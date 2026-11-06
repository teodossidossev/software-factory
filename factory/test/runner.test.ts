// The job's runner (SF-042): each job's turns run in a detached `sf run`, which outlives sf serve,
// is the only runner of its job, stops on abort, takes say while a turn runs as the next turn, and
// whose job a restarted sf serve leaves alone. End to end with the real sf serve and CLI and the
// fake Claude Code, plus the lock and the request queue on their own.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { liveOwner, tryLock, withLock } from '../src/pid-lock.js';
import { factoryPrompt } from '../src/prompts.js';
import { enqueue, hasRequests, runJob, type RunnerRequest, Runners, takeRequest } from '../src/runner.js';
import { call, fakeLog, newEnv, newRepo, putTask, runCli, script, serve, stop, temp, turnsStarted, waitFor } from './support/harness.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function until(what: string, condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const lockOf = (state: string, ticket: string): string => join(state, 'jobs', 'app', ticket, 'runner.pid');

// The pid of a process that has ended.
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

test('a runner outlives sf serve and publishes; a second runner of the job is refused; a restarted sf serve leaves its job alone', async () => {
  const env = await newEnv('runner-survives');
  const repo = await newRepo(env, 'runner-survives-repo', false);
  await putTask(env, repo, 'S-1', 'Survive');
  await script(env, [{ delayMs: 6000, write: { 'a.txt': 'a\n' }, text: 'published without sf serve' }]);
  const jobs = new JobStore(env.state);
  let served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'S-1' });
  await turnsStarted(env, 1);
  const pid = Number((await readFile(lockOf(env.state, 'S-1'), 'utf8')).trim().split(' ')[0]);
  // sf serve crashes while the turn runs; the runner, in a session of its own, goes on.
  await stop(served, 'SIGKILL');
  assert.ok(alive(pid));

  const second = await runCli(env, ['run', 'app', 'S-1']);
  assert.equal(second.code, 1);
  assert.equal(second.stderr, `sf: The job already has a runner (pid ${pid}).\n`);

  // At its start sf serve leaves the working job of the live runner alone.
  served = await serve(env);
  const checked = await call(served, 'check', { workspace: 'app', ticket: 'S-1' });
  assert.deepEqual([checked.state, checked.error], ['working', undefined]);
  await stop(served);

  // The runner publishes with no sf serve at all, then ends: nothing is left to run.
  await until('the iteration to be published', async () => (await jobs.read('app', 'S-1'))?.state === 'awaiting_review');
  assert.match((await jobs.readIteration('app', 'S-1', 1)).report, /^published without sf serve\n/);
  await until('the runner to end', async () => !alive(pid));
  assert.equal(await exists(lockOf(env.state, 'S-1')), false);
  assert.match(await readFile(join(env.state, 'jobs', 'app', 'S-1', 'runner.log'), 'utf8'), new RegExp(`runner ${pid} for app/S-1 started\\n(.|\\n)*runner ${pid} for app/S-1 ended\\n$`));
});

test('abort stops the runner: the turn ends unpublished, the lock goes, and so does every process the runner started', async () => {
  const env = await newEnv('runner-abort');
  const repo = await newRepo(env, 'runner-abort-repo', false);
  await putTask(env, repo, 'B-1', 'Abort');
  // The turn would write late.txt LATE_MS after its prompt. On abort the SDK closes Claude Code's
  // stdin and sends it SIGTERM only 2 s later, and the abort itself takes seconds under the whole
  // suite's load: a turn shorter than both writes before it ends.
  const LATE_MS = 15_000;
  await script(env, [{ delayMs: LATE_MS, write: { 'late.txt': 'never\n' } }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'B-1' });
    await turnsStarted(env, 1);
    const pid = Number((await readFile(lockOf(env.state, 'B-1'), 'utf8')).trim().split(' ')[0]);
    const aborted = await runCli(env, ['abort', 'app', 'B-1']);
    assert.equal(aborted.code, 0, aborted.stderr);
    assert.match(aborted.stdout, /^state: aborted$/m);
    // abort answers once the runner and its process group have ended.
    assert.equal(alive(pid), false);
    assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
    assert.equal(await exists(lockOf(env.state, 'B-1')), false);
    // Past the time the turn would have written, had it gone on: its prompt came before the abort.
    await new Promise((resolve) => setTimeout(resolve, LATE_MS + 500));
    assert.equal(await exists(join(env.state, 'worktrees', 'app', 'B-1', 'late.txt')), false);
    const job = await call(served, 'check', { workspace: 'app', ticket: 'B-1' });
    assert.deepEqual([job.state, job.iteration], ['aborted', 0]);
  } finally {
    await stop(served);
  }
});

test('say while a turn runs is queued in the runner and runs as the next turn of the same session', async () => {
  const env = await newEnv('runner-say');
  const repo = await newRepo(env, 'runner-say-repo', false);
  await putTask(env, repo, 'Q-1', 'Queue');
  await script(env, [{ delayMs: 2500, write: { 'a.txt': 'a\n' }, text: 'first turn' }, { text: 'the said turn' }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'Q-1' });
    await turnsStarted(env, 1);
    const said = await runCli(env, ['say', 'app', 'Q-1', 'also', 'this']);
    assert.equal(said.code, 0, said.stderr);
    assert.equal(said.stdout, 'state: working\nqueued: true\n');
    // One iteration for both turns: published when the queue is empty, with the last turn's text.
    const published = await waitFor(served, 'Q-1', 'awaiting_review', 1);
    assert.match(published.report, /^the said turn\n/);
    const log = await fakeLog(env);
    assert.deepEqual(log.map((entry) => entry.prompt), [factoryPrompt('/implement .software-factory/Q-1.md', 'Q-1', 1), factoryPrompt('also this', 'Q-1', 1)]);
    assert.ok(log[1]!.argv.includes(`--resume=${log[0]!.sessionId}`));
  } finally {
    await stop(served);
  }
});

test('the lock: refused while its owner lives, taken over when the owner is gone, released by its owner only', async () => {
  const dir = join(temp, 'locks');
  const path = join(dir, 'one.lock');
  const first = await tryLock(path);
  assert.ok('held' in first);
  assert.deepEqual(await tryLock(path), { owner: process.pid });
  assert.equal(await liveOwner(path), process.pid);
  await first.held.release();
  assert.equal(await exists(path), false);

  const dead = await deadPid();
  await writeFile(path, `${dead}\n`);
  assert.equal(await liveOwner(path), undefined);
  const taken = await tryLock(path);
  assert.ok('held' in taken);
  assert.equal((await readFile(path, 'utf8')).trim().split(' ')[0], String(process.pid));
  await taken.held.release();

  // A live pid that started after the lock was taken is a reused pid, not the owner.
  await writeFile(path, `${process.pid} 1\n`);
  assert.equal(await liveOwner(path), undefined);
  const reused = await tryLock(path);
  assert.ok('held' in reused);
  await reused.held.release();

  // A lock file without a pid (garbage, an empty file) has no live owner: it is stale and taken over.
  for (const garbage of ['not a pid\n', '']) {
    await writeFile(path, garbage);
    assert.equal(await liveOwner(path), undefined);
    const corrupt = await tryLock(path);
    assert.ok('held' in corrupt, JSON.stringify(garbage));
    assert.equal((await readFile(path, 'utf8')).trim().split(' ')[0], String(process.pid));
    await corrupt.held.release();
  }

  // withLock waits for the holder.
  const holder = await tryLock(path);
  assert.ok('held' in holder);
  const order: string[] = [];
  const waiting = withLock(path, async () => {
    order.push('second');
  }, 10);
  await new Promise((resolve) => setTimeout(resolve, 100));
  order.push('first');
  await holder.held.release();
  await waiting;
  assert.deepEqual(order, ['first', 'second']);
});

test('the queue: requests in order, a second runJob refused while one holds the job, the replies written, a request queued at the end taken', async () => {
  const dir = join(temp, 'queue-job');
  await mkdir(dir, { recursive: true });
  const requests: RunnerRequest[] = [{ kind: 'say', message: 'one' }, { kind: 'fix', content: 'two' }];
  const ids = [await enqueue(dir, requests[0]!), await enqueue(dir, requests[1]!)];
  assert.ok(await hasRequests(dir));
  const taken = [await takeRequest(dir), await takeRequest(dir), await takeRequest(dir)];
  assert.deepEqual(taken, [{ id: ids[0], request: requests[0] }, { id: ids[1], request: requests[1] }, undefined]);

  const applied: RunnerRequest[] = [];
  let resumed = 0;
  let late = false;
  let inner: Promise<unknown> | undefined;
  const work = {
    idle: true,
    async apply(request: RunnerRequest): Promise<unknown> {
      applied.push(request);
      if (request.kind === 'say' && request.message === 'refused') {
        const { FactoryError } = await import('../src/errors.js');
        throw new FactoryError('invalid_state', 'not now');
      }
      return { applied: applied.length };
    },
    async resume(): Promise<void> {
      resumed += 1;
      // A second runner of the same job is refused while this one holds it.
      inner = runJob(dir, work).then(() => 'ran', (error: Error & { code?: string }) => error.code);
    },
    async stop(): Promise<void> {},
  };
  const first = await enqueue(dir, { kind: 'say', message: 'hello' });
  const refused = await enqueue(dir, { kind: 'say', message: 'refused' });
  await runJob(dir, work, {
    pollMs: 10,
    // A request queued while the runner lets go of the job: it takes the job again and answers it.
    settle: async () => {
      if (!late) {
        late = true;
        await enqueue(dir, { kind: 'review' });
      }
    },
  });
  assert.equal(await inner, 'runner_running');
  assert.equal(resumed, 1);
  assert.deepEqual(applied, [{ kind: 'say', message: 'hello' }, { kind: 'say', message: 'refused' }, { kind: 'review' }]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'replies', `${first}.json`), 'utf8')), { ok: true, result: { applied: 1 } });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'replies', `${refused}.json`), 'utf8')), { ok: false, error: { code: 'invalid_state', message: 'not now' } });
  assert.equal(await hasRequests(dir), false);
  assert.equal(await exists(join(dir, 'runner.pid')), false);
});

test('a request no runner takes fails after three launches instead of launching again and again; a reset job takes no request', async () => {
  const state = join(temp, 'launch-state');
  const jobs = new JobStore(state);
  await mkdir(jobs.dir('app', 'L-1'), { recursive: true });
  let launches = 0;
  // A runner that ends at once without taking anything (a broken installation).
  const runners = new Runners(jobs, () => {
    launches += 1;
    return spawn(process.execPath, ['-e', '']);
  });
  const id = await runners.queue('app', 'L-1', { kind: 'say', message: 'x' });
  await assert.rejects(runners.reply('app', 'L-1', id), { code: 'runner_failed', message: /ended 3 times without taking the request/ });
  assert.equal(launches, 3);
  assert.equal(await hasRequests(jobs.dir('app', 'L-1')), false);
  await assert.rejects(enqueue(jobs.dir('app', 'GONE-1'), { kind: 'review' }), { code: 'job_not_found' });
  assert.equal(await exists(jobs.dir('app', 'GONE-1')), false);
});
