// SF-009 Review 03, R3-3 (Review 04: R4-1 to R4-3): the operator's protocol probe. These tests run it against the fake
// stream-json Claude only: they prove the probe's mechanics and checks, not the real CLI's
// behaviour (which stays UNVERIFIED until the operator runs the probe).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, test } from 'node:test';
import { ExecutionError } from '../src/execution/errors.js';
import { identify, isAlive } from '../src/execution/process-identity.js';
import { ManagedClaudeRunner, SESSION_TAG, type ClaudeRunner, type SessionExit } from '../src/execution/runner.js';
import { SessionGate } from '../src/execution/session-gate.js';
import { analyzeProbe, probeCommand, probeRefusal, runProtocolProbe, type ProbeEvent, type ProbeReport } from '../src/executor/protocol-probe.js';
import { destroyFixture, gatePath, type Fixture } from './support/operator-fixture.js';
import { createExecutorFixture, setStreamMode, streamClaude } from './support/executor-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

async function setup(mode: string, extra: Record<string, string> = {}): Promise<{ fx: Fixture; dir: string; runner: ManagedClaudeRunner }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await setStreamMode(fx, mode, extra);
  const dir = await mkdtemp(join(tmpdir(), 'sf009-probe-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return { fx, dir, runner: new ManagedClaudeRunner(streamClaude(fx), 'fake 0.0.0', new SessionGate(gatePath(fx))) };
}

const failed = (report: { checks: Array<{ name: string; ok: boolean }> }) => report.checks.filter((check) => !check.ok).map((check) => check.name);

test('a protocol that acknowledges each message with its uuid before its result passes; the report holds no text, path or id', async () => {
  const { fx, dir, runner } = await setup('ok');
  const report = await runProtocolProbe(runner, dir, { mode: 'sequential', turnTimeoutMs: 10_000, exitTimeoutMs: 5000 });
  assert.equal(report.verdict, 'PASS', JSON.stringify(report.checks));
  assert.deepEqual(report.exit, { code: 0, signal: null });
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /ONE|TWO|Done with this round|FAKE-STREAM-STDERR/, 'no message, reply or stderr text');
  assert.ok(!text.includes(dir) && !text.includes(fx.sandbox), 'no path');
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, 'no session id or uuid');
  assert.deepEqual(await new SessionGate(gatePath(fx)).holders(), [], 'the gate is released');
});

test('overlap: the second message sent while the first turn may run; acknowledgments in order pass', async () => {
  const { dir, runner } = await setup('ok');
  const report = await runProtocolProbe(runner, dir, { mode: 'overlap', turnTimeoutMs: 10_000, exitTimeoutMs: 5000 });
  assert.equal(report.verdict, 'PASS', JSON.stringify(report.checks));
});

test('no replay at all fails the acknowledgment checks', async () => {
  const { dir, runner } = await setup('ok', { noReplay: '1' });
  const report = await runProtocolProbe(runner, dir, { mode: 'sequential', turnTimeoutMs: 10_000, exitTimeoutMs: 5000 });
  assert.equal(report.verdict, 'FAIL');
  assert.deepEqual(failed(report).filter((name) => name.startsWith('ack')), ['ack1_exact_uuid', 'ack1_before_first_result', 'ack2_exact_uuid', 'ack2_before_its_result']);
});

test('a result before the second message is acknowledged fails (the case the supervisor bounds as unresolved)', async () => {
  const { dir, runner } = await setup('answer-before-ack');
  const report = await runProtocolProbe(runner, dir, { mode: 'sequential', turnTimeoutMs: 3000, exitTimeoutMs: 5000 });
  assert.equal(report.verdict, 'FAIL');
  assert.ok(failed(report).includes('ack2_before_its_result'), JSON.stringify(report.checks));
});

test('a foreign uuid in place of the acknowledgment fails', async () => {
  const { dir, runner } = await setup('ok', { badReplayAfterFirst: '1' });
  const report = await runProtocolProbe(runner, dir, { mode: 'sequential', turnTimeoutMs: 10_000, exitTimeoutMs: 5000 });
  assert.ok(failed(report).includes('ack2_exact_uuid') && failed(report).includes('no_foreign_acknowledgments'), JSON.stringify(report.checks));
});

test('a busy session gate refuses the probe: nothing is started', async () => {
  const { fx, dir, runner } = await setup('ok');
  const held = await new SessionGate(gatePath(fx)).reserve('pipe');
  assert.ok(!('busy' in held));
  try {
    await assert.rejects(runProtocolProbe(runner, dir, { mode: 'sequential' }), (error: { code?: string }) => error.code === 'session_busy');
  } finally {
    await held.held.release();
  }
});

test('the probe refuses inside a Claude Code or managed session, and outside an empty absolute directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf009-probe-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await probeRefusal(dir, {}), null);
  assert.match((await probeRefusal(dir, { [SESSION_TAG]: randomUUID() })) ?? '', /inside a Claude Code or managed session/);
  assert.match((await probeRefusal(dir, { CLAUDE_CODE_CHILD_SESSION: '1' })) ?? '', /inside a Claude Code or managed session/);
  assert.match((await probeRefusal('relative/dir', {})) ?? '', /absolute/);
  assert.match((await probeRefusal(join(dir, 'missing'), {})) ?? '', /does not exist/);
  await writeFile(join(dir, 'file'), '');
  assert.match((await probeRefusal(dir, {})) ?? '', /must be empty/);
});

// Review 04 (R4-1, R4-2): the analyzer on recorded event lists, independent of any process.
type Step = 'sent1' | 'sent2' | 'ack1' | 'ack2' | 'result' | 'init' | 'closed' | 'exit';
const recorded = (steps: Step[]): ProbeEvent[] =>
  steps.map((step, t): ProbeEvent => {
    if (step === 'sent1' || step === 'sent2') return { t, kind: 'sent', msg: step === 'sent1' ? 1 : 2 };
    if (step === 'ack1' || step === 'ack2') return { t, kind: 'ack', uuid: step === 'ack1' ? 'msg1' : 'msg2' };
    if (step === 'init') return { t, kind: 'init', mode: 'auto' };
    return { t, kind: step } as ProbeEvent;
  });
const clean = { code: 0, signal: null };
const failing = (checks: Array<{ name: string; ok: boolean }>) => checks.filter((check) => !check.ok).map((check) => check.name);
const SEQUENTIAL: Step[] = ['init', 'sent1', 'ack1', 'result', 'sent2', 'ack2', 'result', 'closed', 'exit'];

test('R4-1: sequential passes only for send(1) < ack(1) < result(1) < send(2) < ack(2) < result(2)', () => {
  assert.deepEqual(failing(analyzeProbe('sequential', recorded(SEQUENTIAL), clean, false)), []);
});

test('R4-1: the reviewed counterexample (message 2 sent before result 1) fails the sequential probe', () => {
  const events = recorded(['init', 'sent1', 'ack1', 'sent2', 'ack2', 'result', 'result', 'closed', 'exit']);
  assert.ok(failing(analyzeProbe('sequential', events, clean, false)).includes('result1_before_send2'));
});

test('R4-1: duplicate, missing or misplaced events never let a later result stand in for an answer', () => {
  const cases: Record<string, Step[]> = {
    'a third result': ['init', 'sent1', 'ack1', 'result', 'sent2', 'ack2', 'result', 'result', 'closed', 'exit'],
    'one result only': ['init', 'sent1', 'ack1', 'result', 'sent2', 'ack2', 'closed', 'exit'],
    'a duplicate ack of message 1': ['init', 'sent1', 'ack1', 'result', 'sent2', 'ack1', 'ack2', 'result', 'closed', 'exit'],
    'ack 1 after its result': ['init', 'sent1', 'result', 'ack1', 'sent2', 'ack2', 'result', 'closed', 'exit'],
    'ack 1 before message 1 was sent': ['init', 'ack1', 'sent1', 'result', 'sent2', 'ack2', 'result', 'closed', 'exit'],
    'ack 2 after its result': ['init', 'sent1', 'ack1', 'result', 'sent2', 'result', 'ack2', 'closed', 'exit'],
    'a result before message 1': ['init', 'result', 'sent1', 'ack1', 'sent2', 'ack2', 'result', 'closed', 'exit'],
    'message 2 never sent': ['init', 'sent1', 'ack1', 'result', 'closed', 'exit'],
  };
  for (const [name, steps] of Object.entries(cases)) {
    assert.notDeepEqual(failing(analyzeProbe('sequential', recorded(steps), clean, false)), [], name);
  }
});

test('R4-1: overlap keeps its semantics (message 2 before result 1) but needs two acknowledged messages and two attributable results', () => {
  const overlap: Step[] = ['init', 'sent1', 'sent2', 'ack1', 'ack2', 'result', 'result', 'closed', 'exit'];
  assert.deepEqual(failing(analyzeProbe('overlap', recorded(overlap), clean, false)), []);
  assert.deepEqual(failing(analyzeProbe('overlap', recorded(SEQUENTIAL), clean, false)), [], 'a sequential order is a valid overlap outcome');
  const cases: Record<string, Step[]> = {
    'acks out of order': ['init', 'sent1', 'sent2', 'ack2', 'ack1', 'result', 'result', 'closed', 'exit'],
    'one result for both': ['init', 'sent1', 'sent2', 'ack1', 'ack2', 'result', 'closed', 'exit'],
    'a third result': ['init', 'sent1', 'sent2', 'ack1', 'ack2', 'result', 'result', 'result', 'closed', 'exit'],
    'the second result before ack 2': ['init', 'sent1', 'sent2', 'ack1', 'result', 'result', 'ack2', 'closed', 'exit'],
    'no ack 2': ['init', 'sent1', 'sent2', 'ack1', 'result', 'result', 'closed', 'exit'],
  };
  for (const [name, steps] of Object.entries(cases)) {
    assert.notDeepEqual(failing(analyzeProbe('overlap', recorded(steps), clean, false)), [], name);
  }
});

test('R4-2: only a normal exit with code 0 after the input closed passes the exit check', () => {
  const exitCheck = (exit: { code: number | null; signal: NodeJS.Signals | null } | null, steps = SEQUENTIAL, between = false) =>
    analyzeProbe('sequential', recorded(steps), exit, between).find((check) => check.name === 'exits_after_input_closed')!.ok;
  assert.equal(exitCheck({ code: 0, signal: null }), true);
  assert.equal(exitCheck({ code: 1, signal: null }), false, 'code 1');
  assert.equal(exitCheck({ code: 143, signal: null }), false, 'another nonzero code');
  assert.equal(exitCheck({ code: null, signal: 'SIGTERM' }), false, 'SIGTERM');
  assert.equal(exitCheck({ code: null, signal: 'SIGKILL' }), false, 'SIGKILL');
  assert.equal(exitCheck(null), false, 'unconfirmed exit');
  assert.equal(exitCheck({ code: 0, signal: null }, SEQUENTIAL, true), false, 'dead before message 2');
  assert.equal(exitCheck({ code: 0, signal: null }, ['init', 'sent1', 'ack1', 'result', 'sent2', 'ack2', 'result', 'exit', 'closed']), false, 'exited before its input closed');
  const all = analyzeProbe('sequential', recorded(SEQUENTIAL), { code: 1, signal: null }, false);
  assert.deepEqual(failing(all), ['exits_after_input_closed'], 'the uuid checks alone cannot pass a failed exit');
});

// Review 04: a test-local fake `claude` for the runtime paths. It acknowledges each message with
// its uuid, answers unless `silent`, and exits on EOF unless `stayAfterClose`; with `ignoreTerm`
// it ignores SIGTERM (SIGKILL still ends it), with `exitOnTerm` it exits 0 on SIGTERM. It is the test's own child: nothing else is signalled.
async function fakeClaude(behaviour: { silent?: boolean; stayAfterClose?: boolean; ignoreTerm?: boolean; exitOnTerm?: boolean }): Promise<{ fx: Fixture; dir: string; bin: string; runner: ManagedClaudeRunner }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  const bin = await mkdtemp(join(tmpdir(), 'sf009-probe-bin-'));
  cleanup.push(() => rm(bin, { recursive: true, force: true }));
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const behaviour = ${JSON.stringify(behaviour)};
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
if (behaviour.ignoreTerm) process.on('SIGTERM', () => fs.appendFileSync(path.join(__dirname, 'sigterm'), 'x'));
if (behaviour.exitOnTerm) process.on('SIGTERM', () => process.exit(0));
fs.writeFileSync(path.join(__dirname, 'pid'), String(process.pid));
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  const msg = JSON.parse(raw);
  fs.appendFileSync(path.join(__dirname, 'messages.log'), 'message\\n');
  out({ type: 'user', message: msg.message, uuid: msg.uuid, isReplay: true });
  out({ type: 'system', subtype: 'init', permissionMode: 'auto' });
  if (!behaviour.silent) out({ type: 'result', subtype: 'success', is_error: false });
});
rl.on('close', () => (behaviour.stayAfterClose ? setInterval(() => undefined, 1000) : process.exit(0)));
`;
  await writeFile(join(bin, 'claude'), script, { mode: 0o755 });
  const dir = await mkdtemp(join(tmpdir(), 'sf009-probe-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return { fx, dir, bin, runner: new ManagedClaudeRunner(join(bin, 'claude'), 'fake 0.0.0', new SessionGate(gatePath(fx))) };
}

const sentMessages = async (bin: string) => (await readFile(join(bin, 'messages.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

test('R4-1: no first result within the bound: message 2 is never sent, the verdict is FAIL and the process and gate are cleaned up', async () => {
  const { fx, dir, bin, runner } = await fakeClaude({ silent: true });
  const report = await runProtocolProbe(runner, dir, { mode: 'sequential', turnTimeoutMs: 500, exitTimeoutMs: 5000 });
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.failure?.code, 'first_result_timeout');
  assert.ok(failed(report).includes('first_result_timeout'), JSON.stringify(report.checks));
  assert.equal(report.events.filter((event) => event.kind === 'sent' && event.msg === 2).length, 0, 'no second message recorded');
  assert.equal(await sentMessages(bin), 1, 'the process received one message only');
  assert.equal(report.shutdown, 'exited');
  assert.deepEqual(report.exit, { code: 0, signal: null });
  assert.deepEqual(await new SessionGate(gatePath(fx)).holders(), [], 'the gate is released');
});

test('R4-3: a process that ignores SIGTERM is ended by SIGKILL within the bounds; that is never a PASS', async () => {
  const { fx, dir, bin, runner } = await fakeClaude({ stayAfterClose: true, ignoreTerm: true });
  const report = await runProtocolProbe(runner, dir, { mode: 'sequential', turnTimeoutMs: 10_000, exitTimeoutMs: 300, termWaitMs: 300, killWaitMs: 5000 });
  assert.equal(report.shutdown, 'sigkill');
  assert.deepEqual(report.exit, { code: null, signal: 'SIGKILL' });
  assert.equal(report.verdict, 'FAIL');
  assert.deepEqual(failed(report), ['exits_after_input_closed'], 'every protocol check passed, the exit did not');
  assert.ok((await readFile(join(bin, 'sigterm'), 'utf8')).length > 0, 'SIGTERM was delivered first');
  assert.deepEqual(await new SessionGate(gatePath(fx)).holders(), [], 'the gate is released once the process is gone');
});

test('R4-2/R4-3: a process that exits with code 0 only on SIGTERM is not a PASS', async () => {
  const { fx, dir, runner } = await fakeClaude({ stayAfterClose: true, exitOnTerm: true });
  const report = await runProtocolProbe(runner, dir, { mode: 'sequential', turnTimeoutMs: 10_000, exitTimeoutMs: 300, termWaitMs: 5000, killWaitMs: 5000 });
  assert.equal(report.shutdown, 'sigterm');
  assert.deepEqual(report.exit, { code: 0, signal: null });
  assert.equal(report.verdict, 'FAIL');
  assert.deepEqual(failed(report), ['exits_after_input_closed'], JSON.stringify(report.checks));
  assert.deepEqual(await new SessionGate(gatePath(fx)).holders(), [], 'the gate is released once the process is gone');
});

// A simulated managed process (no real process): it answers like the fake, never exits, and every
// signal goes to the injected control, so nothing on the host is signalled.
function simulatedRunner(onLaunch?: () => never, onRelease?: () => never, silent = false, brokenEnd = false): { runner: ClaudeRunner; released: () => number } {
  let releases = 0;
  const runner: ClaudeRunner = {
    identity: 'simulated 0.0.0',
    available: async () => true,
    gateHolders: async () => [],
    gatedCommand: async (command) => [...command],
    reserve: async () => ({
      holderPid: 1,
      launch: async () => {
        throw new Error('unused');
      },
      launchManaged: async () => {
        onLaunch?.();
        const output = new PassThrough();
        const input = new Writable({
          write(chunk, _encoding, callback) {
            const msg = JSON.parse(String(chunk)) as { uuid: string };
            output.write(`${JSON.stringify({ type: 'user', uuid: msg.uuid })}\n${JSON.stringify({ type: 'system', subtype: 'init', permissionMode: 'auto' })}\n`);
            if (!silent) output.write(`${JSON.stringify({ type: 'result', subtype: 'success' })}\n`);
            callback();
          },
        });
        if (brokenEnd) {
          input.end = () => {
            throw new Error('simulated end failure');
          };
        }
        return { pid: 2_000_000_000, exited: new Promise<SessionExit>(() => undefined), input, output, errors: new PassThrough() };
      },
      release: async () => {
        releases += 1;
        onRelease?.();
      },
    }),
  };
  return { runner, released: () => releases };
}

const STUCK = { turnTimeoutMs: 2000, exitTimeoutMs: 100, termWaitMs: 100, killWaitMs: 100 };

const simulatedControl = (alive: boolean, kill: (pid: number, signal: NodeJS.Signals) => void) => ({
  identify: async (pid: number) => ({ pid, pid_start: '1', boot_id: 'simulated' }),
  isAlive: async () => alive,
  kill,
});

test('R4-3: a process that survives SIGTERM and SIGKILL reaches the final deadline: gate_unresponsive, the gate is not released', async () => {
  const { runner, released } = simulatedRunner();
  const signals: string[] = [];
  const started = Date.now();
  const report = await runProtocolProbe(runner, '/nonexistent', {
    mode: 'sequential', ...STUCK,
    processControl: simulatedControl(true, (_pid, signal) => void signals.push(signal)),
  });
  assert.ok(Date.now() - started < 5000, 'bounded');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(report.shutdown, 'unconfirmed');
  assert.equal(report.exit, null);
  assert.equal(report.failure?.code, 'gate_unresponsive');
  assert.equal(report.verdict, 'FAIL');
  assert.equal(released(), 0, 'never released on uncertain liveness');
});

test('R4-3: a pid that no longer has the child identity, or a refused signal, is never signalled further (fail closed)', async () => {
  const reused = simulatedRunner();
  const none: string[] = [];
  const first = await runProtocolProbe(reused.runner, '/nonexistent', {
    mode: 'sequential', ...STUCK,
    processControl: simulatedControl(false, (_pid, signal) => void none.push(signal)),
  });
  assert.deepEqual(none, [], 'no signal to a pid that is not the verified child');
  assert.equal(first.failure?.code, 'gate_unresponsive');
  assert.equal(reused.released(), 0);

  const refused = simulatedRunner();
  const attempts: string[] = [];
  const second = await runProtocolProbe(refused.runner, '/nonexistent', {
    mode: 'sequential', ...STUCK,
    processControl: simulatedControl(true, (_pid, signal) => {
      attempts.push(signal);
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    }),
  });
  assert.deepEqual(attempts, ['SIGTERM'], 'EPERM stops the escalation');
  assert.equal(second.failure?.code, 'gate_unresponsive');
  assert.equal(refused.released(), 0);
});

test('R4-3: launchManaged throwing hands the reservation back to the gate helper and reports the launch error', async () => {
  const { runner, released } = simulatedRunner(() => {
    throw new ExecutionError('launch_unconfirmed', 'simulated');
  });
  await assert.rejects(runProtocolProbe(runner, '/nonexistent', { mode: 'sequential' }), (error: { code?: string }) => error.code === 'launch_unconfirmed');
  assert.equal(released(), 1, 'the gate helper decides (a used reservation keeps the gate with what it launched)');
});

test('R4-3: launchManaged throwing and the release failing too is reported as gate_unresponsive', async () => {
  const { runner, released } = simulatedRunner(
    () => {
      throw new ExecutionError('launch_unconfirmed', 'simulated launch');
    },
    () => {
      throw new ExecutionError('gate_unresponsive', 'simulated release');
    },
  );
  await assert.rejects(runProtocolProbe(runner, '/nonexistent', { mode: 'sequential' }), (error: { code?: string; message?: string }) => error.code === 'gate_unresponsive' && /simulated launch/.test(error.message ?? '') && /simulated release/.test(error.message ?? ''));
  assert.equal(released(), 1);
});

test('R4-1/R4-3: a first-result timeout on a process that then cannot be ended keeps both causes', async () => {
  const { runner, released } = simulatedRunner(undefined, undefined, true);
  const report = await runProtocolProbe(runner, '/nonexistent', { mode: 'sequential', ...STUCK, turnTimeoutMs: 200, processControl: simulatedControl(true, () => undefined) });
  assert.equal(report.failure?.code, 'gate_unresponsive', 'the operator-attention cause comes first');
  assert.ok(failed(report).includes('first_result_timeout') && failed(report).includes('gate_unresponsive'), JSON.stringify(report.checks));
  assert.equal(report.events.filter((event) => event.kind === 'sent' && event.msg === 2).length, 0);
  assert.equal(released(), 0);
});

// Review 04 iteration-002 (finding 1): the operator command on the gate_unresponsive path. A real
// subprocess runs the probe and the command's own end (reportProbe, as main.ts does). The child is a
// test-owned fake that keeps running; the driver's process control never delivers a signal, so the
// child plays a process that survives SIGTERM and SIGKILL. The command must print the coded report and
// return promptly, while the gate stays held by the child until the test itself ends it.
test('R4-3: the operator command reports gate_unresponsive and exits promptly; the child keeps the gate until it really ends', async () => {
  const { fx, dir, bin } = await fakeClaude({ stayAfterClose: true });
  const module = (name: string) => pathToFileURL(join(import.meta.dirname, '..', 'src', ...name.split('/'))).href;
  const driver = `
    import { identify, isAlive } from ${JSON.stringify(module('execution/process-identity.js'))};
    import { ManagedClaudeRunner } from ${JSON.stringify(module('execution/runner.js'))};
    import { SessionGate } from ${JSON.stringify(module('execution/session-gate.js'))};
    import { reportProbe, runProtocolProbe } from ${JSON.stringify(module('executor/protocol-probe.js'))};
    const runner = new ManagedClaudeRunner(${JSON.stringify(join(bin, 'claude'))}, 'fake 0.0.0', new SessionGate(${JSON.stringify(gatePath(fx))}));
    const report = await runProtocolProbe(runner, ${JSON.stringify(dir)}, {
      mode: 'sequential', turnTimeoutMs: 10000, exitTimeoutMs: 200, termWaitMs: 200, killWaitMs: 200,
      processControl: { identify, isAlive, kill: () => undefined },
    });
    process.exitCode = await reportProbe(report);
  `;
  const childPid = async () => Number(await readFile(join(bin, 'pid'), 'utf8'));
  // Ends the fake only if the pid is still the fake (its command line names the test's own bin directory).
  cleanup.push(async () => {
    const pid = await childPid().catch(() => 0);
    if (pid > 0 && (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).includes(bin)) process.kill(pid, 'SIGKILL');
  });
  const command = spawn(process.execPath, ['--input-type=module', '-e', driver], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  command.stdout.on('data', (chunk) => (stdout += chunk));
  command.stderr.on('data', (chunk) => (stderr += chunk));
  const ended = await new Promise<number | null | 'attached'>((resolve) => {
    const timer = setTimeout(() => resolve('attached'), 8000);
    command.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (ended === 'attached') command.kill('SIGKILL');
  assert.equal(ended, 4, `the command must exit by itself with code 4 (stderr: ${stderr.slice(0, 300)})`);
  const report = JSON.parse(stdout) as { verdict: string; shutdown: string; failure?: { code: string } };
  assert.equal(report.failure?.code, 'gate_unresponsive');
  assert.equal(report.shutdown, 'unconfirmed');
  assert.equal(report.verdict, 'FAIL');
  assert.match(stderr, /gate_unresponsive/, 'an operator-visible diagnostic');
  const pid = await childPid();
  const gate = new SessionGate(gatePath(fx));
  assert.ok((await isAlive((await identify(pid))!)), 'the child is still running');
  assert.deepEqual(await gate.holders(), [pid], 'the gate is still held, by the child itself');
  process.kill(pid, 'SIGKILL');
  for (let attempt = 0; attempt < 100 && (await gate.holders()).length > 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await gate.holders(), [], 'the gate is free once the child has actually ended');
});

test('R4-3 (iteration-002): an identity check that throws is never a signal: bounded gate_unresponsive, gate kept', async () => {
  const { runner, released } = simulatedRunner();
  const signals: string[] = [];
  const report = await runProtocolProbe(runner, '/nonexistent', {
    mode: 'sequential', ...STUCK,
    processControl: {
      identify: async (pid) => ({ pid, pid_start: '1', boot_id: 'simulated' }),
      isAlive: async () => {
        throw new Error('simulated /proc failure');
      },
      kill: (_pid, signal) => void signals.push(signal),
    },
  });
  assert.deepEqual(signals, [], 'no signal to a process whose identity could not be checked');
  assert.equal(report.shutdown, 'unconfirmed');
  assert.equal(report.failure?.code, 'gate_unresponsive');
  assert.equal(report.verdict, 'FAIL');
  assert.equal(released(), 0);
});

test('R4-3 (iteration-002): an input that throws on end still runs the bounded shutdown and returns a report', async () => {
  const { runner, released } = simulatedRunner(undefined, undefined, false, true);
  const signals: string[] = [];
  const report = await runProtocolProbe(runner, '/nonexistent', { mode: 'sequential', ...STUCK, processControl: simulatedControl(true, (_pid, signal) => void signals.push(signal)) });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(report.events.some((event) => event.kind === 'closed'));
  assert.equal(report.failure?.code, 'gate_unresponsive');
  assert.equal(released(), 0);
});

// Review 05 (R5-1): the operator command when the probe throws while a process it started may still
// be alive. A real subprocess runs the probe through probeCommand, the boundary main.ts uses, and
// mirrors main.ts's generic rejection handler. The gate helper is a test-owned fake (the gate's
// interpreter seam): it takes the real gate lock and then plays a helper whose hand-over is never
// confirmed, that never answers, or that lingers after EXECFAIL; the gate's signal seam delivers
// nothing, so it plays a helper that cannot be stopped. The command must exit by itself with code 4
// and a diagnostic, while the fake keeps the gate until the test itself ends it.
type Uncertain = 'handover_timeout' | 'release_fails' | 'silent_before_held' | 'execfail_lingers';

async function commandWithLiveHelper(scenario: Uncertain): Promise<{ ended: number | null | 'attached'; ms: number; stdout: string; stderr: string; fake: number; isFake: (pid: number) => Promise<boolean>; gate: SessionGate }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  const bin = await mkdtemp(join(tmpdir(), 'sf009-probe-helper-'));
  cleanup.push(() => rm(bin, { recursive: true, force: true }));
  const dir = await mkdtemp(join(tmpdir(), 'sf009-probe-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const marker = `sf009-r5-fake-${randomUUID()}`;
  const pidFile = join(bin, 'pid');
  // Called as `<python> -I -c <helper> <gate>`: a python process that takes the gate lock itself
  // (so /proc/locks shows its own pid), answers on fd 3 (the control channel) as the scenario says,
  // and then does nothing, keeping the lock and the channel open. Its marker identifies it.
  const steps = {
    handover_timeout: ['HELD', 'read'],
    release_fails: ['HELD', 'read'],
    silent_before_held: [],
    execfail_lingers: ['HELD', 'read', 'EXECFAIL simulated'],
  }[scenario];
  const source = `
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_RDWR)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
with open(${JSON.stringify(pidFile)}, 'w') as f:
    f.write(str(os.getpid()))
for step in ${JSON.stringify(steps)}:
    if step == 'read':
        chunk = b'x'
        while chunk and not chunk.endswith(b'\\n'):
            chunk = os.read(3, 4096)
    else:
        os.write(3, (step + '\\n').encode())
while True:
    time.sleep(1)
`;
  const helper = join(bin, 'python');
  await writeFile(join(bin, 'fake.py'), source);
  await writeFile(helper, `#!/bin/sh\nexec python3 -I '${join(bin, 'fake.py')}' "$4" ${marker}\n`, { mode: 0o755 });
  // Ends the fake only while its pid still runs the fake's command line (its unique marker).
  const fakePid = async () => Number(await readFile(pidFile, 'utf8').catch(() => '0'));
  const isFake = async (pid: number) => pid > 0 && (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0').includes(marker);
  cleanup.push(async () => {
    const pid = await fakePid();
    if (await isFake(pid)) process.kill(pid, 'SIGKILL');
  });
  const module = (name: string) => pathToFileURL(join(import.meta.dirname, '..', 'src', ...name.split('/'))).href;
  const driver = `
    import { ExecutionError } from ${JSON.stringify(module('execution/errors.js'))};
    import { ManagedClaudeRunner } from ${JSON.stringify(module('execution/runner.js'))};
    import { SessionGate } from ${JSON.stringify(module('execution/session-gate.js'))};
    import { probeCommand, runProtocolProbe } from ${JSON.stringify(module('executor/protocol-probe.js'))};
    const gate = new SessionGate(${JSON.stringify(gatePath(fx))}, { python: ${JSON.stringify(helper)}, handshakeTimeoutMs: 500, handoverTimeoutMs: 500, exitWaitMs: 300, signal: () => undefined });
    const base = new ManagedClaudeRunner(${JSON.stringify(join(bin, 'claude'))}, 'fake 0.0.0', gate);
    const runner = ${scenario === 'release_fails'} ? {
      identity: base.identity,
      available: () => base.available(),
      gateHolders: () => base.gateHolders(),
      gatedCommand: (command) => base.gatedCommand(command),
      reserve: async () => {
        const reservation = await base.reserve();
        if ('busy' in reservation) return reservation;
        return { ...reservation, release: async () => {
          await reservation.release();
          throw new ExecutionError('gate_unresponsive', 'simulated release failure');
        } };
      },
    } : base;
    // As main.ts: the probe branch, then its generic rejection handler.
    probeCommand(() => runProtocolProbe(runner, ${JSON.stringify(dir)}, { mode: 'sequential' })).then(
      (code) => { process.exitCode = code; },
      (error) => { console.error('sf009-executor: ' + (error.code ?? 'unexpected') + ': ' + error.message); process.exitCode = 1; },
    );
  `;
  const started = Date.now();
  const command = spawn(process.execPath, ['--input-type=module', '-e', driver], { stdio: ['ignore', 'pipe', 'pipe'] });
  // The driver is the test's own child: always collected, whatever the outcome.
  cleanup.push(async () => {
    if (command.exitCode === null && command.signalCode === null) {
      command.kill('SIGKILL');
      await new Promise((resolve) => command.once('exit', resolve));
    }
  });
  let stdout = '';
  let stderr = '';
  command.stdout.on('data', (chunk) => (stdout += chunk));
  command.stderr.on('data', (chunk) => (stderr += chunk));
  const ended = await new Promise<number | null | 'attached'>((resolve) => {
    const timer = setTimeout(() => resolve('attached'), 8000);
    command.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const ms = Date.now() - started;
  const fake = await fakePid();
  assert.ok(await isFake(fake), 'the fake helper ran and is still the fake');
  return { ended, ms, stdout, stderr, fake, isFake, gate: new SessionGate(gatePath(fx)) };
}

for (const [scenario, code] of [
  ['handover_timeout', 'launch_unconfirmed'],
  ['release_fails', 'gate_unresponsive'],
  ['silent_before_held', 'gate_unresponsive'],
  ['execfail_lingers', 'gate_unresponsive'],
] as const) {
  test(`R5-1: a probe that throws ${code} (${scenario}) while the helper lives: the command exits by itself with 4; the helper keeps the gate`, async () => {
    const run = await commandWithLiveHelper(scenario);
    assert.equal(run.ended, 4, `the command must exit by itself with code 4 (stderr: ${run.stderr.slice(0, 400)})`);
    assert.ok(run.ms < 5000, `exited within the bound (${run.ms} ms)`);
    assert.equal(run.stdout, '', 'no report, never a PASS');
    assert.match(run.stderr, new RegExp(`^sf009-executor: ${code}: `));
    assert.match(run.stderr, /exits with code 4 without releasing the session gate or signalling anything/);
    assert.doesNotMatch(run.stderr, /PASS/);
    assert.doesNotMatch(run.stderr.split('\n')[0]!, /free again/, 'no free gate claimed while the fake holds it');
    assert.deepEqual(await run.gate.holders(), [run.fake], 'the gate is still held, by the fake helper itself');
    assert.ok(await run.isFake(run.fake), 'still the fake (its marker) right before the test ends it');
    process.kill(run.fake, 'SIGKILL');
    for (let attempt = 0; attempt < 100 && (await run.gate.holders()).length > 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await run.gate.holders(), [], 'the gate is free once the fake has actually ended');
  });
}

test('R5-1: the command boundary keeps 0 for PASS and 3 for FAIL, and leaves any other error to the generic handler', async () => {
  const exits: number[] = [];
  const exit = ((code: number) => {
    exits.push(code);
    throw new Error('exit');
  }) as (code: number) => never;
  const report = (verdict: 'PASS' | 'FAIL'): ProbeReport => ({ schema: 'software-factory.protocol-probe/v1', mode: 'sequential', runner: 'fake', events: [], exit: { code: 0, signal: null }, exited_between_turns: false, shutdown: 'exited', checks: [], verdict });
  const stdout = process.stdout.write;
  process.stdout.write = ((_chunk: unknown, callback?: () => void) => (callback?.(), true)) as typeof process.stdout.write;
  try {
    assert.equal(await probeCommand(async () => report('PASS'), exit), 0);
    assert.equal(await probeCommand(async () => report('FAIL'), exit), 3);
    for (const code of ['session_busy', 'runner_unavailable', 'io_failed'] as const) {
      await assert.rejects(probeCommand(async () => Promise.reject(new ExecutionError(code, 'x')), exit), { code });
    }
  } finally {
    process.stdout.write = stdout;
  }
  assert.deepEqual(exits, [], 'no explicit exit outside the uncertain-liveness cases');
});

test('R5-1: a launch that is confirmed not started (the helper ended) is still runner_unavailable, the gate free', async () => {
  const { runner, released } = simulatedRunner(() => {
    throw new ExecutionError('runner_unavailable', 'simulated non-start');
  });
  await assert.rejects(runProtocolProbe(runner, '/nonexistent', { mode: 'sequential', processControl: { identify: async () => undefined, isAlive: async () => false, kill: () => undefined } }), { code: 'runner_unavailable' });
  assert.equal(released(), 1);
});

test('R5-1: the operator command\'s probe branch goes through probeCommand (the boundary the subprocess tests drive)', async () => {
  const main = await readFile(join(import.meta.dirname, '..', 'src', 'executor', 'main.js'), 'utf8');
  assert.match(main, /return probeCommand\(\(\) => runProtocolProbe\(runner, /);
  assert.doesNotMatch(main, /reportProbe/, 'no second path that could bypass the boundary');
});
