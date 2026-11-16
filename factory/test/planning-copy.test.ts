// sf planner setup <workspace>: the planning copy it prepares (the clone, the exclude, the skill, the
// pointers file, the MCP server registered with a fake claude for that folder only), the token in
// no output and no file of the copy, a second run's fast-forward and its notes, and every refusal
// with its code.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FactoryError } from '../src/errors.js';
import { plannerCommand } from '../src/planning-copy.js';
import { type Env, git, newEnv, newRepo, processEnv, runCli, temp } from './support/harness.js';

const TOKEN = 'ab'.repeat(32);
const SKILL_SOURCE = fileURLToPath(new URL('../../skills/planning-tasks/', import.meta.url));

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
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `Planning copy of app: ${copy} (main at ${short})`,
    'MCP server software-factory: registered for this folder only (Claude Code local scope)',
    'Skill planning-tasks: installed in .claude/skills',
    'Pointers: .claude/planning-copy.md',
    `Next: open Claude Code there once and accept its trust dialog: cd ${copy} && claude`,
    'Then plan a ticket: /planning-tasks workspace app, ticket <ticket>',
  ]);
});

test('a second run fast-forwards a clean copy, leaves a changed one, and replaces a link at the skill', async () => {
  const { env, repo, copy } = await plannerEnv('planner-second');
  await setup(env);
  const checkoutHead = git(repo, 'rev-parse', 'HEAD');

  // A clean copy is fast-forwarded; settings.local.json and the exclude stay as they are.
  await writeFile(join(copy, '.claude', 'settings.local.json'), '{"permissions":{}}\n');
  const first = pushCommit(repo, 'first.txt');
  const clean = await setup(env);
  assert.equal(git(copy, 'rev-parse', 'HEAD').trim(), first);
  assert.doesNotMatch(clean.stdout, /^(note|warning):/m);
  assert.equal(await readFile(join(copy, '.claude', 'settings.local.json'), 'utf8'), '{"permissions":{}}\n');
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
    new RegExp(`test plan: \`${join(env.config, 'rules', 'app.md')}\` and \`${join(env.config, 'rules', 'global.md')}\`\n$`));

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
  for (const args of [['planner'], ['planner', 'setup'], ['planner', 'start', 'app'], ['planner', 'setup', 'app', 'more']]) {
    const usage = await runCli(env, args);
    assert.equal(usage.code, 2, args.join(' '));
    assert.match(usage.stderr, /^sf: planner needs setup <workspace>\./);
  }
  assert.deepEqual(lines.filter((line) => line.includes(TOKEN)), []);
});
