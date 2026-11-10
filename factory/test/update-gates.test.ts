// The updating marker's gates (SF-101): the run queue's pass (no start, no limit reset, the reset
// timer armed again) and the automatic Task checks (not started, the trigger recorded) as units;
// then sf serve end to end with the fake Claude Code: the socket commands and dashboard POSTs that
// change something refuse with update_in_progress while pause, mr-status and the reads answer;
// sf check-task and sf attach refuse; sf status shows the marker; serve-busy lists a running Task
// check; the catch-up once the CLI removed the marker (the parked job resumed by a scheduler pass,
// the skipped automatic check run); and sf serve started under each marker phase, with a live and a
// dead update pid, and a draining update that dies while sf serve runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { callSocket } from '../src/ipc.js';
import { type Job, type JobState, JobStore, now } from '../src/jobs.js';
import { startTime } from '../src/pid-lock.js';
import { QueueStore, RunQueue } from '../src/queue.js';
import type { Workspace } from '../src/registry.js';
import { CheckStore } from '../src/task-check.js';
import { type AutoCheckRunner, AutoChecks } from '../src/task-check-auto.js';
import { type JobRef, markerPath, readMarker, readSkippedChecks, recordSkippedCheck, SKIPPED_CHECKS_FILE, type UpdateMarker, type UpdatePhase, writeMarker } from '../src/update.js';
import { act } from './support/dashboard-client.js';
import { type Env, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, temp, turnsStarted } from './support/harness.js';

const LONG = 60_000;
const COMMIT = 'b'.repeat(40);
const E2E = { timeout: 120_000 };

async function until(what: string, condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function marker(phase: UpdatePhase, pid: number, paused: JobRef[], pidStart: string | null = startTime(pid) ?? null): UpdateMarker {
  return { phase, pid, pid_start: pidStart, start_commit: COMMIT, paused, at: now() };
}

async function deadPid(): Promise<number> {
  const child = spawn('true', [], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

function jobRecord(workspace: string, ticket: string, state: JobState, extra: Partial<Job> = {}): Job {
  const at = now();
  return {
    workspace, ticket, branch: `${ticket}-x`, base: 'main', continues: null, base_commit: COMMIT, worktree: null, prepared_commit: null, target_commit: null, mr_attempts: 0, mr_conflict_turn: false,
    fixes: 0, gate_fixes: 0, gate_tokens: 0, state, iteration: 1, session_id: null, mr: null, created_at: at, updated_at: at, ...extra,
  };
}

// ------------------------------------------------------------------ the run queue's pass

async function queueWorld(name: string): Promise<{ dir: string; jobs: JobStore; store: QueueStore; workspace: Workspace }> {
  const dir = join(temp, `gates-${name}`);
  const checkout = join(dir, 'checkout');
  await mkdir(join(checkout, '.software-factory'), { recursive: true });
  await writeFile(join(checkout, '.software-factory', 'Q-1.md'), '---\nticket: Q-1\ntitle: Queued\nbase: main\n---\n\n# Q-1\n\nGo.\n');
  const store = new QueueStore(join(dir, 'state'), 3);
  const queue = await store.read();
  await store.write({ ...queue, entries: [{ workspace: 'app', ticket: 'Q-1', queued_at: now() }] });
  return { dir, jobs: new JobStore(join(dir, 'state')), store, workspace: { name: 'app', readCheckout: checkout, workCheckout: checkout } };
}

function parkedRecord(ticket: string, resetsAt: number): Job {
  const at = new Date(Date.now() - 60_000).toISOString();
  return jobRecord('app', ticket, 'waiting_limit', { paused: { from: 'working', step: 'turn', at }, limit: { provider: 'claude', resets_at: new Date(resetsAt).toISOString() } });
}

function fakeQueue(w: Awaited<ReturnType<typeof queueWorld>>, updating: () => boolean, hooks: { onPlan?: () => void; onReset?: () => void } = {}): { queue: RunQueue; calls: string[]; notes: number } {
  const calls: string[] = [];
  const out = { queue: undefined as unknown as RunQueue, calls, notes: 0 };
  const execution = {
    start: async (workspace: string, ticket: string) => {
      calls.push(`start ${workspace}/${ticket}`);
      await w.jobs.write(jobRecord(workspace, ticket, 'working'));
      return { branch: `${ticket}-x`, state: 'working' as const, check_after_minutes: 15, worktree: '/w' };
    },
    fetchBase: async () => undefined,
    limitReset: async (workspace: string, ticket: string) => {
      calls.push(`limitReset ${workspace}/${ticket}`);
      hooks.onReset?.();
      const job = (await w.jobs.read(workspace, ticket))!;
      const { limit: _limit, ...rest } = job;
      await w.jobs.write({ ...rest, state: 'working' });
      return 'resumed' as const;
    },
  };
  const setup = { dependencyStates: async () => [], lastJobBase: async () => undefined };
  out.queue = new RunQueue(w.store, execution as never, setup as never, w.jobs, {
    resolve: async () => w.workspace,
    notify: async () => void (out.notes += 1),
    planCheck: async () => {
      hooks.onPlan?.();
      return { state: 'ready', blockers: 0, majors: 0 };
    },
    updating,
  });
  return out;
}

test('the run queue under the marker: no start, no limitReset, no notification or hold; the reset timer is armed again, so the parked job resumes once the marker is gone', async () => {
  const w = await queueWorld('queue-rearm');
  let marked = true;
  const resetsAt = Date.now() + 400;
  await w.jobs.write(parkedRecord('P-1', resetsAt));
  const run = fakeQueue(w, () => marked);
  try {
    await run.queue.schedule();
    assert.deepEqual(run.calls, []);
    // The reset passes under the marker: the timer's pass applies nothing and arms again.
    await sleep(600);
    await run.queue.idle();
    assert.deepEqual(run.calls, []);
    assert.equal((await w.jobs.read('app', 'P-1'))!.state, 'waiting_limit');
    assert.equal(run.notes, 0);
    const held = await w.store.read();
    assert.deepEqual([held.held, held.entries.length], [false, 1]);
    // The marker goes: the catch-up's pass resumes the parked job, then starts the queued ticket.
    marked = false;
    await run.queue.schedule();
    await run.queue.idle();
    assert.deepEqual(run.calls, ['limitReset app/P-1', 'start app/Q-1']);
    assert.equal(run.notes, 1);
  } finally {
    run.queue.close();
  }
});

test('the run queue looks at the marker again right before each start and each limitReset', async () => {
  const w = await queueWorld('queue-again');
  let marked = false;
  // The marker comes while the pass looks at the plan: the start does not happen.
  const first = fakeQueue(w, () => marked, { onPlan: () => void (marked = true) });
  try {
    await first.queue.schedule();
    assert.deepEqual(first.calls, []);
    assert.equal((await w.store.read()).entries.length, 1);
  } finally {
    first.queue.close();
  }
  // Two parked jobs due; the marker comes during the first reset: the second is not reset.
  marked = false;
  await w.jobs.write(parkedRecord('P-1', Date.now() - 1000));
  await w.jobs.write(parkedRecord('P-2', Date.now() - 500));
  const second = fakeQueue(w, () => marked, { onReset: () => void (marked = true) });
  try {
    await second.queue.schedule();
    assert.deepEqual(second.calls, ['limitReset app/P-1']);
    assert.equal((await w.jobs.read('app', 'P-2'))!.state, 'waiting_limit');
  } finally {
    second.queue.close();
  }
});

// ------------------------------------------------------------------ the automatic checks

test('an automatic Task check due under the marker is not started; its trigger is recorded for the catch-up', async () => {
  const dir = join(temp, 'gates-auto');
  const checkout = join(dir, 'checkout');
  const state = join(dir, 'state');
  await mkdir(join(checkout, '.software-factory'), { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(join(checkout, '.software-factory', 'K-1.md'), '---\nticket: K-1\ntitle: Check\nbase: main\n---\n\n# K-1\n\nGo.\n');
  const starts: string[] = [];
  const runner: AutoCheckRunner = {
    store: new CheckStore(state),
    startAuto: async (workspace, ticket) => {
      starts.push(`${workspace}/${ticket}`);
      return { started: true, sha256: '', ended: new Promise(() => undefined) };
    },
    isRunning: () => false,
    runningCount: () => 0,
    observe: () => undefined,
  };
  let marked = true;
  // Every check is due at once, on the next turn of the event loop.
  const timers = { setTimeout: (callback: () => void) => setImmediate(callback), clearTimeout: (handle: unknown) => clearImmediate(handle as NodeJS.Immediate) };
  const settled = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
    await auto.idle();
  };
  const auto = new AutoChecks({
    checks: runner, jobs: new JobStore(state), resolve: async () => ({ name: 'app', readCheckout: checkout, workCheckout: checkout }), workspaces: async () => [], parallel: 1, timers,
    update: { updating: () => marked, skipped: (workspace, ticket) => recordSkippedCheck(state, { workspace, ticket }) },
  });
  try {
    auto.trigger('app', 'K-1');
    await settled();
    assert.deepEqual(starts, []);
    assert.deepEqual(await readSkippedChecks(state), [{ workspace: 'app', ticket: 'K-1' }]);
    assert.equal(auto.isPending('app', 'K-1'), false);
    // Recorded once, however often it is skipped.
    auto.trigger('app', 'K-1');
    await settled();
    assert.deepEqual(await readSkippedChecks(state), [{ workspace: 'app', ticket: 'K-1' }]);
    marked = false;
    auto.trigger('app', 'K-1');
    await settled();
    assert.deepEqual(starts, ['app/K-1']);
  } finally {
    auto.close();
  }
});

// ------------------------------------------------------------------ sf serve end to end

const paused = async (env: Env, ticket: string): Promise<JobState | undefined> => (await new JobStore(env.state).read('app', ticket))?.state;

// Starts the tickets one after another with a long first turn each, then pauses them.
async function startAndPause(env: Env, tickets: string[]): Promise<void> {
  let started = 0;
  for (const ticket of tickets) {
    const result = await runCli(env, ['start', 'app', ticket]);
    assert.equal(result.code, 0, result.stderr);
    started += 1;
    await turnsStarted(env, started);
  }
  for (const ticket of tickets) {
    const result = await runCli(env, ['pause', 'app', ticket]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await paused(env, ticket), 'paused');
  }
}

const socket = (env: Env, command: string, args: string[] = []): ReturnType<typeof callSocket> => callSocket(env.state, { command, args });

test('sf serve started under each marker phase: gated while the update lives or was interrupted, the recorded jobs resumed for restart_pending and a dead draining update, a user\'s paused job left alone', E2E, async () => {
  const env = await newEnv('gates-phases', { SF_TEST_MARKER_POLL_MS: '200' });
  const repo = await newRepo(env, 'gates-phases-repo', false);
  const tickets = ['P-1', 'D-1', 'R-1', 'U-1'];
  for (const ticket of tickets) {
    await putTask(env, repo, ticket, `Ticket ${ticket}`);
  }
  await script(env, [
    ...tickets.map((ticket) => ({ delayMs: LONG, write: { [`${ticket}-never.txt`]: 'x\n' } })),
    ...[1, 2, 3].map((n) => ({ write: { [`resumed-${n}.txt`]: 'r\n' }, text: 'Went on.' })),
  ]);
  let served = await serve(env);
  await startAndPause(env, tickets);
  await stop(served);

  const pausedAll = async (...which: string[]): Promise<void> => {
    for (const ticket of which) {
      assert.equal(await paused(env, ticket), 'paused', ticket);
    }
  };
  // The phases under which the marker stays: the gates apply, nothing is resumed.
  const live = process.pid;
  const dead = await deadPid();
  const gated: Array<[UpdatePhase, number, string | null]> = [['draining', live, startTime(live) ?? null], ['building', live, startTime(live) ?? null], ['building', dead, '1'], ['rollback_failed', dead, '1']];
  for (const [phase, pid, pidStart] of gated) {
    const written = marker(phase, pid, [{ workspace: 'app', ticket: 'D-1' }], pidStart);
    await writeMarker(env.state, written);
    served = await serve(env);
    try {
      const resumed = await socket(env, 'resume', ['app', 'D-1']);
      assert.equal(resumed.ok ? 'ok' : resumed.error.code, 'update_in_progress', phase);
      await sleep(400);
      assert.deepEqual(await readMarker(env.state), written, phase);
      await pausedAll('P-1', 'D-1', 'R-1', 'U-1');
      if (pid === dead) {
        assert.match(served.output, /update interrupted/, phase);
      }
      const status = await runCli(env, ['status']);
      assert.match(status.stdout, new RegExp(`update: ${phase}`));
    } finally {
      await stop(served);
    }
  }

  // draining with its pid dead at the start: the marker removed, the recorded job resumed.
  await writeMarker(env.state, marker('draining', dead, [{ workspace: 'app', ticket: 'D-1' }], '1'));
  served = await serve(env);
  try {
    await until('D-1 to be resumed', async () => (await paused(env, 'D-1')) === 'awaiting_review');
    assert.equal(existsSync(markerPath(env.state)), false);
    await pausedAll('P-1', 'R-1', 'U-1');

    // draining with a live update pid while sf serve runs, which then dies: the poll resumes P-1.
    const updater = spawn('sleep', ['60'], { stdio: 'ignore' });
    await new Promise((resolve) => updater.once('spawn', resolve));
    await writeMarker(env.state, marker('draining', updater.pid!, [{ workspace: 'app', ticket: 'P-1' }]));
    await sleep(500);
    assert.equal(await paused(env, 'P-1'), 'paused');
    const refused = await socket(env, 'resume', ['app', 'U-1']);
    assert.equal(refused.ok ? 'ok' : refused.error.code, 'update_in_progress');
    updater.kill('SIGKILL');
    await until('P-1 to be resumed after the update died', async () => (await paused(env, 'P-1')) === 'awaiting_review');
    assert.equal(existsSync(markerPath(env.state)), false);
    await pausedAll('R-1', 'U-1');
  } finally {
    await stop(served);
  }

  // restart_pending (the update built and asked for the restart): finished at the start.
  await writeMarker(env.state, marker('restart_pending', live, [{ workspace: 'app', ticket: 'R-1' }]));
  served = await serve(env);
  try {
    await until('R-1 to be resumed', async () => (await paused(env, 'R-1')) === 'awaiting_review');
    assert.equal(existsSync(markerPath(env.state)), false);
    assert.match(served.output, /finishing the update/);
    // The user's own pause stays.
    await pausedAll('U-1');
  } finally {
    await stop(served);
  }
});

test('while the marker exists, sf serve refuses the commands that change something and the dashboard POSTs; pause, mr-status and the reads answer; sf check-task and sf attach refuse; sf status shows it', E2E, async () => {
  const env = await newEnv('gates-commands', { SF_TEST_MARKER_POLL_MS: '200' });
  const repo = await newRepo(env, 'gates-commands-repo', false);
  for (const ticket of ['W-1', 'Y-1', 'N-1']) {
    await putTask(env, repo, ticket, `Ticket ${ticket}`);
  }
  await script(env, [{ delayMs: LONG, write: { 'w.txt': 'x\n' } }, { delayMs: LONG, write: { 'y.txt': 'x\n' } }]);
  const served = await serve(env);
  try {
    await runCli(env, ['start', 'app', 'W-1']);
    await turnsStarted(env, 1);
    await runCli(env, ['start', 'app', 'Y-1']);
    await turnsStarted(env, 2);
    assert.equal((await runCli(env, ['pause', 'app', 'Y-1'])).code, 0);
    await writeMarker(env.state, marker('draining', process.pid, []));

    for (const [command, args] of [['start', ['app', 'N-1']], ['restart', ['app', 'Y-1']], ['resume', ['app', 'Y-1']], ['say', ['app', 'W-1', 'hello']], ['queue-add', ['app', 'N-1']], ['abort', ['app', 'W-1']]] as const) {
      const response = await socket(env, command, [...args]);
      assert.equal(response.ok ? 'ok' : response.error.code, 'update_in_progress', command);
    }
    const cli = await runCli(env, ['start', 'app', 'N-1']);
    assert.equal(cli.code, 1);
    assert.match(cli.stderr, /update_in_progress/);
    const jobs = new JobStore(env.state);
    assert.equal(await jobs.read('app', 'N-1'), undefined);
    assert.equal((await jobs.read('app', 'W-1'))!.state, 'working');
    assert.equal((await jobs.read('app', 'Y-1'))!.state, 'paused');
    assert.deepEqual((await new QueueStore(env.state, 3).read()).entries, []);

    // The reads and the update's own tools answer.
    for (const command of ['ping', 'queue-list', 'serve-busy']) {
      const response = await socket(env, command);
      assert.equal(response.ok, true, command);
    }
    assert.deepEqual((await socket(env, 'serve-busy')).ok && (await socket(env, 'serve-busy') as { result: unknown }).result, { checks: [], handovers: [] });
    const mrStatus = await socket(env, 'mr-status', ['app', 'W-1']);
    assert.notEqual(mrStatus.ok ? 'ok' : mrStatus.error.code, 'update_in_progress');

    // The dashboard: a changing POST is refused, Pause and mr-status go through.
    const say = await act(served.dashboard!, 'api/jobs/app/W-1/say', { message: 'hello' });
    assert.equal(say.status, 409);
    assert.equal(JSON.parse(say.body).error.code, 'update_in_progress');
    const hold = await act(served.dashboard!, 'api/queue/hold', { reason: 'x' });
    assert.equal(JSON.parse(hold.body).error?.code, 'update_in_progress');
    const mr = await act(served.dashboard!, 'api/jobs/app/W-1/mr-status', {});
    assert.notEqual(JSON.parse(mr.body).error?.code, 'update_in_progress');
    const pause = await act(served.dashboard!, 'api/jobs/app/W-1/pause', {});
    assert.equal(pause.status, 200, pause.body);
    assert.equal((await jobs.read('app', 'W-1'))!.state, 'paused');

    // The CLI commands that run in their own process.
    const check = await runCli(env, ['check-task', 'app', 'N-1']);
    assert.equal(check.code, 1);
    assert.match(check.stderr, /update_in_progress/);
    const image = join(env.home, 'shot.png');
    await writeFile(image, Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'));
    const attach = await runCli(env, ['attach', 'app', 'N-1', image]);
    assert.equal(attach.code, 1);
    assert.match(attach.stderr, /update_in_progress/);
    assert.equal(existsSync(join(repo, '.software-factory', 'N-1')), false);

    const status = await runCli(env, ['status']);
    assert.match(status.stdout, /^update: draining \(sf update pid \d+, running/m);
    const one = await runCli(env, ['status', 'app', 'W-1']);
    assert.match(one.stdout, /^update: draining/m);

    // The marker goes: the commands work again.
    await rm(markerPath(env.state));
    const resumed = await socket(env, 'queue-add', ['app', 'N-1']);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal((await runCli(env, ['status'])).stdout.includes('update:'), false);
  } finally {
    await stop(served);
  }
});

test('when the CLI removes the marker while sf serve runs, the catch-up resumes the parked job by a scheduler pass and runs the skipped automatic check; serve-busy lists it while it runs', E2E, async () => {
  const env = await newEnv('gates-catchup', { SF_TEST_MARKER_POLL_MS: '200', SF_TASK_CHECK_AUTO: 'on', SF_TEST_TASK_CHECK_DELAY_MS: '100', SF_REVIEW_MODEL: 'fake-checker' });
  const repo = await newRepo(env, 'gates-catchup-repo', false);
  await mkdir(join(repo, '.software-factory'), { recursive: true });
  await putTask(env, repo, 'Z-1', 'Parked');
  await script(env, [{ delayMs: LONG, write: { 'z.txt': 'x\n' } }, { write: { 'z2.txt': 'z\n' }, text: 'Went on.' }]);
  await reviewScript(env, [{ output: { paraphrase: 'Fine.', findings: [], files: [], verdict: 'ready' }, delayMs: 1_500 }]);
  let served = await serve(env);
  await startAndPause(env, ['Z-1']);
  await stop(served);
  // Z-1 parked on a usage limit whose reset has passed.
  const jobs = new JobStore(env.state);
  const parkedJob = (await jobs.read('app', 'Z-1'))!;
  await jobs.write({ ...parkedJob, state: 'waiting_limit', limit: { provider: 'claude', resets_at: new Date(Date.now() - 60_000).toISOString() } });
  await writeMarker(env.state, marker('draining', process.pid, []));
  served = await serve(env);
  try {
    // A Task file written meanwhile: its automatic check is skipped and recorded.
    await writeFile(join(repo, '.software-factory', 'K-1.md'), '---\nticket: K-1\ntitle: Check me\nbase: main\n---\n\n# K-1\n\nChange the README.\n');
    await until('the skipped check to be recorded', async () => (await readSkippedChecks(env.state)).length === 1);
    await sleep(500);
    assert.equal((await jobs.read('app', 'Z-1'))!.state, 'waiting_limit');
    assert.equal((await reviewLog(env).catch(() => [])).length, 0);
    const queue = await socket(env, 'queue-list');
    assert.equal(queue.ok && (queue.result as { held: boolean }).held, false);

    // The CLI removes the marker (give-up, rollback or --abandon): the catch-up.
    await rm(markerPath(env.state));
    await until('the parked job to be resumed', async () => ['working', 'awaiting_review'].includes((await jobs.read('app', 'Z-1'))!.state));
    await until('the skipped check to run', async () => {
      const busy = await socket(env, 'serve-busy');
      return busy.ok && JSON.stringify(busy.result) === JSON.stringify({ checks: [{ workspace: 'app', ticket: 'K-1' }], handovers: [] });
    });
    await until('the check to end', async () => (await reviewLog(env).catch(() => [])).length === 1 && (await socket(env, 'serve-busy') as { result: { checks: unknown[] } }).result.checks.length === 0);
    assert.equal(existsSync(join(env.state, SKIPPED_CHECKS_FILE)), false);
  } finally {
    await stop(served);
  }
});

test('an sf serve whose start fails after it took a restart_pending marker puts the marker back', E2E, async () => {
  const env = await newEnv('gates-start-fails');
  await newRepo(env, 'gates-start-fails-repo', false);
  const taken = marker('restart_pending', await deadPid(), [{ workspace: 'app', ticket: 'R-1' }], '1');
  await writeMarker(env.state, taken);
  // The MCP port is taken: the start fails after the marker was read.
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  try {
    const port = (blocker.address() as { port: number }).port;
    env.extra = { SF_PORT: String(port) };
    const result = await runCli(env, ['serve']);
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(await readMarker(env.state), taken);
  } finally {
    blocker.close();
  }
});
