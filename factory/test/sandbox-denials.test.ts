// The path denials of every session the factory starts (SF-100): what is denied for reading and
// writing, what for writing only, what stays (the own worktree and checkout), missing paths left
// out, the sandbox's filesystem lists, the Implementer session building them once, the Task checks'
// parent directory, and no SSH agent in the sessions' and the gate's environment.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { sandboxSettings } from '../src/config.js';
import { gateEnvironment } from '../src/gate.js';
import { saveRegistry } from '../src/registry.js';
import { DENIED_TOOLS } from '../src/rules.js';
import { absoluteRule, claudeUserSettings, cliRuleList, type DenialScope, HOME_CREDENTIALS, installDir, PATH_DENIAL_UNREPRESENTABLE, pathDenials, prepareTaskChecksDir, taskChecksDir, USER_SETTINGS_WEAKEN_SANDBOX, userSettingsWeakening, withSandboxDenials } from '../src/sandbox-denials.js';
import { type IdleOutcome, ImplementerSession, sessionEnvironment } from '../src/session.js';
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
  for (const dir of ['.ssh', '.codex', '.aws', '.config/gh']) {
    await mkdir(join(l.home, dir), { recursive: true });
  }
  for (const file of ['.git-credentials', '.npmrc', '.claude/.credentials.json']) {
    await writeFile(join(l.home, file), 'secret');
  }
  await writeFile(join(l.install, 'package.json'), '{"name":"software-factory"}\n');
  await saveRegistry({ workspaces: { app: { read_checkout: l.checkout }, web: { read_checkout: l.otherCheckout }, gone: { read_checkout: at('checkouts', 'gone') } } }, l.config);
  l.env = { HOME: l.home, SF_CONFIG_DIR: l.config, SF_ENV_FILE: l.envFile, TUNNEL_CLIENT_PROFILE_DIR: l.tunnel };
  return l;
}

const scope = (l: Layout, session: DenialScope['session']): DenialScope => ({
  session, workspace: 'app', checkout: l.checkout, ...(session === 'job' ? { worktree: l.own } : {}), stateDir: l.state, worktreeRoot: l.worktrees,
  env: l.env, moduleDir: join(l.install, 'dist', 'src'), tmp: l.tmp,
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
  assert.ok(denials.tools.every((rule) => /^(Read|Edit|Write)\(\/\/[^*]+(\/\*\*)?\)$/.test(rule)), denials.tools.join(', '));
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
  assert.deepEqual(gateEnvironment(env), { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k' });
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
      assert.deepEqual(settings.sandbox, { ...sandbox, filesystem: { disabled: false, ...denials.sandbox } });
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
