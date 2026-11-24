// The user's control of a job and the runner's requests: pause and Resume, the park on a usage
// limit and its reset, abort, reset, Archive (retire), Merged — archive and the pass of merged jobs, exclusive (the start
// screen's section under the lock), and the requests sf serve queues to a job's runner (request, apply, resume, stop),
// among them the move of a part onto its base that the pass of merged jobs asks for.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { changedImages, type ImageRef, jobAttachment, type JobAttachment, type ResolvedImage, resolveTaskImages, sameImages } from '../attachments.js';
import { FactoryError } from '../errors.js';
import { GATE_REVIEWER } from '../gate.js';
import { claudeReviews, type Job, type JobState, LIMIT_RETRY_MS, now, PAUSABLE_STATES, type PauseStep, RESUMABLE_STATES, TERMINAL_STATES } from '../jobs.js';
import { type Decision, SIMPLIFIER } from '../ledger.js';
import { gitBusy } from '../mr.js';
import { factoryPrompt } from '../prompts.js';
import { DENIED_TOOLS } from '../rules.js';
import { factoryRoots, reapOrphanedSandboxes } from '../sandbox-reaper.js';
import type { Workspace } from '../registry.js';
import { readJobRules } from '../rules-docs.js';
import { actedVerdict, REVIEWER } from '../review.js';
import type { RunnerRequest } from '../runner.js';
import { withoutDropped } from '../stops.js';
import { readTask, TASK_DIR, taskDiff, taskSha256 } from '../task-file.js';
import type { UsageLimit } from '../usage-limit.js';
import { deleteBranch, removeWorktree } from '../worktree.js';
import type { ImplementerSession } from '../session.js';
import type { JobStorePort, LivePort, LockPort, RunnerPort, SettingsPort, StopPort } from './ports.js';
import { archiveWithTask, MergedPass } from './archive.js';
import type { ExclusiveScope, Resumed, Retired } from './dto.js';
import { checkNotInCheckout } from './errors.js';
import { firstPrompt, imagesChangedNote, readJobFindings, sessionBlocks } from './prompts.js';
import { exists, type FixOptions, gateSkipped } from './shared.js';

// What ControlPart calls of the other parts, by just those methods.
export interface ControlHandover {
  leaveCheckout(job: Job, workspace: Workspace, pushed: boolean): Promise<Job>;
  markHandedDone(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string }>;
  worktreePath(workspace: string, ticket: string): string;
}

export interface ControlMr {
  checkPrepareMr(job: Job, accepted?: boolean): boolean;
  checkRetryMr(job: Job): void;
  checkMove(job: Job): void;
  moveInRunner(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; branch: string }>;
  prepareMr(job: Job, sensitive: string[], options?: { onAccepted?: () => Promise<void>; retry?: boolean }): Promise<{ state: JobState; iteration: number; branch: string }>;
  retryMrInRunner(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; branch: string }>;
  settled(workspaceName: string, ticket: string): Promise<void>;
}

export interface ControlReviews {
  acceptGateInRunner(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; branch: string }>;
  applySimplify(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; check_after_minutes: number }>;
  checkAcceptGate(job: Job): string;
  checkRetryReview(job: Job): void;
  checkSettle(job: Job, id: string, decision: string, note: string): void;
  checkSimplify(job: Job): void;
  imageRefs(job: Job, task: string): ImageRef[];
  retryReviewInRunner(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number }>;
  settleInRunner(workspaceName: string, ticket: string, id: string, decision: Decision, note: string): Promise<{ state: JobState; id: string; status: string; waiting: string[] }>;
  startReview(job: Job): Promise<void>;
  stopLastReviews(): void;
}

export interface ControlStart {
  copyTask(workspace: Workspace, job: Job): Promise<string | undefined>;
  recordTask(job: Job, content: string): Promise<Job>;
  removePlaceholders(cwd: string): Promise<string[]>;
  resumable(job: Job): Promise<boolean>;
  storeImages(job: Job, images: ResolvedImage[]): Promise<Job>;
  syncTask(workspace: Workspace, job: Job): Promise<Job>;
}

export interface ControlTurns {
  checkFix(job: Job): void;
  checkSay(job: Job, message: string): void;
  fix(current: Job, content: string, options?: FixOptions): Promise<{ iteration: number; check_after_minutes: number }>;
  imagesLine(job: Job): { dir: string; names: string[] } | undefined;
  sayInRunner(workspaceName: string, ticket: string, message: string): Promise<{ state: JobState; queued: boolean }>;
  session(job: Job, workspace: Workspace): ImplementerSession;
  withChange(prompt: string, ticket: string, change: { diff: string | undefined } | undefined): string;
}

export interface ControlPeers {
  readonly handover: ControlHandover;
  readonly mr: ControlMr;
  readonly reviews: ControlReviews;
  readonly start: ControlStart;
  readonly turns: ControlTurns;
}

export class ControlPart {
  readonly #store: JobStorePort;
  readonly #locks: LockPort;
  readonly #sessions: LivePort;
  readonly #runner: RunnerPort;
  readonly #settings: SettingsPort;
  readonly #stop: StopPort;
  // The parts it calls (src/execution.ts wires them).
  readonly #peers: ControlPeers;
  // The pass of merged jobs (its logged failures, its run under way) and Merged — archive, with this part's ports.
  readonly #mergedPass = new MergedPass(() => ({ store: this.#store, locks: this.#locks, settings: this.#settings,
    archive: (w, t) => this.archiveFinished(w, t), markHandedDone: (w, t) => this.#peers.handover.markHandedDone(w, t),
    move: (w, t) => this.request(w, t, { kind: 'move' }) }));

  constructor(store: JobStorePort, locks: LockPort, sessions: LivePort, runner: RunnerPort, settings: SettingsPort, stop: StopPort, peers: ControlPeers) {
    this.#store = store;
    this.#locks = locks;
    this.#sessions = sessions;
    this.#runner = runner;
    this.#settings = settings;
    this.#stop = stop;
    this.#peers = peers;
  }

  // Runs work under the same lock as the job operations, for changes that must not interleave
  // with a start (the workspace registry and the ticket actions of the dashboard's start screen).
  // The scope lets the work retire a finished job inside the same lock acquisition. It closes
  // when the work settles, so a later call cannot reach a job created after it, and the lock is
  // held until every retirement started through it has settled, awaited by the work or not. A
  // retirement that fails fails the section: with the work's own error when the work failed too,
  // else with the retirement's (never a success the retirement did not have).
  exclusive<T>(work: (scope: ExclusiveScope) => Promise<T>): Promise<T> {
    return this.#locks.locked(async () => {
      let open = true;
      // Each started retirement as a promise that never rejects; the failures are kept here. The
      // handler is attached at once, so an unawaited failure is never an unhandled rejection.
      const started: Array<Promise<void>> = [];
      const failures: unknown[] = [];
      const scope: ExclusiveScope = {
        retireFinished: (workspaceName, ticket) => {
          if (!open) {
            return Promise.reject(new FactoryError('scope_closed', 'The exclusive section has ended; the job was not retired.'));
          }
          const retirement = this.#finishedJob(workspaceName, ticket, 'job_active').then((job) => this.#retire(job));
          started.push(retirement.then(() => undefined, (error: unknown) => {
            failures.push(error);
          }));
          return retirement;
        },
      };
      let result: T;
      try {
        result = await work(scope);
      } finally {
        open = false;
        await Promise.all(started);
      }
      if (failures.length > 0) {
        throw failures[0];
      }
      return result;
    });
  }

  async #logPlaceholders(job: Job, iteration: number, paths: string[]): Promise<void> {
    if (paths.length > 0) {
      await this.#store.jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration, type: 'placeholders_removed', paths });
    }
  }

  // Removes the placeholders and logs them under iteration (the turn's, as its messages are).
  async clean(job: Job, iteration: number, cwd: string): Promise<void> {
    try {
      await this.#logPlaceholders(job, iteration, await this.#peers.start.removePlaceholders(cwd));
    } catch (error) {
      console.error(error);
    }
  }

  // Cancels the job's running review, gate, simplification pass or test run (its abort kills the sandbox's process group); its outcome is then never applied.
  #cancelReview(key: string): void {
    this.#sessions.reviews.get(key)?.controller.abort();
    this.#sessions.reviews.delete(key);
  }

  // Ends the job: the runner stops (and with it the session, the review, the gate and a run of the
  // test command); the worktree stays unless discard, which removes it and the branch.
  abort(workspaceName: string, ticket: string, discard: boolean): Promise<{ state: JobState; branch: string; discarded: boolean; worktree: string | null; error?: { code: string; message: string } }> {
    return this.#locks.locked(async () => {
      const found = await this.#store.job(workspaceName, ticket);
      if (TERMINAL_STATES.includes(found.state)) {
        throw new FactoryError('invalid_state', `The job is already ${found.state}.`);
      }
      if (discard) {
        checkNotInCheckout(found);
      }
      if (found.state === 'handed_over') {
        // The checkout holds the branch: no runner may be running.
        await this.#peers.mr.settled(workspaceName, ticket);
      }
      const workspace = await this.#settings.resolve(workspaceName);
      const existing = async (job: Job): Promise<string | null> => (job.worktree !== null && (await exists(job.worktree)) ? job.worktree : null);
      const before = await existing(found);
      if (discard && before !== null && (await gitBusy(before))) {
        throw new FactoryError('rebase_in_progress', 'A rebase or a Git lock is in progress in the worktree; discard would lose it. Finish or abort it first, or abort without --discard.');
      }
      await this.endSession(workspaceName, ticket);
      // The job as its runner left it; one it handed over meanwhile keeps the checkout as it is.
      let job = await this.#store.job(workspaceName, ticket);
      if (discard) {
        checkNotInCheckout(job);
      }
      if (job.state === 'handed_over') {
        job = await this.#peers.handover.leaveCheckout(job, workspace, false);
      }
      const worktree = await existing(job);
      if (worktree !== null) {
        await this.clean(job, job.iteration, worktree);
      }
      const ending = job;
      const failure = discard ? await this.#locks.gitLocked(workspaceName, () => this.#discard(workspace.workCheckout, ending, worktree)) : undefined;
      const kept = discard && failure === undefined ? null : worktree;
      // from: every state not in TERMINAL_STATES
      const next = await this.#store.transition({ ...job, worktree: kept }, 'aborted', 'abort', failure);
      return { state: next.state, branch: next.branch, discarded: discard && failure === undefined, worktree: kept, ...(failure !== undefined ? { error: failure } : {}) };
    });
  }

  // sf pause: stops the job where it is, the way abort does (the runner stops, and with it
  // the turn, the review, the gate or the simplification pass and their processes), and the job
  // goes to paused with its worktree, branch, session, iterations, ledger and events. A review round
  // that ran is thrown away, recorded as interrupted (never as a verdict), and runs again on Resume.
  // A step that ended on its own as the runner stopped leaves the job as it left it; one that had
  // begun MR preparation hands the job to the user (mr_interrupted).
  pause(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; step: PauseStep | null }> {
    return this.#locks.locked(async () => {
      const found = await this.#store.job(workspaceName, ticket);
      if (found.state === 'preparing_mr') {
        throw new FactoryError('invalid_state', 'The job is preparing the MR (the MR text, the commit and the rebase); it cannot be paused now. Wait until it waits for you, or abort it.');
      }
      if (!(PAUSABLE_STATES as readonly JobState[]).includes(found.state)) {
        throw new FactoryError('invalid_state', `sf pause needs working or awaiting_review; the job is ${found.state}.`);
      }
      await this.endSession(workspaceName, ticket);
      // The job as its runner left it.
      const job = await this.#store.job(workspaceName, ticket);
      if (job.state === 'preparing_mr') {
        // from: preparing_mr (the guard above)
        const next = await this.#store.transition(job, 'needs_human', 'pause', {
          code: 'mr_interrupted',
          message: 'The job was paused as its MR preparation began; go on with sf say (its iteration is reviewed again and a clean verdict prepares the branch again), or abort or reset the job.',
        });
        return { state: next.state, branch: next.branch, step: null };
      }
      if (job.state !== 'working' && job.state !== 'awaiting_review') {
        return { state: job.state, branch: job.branch, step: null };
      }
      const from = job.state;
      const iteration = from === 'working' ? job.iteration + 1 : job.iteration;
      if (job.worktree !== null && (await exists(job.worktree))) {
        await this.clean(job, iteration, job.worktree);
      }
      const step = await this.#interruptedStep(job);
      let paused: Job = { ...job, paused: { from, step, at: now() } };
      if (step === 'simplify') {
        // The pass runs again on Resume: its one run per job was not used up.
        const { simplify_iteration: _started, ...rest } = paused;
        paused = rest;
      }
      if (step !== null) {
        const reviewer = { review: REVIEWER, gate: GATE_REVIEWER, simplify: SIMPLIFIER, turn: undefined }[step];
        await this.#store.jobs.appendEvent(workspaceName, ticket, { ts: now(), iteration, type: 'interrupted', step, ...(reviewer !== undefined ? { reviewer } : {}) });
      }
      // from: working, awaiting_review (the guard above)
      const next = await this.#store.transition(paused, 'paused', 'pause');
      return { state: next.state, branch: next.branch, step };
    });
  }

  // A session of the job hit the plan's usage limit: the job parks in waiting_limit, as a
  // pause would leave it (paused: from working for the turn, awaiting_review for a round; the
  // interrupted event, so the round is due again on Resume; a simplification pass not used up), with
  // the limit: its provider and when the run queue goes on (the parsed reset, else paused.at + 30
  // minutes). Nothing of the round is recorded. Only under the lock, in the runner.
  async park(job: Job, step: PauseStep, limit: UsageLimit): Promise<void> {
    const from = job.state === 'working' ? 'working' as const : 'awaiting_review' as const;
    const iteration = from === 'working' ? job.iteration + 1 : job.iteration;
    const at = now();
    const resetsAt = limit.resets_at ?? new Date(Date.parse(at) + LIMIT_RETRY_MS).toISOString();
    // The pass runs again on Resume: its one run per job was not used up.
    const { simplify_iteration: _started, ...withoutPass } = job;
    const parked: Job = { ...(step === 'simplify' ? withoutPass : job), paused: { from, step, at }, limit: { provider: limit.provider, resets_at: resetsAt } };
    const reviewer = { review: REVIEWER, gate: GATE_REVIEWER, simplify: SIMPLIFIER, turn: undefined }[step];
    await this.#store.jobs.appendEvent(job.workspace, job.ticket, { ts: at, iteration, type: 'interrupted', step, ...(reviewer !== undefined ? { reviewer } : {}) });
    // from: working (#idle), awaiting_review (#reviewed, #gated, #simplifyEnded: current)
    await this.#store.transition(parked, 'waiting_limit', 'park');
  }

  // The run queue's step for a parked job whose limit reset, in sf serve. The job is read
  // again under the lock: one no longer parked since the queue saw it (parkedAt: its paused.at;
  // aborted, reset, restarted, resumed by hand, parked again) or already handled is skipped. resume:
  // the job is resumed as sf resume does it, without a message (its runner's reply awaited outside the
  // lock; a resume that fails hands the job to the user with that error: failed); otherwise the
  // reset is only marked (reset_seen, notified_at) and the job waits for the user (waiting).
  async limitReset(workspaceName: string, ticket: string, parkedAt: string, resume: boolean): Promise<'resumed' | 'waiting' | 'failed' | 'skipped'> {
    // A resume that fails, queued or in the runner: the job, still parked as the queue saw it, goes
    // to the user with the error. Only under the lock.
    const fail = async (error: unknown): Promise<'failed'> => {
      const failure = error instanceof FactoryError ? { code: error.code, message: error.message } : { code: 'resume_failed', message: `The resume after the usage limit failed: ${(error as Error).message}`.slice(0, 1000) };
      const job = await this.#store.jobs.read(workspaceName, ticket);
      if (job?.state === 'waiting_limit' && job.paused?.at === parkedAt) {
        // from: waiting_limit (the guard above)
        await this.#store.transition(job, 'needs_human', 'limit_reset', failure);
      }
      return 'failed';
    };
    const queued = await this.#locks.locked(async (): Promise<string | 'waiting' | 'skipped' | 'failed'> => {
      const job = await this.#store.jobs.read(workspaceName, ticket);
      if (job === undefined || job.state !== 'waiting_limit' || job.limit === undefined || job.limit.reset_seen === true || job.paused?.at !== parkedAt) {
        return 'skipped';
      }
      if (!resume) {
        await this.#store.jobs.write({ ...job, limit: { ...job.limit, reset_seen: true, notified_at: now() } });
        return 'waiting';
      }
      try {
        return await this.#runner.serveRunners().queue(workspaceName, ticket, { kind: 'resume', message: '' });
      } catch (error) {
        return fail(error);
      }
    });
    if (queued === 'waiting' || queued === 'skipped' || queued === 'failed') {
      return queued;
    }
    try {
      await this.#runner.serveRunners().reply(workspaceName, ticket, queued);
      return 'resumed';
    } catch (error) {
      return this.#locks.locked(() => fail(error));
    }
  }

  // What a job in working or awaiting_review was doing: the turn, or the review round that runs or
  // is due on its last iteration (review while the Claude review has no stored verdict, else gate
  // while the gate of a joint round has none, then the simplification pass once started); null
  // when none was (awaiting review with the review off). Without the Claude review the gate is the
  // review: due while its gate.json is missing.
  async #interruptedStep(job: Job): Promise<PauseStep | null> {
    const { workspace, ticket, iteration } = job;
    if (job.state === 'working') {
      return 'turn';
    }
    if (iteration === 0) {
      return null;
    }
    const gate = await this.#store.jobs.readGate(workspace, ticket, iteration);
    if (!claudeReviews(job)) {
      if (gate === undefined) {
        return this.#settings.config.review ? 'gate' : null;
      }
    } else {
      const review = await this.#store.jobs.readReview(workspace, ticket, iteration);
      // A stored failure counts as none: in a joint round the gate may still run.
      if (review === undefined || !('verdict' in review)) {
        return this.#settings.config.review ? 'review' : null;
      }
      // A gate the iteration's gate level skipped counts as absent, as with the gate off.
      if (gate === undefined && this.#settings.config.gate.on && !(await gateSkipped(this.#store.jobs, job))) {
        return 'gate';
      }
      if (actedVerdict(withoutDropped(review)) !== 'clean') {
        return null;
      }
    }
    if (gate !== undefined && (!('verdict' in gate) || actedVerdict(withoutDropped(gate)) !== 'clean')) {
      return null;
    }
    return job.simplify_iteration === iteration && (await this.#store.jobs.readSimplify(workspace, ticket, iteration)) === undefined ? 'simplify' : null;
  }

  // sf resume: the paused job goes on where it stopped. A turn: the same Implementer session
  // goes on with the message, or "Continue where you stopped."; a review round: it runs again on the
  // same iteration (no message: sf say sends one after). When the Task file changed since the
  // Implementer was last given it, the new one is copied into the worktree (the reviewers read it
  // there), its sha256 recorded, and the turn's message carries its diff. A start by hand: the run
  // queue's limit does not apply.
  async resumePaused(workspaceName: string, ticket: string, message = ''): Promise<Resumed> {
    const id = await this.#locks.locked(async () => {
      const job = await this.#store.job(workspaceName, ticket);
      const request = { kind: 'resume' as const, message };
      this.#check(job, request);
      return this.#runner.serveRunners().queue(workspaceName, ticket, request);
    });
    return this.#runner.serveRunners().reply(workspaceName, ticket, id) as Promise<Resumed>;
  }

  // sf resume needs a paused job, or one parked on a usage limit (resumed now, before the
  // reset); a message only when a turn was paused, and then plain text. From waiting_limit the job
  // already holds its slot.
  #checkResume(job: Job, message: string): void {
    if (!RESUMABLE_STATES.includes(job.state)) {
      throw new FactoryError('invalid_state', `sf resume needs paused or waiting_limit; the job is ${job.state}.`);
    }
    if (message.includes('\0')) {
      throw new FactoryError('invalid_content', 'The message must be text.');
    }
    if (message.trim() !== '' && job.paused?.from !== 'working') {
      throw new FactoryError('invalid_content', `The job was paused ${job.paused?.step != null ? `during the ${job.paused.step}, which runs again` : 'awaiting review'} on Resume; Resume takes no message then. Resume without one, then send it with sf say.`);
    }
  }

  // The Resume in the runner.
  #resumePaused(workspaceName: string, ticket: string, message: string): Promise<Resumed> {
    return this.#locks.locked(async () => {
      const job = await this.#store.job(workspaceName, ticket);
      this.#checkResume(job, message);
      if (job.worktree === null || !(await exists(job.worktree))) {
        throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf restart the ticket.`);
      }
      const workspace = await this.#settings.resolve(workspaceName);
      const pause = job.paused ?? { from: 'working' as const, step: 'turn' as const };
      // The images the Task file refers to now, from the folder: an image changed while
      // paused is found even when the text did not change; one that cannot be used refuses the
      // Resume before anything changes (the job stays paused).
      const images = await resolveTaskImages(workspace.workCheckout, ticket, await readTask(workspace, ticket));
      const before: JobAttachment[] = job.attachments ?? [];
      const records = images.map(jobAttachment);
      const imagesChanged = sameImages(before, records) ? undefined : changedImages(before, records);
      const change = await this.taskChange(workspace, job);
      if (change !== undefined) {
        await this.#store.jobs.appendEvent(workspaceName, ticket, { ts: now(), iteration: job.iteration, type: 'task_changed', from: job.task_sha256 ?? null, to: change.sha256 });
      }
      let current = job;
      if (imagesChanged !== undefined) {
        current = await this.#peers.start.storeImages(job, images);
      }
      let next: Job;
      if (pause.from === 'working') {
        // from: paused, waiting_limit (#checkResume)
        next = await this.#store.transition(await this.#peers.start.syncTask(workspace, current), 'working', 'resume');
        const first = await this.#resumePrompt(next, message);
        // Only the order changed: every image is named.
        const names = imagesChanged === undefined ? [] : imagesChanged.length > 0 ? imagesChanged : records.map((image) => image.name);
        const text = names.length > 0 ? `${this.#peers.turns.withChange(first, ticket, change)}\n\n${imagesChangedNote(names)}` : this.#peers.turns.withChange(first, ticket, change);
        // A new Implementer session has not seen the images: its first prompt carries their blocks.
        const blocks = next.session_id === null ? this.#peers.reviews.imageRefs(next, (await this.#store.jobs.readTaskCopy(workspaceName, ticket)) ?? '') : [];
        this.#peers.turns.session(next, workspace).send(factoryPrompt(text, ticket, next.iteration + 1, this.#peers.turns.imagesLine(next), next.base_commit), DENIED_TOOLS, blocks);
      } else {
        // The reviewers read the new Task file (copyTask writes it into the worktree and as their copy,
        // review-task.md) and its sha256 is recorded; task.md keeps what the Implementer was last given,
        // so its next prompt (a Fix section, sf say) carries the diff. They get the job's images as they are now.
        const content = await this.#peers.start.copyTask(workspace, current);
        // from: paused, waiting_limit (#checkResume)
        next = await this.#store.transition(content === undefined ? current : await this.#peers.start.recordTask(current, content), 'awaiting_review', 'resume');
        await this.#pickUp(next);
      }
      return { state: next.state, iteration: next.iteration, step: pause.step, task_changed: change !== undefined };
    });
  }

  // The first prompt of a Resume from working: the message, else "Continue where you stopped.". A
  // Resume that opens a new Implementer session (no session_id yet) gives the job's <rules> and
  // <recurring_findings> blocks first: with iteration 0 and no message, the job's first prompt.
  async #resumePrompt(job: Job, message: string): Promise<string> {
    const text = message.trim() !== '' ? message : 'Continue where you stopped.';
    if (job.session_id !== null) {
      return text;
    }
    const dir = this.#store.jobs.dir(job.workspace, job.ticket);
    const [rules, findings] = await Promise.all([readJobRules(dir), readJobFindings(dir)]);
    if (message.trim() === '' && job.iteration === 0) {
      return firstPrompt(job.ticket, [], rules, undefined, findings);
    }
    return [...sessionBlocks(rules, findings), text].join('\n\n');
  }

  // Whether the ticket's Task file changed since the Implementer was last given it (the job's copy, else the worktree's), and its diff; undefined when it did not, or when nothing tells.
  async taskChange(workspace: Workspace, job: Job): Promise<{ diff: string | undefined; sha256: string } | undefined> {
    const current = await readTask(workspace, job.ticket);
    const sha256 = taskSha256(current);
    const before = (await this.#store.jobs.readTaskCopy(job.workspace, job.ticket))
      ?? (job.worktree !== null ? await readFile(join(job.worktree, TASK_DIR, `${job.ticket}.md`), 'utf8').catch(() => undefined) : undefined);
    if (before === undefined) {
      return job.task_sha256 !== undefined && job.task_sha256 !== sha256 ? { diff: undefined, sha256 } : undefined;
    }
    return before === current ? undefined : { diff: await taskDiff(job.ticket, before, current), sha256 };
  }

  // Stops the job's runner, which ends its session and cancels its review, whose outcome is then never applied.
  async endSession(workspace: string, ticket: string): Promise<void> {
    const key = `${workspace}/${ticket}`;
    this.#cancelReview(key);
    const live = this.#sessions.live.get(key);
    this.#sessions.live.delete(key);
    await live?.session.close();
    await this.#runner.runners?.stop(workspace, ticket);
    // The Bash sandboxes the session's Claude Code left, before the config lock check
    // below, as one of them may still hold the lock open.
    await this.#reapSandboxes();
    // The session stopped without an idle outcome (abort, pause, restart, reset): the sandbox's
    // leftover config lock goes as after a turn's end, unless another job runs.
    const job = await this.#store.jobs.read(workspace, ticket).catch(() => undefined);
    if (job !== undefined) {
      await this.#sessions.afterSession(job, job.state === 'working' || job.state === 'preparing_mr' ? job.iteration + 1 : job.iteration);
    }
  }

  // The worktree and the branch go; the checkout is not touched.
  async #discard(checkout: string, job: Job, worktree: string | null): Promise<{ code: string; message: string } | undefined> {
    const removed = worktree === null ? undefined : await removeWorktree(checkout, worktree);
    if (removed !== undefined) {
      return { code: 'discard_failed', message: `${removed} The worktree needs a look.` };
    }
    const deleted = await deleteBranch(checkout, job.branch);
    if (deleted !== undefined) {
      return { code: 'discard_failed', message: `${deleted} The checkout needs a look.` };
    }
    return undefined;
  }

  // The escape hatch: in any state, ends the session, removes the worktree and archives the job; the
  // branch is not touched. A job whose workspace is no longer registered (or whose checkout is gone) is
  // still archived: only the Git clean-up of the checkout is skipped, and the result says so.
  reset(workspaceName: string, ticket: string): Promise<Retired> {
    return this.#locks.locked(async () => {
      const job = await this.#store.job(workspaceName, ticket);
      checkNotInCheckout(job);
      return this.#retire(job);
    });
  }

  // The Archive of a Done card or job page, of Merged — archive and of the pass of merged jobs: reset, for a finished job
  // only. With an active Task file, Setup's ticket archive checks it again and moves the file too in its
  // own lock acquisition; else the state is checked and the job retired in one, so a newer job is refused.
  async archiveFinished(workspaceName: string, ticket: string): Promise<Retired> {
    const job = await this.#locks.locked(() => this.#finishedJob(workspaceName, ticket, 'invalid_state'));
    return (await archiveWithTask(this.#settings, job)) ?? this.#locks.locked(async () => this.#retire(await this.#finishedJob(workspaceName, ticket, 'invalid_state')));
  }

  // sf serve's pass of merged jobs and Merged — archive (MergedPass, archive.ts): the jobs found merged, or the user's, marked and archived.
  archiveMergedJobs(): Promise<Job[]> {
    return this.#mergedPass.run();
  }
  markMerged(workspaceName: string, ticket: string): Promise<Retired & { state: JobState }> {
    return this.#mergedPass.markMerged(workspaceName, ticket);
  }

  // The ticket's current job, refused unless it is terminal, with the code (and the message) of
  // the caller: invalid_state for the job card, job_active for a ticket action. Only under the lock.
  async #finishedJob(workspaceName: string, ticket: string, code: 'invalid_state' | 'job_active'): Promise<Job> {
    const job = await this.#store.job(workspaceName, ticket);
    if (!TERMINAL_STATES.includes(job.state)) {
      throw new FactoryError(code, code === 'invalid_state' ? `Only a finished job can be archived; the job is ${job.state}. Abort it first.`
        : `The job for ${workspaceName}/${ticket} is ${job.state}; abort it first.`);
    }
    return job;
  }

  // Ends the session, removes the worktree (best effort, logged) and archives the job directory;
  // the branch is not touched. Only under the lock, with the job read under the same acquisition.
  async #retire(job: Job): Promise<Retired> {
    const { workspace: workspaceName, ticket } = job;
    const key = `${workspaceName}/${ticket}`;
    const unregistered = (error: unknown): undefined => {
      if (error instanceof FactoryError && (error.code === 'workspace_not_found' || error.code === 'workspace_invalid')) {
        return undefined;
      }
      throw error;
    };
    const workspace: Workspace | undefined = this.#sessions.live.get(key)?.workspace ?? (await this.#settings.resolve(workspaceName).catch(unregistered));
    await this.endSession(workspaceName, ticket);
    if (workspace !== undefined) {
      const checkout = workspace.workCheckout;
      const worktree = job.worktree ?? this.#peers.handover.worktreePath(workspaceName, ticket);
      const failure = await this.#locks.gitLocked(workspaceName, () => removeWorktree(checkout, worktree));
      if (failure !== undefined) {
        console.error(`${key}: ${failure}`);
      }
    }
    const archived = await this.#store.jobs.archive(workspaceName, ticket);
    return { archived: `jobs/${workspaceName}/${archived}`, branch: job.branch, ...(workspace === undefined ? { checkout: 'unavailable' as const } : {}) };
  }

  // sf serve's side of a request: under the lock (so approve, abort and reset see it queued), the
  // state is checked first, so a request the runner would refuse starts no runner, and the request
  // is queued; then the runner's reply, outside the lock, is the result. The runner checks again
  // when it applies the request.
  async request(workspaceName: string, ticket: string, request: Exclude<RunnerRequest, { kind: 'turn' }>): Promise<unknown> {
    const id = await this.#locks.locked(async () => {
      const job = await this.#store.job(workspaceName, ticket);
      this.#check(job, request);
      // Ask for changes and every other answer of the user is not a new start: the run queue's
      // limit does not apply.
      return this.#runner.serveRunners().queue(workspaceName, ticket, request);
    });
    return this.#runner.serveRunners().reply(workspaceName, ticket, id);
  }

  // The state checks of a request, the same in sf serve and in the runner.
  #check(job: Job, request: Exclude<RunnerRequest, { kind: 'turn' }>): void {
    switch (request.kind) {
      case 'say':
        this.#peers.turns.checkSay(job, request.message);
        break;
      case 'fix':
        this.#peers.turns.checkFix(job);
        break;
      case 'clean':
        this.#peers.mr.checkPrepareMr(job);
        break;
      case 'review':
        this.#peers.reviews.checkRetryReview(job);
        break;
      case 'retry':
        this.#peers.mr.checkRetryMr(job);
        break;
      case 'move':
        this.#peers.mr.checkMove(job);
        break;
      case 'accept':
        this.#peers.reviews.checkAcceptGate(job);
        break;
      case 'settle':
        this.#peers.reviews.checkSettle(job, request.id, request.decision, request.note);
        break;
      case 'simplify':
        this.#peers.reviews.checkSimplify(job);
        break;
      case 'resume':
        this.#checkResume(job, request.message);
        break;
    }
  }

  // Runner mode: applies one request of sf serve to the job.
  apply(request: RunnerRequest): Promise<unknown> {
    const { workspace, ticket } = this.#runner.runnerJob();
    switch (request.kind) {
      case 'turn':
        return this.#locks.locked(async () => {
          const job = await this.#store.job(workspace, ticket);
          if (job.state !== 'working') {
            throw new FactoryError('invalid_state', `The first turn needs working; the job is ${job.state}.`);
          }
          this.#peers.turns.session(job, await this.#settings.resolve(workspace)).send(request.prompt, DENIED_TOOLS, request.images);
          return {};
        });
      case 'say':
        return this.#peers.turns.sayInRunner(workspace, ticket, request.message);
      case 'fix':
        return this.#locks.locked(async () => this.#peers.turns.fix(await this.#store.job(workspace, ticket), request.content));
      case 'clean':
        return this.#locks.locked(async () => this.#peers.mr.prepareMr(await this.#store.job(workspace, ticket), request.sensitive));
      case 'review':
        return this.#peers.reviews.retryReviewInRunner(workspace, ticket);
      case 'retry':
        return this.#peers.mr.retryMrInRunner(workspace, ticket);
      case 'move':
        return this.#peers.mr.moveInRunner(workspace, ticket);
      case 'accept':
        return this.#peers.reviews.acceptGateInRunner(workspace, ticket);
      case 'settle':
        return this.#peers.reviews.settleInRunner(workspace, ticket, request.id, request.decision, request.note);
      case 'simplify':
        return this.#peers.reviews.applySimplify(workspace, ticket);
      case 'resume':
        return this.#resumePaused(workspace, ticket, request.message);
    }
  }

  // Runner mode: what the job was doing when its last runner ended. A job awaiting review gets the
  // reviewers of its round without a stored verdict (src/round.ts), or, with every verdict stored,
  // the round's outcome: the next Fix section, a stop, or its simplification pass or MR preparation.
  resume(): Promise<void> {
    const { workspace, ticket } = this.#runner.runnerJob();
    return this.#locks.locked(async () => {
      const job = await this.#store.jobs.read(workspace, ticket);
      if (job !== undefined) {
        await this.#pickUp(job);
      }
    });
  }

  // The review round a job awaiting review has to run or apply (startReview: only the reviewers
  // without a stored verdict run), unless one runs already. Only under the lock.
  async #pickUp(job: Job): Promise<void> {
    if (!this.#sessions.reviews.has(`${job.workspace}/${job.ticket}`) && (await this.#peers.start.resumable(job))) {
      await this.#peers.reviews.startReview(job);
    }
  }

  // Runner mode, on SIGTERM (abort, reset): the turn, the review, the gate, a run of the test
  // command and the last review end and their outcome is never applied; resolves once the state
  // change in progress, if any, is written.
  async stop(): Promise<void> {
    this.#stop.setStopping();
    for (const key of [...this.#sessions.reviews.keys()]) {
      this.#cancelReview(key);
    }
    this.#peers.reviews.stopLastReviews();
    const sessions = [...this.#sessions.live.values()].map((live) => live.session);
    this.#sessions.live.clear();
    await Promise.all(sessions.map((session) => session.close()));
    await this.#reapSandboxes();
    await this.#locks.locked(async () => undefined);
  }

  // Ends the orphaned Bash sandboxes of the factory's sessions: those under its worktree
  // root or state directory. Never throws.
  #reapSandboxes(): Promise<number[]> {
    return reapOrphanedSandboxes(factoryRoots(this.#settings.config));
  }
}
