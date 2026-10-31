// The host-wide Claude session gate (SF-007 Review 01): at most one Claude Code
// session started by Software Factory runs at a time. Every adapter launch
// (ExecutionService.run, from the manual SF-006 CLI or the SF-007 console) takes
// the gate before claiming the job, and the command handoff prints for a
// session started by hand takes the same gate through flock(1). A session
// started by hand in any other way is outside the gate; ExecutionService finds
// it only through its recorded session id (see service.ts).
//
// The gate is an OS lock (flock(2)) on one private file. Node cannot flock, so a
// small fixed Python helper (python3 -I, no shell, fixed source) opens the file
// without following symlinks, checks that it is a private regular file of this
// user, takes LOCK_EX|LOCK_NB, checks that the path still names the locked file
// (so a deleted or replaced file cannot split the gate), and reports HELD or
// BUSY on a control channel (fd 3). To launch, it receives the Claude command
// as JSON and exec()s it in place: the Claude process itself inherits the locked
// descriptor, so the kernel keeps the gate held as long as that process, or any
// process it started that kept the descriptor, lives, even if the adapter dies.
// Released before a launch (EOF on the control channel, or the adapter dying),
// the helper exits. The file is never removed or renamed, and no stale-owner
// check exists to race. holders() only reads /proc/locks and never takes the gate.
//
// Launch evidence (Review 02). The control channel also closes when the helper
// dies, so its closing proves nothing by itself. execve() switches the process's
// executable (/proc/<pid>/exe) before it closes close-on-exec descriptors; a dying
// process loses its image before its descriptors. So after the close, the
// helper's own process (same start time, so a reused pid never counts) is
// checked: running another executable, or an argument list that is no longer the
// helper's, confirms the hand-over (handoverEvidence). An EXECFAIL or ERROR line
// is a confirmed non-start. A process that is gone is indeterminate: the helper
// was killed or crashed before exec, or the target started and ended at once;
// that cannot be told apart from outside, so it is launch_unconfirmed, never a
// launch and never a helper failure. A live process that cannot be shown to have
// exec'd within about 2 s is launch_unconfirmed too (not waited on, not killed).
// A hand-over that does not happen within the timeout (30 s) is reported the same
// way; the helper is not killed, since after the request it may be, or be about to
// become, Claude Code, and it keeps the gate until it ends. Every wait is bounded
// (Review 03): the first answer, every exit after an answer, a release or a signal.
// A helper that was not (successfully) told to exec and does not end is stopped
// with SIGKILL, and the gate counts as free only when its exit was observed and
// /proc/locks shows no lock of its pid; otherwise the call fails closed
// (gate_unresponsive) and the gate stays closed for everyone.
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ExecutionError } from './errors.js';
import { findOnPath } from './runner.js';

export const SESSION_GATE_FILE = 'claude-session.lock';
const HANDOVER_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const EXIT_WAIT_MS = 5_000;
// The helper's lock statement, inserted into its source below: a string only the helper's own
// command line contains (the source is passed with -c).
const HELPER_MARKER = 'fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)';

// From the account database, not from HOME or XDG variables, so the CLI, the
// console and every terminal agree on the same file.
export function defaultSessionGatePath(): string {
  return join(userInfo().homedir, '.local', 'state', 'software-factory', SESSION_GATE_FILE);
}

const HELPER = String.raw`
import fcntl, json, os, stat, sys
CTL = 3
def reply(text):
    os.write(CTL, (text + '\n').encode())
path = sys.argv[1]
for attempt in range(3):
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    except OSError as error:
        reply('ERROR open ' + (error.strerror or 'failed'))
        sys.exit(70)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        reply('ERROR unsafe gate file')
        sys.exit(70)
    try:
        ${HELPER_MARKER}
    except BlockingIOError:
        reply('BUSY')
        sys.exit(75)
    try:
        current = os.lstat(path)
    except OSError:
        current = None
    if current is not None and (current.st_dev, current.st_ino) == (info.st_dev, info.st_ino):
        break
    # The file was removed or replaced since it was opened: lock what the path names now.
    os.close(fd)
else:
    reply('ERROR gate file keeps changing')
    sys.exit(70)
os.ftruncate(fd, 0)
os.write(fd, json.dumps({'pid': os.getpid()}).encode())
os.set_inheritable(CTL, False)
reply('HELD')
try:
    data = b''
    while not data.endswith(b'\n'):
        chunk = os.read(CTL, 65536)
        if not chunk:
            sys.exit(0)
        data += chunk
    request = json.loads(data)
    os.set_inheritable(fd, True)
    os.chdir(request['cwd'])
    os.execve(request['executable'], [request['executable']] + request['args'], request['env'])
except SystemExit:
    raise
except BaseException as error:
    reply('EXECFAIL ' + (getattr(error, 'strerror', None) or type(error).__name__))
    sys.exit(71)
`;

export interface GateLaunch {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };

export interface GateHeld {
  // The helper's pid (the launched command keeps it).
  readonly pid: number;
  // Replaces the holder with the command; the returned pid is the command's own. Throws
  // runner_unavailable (confirmed not started) or launch_unconfirmed (hand-over not confirmed).
  launch(target: GateLaunch): Promise<{ pid: number; exited: Promise<ProcessExit>; streams?: GateStreams }>;
  // Gives the gate back without launching (no-op after a launch).
  release(): Promise<void>;
}

// The launched command's stdin, stdout and stderr, when the reservation was made with 'pipe' (SF-009).
export interface GateStreams {
  input: Writable;
  output: Readable;
  errors: Readable;
}

export type GateBusy = { busy: true; holderPids: number[] };
export type GateReservation = { held: GateHeld } | GateBusy;

// Bounds of every wait on a helper (Review 03), and test seams.
export interface SessionGateOptions {
  // A launch: from the request to the hand-over (default 30 s).
  handoverTimeoutMs?: number;
  // A reservation: from the helper's start to its first answer, HELD, BUSY or ERROR (default 10 s).
  handshakeTimeoutMs?: number;
  // Any wait for a helper to exit: after an answer, a release or a signal (default 5 s).
  exitWaitMs?: number;
  // Test seams only (fault injection; production callers never set them): the interpreter that
  // runs the helper, and how a helper is signalled.
  python?: string;
  signal?: (child: ChildProcess, signal: NodeJS.Signals) => void;
}

type Settings = Required<Omit<SessionGateOptions, 'python'>> & { python: string | undefined };

export class SessionGate {
  readonly path: string;

  readonly #settings: Settings;

  constructor(path: string, options: SessionGateOptions = {}) {
    this.path = path;
    this.#settings = {
      handoverTimeoutMs: options.handoverTimeoutMs ?? HANDOVER_TIMEOUT_MS,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
      exitWaitMs: options.exitWaitMs ?? EXIT_WAIT_MS,
      python: options.python,
      signal: options.signal ?? ((child, signal) => child.kill(signal)),
    };
  }

  async available(): Promise<boolean> {
    return (await findOnPath('python3')) !== undefined;
  }

  // The gate's directory (0700, this user's) and file (regular, 0600, this user's), created if
  // missing. flock(1) in a handed-off command would otherwise create the file with the umask.
  async ensure(): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stats = await lstat(dir);
    if (!stats.isDirectory() || stats.uid !== process.getuid!() || (stats.mode & 0o022) !== 0) {
      throw new ExecutionError('io_failed', 'The Claude session gate directory must be owned by you and not writable by others; nothing was started.');
    }
    const handle = await open(this.path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600).catch(() => undefined);
    if (handle === undefined) throw new ExecutionError('io_failed', 'The Claude session gate file cannot be opened; nothing was started.');
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.uid !== process.getuid!() || (file.mode & 0o077) !== 0) {
        throw new ExecutionError('io_failed', 'The Claude session gate file must be a private (0600) file of yours; nothing was started.');
      }
    } finally {
      await handle.close();
    }
  }

  // Takes the gate now, or reports who holds it. stdio is what the launched command will get
  // ('pipe': the helper writes nothing there, so the pipes belong to the command after exec).
  async reserve(stdio: 'inherit' | 'ignore' | 'pipe'): Promise<GateReservation> {
    const python = this.#settings.python ?? (await findOnPath('python3'));
    if (python === undefined) {
      throw new ExecutionError('runner_unavailable', 'python3 is required for the Claude session gate; nothing was started.');
    }
    await this.ensure();
    const child = spawn(python, ['-I', '-c', HELPER, this.path], { stdio: [stdio, stdio, stdio, 'pipe'] });
    // Any later process error (e.g. a failed kill) is settled through the paths below, never unhandled.
    child.on('error', () => undefined);
    const exited = new Promise<ProcessExit>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', () => resolve({ code: null, signal: null }));
    });
    const started = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (!started) throw new ExecutionError('runner_unavailable', 'The Claude session gate helper could not be started; nothing was started.');
    const control = child.stdio[3] as Readable & Writable;
    const lines = controlLines(control);
    const stop = () => this.#stopHelper(child, control, exited);
    const first = await within(lines.next(), this.#settings.handshakeTimeoutMs);
    if (first === TIMED_OUT) {
      // Silent (stopped or stuck) before its first answer: it was never told to exec, so it is stopped.
      const outcome = await stop();
      throw unresponsive(outcome, `did not answer within ${seconds(this.#settings.handshakeTimeoutMs)}`, child.pid!);
    }
    if (first === 'HELD') return { held: holder(child, control, lines, exited, await helperIdentity(child.pid!), this.#settings, stop) };
    // BUSY or ERROR: this helper reports that it took no lock. If it lingers, it is stopped and the
    // answer stands; if it cannot be shown stopped, that is not assumed and the call fails closed (Review 06).
    if ((await within(exited, this.#settings.exitWaitMs)) === TIMED_OUT && (await stop()) === 'uncertain') {
      const what = first === undefined ? 'closed its control channel' : `answered ${first}`;
      throw unresponsive('uncertain', `${what} but did not end within ${seconds(this.#settings.exitWaitMs)}`, child.pid!);
    }
    if (first === 'BUSY') return { busy: true, holderPids: await this.holders() };
    throw new ExecutionError('io_failed', `The Claude session gate could not be taken (${first ?? 'helper ended'}); nothing was started.`);
  }

  // Stops a helper that was not, or not successfully, told to exec Claude (silent before HELD,
  // lingering after BUSY/ERROR/EXECFAIL, or stuck in release): SIGKILL, also effective on a stopped
  // process, then a bounded wait. Released only when its exit was observed and /proc/locks, read
  // successfully, shows no lock of its pid; uncertain otherwise (e.g. a process stuck in the
  // kernel, or the lock table unreadable), so that the caller fails closed.
  async #stopHelper(child: ChildProcess, control: Readable & Writable, exited: Promise<ProcessExit>): Promise<'released' | 'uncertain'> {
    control.destroy();
    try {
      this.#settings.signal(child, 'SIGKILL');
    } catch {
      // Already gone; verified below.
    }
    const exit = await within(exited, this.#settings.exitWaitMs);
    const locks = await this.#lockHolders();
    return exit !== TIMED_OUT && locks !== undefined && !locks.includes(child.pid!) ? 'released' : 'uncertain';
  }

  // The pids holding the gate in /proc/locks, or undefined when that cannot be read.
  async #lockHolders(): Promise<number[] | undefined> {
    let inode: number;
    try {
      inode = (await lstat(this.path)).ino;
    } catch {
      return undefined;
    }
    let table: string;
    try {
      table = await readFile('/proc/locks', 'utf8');
    } catch {
      return undefined;
    }
    const pids = new Set<number>();
    for (const row of table.split('\n')) {
      const fields = row.trim().split(/\s+/);
      // "1: FLOCK  ADVISORY  WRITE 1234 fd:01:5638189 0 EOF"; blocked waiters are marked "->".
      if (fields[1] !== 'FLOCK' || fields.includes('->')) continue;
      const location = fields[5]?.split(':');
      if (location?.length === 3 && Number(location[2]) === inode) pids.add(Number(fields[4]));
    }
    return [...pids].sort((a, b) => a - b);
  }

  // Who holds the gate right now, read from /proc/locks without taking it: the pid that took the
  // lock (a Claude session, or the helper about to become one). Empty when it is free.
  async holders(): Promise<number[]> {
    return (await this.#lockHolders()) ?? [];
  }

  // The command a person runs by hand for a handed-off session: claude under flock(1) on the
  // same gate, refusing at once (exit 75) while another session holds it.
  gatedCommand(command: readonly string[]): string[] {
    return ['flock', '--nonblock', '--conflict-exit-code', '75', this.path, ...command];
  }
}

// What a busy gate means, for messages: who holds it, never a path.
export function describeHolder(holderPids: readonly number[]): string {
  return `another Claude session holds the session gate${holderPids.length > 0 ? ` (pid ${holderPids.join(', ')}, or a process it started)` : ''}`;
}

interface ControlLines {
  // The next line, or undefined when the channel closed (the helper exec'd or exited).
  next(): Promise<string | undefined>;
}

function controlLines(control: Readable): ControlLines {
  let buffer = '';
  let closed = false;
  const waiting: Array<() => void> = [];
  const wake = () => waiting.splice(0).forEach((resolve) => resolve());
  control.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    wake();
  });
  for (const event of ['end', 'close', 'error']) {
    control.on(event, () => {
      closed = true;
      wake();
    });
  }
  return {
    async next() {
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          return line;
        }
        if (closed) return undefined;
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    },
  };
}

// The helper as first seen: its start time (kept across exec, new for a reused pid) and executable.
export interface HelperIdentity {
  pid: number;
  start: string;
  exe: string | undefined;
}

async function startTime(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // Field 22 (start time). A zombie still has it; a reaped or reused pid does not match.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

const exeOf = (pid: number): Promise<string | undefined> => readlink(`/proc/${pid}/exe`).catch(() => undefined);

export async function helperIdentity(pid: number): Promise<HelperIdentity | undefined> {
  const start = await startTime(pid);
  return start === undefined ? undefined : { pid, start, exe: await exeOf(pid) };
}

// After the control channel closed: did the helper's own process switch to another program?
//   launched      the same process (same start time) runs another executable, or its argument
//                 list no longer is the helper's: execve() replaced the image (/proc/<pid>/exe
//                 changes inside execve before close-on-exec descriptors are closed);
//   gone          it has exited (also as an unreaped zombie, whose exe cannot be read) or the
//                 pid now belongs to another process;
//   undetermined  still alive but neither could be established within about 2 s (re-checked,
//                 never waited on beyond that).
export async function handoverEvidence(helper: HelperIdentity, hasExited: () => boolean): Promise<'launched' | 'gone' | 'undetermined'> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (hasExited()) return 'gone';
    const [start, exe, cmdline] = await Promise.all([
      startTime(helper.pid),
      exeOf(helper.pid),
      readFile(`/proc/${helper.pid}/cmdline`, 'utf8').catch(() => ''),
    ]);
    if (start !== helper.start || hasExited()) return 'gone';
    if (exe === undefined) return 'gone';
    if (helper.exe !== undefined && exe !== helper.exe) return 'launched';
    if (cmdline.length > 0 && !cmdline.includes(HELPER_MARKER)) return 'launched';
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return 'undetermined';
}

const describeExit = (exit: ProcessExit | typeof TIMED_OUT): string =>
  exit === TIMED_OUT ? 'no exit observed' : exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`;

const TIMED_OUT = Symbol('timed out');
// A promise's value, or TIMED_OUT after ms; the timer never outlives the race.
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([promise, new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms)))]);
  clearTimeout(timer);
  return result;
}

const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))} s`;

// A helper that had to be stopped: whether the gate is free again is stated, never assumed.
function unresponsive(outcome: 'released' | 'uncertain', what: string, pid: number): ExecutionError {
  return new ExecutionError(
    'gate_unresponsive',
    outcome === 'released'
      ? `The session gate helper ${what} and was stopped; the gate is free again. Nothing was started; try again.`
      : `The session gate helper (pid ${pid}) ${what} and could not be shown to have stopped; it may still hold the session gate, so no session can start. ` +
          'Nothing was started. Find and end the holder yourself (see the runbook, "The gate stays busy").',
  );
}

function holder(
  child: ChildProcess,
  control: Readable & Writable,
  lines: ControlLines,
  exited: Promise<ProcessExit>,
  identity: HelperIdentity | undefined,
  settings: Settings,
  stop: () => Promise<'released' | 'uncertain'>,
): GateHeld {
  const { handoverTimeoutMs, exitWaitMs } = settings;
  let used = false;
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  return {
    pid: child.pid!,
    async launch(target) {
      if (used) throw new ExecutionError('wrong_state', 'The session gate reservation was already used.');
      used = true;
      // A helper that is already gone makes the write fail; the closed channel is evaluated below.
      control.write(`${JSON.stringify(target)}\n`, () => undefined);
      const answer = await within(lines.next(), handoverTimeoutMs);
      if (answer === TIMED_OUT) {
        // The request was delivered: the helper may be about to become, or already be, Claude Code.
        // It is never killed here; it keeps the gate until it ends, so no other session starts.
        throw new ExecutionError(
          'launch_unconfirmed',
          `The session gate helper (pid ${child.pid}) did not hand over to Claude Code within ${seconds(handoverTimeoutMs)}. It was left running and keeps the session gate; whether Claude Code started could not be confirmed.`,
        );
      }
      if (answer !== undefined) {
        // EXECFAIL or ERROR: nothing was exec'd. A helper that lingers is stopped and the gate verified.
        let note = '';
        if ((await within(exited, exitWaitMs)) === TIMED_OUT && (await stop()) === 'uncertain') {
          note = ` The helper (pid ${child.pid}) could not be shown to have stopped and may still hold the session gate (see the runbook, "gate_unresponsive").`;
        }
        throw new ExecutionError('runner_unavailable', `Claude Code could not be started (${answer.replace(/^(EXECFAIL|ERROR) /, '')}).${note}`);
      }
      // The control channel closed: confirmed only if the helper's own process now runs another program.
      const evidence = identity === undefined ? 'gone' : await handoverEvidence(identity, hasExited);
      if (evidence === 'launched') {
        const streams = child.stdin && child.stdout && child.stderr ? { input: child.stdin, output: child.stdout, errors: child.stderr } : undefined;
        return { pid: child.pid!, exited, ...(streams ? { streams } : {}) };
      }
      if (evidence === 'undetermined') {
        // Alive, but not shown to be Claude Code: not waited on, not killed (it may be the session).
        throw new ExecutionError(
          'launch_unconfirmed',
          `The hand-over to Claude Code could not be confirmed (pid ${child.pid} is still running, but not shown to be Claude Code); whether Claude Code started is unknown.`,
        );
      }
      const exit = await within(exited, exitWaitMs);
      throw new ExecutionError(
        'launch_unconfirmed',
        `The session gate helper ended (${describeExit(exit)}) before its hand-over to Claude Code could be confirmed; whether Claude Code started is unknown.`,
      );
    },
    // Bounded: a helper that does not exit after EOF was never told to exec, so it is stopped;
    // if it may still hold the gate, release fails closed (gate_unresponsive).
    async release() {
      if (used) return;
      used = true;
      control.end();
      if ((await within(exited, exitWaitMs)) !== TIMED_OUT) return;
      const outcome = await stop();
      if (outcome === 'uncertain') throw unresponsive(outcome, `did not end within ${seconds(exitWaitMs)} after its release`, child.pid!);
    },
  };
}
