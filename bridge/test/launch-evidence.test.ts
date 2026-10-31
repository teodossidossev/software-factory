// SF-007 Review 02, R2-1: the launch-evidence contract of the session gate.
// A launch is confirmed only when the gate helper's process is seen running
// another program after its control channel closed (execve() switches the
// program image before it closes close-on-exec descriptors). An explicit
// EXECFAIL is a confirmed non-start. A helper gone before the hand-over can be
// confirmed (killed, crashed, or a target that ended at once) is indeterminate:
// SF-006 records it as needs_inspection / launch_unconfirmed, keeps launch.claim,
// never retries, and the gate is free again. No real Claude is run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import type { ClaudeRunner, ReservedLaunch } from '../src/execution/runner.js';
import { ProcessClaudeRunner } from '../src/execution/runner.js';
import { ExecutionService } from '../src/execution/service.js';
import { handoverEvidence, helperIdentity, SessionGate } from '../src/execution/session-gate.js';
import { acceptedJob, createFixture, destroyFixture, fileReceiver, fixtureService, gatePath, git, invocations, jobDir, setMode, type Fixture } from './support/operator-fixture.js';
import { liveProcesses } from './support/pty.js';

let fx: Fixture;

before(async () => {
  fx = await createFixture();
});

after(async () => {
  await destroyFixture(fx);
});

afterEach(async () => {
  for (const pid of await liveProcesses(join(fx.fakeDir, 'claude'))) process.kill(pid, 'SIGKILL');
  for (let attempt = 0; attempt < 100 && (await gate().holders()).length > 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
});

const gate = () => new SessionGate(gatePath(fx));
const target = (executable: string, args: string[] = []) => ({ executable, args, cwd: fx.sandbox, env: { PATH: process.env.PATH } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function held() {
  const reservation = await gate().reserve('ignore');
  assert.ok('held' in reservation, 'the gate is free');
  return reservation.held;
}

test('the helper killed or ended after HELD and before exec: unconfirmed, nothing runs, the gate is free', async () => {
  const marker = join(fx.sandbox, 'target-ran');
  const script = join(fx.sandbox, 'target.sh');
  await writeFile(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  for (const signal of ['SIGKILL', 'SIGTERM'] as const) {
    const holder = await held();
    process.kill(holder.pid, signal);
    await sleep(200);
    await assert.rejects(holder.launch(target(script)), (error: { code?: string; message: string }) => {
      assert.equal(error.code, 'launch_unconfirmed', signal);
      assert.match(error.message, /before its hand-over to Claude Code could be confirmed; whether Claude Code started is unknown/);
      return true;
    });
    assert.deepEqual(await gate().holders(), [], `${signal}: gate released`);
    await assert.rejects(readFile(marker), { code: 'ENOENT' }, `${signal}: the target never ran`);
  }
  // Killed after the request was written but before it could exec (stopped, then killed).
  const stopped = await held();
  process.kill(stopped.pid, 'SIGSTOP');
  const launching = stopped.launch(target(script));
  await sleep(200);
  process.kill(stopped.pid, 'SIGKILL');
  await assert.rejects(launching, { code: 'launch_unconfirmed' });
  assert.deepEqual(await gate().holders(), []);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  // The control channel closed from the adapter's side without a launch (e.g. it is shutting down): released, not a launch.
  const holder = await held();
  await holder.release();
  await assert.rejects(holder.launch(target(script)), { code: 'wrong_state' });
  assert.deepEqual(await gate().holders(), []);
});

test('an explicit EXECFAIL is a confirmed non-start, also when the helper is interrupted before exec', async () => {
  const missing = await held();
  await assert.rejects(missing.launch(target(join(fx.sandbox, 'no-such-program'))), (error: { code?: string; message: string }) => {
    assert.equal(error.code, 'runner_unavailable');
    assert.match(error.message, /could not be started \(No such file or directory\)/);
    return true;
  });
  assert.deepEqual(await gate().holders(), []);
  // SIGINT while it waits for the request: the helper reports EXECFAIL instead of dying silently.
  const interrupted = await held();
  process.kill(interrupted.pid, 'SIGINT');
  await sleep(200);
  await assert.rejects(interrupted.launch(target('/bin/sleep', ['1'])), { code: 'runner_unavailable' });
  assert.deepEqual(await gate().holders(), []);
});

test('a hand-over that never happens is reported within the timeout; the helper is not killed and keeps the gate', async () => {
  const quickGate = new SessionGate(gatePath(fx), { handoverTimeoutMs: 500 });
  const reservation = await quickGate.reserve('ignore');
  assert.ok('held' in reservation);
  const pid = reservation.held.pid;
  process.kill(pid, 'SIGSTOP');
  const started = Date.now();
  try {
    await assert.rejects(reservation.held.launch(target('/bin/sleep', ['5'])), (error: { code?: string; message: string }) => {
      assert.equal(error.code, 'launch_unconfirmed');
      assert.match(error.message, new RegExp(`\\(pid ${pid}\\) did not hand over to Claude Code within 1 s\\. It was left running and keeps the session gate`));
      return true;
    });
    assert.ok(Date.now() - started < 5_000);
    // After the request it may be about to become Claude Code: alive, and the gate stays closed.
    process.kill(pid, 0);
    assert.deepEqual(await gate().holders(), [pid]);
    const other = await gate().reserve('ignore');
    assert.ok('busy' in other);
  } finally {
    process.kill(pid, 'SIGKILL');
  }
});

test('the evidence check: a live helper that did not exec is undetermined; a reused pid or an exited process is gone', async () => {
  // A stand-in for a helper that is alive but has not exec'd: same interpreter, the helper's marker in its arguments.
  const python = spawn('python3', ['-I', '-c', 'import time  # fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\ntime.sleep(10)'], { stdio: 'ignore' });
  await sleep(300);
  const identity = (await helperIdentity(python.pid!))!;
  const started = Date.now();
  assert.equal(await handoverEvidence(identity, () => false), 'undetermined');
  assert.ok(Date.now() - started < 5_000, 'bounded');
  // The same pid with another start time is another process.
  assert.equal(await handoverEvidence({ ...identity, start: `${identity.start}9` }, () => false), 'gone');
  python.kill('SIGKILL');
  await new Promise((resolve) => python.once('exit', resolve));
  assert.equal(await handoverEvidence(identity, () => true), 'gone');
});

test('a normal session is confirmed and holds the gate; an immediate exit is never reported as a helper failure', async () => {
  const normal = await held();
  const launched = await normal.launch(target('/bin/sleep', ['1']));
  assert.equal(launched.pid, normal.pid, 'the target replaced the helper in place');
  assert.deepEqual(await gate().holders(), [launched.pid]);
  assert.deepEqual(await launched.exited, { code: 0, signal: null });
  assert.deepEqual(await gate().holders(), []);
  // A target that ends soon after starting is confirmed and its exit observed.
  const soon = await held();
  const brief = await soon.launch(target('/bin/sleep', ['0.3']));
  assert.deepEqual(await brief.exited, { code: 0, signal: null });
  // /bin/true ends within microseconds: confirmed if it was still seen, otherwise honestly unconfirmed.
  for (let round = 0; round < 10; round += 1) {
    const quick = await held();
    await quick.launch(target('/bin/true')).then(
      async (result) => assert.deepEqual(await result.exited, { code: 0, signal: null }),
      (error: { code?: string }) => assert.equal(error.code, 'launch_unconfirmed'),
    );
    assert.deepEqual(await gate().holders(), []);
  }
});

// The fixture runner, with a fault injected between taking the gate and the launch.
function faultyService(fault: (reserved: ReservedLaunch) => Promise<void>): ExecutionService {
  const inner = new ProcessClaudeRunner(join(fx.fakeDir, 'claude'), 'fake 0.0.0', 'ignore', gate());
  const runner: ClaudeRunner = {
    identity: inner.identity,
    available: () => inner.available(),
    gateHolders: () => inner.gateHolders(),
    gatedCommand: (command) => inner.gatedCommand(command),
    async reserve() {
      const reservation = await inner.reserve();
      if ('busy' in reservation) return reservation;
      return { ...reservation, launch: async (request) => (await fault(reservation), reservation.launch(request)) };
    },
  };
  return new ExecutionService({
    mediatorRoot: fx.mediator,
    receiverLookup: (requestId) => fileReceiver(fx.receiverDir, requestId),
    runner,
    claudeProjectsDir: fx.projects,
    claudeConfigDir: fx.claudeConfigDir,
    authStatus: async () => ({ loggedIn: true, method: 'fake' }),
    insideClaudeSession: false,
  });
}

async function prepared(job: string): Promise<void> {
  git(fx.appRepo, 'reset', '-q', '--hard');
  git(fx.appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
  await acceptedJob(fx, job);
  await fixtureService(fx).prepare(fx.app, job);
}

const claimed = (job: string) =>
  readFile(join(jobDir(fx, job), 'launch.claim')).then(
    () => true,
    () => false,
  );
const record = async (job: string) => JSON.parse(await readFile(join(jobDir(fx, job), 'execution.json'), 'utf8'));

test('SF-006 run: a helper killed before the hand-over is needs_inspection / launch_unconfirmed, claimed for good, never retried', async () => {
  await setMode(fx, 'ok');
  await prepared('job-unconfirmed');
  const result = await faultyService(async (reserved) => {
    process.kill(reserved.holderPid, 'SIGKILL');
    await sleep(200);
  }).run(fx.app, 'job-unconfirmed', async () => true);
  assert.equal(result.state, 'needs_inspection');
  assert.equal(result.error?.code, 'launch_unconfirmed');
  assert.match(result.recovery ?? '', /never launches again/);
  const saved = await record('job-unconfirmed');
  assert.equal(saved.state, 'needs_inspection');
  assert.equal(saved.completion, null);
  assert.notEqual(saved.session.ended_at, null);
  assert.equal(await claimed('job-unconfirmed'), true);
  assert.equal((await invocations(fx)).filter((call) => call.argv.at(-1)!.includes('/job-unconfirmed/')).length, 0);
  assert.deepEqual(await gate().holders(), []);
  assert.deepEqual(await liveProcesses(join(fx.fakeDir, 'claude')), []);
  // No second attempt under this job id, by any path.
  await assert.rejects(fixtureService(fx).run(fx.app, 'job-unconfirmed', async () => true), { code: 'wrong_state' });
  assert.equal((await fixtureService(fx).collect(fx.app, 'job-unconfirmed', { sessionFinished: true })).state, 'needs_inspection');
  assert.equal(await claimed('job-unconfirmed'), true);
});

test('SF-006 run: an EXECFAIL after the claim is failed / runner_failed, claimed for good; a confirmed launch records its pid', async () => {
  await setMode(fx, 'ok');
  await prepared('job-execfail');
  const fake = join(fx.fakeDir, 'claude');
  const result = await faultyService(async () => {
    await rename(fake, `${fake}.away`);
  }).run(fx.app, 'job-execfail', async () => true);
  await rename(`${fake}.away`, fake);
  assert.deepEqual([result.state, result.error?.code], ['failed', 'runner_failed']);
  assert.equal(await claimed('job-execfail'), true);
  assert.deepEqual(await gate().holders(), []);
  await assert.rejects(fixtureService(fx).run(fx.app, 'job-execfail', async () => true), { code: 'wrong_state' });

  // A confirmed launch records the pid of the Claude process.
  await setMode(fx, 'ok');
  await prepared('job-confirmed');
  const confirmed = await fixtureService(fx).run(fx.app, 'job-confirmed', async () => true);
  assert.equal(confirmed.state, 'completed');
  assert.equal(typeof (await record('job-confirmed')).session.pid, 'number');
});

test('SF-006 run: a confirmed live session whose adapter dies stays running, keeps the gate and is never relaunched', async () => {
  const fixtureJson = join(fx.sandbox, 'fixture.json');
  await writeFile(fixtureJson, JSON.stringify(fx));
  await prepared('job-adapter-dies');
  await setMode(fx, 'hang');
  const adapter = spawn(process.execPath, [new URL('./support/run-fixture.js', import.meta.url).pathname, fixtureJson, 'no', fx.app, 'job-adapter-dies'], { stdio: 'ignore' });
  let claude: number | undefined;
  for (let attempt = 0; attempt < 200 && claude === undefined; attempt += 1) {
    await sleep(50);
    claude = (await liveProcesses(join(fx.fakeDir, 'claude')))[0];
  }
  assert.ok(claude, 'the session started');
  for (let attempt = 0; attempt < 100 && (await record('job-adapter-dies')).session?.pid !== claude; attempt += 1) await sleep(50);
  adapter.kill('SIGKILL');
  await new Promise((resolve) => adapter.once('exit', resolve));
  const saved = await record('job-adapter-dies');
  assert.deepEqual([saved.state, saved.session.pid], ['running', claude]);
  assert.deepEqual(await gate().holders(), [claude]);
  await assert.rejects(fixtureService(fx).run(fx.app, 'job-adapter-dies', async () => true), { code: 'wrong_state' });
  process.kill(claude, 'SIGKILL');
  for (let attempt = 0; attempt < 100 && (await gate().holders()).length > 0; attempt += 1) await sleep(50);
  assert.equal((await fixtureService(fx).collect(fx.app, 'job-adapter-dies', { sessionFinished: false })).state, 'interrupted');
  assert.equal((await invocations(fx)).filter((call) => call.argv.at(-1)!.includes('/job-adapter-dies/')).length, 1);
});
