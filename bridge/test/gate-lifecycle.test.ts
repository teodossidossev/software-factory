// SF-007 Review 03, R3-1: every wait on a session-gate helper is bounded. A helper
// that was never told to exec (silent or stopped before HELD, lingering after BUSY
// or ERROR, stuck during release) is stopped, and the gate is verified free in
// /proc/locks; when that cannot be shown, the call fails closed and the gate stays
// closed for everyone. Fake helpers (scripts in place of the interpreter) inject
// the faults; no real Claude runs.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { ProcessClaudeRunner } from '../src/execution/runner.js';
import { ExecutionService } from '../src/execution/service.js';
import { SessionGate, type SessionGateOptions } from '../src/execution/session-gate.js';
import { acceptedJob, createFixture, destroyFixture, fileReceiver, fixtureService, gatePath, git, invocations, jobDir, type Fixture } from './support/operator-fixture.js';

let fx: Fixture;
const leftovers: number[] = [];
const FAST: SessionGateOptions = { handshakeTimeoutMs: 500, exitWaitMs: 500 };
const BOUND_MS = 4_000;

before(async () => {
  fx = await createFixture();
});

after(async () => {
  await destroyFixture(fx);
});

afterEach(async () => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const exited = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    if (stat === '' || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
};

// A fake helper: records its pid, then runs body (with the control channel on fd 3).
async function fakeHelper(name: string, body: string): Promise<{ path: string; pid: () => Promise<number> }> {
  const path = join(fx.sandbox, `${name}.sh`);
  const pidFile = join(fx.sandbox, `${name}.pid`);
  await writeFile(path, `#!/bin/sh\necho $$ > ${pidFile}\n${body}\n`, { mode: 0o755 });
  return { path, pid: async () => Number(await readFile(pidFile, 'utf8')) };
}

async function timed<T>(work: Promise<T>): Promise<{ value?: T; error?: { code?: string; message: string }; ms: number }> {
  const started = Date.now();
  try {
    return { value: await work, ms: Date.now() - started };
  } catch (error) {
    return { error: error as { code?: string; message: string }, ms: Date.now() - started };
  }
}

test('before HELD: a silent or stopped helper is stopped within the bound; the gate is verified free', async () => {
  for (const [name, body] of [
    ['silent', 'exec sleep 600'],
    // Stopped before the real helper even starts.
    ['stopped', 'kill -STOP $$\nexec python3 "$@"'],
  ] as const) {
    const helper = await fakeHelper(name, body);
    const result = await timed(new SessionGate(gatePath(fx), { ...FAST, python: helper.path }).reserve('ignore'));
    assert.ok(result.ms < BOUND_MS, `${name}: ${result.ms} ms`);
    assert.equal(result.error?.code, 'gate_unresponsive', name);
    assert.match(result.error!.message, /did not answer within 1 s and was stopped; the gate is free again/);
    assert.doesNotMatch(result.error!.message, new RegExp(fx.sandbox));
    assert.ok(await exited(await helper.pid()), `${name}: helper still running`);
    assert.deepEqual(await new SessionGate(gatePath(fx)).holders(), []);
  }
  // A silent helper that does hold the lock and cannot be ended: fails closed, the gate stays closed.
  const locking = await fakeHelper('locking', `exec flock --nonblock --close ${gatePath(fx)} sleep 600`);
  const stuck = await timed(new SessionGate(gatePath(fx), { ...FAST, python: locking.path, signal: () => undefined }).reserve('ignore'));
  const lockingPid = await locking.pid();
  leftovers.push(lockingPid);
  assert.ok(stuck.ms < BOUND_MS, `${stuck.ms} ms`);
  assert.equal(stuck.error?.code, 'gate_unresponsive');
  assert.match(stuck.error!.message, new RegExp(`\\(pid ${lockingPid}\\) did not answer within 1 s and could not be shown to have stopped; it may still hold the session gate`));
  const blocked = await new SessionGate(gatePath(fx)).reserve('ignore');
  assert.ok('busy' in blocked && blocked.holderPids.includes(lockingPid), 'no second reservation while ownership is uncertain');
  // flock(1) runs its command as a child: end that too, so nothing is left behind.
  const children = (await readFile(`/proc/${lockingPid}/task/${lockingPid}/children`, 'utf8').catch(() => '')).trim().split(/\s+/).filter(Boolean).map(Number);
  for (const child of children) process.kill(child, 'SIGKILL');
  process.kill(lockingPid, 'SIGKILL');
  for (let attempt = 0; attempt < 40 && (await new SessionGate(gatePath(fx)).holders()).length > 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  // A normal reservation works right after (positive control).
  const free = await new SessionGate(gatePath(fx)).reserve('ignore');
  assert.ok('held' in free);
  await free.held.release();
});

test('after BUSY or ERROR: a lingering helper is stopped within the bound and the answer stands', async () => {
  const busy = await fakeHelper('busy-stuck', 'echo BUSY >&3\nexec sleep 600');
  const busyResult = await timed(new SessionGate(gatePath(fx), { ...FAST, python: busy.path }).reserve('ignore'));
  assert.ok(busyResult.ms < BOUND_MS, `${busyResult.ms} ms`);
  assert.ok(busyResult.value !== undefined && 'busy' in busyResult.value);
  assert.ok(await exited(await busy.pid()));

  const failed = await fakeHelper('error-stuck', "echo 'ERROR unsafe gate file' >&3\nexec sleep 600");
  const errorResult = await timed(new SessionGate(gatePath(fx), { ...FAST, python: failed.path }).reserve('ignore'));
  assert.ok(errorResult.ms < BOUND_MS, `${errorResult.ms} ms`);
  assert.equal(errorResult.error?.code, 'io_failed');
  assert.match(errorResult.error!.message, /could not be taken \(ERROR unsafe gate file\)/);
  assert.ok(await exited(await failed.pid()));

  // A genuinely busy gate (positive control): answered at once, nothing stopped.
  const holder = await new SessionGate(gatePath(fx)).reserve('ignore');
  assert.ok('held' in holder);
  const second = await timed(new SessionGate(gatePath(fx), FAST).reserve('ignore'));
  assert.ok(second.value !== undefined && 'busy' in second.value && second.value.holderPids.includes(holder.held.pid));
  assert.ok(alive(holder.held.pid), 'the holder is never stopped by another reservation');
  await holder.held.release();
});

// Review 06: a lingering BUSY/ERROR helper that cannot be shown stopped fails closed (gate_unresponsive,
// which the probe command turns into exit 4) instead of a plain answer that leaves Node attached to it.
for (const [answer, line] of [
  ['BUSY', 'BUSY'],
  ['ERROR', 'ERROR unsafe gate file'],
] as const) {
  test(`after ${answer}: a lingering helper that cannot be shown stopped fails closed (gate_unresponsive)`, async () => {
    const helper = await fakeHelper(`${answer.toLowerCase()}-unkillable`, `echo '${line}' >&3\nexec sleep 600`);
    const result = await timed(new SessionGate(gatePath(fx), { ...FAST, python: helper.path, signal: () => undefined }).reserve('ignore'));
    const pid = await helper.pid();
    leftovers.push(pid);
    assert.ok(result.ms < BOUND_MS, `${result.ms} ms`);
    assert.equal(result.error?.code, 'gate_unresponsive');
    assert.match(result.error!.message, new RegExp(`\\(pid ${pid}\\) answered ${line} but did not end within 1 s and could not be shown to have stopped`));
    assert.doesNotMatch(result.error!.message, new RegExp(fx.sandbox));
    assert.ok(alive(pid), 'the fault holds: the helper is still running');
  });
}

test('after HELD: a helper stopped during release is ended within the bound and the gate is free', async () => {
  const gate = new SessionGate(gatePath(fx), FAST);
  const reservation = await gate.reserve('ignore');
  assert.ok('held' in reservation);
  const pid = reservation.held.pid;
  process.kill(pid, 'SIGSTOP');
  const result = await timed(reservation.held.release());
  assert.ok(result.ms < BOUND_MS, `${result.ms} ms`);
  assert.equal(result.error, undefined);
  assert.ok(await exited(pid));
  assert.deepEqual(await gate.holders(), []);
  assert.equal((await invocations(fx)).length, 0, 'no target process started');
  const next = await gate.reserve('ignore');
  assert.ok('held' in next, 'free again after verified cleanup');
  await next.held.release();
});

test('after EXECFAIL: a lingering helper is stopped within the bound; the non-start stands', async () => {
  const failing = await fakeHelper('execfail-stuck', "echo HELD >&3\nread request <&3\necho 'EXECFAIL No such file or directory' >&3\nexec sleep 600");
  const reservation = await new SessionGate(gatePath(fx), { ...FAST, python: failing.path }).reserve('ignore');
  assert.ok('held' in reservation);
  const result = await timed(reservation.held.launch({ executable: '/no/such/program', args: [], cwd: fx.sandbox, env: {} }));
  assert.ok(result.ms < BOUND_MS, `${result.ms} ms`);
  assert.equal(result.error?.code, 'runner_unavailable');
  assert.match(result.error!.message, /^Claude Code could not be started \(No such file or directory\)\.$/);
  assert.ok(await exited(await failing.pid()));
});

test('when release cannot be shown complete it fails closed: the gate stays busy and no session starts', async () => {
  // The helper is stopped and cannot be ended (signals are not delivered here, as with a process stuck in the kernel).
  const gate = new SessionGate(gatePath(fx), { ...FAST, signal: () => undefined });
  const reservation = await gate.reserve('ignore');
  assert.ok('held' in reservation);
  const pid = reservation.held.pid;
  leftovers.push(pid);
  process.kill(pid, 'SIGSTOP');
  const result = await timed(reservation.held.release());
  assert.ok(result.ms < BOUND_MS, `${result.ms} ms`);
  assert.equal(result.error?.code, 'gate_unresponsive');
  assert.match(result.error!.message, new RegExp(`\\(pid ${pid}\\) did not end within 1 s after its release and could not be shown to have stopped; it may still hold the session gate`));
  assert.deepEqual(await gate.holders(), [pid]);
  // Nobody else gets the gate, and SF-006 refuses before any claim.
  const other = await new SessionGate(gatePath(fx)).reserve('ignore');
  assert.ok('busy' in other && other.holderPids.includes(pid));
  git(fx.appRepo, 'reset', '-q', '--hard');
  await acceptedJob(fx, 'job-while-uncertain');
  await fixtureService(fx).prepare(fx.app, 'job-while-uncertain');
  await assert.rejects(fixtureService(fx).run(fx.app, 'job-while-uncertain', async () => true), { code: 'session_busy' });
  await assert.rejects(readFile(join(jobDir(fx, 'job-while-uncertain'), 'launch.claim')), { code: 'ENOENT' });
  assert.equal((await invocations(fx)).length, 0);
});

test('SF-006 run with an unresponsive helper: refused before launch.claim, the job stays prepared, nothing starts', async () => {
  git(fx.appRepo, 'reset', '-q', '--hard');
  git(fx.appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
  await acceptedJob(fx, 'job-unresponsive');
  await fixtureService(fx).prepare(fx.app, 'job-unresponsive');
  const silent = await fakeHelper('silent-run', 'exec sleep 600');
  const service = new ExecutionService({
    mediatorRoot: fx.mediator,
    receiverLookup: (requestId) => fileReceiver(fx.receiverDir, requestId),
    runner: new ProcessClaudeRunner(join(fx.fakeDir, 'claude'), 'fake 0.0.0', 'ignore', new SessionGate(gatePath(fx), { ...FAST, python: silent.path })),
    claudeProjectsDir: fx.projects,
    claudeConfigDir: fx.claudeConfigDir,
    authStatus: async () => ({ loggedIn: true, method: 'fake' }),
    insideClaudeSession: false,
  });
  const result = await timed(service.run(fx.app, 'job-unresponsive', async () => true));
  assert.ok(result.ms < BOUND_MS + 2_000, `${result.ms} ms`);
  assert.equal(result.error?.code, 'gate_unresponsive');
  await assert.rejects(readFile(join(jobDir(fx, 'job-unresponsive'), 'launch.claim')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(jobDir(fx, 'job-unresponsive'), 'execution.json'), 'utf8')).state, 'prepared');
  assert.equal((await invocations(fx)).length, 0);
  assert.ok(await exited(await silent.pid()));
  // Positive controls with the real helper: a successful exec, and an immediate target exit.
  const launch = await new SessionGate(gatePath(fx)).reserve('ignore');
  assert.ok('held' in launch);
  const session = await launch.held.launch({ executable: '/bin/sleep', args: ['0.3'], cwd: fx.sandbox, env: {} });
  assert.deepEqual(await session.exited, { code: 0, signal: null });
  const quick = await new SessionGate(gatePath(fx)).reserve('ignore');
  assert.ok('held' in quick);
  await quick.held.launch({ executable: '/bin/true', args: [], cwd: fx.sandbox, env: {} }).then(
    async (launched) => assert.deepEqual(await launched.exited, { code: 0, signal: null }),
    (error: { code?: string }) => assert.equal(error.code, 'launch_unconfirmed'),
  );
  assert.deepEqual(await new SessionGate(gatePath(fx)).holders(), []);
});
