// npm run build, scripts/build.mjs run on temporary package trees with the checkout's TypeScript:
// it compiles into dist.next/ and swaps it in for dist/ only when both tsc runs passed, so a failed
// build keeps the working dist/, and it heals what an interrupted build left behind.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The tests run from dist/test; the script is that of the checkout.
const SCRIPT = fileURLToPath(new URL('../../scripts/build.mjs', import.meta.url));

const OPTIONS = { target: 'es2023', module: 'nodenext', strict: true, types: [], skipLibCheck: true };
const PACKAGE: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { ...OPTIONS, rootDir: '.', outDir: 'dist' }, include: ['src'] }),
  'tsconfig.web.json': JSON.stringify({ compilerOptions: { ...OPTIONS, module: 'preserve', rootDir: 'web', outDir: 'dist/web' }, include: ['web'] }),
  'src/main.ts': 'export const answer: number = 42;\n',
  'web/page.ts': 'export const title: string = "page";\n',
};
const OLD_DIST: Record<string, string> = { 'dist/src/main.js': 'old main\n', 'dist/src/deleted.js': 'old only\n', 'dist/web/page.js': 'old page\n' };
const TYPE_ERROR = { 'src/main.ts': 'export const answer: number = "not a number";\n' };

type Run = { code: number | null; output: string };

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
}

// Every file under dir, as a map of its path relative to dir to its content.
async function snapshot(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries.filter((item) => item.isFile())) {
    const path = join(entry.parentPath, entry.name);
    files[relative(dir, path).split('\\').join('/')] = await readFile(path, 'utf8');
  }
  return files;
}

function build(root: string, ...args: string[]): Run {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

async function withPackage(files: Record<string, string>, body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'sf-build-'));
  try {
    await write(root, { ...PACKAGE, ...files });
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertNoLeftovers(root: string): void {
  assert.equal(existsSync(join(root, 'dist.next')), false, 'dist.next/ is left');
  assert.equal(existsSync(join(root, 'dist.prev')), false, 'dist.prev/ is left');
}

async function assertNewDist(root: string): Promise<void> {
  const dist = await snapshot(join(root, 'dist'));
  assert.deepEqual(Object.keys(dist).sort(), ['src/main.js', 'web/page.js']);
  assert.match(dist['src/main.js'] ?? '', /answer = 42/);
  assert.match(dist['web/page.js'] ?? '', /title = "page"/);
}

test('build: a passing build replaces dist/ with only the current output and leaves no dist.next/ or dist.prev/', async () => {
  await withPackage(OLD_DIST, async (root) => {
    const run = build(root);
    assert.equal(run.code, 0, run.output);
    await assertNewDist(root);
    assertNoLeftovers(root);
  });
});

test('build: a passing build without a dist/ creates it', async () => {
  await withPackage({}, async (root) => {
    const run = build(root);
    assert.equal(run.code, 0, run.output);
    await assertNewDist(root);
    assertNoLeftovers(root);
  });
});

test("build: a type error exits non-zero with tsc's output and keeps the old dist/ byte for byte", async () => {
  await withPackage({ ...OLD_DIST, ...TYPE_ERROR }, async (root) => {
    const before = await snapshot(join(root, 'dist'));
    const run = build(root);
    assert.notEqual(run.code, 0);
    assert.match(run.output, /src\/main\.ts/);
    assert.deepEqual(await snapshot(join(root, 'dist')), before);
    assertNoLeftovers(root);
  });
});

test('build: a type error in web/ keeps the old dist/ too', async () => {
  await withPackage({ ...OLD_DIST, 'web/page.ts': 'export const title: string = 1;\n' }, async (root) => {
    const before = await snapshot(join(root, 'dist'));
    const run = build(root);
    assert.notEqual(run.code, 0);
    assert.deepEqual(await snapshot(join(root, 'dist')), before);
    assertNoLeftovers(root);
  });
});

test('build: with dist/, dist.prev/ and dist.next/ all present the new output lands in dist/ and neither leftover stays', async () => {
  const leftovers = { 'dist.prev/src/main.js': 'prev\n', 'dist.next/src/stale.js': 'next\n' };
  await withPackage({ ...OLD_DIST, ...leftovers }, async (root) => {
    const run = build(root);
    assert.equal(run.code, 0, run.output);
    await assertNewDist(root);
    assertNoLeftovers(root);
  });
});

test('build: with dist/ missing and a dist.prev/ left, a failing build brings dist.prev/ back as dist/ and exits non-zero', async () => {
  const prev = { 'dist.prev/src/main.js': 'prev main\n', 'dist.prev/web/page.js': 'prev page\n' };
  await withPackage({ ...prev, 'dist.next/src/stale.js': 'next\n', ...TYPE_ERROR }, async (root) => {
    const run = build(root);
    assert.notEqual(run.code, 0);
    assert.deepEqual(await snapshot(join(root, 'dist')), { 'src/main.js': 'prev main\n', 'web/page.js': 'prev page\n' });
    assertNoLeftovers(root);
  });
});

test('build: an unknown argument or a flag without its value exits 2 and touches nothing', async () => {
  await withPackage(OLD_DIST, async (root) => {
    const before = await snapshot(join(root, 'dist'));
    const unknown = build(root, '--bogus');
    assert.equal(unknown.code, 2);
    assert.match(unknown.output, /unknown argument --bogus/);
    const missing = build(root, '--tsc');
    assert.equal(missing.code, 2);
    assert.match(missing.output, /--tsc needs a value/);
    assert.deepEqual(await snapshot(join(root, 'dist')), before);
  });
});

test('build: --tsc names the tsc to run, and a tsc that cannot run fails the build and keeps dist/', async () => {
  await withPackage(OLD_DIST, async (root) => {
    const before = await snapshot(join(root, 'dist'));
    const run = build(root, '--tsc', join(root, 'no-such-tsc'));
    assert.notEqual(run.code, 0);
    assert.deepEqual(await snapshot(join(root, 'dist')), before);
    assertNoLeftovers(root);
  });
});
