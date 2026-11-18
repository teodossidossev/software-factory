// End-to-end test of an important job (Task front matter important: true): SF_MAX_ITERATIONS,
// SF_GATE_MAX_ROUNDS and the gate budget never stop it, and its rounds without progress are still
// counted (stalled_fixes, gate_stalled). In a file of its own: test/gate-limits.test.ts runs near
// run-tests' per-file limit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { writeTask } from '../src/task-file.js';
import { call, codexScript, newEnv, newRepo, reviewScript, script, serve, stop, task, waitFor } from './support/harness.js';
import { CLAUDE_CLEAN, GATE_CLEAN, GATE_FIX, gateEnv, mrText, taskFile } from './support/gate.js';

test('important: true under SF_MAX_ITERATIONS=1, SF_GATE_MAX_ROUNDS=1 and SF_GATE_MAX_TOKENS=1: three gate fixes in a row, two without progress, then clean reach ready_for_human_review', async () => {
  const env = await newEnv('important-flow', gateEnv({ SF_MAX_ITERATIONS: '1', SF_GATE_MAX_ROUNDS: '1', SF_GATE_MAX_TOKENS: '1' }));
  const repo = await newRepo(env, 'important-flow-repo', false);
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, 'IM-2', task('IM-2', 'Important').replace('base: main\n', 'base: main\nimportant: true\n'), new JobStore(env.state));
  await script(env, [
    { write: { 'a.txt': '1\n' } },
    { write: { 'a.txt': '2\n' }, text: '| R1 | fixed | Done. |' },
    { write: { 'a.txt': '3\n' }, text: '| R2 | fixed | Done. |' },
    { write: { 'a.txt': '4\n' }, text: '| R3 | fixed | Done. |' },
    { write: { '.software-factory/IM-2.mr.md': mrText('feat(IM-2): Important') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_CLEAN }, { output: CLAUDE_CLEAN }, { output: CLAUDE_CLEAN }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_FIX }, { output: GATE_FIX }, { output: GATE_FIX }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'IM-2' });
    await waitFor(served, 'IM-2', 'ready_for_human_review', 4);
    assert.deepEqual((await taskFile(repo, 'IM-2')).match(/^## Fix \d+$/gm), ['## Fix 1', '## Fix 2', '## Fix 3']);
    const job = (await new JobStore(env.state).read('app', 'IM-2'))!;
    assert.equal(job.important, true);
    assert.deepEqual([job.stalled_fixes, job.gate_stalled], [2, 2]);
  } finally {
    await stop(served);
  }
});
