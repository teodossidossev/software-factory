// Merged — archive (sf handed-done --merged, Execution.markMerged) on real repositories: the user
// merged a job's changes (any way; the branch may be gone). A handed-over job goes to pushed first
// (handover_marked_done; the checkout's commit settings go back as on a push); then the pushed job
// gets merged_on_target (how user, commit null, once) and is archived with its Task file. Origin is
// never asked; the user's branch, commits and edits stay.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkTransition, JOB_TRANSITIONS } from '../src/jobs.js';
import { call, git, putTask, runCli, script, stop, temp, waitFor } from './support/harness.js';
import { config, exists, head, job, mrTurn, refusedSocket, rev, setup, status, toClean } from './support/handoff.js';
import { archivedDirs, handedOver, localConfig, loggedCommands, mergedEvents, pushedBranch, pushedJob, recordingGit, WRITES, world } from './support/merged.js';

const TIMEOUT = { timeout: 60_000 };
const USER_MARK = { commit: null, target: 'main', how: 'user' };

test('the transition of Merged — archive\'s first step: handed_over to pushed, by marked_done only', () => {
  assert.deepEqual(JOB_TRANSITIONS.filter((row) => row.action === 'marked_done'), [{ from: 'handed_over', to: 'pushed', action: 'marked_done' }]);
  checkTransition('handed_over', 'pushed', 'marked_done');
});

test('sf handed-done --merged: a handed-over job is marked merged and archived without asking origin, with handover_marked_done and the commit template gone; the checkout\'s branch, commits and edits stay; a job of another state is invalid_state', async () => {
  const s = await setup('handmerged');
  await script(s.env, [{ write: { 'README.md': 'merged elsewhere\n', 'added.txt': 'added\n' }, text: 'iteration 1' }, mrTurn('M-1'), { write: { 'two.txt': 'two\n' }, text: 'iteration 1' }]);
  await toClean(s, 'M-1');
  await waitFor(s.served, 'M-1', 'handed_over');
  const handed = await job(s, 'M-1');
  const branch = 'M-1-hand-it-over';
  const template = config(s.repo, 'commit.template')!;
  assert.equal(await exists(template), true);
  assert.equal(config(s.repo, 'commit.cleanup'), 'scissors');
  const before = { head: head(s.repo), tip: rev(s.repo, 'HEAD'), status: status(s.repo) };
  assert.equal(before.head, `refs/heads/${branch}`);

  // Origin fails whenever it is asked: plain handed-done says so, --merged never asks.
  git(s.repo, 'remote', 'set-url', 'origin', join(temp, 'handmerged-nowhere.git'));
  assert.equal((await refusedSocket(s, 'handed-done', ['app', 'M-1'])).code, 'push_check_failed');
  const done = await runCli(s.env, ['handed-done', 'app', 'M-1', '--merged']);
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /^state: pushed$/m);

  // The ticket has no current job; the archived one is pushed, as handed over, marked once.
  assert.equal(await s.jobs.read('app', 'M-1'), undefined);
  const [dir, ...more] = await archivedDirs(s, 'M-1');
  assert.deepEqual(more, []);
  assert.deepEqual([dir!.job.state, dir!.job.prepared_commit, dir!.job.handover], ['pushed', handed.prepared_commit, undefined]);
  assert.equal(dir!.events.filter((event) => event.type === 'handover_marked_done').length, 1);
  assert.equal(dir!.events.filter((event) => event.type === 'handover_pushed').length, 0);
  assert.deepEqual(dir!.events.filter((event) => event.state !== undefined).at(-1)?.state, { from: 'handed_over', to: 'pushed' });
  assert.deepEqual(mergedEvents(dir), [USER_MARK]);
  // The Task file went to the archive.
  assert.deepEqual(await readdir(join(s.repo, '.software-factory', 'archive')), ['M-1.md']);
  // The commit settings and the prefilled message go back as on a push.
  assert.deepEqual([config(s.repo, 'commit.template'), config(s.repo, 'commit.cleanup')], [null, null]);
  assert.equal(await exists(template), false);
  // The user's branch, commits and uncommitted edits are as they were.
  assert.deepEqual({ head: head(s.repo), tip: rev(s.repo, 'HEAD'), status: status(s.repo) }, before);

  // The job is gone: a second handed-done, with or without --merged, finds none.
  assert.equal((await refusedSocket(s, 'handed-done', ['app', 'M-1', '--merged'])).code, 'job_not_found');
  assert.equal((await refusedSocket(s, 'handed-done', ['app', 'M-1'])).code, 'job_not_found');
  // A job that is neither handed over nor pushed: refused, nothing changes (its start needs origin).
  git(s.repo, 'remote', 'set-url', 'origin', s.origin);
  await putTask(s.env, s.repo, 'M-2', 'Two');
  await call(s.served, 'start', { workspace: 'app', ticket: 'M-2' });
  await waitFor(s.served, 'M-2', 'awaiting_review');
  assert.deepEqual(await refusedSocket(s, 'handed-done', ['app', 'M-2', '--merged']), {
    code: 'invalid_state', message: 'Merged — archive needs a handed-over or pushed job; it is awaiting_review.',
  });
  assert.equal((await job(s, 'M-2')).state, 'awaiting_review');
  await stop(s.served);
});

test('markMerged in process: a handed-over job sends no Git command to origin; a pushed job gets one merged_on_target and is archived with its Task file; a job already marked gets no second one; the branches stay', TIMEOUT, async () => {
  const w = await world('mark-merged');
  const commit = pushedBranch(w, 'P-1-one', 'one.txt');
  const two = pushedBranch(w, 'P-2-two', 'two.txt');
  await putTask(w.env, w.repo, 'P-1', 'One');
  await w.jobs.write(pushedJob('P-1', 'P-1-one', commit));
  // P-2 was marked before its Archive failed: the second Merged — archive archives it, unmarked again.
  await w.jobs.write(pushedJob('P-2', 'P-2-two', two));
  await w.jobs.appendEvent('app', 'P-2', { ts: new Date().toISOString(), iteration: 1, type: 'merged_on_target', commit: null, target: 'main', how: 'user' });
  await w.jobs.write(await handedOver(w, 'H-1', 'H-1-hand'));
  const refs = git(w.repo, 'for-each-ref', '--format=%(refname) %(objectname)');
  const recorder = await recordingGit(w.env);
  try {
    const handed = await w.execution.markMerged('app', 'H-1');
    assert.deepEqual([handed.state, handed.branch, /^jobs\/app\/H-1\.\d{8}T\d{6}Z$/.test(handed.archived)], ['pushed', 'H-1-hand', true]);
    assert.equal((await w.execution.markMerged('app', 'P-1')).state, 'pushed');
    assert.equal((await w.execution.markMerged('app', 'P-2')).state, 'pushed');
  } finally {
    recorder.restore();
  }
  const commands = await loggedCommands(recorder.log);
  assert.ok(commands.every(({ command }) => !/^(fetch|ls-remote|push|pull|remote)\b/.test(command) && !WRITES.test(command)), JSON.stringify(commands));
  for (const ticket of ['H-1', 'P-1', 'P-2']) {
    assert.equal(await w.jobs.read('app', ticket), undefined, ticket);
    const dirs = await archivedDirs(w, ticket);
    assert.equal(dirs.length, 1, ticket);
    assert.deepEqual(mergedEvents(dirs[0]), [USER_MARK], ticket);
    assert.equal(dirs[0]!.events.filter((event) => event.type === 'handover_marked_done').length, ticket === 'H-1' ? 1 : 0, ticket);
  }
  assert.deepEqual([localConfig(w.repo, 'commit.template'), localConfig(w.repo, 'commit.cleanup')], [null, null]);
  assert.deepEqual(await readdir(join(w.repo, '.software-factory', 'archive')), ['P-1.md']);
  // No branch or commit went, local or on origin; the checkout stays on the handed-over branch.
  assert.equal(git(w.repo, 'for-each-ref', '--format=%(refname) %(objectname)'), refs);
  assert.equal(git(w.repo, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/H-1-hand');
  // Any other state: invalid_state, nothing written.
  await w.jobs.write({ ...pushedJob('P-3', 'P-3-three', commit), state: 'failed' });
  await assert.rejects(w.execution.markMerged('app', 'P-3'), (error: Error & { code?: string }) => error.code === 'invalid_state' && error.message === 'Merged — archive needs a handed-over or pushed job; it is failed.');
  assert.equal((await w.jobs.read('app', 'P-3'))?.state, 'failed');
  assert.equal((await readFile(w.jobs.eventsPath('app', 'P-3'), 'utf8').catch(() => '')).includes('merged_on_target'), false);
});
