// What more than one part of the job lifecycle uses (SF-089, from src/execution.ts): constants,
// helpers, the internal types, and the types and functions src/execution.ts exports.
import { stat } from 'node:fs/promises';
import { FactoryError } from '../errors.js';
import { GATE_REVIEWER } from '../gate.js';
import type { Job, JobMr, JobState, JobStore, PauseStep } from '../jobs.js';
import { SIMPLIFIER, SCOPE_PROBLEM, SENSITIVE_PROBLEM } from '../ledger.js';
import type { Workspace } from '../registry.js';
import type { Page } from '../repo-files.js';
import { REVIEWER, type ReviewItem } from '../review.js';
import type { Launch } from '../runner.js';
import { ImplementerSession } from '../session.js';
import { TASK_DIR } from '../task-file.js';
import { TESTS_UNAVAILABLE } from '../test-command.js';

// The reviewer name of the run of a workspace's test command among the running reviews (SF-128).
export const TESTS_RUNNER = 'tests';

export const MAX_REPORT_BYTES = 64 * 1024;

const MAX_SLUG = 40;

// The codes of a job the gate handed to the user, which sf accept may take on to MR preparation.
export const GATE_OVERRIDE_CODES: readonly string[] = ['gate_rounds', 'gate_budget', 'gate_failed'];

// The ledger's stops (SF-052) that sf accept takes on as well, with a clean Claude review.
export const LEDGER_ACCEPT_CODES: readonly string[] = ['review_churn', 'review_disputed'];

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
export interface MrContent {
  title: string;
  body: string;
}

// The needs_human codes of a transient stop of MR preparation after the deciding clean verdict and
// before the branch is prepared (SF-087): sf retry runs MR preparation again, without a new review.
// Not after a conflict turn (mr_conflict_turn): its resolution is code no reviewer saw.
// The guard's stops of MR preparation (SF-122) too: after a "!" line in guard-terms.txt, for example.
// And a test command that could not run (SF-128): Retry runs it again.
export const MR_RETRY_CODES: readonly string[] = ['fetch_failed', 'mr_serve_restarted', 'mr_interrupted', 'mr_commit_failed', 'mr_rebase_failed', 'mr_failed', 'guard_hit', 'guard_terms_invalid', 'guard_failed', TESTS_UNAVAILABLE];

// A Save of the Merge request screen (SF-080): the title, the body and, when they change, the
// branch and the base.
export interface MrInput {
  title: string;
  body: string;
  branch?: string;
  base?: string;
}

// The Merge request screen's view of a job's MR text (SF-080, GET mr-view).
export interface MrView {
  title: string;
  body: string;
  factory: { title: string; body: string };
  edited: boolean;
  edited_at: string | null;
  factory_new_at: string | null;
  branch: string;
  base: string;
  branch_editable: boolean;
  branch_reason: string | null;
  base_editable: boolean;
  base_reason: string | null;
  problems: Array<{ field: 'title' | 'body' | 'branch' | 'base'; message: string }>;
  pushed: boolean;
  pushed_at: string | null;
  editable: boolean;
  readonly_reason: string | null;
  target: { host: string | null; repository: string | null };
  rules: { commit_types: string[]; max_header_chars: number; required_headings: string[]; manual_claim: { source: string; flags: string } };
  commit: { title: string; body: string } | null;
  commit_differs: boolean;
}

// What a Save or Reset of the MR text left (SF-080).
export interface MrSaved {
  state: JobState;
  branch: string;
  base: string;
  edited: boolean;
  prepared_commit: string | null;
}

// An error as an outcome's {code, message}; anything but a FactoryError is logged and kept generic.
export function mrFailure(error: unknown): { code: string; message: string } {
  if (error instanceof FactoryError) {
    return { code: error.code, message: error.message };
  }
  console.error(error);
  return { code: 'internal_error', message: 'The merge request failed inside the factory.' };
}

// The paths of the factory's fix items (src/review.ts, unacceptedItems) by kind, each with its
// label: the undeclared sensitive paths, then the paths outside the Task's scope (SF-053).
export function markedGroups(items: ReviewItem[]): Array<{ label: string; paths: string[] }> {
  return [
    { label: 'undeclared sensitive path(s)', problem: SENSITIVE_PROBLEM },
    { label: "path(s) outside the Task's scope", problem: SCOPE_PROBLEM },
  ].map(({ label, problem }) => ({ label, paths: items.filter((item) => item.problem === problem).map((item) => item.path) }))
    .filter((group) => group.paths.length > 0);
}

// A review record without the items the ledger dropped (SF-052), compared as written.
export function withoutDropped(record: { items: ReviewItem[]; dropped?: ReviewItem[] }): { items: ReviewItem[] } {
  const dropped = new Set((record.dropped ?? []).map((item) => JSON.stringify(item)));
  return { items: record.items.filter((item) => !dropped.has(JSON.stringify(item))) };
}

// The refusal of an action a handed-over job does not take before Take it back (SF-073).
function handedOverError(job: Job): FactoryError {
  return new FactoryError('handed_over', `${job.ticket} is in your checkout on ${job.branch}; take it back first.`);
}

// The refusal of the actions that need the branch back from the user's checkout (SF-073): a
// handed-over job, or one whose hand-over step was cut off and waits for recover().
export function checkNotInCheckout(job: Job): void {
  if (job.state === 'handed_over') {
    throw handedOverError(job);
  }
  if (job.handover !== undefined && job.handover.step !== null) {
    throw cutOffError(job, job.handover.step);
  }
}

// The refusal of an action on a job whose hand-over step was cut off (SF-073): recover() repairs it.
export function cutOffError(job: Job, step: string): FactoryError {
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

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Whether the job's last iteration skipped the gate by its gate level (SF-092): its gate-level.json
// says ran: false. Then the gate counts as absent, as with the gate off (the gate's status, the step
// a pause interrupts). A file that cannot be read counts as no decision.
export async function gateSkipped(jobs: JobStore, job: Job): Promise<boolean> {
  try {
    return (await jobs.readGateLevel(job.workspace, job.ticket, job.iteration))?.ran === false;
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

// The line of a Resume's prompt when the Task's images changed while the job was paused (SF-065).
export function imagesChangedNote(names: readonly string[]): string {
  return `The Task's images changed while the job was paused: ${names.join(', ')}.`;
}

// How many kept files the first prompt names.
const MAX_KEPT_NAMED = 50;

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

// The first prompt of a job: /implement of its Task file, then the job's <rules> block when it has
// one (SF-059); after sf restart --keep-files (SF-067), with the files kept from the previous job.
export function firstPrompt(ticket: string, kept: string[], rules = ''): string {
  const command = [`/implement ${TASK_DIR}/${ticket}.md`, ...(rules !== '' ? ['', rules.trimEnd()] : [])].join('\n');
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

export interface Live {
  workspace: Workspace;
  session: ImplementerSession;
  // The session's cwd: the job's worktree.
  cwd: string;
  // During MR preparation: the target's ref name, the files of a stopped rebase while the
  // conflict turn runs, and the MR text turns the guard asked for (SF-122; absent: 0).
  mr?: { targetRef: string; conflicts?: string[]; guardTurns?: number };
}

// A review in progress, Claude's, the gate's or the simplification pass, or the run of the
// workspace's test command (SF-128: tests), one at a time per job: the iteration it reviews and
// what cancels it.
export interface RunningReview {
  reviewer: typeof REVIEWER | typeof GATE_REVIEWER | typeof SIMPLIFIER | typeof TESTS_RUNNER;
  iteration: number;
  controller: AbortController;
}

export interface ExecutionOptions {
  // Runner mode (sf run): the one job this Execution runs. Without it the Execution is sf serve's,
  // which runs no turn and no review itself.
  runner?: { workspace: string; ticket: string };
  // How sf serve starts a runner; the default spawns `sf run`.
  launch?: Launch;
  // The /proc directory the sandbox's config lock check scans (LockScan.proc, SF-105); the real
  // /proc without it. Only tests give another (SF_TEST_PROC_DIR under SF_TEST_HOOKS=on).
  lockProc?: string;
}
