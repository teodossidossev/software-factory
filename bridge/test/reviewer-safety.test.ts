// SF-010 safety: stale snapshots and manual ChatGPT reviews, competing requests, a changed tree,
// withheld or tampered material, invalid provider references, expired and revoked delegations
// (also between submission and delivery), an unwired supervisor, session replacement, dry-run.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, copyFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { dryRun } from '../src/reviewer/status.js';
import { publishReviewReady } from '../src/reviewer/events.js';
import { FactoryJobs } from '../src/factory-jobs.js';
import { JOB_STATE_SCHEMA } from '../src/reviewer/records.js';
import { destroyFixture, jobDir, type Fixture } from './support/operator-fixture.js';
import { createExecutorFixture, enableApp, gateway, messages, setStreamMode, waitFor, waitForStatus } from './support/executor-fixture.js';
import { entryFor, readyJob, reviewerState, secondLineRule, startCoordinator } from './support/reviewer-fixture.js';

let fx: Fixture;

beforeEach(async () => {
  fx = await createExecutorFixture();
  await enableApp(fx);
});

afterEach(async () => {
  await destroyFixture(fx);
});

const reviewMessages = async (): Promise<number> => (await messages(fx)).filter((message) => message.text.startsWith('Software Factory review')).length;

test('a manual ChatGPT review first: the stale event is superseded, the next iteration is reviewed', async () => {
  const job = 'job-manual';
  const { supervisor } = await readyJob(fx, job);
  try {
    const snap1 = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
    await gateway(fx).submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap1.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'Manual. FAKE-EDIT README.md second' }] });
    await waitForStatus(fx, job, (status) => status.job?.current_iteration === 'iteration-002' && status.status === 'awaiting_review', 'iteration-002 ready');
    const coordinator = await startCoordinator(fx, secondLineRule);
    try {
      const stale = await entryFor(fx, job, 'iteration-001', (entry) => entry.state === 'superseded', 'superseded');
      assert.equal(stale.code, 'stale_snapshot');
      assert.equal(stale.attempts, 0);
      await entryFor(fx, job, 'iteration-002', (entry) => entry.state === 'clean_awaiting_acceptance', 'clean');
      const status = await gateway(fx).status(fx.app, job);
      assert.deepEqual(status.job?.reviews.map((review) => review.source), ['mcp']);
      assert.deepEqual(coordinator.provider.calls.map((call) => call.iteration_id), ['iteration-002']);
    } finally {
      await coordinator.stop();
    }
  } finally {
    await supervisor.stop();
  }
});

test('a competing ChatGPT review while findings are pending: exactly one review reaches Claude', async () => {
  const job = 'job-compete';
  const { supervisor } = await readyJob(fx, job);
  const snap1 = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
  let manual: string | undefined;
  const coordinator = await startCoordinator(fx, secondLineRule, {
    beforeSubmit: async () => {
      manual ??= (await gateway(fx).submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap1.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'Manual first. FAKE-EDIT README.md second' }] })).review_id;
    },
  });
  try {
    const entry = await entryFor(fx, job, 'iteration-001', (value) => ['competing_review', 'superseded'].includes(value.state), 'lost to the manual review');
    assert.notEqual(entry.submission_sha256, null, 'the findings were recorded (only their hash is kept once final)');
    const status = await waitForStatus(fx, job, (value) => value.job?.current_iteration === 'iteration-002' && value.job.reviews[0]?.outcome === 'delivered', 'the manual review delivered');
    assert.deepEqual(status.job?.reviews.map((review) => [review.review_id, review.outcome, review.source]), [[manual, 'delivered', 'mcp']]);
    assert.ok(!(await readdir(jobDir(fx, job))).includes(`review-${entry.review_id}.json`), 'the autonomous review was never written');
    assert.equal(await reviewMessages(), 1);
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('a tree changed after the review input was read: the supervisor refuses it and nothing reaches Claude', async () => {
  const job = 'job-tree';
  const { supervisor } = await readyJob(fx, job);
  const coordinator = await startCoordinator(fx, secondLineRule, {
    beforeSubmit: async () => appendFile(join(fx.appRepo, 'README.md'), 'changed by someone else\n'),
  });
  try {
    const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'rejected', 'rejected');
    assert.equal(entry.code, 'tree_changed');
    const ended = await waitForStatus(fx, job, (status) => status.status === 'needs_inspection', 'conflict');
    assert.equal(ended.job?.iterations[0]?.state, 'conflict');
    assert.equal(await reviewMessages(), 0);
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('withheld or tampered material blocks the review and never yields a clean verdict', async () => {
  await setStreamMode(fx, 'implement-secret');
  const job = 'job-withheld';
  const { supervisor } = await readyJob(fx, job);
  const always = () => ({ outcome: 'clean', summary: 'Looks fine.' });
  try {
    const coordinator = await startCoordinator(fx, always);
    try {
      const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'input_blocked', 'blocked');
      assert.equal(entry.code, 'input_withheld');
      assert.equal(coordinator.provider.calls.length, 0, 'the provider never saw it');
    } finally {
      await coordinator.stop();
    }
  } finally {
    await supervisor.stop();
  }
});

test('a symlinked artifact blocks the review (never followed)', async () => {
  const job = 'job-symlink';
  const { supervisor } = await readyJob(fx, job);
  try {
    // The event of the verified snapshot exists first; then the report is replaced by a symlink.
    const state = await reviewerState(fx);
    await waitFor(async () => (await state.events(fx.app, job)).events.length === 1, 'the event');
    const dir = jobDir(fx, job);
    await copyFile(join(dir, 'iteration-001.report.md'), join(fx.sandbox, 'report-copy.md'));
    await rm(join(dir, 'iteration-001.report.md'));
    await symlink(join(fx.sandbox, 'report-copy.md'), join(dir, 'iteration-001.report.md'));
    const coordinator = await startCoordinator(fx, () => ({ outcome: 'clean', summary: 'fine' }));
    try {
      const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'input_blocked', 'blocked').catch((error: Error) => {
        throw new Error(`${error.message}; logs: ${coordinator.logs.join(' | ')}`);
      });
      assert.equal(entry.code, 'artifact_invalid');
      assert.equal(coordinator.provider.calls.length, 0);
      // Reconciliation never publishes an event for the tampered snapshot either.
      const snap = (await gateway(fx).status(fx.app, job)).job!.iterations[0]!.snapshot_sha256!;
      assert.equal(await publishReviewReady(state, new FactoryJobs(fx.mediator), { appId: fx.app, jobId: job, iterationId: 'iteration-001', snapshotSha256: snap }, 'reconciliation', new Date()), 'not_published');
    } finally {
      await coordinator.stop();
    }
  } finally {
    await supervisor.stop();
  }
});

test('a finding that references a file outside the snapshot is invalid output and spends the budget', async () => {
  const job = 'job-bad-ref';
  const { supervisor } = await readyJob(fx, job, { limits: { max_attempts: 2 } });
  const coordinator = await startCoordinator(fx, () => ({ outcome: 'findings', summary: 'x', findings: [{ file: '/etc/passwd', line: 1, severity: 'blocker', text: 'Read this file.' }] }));
  try {
    const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'attempts_exhausted', 'exhausted');
    assert.equal(entry.code, 'finding_file_not_reviewed');
    assert.equal(entry.attempts, 2);
    assert.deepEqual((await readdir(jobDir(fx, job))).filter((name) => name.startsWith('review-')), []);
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('a revoked delegation: its event is refused and nothing is reviewed', async () => {
  const revokedJob = 'job-revoked';
  const { supervisor, delegation } = await readyJob(fx, revokedJob);
  try {
    await (await reviewerState(fx)).revoke(delegation!.delegation_id);
    const coordinator = await startCoordinator(fx, secondLineRule);
    try {
      // The event written before the revocation is refused; a revoked delegation creates no new event.
      const entry = await entryFor(fx, revokedJob, 'iteration-001', (value) => value.state !== 'pending', 'refused');
      assert.deepEqual([entry.state, entry.code, entry.attempts], ['delegation_invalid', 'delegation_revoked', 0]);
      const state = await reviewerState(fx);
      const snap = await gateway(fx).snapshot(fx.app, revokedJob, 'iteration-001');
      assert.equal(await publishReviewReady(state, new FactoryJobs(fx.mediator), { appId: fx.app, jobId: revokedJob, iterationId: 'iteration-001', snapshotSha256: snap.snapshot_sha256 }, 'reconciliation', new Date()), 'not_delegated');
      assert.equal(coordinator.provider.calls.length, 0);
      assert.equal(await reviewMessages(), 0);
    } finally {
      await coordinator.stop();
    }
  } finally {
    await supervisor.stop();
  }
});

test('an expired delegation: the event is recorded as delegation_invalid and nothing is reviewed', async () => {
  const job = 'job-expired';
  const { supervisor } = await readyJob(fx, job, { createdAt: new Date(Date.now() - 3 * 60 * 60_000) });
  const coordinator = await startCoordinator(fx, secondLineRule);
  try {
    // The supervisor's event exists (the delegation was not revoked); the coordinator refuses it.
    const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state !== 'pending', 'refused');
    assert.deepEqual([entry.state, entry.code], ['delegation_invalid', 'delegation_expired']);
    assert.equal(coordinator.provider.calls.length, 0);
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('revoked between submission and delivery: the supervisor revalidates and refuses', async () => {
  const job = 'job-late-revoke';
  let revokeOnce: (() => Promise<void>) | undefined;
  const { supervisor, delegation } = await readyJob(fx, job, {
    supervisor: {
      beforeRequestCommit: async (kind) => {
        if (kind === 'review' && revokeOnce !== undefined) {
          const run = revokeOnce;
          revokeOnce = undefined;
          await run();
        }
      },
    },
  });
  revokeOnce = async () => void (await (await reviewerState(fx)).revoke(delegation!.delegation_id));
  const coordinator = await startCoordinator(fx, secondLineRule);
  try {
    const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'rejected', 'rejected');
    assert.equal(entry.code, 'delegation_revoked');
    const status = await gateway(fx).status(fx.app, job);
    assert.equal(status.status, 'awaiting_review', 'the session keeps waiting for a review');
    assert.deepEqual(status.job?.reviews.map((review) => [review.outcome, review.reason, review.source]), [['rejected', 'delegation_revoked', 'autonomous_reviewer']]);
    assert.equal(await reviewMessages(), 0);
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('a supervisor without SF-010 wiring refuses every autonomous review', async () => {
  const job = 'job-unwired';
  const { supervisor } = await readyJob(fx, job, { wired: false });
  const coordinator = await startCoordinator(fx, secondLineRule);
  try {
    const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'rejected', 'rejected');
    assert.equal(entry.code, 'autonomous_review_disabled');
    assert.equal(await reviewMessages(), 0);
    // The event came from reconciliation: the unwired supervisor writes none.
    assert.equal((await (await reviewerState(fx)).events(fx.app, job)).events[0]?.source, 'reconciliation');
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('session replacement: findings made for the old session are never delivered to the new one', async () => {
  const job = 'job-reset';
  const { supervisor } = await readyJob(fx, job);
  const before = (await gateway(fx).status(fx.app, job)).job!.current_session_id!;
  let reset = false;
  const coordinator = await startCoordinator(fx, secondLineRule, {
    beforeSubmit: async () => {
      if (reset) {
        return;
      }
      reset = true;
      const requestId = randomUUID();
      await gateway(fx).manageContext({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', session_id: before, action: 'reset', request_id: requestId });
      await waitForStatus(fx, job, (status) => status.job?.context_actions.some((action) => action.request_id === requestId && action.outcome === 'performed') === true && status.status === 'awaiting_review', 'reset performed');
    },
  });
  try {
    const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'superseded', 'superseded');
    assert.equal(entry.code, 'input_changed');
    assert.equal(entry.session_id, before);
    const after = (await gateway(fx).status(fx.app, job)).job!;
    assert.notEqual(after.current_session_id, before);
    assert.deepEqual(after.reviews, []);
    assert.equal(await reviewMessages(), 0);
    // The bridge-side binding refuses the stale session and the stale context as well.
    const snap = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
    const review = { app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'x' }] };
    const provenance = { kind: 'autonomous_reviewer' as const, event_id: entry.event_id, delegation_id: randomUUID(), provider: 'offline-fixture', session_id: before, context_epoch: 0 };
    await assert.rejects(gateway(fx).submitAutonomousReview(review, provenance), (error: Error) => /^session_replaced/.test(error.message));
    await assert.rejects(gateway(fx).submitAutonomousReview(review, { ...provenance, session_id: after.current_session_id! }), (error: Error) => /^context_changed/.test(error.message));
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('dry-run reports what would happen and writes nothing', async () => {
  const job = 'job-dry';
  const { supervisor } = await readyJob(fx, job, { supervisor: { reviewReady: async () => undefined } });
  try {
    const state = await reviewerState(fx);
    const before = await readdir(state.dir, { recursive: true });
    const view = await dryRun(fx.stateHome, fx.mediator, fx.app, job, ['offline-fixture'], new Date());
    assert.equal(view.decision, 'would_review');
    assert.equal(view.iteration_id, 'iteration-001');
    assert.ok(view.input !== null && view.input.bytes > 0 && view.input.reviewable_paths === 1);
    assert.equal((await dryRun(fx.stateHome, fx.mediator, fx.app, job, [], new Date())).decision, 'provider_unavailable');
    assert.deepEqual(await readdir(state.dir, { recursive: true }), before, 'no event or state was created');
  } finally {
    await supervisor.stop();
  }
});

test('a compact after the provider answered: the findings are stale and never delivered', async () => {
  const job = 'job-compact';
  const { supervisor } = await readyJob(fx, job);
  const session = (await gateway(fx).status(fx.app, job)).job!.current_session_id!;
  let compacted = false;
  const coordinator = await startCoordinator(fx, secondLineRule, {
    beforeSubmit: async () => {
      if (compacted) {
        return;
      }
      compacted = true;
      const requestId = randomUUID();
      await gateway(fx).manageContext({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', session_id: session, action: 'compact', request_id: requestId });
      await waitForStatus(fx, job, (status) => status.job?.context_actions.some((action) => action.request_id === requestId && action.outcome === 'performed') === true && status.status === 'awaiting_review', 'compact performed');
    },
  });
  try {
    const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'superseded', 'superseded');
    assert.deepEqual([entry.code, entry.context_epoch], ['input_changed', 0]);
    const after = (await gateway(fx).status(fx.app, job)).job!;
    assert.equal(after.current_session_id, session, 'same session, new context epoch');
    assert.deepEqual(after.reviews, []);
    assert.equal(await reviewMessages(), 0);
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('the elapsed-time limit and the input-size limit stop a review before the provider runs', async () => {
  const job = 'job-elapsed';
  // Created 90 minutes ago with a 60-minute budget; the delegation itself expires only in 30 minutes.
  const { supervisor } = await readyJob(fx, job, { createdAt: new Date(Date.now() - 90 * 60_000), limits: { max_elapsed_ms: 60 * 60_000 } });
  try {
    const coordinator = await startCoordinator(fx, secondLineRule);
    try {
      const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state !== 'pending', 'refused');
      assert.deepEqual([entry.state, entry.code, entry.attempts], ['elapsed_limit', 'elapsed_limit', 0]);
      assert.equal(coordinator.provider.calls.length, 0);
    } finally {
      await coordinator.stop();
    }
  } finally {
    await supervisor.stop();
  }
});

test('oversized input blocks the review and never yields a clean verdict', async () => {
  const job = 'job-oversized';
  const { supervisor } = await readyJob(fx, job, { limits: { max_input_bytes: 1024 } });
  const coordinator = await startCoordinator(fx, () => ({ outcome: 'clean', summary: 'fine' }));
  try {
    const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'input_blocked', 'blocked');
    assert.equal(entry.code, 'input_too_large');
    assert.equal(coordinator.provider.calls.length, 0);
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('R2: revoked after the review was recorded as sending: rolled back and rejected, never sent', async () => {
  const job = 'job-revoke-after-record';
  let revokeOnce: (() => Promise<void>) | undefined;
  const { supervisor, delegation } = await readyJob(fx, job, {
    supervisor: {
      afterRequestRecorded: async (kind) => {
        if (kind === 'review' && revokeOnce !== undefined) {
          const run = revokeOnce;
          revokeOnce = undefined;
          await run();
        }
      },
    },
  });
  revokeOnce = async () => void (await (await reviewerState(fx)).revoke(delegation!.delegation_id));
  const coordinator = await startCoordinator(fx, secondLineRule);
  try {
    const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'rejected', 'rejected');
    assert.equal(entry.code, 'delegation_revoked');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const status = await gateway(fx).status(fx.app, job);
    assert.equal(status.status, 'awaiting_review');
    assert.deepEqual(status.job?.iterations.map((value) => [value.id, value.state]), [['iteration-001', 'ready_for_review']], 'no extra iteration');
    assert.deepEqual(status.job?.reviews.map((review) => [review.outcome, review.reason]), [['rejected', 'delegation_revoked']], 'one review entry, rejected');
    assert.equal(await reviewMessages(), 0, 'nothing reached Claude');
    assert.equal(coordinator.provider.calls.length, 1);
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

// n findings of 3,300 ASCII characters on README.md:1 (the first one also edits the README).
const large = (count: number, marker: string) => ({
  outcome: 'findings',
  summary: 'Large.',
  findings: Array.from({ length: count }, (_, index) => ({ file: 'README.md', line: 1, severity: 'major', text: `${index === 0 ? `FAKE-EDIT README.md ${marker} ` : ''}${'x'.repeat(3300)}` })),
});

test('R3: the reported 66 kB response is a coded outcome; the state stays readable and nothing is stuck', async () => {
  const job = 'job-large-66k';
  const { supervisor } = await readyJob(fx, job);
  const coordinator = await startCoordinator(fx, () => large(20, 'second'));
  try {
    const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'provider_failed', 'coded outcome');
    assert.equal(entry.code, 'provider_output_too_large');
    // The next advance and a restart read the state normally.
    await coordinator.coordinator.processJob(fx.app, job);
    const state = (await (await reviewerState(fx)).jobState(fx.app, job))!;
    assert.deepEqual([state.usage.attempts, state.usage.reviews], [1, 0]);
    assert.deepEqual((await readdir(jobDir(fx, job))).filter((name) => name.startsWith('review-')), []);
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('R3: large responses accumulated over iterations stay readable state and are delivered', async () => {
  const job = 'job-large';
  const { supervisor } = await readyJob(fx, job);
  // 12 findings of 3,300 characters (about 40 kB) per review, twice, then clean.
  const coordinator = await startCoordinator(fx, (input) => (input.iteration_number === 1 ? large(12, 'second') : input.iteration_number === 2 ? large(12, 'third') : { outcome: 'clean', summary: 'Done.' }));
  try {
    await entryFor(fx, job, 'iteration-003', (value) => value.state === 'clean_awaiting_acceptance', 'clean after two large reviews', 30_000);
    const state = (await (await reviewerState(fx)).jobState(fx.app, job))!;
    assert.deepEqual(state.reviews.map((value) => [value.iteration_id, value.state]), [['iteration-001', 'delivered'], ['iteration-002', 'delivered'], ['iteration-003', 'clean_awaiting_acceptance']]);
    // Bodies are kept only while submitting; the hash stays.
    assert.ok(state.reviews.slice(0, 2).every((value) => value.submission === null && value.submission_sha256 !== null));
    assert.equal(await reviewMessages(), 2);
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('R3: a valid response too large to record safely is a coded outcome, nothing is submitted', async () => {
  const job = 'job-too-large';
  const { supervisor } = await readyJob(fx, job);
  // 30 findings of 1,700 four-byte characters (3,400 UTF-16 units each): about 204 kB.
  const coordinator = await startCoordinator(fx, () => ({ outcome: 'findings', summary: 'Huge.', findings: Array.from({ length: 30 }, () => ({ file: 'README.md', line: 1, severity: 'minor', text: '\u{1F600}'.repeat(1700) })) }));
  try {
    const entry = await entryFor(fx, job, 'iteration-001', (value) => value.state === 'provider_failed', 'too large');
    assert.equal(entry.code, 'provider_output_too_large');
    assert.equal(entry.submission, null);
    assert.deepEqual((await readdir(jobDir(fx, job))).filter((name) => name.startsWith('review-')), []);
    assert.equal(((await (await reviewerState(fx)).jobState(fx.app, job))!).usage.reviews, 0);
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('R6: dry-run reports exhausted budgets and unreadable reviewer state, and writes nothing', async () => {
  const job = 'job-dry-budget';
  const { supervisor, delegation } = await readyJob(fx, job, { supervisor: { reviewReady: async () => undefined }, limits: { max_attempts: 2, max_reviews: 1 } });
  try {
    const state = await reviewerState(fx);
    const dry = async () => dryRun(fx.stateHome, fx.mediator, fx.app, job, ['offline-fixture'], new Date());
    assert.equal((await dry()).decision, 'would_review');
    const usage = async (attempts: number, reviews: number) =>
      state.updateJobState(fx.app, job, () => ({ schema: JOB_STATE_SCHEMA, app_id: fx.app, job_id: job, delegation_id: delegation!.delegation_id, usage: { attempts, reviews }, reviews: [], revision: 1, updated_at: new Date().toISOString() }));
    await usage(0, 1);
    assert.deepEqual([(await dry()).decision, (await dry()).code], ['review_limit', 'review_limit']);
    await usage(2, 0);
    assert.deepEqual([(await dry()).decision, (await dry()).code], ['attempts_exhausted', 'attempt_limit']);
    // Corrupt state: the coordinator could not read its budgets, so neither does dry-run claim a review.
    const file = join(state.dir, 'jobs', fx.app, `${job}.json`);
    await writeFile(file, '{"schema":', { mode: 0o600 });
    const before = await readdir(state.dir, { recursive: true });
    assert.deepEqual([(await dry()).decision, (await dry()).code], ['reviewer_state_unreadable', 'invalid_record']);
    assert.deepEqual(await readdir(state.dir, { recursive: true }), before, 'nothing created');
    assert.deepEqual((await state.events(fx.app, job)).events, [], 'no event');
  } finally {
    await supervisor.stop();
  }
});
