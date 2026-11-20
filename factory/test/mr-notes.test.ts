// Unit tests of the factory's notes for the user about a job's MR text (src/mr-notes.ts): the nits
// of the last iteration's review and gate, the suggestions the user skipped, the ledger's findings not
// fixed and an Accept over a stop, in that order, uncut; '' without any.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GateOverride, GateRecord, Job, ReviewRecord, SimplifyRecord } from '../src/jobs.js';
import type { LedgerEntry } from '../src/ledger.js';
import { mrNotes, type NotesStore } from '../src/mr-notes.js';
import type { ReviewItem } from '../src/review.js';
import { ACCEPTED_HEADING, FACTORY_NOTE_HEADINGS, FINDINGS_HEADING, NITS_HEADING, SIMPLIFY_HEADING } from '../src/rules.js';
import type { Suggestion } from '../src/simplify.js';

const item = (path: string, problem: string, severity: ReviewItem['severity'] = 'nit'): ReviewItem => ({ path, problem, expected: 'Better.', severity });

function entry(id: string, status: LedgerEntry['status'], extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id, iteration: 1, reviewer: 'claude', severity: 'major', path: 'a.ts', problem: `Problem of ${id}.`, expected: 'Better.', status,
    response: '', evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null, ...extra,
  };
}

const SUGGESTION: Suggestion = { path: 'src/a.ts', what: 'The second null check.', why: 'The caller never passes null.', saves_lines: 6, ledger_ids: ['R2'] };

const review = (items: ReviewItem[]): ReviewRecord => ({ reviewer: 'claude', verdict: 'clean', summary: 'Fine.', items, accepted_sensitive: [], cost_usd: null, started_at: '', ended_at: '' });
const gate = (items: ReviewItem[]): GateRecord => ({ reviewer: 'codex', verdict: 'clean', summary: 'Fine.', items, accepted_sensitive: [], tokens: { input: 0, cached_input: 0, output: 0 }, started_at: '', ended_at: '' });
const simplify = (skipped: boolean): SimplifyRecord => ({
  reviewer: 'claude', summary: 's', suggestions: [SUGGESTION], dropped: [], cost_usd: null, model: null, started_at: '', ended_at: '', ...(skipped ? { skipped_at: '2026-11-20T10:00:00.000Z' } : {}),
});

interface Records {
  reviews?: Record<number, ReviewRecord>;
  gates?: Record<number, GateRecord>;
  simplify?: Record<number, SimplifyRecord>;
  overrides?: Record<number, GateOverride>;
  ledger?: LedgerEntry[];
}

// A NotesStore over the given records, by iteration.
function store(records: Records): NotesStore {
  return {
    readReview: async (_workspace, _ticket, number) => records.reviews?.[number],
    readGate: async (_workspace, _ticket, number) => records.gates?.[number],
    readSimplify: async (_workspace, _ticket, number) => records.simplify?.[number],
    readGateOverride: async (_workspace, _ticket, number) => records.overrides?.[number],
    readLedger: async () => records.ledger ?? [],
  };
}

const job = (iteration: number, claudeReview = true): Job => ({ workspace: 'app', ticket: 'T-1', iteration, claude_review: claudeReview } as Job);
const override = (code: string, unapplied: GateOverride['unapplied'] = []): GateOverride => ({ at: '2026-11-20T10:00:00.000Z', code, unapplied });

test('the headings of the notes, in their order', () => {
  assert.deepEqual(FACTORY_NOTE_HEADINGS, ['### Nits not applied', '### Simplifications not applied', '### Review findings not fixed', '### Accepted over a stop']);
});

test('without any note the notes are empty', async () => {
  assert.equal(await mrNotes(store({}), job(2)), '');
  // A clean review without nits, a fixed finding, a pass not skipped, an Accept over the gate with the Claude review.
  const records: Records = {
    reviews: { 2: review([]) }, gates: { 2: gate([]) }, simplify: { 2: simplify(false) },
    ledger: [entry('R1', 'fixed')], overrides: { 2: override('gate_rounds', [item('g.ts', 'Gate.', 'major')]) },
  };
  assert.equal(await mrNotes(store(records), job(2)), '');
});

test('the nits of the last iteration\'s review and gate, deduplicated; without the Claude review the gate\'s alone', async () => {
  const records: Records = {
    reviews: { 1: review([item('old.ts', 'Old.')]), 2: review([item('a.ts', 'Wording.'), item('m.ts', 'A major.', 'major')]) },
    gates: { 2: gate([item('a.ts', 'Wording.'), item('b.ts', 'Naming.')]) },
  };
  assert.equal(await mrNotes(store(records), job(2)), [NITS_HEADING, '- [nit] `a.ts`: Wording. Expected: Better.', '- [nit] `b.ts`: Naming. Expected: Better.'].join('\n'));
  assert.equal(await mrNotes(store(records), job(2, false)), [NITS_HEADING, '- [nit] `a.ts`: Wording. Expected: Better.', '- [nit] `b.ts`: Naming. Expected: Better.'].join('\n'));
  assert.equal(await mrNotes(store({ reviews: records.reviews }), job(2, false)), '');
  // A review that failed holds no items.
  assert.equal(await mrNotes(store({ reviews: { 2: { reviewer: 'claude', error: 'down' } } }), job(2)), '');
});

test('the suggestions of the newest simplify.json, only when the user skipped them', async () => {
  const line = '- `src/a.ts`: The second null check. Why: The caller never passes null. (saves about 6 lines; added for R2)';
  assert.equal(await mrNotes(store({ simplify: { 2: simplify(true) } }), job(3)), [SIMPLIFY_HEADING, line].join('\n'));
  assert.equal(await mrNotes(store({ simplify: { 2: simplify(false) } }), job(3)), '');
  // The newest record decides: a pass not skipped after a skipped one leaves none.
  assert.equal(await mrNotes(store({ simplify: { 1: simplify(true), 2: simplify(false) } }), job(3)), '');
});

test('the ledger\'s findings not fixed: accepted risks, contests and nits left, not the fixed ones or the user\'s simplifications', async () => {
  const ledger = [
    entry('R1', 'accepted_risk', { settled: { decision: 'accept', note: 'Known risk.', at: '2026-11-05T00:00:00.000Z' } }),
    entry('R2', 'contested', { response: 'Already there.', evidence: 'a.ts:7' }),
    entry('R3', 'left', { severity: 'nit', response: 'Wording stays.' }),
    entry('R4', 'fixed'),
    entry('R5', 'accepted_risk', { reviewer: 'simplify' }),
  ];
  assert.equal(await mrNotes(store({ ledger }), job(2)), [
    FINDINGS_HEADING,
    '- R1 [major, accepted risk] `a.ts`: Problem of R1. — Known risk.',
    '- R2 [major, contested] `a.ts`: Problem of R2. — Already there. Evidence: a.ts:7.',
    '- R3 [nit, left] `a.ts`: Problem of R3. — Wording stays.',
  ].join('\n'));
});

test('an Accept over a stop: at the Fix round limit with the Claude review, over any stop without it; the unapplied items already listed as not fixed left out', async () => {
  const ledger = [entry('R1', 'contested', { response: 'No.' })];
  const unapplied = [{ ...item('a.ts', 'Problem of R1.', 'major'), id: 'R1' }, { ...item('b.ts', 'Open.', 'major'), id: 'R2' }, item('g.ts', 'Gate item.', 'major')];
  const limit = await mrNotes(store({ ledger, overrides: { 2: override('iteration_limit', unapplied) } }), job(2));
  assert.equal(limit.split('\n\n')[1], [
    ACCEPTED_HEADING,
    '- The user accepted iteration 2 over iteration_limit.',
    '- R2 [major] `b.ts`: Open. Expected: Better.',
    '- [major] `g.ts`: Gate item. Expected: Better.',
  ].join('\n'));
  assert.equal(await mrNotes(store({ overrides: { 2: override('review_churn') } }), job(2, false)), [ACCEPTED_HEADING, '- The user accepted iteration 2 over review_churn.'].join('\n'));
  assert.equal(await mrNotes(store({ overrides: { 2: override('gate_failed', 'Codex\n  timed out.') } }), job(2, false)), [
    ACCEPTED_HEADING, '- The user accepted iteration 2 over gate_failed.', '- No reviewer passed iteration 2.', '- The gate failed: Codex timed out.',
  ].join('\n'));
  assert.equal(await mrNotes(store({ overrides: { 2: override('gate_budget') } }), job(2, false)), [ACCEPTED_HEADING, '- The user accepted iteration 2 over gate_budget.', '- No reviewer passed iteration 2.'].join('\n'));
  // With the Claude review an Accept over the gate is no note; nor is an override of an earlier iteration.
  assert.equal(await mrNotes(store({ overrides: { 2: override('gate_rounds', [item('g.ts', 'Gate.', 'major')]) } }), job(2)), '');
  assert.equal(await mrNotes(store({ overrides: { 1: override('iteration_limit') } }), job(2)), '');
});

test('all four notes in order, one blank line between, uncut', async () => {
  const many = Array.from({ length: 2000 }, (_, index) => item(`f${index}.ts`, 'x'.repeat(40)));
  const notes = await mrNotes(store({
    reviews: { 3: review(many) }, simplify: { 2: simplify(true) }, ledger: [entry('R1', 'left', { response: 'Stays.' })],
    overrides: { 3: override('iteration_limit') },
  }), job(3));
  const sections = notes.split('\n\n');
  assert.deepEqual(sections.map((section) => section.split('\n')[0]), FACTORY_NOTE_HEADINGS);
  assert.equal(sections[0]!.split('\n').length, 2001);
  assert.ok(Buffer.byteLength(notes) > 64 * 1024);
  assert.ok(!notes.includes('… and'));
  assert.equal(sections[2], [FINDINGS_HEADING, '- R1 [major, left] `a.ts`: Problem of R1. — Stays.'].join('\n'));
  assert.equal(sections[3], [ACCEPTED_HEADING, '- The user accepted iteration 3 over iteration_limit.'].join('\n'));
});
