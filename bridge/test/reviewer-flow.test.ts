// SF-010 end to end with the fake stream-json Claude and the deterministic offline provider:
// a verified review-ready snapshot → a durable event → the coordinator → findings delivered to the
// same live managed session (no user relay) → the next verified iteration → a clean verdict bound
// to that snapshot, awaiting the operator's acceptance. Nothing is accepted or closed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { acceptedJob, destroyFixture, invocations, jobDir, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, messages, waitFor, waitForStatus } from './support/executor-fixture.js';
import { delegate, entryFor, reviewerState, secondLineRule, startCoordinator, startReviewingSupervisor } from './support/reviewer-fixture.js';
import { eventId, reviewIdOf } from '../src/reviewer/records.js';

let fx: Fixture;

// A fresh fixture per test: an unaccepted job leaves the disposable repository changed.
beforeEach(async () => {
  fx = await createExecutorFixture();
  await enableApp(fx);
});

afterEach(async () => {
  await destroyFixture(fx);
});

test('findings reach the same live session without relay; the next iteration gets a clean verdict awaiting acceptance', async () => {
  const job = 'job-auto-review';
  const accepted = await acceptedJob(fx, job);
  const authorizationId = randomUUID();
  const delegation = await delegate(fx, job, authorizationId);
  const supervisor = await startReviewingSupervisor(fx);
  const coordinator = await startCoordinator(fx, secondLineRule, { backstopMs: 3_600_000 });
  try {
    await authorize(fx, job, accepted, authorizationId);
    // The coordinator reviews iteration-001 on the supervisor's event; the supervisor delivers it.
    const ready2 = await waitForStatus(fx, job, (status) => status.status === 'awaiting_review' && status.job?.current_iteration === 'iteration-002', 'iteration-002 ready', 30_000);
    assert.deepEqual(ready2.job?.iterations.map((entry) => entry.state), ['changes_requested', 'ready_for_review']);
    const review = ready2.job!.reviews[0]!;
    assert.equal(review.outcome, 'delivered');
    assert.equal(review.source, 'autonomous_reviewer');
    const snap1 = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
    const event1 = eventId(fx.app, job, 'iteration-001', snap1.snapshot_sha256);
    assert.equal(review.review_id, reviewIdOf(event1), 'the review id is derived from the event id');

    // The request file carries the provenance; the message went to the same process.
    const request = JSON.parse(await readFile(join(jobDir(fx, job), `review-${review.review_id}.json`), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(request.provenance, { kind: 'autonomous_reviewer', event_id: event1, delegation_id: delegation.delegation_id, provider: 'offline-fixture', session_id: ready2.job!.current_session_id, context_epoch: 0 });
    const sent = await messages(fx);
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.pid, sent[0]!.pid, 'the same live process');
    assert.match(sent[1]!.text, /^Software Factory review .* of iteration-001/);
    assert.match(sent[1]!.text, /Reviewer: the autonomous Software Factory reviewer \(provider offline-fixture\), not ChatGPT/);
    assert.match(sent[1]!.text, /1\. \[major\] README\.md:1: Add the second line\./);
    assert.equal((await invocations(fx)).length, 1, 'no second Claude process');

    // iteration-002 is reviewed clean: bound to its snapshot, awaiting the operator; the job stays open.
    const snap2 = await gateway(fx).snapshot(fx.app, job, 'iteration-002');
    const state = await reviewerState(fx);
    const clean = await waitFor(async () => {
      const value = await state.jobState(fx.app, job);
      return value?.reviews.find((entry) => entry.iteration_id === 'iteration-002' && entry.state === 'clean_awaiting_acceptance') ? value : undefined;
    }, 'clean verdict');
    const entry2 = clean.reviews.find((entry) => entry.iteration_id === 'iteration-002')!;
    assert.equal(entry2.snapshot_sha256, snap2.snapshot_sha256);
    assert.equal(entry2.event_id, eventId(fx.app, job, 'iteration-002', snap2.snapshot_sha256));
    assert.deepEqual(clean.reviews.map((entry) => [entry.iteration_id, entry.state]), [['iteration-001', 'delivered'], ['iteration-002', 'clean_awaiting_acceptance']]);
    assert.deepEqual(clean.usage, { attempts: 2, reviews: 2 });
    const events = await state.events(fx.app, job);
    assert.deepEqual(events.events.map((event) => [event.iteration_id, event.source]), [['iteration-001', 'supervisor'], ['iteration-002', 'supervisor']]);
    assert.deepEqual(coordinator.provider.calls.map((call) => call.iteration_id), ['iteration-001', 'iteration-002'], 'one provider call per event');

    await new Promise((resolve) => setTimeout(resolve, 300));
    const still = await gateway(fx).status(fx.app, job);
    assert.equal(still.status, 'awaiting_review', 'a clean verdict never closes or accepts the job');
    assert.deepEqual(still.job?.acceptances, []);
    assert.ok(!(await readdir(jobDir(fx, job))).some((name) => name.startsWith('acceptance-')), 'no acceptance request was written');
    // Events and the reviewer state hold no host path.
    for (const text of [JSON.stringify(events), JSON.stringify(clean)]) {
      assert.ok(!text.includes(fx.sandbox), 'no host path');
    }
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});

test('a clean verdict is superseded once its snapshot is no longer the current one', async () => {
  const job = 'job-clean-stale';
  const accepted = await acceptedJob(fx, job);
  const authorizationId = randomUUID();
  await delegate(fx, job, authorizationId);
  const supervisor = await startReviewingSupervisor(fx);
  const coordinator = await startCoordinator(fx, () => ({ outcome: 'clean', summary: 'fine' }));
  try {
    await authorize(fx, job, accepted, authorizationId);
    await entryFor(fx, job, 'iteration-001', (entry) => entry.state === 'clean_awaiting_acceptance', 'clean');
    // The operator reviews anyway (ChatGPT): iteration-001's snapshot is no longer current.
    const snap = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
    await gateway(fx).submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'More. FAKE-EDIT notes.txt more' }] });
    const stale = await entryFor(fx, job, 'iteration-001', (entry) => entry.state === 'superseded', 'clean superseded');
    assert.equal(stale.code, 'clean_superseded');
  } finally {
    await coordinator.stop();
    await supervisor.stop();
  }
});
