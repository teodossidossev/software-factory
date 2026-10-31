// SF-007 operator decisions. An approval is created only for a job the queue
// offers it for (awaiting the operator, or prepared by an earlier approval whose
// launch found another session running), only for the exact request id and
// instruction sha256 the operator was shown (and that dispatch.json still
// holds), only when the read-only SF-006 preflight (receipt, OpenClaw receiver
// record, app configuration, clean repository, runner, login, skill, and the
// host-wide session gate) is ready, and only when no other approval is pending.
// It binds the resolved app repository by its sha256. Nothing here starts a
// session, and no safety decision uses the display scan: the session gate in
// SF-006 run is what keeps sessions to one.
import { createHash } from 'node:crypto';
import { loadAppConfig } from '../execution/app-config.js';
import { inspectJob, type QueueDeps, type QueueEntry } from './queue.js';
import { expired, launchRecord, OperatorError, type ApprovalRecord, type JobOperatorState } from './store.js';

export interface Shown {
  request_id: string;
  instruction_sha256: string;
}

export type DecisionDeps = QueueDeps;

async function current(deps: QueueDeps, appId: string, jobId: string): Promise<QueueEntry> {
  const entry = await inspectJob(deps, appId, jobId);
  if (entry === undefined) throw new OperatorError('not_found', `${appId}/${jobId} is not an accepted job.`);
  return entry;
}

// The operator decided about what the console showed; the records must still say exactly that.
function checkShown(entry: QueueEntry, shown: Shown): void {
  if (entry.request_id !== shown.request_id || entry.instruction_sha256 !== shown.instruction_sha256) {
    throw new OperatorError('mismatch', `${entry.app_id}/${entry.job_id} changed since it was shown (request id or instruction sha256); reload and review it again.`);
  }
}

function requireStatus(entry: QueueEntry, action: string, allowed: QueueEntry['status'][]): void {
  if (!allowed.includes(entry.status)) {
    throw new OperatorError('wrong_status', `${entry.app_id}/${entry.job_id} is ${entry.status}; cannot ${action}.`);
  }
}

// Re-checked under the job's lock in the store, against the same files.
function stillUndecided(state: JobOperatorState): void {
  if (state.rejected !== undefined) throw new OperatorError('wrong_status', 'The job was rejected.');
  if (state.pending !== undefined) throw new OperatorError('conflict', 'The job already has a pending approval.');
}

export async function approve(deps: DecisionDeps, appId: string, jobId: string, shown: Shown): Promise<ApprovalRecord> {
  const entry = await current(deps, appId, jobId);
  checkShown(entry, shown);
  if (!entry.actions.includes('approve')) {
    throw new OperatorError('wrong_status', `${appId}/${jobId} is ${entry.status}; cannot approve.`);
  }
  const now = deps.now();
  if ((await deps.store.pendingApprovals()).some((pending) => pending === 'unreadable' || !expired(pending, now))) {
    throw new OperatorError('busy', 'Another approved job is being launched (or an approval record is unreadable); wait until its terminal has started.');
  }
  const report = await deps.service.preflight(appId, jobId);
  if (!report.ready) {
    if (report.checks.some((check) => !check.ok && check.code === 'session_busy')) {
      throw new OperatorError('busy', 'Another Claude session is running; approve this job when it has ended. Nothing was approved.');
    }
    const failed = report.checks.filter((check) => !check.ok).map((check) => `${check.name} (${check.code ?? 'not_ready'})`);
    throw new OperatorError('not_ready', `Preflight is not ready: ${failed.join(', ')}. Nothing was approved.`);
  }
  const config = await loadAppConfig(deps.mediatorRoot, appId);
  const record = await deps.store.createApproval(
    {
      app_id: appId,
      job_id: jobId,
      request_id: shown.request_id,
      instruction_sha256: shown.instruction_sha256,
      app_repo_sha256: createHash('sha256').update(config.repo).digest('hex'),
    },
    now,
    async (state) => stillUndecided(state),
  );
  await deps.store.appendEvent({ event: 'approved', app_id: appId, job_id: jobId, request_id: record.request_id, instruction_sha256: record.instruction_sha256, approval_id: record.id }, now);
  return record;
}

export async function reject(deps: DecisionDeps, appId: string, jobId: string, shown: Shown): Promise<void> {
  const entry = await current(deps, appId, jobId);
  checkShown(entry, shown);
  requireStatus(entry, 'reject', ['awaiting_operator', 'accepted']);
  const now = deps.now();
  await deps.store.reject(appId, jobId, { ...shown, at: now.toISOString() }, async (state) => stillUndecided(state));
  await deps.store.appendEvent({ event: 'rejected', app_id: appId, job_id: jobId, ...shown }, now);
}

export async function later(deps: DecisionDeps, appId: string, jobId: string, shown: Shown): Promise<void> {
  const entry = await current(deps, appId, jobId);
  checkShown(entry, shown);
  requireStatus(entry, 'defer', ['awaiting_operator', 'accepted']);
  const now = deps.now();
  await deps.store.defer(appId, jobId, { ...shown, at: now.toISOString() }, async (state) => stillUndecided(state));
  await deps.store.appendEvent({ event: 'deferred', app_id: appId, job_id: jobId, ...shown }, now);
}

// Withdraws a pending approval; fails once the terminal has consumed it.
export async function cancel(deps: DecisionDeps, appId: string, jobId: string, approvalId: string): Promise<void> {
  const now = deps.now();
  const settled = await deps.store.settleApproval(
    appId,
    jobId,
    approvalId,
    'cancelled',
    launchRecord('cancelled', now, { code: 'cancelled', message: 'The operator cancelled the approval before launch.' }),
  );
  if (settled === undefined) throw new OperatorError('conflict', `${appId}/${jobId} has no pending approval ${approvalId}; it may already have started.`);
  await deps.store.appendEvent({ event: 'cancelled', app_id: appId, job_id: jobId, request_id: settled.request_id, instruction_sha256: settled.instruction_sha256, approval_id: settled.id }, now);
}
