// SF-009 Review 01, R1-2: the final acceptance is bound to the exact reviewed tree. After the
// managed process has ended, the collected tree and diff are compared with the accepted snapshot;
// a change between the acceptance and the collection (a write while the process ends, a delayed
// background writer, a changed index) gives needs_inspection, never completed. The accepted
// snapshot is never rewritten, and the collected artifacts describe what was collected.
// Review 02, R2-2: the comparison runs once more after the result files were written, right before
// the outcome is persisted (test seam afterArtifactsWritten); drift there is acceptance_drift too.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { acceptedJob, destroyFixture, git, invocations, jobDir, sha256, type Fixture } from './support/operator-fixture.js';
import { SESSION_TAG } from '../src/executor/quiescence.js';
import { authorize, createExecutorFixture, enableApp, gateway, managedService, setStreamMode, startSupervisor, waitFor, waitForStatus } from './support/executor-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

interface Outcome {
  status: string;
  code: string | null;
  execution: { state: string; error: { code: string } | null; completion: string | null; session: { signal: string | null }; artifacts: Record<string, string> };
  snapshotBefore: string;
  snapshotAfter: string;
  acceptedDiffSha: string;
  collectedDiff: string;
}

// One job to its first snapshot, accepted at once; then whatever the scenario does while it ends.
async function acceptFirst(
  mode: string,
  onClose?: string,
  beforeCollect?: (fx: Fixture, sessionId: string) => Promise<void>,
  afterArtifacts?: (fx: Fixture, sessionId: string) => Promise<void>,
): Promise<Outcome & { fx: Fixture; report: string }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  await setStreamMode(fx, mode, onClose ? { onClose } : {});
  const job = 'job-accept';
  const accepted = await acceptedJob(fx, job);
  let sessionId = '';
  const seams = {
    ...(beforeCollect ? { beforeManagedCollect: () => beforeCollect(fx, sessionId) } : {}),
    ...(afterArtifacts ? { afterArtifactsWritten: () => afterArtifacts(fx, sessionId) } : {}),
  };
  const running = await startSupervisor(fx, { service: managedService(fx, seams) });
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  const gw = gateway(fx);
  await waitForStatus(fx, job, (value) => value.status === 'awaiting_review', 'iteration-001 ready');
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  sessionId = snap.snapshot.session_id;
  const snapshotFile = join(jobDir(fx, job), 'iteration-001.snapshot.json');
  const snapshotBefore = sha256(await readFile(snapshotFile));
  assert.equal(snapshotBefore, snap.snapshot_sha256);
  await gw.accept({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, acceptance_id: randomUUID() });
  const ended = await waitFor(async () => {
    const status = await gw.status(fx.app, job);
    return ['closed', 'needs_inspection', 'failed'].includes(status.status) ? status : undefined;
  }, 'job ended', 30_000);
  const execution = JSON.parse(await readFile(join(jobDir(fx, job), 'execution.json'), 'utf8')) as Outcome['execution'];
  return {
    fx,
    status: ended.status,
    code: ended.job?.diagnostic?.code ?? null,
    execution,
    snapshotBefore,
    snapshotAfter: sha256(await readFile(snapshotFile)),
    acceptedDiffSha: snap.snapshot.artifacts.diff.sha256,
    collectedDiff: await readFile(join(jobDir(fx, job), 'implementation.diff'), 'utf8'),
    report: await readFile(join(jobDir(fx, job), 'report.md'), 'utf8'),
  };
}

test('no drift: the accepted snapshot is what is collected, and the job closes completed', async () => {
  const outcome = await acceptFirst('ok');
  assert.equal(outcome.status, 'closed');
  assert.equal(outcome.execution.state, 'completed');
  assert.equal(outcome.execution.completion, 'operator_confirmed');
  assert.equal(sha256(outcome.collectedDiff), outcome.acceptedDiffSha, 'the collected diff is the accepted diff');
  assert.equal(outcome.execution.artifacts['implementation.diff'], outcome.acceptedDiffSha);
  assert.equal(outcome.snapshotAfter, outcome.snapshotBefore);
});

test('a write while the process ends (after the acceptance) gives needs_inspection, not completed', async () => {
  const outcome = await acceptFirst('ok', 'write');
  assert.equal(outcome.status, 'needs_inspection');
  assert.equal(outcome.code, 'acceptance_drift');
  assert.equal(outcome.execution.state, 'needs_inspection');
  assert.equal(outcome.execution.error?.code, 'acceptance_drift');
  // Honest artifacts: the collected diff holds the late write and is not the accepted one.
  assert.match(outcome.collectedDiff, /\+after acceptance/);
  assert.notEqual(sha256(outcome.collectedDiff), outcome.acceptedDiffSha);
  assert.equal(outcome.execution.artifacts['implementation.diff'], sha256(outcome.collectedDiff));
  assert.equal(outcome.snapshotAfter, outcome.snapshotBefore, 'the accepted snapshot is unchanged');
});

// Review 02: a delayed background writer of the session can no longer reach an acceptance (it keeps
// the review boundary from being stable: executor-quiescence.test.ts). The acceptance-time wait is
// still there for one that appears afterwards: here a tagged process started as the session ends.
test('a process of the session that writes after the Claude process ended is waited for, and its write gives needs_inspection', async () => {
  const outcome = await acceptFirst('ok', undefined, async (fixture, sessionId) => {
    const child = spawn(process.execPath, ['-e', "setTimeout(() => require('fs').appendFileSync('README.md', 'late write\\n'), 800)"], { cwd: fixture.appRepo, stdio: 'ignore', env: { ...process.env, [SESSION_TAG]: sessionId } });
    await new Promise((resolve) => child.once('spawn', resolve));
  });
  assert.equal(outcome.status, 'needs_inspection');
  assert.equal(outcome.code, 'acceptance_drift');
  assert.match(outcome.collectedDiff, /\+late write/, 'it was waited for: its write is in the collection');
  assert.equal(outcome.snapshotAfter, outcome.snapshotBefore);
});

test('a write racing the collection itself is never reported as completed', async () => {
  const outcome = await acceptFirst('ok', undefined, async (fx) => {
    // Lands while the collection runs: the check before or after the export sees it.
    setTimeout(() => void appendFile(join(fx.appRepo, 'README.md'), 'during collect\n'), 0);
  });
  assert.equal(outcome.status, 'needs_inspection');
  assert.equal(outcome.code, 'acceptance_drift');
  assert.equal(outcome.snapshotAfter, outcome.snapshotBefore);
});

test('a child that writes and then dies by signal is not completed', async () => {
  const outcome = await acceptFirst('ok', 'write-crash');
  assert.equal(outcome.status, 'needs_inspection');
  assert.equal(outcome.code, 'acceptance_drift');
  assert.equal(outcome.execution.session.signal, 'SIGKILL');
  assert.equal(outcome.snapshotAfter, outcome.snapshotBefore);
});

test('a child that dies by signal without changing anything still collects exactly the accepted tree', async () => {
  const outcome = await acceptFirst('ok', 'crash');
  assert.equal(outcome.execution.session.signal, 'SIGKILL');
  assert.equal(outcome.status, 'closed');
  assert.equal(outcome.execution.state, 'completed');
  assert.equal(sha256(outcome.collectedDiff), outcome.acceptedDiffSha);
});

test('a commit (HEAD changed) after the acceptance gives needs_inspection, and nothing is repaired', async () => {
  const outcome = await acceptFirst('ok', 'commit');
  assert.equal(outcome.status, 'needs_inspection');
  assert.equal(outcome.code, 'acceptance_drift');
  assert.equal(outcome.snapshotAfter, outcome.snapshotBefore);
});

test('a Git index changed after the acceptance gives needs_inspection, and nothing is repaired', async () => {
  const outcome = await acceptFirst('ok', 'stage');
  assert.equal(outcome.status, 'needs_inspection');
  assert.equal(outcome.code, 'acceptance_drift');
  assert.match(git(outcome.fx.appRepo, 'diff', '--cached', '--name-only'), /README\.md/, 'the staged change is left for the operator');
  assert.equal(outcome.snapshotAfter, outcome.snapshotBefore);
  assert.equal((await invocations(outcome.fx)).length, 1);
});

// ---- Review 02, R2-2: after the result files were written, before the outcome is persisted ----

async function assertLateDrift(outcome: Outcome & { report: string }, why: RegExp): Promise<void> {
  assert.equal(outcome.status, 'needs_inspection');
  assert.equal(outcome.code, 'acceptance_drift');
  assert.equal(outcome.execution.state, 'needs_inspection');
  assert.equal(outcome.execution.error?.code, 'acceptance_drift');
  assert.match((outcome.execution.error as { message?: string } | null)?.message ?? '', why);
  // The files describe this outcome, never "completed"; the exported diff is what was collected.
  assert.match(outcome.report, /\| State \| needs_inspection \|/);
  assert.match(outcome.report, /acceptance_drift/);
  assert.equal(outcome.execution.artifacts['report.md'], sha256(outcome.report));
  assert.equal(outcome.execution.artifacts['implementation.diff'], sha256(outcome.collectedDiff));
  assert.equal(outcome.snapshotAfter, outcome.snapshotBefore, 'the accepted snapshot is unchanged');
}

test('unchanged at the final check: completed, with the seam reached once', async () => {
  let reached = 0;
  const outcome = await acceptFirst('ok', undefined, undefined, async () => void (reached += 1));
  assert.equal(reached, 1);
  assert.equal(outcome.status, 'closed', JSON.stringify(outcome.execution.error));
  assert.equal(outcome.execution.state, 'completed');
  assert.equal(sha256(outcome.collectedDiff), outcome.acceptedDiffSha);
});

test('a write after the result files were written gives acceptance_drift, not completed', async () => {
  const outcome = await acceptFirst('ok', undefined, undefined, async (fx) => appendFile(join(fx.appRepo, 'README.md'), 'after the artifacts\n'));
  await assertLateDrift(outcome, /changed after the result files were written/);
  assert.equal(sha256(outcome.collectedDiff), outcome.acceptedDiffSha, 'the export is the tree as collected, before the write');
  assert.match(await readFile(join(outcome.fx.appRepo, 'README.md'), 'utf8'), /after the artifacts/, 'nothing was repaired');
});

test('a process of the session still running at the final check gives acceptance_drift', async () => {
  let child: ChildProcess | undefined;
  const outcome = await acceptFirst('ok', undefined, undefined, async (_fx, sessionId) => {
    // A descendant of the session that is still running then (found by its session tag).
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore', env: { ...process.env, [SESSION_TAG]: sessionId } });
    await new Promise((resolve) => child!.once('spawn', resolve));
  });
  child?.kill('SIGKILL');
  await assertLateDrift(outcome, /process started by the session was running after the result files were written/);
});

test('a HEAD change after the result files were written gives acceptance_drift', async () => {
  const outcome = await acceptFirst('ok', undefined, undefined, async (fx) => void git(fx.appRepo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'late commit'));
  await assertLateDrift(outcome, /changed after the result files were written/);
});

test('an index change after the result files were written gives acceptance_drift', async () => {
  const outcome = await acceptFirst('ok', undefined, undefined, async (fx) => void git(fx.appRepo, 'add', 'README.md'));
  await assertLateDrift(outcome, /changed after the result files were written/);
});

test('a Git control file change after the result files were written gives acceptance_drift', async () => {
  const outcome = await acceptFirst('ok', undefined, undefined, async (fx) => appendFile(join(fx.appRepo, '.git', 'config'), '[sf009]\n\tlate = 1\n'));
  await assertLateDrift(outcome, /changed after the result files were written/);
});

test('a withheld export: a write after the result files were written gives acceptance_drift; unchanged it is still never completed', async () => {
  const drifted = await acceptFirst('implement-secret', undefined, undefined, async (fx) => appendFile(join(fx.appRepo, 'README.md'), 'after the artifacts\n'));
  await assertLateDrift(drifted, /changed after the result files were written/);
  assert.match(drifted.collectedDiff, /^# Not exported/);
  const unchanged = await acceptFirst('implement-secret', undefined, undefined, async () => undefined);
  assert.equal(unchanged.status, 'needs_inspection');
  assert.equal(unchanged.execution.error?.code, 'export_withheld');
});
