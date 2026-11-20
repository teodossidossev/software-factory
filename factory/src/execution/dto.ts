// The data shapes of the job lifecycle: what Execution's calls return or take, and the listener of
// its state changes. src/execution.ts exports them.
import type { MergeRequestStatus } from '../forge.js';
import type { Job, JobMr, JobState, PauseStep } from '../jobs.js';
import type { Page } from '../repo-files.js';

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
  // The merge request opened (or reused) on the Git host.
  mr?: JobMr & { reused: boolean };
  // What was pushed of a handed-over job: the factory's commit or the user's.
  message?: string;
}

// sf mr status: what the host says of the job's merge request. A job without a record has it looked
// up by its branch and base: found says how many open ones the host has (the newest is recorded); with
// none, mr is null and there is no status.
export interface MrStatusOutcome {
  state: JobState;
  branch: string;
  mr: JobMr | null;
  status?: MergeRequestStatus;
  found?: { count: number };
}

// The merge request's title and body, from the MR text.
export interface MrContent {
  title: string;
  body: string;
}

// A Save of the Merge request screen: the title, the body and, when they change, the
// branch and the base.
export interface MrInput {
  title: string;
  body: string;
  branch?: string;
  base?: string;
}

// The Merge request screen's view of a job's MR text (GET mr-view).
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
  // The factory's notes for the user (src/mr-notes.ts mrNotes): Markdown, '' without any; never part of the MR text.
  notes: string;
}

// What a Save or Reset of the MR text left.
export interface MrSaved {
  state: JobState;
  branch: string;
  base: string;
  edited: boolean;
  prepared_commit: string | null;
}

// What a Resume did: the job's state and iteration, the step it went on with, and
// whether the Task file had changed.
export interface Resumed {
  state: JobState;
  iteration: number;
  step: PauseStep | null;
  task_changed: boolean;
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
