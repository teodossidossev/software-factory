// End-to-end tests of the findings checklist in the Implementer's prompts (SF-318-2): read once at
// Start from <state>/findings/<workspace>.md, stored as the job's findings.md and recorded by its
// sha256 in job.json; given in every prompt that opens a session (the first prompt, a Resume in a
// new session, a fresh fix round), never to the reviewers or the Task check. The real `sf serve`
// and `sf` CLI with the fake Claude Code and Codex, as in test/execution.test.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { findingsBlock, firstPrompt } from '../src/execution/prompts.js';
import { type Check, checklistText } from '../src/findings-checklist.js';
import { JobStore } from '../src/jobs.js';
import { codexLog, codexScript, type Env, fakeLog, jobPrompt, newEnv, newRepo, putRules, putTask, reviewLog, reviewScript, runCli, script, serve, stop, turnsStarted, waitFor, call } from './support/harness.js';
import { CLAUDE_CLEAN, GATE_CLEAN, gateEnv, mrText } from './support/gate.js';
import { eventsOf, LONG } from './support/pause.js';

const checks = (...texts: string[]): Check[] => texts.map((text, index) => ({ text, findings: 5 - index, jobs: 2 }));
const CHECKLIST = checklistText('2026-11-24', 14, 5, checks('Name each changed setting in the summary', 'Keep error messages specific'));
const BLOCK = findingsBlock(CHECKLIST);
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const checklistFile = (env: Env): string => join(env.state, 'findings', 'app.md');
const findingsFile = (env: Env, ticket: string): string => join(env.state, 'jobs', 'app', ticket, 'findings.md');

async function putChecklist(env: Env, text: string): Promise<void> {
  await mkdir(join(env.state, 'findings'), { recursive: true });
  await writeFile(checklistFile(env), text);
}

const missing = (path: string): Promise<boolean> => stat(path).then(() => false, () => true);

test('the findings checklist (SF-318-2): the first prompt carries the block after <rules>, the job stores it and records its sha; a fresh fix round and a Resume in a new session carry the stored text after the live file changed', async () => {
  const env = await newEnv('findings-prompts', { SF_FIX_SESSION: 'fresh' });
  const repo = await newRepo(env, 'findings-prompts-repo', false);
  const rules = (await putRules(env, repo)).trimEnd();
  for (const ticket of ['F-1', 'P-1', 'P-2']) {
    await putTask(env, repo, ticket, `Findings ${ticket}`);
  }
  await script(env, [
    { write: { 'README.md': 'one\n' }, text: '# Report: F-1, iteration 1\n\nFirst.' },
    { write: { 'README.md': 'two\n' }, text: '# Report: F-1, iteration 2\n\nSecond.' },
    // P-1's and P-2's first turns, paused; then their resumed ones.
    { delayMs: LONG }, { delayMs: LONG },
    { write: { 'a.txt': 'a\n' } }, { write: { 'b.txt': 'b\n' } },
  ]);
  await putChecklist(env, CHECKLIST);
  const jobs = new JobStore(env.state);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'F-1' });
    await waitFor(served, 'F-1', 'awaiting_review', 1);
    assert.equal((await fakeLog(env))[0]!.prompt, await jobPrompt(env, `/implement .software-factory/F-1.md\n\n${rules}\n\n${BLOCK.trimEnd()}`, 'F-1', 1));
    assert.equal(await readFile(findingsFile(env, 'F-1'), 'utf8'), BLOCK);
    assert.equal((await jobs.read('app', 'F-1'))!.findings_checklist, sha(BLOCK));

    // The live file changes: the job's fresh fix round carries the text stored at its Start.
    await putChecklist(env, checklistText('2026-11-25', 20, 6, checks('A later check of the workspace')));
    await call(served, 'request_fix', { workspace: 'app', ticket: 'F-1', content: '1. README.md: again.' });
    await waitFor(served, 'F-1', 'awaiting_review', 2);
    const fix = (await fakeLog(env))[1]!.prompt;
    assert.ok(fix.startsWith(`/implement .software-factory/F-1.md Fix 1\n\n${rules}\n\n${BLOCK.trimEnd()}\n\n<previous_report iteration="1">\n`), fix);
    assert.ok(!fix.includes('A later check'));
    assert.equal((await jobs.read('app', 'F-1'))!.findings_checklist, sha(BLOCK));

    // Jobs started now get the later text; a Resume that opens a new session carries it, after the
    // live file is gone: with a message, and as the first prompt without one at iteration 0.
    const later = findingsBlock(await readFile(checklistFile(env), 'utf8'));
    await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
    await turnsStarted(env, 3);
    await call(served, 'start', { workspace: 'app', ticket: 'P-2' });
    await turnsStarted(env, 4);
    await rm(checklistFile(env));
    assert.equal((await runCli(env, ['pause', 'app', 'P-1'])).code, 0);
    assert.equal((await runCli(env, ['resume', 'app', 'P-1', 'go', 'on'])).code, 0);
    await waitFor(served, 'P-1', 'awaiting_review', 1);
    assert.equal((await fakeLog(env)).at(-1)!.prompt, await jobPrompt(env, `${rules}\n\n${later.trimEnd()}\n\ngo on`, 'P-1', 1));
    assert.equal((await runCli(env, ['pause', 'app', 'P-2'])).code, 0);
    assert.equal((await runCli(env, ['resume', 'app', 'P-2'])).code, 0);
    await waitFor(served, 'P-2', 'awaiting_review', 1);
    assert.equal((await fakeLog(env)).at(-1)!.prompt, await jobPrompt(env, firstPrompt('P-2', [], rules, ['implement'], later), 'P-2', 1));
    assert.equal((await jobs.read('app', 'P-2'))!.findings_checklist, sha(later));
  } finally {
    await stop(served);
  }
});

test('the findings checklist (SF-318-2): no file, a file without checks or SF_FINDINGS_CHECKLIST=off give today\'s prompt and null; without rules the block stands in their place; an unreadable file starts the job without it and logs findings_checklist_unavailable', async () => {
  const env = await newEnv('findings-absent');
  const repo = await newRepo(env, 'findings-absent-repo', false);
  const tickets = ['N-1', 'N-2', 'N-3', 'N-4'];
  for (const ticket of tickets) {
    await putTask(env, repo, ticket, `Findings ${ticket}`);
  }
  await script(env, tickets.map((ticket) => ({ write: { 'README.md': `${ticket}\n` } })));
  const jobs = new JobStore(env.state);
  const served = await serve(env);
  const start = async (ticket: string): Promise<string> => {
    await call(served, 'start', { workspace: 'app', ticket });
    await waitFor(served, ticket, 'awaiting_review', 1);
    return (await fakeLog(env)).at(-1)!.prompt;
  };
  const plain = (ticket: string): Promise<string> => jobPrompt(env, `/implement .software-factory/${ticket}.md`, ticket, 1);
  try {
    assert.equal(await start('N-1'), await plain('N-1'));
    await putChecklist(env, '<!-- generated 2026-11-24 from 3 findings in 1 jobs -->\n');
    assert.equal(await start('N-2'), await plain('N-2'));
    await putChecklist(env, CHECKLIST);
    assert.equal(await start('N-3'), await jobPrompt(env, `/implement .software-factory/N-3.md\n\n${BLOCK.trimEnd()}`, 'N-3', 1));
    assert.equal((await jobs.read('app', 'N-3'))!.findings_checklist, sha(BLOCK));
    // A checklist that cannot be read (a directory in its place): the job starts without it.
    await rm(checklistFile(env));
    await mkdir(checklistFile(env));
    assert.equal(await start('N-4'), await plain('N-4'));
    const unavailable = (await eventsOf(env, 'N-4')).filter((event) => event.type === 'findings_checklist_unavailable');
    assert.equal(unavailable.length, 1);
    assert.match(unavailable[0]!.message, /EISDIR/);
    for (const ticket of ['N-1', 'N-2', 'N-4']) {
      assert.equal((await jobs.read('app', ticket))!.findings_checklist, null, ticket);
      assert.ok(await missing(findingsFile(env, ticket)), ticket);
    }
    for (const ticket of ['N-1', 'N-2', 'N-3']) {
      assert.ok(!(await eventsOf(env, ticket)).some((event) => event.type === 'findings_checklist_unavailable'), ticket);
    }
  } finally {
    await stop(served);
  }

  const off = await newEnv('findings-off', { SF_FINDINGS_CHECKLIST: 'off' });
  const offRepo = await newRepo(off, 'findings-off-repo', false);
  await putTask(off, offRepo, 'O-1', 'Findings off');
  await script(off, [{ write: { 'README.md': 'off\n' } }]);
  await putChecklist(off, CHECKLIST);
  const offServed = await serve(off);
  try {
    await call(offServed, 'start', { workspace: 'app', ticket: 'O-1' });
    await waitFor(offServed, 'O-1', 'awaiting_review', 1);
    assert.equal((await fakeLog(off))[0]!.prompt, await jobPrompt(off, '/implement .software-factory/O-1.md', 'O-1', 1));
    assert.equal((await new JobStore(off.state).read('app', 'O-1'))!.findings_checklist, null);
    assert.ok(await missing(findingsFile(off, 'O-1')));
  } finally {
    await stop(offServed);
  }
});

test('the findings checklist (SF-318-2): the Claude review\'s, the Codex gate\'s and the Task check\'s prompts are the same with and without a checklist; only the Implementer gets it', async () => {
  const env = await newEnv('findings-reviewers', gateEnv());
  const repo = await newRepo(env, 'findings-reviewers-repo', false);
  await putRules(env, repo);
  // Two jobs alike but for their ticket: G-1 starts without a checklist, G-2 with one.
  for (const ticket of ['G-1', 'G-2']) {
    await putTask(env, repo, ticket, 'Greet the reader');
  }
  await script(env, ['G-1', 'G-2'].flatMap((ticket) => [
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 1' },
    { write: { [`.software-factory/${ticket}.mr.md`]: mrText(`feat(${ticket}): Greet the reader`) }, text: 'prepared' },
  ]));
  await reviewScript(env, [{ output: CLAUDE_CLEAN }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_CLEAN }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-1' });
    await waitFor(served, 'G-1', 'ready_for_human_review', 1);
    await putChecklist(env, CHECKLIST);
    await call(served, 'start', { workspace: 'app', ticket: 'G-2' });
    await waitFor(served, 'G-2', 'ready_for_human_review', 1);
  } finally {
    await stop(served);
  }
  const asG2 = (prompt: string): string => prompt.replaceAll('G-1', 'G-2');
  const implementer = (await fakeLog(env)).filter((entry) => entry.prompt.startsWith('/implement '));
  assert.equal(implementer.length, 2);
  assert.ok(!implementer[0]!.prompt.includes('<recurring_findings>'));
  assert.ok(implementer[1]!.prompt.includes(BLOCK.trimEnd()));
  const reviews = await reviewLog(env);
  const gates = await codexLog(env);
  assert.deepEqual([reviews.length, gates.length], [2, 2]);
  assert.equal(reviews[1]!.prompt, asG2(reviews[0]!.prompt));
  assert.equal(gates[1]!.prompt, asG2(gates[0]!.prompt));
  for (const prompt of [reviews[1]!.prompt, gates[1]!.prompt]) {
    assert.ok(!prompt.includes('recurring_findings') && !prompt.includes('Name each changed setting'));
  }

  // The Task check of G-2, with the checklist and without it.
  const output = { paraphrase: 'The Task greets the reader in the README.', findings: [], files: [{ path: 'README.md', action: 'modify' }], verdict: 'ready' };
  await reviewScript(env, [{ output }, { output }]);
  assert.equal((await runCli(env, ['check-task', 'app', 'G-2'])).code, 0);
  await rm(checklistFile(env));
  assert.equal((await runCli(env, ['check-task', 'app', 'G-2'])).code, 0);
  const checksRun = (await reviewLog(env)).slice(-2);
  assert.equal(checksRun.length, 2);
  assert.equal(checksRun[0]!.prompt, checksRun[1]!.prompt);
  assert.ok(!checksRun[0]!.prompt.includes('recurring_findings'));
});
