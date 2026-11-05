// SF-069: an Implementer turn that ends at its turn limit (SF_MAX_TURNS) goes on once by itself
// when it made progress (the worktree changed during the turn and it was not repeating one tool
// call), else the job stops in needs_human with a plain sentence. The decision and its sentences,
// the session driver's bound per chain (with the fake Claude Code), and the job end to end: one
// continuation then success, no change, a repeating call, two limits in a row, a new chain after a
// fix round and after the user's message, SF_TURN_LIMIT_CONTINUES=0, and the one line of sf
// status, sf watch, the notification and the board.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { jobNotification } from '../src/notify.js';
import { ImplementerSession, type IdleOutcome, type LimitedTurn } from '../src/session.js';
import { MAX_PATCH_BYTES } from '../src/patch.js';
import { CONTINUE_PROMPT, limitDecision, repeatedCall, turnLimitLine, worktreeChanged, worktreeState } from '../src/turn-limit.js';
import { formatEvent } from '../src/watch.js';
import { call, type Env, FAKE, fakeLog, git, newEnv, newRepo, putTask, runCli, script, serve, stop, temp, waitFor } from './support/harness.js';

const bash = (command: string): { tool: string; input: Record<string, unknown> } => ({ tool: 'Bash', input: { command } });
const calls = (count: number, make: (index: number) => { tool: string; input: unknown }) => Array.from({ length: count }, (_, index) => {
  const made = make(index);
  return { name: made.tool, input: made.input };
});

async function eventsOf(env: Env, ticket: string): Promise<Array<Record<string, any>>> {
  return (await readFile(join(env.state, 'jobs', 'app', ticket, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

const continuations = async (env: Env, ticket: string): Promise<Array<Record<string, any>>> =>
  (await eventsOf(env, ticket)).filter((event) => event.type === 'turn_limit_continued');

test('limitDecision: progress goes on; no change, a repeating call or the chain used up stops with its sentence', () => {
  const varied = calls(25, (index) => bash(`step ${index}`));
  assert.deepEqual(limitDecision({ maxTurns: 150, changed: true, calls: varied, continued: 0, allowed: 1 }), { continue: true });
  assert.deepEqual(limitDecision({ maxTurns: 150, changed: false, calls: varied, continued: 0, allowed: 1 }),
    { continue: false, message: 'The Implementer used all 150 steps of this turn without changing files.' });
  const looping = [...varied, ...calls(4, () => bash('npm test'))];
  assert.deepEqual(limitDecision({ maxTurns: 150, changed: true, calls: looping, continued: 0, allowed: 1 }),
    { continue: false, message: 'The Implementer used all 150 steps of this turn and was repeating `Bash {"command":"npm test"}`.' });
  assert.deepEqual(limitDecision({ maxTurns: 150, changed: false, calls: looping, continued: 0, allowed: 1 }),
    { continue: false, message: 'The Implementer used all 150 steps of this turn without changing files and was repeating `Bash {"command":"npm test"}`.' });
  assert.deepEqual(limitDecision({ maxTurns: 150, changed: true, calls: varied, continued: 1, allowed: 1 }),
    { continue: false, message: 'The Implementer used all 150 steps of this turn twice in a row; it may need a smaller task or a higher SF_MAX_TURNS.' });
  assert.deepEqual(limitDecision({ maxTurns: 150, changed: true, calls: varied, continued: 2, allowed: 2 }),
    { continue: false, message: 'The Implementer used all 150 steps of this turn 3 times in a row; it may need a smaller task or a higher SF_MAX_TURNS.' });
  // The worktree could not be read: no progress, said as it is.
  assert.deepEqual(limitDecision({ maxTurns: 150, changed: undefined, calls: varied, continued: 0, allowed: 1 }),
    { continue: false, message: 'The Implementer used all 150 steps of this turn and its changes to the files could not be read.' });
  // SF_TURN_LIMIT_CONTINUES=0: the first limit stops.
  assert.deepEqual(limitDecision({ maxTurns: 150, changed: true, calls: varied, continued: 0, allowed: 0 }),
    { continue: false, message: 'The Implementer used all 150 steps of this turn; it may need a smaller task or a higher SF_MAX_TURNS.' });
});

test('repeatedCall: more than 3 of one call (same tool, same input) among the last 20 calls', () => {
  assert.equal(repeatedCall(calls(3, () => bash('ls'))), undefined);
  assert.equal(repeatedCall(calls(4, () => bash('ls'))), 'Bash {"command":"ls"}');
  // Same input, another tool; same tool, another input: different calls.
  assert.equal(repeatedCall([...calls(3, () => bash('ls')), ...calls(3, () => ({ tool: 'Read', input: { command: 'ls' } })), ...calls(3, () => bash('ls -a'))]), undefined);
  // Four alike, but one of them is older than the last 20 calls.
  assert.equal(repeatedCall([...calls(1, () => bash('ls')), ...calls(17, (index) => bash(`x${index}`)), ...calls(3, () => bash('ls'))]), undefined);
  assert.equal(repeatedCall([...calls(16, (index) => bash(`x${index}`)), ...calls(4, () => bash('ls'))]), 'Bash {"command":"ls"}');
  // A long input is cut short.
  const long = repeatedCall(calls(4, () => bash('y'.repeat(500))))!;
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});

test('worktreeChanged: a changed path set or patch hash; an unknown state is no change', () => {
  const state = { paths: ['a.txt'], hash: 'h1' };
  assert.equal(worktreeChanged(state, { paths: ['a.txt'], hash: 'h1' }), false);
  assert.equal(worktreeChanged(state, { paths: ['a.txt'], hash: 'h2' }), true);
  assert.equal(worktreeChanged(state, { paths: ['a.txt', 'b.txt'], hash: 'h1' }), true);
  assert.equal(worktreeChanged(state, { paths: ['b.txt'], hash: 'h1' }), true);
  assert.equal(worktreeChanged(undefined, state), undefined);
  assert.equal(worktreeChanged(state, undefined), undefined);
});

// Fix 1 (R1): the comparison sees the whole Patch, not the one cut at MAX_PATCH_BYTES for display.
test('worktreeState: an edit beyond the displayed Patch cutoff, in a file already changed, is a change', async () => {
  const repo = join(temp, 'state-beyond-cutoff');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'big.txt'), 'start\n');
  await writeFile(join(repo, 'small.txt'), 'small\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  const line = `${'x'.repeat(99)}\n`;
  const body = line.repeat(Math.ceil((MAX_PATCH_BYTES * 1.5) / line.length));
  await writeFile(join(repo, 'big.txt'), `${body}tail one\n`);
  const start = await worktreeState(repo, base);
  // Only the end of the file, far beyond the cutoff, changes.
  await writeFile(join(repo, 'big.txt'), `${body}tail two\n`);
  const end = await worktreeState(repo, base);
  assert.deepEqual(end.paths, ['big.txt']);
  assert.equal(worktreeChanged(start, end), true);
  // Nothing written: the same state.
  assert.equal(worktreeChanged(end, await worktreeState(repo, base)), false);
  // An untracked file and a binary change count as well.
  await writeFile(join(repo, 'new.bin'), Buffer.from([0, 1, 2]));
  const withNew = await worktreeState(repo, base);
  assert.equal(worktreeChanged(end, withNew), true);
  await writeFile(join(repo, 'new.bin'), Buffer.from([0, 1, 3]));
  assert.equal(worktreeChanged(withNew, await worktreeState(repo, base)), true);
});

test('turnLimitLine: one line while the chain that went on is current, none once the job ended', () => {
  const line = 'The Implementer reached the turn limit while making progress; the factory went on by itself (1 of 1).';
  assert.equal(turnLimitLine({ state: 'working', turn_limit: { continued: 1, allowed: 1 } }), line);
  assert.equal(turnLimitLine({ state: 'aborted', turn_limit: { continued: 1, allowed: 1 } }), undefined);
  assert.equal(turnLimitLine({ state: 'working', turn_limit: undefined }), undefined);
  // The chain stopped at a later limit: its error says so, the line does not repeat it.
  assert.equal(turnLimitLine({ state: 'needs_human', turn_limit: { continued: 1, allowed: 1 }, error: { code: 'max_turns', message: 'twice in a row' } }), undefined);
  const job = {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-x', base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null, mr_attempts: 0,
    state: 'awaiting_review' as const, iteration: 1, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null, created_at: '2026-11-05T10:00:00.000Z',
    updated_at: '2026-11-05T10:00:00.000Z', mr: null, turn_limit: { continued: 1, allowed: 1 },
  };
  assert.deepEqual(jobNotification(job, ['3 files changed']).body.split('\n'), ['Report and Patch of iteration 1 are ready for the reviewers', line, '3 files changed']);
  assert.equal(formatEvent(JSON.stringify({ ts: '2026-11-05T10:00:00.000Z', iteration: 1, type: 'turn_limit_continued', continued: 1, allowed: 1, max_turns: 150, changed_paths: 2, tool_calls: 40 }))[0]!.replace(/^\S+ /, ''),
    '[1] turn limit of 150 steps reached while making progress, 2 changed paths; the factory went on by itself (1 of 1)');
});

// The session driver alone, on the fake Claude Code: a hook that always asks to go on gets at
// most turnLimitContinues continuations per chain, and a prompt sent starts a new chain.
test('ImplementerSession: at most turnLimitContinues continuations per chain, whatever the hook answers', async () => {
  const home = join(temp, 'session-bound');
  await mkdir(home, { recursive: true });
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const limit = { maxTurns: true, calls: [bash('make')] };
    await writeFile(join(home, 'fake-claude.json'), JSON.stringify({ turns: [limit, limit, limit, {}] }));
    const asked: LimitedTurn[] = [];
    const prompts: Array<[string, number]> = [];
    let idle: (outcome: IdleOutcome) => void = () => undefined;
    const session = new ImplementerSession({ cwd: home, maxTurns: 7, claudePath: FAKE, turnLimitContinues: 1 }, {
      message: async () => undefined,
      prompt: async (prompt, continued) => {
        prompts.push([prompt, continued]);
      },
      turnLimit: async (turn) => {
        asked.push(turn);
        return { prompt: 'go on' };
      },
      idle: async (outcome) => idle(outcome),
    });
    const first = await new Promise<IdleOutcome>((done) => {
      idle = done;
      session.send('first', []);
    });
    assert.equal(first.ok, false);
    assert.equal(first.ok === false && first.code, 'max_turns');
    assert.match(first.ok === false ? first.message : '', /Reached maximum number of turns \(7\)/);
    assert.deepEqual(prompts, [['first', 0], ['go on', 1]]);
    assert.deepEqual(asked.map((turn) => [turn.continued, turn.allowed, turn.calls]), [[0, 1, [{ name: 'Bash', input: { command: 'make' } }]], [1, 1, [{ name: 'Bash', input: { command: 'make' } }]]]);
    // A prompt sent: a new chain, which gets its continuation again.
    const second = await new Promise<IdleOutcome>((done) => {
      idle = done;
      session.send('second', []);
    });
    assert.equal(second.ok, true);
    assert.deepEqual(prompts.slice(2), [['second', 0], ['go on', 1]]);
    await session.close();
  } finally {
    process.env.HOME = saved;
  }
});

async function started(name: string, ticket: string, turns: unknown[], extra: Record<string, string> = {}) {
  const env = await newEnv(name, { SF_MAX_TURNS: '10', ...extra });
  const repo = await newRepo(env, `${name}-repo`, false);
  await putTask(env, repo, ticket, 'Limited');
  await script(env, turns);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket });
  return { env, served };
}

test('a turn limit with changed files: one continuation into the same session, then the iteration is published', async () => {
  const { env, served } = await started('limit-progress', 'L-1', [
    { write: { 'a.txt': 'a\n' }, calls: [bash('npm test'), bash('npm run build')], maxTurns: true },
    { write: { 'b.txt': 'b\n' }, text: 'Report: done' },
  ]);
  try {
    await waitFor(served, 'L-1', 'awaiting_review', 1);
    const log = await fakeLog(env);
    assert.equal(log.length, 2);
    assert.equal(log[1]!.prompt, CONTINUE_PROMPT);
    assert.ok(log[1]!.argv.includes(`--resume=${log[0]!.sessionId}`), JSON.stringify(log[1]!.argv));
    const [continued, ...more] = await continuations(env, 'L-1');
    assert.equal(more.length, 0);
    assert.deepEqual({ ...continued, ts: undefined }, { ts: undefined, iteration: 1, type: 'turn_limit_continued', continued: 1, allowed: 1, max_turns: 10, changed_paths: 1, tool_calls: 2 });
    const report = await readFile(join(env.state, 'jobs', 'app', 'L-1', 'iterations', '001', 'report.md'), 'utf8');
    assert.match(report, /^Report: done/);
    assert.match(report, /a\.txt/);
    assert.match(report, /b\.txt/);
    const job = (await new JobStore(env.state).read('app', 'L-1'))!;
    assert.deepEqual(job.turn_limit, { continued: 1, allowed: 1 });
    // sf status and sf watch: one line each.
    const line = 'The Implementer reached the turn limit while making progress; the factory went on by itself (1 of 1).';
    const status = await runCli(env, ['status', 'app', 'L-1']);
    assert.equal(status.stdout.split('\n').filter((text) => text === line).length, 1, status.stdout);
    const all = await runCli(env, ['status']);
    assert.ok(all.stdout.split('\n').includes(`app/L-1: ${line}`), all.stdout);
    const watched = await runCli(env, ['watch', 'app', 'L-1', '--once']);
    assert.equal(watched.stdout.split('\n').filter((text) => /turn limit of 10 steps reached while making progress, 1 changed path; the factory went on by itself \(1 of 1\)$/.test(text)).length, 1, watched.stdout);
  } finally {
    await stop(served);
  }
});

test('a turn limit without changed files stops in needs_human with the sentence; no continuation', async () => {
  const { env, served } = await started('limit-still', 'L-2', [{ calls: [bash('ls')], maxTurns: true }, {}]);
  try {
    const checked = await waitFor(served, 'L-2', 'needs_human');
    assert.deepEqual(checked.error, { code: 'max_turns', message: 'The Implementer used all 10 steps of this turn without changing files.' });
    assert.equal((await fakeLog(env)).length, 1);
    assert.deepEqual(await continuations(env, 'L-2'), []);
  } finally {
    await stop(served);
  }
});

test('a turn limit while repeating one call stops in needs_human, though files changed', async () => {
  const { env, served } = await started('limit-loop', 'L-3', [{ write: { 'a.txt': 'a\n' }, calls: [bash('x'), bash('npm test'), bash('npm test'), bash('npm test'), bash('npm test')], maxTurns: true }, {}]);
  try {
    const checked = await waitFor(served, 'L-3', 'needs_human');
    assert.deepEqual(checked.error, { code: 'max_turns', message: 'The Implementer used all 10 steps of this turn and was repeating `Bash {"command":"npm test"}`.' });
    assert.equal((await fakeLog(env)).length, 1);
    assert.deepEqual(await continuations(env, 'L-3'), []);
  } finally {
    await stop(served);
  }
});

test('two turn limits in a row stop the second time; the user\'s message and a fix round each start a new chain', async () => {
  const progress = (file: string) => ({ write: { [file]: `${file}\n` }, maxTurns: true });
  const { env, served } = await started('limit-twice', 'L-4', [
    progress('a.txt'), progress('b.txt'),
    // sf say: a new chain, with its continuation.
    progress('c.txt'), { write: { 'd.txt': 'd\n' } },
    // A fix round: a new chain again.
    progress('e.txt'), { write: { 'f.txt': 'f\n' } },
  ]);
  try {
    const stopped = await waitFor(served, 'L-4', 'needs_human');
    assert.deepEqual(stopped.error, { code: 'max_turns', message: 'The Implementer used all 10 steps of this turn twice in a row; it may need a smaller task or a higher SF_MAX_TURNS.' });
    assert.equal((await continuations(env, 'L-4')).length, 1);
    assert.doesNotMatch((await runCli(env, ['status', 'app', 'L-4'])).stdout, /went on by itself/);
    assert.equal((await runCli(env, ['say', 'app', 'L-4', 'Go', 'on.'])).code, 0);
    await waitFor(served, 'L-4', 'awaiting_review', 1);
    assert.equal((await continuations(env, 'L-4')).length, 2);
    await call(served, 'request_fix', { workspace: 'app', ticket: 'L-4', content: 'One more file.' });
    await waitFor(served, 'L-4', 'awaiting_review', 2);
    assert.deepEqual((await continuations(env, 'L-4')).map((event) => [event.iteration, event.continued]), [[1, 1], [1, 1], [2, 1]]);
    const prompts = (await fakeLog(env)).map((entry) => entry.prompt === CONTINUE_PROMPT);
    assert.deepEqual(prompts, [false, true, false, true, false, true]);
  } finally {
    await stop(served);
  }
});

test('SF_TURN_LIMIT_CONTINUES=0: the first turn limit stops in needs_human, as before', async () => {
  const { env, served } = await started('limit-off', 'L-5', [{ write: { 'a.txt': 'a\n' }, maxTurns: true }, {}], { SF_TURN_LIMIT_CONTINUES: '0' });
  try {
    const checked = await waitFor(served, 'L-5', 'needs_human');
    assert.deepEqual(checked.error, { code: 'max_turns', message: 'The Implementer used all 10 steps of this turn; it may need a smaller task or a higher SF_MAX_TURNS.' });
    assert.equal((await fakeLog(env)).length, 1);
    assert.deepEqual(await continuations(env, 'L-5'), []);
    assert.equal((await new JobStore(env.state).read('app', 'L-5'))!.turn_limit, undefined);
  } finally {
    await stop(served);
  }
});
