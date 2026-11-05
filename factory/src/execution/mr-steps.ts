// MR preparation and the push (SF-089, from src/execution.ts): Clean (markClean, the commit and
// rebase, the conflict turn and the MR text turn), the Retry of a transient failure (SF-087),
// approve (the push), the merge request on the Git host (SF-048) and the Merge request screen
// (the MR text, the branch and the base the user edits).
import { createReadStream } from 'node:fs';
import { type FileHandle, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve as resolvePath } from 'node:path';
import { handoffOffNotice } from '../config.js';
import { FactoryError } from '../errors.js';
import { chooseForge, type Forge, type ForgeKind, forgeFor, type MergeRequestStatus } from '../forge.js';
import { runGit } from '../git.js';
import { checkBranchFree, isAncestor, savedRef, settleAfterPush, subjectOf } from '../handoff.js';
import { type Job, type JobMr, type JobState, now } from '../jobs.js';
import { abortRebase, branchesOnOrigin, commitAndRebase, commitMessage, continueRebase, gitFailure, mergeRequestLink, messageText, mrMessage, mrProblems, mrTextProblem, originUrl, parseOrigin, PROTECTED_BRANCHES, pushBranch, readMrText, rebaseInProgress, resolveTarget, rewriteMessage, sameMessage, unmergedPaths, validBranchName, withFindings, withNits, withSimplifications, worktreesOn } from '../mr.js';
import { buildPatch, notificationLine } from '../patch.js';
import { conflictPrompt, mrPrompt } from '../prompts.js';
import { COMMIT_TYPES, DENIED_TOOLS, MANUAL_CLAIM, MAX_HEADER_CHARS, MR_REQUIRED_HEADINGS } from '../rules.js';
import type { Workspace } from '../registry.js';
import { actedVerdict, type ReviewItem, uniqueNits } from '../review.js';
import type { IdleOutcome } from '../session.js';
import { removeWorktree } from '../worktree.js';
import { cutOffError, exists, type Live, markedGroups, MR_RETRY_CODES, type MrContent, mrFailure, type MrInput, type MrOutcome, type MrSaved, type MrView, withoutDropped } from './shared.js';
import type { Core } from './core.js';

// The Merge request screen (SF-080): the needs_human codes of a push that failed or was refused,
// in which the MR text stays editable (the prepared commit and its worktree are kept until the push).
const MR_PUSH_CODES: readonly string[] = ['mr_push_failed', 'mr_push_protected'];

const MR_READONLY = {
  pushed: 'The MR text is read-only now.',
  handed_over: 'The branch is in your checkout. Take it back to edit the MR text.',
  other: 'The MR text can be edited when the job waits for your review.',
} as const;

// Why the branch and the base are fixed: from the job only (pushed, handed over, a merge request).
const FIELD_FIXED = {
  pushed: 'Fixed after the first push.',
  handed_over: 'The branch is in your checkout.',
} as const;

// Whether the MR text is the user's (SF-080): mr-factory.md exists and its message is not mr.md's.
function editedText(factory: string | undefined, text: string | undefined): boolean {
  return factory !== undefined && text !== undefined && !sameMessage(mrMessage(factory), mrMessage(text));
}

// "10:05" of a timestamp, in the local time of sf serve.
function hhmm(ts: string): string {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// Whether two paths name the same directory (a worktree Git lists, the job's), symlinks resolved.
async function samePath(a: string, b: string | null): Promise<boolean> {
  if (b === null) {
    return false;
  }
  const real = (path: string): Promise<string> => realpath(path).catch(() => resolvePath(path));
  return (await real(a)) === (await real(b));
}

export class MrPart {
  readonly core: Core;

  constructor(core: Core) {
    this.core = core;
  }

  // The end of a turn of MR preparation (mark_clean). After the MR text turn: validate the text,
  // then the factory commits and rebases in the worktree. A rebase that stops on conflicts stays
  // in progress for one conflict turn, whose end comes back here (#conflictIdle). Ready: record
  // the branch tip, remove the worktree and hand the job to the user.
  async mrIdle(job: Job, live: Live, outcome: IdleOutcome): Promise<void> {
    const cwd = live.cwd;
    // The job as last written: with mr_conflict_turn once the conflict turn is under way.
    let current = job;
    const needsHuman = async (code: string, message: string): Promise<void> => {
      // from: preparing_mr (#idle calls mrIdle only then)
      await this.core.transition(current, 'needs_human', 'mr_turn_end', { code, message });
    };
    try {
      if (await rebaseInProgress(cwd)) {
        await this.#conflictIdle(job, live, outcome);
        return;
      }
      if (!outcome.ok) {
        await needsHuman(outcome.code, outcome.message);
        return;
      }
      const written = await readMrText(cwd, job.ticket);
      if (!written.ok) {
        await needsHuman(written.code, written.message);
        return;
      }
      // The nits of the reviewed iteration go into the MR text by the factory's hand (SF-051).
      // So do the ledger's findings not fixed: accepted risks, contests and nits left (SF-052).
      const withNitsText = withNits(written.text, await this.#nitsAtClean(job), job.iteration);
      // And the suggestions of the simplification pass the user skipped (SF-055).
      const skipped = await this.core.parts.reviews.skippedSimplifications(job);
      const withSkipped = skipped === undefined ? withNitsText : withSimplifications(withNitsText, skipped.suggestions, skipped.iteration);
      const factoryText = withFindings(withSkipped, await this.core.jobs.readLedger(job.workspace, job.ticket));
      // The user's own MR text, saved on the Merge request screen (SF-080), stays the MR text: the
      // commit is made with it, unless it fails the rules; then with the factory's new text, and the
      // screen shows the problem (approve refuses until it is saved valid or reset).
      const userText = await this.#userMrText(job);
      const mrText = { text: userText !== undefined && mrTextProblem(job.ticket, userText) === undefined ? userText : factoryText };
      const targetCommit = job.target_commit!;
      const prepared = await this.core.gitLocked(job.workspace, () => commitAndRebase(cwd, { baseCommit: job.base_commit!, targetCommit, mrText: mrText.text }));
      if (prepared.kind === 'failed') {
        await needsHuman(prepared.failure.code, prepared.failure.message);
        return;
      }
      if (userText !== undefined) {
        await this.core.jobs.writeMrFactoryText(job.workspace, job.ticket, factoryText);
        await this.core.jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration: job.iteration, type: 'mr_edited', action: 'factory_new' });
      } else {
        await this.core.jobs.writeMrText(job.workspace, job.ticket, factoryText);
        await this.core.jobs.removeMrFactoryText(job.workspace, job.ticket);
      }
      if (prepared.kind === 'conflict') {
        // The job stays preparing_mr while the Implementer resolves the conflicts.
        const targetRef = live.mr?.targetRef ?? job.base;
        live.mr = { targetRef, conflicts: prepared.files };
        // From here a stop may leave a resolution no reviewer saw: no Retry (SF-087).
        current = { ...job, mr_conflict_turn: true };
        await this.core.jobs.write(current);
        live.session.send(conflictPrompt({ ticket: job.ticket, targetRef, targetCommit, files: prepared.files }), DENIED_TOOLS);
        return;
      }
      await this.#ready(job, live, mrText.text);
    } catch (error) {
      console.error(error);
      await needsHuman('mr_failed', `MR preparation failed inside the factory: ${(error as Error).message}`.slice(0, 1000));
    }
  }

  // The MR text the user saved (SF-080): mr.md when mr-factory.md exists and differs from it;
  // undefined when the text was never edited or is the factory's again.
  async #userMrText(job: Job): Promise<string | undefined> {
    const factory = await this.core.jobs.readMrFactoryText(job.workspace, job.ticket);
    const text = await this.core.jobs.readMrText(job.workspace, job.ticket);
    return editedText(factory, text) ? text : undefined;
  }

  // The nits of the job's last iteration (SF-051): those of its Claude review and of its gate,
  // deduplicated by path and problem; the iteration that reaches Clean leaves them unapplied.
  async #nitsAtClean(job: Job): Promise<ReviewItem[]> {
    const { workspace, ticket, iteration } = job;
    const records = [await this.core.jobs.readReview(workspace, ticket, iteration), await this.core.jobs.readGate(workspace, ticket, iteration)];
    return uniqueNits(records.flatMap((record) => (record !== undefined && 'items' in record ? [record] : [])));
  }

  // The end of the conflict turn: a failed turn, a file still holding a conflict marker or a
  // failing continue aborts the rebase (mr_conflict); a failing continue first saves the resolved
  // worktree as conflict-resolution.diff of the last published iteration. After a continue the
  // change is no longer the reviewed one: it goes back to review against the target, in the same
  // worktree.
  async #conflictIdle(job: Job, live: Live, outcome: IdleOutcome): Promise<void> {
    const cwd = live.cwd;
    const files = live.mr?.conflicts ?? (await unmergedPaths(cwd));
    const targetRef = live.mr?.targetRef ?? job.base;
    const targetCommit = job.target_commit!;
    live.mr = { targetRef };
    if (!outcome.ok) {
      await this.core.gitLocked(job.workspace, () => abortRebase(cwd));
      const message = `The rebase had conflicts in ${files.join(', ')}; the conflict turn failed (${outcome.code}: ${outcome.message}). The rebase was aborted.`;
      // from: preparing_mr (mrIdle, from #idle)
      await this.core.transition(job, 'needs_human', 'mr_turn_end', { code: 'mr_conflict', message: message.slice(0, 1000) });
      return;
    }
    // A continue that fails keeps the resolution next to the iteration being rebased.
    const save = (write: (handle: FileHandle) => Promise<void>): Promise<string> => this.core.jobs.writeConflictResolution(job.workspace, job.ticket, job.iteration, write);
    const failure = await this.core.gitLocked(job.workspace, () => continueRebase(cwd, { files, targetCommit, save }));
    if (failure !== undefined) {
      // from: preparing_mr (mrIdle, from #idle)
      await this.core.transition(job, 'needs_human', 'mr_turn_end', failure);
      return;
    }
    // The resolution goes back to review with this transition: the conflict turn's window ends
    // (SF-087), so a later stop of MR preparation after a clean verdict on it may be retried.
    const rebased: Job = { ...job, base_commit: targetCommit, target_commit: targetCommit, mr_conflict_turn: false };
    const note = [
      '## MR preparation',
      '',
      `The rebase onto ${targetRef} (${targetCommit}) had conflicts in ${files.join(', ')}, resolved by the Implementer. The Patch is now against the target.`,
    ].join('\n');
    const { job: published, changes } = await this.core.parts.turns.publish(rebased, live, outcome, await buildPatch(cwd, targetCommit), [note]);
    // from: preparing_mr (mrIdle, from #idle)
    this.core.parts.reviews.startReview(await this.core.transition(published, 'awaiting_review', 'mr_turn_end', undefined, [notificationLine(changes)]));
  }

  // The branch holds the one commit on top of the target. With hand-over on (SF-073; the
  // workspace's handoff in workspaces.json, else SF_HANDOFF, SF-083) the factory hands it over to
  // the workspace's checkout at once (handed_over); a refusal leaves it in ready_for_human_review
  // with the reason (handoff_skipped), and so does hand-over off, naming the setting. The worktree
  // stays until the hand-over or the push.
  async #ready(job: Job, live: Live, mrText: string): Promise<void> {
    const cwd = live.cwd;
    const tip = (await runGit(cwd, ['rev-parse', '--verify', `refs/heads/${job.branch}`])).stdout.toString('utf8').trim();
    const content = mrMessage(mrText);
    this.core.live.delete(`${job.workspace}/${job.ticket}`);
    const lines = [content.title, notificationLine((await this.core.parts.status.lastFiles(job)) ?? [])];
    let ready: Job = { ...job, base_commit: job.target_commit, prepared_commit: tip };
    // The registry as it is now: its handoff may have changed while the job ran. When it cannot be
    // read or the checkout not verified, the setting from the job's start applies (the hand-over
    // itself then answers the checkout's problem as its refusal).
    const own = (await this.core.resolve(job.workspace).catch(() => live.workspace)).handoff;
    const off = handoffOffNotice(own, this.core.config.handoff, job.ticket);
    if (off !== undefined) {
      ready = { ...ready, handoff_skipped: off };
    } else {
      const outcome = await this.core.parts.handover.handOver(ready, live.workspace, content);
      if (outcome.ok) {
        // from: preparing_mr (mrIdle; handOver writes the job in the same state)
        await this.core.transition(outcome.job, 'handed_over', 'ready', undefined, lines);
        console.log(`${job.workspace}/${job.ticket}: branch ${job.branch} ready (${content.title}), in the checkout`);
        return;
      }
      if (outcome.error.code === 'handover_interrupted') {
        // from: preparing_mr (mrIdle; handOver writes the job in the same state)
        await this.core.transition(outcome.job, 'needs_human', 'ready', outcome.error);
        return;
      }
      ready = { ...outcome.job, handoff_skipped: outcome.error };
    }
    // from: preparing_mr (mrIdle; handOver writes the job in the same state)
    await this.core.transition(ready, 'ready_for_human_review', 'ready', undefined, lines);
    console.log(`${job.workspace}/${job.ticket}: branch ${job.branch} ready (${content.title})`);
  }

  // Clean (the deciding clean verdict): every undeclared sensitive path and every path outside the
  // Task's scope of the reviewed iteration must be acknowledged; then the target is resolved and
  // the MR text turn runs in the worktree. When it ends the factory commits and rebases (mrIdle),
  // and the job ends in ready_for_human_review with the branch in the checkout. Also the retry
  // after a failed preparation (needs_human with mr_attempts > 0).
  markClean(workspaceName: string, ticket: string, sensitive: string[] = []): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.core.parts.control.request(workspaceName, ticket, { kind: 'clean', sensitive }) as Promise<{ state: JobState; iteration: number; branch: string }>;
  }

  // Whether MR preparation may start: awaiting_review, the retry after a failed preparation, or the
  // user's Accept (acceptGate, which checked the state); returns whether it is the retry.
  checkPrepareMr(job: Job, accepted = false): boolean {
    // A prepared commit means the preparation ended (a failed push): not a retry (SF-073).
    const retry = !accepted && job.state === 'needs_human' && job.mr_attempts > 0 && job.worktree !== null && job.prepared_commit === null;
    if (!(job.state === 'awaiting_review' || retry || accepted)) {
      throw new FactoryError('invalid_state', `mark_clean needs awaiting_review (or needs_human after an MR preparation); the job is ${job.state}.`);
    }
    return retry;
  }

  // The user's Retry (sf retry, the dashboard's Retry; SF-087): a job that a transient failure
  // stopped in MR preparation after the deciding clean verdict prepares the MR again, with no fix
  // turn, no review, no gate and no simplification pass. On mr_push_failed it is approve without
  // --as-is: the push again, in sf serve.
  async retryMr(workspaceName: string, ticket: string): Promise<MrOutcome | { state: JobState; iteration: number; branch: string }> {
    const job = await this.core.job(workspaceName, ticket);
    if (job.state === 'needs_human' && job.error?.code === 'mr_push_failed') {
      return this.approve(workspaceName, ticket, false);
    }
    return this.core.parts.control.request(workspaceName, ticket, { kind: 'retry' }) as Promise<{ state: JobState; iteration: number; branch: string }>;
  }

  // sf retry needs needs_human with one of MR_RETRY_CODES, the worktree, no prepared commit and no
  // conflict turn since MR preparation began. No turn ran since: any turn leaves needs_human.
  checkRetryMr(job: Job): void {
    if (job.handover !== undefined && job.handover.step !== null) {
      throw cutOffError(job, job.handover.step);
    }
    const code = job.error?.code;
    const what = `the job is ${job.state}${code !== undefined ? ` (${code})` : ''}`;
    if (job.state !== 'needs_human' || code === undefined || !MR_RETRY_CODES.includes(code)) {
      throw new FactoryError('invalid_state', `sf retry needs needs_human after a transient MR preparation failure (${MR_RETRY_CODES.join(', ')}) or a failed push (mr_push_failed); ${what}.`);
    }
    if (job.mr_conflict_turn) {
      throw new FactoryError('invalid_state', 'The MR preparation ran a conflict turn whose changes no reviewer saw; tell the Implementer to go on (the iteration is reviewed again).');
    }
    if (job.worktree === null || job.prepared_commit !== null) {
      throw new FactoryError('invalid_state', `sf retry needs the job's worktree and no prepared commit; ${what}${job.worktree === null ? ', without a worktree' : ', with a prepared commit'}.`);
    }
  }

  // The Retry in the runner: MR preparation with the paths the clean path accepted. Those of the
  // last iteration's Claude review, and of its gate when the gate's verdict was clean (as #pickUp
  // builds them); after a gate override, the review's alone (as acceptGate passes them).
  retryMrInRunner(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.core.locked(async () => {
      const job = await this.core.job(workspaceName, ticket);
      this.checkRetryMr(job);
      if (!(await exists(job.worktree!))) {
        throw new FactoryError('invalid_state', `sf retry needs the job's worktree; the job is ${job.state} (${job.error!.code}) and its worktree ${job.worktree} is missing.`);
      }
      const review = job.iteration > 0 ? await this.core.jobs.readReview(workspaceName, ticket, job.iteration) : undefined;
      if (review === undefined || !('verdict' in review) || actedVerdict(withoutDropped(review)) !== 'clean') {
        throw new FactoryError('invalid_state', `sf retry needs a clean Claude review of the last iteration (${job.iteration}); tell the Implementer to go on.`);
      }
      const gate = await this.core.jobs.readGate(workspaceName, ticket, job.iteration);
      const overridden = (await this.core.jobs.readGateOverride(workspaceName, ticket, job.iteration)) !== undefined;
      const gateAccepted = !overridden && gate !== undefined && 'verdict' in gate && actedVerdict(withoutDropped(gate)) === 'clean' ? gate.accepted_sensitive : [];
      try {
        return await this.prepareMr(job, [...new Set([...review.accepted_sensitive, ...gateAccepted])], { retry: true });
      } catch (error) {
        // A transient failure again (the fetch) stops the job again with its code, so it can be
        // retried once more; any other refusal leaves the job as it was.
        if (error instanceof FactoryError && MR_RETRY_CODES.includes(error.code)) {
          // from: needs_human (checkRetryMr)
          await this.core.transition(job, 'needs_human', 'mr_retry', { code: error.code, message: error.message });
        }
        throw error;
      }
    });
  }

  // The work of mark_clean, also run for a clean verdict of the review. Only under the lock.
  // With onAccepted (acceptGate, which checked the state), the user's Accept is recorded by it once
  // every check has passed, before the job moves on: the gate override, or the Skip (SF-055).
  // With retry (sf retry, SF-087, which passes the clean path's accepted paths), the state is
  // checkRetryMr's; the Implementer is told the previous error only when an MR text turn ran.
  async prepareMr(job: Job, sensitive: string[], options: { onAccepted?: () => Promise<void>; retry?: boolean } = {}): Promise<{ state: JobState; iteration: number; branch: string }> {
    const { workspace: workspaceName, ticket } = job;
    const { onAccepted } = options;
    // Whether the MR text turn is told the previous error: an earlier MR text turn ran.
    let afterTextTurn: boolean;
    if (options.retry === true) {
      this.checkRetryMr(job);
      afterTextTurn = job.mr_attempts > 0;
    } else {
      afterTextTurn = this.checkPrepareMr(job, onAccepted !== undefined);
    }
    const unacknowledged = markedGroups(await this.core.parts.reviews.unaccepted(job, sensitive));
    if (unacknowledged.length > 0) {
      const lines = unacknowledged.map((group) => `${group.label.charAt(0).toUpperCase()}${group.label.slice(1)} in the reviewed iteration: ${group.paths.join(', ')}.`);
      throw new FactoryError('sensitive_unacknowledged', `${lines.join(' ')} Each must be named in the accepted sensitive paths with the reason it is needed; otherwise it is a fix item.`);
    }
    if (job.worktree === null || !(await exists(job.worktree))) {
      throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
    }
    const key = `${workspaceName}/${ticket}`;
    const live = this.core.live.get(key);
    if (live?.session.busy === true) {
      throw new FactoryError('turn_running', 'A turn of the Implementer is running; wait for it to end.');
    }
    const workspace = live?.workspace ?? (await this.core.resolve(workspaceName));
    const cwd = job.worktree;
    const target = await this.core.gitLocked(workspaceName, async () => {
      // A rebase left in progress when sf serve restarted during a conflict turn.
      await abortRebase(cwd);
      // No turn while the user's checkout holds the branch (SF-073).
      await checkBranchFree(workspace.workCheckout, cwd, job.branch, ticket);
      return resolveTarget(workspace.workCheckout, job.base);
    });
    await onAccepted?.();
    const attempt = job.mr_attempts + 1;
    // from: awaiting_review, or needs_human: the retry and Accept or Skip (checkPrepareMr, checkAcceptGate), the Retry (checkRetryMr)
    const next = await this.core.parts.start.syncTask(workspace, await this.core.transition({ ...job, target_commit: target.commit, mr_attempts: attempt, mr_conflict_turn: false }, 'preparing_mr', 'prepare_mr'));
    const prompt = mrPrompt({
      ticket, branch: job.branch, targetRef: target.ref, targetCommit: target.commit, attempt,
      previousError: afterTextTurn ? job.error?.message : undefined, handbook: this.core.handbook,
    });
    const session = this.core.parts.turns.session(next, workspace);
    this.core.live.get(key)!.mr = { targetRef: target.ref };
    session.send(prompt, DENIED_TOOLS);
    return { state: next.state, iteration: next.iteration, branch: next.branch };
  }

  // The user's approve: the branch the factory prepared at Clean is pushed. Nothing is committed
  // or rebased here; a tip that moved since is refused unless asIs.
  approve(workspaceName: string, ticket: string, asIs = false): Promise<MrOutcome> {
    return this.core.locked(async () => {
      // Refused at once in a state approve does not take; checked again once the runner has ended.
      this.#checkApprovable(await this.core.job(workspaceName, ticket), 'approve');
      await this.settled(workspaceName, ticket);
      const job = await this.core.job(workspaceName, ticket);
      this.#checkApprovable(job, 'approve');
      return this.#approve(job, await this.core.resolve(workspaceName), asIs);
    });
  }

  // The push writes a job no runner may write at the same time: the job's runner has ended (it
  // exits once the job waits for the user) and no request (sf say, a fix) waits for one;
  // runner_active otherwise. Only under the lock, under which every request is queued.
  async settled(workspaceName: string, ticket: string): Promise<void> {
    if (!(await this.core.serveRunners().settled(workspaceName, ticket))) {
      throw new FactoryError('runner_active', `The runner of ${workspaceName}/${ticket} is running a request (sf say or a fix); wait for the job to wait for you again.`);
    }
  }

  // The job's prepared branch can be pushed: ready_for_human_review, handed_over (SF-073), or
  // needs_human after a push that failed (the worktree is kept until the push).
  #approvable(job: Job): boolean {
    return job.state === 'ready_for_human_review' || job.state === 'handed_over' || (job.state === 'needs_human' && job.prepared_commit !== null);
  }

  #checkApprovable(job: Job, command: string): void {
    // A cut-off step of the hand-over is repaired first (SF-073).
    if (job.handover !== undefined && job.handover.step !== null) {
      throw cutOffError(job, job.handover.step);
    }
    if (!this.#approvable(job)) {
      throw new FactoryError('invalid_state', `${command} needs ready_for_human_review (the branch prepared at Clean); the job is ${job.state}.`);
    }
  }

  // The push of approve. With open (sf mr create from ready_for_human_review), the merge request
  // is opened after the push and before the job moves to pushed, so the one notification carries
  // its link; a merge request that fails to open leaves the job pushed, with the failure in the
  // outcome. Only under the lock.
  async #approve(job: Job, workspace: Workspace, asIs: boolean, open?: { forge: Forge; content: MrContent }): Promise<MrOutcome> {
    const { workspace: workspaceName, ticket } = job;
    const checkout = workspace.workCheckout;
    const tipResult = await runGit(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${job.branch}`]);
    const tip = tipResult.stdout.toString('utf8').trim();
    if (tipResult.code !== 0 || tip === '') {
      throw new FactoryError('branch_missing', `The branch ${job.branch} no longer exists in the checkout.`);
    }
    const plan = job.state === 'handed_over' ? await this.#handedOverPush(job, checkout, tip) : { commit: tip, source: undefined, message: undefined };
    if (job.state !== 'handed_over' && tip !== job.prepared_commit && !asIs) {
      throw new FactoryError('branch_changed', `The tip of ${job.branch} is ${tip.slice(0, 12)}, not the prepared ${(job.prepared_commit ?? '').slice(0, 12)}: it was edited by hand. Approve with --as-is to push it as it is.`);
    }
    // The MR text the push and the merge request carry (SF-080); a handed-over branch the user
    // pushes with their own commits carries theirs.
    if (!(job.state === 'handed_over' && plan.source === undefined)) {
      await this.#checkMrText(job, checkout, job.state === 'handed_over' ? job.handover!.saved : job.prepared_commit);
    }
    const pushFailure = await this.core.gitLocked(workspaceName, () => pushBranch(checkout, job.branch, job.base, plan.source));
    if (pushFailure !== undefined) {
      if (job.state === 'handed_over') {
        // The checkout, the record, the saved ref and the config stay; Approve can be retried.
        const kept: Job = { ...job, error: pushFailure };
        await this.core.jobs.write(kept);
        this.core.announce(kept, []);
        return { state: kept.state, branch: kept.branch, error: pushFailure };
      }
      // from: ready_for_human_review, needs_human (#approvable; handed_over keeps its state above)
      const next = await this.core.transition(job, 'needs_human', 'push', pushFailure);
      return { state: next.state, branch: next.branch, error: pushFailure };
    }
    let message = plan.message;
    let after: Job = job;
    if (job.state === 'handed_over') {
      const handover = job.handover!;
      if (plan.source !== undefined) {
        const changed = await this.core.gitLocked(workspaceName, () => settleAfterPush(checkout, handover));
        message = `Pushed the factory's commit ${handover.saved.slice(0, 12)}.${changed !== undefined && changed > 0 ? ` Your uncommitted changes (${changed} files) were not pushed.` : ''}`;
      }
      after = await this.core.parts.handover.leaveCheckout(job, workspace, true);
    } else if (job.worktree !== null) {
      // The worktree stays until the push (SF-073); a failure keeps its path for the next action.
      const worktree = job.worktree;
      const failure = await this.core.gitLocked(workspaceName, () => removeWorktree(checkout, worktree));
      if (failure === undefined) {
        after = { ...job, worktree: null };
      } else {
        await this.core.parts.handover.handoverNote(job, `The worktree could not be removed after the push: ${failure}`);
      }
    }
    const mrText = (await this.core.jobs.readMrText(workspaceName, ticket)) ?? '';
    const { title } = mrMessage(mrText);
    const url = await originUrl(checkout);
    const link = url === undefined ? undefined : mergeRequestLink(url, job.base, job.branch);
    let opened: (JobMr & { reused: boolean }) | undefined;
    let failure: { code: string; message: string } | undefined;
    if (open !== undefined) {
      try {
        opened = await this.#openMr(job, open.forge, open.content);
      } catch (error) {
        failure = mrFailure(error);
      }
    }
    const mr = opened === undefined ? job.mr : { host: opened.host, number: opened.number, url: opened.url, state: opened.state };
    const lines = [title, ...(opened !== undefined ? [`Merge request #${opened.number}: ${opened.url}`] : link !== undefined ? [link] : [])];
    // from: ready_for_human_review, handed_over, needs_human (#approvable)
    const pushed = await this.core.transition({ ...after, prepared_commit: plan.commit, mr }, 'pushed', 'push', undefined, lines);
    if (opened !== undefined) {
      await this.#mrEvent(pushed, opened.reused ? 'reused' : 'created');
    }
    this.core.live.delete(`${workspaceName}/${ticket}`);
    console.log(`${job.workspace}/${job.ticket}: pushed ${job.branch}\n  ${title}${link !== undefined ? `\n  ${link}` : ''}`);
    return {
      state: pushed.state, branch: pushed.branch, ...(title !== '' ? { title } : {}), ...(link !== undefined ? { link } : {}),
      ...(opened !== undefined ? { mr: opened } : {}), ...(failure !== undefined ? { error: failure } : {}), ...(message !== undefined ? { message } : {}),
    };
  }

  // What Approve pushes of a handed-over job (SF-073), from the branch's tip T in the checkout: the
  // saved commit when the user did not commit (T is B), the user's commits when they descend from
  // B, else branch_changed.
  async #handedOverPush(job: Job, checkout: string, tip: string): Promise<{ commit: string; source: string | undefined; message: string | undefined }> {
    const handover = this.core.parts.handover.checkHandedOverJob(job, 'approve');
    if (tip === handover.base) {
      return { commit: handover.saved, source: savedRef(job.ticket), message: undefined };
    }
    if (await isAncestor(checkout, handover.base, tip)) {
      return { commit: tip, source: undefined, message: `Pushed your commit ${tip.slice(0, 12)} (${await subjectOf(checkout, tip)}).` };
    }
    throw new FactoryError('branch_changed', `The tip of ${job.branch} does not descend from the job's base ${handover.base.slice(0, 12)}; push it yourself or take it back.`);
  }

  // The MR text as the merge request's title and body: the same message as the job's commit (mrMessage).
  async mrContent(job: Job): Promise<MrContent> {
    const text = await this.core.jobs.readMrText(job.workspace, job.ticket);
    if (text === undefined || text.trim() === '') {
      throw new FactoryError('mr_text_missing', `The job ${job.workspace}/${job.ticket} has no MR text to open a merge request with.`);
    }
    return mrMessage(text);
  }

  // The Forge of the job's workspace (its checkout's origin); refused when the job's merge request
  // is on another host than the origin now is.
  async #forge(job: Job, workspace?: Workspace): Promise<Forge> {
    const checkout = (workspace ?? (await this.core.resolve(job.workspace))).workCheckout;
    const forge = forgeFor(await originUrl(checkout), this.core.config.forge);
    if (job.mr !== null && job.mr.host !== forge.kind) {
      throw new FactoryError('mr_host_changed', `The merge request #${job.mr.number} is on ${job.mr.host}, but the checkout's origin is now on ${forge.kind}.`);
    }
    return forge;
  }

  async #openMr(job: Job, forge: Forge, content: MrContent): Promise<JobMr & { reused: boolean }> {
    const opened = await forge.open({ branch: job.branch, base: job.base, title: content.title, body: content.body });
    return { host: forge.kind, number: opened.number, url: opened.url, state: opened.state, reused: opened.reused };
  }

  async #mrEvent(job: Job, action: 'created' | 'reused' | 'merged' | 'updated'): Promise<void> {
    const mr = job.mr!;
    await this.core.jobs.appendEvent(job.workspace, job.ticket, {
      ts: now(), iteration: job.iteration, type: 'merge_request', action, host: mr.host, number: mr.number, url: mr.url, mr_state: mr.state,
      ...(typeof mr.merge_commit === 'string' ? { merge_commit: mr.merge_commit } : {}),
    });
  }

  // sf mr create (SF-048): opens the merge request of a pushed job on the Git host, or reuses the
  // one already open for the branch; from ready_for_human_review it is approve (the push) and then
  // the merge request, in one action. The host and its token are checked before anything is pushed.
  createMergeRequest(workspaceName: string, ticket: string): Promise<MrOutcome> {
    return this.core.locked(async () => {
      // A job that approve would push: its runner has ended first.
      if (this.#approvable(await this.core.job(workspaceName, ticket))) {
        await this.settled(workspaceName, ticket);
      }
      const job = await this.core.job(workspaceName, ticket);
      const combined = this.#approvable(job);
      if (combined) {
        this.#checkApprovable(job, 'sf mr create');
      }
      if (!(job.state === 'pushed' || combined)) {
        throw new FactoryError('invalid_state', `sf mr create needs pushed, or ready_for_human_review (approve, then the merge request); the job is ${job.state}.`);
      }
      if (job.mr?.state === 'merged') {
        throw new FactoryError('invalid_state', `The merge request #${job.mr.number} of ${workspaceName}/${ticket} is already merged.`);
      }
      const workspace = await this.core.resolve(workspaceName);
      const forge = await this.#forge(job, workspace);
      const content = await this.mrContent(job);
      if (combined) {
        return this.#approve(job, workspace, false, { forge, content });
      }
      const opened = await this.#openMr(job, forge, content);
      const next: Job = { ...job, mr: { host: opened.host, number: opened.number, url: opened.url, state: opened.state } };
      await this.core.jobs.write(next);
      await this.#mrEvent(next, opened.reused ? 'reused' : 'created');
      this.core.announce(next, [content.title, `Merge request #${opened.number}: ${opened.url}`]);
      return { state: next.state, branch: next.branch, title: content.title, mr: opened };
    });
  }

  // The Merge request screen (SF-080): the job's MR text as mrMessage reads mr.md, the factory's
  // (mr-factory.md, or the same without one), whether and when the user edited it, the branch and
  // the base and whether each can change, every problem of the saved text, the state of the screen
  // (editable, or why not), the target (the workspace's Git host and the repository of its origin),
  // the rules the page checks with, and the message of the commit the push would carry. Undefined
  // without mr.md. No network call: the origin is checked only at Save.
  async mergeRequestView(workspaceName: string, ticket: string): Promise<MrView | undefined> {
    const job = await this.core.job(workspaceName, ticket);
    const text = await this.core.jobs.readMrText(workspaceName, ticket);
    if (text === undefined) {
      return undefined;
    }
    const factoryText = await this.core.jobs.readMrFactoryText(workspaceName, ticket);
    const message = mrMessage(text);
    const factory = factoryText === undefined ? message : mrMessage(factoryText);
    const edited = editedText(factoryText, text);
    const events = await this.#mrEvents(job);
    const editable = this.#mrEditable(job);
    const pushed = job.state === 'pushed';
    // From the job only (not pushed, not handed over, no merge request); the screen's own state
    // (editable) is separate, and the page disables the fields while it is read-only.
    const fixed = pushed || job.mr !== null ? 'pushed' : job.state === 'handed_over' ? 'handed_over' : undefined;
    let readonly: string | null = null;
    if (pushed) {
      readonly = `${events.pushed_at !== null ? `Pushed at ${hhmm(events.pushed_at)}. ` : ''}${MR_READONLY.pushed}`;
    } else if (!editable) {
      readonly = job.state === 'handed_over' ? MR_READONLY.handed_over : MR_READONLY.other;
    }
    let checkout: string | undefined;
    try {
      checkout = (await this.core.resolve(workspaceName)).workCheckout;
    } catch (error) {
      if (!(error instanceof FactoryError)) {
        throw error;
      }
    }
    const sha = job.state === 'handed_over' ? job.handover?.saved ?? null : job.prepared_commit;
    const commit = checkout === undefined || sha === null ? undefined : await commitMessage(checkout, sha);
    const url = checkout === undefined ? undefined : await originUrl(checkout);
    return {
      title: message.title, body: message.body, factory, edited,
      edited_at: edited ? events.saved_at : null,
      factory_new_at: events.factory_new_at,
      branch: job.branch, base: job.base,
      branch_editable: fixed === undefined, branch_reason: fixed === undefined ? null : FIELD_FIXED[fixed],
      base_editable: fixed === undefined, base_reason: fixed === undefined ? null : FIELD_FIXED[fixed],
      problems: mrProblems(ticket, message, job.branch, job.base),
      pushed, pushed_at: events.pushed_at, editable, readonly_reason: readonly,
      target: { host: (await this.mergeRequestHost(workspaceName)).host, repository: (url === undefined ? undefined : parseOrigin(url)?.path) ?? null },
      rules: {
        commit_types: [...COMMIT_TYPES], max_header_chars: MAX_HEADER_CHARS, required_headings: [...MR_REQUIRED_HEADINGS],
        manual_claim: { source: MANUAL_CLAIM.source, flags: MANUAL_CLAIM.flags },
      },
      commit: commit ?? null,
      commit_differs: commit !== undefined && !sameMessage(commit, message),
    };
  }

  // From the job's events (SF-080): the last save that is not undone by a reset after it, the
  // last factory_new after the last save or reset, and the last change to pushed.
  async #mrEvents(job: Job): Promise<{ saved_at: string | null; factory_new_at: string | null; pushed_at: string | null }> {
    const found = { saved_at: null as string | null, factory_new_at: null as string | null, pushed_at: null as string | null };
    let stream;
    try {
      stream = createReadStream(this.core.jobs.eventsPath(job.workspace, job.ticket), { encoding: 'utf8' });
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        if (!line.includes('"mr_edited"') && !line.includes('"pushed"')) {
          continue;
        }
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const ts = typeof record.ts === 'string' ? record.ts : null;
        if (record.type === 'mr_edited') {
          if (record.action === 'factory_new') {
            found.factory_new_at = ts;
          } else {
            found.saved_at = record.action === 'saved' ? ts : null;
            found.factory_new_at = null;
          }
        } else if (typeof record.state === 'object' && record.state !== null && (record.state as { to?: unknown }).to === 'pushed') {
          found.pushed_at = ts;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    } finally {
      stream?.destroy();
    }
    return found;
  }

  // The MR text can be edited (SF-080): ready_for_human_review, or needs_human after a push that
  // failed or was refused (the prepared commit and its worktree are kept until the push).
  #mrEditable(job: Job): boolean {
    return job.state === 'ready_for_human_review' || (job.state === 'needs_human' && job.prepared_commit !== null && MR_PUSH_CODES.includes(job.error?.code ?? ''));
  }

  // Refuses (invalid_state) a Save or Reset in a state that does not take it, or while a step of the
  // hand-over is cut off.
  #checkMrEditable(job: Job, command: string): void {
    if (job.handover !== undefined && job.handover.step !== null) {
      throw cutOffError(job, job.handover.step);
    }
    if (!this.#mrEditable(job)) {
      throw new FactoryError('invalid_state', `${command} needs ready_for_human_review, or needs_human after a failed push; the job is ${job.state}.`);
    }
  }

  // Save of the Merge request screen (SF-080), as approve runs: refused at once in a state it
  // does not take, then once the runner has ended (runner_active while a request runs), checked
  // again. The text is composed as mr.md is written (messageText of mrMessage) and must pass
  // mrTextProblem as the factory's does; the branch and the base, when they change, are checked
  // (#checkRename, #checkBase); the prepared commit's message is rewritten when it differs. Every
  // check comes first: a refusal changes nothing. The first save keeps the factory's text as
  // mr-factory.md.
  saveMr(workspaceName: string, ticket: string, input: MrInput): Promise<MrSaved> {
    return this.core.locked(async () => {
      this.#checkMrEditable(await this.core.job(workspaceName, ticket), 'Save');
      await this.settled(workspaceName, ticket);
      const job = await this.core.job(workspaceName, ticket);
      this.#checkMrEditable(job, 'Save');
      const current = await this.core.jobs.readMrText(workspaceName, ticket);
      if (current === undefined) {
        throw new FactoryError('mr_text_missing', `The job ${workspaceName}/${ticket} has no MR text yet.`);
      }
      if (/[\r\n]/.test(input.title)) {
        throw new FactoryError('mr_text_invalid', 'The MR title must be one line.');
      }
      const message = mrMessage(messageText({ title: input.title, body: input.body }));
      const text = messageText(message);
      const problem = mrTextProblem(ticket, text);
      if (problem !== undefined) {
        throw new FactoryError('mr_text_invalid', `The MR text is invalid: ${problem}.`);
      }
      const saved = await this.#applyMr(job, message, input.branch ?? job.branch, input.base ?? job.base);
      if ((await this.core.jobs.readMrFactoryText(workspaceName, ticket)) === undefined) {
        await this.core.jobs.writeMrFactoryText(workspaceName, ticket, current);
      }
      await this.core.jobs.writeMrText(workspaceName, ticket, text);
      return this.#mrApplied(saved, 'saved', job);
    });
  }

  // Reset to factory text (SF-080): mr-factory.md back as mr.md (it stays), and the commit message
  // rewritten as a save does; branch and base stay. Refused when the text already is the factory's.
  resetMr(workspaceName: string, ticket: string): Promise<MrSaved> {
    return this.core.locked(async () => {
      this.#checkMrEditable(await this.core.job(workspaceName, ticket), 'Reset');
      await this.settled(workspaceName, ticket);
      const job = await this.core.job(workspaceName, ticket);
      this.#checkMrEditable(job, 'Reset');
      const factory = await this.core.jobs.readMrFactoryText(workspaceName, ticket);
      const current = await this.core.jobs.readMrText(workspaceName, ticket);
      if (factory === undefined || !editedText(factory, current)) {
        throw new FactoryError('invalid_state', "The MR text is already the factory's.");
      }
      const saved = await this.#applyMr(job, mrMessage(factory), job.branch, job.base);
      await this.core.jobs.writeMrText(workspaceName, ticket, factory);
      return this.#mrApplied(saved, 'reset', job);
    });
  }

  // The job record and the mr_edited event after a save or a reset.
  async #mrApplied(job: Job, action: 'saved' | 'reset', before: Job): Promise<MrSaved> {
    await this.core.jobs.write(job);
    await this.core.jobs.appendEvent(job.workspace, job.ticket, {
      ts: now(), iteration: job.iteration, type: 'mr_edited', action,
      ...(job.branch !== before.branch ? { branch: job.branch } : {}), ...(job.base !== before.base ? { base: job.base } : {}),
    });
    const edited = editedText(await this.core.jobs.readMrFactoryText(job.workspace, job.ticket), await this.core.jobs.readMrText(job.workspace, job.ticket));
    return { state: job.state, branch: job.branch, base: job.base, edited, prepared_commit: job.prepared_commit };
  }

  // Under the workspace's Git lock: the rename and the base change checked, the prepared commit
  // checked when its message must change (the worktree there, the branch's tip and the worktree's
  // HEAD the prepared commit); then the message rewritten and the branch renamed. A rename that
  // fails puts the prepared commit back (branch_locked): a refusal changes nothing. Returns the job
  // as it is to be written (not written here).
  async #applyMr(job: Job, message: MrContent, branch: string, base: string): Promise<Job> {
    const checkout = (await this.core.resolve(job.workspace)).workCheckout;
    return this.core.gitLocked(job.workspace, async () => {
      const renaming = branch !== job.branch;
      if (renaming) {
        await this.#checkRename(job, checkout, branch, base);
      }
      if (base !== job.base) {
        await this.#checkBase(job, checkout, branch, base);
      }
      const prepared = job.prepared_commit;
      const commit = prepared === null ? undefined : await commitMessage(checkout, prepared);
      const rewrite = prepared !== null && (commit === undefined || !sameMessage(commit, message));
      const worktree = job.worktree;
      if (rewrite) {
        if (worktree === null || !(await exists(worktree))) {
          throw new FactoryError('invalid_state', "The job's worktree is gone; the commit message cannot be changed.");
        }
        const tip = (await runGit(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${job.branch}`])).stdout.toString('utf8').trim();
        const head = (await runGit(worktree, ['symbolic-ref', '-q', 'HEAD'])).stdout.toString('utf8').trim();
        if (tip !== prepared || head !== `refs/heads/${job.branch}`) {
          throw new FactoryError('branch_changed', `The tip of ${job.branch} is ${tip === '' ? 'missing' : tip.slice(0, 12)}, not the prepared ${prepared.slice(0, 12)}${head !== `refs/heads/${job.branch}` ? ", or the job's worktree is not on it" : ''}: it was edited by hand. The commit message cannot be changed; push it as it is or restart the job.`);
        }
      }
      // Applied: the message, then the rename.
      const next: Job = { ...job, prepared_commit: rewrite ? await rewriteMessage(worktree!, message) : prepared, base };
      if (!renaming) {
        return next;
      }
      const args = ['branch', '-m', job.branch, branch];
      const renamed = await runGit(checkout, args);
      if (renamed.code !== 0) {
        if (rewrite) {
          // The branch is still the worktree's HEAD: --soft moves it back, the index and files stay.
          await runGit(worktree!, ['reset', '-q', '--soft', prepared]);
        }
        throw new FactoryError('branch_locked', `The branch cannot be renamed to ${branch}: ${gitFailure(args, renamed)}.`);
      }
      return { ...next, branch };
    });
  }

  // A rename before the first push (SF-080): the job not pushed, handed over or with a merge
  // request; a valid name that is neither protected nor the base, that exists neither in the
  // checkout nor on origin; the branch never pushed (not on origin) and checked out in no worktree
  // but the job's own, the user's checkout included. Otherwise branch_locked with the reason.
  async #checkRename(job: Job, checkout: string, branch: string, base: string): Promise<void> {
    const refuse = (why: string): FactoryError => new FactoryError('branch_locked', `The branch cannot be renamed to ${branch}: ${why}.`);
    if (job.state === 'pushed' || job.state === 'handed_over' || job.mr !== null) {
      throw refuse(`${job.branch} is fixed after the first push`);
    }
    if (!(await validBranchName(checkout, branch))) {
      throw refuse('it is not a valid branch name');
    }
    if (PROTECTED_BRANCHES.includes(branch) || branch === base) {
      throw refuse(`nothing is pushed to main, master or the base branch (${base}) directly`);
    }
    if ((await runGit(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
      throw refuse('a branch of that name exists in the checkout');
    }
    const others: string[] = [];
    for (const path of await worktreesOn(checkout, job.branch)) {
      if (!(await samePath(path, job.worktree))) {
        others.push(path);
      }
    }
    if (others.length > 0) {
      throw refuse(`${job.branch} is checked out in ${others.join(', ')}`);
    }
    const onOrigin = await branchesOnOrigin(checkout, [job.branch, branch]);
    if (onOrigin.has(job.branch)) {
      throw refuse(`${job.branch} is already on origin; it is fixed after the first push`);
    }
    if (onOrigin.has(branch)) {
      throw refuse('a branch of that name exists on origin');
    }
  }

  // A base change before the push (SF-080): the job's branch has never reached origin (a failed
  // push may have; git ls-remote), and the new base exists on origin and contains the commit the
  // change was rebased onto at Clean, so the merge request carries only the job's commit;
  // otherwise base_unrelated. The commit is not rebased.
  async #checkBase(job: Job, checkout: string, branch: string, base: string): Promise<void> {
    const unrelated = new FactoryError('base_unrelated', `The change was prepared on ${job.base}; restart the job with base ${base} instead.`);
    if (job.state === 'pushed' || job.state === 'handed_over' || job.mr !== null) {
      throw new FactoryError('base_unrelated', `The base is fixed after the push; ${job.branch} was pushed for ${job.base}.`);
    }
    if (base === branch || !(await validBranchName(checkout, base))) {
      throw new FactoryError('base_unrelated', `"${base}" cannot be the base of ${branch}.`);
    }
    if (job.target_commit === null) {
      throw unrelated;
    }
    // A push that failed may still have reached origin (the connection dropped after the remote took
    // the branch): the branch on origin means pushed, whatever the job's state says. An origin that
    // cannot be asked refuses too (branch_locked, "Could not check origin for <branch>: …").
    if ((await branchesOnOrigin(checkout, [job.branch])).has(job.branch)) {
      throw new FactoryError('base_unrelated', `The base is fixed after the push; ${job.branch} is already on origin for ${job.base}.`);
    }
    const args = ['fetch', '--no-recurse-submodules', 'origin', `refs/heads/${base}`];
    const fetched = await runGit(checkout, args, 1024 * 1024, 60_000);
    if (fetched.code !== 0) {
      throw new FactoryError('base_unrelated', /couldn't find remote ref/i.test(fetched.stderr) ? `The base ${base} does not exist on origin.` : `${gitFailure(args, fetched)}.`);
    }
    if ((await runGit(checkout, ['merge-base', '--is-ancestor', job.target_commit, 'FETCH_HEAD'])).code !== 0) {
      throw unrelated;
    }
  }

  // Before a push (SF-080): the MR text is valid and is the message of the commit the push would
  // carry (the prepared commit; in handed_over, the saved one), else mr_text_invalid naming the
  // problem. Saving a valid text or Reset clears it. Not for a handed-over branch the user pushes
  // with their own commits.
  async #checkMrText(job: Job, checkout: string, commit: string | null): Promise<void> {
    const text = await this.core.jobs.readMrText(job.workspace, job.ticket);
    if (text === undefined) {
      return;
    }
    const problem = mrTextProblem(job.ticket, text);
    if (problem !== undefined) {
      throw new FactoryError('mr_text_invalid', `The MR text is invalid: ${problem}. Save a valid text, or reset it to the factory's, on the Merge request screen.`);
    }
    const message = commit === null ? undefined : await commitMessage(checkout, commit);
    if (message !== undefined && !sameMessage(message, mrMessage(text))) {
      throw new FactoryError('mr_text_invalid', `The MR text differs from the message of the prepared commit ${commit!.slice(0, 12)}, which the push would carry: save the text or reset it on the Merge request screen.`);
    }
  }

  // sf mr merge (SF-048): merges the job's open merge request through the host's API (no push, no
  // force). The host's refusal (conflicts, failing required checks, a draft) comes back as
  // mr_not_mergeable with its reason, and nothing changes.
  mergeMergeRequest(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; mr: JobMr }> {
    return this.core.locked(async () => {
      const job = await this.core.job(workspaceName, ticket);
      if (job.state !== 'pushed' || job.mr === null) {
        throw new FactoryError('invalid_state', `sf mr merge needs a pushed job with a merge request (sf mr create opens one); the job is ${job.state}${job.state === 'pushed' ? ' without one' : ''}.`);
      }
      if (job.mr.state !== 'open') {
        throw new FactoryError('invalid_state', `The merge request #${job.mr.number} is ${job.mr.state}; only an open one is merged.`);
      }
      const forge = await this.#forge(job);
      const merged = await forge.merge(job.mr.number);
      const next: Job = { ...job, mr: { ...job.mr, state: 'merged', merge_commit: merged.merge_commit } };
      await this.core.jobs.write(next);
      await this.#mrEvent(next, 'merged');
      this.core.announce(next, [`Merge request #${job.mr.number} merged into ${job.base}`, job.mr.url]);
      return { state: next.state, branch: next.branch, mr: next.mr! };
    });
  }

  // sf mr status (SF-048): what the host says of the job's merge request now. A merge request the
  // host has merged or closed meanwhile (by hand) is recorded so; nobody is notified.
  async mergeRequestStatus(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; mr: JobMr; status: MergeRequestStatus }> {
    const job = await this.core.job(workspaceName, ticket);
    if (job.mr === null) {
      throw new FactoryError('invalid_state', `No merge request is recorded for ${workspaceName}/${ticket}; sf mr create opens one.`);
    }
    const number = job.mr.number;
    const status = await (await this.#forge(job)).status(number);
    return this.core.locked(async () => {
      const current = await this.core.job(workspaceName, ticket);
      if (current.mr === null || current.mr.number !== number || current.mr.state === status.state) {
        return { state: current.state, branch: current.branch, mr: current.mr ?? job.mr!, status };
      }
      const next: Job = { ...current, mr: { ...current.mr, state: status.state, ...(status.merge_commit !== undefined ? { merge_commit: status.merge_commit } : {}) } };
      await this.core.jobs.write(next);
      await this.#mrEvent(next, 'updated');
      return { state: next.state, branch: next.branch, mr: next.mr!, status };
    });
  }

  // Whether the merge request actions are on for a workspace: its host, or why they are off (the
  // variable missing, an origin on no supported host, the workspace gone). No request is sent.
  async mergeRequestHost(workspaceName: string): Promise<{ host: ForgeKind | null; reason: string | null }> {
    let origin: string | undefined;
    try {
      origin = await originUrl((await this.core.resolve(workspaceName)).workCheckout);
    } catch (error) {
      if (error instanceof FactoryError) {
        return { host: null, reason: error.message };
      }
      throw error;
    }
    const choice = chooseForge(origin, this.core.config.forge);
    return choice.ok ? { host: choice.kind, reason: null } : { host: choice.kind, reason: choice.reason };
  }
}
