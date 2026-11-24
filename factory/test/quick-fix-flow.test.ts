// End-to-end tests of the quick fix (sf quickfix) with the real sf serve and CLI, the fake Claude
// as the Implementer and the reviewer (SF_REVIEW on, the gate off): the states it is refused in;
// a small fix on a ready job and on a handed-over job goes to MR preparation with no review round;
// a fix over the bound or on a sensitive or security path goes through the full loop; a Tests Fix
// inside the lane is decided again; a stop inside the lane goes on only by sf say, which ends the
// quick fix, also while its turn runs; the dashboard's route (POST api/jobs/<ws>/<ticket>/quickfix)
// and its refusals.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { callSocket } from '../src/ipc.js';
import { jobUserMessages } from '../src/job-stream.js';
import { JobStore } from '../src/jobs.js';
import { QUICK_FIX_END, QUICK_FIX_LEAD } from '../src/prompts.js';
import { saveRegistry } from '../src/registry.js';
import { writeTask } from '../src/task-file.js';
import { act, type Reply } from './support/dashboard-client.js';
import { call, type Env, fakeLog, git, newEnv, newRepo, reviewLog, reviewScript, runCli, runnerPids, script, serve, stop, waitFor } from './support/harness.js';
import { status } from './support/handoff.js';

const TICKET = 'Q-1';
const TITLE = `feat(${TICKET}): Change the notes`;
const MESSAGE = 'Make b upper case';

function mrText(): string {
  return [
    TITLE, '',
    '## What', 'Changes the notes.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- notes.txt', '## Testing', 'Not checked: nothing to run.', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

const mrTurn = { write: { [`.software-factory/${TICKET}.mr.md`]: mrText() }, text: 'MR text' };
const clean = (accepted: string[] = []): Record<string, unknown> => ({ output: { verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: accepted } });

// The registry's workspace app on repo, with its test command when given.
const setCommand = (env: Env, repo: string, command: string | undefined): Promise<void> =>
  saveRegistry({ workspaces: { app: { read_checkout: repo, work_checkout: repo, ...(command !== undefined ? { test_command: command } : {}) } } }, env.config);

// A workspace with an origin and the Task Q-1, whose scope names the files the tests change but extra.txt.
async function quickEnv(name: string, extra: Record<string, string> = {}, command?: string): Promise<{ env: Env; repo: string }> {
  const env = await newEnv(name, { SF_REVIEW: 'on', SF_GATE: 'off', ...extra });
  const repo = await newRepo(env, `${name}-repo`, true);
  await setCommand(env, repo, command);
  const text = `---\nticket: ${TICKET}\ntitle: Change the notes\nbase: main\nscope: [README.md, notes.txt, package.json, src/session-store.ts]\n---\n\n# ${TICKET}: Change the notes\n\nChange the notes.\n`;
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, TICKET, text, new JobStore(env.state));
  return { env, repo };
}

const jobDir = (env: Env): string => join(env.state, 'jobs', 'app', TICKET);
const jobJson = async (env: Env): Promise<Record<string, any>> => JSON.parse(await readFile(join(jobDir(env), 'job.json'), 'utf8'));

// The quick fix's events, each without its time.
async function quickFixEvents(env: Env): Promise<Array<Record<string, unknown>>> {
  const lines = (await readFile(join(jobDir(env), 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  return lines.filter((event) => event.type === 'quick_fix').map(({ ts: _ts, type: _type, ...rest }) => rest);
}

async function quickfix(env: Env, ...words: string[]): Promise<void> {
  const asked = await runCli(env, ['quickfix', 'app', TICKET, ...words]);
  assert.equal(asked.code, 0, asked.stdout + asked.stderr);
  assert.match(asked.stdout, /^state: working$/m);
}

test('sf quickfix is refused in working, awaiting_review, needs_human and pushed, for an empty message, and without a message', async () => {
  const { env, repo } = await quickEnv('qf-refused', { SF_REVIEW: 'off' }, 'exit 127');
  await script(env, [{ delayMs: 1500, write: { 'notes.txt': 'a\n' }, text: 'iteration 1' }, { write: { 'notes.txt': 'a\nb\n' }, text: 'iteration 2' }, mrTurn]);
  const served = await serve(env);
  const refused = async (state: string): Promise<void> => {
    const answer = await runCli(env, ['quickfix', 'app', TICKET, 'fix', 'it']);
    assert.equal(answer.code, 1, answer.stdout + answer.stderr);
    assert.ok(answer.stderr.includes(`sf quickfix needs ready_for_human_review or handed_over; the job is ${state}. Use sf say.`), answer.stderr);
  };
  try {
    await call(served, 'start', { workspace: 'app', ticket: TICKET });
    await waitFor(served, TICKET, 'working');
    await refused('working');
    await waitFor(served, TICKET, 'awaiting_review', 1);
    await refused('awaiting_review');
    await call(served, 'mark_clean', { workspace: 'app', ticket: TICKET });
    assert.equal((await waitFor(served, TICKET, 'needs_human', 1)).error.code, 'tests_unavailable');
    await refused('needs_human');
    await setCommand(env, repo, 'exit 0');
    assert.equal((await runCli(env, ['say', 'app', TICKET, 'go', 'on'])).code, 0);
    await waitFor(served, TICKET, 'awaiting_review', 2);
    await call(served, 'mark_clean', { workspace: 'app', ticket: TICKET });
    await waitFor(served, TICKET, 'ready_for_human_review', 2);
    const empty = await runCli(env, ['quickfix', 'app', TICKET, ' ']);
    assert.equal(empty.code, 1, empty.stdout + empty.stderr);
    assert.ok(empty.stderr.includes('The message must be non-empty text.'), empty.stderr);
    const response = await callSocket(env.state, { command: 'quickfix', args: ['app', TICKET, ' '] });
    assert.deepEqual(response, { ok: false, error: { code: 'invalid_content', message: 'The message must be non-empty text.' } });
    assert.equal((await runCli(env, ['quickfix', 'app', TICKET])).code, 2);
    assert.equal((await jobJson(env)).state, 'ready_for_human_review');
    assert.equal((await runCli(env, ['approve', 'app', TICKET])).code, 0);
    await waitFor(served, TICKET, 'pushed', 2);
    await refused('pushed');
    assert.deepEqual(await quickFixEvents(env), []);
  } finally {
    await stop(served);
  }
});

// A dashboard reply's refusal: its status, code and message.
const refusal = (reply: Reply): { status: number; code: string; message: string } => {
  const { code, message } = JSON.parse(reply.body).error as { code: string; message: string };
  return { status: reply.status, code, message };
};

test('the dashboard\'s quickfix route: 200 on a ready job (working, quick_fix asked), 409 invalid_state while working, 400 invalid_content for an empty message, 409 quick_fix_unavailable without a prepared commit', async () => {
  const { env } = await quickEnv('qf-route');
  await script(env, [
    { write: { 'notes.txt': 'a\nb\n' }, text: 'iteration 1' },
    mrTurn,
    { delayMs: 3000, write: { 'notes.txt': 'a\nB\n' }, text: 'the quick fix' },
    mrTurn,
  ]);
  await reviewScript(env, [clean()]);
  const served = await serve(env);
  try {
    const base = served.dashboard!;
    const path = `api/jobs/app/${TICKET}/quickfix`;
    await call(served, 'start', { workspace: 'app', ticket: TICKET });
    await waitFor(served, TICKET, 'ready_for_human_review', 1);
    const asked = await act(base, path, { message: MESSAGE });
    assert.equal(asked.status, 200, asked.body);
    assert.deepEqual(JSON.parse(asked.body).result, { state: 'working', queued: false });
    assert.equal((await jobJson(env)).state, 'working');
    assert.deepEqual(await quickFixEvents(env), [{ iteration: 1, action: 'asked', from: 'ready_for_human_review' }]);
    // While the quick fix's turn runs: SF-313's refusal of any state but ready or handed over.
    assert.deepEqual(refusal(await act(base, path, { message: 'again' })), {
      status: 409, code: 'invalid_state', message: 'sf quickfix needs ready_for_human_review or handed_over; the job is working. Use sf say.',
    });
    await waitFor(served, TICKET, 'ready_for_human_review', 2);
    assert.ok((await fakeLog(env))[2]!.prompt.startsWith(`${MESSAGE}\n\n${QUICK_FIX_LEAD}\n`));
    assert.deepEqual(refusal(await act(base, path, { message: '' })), { status: 400, code: 'invalid_content', message: 'The message must be non-empty text.' });
    // A ready job without the commit to measure the fix against: refused, and it stays ready.
    const jobs = new JobStore(env.state);
    await jobs.write({ ...(await jobs.read('app', TICKET))!, prepared_commit: null });
    assert.deepEqual(refusal(await act(base, path, { message: MESSAGE })), {
      status: 409, code: 'quick_fix_unavailable', message: 'The job has no prepared commit to measure a quick fix against. Use sf say.',
    });
    const after = await jobJson(env);
    assert.deepEqual([after.state, after.iteration], ['ready_for_human_review', 2]);
    assert.equal((await fakeLog(env)).length, 4);
    assert.deepEqual((await quickFixEvents(env)).map((event) => event.action), ['asked', 'quick']);
  } finally {
    await stop(served);
  }
});

test('a quick fix on a ready job: one turn, no review, the MR text turn given the earlier MR text, ready again with a new prepared commit; the path the reviewer accepted outside the scope stays accepted', async () => {
  const { env, repo } = await quickEnv('qf-ready');
  await script(env, [
    { write: { 'README.md': 'one\n', 'notes.txt': 'a\nb\nc\n', 'extra.txt': 'x\n' }, text: 'iteration 1' },
    mrTurn,
    { write: { 'notes.txt': 'a\nB\nc\n' }, text: 'the quick fix' },
    mrTurn,
  ]);
  await reviewScript(env, [clean(['extra.txt'])]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: TICKET });
    await waitFor(served, TICKET, 'ready_for_human_review', 1);
    const before = await jobJson(env);
    await quickfix(env, 'Make', 'b', 'upper', 'case');
    await waitFor(served, TICKET, 'ready_for_human_review', 2);
    const job = await jobJson(env);
    // No review ran on iteration 2.
    assert.equal((await reviewLog(env)).length, 1);
    assert.deepEqual(await quickFixEvents(env), [
      { iteration: 1, action: 'asked', from: 'ready_for_human_review' },
      { iteration: 2, action: 'quick', files: 1, lines: 2 },
    ]);
    const prompts = (await fakeLog(env)).map((run) => run.prompt);
    assert.equal(prompts.length, 4);
    assert.ok(prompts[2]!.startsWith(`${MESSAGE}\n\n${QUICK_FIX_LEAD}\n`), prompts[2]);
    assert.ok(prompts[2]!.includes(`\n${QUICK_FIX_END}\n\n`), prompts[2]);
    assert.ok(prompts[3]!.includes(`<mr_text>\n${TITLE}\n\n## What\n`), prompts[3]);
    assert.notEqual(job.prepared_commit, before.prepared_commit);
    assert.equal(git(repo, 'show', `${job.prepared_commit}:notes.txt`), 'a\nB\nc\n');
    assert.equal(git(repo, 'show', `${job.prepared_commit}:extra.txt`), 'x\n');
    assert.equal(job.quick_fix, undefined);
    assert.equal(job.fixes, before.fixes);
    // The Stream shows the user's words alone.
    assert.deepEqual((await jobUserMessages(new JobStore(env.state), 'app', TICKET)).map((message) => message.text), [MESSAGE]);
  } finally {
    await stop(served);
  }
});

test('a quick fix on a job handed over by sf handover with hand-over off: the checkout edit comes back and counts, and the job is handed over again with both changes', async () => {
  const { env, repo } = await quickEnv('qf-handed');
  await script(env, [
    { write: { 'README.md': 'one\n', 'notes.txt': 'a\nb\nc\n' }, text: 'iteration 1' },
    mrTurn,
    { write: { 'notes.txt': 'a\nb\nc\nd\n' }, text: 'the quick fix' },
    mrTurn,
  ]);
  await reviewScript(env, [clean()]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: TICKET });
    await waitFor(served, TICKET, 'ready_for_human_review', 1);
    const handed = await runCli(env, ['handover', 'app', TICKET]);
    assert.equal(handed.code, 0, handed.stdout + handed.stderr);
    assert.equal((await jobJson(env)).state, 'handed_over');
    await writeFile(join(repo, 'README.md'), 'one\nmine\n');
    await quickfix(env, 'Add', 'd');
    await waitFor(served, TICKET, 'handed_over', 2);
    assert.equal((await reviewLog(env)).length, 1);
    assert.deepEqual(await quickFixEvents(env), [
      { iteration: 1, action: 'asked', from: 'handed_over' },
      { iteration: 2, action: 'quick', files: 2, lines: 2 },
    ]);
    // Both changes are Local Changes in the checkout.
    assert.equal(status(repo), ' M README.md\n A notes.txt\n');
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'one\nmine\n');
    assert.equal(await readFile(join(repo, 'notes.txt'), 'utf8'), 'a\nb\nc\nd\n');
    assert.equal((await jobJson(env)).quick_fix, undefined);
  } finally {
    await stop(served);
  }
});

test('a quick fix of 31 lines goes through the full loop: a review round, then ready', async () => {
  const { env } = await quickEnv('qf-size');
  const long = `a\nb\nc\n${Array.from({ length: 31 }, (_, index) => `line ${index}\n`).join('')}`;
  await script(env, [
    { write: { 'notes.txt': 'a\nb\nc\n' }, text: 'iteration 1' },
    mrTurn,
    { write: { 'notes.txt': long }, text: 'the quick fix' },
    mrTurn,
  ]);
  await reviewScript(env, [clean(), clean()]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: TICKET });
    await waitFor(served, TICKET, 'ready_for_human_review', 1);
    await quickfix(env, 'Add', 'the', 'lines');
    await waitFor(served, TICKET, 'ready_for_human_review', 2);
    assert.deepEqual(await quickFixEvents(env), [
      { iteration: 1, action: 'asked', from: 'ready_for_human_review' },
      { iteration: 2, action: 'full', reasons: ['size: 31 lines'] },
    ]);
    assert.equal((await reviewLog(env)).length, 2);
    assert.equal((await jobJson(env)).quick_fix, undefined);
  } finally {
    await stop(served);
  }
});

test('a one-line quick fix of package.json, then of src/session-store.ts, goes through the full loop naming the path', async () => {
  const { env } = await quickEnv('qf-paths');
  await script(env, [
    { write: { 'notes.txt': 'a\n' }, text: 'iteration 1' },
    mrTurn,
    { write: { 'package.json': '{}\n' }, text: 'the manifest' },
    mrTurn,
    { write: { 'src/session-store.ts': 'export {};\n' }, text: 'the store' },
    mrTurn,
  ]);
  await reviewScript(env, [clean(), clean(['package.json']), clean(['package.json'])]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: TICKET });
    await waitFor(served, TICKET, 'ready_for_human_review', 1);
    await quickfix(env, 'Add', 'a', 'manifest');
    await waitFor(served, TICKET, 'ready_for_human_review', 2);
    assert.equal((await reviewLog(env)).length, 2);
    await quickfix(env, 'Add', 'the', 'store');
    await waitFor(served, TICKET, 'ready_for_human_review', 3);
    assert.equal((await reviewLog(env)).length, 3);
    assert.deepEqual((await quickFixEvents(env)).filter((event) => event.action === 'full'), [
      { iteration: 2, action: 'full', reasons: ['sensitive: package.json'] },
      { iteration: 3, action: 'full', reasons: ['security: src/session-store.ts'] },
    ]);
  } finally {
    await stop(served);
  }
});

test('a test command failing once inside the lane: a Tests Fix, decided quick again, then ready with no review', async () => {
  const { env, repo } = await quickEnv('qf-tests', {}, 'grep -qx fixed notes.txt');
  await script(env, [
    { write: { 'notes.txt': 'a\nb\nc\nfixed\n' }, text: 'iteration 1' },
    mrTurn,
    { write: { 'notes.txt': 'a\nB\nc\n' }, text: 'the quick fix' },
    { write: { 'notes.txt': 'a\nB\nc\nfixed\n' }, text: 'the Tests Fix' },
    mrTurn,
  ]);
  await reviewScript(env, [clean()]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: TICKET });
    await waitFor(served, TICKET, 'ready_for_human_review', 1);
    const before = await jobJson(env);
    await quickfix(env, 'Make', 'b', 'upper', 'case');
    await waitFor(served, TICKET, 'ready_for_human_review', 3);
    assert.deepEqual(await quickFixEvents(env), [
      { iteration: 1, action: 'asked', from: 'ready_for_human_review' },
      { iteration: 2, action: 'quick', files: 1, lines: 3 },
      { iteration: 3, action: 'quick', files: 1, lines: 2 },
    ]);
    assert.equal((await reviewLog(env)).length, 1);
    const job = await jobJson(env);
    assert.deepEqual([job.quick_fix, job.fixes], [undefined, before.fixes]);
    assert.match(await readFile(join(repo, '.software-factory', `${TICKET}.md`), 'utf8'), /^## Fix 2: Tests$/m);
    assert.equal(git(repo, 'show', `${job.prepared_commit}:notes.txt`), 'a\nB\nc\nfixed\n');
  } finally {
    await stop(served);
  }
});

test('a lane stopped at tests_unavailable: sf accept and sf retry refuse as without a review; sf say ends the quick fix and the next iteration is reviewed', async () => {
  const { env, repo } = await quickEnv('qf-stop', {}, 'exit 0');
  await script(env, [
    { write: { 'notes.txt': 'a\nb\n' }, text: 'iteration 1' },
    mrTurn,
    { write: { 'notes.txt': 'a\nB\n' }, text: 'the quick fix' },
    { write: { 'notes.txt': 'a\nB\nc\n' }, text: 'after the message' },
    mrTurn,
  ]);
  await reviewScript(env, [clean(), clean()]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: TICKET });
    await waitFor(served, TICKET, 'ready_for_human_review', 1);
    await setCommand(env, repo, 'exit 127');
    await quickfix(env, 'Make', 'b', 'upper', 'case');
    assert.equal((await waitFor(served, TICKET, 'needs_human', 2)).error.code, 'tests_unavailable');
    assert.equal((await jobJson(env)).quick_fix.from, 'ready_for_human_review');
    const accepted = await runCli(env, ['accept', 'app', TICKET]);
    assert.equal(accepted.code, 1, accepted.stdout + accepted.stderr);
    assert.ok(accepted.stderr.includes('sf accept needs a clean Claude review of the last iteration (2); it has none.'), accepted.stderr);
    const retried = await runCli(env, ['retry', 'app', TICKET]);
    assert.equal(retried.code, 1, retried.stdout + retried.stderr);
    assert.ok(retried.stderr.includes('sf retry needs a clean Claude review of the last iteration (2); tell the Implementer to go on.'), retried.stderr);
    await setCommand(env, repo, 'exit 0');
    const said = await runCli(env, ['say', 'app', TICKET, 'Add', 'c']);
    assert.equal(said.code, 0, said.stdout + said.stderr);
    assert.equal((await jobJson(env)).quick_fix, undefined);
    await waitFor(served, TICKET, 'ready_for_human_review', 3);
    assert.equal((await reviewLog(env)).length, 2);
    assert.deepEqual((await quickFixEvents(env)).map((event) => event.action), ['asked', 'quick']);
  } finally {
    await stop(served);
  }
});

test('with SF_REVIEW=off, a job left awaiting its quick fix\'s decision when its runner ended gets a runner from sf serve\'s recovery and goes on to MR preparation', async () => {
  const { env, repo } = await quickEnv('qf-recover', { SF_REVIEW: 'off' });
  await script(env, [{ write: { 'notes.txt': 'a\n' }, text: 'iteration 1' }, mrTurn, mrTurn]);
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: TICKET });
    await waitFor(served, TICKET, 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: TICKET });
    await waitFor(served, TICKET, 'ready_for_human_review', 1);
  } finally {
    await stop(served);
  }
  // No runner is left: the job is as a runner that ended right after the quick fix's publish left it.
  const deadline = Date.now() + 20_000;
  for (;;) {
    const alive = (await runnerPids(jobDir(env))).filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) {
      break;
    }
    assert.ok(Date.now() < deadline, `runners still alive: ${alive.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const ready = await jobJson(env);
  const tree = git(repo, 'rev-parse', `${ready.prepared_commit}^{tree}`).trim();
  const left = { ...ready, state: 'awaiting_review', prepared_commit: null, quick_fix: { from: 'ready_for_human_review', tree, accepted: [] } };
  await writeFile(join(jobDir(env), 'job.json'), `${JSON.stringify(left, null, 2)}\n`);
  served = await serve(env);
  try {
    await waitFor(served, TICKET, 'ready_for_human_review', 1);
    assert.deepEqual(await quickFixEvents(env), [{ iteration: 1, action: 'quick', files: 0, lines: 0 }]);
    const job = await jobJson(env);
    assert.equal(job.quick_fix, undefined);
    assert.notEqual(job.prepared_commit, null);
  } finally {
    await stop(served);
  }
});

test('sf say while the quick fix\'s turn runs ends the quick fix: the iteration gets a review round', async () => {
  const { env } = await quickEnv('qf-say');
  await script(env, [
    { write: { 'notes.txt': 'a\nb\n' }, text: 'iteration 1' },
    mrTurn,
    { delayMs: 1500, write: { 'notes.txt': 'a\nB\n' }, text: 'the quick fix' },
    { write: { 'notes.txt': 'a\nB\nc\n' }, text: 'after the message' },
    mrTurn,
  ]);
  await reviewScript(env, [clean(), clean(), clean()]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: TICKET });
    await waitFor(served, TICKET, 'ready_for_human_review', 1);
    await quickfix(env, 'Make', 'b', 'upper', 'case');
    const said = await runCli(env, ['say', 'app', TICKET, 'Add', 'c']);
    assert.equal(said.code, 0, said.stdout + said.stderr);
    assert.equal((await jobJson(env)).quick_fix, undefined);
    const ready = await waitFor(served, TICKET, 'ready_for_human_review');
    assert.ok(ready.iteration >= 2, JSON.stringify(ready));
    assert.ok((await reviewLog(env)).length >= 2);
    assert.deepEqual((await quickFixEvents(env)).map((event) => event.action), ['asked']);
  } finally {
    await stop(served);
  }
});
