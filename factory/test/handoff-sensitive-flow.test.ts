// End-to-end tests of the check before the automatic hand-over: a change to a file the user's IDE
// or tools run (here .vscode/tasks.json) waits in ready_for_human_review with handoff_sensitive and
// the checkout untouched, until the user hands it over; a change without one is handed over at
// once. On real repositories with SF_HANDOFF=checkout, as test/handoff.test.ts.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { call, git, putTask, runCli, script, stop, waitFor } from './support/harness.js';
import { exists, head, job, mrTurn, setup, status, toClean, worktreeOf } from './support/handoff.js';

test('a change to .vscode/tasks.json: ready_for_human_review with handoff_sensitive naming it, the checkout unchanged; sf handover then hands it over', async () => {
  const s = await setup('handsens');
  await script(s.env, [
    { write: { 'README.md': 'job\n', '.vscode/tasks.json': '{"version":"2.0.0","tasks":[]}\n' }, text: 'iteration 1' },
    mrTurn('V-1'),
  ]);
  await putTask(s.env, s.repo, 'V-1', 'Hand it over');
  await call(s.served, 'start', { workspace: 'app', ticket: 'V-1' });
  await waitFor(s.served, 'V-1', 'awaiting_review');
  // The reviewer accepts the undeclared sensitive path; the hand-over still waits for a person.
  await call(s.served, 'mark_clean', { workspace: 'app', ticket: 'V-1', sensitive: ['.vscode/tasks.json'] });
  await waitFor(s.served, 'V-1', 'ready_for_human_review');
  const ready = await job(s, 'V-1');
  assert.deepEqual(ready.handoff_skipped, {
    code: 'handoff_sensitive',
    message: 'it changes files your IDE or tools may run: .vscode/tasks.json; read them, then hand it over',
  });
  assert.deepEqual([ready.worktree, ready.handover], [worktreeOf(s.env, 'V-1'), undefined]);
  // The checkout is as it was: on main, no change, no saved ref, no file of the job.
  assert.equal(head(s.repo), 'refs/heads/main');
  assert.equal(status(s.repo), '');
  assert.equal(git(s.repo, 'for-each-ref', 'refs/factory/'), '');
  assert.equal(await exists(join(s.repo, '.vscode', 'tasks.json')), false);
  assert.match((await runCli(s.env, ['status', 'app', 'V-1'])).stdout, /not handed over to your checkout: it changes files your IDE or tools may run: \.vscode\/tasks\.json; read them, then hand it over \(handoff_sensitive\)/);

  // The person's hand-over runs no check.
  const handed = await runCli(s.env, ['handover', 'app', 'V-1']);
  assert.equal(handed.code, 0, handed.stdout + handed.stderr);
  assert.match(handed.stdout, /^state: handed_over$/m);
  const after = await job(s, 'V-1');
  assert.deepEqual([after.state, after.handoff_skipped, after.worktree], ['handed_over', undefined, null]);
  assert.equal(head(s.repo), 'refs/heads/V-1-hand-it-over');
  assert.equal(await readFile(join(s.repo, '.vscode', 'tasks.json'), 'utf8'), '{"version":"2.0.0","tasks":[]}\n');
  await stop(s.served);
});

test('a change to src/ only is handed over at ready, as without the check', async () => {
  const s = await setup('handplain');
  await script(s.env, [{ write: { 'src/a.ts': 'export const a = 1;\n' }, text: 'iteration 1' }, mrTurn('P-1')]);
  await toClean(s, 'P-1');
  await waitFor(s.served, 'P-1', 'handed_over');
  const handed = await job(s, 'P-1');
  assert.deepEqual([handed.handoff_skipped, handed.worktree], [undefined, null]);
  assert.equal(head(s.repo), 'refs/heads/P-1-hand-it-over');
  assert.equal(status(s.repo), ' A src/a.ts\n');
  await stop(s.served);
});
