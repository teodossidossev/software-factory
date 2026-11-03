// Unit tests of the sensitive-path rules (SF-024): the glob matcher, the built-in patterns,
// SF_SENSITIVE_PATHS and may_touch, the Report section and the notification lines.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedFilesSection, fileSummaryLines } from '../src/patch.js';
import { globToRegExp, matchesGlob, SENSITIVE_PATHS, sensitivityOf } from '../src/rules.js';
import { mayTouch, parseFrontMatter } from '../src/task-file.js';

test('globToRegExp: * and ? stay inside a segment, ** crosses directories, {a,b} alternates, the rest is literal', () => {
  assert.ok(matchesGlob('package.json', 'package.json'));
  assert.ok(!matchesGlob('src/package.json', 'package.json'));
  assert.ok(matchesGlob('tsconfig.build.json', 'tsconfig*.json'));
  assert.ok(!matchesGlob('src/tsconfig.json', 'tsconfig*.json'));
  assert.ok(matchesGlob('vite.config.ts', '*.config.{js,ts,mjs,cjs}'));
  assert.ok(!matchesGlob('vite.config.json', '*.config.{js,ts,mjs,cjs}'));
  assert.ok(matchesGlob('.github/workflows/ci.yml', '.github/**'));
  assert.ok(matchesGlob('.env', '**/.env*'));
  assert.ok(matchesGlob('apps/web/.env.local', '**/.env*'));
  assert.ok(matchesGlob('config/prod.env', '**/*.env'));
  assert.ok(!matchesGlob('src/environment.ts', '**/.env*'));
  assert.ok(matchesGlob('.editorconfig', '.*'));
  assert.ok(!matchesGlob('src/.editorconfig', '.*'));
  assert.ok(matchesGlob('a?b', 'a?b'));
  assert.ok(!matchesGlob('a/b', 'a?b'));
  assert.equal(globToRegExp('a.b').source, '^a\\.b$');
  assert.equal(globToRegExp('{x').source, '^\\{x$');
});

test('sensitivityOf: the built-in patterns, extra globs, and may_touch as paths or globs', () => {
  for (const path of ['package.json', 'yarn.lock', 'pom.xml', 'build.gradle.kts', 'requirements-dev.txt', 'Pipfile.lock', 'go.sum', 'Cargo.lock', 'Gemfile.lock', 'composer.lock',
    '.env', 'src/.env.production', 'deploy/app.env', '.npmrc', 'tsconfig.json', 'jest.config.js', '.eslintrc.cjs', '.prettierrc', '.editorconfig', '.gitignore', '.gitmodules',
    '.github/dependabot.yml', '.gitlab-ci.yml', 'Jenkinsfile', 'Dockerfile.dev', 'docker-compose.override.yml', 'compose.yml', '.dockerignore', 'Makefile',
    '.idea/workspace.xml', '.vscode/settings.json', '.claude/settings.json', 'CLAUDE.md', 'AGENTS.md', '.tool-versions']) {
    assert.equal(sensitivityOf(path, []), 'undeclared', path);
  }
  for (const path of ['src/app.ts', 'README.md', 'docs/guide.md', 'src/config/app.config.json', 'test/fixtures/package.json.txt', 'src/environment.ts']) {
    assert.equal(sensitivityOf(path, []), 'no', path);
  }
  assert.equal(sensitivityOf('package.json', ['package.json']), 'declared');
  assert.equal(sensitivityOf('.github/workflows/ci.yml', ['.github/**']), 'declared');
  assert.equal(sensitivityOf('.github/workflows/ci.yml', ['package.json']), 'undeclared');
  // Extra globs from SF_SENSITIVE_PATHS; may_touch covers them too.
  assert.equal(sensitivityOf('docs/deps.lock', [], ['docs/*.lock']), 'undeclared');
  assert.equal(sensitivityOf('docs/deps.lock', ['docs/**'], ['docs/*.lock']), 'declared');
  assert.equal(sensitivityOf('src/app.ts', ['src/**']), 'no');
  assert.ok(SENSITIVE_PATHS.includes('package-lock.json'));
});

test('mayTouch reads the front matter list in both forms', () => {
  const fields = (text: string) => parseFrontMatter(`---\nticket: T-1\ntitle: t\nbase: main\n${text}\n---\n`)!;
  assert.deepEqual(mayTouch(fields('may_touch: [package.json, .github/**]')), ['package.json', '.github/**']);
  assert.deepEqual(mayTouch(fields('may_touch: package.json, "docs/*.lock"')), ['package.json', 'docs/*.lock']);
  assert.deepEqual(mayTouch(fields('may_touch:')), []);
  assert.deepEqual(mayTouch(fields('other: x')), []);
});

test('changedFilesSection lists sensitive and deleted paths first; fileSummaryLines names them or says none', () => {
  const files = [{ path: 'src/a.ts', added: 1, removed: 0 }, { path: 'package.json', added: 1, removed: 1 }, { path: 'src/old.ts', added: 0, removed: 3 }];
  const changes = [
    { path: 'src/a.ts', status: 'added' as const, sensitive: 'no' as const, additions: 1, deletions: 0 },
    { path: 'package.json', status: 'modified' as const, sensitive: 'declared' as const, additions: 1, deletions: 1 },
    { path: 'src/old.ts', status: 'deleted' as const, sensitive: 'no' as const, additions: 0, deletions: 3 },
    { path: 'package-lock.json', status: 'deleted' as const, sensitive: 'undeclared' as const, additions: 0, deletions: 9 },
  ];
  const section = changedFilesSection(files, false, changes);
  assert.match(section, /^## Changed files\n\n### Sensitive\n\n- package\.json \(declared\)\n- package-lock\.json \(undeclared, deleted\)\n\n### Deleted\n\n- src\/old\.ts\n- package-lock\.json\n\n\| Path \| Added \| Removed \|\n/);
  assert.equal(changedFilesSection(files, false, []), changedFilesSection(files, false));
  assert.deepEqual(fileSummaryLines(changes), ['sensitive: package.json, package-lock.json (undeclared)', 'deleted: src/old.ts, package-lock.json']);
  assert.deepEqual(fileSummaryLines([]), ['sensitive: none', 'deleted: none']);
});
