// End-to-end tests of sf retry (SF-087), the Retry of a transient MR preparation failure after the
// deciding clean verdict, with the real sf serve, the fake Claude (its --json-schema runs are the
// Claude reviews), the fake Codex and a real repository with a bare origin: a fetch that fails
// after the clean verdict and its Retry with no new turn, review or gate; the refusals; the Retry
// after a restart of sf serve during MR preparation, and a second failure with its new code; the
// push again on mr_push_failed; and no Retry after a conflict turn.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { callSocket } from '../src/ipc.js';
import { type Job, JobStore } from '../src/jobs.js';
import { mrPrompt } from '../src/prompts.js';
import { loadHandbook } from '../src/server.js';
import {
  call, codexLog, codexScript, type Env, fakeCodex, fakeLog, git, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, temp, turnsStarted, waitFor,
} from './support/harness.js';

const CONFLICT_TURN = 'The MR preparation ran a conflict turn whose changes no reviewer saw; tell the Implementer to go on (the iteration is reviewed again).';

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'x', '## Why', 'The ticket asks for it.', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
    '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

const retry = (env: Env, ticket: string): ReturnType<typeof runCli> => runCli(env, ['retry', 'app', ticket]);
const lockOf = (env: Env, ticket: string): string => join(env.state, 'jobs', 'app', ticket, 'runner.pid');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(what: string, condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function eventsOf(env: Env, ticket: string): Promise<Array<Record<string, any>>> {
  return (await readFile(join(env.state, 'jobs', 'app', ticket, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

// The refusal of sf retry through the socket of sf serve: its code and message.
async function refusal(env: Env, ticket: string): Promise<{ code: string; message: string }> {
  const response = await callSocket(env.state, { command: 'retry', args: ['app', ticket] });
  assert.equal(response.ok, false, JSON.stringify(response));
  return (response as { error: { code: string; message: string } }).error;
}

test('fetch_failed after the clean verdict: sf retry prepares the MR with only the MR text turn, no review, no gate and no Fix section, with the paths both reviewers accepted', async () => {
  const env = await newEnv('retry-fetch', { SF_REVIEW: 'on', SF_GATE: 'codex', SF_CODEX: fakeCodex });
  const repo = await newRepo(env, 'retry-fetch-repo', true);
  const origin = join(temp, 'retry-fetch-repo-origin.git');
  await putTask(env, repo, 'F-1', 'Fetch fails');
  // The Implementer's turn changes a sensitive path and points origin at a missing path, so the
  // fetch of MR preparation fails after the clean verdict.
  await script(env, [
    { write: { 'README.md': 'hello reader\n', 'package.json': '{"name":"x"}\n' }, run: [['git', 'remote', 'set-url', 'origin', join(temp, 'no-such-origin.git')]], text: 'iteration 1' },
    { write: { '.software-factory/F-1.mr.md': mrText('feat(F-1): Fetch fails') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: { verdict: 'clean', summary: 'package.json is needed.', items: [], accepted_sensitive: ['package.json'] } }]);
  await codexScript(env, [{ output: { verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: ['package.json'] } }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'F-1' });
    const stopped = await waitFor(served, 'F-1', 'needs_human', 1);
    assert.equal(stopped.error.code, 'fetch_failed');
    const jobs = new JobStore(env.state);
    assert.deepEqual([(await jobs.read('app', 'F-1'))!.mr_attempts, (await jobs.read('app', 'F-1'))!.mr_conflict_turn], [0, false]);

    // While origin is still missing: the retry fails again and the job stops again with the code.
    const again = await retry(env, 'F-1');
    assert.equal(again.code, 1, again.stdout + again.stderr);
    assert.match(again.stderr, /^sf: git fetch origin/m);
    assert.equal((await waitFor(served, 'F-1', 'needs_human', 1)).error.code, 'fetch_failed');
    assert.equal((await eventsOf(env, 'F-1')).filter((event) => event.state?.to === 'needs_human').length, 2);

    git(repo, 'remote', 'set-url', 'origin', origin);
    const retried = await retry(env, 'F-1');
    assert.equal(retried.code, 0, retried.stdout + retried.stderr);
    assert.equal(retried.stdout, 'state: preparing_mr\niteration: 1\nbranch: F-1-fetch-fails\n');
    await waitFor(served, 'F-1', 'ready_for_human_review', 1);
    assert.equal(git(repo, 'show', '--name-only', '--format=', 'F-1-fetch-fails').trim(), 'README.md\npackage.json');

    // Only the MR text turn ran again, with no previous error (no MR text turn had run); one
    // review, one gate run, no Fix section.
    const log = await fakeLog(env);
    const handbook = (await loadHandbook()).text;
    const target = git(repo, 'rev-parse', 'origin/main').trim();
    assert.deepEqual(log.map((entry) => entry.prompt.split('\n')[0]), [
      '/implement .software-factory/F-1.md',
      'MR preparation for F-1 on branch F-1-fetch-fails. The user approved the reviewed change.',
    ]);
    assert.equal(log[1]!.prompt, mrPrompt({ ticket: 'F-1', branch: 'F-1-fetch-fails', targetRef: 'origin/main', targetCommit: target, attempt: 1, handbook }));
    assert.equal((await reviewLog(env)).length, 1);
    assert.equal((await codexLog(env)).length, 1);
    assert.doesNotMatch(await readFile(join(env.state, 'worktrees', 'app', 'F-1', '.software-factory', 'F-1.md'), 'utf8'), /^## Fix/m);
    assert.deepEqual((await eventsOf(env, 'F-1')).filter((event) => event.type === 'review').map((event) => event.reviewer), ['claude', 'codex']);
    const job = (await jobs.read('app', 'F-1'))!;
    assert.deepEqual([job.iteration, job.fixes, job.mr_attempts], [1, 0, 1]);
  } finally {
    await stop(served);
  }
});

test('sf retry is refused with invalid_state on review_failed, on mr_conflict, on working and with a prepared commit; refused, it changes nothing', async () => {
  const env = await newEnv('retry-refused');
  await newRepo(env, 'retry-refused-repo', false);
  const served = await serve(env);
  try {
    const jobs = new JobStore(env.state);
    const at = new Date().toISOString();
    const record = (ticket: string, extra: Partial<Job>): Job => ({
      workspace: 'app', ticket, branch: `${ticket}-x`, base: 'main', base_commit: null, target_commit: null, worktree: join(temp, 'retry-refused-wt'), prepared_commit: null,
      mr_attempts: 1, mr_conflict_turn: false, state: 'needs_human', iteration: 1, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null, mr: null, created_at: at, updated_at: at, ...extra,
    });
    const cases: Array<[string, Partial<Job>, RegExp]> = [
      ['R-1', { error: { code: 'review_failed', message: 'overloaded' } }, /the job is needs_human \(review_failed\)\.$/],
      ['R-2', { error: { code: 'mr_conflict', message: 'conflicts' } }, /the job is needs_human \(mr_conflict\)\.$/],
      ['R-3', { state: 'working' }, /the job is working\.$/],
      ['R-4', { error: { code: 'mr_failed', message: 'boom' }, prepared_commit: 'a'.repeat(40) }, /with a prepared commit\.$/],
    ];
    for (const [ticket, extra, message] of cases) {
      await jobs.write(record(ticket, extra));
      const refused = await refusal(env, ticket);
      assert.equal(refused.code, 'invalid_state', ticket);
      assert.match(refused.message, message, ticket);
      assert.deepEqual(await jobs.read('app', ticket), record(ticket, extra), ticket);
    }
    const cli = await retry(env, 'R-1');
    assert.equal(cli.code, 1);
    assert.match(cli.stderr, /^sf: sf retry needs needs_human after a transient MR preparation failure \(fetch_failed, mr_serve_restarted, mr_interrupted, mr_commit_failed, mr_rebase_failed, mr_failed\) or a failed push \(mr_push_failed\); the job is needs_human \(review_failed\)\.$/m);
  } finally {
    await stop(served);
  }
});

test('mr_serve_restarted after recover(): a retry whose fetch fails stops with fetch_failed; the next one prepares the MR without a new review; then mr_push_failed, and sf retry pushes once origin is back', async () => {
  const env = await newEnv('retry-restart', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'retry-restart-repo', true);
  const origin = join(temp, 'retry-restart-repo-origin.git');
  await putTask(env, repo, 'S-1', 'Serve restarts');
  await script(env, [
    { write: { 'README.md': 'hello reader\n' }, text: 'iteration 1' },
    // The MR text turn of the first preparation outlives its runner.
    { delayMs: 60_000, text: 'never' },
    { write: { '.software-factory/S-1.mr.md': mrText('feat(S-1): Serve restarts') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: { verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [] } }]);
  const jobs = new JobStore(env.state);
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-1' });
    await waitFor(served, 'S-1', 'preparing_mr', 1);
    // The MR text turn has taken its (delayed) script entry before its runner is killed.
    await turnsStarted(env, 2);
  } finally {
    await stop(served);
  }
  const runner = Number((await readFile(lockOf(env, 'S-1'), 'utf8')).trim().split(' ')[0]);
  process.kill(runner, 'SIGKILL');
  await until('the runner to end', async () => !alive(runner));
  served = await serve(env);
  try {
    const restarted = await waitFor(served, 'S-1', 'needs_human', 1);
    assert.equal(restarted.error.code, 'mr_serve_restarted');

    // The retry's fetch fails: the job stops again, now with fetch_failed.
    git(repo, 'remote', 'set-url', 'origin', join(temp, 'no-such-origin.git'));
    assert.equal((await retry(env, 'S-1')).code, 1);
    assert.equal((await waitFor(served, 'S-1', 'needs_human', 1)).error.code, 'fetch_failed');
    git(repo, 'remote', 'set-url', 'origin', origin);
    const retried = await retry(env, 'S-1');
    assert.equal(retried.code, 0, retried.stdout + retried.stderr);
    await waitFor(served, 'S-1', 'ready_for_human_review', 1);
    assert.equal((await reviewLog(env)).length, 1);
    // No new Implementer turn but the MR text turn (the killed one is not logged); an MR text turn
    // had run, so its prompt names the previous error.
    const log = await fakeLog(env);
    assert.equal(log.filter((entry) => entry.prompt.startsWith('/implement')).length, 1);
    const last = log.at(-1)!.prompt;
    assert.match(last, /^MR preparation for S-1 on branch S-1-serve-restarts\./);
    assert.ok(last.includes('git fetch origin'), last);
    assert.equal((await jobs.read('app', 'S-1'))!.mr_attempts, 2);

    // A failed push: sf retry is sf approve once origin is back.
    git(repo, 'remote', 'set-url', 'origin', join(temp, 'no-such-origin.git'));
    assert.equal((await runCli(env, ['approve', 'app', 'S-1'])).code, 1);
    assert.equal((await waitFor(served, 'S-1', 'needs_human', 1)).error.code, 'mr_push_failed');
    const failedAgain = await retry(env, 'S-1');
    assert.equal(failedAgain.code, 1);
    assert.match(failedAgain.stdout, /^state: needs_human$/m);
    assert.match(failedAgain.stdout, /^The push failed; fix it and run sf retry again\.$/m);
    git(repo, 'remote', 'set-url', 'origin', origin);
    const pushed = await retry(env, 'S-1');
    assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
    assert.match(pushed.stdout, /^state: pushed$/m);
    assert.equal(execFileSync('git', ['--git-dir', origin, 'rev-parse', 'refs/heads/S-1-serve-restarts'], { encoding: 'utf8' }).trim(), (await jobs.read('app', 'S-1'))!.prepared_commit);
    assert.equal((await reviewLog(env)).length, 1);
  } finally {
    await stop(served);
  }
});

test('mr_failed after a conflict turn (the resolution is applied, then the publish fails): sf retry is refused, the iteration must be reviewed again', async () => {
  const env = await newEnv('retry-conflict');
  const repo = await newRepo(env, 'retry-conflict-repo', true);
  const origin = join(temp, 'retry-conflict-repo-origin.git');
  await putTask(env, repo, 'C-1', 'Conflict');
  const meta = join(env.state, 'jobs', 'app', 'C-1', 'iterations', '001', 'meta.json');
  await script(env, [
    { write: { 'README.md': 'hello change\n' }, text: 'iteration 1' },
    { write: { '.software-factory/C-1.mr.md': mrText('feat(C-1): Conflict') }, text: 'MR text' },
    // The conflict turn resolves the file, and removes the last iteration's meta.json, so the
    // publication of the resolution fails after the rebase continued.
    { write: { 'README.md': 'hello change and upstream\n' }, run: [['rm', meta]], text: 'resolved' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'C-1' });
    await waitFor(served, 'C-1', 'awaiting_review', 1);
    const other = join(temp, 'retry-conflict-other');
    execFileSync('git', ['clone', '-q', origin, other]);
    execFileSync('sh', ['-c', 'printf "hello upstream\\n" > README.md'], { cwd: other });
    git(other, 'commit', '-q', '-am', 'upstream');
    git(other, 'push', '-q', 'origin', 'main');

    await call(served, 'mark_clean', { workspace: 'app', ticket: 'C-1' });
    const stopped = await waitFor(served, 'C-1', 'needs_human', 1);
    assert.equal(stopped.error.code, 'mr_failed', JSON.stringify(stopped.error));
    const jobs = new JobStore(env.state);
    assert.equal((await jobs.read('app', 'C-1'))!.mr_conflict_turn, true);
    assert.deepEqual(await refusal(env, 'C-1'), { code: 'invalid_state', message: CONFLICT_TURN });
    assert.equal((await fakeLog(env)).length, 3);
    assert.equal((await jobs.read('app', 'C-1'))!.state, 'needs_human');
  } finally {
    await stop(served);
    await rm(join(temp, 'retry-conflict-other'), { recursive: true, force: true });
  }
});

test('a conflict resolution reviewed clean, then fetch_failed: mr_conflict_turn is cleared once it went back to review, and sf retry prepares the MR without another review', async () => {
  const env = await newEnv('retry-resolved', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'retry-resolved-repo', true);
  const origin = join(temp, 'retry-resolved-repo-origin.git');
  const other = join(temp, 'retry-resolved-other');
  await putTask(env, repo, 'C-2', 'Resolved');
  const upstream = `git clone -q "${origin}" "${other}" && cd "${other}" && printf "hello upstream\\n" > README.md && git commit -q -am upstream && git push -q origin main`;
  await script(env, [
    // Iteration 1, and origin's main moves in the same line, so the rebase of Clean conflicts.
    { write: { 'README.md': 'hello change\n' }, run: [['sh', '-c', upstream]], text: 'iteration 1' },
    { write: { '.software-factory/C-2.mr.md': mrText('feat(C-2): Resolved') }, text: 'MR text' },
    // The conflict turn resolves it and points origin at a missing path: the fetch after the clean
    // review of the resolution fails.
    { write: { 'README.md': 'hello change and upstream\n' }, run: [['git', 'remote', 'set-url', 'origin', join(temp, 'no-such-origin.git')]], text: 'resolved' },
    // The MR text turn of the Retry: the MR text is still in the worktree.
    { text: 'MR text kept' },
  ]);
  const clean = { output: { verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [] } };
  await reviewScript(env, [clean, clean]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'C-2' });
    const stopped = await waitFor(served, 'C-2', 'needs_human', 2);
    assert.equal(stopped.error.code, 'fetch_failed', JSON.stringify(stopped.error));
    assert.match(stopped.report, /^resolved\n\n## MR preparation\n/);
    const jobs = new JobStore(env.state);
    assert.deepEqual([(await jobs.read('app', 'C-2'))!.mr_conflict_turn, (await jobs.read('app', 'C-2'))!.mr_attempts], [false, 1]);
    assert.equal((await reviewLog(env)).length, 2);

    git(repo, 'remote', 'set-url', 'origin', origin);
    const retried = await retry(env, 'C-2');
    assert.equal(retried.code, 0, retried.stdout + retried.stderr);
    assert.equal(retried.stdout, 'state: preparing_mr\niteration: 2\nbranch: C-2-resolved\n');
    await waitFor(served, 'C-2', 'ready_for_human_review', 2);
    assert.equal(git(repo, 'show', 'C-2-resolved:README.md'), 'hello change and upstream\n');
    // No third review; the Implementer ran only the MR text turn after the conflict turn.
    assert.equal((await reviewLog(env)).length, 2);
    assert.deepEqual((await fakeLog(env)).map((entry) => entry.prompt.split('\n')[0]).slice(0, 1), ['/implement .software-factory/C-2.md']);
    assert.equal((await fakeLog(env)).length, 4);
    assert.match((await fakeLog(env))[3]!.prompt, /^MR preparation for C-2 on branch C-2-resolved\./);
  } finally {
    await stop(served);
    await rm(other, { recursive: true, force: true });
  }
});
