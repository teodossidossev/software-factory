// The host-wide e2e lock (src/e2e-lock.ts): taken at once when free, a second taker that waits and
// is told the holder, a lock of the coordinator's `flock <file> <cmd>` that excludes it both ways,
// an abort, a caller killed with SIGKILL while it holds the lock or waits for it (no helper of it
// is left, nothing takes the lock later), flock missing or failing (no host path in the message),
// and the holder a waiter reads. Each test has its lock file in a fresh temporary folder; they skip
// where flock --no-fork is not supported (util-linux before 2.38).
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { E2E_LOCK_FAILED, E2E_LOCK_FILE, type E2eLock, type E2eLockOptions, lockHolder, takeE2eLock } from '../src/e2e-lock.js';

const SELF = fileURLToPath(import.meta.url);
// The child mode of the SIGKILL tests: this file takes the lock in a process of its own and
// prints `waiting` (from onWait) and `locked`, then waits to be killed.
const CHILD = 'SF_E2E_LOCK_CHILD';
const POLL_MS = 50;

if (process.env[CHILD] !== undefined) {
  const { file } = JSON.parse(process.env[CHILD]) as { file: string };
  const lock = await takeE2eLock({
    file,
    holder: 'child',
    signal: new AbortController().signal,
    pollMs: POLL_MS,
    onWait: () => void process.stdout.write('waiting\n'),
  });
  process.stdout.write(lock !== undefined ? 'locked\n' : 'not locked\n');
  setInterval(() => undefined, 60_000);
} else {
  // Whether this flock supports --no-fork (util-linux 2.38 or later): an older one exits 64.
  const noForkSupported = (): boolean => spawnSync('flock', ['--no-fork', '--nonblock', '/dev/null', 'true']).status === 0;
  const lockTest = (name: string, body: () => Promise<void>): void => {
    test(name, { skip: noForkSupported() ? false : 'flock --no-fork is not supported (util-linux before 2.38)' }, body);
  };

  // A fresh folder for one test's lock file, without links in its path, so /proc's fd links name it
  // as the test does.
  async function folder(): Promise<string> {
    return realpath(await mkdtemp(join(tmpdir(), 'sf-e2e-lock-')));
  }

  // free: `flock -n <file> true` exits 0; held: it exits 1.
  const flockStatus = (file: string): number | null => spawnSync('flock', ['-n', file, 'true']).status;
  const isFree = (file: string): boolean => flockStatus(file) === 0;

  // The pids of the processes that have file open, by their /proc/<pid>/fd links.
  async function openers(file: string): Promise<number[]> {
    const pids: number[] = [];
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) {
        continue;
      }
      const fds = await readdir(`/proc/${name}/fd`).catch(() => [] as string[]);
      for (const fd of fds) {
        if ((await readlink(`/proc/${name}/fd/${fd}`).catch(() => '')) === file) {
          pids.push(Number(name));
          break;
        }
      }
    }
    return pids;
  }

  // The process group of pid, from /proc/<pid>/stat; undefined when it is gone.
  async function groupOf(pid: number): Promise<number | undefined> {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
    return stat === undefined ? undefined : Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  }

  // The processes that have file open but the test's own holders (each a process group of its
  // own): the helpers of a taker.
  async function helpers(file: string, holders: readonly number[] = []): Promise<number[]> {
    const found: number[] = [];
    for (const pid of await openers(file)) {
      const group = await groupOf(pid);
      if (pid !== process.pid && (group === undefined || !holders.includes(group))) {
        found.push(pid);
      }
    }
    return found;
  }

  // Waits until check is true, polling; fails after ms.
  async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) {
        assert.fail(`timed out waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  // Whether promise is still pending after ms.
  async function pendingAfter(promise: Promise<unknown>, ms: number): Promise<boolean> {
    let done = false;
    void promise.then(() => (done = true), () => (done = true));
    await sleep(ms);
    return !done;
  }

  // A lock taken as the coordinator's scripts take it: `flock <file> sh -c <script> <file>` (the
  // script names the file as $0), in a process group of its own; it resolves once the lock is held
  // and the file holds text (what the script writes into it).
  async function outsideHolder(file: string, script: string, text = ''): Promise<ChildProcess> {
    const child = spawn('flock', [file, 'sh', '-c', script, file], { detached: true, stdio: 'ignore' });
    await until(async () => !isFree(file) && (await readFile(file, 'utf8').catch(() => undefined)) === text, 'the outside holder to take the lock');
    return child;
  }

  // Ends an outside holder's process group and waits for it.
  async function endHolder(child: ChildProcess): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
      }
      await closed;
    }
  }

  // A child of this file that takes the lock on file; lines collects what it prints.
  function childTaker(file: string): { child: ChildProcess; lines: string[] } {
    const child = spawn(process.execPath, [SELF], { env: { ...process.env, [CHILD]: JSON.stringify({ file }) }, stdio: ['ignore', 'pipe', 'inherit'] });
    const lines: string[] = [];
    let text = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      text += chunk;
      lines.splice(0, lines.length, ...text.split('\n').filter((line) => line !== ''));
    });
    return { child, lines };
  }

  async function killChild(child: ChildProcess): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGKILL');
      await closed;
    }
  }

  const take = (file: string, extra: Partial<E2eLockOptions> = {}) =>
    takeE2eLock({ file, holder: 'test', signal: new AbortController().signal, pollMs: POLL_MS, ...extra });

  lockTest('LK-1: a free lock is taken at once; while held the file holds the holder line; after release it is free and empty', async () => {
    const dir = await folder();
    const file = join(dir, E2E_LOCK_FILE);
    try {
      let waited = false;
      const lock = await take(file, { holder: 'app/T-1 iteration 2', onWait: () => void (waited = true) });
      assert.ok(lock !== undefined);
      assert.equal(waited, false);
      assert.equal(flockStatus(file), 1);
      assert.match(await readFile(file, 'utf8'), /^app\/T-1 iteration 2 \(pid \d+\) since \d{4}-\d\d-\d\dT/);
      assert.ok((await readFile(file, 'utf8')).includes(`(pid ${process.pid})`));
      // Two releases at once: one helper ends, both resolve.
      await Promise.all([lock.release(), lock.release()]);
      await lock.release();
      assert.equal(flockStatus(file), 0);
      assert.equal(await readFile(file, 'utf8'), '');
      assert.deepEqual(await helpers(file), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  lockTest('LK-1: the holder line takes its time from now', async () => {
    const dir = await folder();
    const file = join(dir, E2E_LOCK_FILE);
    try {
      const lock = await take(file, { holder: 'h', now: () => Date.parse('2026-11-26T10:00:00.000Z') });
      assert.equal(await readFile(file, 'utf8'), `h (pid ${process.pid}) since 2026-11-26T10:00:00.000Z\n`);
      await lock!.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  lockTest('LK-2: a second taker waits for the first, is told the first\'s line once, and holds the lock only after the first released it; onWait is awaited, and its rejection rejects the take', async () => {
    const dir = await folder();
    const file = join(dir, E2E_LOCK_FILE);
    const locks: E2eLock[] = [];
    try {
      const first = await take(file, { holder: 'first' });
      assert.ok(first !== undefined);
      locks.push(first);
      const told: string[] = [];
      let letGo: () => void = () => undefined;
      const onWaitDone = new Promise<void>((resolve) => (letGo = resolve));
      const second = take(file, {
        holder: 'second',
        onWait: (holder) => {
          told.push(holder);
          return onWaitDone;
        },
      });
      void second.then((lock) => lock !== undefined && locks.push(lock));
      await until(() => told.length > 0, 'the second taker to be told');
      assert.match(told[0]!, new RegExp(`^first \\(pid ${process.pid}\\) since \\d{4}-`));
      // onWait is done, the first still holds the lock: the second goes on waiting, told once.
      letGo();
      assert.equal(await pendingAfter(second, 8 * POLL_MS), true);
      assert.equal(told.length, 1);
      await first.release();
      const lock = await second;
      assert.ok(lock !== undefined);
      assert.equal(told.length, 1);
      assert.match(await readFile(file, 'utf8'), /^second \(pid \d+\) since /);
      assert.equal(flockStatus(file), 1);

      // A pending onWait is awaited: the third makes no further attempt, even once the lock is free.
      let thirdGo: () => void = () => undefined;
      const thirdWait = new Promise<void>((resolve) => (thirdGo = resolve));
      let thirdTold = false;
      const third = take(file, {
        holder: 'third',
        onWait: () => {
          thirdTold = true;
          return thirdWait;
        },
      });
      void third.then((taken) => taken !== undefined && locks.push(taken));
      await until(() => thirdTold, 'the third taker to be told');
      await lock.release();
      assert.equal(await pendingAfter(third, 6 * POLL_MS), true);
      assert.equal(flockStatus(file), 0);
      thirdGo();
      const thirdLock = await third;
      assert.ok(thirdLock !== undefined);
      assert.match(await readFile(file, 'utf8'), /^third \(pid \d+\) since /);

      // A rejecting onWait rejects the take with its own error and leaves no helper.
      const stop = new Error('stop waiting');
      await assert.rejects(take(file, { holder: 'fourth', onWait: () => Promise.reject(stop) }), (error) => error === stop);
      await thirdLock.release();
      assert.deepEqual(await helpers(file), []);
      assert.equal(flockStatus(file), 0);
    } finally {
      await Promise.all(locks.map((lock) => lock.release()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  lockTest('LK-3: a lock taken outside the factory, as the coordinator\'s script takes it, makes it wait', async () => {
    const dir = await folder();
    try {
      for (const [script, text, expected] of [
        ['printf "%s\\n" cy-on-checkout.sh > "$0"; exec sleep 600', 'cy-on-checkout.sh\n', 'cy-on-checkout.sh'],
        ['exec sleep 600', '', 'another process'],
      ] as const) {
        const file = join(dir, `${expected.replaceAll(' ', '-')}.lock`);
        const holder = await outsideHolder(file, script, text);
        let lock: E2eLock | undefined;
        try {
          const told: string[] = [];
          const taking = take(file, { onWait: (line) => void told.push(line) });
          await until(() => told.length > 0, 'the taker to be told');
          assert.deepEqual(told, [expected]);
          assert.equal(await pendingAfter(taking, 4 * POLL_MS), true);
          await endHolder(holder);
          lock = await taking;
          assert.ok(lock !== undefined);
          // The taker's lock excludes the script's flock.
          assert.equal(flockStatus(file), 1);
        } finally {
          await endHolder(holder);
          await lock?.release();
        }
        assert.equal(flockStatus(file), 0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  lockTest('LK-4: an abort while waiting resolves undefined, leaves no helper of it, and the lock stays with its holder; a signal aborted before the call starts no helper', async () => {
    const dir = await folder();
    const file = join(dir, E2E_LOCK_FILE);
    const holder = await outsideHolder(file, 'printf "%s\\n" script > "$0"; exec sleep 600', 'script\n');
    try {
      // Aborted between attempts or during one, whichever it meets.
      const controller = new AbortController();
      let told = false;
      const taking = take(file, { signal: controller.signal, onWait: () => void (told = true) });
      await until(() => told, 'the taker to wait');
      await sleep(2 * POLL_MS + 13);
      controller.abort();
      assert.equal(await taking, undefined);
      assert.deepEqual(await helpers(file, [holder.pid!]), []);
      assert.equal(flockStatus(file), 1);
      assert.equal(await readFile(file, 'utf8'), 'script\n');

      // Aborted while onWait is pending: the take resolves undefined at once, without waiting for
      // onWait, and makes no further attempt once onWait is done, whether it resolves or rejects
      // (the late rejection is no unhandled one).
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        for (const settle of ['resolve', 'reject'] as const) {
          const during = new AbortController();
          let onWaitGo: () => void = () => undefined;
          let onWaitFail: (error: Error) => void = () => undefined;
          const onWaitDone = new Promise<void>((resolve, reject) => {
            onWaitGo = resolve;
            onWaitFail = reject;
          });
          let inOnWait = false;
          const waiting = take(file, {
            signal: during.signal,
            onWait: () => {
              inOnWait = true;
              return onWaitDone;
            },
          });
          await until(() => inOnWait, 'the taker to be told');
          during.abort();
          assert.equal(await pendingAfter(waiting, 4 * POLL_MS), false, 'the abort ends the take while onWait is pending');
          assert.equal(await waiting, undefined);
          assert.deepEqual(await helpers(file, [holder.pid!]), []);
          if (settle === 'resolve') {
            onWaitGo();
          } else {
            onWaitFail(new Error('onWait failed late'));
          }
          await sleep(4 * POLL_MS);
          assert.equal(flockStatus(file), 1, 'the lock stays with its holder');
          assert.deepEqual(await helpers(file, [holder.pid!]), []);
        }
        await endHolder(holder);
        await sleep(4 * POLL_MS);
        assert.equal(flockStatus(file), 0);
        assert.deepEqual(await helpers(file), []);
        assert.deepEqual(unhandled, []);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    } finally {
      await endHolder(holder);
    }

    try {
      // Aborted before the call: no flock runs, so the missing file is not even created.
      const missing = join(dir, 'never.lock');
      const aborted = new AbortController();
      aborted.abort();
      assert.equal(await take(missing, { signal: aborted.signal }), undefined);
      assert.equal(existsSync(missing), false);

      // Aborted right after the call, before the helper said `locked`: undefined, the file as it
      // was, the lock free, no helper.
      const free = join(dir, 'free.lock');
      await writeFile(free, 'before\n');
      const late = new AbortController();
      const taking = take(free, { signal: late.signal });
      late.abort();
      assert.equal(await taking, undefined);
      assert.equal(await readFile(free, 'utf8'), 'before\n');
      assert.equal(flockStatus(free), 0);
      assert.deepEqual(await helpers(free), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  lockTest('a helper killed from outside: its release leaves the line of whoever took the lock since', async () => {
    const dir = await folder();
    const file = join(dir, E2E_LOCK_FILE);
    const locks: E2eLock[] = [];
    try {
      const first = await take(file, { holder: 'first' });
      assert.ok(first !== undefined);
      locks.push(first);
      const [helper] = await helpers(file);
      assert.ok(helper !== undefined);
      process.kill(helper, 'SIGKILL');
      await until(() => isFree(file), 'the lock to be free');
      const second = await take(file, { holder: 'second' });
      assert.ok(second !== undefined);
      locks.push(second);
      await first.release();
      assert.match(await readFile(file, 'utf8'), /^second \(pid \d+\) since /);
      assert.equal(flockStatus(file), 1);
      await second.release();
      assert.equal(await readFile(file, 'utf8'), '');
      assert.equal(flockStatus(file), 0);
    } finally {
      await Promise.all(locks.map((lock) => lock.release()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  lockTest('LK-5: a caller killed with SIGKILL while it holds the lock frees it', async () => {
    const dir = await folder();
    const file = join(dir, E2E_LOCK_FILE);
    const { child, lines } = childTaker(file);
    try {
      await until(() => lines.includes('locked'), 'the child to take the lock');
      assert.equal(flockStatus(file), 1);
      assert.match(await readFile(file, 'utf8'), new RegExp(`^child \\(pid ${child.pid}\\) since `));
      await killChild(child);
      await until(() => isFree(file), 'the lock to be free', 5_000);
      await until(async () => (await helpers(file)).length === 0, 'no helper of the child', 5_000);
      // A waiter reads the dead child's line as another process.
      assert.equal(lockHolder(await readFile(file, 'utf8')), 'another process');
    } finally {
      await killChild(child);
      await rm(dir, { recursive: true, force: true });
    }
  });

  lockTest('LK-6: a caller killed with SIGKILL while it waits leaves nothing that could take the lock later', async () => {
    const dir = await folder();
    const file = join(dir, E2E_LOCK_FILE);
    const holder = await outsideHolder(file, 'exec sleep 600');
    const { child, lines } = childTaker(file);
    try {
      await until(() => lines.includes('waiting'), 'the child to wait');
      // Let it make a few attempts, then kill it at any point of one.
      await sleep(3 * POLL_MS + 17);
      await killChild(child);
      await until(async () => (await helpers(file, [holder.pid!])).length === 0, 'no helper of the child', 5_000);
      await endHolder(holder);
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        assert.equal(flockStatus(file), 0, 'the lock stays free');
        await sleep(20);
      }
      assert.deepEqual(await helpers(file), []);
    } finally {
      await killChild(child);
      await endHolder(holder);
      await rm(dir, { recursive: true, force: true });
    }
  });

  lockTest('LK-7: without flock on PATH it rejects with e2e_lock_failed', async () => {
    const dir = await folder();
    const empty = join(dir, 'bin');
    await mkdir(empty);
    try {
      await assert.rejects(take(join(dir, E2E_LOCK_FILE), { env: { PATH: empty } }), (error: Error & { code?: string }) => {
        assert.equal(error.name, 'FactoryError');
        assert.equal(error.code, E2E_LOCK_FAILED);
        assert.equal(error.message, 'the e2e lock could not be taken: flock (util-linux) is not installed');
        return true;
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('LK-8: lockHolder: the first line, control characters out, trimmed, at most 200 code points; empty or naming a gone pid, another process', () => {
    const alive = (pid: number): boolean => pid === 42;
    assert.equal(lockHolder('app/T-1 (pid 42) since 2026-11-26T10:00:00.000Z\nsecond line\n', alive), 'app/T-1 (pid 42) since 2026-11-26T10:00:00.000Z');
    assert.equal(lockHolder('cy-on-checkout.sh\n', alive), 'cy-on-checkout.sh');
    assert.equal(lockHolder('  \u001b[31mred\u0007 \t\r\n', alive), '[31mred');
    assert.equal(lockHolder('a\u0000b\u007fc\u0085d', alive), 'abcd');
    const long = '😀'.repeat(250);
    assert.equal(lockHolder(long, alive), '😀'.repeat(200));
    assert.equal(lockHolder('', alive), 'another process');
    assert.equal(lockHolder('\n\nlater line', alive), 'another process');
    assert.equal(lockHolder(' \u0001 \t', alive), 'another process');
    assert.equal(lockHolder('app/T-1 (pid 43) since 2026-11-26T10:00:00.000Z', alive), 'another process');
    assert.equal(lockHolder('app/T-1 (pid 0) since x', () => true), 'another process');
    assert.equal(lockHolder('app/T-1 (pid 99999999999999999999) since x', () => true), 'another process');
    // The default asks the system: this process is alive.
    assert.equal(lockHolder(`me (pid ${process.pid}) since x`), `me (pid ${process.pid}) since x`);
  });

  lockTest('LK-9: a flock that fails names the lock by its place, never its path', async () => {
    const dir = await folder();
    const file = join(dir, 'missing', E2E_LOCK_FILE);
    const errors: string[] = [];
    const errorMock = mock.method(console, 'error', (...args: unknown[]) => void errors.push(args.map(String).join(' ')));
    try {
      await assert.rejects(take(file), (error: Error & { code?: string }) => {
        assert.equal(error.code, E2E_LOCK_FAILED);
        assert.equal(error.message, 'the e2e lock could not be taken: flock exited with 66 on <state dir>/e2e.lock');
        assert.equal(error.message.includes(dir), false);
        assert.doesNotMatch(error.message, /\/tmp|\/home/);
        return true;
      });
      assert.equal(errors.length, 1);
      assert.match(errors[0]!, /cannot open lock file/);
      assert.ok(errors[0]!.includes(file), errors[0]);
    } finally {
      errorMock.mock.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
