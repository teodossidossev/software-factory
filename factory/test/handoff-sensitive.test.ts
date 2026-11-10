// Unit tests of the check before the automatic hand-over: the paths of the prepared change that
// the sensitive-path rules name, on a temporary repository.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { HANDOFF_SENSITIVE_CODE, handoffSensitive, sensitiveChanges } from '../src/handoff-sensitive.js';
import { git } from './support/harness.js';

let temp: string;
let count = 0;

before(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'sf-handoff-sensitive-')));
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

async function put(repo: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
}

// A repository whose base commit holds the base files; change edits it into the prepared commit.
// Returns the repository and both commits.
async function repoWith(base: Record<string, string>, change: (repo: string) => Promise<void>): Promise<{ repo: string; base: string; prepared: string }> {
  count += 1;
  const repo = join(temp, `repo-${count}`);
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await put(repo, { 'README.md': 'hello\n', ...base });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const baseCommit = git(repo, 'rev-parse', 'HEAD').trim();
  await change(repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'prepared');
  return { repo, base: baseCommit, prepared: git(repo, 'rev-parse', 'HEAD').trim() };
}

test('a change to src/a.ts only: no sensitive paths and no skip', async () => {
  const { repo, base, prepared } = await repoWith({ 'src/a.ts': 'a\n' }, (dir) => put(dir, { 'src/a.ts': 'b\n' }));
  assert.deepEqual(await sensitiveChanges(repo, base, prepared, []), []);
  assert.equal(await handoffSensitive(repo, base, prepared, []), undefined);
});

test('build files, the Gradle wrapper, VS Code tasks and Git hooks, at the root and nested, are each returned', async () => {
  for (const path of ['build.gradle.kts', 'app/build.gradle.kts', 'module/pom.xml', 'gradle/wrapper/gradle-wrapper.properties', '.vscode/tasks.json', '.husky/pre-commit']) {
    const { repo, base, prepared } = await repoWith({}, (dir) => put(dir, { [path]: 'x\n', 'src/a.ts': 'a\n' }));
    assert.deepEqual(await sensitiveChanges(repo, base, prepared, []), [path], path);
  }
});

test('a deleted hook is returned', async () => {
  const { repo, base, prepared } = await repoWith({ '.husky/pre-commit': 'npm test\n' }, (dir) => rm(join(dir, '.husky', 'pre-commit')));
  assert.deepEqual(await sensitiveChanges(repo, base, prepared, []), ['.husky/pre-commit']);
});

test('a rename from .claude/x to docs/x returns the old path', async () => {
  const content = 'a file long enough for Git to see the rename\n'.repeat(5);
  const { repo, base, prepared } = await repoWith({ '.claude/x': content }, async (dir) => {
    await rm(join(dir, '.claude', 'x'));
    await put(dir, { 'docs/x': content });
  });
  assert.deepEqual(await sensitiveChanges(repo, base, prepared, []), ['.claude/x']);
});

test('a rename from docs/x to .vscode/tasks.json returns the new path', async () => {
  const content = 'a file long enough for Git to see the rename\n'.repeat(5);
  const { repo, base, prepared } = await repoWith({ 'docs/x': content }, async (dir) => {
    await rm(join(dir, 'docs', 'x'));
    await put(dir, { '.vscode/tasks.json': content });
  });
  assert.deepEqual(await sensitiveChanges(repo, base, prepared, []), ['.vscode/tasks.json']);
});

test('an SF_SENSITIVE_PATHS glob counts; may_touch plays no part', async () => {
  const { repo, base, prepared } = await repoWith({}, (dir) => put(dir, { 'scripts/run.sh': 'x\n', 'src/a.ts': 'a\n' }));
  assert.deepEqual(await sensitiveChanges(repo, base, prepared, []), []);
  assert.deepEqual(await sensitiveChanges(repo, base, prepared, ['scripts/**']), ['scripts/run.sh']);
});

test('the skip names up to five paths and how many more', async () => {
  const one = await repoWith({}, (dir) => put(dir, { '.vscode/tasks.json': '{}\n' }));
  assert.deepEqual(await handoffSensitive(one.repo, one.base, one.prepared, []), {
    code: HANDOFF_SENSITIVE_CODE,
    message: 'it changes files your IDE or tools may run: .vscode/tasks.json; read them, then hand it over',
  });
  const files = Object.fromEntries(['.husky/a', '.husky/b', '.husky/c', '.husky/d', '.husky/e', '.husky/f', '.husky/g'].map((path) => [path, 'x\n']));
  const seven = await repoWith({}, (dir) => put(dir, files));
  assert.deepEqual(await handoffSensitive(seven.repo, seven.base, seven.prepared, []), {
    code: HANDOFF_SENSITIVE_CODE,
    message: 'it changes files your IDE or tools may run: .husky/a, .husky/b, .husky/c, .husky/d, .husky/e and 2 more; read them, then hand it over',
  });
});

test('a commit that does not exist: the skip says the change\'s files could not be listed', async () => {
  const { repo, base } = await repoWith({}, (dir) => put(dir, { 'src/a.ts': 'a\n' }));
  await assert.rejects(sensitiveChanges(repo, base, '0123456789abcdef0123456789abcdef01234567', []));
  const skip = await handoffSensitive(repo, base, '0123456789abcdef0123456789abcdef01234567', []);
  assert.equal(skip?.code, HANDOFF_SENSITIVE_CODE);
  assert.match(skip!.message, /^could not list the change's files: \S/);
});
