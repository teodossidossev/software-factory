// sf status: the recorded cost of the published iterations and the elapsed wall-clock time, as
// pure helpers (src/status.ts, JobStore.recordedCost) and through the sf CLI without sf serve.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { type IterationMeta, type Job, JobStore } from '../src/jobs.js';
import { jobNotification, limitResetNotification, NOTIFIED_STATES } from '../src/notify.js';
import { elapsedSeconds, formatCost, formatElapsed, formatSince, handoverLines, limitLine, statusRows } from '../src/status.js';
import { newEnv, runCli, temp } from './support/harness.js';

// SINCE prints the local time of the sf process (SF-049); the zone is set, not the machine's.
process.env.TZ = 'Europe/Sofia';

const CREATED = '2026-11-01T10:00:00.000Z';
const base: Job = {
  workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
  mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'awaiting_review', iteration: 0, session_id: null, mr: null, created_at: CREATED, updated_at: CREATED,
};

function meta(iteration: number, cost: number | null, total: number | null = cost): IterationMeta {
  return {
    iteration, started_at: CREATED, ended_at: CREATED, denials: [], changed_files: [], patch_truncated: false, submodule_changed: [],
    cost_usd: cost, cost_usd_total: total, duration_ms: 1000,
  };
}

test('SINCE: the stored time in local time; a missing or unparsable one is empty, not printed as stored', () => {
  assert.equal(formatSince('2026-11-04T10:14:25.668Z'), '2026-11-04 12:14:25');
  assert.equal(formatSince('not a time'), '');
  assert.equal(formatSince(''), '');
  assert.equal(formatSince(undefined), '');
});

async function publish(jobs: JobStore, ticket: string, ...metas: IterationMeta[]): Promise<void> {
  for (const entry of metas) {
    await jobs.writeIteration('app', ticket, { report: `# Report: ${ticket}, iteration ${entry.iteration}\n`, patch: Buffer.from(''), meta: entry });
  }
}

test('elapsed time: from created_at to now for live jobs, to updated_at for terminal ones; floor, clamp and HH:MM:SS', () => {
  const now = new Date('2026-11-02T11:02:03.900Z');
  // Nonterminal: created_at to now, including waiting, floored to whole seconds (25 h, 2 min, 3.9 s).
  assert.equal(elapsedSeconds({ ...base, updated_at: '2026-11-02T11:00:00.000Z' }, now), 25 * 3600 + 2 * 60 + 3);
  for (const state of ['starting', 'working', 'needs_human', 'ready_for_human_review', 'preparing_mr'] as const) {
    assert.equal(elapsedSeconds({ ...base, state }, now), 25 * 3600 + 2 * 60 + 3, state);
  }
  // Terminal: created_at to updated_at, whatever now is.
  for (const state of ['pushed', 'aborted', 'failed'] as const) {
    assert.equal(elapsedSeconds({ ...base, state, updated_at: '2026-11-01T10:00:59.999Z' }, now), 59, state);
  }
  // Zero and negative clock skew.
  assert.equal(elapsedSeconds(base, new Date(CREATED)), 0);
  assert.equal(elapsedSeconds(base, new Date('2026-11-01T09:59:00.000Z')), 0);
  assert.equal(elapsedSeconds({ ...base, state: 'failed', updated_at: '2026-11-01T09:00:00.000Z' }, now), 0);

  assert.equal(formatElapsed(0), '00:00:00');
  assert.equal(formatElapsed(59), '00:00:59');
  assert.equal(formatElapsed(3600), '01:00:00');
  assert.equal(formatElapsed(25 * 3600 + 2 * 60 + 3), '25:02:03');
  assert.equal(formatElapsed(100 * 3600), '100:00:00');
});

test('cost formatting: four decimals, a real zero, unknown', () => {
  assert.equal(formatCost(0.0123 + 0.0377), '0.0500');
  assert.equal(formatCost(0), '0.0000');
  assert.equal(formatCost(1.23456), '1.2346');
  assert.equal(formatCost(undefined), 'unknown');
});

test('recorded cost: the sum of cost_usd of the published iterations, never cost_usd_total nor unpublished directories', async () => {
  const state = join(temp, 'status-cost');
  await mkdir(state, { recursive: true });
  const jobs = new JobStore(state);

  await jobs.write({ ...base, ticket: 'C-1', iteration: 2 });
  // Cumulative totals deliberately differ from the sum; iteration 3 exists but is not published.
  await publish(jobs, 'C-1', meta(1, 0.0123, 9), meta(2, 0.0377, 99), meta(3, 5, 999));
  assert.equal(await jobs.recordedCost('app', 'C-1', 2), 0.0123 + 0.0377);
  assert.equal(await jobs.recordedCost('app', 'C-1', 3), 0.0123 + 0.0377 + 5);

  await jobs.write({ ...base, ticket: 'C-2', iteration: 1 });
  await publish(jobs, 'C-2', meta(1, 0, 7));
  assert.equal(await jobs.recordedCost('app', 'C-2', 1), 0);
  assert.equal(await jobs.recordedCost('app', 'C-2', 0), 0);

  // Unknown: a null cost, a missing cost, a missing metadata file, a negative or non-finite cost.
  await jobs.write({ ...base, ticket: 'C-3', iteration: 2 });
  await publish(jobs, 'C-3', meta(1, 0.5), meta(2, null, 1.5));
  assert.equal(await jobs.recordedCost('app', 'C-3', 2), undefined);
  await jobs.write({ ...base, ticket: 'C-4', iteration: 2 });
  await publish(jobs, 'C-4', meta(1, 0.5));
  assert.equal(await jobs.recordedCost('app', 'C-4', 2), undefined);
  await jobs.write({ ...base, ticket: 'C-5', iteration: 1 });
  await publish(jobs, 'C-5', { ...meta(1, 1), cost_usd: undefined as unknown as number });
  assert.equal(await jobs.recordedCost('app', 'C-5', 1), undefined);
  await publish(jobs, 'C-5', meta(1, -1));
  assert.equal(await jobs.recordedCost('app', 'C-5', 1), undefined);
  await publish(jobs, 'C-5', { ...meta(1, 1), cost_usd: 'x' as unknown as number });
  assert.equal(await jobs.recordedCost('app', 'C-5', 1), undefined);

  // Malformed metadata is an error, not zero.
  await jobs.write({ ...base, ticket: 'C-6', iteration: 1 });
  await mkdir(join(jobs.dir('app', 'C-6'), 'iterations', '001'), { recursive: true });
  await writeFile(join(jobs.dir('app', 'C-6'), 'iterations', '001', 'meta.json'), '{not json');
  await assert.rejects(jobs.recordedCost('app', 'C-6', 1), SyntaxError);
  await assert.rejects(statusRows(jobs, await jobs.list(), new Date()), SyntaxError);
  await rm(jobs.dir('app', 'C-6'), { recursive: true });

  const rows = await statusRows(jobs, await jobs.list(), new Date('2026-11-01T10:00:05.000Z'));
  assert.deepEqual(rows.map((row) => [row.job.ticket, row.cost, row.elapsed]), [
    ['C-1', '0.0500', '00:00:05'], ['C-2', '0.0000', '00:00:05'], ['C-3', 'unknown', '00:00:05'], ['C-4', 'unknown', '00:00:05'], ['C-5', 'unknown', '00:00:05'],
  ]);
});

test('sf status: EST_USD and ELAPSED columns for all jobs and for one job, archives excluded, no server', async () => {
  const env = await newEnv('status-cli');
  const jobs = new JobStore(env.state);
  assert.equal((await runCli(env, ['status'])).stdout, 'No jobs.\n');

  // Two published iterations with distinct costs and misleading cumulative totals, plus an unpublished third.
  await jobs.write({ ...base, ticket: 'S-1', branch: 'S-1-two', iteration: 2, updated_at: '2026-11-01T12:00:00.000Z' });
  await publish(jobs, 'S-1', meta(1, 0.0123, 1), meta(2, 0.0377, 2), meta(3, 4, 6));
  // A real zero.
  await jobs.write({ ...base, ticket: 'S-2', branch: 'S-2-zero', iteration: 1, state: 'needs_human', error: { code: 'turn_failed', message: 'It stopped.' } });
  await publish(jobs, 'S-2', meta(1, 0, 3));
  // No iterations: a job that has just started.
  await jobs.write({ ...base, ticket: 'S-3', branch: 'S-3-new', state: 'working' });
  // A null cost, and a missing metadata file; both terminal with a fixed elapsed time, one above a day.
  await jobs.write({ ...base, ticket: 'S-4', branch: 'S-4-null', iteration: 1, state: 'pushed', updated_at: '2026-11-02T11:02:03.000Z' });
  await publish(jobs, 'S-4', meta(1, null, 2));
  await jobs.write({ ...base, ticket: 'S-5', branch: 'S-5-gone', iteration: 1, state: 'aborted', updated_at: '2026-11-01T10:00:00.000Z' });
  await jobs.write({ ...base, ticket: 'S-6', branch: 'S-6-fail', iteration: 1, state: 'failed', updated_at: '2026-11-01T10:59:59.999Z' });
  await publish(jobs, 'S-6', meta(1, 1.5));
  // An archived earlier job of S-6 with its own cost: not listed, not counted.
  await jobs.write({ ...base, ticket: 'S-7', iteration: 1 });
  await publish(jobs, 'S-7', meta(1, 50));
  await jobs.archive('app', 'S-7');

  const all = await runCli(env, ['status']);
  assert.equal(all.code, 0, all.stderr);
  const lines = all.stdout.trimEnd().split('\n');
  assert.match(lines[0]!, /^WORKSPACE\s+TICKET\s+STATE\s+ITER\s+BRANCH\s+SINCE\s+EST_USD\s+ELAPSED\s+ERROR$/);
  // Columns are two or more spaces apart; SINCE, local time in Sofia (UTC+2), has one space of its own.
  const cells = lines.slice(1).map((line) => line.split(/ {2,}/));
  assert.deepEqual(cells.map((row) => row.slice(0, 6)), [
    ['app', 'S-1', 'awaiting_review', '2', 'S-1-two', '2026-11-01 14:00:00'],
    ['app', 'S-2', 'needs_human', '1', 'S-2-zero', '2026-11-01 12:00:00'],
    ['app', 'S-3', 'working', '0', 'S-3-new', '2026-11-01 12:00:00'],
    ['app', 'S-4', 'pushed', '1', 'S-4-null', '2026-11-02 13:02:03'],
    ['app', 'S-5', 'aborted', '1', 'S-5-gone', '2026-11-01 12:00:00'],
    ['app', 'S-6', 'failed', '1', 'S-6-fail', '2026-11-01 12:59:59'],
  ]);
  assert.deepEqual(cells.map((row) => row[6]), ['0.0500', '0.0000', '0.0000', 'unknown', 'unknown', '1.5000']);
  // Terminal jobs: created_at to updated_at. Live jobs: created_at to now, hours since 2026-11-01.
  assert.deepEqual(cells.slice(3).map((row) => row[7]), ['25:02:03', '00:00:00', '00:59:59']);
  for (const row of cells.slice(0, 3)) {
    assert.match(row[7]!, /^\d{2,}:\d{2}:\d{2}$/, row.join(' '));
    assert.ok(Number(row[7]!.split(':')[0]) >= 1, row.join(' '));
  }
  assert.deepEqual(cells.map((row) => row[8]), [undefined, 'turn_failed', undefined, undefined, undefined, undefined]);

  const one = await runCli(env, ['status', 'app', 'S-2']);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /^WORKSPACE\s+TICKET\s+STATE\s+ITER\s+BRANCH\s+SINCE\s+EST_USD\s+ELAPSED\s+ERROR\napp\s+S-2\s+needs_human\s+1\s+S-2-zero\s+2026-11-01 12:00:00\s+0\.0000\s+\d{2,}:\d\d:\d\d\s+turn_failed\n\nturn_failed: It stopped\.\nsensitive: none\ndeleted: none\n$/);
  assert.equal((await runCli(env, ['status', 'app', 'S-7'])).code, 1);

  // Malformed metadata is reported, not shown as zero.
  await writeFile(join(jobs.dir('app', 'S-6'), 'iterations', '001', 'meta.json'), '{');
  const broken = await runCli(env, ['status', 'app', 'S-6']);
  assert.equal(broken.code, 1);
  assert.doesNotMatch(broken.stdout, /0\.0000/);
});

test('sf help documents the EST_USD (an estimate) and ELAPSED columns and dashboard --open', async () => {
  const help = await runCli(await newEnv('status-help'), ['help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /^  sf status \[<workspace> <ticket>\] +Show one job or all jobs/m);
  assert.match(help.stdout, /^  sf dashboard \[--open\] \[--rotate\] +Print the dashboard URL/m);
  assert.match(help.stdout, /^  EST_USD: an estimate of the API-equivalent price, not a charge \(the session usually runs on your Claude plan\):$/m);
  assert.match(help.stdout, /cost_usd of the published iterations summed, four decimals; 0\.0000 before the first one, unknown when one has no usable cost/);
  assert.doesNotMatch(help.stdout, /COST_USD/);
  assert.match(help.stdout, /ELAPSED: wall-clock time since the job was created, waiting included; stops at the last state change once pushed, aborted or failed/);
  assert.match(help.stdout, /dashboard --open: Linux with xdg-open; waits for the launcher at most 10 s; on a launcher failure exits 1 and leaves the printed URL to open by hand/);
});

test('sf status and the notification of a handed-over job (SF-073): in your checkout on the branch with the MR title and the file lines; a skipped hand-over carries its message', async () => {
  const commit = 'a'.repeat(40);
  const handed: Job = {
    ...base, state: 'handed_over', prepared_commit: commit,
    handover: { branch: 'T-1-demo', saved: commit, base: 'b'.repeat(40), previous: { branch: 'main' }, untracked: [], template: null, cleanup: null, at: CREATED, checked_at: null, step: null },
  };
  assert.deepEqual(handoverLines(handed, 'feat(T-1): Demo'), ['in your checkout on T-1-demo', 'MR title: feat(T-1): Demo']);
  assert.deepEqual(handoverLines(handed, undefined), ['in your checkout on T-1-demo']);
  const skipped: Job = { ...base, state: 'ready_for_human_review', handoff_skipped: { code: 'checkout_dirty', message: 'T-1: ready, but your checkout has changes; hand it over when you are ready' } };
  assert.deepEqual(handoverLines(skipped, 'feat(T-1): Demo'), ['not handed over to your checkout: T-1: ready, but your checkout has changes; hand it over when you are ready (checkout_dirty); sf handover hands it over']);
  assert.deepEqual(handoverLines({ ...base, state: 'ready_for_human_review' }, 'x'), []);

  assert.ok(NOTIFIED_STATES.includes('handed_over'));
  const note = jobNotification(handed, ['feat(T-1): Demo', '2 files']);
  assert.deepEqual([note.title, note.body, note.priority], ['T-1: in your checkout', 'in your checkout on T-1-demo\nfeat(T-1): Demo\n2 files', 'default']);
  const skippedNote = jobNotification(skipped, ['feat(T-1): Demo', '2 files']);
  assert.equal(skippedNote.body, 'branch: T-1-demo\nT-1: ready, but your checkout has changes; hand it over when you are ready\nfeat(T-1): Demo');
  // A change to files the user's IDE or tools run: the same lines, with its message.
  const sensitive: Job = { ...skipped, handoff_skipped: { code: 'handoff_sensitive', message: 'it changes files your IDE or tools may run: .vscode/tasks.json; read them, then hand it over' } };
  assert.deepEqual(handoverLines(sensitive, undefined), ['not handed over to your checkout: it changes files your IDE or tools may run: .vscode/tasks.json; read them, then hand it over (handoff_sensitive); sf handover hands it over']);
  assert.equal(jobNotification(sensitive, ['feat(T-1): Demo']).body, 'branch: T-1-demo\nit changes files your IDE or tools may run: .vscode/tasks.json; read them, then hand it over\nfeat(T-1): Demo');

  // sf status of one job prints the line, without sf serve.
  const env = await newEnv('status-handed');
  const jobs = new JobStore(env.state);
  await jobs.write({ ...handed, ticket: 'T-9' });
  await jobs.writeMrText('app', 'T-9', 'feat(T-9): Demo\n\n## What\nx\n');
  const one = await runCli(env, ['status', 'app', 'T-9']);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /\nin your checkout on T-1-demo\nMR title: feat\(T-9\): Demo\n/);
  assert.match(one.stdout, /handed_over/);
});

test('sf status and the notifications of a job parked on a usage limit (SF-072): the provider and the reset in local time; the reset notification of the run queue', async () => {
  const parked: Job = {
    ...base, state: 'waiting_limit', iteration: 1, paused: { from: 'working', step: 'turn', at: CREATED },
    limit: { provider: 'claude', resets_at: '2026-11-05T01:00:00.000Z' },
  };
  // 03:00 in Sofia.
  assert.equal(limitLine(parked), 'waiting for the usage limit (Claude): resets at 2026-11-05 03:00:00');
  assert.equal(limitLine({ ...parked, limit: { provider: 'codex', resets_at: parked.limit!.resets_at, reset_seen: true, notified_at: CREATED } }), 'usage limit (Codex) reset: sf resume app T-1 goes on');
  assert.equal(limitLine(base), undefined);

  assert.ok(NOTIFIED_STATES.includes('waiting_limit'));
  const note = jobNotification(parked);
  assert.deepEqual([note.title, note.body, note.priority], ['T-1: waiting for limits', 'Usage limit (Claude): parked until 03:00\nbranch: T-1-demo', 'default']);
  assert.deepEqual(limitResetNotification(2, 0), { title: 'Usage limit reset', body: 'Usage limit reset: 2 jobs resumed', priority: 'default', tags: 'hourglass' });
  assert.equal(limitResetNotification(0, 1).body, 'Usage limit reset: 1 job waits for you');

  const env = await newEnv('status-parked');
  const jobs = new JobStore(env.state);
  await jobs.write({ ...parked, ticket: 'T-8' });
  const one = await runCli(env, ['status', 'app', 'T-8']);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /waiting_limit/);
  assert.match(one.stdout, /\nwaiting for the usage limit \(Claude\): resets at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\n/);
  const all = await runCli(env, ['status']);
  assert.match(all.stdout, /\napp\/T-8: waiting for the usage limit \(Claude\): resets at /);
});
