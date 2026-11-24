// Job state on disk: <state dir>/jobs/<workspace>/<ticket>/ with job.json, events.jsonl and
// iterations/NNN/{report.md,patch.diff,meta.json,review.json,gate.json,gate-level.json,gate-override.json,simplify.json,last-review.json} (plus the
// gate's schema and output files, and tree), ledger.json (the findings ledger) from the first Fix section on, task.md
// (the Task file as the Implementer was last given it), from MR preparation on mr.md (and mr-factory.md once the user
// edited it), tests-<N>.json (a run of the workspace's test command on iteration N), planner-suggestion.json (the
// planner's pending note while the job waits for the user, src/planner.ts), planner-send.json (while
// a Send of that note runs), last-review-skill/ and last-review-skill.json (the last review's copy of its skill,
// src/last-review.ts), and objects/. Strictly parsed;
// every file but the event log is replaced atomically. Knows nothing about the Implementer session, nor about Git:
// tree and objects/ are only named here, src/changes.ts writes them.
import { appendFile, type FileHandle, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic, writeFileAtomicWith } from './atomic.js';
import { FactoryError } from './errors.js';
import { GATE_LEVELS, type GateLevel } from './gate-level.js';
import type { LastReviewRecord, SkillCopy } from './last-review.js';
import { type LedgerEntry, ledgerSchema } from './ledger.js';
import type { ReviewItem, ReviewMethod } from './review.js';
import { quickFixSchema } from './quick-fix.js';
import { cleanSchema, type IterationDelta } from './review-delta.js';
import type { Suggestion } from './simplify.js';
import type { TestsOutcome, TestsRecord } from './test-command.js';

export const JOB_STATES = ['starting', 'working', 'awaiting_review', 'needs_human', 'paused', 'waiting_limit', 'ready_for_human_review',
  'handed_over', 'preparing_mr', 'pushed', 'aborted', 'failed'] as const;
export type JobState = (typeof JOB_STATES)[number];
// The traits of a job state, each the name of a set of states (statesWith gives it, in JOB_STATES order):
//   active: the session may be alive; nothing of a paused job runs, a handed_over job's changes wait in the user's checkout.
//   running: counts against the run queue's limit max_running in every workspace: works, is reviewed, or holds its slot on a usage limit.
//   terminal: a new job for the same ticket may start.
//   pausable: sf pause takes it (and it is the paused job's paused.from).
//   restartable: sf restart takes it: the job waits for the user or has ended, not pushed, or is parked on a usage limit.
//   resumable: sf resume takes it.
//   sayable: it takes a message (sf say).
//   notified: a job that reaches it notifies the user (src/notify.ts).
//   waiting: the job waits for the user (src/stats.ts).
//   ready: the job reached the user's review (src/stats.ts).
//   delivered: the job's change reached the user, pushed or in their checkout (src/stats.ts).
//   sandboxed: a session of the job may run under Claude Code's sandbox: its runner runs (src/health.ts, src/execution/handover-steps.ts).
//   idle: for sf update's drain, nothing of the job runs or is about to.
//   busy: for sf update's drain, it must not exist right before the pull.
//   past_reviews: for the live smoke, past the reviews: a job there without a review (or gate) record will not get one.
//   stopped: for the live smoke, the job stopped: the step it was on fails.
type Trait = 'active' | 'running' | 'terminal' | 'pausable' | 'restartable' | 'resumable' | 'sayable' | 'notified' | 'waiting' | 'ready' | 'delivered'
  | 'sandboxed' | 'idle' | 'busy' | 'past_reviews' | 'stopped';
export const STATE_TRAITS: Readonly<Record<JobState, readonly Trait[]>> = {
  starting: ['active', 'running', 'busy'],
  working: ['active', 'running', 'pausable', 'sayable', 'sandboxed', 'busy'],
  awaiting_review: ['active', 'running', 'pausable', 'sayable', 'sandboxed', 'busy'],
  needs_human: ['active', 'restartable', 'sayable', 'notified', 'waiting', 'idle', 'stopped'],
  // The user paused the job: nothing runs; sf resume goes on where it stopped.
  paused: ['restartable', 'resumable', 'notified', 'idle'],
  // A session hit the plan's usage limit: parked, the job keeps its slot; the run queue resumes it when the limit
  // resets, or sf resume does now.
  waiting_limit: ['running', 'restartable', 'resumable', 'notified', 'idle'],
  ready_for_human_review: ['active', 'sayable', 'notified', 'waiting', 'ready', 'idle', 'past_reviews'],
  // The job's changes are in the workspace's checkout on its branch: the user reviews them there.
  handed_over: ['sayable', 'notified', 'waiting', 'ready', 'delivered', 'idle'],
  preparing_mr: ['active', 'running', 'sandboxed', 'busy', 'past_reviews'],
  pushed: ['terminal', 'notified', 'delivered', 'idle', 'past_reviews'],
  aborted: ['terminal', 'restartable', 'idle', 'stopped'],
  failed: ['terminal', 'restartable', 'notified', 'idle', 'stopped'],
};
export const statesWith = (trait: Trait): readonly JobState[] => JOB_STATES.filter((state) => STATE_TRAITS[state].includes(trait));
export const ACTIVE_STATES = statesWith('active');
export const RUNNING_STATES = statesWith('running');
// The running jobs of every workspace (RUNNING_STATES): what the run queue's limit counts.
export const runningJobs = (jobs: Job[]): Job[] => jobs.filter((job) => RUNNING_STATES.includes(job.state));
export const TERMINAL_STATES = statesWith('terminal');
// A tuple for z.enum (paused.from); it equals statesWith('pausable'). PAUSE_STEPS: what was interrupted when the job was
// paused: the Implementer's turn, or a round of the Claude review, the gate or the simplification pass (none when nothing
// ran, as while awaiting review with the review off).
export const PAUSABLE_STATES = ['working', 'awaiting_review'] as const;
export const PAUSE_STEPS = ['turn', 'review', 'gate', 'simplify'] as const;
export type PauseStep = (typeof PAUSE_STEPS)[number];
export const RESTARTABLE_STATES = statesWith('restartable');
export const RESUMABLE_STATES = statesWith('resumable');
// How long a job parked on a usage limit without a parsed reset time waits before the run queue tries it again.
export const LIMIT_RETRY_MS = 30 * 60_000;

// The steps of src/execution/ that change a job's state, each named after the step, not
// after the error code: every needs_human stop of one step shares its action. The order is the
// order of the README's table.
export const JOB_ACTIONS = [
  'create', 'launch', 'recover', 'repair_handover', 'publish', 'mr_turn_end', 'review_retry', 'go_on', 'verdict', 'prepare_mr',
  // tests: the end of the run of the workspace's test command, a Tests Fix or a stop. mr_retry: the Retry's own stop when MR
  // preparation fails again before it began (retryMr). move: the move of a part onto its base, and its stop.
  'tests', 'mr_retry', 'ready', 'move', 'hand_over', 'take_back', 'push', 'pushed_by_user', 'marked_done', 'abort', 'pause', 'resume', 'park',
  'limit_reset', 'fix', 'say', 'ask_for_changes', 'quick_fix',
] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

// One allowed state change: from null only for the new record (create).
export interface JobTransition {
  readonly from: JobState | null;
  readonly to: JobState;
  readonly action: JobAction;
}

// The rows of action: every state of from to every state of to.
function rows(action: JobAction, from: readonly (JobState | null)[], to: readonly JobState[]): JobTransition[] {
  return from.flatMap((one) => to.map((target) => ({ from: one, to: target, action })));
}

// Every allowed state change: transition (src/execution/core.ts) and #claim (src/execution/start.ts) refuse any
// other. Each call site in src/execution/ names its from states in a comment, derived from its guards.
export const JOB_TRANSITIONS: readonly JobTransition[] = Object.freeze([
  ...rows('create', [null], ['starting']),
  ...rows('launch', ['starting'], ['working', 'failed']),
  ...rows('recover', ['working', 'preparing_mr'], ['needs_human']),
  ...rows('recover', ['starting'], ['failed']),
  // A cut-off step of the hand-over (handover.step) stays on the job through every later change
  // until recover() repairs it. handing_over is cut off in preparing_mr or ready_for_human_review,
  // and goes on only to needs_human (handover_interrupted, with a prepared commit) and aborted.
  // asking is cut off in handed_over and goes on to needs_human (ask_interrupted, without a prepared
  // commit), which the retry of MR preparation (checkPrepareMr) takes on, and from there to any
  // state but a new job's starting, failed and pushed (approve refuses a cut-off step).
  ...rows('repair_handover', JOB_STATES.filter((state) => !['starting', 'failed', 'pushed'].includes(state)), ['needs_human']),
  ...rows('repair_handover', ['needs_human', 'ready_for_human_review', 'preparing_mr', 'aborted'], ['ready_for_human_review']),
  ...rows('publish', ['working'], ['awaiting_review', 'needs_human']),
  ...rows('mr_turn_end', ['preparing_mr', 'working'], ['awaiting_review', 'needs_human']), // working: a turn ending MR preparation's rebase
  ...rows('review_retry', ['needs_human'], ['awaiting_review']),
  ...rows('go_on', ['needs_human'], ['awaiting_review']),
  ...rows('verdict', ['awaiting_review'], ['needs_human']),
  ...rows('prepare_mr', ['awaiting_review', 'needs_human'], ['preparing_mr']),
  // The test step of MR preparation: a failure is a Tests Fix (working), the bound or a
  // run that could not happen a stop; a pass goes on in preparing_mr.
  ...rows('tests', ['preparing_mr'], ['working', 'needs_human']),
  ...rows('mr_retry', ['needs_human'], ['needs_human']),
  ...rows('ready', ['preparing_mr'], ['needs_human', 'ready_for_human_review', 'handed_over']),
  // The move of a part onto its base once the ticket it builds on is merged (src/builds-on.ts), and its stop.
  ...rows('move', ['ready_for_human_review', 'handed_over'], ['preparing_mr']),
  ...rows('move', ['preparing_mr'], ['needs_human']),
  ...rows('hand_over', ['ready_for_human_review'], ['needs_human', 'handed_over']),
  ...rows('take_back', ['handed_over'], ['ready_for_human_review']),
  ...rows('push', ['needs_human', 'ready_for_human_review', 'handed_over'], ['pushed']),
  ...rows('push', ['needs_human', 'ready_for_human_review'], ['needs_human']),
  ...rows('pushed_by_user', ['handed_over'], ['pushed']),
  // Merged — archive (or the pass of merged jobs) on a handed-over job: the user merged the changes; origin is not asked.
  ...rows('marked_done', ['handed_over'], ['pushed']),
  ...rows('abort', JOB_STATES.filter((state) => !TERMINAL_STATES.includes(state)), ['aborted']),
  ...rows('pause', ['working', 'awaiting_review'], ['paused']),
  ...rows('pause', ['preparing_mr'], ['needs_human']),
  ...rows('resume', ['paused', 'waiting_limit'], ['working', 'awaiting_review']),
  ...rows('park', ['working', 'awaiting_review'], ['waiting_limit']),
  ...rows('limit_reset', ['waiting_limit'], ['needs_human']),
  ...rows('fix', ['awaiting_review', 'needs_human', 'ready_for_human_review'], ['working', 'needs_human']),
  ...rows('say', ['awaiting_review', 'needs_human', 'ready_for_human_review', 'handed_over'], ['working']),
  ...rows('ask_for_changes', ['handed_over'], ['needs_human']),
  ...rows('quick_fix', ['ready_for_human_review', 'handed_over'], ['working']), // sf quickfix (src/quick-fix.ts)
].map((row) => Object.freeze(row)));

// Every refusal of checkTransition in this process; nothing clears it.
const refusals: JobTransition[] = [];

// The refusals of checkTransition in this process so far, oldest first.
export const refusedTransitions = (): JobTransition[] => refusals.map((row) => ({ ...row }));

// Refuses (illegal_transition) a state change that is not a row of JOB_TRANSITIONS, a bug of the
// factory: the refusal is recorded and written to stderr as one line, so a test sees it even where
// the error is caught.
export function checkTransition(from: JobState | null, to: JobState, action: JobAction): void {
  if (JOB_TRANSITIONS.some((row) => row.from === from && row.to === to && row.action === action)) {
    return;
  }
  refusals.push({ from, to, action });
  process.stderr.write(`illegal_transition: ${from} -> ${to} by ${action}\n`);
  throw new FactoryError('illegal_transition', `${from} -> ${to} by ${action} is not an allowed state change.`);
}

// JOB_TRANSITIONS as the README's Markdown table: the new record first, then by from, to (both in
// JOB_STATES order) and action (JOB_ACTIONS order).
export function renderTransitions(): string {
  const order = (state: JobState | null): number => (state === null ? -1 : JOB_STATES.indexOf(state));
  const sorted = [...JOB_TRANSITIONS].sort((a, b) =>
    order(a.from) - order(b.from) || order(a.to) - order(b.to) || JOB_ACTIONS.indexOf(a.action) - JOB_ACTIONS.indexOf(b.action));
  const lines = ['| From | To | Action |', '|---|---|---|'];
  for (const row of sorted) {
    lines.push(`| ${row.from === null ? '(new)' : `\`${row.from}\``} | \`${row.to}\` | \`${row.action}\` |`);
  }
  return `${lines.join('\n')}\n`;
}

const timestamp = z.iso.datetime();
const commit = z.string().regex(/^[0-9a-f]{40,64}$/);

// The steps of a hand-over that change the checkout; recorded before the change, so
// recover() can repair one that was cut off.
export const HANDOVER_STEPS = ['handing_over', 'asking'] as const;
// A job in the user's checkout: its branch, the job's commit S saved as
// refs/factory/<ticket>, the base B the branch was reset to, what the checkout was on before
// (a branch, or a detached commit), the user's untracked files from before (never touched), the
// local commit.template and commit.cleanup the factory replaced (null: unset), when it was handed
// over and when origin was last asked for the user's push; step while a change is in progress, and
// during Ask for changes the snapshot of the checkout (refs/factory/<ticket>-ask).
const handoverSchema = z.strictObject({
  branch: z.string().min(1),
  saved: commit,
  base: commit,
  previous: z.union([z.strictObject({ branch: z.string().min(1) }), z.strictObject({ commit })]),
  untracked: z.array(z.string()),
  template: z.string().nullable(),
  cleanup: z.string().nullable(),
  at: timestamp,
  checked_at: timestamp.nullable(),
  step: z.enum(HANDOVER_STEPS).nullable(),
  snapshot: commit.optional(),
});
export type Handover = z.output<typeof handoverSchema>;
const jobSchema = z.strictObject({
  workspace: z.string().min(1),
  ticket: z.string().min(1),
  branch: z.string().min(1),
  base: z.string().min(1),
  // The source branch of the open merge request the job continues (src/continues.ts); null for most.
  continues: z.string().min(1).nullable().default(null),
  // The ticket of the same workspace whose unmerged change the job builds on (src/builds-on.ts),
  // and the prepared commit of that ticket the job's change sits on: the one it started from, then
  // each MR preparation's target when it is that ticket's prepared commit; null when the change is
  // on its base (started, prepared or moved there once that ticket was merged); null for most.
  builds_on: z.string().min(1).nullable().default(null),
  builds_on_commit: commit.nullable().default(null),
  // The commit the branch was created from; the Patch is the difference to it.
  base_commit: commit.nullable(),
  // The target commit of MR preparation: resolved at Clean, the commit the branch is rebased onto.
  target_commit: commit.nullable().default(null),
  // The job's worktree, absolute; null before start, after Clean and once removed.
  worktree: z.string().min(1).nullable().default(null),
  // The branch tip the factory prepared at Clean; approve pushes it unless the tip moved.
  prepared_commit: commit.nullable().default(null),
  // Number of MR preparation turns started.
  mr_attempts: z.number().int().min(0).default(0),
  // Whether the MR preparation in progress ran a conflict turn: set before the conflict
  // prompt is sent, cleared when the resolved iteration goes back to review and when MR preparation
  // starts. Its resolution is applied before the job goes back to review, so a stop in between
  // leaves code no reviewer saw: no Retry then.
  mr_conflict_turn: z.boolean().default(false),
  state: z.enum(JOB_STATES),
  // Number of published iterations.
  iteration: z.number().int().min(0),
  // Number of Fix sections written: the reviewers', sf fix, the user's Must fix, Simplify and the
  // Guard's (not the Tests Fix).
  fixes: z.number().int().min(0).default(0),
  // Fix sections the gate asked for (a joint Fix only when the gate's verdict is a fix); the light gate level reads it (a delta round counts from its clean round, src/review-delta.ts).
  gate_fixes: z.number().int().min(0).default(0),
  // Input plus output tokens of every gate run of the job; the gate budget limits them
  // (SF_GATE_MAX_TOKENS for every started 2000 changed lines).
  gate_tokens: z.number().int().min(0).default(0),
  // The job's review rounds without progress: rounds that asked for a Fix while no fewer blocker
  // and major ledger entries were open than after any earlier such round, or that reopened one. Absent: 0.
  stalled_fixes: z.number().int().min(0).optional(),
  // The fewest open blocker and major ledger entries after any review round of the job that asked for a Fix; absent before the first.
  least_open: z.number().int().min(0).optional(),
  // Of those rounds without progress, the ones whose Fix the gate asked for. Absent: 0.
  gate_stalled: z.number().int().min(0).optional(),
  // The job's gate_tokens when its gate budget began counting. Absent: 0.
  gate_budget_from: z.number().int().min(0).optional(),
  // The ticket is important: its Task file said important: true at Start. Absent: not important.
  important: z.literal(true).optional(),
  // The iteration the simplification pass started on, written before it runs; absent until then. Once set, the pass never runs again on the job, whatever became of that run.
  simplify_iteration: z.number().int().min(1).optional(),
  // Whether the Claude review runs on the job, decided at Start (SF_CLAUDE_REVIEW, the Task file's
  // review, the gate) and never changed after; false: the Codex gate is the review. Absent in a
  // job.json written without it: true (claudeReviews).
  claude_review: z.boolean().optional(),
  // The fix rounds' session, decided at Start (SF_FIX_SESSION, the Task's fix_session); absent: resume.
  fix_session: z.enum(['fresh', 'resume']).optional(),
  // The sha256 of the Implementer's findings checklist block (findings.md, src/execution/start.ts); null: none.
  findings_checklist: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  session_id: z.string().min(1).nullable(),
  // fix_session fresh: the SDK's cost total of the session after its last turn (src/execution/turns.ts).
  session_cost_usd: z.strictObject({ session_id: z.string().min(1), usd: z.number().min(0) }).optional(),
  // The spend of ended sessions after their last published iteration, for the next one; absent: 0.
  unpublished_cost_usd: z.number().min(0).optional(),
  // The sha256 of the Task file the job works from: recorded at Start, at every later copy into
  // the worktree and on a Resume that found the Task file changed; absent in a job.json written
  // without it. task.md keeps the version the Implementer was last given, which can be older.
  task_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  // The images the Task file refers to, as resolved at Start, Restart or the last Resume and
  // copied into attachments/ of the job directory; absent when it refers to none.
  attachments: z.array(z.strictObject({
    name: z.string().min(1),
    type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    bytes: z.number().int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })).optional(),
  // While paused or waiting_limit: the state the job was paused in, what was interrupted, and when.
  paused: z.strictObject({ from: z.enum(PAUSABLE_STATES), step: z.enum(PAUSE_STEPS).nullable(), at: timestamp }).optional(),
  // While waiting_limit: whose usage limit the session hit and when the run queue goes on
  // (the parsed reset, else paused.at + 30 minutes); reset_seen once that time passed under the
  // rule wait (the user resumes), with when the user was told.
  limit: z.strictObject({
    provider: z.enum(['claude', 'codex']),
    resets_at: timestamp,
    reset_seen: z.literal(true).optional(),
    notified_at: timestamp.optional(),
  }).optional(),
  // The continuations the factory sent by itself in the Implementer's current chain of turns, after
  // a turn limit, and how many the chain may have; absent once a new chain starts.
  turn_limit: z.strictObject({ continued: z.number().int().min(1), allowed: z.number().int().min(0) }).optional(),
  created_at: timestamp,
  // Time of the last state change.
  updated_at: timestamp,
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
  // The job in the user's checkout; absent otherwise.
  handover: handoverSchema.optional(),
  // Why the automatic hand-over did not happen; absent once the job leaves ready_for_human_review.
  handoff_skipped: z.strictObject({ code: z.string(), message: z.string() }).optional(),
  // While a quick fix runs (sf quickfix, src/quick-fix.ts): where it came from, its baseline tree, the paths accepted before it.
  quick_fix: quickFixSchema.optional(),
  clean: cleanSchema.optional(),
  // The merge request the factory opened on the Git host, from pushed on; null before.
  mr: z.strictObject({
    host: z.enum(['github', 'gitlab']),
    number: z.number().int().min(1),
    url: z.string().min(1),
    state: z.enum(['open', 'merged', 'closed']),
    // The merge commit once merged, when the host reports it.
    merge_commit: commit.nullable().optional(),
  }).nullable().default(null),
});
export type Job = z.output<typeof jobSchema>;
export type JobMr = NonNullable<Job['mr']>;

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

// One file of an iteration: its status against the base, whether it is a sensitive path and
// whether the Task file declared it, whether it is in the Task's file scope, and its line counts.
export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  from?: string;
  sensitive: 'declared' | 'undeclared' | 'no';
  // none when the Task declares no scope; a record written without scope reads as none.
  scope: 'in' | 'out' | 'none';
  additions: number;
  deletions: number;
}

export interface IterationMeta {
  iteration: number;
  started_at: string;
  ended_at: string;
  // Tool names of denied tool calls, in order; never their inputs.
  denials: string[];
  changed_files: ChangedFile[];
  // The structured file list; absent in a meta.json written without it.
  files?: FileChange[];
  patch_truncated: boolean;
  submodule_changed: string[];
  // This iteration's cost, and the SDK's cumulative total for the session.
  cost_usd: number | null;
  cost_usd_total: number | null;
  // The Implementer session cost_usd_total is of; absent in a meta.json written without it.
  session_id?: string;
  duration_ms: number | null;
  // The commit the iteration's Patch is against; absent in a meta.json written without it.
  base_commit?: string;
  // The tree the factory's commit would have when the iteration was published (worktreeTree of
  // src/guard.ts against base_commit, in a temporary index); absent in a meta.json written without it.
  commit_tree?: string;
  delta?: IterationDelta;
}

// iterations/NNN/review.json: the Claude review of the iteration, or why it failed. review_method
// (here and in gate.json): the reviewer's method, 'none' or the skill file; absent in older records.
export type ReviewRecord =
  | {
      reviewer: string;
      verdict: 'clean' | 'fix';
      summary: string;
      items: ReviewItem[];
      accepted_sensitive: string[];
      // The items that reopened an accepted risk: dropped, the user decided.
      dropped?: ReviewItem[];
      cost_usd: number | null;
      started_at: string;
      ended_at: string;
      review_method?: ReviewMethod;
    }
  | { reviewer: string; error: string; review_method?: ReviewMethod };

// The token usage of one gate run, from Codex's turn.completed events.
export interface GateTokens {
  input: number;
  cached_input: number;
  output: number;
}

// iterations/NNN/gate.json: the gate's review of the iteration, or why it failed.
export type GateRecord =
  | {
      reviewer: string;
      verdict: 'clean' | 'fix';
      summary: string;
      items: ReviewItem[];
      accepted_sensitive: string[];
      // The items that reopened an accepted risk: dropped, the user decided.
      dropped?: ReviewItem[];
      model?: string;
      tokens: GateTokens;
      started_at: string;
      ended_at: string;
      review_method?: ReviewMethod;
    }
  | { reviewer: string; error: string; model?: string; tokens: GateTokens; started_at: string; ended_at: string; review_method?: ReviewMethod };

// iterations/NNN/gate-override.json: the user accepted the iteration over a stopped gate
// (needs_human with code gate_rounds, gate_budget or gate_failed) with Claude's clean review; at
// is when, unapplied the Codex items of the iteration's gate.json the change goes without, or the
// gate's error when it failed ([] when no gate ran on the iteration). Over a ledger stop
// (review_churn, review_disputed) or the Fix round limit (iteration_limit) unapplied are the ledger's
// open findings, each with its id, and the gate's items that reopen none of them.
export interface GateOverride {
  at: string;
  code: string;
  unapplied: Array<ReviewItem & { id?: string }> | string;
}

// iterations/NNN/gate-level.json: the gate level of the iteration, decided once at its
// clean Claude verdict (src/gate-level.ts): the level, the rules that decided it, whether the gate
// ran, and the change's counts of files and of added plus deleted lines (null when the iteration's
// meta.json has no file list). Strictly parsed.
export const gateLevelSchema = z.strictObject({
  level: z.enum(GATE_LEVELS),
  reasons: z.array(z.string()).min(1),
  ran: z.boolean(),
  files: z.number().int().min(0).nullable(),
  lines: z.number().int().min(0).nullable(),
  at: z.string(),
});
export type GateLevelRecord = z.output<typeof gateLevelSchema>;

// One job directory of a workspace (listAll): current (<ticket>) or archived
// (<ticket>.<stamp>), with its job.json parsed, or why it could not be.
export interface JobDir {
  workspace: string;
  // The directory's name: what the other read methods take as the ticket.
  name: string;
  archived: boolean;
  job: Job | undefined;
  error?: string;
}

// iterations/NNN/simplify.json: the simplification pass after the deciding clean verdict of the
// iteration, or why it failed (redacted). suggestions: what it offers the user; dropped:
// what the factory withheld because it names a fixed blocker entry of the ledger.
export type SimplifyRecord =
  | {
      reviewer: string;
      summary: string;
      suggestions: Suggestion[];
      dropped: Suggestion[];
      cost_usd: number | null;
      model: string | null;
      started_at: string;
      ended_at: string;
      // When the user skipped the suggestions (sf accept on simplify_offered); absent otherwise.
      skipped_at?: string;
    }
  | { reviewer: string; error: string; started_at: string; ended_at: string };

export interface Iteration {
  report: string;
  patch: Buffer;
  meta: IterationMeta;
}

// One line of events.jsonl: an SDK message, a prompt sent, a state change, a failed notification,
// removed placeholders, or a review's outcome, Codex event or Claude message.
export type EventRecord = { ts: string; iteration: number } & (
  | { message: unknown }
  // A prompt sent to the Implementer, with the names, types and sizes of its image blocks, never their bytes.
  | { prompt: string; images?: Array<{ name: string; type: string; bytes: number }> }
  | { state: { from: JobState | null; to: JobState; error?: { code: string; message: string } } }
  | { type: 'notify_failed'; channel: string; message: string }
  // Sandbox placeholders the factory removed from the work checkout (src/placeholders.ts).
  | { type: 'placeholders_removed'; paths: string[] }
  // The outcome of a review, Claude's or the gate's (reviewer codex); ignored when
  // the job had moved on before it ended.
  // effective: the verdict the factory acted on when it is not the reviewer's: clean for a
  // fix with nits only, fix for a clean that leaves an undeclared sensitive path unaccepted.
  | { type: 'review'; reviewer: string; verdict: 'clean' | 'fix'; items: number; effective?: 'clean' | 'fix'; ignored?: true }
  | { type: 'review_failed'; reviewer: string; error: string; ignored?: true }
  // The reviewers live: one JSONL event of the Codex gate's stdout, one SDK message of the
  // Claude review session; truncated when cut to MAX_LIVE_EVENT_BYTES (cutEvent).
  | { type: 'gate_event'; reviewer: string; event: unknown; truncated?: true }
  | { type: 'review_message'; reviewer: string; message: unknown; truncated?: true }
  // The user accepted the iteration over the stopped gate: the code it stopped with and
  // the number of Codex items not applied (0 when the gate failed or did not run).
  | { type: 'gate_overridden'; code: string; unapplied: number }
  // Whether the Claude review runs on the job, decided at Start, and why.
  | { type: 'review_setup'; claude_review: boolean; reason: string }
  // The session of the job's fix rounds, decided at Start, and why (src/config.ts, fixSessionDecision).
  | { type: 'fix_session_setup'; fix_session: 'fresh' | 'resume'; reason: 'setting' | 'task' | 'alternate' }
  | { type: 'findings_checklist_unavailable'; message: string }
  // The gate level of the iteration: the level, whether the gate runs, and why.
  | { type: 'gate_level'; level: GateLevel; ran: boolean; reasons: string[] }
  // The simplification pass: its outcome (the suggestions offered, those the factory
  // dropped, or its error), and the user's choice on the offer (simplify or skip).
  | { type: 'simplify'; reviewer: string; suggestions: number; dropped: number; error?: string; ignored?: true }
  | { type: 'simplify_chosen'; choice: 'simplify' | 'skip'; suggestions: number }
  // The last review of the iteration: its comments, or its error (timed_out: it reached its time
  // limit); ignored when the job had moved on before it ended.
  | { type: 'last_review'; comments: number; error?: string; timed_out?: true; ignored?: true }
  // A step the user's Pause interrupted: the turn, or a round of a reviewer, thrown away
  // and run again on Resume; never a verdict.
  // A usage limit interrupts the same way: the job parks in waiting_limit.
  | { type: 'interrupted'; step: PauseStep; reviewer?: string }
  // The images of the job, resolved and copied at Start, Restart or a Resume that found them
  // changed: name, type, size and sha256 of each, never their bytes.
  | { type: 'attachments'; images: Array<{ name: string; type: string; bytes: number; sha256: string }> }
  // The Task file changed while the job was paused: the sha256 the job had, and the new one.
  | { type: 'task_changed'; from: string | null; to: string }
  // An Implementer turn ended at the turn limit while making progress and the factory sent a continuation: its
  // number in the chain, the chain's allowance, the turn's maxTurns, the worktree's changed paths and tool calls.
  | { type: 'turn_limit_continued'; continued: number; allowed: number; max_turns: number; changed_paths: number; tool_calls: number }
  // A turn's stream stayed open waited_s seconds after its result: Claude Code ended, the result kept. A Bash call hung (src/tool-stall.ts): its command on one line, how long it was open, why (no command process, or past the tool's cap), and whether the turn's instruction went again or the job stopped.
  | { type: 'turn_stream_stuck'; waited_s: number } | { type: 'tool_stalled'; tool: 'Bash'; command: string; open_s: number; reason: 'no_process' | 'past_cap'; action: 'resent' | 'stopped' }
  // The merge request on the Git host: opened, reused (already open for the branch), merged by the
  // factory; by sf mr status, updated (merged or closed on the host) or found (open for the branch).
  // mr_state, not state: a record with state is a state change.
  | { type: 'merge_request'; action: 'created' | 'reused' | 'merged' | 'updated' | 'found'; host: JobMr['host']; number: number; url: string; mr_state: JobMr['state']; merge_commit?: string }
  // The hand-over to the user's checkout: done, ended (by Ask for changes, Take it back, the
  // push or abort, with the record as it was), or a note (a worktree that could not be removed, the
  // files Ask for changes left in the checkout because they changed).
  | { type: 'handover'; action: 'handed_over' | 'ended' | 'note'; handover?: Handover; note?: string }
  // The user's own push of a handed-over branch, found on origin: the commit, and whether
  // its tree is the job's commit's (null when the commit is not known locally).
  | { type: 'handover_pushed'; commit: string; same_tree: boolean | null }
  // The user marked a handed-over job done: they merged its changes another way (sf handed-done --merged).
  | { type: 'handover_marked_done' }
  // MR preparation committed nothing because the worktree no longer matched the reviewed
  // iteration (the record's iteration): the first MAX_UNREVIEWED_PATHS paths that differ (null:
  // not known) and how many more (0 with null).
  | { type: 'unreviewed_change'; paths: string[] | null; more: number }
  // The factory removed the config lock Claude Code's sandbox left in the workspace checkout's Git
  // directory (src/sandbox-lock.ts): its path.
  | { type: 'sandbox_lock_removed'; path: string }
  // The MR text: the user saved their own or reset it to the factory's (with the branch
  // and base the save set, when it changed them), or a new Clean wrote a new factory text and kept
  // the user's.
  | { type: 'mr_edited'; action: 'saved' | 'reset' | 'factory_new'; branch?: string; base?: string }
  // The workspace's test command: a run started (run: its started_at), and how it ended or
  // the user's Accept of it (accepted_failing), with the last lines of its output (tail).
  | { type: 'tests_started'; run: string; command: string }
  | { type: 'tests'; run: string; command: string; outcome: TestsOutcome; exit_code: number | null; timed_out: boolean; duration_ms: number; reason?: string; tail: string; tail_truncated?: true }
  // skills: what a job uses, once at its start (src/skills.ts); skill_missing: the Implementer's session listed no such skill (its slash command reached the model as plain text).
  | import('./skills.js').SkillsEvent | { type: 'skill_missing'; skill: string }
  | import('./quick-fix.js').QuickFixEvent // a quick fix asked, then quick (no review) or full (the review round)
  // The merge check before sf mr merge (src/merge-check.ts): its last base commit (null: none), how it ended.
  | { type: 'merge_checked'; base_commit: string | null; outcome: 'passed' | 'failed' | 'conflict' | 'timed_out' | 'aborted'; duration_ms: number }
  // Landed on the target, then archived; how (absent: base): the pass found commit on the target, the host said merge request mr merged, or the user's Merged — archive.
  | { type: 'merged_on_target'; commit: string | null; target: string; how?: 'base' | 'host' | 'user'; mr?: number }
);

// The bound of one reviewer event or message in events.jsonl, in bytes of its JSON.
export const MAX_LIVE_EVENT_BYTES = 16 * 1024;

// A string cut to at most limit UTF-16 units and marked, without splitting a surrogate pair.
function cutString(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const code = text.charCodeAt(limit - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
  return `${text.slice(0, end)}…`;
}

// The value with every string cut to limit and every array to its first limit entries.
function shrink(value: unknown, limit: number): unknown {
  if (typeof value === 'string') {
    return cutString(value, limit);
  }
  if (Array.isArray(value)) {
    return value.slice(0, limit).map((entry) => shrink(entry, limit));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shrink(entry, limit)]));
  }
  return value;
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null');

// An event (a parsed Codex event, an SDK message) within MAX_LIVE_EVENT_BYTES of JSON: as it is
// when it fits, else with its strings and arrays cut ever shorter until it fits, at the last its
// type alone.
export function cutEvent(value: unknown): { value: unknown; truncated: boolean } {
  if (jsonBytes(value) <= MAX_LIVE_EVENT_BYTES) {
    return { value, truncated: false };
  }
  for (const limit of [4096, 1024, 256, 64, 16]) {
    const cut = shrink(value, limit);
    if (jsonBytes(cut) <= MAX_LIVE_EVENT_BYTES) {
      return { value: cut, truncated: true };
    }
  }
  const type = (value as { type?: unknown } | null)?.type;
  return { value: typeof type === 'string' ? { type: cutString(type, 64) } : null, truncated: true };
}

// Whether the Claude review runs on the job: its claude_review, true when absent (a job.json
// written without it). False: the Codex gate is the review, and its last gate.json decides.
export const claudeReviews = (job: Pick<Job, 'claude_review'>): boolean => job.claude_review !== false;

export const isActive = (job: Job): boolean => ACTIVE_STATES.includes(job.state);

export function now(): string {
  return new Date().toISOString();
}

// Items stored without a severity read as major.
function majorUnlessSet(items: ReviewItem[]): ReviewItem[] {
  return items.map((item) => (item.severity === undefined ? { ...item, severity: 'major' } : item));
}

// A review or gate record with every item's severity set.
function withSeverity<T extends ReviewRecord | GateRecord>(record: T): T {
  return 'items' in record && Array.isArray(record.items) ? { ...record, items: majorUnlessSet(record.items) } : record;
}

// last-review-skill.json as readLastReviewSkill accepts it.
const skillCopySchema = z.strictObject({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/u), files: z.number().int().min(0) });

async function readOrMissing(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

// The name archive() gives a job directory: <ticket>.<stamp>.
const ARCHIVED_NAME = /\.\d{8}T\d{6}Z$/;

export class JobStore {
  readonly root: string;

  // stateDir: the factory state directory; jobs live in its jobs/ subdirectory.
  constructor(stateDir: string) {
    this.root = join(stateDir, 'jobs');
  }

  // workspace and ticket are validated names (registry and Task file patterns), never paths.
  dir(workspace: string, ticket: string): string {
    return join(this.root, workspace, ticket);
  }

  // The job's own copy of the Task file's images: what its agents are given.
  attachmentsDir(workspace: string, ticket: string): string {
    return join(this.dir(workspace, ticket), 'attachments');
  }

  eventsPath(workspace: string, ticket: string): string {
    return join(this.dir(workspace, ticket), 'events.jsonl');
  }

  async read(workspace: string, ticket: string): Promise<Job | undefined> {
    const text = await readOrMissing(join(this.dir(workspace, ticket), 'job.json'));
    if (text === undefined) {
      return undefined;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch { // not JSON: reported as job_invalid
      throw new FactoryError('job_invalid', `job.json of ${workspace}/${ticket} is not valid JSON.`);
    }
    const parsed = jobSchema.safeParse(data);
    if (!parsed.success || parsed.data.workspace !== workspace || parsed.data.ticket !== ticket) {
      throw new FactoryError('job_invalid', `job.json of ${workspace}/${ticket} is invalid.`);
    }
    return parsed.data;
  }

  async write(job: Job): Promise<void> {
    const dir = this.dir(job.workspace, job.ticket);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(dir, 'job.json'), Buffer.from(`${JSON.stringify(jobSchema.parse(job), null, 2)}\n`));
  }

  // The workspaces that have a job directory, current or archived, sorted.
  workspaceNames(): Promise<string[]> {
    return this.#entries(this.root);
  }

  // Every current job (archived ones excluded), sorted by workspace and ticket.
  async list(): Promise<Job[]> {
    const jobs: Job[] = [];
    for (const workspace of await this.#entries(this.root)) {
      for (const ticket of await this.#entries(join(this.root, workspace))) {
        // Archived directories are named <ticket>.<timestamp>; their job.json names another ticket.
        const text = await readOrMissing(join(this.root, workspace, ticket, 'job.json'));
        if (text === undefined) {
          continue;
        }
        let ticketInFile: unknown = ticket;
        try {
          ticketInFile = (JSON.parse(text) as { ticket?: unknown }).ticket;
        } catch { // not JSON: read() below reports the invalid file
        }
        if (ticketInFile === ticket) {
          const job = await this.read(workspace, ticket);
          if (job !== undefined) {
            jobs.push(job);
          }
        }
      }
    }
    return jobs.sort((a, b) => `${a.workspace}/${a.ticket}`.localeCompare(`${b.workspace}/${b.ticket}`));
  }

  // Every job directory of every workspace, current and archived (sf metrics), sorted by
  // workspace and name. job.json is parsed with jobSchema but not checked against the directory's
  // name (an archived job's ticket is not its directory's name); a file that cannot be read or
  // parsed gives the error instead.
  async listAll(): Promise<JobDir[]> {
    const dirs: JobDir[] = [];
    for (const workspace of await this.#entries(this.root)) {
      for (const name of await this.#entries(join(this.root, workspace))) {
        // Archived: a job.json naming another ticket, or without one the archive's name
        // <ticket>.<stamp>.
        const dir: JobDir = { workspace, name, archived: ARCHIVED_NAME.test(name), job: undefined };
        try {
          const text = await readOrMissing(join(this.root, workspace, name, 'job.json'));
          const parsed = text === undefined ? undefined : jobSchema.safeParse(JSON.parse(text));
          if (parsed?.success === true) {
            dir.job = parsed.data;
            dir.archived = parsed.data.ticket !== name;
          } else {
            dir.error = text === undefined ? 'job.json is missing' : 'job.json is invalid';
          }
        } catch (error) {
          dir.error = error instanceof SyntaxError ? 'job.json is not valid JSON' : (error as Error).message;
        }
        dirs.push(dir);
      }
    }
    return dirs;
  }

  // Moves the job directory to <ticket>.<timestamp> next to it and returns that name.
  async archive(workspace: string, ticket: string): Promise<string> {
    const stamp = now().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const name = `${ticket}.${stamp}`;
    await rename(this.dir(workspace, ticket), join(this.root, workspace, name));
    return name;
  }

  // The Task file as the Implementer was last given it; undefined in a job directory without task.md.
  readTaskCopy(workspace: string, ticket: string): Promise<string | undefined> {
    return readOrMissing(join(this.dir(workspace, ticket), 'task.md'));
  }

  // Replaced atomically, by syncTask (src/execution/start.ts) only.
  async writeTaskCopy(workspace: string, ticket: string, content: Buffer): Promise<void> {
    await writeFileAtomic(join(this.dir(workspace, ticket), 'task.md'), content);
  }

  // The Task file the reviewers read: the bytes the factory last copied into the worktree (copyTask,
  // src/execution/start.ts), never the worktree's file, which the Implementer can write. A job
  // directory without review-task.md (a job started before it was kept) reads task.md; undefined
  // without either.
  async readReviewTask(workspace: string, ticket: string): Promise<string | undefined> {
    return (await readOrMissing(join(this.dir(workspace, ticket), 'review-task.md'))) ?? this.readTaskCopy(workspace, ticket);
  }

  // Replaced atomically, by copyTask (src/execution/start.ts) only.
  async writeReviewTask(workspace: string, ticket: string, content: Buffer): Promise<void> {
    await writeFileAtomic(join(this.dir(workspace, ticket), 'review-task.md'), content);
  }

  // The MR text once it exists (copied when the branch is ready, or at a conflict iteration).
  readMrText(workspace: string, ticket: string): Promise<string | undefined> {
    return readOrMissing(join(this.dir(workspace, ticket), 'mr.md'));
  }

  async writeMrText(workspace: string, ticket: string, text: string): Promise<void> {
    await writeFileAtomic(join(this.dir(workspace, ticket), 'mr.md'), Buffer.from(text, 'utf8'));
  }

  // The factory's MR text, kept next to mr.md once the user saved their own; undefined
  // while the MR text was never edited.
  readMrFactoryText(workspace: string, ticket: string): Promise<string | undefined> {
    return readOrMissing(join(this.dir(workspace, ticket), 'mr-factory.md'));
  }

  async writeMrFactoryText(workspace: string, ticket: string, text: string): Promise<void> {
    await writeFileAtomic(join(this.dir(workspace, ticket), 'mr-factory.md'), Buffer.from(text, 'utf8'));
  }

  // At a Clean without an edit: the factory's text is mr.md again.
  async removeMrFactoryText(workspace: string, ticket: string): Promise<void> {
    await rm(join(this.dir(workspace, ticket), 'mr-factory.md'), { force: true });
  }

  async appendEvent(workspace: string, ticket: string, record: EventRecord): Promise<void> {
    await appendFile(this.eventsPath(workspace, ticket), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  async writeIteration(workspace: string, ticket: string, iteration: Iteration): Promise<void> {
    const dir = join(this.dir(workspace, ticket), 'iterations', String(iteration.meta.iteration).padStart(3, '0'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(dir, 'patch.diff'), iteration.patch);
    await writeFileAtomic(join(dir, 'meta.json'), Buffer.from(`${JSON.stringify(iteration.meta, null, 2)}\n`));
    // The report last: its presence marks the iteration as complete.
    await writeFileAtomic(join(dir, 'report.md'), Buffer.from(iteration.report, 'utf8'));
  }

  async readMeta(workspace: string, ticket: string, number: number): Promise<IterationMeta> {
    const dir = join(this.dir(workspace, ticket), 'iterations', String(number).padStart(3, '0'));
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as IterationMeta;
    // A file list written without scope reads as none.
    return meta.files === undefined ? meta : { ...meta, files: meta.files.map((change) => ({ ...change, scope: change.scope ?? 'none' })) };
  }

  // The directory of one published iteration.
  iterationDir(workspace: string, ticket: string, number: number): string {
    return join(this.dir(workspace, ticket), 'iterations', String(number).padStart(3, '0'));
  }

  // iterations/NNN/tree: the tree id of the job's files after the iteration, derived by
  // src/changes.ts from the iteration's base and Patch.
  treePath(workspace: string, ticket: string, number: number): string {
    return join(this.iterationDir(workspace, ticket, number), 'tree');
  }

  // The job's own Git object directory: the objects of the iteration trees, with the
  // workspace's objects as alternates; nothing is written into the workspace's repository.
  objectsDir(workspace: string, ticket: string): string {
    return join(this.dir(workspace, ticket), 'objects');
  }

  // The resolution of a conflict turn whose rebase could not continue, kept with the
  // iteration being rebased, its content written by write; returns the file's path.
  async writeConflictResolution(workspace: string, ticket: string, number: number, write: (handle: FileHandle) => Promise<void>): Promise<string> {
    const path = join(this.iterationDir(workspace, ticket, number), 'conflict-resolution.diff');
    await writeFileAtomicWith(path, write);
    return path;
  }

  async writeReview(workspace: string, ticket: string, number: number, review: ReviewRecord): Promise<void> {
    await writeFileAtomic(join(this.iterationDir(workspace, ticket, number), 'review.json'), Buffer.from(`${JSON.stringify(review, null, 2)}\n`));
  }

  // Before a retried review: the failed record goes, so the iteration's review shows as running.
  async removeReview(workspace: string, ticket: string, number: number): Promise<void> {
    const dir = join(this.dir(workspace, ticket), 'iterations', String(number).padStart(3, '0'));
    await rm(join(dir, 'review.json'), { force: true });
  }

  // The review of an iteration; undefined while none ended (or with the review off).
  async readReview(workspace: string, ticket: string, number: number): Promise<ReviewRecord | undefined> {
    const text = await readOrMissing(join(this.iterationDir(workspace, ticket, number), 'review.json'));
    return text === undefined ? undefined : withSeverity(JSON.parse(text) as ReviewRecord);
  }

  async writeGate(workspace: string, ticket: string, number: number, gate: GateRecord): Promise<void> {
    await writeFileAtomic(join(this.iterationDir(workspace, ticket, number), 'gate.json'), Buffer.from(`${JSON.stringify(gate, null, 2)}\n`));
  }

  // Before the stopped gate runs again, after the user settled a dispute.
  async removeGate(workspace: string, ticket: string, number: number): Promise<void> {
    await rm(join(this.iterationDir(workspace, ticket, number), 'gate.json'), { force: true });
  }

  // The findings ledger; [] before the first Fix section. Strictly parsed.
  async readLedger(workspace: string, ticket: string): Promise<LedgerEntry[]> {
    const text = await readOrMissing(join(this.dir(workspace, ticket), 'ledger.json'));
    if (text === undefined) {
      return [];
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch { // not JSON: reported as ledger_invalid
      throw new FactoryError('ledger_invalid', `ledger.json of ${workspace}/${ticket} is not valid JSON.`);
    }
    const parsed = ledgerSchema.safeParse(data);
    if (!parsed.success) {
      throw new FactoryError('ledger_invalid', `ledger.json of ${workspace}/${ticket} is invalid.`);
    }
    return parsed.data;
  }

  // Replaced atomically; only under the job lock of the Execution.
  async writeLedger(workspace: string, ticket: string, ledger: LedgerEntry[]): Promise<void> {
    await writeFileAtomic(join(this.dir(workspace, ticket), 'ledger.json'), Buffer.from(`${JSON.stringify(ledgerSchema.parse(ledger), null, 2)}\n`));
  }

  // The outcome of the simplification pass on an iteration, replaced atomically.
  async writeSimplify(workspace: string, ticket: string, number: number, record: SimplifyRecord): Promise<void> {
    await writeFileAtomic(join(this.iterationDir(workspace, ticket, number), 'simplify.json'), Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
  }

  // The simplification pass of an iteration; undefined when none ended there.
  async readSimplify(workspace: string, ticket: string, number: number): Promise<SimplifyRecord | undefined> {
    const text = await readOrMissing(join(this.iterationDir(workspace, ticket, number), 'simplify.json'));
    return text === undefined ? undefined : (JSON.parse(text) as SimplifyRecord);
  }

  // The outcome of the last review on an iteration, replaced atomically.
  async writeLastReview(workspace: string, ticket: string, number: number, record: LastReviewRecord): Promise<void> {
    await writeFileAtomic(join(this.iterationDir(workspace, ticket, number), 'last-review.json'), Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
  }

  // The last review of an iteration; undefined when none ended there.
  async readLastReview(workspace: string, ticket: string, number: number): Promise<LastReviewRecord | undefined> {
    const text = await readOrMissing(join(this.iterationDir(workspace, ticket, number), 'last-review.json'));
    return text === undefined ? undefined : (JSON.parse(text) as LastReviewRecord);
  }

  // The job's copy of the last review's skill folder (copySkill, src/last-review.ts).
  lastReviewSkillDir(workspace: string, ticket: string): string {
    return join(this.dir(workspace, ticket), 'last-review-skill');
  }

  // What the job's copy of the last review's skill is; undefined when there is none, or the file
  // is not JSON of that shape.
  async readLastReviewSkill(workspace: string, ticket: string): Promise<SkillCopy | undefined> {
    const text = await readOrMissing(join(this.dir(workspace, ticket), 'last-review-skill.json'));
    let value: unknown;
    try {
      value = text === undefined ? undefined : JSON.parse(text);
    } catch { // a file that is not JSON reads as no copy: the caller copies the skill again
      return undefined;
    }
    const parsed = skillCopySchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }

  // Replaced atomically.
  async writeLastReviewSkill(workspace: string, ticket: string, copy: SkillCopy): Promise<void> {
    await writeFileAtomic(join(this.dir(workspace, ticket), 'last-review-skill.json'), Buffer.from(`${JSON.stringify(copy, null, 2)}\n`));
  }

  async writeGateOverride(workspace: string, ticket: string, number: number, override: GateOverride): Promise<void> {
    await writeFileAtomic(join(this.iterationDir(workspace, ticket, number), 'gate-override.json'), Buffer.from(`${JSON.stringify(override, null, 2)}\n`));
  }

  // The user's override of the gate on an iteration; undefined when there is none.
  async readGateOverride(workspace: string, ticket: string, number: number): Promise<GateOverride | undefined> {
    const text = await readOrMissing(join(this.iterationDir(workspace, ticket, number), 'gate-override.json'));
    if (text === undefined) {
      return undefined;
    }
    const override = JSON.parse(text) as GateOverride;
    return Array.isArray(override.unapplied) ? { ...override, unapplied: majorUnlessSet(override.unapplied) } : override;
  }

  // The gate level of an iteration; undefined when none was decided there. Strictly parsed:
  // gate_level_invalid for a file that is not valid JSON or does not match the schema.
  async readGateLevel(workspace: string, ticket: string, number: number): Promise<GateLevelRecord | undefined> {
    const text = await readOrMissing(join(this.iterationDir(workspace, ticket, number), 'gate-level.json'));
    if (text === undefined) {
      return undefined;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch { // not JSON: reported as gate_level_invalid
      throw new FactoryError('gate_level_invalid', `gate-level.json of ${workspace}/${ticket} iteration ${number} is not valid JSON.`);
    }
    const parsed = gateLevelSchema.safeParse(data);
    if (!parsed.success) {
      throw new FactoryError('gate_level_invalid', `gate-level.json of ${workspace}/${ticket} iteration ${number} is invalid.`);
    }
    return parsed.data;
  }

  // Written once per iteration, at its clean Claude verdict; parsed with the schema first.
  async writeGateLevel(workspace: string, ticket: string, number: number, record: GateLevelRecord): Promise<void> {
    await writeFileAtomic(join(this.iterationDir(workspace, ticket, number), 'gate-level.json'), Buffer.from(`${JSON.stringify(gateLevelSchema.parse(record), null, 2)}\n`));
  }

  // The run of the workspace's test command on an iteration: tests-<N>.json of the job
  // directory, replaced by a later run of the same iteration (Retry) and by the user's Accept.
  async writeTests(workspace: string, ticket: string, number: number, record: TestsRecord): Promise<void> {
    await writeFileAtomic(join(this.dir(workspace, ticket), `tests-${number}.json`), Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
  }

  // undefined when no run ended on the iteration.
  async readTests(workspace: string, ticket: string, number: number): Promise<TestsRecord | undefined> {
    const text = await readOrMissing(join(this.dir(workspace, ticket), `tests-${number}.json`));
    return text === undefined ? undefined : (JSON.parse(text) as TestsRecord);
  }

  // The job's tests-<N>.json records whose outcome is failed (the bound of the Tests Fix
  // rounds). A record that cannot be read or parsed counts as failed.
  async failedTests(workspace: string, ticket: string): Promise<number> {
    let names: string[];
    try {
      names = (await readdir(this.dir(workspace, ticket))).filter((name) => /^tests-\d+\.json$/.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
    let failed = 0;
    for (const name of names) {
      const outcome = await readFile(join(this.dir(workspace, ticket), name), 'utf8').then((text) => (JSON.parse(text) as { outcome?: unknown }).outcome, () => 'failed');
      if (outcome === 'failed') {
        failed += 1;
      }
    }
    return failed;
  }

  // The gate's review of an iteration; undefined while none ended (or with the gate off).
  async readGate(workspace: string, ticket: string, number: number): Promise<GateRecord | undefined> {
    const text = await readOrMissing(join(this.iterationDir(workspace, ticket, number), 'gate.json'));
    return text === undefined ? undefined : withSeverity(JSON.parse(text) as GateRecord);
  }

  // The recorded cost of the published iterations 1 to count: the sum of their cost_usd and of the
  // cost_usd of their reviews. Undefined when a metadata file is missing or a cost is not a finite
  // nonnegative number (null, absent, ...); an iteration without a review, or a failed review, adds
  // nothing. Other read failures and malformed JSON throw. Later directories and cost_usd_total are
  // ignored.
  async recordedCost(workspace: string, ticket: string, count: number): Promise<number | undefined> {
    let total = 0;
    for (let number = 1; number <= count; number += 1) {
      let meta: IterationMeta;
      try {
        meta = await this.readMeta(workspace, ticket, number);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
      const cost: unknown = meta.cost_usd;
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
        return undefined;
      }
      total += cost;
      const review = await this.readReview(workspace, ticket, number);
      if (review !== undefined && 'verdict' in review) {
        const reviewCost: unknown = review.cost_usd;
        if (typeof reviewCost !== 'number' || !Number.isFinite(reviewCost) || reviewCost < 0) {
          return undefined;
        }
        total += reviewCost;
      }
    }
    return total;
  }

  async readIteration(workspace: string, ticket: string, number: number): Promise<{ report: string; patch: Buffer }> {
    const dir = join(this.dir(workspace, ticket), 'iterations', String(number).padStart(3, '0'));
    return { report: await readFile(join(dir, 'report.md'), 'utf8'), patch: await readFile(join(dir, 'patch.diff')) };
  }

  async #entries(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}
