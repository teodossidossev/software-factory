// End-to-end tests of the Codex gate before Clean (SF-039) with the real sf serve, the fake Claude
// (its --json-schema runs are the Claude reviews, clean unless scripted) and the fake Codex
// (test/support/fake-codex.ts, scripted by $HOME/fake-codex.json): a clean gate runs Clean, a fix
// goes through Claude and the gate again, the argv, prompt and environment of the call, the round
// limit, the token ceiling, failures, abort and serve restart during a gate, the gate off, and the
// strict schema.
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { GATE_SCHEMA, gateArgs } from '../src/gate.js';
import { WITHHELD } from '../src/redact.js';
import { JobStore } from '../src/jobs.js';
import { writeTask } from '../src/task-file.js';
import { fetchRaw } from './support/dashboard-client.js';
import {
  call, codexLog, codexScript, type Env, fakeCodex, fakeLog, git, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, task, waitFor,
} from './support/harness.js';

const CLAUDE_CLEAN = { verdict: 'clean', summary: 'Claude found it right.', items: [], accepted_sensitive: [] };
const GATE_FIX = {
  verdict: 'fix',
  summary: 'The greeting\nis wrong.',
  items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.', severity: 'major' }],
  accepted_sensitive: [],
};
const GATE_CLEAN = { verdict: 'clean', summary: 'Codex found it right.', items: [], accepted_sensitive: [] };
const FIX_SECTION = '## Fix 1\n\nReview by Codex: The greeting is wrong.\n\n1. [R1, major] `README.md`: It greets the world. Expected: It greets the reader.\n';

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

// The lines of sf watch without their time (HH:MM:SS and a space).
const withoutTime = (stdout: string): string[] => stdout.split('\n').map((line) => line.slice('00:00:00 '.length));

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
  // Every item has a severity (SF-051), required in the strict form.
  const item = (GATE_SCHEMA.properties as { items: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } }).items.items;
  assert.deepEqual(item.required, ['path', 'problem', 'expected', 'severity', 'reopens', 'caused_by']);
  assert.deepEqual(item.properties.severity?.enum, ['blocker', 'major', 'nit']);
  assert.deepEqual(gateArgs({ cwd: '/w', dir: '/d', model: 'm' }).slice(-3), ['--model', 'm', '-']);
});

test('the gate runs without the user\'s Codex memories: the feature off and no memories injected', () => {
  const args = gateArgs({ cwd: '/w', dir: '/d', model: undefined });
  const pairs = args.slice(0, -1).map((arg, index) => `${arg} ${args[index + 1]}`);
  assert.ok(pairs.includes('--disable memories'), args.join(' '));
  assert.ok(pairs.includes('-c memories.use_memories=false'), args.join(' '));
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
  await codexScript(env, [{ output: GATE_CLEAN, usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 34 }, bigMessageBytes: 20 * 1024 }]);
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

    // The call: exec, read-only, without the user's memories, in the worktree, the schema and output
    // files in the iteration's directory, JSONL, no --model, the prompt on stdin; no SF_* variable.
    const [run] = await codexLog(env);
    const dir = iterationDir(env, 'G-1', 1);
    assert.deepEqual(run!.argv, [
      'exec', '--ephemeral', '--sandbox', 'read-only', '--disable', 'memories', '-c', 'memories.use_memories=false', '--cd', worktreeOf(env, 'G-1'),
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
    // The gate live (SF-045): every Codex event that parses, in order, the big one cut; then the
    // verdict line. Nothing but the event itself is logged.
    const live = (await eventsOf(env, 'G-1')).filter((record) => record.type === 'gate_event');
    const kind = (record: Record<string, unknown>): string => {
      const event = record.event as { type: string; item?: { type: string } };
      return event.item !== undefined ? `${event.type} ${event.item.type}` : event.type;
    };
    assert.deepEqual(live.map(kind), [
      'thread.started', 'turn.started', 'item.completed reasoning', 'item.started command_execution', 'item.completed command_execution',
      'item.completed agent_message', 'item.completed agent_message', 'turn.completed',
    ]);
    assert.deepEqual(live.map((record) => record.truncated ?? false), [false, false, false, false, false, true, false, false]);
    assert.ok(live.every((record) => record.reviewer === 'codex' && record.iteration === 1));
    assert.ok(live.every((record) => Object.keys(record).filter((key) => key !== 'truncated').sort().join() === 'event,iteration,reviewer,ts,type'));
    const big = JSON.stringify(live[5]!.event);
    assert.ok(Buffer.byteLength(big) <= 16 * 1024 && big.includes('Big bbb'), String(Buffer.byteLength(big)));
    const codexLines = withoutTime(watched.stdout).filter((line) => /^\[1\] (codex \||review by codex)/.test(line)).map((line) => line.slice('[1] '.length));
    assert.equal(codexLines.length, 9, codexLines.join('\n'));
    assert.deepEqual([...codexLines.slice(0, 5), codexLines[5]!.replace(/b{20,}…/, 'b…'), ...codexLines.slice(6)], [
      'codex | reasoning: **Reading the diff**',
      'codex | $ bash -lc \'git status\'',
      'codex | exit 0',
      'codex |   On branch fake',
      'codex |   nothing to commit',
      'codex | Big b… (cut)',
      'codex | Reviewed.',
      'codex | turn completed (1200 in, 34 out tokens)',
      'review by codex: clean',
    ]);
    assert.match((await runCli(env, ['info'])).stdout, new RegExp(`^gate {10}codex codex-cli 0\\.0\\.0-fake \\(${fakeCodex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`, 'm'));
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/G-1', served.dashboard!))).body);
    assert.deepEqual([detail.iterations[0].review.reviewer, detail.iterations[0].gate.reviewer, detail.iterations[0].gate.verdict], ['claude', 'codex', 'clean']);
  } finally {
    await stop(served);
  }
});

test('the live events and the failure records hold no environment value, key or content from outside the worktree (SF-045)', async () => {
  const secret = 'leaky-secret-value-0123456789';
  // A short secret counts as much as a long one.
  const pin = 'q7z';
  const env = await newEnv('gate-leak', gateEnv({ ANTHROPIC_FAKE_SECRET: secret, ANTHROPIC_FAKE_PIN: pin, SF_MAX_JOBS: '4' }));
  const repo = await newRepo(env, 'gate-leak-repo', false);
  await putTask(env, repo, 'L-1', 'Greet the reader');
  await putTask(env, repo, 'L-2', 'Greet the writer');
  await putTask(env, repo, 'L-3', 'Greet the editor');
  await putTask(env, repo, 'L-4', 'Greet the printer');
  // A literal no pattern knows, in a failure that quotes ~/.codex.
  const literal = 'fake-literal-auth-content';
  await script(env, [
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 1' },
    { write: { '.software-factory/L-1.mr.md': mrText('feat(L-1): Greet the reader') }, text: 'prepared' },
    { write: { 'WRITER.md': 'hello writer\n' }, text: 'Report of iteration 1' },
    { write: { 'EDITOR.md': 'hello editor\n' }, text: 'Report of iteration 1' },
    { write: { 'PRINTER.md': 'hello printer\n' }, text: 'Report of iteration 1' },
  ]);
  await reviewScript(env, [
    { output: CLAUDE_CLEAN, leak: true }, { output: CLAUDE_CLEAN }, { output: CLAUDE_CLEAN },
    { subtype: 'error_during_execution', errors: [`~/.codex/config.toml: ${literal}`] },
  ]);
  await codexScript(env, [
    { output: GATE_CLEAN, leak: true }, { error: `quota exceeded for ${secret}` },
    { error: `${join(env.home, '.codex', 'auth.json')}: ${literal}` },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    await waitFor(served, 'L-1', 'ready_for_human_review', 1);
    const raw = await readFile(join(env.state, 'jobs', 'app', 'L-1', 'events.jsonl'), 'utf8');
    for (const leaked of [secret, pin, 'fake-codex-config-model', 'fake-codex-auth-repeated', 'fake-access-token-value', 'fake-refresh-token-value', 'fake-codex-auth-file-content']) {
      assert.ok(!raw.includes(leaked), leaked);
    }
    const watched = (await runCli(env, ['watch', 'app', 'L-1', '--once'])).stdout;
    for (const leaked of [secret, pin, 'fake-codex-config-model', 'fake-codex-auth-repeated']) {
      assert.ok(!watched.includes(leaked), leaked);
    }
    const lines = withoutTime(watched);
    for (const expected of [
      `[1] review | Read(${join(env.home, '.codex', 'auth.json')})`,
      '[1] review | The secret is [redacted:ANTHROPIC_FAKE_SECRET], the pin [redacted:ANTHROPIC_FAKE_PIN].',
      '[1] codex | exit 0',
      `[1] codex |   ${WITHHELD}`,
      '[1] codex | The secret is [redacted:ANTHROPIC_FAKE_SECRET], the pin [redacted:ANTHROPIC_FAKE_PIN].',
      // The prose that quotes ~/.codex, and the prose after the read that repeats it.
      `[1] review | ${WITHHELD}`,
      `[1] codex | ${WITHHELD}`,
    ]) {
      assert.ok(lines.includes(expected), `${expected}\n${lines.join('\n')}`);
    }
    const events = await eventsOf(env, 'L-1');
    const results = events.filter((record) => record.type === 'review_message' && (record.message as { type: string }).type === 'user');
    assert.deepEqual(results.map((record) => ((record.message as { message: { content: Array<{ content: unknown }> } }).message.content[0]!.content)), ['the file', WITHHELD]);
    const outputs = events.filter((record) => record.type === 'gate_event').map((record) => (record.event as { item?: { id?: string; aggregated_output?: string } }).item)
      .filter((item) => item?.id?.startsWith('leak_') === true && item.aggregated_output !== undefined).map((item) => item!.aggregated_output);
    assert.deepEqual(outputs, [WITHHELD, WITHHELD]);

    // A failed gate: Codex's error is redacted in gate.json, the event and the job's error.
    await call(served, 'start', { workspace: 'app', ticket: 'L-2' });
    const failed = await waitFor(served, 'L-2', 'needs_human', 1);
    assert.equal(failed.error.code, 'gate_failed');
    const message = 'Codex reported an error: quota exceeded for [redacted:ANTHROPIC_FAKE_SECRET]';
    assert.equal(failed.error.message, message);
    const recorded = await new JobStore(env.state).readGate('app', 'L-2', 1);
    assert.ok(recorded !== undefined && 'error' in recorded && recorded.error === message);
    const rawFailed = await readFile(join(env.state, 'jobs', 'app', 'L-2', 'events.jsonl'), 'utf8');
    assert.ok(!rawFailed.includes(secret));
    assert.ok(rawFailed.includes('quota exceeded for [redacted:ANTHROPIC_FAKE_SECRET]'));

    // A failed gate and a failed review whose error quotes ~/.codex: the detail is withheld in the
    // live event, gate.json or review.json, the review_failed line, sf watch and the job's error.
    const jobs = new JobStore(env.state);
    for (const [ticket, code, expected] of [
      ['L-3', 'gate_failed', `Codex reported an error: ${WITHHELD}`],
      ['L-4', 'review_failed', `The review ended with error_during_execution: ${WITHHELD}`],
    ] as const) {
      await call(served, 'start', { workspace: 'app', ticket });
      const stopped = await waitFor(served, ticket, 'needs_human', 1);
      assert.deepEqual([stopped.error.code, stopped.error.message], [code, expected]);
      const record = ticket === 'L-3' ? await jobs.readGate('app', ticket, 1) : await jobs.readReview('app', ticket, 1);
      assert.ok(record !== undefined && 'error' in record && record.error === expected, JSON.stringify(record));
      const rawEvents = await readFile(join(env.state, 'jobs', 'app', ticket, 'events.jsonl'), 'utf8');
      assert.ok(!rawEvents.includes(literal), ticket);
      assert.ok((await eventsOf(env, ticket)).some((event) => event.type === 'review_failed' && event.error === expected), ticket);
      const watchedFailure = (await runCli(env, ['watch', 'app', ticket, '--once'])).stdout;
      assert.ok(!watchedFailure.includes(literal), ticket);
      assert.ok(withoutTime(watchedFailure).includes(`[1] review by ${ticket === 'L-3' ? 'codex' : 'claude'} failed: ${expected}`), watchedFailure);
    }
  } finally {
    await stop(served);
  }
});

test('after a read of ~/.codex marks the run, no free-text field of any later Codex event or Claude message reaches events.jsonl, the records, sf watch or the job error (SF-045)', async () => {
  // A literal no pattern knows, in every free-text field of every event and message type.
  const literal = 'walk-literal-zq81';
  const env = await newEnv('gate-walk', gateEnv());
  const repo = await newRepo(env, 'gate-walk-repo', false);
  await putTask(env, repo, 'W-1', 'Walk the gate');
  await putTask(env, repo, 'W-2', 'Walk the review');
  await script(env, [
    { write: { 'GATE.md': 'gate\n' }, text: 'Report of iteration 1' },
    { write: { 'REVIEW.md': 'review\n' }, text: 'Report of iteration 1' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_CLEAN }, { walk: literal }]);
  await codexScript(env, [{ walk: literal }]);
  const served = await serve(env);
  try {
    const jobs = new JobStore(env.state);
    for (const [ticket, code, reviewer, expected] of [
      ['W-1', 'gate_failed', 'codex', `Codex reported an error: ${WITHHELD}`],
      ['W-2', 'review_failed', 'claude', `The review ended with error_during_execution: ${WITHHELD}`],
    ] as const) {
      await call(served, 'start', { workspace: 'app', ticket });
      const stopped = await waitFor(served, ticket, 'needs_human', 1);
      assert.deepEqual([stopped.error.code, stopped.error.message], [code, expected], ticket);
      const dir = join(env.state, 'jobs', 'app', ticket);
      // events.jsonl (every live event, the review_failed line), the record, job.json.
      const raw = await readFile(join(dir, 'events.jsonl'), 'utf8');
      assert.ok(!raw.includes(literal), `${ticket} events.jsonl`);
      const record = ticket === 'W-1' ? await jobs.readGate('app', ticket, 1) : await jobs.readReview('app', ticket, 1);
      assert.ok(record !== undefined && 'error' in record && record.error === expected, JSON.stringify(record));
      assert.ok(!(await readFile(join(dir, 'job.json'), 'utf8')).includes(literal), `${ticket} job.json`);
      // The walk reached events.jsonl: the live events of the run after the read are there, withheld.
      const live = (await eventsOf(env, ticket)).filter((event) => event.type === (ticket === 'W-1' ? 'gate_event' : 'review_message'));
      assert.ok(live.length >= (ticket === 'W-1' ? 16 : 6), `${ticket}: ${live.length} live events`);
      assert.ok(JSON.stringify(live).includes(WITHHELD), ticket);
      // sf watch: no literal; the command lines, exit codes, token counts and the verdict line stay.
      const watched = (await runCli(env, ['watch', 'app', ticket, '--once'])).stdout;
      assert.ok(!watched.includes(literal), `${ticket} sf watch:\n${watched}`);
      const lines = withoutTime(watched);
      assert.ok(lines.includes(`[1] review by ${reviewer} failed: ${expected}`), watched);
      if (ticket === 'W-1') {
        for (const kept of ["[1] codex | $ bash -lc 'cat ~/.codex/auth.json'", '[1] codex | $ cat README.md', '[1] codex | exit 0', `[1] codex | error: ${WITHHELD}`, `[1] codex | ${WITHHELD}`]) {
          assert.ok(lines.includes(kept), `${kept}\n${watched}`);
        }
      } else {
        assert.ok(lines.includes(`[1] review | ${WITHHELD}`), watched);
      }
    }
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
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2\n\n| R1 | fixed | The reader is greeted. |' },
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
    assert.deepEqual([first.verdict, first.model, first.items], ['fix', 'fake-gpt', GATE_FIX.items.map((item) => ({ ...item, reopens: '', caused_by: '' }))]);
    assert.deepEqual((await eventsOf(env, 'G-2')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.reviewer, record.verdict, record.items]), [
      [1, 'claude', 'clean', 0], [1, 'codex', 'fix', 1], [2, 'claude', 'clean', 0], [2, 'codex', 'clean', 0],
    ]);
    assert.match((await runCli(env, ['watch', 'app', 'G-2', '--once'])).stdout, /^\d\d:\d\d:\d\d \[1\] review by codex: fix \(1 item\)$/m);
  } finally {
    await stop(served);
  }
});

// SF-051: the severity of review items.
const nit = (path: string, problem: string, expected = 'Nicer.') => ({ path, problem, expected, severity: 'nit' });

test('severity: one major among nits is the gate\'s Fix section with the nits as optional; a Claude fix with nits only goes to the gate, a gate fix with nits only to MR preparation, and the nits of both reach the MR text', async () => {
  const env = await newEnv('gate-nits', gateEnv());
  const repo = await newRepo(env, 'gate-nits-repo', false);
  await putTask(env, repo, 'G-10', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2\n\n| R1 | fixed | The reader is greeted. |' },
    { write: { '.software-factory/G-10.mr.md': mrText('feat(G-10): Greet the reader') }, text: 'prepared' },
  ]);
  const claudeNit = nit('README.md', 'No capital.');
  await reviewScript(env, [
    { output: { ...CLAUDE_CLEAN, items: [claudeNit] } },
    { output: { verdict: 'fix', summary: 'Nits only.', items: [claudeNit], accepted_sensitive: [] } },
  ]);
  await codexScript(env, [
    { output: { ...GATE_FIX, items: [nit('a.txt', 'A narrower variant.'), ...GATE_FIX.items] } },
    { output: { verdict: 'fix', summary: 'Nits only.', items: [nit('README.md', 'No  capital.', 'Other.'), nit('a.txt', 'A narrower variant.')], accepted_sensitive: [] } },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-10' });
    await waitFor(served, 'G-10', 'ready_for_human_review', 2);
    assert.equal(await taskFile(repo, 'G-10'), `${task('G-10', 'Greet the reader')}\n\n${[
      '## Fix 1', '', 'Review by Codex: The greeting is wrong.', '',
      '1. [R1, major] `README.md`: It greets the world. Expected: It greets the reader.', '',
      'Nits (optional):',
      '2. [R2, nit] `a.txt`: A narrower variant. Expected: Nicer.', '',
    ].join('\n')}`);
    const jobs = new JobStore(env.state);
    const job = (await jobs.read('app', 'G-10'))!;
    assert.deepEqual([job.fixes, job.gate_fixes], [1, 1]);
    assert.equal((await codexLog(env)).length, 2);
    // Recorded as given; the events carry the verdict acted on.
    const gate = await jobs.readGate('app', 'G-10', 2);
    assert.ok(gate !== undefined && 'verdict' in gate);
    assert.equal(gate.verdict, 'fix');
    assert.deepEqual((await eventsOf(env, 'G-10')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.reviewer, record.verdict, record.effective]), [
      [1, 'claude', 'clean', undefined], [1, 'codex', 'fix', undefined], [2, 'claude', 'fix', 'clean'], [2, 'codex', 'fix', 'clean'],
    ]);
    assert.match((await runCli(env, ['watch', 'app', 'G-10', '--once'])).stdout, /^\d\d:\d\d:\d\d \[2\] review by codex: fix \(2 items\), acted on as clean$/m);
    // The nits of iteration 2 from both reviewers, deduplicated by path and problem.
    const mr = (await jobs.readMrText('app', 'G-10'))!;
    assert.ok(mr.includes([
      '## Special things to note',
      '### Nits not applied',
      '- [nit] `README.md`: No capital. Expected: Nicer.',
      '- [nit] `a.txt`: A narrower variant. Expected: Nicer.',
      '',
      '## Change outline',
    ].join('\n')), mr);
  } finally {
    await stop(served);
  }
});

test('severity: a gate fix with nits only is still a fix when it leaves an undeclared sensitive path unaccepted', async () => {
  const env = await newEnv('gate-nits-sensitive', gateEnv());
  const repo = await newRepo(env, 'gate-nits-sensitive-repo', false);
  await putTask(env, repo, 'G-11', 'Add a script');
  await script(env, [
    { write: { 'package.json': '{}\n' }, text: 'iteration 1' },
    { text: 'package.json is needed.' },
    { write: { '.software-factory/G-11.mr.md': mrText('feat(G-11): Add a script') }, text: 'prepared' },
  ]);
  const accepted = { ...CLAUDE_CLEAN, summary: 'package.json is needed.', accepted_sensitive: ['package.json'] };
  await reviewScript(env, [{ output: accepted }, { output: accepted }]);
  await codexScript(env, [
    { output: { verdict: 'fix', summary: 'Nits only.', items: [nit('package.json', 'A narrower variant of the accepted risk.')], accepted_sensitive: [] } },
    { output: { ...GATE_CLEAN, accepted_sensitive: ['package.json'] } },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-11' });
    await waitFor(served, 'G-11', 'ready_for_human_review', 2);
    assert.ok((await taskFile(repo, 'G-11')).endsWith([
      '## Fix 1', '', 'Review by Codex: Nits only.', '',
      '1. [R1, major] `package.json`: Undeclared sensitive path. Expected: Remove it, or justify it in the Report.', '',
      'Nits (optional):',
      '2. [R2, nit] `package.json`: A narrower variant of the accepted risk. Expected: Nicer.', '',
    ].join('\n')));
    assert.equal((await new JobStore(env.state).read('app', 'G-11'))!.gate_fixes, 1);
    assert.deepEqual((await eventsOf(env, 'G-11')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.reviewer, record.verdict, record.effective]), [
      [1, 'claude', 'clean', undefined], [1, 'codex', 'fix', undefined], [2, 'claude', 'clean', undefined], [2, 'codex', 'clean', undefined],
    ]);
  } finally {
    await stop(served);
  }
});

test("scope (SF-053): a gate that does not accept a path outside the Task's scope makes it a major fix item; accepted by both, Clean passes it on; the gate's prompt marks it", async () => {
  const env = await newEnv('gate-scope', gateEnv());
  const repo = await newRepo(env, 'gate-scope-repo', false);
  const content = '---\nticket: G-12\ntitle: Greet the reader\nbase: main\nscope: README.md\n---\n\n# G-12: Greet the reader\n\nChange the README.\n';
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, 'G-12', content, new JobStore(env.state));
  await script(env, [
    { write: { 'README.md': 'hello reader\n', 'notes.txt': 'n\n' }, text: 'iteration 1' },
    { text: 'notes.txt holds the wording the README cites.' },
    { write: { '.software-factory/G-12.mr.md': mrText('feat(G-12): Greet the reader') }, text: 'prepared' },
  ]);
  const accepted = { ...CLAUDE_CLEAN, summary: 'notes.txt is cited by the README.', accepted_sensitive: ['notes.txt'] };
  await reviewScript(env, [{ output: accepted }, { output: accepted }]);
  await codexScript(env, [{ output: GATE_CLEAN }, { output: { ...GATE_CLEAN, accepted_sensitive: ['notes.txt'] } }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-12' });
    await waitFor(served, 'G-12', 'ready_for_human_review', 2);
    assert.ok((await taskFile(repo, 'G-12')).endsWith([
      '## Fix 1', '', 'Review by Codex: Codex found it right.', '',
      "1. [R1, major] `notes.txt`: Outside the Task's scope. Expected: Remove the change, or justify it in the Report.", '',
    ].join('\n')));
    const [first] = await codexLog(env);
    assert.ok(first!.prompt.includes("<marked_paths>\n- outside the Task's scope: notes.txt\n</marked_paths>"), first!.prompt);
    assert.equal((await new JobStore(env.state).read('app', 'G-12'))!.gate_fixes, 1);
    assert.deepEqual((await eventsOf(env, 'G-12')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.reviewer, record.verdict, record.effective]), [
      [1, 'claude', 'clean', undefined], [1, 'codex', 'clean', 'fix'], [2, 'claude', 'clean', undefined], [2, 'codex', 'clean', undefined],
    ]);
    assert.equal(git(repo, 'show', '--name-only', '--format=', 'G-12-greet-the-reader').trim(), 'README.md\nnotes.txt');
  } finally {
    await stop(served);
  }
});

test('SF_GATE_MAX_ROUNDS=1: the second fix of the gate is not applied; needs_human gate_rounds with both summaries', async () => {
  const env = await newEnv('gate-rounds', gateEnv({ SF_GATE_MAX_ROUNDS: '1' }));
  const repo = await newRepo(env, 'gate-rounds-repo', false);
  await putTask(env, repo, 'G-3', 'Rounds');
  await script(env, [{ write: { 'a.txt': '1\n' } }, { write: { 'a.txt': '2\n' }, text: '| R1 | fixed | Done. |' }]);
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
  await script(env, [{ write: { 'a.txt': '1\n' } }, { write: { 'a.txt': '2\n' }, text: '| R1 | fixed | Done. |' }, { write: { 'b.txt': '1\n' } }]);
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

test('sf serve stopped during a gate run leaves the runner and Codex to finish, and a restarted one leaves them alone (SF-042); a runner killed during the gate: the next sf serve ends its Codex and runs the gate again', async () => {
  const env = await newEnv('gate-restart', gateEnv());
  const repo = await newRepo(env, 'gate-restart-repo', false);
  await putTask(env, repo, 'R-1', 'Restart');
  await putTask(env, repo, 'R-2', 'Killed');
  await script(env, [
    { write: { 'a.txt': 'a\n' } },
    { write: { '.software-factory/R-1.mr.md': mrText('feat(R-1): Restart') }, text: 'prepared' },
    { write: { 'b.txt': 'b\n' } },
    { write: { '.software-factory/R-2.mr.md': mrText('feat(R-2): Killed') }, text: 'prepared' },
  ]);
  await codexScript(env, [{ delayMs: 5_000, output: GATE_CLEAN }, { delayMs: 30_000 }, { output: GATE_CLEAN }]);
  const jobs = new JobStore(env.state);
  const lock = (ticket: string): string => join(env.state, 'jobs', 'app', ticket, 'runner.pid');

  // sf serve stops while the gate of R-1 runs: the runner goes on, Clean prepares the branch.
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-1' });
    await until('the gate to run', async () => (await exists(join(env.home, 'fake-codex.log'))));
  } finally {
    await stop(served);
  }
  const [first] = await codexLog(env);
  assert.ok(alive(first!.pid), 'Codex outlives sf serve');
  // A restarted sf serve leaves the review of the live runner alone: no second gate run.
  served = await serve(env);
  try {
    assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'R-1' })).state, 'awaiting_review');
    await waitFor(served, 'R-1', 'ready_for_human_review', 1);
  } finally {
    await stop(served);
  }
  assert.equal((await codexLog(env)).length, 1);
  assert.equal((await jobs.readGate('app', 'R-1', 1) as { verdict?: string }).verdict, 'clean');
  await until('the runner of R-1 to end', async () => !(await exists(lock('R-1'))));

  // The runner of R-2 is killed during its gate, Codex with it: the next sf serve starts the gate again.
  served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-2' });
    await until('the gate of R-2 to run', async () => (await codexLog(env)).length === 2);
  } finally {
    await stop(served);
  }
  const runner = Number((await readFile(lock('R-2'), 'utf8')).trim().split(' ')[0]);
  const second = (await codexLog(env))[1]!;
  process.kill(runner, 'SIGKILL');
  await until('the runner to end', async () => !alive(runner));
  assert.ok(alive(second.pid), 'Codex is left behind by the killed runner');
  assert.equal((await jobs.read('app', 'R-2'))!.state, 'awaiting_review');
  served = await serve(env);
  try {
    await until('the Codex of the killed runner to end', async () => !alive(second.pid));
    await waitFor(served, 'R-2', 'ready_for_human_review', 1);
    assert.equal((await codexLog(env)).length, 3);
    assert.equal((await reviewLog(env)).length, 2);
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

test('sf accept (SF-047): after gate_rounds with a clean Claude review the job goes on to MR preparation; the override is recorded; refused otherwise', async () => {
  const env = await newEnv('gate-accept', gateEnv({ SF_GATE_MAX_ROUNDS: '1' }));
  const repo = await newRepo(env, 'gate-accept-repo', false);
  await putTask(env, repo, 'G-8', 'Accept over the gate');
  const stillWrong = { ...GATE_FIX, summary: 'Still wrong.', items: [{ path: 'a.txt', problem: 'A narrower variant.', expected: 'Even narrower.', severity: 'major' }] };
  await script(env, [
    { write: { 'a.txt': '1\n' } },
    { write: { 'a.txt': '2\n' }, text: '| R1 | fixed | Done. |' },
    { write: { '.software-factory/G-8.mr.md': mrText('feat(G-8): Accept over the gate') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_CLEAN }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_FIX }, { output: stillWrong }]);
  const served = await serve(env);
  try {
    // Refused while the job is not stopped by the gate.
    await call(served, 'start', { workspace: 'app', ticket: 'G-8' });
    const limited = await waitFor(served, 'G-8', 'needs_human', 2);
    assert.equal(limited.error.code, 'gate_rounds');

    // Refused without a clean Claude review of the last iteration: nothing recorded, nothing moves.
    const reviewPath = join(iterationDir(env, 'G-8', 2), 'review.json');
    const review = await readFile(reviewPath, 'utf8');
    await writeFile(reviewPath, JSON.stringify({ ...JSON.parse(review), verdict: 'fix', items: [{ path: 'a.txt', problem: 'Wrong.', expected: 'Right.', severity: 'major' }] }));
    const notClean = await runCli(env, ['accept', 'app', 'G-8']);
    assert.equal(notClean.code, 1);
    assert.match(notClean.stderr, /^sf: sf accept needs a clean Claude review of the last iteration \(2\); it says fix/);
    assert.equal(await exists(join(iterationDir(env, 'G-8', 2), 'gate-override.json')), false);
    assert.equal((await new JobStore(env.state).read('app', 'G-8'))!.state, 'needs_human');
    await writeFile(reviewPath, review);

    const accepted = await runCli(env, ['accept', 'app', 'G-8']);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.match(accepted.stdout, /^state: preparing_mr$/m);
    const ready = await waitFor(served, 'G-8', 'ready_for_human_review', 2);
    assert.equal(git(repo, 'show', `${ready.branch}:a.txt`), '2\n');

    const override = JSON.parse(await readFile(join(iterationDir(env, 'G-8', 2), 'gate-override.json'), 'utf8'));
    assert.match(override.at, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual({ ...override, at: undefined }, { at: undefined, code: 'gate_rounds', unapplied: stillWrong.items.map((item) => ({ ...item, reopens: '', caused_by: '' })) });
    const events = await eventsOf(env, 'G-8');
    const index = events.findIndex((record) => record.type === 'gate_overridden');
    assert.deepEqual({ ...events[index], ts: undefined }, { ts: undefined, iteration: 2, type: 'gate_overridden', code: 'gate_rounds', unapplied: 1 });
    // Recorded before the job moved on to MR preparation.
    assert.deepEqual((events[index + 1]!.state as { from: string; to: string }), { from: 'needs_human', to: 'preparing_mr' });
    assert.match((await runCli(env, ['watch', 'app', 'G-8', '--once'])).stdout, /^\d\d:\d\d:\d\d \[2\] gate overridden by the user \(gate_rounds\): 1 Codex item not applied$/m);

    // The dashboard: the override in the iteration and in the state history.
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/G-8', served.dashboard!))).body);
    assert.equal(detail.gate, true);
    assert.deepEqual(detail.iterations[1].gate_override, override);
    assert.deepEqual(detail.history.filter((entry: Record<string, unknown>) => entry.event === 'gate_overridden').map(({ ts: _ts, ...entry }: Record<string, unknown>) => entry), [
      { event: 'gate_overridden', code: 'gate_rounds', unapplied: 1 },
    ]);
    assert.deepEqual([detail.job.fixes, detail.job.gate_fixes], [1, 1]);

    // Refused in any other state.
    const again = await runCli(env, ['accept', 'app', 'G-8']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /^sf: sf accept needs needs_human after the gate or the ledger stopped the job \(gate_rounds, gate_budget, gate_failed, review_churn, review_disputed\); the job is ready_for_human_review/);
    assert.equal((await runCli(env, ['accept', 'app'])).code, 2);
  } finally {
    await stop(served);
  }
});

test('sf accept (SF-047): a failed gate is accepted with its error as what goes unapplied; another needs_human code is refused', async () => {
  const env = await newEnv('gate-accept-failed', gateEnv());
  const repo = await newRepo(env, 'gate-accept-failed-repo', false);
  await putTask(env, repo, 'G-9', 'Accept a failed gate');
  await script(env, [
    { write: { 'a.txt': '1\n' } },
    { write: { '.software-factory/G-9.mr.md': mrText('feat(G-9): Accept a failed gate') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ exitCode: 3 }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-9' });
    const failed = await waitFor(served, 'G-9', 'needs_human', 1);
    assert.equal(failed.error.code, 'gate_failed');
    const store = new JobStore(env.state);
    // Another code of needs_human is refused.
    const job = (await store.read('app', 'G-9'))!;
    await store.write({ ...job, error: { code: 'iteration_limit', message: 'x' } });
    const refused = await runCli(env, ['accept', 'app', 'G-9']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^sf: sf accept needs needs_human.*the job is needs_human \(iteration_limit\)/);
    await store.write(job);

    assert.equal((await runCli(env, ['accept', 'app', 'G-9'])).code, 0);
    await waitFor(served, 'G-9', 'ready_for_human_review', 1);
    const override = JSON.parse(await readFile(join(iterationDir(env, 'G-9', 1), 'gate-override.json'), 'utf8'));
    assert.equal(override.code, 'gate_failed');
    assert.equal(typeof override.unapplied, 'string');
    assert.equal(override.unapplied, failed.error.message);
  } finally {
    await stop(served);
  }
});
