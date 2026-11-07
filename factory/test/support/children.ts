// Every sf process a test starts (SF-114): tracked here, stopped at the end of its test file
// (SIGTERM, then SIGKILL), also on a failure or a signal to the file's process, and a serve left
// running reported, so the after hook can fail the file. Also finds the sf serves no helper started
// (the detached serve of an sf smoke) by their state directory in /proc. Node built-ins only.
// Importing it adds, once, the exit and signal listeners that kill what is left and remove the
// directories given to removeOnExit.
import type { ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The compiled sf CLI (dist/src/cli.js), the same path as the harness's CLI.
export const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
// How long stopChild waits for the exit after SIGTERM, and again after SIGKILL.
export const STOP_MS = 5_000;
// How long a serve a test expects to refuse may run before the test fails.
export const REFUSAL_MS = 30_000;

const tracked = new Map<ChildProcess, string>();
const serves = new Set<ChildProcess>();
const removals = new Set<string>();

// sf serve, or sf up, which runs serve in its own process.
export function isServe(args: readonly string[]): boolean {
  return args[0] === 'serve' || args[0] === 'up';
}

export function trackChild(child: ChildProcess, args: readonly string[]): void {
  tracked.set(child, `sf ${args.join(' ')} (pid ${child.pid})`);
  if (isServe(args)) {
    serves.add(child);
  }
  child.once('exit', () => {
    tracked.delete(child);
    serves.delete(child);
  });
}

const ended = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null || child.pid === undefined;

// Sends the signal; false when it could not be delivered (the child is gone: ESRCH).
function signal(child: ChildProcess, name: NodeJS.Signals): boolean {
  try {
    return child.kill(name);
  } catch {
    return false;
  }
}

// SIGKILL to a process no ChildProcess stands for; one that ended meanwhile is no error.
function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // It ended meanwhile.
  }
}

// Resolves true once the child has ended, false when it still runs after ms.
function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (ended(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(ended(child));
    }, ms);
    child.once('exit', onExit);
  });
}

// SIGTERM, up to timeoutMs for the exit, then SIGKILL and up to timeoutMs again. True when the child
// ended; never rejects.
export async function stopChild(child: ChildProcess, timeoutMs = STOP_MS): Promise<boolean> {
  if (ended(child)) {
    return true;
  }
  if (!signal(child, 'SIGTERM')) {
    return true;
  }
  if (await exited(child, timeoutMs)) {
    return true;
  }
  if (!signal(child, 'SIGKILL')) {
    return true;
  }
  return exited(child, timeoutMs);
}

// Stops every tracked child still running. leftRunning: the serves among them; survivors: those
// still running afterwards.
export async function stopChildren(timeoutMs = STOP_MS): Promise<{ leftRunning: string[]; survivors: string[] }> {
  const children = [...tracked].filter(([child]) => !ended(child));
  const leftRunning = children.filter(([child]) => serves.has(child)).map(([, label]) => label);
  const stopped = await Promise.all(children.map(([child]) => stopChild(child, timeoutMs)));
  const survivors = children.filter((_, index) => !stopped[index]).map(([, label]) => label);
  return { leftRunning, survivors };
}

// An sf serve or sf up of one of roots: the cmdline's second field the CLI, its third serve or up,
// and SF_STATE_DIR equal to or under a root. The state directory, or undefined.
function serveState(cmdline: string, environ: string, roots: readonly string[]): string | undefined {
  const fields = cmdline.split('\0');
  if (fields[1] !== CLI || !isServe(fields.slice(2))) {
    return undefined;
  }
  const state = environ.split('\0').find((entry) => entry.startsWith('SF_STATE_DIR='))?.slice('SF_STATE_DIR='.length);
  return state !== undefined && roots.some((root) => state === root || state.startsWith(`${root}/`)) ? state : undefined;
}

const pidsOf = (entries: string[]): number[] => entries.filter((entry) => /^\d+$/.test(entry)).map(Number).filter((pid) => pid !== process.pid);
const commandOf = (cmdline: string): string => cmdline.replaceAll('\0', ' ').trim();

// The sf serves (and sf ups) running with their state directory at or under root, the current
// process aside; a process whose files cannot be read is skipped.
export async function strayServes(root: string): Promise<Array<{ pid: number; command: string; state: string }>> {
  const found: Array<{ pid: number; command: string; state: string }> = [];
  for (const pid of pidsOf(await readdir('/proc'))) {
    let cmdline: string;
    let environ: string;
    try {
      cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
      environ = await readFile(`/proc/${pid}/environ`, 'utf8');
    } catch {
      continue;
    }
    const state = serveState(cmdline, environ, [root]);
    if (state !== undefined) {
      found.push({ pid, command: commandOf(cmdline), state });
    }
  }
  return found;
}

// The end of a test file: stops the tracked children, then kills the serves under root no helper
// stopped. The problems, one line each; empty when there are none.
export async function checkChildren(root: string): Promise<string[]> {
  const problems: string[] = [];
  const { leftRunning, survivors } = await stopChildren();
  for (const label of leftRunning) {
    problems.push(`${label} was still running at the end of the test file: stop it in a finally (stop() of test/support/harness.ts)`);
  }
  for (const label of survivors) {
    problems.push(`${label} is still running after SIGTERM and SIGKILL`);
  }
  for (const { pid, command, state } of await strayServes(root)) {
    killPid(pid);
    problems.push(`pid ${pid} (${command}, SF_STATE_DIR=${state}) was still running at the end of the test file`);
  }
  return problems;
}

// A directory to remove when the process ends without its after hook having removed it; also a
// root of the synchronous sweep of the exit and signal listeners.
export function removeOnExit(path: string): void {
  removals.add(path);
}

// strayServes read synchronously over several roots, each found process sent SIGKILL. Their pids.
export function straySweepSync(roots: readonly string[]): number[] {
  const killed: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return killed;
  }
  for (const pid of pidsOf(entries)) {
    let state: string | undefined;
    try {
      state = serveState(readFileSync(`/proc/${pid}/cmdline`, 'utf8'), readFileSync(`/proc/${pid}/environ`, 'utf8'), roots);
    } catch {
      continue;
    }
    if (state !== undefined) {
      killPid(pid);
      killed.push(pid);
    }
  }
  return killed;
}

// What the exit and signal listeners do, synchronously: SIGKILL to every tracked child still
// running and to every serve under the removeOnExit directories, then those directories removed.
function killAllSync(): void {
  for (const child of tracked.keys()) {
    if (!ended(child)) {
      signal(child, 'SIGKILL');
    }
  }
  straySweepSync([...removals]);
  for (const path of removals) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Nothing more can be done while the process ends.
    }
  }
}

process.on('exit', killAllSync);
for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  const onSignal = (): void => {
    killAllSync();
    // Alone: end the process with the signal, as without this listener. Else node:test's own
    // listener ends it.
    if (process.listenerCount(name) === 1) {
      process.off(name, onSignal);
      process.kill(process.pid, name);
    }
  };
  process.on(name, onSignal);
}
