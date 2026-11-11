// The code checks of npm test (SF-144), scripts/check-code.mjs run on temporary package trees: the
// size ratchet of code-size.json, which --update only ever lowers, no script under static/, and
// every web/*.ts a dashboard script, no comment that cites a ticket, and every catch without a binding
// saying on its line why any failure there is fine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The tests run from dist/test; the script is that of the checkout.
const SCRIPT = fileURLToPath(new URL('../../scripts/check-code.mjs', import.meta.url));
const DASHBOARD = "export const DASHBOARD_SCRIPTS = ['core.js', 'main.js'] as const;\n";

type Run = { code: number | null; stderr: string; stdout: string };

// A source of the given number of lines, each ending in \n.
const lines = (count: number): string => 'x;\n'.repeat(count);

// A package tree with the given files (relative path → content) and code-size.json.
async function tree(files: Record<string, string>, list: Record<string, number> | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sf-check-code-'));
  const all: Record<string, string> = { 'src/dashboard.ts': DASHBOARD, 'web/core.ts': lines(10), 'web/main.ts': lines(10), ...files };
  for (const [file, content] of Object.entries(all)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  if (list !== null) {
    await writeFile(join(root, 'code-size.json'), `${JSON.stringify(list, null, 2)}\n`);
  }
  return root;
}

function check(root: string, ...args: string[]): Run {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  return { code: result.status, stderr: result.stderr, stdout: result.stdout };
}

async function list(root: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, 'code-size.json'), 'utf8'));
}

async function withTree(files: Record<string, string>, sizes: Record<string, number> | null, body: (root: string) => Promise<void>): Promise<void> {
  const root = await tree(files, sizes);
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('check-code: a tree within its list passes, and the working directory is the root without --root', async () => {
  await withTree({ 'src/big.ts': lines(700), 'src/small.ts': lines(600), 'web/types.d.ts': lines(900) }, { 'src/big.ts': 720 }, async (root) => {
    assert.equal(check(root).code, 0, check(root).stderr);
    const fromCwd = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    assert.equal(fromCwd.status, 0, fromCwd.stderr);
  });
});

test('check-code: a listed file that grew past its count fails', async () => {
  await withTree({ 'src/big.ts': lines(701) }, { 'src/big.ts': 700 }, async (root) => {
    const run = check(root);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /src\/big\.ts has 701 lines, more than the 700/);
  });
});

test('check-code: an unlisted file of 601 lines fails; one of 600 passes; a final line without \\n counts', async () => {
  await withTree({ 'src/new.ts': lines(601) }, {}, async (root) => {
    const run = check(root);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /src\/new\.ts has 601 lines, more than 600/);
  });
  await withTree({ 'src/edge.ts': lines(600) }, null, async (root) => {
    assert.equal(check(root).code, 0);
  });
  await withTree({ 'src/edge.ts': `${lines(600)}y;` }, null, async (root) => {
    assert.match(check(root).stderr, /src\/edge\.ts has 601 lines/);
  });
});

test('check-code: a listed file shrunk by 60 lines fails until --update lowers its count', async () => {
  await withTree({ 'src/big.ts': lines(700) }, { 'src/big.ts': 760 }, async (root) => {
    const run = check(root);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /src\/big\.ts has 700 lines, 60 fewer than the 760 in code-size\.json: run npm run check-code -- --update/);
    assert.equal(check(root, '--update').code, 0);
    assert.deepEqual(await list(root), { 'src/big.ts': 700 });
    assert.equal(check(root).code, 0);
  });
  await withTree({ 'src/big.ts': lines(700) }, { 'src/big.ts': 750 }, async (root) => {
    assert.equal(check(root).code, 0, 'a shrink of 50 lines is allowed');
  });
});

test('check-code: a listed file that is gone or at 600 lines or fewer fails until --update drops it', async () => {
  await withTree({ 'src/fallen.ts': lines(600), 'src/big.ts': lines(650) }, { 'src/gone.ts': 900, 'src/fallen.ts': 620, 'src/big.ts': 650 }, async (root) => {
    const run = check(root);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /src\/gone\.ts is listed in code-size\.json but is gone/);
    assert.match(run.stderr, /src\/fallen\.ts has 600 lines, no more than 600/);
    assert.equal(check(root, '--update').code, 0);
    assert.deepEqual(await list(root), { 'src/big.ts': 650 });
  });
});

test('check-code: --update never raises a count nor adds a file, and the check still fails', async () => {
  await withTree({ 'src/b.ts': lines(800), 'src/a.ts': lines(700), 'src/new.ts': lines(650) }, { 'src/b.ts': 750, 'src/a.ts': 710 }, async (root) => {
    const run = check(root, '--update');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /src\/b\.ts has 800 lines, more than the 750/);
    assert.match(run.stderr, /src\/new\.ts has 650 lines, more than 600/);
    const written = await readFile(join(root, 'code-size.json'), 'utf8');
    assert.equal(written, '{\n  "src/a.ts": 700,\n  "src/b.ts": 750\n}\n', 'sorted, lowered, never raised');
  });
});

test('check-code: a .js file under static/ fails', async () => {
  await withTree({ 'static/app.css': 'body {}\n', 'static/app.js': 'x;\n', 'static/old/core.js': 'x;\n' }, {}, async (root) => {
    const run = check(root);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /static\/app\.js: static\/ holds no script/);
    assert.match(run.stderr, /static\/old\/core\.js: static\/ holds no script/);
    assert.doesNotMatch(run.stderr, /app\.css/);
  });
});

test('check-code: a web/*.ts file not in DASHBOARD_SCRIPTS fails; a declaration file is exempt', async () => {
  await withTree({ 'web/extra.ts': lines(5), 'web/types.d.ts': lines(5) }, {}, async (root) => {
    const run = check(root);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /web\/extra\.ts: extra\.js is not in DASHBOARD_SCRIPTS/);
    assert.doesNotMatch(run.stderr, /types/);
  });
});

test('check-code: a comment in src/ that cites a ticket fails, a whole-line one and a trailing one, with file and line', async () => {
  await withTree({ 'src/a.ts': 'x;\n// the reason (SF-12)\n', 'src/b.ts': 'code; // SF-12\n', 'src/c.ts': '/* SF-7 */\n/**\n * since SF-8\n */\n' }, {}, async (root) => {
    const run = check(root);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /src\/a\.ts:2: a comment cites SF-12/);
    assert.match(run.stderr, /src\/b\.ts:1: a comment cites SF-12/);
    assert.match(run.stderr, /src\/c\.ts:1: a comment cites SF-7/);
    assert.match(run.stderr, /src\/c\.ts:3: a comment cites SF-8/);
  });
});

test('check-code: a ticket in a string on a code line, or in a comment under test/, passes', async () => {
  const strings = "const a = 'SF-12';\nconst b = \"// SF-12\";\nconst c = `see // SF-12`; // fine\nconst d = 'it\\'s // SF-12';\n";
  await withTree({ 'src/a.ts': strings, 'test/x.test.ts': '// SF-12\ncode; // SF-12\n' }, {}, async (root) => {
    const run = check(root);
    assert.equal(run.code, 0, run.stderr);
  });
});

test('check-code: a comment that cites a ticket in a declaration file under web/ fails', async () => {
  await withTree({ 'web/types.d.ts': 'type A = string;\n// SF-12\n' }, {}, async (root) => {
    const run = check(root);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /web\/types\.d\.ts:2: a comment cites SF-12/);
  });
});

test('check-code: a catch without a binding and without a reason on its line fails, with file and line', async () => {
  const bare = 'try {\n  x();\n} catch {\n  // the reason on the next line does not count\n}\n';
  const empty = 'try {\n  x();\n} catch { //   \n}\n';
  await withTree({ 'src/a.ts': bare, 'src/b.ts': empty, 'web/core.ts': 'try { x(); } catch{ y(); }\n' }, {}, async (root) => {
    const run = check(root);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /src\/a\.ts:3: a catch without a binding drops the error/);
    assert.match(run.stderr, /src\/b\.ts:3: a catch without a binding drops the error/);
    assert.match(run.stderr, /web\/core\.ts:1: a catch without a binding drops the error/);
  });
});

test('check-code: a catch with its reason on its line, a catch with a binding, and a catch in a string or a comment pass', async () => {
  const fine = [
    'try {\n  x();\n} catch { // missing: the job has no record\n}',
    'try {\n  x();\n} catch (error) {\n  throw error;\n}',
    "const a = 'try {} catch {}';",
    'const b = `} catch {`; // a template string',
    '// } catch {',
    '/* } catch { */',
    '/**', ' * } catch {', ' */',
    'x(); // then catch { y }',
  ].join('\n');
  await withTree({ 'src/a.ts': `${fine}\n`, 'test/x.test.ts': 'try {} catch {}\n' }, {}, async (root) => {
    const run = check(root);
    assert.equal(run.code, 0, run.stderr);
  });
});

test('check-code: a catch on a later line of a multi-line comment or template is not counted; code after them is', async () => {
  const source = [
    '/*',
    '} catch {',
    '*/',
    'const t = `first line',
    '} catch {',
    '${value} } catch { and ${`nested ${x} catch {`} } catch {',
    '`;',
    "const r = /['\"`]/g; const s = 'a /* b';",
    'try {} catch {',
    '}',
  ].join('\n');
  await withTree({ 'src/a.ts': `${source}\n` }, {}, async (root) => {
    const run = check(root);
    assert.equal(run.code, 1);
    const catches = run.stderr.split('\n').filter((line) => line.includes('a catch without a binding'));
    assert.deepEqual(catches, ['check-code: src/a.ts:9: a catch without a binding drops the error: say on its line why any failure is fine, catch { // <why>']);
  });
});

test('check-code: a ticket on a later line of a block comment fails; one in a multi-line template passes', async () => {
  await withTree({ 'src/a.ts': '/*\n  since SF-8\n*/\nconst t = `\n// SF-9\n`;\n' }, {}, async (root) => {
    const run = check(root);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /src\/a\.ts:2: a comment cites SF-8/);
    assert.doesNotMatch(run.stderr, /SF-9/);
  });
});

test('check-code: a file that ends inside a template or a comment fails, as its comments cannot be checked', async () => {
  await withTree({ 'src/a.ts': 'const t = `open\n', 'src/b.ts': '/* open\n' }, {}, async (root) => {
    const run = check(root);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /src\/a\.ts: ends inside a string, a template or a comment/);
    assert.match(run.stderr, /src\/b\.ts: ends inside a string, a template or a comment/);
  });
});
