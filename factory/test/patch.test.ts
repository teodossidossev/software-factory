// Unit tests for the branch slug, the Patch assembly and the changed-file table.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { branchName, slugify } from '../src/execution.js';
import { assemblePatch, buildPatch, changedFiles, changedFilesSection } from '../src/patch.js';

let temp: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

before(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'sf-patch-')));
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

test('slugify lowercases, collapses other characters to "-", trims and keeps 40 characters', () => {
  assert.equal(slugify('Export as CSV!'), 'export-as-csv');
  assert.equal(slugify('  --Ünïcode & Co.--  '), 'n-code-co');
  assert.equal(slugify('a'.repeat(39) + ' b c'), `${'a'.repeat(39)}`);
  assert.equal(slugify('x'.repeat(50)).length, 40);
  assert.equal(slugify('!!!'), '');
  assert.equal(branchName('PROJ-1', 'Implementer session, job lifecycle'), 'PROJ-1-implementer-session-job-lifecycle');
  assert.equal(branchName('PROJ-1', '???'), 'PROJ-1');
});

test('assemblePatch concatenates, keeps valid UTF-8 and cuts after the last whole line', () => {
  assert.deepEqual(assemblePatch([Buffer.from('a\n'), Buffer.from('b\n')], 10), { patch: Buffer.from('a\nb\n'), truncated: false });
  const cut = assemblePatch([Buffer.from('line1\nline2\nline3\n')], 14);
  assert.deepEqual([cut.patch.toString(), cut.truncated], ['line1\nline2\n', true]);
  const invalid = assemblePatch([Buffer.from([0x61, 0xff, 0x0a])]);
  assert.equal(invalid.patch.toString('utf8'), 'a�\n');
});

test('changedFiles counts hunk lines per file and reports submodule pointers', () => {
  const diff = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    '+more',
    ' same',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '--- not a header inside a hunk',
    'diff --git "a/caf\\303\\251 x.md" "b/caf\\303\\251 x.md"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/caf\\303\\251 x.md"',
    '@@ -0,0 +1 @@',
    '+hi',
    'diff --git a/img.png b/img.png',
    'new file mode 100644',
    'Binary files /dev/null and b/img.png differ',
    'diff --git a/vendor/lib b/vendor/lib',
    'index 3333333..4444444 160000',
    '--- a/vendor/lib',
    '+++ b/vendor/lib',
    '@@ -1 +1 @@',
    '-Subproject commit 3333333',
    '+Subproject commit 4444444',
    '',
  ].join('\n');
  const { files, submodules } = changedFiles(diff);
  assert.deepEqual(files, [
    { path: 'src/app.ts', added: 2, removed: 1 },
    { path: 'gone.txt', added: 0, removed: 1 },
    { path: 'café x.md', added: 1, removed: 0 },
    { path: 'img.png', added: 0, removed: 0 },
    { path: 'vendor/lib', added: 1, removed: 1 },
  ]);
  assert.deepEqual(submodules, ['vendor/lib']);
});

test('changedFilesSection renders the table, the warning above 30 files and the truncation note', () => {
  assert.equal(changedFilesSection([], false), '## Changed files\n\nNo changes.');
  const one = changedFilesSection([{ path: 'a|b.md', added: 3, removed: 1 }], false);
  assert.equal(one, '## Changed files\n\n| Path | Added | Removed |\n|---|---|---|\n| a\\|b.md | 3 | 1 |');
  const many = Array.from({ length: 31 }, (_, index) => ({ path: `f${index}`, added: 1, removed: 0 }));
  assert.match(changedFilesSection(many, true), /^## Changed files\n\nWarning: 31 files changed, more than 30\.\n\n\| Path/);
  assert.match(changedFilesSection(many, true), /cut at 2097152 bytes/);
  assert.doesNotMatch(changedFilesSection(many.slice(0, 30), false), /Warning/);
});

test('buildPatch covers tracked and untracked files, skips ignored, forbidden and .software-factory paths, reports submodules', async () => {
  const sub = join(temp, 'sub');
  const repo = join(temp, 'repo');
  await mkdir(sub);
  git(sub, 'init', '-q', '-b', 'main');
  await writeFile(join(sub, 'lib.txt'), 'v1\n');
  git(sub, 'add', '.');
  git(sub, 'commit', '-q', '-m', 'sub');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, '.gitignore'), '*.log\n');
  await writeFile(join(repo, 'README.md'), 'one\ntwo\n');
  await writeFile(join(repo, 'staged.txt'), 'keep\n');
  git(repo, 'submodule', 'add', '-q', sub, 'vendor/sub');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD').trim();

  await writeFile(join(repo, 'README.md'), 'one\n2\n');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'new.ts'), 'export {};\n');
  await writeFile(join(repo, 'debug.log'), 'ignored\n');
  await writeFile(join(repo, '.env'), 'SECRET=1\n');
  await writeFile(join(repo, 'key.pem.key'), 'k\n');
  await mkdir(join(repo, '.software-factory'));
  await writeFile(join(repo, '.software-factory', 'T-1.md'), 'task\n');
  await writeFile(join(repo, 'vendor', 'sub', 'lib.txt'), 'v2\n');
  git(join(repo, 'vendor', 'sub'), 'commit', '-q', '-am', 'v2');
  // A staged change still counts and the index is left as it is.
  await writeFile(join(repo, 'staged.txt'), 'keep\nadded\n');
  git(repo, 'add', 'staged.txt');
  const indexBefore = git(repo, 'diff', '--cached', '--name-only');

  const built = await buildPatch(repo, base);
  const text = built.patch.toString('utf8');
  assert.deepEqual(
    built.files.map((file) => file.path),
    ['README.md', 'staged.txt', 'vendor/sub', 'src/new.ts'],
  );
  assert.deepEqual(built.files[0], { path: 'README.md', added: 1, removed: 1 });
  assert.deepEqual(built.files[3], { path: 'src/new.ts', added: 1, removed: 0 });
  assert.deepEqual(built.submodules, ['vendor/sub']);
  assert.equal(built.truncated, false);
  for (const hidden of ['debug.log', '.env', 'SECRET', 'key.pem.key', '.software-factory']) {
    assert.doesNotMatch(text, new RegExp(hidden.replace('.', '\\.')), hidden);
  }
  assert.equal(git(repo, 'diff', '--cached', '--name-only'), indexBefore);
  assert.equal(git(repo, 'ls-files', '--others', '--exclude-standard').includes('src/new.ts'), true);
});
