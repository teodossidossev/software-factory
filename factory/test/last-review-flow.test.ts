// End-to-end tests of the last review after a clean round with the real sf serve, the fake Claude
// (its --json-schema runs are the Claude reviews and the last reviews, in order) and a skill folder
// under the test's home: none without last_review_skill; one read-only session per clean iteration
// that reads the skill's copy, the Task file and the Patch, and whose comments are stored with the
// iteration and go into no MR text; MR preparation's commit waits for it; a failure or a skill
// folder without SKILL.md is recorded and the job goes on; Abort leaves no record; a Tests Fix's
// new iteration replaces the earlier iteration's run with its own.
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { lastReviewRecord } from '../src/execution/last-review-step.js';
import { JobStore } from '../src/jobs.js';
import { skillSha256 } from '../src/last-review.js';
import { saveRegistry } from '../src/registry.js';
import { REVIEW_DENIED_TOOLS } from '../src/review.js';
import { assertPathDenials, call, type Env, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, waitFor } from './support/harness.js';

const ENV = { SF_REVIEW: 'on', SF_GATE: 'off', SF_SIMPLIFY: 'off' };
const CLEAN = { verdict: 'clean', summary: 'Looks right.', items: [], accepted_sensitive: [] };
const FIX = { verdict: 'fix', summary: 'Unchecked.', items: [{ path: 'README.md', problem: 'It greets anyone.', expected: 'Check the reader first.', severity: 'blocker' }], accepted_sensitive: [] };
const COMMENT_TEXT = 'Say which reader the greeting is for.';
const ANSWER = { summary: 'One naming question.', comments: [{ path: './README.md', line: 1, text: COMMENT_TEXT, kind: 'question' }] };

function mrText(ticket: string): string {
  return [
    `feat(${ticket}): Greet the reader`, '',
    '## What', 'x', '## Why', 'The ticket asks for it.', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
    '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

// The turns of a job whose first iteration is clean, then its MR text turn.
const cleanTurns = (ticket: string): unknown[] => [
  { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 1' },
  { write: { [`.software-factory/${ticket}.mr.md`]: mrText(ticket) }, text: 'prepared' },
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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

async function events(env: Env, ticket: string): Promise<Array<Record<string, any>>> {
  return (await readFile(new JobStore(env.state).eventsPath('app', ticket), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>);
}

const lastReviewEvents = async (env: Env, ticket: string): Promise<Array<Record<string, any>>> => (await events(env, ticket)).filter((event) => event.type === 'last_review');
// The Implementer turns that ended: their result messages (a review's messages are review_message events).
const turnsEnded = async (env: Env, ticket: string): Promise<number> => (await events(env, ticket)).filter((event) => event.type === undefined && event.message?.type === 'result').length;
const lastReviewPath = (env: Env, ticket: string, iteration: number): string => join(new JobStore(env.state).iterationDir('app', ticket, iteration), 'last-review.json');
const jobOf = async (env: Env, ticket: string): Promise<Record<string, any>> => (await new JobStore(env.state).read('app', ticket)) as unknown as Record<string, any>;

// A skill folder under the test's home: SKILL.md (front matter, then its body) and CHECKLIST.md;
// without SKILL.md when skill is false.
async function skillFolder(env: Env, name: string, skill = true): Promise<string> {
  const dir = join(env.home, name);
  await mkdir(dir, { recursive: true });
  if (skill) {
    await writeFile(join(dir, 'SKILL.md'), '---\nname: team-review\ndescription: How the team reads a change.\n---\n# Team review\n\nRead every changed line as its next reader would.\n');
  }
  await writeFile(join(dir, 'CHECKLIST.md'), '- Names say what they hold.\n');
  return dir;
}

// Workspace app (no origin) with last_review_skill set to skill and, given, its test_command.
async function lastReviewEnv(name: string, options: { skill?: boolean; command?: string } = {}): Promise<{ env: Env; repo: string; skill: string }> {
  const env = await newEnv(name, ENV);
  const repo = await newRepo(env, `${name}-repo`, false);
  const skill = await skillFolder(env, 'team-review', options.skill ?? true);
  await saveRegistry({ workspaces: { app: { read_checkout: repo, work_checkout: repo, last_review_skill: skill, ...(options.command !== undefined ? { test_command: options.command } : {}) } } }, env.config);
  return { env, repo, skill };
}

test('LR2-1: without last_review_skill a job reaches ready_for_human_review with no last review', async () => {
  const env = await newEnv('last-review-none', ENV);
  const repo = await newRepo(env, 'last-review-none-repo', false);
  await putTask(env, repo, 'L-1', 'Greet the reader');
  await script(env, cleanTurns('L-1'));
  await reviewScript(env, [{ output: CLEAN }, { output: ANSWER }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    await waitFor(served, 'L-1', 'ready_for_human_review', 1);
    assert.equal((await reviewLog(env)).length, 1);
    assert.equal(await exists(lastReviewPath(env, 'L-1', 1)), false);
    assert.deepEqual(await lastReviewEvents(env, 'L-1'), []);
  } finally {
    await stop(served);
  }
});

test('LR2-2, LR2-3: one read-only session after the clean round holds the commit until it ends; its comments are stored, never in the MR text', async () => {
  const { env, repo, skill } = await lastReviewEnv('last-review-run');
  await putTask(env, repo, 'L-2', 'Greet the reader');
  await script(env, cleanTurns('L-2'));
  await reviewScript(env, [{ output: CLEAN }, { output: ANSWER, startFile: 'lr-started', waitFile: 'lr' }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-2' });
    await until(() => exists(join(env.home, 'lr-started')), 'the last review to start');
    // LR2-3: the MR text turn ends while the last review waits; MR preparation holds before its commit.
    await until(async () => (await turnsEnded(env, 'L-2')) === 2, 'the MR text turn to end');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const held = await jobOf(env, 'L-2');
    assert.deepEqual([held.state, held.prepared_commit], ['preparing_mr', null]);
    await writeFile(join(env.home, 'lr'), '');
    await waitFor(served, 'L-2', 'ready_for_human_review', 1);
    assert.notEqual((await jobOf(env, 'L-2')).prepared_commit, null);

    // LR2-2: the session, its prompt and its record.
    const log = await reviewLog(env);
    assert.equal(log.length, 2);
    const run = log[1]!;
    const worktree = join(env.state, 'worktrees', 'app', 'L-2');
    assert.equal(run.cwd, worktree);
    assert.ok(run.argv.join(' ').includes('Read,Grep,Glob'), run.argv.join(' '));
    assertPathDenials(run.argv, env, worktree, REVIEW_DENIED_TOOLS);
    assert.match(run.prompt, /^Last review of ticket L-2, iteration 1: /);
    assert.ok(run.prompt.includes('Read every changed line as its next reader would.'), run.prompt);
    assert.ok(!run.prompt.includes('name: team-review'), run.prompt);
    assert.ok(run.prompt.includes('<skill_file path="CHECKLIST.md">\n- Names say what they hold.\n</skill_file>'), run.prompt);
    assert.ok(run.prompt.includes('<task_file path=".software-factory/L-2.md">'), run.prompt);
    assert.match(run.prompt, /<patch>[\s\S]*\+hello reader[\s\S]*<\/patch>/);

    const jobs = new JobStore(env.state);
    const record = await jobs.readLastReview('app', 'L-2', 1);
    assert.ok(record !== undefined && 'comments' in record, JSON.stringify(record));
    assert.equal(record.reviewer, 'last_review');
    assert.equal(record.summary, ANSWER.summary);
    assert.deepEqual(record.comments, [{ id: 'C1', path: 'README.md', line: 1, text: COMMENT_TEXT, kind: 'question' }]);
    assert.deepEqual(record.skill, { path: skill, sha256: await skillSha256(skill), files: 2 });
    assert.ok(await exists(jobs.lastReviewSkillDir('app', 'L-2')));
    assert.deepEqual(await jobs.readLastReviewSkill('app', 'L-2'), record.skill);
    const ended = await lastReviewEvents(env, 'L-2');
    assert.deepEqual(ended.map((event) => ({ ...event, ts: undefined })), [{ ts: undefined, iteration: 1, type: 'last_review', comments: 1 }]);
    assert.ok(!(await jobs.readMrText('app', 'L-2'))!.includes(COMMENT_TEXT));
  } finally {
    await stop(served);
  }
});

test('LR2-4: a last review that fails is recorded with its error and the job goes on; a timed-out outcome names the time limit', async () => {
  const { env, repo } = await lastReviewEnv('last-review-failed');
  await putTask(env, repo, 'L-3', 'Greet the reader');
  await script(env, cleanTurns('L-3'));
  await reviewScript(env, [{ output: CLEAN }, { subtype: 'error_during_execution', errors: ['The last review broke.'] }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-3' });
    await waitFor(served, 'L-3', 'ready_for_human_review', 1);
    const record = await new JobStore(env.state).readLastReview('app', 'L-3', 1);
    assert.ok(record !== undefined && 'error' in record, JSON.stringify(record));
    assert.match(record.error, /The last review broke\./);
    assert.equal(record.timed_out, false);
    const [ended, ...more] = await lastReviewEvents(env, 'L-3');
    assert.deepEqual(more, []);
    assert.equal(ended!.comments, 0);
    assert.equal(ended!.error, record.error);
    assert.equal('timed_out' in ended!, false);
  } finally {
    await stop(served);
  }

  const at = '2026-11-21T10:00:00.000Z';
  const timedOut = lastReviewRecord({ ok: false, message: 'The last review was aborted.', model: null, startedAt: at, endedAt: at, timedOut: true }, null);
  assert.deepEqual(timedOut, { reviewer: 'last_review', error: 'The last review timed out after 10 minutes.', timed_out: true, skill: null, started_at: at, ended_at: at });
});

test('LR2-5: a job fixed once runs one last review, of its clean iteration 2', async () => {
  const { env, repo } = await lastReviewEnv('last-review-fixed');
  await putTask(env, repo, 'L-4', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: '| R1 | fixed | Checked now. |' },
    { write: { '.software-factory/L-4.mr.md': mrText('L-4') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: FIX }, { output: CLEAN }, { output: ANSWER }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-4' });
    await waitFor(served, 'L-4', 'ready_for_human_review', 2);
    const log = await reviewLog(env);
    assert.equal(log.length, 3);
    assert.match(log[2]!.prompt, /^Last review of ticket L-4, iteration 2: /);
    assert.equal(await exists(lastReviewPath(env, 'L-4', 1)), false);
    assert.ok(await exists(lastReviewPath(env, 'L-4', 2)));
    assert.deepEqual((await lastReviewEvents(env, 'L-4')).map((event) => event.iteration), [2]);
  } finally {
    await stop(served);
  }
});

test('LR2-6: a skill folder without SKILL.md gives a failed last review and the job goes on', async () => {
  const { env, repo, skill } = await lastReviewEnv('last-review-noskill', { skill: false });
  await putTask(env, repo, 'L-5', 'Greet the reader');
  await script(env, cleanTurns('L-5'));
  await reviewScript(env, [{ output: CLEAN }, { output: ANSWER }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-5' });
    await waitFor(served, 'L-5', 'ready_for_human_review', 1);
    assert.equal((await reviewLog(env)).length, 1);
    const record = await new JobStore(env.state).readLastReview('app', 'L-5', 1);
    assert.ok(record !== undefined && 'error' in record, JSON.stringify(record));
    assert.equal(record.error, `The last review's skill folder ${skill} has no SKILL.md.`);
    assert.deepEqual([record.timed_out, record.skill], [false, null]);
    assert.equal((await lastReviewEvents(env, 'L-5'))[0]?.error, record.error);
  } finally {
    await stop(served);
  }
});

test('LR2-7: Abort while the last review runs ends the job aborted with no last-review.json', async () => {
  const { env, repo } = await lastReviewEnv('last-review-abort');
  await putTask(env, repo, 'L-6', 'Greet the reader');
  await script(env, cleanTurns('L-6'));
  await reviewScript(env, [{ output: CLEAN }, { output: ANSWER, startFile: 'lr-started', waitFile: 'lr-never' }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-6' });
    await until(() => exists(join(env.home, 'lr-started')), 'the last review to start');
    const aborted = await runCli(env, ['abort', 'app', 'L-6']);
    assert.equal(aborted.code, 0, aborted.stdout + aborted.stderr);
    assert.equal((await jobOf(env, 'L-6')).state, 'aborted');
    assert.equal(await exists(lastReviewPath(env, 'L-6', 1)), false);
    assert.deepEqual(await lastReviewEvents(env, 'L-6'), []);
  } finally {
    await stop(served);
  }
});

test("LR2-8: after a Tests Fix, iteration 2's clean round replaces iteration 1's last review with its own, which holds iteration 2's MR text turn", async () => {
  // Fails on iteration 1 (README.md says one), passes on iteration 2.
  const { env, repo } = await lastReviewEnv('last-review-tests', { command: 'grep -q two README.md' });
  await putTask(env, repo, 'L-7', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'one\n' }, text: 'Report of iteration 1' },
    // The Tests Fix turn runs once iteration 1's last review has started, so the reviews keep their order.
    { write: { 'README.md': 'two\n' }, text: 'Tests pass now.', waitFile: 'lr-1-started' },
    { write: { '.software-factory/L-7.mr.md': mrText('L-7') }, text: 'prepared' },
  ]);
  await reviewScript(env, [
    { output: CLEAN },
    { output: ANSWER, startFile: 'lr-1-started', waitFile: 'lr-1' },
    { output: CLEAN },
    { output: ANSWER, startFile: 'lr-2-started', waitFile: 'lr-2' },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-7' });
    await until(() => exists(join(env.home, 'lr-2-started')), "iteration 2's last review to start");
    // Iteration 1's run was cancelled when iteration 2's started: it leaves no trace.
    await writeFile(join(env.home, 'lr-1'), '');
    await until(async () => (await turnsEnded(env, 'L-7')) === 3, "iteration 2's MR text turn to end");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(await exists(lastReviewPath(env, 'L-7', 1)), false);
    const held = await jobOf(env, 'L-7');
    assert.deepEqual([held.state, held.iteration, held.prepared_commit], ['preparing_mr', 2, null]);
    assert.equal((await new JobStore(env.state).readTests('app', 'L-7', 1))?.outcome, 'failed');
    await writeFile(join(env.home, 'lr-2'), '');
    await waitFor(served, 'L-7', 'ready_for_human_review', 2);
    assert.equal(await exists(lastReviewPath(env, 'L-7', 1)), false);
    assert.ok(await exists(lastReviewPath(env, 'L-7', 2)));
    assert.deepEqual((await lastReviewEvents(env, 'L-7')).map((event) => event.iteration), [2]);
    assert.equal((await reviewLog(env)).length, 4);
  } finally {
    await stop(served);
  }
});
