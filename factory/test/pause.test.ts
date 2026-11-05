// SF-067 end to end: Pause during a turn, during the Claude review and during the gate, then Resume
// (the fake Claude Code and the fake Codex): the session is the same, the interrupted round runs
// again, no verdict is recorded for it, nothing of the job runs while it is paused. Resume with a
// changed Task file (the diff in the message, the new sha256 recorded, the reviewers on the new
// file). Restart: the archive, the branch deleted only when safe, the refusals for a branch with
// commits and a pushed one, --keep-files. A paused job survives an sf serve restart and does not
// count toward the run queue's limit max_running (SF-071); Resume, a start by hand, is never held by it.
import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { addAttachment, removeAttachment } from '../src/attachments.js';
import { JobStore } from '../src/jobs.js';
import { firstPrompt, imagesChangedNote } from '../src/execution.js';
import { factoryPrompt } from '../src/prompts.js';
import { taskSha256 } from '../src/task-file.js';
import {
  call, codexLog, codexScript, type Env, fakeCodex, fakeLog, git, newEnv, newRepo, putRules, putTask, readyCheck, refused, reviewLog, reviewScript, runCli, script, serve, type Served, stop, task,
  turnsStarted, waitFor,
} from './support/harness.js';

const CLEAN = { verdict: 'clean', summary: 'Claude found it right.', items: [], accepted_sensitive: [] };
const FIX = {
  verdict: 'fix', summary: 'The greeting is wrong.',
  items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.', severity: 'major' }], accepted_sensitive: [],
};
const GATE_CLEAN = { verdict: 'clean', summary: 'Codex found it right.', items: [], accepted_sensitive: [] };
const LONG = 60_000;

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'x', '## Why', 'The ticket asks for it.', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
    '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

const jobDir = (env: Env, ticket: string): string => join(env.state, 'jobs', 'app', ticket);
const worktreeOf = (env: Env, ticket: string): string => join(env.state, 'worktrees', 'app', ticket);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function eventsOf(env: Env, ticket: string): Promise<Array<Record<string, any>>> {
  return (await readFile(join(jobDir(env, ticket), 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

async function until(what: string, condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const count = async (env: Env, name: string): Promise<number> => Number(await readFile(join(env.home, `${name}.count`), 'utf8').catch(() => '0'));

// The processes of this test's factory but sf serve: every one started with its HOME (the runners,
// the fake Claude Code of the turns and reviews, the fake Codex), alive and not a zombie.
async function factoryProcesses(env: Env, served: Served): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === served.child.pid || Number(entry) === process.pid) {
      continue;
    }
    const environ = await readFile(`/proc/${entry}/environ`, 'utf8').catch(() => '');
    if (!environ.split('\0').includes(`HOME=${env.home}`)) {
      continue;
    }
    const status = await readFile(`/proc/${entry}/status`, 'utf8').catch(() => '');
    if (/^State:\s+Z/m.test(status)) {
      continue;
    }
    found.push(`${entry}: ${(await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '')).replaceAll('\0', ' ')}`);
  }
  return found;
}

// Nothing of the job runs: no runner, no Claude Code, no Codex.
async function nothingRuns(env: Env, served: Served): Promise<void> {
  await until('the job\'s processes to end', async () => (await factoryProcesses(env, served)).length === 0, 3_000).catch(async () => {
    assert.deepEqual(await factoryProcesses(env, served), []);
  });
  assert.equal(await exists(join(jobDir(env, 'P-1'), 'runner.pid')), false);
}

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
  const env = await newEnv('pause-gate', { SF_REVIEW: 'on', SF_GATE: 'codex', SF_CODEX: fakeCodex });
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

// SF-072: the usage limit. The known messages as the sessions end with them.
const CLAUDE_LIMIT = "You've hit your 5-hour limit · resets 3am (Europe/Sofia)";
const LIMIT_ERROR = { subtype: 'error_during_execution', errors: [CLAUDE_LIMIT] };

async function waitParked(env: Env, ticket: string, other?: string): Promise<import('../src/jobs.js').Job> {
  const jobs = new JobStore(env.state);
  await until(`${ticket} to park`, async () => {
    const job = await jobs.read('app', ticket);
    return job?.state === 'waiting_limit' && job.paused?.at !== other;
  });
  return (await jobs.read('app', ticket))!;
}

test('Usage limit in a turn (SF-072): the job parks with the turn interrupted; sf say and sf pause are refused; sf resume with a message goes on; a second hit parks it again with the 30-minute retry', async () => {
  const env = await newEnv('limit-turn');
  const repo = await newRepo(env, 'limit-turn-repo', false);
  await putTask(env, repo, 'L-1', 'Limit');
  await script(env, [
    { write: { 'a.txt': 'a\n' }, ...LIMIT_ERROR },
    { subtype: 'error_during_execution', errors: ["You've hit your limit"] },
    { write: { 'b.txt': 'b\n' }, text: 'Went on.' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    const job = await waitParked(env, 'L-1');
    assert.deepEqual([job.iteration, job.paused?.from, job.paused?.step, job.limit?.provider, job.error], [0, 'working', 'turn', 'claude', undefined]);
    // 3am in Sofia, the next one after the park.
    const resets = Date.parse(job.limit!.resets_at);
    assert.equal(new Date(resets).toLocaleTimeString('en-GB', { timeZone: 'Europe/Sofia' }), '03:00:00');
    assert.ok(resets > Date.parse(job.paused!.at) && resets <= Date.parse(job.paused!.at) + 24 * 3600_000, job.limit!.resets_at);
    let events = await eventsOf(env, 'L-1');
    assert.deepEqual(events.filter((record) => record.type === 'interrupted').map((record) => [record.iteration, record.step]), [[1, 'turn']]);
    assert.deepEqual(events.filter((record) => record.state !== undefined).map((record) => record.state.to), ['starting', 'working', 'waiting_limit']);

    const said = await runCli(env, ['say', 'app', 'L-1', 'x']);
    assert.equal(said.code, 1);
    assert.match(said.stderr, /Resume the job with a message: sf resume app L-1 \[message\]/);
    assert.equal((await runCli(env, ['pause', 'app', 'L-1'])).code, 1);
    assert.match((await runCli(env, ['status', 'app', 'L-1'])).stdout, /waiting for the usage limit \(Claude\): resets at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d/);
    assert.match((await runCli(env, ['queue', 'list'])).stdout, /^running: 1\nheld: no\nusage limit: 1 parked job holds the queue, resets at /m);

    const resumed = await runCli(env, ['resume', 'app', 'L-1', 'Go', 'on']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /^state: working\niteration: 0\nstep: turn$/m);
    // The second hit has no reset time: the queue tries again 30 minutes after the park.
    const again = await waitParked(env, 'L-1', job.paused!.at);
    assert.equal(Date.parse(again.limit!.resets_at) - Date.parse(again.paused!.at), 30 * 60_000);
    assert.equal((await runCli(env, ['resume', 'app', 'L-1'])).code, 0);
    await waitFor(served, 'L-1', 'awaiting_review', 1);
    const log = await fakeLog(env);
    assert.equal(log.length, 3);
    assert.equal(log[1]!.sessionId, log[0]!.sessionId);
    assert.match(log[1]!.prompt, /^Go on\n/);
    assert.match(log[2]!.prompt, /^Continue where you stopped\.\n/);
    events = await eventsOf(env, 'L-1');
    assert.deepEqual(events.filter((record) => record.state !== undefined).map((record) => record.state.to), ['starting', 'working', 'waiting_limit', 'working', 'waiting_limit', 'working', 'awaiting_review']);
    const watched = (await runCli(env, ['watch', 'app', 'L-1', '--once'])).stdout;
    assert.match(watched, /\[0\] Parked: usage limit reached/);
    assert.match(watched, /\[0\] Resumed after the usage limit reset/);
    assert.equal((await new JobStore(env.state).read('app', 'L-1'))!.limit, undefined);
  } finally {
    await stop(served);
  }
});

test('Usage limit in the Claude review (SF-072): parked with no review.json and no review_failed; resumed, the review runs again; one that ends after the job moved on is recorded as ignored', async () => {
  const env = await newEnv('limit-review', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'limit-review-repo', false);
  await putTask(env, repo, 'L-1', 'Review');
  await putTask(env, repo, 'L-2', 'Moved on');
  await script(env, [
    { write: { 'a.txt': 'a\n' } },
    { write: { '.software-factory/L-1.mr.md': mrText('feat(L-1): Review') }, text: 'prepared' },
    { write: { 'c.txt': 'c\n' } },
    // Longer than the review: the review ends while the job works, not cancelled by the next one.
    { delayMs: 4000, write: { 'd.txt': 'd\n' }, text: 'Answered.' },
    { write: { '.software-factory/L-2.mr.md': mrText('feat(L-2): Moved on') }, text: 'prepared' },
  ]);
  await reviewScript(env, [LIMIT_ERROR, { output: CLEAN }, { delayMs: 1500, ...LIMIT_ERROR }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    const job = await waitParked(env, 'L-1');
    assert.deepEqual([job.iteration, job.paused?.from, job.paused?.step, job.limit?.provider], [1, 'awaiting_review', 'review', 'claude']);
    const jobs = new JobStore(env.state);
    assert.equal(await jobs.readReview('app', 'L-1', 1), undefined);
    const events = await eventsOf(env, 'L-1');
    assert.deepEqual(events.filter((record) => record.type === 'interrupted').map((record) => [record.iteration, record.step, record.reviewer]), [[1, 'review', 'claude']]);
    assert.equal(events.filter((record) => record.type === 'review_failed').length, 0);
    // Resume takes no message after a review round.
    assert.equal((await runCli(env, ['resume', 'app', 'L-1', 'hello'])).code, 1);
    const resumed = await runCli(env, ['resume', 'app', 'L-1']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /^state: awaiting_review\niteration: 1\nstep: review$/m);
    await waitFor(served, 'L-1', 'ready_for_human_review', 1);
    const review = await jobs.readReview('app', 'L-1', 1);
    assert.ok(review !== undefined && 'verdict' in review && review.verdict === 'clean');

    // L-2: its review hits the limit after a message moved the job on: recorded, ignored, not parked.
    await call(served, 'start', { workspace: 'app', ticket: 'L-2' });
    await waitFor(served, 'L-2', 'awaiting_review', 1);
    await until('the review of L-2 to start', async () => (await count(env, 'fake-review')) >= 3);
    assert.equal((await runCli(env, ['say', 'app', 'L-2', 'One', 'more'])).code, 0);
    await until('the ignored review', async () => (await eventsOf(env, 'L-2')).some((record) => record.type === 'review_failed'));
    const ignored = (await eventsOf(env, 'L-2')).find((record) => record.type === 'review_failed')!;
    assert.deepEqual([ignored.iteration, ignored.ignored], [1, true]);
    const record = await jobs.readReview('app', 'L-2', 1);
    assert.ok(record !== undefined && 'error' in record && /hit your 5-hour limit/.test(record.error), JSON.stringify(record));
    assert.notEqual((await jobs.read('app', 'L-2'))!.state, 'waiting_limit');
    await waitFor(served, 'L-2', 'ready_for_human_review', 2);
  } finally {
    await runCli(env, ['abort', 'app', 'L-2']);
    await stop(served);
  }
});

test('Usage limit in the gate (SF-072): Codex\'s limit parks the job (provider codex, no gate.json); the run queue resumes it by itself at the reset and the gate runs again', async () => {
  const env = await newEnv('limit-gate', { SF_REVIEW: 'on', SF_GATE: 'codex', SF_CODEX: fakeCodex });
  const repo = await newRepo(env, 'limit-gate-repo', false);
  await putTask(env, repo, 'L-1', 'Gate');
  await script(env, [{ write: { 'a.txt': 'a\n' } }, { write: { '.software-factory/L-1.mr.md': mrText('feat(L-1): Gate') }, text: 'prepared' }]);
  await reviewScript(env, [{ output: CLEAN }]);
  await codexScript(env, [{ error: "You've hit your usage limit. Try again in 3s." }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    const job = await waitParked(env, 'L-1');
    assert.deepEqual([job.paused?.from, job.paused?.step, job.limit?.provider], ['awaiting_review', 'gate', 'codex']);
    // The limit-hit run reported 1100 tokens (the fake's default usage): none is charged to the job.
    assert.equal(job.gate_tokens, 0);
    const delay = Date.parse(job.limit!.resets_at) - Date.parse(job.paused!.at);
    assert.ok(delay > 2000 && delay < 4000, String(delay));
    const jobs = new JobStore(env.state);
    assert.equal(await jobs.readGate('app', 'L-1', 1), undefined);
    const events = await eventsOf(env, 'L-1');
    assert.deepEqual(events.filter((record) => record.type === 'interrupted').map((record) => [record.step, record.reviewer]), [['gate', 'codex']]);
    assert.equal(events.filter((record) => record.reviewer === 'codex' && record.type === 'review_failed').length, 0);
    // Nothing by hand: the queue's timer resumes it.
    await waitFor(served, 'L-1', 'ready_for_human_review', 1);
    assert.equal((await codexLog(env)).length, 2);
    assert.equal((await reviewLog(env)).length, 1);
    const gate = await jobs.readGate('app', 'L-1', 1);
    assert.ok(gate !== undefined && 'verdict' in gate && gate.verdict === 'clean');
    // Only the run that gave the verdict counts.
    assert.equal((await jobs.read('app', 'L-1'))!.gate_tokens, 1100);
  } finally {
    await stop(served);
  }
});

// The images of the SF-065 tests.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const PNG2 = Buffer.concat([PNG, Buffer.from('-second')]);
const PNG3 = Buffer.concat([PNG, Buffer.from('-third')]);
const GIF = Buffer.from('GIF89a-gif-body');
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

test('images (SF-065): a Resume finds an image changed while paused (the text unchanged), refuses an unusable one, copies the new one and names it; Restart and a Resume before the first turn give the blocks again', async () => {
  const env = await newEnv('pause-images');
  const repo = await newRepo(env, 'pause-images-repo', false);
  const workspace = { name: 'app', readCheckout: repo, workCheckout: repo };
  const jobs = new JobStore(env.state);
  await putTask(env, repo, 'P-1', 'Images');
  await addAttachment(workspace, 'P-1', PNG, jobs);
  const text = `${task('P-1', 'Images')}\nSee ![the error](P-1/1.png).\n`;
  await writeFile(join(repo, '.software-factory', 'P-1.md'), text);
  await script(env, [
    { write: { 'a.txt': 'a\n' } },
    { delayMs: LONG, write: { 'never.txt': 'x\n' } },
    { write: { 'b.txt': 'b\n' }, text: 'Went on.' },
    // The restarted job's first turn; restarted again, a first turn that never reports a session,
    // then the Resume's.
    { write: { 'c.txt': 'c\n' } },
    { delayMs: LONG },
    { write: { 'd.txt': 'd\n' } },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    assert.equal((await runCli(env, ['say', 'app', 'P-1', 'Go', 'on'])).code, 0);
    await turnsStarted(env, 2);
    assert.equal((await runCli(env, ['pause', 'app', 'P-1'])).code, 0);
    await nothingRuns(env, served);

    // An image that cannot be used refuses the Resume; the job stays paused, its copies as they were.
    await writeFile(join(repo, '.software-factory', 'P-1', '1.png'), GIF);
    const refusal = await runCli(env, ['resume', 'app', 'P-1']);
    assert.equal(refusal.code, 1);
    assert.match(refusal.stderr, /P-1\/1\.png: not the image its name says/);
    assert.equal((await jobs.read('app', 'P-1'))!.state, 'paused');
    assert.deepEqual(await readFile(join(jobDir(env, 'P-1'), 'attachments', '1.png')), PNG);

    // The image changes while paused, the Task text does not: Resume copies it and names it.
    await removeAttachment(workspace, 'P-1', '1.png', jobs);
    await addAttachment(workspace, 'P-1', PNG2, jobs, '1.png');
    const resumed = await runCli(env, ['resume', 'app', 'P-1']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /^task_changed: false$/m);
    await waitFor(served, 'P-1', 'awaiting_review', 2);
    const record = { name: '1.png', type: 'image/png', bytes: PNG2.length, sha256: sha(PNG2) };
    assert.deepEqual((await jobs.read('app', 'P-1'))!.attachments, [record]);
    assert.deepEqual(await readFile(join(jobDir(env, 'P-1'), 'attachments', '1.png')), PNG2);
    assert.deepEqual(await readFile(join(worktreeOf(env, 'P-1'), '.software-factory', 'P-1', '1.png')), PNG2);
    const imagesLine = { dir: join(worktreeOf(env, 'P-1'), '.software-factory', 'P-1'), names: ['1.png'] };
    let log = await fakeLog(env);
    // The same session goes on: the line and the folder, no blocks.
    assert.equal(log.at(-1)!.prompt, factoryPrompt(`Continue where you stopped.\n\n${imagesChangedNote(['1.png'])}`, 'P-1', 2, imagesLine));
    assert.equal(log.at(-1)!.blocks, undefined);
    const attachments = (await eventsOf(env, 'P-1')).filter((event) => event.type === 'attachments').map((event) => event.images);
    assert.deepEqual(attachments, [[{ ...record, bytes: PNG.length, sha256: sha(PNG) }], [record]]);

    // Restart is refused while an image cannot be used, and nothing changes.
    assert.equal((await runCli(env, ['abort', 'app', 'P-1'])).code, 0);
    await rm(join(repo, '.software-factory', 'P-1', '1.png'));
    const early = await runCli(env, ['restart', 'app', 'P-1']);
    assert.equal(early.code, 1);
    assert.match(early.stderr, /P-1\/1\.png: missing/);
    assert.equal((await jobs.read('app', 'P-1'))!.state, 'aborted');
    await addAttachment(workspace, 'P-1', PNG3, jobs, '1.png');
    assert.equal((await runCli(env, ['restart', 'app', 'P-1'])).code, 0);
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    const block = { type: 'image', media_type: 'image/png', bytes: PNG3.length, sha256: sha(PNG3) };
    const blocks = [
      { type: 'text', text: factoryPrompt(firstPrompt('P-1', []), 'P-1', 1, imagesLine) },
      { type: 'text', text: 'Image P-1/1.png ("the error"), referenced in the Task file:' },
      block,
    ];
    assert.deepEqual((await fakeLog(env)).at(-1)!.blocks, blocks);
    assert.deepEqual((await jobs.read('app', 'P-1'))!.attachments, [{ ...record, bytes: PNG3.length, sha256: sha(PNG3) }]);

    // Paused before its first turn reported a session: the Resume sends /implement with the blocks again.
    assert.equal((await runCli(env, ['abort', 'app', 'P-1'])).code, 0);
    assert.equal((await runCli(env, ['restart', 'app', 'P-1'])).code, 0);
    await turnsStarted(env, 5);
    assert.equal((await runCli(env, ['pause', 'app', 'P-1'])).code, 0);
    assert.equal((await runCli(env, ['resume', 'app', 'P-1'])).code, 0);
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    log = await fakeLog(env);
    assert.deepEqual(log.at(-1)!.blocks, blocks);
  } finally {
    await stop(served);
  }
});

test('Usage limit in the simplification pass (SF-072): parked with no simplify.json and no simplify event; resumed, the pass runs again, then MR preparation; an MR turn that hits the limit stops in needs_human', async () => {
  const env = await newEnv('limit-simplify', { SF_REVIEW: 'on', SF_SIMPLIFY: 'on' });
  const repo = await newRepo(env, 'limit-simplify-repo', false);
  await putTask(env, repo, 'L-1', 'Simplify');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: '| R1 | fixed | Checked now. |' },
    { write: { '.software-factory/L-1.mr.md': mrText('feat(L-1): Simplify') }, ...LIMIT_ERROR },
  ]);
  await reviewScript(env, [{ output: FIX }, { output: CLEAN }, LIMIT_ERROR, { output: { summary: 'Nothing to remove.', suggestions: [] } }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    const job = await waitParked(env, 'L-1');
    assert.deepEqual([job.iteration, job.paused?.from, job.paused?.step, job.simplify_iteration], [2, 'awaiting_review', 'simplify', undefined]);
    const jobs = new JobStore(env.state);
    assert.equal(await jobs.readSimplify('app', 'L-1', 2), undefined);
    let events = await eventsOf(env, 'L-1');
    assert.equal(events.filter((record) => record.type === 'simplify').length, 0);
    assert.deepEqual(events.filter((record) => record.type === 'interrupted').map((record) => [record.iteration, record.step, record.reviewer]), [[2, 'simplify', 'simplify']]);
    assert.equal((await runCli(env, ['resume', 'app', 'L-1'])).code, 0);
    // The pass runs again; then the MR turn hits the limit: no park, the old stop.
    const stopped = await waitFor(served, 'L-1', 'needs_human');
    assert.equal(stopped.error.code, 'turn_failed');
    assert.match(stopped.error.message, /hit your 5-hour limit/);
    const record = await jobs.readSimplify('app', 'L-1', 2);
    assert.ok(record !== undefined && 'suggestions' in record, JSON.stringify(record));
    events = await eventsOf(env, 'L-1');
    assert.equal(events.filter((record) => record.type === 'simplify').length, 1);
  } finally {
    await stop(served);
  }
});

test('Usage limit (SF-072): a parked job survives an sf serve restart; the queue resumes it at a reset passed meanwhile, and a resume that fails (worktree gone) leaves it in needs_human; abort ends a parked job', async () => {
  const env = await newEnv('limit-restart');
  const repo = await newRepo(env, 'limit-restart-repo', false);
  await putTask(env, repo, 'L-1', 'Restart');
  await putTask(env, repo, 'L-2', 'Gone');
  await putTask(env, repo, 'L-3', 'Abort');
  await script(env, [LIMIT_ERROR, LIMIT_ERROR, LIMIT_ERROR, { write: { 'a.txt': 'a\n' }, text: 'After the reset.' }]);
  let served = await serve(env);
  const jobs = new JobStore(env.state);
  try {
    for (const ticket of ['L-1', 'L-2', 'L-3']) {
      await call(served, 'start', { workspace: 'app', ticket });
      await waitParked(env, ticket);
    }
    assert.equal((await runCli(env, ['abort', 'app', 'L-3'])).code, 0);
    assert.equal((await jobs.read('app', 'L-3'))!.state, 'aborted');
    await stop(served);
    // While sf serve is down the resets pass; L-2's worktree goes.
    for (const ticket of ['L-1', 'L-2']) {
      const job = (await jobs.read('app', ticket))!;
      await jobs.write({ ...job, limit: { ...job.limit!, resets_at: new Date(Date.now() - 1000).toISOString() } });
    }
    git(repo, 'worktree', 'remove', '--force', worktreeOf(env, 'L-2'));
    served = await serve(env);
    await waitFor(served, 'L-1', 'awaiting_review', 1);
    const failed = await waitFor(served, 'L-2', 'needs_human');
    assert.equal(failed.error.code, 'worktree_missing');
    assert.equal((await fakeLog(env)).at(-1)!.prompt.split('\n')[0], 'Continue where you stopped.');
  } finally {
    await runCli(env, ['abort', 'app', 'L-1']);
    await stop(served);
  }
});

test('images (SF-065): a job paused outside working gets the new set on Resume with no prompt; the reviewers get it', async () => {
  const env = await newEnv('pause-images-review', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'pause-images-review-repo', false);
  const workspace = { name: 'app', readCheckout: repo, workCheckout: repo };
  const jobs = new JobStore(env.state);
  await putTask(env, repo, 'P-1', 'Review images');
  await addAttachment(workspace, 'P-1', PNG, jobs);
  await writeFile(join(repo, '.software-factory', 'P-1.md'), `${task('P-1', 'Review images')}\nSee ![shot](P-1/1.png).\n`);
  await script(env, [{ write: { 'a.txt': 'a\n' } }, { write: { '.software-factory/P-1.mr.md': mrText('feat(P-1): Review images') }, text: 'prepared' }]);
  await reviewScript(env, [{ delayMs: LONG, output: CLEAN }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    await until('the review to start', async () => (await count(env, 'fake-review')) >= 1);
    assert.equal((await runCli(env, ['pause', 'app', 'P-1'])).code, 0);
    await nothingRuns(env, served);
    await removeAttachment(workspace, 'P-1', '1.png', jobs);
    await addAttachment(workspace, 'P-1', PNG2, jobs, '1.png');
    assert.equal((await runCli(env, ['resume', 'app', 'P-1'])).code, 0);
    await waitFor(served, 'P-1', 'ready_for_human_review', 1);
    const reviews = await reviewLog(env);
    assert.equal(reviews.length, 1);
    assert.deepEqual(reviews[0]!.blocks?.slice(1), [
      { type: 'text', text: 'Image P-1/1.png ("shot"), referenced in the Task file:' },
      { type: 'image', media_type: 'image/png', bytes: PNG2.length, sha256: sha(PNG2) },
    ]);
    // No Implementer prompt on that Resume: the first turn and the MR text turn only.
    const log = await fakeLog(env);
    assert.equal(log.length, 2);
    assert.doesNotMatch(log[1]!.prompt, /images changed/);
  } finally {
    await stop(served);
  }
});
