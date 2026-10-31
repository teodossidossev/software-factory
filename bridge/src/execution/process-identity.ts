// Process identity on Linux: pid plus its start time and the boot id, so a
// recycled pid or a reboot is never mistaken for the original process. Used for
// the per-job lock and for finding a Claude session process by its session id.
import { randomUUID } from 'node:crypto';
import { link, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ExecutionError } from './errors.js';

export interface ProcessIdentity {
  pid: number;
  pid_start: string;
  boot_id: string;
}

async function bootId(): Promise<string> {
  try {
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  } catch {
    return 'unknown';
  }
}

// Field 22 of /proc/<pid>/stat (start time in clock ticks); undefined when the process does not exist.
async function startTime(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

export async function identify(pid: number): Promise<ProcessIdentity | undefined> {
  const start = await startTime(pid);
  return start === undefined ? undefined : { pid, pid_start: start, boot_id: await bootId() };
}

export async function isAlive(identity: Partial<ProcessIdentity>): Promise<boolean> {
  return (
    typeof identity.pid === 'number' &&
    identity.boot_id === (await bootId()) &&
    (await startTime(identity.pid)) === identity.pid_start
  );
}

// The subset of session ids that appear in the command line of a running process
// of this host (one /proc scan for all of them).
export async function sessionProcessesRunning(sessionIds: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (sessionIds.length === 0) return found;
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) {
      continue;
    }
    try {
      // Anywhere in an argument (--session-id <id>, --resume <id>, --resume=<id>), in any letter case.
      const argv = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).toLowerCase().split('\0');
      for (const id of sessionIds) if (argv.some((arg) => arg.includes(id.toLowerCase()))) found.add(id);
    } catch {
      // The process ended meanwhile.
    }
  }
  return found;
}

// True when any process of this host has the session id in its command line,
// i.e. a Claude session started with --session-id <id> is still running.
export async function sessionProcessRunning(sessionId: string): Promise<boolean> {
  return (await sessionProcessesRunning([sessionId])).has(sessionId);
}

interface LockContent extends ProcessIdentity {
  token: string;
}

type LockRead = { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'held'; holder: LockContent };

// A lock file is written completely before it appears, so anything unparsable is corrupt, not partial.
async function readLock(path: string): Promise<LockRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'corrupt' };
  }
  try {
    const value = JSON.parse(text) as Partial<LockContent> | null;
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof value.pid === 'number' &&
      typeof value.pid_start === 'string' &&
      typeof value.boot_id === 'string' &&
      typeof value.token === 'string' &&
      /^[A-Za-z0-9-]{1,64}$/.test(value.token)
    ) {
      return { kind: 'held', holder: value as LockContent };
    }
  } catch {
    // Falls through to corrupt.
  }
  return { kind: 'corrupt' };
}

// Read-only: the process a lock file in dir names (pid, start time, boot id; never its token), or
// undefined when there is none or it is unreadable. Whether it still runs is isAlive's question.
export async function lockHolder(dir: string): Promise<ProcessIdentity | undefined> {
  const current = await readLock(join(dir, 'execution.lock'));
  return current.kind === 'held' ? { pid: current.holder.pid, pid_start: current.holder.pid_start, boot_id: current.holder.boot_id } : undefined;
}

// Exclusive per-job lock held by one live process (pid, start time and boot id).
// The lock file is written completely before it appears (temp file + link).
// A stale lock (its holder is gone) is replaced without ever removing the lock
// path: the contender first creates the exclusive marker
// .execution.lock.takeover-<stale token>, so exactly one contender may replace
// that particular stale lock, checks that the path still holds it, and then
// renames its own complete lock file over it (atomic). A live, corrupt or
// already-being-replaced lock is never touched: the caller fails closed.
export async function acquireLock(dir: string, label: string): Promise<() => Promise<void>> {
  const path = join(dir, 'execution.lock');
  const self = await identify(process.pid);
  const token = randomUUID();
  const temp = join(dir, `.execution.lock.${token}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ ...self, token }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const release = async () => {
    const current = await readLock(path);
    // Only this process can replace its own live lock, so the check cannot go stale before the unlink.
    if (current.kind === 'held' && current.holder.token === token) {
      await unlink(path).catch(() => undefined);
    }
  };
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await link(temp, path);
        return release;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
      const current = await readLock(path);
      if (current.kind === 'missing') {
        continue;
      }
      if (current.kind === 'corrupt') {
        throw new ExecutionError(
          'locked',
          `${label}: the lock file is corrupt. Make sure no adapter process is running, then remove it by hand (see the runbook).`,
        );
      }
      if (await isAlive(current.holder)) {
        throw new ExecutionError('locked', `${label} is being handled by another adapter process (pid ${current.holder.pid}).`);
      }
      const marker = join(dir, `.execution.lock.takeover-${current.holder.token}`);
      try {
        await (await open(marker, 'wx', 0o600)).close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new ExecutionError(
            'locked',
            `${label}: another process is replacing a stale lock. If none is running, remove the takeover marker by hand (see the runbook).`,
          );
        }
        throw error;
      }
      try {
        const again = await readLock(path);
        if (again.kind !== 'held' || again.holder.token !== current.holder.token) {
          continue;
        }
        await rename(temp, path);
        return release;
      } finally {
        await rm(marker, { force: true });
      }
    }
    throw new ExecutionError('locked', `${label}: the execution lock could not be taken.`);
  } finally {
    await rm(temp, { force: true });
  }
}
