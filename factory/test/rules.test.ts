// Unit tests of the sensitive-path rules (SF-024): the glob matcher, the built-in patterns,
// SF_SENSITIVE_PATHS and may_touch, the Report section and the notification lines.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Job } from '../src/jobs.js';
import { jobNotification } from '../src/notify.js';
import { changedFilesSection, fileSummaryLines, notificationLine } from '../src/patch.js';
import { DENIED_TOOLS, globToRegExp, matchesGlob, SENSITIVE_PATHS, scopeOf, sensitivityOf } from '../src/rules.js';
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

test('sensitivityOf: the files an IDE or a tool runs by itself, build files at any depth included', () => {
  const examples: Record<string, string> = {
    '**/build.gradle': 'lib/build.gradle',
    '**/build.gradle.kts': 'app/build.gradle.kts',
    '**/settings.gradle*': 'settings.gradle.kts',
    '**/pom.xml': 'module/pom.xml',
    'buildSrc/**': 'buildSrc/src/main/kotlin/Conventions.kt',
    'gradle/**': 'gradle/wrapper/gradle-wrapper.properties',
    'gradlew*': 'gradlew.bat',
    'mvnw*': 'mvnw',
    '.mvn/**': '.mvn/wrapper/maven-wrapper.properties',
    '.husky/**': '.husky/pre-commit',
    '.githooks/**': '.githooks/pre-push',
    '.codex/**': '.codex/config.toml',
  };
  for (const [glob, path] of Object.entries(examples)) {
    assert.ok(SENSITIVE_PATHS.includes(glob), glob);
    assert.ok(matchesGlob(path, glob), `${glob} ${path}`);
    assert.equal(sensitivityOf(path, []), 'undeclared', path);
  }
  for (const path of ['build.gradle', 'pom.xml', 'a/b/settings.gradle', '.envrc', '.mcp.json']) {
    assert.equal(sensitivityOf(path, []), 'undeclared', path);
  }
  for (const path of ['src/gradlew.txt', 'docs/gradle/notes.md', 'src/pom.xml.md']) {
    assert.equal(sensitivityOf(path, []), 'no', path);
  }
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
    { path: 'src/a.ts', status: 'added' as const, sensitive: 'no' as const, scope: 'none' as const, additions: 1, deletions: 0 },
    { path: 'package.json', status: 'modified' as const, sensitive: 'declared' as const, scope: 'none' as const, additions: 1, deletions: 1 },
    { path: 'src/old.ts', status: 'deleted' as const, sensitive: 'no' as const, scope: 'none' as const, additions: 0, deletions: 3 },
    { path: 'package-lock.json', status: 'deleted' as const, sensitive: 'undeclared' as const, scope: 'none' as const, additions: 0, deletions: 9 },
  ];
  const section = changedFilesSection(files, false, changes);
  assert.match(section, /^## Changed files\n\n### Sensitive\n\n- package\.json \(declared\)\n- package-lock\.json \(undeclared, deleted\)\n\n### Deleted\n\n- src\/old\.ts\n- package-lock\.json\n\n\| Path \| Added \| Removed \|\n/);
  assert.equal(changedFilesSection(files, false, []), changedFilesSection(files, false));
  assert.deepEqual(fileSummaryLines(changes), ['sensitive: package.json, package-lock.json (undeclared)', 'deleted: src/old.ts, package-lock.json']);
  assert.deepEqual(fileSummaryLines([]), ['sensitive: none', 'deleted: none']);
});

test('scopeOf: none without a scope; in when the scope or may_touch names the path (paths or globs); out otherwise (SF-053)', () => {
  assert.equal(scopeOf('src/a.ts', undefined, []), 'none');
  assert.equal(scopeOf('src/a.ts', undefined, ['src/**']), 'none');
  assert.equal(scopeOf('src/a.ts', ['src/a.ts'], []), 'in');
  assert.equal(scopeOf('test/deep/a.test.ts', ['src/a.ts', 'test/**'], []), 'in');
  assert.equal(scopeOf('src/b.ts', ['src/a.ts'], []), 'out');
  assert.equal(scopeOf('package.json', ['src/**'], ['package.json']), 'in');
  assert.equal(scopeOf('.github/workflows/ci.yml', ['src/**'], ['.github/**']), 'in');
  assert.equal(scopeOf('README.md', ['src/*'], ['package.json']), 'out');
});

test("changedFilesSection lists the paths outside the Task's scope under their own heading; fileSummaryLines adds an out of scope line only with a scope (SF-053)", () => {
  const files = [{ path: 'src/a.ts', added: 1, removed: 0 }, { path: 'package.json', added: 1, removed: 1 }, { path: 'docs/x.md', added: 2, removed: 0 }, { path: 'src/old.ts', added: 0, removed: 3 }];
  const changes = [
    { path: 'src/a.ts', status: 'added' as const, sensitive: 'no' as const, scope: 'in' as const, additions: 1, deletions: 0 },
    { path: 'package.json', status: 'modified' as const, sensitive: 'undeclared' as const, scope: 'out' as const, additions: 1, deletions: 1 },
    { path: 'docs/x.md', status: 'added' as const, sensitive: 'no' as const, scope: 'out' as const, additions: 2, deletions: 0 },
    { path: 'src/old.ts', status: 'deleted' as const, sensitive: 'no' as const, scope: 'out' as const, additions: 0, deletions: 3 },
  ];
  assert.match(changedFilesSection(files, false, changes), new RegExp([
    '^## Changed files', '', '### Sensitive', '', '- package\\.json \\(undeclared\\)', '',
    "### Outside the Task's scope", '', '- package\\.json', '- docs/x\\.md', '- src/old\\.ts \\(deleted\\)', '',
    '### Deleted', '', '- src/old\\.ts', '', '\\| Path \\| Added \\| Removed \\|\\n',
  ].join('\\n')));
  assert.deepEqual(fileSummaryLines(changes), ['sensitive: package.json (undeclared)', 'out of scope: package.json, docs/x.md, src/old.ts', 'deleted: src/old.ts']);
  const inScope = changes.map((change) => ({ ...change, scope: 'in' as const }));
  assert.doesNotMatch(changedFilesSection(files, false, inScope), /Outside/);
  assert.deepEqual(fileSummaryLines(inScope), ['sensitive: package.json (undeclared)', 'out of scope: none', 'deleted: src/old.ts']);
  const none = changes.map((change) => ({ ...change, scope: 'none' as const }));
  assert.doesNotMatch(changedFilesSection(files, false, none), /Outside/);
  assert.deepEqual(fileSummaryLines(none), ['sensitive: package.json (undeclared)', 'deleted: src/old.ts']);
});

test("notificationLine puts the marked-path summaries on one line, so a ready or awaiting_review notification keeps the out of scope summary within its three lines (SF-053)", () => {
  const changes = [
    { path: 'package.json', status: 'modified' as const, sensitive: 'undeclared' as const, scope: 'out' as const, additions: 1, deletions: 1 },
    { path: 'notes.txt', status: 'added' as const, sensitive: 'no' as const, scope: 'out' as const, additions: 1, deletions: 0 },
    { path: 'src/old.ts', status: 'deleted' as const, sensitive: 'no' as const, scope: 'in' as const, additions: 0, deletions: 3 },
  ];
  const line = 'sensitive: package.json (undeclared); out of scope: package.json, notes.txt; deleted: src/old.ts';
  assert.equal(notificationLine(changes), line);
  assert.equal(notificationLine([]), 'sensitive: none; deleted: none');
  const job: Job = {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-x', base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 1, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'ready_for_human_review', iteration: 1, session_id: null, created_at: '2026-11-04T10:00:00.000Z',
    updated_at: '2026-11-04T10:00:00.000Z', mr: null,
  };
  assert.equal(jobNotification(job, ['feat(T-1): X', line]).body, `branch: T-1-x\nfeat(T-1): X\n${line}`);
  // Hand-over off (SF-083) is a setting, not news: the title and the files line stay; a refusal is named.
  assert.equal(jobNotification({ ...job, handoff_skipped: { code: 'handoff_off', message: 'T-1: ready; hand-over off for this workspace (handoff "off" in workspaces.json)' } }, ['feat(T-1): X', line]).body, `branch: T-1-x\nfeat(T-1): X\n${line}`);
  assert.equal(jobNotification({ ...job, handoff_skipped: { code: 'checkout_dirty', message: 'T-1: ready, but your checkout has changes' } }, ['feat(T-1): X', line]).body, 'branch: T-1-x\nT-1: ready, but your checkout has changes\nfeat(T-1): X');
  assert.equal(jobNotification({ ...job, state: 'awaiting_review' }, [line]).body, `Report and Patch of iteration 1 are ready for the reviewers\n${line}`);
});

test('DENIED_TOOLS denies the web tools, which the sandbox does not hold (SF-123)', () => {
  assert.ok(DENIED_TOOLS.includes('WebFetch') && DENIED_TOOLS.includes('WebSearch'));
});
