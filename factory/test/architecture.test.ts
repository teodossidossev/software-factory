// The module boundaries of src/ (SF-142), read from the sources' import statements: no module of
// the job lifecycle (src/execution/) imports the modules above it (the dashboard, the MCP server,
// the run queue, the CLI), and only src/test-hooks.ts names the test hooks' settings. Type-only
// imports are left to review, not checked here. The job lifecycle's parts take narrow ports, not
// the whole Core (SF-143): no part names Core or reaches through .parts., each part's constructor
// takes only the ports of execution/ports.ts and interfaces declared next to it, and Core has no
// parts field. The checks are tried on sources of their own first.
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

// The parts of the job lifecycle under src/execution/ (SF-143).
const PARTS: readonly string[] = ['start.ts', 'turns.ts', 'reviews.ts', 'mr-steps.ts', 'handover-steps.ts', 'control.ts', 'status.ts'].map((file) => `execution/${file}`);
// Where Core may be named: Core itself and Execution, which builds it and wires the parts.
const NAMES_CORE: readonly string[] = ['execution/core.ts', 'execution.ts'];
const PORTS_MODULE = 'execution/ports.ts';
const CORE_MODULE = 'execution/core.ts';

// Whether the source names Core outside a whole-line comment.
function namesCore(source: string): boolean {
  return /\bCore\b/.test(code(source));
}

// Whether the source mentions .parts. anywhere, its comments too.
function mentionsParts(source: string): boolean {
  return source.includes('.parts.');
}

// Whether the source declares a class field named parts (parts!: …, readonly parts = …, #parts).
function declaresParts(source: string): boolean {
  return /^\s*(?:(?:readonly|public|private|protected|declare|static)\s+)*#?parts\s*[!?]?\s*[:=;]/m.test(code(source));
}

// The interfaces and type aliases a source declares at its top level.
function declaredTypes(source: string): string[] {
  return [...code(source).matchAll(/^(?:export\s+)?(?:interface|type)\s+(\w+)/gm)].map((match) => match[1]!);
}

// The text between the parenthesis at open and its match.
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    depth += text[index] === '(' ? 1 : text[index] === ')' ? -1 : 0;
    if (depth === 0) {
      return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

// The parameters of a list, split at its top-level commas.
function parameters(list: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    depth += '(<{['.includes(char) ? 1 : ')>}]'.includes(char) && !(char === '>' && current.endsWith('=')) ? -1 : 0;
    if (char === ',' && depth === 0) {
      found.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  return [...found, current].map((parameter) => parameter.trim()).filter((parameter) => parameter !== '');
}

// The constructor parameters of the source whose type is neither a port of ports.ts (ports) nor an
// interface or type the source declares itself; a parameter without a type, or of an inline type,
// counts too. A source without a constructor has none.
function foreignParameters(source: string, ports: readonly string[]): string[] {
  const text = code(source);
  const at = /\bconstructor\s*\(/.exec(text);
  if (at === null) {
    return [];
  }
  const allowed = new Set([...ports, ...declaredTypes(source)]);
  return parameters(balanced(text, at.index + at[0].length - 1)).filter((parameter) => {
    const type = /^[\w$]+\??\s*:\s*([\s\S]+)$/.exec(parameter)?.[1]!.trim();
    return type === undefined || !allowed.has(type);
  });
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

test('the port checks catch what they say: Core named in code, .parts. anywhere, a parts field, a constructor parameter that is no port and no interface of its own', () => {
  assert.equal(namesCore("import type { Core } from './core.js';"), true);
  assert.equal(namesCore('  constructor(core: Core) {}'), true);
  assert.equal(namesCore('// Core implements the ports.\nconst core = 1;'), false);
  assert.equal(namesCore('const coreParts = new CoreDump();'), false);
  assert.equal(mentionsParts('    return this.core.parts.control.request(workspace, ticket, request);'), true);
  assert.equal(mentionsParts('// reach each other as this.core.parts.<part>'), true);
  assert.equal(mentionsParts('const parts = { start };'), false);
  for (const source of ['  parts!: Parts;', '  readonly parts: Parts;', '  #parts = {};', '  public parts?: Parts;', 'class Core {\n  parts;\n}']) {
    assert.equal(declaresParts(source), true, source);
  }
  for (const source of ['  // parts!: Parts;', '  readonly #parts2: number;', '  const parts = 1;', '  partsOf(): void {}']) {
    assert.equal(declaresParts(source), false, source);
  }
  const ports = ['JobStorePort', 'SettingsPort'];
  const part = 'export interface StatusPeers {\n  readonly x: number;\n}\ninterface Own { a(): void }\nexport class StatusPart {\n  constructor(store: JobStorePort, settings: SettingsPort, peers: StatusPeers, own: Own) {}\n}';
  assert.deepEqual(foreignParameters(part, ports), []);
  assert.deepEqual(foreignParameters('export class P {\n  #x = 1;\n}', ports), []);
  assert.deepEqual(foreignParameters('class P {\n  constructor(core: Core) {}\n}', ports), ['core: Core']);
  assert.deepEqual(foreignParameters('class P {\n  constructor(store: JobStorePort, control: ControlPart) {}\n}', ports), ['control: ControlPart']);
  assert.deepEqual(foreignParameters('class P {\n  constructor(store: JobStorePort, peers: { control: () => Promise<void>; n: Map<string, number> }) {}\n}', ports), ['peers: { control: () => Promise<void>; n: Map<string, number> }']);
  assert.deepEqual(foreignParameters('class P {\n  constructor(store, settings: SettingsPort | undefined) {}\n}', ports), ['store', 'settings: SettingsPort | undefined']);
});

test('no part of src/execution/ names Core or mentions .parts., and only core.ts and execution.ts name Core', async () => {
  const all = await sources();
  const parts = all.filter(({ file }) => PARTS.includes(file));
  assert.equal(parts.length, PARTS.length);
  assert.deepEqual(parts.filter(({ source }) => mentionsParts(source)).map(({ file }) => `src/${file} mentions .parts.`), []);
  const execution = all.filter(({ file }) => file.startsWith('execution/') || file === 'execution.ts');
  assert.deepEqual(execution.filter(({ file, source }) => !NAMES_CORE.includes(file) && namesCore(source)).map(({ file }) => `src/${file} names Core`), []);
});

test("each part's constructor takes only the ports of execution/ports.ts and interfaces declared next to it", async () => {
  const all = await sources();
  const ports = declaredTypes(all.find(({ file }) => file === PORTS_MODULE)!.source);
  assert.ok(ports.includes('JobStorePort') && ports.includes('StopPort'), `ports.ts declares ${ports.join(', ')}`);
  const found = all.filter(({ file }) => PARTS.includes(file)).flatMap(({ file, source }) => {
    assert.match(code(source), /\bconstructor\s*\(/, `src/${file} has no constructor`);
    return foreignParameters(source, ports).map((parameter) => `src/${file}: ${parameter}`);
  });
  assert.deepEqual(found, []);
});

test('Core declares no parts field', async () => {
  const core = (await sources()).find(({ file }) => file === CORE_MODULE)!;
  assert.equal(declaresParts(core.source), false);
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
