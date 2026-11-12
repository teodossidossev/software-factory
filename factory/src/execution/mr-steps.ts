// MR preparation and the push: Clean (markClean, the commit and rebase, the conflict turn and the
// MR text turn), the Retry of a transient failure, approve (the push), the merge request on the Git
// host and the Merge request screen (the MR text, the branch and the base the user edits).
import { createReadStream } from 'node:fs';
import { type FileHandle, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve as resolvePath } from 'node:path';
import { DEFAULT_TEST_TIMEOUT_MS, envFilePath, handoffOffNotice } from '../config.js';
import { FactoryError } from '../errors.js';
import { chooseForge, type Forge, type ForgeKind, forgeFor, type MergeRequestStatus } from '../forge.js';
import { runGit } from '../git.js';
import { checkTerms, commitsToCheck, GUARD_MAX_FIXES, GUARD_MAX_MR_TURNS, guardFixContent, guardFixCount, guardMessage, type GuardHit, type GuardTerm, maskedMrTextFailure, maskedMrTextProblem, maskTerms, MAX_GUARD_MESSAGE, redactAdded, scanBranch, scanChange, scanCommits, scanMrText, worktreeTree } from '../guard.js';
import { checkBranchFree, isAncestor, savedRef, settleAfterPush, subjectOf } from '../handoff.js';
import { handoffSensitive } from '../handoff-sensitive.js';
import { claudeReviews, type FileChange, type Handover, type Job, type JobMr, type JobState, now } from '../jobs.js';
import { pushedBranch, targetBranch } from '../continues.js';
import { abortRebase, branchesOnOrigin, commitAndRebase, commitMessage, continueRebase, gitFailure, mergeRequestLink, messageText, mrMessage, mrProblems, mrTextProblem, originUrl, parseOrigin, PROTECTED_BRANCHES, pushBranch, readMrText, refuseGuardedLfs, rebaseInProgress, resolveTarget, rewriteMessage, sameMessage, unmergedPaths, validBranchName, withAccepted, withChecks, withFindings, withNits, withSimplifications, worktreesOn } from '../mr.js';
import { type LedgerEntry, notFixed } from '../ledger.js';
import { MergeChecks } from '../merge-check.js';
import { buildPatch, notificationLine, type Patch } from '../patch.js';
import { conflictPrompt, mrPrompt } from '../prompts.js';
import { COMMIT_TYPES, DENIED_TOOLS, MANUAL_CLAIM, MAX_HEADER_CHARS, MR_REQUIRED_HEADINGS } from '../rules.js';
import { configDir, type Workspace } from '../registry.js';
import { actedVerdict, type ReviewItem, uniqueNits } from '../review.js';
import { endSession, type IdleOutcome, type ImplementerSession } from '../session.js';
import { pathDenials } from '../sandbox-denials.js';
import { withoutDropped } from '../stops.js';
import { implementerQuestion } from '../question-stop.js';
import { readTask } from '../task-file.js';
import { checksLine, failureText, inlineCommand, runTestCommand, TEST_CODES, TEST_FIX_ROUNDS, testsFixContent, TESTS_FAILED, type TestsRecord, type TestsResult, TESTS_UNAVAILABLE } from '../test-command.js';
import { removeWorktree } from '../worktree.js';
import type { RunnerRequest } from '../runner.js';
import type { Suggestion } from '../simplify.js';
import type { JobStorePort, LivePort, LockPort, NoticePort, RunnerPort, SettingsPort, StopPort } from './ports.js';
import type { MrContent, MrInput, MrOutcome, MrSaved, MrView } from './dto.js';
import { cutOffError, MR_RETRY_CODES, mrFailure } from './errors.js';
import { TESTS_RUNNER, testsEvent } from './events.js';
import { markedGroups } from './prompts.js';
import { exists, type FixOptions, type Live, type RunningReview } from './shared.js';

// The Merge request screen: the needs_human codes of a push that failed or was refused,
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

// The guard's own errors: a guard-terms.txt that cannot be used, a scan that failed.
const GUARD_ERRORS: readonly string[] = ['guard_terms_invalid', 'guard_failed'];

// Whether an error is one of the guard's own, which stop the job with its code.
function isGuardError(error: unknown): error is FactoryError {
  return error instanceof FactoryError && GUARD_ERRORS.includes(error.code);
}

// Whether the MR text is the user's: mr-factory.md exists and its message is not mr.md's.
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

// What the MR text turn of a preparation is given (prepareMr).
interface MrTurn {
  targetRef: string;
  targetCommit: string;
  attempt: number;
  previousError: string | undefined;
}

// What the end of a test run needs of the preparation that started it: mr_attempts before
// it, and its MR text turn.
interface TestsContext {
  attempts: number;
  turn: MrTurn;
}

// The title of the Fix section of a failed test run: ## Fix N: Tests.
const TESTS_TITLE = 'Tests';

// A command in a stop's message: inline code, cut to 200 characters.
function commandInMessage(command: string): string {
  return inlineCommand(command.length > 200 ? `${command.slice(0, 199)}…` : command);
}

// The stop of a test run that could not happen (tests_unavailable): its reason first, on a line of
// its own (the dashboard's sentence quotes the first line).
function unavailableMessage(record: TestsRecord, iteration: number): string {
  return `${record.reason ?? 'the command could not run'}.\nThe workspace's test command ${commandInMessage(record.command)} could not run on iteration ${iteration}. Fix it on this machine and run sf retry, or accept the iteration without tests (sf accept).`;
}

// The stop at the bound of the Tests Fix rounds (tests_failed): the command and how it ended.
function failedMessage(record: TestsRecord, iteration: number): string {
  return `The workspace's tests still fail after ${TEST_FIX_ROUNDS} Tests Fix rounds: ${commandInMessage(record.command)} (${failureText(record)}) on iteration ${iteration}. Accept the iteration without passing tests (sf accept), or tell the Implementer what to do (sf say).`;
}

// What MrPart calls of the other parts, by just those methods.
export interface MrControl {
  request(workspaceName: string, ticket: string, request: Exclude<RunnerRequest, { kind: 'turn' }>): Promise<unknown>;
}

export interface MrHandover {
  checkHandedOverJob(job: Job, command: string): Handover;
  handOver(job: Job, workspace: Workspace, content: MrContent): Promise<{ ok: true; job: Job } | { ok: false; job: Job; error: { code: string; message: string } }>;
  handoverNote(job: Job, note: string): Promise<void>;
  leaveCheckout(job: Job, workspace: Workspace, pushed: boolean): Promise<Job>;
}

export interface MrReviews {
  skippedSimplifications(job: Job): Promise<{ suggestions: Suggestion[]; iteration: number } | undefined>;
  startReview(job: Job): Promise<void>;
  unaccepted(job: Job, accepted: string[]): Promise<ReviewItem[]>;
}

export interface MrStart {
  syncTask(workspace: Workspace, job: Job): Promise<Job>;
}

export interface MrStatus {
  lastFiles(job: Job): Promise<FileChange[] | undefined>;
}

export interface MrTurns {
  fix(current: Job, content: string, options?: FixOptions): Promise<{ iteration: number; check_after_minutes: number }>;
  publish(job: Job, live: Live, outcome: Extract<IdleOutcome, { ok: true }>, built: Patch, extraSections: string[]): Promise<{ job: Job; changes: FileChange[] }>;
  session(job: Job, workspace: Workspace): ImplementerSession;
}

export interface MrPeers {
  readonly control: MrControl;
  readonly handover: MrHandover;
  readonly reviews: MrReviews;
  readonly start: MrStart;
  readonly status: MrStatus;
  readonly turns: MrTurns;
}

export class MrPart {
  readonly #store: JobStorePort;
  readonly #locks: LockPort;
  readonly #sessions: LivePort;
  readonly #runner: RunnerPort;
  readonly #notice: NoticePort;
  readonly #settings: SettingsPort;
  readonly #stop: StopPort;
  // The parts it calls (src/execution.ts wires them).
  readonly #peers: MrPeers;
  readonly #mergeChecks: MergeChecks;

  constructor(store: JobStorePort, locks: LockPort, sessions: LivePort, runner: RunnerPort, notice: NoticePort, settings: SettingsPort, stop: StopPort, peers: MrPeers) {
    this.#store = store;
    this.#locks = locks;
    this.#sessions = sessions;
    this.#runner = runner;
    this.#notice = notice;
    this.#settings = settings;
    this.#stop = stop;
    this.#peers = peers;
    this.#mergeChecks = new MergeChecks({ store, locks, sessions, settings, stop });
  }

  // The end of a turn of MR preparation (mark_clean). After the MR text turn: validate the text,
  // then the factory commits and rebases in the worktree. A rebase that stops on conflicts stays
  // in progress for one conflict turn, whose end comes back here (conflictIdle). Ready: record
  // the branch tip, remove the worktree and hand the job to the user.
  async mrIdle(job: Job, live: Live, outcome: IdleOutcome): Promise<void> {
    const cwd = live.cwd;
    // The job as last written: with mr_conflict_turn once the conflict turn is under way.
    let current = job;
    const needsHuman = async (code: string, message: string): Promise<void> => {
      // from: preparing_mr (#idle calls mrIdle only then)
      await this.#store.transition(current, 'needs_human', 'mr_turn_end', { code, message });
    };
    try {
      if (await rebaseInProgress(cwd)) {
        await this.conflictIdle(job, live, outcome);
        return;
      }
      const stopped = outcome.ok ? await implementerQuestion(this.#store.jobs, job, cwd) : outcome;
      if (stopped !== undefined) {
        await needsHuman(stopped.code, stopped.message);
        return;
      }
      // The guard's terms, before anything quotes the MR text: an invalid title is masked.
      let terms: GuardTerm[];
      try {
        terms = await this.#guardTerms(live.workspace);
      } catch (error) {
        if (isGuardError(error)) {
          await needsHuman(error.code, error.message);
          return;
        }
        throw error;
      }
      const written = await readMrText(cwd, job.ticket);
      if (!written.ok) {
        await needsHuman(written.code, await maskedMrTextFailure(cwd, job.ticket, written, terms));
        return;
      }
      // The nits of the reviewed iteration go into the MR text by the factory's hand.
      // So do the ledger's findings not fixed: accepted risks, contests and nits left.
      const withNitsText = withNits(written.text, await this.#nitsAtClean(job), job.iteration);
      // And the suggestions of the simplification pass the user skipped.
      const skipped = await this.#peers.reviews.skippedSimplifications(job);
      const withSkipped = skipped === undefined ? withNitsText : withSimplifications(withNitsText, skipped.suggestions, skipped.iteration);
      const ledger = await this.#store.jobs.readLedger(job.workspace, job.ticket);
      // The run of the workspace's test command on this iteration, as ### Checks of ## Testing.
      const tests = await this.#store.jobs.readTests(job.workspace, job.ticket, job.iteration);
      const checked = (text: string): string => (tests === undefined ? text : withChecks(text, checksLine(tests, job.iteration), job.iteration));
      const composed = checked(await this.#withAccepted(withFindings(withSkipped, ledger), job, ledger));
      // The guard: the lines the factory added lose every term; the Implementer's own lines are its to reword.
      const factoryText = redactAdded(composed, written.text, terms);
      // The user's own MR text, saved on the Merge request screen, stays the MR text: the commit is made with it,
      // unless it fails the rules; then with the factory's new text, and the screen shows the problem (approve
      // refuses until it is saved valid or reset). It gets the factory's ### Checks too, cleaned by the guard.
      const saved = await this.#userMrText(job);
      const userText = saved === undefined ? undefined : redactAdded(checked(saved), saved, terms);
      const usersOwn = userText !== undefined && mrTextProblem(job.ticket, userText) === undefined;
      const mrText = { text: usersOwn ? userText : factoryText };
      // The factory's text is checked before it is committed; the user's own is checked at the push.
      if (!usersOwn) {
        const hits = scanMrText(factoryText, terms);
        if (hits.length > 0) {
          const turns = live.mr?.guardTurns ?? 0;
          if (turns < GUARD_MAX_MR_TURNS) {
            const targetRef = live.mr?.targetRef ?? job.base;
            live.mr = { ...live.mr, targetRef, guardTurns: turns + 1 };
            current = { ...job, mr_attempts: job.mr_attempts + 1 };
            await this.#store.jobs.write(current);
            live.session.send(mrPrompt({
              ticket: job.ticket, branch: job.branch, targetRef, targetCommit: job.target_commit!, attempt: current.mr_attempts,
              previousError: `The guard found text that must not be published in this repository in your MR text: ${guardMessage(hits, terms)}. Write the MR text again without it.`,
              handbook: this.#settings.handbook,
            }), DENIED_TOOLS);
            return;
          }
          await needsHuman('guard_hit', `The guard found text that must not be published in this repository in the MR text, after ${turns + 1} MR text turns: ${guardMessage(hits, terms)}. Tell the Implementer how to word it (sf say; its iteration is reviewed again), or run sf retry for new MR text turns.`.slice(0, MAX_GUARD_MESSAGE));
          return;
        }
      }
      const targetCommit = job.target_commit!;
      const prepared = await this.#locks.gitLocked(job.workspace, () => commitAndRebase(cwd, { baseCommit: job.base_commit!, targetCommit, mrText: mrText.text }));
      if (prepared.kind === 'failed') {
        await needsHuman(prepared.failure.code, prepared.failure.message);
        return;
      }
      if (userText !== undefined) {
        await this.#store.jobs.writeMrFactoryText(job.workspace, job.ticket, factoryText);
        // The user's text as committed, with its ### Checks.
        if (usersOwn && userText !== saved) {
          await this.#store.jobs.writeMrText(job.workspace, job.ticket, userText);
        }
        await this.#store.jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration: job.iteration, type: 'mr_edited', action: 'factory_new' });
      } else {
        await this.#store.jobs.writeMrText(job.workspace, job.ticket, factoryText);
        await this.#store.jobs.removeMrFactoryText(job.workspace, job.ticket);
      }
      if (prepared.kind === 'conflict') {
        // The job stays preparing_mr while the Implementer resolves the conflicts.
        const targetRef = live.mr?.targetRef ?? job.base;
        live.mr = { targetRef, conflicts: prepared.files };
        // From here a stop may leave a resolution no reviewer saw: no Retry.
        current = { ...job, mr_conflict_turn: true };
        await this.#store.jobs.write(current);
        live.session.send(conflictPrompt({ ticket: job.ticket, targetRef, targetCommit, files: prepared.files }), DENIED_TOOLS);
        return;
      }
      await this.#ready(job, live, mrText.text);
    } catch (error) {
      console.error(error);
      await needsHuman('mr_failed', `MR preparation failed inside the factory: ${(error as Error).message}`.slice(0, 1000));
    }
  }

  // The MR text the user saved: mr.md when mr-factory.md exists and differs from it;
  // undefined when the text was never edited or is the factory's again.
  async #userMrText(job: Job): Promise<string | undefined> {
    const factory = await this.#store.jobs.readMrFactoryText(job.workspace, job.ticket);
    const text = await this.#store.jobs.readMrText(job.workspace, job.ticket);
    return editedText(factory, text) ? text : undefined;
  }

  // The MR text with the user's Accept over a stop of the iteration, for a job without the
  // Claude review and at the Fix round limit: its gate override's code and what went unapplied, the
  // ledger entries the text already lists as not fixed aside (withFindings); with the Claude review
  // off, after gate_failed or gate_budget, the note that no reviewer passed the iteration. The text
  // as it is without such an override (an Accept over the gate of a job with the Claude review
  // leaves the MR text unchanged).
  async #withAccepted(text: string, job: Job, ledger: LedgerEntry[]): Promise<string> {
    const override = await this.#store.jobs.readGateOverride(job.workspace, job.ticket, job.iteration);
    if (override === undefined || (claudeReviews(job) && override.code !== 'iteration_limit')) {
      return text;
    }
    const listed = new Set(notFixed(ledger).map((entry) => entry.id));
    const unapplied = typeof override.unapplied === 'string' ? override.unapplied : override.unapplied.filter((item) => item.id === undefined || !listed.has(item.id));
    const noReviewer = !claudeReviews(job) && (override.code === 'gate_failed' || override.code === 'gate_budget');
    return withAccepted(text, { code: override.code, unapplied }, job.iteration, noReviewer);
  }

  // The nits of the job's last iteration: those of its Claude review and of its gate, deduplicated
  // by path and problem; the iteration that reaches Clean leaves them unapplied. Without the Claude
  // review the gate's alone.
  async #nitsAtClean(job: Job): Promise<ReviewItem[]> {
    const { workspace, ticket, iteration } = job;
    const records = [claudeReviews(job) ? await this.#store.jobs.readReview(workspace, ticket, iteration) : undefined, await this.#store.jobs.readGate(workspace, ticket, iteration)];
    return uniqueNits(records.flatMap((record) => (record !== undefined && 'items' in record ? [record] : [])));
  }

  // The end of the conflict turn: a failed turn, a file still holding a conflict marker or a
  // failing continue aborts the rebase (mr_conflict); a failing continue first saves the resolved
  // worktree as conflict-resolution.diff of the last published iteration. After a continue the
  // change is no longer the reviewed one: it goes back to review against the target, same worktree.
  // Also the end of a working turn (from #idle) after a stop left the rebase in progress.
  async conflictIdle(job: Job, live: Live, outcome: IdleOutcome): Promise<void> {
    const cwd = live.cwd;
    const files = live.mr?.conflicts ?? (await unmergedPaths(cwd));
    const targetRef = live.mr?.targetRef ?? job.base;
    const targetCommit = job.target_commit!;
    live.mr = { targetRef };
    if (!outcome.ok) {
      await this.#locks.gitLocked(job.workspace, () => abortRebase(cwd));
      const message = `The rebase had conflicts in ${files.join(', ')}; the conflict turn failed (${outcome.code}: ${outcome.message}). The rebase was aborted.`;
      // from: preparing_mr (mrIdle, from #idle), working (#idle)
      await this.#store.transition(job, 'needs_human', 'mr_turn_end', { code: 'mr_conflict', message: message.slice(0, 1000) });
      return;
    }
    // A continue that fails keeps the resolution next to the iteration being rebased.
    const save = (write: (handle: FileHandle) => Promise<void>): Promise<string> => this.#store.jobs.writeConflictResolution(job.workspace, job.ticket, job.iteration, write);
    const failure = await this.#locks.gitLocked(job.workspace, () => continueRebase(cwd, { files, targetCommit, save }));
    if (failure !== undefined) {
      // from: preparing_mr (mrIdle, from #idle), working (#idle)
      await this.#store.transition(job, 'needs_human', 'mr_turn_end', failure);
      return;
    }
    // The resolution goes back to review with this transition: the conflict turn's window ends,
    // so a later stop of MR preparation after a clean verdict on it may be retried.
    const rebased: Job = { ...job, base_commit: targetCommit, target_commit: targetCommit, mr_conflict_turn: false };
    const note = `## MR preparation\n\nThe rebase onto ${targetRef} (${targetCommit}) had conflicts in ${files.join(', ')}, resolved by the Implementer. The Patch is now against the target.`;
    const { job: published, changes } = await this.#peers.turns.publish(rebased, live, outcome, await buildPatch(cwd, targetCommit), [note]);
    // from: preparing_mr (mrIdle, from #idle), working (#idle)
    await this.#peers.reviews.startReview(await this.#store.transition(published, 'awaiting_review', 'mr_turn_end', undefined, [notificationLine(changes)]));
  }

  // The branch holds the one commit on top of the target. With hand-over on (the workspace's
  // handoff in workspaces.json, else SF_HANDOFF) the factory hands it over to the workspace's
  // checkout at once (handed_over); a refusal leaves it in ready_for_human_review with the reason
  // (handoff_skipped), and so do hand-over off, naming the setting, and a change to a file the
  // user's IDE or tools run (handoff_sensitive), which a person hands over. The worktree stays.
  async #ready(job: Job, live: Live, mrText: string): Promise<void> {
    const cwd = live.cwd;
    const tip = (await runGit(cwd, ['rev-parse', '--verify', `refs/heads/${job.branch}`])).stdout.toString('utf8').trim();
    const content = mrMessage(mrText);
    await endSession(this.#sessions.live, `${job.workspace}/${job.ticket}`);
    const lines = [content.title, notificationLine((await this.#peers.status.lastFiles(job)) ?? [])];
    let ready: Job = { ...job, base_commit: job.target_commit, prepared_commit: tip };
    // The registry as it is now (its handoff may have changed while the job ran); when it cannot be
    // read, the setting from the job's start (the hand-over then answers the checkout's problem).
    const own = (await this.#settings.resolve(job.workspace).catch(() => live.workspace)).handoff;
    const skip = handoffOffNotice(own, this.#settings.config.handoff, job.ticket) ?? (await handoffSensitive(cwd, job.target_commit!, tip, this.#settings.config.sensitivePaths));
    if (skip !== undefined) {
      ready = { ...ready, handoff_skipped: skip };
    } else {
      const outcome = await this.#peers.handover.handOver(ready, live.workspace, content);
      if (outcome.ok) {
        // from: preparing_mr (mrIdle; handOver writes the job in the same state)
        await this.#store.transition(outcome.job, 'handed_over', 'ready', undefined, lines);
        console.log(`${job.workspace}/${job.ticket}: branch ${job.branch} ready (${content.title}), in the checkout`);
        return;
      }
      if (outcome.error.code === 'handover_interrupted') {
        // from: preparing_mr (mrIdle; handOver writes the job in the same state)
        await this.#store.transition(outcome.job, 'needs_human', 'ready', outcome.error);
        return;
      }
      ready = { ...outcome.job, handoff_skipped: outcome.error };
    }
    // from: preparing_mr (mrIdle; handOver writes the job in the same state)
    await this.#store.transition(ready, 'ready_for_human_review', 'ready', undefined, lines);
    console.log(`${job.workspace}/${job.ticket}: branch ${job.branch} ready (${content.title})`);
  }

  // Clean (the deciding clean verdict): every undeclared sensitive path and every path outside the
  // Task's scope of the reviewed iteration must be acknowledged; then the target is resolved and
  // the MR text turn runs in the worktree. When it ends the factory commits and rebases (mrIdle),
  // and the job ends in ready_for_human_review with the branch in the checkout. Also the retry
  // after a failed preparation (needs_human with mr_attempts > 0).
  markClean(workspaceName: string, ticket: string, sensitive: string[] = []): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.#peers.control.request(workspaceName, ticket, { kind: 'clean', sensitive }) as Promise<{ state: JobState; iteration: number; branch: string }>;
  }

  // Whether MR preparation may start: awaiting_review, the retry after a failed preparation, or the
  // user's Accept (acceptGate, which checked the state); returns whether it is the retry.
  checkPrepareMr(job: Job, accepted = false): boolean {
    // A prepared commit means the preparation ended (a failed push): not a retry.
    const retry = !accepted && job.state === 'needs_human' && job.mr_attempts > 0 && job.worktree !== null && job.prepared_commit === null;
    if (!(job.state === 'awaiting_review' || retry || accepted)) {
      throw new FactoryError('invalid_state', `mark_clean needs awaiting_review (or needs_human after an MR preparation); the job is ${job.state}.`);
    }
    return retry;
  }

  // The user's Retry (sf retry, the dashboard's Retry): a job that a transient failure
  // stopped in MR preparation after the deciding clean verdict prepares the MR again, with no fix
  // turn, no review, no gate and no simplification pass. On mr_push_failed it is approve without
  // --as-is: the push again, in sf serve.
  async retryMr(workspaceName: string, ticket: string): Promise<MrOutcome | { state: JobState; iteration: number; branch: string }> {
    const job = await this.#store.job(workspaceName, ticket);
    if (job.state === 'needs_human' && job.error?.code === 'mr_push_failed') {
      return this.approve(workspaceName, ticket, false);
    }
    return this.#peers.control.request(workspaceName, ticket, { kind: 'retry' }) as Promise<{ state: JobState; iteration: number; branch: string }>;
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
  // builds them); after a gate override, the review's alone (as acceptGate passes them), whatever
  // its verdict. Without the Claude review the last gate.json's: a clean one, or any after
  // an override.
  retryMrInRunner(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.#locks.locked(async () => {
      const job = await this.#store.job(workspaceName, ticket);
      this.checkRetryMr(job);
      if (!(await exists(job.worktree!))) {
        throw new FactoryError('invalid_state', `sf retry needs the job's worktree; the job is ${job.state} (${job.error!.code}) and its worktree ${job.worktree} is missing.`);
      }
      const gate = job.iteration > 0 ? await this.#store.jobs.readGate(workspaceName, ticket, job.iteration) : undefined;
      const overridden = (await this.#store.jobs.readGateOverride(workspaceName, ticket, job.iteration)) !== undefined;
      const gateClean = gate !== undefined && 'verdict' in gate && actedVerdict(withoutDropped(gate)) === 'clean';
      let accepted: string[];
      if (claudeReviews(job)) {
        const review = job.iteration > 0 ? await this.#store.jobs.readReview(workspaceName, ticket, job.iteration) : undefined;
        if (review === undefined || !('verdict' in review) || (!overridden && actedVerdict(withoutDropped(review)) !== 'clean')) {
          throw new FactoryError('invalid_state', `sf retry needs a clean Claude review of the last iteration (${job.iteration}); tell the Implementer to go on.`);
        }
        accepted = [...new Set([...review.accepted_sensitive, ...(!overridden && gateClean ? gate.accepted_sensitive : [])])];
      } else {
        if (!overridden && !gateClean) {
          throw new FactoryError('invalid_state', `sf retry needs a clean gate verdict of the last iteration (${job.iteration}); tell the Implementer to go on.`);
        }
        accepted = gate !== undefined && 'verdict' in gate ? gate.accepted_sensitive : [];
      }
      try {
        return await this.prepareMr(job, accepted, { retry: true });
      } catch (error) {
        // A transient failure again (the fetch) stops the job again with its code, so it can be
        // retried once more; any other refusal leaves the job as it was.
        if (error instanceof FactoryError && MR_RETRY_CODES.includes(error.code)) {
          // from: needs_human (checkRetryMr)
          await this.#store.transition(job, 'needs_human', 'mr_retry', { code: error.code, message: error.message });
        }
        throw error;
      }
    });
  }

  // The work of mark_clean, also run for a clean verdict of the review. Only under the lock.
  // With onAccepted (acceptGate, which checked the state), the user's Accept is recorded by it once
  // every check has passed, before the job moves on: the gate override, or the Skip.
  // With retry (sf retry, which passes the clean path's accepted paths), the state is
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
    const unacknowledged = markedGroups(await this.#peers.reviews.unaccepted(job, sensitive));
    if (unacknowledged.length > 0) {
      const lines = unacknowledged.map((group) => `${group.label.charAt(0).toUpperCase()}${group.label.slice(1)} in the reviewed iteration: ${group.paths.join(', ')}.`);
      throw new FactoryError('sensitive_unacknowledged', `${lines.join(' ')} Each must be named in the accepted sensitive paths with the reason it is needed; otherwise it is a fix item.`);
    }
    if (job.worktree === null || !(await exists(job.worktree))) {
      throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
    }
    const key = `${workspaceName}/${ticket}`;
    const live = this.#sessions.live.get(key);
    if (live?.session.busy === true) {
      throw new FactoryError('turn_running', 'A turn of the Implementer is running; wait for it to end.');
    }
    const workspace = live?.workspace ?? (await this.#settings.resolve(workspaceName));
    const cwd = job.worktree;
    // A rebase left in progress when sf serve restarted during a conflict turn: aborted before the
    // guard reads the worktree, so it sees the change and not the target's files.
    await this.#locks.gitLocked(workspaceName, () => abortRebase(cwd));
    const guarded = await this.#guardChange(job, workspace, cwd);
    if (guarded !== undefined) {
      return guarded;
    }
    const target = await this.#locks.gitLocked(workspaceName, async () => {
      // A rebase left in progress when sf serve restarted during a conflict turn.
      await abortRebase(cwd);
      // No turn while the user's checkout holds the branch.
      await checkBranchFree(workspace.workCheckout, cwd, job.branch, ticket);
      return resolveTarget(workspace.workCheckout, targetBranch(job));
    });
    await onAccepted?.();
    const attempts = job.mr_attempts;
    const attempt = attempts + 1;
    // from: awaiting_review, or needs_human: the retry and Accept or Skip (checkPrepareMr, checkAcceptGate), the Retry (checkRetryMr)
    const next = await this.#peers.start.syncTask(workspace, await this.#store.transition({ ...job, target_commit: target.commit, mr_attempts: attempt, mr_conflict_turn: false }, 'preparing_mr', 'prepare_mr'));
    // A stop of the test step ran no MR text turn: the next turn is not told its error.
    const previousError = afterTextTurn && !TEST_CODES.includes(job.error?.code ?? '') ? job.error?.message : undefined;
    const turn: MrTurn = { targetRef: target.ref, targetCommit: target.commit, attempt, previousError };
    // The workspace's test command as the registry holds it now (when it cannot be read, as
    // in hand): its run comes first, outside the lock, unless this iteration passed or was accepted.
    const command = (await this.#settings.resolve(workspaceName).catch(() => workspace)).testCommand;
    if (command !== undefined && !(await this.#testsSettled(next))) {
      this.#startTests(next, workspace, command, { attempts, turn });
      return { state: next.state, iteration: next.iteration, branch: next.branch };
    }
    this.#mrTextTurn(next, workspace, turn);
    return { state: next.state, iteration: next.iteration, branch: next.branch };
  }

  // The MR text turn of MR preparation, in the job's session. Only under the lock.
  #mrTextTurn(job: Job, workspace: Workspace, turn: MrTurn): void {
    const prompt = mrPrompt({
      ticket: job.ticket, branch: job.branch, targetRef: turn.targetRef, targetCommit: turn.targetCommit, attempt: turn.attempt,
      previousError: turn.previousError, handbook: this.#settings.handbook,
    });
    const session = this.#peers.turns.session(job, workspace);
    this.#sessions.live.get(`${job.workspace}/${job.ticket}`)!.mr = { targetRef: turn.targetRef };
    session.send(prompt, DENIED_TOOLS);
  }

  // Whether the test step of the job's iteration is done: its record passed, or the user accepted
  // it without passing tests. A record that cannot be read counts as none: the tests run again.
  async #testsSettled(job: Job): Promise<boolean> {
    const record = await this.#store.jobs.readTests(job.workspace, job.ticket, job.iteration).catch((error: unknown) => (console.error(error), undefined));
    return record?.outcome === 'passed' || record?.outcome === 'accepted_failing';
  }

  // Starts the run of the workspace's test command on the job's worktree, registered as the
  // job's running review, so abort and stop() cancel it and the runner waits for it. It runs outside
  // the lock; its end applies under it (#tested). Only under the lock, in the runner.
  #startTests(job: Job, workspace: Workspace, command: string, context: TestsContext): void {
    this.#runner.runnerJob();
    if (this.#stop.isStopping()) {
      throw new FactoryError('runner_stopping', 'The runner of the job is stopping; no test run starts.');
    }
    const key = `${job.workspace}/${job.ticket}`;
    this.#sessions.reviews.get(key)?.controller.abort();
    const running: RunningReview = { reviewer: TESTS_RUNNER, iteration: job.iteration, controller: new AbortController() };
    this.#sessions.reviews.set(key, running);
    this.#runTests(job, workspace, command, running, context).catch((error: unknown) => console.error(error));
  }

  // The run itself: the tests_started event, the sandbox built from the job's path denials (session
  // job, as the Implementer's), the command, then its end under the lock, whatever fails.
  async #runTests(job: Job, workspace: Workspace, command: string, running: RunningReview, context: TestsContext): Promise<void> {
    const run = now();
    let result: TestsResult;
    // An abort (stop() too) queues the run's end on the lock at once, so stop() waits for it.
    let ended: (value: TestsResult) => void = () => undefined;
    const end = new Promise<TestsResult>((resolve) => (ended = resolve));
    let queued: Promise<void> | undefined;
    running.controller.signal.addEventListener('abort', () => (queued = this.#locks.locked(async () => this.#tested(job, running, run, await end, context))), { once: true });
    try {
      await this.#store.jobs.appendEvent(job.workspace, job.ticket, { ts: run, iteration: job.iteration, type: 'tests_started', run, command });
      const denials = await pathDenials({ session: 'job', workspace: job.workspace, checkout: workspace.workCheckout, worktree: job.worktree!, stateDir: this.#settings.config.stateDir, worktreeRoot: this.#settings.config.worktreeRoot });
      result = await runTestCommand({
        command, cwd: job.worktree!, hidden: denials.sandbox.denyRead, timeoutMs: this.#settings.config.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS, signal: running.controller.signal,
      });
    } catch (error) {
      // The path denials could not be built (or the event written): no run without them.
      const at = now();
      const reason = `the sandbox could not be built: ${error instanceof FactoryError ? error.message : (error as Error).message}`.slice(0, 300);
      result = { aborted: false, record: { command, started_at: run, ended_at: at, duration_ms: Date.parse(at) - Date.parse(run), exit_code: null, timed_out: false, outcome: 'unavailable', reason, output: '', output_truncated: false } };
    }
    ended(result);
    await (queued ?? this.#locks.locked(() => this.#tested(job, running, run, result, context)));
  }

  // The end of a test run. A cancelled one (abort, stop(); its result is aborted only then) leaves no
  // trace, but one that changed a watched path stops its job still in this step (tests_failed: no
  // turn starts on that worktree). Otherwise, for the job's step, the record and the tests event are
  // written; a pass goes on to the MR text turn; one that could not run stops the job
  // (tests_unavailable); a failure is a Tests Fix, or past TEST_FIX_ROUNDS a stop (tests_failed).
  async #tested(job: Job, running: RunningReview, run: string, result: TestsResult, context: TestsContext): Promise<void> {
    const { workspace: name, ticket, iteration } = job;
    const key = `${name}/${ticket}`;
    const latest = result.aborted && result.changed !== undefined ? await this.#store.jobs.read(name, ticket) : undefined;
    if (latest?.created_at === job.created_at && latest.state === 'preparing_mr' && result.aborted) {
      // from: preparing_mr (the test step)
      await this.#store.transition({ ...latest, mr_attempts: context.attempts }, 'needs_human', 'tests', { code: TESTS_FAILED, message: `an aborted test run changed ${result.changed}` });
    }
    if (this.#sessions.reviews.get(key) !== running || running.controller.signal.aborted || result.aborted) {
      return;
    }
    this.#sessions.reviews.delete(key);
    const current = await this.#store.jobs.read(name, ticket);
    if (current === undefined || current.created_at !== job.created_at || current.state !== 'preparing_mr' || current.iteration !== iteration) {
      return;
    }
    const { record } = result;
    const back: Job = { ...current, mr_attempts: context.attempts };
    try {
      await this.#store.jobs.writeTests(name, ticket, iteration, record);
      await this.#store.jobs.appendEvent(name, ticket, testsEvent(iteration, run, record));
      if (record.outcome === 'passed') {
        this.#mrTextTurn(current, this.#sessions.live.get(key)?.workspace ?? (await this.#settings.resolve(name)), context.turn);
        return;
      }
      if (record.outcome === 'unavailable') {
        // from: preparing_mr (the test step)
        await this.#store.transition(back, 'needs_human', 'tests', { code: TESTS_UNAVAILABLE, message: unavailableMessage(record, iteration) });
        return;
      }
      const failed = await this.#store.jobs.failedTests(name, ticket);
      if (failed > TEST_FIX_ROUNDS) {
        // from: preparing_mr (the test step)
        await this.#store.transition(back, 'needs_human', 'tests', { code: TESTS_FAILED, message: failedMessage(record, iteration) });
        return;
      }
      await this.#peers.turns.fix(back, testsFixContent(record), { title: TESTS_TITLE, fromTests: true });
    } catch (error) {
      console.error(error);
      const latest = await this.#store.jobs.read(name, ticket);
      if (latest?.state === 'preparing_mr') {
        // from: preparing_mr (the test step)
        await this.#store.transition({ ...latest, mr_attempts: context.attempts }, 'needs_human', 'tests', { code: 'mr_failed', message: `MR preparation failed inside the factory: ${(error as Error).message}`.slice(0, 1000) });
      }
    }
  }

  // The terms of a check of the guard: the secrets, and the names of the user's other
  // workspaces when the workspace is guarded as the registry holds it now (when it cannot be read,
  // as in hand).
  async #guardTerms(workspace: Workspace): Promise<GuardTerm[]> {
    const guarded = (await this.#settings.resolve(workspace.name).catch(() => workspace)).guard === true;
    return (await checkTerms({ workspace, guarded, configDir: configDir(), stateDir: this.#settings.config.stateDir, envFile: envFilePath() })).terms;
  }

  // The guard's check of the change at Clean: the worktree's change as the factory would
  // commit it. Hits are a Guard fix (the usual iteration and its reviews) until GUARD_MAX_FIXES were
  // written, then a stop; undefined when nothing was found. Before the Accept is recorded.
  async #guardChange(job: Job, workspace: Workspace, cwd: string): Promise<{ state: JobState; iteration: number; branch: string } | undefined> {
    const stop = async (code: string, message: string): Promise<{ state: JobState; iteration: number; branch: string }> => {
      // from: awaiting_review, needs_human (checkPrepareMr, checkRetryMr)
      const next = await this.#store.transition(job, 'needs_human', 'fix', { code, message });
      return { state: next.state, iteration: next.iteration, branch: next.branch };
    };
    let terms: GuardTerm[];
    let hits: GuardHit[];
    try {
      terms = await this.#guardTerms(workspace);
      const baseCommit = job.base_commit!;
      hits = await scanChange(cwd, baseCommit, await worktreeTree(cwd, baseCommit), terms);
    } catch (error) {
      if (isGuardError(error)) {
        return stop(error.code, error.message);
      }
      throw error;
    }
    if (hits.length === 0) {
      return undefined;
    }
    const fixes = guardFixCount(await readTask(workspace, job.ticket));
    if (fixes < GUARD_MAX_FIXES) {
      const { iteration } = await this.#peers.turns.fix(job, guardFixContent(hits, terms), { title: 'Guard', fromStop: job.state === 'needs_human' });
      return { state: 'working', iteration, branch: job.branch };
    }
    const message = `The guard found text that must not be published in this repository, after ${fixes} Guard fixes: ${guardMessage(hits, terms)}. Remove it (sf say, or by hand and sf say), or drop a false positive with a "!" line in guard-terms.txt and sf retry. See the matches with: sf guard ${job.workspace} --worktree ${job.ticket}`;
    return stop('guard_hit', message.slice(0, MAX_GUARD_MESSAGE));
  }

  // The terms of the push check: the workspace as approve resolved it, just before.
  async #pushTerms(workspace: Workspace): Promise<GuardTerm[]> {
    return (await checkTerms({ workspace, guarded: workspace.guard === true, configDir: configDir(), stateDir: this.#settings.config.stateDir, envFile: envFilePath() })).terms;
  }

  // The guard's check before a push or a merge request the factory makes: with commit, the commits the push
  // of it to origin publishes, and in a guarded workspace no LFS file (guard_failed); always the branch name
  // and the job's MR text. A hit refuses with guard_hit, naming the places only; nothing is pushed and the job is not changed.
  async #checkGuard(job: Job, workspace: Workspace, commit: string | undefined): Promise<void> {
    const checkout = workspace.workCheckout;
    const terms = await this.#pushTerms(workspace);
    const hits: GuardHit[] = [];
    if (commit !== undefined) {
      await (workspace.guard === true ? refuseGuardedLfs(checkout, job.base, commit) : undefined);
      hits.push(...(await scanCommits(checkout, await commitsToCheck(checkout, { rev: commit, remote: 'origin', history: false }), terms)));
    }
    hits.push(...scanBranch(job.branch, terms));
    const text = await this.#store.jobs.readMrText(job.workspace, job.ticket);
    if (text !== undefined) {
      hits.push(...scanMrText(text, terms));
    }
    if (hits.length === 0) {
      return;
    }
    const key = `${job.workspace}/${job.ticket}`;
    const message = commit !== undefined
      ? `The guard refused the push of ${key}: ${guardMessage(hits, terms)}. See the matches with: sf guard ${job.workspace} ${commit.slice(0, 12)} --mr ${job.ticket}`
      : `The guard refused the merge request of ${key}: ${guardMessage(hits, terms)}. See the matches with: sf guard ${job.workspace} --mr ${job.ticket}`;
    throw new FactoryError('guard_hit', message.slice(0, MAX_GUARD_MESSAGE));
  }

  // The user's approve: the branch the factory prepared at Clean is pushed. Nothing is committed
  // or rebased here; a tip that moved since is refused unless asIs.
  approve(workspaceName: string, ticket: string, asIs = false): Promise<MrOutcome> {
    return this.#locks.locked(async () => {
      // Refused at once in a state approve does not take; checked again once the runner has ended.
      this.#checkApprovable(await this.#store.job(workspaceName, ticket), 'approve');
      await this.settled(workspaceName, ticket);
      const job = await this.#store.job(workspaceName, ticket);
      this.#checkApprovable(job, 'approve');
      return this.#approve(job, await this.#settings.resolve(workspaceName), asIs);
    });
  }

  // The push writes a job no runner may write at the same time: the job's runner has ended (it
  // exits once the job waits for the user) and no request (sf say, a fix) waits for one;
  // runner_active otherwise. Only under the lock, under which every request is queued.
  async settled(workspaceName: string, ticket: string): Promise<void> {
    if (!(await this.#runner.serveRunners().settled(workspaceName, ticket))) {
      throw new FactoryError('runner_active', `The runner of ${workspaceName}/${ticket} is running a request (sf say or a fix); wait for the job to wait for you again.`);
    }
  }

  // The job's prepared branch can be pushed: ready_for_human_review, handed_over, or
  // needs_human after a push that failed (the worktree is kept until the push).
  #approvable(job: Job): boolean {
    return job.state === 'ready_for_human_review' || job.state === 'handed_over' || (job.state === 'needs_human' && job.prepared_commit !== null);
  }

  #checkApprovable(job: Job, command: string): void {
    // A cut-off step of the hand-over is repaired first.
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
    // The MR text the push and the merge request carry; a handed-over branch the user
    // pushes with their own commits carries theirs.
    if (!(job.state === 'handed_over' && plan.source === undefined)) {
      await this.#checkMrText(job, workspace, checkout, job.state === 'handed_over' ? job.handover!.saved : job.prepared_commit);
    }
    // The guard on every push the factory makes, --as-is included.
    await this.#checkGuard(job, workspace, plan.commit);
    // The commit the guard checked is what is pushed, so a branch that moved on since is not
    // published unchecked; a handed-over job's saved commit is pushed through its saved ref.
    const pushFailure = await this.#locks.gitLocked(workspaceName, () => pushBranch(checkout, pushedBranch(job), job.base, plan.source ?? plan.commit));
    if (pushFailure !== undefined) {
      if (job.state === 'handed_over') {
        // The checkout, the record, the saved ref and the config stay; Approve can be retried.
        const kept: Job = { ...job, error: pushFailure };
        await this.#store.jobs.write(kept);
        this.#notice.announce(kept, []);
        return { state: kept.state, branch: kept.branch, error: pushFailure };
      }
      // from: ready_for_human_review, needs_human (#approvable; handed_over keeps its state above)
      const next = await this.#store.transition(job, 'needs_human', 'push', pushFailure);
      return { state: next.state, branch: next.branch, error: pushFailure };
    }
    let message = plan.message;
    let after: Job = job;
    if (job.state === 'handed_over') {
      const handover = job.handover!;
      if (plan.source !== undefined) {
        const changed = await this.#locks.gitLocked(workspaceName, () => settleAfterPush(checkout, handover));
        message = `Pushed the factory's commit ${handover.saved.slice(0, 12)}.${changed !== undefined && changed > 0 ? ` Your uncommitted changes (${changed} files) were not pushed.` : ''}`;
      }
      after = await this.#peers.handover.leaveCheckout(job, workspace, true);
    } else if (job.worktree !== null) {
      // The worktree stays until the push; a failure keeps its path for the next action.
      const worktree = job.worktree;
      const failure = await this.#locks.gitLocked(workspaceName, () => removeWorktree(checkout, worktree));
      if (failure === undefined) {
        after = { ...job, worktree: null };
      } else {
        await this.#peers.handover.handoverNote(job, `The worktree could not be removed after the push: ${failure}`);
      }
    }
    const mrText = (await this.#store.jobs.readMrText(workspaceName, ticket)) ?? '';
    const { title } = mrMessage(mrText);
    const url = await originUrl(checkout);
    const link = url === undefined ? undefined : mergeRequestLink(url, job.base, pushedBranch(job));
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
    const pushed = await this.#store.transition({ ...after, prepared_commit: plan.commit, mr }, 'pushed', 'push', undefined, lines);
    if (opened !== undefined) {
      await this.#mrEvent(pushed, opened.reused ? 'reused' : 'created');
    }
    await endSession(this.#sessions.live, `${workspaceName}/${ticket}`);
    console.log(`${job.workspace}/${job.ticket}: pushed ${pushedBranch(job)}\n  ${title}${link !== undefined ? `\n  ${link}` : ''}`);
    return {
      state: pushed.state, branch: pushed.branch, ...(title !== '' ? { title } : {}), ...(link !== undefined ? { link } : {}),
      ...(opened !== undefined ? { mr: opened } : {}), ...(failure !== undefined ? { error: failure } : {}), ...(message !== undefined ? { message } : {}),
    };
  }

  // What Approve pushes of a handed-over job, from the branch's tip T in the checkout: the
  // saved commit when the user did not commit (T is B), the user's commits when they descend from
  // B, else branch_changed.
  async #handedOverPush(job: Job, checkout: string, tip: string): Promise<{ commit: string; source: string | undefined; message: string | undefined }> {
    const handover = this.#peers.handover.checkHandedOverJob(job, 'approve');
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
    const text = await this.#store.jobs.readMrText(job.workspace, job.ticket);
    if (text === undefined || text.trim() === '') {
      throw new FactoryError('mr_text_missing', `The job ${job.workspace}/${job.ticket} has no MR text to open a merge request with.`);
    }
    return mrMessage(text);
  }

  // The Forge of the job's workspace (its checkout's origin); refused when the job's merge request
  // is on another host than the origin now is.
  async #forge(job: Job, workspace?: Workspace): Promise<Forge> {
    const checkout = (workspace ?? (await this.#settings.resolve(job.workspace))).workCheckout;
    const forge = forgeFor(await originUrl(checkout), this.#settings.config.forge);
    if (job.mr !== null && job.mr.host !== forge.kind) {
      throw new FactoryError('mr_host_changed', `The merge request #${job.mr.number} is on ${job.mr.host}, but the checkout's origin is now on ${forge.kind}.`);
    }
    return forge;
  }

  async #openMr(job: Job, forge: Forge, content: MrContent): Promise<JobMr & { reused: boolean }> {
    const opened = await forge.open({ branch: pushedBranch(job), base: job.base, title: content.title, body: content.body });
    return { host: forge.kind, number: opened.number, url: opened.url, state: opened.state, reused: opened.reused };
  }

  async #mrEvent(job: Job, action: 'created' | 'reused' | 'merged' | 'updated'): Promise<void> {
    const mr = job.mr!;
    await this.#store.jobs.appendEvent(job.workspace, job.ticket, {
      ts: now(), iteration: job.iteration, type: 'merge_request', action, host: mr.host, number: mr.number, url: mr.url, mr_state: mr.state,
      ...(typeof mr.merge_commit === 'string' ? { merge_commit: mr.merge_commit } : {}),
    });
  }

  // sf mr create: opens the merge request of a pushed job on the Git host, or reuses the
  // one already open for the branch; from ready_for_human_review it is approve (the push) and then
  // the merge request, in one action. The host and its token are checked before anything is pushed.
  createMergeRequest(workspaceName: string, ticket: string): Promise<MrOutcome> {
    return this.#locks.locked(async () => {
      // A job that approve would push: its runner has ended first.
      if (this.#approvable(await this.#store.job(workspaceName, ticket))) {
        await this.settled(workspaceName, ticket);
      }
      const job = await this.#store.job(workspaceName, ticket);
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
      const workspace = await this.#settings.resolve(workspaceName);
      const forge = await this.#forge(job, workspace);
      const content = await this.mrContent(job);
      if (combined) {
        return this.#approve(job, workspace, false, { forge, content });
      }
      await this.#checkGuard(job, workspace, undefined);
      const opened = await this.#openMr(job, forge, content);
      const next: Job = { ...job, mr: { host: opened.host, number: opened.number, url: opened.url, state: opened.state } };
      await this.#store.jobs.write(next);
      await this.#mrEvent(next, opened.reused ? 'reused' : 'created');
      this.#notice.announce(next, [content.title, `Merge request #${opened.number}: ${opened.url}`]);
      return { state: next.state, branch: next.branch, title: content.title, mr: opened };
    });
  }

  // The Merge request screen: the job's MR text as mrMessage reads mr.md, the factory's
  // (mr-factory.md, or the same without one), whether and when the user edited it, the branch and
  // the base and whether each can change, every problem of the saved text, the state of the screen
  // (editable, or why not), the target (the workspace's Git host and the repository of its origin),
  // the rules the page checks with, and the message of the commit the push would carry. Undefined
  // without mr.md. No network call: the origin is checked only at Save.
  async mergeRequestView(workspaceName: string, ticket: string): Promise<MrView | undefined> {
    const job = await this.#store.job(workspaceName, ticket);
    const text = await this.#store.jobs.readMrText(workspaceName, ticket);
    if (text === undefined) {
      return undefined;
    }
    const factoryText = await this.#store.jobs.readMrFactoryText(workspaceName, ticket);
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
      checkout = (await this.#settings.resolve(workspaceName)).workCheckout;
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
      problems: await this.#shownProblems(job, message),
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

  // The problems the Merge request screen lists: found on the text as it is, and quoted
  // from it with the guard's terms masked first (a quote is cut, which would cut a secret out of
  // its match). When the masked text gives other problems, or the terms cannot be read, a problem
  // that quotes the text says only which field fails.
  async #shownProblems(job: Job, message: MrContent): Promise<MrView['problems']> {
    const problems = mrProblems(job.ticket, message, job.branch, job.base);
    if (problems.length === 0) {
      return problems;
    }
    let terms: GuardTerm[] | undefined;
    try {
      terms = await this.#pushTerms(await this.#settings.resolve(job.workspace));
    } catch (error) {
      if (!(error instanceof FactoryError)) {
        throw error;
      }
    }
    const masked = terms === undefined ? undefined : mrProblems(job.ticket, { title: maskTerms(message.title, terms), body: maskTerms(message.body, terms) }, job.branch, job.base);
    if (terms !== undefined && masked !== undefined && masked.length === problems.length && masked.every((problem, index) => problem.field === problems[index]!.field)) {
      return masked.map((problem) => ({ field: problem.field, message: maskTerms(problem.message, terms) }));
    }
    return problems.map((problem) => (problem.message.includes('"') ? { field: problem.field, message: `The ${problem.field} does not pass the rules.` } : problem));
  }

  // From the job's events: the last save that is not undone by a reset after it, the
  // last factory_new after the last save or reset, and the last change to pushed.
  async #mrEvents(job: Job): Promise<{ saved_at: string | null; factory_new_at: string | null; pushed_at: string | null }> {
    const found = { saved_at: null as string | null, factory_new_at: null as string | null, pushed_at: null as string | null };
    let stream;
    try {
      stream = createReadStream(this.#store.jobs.eventsPath(job.workspace, job.ticket), { encoding: 'utf8' });
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        if (!line.includes('"mr_edited"') && !line.includes('"pushed"')) {
          continue;
        }
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch { // not a JSON line: skipped
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

  // The MR text can be edited: ready_for_human_review, or needs_human after a push that
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

  // Save of the Merge request screen, as approve runs: refused at once in a state it
  // does not take, then once the runner has ended (runner_active while a request runs), checked
  // again. The text is composed as mr.md is written (messageText of mrMessage) and must pass
  // mrTextProblem as the factory's does; the branch and the base, when they change, are checked
  // (#checkRename, #checkBase); the prepared commit's message is rewritten when it differs. Every
  // check comes first: a refusal changes nothing. The first save keeps the factory's text as
  // mr-factory.md.
  saveMr(workspaceName: string, ticket: string, input: MrInput): Promise<MrSaved> {
    return this.#locks.locked(async () => {
      this.#checkMrEditable(await this.#store.job(workspaceName, ticket), 'Save');
      await this.settled(workspaceName, ticket);
      const job = await this.#store.job(workspaceName, ticket);
      this.#checkMrEditable(job, 'Save');
      const current = await this.#store.jobs.readMrText(workspaceName, ticket);
      if (current === undefined) {
        throw new FactoryError('mr_text_missing', `The job ${workspaceName}/${ticket} has no MR text yet.`);
      }
      if (/[\r\n]/.test(input.title)) {
        throw new FactoryError('mr_text_invalid', 'The MR title must be one line.');
      }
      const message = mrMessage(messageText({ title: input.title, body: input.body }));
      const text = messageText(message);
      if (mrTextProblem(ticket, text) !== undefined) {
        // Masked before the problem cuts its quote: validity is the original text's.
        const terms = await this.#pushTerms(await this.#settings.resolve(workspaceName));
        throw new FactoryError('mr_text_invalid', maskTerms(`The MR text is invalid: ${maskedMrTextProblem(ticket, text, terms)!}.`, terms));
      }
      const saved = await this.#applyMr(job, message, input.branch ?? job.branch, input.base ?? job.base);
      if ((await this.#store.jobs.readMrFactoryText(workspaceName, ticket)) === undefined) {
        await this.#store.jobs.writeMrFactoryText(workspaceName, ticket, current);
      }
      await this.#store.jobs.writeMrText(workspaceName, ticket, text);
      return this.#mrApplied(saved, 'saved', job);
    });
  }

  // Reset to factory text: mr-factory.md back as mr.md (it stays), and the commit message
  // rewritten as a save does; branch and base stay. Refused when the text already is the factory's.
  resetMr(workspaceName: string, ticket: string): Promise<MrSaved> {
    return this.#locks.locked(async () => {
      this.#checkMrEditable(await this.#store.job(workspaceName, ticket), 'Reset');
      await this.settled(workspaceName, ticket);
      const job = await this.#store.job(workspaceName, ticket);
      this.#checkMrEditable(job, 'Reset');
      const factory = await this.#store.jobs.readMrFactoryText(workspaceName, ticket);
      const current = await this.#store.jobs.readMrText(workspaceName, ticket);
      if (factory === undefined || !editedText(factory, current)) {
        throw new FactoryError('invalid_state', "The MR text is already the factory's.");
      }
      const saved = await this.#applyMr(job, mrMessage(factory), job.branch, job.base);
      await this.#store.jobs.writeMrText(workspaceName, ticket, factory);
      return this.#mrApplied(saved, 'reset', job);
    });
  }

  // The job record and the mr_edited event after a save or a reset.
  async #mrApplied(job: Job, action: 'saved' | 'reset', before: Job): Promise<MrSaved> {
    await this.#store.jobs.write(job);
    await this.#store.jobs.appendEvent(job.workspace, job.ticket, {
      ts: now(), iteration: job.iteration, type: 'mr_edited', action,
      ...(job.branch !== before.branch ? { branch: job.branch } : {}), ...(job.base !== before.base ? { base: job.base } : {}),
    });
    const edited = editedText(await this.#store.jobs.readMrFactoryText(job.workspace, job.ticket), await this.#store.jobs.readMrText(job.workspace, job.ticket));
    return { state: job.state, branch: job.branch, base: job.base, edited, prepared_commit: job.prepared_commit };
  }

  // Under the workspace's Git lock: the rename and the base change checked, the prepared commit
  // checked when its message must change (the worktree there, the branch's tip and the worktree's
  // HEAD the prepared commit); then the message rewritten and the branch renamed. A rename that
  // fails puts the prepared commit back (branch_locked): a refusal changes nothing. Returns the job
  // as it is to be written (not written here).
  async #applyMr(job: Job, message: MrContent, branch: string, base: string): Promise<Job> {
    const checkout = (await this.#settings.resolve(job.workspace)).workCheckout;
    return this.#locks.gitLocked(job.workspace, async () => {
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

  // A rename before the first push: the job not pushed, handed over or with a merge
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

  // A base change before the push: the job's branch has never reached origin (a failed
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

  // Before a push: the MR text is valid and is the message of the commit the push would
  // carry (the prepared commit; in handed_over, the saved one), else mr_text_invalid naming the
  // problem. Saving a valid text or Reset clears it. Not for a handed-over branch the user pushes
  // with their own commits.
  // The problem quotes the title, which the guard has not checked yet: every match of the push
  // check's terms in it is masked.
  async #checkMrText(job: Job, workspace: Workspace, checkout: string, commit: string | null): Promise<void> {
    const text = await this.#store.jobs.readMrText(job.workspace, job.ticket);
    if (text === undefined) {
      return;
    }
    if (mrTextProblem(job.ticket, text) !== undefined) {
      // Masked before the problem cuts its quote.
      const terms = await this.#pushTerms(workspace);
      const message = `The MR text is invalid: ${maskedMrTextProblem(job.ticket, text, terms)!}. Save a valid text, or reset it to the factory's, on the Merge request screen.`;
      throw new FactoryError('mr_text_invalid', maskTerms(message, terms));
    }
    const message = commit === null ? undefined : await commitMessage(checkout, commit);
    if (message !== undefined && !sameMessage(message, mrMessage(text))) {
      throw new FactoryError('mr_text_invalid', `The MR text differs from the message of the prepared commit ${commit!.slice(0, 12)}, which the push would carry: save the text or reset it on the Merge request screen.`);
    }
  }

  // sf mr merge: merges the job's open merge request through the host's API (no push, no
  // force), after the merge check of a workspace with a test command (src/merge-check.ts). The
  // host's refusal (conflicts, failing required checks, a draft) comes back as mr_not_mergeable
  // with its reason, and nothing changes.
  mergeMergeRequest(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; mr: JobMr }> {
    return this.#mergeChecks.merge(workspaceName, ticket, (job) => this.#forge(job), async (job, forge, head) => {
      const merged = await forge.merge(job.mr.number, head);
      const next: Job = { ...job, mr: { ...job.mr, state: 'merged', merge_commit: merged.merge_commit } };
      await this.#store.jobs.write(next);
      await this.#mrEvent(next, 'merged');
      this.#notice.announce(next, [`Merge request #${job.mr.number} merged into ${job.base}`, job.mr.url]);
      return { state: next.state, branch: next.branch, mr: next.mr! };
    });
  }

  // sf mr status: what the host says of the job's merge request now. A merge request the
  // host has merged or closed meanwhile (by hand) is recorded so; nobody is notified.
  async mergeRequestStatus(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; mr: JobMr; status: MergeRequestStatus }> {
    const job = await this.#store.job(workspaceName, ticket);
    if (job.mr === null) {
      throw new FactoryError('invalid_state', `No merge request is recorded for ${workspaceName}/${ticket}; sf mr create opens one.`);
    }
    const number = job.mr.number;
    const status = await (await this.#forge(job)).status(number);
    return this.#locks.locked(async () => {
      const current = await this.#store.job(workspaceName, ticket);
      if (current.mr === null || current.mr.number !== number || current.mr.state === status.state) {
        return { state: current.state, branch: current.branch, mr: current.mr ?? job.mr!, status };
      }
      const next: Job = { ...current, mr: { ...current.mr, state: status.state, ...(status.merge_commit !== undefined ? { merge_commit: status.merge_commit } : {}) } };
      await this.#store.jobs.write(next);
      await this.#mrEvent(next, 'updated');
      return { state: next.state, branch: next.branch, mr: next.mr!, status };
    });
  }

  // Whether the merge request actions are on for a workspace: its host, or why they are off (the
  // variable missing, an origin on no supported host, the workspace gone). No request is sent.
  async mergeRequestHost(workspaceName: string): Promise<{ host: ForgeKind | null; reason: string | null }> {
    let origin: string | undefined;
    try {
      origin = await originUrl((await this.#settings.resolve(workspaceName)).workCheckout);
    } catch (error) {
      if (error instanceof FactoryError) {
        return { host: null, reason: error.message };
      }
      throw error;
    }
    const choice = chooseForge(origin, this.#settings.config.forge);
    return choice.ok ? { host: choice.kind, reason: null } : { host: choice.kind, reason: choice.reason };
  }
}
