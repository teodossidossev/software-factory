// The plain explanation of each stop (SF-106, src/explain.ts) with a fake model: the file of a stop
// and the model's input; the stops that get none (a usage limit, explain off); a new stop, a newer
// stop that replaces and aborts an older one; a failure retried once, then stored; sf serve's start;
// at most two at once; the dashboard asked to refresh the job; the stop's real answers; the cap of
// the input; sf explain.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  capExplainInput, currentExplanation, EXPLAIN_SCHEMA, type ExplainInput, type ExplainModel, type ExplainOutput, Explainer, explanationLines, explanationPath,
  type ExplanationRecord, MAX_EXPLANATION_WORDS, outputProblem, readExplanation, stopAnswers, taskGoal,
} from '../src/explain.js';
import { type Job, JobStore, type ReviewRecord } from '../src/jobs.js';
import type { LedgerEntry } from '../src/ledger.js';
import { explainPrompt } from '../src/prompts.js';
import { saveRegistry } from '../src/registry.js';
import type { StructuredOutcome } from '../src/review.js';
import { newEnv, runCli } from './support/harness.js';

const OUTPUT: ExplainOutput = {
  headline: 'Keep your version of the rows, or go back to the Task file?',
  explanation: 'You asked for the undescribed expressions to share one row. The code does that. The Task file still says one row each.',
  choices: [
    { choice: 'Keep your version', effect: 'The Implementer keeps one shared row.', recommended: true },
    { choice: 'Go back', effect: 'Each expression gets its own row again.', recommended: false },
  ],
  recommendation: 'Keep your version: it is what you asked for last.',
};

const TASK = `---
ticket: T-1
title: Rows of the collection editor
base: main
---

# T-1: Rows of the collection editor

## Goal and agreed basis

The undescribed expressions share one row.

## Behaviour

1. Something else.
`;

const REPORT = '# Report: T-1, iteration 3\n\n## Done\n\nShared the row.\n\n## Checks\n\nnpm test: pass.\n\n## Open questions\n\nShould the row be shared?\n';

function entry(id: string, status: LedgerEntry['status'], extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id, iteration: 1, reviewer: 'claude', severity: 'major', path: 'src/editor.ts', problem: `Problem of ${id}.`, expected: `Expected of ${id}.`, status,
    response: '', evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null, ...extra,
  };
}

const T0 = '2026-11-06T10:00:00.000Z';
function stopped(code: string, extra: Partial<Job> = {}, message = `The stop of ${code}.`): Job {
  return {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-rows', base: 'main', base_commit: null, target_commit: null, worktree: '/wt/T-1', prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 2, gate_fixes: 0, gate_tokens: 0, state: 'needs_human', iteration: 3, session_id: 's1', mr: null,
    created_at: '2026-11-06T09:00:00.000Z', updated_at: T0, error: { code, message }, ...extra,
  };
}

const RULES = '\n\nRules from the Software Factory:\n- Do not commit.';
async function fixture(name: string, explain?: Record<string, unknown>, job: Job = stopped('escalated')): Promise<{ jobs: JobStore; config: string; job: Job }> {
  const root = await mkdtemp(join(tmpdir(), `sf-explain-${name}-`));
  const config = join(root, 'config');
  const jobs = new JobStore(join(root, 'state'));
  await saveRegistry({ workspaces: {}, ...(explain !== undefined ? { explain } : {}) }, config);
  await jobs.write(job);
  await jobs.writeTaskCopy('app', 'T-1', Buffer.from(TASK));
  await jobs.writeLedger('app', 'T-1', [entry('R1', 'fixed'), entry('R5', 'escalated', { response: 'Keep the user\'s shared row or the Task file\'s one row each?' })]);
  await jobs.writeIteration('app', 'T-1', {
    report: REPORT, patch: Buffer.from(''),
    meta: { iteration: 3, started_at: T0, ended_at: T0, denials: [], changed_files: [], patch_truncated: false, submodule_changed: [], cost_usd: 0.5, cost_usd_total: 1.5, duration_ms: 10 },
  });
  await jobs.appendEvent('app', 'T-1', { ts: '2026-11-06T08:00:00.000Z', iteration: 0, prompt: `/implement .software-factory/T-1.md${RULES}` });
  await jobs.appendEvent('app', 'T-1', { ts: '2026-11-06T08:10:00.000Z', iteration: 1, prompt: `An old message of iteration one.${RULES}` });
  await jobs.appendEvent('app', 'T-1', { ts: '2026-11-06T09:30:00.000Z', iteration: 2, prompt: `Let the undescribed expressions share one row.${RULES}` });
  await jobs.appendEvent('app', 'T-1', { ts: '2026-11-06T09:40:00.000Z', iteration: 3, prompt: `/implement .software-factory/T-1.md Fix 2${RULES}` });
  return { jobs, config, job };
}

type Call = { prompt: string; model: string; cwd: string; signal: AbortSignal; pending: ExplanationRecord | undefined };

// A fake model: each call takes the next outcome of the list (the last one again when used up); an
// outcome 'block' waits until release() (or, when abortable, until its signal aborts).
function fakeModel(jobs: JobStore, outcomes: Array<'ok' | 'fail' | 'block' | 'hang' | ExplainOutput> = ['ok']) {
  const calls: Call[] = [];
  const releases: Array<() => void> = [];
  let running = 0;
  let most = 0;
  const done = (output: ExplainOutput): StructuredOutcome<ExplainOutput> => ({ ok: true, output, costUsd: 0.0123, model: 'fake', startedAt: T0, endedAt: T0 });
  const model: ExplainModel = async (prompt, { model: name, cwd, signal }) => {
    const call: Call = { prompt, model: name, cwd, signal, pending: await readExplanation(jobs, 'app', 'T-1') };
    calls.push(call);
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
    running += 1;
    most = Math.max(most, running);
    try {
      if (outcome === 'block') {
        await new Promise<void>((resolve) => releases.push(resolve));
        return done(OUTPUT);
      }
      if (outcome === 'hang') {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { ok: false, message: 'The explanation session failed: aborted', model: null, startedAt: T0, endedAt: T0 };
      }
      if (outcome === 'fail') {
        return { ok: false, message: 'The explanation session failed: overloaded', model: null, startedAt: T0, endedAt: T0 };
      }
      return done(outcome === 'ok' ? OUTPUT : outcome);
    } finally {
      running -= 1;
    }
  };
  return { model, calls, release: () => releases.splice(0).forEach((release) => release()), most: () => most, waiting: () => releases.length };
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; !check(); tries += 1) {
    assert.ok(tries < 500, 'the condition never held');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const dataOf = (prompt: string): ExplainInput => JSON.parse(/<stop_data>\n(.*)\n<\/stop_data>/s.exec(prompt)![1]!) as ExplainInput;

test('explain: a job entering needs_human gets one file with its stop; the input holds the goal, the escalated entry and the user\'s last messages; pending first, then the dashboard refreshes the job', async () => {
  const { jobs, config, job } = await fixture('first', { language: 'Bulgarian' });
  const before = await readFile(join(jobs.dir('app', 'T-1'), 'job.json'));
  const fake = fakeModel(jobs);
  const refreshed: string[] = [];
  const explainer = new Explainer({ jobs, configDir: config, model: fake.model, onWritten: (workspace, ticket) => refreshed.push(`${workspace}/${ticket}`) });
  explainer.jobChanged(job);
  await explainer.idle();

  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.equal(call!.model, 'sonnet');
  assert.ok(call!.cwd.startsWith(tmpdir()));
  // The pending file came first: the page says "Explaining…".
  assert.deepEqual([call!.pending?.stop, call!.pending?.output, call!.pending?.error, call!.pending?.ended_at], [{ at: T0, code: 'escalated' }, null, null, null]);
  assert.ok(call!.prompt.startsWith(explainPrompt('Bulgarian', null).slice(0, 80)));
  assert.match(call!.prompt, /in Bulgarian/);
  const data = dataOf(call!.prompt);
  assert.deepEqual(data.task, { title: 'Rows of the collection editor', goal: '## Goal and agreed basis\n\nThe undescribed expressions share one row.' });
  assert.deepEqual(data.stop, { code: 'escalated', message: 'The stop of escalated.' });
  assert.deepEqual(data.entries, [{ id: 'R5', severity: 'major', path: 'src/editor.ts', problem: 'Problem of R5.', expected: 'Expected of R5.', response: 'Keep the user\'s shared row or the Task file\'s one row each?', dispute: null }]);
  assert.deepEqual(data.report, { done: 'Shared the row.', open_questions: 'Should the row be shared?' });
  // The user's messages of the last two iterations, the rules block cut; not the factory's prompts.
  assert.deepEqual(data.your_messages, [{ iteration: 2, at: '2026-11-06T09:30:00.000Z', text: 'Let the undescribed expressions share one row.' }]);
  assert.ok(data.answers.some((answer) => answer.command === 'sf settle app T-1 R5 accept'));

  const record = await readExplanation(jobs, 'app', 'T-1');
  assert.deepEqual({ ...record, started_at: '', ended_at: typeof record?.ended_at },
    { stop: { at: T0, code: 'escalated' }, model: 'sonnet', language: 'Bulgarian', started_at: '', ended_at: 'string', cost_usd: 0.0123, output: OUTPUT, error: null });
  assert.deepEqual(await currentExplanation(jobs, job), record);
  // Pending, then final: the running dashboard is asked to refresh the job each time.
  assert.deepEqual(refreshed, ['app/T-1', 'app/T-1']);
  // It never acts on the job.
  assert.deepEqual(await readFile(join(jobs.dir('app', 'T-1'), 'job.json')), before);

  // The same stop again (another field of job.json changed, a settled entry): no new explanation.
  explainer.jobChanged({ ...job, gate_tokens: 5 });
  await explainer.idle();
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(explanationLines(record!), [
    OUTPUT.headline, '', OUTPUT.explanation, '', 'Choices:', '- Keep your version (recommended): The Implementer keeps one shared row.', '- Go back: Each expression gets its own row again.',
    '', `Recommendation: ${OUTPUT.recommendation}`, '', 'Explained by sonnet · $0.01',
  ]);
});

test('explain: a usage-limit stop gets none, another session_failed stop gets one; explain.on false gets none; the setting is read at each stop', async () => {
  const limited = stopped('session_failed', {}, "You've hit your limit · resets 3am (Europe/Sofia)\nMore.");
  const { jobs, config } = await fixture('limit', undefined, limited);
  const fake = fakeModel(jobs);
  const explainer = new Explainer({ jobs, configDir: config, model: fake.model });
  explainer.jobChanged(limited);
  await explainer.idle();
  assert.equal(fake.calls.length, 0);
  assert.equal(await readExplanation(jobs, 'app', 'T-1'), undefined);

  const failed = stopped('session_failed', { updated_at: '2026-11-06T10:01:00.000Z' }, 'The session crashed.');
  explainer.jobChanged(failed);
  await explainer.idle();
  assert.equal(fake.calls.length, 1);
  assert.deepEqual((await readExplanation(jobs, 'app', 'T-1'))?.stop, { at: '2026-11-06T10:01:00.000Z', code: 'session_failed' });

  // Off: read again at the next stop, without a restart.
  await saveRegistry({ workspaces: {}, explain: { on: false } }, config);
  explainer.jobChanged(stopped('escalated', { updated_at: '2026-11-06T10:02:00.000Z' }));
  await explainer.idle();
  assert.equal(fake.calls.length, 1);
  assert.equal(await currentExplanation(jobs, stopped('escalated', { updated_at: '2026-11-06T10:02:00.000Z' })), null);
});

test('explain: a needs_human to needs_human stop with a new updated_at gets a new explanation; the older file is never shown for the new stop', async () => {
  const { jobs, config, job } = await fixture('again');
  const fake = fakeModel(jobs);
  const explainer = new Explainer({ jobs, configDir: config, model: fake.model });
  explainer.jobChanged(job);
  await explainer.idle();
  const retry = stopped('mr_retry', { updated_at: '2026-11-06T11:00:00.000Z' });
  // Before its explanation is written, the old file is not the new stop's.
  assert.equal(await currentExplanation(jobs, retry), null);
  assert.equal(await currentExplanation(jobs, { ...job, state: 'working' }), null);
  explainer.jobChanged(retry);
  await explainer.idle();
  assert.equal(fake.calls.length, 2);
  assert.equal(dataOf(fake.calls[1]!.prompt).stop.code, 'mr_retry');
  assert.deepEqual((await currentExplanation(jobs, retry))?.stop, { at: '2026-11-06T11:00:00.000Z', code: 'mr_retry' });
  assert.equal(await currentExplanation(jobs, job), null);
});

test('explain: a model failure is tried once more, then stored as the error; an output without exactly one recommended choice fails; a timeout; the job is unchanged', async () => {
  const { jobs, config, job } = await fixture('fail');
  const before = await readFile(join(jobs.dir('app', 'T-1'), 'job.json'));
  const twice = { ...OUTPUT, choices: OUTPUT.choices.map((choice) => ({ ...choice, recommended: true })) };
  const fake = fakeModel(jobs, ['fail', twice]);
  const explainer = new Explainer({ jobs, configDir: config, model: fake.model });
  explainer.jobChanged(job);
  await explainer.idle();
  assert.equal(fake.calls.length, 2);
  const record = await readExplanation(jobs, 'app', 'T-1');
  assert.deepEqual([record?.output, record?.cost_usd, record?.error], [null, null, 'The explanation recommends 2 choices; exactly one must be recommended.']);
  assert.notEqual(record?.ended_at, null);
  // A failed one is the stop's, but shows nothing: sf explain says there is none.
  assert.deepEqual(explanationLines(await currentExplanation(jobs, job)), ['No explanation for the current stop.', `The explanation failed: ${record!.error}`]);
  assert.deepEqual(await readFile(join(jobs.dir('app', 'T-1'), 'job.json')), before);

  // A retry that works after a failure.
  const second = fakeModel(jobs, ['fail', 'ok']);
  const next = stopped('escalated', { updated_at: '2026-11-06T12:00:00.000Z' });
  const again = new Explainer({ jobs, configDir: config, model: second.model });
  again.jobChanged(next);
  await again.idle();
  assert.deepEqual([second.calls.length, (await readExplanation(jobs, 'app', 'T-1'))?.output], [2, OUTPUT]);

  // Each call times out.
  const slow = fakeModel(jobs, ['hang']);
  const late = stopped('escalated', { updated_at: '2026-11-06T13:00:00.000Z' });
  const timed = new Explainer({ jobs, configDir: config, model: slow.model, timeoutMs: 20 });
  timed.jobChanged(late);
  await timed.idle();
  assert.equal(slow.calls.length, 2);
  assert.equal((await readExplanation(jobs, 'app', 'T-1'))?.error, 'The model call timed out after 0.02 seconds.');
});

test('explain: an explanation over 120 words is a failed output: tried once more, then stored as the error; 120 words pass', async () => {
  const words = (count: number): string => Array.from({ length: count }, (_, index) => `word${index}`).join(' \n ');
  assert.equal(MAX_EXPLANATION_WORDS, 120);
  assert.equal(outputProblem({ ...OUTPUT, explanation: words(120) }), null);
  assert.equal(outputProblem({ ...OUTPUT, explanation: `  ${words(121)}  ` }), 'The explanation has 121 words; at most 120 are allowed.');

  const { jobs, config, job } = await fixture('long');
  const long = { ...OUTPUT, explanation: words(121) };
  const fake = fakeModel(jobs, [long, long]);
  const explainer = new Explainer({ jobs, configDir: config, model: fake.model });
  explainer.jobChanged(job);
  await explainer.idle();
  assert.equal(fake.calls.length, 2);
  const record = await readExplanation(jobs, 'app', 'T-1');
  assert.deepEqual([record?.output, record?.error], [null, 'The explanation has 121 words; at most 120 are allowed.']);
  // Not shown: the page and sf explain fall back to the technical stop.
  assert.deepEqual(explanationLines(await currentExplanation(jobs, job)), ['No explanation for the current stop.', `The explanation failed: ${record!.error}`]);

  // An over-long first answer, then a valid one: the valid one is stored.
  const retried = fakeModel(jobs, [long, 'ok']);
  const next = stopped('escalated', { updated_at: '2026-11-06T12:30:00.000Z' });
  const again = new Explainer({ jobs, configDir: config, model: retried.model });
  again.jobChanged(next);
  await again.idle();
  assert.deepEqual([retried.calls.length, (await readExplanation(jobs, 'app', 'T-1'))?.output], [2, OUTPUT]);
});

test('explain: at sf serve\'s start a stopped job without an explanation gets one, one with a finished explanation of its stop does not, a pending one is written again, a stored error is not', async () => {
  const { jobs, config, job } = await fixture('start');
  const fake = fakeModel(jobs);
  const first = new Explainer({ jobs, configDir: config, model: fake.model });
  await first.start();
  await first.idle();
  assert.equal(fake.calls.length, 1);
  const count = 1;
  assert.deepEqual((await currentExplanation(jobs, job))?.output, OUTPUT);

  // Finished for this stop: none.
  const again = new Explainer({ jobs, configDir: config, model: fake.model });
  await again.start();
  await again.idle();
  assert.equal(fake.calls.length, count);

  // Pending (a stopped sf serve left it): written again.
  const record = (await readExplanation(jobs, 'app', 'T-1'))!;
  await writeFile(explanationPath(jobs, 'app', 'T-1'), JSON.stringify({ ...record, ended_at: null, output: null, cost_usd: null }));
  const resumed = new Explainer({ jobs, configDir: config, model: fake.model });
  await resumed.start();
  await resumed.idle();
  assert.equal(fake.calls.length, count + 1);
  assert.deepEqual((await readExplanation(jobs, 'app', 'T-1'))?.output, OUTPUT);

  // A stored error: not retried.
  await writeFile(explanationPath(jobs, 'app', 'T-1'), JSON.stringify({ ...record, output: null, cost_usd: null, error: 'Overloaded.' }));
  const errored = new Explainer({ jobs, configDir: config, model: fake.model });
  await errored.start();
  await errored.idle();
  assert.equal(fake.calls.length, count + 1);

  // A job that is not in needs_human: none.
  await jobs.write({ ...job, state: 'working' });
  await writeFile(explanationPath(jobs, 'app', 'T-1'), '{}');
  const working = new Explainer({ jobs, configDir: config, model: fake.model });
  await working.start();
  await working.idle();
  assert.equal(fake.calls.length, count + 1);
});

test('explain: at most two are written at once; the others wait, one per job', async () => {
  const { jobs, config, job } = await fixture('parallel');
  for (const ticket of ['T-2', 'T-3']) {
    await jobs.write({ ...job, ticket, branch: `${ticket}-x` });
  }
  const fake = fakeModel(jobs, ['block']);
  const explainer = new Explainer({ jobs, configDir: config, model: fake.model });
  for (const ticket of ['T-1', 'T-2', 'T-3']) {
    explainer.jobChanged({ ...job, ticket, branch: `${ticket}-x` });
  }
  await until(() => fake.waiting() === 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual([fake.calls.length, fake.most()], [2, 2]);
  while (fake.calls.length < 3 || fake.waiting() > 0) {
    fake.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await explainer.idle();
  assert.deepEqual([fake.calls.length, fake.most()], [3, 2]);
  for (const ticket of ['T-1', 'T-2', 'T-3']) {
    assert.deepEqual((await readExplanation(jobs, 'app', ticket))?.output, OUTPUT, ticket);
  }
});

test('explain: a newer stop aborts the older running call; the older call that ends after the newer stop\'s file was written does not overwrite it; sf serve\'s stop aborts every call', async () => {
  const { jobs, config, job } = await fixture('replace');
  const newer = { ...OUTPUT, headline: 'The newer stop.' };
  const fake = fakeModel(jobs, ['block', newer]);
  const explainer = new Explainer({ jobs, configDir: config, model: fake.model });
  explainer.jobChanged(job);
  await until(() => fake.waiting() === 1);
  const next = stopped('review_churn', { updated_at: '2026-11-06T11:00:00.000Z' });
  explainer.jobChanged(next);
  await until(() => fake.calls.length === 2);
  assert.equal(fake.calls[0]!.signal.aborted, true);
  assert.equal(fake.calls[1]!.signal.aborted, false);
  await until(() => fake.waiting() === 1);
  // The newer stop is written while the older call still runs; then the older call ends with an output.
  await until(() => fake.calls.length === 2);
  for (let tries = 0; (await readExplanation(jobs, 'app', 'T-1'))?.output?.headline !== newer.headline; tries += 1) {
    assert.ok(tries < 500);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  fake.release();
  await explainer.idle();
  const record = await readExplanation(jobs, 'app', 'T-1');
  assert.deepEqual([record?.stop, record?.output?.headline], [{ at: '2026-11-06T11:00:00.000Z', code: 'review_churn' }, newer.headline]);

  // The stop of sf serve aborts the running call; nothing is written after it.
  const hung = fakeModel(jobs, ['hang']);
  const closing = new Explainer({ jobs, configDir: config, model: hung.model });
  closing.jobChanged(stopped('escalated', { updated_at: '2026-11-06T12:00:00.000Z' }));
  await until(() => hung.calls.length === 1);
  closing.close();
  await closing.idle();
  assert.equal(hung.calls.length, 1);
  const left = await readExplanation(jobs, 'app', 'T-1');
  assert.deepEqual([left?.stop.at, left?.ended_at, left?.output], ['2026-11-06T12:00:00.000Z', null, null]);
});

// ---------- The stop's answers ----------

const CLEAN_REVIEW: ReviewRecord = { reviewer: 'claude', verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [], cost_usd: 0.1, started_at: T0, ended_at: T0 };
const FIX_REVIEW: ReviewRecord = { ...CLEAN_REVIEW, verdict: 'fix', items: [{ severity: 'major', path: 'a.ts', problem: 'Wrong.', expected: 'Right.' }] };
const commands = (job: Job, facts: { ledger?: LedgerEntry[]; review?: ReviewRecord } = {}): string[][] =>
  stopAnswers(job, { ledger: facts.ledger ?? [], review: facts.review }).map((answer) => [answer.label, answer.command]);
const ALWAYS = [['Send a message', 'sf say app T-1 "<message>"'], ['Abort', 'sf abort app T-1']];

test('stopAnswers: an escalated stop lists Accept risk and Must fix per entry to settle with the sf settle commands; every stop ends with Send a message and Abort', () => {
  const ledger = [entry('R1', 'escalated'), entry('R2', 'fixed'), entry('R3', 'contested', { dispute: { reviewer: 'codex', iteration: 2, reason: 'No.' } })];
  assert.deepEqual(commands(stopped('escalated'), { ledger }), [
    ['Accept risk', 'sf settle app T-1 R1 accept'], ['Must fix', 'sf settle app T-1 R1 fix'],
    ['Accept risk', 'sf settle app T-1 R3 accept'], ['Must fix', 'sf settle app T-1 R3 fix'], ...ALWAYS,
  ]);
  assert.deepEqual(commands(stopped('review_disputed'), { ledger: [ledger[2]!], review: CLEAN_REVIEW }), [
    ['Accept and prepare MR', 'sf accept app T-1'], ['Accept risk', 'sf settle app T-1 R3 accept'], ['Must fix', 'sf settle app T-1 R3 fix'], ...ALWAYS,
  ]);
  assert.deepEqual(commands(stopped('odd_code')), ALWAYS);
  assert.deepEqual(commands(stopped('mr_push_protected')), ALWAYS);
});

test('stopAnswers: Accept only when the gate is acceptable (review_churn, gate stops); Retry only when retryable; an aliased code gets its target\'s actions', () => {
  assert.deepEqual(commands(stopped('review_churn'), { review: CLEAN_REVIEW, ledger: [entry('R1', 'open')] }), [['Accept and prepare MR', 'sf accept app T-1'], ...ALWAYS]);
  assert.deepEqual(commands(stopped('review_churn'), { review: FIX_REVIEW }), ALWAYS);
  assert.deepEqual(commands(stopped('review_churn'), { review: { reviewer: 'claude', error: 'Overloaded.' } }), ALWAYS);
  // A major item the ledger dropped does not count.
  assert.deepEqual(commands(stopped('gate_budget'), { review: { ...FIX_REVIEW, dropped: FIX_REVIEW.items } }), [['Accept and prepare MR', 'sf accept app T-1'], ...ALWAYS]);
  assert.deepEqual(commands(stopped('gate_failed'), { review: CLEAN_REVIEW }), [['Accept and prepare MR', 'sf accept app T-1'], ['Tell it to go on', 'sf say app T-1 "Go on."'], ...ALWAYS]);
  assert.deepEqual(commands(stopped('gate_failed')), [['Tell it to go on', 'sf say app T-1 "Go on."'], ...ALWAYS]);

  // session_failed and its aliases: no Retry, ever; a usage limit only Tell it to go on.
  const goOnRestart = [['Tell it to go on', 'sf say app T-1 "Go on."'], ['Restart', 'sf restart app T-1'], ...ALWAYS];
  for (const code of ['session_failed', 'turn_failed', 'permission_mode_mismatch']) {
    assert.deepEqual(commands(stopped(code)), goOnRestart, code);
  }
  assert.deepEqual(commands(stopped('session_failed', {}, "You've hit your limit · resets 3am")), [['Tell it to go on', 'sf say app T-1 "Go on."'], ...ALWAYS]);
  // The MR preparation's stops: Retry while retryable, never after a conflict turn.
  const retry = [['Retry', 'sf retry app T-1'], ['Tell it to go on', 'sf say app T-1 "Go on."'], ...ALWAYS];
  for (const code of ['mr_failed', 'mr_commit_failed', 'mr_rebase_failed', 'mr_serve_restarted', 'mr_interrupted']) {
    assert.deepEqual(commands(stopped(code)), retry, code);
    assert.deepEqual(commands(stopped(code, { mr_conflict_turn: true })), [['Tell it to go on', 'sf say app T-1 "Go on."'], ...ALWAYS], code);
  }
  assert.deepEqual(commands(stopped('fetch_failed')), [['Retry', 'sf retry app T-1'], ...ALWAYS]);
  assert.deepEqual(commands(stopped('simplify_offered')), [['Simplify', 'sf simplify app T-1'], ['Skip', 'sf accept app T-1'], ...ALWAYS]);
  assert.deepEqual(commands(stopped('review_failed')), [['Retry review', 'sf review app T-1'], ...ALWAYS]);
  assert.deepEqual(commands(stopped('iteration_limit')), [['Restart', 'sf restart app T-1'], ...ALWAYS]);
  assert.deepEqual(commands(stopped('mr_push_failed')), [['Push again', 'sf approve app T-1'], ...ALWAYS]);
  assert.deepEqual(commands(stopped('mr_conflict')), [['Tell it how', 'sf say app T-1 "<message>"'], ...ALWAYS]);
  assert.deepEqual(commands(stopped('mr_text_invalid')), ALWAYS);
});

// ---------- The cap ----------

test('the cap: an input over the limit loses the user\'s messages first (oldest first), then the Report from the end, then expected; never the stop message or the answers; too long alone: null', () => {
  const input: ExplainInput = {
    task: { title: 'Title', goal: 'Goal.' },
    stop: { code: 'escalated', message: 'M'.repeat(200) },
    entries: [{ id: 'R1', severity: 'major', path: 'a.ts', problem: 'P'.repeat(50), expected: 'E'.repeat(300), response: 'Q'.repeat(50), dispute: null }],
    report: { done: 'D'.repeat(300), open_questions: 'O'.repeat(300) },
    your_messages: [{ iteration: 2, at: null, text: 'old'.repeat(100) }, { iteration: 3, at: null, text: 'new'.repeat(100) }],
    answers: [{ label: 'Abort', command: 'sf abort app T-1' }],
  };
  const size = (value: unknown): number => JSON.stringify(value).length;
  const whole = size(input);
  // Within the limit: as it is.
  assert.deepEqual(capExplainInput(input, whole), input);

  // The oldest message goes first.
  const one = capExplainInput(input, whole - 10)!;
  assert.deepEqual(one.your_messages.map((message) => message.iteration), [3]);
  assert.deepEqual([one.report, one.entries], [input.report, input.entries]);
  assert.ok(size(one) <= whole - 10);
  // Then every message, then the Report from its end: open questions first, then done.
  const report = capExplainInput(input, whole - 700)!;
  assert.deepEqual(report.your_messages, []);
  assert.equal(report.report.done, input.report.done);
  assert.ok(report.report.open_questions.length < 300 && report.report.open_questions.endsWith('…'));
  assert.ok(size(report) <= whole - 700);
  const both = capExplainInput(input, whole - 1000)!;
  assert.equal(both.report.open_questions, '');
  assert.ok(both.report.done.length < 300);
  assert.equal(both.entries[0]!.expected, input.entries[0]!.expected);
  // Then expected; never the stop message, the problem, the response or the answers.
  const expected = capExplainInput(input, whole - 1450)!;
  assert.deepEqual([expected.report, expected.entries[0]!.expected.length < 300], [{ done: '', open_questions: '' }, true]);
  for (const capped of [one, report, both, expected]) {
    assert.deepEqual([capped.stop, capped.task, capped.answers, capped.entries[0]!.problem, capped.entries[0]!.response], [input.stop, input.task, input.answers, input.entries[0]!.problem, input.entries[0]!.response]);
  }
  assert.equal(capExplainInput(input, 500), null);
  // The input itself is not changed.
  assert.equal(size(input), whole);
});

test('taskGoal: the first level-2 section starting with Goal, else the first level-2 section; the title from the front matter, else the level-1 heading', () => {
  assert.deepEqual(taskGoal('# T-1: Title\n\n## Context\n\nA.\n\n## Goal\n\nB.\n```\n## not a heading\n```\n# End'), { title: 'T-1: Title', goal: '## Goal\n\nB.\n```\n## not a heading\n```' });
  assert.deepEqual(taskGoal('# T-1: Title\n\n## Context\n\nA.\n\n## Other\n\nB.'), { title: 'T-1: Title', goal: '## Context\n\nA.' });
  assert.deepEqual(taskGoal(undefined), { title: '', goal: '' });
});

test('explain: the output schema is draft-07 without $schema and asks for the four fields', () => {
  assert.equal(EXPLAIN_SCHEMA.$schema, undefined);
  assert.deepEqual(Object.keys(EXPLAIN_SCHEMA.properties as object), ['headline', 'explanation', 'choices', 'recommendation']);
});

// ---------- sf explain ----------

test('sf explain prints the current stop\'s explanation, or the No explanation line; without sf serve', async () => {
  const env = await newEnv('sf-explain');
  const jobs = new JobStore(env.state);
  const job = stopped('escalated');
  await jobs.write(job);
  const none = await runCli(env, ['explain', 'app', 'T-1']);
  assert.deepEqual([none.code, none.stdout], [0, 'No explanation for the current stop.\n']);

  await mkdir(jobs.dir('app', 'T-1'), { recursive: true });
  const record: ExplanationRecord = { stop: { at: T0, code: 'escalated' }, model: 'sonnet', language: 'English', started_at: T0, ended_at: T0, cost_usd: 0.02, output: OUTPUT, error: null };
  await writeFile(explanationPath(jobs, 'app', 'T-1'), JSON.stringify(record));
  const shown = await runCli(env, ['explain', 'app', 'T-1']);
  assert.equal(shown.code, 0);
  assert.equal(shown.stdout, `${explanationLines(record).join('\n')}\n`);
  assert.match(shown.stdout, /^Keep your version of the rows/);
  assert.match(shown.stdout, /- Keep your version \(recommended\): /);
  assert.match(shown.stdout, /Recommendation: Keep your version/);

  // Another stop's file: none.
  await jobs.write({ ...job, updated_at: '2026-11-06T11:00:00.000Z' });
  assert.equal((await runCli(env, ['explain', 'app', 'T-1'])).stdout, 'No explanation for the current stop.\n');
  // Pending.
  await jobs.write(job);
  await writeFile(explanationPath(jobs, 'app', 'T-1'), JSON.stringify({ ...record, ended_at: null, output: null, cost_usd: null }));
  assert.equal((await runCli(env, ['explain', 'app', 'T-1'])).stdout, 'No explanation for the current stop.\nIt is being written.\n');
  const missing = await runCli(env, ['explain', 'app', 'T-9']);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /There is no job for app\/T-9/);
  assert.notEqual((await runCli(env, ['explain', 'app'])).code, 0);
});
