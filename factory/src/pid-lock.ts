// Locks between the factory's processes (SF-042: sf serve and the job runners): a file holding the
// pid of its owner and, where /proc tells it, the owner's start time, so a pid reused by another
// process is not taken for the owner. The file is created atomically, as a hard link of a complete
// temp file, so it is never seen empty. A lock whose owner is no longer alive is stale and is taken
// over.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { FactoryError } from './errors.js';

// Whether a process with this pid exists (EPERM: it exists but belongs to someone else).
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// The start time of a process in clock ticks since boot (field 22 of /proc/<pid>/stat); undefined
// where there is no /proc or no such process.
function startTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

// What this process writes into a lock it takes.
function ownerText(): string {
  const start = startTime(process.pid);
  return `${process.pid}${start !== undefined ? ` ${start}` : ''}\n`;
}

interface Owner {
  pid: number;
  start: string | undefined;
}

// The lock file's text; undefined when there is no file.
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

// The owner a lock file's text names; undefined when it names no pid (a corrupt file).
function parseOwner(text: string): Owner | undefined {
  const [pidText, start] = text.trim().split(' ');
  const pid = Number(pidText);
  return Number.isInteger(pid) && pid > 0 ? { pid, start } : undefined;
}

async function readOwner(path: string): Promise<Owner | undefined> {
  const text = await readText(path);
  return text === undefined ? undefined : parseOwner(text);
}

// The owner is still the process that took the lock: alive, and started when it was then.
function ownerAlive(owner: Owner): boolean {
  return isAlive(owner.pid) && (owner.start === undefined || startTime(owner.pid) === undefined || startTime(owner.pid) === owner.start);
}

// The pid written in the lock file; undefined when there is no file or no pid in it.
export async function lockOwner(path: string): Promise<number | undefined> {
  return (await readOwner(path))?.pid;
}

// The pid of the live process holding the lock; undefined when it is free or stale.
export async function liveOwner(path: string): Promise<number | undefined> {
  const owner = await readOwner(path);
  return owner !== undefined && ownerAlive(owner) ? owner.pid : undefined;
}

// The pid of a lock's owner that has ended without releasing it; undefined when the lock is free
// or held.
export async function staleOwner(path: string): Promise<number | undefined> {
  const owner = await readOwner(path);
  return owner !== undefined && !ownerAlive(owner) ? owner.pid : undefined;
}

export interface HeldLock {
  // Removes the lock file while it still names this process.
  release(): Promise<void>;
}

// Takes the lock for this process, or returns the pid of the live process that holds it.
export async function tryLock(path: string): Promise<{ held: HeldLock } | { owner: number }> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temp, ownerText(), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await link(temp, path);
        return { held: { release: () => releaseLock(path) } };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
      const text = await readText(path);
      if (text === undefined) {
        // Released meanwhile: try again.
        continue;
      }
      const owner = parseOwner(text);
      if (owner !== undefined && ownerAlive(owner)) {
        return { owner: owner.pid };
      }
      // Stale: its owner ended without releasing it, or the file names none. Moved aside first and
      // compared with the text read, so a lock that another process took meanwhile is put back
      // rather than removed.
      await removeStale(path, text);
    }
    throw new FactoryError('lock_failed', `The lock ${path} could not be taken.`);
  } finally {
    await rm(temp, { force: true });
  }
}

// Removes the lock file while it still holds text (the stale lock that was read).
async function removeStale(path: string, text: string): Promise<void> {
  const aside = join(dirname(path), `.${basename(path)}.${randomUUID()}.stale`);
  try {
    await rename(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  try {
    if ((await readFile(aside, 'utf8')) !== text) {
      await link(aside, path).catch(() => undefined);
    }
  } finally {
    await rm(aside, { force: true });
  }
}

// Removes the lock while it names this process.
async function releaseLock(path: string): Promise<void> {
  if ((await lockOwner(path)) === process.pid) {
    await rm(path, { force: true });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Runs work while holding the lock, waiting for it as long as another live process holds it.
export async function withLock<T>(path: string, work: () => Promise<T>, pollMs = 50): Promise<T> {
  for (;;) {
    const taken = await tryLock(path);
    if ('held' in taken) {
      try {
        return await work();
      } finally {
        await taken.held.release();
      }
    }
    await sleep(pollMs);
  }
}
