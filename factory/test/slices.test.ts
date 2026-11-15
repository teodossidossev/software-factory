// The Task check's findings of the factory on a Task's slice (SF-220): the size of a change or
// switch slice against the norm's change_max_files, "## Why whole", and the slice keys' nits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saysWhyWhole, sliceFindings } from '../src/slices.js';
import type { CheckOutput } from '../src/task-check.js';

const task = (front = '', body = 'Change the export.'): string => `---\nticket: S-1\ntitle: t\nbase: main\n${front}---\n\n# S-1: t\n\n${body}\n`;
const files = (count: number): CheckOutput['files'] => Array.from({ length: count }, (_, index) => ({ path: `src/f${index}.ts`, action: 'modify' as const }));
const CUT = 'Cut it again along the next axis (Handbook: Slicing a solution), or say under "## Why whole" why it is only safe whole.';
const KEYS = 'part_of is a ticket name, slice is N/M with 1 <= N <= M <= 20, kind is one of mechanical, preparation, change, switch, cleanup.';

test('a change slice over the norm is an overreach major; at the norm, none', () => {
  assert.deepEqual(sliceFindings(task(), files(12), 10), [
    { kind: 'overreach', severity: 'major', where: 'slice norm', problem: '12 files are expected; the norm of a change slice is 10.', expected: CUT },
  ]);
  assert.deepEqual(sliceFindings(task('kind: change\n'), files(11), 10).map((item) => item.severity), ['major']);
  assert.deepEqual(sliceFindings(task(), files(10), 10), []);
  assert.deepEqual(sliceFindings(task('kind: change\n'), files(2), 1)[0]!.problem, '2 files are expected; the norm of a change slice is 1.');
});

test('a switch slice counts as a change; mechanical, preparation and cleanup get none, whatever their size', () => {
  assert.deepEqual(sliceFindings(task('kind: switch\n'), files(11), 10).map((item) => [item.kind, item.severity]), [['overreach', 'major']]);
  for (const kind of ['mechanical', 'preparation', 'cleanup']) {
    assert.deepEqual(sliceFindings(task(`kind: ${kind}\n`), files(50), 10), [], kind);
  }
});

test('without maxFiles there is no size finding', () => {
  assert.deepEqual(sliceFindings(task(), files(50)), []);
});

test('a Task without front matter counts as change', () => {
  assert.deepEqual(sliceFindings('# S-1\n\nNo front matter.\n', files(3), 2).map((item) => item.severity), ['major']);
});

test('"## Why whole" with text under it makes the size finding a nit; the heading alone, or with only blank lines before the next section, does not', () => {
  const whole = task('', 'Change the export.\n\n## Why whole\n\nThe schema and its readers change in one commit or the build breaks.\n\n## Tests\n\n- one');
  assert.deepEqual(sliceFindings(whole, files(12), 10), [
    { kind: 'overreach', severity: 'nit', where: 'slice norm', problem: '12 files are expected; the norm of a change slice is 10.', expected: 'Get the user\'s agreement to keep it whole.' },
  ]);
  assert.equal(saysWhyWhole(task('', '## Why whole\nAt the end.')), true);
  assert.equal(saysWhyWhole(task('', '## Why whole  \r\nWindows lines.')), true);
  for (const body of ['## Why whole', '## Why whole\n\n  \n## Tests\n\n- one', '## Why wholeness\n\nText.', '### Why whole\n\nText.', 'Nothing.']) {
    assert.equal(saysWhyWhole(task('', body)), false, body);
    assert.deepEqual(sliceFindings(task('', body), files(12), 10).map((item) => item.severity), ['major'], body);
  }
});

test('a slice key that is not valid is an unclear nit at the front matter, one per key, before the size finding', () => {
  const found = sliceFindings(task('part_of: a/b\nslice: 3/2\nkind: big\n'), files(12), 10);
  assert.deepEqual(found.map((item) => [item.kind, item.severity, item.where]), [
    ['unclear', 'nit', 'front matter'], ['unclear', 'nit', 'front matter'], ['unclear', 'nit', 'front matter'], ['overreach', 'major', 'slice norm'],
  ]);
  assert.deepEqual(found.slice(0, 3).map((item) => item.problem), [
    'part_of: "a/b" is not valid; it is ignored.', 'slice: "3/2" is not valid; it is ignored.', 'kind: "big" is not valid; it is ignored.',
  ]);
  assert.ok(found.slice(0, 3).every((item) => item.expected === KEYS));
  // Valid keys: nothing.
  assert.deepEqual(sliceFindings(task('part_of: SF-210\nslice: 2/4\nkind: preparation\n'), files(12), 10), []);
});
