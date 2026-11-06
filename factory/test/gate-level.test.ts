// Unit tests of the gate level of an iteration (SF-092, src/gate-level.ts): full, light or none by
// the risk of the job's change, and whether the gate runs at that level.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateDecision, gateLevel, type GateLevelInput, MAX_LIGHT_FILES, MAX_LIGHT_LINES, pathWords, SECURITY_WORDS } from '../src/gate-level.js';
import type { FileChange } from '../src/jobs.js';

const change = (path: string, lines = 10, extra: Partial<FileChange> = {}): FileChange => ({
  path, status: 'modified', sensitive: 'no', scope: 'none', additions: lines, deletions: 0, ...extra,
});

const input = (files: FileChange[] | undefined, extra: Partial<GateLevelInput> = {}): GateLevelInput => ({
  files, patchTruncated: false, mayTouch: [], setting: 'auto', fullPaths: [], sensitivePaths: [], ...extra,
});

test('gateLevel: a docs-only change is none, factory/README.md alone too; a docs change with a CLAUDE.md is full', () => {
  assert.deepEqual(gateLevel(input([change('README.md'), change('docs/design/x.md'), change('docs/images/a.png')])), { level: 'none', reasons: ['docs only'] });
  assert.deepEqual(gateLevel(input([change('factory/README.md')])), { level: 'none', reasons: ['docs only'] });
  assert.deepEqual(gateLevel(input([change('factory/HANDBOOK.md')])), { level: 'none', reasons: ['docs only'] });
  const agents = gateLevel(input([change('README.md'), change('factory/CLAUDE.md')]));
  assert.equal(agents.level, 'full');
  assert.deepEqual(agents.reasons, ['agents: factory/CLAUDE.md']);
  assert.deepEqual(gateLevel(input([change('web/AGENTS.md')])).reasons, ['agents: web/AGENTS.md']);
  // docs/ only at the root.
  assert.equal(gateLevel(input([change('src/docs/x.ts')])).level, 'light');
});

test('gateLevel: a small code change is light', () => {
  assert.deepEqual(gateLevel(input([change('src/app.ts', 30), change('README.md')])), { level: 'light', reasons: ['light: 2 files, 40 lines'] });
  // An empty change is not docs only: light.
  assert.deepEqual(gateLevel(input([])), { level: 'light', reasons: ['light: 0 files, 0 lines'] });
});

test('gateLevel: sensitive, may_touch, security-relevant, SF_GATE_FULL_PATHS, size and unknown changes are full with their reason', () => {
  const full = (files: FileChange[] | undefined, extra: Partial<GateLevelInput> = {}): string[] => {
    const level = gateLevel(input(files, extra));
    assert.equal(level.level, 'full');
    return level.reasons;
  };
  assert.deepEqual(full([change('package.json', 2, { sensitive: 'undeclared' })]), ['sensitive: package.json']);
  assert.deepEqual(full([change('tsconfig.json', 2, { sensitive: 'declared' }), change('README.md')]), ['sensitive: tsconfig.json']);
  // A may_touch path that no sensitive rule names is marked no, but still full; a docs path too.
  assert.deepEqual(full([change('src/app.ts')], { mayTouch: ['src/app.ts'] }), ['may_touch: src/app.ts']);
  assert.deepEqual(full([change('docs/plan.md')], { mayTouch: ['docs/**'] }), ['may_touch: docs/plan.md']);
  assert.deepEqual(full([change('src/session.ts')]), ['security: src/session.ts']);
  assert.deepEqual(full([change('docs/auth.md')]), ['security: docs/auth.md']);
  assert.deepEqual(full([change('lib/billing/pay.ts')], { fullPaths: ['lib/billing/**'] }), ['SF_GATE_FULL_PATHS: lib/billing/pay.ts']);
  assert.deepEqual(full([change('docs/x.md')], { fullPaths: ['docs/x.md'] }), ['SF_GATE_FULL_PATHS: docs/x.md']);
  assert.deepEqual(full([change('src/a.ts', 200), change('src/b.ts', 201)]), [`size: ${MAX_LIGHT_LINES + 1} lines`]);
  assert.deepEqual(full([change('src/a.ts', 200, { deletions: 201 })]), ['size: 401 lines']);
  assert.deepEqual(full(Array.from({ length: MAX_LIGHT_FILES + 1 }, (_, index) => change(`src/f${index}.ts`, 1))), ['size: 13 files']);
  assert.deepEqual(full(undefined), ['unknown: the iteration has no file list']);
  assert.deepEqual(full([change('src/a.ts')], { patchTruncated: true }), ['unknown: the Patch was truncated']);
  assert.deepEqual(full([change('src/a.ts')], { mayTouch: undefined }), ['unknown: the Task file\'s may_touch could not be read']);
  // A rename's old path counts too.
  // A sensitive file renamed away (its mark covers only the new path): sensitive by its old path,
  // by SENSITIVE_PATHS and by SF_SENSITIVE_PATHS.
  assert.deepEqual(full([change('ci/ci.yml', 1, { status: 'renamed', from: '.github/workflows/ci.yml' })]), ['sensitive: .github/workflows/ci.yml']);
  assert.deepEqual(full([change('config/package.json', 1, { status: 'renamed', from: 'package.json' })]), ['sensitive: package.json']);
  assert.deepEqual(full([change('docs/old.md', 1, { status: 'renamed', from: 'vendor/deps.lock' })], { sensitivePaths: ['vendor/*.lock'] }), ['sensitive: vendor/deps.lock']);
  assert.deepEqual(full([change('docs/notes.md', 1, { status: 'renamed', from: 'src/auth.ts' })]), ['security: src/auth.ts']);
  // Each rule that matches is named, the paths of one rule together.
  assert.deepEqual(full([change('package.json', 300, { sensitive: 'undeclared' }), change('src/token.ts', 212)]), ['sensitive: package.json', 'security: src/token.ts', 'size: 512 lines']);
  assert.deepEqual(full(Array.from({ length: 7 }, (_, index) => change(`src/auth/f${index}.ts`, 1))), ['security: src/auth/f0.ts, src/auth/f1.ts, src/auth/f2.ts, src/auth/f3.ts, src/auth/f4.ts and 2 more']);
});

test('gateLevel: SF_GATE_LEVEL=full makes every case full', () => {
  for (const files of [[change('README.md')], [change('src/app.ts')], [change('package.json', 1, { sensitive: 'undeclared' })], undefined]) {
    assert.deepEqual(gateLevel(input(files, { setting: 'full' })), { level: 'full', reasons: ['SF_GATE_LEVEL=full'] });
  }
});

test('pathWords and SECURITY_WORDS: the words of a path, the hits and the misses', () => {
  assert.deepEqual(pathWords('src/authToken.ts'), ['src', 'auth', 'token', 'ts']);
  assert.deepEqual(pathWords('a/JWTSigning_key-x.y'), ['a', 'jwt', 'signing', 'key', 'x', 'y']);
  for (const path of ['src/session.ts', 'src/redact.ts', 'src/sandbox-lock.ts', 'src/authToken.ts']) {
    assert.equal(gateLevel(input([change(path)])).level, 'full', path);
  }
  for (const path of ['docs/design/x.md', 'src/author.ts', 'src/signal.ts', 'src/assign.ts']) {
    assert.notEqual(gateLevel(input([change(path)])).level, 'full', path);
  }
  assert.equal(SECURITY_WORDS.size, 24);
});

test('gateDecision: full runs, none does not, light runs only while the gate asked for no fix; the counts', () => {
  assert.deepEqual(gateDecision(input([change('src/app.ts', 5)]), 0), { level: 'light', reasons: ['light: 1 file, 5 lines'], ran: true, files: 1, lines: 5 });
  assert.deepEqual(gateDecision(input([change('src/app.ts', 5)]), 1), { level: 'light', reasons: ['light: the gate already asked for a fix'], ran: false, files: 1, lines: 5 });
  assert.deepEqual(gateDecision(input([change('README.md', 5)]), 0), { level: 'none', reasons: ['docs only'], ran: false, files: 1, lines: 5 });
  assert.deepEqual(gateDecision(input([change('src/session.ts', 5)]), 3), { level: 'full', reasons: ['security: src/session.ts'], ran: true, files: 1, lines: 5 });
  assert.deepEqual(gateDecision(input(undefined), 0), { level: 'full', reasons: ['unknown: the iteration has no file list'], ran: true, files: null, lines: null });
});
