// The Task check's Codex part: who wrote the Task text decides whether Codex checks it (the owner,
// then the history's writes), its prompt (the Claude check's with the tools sentence adapted), its
// strict schema, the record's combined verdict and counts, the setting, the redaction of its free
// text, the runner shared with the gate; then end to end with the fake Claude and the fake Codex:
// sf check-task with Codex beside the Claude check, in the same worktree and in the gate's wrapper;
// last the readers outside the dashboard: task_check, the notification, the queue's plan check and
// the ticket's history.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { CheckChain } from '../src/builds-on.js';
import { taskCheckCodexSetting } from '../src/config.js';
import { FactoryError } from '../src/errors.js';
import { type CodexTask, GATE_TASK, gateArgs, type GateOptions, runCodex, runGate } from '../src/gate.js';
import { JobStore } from '../src/jobs.js';
import { taskCheckNotification } from '../src/notify.js';
import { checkPrompt } from '../src/prompts.js';
import { Redactor } from '../src/redact.js';
import type { PathDenials } from '../src/sandbox-denials.js';
import {
  CHECK_SCHEMA, type CheckFinding, type CheckOutput, type CheckRecord, checkSummary, recordCounts, recordVerdict, taskSha256,
} from '../src/task-check.js';
import { planCheck } from '../src/task-check-auto.js';
import {
  CHECK_TOOLS_SENTENCE, type CodexCheck, CODEX_CHECK_OUTPUT_FILE, CODEX_CHECK_SCHEMA_FILE, CODEX_TOOLS_SENTENCE, codexCheckDue, codexCheckPrompt, codexCheckSchema, withTaskFolderHidden,
} from '../src/task-check-codex.js';
import { writeTask } from '../src/task-file.js';
import { within } from '../src/test-command.js';
import { TicketHistory } from '../src/ticket-history.js';
import { bwrapLog, call, codexLog, codexScript, type Env, fakeCodex, newEnv, newRepo, reviewLog, reviewScript, runCli, serve, stop, temp } from './support/harness.js';

const OUTSIDE = 'it was written outside the factory\'s tools (an editor or a session\'s file tools)';

const finding = (severity: CheckFinding['severity'], kind: CheckFinding['kind'] = 'decision', where = '## Behaviour', problem = `A ${severity} problem.`): CheckFinding =>
  ({ kind, severity, where, problem, expected: 'Say which.' });

const output = (findings: CheckFinding[], verdict: CheckOutput['verdict']): CheckOutput =>
  ({ paraphrase: 'The Task greets the reader.', findings, files: [{ path: 'README.md', action: 'modify' }], verdict });

function codexPart(out: CheckOutput | null): CodexCheck {
  return {
    reason: OUTSIDE, status: out === null ? 'failed' : 'checked', output: out, error: out === null ? 'Codex timed out after 1 ms and was stopped.' : null,
    model: null, tokens: { input: 1000, cached_input: 200, output: 100 }, started_at: '2026-11-20T10:00:00.000Z', ended_at: '2026-11-20T10:01:00.000Z',
  };
}

function record(claude: CheckOutput | null, codex?: CodexCheck): CheckRecord {
  return {
    workspace: 'app', ticket: 'C-1', sha256: 'a'.repeat(64), commit: 'c'.repeat(40), status: claude === null ? 'failed' : 'checked', output: claude,
    error: claude === null ? 'The check ended with error_max_turns: limit' : null, model: 'fake-model', cost_usd: 0.01,
    started_at: '2026-11-20T10:00:00.000Z', ended_at: '2026-11-20T10:01:00.000Z', ...(codex !== undefined ? { codex } : {}),
  };
}

function taskText(ticket: string, body = 'Greet the reader in README.md.'): string {
  return `---\nticket: ${ticket}\ntitle: Greet the reader\nbase: main\n---\n\n# ${ticket}: Greet the reader\n\n${body}\n`;
}

test('CC-1: codexCheckDue: the owner first, then the last write of the text in the history; queued_by_itself is no write; an unreadable history is none', async () => {
  const state = join(temp, 'due-state');
  const task = taskText('T-1');
  const sha = taskSha256(task);
  const other = taskSha256('another text');
  const historyFile = join(state, 'tickets', 'app', 'T-1', 'history.jsonl');
  const ownerFile = join(state, 'requests', 'app', 'T-1.owner');
  await mkdir(dirname(historyFile), { recursive: true });
  await mkdir(dirname(ownerFile), { recursive: true });
  const history = async (...events: Array<[string, string, string]>): Promise<void> => {
    await writeFile(historyFile, events.map(([kind, by, sha256], index) => `${JSON.stringify({ ts: `2026-11-20T10:0${index}:00.000Z`, kind, by, sha256 })}\n`).join(''));
  };
  const due = (): Promise<unknown> => codexCheckDue(state, 'app', 'T-1', task);

  // No owner file, no history: written outside the factory's tools.
  assert.deepEqual(await due(), { due: true, reason: OUTSIDE });
  // written by write_task: not due, also with a later queued_by_itself of the same text.
  await history(['created', 'you', other], ['written', 'context_owner', sha], ['queued_by_itself', 'factory', sha]);
  assert.deepEqual(await due(), { due: false });
  await writeFile(ownerFile, 'chatgpt\n');
  assert.deepEqual(await due(), { due: false });
  // The owner Claude Code: due whatever the history says.
  await writeFile(ownerFile, 'claude_code\n');
  assert.deepEqual(await due(), { due: true, reason: 'the ticket\'s planner is Claude Code' });
  await writeFile(ownerFile, 'chatgpt');
  // The last write of the text decides.
  await history(['written', 'context_owner', sha], ['edited', 'you', sha]);
  assert.deepEqual(await due(), { due: true, reason: 'you wrote it on the ticket\'s page' });
  await history(['created', 'you', sha]);
  assert.deepEqual(await due(), { due: true, reason: 'you wrote it on the ticket\'s page' });
  await history(['written', 'context_owner', sha], ['fix_added', 'factory', sha]);
  assert.deepEqual(await due(), { due: true, reason: 'the factory added a Fix section to it' });
  // Writes of other texts do not count: none of this text.
  await history(['written', 'context_owner', other], ['queued_by_itself', 'factory', sha]);
  assert.deepEqual(await due(), { due: true, reason: OUTSIDE });
  // A history that cannot be read (a directory in its place) is none; it never throws.
  const broken = join(temp, 'due-broken');
  await mkdir(join(broken, 'tickets', 'app', 'T-1', 'history.jsonl'), { recursive: true });
  assert.deepEqual(await codexCheckDue(broken, 'app', 'T-1', task), { due: true, reason: OUTSIDE });
  assert.deepEqual(await codexCheckDue(broken, 'app', 'bad ticket', task), { due: true, reason: OUTSIDE });
});

test('CC-2: the Codex prompt is the Claude check\'s with the second line\'s tools sentence replaced; a quote of it elsewhere stays', () => {
  const task = taskText('T-2');
  const commit = `1a2b3c4d5e6f${'0'.repeat(28)}`;
  const chain: CheckChain = [{ ticket: 'T-1', path: '.software-factory/T-1.md', text: taskText('T-1') }];
  for (const prompt of [
    checkPrompt('T-2', task, '<rules>\nr\n</rules>', '<skill name="s">\nx\n</skill>'),
    checkPrompt('T-2', task, '', '', undefined, chain),
    checkPrompt('T-2', task, '', '', undefined, chain, { ticket: 'T-1', commit }),
  ]) {
    assert.ok(prompt.split('\n')[1]!.includes(CHECK_TOOLS_SENTENCE));
    const codex = codexCheckPrompt(prompt);
    assert.ok(codex.includes(CODEX_TOOLS_SENTENCE));
    assert.ok(!codex.includes(CHECK_TOOLS_SENTENCE), codex);
    const lines = codex.split('\n');
    lines[1] = lines[1]!.replace(CODEX_TOOLS_SENTENCE, CHECK_TOOLS_SENTENCE);
    assert.equal(lines.join('\n'), prompt);
  }
  // A Task that quotes the sentence keeps the quote.
  const quoting = taskText('T-3', `The check says: "${CHECK_TOOLS_SENTENCE}"`);
  const prompt = checkPrompt('T-3', quoting);
  const codex = codexCheckPrompt(prompt);
  assert.ok(!codex.split('\n')[1]!.includes(CHECK_TOOLS_SENTENCE));
  assert.ok(codex.includes(`<task_file path=".software-factory/T-3.md">\n${quoting.trimEnd()}\n</task_file>`));
  assert.equal(codex.split(CHECK_TOOLS_SENTENCE).length, 2);
});

test('CC-3: the Codex schema is the check\'s, strict, without $schema or minLength, its properties in the check\'s order', () => {
  const schema = codexCheckSchema(CHECK_SCHEMA);
  assert.ok(JSON.stringify(CHECK_SCHEMA).includes('"minLength"'));
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') {
      return;
    }
    const object = node as Record<string, unknown>;
    assert.equal(object.$schema, undefined);
    assert.equal(object.minLength, undefined);
    if (object.type === 'object') {
      assert.equal(object.additionalProperties, false);
      assert.deepEqual(object.required, Object.keys(object.properties as object));
    }
    Object.values(object).forEach(walk);
  };
  walk(schema);
  assert.deepEqual(Object.keys(schema.properties as object), ['paraphrase', 'findings', 'files', 'verdict']);
});

test('CC-4 and CC-12: recordVerdict and recordCounts combine the Claude check and its Codex part; a finding both carry counts once', () => {
  const ready = output([finding('nit')], 'ready');
  const notReady = output([finding('blocker', 'contradiction', 'README.md:1'), finding('major')], 'not_ready');
  // Claude ready, Codex not ready: not ready, the counts summed.
  const both = record(ready, codexPart(notReady));
  assert.equal(recordVerdict(both), 'not_ready');
  assert.deepEqual(recordCounts(both), { blocker: 1, major: 1, nit: 1 });
  const summary = checkSummary(both, both.sha256);
  assert.deepEqual([summary.state, summary.blockers, summary.majors, summary.nits, summary.start_note], ['not_ready', 1, 1, 1, 'not ready: 1 blocker, 1 major']);
  // Claude ready, Codex failed: ready.
  assert.equal(recordVerdict(record(ready, codexPart(null))), 'ready');
  assert.deepEqual(recordCounts(record(ready, codexPart(null))), { blocker: 0, major: 0, nit: 1 });
  // Claude not ready, Codex ready: not ready.
  assert.equal(recordVerdict(record(notReady, codexPart(ready))), 'not_ready');
  // Claude failed: failed, whatever Codex says.
  assert.equal(recordVerdict(record(null, codexPart(ready))), 'failed');
  // No codex key: today's.
  assert.equal(recordVerdict(record(ready)), 'ready');
  assert.equal(recordVerdict(record(notReady)), 'not_ready');
  assert.deepEqual(recordCounts(record(notReady)), { blocker: 1, major: 1, nit: 0 });
  assert.deepEqual(checkSummary(undefined, undefined).blockers, 0);

  // CC-12: the same scope: finding in both outputs counts once; one that differs in its problem counts.
  const scope: CheckFinding = { kind: 'missing', severity: 'major', where: 'scope:', problem: 'src/a.ts (modify) is a file the change needs, and scope: does not name it.', expected: 'Add src/a.ts to scope:, or say why it does not change.' };
  const shared = record(output([scope], 'not_ready'), codexPart(output([scope, finding('major', 'missing', 'scope:')], 'not_ready')));
  assert.deepEqual(recordCounts(shared), { blocker: 0, major: 2, nit: 0 });
});

test('CC-9: SF_TASK_CHECK_CODEX is auto or off, off by default; anything else is invalid_config', () => {
  assert.equal(taskCheckCodexSetting({}), 'off');
  assert.equal(taskCheckCodexSetting({ SF_TASK_CHECK_CODEX: '' }), 'off');
  assert.equal(taskCheckCodexSetting({ SF_TASK_CHECK_CODEX: 'auto' }), 'auto');
  assert.equal(taskCheckCodexSetting({ SF_TASK_CHECK_CODEX: 'off' }), 'off');
  assert.throws(() => taskCheckCodexSetting({ SF_TASK_CHECK_CODEX: 'on' }), (error: unknown) =>
    error instanceof FactoryError && error.code === 'invalid_config' && error.message === 'SF_TASK_CHECK_CODEX must be auto or off, got "on".');
});

test('CC-5 (unit): withTaskFolderHidden puts the work checkout\'s .software-factory last in the sandbox\'s denyRead, everything else as given', () => {
  const denials = { tools: ['Read(//x/**)'], sandbox: { denyRead: ['/a', '/b'], denyWrite: ['/c'] }, claudeTmp: { denyRead: [], allowRead: [], allowWrite: [] }, kept: ['/k'], hooks: undefined } as unknown as PathDenials;
  const hidden = withTaskFolderHidden(denials, '/work/repo');
  assert.deepEqual(hidden.sandbox.denyRead, ['/a', '/b', '/work/repo/.software-factory']);
  assert.deepEqual({ ...hidden, sandbox: { ...hidden.sandbox, denyRead: denials.sandbox.denyRead } }, denials);
  assert.deepEqual(denials.sandbox.denyRead, ['/a', '/b']);
});

test('CC-11 (unit): Redactor.output of a check output redacts the paraphrase and each finding\'s where, problem and expected; nothing else', () => {
  const secret = 'check-secret-value-307';
  const redactor = new Redactor({ cwd: '/work', env: { OPENAI_FAKE_SECRET: secret } });
  const leaked: CheckOutput = {
    paraphrase: `It reads ${secret}.`,
    findings: [{ kind: 'missing', severity: 'major', where: `src/${secret}.ts:1`, problem: `Holds ${secret}.`, expected: `Drop ${secret}.` }],
    files: [{ path: 'README.md', action: 'modify' }],
    verdict: 'not_ready',
  };
  assert.deepEqual(redactor.output(leaked), {
    paraphrase: 'It reads [redacted].',
    findings: [{ kind: 'missing', severity: 'major', where: 'src/[redacted].ts:1', problem: 'Holds [redacted].', expected: 'Drop [redacted].' }],
    files: [{ path: 'README.md', action: 'modify' }],
    verdict: 'not_ready',
  });
  // A setting's public value stays: SF_TASK_CHECK_CODEX is no secret.
  assert.equal(new Redactor({ cwd: '/work', env: { SF_TASK_CHECK_CODEX: 'off' } }).failure('turned off'), 'turned off');
});

test('CC-10 (unit): runGate is runCodex with GATE_TASK; another task names its own noun and files', async () => {
  const dir = join(temp, 'run-codex');
  await mkdir(dir, { recursive: true });
  const options: GateOptions = {
    codexPath: '/nonexistent/codex', cwd: dir, dir, model: undefined, timeoutMs: 30_000, signal: new AbortController().signal,
    wrapper: ['--die-with-parent'], bwrapPath: undefined, platform: 'linux',
  };
  const strip = (outcome: { startedAt: string; endedAt: string }): unknown => ({ ...outcome, startedAt: '', endedAt: '' });
  assert.deepEqual(strip(await runCodex('p', options, GATE_TASK)), strip(await runGate('p', options)));
  const check: CodexTask<unknown> = { noun: 'Codex check', schema: {}, schemaFile: CODEX_CHECK_SCHEMA_FILE, outputFile: CODEX_CHECK_OUTPUT_FILE, parse: (json) => ({ ok: true, output: json }) };
  const refused = await runCodex('p', options, check);
  assert.ok(!refused.ok && refused.message.startsWith('The Codex check did not start: it runs only inside bubblewrap, and there is no bwrap on PATH'), JSON.stringify(refused));
  const args = { cwd: dir, dir, model: undefined };
  assert.deepEqual(gateArgs(args), gateArgs(args, GATE_TASK));
  assert.deepEqual(gateArgs(args, check), gateArgs(args).map((arg) => arg.replace('gate-schema.json', CODEX_CHECK_SCHEMA_FILE).replace('gate-output.json', CODEX_CHECK_OUTPUT_FILE)));
});

// A workspace with a Task file written outside the factory's tools (no history), the Codex check
// on and the gate the fake Codex, unless extra says otherwise.
async function codexEnv(name: string, ticket: string, extra: Record<string, string> = {}): Promise<{ env: Env; repo: string; content: string }> {
  const env = await newEnv(name, { SF_REVIEW_MODEL: 'fake-checker', SF_TASK_CHECK_CODEX: 'auto', SF_GATE: 'codex', SF_CODEX: fakeCodex, ...extra });
  const repo = await newRepo(env, `${name}-repo`, false);
  const content = taskText(ticket);
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, ticket, content, new JobStore(env.state));
  return { env, repo, content };
}

const CLAUDE: CheckOutput = output([finding('nit', 'unclear', '## Title')], 'ready');
const CODEX: CheckOutput = output([{ kind: 'contradiction', severity: 'major', where: 'README.md:1', problem: 'The Task says the README is empty; it says hello.', expected: 'Describe the README as it is.' }], 'ready');

const stored = async (env: Env, ticket: string, content: string): Promise<CheckRecord> =>
  JSON.parse(await readFile(join(env.state, 'checks', 'app', ticket, `${taskSha256(content).slice(0, 16)}.json`), 'utf8')) as CheckRecord;

test('CC-5: sf check-task with the Codex check: Codex runs once beside the Claude check, in its worktree, inside the gate\'s wrapper with .software-factory hidden; the record holds both', async () => {
  const { env, repo, content } = await codexEnv('codex-cli', 'X-1');
  await reviewScript(env, [{ output: CLAUDE }]);
  await codexScript(env, [{ output: CODEX }]);
  const run = await runCli(env, ['check-task', 'app', 'X-1']);
  assert.equal(run.code, 0, run.stderr);

  const [claude] = await reviewLog(env);
  const runs = await codexLog(env);
  assert.equal(runs.length, 1);
  const [codex] = runs;
  const folder = dirname(claude!.cwd);
  assert.deepEqual(codex!.argv, [
    'exec', '--ephemeral', '--sandbox', 'read-only', '--disable', 'memories', '-c', 'memories.use_memories=false', '--cd', claude!.cwd,
    '--output-schema', join(folder, 'codex', CODEX_CHECK_SCHEMA_FILE), '--output-last-message', join(folder, 'codex', CODEX_CHECK_OUTPUT_FILE), '--json', '-',
  ]);
  assert.equal(codex!.cwd, claude!.cwd);
  assert.equal(codex!.prompt, codexCheckPrompt(claude!.prompt));
  assert.equal(claude!.prompt, checkPrompt('X-1', content));
  // Inside the gate's wrapper: "--", the codex executable and its argv; the work checkout's
  // .software-factory hidden (by its own tmpfs, or by the wrapper's /tmp when it lies under /tmp).
  const [wrapped] = await bwrapLog(env);
  const cut = wrapped!.argv.indexOf('--');
  assert.deepEqual(wrapped!.argv.slice(cut), ['--', fakeCodex, ...codex!.argv]);
  assert.deepEqual(wrapped!.argv.slice(0, 2), ['--die-with-parent', '--unshare-pid']);
  const taskFolder = join(repo, '.software-factory');
  const args = wrapped!.argv.slice(0, cut);
  const hidden = args.some((arg, index) => arg === taskFolder && args[index - 1] === '--tmpfs');
  assert.ok(hidden || (within(taskFolder, '/tmp') && args.some((arg, index) => arg === '/tmp' && args[index - 1] === '--tmpfs')), args.join(' '));
  assert.deepEqual(args.slice(-3), ['--bind', join(folder, 'codex'), join(folder, 'codex')]);

  // The record: the Claude check and the Codex part, its output settled (the contradiction a blocker).
  const record = await stored(env, 'X-1', content);
  assert.equal(record.status, 'checked');
  assert.deepEqual(record.output?.findings.map((item) => item.severity), ['nit']);
  const { started_at: startedAt, ended_at: endedAt, ...part } = record.codex!;
  assert.deepEqual(part, {
    reason: OUTSIDE, status: 'checked', output: { ...CODEX, findings: [{ ...CODEX.findings[0]!, severity: 'blocker' }], verdict: 'not_ready' }, error: null,
    model: null, tokens: { input: 1000, cached_input: 200, output: 100 },
  });
  assert.ok(startedAt <= endedAt);
  assert.equal(recordVerdict(record), 'not_ready');

  // The output: the Codex lines after the Files lines, before the Verdict line, which counts both.
  const out = run.stdout;
  const at = (text: string): number => {
    const index = out.indexOf(text);
    assert.ok(index >= 0, `${text} not in:\n${out}`);
    return index;
  };
  assert.ok(at('Files:\n  modify README.md') < at(`\n\nCodex check (${OUTSIDE}), model default, 1100 tokens\nCodex findings:\n  blocker (1):\n    - [contradiction] README.md:1: The Task says the README is empty; it says hello. Expected: Describe the README as it is.\n  major (0): none\n  nit (0): none\nCodex verdict: not ready\n\nVerdict: not ready (1 blocker, 0 major, 1 nit)`));
  // The check folder, with the codex folder, is gone; the checkout has no other worktree.
  assert.equal(existsSync(folder), false);
});

test('the Codex check and the Claude check run at once: each waits for the other to have started', { timeout: 120_000 }, async () => {
  const { env, content } = await codexEnv('codex-parallel', 'X-7');
  await reviewScript(env, [{ output: CLAUDE, startFile: 'claude-started', waitFile: 'codex-started' }]);
  await codexScript(env, [{ output: CODEX, startFile: 'codex-started', waitFile: 'claude-started' }]);
  const run = await runCli(env, ['check-task', 'app', 'X-7']);
  assert.equal(run.code, 0, run.stderr);
  const record = await stored(env, 'X-7', content);
  assert.deepEqual([record.status, record.codex?.status], ['checked', 'checked']);
});

test('CC-6: with the gate off the Codex part is failed and holds nothing: the Claude check\'s verdict, exit 0', async () => {
  const { env, content } = await codexEnv('codex-off', 'X-2', { SF_GATE: 'off' });
  await reviewScript(env, [{ output: CLAUDE }]);
  const run = await runCli(env, ['check-task', 'app', 'X-2']);
  assert.equal(run.code, 0, run.stderr);
  const record = await stored(env, 'X-2', content);
  assert.deepEqual([record.codex?.status, record.codex?.error, record.codex?.output, recordVerdict(record)], ['failed', 'Codex is not available (SF_GATE=off); the Claude check decides alone.', null, 'ready']);
  assert.deepEqual(record.codex?.tokens, { input: 0, cached_input: 0, output: 0 });
  assert.equal(record.codex?.started_at, record.codex?.ended_at);
  assert.match(run.stdout, /Codex check failed: Codex is not available \(SF_GATE=off\); the Claude check decides alone\. \(it does not hold the plan\)\n\nVerdict: ready \(0 blocker, 0 major, 1 nit\)/);
  assert.equal(existsSync(join(env.home, 'fake-codex.log')), false);
});

test('CC-7: a Task ChatGPT wrote through write_task (owner chatgpt, its last write written): no Codex run, no codex key', async () => {
  const { env, content } = await codexEnv('codex-chatgpt', 'X-3');
  await mkdir(join(env.state, 'requests', 'app'), { recursive: true });
  await writeFile(join(env.state, 'requests', 'app', 'X-3.owner'), 'chatgpt\n');
  await mkdir(join(env.state, 'tickets', 'app', 'X-3'), { recursive: true });
  await writeFile(join(env.state, 'tickets', 'app', 'X-3', 'history.jsonl'), `${JSON.stringify({ ts: '2026-11-20T10:00:00.000Z', kind: 'written', by: 'context_owner', sha256: taskSha256(content) })}\n`);
  await reviewScript(env, [{ output: CLAUDE }]);
  const run = await runCli(env, ['check-task', 'app', 'X-3']);
  assert.equal(run.code, 0, run.stderr);
  const record = await stored(env, 'X-3', content);
  assert.equal('codex' in record, false);
  assert.ok(!run.stdout.includes('Codex'), run.stdout);
  assert.equal(existsSync(join(env.home, 'fake-codex.log')), false);
});

test('CC-8: over SF_GATE_MAX_TOKENS the Codex part is failed and its findings are not applied', async () => {
  const { env, content } = await codexEnv('codex-tokens', 'X-4', { SF_GATE_MAX_TOKENS: '1' });
  await reviewScript(env, [{ output: CLAUDE }]);
  await codexScript(env, [{ output: CODEX }]);
  const run = await runCli(env, ['check-task', 'app', 'X-4']);
  assert.equal(run.code, 0, run.stderr);
  const record = await stored(env, 'X-4', content);
  assert.deepEqual([record.codex?.status, record.codex?.output, record.codex?.error], ['failed', null, 'Codex used 1100 tokens, over SF_GATE_MAX_TOKENS (1); its findings are not applied.']);
  assert.deepEqual(record.codex?.tokens, { input: 1000, cached_input: 200, output: 100 });
  assert.equal(recordVerdict(record), 'ready');
});

test('CC-10: Codex answering text that is not JSON is a failed part; the Claude check decides', async () => {
  const { env, content } = await codexEnv('codex-invalid', 'X-5');
  await reviewScript(env, [{ output: CLAUDE }]);
  await codexScript(env, [{ invalid: true }]);
  const run = await runCli(env, ['check-task', 'app', 'X-5']);
  assert.equal(run.code, 0, run.stderr);
  const record = await stored(env, 'X-5', content);
  assert.equal(record.codex?.status, 'failed');
  assert.match(record.codex?.error ?? '', /^Codex returned output that is not JSON: /);
  assert.equal(recordVerdict(record), 'ready');
});

test('CC-11: a secret of the check\'s environment in a Codex finding is stored and printed as [redacted]', async () => {
  const secret = 'fake-secret-value-307';
  const { env, content } = await codexEnv('codex-redact', 'X-6', { OPENAI_FAKE_SECRET: secret });
  await reviewScript(env, [{ output: CLAUDE }]);
  await codexScript(env, [{ output: output([finding('major', 'missing', '## Files', `The key ${secret} is in the Task.`)], 'not_ready') }]);
  const run = await runCli(env, ['check-task', 'app', 'X-6']);
  assert.equal(run.code, 0, run.stderr);
  const text = await readFile(join(env.state, 'checks', 'app', 'X-6', `${taskSha256(content).slice(0, 16)}.json`), 'utf8');
  assert.ok(!text.includes(secret) && !run.stdout.includes(secret), run.stdout);
  const record = JSON.parse(text) as CheckRecord;
  assert.equal(record.codex?.output?.findings[0]?.problem, 'The key [redacted] is in the Task.');
  assert.ok(run.stdout.includes('[missing] ## Files: The key [redacted] is in the Task.'), run.stdout);
});

// task_check of the ticket through sf serve.
async function taskCheckOf(env: Env, ticket: string): Promise<Record<string, any>> {
  const served = await serve(env);
  try {
    return await call(served, 'task_check', { workspace: 'app', ticket });
  } finally {
    await stop(served);
  }
}

test('TC-1: task_check answers the combined verdict, the Claude check\'s fields and the Codex part beside them, its findings settled', async () => {
  const { env, content } = await codexEnv('codex-tool', 'X-8');
  await reviewScript(env, [{ output: CLAUDE }]);
  await codexScript(env, [{ output: CODEX }]);
  const run = await runCli(env, ['check-task', 'app', 'X-8']);
  assert.equal(run.code, 0, run.stderr);
  const answer = await taskCheckOf(env, 'X-8');
  const record = await stored(env, 'X-8', content);
  assert.deepEqual(answer, {
    verdict: 'not_ready', sha256: taskSha256(content), paraphrase: CLAUDE.paraphrase, findings: CLAUDE.findings, files: CLAUDE.files, error: null, model: 'fake-model',
    checked_at: record.ended_at, running: false, pending: false,
    codex: { verdict: 'not_ready', reason: OUTSIDE, findings: [{ ...CODEX.findings[0]!, severity: 'blocker' }], error: null, model: null },
  });
});

test('TC-2: task_check of a failed Codex part: its verdict failed, its error, no findings; the top-level verdict the Claude check\'s', async () => {
  const { env } = await codexEnv('codex-tool-failed', 'X-9');
  await reviewScript(env, [{ output: CLAUDE }]);
  await codexScript(env, [{ invalid: true }]);
  assert.equal((await runCli(env, ['check-task', 'app', 'X-9'])).code, 0);
  const answer = await taskCheckOf(env, 'X-9');
  assert.equal(answer.verdict, 'ready');
  assert.deepEqual(answer.findings, CLAUDE.findings);
  assert.deepEqual([answer.codex.verdict, answer.codex.findings, answer.codex.reason, answer.codex.model], ['failed', [], OUTSIDE, null]);
  assert.match(answer.codex.error, /^Codex returned output that is not JSON: /);
});

test('TC-3: task_check of a Task ChatGPT wrote through write_task: codex null', async () => {
  const { env, content } = await codexEnv('codex-tool-chatgpt', 'X-10');
  await mkdir(join(env.state, 'requests', 'app'), { recursive: true });
  await writeFile(join(env.state, 'requests', 'app', 'X-10.owner'), 'chatgpt\n');
  await mkdir(join(env.state, 'tickets', 'app', 'X-10'), { recursive: true });
  await writeFile(join(env.state, 'tickets', 'app', 'X-10', 'history.jsonl'), `${JSON.stringify({ ts: '2026-11-20T10:00:00.000Z', kind: 'written', by: 'context_owner', sha256: taskSha256(content) })}\n`);
  await reviewScript(env, [{ output: CLAUDE }]);
  assert.equal((await runCli(env, ['check-task', 'app', 'X-10'])).code, 0);
  const answer = await taskCheckOf(env, 'X-10');
  assert.deepEqual([answer.verdict, answer.codex, answer.findings], ['ready', null, CLAUDE.findings]);
});

// A Claude check ready without findings and a Codex part with one blocker and two majors.
const codexHeld = (): CheckRecord =>
  record(output([], 'ready'), codexPart(output([finding('blocker'), finding('major', 'missing', '## A'), finding('major', 'missing', '## B')], 'not_ready')));

test('TC-4: the "plan not ready" notification counts the Codex part\'s findings; a record without one keeps today\'s text', () => {
  assert.deepEqual(taskCheckNotification(codexHeld()), { title: 'C-1: plan not ready', body: '1 blocker, 2 major · app', priority: 'default', tags: 'warning' });
  assert.equal(taskCheckNotification(record(output([finding('major')], 'not_ready')))?.body, '0 blocker, 1 major · app');
  assert.equal(taskCheckNotification(record(output([], 'ready'), codexPart(null))), undefined);
});

test('TC-5: planCheck counts the Codex part\'s findings: the queue\'s reason counts both checks', async () => {
  const of = (held: CheckRecord): Promise<unknown> => planCheck({
    view: async () => ({ check: held, stale: false, running: false, current_sha256: held.sha256, check_reason: null }),
    store: { read: async () => held } as unknown as Parameters<typeof planCheck>[0]['store'],
  }, undefined, 'app', 'C-1');
  assert.deepEqual(await of(codexHeld()), { state: 'not_ready', blockers: 1, majors: 2 });
  assert.deepEqual(await of(record(output([finding('major')], 'not_ready'))), { state: 'not_ready', blockers: 0, majors: 1 });
});

test('TC-6: the ticket\'s history says the combined verdict and counts and names the Codex part; a shared finding counts once', async () => {
  const state = join(temp, 'codex-history');
  const dir = join(state, 'checks', 'app', 'T-1');
  await mkdir(dir, { recursive: true });
  const scope: CheckFinding = { kind: 'missing', severity: 'major', where: 'scope:', problem: 'src/a.ts (modify) is not in scope:.', expected: 'Add it.' };
  const records: Array<[string, CheckRecord]> = [
    ['2026-11-20T10:01:00.000Z', { ...record(output([], 'ready'), codexPart(output([finding('major')], 'not_ready'))), cost_usd: 0.48 }],
    ['2026-11-20T10:02:00.000Z', { ...record(output([], 'ready'), codexPart(null)), cost_usd: 0.31 }],
    ['2026-11-20T10:03:00.000Z', { ...record(output([], 'ready')), cost_usd: 0.48 }],
    ['2026-11-20T10:04:00.000Z', { ...record(output([scope], 'not_ready'), codexPart(output([scope], 'not_ready'))), cost_usd: 0.2 }],
    ['2026-11-20T10:05:00.000Z', { ...record(null, codexPart(output([], 'ready'))), cost_usd: 0.1 }],
  ];
  for (const [index, [endedAt, held]] of records.entries()) {
    await writeFile(join(dir, `${String(index).repeat(16)}.json`), JSON.stringify({ ...held, ticket: 'T-1', ended_at: endedAt }));
  }
  const timeline = await new TicketHistory(state).timeline('app', 'T-1');
  assert.deepEqual(timeline.filter((entry) => entry.kind === 'checked').map((entry) => entry.text), [
    'Check failed · Codex ready · $0.10',
    'Checked: not ready (0 blockers, 1 major) · Codex not ready · $0.20',
    'Checked: ready · $0.48',
    'Checked: ready · Codex failed · $0.31',
    'Checked: not ready (0 blockers, 1 major) · Codex not ready · $0.48',
  ]);
  // The shared scope: major counts once, as planCheck and the notification count it.
  const shared = { ...records[3]![1], ticket: 'T-1' };
  assert.deepEqual(recordCounts(shared), { blocker: 0, major: 1, nit: 0 });
  assert.equal(taskCheckNotification(shared)?.body, '0 blocker, 1 major · app');
});
