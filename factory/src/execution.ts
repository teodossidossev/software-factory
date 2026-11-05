// The job lifecycle: start, check, requestFix, markClean (the MR preparation and the branch,
// SF-019, committed and rebased by the factory, SF-037), say, retryReview (the retry of a failed
// review, SF-044), acceptGate (the user's override of a stopped gate, SF-047), approve (the push),
// the merge request on the Git host (SF-048: createMergeRequest, mergeMergeRequest,
// mergeRequestStatus), simplify (the user's choice on the offer of the simplification pass,
// SF-055), pause, resume and restart (SF-067: resumePaused, restart), abort, reset
// (and the dashboard's terminal-only Archive), status and the rule for a restart of sf serve. Owns the Implementer session of each job, which works in the
// job's own worktree, and publishes an iteration (Report, Patch and the file list) when the
// session goes idle; then the Claude review of that iteration runs (SF-038, src/review.ts), and
// after a clean one the Codex gate (SF-039, src/gate.ts); the deciding verdict takes the path of
// requestFix or markClean; a clean one first runs the simplification pass (SF-055, src/simplify.ts)
// when the job had review fixes. The user starts and approves (the dashboard, the CLI); no MCP tool
// reaches these methods since SF-040. Every state change goes through #transition, the seam for
// notifications.
// Several jobs of one workspace run at the same time, up to SF_MAX_JOBS; the Git operations on
// the shared checkout are serialized per workspace, across processes.
// Since SF-042 each job's turns, reviews and gate run in the job's runner (src/runner.ts), a
// detached `sf run` with an Execution of its own in runner mode: sf serve creates the job at start,
// queues the requests that need a turn or a review (the first turn, say, a Fix section, Clean, the
// retry of a review, the override of the gate, the Resume of a paused job) and waits for the
// runner's reply; abort, pause, restart and reset stop the runner first. approve and the merge request stay in sf serve.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { chmod, copyFile, type FileHandle, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { type Config, handoffOffNotice } from './config.js';
import { FactoryError } from './errors.js';
import { chooseForge, type Forge, type ForgeKind, forgeFor, type MergeRequestStatus } from './forge.js';
import { runGit } from './git.js';
import { GATE_REVIEWER, type GateOutcome, gatePrompt, noTokens, runGate } from './gate.js';
import { askForChanges, attachWorktree, checkBranchFree, commitMessagePath, finishAsk, handOver, isAncestor, remoteBranch, type RemoteBranch, restoreConfig, savedRef, settleAfterPush, subjectOf, takeBack, undoHandover } from './handoff.js';
import { cutEvent, type FileChange, type GateOverride, type GateRecord, type Handover, isActive, type Job, type JobMr, type JobState, JobStore, now, PAUSABLE_STATES, type PauseStep, RESTARTABLE_STATES, type ReviewRecord, type SimplifyRecord, TERMINAL_STATES } from './jobs.js';
import { answerFix, applyVerdict, isSimplification, SIMPLIFIER, type Applied, type Decision, DECISIONS, escalationMessage, headings, LEDGER_ID, type LedgerEntry, FACTORY_PROBLEMS, SCOPE_PROBLEM, SENSITIVE_PROBLEM, settle, SETTLE_CODES, unappliedEntries, unsettled, userFixItems } from './ledger.js';
import { abortRebase, commitAndRebase, continueRebase, gitBusy, mergeRequestLink, mrMessage, originUrl, pushBranch, readMrText, rebaseInProgress, resolveTarget, unmergedPaths, withFindings, withNits, withSimplifications } from './mr.js';
import { buildPatch, changedFilesSection, changedPaths, fileChanges, notificationLine, type Patch } from './patch.js';
import { removeSandboxPlaceholders } from './placeholders.js';
import { Redactor } from './redact.js';
import { conflictPrompt, factoryPrompt, iterationCost, mrPrompt } from './prompts.js';
import { DENIED_TOOLS, type Marks, marksOf } from './rules.js';
import type { Workspace } from './registry.js';
import { DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES, MIN_PAGE_BYTES, type Page, pageBuffer } from './repo-files.js';
import { actedVerdict, decide, type Verdict, fixContent, oneLine, REVIEWER, type ReviewInput, type ReviewItem, type ReviewOutcome, type ReviewOutput, reviewPrompt, runReview, type StructuredOutcome, unacceptedItems, uniqueNits } from './review.js';
import { changedBetween, type FixFiles, fixNumbers, guardSuggestions, offerMessage, runSimplify, SIMPLIFY_CODE, SIMPLIFY_TITLE, simplifyFix, type SimplifyInput, type SimplifyOutput, simplifyPrompt, type Suggestion } from './simplify.js';
import { withLock } from './pid-lock.js';
import { type Launch, type RunnerRequest, Runners, type RunnerWork } from './runner.js';
import { type IdleOutcome, ImplementerSession, type LimitAnswer, type LimitedTurn } from './session.js';
import { CONTINUE_PROMPT, limitDecision, worktreeChanged, type WorktreeState, worktreeState } from './turn-limit.js';
import { appendFix, isDraft, mayTouch, parseFrontMatter, readTask, TASK_DIR, taskDiff, taskScope, taskSha256, TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';
import { addWorktree, deleteBranch, removeWorktree } from './worktree.js';

export const MAX_REPORT_BYTES = 64 * 1024;
const MAX_SLUG = 40;
// The codes of a job the gate handed to the user, which sf accept may take on to MR preparation.
export const GATE_OVERRIDE_CODES: readonly string[] = ['gate_rounds', 'gate_budget', 'gate_failed'];
// The ledger's stops (SF-052) that sf accept takes on as well, with a clean Claude review.
export const LEDGER_ACCEPT_CODES: readonly string[] = ['review_churn', 'review_disputed'];
// The offer of the simplification pass (SF-055): sf accept is its Skip.
const ACCEPT_CODES: readonly string[] = [...GATE_OVERRIDE_CODES, ...LEDGER_ACCEPT_CODES, SIMPLIFY_CODE];

export interface CheckResult {
  state: JobState;
  iteration: number;
  branch: string;
  since: string;
  check_after_minutes: number | null;
  error?: { code: string; message: string };
  report?: string;
  patch?: Page;
  // The MR text, once MR preparation produced one.
  mr?: string;
  // The sensitive and the deleted paths of the last published iteration.
  files?: { sensitive: Array<{ path: string; declared: boolean }>; deleted: string[] };
  // The Claude review of the last published iteration, and the gate's after a clean one.
  review?: ReviewStatus & { gate?: ReviewStatus };
}

export interface ReviewStatus {
  status: 'running' | 'done' | 'failed' | 'off';
  verdict?: 'clean' | 'fix';
  summary?: string;
}

// lines: extra notification lines (the MR title and link when pushed, the file summary).
export type StateListener = (job: Job, from: JobState | null, lines?: string[]) => void;

// How approve (the push) or sf mr create ended: error is the failed push (needs_human), or, with
// the job pushed, the merge request that could not be opened.
export interface MrOutcome {
  state: JobState;
  branch: string;
  error?: { code: string; message: string };
  title?: string;
  link?: string;
  // The merge request opened (or reused) on the Git host (SF-048).
  mr?: JobMr & { reused: boolean };
  // What was pushed of a handed-over job (SF-073): the factory's commit or the user's.
  message?: string;
}

// The merge request's title and body, from the MR text.
interface MrContent {
  title: string;
  body: string;
}

// An error as an outcome's {code, message}; anything but a FactoryError is logged and kept generic.
function mrFailure(error: unknown): { code: string; message: string } {
  if (error instanceof FactoryError) {
    return { code: error.code, message: error.message };
  }
  console.error(error);
  return { code: 'internal_error', message: 'The merge request failed inside the factory.' };
}

type Success = Extract<IdleOutcome, { ok: true }>;

// The paths of the factory's fix items (src/review.ts, unacceptedItems) by kind, each with its
// label: the undeclared sensitive paths, then the paths outside the Task's scope (SF-053).
function markedGroups(items: ReviewItem[]): Array<{ label: string; paths: string[] }> {
  return [
    { label: 'undeclared sensitive path(s)', problem: SENSITIVE_PROBLEM },
    { label: "path(s) outside the Task's scope", problem: SCOPE_PROBLEM },
  ].map(({ label, problem }) => ({ label, paths: items.filter((item) => item.problem === problem).map((item) => item.path) }))
    .filter((group) => group.paths.length > 0);
}

// A review record without the items the ledger dropped (SF-052), compared as written.
function withoutDropped(record: { items: ReviewItem[]; dropped?: ReviewItem[] }): { items: ReviewItem[] } {
  const dropped = new Set((record.dropped ?? []).map((item) => JSON.stringify(item)));
  return { items: record.items.filter((item) => !dropped.has(JSON.stringify(item))) };
}

// The refusal of an action a handed-over job does not take before Take it back (SF-073).
function handedOverError(job: Job): FactoryError {
  return new FactoryError('handed_over', `${job.ticket} is in your checkout on ${job.branch}; take it back first.`);
}

// The refusal of the actions that need the branch back from the user's checkout (SF-073): a
// handed-over job, or one whose hand-over step was cut off and waits for recover().
function checkNotInCheckout(job: Job): void {
  if (job.state === 'handed_over') {
    throw handedOverError(job);
  }
  if (job.handover !== undefined && job.handover.step !== null) {
    throw cutOffError(job, job.handover.step);
  }
}

// The refusal of an action on a job whose hand-over step was cut off (SF-073): recover() repairs it.
function cutOffError(job: Job, step: string): FactoryError {
  return new FactoryError('invalid_state', `A step of the hand-over of ${job.workspace}/${job.ticket} (${step}) was cut off; sf serve repairs it when it starts again.`);
}

// Branch slug: the title lowercased, runs of other characters than a-z and 0-9 as "-", trimmed,
// at most 40 characters.
export function slugify(title: string): string {
  const trim = (value: string): string => value.replace(/^-+|-+$/g, '');
  return trim(trim(title.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, MAX_SLUG));
}

export function branchName(ticket: string, title: string): string {
  const slug = slugify(title);
  return slug === '' ? ticket : `${ticket}-${slug}`;
}

function cutUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString('utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// What a Resume did (SF-067): the job's state and iteration, the step it went on with, and
// whether the Task file had changed.
export interface Resumed {
  state: JobState;
  iteration: number;
  step: PauseStep | null;
  task_changed: boolean;
}

// A job record claimed by start or restart (SF-067), before its worktree exists.
interface Claimed {
  workspace: Workspace;
  ticket: string;
  base: string;
  branch: string;
  worktree: string;
}

// The files sf restart --keep-files keeps (SF-067): their paths relative to the worktree, saved
// under dir until the new worktree exists.
interface Kept {
  dir: string;
  paths: string[];
}

// How many kept files the first prompt names.
const MAX_KEPT_NAMED = 50;
// How long the saved refs of a pushed or aborted job stay (SF-073).
const SAVED_REF_DAYS = 7;
// How long sf restart waits for origin to say whether the old branch was pushed.
const LS_REMOTE_TIMEOUT_MS = 30_000;

// What the Implementer is told of a Task file that changed since it was last given it (SF-067:
// on Resume, or the next Fix section or sf say after a review round resumed): its diff, or, when
// none could be made, to read it again.
export function changeNote(ticket: string, diff: string | undefined): string {
  const path = `${TASK_DIR}/${ticket}.md`;
  if (diff === undefined) {
    return `The Task file ${path} changed since you were last given it (while the job was paused); the copy in your worktree is the new version. Read it again and act on what changed.`;
  }
  return [`The Task file ${path} changed since you were last given it (while the job was paused); the copy in your worktree is the new version. Act on the change:`, '', '````diff', diff, '````'].join('\n');
}

// The first prompt of a job: /implement of its Task file; after sf restart --keep-files (SF-067),
// with the files kept from the previous job.
export function firstPrompt(ticket: string, kept: string[]): string {
  const command = `/implement ${TASK_DIR}/${ticket}.md`;
  if (kept.length === 0) {
    return command;
  }
  const more = kept.length > MAX_KEPT_NAMED ? `, and ${kept.length - MAX_KEPT_NAMED} more` : '';
  return [
    command,
    '',
    `This job restarts an earlier job of ${ticket}. The files that job had changed or added were copied into this worktree before this turn, uncommitted: ${kept.slice(0, MAX_KEPT_NAMED).join(', ')}${more}. They may predate the current Task file: keep what fits it, change or remove the rest.`,
  ].join('\n');
}

// Copies one regular file (with its mode) or symbolic link from to to, creating its directory;
// anything else, or a path that is gone (a deleted file), is skipped. Returns whether it copied.
async function copyEntry(from: string, to: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(from);
  } catch {
    return false;
  }
  if (!info.isFile() && !info.isSymbolicLink()) {
    return false;
  }
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  if (info.isSymbolicLink()) {
    await rm(to, { force: true });
    await symlink(await readlink(from), to);
  } else {
    await copyFile(from, to);
    await chmod(to, info.mode & 0o777);
  }
  return true;
}

// Saves the worktree's changed and new files against baseCommit (the Patch's paths: ignored and
// credential-like files left out) under dir; returns their paths.
async function saveKept(worktree: string, baseCommit: string, dir: string): Promise<string[]> {
  const { tracked, untracked } = await changedPaths(worktree, baseCommit);
  const paths: string[] = [];
  for (const path of [...tracked, ...untracked]) {
    if (await copyEntry(join(worktree, path), join(dir, path))) {
      paths.push(path);
    }
  }
  return paths;
}

// Copies the kept files into the new worktree; one that cannot be copied is logged and skipped.
async function copyKept(kept: Kept, worktree: string): Promise<void> {
  for (const path of kept.paths) {
    try {
      await copyEntry(join(kept.dir, path), join(worktree, path));
    } catch (error) {
      console.error(error);
    }
  }
}

// What the retirement of a job did: the archived job directory, the branch left as it is, and
// whether the checkout could not be cleaned (workspace unregistered or gone).
export interface Retired {
  archived: string;
  branch: string;
  checkout?: 'unavailable';
}

// What exclusive() hands its work: new calls only until the work settles; the lock is held until
// every call made has settled.
export interface ExclusiveScope {
  // Retires the ticket's current job, which must be terminal (job_active otherwise), as reset
  // does; job_not_found without a job. A failure also fails the exclusive section.
  retireFinished(workspace: string, ticket: string): Promise<Retired>;
}

interface Live {
  workspace: Workspace;
  session: ImplementerSession;
  // The session's cwd: the job's worktree.
  cwd: string;
  // During MR preparation: the target's ref name, and the files of a stopped rebase while the
  // conflict turn runs.
  mr?: { targetRef: string; conflicts?: string[] };
}

// A review in progress, Claude's, the gate's or the simplification pass (one at a time per job):
// the iteration it reviews and what cancels it.
interface RunningReview {
  reviewer: typeof REVIEWER | typeof GATE_REVIEWER | typeof SIMPLIFIER;
  iteration: number;
  controller: AbortController;
}

// The options of a Fix section (#fix).
interface FixOptions {
  // What else the Fix counts for (the gate's gate_fixes).
  counts?: Partial<Pick<Job, 'gate_fixes'>>;
  ledger?: LedgerEntry[];
  fromStop?: boolean;
  title?: string;
  overLimit?: boolean;
}

export interface ExecutionOptions {
  // Runner mode (sf run): the one job this Execution runs. Without it the Execution is sf serve's,
  // which runs no turn and no review itself.
  runner?: { workspace: string; ticket: string };
  // How sf serve starts a runner; the default spawns `sf run`.
  launch?: Launch;
}

export class Execution implements RunnerWork {
  readonly jobs: JobStore;
  readonly #config: Config;
  readonly #resolve: (name: string) => Promise<Workspace>;
  readonly #onStateChange: StateListener;
  readonly #handbook: string;
  readonly #live = new Map<string, Live>();
  // The running review of each job, by "<workspace>/<ticket>".
  readonly #reviews = new Map<string, RunningReview>();
  #lock: Promise<unknown> = Promise.resolve();
  // The operations under #locked not settled yet.
  #pending = 0;
  // One Git lock per workspace for the operations on the shared checkout; a lock file under the
  // state directory serializes them with the other processes' (sf serve and the runners).
  readonly #gitLocks = new Map<string, Promise<unknown>>();
  // Runner mode: the job; sf serve: the runners it talks to.
  readonly #runner: { workspace: string; ticket: string } | undefined;
  readonly #runners: Runners | undefined;
  // Runner mode: stop() was called; nothing new starts.
  #stopping = false;

  // handbook: the loaded Handbook text; MR preparation sends its Git rules and MR template, the
  // review its review rules.
  constructor(config: Config, resolve: (name: string) => Promise<Workspace>, onStateChange: StateListener = () => {}, handbook = '', options: ExecutionOptions = {}) {
    this.#config = config;
    this.jobs = new JobStore(config.stateDir);
    this.#resolve = resolve;
    this.#onStateChange = onStateChange;
    this.#handbook = handbook;
    this.#runner = options.runner;
    this.#runners = options.runner === undefined ? new Runners(this.jobs, options.launch) : undefined;
  }

  // One state-changing operation at a time.
  #locked<T>(work: () => Promise<T>): Promise<T> {
    this.#pending += 1;
    const next = this.#lock.catch(() => undefined).then(work);
    this.#lock = next;
    const settled = (): void => {
      this.#pending -= 1;
    };
    next.then(settled, settled);
    return next;
  }

  // Runs work under the same lock as the job operations, for changes that must not interleave
  // with a start (the workspace registry and the ticket actions of the dashboard's start screen).
  // The scope lets the work retire a finished job inside the same lock acquisition. It closes
  // when the work settles, so a later call cannot reach a job created after it, and the lock is
  // held until every retirement started through it has settled, awaited by the work or not. A
  // retirement that fails fails the section: with the work's own error when the work failed too,
  // else with the retirement's (never a success the retirement did not have).
  exclusive<T>(work: (scope: ExclusiveScope) => Promise<T>): Promise<T> {
    return this.#locked(async () => {
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

  // The checkout's Git operations of one workspace (fetch, worktree add and remove, branch
  // delete, the commit and rebase at Clean, push) never interleave; the rest runs concurrently.
  #gitLocked<T>(workspace: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#gitLocks.get(workspace) ?? Promise.resolve();
    const path = join(this.#config.stateDir, 'locks', `git-${workspace}.lock`);
    const next = previous.catch(() => undefined).then(() => withLock(path, work));
    this.#gitLocks.set(workspace, next);
    return next;
  }

  async #transition(job: Job, to: JobState, error?: { code: string; message: string }, lines?: string[]): Promise<Job> {
    const from = job.state;
    // What a pause interrupted is kept only while the job is paused (SF-067); why the hand-over did
    // not happen only while ready_for_human_review, and the hand-over only while handed_over, unless
    // one of its steps was cut off (SF-073: recover() repairs it).
    const { error: _previous, paused, handoff_skipped: skipped, handover, ...rest } = job;
    const next: Job = {
      ...rest, state: to, updated_at: now(), ...(error !== undefined ? { error } : {}), ...(to === 'paused' && paused !== undefined ? { paused } : {}),
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

  async #job(workspace: string, ticket: string): Promise<Job> {
    if (!TICKET_PATTERN.test(ticket)) {
      throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
    }
    const job = await this.jobs.read(workspace, ticket);
    if (job === undefined) {
      throw new FactoryError('job_not_found', `There is no job for ${workspace}/${ticket}.`);
    }
    return job;
  }

  #checkAfter(job: Job): number {
    return job.iteration === 0 ? this.#config.checkAfterStartMin : this.#config.checkAfterFixMin;
  }

  #worktreePath(workspace: string, ticket: string): string {
    return join(this.#config.worktreeRoot, workspace, ticket);
  }

  // At serve start (SF-042): a job in working, preparing_mr or awaiting_review whose runner is alive
  // is left alone, and so is a paused one (SF-067). Without a runner, a working job and an MR preparation need a person, an
  // interrupted start failed, and a job awaiting review whose last iteration has no review, or a
  // clean review but no gate.json, or a clean gate.json and a simplification pass that never applied
  // (SF-055), gets a runner, which resumes it (resume: the review, the gate, the pass, or with the
  // gate off now, Clean).
  recover(): Promise<void> {
    return this.#locked(async () => {
      const runners = this.#serveRunners();
      for (const job of await this.jobs.list()) {
        // A step of the hand-over cut off (SF-073), before the job's generic handling; left alone
        // while its runner still runs it.
        if (job.handover !== undefined && job.handover.step !== null) {
          if ((await runners.owner(job.workspace, job.ticket)) === undefined) {
            await this.#repairHandover(job, job.handover).catch((error: unknown) => console.error(error));
          }
          continue;
        }
        if (['working', 'preparing_mr', 'awaiting_review'].includes(job.state) && (await runners.owner(job.workspace, job.ticket)) !== undefined) {
          continue;
        }
        if (job.state === 'awaiting_review') {
          if (await this.#resumable(job)) {
            await runners.ensure(job.workspace, job.ticket);
          }
        } else if (job.state === 'working') {
          await this.#transition(job, 'needs_human', { code: 'serve_restarted', message: 'sf serve restarted and the runner of the job had ended while the iteration ran; use sf say to continue.' });
        } else if (job.state === 'preparing_mr') {
          await this.#transition(job, 'needs_human', { code: 'mr_serve_restarted', message: 'sf serve restarted and the runner of the job had ended during MR preparation; go on with sf say (its iteration is reviewed again and a clean verdict prepares the branch again), or abort or reset the job.' });
        } else if (job.state === 'starting') {
          await this.#transition(job, 'failed', { code: 'serve_restarted', message: 'sf serve restarted while the job was starting.' });
        }
      }
      await this.#cleanSavedRefs().catch((error: unknown) => console.error(error));
    });
  }

  // A hand-over or an Ask for changes that sf serve's restart cut off (SF-073). handing_over is
  // undone when it is safe (the checkout on the branch holding exactly the job's commit, or still on
  // what it was on): the job waits in ready_for_human_review with its worktree, handoff_skipped
  // handover_interrupted; otherwise nothing in the checkout changes and the job needs the user.
  // asking is finished from the snapshot without the turn (needs_human, ask_interrupted). Only under
  // the lock.
  async #repairHandover(job: Job, handover: Handover): Promise<void> {
    const workspace = await this.#resolve(job.workspace);
    const checkout = workspace.workCheckout;
    const worktree = job.worktree ?? this.#worktreePath(job.workspace, job.ticket);
    const { ticket, branch } = job;
    if (handover.step === 'asking') {
      let message = 'sf serve restarted during Ask for changes; your edits are in the job\'s worktree; use sf say to go on.';
      try {
        const { kept } = await this.#gitLocked(job.workspace, () => finishAsk(checkout, worktree, ticket, handover));
        if (kept.length > 0) {
          await this.#handoverNote(job, `Ask for changes left these files in your checkout, changed after the snapshot: ${kept.join(', ')}.`);
        }
      } catch (error) {
        message = `sf serve restarted during Ask for changes and it could not be finished (${(error as Error).message.slice(0, 300)}); your checkout is saved as refs/factory/${ticket}-ask.`;
      }
      await this.#transition({ ...(await this.#endHandover(job)), worktree, prepared_commit: null }, 'needs_human', { code: 'ask_interrupted', message });
      return;
    }
    const undone = await this.#gitLocked(job.workspace, () => undoHandover(checkout, worktree, ticket, handover)).catch((error: unknown) => {
      console.error(error);
      return false;
    });
    if (!undone) {
      // Not the checkout's files: the factory's commit.template and commit.cleanup go anyway.
      await this.#gitLocked(job.workspace, () => restoreConfig(checkout, ticket, handover)).catch((error: unknown) => console.error(error));
    }
    const ended = await this.#endHandover(job);
    if (undone) {
      const skipped = { code: 'handover_interrupted', message: `${ticket}: sf serve restarted during the hand-over, which was undone; hand it over again when you are ready.` };
      await this.#transition({ ...ended, worktree, handoff_skipped: skipped }, 'ready_for_human_review');
      return;
    }
    await this.#transition(ended, 'needs_human', {
      code: 'handover_interrupted',
      message: `sf serve restarted during the hand-over of ${ticket} and your checkout is not as the factory left it, so nothing was changed there: the branch ${branch} may be checked out in your checkout, the job's commit is saved as refs/factory/${ticket}, and the job's worktree may be detached or gone.`,
    });
  }

  // The saved refs of the hand-over (refs/factory/<ticket>, refs/factory/<ticket>-ask, SF-073) go once
  // every job they may belong to is pushed or aborted for more than 7 days, or does not exist.
  async #cleanSavedRefs(): Promise<void> {
    const jobs = new Map((await this.jobs.list()).map((job) => [`${job.workspace}/${job.ticket}`, job]));
    const gone = (workspace: string, ticket: string): boolean => {
      const job = jobs.get(`${workspace}/${ticket}`);
      return job === undefined || (['pushed', 'aborted'].includes(job.state) && Date.now() - Date.parse(job.updated_at) > SAVED_REF_DAYS * 24 * 3600 * 1000);
    };
    for (const name of await this.jobs.workspaceNames()) {
      let workspace: Workspace;
      try {
        workspace = await this.#resolve(name);
      } catch {
        continue;
      }
      await this.#gitLocked(name, async () => {
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

  // A job awaiting review that has something to resume: its last iteration has no review (with the
  // review on), or one acted on as clean (SF-051: a fix with nits only is) and no gate.json, or a
  // clean gate.json too and a simplification pass that never applied (SF-055).
  async #resumable(job: Job): Promise<boolean> {
    if (job.state !== 'awaiting_review' || job.iteration === 0) {
      return false;
    }
    const review = await this.jobs.readReview(job.workspace, job.ticket, job.iteration);
    if (review === undefined) {
      return this.#config.review;
    }
    // Items the ledger dropped (they reopened an accepted risk, SF-052) never count, as in acceptGate.
    if (!('verdict' in review) || actedVerdict(withoutDropped(review)) !== 'clean') {
      return false;
    }
    const gate = await this.jobs.readGate(job.workspace, job.ticket, job.iteration);
    if (gate === undefined) {
      return true;
    }
    // A clean gate whose outcome never applied (the pass, its record or MR preparation; SF-055).
    return 'verdict' in gate && actedVerdict(withoutDropped(gate)) === 'clean';
  }

  // sf serve's runners; runner mode has none and never reaches the calls that need them.
  #serveRunners(): Runners {
    if (this.#runners === undefined) {
      throw new Error('Only sf serve starts and stops runners.');
    }
    return this.#runners;
  }

  // Runner mode's job; sf serve runs no turn and no review itself.
  #runnerJob(): { workspace: string; ticket: string } {
    if (this.#runner === undefined) {
      throw new Error("Turns and reviews run in the job's runner, not in sf serve.");
    }
    return this.#runner;
  }

  // Creates the job record and its worktree, then runs the first iteration. The validation and
  // the record are under the lock, the fetch and the worktree creation under the workspace's Git
  // lock only, so a long fetch holds no other job.
  async start(workspaceName: string, ticket: string): Promise<{ branch: string; state: JobState; check_after_minutes: number; worktree: string }> {
    const claimed = await this.#locked(async () => {
      if (!TICKET_PATTERN.test(ticket)) {
        throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
      }
      const workspace = await this.#resolve(workspaceName);
      const plan = await this.#plan(workspace, ticket);
      const existing = await this.jobs.read(workspace.name, ticket);
      if (existing !== undefined && !TERMINAL_STATES.includes(existing.state)) {
        throw new FactoryError('job_exists', `The job for ${workspace.name}/${ticket} is ${existing.state}.`);
      }
      await this.#checkSlot(workspace.name, ticket);
      if (existing !== undefined) {
        await this.jobs.archive(workspace.name, ticket);
      }
      return this.#claim(workspace, ticket, plan);
    });
    return this.#launch(claimed);
  }

  // The base and the branch of a job from the ticket's Task file, which must not be a draft.
  async #plan(workspace: Workspace, ticket: string): Promise<{ base: string; branch: string }> {
    const content = await readTask(workspace, ticket);
    if (isDraft(content)) {
      throw new FactoryError('task_draft', `${TASK_DIR}/${ticket}.md is still the skeleton: the Context owner writes the Task with write_task first, then the user starts the job.`);
    }
    const fields = parseFrontMatter(content)!;
    return { base: fields.get('base')!, branch: branchName(ticket, fields.get('title')!) };
  }

  // SF_MAX_JOBS: the live jobs of the workspace (a paused one is not, SF-067), the ticket's own
  // aside, leave a slot; job_limit otherwise. Only under the lock.
  async #checkSlot(workspaceName: string, ticket: string): Promise<void> {
    const live = (await this.jobs.list()).filter((job) => job.workspace === workspaceName && job.ticket !== ticket && isActive(job));
    if (live.length >= this.#config.maxJobs) {
      throw new FactoryError('job_limit', `Workspace ${workspaceName} has ${live.length} live job(s) (${live.map((job) => `${job.ticket} ${job.state}`).join(', ')}); SF_MAX_JOBS is ${this.#config.maxJobs}.`);
    }
  }

  // Writes the record of a new job in starting (the ticket's directory must be free). Only under
  // the lock.
  async #claim(workspace: Workspace, ticket: string, plan: { base: string; branch: string }): Promise<Claimed> {
    const { base, branch } = plan;
    const created = now();
    const worktree = this.#worktreePath(workspace.name, ticket);
    const job: Job = {
      workspace: workspace.name, ticket, branch, base, base_commit: null, state: 'starting', worktree, prepared_commit: null,
      iteration: 0, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null, mr: null, target_commit: null, mr_attempts: 0, created_at: created, updated_at: created,
    };
    await this.jobs.write(job);
    await this.jobs.appendEvent(workspace.name, ticket, { ts: created, iteration: 0, state: { from: null, to: 'starting' } });
    return { workspace, ticket, base, branch, worktree };
  }

  // The claimed job's worktree, then its first turn. kept (sf restart --keep-files, SF-067): the
  // files of the previous job, saved in a directory of their own, are copied into the worktree
  // before the first turn, whose prompt names them; the directory goes once they are copied, and
  // stays (named in the error) when the job could not start.
  async #launch(claimed: Claimed, kept?: Kept): Promise<{ branch: string; state: JobState; check_after_minutes: number; worktree: string }> {
    const { workspace, ticket, base, branch, worktree } = claimed;
    const keptNote = kept !== undefined && kept.paths.length > 0 ? ` The files kept from the previous job are in ${kept.dir}.` : '';
    let baseCommit: string;
    try {
      baseCommit = await this.#gitLocked(workspace.name, () => this.#createWorktree(workspace.workCheckout, base, branch, worktree));
    } catch (error) {
      const failure = error instanceof FactoryError ? error : new FactoryError('start_failed', 'Git failed while creating the worktree.');
      await this.#locked(async () => {
        const job = await this.jobs.read(workspace.name, ticket);
        if (job !== undefined && job.state === 'starting') {
          await this.#transition({ ...job, worktree: null }, 'failed', { code: failure.code, message: `${failure.message}${keptNote}` });
        }
      });
      throw new FactoryError(failure.code, `${failure.message}${keptNote}`);
    }
    const result = await this.#locked(async () => {
      let job = await this.jobs.read(workspace.name, ticket);
      if (job === undefined || job.state !== 'starting') {
        await removeWorktree(workspace.workCheckout, worktree);
        throw new FactoryError('job_ended', `The job for ${workspace.name}/${ticket} ended while it was starting.${keptNote}`);
      }
      job = { ...job, base_commit: baseCommit };
      await this.jobs.write(job);
      if (kept !== undefined) {
        await copyKept(kept, worktree);
      }
      job = await this.#transition(await this.#syncTask(workspace, job), 'working');
      // The first turn runs in the job's runner.
      await this.#serveRunners().queue(workspace.name, ticket, { kind: 'turn', prompt: factoryPrompt(firstPrompt(ticket, kept?.paths ?? []), ticket, job.iteration + 1) });
      return { branch, state: job.state, check_after_minutes: this.#config.checkAfterStartMin, worktree };
    });
    if (kept !== undefined) {
      await rm(kept.dir, { recursive: true, force: true });
    }
    return result;
  }

  // Fetches the base when origin exists, checks the names, creates the branch and its worktree
  // and returns the base commit.
  async #createWorktree(checkout: string, base: string, branch: string, path: string): Promise<string> {
    const valid = async (name: string): Promise<boolean> => !name.startsWith('-') && (await runGit(checkout, ['check-ref-format', '--branch', name])).code === 0;
    if (!(await valid(base))) {
      throw new FactoryError('base_not_found', `The base "${base}" is not a valid branch name.`);
    }
    if (!(await valid(branch))) {
      throw new FactoryError('invalid_ticket', `"${branch}" is not a valid branch name.`);
    }
    const { ref, commit } = await resolveTarget(checkout, base);
    if ((await runGit(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
      throw new FactoryError('branch_exists', `The branch ${branch} already exists in the checkout.`);
    }
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await addWorktree(checkout, path, branch, { create: true, ref });
    return commit;
  }

  // The Task file of the checkout, copied into the worktree before every Implementer turn. The
  // version copied is the one the Implementer was last given (SF-067): kept as task.md in the job
  // directory, and recorded as the job's version (#recordTask). Returns the job.
  async #syncTask(workspace: Workspace, job: Job): Promise<Job> {
    const content = await this.#copyTask(workspace, job);
    if (content === undefined) {
      return job;
    }
    if ((await this.jobs.readTaskCopy(job.workspace, job.ticket)) !== content) {
      await this.jobs.writeTaskCopy(job.workspace, job.ticket, Buffer.from(content, 'utf8'));
    }
    return this.#recordTask(job, content);
  }

  // The Task file's version the job works from (SF-067): its sha256 in job.json, written when it
  // changed. Returns the job.
  async #recordTask(job: Job, content: string): Promise<Job> {
    const sha256 = taskSha256(content);
    if (job.task_sha256 === sha256) {
      return job;
    }
    const next: Job = { ...job, task_sha256: sha256 };
    await this.jobs.write(next);
    return next;
  }

  // Copies the checkout's Task file into the worktree, for the reviewers only (a review round on
  // Resume, SF-067): what the Implementer was last given stays recorded, so its next prompt carries
  // the change. Returns the text copied; undefined without a worktree.
  async #copyTask(workspace: Workspace, job: Job): Promise<string | undefined> {
    if (job.worktree === null) {
      return undefined;
    }
    const dir = join(job.worktree, TASK_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await copyFile(join(workspace.workCheckout, TASK_DIR, `${job.ticket}.md`), join(dir, `${job.ticket}.md`));
    return readFile(join(dir, `${job.ticket}.md`), 'utf8');
  }

  // The prompt of an Implementer turn, with the change of the Task file since the Implementer was
  // last given it (SF-067: changed while paused) when there is one. change: #taskChange's.
  #withChange(prompt: string, ticket: string, change: { diff: string | undefined } | undefined): string {
    return change === undefined ? prompt : `${prompt}\n\n${changeNote(ticket, change.diff)}`;
  }

  // Removes the sandbox's placeholder files from the worktree; a failure is logged and the steps
  // that follow (Patch, MR commit) still skip them.
  async #removePlaceholders(cwd: string): Promise<string[]> {
    try {
      return await removeSandboxPlaceholders(cwd);
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  async #logPlaceholders(job: Job, iteration: number, paths: string[]): Promise<void> {
    if (paths.length > 0) {
      await this.jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration, type: 'placeholders_removed', paths });
    }
  }

  // Removes the placeholders and logs them under iteration (the turn's, as its messages are).
  async #clean(job: Job, iteration: number, cwd: string): Promise<void> {
    try {
      await this.#logPlaceholders(job, iteration, await this.#removePlaceholders(cwd));
    } catch (error) {
      console.error(error);
    }
  }

  // The job's live session, created on first use with the worktree as cwd. Runner mode only.
  #session(job: Job, workspace: Workspace): ImplementerSession {
    this.#runnerJob();
    if (this.#stopping) {
      throw new FactoryError('runner_stopping', 'The runner of the job is stopping; no turn starts.');
    }
    const key = `${job.workspace}/${job.ticket}`;
    const live = this.#live.get(key);
    if (live !== undefined) {
      return live.session;
    }
    if (job.worktree === null) {
      throw new FactoryError('worktree_missing', `The job for ${key} has no worktree; it cannot run a turn.`);
    }
    const cwd = job.worktree;
    const { workspace: name, ticket } = job;
    let iteration = job.iteration + 1;
    // The worktree at the start of the turn running, for its turn limit (SF-069).
    let start: WorktreeState | undefined;
    const session = new ImplementerSession(
      {
        cwd, maxTurns: this.#config.maxTurns, claudePath: this.#config.claudePath,
        sessionId: job.session_id ?? undefined, sandbox: this.#config.sandbox, model: this.#config.model,
        turnLimitContinues: this.#config.turnLimitContinues,
      },
      {
        prompt: async (prompt, continued) => {
          const current = await this.jobs.read(name, ticket);
          iteration = (current?.iteration ?? 0) + 1;
          await this.jobs.appendEvent(name, ticket, { ts: now(), iteration, prompt });
          start = await this.#worktreeState(cwd, current);
          // A prompt sent starts a new chain: the continuations of the last one no longer show.
          if (continued === 0 && current?.turn_limit !== undefined) {
            void this.#recordTurnLimit(name, ticket, undefined).catch(console.error);
          }
        },
        turnLimit: (turn) => this.#turnLimit(name, ticket, iteration, cwd, start, turn),
        message: async (message: SDKMessage) => {
          await this.jobs.appendEvent(name, ticket, { ts: now(), iteration, message });
          if (message.type === 'system' && message.subtype === 'init' && message.permissionMode === 'auto') {
            // Queued, not awaited: the session must never wait for the lock (abort holds it while
            // it closes the session).
            void this.#recordSession(name, ticket, message.session_id);
          }
        },
        idle: (outcome) => this.#idle(name, ticket, outcome),
      },
    );
    this.#live.set(key, { workspace, session, cwd });
    return session;
  }

  // The worktree's state for the turn limit; undefined (no change seen) when Git fails.
  async #worktreeState(cwd: string, job: Job | undefined): Promise<WorktreeState | undefined> {
    if (job?.base_commit === null || job?.base_commit === undefined) {
      return undefined;
    }
    try {
      return await worktreeState(cwd, job.base_commit);
    } catch (error) {
      console.error(error);
      return undefined;
    }
  }

  // A turn of the job ended at maxTurns (SF-069): go on with a continuation when the worktree
  // changed since start and the turn was not repeating itself, and the chain has one left (the
  // session's bound, turn.allowed); else the plain reason it stops. Never waits for the lock.
  async #turnLimit(name: string, ticket: string, iteration: number, cwd: string, start: WorktreeState | undefined, turn: LimitedTurn): Promise<LimitAnswer> {
    const end = await this.#worktreeState(cwd, await this.jobs.read(name, ticket));
    const { allowed } = turn;
    const decision = limitDecision({ maxTurns: this.#config.maxTurns, changed: worktreeChanged(start, end), calls: turn.calls, continued: turn.continued, allowed });
    if (!decision.continue) {
      return { stop: decision.message };
    }
    const continued = turn.continued + 1;
    await this.jobs.appendEvent(name, ticket, {
      ts: now(), iteration, type: 'turn_limit_continued', continued, allowed, max_turns: this.#config.maxTurns, changed_paths: end?.paths.length ?? 0, tool_calls: turn.calls.length,
    });
    void this.#recordTurnLimit(name, ticket, { continued, allowed }).catch(console.error);
    return { prompt: CONTINUE_PROMPT };
  }

  // Writes the continuations of the job's current chain (undefined: a new chain began). Queued,
  // not awaited by the session's hooks, as #recordSession.
  #recordTurnLimit(workspace: string, ticket: string, turnLimit: Job['turn_limit']): Promise<void> {
    return this.#locked(async () => {
      const job = await this.jobs.read(workspace, ticket);
      if (job === undefined || job.turn_limit?.continued === turnLimit?.continued) {
        return;
      }
      const { turn_limit: _old, ...rest } = job;
      await this.jobs.write(turnLimit === undefined ? rest : { ...rest, turn_limit: turnLimit });
    });
  }

  #recordSession(workspace: string, ticket: string, sessionId: string): Promise<void> {
    return this.#locked(async () => {
      const job = await this.jobs.read(workspace, ticket);
      if (job !== undefined && job.session_id !== sessionId) {
        await this.jobs.write({ ...job, session_id: sessionId });
      }
    });
  }

  // The session's queue is empty: publish the iteration, finish MR preparation, or hand the job
  // to a person.
  #idle(workspaceName: string, ticket: string, outcome: IdleOutcome): Promise<void> {
    return this.#locked(async () => {
      const live = this.#live.get(`${workspaceName}/${ticket}`);
      const job = await this.jobs.read(workspaceName, ticket);
      // A prompt sent after the queue drained started another turn; its idle publishes.
      if (live === undefined || job === undefined || live.session.busy) {
        return;
      }
      if (job.state !== 'working' && job.state !== 'preparing_mr') {
        return;
      }
      // Before the Patch and before the MR commit, whatever the outcome of the turn.
      await this.#clean(job, job.iteration + 1, live.cwd);
      if (job.state === 'preparing_mr') {
        await this.#mrIdle(job, live, outcome);
        return;
      }
      if (!outcome.ok) {
        await this.#transition(job, 'needs_human', { code: outcome.code, message: outcome.message });
        return;
      }
      try {
        const { job: published, changes } = await this.#publish(job, live, outcome, await buildPatch(live.cwd, job.base_commit!), []);
        // The Report's answers to the last Fix section go into the ledger (SF-052); an escalated
        // item stops the job before the review.
        const escalated = await this.#answerFix(published, live.cwd, outcome.text);
        if (escalated.length > 0) {
          await this.#transition(published, 'needs_human', { code: 'escalated', message: escalationMessage(escalated) }, [notificationLine(changes)]);
          return;
        }
        this.#startReview(await this.#transition(published, 'awaiting_review', undefined, [notificationLine(changes)]));
      } catch (error) {
        console.error(error);
        await this.#transition(job, 'needs_human', { code: 'publish_failed', message: 'The Report and Patch could not be published.' });
      }
    });
  }

  // The ledger after the Report of the job's last iteration (SF-052): the entries the Fix section it
  // answers listed take the Implementer's answers; returns the entries it escalated. Nothing before
  // the first Fix section. Only under the lock.
  async #answerFix(job: Job, cwd: string, report: string): Promise<LedgerEntry[]> {
    const ledger = await this.jobs.readLedger(job.workspace, job.ticket);
    const fix = job.iteration - 1;
    if (!ledger.some((entry) => entry.asked === fix)) {
      return [];
    }
    let task = '';
    try {
      task = await readFile(join(cwd, TASK_DIR, `${job.ticket}.md`), 'utf8');
    } catch (error) {
      console.error(error);
    }
    const root = resolvePath(cwd);
    const lines = async (path: string): Promise<number | undefined> => {
      const file = resolvePath(root, path);
      if (!file.startsWith(`${root}${sep}`)) {
        return undefined;
      }
      try {
        const text = await readFile(file, 'utf8');
        return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      } catch {
        return undefined;
      }
    };
    // A test's name counts when a test file of the worktree (tracked or new) holds it.
    const testNamed = async (name: string): Promise<boolean> =>
      (await runGit(cwd, ['grep', '--untracked', '-q', '-F', '-e', name, '--', '*test*', '*spec*'])).code === 0;
    const answered = await answerFix(ledger, report, fix, { lines, testNamed, sections: headings(task) });
    await this.jobs.writeLedger(job.workspace, job.ticket, answered.ledger);
    return answered.escalated;
  }

  // The marks rule of a job: the Task file's may_touch plus SF_SENSITIVE_PATHS for the
  // sensitivity, and its scope plus may_touch for the scope (SF-053).
  async #marks(workspace: Workspace, ticket: string): Promise<(path: string) => Marks> {
    let declared: string[] = [];
    let scope: string[] | undefined;
    try {
      const fields = parseFrontMatter(await readTask(workspace, ticket)) ?? new Map<string, string>();
      declared = mayTouch(fields);
      scope = taskScope(fields);
    } catch (error) {
      console.error(error);
    }
    return marksOf(declared, scope, this.#config.sensitivePaths);
  }

  // Writes the next iteration (Report, Patch and the file list) and returns the job with its
  // iteration counted.
  async #publish(job: Job, live: Live, outcome: Success, built: Patch, extraSections: string[]): Promise<{ job: Job; changes: FileChange[] }> {
    const { workspace: workspaceName, ticket } = job;
    const number = job.iteration + 1;
    const total = outcome.result.total_cost_usd ?? null;
    const previousTotal = number > 1 ? ((await this.jobs.readMeta(workspaceName, ticket, number - 1)).cost_usd_total ?? null) : null;
    const changes = await fileChanges(live.cwd, job.base_commit!, built.files, await this.#marks(live.workspace, ticket));
    const sections = [outcome.text.trim() || '(The Implementer wrote no report text.)', ...extraSections, changedFilesSection(built.files, built.truncated, changes)];
    if (outcome.denials.length > 0) {
      sections.push(['## Denied actions', '', ...outcome.denials.map((tool) => `- ${tool}`)].join('\n'));
    }
    await this.jobs.writeIteration(workspaceName, ticket, {
      report: `${sections.join('\n\n')}\n`,
      patch: built.patch,
      meta: {
        iteration: number,
        started_at: outcome.startedAt,
        ended_at: now(),
        denials: outcome.denials,
        changed_files: built.files,
        files: changes,
        patch_truncated: built.truncated,
        submodule_changed: built.submodules,
        cost_usd: iterationCost(total, previousTotal),
        cost_usd_total: total,
        duration_ms: outcome.result.duration_ms ?? null,
      },
    });
    return { job: { ...job, iteration: number }, changes };
  }

  // The end of a turn of MR preparation (mark_clean). After the MR text turn: validate the text,
  // then the factory commits and rebases in the worktree. A rebase that stops on conflicts stays
  // in progress for one conflict turn, whose end comes back here (#conflictIdle). Ready: record
  // the branch tip, remove the worktree and hand the job to the user.
  async #mrIdle(job: Job, live: Live, outcome: IdleOutcome): Promise<void> {
    const cwd = live.cwd;
    const needsHuman = async (code: string, message: string): Promise<void> => {
      await this.#transition(job, 'needs_human', { code, message });
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
      const skipped = await this.#skippedSimplifications(job);
      const withSkipped = skipped === undefined ? withNitsText : withSimplifications(withNitsText, skipped.suggestions, skipped.iteration);
      const mrText = { text: withFindings(withSkipped, await this.jobs.readLedger(job.workspace, job.ticket)) };
      const targetCommit = job.target_commit!;
      const prepared = await this.#gitLocked(job.workspace, () => commitAndRebase(cwd, { baseCommit: job.base_commit!, targetCommit, mrText: mrText.text }));
      if (prepared.kind === 'failed') {
        await needsHuman(prepared.failure.code, prepared.failure.message);
        return;
      }
      await this.jobs.writeMrText(job.workspace, job.ticket, mrText.text);
      if (prepared.kind === 'conflict') {
        // The job stays preparing_mr while the Implementer resolves the conflicts.
        const targetRef = live.mr?.targetRef ?? job.base;
        live.mr = { targetRef, conflicts: prepared.files };
        live.session.send(conflictPrompt({ ticket: job.ticket, targetRef, targetCommit, files: prepared.files }), DENIED_TOOLS);
        return;
      }
      await this.#ready(job, live, mrText.text);
    } catch (error) {
      console.error(error);
      await needsHuman('mr_failed', `MR preparation failed inside the factory: ${(error as Error).message}`.slice(0, 1000));
    }
  }

  // The nits of the job's last iteration (SF-051): those of its Claude review and of its gate,
  // deduplicated by path and problem; the iteration that reaches Clean leaves them unapplied.
  async #nitsAtClean(job: Job): Promise<ReviewItem[]> {
    const { workspace, ticket, iteration } = job;
    const records = [await this.jobs.readReview(workspace, ticket, iteration), await this.jobs.readGate(workspace, ticket, iteration)];
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
      await this.#gitLocked(job.workspace, () => abortRebase(cwd));
      const message = `The rebase had conflicts in ${files.join(', ')}; the conflict turn failed (${outcome.code}: ${outcome.message}). The rebase was aborted.`;
      await this.#transition(job, 'needs_human', { code: 'mr_conflict', message: message.slice(0, 1000) });
      return;
    }
    // A continue that fails keeps the resolution next to the iteration being rebased.
    const save = (write: (handle: FileHandle) => Promise<void>): Promise<string> => this.jobs.writeConflictResolution(job.workspace, job.ticket, job.iteration, write);
    const failure = await this.#gitLocked(job.workspace, () => continueRebase(cwd, { files, targetCommit, save }));
    if (failure !== undefined) {
      await this.#transition(job, 'needs_human', failure);
      return;
    }
    const rebased: Job = { ...job, base_commit: targetCommit, target_commit: targetCommit };
    const note = [
      '## MR preparation',
      '',
      `The rebase onto ${targetRef} (${targetCommit}) had conflicts in ${files.join(', ')}, resolved by the Implementer. The Patch is now against the target.`,
    ].join('\n');
    const { job: published, changes } = await this.#publish(rebased, live, outcome, await buildPatch(cwd, targetCommit), [note]);
    this.#startReview(await this.#transition(published, 'awaiting_review', undefined, [notificationLine(changes)]));
  }

  // Starts the Claude review of the job's last iteration; it runs outside the lock. A review still
  // running for the job is cancelled. Nothing with SF_REVIEW=off.
  #startReview(job: Job): void {
    this.#runnerJob();
    if (!this.#config.review || this.#stopping) {
      return;
    }
    const key = `${job.workspace}/${job.ticket}`;
    this.#reviews.get(key)?.controller.abort();
    const running: RunningReview = { reviewer: REVIEWER, iteration: job.iteration, controller: new AbortController() };
    this.#reviews.set(key, running);
    this.#review(job, running).catch((error: unknown) => console.error(error));
  }

  // The user's retry of a failed review (sf review, the dashboard's Retry review): the job goes
  // back to awaiting_review without a new iteration, the failed review.json goes, and the review
  // of the last iteration runs again.
  retryReview(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number }> {
    return this.#request(workspaceName, ticket, { kind: 'review' }) as Promise<{ state: JobState; iteration: number }>;
  }

  // sf review needs the review on and a job that a failed review handed to the user.
  #checkRetryReview(job: Job): void {
    if (!this.#config.review) {
      throw new FactoryError('review_off', 'The Claude review is off (SF_REVIEW=off); nothing would review the iteration.');
    }
    if (job.state !== 'needs_human' || job.error?.code !== 'review_failed') {
      throw new FactoryError('invalid_state', `sf review needs needs_human after a failed review (review_failed); the job is ${job.state}${job.error !== undefined ? ` (${job.error.code})` : ''}.`);
    }
  }

  // The retry in the runner.
  #retryReview(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number }> {
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      this.#checkRetryReview(job);
      if (job.worktree === null || !(await exists(job.worktree))) {
        throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
      }
      await this.jobs.removeReview(workspaceName, ticket, job.iteration);
      const next = await this.#transition(job, 'awaiting_review');
      this.#startReview(next);
      return { state: next.state, iteration: next.iteration };
    });
  }

  // The user's override of a stopped gate (sf accept, the dashboard's Accept and prepare MR): a job
  // the gate handed over (needs_human with gate_rounds, gate_budget or gate_failed) whose last
  // iteration has a clean Claude review goes on as after a clean gate, to MR preparation with the
  // paths Claude accepted. The override is recorded first: gate-override.json with the Codex
  // items not applied (or the gate's error) and a gate_overridden event.
  acceptGate(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.#request(workspaceName, ticket, { kind: 'accept' }) as Promise<{ state: JobState; iteration: number; branch: string }>;
  }

  // The code the gate (or the ledger, SF-052) stopped with; invalid_state unless it is one sf
  // accept takes on.
  #checkAcceptGate(job: Job): string {
    const code = job.error?.code;
    if (job.state !== 'needs_human' || code === undefined || !ACCEPT_CODES.includes(code)) {
      throw new FactoryError('invalid_state', `sf accept needs needs_human after the gate or the ledger stopped the job, or the simplification pass offered suggestions (${ACCEPT_CODES.join(', ')}); the job is ${job.state}${code !== undefined ? ` (${code})` : ''}.`);
    }
    return code;
  }

  // What an Accept over a ledger stop (review_churn, review_disputed) goes without: the ledger's
  // open findings with their ids, and the items of the iteration's gate that neither reopen one of
  // them nor were dropped.
  async #ledgerUnapplied(job: Job, gate: GateRecord | undefined): Promise<Array<ReviewItem & { id?: string }>> {
    const ledger = await this.jobs.readLedger(job.workspace, job.ticket);
    const open = unappliedEntries(ledger);
    const ids = new Set(open.map((entry) => entry.id));
    const accepted = new Set(ledger.filter((entry) => entry.status === 'accepted_risk').map((entry) => entry.id));
    const rest = gate !== undefined && 'verdict' in gate
      ? gate.items.filter((item) => !ids.has(item.reopens ?? '') && !accepted.has(item.reopens ?? ''))
      : [];
    return [...open, ...rest];
  }

  // The override in the runner.
  #acceptGate(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      const code = this.#checkAcceptGate(job);
      const review = job.iteration > 0 ? await this.jobs.readReview(workspaceName, ticket, job.iteration) : undefined;
      // Items the ledger dropped (they reopened an accepted risk, SF-052) never count.
      if (review === undefined || !('verdict' in review) || actedVerdict(withoutDropped(review)) !== 'clean') {
        const what = review === undefined ? 'has none' : !('verdict' in review) ? 'failed' : review.verdict === 'fix' ? 'says fix' : 'says clean with a blocker or major item';
        throw new FactoryError('invalid_state', `sf accept needs a clean Claude review of the last iteration (${job.iteration}); it ${what}.`);
      }
      const unaccepted = await this.#unaccepted(job, review.accepted_sensitive);
      if (unaccepted.length > 0) {
        throw new FactoryError('invalid_state', `sf accept needs a clean Claude review of the last iteration (${job.iteration}); it does not accept the ${markedGroups(unaccepted).map((group) => `${group.label} ${group.paths.join(', ')}`).join(' and the ')}.`);
      }
      const gate = await this.jobs.readGate(workspaceName, ticket, job.iteration);
      if (code === SIMPLIFY_CODE) {
        // Skip (SF-055): MR preparation as after the clean gate, with the paths both reviewers
        // accepted; simplify.json is marked skipped, so the suggestions go into the MR text (#mrIdle).
        // No gate override: the gate was clean.
        const record = await this.jobs.readSimplify(workspaceName, ticket, job.iteration);
        const sensitive = [...new Set([...review.accepted_sensitive, ...(gate !== undefined && 'verdict' in gate ? gate.accepted_sensitive : [])])];
        return this.#prepareMr(job, sensitive, async () => {
          const at = now();
          if (record !== undefined && 'suggestions' in record) {
            await this.jobs.writeSimplify(workspaceName, ticket, job.iteration, { ...record, skipped_at: at });
          }
          await this.jobs.appendEvent(workspaceName, ticket, {
            ts: at, iteration: job.iteration, type: 'simplify_chosen', choice: 'skip', suggestions: record !== undefined && 'suggestions' in record ? record.suggestions.length : 0,
          });
        });
      }
      const unapplied = LEDGER_ACCEPT_CODES.includes(code)
        ? await this.#ledgerUnapplied(job, gate)
        : gate === undefined ? [] : 'verdict' in gate ? gate.items : gate.error;
      const override: GateOverride = { at: now(), code, unapplied };
      return this.#prepareMr(job, review.accepted_sensitive, async () => {
        await this.jobs.writeGateOverride(workspaceName, ticket, job.iteration, override);
        await this.jobs.appendEvent(workspaceName, ticket, {
          ts: override.at, iteration: job.iteration, type: 'gate_overridden', code: override.code,
          unapplied: Array.isArray(override.unapplied) ? override.unapplied.length : 0,
        });
      });
    });
  }

  // The user's settlement of an escalated or contested ledger entry (SF-052: sf settle, the
  // dashboard's Accept risk and Must fix) while the job is needs_human: accept makes it
  // accepted_risk, fix user_fix. Once an escalated or review_disputed stop has no escalated entry
  // and no disputed contest left, the job goes on by itself: a Fix section with the fixes the user
  // decided, or else the review that was stopped runs again. After review_churn the settlement is
  // only recorded; sf say goes on.
  settle(workspaceName: string, ticket: string, id: string, decision: Decision, note = ''): Promise<{ state: JobState; id: string; status: string; waiting: string[] }> {
    return this.#request(workspaceName, ticket, { kind: 'settle', id, decision, note }) as Promise<{ state: JobState; id: string; status: string; waiting: string[] }>;
  }

  // sf settle needs needs_human, a ledger id, accept or fix, and a note of plain text; the entry
  // itself is checked against the ledger in the runner.
  #checkSettle(job: Job, id: string, decision: string, note: string): void {
    if (job.state !== 'needs_human') {
      throw new FactoryError('invalid_state', `sf settle needs needs_human; the job is ${job.state}.`);
    }
    if (!LEDGER_ID.test(id)) {
      throw new FactoryError('invalid_content', 'id must be a ledger id such as R7.');
    }
    if (!(DECISIONS as readonly string[]).includes(decision)) {
      throw new FactoryError('invalid_content', 'decision must be accept or fix.');
    }
    if (note.includes('\0') || note.length > 2000) {
      throw new FactoryError('invalid_content', 'note must be text of at most 2000 characters.');
    }
  }

  // The settlement in the runner.
  #settle(workspaceName: string, ticket: string, id: string, decision: Decision, note: string): Promise<{ state: JobState; id: string; status: string; waiting: string[] }> {
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      this.#checkSettle(job, id, decision, note);
      const ledger = settle(await this.jobs.readLedger(workspaceName, ticket), id, decision, note, now());
      if (typeof ledger === 'string') {
        throw new FactoryError('invalid_state', ledger);
      }
      await this.jobs.writeLedger(workspaceName, ticket, ledger);
      const status = ledger.find((entry) => entry.id === id)!.status;
      const waiting = unsettled(ledger).map((entry) => entry.id);
      const code = job.error?.code;
      if (waiting.length > 0 || code === undefined || !SETTLE_CODES.includes(code)) {
        return { state: job.state, id, status, waiting };
      }
      return { state: await this.#goOn(job, ledger), id, status, waiting };
    });
  }

  // The job a ledger stop held goes on (SF-052): a Fix section when the user decided a fix (with the
  // open blocker and major entries), otherwise the review that was stopped runs again: the gate
  // when it stopped the job, else the Claude review. Only under the lock.
  async #goOn(job: Job, ledger: LedgerEntry[]): Promise<JobState> {
    const { workspace: workspaceName, ticket, iteration } = job;
    const fix = userFixItems(ledger, iteration);
    if (fix.items.length > 0) {
      // The lead line names the user's decisions only; open entries carried along keep their ids.
      const decided = fix.items.filter((item) => item.userNote !== undefined).map((item) => item.id).join(', ');
      try {
        await this.#fix(job, fixContent(`The user settled the stop (${job.error?.code}): ${decided} to fix.`, fix.items, 'the user'), { ledger: fix.ledger, fromStop: true });
      } catch (error) {
        if (error instanceof FactoryError && error.code === 'iteration_limit') {
          return 'needs_human';
        }
        throw error;
      }
      return 'working';
    }
    if (job.worktree === null || !(await exists(job.worktree))) {
      throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
    }
    const review = await this.jobs.readReview(workspaceName, ticket, iteration);
    const gate = job.error?.code === 'escalated' ? undefined : await this.jobs.readGate(workspaceName, ticket, iteration);
    await this.jobs.removeGate(workspaceName, ticket, iteration);
    if (gate !== undefined && 'verdict' in gate && review !== undefined && 'verdict' in review) {
      await this.#startGate(await this.#transition(job, 'awaiting_review'), review);
    } else {
      await this.jobs.removeReview(workspaceName, ticket, iteration);
      this.#startReview(await this.#transition(job, 'awaiting_review'));
    }
    return (await this.#job(workspaceName, ticket)).state;
  }

  #cancelReview(key: string): void {
    this.#reviews.get(key)?.controller.abort();
    this.#reviews.delete(key);
  }

  // The material of a review of the job's last iteration, the Task file read in the worktree.
  async #reviewInput(job: Job, worktree: string): Promise<ReviewInput> {
    const { workspace: name, ticket, iteration } = job;
    const { report, patch } = await this.jobs.readIteration(name, ticket, iteration);
    const meta = await this.jobs.readMeta(name, ticket, iteration);
    return {
      ticket, iteration, report, patch, patchTruncated: meta.patch_truncated, files: meta.files, handbook: this.#handbook,
      task: await readFile(join(worktree, TASK_DIR, `${ticket}.md`), 'utf8'), ledger: await this.jobs.readLedger(name, ticket),
    };
  }

  // Appends one message of a running review (review_message) or one Codex event of a running gate
  // (gate_event), already redacted (src/redact.ts), to the job's events.jsonl, cut to its bound
  // (SF-045).
  // reviewer: whose session a review_message is (the simplification pass's too, SF-055).
  #appendLive(job: Job, type: 'review_message' | 'gate_event', raw: unknown, reviewer: string = REVIEWER): Promise<void> {
    const { value, truncated } = cutEvent(raw);
    const cut = truncated ? { truncated: true as const } : {};
    return this.jobs.appendEvent(job.workspace, job.ticket, type === 'review_message'
      ? { ts: now(), iteration: job.iteration, type, reviewer, message: value, ...cut }
      : { ts: now(), iteration: job.iteration, type, reviewer: GATE_REVIEWER, event: value, ...cut });
  }

  // Runs the review session, then applies its outcome under the lock.
  async #review(job: Job, running: RunningReview): Promise<void> {
    let outcome: ReviewOutcome;
    const redactor = new Redactor({ cwd: job.worktree ?? '' });
    try {
      if (job.worktree === null) {
        throw new Error('the job has no worktree');
      }
      const prompt = reviewPrompt(await this.#reviewInput(job, job.worktree));
      outcome = await runReview(prompt, {
        cwd: job.worktree, claudePath: this.#config.claudePath, sandbox: this.#config.sandbox, model: this.#config.reviewModel,
        maxTurns: this.#config.reviewMaxTurns, signal: running.controller.signal,
        // The session live in events.jsonl (SF-045).
        onMessage: (message) => this.#appendLive(job, 'review_message', redactor.reviewMessage(message)),
      });
    } catch (error) {
      const at = now();
      outcome = { ok: false, message: `The review could not start: ${(error as Error).message}`.slice(0, 1000), startedAt: at, endedAt: at };
    }
    // The failure message goes to review.json, the event and the job's error: withheld or redacted
    // like the session's prose (src/redact.ts, failure).
    if (!outcome.ok) {
      outcome = { ...outcome, message: redactor.failure(outcome.message) };
    }
    const ended = outcome;
    await this.#locked(() => this.#reviewed(job, running, ended));
  }

  // The end of a review. A cancelled one leaves no trace. Otherwise review.json and the event are
  // written; the verdict applies only while the job still awaits review of the same iteration.
  async #reviewed(reviewed: Job, running: RunningReview, outcome: ReviewOutcome): Promise<void> {
    const { workspace: name, ticket, iteration } = reviewed;
    const key = `${name}/${ticket}`;
    if (this.#reviews.get(key) !== running || running.controller.signal.aborted) {
      return;
    }
    this.#reviews.delete(key);
    const job = await this.jobs.read(name, ticket);
    // Another job of the ticket (after a reset) is not this review's.
    if (job === undefined || job.created_at !== reviewed.created_at) {
      return;
    }
    const current = job.state === 'awaiting_review' && job.iteration === iteration;
    const ignored = current ? {} : { ignored: true as const };
    const record: ReviewRecord = outcome.ok
      ? { reviewer: REVIEWER, ...outcome.output, cost_usd: outcome.costUsd, started_at: outcome.startedAt, ended_at: outcome.endedAt }
      : { reviewer: REVIEWER, error: outcome.message };
    await this.jobs.writeReview(name, ticket, iteration, record);
    await this.jobs.appendEvent(name, ticket, outcome.ok
      ? { ts: now(), iteration, type: 'review', reviewer: REVIEWER, ...(await this.#verdictOf(job, outcome.output)), items: outcome.output.items.length, ...ignored }
      : { ts: now(), iteration, type: 'review_failed', reviewer: REVIEWER, error: outcome.message, ...ignored });
    if (!current) {
      return;
    }
    if (!outcome.ok) {
      await this.#transition(job, 'needs_human', { code: 'review_failed', message: outcome.message });
      return;
    }
    await this.#applying(job, () => this.#afterClaude(job, outcome.output));
  }

  // The undeclared sensitive paths and the paths outside the Task's scope (SF-053) of the job's
  // last iteration not in accepted, nor accepted by the user as a risk (SF-052), as fix items.
  async #unaccepted(job: Job, accepted: string[]): Promise<ReviewItem[]> {
    const byUser = await this.#markedAcceptedByUser(job);
    return unacceptedItems((await this.#lastFiles(job)) ?? [], [...accepted, ...byUser]);
  }

  // The marked paths (undeclared sensitive, outside the Task's scope) whose ledger entry the user
  // settled as an accepted risk.
  async #markedAcceptedByUser(job: Job): Promise<string[]> {
    return (await this.jobs.readLedger(job.workspace, job.ticket))
      .filter((entry) => entry.status === 'accepted_risk' && FACTORY_PROBLEMS.includes(entry.problem))
      .map((entry) => entry.path);
  }

  // The reviewer's verdict for the event, with the one the factory acts on (decide) when it differs.
  async #verdictOf(job: Job, output: ReviewOutput): Promise<{ verdict: Verdict; effective?: Verdict }> {
    const effective = decide(output, await this.#unaccepted(job, output.accepted_sensitive)).verdict;
    return effective === output.verdict ? { verdict: output.verdict } : { verdict: output.verdict, effective };
  }

  // The Claude verdict as the factory acts on it (decide, SF-051): fix (a blocker or major item, or
  // an undeclared sensitive path or a path outside the Task's scope it does not accept) is the
  // next Fix section; clean (a fix with nits only too) starts the gate, or with the gate off runs
  // Clean. Only under the lock.
  // The ledger applies first (SF-052, #applyLedger): a dropped item never counts, a dispute or
  // churn hands the job to the user.
  async #afterClaude(job: Job, output: ReviewOutput): Promise<void> {
    const { summary, accepted_sensitive: accepted } = output;
    const applied = await this.#applyLedger(job, REVIEWER, output);
    if (applied.kind === 'stop') {
      await this.#transition(job, 'needs_human', { code: applied.code, message: applied.message });
    } else if (applied.kind === 'fix') {
      await this.#fix(job, fixContent(summary, applied.items), { ledger: applied.ledger });
    } else if (this.#config.gate.on) {
      await this.#startGate(job, output);
    } else {
      await this.#afterClean(job, accepted);
    }
  }

  // The ledger applied to a reviewer's verdict on the job's last iteration (SF-052, applyVerdict):
  // the items that reopen an accepted risk are recorded as dropped in review.json or gate.json,
  // and the ledger is written unless the verdict is a fix (#fix writes it with its Fix section).
  // Only under the lock.
  async #applyLedger(job: Job, reviewer: typeof REVIEWER | typeof GATE_REVIEWER, output: ReviewOutput): Promise<Applied> {
    const { workspace, ticket, iteration } = job;
    const applied = applyVerdict({
      ledger: await this.jobs.readLedger(workspace, ticket), items: output.items, extra: await this.#unaccepted(job, output.accepted_sensitive), reviewer, iteration,
    });
    if (applied.dropped.length > 0) {
      const record = reviewer === REVIEWER ? await this.jobs.readReview(workspace, ticket, iteration) : await this.jobs.readGate(workspace, ticket, iteration);
      if (record !== undefined && 'verdict' in record) {
        const marked = { ...record, dropped: applied.dropped };
        await (reviewer === REVIEWER ? this.jobs.writeReview(workspace, ticket, iteration, marked as ReviewRecord) : this.jobs.writeGate(workspace, ticket, iteration, marked as GateRecord));
      }
    }
    if (applied.kind !== 'fix') {
      await this.jobs.writeLedger(workspace, ticket, applied.ledger);
    }
    return applied;
  }

  // Applies a verdict (work) to a job awaiting review; a failure to apply it hands the job to the
  // user. Only under the lock.
  async #applying(job: Job, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      // iteration_limit has already handed the job to the user.
      if (error instanceof FactoryError && error.code === 'iteration_limit') {
        return;
      }
      console.error(error);
      const latest = await this.jobs.read(job.workspace, job.ticket);
      if (latest?.state === 'awaiting_review') {
        const code = error instanceof FactoryError ? error.code : 'review_failed';
        await this.#transition(latest, 'needs_human', { code, message: `The review's verdict could not be applied: ${(error as Error).message}`.slice(0, 1000) });
      }
    }
  }

  // Starts the gate after a clean Claude verdict (claude); it runs outside the lock. A job whose gate
  // runs used up SF_GATE_MAX_TOKENS goes to the user instead. Only under the lock.
  async #startGate(job: Job, claude: ReviewOutput): Promise<void> {
    if (job.gate_tokens >= this.#config.gateMaxTokens) {
      await this.#transition(job, 'needs_human', {
        code: 'gate_budget',
        message: `The gate runs of this job used ${job.gate_tokens} tokens, the limit of SF_GATE_MAX_TOKENS (${this.#config.gateMaxTokens}); the user decides how to go on.`,
      });
      return;
    }
    this.#runnerJob();
    if (this.#stopping) {
      return;
    }
    const key = `${job.workspace}/${job.ticket}`;
    this.#reviews.get(key)?.controller.abort();
    const running: RunningReview = { reviewer: GATE_REVIEWER, iteration: job.iteration, controller: new AbortController() };
    this.#reviews.set(key, running);
    this.#gate(job, running, claude).catch((error: unknown) => console.error(error));
  }

  // Runs the gate, then applies its outcome under the lock.
  async #gate(job: Job, running: RunningReview, claude: ReviewOutput): Promise<void> {
    const { workspace: name, ticket, iteration } = job;
    const gate = this.#config.gate;
    let outcome: GateOutcome;
    const redactor = new Redactor({ cwd: job.worktree ?? '' });
    try {
      if (job.worktree === null || job.base_commit === null || !gate.on) {
        throw new Error('the job has no worktree or base commit');
      }
      const prompt = gatePrompt({ ...(await this.#reviewInput(job, job.worktree)), baseCommit: job.base_commit });
      outcome = await runGate(prompt, {
        codexPath: gate.codexPath, cwd: job.worktree, dir: this.jobs.iterationDir(name, ticket, iteration), model: this.#config.codexModel,
        timeoutMs: this.#config.gateTimeoutMs, signal: running.controller.signal,
        // The run live in events.jsonl (SF-045).
        onEvent: (event) => this.#appendLive(job, 'gate_event', redactor.codexEvent(event)),
      });
    } catch (error) {
      const at = now();
      outcome = { ok: false, message: `The gate could not start: ${(error as Error).message}`.slice(0, 1000), tokens: noTokens(), startedAt: at, endedAt: at };
    }
    // The failure message (Codex's stderr or error event) goes to gate.json, the event and the
    // job's error: withheld or redacted like the run's prose (src/redact.ts, failure).
    if (!outcome.ok) {
      outcome = { ...outcome, message: redactor.failure(outcome.message) };
    }
    const ended = outcome;
    await this.#locked(() => this.#gated(job, running, claude, ended));
  }

  // The end of a gate run. A cancelled one leaves no trace. Otherwise its tokens count for the job,
  // gate.json and the event are written, and the verdict applies only while the job still awaits
  // review of the same iteration, as the factory acts on it (decide, SF-051): clean (a fix with nits
  // only too) runs Clean with the paths both reviewers accepted, fix (a blocker or major item, or an
  // undeclared sensitive path or a path outside the Task's scope the gate does not accept) is the
  // next Fix section unless the gate's rounds are used up.
  async #gated(gated: Job, running: RunningReview, claude: ReviewOutput, outcome: GateOutcome): Promise<void> {
    const { workspace: name, ticket, iteration } = gated;
    const key = `${name}/${ticket}`;
    if (this.#reviews.get(key) !== running || running.controller.signal.aborted) {
      return;
    }
    this.#reviews.delete(key);
    const read = await this.jobs.read(name, ticket);
    if (read === undefined || read.created_at !== gated.created_at) {
      return;
    }
    let job = read;
    const used = outcome.tokens.input + outcome.tokens.output;
    if (used > 0) {
      job = { ...job, gate_tokens: job.gate_tokens + used };
      await this.jobs.write(job);
    }
    const current = job.state === 'awaiting_review' && job.iteration === iteration;
    const ignored = current ? {} : { ignored: true as const };
    const model = this.#config.codexModel !== undefined ? { model: this.#config.codexModel } : {};
    const times = { started_at: outcome.startedAt, ended_at: outcome.endedAt };
    const record: GateRecord = outcome.ok
      ? { reviewer: GATE_REVIEWER, ...outcome.output, ...model, tokens: outcome.tokens, ...times }
      : { reviewer: GATE_REVIEWER, error: outcome.message, ...model, tokens: outcome.tokens, ...times };
    await this.jobs.writeGate(name, ticket, iteration, record);
    await this.jobs.appendEvent(name, ticket, outcome.ok
      ? { ts: now(), iteration, type: 'review', reviewer: GATE_REVIEWER, ...(await this.#verdictOf(job, outcome.output)), items: outcome.output.items.length, ...ignored }
      : { ts: now(), iteration, type: 'review_failed', reviewer: GATE_REVIEWER, error: outcome.message, ...ignored });
    if (!current) {
      return;
    }
    if (!outcome.ok) {
      await this.#transition(job, 'needs_human', { code: 'gate_failed', message: outcome.message });
      return;
    }
    if (job.gate_tokens > this.#config.gateMaxTokens) {
      await this.#transition(job, 'needs_human', {
        code: 'gate_budget',
        message: `The gate runs of this job used ${job.gate_tokens} tokens, over the limit of SF_GATE_MAX_TOKENS (${this.#config.gateMaxTokens}); the gate's verdict (${outcome.output.verdict}) was not applied.`,
      });
      return;
    }
    const { summary, accepted_sensitive: accepted } = outcome.output;
    // The ledger applies first (SF-052): a dropped item never counts, a dispute or churn hands the
    // job to the user.
    const applied = await this.#applyLedger(job, GATE_REVIEWER, outcome.output);
    if (applied.kind === 'stop') {
      await this.#transition(job, 'needs_human', { code: applied.code, message: applied.message });
      return;
    }
    const fixing = applied.kind === 'fix';
    if (fixing && job.gate_fixes >= this.#config.gateMaxRounds) {
      const message = `The gate asked for a fix ${job.gate_fixes + 1} times, over the limit of SF_GATE_MAX_ROUNDS (${this.#config.gateMaxRounds}); the fix was not applied. Claude: ${oneLine(claude.summary)} Codex: ${oneLine(summary)}`;
      await this.#transition(job, 'needs_human', { code: 'gate_rounds', message: message.slice(0, 2000) });
      return;
    }
    const decided = job;
    await this.#applying(decided, async () => {
      if (applied.kind === 'fix') {
        await this.#fix(decided, fixContent(summary, applied.items, 'Codex'), { counts: { gate_fixes: decided.gate_fixes + 1 }, ledger: applied.ledger });
      } else {
        await this.#afterClean(decided, [...new Set([...claude.accepted_sensitive, ...accepted])]);
      }
    });
  }

  // After the deciding clean verdict (SF-055): the simplification pass when it is due, else MR
  // preparation with the accepted paths (sensitive). A pass that already ended on this iteration
  // (its runner stopped before the outcome applied) applies its record; one that started on it and
  // never ended (its runner stopped while it ran) is recorded as failed and goes on, as a failed
  // run does. Only under the lock.
  async #afterClean(job: Job, sensitive: string[]): Promise<void> {
    const { workspace, ticket, iteration } = job;
    const record = await this.jobs.readSimplify(workspace, ticket, iteration);
    if (record !== undefined) {
      await this.#offerSimplify(job, record, sensitive);
    } else if (job.simplify_iteration === iteration) {
      const at = now();
      const error = 'The simplification pass was interrupted (its runner ended while it ran); it runs once per job.';
      await this.jobs.writeSimplify(workspace, ticket, iteration, { reviewer: SIMPLIFIER, error, started_at: at, ended_at: at });
      await this.jobs.appendEvent(workspace, ticket, { ts: at, iteration, type: 'simplify', reviewer: SIMPLIFIER, suggestions: 0, dropped: 0, error });
      await this.#prepareMr(job, sensitive);
    } else if (this.#simplifyDue(job)) {
      await this.#startSimplify(job, sensitive);
    } else {
      await this.#prepareMr(job, sensitive);
    }
  }

  // Whether the simplification pass runs on the job (SF-055): SF_SIMPLIFY on, at least one Fix
  // section written (at SF_MAX_ITERATIONS too: Simplify may go over it), and never before: the job's
  // simplify_iteration, written before a pass starts, is still absent. So it runs at most once per job,
  // whether that run ended, failed, was interrupted or the job moved on.
  #simplifyDue(job: Job): boolean {
    return this.#config.simplify && job.fixes >= 1 && job.simplify_iteration === undefined;
  }

  // The suggestions the user skipped (SF-055), with the iteration the pass ran on: the simplify.json
  // marked skipped_at by sf accept. A Simplify, or an answer by sf say, leaves none.
  async #skippedSimplifications(job: Job): Promise<{ suggestions: Suggestion[]; iteration: number } | undefined> {
    for (let number = job.iteration; number >= 1; number -= 1) {
      const record = await this.jobs.readSimplify(job.workspace, job.ticket, number);
      if (record !== undefined) {
        return 'suggestions' in record && record.skipped_at !== undefined ? { suggestions: record.suggestions, iteration: number } : undefined;
      }
    }
    return undefined;
  }

  // Starts the simplification pass after the deciding clean verdict: the job's simplify_iteration is
  // written first, so the pass is used up before it runs. It runs outside the lock, as the reviews
  // do, and stops with them (abort, reset). Only under the lock.
  async #startSimplify(current: Job, sensitive: string[]): Promise<void> {
    this.#runnerJob();
    if (this.#stopping) {
      return;
    }
    const job: Job = { ...current, simplify_iteration: current.iteration };
    await this.jobs.write(job);
    const key = `${job.workspace}/${job.ticket}`;
    this.#reviews.get(key)?.controller.abort();
    const running: RunningReview = { reviewer: SIMPLIFIER, iteration: job.iteration, controller: new AbortController() };
    this.#reviews.set(key, running);
    this.#runSimplifyPass(job, running, sensitive).catch((error: unknown) => console.error(error));
  }

  // The material of the pass: the Task file in the worktree, the final Patch, the ledger and, per
  // Fix section N, the files iteration N+1 changed against iteration N (their Patches compared).
  async #simplifyInput(job: Job, worktree: string): Promise<SimplifyInput> {
    const { workspace, ticket, iteration } = job;
    const { patch } = await this.jobs.readIteration(workspace, ticket, iteration);
    const meta = await this.jobs.readMeta(workspace, ticket, iteration);
    const task = await readFile(join(worktree, TASK_DIR, `${ticket}.md`), 'utf8');
    const fixes: FixFiles[] = [];
    for (const fix of fixNumbers(task)) {
      let files: string[] | undefined;
      if (fix >= 1 && fix + 1 <= iteration) {
        try {
          const before = (await this.jobs.readIteration(workspace, ticket, fix)).patch.toString('utf8');
          const after = (await this.jobs.readIteration(workspace, ticket, fix + 1)).patch.toString('utf8');
          files = changedBetween(before, after);
        } catch {
          files = undefined;
        }
      }
      fixes.push({ fix, files });
    }
    return { ticket, iteration, task, patch, patchTruncated: meta.patch_truncated, ledger: await this.jobs.readLedger(workspace, ticket), fixes };
  }

  // Runs the pass (the review's session settings: SF_REVIEW_MODEL, SF_REVIEW_MAX_TURNS, the
  // sandbox), then applies its outcome under the lock. Its messages go to events.jsonl redacted, as
  // the review's; a failure message is redacted before it is recorded.
  async #runSimplifyPass(job: Job, running: RunningReview, sensitive: string[]): Promise<void> {
    let outcome: StructuredOutcome<SimplifyOutput>;
    const redactor = new Redactor({ cwd: job.worktree ?? '' });
    try {
      if (job.worktree === null) {
        throw new Error('the job has no worktree');
      }
      const prompt = simplifyPrompt(await this.#simplifyInput(job, job.worktree));
      outcome = await runSimplify(prompt, {
        cwd: job.worktree, claudePath: this.#config.claudePath, sandbox: this.#config.sandbox, model: this.#config.reviewModel,
        maxTurns: this.#config.reviewMaxTurns, signal: running.controller.signal,
        onMessage: (message) => this.#appendLive(job, 'review_message', redactor.reviewMessage(message), SIMPLIFIER),
      });
    } catch (error) {
      const at = now();
      outcome = { ok: false, message: `The simplification pass could not start: ${(error as Error).message}`.slice(0, 1000), model: null, startedAt: at, endedAt: at };
    }
    if (!outcome.ok) {
      outcome = { ...outcome, message: redactor.failure(outcome.message) };
    }
    const ended = outcome;
    await this.#locked(() => this.#simplifyEnded(job, running, sensitive, ended));
  }

  // The end of the pass. A cancelled one leaves no trace; one the job moved on from leaves only its
  // event (ignored); either way the job's simplify_iteration keeps any later pass from running. Otherwise simplify.json (the suggestions the
  // ledger guard kept, and those it dropped) and the event are written and the outcome applies.
  async #simplifyEnded(started: Job, running: RunningReview, sensitive: string[], outcome: StructuredOutcome<SimplifyOutput>): Promise<void> {
    const { workspace, ticket, iteration } = started;
    const key = `${workspace}/${ticket}`;
    if (this.#reviews.get(key) !== running || running.controller.signal.aborted) {
      return;
    }
    this.#reviews.delete(key);
    const job = await this.jobs.read(workspace, ticket);
    if (job === undefined || job.created_at !== started.created_at) {
      return;
    }
    const current = job.state === 'awaiting_review' && job.iteration === iteration;
    const guarded = outcome.ok ? guardSuggestions(outcome.output.suggestions, await this.jobs.readLedger(workspace, ticket)) : undefined;
    await this.jobs.appendEvent(workspace, ticket, {
      ts: now(), iteration, type: 'simplify', reviewer: SIMPLIFIER, suggestions: guarded?.kept.length ?? 0, dropped: guarded?.dropped.length ?? 0,
      ...(outcome.ok ? {} : { error: outcome.message }), ...(current ? {} : { ignored: true as const }),
    });
    if (!current) {
      return;
    }
    const record: SimplifyRecord = outcome.ok
      ? { reviewer: SIMPLIFIER, summary: outcome.output.summary, suggestions: guarded!.kept, dropped: guarded!.dropped, cost_usd: outcome.costUsd, model: outcome.model, started_at: outcome.startedAt, ended_at: outcome.endedAt }
      : { reviewer: SIMPLIFIER, error: outcome.message, started_at: outcome.startedAt, ended_at: outcome.endedAt };
    await this.jobs.writeSimplify(workspace, ticket, iteration, record);
    await this.#applying(job, () => this.#offerSimplify(job, record, sensitive));
  }

  // The outcome of the pass: suggestions are offered to the user (needs_human, simplify_offered);
  // none, or a failed run, goes on to MR preparation. Only under the lock.
  async #offerSimplify(job: Job, record: SimplifyRecord, sensitive: string[]): Promise<void> {
    if (!('suggestions' in record) || record.suggestions.length === 0) {
      await this.#prepareMr(job, sensitive);
      return;
    }
    await this.#transition(job, 'needs_human', { code: SIMPLIFY_CODE, message: offerMessage(record.suggestions) });
  }

  // The user's Simplify on the offer (sf simplify, the dashboard's Simplify, SF-055): one Fix section
  // "Simplify" with the suggestions, each recorded in the ledger as accepted_risk of reviewer
  // simplify, and the normal pipeline (the Implementer, the Claude review, the gate). Never twice.
  simplify(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; check_after_minutes: number }> {
    return this.#request(workspaceName, ticket, { kind: 'simplify' }) as Promise<{ state: JobState; iteration: number; check_after_minutes: number }>;
  }

  // sf simplify needs needs_human with simplify_offered.
  #checkSimplify(job: Job): void {
    if (job.state !== 'needs_human' || job.error?.code !== SIMPLIFY_CODE) {
      throw new FactoryError('invalid_state', `sf simplify needs needs_human with ${SIMPLIFY_CODE}; the job is ${job.state}${job.error !== undefined ? ` (${job.error.code})` : ''}.`);
    }
  }

  // The Simplify in the runner.
  #applySimplify(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; check_after_minutes: number }> {
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      this.#checkSimplify(job);
      const ledger = await this.jobs.readLedger(workspaceName, ticket);
      if (ledger.some(isSimplification)) {
        throw new FactoryError('invalid_state', 'The simplification was applied on this job already; it runs once per job.');
      }
      const record = await this.jobs.readSimplify(workspaceName, ticket, job.iteration);
      if (record === undefined || !('suggestions' in record) || record.suggestions.length === 0) {
        throw new FactoryError('invalid_state', `Iteration ${job.iteration} has no suggestion of the simplification pass.`);
      }
      if (job.worktree === null || !(await exists(job.worktree))) {
        throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
      }
      const fix = simplifyFix(ledger, record.summary, record.suggestions, job.iteration, now());
      const result = await this.#fix(job, fix.content, { ledger: fix.ledger, fromStop: true, title: SIMPLIFY_TITLE, overLimit: true });
      await this.jobs.appendEvent(workspaceName, ticket, { ts: now(), iteration: job.iteration, type: 'simplify_chosen', choice: 'simplify', suggestions: record.suggestions.length });
      return { state: 'working', ...result };
    });
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
    this.#live.delete(`${job.workspace}/${job.ticket}`);
    const lines = [content.title, notificationLine((await this.#lastFiles(job)) ?? [])];
    let ready: Job = { ...job, base_commit: job.target_commit, prepared_commit: tip };
    // The registry as it is now: its handoff may have changed while the job ran. When it cannot be
    // read or the checkout not verified, the setting from the job's start applies (the hand-over
    // itself then answers the checkout's problem as its refusal).
    const own = (await this.#resolve(job.workspace).catch(() => live.workspace)).handoff;
    const off = handoffOffNotice(own, this.#config.handoff, job.ticket);
    if (off !== undefined) {
      ready = { ...ready, handoff_skipped: off };
    } else {
      const outcome = await this.#handOver(ready, live.workspace, content);
      if (outcome.ok) {
        await this.#transition(outcome.job, 'handed_over', undefined, lines);
        console.log(`${job.workspace}/${job.ticket}: branch ${job.branch} ready (${content.title}), in the checkout`);
        return;
      }
      if (outcome.error.code === 'handover_interrupted') {
        await this.#transition(outcome.job, 'needs_human', outcome.error);
        return;
      }
      ready = { ...outcome.job, handoff_skipped: outcome.error };
    }
    await this.#transition(ready, 'ready_for_human_review', undefined, lines);
    console.log(`${job.workspace}/${job.ticket}: branch ${job.branch} ready (${content.title})`);
  }

  // The hand-over of a prepared job to the workspace's checkout (SF-073, src/handoff.ts), under the
  // workspace's Git lock: the record with step handing_over is written before the checkout changes.
  // ok: the job to move to handed_over (its worktree gone, or kept when it could not be removed);
  // else the refusal and the job as written (without the record). Only under the lock.
  async #handOver(job: Job, workspace: Workspace, content: MrContent): Promise<{ ok: true; job: Job } | { ok: false; job: Job; error: { code: string; message: string } }> {
    let current = job;
    const record = async (handover: Handover): Promise<void> => {
      current = { ...current, handover };
      await this.jobs.write(current);
    };
    try {
      const done = await this.#gitLocked(job.workspace, () => handOver({
        checkout: workspace.workCheckout, worktree: job.worktree, ticket: job.ticket, branch: job.branch,
        saved: job.prepared_commit!, base: job.base_commit!, message: `${content.title}\n\n${content.body}`, at: now(), record,
      }));
      const { handoff_skipped: _skipped, ...rest } = current;
      const next: Job = { ...rest, handover: done.handover, worktree: done.removeFailure === undefined ? null : job.worktree };
      await this.jobs.write(next);
      await this.jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration: job.iteration, type: 'handover', action: 'handed_over', handover: done.handover });
      if (done.removeFailure !== undefined) {
        await this.#handoverNote(next, `The worktree could not be removed after the hand-over: ${done.removeFailure}`);
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
      await this.jobs.write(rest);
      return { ok: false, job: rest, error: failure };
    }
  }

  async #handoverNote(job: Job, note: string): Promise<void> {
    console.error(`${job.workspace}/${job.ticket}: ${note}`);
    await this.jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration: job.iteration, type: 'handover', action: 'note', note });
  }

  // The hand-over ended (Ask for changes, Take it back, the push, abort): the record goes into the
  // event log; the job is returned without it.
  async #endHandover(job: Job): Promise<Job> {
    const { handover, ...rest } = job;
    if (handover !== undefined) {
      await this.jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration: job.iteration, type: 'handover', action: 'ended', handover });
    }
    return rest;
  }

  // sf handover (SF-073): hands a job waiting in ready_for_human_review over to the checkout. A
  // refusal (checkout_dirty, checkout_busy, handover_refused, handover_mismatch) leaves the job as it
  // was and is returned as the error.
  handover(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string }> {
    return this.#locked(async () => {
      const check = (job: Job): void => {
        if (job.state !== 'ready_for_human_review') {
          throw new FactoryError('invalid_state', `sf handover needs ready_for_human_review; the job is ${job.state}.`);
        }
        if (job.prepared_commit === null || job.base_commit === null) {
          throw new FactoryError('invalid_state', `The job ${workspaceName}/${ticket} has no prepared commit to hand over.`);
        }
      };
      check(await this.#job(workspaceName, ticket));
      await this.#settled(workspaceName, ticket);
      const job = await this.#job(workspaceName, ticket);
      check(job);
      const workspace = await this.#resolve(workspaceName);
      const content = await this.#mrContent(job);
      const outcome = await this.#handOver(job, workspace, content);
      if (!outcome.ok) {
        if (outcome.error.code === 'handover_interrupted') {
          await this.#transition(outcome.job, 'needs_human', outcome.error);
        }
        throw new FactoryError(outcome.error.code, outcome.error.message);
      }
      const next = await this.#transition(outcome.job, 'handed_over', undefined, [content.title, notificationLine((await this.#lastFiles(job)) ?? [])]);
      return { state: next.state, branch: next.branch };
    });
  }

  // sf takeback (SF-073): the job back from the checkout into ready_for_human_review, only while
  // the checkout is as the factory left it (takeback_changed otherwise); it holds an SF_MAX_JOBS
  // slot again (job_limit).
  takeback(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; worktree: string }> {
    return this.#locked(async () => {
      this.#checkHandedOver(await this.#job(workspaceName, ticket), 'sf takeback');
      await this.#settled(workspaceName, ticket);
      const job = await this.#job(workspaceName, ticket);
      const handover = this.#checkHandedOver(job, 'sf takeback');
      await this.#checkSlot(workspaceName, ticket);
      const workspace = await this.#resolve(workspaceName);
      const worktree = job.worktree ?? this.#worktreePath(workspaceName, ticket);
      await this.#gitLocked(workspaceName, () => takeBack(workspace.workCheckout, worktree, ticket, handover));
      const next = await this.#transition({ ...(await this.#endHandover(job)), worktree, prepared_commit: handover.saved }, 'ready_for_human_review');
      return { state: next.state, branch: next.branch, worktree };
    });
  }

  // A handed-over job with no step of the hand-over in progress, and its record; invalid_state otherwise.
  #checkHandedOver(job: Job, command: string): Handover {
    if (job.state !== 'handed_over' || job.handover === undefined) {
      throw new FactoryError('invalid_state', `${command} needs handed_over; the job is ${job.state}.`);
    }
    if (job.handover.step !== null) {
      throw cutOffError(job, job.handover.step);
    }
    return job.handover;
  }

  // sf handed-done (SF-073): the user opened the merge request from the checkout; origin must have
  // the branch beyond the base (not_pushed otherwise), and the job goes to pushed.
  handedDone(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; commit?: string; same_tree?: boolean | null }> {
    return this.#pushCheck(workspaceName, ticket, true);
  }

  // The check for the user's own push of a handed-over branch (SF-073): origin is asked where the
  // branch is, outside the lock; a branch pushed beyond the base moves the job to pushed. Errors
  // change nothing and are logged. minIntervalMs: none when origin was asked as recently (the
  // dashboard's job detail, every 60 s at most).
  async checkHandedOver(workspaceName: string, ticket: string, minIntervalMs = 0): Promise<{ state: JobState; branch: string; commit?: string; same_tree?: boolean | null }> {
    try {
      return await this.#pushCheck(workspaceName, ticket, false, minIntervalMs);
    } catch (error) {
      console.error(error);
      const job = await this.jobs.read(workspaceName, ticket);
      return { state: job?.state ?? 'handed_over', branch: job?.branch ?? '' };
    }
  }

  async #pushCheck(workspaceName: string, ticket: string, done: boolean, minIntervalMs = 0): Promise<{ state: JobState; branch: string; commit?: string; same_tree?: boolean | null }> {
    const asked = await this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      if (!done && (job.state !== 'handed_over' || job.handover === undefined || job.handover.step !== null)) {
        return { job };
      }
      this.#checkHandedOver(job, 'sf handed-done');
      const checked = job.handover!.checked_at;
      if (!done && checked !== null && Date.now() - Date.parse(checked) < minIntervalMs) {
        return { job };
      }
      await this.#settled(workspaceName, ticket);
      // Only the background check counts toward its interval; sf handed-done asks on demand.
      if (done) {
        return { job, handover: job.handover! };
      }
      const next: Job = { ...job, handover: { ...job.handover!, checked_at: now() } };
      await this.jobs.write(next);
      return { job: next, handover: next.handover! };
    });
    if (asked.handover === undefined) {
      return { state: asked.job.state, branch: asked.job.branch };
    }
    const workspace = await this.#resolve(workspaceName);
    const remote = await remoteBranch(workspace.workCheckout, ticket, asked.handover);
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      // The job moved on (or was handed over again) while origin answered.
      if (job.state !== 'handed_over' || job.handover?.at !== asked.handover.at || job.handover.step !== null) {
        if (done) {
          throw new FactoryError('invalid_state', `The job changed while origin was asked; it is ${job.state}.`);
        }
        return { state: job.state, branch: job.branch };
      }
      await this.#settled(workspaceName, ticket);
      const pushed = this.#pushedCommit(job, remote, done);
      if (pushed === undefined) {
        return { state: job.state, branch: job.branch };
      }
      await this.jobs.appendEvent(workspaceName, ticket, { ts: now(), iteration: job.iteration, type: 'handover_pushed', commit: pushed.commit, same_tree: pushed.same_tree });
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
      throw new FactoryError('not_pushed', `The branch ${job.branch} on origin (${remote.commit.slice(0, 12)}) does not descend from the job's base ${job.handover!.base.slice(0, 12)}; push your changes to it first.`);
    }
    throw new FactoryError('not_pushed', `The branch ${job.branch} is not on origin with your changes; push it first.`);
  }

  // A handed-over job the user pushed: the config and the prefilled commit message go, a worktree
  // left over goes, and the job is pushed with the pushed commit. Only under the lock.
  async #pushedByUser(job: Job, workspace: Workspace, commit: string): Promise<Job> {
    const ended = await this.#leaveCheckout(job, workspace, true);
    const title = mrMessage((await this.jobs.readMrText(job.workspace, job.ticket)) ?? '').title;
    return this.#transition({ ...ended, prepared_commit: commit }, 'pushed', undefined, [title]);
  }

  // A handed-over job leaves the checkout (the push, abort): the factory's commit.template and
  // commit.cleanup go back, with pushed the prefilled message file and a worktree left over too.
  // Returns the job without the hand-over record.
  async #leaveCheckout(job: Job, workspace: Workspace, pushed: boolean): Promise<Job> {
    const checkout = workspace.workCheckout;
    let worktree = job.worktree;
    if (job.handover !== undefined) {
      const handover = job.handover;
      await this.#gitLocked(job.workspace, async () => {
        await restoreConfig(checkout, job.ticket, handover);
        if (pushed) {
          await rm(await commitMessagePath(checkout, job.ticket), { force: true });
        }
      });
    }
    if (pushed && worktree !== null) {
      const failure = await this.#gitLocked(job.workspace, () => removeWorktree(checkout, worktree!));
      if (failure === undefined) {
        worktree = null;
      } else {
        await this.#handoverNote(job, `The worktree could not be removed after the push: ${failure}`);
      }
    }
    return { ...(await this.#endHandover(job)), worktree };
  }

  async #lastFiles(job: Job): Promise<FileChange[] | undefined> {
    if (job.iteration === 0) {
      return undefined;
    }
    try {
      return (await this.jobs.readMeta(job.workspace, job.ticket, job.iteration)).files;
    } catch {
      return undefined;
    }
  }

  // Clean (the deciding clean verdict): every undeclared sensitive path and every path outside the
  // Task's scope of the reviewed iteration must be acknowledged; then the target is resolved and
  // the MR text turn runs in the worktree. When it ends the factory commits and rebases (#mrIdle),
  // and the job ends in ready_for_human_review with the branch in the checkout. Also the retry
  // after a failed preparation (needs_human with mr_attempts > 0).
  markClean(workspaceName: string, ticket: string, sensitive: string[] = []): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.#request(workspaceName, ticket, { kind: 'clean', sensitive }) as Promise<{ state: JobState; iteration: number; branch: string }>;
  }

  // Whether MR preparation may start: awaiting_review, the retry after a failed preparation, or the
  // user's Accept (acceptGate, which checked the state); returns whether it is the retry.
  #checkPrepareMr(job: Job, accepted = false): boolean {
    // A prepared commit means the preparation ended (a failed push): not a retry (SF-073).
    const retry = !accepted && job.state === 'needs_human' && job.mr_attempts > 0 && job.worktree !== null && job.prepared_commit === null;
    if (!(job.state === 'awaiting_review' || retry || accepted)) {
      throw new FactoryError('invalid_state', `mark_clean needs awaiting_review (or needs_human after an MR preparation); the job is ${job.state}.`);
    }
    return retry;
  }

  // The work of mark_clean, also run for a clean verdict of the review. Only under the lock.
  // With onAccepted (acceptGate, which checked the state), the user's Accept is recorded by it once
  // every check has passed, before the job moves on: the gate override, or the Skip (SF-055).
  async #prepareMr(job: Job, sensitive: string[], onAccepted?: () => Promise<void>): Promise<{ state: JobState; iteration: number; branch: string }> {
    const { workspace: workspaceName, ticket } = job;
    const retry = this.#checkPrepareMr(job, onAccepted !== undefined);
    const unacknowledged = markedGroups(await this.#unaccepted(job, sensitive));
    if (unacknowledged.length > 0) {
      const lines = unacknowledged.map((group) => `${group.label.charAt(0).toUpperCase()}${group.label.slice(1)} in the reviewed iteration: ${group.paths.join(', ')}.`);
      throw new FactoryError('sensitive_unacknowledged', `${lines.join(' ')} Each must be named in the accepted sensitive paths with the reason it is needed; otherwise it is a fix item.`);
    }
    if (job.worktree === null || !(await exists(job.worktree))) {
      throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
    }
    const key = `${workspaceName}/${ticket}`;
    const live = this.#live.get(key);
    if (live?.session.busy === true) {
      throw new FactoryError('turn_running', 'A turn of the Implementer is running; wait for it to end.');
    }
    const workspace = live?.workspace ?? (await this.#resolve(workspaceName));
    const cwd = job.worktree;
    const target = await this.#gitLocked(workspaceName, async () => {
      // A rebase left in progress when sf serve restarted during a conflict turn.
      await abortRebase(cwd);
      // No turn while the user's checkout holds the branch (SF-073).
      await checkBranchFree(workspace.workCheckout, cwd, job.branch, ticket);
      return resolveTarget(workspace.workCheckout, job.base);
    });
    await onAccepted?.();
    const attempt = job.mr_attempts + 1;
    const next = await this.#syncTask(workspace, await this.#transition({ ...job, target_commit: target.commit, mr_attempts: attempt }, 'preparing_mr'));
    const prompt = mrPrompt({
      ticket, branch: job.branch, targetRef: target.ref, targetCommit: target.commit, attempt,
      previousError: retry ? job.error?.message : undefined, handbook: this.#handbook,
    });
    const session = this.#session(next, workspace);
    this.#live.get(key)!.mr = { targetRef: target.ref };
    session.send(prompt, DENIED_TOOLS);
    return { state: next.state, iteration: next.iteration, branch: next.branch };
  }

  // The user's approve: the branch the factory prepared at Clean is pushed. Nothing is committed
  // or rebased here; a tip that moved since is refused unless asIs.
  approve(workspaceName: string, ticket: string, asIs = false): Promise<MrOutcome> {
    return this.#locked(async () => {
      // Refused at once in a state approve does not take; checked again once the runner has ended.
      this.#checkApprovable(await this.#job(workspaceName, ticket), 'approve');
      await this.#settled(workspaceName, ticket);
      const job = await this.#job(workspaceName, ticket);
      this.#checkApprovable(job, 'approve');
      return this.#approve(job, await this.#resolve(workspaceName), asIs);
    });
  }

  // The push writes a job no runner may write at the same time: the job's runner has ended (it
  // exits once the job waits for the user) and no request (sf say, a fix) waits for one;
  // runner_active otherwise. Only under the lock, under which every request is queued.
  async #settled(workspaceName: string, ticket: string): Promise<void> {
    if (!(await this.#serveRunners().settled(workspaceName, ticket))) {
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
    const pushFailure = await this.#gitLocked(workspaceName, () => pushBranch(checkout, job.branch, job.base, plan.source));
    if (pushFailure !== undefined) {
      if (job.state === 'handed_over') {
        // The checkout, the record, the saved ref and the config stay; Approve can be retried.
        const kept: Job = { ...job, error: pushFailure };
        await this.jobs.write(kept);
        this.#announce(kept, []);
        return { state: kept.state, branch: kept.branch, error: pushFailure };
      }
      const next = await this.#transition(job, 'needs_human', pushFailure);
      return { state: next.state, branch: next.branch, error: pushFailure };
    }
    let message = plan.message;
    let after: Job = job;
    if (job.state === 'handed_over') {
      const handover = job.handover!;
      if (plan.source !== undefined) {
        const changed = await this.#gitLocked(workspaceName, () => settleAfterPush(checkout, handover));
        message = `Pushed the factory's commit ${handover.saved.slice(0, 12)}.${changed !== undefined && changed > 0 ? ` Your uncommitted changes (${changed} files) were not pushed.` : ''}`;
      }
      after = await this.#leaveCheckout(job, workspace, true);
    } else if (job.worktree !== null) {
      // The worktree stays until the push (SF-073); a failure keeps its path for the next action.
      const worktree = job.worktree;
      const failure = await this.#gitLocked(workspaceName, () => removeWorktree(checkout, worktree));
      if (failure === undefined) {
        after = { ...job, worktree: null };
      } else {
        await this.#handoverNote(job, `The worktree could not be removed after the push: ${failure}`);
      }
    }
    const mrText = (await this.jobs.readMrText(workspaceName, ticket)) ?? '';
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
    const pushed = await this.#transition({ ...after, prepared_commit: plan.commit, mr }, 'pushed', undefined, lines);
    if (opened !== undefined) {
      await this.#mrEvent(pushed, opened.reused ? 'reused' : 'created');
    }
    this.#live.delete(`${workspaceName}/${ticket}`);
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
    const handover = this.#checkHandedOver(job, 'approve');
    if (tip === handover.base) {
      return { commit: handover.saved, source: savedRef(job.ticket), message: undefined };
    }
    if (await isAncestor(checkout, handover.base, tip)) {
      return { commit: tip, source: undefined, message: `Pushed your commit ${tip.slice(0, 12)} (${await subjectOf(checkout, tip)}).` };
    }
    throw new FactoryError('branch_changed', `The tip of ${job.branch} does not descend from the job's base ${handover.base.slice(0, 12)}; push it yourself or take it back.`);
  }

  // The MR text as the merge request's title and body: the same message as the job's commit (mrMessage).
  async #mrContent(job: Job): Promise<MrContent> {
    const text = await this.jobs.readMrText(job.workspace, job.ticket);
    if (text === undefined || text.trim() === '') {
      throw new FactoryError('mr_text_missing', `The job ${job.workspace}/${job.ticket} has no MR text to open a merge request with.`);
    }
    return mrMessage(text);
  }

  // The Forge of the job's workspace (its checkout's origin); refused when the job's merge request
  // is on another host than the origin now is.
  async #forge(job: Job, workspace?: Workspace): Promise<Forge> {
    const checkout = (workspace ?? (await this.#resolve(job.workspace))).workCheckout;
    const forge = forgeFor(await originUrl(checkout), this.#config.forge);
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
    await this.jobs.appendEvent(job.workspace, job.ticket, {
      ts: now(), iteration: job.iteration, type: 'merge_request', action, host: mr.host, number: mr.number, url: mr.url, mr_state: mr.state,
      ...(typeof mr.merge_commit === 'string' ? { merge_commit: mr.merge_commit } : {}),
    });
  }

  // A change of the job's merge request outside a state change: the listeners (the notification,
  // the dashboard) hear of it as of a job that stays in its state.
  #announce(job: Job, lines: string[]): void {
    try {
      this.#onStateChange(job, job.state, lines);
    } catch (listenerError) {
      console.error(listenerError);
    }
  }

  // sf mr create (SF-048): opens the merge request of a pushed job on the Git host, or reuses the
  // one already open for the branch; from ready_for_human_review it is approve (the push) and then
  // the merge request, in one action. The host and its token are checked before anything is pushed.
  createMergeRequest(workspaceName: string, ticket: string): Promise<MrOutcome> {
    return this.#locked(async () => {
      // A job that approve would push: its runner has ended first.
      if (this.#approvable(await this.#job(workspaceName, ticket))) {
        await this.#settled(workspaceName, ticket);
      }
      const job = await this.#job(workspaceName, ticket);
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
      const workspace = await this.#resolve(workspaceName);
      const forge = await this.#forge(job, workspace);
      const content = await this.#mrContent(job);
      if (combined) {
        return this.#approve(job, workspace, false, { forge, content });
      }
      const opened = await this.#openMr(job, forge, content);
      const next: Job = { ...job, mr: { host: opened.host, number: opened.number, url: opened.url, state: opened.state } };
      await this.jobs.write(next);
      await this.#mrEvent(next, opened.reused ? 'reused' : 'created');
      this.#announce(next, [content.title, `Merge request #${opened.number}: ${opened.url}`]);
      return { state: next.state, branch: next.branch, title: content.title, mr: opened };
    });
  }

  // sf mr merge (SF-048): merges the job's open merge request through the host's API (no push, no
  // force). The host's refusal (conflicts, failing required checks, a draft) comes back as
  // mr_not_mergeable with its reason, and nothing changes.
  mergeMergeRequest(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; mr: JobMr }> {
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      if (job.state !== 'pushed' || job.mr === null) {
        throw new FactoryError('invalid_state', `sf mr merge needs a pushed job with a merge request (sf mr create opens one); the job is ${job.state}${job.state === 'pushed' ? ' without one' : ''}.`);
      }
      if (job.mr.state !== 'open') {
        throw new FactoryError('invalid_state', `The merge request #${job.mr.number} is ${job.mr.state}; only an open one is merged.`);
      }
      const forge = await this.#forge(job);
      const merged = await forge.merge(job.mr.number);
      const next: Job = { ...job, mr: { ...job.mr, state: 'merged', merge_commit: merged.merge_commit } };
      await this.jobs.write(next);
      await this.#mrEvent(next, 'merged');
      this.#announce(next, [`Merge request #${job.mr.number} merged into ${job.base}`, job.mr.url]);
      return { state: next.state, branch: next.branch, mr: next.mr! };
    });
  }

  // sf mr status (SF-048): what the host says of the job's merge request now. A merge request the
  // host has merged or closed meanwhile (by hand) is recorded so; nobody is notified.
  async mergeRequestStatus(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; mr: JobMr; status: MergeRequestStatus }> {
    const job = await this.#job(workspaceName, ticket);
    if (job.mr === null) {
      throw new FactoryError('invalid_state', `No merge request is recorded for ${workspaceName}/${ticket}; sf mr create opens one.`);
    }
    const number = job.mr.number;
    const status = await (await this.#forge(job)).status(number);
    return this.#locked(async () => {
      const current = await this.#job(workspaceName, ticket);
      if (current.mr === null || current.mr.number !== number || current.mr.state === status.state) {
        return { state: current.state, branch: current.branch, mr: current.mr ?? job.mr!, status };
      }
      const next: Job = { ...current, mr: { ...current.mr, state: status.state, ...(status.merge_commit !== undefined ? { merge_commit: status.merge_commit } : {}) } };
      await this.jobs.write(next);
      await this.#mrEvent(next, 'updated');
      return { state: next.state, branch: next.branch, mr: next.mr!, status };
    });
  }

  // Whether the merge request actions are on for a workspace: its host, or why they are off (the
  // variable missing, an origin on no supported host, the workspace gone). No request is sent.
  async mergeRequestHost(workspaceName: string): Promise<{ host: ForgeKind | null; reason: string | null }> {
    let origin: string | undefined;
    try {
      origin = await originUrl((await this.#resolve(workspaceName)).workCheckout);
    } catch (error) {
      if (error instanceof FactoryError) {
        return { host: null, reason: error.message };
      }
      throw error;
    }
    const choice = chooseForge(origin, this.#config.forge);
    return choice.ok ? { host: choice.kind, reason: null } : { host: choice.kind, reason: choice.reason };
  }

  // Ends the job: the runner stops (and with it the session, the review and the gate); the worktree
  // stays unless discard, which removes it and the branch.
  abort(workspaceName: string, ticket: string, discard: boolean): Promise<{ state: JobState; branch: string; discarded: boolean; worktree: string | null; error?: { code: string; message: string } }> {
    return this.#locked(async () => {
      const found = await this.#job(workspaceName, ticket);
      if (TERMINAL_STATES.includes(found.state)) {
        throw new FactoryError('invalid_state', `The job is already ${found.state}.`);
      }
      if (discard) {
        checkNotInCheckout(found);
      }
      if (found.state === 'handed_over') {
        // The checkout holds the branch (SF-073): no runner may be running.
        await this.#settled(workspaceName, ticket);
      }
      const workspace = await this.#resolve(workspaceName);
      const existing = async (job: Job): Promise<string | null> => (job.worktree !== null && (await exists(job.worktree)) ? job.worktree : null);
      const before = await existing(found);
      if (discard && before !== null && (await gitBusy(before))) {
        throw new FactoryError('rebase_in_progress', 'A rebase or a Git lock is in progress in the worktree; discard would lose it. Finish or abort it first, or abort without --discard.');
      }
      await this.#endSession(workspaceName, ticket);
      // The job as its runner left it; one it handed over meanwhile keeps the checkout as it is.
      let job = await this.#job(workspaceName, ticket);
      if (discard) {
        checkNotInCheckout(job);
      }
      if (job.state === 'handed_over') {
        job = await this.#leaveCheckout(job, workspace, false);
      }
      const worktree = await existing(job);
      if (worktree !== null) {
        await this.#clean(job, job.iteration, worktree);
      }
      const ending = job;
      const failure = discard ? await this.#gitLocked(workspaceName, () => this.#discard(workspace.workCheckout, ending, worktree)) : undefined;
      const kept = discard && failure === undefined ? null : worktree;
      const next = await this.#transition({ ...job, worktree: kept }, 'aborted', failure);
      return { state: next.state, branch: next.branch, discarded: discard && failure === undefined, worktree: kept, ...(failure !== undefined ? { error: failure } : {}) };
    });
  }

  // sf pause (SF-067): stops the job where it is, the way abort does (the runner stops, and with it
  // the turn, the review, the gate or the simplification pass and their processes), and the job
  // goes to paused with its worktree, branch, session, iterations, ledger and events. A review round
  // that ran is thrown away, recorded as interrupted (never as a verdict), and runs again on Resume.
  // A step that ended on its own as the runner stopped leaves the job as it left it; one that had
  // begun MR preparation hands the job to the user (mr_interrupted).
  pause(workspaceName: string, ticket: string): Promise<{ state: JobState; branch: string; step: PauseStep | null }> {
    return this.#locked(async () => {
      const found = await this.#job(workspaceName, ticket);
      if (found.state === 'preparing_mr') {
        throw new FactoryError('invalid_state', 'The job is preparing the MR (the MR text, the commit and the rebase); it cannot be paused now. Wait until it waits for you, or abort it.');
      }
      if (!(PAUSABLE_STATES as readonly JobState[]).includes(found.state)) {
        throw new FactoryError('invalid_state', `sf pause needs working or awaiting_review; the job is ${found.state}.`);
      }
      await this.#endSession(workspaceName, ticket);
      // The job as its runner left it.
      const job = await this.#job(workspaceName, ticket);
      if (job.state === 'preparing_mr') {
        const next = await this.#transition(job, 'needs_human', {
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
        await this.#clean(job, iteration, job.worktree);
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
        await this.jobs.appendEvent(workspaceName, ticket, { ts: now(), iteration, type: 'interrupted', step, ...(reviewer !== undefined ? { reviewer } : {}) });
      }
      const next = await this.#transition(paused, 'paused');
      return { state: next.state, branch: next.branch, step };
    });
  }

  // What a job in working or awaiting_review was doing: the turn, or the review round that runs or
  // is due on its last iteration (the Claude review, the gate after a clean one, the simplification
  // pass once started); null when none was (awaiting review with the review off).
  async #interruptedStep(job: Job): Promise<PauseStep | null> {
    const { workspace, ticket, iteration } = job;
    if (job.state === 'working') {
      return 'turn';
    }
    if (iteration === 0) {
      return null;
    }
    const review = await this.jobs.readReview(workspace, ticket, iteration);
    if (review === undefined) {
      return this.#config.review ? 'review' : null;
    }
    if (!('verdict' in review) || actedVerdict(withoutDropped(review)) !== 'clean') {
      return null;
    }
    const gate = await this.jobs.readGate(workspace, ticket, iteration);
    if (gate === undefined && this.#config.gate.on) {
      return 'gate';
    }
    if (gate !== undefined && (!('verdict' in gate) || actedVerdict(withoutDropped(gate)) !== 'clean')) {
      return null;
    }
    return job.simplify_iteration === iteration && (await this.jobs.readSimplify(workspace, ticket, iteration)) === undefined ? 'simplify' : null;
  }

  // sf resume (SF-067): the paused job goes on where it stopped. A turn: the same Implementer session
  // goes on with the message, or "Continue where you stopped."; a review round: it runs again on the
  // same iteration (no message: sf say sends one after). When the Task file changed since the
  // Implementer was last given it, the new one is copied into the worktree (the reviewers read it
  // there), its sha256 recorded, and the turn's message carries its diff. A paused job needs a free
  // slot of SF_MAX_JOBS to go on.
  async resumePaused(workspaceName: string, ticket: string, message = ''): Promise<Resumed> {
    const id = await this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      const request = { kind: 'resume' as const, message };
      this.#check(job, request);
      await this.#checkSlot(workspaceName, ticket);
      return this.#serveRunners().queue(workspaceName, ticket, request);
    });
    return this.#serveRunners().reply(workspaceName, ticket, id) as Promise<Resumed>;
  }

  // sf resume needs a paused job; a message only when a turn was paused, and then plain text.
  #checkResume(job: Job, message: string): void {
    if (job.state !== 'paused') {
      throw new FactoryError('invalid_state', `sf resume needs paused; the job is ${job.state}.`);
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
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      this.#checkResume(job, message);
      if (job.worktree === null || !(await exists(job.worktree))) {
        throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf restart the ticket.`);
      }
      const workspace = await this.#resolve(workspaceName);
      const pause = job.paused ?? { from: 'working' as const, step: 'turn' as const };
      const change = await this.#taskChange(workspace, job);
      if (change !== undefined) {
        await this.jobs.appendEvent(workspaceName, ticket, { ts: now(), iteration: job.iteration, type: 'task_changed', from: job.task_sha256 ?? null, to: change.sha256 });
      }
      let next: Job;
      if (pause.from === 'working') {
        next = await this.#transition(await this.#syncTask(workspace, job), 'working');
        const first = message.trim() !== '' ? message : next.session_id === null && next.iteration === 0 ? `/implement ${TASK_DIR}/${ticket}.md` : 'Continue where you stopped.';
        this.#session(next, workspace).send(factoryPrompt(this.#withChange(first, ticket, change), ticket, next.iteration + 1), DENIED_TOOLS);
      } else {
        // The reviewers read the new Task file in the worktree and its sha256 is recorded; task.md
        // keeps what the Implementer was last given, so its next prompt (a Fix section, sf say)
        // carries the diff.
        const content = await this.#copyTask(workspace, job);
        next = await this.#transition(content === undefined ? job : await this.#recordTask(job, content), 'awaiting_review');
        await this.#pickUp(next);
      }
      return { state: next.state, iteration: next.iteration, step: pause.step, task_changed: change !== undefined };
    });
  }

  // Whether the ticket's Task file changed since the Implementer was last given it (the job's copy,
  // else the worktree's), and its diff; undefined when it did not, or when nothing tells.
  async #taskChange(workspace: Workspace, job: Job): Promise<{ diff: string | undefined; sha256: string } | undefined> {
    const current = await readTask(workspace, job.ticket);
    const sha256 = taskSha256(current);
    const before = (await this.jobs.readTaskCopy(job.workspace, job.ticket))
      ?? (job.worktree !== null ? await readFile(join(job.worktree, TASK_DIR, `${job.ticket}.md`), 'utf8').catch(() => undefined) : undefined);
    if (before === undefined) {
      return job.task_sha256 !== undefined && job.task_sha256 !== sha256 ? { diff: undefined, sha256 } : undefined;
    }
    return before === current ? undefined : { diff: await taskDiff(job.ticket, before, current), sha256 };
  }

  // sf restart (SF-067): the ticket starts again from its current Task file, as a new job on a fresh
  // worktree and branch from the Task's base, for a job that is paused, aborted, failed or needs the
  // user. The old job is retired as reset does (its runner stopped, its worktree removed, its
  // directory archived), and its branch deleted, only when it has no commit beyond the job's base
  // and was never pushed; otherwise nothing is touched and the restart is refused with the reason
  // (restart_refused). keepFiles: the old worktree's changed and new files go into the new worktree
  // before the first turn, whose prompt says so.
  async restart(workspaceName: string, ticket: string, keepFiles = false): Promise<{ branch: string; state: JobState; check_after_minutes: number; worktree: string; archived: string; branch_deleted: string | null; kept: string[] }> {
    const { claimed, kept, archived, deleted } = await this.#locked(async () => {
      const old = await this.#job(workspaceName, ticket);
      checkNotInCheckout(old);
      if (!RESTARTABLE_STATES.includes(old.state)) {
        throw new FactoryError('invalid_state', `sf restart needs paused, aborted, failed or needs_human; the job is ${old.state}.`);
      }
      const workspace = await this.#resolve(workspaceName);
      const checkout = workspace.workCheckout;
      const plan = await this.#plan(workspace, ticket);
      await this.#checkSlot(workspaceName, ticket);
      // Checked before anything changes, and again below, in the Git lock that deletes the branch,
      // once the runner has stopped: nothing can add a commit between that check and the deletion.
      const branchCheck = async (): Promise<boolean> => {
        const oldExists = await this.#restartableBranch(checkout, old);
        if (plan.branch !== old.branch && (await runGit(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`])).code === 0) {
          throw new FactoryError('branch_exists', `The branch ${plan.branch} of the current Task file already exists in the checkout.`);
        }
        return oldExists;
      };
      await this.#gitLocked(workspaceName, branchCheck);
      await this.#endSession(workspaceName, ticket);
      const worktree = old.worktree ?? this.#worktreePath(workspaceName, ticket);
      let saved: Kept | undefined;
      if (keepFiles && old.base_commit !== null && (await exists(worktree))) {
        await mkdir(join(this.#config.stateDir, 'tmp'), { recursive: true, mode: 0o700 });
        const dir = await mkdtemp(join(this.#config.stateDir, 'tmp', `restart-${ticket}-`));
        saved = { dir, paths: await saveKept(worktree, old.base_commit, dir) };
      }
      // Once the old worktree is gone, the saved files are the only copy: they stay on a failure.
      let removed = false;
      const keptNote = (): string => (removed && saved !== undefined && saved.paths.length > 0 ? ` The files kept from the old worktree are in ${saved.dir}.` : '');
      try {
        const { deleteOld, failure } = await this.#gitLocked(workspaceName, async () => {
          const deleting = await branchCheck();
          const notRemoved = await removeWorktree(checkout, worktree);
          if (notRemoved !== undefined) {
            return { deleteOld: deleting, failure: `${notRemoved} Nothing else was changed; the job is ${old.state}.` };
          }
          removed = true;
          const notDeleted = deleting ? await deleteBranch(checkout, old.branch) : undefined;
          return { deleteOld: deleting, failure: notDeleted === undefined ? undefined : `${notDeleted} The old worktree was removed; the branch and the job (${old.state}) are as they were.` };
        });
        if (failure !== undefined) {
          throw new FactoryError('restart_failed', failure);
        }
        const name = await this.jobs.archive(workspaceName, ticket);
        return { claimed: await this.#claim(workspace, ticket, plan), kept: saved, archived: `jobs/${workspaceName}/${name}`, deleted: deleteOld ? old.branch : null };
      } catch (error) {
        if (saved !== undefined && !removed) {
          await rm(saved.dir, { recursive: true, force: true });
        }
        if (error instanceof FactoryError && keptNote() !== '') {
          throw new FactoryError(error.code, `${error.message}${keptNote()}`);
        }
        throw error;
      }
    });
    const started = await this.#launch(claimed, kept);
    return { ...started, archived, branch_deleted: deleted, kept: kept?.paths ?? [] };
  }

  // Whether the old job's branch is to be deleted at restart: false when the checkout has no such
  // branch; true when it has no commit beyond the job's base commit and was never pushed (no
  // merge request, no upstream, no remote-tracking branch, on no configured remote); refused otherwise
  // (restart_refused, with the reason). Only under the workspace's Git lock.
  async #restartableBranch(checkout: string, job: Job): Promise<boolean> {
    const ref = `refs/heads/${job.branch}`;
    if ((await runGit(checkout, ['rev-parse', '--verify', '--quiet', ref])).code !== 0) {
      return false;
    }
    const refuse = (reason: string): FactoryError => new FactoryError('restart_refused', `The restart was refused: ${reason}. Nothing was changed.`);
    if (job.base_commit === null) {
      throw refuse(`the branch ${job.branch} exists, but the job never created it (it has no base commit); rename or delete it by hand`);
    }
    const count = await runGit(checkout, ['rev-list', '--count', `${job.base_commit}..${ref}`]);
    const commits = Number(count.stdout.toString('utf8').trim());
    if (count.code !== 0 || !Number.isInteger(commits)) {
      throw refuse(`the commits of ${job.branch} beyond the base could not be counted (${count.stderr.trim().slice(0, 300)})`);
    }
    if (commits > 0) {
      throw refuse(`the branch ${job.branch} has ${commits} commit(s) beyond the base; push or delete it by hand first`);
    }
    if (job.mr !== null) {
      throw refuse(`the branch ${job.branch} has a merge request (#${job.mr.number})`);
    }
    const upstream = await runGit(checkout, ['config', '--get', `branch.${job.branch}.remote`]);
    if (upstream.code === 0 && upstream.stdout.toString('utf8').trim() !== '') {
      throw refuse(`the branch ${job.branch} has an upstream (${upstream.stdout.toString('utf8').trim()}): it was pushed`);
    }
    const tracking = (await runGit(checkout, ['for-each-ref', '--format=%(refname)', 'refs/remotes/'])).stdout.toString('utf8').split('\n')
      .filter((name) => name.endsWith(`/${job.branch}`));
    if (tracking.length > 0) {
      throw refuse(`the branch ${job.branch} was pushed (${tracking.map((name) => name.replace(/^refs\/remotes\//, '')).join(', ')})`);
    }
    // Every configured remote is asked (SF-067, R2): a push needs no upstream and no fetched
    // remote-tracking branch. One that cannot answer refuses: the branch may be on it.
    const remotes = await runGit(checkout, ['remote']);
    if (remotes.code !== 0) {
      throw refuse(`the remotes of the checkout could not be listed (${remotes.stderr.trim().slice(0, 300)})`);
    }
    for (const name of remotes.stdout.toString('utf8').split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
      const remote = await runGit(checkout, ['ls-remote', '--heads', name, ref], 64 * 1024, LS_REMOTE_TIMEOUT_MS);
      if (remote.code !== 0) {
        throw refuse(`the remote ${name} could not be asked whether ${job.branch} was pushed (${remote.code === null ? `no answer within ${LS_REMOTE_TIMEOUT_MS / 1000} s` : remote.stderr.trim().slice(0, 300)})`);
      }
      if (remote.stdout.toString('utf8').trim() !== '') {
        throw refuse(`the branch ${job.branch} is on the remote ${name}: it was pushed`);
      }
    }
    return true;
  }

  // Stops the job's runner, which ends its session and cancels its review, whose outcome is then
  // never applied.
  async #endSession(workspace: string, ticket: string): Promise<void> {
    const key = `${workspace}/${ticket}`;
    this.#cancelReview(key);
    const live = this.#live.get(key);
    this.#live.delete(key);
    await live?.session.close();
    await this.#runners?.stop(workspace, ticket);
  }

  // The worktree and the branch go; the checkout is not touched.
  async #discard(checkout: string, job: Job, worktree: string | null): Promise<{ code: string; message: string } | undefined> {
    if (worktree !== null) {
      const removed = await removeWorktree(checkout, worktree);
      if (removed !== undefined) {
        return { code: 'discard_failed', message: `${removed} The worktree needs a look.` };
      }
    }
    const deleted = await deleteBranch(checkout, job.branch);
    if (deleted !== undefined) {
      return { code: 'discard_failed', message: `${deleted} The checkout needs a look.` };
    }
    return undefined;
  }

  // The escape hatch: in any state, ends the session, removes the worktree and archives the job;
  // the branch is not touched.
  // A job whose workspace is no longer registered (or whose checkout is gone) is still archived:
  // only the Git clean-up of the checkout is skipped, and the result says so.
  reset(workspaceName: string, ticket: string): Promise<Retired> {
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      checkNotInCheckout(job);
      return this.#retire(job);
    });
  }

  // The dashboard's Archive of a job card: reset, for a finished job only. The state is checked
  // and the job retired in one lock acquisition, so a job that replaced it is refused, never
  // retired.
  archiveFinished(workspaceName: string, ticket: string): Promise<Retired> {
    return this.#locked(async () => this.#retire(await this.#finishedJob(workspaceName, ticket, 'invalid_state')));
  }

  // The ticket's current job, refused unless it is terminal, with the code (and the message) of
  // the caller: invalid_state for the job card, job_active for a ticket action. Only under the lock.
  async #finishedJob(workspaceName: string, ticket: string, code: 'invalid_state' | 'job_active'): Promise<Job> {
    const job = await this.#job(workspaceName, ticket);
    if (!TERMINAL_STATES.includes(job.state)) {
      const message = code === 'invalid_state'
        ? `Only a finished job can be archived; the job is ${job.state}. Abort it first.`
        : `The job for ${workspaceName}/${ticket} is ${job.state}; abort it first.`;
      throw new FactoryError(code, message);
    }
    return job;
  }

  // Ends the session, removes the worktree (best effort, logged) and archives the job directory;
  // the branch is not touched. Only under the lock, with the job read under the same acquisition.
  async #retire(job: Job): Promise<Retired> {
    const { workspace: workspaceName, ticket } = job;
    const key = `${workspaceName}/${ticket}`;
    const live = this.#live.get(key);
    let workspace: Workspace | undefined = live?.workspace;
    if (workspace === undefined) {
      try {
        workspace = await this.#resolve(workspaceName);
      } catch (error) {
        if (!(error instanceof FactoryError) || (error.code !== 'workspace_not_found' && error.code !== 'workspace_invalid')) {
          throw error;
        }
      }
    }
    await this.#endSession(workspaceName, ticket);
    if (workspace !== undefined) {
      const checkout = workspace.workCheckout;
      const worktree = job.worktree ?? this.#worktreePath(workspaceName, ticket);
      const failure = await this.#gitLocked(workspaceName, () => removeWorktree(checkout, worktree));
      if (failure !== undefined) {
        console.error(`${key}: ${failure}`);
      }
    }
    const archived = await this.jobs.archive(workspaceName, ticket);
    return { archived: `jobs/${workspaceName}/${archived}`, branch: job.branch, ...(workspace === undefined ? { checkout: 'unavailable' as const } : {}) };
  }

  async check(workspace: string, ticket: string, offset = 0, maxBytes = DEFAULT_PAGE_BYTES): Promise<CheckResult> {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxBytes) || maxBytes < MIN_PAGE_BYTES || maxBytes > MAX_PAGE_BYTES) {
      throw new FactoryError('invalid_range', `offset must be >= 0 and max_bytes ${MIN_PAGE_BYTES} to ${MAX_PAGE_BYTES}.`);
    }
    const job = await this.#job(workspace, ticket);
    const result: CheckResult = {
      state: job.state,
      iteration: job.iteration,
      branch: job.branch,
      since: job.updated_at,
      check_after_minutes: job.state === 'working' || job.state === 'preparing_mr' ? this.#checkAfter(job) : null,
      ...(job.error !== undefined ? { error: job.error } : {}),
    };
    // The last published Report and Patch, in every state but the ones where an iteration runs.
    if (job.iteration > 0 && job.state !== 'working' && job.state !== 'starting') {
      const { report, patch } = await this.jobs.readIteration(workspace, ticket, job.iteration);
      result.report = cutUtf8(report, MAX_REPORT_BYTES);
      result.patch = pageBuffer(patch, offset, maxBytes, 'the patch');
      const files = await this.#lastFiles(job);
      if (files !== undefined) {
        result.files = {
          sensitive: files.filter((change) => change.sensitive !== 'no').map((change) => ({ path: change.path, declared: change.sensitive === 'declared' })),
          deleted: files.filter((change) => change.status === 'deleted').map((change) => change.path),
        };
      }
    }
    const mr = await this.jobs.readMrText(workspace, ticket);
    if (mr !== undefined) {
      result.mr = cutUtf8(mr, MAX_REPORT_BYTES);
    }
    const review = await this.#reviewStatus(job);
    if (review !== undefined) {
      result.review = review;
    }
    return result;
  }

  // The review of the last published iteration: its record once it ended, running while it runs or
  // is due, off with SF_REVIEW=off; undefined before the first iteration and when none will run.
  // After a Claude verdict acted on as clean, gate is the gate's the same way; absent with the gate off.
  async #reviewStatus(job: Job): Promise<CheckResult['review']> {
    if (job.iteration === 0) {
      return undefined;
    }
    const running = this.#reviews.get(`${job.workspace}/${job.ticket}`);
    const record = await this.jobs.readReview(job.workspace, job.ticket, job.iteration);
    if (record !== undefined) {
      if (!('verdict' in record)) {
        return { status: 'failed', summary: record.error };
      }
      const done: CheckResult['review'] = { status: 'done', verdict: record.verdict, summary: record.summary };
      // Acted on as clean, the ledger's dropped items aside (as in #resumable): the gate follows.
      const gate = actedVerdict(withoutDropped(record)) === 'clean' ? await this.#gateStatus(job, running) : undefined;
      return gate !== undefined ? { ...done, gate } : done;
    }
    if (running?.reviewer === REVIEWER && running.iteration === job.iteration) {
      return { status: 'running' };
    }
    if (!this.#config.review) {
      return { status: 'off' };
    }
    return job.state === 'awaiting_review' ? { status: 'running' } : undefined;
  }

  // The gate's status for check, after a clean Claude verdict: like the review's, undefined with the
  // gate off and when none will run.
  async #gateStatus(job: Job, running: RunningReview | undefined): Promise<ReviewStatus | undefined> {
    const record = await this.jobs.readGate(job.workspace, job.ticket, job.iteration);
    if (record !== undefined) {
      return 'verdict' in record ? { status: 'done', verdict: record.verdict, summary: record.summary } : { status: 'failed', summary: record.error };
    }
    if (!this.#config.gate.on) {
      return undefined;
    }
    if (running?.reviewer === GATE_REVIEWER && running.iteration === job.iteration) {
      return { status: 'running' };
    }
    return job.state === 'awaiting_review' ? { status: 'running' } : undefined;
  }

  // After Clean the branch holds the one commit: a further fix or message works on in the worktree,
  // which is kept until the push (SF-073), or recreates it from the branch when it is gone; the next
  // Clean commits the whole change again as one commit.
  async #reopen(job: Job, workspace: Workspace): Promise<Job> {
    const worktree = job.worktree ?? this.#worktreePath(job.workspace, job.ticket);
    await this.#gitLocked(job.workspace, () => attachWorktree(workspace.workCheckout, worktree, job.branch));
    const next: Job = { ...job, worktree, prepared_commit: null };
    await this.jobs.write(next);
    return next;
  }

  requestFix(workspaceName: string, ticket: string, content: string): Promise<{ iteration: number; check_after_minutes: number }> {
    return this.#request(workspaceName, ticket, { kind: 'fix', content }) as Promise<{ iteration: number; check_after_minutes: number }>;
  }

  // A Fix section needs a job awaiting review or in human review.
  #checkFix(job: Job): void {
    checkNotInCheckout(job);
    if (job.state !== 'awaiting_review' && job.state !== 'ready_for_human_review') {
      throw new FactoryError('invalid_state', `request_fix needs awaiting_review or ready_for_human_review; the job is ${job.state}.`);
    }
  }

  // The work of request_fix, also run for a fix verdict of the review: appends ## Fix N and starts
  // the next iteration. SF_MAX_ITERATIONS limits the Fix sections; an sf say turn does not count.
  // counts: what else the Fix counts for (the gate's gate_fixes). Only under the lock.
  // ledger: the findings ledger with the section's items (SF-052), written once the section is.
  // fromStop: the Fix of the user's settlement or Simplify (SF-055), from needs_human.
  // title: the section's title after its number (## Fix N: Simplify).
  // overLimit: written even at SF_MAX_ITERATIONS (Simplify, once per job).
  async #fix(current: Job, content: string, options: FixOptions = {}): Promise<{ iteration: number; check_after_minutes: number }> {
    const { counts = {}, ledger, fromStop = false, title, overLimit = false } = options;
    let job = current;
    const { workspace: workspaceName, ticket } = job;
    if (!(fromStop && job.state === 'needs_human')) {
      this.#checkFix(job);
    }
    if (!overLimit && job.fixes >= this.#config.maxIterations) {
      const message = `${job.fixes} Fix sections were written, the limit of SF_MAX_ITERATIONS`;
      await this.#transition(job, 'needs_human', { code: 'iteration_limit', message: `${message}; the user decides how to go on.` });
      throw new FactoryError('iteration_limit', `${message}; the job needs the user.`);
    }
    const workspace = await this.#resolve(workspaceName);
    // No turn while the user's checkout holds the branch (SF-073); nothing is written before.
    const free = job;
    await this.#gitLocked(workspaceName, () => checkBranchFree(workspace.workCheckout, free.worktree, free.branch, ticket));
    if (job.state === 'ready_for_human_review') {
      job = await this.#reopen(job, workspace);
    }
    const fix = job.iteration;
    // A change made while the job was paused, before the factory's own Fix section (SF-067).
    const change = job.task_sha256 === undefined || job.worktree === null ? undefined : await this.#taskChange(workspace, job);
    await appendFix(workspace, ticket, fix, content, title);
    if (ledger !== undefined) {
      await this.jobs.writeLedger(workspaceName, ticket, ledger);
    }
    job = await this.#syncTask(workspace, job);
    // A commit prepared before this turn is never pushed (SF-073).
    job = await this.#transition({ ...job, ...counts, fixes: job.fixes + 1, prepared_commit: null }, 'working');
    this.#session(job, workspace).send(factoryPrompt(this.#withChange(`/implement ${TASK_DIR}/${ticket}.md Fix ${fix}`, ticket, change), ticket, job.iteration + 1), DENIED_TOOLS);
    return { iteration: job.iteration + 1, check_after_minutes: this.#config.checkAfterFixMin };
  }

  // A user message into the session, queued as its next turn (in the runner's queue first, then,
  // while a turn runs, in the session's).
  say(workspaceName: string, ticket: string, message: string): Promise<{ state: JobState; queued: boolean }> {
    return this.#request(workspaceName, ticket, { kind: 'say', message }) as Promise<{ state: JobState; queued: boolean }>;
  }

  // sf say needs a job with a session to go on with and a non-empty text message.
  #checkSay(job: Job, message: string): void {
    // A step of the hand-over that was cut off is repaired by recover() first (SF-073).
    if (job.handover !== undefined && job.handover.step !== null) {
      throw cutOffError(job, job.handover.step);
    }
    if (!['working', 'awaiting_review', 'needs_human', 'ready_for_human_review', 'handed_over'].includes(job.state)) {
      throw new FactoryError('invalid_state', `sf say needs working, awaiting_review, needs_human, ready_for_human_review or handed_over; the job is ${job.state}.`);
    }
    if (job.state === 'handed_over') {
      this.#checkHandedOver(job, 'sf say');
    }
    if (message.trim() === '' || message.includes('\0')) {
      throw new FactoryError('invalid_content', 'The message must be non-empty text.');
    }
  }

  // The message in the runner.
  #say(workspaceName: string, ticket: string, message: string): Promise<{ state: JobState; queued: boolean }> {
    return this.#locked(async () => {
      let job = await this.#job(workspaceName, ticket);
      this.#checkSay(job, message);
      const workspace = this.#live.get(`${workspaceName}/${ticket}`)?.workspace ?? (await this.#resolve(workspaceName));
      if (job.state === 'handed_over') {
        // Ask for changes (SF-073): a free slot, then the checkout's state back into the job.
        await this.#checkSlot(workspaceName, ticket);
        job = await this.#askForChanges(job, workspace);
      }
      // No turn while the user's checkout holds the branch (SF-073), before anything else is written.
      const free = job;
      await this.#gitLocked(workspaceName, () => checkBranchFree(workspace.workCheckout, free.worktree, free.branch, ticket));
      if (job.state === 'ready_for_human_review') {
        job = await this.#reopen(job, workspace);
      }
      // A commit prepared before this turn is never pushed (SF-073).
      if (job.prepared_commit !== null) {
        job = { ...job, prepared_commit: null };
        await this.jobs.write(job);
      }
      if (job.worktree === null || !(await exists(job.worktree))) {
        throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
      }
      const session = this.#session(job, workspace);
      const queued = session.busy;
      // A change made while the job was paused and not handed on yet (SF-067).
      const change = job.task_sha256 === undefined ? undefined : await this.#taskChange(workspace, job);
      job = await this.#syncTask(workspace, job);
      if (job.state !== 'working') {
        job = await this.#transition(job, 'working');
      }
      session.send(factoryPrompt(this.#withChange(message, ticket, change), ticket, job.iteration + 1), DENIED_TOOLS);
      return { state: job.state, queued };
    });
  }

  // Ask for changes on a handed-over job (SF-073), in the runner before the turn, under the
  // workspace's Git lock: the checkout's state goes into refs/factory/<ticket>-ask and the job's
  // worktree, and the checkout gives the branch back. A refusal before the switch (checkout_moved,
  // checkout_busy, checkout_changing, handover_refused) leaves everything as it was; a failure after
  // it is finished from the snapshot once more, else the job needs the user (ask_interrupted) and
  // recover() finishes it. Returns the job without the record, with its worktree. Only under the lock.
  async #askForChanges(job: Job, workspace: Workspace): Promise<Job> {
    const handover = this.#checkHandedOver(job, 'sf say');
    const checkout = workspace.workCheckout;
    const worktree = job.worktree ?? this.#worktreePath(job.workspace, job.ticket);
    let current = job;
    const record = async (next: Handover): Promise<void> => {
      current = { ...current, handover: next };
      await this.jobs.write(current);
    };
    let kept: string[];
    try {
      ({ kept } = await this.#gitLocked(job.workspace, () => askForChanges({ checkout, worktree, ticket: job.ticket, handover, record })));
    } catch (error) {
      const recorded = current.handover;
      if (recorded?.step !== 'asking' || (error instanceof FactoryError && error.code === 'checkout_changing')) {
        if (recorded?.step === 'asking') {
          await this.jobs.write({ ...current, handover });
        }
        throw error;
      }
      try {
        ({ kept } = await this.#gitLocked(job.workspace, () => finishAsk(checkout, worktree, job.ticket, recorded)));
      } catch (again) {
        console.error(again);
        const message = `Ask for changes failed after your checkout was saved as refs/factory/${job.ticket}-ask (${(error as Error).message.slice(0, 300)}); sf serve finishes it when it starts again.`;
        await this.#transition({ ...current, prepared_commit: null }, 'needs_human', { code: 'ask_interrupted', message });
        throw new FactoryError('ask_interrupted', message);
      }
    }
    if (kept.length > 0) {
      await this.#handoverNote(current, `Ask for changes left these files in your checkout, changed after the snapshot: ${kept.join(', ')}.`);
    }
    return { ...(await this.#endHandover(current)), worktree, prepared_commit: null };
  }

  // sf serve's side of a request: under the lock (so approve, abort and reset see it queued), the
  // state is checked first, so a request the runner would refuse starts no runner, and the request
  // is queued; then the runner's reply, outside the lock, is the result. The runner checks again
  // when it applies the request.
  async #request(workspaceName: string, ticket: string, request: Exclude<RunnerRequest, { kind: 'turn' }>): Promise<unknown> {
    const id = await this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      this.#check(job, request);
      // Ask for changes takes a slot of SF_MAX_JOBS again (SF-073), as Resume does.
      if (request.kind === 'say' && job.state === 'handed_over') {
        await this.#checkSlot(workspaceName, ticket);
      }
      return this.#serveRunners().queue(workspaceName, ticket, request);
    });
    return this.#serveRunners().reply(workspaceName, ticket, id);
  }

  // The state checks of a request, the same in sf serve and in the runner.
  #check(job: Job, request: Exclude<RunnerRequest, { kind: 'turn' }>): void {
    switch (request.kind) {
      case 'say':
        this.#checkSay(job, request.message);
        break;
      case 'fix':
        this.#checkFix(job);
        break;
      case 'clean':
        this.#checkPrepareMr(job);
        break;
      case 'review':
        this.#checkRetryReview(job);
        break;
      case 'accept':
        this.#checkAcceptGate(job);
        break;
      case 'settle':
        this.#checkSettle(job, request.id, request.decision, request.note);
        break;
      case 'simplify':
        this.#checkSimplify(job);
        break;
      case 'resume':
        this.#checkResume(job, request.message);
        break;
    }
  }

  // Runner mode: applies one request of sf serve to the job.
  apply(request: RunnerRequest): Promise<unknown> {
    const { workspace, ticket } = this.#runnerJob();
    switch (request.kind) {
      case 'turn':
        return this.#locked(async () => {
          const job = await this.#job(workspace, ticket);
          if (job.state !== 'working') {
            throw new FactoryError('invalid_state', `The first turn needs working; the job is ${job.state}.`);
          }
          this.#session(job, await this.#resolve(workspace)).send(request.prompt, DENIED_TOOLS);
          return {};
        });
      case 'say':
        return this.#say(workspace, ticket, request.message);
      case 'fix':
        return this.#locked(async () => this.#fix(await this.#job(workspace, ticket), request.content));
      case 'clean':
        return this.#locked(async () => this.#prepareMr(await this.#job(workspace, ticket), request.sensitive));
      case 'review':
        return this.#retryReview(workspace, ticket);
      case 'accept':
        return this.#acceptGate(workspace, ticket);
      case 'settle':
        return this.#settle(workspace, ticket, request.id, request.decision, request.note);
      case 'simplify':
        return this.#applySimplify(workspace, ticket);
      case 'resume':
        return this.#resumePaused(workspace, ticket, request.message);
    }
  }

  // Runner mode: what the job was doing when its last runner ended. A job awaiting review whose
  // last iteration has no review gets one; one whose review is clean and has no gate.json gets its
  // gate (or, with the gate off now, Clean); one with a clean gate.json too gets its simplification
  // pass, or its outcome (SF-055).
  resume(): Promise<void> {
    const { workspace, ticket } = this.#runnerJob();
    return this.#locked(async () => {
      const job = await this.jobs.read(workspace, ticket);
      if (job !== undefined) {
        await this.#pickUp(job);
      }
    });
  }

  // The review round a job awaiting review has to run (the review, the gate, the simplification
  // pass or its outcome), unless one runs already. Only under the lock.
  async #pickUp(job: Job): Promise<void> {
    const { workspace, ticket } = job;
    if (this.#reviews.has(`${workspace}/${ticket}`) || !(await this.#resumable(job))) {
      return;
    }
    const review = await this.jobs.readReview(workspace, ticket, job.iteration);
    const gate = await this.jobs.readGate(workspace, ticket, job.iteration);
    if (review === undefined) {
      this.#startReview(job);
    } else if ('verdict' in review && gate !== undefined && 'verdict' in gate) {
      // A clean gate whose simplification pass never applied (SF-055).
      await this.#applying(job, () => this.#afterClean(job, [...new Set([...review.accepted_sensitive, ...gate.accepted_sensitive])]));
    } else if ('verdict' in review) {
      await this.#applying(job, () => this.#afterClaude(job, review));
    }
  }

  // Runner mode: no turn runs or waits, no review or gate runs, no state change is in progress.
  get idle(): boolean {
    return this.#pending === 0 && this.#reviews.size === 0 && ![...this.#live.values()].some((live) => live.session.busy);
  }

  // Runner mode, on SIGTERM (abort, reset): the turn, the review and the gate end and their outcome
  // is never applied; resolves once the state change in progress, if any, is written.
  async stop(): Promise<void> {
    this.#stopping = true;
    for (const key of [...this.#reviews.keys()]) {
      this.#cancelReview(key);
    }
    const sessions = [...this.#live.values()].map((live) => live.session);
    this.#live.clear();
    await Promise.all(sessions.map((session) => session.close()));
    await this.#locked(async () => undefined);
  }

  async status(workspace?: string, ticket?: string): Promise<Job[]> {
    if (workspace !== undefined && ticket !== undefined) {
      return [await this.#job(workspace, ticket)];
    }
    return this.jobs.list();
  }
}
