// sf planner start and stop: the ticket's planner session (fake script and claude first on PATH),
// one per ticket, its record and its environment; a session that ended is no session; every refusal
// of start with its code; the hook's link written into its own session's record only; copyTrusted.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { copyTrusted, sessionFile, startPlanner } from '../src/planner-session.js';
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
// sh -c in the background and, like the real one, ignores SIGTERM; its child does not.
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
    'sh -c "$2" &',
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

    // A copy trusted only through its parent folder.
    await trust(env, join(env.home, 'planning'));
    const untrusted = 'Claude Code does not trust the planning copy of app yet: open Claude Code there once and accept its trust dialog (the Next line of sf planner setup app says how), then start the planner again.';
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
    assert.match(usage.stderr, /^sf: planner needs setup <workspace>, waiting <workspace> \[permission\], start <workspace> <ticket> or stop <workspace> <ticket>\./);
  } finally {
    await killLeft(file);
    // The fake script is no terminal: a SIGKILL to it leaves its child, which the real script's
    // hang-up ends; the test ends it itself.
    const pids = await readFile(join(bin, 'claude.pids'), 'utf8').catch(() => '');
    for (const pid of pids.split('\n').filter((text) => text !== '').map(Number)) {
      forceKill(pid);
    }
  }
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
