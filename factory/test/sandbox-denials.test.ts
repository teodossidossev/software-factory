// The path denials of every session the factory starts (SF-100): what is denied for reading and
// writing, what for writing only, what stays (the own worktree and checkout), missing paths left
// out, the sandbox's filesystem lists, the Implementer session building them once, the Task checks'
// parent directory, and no SSH agent in the sessions' and the gate's environment. SF-125: the Codex
// gate's bubblewrap wrapper of the same denyRead list.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { sandboxAllowRead, sandboxSettings } from '../src/config.js';
import { gateEnvironment } from '../src/gate.js';
import { saveRegistry } from '../src/registry.js';
import { DENIED_TOOLS } from '../src/rules.js';
import {
  absoluteRule, claudeProjectName, claudeUserSettings, cliRuleList, type DenialScope, FACTORY_MCP_SERVER, FILE_GUARD, gateWrapper, gateWrapperFor, HOME_CREDENTIALS, installDir,
  PATH_DENIAL_UNREPRESENTABLE, type PathDenials, pathDenials, prepareTaskChecksDir, taskChecksDir, USER_SETTINGS_WEAKEN_SANDBOX, userSettingsWeakening, withSandboxDenials,
} from '../src/sandbox-denials.js';
import { type IdleOutcome, ImplementerSession, sessionEnvironment, withSandboxEnvDenials } from '../src/session.js';
import { call, FAKE, fakeLog, newEnv, newRepo, putTask, reviewScript, script, serve, stop, temp, waitFor } from './support/harness.js';

// A factory laid out under root: its config (registry, env file), its state with the worktrees of
// two workspaces, the tunnel client's profile, a home with every credential but ~/.netrc, the
// checkouts of the two workspaces, an installation clone and the Task checks' parent.
interface Layout {
  root: string;
  home: string;
  config: string;
  state: string;
  worktrees: string;
  own: string;
  sibling: string;
  otherWorkspace: string;
  checkout: string;
  otherCheckout: string;
  install: string;
  tmp: string;
  envFile: string;
  tunnel: string;
  env: NodeJS.ProcessEnv;
}

async function layout(name: string): Promise<Layout> {
  await rm(join(temp, name), { recursive: true, force: true });
  await mkdir(join(temp, name), { recursive: true });
  const root = await realpath(join(temp, name));
  const at = (...parts: string[]): string => join(root, ...parts);
  const l: Layout = {
    root, home: at('home'), config: at('config'), state: at('state'), worktrees: at('state', 'worktrees'),
    own: at('state', 'worktrees', 'app', 'A-1'), sibling: at('state', 'worktrees', 'app', 'A-2'), otherWorkspace: at('state', 'worktrees', 'web'),
    checkout: at('checkouts', 'app'), otherCheckout: at('checkouts', 'web'), install: at('install'), tmp: at('tmp'), envFile: at('secrets', 'factory.env'),
    tunnel: at('tunnel'), env: {},
  };
  for (const dir of [l.own, l.sibling, join(l.otherWorkspace, 'W-1'), join(l.state, 'jobs', 'app', 'A-1'), join(l.state, 'checks'), l.checkout, l.otherCheckout, join(l.install, 'dist', 'src'), l.tmp, l.tunnel, join(l.home, '.claude')]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(l.state, 'dashboard-token'), 'token\n');
  await writeFile(join(l.state, 'queue.json'), '{}\n');
  await mkdir(join(l.root, 'secrets'));
  await writeFile(l.envFile, 'SF_GITHUB_TOKEN=x\n');
  for (const dir of ['.ssh', '.codex', '.aws', '.config/gh', '.config/git']) {
    await mkdir(join(l.home, dir), { recursive: true });
  }
  for (const file of ['.git-credentials', '.config/git/credentials', '.npmrc', '.claude/.credentials.json']) {
    await writeFile(join(l.home, file), 'secret');
  }
  await writeFile(join(l.install, 'package.json'), '{"name":"software-factory"}\n');
  await saveRegistry({ workspaces: { app: { read_checkout: l.checkout }, web: { read_checkout: l.otherCheckout }, gone: { read_checkout: at('checkouts', 'gone') } } }, l.config);
  l.env = { HOME: l.home, SF_CONFIG_DIR: l.config, SF_ENV_FILE: l.envFile, TUNNEL_CLIENT_PROFILE_DIR: l.tunnel };
  return l;
}

const scope = (l: Layout, session: DenialScope['session']): DenialScope => ({
  session, workspace: 'app', checkout: l.checkout, ...(session === 'job' ? { worktree: l.own } : {}), stateDir: l.state, worktreeRoot: l.worktrees,
  env: l.env, moduleDir: join(l.install, 'dist', 'src'), tmp: l.tmp, systemRoot: join(l.root, 'sys'),
});

// The paths of a layout denied for reading and writing in every session; the Task checks' parent
// (every session but a Task check) once it exists.
const readWrite = (l: Layout): string[] => [
  l.config, l.envFile, join(l.state, 'checks'), join(l.state, 'dashboard-token'), join(l.state, 'jobs'), join(l.state, 'queue.json'),
  l.otherWorkspace, l.sibling, l.tunnel, l.otherCheckout,
  ...HOME_CREDENTIALS.filter((path) => path !== '.netrc').map((path) => join(l.home, path)),
];

const directory = (path: string): Promise<boolean> => stat(path).then((info) => info.isDirectory());

// own: the session's own worktree, which stays (undefined for a Task check).
async function assertDenied(l: Layout, denials: Awaited<ReturnType<typeof pathDenials>>, paths: string[], own: string | undefined): Promise<void> {
  for (const path of paths) {
    const kinds = (await directory(path)) ? ['', '/**'] : [''];
    for (const tool of ['Read', 'Edit', 'Write']) {
      for (const kind of kinds) {
        assert.ok(denials.tools.includes(`${tool}(${absoluteRule(path)}${kind})`), `${tool} ${path}${kind} not denied`);
      }
    }
    assert.ok(denials.sandbox.denyRead.includes(path), `${path} readable by Bash`);
    assert.ok(denials.sandbox.denyWrite.includes(path), `${path} writable by Bash`);
  }
  for (const path of [...denials.sandbox.denyRead, ...denials.sandbox.denyWrite]) {
    assert.ok(path.startsWith('/') && !path.includes('/../'), path);
  }
  // Path rules only, and the factory's own MCP server's tools (SF-099).
  assert.ok(denials.tools.includes(`mcp__${FACTORY_MCP_SERVER}`));
  assert.ok(denials.tools.every((rule) => rule === `mcp__${FACTORY_MCP_SERVER}` || /^(Read|Edit|Write)\(\/\/[^*]+(\/\*\*)?\)$/.test(rule)), denials.tools.join(', '));
  // What stays: the own worktree, the own checkout (its .git too), the state directory and the
  // worktree root themselves (listable), the own workspace's folder.
  for (const path of [...(own !== undefined ? [own] : []), l.checkout, join(l.checkout, '.git'), l.state, l.worktrees, join(l.worktrees, 'app'), l.home]) {
    assert.ok(!denials.sandbox.denyRead.includes(path) && !denials.sandbox.denyWrite.includes(path), `${path} is denied`);
    assert.ok(!denials.tools.some((rule) => rule === `Read(${absoluteRule(path)})` || rule === `Read(${absoluteRule(path)}/**)`), `${path} is denied for the tools`);
  }
}

test('an Implementer (and its reviewer) session: every denied path, absolute, for the tools and the sandbox; the own worktree and checkout stay; other jobs, workspaces and the Task checks are denied; missing paths left out', async () => {
  const l = await layout('denials-job');
  await prepareTaskChecksDir(taskChecksDir(l.tmp));
  const denials = await pathDenials(scope(l, 'job'));
  await assertDenied(l, denials, [...readWrite(l), taskChecksDir(l.tmp)], l.own);
  // Missing: ~/.netrc, the literal ~/.config/software-factory, the gone workspace's checkout: nowhere,
  // so the sandbox never leaves a placeholder for them.
  for (const missing of [join(l.home, '.netrc'), join(l.home, '.config', 'software-factory'), join(l.root, 'checkouts', 'gone')]) {
    assert.ok(!denials.sandbox.denyRead.includes(missing) && !denials.sandbox.denyWrite.includes(missing), missing);
    assert.ok(!denials.tools.some((rule) => rule.includes(absoluteRule(missing))), missing);
  }
  // The installation: write-only.
  assert.ok(denials.sandbox.denyWrite.includes(l.install) && !denials.sandbox.denyRead.includes(l.install));
  assert.ok(denials.tools.includes(`Edit(${absoluteRule(l.install)}/**)`) && denials.tools.includes(`Write(${absoluteRule(l.install)}/**)`));
  assert.ok(!denials.tools.some((rule) => rule.startsWith(`Read(${absoluteRule(l.install)}`)));
  // The worktrees entry of the state itself is not denied, only the other jobs' worktrees in it.
  assert.ok(!denials.sandbox.denyRead.includes(l.worktrees));
});

test('a Task check session: the same denials, every ticket\'s worktree of its workspace included, but not the Task checks\' parent it runs in', async () => {
  const l = await layout('denials-check');
  await prepareTaskChecksDir(taskChecksDir(l.tmp));
  const denials = await pathDenials(scope(l, 'task_check'));
  // No own worktree: every ticket's worktree of the workspace is denied.
  await assertDenied(l, denials, [...readWrite(l), l.own], undefined);
  assert.ok(!denials.sandbox.denyRead.includes(taskChecksDir(l.tmp)) && !denials.tools.some((rule) => rule.includes('sf-task-checks-')));
});

test('real paths: a credential reached through a link is denied by both spellings; a dangling link is left out', async () => {
  const l = await layout('denials-links');
  await rm(join(l.home, '.aws'), { recursive: true });
  await mkdir(join(l.root, 'aws-data'));
  await symlink(join(l.root, 'aws-data'), join(l.home, '.aws'));
  await rm(join(l.home, '.npmrc'));
  await symlink(join(l.root, 'nowhere'), join(l.home, '.npmrc'));
  const denials = await pathDenials(scope(l, 'job'));
  for (const path of [join(l.home, '.aws'), join(l.root, 'aws-data')]) {
    assert.ok(denials.sandbox.denyRead.includes(path), path);
    assert.ok(denials.tools.includes(`Read(${absoluteRule(path)}/**)`), path);
  }
  assert.ok(!denials.sandbox.denyRead.includes(join(l.home, '.npmrc')));
});

test('the factory developing itself: an installation that is, or holds, the own checkout is not denied for writing; other workspaces nested around the own checkout stay', async () => {
  const l = await layout('denials-self');
  const nested = join(l.install, 'repo');
  await mkdir(nested);
  await saveRegistry({ workspaces: { app: { read_checkout: nested }, outer: { read_checkout: l.install } } }, l.config);
  const denials = await pathDenials({ ...scope(l, 'job'), checkout: nested });
  assert.ok(!denials.sandbox.denyWrite.includes(l.install) && !denials.sandbox.denyRead.includes(l.install));
  assert.ok(!denials.tools.some((rule) => rule.includes(absoluteRule(l.install))), denials.tools.join(', '));
});

test('installDir: the Git top-level of the module directory, else the nearest software-factory package', async () => {
  const l = await layout('denials-install');
  assert.equal(await installDir(join(l.install, 'dist', 'src')), l.install);
  const clone = join(l.root, 'clone');
  await mkdir(join(clone, 'factory', 'dist', 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', clone]);
  assert.equal(await installDir(join(clone, 'factory', 'dist', 'src')), clone);
});

test('withSandboxDenials: merged into the sandbox\'s filesystem lists; no sandbox stays none; a path gone since is left out', async () => {
  const l = await layout('denials-merge');
  const denials = { denyRead: [l.sibling, join(l.root, 'gone')], denyWrite: [l.sibling, l.install] };
  const base = sandboxSettings({})!;
  const merged = withSandboxDenials(base, denials)!;
  assert.deepEqual(merged.network, base.network);
  assert.deepEqual(merged.filesystem, { disabled: false, denyRead: [l.sibling], denyWrite: [l.sibling, l.install] });
  assert.equal(withSandboxDenials(undefined, denials), undefined);
  assert.equal(withSandboxDenials(base, undefined), base);
  assert.deepEqual(withSandboxDenials({ ...base, filesystem: { denyRead: ['/x'] } }, denials)!.filesystem!.denyRead, ['/x', l.sibling]);
  await rm(l.sibling, { recursive: true });
  assert.deepEqual(withSandboxDenials(base, denials)!.filesystem, { disabled: false, denyRead: [], denyWrite: [l.install] });
});

test('the Task checks\' parent: made 0700, a wider mode narrowed, a link or a file refused with task_check_dir_unsafe', async () => {
  const l = await layout('denials-checks-dir');
  const dir = taskChecksDir(l.tmp);
  assert.equal(dir, join(l.tmp, `sf-task-checks-${process.getuid!()}`));
  assert.equal(await prepareTaskChecksDir(dir), dir);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await chmod(dir, 0o755);
  await prepareTaskChecksDir(dir);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await rm(dir, { recursive: true });
  await mkdir(join(l.root, 'elsewhere'));
  await symlink(join(l.root, 'elsewhere'), dir);
  await assert.rejects(prepareTaskChecksDir(dir), (error: { code?: string }) => error.code === 'task_check_dir_unsafe');
  await rm(dir);
  await writeFile(dir, '');
  await assert.rejects(prepareTaskChecksDir(dir), (error: { code?: string }) => error.code === 'task_check_dir_unsafe');
});

test('no SSH agent: SSH_AUTH_SOCK reaches neither a Claude session nor the Codex gate', () => {
  const env = { PATH: '/bin', HOME: '/h', SSH_AUTH_SOCK: '/run/agent.sock', ANTHROPIC_API_KEY: 'k', SF_STATE_DIR: '/s' };
  assert.deepEqual(sessionEnvironment(env), { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k' });
  // SF-125: the gate gets no other tool's key either.
  assert.deepEqual(gateEnvironment(env), { PATH: '/bin', HOME: '/h' });
});

test('the Implementer session: every query gets the prompt\'s deny list plus the path denials and the sandbox with their filesystem lists, built once per session object; a failing build fails the turn', async () => {
  const l = await layout('denials-session');
  const env = { home: l.home, state: l.state, config: l.config };
  await script(env, [{}, {}]);
  let built = 0;
  const denials = await pathDenials(scope(l, 'job'));
  const sandbox = sandboxSettings({})!;
  const home = process.env.HOME;
  process.env.HOME = l.home;
  try {
    const outcomes: IdleOutcome[] = [];
    let idle: () => void = () => undefined;
    const session = new ImplementerSession({
      cwd: l.own, maxTurns: 3, claudePath: FAKE, sandbox, pathDenials: async () => {
        built += 1;
        return denials;
      },
    }, { message: async () => undefined, prompt: async () => undefined, idle: async (outcome) => {
      outcomes.push(outcome);
      idle();
    } });
    for (const prompt of ['first', 'second']) {
      const done = new Promise<void>((resolve) => (idle = resolve));
      session.send(prompt, DENIED_TOOLS);
      await done;
    }
    assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, true]);
    assert.equal(built, 1);
    const log = await fakeLog(env);
    assert.equal(log.length, 2);
    for (const entry of log) {
      const deny = entry.argv.find((arg) => arg.startsWith('--disallowedTools='))!.slice('--disallowedTools='.length).split(',');
      assert.deepEqual(deny, [...DENIED_TOOLS, ...denials.tools]);
      const settings = JSON.parse(entry.argv[entry.argv.indexOf('--settings') + 1]!) as { sandbox: typeof sandbox };
      // SF-123: with the session environment's credentials, if any, hidden from sandboxed commands.
      // The host's temporary roots denied (here only the layout's tmp, which holds no kept path).
      assert.deepEqual(denials.claudeTmp, { denyRead: [l.tmp], allowRead: [], allowWrite: [] });
      const filesystem = { disabled: false, denyRead: [...denials.sandbox.denyRead, l.tmp], denyWrite: denials.sandbox.denyWrite, allowRead: [], allowWrite: [] };
      assert.deepEqual(settings.sandbox, withSandboxEnvDenials({ ...sandbox, filesystem }, sessionEnvironment()));
    }

    // A session whose denials cannot be built runs no turn.
    const failed = new Promise<IdleOutcome>((resolve) => {
      const broken = new ImplementerSession({ cwd: l.own, maxTurns: 3, claudePath: FAKE, sandbox, pathDenials: () => Promise.reject(new Error('registry unreadable')) }, {
        message: async () => undefined, prompt: async () => undefined, idle: async (outcome) => resolve(outcome),
      });
      broken.send('third', DENIED_TOOLS);
    });
    const outcome = await failed;
    assert.deepEqual(outcome.ok ? undefined : [outcome.code, outcome.message], ['session_failed', 'registry unreadable']);
    assert.equal((await fakeLog(env)).length, 2);
  } finally {
    process.env.HOME = home;
  }
  // Unused directories stay as they were.
  assert.deepEqual(await readdir(l.tmp), []);
});

test('cliRuleList reads --disallowedTools as the installed CLI does: commas and spaces split only outside parentheses, up to the next ")"', () => {
  assert.deepEqual(cliRuleList(['Bash(git commit:*),Read(**/.env) Edit']), ['Bash(git commit:*)', 'Read(**/.env)', 'Edit']);
  assert.deepEqual(cliRuleList(['Read(//a,b c/**),Write(//x)']), ['Read(//a,b c/**)', 'Write(//x)']);
  // An escaped ")" closes the parentheses all the same: what follows splits.
  assert.deepEqual(cliRuleList(['Read(//a \\(b\\) c)']), ['Read(//a \\(b\\)', 'c)']);
  assert.deepEqual(cliRuleList(['', ' , ']), []);
});

test('a comma in a denied path (the config directory, the env file): the complete rules reach the CLI through the Implementer\'s --disallowedTools; a path the CLI would cut refuses the session', async () => {
  const l = await layout('denials-comma');
  const config = join(l.root, 'sf,config');
  const envFile = join(l.root, 'env,dir', 'factory.env');
  await mkdir(join(l.root, 'env,dir'));
  await writeFile(envFile, 'SF_GITHUB_TOKEN=x\n');
  await saveRegistry({ workspaces: { app: { read_checkout: l.checkout } } }, config);
  const commaScope = { ...scope(l, 'job'), env: { ...l.env, SF_CONFIG_DIR: config, SF_ENV_FILE: envFile } };
  const denials = await pathDenials(commaScope);
  for (const rule of [`Read(/${config})`, `Read(/${config}/**)`, `Edit(/${config}/**)`, `Write(/${config}/**)`, `Read(/${envFile})`, `Edit(/${envFile})`, `Write(/${envFile})`]) {
    assert.ok(denials.tools.includes(rule), rule);
  }
  assert.deepEqual(cliRuleList([denials.tools.join(',')]), denials.tools);

  // Through the session to the (fake) CLI: the logged argument, read as the CLI reads it.
  const env = { home: l.home, state: l.state, config };
  await script(env, [{}]);
  const home = process.env.HOME;
  process.env.HOME = l.home;
  try {
    const outcome = await new Promise<IdleOutcome>((resolve) => {
      const session = new ImplementerSession({ cwd: l.own, maxTurns: 3, claudePath: FAKE, sandbox: sandboxSettings({}), pathDenials: () => pathDenials(commaScope) }, {
        message: async () => undefined, prompt: async () => undefined, idle: async (ended) => resolve(ended),
      });
      session.send('go', DENIED_TOOLS);
    });
    assert.equal(outcome.ok, true);
  } finally {
    process.env.HOME = home;
  }
  const [entry] = await fakeLog(env);
  const sent = cliRuleList([entry!.argv.find((arg) => arg.startsWith('--disallowedTools='))!.slice('--disallowedTools='.length)]);
  assert.deepEqual(sent, [...DENIED_TOOLS, ...denials.tools]);

  // A path with a space after a ")" cannot be one rule for the CLI: no session starts without its denial.
  const cut = join(l.root, 'a (b) c');
  await mkdir(cut);
  await writeFile(join(cut, 'factory.env'), 'SF_GITHUB_TOKEN=x\n');
  await assert.rejects(pathDenials({ ...commaScope, env: { ...commaScope.env, SF_ENV_FILE: join(cut, 'factory.env') } }), (error: { code?: string }) => error.code === PATH_DENIAL_UNREPRESENTABLE);
  // Spaces and parentheses without that are fine.
  const fine = join(l.root, 'my dir (2)');
  await mkdir(fine);
  await writeFile(join(fine, 'factory.env'), 'x\n');
  const spaced = await pathDenials({ ...commaScope, env: { ...commaScope.env, SF_ENV_FILE: join(fine, 'factory.env') } });
  assert.ok(spaced.tools.includes(`Read(/${join(l.root, 'my dir \\(2\\)', 'factory.env')})`), spaced.tools.join(', '));
  assert.deepEqual(cliRuleList([spaced.tools.join(',')]), spaced.tools);
});

test('clean user settings: the factory\'s --settings pins filesystem isolation on with the denials, and the session may not write the user settings nor the global config (missing too)', async () => {
  const l = await layout('denials-user-settings');
  const userSettings = join(l.home, '.claude', 'settings.json');
  await writeFile(userSettings, `${JSON.stringify({ model: 'x', sandbox: { enabled: true, filesystem: { allowRead: [join(l.root, 'elsewhere')] } } })}\n`);
  const global = join(l.home, '.claude.json');
  const denials = await pathDenials(scope(l, 'job'));
  for (const rule of [`Edit(/${userSettings})`, `Write(/${userSettings})`, `Edit(/${global})`, `Write(/${global})`]) {
    assert.ok(denials.tools.includes(rule), rule);
  }
  // Readable as before; the existing file denied for Bash's writes, the missing one left out of the
  // sandbox (no placeholder).
  assert.ok(!denials.tools.includes(`Read(/${userSettings})`));
  assert.ok(denials.sandbox.denyWrite.includes(userSettings) && !denials.sandbox.denyRead.includes(userSettings));
  assert.ok(!denials.sandbox.denyWrite.includes(global));

  // What reaches the (fake) CLI: the flag settings, which outrank the user's, keep filesystem
  // isolation on and carry the read denials.
  const env = { home: l.home, state: l.state, config: l.config };
  await script(env, [{}]);
  const home = process.env.HOME;
  process.env.HOME = l.home;
  try {
    const outcome = await new Promise<IdleOutcome>((resolve) => {
      const session = new ImplementerSession({ cwd: l.own, maxTurns: 3, claudePath: FAKE, sandbox: sandboxSettings({}), pathDenials: () => pathDenials(scope(l, 'job')) }, {
        message: async () => undefined, prompt: async () => undefined, idle: async (ended) => resolve(ended),
      });
      session.send('go', DENIED_TOOLS);
    });
    assert.equal(outcome.ok, true);
  } finally {
    process.env.HOME = home;
  }
  const [entry] = await fakeLog(env);
  assert.ok(entry!.argv.includes('--setting-sources=user,project') || entry!.argv.join(' ').includes('user,project'), entry!.argv.join(' '));
  const settings = JSON.parse(entry!.argv[entry!.argv.indexOf('--settings') + 1]!) as { sandbox: { allowUnsandboxedCommands: boolean; filesystem: { disabled: boolean; denyRead: string[]; denyWrite: string[] } } };
  assert.equal(settings.sandbox.filesystem.disabled, false);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.ok(settings.sandbox.filesystem.denyRead.includes(join(l.home, '.ssh')) && settings.sandbox.filesystem.denyWrite.includes(userSettings));
  const sent = cliRuleList([entry!.argv.find((arg) => arg.startsWith('--disallowedTools='))!.slice('--disallowedTools='.length)]);
  assert.ok(sent.includes(`Write(/${userSettings})`) && sent.includes(`Edit(/${global})`), sent.join(', '));

  // CLAUDE_CONFIG_DIR moves both.
  assert.deepEqual(claudeUserSettings({ CLAUDE_CONFIG_DIR: '/c' }, '/h'), ['/c/settings.json', '/c/.claude.json']);
  assert.deepEqual(claudeUserSettings({}, '/h'), ['/h/.claude/settings.json', '/h/.claude.json']);
});

test('the global config (SF-099: it holds the MCP URL with its token after claude mcp add) is denied for reading too, by the tools and Bash, under CLAUDE_CONFIG_DIR as well', async () => {
  const l = await layout('denials-global-config');
  const global = join(l.home, '.claude.json');
  await writeFile(global, `${JSON.stringify({ mcpServers: { 'software-factory': { type: 'http', url: 'http://127.0.0.1:8787/mcp/x' } } })}\n`);
  const userSettings = join(l.home, '.claude', 'settings.json');
  await writeFile(userSettings, '{}\n');
  const denials = await pathDenials(scope(l, 'job'));
  for (const tool of ['Read', 'Edit', 'Write']) {
    assert.ok(denials.tools.includes(`${tool}(/${global})`), `${tool} ${global}`);
  }
  assert.ok(denials.sandbox.denyRead.includes(global) && denials.sandbox.denyWrite.includes(global));
  // The user settings stay readable (no secret there), denied for writing only.
  assert.ok(!denials.tools.includes(`Read(/${userSettings})`) && !denials.sandbox.denyRead.includes(userSettings));
  // A Task check too.
  const check = await pathDenials(scope(l, 'task_check'));
  assert.ok(check.tools.includes(`Read(/${global})`) && check.sandbox.denyRead.includes(global));
  // The factory's own MCP server, as the docs name it: no session may use its tools, whatever the
  // scope Claude Code loaded it from.
  for (const denials of [await pathDenials(scope(l, 'job')), check]) {
    assert.ok(denials.tools.includes(`mcp__${FACTORY_MCP_SERVER}`), denials.tools.join(', '));
  }
  assert.equal(FACTORY_MCP_SERVER, 'software-factory');
  // Claude Code's backups of the global config hold the same token once it exists.
  const backups = join(l.home, '.claude', 'backups');
  await mkdir(backups);
  await writeFile(join(backups, '.claude.json.backup.1'), '{}\n');
  const withBackups = await pathDenials(scope(l, 'job'));
  assert.ok(withBackups.tools.includes(`Read(/${backups})`) && withBackups.tools.includes(`Read(/${backups}/**)`));
  assert.ok(withBackups.sandbox.denyRead.includes(backups));

  // CLAUDE_CONFIG_DIR: its .claude.json, the home's left alone.
  const moved = join(l.root, 'claude-config');
  await mkdir(moved);
  await writeFile(join(moved, '.claude.json'), '{}\n');
  const elsewhere = await pathDenials({ ...scope(l, 'job'), env: { ...l.env, CLAUDE_CONFIG_DIR: moved } });
  assert.ok(elsewhere.tools.includes(`Read(/${join(moved, '.claude.json')})`) && elsewhere.sandbox.denyRead.includes(join(moved, '.claude.json')));
  await mkdir(join(moved, 'backups'));
  assert.ok((await pathDenials({ ...scope(l, 'job'), env: { ...l.env, CLAUDE_CONFIG_DIR: moved } })).sandbox.denyRead.includes(join(moved, 'backups')));
  assert.ok(!elsewhere.tools.includes(`Read(/${global})`));

  // A missing one: denied for the tools (Claude Code may create it during the session), not in the
  // sandbox (no placeholder).
  await rm(join(moved, '.claude.json'));
  const missing = await pathDenials({ ...scope(l, 'job'), env: { ...l.env, CLAUDE_CONFIG_DIR: moved } });
  assert.ok(missing.tools.includes(`Read(/${join(moved, '.claude.json')})`));
  assert.ok(!missing.sandbox.denyRead.includes(join(moved, '.claude.json')));
});

// The denials the guard compares with: what pathDenials builds for the layout.
const lists = (l: Layout): { denyRead: string[]; denyWrite: string[] } => ({
  denyRead: [join(l.home, '.ssh'), join(l.state, 'jobs')], denyWrite: [join(l.home, '.ssh'), join(l.state, 'jobs'), l.install],
});

test('the user settings guard: a missing or clean file passes; sandbox.enabled false, filesystem.disabled true, an allowRead or allowWrite entry covering a denied path, an unreadable or invalid file stop the session, naming the key and the path', async () => {
  const l = await layout('denials-guard');
  const file = join(l.home, '.claude', 'settings.json');
  const put = (settings: unknown): Promise<void> => writeFile(file, typeof settings === 'string' ? settings : JSON.stringify(settings));
  const verdict = (): Promise<string | undefined> => userSettingsWeakening(file, lists(l), l.home);

  // Missing: fine.
  assert.equal(await verdict(), undefined);
  // Clean: other keys, the sandbox on, allow entries elsewhere, other filesystem keys.
  for (const clean of [{}, { model: 'opus', permissions: { allow: ['Bash(ls:*)'] } }, { sandbox: { enabled: true, filesystem: { disabled: false } } },
    { sandbox: { filesystem: { allowRead: [join(l.root, 'data'), '~/projects/**'], allowWrite: ['/var/tmp/build'], denyRead: ['/x'] } } }]) {
    await put(clean);
    assert.equal(await verdict(), undefined, JSON.stringify(clean));
  }
  // Each weakening key, named with the path.
  const cases: Array<[unknown, RegExp]> = [
    [{ sandbox: { enabled: false } }, /sets sandbox\.enabled false$/],
    [{ sandbox: { filesystem: { disabled: true } } }, /sets sandbox\.filesystem\.disabled true$/],
    // An entry that holds a denied path, is one, lies inside one, by ~ or by a glob.
    [{ sandbox: { filesystem: { allowRead: [l.home] } } }, new RegExp(`allowRead "${l.home}", which covers the denied ${join(l.home, '.ssh')}$`)],
    [{ sandbox: { filesystem: { allowRead: ['~/.ssh'] } } }, /allowRead "~\/\.ssh", which covers the denied .*\/home\/\.ssh$/],
    [{ sandbox: { filesystem: { allowRead: ['~/.ssh/id_ed25519'] } } }, /allowRead "~\/\.ssh\/id_ed25519", which covers the denied .*\/home\/\.ssh$/],
    [{ sandbox: { filesystem: { allowRead: [`${l.state}/**`] } } }, /allowRead ".*\/state\/\*\*", which covers the denied .*\/state\/jobs$/],
    [{ sandbox: { filesystem: { allowWrite: [l.install] } } }, new RegExp(`allowWrite "${l.install}", which covers the denied ${l.install}$`)],
    // Relative: from the settings file's folder (~/.claude/../.ssh).
    [{ sandbox: { filesystem: { allowRead: ['../.ssh'] } } }, /allowRead "\.\.\/\.ssh", which covers/],
    // Shapes Claude Code would not read as this file says: unknown, so refused.
    [{ sandbox: 'off' }, /sets sandbox to something other than an object$/],
    [{ sandbox: { filesystem: { allowRead: 'x' } } }, /allowRead to something other than a list of paths$/],
    ['[]', /is not a JSON object/],
    ['{"sandbox": {', /is not valid JSON/],
  ];
  for (const [settings, expected] of cases) {
    await put(settings);
    const found = await verdict();
    assert.match(found ?? '(none)', expected, JSON.stringify(settings));
    assert.ok(found!.startsWith(file), found);
  }
  // allowWrite of a path denied for reading only does not count (the installation is write-denied only: the reverse).
  await put({ sandbox: { filesystem: { allowRead: [l.install] } } });
  assert.equal(await verdict(), undefined);
  // Unreadable: refused (fail closed).
  await rm(file);
  await mkdir(file);
  assert.match((await verdict())!, /cannot be read \(EISDIR\)/);
  await rm(file, { recursive: true });

  // Through pathDenials: a job session (the Implementer, the review, the simplification pass) is
  // refused with user_settings_weaken_sandbox; a Task check is not guarded.
  await put({ sandbox: { filesystem: { disabled: true } } });
  await assert.rejects(pathDenials(scope(l, 'job')), (error: { code?: string; message?: string }) =>
    error.code === USER_SETTINGS_WEAKEN_SANDBOX && error.message!.includes('sandbox.filesystem.disabled true') && error.message!.includes(file));
  await pathDenials(scope(l, 'task_check'));
  // CLAUDE_CONFIG_DIR: the file the SDK loads moves there.
  const moved = join(l.root, 'claude-config');
  await mkdir(moved);
  await rm(file);
  await writeFile(join(moved, 'settings.json'), JSON.stringify({ sandbox: { enabled: false } }));
  await pathDenials(scope(l, 'job'));
  await assert.rejects(pathDenials({ ...scope(l, 'job'), env: { ...l.env, CLAUDE_CONFIG_DIR: moved } }), (error: { code?: string; message?: string }) =>
    error.code === USER_SETTINGS_WEAKEN_SANDBOX && error.message!.includes(join(moved, 'settings.json')));
});

test('the Implementer session refused by the guard: no query, the turn fails with user_settings_weaken_sandbox and the guard\'s message', async () => {
  const l = await layout('denials-guard-session');
  await writeFile(join(l.home, '.claude', 'settings.json'), JSON.stringify({ sandbox: { enabled: false } }));
  const env = { home: l.home, state: l.state, config: l.config };
  await script(env, [{}]);
  const outcome = await new Promise<IdleOutcome>((resolve) => {
    const session = new ImplementerSession({ cwd: l.own, maxTurns: 3, claudePath: FAKE, sandbox: sandboxSettings({}), pathDenials: () => pathDenials(scope(l, 'job')) }, {
      message: async () => undefined, prompt: async () => undefined, idle: async (ended) => resolve(ended),
    });
    session.send('go', DENIED_TOOLS);
  });
  assert.deepEqual(outcome.ok ? undefined : outcome.code, USER_SETTINGS_WEAKEN_SANDBOX);
  assert.match(outcome.ok ? '' : outcome.message, /settings\.json sets sandbox\.enabled false; the session does not start/);
  assert.equal(existsSync(join(l.home, 'fake-claude.log')), false);
});

test('through sf serve: user settings that weaken the sandbox stop the Implementer before its first turn, and the review of a published iteration, with user_settings_weaken_sandbox naming the key', async () => {
  // The Implementer: the file is there before Start.
  const first = await newEnv('guard-implementer', { SF_REVIEW: 'on' });
  const firstRepo = await newRepo(first, 'guard-implementer-repo', false);
  await putTask(first, firstRepo, 'G-1', 'Guarded');
  await script(first, [{}]);
  await mkdir(join(first.home, '.claude'), { recursive: true });
  await writeFile(join(first.home, '.claude', 'settings.json'), JSON.stringify({ sandbox: { filesystem: { disabled: true } } }));
  const served = await serve(first);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'G-1' });
    const stopped = await waitFor(served, 'G-1', 'needs_human');
    assert.equal(stopped.error.code, USER_SETTINGS_WEAKEN_SANDBOX);
    assert.match(stopped.error.message, /sandbox\.filesystem\.disabled true/);
    assert.equal(existsSync(join(first.home, 'fake-claude.log')), false);
  } finally {
    await stop(served);
  }

  // The review: the Implementer's turn writes the file (as nothing else could: the guard runs
  // before each session), then the review of iteration 1 is refused.
  const second = await newEnv('guard-review', { SF_REVIEW: 'on' });
  const secondRepo = await newRepo(second, 'guard-review-repo', false);
  await putTask(second, secondRepo, 'G-2', 'Guarded review');
  await script(second, [{
    write: { 'README.md': 'changed\n' }, text: 'Report',
    run: [['sh', '-c', `mkdir -p "$HOME/.claude" && printf '%s' '{"sandbox":{"enabled":false}}' > "$HOME/.claude/settings.json"`]],
  }]);
  await reviewScript(second, [{ output: { verdict: 'clean', summary: 'ok', items: [], accepted_sensitive: [] } }]);
  const again = await serve(second);
  try {
    await call(again, 'start', { workspace: 'app', ticket: 'G-2' });
    const stopped = await waitFor(again, 'G-2', 'needs_human', 1);
    assert.equal(stopped.error.code, USER_SETTINGS_WEAKEN_SANDBOX);
    assert.match(stopped.error.message, /sandbox\.enabled false/);
    assert.equal(existsSync(join(second.home, 'fake-review.log')), false);
  } finally {
    await stop(again);
  }
});

test('a session closed while its first turn builds the path denials (an abort right after the runner started) starts no query', async () => {
  const l = await layout('denials-closed');
  const env = { home: l.home, state: l.state, config: l.config };
  await script(env, [{}]);
  let release!: () => void;
  const building = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const asked = new Promise<void>((resolve) => (started = resolve));
  let idle = false;
  const session = new ImplementerSession({
    cwd: l.own, maxTurns: 3, claudePath: FAKE, sandbox: sandboxSettings({}), pathDenials: async () => {
      started();
      await building;
      return pathDenials(scope(l, 'job'));
    },
  }, { message: async () => undefined, prompt: async () => undefined, idle: async () => {
    idle = true;
  } });
  const home = process.env.HOME;
  process.env.HOME = l.home;
  try {
    session.send('go', DENIED_TOOLS);
    await asked;
    const closed = session.close();
    release();
    await closed;
    // Long enough for a query that did start to have logged.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } finally {
    process.env.HOME = home;
  }
  assert.equal(existsSync(join(l.home, 'fake-claude.log')), false);
  // A closed session reports no idle outcome.
  assert.equal(idle, false);
});

test('a user allowRead of ~/.ssh (R1): the Implementer never starts a query, so no Bash command can read ~/.ssh; through sf serve the job stops with user_settings_weaken_sandbox', async () => {
  // pathDenials and the session: refused before any query.
  const l = await layout('denials-allow-ssh');
  await writeFile(join(l.home, '.claude', 'settings.json'), JSON.stringify({ sandbox: { filesystem: { allowRead: ['~/.ssh'] } } }));
  await assert.rejects(pathDenials(scope(l, 'job')), (error: { code?: string; message?: string }) =>
    error.code === USER_SETTINGS_WEAKEN_SANDBOX && error.message!.includes(`allowRead "~/.ssh", which covers the denied ${join(l.home, '.ssh')}`));
  const env = { home: l.home, state: l.state, config: l.config };
  await script(env, [{}]);
  const home = process.env.HOME;
  process.env.HOME = l.home;
  let outcome: IdleOutcome;
  try {
    outcome = await new Promise<IdleOutcome>((resolve) => {
      const session = new ImplementerSession({ cwd: l.own, maxTurns: 3, claudePath: FAKE, sandbox: sandboxSettings({}), pathDenials: () => pathDenials(scope(l, 'job')) }, {
        message: async () => undefined, prompt: async () => undefined, idle: async (ended) => resolve(ended),
      });
      session.send('cat ~/.ssh/*', DENIED_TOOLS);
    });
  } finally {
    process.env.HOME = home;
  }
  assert.deepEqual(outcome.ok ? undefined : outcome.code, USER_SETTINGS_WEAKEN_SANDBOX);
  assert.equal(existsSync(join(l.home, 'fake-claude.log')), false);

  // Through sf serve, with a real ~/.ssh in the job's home.
  const served = await newEnv('guard-allow-ssh', { SF_REVIEW: 'on' });
  const repo = await newRepo(served, 'guard-allow-ssh-repo', false);
  await putTask(served, repo, 'G-3', 'Guarded ssh');
  await script(served, [{}]);
  await mkdir(join(served.home, '.ssh'), { recursive: true });
  await writeFile(join(served.home, '.ssh', 'id_test'), 'key');
  await mkdir(join(served.home, '.claude'), { recursive: true });
  await writeFile(join(served.home, '.claude', 'settings.json'), JSON.stringify({ sandbox: { filesystem: { allowRead: ['~/.ssh'] } } }));
  const running = await serve(served);
  try {
    await call(running, 'start', { workspace: 'app', ticket: 'G-3' });
    const stopped = await waitFor(running, 'G-3', 'needs_human');
    assert.equal(stopped.error.code, USER_SETTINGS_WEAKEN_SANDBOX);
    assert.match(stopped.error.message, /allowRead "~\/\.ssh", which covers the denied .*\/\.ssh/);
    assert.equal(existsSync(join(served.home, 'fake-claude.log')), false);
  } finally {
    await stop(running);
  }
});

// SF-123: a layout whose checkout is in the home directory (~/code/app, a Git repository with an
// ignored .env, a tracked config/.env.production and a .env.example), whose own worktree is a Git
// repository with an untracked .env, and whose home holds .kube, .npm, .local/share/pnpm,
// .local/state, ~/.bashrc and a sibling checkout ~/code/other.
async function homeLayout(name: string): Promise<Layout & { homeCheckout: string }> {
  const l = await layout(name);
  const homeCheckout = join(l.home, 'code', 'app');
  for (const dir of [join(homeCheckout, 'config'), join(l.home, 'code', 'other'), join(l.home, '.kube'), join(l.home, '.npm'), join(l.home, '.local', 'share', 'pnpm'), join(l.home, '.local', 'state', 'x')]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(l.home, '.kube', 'config'), 'secret');
  await writeFile(join(l.home, '.npm', 'x'), 'cache');
  await writeFile(join(l.home, '.bashrc'), 'rc');
  const git = (cwd: string, ...args: string[]): void => void execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });
  git(homeCheckout, 'init', '-q');
  await writeFile(join(homeCheckout, '.gitignore'), '.env\n');
  await writeFile(join(homeCheckout, '.env'), 'SECRET=1\n');
  await writeFile(join(homeCheckout, '.env.example'), 'SECRET=\n');
  await writeFile(join(homeCheckout, 'config', '.env.production'), 'SECRET=2\n');
  await writeFile(join(homeCheckout, 'README.md'), 'readme\n');
  git(homeCheckout, 'add', '.gitignore', '.env.example', 'config/.env.production', 'README.md');
  git(homeCheckout, 'commit', '-q', '-m', 'init');
  git(l.own, 'init', '-q');
  await writeFile(join(l.own, '.env'), 'SECRET=3\n');
  await mkdir(join(l.own, 'src'));
  return { ...l, homeCheckout };
}

const homeScope = (l: Layout & { homeCheckout: string }, session: DenialScope['session'] = 'job'): DenialScope => ({ ...scope(l, session), checkout: l.homeCheckout });

test('the user\'s socket locations (SF-123) are denied for reading and writing when present, left out when missing', async () => {
  const l = await layout('denials-sockets');
  const sys = join(l.root, 'sys');
  const uid = String(process.getuid!());
  const present = [join(sys, 'run', 'user', uid), join(sys, 'run', 'dbus'), join(sys, 'var', 'run', 'docker.sock'), join(sys, 'run', 'tailscale'), join(sys, 'tmp', '.X11-unix'), join(sys, 'tmp', 'ssh-abc123'), join(sys, 'tmp', `tmux-${uid}`), join(l.root, 'xdg')];
  for (const path of present) {
    if (path.endsWith('.sock')) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, '');
    } else {
      await mkdir(path, { recursive: true });
    }
  }
  await mkdir(join(sys, 'tmp', 'other'), { recursive: true });
  const denials = await pathDenials({ ...scope(l, 'job'), env: { ...l.env, XDG_RUNTIME_DIR: join(l.root, 'xdg') } });
  for (const path of present) {
    assert.ok(denials.sandbox.denyRead.includes(path) && denials.sandbox.denyWrite.includes(path), `${path} not denied`);
  }
  const missing = ['run/docker.sock', 'var/run/dbus', 'run/containerd', 'run/podman', 'var/run/tailscale', 'run/screen'].map((path) => join(sys, path));
  for (const path of [...missing, join(sys, 'tmp', 'other'), join(sys, 'tmp')]) {
    assert.ok(!denials.sandbox.denyRead.includes(path) && !denials.sandbox.denyWrite.includes(path), `${path} denied`);
  }
  // The Unix sockets stay allowed: Linux cannot allow them by path.
  assert.equal(sandboxSettings({})!.network!.allowAllUnixSockets, true);
});

test('the home directory (SF-123): a job\'s sandboxed commands read nothing in the home directory but the kept paths, by denyRead only; the specific denials stay inside them; a Task check gets no home denials', async () => {
  const l = await homeLayout('denials-home');
  const denials = await pathDenials(homeScope(l));
  const at = (...parts: string[]): string => join(l.home, ...parts);
  for (const path of [at('.kube'), at('.local', 'state'), at('.bashrc'), at('code', 'other'), at('.claude')]) {
    assert.ok(denials.sandbox.denyRead.includes(path), `${path} readable`);
  }
  for (const path of [at('.npm'), at('.local', 'share', 'pnpm'), at('.local'), at('.local', 'share'), at('code'), l.homeCheckout, l.home]) {
    assert.ok(!denials.sandbox.denyRead.includes(path), `${path} denied`);
  }
  // By denyRead only: not for the tools (the guard holds them), not for writing.
  assert.ok(!denials.sandbox.denyWrite.includes(at('.kube')) && !denials.tools.some((rule) => rule.includes(absoluteRule(at('.kube')))));
  assert.deepEqual([...denials.kept].sort(), [l.own, l.homeCheckout, at('.npm'), at('.local', 'share', 'pnpm'), at('.config', 'git')].sort());
  // A specific denial inside a kept path stays: Git's second credential store in ~/.config/git.
  assert.ok(denials.sandbox.denyRead.includes(at('.config', 'git', 'credentials')) && denials.tools.includes(`Read(${absoluteRule(at('.config', 'git', 'credentials'))})`));
  assert.ok(denials.sandbox.denyRead.includes(at('.config', 'gh')) && !denials.sandbox.denyRead.includes(at('.config', 'git')));
  // No allowRead anywhere, so nothing re-opens a denial inside a kept path.
  assert.deepEqual(Object.keys(denials.sandbox).sort(), ['denyRead', 'denyWrite']);
  const merged = withSandboxDenials(sandboxSettings({}), denials.sandbox)!;
  assert.equal(merged.filesystem!.allowRead, undefined);
  // A Task check: the specific denials only.
  const check = await pathDenials(homeScope(l, 'task_check'));
  assert.ok(!check.sandbox.denyRead.includes(at('.kube')) && check.sandbox.denyRead.includes(at('.ssh')));
});

test('.env files (SF-123): the worktree\'s and the checkout\'s .env files (untracked, ignored or tracked) are denied for reading, nothing re-opens them; .env.example is not', async () => {
  const l = await homeLayout('denials-env');
  const denials = await pathDenials(homeScope(l));
  for (const path of [join(l.homeCheckout, '.env'), join(l.homeCheckout, 'config', '.env.production'), join(l.own, '.env')]) {
    assert.ok(denials.sandbox.denyRead.includes(path), `${path} readable`);
    assert.ok(denials.tools.includes(`Read(${absoluteRule(path)})`), `${path} readable by the Read tool`);
    // Nothing outside denyRead holds it: no allowRead, and no kept path re-allows (kept paths only steer the home denials).
    assert.ok(!(withSandboxDenials(sandboxSettings({}), denials.sandbox)!.filesystem!.allowRead ?? []).length);
  }
  assert.ok(!denials.sandbox.denyRead.includes(join(l.homeCheckout, '.env.example')));
  assert.ok(!denials.tools.some((rule) => rule.includes('.env.example')));
});

test('SF_SANDBOX_ALLOW_READ (SF-123): an entry is kept; one that is, holds or lies in a denied path, climbs, is absolute or has ~ gives invalid_config', async () => {
  const l = await homeLayout('denials-allow-read');
  await mkdir(join(l.home, '.m2', 'repository'), { recursive: true });
  await mkdir(join(l.home, '.m2', 'settings'), { recursive: true });
  const withAllow = (value: string): DenialScope => ({ ...homeScope(l), env: { ...l.env, SF_SANDBOX_ALLOW_READ: value } });
  const denials = await pathDenials(withAllow(' .m2/repository , '));
  assert.ok(denials.kept.includes(join(l.home, '.m2', 'repository')));
  assert.ok(!denials.sandbox.denyRead.includes(join(l.home, '.m2')) && !denials.sandbox.denyRead.includes(join(l.home, '.m2', 'repository')));
  assert.ok(denials.sandbox.denyRead.includes(join(l.home, '.m2', 'settings')));
  for (const value of ['.ssh', '.ssh/keys', '.config', '../x', join(l.root, 'abs'), '~/.m2']) {
    await assert.rejects(pathDenials(withAllow(value)), (error: { code?: string; message?: string }) => error.code === 'invalid_config' && error.message!.includes(`"${value}"`), value);
  }
  assert.deepEqual(sandboxAllowRead({ SF_SANDBOX_ALLOW_READ: '.m2/repository,.gradle/caches' }), ['.m2/repository', '.gradle/caches']);
  assert.deepEqual(sandboxAllowRead({}), []);
});

test('the user settings (SF-123): checked against the specific denials only, so an allowRead of ~/projects/** passes and one of ~/.ssh stops the job', async () => {
  const l = await homeLayout('denials-home-settings');
  await mkdir(join(l.home, 'projects'));
  const file = join(l.home, '.claude', 'settings.json');
  await writeFile(file, JSON.stringify({ sandbox: { filesystem: { allowRead: ['~/projects/**'] } } }));
  const denials = await pathDenials(homeScope(l));
  // ~/projects is denied as a home entry all the same: the user re-opens it in their own settings.
  assert.ok(denials.sandbox.denyRead.includes(join(l.home, 'projects')));
  await writeFile(file, JSON.stringify({ sandbox: { filesystem: { allowRead: ['~/.ssh'] } } }));
  await assert.rejects(pathDenials(homeScope(l)), (error: { code?: string }) => error.code === USER_SETTINGS_WEAKEN_SANDBOX);
});

// Puts one tool call to the denials' PreToolUse hook: the guard's reason, or undefined when it passes.
async function guard(denials: Awaited<ReturnType<typeof pathDenials>>, cwd: string, tool: string, input: unknown): Promise<string | undefined> {
  const hook = denials.hooks!.PreToolUse![0]!.hooks[0]!;
  const answer = await hook({ hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '', cwd, tool_name: tool, tool_input: input, tool_use_id: 't' } as never, 't', { signal: new AbortController().signal });
  const specific = (answer as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return specific?.permissionDecision === 'deny' ? specific.permissionDecisionReason : undefined;
}

test('the file-tool guard (SF-123): writes only in the own worktree outside its .git, by real path; reads in the home only in the kept paths and the session\'s own Claude Code project folder', async () => {
  const l = await homeLayout('denials-file-guard');
  await symlink(l.home, join(l.own, 'out'));
  // A dangling link out of the worktree, and one through a chain of dangling links.
  await symlink(join(l.home, '.bashrc.d', 'new'), join(l.own, 'dangling'));
  await symlink(join(l.own, 'dangling'), join(l.own, 'chained'));
  await symlink(join(l.own, 'loop-b'), join(l.own, 'loop-a'));
  await symlink(join(l.own, 'loop-a'), join(l.own, 'loop-b'));
  const project = join(l.home, '.claude', 'projects', claudeProjectName(l.own));
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'tool-output.txt'), 'saved');
  await mkdir(join(l.home, '.claude', 'projects', 'other'), { recursive: true });
  const denials = await pathDenials(homeScope(l));
  const ask = (tool: string, input: unknown): Promise<string | undefined> => guard(denials, l.own, tool, input);
  // Writes refused, the reason naming the path: the checkout's hook, a home file, through a link, the worktree's .git.
  for (const path of [join(l.homeCheckout, '.git', 'hooks', 'pre-commit'), join(l.home, '.bashrc'), join(l.own, 'out', '.bashrc'), join(l.own, '.git', 'config'), join(l.own, 'dangling'), join(l.own, 'chained')]) {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const reason = await ask(tool, { file_path: path, content: 'x' });
      assert.ok(reason?.startsWith(FILE_GUARD) && reason.includes(path), `${tool} ${path}: ${reason}`);
    }
  }
  assert.match((await ask('NotebookEdit', { notebook_path: join(l.home, 'n.ipynb'), new_source: '' }))!, /n\.ipynb/);
  // A loop of links cannot be checked: refused.
  assert.ok((await ask('Write', { file_path: join(l.own, 'loop-a'), content: 'x' }))?.startsWith(FILE_GUARD));
  // Writes allowed: a file of the worktree, a new nested one, a relative one.
  assert.equal(await ask('Write', { file_path: join(l.own, 'src', 'a.ts'), content: 'x' }), undefined);
  assert.equal(await ask('Write', { file_path: join(l.own, 'new', 'deep', 'b.ts'), content: 'x' }), undefined);
  assert.equal(await ask('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }), undefined);
  // A ~ path, a missing path, an input that is not an object: refused, the path named.
  assert.match((await ask('Write', { file_path: '~/.bashrc', content: 'x' }))!, /~\/\.bashrc/);
  assert.ok((await ask('Write', { content: 'x' }))?.startsWith(FILE_GUARD));
  assert.ok((await ask('Read', 'x'))?.startsWith(FILE_GUARD));
  // Reads refused in the home outside the kept paths, by any read tool.
  for (const [tool, input] of [
    ['Read', { file_path: join(l.home, '.kube', 'config') }], ['Read', { file_path: join(l.home, '.claude', 'projects', 'other', 'x') }],
    ['Grep', { pattern: 'x', path: join(l.home, '.kube') }], ['LS', { path: l.home }], ['Glob', { pattern: `${l.home}/.kube/*` }],
    ['Glob', { pattern: `{src/*,${l.home}/.kube/*}` }], ['Read', { file_path: join(l.own, 'out', '.kube', 'config') }],
  ] as const) {
    const reason = await ask(tool, input);
    assert.ok(reason?.startsWith(FILE_GUARD), `${tool} ${JSON.stringify(input)}: ${reason}`);
  }
  assert.match((await ask('Read', { file_path: '~/.kube/config' }))!, /~\/\.kube\/config/);
  // Reads allowed: a kept toolchain, the checkout, the own project folder, the worktree, outside the home.
  for (const [tool, input] of [
    ['Read', { file_path: join(l.home, '.npm', 'x') }], ['Read', { file_path: join(l.homeCheckout, 'README.md') }], ['Read', { file_path: join(project, 'tool-output.txt') }],
    ['Grep', { pattern: 'x', path: 'src' }], ['Glob', { pattern: '**/*.ts', path: 'src' }], ['Read', { file_path: '/etc/hostname' }], ['Bash', { command: 'cat ~/.kube/config' }],
  ] as const) {
    assert.equal(await ask(tool, input), undefined, `${tool} ${JSON.stringify(input)}`);
  }
});

test('the worktree\'s .git and agent configuration (SF-159): denied to Bash for writing when present, never for reading, no tool rule; the file-tool guard refuses every write tool there, by real path', async () => {
  const l = await layout('denials-agent-config');
  await writeFile(join(l.own, '.git'), 'gitdir: /elsewhere\n');
  await mkdir(join(l.own, '.claude'));
  await writeFile(join(l.own, '.mcp.json'), '{}\n');
  const denials = await pathDenials(scope(l, 'job'));
  for (const name of ['.git', '.claude', '.mcp.json']) {
    assert.ok(denials.sandbox.denyWrite.includes(join(l.own, name)), `${name} writable by Bash`);
    assert.ok(!denials.sandbox.denyRead.includes(join(l.own, name)), `${name} unreadable`);
    assert.ok(!denials.tools.some((rule) => rule.includes(absoluteRule(join(l.own, name)))), name);
  }
  // A missing one is left out, so the sandbox leaves no placeholder for it, and nothing is made for
  // it; the guard still holds the tools.
  assert.ok(!denials.sandbox.denyWrite.includes(join(l.own, '.codex')));
  assert.equal(existsSync(join(l.own, '.codex')), false);
  // A Task check has no worktree of its own (every ticket's is denied whole): no entry of its own for them.
  const check = await pathDenials(scope(l, 'task_check'));
  assert.ok(!['.git', '.claude', '.mcp.json'].some((name) => check.sandbox.denyWrite.includes(join(l.own, name))));

  const ask = (tool: string, input: unknown): Promise<string | undefined> => guard(denials, l.own, tool, input);
  await mkdir(join(l.own, 'src'));
  await symlink(join(l.own, '.claude'), join(l.own, 'src', 'into-claude'));
  for (const path of ['.claude/settings.json', '.claude/settings.local.json', '.claude/skills/x/SKILL.md', '.mcp.json', '.codex/config.toml', '.codex', 'src/into-claude/settings.json']) {
    for (const [tool, input] of [['Write', { file_path: path, content: '{}' }], ['Edit', { file_path: join(l.own, path), old_string: 'a', new_string: 'b' }], ['MultiEdit', { file_path: path, edits: [] }], ['NotebookEdit', { notebook_path: path, new_source: '' }]] as const) {
      const reason = await ask(tool, input);
      assert.equal(reason, `${FILE_GUARD} refuses this ${tool}: ${resolve(l.own, path)} is agent configuration; the factory does not let a job change it.`, `${tool} ${path}`);
    }
  }
  for (const path of ['src/x.ts', 'docs/.claude.md', '.claude.md', '.mcp.json.example', '.codex-notes/a.md']) {
    assert.equal(await ask('Write', { file_path: path, content: 'x' }), undefined, path);
  }
  // .claude a link to a folder of the worktree: a write there is a write of .claude.
  await rm(join(l.own, '.claude'), { recursive: true });
  await mkdir(join(l.own, 'innocent'));
  await symlink('innocent', join(l.own, '.claude'));
  assert.match((await ask('Write', { file_path: 'innocent/settings.json', content: '{}' }))!, /is agent configuration/u);
  // .claude a link to a folder: denied by both spellings. A link that leads nowhere could be removed
  // and replaced by Bash, so no session starts (SF-159 Fix 2).
  const linked = await pathDenials(scope(l, 'job'));
  assert.ok(linked.sandbox.denyWrite.includes(join(l.own, '.claude')) && linked.sandbox.denyWrite.includes(join(l.own, 'innocent')));
  await symlink(join(l.own, 'nowhere'), join(l.own, '.codex'));
  await assert.rejects(pathDenials(scope(l, 'job')), (error: { code?: string }) => error.code === 'watched_path_unsafe');
  // The worktree's .git keeps its own refusal.
  assert.match((await ask('Write', { file_path: '.git', content: 'gitdir: /evil' }))!, /outside the job's worktree .*, or in its \.git\./u);
});

test('claudeProjectName (SF-123): Claude Code\'s folder name of a project, every character but letters and digits as "-", a long one cut with its hash', () => {
  assert.equal(claudeProjectName('/home/teo/.local/state/sf/worktrees/app/A_1'), '-home-teo--local-state-sf-worktrees-app-A-1');
  const long = claudeProjectName(`/${'a'.repeat(250)}`);
  assert.match(long, /^-a{199}-[0-9a-z]+$/);
});

test('a worktree Git cannot list (SF-123): its .env files are found by walking it, so none is left out', async () => {
  const l = await layout('denials-env-walk');
  await mkdir(join(l.own, 'pkg'), { recursive: true });
  await writeFile(join(l.own, '.env'), 'SECRET=1\n');
  await writeFile(join(l.own, 'pkg', '.env.local'), 'SECRET=2\n');
  await writeFile(join(l.own, 'pkg', '.env.sample'), 'SECRET=\n');
  const denials = await pathDenials(scope(l, 'job'));
  assert.ok(denials.sandbox.denyRead.includes(join(l.own, '.env')) && denials.sandbox.denyRead.includes(join(l.own, 'pkg', '.env.local')));
  assert.ok(!denials.sandbox.denyRead.includes(join(l.own, 'pkg', '.env.sample')));
});

test('CLAUDE_CONFIG_DIR outside the home directory (SF-123): its entries but the shell snapshots are denied to Bash as the home\'s are, and the guard refuses reads there but in the own project folder', async () => {
  const l = await homeLayout('denials-config-outside');
  const config = join(l.root, 'claude-config');
  const own = join(config, 'projects', claudeProjectName(l.own));
  for (const dir of [join(config, 'shell-snapshots'), own, join(config, 'projects', 'other'), join(config, 'plugins')]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(own, 'x.jsonl'), '{}');
  await writeFile(join(config, 'projects', 'other', 'x.jsonl'), '{}');
  const denials = await pathDenials({ ...homeScope(l), env: { ...l.env, CLAUDE_CONFIG_DIR: config } });
  assert.ok(denials.sandbox.denyRead.includes(join(config, 'projects')) && denials.sandbox.denyRead.includes(join(config, 'plugins')));
  assert.ok(!denials.sandbox.denyRead.includes(join(config, 'shell-snapshots')) && denials.kept.includes(join(config, 'shell-snapshots')));
  assert.ok((await guard(denials, l.own, 'Read', { file_path: join(config, 'projects', 'other', 'x.jsonl') }))?.startsWith(FILE_GUARD));
  assert.equal(await guard(denials, l.own, 'Read', { file_path: join(own, 'x.jsonl') }), undefined);
});

test('the file-tool guard and links under a search (SF-123 Fix 1): a Glob or Grep that ripgrep\'s --follow would carry into a denied home path through a link anywhere below its folder is refused; links within the worktree, into a toolchain or dangling ones pass', async () => {
  const l = await homeLayout('denials-guard-links');
  const at = (...parts: string[]): string => join(l.own, ...parts);
  await mkdir(at('src', 'deep', 'er'), { recursive: true });
  await writeFile(at('src', 'a.ts'), 'a');
  // Links that keep a search where it may go: within the worktree, into a kept toolchain, dangling.
  await symlink(at('src', 'a.ts'), at('src', 'alias.ts'));
  await symlink(join(l.home, '.npm'), at('src', 'npm-cache'));
  await symlink(join(l.root, 'nowhere'), at('src', 'dangling'));
  // The session's own temporary folder, kept: sandboxed commands write there.
  const sessionTmp = join(l.tmp, 'sf-claude-links');
  await mkdir(sessionTmp, { mode: 0o700 });
  const denials = await pathDenials({ ...homeScope(l), sessionTmp });
  const ask = (tool: string, input: unknown): Promise<string | undefined> => guard(denials, l.own, tool, input);
  for (const [tool, input] of [['Glob', { pattern: 'src/**' }], ['Glob', { pattern: '**/*.ts' }], ['Grep', { pattern: 'x' }], ['Grep', { pattern: 'x', path: 'src' }]] as const) {
    assert.equal(await ask(tool, input), undefined, `${tool} ${JSON.stringify(input)}`);
  }
  // A link to the home directory planted deep below src: every search that walks src is refused, naming the link.
  await symlink(l.home, at('src', 'deep', 'er', 'home'));
  for (const [tool, input] of [['Glob', { pattern: 'src/**' }], ['Glob', { pattern: '**/*.ts' }], ['Grep', { pattern: 'x' }], ['Grep', { pattern: 'x', path: at('src') }], ['Glob', { pattern: '*', path: at('src', 'deep') }]] as const) {
    const reason = await ask(tool, input);
    assert.ok(reason?.startsWith(FILE_GUARD) && reason.includes(at('src', 'deep', 'er', 'home')), `${tool} ${JSON.stringify(input)}: ${reason}`);
  }
  // A pattern without a glob character matches at any depth: the whole folder is walked. A search of
  // a folder beside the link still passes; a Read of a file stays a check of that path only.
  assert.ok((await ask('Glob', { pattern: 'config' }))?.startsWith(FILE_GUARD));
  assert.ok((await ask('Glob', { pattern: 'docs/**' }))?.startsWith(FILE_GUARD));
  await mkdir(at('docs'));
  assert.equal(await ask('Glob', { pattern: '**', path: at('docs') }), undefined);
  assert.equal(await ask('Read', { file_path: at('src', 'a.ts') }), undefined);
  // Through a folder outside the worktree (one sandboxed commands may write, such as the session's
  // temporary folder) that holds a link to a denied home path.
  await rm(at('src', 'deep', 'er', 'home'));
  const hop = join(sessionTmp, 'hop');
  await mkdir(hop, { recursive: true });
  await symlink(join(l.home, '.kube'), join(hop, 'kube'));
  await symlink(hop, at('src', 'hop'));
  const reason = await ask('Glob', { pattern: 'src/**' });
  assert.ok(reason?.startsWith(FILE_GUARD) && reason.includes(join(hop, 'kube')), reason);
  // A loop of folder links ends (each folder walked once).
  await rm(at('src', 'hop'));
  await symlink(at('src'), at('src', 'deep', 'loop'));
  assert.equal(await ask('Glob', { pattern: 'src/**' }), undefined);
  // A search of a folder that holds the home directory, by path, by an absolute pattern or through a
  // link to it, is refused without any link into the home.
  for (const [tool, input] of [['Grep', { pattern: 'secret', path: l.root }], ['Glob', { pattern: '*/.kube/*', path: l.root }], ['Glob', { pattern: `${l.root}/*/.kube/*` }]] as const) {
    const reason = await ask(tool, input);
    assert.ok(reason?.startsWith(FILE_GUARD) && reason.includes(`holding ${l.home}`), `${tool} ${JSON.stringify(input)}: ${reason}`);
  }
  await symlink(l.root, at('src', 'up'));
  assert.match((await ask('Glob', { pattern: 'src/**' }))!, /links to .* holding /);
  await rm(at('src', 'up'));
  // A toolchain is walked too: sandboxed commands may write in one (Claude Code allows ~/.npm/_logs).
  await mkdir(join(l.home, '.npm', '_logs'), { recursive: true });
  await symlink(join(l.home, '.kube'), join(l.home, '.npm', '_logs', 'kube'));
  for (const input of [{ pattern: 'src/**' }, { pattern: '**', path: join(l.home, '.npm') }]) {
    assert.ok((await ask('Glob', input))?.includes(join(l.home, '.npm', '_logs', 'kube')), JSON.stringify(input));
  }
});

test('SF_SANDBOX_ALLOW_READ (SF-123 Fix 4): an entry that is, or holds, the home directory (or a guarded root) is refused, though no credential exists below the home; so is one that only links there', async () => {
  const l = await layout('denials-allow-read-home');
  // A home with no specific denial below it: no credential, no Claude Code folder.
  const home = join(l.root, 'bare-home');
  await mkdir(join(home, '.m2', 'repository'), { recursive: true });
  await mkdir(join(home, 'notes'), { recursive: true });
  await symlink(home, join(home, '.m2', 'home-link'));
  await symlink('/', join(home, 'root-link'));
  const withAllow = (value: string): DenialScope => ({ ...scope(l, 'job'), env: { ...l.env, HOME: home, SF_SANDBOX_ALLOW_READ: value } });
  for (const value of ['.', './', '.m2/..', '.m2/home-link', 'root-link', '.m2/repository,.']) {
    await assert.rejects(pathDenials(withAllow(value)), (error: { code?: string; message?: string }) => error.code === 'invalid_config' && error.message!.includes('SF_SANDBOX_ALLOW_READ'), value);
  }
  // A toolchain below the home still passes, and the home's other entries stay denied.
  const denials = await pathDenials(withAllow('.m2/repository'));
  assert.ok(denials.kept.includes(join(home, '.m2', 'repository')) && !denials.kept.includes(home));
  assert.ok(denials.sandbox.denyRead.includes(join(home, 'notes')));
});

// The bwrap arguments as mounts, in order (SF-125): [option, ...its values].
function mounts(args: string[]): string[][] {
  const arity: Record<string, number> = { '--die-with-parent': 0, '--unshare-pid': 0, '--seccomp': 1, '--tmpfs': 1, '--dev': 1, '--proc': 1, '--ro-bind': 2, '--bind': 2 };
  const result: string[][] = [];
  for (let index = 0; index < args.length; index += 1) {
    const count = arity[args[index]!];
    assert.ok(count !== undefined, `unexpected bwrap argument ${args[index]}`);
    result.push(args.slice(index, index + count + 1));
    index += count;
  }
  return result;
}

const denialsOf = (denyRead: string[]): PathDenials => ({ tools: [], sandbox: { denyRead, denyWrite: [] }, claudeTmp: { denyRead: [], allowRead: [], allowWrite: [] }, kept: [], hooks: undefined });

// Codex as npm installs it (a link in bin/ to the launcher in node_modules), and a standalone one.
async function codexInstall(name: string): Promise<{ root: string; linked: string; modules: string; standalone: string }> {
  const root = await realpath(await mkdir(join(temp, name), { recursive: true }).then(() => join(temp, name)));
  const launcher = join(root, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, '');
  await mkdir(join(root, 'bin'), { recursive: true });
  await symlink(launcher, join(root, 'bin', 'codex'));
  await mkdir(join(root, 'standalone'), { recursive: true });
  await writeFile(join(root, 'standalone', 'codex'), '');
  return { root, linked: join(root, 'bin', 'codex'), modules: join(root, 'lib', 'node_modules'), standalone: join(root, 'standalone', 'codex') };
}

const NODE_PREFIX = dirname(dirname(realpathSync(process.execPath)));

test('gateWrapper (SF-125, SF-161): the socket filter on fd 3, the system read-only, then the denials, then the read-only binds, then CODEX_HOME and the iteration directory read-write, last; no --unshare-net', async () => {
  const codex = await codexInstall('wrapper-order');
  const worktree = join(codex.root, 'worktree');
  // Denials outside /tmp (the test's own files are under it): a directory, a file, one gone, one
  // under the temporary folders (the tmpfs hides it already), and an image's denied jobs/.
  const args = gateWrapper(denialsOf(['/etc', '/usr/bin/env', '/nonexistent-sf-125', '/sf-tmp/x', '/tmp/x', '/var/lib']), {
    worktree, codexPath: codex.linked, codexHome: '/h/.codex', iterationDir: '/var/lib/sf/jobs/app/T/iterations/001', images: ['/var/lib/sf/jobs/app/T/attachments/1.png'], tmp: '/sf-tmp',
  });
  assert.deepEqual(mounts(args), [
    ['--die-with-parent'], ['--unshare-pid'], ['--seccomp', '3'], ['--ro-bind', '/', '/'], ['--dev', '/dev'], ['--proc', '/proc'], ['--tmpfs', '/tmp'], ['--tmpfs', '/sf-tmp'],
    ['--tmpfs', '/etc'], ['--ro-bind', '/dev/null', '/usr/bin/env'], ['--tmpfs', '/var/lib'],
    ['--ro-bind', worktree, worktree], ['--ro-bind', '/var/lib/sf/jobs/app/T/attachments/1.png', '/var/lib/sf/jobs/app/T/attachments/1.png'],
    ['--ro-bind', codex.modules, codex.modules], ['--ro-bind', NODE_PREFIX, NODE_PREFIX],
    ['--bind', '/h/.codex', '/h/.codex'], ['--bind', '/var/lib/sf/jobs/app/T/iterations/001', '/var/lib/sf/jobs/app/T/iterations/001'],
  ]);
  assert.ok(!args.includes('--unshare-net'));
  // The socket filter (src/seccomp.ts), which spawnSeccomped writes to fd 3, once.
  assert.deepEqual(mounts(args).filter((mount) => mount[0] === '--seccomp'), [['--seccomp', '3']]);
  // A tmp under /tmp has no tmpfs of its own; the worktree under it is bound back after /tmp's.
  const under = mounts(gateWrapper(denialsOf([]), { worktree, codexPath: codex.standalone, codexHome: '/h/.codex', iterationDir: '/i', images: [], tmp: join(temp, 'tmp') }));
  assert.deepEqual(under.filter((mount) => mount[0] === '--tmpfs'), [['--tmpfs', '/tmp']]);
  assert.ok(worktree.startsWith('/tmp/') ? under.findIndex((mount) => mount[1] === worktree) > under.findIndex((mount) => mount[1] === '/tmp') : true);
  // Codex without a node_modules above it: its own folder.
  assert.ok(under.some((mount) => mount.join(' ') === `--ro-bind ${join(codex.root, 'standalone')} ${join(codex.root, 'standalone')}`), JSON.stringify(under));
});

test('gateWrapper (SF-125): a denial inside a bound folder stays (the worktree\'s .env), and a bind inside such a denial is bound again (an image under jobs/), the most specific path winning', async () => {
  const codex = await codexInstall('wrapper-fixup');
  const worktree = join(codex.root, 'worktree');
  const jobs = join(codex.root, 'standalone', 'jobs');
  const image = join(jobs, 'app', 'T', 'attachments', '1.png');
  await mkdir(dirname(image), { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, '.env'), 'SECRET=1\n');
  await writeFile(image, 'png');
  const args = mounts(gateWrapper(denialsOf([join(worktree, '.env'), jobs]), {
    worktree, codexPath: codex.standalone, codexHome: '/h/.codex', iterationDir: '/i', images: [image], tmp: '/tmp',
  }));
  const index = (mount: string): number => args.findIndex((entry) => entry.join(' ') === mount);
  // The worktree, the image, the Codex folder (holding jobs/) bound; then jobs/ and the .env hidden
  // again, and the image bound again after jobs/; the read-write binds last.
  const bound = (path: string): string => `--ro-bind ${path} ${path}`;
  for (const mount of [bound(worktree), bound(image), bound(join(codex.root, 'standalone')), `--tmpfs ${jobs}`, `--ro-bind /dev/null ${join(worktree, '.env')}`]) {
    assert.ok(index(mount) >= 0, `${mount} in ${JSON.stringify(args)}`);
  }
  assert.ok(index(`--tmpfs ${jobs}`) > index(bound(join(codex.root, 'standalone'))));
  assert.ok(index(`--ro-bind /dev/null ${join(worktree, '.env')}`) > index(bound(worktree)));
  const lastImage = args.map((entry) => entry.join(' ')).lastIndexOf(bound(image));
  assert.ok(lastImage > index(`--tmpfs ${jobs}`), JSON.stringify(args));
  assert.deepEqual(args.slice(-2), [['--bind', '/h/.codex', '/h/.codex'], ['--bind', '/i', '/i']]);
});

test('gateWrapper (SF-133): a denial reached through a link is hidden at its real path, once, since bwrap cannot mount through a link (/var/run/dbus with /var/run a link to /run)', async (t) => {
  const linked = (await lstat('/var/run').catch(() => undefined))?.isSymbolicLink() === true && existsSync('/var/run/dbus');
  if (!linked) {
    t.skip('no /var/run link to a folder holding dbus here');
    return;
  }
  const codex = await codexInstall('wrapper-link');
  const real = realpathSync('/var/run/dbus');
  const args = mounts(gateWrapper(denialsOf(['/var/run/dbus', real]), {
    worktree: join(codex.root, 'worktree'), codexPath: codex.standalone, codexHome: '/h/.codex', iterationDir: '/i', images: [], tmp: '/tmp',
  }));
  assert.deepEqual(args.filter((mount) => mount[1] === real || mount[1] === '/var/run/dbus'), [['--tmpfs', real]]);
});

test('gateWrapperFor (SF-125): the wrapper of pathDenials(scope): every denyRead entry of the job\'s denials outside the temporary folders is hidden', async () => {
  const l = await layout('wrapper-for');
  const codex = await codexInstall('wrapper-for-codex');
  const options = { worktree: l.own, codexPath: codex.linked, codexHome: join(l.home, '.codex'), iterationDir: join(l.state, 'jobs', 'app', 'A-1'), images: [], tmp: l.tmp };
  const args = await gateWrapperFor(scope(l, 'job'), options);
  assert.deepEqual(args, gateWrapper(await pathDenials(scope(l, 'job')), options));
  assert.deepEqual(args.slice(-6), ['--bind', join(l.home, '.codex'), join(l.home, '.codex'), '--bind', join(l.state, 'jobs', 'app', 'A-1'), join(l.state, 'jobs', 'app', 'A-1')]);
});
