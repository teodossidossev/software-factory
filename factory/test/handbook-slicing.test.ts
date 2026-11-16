// SF-216: the Handbook tells the planner to cut a solution into small merge requests by kind of
// change (## Slicing a solution), and step 2 of the Quick start points at it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handbookSection } from '../src/prompts.js';
import { loadHandbook, servedHandbook } from '../src/server.js';

const HANDBOOK = fileURLToPath(new URL('../../HANDBOOK.md', import.meta.url));

// A phrase as the Handbook may wrap it: any run of spaces may be a line break and an indent.
const phrase = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));

const KINDS = [
  '1. **Mechanical**',
  '2. **Preparation**',
  '3. **The thinnest working path**',
  '4. **Widen along one axis per slice**',
  '5. **The switch**',
  '6. **Cleanup**',
];

test('the Handbook has ## Slicing a solution before ## Task file format, with the six kinds in order', async () => {
  const text = await readFile(HANDBOOK, 'utf8');
  const slicing = text.indexOf('\n## Slicing a solution\n');
  const format = text.indexOf('\n## Task file format\n');
  assert.ok(slicing > 0, 'no ## Slicing a solution');
  assert.ok(format > slicing, '## Slicing a solution comes after ## Task file format');
  const section = handbookSection(text, '## Slicing a solution');
  const at = KINDS.map((kind) => section.indexOf(`\n${kind}`));
  for (const [i, kind] of KINDS.entries()) {
    assert.ok(at[i]! > 0, `missing kind ${kind}`);
  }
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'the kinds are out of order');
  assert.match(section, phrase("A slice's kind is one of `mechanical`, `preparation`, `change` (steps 3 and 4), `switch` and `cleanup`."));
  assert.match(section, phrase('A `change` or `switch` slice aims at about 400 changed lines, tests included, and 10 files.'));
  assert.match(section, phrase('Up to about 600 lines it needs no reason and is no finding'));
  assert.match(section, phrase('A `change` slice under about 50 lines joins its neighbour.'));
  assert.match(section, phrase('"Slice 2 of 5 (change): ..."'));
});

test('step 2 of the Quick start names ## Slicing a solution and no longer says "20-30 files"', async () => {
  const { quickStart } = await loadHandbook(HANDBOOK);
  const step2 = /^2\. [\s\S]*?(?=^3\. )/m.exec(quickStart)?.[0];
  assert.ok(step2 !== undefined, 'no step 2 in the Quick start');
  assert.match(step2, phrase('`## Slicing a solution` (call `guide` to read it)'));
  assert.match(step2, phrase('one line per slice (its kind, what it does, its estimated size)'));
  assert.doesNotMatch(quickStart, /20-30 files/);
});

test('what the guide tool answers holds ## Slicing a solution', async () => {
  const { guide } = servedHandbook(await loadHandbook(HANDBOOK));
  assert.match(guide, /^## Slicing a solution\n/m);
  assert.ok(guide.includes('**The thinnest working path**'));
});
