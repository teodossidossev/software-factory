// End-to-end tests of the Claude review of every iteration (SF-038) with the real sf serve and the
// fake Claude, whose runs with --json-schema are reviews scripted by $HOME/fake-review.json: a fix
// verdict becomes ## Fix N and the next iteration, a clean one runs Clean, undeclared sensitive
// paths, failures, SF_REVIEW=off and the review at serve start, abort during a review, the limit on
// Fix sections, and what check, sf watch, sf status and the dashboard show. Then the schema the CLI
// accepts (the fake refuses one it would not) and the retry of a failed review (SF-044). SF-125:
// the verdict is stored, and sent on, redacted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { iterationLimitMessage } from '../src/execution/turns.js';
import { gatePrompt } from '../src/gate.js';
import { JobStore } from '../src/jobs.js';
import { mrNotes } from '../src/mr-notes.js';
import { handbookSection, MAX_USER_DECISIONS_CHARS, MAX_USER_MESSAGE_CHARS, userDecisionLines } from '../src/prompts.js';
import type { FileChange } from '../src/jobs.js';
import { actedVerdict, decide, fixContent, readOnlySessionOptions, REVIEW_DENIED_TOOLS, REVIEW_SCHEMA, REVIEW_TOOLS, type ReviewItem, reviewPrompt, reviewSessionOptions, runReview, scopeItem, sensitiveItem, unacceptedItems, uniqueNits } from '../src/review.js';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { FILE_GUARD } from '../src/sandbox-denials.js';
import { loadHandbook } from '../src/server.js';
import { runSimplify } from '../src/simplify.js';
import { writeTask } from '../src/task-file.js';
import { act, fetchRaw } from './support/dashboard-client.js';
import { assertPathDenials, call, codexLog, codexScript, type Env, FAKE, fakeLog, git, newEnv, newRepo, ownReviewMethod, probeLog, putRules, putTask, reviewLog, reviewScript, runCli, script, serve, stop, task, waitFor } from './support/harness.js';
import { CLAUDE_CLEAN, GATE_CLEAN, gateEnv } from './support/gate.js';

const FIX = {
  verdict: 'fix',
  summary: 'The greeting  is\nwrong.',
  items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.', severity: 'major' }],
  accepted_sensitive: [],
};
const CLEAN = { verdict: 'clean', summary: 'The greeting is right.', items: [], accepted_sensitive: [] };
const FIX_SECTION = '## Fix 1\n\nReview by Claude: The greeting is wrong.\n\n1. [R1, major] `README.md`: It greets the world. Expected: It greets the reader.\n';

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'x', '## Why', 'The ticket asks for it.', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
    '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

// The items as the review records them: reopens and caused_by "" when the reviewer gave none (SF-052).
const ledgerFields = (items: Array<Omit<ReviewItem, 'severity'> & { severity: string }>): unknown[] => items.map((item) => ({ ...item, reopens: '', caused_by: '' }));
const taskFile = (repo: string, ticket: string): Promise<string> => readFile(join(repo, '.software-factory', `${ticket}.md`), 'utf8');
const worktreeOf = (env: Env, ticket: string): string => join(env.state, 'worktrees', 'app', ticket);
const option = (argv: string[], name: string): string | undefined => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function eventsOf(env: Env, ticket: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(env.state, 'jobs', 'app', ticket, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

test('the review session sees the repository\'s settings and instructions only: no user settings, no auto-memory, no instruction file above the worktree', () => {
  const abortController = new AbortController();
  const cwd = '/home/u/state/worktrees/app/R-1';
  const options = reviewSessionOptions({ cwd, claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 7, }, abortController);
  assert.equal(options.cwd, cwd);
  assert.deepEqual(options.settingSources, ['project']);
  assert.equal(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  const excludes = (options.settings as { claudeMdExcludes?: string[] }).claudeMdExcludes ?? [];
  for (const dir of ['/home/u/state/worktrees/app', '/home/u/state/worktrees', '/home/u/state', '/home/u', '/home']) {
    for (const file of ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', '.claude/AGENTS.md', '.claude/rules/**']) {
      assert.ok(excludes.includes(`${dir}/${file}`), `${dir}/${file} not in ${excludes.join(', ')}`);
    }
  }
  // The worktree's own files stay.
  assert.ok(!excludes.some((pattern) => pattern.startsWith(`${cwd}/`)), excludes.join(', '));
  // A glob character in a directory name is matched literally.
  const special = reviewSessionOptions({ cwd: '/srv/a (b)/w', claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 7, }, abortController);
  assert.ok((special.settings as { claudeMdExcludes: string[] }).claudeMdExcludes.includes('/srv/a \\(b\\)/CLAUDE.md'));
});

test('the options of runStructuredSession: without tools and settingSources, REVIEW_TOOLS and [\'project\'] as before; the morning digest\'s none (SF-103)', () => {
  const base = { cwd: '/srv/app', claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 3 };
  const defaults = readOnlySessionOptions(base, new AbortController(), REVIEW_SCHEMA);
  assert.deepEqual(defaults.tools, REVIEW_TOOLS);
  assert.deepEqual(defaults.settingSources, ['project']);
  const none = readOnlySessionOptions({ ...base, tools: [], settingSources: [] }, new AbortController(), REVIEW_SCHEMA);
  assert.deepEqual([none.tools, none.settingSources], [[], []]);
  assert.deepEqual(none.outputFormat, { type: 'json_schema', schema: REVIEW_SCHEMA });
});

test('every read-only session loads no MCP server: strictMcpConfig, no mcpServers, and \'mcp__*\' denied (SF-164)', () => {
  const base = { cwd: '/srv/app', claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 3 };
  for (const options of [
    reviewSessionOptions(base, new AbortController()),
    readOnlySessionOptions({ ...base, tools: [], settingSources: [] }, new AbortController(), REVIEW_SCHEMA, ['Read(//x/**)'], undefined),
  ]) {
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(options.mcpServers, {});
    assert.ok(options.disallowedTools?.includes('mcp__*'), options.disallowedTools?.join(', '));
  }
});

test('readOnlySessionOptions merges options.hooks (the file-tool guard, SF-123) with the session\'s own hooks: each event\'s matchers concatenated, the session\'s first', () => {
  const base = { cwd: '/srv/app', claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 3 };
  const hook = (): HookCallback => async () => ({});
  const [guard, own, after] = [hook(), hook(), hook()];
  const merged = readOnlySessionOptions({ ...base, hooks: { PreToolUse: [{ hooks: [guard] }] } }, new AbortController(), REVIEW_SCHEMA, [], { PreToolUse: [{ hooks: [own] }], PostToolUse: [{ hooks: [after] }] });
  assert.deepEqual(merged.hooks, { PreToolUse: [{ hooks: [own] }, { hooks: [guard] }], PostToolUse: [{ hooks: [after] }] });
  assert.deepEqual(readOnlySessionOptions({ ...base, hooks: { PreToolUse: [{ hooks: [guard] }] } }, new AbortController(), REVIEW_SCHEMA).hooks, { PreToolUse: [{ hooks: [guard] }] });
  assert.deepEqual(readOnlySessionOptions(base, new AbortController(), REVIEW_SCHEMA, [], { PreToolUse: [{ hooks: [own] }] }).hooks, { PreToolUse: [{ hooks: [own] }] });
  assert.equal('hooks' in readOnlySessionOptions(base, new AbortController(), REVIEW_SCHEMA), false);
});

test('readOnlySessionOptions hides the session environment\'s credentials from sandboxed commands (SF-123 Fix 2): one deny entry each in credentials.envVars, after the entries already there; none without a sandbox', () => {
  const saved = { ...process.env };
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-fake', CLAUDE_CODE_USE_BEDROCK: '1', AWS_SECRET_ACCESS_KEY: 'aws-fake', GOOGLE_APPLICATION_CREDENTIALS: '/g.json' });
  try {
    const sandbox = { enabled: true, credentials: { envVars: [{ name: 'MY_TOKEN', mode: 'mask' as const }] } };
    const options = readOnlySessionOptions({ cwd: '/srv/app', claudePath: undefined, sandbox, model: undefined, maxTurns: 3, filesystem: { denyRead: [], denyWrite: [] } }, new AbortController(), REVIEW_SCHEMA);
    const envVars = options.sandbox?.credentials?.envVars ?? [];
    assert.deepEqual(envVars[0], { name: 'MY_TOKEN', mode: 'mask' });
    // Exactly the passed credentials (Bedrock on: the cloud ones too), never PATH or the switch.
    assert.deepEqual(envVars.slice(1).map((entry) => [entry.name, entry.mode]).sort(), Object.keys(options.env!).filter((name) => /^(ANTHROPIC_\w+|AWS_\w+|GOOGLE_\w+|CLOUD_ML_\w+|CLAUDE_CODE_OAUTH_TOKEN)$/.test(name)).map((name) => [name, 'deny']).sort());
    for (const name of ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS']) {
      assert.ok(envVars.some((entry) => entry.name === name && entry.mode === 'deny'), name);
    }
    assert.ok(!envVars.some((entry) => entry.name === 'PATH' || entry.name === 'CLAUDE_CODE_USE_BEDROCK'));
    // The CLI itself still gets them; no sandbox stays none.
    assert.equal(options.env!.AWS_SECRET_ACCESS_KEY, 'aws-fake');
    assert.equal(readOnlySessionOptions({ cwd: '/srv/app', claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 3 }, new AbortController(), REVIEW_SCHEMA).sandbox, undefined);
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, saved);
  }
});

test('runReview and runSimplify pass options.hooks on to the session (SF-123): its tool calls are put to them', async () => {
  const env = await newEnv('review-hooks');
  const probes = [{ tool: 'Read', input: { file_path: 'README.md' } }];
  await reviewScript(env, [{ output: CLEAN, probes }, { output: { summary: 'Nothing to simplify.', suggestions: [] }, probes }]);
  const seen: string[] = [];
  const guard: HookCallback = async (input) => {
    seen.push(input.hook_event_name === 'PreToolUse' ? input.tool_name : input.hook_event_name);
    return input.hook_event_name === 'PreToolUse' && input.tool_name === 'Read'
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'refused by the test guard' } }
      : {};
  };
  const home = process.env.HOME;
  process.env.HOME = env.home;
  try {
    const options = { cwd: env.home, claudePath: FAKE, sandbox: undefined, model: undefined, maxTurns: 3, signal: new AbortController().signal, hooks: { PreToolUse: [{ hooks: [guard] }] } };
    assert.equal((await runReview('Review this.', options)).ok, true);
    assert.equal((await runSimplify('Simplify this.', options)).ok, true);
  } finally {
    process.env.HOME = home;
  }
  assert.deepEqual(seen, ['Read', 'StructuredOutput', 'Read', 'StructuredOutput']);
  assert.deepEqual((await probeLog(env)).filter((entry) => entry.tool === 'Read').map((entry) => [entry.decision, entry.output]), [['deny', 'refused by the test guard'], ['deny', 'refused by the test guard']]);
});

test('through sf serve (SF-123): the review of an iteration gets the job\'s file-tool guard, which refuses a Read in the home directory', async () => {
  const env = await newEnv('review-guard', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-guard-repo', false);
  await putTask(env, repo, 'R-2', 'Greet the reader');
  await script(env, [{ write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 1' }, { write: { '.software-factory/R-2.mr.md': mrText('feat(R-2): Greet the reader') }, text: 'prepared' }]);
  await reviewScript(env, [{ output: CLEAN, probes: [{ tool: 'Read', input: { file_path: join(env.home, 'fake-claude.json') } }, { tool: 'Read', input: { file_path: 'README.md' } }] }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-2' });
    await waitFor(served, 'R-2', 'ready_for_human_review', 1);
    const [home, own] = await probeLog(env);
    assert.deepEqual([home!.decision, home!.hooks, own!.decision], ['deny', 1, 'allow']);
    assert.ok(home!.output.startsWith(FILE_GUARD) && home!.output.includes(join(env.home, 'fake-claude.json')), home!.output);
  } finally {
    await stop(served);
  }
});

test('fix, then clean: the Fix section from the items, the next iteration, Clean; the read-only argv, the prompt, review.json, check, sf watch, sf status and the dashboard', async () => {
  const env = await newEnv('review-cycle', { SF_REVIEW: 'on', SF_REVIEW_MAX_TURNS: '7', SF_REVIEW_MODEL: 'fake-reviewer' });
  const repo = await newRepo(env, 'review-cycle-repo', false);
  await putTask(env, repo, 'R-1', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2\n\n| R1 | fixed | The reader is greeted. |' },
    { write: { '.software-factory/R-1.mr.md': mrText('feat(R-1): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: FIX }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-1' });
    const ready = await waitFor(served, 'R-1', 'ready_for_human_review', 2);
    assert.deepEqual(ready.review, { status: 'done', verdict: 'clean', summary: CLEAN.summary });
    assert.equal(await taskFile(repo, 'R-1'), `${task('R-1', 'Greet the reader')}\n\n${FIX_SECTION}`);
    assert.equal(git(repo, 'show', 'R-1-greet-the-reader:README.md'), 'hello reader\n');
    const jobs = new JobStore(env.state);
    assert.equal((await jobs.read('app', 'R-1'))!.fixes, 1);

    // The Implementer: the first iteration, the Fix of the review, the MR text turn of Clean.
    const turns = await fakeLog(env);
    assert.deepEqual(turns.map((entry) => entry.prompt.split('\n')[0]), [
      '/implement .software-factory/R-1.md',
      '/implement .software-factory/R-1.md Fix 1',
      'MR preparation for R-1 on branch R-1-greet-the-reader. The user approved the reviewed change.',
    ]);

    // The reviews: fresh read-only sessions in the worktree with the schema and their own limits.
    const reviews = await reviewLog(env);
    assert.equal(reviews.length, 2);
    for (const entry of reviews) {
      assert.equal(entry.cwd, worktreeOf(env, 'R-1'));
      assert.equal(option(entry.argv, 'tools'), 'Read,Grep,Glob');
      // REVIEW_DENIED_TOOLS, then the path denials (SF-100): the factory's state and config, not the worktree.
      assertPathDenials(entry.argv, env, worktreeOf(env, 'R-1'), REVIEW_DENIED_TOOLS);
      assert.deepEqual(JSON.parse(option(entry.argv, 'json-schema')!), REVIEW_SCHEMA);
      assert.deepEqual([option(entry.argv, 'max-turns'), option(entry.argv, 'model'), option(entry.argv, 'permission-mode')], ['7', 'fake-reviewer', 'auto']);
      assert.ok(!entry.argv.some((arg) => arg.startsWith('--resume')), entry.argv.join(' '));
      assert.ok(!turns.some((turn) => turn.sessionId === entry.sessionId));
      assert.ok(!entry.env.some((name) => name.startsWith('SF_')));
      // The repository's settings and instructions only: no user settings, no auto-memory.
      assert.equal(option(entry.argv, 'setting-sources'), 'project');
      assert.ok(entry.env.includes('CLAUDE_CODE_DISABLE_AUTO_MEMORY'), entry.env.join(','));
      const settings = JSON.parse(entry.argv[entry.argv.indexOf('--settings') + 1] ?? '{}') as { claudeMdExcludes?: string[] };
      assert.ok(settings.claudeMdExcludes?.includes(join(dirname(entry.cwd), 'CLAUDE.md')), entry.argv.join(' '));
    }
    // The Implementer's session keeps the user's settings.
    assert.ok(turns.every((turn) => option(turn.argv, 'setting-sources') === 'user,project'));
    assert.equal(REVIEW_DENIED_TOOLS.filter((tool) => ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Read(**/.env)'].includes(tool)).length, 9);
    const [first, second] = reviews.map((entry) => entry.prompt);
    assert.match(first!, /^Code review of iteration 1 of ticket R-1\. /);
    assert.ok(first!.includes(handbookSection((await loadHandbook()).text, '## Review rules')));
    assert.ok(first!.includes(`<task_file path=".software-factory/R-1.md">\n${task('R-1', 'Greet the reader').trimEnd()}\n</task_file>`));
    assert.ok(first!.includes('<report>\nReport of iteration 1\n'));
    assert.ok(first!.includes('<marked_paths>\nNone.\n</marked_paths>'));
    assert.ok(first!.includes('\n<review_method>\nTwo-axis review of the diff'), first);
    assert.match(first!, /<patch>\ndiff --git a\/README\.md b\/README\.md\n[\s\S]*\n\+hello world\n<\/patch>$/);
    assert.match(second!, /^Code review of iteration 2 of ticket R-1\. /);
    assert.ok(second!.includes(`${FIX_SECTION.trimEnd()}\n</task_file>`));
    assert.ok(second!.includes('+hello reader'));

    // review.json of each iteration, the events, check, sf watch, sf status and the dashboard.
    const recorded = await jobs.readReview('app', 'R-1', 1);
    assert.ok(recorded !== undefined && 'verdict' in recorded);
    const { started_at: startedAt, ended_at: endedAt, ...rest } = recorded;
    assert.deepEqual(rest, { reviewer: 'claude', ...FIX, items: ledgerFields(FIX.items), cost_usd: 0.0456, review_method: await ownReviewMethod(env, 'R-1') });
    assert.ok(Date.parse(startedAt) <= Date.parse(endedAt));
    assert.deepEqual((await eventsOf(env, 'R-1')).filter((record) => record.type === 'review').map(({ ts: _ts, ...record }) => record), [
      { iteration: 1, type: 'review', reviewer: 'claude', verdict: 'fix', items: 1 },
      { iteration: 2, type: 'review', reviewer: 'claude', verdict: 'clean', items: 0 },
    ]);
    const watched = await runCli(env, ['watch', 'app', 'R-1', '--once']);
    assert.match(watched.stdout, /^\d\d:\d\d:\d\d \[1\] review by claude: fix \(1 item\)$/m);
    assert.match(watched.stdout, /^\d\d:\d\d:\d\d \[2\] review by claude: clean$/m);
    // The review sessions live (SF-045): every SDK message of each, then the verdict line. The
    // session has the file-tool guard's hook (SF-123), so the fake gives its answer as a
    // StructuredOutput tool call put to it (an assistant and a user message).
    const live = (await eventsOf(env, 'R-1')).filter((record) => record.type === 'review_message' || record.type === 'review');
    assert.deepEqual(live.map((record) => [record.iteration, record.type, (record.message as { type?: string } | undefined)?.type ?? record.verdict]), [1, 2].flatMap((iteration) => [
      [iteration, 'review_message', 'system'], [iteration, 'review_message', 'assistant'], [iteration, 'review_message', 'user'],
      [iteration, 'review_message', 'assistant'], [iteration, 'review_message', 'assistant'], [iteration, 'review_message', 'user'],
      [iteration, 'review_message', 'result'], [iteration, 'review', iteration === 1 ? 'fix' : 'clean'],
    ]));
    assert.ok(live.filter((record) => record.type === 'review_message').every((record) => record.reviewer === 'claude' && Object.keys(record).sort().join() === 'iteration,message,reviewer,ts,type'));
    const reviewLines = watched.stdout.split('\n').filter((line) => / review( |$)/.test(line)).map((line) => line.slice(9));
    // The answer's StructuredOutput call (SF-123: the session has the guard's hook), cut as any call.
    assert.deepEqual(reviewLines.map((line) => line.replace(/^(\[\d\] review \| StructuredOutput)\(.*$/, '$1(…)')), [
      '[1] review | Read(README.md)', '[1] review | Reviewed.', '[1] review | StructuredOutput(…)', '[1] review by claude: fix (1 item)',
      '[2] review | Read(README.md)', '[2] review | Reviewed.', '[2] review | StructuredOutput(…)', '[2] review by claude: clean',
    ]);
    // The Implementer's cost (0.0123, then 0 more in the same session) and both reviews.
    assert.equal((await jobs.recordedCost('app', 'R-1', 2))!.toFixed(4), '0.1035');
    assert.match((await runCli(env, ['status'])).stdout, /\bR-1\b.*\b0\.1035\b/);
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/R-1', served.dashboard!))).body);
    assert.deepEqual(detail.iterations.map((iteration: { review: { verdict: string } | null }) => iteration.review?.verdict), ['fix', 'clean']);
    assert.deepEqual(detail.iterations[0].review.items, ledgerFields(FIX.items));
  } finally {
    await stop(served);
  }
});

test('clean with an undeclared sensitive path it does not accept becomes a fix; accepted, Clean passes it on', async () => {
  const env = await newEnv('review-sensitive', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-sensitive-repo', false);
  await putTask(env, repo, 'S-1', 'Add a script');
  await script(env, [
    { write: { 'package.json': '{}\n', 'a.txt': 'a\n' }, text: 'iteration 1' },
    { text: 'package.json is needed: the tests run with npm.' },
    { write: { '.software-factory/S-1.mr.md': mrText('feat(S-1): Add a script') }, text: 'prepared' },
  ]);
  const accepted = { ...CLEAN, summary: 'package.json is accepted: the tests run with npm.', accepted_sensitive: ['package.json'] };
  await reviewScript(env, [{ output: CLEAN }, { output: accepted }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'S-1' });
    const ready = await waitFor(served, 'S-1', 'ready_for_human_review', 2);
    assert.equal(ready.review.summary, accepted.summary);
    assert.ok((await taskFile(repo, 'S-1')).endsWith(
      '\n\n## Fix 1\n\nReview by Claude: The greeting is right.\n\n1. [R1, major] `package.json`: Undeclared sensitive path. Expected: Remove it, or justify it in the Report.\n',
    ));
    const [first] = await reviewLog(env);
    assert.ok(first!.prompt.includes('<marked_paths>\n- sensitive, undeclared: package.json\n</marked_paths>'));
    assert.equal(git(repo, 'show', '--name-only', '--format=', 'S-1-add-a-script').trim(), 'a.txt\npackage.json');
    // The review's own verdict is what the event records, with the one acted on when it differs.
    assert.deepEqual((await eventsOf(env, 'S-1')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.verdict, record.effective]), [[1, 'clean', 'fix'], [2, 'clean', undefined]]);
  } finally {
    await stop(served);
  }
});

test('coding rules (SF-059): every review prompt gives the job\'s <rules> block before the Task file and asks that a rule violation name the rule\'s file', async () => {
  const env = await newEnv('review-rules', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-rules-repo', false);
  const block = await putRules(env, repo);
  await putTask(env, repo, 'R-9', 'Follow the rules');
  await script(env, [
    { write: { 'README.md': 'hello world\n', 'docs/style.md': 'No rules any more.\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2\n\n| R1 | fixed | The reader is greeted. |' },
    { write: { '.software-factory/R-9.mr.md': mrText('feat(R-9): Follow the rules') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: FIX }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-9' });
    await waitFor(served, 'R-9', 'ready_for_human_review', 2);
    const reviews = await reviewLog(env);
    assert.equal(reviews.length, 2);
    for (const entry of reviews) {
      // The rules as at the base commit, though the job rewrote docs/style.md in its worktree.
      assert.ok(entry.prompt.includes(`\n${block}\n\n<task_file path=".software-factory/R-9.md">\n`), entry.prompt);
      assert.match(entry.prompt, /\n- Review the change against the Task file [^\n]*\n- A review item that is a rule violation names the rule's file \(and heading\) in `problem`\.\n- The user's messages to the job \(<user_decisions>, below\)[^\n]*\n- Follow the review rules below/);
    }
    const turns = await fakeLog(env);
    assert.ok(turns[0]!.prompt.startsWith(`/implement .software-factory/R-9.md\n\n${block}\n`));
    assert.ok(!turns[1]!.prompt.includes('<rules>'));
  } finally {
    await stop(served);
  }
});

test('the review prompt without rules is as before: no <rules> block, no rule-violation line', async () => {
  const input = { ticket: 'R-1', iteration: 1, task: 't', report: 'r', patch: Buffer.from('p'), patchTruncated: false, files: [], handbook: (await loadHandbook()).text };
  const before = reviewPrompt(input);
  assert.equal(reviewPrompt({ ...input, rules: '' }), before);
  assert.ok(!before.includes('<rules>') && !before.includes('rule violation'));
  const withRules = reviewPrompt({ ...input, rules: '<rules>\nR\n</rules>' });
  assert.equal(withRules.replace('- A review item that is a rule violation names the rule\'s file (and heading) in `problem`.\n', '').replace('<rules>\nR\n</rules>\n\n', ''), before);
});

// The Handbook's review rule of the decision documents, as both reviewers get it.
const DECISION_DOCS_RULE = [
  '- The decision documents (`<decision_documents>` in the prompt: the glossary, the decision',
  '  records, the architecture pages) say what was decided about the product. Read those that bear',
  '  on the Patch. An item that is a conflict with one begins `Decision:`, cites the path and the',
  '  heading and quotes the sentence; its severity follows the definitions above. A question of the',
  '  product that no document answers is not an item: put it in `summary`, on a line that begins',
  '  `For the user:`.',
].join('\n');

test('the decision documents: both reviewers\' prompts hold the Handbook\'s rule and end with the <decision_documents> block; none listed: no block, the prompt as before', async () => {
  const handbook = (await loadHandbook()).text;
  assert.ok(handbookSection(handbook, '## Review rules').includes(DECISION_DOCS_RULE));
  const input = { ticket: 'R-1', iteration: 1, task: 't', report: 'r', patch: Buffer.from('p'), patchTruncated: false, files: [], handbook };
  const list = { docs: [{ path: 'GLOSSARY.md', bytes: 4100 }, { path: 'docs/adr/0001-example.md', bytes: 2100 }], left_out: 12 };
  const block = '<decision_documents>\nGLOSSARY.md (4100 bytes)\ndocs/adr/0001-example.md (2100 bytes)\n(12 more are not listed)\n</decision_documents>';
  const prompts: Array<(extra: { decision_docs?: typeof list }) => string> = [
    (extra) => reviewPrompt({ ...input, ...extra }),
    (extra) => gatePrompt({ ...input, ...extra, baseCommit: 'abc123' }),
  ];
  for (const prompt of prompts) {
    const before = prompt({});
    assert.ok(before.includes(DECISION_DOCS_RULE) && !before.includes('\n<decision_documents>'));
    assert.equal(prompt({ decision_docs: { docs: [], left_out: 0 } }), before);
    assert.equal(prompt({ decision_docs: list }), `${before}\n\n${block}`);
    assert.ok(before.endsWith('\n</patch>'));
  }
});

test('through sf serve: the Claude review and the gate get the workspace\'s decision documents as they are in the job\'s worktree', async () => {
  const env = await newEnv('review-decision-docs', gateEnv());
  const repo = await newRepo(env, 'review-decision-docs-repo', false);
  await mkdir(join(repo, 'docs', 'adr'), { recursive: true });
  await writeFile(join(repo, 'GLOSSARY.md'), '# Glossary\n');
  const adr = '# Greeting\n\nGreet the reader.\n';
  await writeFile(join(repo, 'docs', 'adr', '0001-greeting.md'), adr);
  await writeFile(join(repo, 'docs', 'notes.md'), 'Not a decision document.\n');
  git(repo, 'add', 'GLOSSARY.md', 'docs');
  git(repo, 'commit', '-q', '-m', 'decisions');
  await putTask(env, repo, 'R-30', 'Greet the reader');
  const glossary = '# Glossary\n\n## Reader\n\nA reader is a signed-in user.\n';
  await script(env, [
    { write: { 'README.md': 'hello reader\n', 'GLOSSARY.md': glossary }, text: 'Report of iteration 1' },
    { write: { '.software-factory/R-30.mr.md': mrText('feat(R-30): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-30' });
    await waitFor(served, 'R-30', 'ready_for_human_review', 1);
    const prompts = [...(await reviewLog(env)), ...(await codexLog(env))].map((entry) => entry.prompt);
    assert.equal(prompts.length, 2);
    // The glossary at the size the change left it in the worktree.
    const block = `<decision_documents>\nGLOSSARY.md (${Buffer.byteLength(glossary)} bytes)\ndocs/adr/0001-greeting.md (${Buffer.byteLength(adr)} bytes)\n</decision_documents>`;
    for (const prompt of prompts) {
      assert.ok(prompt.endsWith(`\n</patch>\n\n${block}`), prompt.slice(-500));
      assert.ok(prompt.includes(DECISION_DOCS_RULE));
    }
  } finally {
    await stop(served);
  }
});

// SF-112: the user's messages to the job reach the reviewers as decisions.
const DECISION_BULLET = "- The user's messages to the job (<user_decisions>, below) are the user's decisions: where one and the Task file disagree, the message wins, and a later message wins over an earlier one. A change that does what a message asked is not an item, nor is a Task requirement the message replaced; a message the change does not follow is one, citing the message in problem.";

test("the review prompt carries the user's messages in <user_decisions> after the Task file; None. without them; the rule bullet", async () => {
  const input = { ticket: 'R-1', iteration: 3, task: 't\n', report: 'r', patch: Buffer.from('p'), patchTruncated: false, files: [], handbook: (await loadHandbook()).text };
  const userMessages = [
    { iteration: 2, at: '2026-11-07T10:11:12.000Z', text: 'merge the undescribed anonymous expressions into one row\n\n' },
    { iteration: 3, at: null, text: 'and drop the count' },
  ];
  const prompt = reviewPrompt({ ...input, userMessages });
  const section = [
    '<user_decisions>',
    '<user_message iteration="2" at="2026-11-07T10:11:12.000Z">', 'merge the undescribed anonymous expressions into one row', '</user_message>',
    '<user_message iteration="3">', 'and drop the count', '</user_message>',
    '</user_decisions>',
  ].join('\n');
  assert.ok(prompt.includes(`\n</task_file>\n\n${section}\n\n<report>\n`), prompt);
  const none = reviewPrompt(input);
  assert.equal(reviewPrompt({ ...input, userMessages: [] }), none);
  assert.ok(none.includes('\n</task_file>\n\n<user_decisions>\nNone.\n</user_decisions>\n\n<report>\n'), none);
  for (const text of [prompt, none, reviewPrompt({ ...input, rules: '<rules>\nR\n</rules>' })]) {
    assert.match(text, /\n- Review the change against the Task file [^\n]*\n(?:- A review item that is a rule violation [^\n]*\n)?([^\n]*)\n- Follow the review rules below/);
    assert.equal(/\n- Review the change against the Task file [^\n]*\n(?:- A review item that is a rule violation [^\n]*\n)?([^\n]*)\n/.exec(text)![1], DECISION_BULLET);
  }
});

test('the cap of <user_decisions>', () => {
  assert.equal(MAX_USER_MESSAGE_CHARS, 4000);
  assert.equal(MAX_USER_DECISIONS_CHARS, 16000);
  const long = userDecisionLines([{ iteration: 1, at: null, text: 'x'.repeat(5000) }]);
  assert.equal(long.length, 3);
  assert.equal(long[1]!.length, 4000);
  assert.ok(long[1]!.endsWith('…'));
  // A cut never splits a surrogate pair.
  const emoji = userDecisionLines([{ iteration: 1, at: null, text: `${'x'.repeat(3998)}😀😀` }])[1]!;
  assert.equal(emoji, `${'x'.repeat(3998)}…`);
  const five = userDecisionLines([1, 2, 3, 4, 5].map((n) => ({ iteration: n, at: null, text: String(n).repeat(4000) })));
  assert.equal(five[0], "(1 earlier message is left out; the job's Stream has them.)");
  assert.deepEqual(five.filter((line) => line.startsWith('<user_message ')), [2, 3, 4, 5].map((n) => `<user_message iteration="${n}">`));
  // The first message that does not fit ends the walk, though an older, shorter one would fit.
  const sizes = [5, 4000, 4000, 4000, 4000, 3990];
  const walk = userDecisionLines(sizes.map((size, n) => ({ iteration: n + 1, at: null, text: 'z'.repeat(size) })));
  assert.equal(walk[0], "(2 earlier messages are left out; the job's Stream has them.)");
  assert.deepEqual(walk.filter((line) => line.startsWith('<user_message ')), [3, 4, 5, 6].map((n) => `<user_message iteration="${n}">`));
  // The newest alone, cut, however long.
  const alone = userDecisionLines([{ iteration: 1, at: null, text: 'y'.repeat(20000) }]);
  assert.deepEqual([alone.length, alone[1]!.length, alone[1]!.endsWith('…')], [3, 4000, true]);
  assert.deepEqual(userDecisionLines([]), ['None.']);
});

test("an sf say message reaches the next review in <user_decisions>; the first prompt with the job's rules is not a user message", async () => {
  const env = await newEnv('review-decisions', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-decisions-repo', false);
  const block = await putRules(env, repo);
  await putTask(env, repo, 'D-1', 'Decide');
  await script(env, [
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 1' },
    { write: { '.software-factory/D-1.mr.md': mrText('feat(D-1): Decide') }, text: 'prepared' },
    { write: { 'README.md': 'hello all readers\n' }, text: 'Report of iteration 2' },
    { write: { '.software-factory/D-1.mr.md': mrText('feat(D-1): Decide') }, text: 'prepared again' },
  ]);
  await reviewScript(env, [{ output: CLEAN }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'D-1' });
    await waitFor(served, 'D-1', 'ready_for_human_review', 1);
    const said = await runCli(env, ['say', 'app', 'D-1', 'merge', 'the', 'rows', 'into', 'one']);
    assert.equal(said.code, 0, said.stderr);
    await waitFor(served, 'D-1', 'ready_for_human_review', 2);
    const turns = await fakeLog(env);
    assert.ok(turns[0]!.prompt.startsWith(`/implement .software-factory/D-1.md\n\n${block}\n`));
    const reviews = await reviewLog(env);
    assert.equal(reviews.length, 2);
    assert.ok(reviews[0]!.prompt.includes('<user_decisions>\nNone.\n</user_decisions>'), reviews[0]!.prompt);
    const messages = reviews[1]!.prompt.match(/<user_message [^>]*>\n[^\n]*\n<\/user_message>/g);
    assert.equal(messages?.length, 1, reviews[1]!.prompt);
    assert.match(messages![0]!, /^<user_message iteration="2" at="\d{4}-\d\d-\d\dT[^"]+">\nmerge the rows into one\n<\/user_message>$/);
  } finally {
    await stop(served);
  }
});

// SF-051: the severity of review items.
const major = (path: string, problem: string): ReviewItem => ({ path, problem, expected: 'Fixed.', severity: 'major' });
const nit = (path: string, problem: string, expected = 'Nicer.'): ReviewItem => ({ path, problem, expected, severity: 'nit' });

test('the review schema gives every item a severity (blocker, major, nit) and the prompt defines them', async () => {
  const items = (REVIEW_SCHEMA.properties as { items: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } }).items.items;
  assert.deepEqual(items.properties.severity?.enum, ['blocker', 'major', 'nit']);
  assert.ok(items.required.includes('severity'));
  const prompt = reviewPrompt({ ticket: 'R-1', iteration: 1, task: 't', report: 'r', patch: Buffer.from('p'), patchTruncated: false, files: [], handbook: (await loadHandbook()).text });
  assert.ok(prompt.includes("- `blocker`: the change is wrong, unsafe or breaks the Task's acceptance."), prompt);
  assert.ok(prompt.includes('- `major`: a real defect or a Task requirement not met, but contained.'));
  assert.ok(prompt.includes('- `nit`: style, naming, wording, a narrower variant of a risk already accepted, a nice-to-have.'));
});

test('the verdict rule: fix only with a blocker or major item or an unaccepted sensitive path; the Fix section lists the nits last as optional', () => {
  const nits = [nit('a.txt', 'Wording.'), nit('b.txt', 'Naming.')];
  assert.deepEqual(decide({ items: nits }, []), { verdict: 'clean', items: [] });
  assert.equal(actedVerdict({ items: nits }), 'clean');
  // The items decide, whatever the reviewer wrote: a major item in a clean verdict is a fix too.
  assert.equal(actedVerdict({ items: [...nits, major('c.txt', 'Broken.')] }), 'fix');
  assert.deepEqual(decide({ items: [major('c.txt', 'Broken.'), ...nits] }, []), { verdict: 'fix', items: [major('c.txt', 'Broken.'), ...nits] });
  const sensitive = sensitiveItem('package.json');
  assert.equal(sensitive.severity, 'major');
  assert.deepEqual(decide({ items: nits }, [sensitive]), { verdict: 'fix', items: [sensitive, ...nits] });
  const blocker: ReviewItem = { ...major('c.txt', 'Unsafe.'), severity: 'blocker' };
  assert.deepEqual(decide({ items: [nits[0]!, blocker, nits[1]!] }, [sensitive]).items, [blocker, sensitive, ...nits]);
  const ids = [blocker, sensitive, ...nits].map((item, index) => ({ id: `R${index + 1}`, item }));
  assert.equal(fixContent('Two  things.', ids, 'Codex'), [
    'Review by Codex: Two things.', '',
    '1. [R1, blocker] `c.txt`: Unsafe. Expected: Fixed.',
    '2. [R2, major] `package.json`: Undeclared sensitive path. Expected: Remove it, or justify it in the Report.', '',
    'Nits (optional):',
    '3. [R3, nit] `a.txt`: Wording. Expected: Nicer.',
    '4. [R4, nit] `b.txt`: Naming. Expected: Nicer.',
  ].join('\n'));
  // Deduplicated by path and problem text across both reviewers.
  assert.deepEqual(uniqueNits([{ items: [...nits, major('a.txt', 'Wording.')] }, { items: [nit('a.txt', ' Wording. ', 'Other.'), nit('a.txt', 'Other.')] }]), [...nits, nit('a.txt', 'Other.')]);
});

// SF-053: the Task's file scope.
const change = (path: string, marks: Partial<FileChange> = {}): FileChange => ({ path, status: 'added', sensitive: 'no', scope: 'in', additions: 1, deletions: 0, ...marks });

test("the scope rule: a path outside the Task's scope not accepted is a major fix item; accepted, or with no scope, it is none; one that is also undeclared sensitive raises both items, and one acceptance settles both", () => {
  const files = [
    change('src/a.ts'), change('docs/x.md', { scope: 'out' }), change('package.json', { sensitive: 'undeclared', scope: 'out' }),
    change('old.ts', { status: 'deleted', scope: 'out' }), change('b.ts', { scope: 'none' }),
  ];
  const outside = scopeItem('docs/x.md');
  assert.deepEqual(outside, { path: 'docs/x.md', problem: "Outside the Task's scope.", expected: 'Remove the change, or justify it in the Report.', severity: 'major' });
  assert.deepEqual(unacceptedItems(files, []), [sensitiveItem('package.json'), outside, scopeItem('package.json'), scopeItem('old.ts')]);
  assert.deepEqual(unacceptedItems(files, ['docs/x.md', 'package.json']), [scopeItem('old.ts')]);
  assert.deepEqual(unacceptedItems(files, ['docs/x.md', 'package.json', 'old.ts']), []);
  assert.deepEqual(unacceptedItems(files.map((file) => ({ ...file, scope: 'none' as const })), []), [sensitiveItem('package.json')]);
  const nits = [nit('a.txt', 'Wording.')];
  assert.deepEqual(decide({ items: nits }, [outside]), { verdict: 'fix', items: [outside, ...nits] });
  assert.equal(fixContent('Clean.', [{ id: 'R1', item: outside }]), "Review by Claude: Clean.\n\n1. [R1, major] `docs/x.md`: Outside the Task's scope. Expected: Remove the change, or justify it in the Report.");
});

test("the review prompt marks the paths outside the Task's scope in <marked_paths>, the rule asks for a reason tied to the Task, and the schema names them in accepted_sensitive", async () => {
  const files = [change('src/a.ts'), change('docs/x.md', { scope: 'out' }), change('package.json', { sensitive: 'declared' }), change('old.ts', { status: 'deleted', scope: 'out' })];
  const prompt = reviewPrompt({ ticket: 'R-1', iteration: 1, task: 't', report: 'r', patch: Buffer.from('p'), patchTruncated: false, files, handbook: (await loadHandbook()).text });
  assert.ok(prompt.includes([
    '<marked_paths>', '- sensitive, declared by may_touch: package.json', "- outside the Task's scope: docs/x.md", "- outside the Task's scope: old.ts", '- deleted: old.ts', '</marked_paths>',
  ].join('\n')), prompt);
  assert.ok(prompt.includes("- .software-factory/ is the factory's folder (the Task file, the Implementer's steps checklist .software-factory/"), prompt);
  assert.ok(prompt.includes("- An undeclared sensitive path, or a path outside the Task's scope, stays only when you name it in accepted_sensitive and justify it in summary; otherwise it becomes a major fix item, whatever severity you give it. Accept a path outside the scope only for a reason tied to the Task."));
  const none = reviewPrompt({ ticket: 'R-1', iteration: 1, task: 't', report: 'r', patch: Buffer.from('p'), patchTruncated: false, files: [change('b.ts', { scope: 'none' })], handbook: (await loadHandbook()).text });
  assert.ok(none.includes('<marked_paths>\nNone.\n</marked_paths>'));
  const properties = REVIEW_SCHEMA.properties as Record<string, { description?: string }>;
  assert.equal(properties.accepted_sensitive?.description, 'The undeclared sensitive or out-of-scope paths you accept, each justified in summary.');
});

test("a path outside the Task's scope the review does not accept becomes a major fix item; accepted and justified, Clean passes it on; may_touch counts as in scope", async () => {
  const env = await newEnv('review-scope', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-scope-repo', false);
  const content = '---\nticket: O-1\ntitle: Greet the reader\nbase: main\nmay_touch: [package.json]\nscope: [README.md, test/**]\n---\n\n# O-1: Greet the reader\n\nChange the README.\n';
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, 'O-1', content, new JobStore(env.state));
  await script(env, [
    { write: { 'README.md': 'hello reader\n', 'test/readme.test.ts': 't\n', 'package.json': '{}\n', 'notes.txt': 'n\n' }, text: 'iteration 1' },
    { text: 'notes.txt holds the wording the README cites.' },
    { write: { '.software-factory/O-1.mr.md': mrText('feat(O-1): Greet the reader') }, text: 'prepared' },
  ]);
  const accepted = { ...CLEAN, summary: 'notes.txt is accepted: the README cites it.', accepted_sensitive: ['notes.txt'] };
  await reviewScript(env, [{ output: CLEAN }, { output: accepted }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'O-1' });
    const ready = await waitFor(served, 'O-1', 'ready_for_human_review', 2);
    assert.equal(ready.review.summary, accepted.summary);
    assert.ok((await taskFile(repo, 'O-1')).endsWith(
      "\n\n## Fix 1\n\nReview by Claude: The greeting is right.\n\n1. [R1, major] `notes.txt`: Outside the Task's scope. Expected: Remove the change, or justify it in the Report.\n",
    ));
    const store = new JobStore(env.state);
    const meta = await store.readMeta('app', 'O-1', 1);
    assert.deepEqual(meta.files!.map((file) => [file.path, file.sensitive, file.scope]), [
      ['README.md', 'no', 'in'], ['notes.txt', 'no', 'out'], ['package.json', 'declared', 'in'], ['test/readme.test.ts', 'no', 'in'],
    ]);
    const report = (await store.readIteration('app', 'O-1', 1)).report;
    assert.match(report, /\n### Outside the Task's scope\n\n- notes\.txt\n\n/);
    const [first] = await reviewLog(env);
    assert.ok(first!.prompt.includes("<marked_paths>\n- sensitive, declared by may_touch: package.json\n- outside the Task's scope: notes.txt\n</marked_paths>"), first!.prompt);
    const one = await runCli(env, ['status', 'app', 'O-1']);
    assert.match(one.stdout, /\nsensitive: package\.json\nout of scope: notes\.txt\ndeleted: none\n$/);
    // Accepted: the ledger entry is settled as fixed, and the branch holds the path.
    assert.deepEqual((await store.readLedger('app', 'O-1')).map((entry) => [entry.id, entry.problem, entry.status]), [['R1', "Outside the Task's scope.", 'fixed']]);
    assert.equal(git(repo, 'show', '--name-only', '--format=', 'O-1-greet-the-reader').trim(), 'README.md\nnotes.txt\npackage.json\ntest/readme.test.ts');
    assert.deepEqual((await eventsOf(env, 'O-1')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.verdict, record.effective]), [[1, 'clean', 'fix'], [2, 'clean', undefined]]);
  } finally {
    await stop(served);
  }
});

test('a review or gate stored before severity existed reads with every item major', async () => {
  const env = await newEnv('review-old-records');
  const jobs = new JobStore(env.state);
  const item = { path: 'README.md', problem: 'Old.', expected: 'New.' };
  const dir = jobs.iterationDir('app', 'O-1', 1);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'review.json'), JSON.stringify({ reviewer: 'claude', verdict: 'fix', summary: 's', items: [item, { ...item, severity: 'nit' }], accepted_sensitive: [], cost_usd: null, started_at: 'a', ended_at: 'b' }));
  await writeFile(join(dir, 'gate.json'), JSON.stringify({ reviewer: 'codex', verdict: 'fix', summary: 's', items: [item], accepted_sensitive: [], tokens: { input: 0, cached_input: 0, output: 0 }, started_at: 'a', ended_at: 'b' }));
  await writeFile(join(dir, 'gate-override.json'), JSON.stringify({ at: 'a', code: 'gate_rounds', unapplied: [item] }));
  const review = await jobs.readReview('app', 'O-1', 1);
  assert.ok(review !== undefined && 'items' in review);
  assert.deepEqual(review.items, [{ ...item, severity: 'major' }, { ...item, severity: 'nit' }]);
  assert.equal(actedVerdict(review), 'fix');
  const gate = await jobs.readGate('app', 'O-1', 1);
  assert.ok(gate !== undefined && 'items' in gate);
  assert.deepEqual(gate.items, [{ ...item, severity: 'major' }]);
  assert.deepEqual((await jobs.readGateOverride('app', 'O-1', 1))!.unapplied, [{ ...item, severity: 'major' }]);
});

test('one major among nits is a Fix section with the nits as optional; a fix with nits only goes on as clean and its nits reach the MR text', async () => {
  const env = await newEnv('review-nits', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-nits-repo', false);
  await putTask(env, repo, 'N-1', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2\n\n| R1 | fixed | The reader is greeted. |' },
    { write: { '.software-factory/N-1.mr.md': mrText('feat(N-1): Greet the reader') }, text: 'prepared' },
  ]);
  const first = { verdict: 'fix', summary: 'One real problem.', items: [nit('README.md', 'No capital.'), major('README.md', 'It greets the world.')], accepted_sensitive: [] };
  const second = { verdict: 'fix', summary: 'Only nits left.', items: [nit('README.md', 'No capital.'), nit('README.md', 'No  capital.', 'Same.'), nit('a.txt', 'Could say more.')], accepted_sensitive: [] };
  await reviewScript(env, [{ output: first }, { output: second }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'N-1' });
    const ready = await waitFor(served, 'N-1', 'ready_for_human_review', 2);
    assert.equal(await taskFile(repo, 'N-1'), `${task('N-1', 'Greet the reader')}\n\n${[
      '## Fix 1', '', 'Review by Claude: One real problem.', '',
      '1. [R1, major] `README.md`: It greets the world. Expected: Fixed.', '',
      'Nits (optional):',
      '2. [R2, nit] `README.md`: No capital. Expected: Nicer.', '',
    ].join('\n')}`);
    // Recorded as given; the event carries the verdict acted on.
    assert.deepEqual(ready.review, { status: 'done', verdict: 'fix', summary: second.summary });
    const jobs = new JobStore(env.state);
    const recorded = await jobs.readReview('app', 'N-1', 2);
    assert.ok(recorded !== undefined && 'verdict' in recorded);
    assert.deepEqual([recorded.verdict, recorded.items], ['fix', ledgerFields(second.items)]);
    assert.deepEqual((await eventsOf(env, 'N-1')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.verdict, record.effective]), [[1, 'fix', undefined], [2, 'fix', 'clean']]);
    assert.match((await runCli(env, ['watch', 'app', 'N-1', '--once'])).stdout, /^\d\d:\d\d:\d\d \[2\] review by claude: fix \(3 items\), acted on as clean$/m);
    assert.equal((await jobs.read('app', 'N-1'))!.fixes, 1);
    // The nits of the clean iteration, deduplicated, in the Merge request screen's notes, never in the MR text.
    const mr = (await jobs.readMrText('app', 'N-1'))!;
    assert.ok(!mr.includes('### Nits not applied') && !mr.includes('[nit]'), mr);
    assert.equal(await mrNotes(jobs, (await jobs.read('app', 'N-1'))!), [
      '### Nits not applied',
      '- [nit] `README.md`: No capital. Expected: Nicer.',
      '- [nit] `a.txt`: Could say more. Expected: Nicer.',
    ].join('\n'));
  } finally {
    await stop(served);
  }
});

test('a fix with nits only still makes a fix when an undeclared sensitive path is not accepted, whatever severity the reviewer gave it', async () => {
  const env = await newEnv('review-nits-sensitive', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-nits-sensitive-repo', false);
  await putTask(env, repo, 'N-2', 'Add a script');
  await script(env, [
    { write: { 'package.json': '{}\n' }, text: 'iteration 1' },
    { text: 'package.json is needed.' },
    { write: { '.software-factory/N-2.mr.md': mrText('feat(N-2): Add a script') }, text: 'prepared' },
  ]);
  const nitsOnly = { verdict: 'fix', summary: 'Only nits.', items: [nit('package.json', 'Undeclared, but small.')], accepted_sensitive: [] };
  const accepted = { ...CLEAN, summary: 'package.json is accepted: the tests run with npm.', accepted_sensitive: ['package.json'] };
  await reviewScript(env, [{ output: nitsOnly }, { output: accepted }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'N-2' });
    await waitFor(served, 'N-2', 'ready_for_human_review', 2);
    assert.ok((await taskFile(repo, 'N-2')).endsWith([
      '## Fix 1', '', 'Review by Claude: Only nits.', '',
      '1. [R1, major] `package.json`: Undeclared sensitive path. Expected: Remove it, or justify it in the Report.', '',
      'Nits (optional):',
      '2. [R2, nit] `package.json`: Undeclared, but small. Expected: Nicer.', '',
    ].join('\n')));
    assert.deepEqual((await eventsOf(env, 'N-2')).filter((record) => record.type === 'review').map((record) => [record.iteration, record.verdict, record.effective]), [[1, 'fix', undefined], [2, 'clean', undefined]]);
    // The clean iteration had no nits: no list in the MR text.
    assert.ok(!(await new JobStore(env.state).readMrText('app', 'N-2'))!.includes('### Nits not applied'));
  } finally {
    await stop(served);
  }
});

test('a failed review (a turn that is not a success, no output, an invalid verdict, fix without items) is needs_human review_failed', async () => {
  const env = await newEnv('review-failed', { SF_REVIEW: 'on', SF_MAX_JOBS: '4' });
  const repo = await newRepo(env, 'review-failed-repo', false);
  const cases = [
    { review: { subtype: 'error_max_turns' }, message: /^The review ended with error_max_turns: fake review failure$/ },
    { review: { noOutput: true }, message: /^The review returned no structured output\.$/ },
    { review: { output: { ...CLEAN, verdict: 'maybe' } }, message: /^The review returned an invalid verdict: verdict: / },
    { review: { output: { ...FIX, items: [] } }, message: /^The review returned fix without items\.$/ },
  ];
  await script(env, cases.map((_, index) => ({ write: { [`f${index}.txt`]: 'f\n' } })));
  await reviewScript(env, cases.map((entry) => entry.review));
  const served = await serve(env);
  try {
    for (const [index, entry] of cases.entries()) {
      const ticket = `F-${index + 1}`;
      await putTask(env, repo, ticket, `Fail ${index + 1}`);
      await call(served, 'start', { workspace: 'app', ticket });
      const failed = await waitFor(served, ticket, 'needs_human', 1);
      assert.equal(failed.error.code, 'review_failed');
      assert.match(failed.error.message, entry.message);
      assert.deepEqual(failed.review, { status: 'failed', summary: failed.error.message });
      assert.deepEqual(await new JobStore(env.state).readReview('app', ticket, 1), { reviewer: 'claude', error: failed.error.message, review_method: await ownReviewMethod(env, ticket) });
      assert.doesNotMatch(await taskFile(repo, ticket), /## Fix/);
    }
    assert.match((await runCli(env, ['watch', 'app', 'F-2', '--once'])).stdout, /\[1\] review by claude failed: The review returned no structured output\.$/m);
  } finally {
    await stop(served);
  }
});

test('SF_REVIEW=off: the job stays awaiting_review; at the next sf serve with the review on, the iteration without a review gets one', async () => {
  const env = await newEnv('review-off');
  const repo = await newRepo(env, 'review-off-repo', false);
  await putTask(env, repo, 'O-1', 'Off');
  await script(env, [{ write: { 'o.txt': 'o\n' } }, { write: { 'o.txt': 'oo\n' } }]);
  await reviewScript(env, [{ output: FIX }, { delayMs: 5000 }]);
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'O-1' });
    await waitFor(served, 'O-1', 'awaiting_review', 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const off = await call(served, 'check', { workspace: 'app', ticket: 'O-1' });
    assert.deepEqual([off.state, off.review], ['awaiting_review', { status: 'off' }]);
    assert.equal(await exists(join(env.home, 'fake-review.log')), false);
  } finally {
    await stop(served);
  }
  env.extra = { SF_REVIEW: 'on' };
  served = await serve(env);
  try {
    // The review of iteration 1 runs at start: its Fix starts iteration 2, whose review is running.
    const second = await waitFor(served, 'O-1', 'awaiting_review', 2);
    assert.deepEqual(second.review, { status: 'running' });
    assert.ok((await taskFile(repo, 'O-1')).endsWith(`\n\n${FIX_SECTION}`));
    assert.equal((await reviewLog(env)).length, 1);
  } finally {
    await stop(served);
  }
});

test('abort during a running review: the review is cancelled, its outcome never applied, the job stays aborted', async () => {
  const env = await newEnv('review-abort', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-abort-repo', false);
  await putTask(env, repo, 'A-1', 'Abort');
  await script(env, [{ write: { 'a.txt': 'a\n' } }, { text: 'never' }]);
  await reviewScript(env, [{ delayMs: 1500, output: FIX }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'A-1' });
    const waiting = await waitFor(served, 'A-1', 'awaiting_review', 1);
    assert.deepEqual(waiting.review, { status: 'running' });
    const aborted = await runCli(env, ['abort', 'app', 'A-1']);
    assert.equal(aborted.code, 0, aborted.stderr);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const checked = await call(served, 'check', { workspace: 'app', ticket: 'A-1' });
    assert.deepEqual([checked.state, checked.iteration, checked.review], ['aborted', 1, undefined]);
    assert.equal(await new JobStore(env.state).readReview('app', 'A-1', 1), undefined);
    assert.doesNotMatch(await taskFile(repo, 'A-1'), /## Fix/);
    assert.equal((await eventsOf(env, 'A-1')).filter((record) => (record.type === 'review' || record.type === 'review_failed')).length, 0);
    assert.equal((await fakeLog(env)).length, 1);
  } finally {
    await stop(served);
  }
});

test('SF_MAX_ITERATIONS=1 counts rounds without progress: an sf say turn and one Fix are allowed, the round after it, with no fewer open findings, is refused; a review the job outran is not applied', async () => {
  const env = await newEnv('review-limit', { SF_REVIEW: 'on', SF_MAX_ITERATIONS: '1' });
  const repo = await newRepo(env, 'review-limit-repo', false);
  await putTask(env, repo, 'L-1', 'Limit');
  await script(env, [{ write: { 'a.txt': '1\n' } }, { write: { 'a.txt': '2\n' }, text: 'said' }, { write: { 'a.txt': '3\n' }, text: 'fixed' }]);
  await reviewScript(env, [{ delayMs: 1500, output: FIX }, { output: FIX }, { output: FIX }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'L-1' });
    await waitFor(served, 'L-1', 'awaiting_review', 1);
    // The review of iteration 1 still runs: the user's message moves the job on.
    const said = await runCli(env, ['say', 'app', 'L-1', 'also', 'this']);
    assert.equal(said.code, 0, said.stderr);
    const limited = await waitFor(served, 'L-1', 'needs_human', 3);
    // The open blocker and major findings: the refused Fix's new one, raised by the last review, and
    // R1 of Fix 2, carried (its Report answered nothing).
    assert.deepEqual(limited.error, { code: 'iteration_limit', message: iterationLimitMessage(1, 1, { open: 2, raised: 1, reopened: 0, progress: false, least: 1 }, 3) });
    const text = await taskFile(repo, 'L-1');
    assert.deepEqual(text.match(/^## Fix \d+$/gm), ['## Fix 2']);
    assert.equal((await new JobStore(env.state).read('app', 'L-1'))!.fixes, 1);
    assert.deepEqual((await fakeLog(env)).map((entry) => entry.prompt.split('\n')[0]), ['/implement .software-factory/L-1.md', 'also this', '/implement .software-factory/L-1.md Fix 2']);
    // Iteration 1's review was cancelled by the next one, or recorded as ignored; never applied.
    const reviews = (await eventsOf(env, 'L-1')).filter((record) => record.type === 'review');
    assert.deepEqual(reviews.filter((record) => record.ignored !== true).map((record) => record.iteration), [2, 3]);
  } finally {
    await stop(served);
  }
});

test('the review schema is draft-07 without $schema; the fake refuses a $schema the CLI does not know, as the CLI does', async () => {
  assert.equal(REVIEW_SCHEMA.$schema, undefined);
  assert.doesNotMatch(JSON.stringify(REVIEW_SCHEMA), /2020-12|prefixItems|\$defs|unevaluated|dependentRequired|dependentSchemas/);
  assert.deepEqual(REVIEW_SCHEMA.required, ['verdict', 'summary', 'items', 'accepted_sensitive']);
  assert.equal(REVIEW_SCHEMA.additionalProperties, false);
  const env = await newEnv('review-schema');
  const runFake = (schema: Record<string, unknown>): { status: number | null; stderr: string } =>
    spawnSync(process.execPath, [FAKE, '--json-schema', JSON.stringify(schema)], { env: { PATH: process.env.PATH, HOME: env.home }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  const refused = runFake({ ...REVIEW_SCHEMA, $schema: 'https://json-schema.org/draft/2020-12/schema' });
  assert.deepEqual([refused.status, refused.stderr], [1, 'Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"\n']);
  for (const schema of [REVIEW_SCHEMA, { ...REVIEW_SCHEMA, $schema: 'http://json-schema.org/draft-07/schema#' }]) {
    const accepted = runFake(schema);
    assert.deepEqual([accepted.status, accepted.stderr], [0, '']);
  }
});

test('retry a failed review: sf review and the dashboard put the job back to awaiting_review and review the same iteration again; refused in other states and with the review off', async () => {
  const env = await newEnv('review-retry', { SF_REVIEW: 'on' });
  const repo = await newRepo(env, 'review-retry-repo', false);
  await putTask(env, repo, 'R-2', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2\n\n| R1 | fixed | The reader is greeted. |' },
    { write: { '.software-factory/R-2.mr.md': mrText('feat(R-2): Greet the reader') }, text: 'prepared' },
  ]);
  await reviewScript(env, [{ subtype: 'error_max_turns' }, { noOutput: true }, { output: FIX }, { output: CLEAN }]);
  const jobs = new JobStore(env.state);
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-2' });
    const failed = await waitFor(served, 'R-2', 'needs_human', 1);
    assert.equal(failed.error.code, 'review_failed');
  } finally {
    await stop(served);
  }

  // With the review off nothing would review it: refused, the job as it was.
  env.extra = { SF_REVIEW: 'off' };
  served = await serve(env);
  try {
    const off = await runCli(env, ['review', 'app', 'R-2']);
    assert.equal(off.code, 1);
    assert.match(off.stderr, /The Claude review is off \(SF_REVIEW=off\)/);
    assert.equal((await jobs.read('app', 'R-2'))!.state, 'needs_human');
  } finally {
    await stop(served);
  }

  env.extra = { SF_REVIEW: 'on' };
  served = await serve(env);
  try {
    // sf review: the same iteration, the error cleared; the second review fails too.
    const retried = await runCli(env, ['review', 'app', 'R-2']);
    assert.equal(retried.code, 0, retried.stderr);
    assert.match(retried.stdout, /^state: awaiting_review\niteration: 1$/m);
    const again = await waitFor(served, 'R-2', 'needs_human', 1);
    assert.equal(again.error.message, 'The review returned no structured output.');
    assert.deepEqual(await jobs.readReview('app', 'R-2', 1), { reviewer: 'claude', error: again.error.message, review_method: await ownReviewMethod(env, 'R-2') });

    // The dashboard's route: the third review's fix starts iteration 2, whose review is clean.
    const reply = await act(served.dashboard!, 'api/jobs/app/R-2/review', {});
    assert.equal(reply.status, 200, reply.body);
    assert.deepEqual(JSON.parse(reply.body).result, { state: 'awaiting_review', iteration: 1 });
    await waitFor(served, 'R-2', 'ready_for_human_review', 2);
    assert.equal(await taskFile(repo, 'R-2'), `${task('R-2', 'Greet the reader')}\n\n${FIX_SECTION}`);
    const recorded = await jobs.readReview('app', 'R-2', 1);
    assert.ok(recorded !== undefined && 'verdict' in recorded && recorded.verdict === 'fix');
    assert.equal((await reviewLog(env)).length, 4);
    assert.deepEqual((await reviewLog(env)).map((entry) => entry.prompt.split('\n')[0]), [1, 1, 1, 2].map((n) => `Code review of iteration ${n} of ticket R-2. You review; you change nothing.`));
    const events = await eventsOf(env, 'R-2');
    assert.deepEqual(events.filter((record) => (record.type === 'review' || record.type === 'review_failed')).map((record) => [record.iteration, record.type, record.verdict]), [
      [1, 'review_failed', undefined], [1, 'review_failed', undefined], [1, 'review', 'fix'], [2, 'review', 'clean'],
    ]);
    const retries = events.filter((record) => (record.state as { from?: string } | undefined)?.from === 'needs_human');
    assert.deepEqual(retries.map((record) => [record.iteration, (record.state as { to: string }).to, 'error' in (record.state as object)]), [[1, 'awaiting_review', false], [1, 'awaiting_review', false]]);

    // Any other state is refused, by sf review and by the route.
    const ready = await runCli(env, ['review', 'app', 'R-2']);
    assert.equal(ready.code, 1);
    assert.match(ready.stderr, /sf review needs needs_human after a failed review \(review_failed\); the job is ready_for_human_review\./);
    const refusedRoute = await act(served.dashboard!, 'api/jobs/app/R-2/review', {});
    assert.deepEqual([refusedRoute.status, JSON.parse(refusedRoute.body).error.code], [409, 'invalid_state']);
    assert.equal((await reviewLog(env)).length, 4);
  } finally {
    await stop(served);
  }
});

test('runReview with images (SF-065): the session\'s user message is the review prompt, then each image named and its block, in order; without images the prompt alone', async () => {
  const env = await newEnv('review-images');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
  const gif = Buffer.from('GIF89a-gif-body');
  await writeFile(join(env.home, '1.png'), png);
  await writeFile(join(env.home, 'form.gif'), gif);
  const clean = { verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [] };
  await reviewScript(env, [{ output: clean }, { output: clean }]);
  const images = [
    { ticket: 'T-1', name: 'form.gif', alt: 'the form', type: 'image/gif' as const, path: join(env.home, 'form.gif') },
    { ticket: 'T-1', name: '1.png', alt: '', type: 'image/png' as const, path: join(env.home, '1.png') },
  ];
  const home = process.env.HOME;
  process.env.HOME = env.home;
  try {
    const options = { cwd: env.home, claudePath: FAKE, sandbox: undefined, model: undefined, maxTurns: 3, signal: new AbortController().signal };
    assert.equal((await runReview('Review this.', { ...options, images })).ok, true);
    assert.equal((await runReview('Review this.', options)).ok, true);
  } finally {
    process.env.HOME = home;
  }
  const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
  const [withImages, without] = await reviewLog(env);
  assert.deepEqual(withImages!.blocks, [
    { type: 'text', text: 'Review this.' },
    { type: 'text', text: 'Image T-1/form.gif ("the form"), referenced in the Task file:' },
    { type: 'image', media_type: 'image/gif', bytes: gif.length, sha256: sha(gif) },
    { type: 'text', text: 'Image T-1/1.png (""), referenced in the Task file:' },
    { type: 'image', media_type: 'image/png', bytes: png.length, sha256: sha(png) },
  ]);
  assert.deepEqual([without!.prompt, without!.blocks], ['Review this.', undefined]);
});

test('redacted (SF-125): a review finding holding an environment value is stored in review.json, the ledger, the Fix section and the next prompts as [redacted]; its path and severity stay', async () => {
  const secret = 'review-secret-0123456789';
  const env = await newEnv('review-redacted', { SF_REVIEW: 'on', APP_DEPLOY_VALUE: secret });
  const repo = await newRepo(env, 'review-redacted-repo', false);
  await putTask(env, repo, 'R-9', 'Greet the reader');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, text: 'Report of iteration 1' },
    { write: { 'README.md': 'hello reader\n' }, text: 'Report of iteration 2\n\n| R1 | fixed | Done. |' },
    { write: { '.software-factory/R-9.mr.md': mrText('feat(R-9): Greet the reader') }, text: 'prepared' },
  ]);
  const leaky = { ...FIX, summary: `It prints ${secret}.`, items: [{ ...FIX.items[0]!, problem: `It prints ${secret}.`, expected: `No ${secret} in it.` }] };
  await reviewScript(env, [{ output: leaky }, { output: CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'R-9' });
    await waitFor(served, 'R-9', 'ready_for_human_review', 2);
    const jobs = new JobStore(env.state);
    const record = await jobs.readReview('app', 'R-9', 1);
    assert.ok(record !== undefined && 'verdict' in record, JSON.stringify(record));
    assert.equal(record.summary, 'It prints [redacted].');
    assert.deepEqual(record.items, ledgerFields([{ path: 'README.md', problem: 'It prints [redacted].', expected: 'No [redacted] in it.', severity: 'major' }]));
    assert.ok(!(await readFile(join(jobs.iterationDir('app', 'R-9', 1), 'review.json'), 'utf8')).includes(secret));
    const fix = '1. [R1, major] `README.md`: It prints [redacted]. Expected: No [redacted] in it.';
    assert.ok((await taskFile(repo, 'R-9')).includes(fix));
    const prompts = (await fakeLog(env)).map((entry) => entry.prompt);
    assert.ok(prompts.length === 3 && prompts.every((prompt) => !prompt.includes(secret)));
    // The second review read the Task file with the redacted Fix section.
    const reviews = await reviewLog(env);
    assert.ok(reviews[1]!.prompt.includes(fix) && reviews.every((review) => !review.prompt.includes(secret)));
    assert.ok(!(await readFile(join(env.state, 'jobs', 'app', 'R-9', 'ledger.json'), 'utf8')).includes(secret));
  } finally {
    await stop(served);
  }
});
