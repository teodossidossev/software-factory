// Unit tests of the review round (src/round.ts): where the gate stands and who still runs, the
// order in which the reviewers' ends apply, the merge of two verdicts into one Fix section (one
// item and one ledger entry per shared finding, each item tagged with who raised it), the
// ledger's rules over both verdicts, and Claude's fix winning over a gate that failed or would
// stop the job.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GateRecord, ReviewRecord } from '../src/jobs.js';
import type { LedgerEntry } from '../src/ledger.js';
import { type ReviewItem, scopeItem, sensitiveItem } from '../src/review.js';
import { gatePlace, type RoundInput, roundOutcome, roundRuns } from '../src/round.js';

const item = (path: string, problem: string, severity: ReviewItem['severity'] = 'major', extra: Partial<ReviewItem> = {}): ReviewItem => ({ path, problem, expected: 'Better.', severity, ...extra });

function entry(id: string, status: LedgerEntry['status'], extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id, iteration: 1, reviewer: 'claude', severity: 'major', path: 'a.ts', problem: `Problem of ${id}.`, expected: 'Better.', status,
    response: '', evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null, ...extra,
  };
}

const review = (items: ReviewItem[], accepted: string[] = [], summary = 'Claude says so.'): ReviewRecord => ({
  reviewer: 'claude', verdict: items.some((one) => one.severity !== 'nit') ? 'fix' : 'clean', summary, items, accepted_sensitive: accepted, cost_usd: 0, started_at: 'x', ended_at: 'x',
});
const gate = (items: ReviewItem[], accepted: string[] = [], summary = 'Codex says so.'): GateRecord => ({
  reviewer: 'codex', verdict: items.some((one) => one.severity !== 'nit') ? 'fix' : 'clean', summary, items, accepted_sensitive: accepted,
  tokens: { input: 10, cached_input: 0, output: 10 }, started_at: 'x', ended_at: 'x',
});

function joint(claude: ReviewItem[], codex: ReviewItem[], extra: Partial<RoundInput> = {}): RoundInput {
  return {
    place: 'joint', ledger: [], iteration: 2, claude: { record: review(claude), extra: [] }, gate: { record: gate(codex), extra: [] },
    gateFixes: 0, gateTokens: 100, maxRounds: 2, maxTokens: 1000, ...extra,
  };
}

test('where the gate stands: only without the Claude review; joint when the level runs it and a verdict is kept or it is under the budget; budget at SF_GATE_MAX_TOKENS; off otherwise', () => {
  const at = (extra: Partial<Parameters<typeof gatePlace>[0]>) => gatePlace({ claudeReview: true, levelRuns: true, stored: false, tokens: 0, maxTokens: 10, ...extra });
  assert.equal(at({ claudeReview: false }), 'only');
  assert.equal(at({}), 'joint');
  assert.equal(at({ tokens: 10 }), 'budget');
  assert.equal(at({ tokens: 10, stored: true }), 'joint');
  assert.equal(at({ levelRuns: false }), 'off');
});

test('who still runs: each reviewer of the round without a stored verdict', () => {
  assert.deepEqual(roundRuns('joint', { claude: false, gate: false }), { claude: true, gate: true });
  assert.deepEqual(roundRuns('joint', { claude: true, gate: false }), { claude: false, gate: true });
  assert.deepEqual(roundRuns('joint', { claude: false, gate: true }), { claude: true, gate: false });
  assert.deepEqual(roundRuns('joint', { claude: true, gate: true }), { claude: false, gate: false });
  assert.deepEqual(roundRuns('off', { claude: false, gate: false }), { claude: true, gate: false });
  assert.deepEqual(roundRuns('budget', { claude: false, gate: true }), { claude: true, gate: false });
  assert.deepEqual(roundRuns('only', { claude: false, gate: false }), { claude: false, gate: true });
});

test('the order of the ends: Claude\'s usage limit, its failure, the gate\'s usage limit, then the gate\'s failure', () => {
  const claudeLimit = { provider: 'claude' as const, resets_at: null };
  const codexLimit = { provider: 'codex' as const, resets_at: null };
  const failed: ReviewRecord = { reviewer: 'claude', error: 'It broke.' };
  const gateFailed: GateRecord = { reviewer: 'codex', error: 'Codex broke.', tokens: { input: 0, cached_input: 0, output: 0 }, started_at: 'x', ended_at: 'x' };
  const base = joint([], []);
  assert.deepEqual(roundOutcome({ ...base, claude: { ...base.claude!, limit: claudeLimit }, gate: { ...base.gate!, limit: codexLimit } }), { kind: 'park', step: 'review', limit: claudeLimit, dropped: {} });
  assert.deepEqual(roundOutcome({ ...base, claude: { record: failed, extra: [], code: 'user_settings_weaken_sandbox' }, gate: { ...base.gate!, limit: codexLimit } }),
    { kind: 'stop', code: 'user_settings_weaken_sandbox', message: 'It broke.', dropped: {} });
  assert.deepEqual(roundOutcome({ ...base, claude: { record: failed, extra: [] } }), { kind: 'stop', code: 'review_failed', message: 'It broke.', dropped: {} });
  assert.deepEqual(roundOutcome({ ...base, gate: { ...base.gate!, limit: codexLimit } }), { kind: 'park', step: 'gate', limit: codexLimit, dropped: {} });
  const stopped = roundOutcome({ ...base, gate: { record: gateFailed, extra: [], code: 'gate_sandbox_unavailable' } });
  assert.deepEqual([stopped.kind, stopped.kind === 'stop' && stopped.code], ['stop', 'gate_sandbox_unavailable']);
  const over = roundOutcome({ ...base, gateTokens: 1001 });
  assert.deepEqual([over.kind, over.kind === 'stop' && over.code], ['stop', 'gate_budget']);
});

test('both say fix: one Fix section with both lead lines and both lists, Claude\'s ids first, each item named; a shared item is one item and one entry', () => {
  const outcome = roundOutcome(joint(
    [item('a.ts', 'Broken.'), item('n.ts', 'Wording.', 'nit')],
    [item('b.ts', 'Unsafe.', 'blocker'), item(' a.ts ', 'Broken. ')],
  ));
  assert.equal(outcome.kind, 'fix');
  if (outcome.kind !== 'fix') {
    return;
  }
  assert.equal(outcome.gateFix, true);
  assert.equal(outcome.content, [
    'Review by Claude: Claude says so.',
    'Review by Codex: Codex says so.',
    '',
    '1. [R1, major] `a.ts`: Broken. Expected: Better. (raised by Claude and Codex)',
    '2. [R3, blocker] `b.ts`: Unsafe. Expected: Better. (raised by Codex)',
    '',
    'Nits (optional):',
    '3. [R2, nit] `n.ts`: Wording. Expected: Better. (raised by Claude)',
  ].join('\n'));
  assert.deepEqual(outcome.ledger.map((one) => [one.id, one.reviewer, one.severity, one.path, one.problem, one.asked]), [
    ['R1', 'claude', 'major', 'a.ts', 'Broken.', 2], ['R2', 'claude', 'nit', 'n.ts', 'Wording.', 2], ['R3', 'codex', 'blocker', 'b.ts', 'Unsafe.', 2],
  ]);
});

test('a nit of Claude\'s the gate raises as a major: one entry, a major, and the round is a fix that counts for the gate', () => {
  const outcome = roundOutcome(joint([item('a.ts', 'Slow.', 'nit')], [item('a.ts', 'Slow.', 'major')]));
  assert.equal(outcome.kind, 'fix');
  if (outcome.kind !== 'fix') {
    return;
  }
  assert.equal(outcome.gateFix, true);
  assert.deepEqual(outcome.ledger.map((one) => [one.id, one.reviewer, one.severity]), [['R1', 'claude', 'major']]);
  assert.match(outcome.content, /^1\. \[R1, major\] `a\.ts`: Slow\. Expected: Better\. \(raised by Claude and Codex\)$/m);
  // The ledger entry keeps its own text: the tag is on the Fix item line only.
  assert.equal(outcome.ledger[0]!.problem, 'Slow.');
});

test('a Claude nit the gate raises as a major does not make Claude\'s fix: at SF_GATE_MAX_ROUNDS the round stops with gate_rounds; beside a failed gate, open entries alone do not go on', () => {
  const stopped = roundOutcome(joint([item('a.ts', 'Slow.', 'nit')], [item('a.ts', 'Slow.', 'major')], { gateFixes: 2 }));
  assert.ok(stopped.kind === 'stop' && stopped.code === 'gate_rounds');
  const failed: GateRecord = { reviewer: 'codex', error: 'Codex broke.', tokens: { input: 0, cached_input: 0, output: 0 }, started_at: 'x', ended_at: 'x' };
  const carried = roundOutcome({ ...joint([], [], { ledger: [entry('R1', 'open', { asked: 1 })] }), gate: { record: failed, extra: [] } });
  assert.ok(carried.kind === 'stop' && carried.code === 'gate_failed');
});

test('a gate ledger stop beside a Claude pass that is a fix only by carried entries: the ledger gets no new id and no ask', () => {
  const ledger = [entry('R1', 'open', { asked: 1 }), entry('R2', 'contested', { path: 'c.ts', evidence: 'c.ts:3', asked: 1 })];
  const outcome = roundOutcome(joint([item('n.ts', 'Wording.', 'nit')], [item('c.ts', 'Still.', 'major', { reopens: 'R2' })], { ledger }));
  assert.ok(outcome.kind === 'stop' && outcome.code === 'review_disputed', JSON.stringify(outcome));
  assert.ok(outcome.kind === 'stop');
  if (outcome.kind !== 'stop') {
    return;
  }
  assert.deepEqual(outcome.ledger!.map((one) => [one.id, one.status, one.asked, one.dispute?.reviewer ?? null]), [['R1', 'open', 1, null], ['R2', 'contested', 1, 'codex']]);
});

test('Claude\'s fix that wins over a gate stop is Claude\'s own: its severity and text, not the shared merge', () => {
  const outcome = roundOutcome(joint([item('a.ts', 'Broken.')], [item('a.ts', 'Broken.', 'blocker', { reopens: 'R9' })], { gateFixes: 2 }));
  assert.ok(outcome.kind === 'fix' && !outcome.gateFix);
  assert.ok(outcome.kind === 'fix' && outcome.content === 'Review by Claude: Claude says so.\n\n1. [R1, major] `a.ts`: Broken. Expected: Better.', outcome.kind === 'fix' ? outcome.content : '');
  assert.ok(outcome.kind === 'fix' && outcome.ledger.length === 1 && outcome.ledger[0]!.severity === 'major');
});

test('a gate item that reopens an entry and shares Claude\'s text: Claude\'s item reopens it, once', () => {
  const ledger = [entry('R1', 'fixed', { path: 'a.ts', problem: 'Broken.' })];
  const outcome = roundOutcome(joint([item('a.ts', 'Broken again.')], [item('a.ts', 'Broken again.', 'major', { reopens: 'R1' })], { ledger }));
  assert.ok(outcome.kind === 'fix');
  assert.ok(outcome.kind === 'fix' && outcome.ledger.length === 1 && outcome.ledger[0]!.reopened === 1 && outcome.ledger[0]!.status === 'open');
});

test('an item both reopen is one: the same entry reopened once, not counted twice', () => {
  const ledger = [entry('R1', 'fixed', { path: 'a.ts', problem: 'Broken.' })];
  const outcome = roundOutcome(joint([item('a.ts', 'Broken again.', 'major', { reopens: 'R1' })], [item('a.ts', 'Still broken.', 'blocker', { reopens: 'R1' })], { ledger }));
  assert.equal(outcome.kind, 'fix');
  if (outcome.kind !== 'fix') {
    return;
  }
  assert.deepEqual(outcome.ledger.map((one) => [one.id, one.status, one.reopened, one.severity]), [['R1', 'open', 1, 'blocker']]);
  assert.match(outcome.content, /^1\. \[R1, blocker\] .*\(raised by Claude and Codex\)$/m);
});

test('Claude fix, gate clean: the Fix section has both lead lines and Claude\'s items; no gate fix', () => {
  const outcome = roundOutcome(joint([item('a.ts', 'Broken.')], [item('n.ts', 'Wording.', 'nit')]));
  assert.equal(outcome.kind, 'fix');
  assert.ok(outcome.kind === 'fix' && !outcome.gateFix);
  assert.ok(outcome.kind === 'fix' && outcome.content.startsWith('Review by Claude: Claude says so.\nReview by Codex: Codex says so.\n\n1. [R1, major] `a.ts`'));
});

test('Claude clean, gate fix: the gate\'s items, a gate fix', () => {
  const outcome = roundOutcome(joint([], [item('b.ts', 'Unsafe.')]));
  assert.ok(outcome.kind === 'fix' && outcome.gateFix);
  assert.ok(outcome.kind === 'fix' && outcome.content.includes('1. [R1, major] `b.ts`: Unsafe. Expected: Better. (raised by Codex)'));
});

test('both clean: Clean with the union of the accepted paths; the earlier rounds\' open entries are settled', () => {
  const ledger = [entry('R1', 'open', { asked: 1 })];
  const input = joint([], [], { ledger });
  const outcome = roundOutcome({ ...input, claude: { record: review([], ['package.json']), extra: [] }, gate: { record: gate([], ['.github/ci.yml', 'package.json']), extra: [] } });
  assert.equal(outcome.kind, 'clean');
  assert.ok(outcome.kind === 'clean' && outcome.accepted.join() === 'package.json,.github/ci.yml');
  assert.ok(outcome.kind === 'clean' && outcome.ledger[0]!.status === 'fixed' && outcome.ledger[0]!.fixed_by_clean === 2);
});

test('only a clean round settles: a clean Claude verdict the gate does not follow settles nothing', () => {
  const ledger = [entry('R1', 'open', { asked: 1, reviewer: 'codex' })];
  const outcome = roundOutcome(joint([], [item('b.ts', 'Unsafe.')], { ledger }));
  assert.ok(outcome.kind === 'fix');
  if (outcome.kind !== 'fix') {
    return;
  }
  assert.deepEqual(outcome.ledger.map((one) => [one.id, one.status, one.asked]), [['R1', 'open', 2], ['R2', 'open', 2]]);
  // The entry carried over is named by its ledger reviewer.
  assert.match(outcome.content, /\[R1, major\] `a\.ts`: Problem of R1\. Expected: Better\. \(raised by Codex\)/);
});

test('a marked path one reviewer refuses stays a major item, its entry open, though the other accepts it; one neither accepts is one item of both', () => {
  const both = sensitiveItem('package.json');
  const claudeOnly = scopeItem('docs/x.md');
  const input = joint([], []);
  const outcome = roundOutcome({ ...input, claude: { record: review([], ['.github/ci.yml']), extra: [both, claudeOnly] }, gate: { record: gate([], ['docs/x.md']), extra: [both] } });
  assert.equal(outcome.kind, 'fix');
  if (outcome.kind !== 'fix') {
    return;
  }
  assert.deepEqual(outcome.ledger.map((one) => [one.id, one.path, one.problem, one.status]), [
    ['R1', 'package.json', both.problem, 'open'], ['R2', 'docs/x.md', claudeOnly.problem, 'open'],
  ]);
  assert.match(outcome.content, /\[R1, major\] `package\.json`: .*\(raised by Claude and Codex\)/);
  assert.match(outcome.content, /\[R2, major\] `docs\/x\.md`: .*\(raised by Claude\)$/m);
  // The gate does not accept package.json: its verdict is a fix too.
  assert.equal(outcome.gateFix, true);
  // A path only Claude refuses: the gate's verdict is clean, and the Fix does not count for gate_fixes.
  const alone = roundOutcome({ ...input, claude: { record: review([]), extra: [claudeOnly] }, gate: { record: gate([], ['docs/x.md']), extra: [] } });
  assert.ok(alone.kind === 'fix' && !alone.gateFix && alone.ledger.length === 1 && alone.ledger[0]!.status === 'open');
});

test('a ledger stop of Claude\'s verdict stops the round first; the gate\'s items get no entry', () => {
  const ledger = [entry('R1', 'contested', { evidence: 'a.ts:3' })];
  const outcome = roundOutcome(joint([item('a.ts', 'Still.', 'major', { reopens: 'R1' })], [item('b.ts', 'Unsafe.')], { ledger }));
  assert.equal(outcome.kind, 'stop');
  assert.ok(outcome.kind === 'stop' && outcome.code === 'review_disputed' && outcome.message.startsWith('Claude disputes'));
  assert.ok(outcome.kind === 'stop' && outcome.ledger!.length === 1);
});

test('a ledger stop of the gate\'s verdict: it stops a clean Claude round; with Claude\'s fix, Claude\'s Fix section alone is made', () => {
  const ledger = [entry('R1', 'contested', { evidence: 'a.ts:3', path: 'c.ts' })];
  const stopped = roundOutcome(joint([], [item('c.ts', 'Still.', 'major', { reopens: 'R1' })], { ledger }));
  assert.ok(stopped.kind === 'stop' && stopped.code === 'review_disputed' && stopped.message.startsWith('Codex disputes'));
  const fixed = roundOutcome(joint([item('a.ts', 'Broken.')], [item('c.ts', 'Still.', 'major', { reopens: 'R1' })], { ledger }));
  assert.ok(fixed.kind === 'fix' && !fixed.gateFix);
  assert.ok(fixed.kind === 'fix' && fixed.content === 'Review by Claude: Claude says so.\n\n1. [R2, major] `a.ts`: Broken. Expected: Better.', fixed.kind === 'fix' ? fixed.content : '');
  assert.ok(fixed.kind === 'fix' && fixed.ledger.find((one) => one.id === 'R1')!.dispute === null);
});

test('gate_rounds: the gate\'s fix at SF_GATE_MAX_ROUNDS stops a clean Claude round with nothing applied; with Claude\'s fix, Claude\'s alone', () => {
  const stopped = roundOutcome(joint([], [item('b.ts', 'Unsafe.')], { gateFixes: 2 }));
  assert.ok(stopped.kind === 'stop' && stopped.code === 'gate_rounds' && stopped.ledger === undefined);
  assert.ok(stopped.kind === 'stop' && stopped.message.startsWith('The gate asked for a fix 3 times, over the limit of SF_GATE_MAX_ROUNDS (2); the fix was not applied. Claude: Claude says so. Codex: Codex says so.'));
  const fixed = roundOutcome(joint([item('a.ts', 'Broken.')], [item('b.ts', 'Unsafe.')], { gateFixes: 2 }));
  assert.ok(fixed.kind === 'fix' && !fixed.gateFix && fixed.content === 'Review by Claude: Claude says so.\n\n1. [R1, major] `a.ts`: Broken. Expected: Better.');
  assert.ok(fixed.kind === 'fix' && fixed.ledger.length === 1);
});

test('a gate that failed: Claude\'s fix is its Fix section as Claude alone makes it; a clean Claude verdict stops with the gate\'s code', () => {
  const failed: GateRecord = { reviewer: 'codex', error: 'Codex broke.', tokens: { input: 0, cached_input: 0, output: 0 }, started_at: 'x', ended_at: 'x' };
  const fixed = roundOutcome({ ...joint([item('a.ts', 'Broken.')], []), gate: { record: failed, extra: [] } });
  assert.ok(fixed.kind === 'fix' && !fixed.gateFix && fixed.content === 'Review by Claude: Claude says so.\n\n1. [R1, major] `a.ts`: Broken. Expected: Better.');
  const stopped = roundOutcome({ ...joint([], []), gate: { record: failed, extra: [] } });
  assert.deepEqual(stopped, { kind: 'stop', code: 'gate_failed', message: 'Codex broke.', dropped: { claude: [] } });
  const over = roundOutcome({ ...joint([item('a.ts', 'Broken.')], []), gateTokens: 2000 });
  assert.ok(over.kind === 'fix' && !over.gateFix);
});

test('the Claude review alone: off decides and goes to Clean; at the budget a clean verdict ends in gate_budget; a fix is Claude\'s Fix section', () => {
  const ledger = [entry('R1', 'open', { asked: 1 })];
  const off = roundOutcome({ ...joint([], [], { ledger, place: 'off' }), gate: undefined });
  assert.ok(off.kind === 'clean' && off.ledger[0]!.status === 'fixed');
  const budget = roundOutcome({ ...joint([], [], { place: 'budget', gateTokens: 1000 }), gate: undefined });
  assert.ok(budget.kind === 'stop' && budget.code === 'gate_budget' && budget.message.includes('the limit of SF_GATE_MAX_TOKENS (1000)'));
  const fix = roundOutcome({ ...joint([item('a.ts', 'Broken.')], [], { place: 'budget', gateTokens: 1000 }), gate: undefined });
  assert.ok(fix.kind === 'fix' && fix.content === 'Review by Claude: Claude says so.\n\n1. [R1, major] `a.ts`: Broken. Expected: Better.');
});

test('the gate alone (no Claude review): today\'s Fix text by Codex, a gate fix, without SF_GATE_MAX_ROUNDS', () => {
  const outcome = roundOutcome({ ...joint([], [item('b.ts', 'Unsafe.')], { place: 'only', gateFixes: 5 }), claude: undefined });
  assert.ok(outcome.kind === 'fix' && outcome.gateFix && outcome.content === 'Review by Codex: Codex says so.\n\n1. [R1, major] `b.ts`: Unsafe. Expected: Better.');
});
