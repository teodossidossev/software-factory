// Unit tests for the factory's prompt block and the per-iteration cost.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FACTORY_PROMPT_RULES, factoryPrompt, iterationCost } from '../src/prompts.js';

test('factoryPrompt puts the prompt first, then a blank line and the rules with ticket and iteration filled in', () => {
  const prompt = factoryPrompt('/implement .software-factory/PROJ-1.md Fix 2', 'PROJ-1', 3);
  const [first, blank, ...rest] = prompt.split('\n');
  assert.deepEqual([first, blank], ['/implement .software-factory/PROJ-1.md Fix 2', '']);
  assert.equal(rest.join('\n'), FACTORY_PROMPT_RULES.replaceAll('<ticket>', 'PROJ-1').replace('<N>', '3'));
  assert.match(prompt, /^- Do not edit \.software-factory\/PROJ-1\.md; the Context owner owns it\.$/m);
  assert.match(prompt, /^ {2}# Report: PROJ-1, iteration 3$/m);
  assert.match(prompt, /^ {2}## Fix N items \(only when answering/m);
  assert.doesNotMatch(prompt, /<ticket>|<N>/);
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
