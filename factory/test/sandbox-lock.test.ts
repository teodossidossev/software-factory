// staleSandboxLock and removeStaleSandboxLock (SF-085) on a temporary Git directory: only an empty,
// read-only config.lock that no process has open is the sandbox's leftover.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkoutGitDir, removeStaleSandboxLock, staleSandboxLock } from '../src/sandbox-lock.js';

async function gitDir(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'sf-sandbox-lock-')), '.git');
  await mkdir(dir);
  return dir;
}

async function lock(dir: string, content: string, mode: number): Promise<string> {
  const path = join(dir, 'config.lock');
  await writeFile(path, content);
  await chmod(path, mode);
  return path;
}

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

test('staleSandboxLock: an empty read-only config.lock is stale, and removeStaleSandboxLock removes it', async () => {
  const dir = await gitDir();
  const path = await lock(dir, '', 0o444);
  assert.equal(await staleSandboxLock(dir), true);
  assert.equal(await removeStaleSandboxLock(dir), path);
  assert.equal(await exists(path), false);
  // Nothing left: not stale, nothing removed.
  assert.equal(await staleSandboxLock(dir), false);
  assert.equal(await removeStaleSandboxLock(dir), undefined);
});

test('staleSandboxLock: a non-empty lock, a writable one, or one on another platform is not stale and stays', async () => {
  const nonEmpty = await gitDir();
  const kept = await lock(nonEmpty, '[core]\n', 0o444);
  assert.equal(await staleSandboxLock(nonEmpty), false);
  assert.equal(await removeStaleSandboxLock(nonEmpty), undefined);
  assert.equal(await exists(kept), true);
  for (const mode of [0o644, 0o200, 0o420, 0o402]) {
    const writable = await gitDir();
    const path = await lock(writable, '', mode);
    assert.equal(await staleSandboxLock(writable), false, `mode ${mode.toString(8)}`);
    assert.equal(await removeStaleSandboxLock(writable), undefined);
    assert.equal(await exists(path), true);
  }
  const elsewhere = await gitDir();
  await lock(elsewhere, '', 0o444);
  assert.equal(await staleSandboxLock(elsewhere, { platform: 'darwin' }), false);
});

test('staleSandboxLock: a lock a child process holds open is not stale; once it exits, it is', async () => {
  const dir = await gitDir();
  const path = await lock(dir, '', 0o444);
  const fd = openSync(path, 'r');
  // The child holds the lock as its stdin; this process closes its own descriptor.
  const child = spawn('sleep', ['30'], { stdio: [fd, 'ignore', 'ignore'] });
  closeSync(fd);
  try {
    assert.equal(await staleSandboxLock(dir), false);
    assert.equal(await removeStaleSandboxLock(dir), undefined);
    assert.equal(await exists(path), true);
  } finally {
    child.kill();
    await once(child, 'exit');
  }
  assert.equal(await staleSandboxLock(dir), true);
});

test('checkoutGitDir: the Git directory holding the config, a worktree\'s main checkout\'s', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-sandbox-lock-repo-'));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'initial']);
  assert.equal(await checkoutGitDir(repo), join(repo, '.git'));
  const worktree = join(root, 'wt');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', worktree]);
  assert.equal(await checkoutGitDir(worktree), join(repo, '.git'));
});

// A /proc of the test's own: pid directories with fd links, unreadable ones, or none.
async function fakeProc(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sf-fake-proc-'));
}

test('staleSandboxLock fails closed on /proc: a descriptor link to the lock, an unreadable fd directory of the factory\'s user, or no /proc at all keep the lock; processes gone during the scan do not', async () => {
  const dir = await gitDir();
  const path = await lock(dir, '', 0o444);
  const real = await realpath(path);

  // Processes without the lock open, one gone (no fd directory): stale.
  const proc = await fakeProc();
  await mkdir(join(proc, '100', 'fd'), { recursive: true });
  await symlink('/dev/null', join(proc, '100', 'fd', '0'));
  await mkdir(join(proc, '101'));
  await mkdir(join(proc, 'self'));
  assert.equal(await staleSandboxLock(dir, { proc }), true);

  // A descriptor link to the lock: open.
  const holding = await fakeProc();
  await mkdir(join(holding, '200', 'fd'), { recursive: true });
  await symlink(real, join(holding, '200', 'fd', '7'));
  assert.equal(await staleSandboxLock(dir, { proc: holding }), false);

  // No /proc to read: open, as far as the factory can tell.
  assert.equal(await staleSandboxLock(dir, { proc: join(proc, 'missing') }), false);
  assert.equal(await removeStaleSandboxLock(dir, { proc: join(proc, 'missing') }), undefined);
  assert.equal(await exists(path), true);

  // An fd directory of the factory's own user that cannot be read (as for a non-dumpable process).
  if (process.getuid?.() !== 0) {
    const hidden = await fakeProc();
    await mkdir(join(hidden, '300', 'fd'), { recursive: true });
    await chmod(join(hidden, '300', 'fd'), 0o000);
    try {
      assert.equal(await staleSandboxLock(dir, { proc: hidden }), false);
      assert.equal(await removeStaleSandboxLock(dir, { proc: hidden }), undefined);
      assert.equal(await exists(path), true);
    } finally {
      await chmod(join(hidden, '300', 'fd'), 0o700);
    }
  }
});
