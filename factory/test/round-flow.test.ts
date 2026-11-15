// End-to-end tests of the joint round (src/round.ts) with the real sf serve, the fake Claude (its
// --json-schema runs are the Claude reviews) and the fake Codex, each job with both reviewers: both
// say fix (one Fix section with both lead lines and both lists, a shared item once with one ledger
// entry); Claude fix and gate clean, then Claude clean and gate fix (one Fix section each,
// gate_fixes 0, then 1), then both clean (MR preparation); a failed Claude review beside a gate
// verdict (review_failed, gate.json kept, sf review runs Claude alone, then both apply); both
// reviewers started before either ended; a Claude fix beside a failed gate (Claude's Fix section,
// no stop, the Stream says the gate runs again, and the next round runs both).
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { lineEntries, streamContext } from '../src/job-stream.js';
import { call, codexLog, codexScript, type Env, fakeCodex, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, waitFor } from './support/harness.js';

const ITEM = { path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.', severity: 'major' };
const CLAUDE_FIX = { verdict: 'fix', summary: 'The greeting is wrong.', items: [ITEM], accepted_sensitive: [] };
const CLAUDE_CLEAN = { verdict: 'clean', summary: 'Claude found it right.', items: [], accepted_sensitive: [] };
const GATE_ITEM = { path: 'a.txt', problem: 'It is empty.', expected: 'A line.', severity: 'major' };
const GATE_FIX = { verdict: 'fix', summary: 'a.txt is empty.', items: [GATE_ITEM], accepted_sensitive: [] };
const GATE_CLEAN = { verdict: 'clean', summary: 'Codex found it right.', items: [], accepted_sensitive: [] };

const roundEnv = (): Record<string, string> => ({ SF_REVIEW: 'on', SF_GATE: 'codex', SF_GATE_LEVEL: 'full', SF_CODEX: fakeCodex });

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

async function until(what: string, condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const codexRuns = async (env: Env): Promise<number> => ((await exists(join(env.home, 'fake-codex.log'))) ? (await codexLog(env)).length : 0);

test('both say fix: one Fix 1 with both lead lines and the items of both, each named; an item both raise is one item and one ledger entry with the higher severity', async () => {
  const env = await newEnv('round-both-fix', roundEnv());
  const repo = await newRepo(env, 'round-both-fix-repo', false);
  await putTask(env, repo, 'J-1', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n', 'a.txt': '\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n', 'a.txt': 'a line\n' }, text: '| R1 | fixed | Done. |\n| R2 | fixed | Done. |' },
    { write: { '.software-factory/J-1.mr.md': mrText('feat(J-1): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_FIX }, { output: CLAUDE_CLEAN }]);
  // The gate raises Claude's item again (other spacing) as a blocker, and one of its own.
  await codexScript(env, [{ output: { ...GATE_FIX, items: [{ ...ITEM, problem: 'It greets  the world.', severity: 'blocker' }, GATE_ITEM] } }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'J-1' });
    await waitFor(served, 'J-1', 'ready_for_human_review', 2);
    assert.ok((await taskFile(repo, 'J-1')).endsWith([
      '## Fix 1', '', 'Review by Claude: The greeting is wrong.', 'Review by Codex: a.txt is empty.', '',
      '1. [R1, blocker] `README.md`: It greets the world. Expected: It greets the reader. (raised by Claude and Codex)',
      '2. [R2, major] `a.txt`: It is empty. Expected: A line. (raised by Codex)', '',
    ].join('\n')));
    const jobs = new JobStore(env.state);
    assert.deepEqual((await jobs.readLedger('app', 'J-1')).map((entry) => [entry.id, entry.reviewer, entry.severity, entry.problem, entry.status]), [
      ['R1', 'claude', 'blocker', 'It greets the world.', 'fixed'], ['R2', 'codex', 'major', 'It is empty.', 'fixed'],
    ]);
    const job = (await jobs.read('app', 'J-1'))!;
    assert.deepEqual([job.fixes, job.gate_fixes], [1, 1]);
    assert.deepEqual([(await reviewLog(env)).length, await codexRuns(env)], [2, 2]);
  } finally {
    await stop(served);
  }
});

test('Claude fix and gate clean, then Claude clean and gate fix: one Fix section each, gate_fixes 0 after the first and 1 after the second; both clean: MR preparation', async () => {
  const env = await newEnv('round-one-each', roundEnv());
  const repo = await newRepo(env, 'round-one-each-repo', false);
  await putTask(env, repo, 'J-2', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n', 'a.txt': '\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: '| R1 | fixed | Done. |' },
    { write: { 'a.txt': 'a line\n' }, text: '| R2 | fixed | Done. |' },
    { write: { '.software-factory/J-2.mr.md': mrText('feat(J-2): Greet the reader') }, text: 'prepared' },
  ]);
  // Iteration 2's Claude review waits for the test, which reads the job between the rounds.
  await reviewScript(env, [{ output: CLAUDE_FIX }, { output: CLAUDE_CLEAN, waitFile: 'release-2' }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_CLEAN }, { output: GATE_FIX }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'J-2' });
    await waitFor(served, 'J-2', 'awaiting_review', 2);
    const jobs = new JobStore(env.state);
    assert.deepEqual([(await jobs.read('app', 'J-2'))!.fixes, (await jobs.read('app', 'J-2'))!.gate_fixes], [1, 0]);
    await writeFile(join(env.home, 'release-2'), '');
    const ready = await waitFor(served, 'J-2', 'ready_for_human_review', 3);
    assert.deepEqual(ready.review, { status: 'done', verdict: 'clean', summary: CLAUDE_CLEAN.summary, gate: { status: 'done', verdict: 'clean', summary: GATE_CLEAN.summary } });
    const text = await taskFile(repo, 'J-2');
    assert.ok(text.includes([
      '## Fix 1', '', 'Review by Claude: The greeting is wrong.', 'Review by Codex: Codex found it right.', '',
      '1. [R1, major] `README.md`: It greets the world. Expected: It greets the reader. (raised by Claude)', '',
    ].join('\n')), text);
    assert.ok(text.endsWith([
      '## Fix 2', '', 'Review by Claude: Claude found it right.', 'Review by Codex: a.txt is empty.', '',
      '1. [R2, major] `a.txt`: It is empty. Expected: A line. (raised by Codex)', '',
    ].join('\n')), text);
    const job = (await jobs.read('app', 'J-2'))!;
    assert.deepEqual([job.fixes, job.gate_fixes], [2, 1]);
    assert.deepEqual([(await reviewLog(env)).length, await codexRuns(env)], [3, 3]);
    assert.ok((await jobs.readMrText('app', 'J-2')) !== undefined);
  } finally {
    await stop(served);
  }
});

test('a failed Claude review beside a gate verdict: review_failed, gate.json kept; sf review runs Claude alone, then both apply', async () => {
  const env = await newEnv('round-claude-failed', roundEnv());
  const repo = await newRepo(env, 'round-claude-failed-repo', false);
  await putTask(env, repo, 'J-3', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello reader\n', 'a.txt': '\n' }, text: 'Report of iteration 1' },
    { write: { 'a.txt': 'a line\n' }, text: '| R1 | fixed | Done. |' },
    { write: { '.software-factory/J-3.mr.md': mrText('feat(J-3): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ noOutput: true }, { output: CLAUDE_CLEAN }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_FIX }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'J-3' });
    const stopped = await waitFor(served, 'J-3', 'needs_human', 1);
    assert.equal(stopped.error.code, 'review_failed');
    const jobs = new JobStore(env.state);
    const gate = await jobs.readGate('app', 'J-3', 1);
    assert.ok(gate !== undefined && 'verdict' in gate && gate.verdict === 'fix', JSON.stringify(gate));
    assert.equal(await codexRuns(env), 1);
    const retried = await runCli(env, ['review', 'app', 'J-3']);
    assert.equal(retried.code, 0, retried.stderr);
    await waitFor(served, 'J-3', 'ready_for_human_review', 2);
    // The retry ran Claude alone; the kept gate verdict made the Fix with it.
    assert.deepEqual([(await reviewLog(env)).length, await codexRuns(env)], [3, 2]);
    assert.ok((await taskFile(repo, 'J-3')).endsWith([
      '## Fix 1', '', 'Review by Claude: Claude found it right.', 'Review by Codex: a.txt is empty.', '',
      '1. [R1, major] `a.txt`: It is empty. Expected: A line. (raised by Codex)', '',
    ].join('\n')));
    assert.equal((await jobs.read('app', 'J-3'))!.gate_fixes, 1);
  } finally {
    await stop(served);
  }
});

test('both reviewers start before either ends: each records its start and is held until the test saw both; no record of the round before', async () => {
  const env = await newEnv('round-together', roundEnv());
  const repo = await newRepo(env, 'round-together-repo', false);
  await putTask(env, repo, 'J-4', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 1' },
    { write: { '.software-factory/J-4.mr.md': mrText('feat(J-4): Greet the reader') }, text: 'prepared' },
  ]);
  // The fake Codex is held by the fake Claude's waitFile.
  await reviewScript(env, [{ output: CLAUDE_CLEAN, startFile: 'claude.started', waitFile: 'release' }]);
  await codexScript(env, [{ output: GATE_CLEAN, startFile: 'codex.started', waitFile: 'release' }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'J-4' });
    await until('both reviewers to start', async () => (await exists(join(env.home, 'claude.started'))) && (await exists(join(env.home, 'codex.started'))));
    const jobs = new JobStore(env.state);
    assert.deepEqual([await jobs.readReview('app', 'J-4', 1), await jobs.readGate('app', 'J-4', 1)], [undefined, undefined]);
    const checked = await call(served, 'check', { workspace: 'app', ticket: 'J-4' });
    assert.equal(checked.state, 'awaiting_review');
    await writeFile(join(env.home, 'release'), '');
    await waitFor(served, 'J-4', 'ready_for_human_review', 1);
    assert.deepEqual([(await reviewLog(env)).length, await codexRuns(env)], [1, 1]);
  } finally {
    await stop(served);
  }
});

test('a Claude fix beside a failed gate: Claude\'s Fix section alone, no stop; the Stream says the gate runs again; the next round runs both reviewers', async () => {
  const env = await newEnv('round-gate-failed', roundEnv());
  const repo = await newRepo(env, 'round-gate-failed-repo', false);
  await putTask(env, repo, 'J-5', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: '| R1 | fixed | Done. |' },
    { write: { '.software-factory/J-5.mr.md': mrText('feat(J-5): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_FIX }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ exitCode: 3 }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'J-5' });
    await waitFor(served, 'J-5', 'ready_for_human_review', 2);
    // Exactly the Fix section Claude alone makes.
    assert.ok((await taskFile(repo, 'J-5')).endsWith([
      '## Fix 1', '', 'Review by Claude: The greeting is wrong.', '',
      '1. [R1, major] `README.md`: It greets the world. Expected: It greets the reader.', '',
    ].join('\n')));
    const jobs = new JobStore(env.state);
    const failed = await jobs.readGate('app', 'J-5', 1);
    assert.ok(failed !== undefined && 'error' in failed, JSON.stringify(failed));
    assert.deepEqual([(await reviewLog(env)).length, await codexRuns(env)], [2, 2]);
    const job = (await jobs.read('app', 'J-5'))!;
    assert.deepEqual([job.fixes, job.gate_fixes], [1, 0]);
    // No stop on the way: the job never went to needs_human.
    const raw = (await readFile(jobs.eventsPath('app', 'J-5'), 'utf8')).trim().split('\n');
    assert.ok(!raw.some((line) => line.includes('"to":"needs_human"')));
    // The Stream: the gate's failure, then the line that it runs again.
    const ctx = streamContext(jobs, 'app', 'J-5');
    const notes: string[] = [];
    for (const [index, line] of raw.entries()) {
      for (const entry of await lineEntries(line, index, ctx)) {
        if (entry.t === 'note' && entry.who === 'factory' && entry.text.startsWith('The gate failed')) {
          notes.push(entry.text);
        }
      }
    }
    assert.deepEqual(notes, ['The gate failed (gate_failed); it runs again in the next round, with the Claude review.']);
  } finally {
    await stop(served);
  }
});
