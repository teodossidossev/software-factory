// What is committed is what the reviewers saw: commitAndRebase commits a staged tree only when it
// is the reviewed iteration's commit_tree; otherwise nothing is committed (unit tests on a real
// repository), the note and the sf watch line of the unreviewed change, and end to end with the real
// sf serve and the fake Claude: every iteration records commit_tree, a file the MR text turn or the
// workspace's test command writes after the review sends the job back to review, and the next Clean
// commits it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { worktreeTree } from '../src/guard.js';
import { commitAndRebase, unreviewedNote } from '../src/mr.js';
import { saveRegistry } from '../src/registry.js';
import { describeEvent, formatEvent } from '../src/watch.js';
import { call, type Env, git, newEnv, newRepo, putTask, script, serve, stop, waitFor } from './support/harness.js';

// The lines print local time; UTC keeps the stored and the printed time alike.
process.env.TZ = 'UTC';

const TITLE = 'feat(T-1): Change the README';

function mrText(): string {
  return [
    TITLE, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'Not checked: nothing to run.', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

// A repository with a base commit (keep.txt), its own identity and no signing.
async function withRepo(run: (repo: string, sh: (...args: string[]) => string, base: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sf-unreviewed-')));
  try {
    const repo = join(dir, 'repo');
    const sh = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false']]) {
      sh('config', key!, value!);
    }
    await writeFile(join(repo, 'keep.txt'), 'keep\n');
    sh('add', '.');
    sh('commit', '-q', '-m', 'base');
    await run(repo, sh, sh('rev-parse', 'HEAD'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const nothingStaged = (repo: string): number | null => spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: repo }).status;

test('UC-1: commitAndRebase with the reviewed tree commits as before; .software-factory/ written after the tree changes nothing', async () => {
  await withRepo(async (repo, sh, base) => {
    await writeFile(join(repo, 'keep.txt'), 'keep, reviewed\n');
    await writeFile(join(repo, 'new.txt'), 'new\n');
    const reviewedTree = await worktreeTree(repo, base);
    await mkdir(join(repo, '.software-factory'));
    await writeFile(join(repo, '.software-factory', 'T-1.mr.md'), mrText());
    await writeFile(join(repo, '.software-factory', 'T-1.steps.md'), '- [x] step\n');
    assert.deepEqual(await commitAndRebase(repo, { baseCommit: base, targetCommit: base, mrText: mrText(), reviewedTree }), { kind: 'ready' });
    assert.equal(sh('rev-parse', 'HEAD~1'), base);
    assert.equal(sh('rev-parse', 'HEAD^{tree}'), reviewedTree);
    assert.equal(sh('show', '--name-only', '--format=', 'HEAD'), 'keep.txt\nnew.txt');
  });
});

test('UC-2: a staged tree that differs is not committed: the differing paths, sorted; HEAD at the base, nothing staged, the working tree as it was', async () => {
  await withRepo(async (repo, sh, base) => {
    await writeFile(join(repo, 'new.txt'), 'new\n');
    const reviewedTree = await worktreeTree(repo, base);
    await writeFile(join(repo, 'keep.txt'), 'keep, changed after the review\n');
    await writeFile(join(repo, 'late.txt'), 'late\n');
    assert.deepEqual(await commitAndRebase(repo, { baseCommit: base, targetCommit: base, mrText: mrText(), reviewedTree }), { kind: 'unreviewed', paths: ['keep.txt', 'late.txt'] });
    assert.equal(sh('rev-parse', 'HEAD'), base);
    assert.equal(nothingStaged(repo), 0);
    assert.equal(await readFile(join(repo, 'keep.txt'), 'utf8'), 'keep, changed after the review\n');
    assert.equal(await readFile(join(repo, 'late.txt'), 'utf8'), 'late\n');
    assert.equal(await readFile(join(repo, 'new.txt'), 'utf8'), 'new\n');
  });
});

test('UC-3: a reviewed tree the repository does not have gives paths null; without reviewedTree the commit is made as before', async () => {
  await withRepo(async (repo, sh, base) => {
    await writeFile(join(repo, 'keep.txt'), 'keep, changed\n');
    assert.deepEqual(await commitAndRebase(repo, { baseCommit: base, targetCommit: base, mrText: mrText(), reviewedTree: 'a'.repeat(40) }), { kind: 'unreviewed', paths: null });
    assert.equal(sh('rev-parse', 'HEAD'), base);
    assert.equal(nothingStaged(repo), 0);
    await writeFile(join(repo, 'other.txt'), 'other\n');
    assert.deepEqual(await commitAndRebase(repo, { baseCommit: base, targetCommit: base, mrText: mrText() }), { kind: 'ready' });
    assert.equal(sh('rev-parse', 'HEAD~1'), base);
    assert.equal(sh('show', '--name-only', '--format=', 'HEAD'), 'keep.txt\nother.txt');
  });
});

test('UC-4: the note of the unreviewed change and its sf watch line', () => {
  assert.equal(unreviewedNote(1, ['src/extra.ts']), [
    '## MR preparation',
    '',
    'Nothing was committed: the worktree no longer matches iteration 1, the iteration that was reviewed. Changed since then: src/extra.ts. This iteration is the worktree as it is now.',
  ].join('\n'));
  const many = Array.from({ length: 52 }, (_, index) => `f${String(index).padStart(2, '0')}.txt`);
  assert.equal(
    unreviewedNote(3, many).split('\n')[2],
    `Nothing was committed: the worktree no longer matches iteration 3, the iteration that was reviewed. Changed since then: ${many.slice(0, 50).join(', ')} and 2 more. This iteration is the worktree as it is now.`,
  );
  assert.equal(
    unreviewedNote(2, null).split('\n')[2],
    'Nothing was committed: the worktree no longer matches iteration 2, the iteration that was reviewed. Changed since then: not known (the tree recorded for iteration 2 cannot be read). This iteration is the worktree as it is now.',
  );
  const line = (fields: Record<string, unknown>): string[] => formatEvent(JSON.stringify({ ts: '2026-11-04T10:11:12.000Z', iteration: 1, type: 'unreviewed_change', ...fields }));
  assert.deepEqual(line({ paths: ['src/extra.ts'], more: 0 }), ['10:11:12 [1] nothing committed: src/extra.ts changed since iteration 1 was reviewed; back to review']);
  assert.deepEqual(line({ paths: ['a.ts', 'b.ts'], more: 2 }), ['10:11:12 [1] nothing committed: a.ts, b.ts and 2 more changed since iteration 1 was reviewed; back to review']);
  assert.deepEqual(line({ paths: null, more: 0 }), ['10:11:12 [1] nothing committed: the worktree changed since iteration 1 was reviewed; back to review']);
});

const jobDir = (env: Env): string => join(env.state, 'jobs', 'app', 'T-1');
const meta = async (env: Env, iteration: number): Promise<Record<string, any>> => JSON.parse(await readFile(join(jobDir(env), 'iterations', String(iteration).padStart(3, '0'), 'meta.json'), 'utf8'));
const testsRecord = async (env: Env, iteration: number): Promise<Record<string, any>> => JSON.parse(await readFile(join(jobDir(env), `tests-${iteration}.json`), 'utf8'));
const eventLines = async (env: Env): Promise<string[]> => (await readFile(join(jobDir(env), 'events.jsonl'), 'utf8')).trim().split('\n');
const unreviewedEvents = async (env: Env): Promise<Array<Record<string, any>>> =>
  (await eventLines(env)).map((line) => JSON.parse(line) as Record<string, any>).filter((event) => event.type === 'unreviewed_change');

test('UC-5, UC-6: a file the MR text turn writes is not committed; the job goes back to review, and the next Clean commits it with that iteration\'s commit_tree', async () => {
  const env = await newEnv('unreviewed-mr-turn');
  const repo = await newRepo(env, 'unreviewed-mr-turn-repo', true);
  await putTask(env, repo, 'T-1', 'Change README');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'iteration 1' },
    { write: { '.software-factory/T-1.mr.md': mrText(), 'src/extra.ts': 'export const extra = 1;\n' }, text: 'prepared, with an extra file' },
    { write: { '.software-factory/T-1.mr.md': mrText() }, text: 'prepared' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    const back = await waitFor(served, 'T-1', 'awaiting_review', 2);
    const events = await unreviewedEvents(env);
    assert.deepEqual(events.map(({ iteration, paths, more }) => ({ iteration, paths, more })), [{ iteration: 1, paths: ['src/extra.ts'], more: 0 }]);
    const raw = (await eventLines(env)).find((line) => line.includes('"unreviewed_change"'))!;
    assert.match(describeEvent(raw)!.lines[0]!, /^\d\d:\d\d:\d\d \[1\] nothing committed: src\/extra\.ts changed since iteration 1 was reviewed; back to review$/);
    const report = await readFile(join(jobDir(env), 'iterations', '002', 'report.md'), 'utf8');
    assert.ok(report.includes(unreviewedNote(1, ['src/extra.ts'])), report);
    // Nothing on the branch beyond its base; the worktree as it was, nothing staged.
    assert.equal(git(repo, 'rev-list', '--count', `origin/main..${back.branch}`), '0\n');
    const worktree = join(env.state, 'worktrees', 'app', 'T-1');
    assert.deepEqual(git(worktree, 'status', '--porcelain', '--untracked-files=all').split('\n').filter((line) => line !== '').sort(), [' M README.md', '?? src/extra.ts']);
    assert.equal(nothingStaged(worktree), 0);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    const ready = await waitFor(served, 'T-1', 'ready_for_human_review', 2);
    assert.equal(git(repo, 'show', '--name-only', '--format=', ready.branch).trim(), 'README.md\nsrc/extra.ts');
    const [first, second] = [(await meta(env, 1)).commit_tree, (await meta(env, 2)).commit_tree];
    assert.match(first, /^[0-9a-f]{40,64}$/);
    assert.match(second, /^[0-9a-f]{40,64}$/);
    assert.notEqual(first, second);
    assert.equal(git(repo, 'rev-parse', `${ready.branch}^{tree}`).trim(), second);
    assert.equal((await unreviewedEvents(env)).length, 1);
  } finally {
    await stop(served);
  }
});

test('UC-7: a file the workspace\'s test command writes is not committed after that run; the next Clean runs it again and commits the file as it left it', async () => {
  const env = await newEnv('unreviewed-tests');
  const repo = await newRepo(env, 'unreviewed-tests-repo', true);
  await saveRegistry({ workspaces: { app: { read_checkout: repo, test_command: "printf 'tested\\n' > README.md" } } }, env.config);
  await putTask(env, repo, 'T-1', 'Change README');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'iteration 1' },
    { write: { '.software-factory/T-1.mr.md': mrText() }, text: 'prepared' },
    { write: { '.software-factory/T-1.mr.md': mrText() }, text: 'prepared again' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 2);
    assert.deepEqual((await unreviewedEvents(env)).map(({ iteration, paths, more }) => ({ iteration, paths, more })), [{ iteration: 1, paths: ['README.md'], more: 0 }]);
    assert.equal((await testsRecord(env, 1)).outcome, 'passed');
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    const ready = await waitFor(served, 'T-1', 'ready_for_human_review', 2);
    assert.equal((await testsRecord(env, 2)).outcome, 'passed');
    assert.equal(git(repo, 'show', `${ready.branch}:README.md`), 'tested\n');
  } finally {
    await stop(served);
  }
});
