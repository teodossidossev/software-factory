// The tracking of the sf processes a test starts (SF-114, test/support/children.ts): SIGTERM then
// SIGKILL at the end of a file, the serves found in /proc by their state directory, the guard that
// fails a file whose tests leave a serve running (the fixture test/support/leaky-serve.ts), the
// cleanup when the file's process gets a signal, and a serve that does not refuse failing fast.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stopChildren, strayServes, trackChild } from './support/children.js';
import { CLI, newEnv, processEnv, runCli, temp } from './support/harness.js';

const LEAKY = fileURLToPath(new URL('./support/leaky-serve.js', import.meta.url));
const READY = /listening on http:\/\/127\.0\.0\.1:\d+\/mcp\/<token>$/m;

// Resolves once the child's stdout so far matches, with that output.
function printed(child: ChildProcess, pattern: RegExp, what: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = (chunk: Buffer): void => {
      out += chunk.toString('utf8');
      if (pattern.test(out)) {
        child.stdout!.off('data', onData);
        resolve(out);
      }
    };
    child.stdout!.on('data', onData);
    child.once('exit', (code, signal) => reject(new Error(`exited (${code ?? signal}) before ${what}:\n${out}`)));
  });
}

const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

// Waits up to ms for pid to be gone (a killed process the fixture did not reap is reaped once the
// fixture has ended).
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!gone(pid)) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

// The fixture, compiled, with LEAK=mode and the environment of a plain node run (no node:test
// child context: its output stays readable).
function leaky(mode: 'pass' | 'hang'): { child: ChildProcess; output: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const env: NodeJS.ProcessEnv = { ...process.env, LEAK: mode };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [LEAKY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, output: () => output, exited };
}

// A fixture still running when its test failed: SIGTERM, so its own cleanup stops its serves (they
// are under its temp directory, not this file's), then SIGKILL after 10 s.
async function endFixture(run: { child: ChildProcess; exited: Promise<unknown> }): Promise<void> {
  if (run.child.exitCode !== null || run.child.signalCode !== null) {
    return;
  }
  run.child.kill('SIGTERM');
  const ended = await Promise.race([run.exited.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000))]);
  if (!ended) {
    run.child.kill('SIGKILL');
  }
}

function printedByFixture(output: string): { stray: number; serve: number; temp: string } {
  const stray = /^stray-pid (\d+)$/m.exec(output);
  const serve = /^serve-pid (\d+)$/m.exec(output);
  const dir = /^temp (\/.+)$/m.exec(output);
  assert.ok(stray !== null && serve !== null && dir !== null, output);
  return { stray: Number(stray[1]), serve: Number(serve[1]), temp: dir[1]! };
}

test('stopChildren: SIGTERM, then SIGKILL after the timeout; a serve still running is reported', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready')"], { stdio: ['ignore', 'pipe', 'ignore'] });
  trackChild(child, ['serve']);
  await printed(child, /ready/, 'ready');
  const { leftRunning, survivors } = await stopChildren(200);
  assert.deepEqual(leftRunning, [`sf serve (pid ${child.pid})`]);
  assert.deepEqual(survivors, []);
  assert.equal(child.signalCode, 'SIGKILL');
  assert.throws(() => process.kill(child.pid!, 0), { code: 'ESRCH' });
});

test('stopChildren: a child that obeys SIGTERM ends with it; a child that is no serve is not reported', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  trackChild(child, ['mcp-url', '--redact']);
  await new Promise((resolve) => child.once('spawn', resolve));
  const { leftRunning, survivors } = await stopChildren();
  assert.equal(child.signalCode, 'SIGTERM');
  assert.deepEqual(leftRunning, []);
  assert.deepEqual(survivors, []);
});

test('stopChildren: a tracked child that already exited is in neither list', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  trackChild(child, ['serve']);
  await new Promise((resolve) => child.once('exit', resolve));
  const label = `sf serve (pid ${child.pid})`;
  const { leftRunning, survivors } = await stopChildren();
  assert.ok(!leftRunning.includes(label) && !survivors.includes(label), JSON.stringify({ leftRunning, survivors }));
});

test('strayServes: finds an untracked sf serve by its state directory under the root, and no longer once it ended', async () => {
  const env = await newEnv('stray');
  const child = spawn(process.execPath, [CLI, 'serve'], { env: processEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await printed(child, READY, 'the listening line');
    const found = (await strayServes(temp)).find((entry) => entry.pid === child.pid);
    assert.ok(found !== undefined, 'the serve was not found');
    assert.equal(found.state, env.state);
    assert.match(found.command, new RegExp(`${CLI.replaceAll('/', '\\/').replaceAll('.', '\\.')} serve$`));
    assert.ok(!(await strayServes(join(temp, 'elsewhere'))).some((entry) => entry.pid === child.pid));
  } finally {
    const exited = new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve(undefined) : child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  assert.ok(!(await strayServes(temp)).some((entry) => entry.pid === child.pid));
});

test('the guard fails a test file that leaves serves running, stops them and removes its temp directory', async () => {
  const run = leaky('pass');
  try {
    const { code } = await run.exited;
    const output = run.output();
    assert.equal(code, 1, output);
    assert.match(output, /was still running at the end of the test file/);
    const { stray, serve, temp: leakTemp } = printedByFixture(output);
    assert.ok(gone(serve), `the serve ${serve} still runs`);
    assert.ok(await goneWithin(stray, 5_000), `the detached serve ${stray} still runs`);
    assert.match(output, new RegExp(`pid ${stray} \\(.* serve, SF_STATE_DIR=.*\\) was still running at the end of the test file`));
    assert.equal(existsSync(leakTemp), false, `${leakTemp} is still there`);
  } finally {
    await endFixture(run);
  }
});

test('a signal to the test file\'s process stops its serves and removes its temp directory', async () => {
  const run = leaky('hang');
  try {
    const deadline = Date.now() + 30_000;
    while (!/^temp \/.+$/m.test(run.output())) {
      assert.ok(Date.now() < deadline && run.child.exitCode === null, `the fixture did not start its serves:\n${run.output()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const { stray, serve, temp: leakTemp } = printedByFixture(run.output());
    run.child.kill('SIGTERM');
    const ended = await Promise.race([run.exited.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000))]);
    assert.ok(ended, `the fixture did not end within 10 s of SIGTERM:\n${run.output()}`);
    assert.ok(await goneWithin(serve, 5_000), `the serve ${serve} still runs`);
    assert.ok(await goneWithin(stray, 5_000), `the detached serve ${stray} still runs`);
    assert.equal(existsSync(leakTemp), false, `${leakTemp} is still there`);
  } finally {
    await endFixture(run);
  }
});

test('runCli: a serve that does not refuse is stopped and fails the test after 30 s', { timeout: 60_000 }, async () => {
  const env = await newEnv('no-refusal');
  await assert.rejects(runCli(env, ['serve']), /did not exit within 30 s; a refused start was expected/);
  assert.deepEqual(await strayServes(env.state), []);
});
