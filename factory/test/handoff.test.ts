// End-to-end tests of the hand-over to the user's checkout (SF-073) on real repositories: a work
// checkout cloned from a bare origin, the job's worktree, the fake Claude Code as the Implementer.
// SF_HANDOFF=checkout here (the harness turns it off for every other test).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Job, JobStore } from '../src/jobs.js';
import { mrMessage } from '../src/mr.js';
import { call, fakeLog, git, newEnv, newRepo, putTask, refused, runCli, script, serve, type Served, stop, temp, turnsStarted, waitFor } from './support/harness.js';

type Env = Awaited<ReturnType<typeof newEnv>>;

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'npm test: passed', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

const mrTurn = (ticket: string, title = 'Hand it over'): Record<string, unknown> => ({ write: { [`.software-factory/${ticket}.mr.md`]: mrText(`feat(${ticket}): ${title}`) }, text: 'MR text' });

const worktreeOf = (env: Env, ticket: string): string => join(env.state, 'worktrees', 'app', ticket);

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// Git's exit code, without throwing.
function gitCode(cwd: string, ...args: string[]): number {
  try {
    git(cwd, ...args);
    return 0;
  } catch (error) {
    return (error as { status: number }).status;
  }
}

const head = (repo: string): string => git(repo, 'symbolic-ref', '-q', 'HEAD').trim();
const rev = (repo: string, name: string): string => git(repo, 'rev-parse', name).trim();
const config = (repo: string, key: string): string | null => {
  try {
    return git(repo, 'config', '--local', '--get', key).trim();
  } catch {
    return null;
  }
};
// The checkout's status without the Task files of the factory.
const status = (repo: string): string => git(repo, 'status', '--porcelain', '--untracked-files=all').replace(/^\?\? \.software-factory\/.*\n/gm, '');
const remoteTip = (origin: string, branch: string): string | undefined => {
  try {
    return execFileSync('git', ['--git-dir', origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
};

interface Setup {
  env: Env;
  repo: string;
  origin: string;
  served: Served;
  jobs: JobStore;
}

// sf serve on a fresh checkout with origin and SF_HANDOFF=checkout (unless extra says otherwise).
async function setup(name: string, extra: Record<string, string> = {}): Promise<Setup> {
  const env = await newEnv(name, { SF_HANDOFF: 'checkout', ...extra });
  const repo = await newRepo(env, `${name}-repo`, true);
  return { env, repo, origin: join(temp, `${name}-repo-origin.git`), served: await serve(env), jobs: new JobStore(env.state) };
}

// Starts the job and takes it through review to Clean; the turns are already scripted.
async function toClean(s: Setup, ticket: string, title = 'Hand it over'): Promise<void> {
  await putTask(s.env, s.repo, ticket, title);
  await call(s.served, 'start', { workspace: 'app', ticket });
  await waitFor(s.served, ticket, 'awaiting_review');
  await call(s.served, 'mark_clean', { workspace: 'app', ticket });
}

async function waitState(s: Setup, ticket: string, ...states: string[]): Promise<Record<string, any>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const checked = await call(s.served, 'check', { workspace: 'app', ticket });
    if (states.includes(checked.state)) {
      return checked;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${states.join('/')}: ${JSON.stringify(checked)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const job = async (s: Setup, ticket: string): Promise<Job> => (await s.jobs.read('app', ticket))!;

test('automatic hand-over at ready: the checkout on the branch at B with the job\'s changes as Local Changes, added files intent-to-add, the message prefilled, the worktree gone, no slot held; Approve without a user commit pushes the saved commit', async () => {
  const s = await setup('handauto', { SF_MAX_JOBS: '1' });
  await script(s.env, [
    { write: { 'README.md': 'hello handed\n', 'src/new.txt': 'new\n' }, text: 'iteration 1' },
    mrTurn('H-1'),
    { delayMs: 300, write: { 'other.txt': 'o\n' }, text: 'the other job' },
  ]);
  await toClean(s, 'H-1');
  await waitFor(s.served, 'H-1', 'handed_over');
  const branch = 'H-1-hand-it-over';
  const handed = await job(s, 'H-1');
  const saved = handed.prepared_commit!;
  const base = handed.base_commit!;
  assert.deepEqual([handed.worktree, handed.handover?.saved, handed.handover?.base, handed.handover?.previous, handed.handover?.step], [null, saved, base, { branch: 'main' }, null]);
  // The job's commit is one commit on B, saved as refs/factory/H-1.
  assert.equal(rev(s.repo, `${saved}~1`), base);
  assert.equal(rev(s.repo, 'refs/factory/H-1'), saved);
  // The checkout: the branch at B, the changes uncommitted, the new file intent-to-add.
  assert.equal(head(s.repo), `refs/heads/${branch}`);
  assert.equal(rev(s.repo, 'HEAD'), base);
  assert.equal(status(s.repo), ' M README.md\n A src/new.txt\n');
  assert.equal(gitCode(s.repo, 'diff', '--quiet', 'refs/factory/H-1'), 0);
  assert.equal(await readFile(join(s.repo, 'src', 'new.txt'), 'utf8'), 'new\n');
  // The commit message, # headings kept.
  const template = config(s.repo, 'commit.template')!;
  const message = mrMessage(mrText('feat(H-1): Hand it over'));
  assert.equal(await readFile(template, 'utf8'), `${message.title}\n\n${message.body}`);
  assert.equal(template, join(s.repo, '.git', 'factory', 'H-1.commit-msg'));
  assert.equal(config(s.repo, 'commit.cleanup'), 'scissors');
  // The worktree is gone; sf status says where the job is.
  assert.equal(await exists(worktreeOf(s.env, 'H-1')), false);
  assert.ok(!git(s.repo, 'worktree', 'list').includes(worktreeOf(s.env, 'H-1')));
  assert.match((await runCli(s.env, ['status', 'app', 'H-1'])).stdout, /\nin your checkout on H-1-hand-it-over\nMR title: feat\(H-1\): Hand it over\n/);
  // No SF_MAX_JOBS slot is held: another job starts with SF_MAX_JOBS=1.
  await putTask(s.env, s.repo, 'H-2', 'Other');
  assert.equal((await call(s.served, 'start', { workspace: 'app', ticket: 'H-2' })).state, 'working');
  await waitFor(s.served, 'H-2', 'awaiting_review');
  await runCli(s.env, ['abort', 'app', 'H-2']);

  // Approve: the user did not commit, so the saved commit is pushed and the branch moves to it.
  const pushed = await runCli(s.env, ['approve', 'app', 'H-1']);
  assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
  assert.match(pushed.stdout, new RegExp(`^message: Pushed the factory's commit ${saved.slice(0, 12)}\\.$`, 'm'));
  assert.equal(remoteTip(s.origin, branch), saved);
  assert.equal(rev(s.repo, 'HEAD'), saved);
  assert.equal(status(s.repo), '');
  const done = await job(s, 'H-1');
  assert.deepEqual([done.state, done.prepared_commit, done.handover, done.worktree], ['pushed', saved, undefined, null]);
  // The config the factory set is gone, and the prefilled message with it.
  assert.deepEqual([config(s.repo, 'commit.template'), config(s.repo, 'commit.cleanup')], [null, null]);
  assert.equal(await exists(template), false);
  await stop(s.served);
});

test('a checkout with a tracked change: no hand-over, ready_for_human_review with handoff_skipped checkout_dirty and the worktree kept; sf handover once the change is committed elsewhere', async () => {
  const s = await setup('handdirty');
  await script(s.env, [{ write: { 'README.md': 'job\n', 'added.txt': 'a\n' }, text: 'iteration 1' }, mrTurn('D-1')]);
  await putTask(s.env, s.repo, 'D-1', 'Hand it over');
  await call(s.served, 'start', { workspace: 'app', ticket: 'D-1' });
  await waitFor(s.served, 'D-1', 'awaiting_review');
  await writeFile(join(s.repo, '.gitignore'), '*.log\nlocal/\n');
  await call(s.served, 'mark_clean', { workspace: 'app', ticket: 'D-1' });
  await waitFor(s.served, 'D-1', 'ready_for_human_review');
  const ready = await job(s, 'D-1');
  assert.deepEqual(ready.handoff_skipped, { code: 'checkout_dirty', message: 'D-1: ready, but your checkout has changes; hand it over when you are ready' });
  assert.equal(ready.worktree, worktreeOf(s.env, 'D-1'));
  assert.equal(git(ready.worktree!, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'D-1-hand-it-over');
  assert.equal(head(s.repo), 'refs/heads/main');
  assert.equal(status(s.repo), ' M .gitignore\n');
  assert.equal(git(s.repo, 'for-each-ref', 'refs/factory/'), '');
  assert.match((await runCli(s.env, ['status', 'app', 'D-1'])).stdout, /not handed over to your checkout: D-1: ready, but your checkout has changes/);
  const dirty = await runCli(s.env, ['handover', 'app', 'D-1']);
  assert.equal(dirty.code, 1);
  assert.match(dirty.stderr, /your checkout has changes/);

  // The change committed on a branch of its own: the hand-over goes, from that branch.
  git(s.repo, 'switch', '-q', '-c', 'mine');
  git(s.repo, 'commit', '-q', '-am', 'my ignore rule');
  const handed = await runCli(s.env, ['handover', 'app', 'D-1']);
  assert.equal(handed.code, 0, handed.stdout + handed.stderr);
  assert.match(handed.stdout, /^state: handed_over$/m);
  const after = await job(s, 'D-1');
  assert.deepEqual([after.state, after.handoff_skipped, after.handover?.previous, after.worktree], ['handed_over', undefined, { branch: 'mine' }, null]);
  assert.equal(head(s.repo), 'refs/heads/D-1-hand-it-over');
  assert.equal(gitCode(s.repo, 'diff', '--quiet', 'refs/factory/D-1'), 0);
  await stop(s.served);
});

test('a file in the way where the job adds one, untracked or ignored: handover_refused naming it, the file unchanged, nothing else changed', async () => {
  const s = await setup('handway');
  await script(s.env, [
    { write: { 'notes.txt': 'job notes\n', 'gen/out.txt': 'job output\n' }, text: 'iteration 1' }, mrTurn('W-1'),
  ]);
  await putTask(s.env, s.repo, 'W-1', 'Hand it over');
  await call(s.served, 'start', { workspace: 'app', ticket: 'W-1' });
  await waitFor(s.served, 'W-1', 'awaiting_review');
  // An untracked file of the user at a path the job adds.
  await writeFile(join(s.repo, 'notes.txt'), 'my notes\n');
  await call(s.served, 'mark_clean', { workspace: 'app', ticket: 'W-1' });
  await waitFor(s.served, 'W-1', 'ready_for_human_review');
  let ready = await job(s, 'W-1');
  assert.deepEqual(ready.handoff_skipped, { code: 'handover_refused', message: 'These files in your checkout are in the way: notes.txt.' });
  assert.equal(await readFile(join(s.repo, 'notes.txt'), 'utf8'), 'my notes\n');
  assert.equal(head(s.repo), 'refs/heads/main');
  assert.equal(git(s.repo, 'for-each-ref', 'refs/factory/'), '');
  assert.deepEqual([config(s.repo, 'commit.template'), config(s.repo, 'commit.cleanup')], [null, null]);
  assert.equal(git(ready.worktree!, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'W-1-hand-it-over');

  // An ignored file: the checkout is on a branch whose .gitignore ignores gen/, with gen/out.txt.
  await rm(join(s.repo, 'notes.txt'));
  git(s.repo, 'switch', '-q', '-c', 'local');
  await writeFile(join(s.repo, '.gitignore'), '*.log\ngen/\n');
  git(s.repo, 'commit', '-q', '-am', 'ignore gen');
  await mkdir(join(s.repo, 'gen'));
  await writeFile(join(s.repo, 'gen', 'out.txt'), 'my generated file\n');
  assert.equal(status(s.repo), '');
  const refusedIgnored = await runCli(s.env, ['handover', 'app', 'W-1']);
  assert.equal(refusedIgnored.code, 1);
  assert.match(refusedIgnored.stderr, /^sf: These files in your checkout are in the way: gen\/out\.txt\.$/m);
  assert.equal(await readFile(join(s.repo, 'gen', 'out.txt'), 'utf8'), 'my generated file\n');
  assert.equal(head(s.repo), 'refs/heads/local');
  assert.equal(git(s.repo, 'for-each-ref', 'refs/factory/'), '');
  ready = await job(s, 'W-1');
  assert.deepEqual([ready.state, ready.handover], ['ready_for_human_review', undefined]);
  await stop(s.served);
});

test('SF_HANDOFF=off: ready_for_human_review with the worktree; Approve pushes and then removes it', async () => {
  const s = await setup('handoff-off', { SF_HANDOFF: 'off' });
  await script(s.env, [{ write: { 'README.md': 'off\n' }, text: 'iteration 1' }, mrTurn('O-1')]);
  await toClean(s, 'O-1');
  await waitFor(s.served, 'O-1', 'ready_for_human_review');
  const ready = await job(s, 'O-1');
  assert.deepEqual([ready.worktree, ready.handoff_skipped, ready.handover], [worktreeOf(s.env, 'O-1'), undefined, undefined]);
  assert.equal(head(s.repo), 'refs/heads/main');
  const pushed = await runCli(s.env, ['approve', 'app', 'O-1']);
  assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
  assert.equal(remoteTip(s.origin, 'O-1-hand-it-over'), ready.prepared_commit);
  assert.equal(await exists(worktreeOf(s.env, 'O-1')), false);
  assert.equal((await job(s, 'O-1')).worktree, null);
  await stop(s.served);
});

test('Ask for changes: refused with job_limit without a free slot and with checkout_moved off the branch, nothing changed; then the user\'s edit and new file reach the worktree, refs/factory/<ticket>-ask holds them, the checkout is back on main without leftovers, and the next ready hands over again', async () => {
  const s = await setup('handask', { SF_MAX_JOBS: '1' });
  await script(s.env, [
    { write: { 'README.md': 'job readme\n', 'job.txt': 'job\n' }, text: 'iteration 1' },
    mrTurn('A-1'),
    { delayMs: 1500, write: { 'busy.txt': 'b\n' }, text: 'the busy job' },
    { write: { 'second.txt': 'second\n' }, text: 'iteration 2 after the user asked' },
    mrTurn('A-1', 'Hand it over again'),
  ]);
  // The user's own untracked file from before the hand-over: never touched, never in the job.
  await writeFile(join(s.repo, 'mine.txt'), 'mine\n');
  await toClean(s, 'A-1');
  await waitFor(s.served, 'A-1', 'handed_over');
  const branch = 'A-1-hand-it-over';
  const { base_commit: base } = await job(s, 'A-1');
  assert.deepEqual((await job(s, 'A-1')).handover!.untracked, ['mine.txt']);

  // A job working holds the one slot: Ask for changes and Take it back are refused.
  await putTask(s.env, s.repo, 'A-2', 'Busy');
  await call(s.served, 'start', { workspace: 'app', ticket: 'A-2' });
  await turnsStarted(s.env, 3);
  const limited = await refusedSocket(s, 'say', ['app', 'A-1', 'Please change']);
  assert.equal(limited.code, 'job_limit');
  assert.equal((await refusedSocket(s, 'takeback', ['app', 'A-1'])).code, 'job_limit');
  assert.equal((await job(s, 'A-1')).state, 'handed_over');
  await waitFor(s.served, 'A-2', 'awaiting_review');
  await runCli(s.env, ['abort', 'app', 'A-2']);

  // The user's edits: a change to the job's README and a new file.
  await writeFile(join(s.repo, 'README.md'), 'job readme, edited by the user\n');
  await writeFile(join(s.repo, 'user.txt'), 'from the user\n');
  // Off the branch (main is at B, so the edits come along): checkout_moved, nothing changed.
  git(s.repo, 'switch', '-q', 'main');
  const moved = await refusedSocket(s, 'say', ['app', 'A-1', 'Please change']);
  assert.deepEqual(moved, { code: 'checkout_moved', message: `Your checkout is not on ${branch}; switch back to it, or use Take it back.` });
  assert.equal((await job(s, 'A-1')).state, 'handed_over');
  assert.equal(git(s.repo, 'for-each-ref', 'refs/factory/A-1-ask'), '');
  git(s.repo, 'switch', '-q', branch);
  assert.equal(head(s.repo), `refs/heads/${branch}`);

  const asked = await runCli(s.env, ['say', 'app', 'A-1', 'Keep', 'my', 'edit']);
  assert.equal(asked.code, 0, asked.stdout + asked.stderr);
  assert.match(asked.stdout, /^state: working$/m);
  // The checkout is back on main, clean, the user's own file untouched.
  assert.equal(head(s.repo), 'refs/heads/main');
  assert.equal(status(s.repo), '?? mine.txt\n');
  assert.equal(await readFile(join(s.repo, 'mine.txt'), 'utf8'), 'mine\n');
  assert.deepEqual([config(s.repo, 'commit.template'), config(s.repo, 'commit.cleanup')], [null, null]);
  // The snapshot holds the edits, not the user's own file.
  const ask = rev(s.repo, 'refs/factory/A-1-ask');
  assert.equal(git(s.repo, 'show', `${ask}:README.md`), 'job readme, edited by the user\n');
  assert.equal(git(s.repo, 'show', `${ask}:user.txt`), 'from the user\n');
  assert.equal(git(s.repo, 'show', `${ask}:job.txt`), 'job\n');
  assert.notEqual(gitCode(s.repo, 'cat-file', '-e', `${ask}:mine.txt`), 0);
  // The worktree has the edits as uncommitted changes on B.
  const worktree = worktreeOf(s.env, 'A-1');
  assert.equal(rev(worktree, 'HEAD'), base);
  assert.equal(await readFile(join(worktree, 'README.md'), 'utf8'), 'job readme, edited by the user\n');
  assert.equal(await readFile(join(worktree, 'user.txt'), 'utf8'), 'from the user\n');
  assert.equal(await exists(join(worktree, 'mine.txt')), false);
  const asking = await job(s, 'A-1');
  assert.deepEqual([asking.handover, asking.prepared_commit, asking.worktree], [undefined, null, worktree]);
  await waitFor(s.served, 'A-1', 'awaiting_review', 2);
  const log = await fakeLog(s.env);
  assert.match(log.at(-1)!.prompt, /Keep my edit/);
  assert.equal(log.at(-1)!.cwd, worktree);

  // The next ready hands over again: nothing is in the way.
  await call(s.served, 'mark_clean', { workspace: 'app', ticket: 'A-1' });
  await waitFor(s.served, 'A-1', 'handed_over');
  const again = await job(s, 'A-1');
  assert.equal(head(s.repo), `refs/heads/${branch}`);
  assert.equal(git(s.repo, 'show', `${again.prepared_commit}:user.txt`), 'from the user\n');
  assert.equal(git(s.repo, 'show', `${again.prepared_commit}:second.txt`), 'second\n');
  assert.notEqual(gitCode(s.repo, 'cat-file', '-e', `${again.prepared_commit}:mine.txt`), 0);
  assert.equal(await readFile(join(s.repo, 'mine.txt'), 'utf8'), 'mine\n');
  await stop(s.served);
});

// A socket command refused by sf serve, with its code and message.
async function refusedSocket(s: Setup, command: string, args: string[]): Promise<{ code: string; message: string }> {
  const { callSocket } = await import('../src/ipc.js');
  const response = await callSocket(s.env.state, { command, args });
  assert.equal(response.ok, false, `expected ${command} to be refused: ${JSON.stringify(response)}`);
  return (response as { error: { code: string; message: string } }).error;
}

test('Take it back: refused after an edit (takeback_changed, the files named) and with a previous branch that cannot be checked out (takeback_switch_failed, nothing changed); allowed without an edit, with the user\'s own untracked file', async () => {
  const s = await setup('handback');
  await script(s.env, [{ write: { 'README.md': 'job\n', 'added.txt': 'added\n' }, text: 'iteration 1' }, mrTurn('B-1')]);
  // scratch tracks app.log, a path the job's branch ignores (*.log).
  git(s.repo, 'switch', '-q', '-c', 'scratch');
  await writeFile(join(s.repo, 'app.log'), 'tracked on scratch\n');
  git(s.repo, 'add', '-f', 'app.log');
  git(s.repo, 'commit', '-q', '-m', 'track app.log');
  await writeFile(join(s.repo, 'mine.txt'), 'mine\n');
  await toClean(s, 'B-1');
  await waitFor(s.served, 'B-1', 'handed_over');
  const branch = 'B-1-hand-it-over';
  const { prepared_commit: saved, base_commit: base } = await job(s, 'B-1');
  assert.deepEqual((await job(s, 'B-1')).handover!.previous, { branch: 'scratch' });

  await writeFile(join(s.repo, 'README.md'), 'edited\n');
  const changed = await refusedSocket(s, 'takeback', ['app', 'B-1']);
  assert.deepEqual(changed, { code: 'takeback_changed', message: 'Your checkout changed since the hand-over: README.md. Use Ask for changes to send your edits to the job, or undo them.' });
  await writeFile(join(s.repo, 'README.md'), 'job\n');
  // An ignored file of the user where scratch has app.log: the switch back would overwrite it.
  assert.equal(await exists(join(s.repo, 'app.log')), false);
  await writeFile(join(s.repo, 'app.log'), 'my log\n');
  const inTheWay = await refusedSocket(s, 'takeback', ['app', 'B-1']);
  assert.equal(inTheWay.code, 'handover_refused', inTheWay.message);
  assert.match(inTheWay.message, /^These files in your checkout are in the way: app\.log\. /);
  assert.equal(await readFile(join(s.repo, 'app.log'), 'utf8'), 'my log\n');
  assert.equal(head(s.repo), `refs/heads/${branch}`);
  await rm(join(s.repo, 'app.log'));

  // The previous branch is gone: the switch back fails and is undone.
  git(s.repo, 'branch', '-q', '-D', 'scratch');
  const before = status(s.repo);
  const failed = await refusedSocket(s, 'takeback', ['app', 'B-1']);
  assert.equal(failed.code, 'takeback_switch_failed');
  assert.equal(head(s.repo), `refs/heads/${branch}`);
  assert.equal(rev(s.repo, branch), base);
  assert.equal(status(s.repo), before);
  assert.equal(config(s.repo, 'commit.cleanup'), 'scissors');
  assert.equal((await job(s, 'B-1')).state, 'handed_over');
  git(s.repo, 'branch', '-q', 'scratch', base!);

  const back = await runCli(s.env, ['takeback', 'app', 'B-1']);
  assert.equal(back.code, 0, back.stdout + back.stderr);
  assert.match(back.stdout, /^state: ready_for_human_review$/m);
  assert.equal(head(s.repo), 'refs/heads/scratch');
  assert.equal(status(s.repo), '?? mine.txt\n');
  assert.equal(await readFile(join(s.repo, 'mine.txt'), 'utf8'), 'mine\n');
  assert.equal(rev(s.repo, branch), saved);
  assert.deepEqual([config(s.repo, 'commit.template'), config(s.repo, 'commit.cleanup')], [null, null]);
  const ready = await job(s, 'B-1');
  assert.deepEqual([ready.state, ready.prepared_commit, ready.worktree, ready.handover], ['ready_for_human_review', saved, worktreeOf(s.env, 'B-1'), undefined]);
  assert.equal(git(ready.worktree!, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), branch);
  assert.equal(await exists(join(ready.worktree!, 'mine.txt')), false);
  await stop(s.served);
});

test('Approve on a handed-over job: a rejected push keeps the job handed_over with error and the checkout untouched; a user commit is pushed; a tip that does not descend from B is branch_changed', async () => {
  const s = await setup('handpush');
  await script(s.env, [{ write: { 'README.md': 'job\n' }, text: 'iteration 1' }, mrTurn('P-1')]);
  await toClean(s, 'P-1');
  await waitFor(s.served, 'P-1', 'handed_over');
  const branch = 'P-1-hand-it-over';
  const { base_commit: base } = await job(s, 'P-1');
  // origin rejects every push.
  const hook = join(s.origin, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\necho rejected by the test >&2\nexit 1\n');
  await chmod(hook, 0o755);
  const before = [head(s.repo), rev(s.repo, 'HEAD'), status(s.repo), config(s.repo, 'commit.template')];
  const rejected = await runCli(s.env, ['approve', 'app', 'P-1']);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stdout, /^state: handed_over$/m);
  assert.match(rejected.stdout, /The push failed/);
  const kept = await job(s, 'P-1');
  assert.equal(kept.state, 'handed_over');
  assert.equal(kept.error?.code, 'mr_push_failed');
  assert.notEqual(kept.handover, undefined);
  assert.deepEqual([head(s.repo), rev(s.repo, 'HEAD'), status(s.repo), config(s.repo, 'commit.template')], before);
  assert.equal(rev(s.repo, 'refs/factory/P-1'), kept.prepared_commit);
  await rm(hook);

  // The user commits on the branch (another line on top of the job's change): that is pushed.
  await writeFile(join(s.repo, 'README.md'), 'job, and mine\n');
  git(s.repo, 'commit', '-q', '-am', 'feat(P-1): mine');
  const tip = rev(s.repo, 'HEAD');
  // A tip that does not descend from B first: refused.
  git(s.repo, 'update-ref', `refs/heads/${branch}`, git(s.repo, 'commit-tree', `${tip}^{tree}`, '-m', 'orphan').trim());
  const orphan = await runCli(s.env, ['approve', 'app', 'P-1']);
  assert.equal(orphan.code, 1);
  assert.match(orphan.stderr, new RegExp(`^sf: The tip of ${branch} does not descend from the job's base ${base!.slice(0, 12)}; push it yourself or take it back\\.$`, 'm'));
  git(s.repo, 'update-ref', `refs/heads/${branch}`, tip);
  const pushed = await runCli(s.env, ['approve', 'app', 'P-1']);
  assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
  assert.match(pushed.stdout, new RegExp(`^message: Pushed your commit ${tip.slice(0, 12)} \\(feat\\(P-1\\): mine\\)\\.$`, 'm'));
  assert.equal(remoteTip(s.origin, branch), tip);
  const done = await job(s, 'P-1');
  assert.deepEqual([done.state, done.prepared_commit, done.error], ['pushed', tip, undefined]);
  await stop(s.served);
});

test('the user\'s own push: sf handed-done before it is not_pushed; the job detail finds the push (same_tree true, and false with an extra change); fix, reset, restart and abort --discard are refused with handed_over', async () => {
  const s = await setup('handuser');
  await script(s.env, [
    { write: { 'README.md': 'job one\n', 'added.txt': 'added\n' }, text: 'iteration 1' }, mrTurn('U-1'),
    { write: { 'README.md': 'job two\n' }, text: 'iteration 1' }, mrTurn('U-2'),
  ]);
  await toClean(s, 'U-1');
  await waitFor(s.served, 'U-1', 'handed_over');
  for (const [args, code] of [[['reset', 'app', 'U-1'], 1], [['restart', 'app', 'U-1'], 1], [['abort', 'app', 'U-1', '--discard'], 1]] as const) {
    const result = await runCli(s.env, [...args]);
    assert.equal(result.code, code, args.join(' '));
    assert.match(result.stderr, /^sf: U-1 is in your checkout on U-1-hand-it-over; take it back first\.$/m, args.join(' '));
  }
  assert.deepEqual(await refused(s.served, 'request_fix', { workspace: 'app', ticket: 'U-1', content: 'x' }), { code: 'handed_over', message: 'U-1 is in your checkout on U-1-hand-it-over; take it back first.' });
  assert.equal((await refusedSocket(s, 'pause', ['app', 'U-1'])).code, 'invalid_state');
  assert.equal((await refused(s.served, 'mark_clean', { workspace: 'app', ticket: 'U-1' })).code, 'invalid_state');
  const notYet = await refusedSocket(s, 'handed-done', ['app', 'U-1']);
  assert.deepEqual(notYet, { code: 'not_pushed', message: 'The branch U-1-hand-it-over is not on origin with your changes; push it first.' });

  // The user commits the job's changes as they are and pushes from the checkout.
  const template = config(s.repo, 'commit.template')!;
  git(s.repo, 'commit', '-q', '-a', '-F', template, '--cleanup=scissors');
  git(s.repo, 'push', '-q', 'origin', 'U-1-hand-it-over');
  const pushedOne = rev(s.repo, 'HEAD');
  const dashboard = s.served.dashboard!;
  await fetch(new URL('api/jobs/app/U-1', dashboard));
  await waitFor(s.served, 'U-1', 'pushed');
  const one = await job(s, 'U-1');
  assert.deepEqual([one.prepared_commit, one.handover], [pushedOne, undefined]);
  assert.equal(await exists(template), false);
  const events = (await readFile(s.jobs.eventsPath('app', 'U-1'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.filter((event) => event.type === 'handover_pushed').map((event) => [event.commit, event.same_tree]), [[pushedOne, true]]);

  // Another job, pushed by the user with an extra change.
  git(s.repo, 'switch', '-q', 'main');
  await toClean(s, 'U-2', 'Second');
  await waitFor(s.served, 'U-2', 'handed_over');
  await writeFile(join(s.repo, 'extra.txt'), 'extra\n');
  git(s.repo, 'add', 'extra.txt');
  git(s.repo, 'commit', '-q', '-am', 'feat(U-2): with more');
  git(s.repo, 'push', '-q', 'origin', 'U-2-second');
  const done = await runCli(s.env, ['handed-done', 'app', 'U-2']);
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /^state: pushed\n[^]*same_tree: false$/m);
  assert.equal((await job(s, 'U-2')).prepared_commit, rev(s.repo, 'HEAD'));
  await stop(s.served);
});

test('recover(): a hand-over cut off after the checkout switch goes back to ready_for_human_review with the checkout on main and the worktree on the branch; a cut-off Ask for changes leaves the edits in the worktree, needs_human ask_interrupted', async () => {
  const env = await newEnv('handrecover', { SF_HANDOFF: 'checkout' });
  const repo = await newRepo(env, 'handrecover-repo', true);
  const jobs = new JobStore(env.state);
  let served = await serve(env);
  let s: Setup = { env, repo, origin: '', served, jobs };
  await script(env, [
    { write: { 'README.md': 'cut\n', 'new.txt': 'new\n' }, text: 'iteration 1' }, mrTurn('R-1'),
    { write: { 'a.txt': 'a\n' }, text: 'iteration 1' }, mrTurn('R-2'),
  ]);
  await toClean(s, 'R-1');
  await waitFor(served, 'R-1', 'handed_over');
  await stop(served);
  // As if sf serve stopped between the reset to B and the intent-to-add (step 7 done, step 8 not):
  // the added file untracked, the record with its step, the state the hand-over started in, the
  // worktree path it had.
  git(repo, 'reset', '-q', '--', 'new.txt');
  assert.equal(status(repo), ' M README.md\n?? new.txt\n');
  const cut = await jobs.read('app', 'R-1');
  await jobs.write({ ...cut!, state: 'preparing_mr', worktree: worktreeOf(env, 'R-1'), handover: { ...cut!.handover!, step: 'handing_over' } });
  served = await serve(env);
  s = { ...s, served };
  const ready = await waitState(s, 'R-1', 'ready_for_human_review', 'needs_human');
  assert.equal(ready.state, 'ready_for_human_review', JSON.stringify(ready));
  const repaired = await jobs.read('app', 'R-1');
  assert.deepEqual([repaired!.handoff_skipped?.code, repaired!.handover, repaired!.worktree], ['handover_interrupted', undefined, worktreeOf(env, 'R-1')]);
  assert.equal(head(repo), 'refs/heads/main');
  assert.equal(status(repo), '');
  assert.equal(git(worktreeOf(env, 'R-1'), 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'R-1-hand-it-over');
  assert.equal(rev(repo, 'R-1-hand-it-over'), repaired!.prepared_commit);
  assert.deepEqual([config(repo, 'commit.template'), config(repo, 'commit.cleanup')], [null, null]);
  await runCli(env, ['abort', 'app', 'R-1']);

  // Ask for changes cut off after its snapshot was saved.
  await toClean(s, 'R-2', 'Second');
  await waitFor(served, 'R-2', 'handed_over');
  await writeFile(join(repo, 'a.txt'), 'a, edited by the user\n');
  await stop(served);
  const index = join(await mkdtemp(join(tmpdir(), 'sf-index-')), 'index');
  const withIndex = { cwd: repo, encoding: 'utf8' as const, env: { ...process.env, GIT_INDEX_FILE: index } };
  execFileSync('git', ['read-tree', 'HEAD'], withIndex);
  execFileSync('git', ['add', '-A'], withIndex);
  const tree = execFileSync('git', ['write-tree'], withIndex).trim();
  const snapshot = git(repo, 'commit-tree', tree, '-p', 'HEAD', '-m', 'R-2: your checkout at Ask for changes').trim();
  git(repo, 'update-ref', 'refs/factory/R-2-ask', snapshot);
  const asking = await jobs.read('app', 'R-2');
  await jobs.write({ ...asking!, handover: { ...asking!.handover!, step: 'asking', snapshot } });
  // A saved ref of a ticket without a job goes when sf serve starts; R-1's (aborted just now) stays.
  git(repo, 'update-ref', 'refs/factory/GHOST-1', snapshot);
  git(repo, 'update-ref', 'refs/factory/GHOST-1-ask', snapshot);
  served = await serve(env);
  s = { ...s, served };
  const interrupted = await waitFor(served, 'R-2', 'needs_human');
  assert.equal(interrupted.error.code, 'ask_interrupted');
  assert.equal(interrupted.error.message, "sf serve restarted during Ask for changes; your edits are in the job's worktree; use sf say to go on.");
  assert.equal(head(repo), 'refs/heads/main');
  assert.equal(status(repo), '');
  const worktree = worktreeOf(env, 'R-2');
  assert.equal(await readFile(join(worktree, 'a.txt'), 'utf8'), 'a, edited by the user\n');
  assert.equal(rev(worktree, 'HEAD'), asking!.handover!.base);
  const after = await jobs.read('app', 'R-2');
  assert.deepEqual([after!.handover, after!.prepared_commit, after!.worktree], [undefined, null, worktree]);
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/factory/'), 'refs/factory/R-1\nrefs/factory/R-2\nrefs/factory/R-2-ask\n');
  await stop(served);
});

test('a needs_human after a failed push is approvable with the worktree kept and is not taken as the MR preparation retry; after sf say on it and a later needs_human it is not approvable', async () => {
  const s = await setup('handneeds', { SF_HANDOFF: 'off' });
  await script(s.env, [
    { write: { 'README.md': 'job\n' }, text: 'iteration 1' }, mrTurn('N-1'),
    { startupFailure: 'sandbox: bubblewrap is not installed' },
  ]);
  await toClean(s, 'N-1');
  await waitFor(s.served, 'N-1', 'ready_for_human_review');
  const hook = join(s.origin, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  const failed = await runCli(s.env, ['approve', 'app', 'N-1']);
  assert.equal(failed.code, 1);
  const stopped = await job(s, 'N-1');
  assert.deepEqual([stopped.state, stopped.error?.code, stopped.worktree], ['needs_human', 'mr_push_failed', worktreeOf(s.env, 'N-1')]);
  assert.ok((await stat(stopped.worktree!)).isDirectory());
  // Not the retry of MR preparation.
  assert.equal((await refused(s.served, 'mark_clean', { workspace: 'app', ticket: 'N-1' })).code, 'invalid_state');
  // sf say on it: the prepared commit is dropped before the turn; the turn fails, needs_human again.
  const said = await runCli(s.env, ['say', 'app', 'N-1', 'one', 'more']);
  assert.equal(said.code, 0, said.stdout + said.stderr);
  await waitFor(s.served, 'N-1', 'needs_human');
  const again = await job(s, 'N-1');
  assert.deepEqual([again.prepared_commit, again.error?.code], [null, 'sandbox_unavailable']);
  await rm(hook);
  const notApprovable = await runCli(s.env, ['approve', 'app', 'N-1']);
  assert.equal(notApprovable.code, 1);
  assert.match(notApprovable.stderr, /approve needs ready_for_human_review/);
  assert.equal(remoteTip(s.origin, 'N-1-hand-it-over'), undefined);
  await stop(s.served);
});

test('recover() of a hand-over it cannot undo safely: needs_human handover_interrupted with the checkout untouched; no turn runs while the checkout holds the branch (branch_in_checkout), and once it lets go the detached worktree is put back on the branch and the turn runs', async () => {
  const env = await newEnv('handunsafe', { SF_HANDOFF: 'checkout' });
  const repo = await newRepo(env, 'handunsafe-repo', true);
  const jobs = new JobStore(env.state);
  let served = await serve(env);
  let s: Setup = { env, repo, origin: '', served, jobs };
  await script(env, [
    { write: { 'README.md': 'unsafe\n' }, text: 'iteration 1' }, mrTurn('X-1'),
    { write: { 'after.txt': 'after\n' }, text: 'iteration 2 once the branch was free' },
  ]);
  await toClean(s, 'X-1');
  await waitFor(served, 'X-1', 'handed_over');
  await stop(served);
  const branch = 'X-1-hand-it-over';
  const worktree = worktreeOf(env, 'X-1');
  const cut = (await jobs.read('app', 'X-1'))!;
  // The user edited the checkout, so it no longer holds exactly the job's commit; the worktree is
  // still there, detached, as after a hand-over cut off before step 11.
  await writeFile(join(repo, 'README.md'), 'unsafe, and edited by the user\n');
  git(repo, 'worktree', 'add', '-q', '--detach', worktree, cut.prepared_commit!);
  await jobs.write({ ...cut, state: 'preparing_mr', worktree, handover: { ...cut.handover!, step: 'handing_over' } });
  served = await serve(env);
  s = { ...s, served };
  const stopped = await waitFor(served, 'X-1', 'needs_human');
  assert.equal(stopped.error.code, 'handover_interrupted');
  assert.equal(head(repo), `refs/heads/${branch}`);
  assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'unsafe, and edited by the user\n');
  assert.equal(gitCode(worktree, 'symbolic-ref', '-q', 'HEAD'), 1);
  assert.deepEqual([config(repo, 'commit.template'), config(repo, 'commit.cleanup')], [null, null]);

  // sf say is refused while the checkout holds the branch; nothing changes, no turn starts.
  const refusedSay = await refusedSocket(s, 'say', ['app', 'X-1', 'go on']);
  assert.equal(refusedSay.code, 'branch_in_checkout');
  assert.match(refusedSay.message, new RegExp(`^X-1: the branch ${branch} is checked out in your checkout; `));
  const still = (await jobs.read('app', 'X-1'))!;
  assert.deepEqual([still.state, still.prepared_commit], ['needs_human', cut.prepared_commit]);
  assert.equal(gitCode(worktree, 'symbolic-ref', '-q', 'HEAD'), 1);
  assert.equal((await fakeLog(env)).length, 2);

  // The user switches the checkout away (main is at B, the edit comes along): the turn runs in the
  // worktree, which is on the branch again.
  git(repo, 'switch', '-q', 'main');
  const said = await runCli(env, ['say', 'app', 'X-1', 'go', 'on']);
  assert.equal(said.code, 0, said.stdout + said.stderr);
  assert.equal(git(worktree, 'symbolic-ref', '-q', 'HEAD').trim(), `refs/heads/${branch}`);
  await waitFor(served, 'X-1', 'awaiting_review', 2);
  assert.equal((await fakeLog(env)).at(-1)!.cwd, worktree);
  await stop(served);
});
