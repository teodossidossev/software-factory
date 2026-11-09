// End-to-end tests of the hand-over to the user's checkout (SF-073), split from
// test/handoff.test.ts (SF-152: one file ran near run-tests' per-file limit): recover() of a
// hand-over cut off midway, and the sandbox's leftover config lock (SF-085). SF_HANDOFF=checkout
// here; the shared helpers are test/support/handoff.ts's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { call, fakeLog, git, holdOpen, newEnv, newRepo, putTask, refused, runCli, script, serve, stop, turnsStarted, waitFor } from './support/harness.js';
import { config, exists, gitCode, head, job, mrTurn, refusedSocket, remoteTip, rev, type Setup, setup, status, toClean, waitState, worktreeOf } from './support/handoff.js';

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

// The config lock Claude Code's sandbox leaves in the checkout's Git directory (SF-085): empty and
// read-only, as the sandbox makes it; a held lock is not empty.
async function sandboxLock(repo: string, content = ''): Promise<string> {
  const path = join(repo, '.git', 'config.lock');
  await writeFile(path, content);
  await chmod(path, content === '' ? 0o444 : 0o644);
  return path;
}

// The sandbox_lock_removed events of the job's log.
async function lockEvents(s: Setup, ticket: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(s.jobs.dir('app', ticket), 'events.jsonl'), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.type === 'sandbox_lock_removed');
}

test('the sandbox\'s leftover config lock (SF-085): kept at a job\'s turn end while a process has it open; removed when a job\'s turn ends, nobody holds it and no other job runs, an event in its log; kept while another job of the workspace awaits review', async () => {
  const s = await setup('lockturn', { SF_HANDOFF: 'off' });
  await script(s.env, [
    { write: { 'README.md': 'one\n' }, text: 'iteration 1' },
    { write: { 'README.md': 'one more\n' }, text: 'iteration 2' },
    { write: { 'two.txt': 'two\n' }, text: 'the other job' },
  ]);
  const lock = await sandboxLock(s.repo);
  // A process has the lock open (the job's runner scans the test's fake /proc, SF-105): kept.
  const release = await holdOpen(s.env, lock);
  await putTask(s.env, s.repo, 'L-1', 'First');
  await call(s.served, 'start', { workspace: 'app', ticket: 'L-1' });
  await waitFor(s.served, 'L-1', 'awaiting_review');
  assert.equal(await exists(lock), true);
  assert.deepEqual(await lockEvents(s, 'L-1'), []);

  // Nobody holds it any more: the next turn end removes it.
  await release();
  const said = await runCli(s.env, ['say', 'app', 'L-1', 'one more']);
  assert.equal(said.code, 0, said.stdout + said.stderr);
  await waitFor(s.served, 'L-1', 'awaiting_review', 2);
  assert.equal(await exists(lock), false);
  assert.deepEqual((await lockEvents(s, 'L-1')).map((event) => [event.path, event.iteration]), [[lock, 2]]);

  // L-1 awaits review: its sandbox may be using the lock, so L-2's turn end leaves it.
  await sandboxLock(s.repo);
  await putTask(s.env, s.repo, 'L-2', 'Second');
  await call(s.served, 'start', { workspace: 'app', ticket: 'L-2' });
  await waitFor(s.served, 'L-2', 'awaiting_review');
  assert.equal(await exists(lock), true);
  assert.deepEqual(await lockEvents(s, 'L-2'), []);
  await stop(s.served);
});

test('sf handover and Take it back meet a stale sandbox lock (SF-085): it is removed and they succeed; a lock that is not stale (not empty, or open in a process) is never touched and the hand-over refuses with Git\'s message', async () => {
  const s = await setup('lockhand', { SF_HANDOFF: 'off' });
  await script(s.env, [{ write: { 'README.md': 'locked\n' }, text: 'iteration 1' }, mrTurn('M-1')]);
  await toClean(s, 'M-1');
  await waitFor(s.served, 'M-1', 'ready_for_human_review');

  // A lock in use (not empty): untouched, handover_failed with Git's message, nothing changed.
  const held = await sandboxLock(s.repo, 'held\n');
  const refusedHeld = await runCli(s.env, ['handover', 'app', 'M-1']);
  assert.equal(refusedHeld.code, 1);
  assert.match(refusedHeld.stderr, /git config failed: error: could not lock config file .*: File exists/);
  assert.equal(await readFile(held, 'utf8'), 'held\n');
  assert.deepEqual([(await job(s, 'M-1')).state, head(s.repo), status(s.repo)], ['ready_for_human_review', 'refs/heads/main', '']);
  await rm(held);

  // A stale-looking lock a process has open (sf serve scans the test's fake /proc, SF-105): not
  // stale, untouched, the same refusal.
  const lock = await sandboxLock(s.repo);
  const release = await holdOpen(s.env, lock);
  const refusedOpen = await runCli(s.env, ['handover', 'app', 'M-1']);
  assert.equal(refusedOpen.code, 1);
  assert.match(refusedOpen.stderr, /git config failed: error: could not lock config file .*: File exists/);
  assert.equal(await exists(lock), true);
  assert.deepEqual([(await job(s, 'M-1')).state, head(s.repo), status(s.repo)], ['ready_for_human_review', 'refs/heads/main', '']);
  assert.deepEqual(await lockEvents(s, 'M-1'), []);
  await release();

  const handed = await runCli(s.env, ['handover', 'app', 'M-1']);
  assert.equal(handed.code, 0, handed.stdout + handed.stderr);
  assert.equal(await exists(lock), false);
  assert.equal(head(s.repo), 'refs/heads/M-1-hand-it-over');
  assert.equal(config(s.repo, 'commit.cleanup'), 'scissors');
  assert.equal((await lockEvents(s, 'M-1')).length, 1);

  await sandboxLock(s.repo);
  const taken = await runCli(s.env, ['takeback', 'app', 'M-1']);
  assert.equal(taken.code, 0, taken.stdout + taken.stderr);
  assert.equal(await exists(lock), false);
  assert.deepEqual([head(s.repo), config(s.repo, 'commit.template'), config(s.repo, 'commit.cleanup')], ['refs/heads/main', null, null]);
  assert.equal((await lockEvents(s, 'M-1')).length, 2);
  await stop(s.served);
});

test('a hand-over that meets a stale sandbox lock while another job of the workspace works (SF-085): config_locked, the lock and the checkout untouched; when that job leaves working the lock goes and the factory hands over by itself', async () => {
  const s = await setup('lockbusy');
  await script(s.env, [
    { write: { 'README.md': 'waits\n' }, text: 'iteration 1' },
    { delayMs: 60_000, write: { 'busy.txt': 'b\n' }, text: 'the busy job' },
    mrTurn('N-1'),
  ]);
  await putTask(s.env, s.repo, 'N-1', 'Hand it over');
  await putTask(s.env, s.repo, 'N-2', 'Busy');
  await call(s.served, 'start', { workspace: 'app', ticket: 'N-1' });
  await waitFor(s.served, 'N-1', 'awaiting_review');
  await call(s.served, 'start', { workspace: 'app', ticket: 'N-2' });
  await turnsStarted(s.env, 2);
  const lock = await sandboxLock(s.repo);
  await call(s.served, 'mark_clean', { workspace: 'app', ticket: 'N-1' });
  await waitFor(s.served, 'N-1', 'ready_for_human_review');
  const ready = await job(s, 'N-1');
  assert.deepEqual(ready.handoff_skipped, { code: 'config_locked', message: 'Another job of this workspace is running; the hand-over runs when it ends.' });
  assert.equal(await exists(lock), true);
  assert.deepEqual([head(s.repo), status(s.repo), config(s.repo, 'commit.template')], ['refs/heads/main', '', null]);
  assert.deepEqual(await lockEvents(s, 'N-1'), []);
  assert.match((await runCli(s.env, ['status', 'app', 'N-1'])).stdout, /not handed over to your checkout: Another job of this workspace is running; the hand-over runs when it ends\. \(config_locked\)/);

  // N-2 leaves working: N-1 is handed over without anyone asking.
  const aborted = await runCli(s.env, ['abort', 'app', 'N-2']);
  assert.equal(aborted.code, 0, aborted.stdout + aborted.stderr);
  const handed = await waitState(s, 'N-1', 'handed_over');
  assert.equal(handed.state, 'handed_over');
  assert.equal(await exists(lock), false);
  assert.equal(head(s.repo), 'refs/heads/N-1-hand-it-over');
  assert.equal(config(s.repo, 'commit.cleanup'), 'scissors');
  assert.equal((await job(s, 'N-1')).handoff_skipped, undefined);
  // The abort of N-2 ended the last running session: the lock went then, logged in N-2's log.
  assert.deepEqual((await lockEvents(s, 'N-2')).map((event) => event.path), [lock]);
  assert.deepEqual(await lockEvents(s, 'N-1'), []);
  await stop(s.served);
});

test('the sandbox\'s leftover config lock (SF-085) is kept while another job of the workspace is in preparing_mr, whose MR turn runs under the sandbox; removed once it has left', async () => {
  const s = await setup('lockmr', { SF_HANDOFF: 'off' });
  await script(s.env, [
    { write: { 'README.md': 'preparing\n' }, text: 'iteration 1' },
    { delayMs: 60_000, ...mrTurn('R-1') },
    { write: { 'other.txt': 'o\n' }, text: 'the other job' },
    { write: { 'more.txt': 'm\n' }, text: 'the other job again' },
  ]);
  await toClean(s, 'R-1');
  await turnsStarted(s.env, 2);
  assert.equal((await job(s, 'R-1')).state, 'preparing_mr');
  const lock = await sandboxLock(s.repo);
  await putTask(s.env, s.repo, 'R-2', 'Other');
  await call(s.served, 'start', { workspace: 'app', ticket: 'R-2' });
  await waitFor(s.served, 'R-2', 'awaiting_review');
  assert.equal(await exists(lock), true);
  assert.deepEqual(await lockEvents(s, 'R-2'), []);

  // R-1 leaves preparing_mr: R-2's next turn end removes the lock.
  const aborted = await runCli(s.env, ['abort', 'app', 'R-1']);
  assert.equal(aborted.code, 0, aborted.stdout + aborted.stderr);
  const said = await runCli(s.env, ['say', 'app', 'R-2', 'one more']);
  assert.equal(said.code, 0, said.stdout + said.stderr);
  await waitFor(s.served, 'R-2', 'awaiting_review', 2);
  assert.equal(await exists(lock), false);
  assert.deepEqual((await lockEvents(s, 'R-2')).map((event) => [event.path, event.iteration]), [[lock, 2]]);
  await stop(s.served);
});

test('an Implementer session stopped by abort or pause (SF-085): the stale sandbox lock is kept while another job of the workspace works, removed once none runs, an event in the stopped job\'s log', async () => {
  const s = await setup('lockstop', { SF_HANDOFF: 'off' });
  await script(s.env, [{ delayMs: 60_000, write: { 'a.txt': 'a\n' } }, { delayMs: 60_000, write: { 'b.txt': 'b\n' } }]);
  await putTask(s.env, s.repo, 'U-1', 'Aborted');
  await putTask(s.env, s.repo, 'U-2', 'Paused');
  await call(s.served, 'start', { workspace: 'app', ticket: 'U-1' });
  await call(s.served, 'start', { workspace: 'app', ticket: 'U-2' });
  await turnsStarted(s.env, 2);
  const lock = await sandboxLock(s.repo);

  // U-2 still works: the abort of U-1 leaves the lock.
  const aborted = await runCli(s.env, ['abort', 'app', 'U-1']);
  assert.equal(aborted.code, 0, aborted.stdout + aborted.stderr);
  assert.equal(await exists(lock), true);
  assert.deepEqual(await lockEvents(s, 'U-1'), []);

  // The pause stops the last running session: the lock goes.
  const paused = await runCli(s.env, ['pause', 'app', 'U-2']);
  assert.equal(paused.code, 0, paused.stdout + paused.stderr);
  assert.equal((await job(s, 'U-2')).state, 'paused');
  assert.equal(await exists(lock), false);
  assert.deepEqual((await lockEvents(s, 'U-2')).map((event) => [event.path, event.iteration]), [[lock, 1]]);
  await stop(s.served);
});
