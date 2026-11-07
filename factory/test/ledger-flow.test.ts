// End-to-end tests of the findings ledger (SF-052) with the real sf serve, the fake Claude (its
// --json-schema runs are the Claude reviews) and the fake Codex: the Fix section's ids and
// ledger.json, an escalation that stops the job before the review and sf settle that resumes it
// (the review again, or a Fix with the user's decision), an item that reopens an accepted risk
// (dropped), a gate that disputes a contest and Accept on review_disputed, churn by both reviewers
// and Accept on review_churn (refused without a clean Claude review), the MR section, sf reset.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { FINDINGS_HEADING } from '../src/mr.js';
import { call, codexLog, codexScript, fakeCodex, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, waitFor } from './support/harness.js';

const ITEM = { path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.', severity: 'major' };
const FIX = { verdict: 'fix', summary: 'The greeting is wrong.', items: [ITEM], accepted_sensitive: [] };
const CLEAN = { verdict: 'clean', summary: 'Looks right.', items: [], accepted_sensitive: [] };

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

test('escalation: the Fix section has ids, the Implementer escalates R1, the job stops before the review; sf settle accept runs the review again, which may not reopen the accepted risk', async () => {
  const env = await newEnv('ledger-escalate', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'ledger-escalate-repo', false);
  await putTask(env, repo, 'L-1', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: '## Fix 1 items\n| R1 | escalated | Should it greet in English or German? |' },
    { write: { '.software-factory/L-1.mr.md': mrText('feat(L-1): Greet the reader') }, text: 'prepared' },
  ]);
  const reopening = { ...ITEM, problem: 'The greeting is still English.', severity: 'blocker', reopens: 'R1' };
  await reviewScript(env, [{ output: FIX }, { output: { ...FIX, items: [reopening] } }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    const stopped = await waitFor(served, 'L-1', 'needs_human', 2);
    assert.equal(stopped.error.code, 'escalated');
    assert.match(stopped.error.message, /R1 \(major, `README\.md`\): It greets the world\. Question: Should it greet in English or German\?/);
    assert.match(stopped.error.message, /sf settle <workspace> <ticket> <id> accept\|fix/);
    assert.ok((await taskFile(repo, 'L-1')).endsWith('1. [R1, major] `README.md`: It greets the world. Expected: It greets the reader.\n'));
    // No review ran on the escalated iteration.
    assert.equal((await reviewLog(env)).length, 1);
    const jobs = new JobStore(env.state);
    assert.deepEqual((await jobs.readLedger('app', 'L-1')).map((entry) => [entry.id, entry.status, entry.response]), [['R1', 'escalated', 'Should it greet in English or German?']]);

    // Refused: an unknown id, a decision that is not accept or fix.
    assert.match((await runCli(env, ['settle', 'app', 'L-1', 'R9', 'accept'])).stderr, /no entry R9/);
    assert.match((await runCli(env, ['settle', 'app', 'L-1', 'R1', 'maybe'])).stderr, /settle needs <workspace> <ticket> <id> accept\|fix/);

    const settled = await runCli(env, ['settle', 'app', 'L-1', 'R1', 'accept', 'English', 'only.']);
    assert.equal(settled.code, 0, settled.stderr);
    assert.match(settled.stdout, /status: accepted_risk/);
    await waitFor(served, 'L-1', 'ready_for_human_review', 2);
    // The review ran again, saw the settled finding, and its item reopening it was dropped.
    const reviews = await reviewLog(env);
    assert.equal(reviews.length, 2);
    assert.ok(reviews[1]!.prompt.includes('<settled_findings>\n- R1 · accepted_risk · major · `README.md`: It greets the world. Response: Should it greet in English or German? The user decided: accept the risk (English only.)\n</settled_findings>'), reviews[1]!.prompt);
    const record = await jobs.readReview('app', 'L-1', 2);
    assert.ok(record !== undefined && 'verdict' in record);
    assert.deepEqual(record.dropped, [{ ...reopening, caused_by: '' }]);
    assert.equal((await jobs.read('app', 'L-1'))!.fixes, 1);
    // The MR text lists it as not fixed.
    const mr = (await jobs.readMrText('app', 'L-1'))!;
    assert.ok(mr.includes(`${FINDINGS_HEADING}\n- R1 [major, accepted risk] \`README.md\`: It greets the world. — English only.\n`), mr);
  } finally {
    await stop(served);
  }
});

test('escalation: sf settle fix writes the next Fix section with the user\'s decision, the Implementer fixes it, the review is clean', async () => {
  const env = await newEnv('ledger-userfix', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'ledger-userfix-repo', false);
  await putTask(env, repo, 'L-2', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello world!\n' }, text: '| R1 | escalated | Which language? |' },
    { write: { 'README.md': 'hallo Leser\n' }, text: '| R1 | fixed | German now. |' },
    { write: { '.software-factory/L-2.mr.md': mrText('feat(L-2): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: FIX }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-2' });
    await waitFor(served, 'L-2', 'needs_human', 2);
    const settled = await runCli(env, ['settle', 'app', 'L-2', 'R1', 'fix', 'Greet', 'in', 'German.']);
    assert.equal(settled.code, 0, settled.stderr);
    await waitFor(served, 'L-2', 'ready_for_human_review', 3);
    const text = await taskFile(repo, 'L-2');
    assert.ok(text.endsWith([
      '## Fix 2', '', 'Review by the user: The user settled the stop (escalated): R1 to fix.', '',
      '1. [R1, major] `README.md`: It greets the world. Expected: It greets the reader. The user decided: fix. Greet in German.', '',
    ].join('\n')), text);
    const jobs = new JobStore(env.state);
    assert.deepEqual((await jobs.readLedger('app', 'L-2')).map((entry) => [entry.id, entry.status, entry.asked]), [['R1', 'fixed', 2]]);
    assert.equal((await jobs.read('app', 'L-2'))!.fixes, 2);
    // Fixed: nothing is listed as not fixed.
    assert.ok(!(await jobs.readMrText('app', 'L-2'))!.includes(FINDINGS_HEADING));
  } finally {
    await stop(served);
  }
});

test('escalation with a second open major: accepting R1 runs the stopped review again, no Fix by the user; the review brings R2 back', async () => {
  const env = await newEnv('ledger-escalate-open', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'ledger-escalate-open-repo', false);
  await putTask(env, repo, 'L-6', 'Greet the reader');
  const second = { path: 'a.txt', problem: 'Empty.', expected: 'A line.', severity: 'major' };
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    // R1 escalated, R2 left unanswered: it reads as open.
    { write: { 'README.md': 'hello reader\n' }, text: '| R1 | escalated | Which language? |' },
    { write: { 'a.txt': 'a line\n' }, text: '| R2 | fixed | A line now. |' },
    { write: { '.software-factory/L-6.mr.md': mrText('feat(L-6): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: { ...FIX, items: [ITEM, second] } }, { output: CLEAN }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-6' });
    const stopped = await waitFor(served, 'L-6', 'needs_human', 2);
    assert.equal(stopped.error.code, 'escalated');
    const settled = await runCli(env, ['settle', 'app', 'L-6', 'R1', 'accept']);
    assert.equal(settled.code, 0, settled.stderr);
    await waitFor(served, 'L-6', 'ready_for_human_review', 3);
    // The stopped iteration was reviewed; the Fix that followed is the review's, carrying R2.
    const reviews = await reviewLog(env);
    assert.equal(reviews.length, 3);
    assert.match(reviews[1]!.prompt, /^Code review of iteration 2 of ticket L-6\. /);
    const text = await taskFile(repo, 'L-6');
    assert.doesNotMatch(text, /The user settled the stop/);
    assert.ok(text.endsWith([
      '## Fix 2', '', 'Review by Claude: Looks right.', '',
      '1. [R2, major] `a.txt`: Empty. Expected: A line.', '',
    ].join('\n')), text);
    const jobs = new JobStore(env.state);
    assert.deepEqual((await jobs.readLedger('app', 'L-6')).map((entry) => [entry.id, entry.status]), [['R1', 'accepted_risk'], ['R2', 'fixed']]);
  } finally {
    await stop(served);
  }
});

test('a contested undeclared sensitive path the review still does not accept is a dispute (review_disputed); accepting the risk lets Clean pass the path', async () => {
  const env = await newEnv('ledger-sensitive-dispute', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'ledger-sensitive-dispute-repo', false);
  await putTask(env, repo, 'L-7', 'Add a script');
  await script(env, [
    { write: { 'package.json': '{}\n', 'a.txt': 'npm test\n' }, text: 'Report of iteration 1' },
    { text: '| R1 | contested | The tests run with npm: a.txt:1 |' },
    { write: { '.software-factory/L-7.mr.md': mrText('feat(L-7): Add a script') }, text: 'prepared' },
  ]);
  // The review never accepts package.json: the factory raises it each round.
  await reviewScript(env, [{ output: CLEAN }, { output: CLEAN }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-7' });
    const stopped = await waitFor(served, 'L-7', 'needs_human', 2);
    assert.equal(stopped.error.code, 'review_disputed');
    assert.match(stopped.error.message, /The Implementer contests it: The tests run with npm: a\.txt:1 Evidence: a\.txt:1\./);
    assert.match(stopped.error.message, /Claude reopens it: Claude does not accept the undeclared sensitive path package\.json/);
    const jobs = new JobStore(env.state);
    const [entry] = await jobs.readLedger('app', 'L-7');
    assert.deepEqual([entry!.id, entry!.status, entry!.evidence, entry!.dispute?.reviewer], ['R1', 'contested', 'a.txt:1', 'claude']);
    // One Fix section only: the dispute did not become a second one.
    assert.deepEqual((await taskFile(repo, 'L-7')).match(/^## Fix \d+$/gm), ['## Fix 1']);

    const settled = await runCli(env, ['settle', 'app', 'L-7', 'R1', 'accept', 'The', 'tests', 'need', 'npm.']);
    assert.equal(settled.code, 0, settled.stderr);
    await waitFor(served, 'L-7', 'ready_for_human_review', 2);
    assert.equal((await reviewLog(env)).length, 3);
    const mr = (await jobs.readMrText('app', 'L-7'))!;
    assert.ok(mr.includes('- R1 [major, accepted risk] `package.json`: Undeclared sensitive path. — The tests need npm.'), mr);
  } finally {
    await stop(served);
  }
});

test('dispute: the Implementer contests R1 with evidence, the gate reopens it (review_disputed with both positions); Accept prepares the MR with R1 unapplied and listed as contested', async () => {
  const env = await newEnv('ledger-dispute', { SF_REVIEW: 'on', SF_GATE: 'codex', SF_GATE_LEVEL: 'full', SF_CODEX: fakeCodex });
  const repo = await newRepo(env, 'ledger-dispute-repo', false);
  await putTask(env, repo, 'L-3', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 1' },
    { write: { 'a.txt': 'a\n' }, text: '| R1 | contested | The reader is greeted already at README.md:1 |' },
    { write: { '.software-factory/L-3.mr.md': mrText('feat(L-3): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLEAN }, { output: CLEAN }]);
  const disputing = { ...ITEM, problem: 'It still says world in the title.', reopens: 'R1' };
  await codexScript(env, [{ output: FIX }, { output: { ...FIX, items: [disputing] } }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-3' });
    const stopped = await waitFor(served, 'L-3', 'needs_human', 2);
    assert.equal(stopped.error.code, 'review_disputed');
    assert.match(stopped.error.message, /The Implementer contests it: The reader is greeted already at README\.md:1 Evidence: README\.md:1\./);
    assert.match(stopped.error.message, /Codex reopens it: It still says world in the title\./);
    assert.match(stopped.error.message, /Accept and prepare the MR .*continue .*back to planning/);
    const jobs = new JobStore(env.state);
    const [entry] = await jobs.readLedger('app', 'L-3');
    assert.deepEqual([entry!.status, entry!.evidence, entry!.dispute?.reviewer], ['contested', 'README.md:1', 'codex']);
    assert.equal((await codexLog(env)).length, 2);

    const accepted = await runCli(env, ['accept', 'app', 'L-3']);
    assert.equal(accepted.code, 0, accepted.stderr);
    await waitFor(served, 'L-3', 'ready_for_human_review', 2);
    const override = await jobs.readGateOverride('app', 'L-3', 2);
    assert.equal(override?.code, 'review_disputed');
    assert.deepEqual(Array.isArray(override?.unapplied) && override.unapplied.map((item) => item.id ?? item.problem), ['R1']);
    const mr = (await jobs.readMrText('app', 'L-3'))!;
    assert.ok(mr.includes(`${FINDINGS_HEADING}\n- R1 [major, contested] \`README.md\`: It greets the world. — The reader is greeted already at README.md:1 Evidence: README.md:1.\n`), mr);
  } finally {
    await stop(served);
  }
});

test('churn: every blocking item caused by a fix stops the job (review_churn) for either reviewer; Accept needs a clean Claude review; sf reset clears the ledger', async () => {
  const env = await newEnv('ledger-churn', { SF_REVIEW: 'on', SF_GATE: 'codex', SF_GATE_LEVEL: 'full', SF_CODEX: fakeCodex });
  const repo = await newRepo(env, 'ledger-churn-repo', false);
  await putTask(env, repo, 'L-4', 'Churn by Claude');
  await putTask(env, repo, 'L-5', 'Churn by Codex');
  await script(env, [
    { write: { 'README.md': 'hello world\n' } },
    { write: { 'README.md': 'hello reader\n' }, text: '| R1 | fixed | Done. |' },
    { write: { 'README.md': 'hello world\n' } },
    { write: { 'README.md': 'hello reader\n' }, text: '| R1 | fixed | Done. |' },
    { write: { '.software-factory/L-5.mr.md': mrText('feat(L-5): Churn by Codex') }, text: 'prepared' },
  ]);
  const caused = { ...FIX, items: [{ path: 'b.txt', problem: 'The fix broke b.', expected: 'b works.', severity: 'major', caused_by: 'R1' }] };
  await reviewScript(env, [{ output: FIX }, { output: caused }, { output: CLEAN }, { output: CLEAN }]);
  await codexScript(env, [{ output: FIX }, { output: caused }]);
  const served = await serve(env);
  try {
    // Claude: R1, then an item its fix caused.
    await call(served, 'start', { workspace: 'app', ticket: 'L-4' });
    const byClaude = await waitFor(served, 'L-4', 'needs_human', 2);
    assert.equal(byClaude.error.code, 'review_churn');
    assert.match(byClaude.error.message, /caused by R1/);
    assert.match((await runCli(env, ['accept', 'app', 'L-4'])).stderr, /needs a clean Claude review of the last iteration \(2\); it says fix/);
    const jobs = new JobStore(env.state);
    assert.equal((await jobs.readLedger('app', 'L-4')).length, 1);
    // sf reset archives the job and its ledger with it.
    assert.equal((await runCli(env, ['reset', 'app', 'L-4'])).code, 0);
    assert.equal(await exists(join(env.state, 'jobs', 'app', 'L-4', 'ledger.json')), false);
    assert.deepEqual(await jobs.readLedger('app', 'L-4'), []);

    // Codex: the same after a clean Claude review; Accept prepares the MR.
    await call(served, 'start', { workspace: 'app', ticket: 'L-5' });
    const byCodex = await waitFor(served, 'L-5', 'needs_human', 2);
    assert.equal(byCodex.error.code, 'review_churn');
    assert.match(byCodex.error.message, /Codex's review was caused by an earlier fix/);
    const accepted = await runCli(env, ['accept', 'app', 'L-5']);
    assert.equal(accepted.code, 0, accepted.stderr);
    await waitFor(served, 'L-5', 'ready_for_human_review', 2);
    const override = await jobs.readGateOverride('app', 'L-5', 2);
    assert.equal(override?.code, 'review_churn');
    // The gate's item that churned goes unapplied.
    assert.deepEqual(Array.isArray(override?.unapplied) && override.unapplied.map((item) => item.problem), ['The fix broke b.']);
  } finally {
    await stop(served);
  }
});

test('recovery: a Claude blocker that reopens an accepted risk is dropped; the runner dies before the gate has a verdict; the restarted sf serve resumes into the gate', async () => {
  const env = await newEnv('ledger-resume-dropped', { SF_REVIEW: 'on', SF_GATE: 'codex', SF_GATE_LEVEL: 'full', SF_CODEX: fakeCodex });
  const repo = await newRepo(env, 'ledger-resume-dropped-repo', false);
  await putTask(env, repo, 'L-8', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: '| R1 | escalated | Should it greet in English or German? |' },
    { write: { '.software-factory/L-8.mr.md': mrText('feat(L-8): Greet the reader') }, text: 'prepared' },
  ]);
  const reopening = { ...ITEM, problem: 'The greeting is still English.', severity: 'blocker', reopens: 'R1' };
  await reviewScript(env, [{ output: FIX }, { output: { ...FIX, items: [reopening] } }]);
  // The first gate run never ends in time: its runner is killed while it waits.
  await codexScript(env, [{ delayMs: 30_000 }, { output: CLEAN }]);
  const jobs = new JobStore(env.state);
  const lock = join(env.state, 'jobs', 'app', 'L-8', 'runner.pid');
  const until = async (what: string, condition: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!(await condition())) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-8' });
    await waitFor(served, 'L-8', 'needs_human', 2);
    assert.equal((await runCli(env, ['settle', 'app', 'L-8', 'R1', 'accept'])).code, 0);
    await until('the gate to start', async () => (await exists(join(env.home, 'fake-codex.log'))) && (await codexLog(env)).length === 1);
  } finally {
    await stop(served);
  }
  // The review is recorded with its blocker dropped; no gate verdict yet.
  const record = await jobs.readReview('app', 'L-8', 2);
  assert.ok(record !== undefined && 'verdict' in record);
  assert.deepEqual([record.verdict, record.dropped?.map((item) => item.reopens)], ['fix', ['R1']]);
  assert.equal(await jobs.readGate('app', 'L-8', 2), undefined);
  const runner = Number((await readFile(lock, 'utf8')).trim().split(' ')[0]);
  process.kill(runner, 'SIGKILL');
  await until('the runner to end', async () => {
    try {
      process.kill(runner, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.equal((await jobs.read('app', 'L-8'))!.state, 'awaiting_review');

  // The restarted sf serve resumes the job into the gate (the dropped blocker does not count) and on to Clean.
  served = await serve(env);
  try {
    await waitFor(served, 'L-8', 'ready_for_human_review', 2);
    assert.equal((await codexLog(env)).length, 2);
    // The Claude review was not run again: the stored one decides.
    assert.equal((await reviewLog(env)).length, 2);
    const ready = await call(served, 'check', { workspace: 'app', ticket: 'L-8' });
    assert.deepEqual(ready.review.gate, { status: 'done', verdict: 'clean', summary: CLEAN.summary });
  } finally {
    await stop(served);
  }
});

test("a contest with the user's message: the Implementer cites the message, the entry is contested, the next review sees it settled", async () => {
  const env = await newEnv('ledger-user-message', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'ledger-user-message-repo', false);
  await putTask(env, repo, 'L-9', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 1' },
    { write: { '.software-factory/L-9.mr.md': mrText('feat(L-9): Greet the reader') }, text: 'prepared' },
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 2' },
    { write: { 'a.txt': 'a\n' }, text: '## Fix 2 items\n| R1 | contested | Done as the user message "greet the world again" asked. |' },
    { write: { '.software-factory/L-9.mr.md': mrText('feat(L-9): Greet the reader') }, text: 'prepared again' },
  ]);
  await reviewScript(env, [{ output: CLEAN }, { output: FIX }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-9' });
    await waitFor(served, 'L-9', 'ready_for_human_review', 1);
    const said = await runCli(env, ['say', 'app', 'L-9', 'Please', 'greet', 'the', 'world', 'again.']);
    assert.equal(said.code, 0, said.stderr);
    await waitFor(served, 'L-9', 'ready_for_human_review', 3);
    const [entry] = await new JobStore(env.state).readLedger('app', 'L-9');
    assert.deepEqual([entry!.id, entry!.status, entry!.evidence], ['R1', 'contested', 'user message "greet the world again"']);
    const reviews = await reviewLog(env);
    assert.equal(reviews.length, 3);
    const third = reviews[2]!.prompt;
    assert.match(third, /<settled_findings>\n- R1 · contested · major · `README\.md`: It greets the world\. Response: [^\n]* Evidence: user message "greet the world again"\n<\/settled_findings>/);
    assert.match(third, /<user_decisions>\n<user_message iteration="2" at="[^"]+">\nPlease greet the world again\.\n<\/user_message>\n<\/user_decisions>/);
  } finally {
    await stop(served);
  }
});
