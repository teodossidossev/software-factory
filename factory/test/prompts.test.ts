// Unit tests for the factory's prompt block and the per-iteration cost.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FACTORY_PROMPT_RULES, factoryPrompt, iterationCost } from '../src/prompts.js';

test('factoryPrompt puts the prompt first, then a blank line and the rules with ticket and iteration filled in', () => {
  const prompt = factoryPrompt('/implement .software-factory/PROJ-1.md Fix 2', 'PROJ-1', 3);
  const [first, blank, ...rest] = prompt.split('\n');
  assert.deepEqual([first, blank], ['/implement .software-factory/PROJ-1.md Fix 2', '']);
  assert.equal(rest.join('\n'), FACTORY_PROMPT_RULES.replaceAll('<ticket>', 'PROJ-1').replace('<N>', '3').replace('<base>', 'the commit your branch started from'));
  assert.match(prompt, /^- Do not edit \.software-factory\/PROJ-1\.md; the Context owner owns it\.\n- At the start of every turn, write the turn's steps as a checklist in \.software-factory\/PROJ-1\.steps\.md: [^\n]+\n- While working, run the tests of the files you change; run the repository's full test suite once, before the report\.\n- End your turn with a report/m);
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

test('iterationCost is the SDK total minus the previous total, or the total for a first iteration or new session', () => {
  assert.equal(iterationCost(0.5, null), 0.5);
  assert.equal(iterationCost(0.7084, 0.6656), 0.0428);
  assert.equal(iterationCost(0.05, 0.0123), 0.0377);
  assert.equal(iterationCost(0.2, 0.2), 0);
  // A smaller total means the session started over: its total is this iteration's cost.
  assert.equal(iterationCost(0.1, 0.6), 0.1);
  assert.equal(iterationCost(null, 0.6), null);
});
