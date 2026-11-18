// sf planner start and stop: the ticket's planner session (fake script and claude first on PATH),
// one per ticket, its record and its environment; a session that ended is no session; every refusal
// of start with its code; sf planner trust (a fake claude that accepts the dialog, or not) and its
// refusals; the hook's link written into its own session's record only; copyTrusted; with
// SF_PLANNER_TRUST=auto, the trust run against a fake Claude Code faithful to the captured dialog.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { acceptTrustDialog, copyTrusted, sessionFile, startPlanner, trustDialogShown } from '../src/planner-session.js';
import { type Env, git, newEnv, newRepo, processEnv, runCli, temp } from './support/harness.js';

const COMMAND_LINE = "exec claude --remote-control 'Planner app APP-12' '/planning-tasks workspace app, ticket APP-12'";
const SLEEPING_CLAUDE = 'exec sleep 60';

// The fake claude: one arg= line per argument and its environment to claude.log beside it, then body.
async function writeClaude(bin: string, body: string): Promise<void> {
  const log = join(bin, 'claude.log');
  await writeFile(join(bin, 'claude'), `#!/bin/sh\nfor arg in "$@"; do echo "arg=$arg" >> '${log}'; done\nenv >> '${log}'\n${body}\n`);
  await chmod(join(bin, 'claude'), 0o755);
}

// Workspace app with its planning copy set up and trusted, auth.env with Anthropic credentials, and
// a fake script and claude first on PATH. The fake script logs as script.log, runs its command with
// sh -c in the background, its own input passed on (a background command gets /dev/null otherwise),
// and, like the real one, ignores SIGTERM; its child does not.
async function sessionEnv(name: string): Promise<{ env: Env; copy: string; bin: string; file: string }> {
  const env = await newEnv(name);
  // newRepo registers it as workspace app.
  await newRepo(env, `${name}-repo`, false);
  const copy = join(env.home, 'planning', 'app');
  await mkdir(join(copy, '.claude'), { recursive: true });
  git(copy, 'init', '-q', '-b', 'main');
  await writeFile(join(copy, '.claude', 'planning-copy.md'), '# Planning copy of `app`\n');
  await mkdir(join(env.home, 'cc'));
  await trust(env, copy);
  await writeFile(join(env.config, 'auth.env'), 'ANTHROPIC_API_KEY=test-anthropic\nCLAUDE_CODE_OAUTH_TOKEN=test-oauth\n');
  const bin = join(temp, `${name}-bin`);
  await mkdir(bin);
  const log = join(bin, 'script.log');
  await writeFile(join(bin, 'script'), [
    '#!/bin/sh',
    `echo "cwd=$(pwd -P)" >> '${log}'`,
    `for arg in "$@"; do echo "arg=$arg" >> '${log}'; done`,
    `if [ -p /dev/stdin ]; then echo "stdin=fifo" >> '${log}'; fi`,
    `echo "$$" >> '${join(bin, 'script.pids')}'`,
    'exec 3<&0',
    'sh -c "$2" <&3 &',
    "trap '' TERM",
    'wait $!',
    `echo "exit=$?" >> '${log}'`,
    '',
  ].join('\n'));
  await chmod(join(bin, 'script'), 0o755);
  await writeClaude(bin, SLEEPING_CLAUDE);
  env.extra = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    SF_PLANNING_DIR: join(env.home, 'planning'),
    SF_GITHUB_TOKEN: 'test-token',
    OPENAI_API_KEY: 'test-key',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_outer',
    CLAUDE_CONFIG_DIR: join(env.home, 'cc'),
  };
  return { env, copy, bin, file: sessionFile(env.state, 'app', 'APP-12') };
}

// Claude Code's global config (under CLAUDE_CONFIG_DIR) trusting exactly path.
function trust(env: Env, path: string): Promise<void> {
  return writeFile(join(env.home, 'cc', '.claude.json'), JSON.stringify({ projects: { [path]: { hasTrustDialogAccepted: true } } }));
}

const recordOf = async (file: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(file, 'utf8'));

// SIGKILL to the children of pid, then to pid (a script killed first would leave its child reparented).
function forceKill(pid: number): void {
  let children: number[] = [];
  try {
    children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter((text) => text !== '').map(Number);
  } catch { // the process is gone: no children to read
  }
  for (const target of [...children, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch { // already gone
    }
  }
}

// Waits until pid is gone (reaped).
async function gone(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (existsSync(`/proc/${pid}`)) {
    assert.ok(Date.now() < deadline, `process ${pid} did not end`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Ends by force the session a record left behind names.
async function killLeft(file: string): Promise<void> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  const pid = text === undefined ? undefined : (JSON.parse(text) as { pid?: unknown }).pid;
  if (typeof pid === 'number' && pid !== process.pid) {
    forceKill(pid);
  }
}

const runs = async (bin: string): Promise<number> => (await readFile(join(bin, 'script.log'), 'utf8').catch(() => '')).split('\n').filter((line) => line.startsWith('cwd=')).length;

test('sf planner start runs one session per ticket in the planning copy; stop ends it', async () => {
  const { env, copy, bin, file } = await sessionEnv('planner-start');
  try {
    // A stop of nothing creates nothing.
    const nothing = await runCli(env, ['planner', 'stop', 'app', 'APP-12']);
    assert.deepEqual([nothing.code, nothing.stdout, nothing.stderr], [0, 'No planner of app APP-12 is running.\n', '']);
    assert.equal(existsSync(join(env.state, 'planner')), false);

    // PL-1: script once, in the copy, with the command line and /dev/null, its input a FIFO.
    const started = await runCli(env, ['planner', 'start', 'app', 'APP-12']);
    assert.equal(started.code, 0, started.stderr);
    const record = await recordOf(file);
    const pid = record.pid as number;
    assert.equal(started.stdout, [
      `Planner of app APP-12 started: Claude Code session "Planner app APP-12" in the planning copy of app (pid ${pid}).`,
      'Open it in the Claude app or on claude.ai/code under that name; once the planner first waits for you, sf planner start app APP-12 prints its link.',
      '',
    ].join('\n'));
    const scriptLog = await readFile(join(bin, 'script.log'), 'utf8');
    assert.deepEqual(scriptLog.split('\n').slice(0, 6), [`cwd=${copy}`, 'arg=-qfec', `arg=${COMMAND_LINE}`, 'arg=/dev/null', 'stdin=fifo', '']);
    const claudeLog = await readFile(join(bin, 'claude.log'), 'utf8');
    assert.deepEqual(claudeLog.split('\n').slice(0, 3), ['arg=--remote-control', 'arg=Planner app APP-12', 'arg=/planning-tasks workspace app, ticket APP-12']);

    // PL-2: the environment.
    const vars = claudeLog.split('\n').filter((line) => !line.startsWith('arg=') && line.includes('='));
    const names = vars.map((line) => line.slice(0, line.indexOf('=')));
    assert.deepEqual(names.filter((name) => name.startsWith('SF_')).sort(), ['SF_CONFIG_DIR', 'SF_PLANNER_ID', 'SF_PLANNER_TICKET', 'SF_STATE_DIR']);
    for (const line of [`SF_PLANNER_TICKET=APP-12`, `SF_PLANNER_ID=${String(record.id)}`, 'TERM=xterm-256color', `CLAUDE_CONFIG_DIR=${join(env.home, 'cc')}`]) {
      assert.ok(vars.includes(line), line);
    }
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'SF_GITHUB_TOKEN', 'OPENAI_API_KEY', 'SF_PLANNING_DIR', 'CLAUDE_CODE_BRIDGE_SESSION_ID']) {
      assert.equal(names.includes(name), false, name);
    }
    assert.equal(claudeLog.includes('test-anthropic') || claudeLog.includes('test-oauth') || claudeLog.includes('session_outer'), false);

    // PL-3: the record, mode 0600; start again answers with it and spawns nothing.
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(record), ['workspace', 'ticket', 'name', 'id', 'pid', 'pid_start', 'started_at']);
    assert.deepEqual([record.workspace, record.ticket, record.name], ['app', 'APP-12', 'Planner app APP-12']);
    assert.match(String(record.id), /^[0-9a-f-]{36}$/);
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.match(String(record.started_at), /^\d{4}-\d\d-\d\dT/);
    const again = await runCli(env, ['planner', 'start', 'app', 'APP-12']);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, new RegExp(`^Planner of app APP-12 is running since \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d \\(pid ${pid}\\); its link is recorded when it first waits for you\\.\\n$`));
    assert.equal(await runs(bin), 1);
    assert.equal(existsSync(join(copy, '.claude', 'settings.local.json')), false);

    // PL-4: stop ends it by SIGTERM to its Claude Code; again, none.
    const stopped = await runCli(env, ['planner', 'stop', 'app', 'APP-12']);
    assert.deepEqual([stopped.code, stopped.stdout, stopped.stderr], [0, `Stopped the planner of app APP-12 (pid ${pid}).\n`, '']);
    assert.equal(existsSync(file), false);
    assert.match(await readFile(join(bin, 'script.log'), 'utf8'), /^exit=143$/m);
    const none = await runCli(env, ['planner', 'stop', 'app', 'APP-12']);
    assert.deepEqual([none.code, none.stdout], [0, 'No planner of app APP-12 is running.\n']);
  } finally {
    await killLeft(file);
  }
});

test('a session that ended is no session', async () => {
  const { env, bin, file } = await sessionEnv('planner-ended');
  try {
    const first = await runCli(env, ['planner', 'start', 'app', 'APP-12']);
    assert.equal(first.code, 0, first.stderr);
    const pid = (await recordOf(file)).pid as number;
    forceKill(pid);
    await gone(pid);
    // Start starts a new one.
    const second = await runCli(env, ['planner', 'start', 'app', 'APP-12']);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /^Planner of app APP-12 started: /);
    assert.equal(await runs(bin), 2);
    const newPid = (await recordOf(file)).pid as number;
    assert.notEqual(newPid, pid);
    forceKill(newPid);
    await gone(newPid);
    // Stop prints none and removes the record.
    const stopped = await runCli(env, ['planner', 'stop', 'app', 'APP-12']);
    assert.deepEqual([stopped.code, stopped.stdout], [0, 'No planner of app APP-12 is running.\n']);
    assert.equal(existsSync(file), false);
  } finally {
    await killLeft(file);
  }
});

test('sf planner start refuses what it cannot run, each with its code', async () => {
  const { env, copy, bin, file } = await sessionEnv('planner-refused');
  const deps = { env: processEnv(env), stateDir: env.state, configDir: env.config };
  const refused = async (code: string, message: string): Promise<void> => {
    await assert.rejects(startPlanner('app', 'APP-12', deps), (error: unknown) => {
      assert.ok(error instanceof FactoryError, String(error));
      assert.deepEqual([error.code, error.message], [code, message]);
      return true;
    });
    assert.equal(existsSync(file), false, `${code} left a record`);
  };
  try {
    // A lock held by a live process.
    const lock = file.replace(/\.json$/, '.lock');
    await mkdir(join(env.state, 'planner', 'app'), { recursive: true });
    await writeFile(lock, `${process.pid}\n`);
    await refused('planner_starting', 'A start or stop of the planner of app APP-12 is under way: try again in a few seconds.');
    await rm(lock);

    // A copy without .claude/planning-copy.md.
    const pointers = join(copy, '.claude', 'planning-copy.md');
    await rm(pointers);
    await refused('planning_copy_missing', 'The planning copy of app is not set up: run sf planner setup app first.');
    await writeFile(pointers, 'pointers\n');

    // A tracked .claude/CLAUDE.md is no refusal.
    await writeFile(join(copy, '.claude', 'CLAUDE.md'), '# Rules\n');
    git(copy, 'add', '.claude/CLAUDE.md');
    git(copy, 'commit', '-q', '-m', 'claude md');
    const started = await runCli(env, ['planner', 'start', 'app', 'APP-12']);
    assert.equal(started.code, 0, started.stderr);
    const stopped = await runCli(env, ['planner', 'stop', 'app', 'APP-12']);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(stopped.stdout, /^Stopped the planner of app APP-12 \(pid \d+\)\.\n$/);

    // A tracked .claude/agents/a.md; then, that file gone, a .mcp.json link Git does not track.
    await mkdir(join(copy, '.claude', 'agents'));
    await writeFile(join(copy, '.claude', 'agents', 'a.md'), 'agent\n');
    git(copy, 'add', '.claude/agents/a.md');
    git(copy, 'commit', '-q', '-m', 'agent');
    await refused('planning_copy_unsafe', '.claude/agents/a.md is in the planning copy of app, and Claude Code would load it: remove it, run sf planner setup app, then start the planner again.');
    await rm(join(copy, '.claude', 'agents', 'a.md'));
    await symlink(join(temp, 'no-such-mcp.json'), join(copy, '.mcp.json'));
    await refused('planning_copy_unsafe', '.mcp.json is in the planning copy of app, and Claude Code would load it: remove it, run sf planner setup app, then start the planner again.');
    await rm(join(copy, '.mcp.json'));

    // A copy trusted only through its parent folder: the message names sf planner trust.
    await trust(env, join(env.home, 'planning'));
    const untrusted = 'Claude Code does not trust the planning copy of app yet: run sf planner trust app, accept its trust dialog, then start the planner again.';
    await refused('planning_copy_untrusted', untrusted);
    // The CLI: exit 1 with the message.
    const refusedCli = await runCli(env, ['planner', 'start', 'app', 'APP-12']);
    assert.deepEqual([refusedCli.code, refusedCli.stdout, refusedCli.stderr], [1, '', `sf: ${untrusted}\n`]);
    assert.equal(existsSync(file), false);
    await trust(env, copy);

    // A session that ends at once.
    await writeClaude(bin, 'exit 1');
    await refused('planner_start_failed', 'The planner of app APP-12 ended within 3 s of its start: open Claude Code in the planning copy of app by hand to see why (claude on PATH, its login, its sandbox).');
    // No record, lock or FIFO left.
    assert.deepEqual(await readdir(join(env.state, 'planner', 'app')), []);

    // A record that cannot be written: a fake mkfifo puts a folder in its way once the checks are
    // done; the session that was spawned is ended before start reports the failure.
    const realMkfifo = execFileSync('sh', ['-c', 'command -v mkfifo'], { encoding: 'utf8' }).trim();
    await writeFile(join(bin, 'mkfifo'), `#!/bin/sh\n'${realMkfifo}' "$@" || exit $?\nmkdir -p '${join(file, 'in-the-way')}'\n`);
    await chmod(join(bin, 'mkfifo'), 0o755);
    await writeClaude(bin, `echo "$$" >> '${join(bin, 'claude.pids')}'\n${SLEEPING_CLAUDE}`);
    // Through the CLI, whose PATH (mkfifo runs with the process's own) has the fake first.
    const unwritten = await runCli(env, ['planner', 'start', 'app', 'APP-12']);
    assert.equal(unwritten.code, 1, unwritten.stdout);
    assert.match(unwritten.stderr, /^sf: The planner of app APP-12 did not start: its record could not be written \(E[A-Z]+\)\.\n$/);
    const scriptPid = Number((await readFile(join(bin, 'script.pids'), 'utf8')).trim().split('\n').at(-1));
    await gone(scriptPid);
    assert.equal(existsSync(file.replace(/\.json$/, '.lock')), false);
    await rm(file, { recursive: true });
    await rm(join(bin, 'mkfifo'));

    // The usage error.
    const usage = await runCli(env, ['planner', 'start', 'app']);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /^sf: planner needs setup <workspace>, waiting <workspace> \[permission\], start <workspace> <ticket>, stop <workspace> <ticket> or trust <workspace>\./);
  } finally {
    await killLeft(file);
    await killClaudes(bin);
  }
});

// The pids the fake claudes wrote to claude.pids, in order.
const claudePids = async (bin: string): Promise<number[]> =>
  (await readFile(join(bin, 'claude.pids'), 'utf8').catch(() => '')).split('\n').filter((text) => text !== '').map(Number);

// The fake script is no terminal: a SIGKILL to it leaves its child, which the real script's hang-up
// ends; the test ends every fake claude itself.
async function killClaudes(bin: string): Promise<void> {
  for (const pid of await claudePids(bin)) {
    forceKill(pid);
  }
}

// sessionEnv's workspace with its copy untrusted, and a fake claude that logs its folder, arguments
// and environment to claude.log, then accepts the trust dialog as Claude Code would (accept true) by
// writing the copy's real path into its global config, and exits 0.
async function trustEnv(name: string, accept = true): Promise<{ env: Env; copy: string; bin: string; config: string; written: string }> {
  const { env, copy, bin } = await sessionEnv(name);
  const config = join(env.home, 'cc', '.claude.json');
  await rm(config);
  const written = JSON.stringify({ projects: { [copy]: { hasTrustDialogAccepted: true } } });
  const log = join(bin, 'claude.log');
  await writeFile(join(bin, 'claude'), [
    '#!/bin/sh',
    `echo "cwd=$(pwd -P)" >> '${log}'`,
    `for arg in "$@"; do echo "arg=$arg" >> '${log}'; done`,
    `env >> '${log}'`,
    ...(accept ? [`printf '%s' "{\\"projects\\":{\\"$(pwd -P)\\":{\\"hasTrustDialogAccepted\\":true}}}" > "\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"`] : []),
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(bin, 'claude'), 0o755);
  env.extra = { ...env.extra, TERM: 'users-own-term' };
  return { env, copy, bin, config, written };
}

test('sf planner trust opens Claude Code in the copy and reads the answer', async () => {
  const { env, copy, bin, config, written } = await trustEnv('planner-trust');
  const log = join(bin, 'claude.log');

  // TR-1: claude once, in the copy, no arguments, without the factory's token or the session markers.
  const opened = await runCli(env, ['planner', 'trust', 'app']);
  assert.deepEqual([opened.code, opened.stderr], [0, '']);
  assert.equal(opened.stdout, [
    'Claude Code opens in the planning copy of app: accept its trust dialog, then leave it with /exit.',
    'Claude Code trusts the planning copy of app now: start its planner with sf planner start app <ticket>.',
    '',
  ].join('\n'));
  const claudeLog = await readFile(log, 'utf8');
  const lines = claudeLog.split('\n');
  assert.deepEqual(lines.filter((line) => line.startsWith('cwd=')), [`cwd=${copy}`]);
  assert.deepEqual(lines.filter((line) => line.startsWith('arg=')), []);
  const names = lines.filter((line) => line.includes('=')).map((line) => line.slice(0, line.indexOf('=')));
  for (const name of ['SF_PLANNER_TICKET', 'SF_PLANNER_ID', 'SF_GITHUB_TOKEN', 'OPENAI_API_KEY', 'SF_PLANNING_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    assert.equal(names.includes(name), false, name);
  }
  // The user's own TERM, and the directory settings the copy's hook needs.
  for (const line of ['TERM=users-own-term', `CLAUDE_CONFIG_DIR=${join(env.home, 'cc')}`, `SF_STATE_DIR=${env.state}`, `SF_CONFIG_DIR=${env.config}`]) {
    assert.ok(lines.includes(line), line);
  }
  // Claude Code's global config holds only what Claude Code wrote.
  assert.equal(await readFile(config, 'utf8'), written);

  // TR-2: a trusted copy opens nothing.
  const already = await runCli(env, ['planner', 'trust', 'app']);
  assert.deepEqual([already.code, already.stdout, already.stderr], [0, 'Claude Code trusts the planning copy of app already.\n', '']);
  assert.equal(await readFile(log, 'utf8'), claudeLog);
  assert.equal(await readFile(config, 'utf8'), written);
});

test('sf planner trust refuses what it cannot open', async () => {
  const { env, copy, bin, config } = await trustEnv('planner-trust-refused', false);
  const log = join(bin, 'claude.log');
  const refused = async (code: number, message: string): Promise<void> => {
    const result = await runCli(env, ['planner', 'trust', 'app']);
    assert.deepEqual([result.code, result.stderr], [code, `sf: ${message}\n`]);
  };

  // TR-3: Claude Code ends without the acceptance.
  await refused(1, 'Claude Code still does not trust the planning copy of app: its trust dialog was not accepted. Run sf planner trust app again.');
  assert.equal((await readFile(log, 'utf8')).split('\n').filter((line) => line.startsWith('cwd=')).length, 1);
  assert.equal(existsSync(config), false);
  await rm(log);

  // TR-4: a copy not set up, a copy holding .mcp.json: claude is not run.
  const pointers = join(copy, '.claude', 'planning-copy.md');
  await rm(pointers);
  await refused(1, 'The planning copy of app is not set up: run sf planner setup app first.');
  await writeFile(pointers, 'pointers\n');
  await writeFile(join(copy, '.mcp.json'), '{}\n');
  await refused(1, '.mcp.json is in the planning copy of app, and Claude Code would load it: remove it, run sf planner setup app, then sf planner trust app.');
  await rm(join(copy, '.mcp.json'));
  assert.equal(existsSync(log), false);

  // No claude on PATH: a folder holding only a link to git.
  const gitOnly = join(temp, 'planner-trust-git-only');
  await mkdir(gitOnly);
  await symlink(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(gitOnly, 'git'));
  const extra = env.extra;
  env.extra = { ...extra, PATH: gitOnly };
  await refused(1, 'Claude Code (claude) is not on PATH: install it, then run sf planner trust app again.');
  env.extra = extra;

  // No workspace: the planner's usage error.
  const usage = await runCli(env, ['planner', 'trust']);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /^sf: planner needs setup <workspace>, waiting <workspace> \[permission\], start <workspace> <ticket>, stop <workspace> <ticket> or trust <workspace>\./);
  assert.equal(existsSync(log), false);
  assert.equal(existsSync(config), false);
});

test('the hook records the link in its own session\'s record only', async () => {
  const env = await newEnv('planner-link');
  const file = sessionFile(env.state, 'app', 'APP-12');
  await mkdir(join(env.state, 'planner', 'app'), { recursive: true });
  // The test process stands in for the session's script: alive, and never signalled here.
  const record = { workspace: 'app', ticket: 'APP-12', name: 'Planner app APP-12', id: 'id-1', pid: process.pid, started_at: new Date().toISOString() };
  const original = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(file, original, { mode: 0o600 });
  const markers = { SF_PLANNER_TICKET: 'APP-12', SF_PLANNER_ID: 'id-1', CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_01Ab' };
  const waiting = async (extra: Record<string, string>, workspace = 'app'): Promise<void> => {
    env.extra = extra;
    const result = await runCli(env, ['planner', 'waiting', workspace]);
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', ''], JSON.stringify(extra));
  };

  // Another start's id, a session id outside the pattern, a ticket without a record, a workspace
  // without one: nothing changes and nothing is created.
  await waiting({ ...markers, SF_PLANNER_ID: 'id-2' });
  await waiting({ ...markers, CLAUDE_CODE_BRIDGE_SESSION_ID: 'bad/id' });
  await waiting({ ...markers, SF_PLANNER_TICKET: 'APP-13' });
  await waiting(markers, 'beta');
  await waiting({});
  assert.equal(await readFile(file, 'utf8'), original);
  assert.deepEqual(await readdir(join(env.state, 'planner', 'app')), ['APP-12.json']);
  assert.equal(existsSync(join(env.state, 'planner', 'beta')), false);

  // The session's own record gets its link.
  await waiting(markers);
  assert.deepEqual(await recordOf(file), { ...record, link: 'https://claude.ai/code/session_01Ab' });
  assert.deepEqual(await readdir(join(env.state, 'planner', 'app')), ['APP-12.json']);
  // Start on the running session prints it.
  env.extra = {};
  const running = await runCli(env, ['planner', 'start', 'app', 'APP-12']);
  assert.equal(running.code, 0, running.stderr);
  assert.match(running.stdout, new RegExp(`^Planner of app APP-12 is running since [\\d: -]+ \\(pid ${process.pid}\\): https://claude\\.ai/code/session_01Ab\\n$`));
});

test('copyTrusted reads the copy\'s own entry', async () => {
  const home = join(temp, 'trust-home');
  const parent = join(temp, 'trust-planning');
  const copy = join(parent, 'app');
  const link = join(temp, 'trust-link');
  const cc = join(temp, 'trust-cc');
  await mkdir(copy, { recursive: true });
  await mkdir(home);
  await mkdir(cc);
  await symlink(copy, link);
  const env = { HOME: home };
  const config = (dir: string, data: unknown): Promise<void> => writeFile(join(dir, '.claude.json'), typeof data === 'string' ? data : JSON.stringify(data));
  const trusted = (path: string, ...more: string[]): unknown => ({ projects: Object.fromEntries([path, ...more].map((key) => [key, { hasTrustDialogAccepted: true }])) });

  assert.equal(await copyTrusted(copy, env), false, 'missing file');
  await config(home, '{ not json');
  assert.equal(await copyTrusted(copy, env), false, 'broken file');
  await config(home, { projects: [copy] });
  assert.equal(await copyTrusted(copy, env), false, 'projects not an object');
  await config(home, trusted(parent));
  assert.equal(await copyTrusted(copy, env), false, "a parent's entry alone");
  await config(home, { projects: { [copy]: { hasTrustDialogAccepted: false } } });
  assert.equal(await copyTrusted(copy, env), false, 'not accepted');
  await config(home, trusted(copy));
  assert.equal(await copyTrusted(copy, env), true, 'its path');
  assert.equal(await copyTrusted(link, env), true, 'its real path');
  await config(home, trusted(link));
  assert.equal(await copyTrusted(link, env), true, 'the link\'s own entry');

  // CLAUDE_CONFIG_DIR: its .claude.json, not the home's.
  await config(home, trusted(copy));
  await config(cc, trusted(parent));
  assert.equal(await copyTrusted(copy, { HOME: home, CLAUDE_CONFIG_DIR: cc }), false);
  await config(cc, trusted(copy));
  assert.equal(await copyTrusted(copy, { HOME: home, CLAUDE_CONFIG_DIR: cc }), true);
});

// Claude Code 2.1.325's trust dialog after its first line and the folder, as captured: \r\n line
// ends, the selection mark coloured on "No, exit".
const DIALOG = [
  '',
  'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what\'s in this folder first.',
  '',
  "Claude Code'll be able to read, edit, and execute files here.",
  '',
  'Security guide',
  '',
  '\x1b[36m❯\x1b[39m No, exit',
  '  Yes, I trust this folder',
  '',
  'Enter to confirm · Esc to cancel',
  '',
].join('\r\n');
// What Claude Code 2.1.325 writes after Down: cursor moves and the mark, no option line.
const MOVED = '\x1b[3A\x1b[1G \x1b[1B\x1b[1G\x1b[36m❯\x1b[39m\x1b[2B\x1b[1G';

// The fake Claude Code of a trust run (no argument; with arguments it is the planner and sleeps):
// faithful, the captured dialog, its selection on "No, exit"; Down moves it to "Yes, I trust this
// folder" and writes the mark again; Enter on Yes saves the answer in the global config and stays,
// on No exits with nothing saved. welcome shows no dialog, exits ends at once, unsaved saves
// nothing, unmoved writes nothing after Down. Each key read is logged as key=<hex>.
type TrustFake = 'faithful' | 'welcome' | 'exits' | 'unsaved' | 'unmoved';
async function trustClaude(bin: string, fake: TrustFake = 'faithful'): Promise<void> {
  const log = join(bin, 'claude.log');
  await writeFile(join(bin, 'dialog'), DIALOG);
  await writeFile(join(bin, 'moved'), MOVED);
  const hex = "dd bs=1 count=$1 2>/dev/null | od -An -tx1 | tr -d ' \\n'";
  const save = `printf '%s' "{\\"projects\\":{\\"$(pwd -P)\\":{\\"hasTrustDialogAccepted\\":true}}}" > "\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"; `;
  await writeClaude(bin, [
    `echo "$$" >> '${join(bin, 'claude.pids')}'`,
    `if [ $# -gt 0 ]; then ${SLEEPING_CLAUDE}; fi`,
    ...(fake === 'exits' ? ['exit 1'] : []),
    fake === 'welcome'
      ? "printf 'Welcome\\r\\n'"
      : `printf '\\033[?25lAccessing workspace:\\r\\n%s\\r\\n' "$(pwd -P)"; cat '${join(bin, 'dialog')}'`,
    `keys() { ${hex}; }`,
    'selected=no',
    'while :; do',
    '  key=$(keys 1)',
    '  if [ -z "$key" ]; then exit 0; fi',
    '  if [ "$key" = 1b ]; then key="$key$(keys 2)"; fi',
    `  echo "key=$key" >> '${log}'`,
    '  case $key in',
    `    1b5b42) selected=yes; ${fake === 'unmoved' ? ':' : `cat '${join(bin, 'moved')}'`} ;;`,
    `    0d) if [ $selected = no ]; then exit 0; fi; ${fake === 'unsaved' ? '' : save}${SLEEPING_CLAUDE} ;;`,
    '  esac',
    'done',
  ].join('\n'));
}

// sessionEnv's workspace with SF_PLANNER_TRUST=auto, its copy untrusted ({} in the global config)
// and the trust fake as claude.
async function autoEnv(name: string, fake: TrustFake = 'faithful'): Promise<{ env: Env; copy: string; bin: string; file: string; config: string }> {
  const session = await sessionEnv(name);
  const config = join(session.env.home, 'cc', '.claude.json');
  await writeFile(config, '{}');
  await trustClaude(session.bin, fake);
  session.env.extra = { ...session.env.extra, SF_PLANNER_TRUST: 'auto' };
  return { ...session, config };
}

const keysOf = async (bin: string): Promise<string[]> =>
  (await readFile(join(bin, 'claude.log'), 'utf8').catch(() => '')).split('\n').filter((line) => line.startsWith('key='));

test('with SF_PLANNER_TRUST=auto, sf planner start accepts the trust dialog of an untrusted copy first', async () => {
  const { env, copy, bin, file, config } = await autoEnv('planner-auto');
  try {
    // AT-6: a value that is neither ask nor auto stops start before anything runs.
    env.extra = { ...env.extra, SF_PLANNER_TRUST: 'yes' };
    const wrong = await runCli(env, ['planner', 'start', 'app', 'APP-12']);
    assert.deepEqual([wrong.code, wrong.stdout, wrong.stderr], [1, '', 'sf: SF_PLANNER_TRUST must be ask or auto, got "yes".\n']);
    assert.equal(await runs(bin), 0);
    env.extra = { ...env.extra, SF_PLANNER_TRUST: 'auto' };

    // AT-1: the trust run, then the planner and start's two lines.
    const started = await runCli(env, ['planner', 'start', 'app', 'APP-12']);
    assert.equal(started.code, 0, started.stderr);
    const pid = (await recordOf(file)).pid as number;
    assert.equal(started.stdout, [
      `Planner of app APP-12 started: Claude Code session "Planner app APP-12" in the planning copy of app (pid ${pid}).`,
      'Open it in the Claude app or on claude.ai/code under that name; once the planner first waits for you, sf planner start app APP-12 prints its link.',
      '',
    ].join('\n'));
    const scriptLog = (await readFile(join(bin, 'script.log'), 'utf8')).split('\n');
    assert.deepEqual(scriptLog.filter((line) => line.startsWith('cwd=') || line.startsWith('arg=')), [
      `cwd=${copy}`, 'arg=-qfec', 'arg=exec claude', 'arg=/dev/null',
      `cwd=${copy}`, 'arg=-qfec', `arg=${COMMAND_LINE}`, 'arg=/dev/null',
    ]);
    const lines = (await readFile(join(bin, 'claude.log'), 'utf8')).split('\n');
    // Exactly one Down, then one Enter.
    assert.deepEqual(lines.filter((line) => line.startsWith('key=')), ['key=1b5b42', 'key=0d']);
    assert.equal(lines.filter((line) => line === 'SF_PLANNER_TICKET=APP-12').length, 1);
    assert.equal(lines.filter((line) => line === 'TERM=xterm-256color').length, 2);
    // The trust run: no argument (its lines come before the planner's first), none of the markers
    // or tokens.
    const trustRun = lines.slice(0, lines.findIndex((line) => line.startsWith('arg=')));
    assert.ok(trustRun.includes('TERM=xterm-256color'));
    const names = trustRun.filter((line) => line.includes('=')).map((line) => line.slice(0, line.indexOf('=')));
    for (const name of ['SF_PLANNER_TICKET', 'SF_PLANNER_ID', 'SF_GITHUB_TOKEN', 'ANTHROPIC_API_KEY']) {
      assert.equal(names.includes(name), false, name);
    }
    // The trust run's Claude Code was ended; the global config is what it wrote.
    await gone((await claudePids(bin))[0]!);
    assert.equal(await readFile(config, 'utf8'), JSON.stringify({ projects: { [copy]: { hasTrustDialogAccepted: true } } }));

    const stopped = await runCli(env, ['planner', 'stop', 'app', 'APP-12']);
    assert.deepEqual([stopped.code, stopped.stdout], [0, `Stopped the planner of app APP-12 (pid ${pid}).\n`]);
  } finally {
    await killLeft(file);
    await killClaudes(bin);
  }
});

test('acceptTrustDialog says why it could not accept the dialog, and ends Claude Code', async () => {
  const { env, copy, bin, file } = await autoEnv('planner-auto-fails', 'welcome');
  const procEnv = processEnv(env);
  const log = join(bin, 'claude.log');
  const lastGone = async (): Promise<void> => gone((await claudePids(bin)).at(-1)!);
  try {
    // AT-2: no dialog within the limit: nothing sent.
    assert.equal(await acceptTrustDialog('app', procEnv, 1_000), 'the dialog did not show within 1 s');
    assert.deepEqual(await keysOf(bin), []);
    await lastGone();
    assert.equal(await copyTrusted(copy, procEnv), false);

    // AT-3: a dialog answered but not saved.
    await rm(log);
    await trustClaude(bin, 'unsaved');
    assert.equal(await acceptTrustDialog('app', procEnv, 2_000), 'Claude Code did not save the answer');
    assert.deepEqual(await keysOf(bin), ['key=1b5b42', 'key=0d']);
    await lastGone();
    assert.equal(await copyTrusted(copy, procEnv), false);

    // AT-3b: no mark after Down: no Enter.
    await rm(log);
    await trustClaude(bin, 'unmoved');
    assert.equal(await acceptTrustDialog('app', procEnv, 4_000), 'the selection did not move to "Yes, I trust this folder"');
    assert.deepEqual(await keysOf(bin), ['key=1b5b42']);
    await lastGone();
    assert.equal(await copyTrusted(copy, procEnv), false);

    // AT-3: Claude Code ends before the dialog; start refuses with the reason and runs no planner.
    await trustClaude(bin, 'exits');
    const before = await runs(bin);
    const deps = { env: procEnv, stateDir: env.state, configDir: env.config };
    await assert.rejects(startPlanner('app', 'APP-12', deps), (error: unknown) => {
      assert.ok(error instanceof FactoryError, String(error));
      assert.deepEqual([error.code, error.message], ['planning_copy_untrusted',
        'Claude Code does not trust the planning copy of app yet, and the factory could not accept its trust dialog: Claude Code ended before the dialog showed. Run sf planner trust app, accept its trust dialog, then start the planner again.']);
      return true;
    });
    assert.equal(existsSync(file), false);
    assert.equal(await runs(bin), before + 1);
    await lastGone();

    // AT-4: no Claude Code for a copy not set up, one holding .mcp.json, or without script.
    const opened = await runs(bin);
    const pointers = join(copy, '.claude', 'planning-copy.md');
    await rm(pointers);
    assert.equal(await acceptTrustDialog('app', procEnv), 'the copy is not set up');
    await writeFile(pointers, 'pointers\n');
    await writeFile(join(copy, '.mcp.json'), '{}\n');
    assert.equal(await acceptTrustDialog('app', procEnv), '.mcp.json is in the copy, and Claude Code would load it');
    await rm(join(copy, '.mcp.json'));
    const empty = join(temp, 'planner-auto-empty-path');
    await mkdir(empty);
    assert.equal(await acceptTrustDialog('app', { ...procEnv, PATH: empty }), 'script could not run (ENOENT)');
    assert.equal(await runs(bin), opened);
  } finally {
    await killLeft(file);
    await killClaudes(bin);
  }
});

test('trustDialogShown finds "Yes, I trust this folder" through escape sequences, and nothing else', () => {
  const captured = `Accessing workspace:\r\n/tmp/trustprobe.Ty63\r\n${DIALOG}`;
  for (const output of [
    'Yes, I trust this folder',
    captured,
    'Yes, \x1b[1mI trust\x1b[22m this folder',
    'Yes, I trust\r\n  this folder',
    'Yes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder',
    'Yes, I tr\x1b[1must\x1b[22m this fol\x1b[36mder',
    '\x1b]0;claude\x07YES, I TRUST THIS FOLDER',
  ]) {
    assert.equal(trustDialogShown(output), true, JSON.stringify(output));
  }
  for (const output of ['Do you trust the files in this folder?', '❯ No, exit', 'I trust this folder', '']) {
    assert.equal(trustDialogShown(output), false, JSON.stringify(output));
  }
});

test("the trust fake is faithful: a lone Enter on the dialog's default leaves the copy untrusted", async () => {
  const { env, copy, bin, config } = await autoEnv('planner-auto-fake');
  try {
    const ran = spawnSync('sh', [join(bin, 'claude')], { cwd: copy, input: '\r', env: { ...processEnv(env), CLAUDE_CONFIG_DIR: join(env.home, 'cc') } });
    assert.equal(ran.status, 0, ran.stderr.toString());
    assert.deepEqual(await keysOf(bin), ['key=0d']);
    assert.equal(await readFile(config, 'utf8'), '{}');
    assert.equal(await copyTrusted(copy, processEnv(env)), false);
  } finally {
    await killClaudes(bin);
  }
});
