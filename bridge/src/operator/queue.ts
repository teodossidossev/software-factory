// SF-007 queue: a bounded, read-only scan of factory-data/apps/<app>/jobs/<job>/
// that lists OpenClaw-accepted jobs with their displayed status. Discovery never
// implies execution: nothing here prepares, claims, writes or starts anything.
// It reuses the SF-005/SF-006 readers and validators (FactoryJobs, readJobFile,
// readDispatchRecord, checkAcceptedReceipt, loadAppConfig, ExecutionService.status).
// The receiver's own record is checked at approval and again before prepare,
// not on every refresh.
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { checkAcceptedReceipt, readDispatchRecord, type DispatchRecord } from '../dispatch.js';
import { AppConfigError, loadAppConfig } from '../execution/app-config.js';
import { isAlive } from '../execution/process-identity.js';
import { EXECUTION_FILE, type ExecutionService, type ExecutionState } from '../execution/service.js';
import { APPS_PATH, FactoryJobs, ID_PATTERN, jobFileExists, readJobFile } from '../factory-jobs.js';
import { INSTRUCTION_FILE, MAX_INSTRUCTION_BYTES } from '../instruction-store.js';
import { expired, type JobOperatorState, type OperatorStore } from './store.js';

export const QUEUE_LIMITS = { apps: 100, jobsPerApp: 1000, jobs: 5000 };

export type DisplayStatus =
  | 'accepted'
  | 'awaiting_operator'
  | 'approved'
  | 'launching'
  | 'running'
  | 'prepared'
  | 'pending_manual'
  | 'completed'
  | 'rejected'
  | 'interrupted'
  | 'failed'
  | 'needs_inspection'
  | 'invalid';

export type Action = 'approve' | 'reject' | 'later' | 'cancel';

export interface QueueEntry {
  app_id: string;
  job_id: string;
  status: DisplayStatus;
  request_id: string | null;
  instruction_sha256: string | null;
  instruction_bytes: number | null;
  accepted_at: string | null;
  // Why an accepted job cannot run here, or why a record is unusable. Fixed, path-free text.
  problem: { code: string; message: string } | null;
  execution: {
    state: ExecutionState;
    error: { code: string; message: string } | null;
    recovery: string | null;
    process_alive: boolean | null;
    artifacts: Record<string, string>;
  } | null;
  approval: { id: string; approved_at: string; expired: boolean } | null;
  deferred_at: string | null;
  rejected_at: string | null;
  // outcome 'abandoned': the terminal took the approval but ended before preparing the job.
  last_launch: { outcome: string; code: string | null; message: string | null; at: string; final_state: string | null } | null;
  actions: Action[];
  // The recovery command when the console itself offers no decision (SF-006 manual CLI).
  next: string | null;
}

export interface QueueDeps {
  mediatorRoot: string;
  store: OperatorStore;
  // Read-only SF-006 calls; production probes the Claude login afresh for each preflight.
  service: Pick<ExecutionService, 'preflight' | 'status'>;
  now: () => Date;
}

// Fixed explanations: never the raw error text of a malformed or unreadable record.
const PROBLEMS: Record<string, string> = {
  app_not_registered: 'The app directory is missing or not a plain directory.',
  app_not_configured: 'The app has no private .env; it is registered but not executable here.',
  invalid_config: 'The app .env is invalid (format, permissions or symlink); it cannot run here.',
  invalid_repo: 'APP_REPO is not a separate Git worktree root; the app cannot run here.',
  invalid_record: 'dispatch.json, openclaw-receipt.json or execution.json is malformed or does not prove the acceptance.',
  instruction_missing: 'instruction.md is missing.',
  instruction_mismatch: 'instruction.md does not have the accepted SHA-256.',
  unreadable: 'The job could not be read safely (symlink, size or permissions).',
  operator_state: 'The private operator record of this job is unreadable.',
};
const problem = (code: string) => ({ code, message: PROBLEMS[code] ?? PROBLEMS.unreadable! });

// A directory on the way: a plain directory, missing (ENOENT), or the reason it cannot be
// inspected. Symlinks are never followed.
type DirectoryKind = 'directory' | 'missing' | UninspectedReason;
async function directoryKind(path: string): Promise<DirectoryKind> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink() ? 'directory' : 'a symlink or not a directory';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'cannot be inspected';
  }
}

// The ids in a directory, sorted, and how many were left out by the limit; undefined if it cannot be listed.
async function ids(path: string, limit: number): Promise<{ ids: string[]; omitted: number } | undefined> {
  try {
    const all = (await readdir(path)).filter((name) => ID_PATTERN.test(name)).sort();
    return { ids: all.slice(0, limit), omitted: Math.max(0, all.length - limit) };
  } catch {
    return undefined;
  }
}

export type UninspectedReason = 'a symlink or not a directory' | 'cannot be inspected' | 'cannot be listed';

// Where the listing is incomplete. Display only: no safety decision depends on the
// scan (the session gate in SF-006 run does), but the operator must see the gap.
export interface Truncation {
  // factory-data or factory-data/apps does not exist: nothing has been dispatched yet (a clean, empty state).
  uninitialized: boolean;
  // Apps beyond the first QUEUE_LIMITS.apps (sorted by id).
  apps_omitted: number;
  // Apps whose jobs beyond the first QUEUE_LIMITS.jobsPerApp were not inspected.
  jobs_omitted_in: Array<{ app_id: string; omitted: number }>;
  // Jobs not inspected because QUEUE_LIMITS.jobs were inspected already.
  total_omitted: number;
  // Directories that exist but were not inspected; path is built from verified ids only
  // (factory-data, factory-data/apps, factory-data/apps/<app>, factory-data/apps/<app>/jobs).
  uninspected: Array<{ path: string; reason: UninspectedReason }>;
}

export const isTruncated = (truncation: Truncation): boolean =>
  truncation.apps_omitted > 0 || truncation.jobs_omitted_in.length > 0 || truncation.total_omitted > 0 || truncation.uninspected.length > 0;

// Every accepted job, bounded by QUEUE_LIMITS; every limit or directory that cuts the listing is reported.
export async function scanQueue(deps: QueueDeps): Promise<{ entries: QueueEntry[]; truncation: Truncation }> {
  const entries: QueueEntry[] = [];
  const truncation: Truncation = { uninitialized: false, apps_omitted: 0, jobs_omitted_in: [], total_omitted: 0, uninspected: [] };
  for (const path of ['factory-data', APPS_PATH]) {
    const kind = await directoryKind(join(deps.mediatorRoot, path));
    if (kind === 'missing') {
      truncation.uninitialized = true;
      return { entries, truncation };
    }
    if (kind !== 'directory') {
      truncation.uninspected.push({ path, reason: kind });
      return { entries, truncation };
    }
  }
  const apps = join(deps.mediatorRoot, APPS_PATH);
  const appList = await ids(apps, QUEUE_LIMITS.apps);
  if (appList === undefined) {
    truncation.uninspected.push({ path: APPS_PATH, reason: 'cannot be listed' });
    return { entries, truncation };
  }
  truncation.apps_omitted = appList.omitted;
  const configs = new Map<string, string | null>();
  let inspected = 0;
  for (const appId of appList.ids) {
    const appPath = `${APPS_PATH}/${appId}`;
    const appKind = await directoryKind(join(deps.mediatorRoot, appPath));
    // Removed since it was listed: nothing to show.
    if (appKind === 'missing') continue;
    if (appKind !== 'directory') {
      truncation.uninspected.push({ path: appPath, reason: appKind });
      continue;
    }
    const jobsPath = `${appPath}/jobs`;
    const jobsKind = await directoryKind(join(deps.mediatorRoot, jobsPath));
    // A registered app gets its jobs directory with its first job.
    if (jobsKind === 'missing') continue;
    if (jobsKind !== 'directory') {
      truncation.uninspected.push({ path: jobsPath, reason: jobsKind });
      continue;
    }
    const jobList = await ids(join(deps.mediatorRoot, jobsPath), QUEUE_LIMITS.jobsPerApp);
    if (jobList === undefined) {
      truncation.uninspected.push({ path: jobsPath, reason: 'cannot be listed' });
      continue;
    }
    if (jobList.omitted > 0) truncation.jobs_omitted_in.push({ app_id: appId, omitted: jobList.omitted });
    for (const [index, jobId] of jobList.ids.entries()) {
      if (inspected >= QUEUE_LIMITS.jobs) {
        truncation.total_omitted += jobList.ids.length - index;
        break;
      }
      inspected += 1;
      const entry = await inspectJob(deps, appId, jobId, configs);
      if (entry !== undefined) entries.push(entry);
    }
  }
  return { entries, truncation };
}

// The configuration problem of an app, cached per scan (null: executable).
async function configProblem(deps: QueueDeps, appId: string, cache: Map<string, string | null>): Promise<string | null> {
  if (!cache.has(appId)) {
    try {
      await loadAppConfig(deps.mediatorRoot, appId);
      cache.set(appId, null);
    } catch (error) {
      cache.set(appId, error instanceof AppConfigError ? error.code : 'invalid_config');
    }
  }
  return cache.get(appId)!;
}

// One job's queue entry; undefined when it is not an accepted dispatch and the operator never touched it.
export async function inspectJob(deps: QueueDeps, appId: string, jobId: string, configs = new Map<string, string | null>()): Promise<QueueEntry | undefined> {
  const entry: QueueEntry = {
    app_id: appId,
    job_id: jobId,
    status: 'invalid',
    request_id: null,
    instruction_sha256: null,
    instruction_bytes: null,
    accepted_at: null,
    problem: null,
    execution: null,
    approval: null,
    deferred_at: null,
    rejected_at: null,
    last_launch: null,
    actions: [],
    next: null,
  };
  const jobs = new FactoryJobs(deps.mediatorRoot);
  let dispatch: DispatchRecord | undefined;
  let hasExecution = false;
  try {
    const read = await jobs.withJob(appId, jobId, false, async (job) => {
      const record = await readDispatchRecord(job, appId, jobId);
      if (record === undefined || record.state !== 'accepted') return { record, instruction: undefined, execution: false, receipt: false };
      let receipt = true;
      try {
        await checkAcceptedReceipt(job, record);
      } catch {
        receipt = false;
      }
      const instruction = await readJobFile(job, INSTRUCTION_FILE, MAX_INSTRUCTION_BYTES);
      return { record, instruction, execution: await jobFileExists(job, EXECUTION_FILE), receipt };
    });
    dispatch = read.record;
    hasExecution = read.execution;
    if (dispatch === undefined || dispatch.state !== 'accepted') return undefined;
    entry.request_id = dispatch.request_id;
    entry.instruction_sha256 = dispatch.instruction_sha256;
    entry.accepted_at = dispatch.updated_at;
    if (!read.receipt) entry.problem = problem('invalid_record');
    else if (read.instruction === undefined) entry.problem = problem('instruction_missing');
    else {
      entry.instruction_bytes = read.instruction.byteLength;
      if (createHash('sha256').update(read.instruction).digest('hex') !== dispatch.instruction_sha256) entry.problem = problem('instruction_mismatch');
    }
  } catch (error) {
    // A malformed or unreadable job is shown without details and does not stop the scan.
    entry.problem = problem((error as { code?: string }).code === 'invalid_record' ? 'invalid_record' : 'unreadable');
    return entry;
  }

  let operator: JobOperatorState;
  try {
    operator = await deps.store.jobState(appId, jobId);
  } catch {
    entry.problem = problem('operator_state');
    return entry;
  }
  const now = deps.now();
  entry.deferred_at = operator.deferred?.at ?? null;
  entry.rejected_at = operator.rejected?.at ?? null;
  if (operator.pending !== undefined) {
    entry.approval = { id: operator.pending.id, approved_at: operator.pending.approved_at, expired: expired(operator.pending, now) };
  }
  if (operator.launch !== undefined) {
    const { outcome, code, message, at, final_state } = operator.launch;
    entry.last_launch = { outcome, code, message, at, final_state };
  }

  if (hasExecution) {
    try {
      const status = await deps.service.status(appId, jobId);
      entry.execution = { state: status.state, error: status.error, recovery: status.recovery, process_alive: status.process_alive, artifacts: status.artifacts };
      const launchedHere = operator.launch !== undefined && operator.launch.outcome !== 'cancelled';
      const attending = launchedHere && (await attendAlive(operator));
      entry.status = status.state === 'prepared' && attending ? 'launching' : status.state;
      if (entry.status === 'prepared' && launchedHere && operator.pending === undefined && operator.rejected === undefined) {
        // Prepared by an approval whose launch did not start (e.g. another session held the gate): approve again to resume.
        entry.actions = ['approve'];
      } else if (operator.pending !== undefined && status.state === 'prepared') {
        entry.status = 'approved';
        entry.actions = ['cancel'];
      } else {
        entry.next = recoveryCommand(entry);
      }
    } catch {
      entry.status = 'invalid';
      entry.problem = problem('invalid_record');
    }
    return entry;
  }
  if (operator.rejected !== undefined) {
    entry.status = 'rejected';
    return entry;
  }
  if (operator.pending !== undefined) {
    entry.status = 'approved';
    entry.actions = ['cancel'];
    return entry;
  }
  if (operator.launch?.outcome === 'started') {
    if (await attendAlive(operator)) {
      entry.status = 'launching';
      return entry;
    }
    entry.last_launch = { ...entry.last_launch!, outcome: 'abandoned', message: 'The console ended before the job was prepared; nothing was started.' };
  }
  // The acceptance is not proven (receipt) or the instruction is not the accepted one.
  if (entry.problem !== null) {
    entry.status = 'invalid';
    return entry;
  }
  const config = await configProblem(deps, appId, configs);
  if (config !== null) {
    entry.status = 'accepted';
    entry.problem = problem(config);
    return entry;
  }
  entry.status = 'awaiting_operator';
  entry.actions = ['approve', 'reject', 'later'];
  return entry;
}

function recoveryCommand(entry: QueueEntry): string | null {
  const job = `${entry.app_id} ${entry.job_id}`;
  if (entry.status === 'prepared') return `scripts/sf006-execute.sh run ${job}`;
  const collectable = entry.status === 'pending_manual' || entry.status === 'interrupted' || (entry.status === 'running' && entry.execution?.process_alive === false);
  return collectable ? `scripts/sf006-execute.sh collect ${job}` : null;
}

async function attendAlive(operator: JobOperatorState): Promise<boolean> {
  return operator.launch?.attend != null && (await isAlive(operator.launch.attend));
}
