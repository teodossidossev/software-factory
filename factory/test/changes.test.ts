// The file versions of a job's iterations (src/changes.ts, SF-079) on real temporary repositories:
// the trees per iteration built from the base and the Patch, the from/to file lists with their
// counts, both sides of a file, binary, too large and unavailable files (a truncated Patch, a base
// not recorded, a missing checkout, a Patch section that is not UTF-8), an iteration after a
// conflict-resolved rebase, and that the workspace repository's objects, index and refs stay as
// they were.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Changes, CHECKOUT_MISSING, cutAt, type ListedFile, noBase, notUtf8 } from '../src/changes.js';
import { type Job, JobStore } from '../src/jobs.js';
import { buildPatch, fileChanges } from '../src/patch.js';
import { loadRegistry, saveRegistry } from '../src/registry.js';
import { git, temp } from './support/harness.js';

const NO_MARKS = () => ({ sensitive: 'no' as const, scope: 'none' as const });

function configure(): string {
  const dir = join(temp, 'changes-config');
  process.env.SF_CONFIG_DIR = dir;
  return dir;
}

async function register(name: string, checkout: string): Promise<void> {
  const dir = configure();
  const registry = await loadRegistry(dir);
  registry.workspaces[name] = { read_checkout: checkout };
  await saveRegistry(registry, dir);
}

// A repository with files on main, registered as the workspace name; its first commit.
async function repoWith(name: string, files: Record<string, string | Buffer>): Promise<{ repo: string; base: string }> {
  const repo = join(temp, `${name}-repo`);
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  await put(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  await register(name, repo);
  return { repo, base: git(repo, 'rev-parse', 'HEAD').trim() };
}

async function put(dir: string, files: Record<string, string | Buffer | null>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(dir, path), { force: true });
    } else {
      await mkdir(join(dir, path, '..'), { recursive: true });
      await writeFile(join(dir, path), content);
    }
  }
}

// A clone of the repository at commit, where the Implementer's edits are made.
function clone(repo: string, name: string, commit: string): string {
  const work = join(temp, name);
  execFileSync('git', ['clone', '-q', repo, work]);
  git(work, 'checkout', '-q', commit);
  return work;
}

function jobOf(workspace: string, extra: Partial<Job> = {}): Job {
  return {
    workspace, ticket: 'T-1', branch: 'T-1-demo', base: 'main', base_commit: null, target_commit: null,
    worktree: null, prepared_commit: null, mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'awaiting_review', iteration: 0, session_id: 's1', mr: null,
    created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:05:00.000Z', ...extra,
  };
}

// Publishes iteration n of the work clone against base as the Execution does; cut, when given,
// replaces the Patch (a truncated one); record: whether meta.json carries base_commit.
async function publish(jobs: JobStore, job: Job, n: number, work: string, base: string, options: { cut?: (patch: string) => string; record?: boolean; files?: boolean } = {}): Promise<void> {
  const built = await buildPatch(work, base);
  const files = await fileChanges(work, base, built.files, NO_MARKS);
  const patch = options.cut === undefined ? built.patch : Buffer.from(options.cut(built.patch.toString('utf8')));
  await jobs.writeIteration(job.workspace, job.ticket, {
    report: `# Report: T-1, iteration ${n}\n`, patch,
    meta: {
      iteration: n, started_at: '2026-11-01T10:00:00.000Z', ended_at: `2026-11-01T10:0${n}:00.000Z`, denials: [], changed_files: built.files,
      ...(options.files === false ? {} : { files }), patch_truncated: options.cut !== undefined || built.truncated, submodule_changed: [],
      cost_usd: null, cost_usd_total: null, duration_ms: null, ...(options.record === false ? {} : { base_commit: base }),
    },
  });
}

// The workspace repository as the read must leave it: its objects, its index and its refs.
async function snapshot(repo: string): Promise<unknown> {
  const objects = (await readdir(join(repo, '.git', 'objects'), { recursive: true })).sort();
  const index = createHash('sha256').update(await readFile(join(repo, '.git', 'index'))).digest('hex');
  return { objects, index, refs: git(repo, 'for-each-ref'), status: git(repo, 'status', '--porcelain'), head: git(repo, 'rev-parse', 'HEAD') };
}

const row = (path: string, status: string, additions: number, deletions: number, extra: Partial<ListedFile> = {}): ListedFile =>
  ({ path, status: status as ListedFile['status'], additions, deletions, binary: false, unavailable: false, ...extra });

const lines = (count: number, prefix: string): string => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';

test('changes: three iterations: trees per iteration, the from/to lists with counts, both sides of a file, binary, too large and a truncated Patch; the workspace repository is untouched', async () => {
  const big = lines(70000, 'a fairly long line of the big file');
  const { repo, base } = await repoWith('app', {
    'a.txt': 'one\ntwo\nthree\n', 'del.txt': 'gone\n', 'img.bin': Buffer.from([0, 1, 2, 3]), 'big.txt': big, 'keep.txt': 'keep\n',
  });
  const jobs = new JobStore(join(temp, 'changes-state'));
  let job = jobOf('app', { base_commit: base });
  await jobs.write(job);
  const work = clone(repo, 'changes-work', base);
  const before = await snapshot(repo);

  // 1: modified, added, deleted, binary and a big file.
  await put(work, { 'a.txt': 'one\nTWO\nthree\n', 'new.txt': 'new\n', 'del.txt': null, 'img.bin': Buffer.from([0, 1, 2, 4]), 'big.txt': big.replace('line of the big file 1\n', 'line of the big file 1, changed\n') });
  await publish(jobs, job, 1, work, base);
  // 2: a.txt again, z1.txt cut inside its hunk by the truncation, z2.txt beyond the cut.
  await put(work, { 'a.txt': 'one\nTWO\nthree\nfour\n', 'z1.txt': lines(60, 'z1'), 'z2.txt': 'z2\n' });
  await publish(jobs, job, 2, work, base, {
    cut: (patch) => {
      const kept = patch.slice(0, patch.indexOf('diff --git a/z2.txt'));
      return kept.slice(0, kept.indexOf('+z1 30\n'));
    },
  });
  // 3: new.txt removed again, the Patch whole.
  await put(work, { 'new.txt': null });
  await publish(jobs, job, 3, work, base);
  job = { ...job, iteration: 3 };
  await jobs.write(job);

  const changes = new Changes(jobs);
  assert.deepEqual(await changes.index(job), {
    base: { ref: 'main', commit: base },
    iterations: [1, 2, 3].map((n) => ({ n, ended_at: `2026-11-01T10:0${n}:00.000Z`, truncated: n === 2, base_commit: base })),
  });

  // All changes after 1, and its parts.
  assert.deepEqual(await changes.files(job, 'base', 1), {
    more: false,
    files: [row('a.txt', 'modified', 1, 1), row('big.txt', 'modified', 1, 1), row('del.txt', 'deleted', 0, 1), row('img.bin', 'modified', 0, 0, { binary: true }), row('new.txt', 'added', 1, 0)],
  });
  assert.deepEqual((await changes.files(job, 'base', 2))!.files, [
    row('a.txt', 'modified', 2, 1), row('big.txt', 'modified', 1, 1), row('del.txt', 'deleted', 0, 1), row('img.bin', 'modified', 0, 0, { binary: true }), row('new.txt', 'added', 1, 0),
    row('z1.txt', 'added', 0, 0, { unavailable: true }), row('z2.txt', 'added', 0, 0, { unavailable: true }),
  ]);
  // Iteration 2: what changed from 1, the cut files unavailable; the binary file did not change.
  assert.deepEqual((await changes.files(job, 1, 2))!.files, [row('a.txt', 'modified', 1, 0), row('z1.txt', 'added', 0, 0, { unavailable: true }), row('z2.txt', 'added', 0, 0, { unavailable: true })]);
  // Iteration 3: new.txt goes; the files cut in 2 are unavailable on that side.
  assert.deepEqual((await changes.files(job, 2, 3))!.files, [row('new.txt', 'deleted', 0, 1), row('z1.txt', 'added', 0, 0, { unavailable: true }), row('z2.txt', 'added', 0, 0, { unavailable: true })]);
  assert.deepEqual((await changes.files(job, 'base', 3))!.files.map((file) => [file.path, file.status, file.additions]), [
    ['a.txt', 'modified', 2], ['big.txt', 'modified', 1], ['del.txt', 'deleted', 0], ['img.bin', 'modified', 0], ['z1.txt', 'added', 60], ['z2.txt', 'added', 1],
  ]);
  // Only the two pairs of a view.
  for (const [from, to] of [[1, 3], [3, 2], [2, 2], ['base', 4], [0, 1]] as const) {
    assert.equal(await changes.files(job, from, to), undefined, `${from}..${to}`);
  }

  // Both sides of a file.
  assert.deepEqual(await changes.file(job, 'base', 1, 'a.txt'), { kind: 'text', text: 'one\ntwo\nthree\n' });
  assert.deepEqual(await changes.file(job, 1, 1, 'a.txt'), { kind: 'text', text: 'one\nTWO\nthree\n' });
  assert.deepEqual(await changes.file(job, 2, 2, 'a.txt'), { kind: 'text', text: 'one\nTWO\nthree\nfour\n' });
  assert.deepEqual(await changes.file(job, 'base', 1, 'new.txt'), { kind: 'absent' });
  assert.deepEqual(await changes.file(job, 1, 1, 'new.txt'), { kind: 'text', text: 'new\n' });
  assert.deepEqual(await changes.file(job, 1, 1, 'del.txt'), { kind: 'absent' });
  assert.deepEqual(await changes.file(job, 'base', 1, 'img.bin'), { kind: 'binary', bytes: 4 });
  assert.deepEqual(await changes.file(job, 1, 1, 'img.bin'), { kind: 'binary', bytes: null });
  assert.deepEqual(await changes.file(job, 1, 1, 'big.txt'), { kind: 'too_large', bytes: big.length + ', changed'.length });
  assert.deepEqual(await changes.file(job, 2, 2, 'z1.txt'), { kind: 'unavailable', reason: cutAt(2) });
  assert.deepEqual(await changes.file(job, 2, 2, 'z2.txt'), { kind: 'unavailable', reason: cutAt(2) });
  // At 3 the files are whole again; z1.txt at 1 (it is in the list of iteration 2) is absent.
  assert.deepEqual(await changes.file(job, 3, 3, 'z1.txt'), { kind: 'text', text: lines(60, 'z1') });
  assert.deepEqual(await changes.file(job, 1, 1, 'z1.txt'), { kind: 'absent' });
  assert.deepEqual(await changes.file(job, 3, 3, 'new.txt'), { kind: 'absent' });
  // The base of the last iteration when of is the last.
  assert.deepEqual(await changes.file(job, 'base', 3, 'z1.txt'), { kind: 'absent' });
  // A path of no list of a view of that side, or not a path at all, is not served.
  for (const [at, of, path] of [[1, 1, 'keep.txt'], ['base', 3, 'new.txt'], ['base', 1, 'keep.txt'], [1, 1, '../a.txt'], [1, 1, './a.txt'], [1, 1, 'a.txt/'], [4, 4, 'a.txt'], ['base', 4, 'a.txt']] as const) {
    assert.equal(await changes.file(job, at, of, path), undefined, `${at} ${of} ${path}`);
  }

  // The trees are cached per iteration; a fresh reader with the objects gone builds them again.
  const trees = await Promise.all([1, 2, 3].map(async (n) => (await readFile(jobs.treePath('app', 'T-1', n), 'utf8')).trim()));
  assert.ok(trees.every((tree) => /^[0-9a-f]{40}$/.test(tree)));
  assert.equal(new Set(trees).size, 3);
  await rm(jobs.objectsDir('app', 'T-1'), { recursive: true });
  assert.deepEqual(await new Changes(jobs).file(job, 2, 2, 'a.txt'), { kind: 'text', text: 'one\nTWO\nthree\nfour\n' });
  assert.equal((await readFile(jobs.treePath('app', 'T-1', 2), 'utf8')).trim(), trees[1]);
  assert.ok((await stat(jobs.objectsDir('app', 'T-1'))).isDirectory());

  // Nothing of the workspace repository changed.
  assert.deepEqual(await snapshot(repo), before);
});

test('changes: after a conflict-resolved rebase the iteration has its own base; between iterations with different bases the upstream changes show, never a .software-factory/ or credential-like file', async () => {
  const { repo, base } = await repoWith('reb', { 'a.txt': 'one\n', 'other.txt': 'other\n' });
  const jobs = new JobStore(join(temp, 'changes-reb-state'));
  const first = clone(repo, 'changes-reb-work1', base);
  await put(first, { 'a.txt': 'one, mine\n' });
  await publish(jobs, jobOf('reb'), 1, first, base);
  // The target moved: an upstream change, a Task file and a credential-like file.
  await put(repo, { 'other.txt': 'other, upstream\n', '.software-factory/T-9.md': 'task\n', '.env': 'SECRET=1\n', 'id_rsa': 'key\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'upstream');
  const upstream = git(repo, 'rev-parse', 'HEAD').trim();
  const second = clone(repo, 'changes-reb-work2', upstream);
  await put(second, { 'a.txt': 'one, mine and upstream\n' });
  await publish(jobs, jobOf('reb'), 2, second, upstream);
  const job = jobOf('reb', { base_commit: upstream, target_commit: upstream, iteration: 2 });
  await jobs.write(job);
  const changes = new Changes(jobs);

  const index = await changes.index(job);
  assert.deepEqual(index.base, { ref: 'main', commit: upstream });
  assert.deepEqual(index.iterations.map((iteration) => iteration.base_commit), [base, upstream]);
  // Iteration 2 against its own base; iteration 1 against its own.
  assert.deepEqual((await changes.files(job, 'base', 2))!.files, [row('a.txt', 'modified', 1, 1)]);
  assert.deepEqual((await changes.files(job, 'base', 1))!.files, [row('a.txt', 'modified', 1, 1)]);
  assert.deepEqual(await changes.file(job, 'base', 2, 'a.txt'), { kind: 'text', text: 'one\n' });
  // Iteration 2 against 1 shows the upstream change too, never the Task or the credential-like files.
  assert.deepEqual((await changes.files(job, 1, 2))!.files, [row('a.txt', 'modified', 1, 1), row('other.txt', 'modified', 1, 1)]);
  assert.deepEqual(await changes.file(job, 2, 2, 'other.txt'), { kind: 'text', text: 'other, upstream\n' });
  for (const path of ['.software-factory/T-9.md', '.env', 'id_rsa']) {
    assert.equal(await changes.file(job, 2, 2, path), undefined, path);
    assert.equal(await changes.file(job, 1, 1, path), undefined, path);
  }
});

test('changes: an iteration published without its base uses the job base before MR preparation, and is unavailable after a rebase', async () => {
  const { repo, base } = await repoWith('old', { 'a.txt': 'one\n' });
  const jobs = new JobStore(join(temp, 'changes-old-state'));
  const work = clone(repo, 'changes-old-work', base);
  await put(work, { 'a.txt': 'two\n' });
  await publish(jobs, jobOf('old'), 1, work, base, { record: false });
  const before = jobOf('old', { base_commit: base, iteration: 1 });
  await jobs.write(before);
  const changes = new Changes(jobs);
  assert.deepEqual((await changes.index(before)).iterations[0]!.base_commit, base);
  assert.deepEqual((await changes.files(before, 'base', 1))!.files, [row('a.txt', 'modified', 1, 1)]);
  assert.deepEqual(await changes.file(before, 1, 1, 'a.txt'), { kind: 'text', text: 'two\n' });

  // MR preparation started: the base may have moved since.
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'moved');
  const target = git(repo, 'rev-parse', 'HEAD').trim();
  for (const after of [jobOf('old', { base_commit: base, target_commit: target, iteration: 1 }), jobOf('old', { base_commit: target, target_commit: target, iteration: 1 })]) {
    assert.deepEqual(await changes.index(after), { base: { ref: 'main', commit: null }, iterations: [{ n: 1, ended_at: '2026-11-01T10:01:00.000Z', truncated: false, base_commit: null }] });
    assert.deepEqual((await changes.files(after, 'base', 1))!.files, [row('a.txt', 'modified', 0, 0, { unavailable: true })]);
    assert.deepEqual(await changes.file(after, 1, 1, 'a.txt'), { kind: 'unavailable', reason: noBase(1) });
    assert.deepEqual(await changes.file(after, 'base', 1, 'a.txt'), { kind: 'unavailable', reason: noBase(1) });
  }
});

test('changes: a missing checkout makes every file unavailable', async () => {
  const { repo, base } = await repoWith('gone', { 'a.txt': 'one\n' });
  const jobs = new JobStore(join(temp, 'changes-gone-state'));
  const work = clone(repo, 'changes-gone-work', base);
  await put(work, { 'a.txt': 'two\n', 'b.txt': 'b\n' });
  await publish(jobs, jobOf('gone'), 1, work, base);
  const job = jobOf('gone', { base_commit: base, iteration: 1 });
  await jobs.write(job);
  await register('gone', join(temp, 'changes-no-such-checkout'));
  const changes = new Changes(jobs);
  assert.deepEqual((await changes.files(job, 'base', 1))!.files, [row('a.txt', 'modified', 0, 0, { unavailable: true }), row('b.txt', 'added', 0, 0, { unavailable: true })]);
  assert.deepEqual(await changes.file(job, 1, 1, 'b.txt'), { kind: 'unavailable', reason: CHECKOUT_MISSING });
  assert.deepEqual(await changes.file(job, 'base', 1, 'a.txt'), { kind: 'unavailable', reason: CHECKOUT_MISSING });
});

test('changes: a Patch section that is not UTF-8 (an added Latin-1 file, a modified one) is left out and unavailable; the other files apply', async () => {
  const { repo, base } = await repoWith('latin', { 'a.txt': 'one\n', 'old.txt': Buffer.from('caf\xe9\n', 'latin1') });
  const jobs = new JobStore(join(temp, 'changes-latin-state'));
  const work = clone(repo, 'changes-latin-work', base);
  await put(work, { 'a.txt': 'two\n', 'old.txt': Buffer.from('caf\xe9s\n', 'latin1'), 'new.txt': Buffer.from('na\xefve\n', 'latin1') });
  await publish(jobs, jobOf('latin'), 1, work, base);
  const job = jobOf('latin', { base_commit: base, iteration: 1 });
  await jobs.write(job);
  const changes = new Changes(jobs);
  assert.deepEqual((await changes.files(job, 'base', 1))!.files, [
    row('a.txt', 'modified', 1, 1), row('new.txt', 'added', 0, 0, { unavailable: true }), row('old.txt', 'modified', 0, 0, { unavailable: true }),
  ]);
  assert.deepEqual(await changes.file(job, 1, 1, 'a.txt'), { kind: 'text', text: 'two\n' });
  assert.deepEqual(await changes.file(job, 1, 1, 'old.txt'), { kind: 'unavailable', reason: notUtf8(1) });
  assert.deepEqual(await changes.file(job, 1, 1, 'new.txt'), { kind: 'unavailable', reason: notUtf8(1) });
  // The base content is not UTF-8 either: binary, never shown as text.
  assert.deepEqual(await changes.file(job, 'base', 1, 'old.txt'), { kind: 'binary', bytes: 5 });
});
