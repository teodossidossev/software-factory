// The run queue (SF-071): one order of the planned tickets of every workspace, a limit of jobs that
// run at once (max_running) and the scheduler of sf serve that starts the next queued ticket by
// itself when a slot is free. QueueStore reads and writes <state>/queue.json; RunQueue changes it
// and runs the passes, all one at a time on one promise chain. A ticket leaves queue.json before
// its start, and Execution.start refuses a second job of a ticket (job_exists) under its lock: the
// scheduler never starts a ticket twice, across concurrent events and restarts alike. The limit
// gates only the starts the queue makes itself (Execution.start with queued); a start by hand
// always goes, and its job counts as running here too.
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import type { Execution } from './execution.js';
import { type Job, type JobStore, now, RUNNING_STATES, TERMINAL_STATES } from './jobs.js';
import { resolveWorkspace, type Workspace, WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN } from './registry.js';
import type { DependencyRow, Setup } from './setup.js';
import { isDraft, landsAfter, parseFrontMatter, readTask, TASK_DIR, TICKET_DESCRIPTION, TICKET_PATTERN, type TicketRef } from './task-file.js';

export const QUEUE_FILE = 'queue.json';
export const MIN_RUNNING = 1;
export const MAX_RUNNING = 20;
// How often a pass runs again while a queued ticket waits for a dependency and a slot is free, to
// see merges done on the Git host.
export const DEPENDENCY_RECHECK_MS = 5 * 60_000;

const timestamp = z.iso.datetime();
const workspaceName = z.string().regex(WORKSPACE_NAME_PATTERN);
const ticketKey = z.string().regex(TICKET_PATTERN);
const queueSchema = z.strictObject({
  version: z.literal(1),
  max_running: z.number().int().min(MIN_RUNNING).max(MAX_RUNNING),
  held: z.boolean(),
  hold_reason: z.string().nullable(),
  entries: z.array(z.strictObject({ workspace: workspaceName, ticket: ticketKey, queued_at: timestamp })),
  // The scheduler's start that failed, per ticket (out of the queue): shown on its card.
  errors: z.array(z.strictObject({ workspace: workspaceName, ticket: ticketKey, code: z.string(), message: z.string(), at: timestamp })),
});
export type QueueFile = z.infer<typeof queueSchema>;
export type QueueEntry = QueueFile['entries'][number];
export type QueueError = QueueFile['errors'][number];

const sameTicket = (a: TicketRef, b: TicketRef): boolean => a.workspace === b.workspace && a.ticket === b.ticket;

// The running jobs of every workspace (RUNNING_STATES).
export function runningJobs(jobs: Job[]): Job[] {
  return jobs.filter((job) => RUNNING_STATES.includes(job.state));
}

// <state>/queue.json. A missing file reads as an empty queue whose limit is the default
// (SF_MAX_JOBS, within 1-20); an unreadable or invalid one is an error (queue_invalid), which
// sf serve reports at its start.
export class QueueStore {
  readonly path: string;
  readonly #defaultLimit: number;

  constructor(stateDir: string, defaultLimit: number) {
    this.path = join(stateDir, QUEUE_FILE);
    this.#defaultLimit = Math.min(MAX_RUNNING, Math.max(MIN_RUNNING, defaultLimit));
  }

  async read(): Promise<QueueFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, max_running: this.#defaultLimit, held: false, hold_reason: null, entries: [], errors: [] };
      }
      throw new FactoryError('queue_invalid', `${QUEUE_FILE} could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new FactoryError('queue_invalid', `${QUEUE_FILE} is not valid JSON.`);
    }
    const parsed = queueSchema.safeParse(data);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
      throw new FactoryError('queue_invalid', `${QUEUE_FILE} is invalid: ${issues.join('; ')}.`);
    }
    return parsed.data;
  }

  async write(queue: QueueFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.path, Buffer.from(`${JSON.stringify(queue, null, 2)}\n`));
  }
}

// A queued ticket as the queue shows it: its 1-based position and the tickets it lands after that
// are not merged yet (SF-084's states).
export interface QueueRow {
  workspace: string;
  ticket: string;
  position: number;
  queued_at: string;
  waits_for: DependencyRow[];
}

export interface QueueView {
  max_running: number;
  // The running jobs of every workspace, whoever started them.
  running: number;
  held: boolean;
  hold_reason: string | null;
  entries: QueueRow[];
  errors: QueueError[];
  // The first entry that waits for nothing, or null.
  next: TicketRef | null;
}

export interface RunQueueOptions {
  // Called after a pass that changed the queue or started a job (sf serve: the dashboard's
  // refreshSetup); never throws.
  onChange?: () => void;
  // The workspace of a ticket; resolveWorkspace by default.
  resolve?: (name: string) => Promise<Workspace>;
  // DEPENDENCY_RECHECK_MS by default (tests).
  recheckMs?: number;
}

type QueueExecution = Pick<Execution, 'start' | 'fetchBase'>;
type QueueSetup = Pick<Setup, 'dependencyStates' | 'lastJobBase'>;
type QueueJobs = Pick<JobStore, 'list' | 'read'>;

// What a pass knows of a queued ticket's Task file: the tickets it lands after, or gone (no Task
// file, or its workspace is not registered any more: the entry is dropped). A Task file that cannot
// be read otherwise waits for nothing: its start says why it cannot start.
type TaskInfo = { refs: TicketRef[] } | 'gone';

// The scheduler and the changes of the queue (see the top of this file).
export class RunQueue {
  readonly #store: QueueStore;
  readonly #execution: QueueExecution;
  readonly #setup: QueueSetup;
  readonly #jobs: QueueJobs;
  readonly #onChange: () => void;
  readonly #resolve: (name: string) => Promise<Workspace>;
  readonly #recheckMs: number;
  // Every pass and every change, one at a time.
  #chain: Promise<unknown> = Promise.resolve();
  // A pass is queued on the chain and has not begun: a new event needs no second one.
  #passQueued: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(store: QueueStore, execution: QueueExecution, setup: QueueSetup, jobs: QueueJobs, options: RunQueueOptions = {}) {
    this.#store = store;
    this.#execution = execution;
    this.#setup = setup;
    this.#jobs = jobs;
    this.#onChange = options.onChange ?? (() => {});
    this.#resolve = options.resolve ?? ((name) => resolveWorkspace(name));
    this.#recheckMs = options.recheckMs ?? DEPENDENCY_RECHECK_MS;
  }

  // Runs work after every pass and change asked for before it.
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.catch(() => undefined).then(work);
    this.#chain = next;
    return next;
  }

  // Asks for a pass (a job's state changed, the queue changed, the timer); one already waiting to
  // begin covers this one too. Resolves when that pass has ended; never rejects (a failed pass is
  // logged).
  schedule(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    this.#passQueued ??= this.#serial(async () => {
      this.#passQueued = undefined;
      await this.#pass();
    }).catch((error: unknown) => console.error(error));
    return this.#passQueued;
  }

  // Settles once every pass and change asked for so far has ended (tests).
  async idle(): Promise<void> {
    let seen: Promise<unknown> | undefined;
    while (seen !== this.#chain) {
      seen = this.#chain;
      await seen.catch(() => undefined);
    }
  }

  // No pass runs after this (sf serve stops); the dependency timer goes.
  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  // A change of the queue, then a pass.
  #change<T>(work: (queue: QueueFile) => Promise<T> | T): Promise<T> {
    const result = this.#serial(async () => {
      const queue = await this.#store.read();
      const value = await work(queue);
      await this.#store.write(queue);
      return value;
    });
    result.then(() => this.schedule(), () => undefined);
    return result;
  }

  // Adds a planned ticket at position at (1-based; default and beyond the end: the end). Refused:
  // no Task file (task_not_found), a skeleton (task_draft), a ticket with a live job (job_exists),
  // a ticket already queued (already_queued). Clears the ticket's last start error.
  async add(workspace: string, ticket: string, at?: number): Promise<{ position: number }> {
    checkRef(workspace, ticket);
    const index = at === undefined ? undefined : checkPosition(at, 'at');
    return this.#change(async (queue) => {
      if (queue.entries.some((entry) => sameTicket(entry, { workspace, ticket }))) {
        throw new FactoryError('already_queued', `${workspace}/${ticket} is already in the queue.`);
      }
      const content = await readTask(await this.#resolve(workspace), ticket);
      if (isDraft(content)) {
        throw new FactoryError('task_draft', `${TASK_DIR}/${ticket}.md is still the skeleton: the Context owner writes the Task with write_task first.`);
      }
      const job = await this.#jobs.read(workspace, ticket);
      if (job !== undefined && !TERMINAL_STATES.includes(job.state)) {
        throw new FactoryError('job_exists', `The job for ${workspace}/${ticket} is ${job.state}.`);
      }
      const position = Math.min(index ?? queue.entries.length, queue.entries.length);
      queue.entries.splice(position, 0, { workspace, ticket, queued_at: now() });
      queue.errors = queue.errors.filter((error) => !sameTicket(error, { workspace, ticket }));
      return { position: position + 1 };
    });
  }

  // Takes a queued ticket out (not_queued otherwise).
  async remove(workspace: string, ticket: string): Promise<{ removed: true }> {
    checkRef(workspace, ticket);
    return this.#change((queue) => {
      queue.entries.splice(queuedIndex(queue, workspace, ticket), 1);
      return { removed: true as const };
    });
  }

  // Moves a queued ticket to position to (1-based; beyond the end: the end).
  async move(workspace: string, ticket: string, to: number): Promise<{ position: number }> {
    checkRef(workspace, ticket);
    const index = checkPosition(to, 'to');
    return this.#change((queue) => {
      const [entry] = queue.entries.splice(queuedIndex(queue, workspace, ticket), 1);
      const position = Math.min(index, queue.entries.length);
      queue.entries.splice(position, 0, entry!);
      return { position: position + 1 };
    });
  }

  // The number of jobs that may run at once, 1-20 (invalid_limit). Lowering it stops no job.
  async limit(maxRunning: number): Promise<{ max_running: number }> {
    if (!Number.isInteger(maxRunning) || maxRunning < MIN_RUNNING || maxRunning > MAX_RUNNING) {
      throw new FactoryError('invalid_limit', `The limit must be a whole number from ${MIN_RUNNING} to ${MAX_RUNNING}.`);
    }
    return this.#change((queue) => {
      queue.max_running = maxRunning;
      return { max_running: maxRunning };
    });
  }

  // Held: the scheduler starts nothing until release; the reason is shown (none: null).
  async hold(reason = ''): Promise<{ held: true; hold_reason: string | null }> {
    if (reason.includes('\0')) {
      throw new FactoryError('invalid_content', 'The reason must be text.');
    }
    const text = reason.trim() === '' ? null : reason.trim();
    return this.#change((queue) => {
      queue.held = true;
      queue.hold_reason = text;
      return { held: true as const, hold_reason: text };
    });
  }

  // The scheduler starts again; the reason goes.
  release(): Promise<{ held: false }> {
    return this.#change((queue) => {
      queue.held = false;
      queue.hold_reason = null;
      return { held: false as const };
    });
  }

  // The queue as it is now: its limit, the running count, the entries with what each waits for
  // (SF-084's states as last known: the merged check's cache applies) and the next one to start.
  async view(): Promise<QueueView> {
    const queue = await this.#store.read();
    const running = runningJobs(await this.#jobs.list()).length;
    const entries: QueueRow[] = [];
    let next: TicketRef | null = null;
    for (const [index, entry] of queue.entries.entries()) {
      const info = await this.#taskInfo(entry);
      const waits = info === 'gone' ? [] : (await this.#setup.dependencyStates(info.refs, { fresh: false })).filter((row) => row.state !== 'merged');
      if (next === null && info !== 'gone' && waits.length === 0) {
        next = { workspace: entry.workspace, ticket: entry.ticket };
      }
      entries.push({ workspace: entry.workspace, ticket: entry.ticket, position: index + 1, queued_at: entry.queued_at, waits_for: waits });
    }
    return { max_running: queue.max_running, running, held: queue.held, hold_reason: queue.hold_reason, entries, errors: queue.errors, next };
  }

  #taskInfo(entry: TicketRef): Promise<TaskInfo> {
    return this.#resolve(entry.workspace)
      .then((workspace) => readTask(workspace, entry.ticket))
      .then((content): TaskInfo => ({ refs: landsAfter(parseFrontMatter(content)!, entry.workspace) }))
      .catch((error: unknown): TaskInfo => (error instanceof FactoryError && ['task_not_found', 'workspace_not_found'].includes(error.code) ? 'gone' : { refs: [] }));
  }

  // One pass, unless held: the entries whose Task file is gone or whose ticket has a live job leave
  // the queue (and so do the start errors of those tickets); then, while fewer jobs run than
  // max_running, the first entry whose dependencies are all merged leaves queue.json and starts.
  async #pass(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const queue = await this.#store.read();
    if (queue.held || this.#closed) {
      return;
    }
    let changed = false;
    const jobs = await this.#jobs.list();
    const live = new Set(jobs.filter((job) => !TERMINAL_STATES.includes(job.state)).map((job) => `${job.workspace}/${job.ticket}`));
    const infos = new Map<string, TaskInfo>();
    const keep = async (ref: TicketRef): Promise<boolean> => {
      const key = `${ref.workspace}/${ref.ticket}`;
      if (live.has(key)) {
        return false;
      }
      const info = infos.get(key) ?? (await this.#taskInfo(ref));
      infos.set(key, info);
      return info !== 'gone';
    };
    const entries: QueueEntry[] = [];
    for (const entry of queue.entries) {
      if (await keep(entry)) {
        entries.push(entry);
      }
    }
    const errors: QueueError[] = [];
    for (const error of queue.errors) {
      if (await keep(error)) {
        errors.push(error);
      }
    }
    if (entries.length !== queue.entries.length || errors.length !== queue.errors.length) {
      queue.entries = entries;
      queue.errors = errors;
      await this.#store.write(queue);
      changed = true;
    }
    let running = runningJobs(jobs).length;
    // "<workspace> <base>" fetched in this pass (once each), and whether the fetch succeeded.
    const fetched = new Map<string, boolean>();
    let waiting = false;
    while (running < queue.max_running && !this.#closed) {
      let chosen: QueueEntry | undefined;
      waiting = false;
      for (const entry of queue.entries) {
        const info = infos.get(`${entry.workspace}/${entry.ticket}`);
        if (info === undefined || info === 'gone') {
          continue;
        }
        if (await this.#merged(info.refs, fetched)) {
          chosen = entry;
          break;
        }
        waiting = true;
      }
      if (chosen === undefined) {
        break;
      }
      const index = queue.entries.indexOf(chosen);
      queue.entries.splice(index, 1);
      // Out of queue.json before the start: a restart in between never starts it twice.
      await this.#store.write(queue);
      changed = true;
      try {
        await this.#execution.start(chosen.workspace, chosen.ticket, { queued: true });
      } catch (error) {
        if (error instanceof FactoryError && error.code === 'job_limit') {
          // A start by hand took the slot: the entry goes back where it was; the next pass goes on.
          queue.entries.splice(index, 0, chosen);
          await this.#store.write(queue);
          break;
        }
        if (error instanceof FactoryError && error.code === 'job_exists') {
          // Started by hand since the pass read the jobs: out of the queue without an error.
          running = runningJobs(await this.#jobs.list()).length;
          continue;
        }
        const failure = error instanceof FactoryError ? error : new FactoryError('start_failed', 'The start failed inside the factory.');
        if (!(error instanceof FactoryError)) {
          console.error(error);
        }
        queue.errors = [...queue.errors.filter((other) => !sameTicket(other, chosen)), { workspace: chosen.workspace, ticket: chosen.ticket, code: failure.code, message: failure.message, at: now() }];
        await this.#store.write(queue);
      }
      running = runningJobs(await this.#jobs.list()).length;
    }
    // A slot is free and an entry waits for a dependency: look again later for a merge on the host.
    if (waiting && running < queue.max_running && !this.#closed) {
      this.#timer = setTimeout(() => void this.schedule(), this.#recheckMs);
      this.#timer.unref();
    }
    if (changed) {
      this.#onChange();
    }
  }

  // Whether every ticket of refs is merged (SF-084's state). When one is not, its workspace's base
  // is fetched (once per workspace and base in a pass: fetched) and the states asked again past the
  // merged check's cache whenever a base of theirs was fetched in this pass; a failed fetch leaves
  // them as they were.
  async #merged(refs: TicketRef[], fetched: Map<string, boolean>): Promise<boolean> {
    if (refs.length === 0) {
      return true;
    }
    const states = await this.#setup.dependencyStates(refs, { fresh: false });
    const open = states.filter((row) => row.state !== 'merged');
    if (open.length === 0) {
      return true;
    }
    let again = false;
    for (const row of open) {
      // Only a ticket whose last job was pushed can turn merged (pushed, or planned with an archived
      // Task file); running and missing cannot, nor planned without a job (no base).
      if (row.state !== 'pushed' && row.state !== 'planned') {
        continue;
      }
      const base = await this.#setup.lastJobBase(row);
      if (base === undefined) {
        continue;
      }
      const key = `${row.workspace} ${base}`;
      if (!fetched.has(key)) {
        // Offline or refused: the states stay as they are.
        fetched.set(key, await this.#execution.fetchBase(row.workspace, base).then(() => true, () => false));
      }
      again ||= fetched.get(key) === true;
    }
    if (!again) {
      return false;
    }
    return (await this.#setup.dependencyStates(refs, { fresh: true })).every((row) => row.state === 'merged');
  }
}

// The names of a queue change: invalid_name, invalid_ticket.
function checkRef(workspace: string, ticket: string): void {
  if (!WORKSPACE_NAME_PATTERN.test(workspace)) {
    throw new FactoryError('invalid_name', `workspace name must be ${WORKSPACE_NAME_DESCRIPTION}.`);
  }
  if (!TICKET_PATTERN.test(ticket)) {
    throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
  }
}

// A 1-based position, as a 0-based index; invalid_position otherwise.
function checkPosition(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new FactoryError('invalid_position', `${name} must be a whole number from 1.`);
  }
  return value - 1;
}

// The 0-based index of a queued ticket; not_queued otherwise.
function queuedIndex(queue: QueueFile, workspace: string, ticket: string): number {
  const index = queue.entries.findIndex((entry) => sameTicket(entry, { workspace, ticket }));
  if (index < 0) {
    throw new FactoryError('not_queued', `${workspace}/${ticket} is not in the queue.`);
  }
  return index;
}
