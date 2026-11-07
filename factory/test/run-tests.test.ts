// The test runner behind npm test and npm run test:browser (SF-108): half the cores at nice 10,
// the child's exit code passed on exactly. main runs here with a fake spawn and a fake setPriority.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { concurrency, main, niceValue, testArgs, type RunTestsDeps } from '../src/run-tests.js';

type Spawned = { command: string; args: readonly string[] };

// A fake child: emits what `emit` says on the next tick, after main has attached its listeners.
function fakeDeps(opts: {
  env?: Record<string, string | undefined>;
  cores?: number;
  pid?: number | undefined;
  emit: (child: EventEmitter) => void;
  setPriority?: (pid: number, priority: number) => void;
}) {
  const spawned: Spawned[] = [];
  const priorities: Array<[number, number]> = [];
  const logs: string[] = [];
  const deps: RunTestsDeps = {
    spawn: (command, args) => {
      spawned.push({ command, args });
      const child = Object.assign(new EventEmitter(), { pid: 'pid' in opts ? opts.pid : 4242 });
      setImmediate(() => opts.emit(child));
      return child;
    },
    setPriority:
      opts.setPriority ??
      ((pid, priority) => {
        priorities.push([pid, priority]);
      }),
    env: opts.env ?? {},
    cores: opts.cores ?? 20,
    log: (line) => {
      logs.push(line);
    },
  };
  return { deps, spawned, priorities, logs };
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

test('the arguments: the flags, then the later arguments, then the files', () => {
  assert.deepEqual(testArgs('unit', 10, [], ['dist/test/a.test.js', 'dist/test/b.test.js']), [
    '--test',
    '--test-timeout=120000',
    '--test-concurrency=10',
    'dist/test/a.test.js',
    'dist/test/b.test.js',
  ]);
  assert.deepEqual(testArgs('browser', 4, [], ['dist/test/browser/x.test.js']), [
    '--test',
    '--test-concurrency=4',
    'dist/test/browser/x.test.js',
  ]);
  assert.deepEqual(testArgs('unit', 10, ['--test-name-pattern=foo'], ['dist/test/a.test.js']), [
    '--test',
    '--test-timeout=120000',
    '--test-concurrency=10',
    '--test-name-pattern=foo',
    'dist/test/a.test.js',
  ]);
});

test('mode unit runs the unit files with this Node, at nice 10, and passes exit code 0 on', async () => {
  const { deps, spawned, priorities } = fakeDeps({ cores: 20, emit: exitWith(0) });
  assert.equal(await main(['unit', '--test-name-pattern=foo'], deps), 0);
  assert.equal(spawned.length, 1);
  const { command, args } = spawned[0]!;
  assert.equal(command, process.execPath);
  assert.deepEqual(args.slice(0, 4), ['--test', '--test-timeout=120000', '--test-concurrency=10', '--test-name-pattern=foo']);
  const files = args.slice(4);
  assert.ok(files.length > 0);
  assert.ok(files.includes('dist/test/run-tests.test.js'), files.join(' '));
  for (const file of files) assert.match(file, /^dist\/test\/[^/]+\.test\.js$/);
  assert.deepEqual(priorities, [[4242, 10]]);
});

test('mode browser runs the browser files without the timeout flag', async () => {
  const { deps, spawned } = fakeDeps({ cores: 8, emit: exitWith(0) });
  assert.equal(await main(['browser'], deps), 0);
  const { args } = spawned[0]!;
  assert.deepEqual(args.slice(0, 2), ['--test', '--test-concurrency=4']);
  const files = args.slice(2);
  assert.ok(files.length > 0);
  for (const file of files) assert.match(file, /^dist\/test\/browser\/[^/]+\.test\.js$/);
});

test('an unknown or missing mode exits 2 and runs nothing', async () => {
  for (const argv of [['all'], []]) {
    const { deps, spawned, logs } = fakeDeps({ emit: exitWith(0) });
    assert.equal(await main(argv, deps), 2);
    assert.equal(spawned.length, 0);
    assert.equal(logs.length, 1);
  }
});

test('an invalid SF_TEST_CONCURRENCY or SF_TEST_NICE exits 2 before any test runs', async () => {
  for (const env of [{ SF_TEST_CONCURRENCY: '0' }, { SF_TEST_CONCURRENCY: '1.5' }, { SF_TEST_NICE: '5' }]) {
    const { deps, spawned, logs } = fakeDeps({ env, emit: exitWith(0) });
    assert.equal(await main(['unit'], deps), 2);
    assert.equal(spawned.length, 0);
    assert.equal(logs.length, 1);
  }
});

test('SF_TEST_CONCURRENCY replaces the default in the child arguments', async () => {
  const { deps, spawned } = fakeDeps({ env: { SF_TEST_CONCURRENCY: '3' }, emit: exitWith(0) });
  assert.equal(await main(['unit'], deps), 0);
  assert.equal(spawned[0]!.args[2], '--test-concurrency=3');
});

test("the child's exit code is passed on", async () => {
  for (const code of [1, 7]) {
    const { deps } = fakeDeps({ emit: exitWith(code) });
    assert.equal(await main(['unit'], deps), code);
  }
});

test('a child killed by a signal gives 1 and prints the signal', async () => {
  const { deps, logs } = fakeDeps({ emit: exitWith(null, 'SIGTERM') });
  assert.equal(await main(['unit'], deps), 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /SIGTERM/);
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
  assert.equal(spawned.length, 1);
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

test('a spawn that emits error gives 1 with one line, and no priority call without a pid', async () => {
  const { deps, priorities, logs } = fakeDeps({
    pid: undefined,
    emit: (child) => {
      child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }));
      // Node may still report a close after a failed spawn; it must not turn the result into 0.
      child.emit('close', 0, null);
    },
  });
  assert.equal(await main(['unit'], deps), 1);
  assert.deepEqual(priorities, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /ENOENT/);
});
