// The server's payloads as the page's TypeScript reads them (SF-146, SF-147). Each type copies, from the
// server's own type in src/ (named on each), only the fields the typed page code reads; it never
// imports from src/. A file converted later (SF-147 to SF-150) adds the fields it reads.
// A global declaration file: no import or export, so every type is visible to every page script.

// A job's state: src/jobs.ts JOB_STATES.
type JobState =
  | 'starting'
  | 'working'
  | 'awaiting_review'
  | 'needs_human'
  | 'paused'
  | 'waiting_limit'
  | 'ready_for_human_review'
  | 'handed_over'
  | 'preparing_mr'
  | 'pushed'
  | 'aborted'
  | 'failed';

// The rule at a usage limit's reset: src/queue.ts ON_LIMIT_RULES.
type OnLimitRule = 'resume-then-queue' | 'resume-only' | 'wait';

// A workspace's hand-over setting: src/registry.ts HANDOFF_MODES.
type HandoffMode = 'checkout' | 'off';

// What a paused job stopped in: src/jobs.ts PAUSE_STEPS.
type PauseStep = 'turn' | 'review' | 'gate' | 'simplify';

// A stop's kind and group: src/stops.ts StopKind and StopGroup.
type StopKind = 'decision' | 'error';
type StopGroup = 'gate' | 'ledger' | 'limit' | 'simplify' | 'tests';

// A job of api/jobs and of the stream's jobs events: src/dashboard.ts jobSummary. stop is the jobs
// payload's only (jobsPayload); the detail's job has none.
interface JobRow {
  workspace: string;
  ticket: string;
  state: JobState;
  iteration: number;
  updated_at: string;
  error: { code: string; message: string } | null;
  worktree: string | null;
  fixes: number;
  gate_tokens: number;
  // The changed files' count (fileCounts).
  files: number;
  paused: { from: JobState; step: PauseStep | null; at: string } | null;
  limit: { provider: 'claude' | 'codex'; resets_at: string; reset_seen?: true } | null;
  claude_review: boolean;
  stop_code: string | null;
  stop_kind: StopKind | null;
  stop_group: StopGroup | null;
  stop?: JobStop | null;
}

// What a stopped job waits on: src/dashboard.ts stopOf. Its items are unknown[] there: the
// simplification's suggestions, the ledger's entries or the gate's items, by the stop's code.
interface JobStop {
  items: Array<Readonly<Record<string, unknown>>>;
  saves_lines: number | null;
}

// A finding of a review or the gate: src/review.ts ReviewItem.
interface ReviewItem {
  severity: 'blocker' | 'major' | 'nit';
  path: string;
  problem: string;
  expected: string;
}

// review.json and gate.json of an iteration: src/jobs.ts ReviewRecord and GateRecord, a verdict or
// why the review failed (the fields absent from one of them read as undefined).
type ReviewRecord =
  | { verdict: 'clean' | 'fix'; summary: string; items: ReviewItem[]; error?: undefined }
  | { error: string; verdict?: undefined; items?: undefined };
type GateRecord = ReviewRecord;

// gate-override.json of an iteration: src/jobs.ts GateOverride.
interface GateOverride {
  code: string;
  unapplied: Array<ReviewItem & { id?: string }> | string;
}

// A suggestion of the simplification pass: src/simplify.ts Suggestion.
interface Suggestion {
  path: string;
  what: string;
  why: string;
  saves_lines: number;
}

// simplify.json of an iteration: src/jobs.ts SimplifyRecord.
type SimplifyRecord =
  | { suggestions: Suggestion[]; error?: undefined }
  | { error: string; suggestions?: undefined };

// An iteration of the detail: src/dashboard.ts jobDetail.
interface IterationRow {
  number: number;
  review: ReviewRecord | null;
  gate: GateRecord | null;
  gate_override: GateOverride | null;
  simplify: SimplifyRecord | null;
}

// An entry of the findings ledger: src/ledger.ts LedgerEntry.
interface LedgerEntry {
  id: string;
  iteration: number;
  severity: 'blocker' | 'major' | 'nit';
  path: string;
  problem: string;
  expected: string;
  status: 'open' | 'fixed' | 'contested' | 'escalated' | 'left' | 'accepted_risk' | 'user_fix';
  response: string;
  evidence: string;
  dispute: { reviewer: string; reason: string } | null;
  settled: { decision: 'accept' | 'fix'; note: string; at: string } | null;
}

// The plain explanation of the current stop: src/explain.ts ExplanationRecord.
interface ExplanationRecord {
  stop: { at: string; code: string };
  model: string;
  ended_at: string | null;
  cost_usd: number | null;
  output: {
    headline: string;
    explanation: string;
    choices: Array<{ choice: string; effect: string; recommended: boolean }>;
    recommendation: string;
  } | null;
  error: string | null;
}

// A job's detail, api/jobs/<ws>/<ticket> and the stream's job events: src/dashboard.ts jobView.
interface JobDetail {
  job: JobRow;
  iterations: IterationRow[];
  mr: boolean;
  ledger: LedgerEntry[];
  settle_ids: string[];
  explanation: ExplanationRecord | null;
}

// What the host said of a merge request: src/forge.ts MergeRequestStatus.
interface MergeRequestStatus {
  number: number;
  state: string;
  draft: boolean;
  mergeable: boolean | null;
  reason?: string;
  checks?: string;
}

// A ticket's last Task check, api/tickets/<ws>/<ticket>/check: src/task-check.ts CheckView, its
// record CheckRecord and the record's output CheckOutput.
interface CheckOutput {
  paraphrase: string;
  findings: Array<{ kind: string; severity: 'blocker' | 'major' | 'nit'; where: string; problem: string; expected: string }>;
  files: Array<{ path: string; action: 'create' | 'modify' | 'delete' }>;
  verdict: 'ready' | 'not_ready';
}
interface CheckView {
  check: { output: CheckOutput | null; error: string | null; model: string | null; ended_at: string } | null;
  stale: boolean;
  running: boolean;
  check_reason: string | null;
}

// The Changes screen's index, api/jobs/<ws>/<ticket>/changes: src/changes.ts ChangesIndex.
interface ChangesIndex {
  base: { ref: string; commit: string | null };
  iterations: Array<{ n: number; base_commit: string | null }>;
}

// A changed file of a file list: src/changes.ts ListedFile.
interface ListedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  binary: boolean;
  unavailable: boolean;
}

// A file list, api/jobs/<ws>/<ticket>/changes?from=&to=: src/changes.ts files.
interface ChangesList {
  files: ListedFile[];
  more: boolean;
}

// One side of a file, api/jobs/<ws>/<ticket>/file: src/changes.ts FileVersion.
type FileVersion =
  | { kind: 'text'; text: string }
  | { kind: 'absent' }
  | { kind: 'binary' }
  | { kind: 'too_large' }
  | { kind: 'unavailable'; reason: string };

// The Merge request screen's payload, api/jobs/<ws>/<ticket>/mr-view: src/execution/shared.ts MrView.
interface MrView {
  title: string;
  body: string;
  factory: { title: string; body: string };
  edited: boolean;
  factory_new_at: string | null;
  branch: string;
  base: string;
  branch_editable: boolean;
  branch_reason: string | null;
  base_editable: boolean;
  base_reason: string | null;
  problems: MrProblem[];
  pushed: boolean;
  pushed_at: string | null;
  editable: boolean;
  readonly_reason: string | null;
  target: { host: string | null; repository: string | null };
  rules: { commit_types: string[]; max_header_chars: number; required_headings: string[]; manual_claim: { source: string; flags: string } };
  commit: { title: string; body: string } | null;
  commit_differs: boolean;
}
// A problem of the MR text: an entry of src/execution/shared.ts MrView's problems.
interface MrProblem {
  field: 'title' | 'body' | 'branch' | 'base';
  message: string;
}

// An entry of a job's Stream, a page of api/jobs/<ws>/<ticket>/stream and the stream's entries
// events: src/job-stream.ts StreamEntry.
// Who an entry is of: src/job-stream.ts Who.
type StreamWho = 'implementer' | 'claude' | 'codex' | 'you' | 'factory' | 'mr';
// A finding of a verdict entry: src/job-stream.ts VerdictItem.
interface StreamItem {
  severity: string;
  path: string;
  problem: string;
  expected: string;
  id: string | null;
}
type StreamEntry = { k: string; ts: string | null; it: number; who: StreamWho } & (
  | { t: 'prompt'; kind: 'implement' | 'fix' | 'mr' | 'conflict' | 'continue'; text: string; first: string; task_changed: boolean; fix_n?: number; fix?: string; images?: string[] }
  | { t: 'user'; text: string; task_changed: boolean; images?: string[] }
  | { t: 'text'; text: string }
  | { t: 'tool'; id: string; line: string; detail: string }
  | { t: 'tool_result'; id: string; out: string; result: string; err: boolean }
  | { t: 'result'; turns: number | null; ms: number | null; cost: number | null }
  | { t: 'state'; from: string | null; to: string; code: string | null; msg: string | null; text?: string; stop_code?: string; stop_kind?: StopKind }
  | { t: 'verdict'; verdict: string; effective: string | null; summary?: string; items?: StreamItem[] }
  | { t: 'changes'; files: number; paths: string[] }
  | { t: 'simplify'; suggestions: Suggestion[]; saves_lines: number }
  | { t: 'tests'; run: string; command: string }
  | { t: 'tests_result'; run: string; command: string; outcome: string; exit_code: number | null; timed_out: boolean; ms: number | null; reason: string | null; tail: string; tail_truncated: boolean }
  | { t: 'note'; text: string }
);

// A page of a job's Stream: src/dashboard.ts streamPage.
interface StreamPage {
  entries: StreamEntry[];
  next: number;
  end: boolean;
}

// A ticket without a live job: src/setup.ts TicketRow.
interface TicketRow {
  workspace: string;
  ticket: string;
  title: string;
}

// An archived ticket: src/setup.ts ArchivedRow.
interface ArchivedRow {
  workspace: string;
  ticket: string;
  title: string;
}

// A registered workspace: src/setup.ts WorkspaceRow.
interface WorkspaceRow {
  name: string;
}

// The run queue of the tickets payload: src/queue.ts QueueView.
interface QueueView {
  max_running: number;
  running: number;
  held: boolean;
  hold_reason: string | null;
  next: { workspace: string; ticket: string } | null;
}

// The morning digest's settings: src/registry.ts DigestSettings.
interface DigestSettings {
  at: string;
  weekdays_only: boolean;
  model: string;
  language: string;
}
