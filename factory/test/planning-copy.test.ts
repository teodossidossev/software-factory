// sf planner setup <workspace>: the planning copy it prepares (the clone, the exclude, the skill, the
// pointers file, the settings, the MCP server registered with a fake claude for that folder only),
// the token in no output and no file of the copy, a second run's fast-forward and its notes, and
// every refusal with its code; the repository's Claude Code configuration kept out of the copy by
// its sparse checkout; plannerSettings for a given environment.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FactoryError } from '../src/errors.js';
import { plannerCommand, plannerSettings, skillsOff } from '../src/planning-copy.js';
import { rolesOf, writeRoles } from '../src/skill-roles.js';
import { syncSkills } from '../src/skills.js';
import { type Env, git, newEnv, newRepo, processEnv, runCli, skillsSourceDir, temp } from './support/harness.js';

const TOKEN = 'ab'.repeat(32);
const SKILL_SOURCE = fileURLToPath(new URL('../../skills/planning-tasks/', import.meta.url));
// The pointers' last item without a vision of the workspace.
const NO_VISION = '- **The product vision:** none is stored for this workspace.';

// The warning for a planner skill the snapshot lacks.
const missingSkill = (skill: string): string =>
  `warning: the planner's skill ${skill} is not in the factory's skills snapshot; the copy goes without it (sf skills shows what is installed).`;
// stdout without those warnings: the tests without a skills snapshot get one for grilling.
const withoutMissingSkills = (stdout: string): string => stdout.split('\n').filter((line) => !line.startsWith("warning: the planner's skill ")).join('\n');
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A fake claude first on PATH: it logs its folder and arguments to claude.log beside it; with fail,
// `claude mcp add` prints its arguments (the header with the token) to stderr and exits 1.
async function fakeClaude(dir: string, fail = false): Promise<string> {
  await mkdir(dir, { recursive: true });
  const failing = fail ? 'case "$*" in "mcp add"*) echo "error: cannot add $*" >&2; exit 1;; esac\n' : '';
  await writeFile(join(dir, 'claude'), `#!/bin/sh\necho "$(pwd -P) $*" >> "${join(dir, 'claude.log')}"\n${failing}exit 0\n`);
  await chmod(join(dir, 'claude'), 0o755);
  return dir;
}

// An Env with workspace app registered at a repository with a local bare origin (temp/<repoName>),
// the MCP token, SF_PORT 18787, SF_PLANNING_DIR under its home and the fake claude on PATH.
async function plannerEnv(name: string, repoName = `${name}-repo`): Promise<{ env: Env; repo: string; copy: string; bin: string }> {
  const env = await newEnv(name);
  // newRepo registers it as workspace app.
  const repo = await newRepo(env, repoName, true);
  await mkdir(env.state, { recursive: true, mode: 0o700 });
  await writeFile(join(env.state, 'mcp-token'), `${TOKEN}\n`, { mode: 0o600 });
  const bin = await fakeClaude(join(temp, `${name}-bin`));
  const planning = join(env.home, 'planning');
  env.extra = { SF_PORT: '18787', SF_PLANNING_DIR: planning, PATH: `${bin}:${process.env.PATH}` };
  return { env, repo, copy: join(planning, 'app'), bin };
}

async function setup(env: Env): Promise<{ stdout: string; stderr: string }> {
  const result = await runCli(env, ['planner', 'setup', 'app']);
  assert.equal(result.code, 0, result.stderr);
  return result;
}

// Every file under dir, .git included, links not followed.
async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

// A commit pushed to the repository's bare origin from a clone of its own (the checkout untouched).
function pushCommit(repo: string, file: string): string {
  const origin = git(repo, 'config', '--get', 'remote.origin.url').trim();
  const pusher = join(temp, `pusher-${file}`);
  execFileSync('git', ['clone', '-q', origin, pusher]);
  execFileSync('sh', ['-c', `echo change > ${file}`], { cwd: pusher });
  git(pusher, 'add', file);
  git(pusher, 'commit', '-q', '-m', `add ${file}`);
  git(pusher, 'push', '-q', 'origin', 'main');
  return git(pusher, 'rev-parse', 'HEAD').trim();
}

test('a first run clones the workspace, installs the skill and the pointers, and registers the MCP server for the copy only', async () => {
  const { env, repo, copy, bin } = await plannerEnv('planner-first');
  await mkdir(join(env.config, 'rules'), { recursive: true });
  await writeFile(join(env.config, 'rules', 'app.md'), 'Mine.\n');
  // A folder in the place of rules/global.md is not a rules file.
  await mkdir(join(env.config, 'rules', 'global.md'));
  const result = await setup(env);

  // PC-1: the clone at the default branch, /.claude/ excluded.
  assert.equal(git(copy, 'symbolic-ref', '--short', 'HEAD').trim(), 'main');
  assert.equal(git(copy, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/main'));
  assert.equal(git(copy, 'config', '--get', 'remote.origin.url'), git(repo, 'config', '--get', 'remote.origin.url'));
  assert.ok((await readFile(join(copy, '.git', 'info', 'exclude'), 'utf8')).split('\n').includes('/.claude/'));
  assert.equal(git(copy, 'status', '--porcelain'), '');

  // PC-2: the skill, byte for byte.
  const names = (await readdir(SKILL_SOURCE)).sort();
  assert.deepEqual(names, ['ANATOMY.md', 'SKILL.md', 'TRACE.md']);
  assert.deepEqual((await readdir(join(copy, '.claude', 'skills', 'planning-tasks'))).sort(), names);
  for (const file of names) {
    assert.deepEqual(await readFile(join(copy, '.claude', 'skills', 'planning-tasks', file)), await readFile(join(SKILL_SOURCE, file)), file);
  }

  // PC-3: the pointers, with the request's path and the one rules file there is.
  assert.equal(await readFile(join(copy, '.claude', 'planning-copy.md'), 'utf8'), [
    '# Planning copy of `app`',
    '',
    "This folder is the Software Factory's planning copy of the workspace `app`, on its base",
    'branch `main`. Read it and plan with it; change nothing in it. Plan a ticket with the',
    '`planning-tasks` skill.',
    '',
    "- **The user's request** of a ticket created on the dashboard, in their own words:",
    `  \`${join(env.state, 'requests', 'app', '<ticket>.md')}\``,
    "- **The user's rules for this workspace.** The Task check and the reviewers enforce them. Read",
    `  them before any test plan: \`${join(env.config, 'rules', 'app.md')}\``,
    NO_VISION,
    '',
  ].join('\n'));

  // PC-4: claude mcp in the copy, removed then added, local scope.
  const real = await realpath(copy);
  assert.deepEqual((await readFile(join(bin, 'claude.log'), 'utf8')).trim().split('\n'), [
    `${real} mcp remove software-factory --scope local`,
    `${real} mcp add --scope local --transport http software-factory http://127.0.0.1:18787/mcp --header Authorization: Bearer ${TOKEN}`,
  ]);

  // PC-5: the token in no output and no file of the copy.
  assert.equal(result.stdout.includes(TOKEN) || result.stderr.includes(TOKEN), false);
  for (const file of await walk(copy)) {
    assert.equal((await readFile(file)).includes(TOKEN), false, file);
  }

  const short = git(copy, 'rev-parse', '--short', 'HEAD').trim();
  // No skills snapshot: the default role's grilling is a warning.
  assert.deepEqual(result.stdout.trim().split('\n'), [
    missingSkill('grilling'),
    `Planning copy of app: ${copy} (main at ${short})`,
    'MCP server software-factory: registered for this folder only (Claude Code local scope)',
    'Skill planning-tasks: installed in .claude/skills',
    'Skills switched off for the planner: 0 of yours (skillOverrides), and your claude.ai skills (syncClaudeAiSkills false)',
    'Pointers: .claude/planning-copy.md',
    "Settings: read-only; shell commands in Claude Code's sandbox (no writes, no network); secrets denied",
    'Hooks: the phone hears when the planner waits for you (sf planner waiting)',
    `Next: open Claude Code there once and accept its trust dialog: cd ${copy} && claude`,
    'Then plan a ticket: /planning-tasks workspace app, ticket <ticket>',
  ]);
});

test('a second run fast-forwards a clean copy, leaves a changed one, and replaces a link at the skill', async () => {
  const { env, repo, copy } = await plannerEnv('planner-second');
  await setup(env);
  const checkoutHead = git(repo, 'rev-parse', 'HEAD');

  // A clean copy is fast-forwarded; the exclude stays as it is.
  const first = pushCommit(repo, 'first.txt');
  const clean = await setup(env);
  assert.equal(git(copy, 'rev-parse', 'HEAD').trim(), first);
  assert.doesNotMatch(withoutMissingSkills(clean.stdout), /^(note|warning):/m);
  assert.equal((await readFile(join(copy, '.git', 'info', 'exclude'), 'utf8')).split('\n').filter((line) => line === '/.claude/').length, 1);

  // A copy with changes is left as it is and says so.
  await writeFile(join(copy, 'README.md'), 'mine\n');
  const second = pushCommit(repo, 'second.txt');
  const changed = await setup(env);
  assert.match(changed.stdout, /^note: the copy has changes; main was not fast-forwarded\.$/m);
  assert.equal(git(copy, 'rev-parse', 'HEAD').trim(), first);
  assert.equal(git(copy, 'rev-parse', 'origin/main').trim(), second);
  assert.equal(await readFile(join(copy, 'README.md'), 'utf8'), 'mine\n');

  // A link at the skill (an interim copy's) becomes the folder; its target is untouched. Both
  // rules files are named.
  const outside = join(temp, 'planner-second-skill');
  await mkdir(outside);
  await writeFile(join(outside, 'SKILL.md'), 'theirs\n');
  const skill = join(copy, '.claude', 'skills', 'planning-tasks');
  await rm(skill, { recursive: true });
  await symlink(outside, skill);
  await mkdir(join(env.config, 'rules'), { recursive: true });
  await writeFile(join(env.config, 'rules', 'app.md'), 'Mine.\n');
  await writeFile(join(env.config, 'rules', 'global.md'), 'All.\n');
  await setup(env);
  assert.equal((await lstat(skill)).isDirectory(), true);
  assert.deepEqual(await readFile(join(skill, 'SKILL.md')), await readFile(join(SKILL_SOURCE, 'SKILL.md')));
  assert.deepEqual(await readdir(outside), ['SKILL.md']);
  assert.equal(await readFile(join(outside, 'SKILL.md'), 'utf8'), 'theirs\n');
  assert.match(await readFile(join(copy, '.claude', 'planning-copy.md'), 'utf8'),
    new RegExp(`test plan: \`${join(env.config, 'rules', 'app.md')}\` and \`${join(env.config, 'rules', 'global.md')}\`\n${escaped(NO_VISION)}\n$`));

  // The registered checkout was never fetched into or moved.
  assert.equal(git(repo, 'rev-parse', 'HEAD'), checkoutHead);
  assert.equal(git(repo, 'rev-parse', 'origin/main'), checkoutHead);
});

test('sf planner setup refuses what it cannot use, each with its code', async () => {
  const { env, repo, bin } = await plannerEnv('planner-refusals', 'app');
  const planning = join(env.home, 'planning');
  const lines: string[] = [];
  const run = (extra: Record<string, string> = {}, workspace = 'app'): Promise<void> => plannerCommand(['setup', workspace], {
    env: { ...processEnv(env), ...extra }, stateDir: env.state, configDir: env.config, mcpPort: async () => 18787, print: (line) => lines.push(line),
  });
  const refused = async (code: string, message: string | RegExp, extra: Record<string, string> = {}, workspace = 'app'): Promise<void> => {
    await assert.rejects(run(extra, workspace), (error: unknown) => {
      assert.ok(error instanceof FactoryError, String(error));
      assert.equal(error.code, code);
      if (typeof message === 'string') {
        assert.equal(error.message, message);
      } else {
        assert.match(error.message, message);
      }
      assert.equal(error.message.includes(temp), false, error.message);
      return true;
    });
  };

  // The copy path is the registered checkout (temp/app).
  await refused('planning_copy_unusable', 'The planning copy of app would be the checkout of workspace app: set SF_PLANNING_DIR to another folder.', { SF_PLANNING_DIR: temp });
  // ... through a link to a folder inside the checkout, before anything exists there.
  const link = join(temp, 'planner-link');
  await symlink(join(repo, 'sub'), link);
  await refused('planning_copy_unusable', 'The planning copy of app would be the checkout of workspace app: set SF_PLANNING_DIR to another folder.', { SF_PLANNING_DIR: link });
  assert.equal(existsSync(join(repo, 'sub')), false);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  // ... a copy that holds a registered checkout.
  const holding = join(temp, 'planner-holding');
  await mkdir(join(holding, 'app', 'inner'), { recursive: true });
  git(join(holding, 'app', 'inner'), 'init', '-q');
  assert.equal((await runCli(env, ['workspace', 'add', 'inner', '--read', join(holding, 'app', 'inner')])).code, 0);
  await refused('planning_copy_unusable', 'The planning copy of app would be the checkout of workspace inner: set SF_PLANNING_DIR to another folder.', { SF_PLANNING_DIR: holding });
  assert.equal((await runCli(env, ['workspace', 'remove', 'inner'])).code, 0);

  // An existing folder or file that is not a clone of the origin.
  const notClone = 'app in the planning folder is not a clone of app\'s origin: move it away and run sf planner setup again.';
  await mkdir(join(planning, 'app'), { recursive: true });
  await writeFile(join(planning, 'app', 'notes.txt'), 'mine\n');
  await refused('planning_copy_unusable', notClone);
  const other = join(temp, 'planner-other-origin');
  execFileSync('git', ['init', '-q', '--bare', other]);
  await rm(join(planning, 'app'), { recursive: true });
  execFileSync('git', ['clone', '-q', other, join(planning, 'app')], { stdio: 'ignore' });
  await refused('planning_copy_unusable', notClone);
  await rm(join(planning, 'app'), { recursive: true });
  await writeFile(join(planning, 'app'), 'a file\n');
  await refused('planning_copy_unusable', notClone);
  await rm(join(planning, 'app'));
  // ... nor one that shares the checkout's repository: its worktree, or .git a link to its .git.
  git(repo, 'worktree', 'add', '-q', '--detach', join(planning, 'app'));
  await refused('planning_copy_unusable', notClone);
  git(repo, 'worktree', 'remove', '--force', join(planning, 'app'));
  await mkdir(join(planning, 'app'));
  await symlink(join(repo, '.git'), join(planning, 'app', '.git'));
  await refused('planning_copy_unusable', notClone);
  await rm(join(planning, 'app'), { recursive: true });
  assert.equal((await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).includes('/.claude/'), false);

  // A relative SF_PLANNING_DIR.
  await refused('invalid_config', 'SF_PLANNING_DIR must be an absolute path.', { SF_PLANNING_DIR: 'planning' });

  // A checkout without an origin.
  const lonely = join(temp, 'planner-lonely');
  await mkdir(lonely);
  git(lonely, 'init', '-q');
  assert.equal((await runCli(env, ['workspace', 'add', 'lonely', '--read', lonely])).code, 0);
  await refused('no_origin', "lonely's checkout has no origin remote to clone.", {}, 'lonely');

  // No MCP token (the copy is made all the same, the server not registered).
  await rm(join(env.state, 'mcp-token'));
  await refused('no_mcp_token', /no_mcp_token/);
  await writeFile(join(env.state, 'mcp-token'), `${TOKEN}\n`, { mode: 0o600 });
  assert.equal(existsSync(join(bin, 'claude.log')), false);

  // A failing claude mcp add: its output with the token redacted.
  const failing = await fakeClaude(join(temp, 'planner-failing-bin'), true);
  await refused('planner_mcp_failed', /^Registering the factory's MCP server for app's planning copy failed: error: cannot add mcp add .*Authorization: Bearer <token>$/, { PATH: `${failing}:${process.env.PATH}` });

  // .claude a link: nothing is written through it.
  const elsewhere = join(temp, 'planner-elsewhere');
  await mkdir(elsewhere);
  await rm(join(planning, 'app', '.claude'), { recursive: true });
  await symlink(elsewhere, join(planning, 'app', '.claude'));
  await refused('planning_copy_unsafe', ".claude in app's planning copy is a link or not a folder: remove it and run sf planner setup again.");
  assert.deepEqual(await readdir(elsewhere), []);
  await rm(join(planning, 'app', '.claude'));

  // No claude on PATH, through the CLI: PATH holds only git and node.
  const bare = join(temp, 'planner-path');
  await mkdir(bare);
  for (const program of ['git', 'node']) {
    await symlink(execFileSync('which', [program], { encoding: 'utf8' }).trim(), join(bare, program));
  }
  await refused('claude_not_found', 'Claude Code (claude) is not on PATH: install it, then run sf planner setup again.', { PATH: bare });

  // A file system error on the way: planning_copy_failed, its paths as placeholders.
  const skills = join(planning, 'app', '.claude', 'skills');
  await rm(join(skills, 'planning-tasks'), { recursive: true });
  await chmod(skills, 0o500);
  try {
    await refused('planning_copy_failed', /^Preparing app's planning copy failed: EACCES: .*'<copy>\/\.claude\/skills\/planning-tasks'$/);
  } finally {
    await chmod(skills, 0o700);
  }
  env.extra = { ...env.extra, PATH: bare };
  const missing = await runCli(env, ['planner', 'setup', 'app']);
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr.trim(), 'sf: Claude Code (claude) is not on PATH: install it, then run sf planner setup again.');

  // No arguments, or others: the usage error, exit 2.
  for (const args of [['planner'], ['planner', 'setup'], ['planner', 'start', 'app'], ['planner', 'setup', 'app', 'more'], ['planner', 'waiting'], ['planner', 'waiting', 'app', 'other'], ['planner', 'waiting', 'app', 'permission', 'more']]) {
    const usage = await runCli(env, args);
    assert.equal(usage.code, 2, args.join(' '));
    assert.match(usage.stderr, /^sf: planner needs setup <workspace>, waiting <workspace> \[permission\], start <workspace> <ticket> or stop <workspace> <ticket>\./);
  }
  assert.deepEqual(lines.filter((line) => line.includes(TOKEN)), []);
});

const PLANNER_ALLOW = ['mcp__software-factory', 'Read', 'Grep', 'Glob', 'Skill', 'Agent', 'Task', 'TodoWrite', 'ToolSearch'];
const PLANNER_DENY_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebFetch(domain:*)', 'WebSearch'];
const sandboxWith = (denyRead: string): unknown => ({
  enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: ['.'], denyRead: [denyRead] },
});

test('plannerSettings: read-only tools, the secrets of this environment denied, the shell sandboxed', () => {
  // SF_ENV_FILE and HOME only: Claude Code's configuration and the tunnel profile under HOME, and
  // ~/.claude/.credentials.json once, with Claude Code's configuration (not again with the home
  // directory's credentials).
  const plain = plannerSettings({ SF_ENV_FILE: '/srv/sf/auth.env', HOME: '/home/u' }, '/var/sf/state');
  assert.deepEqual(plain, {
    permissions: {
      allow: PLANNER_ALLOW,
      deny: [
        ...PLANNER_DENY_TOOLS,
        'Read(//srv/sf/auth.env)',
        'Read(//var/sf/state/mcp-token)',
        'Read(//var/sf/state/dashboard-token)',
        'Read(//home/u/.claude/settings.json)',
        'Read(//home/u/.claude.json)',
        'Read(//home/u/.claude/.credentials.json)',
        'Read(//home/u/.claude/backups/**)',
        'Read(//home/u/.ssh/**)',
        'Read(//home/u/.codex/**)',
        'Read(//home/u/.aws/**)',
        'Read(//home/u/.config/gh/**)',
        'Read(//home/u/.git-credentials)',
        'Read(//home/u/.config/git/credentials)',
        'Read(//home/u/.netrc)',
        'Read(//home/u/.npmrc)',
        'Read(//home/u/.gnupg/**)',
        'Read(//home/u/.kube/**)',
        'Read(//home/u/.config/glab-cli/**)',
        'Read(//home/u/.docker/config.json)',
        'Read(//home/u/.config/tunnel-client/software-factory.yaml)',
      ],
    },
    sandbox: sandboxWith('//var/sf/state'),
  });

  // Every override: the rules follow them; the state directory's glob characters are escaped in the
  // rules, not in denyRead.
  const moved = plannerSettings({
    SF_ENV_FILE: '/etc/sf/auth.env', HOME: '/home/v', CLAUDE_CONFIG_DIR: '/opt/claude', TUNNEL_CLIENT_PROFILE_DIR: '/opt/tunnel', XDG_CONFIG_HOME: '/home/v/xdg',
  }, '/data/sf(2)/state');
  assert.deepEqual(moved, {
    permissions: {
      allow: PLANNER_ALLOW,
      deny: [
        ...PLANNER_DENY_TOOLS,
        'Read(//etc/sf/auth.env)',
        'Read(//data/sf\\(2\\)/state/mcp-token)',
        'Read(//data/sf\\(2\\)/state/dashboard-token)',
        'Read(//opt/claude/settings.json)',
        'Read(//opt/claude/.claude.json)',
        'Read(//opt/claude/.credentials.json)',
        'Read(//opt/claude/backups/**)',
        'Read(//home/v/.ssh/**)',
        'Read(//home/v/.codex/**)',
        'Read(//home/v/.aws/**)',
        'Read(//home/v/.config/gh/**)',
        'Read(//home/v/.git-credentials)',
        'Read(//home/v/.config/git/credentials)',
        'Read(//home/v/.netrc)',
        'Read(//home/v/.npmrc)',
        'Read(//home/v/.claude/.credentials.json)',
        'Read(//home/v/.gnupg/**)',
        'Read(//home/v/.kube/**)',
        'Read(//home/v/.config/glab-cli/**)',
        'Read(//home/v/.docker/config.json)',
        'Read(//opt/tunnel/software-factory.yaml)',
      ],
    },
    sandbox: sandboxWith('//data/sf(2)/state'),
  });

  // SF_ENV_FILE empty: no environment file, no rule for one.
  const noEnvFile = plannerSettings({ SF_ENV_FILE: '', HOME: '/home/w' }, '/home/w/.local/state/software-factory');
  assert.deepEqual(noEnvFile, {
    permissions: {
      allow: PLANNER_ALLOW,
      deny: [
        ...PLANNER_DENY_TOOLS,
        'Read(//home/w/.local/state/software-factory/mcp-token)',
        'Read(//home/w/.local/state/software-factory/dashboard-token)',
        'Read(//home/w/.claude/settings.json)',
        'Read(//home/w/.claude.json)',
        'Read(//home/w/.claude/.credentials.json)',
        'Read(//home/w/.claude/backups/**)',
        'Read(//home/w/.ssh/**)',
        'Read(//home/w/.codex/**)',
        'Read(//home/w/.aws/**)',
        'Read(//home/w/.config/gh/**)',
        'Read(//home/w/.git-credentials)',
        'Read(//home/w/.config/git/credentials)',
        'Read(//home/w/.netrc)',
        'Read(//home/w/.npmrc)',
        'Read(//home/w/.gnupg/**)',
        'Read(//home/w/.kube/**)',
        'Read(//home/w/.config/glab-cli/**)',
        'Read(//home/w/.docker/config.json)',
        'Read(//home/w/.config/tunnel-client/software-factory.yaml)',
      ],
    },
    sandbox: sandboxWith('//home/w/.local/state/software-factory'),
  });

  // RO-2: the planner reads the user's rules and requests with the Read tool.
  for (const settings of [plain, moved, noEnvFile]) {
    assert.deepEqual(settings.permissions.deny.filter((rule) => /\/(rules|requests)\b/.test(rule)), []);
  }
});

// The copy's hooks (PW-6): the factory's bin/sf and the workspace's name, each quoted for the shell.
const SF_BIN = fileURLToPath(new URL('../../bin/sf', import.meta.url));
const HOOKS = {
  Stop: [{ hooks: [{ type: 'command', command: `'${SF_BIN}' planner waiting 'app'`, timeout: 30 }] }],
  Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'command', command: `'${SF_BIN}' planner waiting 'app' permission`, timeout: 30 }] }],
};

test("sf planner setup writes the copy's settings and keeps the file's other keys", async () => {
  const { env, copy } = await plannerEnv('planner-settings');
  const file = join(copy, '.claude', 'settings.local.json');
  const expected = plannerSettings(processEnv(env), env.state);
  assert.ok(expected.permissions.deny.includes(`Read(/${join(env.state, 'mcp-token')})`));

  // A first run: the file made, mode 0600, the token in it nowhere.
  const first = await setup(env);
  assert.match(first.stdout, /^Settings: read-only; shell commands in Claude Code's sandbox \(no writes, no network\); secrets denied$/m);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...expected, hooks: HOOKS, skillOverrides: {}, syncClaudeAiSkills: false });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readFile(file, 'utf8')).includes(TOKEN), false);

  // The user's keys kept with their values and in their place, permissions and skillOverrides
  // replaced whole, sandbox and syncClaudeAiSkills last; the hooks' Stop and Notification replaced,
  // PreToolUse kept (PW-6); written in place, the file keeps its mode 0600.
  const preToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo checked' }] }];
  const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'echo stopped' }] }], PreToolUse: preToolUse };
  await writeFile(file, `${JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(awk:*)'], defaultMode: 'acceptEdits' }, skillOverrides: { mine: 'off' }, hooks })}\n`);
  const second = await setup(env);
  assert.match(second.stdout, /^Settings: /m);
  const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(written), ['model', 'permissions', 'skillOverrides', 'hooks', 'sandbox', 'syncClaudeAiSkills']);
  assert.deepEqual(written, {
    model: 'opus', permissions: expected.permissions, skillOverrides: {}, hooks: { PreToolUse: preToolUse, ...HOOKS }, sandbox: expected.sandbox, syncClaudeAiSkills: false,
  });
  assert.equal(JSON.stringify(written).includes('Bash(awk:*)'), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  // Another mode the user gave the file is kept.
  await chmod(file, 0o640);
  await setup(env);
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.equal(git(copy, 'status', '--porcelain'), '');
});

test('a settings file that is a link or not an object is refused, untouched', async () => {
  const { env, repo, copy } = await plannerEnv('planner-settings-refused');
  await setup(env);
  const file = join(copy, '.claude', 'settings.local.json');
  const refused = async (code: string, message: string): Promise<void> => {
    await assert.rejects(plannerCommand(['setup', 'app'], {
      env: processEnv(env), stateDir: env.state, configDir: env.config, mcpPort: async () => 18787, print: () => undefined,
    }), (error: unknown) => {
      assert.ok(error instanceof FactoryError, String(error));
      assert.equal(error.code, code);
      assert.equal(error.message, message);
      return true;
    });
  };

  // A link, to a file or to nowhere, and a folder: unsafe, nothing written through the link.
  const unsafe = ".claude/settings.local.json in app's planning copy is a link or not a file: remove it and run sf planner setup again.";
  const outside = join(temp, 'planner-settings-outside.json');
  await writeFile(outside, '{"hooks":{}}\n');
  await rm(file);
  await symlink(outside, file);
  await refused('planning_copy_unsafe', unsafe);
  assert.equal((await lstat(file)).isSymbolicLink(), true);
  assert.equal(await readFile(outside, 'utf8'), '{"hooks":{}}\n');
  await rm(file);
  await symlink(join(temp, 'planner-settings-nowhere.json'), file);
  await refused('planning_copy_unsafe', unsafe);
  assert.equal(existsSync(join(temp, 'planner-settings-nowhere.json')), false);
  await rm(file);
  await mkdir(file);
  await refused('planning_copy_unsafe', unsafe);
  assert.deepEqual(await readdir(file), []);
  await rm(file, { recursive: true });

  // Not a JSON object: unusable, the file unchanged.
  const unusable = ".claude/settings.local.json in app's planning copy is not a JSON object: fix or remove it.";
  for (const text of ['[]\n', 'null\n', '"text"\n', '{"permissions":\n', '']) {
    await writeFile(file, text, { mode: 0o600 });
    await refused('planning_copy_unusable', unusable);
    assert.equal(await readFile(file, 'utf8'), text);
  }
  await rm(file);
  await setup(env);

  // A repository that tracks the settings file.
  await mkdir(join(repo, '.claude'));
  await writeFile(join(repo, '.claude', 'settings.local.json'), '{}\n');
  // -f: a global ignore of the machine may name the file.
  git(repo, 'add', '-f', '.claude/settings.local.json');
  git(repo, 'commit', '-q', '-m', 'settings');
  git(repo, 'push', '-q', 'origin', 'main');
  await refused('planning_copy_unsafe', 'The repository of app tracks .claude/settings.local.json, which the planning copy writes.');
});

test('PW-5: sf planner waiting exits 0 with no stdin, for an unknown workspace and for a refused name; the hook command runs', async () => {
  const received: Array<{ title: unknown; click: unknown; body: string }> = [];
  const ntfy = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({ title: req.headers.title, click: req.headers.click, body });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => ntfy.listen(0, '127.0.0.1', resolve));
  try {
    // No workspace registered at all, stdin empty: a Stop with no transcript is notified.
    const env = await newEnv('planner-waiting');
    env.extra = { SF_NTFY_URL: `http://127.0.0.1:${(ntfy.address() as AddressInfo).port}/sf`, CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_01Ab' };
    const waiting = await runCli(env, ['planner', 'waiting', 'app']);
    assert.deepEqual([waiting.code, waiting.stdout, waiting.stderr], [0, '', '']);
    const permission = await runCli(env, ['planner', 'waiting', 'app', 'permission']);
    assert.deepEqual([permission.code, permission.stderr], [0, '']);
    assert.deepEqual(received, [
      { title: 'Planner waits for you', click: 'https://claude.ai/code/session_01Ab', body: 'app' },
      { title: 'Planner waits for a permission', click: 'https://claude.ai/code/session_01Ab', body: 'app' },
    ]);

    // A name checkName refuses: one stderr line, exit 0, nothing sent.
    const refusedName = await runCli(env, ['planner', 'waiting', '../app']);
    assert.equal(refusedName.code, 0);
    assert.match(refusedName.stderr, /^sf planner waiting: workspace name must be .*\n$/);
    assert.equal(received.length, 2);

    // The Stop hook's command as Claude Code runs it, with invalid JSON on stdin.
    const hook = await runShell(HOOKS.Stop[0]!.hooks[0]!.command, 'not json', processEnv(env));
    assert.deepEqual([hook.code, hook.stderr], [0, '']);
    assert.deepEqual(received.map((entry) => entry.title), ['Planner waits for you', 'Planner waits for a permission', 'Planner waits for you']);

    // An environment file that is malformed, or cannot be read (a folder): one stderr line naming
    // the file only (never its line), exit 0, nothing sent. Another command still fails on it.
    const envFile = join(env.config, 'auth.env');
    await mkdir(env.config, { recursive: true });
    await writeFile(envFile, 'SF_NTFY_TOKEN secret-in-a-broken-line\n');
    for (const args of [['planner', 'waiting', 'app'], ['planner', 'waiting', 'app', 'permission']]) {
      const broken = await runCli(env, args);
      assert.deepEqual([broken.code, broken.stdout, broken.stderr], [0, '', 'sf planner waiting: auth.env could not be read.\n'], args.join(' '));
    }
    assert.equal((await runCli(env, ['planner', 'setup', 'app'])).code, 1);
    await rm(envFile);
    await mkdir(envFile);
    const unreadable = await runCli(env, ['planner', 'waiting', 'app']);
    assert.deepEqual([unreadable.code, unreadable.stderr], [0, 'sf planner waiting: auth.env could not be read.\n']);
    assert.equal(received.length, 3);
  } finally {
    ntfy.closeAllConnections();
    await new Promise<void>((resolve) => ntfy.close(() => resolve()));
  }
});

// sh -c command with input on stdin: its exit code and stderr.
function runShell(command: string, input: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
    child.stdin.end(input);
  });
}

// Files written in the checkout (each holding its own path), committed and pushed to its origin.
// -f: a global ignore of the machine may name them.
async function pushFiles(repo: string, paths: string[], message: string): Promise<void> {
  for (const path of paths) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), `${path}\n`);
  }
  git(repo, 'add', '-f', ...paths);
  git(repo, 'commit', '-q', '-m', message);
  git(repo, 'push', '-q', 'origin', 'main');
}

test("sf planner setup keeps the repository's Claude Code configuration out of the copy", async () => {
  const { env, repo, copy } = await plannerEnv('planner-config');
  const config = ['.claude/settings.json', '.claude/agents/a.md', 'sub/.claude/skills/y/SKILL.md', '.mcp.json'];
  await pushFiles(repo, [...config, '.claude/CLAUDE.md'], 'claude config');
  const factoryFiles = ['.claude/planning-copy.md', '.claude/settings.local.json', '.claude/skills/planning-tasks/SKILL.md'];
  // The copy holds the repository's CLAUDE.md and the factory's files, none of the others but
  // those named; its sparse checkout is set and its status clean but for changed files.
  const leftOut = (stays: string[] = [], status = ''): void => {
    for (const path of config) {
      assert.equal(existsSync(join(copy, path)), stays.includes(path), path);
    }
    for (const path of ['.claude/CLAUDE.md', 'README.md', ...factoryFiles]) {
      assert.equal(existsSync(join(copy, path)), true, path);
    }
    assert.deepEqual(git(copy, 'sparse-checkout', 'list').split('\n').filter((line) => line !== ''), ['/*', '!**/.claude/*', '**/.claude/CLAUDE.md', '!/.mcp.json']);
    assert.equal(git(copy, 'status', '--porcelain', '--untracked-files=no'), status);
  };

  // CO-1: a first run.
  const first = await setup(env);
  leftOut();
  assert.doesNotMatch(withoutMissingSkills(first.stdout), /^(note|warning):/m);
  assert.equal(await readFile(join(copy, '.claude', 'CLAUDE.md'), 'utf8'), '.claude/CLAUDE.md\n');

  // CO-2: a copy made before (its sparse checkout disabled) loses them at its next run.
  git(copy, 'sparse-checkout', 'disable');
  for (const path of config) {
    assert.equal(existsSync(join(copy, path)), true, path);
  }
  await setup(env);
  leftOut();

  // CO-3: a fast-forward changes the settings and CLAUDE.md: the first stays out, the second is
  // updated.
  const origin = git(repo, 'config', '--get', 'remote.origin.url').trim();
  const pusher = join(temp, 'planner-config-pusher');
  execFileSync('git', ['clone', '-q', origin, pusher]);
  await writeFile(join(pusher, '.claude', 'settings.json'), '{"hooks":{}}\n');
  await writeFile(join(pusher, '.claude', 'CLAUDE.md'), 'Updated.\n');
  git(pusher, 'commit', '-q', '-a', '-m', 'change the config');
  git(pusher, 'push', '-q', 'origin', 'main');
  await setup(env);
  assert.equal(git(copy, 'rev-parse', 'HEAD'), git(pusher, 'rev-parse', 'HEAD'));
  assert.equal(await readFile(join(copy, '.claude', 'CLAUDE.md'), 'utf8'), 'Updated.\n');
  leftOut();

  // CO-4: a configuration file with changes of the user's stays, with a warning; the run succeeds.
  git(copy, 'sparse-checkout', 'disable');
  await writeFile(join(copy, '.claude', 'agents', 'a.md'), 'mine\n');
  const changed = await runCli(env, ['planner', 'setup', 'app']);
  assert.equal(changed.code, 0, changed.stderr);
  assert.match(changed.stdout, /^warning: \.claude\/agents\/a\.md stays in the planning copy of app: it has changes of yours, or Git does not track it\. Claude Code would load it there: remove it and run sf planner setup app again\.$/m);
  assert.equal(withoutMissingSkills(changed.stdout).match(/^warning:/gm)?.length, 1, changed.stdout);
  assert.equal(await readFile(join(copy, '.claude', 'agents', 'a.md'), 'utf8'), 'mine\n');
  leftOut(['.claude/agents/a.md'], ' M .claude/agents/a.md\n');
});

test('a failed sparse checkout stops sf planner setup', async () => {
  const { env, copy } = await plannerEnv('planner-sparse-fails');
  // A git first on PATH that fails every sparse-checkout and runs the real git otherwise.
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const fake = join(temp, 'planner-sparse-fails-git');
  await mkdir(fake);
  await writeFile(join(fake, 'git'), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = sparse-checkout ]; then echo 'fatal: simulated' >&2; exit 128; fi\ndone\nexec '${real}' "$@"\n`);
  await chmod(join(fake, 'git'), 0o755);
  env.extra = { ...env.extra, PATH: `${fake}:${env.extra!.PATH}` };
  const result = await runCli(env, ['planner', 'setup', 'app']);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.stderr.trim(), "sf: The planning copy of app could not leave out the repository's Claude Code configuration: simulated");
  // The clone was made; no later step ran.
  assert.equal(existsSync(join(copy, 'README.md')), true);
  assert.equal(existsSync(join(copy, '.claude', 'planning-copy.md')), false);
  assert.equal(existsSync(join(copy, '.claude')), false);

  // Its code, on the next run of the existing copy: runGit finds git on this process's PATH.
  const path = process.env.PATH;
  process.env.PATH = `${fake}:${path}`;
  try {
    await assert.rejects(plannerCommand(['setup', 'app'], {
      env: processEnv(env), stateDir: env.state, configDir: env.config, mcpPort: async () => 18787, print: () => undefined,
    }), (error: unknown) => {
      assert.ok(error instanceof FactoryError, String(error));
      assert.equal(error.code, 'planning_copy_unsafe');
      assert.equal(error.message, "The planning copy of app could not leave out the repository's Claude Code configuration: simulated");
      return true;
    });
  } finally {
    process.env.PATH = path;
  }
  assert.equal(existsSync(join(copy, '.claude')), false);
});

test('a repository that tracks .claude as a link is refused', async () => {
  const { env, repo, copy, bin } = await plannerEnv('planner-config-link');
  await mkdir(join(repo, 'conf'));
  await writeFile(join(repo, 'conf', 'settings.json'), '{"hooks":{}}\n');
  await symlink('conf', join(repo, '.claude'));
  git(repo, 'add', '-f', '.claude', 'conf');
  git(repo, 'commit', '-q', '-m', 'a linked .claude');
  git(repo, 'push', '-q', 'origin', 'main');
  const message = 'The repository tracks .claude as a link, a file or a submodule, not a folder: the planning copy of app cannot leave its Claude Code configuration out.';

  const result = await runCli(env, ['planner', 'setup', 'app']);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.stderr.trim(), `sf: ${message}`);
  assert.equal(existsSync(join(copy, '.claude', 'planning-copy.md')), false);
  // Nothing was written through the link.
  assert.deepEqual(await readdir(join(copy, 'conf')), ['settings.json']);
  assert.equal(existsSync(join(bin, 'claude.log')), false);

  // Its code, on the next run of the existing copy.
  await assert.rejects(plannerCommand(['setup', 'app'], {
    env: processEnv(env), stateDir: env.state, configDir: env.config, mcpPort: async () => 18787, print: () => undefined,
  }), (error: unknown) => {
    assert.ok(error instanceof FactoryError, String(error));
    assert.equal(error.code, 'planning_copy_unsafe');
    assert.equal(error.message, message);
    return true;
  });
  assert.equal(existsSync(join(copy, '.claude', 'planning-copy.md')), false);
});

// A folder dir/name holding a SKILL.md.
async function skillFolder(dir: string, name: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, 'SKILL.md'), `${name}\n`);
}

// Every file under dir, relative to it, sorted.
async function filesOf(dir: string): Promise<string[]> {
  return (await walk(dir)).map((path) => path.slice(dir.length + 1)).sort();
}

test("sf planner setup installs the planner's skills from the snapshot and switches the others off", async () => {
  const { env, copy } = await plannerEnv('planner-skills');
  await writeRoles(env.state, { ...rolesOf(undefined), planner: ['grilling', 'tdd', 'gone'] });
  await syncSkills(env.state, processEnv(env));
  const personal = join(env.home, '.claude', 'skills');
  await skillFolder(personal, 'code-review');
  await symlink(join(skillsSourceDir(), 'implement'), join(personal, 'implement'));
  await symlink(join(skillsSourceDir(), 'tdd'), join(personal, 'tdd'));
  await skillFolder(personal, 'planning-tasks');
  await skillFolder(join(personal, 'synced', 'b1'), 'pdf');
  await mkdir(join(personal, 'notes'));
  await writeFile(join(personal, 'notes', 'readme.md'), 'notes\n');
  const snapshot = await realpath(join(env.state, 'skills'));
  const state = await filesOf(env.state);
  const file = join(copy, '.claude', 'settings.local.json');
  const skills = join(copy, '.claude', 'skills');

  // SK-1 and SK-2: a first run.
  const first = await setup(env);
  for (const skill of ['grilling', 'tdd']) {
    const files = await filesOf(join(snapshot, skill));
    assert.ok(files.includes('SKILL.md'), skill);
    assert.deepEqual(await filesOf(join(skills, skill)), files, skill);
    for (const path of files) {
      assert.deepEqual(await readFile(join(skills, skill, path)), await readFile(join(snapshot, skill, path)), `${skill}/${path}`);
    }
  }
  assert.deepEqual(await readFile(join(skills, 'planning-tasks', 'SKILL.md')), await readFile(join(SKILL_SOURCE, 'SKILL.md')));
  assert.equal(existsSync(join(skills, 'gone')), false);
  const lines = first.stdout.trim().split('\n');
  assert.ok(lines.indexOf(missingSkill('gone')) >= 0 && lines.indexOf(missingSkill('gone')) < lines.findIndex((line) => line.startsWith('Planning copy of app: ')), first.stdout);
  assert.equal(lines.filter((line) => line.startsWith('warning:')).length, 1, first.stdout);
  const skillsLine = lines.indexOf('Skills planning-tasks, grilling, tdd: installed in .claude/skills');
  assert.ok(skillsLine > 0, first.stdout);
  assert.equal(lines[skillsLine + 1], 'Skills switched off for the planner: 2 of yours (skillOverrides), and your claude.ai skills (syncClaudeAiSkills false)');
  const settings = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(settings.skillOverrides, { 'code-review': 'off', implement: 'off' });
  assert.equal(settings.syncClaudeAiSkills, false);
  // The snapshot read as it is: nothing written in the state directory.
  assert.deepEqual(await filesOf(env.state), state);
  assert.equal(await realpath(join(env.state, 'skills')), snapshot);

  // SK-3: the role drops tdd; the user's skillOverrides replaced whole; CLAUDE_CONFIG_DIR's skills
  // read instead of ~/.claude/skills.
  await writeFile(file, `${JSON.stringify({ ...settings, skillOverrides: { grilling: 'off', mine: 'name-only' } }, null, 2)}\n`);
  await writeRoles(env.state, { ...rolesOf(undefined), planner: ['grilling'] });
  await skillFolder(join(env.home, 'cc', 'skills'), 'other');
  env.extra = { ...env.extra, CLAUDE_CONFIG_DIR: join(env.home, 'cc') };
  const second = await setup(env);
  assert.equal(await readFile(join(skills, 'tdd', 'SKILL.md'), 'utf8'), await readFile(join(snapshot, 'tdd', 'SKILL.md'), 'utf8'));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).skillOverrides, { other: 'off', tdd: 'off' });
  assert.match(second.stdout, /^Skills planning-tasks, grilling: installed in \.claude\/skills$/m);
  assert.match(second.stdout, /^Skills switched off for the planner: 2 of yours /m);
  assert.doesNotMatch(second.stdout, /^warning:/m);
});

test("sf planner setup refuses a repository that tracks a planner skill's folder", async () => {
  const { env, repo, copy } = await plannerEnv('planner-skill-tracked');
  await pushFiles(repo, ['.claude/skills/grilling/SKILL.md'], 'a tracked planner skill');
  const result = await runCli(env, ['planner', 'setup', 'app']);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.stderr.trim(), 'sf: The repository of app tracks .claude/skills/grilling/SKILL.md, which the planning copy writes.');
  assert.equal(existsSync(join(copy, '.claude', 'skills', 'planning-tasks')), false);
  assert.equal(existsSync(join(copy, '.claude', 'skills', 'grilling')), false);
});

test('the pointers name the workspace\'s English vision, or say there is none', async () => {
  const { env, copy } = await plannerEnv('planner-vision');
  const pointers = join(copy, '.claude', 'planning-copy.md');
  // Another workspace's vision only: none for app.
  await mkdir(join(env.state, 'vision', 'other', 'en'), { recursive: true });
  await writeFile(join(env.state, 'vision', 'other', 'en', 'VISION.md'), '# Other\n');
  await setup(env);
  assert.ok((await readFile(pointers, 'utf8')).endsWith(`\`\n${NO_VISION}\n`));

  // app's English vision: its folder, after the first put.
  const dir = join(env.state, 'vision', 'app', 'en');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'VISION.md'), '# App\n');
  await setup(env);
  assert.ok((await readFile(pointers, 'utf8')).endsWith([
    '`',
    '- **The product vision** of this workspace, in English: the folder below. Read its `VISION.md`',
    '  first, with the Read tool (the shell does not see the folder), then what the ticket needs of',
    `  its \`CODEMAP.md\` and \`chapters/\`: \`${dir}\``,
    '',
  ].join('\n')), await readFile(pointers, 'utf8'));
});

test('skillsOff: the skill folders of both folders but the kept ones, once each, by name', async () => {
  const root = join(temp, 'planner-skills-off');
  const personal = join(root, 'personal');
  const own = join(root, 'own');
  await skillFolder(personal, 'code-review');
  await skillFolder(join(root, 'linked'), 'tdd');
  await symlink(join(root, 'linked', 'tdd'), join(personal, 'tdd'));
  await skillFolder(join(personal, 'synced', 'b1'), 'pdf');
  await mkdir(join(personal, 'notes'));
  await writeFile(join(personal, 'notes', 'readme.md'), 'notes\n');
  await symlink(join(root, 'nowhere'), join(personal, 'dangling'));
  await skillFolder(personal, 'Bad_Name');
  await skillFolder(own, 'planning-tasks');
  await skillFolder(own, 'stale');
  assert.deepEqual(await skillsOff(personal, own, ['planning-tasks', 'grilling']), ['code-review', 'stale', 'tdd']);
  // A name in both folders counts once; a kept one in either, never.
  await skillFolder(own, 'code-review');
  await skillFolder(personal, 'grilling');
  assert.deepEqual(await skillsOff(personal, own, ['planning-tasks', 'grilling']), ['code-review', 'stale', 'tdd']);
  assert.deepEqual(await skillsOff(join(root, 'missing'), join(root, 'missing-too'), []), []);
});
