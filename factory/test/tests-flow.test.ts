// End-to-end tests of the workspace's test command (SF-128) with the real sf serve and CLI, the fake
// Claude and the fake bubblewrap the harness puts first on PATH (test/support/fake-bwrap.ts, SF-125),
// which takes the sandbox's arguments and runs the command: a pass reaches ready with ### Checks in
// the MR text; a failure writes a Tests Fix and the next iteration runs; the third failure stops the
// job (tests_failed) and Accept prepares the MR; Retry after tests_unavailable runs the command
// again; a check answers while a slow run is under way, and Abort during the run leaves no process; a
// timeout is a failure, also in the real bubblewrap under the job's path denials (SF-152); a
// workspace without the key prepares today's MR text. The rest of the real sandbox is
// test/test-command.test.ts's.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveRegistry } from '../src/registry.js';
import { BWRAP_CANNOT_START, bubblewrapStarts, bwrapLog, call, type Env, git, newEnv, newRepo, putTask, reviewScript, runCli, script, serve, stop, waitFor } from './support/harness.js';

const TITLE = 'feat(T-1): Change the README';

function mrText(header = TITLE): string {
  return [
    header, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'Not checked: nothing to run.', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

// Workspace app with an origin and, unless command is undefined, its test_command.
async function testsEnv(name: string, command: string | undefined, extra: Record<string, string> = {}, options: { realBwrap?: boolean } = {}): Promise<{ env: Env; repo: string }> {
  const env = await newEnv(name, extra, options);
  const repo = await newRepo(env, `${name}-repo`, true);
  await setCommand(env, repo, command);
  await putTask(env, repo, 'T-1', 'Change README');
  return { env, repo };
}

const setCommand = (env: Env, repo: string, command: string | undefined): Promise<void> =>
  saveRegistry({ workspaces: { app: { read_checkout: repo, ...(command !== undefined ? { test_command: command } : {}) } } }, env.config);

const jobDir = (env: Env): string => join(env.state, 'jobs', 'app', 'T-1');
const jobJson = async (env: Env): Promise<Record<string, any>> => JSON.parse(await readFile(join(jobDir(env), 'job.json'), 'utf8'));
const testsRecord = async (env: Env, iteration: number): Promise<Record<string, any>> => JSON.parse(await readFile(join(jobDir(env), `tests-${iteration}.json`), 'utf8'));
const taskText = (repo: string): Promise<string> => readFile(join(repo, '.software-factory', 'T-1.md'), 'utf8');

async function events(env: Env): Promise<Array<Record<string, any>>> {
  return (await readFile(join(jobDir(env), 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

// The pids of the processes whose argv is exactly argv.
async function processesOf(argv: string[]): Promise<number[]> {
  const wanted = `${argv.join('\0')}\0`;
  const pids: number[] = [];
  for (const name of await readdir('/proc')) {
    if (/^\d+$/.test(name) && (await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '')) === wanted) {
      pids.push(Number(name));
    }
  }
  return pids;
}

async function until(check: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// A `sleep 60` only this test runs: 60 seconds and a fraction nobody else uses.
const slowSleep = (): string[] => ['sleep', `60.${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`];

test('a passing run reaches ready_for_human_review with ### Checks in the MR text and the commit', async () => {
  const { env, repo } = await testsEnv('tests-pass', 'exit 0');
  await script(env, [{ write: { 'README.md': 'hello world\n' }, text: 'iteration 1' }, { write: { '.software-factory/T-1.mr.md': mrText() }, text: 'prepared' }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    assert.equal((await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' })).state, 'preparing_mr');
    const ready = await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    const record = await testsRecord(env, 1);
    assert.deepEqual([record.command, record.outcome, record.exit_code, record.timed_out], ['exit 0', 'passed', 0, false]);
    // The command ran through bwrap (the fake, first on PATH) with the sandbox's arguments.
    const runs = await bwrapLog(env);
    assert.equal(runs.length, 1, JSON.stringify(runs));
    assert.deepEqual([runs[0]!.argv.slice(0, 3), runs[0]!.argv.at(-1)], [['--die-with-parent', '--unshare-pid', '--unshare-net'], 'exit 0']);
    const text = await readFile(join(jobDir(env), 'mr.md'), 'utf8');
    assert.match(text, /\n## Testing\nNot checked: nothing to run\.\n\n### Checks\n- `exit 0`: passed in \d+ s on iteration 1\.\n\n## Screenshots\n/u);
    assert.match(git(repo, 'log', '-1', '--format=%B', ready.branch), /### Checks\n- `exit 0`: passed in \d+ s on iteration 1\./u);
    const types = (await events(env)).map((event) => event.type).filter((type) => type === 'tests_started' || type === 'tests');
    assert.deepEqual(types, ['tests_started', 'tests']);
    assert.equal((await jobJson(env)).mr_attempts, 1);
  } finally {
    await stop(served);
  }
});

test('a failure writes a Tests Fix and the next iteration runs; the third failure is tests_failed, and Accept prepares the MR', async () => {
  const { env, repo } = await testsEnv('tests-fail', 'echo "not ok 1"; exit 1', { SF_REVIEW: 'on', SF_MAX_ITERATIONS: '1' });
  await script(env, [
    { write: { 'README.md': 'one\n' }, text: 'iteration 1' },
    { write: { 'README.md': 'two\n' }, text: 'iteration 2' },
    { write: { 'README.md': 'three\n' }, text: 'iteration 3' },
    { write: { '.software-factory/T-1.mr.md': mrText() }, text: 'prepared' },
  ]);
  const clean = { output: { verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [] } };
  await reviewScript(env, [clean, clean, clean]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    const stopped = await waitFor(served, 'T-1', 'needs_human', 3);
    assert.equal(stopped.error.code, 'tests_failed');
    assert.equal(stopped.error.message, 'The workspace\'s tests still fail after 2 Tests Fix rounds: `echo "not ok 1"; exit 1` (exit 1) on iteration 3. Accept the iteration without passing tests (sf accept), or tell the Implementer what to do (sf say).');
    const task = await taskText(repo);
    assert.equal(task.match(/^## Fix \d+: Tests$/gmu)?.length, 2);
    assert.ok(task.includes([
      '## Fix 1: Tests', '',
      "The factory ran the workspace's test command on your worktree, in a sandbox without network, and it failed: `echo \"not ok 1\"; exit 1`. It exited with 1. Make the tests pass; do not weaken or skip a test to get there.",
      '', 'The last lines of its output (all of it):', '', '```text', 'not ok 1', '```',
    ].join('\n')), task);
    // A Tests Fix uses up neither SF_MAX_ITERATIONS (1 here) nor an MR attempt.
    const job = await jobJson(env);
    assert.deepEqual([job.fixes, job.mr_attempts], [0, 0]);
    assert.deepEqual(await Promise.all([1, 2, 3].map(async (n) => (await testsRecord(env, n)).outcome)), ['failed', 'failed', 'failed']);

    const accepted = await runCli(env, ['accept', 'app', 'T-1']);
    assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
    await waitFor(served, 'T-1', 'ready_for_human_review', 3);
    const record = await testsRecord(env, 3);
    assert.deepEqual([record.outcome, record.accepted_from, record.exit_code], ['accepted_failing', 'failed', 1]);
    assert.ok((await readFile(join(jobDir(env), 'mr.md'), 'utf8')).includes('### Checks\n- `echo "not ok 1"; exit 1`: failed (exit 1); accepted by the user without passing tests.\n'));
    // The accepted iteration ran no test again.
    assert.equal((await events(env)).filter((event) => event.type === 'tests_started').length, 3);
  } finally {
    await stop(served);
  }
});

test('exit 127 stops the job as tests_unavailable; Retry runs the command again', async () => {
  // Retry needs a clean Claude review of the iteration.
  const { env, repo } = await testsEnv('tests-retry', 'exit 127', { SF_REVIEW: 'on' });
  await script(env, [{ write: { 'README.md': 'hello world\n' }, text: 'iteration 1' }, { write: { '.software-factory/T-1.mr.md': mrText() }, text: 'prepared' }]);
  await reviewScript(env, [{ output: { verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [] } }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    const stopped = await waitFor(served, 'T-1', 'needs_human', 1);
    assert.equal(stopped.error.code, 'tests_unavailable');
    assert.equal(stopped.error.message.split('\n')[0], 'the command was not found (exit 127).');
    assert.equal((await jobJson(env)).mr_attempts, 0);

    const again = await runCli(env, ['retry', 'app', 'T-1']);
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.equal((await waitFor(served, 'T-1', 'needs_human', 1)).error.code, 'tests_unavailable');
    assert.equal((await events(env)).filter((event) => event.type === 'tests_started').length, 2);

    await setCommand(env, repo, 'exit 0');
    const fixed = await runCli(env, ['retry', 'app', 'T-1']);
    assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
    await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    assert.equal((await testsRecord(env, 1)).outcome, 'passed');
  } finally {
    await stop(served);
  }
});

test('a check answers while a slow run is under way, and Abort during the run leaves no process and no record', async () => {
  const sleep = slowSleep();
  const { env } = await testsEnv('tests-abort', sleep.join(' '));
  await script(env, [{ write: { 'README.md': 'hello world\n' }, text: 'iteration 1' }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await until(async () => (await processesOf(sleep)).length > 0, 'the run to start');
    const asked = Date.now();
    assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'T-1' })).state, 'preparing_mr');
    assert.ok(Date.now() - asked < 5000, `check took ${Date.now() - asked} ms`);
    const aborted = await runCli(env, ['abort', 'app', 'T-1']);
    assert.equal(aborted.code, 0, aborted.stdout + aborted.stderr);
    await until(async () => (await processesOf(sleep)).length === 0, 'the run to end');
    assert.equal((await jobJson(env)).state, 'aborted');
    assert.equal((await events(env)).some((event) => event.type === 'tests'), false);
    await assert.rejects(readFile(join(jobDir(env), 'tests-1.json')), { code: 'ENOENT' });
  } finally {
    await stop(served);
  }
});

test('a run that times out is a failure: a Tests Fix names the timeout', async () => {
  const sleep = slowSleep();
  const { env, repo } = await testsEnv('tests-timeout', sleep.join(' '), { SF_TEST_TIMEOUT_MS: '1000' });
  await script(env, [{ write: { 'README.md': 'one\n' }, text: 'iteration 1' }, { write: { 'README.md': 'two\n' }, text: 'iteration 2' }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 2);
    const record = await testsRecord(env, 1);
    assert.deepEqual([record.outcome, record.timed_out, record.exit_code], ['failed', true, null]);
    assert.ok((await taskText(repo)).includes('It timed out after 1 s and was stopped.'));
    await until(async () => (await processesOf(sleep)).length === 0, 'the timed-out run to end', 5000);
    const aborted = await runCli(env, ['abort', 'app', 'T-1']);
    assert.equal(aborted.code, 0, aborted.stdout + aborted.stderr);
  } finally {
    await stop(served);
  }
});

// SF-152: the same through the real bubblewrap, under the path denials pathDenials builds for this
// test's state directory and worktree root (the fake bwrap off PATH); skipped where it cannot start.
test('with the real bubblewrap and the job\'s path denials, a run that times out ends at its limit: a Tests Fix names the timeout and no process is left', { skip: bubblewrapStarts() ? false : BWRAP_CANNOT_START }, async () => {
  // A sleep of ten minutes only this test runs.
  const sleep = ['sleep', `600.${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`];
  // SF_SANDBOX=off: the fake Claude Code, which keeps its scripts and logs in $HOME, runs without the
  // Implementer's real wrapper (SF-181), which would hide and refuse them; the test command's sandbox does not depend on it.
  const { env, repo } = await testsEnv('tests-timeout-real', `echo before; ${sleep.join(' ')}`, { SF_TEST_TIMEOUT_MS: '2000', SF_SANDBOX: 'off' }, { realBwrap: true });
  await script(env, [{ write: { 'README.md': 'one\n' }, text: 'iteration 1' }, { write: { 'README.md': 'two\n' }, text: 'iteration 2' }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 2);
    const record = await testsRecord(env, 1);
    assert.deepEqual([record.outcome, record.timed_out, record.exit_code, record.output], ['failed', true, null, 'before\n'], JSON.stringify(record));
    assert.ok(record.duration_ms >= 2000 && record.duration_ms < 15_000, String(record.duration_ms));
    // The real sandbox ran it: the fake one logs every call.
    assert.deepEqual(await bwrapLog(env), []);
    assert.ok((await taskText(repo)).includes('It timed out after 2 s and was stopped.'));
    await until(async () => (await processesOf(sleep)).length === 0, 'the timed-out run to end', 5000);
    const aborted = await runCli(env, ['abort', 'app', 'T-1']);
    assert.equal(aborted.code, 0, aborted.stdout + aborted.stderr);
  } finally {
    await stop(served);
  }
});

test('a workspace without test_command prepares the MR as before: no run, no record, no event, no ### Checks', async () => {
  const { env } = await testsEnv('tests-none', undefined);
  await script(env, [{ write: { 'README.md': 'hello world\n' }, text: 'iteration 1' }, { write: { '.software-factory/T-1.mr.md': mrText() }, text: 'prepared' }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    assert.equal(await readFile(join(jobDir(env), 'mr.md'), 'utf8'), mrText());
    assert.deepEqual((await readdir(jobDir(env))).filter((name) => name.startsWith('tests-')), []);
    assert.equal((await events(env)).some((event) => event.type === 'tests' || event.type === 'tests_started'), false);
  } finally {
    await stop(served);
  }
});
