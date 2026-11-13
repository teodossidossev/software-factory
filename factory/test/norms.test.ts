// The norms the user tunes (src/norms.ts): the defaults, a top-level and a workspace override, each
// invalid value falling back to the next source with one problem, the read of norms.json at each
// call (missing, not JSON, changed), and sf norms through the command table and from the CLI.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { answerLines, checkArgs, type Command, COMMANDS, type Serve } from '../src/commands.js';
import { FactoryError } from '../src/errors.js';
import { DEFAULT_NORMS, effectiveNorms, norms, normsFile, type NormSource } from '../src/norms.js';
import { newEnv, runCli, serve, stop } from './support/harness.js';

const E2E = { timeout: 120_000 };
const KEYS = [
  'slice.change_max_lines', 'slice.change_max_files', 'slice.min_lines',
  'lead_time_hours.small', 'lead_time_hours.medium', 'lead_time_hours.complex', 'decision_docs',
];
const allFrom = (source: NormSource): Record<string, NormSource> => Object.fromEntries(KEYS.map((key) => [key, source]));
const configDir = (name: string): Promise<string> => mkdtemp(join(tmpdir(), `sf-norms-${name}-`));

test('the defaults: no file, an empty object', () => {
  assert.deepEqual(DEFAULT_NORMS, {
    slice: { change_max_lines: 400, change_max_files: 10, min_lines: 50 },
    lead_time_hours: { small: 2, medium: 4, complex: 8 },
    decision_docs: ['GLOSSARY.md', 'docs/adr/**/*.md', 'docs/decisions/**/*.md', 'docs/terminology.md', 'docs/architecture.md'],
  });
  for (const file of [undefined, {}, { version: 1 }, { slice: {}, lead_time_hours: {} }]) {
    assert.deepEqual(effectiveNorms(file), { norms: DEFAULT_NORMS, sources: allFrom('default'), problems: [] }, JSON.stringify(file));
  }
});

test('a top-level override: key by key for slice and lead_time_hours, the list as a whole', () => {
  const result = effectiveNorms({ version: 1, slice: { min_lines: 30 }, lead_time_hours: { medium: 3.5 }, decision_docs: [] });
  assert.deepEqual(result.norms, { ...DEFAULT_NORMS, slice: { ...DEFAULT_NORMS.slice, min_lines: 30 }, lead_time_hours: { ...DEFAULT_NORMS.lead_time_hours, medium: 3.5 }, decision_docs: [] });
  assert.deepEqual(result.sources, { ...allFrom('default'), 'slice.min_lines': 'file', 'lead_time_hours.medium': 'file', decision_docs: 'file' });
  assert.deepEqual(result.problems, []);
});

test('a workspace override merges slice key by key over the file\'s and replaces decision_docs', () => {
  const file = {
    slice: { change_max_lines: 500, min_lines: 40 }, decision_docs: ['docs/a.md', 'docs/b.md'],
    workspaces: { web: { slice: { change_max_lines: 300 }, decision_docs: ['ADR/*.md'] }, api: { lead_time_hours: { small: 1 } } },
  };
  const web = effectiveNorms(file, 'web');
  assert.deepEqual(web.norms.slice, { change_max_lines: 300, change_max_files: 10, min_lines: 40 });
  assert.deepEqual(web.norms.decision_docs, ['ADR/*.md']);
  assert.deepEqual(web.sources, { ...allFrom('default'), 'slice.change_max_lines': 'workspace', 'slice.min_lines': 'file', decision_docs: 'workspace' });
  assert.deepEqual(web.problems, []);
  // Another workspace, or none: the file's values; the other entries give none.
  assert.equal(effectiveNorms(file, 'api').norms.slice.change_max_lines, 500);
  assert.equal(effectiveNorms(file, 'api').norms.lead_time_hours.small, 1);
  assert.deepEqual(effectiveNorms(file).norms.decision_docs, ['docs/a.md', 'docs/b.md']);
  assert.equal(effectiveNorms(file, 'other').sources['slice.change_max_lines'], 'file');
});

test('a value of the wrong type or out of range falls back to the next source, with one problem naming the key', () => {
  const problems = (file: unknown, workspace?: string): string[] => effectiveNorms(file, workspace).problems;
  for (const bad of [0, 100001, 1.5, '400', null, true, [400]]) {
    const result = effectiveNorms({ slice: { change_max_lines: bad } });
    assert.equal(result.norms.slice.change_max_lines, 400, JSON.stringify(bad));
    assert.equal(result.sources['slice.change_max_lines'], 'default');
    assert.deepEqual(result.problems, [`slice.change_max_lines: not an integer from 1 to 100000 (got ${JSON.stringify(bad)}); the default is used`]);
  }
  assert.equal(effectiveNorms({ slice: { change_max_files: 1, min_lines: 100000 } }).problems.length, 0);
  for (const bad of [0, -1, 1000.5, '4', null]) {
    assert.deepEqual(problems({ lead_time_hours: { medium: bad } }), [`lead_time_hours.medium: not a number above 0 and at most 1000 (got ${JSON.stringify(bad)}); the default is used`]);
  }
  assert.equal(effectiveNorms({ lead_time_hours: { small: 0.25, complex: 1000 } }).problems.length, 0);
  // A bad workspace value falls back to the file's value when it has one, else to the default.
  const file = { slice: { min_lines: 20 }, workspaces: { web: { slice: { min_lines: -3, change_max_files: 'x' } } } };
  const web = effectiveNorms(file, 'web');
  assert.deepEqual([web.norms.slice.min_lines, web.sources['slice.min_lines'], web.norms.slice.change_max_files, web.sources['slice.change_max_files']], [20, 'file', 10, 'default']);
  assert.deepEqual(web.problems, [
    'workspaces.web.slice.change_max_files: not an integer from 1 to 100000 (got "x"); the default is used',
    'workspaces.web.slice.min_lines: not an integer from 1 to 100000 (got -3); the file\'s value is used',
  ]);
  // The value shown is cut to 40 characters.
  const [long] = problems({ slice: { min_lines: 'y'.repeat(100) } });
  assert.equal(/\(got (.*)\); the default is used$/.exec(long ?? '')?.[1]?.length, 40);
});

test('decision_docs: at most 50 relative globs inside the checkout; one bad entry makes the whole list fall back', () => {
  const docs = (list: unknown, workspace?: string, top?: unknown) => effectiveNorms(top === undefined ? { workspaces: { web: { decision_docs: list } } } : { decision_docs: top, workspaces: { web: { decision_docs: list } } }, workspace ?? 'web');
  for (const bad of [
    '../secrets.md', 'docs/../../x.md', 'docs/..', '/etc/passwd', './docs/a.md', 'docs\\a.md', 'a\0b', '', 'x'.repeat(201), 7, null,
    // A brace's or an extglob's alternative expands on its own: absolute, or out of the checkout.
    '{/tmp,docs}/x.md', '{,/}etc/passwd', '{..,docs}/x.md', 'docs/{a,..}/x.md', 'docs/{adr,decisions}/*.md', '@(/tmp|docs)/x.md', '+(..)/x.md',
    // A character class of one character is that character: Node's glob reads these as docs/../secret.md.
    'docs/[.][.]/secret.md', 'docs/[.]./secret.md', 'docs/.[.]/secret.md', '[/]etc/passwd', 'docs/[ab].md',
  ]) {
    const result = docs(['GLOSSARY.md', bad]);
    assert.deepEqual(result.norms.decision_docs, DEFAULT_NORMS.decision_docs, JSON.stringify(bad));
    assert.equal(result.sources.decision_docs, 'default');
    assert.equal(result.problems.length, 1, JSON.stringify(bad));
    assert.match(result.problems[0]!, /^workspaces\.web\.decision_docs\[1\]: not a relative glob inside the checkout \(got .*\); the default is used$/);
  }
  assert.deepEqual(docs(['docs/x.md', '../y.md'], 'web', ['docs/file.md']).norms.decision_docs, ['docs/file.md']);
  assert.match(docs(['../y.md'], 'web', ['docs/file.md']).problems[0]!, /the file's value is used$/);
  // Not a list, or more than 50: the whole key falls back.
  assert.deepEqual(docs('docs/*.md').problems, ['workspaces.web.decision_docs: not a list of at most 50 globs (got "docs/*.md"); the default is used']);
  const many = Array.from({ length: 51 }, (_, index) => `docs/${index}.md`);
  assert.equal(docs(many).sources.decision_docs, 'default');
  assert.match(docs(many).problems[0]!, /^workspaces\.web\.decision_docs: not a list of at most 50 globs \(got /);
  assert.equal(docs(many.slice(0, 50)).sources.decision_docs, 'workspace');
  // Valid: a glob of 200 characters, '..' inside a name, a leading '~' (a plain character), an empty list.
  assert.equal(docs(['x'.repeat(200), 'docs/a..b.md', '**/*.md']).problems.length, 0);
  const tilde = docs(['~/notes.md', '~drafts/*.md']);
  assert.deepEqual([tilde.problems, tilde.norms.decision_docs, tilde.sources.decision_docs], [[], ['~/notes.md', '~drafts/*.md'], 'workspace']);
  assert.deepEqual(docs([]).norms.decision_docs, []);
});

test('the file\'s shape: the root, a part or a workspace entry that is not an object counts as absent; a version not 1 is read; unknown keys are listed', () => {
  assert.deepEqual(effectiveNorms([1, 2]).problems, ['norms.json: not an object (got [1,2]), ignored']);
  assert.deepEqual(effectiveNorms('x').norms, DEFAULT_NORMS);
  const result = effectiveNorms({
    version: 2, extra: 1, slice: 5, lead_time_hours: { medium: 6, weeks: 2 }, workspaces: { web: 'big', api: { slice: [], colour: 'red' } },
  }, 'web');
  assert.equal(result.norms.lead_time_hours.medium, 6);
  // Every workspace's entry is checked, in the file's order, whichever one is asked (or none).
  const expected = [
    'version: not 1 (got 2); the file is read as version 1',
    'extra: unknown key, ignored',
    'slice: not an object (got 5), ignored',
    'lead_time_hours.weeks: unknown key, ignored',
    'workspaces.web: not an object (got "big"), ignored',
    'workspaces.api.colour: unknown key, ignored',
    'workspaces.api.slice: not an object (got []), ignored',
  ];
  assert.deepEqual(result.problems, expected);
  assert.deepEqual(effectiveNorms({ version: 2, extra: 1, slice: 5, lead_time_hours: { medium: 6, weeks: 2 }, workspaces: { web: 'big', api: { slice: [], colour: 'red' } } }).problems, expected);
  // A bad value of an entry not asked: listed, with the fallback it would have; the values unchanged.
  const other = effectiveNorms({ slice: { min_lines: 20 }, workspaces: { api: { slice: { min_lines: 0, change_max_lines: 'x' } } } }, 'web');
  assert.deepEqual(other.problems, [
    'workspaces.api.slice.change_max_lines: not an integer from 1 to 100000 (got "x"); the default is used',
    'workspaces.api.slice.min_lines: not an integer from 1 to 100000 (got 0); the file\'s value is used',
  ]);
  assert.deepEqual([other.norms.slice.min_lines, other.sources['slice.min_lines']], [20, 'file']);
  assert.deepEqual(effectiveNorms({ workspaces: [] }).problems, ['workspaces: not an object (got []), ignored']);
  // A key that is not plain is named by its JSON, so a problem stays one line.
  assert.deepEqual(effectiveNorms({ 'a\nb': 1, workspaces: { 'x\ny': { 'p q': 1 } } }).problems, [
    '"a\\nb": unknown key, ignored',
    'workspaces."x\\ny"."p q": unknown key, ignored',
  ]);
});

test('a workspace entry is the entry\'s own key only: __proto__ and constructor', () => {
  assert.deepEqual(effectiveNorms({ workspaces: {} }, 'constructor'), { norms: DEFAULT_NORMS, sources: allFrom('default'), problems: [] });
  assert.deepEqual(effectiveNorms({ workspaces: {} }, '__proto__'), { norms: DEFAULT_NORMS, sources: allFrom('default'), problems: [] });
  assert.deepEqual(effectiveNorms({ workspaces: {} }, 'toString').norms, DEFAULT_NORMS);
  const parsed: unknown = JSON.parse('{"workspaces":{"__proto__":{"slice":{"min_lines":7}},"constructor":{"decision_docs":["a.md"]}}}');
  assert.equal(effectiveNorms(parsed, '__proto__').norms.slice.min_lines, 7);
  assert.deepEqual(effectiveNorms(parsed, 'constructor').norms.decision_docs, ['a.md']);
});

test('norms(): read at each call; a missing file is the defaults, a file that is not JSON the defaults with one problem; never throws', async () => {
  const dir = await configDir('read');
  assert.equal(normsFile(dir), join(dir, 'norms.json'));
  assert.deepEqual(await norms(undefined, dir), { norms: DEFAULT_NORMS, sources: allFrom('default'), problems: [] });
  await writeFile(normsFile(dir), '{ not json');
  const bad = await norms('web', dir);
  assert.deepEqual(bad.norms, DEFAULT_NORMS);
  assert.equal(bad.problems.length, 1);
  assert.match(bad.problems[0]!, /^norms\.json is not JSON: .+; the defaults are used$/);
  await writeFile(normsFile(dir), JSON.stringify({ slice: { min_lines: 60 } }));
  assert.equal((await norms('web', dir)).norms.slice.min_lines, 60);
  await writeFile(normsFile(dir), JSON.stringify({ workspaces: { web: { slice: { min_lines: 70 } } } }));
  assert.equal((await norms('web', dir)).norms.slice.min_lines, 70);
  // A file that cannot be read (a directory here): the defaults, with one problem.
  const unreadable = await configDir('unreadable');
  await mkdir(normsFile(unreadable));
  const result = await norms(undefined, unreadable);
  assert.deepEqual([result.norms, result.problems.length], [DEFAULT_NORMS, 1]);
  assert.match(result.problems[0]!, /^norms\.json cannot be read: .+; the defaults are used$/);
});

test('sf norms through the command table: zero or one argument, the name checked, a name without an entry, the problems of every workspace\'s entry', async () => {
  assert.deepEqual(checkArgs(COMMANDS.norms, []).args, []);
  assert.deepEqual(checkArgs(COMMANDS.norms, ['web']).args, ['web']);
  assert.throws(() => checkArgs(COMMANDS.norms, ['web', 'api']), (error: unknown) => error instanceof FactoryError && error.code === 'bad_request' && error.message === 'norms needs [workspace].');
  assert.throws(() => checkArgs(COMMANDS.norms, ['bad name']), (error: unknown) => error instanceof FactoryError && error.code === 'invalid_name');
  assert.equal(COMMANDS.norms.openWhileUpdating, true);
  const dir = await configDir('table');
  const before = process.env.SF_CONFIG_DIR;
  process.env.SF_CONFIG_DIR = dir;
  try {
    await writeFile(normsFile(dir), JSON.stringify({ lead_time_hours: { complex: 12 } }));
    const command: Command = COMMANDS.norms;
    const shown = async (args: string[]) => answerLines(command, await command.run({} as Serve, args, {}) as Record<string, unknown>, {});
    const { lines, failed } = await shown(['web']);
    assert.equal(failed, false);
    assert.deepEqual(lines.slice(0, 2), [`norms: ${normsFile(dir)} (workspace web)`, 'workspace web: no entry']);
    assert.ok(lines.includes('lead_time_hours.complex  12   file'), lines.join('\n'));
    const plain = (await shown([])).lines;
    assert.equal(plain[0], `norms: ${normsFile(dir)}`);
    assert.ok(!plain.some((line) => line.startsWith('workspace ')));
    // The problems of every workspace's entry, the one asked or not, and with none asked.
    await writeFile(normsFile(dir), JSON.stringify({ workspaces: { web: { slice: { min_lines: 40 } }, api: { colour: 'red', lead_time_hours: { small: -1 } } } }));
    const problems = ['problems:', '  workspaces.api.colour: unknown key, ignored', '  workspaces.api.lead_time_hours.small: not a number above 0 and at most 1000 (got -1); the default is used'];
    for (const args of [[], ['web'], ['api']]) {
      const shownLines = (await shown(args)).lines;
      assert.deepEqual(shownLines.slice(-3), problems, args.join(' '));
      assert.ok(shownLines.includes(args[0] === 'web' ? 'slice.min_lines          40   workspace' : 'slice.min_lines          50   default'), shownLines.join('\n'));
    }
  } finally {
    if (before === undefined) {
      delete process.env.SF_CONFIG_DIR;
    } else {
      process.env.SF_CONFIG_DIR = before;
    }
  }
});

test('sf norms from the CLI: the defaults with no file; a workspace entry and one problem; exit 0', E2E, async () => {
  const env = await newEnv('norms-cli');
  const served = await serve(env);
  try {
    const none = await runCli(env, ['norms']);
    assert.equal(none.code, 0, none.stderr);
    assert.equal(none.stdout, [
      `norms: ${join(env.config, 'norms.json')} (no file: the defaults)`,
      'slice.change_max_lines   400  default',
      'slice.change_max_files   10   default',
      'slice.min_lines          50   default',
      'lead_time_hours.small    2    default',
      'lead_time_hours.medium   4    default',
      'lead_time_hours.complex  8    default',
      'decision_docs                 default',
      '  GLOSSARY.md',
      '  docs/adr/**/*.md',
      '  docs/decisions/**/*.md',
      '  docs/terminology.md',
      '  docs/architecture.md',
      '',
    ].join('\n'));
    await mkdir(env.config, { recursive: true });
    await writeFile(join(env.config, 'norms.json'), JSON.stringify({
      version: 1, slice: { min_lines: 'x' }, decision_docs: ['docs/decisions/**/*.md'], workspaces: { web: { slice: { change_max_lines: 300 } } },
    }));
    const web = await runCli(env, ['norms', 'web']);
    assert.equal(web.code, 0, web.stderr);
    assert.equal(web.stdout, [
      `norms: ${join(env.config, 'norms.json')} (workspace web)`,
      'slice.change_max_lines   300  workspace',
      'slice.change_max_files   10   default',
      'slice.min_lines          50   default',
      'lead_time_hours.small    2    default',
      'lead_time_hours.medium   4    default',
      'lead_time_hours.complex  8    default',
      'decision_docs                 file',
      '  docs/decisions/**/*.md',
      'problems:',
      '  slice.min_lines: not an integer from 1 to 100000 (got "x"); the default is used',
      '',
    ].join('\n'));
    const tooMany = await runCli(env, ['norms', 'web', 'api']);
    assert.equal(tooMany.code, 2);
  } finally {
    await stop(served);
  }
});
