// End-to-end tests of the gate level (SF-092) with the real sf serve, the fake Claude and the fake
// Codex: a light job runs the gate once, a full one after each fix, a none one never; the decision
// is recorded once per iteration (gate-level.json and one gate_level event), a skipped gate never
// stops on gate_budget, never shows as running in check, and a pause or a usage limit during the
// simplification pass of a skipped-gate iteration interrupts the pass, not the gate. SF-125: a gate
// finding is stored and sent on redacted; a gate the wrapper cannot hold stops the job.
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { LIGHT_SKIPPED } from '../src/gate-level.js';
import { GATE_SANDBOX_UNAVAILABLE } from '../src/gate.js';
import { JobStore } from '../src/jobs.js';
import {
  call, codexLog, codexScript, type Env, fakeBwrapBin, fakeCodex, fakeLog, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, temp, waitFor,
} from './support/harness.js';

const CLEAN = { verdict: 'clean', summary: 'Claude found it right.', items: [], accepted_sensitive: [] };
const CLAUDE_FIX = {
  verdict: 'fix', summary: 'The greeting is wrong.',
  items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.', severity: 'major' }], accepted_sensitive: [],
};
const GATE_FIX = {
  verdict: 'fix', summary: 'The value is wrong.',
  items: [{ path: 'src/app.ts', problem: 'It exports 1.', expected: 'It exports 2.', severity: 'major' }], accepted_sensitive: [],
};
const GATE_CLEAN = { verdict: 'clean', summary: 'Codex found it right.', items: [], accepted_sensitive: [] };
const NO_SUGGESTIONS = { summary: 'Nothing to remove.', suggestions: [] };
const LONG = 60_000;
// SF-072: a usage limit as the Claude sessions end with it.
const LIMIT_ERROR = { subtype: 'error_during_execution', errors: ["You've hit your 5-hour limit · resets 3am (Europe/Sofia)"] };

const levelEnv = (extra: Record<string, string> = {}): Record<string, string> => ({ SF_REVIEW: 'on', SF_GATE: 'codex', SF_CODEX: fakeCodex, ...extra });

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'x', '## Why', 'The ticket asks for it.', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
    '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function eventsOf(env: Env, ticket: string): Promise<Array<Record<string, any>>> {
  return (await readFile(join(env.state, 'jobs', 'app', ticket, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
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

const codexRuns = async (env: Env): Promise<number> => ((await exists(join(env.home, 'fake-codex.log'))) ? (await codexLog(env)).length : 0);

// The gate_level events of a job: iteration, level, ran, reasons.
const levelEvents = async (env: Env, ticket: string): Promise<unknown[][]> =>
  (await eventsOf(env, ticket)).filter((record) => record.type === 'gate_level').map((record) => [record.iteration, record.level, record.ran, record.reasons]);

// gate-level.json of each iteration 1..count, without its time; null when there is none.
async function levelRecords(env: Env, ticket: string, count: number): Promise<unknown[]> {
  const jobs = new JobStore(env.state);
  const records: unknown[] = [];
  for (let number = 1; number <= count; number += 1) {
    const record = await jobs.readGateLevel('app', ticket, number);
    records.push(record === undefined ? null : { ...record, at: typeof record.at });
  }
  return records;
}

test('light: the gate runs once; its fix is a Fix section; the next clean Claude verdict goes to MR preparation without a second run, and with gate_tokens at SF_GATE_MAX_TOKENS without gate_budget', async () => {
  // The fake Codex's run uses 1100 tokens: the job is at the limit after it.
  const env = await newEnv('level-light', levelEnv({ SF_GATE_MAX_TOKENS: '1100' }));
  const repo = await newRepo(env, 'level-light-repo', false);
  await putTask(env, repo, 'GL-1', 'Export the value');
  await script(env, [
    { write: { 'src/app.ts': 'export const value = 1;\n' }, text: 'Report of iteration 1' },
    { write: { 'src/app.ts': 'export const value = 2;\n' }, text: 'Report of iteration 2\n\n| R1 | fixed | It exports 2. |' },
    { write: { '.software-factory/GL-1.mr.md': mrText('feat(GL-1): Export the value') }, text: 'prepared' },
  ]);
  await codexScript(env, [{ output: GATE_FIX }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'GL-1' });
    const ready = await waitFor(served, 'GL-1', 'ready_for_human_review', 2);
    assert.equal(await codexRuns(env), 1);
    assert.equal((await reviewLog(env)).length, 2);
    // The skipped gate shows no status, as with the gate off.
    assert.deepEqual(ready.review, { status: 'done', verdict: 'clean', summary: 'Looks right.' });
    const job = (await new JobStore(env.state).read('app', 'GL-1'))!;
    assert.deepEqual([job.fixes, job.gate_fixes, job.gate_tokens], [1, 1, 1100]);
    assert.deepEqual(await levelEvents(env, 'GL-1'), [[1, 'light', true, ['light: 1 file, 1 line']], [2, 'light', false, [LIGHT_SKIPPED]]]);
    assert.deepEqual(await levelRecords(env, 'GL-1', 2), [
      { level: 'light', reasons: ['light: 1 file, 1 line'], ran: true, files: 1, lines: 1, at: 'string' },
      { level: 'light', reasons: [LIGHT_SKIPPED], ran: false, files: 1, lines: 1, at: 'string' },
    ]);
    const watched = (await runCli(env, ['watch', 'app', 'GL-1', '--once'])).stdout;
    assert.match(watched, /^\d\d:\d\d:\d\d \[1\] Codex gate: light, runs \(light: 1 file, 1 line\)$/m);
    assert.match(watched, /^\d\d:\d\d:\d\d \[2\] Codex gate: light, skipped \(light: the gate already asked for a fix\)$/m);
  } finally {
    await stop(served);
  }
});

test('full by SF_GATE_FULL_PATHS: the gate runs again after its fix, as before SF-092', async () => {
  const env = await newEnv('level-full', levelEnv({ SF_GATE_FULL_PATHS: 'src/**' }));
  const repo = await newRepo(env, 'level-full-repo', false);
  await putTask(env, repo, 'GF-1', 'Export the value');
  await script(env, [
    { write: { 'src/app.ts': 'export const value = 1;\n' }, text: 'Report of iteration 1' },
    { write: { 'src/app.ts': 'export const value = 2;\n' }, text: 'Report of iteration 2\n\n| R1 | fixed | It exports 2. |' },
    { write: { '.software-factory/GF-1.mr.md': mrText('feat(GF-1): Export the value') }, text: 'prepared' },
  ]);
  await codexScript(env, [{ output: GATE_FIX }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'GF-1' });
    await waitFor(served, 'GF-1', 'ready_for_human_review', 2);
    assert.equal(await codexRuns(env), 2);
    const reasons = ['SF_GATE_FULL_PATHS: src/app.ts'];
    assert.deepEqual(await levelEvents(env, 'GF-1'), [[1, 'full', true, reasons], [2, 'full', true, reasons]]);
    assert.deepEqual((await levelRecords(env, 'GF-1', 2)).map((record) => (record as { level: string }).level), ['full', 'full']);
  } finally {
    await stop(served);
  }
});

test('none: a change that became docs only skips the gate at gate_tokens = SF_GATE_MAX_TOKENS, no gate_budget; a Claude fix verdict decides no level', async () => {
  const env = await newEnv('level-none', levelEnv({ SF_GATE_MAX_TOKENS: '1100' }));
  const repo = await newRepo(env, 'level-none-repo', false);
  await putTask(env, repo, 'GN-1', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n', 'src/app.ts': 'export const value = 1;\n' }, text: 'Report of iteration 1' },
    // The gate's fix drops the code file: the job's change is docs only.
    { write: { 'README.md': 'hello world, again\n' }, run: [['rm', 'src/app.ts']], text: 'Report of iteration 2\n\n| R1 | fixed | Dropped. |' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 3\n\n| R2 | fixed | The reader is greeted. |' },
    { write: { '.software-factory/GN-1.mr.md': mrText('docs(GN-1): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLEAN }, { output: CLAUDE_FIX }, { output: CLEAN }]);
  await codexScript(env, [{ output: { ...GATE_FIX, items: [{ ...GATE_FIX.items[0], problem: 'It is not needed.', expected: 'No code.' }] } }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'GN-1' });
    await waitFor(served, 'GN-1', 'ready_for_human_review', 3);
    assert.equal(await codexRuns(env), 1);
    const job = (await new JobStore(env.state).read('app', 'GN-1'))!;
    assert.deepEqual([job.gate_fixes, job.gate_tokens], [1, 1100]);
    // Iteration 2 had a Claude fix: no gate decision there.
    assert.deepEqual(await levelEvents(env, 'GN-1'), [[1, 'light', true, ['light: 2 files, 3 lines']], [3, 'none', false, ['docs only']]]);
    assert.deepEqual(await levelRecords(env, 'GN-1', 3), [
      { level: 'light', reasons: ['light: 2 files, 3 lines'], ran: true, files: 2, lines: 3, at: 'string' },
      null,
      { level: 'none', reasons: ['docs only'], ran: false, files: 1, lines: 2, at: 'string' },
    ]);
  } finally {
    await stop(served);
  }
});

test('decided once per iteration: a pause while the gate runs and the Resume keep one gate_level event and one gate-level.json', async () => {
  const env = await newEnv('level-pause-gate', levelEnv());
  const repo = await newRepo(env, 'level-pause-gate-repo', false);
  await putTask(env, repo, 'GP-1', 'Export the value');
  await script(env, [
    { write: { 'src/app.ts': 'export const value = 1;\n' } },
    { write: { '.software-factory/GP-1.mr.md': mrText('feat(GP-1): Export the value') }, text: 'prepared' },
  ]);
  await codexScript(env, [{ delayMs: LONG, output: GATE_CLEAN }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'GP-1' });
    await until('the gate to run', async () => exists(join(env.home, 'fake-codex.log')));
    const jobs = new JobStore(env.state);
    const decided = await jobs.readGateLevel('app', 'GP-1', 1);
    assert.equal(decided?.level, 'light');
    const paused = await runCli(env, ['pause', 'app', 'GP-1']);
    assert.match(paused.stdout, /^step: gate$/m);
    assert.equal((await runCli(env, ['resume', 'app', 'GP-1'])).code, 0);
    await waitFor(served, 'GP-1', 'ready_for_human_review', 1);
    assert.equal(await codexRuns(env), 2);
    assert.deepEqual(await levelEvents(env, 'GP-1'), [[1, 'light', true, ['light: 1 file, 1 line']]]);
    // Not written again: the record of the first decision.
    assert.deepEqual(await jobs.readGateLevel('app', 'GP-1', 1), decided);
  } finally {
    await stop(served);
  }
});

test('a skipped gate during the simplification pass: check shows no gate running; a pause there interrupts simplify and Resume runs the pass again; no Codex run', async () => {
  const env = await newEnv('level-pause-simplify', levelEnv({ SF_SIMPLIFY: 'on' }));
  const repo = await newRepo(env, 'level-pause-simplify-repo', false);
  await putTask(env, repo, 'GS-1', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2\n\n| R1 | fixed | The reader is greeted. |' },
    { write: { '.software-factory/GS-1.mr.md': mrText('docs(GS-1): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_FIX }, { output: CLEAN }, { delayMs: LONG, output: NO_SUGGESTIONS }, { output: NO_SUGGESTIONS }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'GS-1' });
    const jobs = new JobStore(env.state);
    await until('the simplification pass to run', async () => (await jobs.read('app', 'GS-1'))?.simplify_iteration === 2);
    const checked = await call(served, 'check', { workspace: 'app', ticket: 'GS-1' });
    assert.equal(checked.state, 'awaiting_review');
    assert.deepEqual(checked.review, { status: 'done', verdict: 'clean', summary: CLEAN.summary });
    const paused = await runCli(env, ['pause', 'app', 'GS-1']);
    assert.equal(paused.code, 0, paused.stderr);
    assert.match(paused.stdout, /^step: simplify$/m);
    const job = (await jobs.read('app', 'GS-1'))!;
    assert.deepEqual([job.paused?.step, job.simplify_iteration], ['simplify', undefined]);
    assert.deepEqual((await eventsOf(env, 'GS-1')).filter((record) => record.type === 'interrupted').map((record) => [record.iteration, record.step, record.reviewer]), [[2, 'simplify', 'simplify']]);
    const resumed = await runCli(env, ['resume', 'app', 'GS-1']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /^step: simplify$/m);
    await waitFor(served, 'GS-1', 'ready_for_human_review', 2);
    // The fake logs a session when it ends: the review, the review, the pass run again on Resume.
    assert.equal((await reviewLog(env)).length, 3);
    assert.equal((await eventsOf(env, 'GS-1')).filter((record) => record.type === 'simplify').length, 1);
    const record = await jobs.readSimplify('app', 'GS-1', 2);
    assert.ok(record !== undefined && 'suggestions' in record, JSON.stringify(record));
    assert.equal(await codexRuns(env), 0);
    assert.deepEqual(await levelEvents(env, 'GS-1'), [[2, 'none', false, ['docs only']]]);
  } finally {
    await stop(served);
  }
});

test('a skipped gate and a usage limit in the simplification pass: parked at simplify; resumed, the pass runs again, then MR preparation', async () => {
  const env = await newEnv('level-limit-simplify', levelEnv({ SF_SIMPLIFY: 'on' }));
  const repo = await newRepo(env, 'level-limit-simplify-repo', false);
  await putTask(env, repo, 'GS-2', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2\n\n| R1 | fixed | The reader is greeted. |' },
    { write: { '.software-factory/GS-2.mr.md': mrText('docs(GS-2): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_FIX }, { output: CLEAN }, LIMIT_ERROR, { output: NO_SUGGESTIONS }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'GS-2' });
    const jobs = new JobStore(env.state);
    await until('the job to park', async () => (await jobs.read('app', 'GS-2'))?.state === 'waiting_limit');
    const job = (await jobs.read('app', 'GS-2'))!;
    assert.deepEqual([job.paused?.step, job.simplify_iteration], ['simplify', undefined]);
    assert.deepEqual((await eventsOf(env, 'GS-2')).filter((record) => record.type === 'interrupted').map((record) => [record.iteration, record.step]), [[2, 'simplify']]);
    assert.equal((await runCli(env, ['resume', 'app', 'GS-2'])).code, 0);
    await waitFor(served, 'GS-2', 'ready_for_human_review', 2);
    assert.equal((await reviewLog(env)).length, 4);
    assert.equal(await codexRuns(env), 0);
    assert.deepEqual(await levelEvents(env, 'GS-2'), [[2, 'none', false, ['docs only']]]);
  } finally {
    await stop(served);
  }
});

test('redacted (SF-125): a gate finding holding an environment value is stored in gate.json and written in the next Fix section as [redacted]', async () => {
  const secret = 'gate-secret-0123456789';
  const env = await newEnv('level-redacted', levelEnv({ SF_GATE_LEVEL: 'full', APP_DEPLOY_VALUE: secret }));
  const repo = await newRepo(env, 'level-redacted-repo', false);
  await putTask(env, repo, 'GR-1', 'Export the value');
  await script(env, [
    { write: { 'src/app.ts': 'export const value = 1;\n' }, text: 'Report of iteration 1' },
    { write: { 'src/app.ts': 'export const value = 2;\n' }, text: 'Report of iteration 2\n\n| R1 | fixed | It exports 2. |' },
    { write: { '.software-factory/GR-1.mr.md': mrText('feat(GR-1): Export the value') }, text: 'prepared' },
  ]);
  const leaky = { ...GATE_FIX, summary: `It logs ${secret}.`, items: [{ ...GATE_FIX.items[0]!, problem: `It logs ${secret}.` }] };
  await codexScript(env, [{ output: leaky }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'GR-1' });
    await waitFor(served, 'GR-1', 'ready_for_human_review', 2);
    const jobs = new JobStore(env.state);
    const gate = await jobs.readGate('app', 'GR-1', 1);
    assert.ok(gate !== undefined && 'verdict' in gate, JSON.stringify(gate));
    assert.equal(gate.summary, 'It logs [redacted].');
    assert.deepEqual(gate.items.map((item) => [item.path, item.problem, item.severity]), [['src/app.ts', 'It logs [redacted].', 'major']]);
    assert.ok(!(await readFile(join(jobs.iterationDir('app', 'GR-1', 1), 'gate.json'), 'utf8')).includes(secret));
    const task = await readFile(join(repo, '.software-factory', 'GR-1.md'), 'utf8');
    assert.ok(task.includes('## Fix 1\n\nReview by Codex: It logs [redacted].\n\n1. [R1, major] `src/app.ts`: It logs [redacted]. Expected: It exports 2.'), task);
    assert.ok((await fakeLog(env)).every((entry) => !entry.prompt.includes(secret)));
  } finally {
    await stop(served);
  }
});

test('fail closed (SF-125): with the sandbox on and no bwrap on PATH, the gate never starts Codex; the job is needs_human with gate_sandbox_unavailable, gate.json and the event say why', async () => {
  // A PATH with git and node only (the factory's and the Claude SDK's), and the fake bwrap only for the
  // Implementer's turn, which runs inside it (SF-181): the turn removes it, so the gate finds none.
  const bin = join(temp, 'no-bwrap-bin');
  await mkdir(bin, { recursive: true });
  for (const [name, target] of [['node', process.execPath], ['git', await gitPath()], ['bwrap', join(fakeBwrapBin, 'bwrap')]] as const) {
    await symlink(target, join(bin, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
  }
  const env = await newEnv('level-no-bwrap', levelEnv({ SF_GATE_LEVEL: 'full', PATH: bin }));
  const repo = await newRepo(env, 'level-no-bwrap-repo', false);
  await putTask(env, repo, 'GN-1', 'Export the value');
  await script(env, [{ write: { 'src/app.ts': 'export const value = 1;\n' }, run: [['/bin/rm', join(bin, 'bwrap')]], text: 'Report of iteration 1' }]);
  await codexScript(env, [{ output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'GN-1' });
    const stopped = await waitFor(served, 'GN-1', 'needs_human', 1);
    assert.equal(stopped.error.code, GATE_SANDBOX_UNAVAILABLE);
    assert.match(stopped.error.message, /no bwrap on PATH/);
    assert.equal(await codexRuns(env), 0);
    const gate = await new JobStore(env.state).readGate('app', 'GN-1', 1);
    assert.ok(gate !== undefined && 'error' in gate && gate.error === stopped.error.message, JSON.stringify(gate));
    assert.ok((await eventsOf(env, 'GN-1')).some((event) => event.type === 'review_failed' && event.reviewer === 'codex' && event.error === stopped.error.message));
  } finally {
    await stop(served);
  }
});

// The git executable of the test's PATH.
async function gitPath(): Promise<string> {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir !== '' && (await exists(join(dir, 'git')))) {
      return join(dir, 'git');
    }
  }
  assert.fail('no git on PATH');
}
