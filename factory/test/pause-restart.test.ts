// End to end, split from test/pause.test.ts so that no file runs near run-tests' per-file limit:
// Restart (the archive, the branch deleted only when safe, the refusals for a branch with commits
// and a pushed one, --keep-files) and the coding rules of a Resume that opens a new session and of
// a Restart (SF-059). Pause and Resume themselves are test/pause.test.ts's; the shared helpers are
// test/support/pause.ts's.
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { firstPrompt } from '../src/execution.js';
import { taskSha256 } from '../src/task-file.js';
import { call, fakeLog, git, newEnv, newRepo, putRules, putTask, runCli, script, serve, stop, task, turnsStarted, waitFor, jobPrompt } from './support/harness.js';
import { exists, LONG, worktreeOf } from './support/pause.js';

test('Restart: a new job from the current Task file on a fresh branch; the old job archived and its branch deleted; --keep-files copies the old files in', async () => {
  const env = await newEnv('restart');
  const repo = await newRepo(env, 'restart-repo', false);
  await putTask(env, repo, 'R-1', 'Old title');
  await script(env, [
    { write: { 'a.txt': 'a\n', 'README.md': 'changed\n', 'dir/b.txt': 'b\n' }, run: [['rm', '.gitignore']] },
    { write: { 'c.txt': 'c\n' } },
    { write: { 'd.txt': 'd\n' } },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-1' });
    await waitFor(served, 'R-1', 'awaiting_review', 1);
    // Refused while the job runs or waits for review.
    const early = await runCli(env, ['restart', 'app', 'R-1']);
    assert.equal(early.code, 1);
    assert.match(early.stderr, /^sf: sf restart needs paused, waiting_limit, aborted, failed or needs_human; the job is awaiting_review\./);
    assert.equal((await runCli(env, ['abort', 'app', 'R-1'])).code, 0);
    await putTask(env, repo, 'R-1', 'New title');

    // --keep-files: the old worktree's changed and new files go into the new one before its first turn.
    const restarted = await runCli(env, ['restart', 'app', 'R-1', '--keep-files']);
    assert.equal(restarted.code, 0, restarted.stderr);
    assert.match(restarted.stdout, /^branch: R-1-new-title\nstate: working\n/);
    assert.match(restarted.stdout, /^branch_deleted: R-1-old-title$/m);
    assert.match(restarted.stdout, /^kept: \["README\.md","a\.txt","dir\/b\.txt"\]$/m);
    assert.match(restarted.stdout, /The old job is archived and its branch deleted/);
    await waitFor(served, 'R-1', 'awaiting_review', 1);
    assert.equal(git(repo, 'branch', '--list', 'R-1-old-title').trim(), '');
    assert.notEqual(git(repo, 'branch', '--list', 'R-1-new-title').trim(), '');
    const archived = (await readdir(join(env.state, 'jobs', 'app'))).filter((name) => name.startsWith('R-1.'));
    assert.equal(archived.length, 1);
    const jobs = new JobStore(env.state);
    const job = (await jobs.read('app', 'R-1'))!;
    assert.deepEqual([job.branch, job.iteration, job.task_sha256], ['R-1-new-title', 1, taskSha256(task('R-1', 'New title'))]);
    const worktree = worktreeOf(env, 'R-1');
    assert.equal(await readFile(join(worktree, 'a.txt'), 'utf8'), 'a\n');
    assert.equal(await readFile(join(worktree, 'README.md'), 'utf8'), 'changed\n');
    assert.equal(await readFile(join(worktree, 'dir', 'b.txt'), 'utf8'), 'b\n');
    // A deleted file is not carried over: .gitignore is there again.
    assert.equal(await exists(join(worktree, '.gitignore')), true);
    const first = (await fakeLog(env)).at(-1)!;
    assert.match(first.prompt, /^\/implement \.software-factory\/R-1\.md\n\nThis job restarts an earlier job of R-1\. The files that job had changed or added were copied into this worktree before this turn, uncommitted: README\.md, a\.txt, dir\/b\.txt\./);
    assert.match((await readFile(join(env.state, 'jobs', 'app', archived[0]!, 'job.json'), 'utf8')), /"state": "aborted"/);
    assert.equal((await readdir(join(env.state, 'tmp'))).length, 0);

    // A plain Restart of a paused job: nothing kept, the first prompt as at Start.
    assert.equal((await runCli(env, ['pause', 'app', 'R-1'])).code, 0);
    const plain = await runCli(env, ['restart', 'app', 'R-1']);
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /^kept: \[\]$/m);
    await waitFor(served, 'R-1', 'awaiting_review', 1);
    assert.match((await fakeLog(env)).at(-1)!.prompt, /^\/implement \.software-factory\/R-1\.md\n\nRules from the Software Factory:/);
    assert.equal(await exists(join(worktreeOf(env, 'R-1'), 'a.txt')), false);
  } finally {
    await stop(served);
  }
});

test('coding rules (SF-059): a Resume that opens a new session gives the <rules> block first (the first prompt without a message), a Restart gives it in its first prompt', async () => {
  const env = await newEnv('pause-rules');
  const repo = await newRepo(env, 'pause-rules-repo', false);
  const block = await putRules(env, repo);
  await putTask(env, repo, 'P-1', 'With a message');
  await putTask(env, repo, 'P-2', 'Without a message');
  await script(env, [{ delayMs: LONG }, { write: { 'a.txt': 'a\n' } }, { delayMs: LONG }, { write: { 'b.txt': 'b\n' } }, { write: { 'c.txt': 'c\n' } }]);
  const served = await serve(env);
  try {
    // The first turns never report a session: each Resume opens a new one.
    await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
    await turnsStarted(env, 1);
    assert.equal((await runCli(env, ['pause', 'app', 'P-1'])).code, 0);
    assert.equal((await runCli(env, ['resume', 'app', 'P-1', 'go', 'on'])).code, 0);
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    assert.equal((await fakeLog(env)).at(-1)!.prompt, await jobPrompt(env, `${block}\n\ngo on`, 'P-1', 1));

    await call(served, 'start', { workspace: 'app', ticket: 'P-2' });
    await turnsStarted(env, 3);
    assert.equal((await runCli(env, ['pause', 'app', 'P-2'])).code, 0);
    assert.equal((await runCli(env, ['resume', 'app', 'P-2'])).code, 0);
    await waitFor(served, 'P-2', 'awaiting_review', 1);
    const log = await fakeLog(env);
    assert.equal(log.at(-1)!.prompt, await jobPrompt(env, firstPrompt('P-2', [], block), 'P-2', 1));
    assert.ok(log.at(-1)!.prompt.startsWith(`/implement .software-factory/P-2.md\n\n${block}\n\nRules from the Software Factory:`));

    // Restart collects the rules again, at the new job's base commit.
    assert.equal((await runCli(env, ['abort', 'app', 'P-2'])).code, 0);
    await writeFile(join(env.config, 'rules', 'global.md'), 'Global rule.\n');
    assert.equal((await runCli(env, ['restart', 'app', 'P-2'])).code, 0);
    await waitFor(served, 'P-2', 'awaiting_review', 1);
    const restarted = (await fakeLog(env)).at(-1)!.prompt;
    assert.ok(restarted.startsWith(`/implement .software-factory/P-2.md\n\n${block.replace('</rules>', '\n### global: rules/global.md\n\nGlobal rule.\n</rules>')}\n\nRules from the Software Factory:`), restarted);
  } finally {
    await stop(served);
  }
});

test('Restart never deletes a branch with commits or a pushed branch: refused with the reason, nothing changed', async () => {
  const env = await newEnv('restart-refused');
  const repo = await newRepo(env, 'restart-refused-repo', true);
  await putTask(env, repo, 'R-1', 'Committed');
  await putTask(env, repo, 'R-2', 'Pushed');
  await script(env, [{ write: { 'a.txt': 'a\n' } }, { write: { 'b.txt': 'b\n' } }]);
  const served = await serve(env);
  try {
    for (const ticket of ['R-1', 'R-2']) {
      await call(served, 'start', { workspace: 'app', ticket });
      await waitFor(served, ticket, 'awaiting_review', 1);
      assert.equal((await runCli(env, ['abort', 'app', ticket])).code, 0);
    }
    // R-1: a commit on the branch.
    git(worktreeOf(env, 'R-1'), 'add', 'a.txt');
    git(worktreeOf(env, 'R-1'), 'commit', '-q', '-m', 'by hand');
    const committed = await runCli(env, ['restart', 'app', 'R-1']);
    assert.equal(committed.code, 1);
    assert.match(committed.stderr, /^sf: The restart was refused: the branch R-1-committed has 1 commit\(s\) beyond the base; push or delete it by hand first\. Nothing was changed\./);
    // R-2: pushed without a commit; then with its remote-tracking branch gone, origin still has it.
    git(repo, 'push', '-q', 'origin', 'R-2-pushed');
    const pushed = await runCli(env, ['restart', 'app', 'R-2']);
    assert.equal(pushed.code, 1);
    assert.match(pushed.stderr, /^sf: .*the branch R-2-pushed was pushed \(origin\/R-2-pushed\)/);
    git(repo, 'update-ref', '-d', 'refs/remotes/origin/R-2-pushed');
    const onOrigin = await runCli(env, ['restart', 'app', 'R-2']);
    assert.equal(onOrigin.code, 1);
    assert.match(onOrigin.stderr, /^sf: .*the branch R-2-pushed is on the remote origin: it was pushed/);
    // Gone from origin, pushed to another remote without an upstream and without its tracking branch.
    git(repo, 'push', '-q', 'origin', '--delete', 'R-2-pushed');
    const backup = join(env.home, 'backup.git');
    git(env.home, 'init', '-q', '--bare', backup);
    git(repo, 'remote', 'add', 'backup', backup);
    git(repo, 'push', '-q', 'backup', 'R-2-pushed');
    git(repo, 'update-ref', '-d', 'refs/remotes/backup/R-2-pushed');
    const onBackup = await runCli(env, ['restart', 'app', 'R-2']);
    assert.equal(onBackup.code, 1);
    assert.match(onBackup.stderr, /^sf: .*the branch R-2-pushed is on the remote backup: it was pushed/);
    // R-2's branch also checked out in a worktree of its own: the job's worktree goes, then the
    // branch delete fails; the job stays, and the files kept from the gone worktree stay too.
    await putTask(env, repo, 'R-3', 'Held');
    await script(env, [{ write: { 'c.txt': 'c\n' } }]);
    await call(served, 'start', { workspace: 'app', ticket: 'R-3' });
    await waitFor(served, 'R-3', 'awaiting_review', 1);
    assert.equal((await runCli(env, ['abort', 'app', 'R-3'])).code, 0);
    const holder = join(env.home, 'holder');
    git(repo, 'worktree', 'add', '-q', '--force', holder, 'R-3-held');
    const held = await runCli(env, ['restart', 'app', 'R-3', '--keep-files']);
    assert.equal(held.code, 1);
    const kept = /The files kept from the old worktree are in (\S+)\.\n/.exec(held.stderr);
    assert.match(held.stderr, /^sf: git branch -D R-3-held failed: .* The old worktree was removed; the branch and the job \(aborted\) are as they were\. The files kept/);
    assert.ok(kept !== null, held.stderr);
    assert.equal(await readFile(join(kept[1]!, 'c.txt'), 'utf8'), 'c\n');
    assert.equal((await new JobStore(env.state).read('app', 'R-3'))!.state, 'aborted');
    assert.equal(await exists(worktreeOf(env, 'R-3')), false);
    for (const [ticket, branch] of [['R-1', 'R-1-committed'], ['R-2', 'R-2-pushed']]) {
      const job = (await new JobStore(env.state).read('app', ticket!))!;
      assert.equal(job.state, 'aborted');
      assert.notEqual(git(repo, 'branch', '--list', branch!).trim(), '');
      assert.equal(await exists(worktreeOf(env, ticket!)), true);
      assert.equal((await readdir(join(env.state, 'jobs', 'app'))).filter((name) => name.startsWith(`${ticket}.`)).length, 0);
    }
  } finally {
    await stop(served);
  }
});
