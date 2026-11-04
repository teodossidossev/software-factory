// Unit tests for the removal of the sandbox's placeholder files and the shared predicate, also
// as used by changedPaths and the factory's commit at Clean.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { commitPaths } from '../src/mr.js';
import { changedPaths } from '../src/patch.js';
import { isPlaceholder, removeSandboxPlaceholders } from '../src/placeholders.js';

// The set observed on 2026-11-02 in a real job.
const OBSERVED = [
  '.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.mcp.json',
  '.claude/agents', '.claude/commands', '.claude/hooks', '.claude/launch.json', '.claude/loop.md',
  '.claude/output-styles', '.claude/routines', '.claude/scheduled_tasks.json', '.claude/settings.json',
  '.claude/settings.local.json', '.claude/skills', '.claude/workflows',
];

let temp: string;
let count = 0;

before(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'sf-placeholders-')));
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

async function dir(): Promise<string> {
  count += 1;
  const path = join(temp, `case-${count}`);
  await mkdir(path);
  return path;
}

async function placeholder(cwd: string, path: string): Promise<void> {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), '');
  await chmod(join(cwd, path), 0o444);
}

async function ccWrites(cwd: string): Promise<void> {
  await mkdir(join(cwd, '.claude', '.cc-writes'), { recursive: true, mode: 0o700 });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

test('the observed set, .claude/.cc-writes and .claude itself are removed and listed sorted', async () => {
  const cwd = await dir();
  for (const path of OBSERVED) {
    await placeholder(cwd, path);
  }
  await ccWrites(cwd);
  await writeFile(join(cwd, 'README.md'), 'hello\n');
  const removed = await removeSandboxPlaceholders(cwd);
  assert.deepEqual(removed, [...OBSERVED, '.claude', '.claude/.cc-writes'].sort());
  assert.deepEqual(await readdir(cwd), ['README.md']);
  // Nothing left to do the second time.
  assert.deepEqual(await removeSandboxPlaceholders(cwd), []);
});

test('real files survive: content, a writable empty file, other modes, a symlink, names outside the rule', async () => {
  const cwd = await dir();
  await mkdir(join(cwd, '.claude'));
  await writeFile(join(cwd, '.claude', 'settings.json'), '{"permissions":{}}\n');
  await writeFile(join(cwd, '.gitmodules'), '[submodule "x"]\n');
  await chmod(join(cwd, '.gitmodules'), 0o444);
  await writeFile(join(cwd, '.mcp.json'), '{}\n');
  // Empty but writable, or with another read-only mode.
  await writeFile(join(cwd, '.bashrc'), '');
  await writeFile(join(cwd, '.zshrc'), '');
  await chmod(join(cwd, '.zshrc'), 0o400);
  await writeFile(join(cwd, '.idea'), '');
  await chmod(join(cwd, '.idea'), 0o555);
  // A symbolic link to a placeholder-like file is never followed or removed.
  await placeholder(cwd, 'target');
  await symlink('target', join(cwd, '.gitconfig'));
  await symlink('../target', join(cwd, '.claude', 'hooks'));
  // Zero-byte 0444 files outside the rule: no leading dot in the root, or deeper than .claude/.
  await placeholder(cwd, 'visible');
  await placeholder(cwd, 'src/.bashrc');
  await placeholder(cwd, '.claude/skills/x/.bashrc');
  // The one real placeholder among them.
  await placeholder(cwd, '.vscode');

  assert.deepEqual(await removeSandboxPlaceholders(cwd), ['.vscode']);
  for (const path of ['.claude/settings.json', '.gitmodules', '.mcp.json', '.bashrc', '.zshrc', '.idea', 'target', '.gitconfig', '.claude/hooks', 'visible', 'src/.bashrc', '.claude/skills/x/.bashrc']) {
    assert.ok(await exists(join(cwd, path)), path);
  }
  assert.equal(await readFile(join(cwd, '.claude', 'settings.json'), 'utf8'), '{"permissions":{}}\n');
  assert.equal(await isPlaceholder(cwd, 'target'), false);
  assert.equal(await isPlaceholder(cwd, '.gitconfig'), false);
  assert.equal(await isPlaceholder(cwd, 'src/.bashrc'), false);
});

test('a non-empty .claude/ keeps its content; .cc-writes with content stays', async () => {
  const cwd = await dir();
  await placeholder(cwd, '.claude/settings.json');
  await placeholder(cwd, '.claude/agents');
  await mkdir(join(cwd, '.claude', 'commands'));
  await writeFile(join(cwd, '.claude', 'commands', 'implement.md'), 'Implement.\n');
  await ccWrites(cwd);
  await writeFile(join(cwd, '.claude', '.cc-writes', 'pending'), 'x');
  assert.deepEqual(await removeSandboxPlaceholders(cwd), ['.claude/agents', '.claude/settings.json']);
  assert.deepEqual((await readdir(join(cwd, '.claude'))).sort(), ['.cc-writes', 'commands']);

  // An empty directory other than .cc-writes keeps .claude alive.
  const other = await dir();
  await mkdir(join(other, '.claude', 'skills'), { recursive: true });
  await ccWrites(other);
  assert.deepEqual(await removeSandboxPlaceholders(other), ['.claude/.cc-writes']);
  assert.deepEqual(await readdir(join(other, '.claude')), ['skills']);
});

test('an absent .claude/, a .claude symlink and an absent cwd are no errors', async () => {
  const cwd = await dir();
  await placeholder(cwd, '.mcp.json');
  assert.deepEqual(await removeSandboxPlaceholders(cwd), ['.mcp.json']);
  assert.deepEqual(await removeSandboxPlaceholders(cwd), []);

  const linked = await dir();
  const real = await dir();
  await placeholder(real, 'settings.json');
  await symlink(real, join(linked, '.claude'));
  assert.deepEqual(await removeSandboxPlaceholders(linked), []);
  assert.ok(await exists(join(real, 'settings.json')));

  assert.deepEqual(await removeSandboxPlaceholders(join(temp, 'missing')), []);
  assert.equal(await isPlaceholder(join(temp, 'missing'), '.bashrc'), false);
});

test('errors other than "not found" are thrown', async () => {
  const cwd = await dir();
  await mkdir(join(cwd, '.claude'));
  await placeholder(cwd, '.claude/settings.json');
  await chmod(join(cwd, '.claude'), 0o000);
  try {
    // Running as root would read the directory anyway.
    if (process.getuid?.() !== 0) {
      await assert.rejects(removeSandboxPlaceholders(cwd), { code: 'EACCES' });
    }
  } finally {
    await chmod(join(cwd, '.claude'), 0o755);
  }
});

test('changedPaths and the commit paths at Clean skip an untracked placeholder, not a real change', async () => {
  const cwd = await dir();
  git(cwd, 'init', '-q', '-b', 'main');
  await writeFile(join(cwd, 'README.md'), 'hello\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'initial');
  const base = git(cwd, 'rev-parse', 'HEAD').trim();
  git(cwd, 'checkout', '-q', '-b', 'T-1-x');
  await writeFile(join(cwd, 'README.md'), 'hello world\n');
  git(cwd, 'commit', '-q', '-am', 'feat(T-1): Change the README');
  await placeholder(cwd, '.bashrc');
  await placeholder(cwd, '.claude/settings.json');
  await writeFile(join(cwd, '.prettierrc'), 'real\n');

  assert.deepEqual(await changedPaths(cwd, base), { tracked: ['README.md'], untracked: ['.prettierrc'] });
  assert.deepEqual(await commitPaths(cwd, base), ['.prettierrc', 'README.md']);
  await rm(join(cwd, '.prettierrc'));
  assert.deepEqual(await commitPaths(cwd, base), ['README.md']);
});
