// SF-027-ISSUE1: a ticket action (Archive, Delete) and the job card's Archive retire only the
// finished job they selected. Every test runs the production composition: a real Execution, and
// Setup bound to it exactly as sf serve binds it (exclusive: execution.exclusive). The order of
// the competing operations is forced with explicit gates, never with sleeps: a gate holds the
// retirement (the job store's archive, its last step) or the lock until the test releases it.
// The fake Claude Code is the Implementer of a started job; every test aborts its live jobs at
// the end, and node:test's timeout bounds a deadlock.
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { FactoryError } from '../src/errors.js';
import { type ExclusiveScope, Execution } from '../src/execution.js';
import { type Job, JobStore, TERMINAL_STATES } from '../src/jobs.js';
import { resolveWorkspace } from '../src/registry.js';
import { runnerLauncher } from '../src/runner.js';
import { Setup } from '../src/setup.js';
import { type Env, FAKE, git, newEnv, newRepo, processEnv, putTask, script } from './support/harness.js';

const TIMEOUT = { timeout: 60_000 };

interface World {
  env: Env;
  repo: string;
  // The repository's .software-factory directory.
  dir: string;
  state: string;
  execution: Execution;
  setup: Setup;
  // The Setup's own store, as in sf serve; the Execution retires through execution.jobs.
  jobs: JobStore;
}

async function world(name: string): Promise<World> {
  const env = await newEnv(name);
  const repo = await newRepo(env, `${name}-repo`, false);
  await script(env, []);
  // The fake Claude Code reads its turns from $HOME and logs there; the session passes HOME on.
  process.env.HOME = env.home;
  const config: Config = {
    stateDir: env.state, checkAfterStartMin: 15, checkAfterFixMin: 5, maxTurns: 10, turnLimitContinues: 1, maxIterations: 5, claudePath: FAKE,
    sandbox: undefined, model: undefined, worktreeRoot: join(env.state, 'worktrees'), maxJobs: 3, sensitivePaths: [],
    review: false, reviewModel: undefined, reviewMaxTurns: 60, simplify: false, taskCheckMaxTurns: 30, taskCheckAuto: false, taskCheckParallel: 1, rulesMaxBytes: 49152,
    gate: { on: false, reason: 'SF_GATE=off' }, codexModel: undefined, gateMaxRounds: 3, gateMaxTokens: 5_000_000, gateTimeoutMs: 900_000, gateLevel: 'auto', gateFullPaths: [],
    forge: { githubToken: undefined, githubApi: 'https://api.github.com', gitlabToken: undefined, gitlabUrl: undefined }, handoff: 'off', smokeProbeAllow: undefined,
  };
  // The job's runner (SF-042) gets the test's directories and the fake Claude Code.
  const execution = new Execution(config, (workspace) => resolveWorkspace(workspace, env.config), () => {}, '', { launch: runnerLauncher(processEnv(env)) });
  const jobs = new JobStore(env.state);
  const setup = new Setup({ configDir: env.config, jobs, exclusive: (work) => execution.exclusive(work) });
  return { env, repo, dir: join(repo, '.software-factory'), state: env.state, execution, setup, jobs };
}

// Ends every live session, so no fake Claude Code outlives the test.
async function shutdown(world: World): Promise<void> {
  for (const job of await world.execution.jobs.list()) {
    if (!TERMINAL_STATES.includes(job.state)) {
      await world.execution.abort(job.workspace, job.ticket, false).catch(() => undefined);
    }
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

interface Gate {
  // Resolves when the gated step is reached (the lock is held there).
  entered: Promise<void>;
  release: () => void;
  // The tickets whose job directory reached the store's archive, in order.
  archived: string[];
}

// Holds the next archive of a job directory by the Execution (the last step of a retirement,
// after the session, the worktree and the snapshot ref) until release; with failure, that archive
// throws it instead of archiving. Later archives pass through.
function gateRetirement(execution: Execution, failure?: Error): Gate {
  const store = execution.jobs;
  const original = store.archive.bind(store);
  const entered = deferred();
  const released = deferred();
  const archived: string[] = [];
  let used = false;
  store.archive = async (workspace, ticket) => {
    if (!used) {
      used = true;
      entered.resolve();
      await released.promise;
      if (failure !== undefined) {
        throw failure;
      }
    }
    archived.push(ticket);
    return original(workspace, ticket);
  };
  return { entered: entered.promise, release: released.resolve, archived };
}

interface Tracked<T> {
  promise: Promise<T>;
  settled: () => boolean;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  return { promise, settled: () => done };
}

// Lets every operation that could run now take its turn (it does not order anything: the gates do).
async function yieldTurns(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Every operation queued on the Execution's lock before this one has finished.
function drain(execution: Execution): Promise<void> {
  return execution.exclusive(async () => undefined);
}

// Holds the Execution's lock until release, so the operations queued meanwhile run after it in
// the order of their calls.
async function holdLock(execution: Execution): Promise<{ release: () => void; done: Promise<void> }> {
  const reached = deferred();
  const release = deferred();
  const done = execution.exclusive(async () => {
    reached.resolve();
    await release.promise;
  });
  await reached.promise;
  return { release: release.resolve, done };
}

function finished(ticket: string, state: Job['state'], sessionId: string): Job {
  return {
    workspace: 'app', ticket, branch: `${ticket}-old`, base: 'main', continues: null, base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state, iteration: 1, session_id: sessionId, mr: null, created_at: '2026-11-03T10:00:00.000Z', updated_at: '2026-11-03T10:00:00.000Z',
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// The job directories archived for the ticket: <state>/jobs/app/<ticket>.<stamp>.
async function archivedJobs(world: World, ticket: string): Promise<Job[]> {
  const root = join(world.state, 'jobs', 'app');
  const names = (await readdir(root)).filter((name) => name.startsWith(`${ticket}.`)).sort();
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(root, name, 'job.json'), 'utf8')) as Job));
}

// The ticket's files under .software-factory, with their content.
async function ticketFiles(world: World, ticket: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of [`${ticket}.md`, `${ticket}.mr.md`, `archive/${ticket}.md`, `archive/${ticket}.mr.md`]) {
    if (await exists(join(world.dir, path))) {
      files[path] = await readFile(join(world.dir, path), 'utf8');
    }
  }
  return files;
}

function requestPath(world: World, ticket: string): string {
  return join(world.state, 'requests', 'app', `${ticket}.md`);
}

async function putRequest(world: World, ticket: string): Promise<void> {
  await mkdir(dirname(requestPath(world, ticket)), { recursive: true });
  await writeFile(requestPath(world, ticket), 'The user\'s words.\n');
}

const hasCode = (expected: string) => (error: unknown): boolean => error instanceof FactoryError && error.code === expected;

// A started job is alive: not terminal, with its worktree on the branch.
async function assertAlive(world: World, ticket: string, branch: string): Promise<Job> {
  await drain(world.execution);
  const job = await world.execution.jobs.read('app', ticket);
  assert.ok(job !== undefined, `${ticket} has no job`);
  assert.ok(!TERMINAL_STATES.includes(job.state), `${ticket} is ${job.state}`);
  assert.equal(job.branch, branch);
  assert.ok(job.worktree !== null && (await exists(job.worktree)), `${ticket} lost its worktree`);
  assert.equal(git(job.worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), branch);
  return job;
}

test('archive: Restore and Start queued during the retirement wait for the whole section; the new job, session and worktree survive', TIMEOUT, async () => {
  const w = await world('race-archive');
  const gate = gateRetirement(w.execution);
  try {
    await putTask(w.env, w.repo, 'T-1', 'One');
    await writeFile(join(w.dir, 'T-1.mr.md'), 'feat(T-1): One\n');
    await w.jobs.write(finished('T-1', 'pushed', 'first'));

    const archive = track(w.setup.archiveTicket('app', 'T-1'));
    await gate.entered;
    // Retirement runs before the files move: they are still where they were.
    assert.deepEqual(Object.keys(await ticketFiles(w, 'T-1')).sort(), ['T-1.md', 'T-1.mr.md']);
    const restore = track(w.setup.restoreTicket('app', 'T-1'));
    const start = track(w.execution.start('app', 'T-1'));
    await yieldTurns();
    assert.deepEqual([archive.settled(), restore.settled(), start.settled()], [false, false, false]);
    assert.equal((await w.jobs.read('app', 'T-1'))?.session_id, 'first');

    gate.release();
    assert.deepEqual({ ...(await archive.promise), retired: undefined }, { workspace: 'app', ticket: 'T-1', path: '.software-factory/archive/T-1.md', jobArchived: true, retired: undefined });
    assert.deepEqual(await restore.promise, { workspace: 'app', ticket: 'T-1', path: '.software-factory/T-1.md' });
    const started = await start.promise;
    assert.equal(started.branch, 'T-1-one');
    // The retired job is the one Archive selected; the new one is alive and nothing retires it later.
    assert.deepEqual((await archivedJobs(w, 'T-1')).map((job) => job.session_id), ['first']);
    assert.deepEqual(gate.archived, ['T-1']);
    await assertAlive(w, 'T-1', 'T-1-one');
    assert.deepEqual(Object.keys(await ticketFiles(w, 'T-1')).sort(), ['T-1.md', 'T-1.mr.md']);
  } finally {
    gate.release();
    await shutdown(w);
  }
});

test('archive: live and terminal replacements queued at the very end of the Archive section (the old gap before the retirement) are left alone', TIMEOUT, async () => {
  const w = await world('race-archive-end');
  // The production lock and scope; once armed, the next section holds the lock a moment longer
  // after its work is done.
  let armed: { reached: Deferred; release: Deferred } | undefined;
  const arm = (): { reached: Deferred; release: Deferred } => (armed = { reached: deferred(), release: deferred() });
  const setup = new Setup({
    configDir: w.env.config, jobs: w.jobs,
    exclusive: (work) => w.execution.exclusive(async (scope) => {
      const result = await work(scope);
      const gate = armed;
      armed = undefined;
      if (gate !== undefined) {
        gate.reached.resolve();
        await gate.release.promise;
      }
      return result;
    }),
  });
  const gates: Array<{ reached: Deferred; release: Deferred }> = [];
  try {
    // A live replacement: Restore and Start.
    await putTask(w.env, w.repo, 'T-1', 'One');
    await w.jobs.write(finished('T-1', 'pushed', 'first'));
    const one = arm();
    gates.push(one);
    const archive = track(setup.archiveTicket('app', 'T-1'));
    await one.reached.promise;
    const restore = track(setup.restoreTicket('app', 'T-1'));
    const start = track(w.execution.start('app', 'T-1'));
    one.release.resolve();
    assert.equal((await archive.promise).jobArchived, true);
    await restore.promise;
    assert.equal((await start.promise).branch, 'T-1-one');
    await assertAlive(w, 'T-1', 'T-1-one');
    assert.deepEqual((await archivedJobs(w, 'T-1')).map((job) => job.session_id), ['first']);

    // A terminal replacement installed by another lock holder, identical but for the session id.
    await putTask(w.env, w.repo, 'T-2', 'Two');
    await w.jobs.write(finished('T-2', 'pushed', 'first'));
    const two = arm();
    gates.push(two);
    const second = track(setup.archiveTicket('app', 'T-2'));
    await two.reached.promise;
    const replace = track(w.execution.exclusive(async () => w.jobs.write(finished('T-2', 'pushed', 'second'))));
    two.release.resolve();
    assert.equal((await second.promise).jobArchived, true);
    await replace.promise;
    await drain(w.execution);
    assert.deepEqual(await w.jobs.read('app', 'T-2'), finished('T-2', 'pushed', 'second'));
    assert.deepEqual((await archivedJobs(w, 'T-2')).map((job) => job.session_id), ['first']);

    // A terminal replacement made by the real Start: Restore, then a Start that fails (unknown base).
    await putTask(w.env, w.repo, 'T-3', 'Three', 'no-such-base');
    await w.jobs.write(finished('T-3', 'aborted', 'first'));
    const three = arm();
    gates.push(three);
    const third = track(setup.archiveTicket('app', 'T-3'));
    await three.reached.promise;
    const restoreThree = track(setup.restoreTicket('app', 'T-3'));
    const failing = track(w.execution.start('app', 'T-3'));
    three.release.resolve();
    assert.equal((await third.promise).jobArchived, true);
    await restoreThree.promise;
    await assert.rejects(failing.promise, hasCode('base_not_found'));
    await drain(w.execution);
    assert.equal((await w.jobs.read('app', 'T-3'))?.state, 'failed');
    assert.deepEqual((await archivedJobs(w, 'T-3')).map((job) => job.session_id), ['first']);
  } finally {
    for (const gate of gates) {
      gate.release.resolve();
    }
    await shutdown(w);
  }
});

test('delete: Restore and Start queued during the retirement find no Task file; active and archived copies and the request go', TIMEOUT, async () => {
  const w = await world('race-delete');
  const gate = gateRetirement(w.execution);
  try {
    await putTask(w.env, w.repo, 'T-1', 'One');
    await mkdir(join(w.dir, 'archive'));
    await writeFile(join(w.dir, 'archive', 'T-1.md'), await readFile(join(w.dir, 'T-1.md'), 'utf8'));
    await writeFile(join(w.dir, 'archive', 'T-1.mr.md'), 'feat(T-1): One\n');
    await putRequest(w, 'T-1');
    await w.jobs.write(finished('T-1', 'failed', 'first'));

    const remove = track(w.setup.deleteTicket('app', 'T-1'));
    await gate.entered;
    assert.deepEqual(Object.keys(await ticketFiles(w, 'T-1')).sort(), ['T-1.md', 'archive/T-1.md', 'archive/T-1.mr.md']);
    assert.ok(await exists(requestPath(w, 'T-1')));
    const restore = track(w.setup.restoreTicket('app', 'T-1'));
    const start = track(w.execution.start('app', 'T-1'));
    await yieldTurns();
    assert.deepEqual([remove.settled(), restore.settled(), start.settled()], [false, false, false]);

    gate.release();
    const deleted = await remove.promise;
    assert.deepEqual(deleted.deleted.sort(), ['.software-factory/T-1.md', '.software-factory/archive/T-1.md', '.software-factory/archive/T-1.mr.md']);
    assert.equal(deleted.jobArchived, true);
    await assert.rejects(restore.promise, hasCode('task_not_found'));
    await assert.rejects(start.promise, hasCode('task_not_found'));
    await drain(w.execution);
    assert.equal(await w.jobs.read('app', 'T-1'), undefined);
    assert.deepEqual(await ticketFiles(w, 'T-1'), {});
    assert.equal(await exists(requestPath(w, 'T-1')), false);
    assert.deepEqual(gate.archived, ['T-1']);
  } finally {
    gate.release();
    await shutdown(w);
  }
});

test('archive and delete compete: the second sees what the first left; a job is retired once', TIMEOUT, async () => {
  const w = await world('race-archive-delete');
  const gate = gateRetirement(w.execution);
  try {
    // Archive first, Delete queued during its retirement: Delete removes the archived copies, with
    // no job left to retire.
    await putTask(w.env, w.repo, 'T-1', 'One');
    await writeFile(join(w.dir, 'T-1.mr.md'), 'feat(T-1): One\n');
    await w.jobs.write(finished('T-1', 'pushed', 'first'));
    const archive = track(w.setup.archiveTicket('app', 'T-1'));
    await gate.entered;
    const remove = track(w.setup.deleteTicket('app', 'T-1'));
    await yieldTurns();
    assert.equal(remove.settled(), false);
    gate.release();
    assert.equal((await archive.promise).jobArchived, true);
    const deleted = await remove.promise;
    assert.deepEqual([deleted.deleted.sort(), deleted.jobArchived], [['.software-factory/archive/T-1.md', '.software-factory/archive/T-1.mr.md'], false]);
    assert.deepEqual(gate.archived, ['T-1']);

    // Delete first, Archive queued behind it: no Task file is left to archive, and nothing more is
    // retired.
    await putTask(w.env, w.repo, 'T-2', 'Two');
    await w.jobs.write(finished('T-2', 'aborted', 'first'));
    const holder = await holdLock(w.execution);
    const first = track(w.setup.deleteTicket('app', 'T-2'));
    const second = track(w.setup.archiveTicket('app', 'T-2'));
    holder.release();
    await holder.done;
    assert.equal((await first.promise).jobArchived, true);
    await assert.rejects(second.promise, hasCode('task_not_found'));
    assert.deepEqual(gate.archived, ['T-1', 'T-2']);
    assert.equal(await w.jobs.read('app', 'T-2'), undefined);
  } finally {
    gate.release();
    await shutdown(w);
  }
});

test('a replacement by another terminal job cannot slip between selection and retirement, and one installed after the action survives', TIMEOUT, async () => {
  const w = await world('race-terminal');
  const gate = gateRetirement(w.execution);
  try {
    // The replacement differs from the selected job only by its session id: same state, branch
    // and timestamps.
    await putTask(w.env, w.repo, 'T-1', 'One');
    await w.jobs.write(finished('T-1', 'pushed', 'first'));
    const archive = track(w.setup.archiveTicket('app', 'T-1'));
    await gate.entered;
    const replace = track(w.execution.exclusive(async () => w.jobs.write(finished('T-1', 'pushed', 'second'))));
    await yieldTurns();
    assert.equal(replace.settled(), false);
    assert.equal((await w.jobs.read('app', 'T-1'))?.session_id, 'first');
    gate.release();
    assert.equal((await archive.promise).jobArchived, true);
    await replace.promise;
    await drain(w.execution);
    assert.deepEqual((await archivedJobs(w, 'T-1')).map((job) => job.session_id), ['first']);
    assert.deepEqual(await w.jobs.read('app', 'T-1'), finished('T-1', 'pushed', 'second'));

    // A scope kept past its section cannot retire the job that replaced the one it saw.
    let kept: ExclusiveScope | undefined;
    await w.execution.exclusive(async (scope) => {
      kept = scope;
    });
    await assert.rejects(kept!.retireFinished('app', 'T-1'), hasCode('scope_closed'));
    assert.deepEqual(await w.jobs.read('app', 'T-1'), finished('T-1', 'pushed', 'second'));
    assert.deepEqual(gate.archived, ['T-1']);

    // A real terminal replacement: Restore and a Start that fails (unknown base) queued during the
    // retirement of T-2's job; the failed new job is kept.
    const next = gateRetirement(w.execution);
    try {
      await putTask(w.env, w.repo, 'T-2', 'Two', 'no-such-base');
      await w.jobs.write(finished('T-2', 'aborted', 'first'));
      const second = track(w.setup.archiveTicket('app', 'T-2'));
      await next.entered;
      const restore = track(w.setup.restoreTicket('app', 'T-2'));
      const start = track(w.execution.start('app', 'T-2'));
      await yieldTurns();
      assert.deepEqual([restore.settled(), start.settled()], [false, false]);
      next.release();
      assert.equal((await second.promise).jobArchived, true);
      await restore.promise;
      await assert.rejects(start.promise, hasCode('base_not_found'));
      await drain(w.execution);
      const failed = await w.jobs.read('app', 'T-2');
      assert.equal(failed?.state, 'failed');
      assert.equal(failed?.session_id, null);
      assert.deepEqual((await archivedJobs(w, 'T-2')).map((job) => job.session_id), ['first']);
      assert.deepEqual(next.archived, ['T-2']);
    } finally {
      next.release();
    }
  } finally {
    gate.release();
    await shutdown(w);
  }
});

test('a failed retirement moves and deletes nothing and frees the lock; a file failure after it is not rolled back', TIMEOUT, async () => {
  const w = await world('retire-failure');
  try {
    await putTask(w.env, w.repo, 'T-1', 'One');
    await writeFile(join(w.dir, 'T-1.mr.md'), 'feat(T-1): One\n');
    await mkdir(join(w.dir, 'archive'));
    await writeFile(join(w.dir, 'archive', 'T-1.mr.md'), 'older\n');
    await putRequest(w, 'T-1');
    await w.jobs.write(finished('T-1', 'pushed', 'first'));
    const before = await ticketFiles(w, 'T-1');

    // Archive: the retirement throws before the job is archived.
    const failing = gateRetirement(w.execution, new Error('disk full'));
    const archive = track(w.setup.archiveTicket('app', 'T-1'));
    await failing.entered;
    // Queued behind it: a Restore, which changes nothing here (the Task file is still active).
    const queued = track(w.setup.restoreTicket('app', 'T-1'));
    failing.release();
    await assert.rejects(archive.promise, /disk full/);
    await assert.rejects(queued.promise, hasCode('ticket_exists'));
    assert.deepEqual(await ticketFiles(w, 'T-1'), before);
    assert.ok(await exists(requestPath(w, 'T-1')));
    assert.equal((await w.jobs.read('app', 'T-1'))?.session_id, 'first');

    // Delete: the same; the request stays too.
    const again = gateRetirement(w.execution, new Error('disk full'));
    const remove = track(w.setup.deleteTicket('app', 'T-1'));
    await again.entered;
    const probe = track(drain(w.execution));
    again.release();
    await assert.rejects(remove.promise, /disk full/);
    await probe.promise;
    assert.deepEqual(await ticketFiles(w, 'T-1'), before);
    assert.ok(await exists(requestPath(w, 'T-1')));
    assert.equal((await w.jobs.read('app', 'T-1'))?.session_id, 'first');
    // A subsequent Archive succeeds: the failures released the lock.
    assert.deepEqual({ ...(await w.setup.archiveTicket('app', 'T-1')), retired: undefined }, { workspace: 'app', ticket: 'T-1', path: '.software-factory/archive/T-1.md', jobArchived: true, retired: undefined });
    assert.deepEqual(await ticketFiles(w, 'T-1'), { 'archive/T-1.md': before['T-1.md']!, 'archive/T-1.mr.md': 'feat(T-1): One\n' });
    assert.ok(await exists(requestPath(w, 'T-1')));
    assert.equal(await w.jobs.read('app', 'T-1'), undefined);
    assert.deepEqual((await archivedJobs(w, 'T-1')).map((job) => job.session_id), ['first']);

    // No rollback: the job is retired first; a file operation that fails afterwards leaves it
    // retired and the files as they were, and the failure is reported.
    await putTask(w.env, w.repo, 'T-2', 'Two');
    await w.jobs.write(finished('T-2', 'failed', 'first'));
    await mkdir(join(w.dir, 'archive', 'T-2.md'));
    await assert.rejects(w.setup.archiveTicket('app', 'T-2'), (error: unknown) => !(error instanceof FactoryError));
    assert.equal(await w.jobs.read('app', 'T-2'), undefined);
    assert.ok(await exists(join(w.dir, 'T-2.md')));
  } finally {
    await shutdown(w);
  }
});

// The scope's in-flight boundary (Fix 1): a retirement started through the scope keeps the lock
// until it settles, even when the work does not await it.

test('a retirement the work does not await keeps the lock until it settles; a replacement queued meanwhile runs after it and survives', TIMEOUT, async () => {
  const w = await world('inflight-return');
  const gate = gateRetirement(w.execution);
  try {
    await putTask(w.env, w.repo, 'T-1', 'One');
    await w.jobs.write(finished('T-1', 'pushed', 'first'));
    let retirement: Promise<unknown> | undefined;
    const section = track(w.execution.exclusive(async (scope) => {
      retirement = scope.retireFinished('app', 'T-1');
      return 'done';
    }));
    await gate.entered;
    let replaced = false;
    const replace = track(w.execution.exclusive(async () => {
      replaced = true;
      await w.jobs.write(finished('T-1', 'pushed', 'second'));
    }));
    await yieldTurns();
    assert.deepEqual([section.settled(), replaced], [false, false]);
    assert.equal((await w.jobs.read('app', 'T-1'))?.session_id, 'first');

    gate.release();
    assert.equal(await section.promise, 'done');
    assert.equal((await retirement) !== undefined, true);
    await replace.promise;
    await drain(w.execution);
    assert.deepEqual(await w.jobs.read('app', 'T-1'), finished('T-1', 'pushed', 'second'));
    assert.deepEqual((await archivedJobs(w, 'T-1')).map((job) => job.session_id), ['first']);
    assert.deepEqual(gate.archived, ['T-1']);
  } finally {
    gate.release();
    await shutdown(w);
  }
});

test('work that throws while its retirement is in flight keeps the lock until the retirement settles and reports its own error', TIMEOUT, async () => {
  const w = await world('inflight-throw');
  const gate = gateRetirement(w.execution);
  try {
    await putTask(w.env, w.repo, 'T-1', 'One');
    await w.jobs.write(finished('T-1', 'aborted', 'first'));
    const thrown = deferred();
    let retirement: Promise<unknown> | undefined;
    const section = track(w.execution.exclusive(async (scope) => {
      retirement = scope.retireFinished('app', 'T-1');
      await gate.entered;
      thrown.resolve();
      throw new Error('work failed');
    }));
    await thrown.promise;
    const start = track(w.execution.start('app', 'T-1'));
    await yieldTurns();
    assert.deepEqual([section.settled(), start.settled()], [false, false]);

    gate.release();
    await assert.rejects(section.promise, /^Error: work failed$/);
    assert.equal((await retirement) !== undefined, true);
    assert.equal((await start.promise).branch, 'T-1-one');
    await assertAlive(w, 'T-1', 'T-1-one');
    assert.deepEqual((await archivedJobs(w, 'T-1')).map((job) => job.session_id), ['first']);
  } finally {
    gate.release();
    await shutdown(w);
  }
});

test('a scoped retirement that fails is never a silent success and never an unhandled rejection; the lock recovers', TIMEOUT, async () => {
  const w = await world('inflight-reject');
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  const gates: Gate[] = [];
  try {
    await putTask(w.env, w.repo, 'T-1', 'One');
    await w.jobs.write(finished('T-1', 'pushed', 'first'));

    // The work returns without awaiting (or handling) the retirement, which then fails: the
    // section fails with the retirement's error, after it settled; the queued observer runs next.
    const failing = gateRetirement(w.execution, new Error('disk full'));
    gates.push(failing);
    const section = track(w.execution.exclusive(async (scope) => {
      void scope.retireFinished('app', 'T-1');
      return 'done';
    }));
    await failing.entered;
    let observed = false;
    const observer = track(w.execution.exclusive(async () => {
      observed = true;
      return w.jobs.read('app', 'T-1');
    }));
    await yieldTurns();
    assert.deepEqual([section.settled(), observed], [false, false]);
    failing.release();
    await assert.rejects(section.promise, /disk full/);
    assert.equal((await observer.promise)?.session_id, 'first');

    // The work throws while the retirement fails too: the work's own error is the one reported.
    const both = gateRetirement(w.execution, new Error('disk full again'));
    gates.push(both);
    const thrown = track(w.execution.exclusive(async (scope) => {
      void scope.retireFinished('app', 'T-1');
      await both.entered;
      throw new Error('work failed');
    }));
    await both.entered;
    both.release();
    await assert.rejects(thrown.promise, /^Error: work failed$/);

    // The lock recovered: the job is still there and a normal retirement goes through.
    assert.equal((await w.jobs.read('app', 'T-1'))?.session_id, 'first');
    assert.equal((await w.setup.archiveTicket('app', 'T-1')).jobArchived, true);
    assert.equal(await w.jobs.read('app', 'T-1'), undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    for (const gate of gates) {
      gate.release();
    }
    process.off('unhandledRejection', onUnhandled);
    await shutdown(w);
  }
});

test('job card Archive: the terminal guard holds against a queued Start; a live job refuses ticket actions; sf reset keeps any-state authority', TIMEOUT, async () => {
  const w = await world('job-card');
  try {
    // T-1 failed; a Start queued ahead of the job card's Archive and the ticket's Archive and
    // Delete replaces it with a live job: the job card refuses with invalid_state, the ticket
    // actions with job_active, and the job and its files stay.
    await putTask(w.env, w.repo, 'T-1', 'One');
    await writeFile(join(w.dir, 'T-1.mr.md'), 'feat(T-1): One\n');
    await w.jobs.write(finished('T-1', 'failed', 'first'));
    const files = await ticketFiles(w, 'T-1');
    const holder = await holdLock(w.execution);
    const start = track(w.execution.start('app', 'T-1'));
    const archive = track(w.execution.archiveFinished('app', 'T-1'));
    const archiveTicket = track(w.setup.archiveTicket('app', 'T-1'));
    const deleteTicket = track(w.setup.deleteTicket('app', 'T-1'));
    holder.release();
    await holder.done;
    await assert.rejects(archive.promise, hasCode('invalid_state'));
    await assert.rejects(archiveTicket.promise, hasCode('job_active'));
    await assert.rejects(deleteTicket.promise, hasCode('job_active'));
    assert.equal((await start.promise).branch, 'T-1-one');
    await assertAlive(w, 'T-1', 'T-1-one');
    assert.deepEqual(await ticketFiles(w, 'T-1'), files);

    await w.execution.abort('app', 'T-1', false);

    // A finished job is retired by the job card's Archive: the history is archived, the kept
    // worktree goes, the branch stays. (Another ticket: two archives of one ticket within the same
    // second would share the archive name, a limit of the job store's second-resolution stamp.)
    await putTask(w.env, w.repo, 'T-3', 'Three');
    await w.execution.start('app', 'T-3');
    const kept = await assertAlive(w, 'T-3', 'T-3-three');
    assert.equal((await w.execution.abort('app', 'T-3', false)).worktree, kept.worktree);
    const done = await w.execution.archiveFinished('app', 'T-3');
    assert.match(done.archived, /^jobs\/app\/T-3\.\d{8}T\d{6}Z$/);
    assert.deepEqual([done.branch, done.checkout], ['T-3-three', undefined]);
    assert.equal(await w.jobs.read('app', 'T-3'), undefined);
    assert.equal(await exists(kept.worktree!), false);
    assert.equal(git(w.repo, 'branch', '--list', 'T-3-three').trim(), 'T-3-three');
    await assert.rejects(w.execution.archiveFinished('app', 'T-3'), hasCode('job_not_found'));

    // sf reset still retires a live job.
    await putTask(w.env, w.repo, 'T-2', 'Two');
    await w.execution.start('app', 'T-2');
    const working = await assertAlive(w, 'T-2', 'T-2-two');
    const reset = await w.execution.reset('app', 'T-2');
    assert.equal(reset.branch, 'T-2-two');
    assert.equal(await w.jobs.read('app', 'T-2'), undefined);
    assert.equal(await exists(working.worktree!), false);
  } finally {
    await shutdown(w);
  }
});
