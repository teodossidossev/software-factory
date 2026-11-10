// The table of stops and the actions a job offers (SF-129, src/stops.ts): the codes resolve
// (aliases, the usage limit, other), the actions per state and per row with each precondition both
// ways, the availability reasons, the derived lists the Execution and the stats read, and a flow
// with the real sf serve: a settlement at a churn stop is recorded and the job stays needs_human.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GATE_OVERRIDE_CODES, LEDGER_ACCEPT_CODES, MR_RETRY_CODES } from '../src/execution.js';
import { type Job, JobStore, type ReviewRecord } from '../src/jobs.js';
import type { LedgerEntry } from '../src/ledger.js';
import { ACTION_IDS, canonicalStop, codesWith, codesWithAction, type JobFacts, jobActions, NO_FACTS, settleCodes, settleEntries, STOP_CODES, stopFields, STOPS } from '../src/stops.js';
import { call, newEnv, newRepo, putTask, reviewScript, runCli, script, serve, stop, waitFor } from './support/harness.js';

const NOW = new Date('2026-11-07T10:00:00.000Z');
const T0 = '2026-11-07T09:00:00.000Z';

function job(state: Job['state'], extra: Partial<Job> = {}): Job {
  return {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', continues: null, base_commit: null, target_commit: null, worktree: '/wt/T-1', prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state, iteration: 2, session_id: 's1', mr: null,
    created_at: T0, updated_at: T0, ...extra,
  };
}
const stopped = (code: string, extra: Partial<Job> = {}, message = `The ${code} message.`): Job => job('needs_human', { error: { code, message }, ...extra });

const CLEAN: ReviewRecord = { reviewer: 'claude', verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [], cost_usd: 0.1, started_at: T0, ended_at: T0 };
const FIX: ReviewRecord = { ...CLEAN, verdict: 'fix', items: [{ severity: 'major', path: 'a.ts', problem: 'Wrong.', expected: 'Right.' }] };
const GITHUB = { host: 'github', reason: null };

function entry(id: string, status: LedgerEntry['status']): LedgerEntry {
  return {
    id, iteration: 1, reviewer: 'claude', severity: 'major', path: 'a.ts', problem: 'P.', expected: 'E.', status, response: '', evidence: '', reopened: 0, asked: 1,
    caused_by: '', dispute: null, settled: null,
  };
}

// The shown actions as "id:label", the primary marked with "*", a dangerous one with "!".
const shown = (subject: Job, facts: Partial<JobFacts> = {}): string[] =>
  jobActions(subject, { ...NO_FACTS, mrHost: GITHUB, ...facts }, NOW).actions.map((a) => `${a.primary ? '*' : ''}${a.danger ? '!' : ''}${a.action}:${a.label}`);
const reason = (subject: Job, action: (typeof ACTION_IDS)[number], facts: Partial<JobFacts> = {}): string =>
  jobActions(subject, { ...NO_FACTS, mrHost: GITHUB, ...facts }, NOW).availability[action];

test('canonicalStop: every row is its own code, aliases resolve to their row, the usage-limit form of session_failed is usage_limit, any other code is other', () => {
  for (const code of STOP_CODES) {
    assert.equal(canonicalStop(code, 'Some message.', NOW), code);
  }
  for (const [alias, row] of [['mr_interrupted', 'mr_serve_restarted'], ['turn_failed', 'session_failed'], ['permission_mode_mismatch', 'session_failed'],
    ['mr_text_invalid', 'mr_text_missing'], ['mr_commit_failed', 'mr_failed'], ['mr_rebase_failed', 'mr_failed'], ['guard_terms_invalid', 'guard_hit'], ['guard_failed', 'guard_hit']] as const) {
    assert.equal(canonicalStop(alias, '', NOW), row, alias);
  }
  assert.equal(canonicalStop('session_failed', "You've hit your 5-hour limit · resets 3am (Europe/Sofia)", NOW), 'usage_limit');
  // Only the first line counts, and only session_failed (as usage-limit.ts reads it).
  assert.equal(canonicalStop('session_failed', "Crashed.\nYou've hit your limit", NOW), 'session_failed');
  assert.equal(canonicalStop('turn_failed', "You've hit your limit · resets 3am", NOW), 'session_failed');
  for (const code of ['start_failed', '', undefined, null]) {
    assert.equal(canonicalStop(code, 'x', NOW), 'other', String(code));
  }
  assert.deepEqual(stopFields(stopped('mr_rebase_failed'), NOW), { stop_code: 'mr_failed', stop_kind: 'error', stop_group: null });
  assert.deepEqual(stopFields(stopped('review_churn'), NOW), { stop_code: 'review_churn', stop_kind: 'decision', stop_group: 'ledger' });
  // Only a needs_human job has a stop.
  assert.deepEqual(stopFields(job('failed', { error: { code: 'start_failed', message: 'Git failed.' } }), NOW), { stop_code: null, stop_kind: null, stop_group: null });
});

test('jobActions per state: the shown list in order, the first non-dangerous one primary; none primary on a finished or handed-over job', () => {
  for (const state of ['starting', 'working', 'awaiting_review'] as const) {
    assert.deepEqual(shown(job(state)), ['*say:Send', 'pause:Pause', '!abort:Abort…'], state);
  }
  assert.deepEqual(shown(job('preparing_mr')), ['!abort:Abort…']);
  assert.deepEqual(shown(job('paused')), ['*resume:Resume', 'restart:Restart…', '!abort:Abort…']);
  assert.deepEqual(shown(job('waiting_limit')), ['*resume:Resume now', '!abort:Abort…']);
  assert.deepEqual(shown(job('ready_for_human_review', { prepared_commit: 'a'.repeat(40) })), [
    '*review-mr:Review the MR and push', 'approve:Approve…', 'handover:Hand over to my checkout', 'mr-create:Create merge request', 'say:Send', '!abort:Abort…',
  ]);
  assert.deepEqual(shown(job('handed_over')), []);
  assert.deepEqual(shown(job('aborted')), ['restart:Restart…', 'archive:Archive']);
  assert.deepEqual(shown(job('failed')), ['restart:Restart…', 'archive:Archive']);
  // pushed: Create merge request without an open or merged one, Merge on an open one, Refresh with any.
  const mr = (state: 'open' | 'merged' | 'closed') => ({ host: 'github' as const, number: 3, url: 'https://github.com/acme/app/pull/3', state });
  assert.deepEqual(shown(job('pushed')), ['mr-create:Create merge request', 'archive:Archive']);
  assert.deepEqual(shown(job('pushed', { mr: mr('open') })), ['mr-merge:Merge…', 'mr-status:Refresh MR status', 'archive:Archive']);
  assert.deepEqual(shown(job('pushed', { mr: mr('merged') })), ['mr-status:Refresh MR status', 'archive:Archive']);
  assert.deepEqual(shown(job('pushed', { mr: mr('closed') })), ['mr-create:Create merge request', 'mr-status:Refresh MR status', 'archive:Archive']);
});

test('jobActions per row: each stop shows its row\'s actions in order, each precondition both ways', () => {
  const clean = { review: CLEAN };
  const send = 'say:Send';
  const abort = '!abort:Abort…';
  const goOn = 'goon:Tell it to go on';
  // clean_review: Accept with a clean Claude review, the dropped items aside; without the Claude
  // review none is needed; at the Fix round limit whatever the last verdict.
  for (const code of ['gate_rounds', 'gate_budget', 'review_churn', 'review_disputed', 'tests_failed']) {
    assert.deepEqual(shown(stopped(code), clean), ['*accept:Accept and prepare MR', send, abort], code);
    assert.deepEqual(shown(stopped(code), { review: FIX }), [`*${send}`, abort], code);
    assert.deepEqual(shown(stopped(code)), [`*${send}`, abort], code);
    assert.deepEqual(shown(stopped(code), { review: { ...FIX, dropped: FIX.items } })[0], '*accept:Accept and prepare MR', code);
    assert.deepEqual(shown(stopped(code, { claude_review: false }))[0], '*accept:Accept and prepare MR', code);
  }
  assert.deepEqual(shown(stopped('gate_failed'), clean), ['*accept:Accept and prepare MR', goOn, abort]);
  assert.deepEqual(shown(stopped('gate_failed'), { review: { reviewer: 'claude', error: 'Overloaded.' } }), [`*${goOn}`, abort]);
  for (const review of [CLEAN, FIX, undefined]) {
    assert.deepEqual(shown(stopped('iteration_limit'), { review }), ['*accept:Accept and prepare MR', send, 'restart:Restart…', abort]);
  }
  assert.deepEqual(shown(stopped('simplify_offered')), ['*simplify:Simplify', 'accept:Skip', send, abort]);
  assert.deepEqual(shown(stopped('escalated')), [`*${send}`, abort]);
  // retryable and not_retryable: Retry, never after a conflict turn.
  assert.deepEqual(shown(stopped('tests_unavailable'), clean), ['*retry:Retry', 'accept:Accept and prepare MR', send, abort]);
  assert.deepEqual(shown(stopped('tests_unavailable', { mr_conflict_turn: true })), [`*${send}`, abort]);
  assert.deepEqual(shown(stopped('fetch_failed')), ['*retry:Retry', abort]);
  assert.deepEqual(shown(stopped('fetch_failed', { mr_conflict_turn: true })), [`*${goOn}`, abort]);
  for (const code of ['mr_failed', 'mr_commit_failed', 'mr_rebase_failed', 'mr_serve_restarted', 'mr_interrupted']) {
    assert.deepEqual(shown(stopped(code)), ['*retry:Retry', goOn, abort], code);
    assert.deepEqual(shown(stopped(code, { mr_conflict_turn: true })), [`*${goOn}`, abort], code);
  }
  assert.deepEqual(shown(stopped('review_failed')), ['*review:Retry review', abort]);
  for (const code of ['serve_restarted', 'session_failed', 'turn_failed', 'permission_mode_mismatch']) {
    assert.deepEqual(shown(stopped(code)), [`*${goOn}`, 'restart:Restart…', abort], code);
  }
  assert.deepEqual(shown(stopped('session_failed', {}, "You've hit your limit · resets 3am")), [`*${goOn}`, abort]);
  for (const code of ['max_turns', 'sandbox_unavailable', 'publish_failed', 'worktree_remove_failed']) {
    assert.deepEqual(shown(stopped(code)), [`*${goOn}`, abort], code);
  }
  assert.deepEqual(shown(stopped('mr_conflict')), ['*say:Tell it how', abort]);
  for (const code of ['mr_text_missing', 'mr_text_invalid', 'mr_empty', 'odd_code']) {
    assert.deepEqual(shown(stopped(code)), [`*${send}`, abort], code);
  }
  // The guard's stops (SF-122): Retry, as sf retry takes them, never after a conflict turn.
  for (const code of ['guard_hit', 'guard_terms_invalid', 'guard_failed']) {
    assert.deepEqual(shown(stopped(code)), ['*retry:Retry', send, abort], code);
    assert.deepEqual(shown(stopped(code, { mr_conflict_turn: true })), [`*${send}`, abort], code);
  }
  assert.deepEqual(shown(stopped('mr_push_failed', { prepared_commit: 'a'.repeat(40) })), ['*approve:Push again', abort]);
  assert.deepEqual(shown(stopped('mr_push_protected')), [abort]);
  // review-mr is never part of a stop row.
  for (const code of STOP_CODES) {
    assert.ok(STOPS[code].actions.every((candidate) => (candidate.id as string) !== 'review-mr'), code);
  }
});

test('availability: every action has an entry, \'\' or its one-line reason, as the page\'s rules said them', () => {
  const all = jobActions(job('working'), { ...NO_FACTS, mrHost: GITHUB }, NOW).availability;
  assert.deepEqual(Object.keys(all).sort(), [...ACTION_IDS].sort());
  assert.deepEqual([reason(job('working'), 'say'), reason(job('working'), 'goon'), reason(job('working'), 'pause'), reason(job('working'), 'abort')], ['', '', '', '']);
  assert.equal(reason(job('working'), 'approve'), 'not available while the job is working.');
  assert.equal(reason(job('awaiting_review'), 'approve'), 'the reviewers have not reached Clean yet.');
  assert.equal(reason(job('preparing_mr'), 'approve'), 'the branch is being prepared.');
  assert.equal(reason(stopped('gate_rounds'), 'approve'), 'approve pushes a branch prepared at Clean; this job has none yet.');
  assert.equal(reason(job('preparing_mr'), 'pause'), 'the MR is being prepared (commit, rebase); it cannot be paused now.');
  assert.equal(reason(job('paused'), 'pause'), 'only while the Implementer works or the reviewers review.');
  assert.equal(reason(job('working'), 'resume'), 'only for a paused job, or one waiting for limits.');
  assert.equal(reason(job('working'), 'restart'), 'only for a paused, waiting for limits, aborted, failed or needs_human job.');
  assert.equal(reason(job('pushed'), 'abort'), 'the job is already pushed.');
  assert.equal(reason(job('working'), 'archive'), 'only a finished job is archived.');
  assert.equal(reason(job('working'), 'review'), 'only after a failed review.');
  assert.equal(reason(stopped('fetch_failed', { mr_conflict_turn: true }), 'retry'), 'only after a transient MR preparation failure.');
  assert.equal(reason(stopped('guard_failed'), 'retry'), '');
  assert.equal(reason(stopped('odd_code'), 'retry'), 'only after a transient MR preparation failure.');
  assert.equal(reason(stopped('fetch_failed'), 'retry'), '');
  assert.equal(reason(stopped('gate_rounds'), 'simplify'), 'only when the simplification pass offers suggestions (simplify_offered).');
  assert.equal(reason(stopped('simplify_offered'), 'simplify'), '');
  assert.match(reason(stopped('gate_rounds'), 'accept'), /^only at the Fix round limit, or after the gate or the ledger stopped the job/);
  // Skip on simplify_offered is shown always; it is available with a clean review, as before.
  assert.equal(reason(stopped('simplify_offered'), 'accept', { review: CLEAN }), '');
  assert.notEqual(reason(stopped('simplify_offered'), 'accept', { review: FIX }), '');
  assert.equal(reason(job('working'), 'handover'), 'only when the job is ready_for_human_review; it is working.');
  assert.equal(reason(job('working'), 'takeback'), 'only when the job is handed_over; it is working.');
  assert.equal(reason(job('paused', { paused: { from: 'working', step: 'turn', at: T0 } }), 'say'), 'the job is paused: Resume sends the message.');
  assert.equal(reason(job('waiting_limit', { paused: { from: 'awaiting_review', step: 'review', at: T0 } }), 'say'), 'the job waits for limits: Resume now, then send the message.');
  assert.equal(reason(job('pushed'), 'say'), 'messages need working, awaiting_review, needs_human, ready_for_human_review or handed_over; the job is pushed.');
  // The merge request actions: the host's reason, or why not for the job.
  const ready = job('ready_for_human_review', { prepared_commit: 'a'.repeat(40) });
  assert.equal(reason(ready, 'mr-create'), '');
  assert.equal(reason(ready, 'mr-create', { mrHost: { host: null, reason: 'the origin URL names no GitHub or GitLab repository' } }), 'the origin URL names no GitHub or GitLab repository.');
  assert.equal(reason(ready, 'mr-create', { mrHost: null }), 'the Git host is not known yet.');
  assert.equal(reason(job('working'), 'mr-create'), 'a merge request needs a pushed branch, or one ready to approve.');
  assert.equal(reason(job('pushed', { mr: { host: 'github', number: 3, url: 'u', state: 'merged' } }), 'mr-create'), 'the merge request #3 is merged.');
  assert.equal(reason(job('pushed'), 'mr-merge'), 'only an open merge request of a pushed job is merged.');
  assert.equal(reason(job('pushed'), 'mr-status'), 'no merge request yet.');
  // settle: '' at a stop whose row is settled in, a reason everywhere else.
  for (const code of ['escalated', 'review_disputed', 'review_churn']) {
    assert.equal(reason(stopped(code), 'settle'), '', code);
  }
  for (const subject of [stopped('gate_rounds'), job('working'), job('ready_for_human_review')]) {
    assert.equal(reason(subject, 'settle'), 'only while a stop waits for you to settle ledger findings (escalated, review_churn, review_disputed).');
  }
});

test('the derived lists: settleCodes, codesWith and the Execution\'s constants are the table\'s, as the hand-kept lists were', () => {
  assert.deepEqual(settleCodes({ resumes: true }), ['escalated', 'review_disputed']);
  assert.deepEqual(settleCodes({ resumes: false }), ['review_churn']);
  assert.deepEqual(GATE_OVERRIDE_CODES, ['gate_rounds', 'gate_budget', 'gate_failed']);
  assert.deepEqual(LEDGER_ACCEPT_CODES, ['review_churn', 'review_disputed']);
  assert.deepEqual(codesWith('ledger'), ['review_churn', 'review_disputed']);
  assert.deepEqual(codesWith('tests'), ['tests_failed', 'tests_unavailable']);
  assert.deepEqual(codesWith('limit'), ['iteration_limit']);
  assert.deepEqual(codesWithAction('accept'), ['gate_rounds', 'gate_budget', 'gate_failed', 'review_churn', 'review_disputed', 'iteration_limit', 'simplify_offered', 'tests_failed', 'tests_unavailable']);
  // sf retry takes every code of a row with Retry, aliases included, and only those, in the order
  // it has always named them.
  assert.deepEqual(MR_RETRY_CODES, ['fetch_failed', 'mr_serve_restarted', 'mr_interrupted', 'mr_commit_failed', 'mr_rebase_failed', 'mr_failed', 'guard_hit', 'guard_terms_invalid', 'guard_failed', 'tests_unavailable']);
  assert.deepEqual([...MR_RETRY_CODES].sort(), STOP_CODES.filter((code) => STOPS[code].actions.some((candidate) => candidate.id === 'retry')).flatMap((code) => [code, ...STOPS[code].aliases]).sort());
  for (const code of MR_RETRY_CODES) {
    assert.equal(reason(stopped(code), 'retry'), '', code);
  }
  // settleEntries: the escalated and contested entries, on a row the user settles in only.
  const ledger = [entry('R1', 'open'), entry('R2', 'contested'), entry('R3', 'escalated'), entry('R4', 'accepted_risk')];
  for (const code of ['escalated', 'review_disputed', 'review_churn']) {
    assert.deepEqual(settleEntries(stopped(code), ledger, NOW).map((item) => item.id), ['R2', 'R3'], code);
  }
  assert.deepEqual(settleEntries(stopped('gate_rounds'), ledger, NOW), []);
  assert.deepEqual(settleEntries(job('working'), ledger, NOW), []);
});

const ITEM = { path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.', severity: 'major' };

test('flow: a settlement at a churn stop (review_churn, settle resumes false) is recorded and the job stays needs_human', async () => {
  const env = await newEnv('stops-churn-settle', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'stops-churn-settle-repo', false);
  await putTask(env, repo, 'S-1', 'Churn with a contest');
  await script(env, [
    { write: { 'README.md': 'hello world\n' } },
    { write: { 'README.md': 'hello reader\n' }, text: '| R1 | fixed | Done. |\n| R2 | contested | Already right at README.md:1 |' },
  ]);
  const second = { ...ITEM, path: 'a.txt', problem: 'a is empty.', expected: 'A line.' };
  const caused = { path: 'b.txt', problem: 'The fix broke b.', expected: 'b works.', severity: 'major', caused_by: 'R1' };
  await reviewScript(env, [
    { output: { verdict: 'fix', summary: 'Two things.', items: [ITEM, second], accepted_sensitive: [] } },
    { output: { verdict: 'fix', summary: 'The fix broke b.', items: [caused], accepted_sensitive: [] } },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-1' });
    const churn = await waitFor(served, 'S-1', 'needs_human', 2);
    assert.equal(churn.error.code, 'review_churn');
    const jobs = new JobStore(env.state);
    assert.deepEqual((await jobs.readLedger('app', 'S-1')).map((item) => [item.id, item.status]), [['R1', 'fixed'], ['R2', 'contested']]);
    const settled = await runCli(env, ['settle', 'app', 'S-1', 'R2', 'accept', 'Fine as it is.']);
    assert.equal(settled.code, 0, settled.stderr);
    // Recorded, and the job waits as it did: churn is not one of settleCodes({ resumes: true }).
    const after = await waitFor(served, 'S-1', 'needs_human', 2);
    assert.equal(after.error.code, 'review_churn');
    const r2 = (await jobs.readLedger('app', 'S-1')).find((item) => item.id === 'R2');
    assert.deepEqual([r2?.status, r2?.settled?.note], ['accepted_risk', 'Fine as it is.']);
  } finally {
    await stop(served);
  }
});
