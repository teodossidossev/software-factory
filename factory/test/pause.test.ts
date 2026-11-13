// SF-067 end to end: Pause during a turn, during the Claude review and during the gate, then Resume
// (the fake Claude Code and the fake Codex): the session is the same, the interrupted round runs
// again, no verdict is recorded for it, nothing of the job runs while it is paused. Resume with a
// changed Task file (the diff in the message, the new sha256 recorded, the reviewers on the new
// file). A paused job survives an sf serve restart and does not count toward the run queue's limit
// max_running (SF-071); Resume, a start by hand, is never held by it. Split so that no file runs
// near run-tests' per-file limit: the usage limit (SF-072) and the images of a Resume (SF-065) are
// test/pause-limits.test.ts's (SF-152); Restart and the coding rules of a Resume and a Restart
// (SF-059) test/pause-restart.test.ts's.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { taskSha256 } from '../src/task-file.js';
import { call, codexLog, codexScript, fakeCodex, fakeLog, newEnv, newRepo, putTask, readyCheck, refused, reviewLog, reviewScript, runCli, script, serve, stop, task, turnsStarted, waitFor } from './support/harness.js';
import { CLEAN, count, eventsOf, exists, FIX, GATE_CLEAN, jobDir, LONG, mrText, nothingRuns, until, worktreeOf } from './support/pause.js';

test('Pause during a turn, the Task file rewritten while paused, then Resume: the same session goes on with the diff, the new sha256 is recorded', async () => {
  const env = await newEnv('pause-turn');
  const repo = await newRepo(env, 'pause-turn-repo', false);
  await putTask(env, repo, 'P-1', 'Pause');
  await script(env, [
    { write: { 'a.txt': 'a\n' } },
    { delayMs: LONG, write: { 'never.txt': 'x\n' } },
    { write: { 'b.txt': 'b\n' }, text: 'Went on.' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    const jobs = new JobStore(env.state);
    const started = (await jobs.read('app', 'P-1'))!;
    assert.equal(started.task_sha256, taskSha256(task('P-1', 'Pause')));
    assert.equal(await jobs.readTaskCopy('app', 'P-1'), task('P-1', 'Pause'));
    const session = started.session_id;
    assert.ok(session !== null);

    // A message starts the long turn; Pause stops it at once.
    assert.equal((await runCli(env, ['say', 'app', 'P-1', 'Go', 'on'])).code, 0);
    await turnsStarted(env, 2);
    const paused = await runCli(env, ['pause', 'app', 'P-1']);
    assert.equal(paused.code, 0, paused.stderr);
    assert.match(paused.stdout, /^state: paused\nbranch: P-1-pause\nstep: turn$/m);
    await nothingRuns(env, served);
    const job = (await jobs.read('app', 'P-1'))!;
    assert.deepEqual([job.state, job.iteration, job.session_id, job.paused?.from, job.paused?.step], ['paused', 1, session, 'working', 'turn']);
    assert.equal(await exists(join(worktreeOf(env, 'P-1'), 'a.txt')), true);
    assert.equal(await exists(join(worktreeOf(env, 'P-1'), 'never.txt')), false);
    assert.deepEqual((await eventsOf(env, 'P-1')).filter((record) => record.type === 'interrupted').map((record) => [record.iteration, record.step]), [[2, 'turn']]);
    // A paused job takes no message; the Context owner may rewrite its Task file.
    assert.equal((await runCli(env, ['say', 'app', 'P-1', 'x'])).code, 1);
    const changed = `${task('P-1', 'Pause')}\nAlso greet the reader.\n`;
    await call(served, 'write_task', { workspace: 'app', ticket: 'P-1', content: changed });
    assert.equal((await refused(served, 'start', { workspace: 'app', ticket: 'P-1' })).code, 'job_exists');

    const resumed = await runCli(env, ['resume', 'app', 'P-1']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /^state: working\niteration: 1\nstep: turn\ntask_changed: true$/m);
    await waitFor(served, 'P-1', 'awaiting_review', 2);
    const log = await fakeLog(env);
    assert.equal(log.length, 2, 'the killed turn never got to log');
    const last = log.at(-1)!;
    assert.equal(last.sessionId, session);
    assert.ok(last.argv.includes(`--resume=${session}`), JSON.stringify(last.argv));
    assert.match(last.prompt, /^Continue where you stopped\.\n\nThe Task file \.software-factory\/P-1\.md changed since you were last given it \(while the job was paused\)/);
    assert.match(last.prompt, /````diff\n--- a\/\.software-factory\/P-1\.md\n\+\+\+ b\/\.software-factory\/P-1\.md\n@@ [^\n]+\n(?:[^\n]*\n)*\+Also greet the reader\.\n/);
    assert.match(last.prompt, /\n\nRules from the Software Factory:/);
    const after = (await jobs.read('app', 'P-1'))!;
    assert.equal(after.task_sha256, taskSha256(changed));
    assert.equal(after.paused, undefined);
    assert.equal(await jobs.readTaskCopy('app', 'P-1'), changed);
    assert.equal(await readFile(join(worktreeOf(env, 'P-1'), '.software-factory', 'P-1.md'), 'utf8'), changed);
    const changes = (await eventsOf(env, 'P-1')).filter((record) => record.type === 'task_changed');
    assert.deepEqual(changes.map((record) => [record.from, record.to]), [[taskSha256(task('P-1', 'Pause')), taskSha256(changed)]]);
    assert.match((await runCli(env, ['watch', 'app', 'P-1', '--once'])).stdout, /\[2\] turn interrupted by the pause/);
    // Resume of a job that is not paused is refused.
    assert.equal((await runCli(env, ['resume', 'app', 'P-1'])).code, 1);
  } finally {
    await stop(served);
  }
});

test('Pause during the Claude review: the round is thrown away and recorded as interrupted; Resume runs it again on the same iteration with the new Task file', async () => {
  const env = await newEnv('pause-review', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'pause-review-repo', false);
  await putTask(env, repo, 'P-1', 'Review');
  await script(env, [
    { write: { 'a.txt': 'a\n' } }, { write: { 'README.md': 'reader\n' }, text: '# Report: P-1, iteration 2\n## Fix 1 items\n| R1 | fixed | README.md:1 |\n' },
    { write: { '.software-factory/P-1.mr.md': mrText('feat(P-1): Review') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ delayMs: LONG, output: FIX }, { output: FIX }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    await until('the review to start', async () => (await count(env, 'fake-review')) >= 1);
    const paused = await runCli(env, ['pause', 'app', 'P-1']);
    assert.equal(paused.code, 0, paused.stderr);
    assert.match(paused.stdout, /^step: review$/m);
    await nothingRuns(env, served);
    const jobs = new JobStore(env.state);
    assert.equal(await jobs.readReview('app', 'P-1', 1), undefined);
    const events = await eventsOf(env, 'P-1');
    assert.deepEqual(events.filter((record) => record.type === 'interrupted').map((record) => [record.iteration, record.step, record.reviewer]), [[1, 'review', 'claude']]);
    assert.equal(events.filter((record) => record.type === 'review' || record.type === 'review_failed').length, 0);
    const checked = await call(served, 'check', { workspace: 'app', ticket: 'P-1' });
    assert.equal(checked.state, 'paused');
    assert.equal(checked.review, undefined);

    // The Task file changes; a message is refused (the review runs again, it takes none).
    const changed = `${task('P-1', 'Review')}\nThe reviewers read this line.\n`;
    await writeFile(join(repo, '.software-factory', 'P-1.md'), changed);
    const withMessage = await runCli(env, ['resume', 'app', 'P-1', 'hello']);
    assert.equal(withMessage.code, 1);
    assert.match(withMessage.stderr, /Resume takes no message then\. Resume without one, then send it with sf say\./);
    const resumed = await runCli(env, ['resume', 'app', 'P-1']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /^state: awaiting_review\niteration: 1\nstep: review\ntask_changed: true$/m);
    // At once: job.json has the new Task file's sha256; task.md keeps what the Implementer was last given.
    const resumedJob = JSON.parse(await readFile(join(jobDir(env, 'P-1'), 'job.json'), 'utf8'));
    assert.equal(resumedJob.task_sha256, taskSha256(changed));
    assert.equal(await jobs.readTaskCopy('app', 'P-1'), task('P-1', 'Review'));
    await waitFor(served, 'P-1', 'ready_for_human_review', 2);
    assert.equal(await count(env, 'fake-review'), 3);
    const reviews = await reviewLog(env);
    assert.equal(reviews.length, 2, 'the interrupted review never got to log');
    assert.match(reviews[0]!.prompt, /The reviewers read this line\./);
    const review = await jobs.readReview('app', 'P-1', 1);
    assert.ok(review !== undefined && 'verdict' in review && review.verdict === 'fix');
    // The Implementer gets the change with its next prompt, the Fix section: the paused edit only.
    const log = await fakeLog(env);
    assert.equal(log.length, 3);
    assert.match(log[1]!.prompt, /^\/implement \.software-factory\/P-1\.md Fix 1\n\nThe Task file \.software-factory\/P-1\.md changed since you were last given it/);
    assert.match(log[1]!.prompt, /\+The reviewers read this line\./);
    assert.doesNotMatch(log[1]!.prompt.split('````')[1]!, /## Fix 1/);
    assert.equal((await jobs.read('app', 'P-1'))!.task_sha256, taskSha256(await readFile(join(repo, '.software-factory', 'P-1.md'), 'utf8')));
  } finally {
    await stop(served);
  }
});

test('Pause during the gate kills Codex and records no verdict; Resume runs the gate again on the same iteration, not the Claude review', async () => {
  const env = await newEnv('pause-gate', { SF_REVIEW: 'on', SF_GATE: 'codex', SF_GATE_LEVEL: 'full', SF_CODEX: fakeCodex });
  const repo = await newRepo(env, 'pause-gate-repo', false);
  await putTask(env, repo, 'P-1', 'Gate');
  await script(env, [{ write: { 'a.txt': 'a\n' } }, { write: { '.software-factory/P-1.mr.md': mrText('feat(P-1): Gate') }, text: 'prepared' }]);
  await reviewScript(env, [{ output: CLEAN }]);
  await codexScript(env, [{ delayMs: LONG, output: GATE_CLEAN }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
    await until('the gate to run', async () => exists(join(env.home, 'fake-codex.log')));
    const paused = await runCli(env, ['pause', 'app', 'P-1']);
    assert.equal(paused.code, 0, paused.stderr);
    assert.match(paused.stdout, /^step: gate$/m);
    await nothingRuns(env, served);
    const jobs = new JobStore(env.state);
    assert.equal(await jobs.readGate('app', 'P-1', 1), undefined);
    const events = await eventsOf(env, 'P-1');
    assert.deepEqual(events.filter((record) => record.type === 'interrupted').map((record) => [record.step, record.reviewer]), [['gate', 'codex']]);
    assert.equal(events.filter((record) => record.reviewer === 'codex' && (record.type === 'review' || record.type === 'review_failed')).length, 0);

    const resumed = await runCli(env, ['resume', 'app', 'P-1']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /^step: gate\ntask_changed: false$/m);
    await waitFor(served, 'P-1', 'ready_for_human_review', 1);
    assert.equal((await codexLog(env)).length, 2);
    assert.equal((await reviewLog(env)).length, 1);
    const gate = await jobs.readGate('app', 'P-1', 1);
    assert.ok(gate !== undefined && 'verdict' in gate && gate.verdict === 'clean');
  } finally {
    await stop(served);
  }
});

test('Pause is refused while the MR is prepared and outside working and awaiting_review', async () => {
  const env = await newEnv('pause-refused');
  const repo = await newRepo(env, 'pause-refused-repo', false);
  await putTask(env, repo, 'P-1', 'Refused');
  await script(env, [{ write: { 'a.txt': 'a\n' } }, { delayMs: LONG }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'P-1' });
    await waitFor(served, 'P-1', 'preparing_mr', 1);
    const refusal = await runCli(env, ['pause', 'app', 'P-1']);
    assert.equal(refusal.code, 1);
    assert.match(refusal.stderr, /^sf: The job is preparing the MR/);
    assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'P-1' })).state, 'preparing_mr');
    assert.equal((await runCli(env, ['abort', 'app', 'P-1'])).code, 0);
    const again = await runCli(env, ['pause', 'app', 'P-1']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /^sf: sf pause needs working or awaiting_review; the job is aborted\./);
  } finally {
    await stop(served);
  }
});

test('A paused job survives an sf serve restart and is not counted toward the run limit; Resume goes over the limit', async () => {
  const env = await newEnv('pause-slot', { SF_MAX_JOBS: '1' });
  const repo = await newRepo(env, 'pause-slot-repo', false);
  await putTask(env, repo, 'P-1', 'First');
  await putTask(env, repo, 'P-2', 'Second');
  await script(env, [{ delayMs: LONG }, { delayMs: LONG }, { write: { 'a.txt': 'a\n' } }]);
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
    await turnsStarted(env, 1);
    assert.equal((await runCli(env, ['pause', 'app', 'P-1'])).code, 0);
    // max_running is 1 (SF_MAX_JOBS): the paused job holds no slot, so the queue starts P-2.
    await readyCheck(env, repo, 'P-2');
    assert.equal((await runCli(env, ['queue', 'add', 'app', 'P-2'])).code, 0);
    await turnsStarted(env, 2);
  } finally {
    await stop(served);
  }
  served = await serve(env);
  try {
    assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'P-1' })).state, 'paused');
    assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'P-2' })).state, 'working');
    assert.match((await runCli(env, ['queue', 'list'])).stdout, /^limit: 1 job at once\nrunning: 1\n/);
    // P-2 runs and the limit is 1: Resume is the user's, never held by the limit. The first turn
    // never reported a session: Resume runs the task again.
    const resumed = await runCli(env, ['resume', 'app', 'P-1']);
    assert.equal(resumed.code, 0, resumed.stderr);
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    assert.equal((await runCli(env, ['abort', 'app', 'P-2'])).code, 0);
    assert.match((await fakeLog(env)).at(-1)!.prompt, /^\/implement \.software-factory\/P-1\.md\n\nRules from the Software Factory:/);
  } finally {
    await stop(served);
  }
});