// End-to-end tests of the Codex gate (SF-039), split from test/gate.test.ts (SF-152: one file ran
// near run-tests' per-file limit): the round limit, the token ceiling, failures, abort and serve
// restart during a gate, the gate off, sf accept after the gate, the prompt's <user_decisions>,
// and runGate on its own inside its wrapper (SF-125). The shared helpers are test/support/gate.ts's.
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GATE_OUTPUT_FILE, GATE_SANDBOX_UNAVAILABLE, gateArgs, gateEnvironment, type GateOptions, gatePrompt, runGate } from '../src/gate.js';
import { JobStore } from '../src/jobs.js';
import { PACKAGE_ROOT } from '../src/package-root.js';
import { handbookSection } from '../src/prompts.js';
import { reviewPrompt } from '../src/review.js';
import { loadHandbook } from '../src/server.js';
import { fetchRaw } from './support/dashboard-client.js';
import { call, codexLog, codexScript, fakeLog, git, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, temp, waitFor } from './support/harness.js';
import { alive, CLAUDE_CLEAN, eventsOf, exists, GATE_CLEAN, GATE_FIX, gateEnv, iterationDir, mrText, taskFile, until } from './support/gate.js';

test('SF_GATE_MAX_ROUNDS=1: the second fix of the gate is not applied; needs_human gate_rounds with both summaries', async () => {
  const env = await newEnv('gate-rounds', gateEnv({ SF_GATE_MAX_ROUNDS: '1' }));
  const repo = await newRepo(env, 'gate-rounds-repo', false);
  await putTask(env, repo, 'G-3', 'Rounds');
  await script(env, [{ write: { 'a.txt': '1\n' } }, { write: { 'a.txt': '2\n' }, text: '| R1 | fixed | Done. |' }]);
  await reviewScript(env, [{ output: CLAUDE_CLEAN }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_FIX }, { output: { ...GATE_FIX, summary: 'Still wrong.' } }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-3' });
    const limited = await waitFor(served, 'G-3', 'needs_human', 2);
    assert.equal(limited.error.code, 'gate_rounds');
    assert.match(limited.error.message, /SF_GATE_MAX_ROUNDS \(1\)/);
    assert.ok(limited.error.message.includes(`Claude: ${CLAUDE_CLEAN.summary}`), limited.error.message);
    assert.ok(limited.error.message.includes('Codex: Still wrong.'), limited.error.message);
    assert.deepEqual((await taskFile(repo, 'G-3')).match(/^## Fix \d+$/gm), ['## Fix 1']);
    assert.equal((await new JobStore(env.state).read('app', 'G-3'))!.gate_fixes, 1);
    assert.equal((await fakeLog(env)).length, 2);
  } finally {
    await stop(served);
  }
});

test('SF_GATE_MAX_ROUNDS=1 in a joint round: the gate\'s fix at the limit beside a Claude fix makes Claude\'s Fix section alone, no gate_rounds stop, gate_fixes unchanged', async () => {
  const env = await newEnv('gate-rounds-claude', gateEnv({ SF_GATE_MAX_ROUNDS: '1' }));
  const repo = await newRepo(env, 'gate-rounds-claude-repo', false);
  await putTask(env, repo, 'G-13', 'Rounds');
  await script(env, [
    { write: { 'a.txt': '1\n' } }, { write: { 'a.txt': '2\n' }, text: '| R1 | fixed | Done. |' }, { write: { 'b.txt': '1\n' }, text: '| R2 | fixed | Done. |' },
    { write: { '.software-factory/G-13.mr.md': mrText('feat(G-13): Rounds') }, text: 'prepared' },
  ]);
  const claudeFix = { verdict: 'fix', summary: 'b.txt is missing.', items: [{ path: 'b.txt', problem: 'Missing.', expected: 'A file.', severity: 'major' }], accepted_sensitive: [] };
  await reviewScript(env, [{ output: CLAUDE_CLEAN }, { output: claudeFix }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_FIX }, { output: { ...GATE_FIX, summary: 'Still wrong.' } }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-13' });
    await waitFor(served, 'G-13', 'ready_for_human_review', 3);
    assert.ok((await taskFile(repo, 'G-13')).includes('## Fix 2\n\nReview by Claude: b.txt is missing.\n\n1. [R2, major] `b.txt`: Missing. Expected: A file.\n'));
    const job = (await new JobStore(env.state).read('app', 'G-13'))!;
    assert.deepEqual([job.fixes, job.gate_fixes], [2, 1]);
    // The gate's item of iteration 2 got no ledger entry.
    assert.deepEqual((await new JobStore(env.state).readLedger('app', 'G-13')).map((entry) => [entry.id, entry.reviewer]), [['R1', 'codex'], ['R2', 'claude']]);
    assert.ok(!(await eventsOf(env, 'G-13')).some((record) => (record.state as { to?: string } | undefined)?.to === 'needs_human'));
  } finally {
    await stop(served);
  }
});

test('SF_GATE_MAX_TOKENS in a joint round: at the limit no gate starts and the Claude review runs alone: a fix is its Fix section, a clean verdict ends in gate_budget', async () => {
  const env = await newEnv('gate-budget-claude', gateEnv({ SF_GATE_MAX_TOKENS: '1000' }));
  const repo = await newRepo(env, 'gate-budget-claude-repo', false);
  await putTask(env, repo, 'B-3', 'At the limit');
  await script(env, [{ write: { 'a.txt': '1\n' } }, { write: { 'a.txt': '2\n' }, text: '| R1 | fixed | Done. |' }, { write: { 'b.txt': '1\n' }, text: '| R2 | fixed | Done. |' }]);
  const claudeFix = { verdict: 'fix', summary: 'b.txt is missing.', items: [{ path: 'b.txt', problem: 'Missing.', expected: 'A file.', severity: 'major' }], accepted_sensitive: [] };
  await reviewScript(env, [{ output: CLAUDE_CLEAN }, { output: claudeFix }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_FIX, usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 100 } }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'B-3' });
    const stopped = await waitFor(served, 'B-3', 'needs_human', 3);
    assert.equal(stopped.error.code, 'gate_budget');
    assert.match(stopped.error.message, /used 1000 tokens, the limit of SF_GATE_MAX_TOKENS \(1000\)/);
    assert.ok((await taskFile(repo, 'B-3')).includes('## Fix 2\n\nReview by Claude: b.txt is missing.\n\n1. [R2, major] `b.txt`: Missing. Expected: A file.\n'));
    assert.deepEqual([(await codexLog(env)).length, (await reviewLog(env)).length], [1, 3]);
  } finally {
    await stop(served);
  }
});

test('SF_GATE_MAX_TOKENS: a run that pushes the job over is not applied, and no run starts once the job is at the limit (gate_budget)', async () => {
  const env = await newEnv('gate-budget', gateEnv({ SF_GATE_MAX_TOKENS: '1000' }));
  const repo = await newRepo(env, 'gate-budget-repo', false);
  await script(env, [{ write: { 'a.txt': '1\n' } }, { write: { 'a.txt': '2\n' }, text: '| R1 | fixed | Done. |' }, { write: { 'b.txt': '1\n' } }]);
  await codexScript(env, [
    { output: GATE_FIX, usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 100 } },
    { output: GATE_CLEAN, usage: { input_tokens: 1400, cached_input_tokens: 1000, output_tokens: 100 } },
  ]);
  const served = await serve(env);
  try {
    // At the limit after its first run: the fix applies, the next gate does not start.
    await putTask(env, repo, 'B-1', 'At the limit');
    await call(served, 'start', { workspace: 'app', ticket: 'B-1' });
    const refused = await waitFor(served, 'B-1', 'needs_human', 2);
    assert.equal(refused.error.code, 'gate_budget');
    assert.match(refused.error.message, /used 1000 tokens, the limit of SF_GATE_MAX_TOKENS \(1000\)/);
    assert.equal((await codexLog(env)).length, 1);
    assert.equal(await exists(join(iterationDir(env, 'B-1', 2), 'gate.json')), false);

    // Over the limit with its first run: the clean verdict is recorded, not applied.
    await putTask(env, repo, 'B-2', 'Over the limit');
    await call(served, 'start', { workspace: 'app', ticket: 'B-2' });
    const over = await waitFor(served, 'B-2', 'needs_human', 1);
    assert.equal(over.error.code, 'gate_budget');
    assert.match(over.error.message, /used 1500 tokens, over the limit/);
    assert.deepEqual(over.review.gate, { status: 'done', verdict: 'clean', summary: GATE_CLEAN.summary });
    assert.equal((await new JobStore(env.state).read('app', 'B-2'))!.gate_tokens, 1500);
  } finally {
    await stop(served);
  }
});

test('a failed gate (a non-zero exit, no output, an invalid output, an invalid verdict, an error event, a timeout) is needs_human gate_failed', async () => {
  const env = await newEnv('gate-failed', gateEnv({ SF_MAX_JOBS: '6', SF_GATE_TIMEOUT_MS: '2000' }));
  const repo = await newRepo(env, 'gate-failed-repo', false);
  const cases = [
    { run: { exitCode: 3 }, message: /^Codex exited with code 3: fake codex: something went wrong$/ },
    { run: { noOutput: true }, message: /^Codex wrote no output\.$/ },
    { run: { invalid: true }, message: /^Codex returned output that is not JSON: not json at all$/ },
    { run: { output: { ...GATE_CLEAN, verdict: 'maybe' } }, message: /^Codex returned an invalid verdict: verdict: / },
    { run: { error: 'stream disconnected' }, message: /^Codex reported an error: stream disconnected$/ },
    { run: { delayMs: 10_000 }, message: /^Codex timed out after 2000 ms and was stopped \(SIGTERM\)\.$/ },
  ];
  await script(env, cases.map((_, index) => ({ write: { [`f${index}.txt`]: 'f\n' } })));
  await codexScript(env, cases.map((entry) => entry.run));
  const served = await serve(env);
  try {
    for (const [index, entry] of cases.entries()) {
      const ticket = `F-${index + 1}`;
      await putTask(env, repo, ticket, `Fail ${index + 1}`);
      await call(served, 'start', { workspace: 'app', ticket });
      const failed = await waitFor(served, ticket, 'needs_human', 1);
      assert.equal(failed.error.code, 'gate_failed', JSON.stringify(failed.error));
      assert.match(failed.error.message, entry.message);
      assert.deepEqual(failed.review.gate, { status: 'failed', summary: failed.error.message });
      const recorded = await new JobStore(env.state).readGate('app', ticket, 1);
      assert.ok(recorded !== undefined && 'error' in recorded);
      assert.equal(recorded.error, failed.error.message);
      assert.doesNotMatch(await taskFile(repo, ticket), /## Fix/);
    }
    const timedOut = (await codexLog(env)).at(-1)!;
    assert.equal(alive(timedOut.pid), false);
    assert.match((await runCli(env, ['watch', 'app', 'F-2', '--once'])).stdout, /\[1\] review by codex failed: Codex wrote no output\.$/m);
  } finally {
    await stop(served);
  }
});

test('abort during a gate run kills Codex; its outcome is never applied', async () => {
  const env = await newEnv('gate-abort', gateEnv());
  const repo = await newRepo(env, 'gate-abort-repo', false);
  await putTask(env, repo, 'A-1', 'Abort');
  await script(env, [{ write: { 'a.txt': 'a\n' } }]);
  await codexScript(env, [{ delayMs: 4000, output: GATE_FIX }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'A-1' });
    // In the joint round check shows the gate once Claude's verdict is stored.
    await until('the gate to run and the Claude review to end', async () => (await exists(join(env.home, 'fake-codex.log')))
      && (await new JobStore(env.state).readReview('app', 'A-1', 1)) !== undefined);
    const waiting = await call(served, 'check', { workspace: 'app', ticket: 'A-1' });
    assert.deepEqual([waiting.state, waiting.review.gate], ['awaiting_review', { status: 'running' }]);
    const [run] = await codexLog(env);
    assert.equal(alive(run!.pid), true);
    const aborted = await runCli(env, ['abort', 'app', 'A-1']);
    assert.equal(aborted.code, 0, aborted.stderr);
    await until('Codex to end', async () => !alive(run!.pid));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const checked = await call(served, 'check', { workspace: 'app', ticket: 'A-1' });
    assert.equal(checked.state, 'aborted');
    assert.equal(await new JobStore(env.state).readGate('app', 'A-1', 1), undefined);
    assert.equal(await exists(join(iterationDir(env, 'A-1', 1), 'gate-output.json')), false);
    assert.equal((await eventsOf(env, 'A-1')).filter((record) => record.reviewer === 'codex').length, 0);
  } finally {
    await stop(served);
  }
});

test('sf serve stopped during a gate run leaves the runner and Codex to finish, and a restarted one leaves them alone (SF-042); a runner killed during the gate: the next sf serve ends its Codex and runs the gate again', async () => {
  const env = await newEnv('gate-restart', gateEnv());
  const repo = await newRepo(env, 'gate-restart-repo', false);
  await putTask(env, repo, 'R-1', 'Restart');
  await putTask(env, repo, 'R-2', 'Killed');
  await script(env, [
    { write: { 'a.txt': 'a\n' } },
    { write: { '.software-factory/R-1.mr.md': mrText('feat(R-1): Restart') }, text: 'prepared' },
    { write: { 'b.txt': 'b\n' } },
    { write: { '.software-factory/R-2.mr.md': mrText('feat(R-2): Killed') }, text: 'prepared' },
  ]);
  await codexScript(env, [{ delayMs: 5_000, output: GATE_CLEAN }, { delayMs: 30_000 }, { output: GATE_CLEAN }]);
  const jobs = new JobStore(env.state);
  const lock = (ticket: string): string => join(env.state, 'jobs', 'app', ticket, 'runner.pid');

  // sf serve stops while the gate of R-1 runs: the runner goes on, Clean prepares the branch.
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-1' });
    await until('the gate to run', async () => (await exists(join(env.home, 'fake-codex.log'))));
  } finally {
    await stop(served);
  }
  const [first] = await codexLog(env);
  assert.ok(alive(first!.pid), 'Codex outlives sf serve');
  // A restarted sf serve leaves the review of the live runner alone: no second gate run.
  served = await serve(env);
  try {
    assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'R-1' })).state, 'awaiting_review');
    await waitFor(served, 'R-1', 'ready_for_human_review', 1);
  } finally {
    await stop(served);
  }
  assert.equal((await codexLog(env)).length, 1);
  assert.equal((await jobs.readGate('app', 'R-1', 1) as { verdict?: string }).verdict, 'clean');
  await until('the runner of R-1 to end', async () => !(await exists(lock('R-1'))));

  // The runner of R-2 is killed during its gate, Codex with it: the next sf serve starts the gate again.
  served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-2' });
    await until('the gate of R-2 to run', async () => (await codexLog(env)).length === 2);
  } finally {
    await stop(served);
  }
  const runner = Number((await readFile(lock('R-2'), 'utf8')).trim().split(' ')[0]);
  const second = (await codexLog(env))[1]!;
  process.kill(runner, 'SIGKILL');
  await until('the runner to end', async () => !alive(runner));
  assert.ok(alive(second.pid), 'Codex is left behind by the killed runner');
  assert.equal((await jobs.read('app', 'R-2'))!.state, 'awaiting_review');
  served = await serve(env);
  try {
    await until('the Codex of the killed runner to end', async () => !alive(second.pid));
    await waitFor(served, 'R-2', 'ready_for_human_review', 1);
    assert.equal((await codexLog(env)).length, 3);
    assert.equal((await reviewLog(env)).length, 2);
  } finally {
    await stop(served);
  }
});

test('gate off: SF_GATE=off, and SF_CODEX pointing at nothing (one line at sf serve), let the Claude verdict decide as in SF-038', async () => {
  for (const [name, extra, line, info] of [
    ['gate-off', { SF_GATE: 'off' }, undefined, /^gate {10}off \(SF_GATE=off\)$/m],
    ['gate-missing', { SF_CODEX: '/nonexistent/codex' }, /^gate: off \(SF_CODEX \/nonexistent\/codex is not an executable file\); the Claude review decides$/m, /^gate {10}off \(SF_CODEX \/nonexistent\/codex is not an executable file\)$/m],
  ] as const) {
    const env = await newEnv(name, gateEnv(extra));
    const repo = await newRepo(env, `${name}-repo`, false);
    await putTask(env, repo, 'O-1', 'Off');
    await script(env, [{ write: { 'o.txt': 'o\n' } }, { write: { '.software-factory/O-1.mr.md': mrText('feat(O-1): Off') }, text: 'prepared' }]);
    const served = await serve(env);
    try {
      if (line === undefined) {
        assert.doesNotMatch(served.output, /^gate:/m);
      } else {
        assert.match(served.output, line);
      }
      await call(served, 'start', { workspace: 'app', ticket: 'O-1' });
      const ready = await waitFor(served, 'O-1', 'ready_for_human_review', 1);
      assert.deepEqual(ready.review, { status: 'done', verdict: 'clean', summary: 'Looks right.' });
      assert.equal(await exists(join(env.home, 'fake-codex.log')), false);
      assert.equal(await exists(join(iterationDir(env, 'O-1', 1), 'gate.json')), false);
      // No gate level either (SF-092).
      assert.equal(await exists(join(iterationDir(env, 'O-1', 1), 'gate-level.json')), false);
      assert.equal((await eventsOf(env, 'O-1')).filter((record) => record.type === 'gate_level').length, 0);
      assert.match((await runCli(env, ['info'])).stdout, info);
    } finally {
      await stop(served);
    }
  }
});

test('sf accept (SF-047): after gate_rounds with a clean Claude review the job goes on to MR preparation; the override is recorded; refused otherwise', async () => {
  const env = await newEnv('gate-accept', gateEnv({ SF_GATE_MAX_ROUNDS: '1' }));
  const repo = await newRepo(env, 'gate-accept-repo', false);
  await putTask(env, repo, 'G-8', 'Accept over the gate');
  const stillWrong = { ...GATE_FIX, summary: 'Still wrong.', items: [{ path: 'a.txt', problem: 'A narrower variant.', expected: 'Even narrower.', severity: 'major' }] };
  await script(env, [
    { write: { 'a.txt': '1\n' } },
    { write: { 'a.txt': '2\n' }, text: '| R1 | fixed | Done. |' },
    { write: { '.software-factory/G-8.mr.md': mrText('feat(G-8): Accept over the gate') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_CLEAN }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_FIX }, { output: stillWrong }]);
  const served = await serve(env);
  try {
    // Refused while the job is not stopped by the gate.
    await call(served, 'start', { workspace: 'app', ticket: 'G-8' });
    const limited = await waitFor(served, 'G-8', 'needs_human', 2);
    assert.equal(limited.error.code, 'gate_rounds');

    // Refused without a clean Claude review of the last iteration: nothing recorded, nothing moves.
    const reviewPath = join(iterationDir(env, 'G-8', 2), 'review.json');
    const review = await readFile(reviewPath, 'utf8');
    await writeFile(reviewPath, JSON.stringify({ ...JSON.parse(review), verdict: 'fix', items: [{ path: 'a.txt', problem: 'Wrong.', expected: 'Right.', severity: 'major' }] }));
    const notClean = await runCli(env, ['accept', 'app', 'G-8']);
    assert.equal(notClean.code, 1);
    assert.match(notClean.stderr, /^sf: sf accept needs a clean Claude review of the last iteration \(2\); it says fix/);
    assert.equal(await exists(join(iterationDir(env, 'G-8', 2), 'gate-override.json')), false);
    assert.equal((await new JobStore(env.state).read('app', 'G-8'))!.state, 'needs_human');
    await writeFile(reviewPath, review);

    const accepted = await runCli(env, ['accept', 'app', 'G-8']);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.match(accepted.stdout, /^state: preparing_mr$/m);
    const ready = await waitFor(served, 'G-8', 'ready_for_human_review', 2);
    assert.equal(git(repo, 'show', `${ready.branch}:a.txt`), '2\n');

    const override = JSON.parse(await readFile(join(iterationDir(env, 'G-8', 2), 'gate-override.json'), 'utf8'));
    assert.match(override.at, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual({ ...override, at: undefined }, { at: undefined, code: 'gate_rounds', unapplied: stillWrong.items.map((item) => ({ ...item, reopens: '', caused_by: '' })) });
    const events = await eventsOf(env, 'G-8');
    const index = events.findIndex((record) => record.type === 'gate_overridden');
    assert.deepEqual({ ...events[index], ts: undefined }, { ts: undefined, iteration: 2, type: 'gate_overridden', code: 'gate_rounds', unapplied: 1 });
    // Recorded before the job moved on to MR preparation.
    assert.deepEqual((events[index + 1]!.state as { from: string; to: string }), { from: 'needs_human', to: 'preparing_mr' });
    assert.match((await runCli(env, ['watch', 'app', 'G-8', '--once'])).stdout, /^\d\d:\d\d:\d\d \[2\] gate overridden by the user \(gate_rounds\): 1 Codex item not applied$/m);

    // The dashboard: the override in the iteration and in the state history.
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/G-8', served.dashboard!))).body);
    assert.equal(detail.gate, true);
    assert.deepEqual(detail.iterations[1].gate_override, override);
    assert.deepEqual(detail.history.filter((entry: Record<string, unknown>) => entry.event === 'gate_overridden').map(({ ts: _ts, ...entry }: Record<string, unknown>) => entry), [
      { event: 'gate_overridden', code: 'gate_rounds', unapplied: 1 },
    ]);
    assert.deepEqual([detail.job.fixes, detail.job.gate_fixes], [1, 1]);

    // Refused in any other state.
    const again = await runCli(env, ['accept', 'app', 'G-8']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /^sf: sf accept needs needs_human after the gate or the ledger stopped the job or at the Fix round limit, or when the simplification pass offered suggestions \(gate_rounds, gate_budget, gate_failed, review_churn, review_disputed, iteration_limit, simplify_offered, tests_failed, tests_unavailable\); the job is ready_for_human_review/);
    assert.equal((await runCli(env, ['accept', 'app'])).code, 2);
  } finally {
    await stop(served);
  }
});

test('sf accept (SF-115, SF-131): at iteration_limit the job goes on to MR preparation whatever the last verdict; the refused Codex fix is an open ledger entry, which the override records and the MR text lists', async () => {
  const env = await newEnv('limit-accept', gateEnv({ SF_MAX_ITERATIONS: '1' }));
  const repo = await newRepo(env, 'limit-accept-repo', false);
  await putTask(env, repo, 'G-15', 'Accept at the Fix round limit');
  const another = { ...GATE_FIX, summary: 'Another problem.', items: [{ path: 'a.txt', problem: 'Another problem.', expected: 'Solved.', severity: 'major' }] };
  await script(env, [
    { write: { 'a.txt': '1\n' } },
    { write: { 'a.txt': '2\n' }, text: '| R1 | fixed | Done. |' },
    { write: { '.software-factory/G-15.mr.md': mrText('feat(G-15): Accept at the Fix round limit') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_CLEAN }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_FIX }, { output: another }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-15' });
    const limited = await waitFor(served, 'G-15', 'needs_human', 2);
    assert.deepEqual(limited.error, {
      code: 'iteration_limit',
      message: '1 Fix sections were written, the limit of SF_MAX_ITERATIONS; 1 open blocker or major findings; the user decides how to go on: sf accept takes iteration 2 as it is (the open findings go unapplied and are listed in the MR text), sf say gives a direction.',
    });
    // The refused verdict's item is an open ledger entry with its id.
    const ledger = JSON.parse(await readFile(join(env.state, 'jobs', 'app', 'G-15', 'ledger.json'), 'utf8')) as Array<{ id: string; status: string; problem: string }>;
    assert.deepEqual(ledger.map((entry) => [entry.id, entry.status, entry.problem]), [['R1', 'fixed', GATE_FIX.items[0]!.problem], ['R2', 'open', 'Another problem.']]);

    // A fix verdict of Claude's on the last iteration does not refuse it (SF-131).
    const reviewPath = join(iterationDir(env, 'G-15', 2), 'review.json');
    await writeFile(reviewPath, JSON.stringify({ ...JSON.parse(await readFile(reviewPath, 'utf8')), verdict: 'fix', items: [{ path: 'a.txt', problem: 'Wrong.', expected: 'Right.', severity: 'major' }] }));

    const accepted = await runCli(env, ['accept', 'app', 'G-15']);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.match(accepted.stdout, /^state: preparing_mr$/m);
    const ready = await waitFor(served, 'G-15', 'ready_for_human_review', 2);
    assert.equal(git(repo, 'show', `${ready.branch}:a.txt`), '2\n');

    const override = JSON.parse(await readFile(join(iterationDir(env, 'G-15', 2), 'gate-override.json'), 'utf8'));
    assert.match(override.at, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual({ ...override, at: undefined }, { at: undefined, code: 'iteration_limit', unapplied: another.items.map((item) => ({ id: 'R2', path: item.path, problem: item.problem, expected: item.expected, severity: item.severity })) });
    const events = await eventsOf(env, 'G-15');
    const index = events.findIndex((record) => record.type === 'gate_overridden');
    assert.deepEqual({ ...events[index], ts: undefined }, { ts: undefined, iteration: 2, type: 'gate_overridden', code: 'iteration_limit', unapplied: 1 });
    const mr = await readFile(join(env.state, 'jobs', 'app', 'G-15', 'mr.md'), 'utf8');
    assert.match(mr, /### Accepted over a stop\n- The user accepted iteration 2 over iteration_limit\.\n- R2 \[major\] `a\.txt`: Another problem\. Expected: Solved\./);
    assert.deepEqual((events[index + 1]!.state as { from: string; to: string }), { from: 'needs_human', to: 'preparing_mr' });
  } finally {
    await stop(served);
  }
});

test('sf accept (SF-047): a failed gate is accepted with its error as what goes unapplied; another needs_human code is refused', async () => {
  const env = await newEnv('gate-accept-failed', gateEnv());
  const repo = await newRepo(env, 'gate-accept-failed-repo', false);
  await putTask(env, repo, 'G-9', 'Accept a failed gate');
  await script(env, [
    { write: { 'a.txt': '1\n' } },
    { write: { '.software-factory/G-9.mr.md': mrText('feat(G-9): Accept a failed gate') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ exitCode: 3 }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-9' });
    const failed = await waitFor(served, 'G-9', 'needs_human', 1);
    assert.equal(failed.error.code, 'gate_failed');
    const store = new JobStore(env.state);
    // Another code of needs_human is refused.
    const job = (await store.read('app', 'G-9'))!;
    await store.write({ ...job, error: { code: 'max_turns', message: 'x' } });
    const refused = await runCli(env, ['accept', 'app', 'G-9']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^sf: sf accept needs needs_human.*the job is needs_human \(max_turns\)/);
    await store.write(job);

    assert.equal((await runCli(env, ['accept', 'app', 'G-9'])).code, 0);
    await waitFor(served, 'G-9', 'ready_for_human_review', 1);
    const override = JSON.parse(await readFile(join(iterationDir(env, 'G-9', 1), 'gate-override.json'), 'utf8'));
    assert.equal(override.code, 'gate_failed');
    assert.equal(typeof override.unapplied, 'string');
    assert.equal(override.unapplied, failed.error.message);
  } finally {
    await stop(served);
  }
});

test('the gate prompt carries <user_decisions> as the review does', async () => {
  const input = {
    ticket: 'G-1', iteration: 2, task: 't', report: 'r', patch: Buffer.from('p'), patchTruncated: false, files: [], handbook: (await loadHandbook()).text,
    userMessages: [{ iteration: 2, at: '2026-11-07T10:11:12.000Z', text: 'merge the rows into one' }],
  };
  const gate = gatePrompt({ ...input, baseCommit: 'abc' });
  const review = reviewPrompt(input);
  const section = '\n<user_decisions>\n<user_message iteration="2" at="2026-11-07T10:11:12.000Z">\nmerge the rows into one\n</user_message>\n</user_decisions>\n';
  const bullet = "\n- The user's messages to the job (<user_decisions>, below) are the user's decisions:";
  for (const prompt of [gate, review]) {
    assert.ok(prompt.includes(section) && prompt.includes(bullet), prompt);
  }
  // The same body after each reviewer's own preamble.
  assert.equal(gate.slice(gate.indexOf('\n\n- Verify the claims')), review.slice(review.indexOf('\n\n- Verify the claims')));
});

// SF-213: both reviewers are told to list every blocker and major item, not the first one found.
// The real factory/HANDBOOK.md, not SF_HANDBOOK or a fixture: dropping the rule, or moving it out
// of `## Review rules`, fails here.
test('the review prompt and the gate prompt ask for a complete verdict, from the real Handbook', async () => {
  const handbook = (await loadHandbook(fileURLToPath(new URL('HANDBOOK.md', PACKAGE_ROOT)))).text;
  const complete = 'A verdict is complete: it lists every blocker and major item the Patch has';
  const rules = handbookSection(handbook, '## Review rules');
  assert.match(rules, /\n- A `fix` lists concrete items[^\n]*\n(?: {2}[^\n]*\n)*- A verdict is complete: it lists every blocker and major item the Patch has, not the first one\n/);
  const input = { ticket: 'G-1', iteration: 1, task: 't', report: 'r', patch: Buffer.from('p'), patchTruncated: false, files: [], handbook };
  for (const prompt of [reviewPrompt(input), gatePrompt({ ...input, baseCommit: 'abc' })]) {
    assert.ok(prompt.includes(rules) && prompt.includes(complete), prompt);
  }
});

// SF-125: runGate on its own, with a fake bwrap and a fake codex of the test's own (they log to
// files of the test, never to $HOME): the bwrap logs its argv and runs the command after "--"; the
// codex logs its argv and answers with a clean verdict, or exits 1 after writing it (fail).
async function gateFakes(name: string): Promise<{ dir: string; bwrap: string; codex: string; bwrapArgs: string; codexArgs: string }> {
  const root = join(temp, name);
  const dir = join(root, 'iteration');
  await mkdir(dir, { recursive: true });
  const bwrapArgs = join(root, 'bwrap.args');
  const codexArgs = join(root, 'codex.args');
  const bwrap = join(root, 'bwrap');
  await writeFile(bwrap, `#!/bin/sh\nprintf '%s\\n' "$@" > '${bwrapArgs}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
  const codex = join(root, 'codex');
  await writeFile(codex, `#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs');
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(codexArgs)}, argv.join('\\n') + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  writeFileSync(argv[argv.indexOf('--output-last-message') + 1], JSON.stringify(${JSON.stringify(GATE_CLEAN)}));
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + '\\n');
  process.exit(process.env.CODEX_FAKE_EXIT === '1' ? 1 : 0);
});
`);
  await chmod(bwrap, 0o755);
  await chmod(codex, 0o755);
  return { dir, bwrap, codex, bwrapArgs, codexArgs };
}

const gateOptions = (fakes: { dir: string; codex: string }, extra: Partial<GateOptions>): GateOptions => ({
  codexPath: fakes.codex, cwd: fakes.dir, dir: fakes.dir, model: undefined, timeoutMs: 30_000, signal: new AbortController().signal, wrapper: undefined, bwrapPath: undefined, ...extra,
});

test('runGate inside the wrapper (SF-125): bwrap gets the wrapper, "--", the codex executable and gateArgs; gate-output.json is gone after the run', async () => {
  const fakes = await gateFakes('run-gate-wrapped');
  const wrapper = ['--die-with-parent', '--ro-bind', '/', '/', '--tmpfs', '/tmp'];
  const outcome = await runGate('the prompt', gateOptions(fakes, { wrapper, bwrapPath: fakes.bwrap, platform: 'linux' }));
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.deepEqual(outcome.output, GATE_CLEAN);
  const args = gateArgs({ cwd: fakes.dir, dir: fakes.dir, model: undefined });
  assert.deepEqual((await readFile(fakes.bwrapArgs, 'utf8')).trimEnd().split('\n'), [...wrapper, '--', fakes.codex, ...args]);
  assert.deepEqual((await readFile(fakes.codexArgs, 'utf8')).trimEnd().split('\n'), args);
  assert.equal(await exists(join(fakes.dir, GATE_OUTPUT_FILE)), false);
});

test('runGate without a wrapper (SF_SANDBOX=off, SF-125) runs codex itself; a failed run leaves no gate-output.json either', async () => {
  const fakes = await gateFakes('run-gate-unwrapped');
  const outcome = await runGate('the prompt', gateOptions(fakes, { bwrapPath: fakes.bwrap }));
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.equal(await exists(fakes.bwrapArgs), false);
  assert.deepEqual((await readFile(fakes.codexArgs, 'utf8')).trimEnd().split('\n'), gateArgs({ cwd: fakes.dir, dir: fakes.dir, model: undefined }));
  assert.equal(await exists(join(fakes.dir, GATE_OUTPUT_FILE)), false);

  // Codex wrote its answer, then exited 1: a failed run, and the answer is gone too.
  process.env.CODEX_FAKE_EXIT = '1';
  try {
    const failed = await runGate('the prompt', gateOptions(fakes, {}));
    assert.ok(!failed.ok && failed.code === undefined && /^Codex exited with code 1/.test(failed.message), JSON.stringify(failed));
  } finally {
    delete process.env.CODEX_FAKE_EXIT;
  }
  assert.equal(await exists(join(fakes.dir, GATE_OUTPUT_FILE)), false);
});

test('fail closed (SF-125, SF-161): with a wrapper and no bwrap, on another platform than Linux, or on an architecture the socket filter does not support, Codex never starts: gate_sandbox_unavailable naming the cause', async () => {
  const fakes = await gateFakes('run-gate-refused');
  const wrapper = ['--die-with-parent', '--ro-bind', '/', '/'];
  for (const [extra, cause] of [
    [{ wrapper, bwrapPath: undefined, platform: 'linux' }, /no bwrap on PATH/],
    [{ wrapper, bwrapPath: fakes.bwrap, platform: 'darwin' }, /on Linux, and this is darwin/],
    [{ wrapper, bwrapPath: fakes.bwrap, platform: 'linux', arch: 'ia32' }, /^The gate did not start: the gate's socket filter does not support ia32 \(gate_sandbox_unavailable\)/],
  ] as const) {
    const outcome = await runGate('the prompt', gateOptions(fakes, extra));
    assert.ok(!outcome.ok, JSON.stringify(outcome));
    assert.equal(outcome.code, GATE_SANDBOX_UNAVAILABLE);
    assert.match(outcome.message, cause);
    assert.ok(outcome.message.includes(GATE_SANDBOX_UNAVAILABLE), outcome.message);
    assert.deepEqual(outcome.tokens, { input: 0, cached_input: 0, output: 0 });
  }
  assert.equal(await exists(fakes.bwrapArgs), false);
  assert.equal(await exists(fakes.codexArgs), false);
});

test('the gate\'s environment (SF-125): the shell\'s, the locale\'s, the proxy\'s, OPENAI_* and CODEX_*; no other key, no SF_* setting, no SSH agent', () => {
  const env = {
    PATH: '/bin', HOME: '/h', LANG: 'C.UTF-8', LC_ALL: 'C', XDG_CONFIG_HOME: '/h/.config', TMPDIR: '/t', HTTPS_PROXY: 'http://proxy:3128', no_proxy: 'localhost',
    OPENAI_API_KEY: 'sk-x', CODEX_HOME: '/h/.codex', AWS_SECRET_ACCESS_KEY: 'a', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'k', SF_X: 'x', SSH_AUTH_SOCK: '/run/agent.sock',
  };
  assert.deepEqual(gateEnvironment(env), {
    PATH: '/bin', HOME: '/h', LANG: 'C.UTF-8', LC_ALL: 'C', XDG_CONFIG_HOME: '/h/.config', TMPDIR: '/t', HTTPS_PROXY: 'http://proxy:3128', no_proxy: 'localhost',
    OPENAI_API_KEY: 'sk-x', CODEX_HOME: '/h/.codex',
  });
});
