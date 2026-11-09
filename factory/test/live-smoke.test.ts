// End-to-end tests of `sf smoke` (SF-090) with the harness's fake Claude Code (SF_CLAUDE) and fake
// Codex (SF_CODEX, SF_GATE=codex over the harness's off), a TMPDIR the test owns and the test's own
// SF_STATE_DIR and SF_CONFIG_DIR (with an env file holding a Git host token), which the smoke must
// leave untouched: the steps of a run and the Sandbox step's checks. The time budget, the signals,
// the process groups, the child environment, the option parsing and the redaction of its settings
// are test/live-smoke-halt.test.ts's (SF-152: one file ran near run-tests' per-file limit).
// SF-125: the Gate sandbox step, through the harness's fake bwrap.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { CLASSIFIER_DENIAL, DONT_ASK_DENIAL, initToolsProblem, outsideWriteProblem, PROBE_SCRIPT, PROBES, probeCallProblem, probeCommand, probeProblem, smokePaths, smokeProbe, smokeTask, STEPS } from '../src/live-smoke.js';
import { FILE_GUARD } from '../src/sandbox-denials.js';
import { bwrapLog, codexLog, codexScript, fakeCodex, fakeLog, git, reviewLog, reviewScript, script, temp } from './support/harness.js';
import { BRANCH, CHECK_READY, CLAUDE_CLEAN, CLEAN_TURNS, cleanScripts, onlyChecksDir, probeOutput, smoke, statuses, untouched } from './support/live-smoke.js';

test('a clean run: every step PASS, exit 0, the temp directory gone, the user\'s state and config untouched; the children ran in the smoke\'s directories without the user\'s SF_* settings', async () => {
  const ran = await smoke('smoke-clean', [], cleanScripts);
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), STEPS.map(() => 'PASS'), ran.stdout);
  assert.match(ran.dir, /\/sf-smoke-[^/]+$/);
  assert.ok(ran.dir.startsWith(ran.tmp), ran.dir);
  assert.match(ran.stdout, /\nsmoke: PASS, cost \d+\.\d{4} USD, gate 1100 tokens\n$/);
  assert.match(ran.rows.get('Task check')!.detail, /^verdict ready/);
  assert.equal(ran.rows.get('Sandbox')!.detail, `every probe refused (${PROBES.length}), no web tools, the Write outside the worktree refused`);
  assert.equal(ran.rows.get('Gate sandbox')!.detail, 'the canary env file and jobs/ hidden inside the gate\'s wrapper');
  assert.match(ran.rows.get('Codex gate')!.detail, /clean, 1100 tokens/);
  assert.match(ran.rows.get('MR text')!.detail, /^feat\(SMOKE-1\): Add a second greeting line$/);
  assert.match(ran.rows.get('Approve')!.detail, new RegExp(`^${BRANCH} at [0-9a-f]{12} on origin\\.git$`));
  // SF-126: sf serve prints the dashboard with <token>; the smoke builds the URL from the printed
  // port and the token file of its state directory, so the Dashboard step reads every page with it.
  assert.match(ran.rows.get('Setup')!.detail, /^sf serve ready, dashboard on port \d+$/);
  assert.match(ran.rows.get('Dashboard')!.detail, /^7 answers: the page and 6 API$/);
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
    // The user's paths found as the smoke finds them, in the test's home (SF-123).
    const found = (path: string): string | undefined => (existsSync(path) ? path : undefined);
    const probe = smokeProbe(smokePaths(ran.dir), createHash('sha256').update(canary).digest('hex'), {
      ssh: found(join(ran.env.home, '.ssh')), dbus: found(`/run/user/${process.getuid!()}/bus`), docker: found('/var/run/docker.sock'),
      claudeProjects: found(join(ran.env.home, '.claude', 'projects')),
    }, ran.env.home);
    assert.equal(probe.homeCanary, join(ran.env.home, `.sf-smoke-${basename(ran.dir).slice('sf-smoke-'.length)}`, 'canary'));
    const task = git(join(ran.dir, 'origin.git'), 'show', 'main:.software-factory/SMOKE-1.md');
    assert.equal(task, smokeTask(probe, join(ran.dir, 'outside.txt')));
    assert.ok(task.includes(`--home-canary '${probe.homeCanary}'`));
    // SF-123: the Write outside the worktree asked for; the home canary gone with Cleanup.
    assert.ok(task.replace(/\s+/g, ' ').includes(`with the Write tool, write the line "outside" to the file \`${join(ran.dir, 'outside.txt')}\``));
    assert.equal(existsSync(dirname(probe.homeCanary)), false);
    assert.equal(existsSync(join(ran.dir, 'outside.txt')), false);
    assert.ok(task.includes(probeCommand(probe)));
    // SF-110: the probe as one Bash call on its own, then probe.json read with the Read tool.
    assert.ok(task.replace(/\s+/g, ' ').includes('as one Bash call on its own, with nothing before or after it (no `cd`, `echo`, `cat`, `;`, `&&` or `|`)'));
    assert.ok(task.includes('Then read `probe.json` with the Read tool.'));
    assert.ok(!task.includes(canary.trim()) && !ran.stdout.includes(canary.trim()));
    assert.equal(git(join(ran.dir, 'origin.git'), 'show', 'main:probe.mjs'), PROBE_SCRIPT);
    assert.equal(git(join(ran.dir, 'origin.git'), 'show', `${BRANCH}:probe.json`), probeOutput());
    assert.equal(git(join(ran.dir, 'origin.git'), 'log', '-1', '--format=%an <%ae>', 'main').trim(), 'sf-smoke <sf-smoke@localhost>');
    // SF-104, SF-109, SF-110: the Implementer ran in dontAsk, with the probe's prefix rule and the
    // file tools of the ticket allowed.
    for (const entry of await fakeLog(ran.env)) {
      assert.deepEqual(entry.argv.filter((arg) => arg.startsWith('--allowedTools')), ['--allowedTools=Bash(node probe.mjs:*),Read,Edit,Write,Glob,Grep,TodoWrite']);
      assert.deepEqual(entry.argv.filter((arg) => arg.startsWith('--permission-mode')), ['--permission-mode=dontAsk']);
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
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.match(ran.rows.get('Claude review')!.detail, /^needs_human: review_failed: /);
  // Cleanup aborts the active job before its reset.
  assert.match(ran.stdout, /^Dashboard: SKIP[^\n]*\njob aborted \(sf abort smoke SMOKE-1\)\nCleanup: PASS/m);
  assert.match(ran.stdout, /\nsmoke: FAIL \(1 of 12 steps\), cost \d+\.\d{4} USD, gate 0 tokens\n$/);
  assert.equal((await codexLog(ran.env).catch(() => [])).length, 0);
  await onlyChecksDir(ran.tmp);
  await untouched(ran);
});

test('the gate off: the Codex gate step FAILs with sf info\'s reason, the job still goes on to the push and the dashboard, the run ends as FAIL', async () => {
  const ran = await smoke('smoke-gate-off', [], cleanScripts, { SF_GATE: 'off' });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'PASS', 'PASS', 'PASS', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Codex gate')!.detail, 'the gate is off (SF_GATE=off)');
  assert.match(ran.stdout, /\nsmoke: FAIL \(1 of 12 steps\), cost \d+\.\d{4} USD, gate 0 tokens\n$/);
  await onlyChecksDir(ran.tmp);
});

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

test('the init-tools check (SF-123): fails on an Implementer init that lists WebFetch or WebSearch, or on no init; a reviewer\'s init does not count', () => {
  const init = (tools: string[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ ts: 't', iteration: 1, ...extra, message: { type: 'system', subtype: 'init', tools, session_id: 's' } });
  assert.equal(initToolsProblem(init(['Bash', 'Read', 'Write'])), undefined);
  assert.equal(initToolsProblem(init(['Bash', 'WebFetch'])), 'the Implementer was offered WebFetch');
  assert.equal(initToolsProblem([init(['Bash']), init(['WebSearch', 'WebFetch'])].join('\n')), 'the Implementer was offered WebSearch and WebFetch');
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

test('SF_SANDBOX=off: the Sandbox step is a SKIP that counts as a pass, the last line says the sandbox was not checked, exit 0', async () => {
  const ran = await smoke('smoke-sandbox-off', [], cleanScripts, { SF_SANDBOX: 'off' });
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), STEPS.map((step) => (step === 'Sandbox' || step === 'Gate sandbox' ? 'SKIP' : 'PASS')), ran.stdout);
  assert.equal(ran.rows.get('Gate sandbox')!.detail, 'sandbox off');
  assert.equal(ran.rows.get('Sandbox')!.detail, 'sandbox off');
  assert.match(ran.stdout, /\nsmoke: PASS \(sandbox not checked\), cost \d+\.\d{4} USD, gate 1100 tokens\n$/);
});

test('Gate sandbox (SF-125): the canary read inside the gate\'s wrapper (a bwrap that hides nothing) FAILs the step, the later steps SKIP; the wrapper was the job\'s', async () => {
  const ran = await smoke('smoke-gate-sandbox-open', [], async (env) => {
    await cleanScripts(env);
    await writeFile(join(env.home, 'fake-bwrap.json'), JSON.stringify({ open: true }));
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Gate sandbox')!.detail, 'the gate\'s wrapper let through: cat of the canary env file exited 0, cat of the job\'s job.json under jobs/ exited 0');
  // The three commands, each inside the wrapper of the job's worktree, its iteration directory read-write last.
  // The gate's own runs (sf serve goes on with the job until Cleanup) aside.
  const runs = (await bwrapLog(ran.env)).filter((run) => run.argv[run.argv.indexOf('--') + 1] !== fakeCodex);
  const worktree = join(ran.dir, 'worktrees', 'smoke', 'SMOKE-1');
  const iteration = join(ran.dir, 'state', 'jobs', 'smoke', 'SMOKE-1', 'iterations', '001');
  assert.deepEqual(runs.map((run) => run.argv.slice(run.argv.indexOf('--'))), [
    ['--', 'ls', worktree], ['--', 'cat', join(ran.dir, 'config', 'auth.env')], ['--', 'cat', join(ran.dir, 'state', 'jobs', 'smoke', 'SMOKE-1', 'job.json')],
  ]);
  for (const run of runs) {
    const cut = run.argv.indexOf('--');
    assert.deepEqual(run.argv.slice(cut - 3, cut), ['--bind', iteration, iteration]);
    assert.ok(run.argv.join(' ').includes(`--ro-bind ${worktree} ${worktree}`));
  }
  await onlyChecksDir(ran.tmp);
});

test('Gate sandbox (SF-125): a canary env file missing outside the wrapper FAILs the step: a hidden one would prove nothing', async () => {
  let removed = false;
  const ran = await smoke('smoke-gate-sandbox-missing', [], cleanScripts, {}, (text) => {
    if (!removed && /^Setup: PASS/m.test(text)) {
      removed = true;
      void rm(join(text.split('\n')[0]!, 'config', 'auth.env'), { force: true });
    }
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Gate sandbox')!.detail, `the canary env file ${join(ran.dir, 'config', 'auth.env')} is missing outside the wrapper`);
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
  // Given the run's probe: absent only for a path the smoke did not give it (missing outside the sandbox).
  const paths = smokePaths('/t/sf-smoke-x');
  const given = smokeProbe(paths, 'ab'.repeat(32), { ssh: '/h/.ssh', dbus: '/run/user/1/bus', docker: '/var/run/docker.sock' }, '/h');
  const absent = probeOutput({ '~/.ssh': 'absent', dbus: 'absent', 'docker.sock': 'absent', '~/.claude/projects': 'absent' });
  assert.equal(probeProblem(absent, given), '~/.ssh absent, though it exists, dbus absent, though it exists, docker.sock absent, though it exists');
  assert.equal(probeProblem(absent, smokeProbe(paths, 'ab'.repeat(32), {}, '/h')), undefined);
  assert.equal(probeProblem(JSON.stringify(PROBES.filter((name) => name !== 'dbus').map((name) => ({ name, outcome: 'refused' })))), 'dbus missing');
  assert.equal(probeProblem(JSON.stringify([{ name: 'auth.env', outcome: 'refused' }])), 'dashboard-token missing, jobs missing, sf.sock missing, ~/.ssh missing, SSH_AUTH_SOCK missing, dbus missing, docker.sock missing, home-canary missing, ~/.claude/projects missing');
  assert.equal(probeProblem('not json'), 'probe.json is not JSON');
  assert.equal(probeProblem('{}'), 'probe.json is not a list of probes');
});

test('the probe script: allowed only for what access shows (the canary by its SHA-256, a token, the job in jobs/, a connect, a non-empty ~/.ssh, home canary and projects listing); refused for a hidden or missing path; absent exactly for an option not given; never prints what it read', async () => {
  const dir = join(temp, 'probe-script');
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'state', 'jobs', 'smoke'), { recursive: true });
  await mkdir(join(dir, 'ssh'));
  await mkdir(join(dir, 'projects', 'p'), { recursive: true });
  await writeFile(join(dir, 'home-canary'), 'canary-value\n');
  await writeFile(join(dir, 'probe.mjs'), PROBE_SCRIPT);
  const canary = 'SF_CANARY=0123456789abcdef\n';
  await writeFile(join(dir, 'auth.env'), canary);
  await writeFile(join(dir, 'state', 'dashboard-token'), 'token-value\n');
  await writeFile(join(dir, 'ssh', 'id_test'), 'key');
  const socket = join(dir, 'state', 'sf.sock');
  const servers = [socket, join(dir, 'bus'), join(dir, 'docker.sock')].map((path) => {
    const server = createServer((connection) => connection.end());
    return { server, listening: new Promise<void>((resolve) => server.listen(path, resolve)) };
  });
  await Promise.all(servers.map(({ listening }) => listening));
  const run = (probe: Parameters<typeof probeCommand>[0], env: NodeJS.ProcessEnv): string =>
    execFileSync('sh', ['-c', probeCommand(probe).replace(/ > probe\.json$/, '')], { cwd: dir, env, encoding: 'utf8' });
  const sha = createHash('sha256').update(canary).digest('hex');
  try {
    const open = {
      canary: join(dir, 'auth.env'), canarySha256: sha, token: join(dir, 'state', 'dashboard-token'), jobs: join(dir, 'state', 'jobs'), job: 'smoke', socket, ssh: join(dir, 'ssh'),
      dbus: join(dir, 'bus'), docker: join(dir, 'docker.sock'), claudeProjects: join(dir, 'projects'), homeCanary: join(dir, 'home-canary'),
    };
    const allowed = run(open, { PATH: process.env.PATH, SSH_AUTH_SOCK: '/x' });
    assert.deepEqual(JSON.parse(allowed), [
      { name: 'auth.env', outcome: 'allowed', code: null }, { name: 'dashboard-token', outcome: 'allowed', code: null }, { name: 'jobs', outcome: 'allowed', code: null },
      { name: 'sf.sock', outcome: 'allowed', code: null }, { name: '~/.ssh', outcome: 'allowed', code: null }, { name: 'SSH_AUTH_SOCK', outcome: 'allowed', code: null },
      { name: 'dbus', outcome: 'allowed', code: null }, { name: 'docker.sock', outcome: 'allowed', code: null }, { name: 'home-canary', outcome: 'allowed', code: null },
      { name: '~/.claude/projects', outcome: 'allowed', code: null },
    ]);
    assert.ok(!allowed.includes('SF_CANARY') && !allowed.includes('token-value') && !allowed.includes('canary-value'));
    // What a sandbox shows for a denied path: an empty file, an empty folder, nothing at all.
    await writeFile(join(dir, 'empty'), '');
    await mkdir(join(dir, 'none'), { recursive: true });
    const hidden = {
      ...open, canary: join(dir, 'empty'), token: join(dir, 'empty'), jobs: join(dir, 'none'), socket: join(dir, 'missing.sock'), ssh: join(dir, 'none'),
      dbus: join(dir, 'missing.sock'), docker: join(dir, 'empty'), claudeProjects: join(dir, 'none'), homeCanary: join(dir, 'empty'),
    };
    assert.deepEqual(JSON.parse(run(hidden, { PATH: process.env.PATH })), [
      { name: 'auth.env', outcome: 'refused', code: null }, { name: 'dashboard-token', outcome: 'refused', code: null }, { name: 'jobs', outcome: 'refused', code: null },
      { name: 'sf.sock', outcome: 'refused', code: 'ENOENT' }, { name: '~/.ssh', outcome: 'refused', code: null }, { name: 'SSH_AUTH_SOCK', outcome: 'absent', code: null },
      { name: 'dbus', outcome: 'refused', code: 'ENOENT' }, { name: 'docker.sock', outcome: 'refused', code: 'ECONNREFUSED' }, { name: 'home-canary', outcome: 'refused', code: null },
      { name: '~/.claude/projects', outcome: 'refused', code: null },
    ]);
    // Options not given: absent, but for the home canary, which is always given (a missing one is refused).
    const gone = { ...hidden, canary: join(dir, 'missing'), ssh: undefined, dbus: undefined, docker: undefined, claudeProjects: undefined, homeCanary: join(dir, 'missing') };
    const result = JSON.parse(run(gone, { PATH: process.env.PATH })) as Array<{ name: string; outcome: string; code: string | null }>;
    assert.deepEqual(result[0], { name: 'auth.env', outcome: 'refused', code: 'ENOENT' });
    assert.deepEqual(result.slice(4).map(({ name, outcome }) => [name, outcome]), [
      ['~/.ssh', 'absent'], ['SSH_AUTH_SOCK', 'absent'], ['dbus', 'absent'], ['docker.sock', 'absent'], ['home-canary', 'refused'], ['~/.claude/projects', 'absent'],
    ]);
    assert.equal(probeProblem(JSON.stringify(result)), undefined);
    assert.ok(!probeCommand(gone).includes('--dbus') && !probeCommand(gone).includes('--docker') && !probeCommand(gone).includes('--claude-projects') && probeCommand(gone).includes('--home-canary'));
  } finally {
    servers.forEach(({ server }) => server.close());
  }
});
