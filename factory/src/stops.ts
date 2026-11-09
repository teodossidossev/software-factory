// The stops of a job and the actions it offers: one table, read by the Execution (which
// stop sf accept, sf retry and sf settle take on), the explanation's answers (explain.ts), the
// stats (stats.ts) and the dashboard's payloads (dashboard.ts), whose page renders what it
// receives and decides no rule of its own. A row per canonical stop code: its kind (a decision
// the user makes, or an error), the codes that share it (aliases), its group, whether the user
// settles ledger entries there, and its actions in order, each shown only while its precondition
// holds. job.error.code stays a string on disk: canonicalStop resolves it, and an unknown code is
// `other`. Pure: the caller reads the facts (the ledger, the last review and gate, the Git host).
import type { DashboardAction } from './dashboard-routes.js';
import { claudeReviews, type GateRecord, type Job, PAUSABLE_STATES, RESTARTABLE_STATES, type ReviewRecord, TERMINAL_STATES } from './jobs.js';
import type { LedgerEntry } from './ledger.js';
import { actedVerdict, type ReviewItem } from './review.js';
import { usageLimit } from './usage-limit.js';

export type StopKind = 'decision' | 'error';
// gate: the Codex gate stopped (sf accept overrides it); ledger: the ledger did; limit: the Fix
// round limit; simplify: the simplification pass's offer; tests: the workspace's tests.
export type StopGroup = 'gate' | 'ledger' | 'limit' | 'simplify' | 'tests';
// The dashboard's actions (POST api/jobs/<ws>/<ticket>/<action>), plus goon (Tell it to go on:
// say "Go on.") and review-mr (opens the Merge request screen; no command, never in a stop row).
export type ActionId = DashboardAction | 'goon' | 'review-mr';
// When a stop's action is shown: always; clean_review: Accept applies (acceptable); retryable and
// not_retryable: Retry applies, or does not (retryable).
export type Precondition = 'always' | 'clean_review' | 'retryable' | 'not_retryable';

export interface StopAction {
  id: Exclude<ActionId, 'review-mr'>;
  label: string;
  precondition: Precondition;
}

export interface StopRow {
  kind: StopKind;
  aliases: readonly string[];
  group: StopGroup | null;
  // The user settles the stop's ledger entries (Accept risk, Must fix); resumes: once none is left
  // to settle the job goes on by itself. A churn stop's settlement is only recorded.
  settle: { resumes: boolean } | null;
  actions: readonly StopAction[];
}

const action = (id: StopAction['id'], label: string, precondition: Precondition = 'always'): StopAction => ({ id, label, precondition });
const SEND = action('say', 'Send');
const GO_ON = action('goon', 'Tell it to go on');
const ABORT = action('abort', 'Abort…');
const RESTART = action('restart', 'Restart…');
const ACCEPT = action('accept', 'Accept and prepare MR', 'clean_review');
const RETRY = action('retry', 'Retry', 'retryable');

const row = (kind: StopKind, actions: StopAction[], extra: Partial<Omit<StopRow, 'kind' | 'actions'>> = {}): StopRow => ({
  kind, aliases: [], group: null, settle: null, actions, ...extra,
});

// The rows, in the order the derived lists keep (the accept codes as sf accept names them, the
// Retry rows as sf retry does). The
// dashboard's STOPS (static/board.js) has the words of each row, under the same keys.
export const STOPS = {
  escalated: row('decision', [SEND, ABORT], { settle: { resumes: true } }),
  gate_rounds: row('decision', [ACCEPT, SEND, ABORT], { group: 'gate' }),
  gate_budget: row('decision', [ACCEPT, SEND, ABORT], { group: 'gate' }),
  gate_failed: row('error', [ACCEPT, GO_ON, ABORT], { group: 'gate' }),
  review_churn: row('decision', [ACCEPT, SEND, ABORT], { group: 'ledger', settle: { resumes: false } }),
  review_disputed: row('decision', [ACCEPT, SEND, ABORT], { group: 'ledger', settle: { resumes: true } }),
  iteration_limit: row('decision', [ACCEPT, SEND, RESTART, ABORT], { group: 'limit' }),
  simplify_offered: row('decision', [action('simplify', 'Simplify'), action('accept', 'Skip'), SEND, ABORT], { group: 'simplify' }),
  tests_failed: row('decision', [ACCEPT, SEND, ABORT], { group: 'tests' }),
  fetch_failed: row('error', [RETRY, action('goon', 'Tell it to go on', 'not_retryable'), ABORT]),
  mr_serve_restarted: row('error', [RETRY, GO_ON, ABORT], { aliases: ['mr_interrupted'] }),
  mr_failed: row('error', [RETRY, GO_ON, ABORT], { aliases: ['mr_commit_failed', 'mr_rebase_failed'] }),
  // The guard's stops of MR preparation: sf retry runs new MR text turns, or the check
  // again after a fix of guard-terms.txt or auth.env.
  guard_hit: row('error', [RETRY, SEND, ABORT], { aliases: ['guard_terms_invalid', 'guard_failed'] }),
  tests_unavailable: row('error', [RETRY, ACCEPT, SEND, ABORT], { group: 'tests' }),
  max_turns: row('decision', [GO_ON, ABORT]),
  review_failed: row('error', [action('review', 'Retry review'), ABORT]),
  serve_restarted: row('error', [GO_ON, RESTART, ABORT]),
  // session_failed with the usage-limit message (canonicalStop).
  usage_limit: row('error', [GO_ON, ABORT]),
  session_failed: row('error', [GO_ON, RESTART, ABORT], { aliases: ['turn_failed', 'permission_mode_mismatch'] }),
  sandbox_unavailable: row('error', [GO_ON, ABORT]),
  publish_failed: row('error', [GO_ON, ABORT]),
  mr_conflict: row('error', [action('say', 'Tell it how'), ABORT]),
  mr_text_missing: row('error', [SEND, ABORT], { aliases: ['mr_text_invalid'] }),
  mr_empty: row('error', [SEND, ABORT]),
  worktree_remove_failed: row('error', [GO_ON, ABORT]),
  mr_push_failed: row('error', [action('approve', 'Push again'), ABORT]),
  // Renaming the branch is on the Merge request screen.
  mr_push_protected: row('error', [ABORT]),
  // Any other code.
  other: row('error', [SEND, ABORT]),
} satisfies Record<string, StopRow>;

export type StopCode = keyof typeof STOPS;
export const STOP_CODES = Object.keys(STOPS) as StopCode[];
const rowOf = (code: StopCode): StopRow => STOPS[code];

const ALIASES: ReadonlyMap<string, StopCode> = new Map(STOP_CODES.flatMap((code) => rowOf(code).aliases.map((alias) => [alias, code] as const)));

// The row of a stored code: an alias resolves to its row; session_failed with the Claude usage
// limit's message (usage-limit.ts, its first line) is usage_limit; an unknown code is other.
export function canonicalStop(code: string | null | undefined, message: string | null | undefined, now: Date): StopCode {
  if (code === 'session_failed' && usageLimit(message ?? '', now, 'claude') !== undefined) {
    return 'usage_limit';
  }
  if (typeof code !== 'string') {
    return 'other';
  }
  return Object.hasOwn(STOPS, code) ? (code as StopCode) : (ALIASES.get(code) ?? 'other');
}

// The canonical codes of a group's rows.
export function codesWith(group: StopGroup): StopCode[] {
  return STOP_CODES.filter((code) => rowOf(code).group === group);
}

// The canonical codes of the rows the user settles in, by whether the settlement resumes the job.
export function settleCodes(filter: { resumes: boolean }): StopCode[] {
  return STOP_CODES.filter((code) => rowOf(code).settle?.resumes === filter.resumes);
}

// The canonical codes of the rows that offer an action.
export function codesWithAction(id: StopAction['id']): StopCode[] {
  return STOP_CODES.filter((code) => rowOf(code).actions.some((candidate) => candidate.id === id));
}

// The stored codes of the rows that offer an action: each row's code, then its aliases.
export function storedCodesWithAction(id: StopAction['id']): string[] {
  return codesWithAction(id).flatMap((code) => [code, ...rowOf(code).aliases]);
}

// ---------- The rules of a job's actions ----------

// A review record without the items the ledger dropped, compared as written.
export function withoutDropped(record: { items: ReviewItem[]; dropped?: ReviewItem[] }): { items: ReviewItem[] } {
  const dropped = new Set((record.dropped ?? []).map((item) => JSON.stringify(item)));
  return { items: record.items.filter((item) => !dropped.has(JSON.stringify(item))) };
}

// Whether the merge request actions are on for the job's workspace: its Git host, or why not.
export interface MrHost {
  host: string | null;
  reason: string | null;
}

// What the rules read besides the job: the ledger, the Claude review and the gate of the last
// iteration (read only for a needs_human job), and the workspace's Git host.
export interface JobFacts {
  ledger: LedgerEntry[];
  review: ReviewRecord | undefined;
  gate?: GateRecord | undefined;
  mrHost?: MrHost | null;
}

export const NO_FACTS: JobFacts = { ledger: [], review: undefined, gate: undefined, mrHost: null };

// An action as the job page shows it, in order; primary: the first one, unless it is dangerous.
export interface ShownAction {
  action: ActionId;
  label: string;
  primary: boolean;
  danger: boolean;
}

export interface JobActions {
  actions: ShownAction[];
  // Every action's availability: '' when it applies to the job now, else why not, in one line.
  availability: Record<ActionId, string>;
}

// The actions whose availability is given, every one the page may ask.
export const ACTION_IDS: readonly ActionId[] = [
  'approve', 'abort', 'say', 'goon', 'review', 'retry', 'accept', 'settle', 'simplify', 'archive', 'mr-create', 'mr-merge', 'mr-status',
  'pause', 'resume', 'restart', 'handover', 'takeback', 'handed-done', 'mr-save', 'mr-reset', 'review-mr',
];

// The states that take a message (sf say), and the hand-over's actions with the state each takes.
const SAY_STATES: readonly string[] = ['working', 'awaiting_review', 'needs_human', 'ready_for_human_review', 'handed_over'];
const HANDOVER_STATES: Readonly<Partial<Record<ActionId, string>>> = { handover: 'ready_for_human_review', 'handed-done': 'handed_over', takeback: 'handed_over' };
// Pause, Resume and Restart: a job parked on a usage limit (waiting_limit) is
// resumed (Resume now) and restarted like a paused one.
const RESUME_STATES: readonly string[] = ['paused', 'waiting_limit'];

// The stop row of a needs_human job; null in any other state.
function stopRowOf(job: Job, now: Date): { code: StopCode; row: StopRow } | null {
  if (job.state !== 'needs_human') {
    return null;
  }
  const code = canonicalStop(job.error?.code, job.error?.message, now);
  return { code, row: rowOf(code) };
}

// A Claude review the factory acts on as clean: a verdict without a blocker or major item, the
// items the ledger dropped aside.
const actedClean = (review: ReviewRecord | undefined): boolean => review !== undefined && 'verdict' in review && actedVerdict(withoutDropped(review)) === 'clean';

// Accept applies on a row with an Accept (sf accept checks it again): at the Fix round limit
// whatever the last verdict, without the Claude review (the gate is the review), else
// with a clean Claude review of the last iteration.
function acceptable(job: Job, facts: JobFacts, now: Date): boolean {
  const stop = stopRowOf(job, now);
  if (stop === null || !stop.row.actions.some((candidate) => candidate.id === 'accept')) {
    return false;
  }
  return stop.row.group === 'limit' || !claudeReviews(job) || actedClean(facts.review);
}

// Retry applies: a stop whose row has Retry, never after a conflict turn, whose resolution
// no reviewer saw.
function retryable(job: Job, now: Date): boolean {
  const stop = stopRowOf(job, now);
  return stop !== null && stop.row.actions.some((candidate) => candidate.id === 'retry') && job.mr_conflict_turn !== true;
}

function holds(precondition: Precondition, job: Job, facts: JobFacts, now: Date): boolean {
  switch (precondition) {
    case 'always':
      return true;
    case 'clean_review':
      return acceptable(job, facts, now);
    case 'retryable':
      return retryable(job, now);
    case 'not_retryable':
      return !retryable(job, now);
  }
}

// The job can be pushed: the branch prepared at Clean is ready, or its push failed and approve
// tries again. The merge request on the Git host: Create merge request applies to a
// branch ready to approve (push, then open) and to a pushed one without an open or merged one;
// Merge to an open one.
const canApprove = (job: Job): boolean => job.state === 'ready_for_human_review' || job.state === 'handed_over' || (job.state === 'needs_human' && typeof job.prepared_commit === 'string');
const hasMr = (job: Job): boolean => job.mr !== null && typeof job.mr === 'object';
const canCreateMr = (job: Job): boolean => canApprove(job) || (job.state === 'pushed' && !(hasMr(job) && job.mr!.state !== 'closed'));
const canMerge = (job: Job): boolean => job.state === 'pushed' && hasMr(job) && job.mr!.state === 'open';
// Why the merge request actions are off for the job's workspace, or ''.
const mrOff = (host: MrHost | null | undefined): string => (host === null || host === undefined || typeof host !== 'object' ? 'the Git host is not known yet.'
  : typeof host.reason === 'string' && host.reason !== '' ? `${host.reason}.` : '');
// A job paused or parked on a usage limit during the Implementer's turn: its
// Resume takes the message.
const pausedTurn = (job: Job): boolean => RESUME_STATES.includes(job.state) && job.paused?.from === 'working';

const SETTLE_REASON = `only while a stop waits for you to settle ledger findings (${STOP_CODES.filter((code) => rowOf(code).settle !== null).join(', ')}).`;

// Why an action is unavailable for the job, or ''. The factory's own guards decide again.
function availabilityOf(id: ActionId, job: Job, facts: JobFacts, now: Date): string {
  const terminal = (TERMINAL_STATES as readonly string[]).includes(job.state);
  switch (id) {
    case 'review-mr':
      return job.state === 'ready_for_human_review' ? '' : 'no MR text yet: written at Clean.';
    case 'approve':
      if (canApprove(job)) {
        return '';
      }
      if (job.state === 'needs_human') {
        return 'approve pushes a branch prepared at Clean; this job has none yet.';
      }
      if (job.state === 'preparing_mr') {
        return 'the branch is being prepared.';
      }
      if (job.state === 'awaiting_review') {
        return 'the reviewers have not reached Clean yet.';
      }
      return `not available while the job is ${job.state}.`;
    case 'abort':
      return terminal ? `the job is already ${job.state}.` : '';
    case 'archive':
      return terminal ? '' : 'only a finished job is archived.';
    case 'pause':
      if (job.state === 'preparing_mr') {
        return 'the MR is being prepared (commit, rebase); it cannot be paused now.';
      }
      return (PAUSABLE_STATES as readonly string[]).includes(job.state) ? '' : 'only while the Implementer works or the reviewers review.';
    case 'resume':
      return RESUME_STATES.includes(job.state) ? '' : 'only for a paused job, or one waiting for limits.';
    case 'restart':
      return RESTARTABLE_STATES.includes(job.state) ? '' : 'only for a paused, waiting for limits, aborted, failed or needs_human job.';
    case 'mr-create':
      if (!canCreateMr(job)) {
        return hasMr(job) && job.state === 'pushed' ? `the merge request #${job.mr!.number} is ${job.mr!.state}.` : 'a merge request needs a pushed branch, or one ready to approve.';
      }
      return mrOff(facts.mrHost);
    case 'mr-merge':
      return canMerge(job) ? mrOff(facts.mrHost) : 'only an open merge request of a pushed job is merged.';
    case 'mr-status':
      return hasMr(job) ? mrOff(facts.mrHost) : 'no merge request yet.';
    case 'review':
      return stopRowOf(job, now)?.code === 'review_failed' ? '' : 'only after a failed review.';
    case 'retry':
      return retryable(job, now) ? '' : 'only after a transient MR preparation failure.';
    case 'simplify':
      return stopRowOf(job, now)?.row.group === 'simplify' ? '' : 'only when the simplification pass offers suggestions (simplify_offered).';
    case 'accept':
      return acceptable(job, facts, now)
        ? '' : 'only at the Fix round limit, or after the gate or the ledger stopped the job or when the simplification pass offered suggestions, with a clean Claude review (or none on the job).';
    case 'settle':
      return (stopRowOf(job, now)?.row.settle ?? null) !== null ? '' : SETTLE_REASON;
    case 'handover':
    case 'handed-done':
    case 'takeback': {
      const wanted = HANDOVER_STATES[id]!;
      return job.state === wanted ? '' : `only when the job is ${wanted}; it is ${job.state}.`;
    }
    default:
      // say, goon (a message "Go on.") and the Merge request screen's saves.
      if (job.state === 'paused') {
        return pausedTurn(job) ? 'the job is paused: Resume sends the message.' : 'the job is paused: Resume, then send the message.';
      }
      if (job.state === 'waiting_limit') {
        return pausedTurn(job) ? 'the job waits for limits: Resume now sends the message.' : 'the job waits for limits: Resume now, then send the message.';
      }
      return SAY_STATES.includes(job.state) ? '' : `messages need working, awaiting_review, needs_human, ready_for_human_review or handed_over; the job is ${job.state}.`;
  }
}

type Listed = { id: ActionId; label: string };
const listed = (id: ActionId, label: string): Listed => ({ id, label });

// The actions the job shows now, in order, without primary (a finished or handed-over job), or
// with the first non-dangerous one primary.
function shownActions(job: Job, facts: JobFacts, now: Date): { list: Listed[]; primary: boolean } {
  const mrCreate = canCreateMr(job) ? [listed('mr-create', 'Create merge request')] : [];
  switch (job.state) {
    case 'starting':
    case 'working':
    case 'awaiting_review':
      return { list: [SEND, listed('pause', 'Pause'), ABORT].map(toListed), primary: true };
    case 'paused':
      return { list: [listed('resume', 'Resume'), toListed(RESTART), toListed(ABORT)], primary: true };
    case 'waiting_limit':
      // No message waits for a parked job; Resume now carries it (from a turn).
      return { list: [listed('resume', 'Resume now'), toListed(ABORT)], primary: true };
    case 'ready_for_human_review':
      // The Merge request screen first; Approve… stays.
      return {
        list: [listed('review-mr', 'Review the MR and push'), listed('approve', 'Approve…'), listed('handover', 'Hand over to my checkout'), ...mrCreate, toListed(SEND), toListed(ABORT)],
        primary: true,
      };
    case 'handed_over':
      // Its actions are in the hand-over panel; the composer's row stays empty.
      return { list: [], primary: false };
    case 'needs_human': {
      const stop = stopRowOf(job, now)!;
      return { list: stop.row.actions.filter((candidate) => holds(candidate.precondition, job, facts, now)).map(toListed), primary: true };
    }
    case 'pushed':
      return {
        list: [...mrCreate, ...(canMerge(job) ? [listed('mr-merge', 'Merge…')] : []), ...(hasMr(job) ? [listed('mr-status', 'Refresh MR status')] : []), listed('archive', 'Archive')],
        primary: false,
      };
    case 'aborted':
    case 'failed':
      return { list: [toListed(RESTART), listed('archive', 'Archive')], primary: false };
    default:
      // preparing_mr: only Abort stops it.
      return { list: [toListed(ABORT)], primary: true };
  }
}

function toListed(item: StopAction | Listed): Listed {
  return { id: item.id, label: item.label };
}

// The actions the job page shows and every action's availability, for the job and its facts.
export function jobActions(job: Job, facts: JobFacts, now: Date): JobActions {
  const { list, primary } = shownActions(job, facts, now);
  const actions = list.map((item, index) => {
    const danger = item.id === 'abort';
    return { action: item.id, label: item.label, primary: primary && index === 0 && !danger, danger };
  });
  const availability = Object.fromEntries(ACTION_IDS.map((id) => [id, availabilityOf(id, job, facts, now)])) as Record<ActionId, string>;
  return { actions, availability };
}

// The ledger entries the user settles at the job's stop, each with Accept risk and Must fix: those
// sf settle takes (escalated or contested), on a row the user settles in; none otherwise.
export function settleEntries(job: Job, ledger: LedgerEntry[], now: Date): LedgerEntry[] {
  return (stopRowOf(job, now)?.row.settle ?? null) !== null ? ledger.filter((entry) => entry.status === 'escalated' || entry.status === 'contested') : [];
}

// What the dashboard's payloads carry of a job's stop: its canonical code, kind and group (null
// unless the job is needs_human).
export function stopFields(job: Job, now: Date): { stop_code: StopCode | null; stop_kind: StopKind | null; stop_group: StopGroup | null } {
  const stop = stopRowOf(job, now);
  return { stop_code: stop?.code ?? null, stop_kind: stop?.row.kind ?? null, stop_group: stop?.row.group ?? null };
}
