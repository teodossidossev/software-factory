// Tests of sf metrics (SF-092, src/metrics.ts) on a fixture state directory: current and archived
// jobs, gate records, gate levels and ledgers; the outcomes of the gate's items, each ledger entry
// counted once, the yield, the totals, --since, --json, a workspace argument, and the records that
// cannot be read.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { type GateLevelRecord, type GateRecord, type Job, JobStore } from '../src/jobs.js';
import type { LedgerEntry } from '../src/ledger.js';
import { collectMetrics, entryOf, metricsLines, outcomeOf } from '../src/metrics.js';
import type { ReviewItem } from '../src/review.js';
import { newEnv, runCli } from './support/harness.js';

const AT = '2026-11-05T10:00:00.000Z';
const TOKENS = { input: 1000, cached_input: 0, output: 100 };

function job(workspace: string, ticket: string, created: string, extra: Partial<Job> = {}): Job {
  return {
    workspace, ticket, branch: `${ticket}-x`, base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, state: 'pushed', iteration: 0, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null,
    created_at: `${created}T08:00:00.000Z`, updated_at: AT, mr: null, ...extra,
  } as Job;
}

const item = (path: string, problem: string, severity: ReviewItem['severity'], extra: Partial<ReviewItem> = {}): ReviewItem =>
  ({ path, problem, expected: 'Better.', severity, reopens: '', caused_by: '', ...extra }) as ReviewItem;

const fix = (items: ReviewItem[]): GateRecord => ({ reviewer: 'codex', verdict: 'fix', summary: 'Fix.', items, accepted_sensitive: [], tokens: TOKENS, started_at: AT, ended_at: AT });
const failed: GateRecord = { reviewer: 'codex', error: 'exit 2', tokens: TOKENS, started_at: AT, ended_at: AT };
const clean: GateRecord = { reviewer: 'codex', verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [], tokens: TOKENS, started_at: AT, ended_at: AT };
const level = (value: GateLevelRecord['level'], ran: boolean): GateLevelRecord => ({ level: value, reasons: ['x'], ran, files: 1, lines: 1, at: AT });

function entry(id: string, iteration: number, reviewer: string, path: string, problem: string, severity: LedgerEntry['severity'], status: LedgerEntry['status']): LedgerEntry {
  return { id, iteration, reviewer, severity, path, problem, expected: 'Better.', status, response: '', evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null };
}

// One iteration directory with its records; raw text for a file that is not valid.
async function iteration(jobs: JobStore, workspace: string, dir: string, number: number, records: { level?: GateLevelRecord | string; gate?: GateRecord | string }): Promise<void> {
  const path = jobs.iterationDir(workspace, dir, number);
  await mkdir(path, { recursive: true });
  if (typeof records.level === 'string') {
    await writeFile(join(path, 'gate-level.json'), records.level);
  } else if (records.level !== undefined) {
    await jobs.writeGateLevel(workspace, dir, number, records.level);
  }
  if (typeof records.gate === 'string') {
    await writeFile(join(path, 'gate.json'), records.gate);
  } else if (records.gate !== undefined) {
    await jobs.writeGate(workspace, dir, number, records.gate);
  }
}

// The fixture: app/M-1 (current), app/M-2 (archived), app/M-3 (before 2026-11-01, an invalid
// gate-level.json and ledger.json), app/BAD (an invalid job.json), other/O-1.
async function fixture(name: string): Promise<{ env: Awaited<ReturnType<typeof newEnv>>; jobs: JobStore; archived: string }> {
  const env = await newEnv(name);
  const jobs = new JobStore(env.state);

  // M-1: F F l. R1 fixed and raised again (reopens, with a newer problem text): counted once; a
  // nit left; an item with no entry: open; an item reopening Claude's contested entry: contested.
  await jobs.write(job('app', 'M-1', '2026-11-03', { iteration: 3, gate_tokens: 5000, gate_fixes: 2 }));
  await iteration(jobs, 'app', 'M-1', 1, { level: level('full', true), gate: fix([item('src/a.ts', 'A is wrong.', 'major'), item('src/b.ts', 'B could be nicer.', 'nit')]) });
  await iteration(jobs, 'app', 'M-1', 2, {
    level: level('full', true),
    gate: fix([item('src/a.ts', 'A is still wrong.', 'major', { reopens: 'R1' }), item('src/c.ts', 'C is wrong.', 'major'), item('src/d.ts', 'D again.', 'blocker', { reopens: 'R3' })]),
  });
  await iteration(jobs, 'app', 'M-1', 3, { level: level('light', false) });
  await jobs.writeLedger('app', 'M-1', [
    entry('R1', 1, 'codex', 'src/a.ts', 'A is wrong.', 'major', 'fixed'),
    entry('R2', 1, 'codex', 'src/b.ts', 'B could be nicer.', 'nit', 'left'),
    entry('R3', 1, 'claude', 'src/d.ts', 'D is wrong.', 'major', 'contested'),
  ]);

  // M-2, archived: · - L, a failed run and a fix whose items were accepted (a risk, and left on a major).
  await jobs.write(job('app', 'M-2', '2026-11-04', { state: 'aborted', iteration: 3, gate_tokens: 100 }));
  await iteration(jobs, 'app', 'M-2', 1, { gate: failed });
  await iteration(jobs, 'app', 'M-2', 2, { level: level('none', false) });
  await iteration(jobs, 'app', 'M-2', 3, { level: level('light', true), gate: fix([item('src/e.ts', 'E.', 'major'), item('src/f.ts', 'F.', 'major')]) });
  await jobs.writeLedger('app', 'M-2', [entry('R1', 3, 'codex', 'src/e.ts', 'E.', 'major', 'accepted_risk'), entry('R2', 3, 'codex', 'src/f.ts', 'F.', 'major', 'left')]);
  const archived = await jobs.archive('app', 'M-2');

  // M-3: ? F; its ledger is invalid, so its nit is open.
  await jobs.write(job('app', 'M-3', '2026-10-01', { state: 'failed', iteration: 2, gate_tokens: 7 }));
  await iteration(jobs, 'app', 'M-3', 1, { level: '{not json', gate: fix([item('src/g.ts', 'G.', 'major')]) });
  await iteration(jobs, 'app', 'M-3', 2, { level: level('full', true), gate: fix([item('src/h.ts', 'H.', 'nit')]) });
  await writeFile(join(jobs.dir('app', 'M-3'), 'ledger.json'), '[{"id": 1}]');

  await mkdir(jobs.dir('app', 'BAD'), { recursive: true });
  await writeFile(join(jobs.dir('app', 'BAD'), 'job.json'), '{"ticket": "BAD"}');

  await jobs.write(job('other', 'O-1', '2026-11-05', { iteration: 1, gate_tokens: 1100 }));
  await iteration(jobs, 'other', 'O-1', 1, { level: level('full', true), gate: clean });
  return { env, jobs, archived };
}

test('outcomeOf and entryOf: the rules in order, nit first; the gate\'s own entry, else the one reopens names, else none', () => {
  assert.equal(outcomeOf('nit', 'fixed'), 'nit');
  assert.equal(outcomeOf('nit', undefined), 'nit');
  assert.equal(outcomeOf('major', 'fixed'), 'fixed');
  assert.equal(outcomeOf('blocker', 'user_fix'), 'fixed');
  assert.equal(outcomeOf('major', 'contested'), 'contested');
  assert.equal(outcomeOf('major', 'accepted_risk'), 'accepted');
  assert.equal(outcomeOf('major', 'left'), 'accepted');
  for (const status of ['open', 'escalated', undefined] as const) {
    assert.equal(outcomeOf('major', status), 'open');
  }
  const ledger = [entry('R1', 1, 'codex', 'a', 'P.', 'major', 'fixed'), entry('R2', 2, 'claude', 'a', 'P.', 'major', 'fixed')];
  assert.equal(entryOf(ledger, 1, item('a', 'P.', 'major'))?.id, 'R1');
  // Another iteration's, or Claude's with the same text, is not the gate's own.
  assert.equal(entryOf(ledger, 2, item('a', 'P.', 'major')), undefined);
  assert.equal(entryOf(ledger, 2, item('a', 'Q.', 'major', { reopens: 'R2' }))?.id, 'R2');
  assert.equal(entryOf(ledger, 2, item('a', 'Q.', 'major', { reopens: 'R9' })), undefined);
});

test('collectMetrics: current and archived jobs, levels per iteration, runs, tokens, outcomes counted once per ledger entry, the yield, the totals and the unreadable records', async () => {
  const { jobs, archived } = await fixture('metrics-all');
  const metrics = await collectMetrics(jobs);
  assert.deepEqual(metrics.jobs.map((row) => [row.workspace, row.ticket, row.dir, row.archived, row.started, row.state, row.iterations, row.levels.join(' '), row.gate_runs, row.gate_tokens, row.items, row.yield]), [
    ['app', 'M-3', 'M-3', false, '2026-10-01', 'failed', 2, '? F', 1, 7, { fixed: 0, contested: 0, accepted: 0, nit: 0, open: 1 }, 0],
    ['app', 'M-1', 'M-1', false, '2026-11-03', 'pushed', 3, 'F F l', 2, 5000, { fixed: 1, contested: 1, accepted: 0, nit: 1, open: 1 }, 25],
    ['app', 'M-2', archived, true, '2026-11-04', 'aborted', 3, '· - L', 2, 100, { fixed: 0, contested: 0, accepted: 2, nit: 0, open: 0 }, 0],
    ['other', 'O-1', 'O-1', false, '2026-11-05', 'pushed', 1, 'F', 1, 1100, { fixed: 0, contested: 0, accepted: 0, nit: 0, open: 0 }, null],
  ]);
  assert.deepEqual(metrics.totals, {
    jobs: 4, gate_runs: 6, gate_tokens: 6207,
    items: { fixed: 1, contested: 1, accepted: 2, nit: 1, open: 2 },
    yield: 14.3,
    levels: { full: { iterations: 4, share: 57.1 }, light: { iterations: 2, share: 28.6 }, none: { iterations: 1, share: 14.3 } },
    // BAD's job.json, M-3's gate-level.json and ledger.json.
    unreadable: 3,
  });
  const lines = metricsLines(metrics);
  assert.match(lines[0]!, /^WORKSPACE +TICKET +STARTED +STATE +ITER +LEVELS +RUNS +TOKENS +FIXED +CONTESTED +ACCEPTED +NIT +OPEN +YIELD$/);
  assert.match(lines[2]!, /^app +M-1 +2026-11-03 +pushed +3 +F F l +2 +5000 +1 +1 +0 +1 +1 +25%$/);
  assert.match(lines[3]!, /^app +M-2 \(archived\) +2026-11-04 +aborted +3 +· - L +2 +100 +0 +0 +2 +0 +0 +0%$/);
  assert.match(lines[4]!, /^other +O-1 .* -$/);
  assert.deepEqual(lines.slice(-8), [
    '', 'jobs: 4', 'gate runs: 6', 'gate tokens: 6207', 'gate items: fixed 1, contested 1, accepted 2, nit 1, open 2', 'gate yield: 14.3%',
    'gate levels: full 4 (57.1%), light 2 (28.6%), none 1 (14.3%)', 'unreadable records: 3',
  ]);
});

test('collectMetrics: --since leaves out older jobs; a workspace argument only its jobs; an unknown workspace no rows and zero totals', async () => {
  const { jobs } = await fixture('metrics-filters');
  const since = await collectMetrics(jobs, { since: '2026-11-04' });
  assert.deepEqual(since.jobs.map((row) => row.ticket), ['M-2', 'O-1']);
  // The invalid job.json has no date: it still counts.
  assert.deepEqual([since.totals.jobs, since.totals.gate_runs, since.totals.unreadable], [2, 3, 1]);
  const other = await collectMetrics(jobs, { workspace: 'other' });
  assert.deepEqual(other.jobs.map((row) => row.ticket), ['O-1']);
  assert.deepEqual([other.totals.unreadable, other.totals.yield, other.totals.levels.full], [0, null, { iterations: 1, share: 100 }]);
  const none = await collectMetrics(jobs, { workspace: 'nosuch' });
  assert.deepEqual(none, {
    jobs: [],
    totals: {
      jobs: 0, gate_runs: 0, gate_tokens: 0, items: { fixed: 0, contested: 0, accepted: 0, nit: 0, open: 0 }, yield: null,
      levels: { full: { iterations: 0, share: null }, light: { iterations: 0, share: null }, none: { iterations: 0, share: null } }, unreadable: 0,
    },
  });
  assert.deepEqual(metricsLines(none).slice(0, 2), ['No jobs.', '']);
});

test('sf metrics: the table, --json with the same fields, a workspace and --since; usage errors exit 2', async () => {
  const { env } = await fixture('metrics-cli');
  const table = await runCli(env, ['metrics']);
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /^app +M-1 +2026-11-03 +pushed +3 +F F l /m);
  assert.match(table.stdout, /^unreadable records: 3$/m);
  const json = await runCli(env, ['metrics', 'app', '--since', '2026-11-01', '--json']);
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout) as { jobs: Array<{ ticket: string; levels: string[]; yield: number | null }>; totals: Record<string, unknown> };
  assert.deepEqual(parsed.jobs.map((row) => [row.ticket, row.levels, row.yield]), [['M-1', ['F', 'F', 'l'], 25], ['M-2', ['·', '-', 'L'], 0]]);
  assert.deepEqual([parsed.totals.jobs, parsed.totals.unreadable, parsed.totals.yield], [2, 1, 16.7]);
  const unknown = await runCli(env, ['metrics', 'nosuch']);
  assert.equal(unknown.code, 0, unknown.stderr);
  assert.match(unknown.stdout, /^No jobs\.\n\njobs: 0\n/);
  for (const args of [['metrics', '--since', '2026-02-30'], ['metrics', '--since', 'yesterday'], ['metrics', '--bogus'], ['metrics', 'app', 'extra']]) {
    const refused = await runCli(env, args);
    assert.equal(refused.code, 2, args.join(' '));
  }
});
