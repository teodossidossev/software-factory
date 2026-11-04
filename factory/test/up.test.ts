// `sf up` (SF-025): sf serve in the process, the tunnel script as a child with its output
// prefixed, the dashboard opened once with the printed URL, Ctrl+C stopping both; without the
// script, with a script that exits, with --no-tunnel and --no-open; usage errors; `npm start`.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchRaw } from './support/dashboard-client.js';
import { fakeLauncher } from './support/fake-launcher.js';
import { CLI, type Env, newEnv, processEnv, runCli, temp } from './support/harness.js';

const READY = /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/;
const DASHBOARD = /dashboard (http:\/\/127\.0\.0\.1:\d+\/d\/[0-9a-f]{64}\/)/;
// The fake tunnel needs sleep and the launcher only printf: a PATH with the system tools.
const TOOLS = '/usr/bin:/bin';

interface Up {
  child: ChildProcess;
  out(): string;
  err(): string;
  dashboard: string;
  // Waits until the condition holds (5 s), reading the output so far.
  until(condition: () => boolean, what: string): Promise<void>;
  stop(signal?: NodeJS.Signals): Promise<number | null>;
}

// sf up with every byte of its output kept, resolved once serve is listening.
async function spawnUp(env: Env, args: string[]): Promise<Up> {
  const child = spawn(process.execPath, [CLI, 'up', ...args], { env: processEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  const until = async (condition: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}:\n${out}\n${err}`);
      assert.equal(child.exitCode, null, `sf up exited with ${child.exitCode}:\n${out}\n${err}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await until(() => READY.test(out), 'the listening line');
  return {
    child, out: () => out, err: () => err, dashboard: DASHBOARD.exec(out)![1]!, until,
    stop: (signal = 'SIGINT') => new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
        return;
      }
      child.once('exit', (code) => resolve(code));
      child.kill(signal);
    }),
  };
}

// A tunnel script that records its arguments, prints on both streams and waits for SIGTERM;
// or one that fails its check at once.
async function fakeTunnel(name: string, body: string): Promise<{ script: string; log: string }> {
  const dir = join(temp, name);
  await mkdir(dir, { recursive: true });
  const script = join(dir, 'sf-tunnel.sh');
  const log = join(dir, 'tunnel.log');
  await writeFile(script, `#!/bin/sh\necho "args $*" >> '${log}'\n${body}\n`);
  await chmod(script, 0o755);
  return { script, log };
}

const RUNNING = `trap 'echo term >> "$LOG"; exit 0' TERM
echo "sf-tunnel: ok: fake tunnel up"
echo "fake warning" >&2
while :; do sleep 0.2; done`;

test('sf up: serve, the tunnel child with prefixed output, the dashboard opened once; SIGINT stops both', async () => {
  const launcher = await fakeLauncher('up-open', 0);
  const tunnel = await fakeTunnel('up-tunnel', RUNNING.replace('"$LOG"', `'${join(temp, 'up-tunnel', 'tunnel.log')}'`));
  const env = await newEnv('up-ok', { PATH: `${launcher.bin}:${TOOLS}`, SF_TUNNEL_SCRIPT: tunnel.script });
  const up = await spawnUp(env, []);
  try {
    assert.doesNotMatch(up.out(), /auth: /);
    await up.until(() => up.err().includes('tunnel | sf-tunnel: ok: fake tunnel up') && up.err().includes('tunnel | fake warning'), 'the tunnel lines');
    assert.match(await readFile(tunnel.log, 'utf8'), /^args run$/m);
    const deadline = Date.now() + 5_000;
    while ((await launcher.calls()).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(await launcher.calls(), [[up.dashboard]]);
    // Everything serves: the dashboard answers with the printed token.
    assert.equal((await fetchRaw(new URL('api/jobs', up.dashboard))).status, 200);
    assert.doesNotMatch(up.err(), /exited|sf: /);
  } finally {
    assert.equal(await up.stop('SIGINT'), 0, up.err());
  }
  // The tunnel got SIGTERM (its shell runs the trap once the current sleep ends) and its exit was
  // not reported as a failure.
  const deadline = Date.now() + 3_000;
  while (!/^term$/m.test(await readFile(tunnel.log, 'utf8')) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(await readFile(tunnel.log, 'utf8'), /^term$/m);
  assert.doesNotMatch(up.err(), /tunnel \| exited/);
  assert.match(up.out(), /received SIGINT, shutting down/);
  assert.deepEqual(await launcher.calls(), [[up.dashboard]]);
});

test('sf up: a missing script, a script that fails its check and a launcher failure are reported once; serve goes on; --no-tunnel and --no-open', async () => {
  const launcher = await fakeLauncher('up-open-fail', 3);
  // No script at all.
  const missingEnv = await newEnv('up-missing', { PATH: `${launcher.bin}:${TOOLS}`, SF_TUNNEL_SCRIPT: join(temp, 'up-missing', 'nope.sh') });
  const missing = await spawnUp(missingEnv, ['--no-open']);
  try {
    await missing.until(() => missing.err().includes('tunnel | not started'), 'the missing-script line');
    assert.match(missing.err(), new RegExp(`^tunnel \\| not started: ${join(temp, 'up-missing', 'nope.sh')} is missing; the dashboard works without it \\(docs/runbooks/chatgpt-connection\\.md\\)\\.$`, 'm'));
    assert.equal((await fetchRaw(new URL('api/jobs', missing.dashboard))).status, 200);
    assert.deepEqual(await launcher.calls(), []);
  } finally {
    assert.equal(await missing.stop('SIGTERM'), 0);
  }

  // The script's own check fails (no profile): its line, then the exit line, and serve goes on;
  // the launcher fails: the reason, and serve goes on.
  const failing = await fakeTunnel('up-tunnel-fail', 'echo "sf-tunnel: FAIL: profile missing: /x/software-factory.yaml (run: init <tunnel_id>)" >&2\nexit 1');
  const failEnv = await newEnv('up-fail', { PATH: `${launcher.bin}:${TOOLS}`, SF_TUNNEL_SCRIPT: failing.script });
  const failed = await spawnUp(failEnv, []);
  try {
    await failed.until(() => failed.err().includes('tunnel | exited') && failed.err().includes('sf: xdg-open exited with 3'), 'the failure lines');
    assert.match(failed.err(), /^tunnel \| sf-tunnel: FAIL: profile missing: \/x\/software-factory\.yaml \(run: init <tunnel_id>\)$/m);
    assert.match(failed.err(), /^tunnel \| exited \(1\); sf up goes on without it and the dashboard works\. Fix it and run npm run tunnel in another terminal \(docs\/runbooks\/chatgpt-connection\.md\)\.$/m);
    assert.equal(failed.err().split('tunnel | exited').length, 2);
    assert.match(failed.err(), /^sf: xdg-open exited with 3; open the URL above by hand\.$/m);
    assert.deepEqual(await launcher.calls(), [[failed.dashboard]]);
    assert.equal((await fetchRaw(new URL('api/jobs', failed.dashboard))).status, 200);
  } finally {
    assert.equal(await failed.stop(), 0);
  }

  // --no-tunnel: nothing spawned; --no-open: nothing launched.
  const quietEnv = await newEnv('up-quiet', { PATH: `${launcher.bin}:${TOOLS}`, SF_TUNNEL_SCRIPT: failing.script });
  const quiet = await spawnUp(quietEnv, ['--no-tunnel', '--no-open']);
  try {
    await quiet.until(() => quiet.out().includes('tunnel: not started (--no-tunnel)'), 'the no-tunnel line');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(quiet.err(), '');
    assert.deepEqual(await launcher.calls(), [[failed.dashboard]]);
  } finally {
    assert.equal(await quiet.stop(), 0);
  }

  // Usage errors exit 2 before anything starts.
  for (const args of [['up', 'extra'], ['up', '--nope'], ['up', '--no-open=yes']]) {
    const usage = await runCli(quietEnv, args);
    assert.equal(usage.code, 2, args.join(' '));
    assert.match(usage.stderr, /^sf: .*\n\nUsage:/);
  }
  assert.match((await runCli(quietEnv, ['--help'])).stdout, /sf up \[--no-open\] \[--no-tunnel\]/);
});

test('npm start runs sf up', async () => {
  const root = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(root.scripts.start, 'factory/bin/sf up');
  assert.equal(root.scripts.serve, 'factory/bin/sf serve');
  assert.equal(root.scripts.tunnel, 'scripts/sf-tunnel.sh run');
});
