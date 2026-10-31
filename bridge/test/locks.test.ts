// SF-007 Review 01, Finding 3: the SF-006 execution lock (acquireLock) under
// real multi-process contention. Mutual exclusion must hold while holders come
// and go, a stale lock is taken over by exactly one contender (no rename gap),
// a live or replaced lock is never removed, PID reuse and another boot are
// recognised, and a corrupt lock fails closed and is left untouched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireLock, identify } from '../src/execution/process-identity.js';

const WORKER = fileURLToPath(new URL('./support/lock-worker.js', import.meta.url));
let sandbox: string;
let counter = 0;

before(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'sf-locks-')));
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  counter += 1;
  const dir = join(sandbox, `lock-${counter}`);
  await mkdir(dir);
  return dir;
}

function worker(...args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, ...args], { stdio: 'ignore' });
    child.once('exit', (code) => resolve(code));
  });
}

async function lines(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
}

// A lock left by a process that no longer exists (a pid far above pid_max on this test host).
const deadHolder = (token: string) => JSON.stringify({ pid: 4_194_000 + Math.floor(Math.random() * 300), pid_start: '1', boot_id: 'whatever', token });

test('mutual exclusion holds across 8 processes acquiring and releasing 25 times each', async () => {
  const dir = await freshDir();
  const log = join(dir, 'log');
  const codes = await Promise.all(Array.from({ length: 8 }, () => worker('loop', dir, '25', log)));
  assert.deepEqual(codes, Array(8).fill(0));
  const events = await lines(log);
  assert.equal(events.length, 8 * 25 * 2);
  for (let index = 0; index < events.length; index += 2) {
    const [enter, exit] = [events[index]!, events[index + 1]!];
    assert.match(enter, /^enter \d+$/, `line ${index}`);
    assert.equal(exit, enter.replace('enter', 'exit'), `overlap at line ${index}`);
  }
  assert.deepEqual((await readdir(dir)).sort(), ['log'], 'no lock, temp or marker files left');
});

test('a stale lock is taken over by exactly one of many simultaneous contenders', async () => {
  for (let round = 0; round < 5; round += 1) {
    const dir = await freshDir();
    const log = join(dir, 'log');
    await writeFile(join(dir, 'execution.lock'), deadHolder(`stale-${round}`), { mode: 0o600 });
    await Promise.all(Array.from({ length: 8 }, () => worker('once', dir, '400', log)));
    const results = await lines(log);
    assert.equal(results.filter((line) => line.startsWith('won')).length, 1, results.join('\n'));
    assert.equal(results.filter((line) => line.startsWith('locked')).length, 7, results.join('\n'));
  }
});

test('a holder killed while holding is replaced by one contender; a live holder is never displaced', async () => {
  const dir = await freshDir();
  const log = join(dir, 'log');
  const holder = spawn(process.execPath, [WORKER, 'once', dir, '60000', log], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 200 && !(await lines(log)).some((line) => line.startsWith('won')); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // While it lives, nobody gets the lock and its file is untouched.
  const before = await readFile(join(dir, 'execution.lock'), 'utf8');
  await Promise.all(Array.from({ length: 4 }, () => worker('once', dir, '10', log)));
  assert.equal((await lines(log)).filter((line) => line.startsWith('won')).length, 1);
  assert.equal(await readFile(join(dir, 'execution.lock'), 'utf8'), before);
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));
  await Promise.all(Array.from({ length: 6 }, () => worker('once', dir, '300', log)));
  assert.equal((await lines(log)).filter((line) => line.startsWith('won')).length, 2);
});

test('PID reuse and another boot make a lock stale; a live identity does not', async () => {
  const self = (await identify(process.pid))!;
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['reused pid (other start time)', { ...self, pid_start: `${self.pid_start}1`, token: 'a' }, true],
    ['other boot', { ...self, boot_id: 'another-boot', token: 'b' }, true],
    ['live holder', { ...self, token: 'c' }, false],
  ];
  for (const [label, holder, stale] of cases) {
    const dir = await freshDir();
    await writeFile(join(dir, 'execution.lock'), JSON.stringify(holder), { mode: 0o600 });
    if (stale) {
      const release = await acquireLock(dir, label);
      assert.notEqual(JSON.parse(await readFile(join(dir, 'execution.lock'), 'utf8')).token, holder.token, label);
      await release();
      assert.deepEqual(await readdir(dir), [], label);
    } else {
      await assert.rejects(acquireLock(dir, label), { code: 'locked' }, label);
      assert.equal(JSON.parse(await readFile(join(dir, 'execution.lock'), 'utf8')).token, 'c');
    }
  }
});

test('a corrupt lock or an interrupted takeover fails closed and is left untouched', async () => {
  for (const content of ['', '{"pid":', 'null', '[]', '{"pid":"x"}']) {
    const dir = await freshDir();
    await writeFile(join(dir, 'execution.lock'), content, { mode: 0o600 });
    await assert.rejects(acquireLock(dir, 'corrupt'), (error: { code?: string; message: string }) => error.code === 'locked' && /corrupt/.test(error.message));
    assert.equal(await readFile(join(dir, 'execution.lock'), 'utf8'), content);
  }
  // Another process is (or was, until it crashed) replacing this stale lock: never a second replacement.
  const dir = await freshDir();
  await writeFile(join(dir, 'execution.lock'), deadHolder('in-takeover'), { mode: 0o600 });
  await writeFile(join(dir, '.execution.lock.takeover-in-takeover'), '', { mode: 0o600 });
  await assert.rejects(acquireLock(dir, 'takeover'), { code: 'locked' });
  assert.equal(JSON.parse(await readFile(join(dir, 'execution.lock'), 'utf8')).token, 'in-takeover');
});
