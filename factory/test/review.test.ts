// End-to-end tests of the Claude review of every iteration (SF-038) with the real sf serve and the
// fake Claude, whose runs with --json-schema are reviews scripted by $HOME/fake-review.json: a fix
// verdict becomes ## Fix N and the next iteration, a clean one runs Clean, undeclared sensitive
// paths, failures, SF_REVIEW=off and the review at serve start, abort during a review, the limit on
// Fix sections, and what check, sf watch, sf status and the dashboard show.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { handbookSection } from '../src/prompts.js';
import { REVIEW_DENIED_TOOLS, REVIEW_SCHEMA } from '../src/review.js';
import { loadHandbook } from '../src/server.js';
import { fetchRaw } from './support/dashboard-client.js';
import { call, type Env, fakeLog, git, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, task, waitFor } from './support/harness.js';

const FIX = {
  verdict: 'fix',
  summary: 'The greeting  is\nwrong.',
  items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.' }],
  accepted_sensitive: [],
};
const CLEAN = { verdict: 'clean', summary: 'The greeting is right.', items: [], accepted_sensitive: [] };
const FIX_SECTION = '## Fix 1\n\nReview by Claude: The greeting is wrong.\n\n1. `README.md`: It greets the world. Expected: It greets the reader.\n';

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'x', '## Why', 'The ticket asks for it.', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
    '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

const taskFile = (repo: string, ticket: string): Promise<string> => readFile(join(repo, '.software-factory', `${ticket}.md`), 'utf8');
const worktreeOf = (env: Env, ticket: string): string => join(env.state, 'worktrees', 'app', ticket);
const option = (argv: string[], name: string): string | undefined => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function eventsOf(env: Env, ticket: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(env.state, 'jobs', 'app', ticket, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

test('fix, then clean: the Fix section from the items, the next iteration, Clean; the read-only argv, the prompt, review.json, check, sf watch, sf status and the dashboard', async () => {
  const env = await newEnv('review-cycle', { SF_REVIEW: 'on', SF_REVIEW_MAX_TURNS: '7', SF_REVIEW_MODEL: 'fake-reviewer' });
  const repo = await newRepo(env, 'review-cycle-repo', false);
  await putTask(env, repo, 'R-1', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2' },
    { write: { '.software-factory/R-1.mr.md': mrText('feat(R-1): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: FIX }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-1' });
    const ready = await waitFor(served, 'R-1', 'ready_for_human_review', 2);
    assert.deepEqual(ready.review, { status: 'done', verdict: 'clean', summary: CLEAN.summary });
    assert.equal(await taskFile(repo, 'R-1'), `${task('R-1', 'Greet the reader')}\n\n${FIX_SECTION}`);
    assert.equal(git(repo, 'show', 'R-1-greet-the-reader:README.md'), 'hello reader\n');
    const jobs = new JobStore(env.state);
    assert.equal((await jobs.read('app', 'R-1'))!.fixes, 1);

    // The Implementer: the first iteration, the Fix of the review, the MR text turn of Clean.
    const turns = await fakeLog(env);
    assert.deepEqual(turns.map((entry) => entry.prompt.split('\n')[0]), [
      '/implement .software-factory/R-1.md',
      '/implement .software-factory/R-1.md Fix 1',
      'MR preparation for R-1 on branch R-1-greet-the-reader. The user approved the reviewed change.',
    ]);

    // The reviews: fresh read-only sessions in the worktree with the schema and their own limits.
    const reviews = await reviewLog(env);
    assert.equal(reviews.length, 2);
    for (const entry of reviews) {
      assert.equal(entry.cwd, worktreeOf(env, 'R-1'));
      assert.equal(option(entry.argv, 'tools'), 'Read,Grep,Glob');
      assert.deepEqual(option(entry.argv, 'disallowedTools')!.split(','), REVIEW_DENIED_TOOLS);
      assert.deepEqual(JSON.parse(option(entry.argv, 'json-schema')!), REVIEW_SCHEMA);
      assert.deepEqual([option(entry.argv, 'max-turns'), option(entry.argv, 'model'), option(entry.argv, 'permission-mode')], ['7', 'fake-reviewer', 'auto']);
      assert.ok(!entry.argv.some((arg) => arg.startsWith('--resume')), entry.argv.join(' '));
      assert.ok(!turns.some((turn) => turn.sessionId === entry.sessionId));
      assert.ok(!entry.env.some((name) => name.startsWith('SF_')));
    }
    assert.equal(REVIEW_DENIED_TOOLS.filter((tool) => ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Read(**/.env)'].includes(tool)).length, 9);
    const [first, second] = reviews.map((entry) => entry.prompt);
    assert.match(first!, /^Code review of iteration 1 of ticket R-1\. /);
    assert.ok(first!.includes(handbookSection((await loadHandbook()).text, '## Review rules for the Context owner')));
    assert.ok(first!.includes(`<task_file path=".software-factory/R-1.md">\n${task('R-1', 'Greet the reader').trimEnd()}\n</task_file>`));
    assert.ok(first!.includes('<report>\nReport of iteration 1\n'));
    assert.ok(first!.includes('<sensitive_and_deleted_paths>\nNone.\n</sensitive_and_deleted_paths>'));
    assert.match(first!, /<patch>\ndiff --git a\/README\.md b\/README\.md\n[\s\S]*\n\+hello world\n<\/patch>$/);
    assert.match(second!, /^Code review of iteration 2 of ticket R-1\. /);
    assert.ok(second!.includes(`${FIX_SECTION.trimEnd()}\n</task_file>`));
    assert.ok(second!.includes('+hello reader'));

    // review.json of each iteration, the events, check, sf watch, sf status and the dashboard.
    const recorded = await jobs.readReview('app', 'R-1', 1);
    assert.ok(recorded !== undefined && 'verdict' in recorded);
    const { started_at: startedAt, ended_at: endedAt, ...rest } = recorded;
    assert.deepEqual(rest, { reviewer: 'claude', ...FIX, cost_usd: 0.0456 });
    assert.ok(Date.parse(startedAt) <= Date.parse(endedAt));
    assert.deepEqual((await eventsOf(env, 'R-1')).filter((record) => record.type === 'review').map(({ ts: _ts, ...record }) => record), [
      { iteration: 1, type: 'review', reviewer: 'claude', verdict: 'fix', items: 1 },
      { iteration: 2, type: 'review', reviewer: 'claude', verdict: 'clean', items: 0 },
    ]);
    const watched = await runCli(env, ['watch', 'app', 'R-1', '--once']);
    assert.match(watched.stdout, /^\d\d:\d\d:\d\d \[1\] review by claude: fix \(1 item\)$/m);
    assert.match(watched.stdout, /^\d\d:\d\d:\d\d \[2\] review by claude: clean$/m);
    // The Implementer's cost (0.0123, then 0 more in the same session) and both reviews.
    assert.equal((await jobs.recordedCost('app', 'R-1', 2))!.toFixed(4), '0.1035');
    assert.match((await runCli(env, ['status'])).stdout, /\bR-1\b.*\b0\.1035\b/);
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/R-1', served.dashboard!))).body);
    assert.deepEqual(detail.iterations.map((iteration: { review: { verdict: string } | null }) => iteration.review?.verdict), ['fix', 'clean']);
    assert.deepEqual(detail.iterations[0].review.items, FIX.items);
  } finally {
    await stop(served);
  }
});

test('clean with an undeclared sensitive path it does not accept becomes a fix; accepted, Clean passes it on', async () => {
  const env = await newEnv('review-sensitive', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-sensitive-repo', false);
  await putTask(env, repo, 'S-1', 'Add a script');
  await script(env, [
    { write: { 'package.json': '{}\n', 'a.txt': 'a\n' }, text: 'iteration 1' },
    { text: 'package.json is needed: the tests run with npm.' },
    { write: { '.software-factory/S-1.mr.md': mrText('feat(S-1): Add a script') }, text: 'prepared' },
  ]);
  const accepted = { ...CLEAN, summary: 'package.json is accepted: the tests run with npm.', accepted_sensitive: ['package.json'] };
  await reviewScript(env, [{ output: CLEAN }, { output: accepted }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-1' });
    const ready = await waitFor(served, 'S-1', 'ready_for_human_review', 2);
    assert.equal(ready.review.summary, accepted.summary);
    assert.ok((await taskFile(repo, 'S-1')).endsWith(
      '\n\n## Fix 1\n\nReview by Claude: The greeting is right.\n\n1. `package.json`: Undeclared sensitive path. Expected: Remove it, or justify it in the Report.\n',
    ));
    const [first] = await reviewLog(env);
    assert.ok(first!.prompt.includes('<sensitive_and_deleted_paths>\n- sensitive, undeclared: package.json\n</sensitive_and_deleted_paths>'));
    assert.equal(git(repo, 'show', '--name-only', '--format=', 'S-1-add-a-script').trim(), 'a.txt\npackage.json');
    // The review's own verdict is what the event records.
    assert.deepEqual((await eventsOf(env, 'S-1')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.verdict]), [[1, 'clean'], [2, 'clean']]);
  } finally {
    await stop(served);
  }
});

test('a failed review (a turn that is not a success, no output, an invalid verdict, fix without items) is needs_human review_failed', async () => {
  const env = await newEnv('review-failed', { SF_REVIEW: 'on', SF_MAX_JOBS: '4' });
  const repo = await newRepo(env, 'review-failed-repo', false);
  const cases = [
    { review: { subtype: 'error_max_turns' }, message: /^The review ended with error_max_turns: fake review failure$/ },
    { review: { noOutput: true }, message: /^The review returned no structured output\.$/ },
    { review: { output: { ...CLEAN, verdict: 'maybe' } }, message: /^The review returned an invalid verdict: verdict: / },
    { review: { output: { ...FIX, items: [] } }, message: /^The review returned fix without items\.$/ },
  ];
  await script(env, cases.map((_, index) => ({ write: { [`f${index}.txt`]: 'f\n' } })));
  await reviewScript(env, cases.map((entry) => entry.review));
  const served = await serve(env);
  try {
    for (const [index, entry] of cases.entries()) {
      const ticket = `F-${index + 1}`;
      await putTask(env, repo, ticket, `Fail ${index + 1}`);
      await call(served, 'start', { workspace: 'app', ticket });
      const failed = await waitFor(served, ticket, 'needs_human', 1);
      assert.equal(failed.error.code, 'review_failed');
      assert.match(failed.error.message, entry.message);
      assert.deepEqual(failed.review, { status: 'failed', summary: failed.error.message });
      assert.deepEqual(await new JobStore(env.state).readReview('app', ticket, 1), { reviewer: 'claude', error: failed.error.message });
      assert.doesNotMatch(await taskFile(repo, ticket), /## Fix/);
    }
    assert.match((await runCli(env, ['watch', 'app', 'F-2', '--once'])).stdout, /\[1\] review by claude failed: The review returned no structured output\.$/m);
  } finally {
    await stop(served);
  }
});

test('SF_REVIEW=off: the job stays awaiting_review; at the next sf serve with the review on, the iteration without a review gets one', async () => {
  const env = await newEnv('review-off');
  const repo = await newRepo(env, 'review-off-repo', false);
  await putTask(env, repo, 'O-1', 'Off');
  await script(env, [{ write: { 'o.txt': 'o\n' } }, { write: { 'o.txt': 'oo\n' } }]);
  await reviewScript(env, [{ output: FIX }, { delayMs: 5000 }]);
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'O-1' });
    await waitFor(served, 'O-1', 'awaiting_review', 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const off = await call(served, 'check', { workspace: 'app', ticket: 'O-1' });
    assert.deepEqual([off.state, off.review], ['awaiting_review', { status: 'off' }]);
    assert.equal(await exists(join(env.home, 'fake-review.log')), false);
  } finally {
    await stop(served);
  }
  env.extra = { SF_REVIEW: 'on' };
  served = await serve(env);
  try {
    // The review of iteration 1 runs at start: its Fix starts iteration 2, whose review is running.
    const second = await waitFor(served, 'O-1', 'awaiting_review', 2);
    assert.deepEqual(second.review, { status: 'running' });
    assert.ok((await taskFile(repo, 'O-1')).endsWith(`\n\n${FIX_SECTION}`));
    assert.equal((await reviewLog(env)).length, 1);
  } finally {
    await stop(served);
  }
});

test('abort during a running review: the review is cancelled, its outcome never applied, the job stays aborted', async () => {
  const env = await newEnv('review-abort', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-abort-repo', false);
  await putTask(env, repo, 'A-1', 'Abort');
  await script(env, [{ write: { 'a.txt': 'a\n' } }, { text: 'never' }]);
  await reviewScript(env, [{ delayMs: 1500, output: FIX }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'A-1' });
    const waiting = await waitFor(served, 'A-1', 'awaiting_review', 1);
    assert.deepEqual(waiting.review, { status: 'running' });
    const aborted = await runCli(env, ['abort', 'app', 'A-1']);
    assert.equal(aborted.code, 0, aborted.stderr);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const checked = await call(served, 'check', { workspace: 'app', ticket: 'A-1' });
    assert.deepEqual([checked.state, checked.iteration, checked.review], ['aborted', 1, undefined]);
    assert.equal(await new JobStore(env.state).readReview('app', 'A-1', 1), undefined);
    assert.doesNotMatch(await taskFile(repo, 'A-1'), /## Fix/);
    assert.equal((await eventsOf(env, 'A-1')).filter((record) => typeof record.type === 'string' && record.type.startsWith('review')).length, 0);
    assert.equal((await fakeLog(env)).length, 1);
  } finally {
    await stop(served);
  }
});

test('SF_MAX_ITERATIONS=1 counts Fix sections: an sf say turn and one Fix are allowed, the second Fix is refused; a review the job outran is not applied', async () => {
  const env = await newEnv('review-limit', { SF_REVIEW: 'on', SF_MAX_ITERATIONS: '1' });
  const repo = await newRepo(env, 'review-limit-repo', false);
  await putTask(env, repo, 'L-1', 'Limit');
  await script(env, [{ write: { 'a.txt': '1\n' } }, { write: { 'a.txt': '2\n' }, text: 'said' }, { write: { 'a.txt': '3\n' }, text: 'fixed' }]);
  await reviewScript(env, [{ delayMs: 1500, output: FIX }, { output: FIX }, { output: FIX }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    await waitFor(served, 'L-1', 'awaiting_review', 1);
    // The review of iteration 1 still runs: the user's message moves the job on.
    const said = await runCli(env, ['say', 'app', 'L-1', 'also', 'this']);
    assert.equal(said.code, 0, said.stderr);
    const limited = await waitFor(served, 'L-1', 'needs_human', 3);
    assert.deepEqual(limited.error, { code: 'iteration_limit', message: '1 Fix sections were written, the limit of SF_MAX_ITERATIONS; the user decides how to go on.' });
    const text = await taskFile(repo, 'L-1');
    assert.deepEqual(text.match(/^## Fix \d+$/gm), ['## Fix 2']);
    assert.equal((await new JobStore(env.state).read('app', 'L-1'))!.fixes, 1);
    assert.deepEqual((await fakeLog(env)).map((entry) => entry.prompt.split('\n')[0]), ['/implement .software-factory/L-1.md', 'also this', '/implement .software-factory/L-1.md Fix 2']);
    // Iteration 1's review was cancelled by the next one, or recorded as ignored; never applied.
    const reviews = (await eventsOf(env, 'L-1')).filter((record) => record.type === 'review');
    assert.deepEqual(reviews.filter((record) => record.ignored !== true).map((record) => record.iteration), [2, 3]);
  } finally {
    await stop(served);
  }
});
