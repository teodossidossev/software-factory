// The hand-over of a job's branch to the user's checkout: handover, takeback, the check of the
// user's own push, Ask for changes, the repair of a cut-off step, the saved refs, and the sandbox's
// leftover config lock around hand-overs and sessions (handOverLocked, afterTaskCheck,
// afterJobChange).
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pushedBranch } from '../continues.js';
import { FactoryError } from '../errors.js';
import { runGit } from '../git.js';
import { askForChanges, commitMessagePath, finishAsk, handOver, remoteBranch, type RemoteBranch, restoreConfig, takeBack, undoHandover } from '../handoff.js';
import { type FileChange, type Handover, type Job, type JobState, now } from '../jobs.js';
import { mrMessage } from '../mr.js';
import { notificationLine } from '../patch.js';
import { checkoutGitDir, type LockScan, removeStaleSandboxLock, staleSandboxLock } from '../sandbox-lock.js';
import type { Workspace } from '../registry.js';
import { updateMarked } from '../update.js';
import { removeWorktree } from '../worktree.js';
import type { JobStorePort, LockPort, SettingsPort } from './ports.js';
import type { MrContent } from './dto.js';
import { cutOffError, mrFailure } from './errors.js';

// The states in which a job's sessions may run under Claude Code's sandbox, which binds the
// workspace checkout's .git/config.lock into each sandboxed command: the Implementer's
// turns (working, and the MR text and conflict turns of preparing_mr) and the reviewers' sessions.
const SANDBOXED_STATES: readonly JobState[] = ['working', 'awaiting_review', 'preparing_mr'];

// The refusal of a hand-over or Take it back that met the sandbox's leftover config lock while
// another job of the workspace ran, whose sandbox may be using it; a hand-over refused so
// runs by itself once none runs.
const CONFIG_LOCKED_CODE = 'config_locked';

const CONFIG_LOCKED = {
  handover: 'Another job of this workspace is running; the hand-over runs when it ends.',
  takeback: 'Another job of this workspace is running; Take it back when it ends.',
} as const;

// Whether a job of the workspace, other than the ticket except, is in one of the SANDBOXED_STATES.
const sandboxesRunning = (jobs: Job[], workspace: string, except?: string): boolean =>
  jobs.some((job) => job.workspace === workspace && job.ticket !== except && SANDBOXED_STATES.includes(job.state));

// A job waiting in ready_for_human_review because its hand-over met the sandbox's leftover config
// lock while another job of the workspace ran.
const lockedOut = (job: Job): boolean => job.state === 'ready_for_human_review' && job.handoff_skipped?.code === CONFIG_LOCKED_CODE;

// How long the saved refs of a pushed or aborted job stay.
const SAVED_REF_DAYS = 7;

// A hand-over operation running in this process (sf serve's serve-busy): the hand-over (by
// hand, or the factory's own after config_locked), Take it back, I opened the MR myself, and the
// background check of the user's push.
export type HandoverOperation = 'hand_over' | 'take_back' | 'handed_done' | 'push_check';
export interface HandoverRunning {
  workspace: string;
  ticket: string;
  step: HandoverOperation;
}

// What HandoverPart calls of the other parts, by just those methods.
export interface HandoverMr {
  mrContent(job: Job): Promise<MrContent>;
  settled(workspaceName: string, ticket: string): Promise<void>;
}

export interface HandoverStatus {
  lastFiles(job: Job): Promise<FileChange[] | undefined>;
}

export interface HandoverPeers {
  readonly mr: HandoverMr;
  readonly status: HandoverStatus;
}

export class HandoverPart {
  readonly #store: JobStorePort;
  readonly #locks: LockPort;
  readonly #settings: SettingsPort;
  // The parts it calls (src/execution.ts wires them).
  readonly #peers: HandoverPeers;
  // The hand-over operations running now, each added when it begins and removed when it ends.
  readonly #running = new Set<HandoverRunning>();

  constructor(store: JobStorePort, locks: LockPort, settings: SettingsPort, peers: HandoverPeers) {
    this.#store = store;
    this.#locks = locks;
    this.#settings = settings;
    this.#peers = peers;
  }

  // The hand-over operations running in this process now (a copy).
  running(): HandoverRunning[] {
    return [...this.#running].map((entry) => ({ ...entry }));
  }

  async #tracked<T>(workspace: string, ticket: string, step: HandoverOperation, work: () => Promise<T>): Promise<T> {
    const entry: HandoverRunning = { workspace, ticket, step };
    this.#running.add(entry);
    try {
      return await work();
    } finally {
      this.#running.delete(entry);
    }
  }

  worktreePath(workspace: string, ticket: string): string {
    return join(this.#settings.config.worktreeRoot, workspace, ticket);
  }

  // A hand-over or an Ask for changes that sf serve's restart cut off. handing_over is
  // undone when it is safe (the checkout on the branch holding exactly the job's commit, or still on
  // what it was on): the job waits in ready_for_human_review with its worktree, handoff_skipped
  // handover_interrupted; otherwise nothing in the checkout changes and the job needs the user.
  // asking is finished from the snapshot without the turn (needs_human, ask_interrupted). Only under
  // the lock.
  async repairHandover(job: Job, handover: Handover): Promise<void> {
    const workspace = await this.#settings.resolve(job.workspace);
    const checkout = workspace.workCheckout;
    const worktree = job.worktree ?? this.worktreePath(job.workspace, job.ticket);
    const { ticket, branch } = job;
    if (handover.step === 'asking') {
      let message = 'sf serve restarted during Ask for changes; your edits are in the job\'s worktree; use sf say to go on.';
      try {
        const { kept } = await this.#locks.gitLocked(job.workspace, () => finishAsk(checkout, worktree, ticket, handover));
        if (kept.length > 0) {
          await this.handoverNote(job, `Ask for changes left these files in your checkout, changed after the snapshot: ${kept.join(', ')}.`);
        }
      } catch (error) {
        message = `sf serve restarted during Ask for changes and it could not be finished (${(error as Error).message.slice(0, 300)}); your checkout is saved as refs/factory/${ticket}-ask.`;
      }
      // from: handed_over (asking cut off), or any later state still carrying the step but starting, failed and pushed (JOB_TRANSITIONS)
      await this.#store.transition({ ...(await this.#endHandover(job)), worktree, prepared_commit: null }, 'needs_human', 'repair_handover', { code: 'ask_interrupted', message });
      return;
    }
    const undone = await this.#locks.gitLocked(job.workspace, () => undoHandover(checkout, worktree, ticket, handover)).catch((error: unknown) => {
      console.error(error);
      return false;
    });
    if (!undone) {
      // Not the checkout's files: the factory's commit.template and commit.cleanup go anyway.
      await this.#locks.gitLocked(job.workspace, () => restoreConfig(checkout, ticket, handover)).catch((error: unknown) => console.error(error));
    }
    const ended = await this.#endHandover(job);
    if (undone) {
      const skipped = { code: 'handover_interrupted', message: `${ticket}: sf serve restarted during the hand-over, which was undone; hand it over again when you are ready.` };
      // from: preparing_mr and ready_for_human_review (handing_over cut off), or needs_human and aborted still carrying the cut-off step
      await this.#store.transition({ ...ended, worktree, handoff_skipped: skipped }, 'ready_for_human_review', 'repair_handover');
      return;
    }
    // from: preparing_mr and ready_for_human_review (handing_over cut off), handed_over (asking), or any later state still carrying the step but starting, failed and pushed (JOB_TRANSITIONS)
    await this.#store.transition(ended, 'needs_human', 'repair_handover', {
      code: 'handover_interrupted',
      message: `sf serve restarted during the hand-over of ${ticket} and your checkout is not as the factory left it, so nothing was changed there: the branch ${branch} may be checked out in your checkout, the job's commit is saved as refs/factory/${ticket}, and the job's worktree may be detached or gone.`,
    });
  }

  // The saved refs of the hand-over (refs/factory/<ticket>, refs/factory/<ticket>-ask) go once
  // every job they may belong to is pushed or aborted for more than 7 days, or does not exist.
  async cleanSavedRefs(): Promise<void> {
    const jobs = new Map((await this.#store.jobs.list()).map((job) => [`${job.workspace}/${job.ticket}`, job]));
    const gone = (workspace: string, ticket: string): boolean => {
      const job = jobs.get(`${workspace}/${ticket}`);
      return job === undefined || (['pushed', 'aborted'].includes(job.state) && Date.now() - Date.parse(job.updated_at) > SAVED_REF_DAYS * 24 * 3600 * 1000);
    };
    for (const name of await this.#store.jobs.workspaceNames()) {
      let workspace: Workspace;
      try {
        workspace = await this.#settings.resolve(name);
      } catch {
        continue;
      }
      await this.#locks.gitLocked(name, async () => {
        const listed = await runGit(workspace.workCheckout, ['for-each-ref', '--format=%(refname)', 'refs/factory/']);
        for (const ref of listed.stdout.toString('utf8').split('\n').filter((line) => line.startsWith('refs/factory/'))) {
          const short = ref.slice('refs/factory/'.length);
          const owners = short.endsWith('-ask') ? [short, short.slice(0, -'-ask'.length)] : [short];
          if (owners.every((ticket) => gone(name, ticket))) {
            await runGit(workspace.workCheckout, ['update-ref', '-d', ref]);
          }
        }
      });
    }
  }

  // The hand-over of a prepared job to the workspace's checkout (src/handoff.ts), under the
  // workspace's Git lock: the record with step handing_over is written before the checkout changes.
  // ok: the job to move to handed_over (its worktree gone, or kept when it could not be removed);
  // else the refusal and the job as written (without the record). Only under the lock.
  async handOver(job: Job, workspace: Workspace, content: MrContent): Promise<{ ok: true; job: Job } | { ok: false; job: Job; error: { code: string; message: string } }> {
    let current = job;
    const record = async (handover: Handover): Promise<void> => {
      current = { ...current, handover };
      await this.#store.jobs.write(current);
    };
    try {
      const done = await this.#locks.gitLocked(job.workspace, async () => {
        await this.#freeConfig(job, workspace.workCheckout, 'handover');
        return handOver({
          checkout: workspace.workCheckout, worktree: job.worktree, ticket: job.ticket, branch: job.branch,
          saved: job.prepared_commit!, base: job.base_commit!, message: `${content.title}\n\n${content.body}`, at: now(), record,
        });
      });
      const { handoff_skipped: _skipped, ...rest } = current;
      const next: Job = { ...rest, handover: done.handover, worktree: done.removeFailure === undefined ? null : job.worktree };
      await this.#store.jobs.write(next);
      await this.#store.jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration: job.iteration, type: 'handover', action: 'handed_over', handover: done.handover });
      if (done.removeFailure !== undefined) {
        await this.handoverNote(next, `The worktree could not be removed after the hand-over: ${done.removeFailure}`);
      }
      return { ok: true, job: next };
    } catch (error) {
      const failure = error instanceof FactoryError ? { code: error.code, message: error.message } : mrFailure(error);
      // An undo that failed keeps the record with its step: recover() repairs it when sf serve
      // starts, or tells where things are.
      if (failure.code === 'handover_interrupted') {
        return { ok: false, job: current, error: failure };
      }
      const { handover: _record, ...rest } = current;
      await this.#store.jobs.write(rest);
      return { ok: false, job: rest, error: failure };
    }
  }

  // Where the lock check looks: the Execution's lockProc (tests only), else the real /proc.
  #scan(): LockScan {
    return this.#locks.lockProc === undefined ? {} : { proc: this.#locks.lockProc };
  }

  // The sandbox's leftover config lock in the workspace checkout's Git directory: removed when it
  // is stale (src/sandbox-lock.ts) and no job of the workspace other than the ticket except is in
  // working, awaiting_review or preparing_mr (their sandboxes may be using it). removed: gone, with
  // the event sandbox_lock_removed in log.job's log (in sf serve's output without log); busy: stale
  // but kept for a running job; none: no stale lock. Only under the workspace's Git lock.
  async #sandboxLock(workspace: string, checkout: string, except: string | undefined, log: { job: Job; iteration: number } | undefined): Promise<'removed' | 'busy' | 'none'> {
    const gitDir = await checkoutGitDir(checkout);
    if (!(await staleSandboxLock(gitDir, this.#scan()))) {
      return 'none';
    }
    if (sandboxesRunning(await this.#store.jobs.list(), workspace, except)) {
      return 'busy';
    }
    // Checked again right before the removal.
    const path = await removeStaleSandboxLock(gitDir, this.#scan());
    if (path === undefined) {
      return 'none';
    }
    if (log !== undefined) {
      await this.#store.jobs.appendEvent(log.job.workspace, log.job.ticket, { ts: now(), iteration: log.iteration, type: 'sandbox_lock_removed', path });
    } else {
      console.log(`${workspace}: removed the sandbox's leftover ${path}`);
    }
    return 'removed';
  }

  // #sandboxLock after a session ended, under the workspace's Git lock, only when a stale lock is
  // there (most turns find none and take no lock). A failure is only logged.
  async clearAfter(workspace: string, except: string | undefined, log: { job: Job; iteration: number } | undefined): Promise<void> {
    try {
      const { workCheckout } = await this.#settings.resolve(workspace);
      if (!(await staleSandboxLock(await checkoutGitDir(workCheckout), this.#scan()))) {
        return;
      }
      await this.#locks.gitLocked(workspace, () => this.#sandboxLock(workspace, workCheckout, except, log));
    } catch (error) {
      console.error(error);
    }
  }

  // Right before a hand-over or Take it back, under the workspace's Git lock: a stale sandbox lock
  // goes; one kept for another running job refuses with config_locked and the action's message
  // (CONFIG_LOCKED), before anything changes. A lock that is not stale stays: Git's own refusal tells of it.
  async #freeConfig(job: Job, checkout: string, action: keyof typeof CONFIG_LOCKED): Promise<void> {
    if ((await this.#sandboxLock(job.workspace, checkout, job.ticket, { job, iteration: job.iteration })) === 'busy') {
      throw new FactoryError(CONFIG_LOCKED_CODE, CONFIG_LOCKED[action]);
    }
  }

  // sf serve, when a Task check of the workspace ended and no other check of it runs: the
  // check's worktree shares the checkout's Git directory, so its sandbox may have left the lock;
  // it goes unless a job of the workspace runs. The removal is logged in the ticket's job, if any.
  async afterTaskCheck(workspaceName: string, ticket: string): Promise<void> {
    const job = await this.#store.jobs.read(workspaceName, ticket).catch(() => undefined);
    await this.clearAfter(workspaceName, undefined, job === undefined ? undefined : { job, iteration: job.iteration });
  }

  // sf serve, on each job change it sees: when a job left the SANDBOXED_STATES (working,
  // awaiting_review, preparing_mr; a move between two of them does not count), or one came to wait
  // with config_locked, the workspace's jobs waiting with config_locked are handed over once none
  // of its jobs is in one of those states. The retry changes a job only by
  // the hand-over itself (handed_over) or by its handoff_skipped in the same state, neither of
  // which brings it here again.
  async afterJobChange(job: Job, from: JobState | null): Promise<void> {
    const left = from !== null && SANDBOXED_STATES.includes(from) && !SANDBOXED_STATES.includes(job.state);
    const waiting = from !== job.state && lockedOut(job);
    if (left || waiting) {
      await this.handOverLocked(job.workspace);
    }
  }

  // sf serve (at start, and through afterJobChange): hands over the jobs waiting with config_locked
  // of the workspace (of every workspace without one) in which no job is in the SANDBOXED_STATES. A
  // refusal becomes the job's handoff_skipped; nothing is thrown. While the factory is being updated
  // (the updating marker) it returns at once; the catch-up after the update calls it again.
  async handOverLocked(workspace?: string): Promise<void> {
    if (updateMarked(this.#settings.config.stateDir)) {
      return;
    }
    const all = await this.#store.jobs.list();
    for (const job of all.filter((one) => lockedOut(one) && (workspace === undefined || one.workspace === workspace))) {
      if (sandboxesRunning(all, job.workspace)) {
        continue;
      }
      try {
        const outcome = await this.#handover(job.workspace, job.ticket, true);
        if (outcome !== undefined) {
          console.log(`${job.workspace}/${job.ticket}: handed over to the checkout now that no other job of the workspace runs`);
        }
      } catch (error) {
        console.error(`${job.workspace}/${job.ticket}: the hand-over after config_locked failed: ${(error as Error).message}`);
      }
    }
  }

  async handoverNote(job: Job, note: string): Promise<void> {
    console.error(`${job.workspace}/${job.ticket}: ${note}`);
    await this.#store.jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration: job.iteration, type: 'handover', action: 'note', note });
  }

  // The hand-over ended (Ask for changes, Take it back, the push, abort): the record goes into the
  // event log; the job is returned without it.
  async #endHandover(job: Job): Promise<Job> {
    const { handover, ...rest } = job;
    if (handover !== undefined) {
      await this.#store.jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration: job.iteration, type: 'handover', action: 'ended', handover });
    }
    return rest;
  }

  // sf handover: hands a job waiting in ready_for_human_review over to the checkout. A
  // refusal (checkout_dirty, checkout_busy, handover_refused, handover_mismatch) leaves the job as it
  // was and is returned as the error; config_locked becomes its handoff_skipped too, so
  // the factory hands it over by itself once no other job of the workspace runs.
  handover(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string }> {
    return this.#handover(workspaceName, ticket, false) as Promise<{ state: JobState; branch: string }>;
  }

  // retry: the factory's own hand-over of a job waiting with config_locked (handOverLocked): a job
  // no longer waiting so is left alone, and a refusal becomes its handoff_skipped instead of an
  // error; undefined then.
  #handover(workspaceName: string, ticket: string, retry: boolean): Promise<{ state: JobState; branch: string } | undefined> {
    return this.#tracked(workspaceName, ticket, 'hand_over', () => this.#handoverLocked(workspaceName, ticket, retry));
  }

  #handoverLocked(workspaceName: string, ticket: string, retry: boolean): Promise<{ state: JobState; branch: string } | undefined> {
    return this.#locks.locked(async () => {
      const check = (job: Job): boolean => {
        if (retry && !lockedOut(job)) {
          return false;
        }
        if (job.state !== 'ready_for_human_review') {
          throw new FactoryError('invalid_state', `sf handover needs ready_for_human_review; the job is ${job.state}.`);
        }
        if (job.prepared_commit === null || job.base_commit === null) {
          throw new FactoryError('invalid_state', `The job ${workspaceName}/${ticket} has no prepared commit to hand over.`);
        }
        return true;
      };
      if (!check(await this.#store.job(workspaceName, ticket))) {
        return undefined;
      }
      await this.#peers.mr.settled(workspaceName, ticket);
      const job = await this.#store.job(workspaceName, ticket);
      if (!check(job)) {
        return undefined;
      }
      const workspace = await this.#settings.resolve(workspaceName);
      const content = await this.#peers.mr.mrContent(job);
      const outcome = await this.handOver(job, workspace, content);
      if (!outcome.ok) {
        if (outcome.error.code === 'handover_interrupted') {
          // from: ready_for_human_review (check above; handOver keeps the state)
          await this.#store.transition(outcome.job, 'needs_human', 'hand_over', outcome.error);
        } else if (retry || outcome.error.code === CONFIG_LOCKED_CODE) {
          await this.#store.jobs.write({ ...outcome.job, handoff_skipped: outcome.error });
        }
        if (retry) {
          console.error(`${workspaceName}/${ticket}: not handed over: ${outcome.error.message} (${outcome.error.code})`);
          return undefined;
        }
        throw new FactoryError(outcome.error.code, outcome.error.message);
      }
      // from: ready_for_human_review (check above; handOver keeps the state)
      const next = await this.#store.transition(outcome.job, 'handed_over', 'hand_over', undefined, [content.title, notificationLine((await this.#peers.status.lastFiles(job)) ?? [])]);
      return { state: next.state, branch: next.branch };
    });
  }

  // sf takeback: the job back from the checkout into ready_for_human_review, only while
  // the checkout is as the factory left it (takeback_changed otherwise). ready_for_human_review is
  // not running: no limit applies.
  takeback(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; worktree: string }> {
    return this.#tracked(workspaceName, ticket, 'take_back', () => this.#locks.locked(async () => {
      this.checkHandedOverJob(await this.#store.job(workspaceName, ticket), 'sf takeback');
      await this.#peers.mr.settled(workspaceName, ticket);
      const job = await this.#store.job(workspaceName, ticket);
      const handover = this.checkHandedOverJob(job, 'sf takeback');
      const workspace = await this.#settings.resolve(workspaceName);
      const worktree = job.worktree ?? this.worktreePath(workspaceName, ticket);
      await this.#locks.gitLocked(workspaceName, async () => {
        // The config is restored after the switch back: a lock kept for a running job refuses first.
        await this.#freeConfig(job, workspace.workCheckout, 'takeback');
        await takeBack(workspace.workCheckout, worktree, ticket, handover);
      });
      // from: handed_over (checkHandedOverJob)
      const next = await this.#store.transition({ ...(await this.#endHandover(job)), worktree, prepared_commit: handover.saved }, 'ready_for_human_review', 'take_back');
      return { state: next.state, branch: next.branch, worktree };
    }));
  }

  // A handed-over job with no step of the hand-over in progress, and its record; invalid_state otherwise.
  checkHandedOverJob(job: Job, command: string): Handover {
    if (job.state !== 'handed_over' || job.handover === undefined) {
      throw new FactoryError('invalid_state', `${command} needs handed_over; the job is ${job.state}.`);
    }
    if (job.handover.step !== null) {
      throw cutOffError(job, job.handover.step);
    }
    return job.handover;
  }

  // sf handed-done: the user opened the merge request from the checkout; origin must have
  // the branch beyond the base (not_pushed otherwise), and the job goes to pushed.
  handedDone(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; commit?: string; same_tree?: boolean | null }> {
    return this.#pushCheck(workspaceName, ticket, true);
  }

  // The check for the user's own push of a handed-over branch: origin is asked where the job's
  // pushed branch is (its continued branch, if any), outside the lock; a branch pushed beyond the
  // base moves the job to pushed. Errors change nothing and are logged. minIntervalMs: none when
  // origin was asked as recently (the dashboard's job detail, every 60 s at most).
  async checkHandedOver(workspaceName: string, ticket: string, minIntervalMs = 0): Promise<{ state: JobState; branch: string; commit?: string; same_tree?: boolean | null }> {
    try {
      return await this.#pushCheck(workspaceName, ticket, false, minIntervalMs);
    } catch (error) {
      console.error(error);
      const job = await this.#store.jobs.read(workspaceName, ticket);
      return { state: job?.state ?? 'handed_over', branch: job?.branch ?? '' };
    }
  }

  #pushCheck(workspaceName: string, ticket: string, done: boolean, minIntervalMs = 0): Promise<{ state: JobState; branch: string; commit?: string; same_tree?: boolean | null }> {
    return this.#tracked(workspaceName, ticket, done ? 'handed_done' : 'push_check', () => this.#pushCheckTracked(workspaceName, ticket, done, minIntervalMs));
  }

  async #pushCheckTracked(workspaceName: string, ticket: string, done: boolean, minIntervalMs: number): Promise<{ state: JobState; branch: string; commit?: string; same_tree?: boolean | null }> {
    const asked = await this.#locks.locked(async () => {
      const job = await this.#store.job(workspaceName, ticket);
      if (!done && (job.state !== 'handed_over' || job.handover === undefined || job.handover.step !== null)) {
        return { job };
      }
      this.checkHandedOverJob(job, 'sf handed-done');
      const checked = job.handover!.checked_at;
      if (!done && checked !== null && Date.now() - Date.parse(checked) < minIntervalMs) {
        return { job };
      }
      await this.#peers.mr.settled(workspaceName, ticket);
      // Only the background check counts toward its interval; sf handed-done asks on demand.
      if (done) {
        return { job, handover: job.handover! };
      }
      const next: Job = { ...job, handover: { ...job.handover!, checked_at: now() } };
      await this.#store.jobs.write(next);
      return { job: next, handover: next.handover! };
    });
    if (asked.handover === undefined) {
      return { state: asked.job.state, branch: asked.job.branch };
    }
    const workspace = await this.#settings.resolve(workspaceName);
    const remote = await remoteBranch(workspace.workCheckout, ticket, asked.handover, pushedBranch(asked.job));
    return this.#locks.locked(async () => {
      const job = await this.#store.job(workspaceName, ticket);
      // The job moved on (or was handed over again) while origin answered.
      if (job.state !== 'handed_over' || job.handover?.at !== asked.handover.at || job.handover.step !== null) {
        if (done) {
          throw new FactoryError('invalid_state', `The job changed while origin was asked; it is ${job.state}.`);
        }
        return { state: job.state, branch: job.branch };
      }
      await this.#peers.mr.settled(workspaceName, ticket);
      const pushed = this.#pushedCommit(job, remote, done);
      if (pushed === undefined) {
        return { state: job.state, branch: job.branch };
      }
      await this.#store.jobs.appendEvent(workspaceName, ticket, { ts: now(), iteration: job.iteration, type: 'handover_pushed', commit: pushed.commit, same_tree: pushed.same_tree });
      const next = await this.#pushedByUser(job, workspace, pushed.commit);
      return { state: next.state, branch: next.branch, commit: pushed.commit, same_tree: pushed.same_tree };
    });
  }

  // The commit origin has that counts as the user's push, or undefined; with done (sf
  // handed-done), not_pushed instead of undefined, and an unknown commit counts (same_tree null).
  #pushedCommit(job: Job, remote: RemoteBranch, done: boolean): { commit: string; same_tree: boolean | null } | undefined {
    if (remote.kind === 'pushed') {
      return { commit: remote.commit, same_tree: remote.same_tree };
    }
    if (remote.kind === 'unknown' && done) {
      return { commit: remote.commit, same_tree: null };
    }
    if (!done) {
      return undefined;
    }
    if (remote.kind === 'unrelated') {
      throw new FactoryError('not_pushed', `The branch ${pushedBranch(job)} on origin (${remote.commit.slice(0, 12)}) does not descend from the job's base ${job.handover!.base.slice(0, 12)}; push your changes to it first.`);
    }
    throw new FactoryError('not_pushed', `The branch ${pushedBranch(job)} is not on origin with your changes; push it first.`);
  }

  // A handed-over job the user pushed: the config and the prefilled commit message go, a worktree
  // left over goes, and the job is pushed with the pushed commit. Only under the lock.
  async #pushedByUser(job: Job, workspace: Workspace, commit: string): Promise<Job> {
    const ended = await this.leaveCheckout(job, workspace, true);
    const title = mrMessage((await this.#store.jobs.readMrText(job.workspace, job.ticket)) ?? '').title;
    // from: handed_over (#pushCheck: checkHandedOverJob, checked again under the lock)
    return this.#store.transition({ ...ended, prepared_commit: commit }, 'pushed', 'pushed_by_user', undefined, [title]);
  }

  // A handed-over job leaves the checkout (the push, abort): the factory's commit.template and
  // commit.cleanup go back, with pushed the prefilled message file and a worktree left over too.
  // Returns the job without the hand-over record.
  async leaveCheckout(job: Job, workspace: Workspace, pushed: boolean): Promise<Job> {
    const checkout = workspace.workCheckout;
    let worktree = job.worktree;
    if (job.handover !== undefined) {
      const handover = job.handover;
      await this.#locks.gitLocked(job.workspace, async () => {
        await restoreConfig(checkout, job.ticket, handover);
        if (pushed) {
          await rm(await commitMessagePath(checkout, job.ticket), { force: true });
        }
      });
    }
    if (pushed && worktree !== null) {
      const failure = await this.#locks.gitLocked(job.workspace, () => removeWorktree(checkout, worktree!));
      if (failure === undefined) {
        worktree = null;
      } else {
        await this.handoverNote(job, `The worktree could not be removed after the push: ${failure}`);
      }
    }
    return { ...(await this.#endHandover(job)), worktree };
  }

  // Ask for changes on a handed-over job, in the runner before the turn, under the
  // workspace's Git lock: the checkout's state goes into refs/factory/<ticket>-ask and the job's
  // worktree, and the checkout gives the branch back. A refusal before the switch (checkout_moved,
  // checkout_busy, checkout_changing, handover_refused) leaves everything as it was; a failure after
  // it is finished from the snapshot once more, else the job needs the user (ask_interrupted) and
  // recover() finishes it. Returns the job without the record, with its worktree. Only under the lock.
  async askForChanges(job: Job, workspace: Workspace): Promise<Job> {
    const handover = this.checkHandedOverJob(job, 'sf say');
    const checkout = workspace.workCheckout;
    const worktree = job.worktree ?? this.worktreePath(job.workspace, job.ticket);
    let current = job;
    const record = async (next: Handover): Promise<void> => {
      current = { ...current, handover: next };
      await this.#store.jobs.write(current);
    };
    let kept: string[];
    try {
      ({ kept } = await this.#locks.gitLocked(job.workspace, () => askForChanges({ checkout, worktree, ticket: job.ticket, handover, record })));
    } catch (error) {
      const recorded = current.handover;
      if (recorded?.step !== 'asking' || (error instanceof FactoryError && error.code === 'checkout_changing')) {
        if (recorded?.step === 'asking') {
          await this.#store.jobs.write({ ...current, handover });
        }
        throw error;
      }
      try {
        ({ kept } = await this.#locks.gitLocked(job.workspace, () => finishAsk(checkout, worktree, job.ticket, recorded)));
      } catch (again) {
        console.error(again);
        const message = `Ask for changes failed after your checkout was saved as refs/factory/${job.ticket}-ask (${(error as Error).message.slice(0, 300)}); sf serve finishes it when it starts again.`;
        // from: handed_over (checkHandedOverJob)
        await this.#store.transition({ ...current, prepared_commit: null }, 'needs_human', 'ask_for_changes', { code: 'ask_interrupted', message });
        throw new FactoryError('ask_interrupted', message);
      }
    }
    if (kept.length > 0) {
      await this.handoverNote(current, `Ask for changes left these files in your checkout, changed after the snapshot: ${kept.join(', ')}.`);
    }
    return { ...(await this.#endHandover(current)), worktree, prepared_commit: null };
  }
}
