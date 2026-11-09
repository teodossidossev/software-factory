// End-to-end tests of the hand-over to the user's checkout (SF-073) on real repositories: a work
// checkout cloned from a bare origin, the job's worktree, the fake Claude Code as the Implementer.
// SF_HANDOFF=checkout here (the harness turns it off for every other test); a workspace's own
// handoff in workspaces.json wins over it (SF-083).
// recover() of a hand-over and the sandbox's leftover config lock (SF-085) are
// test/handoff-recover.test.ts's (SF-152: one file ran near run-tests' per-file limit).
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { handoffOffNotice } from '../src/config.js';
import { mrMessage } from '../src/mr.js';
import { saveRegistry } from '../src/registry.js';
import { call, fakeLog, git, putTask, readyCheck, refused, runCli, script, stop, turnsStarted, waitFor } from './support/harness.js';
import { config, exists, gitCode, head, job, mrText, mrTurn, refusedSocket, remoteTip, rev, setup, status, toClean, worktreeOf } from './support/handoff.js';

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
  // handed_over is not running (SF-071): with the run limit 1 (SF_MAX_JOBS=1) the queue starts another job.
  await putTask(s.env, s.repo, 'H-2', 'Other');
  await readyCheck(s.env, s.repo, 'H-2');
  assert.equal((await runCli(s.env, ['queue', 'add', 'app', 'H-2'])).code, 0);
  for (const deadline = Date.now() + 20_000; (await s.jobs.read('app', 'H-2')) === undefined;) {
    assert.ok(Date.now() < deadline, 'H-2 did not start');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
  // A workspace without its own handoff follows SF_HANDOFF, and the notice names it (SF-083).
  assert.deepEqual([ready.worktree, ready.handoff_skipped, ready.handover], [worktreeOf(s.env, 'O-1'), { code: 'handoff_off', message: 'O-1: ready; hand-over off (SF_HANDOFF=off)' }, undefined]);
  assert.equal(head(s.repo), 'refs/heads/main');
  const pushed = await runCli(s.env, ['approve', 'app', 'O-1']);
  assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
  assert.equal(remoteTip(s.origin, 'O-1-hand-it-over'), ready.prepared_commit);
  assert.equal(await exists(worktreeOf(s.env, 'O-1')), false);
  assert.equal((await job(s, 'O-1')).worktree, null);
  await stop(s.served);
});

test('handoffOffNotice (SF-083): the workspace\'s handoff wins over SF_HANDOFF; without it SF_HANDOFF decides; off names the setting that decided', () => {
  const workspaceOff = { code: 'handoff_off', message: 'T-1: ready; hand-over off for this workspace (handoff "off" in workspaces.json)' };
  const globalOff = { code: 'handoff_off', message: 'T-1: ready; hand-over off (SF_HANDOFF=off)' };
  assert.deepEqual(handoffOffNotice('off', 'checkout', 'T-1'), workspaceOff);
  assert.deepEqual(handoffOffNotice('off', 'off', 'T-1'), workspaceOff);
  assert.equal(handoffOffNotice('checkout', 'off', 'T-1'), undefined);
  assert.equal(handoffOffNotice('checkout', 'checkout', 'T-1'), undefined);
  assert.equal(handoffOffNotice(undefined, 'checkout', 'T-1'), undefined);
  assert.deepEqual(handoffOffNotice(undefined, 'off', 'T-1'), globalOff);
});

test('a workspace with handoff "off" under SF_HANDOFF=checkout (SF-083), set while sf serve runs: the job stays in ready_for_human_review with its worktree, the checkout untouched, and sf status names the workspace\'s setting', async () => {
  const s = await setup('ws-handoff-off');
  await saveRegistry({ workspaces: { app: { read_checkout: s.repo, handoff: 'off' } } }, s.env.config);
  await script(s.env, [{ write: { 'README.md': 'workspace off\n' }, text: 'iteration 1' }, mrTurn('P-1')]);
  await toClean(s, 'P-1');
  await waitFor(s.served, 'P-1', 'ready_for_human_review');
  const ready = await job(s, 'P-1');
  assert.deepEqual(
    [ready.worktree, ready.handoff_skipped, ready.handover],
    [worktreeOf(s.env, 'P-1'), { code: 'handoff_off', message: 'P-1: ready; hand-over off for this workspace (handoff "off" in workspaces.json)' }, undefined],
  );
  assert.deepEqual([head(s.repo), status(s.repo), git(s.repo, 'for-each-ref', 'refs/factory/')], ['refs/heads/main', '', '']);
  const shown = await runCli(s.env, ['status', 'app', 'P-1']);
  assert.equal(shown.code, 0, shown.stdout + shown.stderr);
  assert.match(shown.stdout, /not handed over to your checkout: P-1: ready; hand-over off for this workspace \(handoff "off" in workspaces\.json\) \(handoff_off\); sf handover hands it over/);
  await stop(s.served);
});

test('a workspace with handoff "checkout" under SF_HANDOFF=off (SF-083): the job is handed over to its checkout', async () => {
  const s = await setup('ws-handoff-on', { SF_HANDOFF: 'off' });
  await saveRegistry({ workspaces: { app: { read_checkout: s.repo, handoff: 'checkout' } } }, s.env.config);
  await script(s.env, [{ write: { 'README.md': 'workspace on\n' }, text: 'iteration 1' }, mrTurn('Q-1')]);
  await toClean(s, 'Q-1');
  await waitFor(s.served, 'Q-1', 'handed_over');
  const handed = await job(s, 'Q-1');
  assert.deepEqual([handed.handoff_skipped, handed.worktree, head(s.repo)], [undefined, null, 'refs/heads/Q-1-hand-it-over']);
  await stop(s.served);
});

test('Ask for changes: not held by the run limit while another job runs, refused with checkout_moved off the branch, nothing changed; then the user\'s edit and new file reach the worktree, refs/factory/<ticket>-ask holds them, the checkout is back on main without leftovers, and the next ready hands over again', async () => {
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

  // A job runs and the run limit is 1 (SF_MAX_JOBS=1): Ask for changes is the user's own, so the
  // limit does not hold it (SF-071); it goes on below while A-2 runs.
  await putTask(s.env, s.repo, 'A-2', 'Busy');
  await call(s.served, 'start', { workspace: 'app', ticket: 'A-2' });
  await turnsStarted(s.env, 3);

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
  assert.ok(['working', 'awaiting_review'].includes((await job(s, 'A-2')).state));
  await waitFor(s.served, 'A-2', 'awaiting_review');
  await runCli(s.env, ['abort', 'app', 'A-2']);
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
