// The workspace's test command (SF-128, src/test-command.ts): the run in a real bubblewrap sandbox
// (pass, fail, a timeout and an abort that leave no process, a parent killed with SIGKILL that leaves
// none either and nothing of its private /tmp on the host, the path denials hidden, no SF_* variable,
// no network but loopback, exit 127, the capped tail), and the text the factory makes of a run. The sandbox tests skip where the real
// bubblewrap cannot start (bubblewrapStarts, test/support/harness.ts); nothing here runs the command outside one.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathDenials } from '../src/sandbox-denials.js';
import {
  bwrapArgs, checksLine, durationText, hiddenMounts, inlineCommand, lastLines, MAX_TESTS_OUTPUT_BYTES, runTestCommand, testEnvironment, type TestsRecord, testsFixContent,
} from '../src/test-command.js';

const SELF = fileURLToPath(import.meta.url);
// The child mode of the SIGKILL test: this file runs one command and waits.
const CHILD = 'SF_TEST_COMMAND_CHILD';

// The pids of the processes whose argv is exactly argv.
async function processesOf(argv: string[]): Promise<number[]> {
  const wanted = `${argv.join('\0')}\0`;
  const pids: number[] = [];
  for (const name of await readdir('/proc')) {
    if (/^\d+$/.test(name) && (await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '')) === wanted) {
      pids.push(Number(name));
    }
  }
  return pids;
}

// Waits until test is true, polling; fails after ms.
async function until(test: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The paths named name under the host's /tmp and temporary directory: a file the run wrote to its
// own /tmp must be in none of them.
function hostCopies(name: string): string[] {
  const found = spawnSync('find', ['/tmp', tmpdir(), '-name', name], { encoding: 'utf8' }).stdout;
  return [...new Set(found.split('\n').filter((line) => line !== ''))];
}

// A sleep only this test starts: its argv names a duration nobody else uses.
const uniqueSleep = (): string[] => ['sleep', String(9_000_000 + Math.floor(Math.random() * 999_999))];

if (process.env[CHILD] !== undefined) {
  // The child: runs the command in its worktree until it is killed.
  const { command, cwd } = JSON.parse(process.env[CHILD]) as { command: string; cwd: string };
  await runTestCommand({ command, cwd, hidden: [], timeoutMs: 600_000, signal: new AbortController().signal });
} else {
  // Imported here, not above: the harness registers before and after hooks, which the child above
  // (a plain node run killed with SIGKILL) must not run.
  const { BWRAP_CANNOT_START, bubblewrapStarts } = await import('./support/harness.js');
  // The tests that run the command in the real bubblewrap: skipped where it cannot start (inside
  // another sandbox).
  const sandboxTest = (name: string, body: () => Promise<void>): void => {
    test(name, { skip: bubblewrapStarts() ? false : BWRAP_CANNOT_START }, body);
  };
  let root: string;
  let worktree: string;

  before(async () => {
    // Outside /tmp, so the private /tmp of a run does not hide it: the hidden mounts must.
    root = await realpath(await mkdtemp(join(dirname(SELF), '.sf128-')));
    worktree = join(root, 'worktree');
    await mkdir(worktree);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = (command: string, extra: Partial<Parameters<typeof runTestCommand>[0]> = {}) =>
    runTestCommand({ command, cwd: worktree, hidden: [], timeoutMs: 60_000, signal: new AbortController().signal, ...extra });

  const recordOf = async (command: string, extra: Partial<Parameters<typeof runTestCommand>[0]> = {}): Promise<TestsRecord> => {
    const result = await run(command, extra);
    assert.equal(result.aborted, false);
    return (result as { record: TestsRecord }).record;
  };

  sandboxTest('a command that exits 0 passed, in the worktree, with its output', async () => {
    const record = await recordOf('pwd; echo out; echo err >&2; touch made.txt');
    assert.equal(record.outcome, 'passed');
    assert.equal(record.exit_code, 0);
    assert.equal(record.timed_out, false);
    assert.equal(record.output, `${worktree}\nout\nerr\n`);
    assert.equal(record.output_truncated, false);
    assert.ok(record.duration_ms >= 0 && Date.parse(record.ended_at) >= Date.parse(record.started_at));
    assert.ok((await stat(join(worktree, 'made.txt'))).isFile());
  });

  sandboxTest('a non-zero exit failed, with its exit code', async () => {
    const record = await recordOf('echo broken; exit 3');
    assert.equal(record.outcome, 'failed');
    assert.equal(record.exit_code, 3);
    assert.equal(record.output, 'broken\n');
  });

  sandboxTest('exit 127 (a command not found) and exit 126 are unavailable, never failed', async () => {
    const missing = await recordOf('no-such-command-sf128');
    assert.equal(missing.outcome, 'unavailable');
    assert.equal(missing.exit_code, 127);
    assert.equal(missing.reason, 'the command was not found (exit 127)');
    const denied = await recordOf('exit 126');
    assert.equal(denied.outcome, 'unavailable');
    assert.equal(denied.reason, 'the command could not be executed (exit 126)');
  });

  sandboxTest('a timeout fails the run and leaves no process of it', async () => {
    const sleep = uniqueSleep();
    const record = await recordOf(`echo before; ${sleep.join(' ')}`, { timeoutMs: 1000 });
    assert.equal(record.outcome, 'failed');
    assert.equal(record.timed_out, true);
    assert.equal(record.exit_code, null);
    assert.equal(record.output, 'before\n');
    await until(async () => (await processesOf(sleep)).length === 0, 'the sleep to end');
  });

  sandboxTest("the controller's abort returns aborted and leaves no process of the run", async () => {
    const sleep = uniqueSleep();
    const controller = new AbortController();
    const result = run(sleep.join(' '), { signal: controller.signal });
    await until(async () => (await processesOf(sleep)).length > 0, 'the sleep to start');
    controller.abort();
    assert.deepEqual(await result, { aborted: true });
    await until(async () => (await processesOf(sleep)).length === 0, 'the sleep to end');
  });

  sandboxTest('a parent killed with SIGKILL leaves no process of the run behind, and nothing of its private /tmp on the host', async () => {
    const sleep = uniqueSleep();
    const marker = `sf128-tmp-${process.pid}-${sleep[1]}`;
    const command = `mkdir /tmp/${marker} && echo x > /tmp/${marker}/file && ${sleep.join(' ')}`;
    const child = spawn(process.execPath, [SELF], { env: { ...process.env, [CHILD]: JSON.stringify({ command, cwd: worktree }) }, stdio: 'ignore' });
    try {
      await until(async () => (await processesOf(sleep)).length > 0, 'the sleep to start');
      child.kill('SIGKILL');
      await until(async () => (await processesOf(sleep)).length === 0, 'the sleep to end after its parent');
    } finally {
      child.kill('SIGKILL');
    }
    // The private /tmp was the sandbox's own tmpfs, gone with it.
    assert.deepEqual(hostCopies(marker), []);
  });

  sandboxTest("the job's path denials are hidden: the env file and sf.sock stand-ins cannot be read or reached; only the worktree and /tmp are writable", async () => {
    const config = join(root, 'config');
    const state = join(root, 'state');
    const worktreeRoot = join(state, 'worktrees');
    const own = join(worktreeRoot, 'app', 'T-1');
    await mkdir(config, { recursive: true });
    await mkdir(own, { recursive: true });
    await writeFile(join(config, 'auth.env'), 'GITHUB_TOKEN=sf128-secret-value\n');
    await writeFile(join(state, 'mcp-token'), 'sf128-token\n');
    const socket = join(state, 'sf.sock');
    const server = createServer();
    // A relative path: the absolute one is longer than a socket's address may be.
    const cwd = process.cwd();
    process.chdir(state);
    try {
      await new Promise<void>((resolve) => server.listen('sf.sock', resolve));
    } finally {
      process.chdir(cwd);
    }
    try {
      const denials = await pathDenials({
        session: 'job', workspace: 'app', checkout: worktree, worktree: own, stateDir: state, worktreeRoot, configDir: config,
        env: { HOME: join(root, 'home'), SF_CONFIG_DIR: config },
      });
      for (const path of [join(config, 'auth.env'), join(state, 'mcp-token'), socket]) {
        assert.ok(denials.sandbox.denyRead.includes(path), path);
      }
      const outside = join(dirname(SELF), `.sf128-probe-${process.pid}`);
      const record = await recordOf([
        `if grep -q sf128 '${join(config, 'auth.env')}' 2>/dev/null; then echo READ-ENV; exit 1; fi`,
        `if [ -n "$(ls -A '${config}' 2>/dev/null)" ]; then echo LISTED-CONFIG; exit 1; fi`,
        `if grep -q sf128 '${join(state, 'mcp-token')}' 2>/dev/null; then echo READ-TOKEN; exit 1; fi`,
        `if [ -S '${socket}' ]; then echo SOCKET; exit 1; fi`,
        // The runtime directory's sockets (the user's D-Bus and systemd manager, the agents) are gone.
        'if [ -n "$(ls -A /run 2>/dev/null)" ]; then echo RUN; exit 1; fi',
        `if touch '${outside}' 2>/dev/null; then echo WROTE-OUTSIDE; exit 1; fi`,
        `touch in-worktree.txt /tmp/in-tmp-${process.pid}.txt || exit 1`,
        'echo ok',
      ].join('\n'), { cwd: own, hidden: denials.sandbox.denyRead });
      await rm(outside, { force: true });
      assert.equal(record.output, 'ok\n', record.output);
      assert.equal(record.outcome, 'passed');
      assert.ok((await stat(join(own, 'in-worktree.txt'))).isFile());
      // The private /tmp went with the run.
      assert.deepEqual(hostCopies(`in-tmp-${process.pid}.txt`), []);
    } finally {
      server.close();
    }
  });

  sandboxTest('the environment is PATH, LANG, CI, HOME, TMPDIR and npm_config_cache only: no SF_* variable reaches the run', async () => {
    process.env.SF_SECRET_SF128 = 'sf128-secret-value';
    try {
      const record = await recordOf(
        `if env | grep -q -e '^SF_' -e sf128-secret; then echo LEAKED; exit 1; fi; [ "$CI" = 1 ] && [ "$TMPDIR" = /tmp ] && [ "$npm_config_cache" = /tmp/npm-cache ] && [ "$HOME" = '${process.env.HOME}' ] && echo ok`,
      );
      assert.equal(record.output, 'ok\n', record.output);
    } finally {
      delete process.env.SF_SECRET_SF128;
    }
  });

  sandboxTest('no network but loopback', async () => {
    await writeFile(join(worktree, 'net-probe.mjs'), [
      "import { createConnection, createServer } from 'node:net';",
      'const server = createServer((socket) => socket.end("hi"));',
      "await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));",
      "const local = await new Promise((resolve) => { const c = createConnection(server.address().port, '127.0.0.1'); c.on('data', () => resolve(true)); c.on('error', () => resolve(false)); });",
      "const remote = await new Promise((resolve) => { const c = createConnection(80, '1.1.1.1'); c.setTimeout(3000, () => { c.destroy(); resolve(false); }); c.on('connect', () => { c.destroy(); resolve(true); }); c.on('error', () => resolve(false)); });",
      'server.close();',
      "console.log(`loopback ${local} remote ${remote}`);",
    ].join('\n'));
    const record = await recordOf(`'${process.execPath}' net-probe.mjs`);
    assert.equal(record.output, 'loopback true remote false\n', record.output);
  });

  sandboxTest('the output kept is its last 64 KiB', async () => {
    const record = await recordOf('i=0; while [ $i -lt 9000 ]; do echo "line $i of the long output"; i=$((i+1)); done; exit 1');
    assert.equal(record.outcome, 'failed');
    assert.equal(record.output_truncated, true);
    assert.ok(Buffer.byteLength(record.output) <= MAX_TESTS_OUTPUT_BYTES, String(Buffer.byteLength(record.output)));
    assert.ok(record.output.endsWith('line 8999 of the long output\n'));
  });

  test('without bwrap on PATH the run is unavailable and nothing runs', async () => {
    const record = await recordOf('touch ran.txt', { env: { PATH: join(root, 'no-such-bin'), HOME: root } });
    assert.equal(record.outcome, 'unavailable');
    assert.equal(record.reason, 'bwrap is not installed');
    assert.equal(record.exit_code, null);
    assert.equal(await stat(join(worktree, 'ran.txt')).then(() => true, () => false), false);
  });

  test('the sandbox: the root read-only, a pid and network namespace that die with the parent, /tmp and the worktree, then the hidden paths over them', () => {
    const args = bwrapArgs({ command: 'npm test', cwd: '/wt', hidden: [{ path: '/cfg', directory: true }, { path: '/state/sf.sock', directory: false }] });
    assert.deepEqual(args, [
      '--die-with-parent', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
      '--tmpfs', '/tmp', '--bind', '/wt', '/wt',
      '--tmpfs', '/cfg', '--remount-ro', '/cfg', '--ro-bind', '/dev/null', '/state/sf.sock', '--chdir', '/wt',
      '--', '/bin/sh', '-c', 'printf started >&3; exec 3>&-; exec /bin/sh -c "$1"', 'sh', 'npm test',
    ]);
  });

  test('the environment keeps nothing of the factory', () => {
    assert.deepEqual(testEnvironment({ PATH: '/bin', LANG: 'en_US.UTF-8', HOME: '/home/u', SF_STATE_DIR: '/s', GITHUB_TOKEN: 'x' }), {
      PATH: '/bin', LANG: 'en_US.UTF-8', CI: '1', HOME: '/home/u', TMPDIR: '/tmp', npm_config_cache: '/tmp/npm-cache',
    });
  });

  test('the hidden mounts: real paths, once, none inside a hidden directory, none holding the worktree, gone ones left out', async () => {
    const dir = join(root, 'hidden');
    await mkdir(join(dir, 'inner'), { recursive: true });
    await writeFile(join(dir, 'inner', 'file'), 'x');
    await writeFile(join(root, 'lone'), 'x');
    assert.deepEqual(await hiddenMounts([join(dir, 'inner', 'file'), dir, join(root, 'lone'), join(root, 'lone'), join(root, 'gone'), root], worktree), [
      { path: join(root, 'lone'), directory: false },
      { path: dir, directory: true },
    ]);
  });

  test('the text of a run: durations, the last lines, the Fix section and the ### Checks lines', () => {
    assert.equal(durationText(12_400), '12 s');
    assert.equal(durationText(120_000), '2 min');
    assert.equal(durationText(252_000), '4 min 12 s');
    assert.equal(durationText(3_900_000), '1 h 5 min');
    assert.equal(lastLines('a\nb\nc\n', 2, 100), 'b\nc');
    assert.equal(lastLines('a\nbbbbbbbbbb', 5, 6), 'bbbbb');
    assert.equal(inlineCommand('npm test &&\n  echo `done`'), '`` npm test && echo `done` ``');
    const base: TestsRecord = {
      command: 'npm test', started_at: '2026-11-07T10:00:00.000Z', ended_at: '2026-11-07T10:04:12.000Z', duration_ms: 252_000,
      exit_code: 1, timed_out: false, outcome: 'failed', output: 'ok 1\n```\nnot ok 2\n', output_truncated: false,
    };
    assert.equal(testsFixContent(base), [
      "The factory ran the workspace's test command on your worktree, in a sandbox without network, and it failed: `npm test`. It exited with 1. Make the tests pass; do not weaken or skip a test to get there.",
      '',
      'The last lines of its output (all of it):',
      '',
      '````text',
      'ok 1\n```\nnot ok 2',
      '````',
    ].join('\n'));
    const long: TestsRecord = { ...base, output: Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n') };
    const fix = testsFixContent(long);
    assert.ok(fix.includes('The last lines of its output:\n'), fix);
    assert.ok(!fix.includes('line 249\n') && fix.includes('line 250\nline 251'), fix);
    assert.ok(Buffer.byteLength(fix) < 13 * 1024);
    assert.ok(testsFixContent({ ...base, timed_out: true, exit_code: null, duration_ms: 1_800_000, output: '' }).includes('It timed out after 30 min and was stopped.'));
    assert.equal(checksLine({ ...base, outcome: 'passed', exit_code: 0 }, 3), '- `npm test`: passed in 4 min 12 s on iteration 3.');
    assert.equal(checksLine({ ...base, outcome: 'accepted_failing', accepted_from: 'failed' }, 3), '- `npm test`: failed (exit 1); accepted by the user without passing tests.');
    assert.equal(checksLine({ ...base, outcome: 'accepted_failing', accepted_from: 'unavailable', exit_code: 127, reason: 'the command was not found (exit 127)' }, 3),
      '- `npm test`: could not run (the command was not found (exit 127)); accepted by the user without tests.');
  });
}
