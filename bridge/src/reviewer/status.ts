// SF-010: read-only views of the review coordinator. Both open the private state with
// ReviewerState.openExisting and read the mediator with create=false: they create no directory or
// file, also when nothing exists yet, and change nothing.
import { join } from 'node:path';
import { FactoryJobs } from '../factory-jobs.js';
import { lockHolder, isAlive } from '../execution/process-identity.js';
import { checkJobDirectory, readManaged, type ManagedRecord } from '../executor/records.js';
import { delegationRefusal } from './events.js';
import { buildReviewInput } from './input.js';
import { EVENT_SCHEMA, eventId, type ReviewDelegation, type ReviewEntry } from './records.js';
import { ReviewerState } from './store.js';

export interface ReviewerJobView {
  app_id: string;
  job_id: string;
  delegation: { delegation_id: string; provider: string; state: 'active' | 'revoked' | 'expired' | 'elapsed'; expires_at: string; limits: ReviewDelegation['limits'] } | null;
  usage: { attempts: number; reviews: number } | null;
  events: number;
  reviews: Array<Pick<ReviewEntry, 'iteration_id' | 'snapshot_sha256' | 'state' | 'code' | 'attempts' | 'review_id'>>;
  // The latest review's state; clean_awaiting_acceptance means: the operator decides; nothing was accepted.
  latest: string | null;
  error: string | null;
}

export interface ReviewerStatusView {
  present: boolean;
  provider: { provider: string; enabled_at: string } | null;
  coordinator: { running: boolean; pid: number | null };
  jobs: ReviewerJobView[];
  complete: boolean;
  note: string;
}

const delegationState = async (state: ReviewerState, delegation: ReviewDelegation, now: Date): Promise<NonNullable<ReviewerJobView['delegation']>['state']> => {
  if (await state.revoked(delegation.delegation_id)) {
    return 'revoked';
  }
  if (now.getTime() >= Date.parse(delegation.expires_at)) {
    return 'expired';
  }
  return now.getTime() - Date.parse(delegation.created_at) > delegation.limits.max_elapsed_ms ? 'elapsed' : 'active';
};

export async function reviewerStatus(stateHome: string, mediatorRoot: string, now: Date, filter: { app?: string; job?: string } = {}): Promise<ReviewerStatusView> {
  const state = await ReviewerState.openExisting(stateHome, mediatorRoot);
  const optIn = await state.providerOptIn().catch(() => undefined);
  const holder = await lockHolder(join(state.dir, 'coordinator')).catch(() => undefined);
  const running = holder !== undefined && (await isAlive(holder).catch(() => false));
  const { jobs, complete } = await state.delegatedJobs();
  const views: ReviewerJobView[] = [];
  for (const { appId, jobId } of jobs) {
    if ((filter.app !== undefined && filter.app !== appId) || (filter.job !== undefined && filter.job !== jobId)) {
      continue;
    }
    try {
      const delegation = (await state.delegation(appId, jobId))!;
      const job = await state.jobState(appId, jobId);
      const events = await state.events(appId, jobId);
      const reviews = (job?.reviews ?? []).slice(-20).map((entry) => ({ iteration_id: entry.iteration_id, snapshot_sha256: entry.snapshot_sha256, state: entry.state, code: entry.code, attempts: entry.attempts, review_id: entry.review_id }));
      views.push({
        app_id: appId,
        job_id: jobId,
        delegation: { delegation_id: delegation.delegation_id, provider: delegation.provider, state: await delegationState(state, delegation, now), expires_at: delegation.expires_at, limits: delegation.limits },
        usage: job?.usage ?? null,
        events: events.events.length,
        reviews,
        latest: reviews.at(-1)?.state ?? null,
        error: null,
      });
    } catch (error) {
      views.push({ app_id: appId, job_id: jobId, delegation: null, usage: null, events: 0, reviews: [], latest: null, error: (error as { code?: string }).code ?? 'unreadable' });
    }
  }
  const present = optIn !== undefined || jobs.length > 0;
  return {
    present,
    provider: optIn === undefined ? null : { provider: optIn.provider, enabled_at: optIn.enabled_at },
    coordinator: { running, pid: running ? holder!.pid : null },
    jobs: views,
    complete,
    note: present
      ? 'A clean verdict means: awaiting the operator\'s acceptance. Nothing here accepts, closes or authorizes a job.'
      : 'No reviewer state: no provider opt-in and no delegation. Autonomous review is not enabled for any job.',
  };
}

export interface DryRunView {
  app_id: string;
  job_id: string;
  // What a coordinator would do now: not_delegated, delegation_invalid, provider_unavailable,
  // no_ready_iteration, already_handled, reviewer_state_unreadable, review_limit, attempts_exhausted,
  // would_review, input_blocked, wait, superseded, job_ended.
  decision: string;
  code: string | null;
  iteration_id: string | null;
  snapshot_sha256: string | null;
  event_id: string | null;
  input: { bytes: number; input_sha256: string; reviewable_paths: number } | null;
  note: string;
}

// availableProviders: the providers this build could run (none in production).
export async function dryRun(stateHome: string, mediatorRoot: string, appId: string, jobId: string, availableProviders: readonly string[], now: Date): Promise<DryRunView> {
  const state = await ReviewerState.openExisting(stateHome, mediatorRoot);
  const jobs = new FactoryJobs(mediatorRoot);
  const view = (decision: string, code: string | null, extra: Partial<DryRunView> = {}): DryRunView => ({
    app_id: appId,
    job_id: jobId,
    decision,
    code,
    iteration_id: null,
    snapshot_sha256: null,
    event_id: null,
    input: null,
    note: 'Dry run: nothing was written, created or sent.',
    ...extra,
  });
  const delegation = await state.delegation(appId, jobId).catch(() => undefined);
  if (delegation === undefined) {
    return view('not_delegated', null);
  }
  let managed: ManagedRecord | undefined;
  try {
    managed = await jobs.withJob(appId, jobId, false, async (job) => {
      await checkJobDirectory(job);
      return readManaged(job);
    });
  } catch (error) {
    return view('wait', (error as { code?: string }).code ?? 'job_unreadable');
  }
  if (managed === undefined) {
    return view('wait', 'not_managed');
  }
  const refusal = await delegationRefusal(state, appId, jobId, { authorizationId: managed.authorization_id }, now);
  if (refusal !== null) {
    return view('delegation_invalid', refusal.code);
  }
  if (!availableProviders.includes(delegation.provider)) {
    return view('provider_unavailable', 'provider_unavailable', { note: `The delegated provider ${delegation.provider} is not available in this build; real operation stays disabled. Nothing was written.` });
  }
  const iteration = managed.iterations.find((entry) => entry.id === managed.current_iteration);
  if (iteration === undefined || iteration.state !== 'ready_for_review' || iteration.snapshot === null) {
    return view('no_ready_iteration', null);
  }
  const id = eventId(appId, jobId, iteration.id, iteration.snapshot.sha256);
  const where = { iteration_id: iteration.id, snapshot_sha256: iteration.snapshot.sha256, event_id: id };
  let job;
  try {
    job = await state.jobState(appId, jobId);
  } catch (error) {
    // The coordinator cannot read its budgets either: it would stop here.
    return view('reviewer_state_unreadable', (error as { code?: string }).code ?? 'invalid_record', where);
  }
  const entry = job?.reviews.find((review) => review.event_id === id);
  if (entry !== undefined && entry.state !== 'pending') {
    return view('already_handled', entry.state, where);
  }
  // The budgets of this delegation (a state of an earlier delegation does not count, as in the coordinator).
  if (job !== undefined && job.delegation_id === delegation.delegation_id) {
    if (job.usage.reviews >= delegation.limits.max_reviews) {
      return view('review_limit', 'review_limit', where);
    }
    if (job.usage.attempts >= delegation.limits.max_attempts) {
      return view('attempts_exhausted', 'attempt_limit', where);
    }
  }
  const built = await buildReviewInput(jobs, { schema: EVENT_SCHEMA, event_id: id, app_id: appId, job_id: jobId, iteration_id: iteration.id, iteration_number: iteration.number, snapshot_sha256: iteration.snapshot.sha256, source: 'reconciliation', created_at: now.toISOString() }, delegation.limits.max_input_bytes);
  if (!built.ok) {
    return view(built.disposition === 'blocked' ? 'input_blocked' : built.disposition, built.code, where);
  }
  return view('would_review', null, { ...where, input: { bytes: built.input.bytes, input_sha256: built.input.input_sha256, reviewable_paths: built.input.reviewable_paths.length } });
}
