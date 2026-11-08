// The module boundaries of src/ (SF-142), read from the sources' import statements: no module of
// the job lifecycle (src/execution/) imports the modules above it (the dashboard, the MCP server,
// the run queue, the CLI), and only src/test-hooks.ts names the test hooks' settings. Type-only
// imports are left to review, not checked here. The checks are tried on sources of their own first.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readTestHooks } from '../src/test-hooks.js';

// The tests run from dist/test; the sources are those of the checkout.
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
// The modules src/execution/ must not import, relative to src/.
const ABOVE_EXECUTION: readonly string[] = ['dashboard.ts', 'server.ts', 'queue.ts', 'cli.ts'];
// The settings only src/test-hooks.ts reads.
const HOOK_SETTINGS: readonly string[] = ['SF_TEST_HOOKS', 'SF_TEST_TASK_CHECK_DELAY_MS', 'SF_TEST_MARKER_POLL_MS', 'SF_TEST_PROC_DIR'];
const HOOKS_MODULE = 'test-hooks.ts';

// The source without its whole-line // comments, which name settings and modules freely (the
// sources have no block comments); a comment after code, or a block comment, stays and counts.
function code(source: string): string {
  return source.split('\n').map((line) => (line.trimStart().startsWith('//') ? '' : line)).join('\n');
}

// Whether an import or export clause carries only types: `import type`/`export type`, or named
// members that are each marked type ({ type A, type B }).
function typeOnly(keyword: string | undefined, clause: string): boolean {
  if (keyword !== undefined) {
    return true;
  }
  const named = /^\{([^}]*)\}$/.exec(clause.trim());
  const members = named?.[1]!.split(',').map((member) => member.trim()).filter((member) => member !== '') ?? [];
  return members.length > 0 && members.every((member) => /^type\s/.test(member));
}

// Every module specifier of the source's static imports and re-exports (on one line or several),
// side-effect imports and dynamic import() calls. Type-only imports and re-exports are not
// counted: the Task leaves them to review (SF-142).
function specifiers(source: string): string[] {
  const text = code(source);
  return [
    ...[...text.matchAll(/\b(?:import|export)\b(\s+type\b)?([^;'"]*?)\bfrom\s*['"]([^'"]+)['"]/g)]
      .filter((match) => !typeOnly(match[1], match[2]!))
      .map((match) => match[3]!),
    ...[...text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g), ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]!),
  ];
}

// The modules of src/ (relative to it, as .ts) that a source at file (relative to src/) imports.
function importedModules(file: string, source: string): string[] {
  return specifiers(source)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => normalize(join(dirname(file), specifier)).replace(/\.js$/, '.ts'));
}

// What a module of src/execution/ imports of the modules above it.
function importsAbove(file: string, source: string): string[] {
  return importedModules(file, source).filter((module) => ABOVE_EXECUTION.includes(module));
}

// The hook settings a source names outside a whole-line comment: process.env.X, env.X,
// env['X'], a destructured X alike.
function hookNames(source: string): string[] {
  const text = code(source);
  return HOOK_SETTINGS.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
}

async function sources(): Promise<Array<{ file: string; source: string }>> {
  const files = (await readdir(SRC, { recursive: true })).filter((file) => file.endsWith('.ts')).sort();
  return Promise.all(files.map(async (file) => ({ file, source: await readFile(join(SRC, file), 'utf8') })));
}

test('the checks catch what they say: every import form of a module above src/execution/ but the type-only ones, and every read of a hook setting outside a comment', () => {
  const caught = [
    "import { readToken } from '../dashboard.js';",
    "import { type Execution, startServer } from '../server.js';",
    "import {\n  QueueStore,\n  runningJobs,\n} from '../queue.js';",
    "export { main } from '../cli.js';",
    "import '../queue.js';",
    "const { RunQueue } = await import('../queue.js');",
    "import { x } from './../dashboard.js';",
  ];
  for (const source of caught) {
    assert.equal(importsAbove('execution/start.ts', source).length, 1, source);
  }
  const passed = [
    "import { runningJobs } from '../jobs.js';",
    "import { x } from './queue.js';",
    "// import { readToken } from '../dashboard.js';",
    "import { x } from 'dashboard.js';",
    // Type-only: left to review.
    "import type { Execution } from '../server.js';",
    "import { type RunQueue, type QueueView } from '../queue.js';",
    "import type {\n  Serve,\n} from '../cli.js';",
    "export type { QueueFile } from '../queue.js';",
  ];
  for (const source of passed) {
    assert.deepEqual(importsAbove('execution/start.ts', source), [], source);
  }
  assert.deepEqual(importsAbove('cli.ts', "import { RunQueue } from './queue.js';"), ['queue.ts']);
  for (const source of [
    "const on = process.env.SF_TEST_HOOKS === 'on';",
    "const delay = process.env['SF_TEST_TASK_CHECK_DELAY_MS'];",
    'const { SF_TEST_MARKER_POLL_MS: poll } = process.env;',
    'const dir = env.SF_TEST_PROC_DIR; // the fake /proc',
  ]) {
    assert.equal(hookNames(source).length, 1, source);
  }
  assert.deepEqual(hookNames('// SF_TEST_HOOKS=on: the tests\' commands answer.\nconst x = 1;'), []);
  assert.deepEqual(hookNames('const timeout = process.env.SF_TEST_TIMEOUT_MS;'), []);
});

test('no module under src/execution/ imports dashboard.ts, server.ts, queue.ts or cli.ts (type-only imports aside)', async () => {
  const execution = (await sources()).filter(({ file }) => file.startsWith('execution/'));
  assert.ok(execution.length >= 10, `only ${execution.length} modules under src/execution/`);
  const found = execution.flatMap(({ file, source }) => importsAbove(file, source).map((module) => `src/${file} imports src/${module}`));
  assert.deepEqual(found, []);
});

test('only src/test-hooks.ts reads SF_TEST_HOOKS, SF_TEST_TASK_CHECK_DELAY_MS, SF_TEST_MARKER_POLL_MS and SF_TEST_PROC_DIR', async () => {
  const all = await sources();
  assert.deepEqual(hookNames(all.find(({ file }) => file === HOOKS_MODULE)!.source), HOOK_SETTINGS);
  const found = all.filter(({ file }) => file !== HOOKS_MODULE).flatMap(({ file, source }) => hookNames(source).map((name) => `src/${file} reads ${name}`));
  assert.deepEqual(found, []);
});

test('every test hook is off unless SF_TEST_HOOKS=on; a delay that is not a whole number and an empty directory count as unset', () => {
  const settings = { SF_TEST_TASK_CHECK_DELAY_MS: '300', SF_TEST_MARKER_POLL_MS: '200', SF_TEST_PROC_DIR: '/tmp/proc' };
  const off = { socketCommands: false, taskCheckDelayMs: undefined, markerPollMs: undefined, procDir: undefined };
  for (const value of [undefined, '', 'off', 'ON', '1', 'true', ' on']) {
    assert.deepEqual(readTestHooks({ ...settings, ...(value !== undefined ? { SF_TEST_HOOKS: value } : {}) }), off, `SF_TEST_HOOKS=${value}`);
  }
  const on = readTestHooks({ ...settings, SF_TEST_HOOKS: 'on' });
  assert.deepEqual(on, { socketCommands: true, taskCheckDelayMs: 300, markerPollMs: 200, procDir: '/tmp/proc' });
  assert.ok(Object.isFrozen(on));
  assert.deepEqual(readTestHooks({ SF_TEST_HOOKS: 'on', SF_TEST_TASK_CHECK_DELAY_MS: '1.5', SF_TEST_MARKER_POLL_MS: '-1', SF_TEST_PROC_DIR: '' }), { ...off, socketCommands: true });
  assert.deepEqual(readTestHooks({ SF_TEST_HOOKS: 'on' }), { ...off, socketCommands: true });
});
