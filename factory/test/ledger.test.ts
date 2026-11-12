// Unit tests of the findings ledger (SF-052, src/ledger.ts): the ids of a Fix section, the Report
// table (each answer, a contest without evidence, unreadable rows, left on a major), the five rules
// of a verdict for both reviewers, the user's settlement, the reviewers' prompt and the MR section;
// what a clean verdict of the reviewer that decides the round settles.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerFix, applyVerdict, escalationMessage, type EvidenceContext, findEvidence, headings, type LedgerEntry, ledgerSchema, reportRows, settle, settledLines, unappliedEntries, unsettled, userFixItems } from '../src/ledger.js';
import { FINDINGS_HEADING, NITS_HEADING, withFindings, withNits } from '../src/mr.js';
import { GATE_SCHEMA } from '../src/gate.js';
import { fixContent, REVIEW_SCHEMA, type ReviewItem, reviewOutput, reviewPrompt, scopeItem, sensitiveItem } from '../src/review.js';

const item = (path: string, problem: string, severity: ReviewItem['severity'] = 'major', extra: Partial<ReviewItem> = {}): ReviewItem => ({ path, problem, expected: 'Better.', severity, ...extra });

function entry(id: string, status: LedgerEntry['status'], extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id, iteration: 1, reviewer: 'claude', severity: 'major', path: 'a.ts', problem: `Problem of ${id}.`, expected: 'Better.', status,
    response: '', evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null, ...extra,
  };
}

// A worktree of a.ts (10 lines), test/a.test.ts (5 lines); the Task file's headings.
const context: EvidenceContext = {
  lines: async (path) => ({ 'a.ts': 10, 'test/a.test.ts': 5 } as Record<string, number>)[path],
  // The test names the worktree's test files hold.
  testNamed: async (name) => ['rejects a bad id', 'keeps the order'].includes(name),
  sections: ['SF-1: Demo', 'Behaviour', 'Fix 1'],
};

const REVIEWERS = ['claude', 'codex'] as const;

test('a fix gives every item an id, R1, R2, … in Fix order, blockers and majors first, nits last; the Fix section carries them', () => {
  const applied = applyVerdict({ ledger: [], items: [item('n.ts', 'Wording.', 'nit'), item('a.ts', 'Broken.'), item('b.ts', 'Unsafe.', 'blocker')], extra: [item('package.json', 'Undeclared sensitive path.')], reviewer: 'claude', iteration: 1 });
  assert.equal(applied.kind, 'fix');
  if (applied.kind !== 'fix') {
    return;
  }
  assert.deepEqual(applied.items.map((fixItem) => [fixItem.id, fixItem.item.path]), [['R1', 'a.ts'], ['R2', 'b.ts'], ['R3', 'package.json'], ['R4', 'n.ts']]);
  assert.deepEqual(applied.ledger.map((entry) => [entry.id, entry.status, entry.asked, entry.reviewer, entry.iteration]), [
    ['R1', 'open', 1, 'claude', 1], ['R2', 'open', 1, 'claude', 1], ['R3', 'open', 1, 'claude', 1], ['R4', 'open', 1, 'claude', 1],
  ]);
  assert.equal(fixContent('S.', applied.items), [
    'Review by Claude: S.', '',
    '1. [R1, major] `a.ts`: Broken. Expected: Better.',
    '2. [R2, blocker] `b.ts`: Unsafe. Expected: Better.',
    '3. [R3, major] `package.json`: Undeclared sensitive path. Expected: Better.', '',
    'Nits (optional):',
    '4. [R4, nit] `n.ts`: Wording. Expected: Better.',
  ].join('\n'));
  // The next fix numbers on, and carries the open blocking entries of earlier Fix sections.
  const next = applyVerdict({ ledger: [...applied.ledger.slice(0, 3).map((e) => ({ ...e, status: 'fixed' as const })), applied.ledger[3]!], items: [item('c.ts', 'New.')], extra: [], reviewer: 'codex', iteration: 2 });
  assert.equal(next.kind, 'fix');
  assert.deepEqual(next.kind === 'fix' && next.items.map((fixItem) => fixItem.id), ['R5']);
});

test('the Report table: each answer, a contest without evidence reads as open, unreadable rows, left on a major', async () => {
  const ledger = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'].map((id) => entry(id, 'open'));
  ledger[4] = { ...ledger[4]!, severity: 'nit' };
  // An entry of an earlier Fix section is not this Report's.
  ledger.push(entry('R9', 'open', { asked: 0 }));
  const report = [
    '# Report: SF-1, iteration 2', '',
    '## Fix 1 items',
    '| Id | Outcome | Evidence or note |',
    '|----|---------|------------------|',
    '| R1 | fixed | Done. |',
    '| **R2** | contested | The guard is already at a.ts:7 and test "rejects a bad id". |',
    '| R3 | contested | I think it is fine. |',
    '| R4 | escalated | Which currency does the client bill in? |',
    '| R5 | left | Wording stays. |',
    '| R6 | left | Not now. |',
    '| R7 | maybe | ? |',
    '| R9 | fixed | Not asked here. |',
  ].join('\n');
  const answered = await answerFix(ledger, report, 1, context);
  const byId = new Map(answered.ledger.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('R1')!.status, 'fixed');
  assert.equal(byId.get('R1')!.response, 'Done.');
  assert.equal(byId.get('R2')!.status, 'contested');
  assert.equal(byId.get('R2')!.evidence, 'a.ts:7; test "rejects a bad id"');
  // A wish to contest is not evidence.
  assert.deepEqual([byId.get('R3')!.status, byId.get('R3')!.response], ['open', 'I think it is fine.']);
  assert.deepEqual([byId.get('R4')!.status, byId.get('R4')!.response], ['escalated', 'Which currency does the client bill in?']);
  assert.equal(byId.get('R5')!.status, 'left');
  // left on a major, an unreadable row and a missing row read as open.
  assert.equal(byId.get('R6')!.status, 'open');
  assert.equal(byId.get('R7')!.status, 'open');
  assert.equal(byId.get('R8')!.status, 'open');
  assert.equal(byId.get('R9')!.status, 'open');
  assert.deepEqual(answered.escalated.map((entry) => entry.id), ['R4']);
  // The earlier template's "rejected" reads as contested; a fix the user decided is settled by fixed only.
  const rows = reportRows('| 1 | R2 | rejected | §Behaviour says so |\n| R1 | escalated | ? |');
  assert.deepEqual(rows, [{ id: 'R2', answer: 'contested', note: '§Behaviour says so' }, { id: 'R1', answer: 'escalated', note: '?' }]);
  const user = await answerFix([entry('R1', 'user_fix'), entry('R2', 'user_fix')], '| R1 | contested | a.ts:1 |\n| R2 | fixed | ok |', 1, context);
  assert.deepEqual(user.ledger.map((entry) => entry.status), ['open', 'fixed']);
  // An escalation without a question reads as open.
  assert.equal((await answerFix([entry('R1', 'open')], '| R1 | escalated | |', 1, context)).ledger[0]!.status, 'open');
});

test("evidence: a path:line within a file of the worktree, a test file or a quoted test name, a §section of the Task file, a quote of the user's message", async () => {
  assert.equal(await findEvidence('see a.ts:10', context), 'a.ts:10');
  assert.equal(await findEvidence('see a.ts:11, b.ts:1, /etc/passwd:1, ../a.ts:1', context), '');
  assert.equal(await findEvidence('covered by test/a.test.ts', context), 'test/a.test.ts');
  assert.equal(await findEvidence("the test 'keeps the order' covers it", context), 'test "keeps the order"');
  assert.equal(await findEvidence('§Behaviour: the Task asks for it; §Nowhere', context), '§behaviour');
  assert.equal(await findEvidence('I disagree.', context), '');
  // A quoted text no test file holds is a wish, not a test.
  assert.equal(await findEvidence('This tests nothing, I "disagree"', context), '');
  assert.deepEqual(headings('# T\n```\n## not\n```\n## Behaviour\ntext\n### Fix 1 items'), ['T', 'Behaviour', 'Fix 1 items']);

  // SF-112: a quote of the user's own message to the job, case and spacing aside, at least 8 characters.
  const said: EvidenceContext = { ...context, userMessages: ['Please merge the anonymous rows into one row.'] };
  assert.equal(await findEvidence('contested: user message "merge the anonymous rows"', said), 'user message "merge the anonymous rows"');
  assert.equal(await findEvidence("as the user's message `Merge  the ANONYMOUS rows` asked", said), 'user message "Merge the ANONYMOUS rows"');
  assert.equal(await findEvidence('contested: user message "split the rows apart"', said), '');
  assert.equal(await findEvidence('contested: user message "merge t"', said), '');
  assert.equal(await findEvidence('contested: user message "merge the anonymous rows"', context), '');
  // A long quote is recorded cut to 200 characters.
  const long = `${'word '.repeat(60)}end`;
  const quoted = await findEvidence(`user message "${long}"`, { ...context, userMessages: [long] });
  assert.equal(quoted, `user message "${long.slice(0, 199)}…"`);
  const answered = await answerFix([entry('R1', 'open')], '| R1 | contested | user message "merge the anonymous rows" |', 1, said);
  assert.deepEqual([answered.ledger[0]!.status, answered.ledger[0]!.evidence], ['contested', 'user message "merge the anonymous rows"']);
});

for (const reviewer of REVIEWERS) {
  test(`rule 1 (${reviewer}): an item that reopens an accepted risk is dropped, whatever its severity`, () => {
    const ledger = [entry('R1', 'accepted_risk', { settled: { decision: 'accept', note: 'ok', at: '2026-11-05T00:00:00.000Z' } })];
    const reopening = item('a.ts', 'Still risky.', 'blocker', { reopens: 'R1' });
    const applied = applyVerdict({ ledger, items: [reopening], extra: [], reviewer, iteration: 2 });
    assert.equal(applied.kind, 'clean');
    assert.deepEqual(applied.dropped, [reopening]);
    assert.deepEqual(applied.ledger, ledger);
    // Raised again without naming it: the same path and problem text is the same risk.
    const unnamed = item(' a.ts', 'problem of  R1.', 'major');
    assert.deepEqual(applyVerdict({ ledger, items: [unnamed], extra: [], reviewer, iteration: 2 }).dropped, [unnamed]);
  });

  test(`rule 2 (${reviewer}): an item that reopens a contested entry is a dispute with both positions`, () => {
    const ledger = [entry('R1', 'contested', { response: 'Guarded already.', evidence: 'a.ts:7' })];
    const applied = applyVerdict({ ledger, items: [item('a.ts', 'The guard misses null.', 'major', { reopens: 'R1' }), item('b.ts', 'Other.')], extra: [], reviewer, iteration: 2 });
    assert.equal(applied.kind, 'stop');
    assert.equal(applied.kind === 'stop' && applied.code, 'review_disputed');
    const message = applied.kind === 'stop' ? applied.message : '';
    assert.match(message, /Guarded already\. Evidence: a\.ts:7\./);
    assert.match(message, /reopens it: The guard misses null\. Expected: Better\./);
    assert.match(message, /Accept and prepare the MR .*continue .*back to planning/);
    assert.deepEqual(applied.ledger[0]!.dispute, { reviewer, iteration: 2, reason: 'The guard misses null. Expected: Better.' });
    assert.deepEqual(unsettled(applied.ledger).map((e) => e.id), ['R1']);
    // A nit never stops the job.
    assert.equal(applyVerdict({ ledger, items: [item('a.ts', 'Name.', 'nit', { reopens: 'R1' })], extra: [], reviewer, iteration: 2 }).kind, 'clean');
  });

  test(`rule 3 (${reviewer}): an item that reopens a fixed entry opens it again; the second reopening is churn`, () => {
    const first = applyVerdict({ ledger: [entry('R1', 'fixed', { response: 'Done.' })], items: [item('a.ts', 'Not really fixed.', 'major', { reopens: 'R1' })], extra: [], reviewer, iteration: 2 });
    assert.equal(first.kind, 'fix');
    assert.deepEqual(first.kind === 'fix' && first.items.map((fixItem) => [fixItem.id, fixItem.item.problem]), [['R1', 'Not really fixed.']]);
    assert.deepEqual([first.ledger[0]!.status, first.ledger[0]!.reopened, first.ledger[0]!.asked, first.ledger[0]!.response], ['open', 1, 2, '']);
    const fixedAgain = first.ledger.map((e) => ({ ...e, status: 'fixed' as const }));
    const second = applyVerdict({ ledger: fixedAgain, items: [item('a.ts', 'Still not.', 'major', { reopens: 'R1' })], extra: [], reviewer, iteration: 3 });
    assert.equal(second.kind === 'stop' && second.code, 'review_churn');
    assert.equal(second.ledger[0]!.reopened, 2);
    // A nit never reopens a fix nor counts for churn; it stays optional under the entry's id.
    const nitOnFix = applyVerdict({ ledger: fixedAgain, items: [item('a.ts', 'Could be named better.', 'nit', { reopens: 'R1' })], extra: [], reviewer, iteration: 3 });
    assert.equal(nitOnFix.kind, 'clean');
    assert.deepEqual([nitOnFix.ledger[0]!.status, nitOnFix.ledger[0]!.reopened, nitOnFix.ledger[0]!.severity], ['fixed', 1, 'major']);
    // A blocker reopening a major raises it; a major reopening a blocker keeps it a blocker.
    const blockerEntry = applyVerdict({ ledger: [entry('R1', 'fixed', { severity: 'blocker' })], items: [item('a.ts', 'Back.', 'major', { reopens: 'R1' })], extra: [], reviewer, iteration: 2 });
    assert.equal(blockerEntry.ledger[0]!.severity, 'blocker');
  });

  test(`rule 4 (${reviewer}): when every blocker and major item names the fix that caused it, it is churn`, () => {
    const ledger = [entry('R1', 'fixed')];
    const caused = applyVerdict({ ledger, items: [item('b.ts', 'The fix broke b.', 'major', { caused_by: 'R1' }), item('c.ts', 'Nit.', 'nit')], extra: [], reviewer, iteration: 2 });
    assert.equal(caused.kind === 'stop' && caused.code, 'review_churn');
    assert.match(caused.kind === 'stop' ? caused.message : '', /caused by R1/);
    // One blocking item of its own, or a caused_by that names no entry: the verdict applies.
    assert.equal(applyVerdict({ ledger, items: [item('b.ts', 'Broke b.', 'major', { caused_by: 'R1' }), item('c.ts', 'Own.')], extra: [], reviewer, iteration: 2 }).kind, 'fix');
    assert.equal(applyVerdict({ ledger, items: [item('b.ts', 'Broke b.', 'major', { caused_by: 'R9' })], extra: [], reviewer, iteration: 2 }).kind, 'fix');
  });

  test(`rule 5 (${reviewer}): otherwise the verdict applies as before, with the open blocking entries and the user's fixes`, () => {
    // Nits only: clean, nothing recorded.
    assert.equal(applyVerdict({ ledger: [], items: [item('a.ts', 'Name.', 'nit')], extra: [], reviewer, iteration: 1 }).kind, 'clean');
    // An open major the Report did not settle comes back, even under a clean verdict.
    const open = [entry('R1', 'open', { response: 'I think it is fine.' }), entry('R2', 'open', { severity: 'nit' })];
    const applied = applyVerdict({ ledger: open, items: [], extra: [], reviewer, iteration: 2 });
    assert.equal(applied.kind, 'fix');
    assert.deepEqual(applied.kind === 'fix' && applied.items.map((fixItem) => fixItem.id), ['R1']);
    const user = [entry('R1', 'user_fix', { severity: 'nit', settled: { decision: 'fix', note: 'Do it now.', at: '2026-11-05T00:00:00.000Z' } })];
    const decided = applyVerdict({ ledger: user, items: [], extra: [], reviewer, iteration: 2 });
    assert.equal(decided.kind === 'fix' && fixContent('S.', decided.items).split('\n')[2], '1. [R1, nit] `a.ts`: Problem of R1. Expected: Better. The user decided: fix. Do it now.');
  });
}

test('settling: only escalated and contested entries; accept is accepted_risk, fix user_fix and the next Fix section', () => {
  const ledger = [entry('R1', 'escalated', { response: 'Which?' }), entry('R2', 'contested', { dispute: { reviewer: 'codex', iteration: 2, reason: 'No.' } }), entry('R3', 'fixed')];
  assert.match(settle(ledger, 'R3', 'accept', '', '2026-11-05T00:00:00.000Z') as string, /R3 is fixed/);
  assert.match(settle(ledger, 'R9', 'accept', '', '2026-11-05T00:00:00.000Z') as string, /no entry R9/);
  const accepted = settle(ledger, 'R1', 'accept', 'EUR only.', '2026-11-05T00:00:00.000Z') as LedgerEntry[];
  assert.deepEqual([accepted[0]!.status, accepted[0]!.settled?.note], ['accepted_risk', 'EUR only.']);
  assert.deepEqual(unsettled(accepted).map((e) => e.id), ['R2']);
  const fixed = settle(accepted, 'R2', 'fix', 'Handle null.', '2026-11-05T00:00:00.000Z') as LedgerEntry[];
  assert.deepEqual([fixed[1]!.status, fixed[1]!.dispute], ['user_fix', null]);
  assert.deepEqual(unsettled(fixed), []);
  const next = userFixItems(fixed, 2);
  assert.deepEqual(next.items.map((fixItem) => [fixItem.id, fixItem.userNote]), [['R2', 'Handle null.']]);
  assert.equal(next.ledger[1]!.asked, 2);
  assert.deepEqual(unappliedEntries([...fixed, entry('R4', 'open')]).map((e) => e.id), ['R2', 'R4']);
  // Open blockers and majors ride along with the user's fixes, but never make a Fix on their own:
  // without a user_fix the stopped review runs again and brings them back itself.
  const open = entry('R5', 'open');
  assert.deepEqual(userFixItems([...fixed, open], 2).items.map((fixItem) => fixItem.id), ['R2', 'R5']);
  assert.deepEqual(userFixItems([accepted[0]!, open], 2), { items: [], ledger: [accepted[0]!, open] });
});

test('the reviewers\' prompt carries the settled findings (every entry not open) and the rules on them', () => {
  const ledger = [
    entry('R1', 'fixed', { response: 'Guard added.' }),
    entry('R2', 'contested', { response: 'Already there.', evidence: 'a.ts:7' }),
    entry('R3', 'accepted_risk', { settled: { decision: 'accept', note: 'Known.', at: '2026-11-05T00:00:00.000Z' } }),
    entry('R4', 'open'),
  ];
  const prompt = reviewPrompt({ ticket: 'SF-1', iteration: 2, task: '# T', report: 'r', patch: Buffer.from(''), patchTruncated: false, files: [], handbook: '## Review rules\n\n- rule', ledger });
  const block = prompt.slice(prompt.indexOf('\n<settled_findings>\n') + 1, prompt.indexOf('\n</settled_findings>') + 1);
  assert.deepEqual(block.split('\n').slice(1, -1), [
    '- R1 · fixed · major · `a.ts`: Problem of R1. Response: Guard added.',
    '- R2 · contested · major · `a.ts`: Problem of R2. Response: Already there. Evidence: a.ts:7',
    '- R3 · accepted_risk · major · `a.ts`: Problem of R3. The user decided: accept the risk (Known.)',
  ]);
  assert.match(prompt, /Do not raise a settled finding again, nor a narrower variant of it\./);
  assert.match(prompt, /set `reopens` to its id and say why/);
  assert.match(prompt, /`caused_by`/);
  assert.deepEqual(settledLines([entry('R1', 'open')]), ['None.']);
});

test('the MR text lists the findings not fixed (accepted risks, contests, nits left) with their ids, after the nits', () => {
  const text = ['feat(SF-1): x', '', '## Special things to note', '- None.', '', '## Change outline', 'x', ''].join('\n');
  const ledger = [
    entry('R1', 'accepted_risk', { settled: { decision: 'accept', note: 'Known risk.', at: '2026-11-05T00:00:00.000Z' } }),
    entry('R2', 'contested', { response: 'Already there.', evidence: 'a.ts:7' }),
    entry('R3', 'left', { severity: 'nit', response: 'Wording stays.' }),
    entry('R4', 'fixed'),
  ];
  const written = withFindings(withNits(text, [item('n.ts', 'Name.', 'nit')], 2), ledger);
  assert.equal(written, [
    'feat(SF-1): x', '', '## Special things to note',
    NITS_HEADING, '- [nit] `n.ts`: Name. Expected: Better.', '',
    FINDINGS_HEADING,
    '- R1 [major, accepted risk] `a.ts`: Problem of R1. — Known risk.',
    '- R2 [major, contested] `a.ts`: Problem of R2. — Already there. Evidence: a.ts:7.',
    '- R3 [nit, left] `a.ts`: Problem of R3. — Wording stays.', '',
    '## Change outline', 'x', '',
  ].join('\n'));
  // Written again (a later preparation), the subsection is replaced, not repeated.
  assert.equal(withFindings(written, ledger), written);
  assert.equal(withFindings(text, [entry('R4', 'fixed')]), text);
});

for (const reviewer of REVIEWERS) {
  test(`a contested sensitive path the reviewer (${reviewer}) still does not accept is a dispute, its evidence kept; a fixed one raised again is reopened`, () => {
    const sensitive = item('package.json', 'Undeclared sensitive path.');
    const contested = [entry('R1', 'contested', { path: 'package.json', problem: 'Undeclared sensitive path.', response: 'The tests need npm.', evidence: 'a.ts:1' })];
    const disputed = applyVerdict({ ledger: contested, items: [], extra: [sensitive], reviewer, iteration: 2 });
    assert.equal(disputed.kind === 'stop' && disputed.code, 'review_disputed');
    const message = disputed.kind === 'stop' ? disputed.message : '';
    assert.match(message, /The Implementer contests it: The tests need npm\. Evidence: a\.ts:1\./);
    assert.match(message, new RegExp(`${reviewer === 'codex' ? 'Codex' : 'Claude'} reopens it: .*does not accept the undeclared sensitive path package\\.json`));
    assert.deepEqual([disputed.ledger[0]!.status, disputed.ledger[0]!.evidence, disputed.ledger[0]!.dispute?.reviewer], ['contested', 'a.ts:1', reviewer]);
    assert.deepEqual(unsettled(disputed.ledger).map((e) => e.id), ['R1']);

    const fixed = [entry('R1', 'fixed', { path: 'package.json', problem: 'Undeclared sensitive path.' })];
    const reopened = applyVerdict({ ledger: fixed, items: [], extra: [sensitive], reviewer, iteration: 2 });
    assert.deepEqual(reopened.kind === 'fix' && reopened.items.map((fixItem) => fixItem.id), ['R1']);
    assert.deepEqual([reopened.ledger[0]!.status, reopened.ledger[0]!.reopened], ['open', 1]);
    const twice = applyVerdict({ ledger: [{ ...fixed[0]!, reopened: 1 }], items: [], extra: [sensitive], reviewer, iteration: 3 });
    assert.equal(twice.kind === 'stop' && twice.code, 'review_churn');
  });
}

test('a sensitive path keeps its entry: raised again under its id, dropped once the user accepted the risk; a nit on a contest keeps the contest\'s id; churn says what was claimed before', () => {
  const sensitive = item('package.json', 'Undeclared sensitive path.');
  const accepted = [entry('R1', 'accepted_risk', { path: 'package.json', problem: 'Undeclared sensitive path.' })];
  const dropped = applyVerdict({ ledger: accepted, items: [], extra: [sensitive], reviewer: 'claude', iteration: 2 });
  // Recorded with the entry it reopened.
  assert.deepEqual([dropped.kind, dropped.dropped], ['clean', [{ ...sensitive, reopens: 'R1' }]]);
  // Raised again while it is still open: the same entry, not a new one.
  const open = applyVerdict({ ledger: [entry('R1', 'open', { path: 'package.json', problem: 'Undeclared sensitive path.' })], items: [], extra: [sensitive], reviewer: 'claude', iteration: 2 });
  assert.deepEqual(open.kind === 'fix' && open.items.map((fixItem) => fixItem.id), ['R1']);
  assert.equal(open.ledger.length, 1);

  const nitOnContest = applyVerdict({ ledger: [entry('R1', 'contested'), entry('R2', 'open', { asked: 1 })], items: [item('a.ts', 'Name.', 'nit', { reopens: 'R1' })], extra: [], reviewer: 'claude', iteration: 2 });
  assert.deepEqual(nitOnContest.kind === 'fix' && nitOnContest.items.map((fixItem) => fixItem.id), ['R2', 'R1']);
  assert.equal(nitOnContest.ledger.find((e) => e.id === 'R1')!.status, 'contested');

  const twice = applyVerdict({ ledger: [entry('R1', 'fixed', { reopened: 1, response: 'Guard added.' })], items: [item('a.ts', 'Still open.', 'major', { reopens: 'R1' })], extra: [], reviewer: 'claude', iteration: 3 });
  assert.match(twice.kind === 'stop' ? twice.message : '', /Before: Problem of R1\. \(answered fixed: Guard added\.\)/);
  const caused = applyVerdict({ ledger: [entry('R1', 'fixed')], items: [item('b.ts', 'Broke b.', 'major', { caused_by: 'R1' })], extra: [], reviewer: 'codex', iteration: 2 });
  assert.match(caused.kind === 'stop' ? caused.message : '', /caused by R1, the fix of: Problem of R1\./);
});

test('reopens and caused_by are a ledger id or "" in both reviewers\' schema: anything else is an invalid verdict', () => {
  const verdict = (extra: Record<string, unknown>) => ({ verdict: 'fix', summary: 'S.', accepted_sensitive: [], items: [{ path: 'a.ts', problem: 'P.', expected: 'E.', severity: 'major', ...extra }] });
  for (const valid of [{}, { reopens: '', caused_by: '' }, { reopens: 'R7', caused_by: 'R12' }]) {
    assert.equal(reviewOutput.safeParse(verdict(valid)).success, true, JSON.stringify(valid));
  }
  for (const invalid of [{ reopens: 'R7 please' }, { reopens: 'r7' }, { reopens: 'R0' }, { caused_by: 'Fix 1' }, { caused_by: ' R1' }, { reopens: 7 }]) {
    assert.equal(reviewOutput.safeParse(verdict(invalid)).success, false, JSON.stringify(invalid));
  }
  // The schemas sent to Claude and to Codex carry the same pattern.
  for (const schema of [REVIEW_SCHEMA, GATE_SCHEMA]) {
    const properties = (schema.properties as { items: { items: { properties: Record<string, { pattern?: string }> } } }).items.items.properties;
    for (const field of ['reopens', 'caused_by']) {
      const pattern = new RegExp(properties[field]!.pattern!);
      assert.deepEqual(['', 'R7', 'R7 please', 'Fix 1'].map((value) => pattern.test(value)), [true, true, false, false], field);
    }
  }
});

test('a stop message with oversized facts stays within its bound and keeps its question whole: dispute, churn (both kinds), escalation', () => {
  const long = 'x'.repeat(5000);
  const question = /Accept and prepare the MR \(when Claude's review of the iteration is clean; the open findings go unapplied\), continue \(sf settle the entries or sf say\), or back to planning \(abort, keeping the branch\)\?$/;
  const contested = ['R1', 'R2', 'R3'].map((id) => entry(id, 'contested', { problem: long, response: long, evidence: 'a.ts:1' }));
  const disputed = applyVerdict({ ledger: contested, items: contested.map((e) => item('a.ts', long, 'major', { reopens: e.id, expected: long } as Partial<ReviewItem>)), extra: [], reviewer: 'codex', iteration: 2 });
  const fixed = ['R1', 'R2'].map((id) => entry(id, 'fixed', { reopened: 1, problem: long, response: long }));
  const churned = applyVerdict({ ledger: fixed, items: fixed.map((e) => item('a.ts', long, 'major', { reopens: e.id })), extra: [], reviewer: 'claude', iteration: 3 });
  const caused = applyVerdict({ ledger: [entry('R1', 'fixed', { problem: long })], items: [1, 2, 3].map(() => item('b.ts', long, 'major', { caused_by: 'R1' })), extra: [], reviewer: 'codex', iteration: 2 });
  for (const [what, applied] of [['dispute', disputed], ['churn', churned], ['caused', caused]] as const) {
    assert.equal(applied.kind, 'stop', what);
    const message = applied.kind === 'stop' ? applied.message : '';
    assert.ok(message.length <= 2000, `${what}: ${message.length}`);
    assert.match(message, question, what);
    // The facts are shortened, not dropped: each item is still named.
    assert.match(message, /R1/, what);
    assert.match(message, /…/, what);
  }
  assert.match(disputed.kind === 'stop' ? disputed.message : '', /Settle each disputed entry: accept the risk or must fix \(sf settle <workspace> <ticket> <id> accept\|fix \[note\]\)\. Accept/);
  const escalated = escalationMessage(['R1', 'R2'].map((id) => entry(id, 'escalated', { problem: long, response: long })));
  assert.ok(escalated.length <= 2000, String(escalated.length));
  assert.match(escalated, /^The Implementer escalated R1, R2: only you know the answer\. /);
  assert.match(escalated, /Settle each: accept the risk or must fix \(sf settle <workspace> <ticket> <id> accept\|fix \[note\]\); then the review runs, or the Fix you decided\.$/);
  assert.match(escalated, /R2 \(major/);
  // A short message is left as it is.
  assert.equal(escalationMessage([entry('R1', 'escalated', { response: 'Which?' })]), 'The Implementer escalated R1: only you know the answer. R1 (major, `a.ts`): Problem of R1. Question: Which? Settle each: accept the risk or must fix (sf settle <workspace> <ticket> <id> accept|fix [note]); then the review runs, or the Fix you decided.');
});

test('a stop over many findings keeps its question whole: the id list and the facts are capped, the rest counted', () => {
  const question = /Accept and prepare the MR \(when Claude's review of the iteration is clean; the open findings go unapplied\), continue \(sf settle the entries or sf say\), or back to planning \(abort, keeping the branch\)\?$/;
  const ids = Array.from({ length: 60 }, (_, index) => `R${index + 1}`);
  const contested = ids.map((id) => entry(id, 'contested', { response: 'Done.', evidence: 'a.ts:1' }));
  const disputed = applyVerdict({ ledger: contested, items: ids.map((id) => item('a.ts', 'Wrong.', 'major', { reopens: id })), extra: [], reviewer: 'codex', iteration: 2 });
  const fixed = ids.map((id) => entry(id, 'fixed', { reopened: 1 }));
  const churned = applyVerdict({ ledger: fixed, items: ids.map((id) => item('a.ts', 'Back.', 'major', { reopens: id })), extra: [], reviewer: 'claude', iteration: 3 });
  const caused = applyVerdict({ ledger: [entry('R1', 'fixed')], items: ids.map((id) => item(`${id}.ts`, 'Broke it.', 'major', { caused_by: 'R1' })), extra: [], reviewer: 'codex', iteration: 2 });
  const escalated = escalationMessage(ids.map((id) => entry(id, 'escalated', { response: 'Which one?' })));
  const messages: Array<[string, string]> = [
    ['dispute', disputed.kind === 'stop' ? disputed.message : ''],
    ['churn', churned.kind === 'stop' ? churned.message : ''],
    ['caused', caused.kind === 'stop' ? caused.message : ''],
  ];
  for (const [what, message] of messages) {
    assert.ok(message.length <= 2000, `${what}: ${message.length}`);
    assert.match(message, question, what);
    // The first findings are shown, the rest counted.
    assert.match(message, /\bR1\b/, what);
    assert.match(message, /… and \d+ more (?:findings|items): see ledger\.json\./, what);
  }
  // The id list of the lead is capped as well.
  assert.match(messages[0]![1], /^Codex disputes the contest of R1, R2, R3, R4, R5, R6, R7, R8, R9, R10 and 50 more\. /);
  assert.ok(escalated.length <= 2000, String(escalated.length));
  assert.match(escalated, /^The Implementer escalated R1, R2, R3, R4, R5, R6, R7, R8, R9, R10 and 50 more: only you know the answer\. /);
  assert.match(escalated, /Settle each: accept the risk or must fix \(sf settle <workspace> <ticket> <id> accept\|fix \[note\]\); then the review runs, or the Fix you decided\.$/);
});

test("a path outside the Task's scope keeps its own entry, apart from a sensitive one of the same path: raised again under its id, fixed once no longer raised, its reason names the scope (SF-053)", () => {
  const outside = scopeItem('notes.txt');
  const first = applyVerdict({ ledger: [], items: [], extra: [outside, sensitiveItem('package.json')], reviewer: 'claude', iteration: 1 });
  assert.deepEqual(first.kind === 'fix' && first.items.map((fixItem) => [fixItem.id, fixItem.item.path, fixItem.item.problem]), [
    ['R1', 'notes.txt', "Outside the Task's scope."], ['R2', 'package.json', 'Undeclared sensitive path.'],
  ]);
  // A path that is both raises two items, each with its own entry.
  const both = applyVerdict({ ledger: [], items: [], extra: [sensitiveItem('.editorconfig'), scopeItem('.editorconfig')], reviewer: 'claude', iteration: 1 });
  assert.deepEqual(both.kind === 'fix' && both.items.map((fixItem) => [fixItem.id, fixItem.item.problem]), [['R1', 'Undeclared sensitive path.'], ['R2', "Outside the Task's scope."]]);
  assert.equal(both.ledger.length, 2);
  // Raised again: the same entry. A sensitive entry of the same path is another finding.
  const ledger = [...first.ledger, entry('R3', 'open', { path: 'notes.txt', problem: 'Undeclared sensitive path.' })];
  const again = applyVerdict({ ledger, items: [], extra: [outside], reviewer: 'codex', iteration: 2 });
  assert.deepEqual(again.kind === 'fix' && again.items.map((fixItem) => fixItem.id), ['R1']);
  assert.deepEqual(again.ledger.map((e) => [e.id, e.status]), [['R1', 'open'], ['R2', 'fixed'], ['R3', 'fixed']]);
  // No longer raised (accepted, or the change is gone): fixed.
  const accepted = applyVerdict({ ledger: again.ledger, items: [], extra: [], reviewer: 'claude', iteration: 3 });
  assert.equal(accepted.kind, 'clean');
  assert.deepEqual(accepted.ledger.map((e) => e.status), ['fixed', 'fixed', 'fixed']);
  // A contested one the reviewer still does not accept: its reason names the scope.
  const contested = [entry('R1', 'contested', { path: 'notes.txt', problem: "Outside the Task's scope.", response: 'The README cites it.', evidence: 'a.ts:1' })];
  const disputed = applyVerdict({ ledger: contested, items: [], extra: [outside], reviewer: 'codex', iteration: 2 });
  assert.match(disputed.kind === 'stop' ? disputed.message : '', /Codex reopens it: Codex does not accept the path outside the Task's scope notes\.txt \(it is not in its accepted_sensitive\)\./);
});

// The ledger of a job whose earlier rounds left findings: open majors and a blocker of Fix 1 and
// Fix 2, an open nit, the user's fix, a contest, an escalation, a nit left, an accepted risk and an
// open scope entry of the factory.
const earlier = (): LedgerEntry[] => [
  entry('R1', 'open'), entry('R2', 'open', { asked: 2 }), entry('R3', 'open', { severity: 'blocker', asked: 2 }), entry('R4', 'open', { severity: 'nit', asked: 2 }),
  entry('R5', 'user_fix', { settled: { decision: 'fix', note: 'Do it.', at: '2026-11-05T00:00:00.000Z' } }), entry('R6', 'contested', { evidence: 'a.ts:1' }), entry('R7', 'escalated', { response: 'Which?' }),
  entry('R8', 'left', { severity: 'nit' }), entry('R9', 'accepted_risk', { settled: { decision: 'accept', note: 'ok', at: '2026-11-05T00:00:00.000Z' } }),
  entry('R10', 'open', { path: 'notes.txt', problem: "Outside the Task's scope." }),
];
const statuses = (ledger: LedgerEntry[]): Array<[string, string, number | undefined]> => ledger.map((e) => [e.id, e.status, e.fixed_by_clean]);

test('a clean verdict of the reviewer that decides the round settles the open blocker and major entries of earlier rounds as fixed, nits on it too; nothing else', () => {
  for (const [reviewer, name] of [['codex', 'Codex'], ['claude', 'Claude']] as const) {
    const nit = item('n.ts', 'Wording.', 'nit');
    const applied = applyVerdict({ ledger: earlier(), items: [nit], extra: [], reviewer, iteration: 3, decides: true });
    // The user's fix still makes a Fix; the settled entries are not in it.
    assert.deepEqual(applied.kind === 'fix' && applied.items.map((fixItem) => fixItem.id), ['R5', 'R11']);
    assert.deepEqual(statuses(applied.ledger).slice(0, 10), [
      ['R1', 'fixed', 3], ['R2', 'fixed', 3], ['R3', 'fixed', 3], ['R4', 'open', undefined], ['R5', 'user_fix', undefined], ['R6', 'contested', undefined],
      ['R7', 'escalated', undefined], ['R8', 'left', undefined], ['R9', 'accepted_risk', undefined], ['R10', 'fixed', undefined],
    ]);
    assert.equal(applied.ledger[0]!.response, `Settled by the clean ${name} verdict of iteration 3.`);
    assert.ok(settledLines(applied.ledger).includes(`- R2 · fixed · major · \`a.ts\`: Problem of R2. Response: Settled by the clean ${name} verdict of iteration 3.`));
  }
  // Without the user's fix the round is clean: no Fix, so no iteration_limit stop either.
  const clean = applyVerdict({ ledger: [entry('R1', 'open'), entry('R2', 'open', { asked: 2 }), entry('R3', 'open', { asked: 2 })], items: [], extra: [], reviewer: 'codex', iteration: 3, decides: true });
  assert.equal(clean.kind, 'clean');
  assert.deepEqual(statuses(clean.ledger), [['R1', 'fixed', 3], ['R2', 'fixed', 3], ['R3', 'fixed', 3]]);
  // An entry asked in this very round is not one the verdict saw answered.
  assert.deepEqual(statuses(applyVerdict({ ledger: [entry('R1', 'open', { asked: 3 })], items: [], extra: [], reviewer: 'codex', iteration: 3, decides: true }).ledger), [['R1', 'open', undefined]]);
});

test('a clean verdict settles nothing from a reviewer that does not decide the round, nor with a blocking item: the open entries make a Fix as before', () => {
  const open = [entry('R1', 'open'), entry('R2', 'open', { asked: 2 })];
  // The Claude review the gate follows: its clean verdict leaves the entries open.
  const followed = applyVerdict({ ledger: open, items: [], extra: [], reviewer: 'claude', iteration: 3, decides: false });
  assert.deepEqual(followed.kind === 'fix' && followed.items.map((fixItem) => fixItem.id), ['R1', 'R2']);
  assert.deepEqual(statuses(followed.ledger), [['R1', 'open', undefined], ['R2', 'open', undefined]]);
  // A new major item of the deciding reviewer: nothing is settled, the Fix carries it with the entries.
  const blocked = applyVerdict({ ledger: open, items: [item('c.ts', 'New.')], extra: [], reviewer: 'codex', iteration: 3, decides: true });
  assert.deepEqual(blocked.kind === 'fix' && blocked.items.map((fixItem) => fixItem.id), ['R3', 'R1', 'R2']);
  assert.deepEqual(statuses(blocked.ledger).slice(0, 2), [['R1', 'open', undefined], ['R2', 'open', undefined]]);
  // A path outside the scope the reviewer does not accept blocks too.
  const outside = applyVerdict({ ledger: open, items: [], extra: [scopeItem('notes.txt')], reviewer: 'codex', iteration: 3, decides: true });
  assert.deepEqual(statuses(outside.ledger).slice(0, 2), [['R1', 'open', undefined], ['R2', 'open', undefined]]);
  // An item that reopens a settled entry in a later round opens it again, without its mark.
  const settled = applyVerdict({ ledger: open, items: [], extra: [], reviewer: 'codex', iteration: 3, decides: true }).ledger;
  const reopened = applyVerdict({ ledger: settled, items: [item('a.ts', 'Still broken.', 'major', { reopens: 'R1' })], extra: [], reviewer: 'codex', iteration: 4, decides: true });
  assert.deepEqual(reopened.kind === 'fix' && reopened.items.map((fixItem) => fixItem.id), ['R1']);
  assert.deepEqual(statuses(reopened.ledger), [['R1', 'open', undefined], ['R2', 'fixed', 3]]);
  // ledger.json of an earlier version (no fixed_by_clean) reads, and so does the new field.
  assert.equal(ledgerSchema.safeParse(open).success, true);
  assert.equal(ledgerSchema.safeParse(settled).success, true);
});
