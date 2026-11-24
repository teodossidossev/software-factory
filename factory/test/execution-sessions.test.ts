// End-to-end execution tests, the Implementer's session: permission_mode_mismatch and its restart,
// the smoke's session (dontAsk with the probe rule) against a real job's, the allowedTools, the
// tool allow list without MCP, the init assertion, and the session of a fix round (SF-316: resume or
// fresh, with the fresh round's pack and the costs per session). The real `sf serve` and `sf` CLI with
// private config and state directories, throwaway Git repositories and the fake Claude Code as the Implementer executable, as in
// test/execution.test.ts (split so that no file runs near run-tests' per-file limit).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { addAttachment } from '../src/attachments.js';
import { changedFileLine, freshFixPrompt } from '../src/execution/prompts.js';
import { JobStore } from '../src/jobs.js';
import { factoryPrompt } from '../src/prompts.js';
import { prepareClaudeState } from '../src/session-wrapper.js';
import { rolesOf } from '../src/skill-roles.js';
import { initToolsProblem } from '../src/live-smoke.js';
import { DENIED_TOOLS, IMPLEMENTER_TOOLS } from '../src/rules.js';
import { IMPLEMENTER_SESSION_TOOLS, SESSION_SHELL_ENV, SMOKE_PROBE_RULE, SMOKE_TOOLS, sessionAllowedTools } from '../src/session.js';
import { bwrapLog, call, type Env, FAKE_SKILLS, fakeLog, implementerRun, newEnv, newRepo, putRules, putTask, refused, runCli, script, serve, skillsSourceDir, stop, temp, waitFor, jobPrompt } from './support/harness.js';

// Each role's list a job's skills event records without a choice.
const DEFAULT_ROLES = rolesOf(undefined);

test('permission_mode_mismatch ends in needs_human; a restart turns working jobs into needs_human and sf say resumes them', async () => {
  const env = await newEnv('restart');
  const repo = await newRepo(env, 'restart-repo', false);
  await putTask(env, repo, 'M-1', 'Mismatch');
  await script(env, [{ permissionMode: 'default' }, { text: 'resumed report' }]);
  let served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'M-1' });
  const mismatch = await waitFor(served, 'M-1', 'needs_human');
  assert.equal(mismatch.error.code, 'permission_mode_mismatch');
  assert.equal(mismatch.iteration, 0);
  assert.deepEqual([mismatch.report, mismatch.patch], [undefined, undefined]);
  // A crash leaves the socket behind; the next sf serve replaces it.
  await stop(served, 'SIGKILL');
  assert.ok((await stat(join(env.state, 'sf.sock'))).isSocket());

  // A job left "working" by a stopped server, with a session to resume.
  const jobs = new JobStore(env.state);
  const job = (await jobs.read('app', 'M-1'))!;
  await jobs.write({ ...job, state: 'working', session_id: 'kept-session', error: undefined });
  served = await serve(env);
  const restarted = await call(served, 'check', { workspace: 'app', ticket: 'M-1' });
  assert.deepEqual([restarted.state, restarted.error?.code], ['needs_human', 'serve_restarted']);
  assert.equal((await jobs.read('app', 'M-1'))!.session_id, 'kept-session');

  assert.equal((await runCli(env, ['say', 'app', 'M-1', 'please', 'continue'])).code, 0);
  const resumed = await waitFor(served, 'M-1', 'awaiting_review', 1);
  assert.match(resumed.report, /^resumed report\n/);
  const log = await fakeLog(env);
  assert.equal(log[1]!.prompt, await jobPrompt(env, 'please continue', 'M-1', 1));
  assert.ok(log[1]!.argv.includes('--resume=kept-session'));
  await stop(served);
});

// SF-316: the usage limit a turn ends with, and a Task file that refers to one image.
const CLAUDE_LIMIT = { subtype: 'error_during_execution', errors: ["You've hit your 5-hour limit · resets 3am (Europe/Sofia)"] };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const PNG2 = Buffer.concat([PNG, Buffer.from('-second')]);
const PNG3 = Buffer.concat([PNG, Buffer.from('-third')]);
const GIF = Buffer.from('GIF89a-gif-body');

// Waits until the job is parked on the usage limit.
async function parked(env: Env, ticket: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while ((await new JobStore(env.state).read('app', ticket))?.state !== 'waiting_limit') {
    assert.ok(Date.now() < deadline, `timed out waiting for ${ticket} to park`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('SF_FIX_SESSION=resume (SF-316, the default arm): a fix round resumes the job\'s session with today\'s prompt; a Resume after a usage-limit park keeps the session; the costs subtract within the session', async () => {
  const env = await newEnv('fix-session-resume');
  const repo = await newRepo(env, 'fix-session-resume-repo', false);
  await putTask(env, repo, 'F-1', 'Resume');
  await script(env, [
    { write: { 'a.txt': 'a\n' }, costTotal: 0.25 },
    { write: { 'a.txt': 'b\n' }, costTotal: 0.4 },
    CLAUDE_LIMIT,
    { write: { 'a.txt': 'c\n' }, costTotal: 0.7 },
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'F-1' });
    await waitFor(served, 'F-1', 'awaiting_review', 1);
    // The Task file changes while the job waits: the fix round carries the change note, as before.
    const taskPath = join(repo, '.software-factory', 'F-1.md');
    await writeFile(taskPath, `${await readFile(taskPath, 'utf8')}\nOne more line.\n`);
    await call(served, 'request_fix', { workspace: 'app', ticket: 'F-1', content: '1. a.txt: again.' });
    await waitFor(served, 'F-1', 'awaiting_review', 2);
    await call(served, 'request_fix', { workspace: 'app', ticket: 'F-1', content: '1. a.txt: once more.' });
    await parked(env, 'F-1');
    assert.equal((await runCli(env, ['resume', 'app', 'F-1'])).code, 0);
    await waitFor(served, 'F-1', 'awaiting_review', 3);
  } finally {
    await stop(served);
  }
  const jobs = new JobStore(env.state);
  const job = (await jobs.read('app', 'F-1'))!;
  assert.equal(job.fix_session, 'resume');
  assert.deepEqual([job.session_cost_usd, job.unpublished_cost_usd], [undefined, undefined]);
  const log = await fakeLog(env);
  const prompts = log.map((entry) => entry.prompt);
  assert.deepEqual([prompts[0], ...prompts.slice(2)], [
    await jobPrompt(env, '/implement .software-factory/F-1.md', 'F-1', 1),
    await jobPrompt(env, '/implement .software-factory/F-1.md Fix 2', 'F-1', 3),
    await jobPrompt(env, 'Continue where you stopped.', 'F-1', 3),
  ]);
  assert.ok(prompts[1]!.startsWith('/implement .software-factory/F-1.md Fix 1\n\nThe Task file .software-factory/F-1.md changed since you were last given it'), prompts[1]);
  assert.match(prompts[1]!, /^\+One more line\.$/m);
  assert.doesNotMatch(prompts[1]!, /<previous_report|<changed_files>/);
  // One session throughout.
  assert.ok(log.every((entry) => entry.sessionId === log[0]!.sessionId));
  assert.deepEqual(log.slice(1).map((entry) => entry.argv.includes(`--resume=${log[0]!.sessionId}`)), [true, true, true]);
  const metas = await Promise.all([1, 2, 3].map((n) => jobs.readMeta('app', 'F-1', n)));
  assert.deepEqual(metas.map((meta) => [meta.session_id, meta.cost_usd, meta.cost_usd_total]), [[log[0]!.sessionId, 0.25, 0.25], [log[0]!.sessionId, 0.15, 0.4], [log[0]!.sessionId, 0.3, 0.7]]);
});

test('SF_FIX_SESSION=fresh (SF-316): a fix round starts a new session with the pack (rules, the images the Task refers to now, previous Report, changed files) and no change note; an image that cannot be used refuses it; sf say continues that session; a Resume after a usage-limit park keeps it; the costs are per session, an ended session\'s unpublished spend carried', async () => {
  const env = await newEnv('fix-session-fresh', { SF_FIX_SESSION: 'fresh' });
  const repo = await newRepo(env, 'fix-session-fresh-repo', false);
  const rules = await putRules(env, repo);
  const workspace = { name: 'app', readCheckout: repo, workCheckout: repo };
  const jobs = new JobStore(env.state);
  await putTask(env, repo, 'F-1', 'Fresh');
  await addAttachment(workspace, 'F-1', PNG, jobs);
  const taskPath = join(repo, '.software-factory', 'F-1.md');
  await writeFile(taskPath, `${await readFile(taskPath, 'utf8')}\nSee ![the error](F-1/1.png).\n`);
  await script(env, [
    { write: { 'README.md': 'hello fresh\n', 'new.txt': 'new\n' }, text: '# Report: F-1, iteration 1\n\nFirst.', costTotal: 0.25 },
    { write: { 'new.txt': 'newer\n' }, text: '# Report: F-1, iteration 2\n\nSecond.', costTotal: 0.5 },
    { write: { 'new.txt': 'newest\n' }, text: 'Third.', costTotal: 0.6 },
    CLAUDE_LIMIT,
    { write: { 'new.txt': 'last\n' }, text: 'Fourth.', costTotal: 0.2 },
  ]);
  let served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'F-1' });
    await waitFor(served, 'F-1', 'awaiting_review', 1);
    // An image that cannot be used refuses the Fix, as it refuses a Resume: nothing is written and
    // no turn starts.
    await writeFile(join(repo, '.software-factory', 'F-1', '1.png'), GIF);
    const refusal = await refused(served, 'request_fix', { workspace: 'app', ticket: 'F-1', content: '1. new.txt: again.' });
    assert.equal(refusal.code, 'attachment_invalid');
    assert.match(refusal.message, /F-1\/1\.png: not the image its name says/);
    const held = (await jobs.read('app', 'F-1'))!;
    assert.deepEqual([held.state, held.iteration, held.fixes, held.session_id], ['awaiting_review', 1, 0, (await fakeLog(env))[0]!.sessionId]);
    assert.doesNotMatch(await readFile(taskPath, 'utf8'), /## Fix 1/);
    assert.equal((await fakeLog(env)).length, 1);
    // The Task file changes while the job waits: a resume fix round would carry the change note. Its
    // image 1.png is replaced and it refers to a new one, 2.png.
    await writeFile(join(repo, '.software-factory', 'F-1', '1.png'), PNG2);
    await writeFile(join(repo, '.software-factory', 'F-1', '2.png'), PNG3);
    await writeFile(taskPath, `${await readFile(taskPath, 'utf8')}\nOne more line, and ![the form](F-1/2.png).\n`);
    await call(served, 'request_fix', { workspace: 'app', ticket: 'F-1', content: '1. new.txt: again.' });
    await waitFor(served, 'F-1', 'awaiting_review', 2);
    assert.equal((await runCli(env, ['say', 'app', 'F-1', 'go', 'on'])).code, 0);
    await waitFor(served, 'F-1', 'awaiting_review', 3);
  } finally {
    await stop(served);
  }
  let log = await fakeLog(env);
  const base = (await jobs.read('app', 'F-1'))!.base_commit;
  const worktree = (await jobs.read('app', 'F-1'))!.worktree!;
  const imagesLine = { dir: join(worktree, '.software-factory', 'F-1'), names: ['1.png', '2.png'] };
  const first = await jobs.readIteration('app', 'F-1', 1);
  const meta1 = await jobs.readMeta('app', 'F-1', 1);
  assert.deepEqual(meta1.files!.map(changedFileLine).sort(), ['A new.txt', 'M README.md']);
  const fixPrompt = factoryPrompt(freshFixPrompt('/implement .software-factory/F-1.md Fix 1', rules, { iteration: 1, report: first.report, files: meta1.files! }, base), 'F-1', 2, imagesLine, base);
  // The prompt is the first block, then the Task's images as it refers to them now: the replaced
  // one's new bytes and the added one; their copies and records follow.
  const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
  assert.deepEqual(log[1]!.blocks, [
    { type: 'text', text: fixPrompt },
    { type: 'text', text: 'Image F-1/1.png ("the error"), referenced in the Task file:' },
    { type: 'image', media_type: 'image/png', bytes: PNG2.length, sha256: sha(PNG2) },
    { type: 'text', text: 'Image F-1/2.png ("the form"), referenced in the Task file:' },
    { type: 'image', media_type: 'image/png', bytes: PNG3.length, sha256: sha(PNG3) },
  ]);
  assert.deepEqual((await jobs.read('app', 'F-1'))!.attachments, [
    { name: '1.png', type: 'image/png', bytes: PNG2.length, sha256: sha(PNG2) }, { name: '2.png', type: 'image/png', bytes: PNG3.length, sha256: sha(PNG3) },
  ]);
  assert.deepEqual(await readFile(join(worktree, '.software-factory', 'F-1', '2.png')), PNG3);
  assert.deepEqual(await readFile(join(jobs.dir('app', 'F-1'), 'attachments', '1.png')), PNG2);
  assert.doesNotMatch(fixPrompt, /changed since you were last given it/);
  assert.match(fixPrompt, /<previous_report iteration="1">\n# Report: F-1, iteration 1\n\nFirst\./);
  // The fix round's session is new; sf say continues it, with the message alone.
  assert.ok(!log[1]!.argv.some((arg) => arg.startsWith('--resume')));
  assert.notEqual(log[1]!.sessionId, log[0]!.sessionId);
  assert.ok(log[2]!.argv.includes(`--resume=${log[1]!.sessionId}`));
  assert.equal(log[2]!.prompt, await jobPrompt(env, 'go on', 'F-1', 3, imagesLine));

  // An MR-preparation turn of the second session that published nothing, as job.json records it.
  const waiting = (await jobs.read('app', 'F-1'))!;
  assert.deepEqual(waiting.session_cost_usd, { session_id: log[1]!.sessionId, usd: 0.6 });
  await jobs.write({ ...waiting, session_cost_usd: { session_id: log[1]!.sessionId, usd: 0.75 } });
  served = await serve(env);
  try {
    await call(served, 'request_fix', { workspace: 'app', ticket: 'F-1', content: '1. new.txt: last.' });
    await parked(env, 'F-1');
    log = await fakeLog(env);
    // The ended session's spend after iteration 3 waits for the next published iteration.
    const atPark = (await jobs.read('app', 'F-1'))!;
    assert.deepEqual([atPark.session_id, atPark.session_cost_usd, atPark.unpublished_cost_usd], [log[3]!.sessionId, undefined, 0.15]);
    assert.ok(!log[3]!.argv.some((arg) => arg.startsWith('--resume')));
    assert.equal((await runCli(env, ['resume', 'app', 'F-1'])).code, 0);
    await waitFor(served, 'F-1', 'awaiting_review', 4);
  } finally {
    await stop(served);
  }
  log = await fakeLog(env);
  // The Resume after the park continues the fix round's new session.
  assert.ok(log[4]!.argv.includes(`--resume=${log[3]!.sessionId}`));
  assert.equal(log[4]!.prompt, await jobPrompt(env, 'Continue where you stopped.', 'F-1', 4, imagesLine));
  const metas = await Promise.all([1, 2, 3, 4].map((n) => jobs.readMeta('app', 'F-1', n)));
  assert.deepEqual(metas.map((meta) => [meta.session_id, meta.cost_usd, meta.cost_usd_total]), [
    [log[0]!.sessionId, 0.25, 0.25],
    // A second session costing more than the first's total: its own total.
    [log[1]!.sessionId, 0.5, 0.5],
    [log[1]!.sessionId, 0.1, 0.6],
    // The third session's total plus the second's unpublished 0.15.
    [log[3]!.sessionId, 0.35, 0.2],
  ]);
  const done = (await jobs.read('app', 'F-1'))!;
  assert.deepEqual([done.fix_session, done.unpublished_cost_usd, done.session_cost_usd], ['fresh', 0, { session_id: log[3]!.sessionId, usd: 0.2 }]);
});

test('the smoke\'s session (SF-104, SF-109, SF-110): an sf serve whose state directory is laid out as sf smoke makes it runs the Implementer in dontAsk with exactly Bash(node probe.mjs:*) and the file tools in allowedTools; a real job stays in auto without allowedTools, and the sandbox, the path denials, the setting sources and the disallowed tools are equal for the same paths', async () => {
  const command = "node probe.mjs --canary '/x/config/auth.env' --job smoke > probe.json";
  // <TMPDIR>/sf-smoke-<suffix>/state, as sf smoke makes it; the sandbox on, as in a real job.
  const env = await newEnv('sf-smoke-exec', { TMPDIR: temp, SF_SMOKE_PROBE_ALLOW: command });
  const repo = await newRepo(env, 'sf-smoke-exec-repo', true);
  await putTask(env, repo, 'P-1', 'Probe');
  await script(env, [{ text: '# Report: P-1, iteration 1' }, { text: '# Report: P-1, iteration 2' }]);
  // The ticket history, which request_fix creates, exists for both turns: the same paths to deny
  // (a missing path is left out of the denials).
  await mkdir(join(env.state, 'tickets'), { recursive: true });
  // The fake's count and log, which its first run creates in the home: there for both turns too,
  // as the home's entries are denied to Bash (SF-123).
  await writeFile(join(env.home, 'fake-claude.count'), '0');
  await writeFile(join(env.home, 'fake-claude.log'), '');
  // So are the fake bwrap's log and the Claude Code state the Implementer's wrapper makes before its
  // first run (SF-181): its folders, its credentials and its global config.
  await writeFile(join(env.home, 'fake-bwrap.log'), '');
  await prepareClaudeState(join(env.home, '.claude'), join(env.home, '.claude.json'));
  let served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
  await waitFor(served, 'P-1', 'awaiting_review', 1);
  await stop(served);
  // The same job's next turn from an sf serve without the setting: a real job's options, same paths.
  delete env.extra!.SF_SMOKE_PROBE_ALLOW;
  served = await serve(env);
  await call(served, 'request_fix', { workspace: 'app', ticket: 'P-1', content: '1. Again.' });
  await waitFor(served, 'P-1', 'awaiting_review', 2);
  await stop(served);

  const [smokeLogged, realLogged] = await fakeLog(env);
  // Each session has a temporary folder of its own (CLAUDE_CODE_TMPDIR), read back by its sandbox:
  // the same place in both argv once named alike.
  const own = (entry: typeof smokeLogged): typeof smokeLogged => ({ ...entry!, argv: entry!.argv.map((arg) => arg.split(entry!.tmpdir!.path).join('<session tmp>')) });
  assert.notEqual(smokeLogged!.tmpdir!.path, realLogged!.tmpdir!.path);
  const [smoke, real] = [own(smokeLogged), own(realLogged)];
  const allowed = (argv: string[]): string[] => argv.filter((arg) => arg.startsWith('--allowedTools'));
  assert.deepEqual(allowed(smoke!.argv), ['--allowedTools=Bash(node probe.mjs:*),Read,Edit,Write,Glob,Grep,TodoWrite']);
  assert.deepEqual(allowed(real!.argv), []);
  const mode = (argv: string[]): string[] => argv.filter((arg) => arg.startsWith('--permission-mode'));
  assert.deepEqual(mode(smoke!.argv), ['--permission-mode=dontAsk']);
  assert.deepEqual(mode(real!.argv), ['--permission-mode=auto']);
  // Everything else of the two sessions' argv is the same, but the real turn's resume.
  const rest = (argv: string[]): string[] => argv.filter((arg) => !/^--(allowedTools|permission-mode|resume)\b/.test(arg));
  assert.deepEqual(rest(smoke!.argv), rest(real!.argv));
  assert.ok(smoke!.argv.includes('--setting-sources=user,project'));
  assert.ok(real!.argv.includes(`--resume=${smoke!.sessionId}`));
  const sandbox = (argv: string[]): Record<string, unknown> => (JSON.parse(argv[argv.indexOf('--settings') + 1]!) as { sandbox: Record<string, unknown> }).sandbox;
  const denied = (argv: string[]): string | undefined => argv.find((arg) => arg.startsWith('--disallowedTools='));
  assert.deepEqual(sandbox(smoke!.argv), sandbox(real!.argv));
  assert.deepEqual([sandbox(smoke!.argv).enabled, sandbox(smoke!.argv).allowUnsandboxedCommands], [true, false]);
  assert.ok((sandbox(smoke!.argv).filesystem as { denyRead: string[] }).denyRead.length > 0);
  assert.equal(denied(smoke!.argv), denied(real!.argv));
  assert.ok(denied(smoke!.argv)?.includes('Bash(git commit:*)'));
  // Both sessions: the allowed tools only and no MCP server (strict, no --mcp-config); the init
  // messages the factory records list nothing else.
  // Both, through the wrapper (SF-196): no background task, a 20-minute Bash default and a 60-minute cap.
  for (const entry of [smoke!, real!]) {
    assert.deepEqual(entry.argv.filter((arg) => /^--(tools|strict-mcp-config|mcp-config)\b/.test(arg)), [`--tools=${IMPLEMENTER_TOOLS.join(',')}`, '--strict-mcp-config']);
    assert.deepEqual(entry.shell, { BASH_DEFAULT_TIMEOUT_MS: '1200000', BASH_MAX_TIMEOUT_MS: '3600000', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
  }
  assert.deepEqual(SESSION_SHELL_ENV, smoke!.shell);
  const events = await readFile(join(env.state, 'jobs', 'app', 'P-1', 'events.jsonl'), 'utf8');
  const inits = events.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line).message).filter((message) => message?.type === 'system' && message.subtype === 'init');
  assert.deepEqual(inits.map((message) => message.tools), [IMPLEMENTER_TOOLS, IMPLEMENTER_TOOLS]);
  assert.equal(initToolsProblem(events), undefined);
});

test('the Implementer\'s tools: IMPLEMENTER_TOOLS only, no MCP server; DENIED_TOOLS keeps the web, worktree and MCP tools out', () => {
  assert.deepEqual(IMPLEMENTER_SESSION_TOOLS, { tools: IMPLEMENTER_TOOLS, strictMcpConfig: true, mcpServers: {} });
  assert.deepEqual(IMPLEMENTER_TOOLS, ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'Skill', 'Task', 'Agent', 'TodoWrite', 'ToolSearch']);
  // No background task to watch or stop (SF-196): TaskOutput, TaskStop and Monitor are denied by name.
  for (const tool of ['EnterWorktree', 'WebFetch', 'WebSearch', 'mcp__*', 'Workflow', 'CronCreate', 'SendMessage', 'ExitWorktree', 'Monitor', 'TaskOutput', 'TaskStop']) {
    assert.ok(DENIED_TOOLS.includes(tool) && !IMPLEMENTER_TOOLS.includes(tool), tool);
  }
  // The smoke's allowed file tools are among them.
  assert.ok(SMOKE_TOOLS.every((tool) => IMPLEMENTER_TOOLS.includes(tool)));
});

test('the allowedTools of a session (SF-104, SF-109, SF-110): a smoke session with the probe has exactly the prefix rule and the file tools; a real job none; allowCommands without smokeMode the exact rules', () => {
  const command = "node probe.mjs --canary '/x/config/auth.env' > probe.json";
  assert.equal(SMOKE_PROBE_RULE, 'Bash(node probe.mjs:*)');
  assert.deepEqual(sessionAllowedTools({ allowCommands: [command], smokeMode: true }), [SMOKE_PROBE_RULE, ...SMOKE_TOOLS]);
  assert.deepEqual(sessionAllowedTools({ allowCommands: [command, 'node probe.mjs --job smoke'], smokeMode: true }), [SMOKE_PROBE_RULE, ...SMOKE_TOOLS]);
  assert.deepEqual(sessionAllowedTools({ allowCommands: undefined, smokeMode: false }), []);
  assert.deepEqual(sessionAllowedTools({}), []);
  assert.deepEqual(sessionAllowedTools({ allowCommands: [command], smokeMode: false }), [`Bash(${command})`]);
  assert.deepEqual(sessionAllowedTools({ allowCommands: [command] }), [`Bash(${command})`]);
  // A smoke session without a command: the file tools only, no probe rule.
  assert.deepEqual(sessionAllowedTools({ smokeMode: true }), [...SMOKE_TOOLS]);
});

test('the init assertion (SF-109): a smoke session reporting auto and a real one reporting dontAsk fail with permission_mode_mismatch; each reporting its own mode records the session id', async () => {
  const command = 'node probe.mjs --job smoke > probe.json';
  const cases: Array<{ name: string; extra: Record<string, string>; reported: string; expected: string }> = [
    { name: 'sf-smoke-mode-a', extra: { TMPDIR: temp, SF_SMOKE_PROBE_ALLOW: command }, reported: 'auto', expected: 'dontAsk' },
    { name: 'mode-real-a', extra: {}, reported: 'dontAsk', expected: 'auto' },
    { name: 'sf-smoke-mode-b', extra: { TMPDIR: temp, SF_SMOKE_PROBE_ALLOW: command }, reported: 'dontAsk', expected: 'dontAsk' },
    { name: 'mode-real-b', extra: {}, reported: 'auto', expected: 'auto' },
  ];
  for (const { name, extra, reported, expected } of cases) {
    const env = await newEnv(name, extra);
    const repo = await newRepo(env, `${name}-repo`, false);
    await putTask(env, repo, 'M-1', 'Mode');
    await script(env, [{ permissionMode: reported, text: '# Report: M-1, iteration 1' }]);
    const served = await serve(env);
    await call(served, 'start', { workspace: 'app', ticket: 'M-1' });
    const job = await waitFor(served, 'M-1', reported === expected ? 'awaiting_review' : 'needs_human', reported === expected ? 1 : undefined);
    const [entry] = await fakeLog(env);
    assert.ok(entry!.argv.includes(`--permission-mode=${expected}`), name);
    const recorded = (await new JobStore(env.state).read('app', 'M-1'))!.session_id ?? null;
    if (reported === expected) {
      assert.equal(recorded, entry!.sessionId, name);
    } else {
      assert.equal(job.error.code, 'permission_mode_mismatch', name);
      assert.match(job.error.message, new RegExp(`"${reported}" instead of "${expected}"`), name);
      assert.equal(recorded, null, name);
    }
    await stop(served);
  }
});

test('the implement skill missing from the session\'s init message: one skill_missing event per job, its turns carry on; listed: none', async () => {
  const env = await newEnv('skill-missing');
  const repo = await newRepo(env, 'skill-missing-repo', false);
  await putTask(env, repo, 'K-1', 'Missing');
  await putTask(env, repo, 'K-2', 'Present');
  await script(env, [
    { text: '# Report: K-1, iteration 1', slashCommands: ['tdd'] }, { text: '# Report: K-1, iteration 2', slashCommands: [] }, { text: '# Report: K-2, iteration 1' },
  ]);
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'K-1' });
  await waitFor(served, 'K-1', 'awaiting_review', 1);
  assert.equal((await runCli(env, ['say', 'app', 'K-1', 'go', 'on'])).code, 0);
  await waitFor(served, 'K-1', 'awaiting_review', 2);
  await call(served, 'start', { workspace: 'app', ticket: 'K-2' });
  await waitFor(served, 'K-2', 'awaiting_review', 1);
  await stop(served);
  const jobs = new JobStore(env.state);
  const missing = async (ticket: string): Promise<unknown[]> => (await readFile(jobs.eventsPath('app', ticket), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { type?: string }).filter((record) => record.type === 'skill_missing').map(({ ts: _ts, ...rest }: Record<string, unknown>) => rest);
  assert.deepEqual(await missing('K-1'), [{ iteration: 1, type: 'skill_missing', skill: 'implement' }]);
  assert.deepEqual(await missing('K-2'), []);
});

test('a job started with no skills source: its one skills event names every skill missing, and sf serve\'s log and the job\'s runner.log each get one warning line for the job', async () => {
  const none = join(temp, 'no-agents', 'skills');
  const env = await newEnv('skills-missing-source', { SF_SKILLS_DIR: none });
  const repo = await newRepo(env, 'skills-missing-source-repo', false);
  await putTask(env, repo, 'M-1', 'Missing');
  await script(env, [{ text: '# Report: M-1, iteration 1' }]);
  const served = await serve(env);
  let log = '';
  served.child.stderr!.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
  await call(served, 'start', { workspace: 'app', ticket: 'M-1' });
  await waitFor(served, 'M-1', 'awaiting_review', 1);
  await stop(served);
  const line = `warning: app/M-1: skills missing in ${none} or its lock file: implement, tdd, code-review, grilling, prototype; the snapshot keeps the copies it has`;
  assert.equal(log.split('\n').filter((entry) => entry === line).length, 1, log);
  // The job's runner.log has it too, once (the runner appends its own output after it).
  const runnerLog = await readFile(join(new JobStore(env.state).dir('app', 'M-1'), 'runner.log'), 'utf8');
  assert.equal(runnerLog.split('\n').filter((entry) => entry === line).length, 1, runnerLog);
  const events = (await readFile(new JobStore(env.state).eventsPath('app', 'M-1'), 'utf8')).trim().split('\n').map((entry) => JSON.parse(entry) as Record<string, unknown>);
  assert.deepEqual(events.filter((record) => record.type === 'skills').map(({ ts: _ts, ...rest }) => rest), [{ iteration: 0, type: 'skills', versions: {}, missing: ['implement', 'tdd', 'code-review', 'grilling', 'prototype'], roles: DEFAULT_ROLES }]);
});

test('the skills event: one per job, at its start before its first prompt, with the snapshot\'s versions and folder; a later turn adds none; a later job takes a changed skill, and the first job\'s next turn still binds its own folder', async () => {
  const env = await newEnv('skills-event');
  const repo = await newRepo(env, 'skills-event-repo', false);
  await putTask(env, repo, 'V-1', 'First');
  await putTask(env, repo, 'V-2', 'Second');
  await script(env, [{ text: '# Report: V-1, iteration 1' }, { text: '# Report: V-2, iteration 1' }, { text: '# Report: V-1, iteration 2' }]);
  const versions = Object.fromEntries(Object.keys(FAKE_SKILLS).map((name) => [name, `${name}-hash`]));
  const served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'V-1' });
  await waitFor(served, 'V-1', 'awaiting_review', 1);
  // tdd updated in the source: V-2's start copies it into a new folder and swaps the link to it.
  const lock = join(skillsSourceDir(), '..', '.skill-lock.json');
  const saved = await readFile(lock, 'utf8');
  await writeFile(join(skillsSourceDir(), 'tdd', 'SKILL.md'), 'tdd v2\n');
  await writeFile(lock, saved.replace('"tdd-hash"', '"tdd-v2"'));
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'V-2' });
    await waitFor(served, 'V-2', 'awaiting_review', 1);
    // V-1's next turn, after the swap.
    assert.equal((await runCli(env, ['say', 'app', 'V-1', 'go', 'on'])).code, 0);
    await waitFor(served, 'V-1', 'awaiting_review', 2);
    await stop(served);
  } finally {
    await writeFile(lock, saved);
    await writeFile(join(skillsSourceDir(), 'tdd', 'SKILL.md'), `---\nname: tdd\ndescription: The fake tdd skill\n---\n\n${FAKE_SKILLS.tdd}\n`);
  }
  const jobs = new JobStore(env.state);
  const records = async (ticket: string): Promise<Array<Record<string, unknown>>> => (await readFile(jobs.eventsPath('app', ticket), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const skillsOf = async (ticket: string): Promise<Array<Record<string, unknown>>> => (await records(ticket)).filter((record) => record.type === 'skills').map(({ ts: _ts, ...rest }) => rest);
  const [first] = await skillsOf('V-1');
  const [second] = await skillsOf('V-2');
  assert.deepEqual(await skillsOf('V-1'), [{ iteration: 0, type: 'skills', versions, folder: first!.folder, roles: DEFAULT_ROLES }]);
  assert.deepEqual(await skillsOf('V-2'), [{ iteration: 0, type: 'skills', versions: { ...versions, tdd: 'tdd-v2' }, folder: second!.folder, roles: DEFAULT_ROLES }]);
  assert.match(String(first!.folder), /^skills\.d\/[\w-]+$/);
  assert.notEqual(first!.folder, second!.folder);
  assert.equal(await readlink(join(env.state, 'skills')), second!.folder);
  const events = await records('V-1');
  assert.ok(events.findIndex((record) => record.type === 'skills') < events.findIndex((record) => 'prompt' in record));
  // Every V-1 wrapper, the one after the swap too, binds V-1's folder; V-2's binds its own.
  const binds = async (ticket: string): Promise<string[]> => {
    const worktree = (await jobs.read('app', ticket))!.worktree!;
    const runs = (await bwrapLog(env, { implementer: true })).filter((run) => implementerRun(run) && run.argv[run.argv.indexOf('--chdir') + 1] === worktree);
    return runs.map((run) => run.argv[run.argv.indexOf(join(env.home, '.claude', 'skills', 'implement')) - 1]!);
  };
  assert.deepEqual(await binds('V-1'), [join(env.state, String(first!.folder), 'implement'), join(env.state, String(first!.folder), 'implement')]);
  assert.deepEqual(await binds('V-2'), [join(env.state, String(second!.folder), 'implement')]);
  assert.equal(await readFile(join(env.state, 'skills', 'tdd', 'SKILL.md'), 'utf8'), 'tdd v2\n');
});
