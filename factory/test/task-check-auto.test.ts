// The automatic Task checks (SF-086): the settings; AutoChecks with a fake clock and a fake runner
// (the 60 s debounce, one check per ticket, the cancels, the skips, the parallel limit, a manual
// Check that counts toward it, a trigger during a manual check, a re-check that runs only on a
// record of its kind); TaskChecks' automatic start (a cancelled run stores nothing, the running
// count, a manual Check that cancels a pending automatic one and is refused during a running one);
// the watcher of the .software-factory folders; the notification; then sf serve end to end with the
// fake Claude: write_task, the watcher and the run queue trigger one check each, and the board shows
// the verdict.
import assert from 'node:assert/strict';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { FactoryError } from '../src/errors.js';
import type { Job, JobState } from '../src/jobs.js';
import { type Notification, notifyTaskCheck, taskCheckNotification } from '../src/notify.js';
import type { Workspace } from '../src/registry.js';
import { type CheckRecord, CheckStore, TaskChecks, taskSha256 } from '../src/task-check.js';
import { AutoChecks, planCheck, type WatchFolder } from '../src/task-check-auto.js';
import { FakeClock, FakeRunner } from './support/auto-checks.js';
import { fetchRaw } from './support/dashboard-client.js';
import { type Env, newEnv, newRepo, reviewLog, reviewScript, runCli, serve, stop, task, temp } from './support/harness.js';

const MINUTE = 60_000;

const text = (ticket: string, body = 'Change the README.'): string => `---\nticket: ${ticket}\ntitle: Ticket ${ticket}\nbase: main\n---\n\n# ${ticket}\n\n${body}\n`;
const DRAFT = (ticket: string): string => `${text(ticket)}\n## Status: waiting for the Context owner\n`;

function checkRecord(workspace: string, ticket: string, content: string, verdict: 'ready' | 'not_ready' | 'failed'): CheckRecord {
  const at = new Date().toISOString();
  const findings = verdict === 'not_ready'
    ? [{ kind: 'decision' as const, severity: 'blocker' as const, where: 'w', problem: 'p', expected: 'e' }, { kind: 'missing' as const, severity: 'major' as const, where: 'w', problem: 'p', expected: 'e' }]
    : [];
  return {
    workspace, ticket, sha256: taskSha256(content), commit: null, status: verdict === 'failed' ? 'failed' : 'checked',
    output: verdict === 'failed' ? null : { paraphrase: 'p', findings, files: [], verdict },
    error: verdict === 'failed' ? 'The check ended with error_max_turns: limit\nsecond line' : null, model: null, cost_usd: null, started_at: at, ended_at: at,
  };
}

function jobOf(workspace: string, ticket: string, state: JobState): Job {
  const at = new Date().toISOString();
  return {
    workspace, ticket, branch: `${ticket}-x`, base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state, iteration: 0, session_id: null, mr: null, created_at: at, updated_at: at,
  };
}

interface Rig {
  dir: string;
  clock: FakeClock;
  runner: FakeRunner;
  jobs: Map<string, Job>;
  auto: AutoChecks;
  ended: CheckRecord[];
  put(ticket: string, content?: string): Promise<string>;
}

// Workspace app: a folder with its Task files, a fake runner, jobs by key and a fake clock.
async function rig(name: string, parallel = 1): Promise<Rig> {
  const dir = join(temp, name);
  await mkdir(join(dir, '.software-factory'), { recursive: true });
  const clock = new FakeClock();
  const runner = new FakeRunner(join(dir, 'state'));
  const jobs = new Map<string, Job>();
  const ended: CheckRecord[] = [];
  const workspace: Workspace = { name: 'app', readCheckout: dir, workCheckout: dir };
  const auto = new AutoChecks({
    checks: runner, jobs: { read: async (ws, ticket) => jobs.get(`${ws}/${ticket}`) }, resolve: async () => workspace, workspaces: async () => [],
    parallel, timers: clock, onCheckEnded: (record) => ended.push(record),
  });
  const put = async (ticket: string, content = text(ticket)): Promise<string> => {
    await writeFile(join(dir, '.software-factory', `${ticket}.md`), content);
    return content;
  };
  return { dir, clock, runner, jobs, auto, ended, put };
}

// Moves the clock, then lets the starts that follow settle.
async function advance(r: Rig, ms: number): Promise<void> {
  r.clock.advance(ms);
  await r.auto.idle();
}

test('the settings: SF_TASK_CHECK_AUTO on (default, also empty) or off, anything else invalid; SF_TASK_CHECK_PARALLEL 1-4, default 1', () => {
  const base = { HOME: temp, SF_GATE: 'off' };
  assert.deepEqual([loadConfig(base).taskCheckAuto, loadConfig(base).taskCheckParallel], [true, 1]);
  assert.equal(loadConfig({ ...base, SF_TASK_CHECK_AUTO: '' }).taskCheckAuto, true);
  assert.equal(loadConfig({ ...base, SF_TASK_CHECK_AUTO: 'on' }).taskCheckAuto, true);
  assert.equal(loadConfig({ ...base, SF_TASK_CHECK_AUTO: 'off' }).taskCheckAuto, false);
  assert.equal(loadConfig({ ...base, SF_TASK_CHECK_PARALLEL: '4' }).taskCheckParallel, 4);
  assert.equal(loadConfig({ ...base, SF_TASK_CHECK_PARALLEL: '' }).taskCheckParallel, 1);
  for (const env of [{ SF_TASK_CHECK_AUTO: 'maybe' }, { SF_TASK_CHECK_AUTO: 'OFF' }, { SF_TASK_CHECK_PARALLEL: '0' }, { SF_TASK_CHECK_PARALLEL: '5' }, { SF_TASK_CHECK_PARALLEL: 'two' }]) {
    assert.throws(() => loadConfig({ ...base, ...env }), (error: FactoryError) => error.code === 'invalid_config', JSON.stringify(env));
  }
});

test('the debounce: a check runs 60 s after the ticket\'s last trigger, once for a burst (write_task and its watcher event alike); pending until it starts', async () => {
  const r = await rig('auto-debounce');
  await r.put('T-1');
  r.auto.trigger('app', 'T-1');
  r.auto.trigger('app', 'T-1');
  assert.equal(r.auto.isPending('app', 'T-1'), true);
  await advance(r, 30_000);
  r.auto.trigger('app', 'T-1');
  await advance(r, 59_000);
  assert.deepEqual(r.runner.starts, []);
  assert.equal(r.auto.isPending('app', 'T-1'), true);
  await advance(r, 1_000);
  assert.deepEqual(r.runner.starts, ['auto app/T-1']);
  assert.deepEqual([r.auto.isPending('app', 'T-1'), r.runner.isRunning('app', 'T-1')], [false, true]);
  // Ready: stored, no notification; nothing more runs.
  await r.runner.end('app', 'T-1', checkRecord('app', 'T-1', text('T-1'), 'ready'));
  await advance(r, 10 * MINUTE);
  assert.deepEqual([r.runner.starts.length, r.ended], [1, []]);
  assert.equal(r.auto.isPending('app', 'T-1'), false);
});

test('a new trigger cancels a running automatic check (nothing stored) and schedules a new one; a job that starts (jobChanged) and cancel drop a pending and a running one', async () => {
  const r = await rig('auto-cancel');
  await r.put('T-1');
  r.auto.trigger('app', 'T-1');
  await advance(r, MINUTE);
  assert.deepEqual(r.runner.starts, ['auto app/T-1']);
  await r.put('T-1', text('T-1', 'Changed.'));
  r.auto.trigger('app', 'T-1');
  await r.auto.idle();
  // The run was aborted and ended storing nothing.
  assert.equal(r.runner.isRunning('app', 'T-1'), false);
  assert.equal(await r.runner.store.last('app', 'T-1'), undefined);
  assert.equal(r.auto.isPending('app', 'T-1'), true);
  await advance(r, MINUTE);
  assert.deepEqual(r.runner.starts, ['auto app/T-1', 'auto app/T-1']);
  // A job that waits for the user or is paused does not use the Task file now: nothing changes.
  for (const state of ['paused', 'aborted', 'failed', 'pushed'] as const) {
    r.auto.jobChanged(jobOf('app', 'T-1', state));
  }
  assert.equal(r.runner.isRunning('app', 'T-1'), true);
  // A job starts: the running automatic check is cancelled, nothing stored, nothing pending.
  r.auto.jobChanged(jobOf('app', 'T-1', 'starting'));
  await r.auto.idle();
  assert.deepEqual([r.runner.isRunning('app', 'T-1'), r.auto.isPending('app', 'T-1')], [false, false]);
  assert.equal(await r.runner.store.last('app', 'T-1'), undefined);
  // A pending one: dropped, it never fires (a job in any state it runs in, as with cancel).
  r.auto.trigger('app', 'T-1');
  r.auto.jobChanged(jobOf('app', 'T-1', 'needs_human'));
  assert.equal(r.auto.isPending('app', 'T-1'), false);
  r.auto.trigger('app', 'T-1');
  r.auto.cancel('app', 'T-1');
  assert.equal(r.auto.isPending('app', 'T-1'), false);
  await advance(r, 5 * MINUTE);
  assert.equal(r.runner.starts.length, 2);
  assert.deepEqual(r.ended, []);
});

test('when it fires, nothing runs for a missing file, a skeleton, a check record of any status for this version, or a running job; a paused job\'s file is checked', async () => {
  const r = await rig('auto-skip');
  await r.put('S-1', DRAFT('S-1'));
  const checked = await r.put('S-2');
  await r.runner.store.write(checkRecord('app', 'S-2', checked, 'ready'));
  const failed = await r.put('S-3');
  await r.runner.store.write(checkRecord('app', 'S-3', failed, 'failed'));
  await r.put('S-4');
  r.jobs.set('app/S-4', jobOf('app', 'S-4', 'working'));
  await r.put('S-5');
  r.jobs.set('app/S-5', jobOf('app', 'S-5', 'paused'));
  await r.put('S-6');
  r.jobs.set('app/S-6', jobOf('app', 'S-6', 'aborted'));
  for (const ticket of ['S-0', 'S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-6']) {
    r.auto.trigger('app', ticket);
  }
  await advance(r, MINUTE);
  assert.deepEqual(r.runner.starts, ['auto app/S-5']);
  await r.runner.end('app', 'S-5');
  await r.auto.idle();
  assert.deepEqual(r.runner.starts, ['auto app/S-5', 'auto app/S-6']);
  // Dropped, not deferred: none of them is pending, nothing more runs.
  assert.deepEqual(['S-0', 'S-1', 'S-2', 'S-3', 'S-4'].map((ticket) => r.auto.isPending('app', ticket)), [false, false, false, false, false]);
  await r.runner.end('app', 'S-6');
  await advance(r, 5 * MINUTE);
  assert.equal(r.runner.starts.length, 2);
});

test('a re-check runs on a record only of its kind: retry on a failed one, moved on a not_ready one; a running job still drops it', async () => {
  const r = await rig('auto-recheck-kind');
  const verdicts = { 'K-1': 'failed', 'K-2': 'not_ready', 'K-3': 'ready', 'K-4': 'failed', 'K-5': 'not_ready', 'K-6': 'failed' } as const;
  for (const [ticket, verdict] of Object.entries(verdicts)) {
    await r.runner.store.write(checkRecord('app', ticket, await r.put(ticket), verdict));
  }
  r.jobs.set('app/K-6', jobOf('app', 'K-6', 'working'));
  r.auto.trigger('app', 'K-1', 'retry');
  r.auto.trigger('app', 'K-2', 'moved');
  r.auto.trigger('app', 'K-3', 'retry');
  r.auto.trigger('app', 'K-4', 'moved');
  r.auto.trigger('app', 'K-5', 'retry');
  r.auto.trigger('app', 'K-6', 'retry');
  await advance(r, MINUTE);
  await r.runner.end('app', 'K-1');
  await r.auto.idle();
  assert.deepEqual(r.runner.starts, ['auto app/K-1', 'auto app/K-2']);
  await r.runner.end('app', 'K-2');
  await advance(r, 5 * MINUTE);
  assert.equal(r.runner.starts.length, 2);
  // A plain trigger after a re-check one asks for none: the record holds it.
  r.auto.trigger('app', 'K-1', 'retry');
  r.auto.trigger('app', 'K-1');
  await advance(r, MINUTE);
  assert.equal(r.runner.starts.length, 2);
});

test('the parallel limit: at most N automatic checks at once, the others wait in trigger order; a manual Check counts toward it and never waits', async () => {
  const r = await rig('auto-parallel', 2);
  for (const ticket of ['P-1', 'P-2', 'P-3', 'P-4']) {
    await r.put(ticket);
  }
  r.auto.trigger('app', 'P-3');
  await advance(r, 1_000);
  r.auto.trigger('app', 'P-1');
  await advance(r, 1_000);
  r.auto.trigger('app', 'P-2');
  await advance(r, MINUTE);
  assert.deepEqual(r.runner.starts, ['auto app/P-3', 'auto app/P-1']);
  assert.equal(r.auto.isPending('app', 'P-2'), true);
  // A manual Check goes at once, over the limit; the slot P-3 frees goes to it, so P-2 still waits.
  r.runner.manual('app', 'P-4');
  assert.equal(r.runner.runningCount(), 3);
  await r.runner.end('app', 'P-3');
  await r.auto.idle();
  assert.deepEqual(r.runner.starts, ['auto app/P-3', 'auto app/P-1', 'manual app/P-4']);
  await r.runner.end('app', 'P-4');
  await r.auto.idle();
  assert.deepEqual(r.runner.starts, ['auto app/P-3', 'auto app/P-1', 'manual app/P-4', 'auto app/P-2']);
  assert.equal(r.auto.isPending('app', 'P-2'), false);
});

test('a manual Check cancels the ticket\'s pending automatic check; a trigger during a manual check fires after it, and the same-version rule applies then', async () => {
  const r = await rig('auto-manual');
  const first = await r.put('M-1');
  r.auto.trigger('app', 'M-1');
  r.runner.manual('app', 'M-1');
  assert.equal(r.auto.isPending('app', 'M-1'), false);
  await advance(r, MINUTE);
  assert.deepEqual(r.runner.starts, ['manual app/M-1']);
  // A trigger while it runs: due after 60 s, it waits for the manual check.
  r.auto.trigger('app', 'M-1');
  await advance(r, 2 * MINUTE);
  assert.deepEqual([r.runner.starts.length, r.auto.isPending('app', 'M-1')], [1, true]);
  // The manual check stored a record of this version: the trigger is dropped.
  await r.runner.end('app', 'M-1', checkRecord('app', 'M-1', first, 'ready'));
  await r.auto.idle();
  assert.deepEqual([r.runner.starts.length, r.auto.isPending('app', 'M-1')], [1, false]);
  // The file changed during a manual check: after it, the new version is checked automatically.
  r.runner.manual('app', 'M-1');
  await r.put('M-1', text('M-1', 'Changed while checked.'));
  r.auto.trigger('app', 'M-1');
  await advance(r, MINUTE);
  await r.runner.end('app', 'M-1', checkRecord('app', 'M-1', first, 'ready'));
  await r.auto.idle();
  assert.deepEqual(r.runner.starts, ['manual app/M-1', 'manual app/M-1', 'auto app/M-1']);
});

test('the queue\'s trigger only for a ticket without a check of its current Task file, rescheduling a pending one and leaving a running one; the end of an automatic check: notified when not ready or failed, never when ready or cancelled', async () => {
  const r = await rig('auto-ended');
  const ready = await r.put('E-1');
  await r.runner.store.write(checkRecord('app', 'E-1', ready, 'ready'));
  await r.auto.triggerIfUnchecked('app', 'E-1');
  await r.auto.triggerIfUnchecked('app', 'E-404');
  assert.deepEqual([r.auto.isPending('app', 'E-1'), r.auto.isPending('app', 'E-404')], [false, false]);
  const two = await r.put('E-2');
  const three = await r.put('E-3');
  await r.auto.triggerIfUnchecked('app', 'E-2');
  r.auto.trigger('app', 'E-3');
  assert.deepEqual([r.auto.isPending('app', 'E-2'), r.auto.isPending('app', 'E-3')], [true, true]);
  // Already pending (Fix 4, R3): the queue's trigger reschedules it like every trigger, 60 s after it.
  await advance(r, 30_000);
  await r.auto.triggerIfUnchecked('app', 'E-2');
  await advance(r, 30_000);
  assert.deepEqual(r.runner.starts, ['auto app/E-3']);
  assert.equal(r.auto.isPending('app', 'E-2'), true);
  await advance(r, 29_000);
  assert.deepEqual(r.runner.starts, ['auto app/E-3']);
  // E-3 holds the only slot: E-2 waits for it once due.
  await r.runner.end('app', 'E-3', checkRecord('app', 'E-3', three, 'failed'));
  await r.auto.idle();
  await advance(r, 1_000);
  assert.deepEqual(r.runner.starts, ['auto app/E-3', 'auto app/E-2']);
  // A check of the ticket runs: the queue's trigger neither cancels nor reschedules it.
  await r.auto.triggerIfUnchecked('app', 'E-2');
  assert.deepEqual([r.runner.isRunning('app', 'E-2'), r.runner.aborted('app', 'E-2'), r.auto.isPending('app', 'E-2')], [true, false, false]);
  await r.runner.end('app', 'E-2', checkRecord('app', 'E-2', two, 'not_ready'));
  await r.auto.idle();
  assert.deepEqual(r.ended.map((record) => record.ticket), ['E-3', 'E-2']);
  // Cancelled: no record, no notification.
  await r.put('E-4');
  r.auto.trigger('app', 'E-4');
  await advance(r, MINUTE);
  r.auto.trigger('app', 'E-4');
  await r.auto.idle();
  assert.deepEqual(r.ended.map((record) => record.ticket), ['E-3', 'E-2']);
});

test('the notification: "plan not ready" with the counts as the board writes them, "plan check failed" with the first line of the error; none when ready; a failed channel is logged', async () => {
  const notReady = checkRecord('app', 'SF-086', 'x', 'not_ready');
  assert.deepEqual(taskCheckNotification(notReady), { title: 'SF-086: plan not ready', body: '1 blocker, 1 major · app', priority: 'default', tags: 'warning' });
  assert.deepEqual(taskCheckNotification(checkRecord('app', 'SF-086', 'x', 'failed')), { title: 'SF-086: plan check failed', body: 'The check ended with error_max_turns: limit', priority: 'default', tags: 'warning' });
  assert.equal(taskCheckNotification(checkRecord('app', 'SF-086', 'x', 'ready')), undefined);
  const sent: Notification[] = [];
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => logged.push(String(line));
  try {
    await notifyTaskCheck(notReady, { desktop: true, iterations: false, ntfyUrl: undefined, ntfyToken: undefined }, async (notification) => {
      sent.push(notification);
      return [{ channel: 'desktop', status: 'failed', message: 'notify-send exited with 1' }, { channel: 'ntfy', status: 'skipped', message: 'SF_NTFY_URL is not set' }];
    });
    await notifyTaskCheck(checkRecord('app', 'SF-086', 'x', 'ready'), { desktop: true, iterations: false, ntfyUrl: undefined, ntfyToken: undefined }, async (notification) => {
      sent.push(notification);
      return [];
    });
  } finally {
    console.error = original;
  }
  assert.deepEqual(sent.map((notification) => notification.title), ['SF-086: plan not ready']);
  assert.deepEqual(logged, ['app/SF-086: plan-check notification via desktop failed: notify-send exited with 1']);
});

test('Fix 1 R1: an automatic check\'s record is committed only when no cancel came first, a cancel during the write included; one after the commit leaves it', async () => {
  const dir = join(temp, 'auto-commit');
  const store = new CheckStore(dir);
  const record = checkRecord('app', 'K-1', text('K-1'), 'not_ready');
  const files = async (): Promise<string[]> => (await readdir(join(dir, 'checks', 'app', 'K-1')).catch(() => [])).sort();
  // Cancelled while the record is being written (the write has begun and awaits the disk).
  const during = new AbortController();
  const writing = store.writeUnless(record, during.signal);
  during.abort();
  assert.equal(await writing, undefined);
  assert.deepEqual(await files(), []);
  assert.equal(await store.read('app', 'K-1', record.sha256), undefined);
  // Cancelled before it began.
  const before = new AbortController();
  before.abort();
  assert.equal(await store.writeUnless(record, before.signal), undefined);
  assert.deepEqual(await files(), []);
  // Not cancelled: stored, no temp file left; a cancel after the commit changes nothing.
  const after = new AbortController();
  assert.equal(await store.writeUnless(record, after.signal), store.path('app', 'K-1', record.sha256));
  after.abort();
  assert.deepEqual(await files(), [`${record.sha256.slice(0, 16)}.json`]);
  assert.deepEqual(await store.read('app', 'K-1', record.sha256), record);
});

// A TaskChecks over workspace app whose resolve waits for release (block() holds it again); Task
// files in dir.
async function realChecks(name: string): Promise<{ checks: TaskChecks; dir: string; release: () => void; block: () => void; settled: string[] }> {
  const dir = join(temp, name);
  await mkdir(join(dir, '.software-factory'), { recursive: true });
  let open!: () => void;
  let gate!: Promise<void>;
  const block = (): void => {
    gate = new Promise<void>((resolve) => (open = resolve));
  };
  block();
  const settled: string[] = [];
  const checks = new TaskChecks({
    resolve: async () => {
      await gate;
      return { name: 'app', readCheckout: dir, workCheckout: dir };
    },
    claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 1, rulesMaxBytes: 49152, stateDir: join(dir, 'state'), configDir: join(dir, 'config'), worktreeRoot: join(dir, 'worktrees'),
    onSettled: (workspace, ticket) => settled.push(`${workspace}/${ticket}`),
  });
  return { checks, dir, release: () => open(), block, settled };
}

test('TaskChecks.startAuto: counted while it runs, refuses a manual Check of the ticket, stores its record (a bad base fails at once) and nothing when cancelled', async () => {
  const { checks, dir, release, settled } = await realChecks('auto-real');
  // base: a name that is not a branch, so the check fails before any session.
  const bad = (ticket: string): string => text(ticket).replace('base: main', 'base: -nope');
  await writeFile(join(dir, '.software-factory', 'R-1.md'), bad('R-1'));
  await writeFile(join(dir, '.software-factory', 'R-2.md'), bad('R-2'));
  const heard: string[] = [];
  checks.observe({ manualStart: (ws, ticket) => heard.push(`manual ${ws}/${ticket}`), ended: (ws, ticket) => heard.push(`ended ${ws}/${ticket}`) });
  const controller = new AbortController();
  const one = checks.startAuto('app', 'R-1', controller.signal);
  const cancelled = new AbortController();
  const two = checks.startAuto('app', 'R-2', cancelled.signal);
  assert.deepEqual([checks.runningCount(), checks.isRunning('app', 'R-1')], [2, true]);
  await assert.rejects(checks.start('app', 'R-1'), (error: FactoryError) => error.code === 'check_running');
  cancelled.abort();
  release();
  const [first, second] = await Promise.all([one, two]);
  const [stored, none] = await Promise.all([first.ended, second.ended]);
  assert.equal(stored?.status, 'failed');
  assert.match(stored!.error!, /base/);
  assert.equal(none, undefined);
  assert.equal((await checks.store.read('app', 'R-1', taskSha256(bad('R-1'))))?.status, 'failed');
  assert.equal(await checks.store.last('app', 'R-2'), undefined);
  assert.deepEqual([checks.runningCount(), settled.sort()], [0, ['app/R-1', 'app/R-2']]);
  assert.deepEqual(heard.sort(), ['ended app/R-1', 'ended app/R-2']);
  // A manual start is heard before it runs.
  await checks.start('app', 'R-2').then((started) => assert.deepEqual(Object.keys(started), ['started', 'sha256']));
  assert.equal(heard.includes('manual app/R-2'), true);
});

test('AutoChecks over TaskChecks: a manual Check cancels the pending automatic one; it is refused while the automatic one runs; the plan check of the queue', async () => {
  const { checks, dir, release, block } = await realChecks('auto-real-manual');
  const content = text('R-3').replace('base: main', 'base: -nope');
  await writeFile(join(dir, '.software-factory', 'R-3.md'), content);
  const clock = new FakeClock();
  const workspace: Workspace = { name: 'app', readCheckout: dir, workCheckout: dir };
  const auto = new AutoChecks({ checks, jobs: { read: async () => undefined }, resolve: async () => workspace, workspaces: async () => [], parallel: 1, timers: clock });
  release();
  assert.deepEqual(await planCheck(checks, auto, 'app', 'R-3'), { state: 'none', blockers: 0, majors: 0 });
  auto.trigger('app', 'R-3');
  assert.deepEqual((await planCheck(checks, auto, 'app', 'R-3')).state, 'checking');
  const manual = await checks.start('app', 'R-3');
  assert.equal(auto.isPending('app', 'R-3'), false);
  assert.equal(manual.started, true);
  const deadline = Date.now() + 10_000;
  while (checks.isRunning('app', 'R-3')) {
    assert.ok(Date.now() < deadline, 'the manual check did not end');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(await planCheck(checks, auto, 'app', 'R-3'), { state: 'failed', blockers: 0, majors: 0 });
  // A new version: the automatic check runs (held in its setup); a manual Check meanwhile is
  // check_running, and the plan is being checked.
  await writeFile(join(dir, '.software-factory', 'R-3.md'), `${content}More.\n`);
  block();
  auto.trigger('app', 'R-3');
  clock.advance(MINUTE);
  const until = Date.now() + 5_000;
  while (!checks.isRunning('app', 'R-3')) {
    assert.ok(Date.now() < until, 'the automatic check did not start');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(auto.isPending('app', 'R-3'), false);
  await assert.rejects(checks.start('app', 'R-3'), (error: FactoryError) => error.code === 'check_running');
  release();
  await auto.idle();
});

test('the watcher: a <ticket>.md directly in a workspace\'s .software-factory folder triggers; archive/, other names and deletions do not; new and removed workspaces at the re-read, a missing folder tried again', async () => {
  const clock = new FakeClock();
  const root = join(temp, 'auto-watch');
  const dirs = { a: join(root, 'a'), b: join(root, 'b'), c: join(root, 'c') };
  await mkdir(join(dirs.a, '.software-factory', 'archive'), { recursive: true });
  await mkdir(join(dirs.b, '.software-factory'), { recursive: true });
  const registered = [{ name: 'a', workCheckout: dirs.a }];
  const runner = new FakeRunner(join(root, 'state'));
  const auto = new AutoChecks({
    checks: runner, jobs: { read: async () => undefined }, resolve: async (name) => ({ name, readCheckout: join(root, name), workCheckout: join(root, name) }),
    workspaces: async () => [...registered], parallel: 1, timers: clock,
  });
  await auto.start();
  try {
    assert.deepEqual(auto.watched(), ['a']);
    const until = async (what: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!what()) {
        assert.ok(Date.now() < deadline, label);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await writeFile(join(dirs.a, '.software-factory', 'archive', 'W-2.md'), text('W-2'));
    await writeFile(join(dirs.a, '.software-factory', 'notes.txt'), 'x');
    await writeFile(join(dirs.a, '.software-factory', 'not a ticket.md'), 'x');
    await writeFile(join(dirs.a, '.software-factory', 'W-1.mr.md'), 'x');
    await writeFile(join(dirs.a, '.software-factory', 'W-1.md'), text('W-1'));
    await until(() => auto.isPending('a', 'W-1'), 'W-1 was not triggered');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual([auto.isPending('a', 'W-2'), auto.isPending('a', 'not a ticket'), auto.isPending('a', 'W-1.mr'), auto.isPending('a', 'archive')], [false, false, true, false]);
    // W-1.mr.md matches the ticket name W-1.mr: a trigger, dropped when it fires (no such Task file).
    auto.cancel('a', 'W-1.mr');
    // A deletion triggers nothing.
    auto.cancel('a', 'W-1');
    await rm(join(dirs.a, '.software-factory', 'W-1.md'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(auto.isPending('a', 'W-1'), false);
    // b is added (the dashboard's hook re-reads at once), c's folder does not exist yet.
    registered.push({ name: 'b', workCheckout: dirs.b }, { name: 'c', workCheckout: dirs.c });
    await auto.rereadWorkspaces();
    assert.deepEqual(auto.watched(), ['a', 'b']);
    await writeFile(join(dirs.b, '.software-factory', 'B-1.md'), text('B-1'));
    await until(() => auto.isPending('b', 'B-1'), 'B-1 was not triggered');
    await mkdir(join(dirs.c, '.software-factory'), { recursive: true });
    // The 60 s re-read watches c now and stops watching a, removed.
    registered.splice(0, 1);
    clock.advance(MINUTE);
    await auto.rereadWorkspaces();
    assert.deepEqual(auto.watched(), ['b', 'c']);
    await writeFile(join(dirs.a, '.software-factory', 'W-3.md'), text('W-3'));
    await writeFile(join(dirs.c, '.software-factory', 'C-1.md'), text('C-1'));
    await until(() => auto.isPending('c', 'C-1'), 'C-1 was not triggered');
    assert.equal(auto.isPending('a', 'W-3'), false);
  } finally {
    auto.close();
  }
  assert.deepEqual(auto.watched(), []);
});

test('a watch that breaks is taken down and made again at the next re-read', async () => {
  const clock = new FakeClock();
  const made: Array<{ dir: string; onError: () => void; closed: boolean }> = [];
  const watch: WatchFolder = (dir, _onName, onError) => {
    const entry = { dir, onError, closed: false };
    made.push(entry);
    return { close: () => (entry.closed = true) };
  };
  const auto = new AutoChecks({
    checks: new FakeRunner(join(temp, 'auto-watch-broken')), jobs: { read: async () => undefined }, resolve: async () => { throw new Error('unused'); },
    workspaces: async () => [{ name: 'a', workCheckout: '/srv/a' }], parallel: 1, timers: clock, watch,
  });
  await auto.start();
  assert.deepEqual([made.length, auto.watched()], [1, ['a']]);
  made[0]!.onError();
  assert.deepEqual([made[0]!.closed, auto.watched()], [true, []]);
  clock.advance(MINUTE);
  await auto.rereadWorkspaces();
  assert.deepEqual([made.length, made[1]!.dir, auto.watched()], [2, '/srv/a/.software-factory', ['a']]);
  auto.close();
});

// sf serve with the automatic check on, 300 ms after the last trigger.
async function autoEnv(name: string): Promise<{ env: Env; repo: string }> {
  const env = await newEnv(name, { SF_TASK_CHECK_AUTO: 'on', SF_TEST_TASK_CHECK_DELAY_MS: '300', SF_REVIEW_MODEL: 'fake-checker' });
  const repo = await newRepo(env, `${name}-repo`, false);
  // The folder exists when sf serve starts, so it is watched from the start.
  await mkdir(join(repo, '.software-factory'));
  return { env, repo };
}

const OUTPUT = { paraphrase: 'Greets the reader.', findings: [], files: [{ path: 'README.md', action: 'modify' }], verdict: 'ready' };

test('sf serve: a Task file written through write_task is checked without a click, once for the write and its watcher event; the board and task_check show the verdict', { timeout: 60_000 }, async () => {
  const { env, repo } = await autoEnv('auto-serve');
  await reviewScript(env, [{ output: OUTPUT, delayMs: 300 }, { output: { ...OUTPUT, findings: [{ kind: 'decision', severity: 'major', where: 'w', problem: 'p', expected: 'e' }] } }]);
  const served = await serve(env);
  try {
    const content = task('A-1', 'Automatic');
    const written = (await served.client.callTool({ name: 'write_task', arguments: { workspace: 'app', ticket: 'A-1', content } })).structuredContent as Record<string, unknown>;
    assert.deepEqual([written.check, written.check_after_seconds], ['scheduled', 60]);
    const taskCheck = async (): Promise<Record<string, any>> => (await served.client.callTool({ name: 'task_check', arguments: { workspace: 'app', ticket: 'A-1' } })).structuredContent as Record<string, any>;
    const first = await taskCheck();
    assert.deepEqual([first.verdict, first.pending || first.running], ['none', true]);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const read = await taskCheck();
      if (!read.pending && !read.running && read.verdict !== 'none') {
        assert.equal(read.verdict, 'ready');
        break;
      }
      assert.ok(Date.now() < deadline, 'the automatic check did not end');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const tickets = JSON.parse((await fetchRaw(new URL('api/tickets', served.dashboard!))).body).tickets as Array<Record<string, any>>;
    assert.deepEqual([tickets[0]!.check.state, tickets[0]!.check.stale], ['ready', false]);
    // Quiet for longer than the delay: still one session.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal((await reviewLog(env)).length, 1);
    // The same text again: already checked, nothing runs.
    const again = (await served.client.callTool({ name: 'write_task', arguments: { workspace: 'app', ticket: 'A-1', content } })).structuredContent as Record<string, unknown>;
    assert.equal(again.check, 'already_checked');
    // A file written without write_task (an editor): the watcher triggers its check.
    await writeFile(join(repo, '.software-factory', 'A-2.md'), task('A-2', 'By hand'));
    const until = Date.now() + 20_000;
    while ((await reviewLog(env).catch(() => [])).length < 2) {
      assert.ok(Date.now() < until, 'the watcher did not trigger a check');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // The queue (held, so nothing starts) shows why a ticket whose plan is not ready waits, until
    // Start anyway.
    assert.equal((await runCli(env, ['queue', 'hold'])).code, 0);
    const queuedA2 = await runCli(env, ['queue', 'add', 'app', 'A-2']);
    assert.equal(queuedA2.code, 0, queuedA2.stderr);
    const later = Date.now() + 20_000;
    let row: Record<string, any> | undefined;
    for (;;) {
      row = (JSON.parse((await fetchRaw(new URL('api/tickets', served.dashboard!))).body).tickets as Array<Record<string, any>>).find((entry) => entry.ticket === 'A-2');
      if (row?.queue_reason === 'plan not ready: 0 blocker, 1 major') {
        break;
      }
      assert.ok(Date.now() < later, `the queue reason did not come: ${JSON.stringify(row)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match((await runCli(env, ['queue', 'list'])).stdout, /1\. app\/A-2 {2}plan not ready: 0 blocker, 1 major\n/);
    assert.equal((await runCli(env, ['queue', 'force', 'app', 'A-2'])).stdout, 'force: true\n');
    assert.equal((await runCli(env, ['queue', 'force', 'app', 'A-9'])).code, 1);
    assert.equal((await runCli(env, ['queue', 'force', 'app'])).code, 2);
    assert.match((await runCli(env, ['queue', 'list'])).stdout, /1\. app\/A-2 {2}forced \(Start anyway\)\n/);
  } finally {
    await stop(served);
  }
});

// SF-130: a small, scoped Task needs no plan check.
const small = (ticket: string): string => text(ticket).replace('base: main\n', 'base: main\nscope: [README.md]\n');

test('SF-130: no automatic check of a small Task, from a trigger or the queue\'s trigger; a large one runs', async () => {
  const r = await rig('auto-small');
  await r.put('S-1', small('S-1'));
  await r.put('L-1');
  r.auto.trigger('app', 'S-1');
  r.auto.trigger('app', 'L-1');
  await advance(r, MINUTE);
  assert.deepEqual(r.runner.starts, ['auto app/L-1']);
  assert.equal(r.auto.isPending('app', 'S-1'), false);
  // The queue's trigger schedules nothing for it.
  await r.auto.triggerIfUnchecked('app', 'S-1');
  assert.equal(r.auto.isPending('app', 'S-1'), false);
  await advance(r, MINUTE);
  assert.deepEqual(r.runner.starts, ['auto app/L-1']);
});

test('SF-130: the plan check of a small Task with no record is not_needed, even while a trigger is pending; a manual Check of it runs, and its record counts', async () => {
  const { checks, dir, release } = await realChecks('auto-small-manual');
  const content = small('S-2').replace('base: main', 'base: -nope');
  await writeFile(join(dir, '.software-factory', 'S-2.md'), content);
  const clock = new FakeClock();
  const workspace: Workspace = { name: 'app', readCheckout: dir, workCheckout: dir };
  const auto = new AutoChecks({ checks, jobs: { read: async () => undefined }, resolve: async () => workspace, workspaces: async () => [], parallel: 1, timers: clock });
  release();
  assert.deepEqual(await planCheck(checks, auto, 'app', 'S-2'), { state: 'not_needed', blockers: 0, majors: 0 });
  auto.trigger('app', 'S-2');
  assert.equal((await planCheck(checks, auto, 'app', 'S-2')).state, 'not_needed');
  // A manual Check always runs.
  assert.equal((await checks.start('app', 'S-2')).started, true);
  const deadline = Date.now() + 10_000;
  while (checks.isRunning('app', 'S-2')) {
    assert.ok(Date.now() < deadline, 'the manual check did not end');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await checks.store.read('app', 'S-2', taskSha256(content)))?.status, 'failed');
  assert.deepEqual(await planCheck(checks, auto, 'app', 'S-2'), { state: 'failed', blockers: 0, majors: 0 });
  await auto.idle();
});

test('sf serve (SF-130): write_task of a small Task answers not_needed with its reason and no check runs, nor from the queue; with the automatic checks off the answer is off', { timeout: 60_000 }, async () => {
  const { env } = await autoEnv('auto-serve-small');
  await reviewScript(env, [{ output: OUTPUT }]);
  const served = await serve(env);
  try {
    const content = task('N-1', 'Small').replace('base: main\n', 'base: main\nscope: [README.md]\n');
    const written = (await served.client.callTool({ name: 'write_task', arguments: { workspace: 'app', ticket: 'N-1', content } })).structuredContent as Record<string, unknown>;
    const words = content.split(/\s+/).filter((word) => word !== '').length;
    assert.deepEqual([written.check, written.check_reason, written.check_after_seconds], ['not_needed', `small: 1 scope entries, ${words} words`, undefined]);
    assert.equal((await runCli(env, ['queue', 'hold'])).code, 0);
    assert.equal((await runCli(env, ['queue', 'add', 'app', 'N-1'])).code, 0);
    // Longer than the delay (300 ms) and the watcher's event: no session ran.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await assert.rejects(reviewLog(env));
    const row = (JSON.parse((await fetchRaw(new URL('api/tickets', served.dashboard!))).body).tickets as Array<Record<string, any>>).find((entry) => entry.ticket === 'N-1');
    assert.deepEqual([row?.check?.state, row?.check?.check_reason, row?.check?.start_note, row?.queue_reason], ['not_needed', written.check_reason, null, null]);
    // A large Task is scheduled.
    const large = (await served.client.callTool({ name: 'write_task', arguments: { workspace: 'app', ticket: 'N-2', content: task('N-2', 'Large') } })).structuredContent as Record<string, unknown>;
    assert.deepEqual([large.check, large.check_reason], ['scheduled', undefined]);
  } finally {
    await stop(served);
  }
  const off = await newEnv('auto-serve-off');
  await newRepo(off, 'auto-serve-off-repo', false);
  const servedOff = await serve(off);
  try {
    const content = task('N-3', 'Small').replace('base: main\n', 'base: main\nscope: [README.md]\n');
    const written = (await servedOff.client.callTool({ name: 'write_task', arguments: { workspace: 'app', ticket: 'N-3', content } })).structuredContent as Record<string, unknown>;
    assert.equal(written.check, 'off');
  } finally {
    await stop(servedOff);
  }
});
