// The Stats page's numbers (SF-117, src/stats.ts) over temporary state directories in Europe/Sofia
// with a fixed now (2026-11-07 14:00 local, the 7-day period 2026-11-01 to 2026-11-07): costs and
// tokens by role on their record's local day, the review stages with failures from the events,
// the plan check's revisions, the second opinion, the warnings with their texts and targets, now,
// time to ready, the workspace filter, the limits and the caches, the Claude review arms and the
// simplification counts (SF-132), and no review text in the payload.
import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { DigestStore } from '../src/digest-run.js';
import { type EventRecord, type GateRecord, type Job, JobStore, type ReviewRecord } from '../src/jobs.js';
import type { LedgerEntry } from '../src/ledger.js';
import type { ReviewItem } from '../src/review.js';
import { STATS_CACHE_MS, Stats, type StatsPayload } from '../src/stats.js';
import { CheckStore } from '../src/task-check.js';
import { newEnv } from './support/harness.js';

process.env.TZ = 'Europe/Sofia';
const NOW = new Date('2026-11-07T12:00:00.000Z');
// A time of a local day (Sofia is UTC+2 in November).
const on = (day: string, time = '12:00'): string => new Date(`${day}T${time}:00+02:00`).toISOString();
const NO_TOKENS = { input: 0, cached_input: 0, output: 0 };

function job(workspace: string, ticket: string, extra: Partial<Job> = {}): Job {
  return {
    workspace, ticket, branch: `${ticket}-x`, base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, state: 'working', iteration: 0, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null,
    created_at: on('2026-11-05', '09:00'), updated_at: on('2026-11-06'), mr: null, ...extra,
  } as Job;
}

const item = (path: string, problem: string, severity: ReviewItem['severity'], extra: Partial<ReviewItem> = {}): ReviewItem =>
  ({ path, problem, expected: 'Better.', severity, reopens: '', caused_by: '', ...extra }) as ReviewItem;
const review = (items: ReviewItem[], ended: string, cost: number | null = 0, summary = 'Fine.'): ReviewRecord =>
  ({ reviewer: 'claude', verdict: items.some((one) => one.severity !== 'nit') ? 'fix' : 'clean', summary, items, accepted_sensitive: [], cost_usd: cost, started_at: ended, ended_at: ended });
const gate = (items: ReviewItem[], ended: string, tokens = NO_TOKENS): GateRecord =>
  ({ reviewer: 'codex', verdict: items.some((one) => one.severity !== 'nit') ? 'fix' : 'clean', summary: 'Gate.', items, accepted_sensitive: [], tokens, started_at: ended, ended_at: ended });
const gateFailed = (ended: string, tokens = NO_TOKENS): GateRecord => ({ reviewer: 'codex', error: 'exit 2', tokens, started_at: ended, ended_at: ended });

function entry(id: string, iteration: number, reviewer: string, path: string, problem: string, severity: LedgerEntry['severity'], status: LedgerEntry['status'], reopened = 0): LedgerEntry {
  return { id, iteration, reviewer, severity, path, problem, expected: 'Better.', status, response: '', evidence: '', reopened, asked: 1, caused_by: '', dispute: null, settled: null };
}

// A job directory with one iteration per cost (each meta.json ended at its time).
async function makeJob(jobs: JobStore, workspace: string, ticket: string, iterations: Array<{ ended: string; cost: number | null }>, extra: Partial<Job> = {}): Promise<void> {
  await jobs.write(job(workspace, ticket, { iteration: iterations.length, ...extra }));
  for (const [index, one] of iterations.entries()) {
    await jobs.writeIteration(workspace, ticket, {
      report: 'Report.', patch: Buffer.from(''),
      meta: { iteration: index + 1, started_at: one.ended, ended_at: one.ended, denials: [], changed_files: [], patch_truncated: false, submodule_changed: [], cost_usd: one.cost, cost_usd_total: null, duration_ms: null },
    });
  }
}

const event = (jobs: JobStore, workspace: string, dir: string, record: Record<string, unknown>): Promise<void> =>
  jobs.appendEvent(workspace, dir, { iteration: 1, ...record } as EventRecord);
const result = (input: number, output: number): Record<string, unknown> => ({ type: 'result', usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output } });

async function explanation(jobs: JobStore, workspace: string, dir: string, ended: string | null, cost: number | null, error: string | null = null): Promise<void> {
  const record = { stop: { at: ended ?? NOW.toISOString(), code: 'escalated' }, model: 'm', language: 'en', started_at: ended ?? NOW.toISOString(), ended_at: ended, cost_usd: cost, output: null, error };
  await writeFile(join(jobs.dir(workspace, dir), 'explanation.json'), JSON.stringify(record));
}

async function check(state: string, workspace: string, ticket: string, sha: string, status: 'checked' | 'failed', started: string, severities: string[], cost: number | null = 0): Promise<void> {
  await new CheckStore(state).write({
    workspace, ticket, sha256: sha.repeat(64).slice(0, 64), commit: null, status, error: status === 'failed' ? 'x' : null, model: 'm', cost_usd: cost, started_at: started, ended_at: started,
    output: status === 'failed' ? null : { paraphrase: 'P.', findings: severities.map((severity) => ({ kind: 'missing', severity, where: 'x', problem: 'SECRET-CHECK', expected: 'y' })), files: [], verdict: 'ready' },
  } as never);
}

async function digest(state: string, started: string, cost: number | null, error: string | null = null): Promise<string> {
  const stampText = started.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const stored = await new DigestStore(state).write({
    trigger: 'scheduled', started_at: started, ended_at: started, period: { from: started, to: started }, daily_days: { yesterday: { from: started, to: started }, today: { from: started, to: started } },
    model: 'm', language: 'en', workspaces: [], daily_sources: [], output: null, cost_usd: cost, error, notes: [], counts: { landed: 0, live_branches: 0, impact: 0 },
  }, `${stampText}-scheduled`);
  return stored.id;
}

const stats = (state: string, jobs: JobStore, extra: { now?: () => Date; maxJobs?: number } = {}): Stats => new Stats(state, jobs, { now: () => NOW, ...extra });
const role = (payload: StatsPayload, name: string) => payload.roles.find((row) => row.role === name)!;
const stage = (payload: StatsPayload, name: string) => payload.stages.find((row) => row.stage === name)!;
const dayRow = (payload: StatsPayload, day: string) => payload.days_rows.find((row) => row.day === day)!;

test('costs and tokens by role on their record\'s local day, every day of the period a row, a null cost incomplete, an older record left out', async () => {
  const env = await newEnv('stats-costs');
  const jobs = new JobStore(env.state);
  // 22:30 UTC on 2026-11-04 is 00:30 on 2026-11-05 in Sofia.
  await makeJob(jobs, 'app', 'A-1', [{ ended: '2026-11-04T22:30:00.000Z', cost: 1.5 }, { ended: on('2026-11-06'), cost: null }]);
  await jobs.writeReview('app', 'A-1', 1, review([item('a', 'A.', 'major')], on('2026-11-05'), 0.5));
  await jobs.writeReview('app', 'A-1', 2, review([], on('2026-11-06'), 0.25));
  await jobs.writeGate('app', 'A-1', 2, gate([], on('2026-11-06'), { input: 1000, cached_input: 200, output: 100 }));
  await jobs.writeSimplify('app', 'A-1', 2, { reviewer: 'simplify', summary: 'S.', suggestions: [], dropped: [], cost_usd: 0.125, model: null, started_at: on('2026-11-06'), ended_at: on('2026-11-06') });
  await explanation(jobs, 'app', 'A-1', on('2026-11-06'), 0.75);
  // Before the period: left out.
  await makeJob(jobs, 'app', 'A-0', [{ ended: on('2026-10-20'), cost: 9 }], { state: 'pushed', created_at: on('2026-10-20'), updated_at: on('2026-10-21') });
  await check(env.state, 'app', 'T-1', 'a', 'checked', on('2026-11-04'), [], 0.375);
  await digest(env.state, on('2026-11-03', '08:00'), 0.0625);

  // Tokens from the events: the Implementer's result messages, Claude's and the simplification's review messages.
  await event(jobs, 'app', 'A-1', { ts: on('2026-11-05'), message: { type: 'result', usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 } } });
  await event(jobs, 'app', 'A-1', { ts: on('2026-11-05'), message: { type: 'assistant', usage: { input_tokens: 1000 } } });
  await event(jobs, 'app', 'A-1', { ts: on('2026-11-05'), type: 'review_message', reviewer: 'claude', message: result(100, 10) });
  await event(jobs, 'app', 'A-1', { ts: on('2026-11-06'), type: 'review_message', reviewer: 'simplify', message: result(7, 1) });
  // Not counted: "type":"result" inside a string, a result inside another kind of line, a malformed line, a line before the period.
  await event(jobs, 'app', 'A-1', { ts: on('2026-11-05'), prompt: 'say {"type":"result","usage":{"input_tokens":5000}}' });
  await event(jobs, 'app', 'A-1', { ts: on('2026-11-05'), type: 'gate_event', reviewer: 'codex', event: result(5000, 5000) });
  await appendFile(jobs.eventsPath('app', 'A-1'), `{"ts":"${on('2026-11-05')}","iteration":1,"message":{"type":"result","usage":{"input_tokens":5000}\n`);
  await event(jobs, 'app', 'A-1', { ts: on('2026-10-20'), message: result(5000, 5000) });

  const payload = await stats(env.state, jobs).compute({ days: 7, workspace: null });
  assert.equal(payload.days, 7);
  assert.deepEqual(payload.period, { from: '2026-11-01', to: '2026-11-07' });
  assert.deepEqual(payload.days_rows.map((row) => row.day), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
  assert.deepEqual(dayRow(payload, '2026-11-01'), { day: '2026-11-01', cost: { implementer: 0, claude_review: 0, simplify: 0, task_check: 0, digest: 0, explanation: 0 }, codex_tokens: NO_TOKENS, started: 0, finished: 0 });
  assert.deepEqual(dayRow(payload, '2026-11-05').cost, { implementer: 1.5, claude_review: 0.5, simplify: 0, task_check: 0, digest: 0, explanation: 0 });
  assert.deepEqual(dayRow(payload, '2026-11-06').cost, { implementer: 0, claude_review: 0.25, simplify: 0.125, task_check: 0, digest: 0, explanation: 0.75 });
  assert.deepEqual(dayRow(payload, '2026-11-06').codex_tokens, { input: 1000, cached_input: 200, output: 100 });
  assert.equal(dayRow(payload, '2026-11-04').cost.task_check, 0.375);
  assert.equal(dayRow(payload, '2026-11-03').cost.digest, 0.0625);
  assert.equal(dayRow(payload, '2026-11-05').started, 1);
  assert.equal(payload.totals.cost_usd, 1.5 + 0.5 + 0.25 + 0.125 + 0.75 + 0.375 + 0.0625);
  assert.deepEqual(payload.totals.codex_tokens, { input: 1000, cached_input: 200, output: 100 });

  assert.deepEqual(role(payload, 'implementer'), { role: 'implementer', cost_usd: 1.5, complete: false, tokens: { input: 60, output: 5 }, runs: 2 });
  assert.deepEqual(role(payload, 'claude_review'), { role: 'claude_review', cost_usd: 0.75, complete: true, tokens: { input: 100, output: 10 }, runs: 2 });
  assert.deepEqual(role(payload, 'simplify'), { role: 'simplify', cost_usd: 0.125, complete: true, tokens: { input: 7, output: 1 }, runs: 1 });
  assert.deepEqual(role(payload, 'codex_gate'), { role: 'codex_gate', cost_usd: null, complete: true, tokens: { input: 1000, cached_input: 200, output: 100 }, runs: 1 });
  assert.deepEqual(role(payload, 'task_check'), { role: 'task_check', cost_usd: 0.375, complete: true, tokens: null, runs: 1 });
  assert.deepEqual(role(payload, 'digest'), { role: 'digest', cost_usd: 0.0625, complete: true, tokens: null, runs: 1 });
  assert.deepEqual(role(payload, 'explanation'), { role: 'explanation', cost_usd: 0.75, complete: true, tokens: null, runs: 1 });
  assert.deepEqual(payload.roles.map((row) => row.role), ['implementer', 'claude_review', 'simplify', 'codex_gate', 'task_check', 'digest', 'explanation']);
  assert.deepEqual(payload.by_workspace, [{
    workspace: 'app', cost: { implementer: 1.5, claude_review: 0.75, simplify: 0.125, task_check: 0.375, explanation: 0.75 }, total_usd: 3.5, codex_tokens: 1100, jobs_started: 1, median_time_to_ready_s: null,
  }]);
  assert.deepEqual(payload.workspaces, ['app']);
  // A-1 of all time: 1.5 + null + 0.5 + 0.25 + 0.125 + 0.75; A-0 is not in the period.
  assert.deepEqual(payload.jobs.map((row) => [row.ticket, row.cost_usd, row.cost_complete]), [['A-1', 3.125, false]]);
  assert.deepEqual(payload.notes, { truncated: 0, unreadable: 0, events_skipped: 0, digest_excluded: false });
  // A 30-day period reaches A-0's record.
  const month = await stats(env.state, jobs).compute({ days: 30, workspace: null });
  assert.equal(month.days_rows.length, 30);
  assert.equal(role(month, 'implementer').cost_usd, 10.5);
});

test('review stages: findings by severity, fixed once per ledger entry, failures from the review_failed lines across retries, ignored ones left out; the plan check\'s revised; no review text in the payload', async () => {
  const env = await newEnv('stats-stages');
  const jobs = new JobStore(env.state);
  await makeJob(jobs, 'app', 'B-1', [{ ended: on('2026-11-05'), cost: 1 }, { ended: on('2026-11-06'), cost: 1 }]);
  // Iteration 1: the review failed, the retry removed its file and gave a verdict.
  await jobs.writeReview('app', 'B-1', 1, { reviewer: 'claude', error: 'SECRET-ERROR' });
  await event(jobs, 'app', 'B-1', { ts: on('2026-11-05', '10:00'), type: 'review_failed', reviewer: 'claude', error: 'SECRET-ERROR' });
  await jobs.removeReview('app', 'B-1', 1);
  await jobs.writeReview('app', 'B-1', 1, review([item('a', 'SECRET-PROBLEM', 'major', { expected: 'SECRET-EXPECTED' }), item('b', 'B.', 'nit')], on('2026-11-05', '11:00'), 0.5, 'SECRET-SUMMARY'));
  await event(jobs, 'app', 'B-1', { ts: on('2026-11-05', '11:00'), type: 'review', reviewer: 'claude', verdict: 'fix', items: 2 });
  await event(jobs, 'app', 'B-1', { ts: on('2026-11-05', '11:30'), type: 'review_failed', reviewer: 'claude', error: 'x', ignored: true });
  // Iteration 2: R1 raised again (counted once), a blocker without an entry (open).
  await jobs.writeReview('app', 'B-1', 2, review([item('a', 'Still.', 'major', { reopens: 'R1' }), item('c', 'C.', 'blocker')], on('2026-11-06'), 0.5));
  await jobs.writeLedger('app', 'B-1', [entry('R1', 1, 'claude', 'a', 'SECRET-PROBLEM', 'major', 'fixed'), entry('R2', 1, 'claude', 'b', 'B.', 'nit', 'left')]);

  // The gate failed three times across retries; each failed gate.json went with removeGate.
  await makeJob(jobs, 'app', 'G-1', [{ ended: on('2026-11-04'), cost: 1 }]);
  for (const day of ['2026-11-04', '2026-11-05', '2026-11-06']) {
    await jobs.writeGate('app', 'G-1', 1, gateFailed(on(day, '14:02'), { input: 10, cached_input: 0, output: 1 }));
    await event(jobs, 'app', 'G-1', { ts: on(day, '14:02'), type: 'review_failed', reviewer: 'codex', error: 'exit 2' });
    if (day !== '2026-11-06') {
      await jobs.removeGate('app', 'G-1', 1);
    }
  }

  // Plan checks: T-1's major was followed by a check of another version (revised); T-2's blocker was
  // not; T-3's check failed.
  await check(env.state, 'app', 'T-1', 'a', 'checked', on('2026-11-03'), ['major', 'nit'], 0.25);
  await check(env.state, 'app', 'T-1', 'b', 'checked', on('2026-11-04'), [], 0.25);
  await check(env.state, 'app', 'T-2', 'c', 'checked', on('2026-11-04'), ['blocker']);
  await check(env.state, 'app', 'T-3', 'd', 'failed', on('2026-11-05'), []);

  const payload = await stats(env.state, jobs).compute({ days: 7, workspace: null });
  assert.deepEqual(stage(payload, 'claude_review'), {
    stage: 'claude_review', runs: 2, failed: 1, findings: { blocker: 1, major: 2, nit: 1 }, outcomes: { fixed: 1, contested: 0, accepted: 0, nit: 1, open: 1 }, revised: null, fixed: 1, tickets: null,
    cost_usd: 1, tokens: { input: 0, output: 0 },
  });
  // A failed gate.json still on disk adds its tokens; the removed ones do not.
  assert.deepEqual(stage(payload, 'codex_gate'), {
    stage: 'codex_gate', runs: 0, failed: 3, findings: { blocker: 0, major: 0, nit: 0 }, outcomes: { fixed: 0, contested: 0, accepted: 0, nit: 0, open: 0 }, revised: null, fixed: 0, tickets: null,
    cost_usd: null, tokens: { input: 10, cached_input: 0, output: 1 },
  });
  assert.deepEqual(stage(payload, 'task_check'), {
    stage: 'task_check', runs: 3, failed: 1, findings: { blocker: 1, major: 1, nit: 1 }, outcomes: null, revised: 1, fixed: 1, tickets: 3, cost_usd: 0.5, tokens: null,
  });
  const failing = payload.warnings.filter((warning) => warning.kind === 'stage_failing');
  assert.deepEqual(failing, [{
    kind: 'stage_failing', text: 'The Codex gate failed 3 times in a row, last on G-1 on 2026-11-06 at 14:02.', at: on('2026-11-06', '14:02'),
    target: { kind: 'job', workspace: 'app', ticket: 'G-1', archived: false },
  }]);
  const text = JSON.stringify(payload);
  for (const secret of ['SECRET-PROBLEM', 'SECRET-EXPECTED', 'SECRET-SUMMARY', 'SECRET-ERROR', 'SECRET-CHECK']) {
    assert.equal(text.includes(secret), false, secret);
  }

  // The newest gate run succeeded: no warning.
  await event(jobs, 'app', 'G-1', { ts: on('2026-11-06', '15:00'), type: 'review', reviewer: 'codex', verdict: 'clean', items: 0 });
  const after = await stats(env.state, jobs).compute({ days: 7, workspace: null });
  assert.deepEqual(after.warnings.filter((warning) => warning.kind === 'stage_failing'), []);
});

test('second opinion: a gate major after a clean Claude review is caught with its fixed entry; a clean gate is not; a failed gate is not counted; the next iteration\'s new Claude major counts, a fix-caused one not; cases newest first', async () => {
  const env = await newEnv('stats-opinion');
  const jobs = new JobStore(env.state);
  await makeJob(jobs, 'app', 'S-1', [{ ended: on('2026-11-03'), cost: 1 }, { ended: on('2026-11-04'), cost: 1 }, { ended: on('2026-11-05'), cost: 1 }]);
  await jobs.writeReview('app', 'S-1', 1, review([item('n', 'Nit.', 'nit')], on('2026-11-03')));
  await jobs.writeGate('app', 'S-1', 1, gate([item('m', 'M.', 'major'), item('o', 'O.', 'nit')], on('2026-11-03', '13:00')));
  await jobs.writeReview('app', 'S-1', 2, review([], on('2026-11-04')));
  await jobs.writeGate('app', 'S-1', 2, gate([], on('2026-11-04', '13:00')));
  await jobs.writeReview('app', 'S-1', 3, review([item('p', 'New.', 'major', { caused_by: '' }), item('q', 'From the fix.', 'major', { caused_by: 'R1' })], on('2026-11-05')));
  await jobs.writeLedger('app', 'S-1', [entry('R1', 1, 'codex', 'm', 'M.', 'major', 'fixed')]);
  await makeJob(jobs, 'app', 'S-2', [{ ended: on('2026-11-05'), cost: 1 }]);
  await jobs.writeReview('app', 'S-2', 1, review([], on('2026-11-05')));
  await jobs.writeGate('app', 'S-2', 1, gateFailed(on('2026-11-05')));
  await makeJob(jobs, 'app', 'S-3', [{ ended: on('2026-11-06'), cost: 1 }]);
  await jobs.writeReview('app', 'S-3', 1, review([], on('2026-11-06')));
  await jobs.writeGate('app', 'S-3', 1, gate([item('x', 'X.', 'blocker'), item('y', 'Y.', 'major')], on('2026-11-06', '13:00')));

  const { second_opinion: opinion } = await stats(env.state, jobs).compute({ days: 7, workspace: null });
  assert.deepEqual(opinion.codex_after_claude, {
    iterations: 3, caught: 2, findings: 3, fixed: 1,
    cases: [
      { workspace: 'app', ticket: 'S-3', dir: 'S-3', archived: false, iteration: 1, findings: 2, fixed: 0 },
      { workspace: 'app', ticket: 'S-1', dir: 'S-1', archived: false, iteration: 1, findings: 1, fixed: 1 },
    ],
  });
  assert.deepEqual(opinion.claude_after_codex, {
    iterations: 1, caught: 1, findings: 1, fixed: 0,
    cases: [{ workspace: 'app', ticket: 'S-1', dir: 'S-1', archived: false, iteration: 3, findings: 1, fixed: 0 }],
  });
});

// count finished jobs of a workspace, each with iterations iterations of cost each and gateTokens.
async function references(jobs: JobStore, workspace: string, count: number, iterations: number, cost: number, gateTokens: number): Promise<void> {
  for (let n = 1; n <= count; n += 1) {
    await makeJob(jobs, workspace, `R-${n}`, Array.from({ length: iterations }, () => ({ ended: on('2026-10-20'), cost })), {
      state: 'pushed', created_at: on('2026-10-20'), updated_at: on('2026-10-2' + String(n % 10)), gate_tokens: gateTokens,
    });
  }
}

test('warnings: a job far above the usual cost, iterations and gate tokens with 5 reference jobs in one line, not with 4, not under $5 or 5 iterations; review churn by reopened and by a stop line; failing plan checks and digests; their texts, targets and order', async () => {
  const env = await newEnv('stats-warnings');
  const jobs = new JobStore(env.state);
  await references(jobs, 'ref', 5, 2, 1, 600_000);
  await makeJob(jobs, 'ref', 'X-1', Array.from({ length: 7 }, () => ({ ended: on('2026-11-06'), cost: 1 })), { gate_tokens: 2_100_000, updated_at: on('2026-11-06', '15:00') });
  await references(jobs, 'few', 4, 2, 1, 600_000);
  await makeJob(jobs, 'few', 'Y-1', Array.from({ length: 5 }, () => ({ ended: on('2026-11-06'), cost: 1 })), { gate_tokens: 2_100_000 });
  // Four times the usual, but under $5 and under 5 iterations.
  await references(jobs, 'cheap', 5, 1, 0.125, 0);
  await makeJob(jobs, 'cheap', 'Z-1', Array.from({ length: 4 }, () => ({ ended: on('2026-11-06'), cost: 0.25 })), { gate_tokens: 10 });

  // Review churn: R4 and R10 reopened 3 times (the lowest id wins), on an archived job; a churn stop line.
  await makeJob(jobs, 'churn', 'C-1', [], { state: 'aborted', updated_at: on('2026-11-05', '09:00') });
  await jobs.writeLedger('churn', 'C-1', [entry('R10', 1, 'claude', 'a', 'A.', 'major', 'fixed', 3), entry('R2', 1, 'claude', 'b', 'B.', 'major', 'fixed', 2), entry('R4', 1, 'codex', 'c', 'C.', 'major', 'fixed', 3)]);
  const archived = await jobs.archive('churn', 'C-1');
  await makeJob(jobs, 'churn', 'D-1', [], { state: 'needs_human', updated_at: on('2026-11-06', '14:02') });
  await event(jobs, 'churn', 'D-1', { ts: on('2026-11-04', '10:00'), state: { from: 'awaiting_review', to: 'needs_human', error: { code: 'review_disputed', message: 'x' } } });
  await event(jobs, 'churn', 'D-1', { ts: on('2026-11-06', '14:02'), state: { from: 'awaiting_review', to: 'needs_human', error: { code: 'review_churn', message: 'x' } } });

  // The plan check of P-1 and the digest failed three times in a row.
  for (const [sha, day] of [['1', '2026-11-04'], ['2', '2026-11-05'], ['3', '2026-11-06']] as const) {
    await check(env.state, 'plan', 'P-1', sha, 'failed', on(day, '10:00'), []);
  }
  let digestId = '';
  for (const day of ['2026-11-04', '2026-11-05', '2026-11-06']) {
    digestId = await digest(env.state, on(day, '08:00'), null, 'model failed');
  }

  const payload = await stats(env.state, jobs).compute({ days: 7, workspace: null });
  const x1 = { kind: 'job', workspace: 'ref', ticket: 'X-1', archived: false };
  assert.deepEqual(payload.warnings, [
    {
      kind: 'job_unusual', text: 'X-1: cost $7.00 (usual $2.00); 2.1M Codex gate tokens (usual 600k); 7 iterations (usual 2) — compared with the last 5 finished jobs of ref.',
      at: on('2026-11-06', '15:00'), target: x1,
    },
    { kind: 'review_churn', text: 'D-1 stopped with review_churn on 2026-11-06 at 14:02.', at: on('2026-11-06', '14:02'), target: { kind: 'job', workspace: 'churn', ticket: 'D-1', archived: false } },
    { kind: 'stage_failing', text: 'The plan check failed 3 times in a row, last on P-1 on 2026-11-06 at 10:00.', at: on('2026-11-06', '10:00'), target: { kind: 'ticket', workspace: 'plan', ticket: 'P-1' } },
    { kind: 'stage_failing', text: 'The digest failed 3 times in a row, last the digest of 2026-11-06 at 08:00.', at: on('2026-11-06', '08:00'), target: { kind: 'digest', id: digestId } },
    { kind: 'review_churn', text: 'C-1: review churn, finding R4 was reopened 3 times.', at: on('2026-11-05', '09:00'), target: { kind: 'job', workspace: 'churn', ticket: 'C-1', archived: true } },
  ]);
  assert.ok(payload.jobs.some((row) => row.dir === archived && row.archived));
  // With a workspace chosen, the digests are left out.
  const ref = await stats(env.state, jobs).compute({ days: 7, workspace: 'ref' });
  assert.deepEqual(ref.warnings.map((warning) => warning.kind), ['job_unusual']);
  assert.equal(ref.notes.digest_excluded, true);
});

// A job still working, iterations of cost each, last updated at updated.
const unusual = (jobs: JobStore, workspace: string, ticket: string, iterations: number, cost: number, updated: string, gateTokens = 0): Promise<void> =>
  makeJob(jobs, workspace, ticket, Array.from({ length: iterations }, () => ({ ended: updated, cost })), { gate_tokens: gateTokens, updated_at: updated });

test('job_unusual: above three times the usual with the floors $5 and 5 iterations; one line per job, only its unusual measures', async () => {
  const env = await newEnv('stats-unusual');
  const jobs = new JobStore(env.state);
  // The usual: $2 and 1 iteration.
  await references(jobs, 'cost', 5, 1, 2, 0);
  await unusual(jobs, 'cost', 'J-1', 1, 5, on('2026-11-06', '10:00'));
  await unusual(jobs, 'cost', 'J-2', 1, 7, on('2026-11-06', '11:00'));
  // 3.5 times the usual $1.125 at $4: under the floor.
  await references(jobs, 'small', 5, 1, 1.125, 0);
  await unusual(jobs, 'small', 'J-3', 1, 4, on('2026-11-06', '12:00'));
  // Only the tokens: the usual is 600k and $1.
  await references(jobs, 'tokens', 5, 1, 1, 600_000);
  await unusual(jobs, 'tokens', 'T-1', 1, 1, on('2026-11-06', '13:00'), 2_100_000);
  // The usual 1 iteration at no cost: 5 iterations warn, 4 do not.
  await references(jobs, 'iter', 5, 1, 0, 0);
  await unusual(jobs, 'iter', 'I-5', 5, 0, on('2026-11-06', '14:00'));
  await unusual(jobs, 'iter', 'I-4', 4, 0, on('2026-11-06', '15:00'));

  const payload = await stats(env.state, jobs).compute({ days: 7, workspace: null });
  const target = (workspace: string, ticket: string) => ({ kind: 'job', workspace, ticket, archived: false });
  assert.deepEqual(payload.warnings, [
    { kind: 'job_unusual', text: 'I-5: 5 iterations (usual 1) — compared with the last 5 finished jobs of iter.', at: on('2026-11-06', '14:00'), target: target('iter', 'I-5') },
    { kind: 'job_unusual', text: 'T-1: 2.1M Codex gate tokens (usual 600k) — compared with the last 5 finished jobs of tokens.', at: on('2026-11-06', '13:00'), target: target('tokens', 'T-1') },
    { kind: 'job_unusual', text: 'J-2: cost $7.00 (usual $2.00) — compared with the last 5 finished jobs of cost.', at: on('2026-11-06', '11:00'), target: target('cost', 'J-2') },
  ]);
});

test('recent only: job and review-churn warnings for jobs updated on the last 7 local days, whatever the period, the stop line from those days too; newest first, ties by ticket; the charts still the period\'s', async () => {
  const env = await newEnv('stats-recent');
  const jobs = new JobStore(env.state);
  await references(jobs, 'ref', 5, 1, 1, 0);
  // 7 iterations at $1: above three times the usual $1 and 1 iteration. The first of the 7 local
  // days warns, the day before it and a job 8 days old do not.
  await unusual(jobs, 'ref', 'B-7', 7, 1, on('2026-11-01', '00:05'));
  await unusual(jobs, 'ref', 'B-8', 7, 1, on('2026-10-31', '23:55'));
  await unusual(jobs, 'ref', 'O-8', 7, 1, on('2026-10-30'));
  // Review churn: 8 days old none, 6 days old one (two at the same time, by ticket).
  for (const [ticket, updated] of [['C-8', on('2026-10-30')], ['E-2', on('2026-11-01', '12:00')], ['E-1', on('2026-11-01', '12:00')]] as const) {
    await makeJob(jobs, 'churn', ticket, [], { state: 'aborted', updated_at: updated });
    await jobs.writeLedger('churn', ticket, [entry('R1', 1, 'claude', 'a', 'A.', 'major', 'fixed', 3)]);
  }
  // A stop line: 20 days old on a job updated yesterday none; on a job 8 days old none.
  await makeJob(jobs, 'churn', 'S-1', [], { state: 'needs_human', updated_at: on('2026-11-06') });
  await event(jobs, 'churn', 'S-1', { ts: on('2026-10-18'), state: { from: 'awaiting_review', to: 'needs_human', error: { code: 'review_churn', message: 'x' } } });
  await makeJob(jobs, 'churn', 'S-8', [], { state: 'needs_human', updated_at: on('2026-10-30') });
  await event(jobs, 'churn', 'S-8', { ts: on('2026-10-30'), state: { from: 'awaiting_review', to: 'needs_human', error: { code: 'review_disputed', message: 'x' } } });

  const churn = (ticket: string) => ({
    kind: 'review_churn', text: `${ticket}: review churn, finding R1 was reopened 3 times.`, at: on('2026-11-01', '12:00'), target: { kind: 'job', workspace: 'churn', ticket, archived: false },
  });
  const expected = [churn('E-1'), churn('E-2'), {
    kind: 'job_unusual', text: 'B-7: cost $7.00 (usual $1.00); 7 iterations (usual 1) — compared with the last 5 finished jobs of ref.',
    at: on('2026-11-01', '00:05'), target: { kind: 'job', workspace: 'ref', ticket: 'B-7', archived: false },
  }];
  for (const days of [7, 30, 90] as const) {
    const payload = await stats(env.state, jobs).compute({ days, workspace: null });
    assert.deepEqual(payload.warnings, expected, `${days} days`);
  }
  // The 30-day period still counts the old jobs.
  const month = await stats(env.state, jobs).compute({ days: 30, workspace: null });
  assert.equal(dayRow(month, '2026-10-30').cost.implementer, 7);
  assert.ok(month.jobs.some((row) => row.ticket === 'O-8'));
});

test('cost_spike: a day above twice the median of the cost days before, with 7 such days, naming the job of the most cost; not with 6', async () => {
  const env = await newEnv('stats-spike');
  const jobs = new JobStore(env.state);
  const days = (count: number) => Array.from({ length: count }, (_, index) => ({ ended: on(`2026-10-${20 + index}`), cost: 2 }));
  for (const [workspace, count] of [['seven', 7], ['six', 6]] as const) {
    await makeJob(jobs, workspace, 'H-1', days(count), { state: 'pushed', created_at: on('2026-10-20'), updated_at: on('2026-10-28') });
    await makeJob(jobs, workspace, 'K-1', [{ ended: on('2026-11-06'), cost: 7 }]);
    await makeJob(jobs, workspace, 'K-2', [{ ended: on('2026-11-06'), cost: 3 }]);
  }
  const seven = await stats(env.state, jobs).compute({ days: 7, workspace: 'seven' });
  assert.deepEqual(seven.warnings, [{
    kind: 'cost_spike', text: '2026-11-06 cost $10.00, more than twice the usual $2.00 (median of the 30 days before); the most on K-1 ($7.00).',
    at: new Date(2026, 10, 6).toISOString(), target: { kind: 'job', workspace: 'seven', ticket: 'K-1', archived: false },
  }]);
  const six = await stats(env.state, jobs).compute({ days: 7, workspace: 'six' });
  assert.deepEqual(six.warnings, []);
});

test('now from the current job states and queue.json (a broken one gives null); time to ready from the first ready line; the workspace filter', async () => {
  const env = await newEnv('stats-now');
  const jobs = new JobStore(env.state);
  await makeJob(jobs, 'app', 'N-1', [], { state: 'working' });
  await makeJob(jobs, 'app', 'N-2', [], { state: 'needs_human' });
  await makeJob(jobs, 'app', 'N-3', [], { state: 'ready_for_human_review', created_at: '2026-11-05T08:00:00.000Z' });
  await makeJob(jobs, 'app', 'N-4', [], { state: 'paused' });
  await makeJob(jobs, 'other', 'O-1', [], { state: 'handed_over', created_at: '2026-11-05T08:00:00.000Z' });
  await makeJob(jobs, 'other', 'O-2', [], { state: 'working' });
  await jobs.archive('other', 'O-2');
  for (const [workspace, ticket] of [['app', 'N-3'], ['other', 'O-1']]) {
    await event(jobs, workspace!, ticket!, { ts: '2026-11-05T08:01:00.000Z', state: { from: 'starting', to: 'working' } });
    await event(jobs, workspace!, ticket!, { ts: '2026-11-05T09:00:00.000Z', state: { from: 'awaiting_review', to: 'ready_for_human_review' } });
    await event(jobs, workspace!, ticket!, { ts: '2026-11-05T10:00:00.000Z', state: { from: 'ready_for_human_review', to: 'handed_over' } });
  }
  const queue = { version: 1, max_running: 3, held: false, hold_reason: null, on_limit: 'wait', errors: [], entries: [
    { workspace: 'app', ticket: 'Q-1', queued_at: NOW.toISOString() }, { workspace: 'other', ticket: 'Q-2', queued_at: NOW.toISOString() },
  ] };
  await writeFile(join(env.state, 'queue.json'), JSON.stringify(queue));

  const all = await stats(env.state, jobs).compute({ days: 7, workspace: null });
  // O-2 is archived: not counted.
  assert.deepEqual(all.now, { running: 1, waiting_for_you: 3, paused: 1, queued: 2 });
  assert.equal(all.jobs.find((row) => row.ticket === 'N-3')!.time_to_ready_s, 3600);
  assert.equal(all.totals.median_time_to_ready_s, 3600);
  assert.deepEqual(all.workspaces, ['app', 'other']);
  assert.deepEqual(all.by_workspace.map((row) => [row.workspace, row.median_time_to_ready_s]), [['app', 3600], ['other', 3600]]);

  const app = await stats(env.state, jobs).compute({ days: 7, workspace: 'app' });
  assert.deepEqual(app.now, { running: 1, waiting_for_you: 2, paused: 1, queued: 1 });
  assert.deepEqual(app.jobs.map((row) => row.ticket).sort(), ['N-1', 'N-2', 'N-3', 'N-4']);
  assert.deepEqual(app.by_workspace.map((row) => row.workspace), ['app']);
  assert.equal(app.notes.digest_excluded, true);

  await writeFile(join(env.state, 'queue.json'), '{ broken');
  assert.equal((await stats(env.state, jobs).compute({ days: 7, workspace: null })).now.queued, null);
});

test('limits and caches: maxJobs, an unreadable job.json, no reread after STATS_CACHE_MS with nothing changed, one reread after a writeReview, an appended result line counted without rereading', async () => {
  const env = await newEnv('stats-cache');
  const jobs = new JobStore(env.state);
  await makeJob(jobs, 'app', 'L-1', [{ ended: on('2026-11-05'), cost: 1 }], { created_at: on('2026-11-03') });
  await makeJob(jobs, 'app', 'L-2', [{ ended: on('2026-11-05'), cost: 1 }], { created_at: on('2026-11-04') });
  await makeJob(jobs, 'app', 'L-3', [{ ended: on('2026-11-05'), cost: 1 }], { created_at: on('2026-11-05') });
  await mkdir(jobs.dir('app', 'BAD'), { recursive: true });
  await writeFile(join(jobs.dir('app', 'BAD'), 'job.json'), '{ not json');
  // An explanation.json that does not parse counts too.
  await writeFile(join(jobs.dir('app', 'L-3'), 'explanation.json'), '{ broken');

  const limited = await stats(env.state, jobs, { maxJobs: 2 }).compute({ days: 7, workspace: null });
  assert.equal(limited.notes.truncated, 1);
  assert.equal(limited.notes.unreadable, 2);
  assert.deepEqual(limited.jobs.map((row) => row.ticket), ['L-3', 'L-2']);

  let clock = NOW.getTime();
  const counter = stats(env.state, jobs, { now: () => new Date(clock) });
  const first = await counter.compute({ days: 7, workspace: null });
  assert.equal(counter.jobReads, 3);
  // Within STATS_CACHE_MS the same payload; concurrent requests share one.
  assert.equal(await counter.compute({ days: 7, workspace: null }), first);
  clock += STATS_CACHE_MS + 1;
  const [a, b] = await Promise.all([counter.compute({ days: 7, workspace: null }), counter.compute({ days: 7, workspace: null })]);
  assert.equal(a, b);
  assert.notEqual(a, first);
  assert.equal(counter.jobReads, 3);

  await jobs.writeReview('app', 'L-2', 1, review([], on('2026-11-06'), 0.5));
  clock += STATS_CACHE_MS + 1;
  const reviewed = await counter.compute({ days: 7, workspace: null });
  assert.equal(counter.jobReads, 4);
  assert.equal(role(reviewed, 'claude_review').cost_usd, 0.5);

  await event(jobs, 'app', 'L-1', { ts: on('2026-11-06'), message: result(40, 4) });
  clock += STATS_CACHE_MS + 1;
  assert.deepEqual(role(await counter.compute({ days: 7, workspace: null }), 'implementer').tokens, { input: 40, output: 4 });
  await event(jobs, 'app', 'L-1', { ts: on('2026-11-06'), message: result(2, 1) });
  clock += STATS_CACHE_MS + 1;
  assert.deepEqual(role(await counter.compute({ days: 7, workspace: null }), 'implementer').tokens, { input: 42, output: 5 });
  assert.equal(counter.jobReads, 4);
});

test('unreadable digest records: each one that does not parse counts once in notes.unreadable and adds nothing; none counted with a workspace chosen', async () => {
  const env = await newEnv('stats-digests-unreadable');
  const jobs = new JobStore(env.state);
  await makeJob(jobs, 'app', 'U-1', [{ ended: on('2026-11-05'), cost: 1 }]);
  await digest(env.state, on('2026-11-05', '08:00'), 0.5);
  const store = new DigestStore(env.state);
  await writeFile(store.path('20261106T060000Z-scheduled'), '{ broken');
  await writeFile(store.path('20261104T060000Z-manual'), 'SECRET-DIGEST');
  // Not a digest record's name: not a digest, not counted.
  await writeFile(join(store.dir, 'notes.json'), '{ broken');

  const all = await stats(env.state, jobs).compute({ days: 7, workspace: null });
  assert.equal(all.notes.unreadable, 2);
  assert.deepEqual(role(all, 'digest'), { role: 'digest', cost_usd: 0.5, complete: true, tokens: null, runs: 1 });
  assert.equal(JSON.stringify(all).includes('SECRET-DIGEST'), false);
  const app = await stats(env.state, jobs).compute({ days: 7, workspace: 'app' });
  assert.equal(app.notes.unreadable, 0);
});

test('plan checks per job and per ticket (SF-130): each job row counts every record of its workspace and ticket, all-time, failed ones included, an unknown cost incomplete; the stage counts the distinct tickets of the period', async () => {
  const env = await newEnv('stats-plan-checks');
  const jobs = new JobStore(env.state);
  await makeJob(jobs, 'app', 'P-1', [{ ended: on('2026-11-05'), cost: 1 }]);
  await makeJob(jobs, 'app', 'P-2', [{ ended: on('2026-11-05'), cost: 1 }]);
  await makeJob(jobs, 'app', 'P-3', [{ ended: on('2026-11-05'), cost: 1 }]);
  // P-1: one before the period (counted all-time), a failed one and a ready one.
  await check(env.state, 'app', 'P-1', 'a', 'checked', on('2026-10-01'), ['major'], 0.5);
  await check(env.state, 'app', 'P-1', 'b', 'failed', on('2026-11-04'), [], 0.25);
  await check(env.state, 'app', 'P-1', 'c', 'checked', on('2026-11-05'), [], 0.25);
  // P-2: one cost unknown.
  await check(env.state, 'app', 'P-2', 'd', 'checked', on('2026-11-05'), [], 0.5);
  await check(env.state, 'app', 'P-2', 'e', 'checked', on('2026-11-06'), [], null);
  // Another workspace's ticket of the same name is not P-1's.
  await check(env.state, 'web', 'P-1', 'f', 'checked', on('2026-11-06'), [], 4);

  const payload = await stats(env.state, jobs).compute({ days: 7, workspace: null });
  const row = (ticket: string) => payload.jobs.find((one) => one.ticket === ticket)!;
  assert.deepEqual([row('P-1').plan_checks, row('P-1').plan_check_usd, row('P-1').plan_check_usd_complete], [3, 1, true]);
  assert.deepEqual([row('P-2').plan_checks, row('P-2').plan_check_usd, row('P-2').plan_check_usd_complete], [2, 0.5, false]);
  assert.deepEqual([row('P-3').plan_checks, row('P-3').plan_check_usd, row('P-3').plan_check_usd_complete], [0, 0, true]);
  // In the period: app/P-1 (two), app/P-2 (two) and web/P-1; the October one is not.
  assert.deepEqual([stage(payload, 'task_check').tickets, stage(payload, 'task_check').runs, stage(payload, 'task_check').failed], [3, 4, 1]);
  assert.deepEqual([stage(payload, 'claude_review').tickets, stage(payload, 'codex_gate').tickets], [null, null]);
});

test('arms (SF-132): the jobs started in the period by claude_review true and false, one without it in neither; delivered, aborted, cost as the job rows sum it, per delivered, median iterations, Codex findings', async () => {
  const env = await newEnv('stats-arms');
  const jobs = new JobStore(env.state);
  // On: pushed (2 iterations, a blocker, a major and a nit of the gate), aborted with an unknown cost, handed over (4 iterations).
  await makeJob(jobs, 'app', 'ON-1', [{ ended: on('2026-11-05'), cost: 1 }, { ended: on('2026-11-05'), cost: 2 }], { claude_review: true, state: 'pushed' });
  await jobs.writeGate('app', 'ON-1', 1, gate([item('a', 'A.', 'blocker'), item('b', 'B.', 'major'), item('c', 'C.', 'nit')], on('2026-11-05')));
  await makeJob(jobs, 'app', 'ON-2', [{ ended: on('2026-11-05'), cost: null }], { claude_review: true, state: 'aborted' });
  await makeJob(jobs, 'app', 'ON-3', Array.from({ length: 4 }, () => ({ ended: on('2026-11-06'), cost: 0.5 })), { claude_review: true, state: 'handed_over' });
  // Off: still working, a major of the gate; one started before the period is in no arm.
  await makeJob(jobs, 'app', 'OFF-1', [{ ended: on('2026-11-06'), cost: 3 }], { claude_review: false });
  await jobs.writeGate('app', 'OFF-1', 1, gate([item('d', 'D.', 'major')], on('2026-11-06')));
  await makeJob(jobs, 'app', 'OFF-0', [{ ended: on('2026-11-02'), cost: 7 }], { claude_review: false, created_at: on('2026-10-20') });
  // Started before SF-131: no claude_review, in neither arm.
  await makeJob(jobs, 'app', 'OLD-1', [{ ended: on('2026-11-05'), cost: 10 }], { state: 'pushed' });
  await jobs.writeGate('app', 'OLD-1', 1, gate([item('e', 'E.', 'blocker')], on('2026-11-05')));

  const payload = await stats(env.state, jobs).compute({ days: 7, workspace: null });
  const row = (ticket: string) => payload.jobs.find((one) => one.ticket === ticket)!;
  assert.deepEqual(['ON-1', 'OFF-1', 'OLD-1'].map((ticket) => row(ticket).claude_review), [true, false, null]);
  assert.deepEqual(payload.arms, [
    { arm: 'on', jobs: 3, delivered: 2, aborted: 1, cost_usd: 5, cost_complete: false, usd_per_delivered: 2.5, median_iterations: 3, codex_findings: 2, codex_findings_per_job: 2 / 3 },
    { arm: 'off', jobs: 1, delivered: 0, aborted: 0, cost_usd: 3, cost_complete: true, usd_per_delivered: null, median_iterations: null, codex_findings: 1, codex_findings_per_job: 1 },
  ]);
  // The arm cost is the sum of its jobs' cost_usd.
  assert.equal(payload.arms[0]!.cost_usd, ['ON-1', 'ON-2', 'ON-3'].reduce((total, ticket) => total + row(ticket).cost_usd, 0));

  // No job of the experiment: both rows, empty.
  const none = await newEnv('stats-arms-none');
  const oldJobs = new JobStore(none.state);
  await makeJob(oldJobs, 'app', 'OLD-1', [{ ended: on('2026-11-05'), cost: 10 }], { state: 'pushed' });
  const empty = await stats(none.state, oldJobs).compute({ days: 7, workspace: null });
  assert.deepEqual(empty.arms.map((arm) => [arm.arm, arm.jobs, arm.cost_usd, arm.cost_complete, arm.usd_per_delivered, arm.median_iterations, arm.codex_findings_per_job]), [
    ['on', 0, 0, true, null, null, null], ['off', 0, 0, true, null, null, null],
  ]);
});

test('simplify (SF-132): offered counts the period\'s simplification records with a suggestion; taken and skipped the period\'s simplify_chosen lines', async () => {
  const env = await newEnv('stats-simplify');
  const jobs = new JobStore(env.state);
  const offer = (path: string) => ({ path, what: 'W.', why: 'Y.', saves_lines: 3, ledger_ids: [] });
  const record = (ended: string, suggestions: ReturnType<typeof offer>[], dropped: ReturnType<typeof offer>[] = []) =>
    ({ reviewer: 'simplify', summary: 'S.', suggestions, dropped, cost_usd: 0.1, model: null, started_at: ended, ended_at: ended });
  for (const ticket of ['S-1', 'S-2', 'S-3', 'S-4', 'S-5']) {
    await makeJob(jobs, 'app', ticket, [{ ended: on('2026-11-05'), cost: 1 }]);
  }
  // Offered: S-1 and S-2; not: no suggestion (only a dropped one), a failed pass, one before the period.
  await jobs.writeSimplify('app', 'S-1', 1, record(on('2026-11-05'), [offer('a'), offer('b')]));
  await jobs.writeSimplify('app', 'S-2', 1, record(on('2026-11-06'), [offer('c')]));
  await jobs.writeSimplify('app', 'S-3', 1, record(on('2026-11-06'), [], [offer('d')]));
  await jobs.writeSimplify('app', 'S-4', 1, { reviewer: 'simplify', error: 'exit 1', started_at: on('2026-11-06'), ended_at: on('2026-11-06') });
  await jobs.writeSimplify('app', 'S-5', 1, record(on('2026-10-20'), [offer('e')]));
  await event(jobs, 'app', 'S-1', { ts: on('2026-11-05'), type: 'simplify_chosen', choice: 'simplify', suggestions: 2 });
  await event(jobs, 'app', 'S-2', { ts: on('2026-11-06'), type: 'simplify_chosen', choice: 'skip', suggestions: 1 });
  await event(jobs, 'app', 'S-5', { ts: on('2026-10-20'), type: 'simplify_chosen', choice: 'skip', suggestions: 1 });

  const payload = await stats(env.state, jobs).compute({ days: 7, workspace: null });
  assert.deepEqual(payload.simplify, { offered: 2, taken: 1, skipped: 1 });
  const month = await stats(env.state, jobs).compute({ days: 30, workspace: null });
  assert.deepEqual(month.simplify, { offered: 3, taken: 1, skipped: 2 });
});
