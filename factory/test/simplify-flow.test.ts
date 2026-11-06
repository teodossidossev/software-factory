// End-to-end tests of the simplification pass (SF-055) with the real sf serve, the fake Claude (its
// --json-schema runs are the Claude reviews and the pass, in order) and the fake Codex: no pass
// without review fixes or with SF_SIMPLIFY=off; no suggestions go on to MR preparation; suggestions
// stop the job (simplify_offered); Simplify writes the Fix section and the ledger entries, a reviewer
// cannot ask for them back, and the pass never runs twice; Skip (sf accept, gate on) prepares the
// MR with the suggestions listed; a failed run goes on to MR preparation.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { SIMPLIFY_HEADING } from '../src/mr.js';
import { REVIEW_DENIED_TOOLS } from '../src/review.js';
import { assertPathDenials, call, codexLog, codexScript, fakeCodex, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, waitFor } from './support/harness.js';

const ITEM = { path: 'README.md', problem: 'It greets anyone.', expected: 'Check the reader first.', severity: 'blocker' };
const FIX = { verdict: 'fix', summary: 'Unchecked.', items: [ITEM], accepted_sensitive: [] };
const CLEAN = { verdict: 'clean', summary: 'Looks right.', items: [], accepted_sensitive: [] };
const SUGGESTION = { path: 'guard.txt', what: 'The second guard.', why: 'The first one covers it.', saves_lines: 3, ledger_ids: ['R1'] };
const NONE = { summary: 'Everything the fixes added is needed.', suggestions: [] };

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'x', '## Why', 'The ticket asks for it.', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
    '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

const taskFile = (repo: string, ticket: string): Promise<string> => readFile(join(repo, '.software-factory', `${ticket}.md`), 'utf8');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// The turns of a job that is fixed once (R1), then prepares its MR; extra turns go before the MR's.
function turns(ticket: string, extra: unknown[] = []): unknown[] {
  return [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n', 'guard.txt': 'guard\nguard again\n' }, text: '| R1 | fixed | Checked now. |' },
    ...extra,
    { write: { [`.software-factory/${ticket}.mr.md`]: mrText(`feat(${ticket}): Greet the reader`) }, text: 'prepared' },
  ];
}

async function events(jobs: JobStore, ticket: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(jobs.eventsPath('app', ticket), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('no pass: a job without review fixes, and with SF_SIMPLIFY=off one with them, goes on to MR preparation', async () => {
  const on = await newEnv('simplify-nofix', { SF_REVIEW: 'on', SF_SIMPLIFY: 'on' });
  const repo = await newRepo(on, 'simplify-nofix-repo', false);
  await putTask(on, repo, 'S-1', 'Greet the reader');
  await script(on, [{ write: { 'README.md': 'hello reader\n' }, text: 'Report' }, { write: { '.software-factory/S-1.mr.md': mrText('feat(S-1): Greet the reader') }, text: 'prepared' }]);
  await reviewScript(on, [{ output: CLEAN }, { output: NONE }]);
  let served = await serve(on);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-1' });
    await waitFor(served, 'S-1', 'ready_for_human_review', 1);
    assert.equal((await reviewLog(on)).length, 1);
    assert.equal(await exists(join(new JobStore(on.state).iterationDir('app', 'S-1', 1), 'simplify.json')), false);
  } finally {
    await stop(served);
  }

  const off = await newEnv('simplify-off', { SF_REVIEW: 'on', SF_SIMPLIFY: 'off' });
  const offRepo = await newRepo(off, 'simplify-off-repo', false);
  await putTask(off, offRepo, 'S-2', 'Greet the reader');
  await script(off, turns('S-2'));
  await reviewScript(off, [{ output: FIX }, { output: CLEAN }, { output: NONE }]);
  served = await serve(off);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-2' });
    await waitFor(served, 'S-2', 'ready_for_human_review', 2);
    assert.equal((await reviewLog(off)).length, 2);
  } finally {
    await stop(served);
  }
});

test('gate off, no suggestions: the pass runs after the clean Claude review on the Task without its Fix sections, then MR preparation; a failed pass goes on too', async () => {
  const env = await newEnv('simplify-none', { SF_REVIEW: 'on', SF_SIMPLIFY: 'on' });
  const repo = await newRepo(env, 'simplify-none-repo', false);
  await putTask(env, repo, 'S-3', 'Greet the reader');
  await putTask(env, repo, 'S-4', 'Greet the reader');
  await script(env, [...turns('S-3'), ...turns('S-4')]);
  await reviewScript(env, [
    { output: FIX }, { output: CLEAN }, { output: NONE },
    { output: FIX }, { output: CLEAN }, { subtype: 'error_during_execution', errors: ['The pass broke.'] },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-3' });
    await waitFor(served, 'S-3', 'ready_for_human_review', 2);
    const log = await reviewLog(env);
    assert.equal(log.length, 3);
    const pass = log[2]!;
    assert.match(pass.prompt, /^Simplification pass of ticket S-3, after its review fixes/);
    assert.ok(!pass.prompt.includes('## Fix 1'), pass.prompt);
    assert.match(pass.prompt, /- R1 · fixed · blocker · claude · `README\.md`: It greets anyone\./);
    assert.match(pass.prompt, /- Fix 1, answered by iteration 2: README\.md, guard\.txt/);
    assert.match(pass.prompt, /here: R1/);
    // The review's read-only session: its tools only.
    assert.ok(pass.argv.join(' ').includes('Read,Grep,Glob'), pass.argv.join(' '));
    const jobs = new JobStore(env.state);
    const record = await jobs.readSimplify('app', 'S-3', 2);
    assert.deepEqual(record !== undefined && 'suggestions' in record ? [record.reviewer, record.summary, record.suggestions, record.dropped] : record, ['simplify', NONE.summary, [], []]);
    const passed = (await events(jobs, 'S-3')).find((event) => event.type === 'simplify');
    assert.deepEqual({ ...passed, ts: undefined }, { ts: undefined, iteration: 2, type: 'simplify', reviewer: 'simplify', suggestions: 0, dropped: 0 });

    await call(served, 'start', { workspace: 'app', ticket: 'S-4' });
    await waitFor(served, 'S-4', 'ready_for_human_review', 2);
    const failed = await jobs.readSimplify('app', 'S-4', 2);
    assert.ok(failed !== undefined && 'error' in failed && /The simplification pass ended with error_during_execution: The pass broke\./.test(failed.error), JSON.stringify(failed));
    assert.match(String((await events(jobs, 'S-4')).find((event) => event.type === 'simplify')?.error), /The pass broke\./);
    assert.ok(!(await jobs.readMrText('app', 'S-4'))!.includes(SIMPLIFY_HEADING));
  } finally {
    await stop(served);
  }
});

test('suggestions: simplify_offered; Simplify writes "Fix 2: Simplify" and the ledger entries, a reviewer cannot ask for them back, and the pass never runs twice', async () => {
  const env = await newEnv('simplify-apply', { SF_REVIEW: 'on', SF_SIMPLIFY: 'on' });
  const repo = await newRepo(env, 'simplify-apply-repo', false);
  await putTask(env, repo, 'S-5', 'Greet the reader');
  await script(env, turns('S-5', [{ write: { 'guard.txt': 'guard\n' }, text: '| R2 | fixed | Removed. |' }]));
  // The second suggestion would undo the fixed blocker R1: the factory drops it.
  const undoing = { path: 'README.md', what: 'The reader check.', why: 'Simpler.', saves_lines: 1, ledger_ids: ['R1'] };
  const own = { ...SUGGESTION, ledger_ids: [] };
  const back = { path: 'guard.txt', problem: 'The second guard is gone.', expected: 'Bring it back.', severity: 'major', reopens: 'R2' };
  await reviewScript(env, [
    { output: FIX }, { output: CLEAN }, { output: { summary: 'One guard too many.', suggestions: [own, undoing] } },
    { output: { verdict: 'fix', summary: 'Guard missing.', items: [back], accepted_sensitive: [] } },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-5' });
    const offered = await waitFor(served, 'S-5', 'needs_human', 2);
    assert.equal(offered.error.code, 'simplify_offered');
    assert.match(offered.error.message, /^The simplification pass found 1 thing the review fixes added that the Task does not need \(about 3 lines\): 1\. `guard\.txt`: The second guard\./);
    assert.ok(!offered.error.message.includes('The reader check.'));
    const jobs = new JobStore(env.state);
    const record = await jobs.readSimplify('app', 'S-5', 2);
    assert.deepEqual(record !== undefined && 'suggestions' in record ? [record.suggestions, record.dropped] : record, [[own], [undoing]]);

    const simplified = await runCli(env, ['simplify', 'app', 'S-5']);
    assert.equal(simplified.code, 0, simplified.stderr);
    await waitFor(served, 'S-5', 'ready_for_human_review', 3);
    const text = await taskFile(repo, 'S-5');
    assert.ok(text.endsWith([
      '## Fix 2: Simplify', '', "Simplify, by the user's choice: One guard too many.", '',
      "Remove or simplify each item below. Keep what the Task's goal and acceptance need, and never undo what a fixed blocker finding of the ledger established; leave an item (and say why) when it turns out to be needed.", '',
      '1. [R2, simplify] `guard.txt`: The second guard. Why: The first one covers it. (saves about 3 lines)', '',
    ].join('\n')), text);
    assert.deepEqual((await jobs.readLedger('app', 'S-5')).map((entry) => [entry.id, entry.reviewer, entry.status]), [['R1', 'claude', 'fixed'], ['R2', 'simplify', 'accepted_risk']]);
    // The review of the Simplify iteration asked for the guard back: dropped, so it was clean, and no second pass ran.
    assert.deepEqual((await jobs.readReview('app', 'S-5', 3)) !== undefined && (await jobs.readReview('app', 'S-5', 3) as { dropped?: unknown[] }).dropped, [{ ...back, caused_by: '' }]);
    const log = await reviewLog(env);
    assert.equal(log.length, 4);
    assert.match(log[3]!.prompt, /- R2 · simplified by the user's choice · `guard\.txt`: The second guard\./);
    // The pass (the third session) got the path denials (SF-100) on top of the review's deny list.
    assert.match(log[2]!.prompt, /simplif/i);
    assertPathDenials(log[2]!.argv, env, join(env.state, 'worktrees', 'app', 'S-5'), REVIEW_DENIED_TOOLS);
    assert.equal(await exists(join(jobs.iterationDir('app', 'S-5', 3), 'simplify.json')), false);
    const job = (await jobs.read('app', 'S-5'))!;
    assert.equal(job.fixes, 2);
    const chosen = (await events(jobs, 'S-5')).find((event) => event.type === 'simplify_chosen');
    assert.deepEqual({ ...chosen, ts: undefined }, { ts: undefined, iteration: 2, type: 'simplify_chosen', choice: 'simplify', suggestions: 1 });
    // Applied: neither listed as not applied nor as a finding not fixed.
    const mr = (await jobs.readMrText('app', 'S-5'))!;
    assert.ok(!mr.includes(SIMPLIFY_HEADING) && !mr.includes('### Review findings not fixed'), mr);
    const again = await runCli(env, ['simplify', 'app', 'S-5']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /sf simplify needs needs_human with simplify_offered/);
  } finally {
    await stop(served);
  }
});

test('gate on, Skip: the pass runs after the clean gate; sf accept prepares the MR with "Simplifications not applied"', async () => {
  const env = await newEnv('simplify-skip', { SF_REVIEW: 'on', SF_SIMPLIFY: 'on', SF_GATE: 'codex', SF_GATE_LEVEL: 'full', SF_CODEX: fakeCodex });
  const repo = await newRepo(env, 'simplify-skip-repo', false);
  await putTask(env, repo, 'S-6', 'Greet the reader');
  await script(env, turns('S-6'));
  // R1 is a major here: a suggestion that names it stays (only a fixed blocker is untouchable).
  await reviewScript(env, [{ output: { ...FIX, items: [{ ...ITEM, severity: 'major' }] } }, { output: CLEAN }, { output: { summary: 'One guard too many.', suggestions: [SUGGESTION] } }]);
  await codexScript(env, [{ output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-6' });
    const offered = await waitFor(served, 'S-6', 'needs_human', 2);
    assert.equal(offered.error.code, 'simplify_offered');
    assert.equal((await codexLog(env)).length, 1);
    assert.equal((await reviewLog(env)).length, 3);

    const skipped = await runCli(env, ['accept', 'app', 'S-6']);
    assert.equal(skipped.code, 0, skipped.stderr);
    await waitFor(served, 'S-6', 'ready_for_human_review', 2);
    const jobs = new JobStore(env.state);
    const mr = (await jobs.readMrText('app', 'S-6'))!;
    assert.ok(mr.includes(`${SIMPLIFY_HEADING}\n- \`guard.txt\`: The second guard. Why: The first one covers it. (saves about 3 lines; added for R1)\n`), mr);
    assert.equal(await jobs.readGateOverride('app', 'S-6', 2), undefined);
    const record = await jobs.readSimplify('app', 'S-6', 2);
    assert.ok(record !== undefined && 'suggestions' in record && typeof record.skipped_at === 'string');
    const chosen = (await events(jobs, 'S-6')).find((event) => event.type === 'simplify_chosen');
    assert.deepEqual({ ...chosen, ts: undefined }, { ts: undefined, iteration: 2, type: 'simplify_chosen', choice: 'skip', suggestions: 1 });
    assert.equal((await jobs.readLedger('app', 'S-6')).some((entry) => entry.reviewer === 'simplify'), false);
  } finally {
    await stop(served);
  }
});

test('at SF_MAX_ITERATIONS the pass still runs and offers; Simplify is written over the limit, and the next fix stops with iteration_limit', async () => {
  const env = await newEnv('simplify-limit', { SF_REVIEW: 'on', SF_SIMPLIFY: 'on', SF_MAX_ITERATIONS: '1' });
  const repo = await newRepo(env, 'simplify-limit-repo', false);
  await putTask(env, repo, 'S-7', 'Greet the reader');
  await script(env, turns('S-7', [{ write: { 'guard.txt': 'guard\n' }, text: '| R2 | fixed | Removed. |' }]));
  const own = { ...SUGGESTION, ledger_ids: [] };
  const later = { path: 'guard.txt', problem: 'A new defect.', expected: 'Fix it.', severity: 'major' };
  await reviewScript(env, [{ output: FIX }, { output: CLEAN }, { output: { summary: 's', suggestions: [own] } }, { output: { ...FIX, items: [later] } }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-7' });
    const offered = await waitFor(served, 'S-7', 'needs_human', 2);
    assert.equal(offered.error.code, 'simplify_offered');
    const simplified = await runCli(env, ['simplify', 'app', 'S-7']);
    assert.equal(simplified.code, 0, simplified.stderr);
    const limited = await waitFor(served, 'S-7', 'needs_human', 3);
    assert.equal(limited.error.code, 'iteration_limit');
    const jobs = new JobStore(env.state);
    assert.equal((await jobs.read('app', 'S-7'))!.fixes, 2);
    assert.ok((await taskFile(repo, 'S-7')).includes('## Fix 2: Simplify'));
  } finally {
    await stop(served);
  }
});

test('once per job: the pass is marked on the job before it runs; one the user moves on from (sf say) never runs again', async () => {
  const env = await newEnv('simplify-once', { SF_REVIEW: 'on', SF_SIMPLIFY: 'on' });
  const repo = await newRepo(env, 'simplify-once-repo', false);
  await putTask(env, repo, 'S-8', 'Greet the reader');
  await script(env, turns('S-8', [{ write: { 'README.md': 'hello dear reader\n' }, text: 'Said.' }]));
  // The pass is slow; the user goes on with sf say while it runs.
  await reviewScript(env, [{ output: FIX }, { output: CLEAN }, { output: { summary: 's', suggestions: [{ ...SUGGESTION, ledger_ids: [] }] }, delayMs: 6000 }, { output: CLEAN }, { output: NONE }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-8' });
    const jobs = new JobStore(env.state);
    const deadline = Date.now() + 15_000;
    while ((await reviewLog(env).catch(() => [])).length < 3) {
      assert.ok(Date.now() < deadline, 'the pass did not start');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await jobs.read('app', 'S-8'))!.simplify_iteration, 2);
    const said = await runCli(env, ['say', 'app', 'S-8', 'Greet', 'dearly.']);
    assert.equal(said.code, 0, said.stderr);
    await waitFor(served, 'S-8', 'ready_for_human_review', 3);
    // No second pass on the clean iteration 3. The first applied nothing: the next review cancelled
    // it (no trace), or it ended after the job moved on (an ignored event only).
    assert.equal((await reviewLog(env)).length, 4);
    assert.equal(await exists(join(jobs.iterationDir('app', 'S-8', 2), 'simplify.json')), false);
    const passed = (await events(jobs, 'S-8')).filter((event) => event.type === 'simplify');
    assert.ok(passed.every((event) => event.iteration === 2 && event.ignored === true), JSON.stringify(passed));
    assert.equal((await jobs.read('app', 'S-8'))!.simplify_iteration, 2);
  } finally {
    await stop(served);
  }
});
