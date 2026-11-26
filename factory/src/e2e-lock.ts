// The host-wide e2e lock: one e2e run at a time on the machine, across all jobs, because two runs
// on one backend break each other. It is an exclusive flock(2) lock on one file of the factory's
// state directory (<state dir>/e2e.lock, the caller passes the path), so the coordinator's own
// scripts take the same lock with `flock <file> <cmd>`, and each side waits for the other. No
// helper of the lock outlives its caller, a SIGKILL of the caller included: no helper ever waits in
// flock(2), where it could not notice its caller's death. Every attempt is one non-blocking
// `flock --nonblock --no-fork <file> /bin/sh -c 'echo locked; exec cat >/dev/null'` (util-linux
// 2.38 or later for --no-fork; an older flock exits 64), with stdin, stdout and stderr as pipes and
// an environment of PATH only. Exit 75 before `locked` means the file is held: the taker tries
// again every pollMs. `locked` means the helper holds the lock: with --no-fork the process holding
// the descriptor is the `cat` reading the caller's pipe, so it ends when the caller closes the pipe
// (release), exits, dies or kills it, and the kernel ends the lock with it. The lock is never stale;
// the holder line the taker writes into the file (who, pid, since when) only tells a waiter who
// holds it, and a line whose pid is gone reads `another process`. A failure is an e2e_lock_failed
// error that names the lock by its place in the state directory, never by its host path; flock's
// own words go to console.error (a job runner's runner.log) only.
// This module knows processes and one file; it knows nothing about jobs.
import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { FactoryError } from './errors.js';
import { isAlive } from './pid-lock.js';

export const E2E_LOCK_FILE = 'e2e.lock';
export const E2E_LOCK_FAILED = 'e2e_lock_failed';
// How long a taker waits between two attempts on a held lock.
export const E2E_LOCK_POLL_MS = 1000;

// The exit code flock gives when the file is held (--conflict-exit-code).
const CONFLICT_EXIT = 75;
// What a waiter is told when the file names no live holder.
const ANOTHER_PROCESS = 'another process';
// The longest holder a waiter is told, in code points.
const MAX_HOLDER_CODE_POINTS = 200;
// What lockHolder reads of the file: its start, enough for the first line's 200 code points.
const READ_BYTES = 4096;
// What an attempt keeps of the helper's stderr, for its last line: the end of it.
const STDERR_TAIL_BYTES = 4096;

export interface E2eLockOptions {
  // The lock file: <state dir>/e2e.lock.
  file: string;
  // Who takes the lock, for the holder line a waiter reads.
  holder: string;
  // Ends a wait: the take resolves undefined.
  signal: AbortSignal;
  // Called once, with the holder, at the first attempt that finds the lock held; awaited, unless the
  // signal ends the wait first.
  onWait?: (holder: string) => void | Promise<void>;
  // Where PATH comes from (default: process.env).
  env?: NodeJS.ProcessEnv;
  // The clock of the holder line's time (default: Date.now).
  now?: () => number;
  // How long to wait between two attempts (default: E2E_LOCK_POLL_MS).
  pollMs?: number;
}

export interface E2eLock {
  // Empties the holder line and lets the lock go; idempotent, it resolves once the helper ended.
  release(): Promise<void>;
}

// What one attempt came to: the lock held by this helper, the file held by another, or aborted.
// exited resolves once the helper ended.
type Locked = { kind: 'locked'; helper: ChildProcess; exited: Promise<void> };
type Attempt = Locked | { kind: 'held' } | { kind: 'aborted' };

// The holder a waiter is told, from the lock file's text: its first line, control characters out,
// trimmed, at most MAX_HOLDER_CODE_POINTS; `another process` when that is empty or names a pid
// (`(pid <n>)`) whose process is gone.
export function lockHolder(text: string, alive: (pid: number) => boolean = isAlive): string {
  const line = (text.split('\n')[0] ?? '').replace(/\p{Cc}/gu, '').trim();
  const holder = [...line].slice(0, MAX_HOLDER_CODE_POINTS).join('');
  if (holder === '') {
    return ANOTHER_PROCESS;
  }
  const pid = /\(pid (\d+)\)/.exec(holder);
  if (pid !== null) {
    const n = Number(pid[1]);
    if (!Number.isSafeInteger(n) || n <= 0 || !alive(n)) {
      return ANOTHER_PROCESS;
    }
  }
  return holder;
}

// Takes the e2e lock: resolves the lock once it is held, undefined when the signal ends the wait
// (or was aborted at the call). Rejects with e2e_lock_failed when flock is missing or fails, and
// with onWait's own error when onWait rejects.
export async function takeE2eLock(options: E2eLockOptions): Promise<E2eLock | undefined> {
  const { file, holder, signal, onWait, env = process.env, now = Date.now, pollMs = E2E_LOCK_POLL_MS } = options;
  let told = false;
  for (;;) {
    if (signal.aborted) {
      return undefined;
    }
    const attempt = await attemptLock(file, env, signal);
    if (attempt.kind === 'aborted') {
      return undefined;
    }
    if (attempt.kind === 'locked') {
      await writeLine(file, `${holder} (pid ${process.pid}) since ${new Date(now()).toISOString()}\n`);
      return heldLock(file, attempt);
    }
    if (!told) {
      told = true;
      const text = await readStart(file);
      if (signal.aborted) {
        return undefined;
      }
      if (onWait !== undefined && !(await untilAborted(onWait, lockHolder(text), signal))) {
        return undefined;
      }
    }
    if (!(await pause(pollMs, signal))) {
      return undefined;
    }
  }
}

// The lock this helper holds: release empties the line, closes the helper's stdin (its cat ends,
// and the lock with it) and waits for the helper to end. A helper that already ended (killed from
// outside) no longer holds the lock, so its release leaves the file to whoever took it since.
function heldLock(file: string, { helper, exited }: Locked): E2eLock {
  let released: Promise<void> | undefined;
  return {
    release() {
      released ??= (async () => {
        if (helper.exitCode === null && helper.signalCode === null) {
          await writeLine(file, '');
        }
        helper.stdin?.end();
        await exited;
      })();
      return released;
    },
  };
}

// One non-blocking attempt. The helper's stdin stays open while it holds the lock; an abort before
// `locked` was read kills it and waits for it to end.
function attemptLock(file: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Attempt> {
  const helper = spawn(
    'flock',
    ['--exclusive', '--nonblock', '--conflict-exit-code', String(CONFLICT_EXIT), '--no-fork', file, '/bin/sh', '-c', 'echo locked; exec cat >/dev/null'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: env.PATH === undefined ? {} : { PATH: env.PATH } },
  );
  // A write to the pipe of a helper that already ended (EPIPE) changes nothing: its end is what
  // release waits for.
  helper.stdin.on('error', () => undefined);
  let stderr = '';
  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });
  const exited = new Promise<void>((resolve) => helper.once('close', () => resolve()));
  return new Promise<Attempt>((resolve, reject) => {
    let stdout = '';
    let settled = false;
    const settle = (attempt: Attempt | FactoryError): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      helper.stdout.removeListener('data', onData);
      if (attempt instanceof FactoryError) {
        reject(attempt);
      } else {
        resolve(attempt);
      }
    };
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      helper.kill('SIGKILL');
      void exited.then(() => settle({ kind: 'aborted' }));
    };
    const onData = (chunk: string): void => {
      stdout += chunk;
      if (stdout.startsWith('locked\n') && !signal.aborted) {
        // What else the helper writes (nothing: cat writes to /dev/null) is read and dropped.
        helper.stdout.resume();
        settle({ kind: 'locked', helper, exited });
      }
    };
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', onData);
    signal.addEventListener('abort', onAbort, { once: true });
    // A spawn that failed has no pid; an error of a started helper (a kill that failed) leaves its
    // end to the close event.
    helper.on('error', (error: NodeJS.ErrnoException) => {
      if (helper.pid !== undefined) {
        return;
      }
      settle(lockFailed(error.code === 'ENOENT' ? 'flock (util-linux) is not installed' : `flock could not be started (${errorCode(error)})`));
    });
    helper.once('close', (code: number | null, killedBy: NodeJS.Signals | null) => {
      if (settled || signal.aborted) {
        return;
      }
      if (code === CONFLICT_EXIT) {
        settle({ kind: 'held' });
        return;
      }
      const line = stderr.trimEnd().split('\n').at(-1) ?? '';
      if (line !== '') {
        console.error(`e2e lock: ${line}`);
      }
      settle(lockFailed(code !== null ? `flock exited with ${code} on ${place(file)}` : `flock was killed by ${killedBy ?? 'a signal'} on ${place(file)}`));
    });
  });
}

function lockFailed(why: string): FactoryError {
  return new FactoryError(E2E_LOCK_FAILED, `the e2e lock could not be taken: ${why}`);
}

// The lock file by its place in the state directory, never its host path.
function place(file: string): string {
  return `<state dir>/${basename(file)}`;
}

// The code of a failed file operation, for a log line.
function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'unknown error';
}

// Calls onWait and waits for it: true once it resolved, false when the signal ends the wait first
// (onWait still pending; what it comes to later, a rejection included, changes nothing). A
// rejection before the abort, or a throw, rejects with onWait's own error.
function untilAborted(onWait: (holder: string) => void | Promise<void>, holder: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    const done = (): void => signal.removeEventListener('abort', onAbort);
    (async () => onWait(holder))().then(
      () => {
        done();
        resolve(!signal.aborted);
      },
      (error: unknown) => {
        done();
        if (signal.aborted) {
          resolve(false);
        } else {
          reject(error);
        }
      },
    );
  });
}

// Waits ms; false when the signal ends the wait (at once when it already has).
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Replaces the file's text, never through a link. The line only informs a waiter: a failure is
// logged and the lock stays as it is.
async function writeLine(file: string, text: string): Promise<void> {
  try {
    const handle = await open(file, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
  } catch (error) {
    console.error(`e2e lock: the holder line of ${place(file)} could not be written (${errorCode(error)})`);
  }
}

// The start of the file, for its holder line; empty when the file is gone. Any other failure is
// logged and reads as empty too: the waiter is told `another process`.
async function readStart(file: string): Promise<string> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(READ_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, READ_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`e2e lock: the holder line of ${place(file)} could not be read (${errorCode(error)})`);
    }
    return '';
  }
}
