// SF-067 end to end: Pause during a turn, during the Claude review and during the gate, then Resume
// (the fake Claude Code and the fake Codex): the session is the same, the interrupted round runs
// again, no verdict is recorded for it, nothing of the job runs while it is paused. Resume with a
// changed Task file (the diff in the message, the new sha256 recorded, the reviewers on the new
// file). Restart: the archive, the branch deleted only when safe, the refusals for a branch with
// commits and a pushed one, --keep-files. A paused job survives an sf serve restart and does not
// count toward the run queue's limit max_running (SF-071); Resume, a start by hand, is never held by it.
// The usage limit (SF-072) and the images of a Resume (SF-065) are test/pause-limits.test.ts's
// (SF-152: one file ran near run-tests' per-file limit).
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { firstPrompt } from '../src/execution.js';
import { factoryPrompt } from '../src/prompts.js';
import { taskSha256 } from '../src/task-file.js';
import { call, codexLog, codexScript, fakeCodex, fakeLog, git, newEnv, newRepo, putRules, putTask, readyCheck, refused, reviewLog, reviewScript, runCli, script, serve, stop, task, turnsStarted, waitFor } from './support/harness.js';
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
    assert.equal((await fakeLog(env)).at(-1)!.prompt, factoryPrompt(`${block}\n\ngo on`, 'P-1', 1));

    await call(served, 'start', { workspace: 'app', ticket: 'P-2' });
    await turnsStarted(env, 3);
    assert.equal((await runCli(env, ['pause', 'app', 'P-2'])).code, 0);
    assert.equal((await runCli(env, ['resume', 'app', 'P-2'])).code, 0);
    await waitFor(served, 'P-2', 'awaiting_review', 1);
    const log = await fakeLog(env);
    assert.equal(log.at(-1)!.prompt, factoryPrompt(firstPrompt('P-2', [], block), 'P-2', 1));
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
