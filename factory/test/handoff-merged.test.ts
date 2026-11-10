// Merged another way (sf handed-done --merged) on real repositories: the user merged a handed-over
// job's changes themselves, under another branch or straight into the main branch. Origin is
// never asked; the checkout's commit settings go back as on a push; the user's branch, commits
// and edits stay.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkTransition, JOB_TRANSITIONS } from '../src/jobs.js';
import { git, runCli, script, stop, temp, waitFor } from './support/harness.js';
import { config, exists, head, job, mrTurn, refusedSocket, rev, setup, status, toClean } from './support/handoff.js';

test('the transition of Merged another way: handed_over to pushed, by marked_done only', () => {
  assert.deepEqual(JOB_TRANSITIONS.filter((row) => row.action === 'marked_done'), [{ from: 'handed_over', to: 'pushed', action: 'marked_done' }]);
  checkTransition('handed_over', 'pushed', 'marked_done');
});

test('sf handed-done --merged: a handed-over job goes to pushed without asking origin, with the event handover_marked_done and the commit template gone; the checkout\'s branch, commits and edits stay; any other state is invalid_state as with handed-done', async () => {
  const s = await setup('handmerged');
  await script(s.env, [{ write: { 'README.md': 'merged elsewhere\n', 'added.txt': 'added\n' }, text: 'iteration 1' }, mrTurn('M-1')]);
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

  const marked = await job(s, 'M-1');
  assert.deepEqual([marked.state, marked.prepared_commit, marked.handover], ['pushed', handed.prepared_commit, undefined]);
  // The commit settings and the prefilled message go back as on a push.
  assert.deepEqual([config(s.repo, 'commit.template'), config(s.repo, 'commit.cleanup')], [null, null]);
  assert.equal(await exists(template), false);
  // The user's branch, commits and uncommitted edits are as they were.
  assert.deepEqual({ head: head(s.repo), tip: rev(s.repo, 'HEAD'), status: status(s.repo) }, before);
  const events = (await readFile(s.jobs.eventsPath('app', 'M-1'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type?: string; state?: { from: string; to: string } });
  assert.equal(events.filter((event) => event.type === 'handover_marked_done').length, 1);
  assert.equal(events.filter((event) => event.type === 'handover_pushed').length, 0);
  assert.deepEqual(events.filter((event) => event.state !== undefined).at(-1)?.state, { from: 'handed_over', to: 'pushed' });

  // A job that is not handed over: refused as handed-done refuses it.
  assert.deepEqual(await refusedSocket(s, 'handed-done', ['app', 'M-1', '--merged']), { code: 'invalid_state', message: 'sf handed-done --merged needs handed_over; the job is pushed.' });
  assert.deepEqual(await refusedSocket(s, 'handed-done', ['app', 'M-1']), { code: 'invalid_state', message: 'sf handed-done needs handed_over; the job is pushed.' });
  await stop(s.served);
});

