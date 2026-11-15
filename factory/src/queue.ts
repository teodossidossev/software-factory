// The run queue: one order of the planned tickets of every workspace, a limit of jobs that
// run at once (max_running) and the scheduler of sf serve that starts the next queued ticket by
// itself when a slot is free. QueueStore reads and writes <state>/queue.json; RunQueue changes it
// and runs the passes, all one at a time on one promise chain. A ticket leaves queue.json before
// its start, and Execution.start refuses a second job of a ticket (job_exists) under its lock: the
// scheduler never starts a ticket twice, across concurrent events and restarts alike. The limit
// gates only the starts the queue makes itself (Execution.start with queued); a start by hand
// always goes, and its job counts as running here too.
// A job parked on a usage limit (waiting_limit) holds its slot and holds the queue: while any
// job is parked the scheduler starts nothing (the limit hold, computed, never stored; releasing the
// hold by hand does not end it). One timer at the earliest reset of the parked jobs applies the rule
// of queue.json's on_limit to each job whose reset has passed, in park order: resume-then-queue
// resumes it, resume-only resumes it and holds the queue by hand, wait only marks it (the user
// resumes) and holds the queue by hand.
// With planCheck the scheduler starts a queued ticket only when the Task check of its current
// Task file is ready or not needed, or its entry is forced (Start anyway);
// otherwise the entry stays in place and its row says why.
// A start that cannot fetch its base (fetch_failed: the network is gone) leaves no job (the start
// removes the record it made) and puts its entry back in its place with retry_at and retries: the
// entry is passed over until retry_at (5 minutes after the first failure, then 10, then every 15,
// without end: removing the entry stops it), and the reset timer also wakes at the earliest
// retry_at. One notification at the first failure. Every other start error fails as before.
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { taskStartBranch } from './continues.js';
import { FactoryError } from './errors.js';
import type { Execution } from './execution.js';
import { type Job, type JobStore, now, runningJobs, TERMINAL_STATES } from './jobs.js';
import { limitResetNotification, type Notification, type NotifyModeOf, withNotifyMode } from './notify.js';
import { type NotifyMode, resolveWorkspace, type Workspace, WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN, workspaceNotifyMode } from './registry.js';
import type { DependencyRow, Setup } from './setup.js';
import { isDraft, landsAfter, parseFrontMatter, readTask, TASK_DIR, TICKET_DESCRIPTION, TICKET_PATTERN, type TicketRef } from './task-file.js';

export const QUEUE_FILE = 'queue.json';
export const MIN_RUNNING = 1;
export const MAX_RUNNING = 20;
// How often a pass runs again while a queued ticket waits for a dependency and a slot is free, to
// see merges done on the Git host.
export const DEPENDENCY_RECHECK_MS = 5 * 60_000;
// How soon a parked job whose reset passed and whose step failed inside the factory is tried again.
export const LIMIT_RECHECK_MS = 60_000;

// What the queue does when a usage limit resets.
export const ON_LIMIT_RULES = ['resume-then-queue', 'resume-only', 'wait'] as const;
export type OnLimitRule = (typeof ON_LIMIT_RULES)[number];
export const DEFAULT_ON_LIMIT: OnLimitRule = 'resume-then-queue';
// The hold by hand that resume-only and wait leave after a reset.
export const LIMIT_RESET_HOLD_REASON = 'usage limit reset; release the queue to go on';

// The start error the queue tries again instead of failing: the base could not be fetched.
export const RETRY_CODE = 'fetch_failed';
// The wait before the next try of a start that could not fetch: 5 minutes after the first failure,
// then 10, then 15 after every later one.
const RETRY_MINUTES = [5, 10, 15] as const;

// The wait in ms after the retries-th failed fetch (1-based).
export function retryDelayMs(retries: number): number {
  return RETRY_MINUTES[Math.min(Math.max(retries, 1), RETRY_MINUTES.length) - 1]! * 60_000;
}

// The one notification of a queued start that could not fetch, at its first failure, as the
// workspace's notify setting has it (brief: ntfy gets "<workspace> · fetch_failed"; off: none).
export function fetchRetryNotification(workspace: string, ticket: string, base: string, mode: NotifyMode): Notification | undefined {
  const full: Notification = { title: `${ticket}: start failed`, body: `${ticket} could not fetch ${base}; the queue tries again`, priority: 'default', tags: 'warning' };
  return withNotifyMode(full, mode, `${workspace} · ${RETRY_CODE}`);
}

const timestamp = z.iso.datetime();
const workspaceName = z.string().regex(WORKSPACE_NAME_PATTERN);
const ticketKey = z.string().regex(TICKET_PATTERN);
const queueSchema = z.strictObject({
  version: z.literal(1),
  max_running: z.number().int().min(MIN_RUNNING).max(MAX_RUNNING),
  held: z.boolean(),
  hold_reason: z.string().nullable(),
  // The rule at a usage limit's reset; absent in a queue.json written without it: the default.
  on_limit: z.enum(ON_LIMIT_RULES).default(DEFAULT_ON_LIMIT),
  // force: Start anyway, whatever the plan check says; until the entry leaves the queue.
  // retry_at, retries: a start that could not fetch (RETRY_CODE) is tried again at retry_at, the
  // failures so far in retries; both absent before the first. State format 4 (src/state-version.ts).
  entries: z.array(z.strictObject({
    workspace: workspaceName, ticket: ticketKey, queued_at: timestamp, force: z.literal(true).optional(),
    retry_at: timestamp.optional(), retries: z.number().int().min(1).optional(),
  })),
  // The scheduler's start that failed, per ticket (out of the queue): shown on its card.
  errors: z.array(z.strictObject({ workspace: workspaceName, ticket: ticketKey, code: z.string(), message: z.string(), at: timestamp })),
  // When the scheduler last started a queued ticket (the health check queue reads it);
  // absent before the first start. State format 3 (src/state-version.ts).
  last_start: timestamp.optional(),
});
export type QueueFile = z.infer<typeof queueSchema>;
export type QueueEntry = QueueFile['entries'][number];
export type QueueError = QueueFile['errors'][number];

const sameTicket = (a: TicketRef, b: TicketRef): boolean => a.workspace === b.workspace && a.ticket === b.ticket;

// The jobs parked on a usage limit, in park order (paused.at).
export function parkedJobs(jobs: Job[]): Job[] {
  return jobs.filter((job) => job.state === 'waiting_limit').sort((a, b) => (a.paused?.at ?? '').localeCompare(b.paused?.at ?? ''));
}

// The parked jobs the reset timer still waits for: those whose reset was not handled under wait.
function timedJobs(jobs: Job[]): Job[] {
  return parkedJobs(jobs).filter((job) => job.limit !== undefined && job.limit.reset_seen !== true);
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
        return { version: 1, max_running: this.#defaultLimit, held: false, hold_reason: null, on_limit: DEFAULT_ON_LIMIT, entries: [], errors: [] };
      }
      throw new FactoryError('queue_invalid', `${QUEUE_FILE} could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch { // not JSON: reported as queue_invalid
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

// The Task check of a queued ticket's current Task file: ready, not_ready, failed, checking
// (pending or running), none, or not_needed (no check of this version, and checkNeed says
// it needs none), with its blocker and major counts.
export interface PlanCheck {
  state: 'ready' | 'not_ready' | 'failed' | 'checking' | 'none' | 'not_needed';
  blockers: number;
  majors: number;
}

// Why the scheduler skips a queued ticket for its plan, as its card says it; null when ready or not
// needed.
export function planReason(plan: PlanCheck): string | null {
  switch (plan.state) {
    case 'ready':
    case 'not_needed':
      return null;
    case 'not_ready':
      return `plan not ready: ${plan.blockers} blocker, ${plan.majors} major`;
    case 'failed':
      return 'plan check failed';
    case 'checking':
      return 'plan being checked';
    case 'none':
      return 'plan not checked';
  }
}

// A queued ticket as the queue shows it: its 1-based position, the tickets it lands after that are
// not merged yet (with their dependency states), whether it is forced, why its plan holds it (null
// when the plan is ready, the entry forced, or the queue has no plan check) and, after a start that
// could not fetch, its next try while it is ahead (passed over until at; null otherwise: once due,
// the entry waits as any other).
export interface QueueRow {
  workspace: string;
  ticket: string;
  position: number;
  queued_at: string;
  waits_for: DependencyRow[];
  force: boolean;
  plan_reason: string | null;
  retry: { code: typeof RETRY_CODE; at: string; retries: number } | null;
}

export interface QueueView {
  max_running: number;
  // The running jobs of every workspace, whoever started them.
  running: number;
  held: boolean;
  hold_reason: string | null;
  // The rule at a usage limit's reset.
  on_limit: OnLimitRule;
  // The limit hold: the parked jobs and the earliest reset the timer waits for (null when
  // every parked job's reset passed under wait); null when no job is parked.
  limit_hold: { parked: number; resets_at: string | null } | null;
  entries: QueueRow[];
  errors: QueueError[];
  // The first entry that waits for nothing, whose plan does not hold it and whose next try (if
  // any) is due, or null.
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
  // The clock of the reset timer and of the next try of a start that could not fetch; Date.now by
  // default (tests).
  clock?: () => number;
  // Sends the one notification of a reset and the one of a start that could not fetch (sf serve:
  // sendNotification); never throws.
  notify?: (notification: Notification) => Promise<unknown>;
  // A workspace's notify setting, for the notification of a start that could not fetch;
  // workspaceNotifyMode by default.
  notifyMode?: NotifyModeOf;
  // The Task check of a queued ticket; without it every plan counts as ready.
  planCheck?: (workspace: string, ticket: string) => Promise<PlanCheck>;
  // Called after a ticket was added (the dashboard, the CLI and MCP alike; sf serve: the automatic
  // check of a ticket without one); never throws.
  onAdded?: (workspace: string, ticket: string) => void;
  // The updating marker: while it is true a pass starts no queued ticket and calls no
  // limitReset; the reset timer is armed again as always, so a parked job stays in waiting_limit.
  // Checked at the start of a pass and again right before each start and each limitReset.
  updating?: () => boolean;
}

type QueueExecution = Pick<Execution, 'start' | 'fetchBase' | 'limitReset'>;
type QueueSetup = Pick<Setup, 'dependencyStates' | 'lastJobBase'>;
type QueueJobs = Pick<JobStore, 'list' | 'read'>;

// What a pass knows of a queued ticket's Task file: the tickets it lands after and the branch its
// start fetches (continues, else base; '' when unknown), or gone (no Task file, or its workspace is
// not registered any more: the entry is dropped). A Task file that cannot be read otherwise waits
// for nothing: its start says why it cannot start.
type TaskInfo = { refs: TicketRef[]; base: string } | 'gone';

// The scheduler and the changes of the queue (see the top of this file).
export class RunQueue {
  readonly #store: QueueStore;
  readonly #execution: QueueExecution;
  readonly #setup: QueueSetup;
  readonly #jobs: QueueJobs;
  readonly #onChange: () => void;
  readonly #resolve: (name: string) => Promise<Workspace>;
  readonly #recheckMs: number;
  readonly #clock: () => number;
  readonly #notify: (notification: Notification) => Promise<unknown>;
  readonly #notifyMode: NotifyModeOf;
  readonly #planCheck: ((workspace: string, ticket: string) => Promise<PlanCheck>) | undefined;
  readonly #onAdded: (workspace: string, ticket: string) => void;
  readonly #updating: () => boolean;
  // Every pass and every change, one at a time.
  #chain: Promise<unknown> = Promise.resolve();
  // A pass is queued on the chain and has not begun: a new event needs no second one.
  #passQueued: Promise<void> | undefined;
  // The last work of each ticket under withTicket, by "<workspace>/<ticket>".
  readonly #ticketLocks = new Map<string, Promise<void>>();
  #timer: NodeJS.Timeout | undefined;
  // The reset timer: at the earliest reset of the parked jobs or the earliest next try of an entry
  // whose start could not fetch, whichever comes first.
  #resetTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(store: QueueStore, execution: QueueExecution, setup: QueueSetup, jobs: QueueJobs, options: RunQueueOptions = {}) {
    this.#store = store;
    this.#execution = execution;
    this.#setup = setup;
    this.#jobs = jobs;
    this.#onChange = options.onChange ?? (() => {});
    this.#resolve = options.resolve ?? ((name) => resolveWorkspace(name));
    this.#recheckMs = options.recheckMs ?? DEPENDENCY_RECHECK_MS;
    this.#clock = options.clock ?? Date.now;
    this.#notify = options.notify ?? (() => Promise.resolve());
    this.#notifyMode = options.notifyMode ?? ((name) => workspaceNotifyMode(name));
    this.#planCheck = options.planCheck;
    this.#onAdded = options.onAdded ?? (() => {});
    this.#updating = options.updating ?? (() => false);
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

  // Runs work for a ticket after the work asked for it before: the scheduler's last look
  // at a ticket's plan and its start, and the factory's own writes of its Task file (write_task,
  // the dashboard's Save), so no such write lands between the look and the job's claim. Work for
  // other tickets runs meanwhile.
  withTicket<T>(workspace: string, ticket: string, work: () => Promise<T>): Promise<T> {
    const key = `${workspace}/${ticket}`;
    const result = (this.#ticketLocks.get(key) ?? Promise.resolve()).then(work);
    const tail = result.then(() => undefined, () => undefined);
    this.#ticketLocks.set(key, tail);
    void tail.then(() => {
      if (this.#ticketLocks.get(key) === tail) {
        this.#ticketLocks.delete(key);
      }
    });
    return result;
  }

  // Settles once every pass and change asked for so far has ended (tests).
  async idle(): Promise<void> {
    let seen: Promise<unknown> | undefined;
    while (seen !== this.#chain) {
      seen = this.#chain;
      await seen.catch(() => undefined);
    }
  }

  // No pass runs after this (sf serve stops); the dependency and reset timers go.
  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    clearTimeout(this.#resetTimer);
    this.#resetTimer = undefined;
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
    const added = this.#change(async (queue) => {
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
    const result = await added;
    try {
      this.#onAdded(workspace, ticket);
    } catch (error) {
      console.error(error);
    }
    return result;
  }

  // Start anyway: the queued ticket starts whatever its plan check says, for any version
  // of its Task file, until it leaves the queue (not_queued otherwise).
  async force(workspace: string, ticket: string): Promise<{ force: true }> {
    checkRef(workspace, ticket);
    return this.#change((queue) => {
      queue.entries[queuedIndex(queue, workspace, ticket)]!.force = true;
      return { force: true as const };
    });
  }

  // Why the entry's plan holds it (null: it does not): forced, no plan check, ready or not
  // needed. A plan check that fails counts as not checked.
  async #planHold(entry: QueueEntry): Promise<string | null> {
    if (entry.force === true || this.#planCheck === undefined) {
      return null;
    }
    const plan = await this.#planCheck(entry.workspace, entry.ticket).catch((error: unknown): PlanCheck => {
      if (!(error instanceof FactoryError)) {
        console.error(error);
      }
      return { state: 'none', blockers: 0, majors: 0 };
    });
    return planReason(plan);
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

  // The rule at a usage limit's reset: resume-then-queue, resume-only or wait (invalid_rule).
  async rule(rule: string): Promise<{ on_limit: OnLimitRule }> {
    if (!(ON_LIMIT_RULES as readonly string[]).includes(rule)) {
      throw new FactoryError('invalid_rule', `The rule must be one of ${ON_LIMIT_RULES.join(', ')}.`);
    }
    const value = rule as OnLimitRule;
    return this.#change((queue) => {
      queue.on_limit = value;
      return { on_limit: value };
    });
  }

  // The scheduler starts again; the reason goes. The limit hold stays while a job is parked.
  release(): Promise<{ held: false }> {
    return this.#change((queue) => {
      queue.held = false;
      queue.hold_reason = null;
      return { held: false as const };
    });
  }

  // The queue as it is now: its limit, the running count, the entries with what each waits for
  // (their dependency states as last known: the merged check's cache applies) and the next one to start.
  async view(): Promise<QueueView> {
    const queue = await this.#store.read();
    const jobs = await this.#jobs.list();
    const running = runningJobs(jobs).length;
    const parked = parkedJobs(jobs);
    const resets = timedJobs(jobs).map((job) => job.limit!.resets_at).sort();
    const limitHold = parked.length === 0 ? null : { parked: parked.length, resets_at: resets[0] ?? null };
    const entries: QueueRow[] = [];
    let next: TicketRef | null = null;
    for (const [index, entry] of queue.entries.entries()) {
      const info = await this.#taskInfo(entry);
      const waits = info === 'gone' ? [] : (await this.#setup.dependencyStates(info.refs, { fresh: false })).filter((row) => row.state !== 'merged');
      const hold = info === 'gone' ? null : await this.#planHold(entry);
      if (next === null && info !== 'gone' && waits.length === 0 && hold === null && !this.#retryPending(entry)) {
        next = { workspace: entry.workspace, ticket: entry.ticket };
      }
      const retry: QueueRow['retry'] = this.#retryPending(entry) ? { code: RETRY_CODE, at: entry.retry_at!, retries: entry.retries ?? 1 } : null;
      entries.push({ workspace: entry.workspace, ticket: entry.ticket, position: index + 1, queued_at: entry.queued_at, waits_for: waits, force: entry.force === true, plan_reason: hold, retry });
    }
    return { max_running: queue.max_running, running, held: queue.held, hold_reason: queue.hold_reason, on_limit: queue.on_limit, limit_hold: limitHold, entries, errors: queue.errors, next };
  }

  #taskInfo(entry: TicketRef): Promise<TaskInfo> {
    return this.#resolve(entry.workspace)
      .then((workspace) => readTask(workspace, entry.ticket))
      .then((content): TaskInfo => {
        const fields = parseFrontMatter(content)!;
        return { refs: landsAfter(fields, entry.workspace), base: taskStartBranch(fields) };
      })
      .catch((error: unknown): TaskInfo => (error instanceof FactoryError && ['task_not_found', 'workspace_not_found'].includes(error.code) ? 'gone' : { refs: [], base: '' }));
  }

  // Whether the entry waits for the next try of a start that could not fetch (retry_at ahead).
  #retryPending(entry: QueueEntry): boolean {
    return entry.retry_at !== undefined && Date.parse(entry.retry_at) > this.#clock();
  }

  // One pass: first the parked jobs whose usage limit reset (#resets) and the reset timer;
  // then, unless held by hand or by a parked job, the entries whose Task file is gone or whose ticket
  // has a live job leave the queue (and so do the start errors of those tickets); then, while fewer
  // jobs run than max_running, the first entry whose plan does not hold it (ready or forced)
  // and whose dependencies are all merged leaves queue.json and starts. An entry held by its plan
  // stays in place; the end of a Task check asks for a pass. An entry whose next try is ahead
  // (retry_at) is passed over; a start that fails with RETRY_CODE puts its entry back in its place
  // with the next try, and the reset timer is armed again for it.
  async #pass(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#closed) {
      return;
    }
    let changed = await this.#resets();
    const queue = await this.#store.read();
    const jobs = await this.#jobs.list();
    // While the factory is being updated nothing starts; the catch-up asks for a pass.
    if (queue.held || parkedJobs(jobs).length > 0 || this.#closed || this.#updating()) {
      if (changed) {
        this.#onChange();
      }
      return;
    }
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
    // The entries whose plan held them at the last look, under the ticket's lock: not tried again
    // in this pass.
    const heldNow = new Set<QueueEntry>();
    // A start in this pass could not fetch: the timer is armed again for its next try.
    let retried = false;
    while (running < queue.max_running && !this.#closed) {
      let chosen: QueueEntry | undefined;
      waiting = false;
      for (const entry of queue.entries) {
        const info = infos.get(`${entry.workspace}/${entry.ticket}`);
        if (info === undefined || info === 'gone' || heldNow.has(entry) || this.#retryPending(entry) || (await this.#planHold(entry)) !== null) {
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
      const entry = chosen;
      // The last look at the plan and the start under the ticket's lock (withTicket): a write_task
      // or a Save of the Task file lands before the look, which sees it, or after the job's claim,
      // which refuses it (job_active). So the version started is the one found ready.
      const outcome = await this.withTicket(entry.workspace, entry.ticket, async (): Promise<'held' | 'limit' | 'next' | 'updating'> => {
        // The merged check may have fetched for seconds: the marker is looked at again.
        if (this.#updating()) {
          return 'updating';
        }
        if ((await this.#planHold(entry)) !== null) {
          return 'held';
        }
        const index = queue.entries.indexOf(entry);
        queue.entries.splice(index, 1);
        // The start's time, for the health check queue, in the same write.
        queue.last_start = now();
        // Out of queue.json before the start: a restart in between never starts it twice.
        await this.#store.write(queue);
        changed = true;
        try {
          await this.#execution.start(entry.workspace, entry.ticket, { queued: true });
        } catch (error) {
          if (error instanceof FactoryError && error.code === 'job_limit') {
            // A start by hand took the slot: the entry goes back where it was; the next pass goes on.
            queue.entries.splice(index, 0, entry);
            await this.#store.write(queue);
            return 'limit';
          }
          if (error instanceof FactoryError && error.code === 'job_exists') {
            // Started by hand since the pass read the jobs: out of the queue without an error.
            return 'next';
          }
          if (error instanceof FactoryError && error.code === RETRY_CODE) {
            // The base could not be fetched (the start left no job): the entry goes back where it
            // was, with its next try; the user is told at the first failure only.
            const retries = (entry.retries ?? 0) + 1;
            queue.entries.splice(index, 0, { ...entry, retry_at: new Date(this.#clock() + retryDelayMs(retries)).toISOString(), retries });
            await this.#store.write(queue);
            retried = true;
            if (retries === 1) {
              const info = infos.get(`${entry.workspace}/${entry.ticket}`);
              const base = info === undefined || info === 'gone' || info.base === '' ? 'its base' : info.base;
              const note = fetchRetryNotification(entry.workspace, entry.ticket, base, await this.#notifyMode(entry.workspace));
              if (note !== undefined) {
                await this.#notify(note).catch((failure: unknown) => console.error(failure));
              }
            }
            return 'next';
          }
          const failure = error instanceof FactoryError ? error : new FactoryError('start_failed', 'The start failed inside the factory.');
          if (!(error instanceof FactoryError)) {
            console.error(error);
          }
          queue.errors = [...queue.errors.filter((other) => !sameTicket(other, entry)), { workspace: entry.workspace, ticket: entry.ticket, code: failure.code, message: failure.message, at: now() }];
          await this.#store.write(queue);
        }
        return 'next';
      });
      if (outcome === 'limit' || outcome === 'updating') {
        break;
      }
      if (outcome === 'held') {
        heldNow.add(entry);
        continue;
      }
      running = runningJobs(await this.#jobs.list()).length;
    }
    // A slot is free and an entry waits for a dependency: look again later for a merge on the host.
    if (waiting && running < queue.max_running && !this.#closed) {
      this.#timer = setTimeout(() => void this.schedule(), this.#recheckMs);
      this.#timer.unref();
    }
    if (retried) {
      await this.#armResetTimer();
    }
    if (changed) {
      this.#onChange();
    }
  }

  // The parked jobs whose reset has passed, in park order, under queue.json's rule: resumed
  // (resume-then-queue, resume-only) or marked to wait for the user (wait); after resume-only and
  // wait the queue is held by hand. One notification for them all. Then the reset timer is armed at
  // the earliest reset still ahead. Returns whether anything changed.
  async #resets(): Promise<boolean> {
    clearTimeout(this.#resetTimer);
    this.#resetTimer = undefined;
    const rule = (await this.#store.read()).on_limit;
    const due = timedJobs(await this.#jobs.list()).filter((job) => Date.parse(job.limit!.resets_at) <= this.#clock());
    let resumed = 0;
    let waiting = 0;
    for (const job of due) {
      // Under the updating marker no reset is applied; the timer below is armed again.
      if (this.#closed || this.#updating()) {
        break;
      }
      let outcome: Awaited<ReturnType<QueueExecution['limitReset']>>;
      try {
        outcome = await this.#execution.limitReset(job.workspace, job.ticket, job.paused?.at ?? '', rule !== 'wait');
      } catch (error) {
        console.error(error);
        continue;
      }
      resumed += outcome === 'resumed' ? 1 : 0;
      waiting += outcome === 'waiting' ? 1 : 0;
    }
    // A hold by hand already in place keeps its own reason.
    if (resumed + waiting > 0 && rule !== 'resume-then-queue') {
      const queue = await this.#store.read();
      if (!queue.held) {
        queue.held = true;
        queue.hold_reason = LIMIT_RESET_HOLD_REASON;
        await this.#store.write(queue);
      }
    }
    if (resumed + waiting > 0) {
      await this.#notify(limitResetNotification(resumed, waiting)).catch((error: unknown) => console.error(error));
    }
    await this.#armResetTimer();
    return resumed + waiting > 0;
  }

  // Arms the reset timer at the earliest reset still ahead of the parked jobs or the earliest
  // retry_at still ahead of the queue's entries, whichever comes first; none without either.
  // A retry_at that passed needs no timer: the entry starts at the next pass with a free slot.
  async #armResetTimer(): Promise<void> {
    clearTimeout(this.#resetTimer);
    this.#resetTimer = undefined;
    if (this.#closed) {
      return;
    }
    const nowMs = this.#clock();
    const reset = timedJobs(await this.#jobs.list()).map((job) => Date.parse(job.limit!.resets_at)).sort((a, b) => a - b)[0];
    const retry = (await this.#store.read()).entries.map((entry) => (entry.retry_at === undefined ? Number.NaN : Date.parse(entry.retry_at))).filter((at) => at > nowMs).sort((a, b) => a - b)[0];
    const waits: number[] = [];
    if (reset !== undefined) {
      // A job still due was not handled (its step failed inside the factory): tried again a minute
      // later, not at once.
      waits.push(reset <= nowMs ? LIMIT_RECHECK_MS : reset - nowMs);
    }
    if (retry !== undefined) {
      waits.push(retry - nowMs);
    }
    if (waits.length === 0 || this.#closed) {
      return;
    }
    // setTimeout's bound is about 24.8 days; a later reset is looked at again then.
    this.#resetTimer = setTimeout(() => void this.schedule(), Math.min(...waits, 2 ** 31 - 1));
    this.#resetTimer.unref();
  }

  // Whether every ticket of refs is merged. When one is not, its workspace's base
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
