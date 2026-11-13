// The Implementer's Claude Code inside bubblewrap (SF-181): the wrapper's arguments for a fixed set
// of denials and paths, a session's query spawned through the fake bwrap with its command, argv, cwd
// and environment unchanged, a missing or failing bwrap ending the turn with sandbox_unavailable and
// never an unwrapped Claude Code, and, where the real bubblewrap starts, what a command inside the
// real wrapper may write.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { sandboxSettings } from '../src/config.js';
import { findBwrap } from '../src/gate.js';
import { within } from '../src/test-command.js';
import type { SandboxDenials } from '../src/sandbox-denials.js';
import { type IdleOutcome, ImplementerSession } from '../src/session.js';
import { implementerSkills, skillsSnapshot, syncSkills } from '../src/skills.js';
import { BWRAP_MISSING, CLAUDE_WRITTEN, claudeExecutable, implementerWrapper, prepareClaudeState, type WrapperPaths } from '../src/session-wrapper.js';
import { bwrapLog, FAKE, fakeLog, newEnv, script, temp, useFakeBwrap } from './support/harness.js';

// A fake home with Claude Code's state, a native install under ~/.local/share/claude, ~/.ssh, the
// user's own skills (~/.claude/skills/mine, ~/.agents/skills/theirs), a worktree with a .git file, a
// .env and a .claude folder, and a skills snapshot's folder (snapshot: implement/SKILL.md and
// tdd/SKILL.md), of which the paths bind implement alone; every path real.
async function fixture(name: string): Promise<{ root: string; paths: WrapperPaths; denials: SandboxDenials; snapshot: string }> {
  const root = join(await realpath(temp), name);
  const home = join(root, 'home');
  const claudeDir = join(home, '.claude');
  const worktree = join(root, 'worktree');
  const sessionTmp = join(root, 'tmp', 'sf-claude-1-x');
  const executable = join(home, '.local', 'share', 'claude', 'versions', '9.9.9');
  const skills = join(root, 'state', 'skills.d', 'one');
  for (const dir of [
    join(home, '.ssh'), claudeDir, join(claudeDir, 'backups'), join(claudeDir, 'skills', 'mine'), join(home, '.agents', 'skills', 'theirs'), join(worktree, '.claude'), sessionTmp,
    dirname(executable), join(skills, 'implement'), join(skills, 'tdd'),
  ]) {
    await mkdir(dir, { recursive: true });
  }
  await prepareClaudeState(claudeDir, join(home, '.claude.json'));
  for (const [path, text] of [
    [join(home, '.ssh', 'id_ed25519'), 'key'], [join(home, '.claude.json'), '{}'], [join(claudeDir, '.credentials.json'), '{}'], [join(claudeDir, 'settings.json'), '{}'],
    [join(worktree, '.git'), 'gitdir: /nowhere\n'], [join(worktree, '.env'), 'SECRET=1\n'], [executable, '#!/bin/sh\n'],
    [join(skills, 'implement', 'SKILL.md'), 'the factory\'s implement\n'], [join(skills, 'tdd', 'SKILL.md'), 'tdd\n'], [join(claudeDir, 'skills', 'mine', 'SKILL.md'), 'mine\n'],
    [join(home, '.agents', 'skills', 'theirs', 'SKILL.md'), 'theirs\n'],
  ] as const) {
    await writeFile(path, text);
  }
  const share = join(home, '.local', 'share');
  const denials: SandboxDenials = {
    // As pathDenials builds them for a job: the credentials, the global config, the home's other
    // entries (~/.local/share, ~/.agents, Claude Code's own entries), the worktree's .env.
    denyRead: [
      join(home, '.ssh'), join(claudeDir, '.credentials.json'), join(home, '.claude.json'), share, join(home, '.agents'), join(claudeDir, 'projects'), join(claudeDir, 'backups'),
      join(claudeDir, 'skills'), join(claudeDir, 'settings.json'), join(worktree, '.env'),
    ],
    denyWrite: [join(home, '.ssh'), join(claudeDir, '.credentials.json'), join(home, '.claude.json'), join(claudeDir, 'settings.json'), join(worktree, '.git'), join(worktree, '.claude')],
  };
  return { root, paths: { worktree, sessionTmp, home, claudeDir, globalConfig: join(home, '.claude.json'), skills: [join(skills, 'implement')], executable }, denials, snapshot: skills };
}

// The wrapper's skills mounts: an empty tmpfs on mount, each folder read-only at mount/<its name>, the tmpfs read-only.
const skillsMounts = (mount: string, folders: string[]): string[] => [
  '--tmpfs', mount, ...folders.flatMap((folder) => ['--ro-bind', folder, join(mount, folder.split('/').at(-1)!)]), '--remount-ro', mount,
];

test('the wrapper\'s arguments: the read-only root, the hidden entries but the CLI\'s own, the installation, the read-write binds, the fix-up pass, then .git, the agent configuration and the user settings read-only again, and last the Implementer\'s skills read-only in <config dir>/skills', async () => {
  const { paths, denials, snapshot } = await fixture('wrapper-args');
  const { home, claudeDir, worktree, sessionTmp, executable } = paths;
  const nodePrefix = dirname(dirname(realpathSync(process.execPath)));
  const native = join(home, '.local', 'share', 'claude');
  const written = CLAUDE_WRITTEN.map((name) => join(claudeDir, name));
  // A denial under /tmp (the test's files usually are) is hidden by the private /tmp already.
  const hide = (mount: string[]): string[] => (within(mount.at(-1)!, '/tmp') ? [] : mount);
  assert.deepEqual(implementerWrapper(denials, paths), [
    '--die-with-parent', '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    // Hidden: neither the credentials nor the global config nor the projects folder, which the CLI needs.
    ...hide(['--tmpfs', join(home, '.ssh')]), ...hide(['--tmpfs', join(home, '.local', 'share')]), ...hide(['--tmpfs', join(home, '.agents')]),
    ...hide(['--tmpfs', join(claudeDir, 'backups')]), ...hide(['--tmpfs', join(claudeDir, 'skills')]),
    ...hide(['--ro-bind', '/dev/null', join(claudeDir, 'settings.json')]), ...hide(['--ro-bind', '/dev/null', join(worktree, '.env')]),
    // The installation read-only: the executable, its folder, the native installer's folder, node's prefix.
    '--ro-bind', executable, executable, '--ro-bind', dirname(executable), dirname(executable), '--ro-bind', native, native, '--ro-bind', nodePrefix, nodePrefix,
    // Read-write: the worktree, the session's tmp, the state folders, the credentials, the global config.
    '--bind', worktree, worktree, '--bind', sessionTmp, sessionTmp, ...written.flatMap((dir) => ['--bind', dir, dir]),
    '--bind', join(claudeDir, '.credentials.json'), join(claudeDir, '.credentials.json'), '--bind', join(home, '.claude.json'), join(home, '.claude.json'),
    // The fix-up pass: the worktree's .env hidden again.
    '--ro-bind', '/dev/null', join(worktree, '.env'),
    // Read-only again: the worktree's .git and .claude, then the user settings.
    '--ro-bind', join(worktree, '.git'), join(worktree, '.git'), '--ro-bind', join(worktree, '.claude'), join(worktree, '.claude'),
    '--ro-bind', join(claudeDir, 'settings.json'), join(claudeDir, 'settings.json'),
    // Last, over the tmpfs that hid the user's skills: an empty one with the chosen skill of the snapshot, read-only.
    '--tmpfs', join(claudeDir, 'skills'), '--ro-bind', join(snapshot, 'implement'), join(claudeDir, 'skills', 'implement'), '--remount-ro', join(claudeDir, 'skills'),
  ]);
});

test('the skills binds: in <config dir>/skills when it is a folder, made by prepareClaudeState when missing, in the real path of a link; the snapshot\'s link resolved; only the chosen skills; none through a dangling link', async () => {
  const { root, paths, denials, snapshot } = await fixture('wrapper-skills');
  const implement = [join(snapshot, 'implement')];
  const last = (args: string[], count = implement.length): string[] => args.slice(-(4 + 3 * count));
  // A folder (the user's links live in it).
  assert.deepEqual(last(implementerWrapper(denials, paths)), skillsMounts(join(paths.claudeDir, 'skills'), implement));
  // Missing: made empty first, so bwrap has its mount point.
  const fresh = join(root, 'fresh', '.claude');
  await prepareClaudeState(fresh, join(root, 'fresh', '.claude.json'));
  assert.ok((await stat(join(fresh, 'skills'))).isDirectory());
  assert.deepEqual(last(implementerWrapper(denials, { ...paths, claudeDir: fresh })), skillsMounts(join(fresh, 'skills'), implement));
  // A link (to ~/.agents/skills, which the home's tmpfs hides): in its real path, the path the CLI reaches.
  const linked = join(root, 'linked', '.claude');
  await mkdir(linked, { recursive: true });
  await symlink(join(paths.home, '.agents', 'skills'), join(linked, 'skills'));
  await prepareClaudeState(linked, join(root, 'linked', '.claude.json'));
  assert.deepEqual(last(implementerWrapper(denials, { ...paths, claudeDir: linked })), skillsMounts(join(paths.home, '.agents', 'skills'), implement));
  // The snapshot is a link to its current folder: the folder is bound, so a later swap leaves this session's as it is.
  const link = join(root, 'state', 'skills');
  await mkdir(dirname(link), { recursive: true });
  await symlink(snapshot, link);
  assert.deepEqual(last(implementerWrapper(denials, { ...paths, skills: [join(link, 'implement')] })), skillsMounts(join(paths.claudeDir, 'skills'), implement));
  // The Implementer with [tdd] only: tdd alone is bound, implement is not.
  const tdd = implementerWrapper(denials, { ...paths, skills: [join(link, 'tdd')] });
  assert.deepEqual(last(tdd), skillsMounts(join(paths.claudeDir, 'skills'), [join(snapshot, 'tdd')]));
  assert.ok(!tdd.includes(join(snapshot, 'implement')));
  // No skills, or none of them in the snapshot: the empty, read-only tmpfs alone, so no skill of the user's is seen.
  assert.deepEqual(last(implementerWrapper(denials, { ...paths, skills: [] }), 0), skillsMounts(join(paths.claudeDir, 'skills'), []));
  assert.deepEqual(last(implementerWrapper(denials, { ...paths, skills: [join(root, 'none', 'implement')] }), 0), skillsMounts(join(paths.claudeDir, 'skills'), []));
  // A dangling link (prepareClaudeState leaves it): no mount there, the job shows skill_missing.
  const dangling = join(root, 'dangling', '.claude');
  await mkdir(dangling, { recursive: true });
  await symlink(join(root, 'nowhere'), join(dangling, 'skills'));
  await prepareClaudeState(dangling, join(root, 'dangling', '.claude.json'));
  assert.ok(!implementerWrapper(denials, { ...paths, claudeDir: dangling }).includes(join(snapshot, 'implement')));
});

test('the private /tmp (SF-185): --tmpfs /tmp after the read-only root and before every bind of a path under /tmp; a denial under /tmp is not mounted, but one inside the session\'s tmp is hidden again on top of its bind; one outside /tmp is hidden', async () => {
  const { paths } = await fixture('wrapper-private-tmp');
  // The session's tmp under /tmp, as the factory makes it; mountPoint resolves a missing one as is.
  const sessionTmp = '/tmp/sf-claude-185-x';
  const inside = join(paths.sessionTmp, 'denied');
  await mkdir(inside);
  const args = implementerWrapper({ denyRead: ['/etc', '/tmp/sf-185-other'], denyWrite: [] }, { ...paths, sessionTmp });
  const tmpfs = args.findIndex((arg, index) => arg === '/tmp' && args[index - 1] === '--tmpfs');
  assert.deepEqual(args.slice(0, tmpfs + 1), ['--die-with-parent', '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp']);
  // /tmp's tmpfs once, and before every --bind or --ro-bind of a path under /tmp.
  assert.deepEqual(args.flatMap((arg, index) => (arg === '/tmp' ? [args[index - 1]] : [])), ['--tmpfs']);
  const bindsUnderTmp = args.flatMap((arg, index) => ((arg === '--bind' || arg === '--ro-bind') && within(args[index + 2]!, '/tmp') ? [index] : []));
  assert.ok(bindsUnderTmp.includes(args.indexOf(sessionTmp) - 1), args.join(' '));
  assert.ok(bindsUnderTmp.every((index) => index > tmpfs), args.join(' '));
  assert.ok(!args.includes('/tmp/sf-185-other'), args.join(' '));
  assert.ok(args.join(' ').includes('--tmpfs /etc'), args.join(' '));
  // The fixture's own session tmp, when under /tmp: a denial inside it is hidden again after its bind.
  const own = implementerWrapper({ denyRead: [inside], denyWrite: [] }, paths);
  assert.ok(own.lastIndexOf(inside) > own.indexOf(paths.sessionTmp), own.join(' '));
  assert.equal(own[own.lastIndexOf(inside) - 1], '--tmpfs');
});

test('the wrapper never binds the Git directory or a denied path read-write, and never shows ~/.ssh again', async () => {
  const { paths, denials } = await fixture('wrapper-never');
  const args = implementerWrapper(denials, paths);
  const writable = args.flatMap((arg, index) => (arg === '--bind' ? [args[index + 2]!] : []));
  assert.ok(!writable.includes(join(paths.worktree, '.git')), JSON.stringify(writable));
  assert.ok(!writable.includes(join(paths.claudeDir, 'settings.json')));
  assert.ok(!writable.some((path) => path === paths.home || path === paths.claudeDir || path === '/'));
  // A denial that holds the worktree (its bind comes back in the fix-up pass): .git is still read-only last.
  const git = join(paths.worktree, '.git');
  const held = implementerWrapper({ ...denials, denyRead: [...denials.denyRead, dirname(paths.worktree)] }, paths);
  const lastBind = held.lastIndexOf(paths.worktree) - 2;
  assert.equal(held[lastBind], '--bind');
  assert.ok(held.slice(lastBind).join(' ').includes(`--ro-bind ${git} ${git}`), held.join(' '));
  // ~/.ssh is named once: by the tmpfs that hides it; under /tmp not at all (the private /tmp hides it).
  const ssh = join(paths.home, '.ssh');
  assert.deepEqual(args.flatMap((arg, index) => (arg === ssh ? [args[index - 1]] : [])), within(ssh, '/tmp') ? [] : ['--tmpfs']);
});

test('prepareClaudeState: the state folders, and the credentials and global config as {} (mode 0600) when missing; existing ones stay as they are; the wrapper binds both read-write', async () => {
  const root = join(await realpath(temp), 'wrapper-prepare');
  const claudeDir = join(root, 'home', '.claude');
  const globalConfig = join(root, 'home', '.claude.json');
  await mkdir(join(root, 'home'), { recursive: true });
  await prepareClaudeState(claudeDir, globalConfig);
  for (const name of CLAUDE_WRITTEN) {
    assert.ok(existsSync(join(claudeDir, name)), name);
  }
  for (const file of [join(claudeDir, '.credentials.json'), globalConfig]) {
    assert.equal(await readFile(file, 'utf8'), '{}');
    assert.equal((await stat(file)).mode & 0o777, 0o600, file);
  }
  await writeFile(globalConfig, '{"numStartups":3}');
  await prepareClaudeState(claudeDir, globalConfig);
  assert.equal(await readFile(globalConfig, 'utf8'), '{"numStartups":3}');
  const args = implementerWrapper({ denyRead: [], denyWrite: [] }, {
    worktree: root, sessionTmp: root, home: join(root, 'home'), claudeDir, globalConfig, skills: [join(root, 'skills', 'implement')], executable: '/bin/sh',
  }).join(' ');
  for (const file of [join(claudeDir, '.credentials.json'), globalConfig]) {
    assert.ok(args.includes(`--bind ${file} ${file}`), args);
  }
});

test('claudeExecutable: the script after node, else the command', () => {
  assert.equal(claudeExecutable({ command: 'node', args: ['/opt/claude/cli.js', '--verbose'] }), '/opt/claude/cli.js');
  assert.equal(claudeExecutable({ command: '/home/u/.local/bin/claude', args: ['--verbose'] }), '/home/u/.local/bin/claude');
});

// Runs one Implementer turn with the sandbox on, HOME the test's and the skills snapshot of its
// state directory (synced from the harness's fake source); resolves with its outcome.
async function oneTurn(env: Awaited<ReturnType<typeof newEnv>>, path: string, seen: string[] = [], configDir?: string): Promise<IdleOutcome> {
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  Object.assign(process.env, { HOME: env.home, PATH: path });
  if (configDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = configDir;
  }
  try {
    await syncSkills(env.state);
    return await new Promise<IdleOutcome>((resolve) => {
      new ImplementerSession({ cwd: join(env.home, 'work'), maxTurns: 3, claudePath: FAKE, sandbox: sandboxSettings({}), skills: () => implementerSkills(env.state) }, {
        message: async (message) => void seen.push('subtype' in message ? `${message.type}/${message.subtype}` : message.type),
        prompt: async () => undefined, idle: async (outcome) => resolve(outcome),
      }).send('go', []);
    });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test('spawnClaudeCodeProcess: the command, its argv, cwd and environment reach Claude Code unchanged, after the wrapper and "--" in the fake bwrap', async () => {
  const env = await newEnv('wrapper-spawn');
  await mkdir(join(env.home, 'work'), { recursive: true });
  await script(env, [{}]);
  useFakeBwrap();
  const outcome = await oneTurn(env, process.env.PATH!);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const [run] = await bwrapLog(env, { implementer: true });
  const [logged] = await fakeLog(env);
  const cut = run!.argv.indexOf('--');
  // The SDK starts the fake (a script) with node: its argv after it is the CLI's whole argv.
  assert.deepEqual(run!.argv.slice(cut + 1, cut + 3), ['node', FAKE]);
  assert.deepEqual(run!.argv.slice(cut + 3), logged!.argv);
  assert.deepEqual(run!.argv.slice(cut - 2, cut), ['--chdir', join(env.home, 'work')]);
  assert.equal(logged!.cwd, join(env.home, 'work'));
  assert.ok(logged!.env.includes('CLAUDE_CODE_TMPDIR') && logged!.env.includes('HOME'), JSON.stringify(logged!.env));
  assert.deepEqual(run!.argv.slice(0, 2), ['--die-with-parent', '--unshare-pid']);
  // Claude Code's state folders, its credentials and its global config were made before the wrapper started.
  for (const path of [...CLAUDE_WRITTEN.map((name) => join(env.home, '.claude', name)), join(env.home, '.claude', '.credentials.json'), join(env.home, '.claude.json')]) {
    assert.ok(existsSync(path), path);
  }
  // The Implementer's skills (every default) in the snapshot's current folder (the link resolved), read-only in
  // ~/.claude/skills, the last mounts before the chdir.
  const snapshot = realpathSync(skillsSnapshot(env.state));
  assert.ok(within(snapshot, join(env.state, 'skills.d')) && existsSync(join(snapshot, 'implement', 'SKILL.md')), snapshot);
  const chosen = ['implement', 'tdd', 'code-review', 'grilling'].map((name) => join(snapshot, name));
  assert.deepEqual(run!.argv.slice(cut - 18, cut - 2), skillsMounts(join(env.home, '.claude', 'skills'), chosen));
});

test('with CLAUDE_CONFIG_DIR set, the skills snapshot is bound read-only on <CLAUDE_CONFIG_DIR>/skills', async () => {
  const env = await newEnv('wrapper-config-dir');
  await mkdir(join(env.home, 'work'), { recursive: true });
  await script(env, [{}]);
  useFakeBwrap();
  const configDir = join(env.home, 'claude-config');
  const outcome = await oneTurn(env, process.env.PATH!, [], configDir);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const [run] = await bwrapLog(env, { implementer: true });
  const cut = run!.argv.indexOf('--');
  const chosen = ['implement', 'tdd', 'code-review', 'grilling'].map((name) => join(realpathSync(skillsSnapshot(env.state)), name));
  assert.deepEqual(run!.argv.slice(cut - 18, cut - 2), skillsMounts(join(configDir, 'skills'), chosen));
  assert.ok(existsSync(join(configDir, 'skills')));
});

test('no bwrap on PATH: the turn ends with sandbox_unavailable and its message, and Claude Code never starts', async () => {
  const env = await newEnv('wrapper-missing');
  await mkdir(join(env.home, 'work'), { recursive: true });
  await mkdir(join(env.home, 'empty-bin'));
  await script(env, [{}]);
  const outcome = await oneTurn(env, join(env.home, 'empty-bin'));
  assert.deepEqual(outcome.ok ? outcome : { code: outcome.code, message: outcome.message }, { code: 'sandbox_unavailable', message: BWRAP_MISSING });
  assert.equal(existsSync(join(env.home, 'fake-claude.log')), false);
});

test('a bwrap that exits 1 before Claude Code answers: the turn ends with sandbox_unavailable and bwrap\'s first error line, redacted, and Claude Code never starts', async () => {
  const env = await newEnv('wrapper-fails');
  await mkdir(join(env.home, 'work'), { recursive: true });
  const bin = join(env.home, 'failing-bin');
  await mkdir(bin);
  // Its first line names a value of the factory's environment, which the message must not show.
  await writeFile(join(bin, 'bwrap'), '#!/bin/sh\necho "bwrap: Can\'t mount tmpfs on /x/wrapper-secret-1234: Operation not permitted" >&2\necho "second line" >&2\nexit 1\n');
  await chmod(join(bin, 'bwrap'), 0o755);
  await script(env, [{}]);
  process.env.SF_TEST_WRAPPER_SECRET_VALUE = 'wrapper-secret-1234';
  try {
    const outcome = await oneTurn(env, `${bin}:${process.env.PATH ?? ''}`);
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.ok ? undefined : [outcome.code, outcome.message], ['sandbox_unavailable', 'bwrap: Can\'t mount tmpfs on /x/[redacted:SF_TEST_WRAPPER_SECRET_VALUE]: Operation not permitted']);
  } finally {
    delete process.env.SF_TEST_WRAPPER_SECRET_VALUE;
  }
  assert.equal(existsSync(join(env.home, 'fake-claude.log')), false);
});

test('a bwrap that exits 1 after Claude Code\'s init but before its result: the turn still ends with sandbox_unavailable and bwrap\'s first error line', async () => {
  const env = await newEnv('wrapper-fails-after-init');
  await mkdir(join(env.home, 'work'), { recursive: true });
  const bin = join(env.home, 'cut-bin');
  await mkdir(bin);
  // The fake Claude Code runs, but its output is cut after its system/init line: then it is killed,
  // bwrap's error line follows and bwrap exits 1, as a wrapper that dies under a running Claude Code.
  await writeFile(join(bin, 'bwrap'), [
    `#!${process.execPath}`,
    "import { spawn } from 'node:child_process';",
    "import { createInterface } from 'node:readline';",
    "const argv = process.argv.slice(process.argv.indexOf('--') + 1);",
    "const child = spawn(argv[0], argv.slice(1), { stdio: ['inherit', 'pipe', 'inherit'] });",
    'for await (const line of createInterface({ input: child.stdout })) {',
    "  process.stdout.write(`${line}\\n`);",
    '  if (/"subtype":"init"/.test(line)) {',
    "    child.kill('SIGKILL');",
    "    process.stderr.write('bwrap: the wrapper went away\\n', () => process.exit(1));",
    '    break;',
    '  }',
    '}',
    '',
  ].join('\n'));
  await chmod(join(bin, 'bwrap'), 0o755);
  await script(env, [{}]);
  const seen: string[] = [];
  const outcome = await oneTurn(env, `${bin}:${process.env.PATH ?? ''}`, seen);
  assert.ok(seen.includes('system/init') && !seen.includes('result/success'), JSON.stringify(seen));
  assert.deepEqual(outcome.ok ? outcome : [outcome.code, outcome.message], ['sandbox_unavailable', 'bwrap: the wrapper went away']);
});

// Whether the real bwrap starts a wrapper like the Implementer's here (not inside another sandbox).
// The real bwrap, found when this file loads: a test above puts the fake one first on this process's PATH.
const REAL_BWRAP = findBwrap();

function realBwrapStarts(): boolean {
  if (REAL_BWRAP === undefined) {
    return false;
  }
  const probe = spawnSync(REAL_BWRAP, ['--die-with-parent', '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', 'true'], { stdio: 'ignore', timeout: 30_000 });
  return probe.status === 0;
}

test('under the real bwrap with the wrapper: a write in the home outside the allowed set, through a link out of the worktree, to ~/.claude/settings.json and to the worktree\'s .git fails; the worktree, the tmp and ~/.claude/projects take one; a file and a Unix socket in the private /tmp are made there and never reach the host\'s /tmp, whose entries are not seen; <config dir>/skills/implement/SKILL.md is the snapshot\'s, read-only, and neither the user\'s skills nor ~/.agents are seen', { skip: process.platform === 'linux' && realBwrapStarts() ? false : 'the real bubblewrap cannot start here' }, async () => {
  const { root, paths, denials, snapshot } = await fixture('wrapper-real');
  await mkdir(join(root, 'home', 'elsewhere'));
  await symlink(join(root, 'home', 'elsewhere'), join(paths.worktree, 'out'));
  // The fixture is under /tmp when the test's temporary folder is (the usual case): then its home is
  // in the private /tmp, where a write lands in the session's tmpfs, never in the host's home, and a
  // host file next to it is not seen.
  const underTmp = within(root, '/tmp');
  const hostOnly = join(root, 'host-only.txt');
  await writeFile(hostOnly, 'host\n');
  const tmpFile = `/tmp/sf-185-${process.pid}.txt`;
  const tmpSocket = `/tmp/sf-185-${process.pid}.sock`;
  const listen = `require('node:net').createServer().listen('${tmpSocket}', () => process.exit(require('node:fs').statSync('${tmpSocket}').isSocket() ? 0 : 1))`;
  const checks: Record<string, string> = {
    home: `echo x > '${join(paths.home, 'outside.txt')}'`,
    link: `echo x > '${join(paths.worktree, 'out', 'escaped.txt')}'`,
    settings: `echo x > '${join(paths.claudeDir, 'settings.json')}'`,
    git: `echo x >> '${join(paths.worktree, '.git')}'`,
    ssh: `cat '${join(paths.home, '.ssh', 'id_ed25519')}'`,
    worktree: `echo x > '${join(paths.worktree, 'ok.txt')}'`,
    tmp: `echo x > '${join(paths.sessionTmp, 'ok.txt')}'`,
    projects: `echo x > '${join(paths.claudeDir, 'projects', 'ok.txt')}'`,
    tmpFile: `echo x > '${tmpFile}' && test -f '${tmpFile}'`,
    tmpSocket: `'${process.execPath}' -e "${listen}"`,
    skillRead: `grep -qx "the factory's implement" '${join(paths.claudeDir, 'skills', 'implement', 'SKILL.md')}'`,
    skillWrite: `echo x > '${join(paths.claudeDir, 'skills', 'implement', 'SKILL.md')}'`,
    userSkill: `cat '${join(paths.claudeDir, 'skills', 'mine', 'SKILL.md')}'`,
    // A skill of the snapshot the Implementer did not choose, and one it would add.
    otherSkill: `cat '${join(paths.claudeDir, 'skills', 'tdd', 'SKILL.md')}'`,
    skillAdd: `mkdir '${join(paths.claudeDir, 'skills', 'added')}'`,
    agents: `ls '${join(paths.home, '.agents', 'skills')}'`,
    ...(underTmp ? { hostTmp: `cat '${hostOnly}'` } : {}),
  };
  const body = Object.entries(checks).map(([name, command]) => `if ${command} 2>/dev/null; then echo ${name}:ok; else echo ${name}:refused; fi`).join('\n');
  const ran = spawnSync(REAL_BWRAP!, [...implementerWrapper(denials, { ...paths, executable: '/bin/sh' }), '--chdir', paths.worktree, '--', '/bin/sh', '-c', body], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.stdout.trim().split('\n'), [
    `home:${underTmp ? 'ok' : 'refused'}`, 'link:refused', 'settings:refused', 'git:refused', 'ssh:refused', 'worktree:ok', 'tmp:ok', 'projects:ok',
    'tmpFile:ok', 'tmpSocket:ok', 'skillRead:ok', 'skillWrite:refused', 'userSkill:refused', 'otherSkill:refused', 'skillAdd:refused', 'agents:refused',
    ...(underTmp ? ['hostTmp:refused'] : []),
  ]);
  assert.equal(await readFile(join(snapshot, 'implement', 'SKILL.md'), 'utf8'), "the factory's implement\n");
  assert.equal(existsSync(join(paths.home, 'outside.txt')), false);
  assert.equal(existsSync(join(root, 'home', 'elsewhere', 'escaped.txt')), false);
  assert.equal(await readFile(join(paths.claudeDir, 'settings.json'), 'utf8'), '{}');
  assert.equal(await readFile(join(paths.worktree, '.git'), 'utf8'), 'gitdir: /nowhere\n');
  assert.equal(await readFile(join(paths.claudeDir, 'projects', 'ok.txt'), 'utf8'), 'x\n');
  // The session's tmp is the host folder, bound on top of the private /tmp.
  assert.equal(await readFile(join(paths.sessionTmp, 'ok.txt'), 'utf8'), 'x\n');
  assert.equal(existsSync(tmpFile), false);
  assert.equal(existsSync(tmpSocket), false);
});
