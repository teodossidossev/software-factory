// End-to-end tests of `sf smoke` (SF-090) with the harness's fake Claude Code (SF_CLAUDE) and fake
// Codex (SF_CODEX, SF_GATE=codex over the harness's off), a TMPDIR the test owns and the test's own
// SF_STATE_DIR and SF_CONFIG_DIR (with an env file holding a Git host token), which the smoke must
// leave untouched. Plus the child environment, the option parsing and the redaction of its settings.
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { CLASSIFIER_DENIAL, childEnv, PASSED_SETTINGS, positiveDecimal, PROBE_SCRIPT, PROBES, probeCallProblem, probeCommand, probeProblem, ProcessGroups, runSmoke, smokePaths, smokeProbe, smokeTask, STEPS, terminate, trackRunnerLock } from '../src/live-smoke.js';
import { taskChecksDir } from '../src/sandbox-denials.js';
import { Redactor } from '../src/redact.js';
import { CLI, codexLog, codexScript, type Env, FAKE, fakeCodex, fakeLog, git, newEnv, processEnv, reviewLog, reviewScript, script, temp } from './support/harness.js';

const MR_PATH = '.software-factory/SMOKE-1.mr.md';
const BRANCH = 'SMOKE-1-add-a-second-greeting-line';
const CHECK_READY = { paraphrase: 'Add a second greeting line to greeting.txt.', findings: [], files: [{ path: 'greeting.txt', action: 'modify' }], verdict: 'ready' };
const CLAUDE_CLEAN = { verdict: 'clean', summary: 'Claude found it right.', items: [], accepted_sensitive: [] };

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'Adds a greeting line.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- greeting.txt', '## Testing', 'grep -c hello greeting.txt: 2', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

// The sandbox probe's output (SF-100) as the fake Implementer writes it: every probe refused, or
// one of them with another outcome.
function probeOutput(changed: Record<string, string> = {}): string {
  return `${JSON.stringify(PROBES.map((name) => ({ name, outcome: changed[name] ?? 'refused', code: changed[name] === undefined ? 'EACCES' : null })), null, 2)}\n`;
}

// The turns of a clean run: the Implementer's change and the probe's output, then the MR text at Clean.
const CLEAN_TURNS = [
  { write: { 'greeting.txt': 'hello\nhello again\n', 'probe.json': probeOutput() }, text: '# Report: SMOKE-1, iteration 1\n\n## Done\nAdded the line.' },
  { write: { [MR_PATH]: mrText('feat(SMOKE-1): Add a second greeting line') }, text: 'prepared' },
];

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  env: Env;
  tmp: string;
  // The smoke's temporary directory: the first line of its output.
  dir: string;
  // The rows of the table by step: [result, detail].
  rows: Map<string, { status: string; detail: string }>;
}

// Runs sf smoke as the user would, with the test's own state, config (and env file) and TMPDIR.
// onStdout: called with the output so far on each chunk, with the child (to signal it).
async function smoke(name: string, args: string[], setup: (env: Env) => Promise<void>, extra: Record<string, string> = {}, onStdout?: (text: string, child: ChildProcess) => void, extraOf?: (env: Env) => Record<string, string>): Promise<Ran> {
  const env = await newEnv(name);
  const tmp = join(temp, name, 'tmp');
  await mkdir(tmp, { recursive: true });
  await mkdir(env.config, { recursive: true });
  // The user's env file: a Git host token and a notification token the child must never see.
  await writeFile(join(env.config, 'auth.env'), 'SF_GITHUB_TOKEN=ghp_fakeFakeFakeFakeFakeFake1234\nSF_NTFY_TOKEN=tk_fake\n');
  await setup(env);
  const childEnvironment = { ...processEnv(env), SF_GATE: 'codex', SF_CODEX: fakeCodex, SF_NTFY_URL: 'http://127.0.0.1:9/never', TMPDIR: tmp, ...extra, ...extraOf?.(env) };
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, 'smoke', ...args], { env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      onStdout?.(out, child);
    });
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.once('close', (exit) => resolve({ code: exit, stdout: out, stderr: err }));
  });
  const lines = stdout.split('\n');
  const rows = new Map<string, { status: string; detail: string }>();
  for (const line of lines) {
    const match = /^(.+?): (PASS|FAIL|SKIP) \(\d+\.\d s\)(?: (.*))?$/.exec(line);
    if (match !== null && (STEPS as readonly string[]).includes(match[1]!)) {
      rows.set(match[1]!, { status: match[2]!, detail: match[3] ?? '' });
    }
  }
  return { code, stdout, stderr, env, tmp, dir: lines[0]!, rows };
}

const statuses = (ran: Ran): string[] => STEPS.map((step) => ran.rows.get(step)?.status ?? 'missing');

// What a run leaves in its TMPDIR: at most the Task checks' shared parent directory (SF-100, made by
// sf serve and the checks, kept for the next run), empty.
async function onlyChecksDir(tmp: string): Promise<void> {
  const left = await readdir(tmp);
  assert.deepEqual(left.filter((name) => name !== basename(taskChecksDir(tmp))), []);
  if (left.length > 0) {
    assert.deepEqual(await readdir(taskChecksDir(tmp)), []);
  }
}

// The user's state and config of the test: no state directory, the config only the env file.
async function untouched(ran: Ran): Promise<void> {
  assert.equal(existsSync(ran.env.state), false, 'the user\'s state directory was created');
  assert.deepEqual(await readdir(ran.env.config), ['auth.env']);
}

async function cleanScripts(env: Env): Promise<void> {
  await script(env, CLEAN_TURNS);
  await reviewScript(env, [{ output: CHECK_READY }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{}]);
}

test('a clean run: every step PASS, exit 0, the temp directory gone, the user\'s state and config untouched; the children ran in the smoke\'s directories without the user\'s SF_* settings', async () => {
  const ran = await smoke('smoke-clean', [], cleanScripts);
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), STEPS.map(() => 'PASS'), ran.stdout);
  assert.match(ran.dir, /\/sf-smoke-[^/]+$/);
  assert.ok(ran.dir.startsWith(ran.tmp), ran.dir);
  assert.match(ran.stdout, /\nsmoke: PASS, cost \d+\.\d{4} USD, gate 1100 tokens\n$/);
  assert.match(ran.rows.get('Task check')!.detail, /^verdict ready/);
  assert.match(ran.rows.get('Codex gate')!.detail, /clean, 1100 tokens/);
  assert.match(ran.rows.get('MR text')!.detail, /^feat\(SMOKE-1\): Add a second greeting line$/);
  assert.match(ran.rows.get('Approve')!.detail, new RegExp(`^${BRANCH} at [0-9a-f]{12} on origin\\.git$`));
  // The table: a header and one row per step.
  assert.match(ran.stdout, /\nSTEP +RESULT +SECONDS +DETAIL\n/);
  await onlyChecksDir(ran.tmp);
  await untouched(ran);

  // The child environment: the smoke's directories (the job's worktree under its SF_WORKTREE_ROOT,
  // its state in SF_STATE_DIR: the user's is untouched above), its model, and none of the user's
  // SF_* settings, from the user's environment or the env file. (The factory gives Claude Code
  // only a few variables of its own environment, so the fakes log no SF_STATE_DIR either way.)
  const implementer = await fakeLog(ran.env);
  const reviews = await reviewLog(ran.env);
  const gate = await codexLog(ran.env);
  assert.equal(implementer.length, 2);
  assert.equal(reviews.length, 2);
  assert.equal(gate.length, 1);
  for (const entry of [...implementer, ...reviews, ...gate]) {
    for (const name of ['SF_NTFY_URL', 'SF_NTFY_TOKEN', 'SF_GITHUB_TOKEN', 'SF_TEST_HOOKS']) {
      assert.equal(entry.env.includes(name), false, `${name} reached the child`);
    }
  }
  for (const entry of [...implementer, ...reviews]) {
    assert.ok(entry.argv.join(' ').includes('haiku'), entry.argv.join(' '));
  }
  assert.equal(implementer[0]!.cwd, join(ran.dir, 'worktrees', 'smoke', 'SMOKE-1'));
  assert.equal(gate[0]!.cwd, join(ran.dir, 'worktrees', 'smoke', 'SMOKE-1'));
});

test('--keep keeps the directory and prints it; the bare remote has the job\'s branch at its prepared commit', async () => {
  const ran = await smoke('smoke-keep', ['--keep'], cleanScripts);
  try {
    assert.equal(ran.code, 0, ran.stdout + ran.stderr);
    assert.match(ran.rows.get('Cleanup')!.detail, new RegExp(`kept ${ran.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(existsSync(ran.dir), true);
    // The job was reset at Cleanup: its record archived, with the commit it prepared.
    const archived = (await readdir(join(ran.dir, 'state', 'jobs', 'smoke'))).filter((name) => name.startsWith('SMOKE-1.'));
    assert.equal(archived.length, 1);
    const job = JSON.parse(await readFile(join(ran.dir, 'state', 'jobs', 'smoke', archived[0]!, 'job.json'), 'utf8')) as { state: string; branch: string; prepared_commit: string };
    assert.deepEqual([job.state, job.branch], ['pushed', BRANCH]);
    assert.equal(git(join(ran.dir, 'origin.git'), 'rev-parse', BRANCH).trim(), job.prepared_commit);
    assert.equal(git(join(ran.dir, 'origin.git'), 'show', `${BRANCH}:greeting.txt`), 'hello\nhello again\n');
    // The repository the smoke made: main with the greeting and the Task file, by sf-smoke.
    // The Task of the run: its probe of the run's own paths, the canary by its SHA-256 only.
    const canary = await readFile(join(ran.dir, 'config', 'auth.env'), 'utf8');
    assert.match(canary, /^SF_CANARY=[0-9a-f]{48}\n$/);
    const probe = smokeProbe(smokePaths(ran.dir), createHash('sha256').update(canary).digest('hex'), undefined);
    const task = git(join(ran.dir, 'origin.git'), 'show', 'main:.software-factory/SMOKE-1.md');
    assert.equal(task, smokeTask(probe));
    assert.ok(task.includes(probeCommand(probe)));
    assert.ok(!task.includes(canary.trim()) && !ran.stdout.includes(canary.trim()));
    assert.equal(git(join(ran.dir, 'origin.git'), 'show', 'main:probe.mjs'), PROBE_SCRIPT);
    assert.equal(git(join(ran.dir, 'origin.git'), 'show', `${BRANCH}:probe.json`), probeOutput());
    assert.equal(git(join(ran.dir, 'origin.git'), 'log', '-1', '--format=%an <%ae>', 'main').trim(), 'sf-smoke <sf-smoke@localhost>');
    // SF-104: the Implementer had the probe command, exactly, past the permission check, in mode auto.
    for (const entry of await fakeLog(ran.env)) {
      assert.deepEqual(entry.argv.filter((arg) => arg.startsWith('--allowedTools')), [`--allowedTools=Bash(${probeCommand(probe)})`]);
      assert.ok(entry.argv.includes('--permission-mode=auto'));
    }
    await untouched(ran);
  } finally {
    await rm(ran.dir, { recursive: true, force: true });
  }
});

test('a review session that fails: the Claude review step FAILs with review_failed, the later steps SKIP, Cleanup PASS, exit 1', async () => {
  const ran = await smoke('smoke-review', [], async (env) => {
    await script(env, CLEAN_TURNS);
    await reviewScript(env, [{ output: CHECK_READY }, { noOutput: true }, { noOutput: true }]);
    await codexScript(env, [{}]);
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.match(ran.rows.get('Claude review')!.detail, /^needs_human: review_failed: /);
  // Cleanup aborts the active job before its reset.
  assert.match(ran.stdout, /^Dashboard: SKIP[^\n]*\njob aborted \(sf abort smoke SMOKE-1\)\nCleanup: PASS/m);
  assert.match(ran.stdout, /\nsmoke: FAIL \(1 of 11 steps\), cost \d+\.\d{4} USD, gate 0 tokens\n$/);
  assert.equal((await codexLog(ran.env).catch(() => [])).length, 0);
  await onlyChecksDir(ran.tmp);
  await untouched(ran);
});

test('the gate off: the Codex gate step FAILs with sf info\'s reason, the job still goes on to the push and the dashboard, the run ends as FAIL', async () => {
  const ran = await smoke('smoke-gate-off', [], cleanScripts, { SF_GATE: 'off' });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'PASS', 'PASS', 'PASS', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Codex gate')!.detail, 'the gate is off (SF_GATE=off)');
  assert.match(ran.stdout, /\nsmoke: FAIL \(1 of 11 steps\), cost \d+\.\d{4} USD, gate 0 tokens\n$/);
  await onlyChecksDir(ran.tmp);
});

test('a probe the sandbox let through: the Sandbox step FAILs naming it, the later steps SKIP, Cleanup PASS, exit 1', async () => {
  const ran = await smoke('smoke-sandbox-allowed', [], async (env) => {
    await script(env, [{ ...CLEAN_TURNS[0], write: { ...CLEAN_TURNS[0]!.write, 'probe.json': probeOutput({ 'sf.sock': 'allowed' }) } }]);
    await reviewScript(env, [{ output: CHECK_READY }, { output: CLAUDE_CLEAN }]);
    await codexScript(env, [{}]);
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Sandbox')!.detail, 'the sandbox let through: sf.sock allowed');
  assert.match(ran.stdout, /\nsmoke: FAIL \(1 of 11 steps\), /);
  await onlyChecksDir(ran.tmp);
});

test('no probe.json in the worktree: the Sandbox step FAILs', async () => {
  const ran = await smoke('smoke-sandbox-missing', [], async (env) => {
    await script(env, [{ ...CLEAN_TURNS[0], write: { 'greeting.txt': 'hello\nhello again\n' } }]);
    await reviewScript(env, [{ output: CHECK_READY }, { output: CLAUDE_CLEAN }]);
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
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

test('why probe.json is missing (SF-104), from the job\'s events: no probe call, the classifier\'s refusal, another error, or none', () => {
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

test('SF_SANDBOX=off: the Sandbox step is a SKIP that counts as a pass, the last line says the sandbox was not checked, exit 0', async () => {
  const ran = await smoke('smoke-sandbox-off', [], cleanScripts, { SF_SANDBOX: 'off' });
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), STEPS.map((step) => (step === 'Sandbox' ? 'SKIP' : 'PASS')), ran.stdout);
  assert.equal(ran.rows.get('Sandbox')!.detail, 'sandbox off');
  assert.match(ran.stdout, /\nsmoke: PASS \(sandbox not checked\), cost \d+\.\d{4} USD, gate 1100 tokens\n$/);
});

test('probeProblem: every probe refused passes, absent only for ~/.ssh and SSH_AUTH_SOCK; anything else names the probe', () => {
  assert.equal(probeProblem(probeOutput()), undefined);
  assert.equal(probeProblem(probeOutput({ '~/.ssh': 'absent', SSH_AUTH_SOCK: 'absent' })), undefined);
  assert.equal(probeProblem(probeOutput({ 'auth.env': 'allowed', SSH_AUTH_SOCK: 'allowed' })), 'auth.env allowed, SSH_AUTH_SOCK allowed');
  assert.equal(probeProblem(probeOutput({ jobs: 'absent' })), 'jobs absent');
  assert.equal(probeProblem(JSON.stringify([{ name: 'auth.env', outcome: 'refused' }])), 'dashboard-token missing, jobs missing, sf.sock missing, ~/.ssh missing, SSH_AUTH_SOCK missing');
  assert.equal(probeProblem('not json'), 'probe.json is not JSON');
  assert.equal(probeProblem('{}'), 'probe.json is not a list of probes');
});

test('the probe script: allowed only for what access shows (the canary by its SHA-256, a token, the job in jobs/, a connect, a non-empty ~/.ssh); refused for a hidden or missing path; never prints what it read', async () => {
  const dir = join(temp, 'probe-script');
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'state', 'jobs', 'smoke'), { recursive: true });
  await mkdir(join(dir, 'ssh'));
  await writeFile(join(dir, 'probe.mjs'), PROBE_SCRIPT);
  const canary = 'SF_CANARY=0123456789abcdef\n';
  await writeFile(join(dir, 'auth.env'), canary);
  await writeFile(join(dir, 'state', 'dashboard-token'), 'token-value\n');
  await writeFile(join(dir, 'ssh', 'id_test'), 'key');
  const socket = join(dir, 'state', 'sf.sock');
  const server = createServer((connection) => connection.end());
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const run = (probe: Parameters<typeof probeCommand>[0], env: NodeJS.ProcessEnv): string =>
    execFileSync('sh', ['-c', probeCommand(probe).replace(/ > probe\.json$/, '')], { cwd: dir, env, encoding: 'utf8' });
  const sha = createHash('sha256').update(canary).digest('hex');
  try {
    const open = { canary: join(dir, 'auth.env'), canarySha256: sha, token: join(dir, 'state', 'dashboard-token'), jobs: join(dir, 'state', 'jobs'), job: 'smoke', socket, ssh: join(dir, 'ssh') };
    const allowed = run(open, { PATH: process.env.PATH, SSH_AUTH_SOCK: '/x' });
    assert.deepEqual(JSON.parse(allowed), [
      { name: 'auth.env', outcome: 'allowed', code: null }, { name: 'dashboard-token', outcome: 'allowed', code: null }, { name: 'jobs', outcome: 'allowed', code: null },
      { name: 'sf.sock', outcome: 'allowed', code: null }, { name: '~/.ssh', outcome: 'allowed', code: null }, { name: 'SSH_AUTH_SOCK', outcome: 'allowed', code: null },
    ]);
    assert.ok(!allowed.includes('SF_CANARY') && !allowed.includes('token-value'));
    // What a sandbox shows for a denied path: an empty file, an empty folder, nothing at all.
    await writeFile(join(dir, 'empty'), '');
    await mkdir(join(dir, 'none'), { recursive: true });
    const hidden = { ...open, canary: join(dir, 'empty'), token: join(dir, 'empty'), jobs: join(dir, 'none'), socket: join(dir, 'missing.sock'), ssh: join(dir, 'none') };
    assert.deepEqual(JSON.parse(run(hidden, { PATH: process.env.PATH })), [
      { name: 'auth.env', outcome: 'refused', code: null }, { name: 'dashboard-token', outcome: 'refused', code: null }, { name: 'jobs', outcome: 'refused', code: null },
      { name: 'sf.sock', outcome: 'refused', code: 'ENOENT' }, { name: '~/.ssh', outcome: 'refused', code: null }, { name: 'SSH_AUTH_SOCK', outcome: 'absent', code: null },
    ]);
    const gone = { ...hidden, canary: join(dir, 'missing'), ssh: undefined };
    const result = JSON.parse(run(gone, { PATH: process.env.PATH })) as Array<{ name: string; outcome: string; code: string | null }>;
    assert.deepEqual(result[0], { name: 'auth.env', outcome: 'refused', code: 'ENOENT' });
    assert.deepEqual(result[4], { name: '~/.ssh', outcome: 'absent', code: null });
    assert.equal(probeProblem(JSON.stringify(result)), undefined);
  } finally {
    server.close();
  }
});

// The time budget of the tests that halt a step on it: the steps before that step (Setup alone in
// two of them) must fit in it under the whole suite's load, where Setup has taken over 6 s; the
// halted step's fake answers only after a minute.
const HALT_BUDGET_MIN = '0.5';

test('a time budget of a fraction of a minute with a slow turn: the step running FAILs with "time budget", the rest SKIP, the job aborted, cleanup done', async () => {
  const ran = await smoke('smoke-time', ['--timeout-min', HALT_BUDGET_MIN, '--keep'], async (env) => {
    await script(env, [{ ...CLEAN_TURNS[0], delayMs: 60_000 }]);
    await reviewScript(env, [{ output: CHECK_READY }]);
  });
  try {
    assert.equal(ran.code, 1, ran.stdout + ran.stderr);
    assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
    assert.equal(ran.rows.get('Implementer turn')!.detail, 'time budget');
    assert.match(ran.stdout, /\njob aborted \(sf abort smoke SMOKE-1\)\n/);
    assert.match(ran.rows.get('Cleanup')!.detail, /^job reset, sf serve stopped, kept /);
    // What the factory wrote: the job aborted (then archived by the reset), never pushed.
    const archived = (await readdir(join(ran.dir, 'state', 'jobs', 'smoke'))).filter((name) => name.startsWith('SMOKE-1.'));
    assert.equal(archived.length, 1);
    const job = JSON.parse(await readFile(join(ran.dir, 'state', 'jobs', 'smoke', archived[0]!, 'job.json'), 'utf8')) as { state: string };
    assert.equal(job.state, 'aborted');
    assert.equal(git(join(ran.dir, 'origin.git'), 'branch', '--list', BRANCH).trim(), '');
    assert.deepEqual(await processesOf(ran.env.home), []);
    await untouched(ran);
  } finally {
    await rm(ran.dir, { recursive: true, force: true });
  }
});

// The live processes whose environment has HOME=home: the test's fakes and sf processes (Linux /proc).
async function processesOf(home: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid)) {
    const environ = await readFile(`/proc/${name}/environ`, 'utf8').catch(() => '');
    if (environ.split('\0').includes(`HOME=${home}`)) {
      found.push(`${name}: ${(await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '')).replaceAll('\0', ' ')}`);
    }
  }
  return found;
}

test('a halt during sf check-task ends its whole process group: the Task check\'s Claude Code does not outlive the stopped sf, nothing of the run is left', async () => {
  const ran = await smoke('smoke-group', ['--timeout-min', HALT_BUDGET_MIN], async (env) => {
    // The check's session would answer only after a minute, and lingers that long once its sf is gone.
    await reviewScript(env, [{ output: CHECK_READY, delayMs: 60_000 }]);
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Task check')!.detail, 'time budget');
  // The fake review started (it counts its run first) and was ended with the group.
  assert.equal(await readFile(join(ran.env.home, 'fake-review.count'), 'utf8'), '1');
  assert.deepEqual(await processesOf(ran.env.home), []);
  await onlyChecksDir(ran.tmp);
});

test('a halt waits for the running child sf command\'s whole group, SIGKILL included, before the step ends and the job would be aborted', async () => {
  const ran = await smoke('smoke-stubborn', ['--timeout-min', HALT_BUDGET_MIN], async (env) => {
    // Claude Code that leaves a process ignoring SIGTERM in the group of sf check-task: only the
    // SIGKILL after 15 s ends it.
    const wrapper = join(env.home, 'stubborn-claude');
    await writeFile(wrapper, `#!/bin/sh\nsh -c 'trap "" TERM; while :; do sleep 1; done' &\nexec '${process.execPath}' '${FAKE}' "$@"\n`);
    await chmod(wrapper, 0o755);
    await reviewScript(env, [{ output: CHECK_READY, delayMs: 60_000 }]);
  }, {}, undefined, (env) => ({ SF_CLAUDE: join(env.home, 'stubborn-claude') }));
  try {
    assert.equal(ran.code, 1, ran.stdout + ran.stderr);
    assert.deepEqual(statuses(ran), ['PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
    assert.equal(ran.rows.get('Task check')!.detail, 'time budget');
    // The group was stopped, SIGKILL after 15 s included, before the step's row: the step took the
    // budget's rest plus the escalation.
    assert.match(ran.stdout, /\nstopped sf check-task and its process group\nTask check: FAIL \((\d+\.\d) s\) time budget\n/);
    const seconds = Number(/\nTask check: FAIL \((\d+\.\d) s\)/.exec(ran.stdout)![1]);
    assert.ok(seconds >= 15, `the step ended after ${seconds} s, before the SIGKILL`);
    assert.deepEqual(await processesOf(ran.env.home), []);
    await onlyChecksDir(ran.tmp);
  } finally {
    // Never leave the stubborn loop behind, even when an assertion failed.
    for (const line of await processesOf(ran.env.home)) {
      process.kill(Number(line.split(':')[0]), 'SIGKILL');
    }
  }
});

test('SIGTERM during the run: the step running FAILs with "interrupted (SIGTERM)", the job aborted, sf serve stopped, the directory removed, exit 1', async () => {
  let sent = false;
  const ran = await smoke('smoke-signal', [], async (env) => {
    await script(env, [{ ...CLEAN_TURNS[0], delayMs: 60_000 }]);
    await reviewScript(env, [{ output: CHECK_READY }]);
  }, {}, (text, child) => {
    if (!sent && /^Start: PASS/m.test(text)) {
      sent = true;
      child.kill('SIGTERM');
    }
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Implementer turn')!.detail, 'interrupted (SIGTERM)');
  assert.match(ran.stdout, /\njob aborted \(sf abort smoke SMOKE-1\)\n/);
  assert.equal(ran.rows.get('Cleanup')!.detail, 'job reset, sf serve stopped, directory removed');
  assert.deepEqual(await processesOf(ran.env.home), []);
  await onlyChecksDir(ran.tmp);
  await untouched(ran);
});

test('a signal in Cleanup: the active job is aborted before its reset, Cleanup goes on to its end, exit 1', async () => {
  let sent = false;
  const ran = await smoke('smoke-cleanup-signal', ['--keep'], async (env) => {
    await script(env, CLEAN_TURNS);
    // The review fails: the job waits in needs_human, active, when Cleanup starts.
    await reviewScript(env, [{ output: CHECK_READY }, { noOutput: true }, { noOutput: true }]);
  }, {}, (text, child) => {
    // The last step's row is printed just before Cleanup starts, in the same tick.
    if (!sent && /^Dashboard: SKIP/m.test(text)) {
      sent = true;
      child.kill('SIGTERM');
    }
  });
  try {
    assert.equal(ran.code, 1, ran.stdout + ran.stderr);
    assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
    assert.match(ran.rows.get('Claude review')!.detail, /review_failed/);
    // The signal came after the steps: the job aborted in Cleanup, then reset.
    assert.match(ran.stdout, /^Dashboard: SKIP[^\n]*\njob aborted \(sf abort smoke SMOKE-1\)\nCleanup: PASS/m);
    assert.match(ran.rows.get('Cleanup')!.detail, /^job reset, sf serve stopped, kept /);
    const archived = (await readdir(join(ran.dir, 'state', 'jobs', 'smoke'))).filter((name) => name.startsWith('SMOKE-1.'));
    const job = JSON.parse(await readFile(join(ran.dir, 'state', 'jobs', 'smoke', archived[0]!, 'job.json'), 'utf8')) as { state: string };
    assert.equal(job.state, 'aborted');
    assert.deepEqual(await processesOf(ran.env.home), []);
  } finally {
    await rm(ran.dir, { recursive: true, force: true });
  }
});

// The pid of a live process whose command line holds these arguments in a row and whose HOME is
// home (Linux /proc), or undefined.
async function findProcess(home: string, args: string[]): Promise<number | undefined> {
  const needle = `\0${args.join('\0')}\0`;
  for (const name of (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))) {
    const command = await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '');
    if (command.includes(needle) && (await readFile(`/proc/${name}/environ`, 'utf8').catch(() => '')).split('\0').includes(`HOME=${home}`)) {
      return Number(name);
    }
  }
  return undefined;
}

test('the first signal while Cleanup\'s sf reset runs: the job was aborted before the reset (sf serve runs a reset it was asked for to its end), exit 1', async () => {
  let home = '';
  let caught: number | undefined;
  let watching = false;
  const ran = await smoke('smoke-reset-signal', ['--keep'], async (env) => {
    home = env.home;
    await script(env, CLEAN_TURNS);
    // The review fails: the job waits in needs_human, active, when Cleanup starts.
    await reviewScript(env, [{ output: CHECK_READY }, { noOutput: true }, { noOutput: true }]);
  }, {}, (text, child) => {
    if (watching || !/^Dashboard: SKIP/m.test(text)) {
      return;
    }
    watching = true;
    // Watch for Cleanup's sf reset and signal the smoke while it runs.
    void (async () => {
      const deadline = Date.now() + 30_000;
      while (caught === undefined && Date.now() < deadline && child.exitCode === null) {
        caught = await findProcess(home, ['reset', 'smoke', 'SMOKE-1']);
      }
      if (caught !== undefined) {
        child.kill('SIGTERM');
      }
    })();
  });
  try {
    assert.notEqual(caught, undefined, `Cleanup's sf reset was not seen running:\n${ran.stdout}`);
    assert.equal(ran.code, 1, ran.stdout + ran.stderr);
    assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
    assert.match(ran.stdout, /^Dashboard: SKIP[^\n]*\njob aborted \(sf abort smoke SMOKE-1\)\nCleanup: PASS/m);
    assert.match(ran.rows.get('Cleanup')!.detail, /^job reset, sf serve stopped, kept /);
    const archived = (await readdir(join(ran.dir, 'state', 'jobs', 'smoke'))).filter((name) => name.startsWith('SMOKE-1.'));
    assert.equal(archived.length, 1);
    const job = JSON.parse(await readFile(join(ran.dir, 'state', 'jobs', 'smoke', archived[0]!, 'job.json'), 'utf8')) as { state: string };
    assert.equal(job.state, 'aborted');
    assert.deepEqual(await processesOf(ran.env.home), []);
  } finally {
    await rm(ran.dir, { recursive: true, force: true });
  }
});

// A detached sleeper (its own process group), for the ProcessGroups tests.
function sleeper(command = 'sleep 30'): ChildProcess {
  return spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' });
}

const exited = (child: ChildProcess): Promise<void> => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve())));
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('ProcessGroups: a group never seen, or one whose id now names other processes (a reused pid), is never signalled', async () => {
  const unrelated = sleeper();
  const reused = sleeper();
  try {
    const groups = new ProcessGroups();
    await groups.end(unrelated.pid!, 100);
    // The id is tracked, but what it names now is not the process seen (another start time).
    groups.track(reused.pid!, '1');
    assert.equal(groups.owned(reused.pid!), false);
    assert.deepEqual(groups.ids(), []);
    await groups.end(reused.pid!, 100);
    assert.equal(isAlive(unrelated.pid!), true);
    assert.equal(isAlive(reused.pid!), true);
  } finally {
    unrelated.kill('SIGKILL');
    reused.kill('SIGKILL');
  }
});

test('ProcessGroups: a group that ended is forgotten, so its id is never signalled again; one left with orphans is ended whole', async () => {
  const groups = new ProcessGroups();
  const short = sleeper('true');
  groups.track(short.pid!);
  await exited(short);
  groups.observe();
  assert.deepEqual(groups.ids(), []);

  // The leader starts a grandchild and is killed alone: the orphan keeps the group, which is still the run's.
  const leader = sleeper('sleep 30 & wait');
  groups.track(leader.pid!);
  await new Promise((resolve) => setTimeout(resolve, 200));
  groups.observe();
  const orphanGroup = leader.pid!;
  leader.kill('SIGKILL');
  await exited(leader);
  assert.equal(groups.owned(orphanGroup), true);
  assert.doesNotThrow(() => process.kill(-orphanGroup, 0));
  await groups.end(orphanGroup, 100);
  assert.equal(groups.owned(orphanGroup), false);
  assert.throws(() => process.kill(-orphanGroup, 0), { code: 'ESRCH' });

  // terminate: a live child and its group end together.
  const child = sleeper('sleep 30 & wait');
  groups.track(child.pid!);
  await terminate(child, groups, 100);
  assert.throws(() => process.kill(-child.pid!, 0), { code: 'ESRCH' });
});

// The start time of a live process (field 22 of /proc/<pid>/stat), as src/pid-lock.ts writes it.
async function startOf(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
}

test('trackRunnerLock: a runner is tracked by the identity its lock holds; a pid reused since then (another start time) is never taken for it nor signalled', async () => {
  const lockDir = join(temp, 'runner-locks');
  await mkdir(lockDir, { recursive: true });
  const reused = sleeper();
  const runner = sleeper();
  try {
    const groups = new ProcessGroups();
    // The lock names the runner that held this pid before; the pid is another process's now.
    const stale = join(lockDir, 'stale.pid');
    await writeFile(stale, `${reused.pid!} 1\n`);
    await trackRunnerLock(groups, stale);
    assert.equal(groups.owned(reused.pid!), false);
    await groups.end(reused.pid!, 100);
    assert.equal(isAlive(reused.pid!), true);

    // A lock without a start time, or with no pid, tracks nothing.
    const bare = join(lockDir, 'bare.pid');
    await writeFile(bare, `${reused.pid!}\n`);
    await trackRunnerLock(groups, bare);
    await writeFile(bare, 'nonsense\n');
    await trackRunnerLock(groups, bare);
    await trackRunnerLock(groups, join(lockDir, 'missing.pid'));
    assert.deepEqual(groups.ids(), []);

    // The lock of the live runner: its group is the run's and ends.
    const live = join(lockDir, 'live.pid');
    await writeFile(live, `${runner.pid!} ${await startOf(runner.pid!)}\n`);
    await trackRunnerLock(groups, live);
    assert.equal(groups.owned(runner.pid!), true);
    await groups.end(runner.pid!, 100);
    assert.throws(() => process.kill(-runner.pid!, 0), { code: 'ESRCH' });
    assert.equal(isAlive(reused.pid!), true);
  } finally {
    reused.kill('SIGKILL');
    runner.kill('SIGKILL');
  }
});

test('a budget exceeded after the monitor\'s last poll still fails the run: the check before the next step catches it', async () => {
  const env = await newEnv('smoke-unpolled');
  const tmp = join(temp, 'smoke-unpolled', 'tmp');
  await mkdir(tmp, { recursive: true });
  await cleanScripts(env);
  // runSmoke in this process, with the children's environment as sf smoke would give it.
  const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SF_CLAUDE: process.env.SF_CLAUDE, SF_CODEX: process.env.SF_CODEX, SF_GATE: process.env.SF_GATE };
  Object.assign(process.env, { HOME: env.home, TMPDIR: tmp, SF_CLAUDE: FAKE, SF_CODEX: fakeCodex, SF_GATE: 'codex' });
  const lines: string[] = [];
  let code: number;
  try {
    // The Task check (0.0456) and iteration 1 (0.0123) stay within 0.08 USD; the review's 0.0456 goes
    // over it. The monitor never polls (an hour): only the checks around the steps can see it.
    code = await runSmoke({ keep: false, timeoutMin: 20, budgetUsd: 0.08, monitorMs: 3_600_000 }, (line) => lines.push(line));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
  const output = lines.join('\n');
  assert.equal(code, 1, output);
  const status = (step: string): string | undefined => new RegExp(`^${step}: (PASS|FAIL|SKIP)`, 'm').exec(output)?.[1];
  assert.deepEqual(STEPS.map(status), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'PASS'], output);
  assert.match(output, /^Codex gate: FAIL \(0\.0 s\) cost budget$/m);
  assert.match(output, /^job aborted \(sf abort smoke SMOKE-1\)$/m);
  assert.match(output, /^smoke: FAIL \(1 of 11 steps\), cost 0\.1035 USD/m);
  await onlyChecksDir(tmp);
});

test('a signal while the temporary directory is being made: the run still ends through Cleanup, the directory removed, exit 1', async () => {
  const tmp = join(temp, 'smoke-early-signal', 'tmp');
  await mkdir(tmp, { recursive: true });
  // Never a real Claude Code or Codex, and a short time budget, should the signal not stop the run.
  const saved = { TMPDIR: process.env.TMPDIR, SF_CLAUDE: process.env.SF_CLAUDE, SF_GATE: process.env.SF_GATE };
  Object.assign(process.env, { TMPDIR: tmp, SF_CLAUDE: '/bin/false', SF_GATE: 'off' });
  const lines: string[] = [];
  let code: number;
  const before = process.listeners('SIGTERM');
  try {
    // runSmoke runs up to its first await (making the directory) before this line goes on: the
    // signal comes in that window, through the handler it installed.
    const running = runSmoke({ keep: false, timeoutMin: 0.05, budgetUsd: 2 }, (line) => lines.push(line));
    const added = process.listeners('SIGTERM').filter((listener) => !before.includes(listener));
    assert.equal(added.length, 1, 'no SIGTERM handler before the directory is made');
    (added[0] as (signal: NodeJS.Signals) => void)('SIGTERM');
    code = await running;
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
  const output = lines.join('\n');
  assert.equal(code, 1, output);
  assert.match(lines[0]!, /\/sf-smoke-[^/]+$/);
  assert.match(output, /^Setup: FAIL \(0\.0 s\) interrupted \(SIGTERM\)$/m);
  assert.match(output, /^Cleanup: PASS \(\d+\.\d s\) no job to reset, directory removed$/m);
  assert.match(output, /^smoke: FAIL \(1 of 11 steps\)/m);
  await onlyChecksDir(tmp);
  // Its handlers are gone with the run.
  assert.deepEqual(process.listeners('SIGTERM'), before);
});

test('usage errors exit 2: an unknown option, a positional argument, a budget that is not a positive number', async () => {
  for (const args of [['--fast'], ['now'], ['--timeout-min', '0'], ['--timeout-min', 'ten'], ['--budget-usd', '-1'], ['--budget-usd=1e3'], ['--timeout-min']]) {
    const ran = await smoke(`smoke-usage-${args.join('').replace(/\W/g, '')}`, args, async () => undefined);
    assert.equal(ran.code, 2, `${args.join(' ')}: ${ran.stdout}${ran.stderr}`);
    assert.match(ran.stderr, /^sf: /);
    // Nothing was made.
    assert.deepEqual(await readdir(ran.tmp), []);
  }
  assert.deepEqual(['12', '0.05', '.5', '3.'].map(positiveDecimal), [12, 0.05, 0.5, 3]);
  assert.deepEqual(['0', '0.0', '-1', '1e3', '', 'x', '1.2.3'].map(positiveDecimal), [undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
});

test('the child environment: the user\'s SF_* settings dropped but the factory\'s executables, gate and sandbox; the smoke\'s directories, ports, models and limits on top', () => {
  const paths = smokePaths('/tmp/sf-smoke-x');
  const env = childEnv({
    PATH: '/bin', HOME: '/home/u', OPENAI_API_KEY: 'k',
    SF_CLAUDE: '/c', SF_CODEX: '/x', SF_GATE: 'codex', SF_SANDBOX: 'off', SF_SANDBOX_DOMAINS: 'a.org', SF_GATE_TIMEOUT_MS: '5',
    SF_STATE_DIR: '/mine', SF_CONFIG_DIR: '/mine/c', SF_NTFY_URL: 'u', SF_NTFY_TOKEN: 't', SF_GITHUB_TOKEN: 'g', SF_GITLAB_TOKEN: 'l', SF_GITLAB_URL: 'h',
    SF_TEST_HOOKS: 'on', SF_SENSITIVE_PATHS: 'x', SF_HANDBOOK: '/h', SF_MAX_JOBS: '9', SF_TASK_CHECK_AUTO: 'off', SF_SMOKE_CODEX_MODEL: 'gpt-mini',
  }, paths);
  assert.deepEqual(env, {
    PATH: '/bin', HOME: '/home/u', OPENAI_API_KEY: 'k',
    SF_CLAUDE: '/c', SF_CODEX: '/x', SF_GATE: 'codex', SF_SANDBOX: 'off', SF_SANDBOX_DOMAINS: 'a.org', SF_GATE_TIMEOUT_MS: '5',
    SF_STATE_DIR: '/tmp/sf-smoke-x/state', SF_CONFIG_DIR: '/tmp/sf-smoke-x/config', SF_WORKTREE_ROOT: '/tmp/sf-smoke-x/worktrees',
    SF_PORT: '0', SF_DASHBOARD_PORT: '0', SF_HANDOFF: 'off', SF_SIMPLIFY: 'off', SF_DESKTOP_NOTIFY: 'off', SF_REVIEW: 'on', SF_DASHBOARD: 'on',
    SF_ENV_FILE: '/tmp/sf-smoke-x/empty.env', SF_MODEL: 'haiku', SF_REVIEW_MODEL: 'haiku', SF_CODEX_MODEL: 'gpt-mini',
    SF_MAX_TURNS: '40', SF_REVIEW_MAX_TURNS: '30', SF_TASK_CHECK_MAX_TURNS: '30', SF_MAX_ITERATIONS: '2', SF_GATE_MAX_ROUNDS: '1', SF_GATE_MAX_TOKENS: '400000',
  });
  assert.deepEqual([...PASSED_SETTINGS].sort(), ['SF_CLAUDE', 'SF_CODEX', 'SF_GATE', 'SF_GATE_TIMEOUT_MS', 'SF_SANDBOX', 'SF_SANDBOX_DOMAINS']);
  // SF_SMOKE_MODEL picks the Claude model; without SF_SMOKE_CODEX_MODEL Codex keeps its default.
  const own = childEnv({ SF_SMOKE_MODEL: 'sonnet', SF_CODEX_MODEL: 'big' }, paths);
  assert.deepEqual([own.SF_MODEL, own.SF_REVIEW_MODEL, own.SF_CODEX_MODEL], ['sonnet', 'sonnet', undefined]);
  // SF-104: with the run's probe, SF_SMOKE_PROBE_ALLOW is its command; without one (or the user's
  // own value) it is absent.
  assert.equal('SF_SMOKE_PROBE_ALLOW' in childEnv({ SF_SMOKE_PROBE_ALLOW: 'rm -rf ~' }, paths), false);
  const probe = smokeProbe(paths, 'ab'.repeat(32), undefined);
  assert.deepEqual(childEnv({ SF_SMOKE_PROBE_ALLOW: 'rm -rf ~' }, paths, probe), { ...childEnv({}, paths), SF_SMOKE_PROBE_ALLOW: probeCommand(probe) });
});

test('SF_SMOKE_MODEL and SF_SMOKE_CODEX_MODEL are public settings: their model names are never redacted from prose', () => {
  const redactor = new Redactor({ cwd: '/work', env: { SF_SMOKE_MODEL: 'haiku', SF_SMOKE_CODEX_MODEL: 'gpt-mini', OTHER: 'secret-value' }, home: '/home/u' });
  assert.equal(redactor.text('haiku and gpt-mini, not secret-value'), 'haiku and gpt-mini, not [redacted:OTHER]');
});
