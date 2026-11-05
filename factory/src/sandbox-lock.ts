// The config lock Claude Code's sandbox leaves in a checkout's Git directory (SF-085): to protect
// .git/config it binds an empty, read-only .git/config.lock into every sandboxed command, creating
// the file when it is missing and never removing it. Git then refuses every config write in that
// checkout (the hand-over's commit.template and commit.cleanup, the user's own git config). This
// module knows only the file system and Git; the Execution decides when no sandbox can be using it.
import { lstat, readdir, readlink, realpath, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runGit } from './git.js';

const CONFIG_LOCK = 'config.lock';

// The checkout's Git directory that holds its config: the common one (a worktree's config is its
// main checkout's).
export async function checkoutGitDir(checkout: string): Promise<string> {
  const result = await runGit(checkout, ['rev-parse', '--git-common-dir']);
  const dir = result.stdout.toString('utf8').trim();
  if (result.code !== 0 || dir === '') {
    throw new Error(`git rev-parse --git-common-dir failed in ${checkout}: ${result.stderr.trim().slice(0, 300)}`);
  }
  return resolve(checkout, dir);
}

// Where the open-file check looks (tests give their own): the /proc directory, and the users
// whose processes it must be able to see into.
export interface LockScan {
  platform?: NodeJS.Platform;
  proc?: string;
  // The factory's own user; default process.getuid().
  uid?: number;
}

// An error that proves a /proc entry gone during the scan (the process or the descriptor ended).
function gone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ESRCH';
}

// Whether any process may have path open: a link under <proc>/<pid>/fd that points at it. Fails
// closed: /proc unreadable, or a process of the factory's user or of the lock's owner (the
// sandbox and Git run as them) whose descriptors stay unreadable (permission, or any error other
// than the process or descriptor having gone meanwhile), counts as having it open. Processes of
// other users are skipped: an unprivileged user can never read their descriptors (pid 1 and every
// root daemon), so counting them would keep every lock forever; neither the sandbox nor Git runs
// as them.
async function mayBeOpen(path: string, owners: ReadonlySet<number>, proc: string): Promise<boolean> {
  let pids: string[];
  try {
    pids = (await readdir(proc)).filter((name) => /^\d+$/.test(name));
  } catch {
    return true;
  }
  for (const pid of pids) {
    // A process of the factory's user is unreadable for a moment while it execs or exits: looked
    // at again a few times before it counts as having the lock open.
    let answer = await processHolds(path, owners, join(proc, pid));
    for (let attempt = 0; answer === 'unreadable' && attempt < UNREADABLE_RETRIES; attempt += 1) {
      await sleep(UNREADABLE_PAUSE_MS);
      answer = await processHolds(path, owners, join(proc, pid));
    }
    if (answer !== 'no') {
      return true;
    }
  }
  return false;
}

// How often, and how far apart, an unreadable process of the factory's user is looked at again.
const UNREADABLE_RETRIES = 5;
const UNREADABLE_PAUSE_MS = 50;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Whether the process at dir has path open: yes (a link to it), no (none, the process gone, or an
// unreadable process of another user), or unreadable (its descriptors cannot be read and it is the
// factory's user's or the lock owner's, or its owner cannot be told).
async function processHolds(path: string, owners: ReadonlySet<number>, dir: string): Promise<'yes' | 'no' | 'unreadable'> {
  let fds: string[];
  try {
    fds = await readdir(join(dir, 'fd'));
  } catch (error) {
    if (gone(error)) {
      return 'no';
    }
    // Whose process it is decides whether its unreadable descriptors could hold the lock.
    const owner = await stat(dir).then((info): number | 'gone' | 'unknown' => info.uid, (statError: unknown) => (gone(statError) ? 'gone' : 'unknown'));
    if (owner === 'gone') {
      return 'no';
    }
    return owner === 'unknown' || owners.has(owner) ? 'unreadable' : 'no';
  }
  for (const fd of fds) {
    let target: string;
    try {
      target = await readlink(join(dir, 'fd', fd));
    } catch (error) {
      if (gone(error)) {
        continue;
      }
      return 'unreadable';
    }
    if (target === path) {
      return 'yes';
    }
  }
  return 'no';
}

// Whether gitDir's config.lock is the sandbox's leftover: a regular file, empty, without any write
// permission bit, and open in no process (mayBeOpen, which fails closed). Only on Linux (the
// factory's platform, where /proc says who has a file open); elsewhere, and when there is no lock,
// never.
export async function staleSandboxLock(gitDir: string, scan: LockScan = {}): Promise<boolean> {
  if ((scan.platform ?? process.platform) !== 'linux') {
    return false;
  }
  const path = join(gitDir, CONFIG_LOCK);
  let info;
  try {
    info = await lstat(path);
  } catch {
    return false;
  }
  if (!info.isFile() || info.size !== 0 || (info.mode & 0o222) !== 0) {
    return false;
  }
  const real = await realpath(path).catch(() => undefined);
  const owners = new Set([scan.uid ?? process.getuid?.() ?? info.uid, info.uid]);
  return real !== undefined && !(await mayBeOpen(real, owners, scan.proc ?? '/proc'));
}

// Removes gitDir's config.lock when it is the sandbox's leftover (staleSandboxLock); returns its
// path when it did, undefined when there was nothing stale to remove. The caller checks first that
// no running job of the workspace may be using it.
export async function removeStaleSandboxLock(gitDir: string, scan: LockScan = {}): Promise<string | undefined> {
  if (!(await staleSandboxLock(gitDir, scan))) {
    return undefined;
  }
  const path = join(gitDir, CONFIG_LOCK);
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  return path;
}
