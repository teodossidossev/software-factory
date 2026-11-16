// The reviewers' copy of the Task file (review-task.md in the job directory): the store's read and
// write; the Claude reviews, the gate, the simplification pass and a contest's §section read it,
// never the worktree's file the Implementer rewrites in every iteration; and the factory's copies
// into the worktree's .software-factory/ go through no link the Implementer put there.
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addAttachment, removeAttachment } from '../src/attachments.js';
import { JobStore } from '../src/jobs.js';
import { call, codexLog, codexScript, fakeCodex, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, task, temp, turnsStarted, waitFor } from './support/harness.js';
import { CLEAN, count, FIX, LONG, mrText, nothingRuns, until } from './support/pause.js';

// What the Implementer writes into the worktree's Task file in every iteration.
const REWRITE = '---\nticket: S-1\ntitle: Rewritten\nbase: main\n---\n\n# S-1: Rewritten\n\n## Only in the rewrite\n\nAnything goes.\n';
const GREET_FIX = { verdict: 'fix', summary: 'Unchecked.', items: [{ path: 'src/greet.ts', problem: 'It greets anyone.', expected: 'Check the reader first.', severity: 'major' }], accepted_sensitive: [] };
const NONE = { summary: 'Everything the fixes added is needed.', suggestions: [] };

const block = (text: string, attributes = ''): string => `<task_file path=".software-factory/S-1.md"${attributes}>\n${text.trimEnd()}\n</task_file>`;
const checkoutTask = (repo: string, ticket: string): Promise<string> => readFile(join(repo, '.software-factory', `${ticket}.md`), 'utf8');

// Every entry under dir, by its path relative to dir: a folder as "dir", a file as its content.
async function tree(dir: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name).slice(dir.length + 1);
    entries[path] = entry.isDirectory() ? 'dir' : (await readFile(join(dir, path))).toString('base64');
  }
  return entries;
}

test('readReviewTask: review-task.md, else task.md, else undefined; writeReviewTask writes review-task.md', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-task-'));
  try {
    const jobs = new JobStore(dir);
    await mkdir(jobs.dir('app', 'T-1'), { recursive: true });
    assert.equal(await jobs.readReviewTask('app', 'T-1'), undefined);
    await jobs.writeTaskCopy('app', 'T-1', Buffer.from('given\n'));
    assert.equal(await jobs.readReviewTask('app', 'T-1'), 'given\n');
    await jobs.writeReviewTask('app', 'T-1', Buffer.from('reviewed\n'));
    assert.equal(await jobs.readReviewTask('app', 'T-1'), 'reviewed\n');
    assert.equal(await readFile(join(jobs.dir('app', 'T-1'), 'review-task.md'), 'utf8'), 'reviewed\n');
    assert.equal(await jobs.readTaskCopy('app', 'T-1'), 'given\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('gate off: the Claude reviews and the pass read the factory\'s copy, not the Implementer\'s rewrite; a §section only the rewrite has is no evidence', async () => {
  const env = await newEnv('review-task-claude', { SF_REVIEW: 'on', SF_SIMPLIFY: 'on' });
  const repo = await newRepo(env, 'review-task-claude-repo', false);
  await putTask(env, repo, 'S-1', 'Greet the reader');
  await reviewScript(env, [{ output: GREET_FIX }, { output: CLEAN }, { output: NONE }]);
  await script(env, [
    { write: { 'src/greet.ts': 'export const greet = "hello";\n', '.software-factory/S-1.md': REWRITE }, text: 'Report of iteration 1' },
    { write: { 'src/greet.ts': 'export const greet = "hello reader";\n', '.software-factory/S-1.md': REWRITE }, text: '# Report: S-1, iteration 2\n## Fix 1 items\n| R1 | contested | §Only in the rewrite |\n' },
    { write: { '.software-factory/S-1.mr.md': mrText('feat(S-1): Greet the reader') }, text: 'prepared' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-1' });
    await waitFor(served, 'S-1', 'ready_for_human_review', 2);
    const log = await reviewLog(env);
    assert.equal(log.length, 3);
    const checkout = await checkoutTask(repo, 'S-1');
    assert.match(checkout, /## Fix 1/);
    assert.ok(log[0]!.prompt.includes(block(task('S-1', 'Greet the reader'))), log[0]!.prompt);
    assert.ok(log[1]!.prompt.includes(block(checkout)), log[1]!.prompt);
    assert.ok(log[2]!.prompt.includes(block(task('S-1', 'Greet the reader'), ' fix_sections="cut"')), log[2]!.prompt);
    for (const run of log) {
      assert.ok(!run.prompt.includes('Anything goes.'), run.prompt);
    }
    const jobs = new JobStore(env.state);
    assert.equal(await jobs.readReviewTask('app', 'S-1'), checkout);
    const r1 = (await jobs.readLedger('app', 'S-1')).find((entry) => entry.id === 'R1');
    assert.equal(r1?.status, 'fixed');
    assert.equal(r1?.fixed_by_clean, 2);
  } finally {
    await stop(served);
  }
});

test('gate on: the Claude review and the gate read the factory\'s copy, not the Implementer\'s rewrite', async () => {
  const env = await newEnv('review-task-gate', { SF_REVIEW: 'on', SF_GATE: 'codex', SF_GATE_LEVEL: 'full', SF_CODEX: fakeCodex });
  const repo = await newRepo(env, 'review-task-gate-repo', false);
  await putTask(env, repo, 'S-1', 'Greet the reader');
  await reviewScript(env, [{ output: CLEAN }]);
  await codexScript(env, [{ output: CLEAN }]);
  await script(env, [
    { write: { 'src/greet.ts': 'export const greet = "hello reader";\n', '.software-factory/S-1.md': REWRITE }, text: 'Report of iteration 1' },
    { write: { '.software-factory/S-1.mr.md': mrText('feat(S-1): Greet the reader') }, text: 'prepared' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-1' });
    await waitFor(served, 'S-1', 'ready_for_human_review', 1);
    const expected = block(task('S-1', 'Greet the reader'));
    const prompts = [(await reviewLog(env))[0]!.prompt, (await codexLog(env))[0]!.prompt];
    for (const prompt of prompts) {
      assert.ok(prompt.includes(expected), prompt);
      assert.ok(!prompt.includes('Anything goes.'), prompt);
    }
  } finally {
    await stop(served);
  }
});

// A job paused in its first Claude review, with the Task file changed in the checkout meanwhile;
// before the Resume, link(worktree) puts the Implementer's link in the worktree. Returns the job's
// worktree and the changed Task file once the resumed round decided.
async function resumeReviewWithLink(name: string, link: (worktree: string, outside: string) => Promise<void>): Promise<{ worktree: string; outside: string; changed: string }> {
  const env = await newEnv(name, { SF_REVIEW: 'on' });
  const repo = await newRepo(env, `${name}-repo`, false);
  await putTask(env, repo, 'P-1', 'Review');
  await script(env, [{ write: { 'a.txt': 'a\n' } }, { write: { '.software-factory/P-1.mr.md': mrText('feat(P-1): Review') }, text: 'prepared' }]);
  await reviewScript(env, [{ delayMs: LONG, output: FIX }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    await until('the review to start', async () => (await count(env, 'fake-review')) >= 1);
    assert.equal((await runCli(env, ['pause', 'app', 'P-1'])).code, 0);
    await nothingRuns(env, served);
    const changed = `${task('P-1', 'Review')}\nThe reviewers read this line.\n`;
    await writeFile(join(repo, '.software-factory', 'P-1.md'), changed);
    const worktree = (await new JobStore(env.state).read('app', 'P-1'))!.worktree!;
    const outside = join(temp, `${name}-outside`);
    await link(worktree, outside);
    const resumed = await runCli(env, ['resume', 'app', 'P-1']);
    assert.equal(resumed.code, 0, resumed.stderr);
    await waitFor(served, 'P-1', 'ready_for_human_review', 1);
    return { worktree, outside, changed };
  } finally {
    await stop(served);
  }
}

test('a link at the worktree\'s Task file is replaced, not written through, by the next copy', async () => {
  const { worktree, outside, changed } = await resumeReviewWithLink('review-task-file-link', async (worktree, outside) => {
    await writeFile(outside, 'untouched\n');
    const path = join(worktree, '.software-factory', 'P-1.md');
    await rm(path);
    await symlink(outside, path);
  });
  assert.equal(await readFile(outside, 'utf8'), 'untouched\n');
  const path = join(worktree, '.software-factory', 'P-1.md');
  assert.ok((await lstat(path)).isFile());
  assert.equal(await readFile(path, 'utf8'), changed);
});

test('a link at the worktree\'s .software-factory/ is replaced by a folder, not written through, by the next copy', async () => {
  const { worktree, outside, changed } = await resumeReviewWithLink('review-task-dir-link', async (worktree, outside) => {
    const dir = join(worktree, '.software-factory');
    await rename(dir, outside);
    await writeFile(join(outside, 'P-1.md'), 'untouched\n');
    await symlink(outside, dir);
  });
  assert.equal(await readFile(join(outside, 'P-1.md'), 'utf8'), 'untouched\n');
  const dir = join(worktree, '.software-factory');
  assert.ok((await lstat(dir)).isDirectory());
  assert.equal(await readFile(join(dir, 'P-1.md'), 'utf8'), changed);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const PNG2 = Buffer.concat([PNG, Buffer.from('-second')]);

test('a Resume that brings a changed image writes nothing through a link at the worktree\'s .software-factory/', async () => {
  const env = await newEnv('review-task-images');
  const repo = await newRepo(env, 'review-task-images-repo', false);
  const workspace = { name: 'app', readCheckout: repo, workCheckout: repo };
  const jobs = new JobStore(env.state);
  await putTask(env, repo, 'P-1', 'Images');
  await addAttachment(workspace, 'P-1', PNG, jobs);
  await writeFile(join(repo, '.software-factory', 'P-1.md'), `${task('P-1', 'Images')}\nSee ![the error](P-1/1.png).\n`);
  await script(env, [{ write: { 'a.txt': 'a\n' } }, { delayMs: LONG, write: { 'never.txt': 'x\n' } }, { write: { 'b.txt': 'b\n' }, text: 'Went on.' }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    assert.equal((await runCli(env, ['say', 'app', 'P-1', 'Go', 'on'])).code, 0);
    await turnsStarted(env, 2);
    assert.equal((await runCli(env, ['pause', 'app', 'P-1'])).code, 0);
    await nothingRuns(env, served);

    await removeAttachment(workspace, 'P-1', '1.png', jobs);
    await addAttachment(workspace, 'P-1', PNG2, jobs, '1.png');
    const worktree = (await jobs.read('app', 'P-1'))!.worktree!;
    const dir = join(worktree, '.software-factory');
    const outside = join(temp, 'review-task-images-outside');
    await rename(dir, outside);
    await symlink(outside, dir);
    const before = await tree(outside);
    assert.equal(before[join('P-1', '1.png')], PNG.toString('base64'));

    const resumed = await runCli(env, ['resume', 'app', 'P-1']);
    assert.equal(resumed.code, 0, resumed.stderr);
    await waitFor(served, 'P-1', 'awaiting_review', 2);
    assert.deepEqual(await tree(outside), before);
    assert.ok((await lstat(dir)).isDirectory());
    const image = join(dir, 'P-1', '1.png');
    assert.ok((await lstat(image)).isFile());
    assert.deepEqual(await readFile(image), PNG2);
  } finally {
    await stop(served);
  }
});
