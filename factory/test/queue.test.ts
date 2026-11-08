// The run queue (SF-071): the scheduler with fake jobs (an Execution whose start writes a job
// record, a real JobStore, a real Setup over a real registry) and a real temporary repository with a
// bare origin for the merged check of lands_after; then the composition in sf serve, end to end
// with the fake Claude Code: the CLI, the limit that gates only the queue's own starts, a runner's
// transition that frees the slot, and a restart.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { FactoryError } from '../src/errors.js';
import { type ExclusiveScope, Execution } from '../src/execution.js';
import { type Job, type JobState, JobStore, LIMIT_RETRY_MS, now } from '../src/jobs.js';
import { LIMIT_RESET_HOLD_REASON, type PlanCheck, QueueStore, RunQueue, type RunQueueOptions } from '../src/queue.js';
import { resolveWorkspace, saveRegistry } from '../src/registry.js';
import { followJobs } from '../src/runner.js';
import { Setup } from '../src/setup.js';
import { TaskChecks, taskSha256 } from '../src/task-check.js';
import { planCheck } from '../src/task-check-auto.js';
import { writeTask } from '../src/task-file.js';
import { call, type Env, FAKE, git, newEnv, newRepo, putTask, readyCheck, refused, runCli, script, serve, stop, task, temp, turnsStarted, waitFor } from './support/harness.js';

const TIMEOUT = { timeout: 60_000 };
// The end-to-end test below makes some 25 sf CLI calls, three sf serve starts, six turns and four
// aborts: about 30 s alone, over 60 s under the whole suite's load. Its guard is npm test's.
const END_TO_END_TIMEOUT = { timeout: 120_000 };

function config(env: Env): Config {
  return {
    stateDir: env.state, checkAfterStartMin: 15, checkAfterFixMin: 5, maxTurns: 10, turnLimitContinues: 1, maxIterations: 5, claudePath: FAKE,
    sandbox: undefined, model: undefined, worktreeRoot: join(env.state, 'worktrees'), maxJobs: 3, sensitivePaths: [],
    review: false, reviewModel: undefined, reviewMaxTurns: 60, simplify: false, taskCheckMaxTurns: 30, taskCheckAuto: false, taskCheckParallel: 1, rulesMaxBytes: 49152,
    gate: { on: false, reason: 'SF_GATE=off' }, codexModel: undefined, gateMaxRounds: 3, gateMaxTokens: 5_000_000, gateTimeoutMs: 900_000, gateLevel: 'auto', gateFullPaths: [],
    forge: { githubToken: undefined, githubApi: 'https://api.github.com', gitlabToken: undefined, gitlabUrl: undefined }, handoff: 'off', smokeProbeAllow: undefined,
  };
}

function jobRecord(workspace: string, ticket: string, state: JobState, extra: Partial<Job> = {}): Job {
  const at = now();
  return {
    workspace, ticket, branch: `${ticket}-branch`, base: 'main', base_commit: null, state, worktree: null, prepared_commit: null,
    iteration: 0, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null, mr: null, target_commit: null, mr_attempts: 0, mr_conflict_turn: false, created_at: at, updated_at: at, ...extra,
  };
}

// The Execution the queue drives: start writes the job in working (or throws what refuse holds for
// the ticket, or waits on hang); fetchBase is a real Execution's.
class FakeExecution {
  readonly starts: string[] = [];
  readonly fetches: string[] = [];
  readonly refuse = new Map<string, FactoryError>();
  hang: Promise<void> | undefined;
  readonly #jobs: JobStore;
  readonly #real: Execution;

  constructor(jobs: JobStore, real: Execution) {
    this.#jobs = jobs;
    this.#real = real;
  }

  async start(workspace: string, ticket: string, options: { queued?: boolean } = {}): Promise<{ branch: string; state: JobState; check_after_minutes: number; worktree: string }> {
    assert.equal(options.queued, true);
    this.starts.push(`${workspace}/${ticket}`);
    const refusal = this.refuse.get(`${workspace}/${ticket}`);
    if (refusal !== undefined) {
      throw refusal;
    }
    if (this.hang !== undefined) {
      await this.hang;
    }
    await this.#jobs.write(jobRecord(workspace, ticket, 'working'));
    return { branch: `${ticket}-branch`, state: 'working', check_after_minutes: 15, worktree: '/nowhere' };
  }

  fetchBase(workspace: string, base: string): Promise<void> {
    this.fetches.push(`${workspace} ${base}`);
    return this.#real.fetchBase(workspace, base);
  }

  // The reset of a parked job's usage limit (SF-072), as Execution.limitReset does it on the record:
  // skipped unless still parked with the park the queue saw; resumed (to its paused.from, or
  // needs_human with failResume's error), or marked reset_seen.
  readonly resets: string[] = [];
  failResume: FactoryError | undefined;
  async limitReset(workspace: string, ticket: string, parkedAt: string, resume: boolean): Promise<'resumed' | 'waiting' | 'failed' | 'skipped'> {
    const job = await this.#jobs.read(workspace, ticket);
    if (job === undefined || job.state !== 'waiting_limit' || job.limit === undefined || job.limit.reset_seen === true || job.paused?.at !== parkedAt) {
      return 'skipped';
    }
    this.resets.push(`${workspace}/${ticket} ${resume ? 'resume' : 'wait'}`);
    if (!resume) {
      await this.#jobs.write({ ...job, limit: { ...job.limit, reset_seen: true, notified_at: now() } });
      return 'waiting';
    }
    const { paused, limit: _limit, ...rest } = job;
    if (this.failResume !== undefined) {
      await this.#jobs.write({ ...rest, state: 'needs_human', error: { code: this.failResume.code, message: this.failResume.message } });
      return 'failed';
    }
    await this.#jobs.write({ ...rest, state: paused?.from ?? 'working' });
    return 'resumed';
  }
}

interface World {
  env: Env;
  repo: string;
  origin: string;
  jobs: JobStore;
  store: QueueStore;
  execution: FakeExecution;
  setup: Setup;
  queue: RunQueue;
  // Another queue on the same state, as after an sf serve restart.
  again(): RunQueue;
}

// Workspace app (a checkout cloned from a bare origin) and, with web, workspace web too.
async function world(name: string, options: { web?: boolean; recheckMs?: number } & Pick<RunQueueOptions, 'planCheck' | 'onAdded'> = {}): Promise<World> {
  const env = await newEnv(name);
  const repo = await newRepo(env, `${name}-repo`, true);
  if (options.web === true) {
    const web = await newRepo(env, `${name}-web`, false);
    await saveRegistry({ workspaces: { app: { read_checkout: repo }, web: { read_checkout: web } } }, env.config);
  }
  const jobs = new JobStore(env.state);
  const store = new QueueStore(env.state, 3);
  const resolve = (workspace: string) => resolveWorkspace(workspace, env.config);
  const execution = new FakeExecution(jobs, new Execution(config(env), resolve));
  const setup = new Setup({ configDir: env.config, jobs, exclusive: (work) => work({} as ExclusiveScope) });
  const make = (): RunQueue => new RunQueue(store, execution, setup, jobs, {
    resolve, ...(options.recheckMs !== undefined ? { recheckMs: options.recheckMs } : {}),
    ...(options.planCheck !== undefined ? { planCheck: options.planCheck } : {}), ...(options.onAdded !== undefined ? { onAdded: options.onAdded } : {}),
  });
  return { env, repo, origin: join(temp, `${name}-repo-origin.git`), jobs, store, execution, setup, queue: make(), again: make };
}

async function plan(w: World, ticket: string, options: { workspace?: string; landsAfter?: string; draft?: boolean } = {}): Promise<void> {
  const name = options.workspace ?? 'app';
  const workspace = await resolveWorkspace(name, w.env.config);
  let content = task(ticket, `Job ${ticket}`);
  if (options.landsAfter !== undefined) {
    content = content.replace('base: main\n', `base: main\nlands_after: ${options.landsAfter}\n`);
  }
  if (options.draft === true) {
    content += '\n## Status: waiting for the Context owner\n';
  }
  await writeTask(workspace, ticket, content, w.jobs);
}

const queued = async (w: World): Promise<string[]> => (await w.store.read()).entries.map((entry) => `${entry.workspace}/${entry.ticket}`);
const setState = async (w: World, workspace: string, ticket: string, state: JobState): Promise<void> => {
  await w.jobs.write({ ...(await w.jobs.read(workspace, ticket))!, state });
};
const settle = async (queue: RunQueue): Promise<void> => {
  await queue.schedule();
  await queue.idle();
};

test('the scheduler fills the free slots in queue order, across workspaces, and a starting job counts as running', TIMEOUT, async () => {
  const w = await world('queue-fill', { web: true });
  for (const ticket of ['A-1', 'A-2']) {
    await plan(w, ticket);
  }
  await plan(w, 'W-1', { workspace: 'web' });
  // A job of web is starting: it holds one of the two slots.
  await w.jobs.write(jobRecord('web', 'W-0', 'starting'));
  await w.queue.limit(2);
  await w.queue.hold('setting up');
  assert.deepEqual(await w.queue.add('app', 'A-1'), { position: 1 });
  assert.deepEqual(await w.queue.add('web', 'W-1'), { position: 2 });
  assert.deepEqual(await w.queue.add('app', 'A-2', 2), { position: 2 });
  assert.deepEqual(await queued(w), ['app/A-1', 'app/A-2', 'web/W-1']);
  await w.queue.release();
  await w.queue.idle();
  assert.deepEqual(w.execution.starts, ['app/A-1']);
  assert.deepEqual(await queued(w), ['app/A-2', 'web/W-1']);
  // W-0 waits for the user: not running, the next entry starts.
  await setState(w, 'web', 'W-0', 'needs_human');
  await settle(w.queue);
  assert.deepEqual(w.execution.starts, ['app/A-1', 'app/A-2']);
  // A-1 reaches ready_for_human_review: its slot frees and web's ticket starts.
  await setState(w, 'app', 'A-1', 'ready_for_human_review');
  await settle(w.queue);
  assert.deepEqual(w.execution.starts, ['app/A-1', 'app/A-2', 'web/W-1']);
  assert.deepEqual(await queued(w), []);
  const view = await w.queue.view();
  assert.deepEqual([view.max_running, view.running, view.next, view.entries], [2, 2, null, []]);
});

test('SF-086: a queued ticket starts only when its plan is ready or it is forced; the others stay in place with the reason; force survives a restart, holds for any version, ends when the entry leaves', TIMEOUT, async () => {
  const plans = new Map<string, PlanCheck>([
    ['app/P-1', { state: 'not_ready', blockers: 2, majors: 1 }],
    ['app/P-2', { state: 'failed', blockers: 0, majors: 0 }],
    ['app/P-3', { state: 'checking', blockers: 0, majors: 0 }],
    ['app/P-5', { state: 'ready', blockers: 0, majors: 0 }],
  ]);
  const added: string[] = [];
  const w = await world('queue-plan', {
    planCheck: async (workspace, ticket) => plans.get(`${workspace}/${ticket}`) ?? { state: 'none', blockers: 0, majors: 0 },
    onAdded: (workspace, ticket) => added.push(`${workspace}/${ticket}`),
  });
  for (const ticket of ['P-1', 'P-2', 'P-3', 'P-4', 'P-5']) {
    await plan(w, ticket);
  }
  await w.queue.limit(5);
  await w.queue.hold();
  for (const ticket of ['P-1', 'P-2', 'P-3', 'P-4', 'P-5']) {
    await w.queue.add('app', ticket);
  }
  assert.deepEqual(added, ['app/P-1', 'app/P-2', 'app/P-3', 'app/P-4', 'app/P-5']);
  const reasons = async (queue: RunQueue): Promise<Array<[string, string | null, boolean]>> => (await queue.view()).entries.map((row) => [row.ticket, row.plan_reason, row.force]);
  assert.deepEqual(await reasons(w.queue), [
    ['P-1', 'plan not ready: 2 blocker, 1 major', false], ['P-2', 'plan check failed', false], ['P-3', 'plan being checked', false], ['P-4', 'plan not checked', false], ['P-5', null, false],
  ]);
  assert.deepEqual((await w.queue.view()).next, { workspace: 'app', ticket: 'P-5' });
  // Only the ready one starts, though every slot is free; the others keep their places.
  await w.queue.release();
  await w.queue.idle();
  assert.deepEqual(w.execution.starts, ['app/P-5']);
  assert.deepEqual(await queued(w), ['app/P-1', 'app/P-2', 'app/P-3', 'app/P-4']);
  assert.equal((await w.queue.view()).next, null);
  // Start anyway, while held: stored in queue.json; a restart keeps it, and a new Task file too.
  await w.queue.hold();
  assert.deepEqual(await w.queue.force('app', 'P-2'), { force: true });
  await assert.rejects(w.queue.force('app', 'P-9'), { code: 'not_queued' });
  await assert.rejects(w.queue.force('app', 'P-5'), { code: 'not_queued' });
  assert.deepEqual((await w.store.read()).entries.map((entry) => entry.force ?? false), [false, true, false, false]);
  await writeTask(await resolveWorkspace('app', w.env.config), 'P-2', task('P-2', 'Job P-2, rewritten'), w.jobs);
  const again = w.again();
  assert.deepEqual((await reasons(again))[1], ['P-2', null, true]);
  await again.release();
  await again.idle();
  assert.deepEqual(w.execution.starts, ['app/P-5', 'app/P-2']);
  // A check that ends ready: the next pass starts it.
  plans.set('app/P-3', { state: 'ready', blockers: 0, majors: 0 });
  await settle(again);
  assert.deepEqual(w.execution.starts, ['app/P-5', 'app/P-2', 'app/P-3']);
  // Forced, removed and added again: not forced any more.
  await again.hold();
  await again.force('app', 'P-4');
  assert.deepEqual((await reasons(again)).find((row) => row[0] === 'P-4'), ['P-4', null, true]);
  await again.remove('app', 'P-4');
  await again.add('app', 'P-4');
  assert.deepEqual((await reasons(again)).find((row) => row[0] === 'P-4'), ['P-4', 'plan not checked', false]);
  // A plan check that throws counts as not checked.
  const broken = new RunQueue(w.store, w.execution, w.setup, w.jobs, { resolve: (name) => resolveWorkspace(name, w.env.config), planCheck: async () => { throw new FactoryError('workspace_not_found', 'gone'); } });
  assert.deepEqual((await reasons(broken)).map((row) => row[1]), ['plan not checked', 'plan not checked']);
});

test('SF-086: the plan is asked again just before the start: a Task file written while the pass looked at the dependencies holds the entry', TIMEOUT, async () => {
  let asked = 0;
  const w = await world('queue-plan-again', {
    // Ready when the pass first looks, being checked when it asks again (a write_task meanwhile).
    planCheck: async () => (asked++ % 2 === 0 ? { state: 'ready', blockers: 0, majors: 0 } : { state: 'checking', blockers: 0, majors: 0 }),
  });
  await plan(w, 'R-1');
  await w.queue.hold();
  await w.queue.add('app', 'R-1');
  asked = 0;
  await w.queue.release();
  await w.queue.idle();
  assert.deepEqual(w.execution.starts, []);
  assert.deepEqual(await queued(w), ['app/R-1']);
});

test('Fix 1 R2: the last look at the plan and the start hold the ticket\'s lock: a write under it before the look holds the entry; one asked during the start waits for the job\'s claim', TIMEOUT, async () => {
  // The plan is ready for the version "checked" only; a write makes it unchecked.
  let version = 'checked';
  const w = await world('queue-plan-lock', {
    planCheck: async () => (version === 'checked' ? { state: 'ready', blockers: 0, majors: 0 } : { state: 'none', blockers: 0, majors: 0 }),
  });
  await plan(w, 'L-1');
  await w.queue.hold();
  await w.queue.add('app', 'L-1');
  // A write_task under the lock, still writing when the pass reaches the start.
  let finishWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => (finishWrite = resolve));
  const write = w.queue.withTicket('app', 'L-1', async () => {
    await writeGate;
    version = 'rewritten';
  });
  const pass = w.queue.release();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(w.execution.starts, []);
  finishWrite();
  await write;
  await pass;
  await w.queue.idle();
  // The last look saw the new version: not started, still queued, its reason shown.
  assert.deepEqual(w.execution.starts, []);
  assert.deepEqual(await queued(w), ['app/L-1']);
  assert.equal((await w.queue.view()).entries[0]!.plan_reason, 'plan not checked');
  // Checked again: the start runs under the lock, and a write asked meanwhile waits for it.
  version = 'checked';
  let finishStart!: () => void;
  w.execution.hang = new Promise<void>((resolve) => (finishStart = resolve));
  const started = settle(w.queue);
  for (const deadline = Date.now() + 5_000; w.execution.starts.length === 0;) {
    assert.ok(Date.now() < deadline, 'L-1 did not start');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  let wrote = false;
  // The write runs once the start has ended: it sees the claimed job (write_task's guard refuses then).
  const late = w.queue.withTicket('app', 'L-1', async () => {
    wrote = true;
    return (await w.jobs.read('app', 'L-1'))?.state;
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(wrote, false);
  finishStart();
  await started;
  assert.equal(await late, 'working');
  // Another ticket's work never waits for it.
  assert.equal(await w.queue.withTicket('app', 'L-2', async () => 'free'), 'free');
});

test('a limit change starts more at once; lowering it stops nothing and starts nothing until the count is below it', TIMEOUT, async () => {
  const w = await world('queue-limit');
  for (const ticket of ['L-1', 'L-2', 'L-3']) {
    await plan(w, ticket);
  }
  await w.queue.limit(1);
  await w.queue.add('app', 'L-1');
  await w.queue.add('app', 'L-2');
  await w.queue.idle();
  assert.deepEqual(w.execution.starts, ['app/L-1']);
  await w.queue.limit(2);
  await w.queue.idle();
  assert.deepEqual(w.execution.starts, ['app/L-1', 'app/L-2']);
  await w.queue.limit(1);
  await w.queue.add('app', 'L-3');
  await w.queue.idle();
  assert.deepEqual(w.execution.starts, ['app/L-1', 'app/L-2']);
  assert.deepEqual([(await w.jobs.read('app', 'L-1'))!.state, (await w.jobs.read('app', 'L-2'))!.state], ['working', 'working']);
  await setState(w, 'app', 'L-1', 'ready_for_human_review');
  await settle(w.queue);
  assert.deepEqual(w.execution.starts, ['app/L-1', 'app/L-2']);
  await setState(w, 'app', 'L-2', 'paused');
  await settle(w.queue);
  assert.deepEqual(w.execution.starts, ['app/L-1', 'app/L-2', 'app/L-3']);
  for (const bad of [0, 21, 1.5, Number.NaN]) {
    await assert.rejects(w.queue.limit(bad), { code: 'invalid_limit' });
  }
  assert.equal((await w.store.read()).max_running, 1);
});

test('lands_after: an entry waits until every ticket it lands after is merged into origin (a fetch moves origin/<base>), the next entry starts meanwhile', TIMEOUT, async () => {
  const w = await world('queue-deps', { recheckMs: 50 });
  // D-1 was pushed on its branch, not merged.
  git(w.repo, 'switch', '-q', '-c', 'D-1-branch');
  await writeFile(join(w.repo, 'dep.txt'), 'dep\n');
  git(w.repo, 'add', 'dep.txt');
  git(w.repo, 'commit', '-q', '-m', 'D-1');
  const tip = git(w.repo, 'rev-parse', 'HEAD').trim();
  git(w.repo, 'push', '-q', 'origin', 'D-1-branch');
  git(w.repo, 'switch', '-q', 'main');
  await plan(w, 'D-1');
  await w.jobs.write(jobRecord('app', 'D-1', 'pushed', { branch: 'D-1-branch', prepared_commit: tip }));
  await plan(w, 'Q-1', { landsAfter: 'D-1' });
  await plan(w, 'Q-2');
  await w.queue.limit(1);
  await w.queue.hold();
  await w.queue.add('app', 'Q-1');
  await w.queue.add('app', 'Q-2');
  await w.queue.release();
  await w.queue.idle();
  // Q-1 waits (pushed is not merged); Q-2 starts; origin was asked once.
  assert.deepEqual(w.execution.starts, ['app/Q-2']);
  assert.deepEqual(w.execution.fetches, ['app main']);
  let view = await w.queue.view();
  assert.deepEqual(view.entries.map((entry) => [entry.ticket, entry.position, entry.waits_for]), [['Q-1', 1, [{ workspace: 'app', ticket: 'D-1', state: 'pushed' }]]]);
  assert.equal(view.next, null);
  // Q-2 is ready for review: a slot is free, D-1 is still not merged.
  await setState(w, 'app', 'Q-2', 'ready_for_human_review');
  await settle(w.queue);
  assert.deepEqual(w.execution.starts, ['app/Q-2']);
  assert.ok(w.execution.fetches.length >= 2 && w.execution.fetches.every((fetch) => fetch === 'app main'), String(w.execution.fetches));
  // D-1 is merged on the host; the checkout's origin/main does not know yet. The timer's pass
  // fetches, sees it merged past the cache of the last answer, and starts Q-1.
  const other = join(temp, 'queue-deps-other');
  execFileSync('git', ['clone', '-q', w.origin, other]);
  git(other, 'merge', '-q', '--ff-only', 'origin/D-1-branch');
  git(other, 'push', '-q', 'origin', 'main');
  assert.notEqual(git(w.repo, 'rev-parse', 'origin/main').trim(), tip);
  const deadline = Date.now() + 10_000;
  while (w.execution.starts.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  w.queue.close();
  assert.deepEqual(w.execution.starts, ['app/Q-2', 'app/Q-1']);
  assert.equal(git(w.repo, 'rev-parse', 'origin/main').trim(), tip);
  view = await w.queue.view();
  assert.deepEqual(view.entries, []);
});

test('a failed start leaves the ticket out of the queue with its error and the pass goes on; adding it again clears the error; job_limit keeps the entry in place; job_exists drops it without an error', TIMEOUT, async () => {
  const w = await world('queue-fail');
  for (const ticket of ['F-1', 'F-2', 'F-3', 'F-4']) {
    await plan(w, ticket);
  }
  await w.queue.limit(1);
  await w.queue.hold();
  for (const ticket of ['F-1', 'F-2']) {
    await w.queue.add('app', ticket);
  }
  w.execution.refuse.set('app/F-1', new FactoryError('branch_exists', 'The branch F-1-job-f-1 already exists in the checkout.'));
  await w.queue.release();
  await w.queue.idle();
  assert.deepEqual(w.execution.starts, ['app/F-1', 'app/F-2']);
  let file = await w.store.read();
  assert.deepEqual(file.entries, []);
  assert.deepEqual(file.errors.map(({ workspace, ticket, code, message }) => ({ workspace, ticket, code, message })), [
    { workspace: 'app', ticket: 'F-1', code: 'branch_exists', message: 'The branch F-1-job-f-1 already exists in the checkout.' },
  ]);
  assert.deepEqual((await w.queue.view()).errors.length, 1);
  // Added again: the error goes.
  await w.queue.hold();
  await w.queue.add('app', 'F-1');
  assert.deepEqual((await w.store.read()).errors, []);
  // job_limit (a start by hand took the slot): the entry stays where it was, the pass ends.
  await w.queue.add('app', 'F-3');
  await setState(w, 'app', 'F-2', 'ready_for_human_review');
  w.execution.refuse.set('app/F-1', new FactoryError('job_limit', '1 job run (X-1 working); the limit is 1.'));
  await w.queue.release();
  await w.queue.idle();
  assert.deepEqual(w.execution.starts.slice(2), ['app/F-1']);
  file = await w.store.read();
  assert.deepEqual(file.entries.map((entry) => entry.ticket), ['F-1', 'F-3']);
  assert.deepEqual(file.errors, []);
  // job_exists (started by hand after the pass read the jobs): out of the queue without an error.
  w.execution.refuse.set('app/F-1', new FactoryError('job_exists', 'The job for app/F-1 is working.'));
  await settle(w.queue);
  assert.deepEqual(w.execution.starts.slice(3), ['app/F-1', 'app/F-3']);
  file = await w.store.read();
  assert.deepEqual([file.entries, file.errors], [[], []]);
});

test('add refuses a missing Task file, a skeleton, a live job and a ticket already queued; remove and move refuse one not queued; move reorders', TIMEOUT, async () => {
  const w = await world('queue-add');
  await w.queue.hold();
  await plan(w, 'S-1', { draft: true });
  await plan(w, 'S-2');
  await plan(w, 'S-3');
  await plan(w, 'S-4');
  await w.jobs.write(jobRecord('app', 'S-3', 'needs_human'));
  await assert.rejects(w.queue.add('app', 'S-9'), { code: 'task_not_found' });
  await assert.rejects(w.queue.add('app', 'S-1'), { code: 'task_draft' });
  await assert.rejects(w.queue.add('app', 'S-3'), { code: 'job_exists' });
  await w.queue.add('app', 'S-2');
  await assert.rejects(w.queue.add('app', 'S-2'), { code: 'already_queued' });
  await assert.rejects(w.queue.add('nope', 'S-2'), { code: 'workspace_not_found' });
  await assert.rejects(w.queue.add('app', 'S-4', 0), { code: 'invalid_position' });
  await assert.rejects(w.queue.remove('app', 'S-4'), { code: 'not_queued' });
  await assert.rejects(w.queue.move('app', 'S-4', 1), { code: 'not_queued' });
  // A finished job does not keep a ticket out.
  await w.jobs.write(jobRecord('app', 'S-4', 'failed'));
  assert.deepEqual(await w.queue.add('app', 'S-4', 1), { position: 1 });
  assert.deepEqual(await queued(w), ['app/S-4', 'app/S-2']);
  assert.deepEqual(await w.queue.move('app', 'S-4', 9), { position: 2 });
  assert.deepEqual(await queued(w), ['app/S-2', 'app/S-4']);
  assert.deepEqual(await w.queue.remove('app', 'S-2'), { removed: true });
  assert.deepEqual(await queued(w), ['app/S-4']);
});

test('hold and release; a deleted or archived Task file and a start by hand drop the entry at the next pass, without an error', TIMEOUT, async () => {
  const w = await world('queue-hold');
  for (const ticket of ['H-1', 'H-2', 'H-3', 'H-4']) {
    await plan(w, ticket);
  }
  await w.queue.limit(1);
  await w.queue.hold('usage limit');
  for (const ticket of ['H-1', 'H-2', 'H-3', 'H-4']) {
    await w.queue.add('app', ticket);
  }
  await settle(w.queue);
  assert.deepEqual(w.execution.starts, []);
  assert.deepEqual([(await w.queue.view()).held, (await w.queue.view()).hold_reason], [true, 'usage limit']);
  // Held, nothing is dropped either; the user's changes meanwhile:
  await rm(join(w.repo, '.software-factory', 'H-1.md'));
  await mkdir(join(w.repo, '.software-factory', 'archive'), { recursive: true });
  await rename(join(w.repo, '.software-factory', 'H-2.md'), join(w.repo, '.software-factory', 'archive', 'H-2.md'));
  await w.jobs.write(jobRecord('app', 'H-3', 'working'));
  await settle(w.queue);
  assert.deepEqual(await queued(w), ['app/H-1', 'app/H-2', 'app/H-3', 'app/H-4']);
  await w.queue.release();
  await w.queue.idle();
  // H-3 runs (started by hand) and holds the one slot: nothing starts, the three are gone.
  assert.deepEqual(await queued(w), ['app/H-4']);
  assert.deepEqual(w.execution.starts, []);
  assert.deepEqual((await w.store.read()).errors, []);
  assert.deepEqual([(await w.queue.view()).held, (await w.queue.view()).hold_reason], [false, null]);
});

test('the queue survives a restart (entries, limit, held); a ticket out of the queue whose start was cut off is never started again; concurrent passes start a ticket once', TIMEOUT, async () => {
  const w = await world('queue-restart');
  for (const ticket of ['R-1', 'R-2', 'R-3']) {
    await plan(w, ticket);
  }
  await w.queue.limit(1);
  await w.queue.hold('restart');
  await w.queue.add('app', 'R-1');
  await w.queue.add('app', 'R-2');
  w.queue.close();
  const first = w.again();
  let view = await first.view();
  assert.deepEqual([view.max_running, view.held, view.hold_reason, view.entries.map((entry) => entry.ticket)], [1, true, 'restart', ['R-1', 'R-2']]);
  await settle(first);
  assert.deepEqual(w.execution.starts, []);
  // sf serve stops while R-1's start runs: R-1 is out of queue.json before its start.
  let release!: () => void;
  w.execution.hang = new Promise((resolve) => (release = resolve));
  const released = first.release();
  while (w.execution.starts.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  first.close();
  assert.deepEqual(await queued(w), ['app/R-2']);
  // The next sf serve: R-1 has no job and is not queued; it is not started again.
  w.execution.hang = undefined;
  const queue = w.again();
  await settle(queue);
  assert.deepEqual(w.execution.starts, ['app/R-1', 'app/R-2']);
  release();
  await released;
  await first.idle();
  assert.deepEqual(w.execution.starts, ['app/R-1', 'app/R-2']);
  // Many events at once: one start of R-3.
  await setState(w, 'app', 'R-2', 'ready_for_human_review');
  await setState(w, 'app', 'R-1', 'ready_for_human_review');
  await Promise.all([queue.add('app', 'R-3'), ...Array.from({ length: 8 }, () => queue.schedule())]);
  await queue.idle();
  assert.deepEqual(w.execution.starts, ['app/R-1', 'app/R-2', 'app/R-3']);
  view = await queue.view();
  assert.deepEqual([view.entries, view.running], [[], 1]);
});

test('a runner-side transition read through followJobs (ready_for_human_review) frees the slot and starts the next entry', TIMEOUT, async () => {
  const w = await world('queue-follow');
  await plan(w, 'J-1');
  await plan(w, 'J-2');
  await w.queue.limit(1);
  await w.queue.add('app', 'J-1');
  await w.queue.add('app', 'J-2');
  await w.queue.idle();
  assert.deepEqual(w.execution.starts, ['app/J-1']);
  const followed = followJobs(w.jobs, (job, from) => {
    if (from !== job.state) {
      void w.queue.schedule();
    }
  }, 20);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The runner process writes the job's new state to disk.
    await setState(w, 'app', 'J-1', 'ready_for_human_review');
    const deadline = Date.now() + 5_000;
    while (w.execution.starts.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(w.execution.starts, ['app/J-1', 'app/J-2']);
  } finally {
    followed.close();
  }
});

// SF-072: a job parked on a usage limit, as Execution's park leaves it.
function parked(workspace: string, ticket: string, at: string, resetsAt: string, from: 'working' | 'awaiting_review' = 'working', provider: 'claude' | 'codex' = 'claude'): Job {
  return {
    ...jobRecord(workspace, ticket, 'waiting_limit', { iteration: 1 }),
    paused: { from, step: from === 'working' ? 'turn' : 'review', at }, limit: { provider, resets_at: resetsAt },
  };
}

// A queue with a clock the test sets and the notifications it sends.
function limitQueue(w: World, clock: { now: number }): { queue: RunQueue; notes: string[] } {
  const notes: string[] = [];
  const queue = new RunQueue(w.store, w.execution, w.setup, w.jobs, {
    resolve: (workspace) => resolveWorkspace(workspace, w.env.config), clock: () => clock.now,
    notify: async (notification) => {
      notes.push(notification.body);
    },
  });
  return { queue, notes };
}

const T0 = Date.parse('2026-11-05T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

test('usage limit (SF-072): a parked job holds its slot and the queue; releasing the hold by hand starts nothing; a start by hand goes and counts', TIMEOUT, async () => {
  const w = await world('queue-limit-hold');
  const clock = { now: T0 };
  const { queue } = limitQueue(w, clock);
  try {
    for (const ticket of ['H-1', 'H-2']) {
      await plan(w, ticket);
    }
    await w.jobs.write(parked('app', 'P-1', iso(T0 - 1000), iso(T0 + 3_600_000)));
    await queue.limit(3);
    await queue.add('app', 'H-1');
    await queue.idle();
    assert.deepEqual(w.execution.starts, [], 'nothing starts while a job is parked, slots free or not');
    let view = await queue.view();
    assert.deepEqual([view.running, view.held, view.on_limit, view.limit_hold], [1, false, 'resume-then-queue', { parked: 1, resets_at: iso(T0 + 3_600_000) }]);
    // The hold by hand and its release never end the limit hold.
    await queue.hold('night');
    await queue.release();
    await queue.idle();
    assert.deepEqual(w.execution.starts, []);
    // A start by hand (the user's choice) goes, and counts against max_running with the parked job.
    await w.jobs.write(jobRecord('app', 'M-1', 'working'));
    await queue.limit(2);
    await queue.add('app', 'H-2');
    await queue.idle();
    view = await queue.view();
    assert.deepEqual([view.running, w.execution.starts], [2, []]);
    // The parked job is aborted: the limit hold ends, and the queue fills the one free slot.
    await w.jobs.write({ ...(await w.jobs.read('app', 'P-1'))!, state: 'aborted' });
    await queue.schedule();
    await queue.idle();
    assert.deepEqual(w.execution.starts, ['app/H-1']);
    await setState(w, 'app', 'M-1', 'needs_human');
    await queue.schedule();
    await queue.idle();
    assert.deepEqual(w.execution.starts, ['app/H-1', 'app/H-2']);
    assert.equal((await queue.view()).limit_hold, null);
  } finally {
    queue.close();
  }
});

test('usage limit (SF-072): resume-then-queue at a simulated reset resumes the due jobs in park order, then the queue goes on; one notification', TIMEOUT, async () => {
  const w = await world('queue-limit-rtq');
  const clock = { now: T0 };
  const { queue, notes } = limitQueue(w, clock);
  try {
    await plan(w, 'N-1');
    await w.jobs.write(parked('app', 'P-2', iso(T0 - 1000), iso(T0 + 60_000), 'awaiting_review', 'codex'));
    await w.jobs.write(parked('app', 'P-1', iso(T0 - 2000), iso(T0 + 60_000)));
    // P-3 resets later: it stays parked and keeps the queue held.
    await w.jobs.write(parked('app', 'P-3', iso(T0 - 500), iso(T0 + 120_000)));
    await queue.add('app', 'N-1');
    await queue.idle();
    assert.deepEqual([w.execution.resets, w.execution.starts], [[], []]);
    clock.now = T0 + 60_000;
    await queue.schedule();
    await queue.idle();
    assert.deepEqual(w.execution.resets, ['app/P-1 resume', 'app/P-2 resume']);
    assert.deepEqual([(await w.jobs.read('app', 'P-1'))!.state, (await w.jobs.read('app', 'P-2'))!.state], ['working', 'awaiting_review']);
    assert.deepEqual(notes, ['Usage limit reset: 2 jobs resumed']);
    assert.deepEqual(w.execution.starts, [], 'P-3 still holds the queue');
    assert.equal((await w.store.read()).held, false);
    clock.now = T0 + 120_000;
    await queue.schedule();
    await queue.idle();
    assert.deepEqual(notes, ['Usage limit reset: 2 jobs resumed', 'Usage limit reset: 1 job resumed']);
    // Three running against the limit 3: N-1 waits for a slot, not for the limit.
    assert.deepEqual(w.execution.starts, []);
    await setState(w, 'app', 'P-3', 'ready_for_human_review');
    await queue.schedule();
    await queue.idle();
    assert.deepEqual(w.execution.starts, ['app/N-1']);
  } finally {
    queue.close();
  }
});

test('usage limit (SF-072): the reset timer fires by itself at the earliest reset, and a job with no parsed reset is retried 30 minutes after its park', TIMEOUT, async () => {
  const w = await world('queue-limit-timer');
  // The real clock: the timer fires by itself.
  const { queue, notes } = limitQueue(w, { get now() { return Date.now(); } });
  try {
    // No parsed reset: the park stored paused.at + 30 minutes (LIMIT_RETRY_MS).
    const at = Date.now() - LIMIT_RETRY_MS + 150;
    await w.jobs.write(parked('app', 'P-1', iso(at), iso(at + LIMIT_RETRY_MS)));
    await queue.schedule();
    await queue.idle();
    assert.deepEqual(w.execution.resets, []);
    const deadline = Date.now() + 5000;
    while (w.execution.resets.length === 0) {
      assert.ok(Date.now() < deadline, 'the timer did not fire');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await queue.idle();
    assert.deepEqual(w.execution.resets, ['app/P-1 resume']);
    assert.deepEqual(notes, ['Usage limit reset: 1 job resumed']);
  } finally {
    queue.close();
  }
});

test('usage limit (SF-072): resume-only resumes and holds the queue by hand; wait resumes nothing, marks the jobs and holds the queue; the timer skips them', TIMEOUT, async () => {
  const w = await world('queue-limit-rules');
  const clock = { now: T0 };
  const { queue, notes } = limitQueue(w, clock);
  try {
    await plan(w, 'N-1');
    await w.jobs.write(parked('app', 'P-1', iso(T0 - 1000), iso(T0 + 1000)));
    await queue.add('app', 'N-1');
    await assert.rejects(queue.rule('later'), { code: 'invalid_rule' });
    assert.deepEqual(await queue.rule('resume-only'), { on_limit: 'resume-only' });
    clock.now = T0 + 1000;
    await queue.schedule();
    await queue.idle();
    assert.deepEqual(w.execution.resets, ['app/P-1 resume']);
    assert.deepEqual(notes, ['Usage limit reset: 1 job resumed']);
    let file = await w.store.read();
    assert.deepEqual([file.held, file.hold_reason], [true, LIMIT_RESET_HOLD_REASON]);
    assert.deepEqual(w.execution.starts, []);

    // wait: nothing resumes.
    await queue.rule('wait');
    await w.jobs.write(parked('app', 'P-2', iso(T0 + 2000), iso(T0 + 3000)));
    await queue.release();
    await queue.idle();
    assert.deepEqual(w.execution.starts, [], 'P-2 holds the queue');
    clock.now = T0 + 3000;
    await queue.schedule();
    await queue.idle();
    assert.deepEqual(w.execution.resets, ['app/P-1 resume', 'app/P-2 wait']);
    const waiting = (await w.jobs.read('app', 'P-2'))!;
    assert.deepEqual([waiting.state, waiting.limit?.reset_seen, typeof waiting.limit?.notified_at], ['waiting_limit', true, 'string']);
    assert.deepEqual(notes, ['Usage limit reset: 1 job resumed', 'Usage limit reset: 1 job waits for you']);
    file = await w.store.read();
    assert.deepEqual([file.held, file.hold_reason], [true, LIMIT_RESET_HOLD_REASON]);
    assert.deepEqual((await queue.view()).limit_hold, { parked: 1, resets_at: null });
    // Later passes skip it: no second mark, no second notification; released by hand, the queue
    // still starts nothing while it is parked.
    await queue.release();
    clock.now = T0 + 60_000;
    await queue.schedule();
    await queue.idle();
    assert.deepEqual([w.execution.resets.length, notes.length, w.execution.starts], [2, 2, []]);
    // The user resumes it: the queue goes on.
    await setState(w, 'app', 'P-2', 'working');
    await queue.schedule();
    await queue.idle();
    assert.deepEqual(w.execution.starts, ['app/N-1']);
  } finally {
    queue.close();
  }
});

test('usage limit (SF-072): a job aborted, reset or resumed by hand before its reset is skipped; a timed resume that fails leaves the job in needs_human', TIMEOUT, async () => {
  const w = await world('queue-limit-skip');
  const clock = { now: T0 };
  const { queue, notes } = limitQueue(w, clock);
  try {
    await w.jobs.write(parked('app', 'P-1', iso(T0 - 1000), iso(T0 + 1000)));
    await w.jobs.write(parked('app', 'P-2', iso(T0 - 900), iso(T0 + 1000)));
    await w.jobs.write(parked('app', 'P-3', iso(T0 - 800), iso(T0 + 1000)));
    await queue.idle();
    // Meanwhile: P-1 aborted, P-2 resumed by hand, P-3 reset (archived).
    await setState(w, 'app', 'P-1', 'aborted');
    await setState(w, 'app', 'P-2', 'working');
    await w.jobs.archive('app', 'P-3');
    clock.now = T0 + 1000;
    await queue.schedule();
    await queue.idle();
    assert.deepEqual([w.execution.resets, notes], [[], []]);
    assert.deepEqual([(await w.jobs.read('app', 'P-1'))!.state, (await w.jobs.read('app', 'P-2'))!.state], ['aborted', 'working']);
    // A timed resume that throws: the job needs the user with that error; the timer moves on.
    await w.jobs.write(parked('app', 'P-4', iso(T0 + 1000), iso(T0 + 2000)));
    w.execution.failResume = new FactoryError('worktree_missing', 'The worktree of app/P-4 is missing; sf restart the ticket.');
    clock.now = T0 + 2000;
    await queue.schedule();
    await queue.idle();
    const failed = (await w.jobs.read('app', 'P-4'))!;
    assert.deepEqual([failed.state, failed.error?.code], ['needs_human', 'worktree_missing']);
    assert.deepEqual(notes, []);
    assert.equal((await queue.view()).limit_hold, null);
  } finally {
    queue.close();
  }
});

test('usage limit (SF-072): a restarted sf serve keeps the parked jobs and its queue resumes a reset that passed while it was down', TIMEOUT, async () => {
  const w = await world('queue-limit-restart');
  const clock = { now: T0 };
  const first = limitQueue(w, clock);
  await w.jobs.write(parked('app', 'P-1', iso(T0 - 1000), iso(T0 + 1000)));
  await first.queue.schedule();
  await first.queue.idle();
  first.queue.close();
  assert.equal((await w.jobs.read('app', 'P-1'))!.state, 'waiting_limit');
  clock.now = T0 + 5000;
  const second = limitQueue(w, clock);
  try {
    await second.queue.schedule();
    await second.queue.idle();
    assert.deepEqual(w.execution.resets, ['app/P-1 resume']);
    assert.deepEqual(second.notes, ['Usage limit reset: 1 job resumed']);
  } finally {
    second.queue.close();
  }
});

test('sf queue on-limit (SF-072): the rule is checked by the CLI, stored by sf serve and shown by sf queue list', TIMEOUT, async () => {
  const env = await newEnv('queue-on-limit');
  await newRepo(env, 'queue-on-limit-repo', false);
  const served = await serve(env);
  try {
    assert.equal((await runCli(env, ['queue', 'on-limit', 'wait'])).stdout, 'on_limit: wait\n');
    assert.match((await runCli(env, ['queue', 'list'])).stdout, /^held: no\non limit reset: wait$/m);
    assert.equal(JSON.parse(await readFile(join(env.state, 'queue.json'), 'utf8')).on_limit, 'wait');
    const bad = await runCli(env, ['queue', 'on-limit', 'later']);
    assert.deepEqual([bad.code, /queue on-limit needs resume-then-queue\|resume-only\|wait\./.test(bad.stderr)], [2, true]);
    assert.equal(JSON.parse(await readFile(join(env.state, 'queue.json'), 'utf8')).on_limit, 'wait');
  } finally {
    await stop(served);
  }
});

test('an invalid queue.json is an error; a missing one is an empty queue whose limit is SF_MAX_JOBS within 1-20', async () => {
  const env = await newEnv('queue-file');
  await mkdir(env.state, { recursive: true });
  assert.deepEqual(await new QueueStore(env.state, 3).read(), { version: 1, max_running: 3, held: false, hold_reason: null, on_limit: 'resume-then-queue', entries: [], errors: [] });
  assert.equal((await new QueueStore(env.state, 50).read()).max_running, 20);
  await writeFile(join(env.state, 'queue.json'), '{"version": 1, "max_running": 0, "held": false, "hold_reason": null, "entries": [], "errors": []}');
  await assert.rejects(new QueueStore(env.state, 3).read(), { code: 'queue_invalid' });
  await writeFile(join(env.state, 'queue.json'), 'not json');
  await assert.rejects(new QueueStore(env.state, 3).read(), { code: 'queue_invalid' });
  // A queue.json written before SF-072 has no on_limit: the default; an unknown rule is invalid.
  await writeFile(join(env.state, 'queue.json'), '{"version": 1, "max_running": 2, "held": false, "hold_reason": null, "entries": [], "errors": []}');
  assert.equal((await new QueueStore(env.state, 3).read()).on_limit, 'resume-then-queue');
  await writeFile(join(env.state, 'queue.json'), '{"version": 1, "max_running": 2, "held": false, "hold_reason": null, "on_limit": "later", "entries": [], "errors": []}');
  await assert.rejects(new QueueStore(env.state, 3).read(), { code: 'queue_invalid' });
});

// Waits until the queue's start of the ticket has made its job.
async function started(env: Env, ticket: string): Promise<void> {
  const jobs = new JobStore(env.state);
  const deadline = Date.now() + 20_000;
  while ((await jobs.read('app', ticket)) === undefined) {
    assert.ok(Date.now() < deadline, `${ticket} did not start`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// sf serve end to end: the queue's own start is limited, a start by hand, a resume or sf say on a
// needs_human job never; the job a runner takes to ready_for_human_review frees the slot (the
// coordinator's acceptance check); the queue and its limit survive a restart.
test('sf serve: queue two tickets with limit 1, the second starts by itself once the first is ready for review; starts by hand and sf say go over the limit', END_TO_END_TIMEOUT, async () => {
  const env = await newEnv('queue-serve');
  const repo = await newRepo(env, 'queue-serve-repo', true);
  for (const ticket of ['Q-1', 'Q-2', 'M-1', 'M-2']) {
    await putTask(env, repo, ticket, `Job ${ticket}`);
  }
  // The queue starts a ticket whose plan is ready (SF-086): Q-1 and Q-2 have a ready check.
  for (const ticket of ['Q-1', 'Q-2']) {
    await readyCheck(env, repo, ticket);
  }
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, 'S-1', `${task('S-1', 'Skeleton')}\n## Status: waiting for the Context owner\n`, new JobStore(env.state));
  const mrText = (ticket: string): string => [
    `feat(${ticket}): Job ${ticket}`, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'npm test: passed', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
  await script(env, [
    { permissionMode: 'default' },
    { write: { 'q1.txt': 'q1\n' }, text: 'Q-1 iteration 1' },
    { delayMs: 1500, write: { 'm2.txt': 'm2\n' }, text: 'M-2 iteration 1' },
    { write: { 'm1.txt': 'm1\n' }, text: 'M-1 after say' },
    { write: { '.software-factory/Q-1.mr.md': mrText('Q-1') }, text: 'MR text' },
    { write: { 'q2.txt': 'q2\n' }, text: 'Q-2 iteration 1' },
  ]);
  let served = await serve(env);
  try {
    assert.equal((await runCli(env, ['queue', 'limit', '1'])).stdout, 'max_running: 1\n');
    assert.equal((await runCli(env, ['queue', 'limit', '0'])).code, 1);
    // M-1 by hand ends in needs_human (it does not run).
    await call(served, 'start', { workspace: 'app', ticket: 'M-1' });
    await waitFor(served, 'M-1', 'needs_human');
    assert.equal((await runCli(env, ['queue', 'add', 'app', 'Q-1'])).stdout, 'position: 1\n');
    await started(env, 'Q-1');
    await waitFor(served, 'Q-1', 'awaiting_review', 1);
    // The Context owner's tools: queue_add with its refusals, queue_list.
    assert.deepEqual(await call(served, 'queue_add', { workspace: 'app', ticket: 'Q-2' }), { position: 1 });
    assert.equal((await refused(served, 'queue_add', { workspace: 'app', ticket: 'Q-2' })).code, 'already_queued');
    assert.equal((await refused(served, 'queue_add', { workspace: 'app', ticket: 'Q-1' })).code, 'job_exists');
    assert.equal((await refused(served, 'queue_add', { workspace: 'app', ticket: 'S-1' })).code, 'task_draft');
    assert.equal((await refused(served, 'queue_add', { workspace: 'app', ticket: 'Q-9' })).code, 'task_not_found');
    const listed = await call(served, 'queue_list', {});
    assert.deepEqual({ ...listed, entries: listed.entries.map(({ queued_at: _at, ...entry }: Record<string, unknown>) => entry) }, {
      max_running: 1, running: 1, held: false, entries: [{ workspace: 'app', ticket: 'Q-2', position: 1, waits_for: [] }],
    });
    // The limit is reached: a start by hand still goes, and so does sf say on the needs_human job.
    assert.equal((await call(served, 'start', { workspace: 'app', ticket: 'M-2' })).state, 'working');
    await turnsStarted(env, 3);
    const said = await runCli(env, ['say', 'app', 'M-1', 'go', 'on']);
    assert.equal(said.code, 0, said.stderr);
    const list = await runCli(env, ['queue', 'list']);
    assert.match(list.stdout, /^limit: 1 job at once\nrunning: 3\nheld: no\non limit reset: resume-then-queue\nnext: app\/Q-2\nqueue:\n {2}1\. app\/Q-2\n$/);
    assert.equal((await refused(served, 'start', { workspace: 'app', ticket: 'M-2' })).code, 'job_exists');
    await waitFor(served, 'M-2', 'awaiting_review', 1);
    await waitFor(served, 'M-1', 'awaiting_review', 1);
    await runCli(env, ['abort', 'app', 'M-2']);
    await runCli(env, ['abort', 'app', 'M-1']);
    // Held across a restart: nothing starts.
    assert.equal((await runCli(env, ['queue', 'hold', 'until', 'tomorrow'])).code, 0);
    await stop(served);
    served = await serve(env);
    assert.match((await runCli(env, ['queue', 'list'])).stdout, /^limit: 1 job at once\nrunning: 1\nheld: yes \(until tomorrow\)\n/);
    assert.equal((await runCli(env, ['queue', 'release'])).code, 0);
    // Q-1 is clean; its MR turn runs in the runner, which takes it to ready_for_human_review: the
    // slot frees and Q-2 starts by itself.
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'Q-1' });
    await waitFor(served, 'Q-1', 'ready_for_human_review');
    await started(env, 'Q-2');
    await waitFor(served, 'Q-2', 'awaiting_review', 1);
    assert.match((await runCli(env, ['queue', 'list'])).stdout, /^limit: 1 job at once\nrunning: 1\nheld: no\non limit reset: resume-then-queue\nnext: nothing ready\nqueue: empty\n$/);
    const file = JSON.parse(await readFile(join(env.state, 'queue.json'), 'utf8'));
    assert.deepEqual([file.max_running, file.entries, file.held], [1, [], false]);
    await turnsStarted(env, 6);
  } finally {
    await runCli(env, ['abort', 'app', 'Q-2']);
    await runCli(env, ['abort', 'app', 'Q-1']);
    await stop(served);
  }
});

test('SF-130: with the plan check of sf serve, a small queued ticket with no check record starts; one with a not_ready record of its current version is held', TIMEOUT, async () => {
  let checks!: TaskChecks;
  const w = await world('queue-not-needed', { planCheck: (workspace, ticket) => planCheck(checks, undefined, workspace, ticket) });
  checks = new TaskChecks({
    resolve: (name) => resolveWorkspace(name, w.env.config), claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 1, rulesMaxBytes: 49152,
    stateDir: w.env.state, configDir: w.env.config, worktreeRoot: join(w.env.state, 'worktrees'),
  });
  const workspace = await resolveWorkspace('app', w.env.config);
  const small = (ticket: string): string => task(ticket, `Job ${ticket}`).replace('base: main\n', 'base: main\nscope: [README.md]\n');
  await writeTask(workspace, 'S-1', small('S-1'), w.jobs);
  await writeTask(workspace, 'S-2', small('S-2'), w.jobs);
  const at = new Date().toISOString();
  await checks.store.write({
    workspace: 'app', ticket: 'S-2', sha256: taskSha256(small('S-2')), commit: null, status: 'checked', error: null, model: null, cost_usd: 0.5, started_at: at, ended_at: at,
    output: { paraphrase: 'p', findings: [{ kind: 'decision', severity: 'blocker', where: 'w', problem: 'p', expected: 'e' }], files: [], verdict: 'not_ready' },
  });
  await w.queue.hold();
  await w.queue.add('app', 'S-1');
  await w.queue.add('app', 'S-2');
  assert.deepEqual((await w.queue.view()).entries.map((row) => [row.ticket, row.plan_reason]), [['S-1', null], ['S-2', 'plan not ready: 1 blocker, 0 major']]);
  await w.queue.release();
  await w.queue.idle();
  assert.deepEqual(w.execution.starts, ['app/S-1']);
  assert.deepEqual(await queued(w), ['app/S-2']);
});
