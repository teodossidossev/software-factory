// End-to-end tests of the Codex gate before Clean (SF-039) with the real sf serve, the fake Claude
// (its --json-schema runs are the Claude reviews, clean unless scripted) and the fake Codex
// (test/support/fake-codex.ts, scripted by $HOME/fake-codex.json): a clean gate runs Clean, a fix
// goes through Claude and the gate again, the argv, prompt and environment of the call, the round
// limit, the token ceiling, failures, abort and serve restart during a gate, the gate off, and the
// strict schema.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { GATE_SCHEMA, gateArgs } from '../src/gate.js';
import { JobStore } from '../src/jobs.js';
import { fetchRaw } from './support/dashboard-client.js';
import {
  call, codexLog, codexScript, type Env, fakeCodex, fakeLog, git, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, task, waitFor,
} from './support/harness.js';

const CLAUDE_CLEAN = { verdict: 'clean', summary: 'Claude found it right.', items: [], accepted_sensitive: [] };
const GATE_FIX = {
  verdict: 'fix',
  summary: 'The greeting\nis wrong.',
  items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.' }],
  accepted_sensitive: [],
};
const GATE_CLEAN = { verdict: 'clean', summary: 'Codex found it right.', items: [], accepted_sensitive: [] };
const FIX_SECTION = '## Fix 1\n\nReview by Codex: The greeting is wrong.\n\n1. `README.md`: It greets the world. Expected: It greets the reader.\n';

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'x', '## Why', 'The ticket asks for it.', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
    '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

const gateEnv = (extra: Record<string, string> = {}): Record<string, string> => ({ SF_REVIEW: 'on', SF_GATE: 'codex', SF_CODEX: fakeCodex, ...extra });
const taskFile = (repo: string, ticket: string): Promise<string> => readFile(join(repo, '.software-factory', `${ticket}.md`), 'utf8');
const worktreeOf = (env: Env, ticket: string): string => join(env.state, 'worktrees', 'app', ticket);
const iterationDir = (env: Env, ticket: string, number: number): string => join(env.state, 'jobs', 'app', ticket, 'iterations', String(number).padStart(3, '0'));
const option = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventsOf(env: Env, ticket: string): Promise<Array<Record<string, unknown>>> {
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

test('the strict schema: no $schema, every object has additionalProperties false and every property required', () => {
  assert.equal('$schema' in GATE_SCHEMA, false);
  const objects: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node !== null && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (record.type === 'object') {
        objects.push(record);
      }
      Object.values(record).forEach(walk);
    }
  };
  walk(GATE_SCHEMA);
  // The verdict and its items.
  assert.equal(objects.length, 2);
  for (const object of objects) {
    assert.equal(object.additionalProperties, false);
    assert.deepEqual(object.required, Object.keys(object.properties as object));
  }
  assert.deepEqual([...(GATE_SCHEMA.required as string[])].sort(), ['accepted_sensitive', 'items', 'summary', 'verdict']);
  assert.deepEqual(gateArgs({ cwd: '/w', dir: '/d', model: 'm' }).slice(-3), ['--model', 'm', '-']);
});

test('clean: Claude, then the gate in a read-only Codex in the worktree, then Clean; the argv, the prompt, the environment, gate.json, check, sf watch, sf info and the dashboard', async () => {
  const env = await newEnv('gate-clean', gateEnv());
  const repo = await newRepo(env, 'gate-clean-repo', false);
  await putTask(env, repo, 'G-1', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 1' },
    { write: { '.software-factory/G-1.mr.md': mrText('feat(G-1): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_CLEAN, usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 34 } }]);
  const served = await serve(env);
  try {
    assert.doesNotMatch(served.output, /^gate:/m);
    await call(served, 'start', { workspace: 'app', ticket: 'G-1' });
    const ready = await waitFor(served, 'G-1', 'ready_for_human_review', 1);
    assert.deepEqual(ready.review, { status: 'done', verdict: 'clean', summary: CLAUDE_CLEAN.summary, gate: { status: 'done', verdict: 'clean', summary: GATE_CLEAN.summary } });
    assert.equal(git(repo, 'show', 'G-1-greet-the-reader:README.md'), 'hello reader\n');
    assert.deepEqual((await fakeLog(env)).map((entry) => entry.prompt.split('\n')[0]), [
      '/implement .software-factory/G-1.md',
      'MR preparation for G-1 on branch G-1-greet-the-reader. The user approved the reviewed change.',
    ]);
    assert.equal((await reviewLog(env)).length, 1);

    // The call: exec, read-only, in the worktree, the schema and output files in the iteration's
    // directory, JSONL, no --model, the prompt on stdin; no SF_* variable.
    const [run] = await codexLog(env);
    const dir = iterationDir(env, 'G-1', 1);
    assert.deepEqual(run!.argv, [
      'exec', '--ephemeral', '--sandbox', 'read-only', '--cd', worktreeOf(env, 'G-1'),
      '--output-schema', join(dir, 'gate-schema.json'), '--output-last-message', join(dir, 'gate-output.json'), '--json', '-',
    ]);
    assert.equal(run!.cwd, worktreeOf(env, 'G-1'));
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'gate-schema.json'), 'utf8')), GATE_SCHEMA);
    assert.ok(!run!.env.some((name) => name.startsWith('SF_')), run!.env.join(','));
    assert.ok(run!.env.includes('HOME') && run!.env.includes('PATH'));
    const job = (await new JobStore(env.state).read('app', 'G-1'))!;
    const base = git(repo, 'rev-parse', 'main').trim();
    assert.match(run!.prompt, /^Code review of iteration 1 of ticket G-1\. You are the second and deciding reviewer/);
    assert.ok(run!.prompt.includes(`against the base commit ${base}.`));
    assert.ok(run!.prompt.includes(`\`git diff ${base}\``));
    assert.ok(run!.prompt.includes('Do not leave the worktree. Do not read credentials: `.env*` files, keys, `~/.ssh`, `~/.config`.'));
    assert.ok(run!.prompt.includes(`<task_file path=".software-factory/G-1.md">\n${task('G-1', 'Greet the reader').trimEnd()}\n</task_file>`));
    assert.ok(run!.prompt.includes('<report>\nReport of iteration 1\n'));
    assert.match(run!.prompt, /<patch>\ndiff --git a\/README\.md b\/README\.md\n[\s\S]*\n\+hello reader\n<\/patch>$/);

    // gate.json, the tokens, the events, sf watch, sf info and the dashboard.
    assert.equal(job.gate_tokens, 1234);
    assert.equal(job.gate_fixes, 0);
    const recorded = await new JobStore(env.state).readGate('app', 'G-1', 1);
    assert.ok(recorded !== undefined && 'verdict' in recorded);
    const { started_at: startedAt, ended_at: endedAt, ...rest } = recorded;
    assert.deepEqual(rest, { reviewer: 'codex', ...GATE_CLEAN, tokens: { input: 1200, cached_input: 300, output: 34 } });
    assert.ok(Date.parse(startedAt) <= Date.parse(endedAt));
    assert.deepEqual((await eventsOf(env, 'G-1')).filter((record) => record.type === 'review').map((record) => [record.reviewer, record.verdict]), [['claude', 'clean'], ['codex', 'clean']]);
    const watched = await runCli(env, ['watch', 'app', 'G-1', '--once']);
    assert.match(watched.stdout, /^\d\d:\d\d:\d\d \[1\] review by codex: clean$/m);
    assert.match((await runCli(env, ['info'])).stdout, new RegExp(`^gate {10}codex codex-cli 0\\.0\\.0-fake \\(${fakeCodex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`, 'm'));
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/G-1', served.dashboard!))).body);
    assert.deepEqual([detail.iterations[0].review.reviewer, detail.iterations[0].gate.reviewer, detail.iterations[0].gate.verdict], ['claude', 'codex', 'clean']);
  } finally {
    await stop(served);
  }
});

test('fix: the gate\'s Fix section, the next iteration, Claude again, the gate again, Clean; --model with SF_CODEX_MODEL', async () => {
  const env = await newEnv('gate-fix', gateEnv({ SF_CODEX_MODEL: 'fake-gpt' }));
  const repo = await newRepo(env, 'gate-fix-repo', false);
  await putTask(env, repo, 'G-2', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2' },
    { write: { '.software-factory/G-2.mr.md': mrText('feat(G-2): Greet the reader') }, text: 'prepared' },
  ]);
  await codexScript(env, [{ output: GATE_FIX }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-2' });
    await waitFor(served, 'G-2', 'ready_for_human_review', 2);
    assert.equal(await taskFile(repo, 'G-2'), `${task('G-2', 'Greet the reader')}\n\n${FIX_SECTION}`);
    assert.equal(git(repo, 'show', 'G-2-greet-the-reader:README.md'), 'hello reader\n');
    assert.deepEqual((await fakeLog(env)).map((entry) => entry.prompt.split('\n')[0]), [
      '/implement .software-factory/G-2.md',
      '/implement .software-factory/G-2.md Fix 1',
      'MR preparation for G-2 on branch G-2-greet-the-reader. The user approved the reviewed change.',
    ]);
    const reviews = await reviewLog(env);
    assert.deepEqual(reviews.map((entry) => entry.prompt.split('\n')[0]), ['Code review of iteration 1 of ticket G-2. You review; you change nothing.', 'Code review of iteration 2 of ticket G-2. You review; you change nothing.']);
    const runs = await codexLog(env);
    assert.equal(runs.length, 2);
    for (const run of runs) {
      assert.equal(option(run.argv, 'model'), 'fake-gpt');
      assert.equal(run.argv.at(-1), '-');
    }
    assert.ok(runs[1]!.prompt.includes(`${FIX_SECTION.trimEnd()}\n</task_file>`));
    assert.ok(runs[1]!.prompt.includes('+hello reader'));
    const jobs = new JobStore(env.state);
    const job = (await jobs.read('app', 'G-2'))!;
    assert.deepEqual([job.fixes, job.gate_fixes, job.gate_tokens], [1, 1, 2200]);
    const first = await jobs.readGate('app', 'G-2', 1);
    assert.ok(first !== undefined && 'verdict' in first);
    assert.deepEqual([first.verdict, first.model, first.items], ['fix', 'fake-gpt', GATE_FIX.items]);
    assert.deepEqual((await eventsOf(env, 'G-2')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.reviewer, record.verdict, record.items]), [
      [1, 'claude', 'clean', 0], [1, 'codex', 'fix', 1], [2, 'claude', 'clean', 0], [2, 'codex', 'clean', 0],
    ]);
    assert.match((await runCli(env, ['watch', 'app', 'G-2', '--once'])).stdout, /^\d\d:\d\d:\d\d \[1\] review by codex: fix \(1 item\)$/m);
  } finally {
    await stop(served);
  }
});

test('SF_GATE_MAX_ROUNDS=1: the second fix of the gate is not applied; needs_human gate_rounds with both summaries', async () => {
  const env = await newEnv('gate-rounds', gateEnv({ SF_GATE_MAX_ROUNDS: '1' }));
  const repo = await newRepo(env, 'gate-rounds-repo', false);
  await putTask(env, repo, 'G-3', 'Rounds');
  await script(env, [{ write: { 'a.txt': '1\n' } }, { write: { 'a.txt': '2\n' } }]);
  await reviewScript(env, [{ output: CLAUDE_CLEAN }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_FIX }, { output: { ...GATE_FIX, summary: 'Still wrong.' } }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-3' });
    const limited = await waitFor(served, 'G-3', 'needs_human', 2);
    assert.equal(limited.error.code, 'gate_rounds');
    assert.match(limited.error.message, /SF_GATE_MAX_ROUNDS \(1\)/);
    assert.ok(limited.error.message.includes(`Claude: ${CLAUDE_CLEAN.summary}`), limited.error.message);
    assert.ok(limited.error.message.includes('Codex: Still wrong.'), limited.error.message);
    assert.deepEqual((await taskFile(repo, 'G-3')).match(/^## Fix \d+$/gm), ['## Fix 1']);
    assert.equal((await new JobStore(env.state).read('app', 'G-3'))!.gate_fixes, 1);
    assert.equal((await fakeLog(env)).length, 2);
  } finally {
    await stop(served);
  }
});

test('SF_GATE_MAX_TOKENS: a run that pushes the job over is not applied, and no run starts once the job is at the limit (gate_budget)', async () => {
  const env = await newEnv('gate-budget', gateEnv({ SF_GATE_MAX_TOKENS: '1000' }));
  const repo = await newRepo(env, 'gate-budget-repo', false);
  await script(env, [{ write: { 'a.txt': '1\n' } }, { write: { 'a.txt': '2\n' } }, { write: { 'b.txt': '1\n' } }]);
  await codexScript(env, [
    { output: GATE_FIX, usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 100 } },
    { output: GATE_CLEAN, usage: { input_tokens: 1400, cached_input_tokens: 1000, output_tokens: 100 } },
  ]);
  const served = await serve(env);
  try {
    // At the limit after its first run: the fix applies, the next gate does not start.
    await putTask(env, repo, 'B-1', 'At the limit');
    await call(served, 'start', { workspace: 'app', ticket: 'B-1' });
    const refused = await waitFor(served, 'B-1', 'needs_human', 2);
    assert.equal(refused.error.code, 'gate_budget');
    assert.match(refused.error.message, /used 1000 tokens, the limit of SF_GATE_MAX_TOKENS \(1000\)/);
    assert.equal((await codexLog(env)).length, 1);
    assert.equal(await exists(join(iterationDir(env, 'B-1', 2), 'gate.json')), false);

    // Over the limit with its first run: the clean verdict is recorded, not applied.
    await putTask(env, repo, 'B-2', 'Over the limit');
    await call(served, 'start', { workspace: 'app', ticket: 'B-2' });
    const over = await waitFor(served, 'B-2', 'needs_human', 1);
    assert.equal(over.error.code, 'gate_budget');
    assert.match(over.error.message, /used 1500 tokens, over the limit/);
    assert.deepEqual(over.review.gate, { status: 'done', verdict: 'clean', summary: GATE_CLEAN.summary });
    assert.equal((await new JobStore(env.state).read('app', 'B-2'))!.gate_tokens, 1500);
  } finally {
    await stop(served);
  }
});

test('a failed gate (a non-zero exit, no output, an invalid output, an invalid verdict, an error event, a timeout) is needs_human gate_failed', async () => {
  const env = await newEnv('gate-failed', gateEnv({ SF_MAX_JOBS: '6', SF_GATE_TIMEOUT_MS: '2000' }));
  const repo = await newRepo(env, 'gate-failed-repo', false);
  const cases = [
    { run: { exitCode: 3 }, message: /^Codex exited with code 3: fake codex: something went wrong$/ },
    { run: { noOutput: true }, message: /^Codex wrote no output\.$/ },
    { run: { invalid: true }, message: /^Codex returned output that is not JSON: not json at all$/ },
    { run: { output: { ...GATE_CLEAN, verdict: 'maybe' } }, message: /^Codex returned an invalid verdict: verdict: / },
    { run: { error: 'stream disconnected' }, message: /^Codex reported an error: stream disconnected$/ },
    { run: { delayMs: 10_000 }, message: /^Codex timed out after 2000 ms and was stopped \(SIGTERM\)\.$/ },
  ];
  await script(env, cases.map((_, index) => ({ write: { [`f${index}.txt`]: 'f\n' } })));
  await codexScript(env, cases.map((entry) => entry.run));
  const served = await serve(env);
  try {
    for (const [index, entry] of cases.entries()) {
      const ticket = `F-${index + 1}`;
      await putTask(env, repo, ticket, `Fail ${index + 1}`);
      await call(served, 'start', { workspace: 'app', ticket });
      const failed = await waitFor(served, ticket, 'needs_human', 1);
      assert.equal(failed.error.code, 'gate_failed', JSON.stringify(failed.error));
      assert.match(failed.error.message, entry.message);
      assert.deepEqual(failed.review.gate, { status: 'failed', summary: failed.error.message });
      const recorded = await new JobStore(env.state).readGate('app', ticket, 1);
      assert.ok(recorded !== undefined && 'error' in recorded);
      assert.equal(recorded.error, failed.error.message);
      assert.doesNotMatch(await taskFile(repo, ticket), /## Fix/);
    }
    const timedOut = (await codexLog(env)).at(-1)!;
    assert.equal(alive(timedOut.pid), false);
    assert.match((await runCli(env, ['watch', 'app', 'F-2', '--once'])).stdout, /\[1\] review by codex failed: Codex wrote no output\.$/m);
  } finally {
    await stop(served);
  }
});

test('abort during a gate run kills Codex; its outcome is never applied', async () => {
  const env = await newEnv('gate-abort', gateEnv());
  const repo = await newRepo(env, 'gate-abort-repo', false);
  await putTask(env, repo, 'A-1', 'Abort');
  await script(env, [{ write: { 'a.txt': 'a\n' } }]);
  await codexScript(env, [{ delayMs: 4000, output: GATE_FIX }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'A-1' });
    await until('the gate to run', async () => (await exists(join(env.home, 'fake-codex.log'))));
    const waiting = await call(served, 'check', { workspace: 'app', ticket: 'A-1' });
    assert.deepEqual([waiting.state, waiting.review.gate], ['awaiting_review', { status: 'running' }]);
    const [run] = await codexLog(env);
    assert.equal(alive(run!.pid), true);
    const aborted = await runCli(env, ['abort', 'app', 'A-1']);
    assert.equal(aborted.code, 0, aborted.stderr);
    await until('Codex to end', async () => !alive(run!.pid));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const checked = await call(served, 'check', { workspace: 'app', ticket: 'A-1' });
    assert.equal(checked.state, 'aborted');
    assert.equal(await new JobStore(env.state).readGate('app', 'A-1', 1), undefined);
    assert.equal(await exists(join(iterationDir(env, 'A-1', 1), 'gate-output.json')), false);
    assert.equal((await eventsOf(env, 'A-1')).filter((record) => record.reviewer === 'codex').length, 0);
  } finally {
    await stop(served);
  }
});

test('sf serve stopped during a gate run kills Codex; the next sf serve starts the gate of the clean iteration again', async () => {
  const env = await newEnv('gate-restart', gateEnv());
  const repo = await newRepo(env, 'gate-restart-repo', false);
  await putTask(env, repo, 'R-1', 'Restart');
  await script(env, [
    { write: { 'a.txt': 'a\n' } },
    { write: { '.software-factory/R-1.mr.md': mrText('feat(R-1): Restart') }, text: 'prepared' },
  ]);
  await codexScript(env, [{ delayMs: 10_000 }, { output: GATE_CLEAN }]);
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-1' });
    await until('the gate to run', async () => (await exists(join(env.home, 'fake-codex.log'))));
  } finally {
    await stop(served);
  }
  const [first] = await codexLog(env);
  await until('Codex to end with sf serve', async () => !alive(first!.pid));
  served = await serve(env);
  try {
    await waitFor(served, 'R-1', 'ready_for_human_review', 1);
    assert.equal((await codexLog(env)).length, 2);
    assert.equal((await reviewLog(env)).length, 1);
  } finally {
    await stop(served);
  }
});

test('gate off: SF_GATE=off, and SF_CODEX pointing at nothing (one line at sf serve), let the Claude verdict decide as in SF-038', async () => {
  for (const [name, extra, line, info] of [
    ['gate-off', { SF_GATE: 'off' }, undefined, /^gate {10}off \(SF_GATE=off\)$/m],
    ['gate-missing', { SF_CODEX: '/nonexistent/codex' }, /^gate: off \(SF_CODEX \/nonexistent\/codex is not an executable file\); the Claude review decides$/m, /^gate {10}off \(SF_CODEX \/nonexistent\/codex is not an executable file\)$/m],
  ] as const) {
    const env = await newEnv(name, gateEnv(extra));
    const repo = await newRepo(env, `${name}-repo`, false);
    await putTask(env, repo, 'O-1', 'Off');
    await script(env, [{ write: { 'o.txt': 'o\n' } }, { write: { '.software-factory/O-1.mr.md': mrText('feat(O-1): Off') }, text: 'prepared' }]);
    const served = await serve(env);
    try {
      if (line === undefined) {
        assert.doesNotMatch(served.output, /^gate:/m);
      } else {
        assert.match(served.output, line);
      }
      await call(served, 'start', { workspace: 'app', ticket: 'O-1' });
      const ready = await waitFor(served, 'O-1', 'ready_for_human_review', 1);
      assert.deepEqual(ready.review, { status: 'done', verdict: 'clean', summary: 'Looks right.' });
      assert.equal(await exists(join(env.home, 'fake-codex.log')), false);
      assert.equal(await exists(join(iterationDir(env, 'O-1', 1), 'gate.json')), false);
      assert.match((await runCli(env, ['info'])).stdout, info);
    } finally {
      await stop(served);
    }
  }
});
