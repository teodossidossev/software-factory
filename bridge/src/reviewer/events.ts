// SF-010: durable review-ready events and the operator's review delegation check.
//
// An event is created only from committed state: managed.json must reference the iteration's
// snapshot by sha256, and the snapshot's bytes, diff and report must verify (the same checks as
// factory_review_snapshot). The supervisor creates it right after publishing (Supervisor option
// reviewReady); if it crashed in between, reconciliation creates the same event later from
// managed.json: the identity is deterministic (records.ts eventId), so both paths and any repeat
// produce one event. Events are only created for jobs with an unrevoked delegation, so jobs that
// were never delegated (all historical jobs) produce none.
import { checkJobDirectory, MAX_MANAGED_BYTES, readManaged, snapshotSchema, verifiedArtifacts, type ReviewRequest } from '../executor/records.js';
import { readJobFile, type FactoryJobs } from '../factory-jobs.js';
import { eventId, EVENT_SCHEMA, sha256, type ReviewDelegation } from './records.js';
import type { ReviewerState } from './store.js';

export interface SnapshotRef {
  appId: string;
  jobId: string;
  iterationId: string;
  snapshotSha256: string;
}

// created: a new event; exists: the same event was already there; not_published: managed.json does
// not (or no longer) reference this verified snapshot as the current ready iteration; not_delegated.
export type PublishOutcome = 'created' | 'exists' | 'not_published' | 'not_delegated';

export async function publishReviewReady(state: ReviewerState, jobs: FactoryJobs, ref: SnapshotRef, source: 'supervisor' | 'reconciliation', now: Date): Promise<PublishOutcome> {
  const delegation = await state.delegation(ref.appId, ref.jobId);
  if (delegation === undefined || (await state.revoked(delegation.delegation_id))) {
    return 'not_delegated';
  }
  const number = await jobs.withJob(ref.appId, ref.jobId, false, async (job): Promise<number | undefined> => {
    await checkJobDirectory(job);
    const managed = await readManaged(job);
    const iteration = managed?.iterations.find((entry) => entry.id === ref.iterationId);
    if (managed === undefined || iteration === undefined || managed.current_iteration !== iteration.id || iteration.state !== 'ready_for_review' || iteration.snapshot?.sha256 !== ref.snapshotSha256) {
      return undefined;
    }
    const bytes = await readJobFile(job, iteration.snapshot.file, MAX_MANAGED_BYTES);
    if (bytes === undefined || sha256(bytes) !== ref.snapshotSha256) {
      return undefined;
    }
    const snapshot = snapshotSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!snapshot.success || snapshot.data.app_id !== ref.appId || snapshot.data.job_id !== ref.jobId || snapshot.data.iteration_id !== ref.iterationId) {
      return undefined;
    }
    try {
      await verifiedArtifacts(job, snapshot.data);
    } catch {
      // Not a verified snapshot (a missing, substituted or changed artifact): no event.
      return undefined;
    }
    return iteration.number;
  });
  if (number === undefined) {
    return 'not_published';
  }
  const created = await state.createEvent({
    schema: EVENT_SCHEMA,
    event_id: eventId(ref.appId, ref.jobId, ref.iterationId, ref.snapshotSha256),
    app_id: ref.appId,
    job_id: ref.jobId,
    iteration_id: ref.iterationId,
    iteration_number: number,
    snapshot_sha256: ref.snapshotSha256,
    source,
    created_at: now.toISOString(),
  });
  return created ? 'created' : 'exists';
}

// Bounded reconciliation of one job: the event of its current ready iteration, from managed.json.
export async function reconcileJobEvent(state: ReviewerState, jobs: FactoryJobs, appId: string, jobId: string, now: Date): Promise<PublishOutcome> {
  const current = await jobs
    .withJob(appId, jobId, false, async (job) => {
      await checkJobDirectory(job);
      const managed = await readManaged(job);
      const iteration = managed?.iterations.find((entry) => entry.id === managed.current_iteration);
      return iteration?.state === 'ready_for_review' && iteration.snapshot !== null ? { iterationId: iteration.id, snapshotSha256: iteration.snapshot.sha256 } : undefined;
    })
    .catch(() => undefined);
  if (current === undefined) {
    return 'not_published';
  }
  return publishReviewReady(state, jobs, { appId, jobId, ...current }, 'reconciliation', now);
}

// Why the delegation does not cover a review now, or null. Checked by the coordinator before each
// step and by the supervisor (autonomousReviewCheck) immediately before delivery.
export async function delegationRefusal(
  state: ReviewerState,
  appId: string,
  jobId: string,
  expected: { delegationId?: string; provider?: string; authorizationId?: string },
  now: Date,
): Promise<{ code: string; delegation?: ReviewDelegation } | null> {
  let delegation: ReviewDelegation | undefined;
  try {
    delegation = await state.delegation(appId, jobId);
  } catch {
    return { code: 'delegation_unreadable' };
  }
  if (delegation === undefined) {
    return { code: 'delegation_missing' };
  }
  if (expected.delegationId !== undefined && delegation.delegation_id !== expected.delegationId) {
    return { code: 'delegation_replaced', delegation };
  }
  if (await state.revoked(delegation.delegation_id)) {
    return { code: 'delegation_revoked', delegation };
  }
  if (now.getTime() >= Date.parse(delegation.expires_at)) {
    return { code: 'delegation_expired', delegation };
  }
  if (now.getTime() - Date.parse(delegation.created_at) > delegation.limits.max_elapsed_ms) {
    return { code: 'elapsed_limit', delegation };
  }
  if (expected.authorizationId !== undefined && delegation.authorization_id !== expected.authorizationId) {
    return { code: 'delegation_mismatch', delegation };
  }
  if (expected.provider !== undefined && delegation.provider !== expected.provider) {
    return { code: 'provider_mismatch', delegation };
  }
  let optIn;
  try {
    optIn = await state.providerOptIn();
  } catch {
    return { code: 'provider_opt_in_unreadable', delegation };
  }
  if (optIn === undefined || optIn.provider !== delegation.provider) {
    return { code: 'provider_not_enabled', delegation };
  }
  return null;
}

// The supervisor's autonomousReview option: the delegation the review names still covers it, for
// the managed job's own authorization. Only wired where SF-010 is explicitly enabled (tests).
export function autonomousReviewCheck(state: ReviewerState, jobs: FactoryJobs, now: () => Date = () => new Date()): (request: ReviewRequest) => Promise<string | null> {
  return async (request) => {
    if (request.provenance === undefined) {
      return 'not_autonomous';
    }
    const authorizationId = await jobs.withJob(request.app_id, request.job_id, false, async (job) => (await readManaged(job))?.authorization_id);
    if (authorizationId === undefined) {
      return 'not_managed';
    }
    const refusal = await delegationRefusal(state, request.app_id, request.job_id, { delegationId: request.provenance.delegation_id, provider: request.provenance.provider, authorizationId }, now());
    return refusal?.code ?? null;
  };
}
