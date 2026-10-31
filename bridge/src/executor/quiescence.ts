// SF-009 Review 02 (R2-1): when a review boundary is stable. A stream-json `result` proves only
// that Claude's foreground turn ended; a background command, a subagent-style task or a detached
// child can still write. A snapshot is published only after a quiescent boundary was observed:
//   - no process of the session runs any more: the Claude process's descendants (parent links) and
//     every same-user process that carries the session's tag in its environment (SESSION_TAG, set
//     by ManagedClaudeRunner and inherited by children, so a detached or re-parented child is still
//     found); each known by its identity (pid and start time), so a recycled pid is never mistaken;
//   - the Claude process produced no output and has no background task open (system/task_started
//     without its system/task_notification: a subagent runs inside the Claude process itself);
//   - and the full tree fingerprint stayed the same for a whole quiet window.
// Bounded: at the deadline the reason is reported and nothing is published.
//
// Limits (no OS sandbox): this is same-user inspection of /proc. A process that clears its
// environment and leaves the process tree (e.g. `env -i setsid ...`) is not found, and an
// unrelated same-user process can still write; the fingerprint checks around the capture and
// before publication catch a write that lands meanwhile, not one that comes later.
// /proc is read synchronously: each read is served by the kernel in microseconds, and one pass
// over a few hundred processes then takes milliseconds instead of queueing on the thread pool.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_TAG } from '../execution/runner.js';

export { SESSION_TAG };

const MAX_PROCESSES = 50_000;
// USER_HZ: the unit of /proc start times (100 on Linux for every architecture in use).
const CLOCK_TICKS = 100;

export interface ProcessRef {
  pid: number;
  // Field 22 of /proc/<pid>/stat (start time in clock ticks since boot).
  start: string;
  // The command name (comm, at most 15 characters), sanitized: diagnostics only.
  name: string;
}

export interface WriterScan {
  // Proven processes of the session: descendants of the Claude process, or tagged.
  writers: ProcessRef[];
  // Everything the scan could not rule out (fail closed): the unattributed processes below, plus
  // what could not be identified at all (process list unreadable or truncated, stat unreadable).
  indeterminate: number;
  // Review 03 (R3-4): of those, the same-user processes started during the session, known by
  // identity, that cannot be attributed either way (their environment or owner cannot be read).
  // Not proven to be the session's, never ignored as unrelated. Omitted: none known.
  unattributed?: ProcessRef[];
}

// Review 03 (R3-4): why a scan is not quiet, as a reason code and a non-secret message (pids and
// command names only; never a command line or an environment).
export type ScanBlocker = { code: 'session_writers' | 'unattributed_processes' | 'process_scan_incomplete'; message: string };

export function scanBlocker(scan: WriterScan): ScanBlocker | null {
  if (scan.writers.length > 0) return { code: 'session_writers', message: `${describeProcesses(scan.writers)} started by the session still running` };
  const unattributed = scan.unattributed ?? [];
  const incomplete = scan.indeterminate - unattributed.length;
  if (unattributed.length > 0) {
    const pids = unattributed.slice(0, 10).map((ref) => `${ref.pid} ${ref.name}`).join(', ');
    return {
      code: 'unattributed_processes',
      message: `${unattributed.length} same-user process(es) started during the session cannot be attributed (environment or owner unreadable; pid ${pids}${unattributed.length > 10 ? ', ...' : ''})${incomplete > 0 ? `, and ${incomplete} more could not be identified at all` : ''}; not proven to be the session's, not ignored either: end or inspect them`,
    };
  }
  if (scan.indeterminate > 0) return { code: 'process_scan_incomplete', message: `the process scan could not identify ${scan.indeterminate} process(es) (process list or stat unreadable, or too many processes)` };
  return null;
}

interface Stat {
  state: string;
  ppid: number;
  start: string;
  name: string;
}

const gone = (error: unknown): boolean => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');

// The process's stat; 'gone' when it ended (ENOENT, ESRCH); 'unreadable' for any other failure or
// an unparsable stat, which is never taken as "not running" (Review 02, review 1ff34ac1).
function statOf(proc: string, pid: number): Stat | 'gone' | 'unreadable' {
  let text: string;
  try {
    text = readFileSync(join(proc, String(pid), 'stat'), 'utf8');
  } catch (error) {
    return gone(error) ? 'gone' : 'unreadable';
  }
  const close = text.lastIndexOf(')');
  const fields = text.slice(close + 2).split(' ');
  if (close < 0 || fields.length < 20) return 'unreadable';
  return { state: fields[0]!, ppid: Number(fields[1]), start: fields[19]!, name: text.slice(text.indexOf('(') + 1, close).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 15) };
}

function readStat(proc: string, pid: number): Stat | undefined {
  const stat = statOf(proc, pid);
  return typeof stat === 'string' ? undefined : stat;
}

// Whether pid's /proc entry belongs to another user (then it cannot be the session's). undefined
// when that cannot be determined (it ended, or its entry cannot be read).
function otherUser(proc: string, pid: number, uid: number | undefined): boolean | undefined {
  try {
    return uid !== undefined && lstatSync(join(proc, String(pid))).uid !== uid;
  } catch {
    return undefined;
  }
}

// The live processes that belong to the session rooted at rootPid (which itself is left out).
// tags: the session ids whose tag marks a process; since: the start time of the session's first
// process (a process started before it cannot carry its tag). A process that ends while it is
// being read is not counted; zombies do not write. Fail closed (indeterminate): a process list
// longer than limit, and a process of this user (or of an undeterminable owner) whose stat cannot
// be read: it could be the session's.
export async function sessionWriters(rootPid: number, tags: readonly string[], since: string, proc = '/proc', limit = MAX_PROCESSES): Promise<WriterScan> {
  const uid = process.getuid?.();
  const stats = new Map<number, Stat>();
  const children = new Map<number, number[]>();
  let names: string[];
  try {
    names = readdirSync(proc);
  } catch {
    // Without a process list nothing can be shown quiet: fail closed.
    return { writers: [], indeterminate: 1 };
  }
  const pids = names.filter((entry) => /^\d+$/.test(entry));
  let indeterminate = pids.length > limit ? 1 : 0;
  const unattributed: ProcessRef[] = [];
  for (const entry of pids.slice(0, limit)) {
    const pid = Number(entry);
    if (pid === process.pid || pid === rootPid) continue;
    const stat = statOf(proc, pid);
    if (stat === 'gone') continue;
    if (stat === 'unreadable') {
      if (otherUser(proc, pid, uid) !== true && statOf(proc, pid) !== 'gone') indeterminate += 1;
      continue;
    }
    if (stat.state === 'Z') continue;
    stats.set(pid, stat);
    children.set(stat.ppid, [...(children.get(stat.ppid) ?? []), pid]);
  }
  const found = new Set<number>();
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (found.has(next)) continue;
    found.add(next);
    queue.push(...(children.get(next) ?? []));
  }
  const markers = tags.map((tag) => `${SESSION_TAG}=${tag}`);
  for (const [pid, stat] of stats) {
    if (found.has(pid) || Number(stat.start) < Number(since)) continue;
    // Only this user's processes: another user's cannot have been started by the session.
    const foreign = otherUser(proc, pid, uid);
    if (foreign === true) continue;
    if (foreign === undefined) {
      if (statOf(proc, pid) !== 'gone') unattributed.push({ pid, start: stat.start, name: stat.name });
      continue;
    }
    let environ: string;
    try {
      environ = readFileSync(join(proc, String(pid), 'environ'), 'latin1');
    } catch (error) {
      // A process refuses the read while it ends (or execs); counted only if it is still the same
      // live process afterwards.
      const again = gone(error) ? undefined : readStat(proc, pid);
      if (again !== undefined && again.state !== 'Z' && again.state !== 'X' && again.start === stat.start) unattributed.push({ pid, start: stat.start, name: stat.name });
      continue;
    }
    const variables = environ.split('\0');
    if (markers.some((marker) => variables.includes(marker))) found.add(pid);
  }
  const writers = [...found].flatMap((pid) => (stats.has(pid) ? [{ pid, start: stats.get(pid)!.start, name: stats.get(pid)!.name }] : []));
  return { writers: writers.sort((a, b) => a.pid - b.pid), indeterminate: indeterminate + unattributed.length, unattributed };
}

// The start time (clock ticks since boot, as in /proc/<pid>/stat) of a moment, less a margin; '0'
// when the boot time cannot be read. Used where the session's first process no longer runs.
export function ticksAt(iso: string, proc = '/proc'): string {
  try {
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync(join(proc, 'stat'), 'utf8'))?.[1]);
    const seconds = Date.parse(iso) / 1000 - btime - 5;
    return Number.isFinite(seconds) && seconds > 0 ? String(Math.floor(seconds * CLOCK_TICKS)) : '0';
  } catch {
    return '0';
  }
}

// An instant check (not a wait): a scan that finds only unidentifiable processes is repeated a few
// times, because a process that ends or execs refuses the environment read for a moment. One that
// stays unidentifiable stays indeterminate (fail closed).
export async function settledScan(scan: () => Promise<WriterScan>, attempts = 10, pauseMs = 100): Promise<WriterScan> {
  let result = await scan();
  for (let attempt = 1; attempt < attempts && result.writers.length === 0 && result.indeterminate > 0; attempt += 1) {
    await sleep(pauseMs);
    result = await scan();
  }
  return result;
}

// The processes of refs that still run as the same process (pid and start time).
export async function stillRunning(refs: readonly ProcessRef[], proc = '/proc'): Promise<ProcessRef[]> {
  const running: ProcessRef[] = [];
  for (const ref of refs) {
    // A stat that cannot be read is not proof that it ended.
    const stat = statOf(proc, ref.pid);
    if (stat === 'unreadable' || (stat !== 'gone' && stat.state !== 'Z' && stat.start === ref.start)) running.push(ref);
  }
  return running;
}

// The start time of pid, or undefined when it does not run.
export async function startOf(pid: number, proc = '/proc'): Promise<string | undefined> {
  return readStat(proc, pid)?.start;
}

// "3 process(es) (node x2, sh)": counts and command names only.
export function describeProcesses(refs: readonly ProcessRef[]): string {
  const counts = new Map<string, number>();
  for (const ref of refs) counts.set(ref.name, (counts.get(ref.name) ?? 0) + 1);
  const list = [...counts].slice(0, 10).map(([name, count]) => (count > 1 ? `${name} x${count}` : name));
  return `${refs.length} process(es) (${list.join(', ')}${counts.size > 10 ? ', ...' : ''})`;
}

export interface QuiescenceProbe {
  scan(): Promise<WriterScan>;
  // The full tree fingerprint (fingerprint.ts).
  fingerprint(): Promise<string>;
  // A counter of everything the Claude process wrote to stdout; a change is activity.
  activity(): number;
  // Background tasks Claude Code reported started and not yet ended (stream-json system events).
  tasks?(): number;
  // Ends the wait early: a further turn end was observed, or the supervisor stops.
  interrupted(): 'turn' | 'stopped' | undefined;
  // Called when the reason for waiting changes (diagnostics).
  waiting?(reason: string): Promise<void>;
}

export interface QuiescenceLimits {
  // How long the fingerprint and the output must stay unchanged with no process of the session.
  quietMs: number;
  // The bound on the whole wait.
  timeoutMs: number;
  pollMs: number;
}

export type Quiescence =
  // activity: the output counter of the quiet window; whoever publishes must find it unchanged.
  | { kind: 'quiet'; fingerprint: string; activity: number; waitedMs: number; writersSeen: number }
  | { kind: 'timeout'; reason: string; waitedMs: number }
  | { kind: 'turn' }
  | { kind: 'stopped' };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function awaitQuiescence(probe: QuiescenceProbe, limits: QuiescenceLimits): Promise<Quiescence> {
  const started = Date.now();
  const seen = new Set<string>();
  let window: { fingerprint: string; activity: number; since: number } | undefined;
  const initial = 'no quiet window of the required length was observed';
  let reason = initial;
  let reported = '';
  for (;;) {
    const interrupted = probe.interrupted();
    if (interrupted !== undefined) return { kind: interrupted };
    const scan = await probe.scan();
    const tasks = probe.tasks?.() ?? 0;
    for (const writer of scan.writers) seen.add(`${writer.pid}:${writer.start}`);
    const blocker = scanBlocker(scan);
    if (blocker !== null || tasks > 0) {
      window = undefined;
      // Proven writers first, then open tasks, then what could not be attributed (R3-4: each by its code).
      if (blocker !== null && (blocker.code === 'session_writers' || tasks === 0)) reason = `${blocker.message} [${blocker.code}]`;
      else reason = `${tasks} background task(s) Claude Code reported started have not ended [background_tasks]`;
    } else {
      const fingerprint = await probe.fingerprint();
      const activity = probe.activity();
      const now = Date.now();
      if (window === undefined || window.fingerprint !== fingerprint || window.activity !== activity) {
        if (window !== undefined) reason = window.fingerprint !== fingerprint ? 'the working tree kept changing with no process of the session running' : 'Claude Code kept producing output after its turn ended';
        window = { fingerprint, activity, since: now };
      } else if (now - window.since >= limits.quietMs) {
        return { kind: 'quiet', fingerprint, activity, waitedMs: now - started, writersSeen: seen.size };
      }
    }
    if (reason !== reported && reason !== initial) {
      reported = reason;
      await probe.waiting?.(reason);
    }
    if (Date.now() - started >= limits.timeoutMs) return { kind: 'timeout', reason, waitedMs: Date.now() - started };
    await sleep(limits.pollMs);
  }
}
