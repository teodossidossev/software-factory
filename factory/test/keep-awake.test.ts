// The laptop stays awake while a job runs (SF-158). KeepAwake driven directly with a fake command and
// job lister: one inhibitor while jobs run, none when none run (nor when the jobs cannot be listed), never two, a missing command or one
// that exits with an error logs one line and is not tried again. Through sf serve with a fake
// systemd-inhibit first on the PATH and a job parked on a usage limit (a running job that recovery
// leaves alone): the inhibitor ends when sf serve stops and when it is SIGKILLed; SF_KEEP_AWAKE=off
// starts none; an invalid value is invalid_config.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { keepAwakeSetting } from '../src/config.js';
import { type Job, JobStore } from '../src/jobs.js';
import { KeepAwake } from '../src/keep-awake.js';
import { processAlive, until } from './support/fake-tunnel.js';
import { fakeBwrapBin, newEnv, runCli, serve, stop } from './support/harness.js';

const CREATED = '2026-11-01T10:00:00.000Z';
const job = (ticket: string, state: Job['state']): Job => ({
  workspace: 'app', ticket, branch: `${ticket}-demo`, base: 'main', continues: null, builds_on: null, builds_on_commit: null,base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
  mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state, iteration: 1, session_id: null, mr: null,
  created_at: CREATED, updated_at: CREATED,
});
// Parked on a usage limit that resets in a year: running (RUNNING_STATES), and left alone by recovery.
const parked = (ticket: string): Job => ({
  ...job(ticket, 'waiting_limit'), paused: { from: 'working', step: 'turn', at: CREATED },
  limit: { provider: 'claude', resets_at: new Date(Date.now() + 365 * 24 * 3_600_000).toISOString() },
});

interface FakeInhibit {
  dir: string;
  command: string;
  // The pid and arguments of each start, in order.
  starts(): Promise<Array<{ pid: number; args: string }>>;
}

// A fake systemd-inhibit: logs its pid and arguments, then runs the command after its options in
// its own place (exec: the logged pid is the `sh -c 'read _'` that holds). exitCode: it exits at once.
async function fakeInhibit(exitCode?: number): Promise<FakeInhibit> {
  const dir = await mkdtemp(join(tmpdir(), 'sf-fake-inhibit-'));
  const command = join(dir, 'systemd-inhibit');
  const log = join(dir, 'starts.log');
  await writeFile(log, '');
  await writeFile(command, [
    '#!/bin/sh',
    `echo "$$ $*" >> '${log}'`,
    ...(exitCode !== undefined ? [`exit ${exitCode}`] : []),
    'while [ $# -gt 0 ]; do case "$1" in --*) shift ;; *) break ;; esac; done',
    'exec "$@"',
    '',
  ].join('\n'));
  await chmod(command, 0o755);
  return {
    dir, command,
    starts: async () => (await readFile(log, 'utf8')).split('\n').filter((line) => line !== '').map((line) => {
      const space = line.indexOf(' ');
      return { pid: Number(line.slice(0, space)), args: line.slice(space + 1) };
    }),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('SF_KEEP_AWAKE: on, off, empty is on; anything else is invalid_config', () => {
  assert.equal(keepAwakeSetting({}), true);
  assert.equal(keepAwakeSetting({ SF_KEEP_AWAKE: '' }), true);
  assert.equal(keepAwakeSetting({ SF_KEEP_AWAKE: 'on' }), true);
  assert.equal(keepAwakeSetting({ SF_KEEP_AWAKE: 'off' }), false);
  assert.throws(() => keepAwakeSetting({ SF_KEEP_AWAKE: 'yes' }), { code: 'invalid_config', message: 'SF_KEEP_AWAKE must be on or off, got "yes".' });
});

test('one inhibitor while jobs run, none when none run: started with idle:handle-lid-switch and the count, ended when the last job stops; each start and end is one line', async () => {
  const fake = await fakeInhibit();
  let jobs: Job[] = [job('A-1', 'working'), job('A-2', 'awaiting_review'), job('A-3', 'pushed')];
  const lines: string[] = [];
  const keepAwake = new KeepAwake({ intervalMs: 60_000, jobs: async () => jobs, command: fake.command, log: (line) => lines.push(line) });
  try {
    await keepAwake.check();
    assert.equal(keepAwake.holding, true);
    await until(async () => (await fake.starts()).length === 1, 'the inhibitor to start');
    const [first] = await fake.starts();
    assert.equal(first!.args, '--what=idle:handle-lid-switch --who=Software Factory --why=2 jobs running --mode=block sh -c read _');
    await until(() => lines.length === 1, 'the start line');
    assert.deepEqual(lines, ['keeping the laptop awake: 2 jobs running']);

    // Further checks while jobs run start nothing more.
    jobs = [job('A-1', 'working')];
    await keepAwake.check();
    await keepAwake.check();
    assert.equal((await fake.starts()).length, 1);

    // No job running: the inhibitor ends.
    jobs = [job('A-1', 'ready_for_human_review'), job('A-2', 'needs_human')];
    await keepAwake.check();
    await until(async () => !(await processAlive(first!.pid)) && !keepAwake.holding, 'the inhibitor to end');
    assert.deepEqual(lines, ['keeping the laptop awake: 2 jobs running', 'letting the laptop sleep: no job running']);
    await keepAwake.check();
    assert.equal((await fake.starts()).length, 1);

    // A job runs again: a new one.
    jobs = [job('A-4', 'preparing_mr')];
    await keepAwake.check();
    await until(async () => (await fake.starts()).length === 2, 'the second inhibitor');
    assert.match((await fake.starts())[1]!.args, /--why=1 job running /);
  } finally {
    keepAwake.stop();
  }
  const last = (await fake.starts()).at(-1)!;
  await until(async () => !(await processAlive(last.pid)), 'stop() to end the inhibitor');
  assert.equal(lines.at(-1), 'letting the laptop sleep: sf serve stops');
});

test('never two: checks at once start one inhibitor, and none starts while the previous one is still ending', async () => {
  const fake = await fakeInhibit();
  let jobs: Job[] = [job('B-1', 'working')];
  const keepAwake = new KeepAwake({ intervalMs: 60_000, jobs: async () => jobs, command: fake.command, log: () => undefined });
  try {
    await Promise.all([keepAwake.check(), keepAwake.check(), keepAwake.check()]);
    await until(async () => (await fake.starts()).length === 1, 'the inhibitor to start');
    await sleep(200);
    assert.equal((await fake.starts()).length, 1);

    // Ending, and a job runs again before the exit is seen: the check starts nothing beside it.
    jobs = [];
    await keepAwake.check();
    jobs = [job('B-2', 'working')];
    await keepAwake.check();
    assert.equal(keepAwake.holding, true);
    await until(() => !keepAwake.holding, 'the first inhibitor to end');
    assert.equal((await fake.starts()).length, 1);
    await keepAwake.check();
    await until(async () => (await fake.starts()).length === 2, 'the next inhibitor');
    assert.equal(await processAlive((await fake.starts())[0]!.pid), false);
  } finally {
    keepAwake.stop();
  }
});

test('jobs that cannot be listed end a held inhibitor, with one line; the next list that shows a job starts one again', async () => {
  const fake = await fakeInhibit();
  let list: () => Promise<Job[]> = async () => [job('E-1', 'working')];
  const lines: string[] = [];
  const keepAwake = new KeepAwake({ intervalMs: 60_000, jobs: () => list(), command: fake.command, log: (line) => lines.push(line) });
  try {
    await keepAwake.check();
    await until(async () => (await fake.starts()).length === 1, 'the inhibitor to start');
    const [first] = await fake.starts();
    list = async () => {
      throw new Error('job.json is not JSON');
    };
    await keepAwake.check();
    await until(async () => !keepAwake.holding && !(await processAlive(first!.pid)), 'the inhibitor to end');
    assert.deepEqual(lines, ['keeping the laptop awake: 1 job running', 'keep-awake: the jobs could not be listed: job.json is not JSON', 'letting the laptop sleep: no job running']);
    list = async () => [job('E-1', 'working')];
    await keepAwake.check();
    await until(async () => (await fake.starts()).length === 2, 'a new inhibitor');
  } finally {
    keepAwake.stop();
  }
});

test('the interval: start() checks at once, then every interval; stop() ends the checks', async () => {
  const fake = await fakeInhibit();
  let jobs: Job[] = [job('C-1', 'starting')];
  let lists = 0;
  const keepAwake = new KeepAwake({ intervalMs: 50, jobs: async () => (lists++, jobs), command: fake.command, log: () => undefined });
  keepAwake.start();
  try {
    await until(async () => (await fake.starts()).length === 1, 'the first check to start the inhibitor');
    jobs = [];
    await until(() => !keepAwake.holding, 'a later check to end it');
  } finally {
    keepAwake.stop();
  }
  const seen = lists;
  await sleep(200);
  assert.equal(lists, seen);
});

test('a missing command and one that exits with an error: one line each, and not tried again', async () => {
  const missing = join(await mkdtemp(join(tmpdir(), 'sf-no-inhibit-')), 'systemd-inhibit');
  const lines: string[] = [];
  const jobs = [job('D-1', 'working')];
  const keepAwake = new KeepAwake({ intervalMs: 60_000, jobs: async () => jobs, command: missing, log: (line) => lines.push(line) });
  await keepAwake.check();
  await until(() => lines.length > 0 && !keepAwake.holding, 'the missing command to be logged');
  await keepAwake.check();
  await keepAwake.check();
  await sleep(100);
  assert.deepEqual(lines, [`keep-awake: off until sf serve restarts (${missing} not found)`]);
  keepAwake.stop();

  const failing = await fakeInhibit(1);
  const failed: string[] = [];
  const again = new KeepAwake({ intervalMs: 60_000, jobs: async () => jobs, command: failing.command, log: (line) => failed.push(line) });
  await again.check();
  await until(() => failed.length === 2 && !again.holding, 'the failure to be logged');
  await again.check();
  await again.check();
  await sleep(100);
  assert.equal((await failing.starts()).length, 1);
  assert.deepEqual(failed, ['keeping the laptop awake: 1 job running', `keep-awake: off until sf serve restarts (${failing.command} exited with code 1)`]);
  again.stop();
});

test('sf serve with a fake systemd-inhibit on the PATH: an inhibitor for the parked job at once, ended when sf serve stops and when it is SIGKILLed; SF_KEEP_AWAKE=off starts none; an invalid value is invalid_config', { timeout: 120_000 }, async () => {
  const fake = await fakeInhibit();
  const PATH = [fake.dir, fakeBwrapBin, process.env.PATH ?? ''].join(delimiter);
  const env = await newEnv('keep-awake-serve', { SF_KEEP_AWAKE: 'on', PATH });
  await new JobStore(env.state).write(parked('K-1'));

  // A stop by SIGTERM.
  let served = await serve(env);
  await until(async () => (await fake.starts()).length === 1, 'sf serve to start the inhibitor', 30_000);
  const first = (await fake.starts())[0]!;
  assert.match(first.args, /--why=1 job running /);
  await stop(served);
  await until(async () => !(await processAlive(first.pid)), 'the inhibitor to end with sf serve');

  // SIGKILL: no handler runs; the pipe closes with sf serve and the inhibitor ends.
  served = await serve(env);
  await until(async () => (await fake.starts()).length === 2, 'the next sf serve to start one', 30_000);
  const second = (await fake.starts())[1]!;
  assert.equal(await processAlive(second.pid), true);
  await stop(served, 'SIGKILL');
  await until(async () => !(await processAlive(second.pid)), 'the inhibitor to end with the killed sf serve');

  // SF_KEEP_AWAKE=off: none.
  env.extra = { ...env.extra, SF_KEEP_AWAKE: 'off' };
  served = await serve(env);
  await sleep(1_000);
  await stop(served);
  assert.equal((await fake.starts()).length, 2);

  // An invalid value stops the start.
  env.extra = { ...env.extra, SF_KEEP_AWAKE: 'yes' };
  const refused = await runCli(env, ['serve']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /SF_KEEP_AWAKE must be on or off, got "yes"/);
  assert.equal((await fake.starts()).length, 2);
});
