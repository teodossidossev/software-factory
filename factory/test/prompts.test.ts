// Unit tests for the factory's prompt block and the per-iteration cost.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedFileLine, findingsBlock, firstPrompt, freshFixPrompt, implementCommand, sessionBlocks } from '../src/execution/prompts.js';
import { checklistText } from '../src/findings-checklist.js';
import { FACTORY_PROMPT_RULES, factoryPrompt, iterationCost } from '../src/prompts.js';

test('factoryPrompt puts the prompt first, then a blank line and the rules with ticket and iteration filled in', () => {
  const prompt = factoryPrompt('/implement .software-factory/PROJ-1.md Fix 2', 'PROJ-1', 3);
  const [first, blank, ...rest] = prompt.split('\n');
  assert.deepEqual([first, blank], ['/implement .software-factory/PROJ-1.md Fix 2', '']);
  assert.equal(rest.join('\n'), FACTORY_PROMPT_RULES.replaceAll('<ticket>', 'PROJ-1').replace('<N>', '3').replace('<base>', 'the commit your branch started from'));
  assert.match(prompt, /^- Do not edit \.software-factory\/PROJ-1\.md; the Context owner owns it\.\n- Write your own changes to files with Edit and Write only, never through an inline script, `sed -i` or a shell redirection: the factory checks every Edit and Write\. Running the repository's own tools \(formatter, code generator, package manager\) is fine\.\n- At the start of every turn, write the turn's steps as a checklist in \.software-factory\/PROJ-1\.steps\.md: [^\n]+\n- While working, run the tests of the files you change; run the repository's full test suite once, before the report\.\n- Run every command in the foreground and wait for it; give a long one a timeout \(up to 60 minutes\)\. Never run a command in the background or a loop that waits for a file\.\n- End your turn with a report/m);
  assert.match(prompt, /^ {2}# Report: PROJ-1, iteration 3$/m);
  assert.match(prompt, /^ {2}## Fix N items \(only when answering/m);
  assert.doesNotMatch(prompt, /<ticket>|<N>|<base>/);
});

test('factoryPrompt\'s last rule puts the skills under the factory\'s rules: the job\'s base commit as their fixed point, the Task file as the spec, no issue tracker, never ask, these rules win', () => {
  const rule = (base: string): string => `- When a skill needs a fixed point, it is the base commit ${base}, and the change is the uncommitted worktree against it; the spec is the Task file; there is no issue tracker. Never ask the user; where a skill's step conflicts with these rules (commit, push, ask), these rules win.`;
  assert.equal(factoryPrompt('/implement .software-factory/PROJ-1.md', 'PROJ-1', 1, undefined, 'abc123').split('\n').at(-1), rule('abc123'));
  assert.equal(factoryPrompt('/implement .software-factory/PROJ-1.md', 'PROJ-1', 1, undefined, null).split('\n').at(-1), rule('the commit your branch started from'));
  assert.match(FACTORY_PROMPT_RULES, /^- Do not commit, stage, stash, push or switch branches;/m);
});

test('factoryPrompt with images (SF-065): one line names their folder and names before the rules; without images the prompt is as before', () => {
  const plain = factoryPrompt('/implement .software-factory/PROJ-1.md', 'PROJ-1', 1);
  assert.equal(factoryPrompt('/implement .software-factory/PROJ-1.md', 'PROJ-1', 1, { dir: '/w/.software-factory/PROJ-1', names: [] }), plain);
  const prompt = factoryPrompt('/implement .software-factory/PROJ-1.md', 'PROJ-1', 1, { dir: '/w/.software-factory/PROJ-1', names: ['1.png', '2.png'] });
  assert.equal(prompt, [
    '/implement .software-factory/PROJ-1.md', '',
    "The Task's images are in /w/.software-factory/PROJ-1: 1.png, 2.png. Read them when you need them.", '',
    FACTORY_PROMPT_RULES.replaceAll('<ticket>', 'PROJ-1').replace('<N>', '1').replace('<base>', 'the commit your branch started from'),
  ].join('\n'));
});

test('the pack of a fresh fix round (SF-316, freshFixPrompt): the fix command on the first line, then the rules, the previous Report and the changed files as A, M, D and R lines; no diff text', () => {
  const command = implementCommand('PROJ-1', ['implement'], 2);
  const rules = '<rules>\nNo abbreviations.\n</rules>\n';
  const files = [
    { path: 'src/new.ts', status: 'added' as const },
    { path: 'src/changed.ts', status: 'modified' as const },
    { path: 'src/gone.ts', status: 'deleted' as const },
    { path: 'src/after.ts', status: 'renamed' as const, from: 'src/before.ts' },
  ];
  const prompt = freshFixPrompt(command, rules, { iteration: 2, report: '# Report: PROJ-1, iteration 2\n\nDone.\n', files }, 'abc123');
  assert.equal(prompt, [
    '/implement .software-factory/PROJ-1.md Fix 2',
    '',
    '<rules>', 'No abbreviations.', '</rules>',
    '',
    '<previous_report iteration="2">', '# Report: PROJ-1, iteration 2', '', 'Done.', '</previous_report>',
    '',
    '<changed_files>',
    'This fix round starts a new session. The files your change holds against the base commit abc123, as of iteration 2: for A read the file; for M and D read `git diff abc123 -- <path>`; for R read `git diff abc123 -- <from> <path>`; all in the worktree.',
    'A src/new.ts', 'M src/changed.ts', 'D src/gone.ts', 'R src/before.ts -> src/after.ts',
    '</changed_files>',
  ].join('\n'));
  assert.deepEqual(files.map(changedFileLine), ['A src/new.ts', 'M src/changed.ts', 'D src/gone.ts', 'R src/before.ts -> src/after.ts']);
  // Without rules the blocks follow the command; without files the list says so.
  const bare = freshFixPrompt(command, '', { iteration: 1, report: 'r', files: [] }, null);
  assert.equal(bare.split('\n').slice(0, 3).join('\n'), `${command}\n\n<previous_report iteration="1">`);
  assert.match(bare, /against the base commit the commit your branch started from, as of iteration 1: [^\n]+\n\(none\)\n<\/changed_files>$/);
});

test('the findings checklist block (SF-318-2, findingsBlock): the instruction line, then the file\'s "- " lines without its generated comment; \'\' for a file without checks', () => {
  const file = checklistText('2026-11-24', 14, 5, [{ text: 'Run the tests of every changed file', findings: 4, jobs: 2 }, { text: 'Keep error messages specific', findings: 3, jobs: 2 }]);
  assert.equal(findingsBlock(file), [
    '<recurring_findings>',
    'Before you write the Report, go through these checks, fix what applies to this change, and say in `## Checks` which applied.',
    '- Run the tests of every changed file (4)',
    '- Keep error messages specific (3)',
    '</recurring_findings>',
    '',
  ].join('\n'));
  assert.equal(findingsBlock(file.replaceAll('\n', '\r\n')), findingsBlock(file));
  for (const empty of ['', '<!-- generated 2026-11-24 from 0 findings in 0 jobs -->\n', 'notes\n-\n- \n']) {
    assert.equal(findingsBlock(empty), '', empty);
  }
});

test('the findings block in the prompts that open a session (SF-318-2): after the rules, in their place without them, before the kept files and the fresh fix pack; none without it', () => {
  const rules = '<rules>\nNo abbreviations.\n</rules>\n';
  const findings = '<recurring_findings>\nBefore you write the Report.\n- Check one (3)\n</recurring_findings>\n';
  const command = '/implement .software-factory/PROJ-1.md';
  assert.equal(firstPrompt('PROJ-1', [], rules, ['implement'], findings), `${command}\n\n${rules.trimEnd()}\n\n${findings.trimEnd()}`);
  assert.equal(firstPrompt('PROJ-1', [], '', ['implement'], findings), `${command}\n\n${findings.trimEnd()}`);
  assert.equal(firstPrompt('PROJ-1', [], rules), `${command}\n\n${rules.trimEnd()}`);
  assert.equal(firstPrompt('PROJ-1', [], rules, ['implement'], ''), firstPrompt('PROJ-1', [], rules));
  assert.ok(firstPrompt('PROJ-1', ['a.ts'], rules, ['implement'], findings).startsWith(`${command}\n\n${rules.trimEnd()}\n\n${findings.trimEnd()}\n\nThis job restarts an earlier job of PROJ-1.`));
  const pack = { iteration: 2, report: 'r', files: [] };
  const fix = `${command} Fix 2`;
  assert.ok(freshFixPrompt(fix, rules, pack, 'abc', findings).startsWith(`${fix}\n\n${rules.trimEnd()}\n\n${findings.trimEnd()}\n\n<previous_report iteration="2">\n`));
  assert.ok(freshFixPrompt(fix, '', pack, 'abc', findings).startsWith(`${fix}\n\n${findings.trimEnd()}\n\n<previous_report iteration="2">\n`));
  assert.equal(freshFixPrompt(fix, rules, pack, 'abc', ''), freshFixPrompt(fix, rules, pack, 'abc'));
  assert.deepEqual(sessionBlocks(rules, findings), [rules.trimEnd(), findings.trimEnd()]);
  assert.deepEqual(sessionBlocks('', ''), []);
});

test('iterationCost with a previous meta.json without session_id (written before SF-316): the SDK total minus the previous total, or the total for a first iteration or new session', () => {
  const old = (total: number | null) => ({ cost_usd_total: total });
  assert.equal(iterationCost(0.5, undefined, 's-1'), 0.5);
  assert.equal(iterationCost(0.5, old(null), 's-1'), 0.5);
  assert.equal(iterationCost(0.7084, old(0.6656), 's-1'), 0.0428);
  assert.equal(iterationCost(0.05, old(0.0123), 's-1'), 0.0377);
  assert.equal(iterationCost(0.2, old(0.2), 's-1'), 0);
  // A smaller total means the session started over: its total is this iteration's cost.
  assert.equal(iterationCost(0.1, old(0.6), 's-1'), 0.1);
  assert.equal(iterationCost(null, old(0.6), 's-1'), null);
});

test('iterationCost across sessions (SF-316): the previous total is subtracted only for the same session; a second session costing more than the first\'s total is its own total; the carried spend of an ended session is added', () => {
  // The same session: the difference.
  assert.equal(iterationCost(0.9, { cost_usd_total: 0.6, session_id: 's-1' }, 's-1'), 0.3);
  // A total below the previous one of the same session id is taken whole, never a negative cost.
  assert.equal(iterationCost(0.2, { cost_usd_total: 0.6, session_id: 's-1' }, 's-1'), 0.2);
  // A new session whose total is above the first session's: its whole total, not the difference.
  assert.equal(iterationCost(0.9, { cost_usd_total: 0.6, session_id: 's-1' }, 's-2'), 0.9);
  assert.equal(iterationCost(0.1, { cost_usd_total: 0.6, session_id: 's-1' }, 's-2'), 0.1);
  // The ended session's spend after its last published iteration (an MR-preparation turn that
  // published nothing) is carried into the next iteration, not lost.
  assert.equal(iterationCost(0.9, { cost_usd_total: 0.6, session_id: 's-1' }, 's-2', 0.25), 1.15);
  assert.equal(iterationCost(null, { cost_usd_total: 0.6, session_id: 's-1' }, 's-2', 0.25), 0.25);
  assert.equal(iterationCost(null, { cost_usd_total: 0.6, session_id: 's-1' }, 's-2', 0), null);
});
