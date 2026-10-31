// SF-009 Review 02, R2-4: a review or an acceptance binds only a snapshot whose diff and report are
// still exactly the bytes it records: its own files, regular, not symlinks, within the size limit.
// A mutated, substituted, vanished or mismatched artifact rejects the request, which never reaches
// Claude and never accepts anything. factory_review_snapshot applies the same checks (read-only).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { acceptedJob, destroyFixture, invocations, jobDir, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, messages, startSupervisor, waitFor, waitForStatus } from './support/executor-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function ready(): Promise<{ fx: Fixture; job: string; dir: string; snapshotSha: string }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  const job = 'job-integrity';
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx);
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  const gw = gateway(fx);
  await waitForStatus(fx, job, (value) => value.status === 'awaiting_review', 'iteration-001 ready');
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  return { fx, job, dir: jobDir(fx, job), snapshotSha: snap.snapshot_sha256 };
}

const ended = (fx: Fixture, job: string) =>
  waitFor(async () => {
    const value = await gateway(fx).status(fx.app, job);
    return ['needs_inspection', 'closed', 'failed'].includes(value.status) ? value : undefined;
  }, `${job} ended`, 20_000);

// A review submitted after the artifact was tampered with is rejected and never delivered.
async function reviewRejected(fx: Fixture, job: string, snapshotSha: string): Promise<void> {
  const reviewId = randomUUID();
  await gateway(fx).submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snapshotSha, review_id: reviewId, findings: [{ text: 'FAKE-EDIT notes.txt never' }] });
  const value = await ended(fx, job);
  assert.equal(value.status, 'needs_inspection');
  assert.deepEqual(value.job?.reviews.map((entry) => [entry.review_id, entry.outcome, entry.reason]), [[reviewId, 'rejected', 'snapshot_artifact_invalid']]);
  assert.equal(value.job?.iterations[0]?.state, 'conflict');
  assert.equal((await messages(fx)).length, 1, 'the review never reached Claude');
}

// An acceptance submitted after the artifact was tampered with is rejected: nothing is accepted or completed.
async function acceptanceRejected(fx: Fixture, job: string, snapshotSha: string): Promise<void> {
  const acceptanceId = randomUUID();
  await gateway(fx).accept({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snapshotSha, acceptance_id: acceptanceId });
  const value = await ended(fx, job);
  assert.equal(value.status, 'needs_inspection');
  assert.deepEqual(value.job?.acceptances.map((entry) => [entry.acceptance_id, entry.outcome, entry.reason]), [[acceptanceId, 'rejected', 'snapshot_artifact_invalid']]);
  const execution = JSON.parse(await readFile(join(jobDir(fx, job), 'execution.json'), 'utf8')) as { state: string };
  assert.notEqual(execution.state, 'completed');
  assert.equal((await invocations(fx)).length, 1);
}

test('positive: intact artifacts bind a review, which is delivered', async () => {
  const { fx, job, snapshotSha } = await ready();
  const reviewId = randomUUID();
  await gateway(fx).submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snapshotSha, review_id: reviewId, findings: [{ text: 'FAKE-EDIT notes.txt ok' }] });
  const next = await waitFor(async () => {
    const value = await gateway(fx).status(fx.app, job);
    return value.job?.current_iteration === 'iteration-002' && value.status === 'awaiting_review' ? value : undefined;
  }, 'iteration-002');
  assert.deepEqual(next.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'delivered']]);
});

test('a mutated diff rejects the review; factory_review_snapshot refuses it too', async () => {
  const { fx, job, dir, snapshotSha } = await ready();
  await appendFile(join(dir, 'iteration-001.diff'), '+not what was reviewed\n');
  await assert.rejects(gateway(fx).snapshot(fx.app, job, 'iteration-001'), { code: 'invalid_record' });
  await reviewRejected(fx, job, snapshotSha);
});

test('a mutated report rejects the acceptance', async () => {
  const { fx, job, dir, snapshotSha } = await ready();
  await appendFile(join(dir, 'iteration-001.report.md'), 'edited\n');
  await acceptanceRejected(fx, job, snapshotSha);
});

test('a symlink substituted for the diff (with identical bytes) rejects the acceptance', async () => {
  const { fx, job, dir, snapshotSha } = await ready();
  await rename(join(dir, 'iteration-001.diff'), join(fx.sandbox, 'moved.diff'));
  await symlink(join(fx.sandbox, 'moved.diff'), join(dir, 'iteration-001.diff'));
  await acceptanceRejected(fx, job, snapshotSha);
});

test('a vanished report rejects the review', async () => {
  const { fx, job, dir, snapshotSha } = await ready();
  await rm(join(dir, 'iteration-001.report.md'));
  await reviewRejected(fx, job, snapshotSha);
});

test('a valid snapshot JSON (its sha256 recorded in managed.json) that names other artifacts rejects the acceptance', async () => {
  const { fx, job, dir } = await ready();
  // Someone with write access rewrites the snapshot and managed.json consistently, pointing the
  // snapshot at another file whose recorded hash matches it.
  const snapshot = JSON.parse(await readFile(join(dir, 'iteration-001.snapshot.json'), 'utf8')) as { artifacts: { diff: { file: string; sha256: string } } };
  const substitute = Buffer.from('diff --git a/README.md b/README.md\n+substituted\n');
  await writeFile(join(dir, 'other.diff'), substitute, { mode: 0o600 });
  snapshot.artifacts.diff = { file: 'other.diff', sha256: sha256(substitute) };
  const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(join(dir, 'iteration-001.snapshot.json'), bytes, { mode: 0o600 });
  const managedPath = join(dir, 'managed.json');
  const managed = JSON.parse(await readFile(managedPath, 'utf8')) as { iterations: Array<{ snapshot: { sha256: string } | null }> };
  managed.iterations[0]!.snapshot!.sha256 = sha256(bytes);
  await writeFile(`${managedPath}.tmp`, `${JSON.stringify(managed, null, 2)}\n`, { mode: 0o600 });
  await rename(`${managedPath}.tmp`, managedPath);
  await assert.rejects(gateway(fx).snapshot(fx.app, job, 'iteration-001'), { code: 'invalid_record' });
  await acceptanceRejected(fx, job, sha256(bytes));
});
