// The simplification pass's pure parts (SF-055): the Task file without its Fix sections, the files
// each Fix section's iteration changed, the prompt, the guard that drops a suggestion naming a fixed
// blocker, the Fix section and ledger entries of Simplify, the offer message, how the ledger shows the
// simplifications to the reviewers and leaves them out of the MR's findings, the MR section of Skip.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { answerFix, applyVerdict, type LedgerEntry, notFixed, settledLines } from '../src/ledger.js';
import { SIMPLIFY_HEADING, withSimplifications } from '../src/mr.js';
import { changedBetween, fixNumbers, guardSuggestions, offerMessage, runSimplify, SIMPLIFY_SCHEMA, simplifyFix, simplifyOutput, simplifyPrompt, type Suggestion, withoutFixSections } from '../src/simplify.js';
import { FAKE, newEnv, reviewLog, reviewScript } from './support/harness.js';

const TASK = ['---', 'ticket: S-1', '---', '', '# S-1: Greet', '', '## Acceptance', '', 'It greets.', '', '```', '## Fix 9 in a fence', '```', ''].join('\n');
const WITH_FIXES = `${TASK}\n\n## Fix 1\n\nReview by Claude: guard it.\n\n## Fix 2: Simplify\n\nSimplify, by the user's choice.\n`;

function entry(id: string, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id, iteration: 1, reviewer: 'claude', severity: 'blocker', path: 'src/a.ts', problem: 'Injection.', expected: 'Escape it.', status: 'fixed', response: 'Escaped.',
    evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null, ...extra,
  };
}

const SUGGESTION: Suggestion = { path: 'src/a.ts', what: 'The second null check.', why: 'The caller never passes null.', saves_lines: 6, ledger_ids: ['R2'] };

function diff(path: string, line: string): string {
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${line}\n`;
}

test('withoutFixSections cuts from the first Fix heading outside a fence; fixNumbers reads the Fix headings, titled ones too', () => {
  assert.equal(withoutFixSections(WITH_FIXES), TASK.trimEnd() + '\n');
  assert.equal(withoutFixSections(TASK), TASK);
  assert.deepEqual(fixNumbers(WITH_FIXES), [1, 2]);
  assert.deepEqual(fixNumbers(TASK), []);
});

test('changedBetween: the files whose diff differs between two Patches, added and gone ones included', () => {
  const before = diff('a.ts', 'one') + diff('b.ts', 'two');
  const after = diff('a.ts', 'one') + diff('b.ts', 'three') + diff('c.ts', 'new');
  assert.deepEqual(changedBetween(before, after), ['b.ts', 'c.ts']);
  assert.deepEqual(changedBetween(after, diff('a.ts', 'one')), ['b.ts', 'c.ts']);
  assert.deepEqual(changedBetween(before, before), []);
});

test('the prompt: the question, the fixed blockers named as untouchable, the Task without its Fix sections, the whole ledger, the files per Fix, the Patch', () => {
  const ledger = [entry('R1'), entry('R2', { severity: 'major', path: 'src/b.ts', problem: 'No null check.' }), entry('R3', { status: 'contested', severity: 'blocker' })];
  const prompt = simplifyPrompt({
    ticket: 'S-1', iteration: 3, task: WITH_FIXES, patch: Buffer.from(diff('src/a.ts', 'x')), patchTruncated: false, ledger,
    fixes: [{ fix: 1, files: ['src/a.ts'] }, { fix: 2, files: undefined }],
  });
  assert.match(prompt, /You read; you change nothing\./);
  assert.match(prompt, /exists only to satisfy a review item and is not needed for the Task's goal, its acceptance, or a blocker or major ledger entry that is still valid/);
  assert.match(prompt, /Never propose removing or weakening anything a `fixed` blocker entry of the ledger needed, security above all \(here: R1\)\./);
  assert.match(prompt, /- Suggest nothing in a file a fixed blocker entry is about \(src\/a\.ts\): the factory withholds any suggestion on such a path/);
  assert.ok(!prompt.includes('Review by Claude: guard it.'));
  assert.ok(prompt.includes('## Acceptance'));
  assert.match(prompt, /- R2 · fixed · major · claude · `src\/b\.ts`: No null check\. Expected: Escape it\. Response: Escaped\./);
  assert.match(prompt, /- R3 · contested · blocker/);
  assert.match(prompt, /- Fix 1, answered by iteration 2: src\/a\.ts\n- Fix 2, answered by iteration 3: not known/);
  assert.match(prompt, /<patch>\ndiff --git a\/src\/a\.ts/);
});

test('the output schema: draft-07 without $schema; ledger_ids must be ledger ids', () => {
  assert.equal(SIMPLIFY_SCHEMA.$schema, undefined);
  assert.equal(simplifyOutput.safeParse({ summary: 's', suggestions: [SUGGESTION] }).success, true);
  assert.equal(simplifyOutput.safeParse({ summary: 's', suggestions: [{ ...SUGGESTION, ledger_ids: ['seven'] }] }).success, false);
  assert.equal(simplifyOutput.safeParse({ summary: 's', suggestions: [{ ...SUGGESTION, saves_lines: -1 }] }).success, false);
});

test('the guard drops a suggestion that names a fixed blocker entry or is on its path, whatever ids it names; a fixed major, an open blocker or another file keeps it', () => {
  const ledger = [entry('R1'), entry('R2', { severity: 'major', path: 'src/b.ts' }), entry('R3', { status: 'open', path: 'src/c.ts' })];
  const elsewhere = { ...SUGGESTION, path: 'src/b.ts' };
  const naming = { ...elsewhere, ledger_ids: ['R2', 'R1'] };
  const onPath = { ...SUGGESTION, ledger_ids: [] };
  const onPathAgain = { ...SUGGESTION, path: './src/a.ts', ledger_ids: ['R2'] };
  const kept = [elsewhere, { ...elsewhere, path: 'src/c.ts', ledger_ids: ['R3'] }, { ...elsewhere, ledger_ids: [] }];
  assert.deepEqual(guardSuggestions([naming, onPath, ...kept, onPathAgain], ledger), { kept, dropped: [naming, onPath, onPathAgain] });
});

test('Simplify: one accepted_risk entry of reviewer simplify per suggestion, asked in the Fix; a reviewer item that reopens one is dropped', () => {
  const ledger = [entry('R1'), entry('R2', { severity: 'major' })];
  const at = '2026-11-05T10:00:00.000Z';
  const fix = simplifyFix(ledger, 'Two guards too many.', [SUGGESTION, { ...SUGGESTION, path: 'test/a.test.ts', what: 'The duplicate test.', ledger_ids: [] }], 3, at);
  assert.deepEqual(fix.ledger.slice(2).map((added) => [added.id, added.reviewer, added.status, added.asked, added.path, added.problem, added.settled?.note]), [
    ['R3', 'simplify', 'accepted_risk', 3, 'src/a.ts', 'The second null check.', "removed by the user's choice"],
    ['R4', 'simplify', 'accepted_risk', 3, 'test/a.test.ts', 'The duplicate test.', "removed by the user's choice"],
  ]);
  assert.equal(fix.content, [
    "Simplify, by the user's choice: Two guards too many.", '',
    "Remove or simplify each item below. Keep what the Task's goal and acceptance need, and never undo what a fixed blocker finding of the ledger established; leave an item (and say why) when it turns out to be needed.", '',
    '1. [R3, simplify] `src/a.ts`: The second null check. Why: The caller never passes null. (saves about 6 lines; added for R2)',
    '2. [R4, simplify] `test/a.test.ts`: The duplicate test. Why: The caller never passes null. (saves about 6 lines)',
  ].join('\n'));
  const back = { path: 'src/a.ts', problem: 'Bring the null check back.', expected: 'Check null.', severity: 'major' as const, reopens: 'R3' };
  const applied = applyVerdict({ ledger: fix.ledger, items: [back], extra: [], reviewer: 'claude', iteration: 4 });
  assert.equal(applied.kind, 'clean');
  assert.deepEqual(applied.dropped, [back]);
});

test('the reviewers see a simplification as the user\'s choice; the MR findings leave it out', () => {
  const ledger = simplifyFix([entry('R1')], 's', [SUGGESTION], 2, '2026-11-05T10:00:00.000Z').ledger;
  const [, line] = settledLines(ledger);
  assert.equal(line, "- R2 · simplified by the user's choice · `src/a.ts`: The second null check. Do not ask to bring it back; a defect its removal causes is a new item, or reopens the entry whose fix the removal undid.");
  assert.deepEqual(notFixed([...ledger, entry('R3', { status: 'accepted_risk' })]).map((found) => found.id), ['R3']);
});

test('the offer message lists the suggestions and both choices; Skip lists them in the MR text', () => {
  const message = offerMessage([SUGGESTION]);
  assert.match(message, /^The simplification pass found 1 thing the review fixes added that the Task does not need \(about 6 lines\): 1\. `src\/a\.ts`: The second null check\./);
  assert.match(message, /sf simplify <workspace> <ticket>.*sf accept <workspace> <ticket>/);
  const many = offerMessage(Array.from({ length: 40 }, (_, index) => ({ ...SUGGESTION, what: `${'x'.repeat(200)} ${index}` })));
  assert.ok(many.length <= 2000);
  assert.match(many, /more suggestions: see simplify\.json\./);
  const text = ['feat(S-1): Greet', '', '## Special things to note', '- None.', '', '## Change outline', 'x', ''].join('\n');
  assert.equal(withSimplifications(text, [SUGGESTION], 3), ['feat(S-1): Greet', '', '## Special things to note', SIMPLIFY_HEADING,
    '- `src/a.ts`: The second null check. Why: The caller never passes null. (saves about 6 lines; added for R2)', '', '## Change outline', 'x', ''].join('\n'));
  assert.equal(withSimplifications(text, [], 3), text);
});

test('rule 1 holds for a simplification at every severity: a blocker that reopens it is dropped; an independent blocker is a new item', () => {
  const ledger = simplifyFix([entry('R1')], 's', [SUGGESTION], 2, '2026-11-05T10:00:00.000Z').ledger;
  const reopening = { path: 'src/a.ts', problem: 'Bring the check back.', expected: 'Check null.', severity: 'blocker' as const, reopens: 'R2' };
  const sameWords = { path: 'src/a.ts', problem: 'The second null check.', expected: 'Keep it.', severity: 'blocker' as const };
  const dropped = applyVerdict({ ledger, items: [reopening, sameWords], extra: [], reviewer: 'codex', iteration: 3 });
  assert.equal(dropped.kind, 'clean');
  assert.deepEqual(dropped.dropped, [reopening, sameWords]);
  const independent = { path: 'src/b.ts', problem: 'The caller now passes null to b.', expected: 'Handle null in b.', severity: 'blocker' as const, reopens: '' };
  const applied = applyVerdict({ ledger, items: [independent], extra: [], reviewer: 'codex', iteration: 3 });
  assert.deepEqual(applied.kind === 'fix' && applied.items.map((item) => [item.id, item.item.severity]), [['R3', 'blocker']]);
  assert.equal(applied.ledger.find((found) => found.id === 'R2')?.status, 'accepted_risk');
});

test('a simplification the Implementer leaves is left with its note, no longer the user\'s removal; a fixed one stays', async () => {
  const ledger = simplifyFix([entry('R1')], 's', [SUGGESTION, { ...SUGGESTION, what: 'Another.' }], 2, '2026-11-05T10:00:00.000Z').ledger;
  const context = { lines: async () => undefined, testNamed: async () => false, sections: [] };
  const answered = await answerFix(ledger, '| R2 | left | The guard is needed after all. |\n| R3 | fixed | Removed. |', 2, context);
  assert.deepEqual(answered.ledger.slice(1).map((found) => [found.id, found.status, found.response, found.settled === null]), [
    ['R2', 'left', 'The guard is needed after all.', true],
    ['R3', 'accepted_risk', "removed by the user's choice", false],
  ]);
});

test('runSimplify with images (SF-065): the pass gets the same image blocks after its prompt as the review', async () => {
  const env = await newEnv('simplify-images');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
  await writeFile(join(env.home, '1.png'), png);
  await reviewScript(env, [{ output: { summary: 'Nothing to simplify.', suggestions: [] } }]);
  const home = process.env.HOME;
  process.env.HOME = env.home;
  try {
    const outcome = await runSimplify('Simplify this.', {
      cwd: env.home, claudePath: FAKE, sandbox: undefined, model: undefined, maxTurns: 3, signal: new AbortController().signal,
      images: [{ ticket: 'T-1', name: '1.png', alt: 'the error', type: 'image/png', path: join(env.home, '1.png') }],
    });
    assert.equal(outcome.ok, true);
  } finally {
    process.env.HOME = home;
  }
  const [entry] = await reviewLog(env);
  assert.deepEqual(entry!.blocks?.map((block) => (block.type === 'image' ? `image ${block.media_type} ${block.bytes}` : block.text)), [
    'Simplify this.', 'Image T-1/1.png ("the error"), referenced in the Task file:', `image image/png ${png.length}`,
  ]);
});
