// The automatic Task checks of sf serve. A trigger, keyed by workspace/ticket, (re)schedules
// a check of the ticket's current Task file AUTO_CHECK_DELAY_MS after its last trigger: write_task
// after its write, the watcher of each workspace's .software-factory folder, a ticket added to the run
// queue without a check. A new trigger cancels the ticket's pending check and its running automatic
// one (a cancelled run stores nothing). When it fires, nothing runs for a missing file or a skeleton,
// a Task file that already has a check record of any status, one that needs no check
// (checkNeed), or a ticket whose job runs (non-terminal and not paused, as write_task's guard); such a
// trigger is dropped. At most `parallel` checks run at
// once over every workspace, a manual Check included (it never waits); the others wait in trigger
// order. Every check runs through TaskChecks, so the board's "checking…" and check_running see it.
// A manual Check cancels a pending automatic check of its ticket; a trigger that fires while a check
// of its ticket runs waits for it to end. A job that starts cancels the ticket's pending and running
// automatic checks (cancel).
import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { FactoryError } from './errors.js';
import { type Job, type JobStore, TERMINAL_STATES } from './jobs.js';
import type { PlanCheck } from './queue.js';
import type { Workspace } from './registry.js';
import { type CheckRecord, currentCheckSha256, recordVerdict, severityCounts, type TaskChecks } from './task-check.js';
import { checkNeed, isDraft, readTask, TASK_DIR, TICKET_PATTERN } from './task-file.js';

// The time from a ticket's last trigger to its check.
export const AUTO_CHECK_DELAY_MS = 60_000;
// How often the registry is read again for workspaces to watch or to stop watching.
export const WATCH_REREAD_MS = 60_000;

// The timers of the automatic checks; real ones by default (unref'd), a fake clock in the tests.
export interface AutoTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: AutoTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

// A watch of one folder: onName gets the name of each changed entry directly in it (null when the
// platform gives none); onError when the watch broke (it is taken down and tried again at the next
// re-read).
export type WatchFolder = (dir: string, onName: (name: string | null) => void, onError: () => void) => { close(): void };

const watchFolder: WatchFolder = (dir, onName, onError) => {
  const watcher: FSWatcher = fsWatch(dir, { persistent: false, recursive: false }, (_event, name) => onName(name === null ? null : String(name)));
  watcher.on('error', onError);
  return watcher;
};

export type AutoCheckRunner = Pick<TaskChecks, 'startAuto' | 'isRunning' | 'runningCount' | 'observe' | 'store'>;

export interface AutoChecksOptions {
  checks: AutoCheckRunner;
  jobs: Pick<JobStore, 'read'>;
  resolve: (name: string) => Promise<Workspace>;
  // The registered workspaces, read again for the watcher (the registry).
  workspaces: () => Promise<Array<Pick<Workspace, 'name' | 'workCheckout'>>>;
  // SF_TASK_CHECK_PARALLEL.
  parallel: number;
  // An automatic check that ended not_ready or failed (the notification); never one cancelled.
  onCheckEnded?: (record: CheckRecord) => void;
  delayMs?: number;
  rereadMs?: number;
  timers?: AutoTimers;
  watch?: WatchFolder;
  // The updating marker: while updating() is true no automatic check starts; its trigger
  // goes to skipped (update-skipped-checks.json) for the catch-up after the update.
  update?: { updating(): boolean; skipped(workspace: string, ticket: string): Promise<void> };
}

// A ticket's automatic check: scheduled (its timer runs), due (fired; waits for a slot or for the
// ticket's running check to end), starting (being looked at and started) or running. gen counts the
// triggers, so a step that awaited sees whether a newer trigger or a cancel came meanwhile.
interface Entry {
  workspace: string;
  ticket: string;
  gen: number;
  phase: 'scheduled' | 'due' | 'starting' | 'running';
  timer: unknown;
  controller: AbortController | undefined;
}

const keyOf = (workspace: string, ticket: string): string => `${workspace}/${ticket}`;

// A job that uses its Task file: non-terminal and not paused (write_task's guard,
// refuseWhileJobRunning). No automatic check runs on its ticket.
export const usesTaskFile = (job: Pick<Job, 'state'>): boolean => !TERMINAL_STATES.includes(job.state) && job.state !== 'paused';

// The triggers, timers, the due tickets and the parallel limit of the automatic checks, and the
// watchers of the .software-factory folders (see the top of this file).
export class AutoChecks {
  readonly #checks: AutoCheckRunner;
  readonly #jobs: Pick<JobStore, 'read'>;
  readonly #resolve: (name: string) => Promise<Workspace>;
  readonly #workspaces: AutoChecksOptions['workspaces'];
  readonly #parallel: number;
  readonly #onCheckEnded: (record: CheckRecord) => void;
  readonly #delayMs: number;
  readonly #rereadMs: number;
  readonly #timers: AutoTimers;
  readonly #watch: WatchFolder;
  readonly #update: AutoChecksOptions['update'];
  readonly #entries = new Map<string, Entry>();
  // The due tickets, in the order they fired (their last trigger's order).
  #due: string[] = [];
  // The starts, one at a time.
  #drain: Promise<void> = Promise.resolve();
  // The watched folders by workspace name.
  readonly #watchers = new Map<string, { dir: string; close(): void }>();
  #reread: Promise<void> = Promise.resolve();
  #rereadTimer: unknown;
  #closed = false;

  constructor(options: AutoChecksOptions) {
    this.#checks = options.checks;
    this.#jobs = options.jobs;
    this.#resolve = options.resolve;
    this.#workspaces = options.workspaces;
    this.#parallel = options.parallel;
    this.#onCheckEnded = options.onCheckEnded ?? (() => {});
    this.#delayMs = options.delayMs ?? AUTO_CHECK_DELAY_MS;
    this.#rereadMs = options.rereadMs ?? WATCH_REREAD_MS;
    this.#timers = options.timers ?? REAL_TIMERS;
    this.#watch = options.watch ?? watchFolder;
    this.#update = options.update;
    this.#checks.observe({
      // A manual Check goes at once: the ticket's pending automatic check is dropped.
      manualStart: (workspace, ticket) => {
        const entry = this.#entries.get(keyOf(workspace, ticket));
        if (entry !== undefined && entry.phase !== 'running') {
          this.cancel(workspace, ticket);
        }
      },
      // A slot is free, or a ticket's check that a due trigger waited for has ended.
      ended: () => this.#pump(),
    });
  }

  // (Re)schedules the ticket's check delayMs from now; cancels its pending check and its running
  // automatic one.
  trigger(workspace: string, ticket: string): void {
    if (this.#closed) {
      return;
    }
    const key = keyOf(workspace, ticket);
    const entry = this.#entries.get(key) ?? { workspace, ticket, gen: 0, phase: 'scheduled' as const, timer: undefined, controller: undefined };
    this.#stop(key, entry);
    const gen = entry.gen;
    entry.phase = 'scheduled';
    entry.timer = this.#timers.setTimeout(() => this.#fire(key, gen), this.#delayMs);
    this.#entries.set(key, entry);
  }

  // A trigger for a ticket added to the run queue: when its current Task file has no check record,
  // it reschedules the ticket's check as every trigger does, a pending one included; nothing
  // when a record of the current version exists, the Task needs no check or a check of the
  // ticket runs.
  async triggerIfUnchecked(workspace: string, ticket: string): Promise<void> {
    if (this.#checks.isRunning(workspace, ticket)) {
      return;
    }
    try {
      const resolved = await this.#resolve(workspace);
      const task = await readTask(resolved, ticket);
      // Found by the check sha256: the text and its referenced images.
      if ((await this.#checks.store.read(workspace, ticket, await currentCheckSha256(resolved, ticket, task))) !== undefined || !checkNeed(task, workspace).needed) {
        return;
      }
    } catch (error) {
      if (!(error instanceof FactoryError)) {
        console.error(error);
      }
      return;
    }
    if (!this.#checks.isRunning(workspace, ticket)) {
      this.trigger(workspace, ticket);
    }
  }

  // Cancels the ticket's pending check and its running automatic one; the run stores nothing.
  cancel(workspace: string, ticket: string): void {
    const key = keyOf(workspace, ticket);
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return;
    }
    this.#stop(key, entry);
    this.#entries.delete(key);
  }

  // A job's state changed (sf serve's listeners): a job that now uses its Task file cancels the
  // ticket's pending and running automatic checks.
  jobChanged(job: Pick<Job, 'workspace' | 'ticket' | 'state'>): void {
    if (usesTaskFile(job)) {
      this.cancel(job.workspace, job.ticket);
    }
  }

  // Whether a check of the ticket is scheduled, waits for a slot or is being started.
  isPending(workspace: string, ticket: string): boolean {
    const entry = this.#entries.get(keyOf(workspace, ticket));
    return entry !== undefined && entry.phase !== 'running';
  }

  // The entry's timer, its place among the due and its run go; a step that awaited sees the new gen.
  #stop(key: string, entry: Entry): void {
    entry.gen += 1;
    if (entry.timer !== undefined) {
      this.#timers.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    this.#due = this.#due.filter((other) => other !== key);
    entry.controller?.abort();
    entry.controller = undefined;
  }

  // The ticket's timer ran out (unless a newer trigger or a cancel came): it joins the due tickets.
  #fire(key: string, gen: number): void {
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.gen !== gen || this.#closed) {
      return;
    }
    entry.timer = undefined;
    entry.phase = 'due';
    this.#due.push(key);
    this.#pump();
  }

  // Asks for a round of starts after the ones already asked for.
  #pump(): void {
    this.#drain = this.#drain.then(() => this.#startDue()).catch((error: unknown) => console.error(error));
  }

  // Settles once the starts asked for so far are done (tests).
  async idle(): Promise<void> {
    let seen: Promise<void> | undefined;
    while (seen !== this.#drain) {
      seen = this.#drain;
      await seen;
    }
  }

  // Starts the due tickets in order while a slot is free; a ticket whose check runs (a manual one,
  // or an automatic one still ending after its cancel) waits for it to end.
  async #startDue(): Promise<void> {
    for (;;) {
      if (this.#closed || this.#checks.runningCount() >= this.#parallel) {
        return;
      }
      const key = this.#due.find((other) => {
        const entry = this.#entries.get(other);
        return entry !== undefined && !this.#checks.isRunning(entry.workspace, entry.ticket);
      });
      if (key === undefined) {
        return;
      }
      this.#due = this.#due.filter((other) => other !== key);
      const entry = this.#entries.get(key)!;
      const gen = entry.gen;
      const controller = new AbortController();
      entry.phase = 'starting';
      entry.controller = controller;
      const backToHead = (): void => {
        // Back to the head of the due tickets: it was first in order.
        entry.phase = 'due';
        entry.controller = undefined;
        this.#due.unshift(key);
      };
      let run: boolean;
      try {
        run = await this.#shouldRun(entry.workspace, entry.ticket);
      } catch (error) {
        console.error(error);
        run = false;
      }
      if (entry.gen !== gen) {
        continue;
      }
      if (!run) {
        this.#entries.delete(key);
        continue;
      }
      // The factory is being updated: not started; the catch-up checks it.
      if (this.#update?.updating() === true) {
        this.#entries.delete(key);
        await this.#update.skipped(entry.workspace, entry.ticket).catch((error: unknown) => console.error(error));
        continue;
      }
      // A manual Check took the last slot or the ticket meanwhile.
      if (this.#checks.runningCount() >= this.#parallel || this.#checks.isRunning(entry.workspace, entry.ticket)) {
        backToHead();
        continue;
      }
      let ended: Promise<CheckRecord | undefined>;
      // TaskChecks counts it as running from the call on, while it sets the check up.
      const launched = this.#checks.startAuto(entry.workspace, entry.ticket, controller.signal);
      entry.phase = 'running';
      try {
        ({ ended } = await launched);
      } catch (error) {
        if (entry.gen === gen) {
          if (error instanceof FactoryError && error.code === 'check_running') {
            backToHead();
          } else {
            this.#entries.delete(key);
          }
        }
        if (!(error instanceof FactoryError)) {
          console.error(error);
        }
        continue;
      }
      void ended.then((record) => {
        if (entry.controller === controller) {
          this.#entries.delete(key);
        }
        // A stored record is the run's result, even when a cancel came after its commit.
        if (record !== undefined && recordVerdict(record) !== 'ready') {
          this.#onCheckEnded(record);
        }
      });
    }
  }

  // Whether the ticket's check runs now: a Task file that is not a skeleton, has no check record of
  // any status yet, needs a check, and whose ticket has no running job (a paused one does
  // not count).
  async #shouldRun(workspace: string, ticket: string): Promise<boolean> {
    let task: string;
    let resolved: Workspace;
    try {
      resolved = await this.#resolve(workspace);
      task = await readTask(resolved, ticket);
    } catch (error) {
      if (error instanceof FactoryError) {
        return false;
      }
      throw error;
    }
    // Found by the check sha256: the text and its referenced images.
    if (isDraft(task) || !checkNeed(task, workspace).needed || (await this.#checks.store.read(workspace, ticket, await currentCheckSha256(resolved, ticket, task))) !== undefined) {
      return false;
    }
    const job = await this.#jobs.read(workspace, ticket);
    return job === undefined || !usesTaskFile(job);
  }

  // Watches every registered workspace now and re-reads the registry every rereadMs.
  start(): Promise<void> {
    const again = (): void => {
      if (!this.#closed) {
        this.#rereadTimer = this.#timers.setTimeout(() => {
          void this.rereadWorkspaces().finally(again);
        }, this.#rereadMs);
      }
    };
    return this.rereadWorkspaces().finally(again);
  }

  // Reads the registry again: new workspaces are watched, removed ones (or moved) no longer; a
  // folder that cannot be watched is tried again at the next re-read.
  rereadWorkspaces(): Promise<void> {
    this.#reread = this.#reread.then(async () => {
      if (this.#closed) {
        return;
      }
      let workspaces: Array<Pick<Workspace, 'name' | 'workCheckout'>>;
      try {
        workspaces = await this.#workspaces();
      } catch (error) {
        console.error(error);
        return;
      }
      const wanted = new Map(workspaces.map((workspace) => [workspace.name, join(workspace.workCheckout, TASK_DIR)]));
      for (const [name, watcher] of this.#watchers) {
        if (wanted.get(name) !== watcher.dir) {
          watcher.close();
          this.#watchers.delete(name);
        }
      }
      for (const [name, dir] of wanted) {
        if (this.#watchers.has(name)) {
          continue;
        }
        try {
          const watcher = this.#watch(dir, (file) => void this.#changed(name, dir, file), () => {
            if (this.#watchers.get(name) === entry) {
              this.#watchers.delete(name);
            }
            watcher.close();
          });
          const entry = { dir, close: () => watcher.close() };
          this.#watchers.set(name, entry);
        } catch {
          // Not there yet (no Task file written), or not readable: the next re-read tries again.
        }
      }
    });
    return this.#reread;
  }

  // The workspaces watched now (tests).
  watched(): string[] {
    return [...this.#watchers.keys()].sort();
  }

  // A file directly in the folder named <ticket>.md, with a valid ticket, that exists: a trigger.
  // Deletions, the archive folder and every other name are ignored.
  async #changed(workspace: string, dir: string, name: string | null): Promise<void> {
    const match = name === null ? null : /^(.+)\.md$/.exec(name);
    const ticket = match?.[1];
    if (ticket === undefined || !TICKET_PATTERN.test(ticket)) {
      return;
    }
    const stats = await lstat(join(dir, name!)).catch(() => undefined);
    if (stats?.isFile() === true) {
      this.trigger(workspace, ticket);
    }
  }

  // sf serve stops: no timer, watcher or start any more; running automatic checks are cancelled.
  close(): void {
    this.#closed = true;
    this.#timers.clearTimeout(this.#rereadTimer);
    for (const [key, entry] of this.#entries) {
      this.#stop(key, entry);
    }
    this.#entries.clear();
    for (const watcher of this.#watchers.values()) {
      watcher.close();
    }
    this.#watchers.clear();
  }
}

// The plan check of a queued ticket (the run queue's planCheck): checking while a check of it runs;
// not_needed when its current Task file has no check record and needs none (a pending
// trigger of it never runs); checking while a check of it is pending; else the verdict of the check
// of its current Task file (none without one) with its blocker and major counts.
export async function planCheck(checks: Pick<TaskChecks, 'view' | 'store'>, auto: Pick<AutoChecks, 'isPending'> | undefined, workspace: string, ticket: string): Promise<PlanCheck> {
  const view = await checks.view(workspace, ticket);
  if (view.running) {
    return { state: 'checking', blockers: 0, majors: 0 };
  }
  const record = view.check !== null && !view.stale
    ? view.check
    : view.current_sha256 === null ? undefined : await checks.store.read(workspace, ticket, view.current_sha256);
  if (record === undefined && view.check_reason !== null) {
    return { state: 'not_needed', blockers: 0, majors: 0 };
  }
  if (auto?.isPending(workspace, ticket) === true) {
    return { state: 'checking', blockers: 0, majors: 0 };
  }
  if (record === undefined) {
    return { state: 'none', blockers: 0, majors: 0 };
  }
  const counts = severityCounts(record.output);
  return { state: recordVerdict(record), blockers: counts.blocker, majors: counts.major };
}
