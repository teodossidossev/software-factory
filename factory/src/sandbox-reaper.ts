// The leftovers of Claude Code's Bash sandbox. Claude Code starts its sandbox as
// `bwrap --new-session --die-with-parent …`: its own session, so no process-group kill reaches it,
// and when the claude process of a query ends its bwraps are reparented to the systemd user manager
// (or pid 1) and live on with their shells and socat bridges. This module ends those orphans, the
// factory's own and nothing else: a bwrap of the factory's user, whose parent is pid 1 or a systemd
// process, and whose command line names a path under one of the roots (the worktree root and the
// state directory); with it, its descendants of the same user. A process whose parent is alive and
// not systemd (a live session's sandbox) and another user's are never touched. It reads /proc and
// is a no-op without it. It knows nothing of jobs or sessions; its callers decide when it runs.
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stateDir, worktreeRoot } from './config.js';

// The sandbox's command name (comm): the only processes chosen for themselves.
const SANDBOX_NAME = 'bwrap';
// SIGTERM first; SIGKILL for whatever is still alive this long after.
const GRACE_MS = 2_000;
const POLL_MS = 100;
// How often sf serve looks for leftovers while it runs with SF_HEALTH=off, whatever ended
// (src/recovery.ts); with the health checks on, it looks before each sandboxes check.
export const REAP_EVERY_MS = 10 * 60_000;

export interface ReapOptions {
  // The /proc directory to read; default the real one (on Linux only: elsewhere the reaper is a no-op).
  proc?: string;
  platform?: NodeJS.Platform;
  // The factory's own user; default process.getuid().
  uid?: number;
  // How long after SIGTERM a process still alive gets SIGKILL; default 2 s.
  graceMs?: number;
  // Where its one line goes (what it ended, or why it failed); default console.error.
  log?: (line: string) => void;
}

// One process as /proc shows it.
interface ProcessInfo {
  pid: number;
  name: string;
  ppid: number;
  uid: number;
  // The start time (field 22 of stat): with the pid, who the process is (a reused pid is another).
  start: string;
  zombie: boolean;
  args: string[];
}

// The reaper's roots of a factory: its worktree root and its state directory; by default as
// config.ts reads them from the environment (which throws on an invalid SF_WORKTREE_ROOT).
export function factoryRoots(dirs: { worktreeRoot: string; stateDir: string } = { worktreeRoot: worktreeRoot(), stateDir: stateDir() }): string[] {
  return [dirs.worktreeRoot, dirs.stateDir];
}

// Each root as an absolute path without a trailing slash, with its real path when that differs (a
// symlinked home: the sandbox names real paths); the file-system root and empty roots dropped, so a
// root can never cover every path.
function normalRoots(roots: readonly string[]): string[] {
  const result = new Set<string>();
  for (const root of roots) {
    if (root.trim() === '') {
      continue;
    }
    const absolute = resolve(root);
    const real = (() => {
      try {
        return realpathSync(absolute);
      } catch {
        return absolute;
      }
    })();
    for (const path of [absolute, real]) {
      if (path !== '/') {
        result.add(path);
      }
    }
  }
  return [...result];
}

// Whether one of args names root or a path under it.
function namesRoot(args: readonly string[], roots: readonly string[]): boolean {
  return args.some((arg) => roots.some((root) => arg === root || arg.startsWith(`${root}/`)));
}

// The process at <proc>/<pid>, or undefined when it is gone or cannot be read.
async function readProcess(proc: string, pid: number): Promise<ProcessInfo | undefined> {
  const dir = join(proc, String(pid));
  try {
    const [status, stat, cmdline] = await Promise.all([
      readFile(join(dir, 'status'), 'utf8'),
      readFile(join(dir, 'stat'), 'utf8'),
      readFile(join(dir, 'cmdline'), 'utf8'),
    ]);
    const field = (name: string): string | undefined => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(status)?.[1];
    const name = field('Name');
    const ppid = Number(field('PPid'));
    const uid = Number(field('Uid')?.split(/\s+/)[0]);
    // The fields after the command name, which may itself hold spaces and parentheses.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const start = rest[19];
    if (name === undefined || !Number.isInteger(ppid) || !Number.isInteger(uid) || start === undefined) {
      return undefined;
    }
    return { pid, name, ppid, uid, start, zombie: rest[0] === 'Z', args: cmdline.split('\0').filter((arg) => arg !== '') };
  } catch {
    return undefined;
  }
}

// Every process /proc shows that can still be read.
async function readProcesses(proc: string): Promise<Map<number, ProcessInfo>> {
  const pids = (await readdir(proc)).filter((name) => /^\d+$/.test(name)).map(Number);
  const found = await Promise.all(pids.map((pid) => readProcess(proc, pid)));
  return new Map(found.filter((info): info is ProcessInfo => info !== undefined).map((info) => [info.pid, info]));
}

// Whether the process is orphaned: its parent is pid 1, or a systemd process (the user manager,
// which takes the orphans of the user's session as their subreaper).
function orphaned(info: ProcessInfo, processes: ReadonlyMap<number, ProcessInfo>): boolean {
  return info.ppid === 1 || processes.get(info.ppid)?.name === 'systemd';
}

// The sandbox leftovers among processes: each orphaned sandbox of uid naming a root, then its
// descendants of uid, parents before children; never the reaper's own process or its ancestors.
function chooseLeftovers(processes: ReadonlyMap<number, ProcessInfo>, roots: readonly string[], uid: number, self: number): ProcessInfo[] {
  const spared = new Set<number>();
  for (let pid: number | undefined = self; pid !== undefined && pid > 0 && !spared.has(pid); pid = processes.get(pid)?.ppid) {
    spared.add(pid);
  }
  const children = new Map<number, ProcessInfo[]>();
  for (const info of processes.values()) {
    children.set(info.ppid, [...(children.get(info.ppid) ?? []), info]);
  }
  const chosen = new Map<number, ProcessInfo>();
  const add = (info: ProcessInfo): void => {
    // Another user's process, and what runs under it, is never touched.
    if (chosen.has(info.pid) || spared.has(info.pid) || info.uid !== uid) {
      return;
    }
    chosen.set(info.pid, info);
    for (const child of children.get(info.pid) ?? []) {
      add(child);
    }
  };
  for (const info of processes.values()) {
    if (info.pid > 1 && info.uid === uid && info.name === SANDBOX_NAME && orphaned(info, processes) && namesRoot(info.args, roots)) {
      add(info);
    }
  }
  return [...chosen.values()];
}

// The /proc the reaper reads: the one given, else the real one on Linux; undefined elsewhere.
function procDir(options: ReapOptions): string | undefined {
  if (options.proc !== undefined) {
    return options.proc;
  }
  return (options.platform ?? process.platform) === 'linux' ? '/proc' : undefined;
}

// The leftovers to end now and the /proc they were read from; undefined without a readable /proc.
async function leftovers(roots: readonly string[], options: ReapOptions): Promise<{ proc: string; chosen: ProcessInfo[] } | undefined> {
  const proc = procDir(options);
  const processes = proc === undefined ? undefined : await readProcesses(proc).catch(() => undefined);
  if (proc === undefined || processes === undefined) {
    return undefined;
  }
  return { proc, chosen: chooseLeftovers(processes, normalRoots(roots), options.uid ?? process.getuid?.() ?? -1, process.pid) };
}

// The pids reapOrphanedSandboxes would end now, sandboxes and descendants; [] without /proc.
export async function findOrphanedSandboxes(roots: readonly string[], options: ReapOptions = {}): Promise<number[]> {
  return ((await leftovers(roots, options))?.chosen ?? []).map((info) => info.pid);
}

// The orphan scans of the health check sandboxes: each scan is a fresh
// findOrphanedSandboxes; it returns how many pids it found and those the previous scan of this
// watch found too (the reaper did not end them). The first scan has no previous one, so none
// persist.
export class OrphanWatch {
  readonly #roots: () => readonly string[];
  readonly #options: ReapOptions;
  #previous: Set<number> | undefined;

  constructor(roots: () => readonly string[], options: ReapOptions = {}) {
    this.#roots = roots;
    this.#options = options;
  }

  async scan(): Promise<{ found: number; persisting: number[] }> {
    const found = await findOrphanedSandboxes(this.#roots(), this.#options);
    const previous = this.#previous;
    this.#previous = new Set(found);
    return { found: found.length, persisting: previous === undefined ? [] : found.filter((pid) => previous.has(pid)) };
  }
}

// Sends the signal, ignoring a process gone meanwhile (ESRCH) or not ours to signal (EPERM).
function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Nothing to end.
  }
}

// Whether the process is still the one chosen and not yet ended (a zombie has ended).
async function stillAlive(proc: string, info: ProcessInfo): Promise<boolean> {
  const now = await readProcess(proc, info.pid);
  return now !== undefined && now.start === info.start && !now.zombie;
}

// Resolves after ms.
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// Ends the factory's sandbox leftovers under roots: SIGTERM to each and its descendants, SIGKILL
// after the grace period to any still alive. Resolves with the pids it signalled. Never throws:
// a failure is one log line, and without /proc it does nothing.
export async function reapOrphanedSandboxes(roots: readonly string[], options: ReapOptions = {}): Promise<number[]> {
  const log = options.log ?? ((line: string) => console.error(line));
  try {
    const found = await leftovers(roots, options);
    if (found === undefined) {
      // No /proc: nothing to read, nothing to end.
      return [];
    }
    const { proc } = found;
    // Each looked at again right before its SIGTERM: a pid reused since the scan is another process.
    const checked = await Promise.all(found.chosen.map((info) => stillAlive(proc, info)));
    const chosen = found.chosen.filter((_, index) => checked[index]);
    if (chosen.length === 0) {
      return [];
    }
    for (const info of chosen) {
      signal(info.pid, 'SIGTERM');
    }
    const deadline = Date.now() + (options.graceMs ?? GRACE_MS);
    let alive = chosen;
    for (;;) {
      const checks = await Promise.all(alive.map((info) => stillAlive(proc, info)));
      alive = alive.filter((_, index) => checks[index]);
      if (alive.length === 0 || Date.now() >= deadline) {
        break;
      }
      await sleep(POLL_MS);
    }
    for (const info of alive) {
      signal(info.pid, 'SIGKILL');
    }
    const sandboxes = chosen.filter((info) => !chosen.some((other) => other.pid === info.ppid)).length;
    log(`sandbox reaper: ended ${sandboxes} orphaned sandbox${sandboxes === 1 ? '' : 'es'} (${chosen.length} processes${alive.length > 0 ? `, ${alive.length} with SIGKILL` : ''})`);
    return chosen.map((info) => info.pid);
  } catch (error) {
    log(`sandbox reaper: failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
