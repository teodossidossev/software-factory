// The test runner behind npm test and npm run test:browser (SF-108, SF-152): each file in a child of
// its own, half the cores at once, at nice 10, a file past SF_TEST_FILE_TIMEOUT_MS killed with every
// process below it, up to three failed files retried once, one at a time (SF-184). main runs here
// with a fake spawn, a fake setPriority and a fake kill over a folder of fake test files, and once
// for real over a file that hangs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CLOSE_GRACE_MS, COMPILE_CACHE_DIR, concurrency, DEFAULT_FILE_TIMEOUT_MS, fileTimeout, killTree, main, marked, niceValue, RUN_MARK, testArgs, type ChildLike, type RunTestsDeps } from '../src/run-tests.js';

type Spawned = { command: string; args: readonly string[]; cwd: string; detached: boolean; env: Record<string, string | undefined> };
type FakeChild = EventEmitter & { pid: number | undefined; stdout: EventEmitter; stderr: EventEmitter; file: string };

const FILES = ['dist/test/a.test.js', 'dist/test/b.test.js', 'dist/test/c.test.js'];
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'sf-run-tests-'));
  await mkdir(join(root, 'dist', 'test', 'browser'), { recursive: true });
  for (const file of [...FILES, 'dist/test/browser/x.test.js', 'dist/test/helper.js']) {
    await writeFile(join(root, file), '');
  }
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

// Fake children: emit what `emit` says for their file on the next tick, after main has attached its
// listeners; emit may return nothing and leave the child running.
function fakeDeps(opts: {
  env?: Record<string, string | undefined>;
  cores?: number;
  pid?: number | undefined;
  root?: string;
  emit: (child: FakeChild) => void;
  setPriority?: (pid: number, priority: number) => void;
  marked?: (mark: string) => number[];
  closeGraceMs?: number;
}) {
  const spawned: Spawned[] = [];
  const children: FakeChild[] = [];
  const priorities: Array<[number, number]> = [];
  const killed: number[] = [];
  const logs: string[] = [];
  const written: string[] = [];
  let nextPid = 4242;
  const deps: RunTestsDeps = {
    spawn: (command, args, options) => {
      spawned.push({ command, args, cwd: options.cwd, detached: options.detached, env: options.env });
      const child: FakeChild = Object.assign(new EventEmitter(), {
        pid: 'pid' in opts ? opts.pid : nextPid++, stdout: new EventEmitter(), stderr: new EventEmitter(), file: args.at(-1)!,
      });
      children.push(child);
      setImmediate(() => opts.emit(child));
      return child as ChildLike;
    },
    setPriority:
      opts.setPriority ??
      ((pid, priority) => {
        priorities.push([pid, priority]);
      }),
    kill: (pid) => {
      killed.push(pid);
      // The kill ends the child as SIGKILL would.
      const child = children.find((entry) => entry.pid === pid);
      if (child !== undefined) setImmediate(() => exitWith(null, 'SIGKILL')(child));
    },
    env: opts.env ?? {},
    cores: opts.cores ?? 20,
    log: (line) => {
      logs.push(line);
    },
    write: (text) => {
      written.push(text);
    },
    root: opts.root ?? root,
    ...(opts.marked !== undefined ? { marked: opts.marked } : {}),
    ...(opts.closeGraceMs !== undefined ? { closeGraceMs: opts.closeGraceMs } : {}),
  };
  return { deps, spawned, children, priorities, killed, logs, written };
}

const exitWith = (code: number | null, signal: string | null = null) => (child: EventEmitter) => {
  child.emit('exit', code, signal);
  child.emit('close', code, signal);
};

test('the concurrency is half the cores rounded down, at least 1', () => {
  assert.deepEqual(concurrency({}, 1), { ok: true, value: 1 });
  assert.deepEqual(concurrency({}, 2), { ok: true, value: 1 });
  assert.deepEqual(concurrency({}, 3), { ok: true, value: 1 });
  assert.deepEqual(concurrency({}, 20), { ok: true, value: 10 });
  assert.deepEqual(concurrency({}, 21), { ok: true, value: 10 });
  assert.deepEqual(concurrency({ SF_TEST_CONCURRENCY: '' }, 20), { ok: true, value: 10 });
});

test('a valid SF_TEST_CONCURRENCY replaces it; anything else is refused', () => {
  assert.deepEqual(concurrency({ SF_TEST_CONCURRENCY: '3' }, 20), { ok: true, value: 3 });
  assert.deepEqual(concurrency({ SF_TEST_CONCURRENCY: '32' }, 4), { ok: true, value: 32 });
  for (const bad of ['0', '-1', 'abc', '1.5', ' 2', '2x', '1e3']) {
    const result = concurrency({ SF_TEST_CONCURRENCY: bad }, 20);
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.match(result.error, /SF_TEST_CONCURRENCY/);
  }
});

test('SF_TEST_FILE_TIMEOUT_MS: unset or empty is 5 minutes, a positive integer replaces it, anything else is refused', () => {
  assert.equal(DEFAULT_FILE_TIMEOUT_MS, 300_000);
  assert.deepEqual(fileTimeout({}), { ok: true, value: 300_000 });
  assert.deepEqual(fileTimeout({ SF_TEST_FILE_TIMEOUT_MS: '' }), { ok: true, value: 300_000 });
  assert.deepEqual(fileTimeout({ SF_TEST_FILE_TIMEOUT_MS: '1' }), { ok: true, value: 1 });
  assert.deepEqual(fileTimeout({ SF_TEST_FILE_TIMEOUT_MS: '900000' }), { ok: true, value: 900_000 });
  for (const bad of ['0', '-1', 'abc', '1.5', ' 2', '2x', '1e3', '99999999999999999999']) {
    const result = fileTimeout({ SF_TEST_FILE_TIMEOUT_MS: bad });
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.equal(result.error, `SF_TEST_FILE_TIMEOUT_MS must be a positive integer, not ${JSON.stringify(bad)}`);
  }
  // A Node timer keeps at most 2^31 - 1 ms; a longer one would fire at once.
  assert.deepEqual(fileTimeout({ SF_TEST_FILE_TIMEOUT_MS: '2147483647' }), { ok: true, value: 2_147_483_647 });
  assert.deepEqual(fileTimeout({ SF_TEST_FILE_TIMEOUT_MS: '3000000000' }), { ok: false, error: 'SF_TEST_FILE_TIMEOUT_MS must be at most 2147483647, not 3000000000' });
});

test('SF_TEST_NICE: unset or empty is 10, exactly 0 is 0, anything else is refused', () => {
  assert.deepEqual(niceValue({}), { ok: true, value: 10 });
  assert.deepEqual(niceValue({ SF_TEST_NICE: '' }), { ok: true, value: 10 });
  assert.deepEqual(niceValue({ SF_TEST_NICE: '0' }), { ok: true, value: 0 });
  for (const bad of ['5', '10', '00', ' 0', 'off']) {
    const result = niceValue({ SF_TEST_NICE: bad });
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.match(result.error, /SF_TEST_NICE/);
  }
});

test('the arguments: the flags, then the later arguments, then the file', () => {
  assert.deepEqual(testArgs('unit', [], 'dist/test/a.test.js'), ['--test', '--test-timeout=120000', 'dist/test/a.test.js']);
  assert.deepEqual(testArgs('browser', [], 'dist/test/browser/x.test.js'), ['--test', 'dist/test/browser/x.test.js']);
  assert.deepEqual(testArgs('unit', ['--test-name-pattern=foo'], 'dist/test/a.test.js'), ['--test', '--test-timeout=120000', '--test-name-pattern=foo', 'dist/test/a.test.js']);
});

test("mode unit runs each of the package's unit files in a detached child of this Node, at nice 10", async () => {
  const { deps, spawned, priorities } = fakeDeps({ cores: 20, emit: exitWith(0) });
  // The package's own files: no root of the test's.
  delete deps.root;
  assert.equal(await main(['unit', '--test-name-pattern=foo'], deps), 0);
  assert.ok(spawned.length > 1);
  const files: string[] = [];
  for (const { command, args, detached } of spawned) {
    assert.equal(command, process.execPath);
    assert.equal(detached, true);
    assert.deepEqual(args.slice(0, 3), ['--test', '--test-timeout=120000', '--test-name-pattern=foo']);
    assert.equal(args.length, 4);
    files.push(args[3]!);
  }
  assert.ok(files.includes('dist/test/run-tests.test.js'), files.join(' '));
  for (const file of files) assert.match(file, /^dist\/test\/[^/]+\.test\.js$/);
  assert.deepEqual(priorities, spawned.map((_, index) => [4242 + index, 10]));
});

test("the children get the caller's environment, the run's compile cache and a mark of their own; a NODE_COMPILE_CACHE of the caller wins", async () => {
  const own = fakeDeps({ env: { KEEP: 'me' }, emit: exitWith(0) });
  assert.equal(await main(['unit'], own.deps), 0);
  own.spawned.forEach(({ env }, index) => {
    assert.deepEqual(env, { KEEP: 'me', NODE_COMPILE_CACHE: join(root, COMPILE_CACHE_DIR), [RUN_MARK]: `${process.pid}-${index + 1}` });
  });
  const callers = fakeDeps({ env: { NODE_COMPILE_CACHE: '/elsewhere' }, emit: exitWith(0) });
  assert.equal(await main(['unit'], callers.deps), 0);
  for (const { env } of callers.spawned) assert.equal(env.NODE_COMPILE_CACHE, '/elsewhere');
});

test('each file runs once, in its own child, from the root, and its output is written whole when it ends, under a line that names it', async () => {
  const { deps, spawned, written } = fakeDeps({
    emit: (child) => {
      child.stdout.emit('data', Buffer.from(`${child.file} one\n`));
      child.stderr.emit('data', Buffer.from(`${child.file} two\n`));
      exitWith(0)(child);
    },
  });
  assert.equal(await main(['unit'], deps), 0);
  assert.deepEqual(spawned.map(({ args }) => args.at(-1)), FILES);
  for (const { cwd } of spawned) assert.equal(cwd, root);
  assert.equal(written.length, 3);
  for (const [index, file] of FILES.entries()) {
    const text = written.find((entry) => entry.includes(`${file} one`))!;
    assert.equal(text.replace(/\(exit 0, \d+\.\d s\)/, '(exit 0, T s)'), `run-tests: ${file} (exit 0, T s)\n${file} one\n${file} two\n`, `${index}: ${text}`);
  }
});

test('at most N files run at once', async () => {
  let runningNow = 0;
  let most = 0;
  const { deps, spawned } = fakeDeps({
    env: { SF_TEST_CONCURRENCY: '2' },
    emit: (child) => {
      runningNow += 1;
      most = Math.max(most, runningNow);
      setTimeout(() => {
        runningNow -= 1;
        exitWith(0)(child);
      }, 20);
    },
  });
  assert.equal(await main(['unit'], deps), 0);
  assert.equal(spawned.length, 3);
  assert.equal(most, 2);
});

test('mode browser runs the browser files without the timeout flag', async () => {
  const { deps, spawned } = fakeDeps({ cores: 8, emit: exitWith(0) });
  assert.equal(await main(['browser'], deps), 0);
  assert.deepEqual(spawned.map(({ args }) => args), [['--test', 'dist/test/browser/x.test.js']]);
});

test('an unknown or missing mode exits 2 and runs nothing', async () => {
  for (const argv of [['all'], []]) {
    const { deps, spawned, logs } = fakeDeps({ emit: exitWith(0) });
    assert.equal(await main(argv, deps), 2);
    assert.equal(spawned.length, 0);
    assert.equal(logs.length, 1);
  }
});

test('an invalid SF_TEST_CONCURRENCY, SF_TEST_NICE or SF_TEST_FILE_TIMEOUT_MS exits 2 before any test runs', async () => {
  for (const env of [{ SF_TEST_CONCURRENCY: '0' }, { SF_TEST_CONCURRENCY: '1.5' }, { SF_TEST_NICE: '5' }, { SF_TEST_FILE_TIMEOUT_MS: '0' }, { SF_TEST_FILE_TIMEOUT_MS: '5m' }, { SF_TEST_FILE_TIMEOUT_MS: '3000000000' }]) {
    const { deps, spawned, logs } = fakeDeps({ env, emit: exitWith(0) });
    assert.equal(await main(['unit'], deps), 2);
    assert.equal(spawned.length, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, new RegExp(Object.keys(env)[0]!));
  }
});

test('no file to run exits 1 with one line', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'sf-run-tests-empty-'));
  try {
    const { deps, spawned, logs } = fakeDeps({ root: empty, emit: exitWith(0) });
    assert.equal(await main(['unit'], deps), 1);
    assert.equal(spawned.length, 0);
    assert.deepEqual(logs, ['run-tests: no test files match dist/test/*.test.js (run npm run build first)']);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("a failing file's exit code is passed on, the other files still run, and the failing files are named", async () => {
  for (const code of [1, 7]) {
    const { deps, spawned, logs } = fakeDeps({ env: { SF_TEST_RETRY: '0' }, emit: (child) => exitWith(child.file === FILES[1] ? code : 0)(child) });
    assert.equal(await main(['unit'], deps), code);
    assert.equal(spawned.length, 3);
    assert.deepEqual(logs, [`run-tests: 1 of 3 test files failed: ${FILES[1]}`]);
  }
});

test("a failing file's output comes after every passing file's, so the run's last lines show the failure", async () => {
  const { deps, written, logs } = fakeDeps({
    env: { SF_TEST_CONCURRENCY: '1', SF_TEST_RETRY: '0' },
    emit: (child) => {
      child.stdout.emit('data', Buffer.from(`${child.file} says\n`));
      exitWith(child.file === FILES[0] ? 1 : 0)(child);
    },
  });
  assert.equal(await main(['unit'], deps), 1);
  assert.deepEqual(written.map((text) => text.split('\n')[1]), [`${FILES[1]} says`, `${FILES[2]} says`, `${FILES[0]} says`]);
  assert.match(written[2]!, /^run-tests: dist\/test\/a\.test\.js \(exit 1, /);
  assert.deepEqual(logs, [`run-tests: 1 of 3 test files failed: ${FILES[0]}`]);
});

test('a child killed by a signal gives 1 and prints the signal', async () => {
  const { deps, logs, written } = fakeDeps({ env: { SF_TEST_RETRY: '0' }, emit: (child) => exitWith(child.file === FILES[0] ? null : 0, child.file === FILES[0] ? 'SIGTERM' : null)(child) });
  assert.equal(await main(['unit'], deps), 1);
  assert.match(written.at(-1)!, new RegExp(`^run-tests: ${FILES[0]} \\(was killed by SIGTERM, `));
  assert.deepEqual(logs, [`run-tests: 1 of 3 test files failed: ${FILES[0]}`]);
});

test('a file past SF_TEST_FILE_TIMEOUT_MS is killed, named with the limit, and the run exits 1; the others pass', async () => {
  const { deps, killed, logs, written, children } = fakeDeps({
    env: { SF_TEST_FILE_TIMEOUT_MS: '50' },
    emit: (child) => {
      if (child.file === FILES[2]) {
        // It hangs after its first line.
        child.stdout.emit('data', Buffer.from('waiting forever\n'));
        return;
      }
      exitWith(0)(child);
    },
  });
  assert.equal(await main(['unit'], deps), 1);
  const stuck = children.find((child) => child.file === FILES[2])!;
  assert.deepEqual(killed, [stuck.pid]);
  assert.deepEqual(logs, [`run-tests: ${FILES[2]} exceeded 50 ms and was killed`, `run-tests: 1 of 3 test files failed: ${FILES[2]}`]);
  // What it wrote before it was killed is printed, last, after the files that passed.
  assert.equal(written.length, 3);
  assert.equal(written[2]!.replace(/, \d+\.\d s\)/, ', T s)'), `run-tests: ${FILES[2]} (exceeded 50 ms and was killed, T s)\nwaiting forever\n`);
});

test('a file under the limit is not killed', async () => {
  const { deps, killed } = fakeDeps({ env: { SF_TEST_FILE_TIMEOUT_MS: '5000' }, emit: (child) => setTimeout(() => exitWith(0)(child), 30) });
  assert.equal(await main(['unit'], deps), 0);
  assert.deepEqual(killed, []);
});

test('a file that exited before its limit is not killed, even when its output closes after the limit', async () => {
  const { deps, killed, logs } = fakeDeps({
    env: { SF_TEST_FILE_TIMEOUT_MS: '40' },
    emit: (child) => {
      child.emit('exit', 0, null);
      setTimeout(() => child.emit('close', 0, null), 120);
    },
  });
  assert.equal(await main(['unit'], deps), 0);
  assert.deepEqual(killed, []);
  assert.deepEqual(logs, []);
});

test('marked: the processes whose environment carries the mark, this one left out', async () => {
  const proc = await mkdtemp(join(tmpdir(), 'sf-run-tests-proc-'));
  try {
    const put = async (pid: number, environ: string[]) => {
      await mkdir(join(proc, String(pid)));
      await writeFile(join(proc, String(pid), 'environ'), `${environ.join('\0')}\0`);
    };
    await put(10, ['PATH=/bin', `${RUN_MARK}=7-1`]);
    await put(11, [`${RUN_MARK}=7-12`]);
    await put(12, ['A=b']);
    await put(13, [`${RUN_MARK}=7-1`]);
    await mkdir(join(proc, '14'));
    await mkdir(join(proc, 'self'));
    assert.deepEqual(marked('7-1', proc, 13).sort(), [10]);
    assert.deepEqual(marked('7-1', join(proc, 'missing')), []);
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});

test('a file whose output is still open after the grace failed: its group and the processes that hold its output are killed, and the run exits 1', async () => {
  assert.equal(CLOSE_GRACE_MS, 5000);
  const { deps, killed, logs, written } = fakeDeps({
    env: { SF_TEST_RETRY: '0' },
    closeGraceMs: 30,
    // A server the file left, outside the child's group and tree, holds its output.
    marked: (mark) => (mark === `${process.pid}-2` ? [7777] : []),
    emit: (child) => {
      if (child.file === FILES[1]) {
        child.stdout.emit('data', Buffer.from('all passed\n'));
        child.emit('exit', 0, null);
        return;
      }
      exitWith(0)(child);
    },
  });
  assert.equal(await main(['unit'], deps), 1);
  assert.deepEqual(killed, [4243, 7777]);
  const left = 'exited (0), but processes it left kept its output open 30 ms later and were killed';
  assert.deepEqual(logs, [`run-tests: ${FILES[1]} ${left}`, `run-tests: 1 of 3 test files failed: ${FILES[1]}`]);
  assert.ok(written.at(-1)!.startsWith(`run-tests: ${FILES[1]} (${left}, `), written.at(-1));
  assert.ok(written.at(-1)!.endsWith(' s)\nall passed\n'), written.at(-1));
});

test('SF_TEST_NICE=0 skips the priority call', async () => {
  const { deps, priorities } = fakeDeps({ env: { SF_TEST_NICE: '0' }, emit: exitWith(0) });
  assert.equal(await main(['unit'], deps), 0);
  assert.deepEqual(priorities, []);
});

test('a failing priority call warns once and the tests still run', async () => {
  const { deps, spawned, logs } = fakeDeps({
    emit: exitWith(0),
    setPriority: () => {
      throw Object.assign(new Error('A system error occurred: uv_os_setpriority returned EACCES'), { code: 'ERR_SYSTEM_ERROR' });
    },
  });
  assert.equal(await main(['unit'], deps), 0);
  assert.equal(spawned.length, 3);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /priority/);
});

test('a failing priority call does not hide a failing test run', async () => {
  const { deps } = fakeDeps({
    emit: exitWith(1),
    setPriority: () => {
      throw new Error('not permitted');
    },
  });
  assert.equal(await main(['unit'], deps), 1);
});

test('a spawn that emits error gives 1 with its line, and no priority call without a pid', async () => {
  const { deps, priorities, logs, written } = fakeDeps({
    env: { SF_TEST_RETRY: '0' },
    pid: undefined,
    emit: (child) => {
      child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }));
      // Node may still report a close after a failed spawn; it must not turn the result into 0.
      child.emit('close', 0, null);
    },
  });
  assert.equal(await main(['unit'], deps), 1);
  assert.deepEqual(priorities, []);
  assert.deepEqual(logs, [`run-tests: 3 of 3 test files failed: ${FILES.join(', ')}`]);
  assert.deepEqual(written.map((text) => text.replace(/, \d+\.\d s\)\n$/, ')')), FILES.map((file) => `run-tests: ${file} (could not start node --test: spawn node ENOENT)`));
});

test('an interrupt kills the running files and starts no more; the run exits 1', async () => {
  let interrupt: (() => void) | undefined;
  let removed = false;
  const { deps, spawned, killed, logs } = fakeDeps({
    env: { SF_TEST_CONCURRENCY: '1' },
    emit: () => interrupt!(),
  });
  deps.onInterrupt = (stop) => {
    interrupt = stop;
    return () => {
      removed = true;
    };
  };
  assert.equal(await main(['unit'], deps), 1);
  assert.equal(spawned.length, 1);
  assert.deepEqual(killed, [4242]);
  assert.equal(logs[0], 'run-tests: interrupted; the running test files are killed');
  assert.equal(removed, true);
});

// An emit that writes `<file> run <n>` and exits with code(file, n), n counting the file's runs from 1.
function byRun(code: (file: string, run: number) => number): (child: FakeChild) => void {
  const runs = new Map<string, number>();
  return (child) => {
    const run = (runs.get(child.file) ?? 0) + 1;
    runs.set(child.file, run);
    child.stdout.emit('data', Buffer.from(`${child.file} run ${run}\n`));
    exitWith(code(child.file, run))(child);
  };
}

const timeless = (text: string): string => text.replace(/, \d+\.\d s\)/g, ', T s)');
const withoutMark = (env: Record<string, string | undefined>) => Object.fromEntries(Object.entries(env).filter(([name]) => name !== RUN_MARK));

test('a file that fails, then passes on its retry, counts as passed: the summary names it, and its first output is printed under a heading', async () => {
  const { deps, spawned, written, logs } = fakeDeps({ env: { KEEP: 'me' }, emit: byRun((file, run) => (file === FILES[1] && run === 1 ? 1 : 0)) });
  assert.equal(await main(['unit', '--test-name-pattern=foo'], deps), 0);
  assert.deepEqual(spawned.map(({ args }) => args.at(-1)), [...FILES, FILES[1]]);
  // The same arguments and environment, a mark of its own.
  assert.deepEqual(spawned[3]!.args, spawned[1]!.args);
  assert.deepEqual(withoutMark(spawned[3]!.env), withoutMark(spawned[1]!.env));
  assert.notEqual(spawned[3]!.env[RUN_MARK], spawned[1]!.env[RUN_MARK]);
  assert.deepEqual(logs, [`run-tests: 3 test files passed (1 after a retry: ${FILES[1]})`]);
  assert.equal(written.length, 3);
  assert.equal(
    timeless(written.at(-1)!),
    `--- ${FILES[1]} failed on the first run, passed on the retry ---\nrun-tests: ${FILES[1]} (exit 1, T s)\n${FILES[1]} run 1\nrun-tests: ${FILES[1]} (exit 0, T s)\n${FILES[1]} run 2\n`,
  );
});

test('a file that fails again on its retry fails the run, with both outputs printed last', async () => {
  const { deps, spawned, written, logs } = fakeDeps({ emit: byRun((file) => (file === FILES[0] ? 7 : 0)) });
  assert.equal(await main(['unit'], deps), 7);
  assert.equal(spawned.length, 4);
  assert.deepEqual(logs, [`run-tests: 1 of 3 test files failed: ${FILES[0]}`]);
  assert.equal(
    timeless(written.at(-1)!),
    `--- ${FILES[0]} failed on the first run and on the retry ---\nrun-tests: ${FILES[0]} (exit 7, T s)\n${FILES[0]} run 1\nrun-tests: ${FILES[0]} (exit 7, T s)\n${FILES[0]} run 2\n`,
  );
});

test('of two retried files, one passing and one failing again, the run fails and both are printed', async () => {
  const { deps, spawned, written, logs } = fakeDeps({ emit: byRun((file, run) => (file === FILES[0] || (file === FILES[2] && run === 1) ? 1 : 0)) });
  assert.equal(await main(['unit'], deps), 1);
  assert.deepEqual(spawned.map(({ args }) => args.at(-1)), [...FILES, FILES[0], FILES[2]]);
  assert.deepEqual(logs, [`run-tests: 1 of 3 test files failed: ${FILES[0]}`]);
  assert.match(written.join(''), new RegExp(`--- ${FILES[2]} failed on the first run, passed on the retry ---\\n`));
  assert.match(written.at(-1)!, new RegExp(`^--- ${FILES[0]} failed on the first run and on the retry ---\\n`));
});

test('a retry that hangs is killed at the same limit', async () => {
  const { deps, spawned, logs } = fakeDeps({
    env: { SF_TEST_FILE_TIMEOUT_MS: '50' },
    emit: (child) => {
      if (child.file !== FILES[1]) return exitWith(0)(child);
      // Fails at once on its first run; hangs on its retry.
      if (spawned.length <= FILES.length) exitWith(1)(child);
    },
  });
  assert.equal(await main(['unit'], deps), 1);
  assert.equal(spawned.length, 4);
  assert.deepEqual(logs, [`run-tests: ${FILES[1]} exceeded 50 ms and was killed`, `run-tests: 1 of 3 test files failed: ${FILES[1]}`]);
});

test('retries run one at a time, after the parallel run; up to three failed files are retried', async () => {
  let firstRunsLeft = FILES.length;
  let retriesNow = 0;
  let most = 0;
  let early = false;
  const runs = new Map<string, number>();
  const { deps, spawned } = fakeDeps({
    emit: (child) => {
      const run = (runs.get(child.file) ?? 0) + 1;
      runs.set(child.file, run);
      if (run === 1) {
        firstRunsLeft -= 1;
        return exitWith(1)(child);
      }
      if (firstRunsLeft > 0) early = true;
      retriesNow += 1;
      most = Math.max(most, retriesNow);
      setTimeout(() => {
        retriesNow -= 1;
        exitWith(0)(child);
      }, 20);
    },
  });
  assert.equal(await main(['unit'], deps), 0);
  assert.deepEqual(spawned.map(({ args }) => args.at(-1)), [...FILES, ...FILES]);
  assert.equal(most, 1);
  assert.equal(early, false);
});

test('four failed files are not retried', async () => {
  const four = await mkdtemp(join(tmpdir(), 'sf-run-tests-four-'));
  try {
    await mkdir(join(four, 'dist', 'test'), { recursive: true });
    for (const name of ['a', 'b', 'c', 'd']) await writeFile(join(four, 'dist', 'test', `${name}.test.js`), '');
    const { deps, spawned, logs } = fakeDeps({ root: four, emit: byRun((_, run) => (run === 1 ? 1 : 0)) });
    assert.equal(await main(['unit'], deps), 1);
    assert.equal(spawned.length, 4);
    assert.match(logs.at(-1)!, /^run-tests: 4 of 4 test files failed: /);
  } finally {
    await rm(four, { recursive: true, force: true });
  }
});

test('a file killed at its limit is not retried, nor is any other failed file of the run', async () => {
  const { deps, spawned, logs } = fakeDeps({
    env: { SF_TEST_FILE_TIMEOUT_MS: '50' },
    emit: (child) => {
      if (child.file === FILES[2]) return;
      exitWith(child.file === FILES[0] ? 1 : 0)(child);
    },
  });
  assert.equal(await main(['unit'], deps), 1);
  assert.equal(spawned.length, 3);
  assert.deepEqual(logs, [`run-tests: ${FILES[2]} exceeded 50 ms and was killed`, `run-tests: 2 of 3 test files failed: ${FILES[0]}, ${FILES[2]}`]);
});

test('SF_TEST_RETRY=0 turns the retry off; any other value leaves it on', async () => {
  const off = fakeDeps({ env: { SF_TEST_RETRY: '0' }, emit: byRun((file, run) => (file === FILES[1] && run === 1 ? 1 : 0)) });
  assert.equal(await main(['unit'], off.deps), 1);
  assert.equal(off.spawned.length, 3);
  for (const value of ['', '1', 'no', 'off']) {
    const on = fakeDeps({ env: { SF_TEST_RETRY: value }, emit: byRun((file, run) => (file === FILES[1] && run === 1 ? 1 : 0)) });
    assert.equal(await main(['unit'], on.deps), 0, value);
    assert.equal(on.spawned.length, 4, value);
  }
});

test('an interrupt during a retry kills it and starts no more; the run exits 1', async () => {
  let interrupt: (() => void) | undefined;
  const { deps, spawned, killed } = fakeDeps({
    emit: (child) => {
      // The first runs fail; the first retry is interrupted.
      if (spawned.length <= FILES.length) return exitWith(1)(child);
      interrupt!();
    },
  });
  deps.onInterrupt = (stop) => {
    interrupt = stop;
    return () => undefined;
  };
  assert.equal(await main(['unit'], deps), 1);
  assert.equal(spawned.length, 4);
  assert.deepEqual(killed, [4245]);
});

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

test('killTree stops the tree, then kills the group and every process below the root, those of other groups too', () => {
  const sent: Array<[number, string]> = [];
  const tree: Record<number, number[]> = { 10: [11, 12], 11: [13] };
  let rounds = 0;
  killTree(10, (pid, signal) => void sent.push([pid, signal]), (pid) => {
    rounds += 1;
    // A child appears in the second look, as a fork racing the stop would.
    const below = (from: number): number[] => (tree[from] ?? []).flatMap((child) => [child, ...below(child)]);
    return rounds === 1 ? below(pid).filter((entry) => entry !== 13) : below(pid);
  });
  const stopped = sent.filter(([, signal]) => signal === 'SIGSTOP').map(([pid]) => pid);
  const killed = sent.filter(([, signal]) => signal === 'SIGKILL').map(([pid]) => pid);
  assert.deepEqual(stopped.sort(), [-10, 10, 11, 12, 13].sort());
  assert.deepEqual(killed.sort(), [-10, 10, 11, 12, 13].sort());
  // Every stop comes before the first kill.
  assert.ok(sent.findIndex(([, signal]) => signal === 'SIGKILL') > sent.findLastIndex(([, signal]) => signal === 'SIGSTOP'));
});

test('for real: a file that hangs is killed after its limit with the detached process it started, and the run exits 1', { skip: process.platform !== 'linux' ? 'needs /proc' : false }, async () => {
  const real = await mkdtemp(join(tmpdir(), 'sf-run-tests-real-'));
  // A sleep only this test starts: its argv names a duration nobody else uses.
  const sleep = ['sleep', `600.${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`];
  try {
    await mkdir(join(real, 'dist', 'test'), { recursive: true });
    await writeFile(join(real, 'dist', 'test', 'hang.test.js'), [
      "import { spawn } from 'node:child_process';",
      "import { test } from 'node:test';",
      `test('hangs', async () => { spawn(${JSON.stringify(sleep[0])}, [${JSON.stringify(sleep[1])}], { detached: true, stdio: 'ignore' }); console.log('started'); await new Promise(() => setInterval(() => {}, 1000)); });`,
    ].join('\n'));
    await writeFile(join(real, 'dist', 'test', 'quick.test.js'), "import { test } from 'node:test';\ntest('quick', () => {});\n");
    const logs: string[] = [];
    const written: string[] = [];
    // The child must not think it runs under this file's own test runner.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const started = Date.now();
    const code = await main(['unit', '--test-timeout=600000'], {
      spawn: (command, args, options) => spawn(command, args, { ...options, env: { ...env, ...options.env } }),
      setPriority: () => undefined,
      kill: (pid) => killTree(pid),
      env: { SF_TEST_FILE_TIMEOUT_MS: '3000', SF_TEST_CONCURRENCY: '2' },
      cores: 2,
      log: (line) => void logs.push(line),
      write: (text) => void written.push(text),
      root: real,
    });
    assert.equal(code, 1, `${logs.join('\n')}\n${written.join('')}`);
    assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
    assert.deepEqual(logs, ['run-tests: dist/test/hang.test.js exceeded 3000 ms and was killed', 'run-tests: 1 of 2 test files failed: dist/test/hang.test.js']);
    assert.match(written.at(-1)!, /^run-tests: dist\/test\/hang\.test\.js \(exceeded 3000 ms and was killed, /);
    assert.match(written.join(''), /quick/);
    // SIGKILL is sent before main resolves; the kernel may take a moment to end the process.
    for (const deadline = Date.now() + 5000; (await processesOf(sleep)).length > 0 && Date.now() < deadline; ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(await processesOf(sleep), []);
  } finally {
    for (const pid of await processesOf(sleep)) process.kill(pid, 'SIGKILL');
    await rm(real, { recursive: true, force: true });
  }
});

test('for real: a file that exits while a detached process it started holds its output fails, and that process is killed', { skip: process.platform !== 'linux' ? 'needs /proc' : false }, async () => {
  const real = await mkdtemp(join(tmpdir(), 'sf-run-tests-held-'));
  const sleep = ['sleep', `600.${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`];
  try {
    await mkdir(join(real, 'dist', 'test'), { recursive: true });
    // In node --test's own process (no isolation), so the sleep inherits the output run-tests reads
    // and the child's mark; detached, it leaves the child's group, and its parent's exit takes it out
    // of the tree.
    await writeFile(join(real, 'dist', 'test', 'leaves.test.js'), [
      "import { spawn } from 'node:child_process';",
      "import { test } from 'node:test';",
      `test('leaves a server', () => { spawn(${JSON.stringify(sleep[0])}, [${JSON.stringify(sleep[1])}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref(); });`,
    ].join('\n'));
    const logs: string[] = [];
    const written: string[] = [];
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const started = Date.now();
    const code = await main(['unit', '--test-isolation=none'], {
      spawn: (command, args, options) => spawn(command, args, { ...options, env: { ...env, ...options.env } }),
      setPriority: () => undefined,
      kill: (pid) => killTree(pid),
      marked: (mark) => marked(mark),
      closeGraceMs: 1000,
      env: { SF_TEST_FILE_TIMEOUT_MS: '60000', SF_TEST_RETRY: '0' },
      cores: 2,
      log: (line) => void logs.push(line),
      write: (text) => void written.push(text),
      root: real,
    });
    assert.equal(code, 1, `${logs.join('\n')}\n${written.join('')}`);
    assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
    assert.deepEqual(logs, [
      'run-tests: dist/test/leaves.test.js exited (0), but processes it left kept its output open 1000 ms later and were killed',
      'run-tests: 1 of 1 test files failed: dist/test/leaves.test.js',
    ]);
    for (const deadline = Date.now() + 5000; (await processesOf(sleep)).length > 0 && Date.now() < deadline; ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(await processesOf(sleep), []);
  } finally {
    for (const pid of await processesOf(sleep)) process.kill(pid, 'SIGKILL');
    await rm(real, { recursive: true, force: true });
  }
});
