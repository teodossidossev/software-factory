// Unit tests of a quick fix's decision (src/quick-fix.ts): its change since the hand-over goes
// without a review when it is small and away from the gate level's paths and the Task's scope;
// otherwise it goes through the full loop with its reasons. And the read of that change from Git.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { type FileChange, type Job, JobStore } from '../src/jobs.js';
import { type DeltaEntry, markedPaths, type QuickFixInput, quickFixDecision, readDelta, withoutQuickFix } from '../src/quick-fix.js';
import { git, temp } from './support/harness.js';

const entry = (path: string, added = 1, deleted = 0, extra: Partial<DeltaEntry> = {}): DeltaEntry => ({ path, added, deleted, binary: false, submodule: false, ...extra });

const change = (path: string, extra: Partial<FileChange> = {}): FileChange => ({
  path, status: 'modified', sensitive: 'no', scope: 'none', additions: 1, deletions: 0, ...extra,
});

const input = (delta: QuickFixInput['delta'], extra: Partial<QuickFixInput> = {}): QuickFixInput => ({
  delta, files: Array.isArray(delta) ? delta.map((one) => change(one.path)) : [], mayTouch: [], fullPaths: [], sensitivePaths: [], maxLines: 30, maxFiles: 2, ...extra,
});

// The decision's reasons, asserting it is full.
function full(given: QuickFixInput): string[] {
  const decision = quickFixDecision(given);
  assert.equal(decision.quick, false, JSON.stringify(decision));
  return decision.reasons;
}

test('quickFixDecision: one file and 3 lines is quick; an empty change is quick with 0 files and 0 lines', () => {
  assert.deepEqual(quickFixDecision(input([entry('src/app.css', 2, 1)])), { quick: true, files: 1, lines: 3, reasons: [] });
  assert.deepEqual(quickFixDecision(input([])), { quick: true, files: 0, lines: 0, reasons: [] });
});

test('quickFixDecision: 31 lines and 3 files are over the default bound', () => {
  assert.deepEqual(full(input([entry('src/app.css', 20, 11)])), ['size: 31 lines']);
  assert.deepEqual(full(input([entry('a.css'), entry('b.css'), entry('c.css')])), ['size: 3 files']);
  // At the bound: quick.
  assert.equal(quickFixDecision(input([entry('a.css', 15, 15), entry('b.css', 0, 0)])).quick, true);
});

test('quickFixDecision: a binary and a submodule entry are full, each named', () => {
  assert.deepEqual(full(input([entry('logo.png', 0, 0, { binary: true })])), ['binary: logo.png']);
  assert.deepEqual(full(input([entry('vendor/lib', 0, 0, { submodule: true })])), ['submodule: vendor/lib']);
});

test('quickFixDecision: the gate level\'s path rules on the change\'s paths: sensitive, security, agents, may_touch, SF_GATE_FULL_PATHS', () => {
  assert.deepEqual(full(input([entry('package.json')])), ['sensitive: package.json']);
  assert.deepEqual(full(input([entry('src/auth/login.ts')])), ['security: src/auth/login.ts']);
  assert.deepEqual(full(input([entry('web/CLAUDE.md')])), ['agents: web/CLAUDE.md']);
  assert.deepEqual(full(input([entry('src/billing.ts')], { mayTouch: ['src/billing.ts'] })), ['may_touch: src/billing.ts']);
  assert.deepEqual(full(input([entry('lib/pay/x.ts')], { fullPaths: ['lib/pay/**'] })), ['SF_GATE_FULL_PATHS: lib/pay/x.ts']);
  // SF_SENSITIVE_PATHS, and a mark the new iteration gives a path of the change.
  assert.deepEqual(full(input([entry('conf/app.yml')], { sensitivePaths: ['conf/**'] })), ['sensitive: conf/app.yml']);
  assert.deepEqual(full(input([entry('src/x.ts')], { files: [change('src/x.ts', { sensitive: 'declared' })] })), ['sensitive: src/x.ts']);
});

test('quickFixDecision: the rules apply to the change\'s paths only, not to the rest of the iteration', () => {
  const files = [change('src/app.css'), change('package.json', { sensitive: 'undeclared' }), change('extra.txt', { scope: 'out' }), change('src/auth.ts')];
  assert.deepEqual(quickFixDecision(input([entry('src/app.css')], { files })), { quick: true, files: 1, lines: 1, reasons: [] });
});

test('quickFixDecision: a path the new iteration marks outside the scope is full', () => {
  assert.deepEqual(full(input([entry('extra.txt')], { files: [change('extra.txt', { scope: 'out' })] })), ['scope: extra.txt']);
});

test('quickFixDecision: a change or a Task that cannot be read is unknown, and so is an iteration without a file list', () => {
  assert.deepEqual(quickFixDecision(input({ error: 'git diff --raw failed (exit 128)' })), { quick: false, files: 0, lines: 0, reasons: ['unknown: git diff --raw failed (exit 128)'] });
  assert.deepEqual(full(input([entry('a.css')], { mayTouch: undefined })), ['unknown: the Task file\'s may_touch could not be read']);
  assert.deepEqual(full(input([entry('a.css')], { files: undefined })), ['unknown: the iteration has no file list']);
});

test('quickFixDecision: bounds of 5 lines and 1 file apply, every reason in order', () => {
  const bound = { maxLines: 5, maxFiles: 1 };
  assert.equal(quickFixDecision(input([entry('a.css', 3, 2)], bound)).quick, true);
  assert.deepEqual(full(input([entry('a.css', 3, 3)], bound)), ['size: 6 lines']);
  assert.deepEqual(full(input([entry('a.css'), entry('b.css')], bound)), ['size: 2 files']);
  assert.deepEqual(full(input([entry('package.json', 20, 11), entry('a.png', 0, 0, { binary: true })])), ['size: 31 lines', 'binary: a.png', 'sensitive: package.json']);
});

test('markedPaths: the paths with a sensitive mark or outside the scope', () => {
  assert.deepEqual(markedPaths([change('a.ts'), change('package.json', { sensitive: 'declared' }), change('b.ts', { sensitive: 'undeclared' }), change('c.ts', { scope: 'out' }), change('d.ts', { scope: 'in' })]), ['package.json', 'b.ts', 'c.ts']);
});

test('job.json keeps quick_fix and refuses an invalid one; withoutQuickFix drops it', async () => {
  const jobs = new JobStore(await mkdtemp(join(temp, 'quick-fix-state-')));
  const at = '2026-11-24T10:00:00.000Z';
  const job: Job = {
    workspace: 'app', ticket: 'Q-1', branch: 'Q-1-quick', base: 'main', continues: null, builds_on: null, builds_on_commit: null,
    base_commit: null, state: 'working', worktree: null, prepared_commit: null, iteration: 1, fixes: 0, gate_fixes: 0, gate_tokens: 0,
    session_id: null, mr: null, target_commit: null, mr_attempts: 1, mr_conflict_turn: false, created_at: at, updated_at: at,
  };
  const quick: Job = { ...job, quick_fix: { from: 'handed_over', tree: 'a'.repeat(40), accepted: ['extra.txt'] } };
  await jobs.write(quick);
  assert.deepEqual(await jobs.read('app', 'Q-1'), quick);
  assert.deepEqual(withoutQuickFix(quick), job);
  assert.equal('quick_fix' in withoutQuickFix(quick), false);
  const path = join(jobs.dir('app', 'Q-1'), 'job.json');
  for (const invalid of [{ from: 'needs_human', tree: 'a'.repeat(40), accepted: [] }, { from: 'handed_over', tree: 'HEAD', accepted: [] }, { from: 'handed_over', tree: 'a'.repeat(40) }]) {
    await writeFile(path, `${JSON.stringify({ ...job, quick_fix: invalid }, null, 2)}\n`);
    await assert.rejects(jobs.read('app', 'Q-1'), { code: 'job_invalid' });
  }
});

test('readDelta: counts, a binary file, a deletion, an odd path and a submodule, between two trees; a tree that is not there throws', async () => {
  const repo = await mkdtemp(join(temp, 'quick-fix-'));
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n');
  await writeFile(join(repo, 'gone.txt'), 'x\n');
  git(repo, 'add', '-A');
  const from = git(repo, 'write-tree').trim();
  await writeFile(join(repo, 'a.txt'), 'one\n2\nthree\n');
  git(repo, 'rm', '-q', '-f', 'gone.txt');
  await writeFile(join(repo, 'logo.png'), Buffer.from([0, 1, 2, 0, 255]));
  await writeFile(join(repo, 'tab\there.txt'), 'odd\n');
  git(repo, 'add', '-A');
  // A submodule entry: a gitlink in the index.
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/lib`);
  const to = git(repo, 'write-tree').trim();
  const delta = await readDelta(repo, from, to);
  assert.deepEqual(delta.sort((a, b) => a.path.localeCompare(b.path)), [
    entry('a.txt', 2, 1),
    entry('gone.txt', 0, 1),
    entry('logo.png', 0, 0, { binary: true }),
    entry('tab\there.txt', 1, 0),
    entry('vendor/lib', 0, 0, { submodule: true }),
  ]);
  assert.deepEqual(await readDelta(repo, to, to), []);
  await assert.rejects(readDelta(repo, from, 'b'.repeat(40)), { message: 'git diff --raw failed (exit 128)' });
});
