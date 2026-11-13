// End-to-end tests of `sf smoke` (SF-090), split from test/live-smoke.test.ts so that no file runs
// near run-tests' per-file limit: the Gate sandbox step (SF-125), through the harness's fake bwrap,
// its socket probe (SF-161), and SF_SANDBOX=off, which skips it and the Sandbox step. The steps of
// a run are test/live-smoke.test.ts's, the Sandbox step test/live-smoke-sandbox.test.ts's; the
// shared helpers are test/support/live-smoke.ts's.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { STEPS } from '../src/live-smoke.js';
import { socketProbeScript } from '../src/smoke-probe.js';
import { bwrapLog, fakeCodex } from './support/harness.js';
import { cleanScripts, onlyChecksDir, smoke, statuses } from './support/live-smoke.js';

test('SF_SANDBOX=off: the Sandbox step is a SKIP that counts as a pass, the last line says the sandbox was not checked, exit 0', async () => {
  const ran = await smoke('smoke-sandbox-off', [], cleanScripts, { SF_SANDBOX: 'off' });
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), STEPS.map((step) => (step === 'Sandbox' || step === 'Gate sandbox' ? 'SKIP' : 'PASS')), ran.stdout);
  assert.equal(ran.rows.get('Gate sandbox')!.detail, 'sandbox off');
  assert.equal(ran.rows.get('Sandbox')!.detail, 'sandbox off');
  assert.match(ran.stdout, /\nsmoke: PASS \(sandbox not checked\), cost \d+\.\d{4} USD, gate 1100 tokens\n$/);
});

test('Gate sandbox (SF-125): the canary read inside the gate\'s wrapper (a bwrap that hides nothing) FAILs the step, the later steps SKIP; the wrapper was the job\'s', async () => {
  const ran = await smoke('smoke-gate-sandbox-open', [], async (env) => {
    await cleanScripts(env);
    await writeFile(join(env.home, 'fake-bwrap.json'), JSON.stringify({ open: true }));
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Gate sandbox')!.detail, 'the gate\'s wrapper let through: cat of the canary env file exited 0, cat of the job\'s job.json under jobs/ exited 0');
  // The three commands, each inside the wrapper of the job's worktree, its iteration directory read-write last.
  // The gate's own runs (sf serve goes on with the job until Cleanup) aside.
  const runs = (await bwrapLog(ran.env)).filter((run) => run.argv[run.argv.indexOf('--') + 1] !== fakeCodex);
  const worktree = join(ran.dir, 'worktrees', 'smoke', 'SMOKE-1');
  const iteration = join(ran.dir, 'state', 'jobs', 'smoke', 'SMOKE-1', 'iterations', '001');
  assert.deepEqual(runs.map((run) => run.argv.slice(run.argv.indexOf('--'))), [
    ['--', 'ls', worktree], ['--', 'cat', join(ran.dir, 'config', 'auth.env')], ['--', 'cat', join(ran.dir, 'state', 'jobs', 'smoke', 'SMOKE-1', 'job.json')],
  ]);
  for (const run of runs) {
    const cut = run.argv.indexOf('--');
    assert.deepEqual(run.argv.slice(cut - 3, cut), ['--bind', iteration, iteration]);
    assert.ok(run.argv.join(' ').includes(`--ro-bind ${worktree} ${worktree}`));
  }
  await onlyChecksDir(ran.tmp);
});

test('Gate sandbox (SF-161): a wrapper without the socket filter (a bwrap that ignores --seccomp) lets the socket probe connect to the smoke\'s abstract socket: the step FAILs; the probe ran as node -e inside the job\'s wrapper, with --seccomp 3', async () => {
  const ran = await smoke('smoke-gate-sandbox-unfiltered', [], async (env) => {
    await cleanScripts(env);
    await writeFile(join(env.home, 'fake-bwrap.json'), JSON.stringify({ unfiltered: true }));
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Gate sandbox')!.detail, 'a Unix socket connected inside the gate\'s wrapper');
  const runs = (await bwrapLog(ran.env)).filter((run) => run.argv[run.argv.indexOf('--') + 1] !== fakeCodex);
  assert.equal(runs.length, 4);
  const probe = runs.at(-1)!.argv;
  const cut = probe.indexOf('--');
  assert.deepEqual(probe.slice(cut + 1, cut + 3), [process.execPath, '-e']);
  assert.match(probe[cut + 3]!, /connect\('\\0sf-smoke-[0-9a-f]{16}'\)/);
  assert.deepEqual(probe.slice(probe.indexOf('--seccomp'), probe.indexOf('--seccomp') + 2), ['--seccomp', '3']);
  await onlyChecksDir(ran.tmp);
});

test('Gate sandbox (SF-125): a canary env file missing outside the wrapper FAILs the step: a hidden one would prove nothing', async () => {
  let removed = false;
  const ran = await smoke('smoke-gate-sandbox-missing', [], cleanScripts, {}, (text) => {
    if (!removed && /^Setup: PASS/m.test(text)) {
      removed = true;
      void rm(join(text.split('\n')[0]!, 'config', 'auth.env'), { force: true });
    }
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Gate sandbox')!.detail, `the canary env file ${join(ran.dir, 'config', 'auth.env')} is missing outside the wrapper`);
});

test('the socket probe (SF-161): connected and exit 0 on an abstract socket that listens; the error\'s code and exit 2 on one nobody listens on', async () => {
  const name = `sf-smoke-${process.pid.toString(16).padStart(16, '0')}`;
  const run = (): { code: number; stdout: string } => {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, ['-e', socketProbeScript(name)], { encoding: 'utf8' }) };
    } catch (error) {
      const failed = error as { status: number; stdout: string };
      return { code: failed.status, stdout: failed.stdout };
    }
  };
  assert.deepEqual(run(), { code: 2, stdout: 'ECONNREFUSED\n' });
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(`\0${name}`, resolve));
  try {
    const connected = await new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile(process.execPath, ['-e', socketProbeScript(name)], { encoding: 'utf8' }, (error, stdout) => resolve({ code: error === null ? 0 : (error.code as number), stdout }));
    });
    assert.deepEqual(connected, { code: 0, stdout: 'connected\n' });
  } finally {
    server.close();
  }
});
