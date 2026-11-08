// The shared state and seams of the job lifecycle's parts (SF-089): the job store, the config, the
// live Implementer sessions and the running reviews of this process, the operation lock (locked),
// the per-workspace Git lock (gitLocked), transition (every state change after the first, the seam
// for notifications and for JOB_TRANSITIONS in src/jobs.ts, SF-088), and the runner seams. No job
// logic: the parts hold it. Core implements the narrow ports of ./ports.ts (SF-143); each part takes
// only the ports it uses, and src/execution.ts wires the parts to each other.
import { join } from 'node:path';
import { withoutImageData } from '../attachments.js';
import type { Config } from '../config.js';
import { FactoryError } from '../errors.js';
import { GATE_REVIEWER } from '../gate.js';
import { checkTransition, cutEvent, type Job, type JobAction, type JobState, JobStore, now, RESUMABLE_STATES } from '../jobs.js';
import type { Workspace } from '../registry.js';
import { REVIEWER } from '../review.js';
import { withLock } from '../pid-lock.js';
import { Runners } from '../runner.js';
import { TICKET_DESCRIPTION, TICKET_PATTERN } from '../task-file.js';
import type { StateListener } from './dto.js';
import type { JobStorePort, LivePort, LockPort, NoticePort, RunnerPort, SettingsPort, StopPort } from './ports.js';
import type { ExecutionOptions, Live, RunningReview } from './shared.js';

// The hand-over part's check of the sandbox's leftover config lock after a session (clearAfter).
export type ClearAfter = (workspace: string, except: string | undefined, log: { job: Job; iteration: number }) => Promise<void>;

export class Core implements JobStorePort, LockPort, LivePort, RunnerPort, NoticePort, SettingsPort, StopPort {
  readonly jobs: JobStore;
  readonly config: Config;
  readonly resolve: (name: string) => Promise<Workspace>;
  readonly #onStateChange: StateListener;
  readonly handbook: string;
  readonly live = new Map<string, Live>();
  // The running review of each job, by "<workspace>/<ticket>".
  readonly reviews = new Map<string, RunningReview>();
  #lock: Promise<unknown> = Promise.resolve();
  // The operations under locked not settled yet.
  #pending = 0;
  // One Git lock per workspace for the operations on the shared checkout; a lock file under the
  // state directory serializes them with the other processes' (sf serve and the runners).
  readonly #gitLocks = new Map<string, Promise<unknown>>();
  // Runner mode: the job; sf serve: the runners it talks to.
  readonly #runner: { workspace: string; ticket: string } | undefined;
  readonly runners: Runners | undefined;
  // The /proc the sandbox's config lock check scans (ExecutionOptions.lockProc); undefined: the real one.
  readonly lockProc: string | undefined;
  // The run queue's limit max_running (ExecutionOptions.maxRunning); undefined: config.maxJobs.
  readonly maxRunning: (() => Promise<number>) | undefined;
  // Runner mode: stop() was called; nothing new starts.
  #stopping = false;
  // The hand-over part's clearAfter, set by src/execution.ts once it has built the part (the
  // Core↔handover pair); afterSession throws before.
  #clearAfter: ClearAfter | undefined;

  constructor(config: Config, resolve: (name: string) => Promise<Workspace>, onStateChange: StateListener, handbook: string, options: ExecutionOptions) {
    this.config = config;
    this.jobs = new JobStore(config.stateDir);
    this.resolve = resolve;
    this.#onStateChange = onStateChange;
    this.handbook = handbook;
    this.#runner = options.runner;
    this.runners = options.runner === undefined ? new Runners(this.jobs, options.launch) : undefined;
    this.lockProc = options.lockProc;
    this.maxRunning = options.maxRunning;
  }

  isStopping(): boolean {
    return this.#stopping;
  }

  setStopping(): void {
    this.#stopping = true;
  }

  // src/execution.ts, once the hand-over part is built.
  bindClearAfter(clearAfter: ClearAfter): void {
    this.#clearAfter = clearAfter;
  }

  // The operations under locked not settled yet (Execution's idle).
  get pending(): number {
    return this.#pending;
  }

  // One state-changing operation at a time.
  locked<T>(work: () => Promise<T>): Promise<T> {
    this.#pending += 1;
    const next = this.#lock.catch(() => undefined).then(work);
    this.#lock = next;
    const settled = (): void => {
      this.#pending -= 1;
    };
    next.then(settled, settled);
    return next;
  }

  // The checkout's Git operations of one workspace (fetch, worktree add and remove, branch
  // delete, the commit and rebase at Clean, push) never interleave; the rest runs concurrently.
  gitLocked<T>(workspace: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#gitLocks.get(workspace) ?? Promise.resolve();
    const path = join(this.config.stateDir, 'locks', `git-${workspace}.lock`);
    const next = previous.catch(() => undefined).then(() => withLock(path, work));
    this.#gitLocks.set(workspace, next);
    return next;
  }

  // Every state change after the first: refused (illegal_transition) before anything is written
  // unless JOB_TRANSITIONS allows it (SF-088). action: the step that changes the state, a literal
  // at every call site.
  async transition(job: Job, to: JobState, action: JobAction, error?: { code: string; message: string }, lines?: string[]): Promise<Job> {
    checkTransition(job.state, to, action);
    const from = job.state;
    // What a pause interrupted is kept only while the job is paused (SF-067) or parked on a usage
    // limit (SF-072, with the limit); why the hand-over did not happen only while
    // ready_for_human_review, and the hand-over only while handed_over, unless one of its steps was
    // cut off (SF-073: recover() repairs it).
    const { error: _previous, paused, limit, handoff_skipped: skipped, handover, ...rest } = job;
    const next: Job = {
      ...rest, state: to, updated_at: now(), ...(error !== undefined ? { error } : {}),
      ...(RESUMABLE_STATES.includes(to) && paused !== undefined ? { paused } : {}),
      ...(to === 'waiting_limit' && limit !== undefined ? { limit } : {}),
      ...(to === 'ready_for_human_review' && skipped !== undefined ? { handoff_skipped: skipped } : {}),
      ...(handover !== undefined && (to === 'handed_over' || handover.step !== null) ? { handover } : {}),
    };
    await this.jobs.write(next);
    await this.jobs.appendEvent(job.workspace, job.ticket, {
      ts: next.updated_at,
      iteration: job.iteration,
      state: { from, to, ...(error !== undefined ? { error } : {}) },
    });
    try {
      this.#onStateChange(next, from, lines);
    } catch (listenerError) {
      console.error(listenerError);
    }
    return next;
  }

  async job(workspace: string, ticket: string): Promise<Job> {
    if (!TICKET_PATTERN.test(ticket)) {
      throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
    }
    const job = await this.jobs.read(workspace, ticket);
    if (job === undefined) {
      throw new FactoryError('job_not_found', `There is no job for ${workspace}/${ticket}.`);
    }
    return job;
  }

  // sf serve's runners; runner mode has none and never reaches the calls that need them.
  serveRunners(): Runners {
    if (this.runners === undefined) {
      throw new Error('Only sf serve starts and stops runners.');
    }
    return this.runners;
  }

  // Runner mode's job; sf serve runs no turn and no review itself.
  runnerJob(): { workspace: string; ticket: string } {
    if (this.#runner === undefined) {
      throw new Error("Turns and reviews run in the job's runner, not in sf serve.");
    }
    return this.#runner;
  }

  // Appends one message of a running review (review_message) or one Codex event of a running gate
  // (gate_event), already redacted (src/redact.ts), to the job's events.jsonl, cut to its bound
  // (SF-045).
  // reviewer: whose session a review_message is (the simplification pass's too, SF-055).
  appendLive(job: Job, type: 'review_message' | 'gate_event', raw: unknown, reviewer: string = REVIEWER): Promise<void> {
    const { value, truncated } = cutEvent(withoutImageData(raw));
    const cut = truncated ? { truncated: true as const } : {};
    return this.jobs.appendEvent(job.workspace, job.ticket, type === 'review_message'
      ? { ts: now(), iteration: job.iteration, type, reviewer, message: value, ...cut }
      : { ts: now(), iteration: job.iteration, type, reviewer: GATE_REVIEWER, event: value, ...cut });
  }

  // After a session of the job ended (an Implementer turn, the Claude review, the gate, the
  // simplification pass; iteration: the one it worked on): the sandbox's leftover config lock goes,
  // unless another job of the workspace runs. A failure is only logged; the job goes on.
  afterSession(job: Job, iteration = job.iteration): Promise<void> {
    if (this.#clearAfter === undefined) {
      throw new Error('Core.afterSession before src/execution.ts bound the hand-over part.');
    }
    return this.#clearAfter(job.workspace, job.ticket, { job, iteration });
  }

  // A change of the job's merge request outside a state change: the listeners (the notification,
  // the dashboard) hear of it as of a job that stays in its state.
  announce(job: Job, lines: string[]): void {
    try {
      this.#onStateChange(job, job.state, lines);
    } catch (listenerError) {
      console.error(listenerError);
    }
  }
}
