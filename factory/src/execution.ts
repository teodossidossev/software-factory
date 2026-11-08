// The job lifecycle (SF-089: a thin coordinator over its parts in src/execution/). Execution keeps
// the public operations that sf serve, the runner (sf run), the CLI and the tests call, each a call
// into the part that owns it, and wires the parts to one Core:
// - execution/core.ts: the shared state and seams (the job store, the config, the live sessions,
//   the running reviews, locked, gitLocked, transition: every state change after the first, the
//   seam for notifications and for JOB_TRANSITIONS in src/jobs.ts, SF-088).
// - execution/start.ts: start, the worktree and the Task file's copy, restart (SF-067), recover
//   (the rule for a restart of sf serve, SF-042).
// - execution/turns.ts: the Implementer session, the end of a turn and the published iteration,
//   say, requestFix and the Fix section.
// - execution/reviews.ts: the Claude review (SF-038), the Codex gate (SF-039), the ledger (settle),
//   retryReview (SF-044), acceptGate (SF-047), the simplification pass (SF-055).
// - execution/mr-steps.ts: MR preparation at Clean (markClean, SF-019, SF-037), retryMr (SF-087),
//   approve (the push), the merge request on the Git host (SF-048), the Merge request screen.
// - execution/handover-steps.ts: the hand-over to the user's checkout and its checks (SF-073), the
//   sandbox's config lock (SF-085).
// - execution/control.ts: pause and Resume (SF-067), the usage-limit park (SF-072), abort, reset,
//   Archive, exclusive, and the requests sf serve queues to a job's runner.
// - execution/status.ts: check and status.
// - execution/dto.ts: the data shapes Execution's calls return or take (SF-142).
// - execution/errors.ts: the codes sf accept and sf retry take on, and the shared refusals.
// - execution/prompts.ts: the first prompt and the notes the Implementer is given.
// - execution/events.ts: the tests event of the job's stream.
// - execution/shared.ts: the helpers and runtime types more than one part uses.
// The Implementer session of each job works in the job's own worktree and publishes an iteration
// (Report, Patch and the file list) when the session goes idle; then the Claude review of that
// iteration runs (SF-038, src/review.ts), and after a clean one the Codex gate (SF-039,
// src/gate.ts); the deciding verdict takes the path of requestFix or markClean; a clean one first
// runs the simplification pass (SF-055, src/simplify.ts) when the job had review fixes.
// Several jobs of one workspace run at the same time; the run queue (SF-071, src/queue.ts) limits
// only the starts it makes itself to max_running running jobs of every workspace (a start by hand
// always goes). The Git operations on the shared checkout are serialized per workspace, across
// processes. Since SF-042 each job's turns, reviews and gate run in the job's runner
// (src/runner.ts), a detached `sf run` with an Execution of its own in runner mode: sf serve
// creates the job at start, queues the requests that need a turn or a review (the first turn, say,
// a Fix section, Clean, the retry of a review, the override of the gate, the Retry of MR
// preparation, the Resume of a paused job) and waits for the runner's reply; abort, pause, restart
// and reset stop the runner first. approve and the merge request stay in sf serve. The user starts
// and approves (the dashboard, the CLI); no MCP tool reaches these methods since SF-040.
import type { Config } from './config.js';
import type { Decision } from './ledger.js';
import type { ForgeKind, MergeRequestStatus } from './forge.js';
import type { Job, JobMr, JobState, JobStore, PauseStep } from './jobs.js';
import type { Workspace } from './registry.js';
import type { RunnerRequest, RunnerWork } from './runner.js';
import { DEFAULT_PAGE_BYTES } from './repo-files.js';
import { ControlPart } from './execution/control.js';
import { Core } from './execution/core.js';
import type { CheckResult, ExclusiveScope, MrInput, MrOutcome, MrSaved, MrView, Resumed, Retired, StateListener } from './execution/dto.js';
import { type HandoverRunning, HandoverPart } from './execution/handover-steps.js';
import { MrPart } from './execution/mr-steps.js';
import { ReviewsPart } from './execution/reviews.js';
import type { ExecutionOptions } from './execution/shared.js';
import { StartPart } from './execution/start.js';
import { StatusPart } from './execution/status.js';
import { TurnsPart } from './execution/turns.js';

export { GATE_OVERRIDE_CODES, LEDGER_ACCEPT_CODES, MR_RETRY_CODES } from './execution/errors.js';
export { changeNote, firstPrompt, imagesChangedNote } from './execution/prompts.js';
export { branchName, MAX_REPORT_BYTES, slugify } from './execution/shared.js';
export type { CheckResult, ExclusiveScope, MrInput, MrOutcome, MrSaved, MrView, Resumed, Retired, ReviewStatus, StateListener } from './execution/dto.js';
export type { HandoverRunning } from './execution/handover-steps.js';
export type { ExecutionOptions } from './execution/shared.js';

export class Execution implements RunnerWork {
  // The same store as the parts' (core.jobs).
  readonly jobs: JobStore;
  readonly #core: Core;

  // handbook: the loaded Handbook text; MR preparation sends its Git rules and MR template, the
  // review its review rules.
  constructor(config: Config, resolve: (name: string) => Promise<Workspace>, onStateChange: StateListener = () => {}, handbook = '', options: ExecutionOptions = {}) {
    const core = new Core(config, resolve, onStateChange, handbook, options);
    core.parts = {
      start: new StartPart(core),
      turns: new TurnsPart(core),
      reviews: new ReviewsPart(core),
      mr: new MrPart(core),
      handover: new HandoverPart(core),
      control: new ControlPart(core),
      status: new StatusPart(core),
    };
    this.#core = core;
    this.jobs = core.jobs;
  }

  // Runner mode: no turn runs or waits, no review or gate runs, no state change is in progress.
  get idle(): boolean {
    return this.#core.pending === 0 && this.#core.reviews.size === 0 && ![...this.#core.live.values()].some((live) => live.session.busy);
  }

  // execution/start.ts
  recover(options: { startRunners?: boolean } = {}): Promise<void> {
    return this.#core.parts.start.recover(options);
  }

  // The catch-up after an update (SF-101): runners for the resumable jobs recover() left alone.
  ensureResumable(): Promise<void> {
    return this.#core.parts.start.ensureResumable();
  }

  start(workspaceName: string, ticket: string, { queued = false }: { queued?: boolean } = {}): Promise<{ branch: string; state: JobState; check_after_minutes: number; worktree: string }> {
    return this.#core.parts.start.start(workspaceName, ticket, { queued });
  }

  fetchBase(workspaceName: string, base: string): Promise<void> {
    return this.#core.parts.start.fetchBase(workspaceName, base);
  }

  restart(workspaceName: string, ticket: string, keepFiles = false): Promise<{ branch: string; state: JobState; check_after_minutes: number; worktree: string; archived: string; branch_deleted: string | null; kept: string[] }> {
    return this.#core.parts.start.restart(workspaceName, ticket, keepFiles);
  }

  // execution/turns.ts
  requestFix(workspaceName: string, ticket: string, content: string): Promise<{ iteration: number; check_after_minutes: number }> {
    return this.#core.parts.turns.requestFix(workspaceName, ticket, content);
  }

  say(workspaceName: string, ticket: string, message: string): Promise<{ state: JobState; queued: boolean }> {
    return this.#core.parts.turns.say(workspaceName, ticket, message);
  }

  // execution/reviews.ts
  retryReview(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number }> {
    return this.#core.parts.reviews.retryReview(workspaceName, ticket);
  }

  acceptGate(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.#core.parts.reviews.acceptGate(workspaceName, ticket);
  }

  settle(workspaceName: string, ticket: string, id: string, decision: Decision, note = ''): Promise<{ state: JobState; id: string; status: string; waiting: string[] }> {
    return this.#core.parts.reviews.settle(workspaceName, ticket, id, decision, note);
  }

  simplify(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; check_after_minutes: number }> {
    return this.#core.parts.reviews.simplify(workspaceName, ticket);
  }

  // execution/mr-steps.ts
  markClean(workspaceName: string, ticket: string, sensitive: string[] = []): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.#core.parts.mr.markClean(workspaceName, ticket, sensitive);
  }

  retryMr(workspaceName: string, ticket: string): Promise<MrOutcome | { state: JobState; iteration: number; branch: string }> {
    return this.#core.parts.mr.retryMr(workspaceName, ticket);
  }

  approve(workspaceName: string, ticket: string, asIs = false): Promise<MrOutcome> {
    return this.#core.parts.mr.approve(workspaceName, ticket, asIs);
  }

  createMergeRequest(workspaceName: string, ticket: string): Promise<MrOutcome> {
    return this.#core.parts.mr.createMergeRequest(workspaceName, ticket);
  }

  mergeRequestView(workspaceName: string, ticket: string): Promise<MrView | undefined> {
    return this.#core.parts.mr.mergeRequestView(workspaceName, ticket);
  }

  saveMr(workspaceName: string, ticket: string, input: MrInput): Promise<MrSaved> {
    return this.#core.parts.mr.saveMr(workspaceName, ticket, input);
  }

  resetMr(workspaceName: string, ticket: string): Promise<MrSaved> {
    return this.#core.parts.mr.resetMr(workspaceName, ticket);
  }

  mergeMergeRequest(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; mr: JobMr }> {
    return this.#core.parts.mr.mergeMergeRequest(workspaceName, ticket);
  }

  mergeRequestStatus(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; mr: JobMr; status: MergeRequestStatus }> {
    return this.#core.parts.mr.mergeRequestStatus(workspaceName, ticket);
  }

  mergeRequestHost(workspaceName: string): Promise<{ host: ForgeKind | null; reason: string | null }> {
    return this.#core.parts.mr.mergeRequestHost(workspaceName);
  }

  // execution/handover-steps.ts
  afterTaskCheck(workspaceName: string, ticket: string): Promise<void> {
    return this.#core.parts.handover.afterTaskCheck(workspaceName, ticket);
  }

  afterJobChange(job: Job, from: JobState | null): Promise<void> {
    return this.#core.parts.handover.afterJobChange(job, from);
  }

  handOverLocked(workspace?: string): Promise<void> {
    return this.#core.parts.handover.handOverLocked(workspace);
  }

  // The hand-over operations running in this process now (SF-101: sf serve's serve-busy).
  handoversRunning(): HandoverRunning[] {
    return this.#core.parts.handover.running();
  }

  handover(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string }> {
    return this.#core.parts.handover.handover(workspaceName, ticket);
  }

  takeback(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; worktree: string }> {
    return this.#core.parts.handover.takeback(workspaceName, ticket);
  }

  handedDone(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; commit?: string; same_tree?: boolean | null }> {
    return this.#core.parts.handover.handedDone(workspaceName, ticket);
  }

  checkHandedOver(workspaceName: string, ticket: string, minIntervalMs = 0): Promise<{ state: JobState; branch: string; commit?: string; same_tree?: boolean | null }> {
    return this.#core.parts.handover.checkHandedOver(workspaceName, ticket, minIntervalMs);
  }

  // execution/control.ts
  exclusive<T>(work: (scope: ExclusiveScope) => Promise<T>): Promise<T> {
    return this.#core.parts.control.exclusive(work);
  }

  abort(workspaceName: string, ticket: string, discard: boolean): Promise<{ state: JobState; branch: string; discarded: boolean; worktree: string | null; error?: { code: string; message: string } }> {
    return this.#core.parts.control.abort(workspaceName, ticket, discard);
  }

  pause(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; step: PauseStep | null }> {
    return this.#core.parts.control.pause(workspaceName, ticket);
  }

  limitReset(workspaceName: string, ticket: string, parkedAt: string, resume: boolean): Promise<'resumed' | 'waiting' | 'failed' | 'skipped'> {
    return this.#core.parts.control.limitReset(workspaceName, ticket, parkedAt, resume);
  }

  resumePaused(workspaceName: string, ticket: string, message = ''): Promise<Resumed> {
    return this.#core.parts.control.resumePaused(workspaceName, ticket, message);
  }

  reset(workspaceName: string, ticket: string): Promise<Retired> {
    return this.#core.parts.control.reset(workspaceName, ticket);
  }

  archiveFinished(workspaceName: string, ticket: string): Promise<Retired> {
    return this.#core.parts.control.archiveFinished(workspaceName, ticket);
  }

  apply(request: RunnerRequest): Promise<unknown> {
    return this.#core.parts.control.apply(request);
  }

  resume(): Promise<void> {
    return this.#core.parts.control.resume();
  }

  stop(): Promise<void> {
    return this.#core.parts.control.stop();
  }

  // execution/status.ts
  check(workspace: string, ticket: string, offset = 0, maxBytes = DEFAULT_PAGE_BYTES): Promise<CheckResult> {
    return this.#core.parts.status.check(workspace, ticket, offset, maxBytes);
  }

  status(workspace?: string, ticket?: string): Promise<Job[]> {
    return this.#core.parts.status.status(workspace, ticket);
  }
}
