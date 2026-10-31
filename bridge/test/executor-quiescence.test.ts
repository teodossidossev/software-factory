// SF-009 Review 02, R2-1: a published review boundary is really stable. A stream-json result ends
// only the foreground turn; the snapshot is published once no process of the session runs (by
// descent or by its environment tag, each known by pid and start time), Claude is silent and the
// tree fingerprint held for a quiet window, and only if that still holds when its files are
// written. Hitting the bound fails the snapshot visibly; nothing is killed or guessed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { SessionGate } from '../src/execution/session-gate.js';
import { StreamSession } from '../src/executor/stream-session.js';
import { awaitQuiescence, SESSION_TAG, sessionWriters, settledScan, stillRunning, ticksAt, type WriterScan } from '../src/executor/quiescence.js';
import type { SupervisorOptions } from '../src/executor/supervisor.js';
import { acceptedJob, destroyFixture, gatePath, git, invocations, jobDir, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, messages, setStreamMode, startSupervisor, waitFor } from './support/executor-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

// ---- the process scan, on a fake /proc ----

async function fakeProc(): Promise<{ root: string; add: (pid: number, p: { ppid: number; start: number; name?: string; state?: string; env?: string[] | 'unreadable' | 'missing' }) => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'sf009-proc-'));
  cleanup.push(async () => {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    add: async (pid, p) => {
      const dir = join(root, String(pid));
      await mkdir(dir);
      const fields = [p.state ?? 'S', String(p.ppid), ...Array<string>(17).fill('0'), String(p.start), '0', '0'];
      await writeFile(join(dir, 'stat'), `${pid} (${p.name ?? 'node'}) ${fields.join(' ')}\n`);
      if (p.env === 'missing') return;
      await writeFile(join(dir, 'environ'), p.env === 'unreadable' ? '' : `${(p.env ?? ['PATH=/bin']).join('\0')}\0`);
      if (p.env === 'unreadable') await chmod(join(dir, 'environ'), 0o000);
    },
  };
}

test('the scan finds descendants and tagged processes, by identity, and nothing unrelated', async () => {
  const proc = await fakeProc();
  const tag = randomUUID();
  await proc.add(100, { ppid: 1, start: 500, name: 'claude' });
  await proc.add(101, { ppid: 100, start: 510, name: 'bash' });
  await proc.add(102, { ppid: 101, start: 520, name: 'node' });
  await proc.add(103, { ppid: 100, start: 530, state: 'Z' });
  // Detached: re-parented to 1, found by its tag.
  await proc.add(104, { ppid: 1, start: 540, name: 'sleep', env: ['PATH=/bin', `${SESSION_TAG}=${tag}`] });
  // Unrelated: another session's tag, no tag, and one started before the session.
  await proc.add(105, { ppid: 1, start: 550, env: [`${SESSION_TAG}=${randomUUID()}`] });
  await proc.add(106, { ppid: 1, start: 560 });
  await proc.add(107, { ppid: 1, start: 100, env: [`${SESSION_TAG}=${tag}`] });
  // Ended while it was observed: its stat was read, its environment is gone.
  await proc.add(108, { ppid: 1, start: 570, env: 'missing' });
  const scan = await sessionWriters(100, [tag], '500', proc.root);
  assert.deepEqual(scan.writers.map((writer) => [writer.pid, writer.start, writer.name]), [[101, '510', 'bash'], [102, '520', 'node'], [104, '540', 'sleep']]);
  assert.equal(scan.indeterminate, 0, 'a process that ended meanwhile is neither a writer nor indeterminate');
});

test('a same-user process whose identity cannot be read is indeterminate, never ignored', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads any file');
  const proc = await fakeProc();
  await proc.add(100, { ppid: 1, start: 500, name: 'claude' });
  await proc.add(110, { ppid: 1, start: 600, env: 'unreadable' });
  const scan = await sessionWriters(100, [randomUUID()], '500', proc.root);
  assert.deepEqual(scan, { writers: [], indeterminate: 1, unattributed: [{ pid: 110, start: '600', name: 'node' }] });
});

test('an unreadable process list is never quiet; a moment converts to /proc start ticks', async () => {
  assert.deepEqual(await sessionWriters(100, [randomUUID()], '0', join(tmpdir(), `sf009-no-proc-${randomUUID()}`)), { writers: [], indeterminate: 1 });
  const proc = await fakeProc();
  await writeFile(join(proc.root, 'stat'), 'cpu 0 0\nbtime 1000\n');
  assert.equal(ticksAt(new Date(1_100_000).toISOString(), proc.root), String((100 - 5) * 100));
  assert.equal(ticksAt('not a date', proc.root), '0');
});

test('a same-user process whose stat cannot be read, and a truncated process list, are never quiet', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads any file');
  const proc = await fakeProc();
  await proc.add(100, { ppid: 1, start: 500, name: 'claude' });
  await proc.add(130, { ppid: 1, start: 600 });
  await chmod(join(proc.root, '130', 'stat'), 0o000);
  assert.deepEqual(await sessionWriters(100, [randomUUID()], '500', proc.root), { writers: [], indeterminate: 1, unattributed: [] });
  // Nor proof that a known process ended.
  assert.equal((await stillRunning([{ pid: 130, start: '600', name: 'node' }], proc.root)).length, 1);
  // A garbled stat is unreadable too.
  await proc.add(131, { ppid: 1, start: 610 });
  await writeFile(join(proc.root, '131', 'stat'), 'garbage');
  assert.equal((await sessionWriters(100, [randomUUID()], '500', proc.root)).indeterminate, 2);
  // Beyond the enumeration limit: indeterminate, even when everything listed is clean.
  const small = await fakeProc();
  for (const pid of [200, 201, 202]) await small.add(pid, { ppid: 1, start: 700 });
  assert.deepEqual(await sessionWriters(999, [randomUUID()], '0', small.root, 3), { writers: [], indeterminate: 0, unattributed: [] });
  assert.deepEqual(await sessionWriters(999, [randomUUID()], '0', small.root, 2), { writers: [], indeterminate: 1, unattributed: [] });
  const quiet = await awaitQuiescence(
    { scan: () => sessionWriters(999, [randomUUID()], '0', small.root, 2), fingerprint: async () => 'a', activity: () => 0, interrupted: () => undefined },
    { quietMs: 30, timeoutMs: 200, pollMs: 10 },
  );
  assert.equal(quiet.kind, 'timeout');
});

test('background tasks: more than the bound stays busy; long ids that share a prefix are not aliased', async () => {
  const session = fakeSession();
  for (let i = 0; i < 1001; i += 1) session.emit({ type: 'system', subtype: 'task_started', task_id: `task-${i}` });
  for (let i = 0; i < 1001; i += 1) session.emit({ type: 'system', subtype: 'task_notification', task_id: `task-${i}` });
  await session.flush();
  assert.ok(session.stream.openTasks > 0, 'an untracked task may still run: never reported idle');
  const other = fakeSession();
  const prefix = 'x'.repeat(200);
  other.emit({ type: 'system', subtype: 'task_started', task_id: `${prefix}-a` });
  other.emit({ type: 'system', subtype: 'task_started', task_id: `${prefix}-b` });
  other.emit({ type: 'system', subtype: 'task_notification', task_id: `${prefix}-a` });
  await other.flush();
  assert.equal(other.stream.openTasks, 1);
  other.emit({ type: 'system', subtype: 'task_notification', task_id: `${prefix}-b` });
  await other.flush();
  assert.equal(other.stream.openTasks, 0);
});

// A StreamSession over in-memory pipes.
function fakeSession(): { stream: StreamSession; emit: (event: object) => void; flush: () => Promise<void>; sent: string[] } {
  const output = new PassThrough();
  const input = new PassThrough();
  // The uuid of every message the session wrote to stdin, in order.
  const sent: string[] = [];
  let buffered = '';
  input.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
      sent.push((JSON.parse(buffered.slice(0, index)) as { uuid: string }).uuid);
      buffered = buffered.slice(index + 1);
    }
  });
  const stream = new StreamSession({ pid: 1, input, output, errors: new PassThrough(), exited: new Promise(() => undefined) }, randomUUID());
  return {
    sent,
    stream,
    emit: (event) => void output.write(`${JSON.stringify(event)}\n`),
    flush: () => new Promise((resolve) => setTimeout(resolve, 50)),
  };
}

test('a recycled pid is not the process that was waited for', async () => {
  const proc = await fakeProc();
  await proc.add(120, { ppid: 1, start: 900 });
  assert.deepEqual(await stillRunning([{ pid: 120, start: '900', name: 'node' }], proc.root), [{ pid: 120, start: '900', name: 'node' }]);
  assert.deepEqual(await stillRunning([{ pid: 120, start: '800', name: 'node' }, { pid: 121, start: '900', name: 'node' }], proc.root), []);
});

test('the wait: quiet only after a full window with no process, output or change; otherwise the bounded reason', async () => {
  const none: WriterScan = { writers: [], indeterminate: 0 };
  const limits = { quietMs: 60, timeoutMs: 400, pollMs: 10 };
  // Positive: no process of the session, nothing changes.
  const quiet = await awaitQuiescence({ scan: async () => none, fingerprint: async () => 'a', activity: () => 0, interrupted: () => undefined }, limits);
  assert.equal(quiet.kind, 'quiet');
  // A process that keeps running: the bound is reached and named.
  const reasons: string[] = [];
  const busy = await awaitQuiescence(
    { scan: async () => ({ writers: [{ pid: 7, start: '1', name: 'node' }], indeterminate: 0 }), fingerprint: async () => 'a', activity: () => 0, interrupted: () => undefined, waiting: async (reason) => void reasons.push(reason) },
    limits,
  );
  assert.equal(busy.kind, 'timeout');
  assert.match(busy.kind === 'timeout' ? busy.reason : '', /1 process\(es\) \(node\) started by the session still running/);
  assert.equal(reasons.length, 1, 'a reason is reported once while it stays the same');
  // Indeterminate identity is a reason to wait, never to publish.
  const unknown = await awaitQuiescence({ scan: async () => ({ writers: [], indeterminate: 2 }), fingerprint: async () => 'a', activity: () => 0, interrupted: () => undefined }, limits);
  assert.match(unknown.kind === 'timeout' ? unknown.reason : '', /could not identify 2 process\(es\).*\[process_scan_incomplete\]/);
  // Review 03 (R3-4): unattributed processes are named by their own code, with pid and command name.
  const unattributed = await awaitQuiescence({ scan: async () => ({ writers: [], indeterminate: 1, unattributed: [{ pid: 4242, start: '9', name: 'node' }] }), fingerprint: async () => 'a', activity: () => 0, interrupted: () => undefined }, limits);
  assert.match(unattributed.kind === 'timeout' ? unattributed.reason : '', /1 same-user process\(es\) started during the session cannot be attributed .*pid 4242 node.*\[unattributed_processes\]/);
  // A tree that keeps changing, and output that keeps coming, never give a window.
  let n = 0;
  const changing = await awaitQuiescence({ scan: async () => none, fingerprint: async () => String((n += 1)), activity: () => 0, interrupted: () => undefined }, limits);
  assert.match(changing.kind === 'timeout' ? changing.reason : '', /kept changing/);
  let lines = 0;
  const talking = await awaitQuiescence({ scan: async () => none, fingerprint: async () => 'a', activity: () => (lines += 1), interrupted: () => undefined }, limits);
  assert.match(talking.kind === 'timeout' ? talking.reason : '', /kept producing output/);
  // An open background task of the Claude process itself (a subagent has no process of its own).
  const task = await awaitQuiescence({ scan: async () => none, fingerprint: async () => 'a', activity: () => 0, tasks: () => 1, interrupted: () => undefined }, limits);
  assert.match(task.kind === 'timeout' ? task.reason : '', /1 background task\(s\) Claude Code reported started have not ended/);
  // A further turn end interrupts the wait.
  assert.equal((await awaitQuiescence({ scan: async () => none, fingerprint: async () => 'a', activity: () => 0, interrupted: () => 'turn' }, limits)).kind, 'turn');
});

test('an instant check tolerates a process that is unidentifiable only while it ends; a lasting one fails closed', async () => {
  let n = 0;
  const transient = await settledScan(async () => ({ writers: [], indeterminate: (n += 1) <= 2 ? 1 : 0 }), 10, 5);
  assert.deepEqual(transient, { writers: [], indeterminate: 0 });
  const lasting = await settledScan(async () => ({ writers: [], indeterminate: 1 }), 5, 5);
  assert.equal(lasting.indeterminate, 1);
  // A writer is never re-scanned away.
  let m = 0;
  const writer = await settledScan(async () => ({ writers: (m += 1) === 1 ? [{ pid: 9, start: '1', name: 'sh' }] : [], indeterminate: 0 }), 10, 5);
  assert.equal(writer.writers.length, 1);
});

// ---- the supervisor with the fake stream-json Claude ----

// Where the boundary is expected to be reached: a bound that a loaded test host cannot hit by accident.
const ROOMY: Partial<SupervisorOptions> = { quiesceTimeoutMs: 12_000 };
// Where the bound is the expected outcome.
const SHORT: Partial<SupervisorOptions> = { quiesceTimeoutMs: 4000 };

async function launched(mode: string, options: Partial<SupervisorOptions> = {}): Promise<{ fx: Fixture; job: string }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  await setStreamMode(fx, mode);
  const job = 'job-quiet';
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx, options);
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  return { fx, job };
}

const status = async (fx: Fixture, job: string, wanted: string, diagnostic?: RegExp, timeoutMs?: number) => {
  let last = '';
  try {
    return await waitFor(async () => {
      const value = await gateway(fx).status(fx.app, job);
      last = `${value.status} ${value.job?.diagnostic?.code} ${value.job?.diagnostic?.message}`;
      return value.status === wanted && (diagnostic === undefined || diagnostic.test(`${value.job?.diagnostic?.code} ${value.job?.diagnostic?.message}`)) ? value : undefined;
    }, `${job} ${wanted}${diagnostic ? ` ${diagnostic}` : ''}`, timeoutMs);
  } catch (error) {
    throw new Error(`${(error as Error).message}; last seen: ${last}`);
  }
};

// The published snapshot is the tree: a review bound to it is delivered (not tree_changed).
async function reviewIsDelivered(fx: Fixture, job: string): Promise<void> {
  const gw = gateway(fx);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  const reviewId = randomUUID();
  await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: reviewId, findings: [{ text: 'FAKE-EDIT notes.txt next' }] });
  let last = '';
  const next = await waitFor(async () => {
    const value = await gw.status(fx.app, job);
    last = `${value.status} ${value.job?.current_iteration} ${value.job?.diagnostic?.code} ${value.job?.diagnostic?.message}`;
    return value.job?.current_iteration === 'iteration-002' && value.status === 'awaiting_review' ? value : undefined;
  }, 'iteration-002', 20_000).catch((error: Error) => {
    throw new Error(`${error.message}; last seen: ${last}`);
  });
  assert.deepEqual(next.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'delivered']]);
}

test('normal path: no process of the session, published after one quiet window', async () => {
  const { fx, job } = await launched('ok');
  await status(fx, job, 'awaiting_review');
  const snap = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
  assert.equal(snap.snapshot.background_processes, 0);
  assert.equal(snap.snapshot.quiescence?.writers_waited_for, 0);
  assert.equal(snap.snapshot.quiescence?.quiet_ms, 150);
});

test('a child that sleeps longer than the old 1 s settle and then writes is waited for; its write is in the snapshot', async () => {
  const { fx, job } = await launched('implement-sleep-writer', ROOMY);
  await status(fx, job, 'awaiting_review');
  const snap = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
  assert.match(await readFile(join(fx.mediator, snap.diff.path), 'utf8'), /\+slow write/);
  assert.ok((snap.snapshot.quiescence?.writers_waited_for ?? 0) >= 1, 'the child was waited for');
  assert.ok((snap.snapshot.quiescence?.waited_ms ?? 0) >= 1000);
  await reviewIsDelivered(fx, job);
});

test('a writer that left the process tree is found by its session tag and waited for', async () => {
  const { fx, job } = await launched('implement-detached-writer', ROOMY);
  await status(fx, job, 'awaiting_review');
  const snap = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
  assert.match(await readFile(join(fx.mediator, snap.diff.path), 'utf8'), /\+detached write/);
  assert.ok((snap.snapshot.quiescence?.writers_waited_for ?? 0) >= 1);
  await reviewIsDelivered(fx, job);
});

test('a subagent-style background task: output after the turn end, then a second turn end, makes one snapshot after it', async () => {
  const { fx, job } = await launched('implement-late-turn', ROOMY);
  await status(fx, job, 'awaiting_review');
  const snap = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
  assert.match(await readFile(join(fx.mediator, snap.diff.path), 'utf8'), /\+background task result/);
  const value = await gateway(fx).status(fx.app, job);
  assert.equal(value.job?.iterations.length, 1);
  assert.equal((await messages(fx)).length, 1);
  await reviewIsDelivered(fx, job);
});

test('a descendant that would write only after Claude ends blocks the boundary: snapshot_failed, nothing published', async () => {
  const { fx, job } = await launched('implement-delayed-writer', SHORT);
  const failed = await status(fx, job, 'needs_operator', /snapshot_failed/);
  assert.match(failed.job!.diagnostic!.message, /No stable review boundary within 4 s: 1 process\(es\) .* still running/);
  assert.equal(failed.job?.iterations[0]?.state, 'snapshot_failed');
  assert.equal(failed.job?.iterations[0]?.snapshot_sha256, null);
  assert.equal((await gateway(fx).listReviewReady(fx.app)).ready.length, 0);
  assert.ok(!(await readdir(jobDir(fx, job))).includes('iteration-001.snapshot.json'));
  assert.equal(failed.job?.session_process, 'alive', 'nothing was stopped');
});

test('while it waits, the reason is visible (non-secret) in the job status', async () => {
  const { fx, job } = await launched('implement-background', { quiesceTimeoutMs: 8000 });
  const waiting = await status(fx, job, 'running', /snapshot_waiting/);
  assert.match(waiting.job!.diagnostic!.message, /Waiting for a stable review boundary of iteration-001: 1 process\(es\) \(.+\) started by the session still running/);
});

test('an external write during the capture is never published as stable: the capture waits again and includes it', async () => {
  let calls = 0;
  const holder: { fx?: Fixture } = {};
  const { fx, job } = await launched('ok', {
    beforeSnapshotCommit: async () => {
      calls += 1;
      if (calls === 1) await appendFile(join(holder.fx!.appRepo, 'README.md'), 'external write\n');
    },
  });
  holder.fx = fx;
  await status(fx, job, 'awaiting_review');
  assert.equal(calls, 2, 'the first capture was discarded');
  const snap = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
  assert.match(await readFile(join(fx.mediator, snap.diff.path), 'utf8'), /\+external write/);
  await reviewIsDelivered(fx, job);
});

test('an external writer that never stops: snapshot_failed within the bound, nothing published', async () => {
  const holder: { fx?: Fixture } = {};
  const { fx, job } = await launched('ok', { ...SHORT, beforeSnapshotCommit: async () => appendFile(join(holder.fx!.appRepo, 'README.md'), `external ${Date.now()}\n`) });
  holder.fx = fx;
  const failed = await status(fx, job, 'needs_operator', /snapshot_failed/);
  assert.match(failed.job!.diagnostic!.message, /changed during the capture/);
  assert.ok(!(await readdir(jobDir(fx, job))).includes('iteration-001.snapshot.json'));
});

test('a Git index changed during the capture ends the session for inspection; nothing is published', async () => {
  const holder: { fx?: Fixture } = {};
  const { fx, job } = await launched('ok', { beforeSnapshotCommit: async () => void git(holder.fx!.appRepo, 'add', 'README.md') });
  holder.fx = fx;
  const ended = await status(fx, job, 'needs_inspection', /git_operation_detected/);
  assert.equal(ended.job?.iterations[0]?.snapshot_sha256, null);
  assert.equal((await invocations(fx)).length, 1);
});

test('a Git control file changed during the capture ends the session for inspection; nothing is published', async () => {
  const holder: { fx?: Fixture } = {};
  const { fx, job } = await launched('ok', { beforeSnapshotCommit: async () => appendFile(join(holder.fx!.appRepo, '.git', 'config'), '[sf009]\n\tprobe = 1\n') });
  holder.fx = fx;
  const ended = await status(fx, job, 'needs_inspection', /git_operation_detected/);
  assert.equal(ended.job?.iterations[0]?.snapshot_sha256, null);
});

test('a tagged process outside the tree is still running: it is waited for, never killed', async () => {
  const { fx, job } = await launched('implement-late-turn', ROOMY);
  // Stands in for a process the session started that cleared its parent link but kept its tag.
  const sid = await waitFor(async () => (JSON.parse(await readFile(join(jobDir(fx, job), 'managed.json'), 'utf8')) as { session: { current_session_id: string | null } }).session.current_session_id ?? undefined, 'session id');
  const started = Date.now();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore', env: { ...process.env, [SESSION_TAG]: sid } });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  cleanup.push(async () => void child.kill('SIGKILL'));
  await status(fx, job, 'awaiting_review', undefined, 20_000);
  assert.ok(Date.now() - started >= 2900, 'published only after the tagged process ended');
  assert.equal(await exited, 0, 'it ended on its own; nothing was killed');
});

test('a turn end after publication with an unchanged tree is taken; the review loop continues', async () => {
  const { fx, job } = await launched('implement-late-result', ROOMY);
  await status(fx, job, 'awaiting_review');
  await waitFor(async () => {
    const managed = JSON.parse(await readFile(join(jobDir(fx, job), 'managed.json'), 'utf8')) as { events: Array<{ event: string }> };
    return managed.events.some((entry) => entry.event === 'late_turn');
  }, 'late_turn', 20_000);
  assert.equal((await gateway(fx).status(fx.app, job)).status, 'awaiting_review');
  await reviewIsDelivered(fx, job);
});

test('a turn end after publication that changed the tree publishes an immutable continuation in the same session', async () => {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  await setStreamMode(fx, 'late-on-signal', { lateWrite: '1' });
  const job = 'job-late';
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx, ROOMY);
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  await status(fx, job, 'awaiting_review');
  const gw = gateway(fx);
  const first = await gw.snapshot(fx.app, job, 'iteration-001');
  const original = await readFile(join(jobDir(fx, job), 'iteration-001.snapshot.json'));
  await writeFile(join(fx.fakeDir, 'late-signal'), '');
  const continued = await waitFor(async () => {
    const value = await gw.status(fx.app, job);
    return value.status === 'awaiting_review' && value.job?.current_iteration === 'iteration-002' ? value : undefined;
  }, 'late result republished', 20_000);
  const second = await gw.snapshot(fx.app, job, 'iteration-002');
  assert.notEqual(second.snapshot_sha256, first.snapshot_sha256);
  assert.match(await readFile(join(fx.mediator, second.diff.path), 'utf8'), /late turn write/);
  assert.deepEqual(await readFile(join(jobDir(fx, job), 'iteration-001.snapshot.json')), original);
  assert.equal(continued.job?.session_process, 'alive');
  assert.equal(continued.job?.iterations[0]?.state, 'abandoned');
  assert.equal((await messages(fx)).length, 1);
  assert.equal((await invocations(fx)).length, 1);
});

test('output after the quiet window and before publication discards that capture; the quiet window starts again', async () => {
  let calls = 0;
  const holder: { fx?: Fixture } = {};
  const { fx, job } = await launched('progress-on-signal', {
    ...ROOMY,
    beforeSnapshotCommit: async () => {
      calls += 1;
      if (calls !== 1) return;
      // Claude writes one non-result line (no task, no turn end, no file change) right now.
      await writeFile(join(holder.fx!.fakeDir, 'progress-signal'), '');
      await new Promise((resolve) => setTimeout(resolve, 400));
    },
  });
  holder.fx = fx;
  await status(fx, job, 'awaiting_review');
  assert.equal(calls, 2, 'the first capture was not published');
  await reviewIsDelivered(fx, job);
});

test('refused actions reported by a turn end after publication block the acceptance (needs_operator); a review still goes through', async () => {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  await setStreamMode(fx, 'implement-late-result', { lateDenial: '1' });
  const job = 'job-late-denial';
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx, ROOMY);
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  await status(fx, job, 'awaiting_review');
  const gw = gateway(fx);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  assert.deepEqual(snap.snapshot.blocked_actions, [], 'published clean');
  const flagged = await status(fx, job, 'needs_operator', /late_turn_refused/, 20_000);
  assert.deepEqual(flagged.job?.iterations[0]?.blocked_actions, [{ action: 'Bash(git push)', count: 1 }]);
  assert.ok(!flagged.job!.diagnostic!.message.includes('origin main'), 'the refused input is not echoed');
  const acceptanceId = randomUUID();
  await gw.accept({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, acceptance_id: acceptanceId });
  const refused = await waitFor(async () => {
    const value = await gw.status(fx.app, job);
    return value.job?.acceptances.some((entry) => entry.acceptance_id === acceptanceId) ? value : undefined;
  }, 'acceptance handled');
  assert.deepEqual(refused.job?.acceptances.map((entry) => [entry.outcome, entry.reason]), [['rejected', 'late_refused_actions']]);
  assert.notEqual(refused.status, 'closed');
  assert.equal(refused.job?.session_process, 'alive');
  assert.equal(await readFile(join(jobDir(fx, job), 'execution.json'), 'utf8').then((text) => (JSON.parse(text) as { state: string }).state), 'running');
  await reviewIsDelivered(fx, job);
});

// ---- review 9a4e25e0: late results at the review/acceptance commit boundary, failed late turns ----

async function lateLaunch(mode: string, extra: Record<string, string>, options: Partial<SupervisorOptions> = {}): Promise<{ fx: Fixture; job: string }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  await setStreamMode(fx, mode, extra);
  const job = 'job-late-boundary';
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx, { ...ROOMY, ...options });
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  return { fx, job };
}

// A seam that makes the fake Claude emit its late result exactly while the first request of kind
// is between its binding and its commit, and waits until the supervisor has read it.
const lateDuring = (fx: () => Fixture, kind: 'review' | 'acceptance') => {
  let fired = false;
  return async (current: 'review' | 'acceptance') => {
    if (current !== kind || fired) return;
    fired = true;
    await writeFile(join(fx().fakeDir, 'late-signal'), '');
    await new Promise((resolve) => setTimeout(resolve, 400));
  };
};

test('a late result with a refused action arriving while an acceptance is being committed: no acceptance', async () => {
  const holder: { fx?: Fixture } = {};
  const { fx, job } = await lateLaunch('late-on-signal', { lateDenial: '1' }, { beforeRequestCommit: lateDuring(() => holder.fx!, 'acceptance') });
  holder.fx = fx;
  await status(fx, job, 'awaiting_review');
  const gw = gateway(fx);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  const acceptanceId = randomUUID();
  await gw.accept({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, acceptance_id: acceptanceId });
  const handled = await waitFor(async () => {
    const value = await gw.status(fx.app, job);
    return value.job?.acceptances.some((entry) => entry.acceptance_id === acceptanceId) ? value : undefined;
  }, 'acceptance handled', 20_000);
  assert.deepEqual(handled.job?.acceptances.map((entry) => [entry.outcome, entry.reason]), [['rejected', 'late_refused_actions']]);
  assert.deepEqual(handled.job?.iterations[0]?.blocked_actions, [{ action: 'Bash(git push)', count: 1 }]);
  assert.notEqual(handled.status, 'closed');
  assert.equal(handled.job?.session_process, 'alive');
  assert.equal((JSON.parse(await readFile(join(jobDir(fx, job), 'execution.json'), 'utf8')) as { state: string }).state, 'running', 'nothing was collected');
});

test('a late result arriving while a review is being committed is handled first; it never completes the next iteration', async () => {
  const holder: { fx?: Fixture } = {};
  const { fx, job } = await lateLaunch('late-on-signal', { lateDenial: '1' }, { beforeRequestCommit: lateDuring(() => holder.fx!, 'review') });
  holder.fx = fx;
  await status(fx, job, 'awaiting_review');
  const gw = gateway(fx);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  const reviewId = randomUUID();
  await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: reviewId, findings: [{ text: 'FAKE-EDIT notes.txt second-round' }] });
  const next = await waitFor(async () => {
    const value = await gw.status(fx.app, job);
    return value.job?.current_iteration === 'iteration-002' && value.job.iterations[1]?.snapshot_sha256 ? value : undefined;
  }, 'iteration-002 published', 20_000);
  // The late result was taken as a late turn of iteration-001, before the review was delivered.
  const managed = JSON.parse(await readFile(join(jobDir(fx, job), 'managed.json'), 'utf8')) as { events: Array<{ event: string }> };
  const order = managed.events.map((entry) => entry.event);
  assert.ok(order.indexOf('late_turn_refused') < order.indexOf('review_delivered'), order.join(','));
  assert.deepEqual(next.job?.iterations[0]?.blocked_actions, [{ action: 'Bash(git push)', count: 1 }]);
  // iteration-002 is the answer to the review, not the late result.
  const second = await gw.snapshot(fx.app, job, 'iteration-002');
  assert.match(await readFile(join(fx.mediator, second.diff.path), 'utf8'), /\+second-round/);
  assert.equal((await messages(fx)).length, 2);
});

test('a failed late turn (is_error) with an unchanged tree makes the snapshot not acceptable; a review still goes through', async () => {
  const { fx, job } = await lateLaunch('implement-late-result', { lateError: '1' });
  await status(fx, job, 'awaiting_review');
  const gw = gateway(fx);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  assert.equal(snap.snapshot.turn.is_error, false, 'published as a successful turn');
  const flagged = await status(fx, job, 'needs_operator', /late_turn_error/, 20_000);
  assert.match(flagged.job!.diagnostic!.message, /result subtype error_during_execution/);
  assert.ok(!flagged.job!.diagnostic!.message.includes('One more thing'), 'no result text is echoed');
  const acceptanceId = randomUUID();
  await gw.accept({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, acceptance_id: acceptanceId });
  const handled = await waitFor(async () => {
    const value = await gw.status(fx.app, job);
    return value.job?.acceptances.some((entry) => entry.acceptance_id === acceptanceId) ? value : undefined;
  }, 'acceptance handled', 20_000);
  assert.deepEqual(handled.job?.acceptances.map((entry) => [entry.outcome, entry.reason]), [['rejected', 'late_turn_error']]);
  assert.equal(handled.job?.session_process, 'alive');
  await reviewIsDelivered(fx, job);
});

const RESULT = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, permission_denials: [] };
const ack = (uuid: string) => ({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: [{ type: 'text', text: 'echo' }] } });

// Sends A, acknowledges it and takes its answer; then sends B. Returns the session and both uuids.
async function afterFirstAnswer(): Promise<{ session: ReturnType<typeof fakeSession>; a: string; b: string }> {
  const session = fakeSession();
  await session.stream.send('A');
  await session.flush();
  const a = session.sent[0]!;
  session.emit(ack(a));
  session.emit(RESULT);
  await session.flush();
  const first = await session.stream.nextTurn();
  assert.ok(first?.kind === 'result' && session.stream.answers(first) && session.stream.correlated);
  await session.stream.send('B');
  await session.flush();
  return { session, a, b: session.sent[1]! };
}

test('a result answers a message only after its own acknowledgment; without acknowledgment only the first message', async () => {
  const { session, b } = await afterFirstAnswer();
  // An old result in flight: it arrives after B was sent, before B's acknowledgment.
  session.emit(RESULT);
  session.emit(ack(b));
  session.emit(RESULT);
  await session.flush();
  const old = await session.stream.nextTurn();
  assert.ok(old?.kind === 'result' && !session.stream.answers(old), 'the old result is not the answer');
  const answer = await session.stream.nextTurn();
  assert.ok(answer?.kind === 'result' && session.stream.answers(answer));
  // No acknowledgment at all: the first message has nothing before it; later ones cannot be attributed.
  const silent = fakeSession();
  await silent.stream.send('first');
  silent.emit(RESULT);
  await silent.flush();
  const only = await silent.stream.nextTurn();
  assert.ok(only?.kind === 'result' && silent.stream.answers(only));
  assert.equal(silent.stream.correlated, false);
  await silent.stream.send('second');
  silent.emit(RESULT);
  await silent.flush();
  const unattributable = await silent.stream.nextTurn();
  assert.ok(unattributable?.kind === 'result' && !silent.stream.answers(unattributable));
});

for (const [label, bogus] of [
  ['a duplicate acknowledgment of A', (ids: { a: string; b: string }) => ack(ids.a)],
  ['isReplay with a foreign uuid', () => ack(randomUUID())],
  ['isReplay without any uuid', () => ({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } })],
  ["a replayed tool_result carrying B's uuid", (ids: { a: string; b: string }) => ({ type: 'user', isReplay: true, uuid: ids.b, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })],
] as Array<[string, (ids: { a: string; b: string }) => object]>) {
  test(`${label} never acknowledges B: a stale result before B's real acknowledgment is not B's answer`, async () => {
    const { session, a, b } = await afterFirstAnswer();
    session.emit(bogus({ a, b }));
    session.emit(RESULT);
    await session.flush();
    const stale = await session.stream.nextTurn();
    assert.ok(stale?.kind === 'result' && !session.stream.answers(stale), 'not counted as an acknowledgment');
    session.emit(ack(b));
    session.emit(RESULT);
    await session.flush();
    const answer = await session.stream.nextTurn();
    assert.ok(answer?.kind === 'result' && session.stream.answers(answer), "B's own acknowledgment counts");
  });
}

// ---- review 97dbc7ac: review commit race, publication fence, wedge-free re-quiescence ----

// Fires the fake Claude's signal file (late-signal or progress-signal) once, at a seam, and waits
// until the supervisor has read what it emits.
const fireOnce = (fx: () => Fixture, file: string) => {
  let fired = false;
  return async () => {
    if (fired) return;
    fired = true;
    await writeFile(join(fx().fakeDir, file), '');
    await new Promise((resolve) => setTimeout(resolve, 400));
  };
};

const events = async (fx: Fixture, job: string) =>
  (JSON.parse(await readFile(join(jobDir(fx, job), 'managed.json'), 'utf8')) as { events: Array<{ event: string; detail: string | null }> }).events;

async function submitAndAwaitNext(fx: Fixture, job: string, edit: string): Promise<{ reviewId: string; value: Awaited<ReturnType<ReturnType<typeof gateway>['status']>> }> {
  const gw = gateway(fx);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  const reviewId = randomUUID();
  await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: reviewId, findings: [{ text: `FAKE-EDIT notes.txt ${edit}` }] });
  const value = await waitFor(async () => {
    const current = await gw.status(fx.app, job);
    return current.job?.current_iteration === 'iteration-002' && current.job.iterations[1]?.snapshot_sha256 ? current : undefined;
  }, 'iteration-002 published', 25_000);
  return { reviewId, value };
}

for (const variant of [{ name: 'refused action', extra: { lateDenial: '1' } as Record<string, string> }, { name: 'failed turn', extra: { lateError: '1' } as Record<string, string> }]) {
  test(`review commit race (${variant.name}): a late result after the review was recorded rolls it back; it is attributed to iteration-001 and the review is delivered once, afterwards`, async () => {
    const holder: { fx?: Fixture } = {};
    const fire = fireOnce(() => holder.fx!, 'late-signal');
    const { fx, job } = await lateLaunch('late-on-signal', variant.extra, { afterRequestRecorded: async (kind) => (kind === 'review' ? fire() : undefined) });
    holder.fx = fx;
    await status(fx, job, 'awaiting_review');
    const { reviewId, value } = await submitAndAwaitNext(fx, job, 'after-rollback');
    const order = (await events(fx, job)).map((entry) => entry.event);
    assert.ok(order.indexOf('review_withdrawn') >= 0 && order.indexOf('review_withdrawn') < order.lastIndexOf('review_delivered'), order.join(','));
    assert.ok(order.indexOf(variant.extra.lateDenial ? 'late_turn_refused' : 'late_turn_error') < order.lastIndexOf('review_delivered'));
    assert.deepEqual(value.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'delivered']], 'delivered exactly once');
    assert.equal((await messages(fx)).length, 2, 'one review message reached Claude');
    const managed = JSON.parse(await readFile(join(jobDir(fx, job), 'managed.json'), 'utf8')) as { iterations: Array<{ blocked_actions: unknown[]; late_error?: unknown }> };
    if (variant.extra.lateDenial) assert.deepEqual(managed.iterations[0]!.blocked_actions, [{ action: 'Bash(git push)', count: 1 }]);
    else assert.ok(managed.iterations[0]!.late_error !== undefined);
    const second = await gateway(fx).snapshot(fx.app, job, 'iteration-002');
    assert.match(await readFile(join(fx.mediator, second.diff.path), 'utf8'), /\+after-rollback/, 'iteration-002 is the answer to the review');
  });

  test(`old result after the review was sent, before Claude acknowledged it (${variant.name}): attributed to iteration-001, never the answer`, async () => {
    const { fx, job } = await lateLaunch('old-result-before-ack', variant.extra);
    await status(fx, job, 'awaiting_review');
    const { reviewId, value } = await submitAndAwaitNext(fx, job, 'real-answer');
    const managed = JSON.parse(await readFile(join(jobDir(fx, job), 'managed.json'), 'utf8')) as { iterations: Array<{ blocked_actions: unknown[]; late_error?: unknown; state: string }>; events: Array<{ event: string }> };
    assert.ok(managed.events.some((entry) => entry.event === 'stale_turn'));
    if (variant.extra.lateDenial) assert.deepEqual(managed.iterations[0]!.blocked_actions, [{ action: 'Bash(git push)', count: 1 }]);
    else assert.ok(managed.iterations[0]!.late_error !== undefined);
    assert.deepEqual(managed.iterations[1]!.blocked_actions, [], 'nothing of the old turn is put on iteration-002');
    assert.deepEqual(value.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'delivered']]);
    const second = await gateway(fx).snapshot(fx.app, job, 'iteration-002');
    assert.match(await readFile(join(fx.mediator, second.diff.path), 'utf8'), /\+real-answer/, 'not a premature snapshot of the old result');
    assert.equal(second.snapshot.turn.is_error, false);
  });
}

test('output right before the snapshot is recorded as ready: another full capture', async () => {
  const holder: { fx?: Fixture } = {};
  const fire = fireOnce(() => holder.fx!, 'progress-signal');
  let before = 0;
  const { fx, job } = await lateLaunch('progress-on-signal', {}, {
    aroundPublishRecord: async (stage) => {
      if (stage !== 'before') return;
      before += 1;
      await fire();
    },
  });
  holder.fx = fx;
  await status(fx, job, 'awaiting_review');
  assert.equal(before, 2, 'the first capture was not recorded as ready');
  await reviewIsDelivered(fx, job);
});

test('output while the snapshot is being recorded as ready: no request is acted on before a new full quiet window', async () => {
  const holder: { fx?: Fixture } = {};
  const fire = fireOnce(() => holder.fx!, 'progress-signal');
  const { fx, job } = await lateLaunch('progress-on-signal', {}, { aroundPublishRecord: async (stage) => (stage === 'after' ? fire() : undefined) });
  holder.fx = fx;
  await status(fx, job, 'awaiting_review');
  await reviewIsDelivered(fx, job);
  const order = (await events(fx, job)).map((entry) => entry.event);
  assert.ok(order.indexOf('boundary_requiesced') >= 0 && order.indexOf('boundary_requiesced') < order.indexOf('review_delivered'), order.join(','));
});

test('one output line after publication, then silence: a new quiet window is observed and the review goes through (no endless rejection)', async () => {
  const { fx, job } = await lateLaunch('progress-on-signal', {});
  await status(fx, job, 'awaiting_review');
  await writeFile(join(fx.fakeDir, 'progress-signal'), '');
  await waitFor(async () => (await events(fx, job)).some((entry) => entry.event === 'boundary_requiesced'), 'requiesced', 20_000);
  await reviewIsDelivered(fx, job);
  const value = await gateway(fx).status(fx.app, job);
  assert.ok(value.job?.reviews.every((entry) => entry.outcome === 'delivered'), 'nothing was rejected for it');
});

test('output that never stops after publication keeps a continuation working; no review is handed over', async () => {
  const holder: { fx?: Fixture } = {};
  const fire = fireOnce(() => holder.fx!, 'progress-signal');
  const { fx, job } = await lateLaunch('chatty-on-signal', {}, {
    quiesceTimeoutMs: 3000,
    beforeRequestCommit: async (kind) => (kind === 'review' ? fire() : undefined),
  });
  holder.fx = fx;
  await status(fx, job, 'awaiting_review');
  const gw = gateway(fx);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'FAKE-EDIT notes.txt never' }] });
  await waitFor(async () => (await gw.status(fx.app, job)).job?.current_iteration === 'iteration-002', 'work continued', 20_000);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const working = await gw.status(fx.app, job);
  assert.equal(working.status, 'running');
  assert.equal(working.job?.iterations[1]?.snapshot_sha256, null, 'progress without a final result cannot publish');
  assert.deepEqual(working.job?.reviews, [], 'the old review was never delivered');
  assert.equal(working.job?.session_process, 'alive');
  assert.equal((await messages(fx)).length, 1);
});

// ---- review 9bbf622d: the bound snapshot is revalidated at the commit boundary ----

const MUTATIONS: Array<[string, (fx: Fixture, job: string) => Promise<void>, RegExp]> = [
  ['README changed', async (fx) => appendFile(join(fx.appRepo, 'README.md'), 'changed at the commit boundary\n'), /tree_changed/],
  ['Git index changed', async (fx) => void git(fx.appRepo, 'add', 'README.md'), /tree_changed/],
  ['diff artifact changed', async (fx, job) => appendFile(join(jobDir(fx, job), 'iteration-001.diff'), '+not what was reviewed\n'), /snapshot_artifact_invalid/],
];

for (const seam of ['beforeRequestCommit', 'afterRequestRecorded'] as const) {
  for (const [what, mutate, reason] of MUTATIONS) {
    for (const kind of ['review', 'acceptance'] as const) {
      test(`${what} at ${seam} (no Claude output) refuses the ${kind}: never delivered or accepted, inspection required`, async () => {
        const holder: { fx?: Fixture; job?: string } = {};
        let fired = false;
        const { fx, job } = await lateLaunch('ok', {}, {
          [seam]: async (current: 'review' | 'acceptance') => {
            if (current !== kind || fired) return;
            fired = true;
            await mutate(holder.fx!, holder.job!);
          },
        });
        holder.fx = fx;
        holder.job = job;
        await status(fx, job, 'awaiting_review');
        const gw = gateway(fx);
        const snap = await gw.snapshot(fx.app, job, 'iteration-001');
        if (kind === 'review') {
          await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'FAKE-EDIT notes.txt never' }] });
        } else {
          await gw.accept({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, acceptance_id: randomUUID() });
        }
        const ended = await status(fx, job, 'needs_inspection', /conflict/, 20_000);
        assert.ok(fired);
        assert.equal(ended.job?.iterations[0]?.state, 'conflict');
        if (kind === 'review') {
          assert.equal(ended.job?.reviews.length, 1);
          assert.equal(ended.job?.reviews[0]?.outcome, 'rejected');
          assert.match(ended.job?.reviews[0]?.reason ?? '', reason);
          assert.equal(ended.job?.iterations.length, 1, 'no next iteration');
          assert.equal((await messages(fx)).length, 1, 'the review never reached Claude');
        } else {
          assert.ok(ended.job?.acceptances.every((entry) => entry.outcome === 'rejected'));
          assert.match(ended.job?.acceptances[0]?.reason ?? '', reason);
          const execution = JSON.parse(await readFile(join(jobDir(fx, job), 'execution.json'), 'utf8')) as { state: string };
          assert.notEqual(execution.state, 'completed');
        }
      });
    }
  }
}

// ---- review 88e39f51: unacknowledged later messages; the review audit reflects the handoff ----

for (const [label, extra] of [
  ['no acknowledgment', { noReplayAfterFirst: '1' }],
  ['an acknowledgment with another uuid', { badReplayAfterFirst: '1' }],
] as Array<[string, Record<string, string>]>) {
  test(`a review answered but never acknowledged (${label}): bounded, fail-closed turn_correlation_unavailable; no snapshot, review unconfirmed, gate released`, async () => {
    const { fx, job } = await lateLaunch('ok', extra);
    await status(fx, job, 'awaiting_review');
    const gw = gateway(fx);
    const snap = await gw.snapshot(fx.app, job, 'iteration-001');
    const reviewId = randomUUID();
    await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: reviewId, findings: [{ text: 'FAKE-EDIT notes.txt unattributable' }] });
    const ended = await status(fx, job, 'needs_inspection', /turn_correlation_unavailable/, 20_000);
    assert.deepEqual(ended.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'unconfirmed']]);
    assert.equal(ended.job?.iterations[1]?.snapshot_sha256 ?? null, null, 'nothing was published from the unattributable result');
    assert.equal(ended.job?.session_process, 'ended', 'the session ended: the gate is free again');
    assert.ok((await events(fx, job)).some((entry) => entry.event === 'stale_turn'), 'the result was not taken as the answer');
    assert.equal((await invocations(fx)).length, 1);
    assert.deepEqual(await new SessionGate(gatePath(fx)).holders(), []);
  });
}

test('the review audit says delivered only after Claude Code acknowledged that message', async () => {
  const { fx, job } = await lateLaunch('ok', {});
  await status(fx, job, 'awaiting_review');
  const { reviewId, value } = await submitAndAwaitNext(fx, job, 'acknowledged');
  assert.deepEqual(value.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'delivered']]);
  const order = (await events(fx, job)).map((entry) => entry.event);
  assert.ok(order.indexOf('review_sending') < order.indexOf('review_delivered'), order.join(','));
});

test('the review message cannot be written: unconfirmed (never delivered), never retried, session ended for inspection, no second launch', async () => {
  const { fx, job } = await lateLaunch('ok', {}, {
    beforeReviewWrite: () => {
      throw Object.assign(new Error('injected write failure'), { code: 'EPIPE' });
    },
  });
  await status(fx, job, 'awaiting_review');
  const gw = gateway(fx);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  const reviewId = randomUUID();
  await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: reviewId, findings: [{ text: 'FAKE-EDIT notes.txt never' }] });
  const ended = await status(fx, job, 'needs_inspection', /review_not_delivered/, 20_000);
  assert.deepEqual(ended.job?.reviews.map((entry) => [entry.review_id, entry.outcome, entry.reason]), [[reviewId, 'unconfirmed', 'send_failed']]);
  assert.equal((await messages(fx)).length, 1, 'the review never reached Claude');
  assert.equal((await invocations(fx)).length, 1, 'no second launch');
});

test('a supervisor crash after recording the review, before sending it: after the restart it is unconfirmed, never delivered, nothing relaunched', async () => {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  const job = 'job-crash-review';
  const accepted = await acceptedJob(fx, job);
  const file = join(fx.sandbox, 'fixture.json');
  await writeFile(file, JSON.stringify(fx));
  const entry = fileURLToPath(new URL('./support/supervisor-fixture.js', import.meta.url));
  const crashing = spawn(process.execPath, [entry, file, 'crash-after-review-recorded'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const crashed = new Promise((resolve) => crashing.once('exit', resolve));
  cleanup.push(async () => void crashing.kill('SIGKILL'));
  await authorize(fx, job, accepted, randomUUID());
  await status(fx, job, 'awaiting_review');
  const gw = gateway(fx);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  const reviewId = randomUUID();
  await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: reviewId, findings: [{ text: 'FAKE-EDIT notes.txt never' }] });
  await crashed;
  const recorded = JSON.parse(await readFile(join(jobDir(fx, job), 'managed.json'), 'utf8')) as { reviews: Array<{ review_id: string; outcome: string }> };
  assert.deepEqual(recorded.reviews.map((review) => [review.review_id, review.outcome]), [[reviewId, 'sending']], 'recorded as being sent, not delivered');
  // The restarted supervisor collects the session (never relaunched) and settles the review.
  const restarted = await startSupervisor(fx);
  cleanup.push(restarted.stop);
  const ended = await waitFor(async () => {
    const value = await gw.status(fx.app, job);
    return ['needs_inspection', 'failed', 'closed'].includes(value.status) ? value : undefined;
  }, 'recovered', 30_000);
  assert.equal(ended.status, 'needs_inspection');
  assert.deepEqual(ended.job?.reviews.map((review) => [review.review_id, review.outcome, review.reason]), [[reviewId, 'unconfirmed', 'supervisor_restarted']]);
  assert.equal((await messages(fx)).length, 1, 'the review never reached Claude');
  assert.equal((await invocations(fx)).length, 1, 'no relaunch');
});
