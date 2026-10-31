// SF-010 recovery: crash windows (before the event, after an attempt was counted, before and after
// the review request was written), duplicate events and notifications, concurrent coordinators,
// uncertain delivery, and durable budgets across restarts. Fake stream-json Claude only.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { afterEach, beforeEach, test } from 'node:test';
import { FactoryJobs } from '../src/factory-jobs.js';
import { ReviewCoordinator } from '../src/reviewer/coordinator.js';
import { publishReviewReady } from '../src/reviewer/events.js';
import { PROVIDER_OPT_IN_SCHEMA } from '../src/reviewer/records.js';
import { destroyFixture, jobDir, type Fixture } from './support/operator-fixture.js';
import { createExecutorFixture, enableApp, gateway, messages, waitFor, waitForStatus } from './support/executor-fixture.js';
import { delegate, entryFor, readyJob, reviewerState, secondLineRule, startCoordinator } from './support/reviewer-fixture.js';
import { OfflineReviewProvider } from '../src/reviewer/provider.js';

let fx: Fixture;

// A fresh fixture per test: an unaccepted job leaves the disposable repository changed.
beforeEach(async () => {
  fx = await createExecutorFixture();
  await enableApp(fx);
});

afterEach(async () => {
  await destroyFixture(fx);
});

const reviewFiles = async (job: string): Promise<string[]> => (await readdir(jobDir(fx, job))).filter((name) => /^review-.*\.json$/.test(name));
const crash = async (): Promise<void> => {
  throw new Error('simulated crash');
};

test('a crash before the event: reconciliation creates the same event; duplicates and notification storms deliver once', async () => {
  const job = 'job-reconcile';
  // The supervisor's event write fails every time (as if it crashed right after publishing).
  const { supervisor } = await readyJob(fx, job, { supervisor: { reviewReady: crash } });
  const state = await reviewerState(fx);
  try {
    assert.deepEqual((await state.events(fx.app, job)).events, [], 'no event yet');
    const snap1 = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
    const ref = { appId: fx.app, jobId: job, iterationId: 'iteration-001', snapshotSha256: snap1.snapshot_sha256 };
    // Duplicate creation from both paths: one event.
    const jobs = new FactoryJobs(fx.mediator);
    const outcomes = await Promise.all([publishReviewReady(state, jobs, ref, 'reconciliation', new Date()), publishReviewReady(state, jobs, ref, 'supervisor', new Date()), publishReviewReady(state, jobs, ref, 'reconciliation', new Date())]);
    assert.deepEqual(outcomes.filter((outcome) => outcome === 'created').length, 1);
    assert.deepEqual(outcomes.filter((outcome) => outcome === 'exists').length, 2);
    // A snapshot that is not the referenced one never becomes an event.
    assert.equal(await publishReviewReady(state, jobs, { ...ref, snapshotSha256: 'e'.repeat(64) }, 'supervisor', new Date()), 'not_published');

    const coordinator = await startCoordinator(fx, secondLineRule, { backstopMs: 3_600_000 });
    try {
      // A storm of duplicate, out-of-order notifications and direct passes.
      for (let index = 0; index < 20; index += 1) {
        coordinator.coordinator.notify(fx.app, job);
        coordinator.coordinator.notify();
      }
      await Promise.all([coordinator.coordinator.processJob(fx.app, job), coordinator.coordinator.processJob(fx.app, job), coordinator.coordinator.reconcile()]);
      await waitForStatus(fx, job, (status) => status.job?.current_iteration === 'iteration-002' && status.status === 'awaiting_review', 'iteration-002 ready');
      // iteration-002's event is recovered by reconciliation too (the hook keeps failing).
      await entryFor(fx, job, 'iteration-002', (entry) => entry.state === 'clean_awaiting_acceptance', 'clean verdict');
      const events = (await state.events(fx.app, job)).events;
      assert.deepEqual(events.map((event) => event.iteration_id), ['iteration-001', 'iteration-002']);
      assert.equal(events[1]!.source, 'reconciliation');
      assert.deepEqual(coordinator.provider.calls.filter((call) => call.job_id === job).map((call) => call.iteration_id), ['iteration-001', 'iteration-002'], 'one provider call per event');
      assert.equal((await reviewFiles(job)).length, 1, 'one review request');
      assert.equal((await messages(fx)).filter((message) => message.text.includes('Add the second line') && message.text.startsWith('Software Factory review')).length, 1, 'delivered once');
    } finally {
      await coordinator.stop();
    }
  } finally {
    await supervisor.stop();
  }
});

test('concurrent coordinators: a second one is refused while the first runs, and creates nothing', async () => {
  await (await reviewerState(fx)).setProviderOptIn({ schema: PROVIDER_OPT_IN_SCHEMA, provider: 'offline-fixture', enabled_at: new Date().toISOString(), issuer: 'operator:sf010-reviewer provider-enable' });
  const first = await startCoordinator(fx, secondLineRule);
  try {
    await assert.rejects(startCoordinator(fx, secondLineRule), { code: 'locked' });
  } finally {
    await first.stop();
  }
  const again = await startCoordinator(fx, secondLineRule);
  await again.stop();
});

test('a crash after an attempt was counted keeps it spent; the restart retries within the budget and delivers once', async () => {
  const job = 'job-attempt-crash';
  const { supervisor } = await readyJob(fx, job, { limits: { max_attempts: 3 } });
  try {
    // Every attempt of this coordinator "crashes" after it was counted (a notification may retry it).
    const crashed = await startCoordinator(fx, secondLineRule, { afterAttemptRecorded: crash });
    let spent: number;
    try {
      await entryFor(fx, job, 'iteration-001', (value) => value.state === 'provider_running', 'attempt counted');
    } finally {
      await crashed.stop();
      spent = (await entryFor(fx, job, 'iteration-001', () => true, 'entry')).attempts;
    }
    assert.ok(spent >= 1 && spent < 3);
    assert.equal(crashed.provider.calls.filter((call) => call.job_id === job).length, 0, 'the provider never ran');
    const restarted = await startCoordinator(fx, secondLineRule);
    try {
      await entryFor(fx, job, 'iteration-001', (value) => value.state === 'delivered', 'delivered after restart');
      const state = (await (await reviewerState(fx)).jobState(fx.app, job))!;
      assert.equal(state.reviews[0]!.attempts, spent + 1, 'the crashed attempts stay counted');
      assert.equal(state.usage.attempts, spent + 1);
      assert.equal((await reviewFiles(job)).length, 1);
    } finally {
      await restarted.stop();
    }
  } finally {
    await supervisor.stop();
  }
});

for (const [job, seam] of [
  ['job-before-write', 'beforeSubmit'],
  ['job-after-write', 'afterSubmit'],
] as const) {
  test(`a crash ${seam === 'beforeSubmit' ? 'before' : 'after'} the request was written: the restart submits the same review once, never twice`, async () => {
    const { supervisor } = await readyJob(fx, job);
    try {
      const crashed = await startCoordinator(fx, secondLineRule, { [seam]: crash });
      try {
        const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state !== 'pending' && value.state !== 'provider_running', 'findings recorded');
        assert.notEqual(entry.submission, null);
        if (seam === 'beforeSubmit') {
          assert.equal(entry.state, 'submitting');
          assert.equal((await reviewFiles(job)).length, 0, 'nothing written yet');
        } else {
          await waitFor(async () => (await reviewFiles(job)).length === 1, 'the request was written');
        }
      } finally {
        await crashed.stop();
      }
      if (seam === 'afterSubmit') {
        // The supervisor may already have delivered the written request.
        await waitForStatus(fx, job, (status) => status.job?.reviews.length === 1, 'the supervisor took the request');
      }
      const restarted = await startCoordinator(fx, secondLineRule);
      try {
        const done = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'delivered', 'delivered');
        assert.equal(done.attempts, 1, 'the provider is not asked again for recorded findings');
        assert.equal(restarted.provider.calls.filter((call) => call.job_id === job && call.iteration_id === 'iteration-001').length, 0);
        assert.equal((await reviewFiles(job)).length, 1, 'one request file');
        const status = await gateway(fx).status(fx.app, job);
        assert.deepEqual(status.job?.reviews.map((review) => [review.outcome, review.source]), [['delivered', 'autonomous_reviewer']]);
      } finally {
        await restarted.stop();
      }
    } finally {
      await supervisor.stop();
    }
  });
}

test('uncertain delivery is reported and never resent', async () => {
  const job = 'job-unconfirmed';
  let fail = true;
  const { supervisor } = await readyJob(fx, job, {
    supervisor: {
      beforeReviewWrite: () => {
        if (fail) {
          fail = false;
          throw new Error('write failed');
        }
      },
    },
  });
  const coordinator = await startCoordinator(fx, secondLineRule);
  try {
    const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'unconfirmed', 'unconfirmed');
    assert.equal(entry.code, 'send_failed');
    const ended = await waitForStatus(fx, job, (status) => status.status === 'needs_inspection', 'ended for inspection');
    assert.deepEqual(ended.job?.reviews.map((review) => [review.outcome, review.reason]), [['unconfirmed', 'send_failed']]);
    await coordinator.coordinator.reconcile();
    await coordinator.coordinator.processJob(fx.app, job);
    assert.equal((await reviewFiles(job)).length, 1, 'never resent');
    assert.equal(coordinator.provider.calls.filter((call) => call.job_id === job).length, 1);
    assert.equal((await entryFor(fx, job, 'iteration-001', () => true, 'entry')).state, 'unconfirmed');
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('budgets are durable: invalid output and timeouts spend attempts; a restart does not refill them', async () => {
  const job = 'job-budget';
  const { supervisor } = await readyJob(fx, job, { limits: { max_attempts: 2, attempt_timeout_ms: 200 } });
  try {
    let call = 0;
    // First a malformed answer, then one that never comes (timeout).
    const flaky = await startCoordinator(fx, () => (call++ === 0 ? { outcome: 'findings', summary: 'x', findings: [{ file: 'README.md', line: 1, severity: 'urgent', text: 'x' }] } : new Promise(() => undefined)));
    try {
      const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'attempts_exhausted', 'attempts exhausted');
      assert.equal(entry.code, 'provider_timeout');
      assert.equal(entry.attempts, 2);
      assert.equal(entry.submission, null);
    } finally {
      await flaky.stop();
    }
    const restarted = await startCoordinator(fx, secondLineRule);
    try {
      await restarted.coordinator.reconcile();
      assert.equal(restarted.provider.calls.filter((value) => value.job_id === job).length, 0, 'no attempt left after the restart');
      const state = (await (await reviewerState(fx)).jobState(fx.app, job))!;
      assert.equal(state.usage.attempts, 2);
      assert.deepEqual(await reviewFiles(job), []);
      assert.equal((await gateway(fx).status(fx.app, job)).status, 'awaiting_review', 'the job is untouched');
    } finally {
      await restarted.stop();
    }
  } finally {
    await supervisor.stop();
  }
});

test('the review budget: after max_reviews the next iteration is not reviewed', async () => {
  const job = 'job-review-limit';
  const { supervisor } = await readyJob(fx, job, { limits: { max_reviews: 1 } });
  const coordinator = await startCoordinator(fx, secondLineRule);
  try {
    await entryFor(fx, job, 'iteration-001', (value) => value.state === 'delivered', 'delivered');
    const limited = await entryFor(fx, job, 'iteration-002', (value) => value.state === 'review_limit', 'review limit');
    assert.equal(limited.attempts, 0);
    assert.equal(coordinator.provider.calls.filter((call) => call.job_id === job).length, 1);
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('start refuses without a provider this process has, and then creates nothing', async () => {
  await assert.rejects(ReviewCoordinator.start({ mediatorRoot: fx.mediator, stateHome: `${fx.sandbox}/no-state`, providers: [] }), { code: 'provider_unavailable' });
  await assert.rejects(readdir(`${fx.sandbox}/no-state`), { code: 'ENOENT' });
});

test('R4: findings recorded under a revoked grant are never delivered under a new delegation or provider', async () => {
  const job = 'job-redelegate';
  const { supervisor, delegation: first, authorizationId } = await readyJob(fx, job);
  try {
    // Provider A answers; the coordinator "crashes" before the request is written.
    const crashed = await startCoordinator(fx, secondLineRule, { beforeSubmit: crash });
    try {
      await entryFor(fx, job, 'iteration-001', (value) => value.state === 'submitting', 'findings of A recorded');
    } finally {
      await crashed.stop();
    }
    const state = await reviewerState(fx);
    await state.revoke(first!.delegation_id);
    const second = await delegate(fx, job, authorizationId, {}, 'offline-b');
    const providerB = new OfflineReviewProvider(secondLineRule, 'offline-b');
    const restarted = await ReviewCoordinator.start({ mediatorRoot: fx.mediator, stateHome: fx.stateHome, providers: [providerB] });
    const done = restarted.run();
    try {
      const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'delegation_invalid', 'not relabelled');
      assert.equal(entry.code, 'delegation_replaced');
      assert.deepEqual([entry.delegation_id, entry.provider], [first!.delegation_id, 'offline-fixture'], 'the entry keeps its original grant');
      assert.equal(entry.submission, null);
      assert.deepEqual(await reviewFiles(job), [], 'nothing was written');
      assert.equal(providerB.calls.length, 0);
      const job2 = (await state.jobState(fx.app, job))!;
      assert.deepEqual([job2.delegation_id, job2.usage.reviews], [second.delegation_id, 0]);
      assert.equal((await messages(fx)).filter((message) => message.text.startsWith('Software Factory review')).length, 0);
    } finally {
      await restarted.close();
      await done;
    }
  } finally {
    await supervisor.stop();
  }
});
