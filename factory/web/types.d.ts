// The server's payloads as the page's TypeScript reads them (SF-146). Each type copies, from the
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

// A job of api/jobs and of the stream's jobs events: src/dashboard.ts jobSummary.
interface JobRow {
  workspace: string;
  ticket: string;
  state: JobState;
}

// A job's detail, api/jobs/<ws>/<ticket> and the stream's job events: src/dashboard.ts jobView.
interface JobDetail {
  job: JobRow;
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
