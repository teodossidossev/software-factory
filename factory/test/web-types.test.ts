// Every page payload type is checked against the server's (SF-186). The checks themselves are
// test/web-types/check.ts, compiled by npm run typecheck (tsconfig.web-types.json); this test reads
// that file and web/types.d.ts as text and fails, naming the type, when a top-level type of
// web/types.d.ts is neither a key of its Checks nor listed in PAGE_ONLY or KNOWN_DRIFT, so a new
// page type cannot skip the check. The reading is tried on sources of its own first.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// The tests run from dist/test; the sources are those of the checkout.
const PAGE_TYPES = new URL('../../web/types.d.ts', import.meta.url);
const CHECKS = new URL('../../test/web-types/check.ts', import.meta.url);

// The names of the top-level types and interfaces of a declaration file.
function pageTypes(source: string): string[] {
  return [...source.matchAll(/^(?:declare\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]!);
}

// The names of one of check.ts's lists (PAGE_ONLY, NARROWED, KNOWN_DRIFT), each entry
// ['<name>', '<reason>'], with its reason.
function listed(source: string, list: string): Array<{ name: string; reason: string }> {
  const body = new RegExp(`^export const ${list} = \\[([\\s\\S]*?)\\] as const;`, 'm').exec(source);
  assert.ok(body !== null, `check.ts has no export const ${list} = [...] as const;`);
  return [...body[1]!.matchAll(/\[\s*'([^']*)',\s*'([^']*)'\s*\]/g)].map((match) => ({ name: match[1]!, reason: match[2]! }));
}

// The keys of check.ts's interface Checks, each with the page type its check names first.
function checked(source: string): Array<{ key: string; type: string | undefined }> {
  const body = /^export interface Checks \{\n([\s\S]*?)^\}/m.exec(source);
  assert.ok(body !== null, 'check.ts has no export interface Checks { ... }');
  return body[1]!.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('//')).map((line) => {
    const entry = /^\s+(\w+): (?:Copy|Same)<(\w+),/.exec(line);
    return { key: entry?.[1] ?? line.trim(), type: entry?.[2] };
  });
}

// What is wrong with the coverage of the page types by check.ts: a page type neither checked nor
// listed, a check whose page type is not its key, a name checked or listed that is no page type or
// more than once, an entry without a reason. Empty when all is well.
function coverageProblems(types: string, checks: string): string[] {
  const page = pageTypes(types);
  const entries = checked(checks);
  const pageOnly = listed(checks, 'PAGE_ONLY');
  const drift = listed(checks, 'KNOWN_DRIFT');
  const narrowed = listed(checks, 'NARROWED');
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.type !== entry.key) {
      problems.push(`check ${entry.key}: not of the form "${entry.key}: Copy<${entry.key}, …>" or "${entry.key}: Same<${entry.key}, …>"`);
    }
  }
  const covered = [...entries.map((entry) => entry.key), ...pageOnly.map((entry) => entry.name), ...drift.map((entry) => entry.name)];
  for (const name of page) {
    if (!covered.includes(name)) {
      problems.push(`${name}: a type of web/types.d.ts with no check in test/web-types/check.ts and not in PAGE_ONLY or KNOWN_DRIFT`);
    }
  }
  for (const name of new Set(covered)) {
    if (!page.includes(name)) {
      problems.push(`${name}: checked or listed in test/web-types/check.ts, but no type of web/types.d.ts`);
    } else if (covered.filter((other) => other === name).length > 1) {
      problems.push(`${name}: checked or listed more than once in test/web-types/check.ts`);
    }
  }
  for (const entry of narrowed) {
    if (!page.includes(entry.name.split('.')[0]!)) {
      problems.push(`NARROWED ${entry.name}: no type of web/types.d.ts`);
    }
  }
  for (const entry of [...pageOnly, ...drift, ...narrowed]) {
    if (entry.reason.trim() === '') {
      problems.push(`${entry.name}: listed without a reason`);
    }
  }
  return problems;
}

const FIXTURE_CHECKS = `export const PAGE_ONLY = [
  ['Helper', 'a page-only helper'],
] as const;
export const NARROWED = [] as const;
export const KNOWN_DRIFT = [] as const;
export interface Checks {
  Row: Copy<Row, ServerRow>;
  // A comment line is no check.
  Mode: Same<Mode, ServerMode>;
}
`;

test('the coverage check passes a page whose every type is checked or listed', () => {
  const types = 'type Mode = \'a\' | \'b\';\ninterface Row {\n  mode: Mode;\n}\ntype Helper = Row & { x: number };\n';
  assert.deepEqual(coverageProblems(types, FIXTURE_CHECKS), []);
});

test('the coverage check names a page type that is neither checked nor listed', () => {
  const types = 'type Mode = \'a\';\ninterface Row {\n  mode: Mode;\n  nested: { type: string };\n}\ntype Helper = Row;\ninterface Added {\n  x: number;\n}\n';
  assert.deepEqual(coverageProblems(types, FIXTURE_CHECKS), [
    'Added: a type of web/types.d.ts with no check in test/web-types/check.ts and not in PAGE_ONLY or KNOWN_DRIFT',
  ]);
});

test('the coverage check names a stale, doubled, mislabelled or reasonless entry', () => {
  const types = 'type Mode = \'a\';\ninterface Row {\n  mode: Mode;\n}\n';
  const checks = FIXTURE_CHECKS
    .replace("['Helper', 'a page-only helper'],", "['Helper', 'gone'],\n  ['Row', ''],")
    .replace('Mode: Same<Mode, ServerMode>;', 'Mode: Same<Row, ServerMode>;')
    .replace('export const NARROWED = [] as const;', "export const NARROWED = [\n  ['Gone.items', 'unknown there'],\n] as const;");
  assert.deepEqual(coverageProblems(types, checks), [
    'check Mode: not of the form "Mode: Copy<Mode, …>" or "Mode: Same<Mode, …>"',
    'Row: checked or listed more than once in test/web-types/check.ts',
    'Helper: checked or listed in test/web-types/check.ts, but no type of web/types.d.ts',
    'NARROWED Gone.items: no type of web/types.d.ts',
    'Row: listed without a reason',
  ]);
});

test('every type of web/types.d.ts is checked against the server or listed in PAGE_ONLY', async () => {
  const [types, checks] = await Promise.all([readFile(PAGE_TYPES, 'utf8'), readFile(CHECKS, 'utf8')]);
  assert.ok(pageTypes(types).length > 0, 'web/types.d.ts declares no type');
  assert.deepEqual(coverageProblems(types, checks), []);
});
