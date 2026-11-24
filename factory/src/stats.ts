// The Stats page: the factory's numbers over 7, 30 or 90 local days, computed from the
// state directory and only read from it. What each review stage found and what of it was fixed,
// how often the Codex gate caught what the Claude review passed (and the other way round), the
// cost and the tokens per day, workspace and role, the jobs running and waiting now, the Claude
// review experiment's two arms and the simplification's offers taken, and the warnings
// when a job, a stage or a day is far from the usual. The payload holds numbers, times,
// workspace names, tickets, job directory names, states, Task titles and the warnings' own
// sentences; never a review's text, a prompt, a message or a setting.
//
// Every cost and token count is on the local day of its own record. Job directories are read once
// and kept until a file of theirs changes (a signature of their stats); an event log is read on
// from where the last read ended; a payload is kept for STATS_CACHE_MS. An unreadable file never
// stops a computation: it counts once in notes.unreadable and adds nothing.
import { type FileHandle, open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DIGEST_ID, DigestStore } from './digest-run.js';
import { explanationPath, readExplanation } from './explain.js';
import { GATE_REVIEWER } from './gate.js';
import { type GateTokens, type Job, type JobDir, type JobState, type JobStore, RUNNING_STATES, statesWith, TERMINAL_STATES } from './jobs.js';
import { type LedgerEntry, SIMPLIFIER } from './ledger.js';
import { localTime } from './local-time.js';
import { entryOf, type Outcome, type Outcomes, outcomeOf } from './metrics.js';
import { QueueStore } from './queue.js';
import { REVIEWER, type ReviewItem, type Severity } from './review.js';
import { codesWith } from './stops.js';
import { type CheckMode, recordMode } from './task-check.js';
import { parseFrontMatter } from './task-file.js';

// The periods the page offers, in local days ending today.
export const STATS_DAYS = [7, 30, 90] as const;
export type StatsDays = (typeof STATS_DAYS)[number];
// The most job directories one computation reads: the newest by created_at.
export const STATS_MAX_JOBS = 1000;
// An event log larger than this is not read: its job's tokens and time to ready are unknown.
export const STATS_MAX_EVENTS_BYTES = 256 * 1024 * 1024;
// How long a finished payload is served again.
export const STATS_CACHE_MS = 10_000;
// The warnings of a job: its reference is the last REFERENCE_JOBS finished jobs of its
// workspace, and there is no warning with fewer than MIN_REFERENCE_JOBS of them.
export const REFERENCE_JOBS = 30;
export const MIN_REFERENCE_JOBS = 5;
// A job is unusual on a measure above JOB_FACTOR times its reference's median, and on its cost
// or iterations only from these floors.
export const JOB_FACTOR = 3;
const JOB_MIN_COST_USD = 5;
const JOB_MIN_ITERATIONS = 5;
// The job and review-churn warnings concern only the jobs last updated on the WARN_RECENT_DAYS
// local days ending today, whatever the period.
export const WARN_RECENT_DAYS = 7;
// A stage whose FAILING_RUNS newest runs all failed is a warning.
export const FAILING_RUNS = 3;

// The roles whose cost or tokens are counted, in the order of the page's rows.
export const ROLES = ['implementer', 'claude_review', 'simplify', 'codex_gate', 'task_check', 'digest', 'explanation'] as const;
export type Role = (typeof ROLES)[number];
// The roles with a cost in USD (the Codex gate has tokens only).
export type CostRole = Exclude<Role, 'codex_gate'>;
const COST_ROLES: readonly CostRole[] = ['implementer', 'claude_review', 'simplify', 'task_check', 'digest', 'explanation'];
// The roles of a job directory.
type JobCostRole = 'implementer' | 'claude_review' | 'simplify' | 'explanation';

export type Findings = Record<Severity, number>;
// The tokens of a Claude session: input with the cache reads and writes, and output.
export interface ClaudeTokens {
  input: number;
  output: number;
}

export interface StatsQuery {
  days: StatsDays;
  // One workspace, or null for every workspace.
  workspace: string | null;
}

export interface DayRow {
  day: string;
  cost: Record<CostRole, number>;
  codex_tokens: GateTokens;
  started: number;
  finished: number;
}

export interface RoleRow {
  role: Role;
  // null for the Codex gate.
  cost_usd: number | null;
  // false when a record of the period had no cost.
  complete: boolean;
  // null when the role records none.
  tokens: ClaudeTokens | GateTokens | null;
  runs: number;
}

export interface WorkspaceRow {
  workspace: string;
  cost: Record<Exclude<CostRole, 'digest'>, number>;
  total_usd: number;
  // input + output.
  codex_tokens: number;
  jobs_started: number;
  median_time_to_ready_s: number | null;
}

export type Stage = 'claude_review' | 'codex_gate' | 'task_check';

export interface StageRow {
  stage: Stage;
  runs: number;
  failed: number;
  findings: Findings;
  // null for the plan check.
  outcomes: Outcomes | null;
  // The plan check only: the checks with a blocker or major after which the Task was revised; null otherwise.
  revised: number | null;
  // outcomes.fixed, or revised for the plan check.
  fixed: number;
  // The plan check only: the distinct tickets with a check record in the period; null otherwise.
  tickets: number | null;
  cost_usd: number | null;
  tokens: ClaudeTokens | GateTokens | null;
}

// The plan check by how its Claude check ran: full or follow_up; a record without mode counts as
// full.
export interface TaskCheckModeRow {
  mode: CheckMode;
  // The checks of the mode that ended in the period, as the plan check's StageRow counts them: ok
  // ones (runs) and failed ones; the sum of the known costs of both, false when one is unknown;
  // cost_usd / runs, null with no run.
  runs: number;
  failed: number;
  cost_usd: number;
  cost_complete: boolean;
  usd_per_run: number | null;
  // The quality signal: the tickets started in the period (each once, by its latest job started
  // in it) whose last check that ended before that job's start, failed or not, ran in this mode
  // (full for a ticket with no such check), and those of them whose job needed more than 2
  // iterations; over_two / started, null with none.
  started: number;
  over_two: number;
  over_two_share: number | null;
}

export interface SecondOpinionCase {
  workspace: string;
  ticket: string;
  dir: string;
  archived: boolean;
  iteration: number;
  findings: number;
  fixed: number;
}

export interface SecondOpinion {
  iterations: number;
  caught: number;
  findings: number;
  fixed: number;
  // The caught iterations, newest first, at most MAX_CASES.
  cases: SecondOpinionCase[];
}

export interface JobRow {
  workspace: string;
  ticket: string;
  dir: string;
  archived: boolean;
  title: string | null;
  state: JobState;
  created_at: string;
  iterations: number;
  cost_usd: number;
  cost_complete: boolean;
  codex_tokens: number;
  claude: Findings;
  codex: Findings;
  time_to_ready_s: number | null;
  // The plan checks of its workspace and ticket, all-time: every record, failed ones
  // included; the sum of their known costs; false when a cost is unknown.
  plan_checks: number;
  plan_check_usd: number;
  plan_check_usd_complete: boolean;
  // From job.json: whether the Claude review ran on the job; null for a job.json written before
  // that field.
  claude_review: boolean | null;
}

// One arm of the Claude review experiment: the jobs started in the period whose
// claude_review is true (on) or false (off).
export interface ArmRow {
  arm: 'on' | 'off';
  jobs: number;
  // In pushed or handed_over.
  delivered: number;
  aborted: number;
  // The sum of its jobs' JobRow.cost_usd; false when one of them is incomplete.
  cost_usd: number;
  cost_complete: boolean;
  // null with none delivered.
  usd_per_delivered: number | null;
  // Of the delivered jobs; null with none.
  median_iterations: number | null;
  // The Codex gate's blockers and majors of its jobs (JobRow.codex).
  codex_findings: number;
  // null with no job.
  codex_findings_per_job: number | null;
}

// The simplification pass in the period: the records with a suggestion, and the user's
// choices.
export interface SimplifyCounts {
  offered: number;
  taken: number;
  skipped: number;
}

export type WarningKind = 'job_unusual' | 'review_churn' | 'stage_failing' | 'cost_spike';

export type WarningTarget =
  | { kind: 'job'; workspace: string; ticket: string; archived: boolean }
  | { kind: 'ticket'; workspace: string; ticket: string }
  | { kind: 'digest'; id: string };

export interface StatsWarning {
  kind: WarningKind;
  text: string;
  // The ISO time it concerns.
  at: string;
  target: WarningTarget | null;
}

export interface StatsNotes {
  // The job directories left out beyond maxJobs.
  truncated: number;
  unreadable: number;
  events_skipped: number;
  // A workspace is chosen: the digests (which have none) are not counted.
  digest_excluded: boolean;
}

export interface StatsPayload {
  generated_at: string;
  days: StatsDays;
  workspace: string | null;
  // Local days, inclusive.
  period: { from: string; to: string };
  workspaces: string[];
  now: { running: number; waiting_for_you: number; paused: number; queued: number | null };
  totals: {
    cost_usd: number;
    codex_tokens: GateTokens;
    jobs_started: number;
    jobs_finished: { total: number; pushed: number; aborted: number; failed: number };
    median_time_to_ready_s: number | null;
    median_iterations: number | null;
  };
  days_rows: DayRow[];
  roles: RoleRow[];
  by_workspace: WorkspaceRow[];
  stages: StageRow[];
  // Full, then follow_up.
  task_check_modes: TaskCheckModeRow[];
  second_opinion: { codex_after_claude: SecondOpinion; claude_after_codex: SecondOpinion };
  // On, then off; a job without claude_review is in neither.
  arms: ArmRow[];
  simplify: SimplifyCounts;
  jobs: JobRow[];
  warnings: StatsWarning[];
  notes: StatsNotes;
}

export interface StatsOptions {
  now?: () => Date;
  maxJobs?: number;
}

// The most cases per second-opinion card and rows in the jobs list.
const MAX_CASES = 50;
const MAX_JOB_ROWS = 200;
// The days before the period the cost-spike rule looks at.
const SPIKE_DAYS = 30;
const WAITING_STATES = statesWith('waiting');
const READY_STATES: readonly string[] = statesWith('ready');
const CHURN_CODES: readonly string[] = codesWith('ledger');
// Only the event lines with one of these are parsed.
const EVENT_MARKS = ['"type":"result"', '"type":"review"', '"type":"review_failed"', '"type":"simplify_chosen"', '"state":{'];
const DELIVERED_STATES = statesWith('delivered');
const CHECK_FILE = /^[0-9a-f]{16}\.json$/;
const READ_CHUNK = 1024 * 1024;

// ---------- Small helpers ----------

const pad = (value: number): string => String(value).padStart(2, '0');
const dateOf = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
// The local day of a stored time, or undefined.
const dayOf = (ts: unknown): string | undefined => localTime(ts)?.slice(0, 10);

// The count local days ending today, oldest first.
function localDays(now: Date, count: number): string[] {
  const days: string[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    days.push(dateOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)));
  }
  return days;
}

// The ISO time of a local day's midnight.
function midnight(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, date).toISOString();
}

// The median of the values: the mean of the middle two of an even count; null of none.
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const costOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const noFindings = (): Findings => ({ blocker: 0, major: 0, nit: 0 });
const noOutcomes = (): Outcomes => ({ fixed: 0, contested: 0, accepted: 0, nit: 0, open: 0 });
const noGateTokens = (): GateTokens => ({ input: 0, cached_input: 0, output: 0 });
const noClaudeTokens = (): ClaudeTokens => ({ input: 0, output: 0 });
const isTerminal = (state: JobState): boolean => TERMINAL_STATES.includes(state);
const sumCosts = (cost: Record<string, number>): number => Object.values(cost).reduce((total, value) => total + value, 0);

// The texts' formats: $ and two decimals; 1.2M, 340k or the plain number; a median count.
export const money = (value: number): string => `$${value.toFixed(2)}`;
export function tokenText(value: number): string {
  if (value >= 999_500) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value));
}
const countText = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));
// "on YYYY-MM-DD at HH:MM" of a stored time.
const onAt = (ts: string): string => {
  const local = localTime(ts) ?? ts;
  return `on ${local.slice(0, 10)} at ${local.slice(11, 16)}`;
};

// ---------- What one job directory holds (everything but its events) ----------

interface ItemSummary {
  severity: Severity;
  outcome: Outcome;
  // The ledger entry the item counts under, or null.
  entry: string | null;
  // caused_by set: the item came from a fix.
  caused: boolean;
}

// A verdict record (review.json or gate.json): its time and its items.
interface VerdictSummary {
  at: string;
  items: ItemSummary[];
}

interface JobSummary {
  signature: string;
  title: string | null;
  costs: Array<{ role: JobCostRole; at: string; cost: number | null }>;
  // Every gate.json, a verdict or a failed run.
  gateRuns: Array<{ at: string; tokens: GateTokens }>;
  reviews: Map<number, VerdictSummary>;
  gates: Map<number, VerdictSummary>;
  // Every simplify.json: failed, or how many suggestions it offered.
  simplifies: Array<{ at: string; failed: boolean; suggestions: number }>;
  explanation: { at: string; failed: boolean } | null;
  // The ledger entry reopened most (at least twice), or null.
  churn: { id: string; reopened: number } | null;
  unreadable: number;
}

// What the event log adds: tokens by role and day, the reviewers' runs, the first ready line, the
// ledger stops and the user's simplification choices.
interface EventSums {
  tokens: Map<string, ClaudeTokens>;
  runs: Array<{ ts: string; reviewer: string; failed: boolean }>;
  ready: string | null;
  stops: Array<{ ts: string; code: string }>;
  chosen: Array<{ ts: string; choice: 'simplify' | 'skip' }>;
}

interface EventsCache {
  size: number;
  // The end of the last complete line read.
  offset: number;
  sums: EventSums;
}

interface CheckRow {
  workspace: string;
  ticket: string;
  sha256: string;
  status: 'checked' | 'failed';
  // full for a record without mode or with one not known.
  mode: CheckMode;
  findings: Findings;
  cost: number | null;
  started_at: string;
  ended_at: string;
}

type ReadableDir = JobDir & { job: Job };

// One job directory read for the computation.
interface JobData {
  dir: ReadableDir;
  job: Job;
  key: string;
  summary: JobSummary;
  // null when the events were not read (outside the window, too large, unreadable).
  events: EventSums | null;
}

const emptySums = (): EventSums => ({ tokens: new Map(), runs: [], ready: null, stops: [], chosen: [] });
const copySums = (sums: EventSums): EventSums => ({
  tokens: new Map([...sums.tokens].map(([key, value]) => [key, { ...value }])), runs: [...sums.runs], ready: sums.ready, stops: [...sums.stops], chosen: [...sums.chosen],
});
const tokenKey = (role: string, day: string): string => `${role}\n${day}`;

// The tokens of an SDK result message, or undefined when it is not one.
function resultTokens(message: unknown): ClaudeTokens | undefined {
  if (!isObject(message) || message.type !== 'result') {
    return undefined;
  }
  const usage = isObject(message.usage) ? message.usage : {};
  return {
    input: count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens),
    output: count(usage.output_tokens),
  };
}

// One line of events.jsonl into the sums; a line of another kind or shape adds nothing.
function addLine(sums: EventSums, line: string): void {
  if (!EVENT_MARKS.some((mark) => line.includes(mark))) {
    return;
  }
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch { // not a JSON line: adds nothing
    return;
  }
  if (!isObject(record) || typeof record.ts !== 'string' || typeof record.iteration !== 'number') {
    return;
  }
  const { ts } = record;
  const day = dayOf(ts);
  if (day === undefined) {
    return;
  }
  const add = (role: Role, tokens: ClaudeTokens): void => {
    const key = tokenKey(role, day);
    const sum = sums.tokens.get(key) ?? noClaudeTokens();
    sums.tokens.set(key, { input: sum.input + tokens.input, output: sum.output + tokens.output });
  };
  if (record.type === undefined && 'message' in record) {
    const tokens = resultTokens(record.message);
    if (tokens !== undefined) {
      add('implementer', tokens);
    }
    return;
  }
  if (record.type === 'review_message') {
    const tokens = resultTokens(record.message);
    const role = record.reviewer === REVIEWER ? 'claude_review' : record.reviewer === SIMPLIFIER ? 'simplify' : undefined;
    if (tokens !== undefined && role !== undefined) {
      add(role, tokens);
    }
    return;
  }
  if ((record.type === 'review' || record.type === 'review_failed') && typeof record.reviewer === 'string' && record.ignored !== true) {
    sums.runs.push({ ts, reviewer: record.reviewer, failed: record.type === 'review_failed' });
    return;
  }
  if (record.type === 'simplify_chosen') {
    if (record.choice === 'simplify' || record.choice === 'skip') {
      sums.chosen.push({ ts, choice: record.choice });
    }
    return;
  }
  if (record.type === undefined && isObject(record.state) && typeof record.state.to === 'string') {
    if (sums.ready === null && READY_STATES.includes(record.state.to)) {
      sums.ready = ts;
    }
    const error = record.state.error;
    if (isObject(error) && typeof error.code === 'string' && CHURN_CODES.includes(error.code)) {
      sums.stops.push({ ts, code: error.code });
    }
  }
}

const blocks = (item: { severity: Severity }): boolean => item.severity !== 'nit';
const findingsOf = (items: readonly { severity: Severity }[]): Findings => {
  const findings = noFindings();
  for (const item of items) {
    findings[item.severity] += 1;
  }
  return findings;
};
const addFindings = (to: Findings, from: Findings): void => {
  to.blocker += from.blocker;
  to.major += from.major;
  to.nit += from.nit;
};

// A verdict record's items with their outcomes, or undefined when it is not a usable verdict.
function verdictOf(record: unknown, iteration: number, reviewer: string, ledger: readonly LedgerEntry[] | undefined): VerdictSummary | undefined {
  if (!isObject(record) || !('verdict' in record) || !Array.isArray(record.items) || typeof record.ended_at !== 'string') {
    return undefined;
  }
  const items = (record.items as ReviewItem[]).filter(isObject).map((item): ItemSummary => {
    const entry = ledger === undefined ? undefined : entryOf(ledger, iteration, item, reviewer);
    const severity: Severity = item.severity ?? 'major';
    // An unreadable ledger leaves every item open, as sf metrics does.
    const outcome = ledger === undefined ? 'open' : outcomeOf(entry?.severity ?? severity, entry?.status);
    return { severity, outcome, entry: entry?.id ?? null, caused: typeof item.caused_by === 'string' && item.caused_by !== '' };
  });
  return { at: record.ended_at, items };
}

// The number of a ledger id (R12: 12), to order ids.
const ledgerNumber = (id: string): number => Number(id.slice(1));

// ---------- The computation ----------

export class Stats {
  // The full reads of a job directory's files (tests).
  jobReads = 0;
  readonly #stateDir: string;
  readonly #jobs: JobStore;
  readonly #now: () => Date;
  readonly #maxJobs: number;
  readonly #digests: DigestStore;
  readonly #summaries = new Map<string, JobSummary>();
  readonly #events = new Map<string, EventsCache>();
  readonly #checks = new Map<string, { signature: string; record: CheckRow | null }>();
  readonly #payloads = new Map<string, { at: number | null; payload: Promise<StatsPayload> }>();
  // One computation at a time: the caches are never read and changed by two at once.
  #chain: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string, jobs: JobStore, options: StatsOptions = {}) {
    this.#stateDir = stateDir;
    this.#jobs = jobs;
    this.#now = options.now ?? (() => new Date());
    this.#maxJobs = options.maxJobs ?? STATS_MAX_JOBS;
    this.#digests = new DigestStore(stateDir);
  }

  // The payload of the query: a finished one of the last STATS_CACHE_MS, the one being computed,
  // or a new one.
  compute(query: StatsQuery): Promise<StatsPayload> {
    const key = `${query.days}\n${query.workspace ?? ''}`;
    const kept = this.#payloads.get(key);
    if (kept !== undefined && (kept.at === null || this.#now().getTime() - kept.at < STATS_CACHE_MS)) {
      return kept.payload;
    }
    const entry: { at: number | null; payload: Promise<StatsPayload> } = { at: null, payload: Promise.resolve(undefined as never) };
    const run = this.#chain.then(() => this.#compute(query));
    this.#chain = run.catch(() => undefined);
    entry.payload = run.then(
      (payload) => {
        entry.at = this.#now().getTime();
        return payload;
      },
      (error: unknown) => {
        if (this.#payloads.get(key) === entry) {
          this.#payloads.delete(key);
        }
        throw error;
      },
    );
    this.#payloads.set(key, entry);
    return entry.payload;
  }

  // The signature of a job directory's stats: mtimeMs:size of its files, mtimeMs of its iterations.
  async #signature(dir: ReadableDir): Promise<string> {
    const base = this.#jobs.dir(dir.workspace, dir.name);
    const file = async (path: string): Promise<string> => {
      try {
        const info = await stat(path);
        return `${info.mtimeMs}:${info.size}`;
      } catch { // a missing or unreadable file: signature 0:0
        return '0:0';
      }
    };
    const iteration = async (number: number): Promise<string> => {
      try {
        return String((await stat(this.#jobs.iterationDir(dir.workspace, dir.name, number))).mtimeMs);
      } catch { // a missing or unreadable iteration: signature 0
        return '0';
      }
    };
    const numbers = Array.from({ length: dir.job.iteration }, (_, index) => index + 1);
    const parts = await Promise.all([
      ...['job.json', 'ledger.json', 'task.md'].map((name) => file(join(base, name))),
      file(explanationPath(this.#jobs, dir.workspace, dir.name)),
      ...numbers.map(iteration),
    ]);
    return parts.join('|');
  }

  // The job directory's summary: kept while its signature holds, else read again.
  async #summary(dir: ReadableDir, key: string): Promise<JobSummary> {
    const signature = await this.#signature(dir);
    const kept = this.#summaries.get(key);
    if (kept !== undefined && kept.signature === signature) {
      return kept;
    }
    const summary = await this.#readJob(dir, signature);
    this.jobReads += 1;
    this.#summaries.set(key, summary);
    return summary;
  }

  async #readJob(dir: ReadableDir, signature: string): Promise<JobSummary> {
    const { workspace, name, job } = dir;
    const jobs = this.#jobs;
    let unreadable = 0;
    const attempt = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await read();
      } catch { // counted in the job's unreadable
        unreadable += 1;
        return undefined;
      }
    };
    const summary: JobSummary = {
      signature, title: null, costs: [], gateRuns: [], reviews: new Map(), gates: new Map(), simplifies: [], explanation: null, churn: null, unreadable: 0,
    };
    const ledger = await attempt(() => jobs.readLedger(workspace, name));
    for (let number = 1; number <= job.iteration; number += 1) {
      const meta = await attempt(() => jobs.readMeta(workspace, name, number));
      if (meta !== undefined) {
        if (isObject(meta) && typeof meta.ended_at === 'string') {
          summary.costs.push({ role: 'implementer', at: meta.ended_at, cost: costOf(meta.cost_usd) });
        } else {
          unreadable += 1;
        }
      }
      const review = await attempt(() => jobs.readReview(workspace, name, number));
      const reviewVerdict = verdictOf(review, number, REVIEWER, ledger);
      if (reviewVerdict !== undefined) {
        summary.reviews.set(number, reviewVerdict);
        summary.costs.push({ role: 'claude_review', at: reviewVerdict.at, cost: costOf((review as { cost_usd?: unknown }).cost_usd) });
      }
      const gate = await attempt(() => jobs.readGate(workspace, name, number));
      if (gate !== undefined) {
        if (isObject(gate) && typeof gate.ended_at === 'string') {
          const tokens: Record<string, unknown> = isObject(gate.tokens) ? gate.tokens : {};
          summary.gateRuns.push({ at: gate.ended_at, tokens: { input: count(tokens.input), cached_input: count(tokens.cached_input), output: count(tokens.output) } });
          const gateVerdict = verdictOf(gate, number, GATE_REVIEWER, ledger);
          if (gateVerdict !== undefined) {
            summary.gates.set(number, gateVerdict);
          }
        } else {
          unreadable += 1;
        }
      }
      const simplify = await attempt(() => jobs.readSimplify(workspace, name, number));
      if (simplify !== undefined) {
        if (isObject(simplify) && typeof simplify.ended_at === 'string') {
          const succeeded = 'summary' in simplify;
          const suggestions = succeeded && Array.isArray(simplify.suggestions) ? simplify.suggestions.length : 0;
          summary.simplifies.push({ at: simplify.ended_at, failed: !succeeded, suggestions });
          if (succeeded) {
            summary.costs.push({ role: 'simplify', at: simplify.ended_at, cost: costOf((simplify as { cost_usd?: unknown }).cost_usd) });
          }
        } else {
          unreadable += 1;
        }
      }
    }
    const explanation = await readExplanation(jobs, workspace, name);
    // readExplanation reads an invalid file as none: one that exists counts as unreadable.
    if (explanation === undefined && await stat(explanationPath(jobs, workspace, name)).then(() => true, () => false)) {
      unreadable += 1;
    }
    if (explanation !== undefined && explanation.ended_at !== null) {
      summary.costs.push({ role: 'explanation', at: explanation.ended_at, cost: costOf(explanation.cost_usd) });
      summary.explanation = { at: explanation.ended_at, failed: explanation.error !== null };
    }
    const task = await attempt(() => jobs.readTaskCopy(workspace, name));
    summary.title = (task === undefined ? undefined : parseFrontMatter(task)?.get('title')) ?? null;
    for (const entry of ledger ?? []) {
      const most = summary.churn;
      if (entry.reopened >= 2 && (most === null || entry.reopened > most.reopened || (entry.reopened === most.reopened && ledgerNumber(entry.id) < ledgerNumber(most.id)))) {
        summary.churn = { id: entry.id, reopened: entry.reopened };
      }
    }
    summary.unreadable = unreadable;
    return summary;
  }

  // The sums of a job's events.jsonl, read on from the last complete line; 'skipped' when it is
  // too large, null when it cannot be read.
  async #eventSums(dir: ReadableDir, key: string): Promise<EventSums | 'skipped' | null> {
    const path = this.#jobs.eventsPath(dir.workspace, dir.name);
    let handle: FileHandle;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      this.#events.delete(key);
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? emptySums() : null;
    }
    try {
      const { size } = await handle.stat();
      if (size > STATS_MAX_EVENTS_BYTES) {
        this.#events.delete(key);
        return 'skipped';
      }
      let kept = this.#events.get(key);
      if (kept === undefined || size < kept.size) {
        kept = { size: 0, offset: 0, sums: emptySums() };
      }
      if (size === kept.size) {
        return kept.sums;
      }
      const sums = copySums(kept.sums);
      let offset = kept.offset;
      let carry = Buffer.alloc(0);
      let position = kept.offset;
      while (position < size) {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK, size - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) {
          break;
        }
        position += bytesRead;
        const data = carry.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
        let start = 0;
        for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
          addLine(sums, data.toString('utf8', start, end));
          start = end + 1;
        }
        offset += start;
        carry = data.subarray(start);
      }
      this.#events.set(key, { size, offset, sums });
      return sums;
    } catch { // a read error: null, as the file cannot be read
      return null;
    } finally {
      await handle.close();
    }
  }

  // Every Task check record under checks/<ws>/<ticket>/, kept by path while mtimeMs:size holds.
  async #checkRecords(): Promise<{ records: CheckRow[]; unreadable: number }> {
    const root = join(this.#stateDir, 'checks');
    const dirs = async (path: string): Promise<string[]> => {
      try {
        return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      } catch { // a missing or unreadable directory: none
        return [];
      }
    };
    const records: CheckRow[] = [];
    const seen = new Set<string>();
    let unreadable = 0;
    for (const workspace of await dirs(root)) {
      for (const ticket of await dirs(join(root, workspace))) {
        let names: string[];
        try {
          names = (await readdir(join(root, workspace, ticket))).filter((name) => CHECK_FILE.test(name)).sort();
        } catch { // a ticket directory gone or unreadable: no records from it
          continue;
        }
        for (const name of names) {
          const path = join(root, workspace, ticket, name);
          seen.add(path);
          let signature: string;
          try {
            const info = await stat(path);
            signature = `${info.mtimeMs}:${info.size}`;
          } catch { // gone or unreadable: counted in unreadable
            unreadable += 1;
            continue;
          }
          let kept = this.#checks.get(path);
          if (kept === undefined || kept.signature !== signature) {
            kept = { signature, record: await readCheck(path, workspace, ticket) };
            this.#checks.set(path, kept);
          }
          if (kept.record === null) {
            unreadable += 1;
          } else {
            records.push(kept.record);
          }
        }
      }
    }
    for (const path of this.#checks.keys()) {
      if (!seen.has(path)) {
        this.#checks.delete(path);
      }
    }
    return { records, unreadable };
  }

  // The digests' summaries, and how many stored records could not be read: DigestStore.list()
  // leaves out a record it cannot read, so each id named by a file of digest/ and missing from the
  // list (or listed without an end) counts once; a failed list counts once.
  async #digestRecords(): Promise<{ records: Array<{ id: string; cost_usd: number | null; error: string | null; ended_at: string }>; unreadable: number }> {
    let listed;
    try {
      listed = await this.#digests.list();
    } catch { // a failed list counts once in unreadable
      return { records: [], unreadable: 1 };
    }
    const records = listed.filter((digest) => typeof digest.ended_at === 'string');
    let names: string[];
    try {
      names = (await readdir(this.#digests.dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (error) {
      return { records, unreadable: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : 1 };
    }
    const read = new Set(records.map((digest) => digest.id));
    const unreadable = names.filter((name) => name.endsWith('.json') && DIGEST_ID.test(name.slice(0, -5)) && !read.has(name.slice(0, -5))).length;
    return { records, unreadable };
  }

  async #compute(query: StatsQuery): Promise<StatsPayload> {
    const now = this.#now();
    const { workspace } = query;
    const periodDays = localDays(now, query.days);
    const windowDays = localDays(now, query.days + SPIKE_DAYS);
    const from = periodDays[0]!;
    const to = periodDays[periodDays.length - 1]!;
    const windowFrom = windowDays[0]!;
    const inPeriod = (ts: unknown): boolean => {
      const day = dayOf(ts);
      return day !== undefined && day >= from && day <= to;
    };
    const recentDays = new Set(localDays(now, WARN_RECENT_DAYS));
    const recent = (ts: unknown): boolean => recentDays.has(dayOf(ts) ?? '');
    const chosen = (name: string): boolean => workspace === null || name === workspace;
    const notes: StatsNotes = { truncated: 0, unreadable: 0, events_skipped: 0, digest_excluded: workspace !== null };

    // The job directories of the workspace filter, the newest maxJobs.
    const dirs = await this.#jobs.listAll();
    const present = new Set(dirs.map((dir) => `${dir.workspace}/${dir.name}`));
    for (const cache of [this.#summaries, this.#events]) {
      for (const key of cache.keys()) {
        if (!present.has(key)) {
          cache.delete(key);
        }
      }
    }
    let readable: ReadableDir[] = [];
    for (const dir of dirs) {
      if (!chosen(dir.workspace)) {
        continue;
      }
      if (dir.job === undefined) {
        notes.unreadable += 1;
      } else {
        readable.push(dir as ReadableDir);
      }
    }
    readable.sort((a, b) => b.job.created_at.localeCompare(a.job.created_at));
    if (readable.length > this.#maxJobs) {
      notes.truncated = readable.length - this.#maxJobs;
      readable = readable.slice(0, this.#maxJobs);
    }
    const read: JobData[] = [];
    for (const dir of readable) {
      const key = `${dir.workspace}/${dir.name}`;
      const summary = await this.#summary(dir, key);
      notes.unreadable += summary.unreadable;
      let events: EventSums | null = null;
      if ((dayOf(dir.job.updated_at) ?? '') >= windowFrom || !isTerminal(dir.job.state)) {
        const sums = await this.#eventSums(dir, key);
        if (sums === 'skipped') {
          notes.events_skipped += 1;
        } else if (sums === null) {
          notes.unreadable += 1;
        } else {
          events = sums;
        }
      }
      read.push({ dir, job: dir.job, key, summary, events });
    }

    const checks = await this.#checkRecords();
    notes.unreadable += checks.unreadable;
    const checkRecords = checks.records.filter((record) => chosen(record.workspace));
    let digests: Array<{ id: string; cost_usd: number | null; error: string | null; ended_at: string }> = [];
    if (workspace === null) {
      const listed = await this.#digestRecords();
      digests = listed.records;
      notes.unreadable += listed.unreadable;
    }

    // The sums: cost and tokens by day, role and workspace.
    const rows = new Map<string, DayRow>(periodDays.map((day) => [day, {
      day, cost: { implementer: 0, claude_review: 0, simplify: 0, task_check: 0, digest: 0, explanation: 0 }, codex_tokens: noGateTokens(), started: 0, finished: 0,
    }]));
    const roles = new Map<Role, RoleRow>(ROLES.map((role) => [role, {
      role, cost_usd: role === 'codex_gate' ? null : 0, complete: true,
      tokens: role === 'codex_gate' ? noGateTokens() : ['implementer', 'claude_review', 'simplify'].includes(role) ? noClaudeTokens() : null, runs: 0,
    }]));
    const workspaceNames = await this.#jobs.workspaceNames();
    const byWorkspace = new Map<string, WorkspaceRow & { ready: number[] }>((workspace === null ? workspaceNames : [workspace]).map((name) => [name, {
      workspace: name, cost: { implementer: 0, claude_review: 0, simplify: 0, task_check: 0, explanation: 0 }, total_usd: 0, codex_tokens: 0, jobs_started: 0,
      median_time_to_ready_s: null, ready: [],
    }]));
    // The cost of every day of the window (the cost-spike rule) and of each job on each day of the period.
    const windowCost = new Map<string, number>(windowDays.map((day) => [day, 0]));
    const jobDayCost = new Map<string, Map<JobData, number>>();

    const addCost = (role: CostRole, at: string, cost: number | null, workspaceName: string | null, data: JobData | null): void => {
      const day = dayOf(at);
      if (day === undefined) {
        return;
      }
      const value = cost ?? 0;
      if (windowCost.has(day)) {
        windowCost.set(day, windowCost.get(day)! + value);
      }
      const row = rows.get(day);
      if (row === undefined) {
        return;
      }
      row.cost[role] += value;
      const roleRow = roles.get(role)!;
      roleRow.cost_usd! += value;
      roleRow.runs += 1;
      if (cost === null) {
        roleRow.complete = false;
      }
      const wsRow = workspaceName === null ? undefined : byWorkspace.get(workspaceName);
      if (wsRow !== undefined && role !== 'digest') {
        wsRow.cost[role] += value;
      }
      if (data !== null) {
        const perJob = jobDayCost.get(day) ?? new Map<JobData, number>();
        perJob.set(data, (perJob.get(data) ?? 0) + value);
        jobDayCost.set(day, perJob);
      }
    };

    const stageOf = (stage: Stage): StageRow => ({
      stage, runs: 0, failed: 0, findings: noFindings(), outcomes: stage === 'task_check' ? null : noOutcomes(), revised: stage === 'task_check' ? 0 : null, fixed: 0,
      tickets: stage === 'task_check' ? 0 : null, cost_usd: null, tokens: null,
    });
    const stages = { claude_review: stageOf('claude_review'), codex_gate: stageOf('codex_gate'), task_check: stageOf('task_check') };
    const opinion = (): SecondOpinion & { dated: Array<SecondOpinionCase & { at: string }> } => ({ iterations: 0, caught: 0, findings: 0, fixed: 0, cases: [], dated: [] });
    const codexAfterClaude = opinion();
    const claudeAfterCodex = opinion();
    const caseOf = (data: JobData, iteration: number, findings: number, fixed: number, at: string): SecondOpinionCase & { at: string } => ({
      workspace: data.dir.workspace, ticket: data.job.ticket, dir: data.dir.name, archived: data.dir.archived, iteration, findings, fixed, at,
    });
    const totals: StatsPayload['totals'] = {
      cost_usd: 0, codex_tokens: noGateTokens(), jobs_started: 0, jobs_finished: { total: 0, pushed: 0, aborted: 0, failed: 0 }, median_time_to_ready_s: null, median_iterations: null,
    };
    const simplify: SimplifyCounts = { offered: 0, taken: 0, skipped: 0 };
    const readyTimes: number[] = [];
    const pushedIterations: number[] = [];
    const jobRows: Array<JobRow & { data: JobData }> = [];
    // The plan checks of each ticket, all-time.
    const planChecks = new Map<string, { plan_checks: number; plan_check_usd: number; plan_check_usd_complete: boolean }>();
    for (const record of checks.records) {
      const key = `${record.workspace}/${record.ticket}`;
      const sums = planChecks.get(key) ?? { plan_checks: 0, plan_check_usd: 0, plan_check_usd_complete: true };
      sums.plan_checks += 1;
      sums.plan_check_usd += record.cost ?? 0;
      sums.plan_check_usd_complete &&= record.cost !== null;
      planChecks.set(key, sums);
    }

    for (const data of read) {
      const { job, summary, events, dir } = data;
      for (const cost of summary.costs) {
        addCost(cost.role, cost.at, cost.cost, dir.workspace, data);
      }
      for (const run of summary.gateRuns) {
        const row = rows.get(dayOf(run.at) ?? '');
        if (row === undefined) {
          continue;
        }
        for (const target of [row.codex_tokens, roles.get('codex_gate')!.tokens as GateTokens, totals.codex_tokens]) {
          target.input += run.tokens.input;
          target.cached_input += run.tokens.cached_input;
          target.output += run.tokens.output;
        }
        roles.get('codex_gate')!.runs += 1;
        const wsRow = byWorkspace.get(dir.workspace);
        if (wsRow !== undefined) {
          wsRow.codex_tokens += run.tokens.input + run.tokens.output;
        }
      }
      for (const [key, tokens] of events?.tokens ?? []) {
        const [role, day] = key.split('\n') as [Role, string];
        if (rows.has(day)) {
          const target = roles.get(role)!.tokens as ClaudeTokens;
          target.input += tokens.input;
          target.output += tokens.output;
        }
      }
      // Load: started, finished, time to ready.
      const wsRow = byWorkspace.get(dir.workspace);
      const startedRow = rows.get(dayOf(job.created_at) ?? '');
      if (startedRow !== undefined) {
        startedRow.started += 1;
        totals.jobs_started += 1;
        if (wsRow !== undefined) {
          wsRow.jobs_started += 1;
        }
      }
      const finishedRow = isTerminal(job.state) ? rows.get(dayOf(job.updated_at) ?? '') : undefined;
      if (finishedRow !== undefined) {
        finishedRow.finished += 1;
        totals.jobs_finished.total += 1;
        totals.jobs_finished[job.state as 'pushed' | 'aborted' | 'failed'] += 1;
        if (job.state === 'pushed') {
          pushedIterations.push(job.iteration);
        }
      }
      const ready = events?.ready ?? null;
      const timeToReady = ready === null ? null : Math.round((Date.parse(ready) - Date.parse(job.created_at)) / 1000);
      if (ready !== null && timeToReady !== null && inPeriod(ready)) {
        readyTimes.push(timeToReady);
        wsRow?.ready.push(timeToReady);
      }

      // Review stages: verdicts in the period, outcomes once per ledger entry, failures from the events.
      for (const [stage, records, reviewer] of [[stages.claude_review, summary.reviews, REVIEWER], [stages.codex_gate, summary.gates, GATE_REVIEWER]] as const) {
        const byEntry = new Map<string, Outcome>();
        for (const record of records.values()) {
          if (!inPeriod(record.at)) {
            continue;
          }
          stage.runs += 1;
          addFindings(stage.findings, findingsOf(record.items));
          for (const item of record.items) {
            if (item.entry !== null) {
              byEntry.set(item.entry, item.outcome);
            } else {
              stage.outcomes![item.outcome] += 1;
            }
          }
        }
        for (const outcome of byEntry.values()) {
          stage.outcomes![outcome] += 1;
        }
        stage.failed += (events?.runs ?? []).filter((run) => run.failed && run.reviewer === reviewer && inPeriod(run.ts)).length;
      }

      // Second opinion: the gate after a clean Claude review, Claude after a clean gate.
      for (const [number, gate] of summary.gates) {
        const review = summary.reviews.get(number);
        if (inPeriod(gate.at) && review !== undefined && !review.items.some(blocks)) {
          codexAfterClaude.iterations += 1;
          const found = gate.items.filter(blocks);
          if (found.length > 0) {
            const fixed = found.filter((item) => item.outcome === 'fixed').length;
            codexAfterClaude.caught += 1;
            codexAfterClaude.findings += found.length;
            codexAfterClaude.fixed += fixed;
            codexAfterClaude.dated.push(caseOf(data, number, found.length, fixed, gate.at));
          }
        }
        const next = summary.reviews.get(number + 1);
        if (!gate.items.some(blocks) && next !== undefined && inPeriod(next.at)) {
          claudeAfterCodex.iterations += 1;
          const found = next.items.filter((item) => blocks(item) && !item.caused);
          if (found.length > 0) {
            const fixed = found.filter((item) => item.outcome === 'fixed').length;
            claudeAfterCodex.caught += 1;
            claudeAfterCodex.findings += found.length;
            claudeAfterCodex.fixed += fixed;
            claudeAfterCodex.dated.push(caseOf(data, number + 1, found.length, fixed, next.at));
          }
        }
      }

      // The simplification: the passes that offered a suggestion, and the user's choices.
      simplify.offered += summary.simplifies.filter((run) => run.suggestions > 0 && inPeriod(run.at)).length;
      for (const chosen of events?.chosen ?? []) {
        if (inPeriod(chosen.ts)) {
          simplify[chosen.choice === 'simplify' ? 'taken' : 'skipped'] += 1;
        }
      }

      // Per job: in the period when created or changed in it, or not finished.
      if (inPeriod(job.created_at) || inPeriod(job.updated_at) || !isTerminal(job.state)) {
        const claude = noFindings();
        const codex = noFindings();
        for (const record of summary.reviews.values()) {
          addFindings(claude, findingsOf(record.items));
        }
        for (const record of summary.gates.values()) {
          addFindings(codex, findingsOf(record.items));
        }
        jobRows.push({
          workspace: dir.workspace, ticket: job.ticket, dir: dir.name, archived: dir.archived, title: summary.title, state: job.state, created_at: job.created_at,
          iterations: job.iteration, cost_usd: summary.costs.reduce((total, cost) => total + (cost.cost ?? 0), 0), cost_complete: summary.costs.every((cost) => cost.cost !== null),
          codex_tokens: job.gate_tokens, claude, codex, time_to_ready_s: timeToReady,
          ...(planChecks.get(`${dir.workspace}/${job.ticket}`) ?? { plan_checks: 0, plan_check_usd: 0, plan_check_usd_complete: true }),
          claude_review: job.claude_review ?? null, data,
        });
      }
    }

    // The plan check: its cost, runs, findings, revisions and tickets.
    const checkedTickets = new Set<string>();
    const modes = new Map<CheckMode, TaskCheckModeRow>((['full', 'follow_up'] as const).map((mode) => [mode, {
      mode, runs: 0, failed: 0, cost_usd: 0, cost_complete: true, usd_per_run: null, started: 0, over_two: 0, over_two_share: null,
    }]));
    for (const record of checkRecords) {
      addCost('task_check', record.ended_at, record.cost, record.workspace, null);
      if (!inPeriod(record.ended_at)) {
        continue;
      }
      checkedTickets.add(`${record.workspace}/${record.ticket}`);
      const mode = modes.get(record.mode)!;
      mode.cost_usd += record.cost ?? 0;
      mode.cost_complete &&= record.cost !== null;
      if (record.status === 'failed') {
        stages.task_check.failed += 1;
        mode.failed += 1;
        continue;
      }
      stages.task_check.runs += 1;
      mode.runs += 1;
      addFindings(stages.task_check.findings, record.findings);
      const revised = (record.findings.blocker > 0 || record.findings.major > 0) && checkRecords.some((other) =>
        other.workspace === record.workspace && other.ticket === record.ticket && other.sha256 !== record.sha256 && Date.parse(other.started_at) > Date.parse(record.started_at));
      if (revised) {
        stages.task_check.revised! += 1;
      }
    }
    // The quality signal: each ticket started in the period once, by its latest job started in it,
    // under the mode of the ticket's last check (failed ones included) that ended before that
    // job's start; full without one.
    const startedJobs = new Map<string, Job>();
    for (const { job, dir } of read) {
      const key = `${dir.workspace}/${job.ticket}`;
      const kept = startedJobs.get(key);
      if (inPeriod(job.created_at) && (kept === undefined || job.created_at > kept.created_at)) {
        startedJobs.set(key, job);
      }
    }
    for (const job of startedJobs.values()) {
      const start = Date.parse(job.created_at);
      const last = checkRecords.reduce<CheckRow | undefined>((found, record) => (
        record.workspace === job.workspace && record.ticket === job.ticket && Date.parse(record.ended_at) < start
        && (found === undefined || Date.parse(record.ended_at) > Date.parse(found.ended_at)) ? record : found), undefined);
      const mode = modes.get(last?.mode ?? 'full')!;
      mode.started += 1;
      mode.over_two += job.iteration > 2 ? 1 : 0;
    }
    for (const mode of modes.values()) {
      mode.usd_per_run = mode.runs === 0 ? null : mode.cost_usd / mode.runs;
      mode.over_two_share = mode.started === 0 ? null : mode.over_two / mode.started;
    }
    for (const digest of digests) {
      addCost('digest', digest.ended_at, costOf(digest.cost_usd), null, null);
    }

    for (const stage of [stages.claude_review, stages.codex_gate]) {
      stage.fixed = stage.outcomes!.fixed;
    }
    stages.task_check.fixed = stages.task_check.revised!;
    stages.task_check.tickets = checkedTickets.size;
    stages.claude_review.cost_usd = roles.get('claude_review')!.cost_usd;
    stages.claude_review.tokens = roles.get('claude_review')!.tokens;
    stages.codex_gate.tokens = roles.get('codex_gate')!.tokens;
    stages.task_check.cost_usd = roles.get('task_check')!.cost_usd;
    totals.cost_usd = COST_ROLES.reduce((total, role) => total + roles.get(role)!.cost_usd!, 0);
    totals.median_time_to_ready_s = median(readyTimes);
    totals.median_iterations = median(pushedIterations);
    const secondOpinion = (value: ReturnType<typeof opinion>): SecondOpinion => ({
      iterations: value.iterations, caught: value.caught, findings: value.findings, fixed: value.fixed,
      cases: value.dated.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_CASES).map(({ at: _at, ...rest }) => rest),
    });

    const warnings = [
      ...jobWarnings(read, jobRows, recent),
      ...stageWarnings(read, checkRecords, digests, inPeriod),
      ...spikeWarnings(periodDays, rows, windowCost, jobDayCost),
    ].sort((a, b) => b.at.localeCompare(a.at) || warningTicket(a).localeCompare(warningTicket(b)));

    // Now: the current job directories and the run queue.
    const current = dirs.filter((dir): dir is ReadableDir => !dir.archived && dir.job !== undefined && chosen(dir.workspace)).map((dir) => dir.job.state);
    let queued: number | null;
    try {
      queued = (await new QueueStore(this.#stateDir, 1).read()).entries.filter((entry) => chosen(entry.workspace)).length;
    } catch { // an unreadable queue: its count is unknown (null)
      queued = null;
    }

    return {
      generated_at: now.toISOString(),
      days: query.days,
      workspace,
      period: { from, to },
      workspaces: workspaceNames,
      now: {
        running: current.filter((state) => RUNNING_STATES.includes(state)).length,
        waiting_for_you: current.filter((state) => WAITING_STATES.includes(state)).length,
        paused: current.filter((state) => state === 'paused').length,
        queued,
      },
      totals,
      days_rows: [...rows.values()],
      roles: [...roles.values()],
      by_workspace: [...byWorkspace.values()].sort((a, b) => a.workspace.localeCompare(b.workspace)).map(({ ready, ...row }) => ({
        ...row, total_usd: sumCosts(row.cost), median_time_to_ready_s: median(ready),
      })),
      stages: [stages.claude_review, stages.codex_gate, stages.task_check],
      task_check_modes: [...modes.values()],
      second_opinion: { codex_after_claude: secondOpinion(codexAfterClaude), claude_after_codex: secondOpinion(claudeAfterCodex) },
      arms: armRows(jobRows, inPeriod),
      simplify,
      jobs: jobRows.sort((a, b) => b.cost_usd - a.cost_usd || b.created_at.localeCompare(a.created_at)).slice(0, MAX_JOB_ROWS).map(({ data: _data, ...row }) => row),
      warnings,
      notes,
    };
  }
}

// A check record as the stats use it, or null when it cannot be read or has not the shape.
async function readCheck(path: string, workspace: string, ticket: string): Promise<CheckRow | null> {
  let record: unknown;
  try {
    record = JSON.parse(await readFile(path, 'utf8'));
  } catch { // missing or not JSON: null
    return null;
  }
  if (!isObject(record) || (record.status !== 'checked' && record.status !== 'failed') || typeof record.sha256 !== 'string'
    || typeof record.started_at !== 'string' || typeof record.ended_at !== 'string') {
    return null;
  }
  const output = isObject(record.output) ? record.output : {};
  const findings = noFindings();
  for (const finding of Array.isArray(output.findings) ? output.findings : []) {
    const severity = isObject(finding) ? finding.severity : undefined;
    if (severity === 'blocker' || severity === 'major' || severity === 'nit') {
      findings[severity] += 1;
    }
  }
  return {
    workspace, ticket, sha256: record.sha256, status: record.status, mode: recordMode(record.mode), findings, cost: costOf(record.cost_usd),
    started_at: record.started_at, ended_at: record.ended_at,
  };
}

// The arms of the Claude review experiment, on then off: the job rows started in the
// period with claude_review true or false, before the job list is cut to MAX_JOB_ROWS.
function armRows(rows: readonly JobRow[], inPeriod: (ts: unknown) => boolean): ArmRow[] {
  return (['on', 'off'] as const).map((arm): ArmRow => {
    const jobs = rows.filter((row) => row.claude_review === (arm === 'on') && inPeriod(row.created_at));
    const delivered = jobs.filter((row) => DELIVERED_STATES.includes(row.state));
    const cost = jobs.reduce((total, row) => total + row.cost_usd, 0);
    const findings = jobs.reduce((total, row) => total + row.codex.blocker + row.codex.major, 0);
    return {
      arm, jobs: jobs.length, delivered: delivered.length, aborted: jobs.filter((row) => row.state === 'aborted').length,
      cost_usd: cost, cost_complete: jobs.every((row) => row.cost_complete), usd_per_delivered: delivered.length === 0 ? null : cost / delivered.length,
      median_iterations: median(delivered.map((row) => row.iterations)), codex_findings: findings, codex_findings_per_job: jobs.length === 0 ? null : findings / jobs.length,
    };
  });
}

// The ticket a warning names, '' for a day or a digest.
const warningTicket = (warning: StatsWarning): string => (warning.target !== null && warning.target.kind !== 'digest' ? warning.target.ticket : '');
const jobTarget = (data: JobData): WarningTarget => ({ kind: 'job', workspace: data.dir.workspace, ticket: data.job.ticket, archived: data.dir.archived });

// The warnings of a job far above the usual (one per job, its unusual measures in one text) and
// of review churn, both only for jobs last updated on a recent day: the stop form also takes its
// stop line from those days.
function jobWarnings(read: readonly JobData[], rows: ReadonlyArray<JobRow & { data: JobData }>, recent: (ts: unknown) => boolean): StatsWarning[] {
  const warnings: StatsWarning[] = [];
  const finished = read.filter((data) => isTerminal(data.job.state)).sort((a, b) => b.job.updated_at.localeCompare(a.job.updated_at));
  const costs = new Map(rows.map((row) => [row.data, row.cost_usd]));
  const costOfJob = (data: JobData): number => costs.get(data) ?? data.summary.costs.reduce((total, cost) => total + (cost.cost ?? 0), 0);
  for (const row of rows) {
    const { data } = row;
    const { ticket } = data.job;
    const at = data.job.updated_at;
    if (!recent(at)) {
      continue;
    }
    const reference = finished.filter((other) => other !== data && other.dir.workspace === data.dir.workspace).slice(0, REFERENCE_JOBS);
    if (reference.length >= MIN_REFERENCE_JOBS) {
      const measures: string[] = [];
      const usualCost = median(reference.map(costOfJob))!;
      if (row.cost_usd > JOB_FACTOR * usualCost && row.cost_usd >= JOB_MIN_COST_USD) {
        measures.push(`cost ${money(row.cost_usd)} (usual ${money(usualCost)})`);
      }
      const usualTokens = median(reference.map((other) => other.job.gate_tokens))!;
      if (usualTokens > 0 && row.codex_tokens > JOB_FACTOR * usualTokens) {
        measures.push(`${tokenText(row.codex_tokens)} Codex gate tokens (usual ${tokenText(usualTokens)})`);
      }
      const usualIterations = median(reference.map((other) => other.job.iteration))!;
      if (row.iterations > JOB_FACTOR * usualIterations && row.iterations >= JOB_MIN_ITERATIONS) {
        measures.push(`${row.iterations} iterations (usual ${countText(usualIterations)})`);
      }
      if (measures.length > 0) {
        warnings.push({
          kind: 'job_unusual', text: `${ticket}: ${measures.join('; ')} — compared with the last ${reference.length} finished jobs of ${data.dir.workspace}.`, at, target: jobTarget(data),
        });
      }
    }
    const churn = data.summary.churn;
    if (churn !== null) {
      warnings.push({ kind: 'review_churn', text: `${ticket}: review churn, finding ${churn.id} was reopened ${churn.reopened} times.`, at, target: jobTarget(data) });
      continue;
    }
    const stop = (data.events?.stops ?? []).filter((line) => recent(line.ts)).at(-1);
    if (stop !== undefined) {
      warnings.push({ kind: 'review_churn', text: `${ticket} stopped with ${stop.code} ${onAt(stop.ts)}.`, at: stop.ts, target: jobTarget(data) });
    }
  }
  return warnings;
}

// The warnings of a stage whose FAILING_RUNS newest runs all failed.
function stageWarnings(
  read: readonly JobData[], checks: readonly CheckRow[], digests: ReadonlyArray<{ id: string; error: string | null; ended_at: string }>, inPeriod: (ts: unknown) => boolean,
): StatsWarning[] {
  interface Run { at: string; failed: boolean; target: WarningTarget; last: string }
  const onJob = (data: JobData, at: string): Pick<Run, 'target' | 'last'> => ({ target: jobTarget(data), last: `last on ${data.job.ticket} ${onAt(at)}` });
  const reviewerRuns = (reviewer: string): Run[] => read.flatMap((data) => (data.events?.runs ?? []).filter((run) => run.reviewer === reviewer).map((run) => ({ at: run.ts, failed: run.failed, ...onJob(data, run.ts) })));
  const stages: Array<[string, Run[]]> = [
    ['The Claude review', reviewerRuns(REVIEWER)],
    ['The Codex gate', reviewerRuns(GATE_REVIEWER)],
    ['The simplification', read.flatMap((data) => data.summary.simplifies.map((run) => ({ at: run.at, failed: run.failed, ...onJob(data, run.at) })))],
    ['The plan check', checks.map((check) => ({
      at: check.ended_at, failed: check.status === 'failed', target: { kind: 'ticket', workspace: check.workspace, ticket: check.ticket }, last: `last on ${check.ticket} ${onAt(check.ended_at)}`,
    }))],
    ['The digest', digests.map((digest) => ({ at: digest.ended_at, failed: digest.error !== null, target: { kind: 'digest', id: digest.id }, last: `last the digest of ${onAt(digest.ended_at).slice(3)}` }))],
    ['The explanation', read.flatMap((data) => (data.summary.explanation === null ? [] : [{ at: data.summary.explanation.at, failed: data.summary.explanation.failed, ...onJob(data, data.summary.explanation.at) }]))],
  ];
  const warnings: StatsWarning[] = [];
  for (const [name, runs] of stages) {
    const newest = runs.filter((run) => !Number.isNaN(Date.parse(run.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, FAILING_RUNS);
    if (newest.length === FAILING_RUNS && newest.every((run) => run.failed) && inPeriod(newest[0]!.at)) {
      warnings.push({ kind: 'stage_failing', text: `${name} failed ${FAILING_RUNS} times in a row, ${newest[0]!.last}.`, at: newest[0]!.at, target: newest[0]!.target });
    }
  }
  return warnings;
}

// The warnings of a day whose cost is far above the usual.
function spikeWarnings(periodDays: readonly string[], rows: ReadonlyMap<string, DayRow>, windowCost: ReadonlyMap<string, number>, jobDayCost: ReadonlyMap<string, ReadonlyMap<JobData, number>>): StatsWarning[] {
  const window = [...windowCost.keys()];
  const warnings: StatsWarning[] = [];
  for (const day of periodDays) {
    const total = sumCosts(rows.get(day)!.cost);
    const index = window.indexOf(day);
    const before = window.slice(Math.max(0, index - SPIKE_DAYS), index).map((other) => windowCost.get(other)!).filter((cost) => cost > 0);
    if (before.length < 7) {
      continue;
    }
    const usual = median(before)!;
    if (total <= 2 * usual || total < 5) {
      continue;
    }
    let most: [JobData, number] | undefined;
    for (const entry of jobDayCost.get(day) ?? []) {
      if (entry[1] > 0 && (most === undefined || entry[1] > most[1])) {
        most = entry;
      }
    }
    const tail = most === undefined ? '' : `; the most on ${most[0].job.ticket} (${money(most[1])})`;
    warnings.push({
      kind: 'cost_spike', text: `${day} cost ${money(total)}, more than twice the usual ${money(usual)} (median of the ${SPIKE_DAYS} days before)${tail}.`,
      at: midnight(day), target: most === undefined ? null : jobTarget(most[0]),
    });
  }
  return warnings;
}
