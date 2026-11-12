// The server's payloads as the page's TypeScript reads them. Each type copies, from the
// server's own type in src/ (named on each), only the fields the typed page code reads; it never
// imports from src/. A page script that reads another field adds it here. test/web-types/check.ts
// checks each copy against the server's type (npm run typecheck): a new type gets a check there.
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

// A job of a job's detail: src/dashboard.ts jobSummary.
interface JobSummary {
  workspace: string;
  ticket: string;
  branch: string;
  base: string;
  state: JobState;
  iteration: number;
  updated_at: string;
  created_at: string;
  error: { code: string; message: string } | null;
  worktree: string | null;
  prepared_commit: string | null;
  fixes: number;
  gate_fixes: number;
  gate_tokens: number;
  // The changed files' count (fileCounts).
  files: number;
  mr: JobMr | null;
  mr_host: { host: 'github' | 'gitlab' | null; reason: string | null };
  paused: { from: JobState; step: PauseStep | null; at: string } | null;
  limit: { provider: 'claude' | 'codex'; resets_at: string; reset_seen?: true } | null;
  task_changed: boolean | null;
  turn_limit: string | null;
  // The job in the user's checkout (src/jobs.ts Handover): only what the page reads.
  handover: { at: string } | null;
  handoff_skipped: { code: string; message: string } | null;
  claude_review: boolean;
  // A running job's steps, phase and likely ready range; null for a job not running.
  progress: JobProgress | null;
  stop_code: string | null;
  stop_kind: StopKind | null;
  stop_group: StopGroup | null;
  // src/stops.ts jobActions: the actions the job page shows, in order, and every action's
  // availability ('' or why it is off).
  actions: ShownAction[];
  availability: Readonly<Record<string, string>>;
}

// A job of api/jobs and of the stream's jobs events: src/dashboard.ts jobsPayload, jobSummary with
// title, cost_usd, review, now, tool_calls and stop (boardFacts, nowOf, stopOf). They are optional
// here, as the page also holds a detail's job (JobSummary) as a JobRow.
interface JobRow extends JobSummary {
  title?: string | null;
  cost_usd?: number | null;
  review?: 'clean' | 'fix' | 'failed' | null;
  now?: { who: string; what: string; ts: string | null } | null;
  tool_calls?: number;
  stop?: JobStop | null;
}

// The merge request on the Git host: src/jobs.ts JobMr.
interface JobMr {
  host: 'github' | 'gitlab';
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  merge_commit?: string | null;
}

// An action of the job page: src/stops.ts ShownAction.
interface ShownAction {
  action: string;
  label: string;
  primary: boolean;
  danger: boolean;
}

// api/jobs and the stream's jobs events: src/dashboard.ts jobsPayload, with the remote port's
// remote.
interface JobsPayload {
  jobs: JobRow[];
  remote?: boolean;
}

// The result of a job's action (POST api/jobs/<ws>/<ticket>/<action>): the fields describeOutcome
// and run read of the results of src/execution.ts Execution's action methods (approve and
// createMergeRequest's MrOutcome, say, settle, pause, abort, restart, handedDone, mergeMergeRequest,
// mergeRequestStatus, ...), each absent from the results that have none.
interface ActionResult {
  state?: JobState;
  branch?: string;
  title?: string;
  message?: string;
  link?: string;
  error?: { code: string; message: string } | null;
  archived?: string;
  commit?: string;
  mr?: { number: number; url: string; reused?: boolean; merge_commit?: string | null } | null;
  status?: MergeRequestStatus | string | null;
  iteration?: number;
  step?: string | null;
  id?: string;
  waiting?: string[];
  task_changed?: boolean;
  kept?: string[];
  branch_deleted?: string | null;
  discarded?: boolean;
  worktree?: string | null;
  queued?: boolean;
}

// A running job's progress: src/progress.ts Progress, its phase src/progress.ts PHASES.
type ProgressPhase = 'code' | 'claude' | 'codex' | 'mr_text';
interface JobProgress {
  steps: Array<{ text: string; done: boolean }>;
  phase: ProgressPhase;
  fix_round: number;
  ready_from: string;
  ready_to: string;
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

// An iteration of the detail: src/dashboard.ts jobDetail; files: its file list (src/jobs.ts
// FileChange, only the line counts), null for an iteration whose meta has no files list.
interface IterationRow {
  number: number;
  files: Array<{ additions: number; deletions: number }> | null;
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
  reviewer: string;
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
  job: JobSummary;
  iterations: IterationRow[];
  mr: boolean;
  mr_title: string | null;
  confirm_actions: string[];
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
  check: { status: 'checked' | 'failed'; output: CheckOutput | null; error: string | null; model: string | null; cost_usd: number | null; ended_at: string } | null;
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
// The live stream's entries of one line of a job's events (the entries event): src/dashboard.ts
// lineEntries, sent with its 0-based line.
interface StreamLine {
  line: number;
  entries: StreamEntry[];
}

// A ticket without a live job, as the planned ticket page's payload carries it: src/setup.ts
// TicketRow with its conversation (src/dashboard.ts ticketEntry: the first message, and its
// ChatGPT link or null when it is too long for one; check with the Task checks only).
interface TicketEntry {
  workspace: string;
  ticket: string;
  title: string;
  base: string;
  draft: boolean;
  job: JobState | null;
  lands_after: DependencyRow[];
  // src/attachments.ts Attachment: only the name.
  attachments: Array<{ name: string }>;
  conversation: { message: string; url: string | null };
  check?: CheckSummary | null;
}
// A ticket without a live job, as the tickets payload's rows carry it (src/dashboard.ts
// ticketsPayload: ticketEntry and the run queue's fields).
interface TicketRow extends TicketEntry {
  queue_position: number | null;
  queue_error: { code: string; message: string } | null;
  queue_reason: string | null;
  queue_force: boolean;
}
// A ticket in the run queue: its position, 1-based.
type QueuedRow = TicketRow & { queue_position: number };

// A ticket's check for the board: src/task-check.ts CheckSummary.
interface CheckSummary {
  state: 'none' | 'ready' | 'not_ready' | 'failed' | 'not_needed';
  check_reason: string | null;
  stale: boolean;
  running: boolean;
  blockers: number;
  majors: number;
  // The note of Start's confirmation.
  start_note: string | null;
}

// The state of a ticket another lands after: src/setup.ts DEPENDENCY_STATES.
type DependencyState = 'merged' | 'pushed' | 'running' | 'planned' | 'missing';
// A ticket another lands after, with its state: src/setup.ts DependencyRow.
interface DependencyRow {
  workspace: string;
  ticket: string;
  state: DependencyState;
}
// A live job's Task file's lands_after (the tickets payload's job_lands_after): src/setup.ts
// JobDependencies.
interface JobDependencies {
  workspace: string;
  ticket: string;
  lands_after: DependencyRow[];
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
  path: string;
  liveJobs: number;
  problem: string | null;
  handoff: HandoffMode | null;
  // src/registry.ts WorkspaceColor.
  color: string;
  app: string;
  description: string | null;
  derived_description: string | null;
  digest: { track: boolean; my_work: boolean };
}

// The run queue of the tickets payload: src/queue.ts QueueView.
interface QueueView {
  max_running: number;
  running: number;
  held: boolean;
  hold_reason: string | null;
  next: { workspace: string; ticket: string } | null;
  on_limit: OnLimitRule;
  limit_hold: { parked: number; resets_at: string | null } | null;
}

// The morning digest's settings, as the workspaces payload carries them: src/registry.ts
// DigestSettings without its model (src/setup.ts WorkspaceSettings).
interface DigestSettings {
  at: string;
  weekdays_only: boolean;
  language: string;
}

// The workspaces payload (api/workspaces and the stream's workspaces event): src/dashboard.ts
// workspacesPayload, the registry with src/setup.ts WorkspaceSettings.
interface WorkspacesPayload {
  workspaces: WorkspaceRow[];
  handoff_default: HandoffMode;
  digest: DigestSettings;
}

// The tickets payload (api/tickets and the stream's tickets event): src/dashboard.ts ticketsPayload;
// the event adds changed, the tickets it is about, when it is not about all of them.
interface TicketsPayload {
  tickets: TicketRow[];
  archived: ArchivedRow[];
  job_lands_after: JobDependencies[];
  queue: QueueView | null;
  changed?: Array<{ workspace: string; ticket: string }>;
}

// The planned ticket page, api/tickets/<ws>/<ticket>/page: src/dashboard.ts ticketPage. The check is
// null without the Task checks; the history is src/ticket-history.ts TimelineEntry, newest first.
interface TicketPage {
  ticket: TicketEntry;
  task: { text: string; sha256: string };
  plan: TicketPlan;
  check: CheckView | null;
  check_rounds: number;
  check_usd: number;
  check_usd_complete: boolean;
  history: Array<{ ts: string | null; text: string }>;
}
// The plan in plain words: src/dashboard.ts planOf. The page updates waits_for's states from the
// tickets payload.
interface TicketPlan {
  starts_from: string;
  files: Array<{ path: string; sensitive: boolean }>;
  scoped: boolean;
  waits_for: PlanDependency[];
}
// A ticket the plan waits for (of another workspace as <workspace>/<ticket>): src/dashboard.ts planOf.
interface PlanDependency {
  ticket: string;
  state: DependencyState;
  merged: boolean;
}

// The morning digests, api/digests: src/digest-run.ts Digests.list, newest first.
interface DigestList {
  running: boolean;
  digests: DigestSummary[];
}
// A digest of the list: src/digest-run.ts DigestSummary.
interface DigestSummary {
  id: string;
  trigger: 'scheduled' | 'manual';
  ended_at: string;
}

// One digest, api/digests/<id>: src/digest-run.ts DigestRecord.
interface DigestRecord {
  id: string;
  started_at: string;
  ended_at: string;
  period: { from: string; to: string };
  // The daily's days; older records may lack it.
  daily_days?: { yesterday: { from: string; to: string }; today: { from: string; to: string } };
  language: string;
  workspaces: DigestWorkspace[];
  daily_sources: DigestDailySource[];
  output: DigestOutput | null;
  cost_usd: number | null;
  error: string | null;
  notes: string[];
}
// A workspace of a digest: src/digest-run.ts DigestWorkspace, its fetch src/digest.ts MirrorResult.
interface DigestWorkspace {
  name: string;
  app: string;
  track: boolean;
  fetch: { message: string | null; notes: string[] };
  git: DigestGit | null;
  error: string | null;
}
// A workspace's Git data: src/digest.ts RepoData.
interface DigestGit {
  main: string;
  landed: DigestLanded[];
  branches: DigestBranch[];
  notes: string[];
}
// A commit that landed on the main branch: src/digest.ts LandedEntry.
interface DigestLanded {
  sha: string;
  full_sha: string;
  author: string;
  mine: boolean;
  date: string;
  subject: string;
  ticket: string | null;
  dirs: string[];
  stat: string;
}
// A branch: src/digest.ts LiveBranch.
interface DigestBranch {
  name: string;
  local: boolean;
  author: string;
  mine: boolean;
  age_days: number;
  ahead: number;
  behind: number;
  local_only: number;
  subject: string;
  landed: boolean;
  overlap?: string[];
}
// The material of one daily: src/digest-run.ts DailySource, its commits DailyCommit.
interface DigestDailySource {
  app: string;
  workspaces: string[];
  commits: Array<{ sha: string; ref: string; date: string; subject: string; workspace: string }>;
}
// The model's output: src/digest-run.ts DigestOutput.
interface DigestOutput {
  repos: Array<{
    name: string;
    headline: string;
    merged: Array<{ sha: string; problem: string }>;
    branches: Array<{ ref: string; what: string }>;
    impact_on_me: string[];
  }>;
  cross_repo: DigestCross[];
  dailies: DigestDaily[];
}
// A ticket across the workspaces: an entry of DigestOutput's cross_repo.
interface DigestCross {
  ticket: string;
  by_workspace: Readonly<Record<string, string>>;
  for_me: string;
}
// A daily: an entry of DigestOutput's dailies.
interface DigestDaily {
  app: string;
  workspaces: string[];
  yesterday: string[];
  problems: string[];
  plan: string[];
  next: string[];
}

// The Stats page's payload, api/stats: src/stats.ts StatsPayload and its rows (named Stats* here, as
// JobRow and WorkspaceRow are the board's).
type StatsRole = 'implementer' | 'claude_review' | 'simplify' | 'codex_gate' | 'task_check' | 'digest' | 'explanation';
// The roles with a cost in USD: src/stats.ts CostRole.
type StatsCostRole = Exclude<StatsRole, 'codex_gate'>;
// src/stats.ts Findings.
interface StatsFindings {
  blocker: number;
  major: number;
  nit: number;
}
// src/stats.ts ClaudeTokens and GateTokens.
interface StatsClaudeTokens {
  input: number;
  output: number;
}
interface StatsGateTokens {
  input: number;
  cached_input: number;
  output: number;
}
// src/stats.ts DayRow.
interface StatsDayRow {
  day: string;
  cost: Readonly<Record<StatsCostRole, number>>;
  codex_tokens: StatsGateTokens;
  started: number;
}
// src/stats.ts RoleRow.
interface StatsRoleRow {
  role: StatsRole;
  cost_usd: number | null;
  complete: boolean;
  tokens: StatsClaudeTokens | StatsGateTokens | null;
  runs: number;
}
// src/stats.ts WorkspaceRow.
interface StatsWorkspaceRow {
  workspace: string;
  cost: Readonly<Record<Exclude<StatsCostRole, 'digest'>, number>>;
  total_usd: number;
  codex_tokens: number;
  jobs_started: number;
  median_time_to_ready_s: number | null;
}
// src/stats.ts StageRow.
interface StatsStageRow {
  stage: 'claude_review' | 'codex_gate' | 'task_check';
  runs: number;
  failed: number;
  findings: StatsFindings;
  fixed: number;
  tickets: number | null;
  cost_usd: number | null;
  tokens: StatsClaudeTokens | StatsGateTokens | null;
}
// src/stats.ts SecondOpinion and SecondOpinionCase.
interface StatsSecondOpinion {
  iterations: number;
  caught: number;
  findings: number;
  fixed: number;
  cases: Array<{ workspace: string; ticket: string; archived: boolean; iteration: number; findings: number; fixed: number }>;
}
// src/stats.ts ArmRow.
interface StatsArmRow {
  arm: 'on' | 'off';
  jobs: number;
  delivered: number;
  aborted: number;
  cost_usd: number;
  cost_complete: boolean;
  usd_per_delivered: number | null;
  median_iterations: number | null;
  codex_findings: number;
  codex_findings_per_job: number | null;
}
// src/stats.ts JobRow.
interface StatsJobRow {
  workspace: string;
  ticket: string;
  archived: boolean;
  title: string | null;
  state: JobState;
  created_at: string;
  iterations: number;
  cost_usd: number;
  cost_complete: boolean;
  codex_tokens: number;
  claude: StatsFindings;
  codex: StatsFindings;
  time_to_ready_s: number | null;
  plan_checks: number;
  plan_check_usd: number;
  plan_check_usd_complete: boolean;
}
// What a warning points at: src/stats.ts WarningTarget.
type StatsTarget =
  | { kind: 'job'; workspace: string; ticket: string; archived: boolean }
  | { kind: 'ticket'; workspace: string; ticket: string }
  | { kind: 'digest'; id: string };
// The payload: src/stats.ts StatsPayload.
interface StatsPayload {
  generated_at: string;
  period: { from: string; to: string };
  workspaces: string[];
  now: { running: number; waiting_for_you: number; paused: number; queued: number | null };
  totals: {
    cost_usd: number;
    codex_tokens: StatsGateTokens;
    jobs_started: number;
    jobs_finished: { total: number; pushed: number; aborted: number; failed: number };
    median_time_to_ready_s: number | null;
    median_iterations: number | null;
  };
  days_rows: StatsDayRow[];
  roles: StatsRoleRow[];
  by_workspace: StatsWorkspaceRow[];
  stages: StatsStageRow[];
  second_opinion: { codex_after_claude: StatsSecondOpinion; claude_after_codex: StatsSecondOpinion };
  arms: StatsArmRow[];
  // src/stats.ts SimplifyCounts.
  simplify: { offered: number; taken: number; skipped: number };
  jobs: StatsJobRow[];
  // src/stats.ts StatsWarning.
  warnings: Array<{ text: string; target: StatsTarget | null }>;
  // src/stats.ts StatsNotes.
  notes: { truncated: number; unreadable: number; events_skipped: number; digest_excluded: boolean };
}

// A health check's status: src/health.ts HEALTH_STATUSES. off is "not configured" and counts as green.
type HealthStatus = 'ok' | 'recovering' | 'down' | 'off';

// One health check of api/health and of the stream's health events: src/health.ts
// HealthCheck.
interface HealthCheck {
  label: string;
  status: HealthStatus;
  detail: string;
  since: string;
}

// An open merge request of a workspace's origin (GET api/workspaces/<ws>/merge-requests):
// src/forge-comments.ts OpenRequest.
interface OpenMergeRequest {
  number: number;
  title: string;
  author: string;
  source: string;
  target: string;
  url: string;
  updated_at: string;
  draft: boolean;
}

// A review thread of a merge request (GET api/workspaces/<ws>/merge-requests/<number>/threads):
// src/forge-comments.ts ReviewThread and ReviewComment. path and line are null for a general
// comment; resolved is null where the host has no such notion.
interface ReviewThread {
  id: string;
  resolved: boolean | null;
  path: string | null;
  line: number | null;
  comments: Array<{ author: string; body: string; created_at: string }>;
}

// The job created from review comments: src/review-job.ts ReviewJobResult.
interface ReviewJobResult {
  workspace: string;
  ticket: string;
  path: string;
  position: number;
}
