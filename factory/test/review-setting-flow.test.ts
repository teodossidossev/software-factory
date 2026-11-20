// End-to-end tests of the review setting (SF-131) with the real sf serve, the fake Claude (its
// --json-schema runs are the Claude reviews) and the fake Codex: with SF_CLAUDE_REVIEW=ticket a
// ticket without review: is reviewed by the gate alone (fix, fix again, clean, MR, no review.json);
// review: claude runs Claude and the gate in a joint round; review: codex under always runs the gate alone; with
// the gate off Claude reviews; a runner killed while the gate runs resumes the gate; Accept over
// review_churn and gate_failed without a Claude review lists what went unapplied on the Merge
// request screen, not in the MR text;
// the gate prompt says it is the only reviewer.
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { gatePrompt, JOINT_REVIEWER_LINE, ONLY_REVIEWER_LINE } from '../src/gate.js';
import { JobStore } from '../src/jobs.js';
import { mrNotes } from '../src/mr-notes.js';
import { loadHandbook } from '../src/server.js';
import { writeTask } from '../src/task-file.js';
import {
  call, codexLog, codexScript, type Env, fakeCodex, fakeLog, newEnv, newRepo, reviewScript, runCli, script, serve, stop, task, waitFor,
} from './support/harness.js';

const CLEAN = { verdict: 'clean', summary: 'Looks right.', items: [], accepted_sensitive: [] };
const ITEM = { path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.', severity: 'major' };
const FIX = { verdict: 'fix', summary: 'The greeting is wrong.', items: [ITEM], accepted_sensitive: [] };
const SECOND = { path: 'README.md', problem: 'It greets no one.', expected: 'It greets the reader.', severity: 'major' };

// The environment of these tests: the review and the gate on, the review by ticket.
const settingEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  SF_REVIEW: 'on', SF_GATE: 'codex', SF_GATE_LEVEL: 'auto', SF_CODEX: fakeCodex, SF_CLAUDE_REVIEW: 'ticket', ...extra,
});

// An MR text that passes the factory's rules, with its header.
function mrText(header: string): string {
  return [
    header, '',
    '## What', 'x', '## Why', 'The ticket asks for it.', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
    '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

// The ticket's Task file, with the review key when given.
async function putTask(env: Env, repo: string, ticket: string, title: string, review?: 'claude' | 'codex'): Promise<void> {
  const text = task(ticket, title).replace('base: main\n', `base: main\n${review !== undefined ? `review: ${review}\n` : ''}`);
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, ticket, text, new JobStore(env.state));
}

// Whether a path exists.
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// The job's events.jsonl records.
async function eventsOf(env: Env, ticket: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(env.state, 'jobs', 'app', ticket, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

// The review.json files of every iteration of the ticket's job.
async function reviewFiles(env: Env, ticket: string): Promise<string[]> {
  const root = join(env.state, 'jobs', 'app', ticket, 'iterations');
  const found: string[] = [];
  for (const name of await readdir(root)) {
    if (await exists(join(root, name, 'review.json'))) {
      found.push(name);
    }
  }
  return found;
}

// The Claude review sessions the fake Claude ran (its fake-review.log lines).
const claudeReviewRuns = async (env: Env): Promise<number> => ((await exists(join(env.home, 'fake-review.log'))) ? (await readFile(join(env.home, 'fake-review.log'), 'utf8')).trim().split('\n').length : 0);

// Waits up to 20 s for condition, failing with what.
async function until(what: string, condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Whether the process runs.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('the gate prompt (SF-131): without a Claude review the gate is the only reviewer; with one, one of the joint round\'s two independent reviewers', async () => {
  const input = {
    ticket: 'T-1', iteration: 2, report: 'r', patch: Buffer.from(''), patchTruncated: false, files: [], handbook: (await loadHandbook()).text, task: 't', ledger: [], rules: '', userMessages: [], baseCommit: 'abc',
  };
  const only = gatePrompt({ ...input, onlyReviewer: true });
  assert.equal(ONLY_REVIEWER_LINE, 'You are the only reviewer of this iteration, and your verdict decides.');
  assert.ok(only.startsWith(`Code review of iteration 2 of ticket T-1. ${ONLY_REVIEWER_LINE} You review; you change nothing.`), only.split('\n')[0]);
  assert.doesNotMatch(only, /a Claude review found this iteration clean/);
  const joint = gatePrompt(input);
  assert.equal(JOINT_REVIEWER_LINE, "You are one of two independent reviewers of this iteration; either's blocker or major item makes a fix.");
  assert.equal(joint.split('\n')[0], `Code review of iteration 2 of ticket T-1. ${JOINT_REVIEWER_LINE} You review; you change nothing.`);
  assert.doesNotMatch(joint, /only reviewer|a Claude review found this iteration clean/);
});

test('SF_CLAUDE_REVIEW=ticket, no review: key: the gate alone reviews (fix, then clean), the job reaches MR preparation and ready without any review.json; claude_review false with its review_setup event; sf check says off with the gate', async () => {
  const env = await newEnv('setting-gate-only', settingEnv());
  const repo = await newRepo(env, 'setting-gate-only-repo', false);
  await putTask(env, repo, 'S-1', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2\n\n| R1 | fixed | The reader is greeted. |' },
    { write: { '.software-factory/S-1.mr.md': mrText('feat(S-1): Greet the reader') }, text: 'prepared' },
  ]);
  await codexScript(env, [{ delayMs: 1500, output: FIX }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-1' });
    // While the gate runs, sf check says the Claude review is off and the gate runs.
    const reviewing = await waitFor(served, 'S-1', 'awaiting_review', 1);
    assert.deepEqual(reviewing.review, { status: 'off', gate: { status: 'running' } });
    const ready = await waitFor(served, 'S-1', 'ready_for_human_review', 2);
    assert.deepEqual(ready.review, { status: 'off', gate: { status: 'done', verdict: 'clean', summary: CLEAN.summary } });
    assert.equal(await claudeReviewRuns(env), 0);
    assert.deepEqual(await reviewFiles(env, 'S-1'), []);
    const job = (await new JobStore(env.state).read('app', 'S-1'))!;
    assert.deepEqual([job.claude_review, job.fixes, job.gate_fixes], [false, 1, 1]);
    const events = await eventsOf(env, 'S-1');
    assert.deepEqual(events.filter((record) => record.type === 'review_setup').map((record) => [record.claude_review, record.reason]), [[false, 'SF_CLAUDE_REVIEW=ticket']]);
    // The gate runs on every iteration at level full, for the reason that no Claude review runs.
    assert.deepEqual(events.filter((record) => record.type === 'gate_level').map((record) => [record.iteration, record.level, record.ran, record.reasons]), [
      [1, 'full', true, ['no Claude review']], [2, 'full', true, ['no Claude review']],
    ]);
    assert.deepEqual(events.filter((record) => record.type === 'review').map((record) => [record.iteration, record.reviewer, record.verdict]), [[1, 'codex', 'fix'], [2, 'codex', 'clean']]);
    // The gate's Fix section as before the joint round (one lead line, no tag), then MR preparation.
    const fixed = await readFile(join(repo, '.software-factory', 'S-1.md'), 'utf8');
    assert.match(fixed, /## Fix 1\n\nReview by Codex: The greeting is wrong\.\n\n1\. \[R1, major\] `README\.md`: [^\n]*\.\n?$/);
    assert.doesNotMatch(fixed, /Review by Claude|raised by/);
    assert.deepEqual((await fakeLog(env)).map((entry) => entry.prompt.split('\n')[0]), [
      '/implement .software-factory/S-1.md', '/implement .software-factory/S-1.md Fix 1', 'MR preparation for S-1 on branch S-1-greet-the-reader. The user approved the reviewed change.',
    ]);
    for (const run of await codexLog(env)) {
      assert.ok(run.prompt.split('\n')[0]!.includes(ONLY_REVIEWER_LINE), run.prompt.split('\n')[0]);
    }
  } finally {
    await stop(served);
  }
});

test('review: claude under ticket runs the Claude review and the gate in one round; review: codex under always runs the gate alone', async () => {
  const env = await newEnv('setting-by-ticket', settingEnv());
  const repo = await newRepo(env, 'setting-by-ticket-repo', false);
  await putTask(env, repo, 'S-2', 'Claude asked for', 'claude');
  await script(env, [
    { write: { 'a.txt': '1\n' } },
    { write: { '.software-factory/S-2.mr.md': mrText('feat(S-2): Claude asked for') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLEAN }]);
  await codexScript(env, [{ output: CLEAN }]);
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-2' });
    const ready = await waitFor(served, 'S-2', 'ready_for_human_review', 1);
    assert.equal(ready.review.status, 'done');
    assert.equal(ready.review.gate.verdict, 'clean');
    assert.equal(await claudeReviewRuns(env), 1);
    assert.deepEqual(await reviewFiles(env, 'S-2'), ['001']);
    assert.equal((await new JobStore(env.state).read('app', 'S-2'))!.claude_review, true);
    // A joint round: both reviewed the iteration, in whichever order they ended.
    assert.deepEqual((await eventsOf(env, 'S-2')).filter((record) => record.type === 'review').map((record) => record.reviewer).sort(), ['claude', 'codex']);
    assert.ok(!(await codexLog(env))[0]!.prompt.includes(ONLY_REVIEWER_LINE));
    assert.ok((await codexLog(env))[0]!.prompt.startsWith(`Code review of iteration 1 of ticket S-2. ${JOINT_REVIEWER_LINE}`));
  } finally {
    await stop(served);
  }

  const always = await newEnv('setting-codex-always', settingEnv({ SF_CLAUDE_REVIEW: 'always' }));
  const other = await newRepo(always, 'setting-codex-always-repo', false);
  await putTask(always, other, 'S-3', 'Codex asked for', 'codex');
  await putTask(always, other, 'S-4', 'Nothing asked for');
  await script(always, [
    { write: { 'a.txt': '1\n' } },
    { write: { '.software-factory/S-3.mr.md': mrText('feat(S-3): Codex asked for') }, text: 'prepared' },
  ]);
  await codexScript(always, [{ output: CLEAN }]);
  served = await serve(always);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-3' });
    await waitFor(served, 'S-3', 'ready_for_human_review', 1);
    assert.equal(await claudeReviewRuns(always), 0);
    assert.deepEqual(await reviewFiles(always, 'S-3'), []);
    const events = await eventsOf(always, 'S-3');
    assert.deepEqual(events.filter((record) => record.type === 'review_setup').map((record) => [record.claude_review, record.reason]), [[false, 'the Task file says review: codex']]);
  } finally {
    await stop(served);
  }
});

test('the gate off (SF_GATE=off) under ticket: Claude reviews every job, and its clean verdict decides', async () => {
  const env = await newEnv('setting-gate-off', settingEnv({ SF_GATE: 'off' }));
  const repo = await newRepo(env, 'setting-gate-off-repo', false);
  await putTask(env, repo, 'S-5', 'Gate off', 'codex');
  await script(env, [
    { write: { 'a.txt': '1\n' } },
    { write: { '.software-factory/S-5.mr.md': mrText('feat(S-5): Gate off') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-5' });
    const ready = await waitFor(served, 'S-5', 'ready_for_human_review', 1);
    assert.deepEqual(ready.review, { status: 'done', verdict: 'clean', summary: CLEAN.summary });
    assert.equal(await claudeReviewRuns(env), 1);
    const job = (await new JobStore(env.state).read('app', 'S-5'))!;
    assert.equal(job.claude_review, true);
    const [setup] = (await eventsOf(env, 'S-5')).filter((record) => record.type === 'review_setup');
    assert.deepEqual([setup!.claude_review, setup!.reason], [true, 'the gate is off (SF_GATE=off)']);
  } finally {
    await stop(served);
  }
});

test('a runner killed while the gate of a job without the Claude review runs: the next sf serve resumes the gate, never a Claude review', async () => {
  const env = await newEnv('setting-restart', settingEnv());
  const repo = await newRepo(env, 'setting-restart-repo', false);
  await putTask(env, repo, 'S-6', 'Restart');
  await script(env, [
    { write: { 'a.txt': '1\n' } },
    { write: { '.software-factory/S-6.mr.md': mrText('feat(S-6): Restart') }, text: 'prepared' },
  ]);
  await codexScript(env, [{ delayMs: 30_000 }, { output: CLEAN }]);
  const jobs = new JobStore(env.state);
  const lock = join(env.state, 'jobs', 'app', 'S-6', 'runner.pid');
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-6' });
    await until('the gate to run', async () => (await exists(join(env.home, 'fake-codex.log'))));
  } finally {
    await stop(served);
  }
  const runner = Number((await readFile(lock, 'utf8')).trim().split(' ')[0]);
  process.kill(runner, 'SIGKILL');
  await until('the runner to end', async () => !alive(runner));
  assert.equal((await jobs.read('app', 'S-6'))!.state, 'awaiting_review');
  served = await serve(env);
  try {
    await waitFor(served, 'S-6', 'ready_for_human_review', 1);
    assert.equal((await codexLog(env)).length, 2);
    assert.equal(await claudeReviewRuns(env), 0);
    assert.deepEqual(await reviewFiles(env, 'S-6'), []);
  } finally {
    await stop(served);
  }
});

test('Accept without the Claude review: over review_churn the ledger\'s open findings and the churned item go unapplied and are listed on the Merge request screen; over gate_failed it says no reviewer passed the iteration', async () => {
  const env = await newEnv('setting-accept', settingEnv());
  const repo = await newRepo(env, 'setting-accept-repo', false);
  await putTask(env, repo, 'S-7', 'Churn');
  await putTask(env, repo, 'S-8', 'Failed gate');
  await script(env, [
    { write: { 'README.md': 'hello world\n' } },
    { write: { 'README.md': 'hello reader\n' }, text: '| R1 | fixed | Done. |' },
    { write: { '.software-factory/S-7.mr.md': mrText('feat(S-7): Churn') }, text: 'prepared' },
    { write: { 'a.txt': '1\n' } },
    { write: { '.software-factory/S-8.mr.md': mrText('feat(S-8): Failed gate') }, text: 'prepared' },
  ]);
  const caused = { ...FIX, items: [{ ...SECOND, caused_by: 'R1' }] };
  await codexScript(env, [{ output: FIX }, { output: caused }, { exitCode: 3, stderr: 'codex broke' }]);
  const jobs = new JobStore(env.state);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-7' });
    const churned = await waitFor(served, 'S-7', 'needs_human', 2);
    assert.equal(churned.error.code, 'review_churn');
    // No clean Claude review is needed: the gate is the review.
    const accepted = await runCli(env, ['accept', 'app', 'S-7']);
    assert.equal(accepted.code, 0, accepted.stderr);
    await waitFor(served, 'S-7', 'ready_for_human_review', 2);
    const override = await jobs.readGateOverride('app', 'S-7', 2);
    assert.equal(override?.code, 'review_churn');
    assert.deepEqual(Array.isArray(override?.unapplied) && override.unapplied.map((item) => item.problem), [SECOND.problem]);
    const mr = (await jobs.readMrText('app', 'S-7'))!;
    assert.ok(!mr.includes('### Accepted over a stop') && !mr.includes('The user accepted'), mr);
    const notes = await mrNotes(jobs, (await jobs.read('app', 'S-7'))!);
    assert.match(notes, /### Accepted over a stop\n- The user accepted iteration 2 over review_churn\.\n- \[major\] `README\.md`: It greets no one\. Expected: It greets the reader\./);
    assert.doesNotMatch(notes, /No reviewer passed/);
    assert.deepEqual(await reviewFiles(env, 'S-7'), []);

    await call(served, 'start', { workspace: 'app', ticket: 'S-8' });
    const failed = await waitFor(served, 'S-8', 'needs_human', 1);
    assert.equal(failed.error.code, 'gate_failed');
    const overFailed = await runCli(env, ['accept', 'app', 'S-8']);
    assert.equal(overFailed.code, 0, overFailed.stderr);
    await waitFor(served, 'S-8', 'ready_for_human_review', 1);
    const text = (await jobs.readMrText('app', 'S-8'))!;
    assert.ok(!text.includes('### Accepted over a stop') && !text.includes('No reviewer passed'), text);
    assert.match(await mrNotes(jobs, (await jobs.read('app', 'S-8'))!), /### Accepted over a stop\n- The user accepted iteration 1 over gate_failed\.\n- No reviewer passed iteration 1\.\n- The gate failed: /);
    assert.equal(await claudeReviewRuns(env), 0);
  } finally {
    await stop(served);
  }
});
