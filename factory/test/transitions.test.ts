// The table of allowed state changes (SF-088, src/jobs.ts): checkTransition refuses what it does not
// list, every call site of src/ passes a literal state and action, every row has a call site, and
// the README shows the table as renderTransitions() renders it.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FactoryError } from '../src/errors.js';
import { checkTransition, JOB_ACTIONS, JOB_STATES, JOB_TRANSITIONS, type JobAction, type JobState, refusedTransitions, renderTransitions, TERMINAL_STATES } from '../src/jobs.js';

// The tests run from dist/test; the sources and the README are those of the checkout.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const START = '<!-- transitions:start -->';
const END = '<!-- transitions:end -->';
// The one call whose arguments are not literals: transition (src/execution/core.ts) forwards its own.
const FORWARDING = 'checkTransition(job.state, to, action)';

interface CallSite {
  where: string;
  call: string;
  to: string | undefined;
  action: string | undefined;
}

// The index of the comma or closing bracket that ends the argument starting at start, skipping
// nested brackets (objects, spreads, calls) and string literals.
function argumentEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (char === '\'' || char === '"' || char === '`') {
      for (i++; source[i] !== char; i++) {
        if (source[i] === '\\') {
          i++;
        }
      }
    } else if ('([{'.includes(char)) {
      depth++;
    } else if (')]}'.includes(char)) {
      if (depth === 0) {
        return i;
      }
      depth--;
    } else if (char === ',' && depth === 0) {
      return i;
    }
  }
  throw new Error(`unterminated argument at ${start}`);
}

// A single-quoted string literal argument's value, or undefined when the argument is anything else.
function literal(argument: string): string | undefined {
  return /^'([a-z_]+)'$/.exec(argument.trim())?.[1];
}

// Every #transition(, core.transition( (the parts of src/execution/, SF-089), #store.transition(
// (the parts through their JobStorePort since SF-143) and checkTransition( call of the sources,
// declarations and comments aside, with its second and third arguments read as literals.
async function callSites(): Promise<CallSite[]> {
  const dir = join(ROOT, 'src');
  const sites: CallSite[] = [];
  for (const name of (await readdir(dir, { recursive: true })).filter((file) => file.endsWith('.ts')).sort()) {
    const source = await readFile(join(dir, name), 'utf8');
    for (const match of source.matchAll(/(?:#transition|\bcore\.transition|#store\.transition|\bcheckTransition)\(/g)) {
      const before = source.slice(source.lastIndexOf('\n', match.index) + 1, match.index);
      if (/(?:async |function )$/.test(before) || before.trimStart().startsWith('//')) {
        continue;
      }
      const open = match.index + match[0].length;
      const first = argumentEnd(source, open);
      const second = source[first] === ',' ? argumentEnd(source, first + 1) : first;
      const third = source[second] === ',' ? argumentEnd(source, second + 1) : second;
      const where = `src/${name}:${source.slice(0, match.index).split('\n').length}`;
      const call = source.slice(match.index, third + 1).replace(/\s+/g, ' ');
      sites.push({ where, call, to: literal(source.slice(first + 1, second)), action: literal(source.slice(second + 1, third)) });
    }
  }
  return sites;
}

test('checkTransition accepts every row of the table', () => {
  for (const row of JOB_TRANSITIONS) {
    assert.doesNotThrow(() => checkTransition(row.from, row.to, row.action), JSON.stringify(row));
  }
});

test('checkTransition refuses a change the table does not list, and records it', (t) => {
  // The refusal's stderr line stays out of the test's output. This file does not import the
  // harness, whose after hook would fail on these refusals.
  const writes: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string) => {
    writes.push(chunk);
    return true;
  });
  const before = refusedTransitions().length;
  const illegal: Array<[JobState | null, JobState, JobAction]> = [
    ['pushed', 'working', 'say'],
    ['aborted', 'ready_for_human_review', 'take_back'],
    [null, 'working', 'create'],
    ['working', 'aborted', 'push'],
  ];
  for (const [from, to, action] of illegal) {
    assert.throws(() => checkTransition(from, to, action), (error: unknown) => {
      assert.ok(error instanceof FactoryError);
      assert.equal(error.code, 'illegal_transition');
      assert.equal(error.message, `${from} -> ${to} by ${action} is not an allowed state change.`);
      return true;
    });
  }
  assert.deepEqual(writes, illegal.map(([from, to, action]) => `illegal_transition: ${from} -> ${to} by ${action}\n`));
  assert.deepEqual(refusedTransitions().slice(before), illegal.map(([from, to, action]) => ({ from, to, action })));
});

test('the table: new records only by create, abort from every state not terminal, no duplicate row', () => {
  assert.deepEqual(JOB_TRANSITIONS.filter((row) => row.from === null), [{ from: null, to: 'starting', action: 'create' }]);
  assert.deepEqual(
    JOB_TRANSITIONS.filter((row) => row.action === 'abort').map((row) => row.from),
    JOB_STATES.filter((state) => !TERMINAL_STATES.includes(state)),
  );
  assert.ok(JOB_TRANSITIONS.every((row) => row.to === 'aborted' ? row.action === 'abort' : true));
  const keys = JOB_TRANSITIONS.map((row) => `${row.from} ${row.to} ${row.action}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(Object.isFrozen(JOB_TRANSITIONS));
});

test('the test step (SF-128): from preparing_mr to working (a Tests Fix) or needs_human (a stop), by tests only', () => {
  assert.deepEqual(JOB_TRANSITIONS.filter((row) => row.action === 'tests'), [
    { from: 'preparing_mr', to: 'working', action: 'tests' },
    { from: 'preparing_mr', to: 'needs_human', action: 'tests' },
  ]);
  checkTransition('preparing_mr', 'working', 'tests');
});

test('every call site passes a literal state and action, and every row of the table has a call site', async () => {
  const sites = await callSites();
  const forwarding = sites.filter((site) => site.call === FORWARDING);
  assert.equal(forwarding.length, 1, `exactly one forwarding call ${FORWARDING}`);
  const calls = sites.filter((site) => site.call !== FORWARDING);
  assert.ok(calls.length > 40, `found only ${calls.length} call sites`);
  for (const site of calls) {
    assert.ok(site.to !== undefined && (JOB_STATES as readonly string[]).includes(site.to), `${site.where}: the state of ${site.call} must be a literal of JOB_STATES`);
    assert.ok(site.action !== undefined && (JOB_ACTIONS as readonly string[]).includes(site.action), `${site.where}: the action of ${site.call} must be a literal of JOB_ACTIONS`);
  }
  // No dead rows: each (to, action) of the table is some call site's, and so is each action.
  const used = new Set(calls.map((site) => `${site.to} ${site.action}`));
  const dead = JOB_TRANSITIONS.filter((row) => !used.has(`${row.to} ${row.action}`));
  assert.deepEqual(dead, [], 'rows of JOB_TRANSITIONS no call site makes');
  assert.deepEqual(JOB_ACTIONS.filter((action) => !calls.some((site) => site.action === action)), [], 'actions no call site uses');
  // And no call site whose (to, action) the table lacks.
  const pairs = new Set(JOB_TRANSITIONS.map((row) => `${row.to} ${row.action}`));
  assert.deepEqual(calls.filter((site) => !pairs.has(`${site.to} ${site.action}`)).map((site) => `${site.where}: ${site.call}`), []);
});

test('renderTransitions: the create row first, then by from, to and action', () => {
  const lines = renderTransitions().trimEnd().split('\n');
  assert.equal(lines[0], '| From | To | Action |');
  assert.equal(lines[1], '|---|---|---|');
  assert.equal(lines[2], '| (new) | `starting` | `create` |');
  assert.equal(lines.length, JOB_TRANSITIONS.length + 2);
  const parsed = lines.slice(3).map((line) => line.split('|').slice(1, 4).map((cell) => cell.trim().replaceAll('`', '')));
  const position = parsed.map(([from, to, action]) => [JOB_STATES.indexOf(from as JobState), JOB_STATES.indexOf(to as JobState), JOB_ACTIONS.indexOf(action as JobAction)]);
  for (let i = 1; i < position.length; i++) {
    const [a, b] = [position[i - 1]!, position[i]!];
    assert.ok(a[0]! < b[0]! || (a[0] === b[0] && (a[1]! < b[1]! || (a[1] === b[1] && a[2]! < b[2]!))), `row ${i + 3} is out of order: ${lines[i + 2]} before ${lines[i + 3]}`);
  }
});

test('the README shows the table as renderTransitions() renders it', async () => {
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  assert.ok(start >= 0 && end > start, `README.md needs the markers ${START} and ${END}`);
  const block = readme.slice(start + START.length, end).replace(/^\n/, '');
  const expected = renderTransitions();
  assert.ok(block === expected, `The table in README.md (section Job states) differs from JOB_TRANSITIONS; put this between the markers:\n\n${expected}`);
});
