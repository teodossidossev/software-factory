// SF-010 test support: the SF-009 executor fixture (throwaway mediator, disposable app repository,
// fake stream-json Claude, private state home) plus the review coordinator with the deterministic
// offline provider. No real Claude Code, model or network is used.
import { randomUUID } from 'node:crypto';
import { FactoryJobs } from '../../src/factory-jobs.js';
import { autonomousReviewCheck, publishReviewReady } from '../../src/reviewer/events.js';
import { ReviewCoordinator, type CoordinatorOptions } from '../../src/reviewer/coordinator.js';
import { OfflineReviewProvider, type OfflineRule } from '../../src/reviewer/provider.js';
import { DELEGATION_SCHEMA, PROVIDER_OPT_IN_SCHEMA, type ReviewDelegation, type ReviewEntry, type ReviewLimits } from '../../src/reviewer/records.js';
import { ReviewerState } from '../../src/reviewer/store.js';
import type { SupervisorOptions } from '../../src/executor/supervisor.js';
import { acceptedJob, type Fixture } from './operator-fixture.js';
import { authorize, startSupervisor, waitFor, waitForStatus } from './executor-fixture.js';

export const LIMITS: ReviewLimits = { max_attempts: 6, max_reviews: 4, max_elapsed_ms: 60 * 60_000, max_input_bytes: 1024 * 1024, attempt_timeout_ms: 2000 };

export const reviewerState = (fx: Fixture): Promise<ReviewerState> => ReviewerState.open(fx.stateHome, fx.mediator);

// The operator's two explicit steps: the provider opt-in and the per-job delegation.
export async function delegate(fx: Fixture, job: string, authorizationId: string, limits: Partial<ReviewLimits> = {}, provider = 'offline-fixture', createdAt = new Date()): Promise<ReviewDelegation> {
  const state = await reviewerState(fx);
  await state.setProviderOptIn({ schema: PROVIDER_OPT_IN_SCHEMA, provider, enabled_at: new Date().toISOString(), issuer: 'operator:sf010-reviewer provider-enable' });
  const delegation: ReviewDelegation = {
    schema: DELEGATION_SCHEMA,
    delegation_id: randomUUID(),
    app_id: fx.app,
    job_id: job,
    authorization_id: authorizationId,
    provider,
    limits: { ...LIMITS, ...limits },
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + 2 * 60 * 60_000).toISOString(),
    issuer: 'operator:sf010-reviewer delegate',
  };
  await state.createDelegation(delegation);
  return delegation;
}

// The supervisor with SF-010 wired in (as no production entry point does).
export async function startReviewingSupervisor(fx: Fixture, options: Partial<SupervisorOptions> = {}): ReturnType<typeof startSupervisor> {
  const state = await reviewerState(fx);
  const jobs = new FactoryJobs(fx.mediator);
  return startSupervisor(fx, {
    reviewReady: async (ref) => void (await publishReviewReady(state, jobs, ref, 'supervisor', new Date())),
    autonomousReview: autonomousReviewCheck(state, jobs),
    ...options,
  });
}

export async function startCoordinator(
  fx: Fixture,
  rule?: OfflineRule,
  options: Partial<CoordinatorOptions> = {},
): Promise<{ coordinator: ReviewCoordinator; provider: OfflineReviewProvider; done: Promise<void>; stop: () => Promise<void>; logs: string[] }> {
  const provider = new OfflineReviewProvider(rule);
  const logs: string[] = [];
  const coordinator = await ReviewCoordinator.start({ mediatorRoot: fx.mediator, stateHome: fx.stateHome, providers: [provider], log: (line) => logs.push(line), ...options });
  const done = coordinator.run();
  return {
    coordinator,
    provider,
    done,
    logs,
    stop: async () => {
      await coordinator.close();
      await done;
    },
  };
}

// The offline rule of the end-to-end tests: one finding until the README has the second line.
export const secondLineRule: OfflineRule = (input) =>
  /^\+second$/m.test(input.diff.text)
    ? { outcome: 'clean', summary: 'The README has both lines.' }
    : { outcome: 'findings', summary: 'One line is missing.', findings: [{ file: 'README.md', line: 1, severity: 'major', text: 'Add the second line. FAKE-EDIT README.md second' }] };

// An accepted, authorized and delegated job whose iteration-001 is awaiting review, with the
// SF-010-wired supervisor running. delegate: false leaves it undelegated.
export async function readyJob(
  fx: Fixture,
  job: string,
  options: { limits?: Partial<ReviewLimits>; supervisor?: Partial<SupervisorOptions>; delegate?: boolean; createdAt?: Date; wired?: boolean } = {},
): Promise<{ supervisor: Awaited<ReturnType<typeof startSupervisor>>; delegation: ReviewDelegation | undefined; authorizationId: string }> {
  const accepted = await acceptedJob(fx, job);
  const authorizationId = randomUUID();
  const delegation = options.delegate === false ? undefined : await delegate(fx, job, authorizationId, options.limits ?? {}, 'offline-fixture', options.createdAt);
  const supervisor = options.wired === false ? await startSupervisor(fx, options.supervisor ?? {}) : await startReviewingSupervisor(fx, options.supervisor ?? {});
  try {
    await authorize(fx, job, accepted, authorizationId);
    await waitForStatus(fx, job, (status) => status.status === 'awaiting_review' && status.job?.current_iteration === 'iteration-001', `${job} iteration-001 ready`);
  } catch (error) {
    await supervisor.stop();
    throw error;
  }
  return { supervisor, delegation, authorizationId };
}

// The coordinator's entry for one iteration of a job once predicate holds.
export async function entryFor(fx: Fixture, job: string, iteration: string, predicate: (entry: ReviewEntry) => boolean, what: string, timeoutMs = 15_000): Promise<ReviewEntry> {
  const state = await reviewerState(fx);
  let last = 'none';
  try {
    return await waitFor(async () => {
      const entry = (await state.jobState(fx.app, job))?.reviews.find((review) => review.iteration_id === iteration);
      last = entry === undefined ? 'none' : `${entry.state} ${entry.code ?? '-'}`;
      return entry !== undefined && predicate(entry) ? entry : undefined;
    }, what, timeoutMs);
  } catch (error) {
    throw new Error(`${(error as Error).message}; last entry: ${last}`);
  }
}
