// SF-009: auto mode does not become bypass mode. Refused actions are surfaced, Git operations and
// changes to protected checkouts end the session for inspection, exports omit secrets, background
// writers cannot corrupt a snapshot, and a tree changed under a pending review refuses the review.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { acceptedJob, destroyFixture, git, invocations, jobDir, type Fixture } from './support/operator-fixture.js';
import type { SupervisorOptions } from '../src/executor/supervisor.js';
import { authorize, createExecutorFixture, enableApp, gateway, messages, setStreamMode, startSupervisor, waitFor } from './support/executor-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

async function launched(mode: string, protect = false, options: Partial<SupervisorOptions> = {}): Promise<{ fx: Fixture; job: string; other: string }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  const other = join(fx.sandbox, 'other-checkout');
  await mkdir(other);
  git(other, 'init', '-q');
  await writeFile(join(other, 'README.md'), '# Other\n');
  git(other, 'add', 'README.md');
  git(other, 'commit', '-q', '-m', 'init');
  await enableApp(fx, fx.app, protect ? [other] : []);
  await setStreamMode(fx, mode, { outside: other });
  const job = 'job-scope';
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx, options);
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  return { fx, job, other };
}

const status = (fx: Fixture, job: string, wanted: string, diagnostic?: RegExp) =>
  waitFor(async () => {
    const value = await gateway(fx).status(fx.app, job);
    return value.status === wanted && (diagnostic === undefined || diagnostic.test(`${value.job?.diagnostic?.code} ${value.job?.diagnostic?.message}`)) ? value : undefined;
  }, `${job} ${wanted}`);

const allText = async (dir: string) => {
  let text = '';
  for (const name of await readdir(dir)) text += await readFile(join(dir, name), 'utf8').catch(() => '');
  return text;
};

test('an action auto mode refused is surfaced as needs_operator with a non-secret diagnostic; the review loop continues', async () => {
  const { fx, job, other } = await launched('implement-git-commit', true);
  const blocked = await status(fx, job, 'needs_operator', /auto_mode_refused/);
  assert.deepEqual(blocked.job?.iterations[0]?.blocked_actions, [{ action: 'Bash(git commit)', count: 1 }]);
  assert.ok(!blocked.job!.diagnostic!.message.includes('secret-free'), 'the refused input is not echoed');
  // The snapshot is still published and reviewable; nothing was approved on Claude's behalf.
  const gw = gateway(fx);
  assert.deepEqual((await gw.listReviewReady(fx.app)).ready.map((entry) => entry.iteration_id), ['iteration-001']);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  assert.deepEqual(snap.snapshot.blocked_actions, [{ action: 'Bash(git commit)', count: 1 }]);
  await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'Leave Git to the operator. FAKE-EDIT notes.txt ok' }] });
  const next = await waitFor(async () => {
    const value = await gw.status(fx.app, job);
    return value.status === 'awaiting_review' && value.job?.current_iteration === 'iteration-002' ? value : undefined;
  }, 'iteration-002');
  assert.equal(next.job?.diagnostic, null);
  assert.equal(git(fx.appRepo, 'log', '--oneline').trim().split('\n').length, 1, 'no commit');
  assert.equal(git(other, 'status', '--porcelain'), '', 'the protected checkout is untouched');
});

test('a real Git commit during a turn ends the session for inspection; nothing is published or repaired', async () => {
  const { fx, job } = await launched('implement-commit');
  const ended = await status(fx, job, 'needs_inspection', /git_operation_detected/);
  assert.equal(ended.job?.iterations[0]?.snapshot_sha256, null);
  assert.equal(ended.job?.session_process, 'ended');
  const execution = JSON.parse(await readFile(join(jobDir(fx, job), 'execution.json'), 'utf8')) as { state: string; error: { code: string } };
  assert.equal(execution.state, 'failed');
  assert.equal(execution.error.code, 'git_changed');
  assert.equal(git(fx.appRepo, 'log', '--oneline').trim().split('\n').length, 2, 'the commit was left as it is');
  assert.equal((await invocations(fx)).length, 1);
});

test('a changed protected checkout ends the session for inspection', async () => {
  const { fx, job } = await launched('implement-outside', true);
  await status(fx, job, 'needs_inspection', /protected_checkout_changed/);
  assert.equal((await gateway(fx).listReviewReady(fx.app)).ready.length, 0);
});

test('a credential written by Claude withholds the export; no secret reaches the mediator', async () => {
  const { fx, job } = await launched('implement-secret');
  await status(fx, job, 'awaiting_review');
  const snap = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
  assert.match(snap.snapshot.export.withheld ?? '', /credential-style/);
  assert.deepEqual(snap.snapshot.export.changed_paths, []);
  assert.match(await readFile(join(fx.mediator, snap.diff.path), 'utf8'), /^# Not exported/);
  assert.ok(!(await allText(jobDir(fx, job))).includes('fixture-only'));
});

test('a background writer cannot produce a snapshot: the capture fails visibly and nothing is published', async () => {
  const { fx, job } = await launched('implement-background', false, { quiesceTimeoutMs: 4000 });
  const failed = await status(fx, job, 'needs_operator', /snapshot_failed/);
  assert.equal(failed.job?.iterations[0]?.state, 'snapshot_failed');
  // Review 02: the running writer itself is the reason (it is never stopped).
  assert.match(failed.job!.diagnostic!.message, /No stable review boundary within 4 s: 1 process\(es\) .* still running/);
  assert.equal((await gateway(fx).listReviewReady(fx.app)).ready.length, 0);
  assert.ok(!(await readdir(jobDir(fx, job))).includes('iteration-001.snapshot.json'));
});

test('a tree changed while a review is pending refuses the review and never replays it', async () => {
  const { fx, job } = await launched('ok');
  await status(fx, job, 'awaiting_review');
  const gw = gateway(fx);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  // The operator reverts the experimental change while ChatGPT reviews.
  git(fx.appRepo, 'checkout', '--', 'README.md');
  const reviewId = randomUUID();
  await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: reviewId, findings: [{ text: 'FAKE-EDIT notes.txt never' }] });
  const ended = await status(fx, job, 'needs_inspection', /conflict/);
  assert.deepEqual(ended.job?.reviews.map((entry) => [entry.review_id, entry.outcome, entry.reason]), [[reviewId, 'rejected', 'tree_changed']]);
  assert.equal(ended.job?.iterations[0]?.state, 'conflict');
  assert.equal((await messages(fx)).length, 1, 'the review never reached Claude');
});
