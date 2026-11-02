// sf status: the recorded cost of the published iterations and the elapsed wall-clock time, as
// pure helpers (src/status.ts, JobStore.recordedCost) and through the sf CLI without sf serve.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { type IterationMeta, type Job, JobStore } from '../src/jobs.js';
import { elapsedSeconds, formatCost, formatElapsed, statusRows } from '../src/status.js';
import { newEnv, runCli, temp } from './support/harness.js';

const CREATED = '2026-11-01T10:00:00.000Z';
const base: Job = {
  workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', base_commit: null, target_commit: null,
  mr_attempts: 0, state: 'awaiting_review', iteration: 0, session_id: null, created_at: CREATED, updated_at: CREATED,
};

function meta(iteration: number, cost: number | null, total: number | null = cost): IterationMeta {
  return {
    iteration, started_at: CREATED, ended_at: CREATED, denials: [], changed_files: [], patch_truncated: false, submodule_changed: [],
    cost_usd: cost, cost_usd_total: total, duration_ms: 1000,
  };
}

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

test('sf status: COST_USD and ELAPSED columns for all jobs and for one job, archives excluded, no server', async () => {
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
  assert.match(lines[0]!, /^WORKSPACE\s+TICKET\s+STATE\s+ITER\s+BRANCH\s+SINCE\s+COST_USD\s+ELAPSED\s+ERROR$/);
  const cells = lines.slice(1).map((line) => line.split(/\s+/));
  assert.deepEqual(cells.map((row) => row.slice(0, 6)), [
    ['app', 'S-1', 'awaiting_review', '2', 'S-1-two', '2026-11-01T12:00:00.000Z'],
    ['app', 'S-2', 'needs_human', '1', 'S-2-zero', CREATED],
    ['app', 'S-3', 'working', '0', 'S-3-new', CREATED],
    ['app', 'S-4', 'pushed', '1', 'S-4-null', '2026-11-02T11:02:03.000Z'],
    ['app', 'S-5', 'aborted', '1', 'S-5-gone', CREATED],
    ['app', 'S-6', 'failed', '1', 'S-6-fail', '2026-11-01T10:59:59.999Z'],
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
  assert.match(one.stdout, /^WORKSPACE\s+TICKET\s+STATE\s+ITER\s+BRANCH\s+SINCE\s+COST_USD\s+ELAPSED\s+ERROR\napp\s+S-2\s+needs_human\s+1\s+S-2-zero\s+\S+\s+0\.0000\s+\d{2,}:\d\d:\d\d\s+turn_failed\n\nturn_failed: It stopped\.\n$/);
  assert.equal((await runCli(env, ['status', 'app', 'S-7'])).code, 1);

  // Malformed metadata is reported, not shown as zero.
  await writeFile(join(jobs.dir('app', 'S-6'), 'iterations', '001', 'meta.json'), '{');
  const broken = await runCli(env, ['status', 'app', 'S-6']);
  assert.equal(broken.code, 1);
  assert.doesNotMatch(broken.stdout, /0\.0000/);
});

test('sf help documents the COST_USD and ELAPSED columns and dashboard --open', async () => {
  const help = await runCli(await newEnv('status-help'), ['help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /^  sf status \[<workspace> <ticket>\] +Show one job or all jobs/m);
  assert.match(help.stdout, /^  sf dashboard \[--open\] +Print the dashboard URL/m);
  assert.match(help.stdout, /COST_USD: cost_usd of the published iterations summed, four decimals; 0\.0000 before the first one, unknown when one has no usable cost/);
  assert.match(help.stdout, /ELAPSED: wall-clock time since the job was created, waiting included; stops at the last state change once pushed, aborted or failed/);
  assert.match(help.stdout, /dashboard --open: Linux with xdg-open; waits for the launcher at most 10 s; on a launcher failure exits 1 and leaves the printed URL to open by hand/);
});
