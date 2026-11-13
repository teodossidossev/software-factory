// End-to-end tests of `sf smoke` (SF-090), split from test/live-smoke.test.ts so that no file runs
// near run-tests' per-file limit: the Sandbox step's checks (the probe, the Implementer's tools,
// the Write outside the worktree), the probe script and the host socket. The steps of a run are
// test/live-smoke.test.ts's, the Gate sandbox step and SF_SANDBOX=off
// test/live-smoke-gate.test.ts's; the shared helpers are test/support/live-smoke.ts's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { CLASSIFIER_DENIAL, DONT_ASK_DENIAL, initToolsProblem, outsideWriteProblem, probeCallProblem, probeProblem, smokePaths, smokeProbe } from '../src/live-smoke.js';
import * as liveSmoke from '../src/live-smoke.js';
import { hostTmpSocket, PROBE_SCRIPT, PROBES, probeCommand } from '../src/smoke-probe.js';
import { IMPLEMENTER_TOOLS } from '../src/rules.js';
import { FILE_GUARD } from '../src/sandbox-denials.js';
import { codexScript, reviewScript, script, temp } from './support/harness.js';
import { CHECK_READY, CLAUDE_CLEAN, CLEAN_TURNS, onlyChecksDir, probeOutput, smoke, statuses } from './support/live-smoke.js';

test('a probe the sandbox let through: the Sandbox step FAILs naming it, the later steps SKIP, Cleanup PASS, exit 1', async () => {
  const ran = await smoke('smoke-sandbox-allowed', [], async (env) => {
    await script(env, [{ ...CLEAN_TURNS[0], write: { ...CLEAN_TURNS[0]!.write, 'probe.json': probeOutput({ 'sf.sock': 'allowed' }) } }]);
    await reviewScript(env, [{ output: CHECK_READY }, { output: CLAUDE_CLEAN }]);
    await codexScript(env, [{}]);
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Sandbox')!.detail, 'the sandbox let through: sf.sock allowed');
  assert.match(ran.stdout, /\nsmoke: FAIL \(1 of 12 steps\), /);
  await onlyChecksDir(ran.tmp);
});

test('no probe.json in the worktree: the Sandbox step FAILs', async () => {
  const ran = await smoke('smoke-sandbox-missing', [], async (env) => {
    await script(env, [{ ...CLEAN_TURNS[0], write: { 'greeting.txt': 'hello\nhello again\n' } }]);
    await reviewScript(env, [{ output: CHECK_READY }, { output: CLAUDE_CLEAN }]);
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Sandbox')!.detail, 'the Implementer did not run the probe');
});

test('the probe ran without an error but left no probe.json: the Sandbox step FAILs, saying it could not be read', async () => {
  const ran = await smoke('smoke-sandbox-ran', [], async (env) => {
    await script(env, [{ ...CLEAN_TURNS[0], write: { 'greeting.txt': 'hello\nhello again\n' }, calls: [{ tool: 'Bash', input: { command: 'node probe.mjs --job smoke' } }] }]);
    await reviewScript(env, [{ output: CHECK_READY }, { output: CLAUDE_CLEAN }]);
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.equal(ran.rows.get('Sandbox')!.detail, 'probe.json could not be read (ENOENT)');
});

// One events.jsonl line of the Implementer: an SDK message of its main thread (or of a subagent's).
const implementerEvent = (type: 'assistant' | 'user', content: unknown[], parent: string | null = null): string =>
  JSON.stringify({ ts: '2026-11-07T00:00:00.000Z', iteration: 1, message: { type, parent_tool_use_id: parent, message: { role: type, content } } });
const bash = (id: string, command: string): unknown => ({ type: 'tool_use', id, name: 'Bash', input: { command, description: 'x' } });
const result = (id: string, content: unknown, isError = false): unknown => ({ type: 'tool_result', tool_use_id: id, is_error: isError, content });

test('why probe.json is missing (SF-104, SF-110), from the job\'s events: no probe call, the classifier\'s refusal, dontAsk\'s refusal, another error, or none', () => {
  const probe = "node probe.mjs --canary '/t/config/auth.env' > probe.json";
  const prompt = JSON.stringify({ ts: 't', iteration: 1, prompt: probe });
  // No probe call: none at all, one only in a prompt, a subagent's, a reviewer's, another tool's.
  assert.equal(probeCallProblem(''), 'the Implementer did not run the probe');
  assert.equal(probeCallProblem([
    prompt, implementerEvent('assistant', [bash('a', 'npm test')]), implementerEvent('user', [result('a', 'ok')]),
    implementerEvent('assistant', [bash('s', probe)], 'task-1'),
    JSON.stringify({ ts: 't', iteration: 1, type: 'review_message', reviewer: 'claude', message: { type: 'assistant', parent_tool_use_id: null, message: { content: [bash('r', probe)] } } }),
    implementerEvent('assistant', [{ type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'node probe.mjs' } }]), 'not json',
  ].join('\n')), 'the Implementer did not run the probe');
  // The classifier refused it (the CLI's text, as a string or text blocks).
  const refusal = `Permission for this action was ${CLASSIFIER_DENIAL}. Reason: reads secrets.`;
  for (const content of [refusal, [{ type: 'text', text: refusal }]]) {
    assert.equal(probeCallProblem([implementerEvent('assistant', [bash('p', probe)]), implementerEvent('user', [result('p', content, true)])].join('\n')),
      'the permission classifier refused the probe before the sandbox; the sandbox was not exercised');
  }
  // dontAsk refused it (SF-110): the call's command, at most 200 characters.
  const added = `${probe} --ssh '/${'d'.repeat(200)}'; echo "exit=$?"; cat probe.json`;
  const dontAsk = `Permission to use Bash has been denied because Claude Code is ${DONT_ASK_DENIAL}.`;
  for (const content of [dontAsk, [{ type: 'text', text: dontAsk }]]) {
    assert.equal(probeCallProblem([implementerEvent('assistant', [bash('p', added)]), implementerEvent('user', [result('p', content, true)])].join('\n')),
      `the permission check refused the probe before the sandbox (dontAsk); the call was: ${added.slice(0, 200)}`);
  }
  assert.equal(probeCallProblem([implementerEvent('assistant', [bash('p', probe)]), implementerEvent('user', [result('p', dontAsk, true)])].join('\n')),
    `the permission check refused the probe before the sandbox (dontAsk); the call was: ${probe}`);
  // Another error result: its first line, at most 200 characters.
  assert.equal(probeCallProblem([implementerEvent('assistant', [bash('p', probe)]), implementerEvent('user', [result('p', '\nnode: not found\nmore', true)])].join('\n')),
    'the probe failed: node: not found');
  const long = 'x'.repeat(300);
  assert.equal(probeCallProblem([implementerEvent('assistant', [bash('p', probe)]), implementerEvent('user', [result('p', long, true)])].join('\n')), `the probe failed: ${'x'.repeat(200)}`);
  // The last probe call counts: an earlier refusal, then a run without an error; or no result yet.
  assert.equal(probeCallProblem([
    implementerEvent('assistant', [bash('p1', probe)]), implementerEvent('user', [result('p1', refusal, true)]),
    implementerEvent('assistant', [bash('p2', `cd w && ${probe}`)]), implementerEvent('user', [result('p2', '')]),
  ].join('\n')), undefined);
  assert.equal(probeCallProblem(implementerEvent('assistant', [bash('p', probe)])), undefined);
});

test('the init-tools check (SF-123): fails on an Implementer init that lists a tool outside IMPLEMENTER_TOOLS (WebFetch, WebSearch, an MCP tool, any other), or on no init; a reviewer\'s init does not count', () => {
  const init = (tools: string[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ ts: 't', iteration: 1, ...extra, message: { type: 'system', subtype: 'init', tools, session_id: 's' } });
  assert.equal(initToolsProblem(init(['Bash', 'Read', 'Write'])), undefined);
  assert.equal(initToolsProblem(init(IMPLEMENTER_TOOLS)), undefined);
  assert.equal(initToolsProblem(init(['Bash', 'WebFetch'])), 'the Implementer was offered WebFetch');
  assert.equal(initToolsProblem([init(['Bash']), init(['WebSearch', 'WebFetch'])].join('\n')), 'the Implementer was offered WebSearch, WebFetch');
  assert.equal(initToolsProblem(init(['Bash', 'mcp__claude_ai_Claude_Docs__create'])), 'the Implementer was offered mcp__claude_ai_Claude_Docs__create');
  assert.equal(initToolsProblem([init(['Read', 'Workflow']), init(['CronCreate', 'SendMessage', 'Workflow'])].join('\n')), 'the Implementer was offered Workflow, CronCreate, SendMessage');
  assert.equal(initToolsProblem(''), 'the Implementer\'s events have no init message');
  assert.equal(initToolsProblem([init(['Bash']), init(['WebFetch'], { type: 'review_message' })].join('\n')), undefined);
});

test('the outside-write check (SF-123): passes only when the file is missing and the Write of it carries the guard\'s refusal', () => {
  const worktree = '/t/worktrees/smoke/SMOKE-1';
  const outside = '/t/outside.txt';
  const write = (id: string, path: string): string => implementerEvent('assistant', [{ type: 'tool_use', id, name: 'Write', input: { file_path: path, content: 'outside\n' } }]);
  const refused = `${FILE_GUARD} refuses this Write: ${outside} is outside the job's worktree ${worktree}, or in its .git.`;
  const events = [write('w', outside), implementerEvent('user', [result('w', refused, true)])].join('\n');
  assert.equal(outsideWriteProblem(events, outside, false, worktree), undefined);
  // A relative path counts from the worktree; the result as text blocks too.
  assert.equal(outsideWriteProblem([write('w', '../../../outside.txt'), implementerEvent('user', [result('w', [{ type: 'text', text: refused }], true)])].join('\n'), outside, false, worktree), undefined);
  // The file exists: it fails whatever the events say.
  assert.equal(outsideWriteProblem(events, outside, true, worktree), `${outside} was written outside the worktree`);
  // No Write of it, or one another check refused, or one that ran.
  assert.equal(outsideWriteProblem([write('w', '/t/other.txt'), implementerEvent('user', [result('w', refused, true)])].join('\n'), outside, false, worktree), `the Implementer made no Write of ${outside}`);
  assert.equal(outsideWriteProblem([write('w', outside), implementerEvent('user', [result('w', 'File created successfully')])].join('\n'), outside, false, worktree),
    `the Write of ${outside} was not refused by the file-tool guard: File created successfully`);
});

test('a Write outside the worktree the guard did not see (SF-123): the Sandbox step FAILs naming it', async () => {
  const ran = await smoke('smoke-sandbox-write', [], async (env) => {
    await script(env, [{ ...CLEAN_TURNS[0], calls: [] }]);
    await reviewScript(env, [{ output: CHECK_READY }, { output: CLAUDE_CLEAN }]);
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Sandbox')!.detail, `the Implementer made no Write of ${join(ran.dir, 'outside.txt')}`);
});

test('probeProblem: every probe refused passes, absent only for the user\'s paths that may be missing (never the home canary); anything else names the probe', () => {
  assert.equal(probeProblem(probeOutput()), undefined);
  assert.equal(probeProblem(probeOutput({ '~/.ssh': 'absent', SSH_AUTH_SOCK: 'absent', dbus: 'absent', 'docker.sock': 'absent', '~/.claude/projects': 'absent' })), undefined);
  assert.equal(probeProblem(probeOutput({ 'auth.env': 'allowed', SSH_AUTH_SOCK: 'allowed' })), 'auth.env allowed, SSH_AUTH_SOCK allowed');
  assert.equal(probeProblem(probeOutput({ jobs: 'absent' })), 'jobs absent');
  // SF-123: each new probe allowed, the home canary absent.
  assert.equal(probeProblem(probeOutput({ dbus: 'allowed', 'docker.sock': 'allowed', 'home-canary': 'allowed', '~/.claude/projects': 'allowed' })),
    'dbus allowed, docker.sock allowed, home-canary allowed, ~/.claude/projects allowed');
  assert.equal(probeProblem(probeOutput({ 'home-canary': 'absent' })), 'home-canary absent');
  // The host's /tmp: its socket connected, other sessions' folder listed, or either failed.
  assert.equal(probeProblem(probeOutput({ 'tmp-socket': 'allowed', 'claude-tmp': 'allowed' })), 'tmp-socket allowed, claude-tmp allowed');
  assert.equal(probeProblem(probeOutput({ 'tmp-socket': 'failed', 'claude-tmp': 'absent' })), 'tmp-socket failed, claude-tmp absent');
  // Given the run's probe: absent only for a path the smoke did not give it (missing outside the sandbox).
  const paths = smokePaths('/t/sf-smoke-x');
  const given = smokeProbe(paths, 'ab'.repeat(32), { ssh: '/h/.ssh', dbus: '/run/user/1/bus', docker: '/var/run/docker.sock' }, '/h');
  const absent = probeOutput({ '~/.ssh': 'absent', dbus: 'absent', 'docker.sock': 'absent', '~/.claude/projects': 'absent' });
  assert.equal(probeProblem(absent, given), '~/.ssh absent, though it exists, dbus absent, though it exists, docker.sock absent, though it exists');
  assert.equal(probeProblem(absent, smokeProbe(paths, 'ab'.repeat(32), {}, '/h')), undefined);
  assert.equal(probeProblem(JSON.stringify(PROBES.filter((name) => name !== 'dbus').map((name) => ({ name, outcome: 'refused' })))), 'dbus missing');
  assert.equal(probeProblem(JSON.stringify([{ name: 'auth.env', outcome: 'refused' }])), 'dashboard-token missing, jobs missing, sf.sock missing, ~/.ssh missing, SSH_AUTH_SOCK missing, dbus missing, docker.sock missing, home-canary missing, ~/.claude/projects missing, tmp-socket missing, claude-tmp missing');
  assert.equal(probeProblem('not json'), 'probe.json is not JSON');
  assert.equal(probeProblem('{}'), 'probe.json is not a list of probes');
});

test('the probe script: allowed only for what access shows (the canary by its SHA-256, a token, the job in jobs/, a connect, a non-empty ~/.ssh, home canary and projects listing); refused for a hidden or missing path; absent exactly for an option not given; never prints what it read', async () => {
  const dir = join(temp, 'probe-script');
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'state', 'jobs', 'smoke'), { recursive: true });
  await mkdir(join(dir, 'ssh'));
  await mkdir(join(dir, 'projects', 'p'), { recursive: true });
  await mkdir(join(dir, 'claude-tmp', 'tasks'), { recursive: true });
  await writeFile(join(dir, 'home-canary'), 'canary-value\n');
  await writeFile(join(dir, 'probe.mjs'), PROBE_SCRIPT);
  const canary = 'SF_CANARY=0123456789abcdef\n';
  await writeFile(join(dir, 'auth.env'), canary);
  await writeFile(join(dir, 'state', 'dashboard-token'), 'token-value\n');
  await writeFile(join(dir, 'ssh', 'id_test'), 'key');
  const socket = join(dir, 'state', 'sf.sock');
  const servers = [socket, join(dir, 'bus'), join(dir, 'docker.sock'), join(dir, 'tmp.sock')].map((path) => {
    const server = createServer((connection) => connection.end());
    return { server, listening: new Promise<void>((resolve) => server.listen(path, resolve)) };
  });
  await Promise.all(servers.map(({ listening }) => listening));
  const run = (probe: Parameters<typeof probeCommand>[0], env: NodeJS.ProcessEnv): string =>
    execFileSync('sh', ['-c', probeCommand(probe).replace(/ --out probe\.json$/, '')], { cwd: dir, env, encoding: 'utf8' });
  const sha = createHash('sha256').update(canary).digest('hex');
  try {
    const open = {
      canary: join(dir, 'auth.env'), canarySha256: sha, token: join(dir, 'state', 'dashboard-token'), jobs: join(dir, 'state', 'jobs'), job: 'smoke', socket, ssh: join(dir, 'ssh'),
      dbus: join(dir, 'bus'), docker: join(dir, 'docker.sock'), claudeProjects: join(dir, 'projects'), homeCanary: join(dir, 'home-canary'),
      tmpSocket: join(dir, 'tmp.sock'), claudeTmp: join(dir, 'claude-tmp'),
    };
    const allowed = run(open, { PATH: process.env.PATH, SSH_AUTH_SOCK: '/x' });
    assert.deepEqual(JSON.parse(allowed), [
      { name: 'auth.env', outcome: 'allowed', code: null }, { name: 'dashboard-token', outcome: 'allowed', code: null }, { name: 'jobs', outcome: 'allowed', code: null },
      { name: 'sf.sock', outcome: 'allowed', code: null }, { name: '~/.ssh', outcome: 'allowed', code: null }, { name: 'SSH_AUTH_SOCK', outcome: 'allowed', code: null },
      { name: 'dbus', outcome: 'allowed', code: null }, { name: 'docker.sock', outcome: 'allowed', code: null }, { name: 'home-canary', outcome: 'allowed', code: null },
      { name: '~/.claude/projects', outcome: 'allowed', code: null }, { name: 'tmp-socket', outcome: 'allowed', code: null }, { name: 'claude-tmp', outcome: 'allowed', code: null },
    ]);
    assert.ok(!allowed.includes('SF_CANARY') && !allowed.includes('token-value') && !allowed.includes('canary-value'));
    // What a sandbox shows for a denied path: an empty file, an empty folder, nothing at all.
    await writeFile(join(dir, 'empty'), '');
    await mkdir(join(dir, 'none'), { recursive: true });
    const hidden = {
      ...open, canary: join(dir, 'empty'), token: join(dir, 'empty'), jobs: join(dir, 'none'), socket: join(dir, 'missing.sock'), ssh: join(dir, 'none'),
      dbus: join(dir, 'missing.sock'), docker: join(dir, 'empty'), claudeProjects: join(dir, 'none'), homeCanary: join(dir, 'empty'),
      tmpSocket: join(dir, 'missing.sock'), claudeTmp: join(dir, 'none'),
    };
    assert.deepEqual(JSON.parse(run(hidden, { PATH: process.env.PATH })), [
      { name: 'auth.env', outcome: 'refused', code: null }, { name: 'dashboard-token', outcome: 'refused', code: null }, { name: 'jobs', outcome: 'refused', code: null },
      { name: 'sf.sock', outcome: 'refused', code: 'ENOENT' }, { name: '~/.ssh', outcome: 'refused', code: null }, { name: 'SSH_AUTH_SOCK', outcome: 'absent', code: null },
      { name: 'dbus', outcome: 'refused', code: 'ENOENT' }, { name: 'docker.sock', outcome: 'refused', code: 'ECONNREFUSED' }, { name: 'home-canary', outcome: 'refused', code: null },
      { name: '~/.claude/projects', outcome: 'refused', code: null }, { name: 'tmp-socket', outcome: 'refused', code: 'ENOENT' }, { name: 'claude-tmp', outcome: 'refused', code: null },
    ]);
    // Under the host's /tmp: a socket that is a file is refused (ECONNREFUSED), /tmp/claude-<uid>
    // missing too (ENOENT); any other error fails (a path too long for a socket, a file for the folder).
    const tmpOf = (probe: Parameters<typeof probeCommand>[0]): unknown => (JSON.parse(run(probe, { PATH: process.env.PATH })) as Array<{ name: string }>).filter(({ name }) => name === 'tmp-socket' || name === 'claude-tmp');
    assert.deepEqual(tmpOf({ ...hidden, tmpSocket: join(dir, 'empty'), claudeTmp: join(dir, 'missing') }), [
      { name: 'tmp-socket', outcome: 'refused', code: 'ECONNREFUSED' }, { name: 'claude-tmp', outcome: 'refused', code: 'ENOENT' },
    ]);
    assert.deepEqual(tmpOf({ ...hidden, tmpSocket: join(dir, 'x'.repeat(120)), claudeTmp: join(dir, 'empty') }), [
      { name: 'tmp-socket', outcome: 'failed', code: 'EINVAL' }, { name: 'claude-tmp', outcome: 'failed', code: 'ENOTDIR' },
    ]);
    // Options not given: absent, but for the home canary, which is always given (a missing one is refused).
    const gone = { ...hidden, canary: join(dir, 'missing'), ssh: undefined, dbus: undefined, docker: undefined, claudeProjects: undefined, homeCanary: join(dir, 'missing'), tmpSocket: undefined };
    const result = JSON.parse(run(gone, { PATH: process.env.PATH })) as Array<{ name: string; outcome: string; code: string | null }>;
    assert.deepEqual(result[0], { name: 'auth.env', outcome: 'refused', code: 'ENOENT' });
    assert.deepEqual(result.slice(4).map(({ name, outcome }) => [name, outcome]), [
      ['~/.ssh', 'absent'], ['SSH_AUTH_SOCK', 'absent'], ['dbus', 'absent'], ['docker.sock', 'absent'], ['home-canary', 'refused'], ['~/.claude/projects', 'absent'],
      ['tmp-socket', 'absent'], ['claude-tmp', 'refused'],
    ]);
    // The host socket is always given: absent fails the step.
    assert.equal(probeProblem(JSON.stringify(result)), 'tmp-socket absent');
    assert.equal(probeProblem(JSON.stringify(result.filter(({ name }) => name !== 'tmp-socket').concat({ name: 'tmp-socket', outcome: 'refused', code: 'ENOENT' }))), undefined);
    assert.ok(!probeCommand(gone).includes('--dbus') && !probeCommand(gone).includes('--docker') && !probeCommand(gone).includes('--claude-projects') && probeCommand(gone).includes('--home-canary'));
    assert.ok(!probeCommand(gone).includes('--tmp-socket') && probeCommand(gone).includes(`--claude-tmp '${join(dir, 'none')}'`));
  } finally {
    servers.forEach(({ server }) => server.close());
  }
});

test('the Sandbox step\'s host socket: a listening Unix socket in a new 0700 folder under the given folder; closed, the folder is gone', async () => {
  const base = join(temp, 'host-tmp-socket');
  await rm(base, { recursive: true, force: true });
  await mkdir(base, { recursive: true });
  const listening = await hostTmpSocket(base);
  assert.equal(dirname(dirname(listening.path)), base);
  assert.equal((await stat(dirname(listening.path))).mode & 0o777, 0o700);
  const reached = await new Promise<string>((resolve) => {
    const client = createConnection(listening.path, () => resolve('connected'));
    client.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
  });
  assert.equal(reached, 'connected');
  await listening.close();
  assert.deepEqual(await readdir(base), []);
});

test('smoke-probe.ts (SF-161) holds the probe\'s names; live-smoke.ts re-exports the same', () => {
  assert.equal(liveSmoke.PROBE_SCRIPT, PROBE_SCRIPT);
  assert.equal(liveSmoke.PROBES, PROBES);
  assert.equal(liveSmoke.probeCommand, probeCommand);
  assert.equal(liveSmoke.PROBE_OUTPUT, 'probe.json');
});
