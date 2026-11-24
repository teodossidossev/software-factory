// End-to-end tests of the Codex gate before Clean (SF-039) with the real sf serve, the fake Claude
// (its --json-schema runs are the Claude reviews, clean unless scripted) and the fake Codex
// (test/support/fake-codex.ts, scripted by $HOME/fake-codex.json), both in a joint round: a clean
// round runs Clean, a fix goes through Claude and the gate again, the argv, prompt and environment of the call, the round
// limit, the token ceiling, failures, abort and serve restart during a gate, the gate off, and the
// strict schema.
// The round limit, the token ceiling, failures, abort and serve restart during a gate, the gate
// off, sf accept and runGate on its own are test/gate-limits.test.ts's (SF-152: one file ran near
// run-tests' per-file limit).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateFullPaths, loadConfig, sensitivePaths } from '../src/config.js';
import type { FactoryError } from '../src/errors.js';
import { GATE_OUTPUT_FILE, GATE_SCHEMA, gateArgs } from '../src/gate.js';
import { WITHHELD } from '../src/redact.js';
import { JobStore } from '../src/jobs.js';
import { mrNotes } from '../src/mr-notes.js';
import { writeTask } from '../src/task-file.js';
import { fetchRaw } from './support/dashboard-client.js';
import { bwrapLog, call, codexLog, codexScript, fakeCodex, fakeLog, git, newEnv, newRepo, ownReviewMethod, putRules, putTask, reviewLog, reviewScript, runCli, script, serve, stop, task, waitFor } from './support/harness.js';
import { byRound, CLAUDE_CLEAN, eventsOf, exists, FIX_SECTION, GATE_CLEAN, GATE_FIX, gateEnv, iterationDir, mrText, option, taskFile, withoutTime, worktreeOf } from './support/gate.js';

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
  assert.deepEqual(item.required, ['path', 'problem', 'expected', 'severity', 'reopens', 'caused_by', 'outside_delta']);
  assert.deepEqual(item.properties.outside_delta?.enum, ['', 'broken_by_delta', 'asked_by_user']);
  assert.deepEqual(item.properties.severity?.enum, ['blocker', 'major', 'nit']);
  assert.deepEqual(gateArgs({ cwd: '/w', dir: '/d', model: 'm' }).slice(-3), ['--model', 'm', '-']);
});

test('gateArgs (SF-065): one --image per image before --cd, never right before the final "-"; without images the argv is as before', () => {
  const plain = gateArgs({ cwd: '/w', dir: '/d', model: undefined });
  assert.deepEqual(gateArgs({ cwd: '/w', dir: '/d', model: undefined, images: [] }), plain);
  assert.deepEqual(plain, [
    'exec', '--ephemeral', '--sandbox', 'read-only', '--disable', 'memories', '-c', 'memories.use_memories=false',
    '--cd', '/w', '--output-schema', '/d/gate-schema.json', '--output-last-message', '/d/gate-output.json', '--json', '-',
  ]);
  assert.deepEqual(gateArgs({ cwd: '/w', dir: '/d', model: undefined, images: ['/j/attachments/1.png', '/j/attachments/2.gif'] }), [
    'exec', '--ephemeral', '--sandbox', 'read-only', '--disable', 'memories', '-c', 'memories.use_memories=false',
    '--image', '/j/attachments/1.png', '--image', '/j/attachments/2.gif',
    '--cd', '/w', '--output-schema', '/d/gate-schema.json', '--output-last-message', '/d/gate-output.json', '--json', '-',
  ]);
});

test('the gate level settings (SF-092): SF_GATE_LEVEL auto (default, also empty) or full, anything else invalid_config; SF_GATE_FULL_PATHS as SF_SENSITIVE_PATHS', () => {
  const base = { HOME: '/nonexistent-home', SF_GATE: 'off' };
  assert.deepEqual([loadConfig(base).gateLevel, loadConfig(base).gateFullPaths], ['auto', []]);
  assert.equal(loadConfig({ ...base, SF_GATE_LEVEL: '' }).gateLevel, 'auto');
  assert.equal(loadConfig({ ...base, SF_GATE_LEVEL: 'auto' }).gateLevel, 'auto');
  assert.equal(loadConfig({ ...base, SF_GATE_LEVEL: 'full' }).gateLevel, 'full');
  for (const value of ['light', 'none', 'FULL', 'off']) {
    assert.throws(() => loadConfig({ ...base, SF_GATE_LEVEL: value }), (error: FactoryError) => error.code === 'invalid_config' && error.message.includes(`"${value}"`), value);
  }
  const globs = ' lib/billing/** , ,src/pay*.ts ';
  assert.deepEqual(gateFullPaths({ SF_GATE_FULL_PATHS: globs }), ['lib/billing/**', 'src/pay*.ts']);
  assert.deepEqual(gateFullPaths({ SF_GATE_FULL_PATHS: globs }), sensitivePaths({ SF_SENSITIVE_PATHS: globs }));
  assert.deepEqual(loadConfig({ ...base, SF_GATE_FULL_PATHS: globs }).gateFullPaths, ['lib/billing/**', 'src/pay*.ts']);
  assert.deepEqual(gateFullPaths({}), []);
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
    // SF-125: Codex ran inside bwrap (the harness's fake, first on PATH) with the wrapper of the
    // job's denials, then "--", the codex executable and its argv; its raw output file is gone.
    const [wrapped] = await bwrapLog(env);
    const cut = wrapped!.argv.indexOf('--');
    assert.deepEqual(wrapped!.argv.slice(cut), ['--', fakeCodex, ...run!.argv]);
    assert.deepEqual(wrapped!.argv.slice(0, 2), ['--die-with-parent', '--unshare-pid']);
    assert.deepEqual(wrapped!.argv.slice(cut - 6, cut), ['--bind', join(env.home, '.codex'), join(env.home, '.codex'), '--bind', dir, dir]);
    assert.equal(await exists(join(dir, GATE_OUTPUT_FILE)), false);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'gate-schema.json'), 'utf8')), GATE_SCHEMA);
    assert.ok(!run!.env.some((name) => name.startsWith('SF_')), run!.env.join(','));
    assert.ok(run!.env.includes('HOME') && run!.env.includes('PATH'));
    const job = (await new JobStore(env.state).read('app', 'G-1'))!;
    const base = git(repo, 'rev-parse', 'main').trim();
    assert.match(run!.prompt, /^Code review of iteration 1 of ticket G-1\. You are one of two independent reviewers of this iteration; either's blocker or major item makes a fix\./);
    assert.ok(run!.prompt.includes(`against the base commit ${base}.`));
    assert.ok(run!.prompt.includes(`\`git diff ${base}\``));
    assert.ok(run!.prompt.includes('Do not leave the worktree. Do not read credentials: `.env*` files, keys, `~/.ssh`, `~/.config`.'));
    assert.ok(run!.prompt.includes(`<task_file path=".software-factory/G-1.md">\n${task('G-1', 'Greet the reader').trimEnd()}\n</task_file>`));
    assert.ok(run!.prompt.includes('<report>\nReport of iteration 1\n'));
    assert.match(run!.prompt, /<patch>\ndiff --git a\/README\.md b\/README\.md\n[\s\S]*\n\+hello reader\n<\/patch>$/);
    // The review method: the package's own code-review skill, without its front matter.
    assert.ok(run!.prompt.includes('\n<review_method>\nTwo-axis review of the diff'), run!.prompt);
    // SF-059: a repository without rule files: no block.
    assert.ok(!run!.prompt.includes('<rules>') && !run!.prompt.includes('rule violation'));

    // gate.json, the tokens, the events, sf watch, sf info and the dashboard.
    assert.equal(job.gate_tokens, 1234);
    assert.equal(job.gate_fixes, 0);
    const recorded = await new JobStore(env.state).readGate('app', 'G-1', 1);
    assert.ok(recorded !== undefined && 'verdict' in recorded);
    const { started_at: startedAt, ended_at: endedAt, ...rest } = recorded;
    assert.deepEqual(rest, { reviewer: 'codex', ...GATE_CLEAN, tokens: { input: 1200, cached_input: 300, output: 34 }, review_method: await ownReviewMethod(env, 'G-1') });
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

test('coding rules (SF-059): the gate prompt gives the job\'s <rules> block before the Task file and asks that a rule violation name the rule\'s file', async () => {
  const env = await newEnv('gate-rules', gateEnv());
  const repo = await newRepo(env, 'gate-rules-repo', false);
  const block = await putRules(env, repo);
  await putTask(env, repo, 'G-9', 'Follow the rules');
  await script(env, [
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 1' },
    { write: { '.software-factory/G-9.mr.md': mrText('feat(G-9): Follow the rules') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-9' });
    await waitFor(served, 'G-9', 'ready_for_human_review', 1);
    const [run] = await codexLog(env);
    assert.ok(run!.prompt.includes(`\n${block}\n\n<task_file path=".software-factory/G-9.md">\n`), run!.prompt);
    assert.match(run!.prompt, /\n- Review the change against the Task file [^\n]*\n- A review item that is a rule violation names the rule's file \(and heading\) in `problem`\.\n/);
    assert.ok((await reviewLog(env))[0]!.prompt.includes(`\n${block}\n\n<task_file`));
  } finally {
    await stop(served);
  }
});

test('the live events and the failure records hold no environment value, key or content from outside the worktree (SF-045)', async () => {
  const secret = 'leaky-secret-value-0123456789';
  // A short secret counts as much as a long one.
  const pin = 'q7z';
  // The gate's own (SF-125: it gets OPENAI_* and CODEX_* variables, not the review's ANTHROPIC_*).
  const codexSecret = 'leaky-codex-value-9876543210';
  const codexPin = 'w4k';
  const env = await newEnv('gate-leak', gateEnv({ ANTHROPIC_FAKE_SECRET: secret, ANTHROPIC_FAKE_PIN: pin, OPENAI_FAKE_SECRET: codexSecret, OPENAI_FAKE_PIN: codexPin, SF_MAX_JOBS: '4' }));
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
    for (const leaked of [secret, pin, codexSecret, codexPin, 'fake-codex-config-model', 'fake-codex-auth-repeated', 'fake-access-token-value', 'fake-refresh-token-value', 'fake-codex-auth-file-content']) {
      assert.ok(!raw.includes(leaked), leaked);
    }
    const watched = (await runCli(env, ['watch', 'app', 'L-1', '--once'])).stdout;
    for (const leaked of [secret, pin, codexSecret, codexPin, 'fake-codex-config-model', 'fake-codex-auth-repeated']) {
      assert.ok(!watched.includes(leaked), leaked);
    }
    const lines = withoutTime(watched);
    for (const expected of [
      `[1] review | Read(${join(env.home, '.codex', 'auth.json')})`,
      '[1] review | The secret is [redacted:ANTHROPIC_FAKE_SECRET], the pin [redacted:ANTHROPIC_FAKE_PIN].',
      '[1] codex | exit 0',
      `[1] codex |   ${WITHHELD}`,
      '[1] codex | The secret is [redacted:OPENAI_FAKE_SECRET], the pin [redacted:OPENAI_FAKE_PIN].',
      // The prose that quotes ~/.codex, and the prose after the read that repeats it.
      `[1] review | ${WITHHELD}`,
      `[1] codex | ${WITHHELD}`,
    ]) {
      assert.ok(lines.includes(expected), `${expected}\n${lines.join('\n')}`);
    }
    const events = await eventsOf(env, 'L-1');
    const results = events.filter((record) => record.type === 'review_message' && (record.message as { type: string }).type === 'user');
    // The second is the read of ~/.codex/auth.json; the third the answer's StructuredOutput call,
    // which the fake makes once the review has a hook (the file-tool guard, SF-123), after that read.
    assert.deepEqual(results.map((record) => ((record.message as { message: { content: Array<{ content: unknown }> } }).message.content[0]!.content)), ['the file', WITHHELD, WITHHELD]);
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

test('fix: the joint round\'s Fix section, the next iteration, Claude and the gate again, Clean; --model with SF_CODEX_MODEL', async () => {
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
    assert.deepEqual(byRound((await eventsOf(env, 'G-2')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.reviewer, record.verdict, record.items])), [
      [1, 'claude', 'clean', 0], [1, 'codex', 'fix', 1], [2, 'claude', 'clean', 0], [2, 'codex', 'clean', 0],
    ]);
    assert.match((await runCli(env, ['watch', 'app', 'G-2', '--once'])).stdout, /^\d\d:\d\d:\d\d \[1\] review by codex: fix \(1 item\)$/m);
  } finally {
    await stop(served);
  }
});

// SF-051: the severity of review items.
const nit = (path: string, problem: string, expected = 'Nicer.') => ({ path, problem, expected, severity: 'nit' });

test('severity: one major among nits is the round\'s Fix section with the nits as optional; a Claude fix and a gate fix with nits only go to MR preparation, and the nits of both reach the MR text', async () => {
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
      '## Fix 1', '', 'Review by Claude: Claude found it right.', 'Review by Codex: The greeting is wrong.', '',
      '1. [R1, major] `README.md`: It greets the world. Expected: It greets the reader. (raised by Codex)', '',
      'Nits (optional):',
      '2. [R2, nit] `a.txt`: A narrower variant. Expected: Nicer. (raised by Codex)', '',
    ].join('\n')}`);
    const jobs = new JobStore(env.state);
    const job = (await jobs.read('app', 'G-10'))!;
    assert.deepEqual([job.fixes, job.gate_fixes], [1, 1]);
    assert.equal((await codexLog(env)).length, 2);
    // Recorded as given; the events carry the verdict acted on.
    const gate = await jobs.readGate('app', 'G-10', 2);
    assert.ok(gate !== undefined && 'verdict' in gate);
    assert.equal(gate.verdict, 'fix');
    assert.deepEqual(byRound((await eventsOf(env, 'G-10')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.reviewer, record.verdict, record.effective])), [
      [1, 'claude', 'clean', undefined], [1, 'codex', 'fix', undefined], [2, 'claude', 'fix', 'clean'], [2, 'codex', 'fix', 'clean'],
    ]);
    assert.match((await runCli(env, ['watch', 'app', 'G-10', '--once'])).stdout, /^\d\d:\d\d:\d\d \[2\] review by codex: fix \(2 items\), acted on as clean$/m);
    // The nits of iteration 2 from both reviewers, deduplicated by path and problem, in the Merge
    // request screen's notes, never in the MR text.
    const mr = (await jobs.readMrText('app', 'G-10'))!;
    assert.ok(!mr.includes('### Nits not applied') && !mr.includes('[nit]'), mr);
    assert.equal(await mrNotes(jobs, (await jobs.read('app', 'G-10'))!), [
      '### Nits not applied',
      '- [nit] `README.md`: No capital. Expected: Nicer.',
      '- [nit] `a.txt`: A narrower variant. Expected: Nicer.',
    ].join('\n'));
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
      '## Fix 1', '', 'Review by Claude: package.json is needed.', 'Review by Codex: Nits only.', '',
      '1. [R1, major] `package.json`: Undeclared sensitive path. Expected: Remove it, or justify it in the Report. (raised by Codex)', '',
      'Nits (optional):',
      '2. [R2, nit] `package.json`: A narrower variant of the accepted risk. Expected: Nicer. (raised by Codex)', '',
    ].join('\n')));
    assert.equal((await new JobStore(env.state).read('app', 'G-11'))!.gate_fixes, 1);
    assert.deepEqual(byRound((await eventsOf(env, 'G-11')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.reviewer, record.verdict, record.effective])), [
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
      '## Fix 1', '', 'Review by Claude: notes.txt is cited by the README.', 'Review by Codex: Codex found it right.', '',
      "1. [R1, major] `notes.txt`: Outside the Task's scope. Expected: Remove the change, or justify it in the Report. (raised by Codex)", '',
    ].join('\n')));
    const [first] = await codexLog(env);
    assert.ok(first!.prompt.includes("<marked_paths>\n- outside the Task's scope: notes.txt\n</marked_paths>"), first!.prompt);
    assert.equal((await new JobStore(env.state).read('app', 'G-12'))!.gate_fixes, 1);
    assert.deepEqual(byRound((await eventsOf(env, 'G-12')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.reviewer, record.verdict, record.effective])), [
      [1, 'claude', 'clean', undefined], [1, 'codex', 'clean', 'fix'], [2, 'claude', 'clean', undefined], [2, 'codex', 'clean', undefined],
    ]);
    assert.equal(git(repo, 'show', '--name-only', '--format=', 'G-12-greet-the-reader').trim(), 'README.md\nnotes.txt');
  } finally {
    await stop(served);
  }
});

test('a missing review skill (SF_REVIEW_SKILL): both prompts as without a method, and review_method none in review.json and gate.json', async () => {
  const env = await newEnv('gate-no-skill', gateEnv({ SF_REVIEW_SKILL: join(tmpdir(), 'sf-no-such-skill', 'SKILL.md') }));
  const repo = await newRepo(env, 'gate-no-skill-repo', false);
  await putTask(env, repo, 'G-20', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 1' },
    { write: { '.software-factory/G-20.mr.md': mrText('feat(G-20): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-20' });
    await waitFor(served, 'G-20', 'ready_for_human_review', 1);
    const prompts = [...(await reviewLog(env)), ...(await codexLog(env))].map((entry) => entry.prompt);
    assert.equal(prompts.length, 2);
    for (const prompt of prompts) {
      assert.ok(!prompt.includes('<review_method>') && !prompt.includes('`Spec:`, `Standards:` or `Decision:`'), prompt);
    }
    const jobs = new JobStore(env.state);
    assert.equal((await jobs.readReview('app', 'G-20', 1) as { review_method?: unknown }).review_method, 'none');
    assert.equal((await jobs.readGate('app', 'G-20', 1) as { review_method?: unknown }).review_method, 'none');
  } finally {
    await stop(served);
  }
});
