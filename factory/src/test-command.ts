// The workspace's test command: run by the factory itself before a job is ready, as the
// first step of MR preparation, on the reviewed worktree. The command is Implementer-written code
// to the factory, so it never runs outside a bubblewrap (bwrap) sandbox the factory builds: the
// whole file system read-only, the paths of the job's path denials (src/sandbox-denials.ts)
// hidden, only the worktree (but its .git) and a private /tmp writable, no network but loopback, an
// environment of PATH, LANG, CI, HOME, TMPDIR and npm_config_cache only. A run that changes the
// worktree's .git or agent configuration (.claude, .mcp.json, .codex) failed, whatever its exit:
// the runner compares a fingerprint of them taken before and after it; a run where one of them is
// a link does not start, and failed. The private /tmp of each run is a tmpfs of the sandbox's own
// mount namespace, never a directory of the host: it goes with the sandbox, so a runner killed
// mid-run leaves nothing to clean. The sandbox dies with its parent
// (--die-with-parent, --unshare-pid), and a timeout or an abort kills its process group. Also the
// run's record (tests-<N>.json), the Fix section of a failure and the MR text's ### Checks lines.
// This module knows processes, text and the files of the worktree; it knows nothing about jobs.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { FactoryError } from './errors.js';

// The Tests Fix sections a job gets at most: once more records of the job say failed, the job stops
// (tests_failed).
export const TEST_FIX_ROUNDS = 2;

// The output a record keeps: its last 64 KiB and, when that is not all of it, its first 8 KiB, so
// what a test command prints first (a code check's warnings and summary) stays in the record.
export const MAX_TESTS_OUTPUT_BYTES = 64 * 1024;
export const MAX_TESTS_OUTPUT_HEAD_BYTES = 8 * 1024;

// What a Fix section quotes of the output: its last 150 lines, at most 12 KiB.
export const FIX_TAIL_LINES = 150;
export const FIX_TAIL_BYTES = 12 * 1024;

// What a tests event carries of the output for the Stream: its last 40 lines, at most 4 KiB.
export const EVENT_TAIL_LINES = 40;
export const EVENT_TAIL_BYTES = 4 * 1024;

// How often a run compares the clock with its deadline: Node's timers count only the time
// the machine is awake, so a run the machine slept through ends within this long of the resume.
export const DEADLINE_CHECK_MS = 1000;

// The longest test_command of workspaces.json.
export const MAX_TEST_COMMAND_CHARS = 2000;

// The stop codes of the test step: the tests failed after the Tests Fix rounds, or could not run.
export const TESTS_FAILED = 'tests_failed';
export const TESTS_UNAVAILABLE = 'tests_unavailable';
export const TEST_CODES: readonly string[] = [TESTS_FAILED, TESTS_UNAVAILABLE];

// The exit codes of a shell that could not run the command (not executable, not found).
const UNAVAILABLE_EXITS = [126, 127];

// How a run ended: passed, failed (an exit other than 0, 126 and 127, or the timeout), unavailable
// (it could not run), or accepted_failing (the user accepted it without passing tests).
export const TESTS_OUTCOMES = ['passed', 'failed', 'unavailable', 'accepted_failing'] as const;
export type TestsOutcome = (typeof TESTS_OUTCOMES)[number];

// One run of the test command (tests-<N>.json of the job, N the iteration it ran on).
export interface TestsRecord {
  command: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  // null after a timeout or when the sandbox never ran the command.
  exit_code: number | null;
  timed_out: boolean;
  outcome: TestsOutcome;
  // unavailable: why the command could not run.
  reason?: string;
  // stdout and stderr together, as they came: all of it, or past the bounds its first
  // MAX_TESTS_OUTPUT_HEAD_BYTES and its last MAX_TESTS_OUTPUT_BYTES in whole lines, with a line
  // between them saying how many bytes were left out (KeptOutput).
  output: string;
  output_truncated: boolean;
  // accepted_failing: when the user accepted, and what the run's outcome was.
  accepted_at?: string;
  accepted_from?: 'failed' | 'unavailable';
}

// What a run returns: its record, or aborted (the controller's abort; nothing of it applies but
// changed, the first watched path it changed, if any).
export type TestsResult = { aborted: false; record: TestsRecord } | { aborted: true; changed?: string };

// A hidden path as the sandbox mounts it: an empty read-only directory, or /dev/null for a file.
export interface HiddenMount {
  path: string;
  directory: boolean;
}

// The fields of a record a run decides; the command and the times are runTestCommand's.
type Ending = Pick<TestsRecord, 'exit_code' | 'timed_out' | 'outcome'> & { reason?: string; output?: string; output_truncated?: boolean };

// One run of runTestCommand: the command, where, what is hidden, how long, and what cancels it.
export interface TestRun {
  command: string;
  // The worktree: the command's working directory, writable.
  cwd: string;
  // The paths hidden in the sandbox (the job's path denials, read and write): directories as an
  // empty read-only directory, files as /dev/null.
  hidden: readonly string[];
  // How long the run may take, by the clock (sleep of the machine included).
  timeoutMs: number;
  signal: AbortSignal;
  // The clock of the record's times and of the limit, in ms (default: Date.now).
  now?: () => number;
  // The environment the PATH, LANG and HOME come from (default: process.env).
  env?: NodeJS.ProcessEnv;
}

// The sandbox's shell: tells the runner on fd 3 that the sandbox started, closes fd 3, then runs
// the command ($1) in a shell of its own.
const START_SCRIPT = 'printf started >&3; exec 3>&-; exec /bin/sh -c "$1"';

// Whether path is inside dir or dir itself (both absolute, resolved).
export function within(path: string, dir: string): boolean {
  const inside = relative(dir, path);
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

// The hidden paths as the sandbox mounts them: each by its real path, once, without the paths inside
// a hidden directory (the empty directory over it already hides them), none that is or holds the
// worktree; directories marked. A path that is gone is left out.
export async function hiddenMounts(paths: readonly string[], cwd: string): Promise<HiddenMount[]> {
  const found: HiddenMount[] = [];
  for (const path of paths) {
    const real = await realpath(path).catch(() => undefined);
    const info = real === undefined ? undefined : await stat(real).catch(() => undefined);
    if (real !== undefined && info !== undefined && !found.some((entry) => entry.path === real) && !within(cwd, real)) {
      found.push({ path: real, directory: info.isDirectory() });
    }
  }
  found.sort((a, b) => a.path.length - b.path.length);
  const kept: HiddenMount[] = [];
  for (const entry of found) {
    if (!kept.some((outer) => outer.directory && within(entry.path, outer.path))) {
      kept.push(entry);
    }
  }
  return kept;
}

// The runtime directories hidden in every run, whatever the path denials say: their Unix sockets
// (the user's D-Bus and systemd manager, the SSH and keyring agents, Docker) would reach past the
// sandbox, since a read-only mount does not refuse a connect() and the network namespace covers
// only abstract sockets. /var/run is a link to /run.
const RUNTIME_DIRS = ['/run'];

// The bwrap arguments of a run: the root read-only, a fresh /dev and /proc, a fresh tmpfs at /tmp
// (the run's private /tmp, in the sandbox's memory: it ends with the sandbox, however the runner
// ends) and the worktree writable but its .git (a file in a worktree, a folder in a checkout; none
// in a plain folder), then the runtime directories and the hidden paths over them all (a denied
// path inside the worktree stays hidden), then the start script with the command.
export function bwrapArgs(options: { command: string; cwd: string; hidden: readonly HiddenMount[] }): string[] {
  const args = ['--die-with-parent', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
  args.push('--tmpfs', '/tmp', '--bind', options.cwd, options.cwd, '--ro-bind-try', join(options.cwd, '.git'), join(options.cwd, '.git'));
  for (const entry of options.hidden) {
    args.push(...(entry.directory ? ['--tmpfs', entry.path, '--remount-ro', entry.path] : ['--ro-bind', '/dev/null', entry.path]));
  }
  args.push('--chdir', options.cwd);
  return [...args, '--', '/bin/sh', '-c', START_SCRIPT, 'sh', options.command];
}

// The worktree's agent configuration, which the next Claude Code or Codex session in the worktree
// loads, outside any sandbox for its hooks and MCP servers.
export const AGENT_CONFIG = ['.claude', '.mcp.json', '.codex'] as const;
// What a test run may not change: the worktree's link to Git (its config runs commands in the
// factory's own Git calls), then the agent configuration.
export const WATCHED_PATHS = ['.git', ...AGENT_CONFIG] as const;

// The watched paths of a worktree, absolute. A link that leads nowhere among them could not be
// denied for writing and could be replaced: it throws WATCHED_PATH_UNSAFE.
export async function watchedPaths(worktree: string): Promise<string[]> {
  const paths = WATCHED_PATHS.map((name) => join(worktree, name));
  for (const path of paths) {
    const info = await lstat(path).catch(() => undefined);
    if (info?.isSymbolicLink() === true && (await stat(path).catch(() => undefined)) === undefined) {
      throw new FactoryError(WATCHED_PATH_UNSAFE, `${path} is a link that leads nowhere, so no sandbox can keep it from being replaced; remove it or make it lead to a real file or folder.`);
    }
  }
  return paths;
}
export const WATCHED_PATH_UNSAFE = 'watched_path_unsafe';

// A fingerprint: each path (relative to the worktree) with its kind; a file's size, mtime, SHA-256.
export type Fingerprint = Map<string, string>;

// The fingerprint of WATCHED_PATHS under cwd (a real path): each path, each entry of a folder below
// it, every one, a missing path as absent, an unreadable one by its error. A link is its target,
// followed only into cwd (outside it the sandbox writes nothing that stays). Never throws.
export async function configFingerprint(cwd: string): Promise<Fingerprint> {
  const found: Fingerprint = new Map();
  const seen = new Set<string>();
  for (const name of WATCHED_PATHS) {
    await addEntries(cwd, name, found, seen);
  }
  return found;
}

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? 'error';

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

// Adds the entry of name (relative to cwd) and, for a folder, of everything below it; seen: the
// real folders already walked (a loop of links ends there).
async function addEntries(cwd: string, name: string, found: Fingerprint, seen: Set<string>): Promise<void> {
  const path = join(cwd, name);
  let info = await lstat(path).catch((error: unknown) => errorCode(error));
  if (typeof info === 'string') {
    found.set(name, info === 'ENOENT' ? 'absent' : `unreadable ${info}`);
    return;
  }
  let link = '';
  if (info.isSymbolicLink()) {
    link = `link ${await readlink(path).catch(errorCode)} `;
    const real = await realpath(path).catch(() => undefined);
    const target = real === undefined || !within(real, cwd) ? undefined : await stat(real).catch(() => undefined);
    if (target === undefined) {
      found.set(name, link.trimEnd());
      return;
    }
    info = target;
  }
  if (info.isFile()) {
    found.set(name, `${link}file ${info.size} ${info.mtimeMs} ${await sha256(path).catch(errorCode)}`);
    return;
  }
  if (!info.isDirectory()) {
    found.set(name, `${link}other ${info.mode}`);
    return;
  }
  const real = await realpath(path).catch(() => path);
  if (seen.has(real)) {
    found.set(name, `${link}folder seen`);
    return;
  }
  seen.add(real);
  const names = await readdir(path).catch(errorCode);
  found.set(name, `${link}folder${typeof names === 'string' ? ` unreadable ${names}` : ''}`);
  for (const entry of typeof names === 'string' ? [] : names.sort()) {
    await addEntries(cwd, `${name}/${entry}`, found, seen);
  }
}

// The first path (in order) whose entry differs between two fingerprints, or undefined.
export function firstChange(before: Fingerprint, after: Fingerprint): string | undefined {
  return [...new Set([...before.keys(), ...after.keys()])].sort().find((path) => before.get(path) !== after.get(path));
}

// Why a run that changed path failed.
export const configChangedReason = (path: string): string =>
  `the test run changed ${path}: the factory does not let a test run change .git, .claude, .mcp.json or .codex`;

// The only environment of a run: PATH and LANG as the factory has them, CI, the real HOME (read-only
// in the sandbox) and the private /tmp for TMPDIR and npm's cache. No SF_* variable, no value of
// the env file.
export function testEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: env.LANG || 'C.UTF-8',
    CI: '1',
    HOME: env.HOME || homedir(),
    TMPDIR: '/tmp',
    npm_config_cache: '/tmp/npm-cache',
  };
}

// The output a record keeps, as it comes: all of it within the bounds; past them its first
// headLimit bytes cut back to a whole line, a line saying how many bytes were left out, and its
// last tailLimit bytes cut forward to a whole line (a part with no line end is kept whole).
export class KeptOutput {
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #head: Buffer[] = [];
  #headBytes = 0;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #dropped = 0;
  truncated = false;

  constructor(headLimit: number, tailLimit: number) {
    this.#headLimit = headLimit;
    this.#tailLimit = tailLimit;
  }

  push(chunk: Buffer): void {
    const room = this.#headLimit - this.#headBytes;
    if (room > 0) {
      this.#head.push(chunk.subarray(0, room));
      this.#headBytes += Math.min(room, chunk.length);
      chunk = chunk.subarray(room);
    }
    if (chunk.length === 0) {
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    while (this.#bytes - this.#chunks[0]!.length >= this.#tailLimit) {
      this.#dropped += this.#chunks[0]!.length;
      this.#bytes -= this.#chunks.shift()!.length;
    }
  }

  text(): string {
    const head = Buffer.concat(this.#head);
    let tail = Buffer.concat(this.#chunks);
    if (this.#dropped === 0 && tail.length <= this.#tailLimit) {
      return cleanOutput(Buffer.concat([head, tail]).toString('utf8'));
    }
    this.truncated = true;
    tail = tail.subarray(tail.length - this.#tailLimit);
    const tailStart = tail.indexOf(0x0a) + 1;
    const kept = tailStart > 0 && tailStart < tail.length ? tail.subarray(tailStart) : tail;
    const headEnd = head.lastIndexOf(0x0a) + 1;
    const first = headEnd > 0 ? head.subarray(0, headEnd) : head;
    const left = this.#headBytes + this.#dropped + this.#bytes - first.length - kept.length;
    const gap = `${first.length > 0 && headEnd === 0 ? '\n' : ''}[${left} bytes of the output left out]\n`;
    return cleanOutput(`${first.toString('utf8')}${gap}${kept.toString('utf8')}`);
  }
}

// Output as text the records, the Task file and the Stream can hold: no NUL, no ANSI escape
// sequences, LF line ends.
function cleanOutput(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '').replace(/\r\n?/gu, '\n').replace(/\0/gu, '');
}

// The last line of the sandbox's own error output (bwrap: …), on one line, at most 300 characters.
function sandboxError(stderr: string): string | undefined {
  const line = stderr.split('\n').map((entry) => entry.trim()).filter((entry) => entry !== '').at(-1);
  return line === undefined ? undefined : line.slice(0, 300);
}

// Runs the command once in the sandbox. Never throws: bwrap missing, a sandbox that does not start or
// a spawn error is unavailable, and so is exit 126 or 127; exit 0 passed; any other exit or the
// timeout failed. The controller's abort kills the run and returns aborted.
export async function runTestCommand(run: TestRun): Promise<TestsResult> {
  const clock = run.now ?? Date.now;
  const startedAt = new Date(clock());
  const finish = (fields: Ending): TestsResult => {
    const ended = new Date(clock());
    return {
      aborted: false,
      record: {
        command: run.command, started_at: startedAt.toISOString(), ended_at: ended.toISOString(), duration_ms: ended.getTime() - startedAt.getTime(),
        exit_code: fields.exit_code, timed_out: fields.timed_out, outcome: fields.outcome, ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
        output: fields.output ?? '', output_truncated: fields.output_truncated ?? false,
      },
    };
  };
  if (run.signal.aborted) {
    return { aborted: true };
  }
  let cwd: string;
  let hidden: HiddenMount[];
  try {
    cwd = await realpath(run.cwd);
    hidden = await hiddenMounts([...RUNTIME_DIRS, ...run.hidden], cwd);
  } catch (error) {
    return finish({ exit_code: null, timed_out: false, outcome: 'unavailable', reason: `the sandbox could not be prepared: ${(error as Error).message}`.slice(0, 300) });
  }
  // A watched path that is a link: the fingerprint could not hold what it leads to.
  for (const name of WATCHED_PATHS) {
    if ((await lstat(join(cwd, name)).catch(() => undefined))?.isSymbolicLink() === true) {
      return finish({ exit_code: null, timed_out: false, outcome: 'failed', reason: `the test run did not start: ${name} is a link` });
    }
  }
  const before = await configFingerprint(cwd);
  const result = await sandboxed(run, cwd, hidden, { clock, deadline: startedAt.getTime() + run.timeoutMs }, finish);
  const changed = firstChange(before, await configFingerprint(cwd));
  if (result.aborted) {
    return changed === undefined ? result : { aborted: true, changed };
  }
  return changed === undefined ? result : { aborted: false, record: { ...result.record, outcome: 'failed', reason: configChangedReason(changed) } };
}

// The run in bwrap itself, with the worktree and the hidden paths prepared, until the deadline (ms of
// the clock); finish makes the record of how it ended.
async function sandboxed(run: TestRun, cwd: string, hidden: readonly HiddenMount[], limit: { clock: () => number; deadline: number }, finish: (fields: Ending) => TestsResult): Promise<TestsResult> {
  const output = new KeptOutput(MAX_TESTS_OUTPUT_HEAD_BYTES, MAX_TESTS_OUTPUT_BYTES);
  let stderr = '';
  let started = false;
  let timedOut = false;
  let aborted = false;
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | { spawnError: Error }>((resolve) => {
    // Detached: the run's process group is the sandbox's, killed whole. The environment is the
    // sandbox's, so nothing else of the factory's reaches bwrap or the command.
    const child = spawn('bwrap', bwrapArgs({ command: run.command, cwd, hidden }), {
      cwd, env: testEnvironment(run.env), stdio: ['ignore', 'pipe', 'pipe', 'pipe'], detached: true,
    });
    const killGroup = (): void => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch { // the group is already gone
      }
    };
    const expire = (): void => {
      timedOut = true;
      killGroup();
    };
    // The limit by the clock: Node's timers stand still while the machine is suspended, so a
    // run the machine slept through past its deadline ends within DEADLINE_CHECK_MS of the resume.
    // The timer of the whole limit stays, for a clock that is set back; a clock set forward past the
    // deadline ends the run early, as a sleep would (Node has no clock that counts a suspend).
    const timer = setTimeout(expire, run.timeoutMs);
    const check = setInterval(() => {
      if (limit.clock() >= limit.deadline) {
        expire();
      }
    }, DEADLINE_CHECK_MS);
    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };
    run.signal.addEventListener('abort', onAbort, { once: true });
    // An abort while the sandbox was being prepared fired before the listener.
    if (run.signal.aborted) {
      onAbort();
    }
    // The runner does not leave a run behind it (--die-with-parent covers a runner that is killed).
    process.once('exit', killGroup);
    child.stdout!.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => {
      output.push(chunk);
      if (!started && stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });
    (child.stdio[3] as NodeJS.ReadableStream).on('data', () => {
      started = true;
    });
    const done = (value: { code: number | null; signal: NodeJS.Signals | null } | { spawnError: Error }): void => {
      clearTimeout(timer);
      clearInterval(check);
      run.signal.removeEventListener('abort', onAbort);
      process.off('exit', killGroup);
      resolve(value);
    };
    child.once('error', (error) => done({ spawnError: error }));
    child.once('close', (code, signal) => done({ code, signal }));
  });
  if (aborted) {
    return { aborted: true };
  }
  const tail = { output: output.text(), output_truncated: output.truncated };
  if ('spawnError' in ended) {
    const missing = (ended.spawnError as NodeJS.ErrnoException).code === 'ENOENT';
    return finish({ exit_code: null, timed_out: false, outcome: 'unavailable', reason: missing ? 'bwrap is not installed' : `bwrap could not be started: ${ended.spawnError.message}`.slice(0, 300), ...tail });
  }
  if (timedOut) {
    return finish({ exit_code: null, timed_out: true, outcome: 'failed', ...tail });
  }
  if (!started) {
    const said = sandboxError(cleanOutput(stderr));
    return finish({ exit_code: ended.code, timed_out: false, outcome: 'unavailable', reason: `the sandbox did not start${said !== undefined ? `: ${said}` : ended.code !== null ? ` (exit ${ended.code})` : ''}`, ...tail });
  }
  if (ended.code === 0) {
    return finish({ exit_code: 0, timed_out: false, outcome: 'passed', ...tail });
  }
  if (ended.code !== null && UNAVAILABLE_EXITS.includes(ended.code)) {
    const reason = ended.code === 127 ? 'the command was not found (exit 127)' : 'the command could not be executed (exit 126)';
    return finish({ exit_code: ended.code, timed_out: false, outcome: 'unavailable', reason, ...tail });
  }
  return finish({ exit_code: ended.code, timed_out: false, outcome: 'failed', ...tail });
}

// A duration in words: "12 s", "4 min 12 s", "2 min", "1 h 5 min".
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`;
  }
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

// How a failed run ended: "exit 1", "timed out after 30 min", "killed after 7 h" (a signal from
// outside the factory, or the kernel, ended the sandbox: no exit code, no timeout), or the reason
// it failed whatever its exit (it changed the agent configuration).
export function failureText(record: Pick<TestsRecord, 'exit_code' | 'timed_out' | 'duration_ms' | 'reason'>): string {
  if (record.reason !== undefined) {
    return record.reason;
  }
  if (record.timed_out) {
    return `timed out after ${durationText(record.duration_ms)}`;
  }
  return record.exit_code === null ? `killed after ${durationText(record.duration_ms)}` : `exit ${record.exit_code}`;
}

// The last lines of a text, at most lines lines and bytes bytes (whole lines; the last line cut from
// its start when it alone is longer).
export function lastLines(text: string, lines: number, bytes: number): string {
  const all = text.replace(/\n+$/u, '').split('\n');
  const kept: string[] = [];
  let size = 0;
  for (let index = all.length - 1; index >= 0 && kept.length < lines; index -= 1) {
    const line = all[index]!;
    const length = Buffer.byteLength(line, 'utf8') + 1;
    if (size + length > bytes) {
      if (kept.length === 0) {
        kept.unshift(Buffer.from(line, 'utf8').subarray(-(bytes - 1)).toString('utf8').replace(/^�+/u, ''));
      }
      break;
    }
    kept.unshift(line);
    size += length;
  }
  return kept.join('\n');
}

// The longest run of backticks in text.
const longestTicks = (text: string): number => Math.max(0, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));

// A fence for text: one backtick more than its longest run of backticks, at least three.
function fence(text: string): string {
  return '`'.repeat(Math.max(3, longestTicks(text) + 1));
}

// A command as inline code on one line: its lines joined with " ", in enough backticks.
export function inlineCommand(command: string): string {
  const line = command.split(/\r?\n/u).map((part) => part.trim()).filter((part) => part !== '').join(' ');
  const ticks = '`'.repeat(longestTicks(line) + 1);
  const pad = line.startsWith('`') || line.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${line}${pad}${ticks}`;
}

// The Fix section of a failed run (titled Tests): the command, how it ended and the output's last
// lines in a fence.
export function testsFixContent(record: TestsRecord): string {
  const tail = lastLines(record.output, FIX_TAIL_LINES, FIX_TAIL_BYTES);
  const ending = record.timed_out
    ? `It timed out after ${durationText(record.duration_ms)} and was stopped.`
    : record.exit_code === null
      ? `It was killed by a signal after ${durationText(record.duration_ms)}, before it exited.`
      : `It exited with ${record.exit_code}.`;
  const why = record.reason === undefined ? '' : ` It failed because ${record.reason}.`;
  const lines = [
    `The factory ran the workspace's test command on your worktree, in a sandbox without network, and it failed: ${inlineCommand(record.command)}. ${ending}${why} Make the tests pass; do not weaken or skip a test to get there.`,
    '',
  ];
  if (tail === '') {
    lines.push('The command wrote no output.');
  } else {
    const marks = fence(tail);
    lines.push(`The last lines of its output${record.output_truncated || tail !== record.output.replace(/\n+$/u, '') ? '' : ' (all of it)'}:`, '', `${marks}text`, tail, marks);
  }
  return lines.join('\n');
}

// The ### Checks line of the MR text for the record of the iteration the MR is prepared from.
export function checksLine(record: TestsRecord, iteration: number): string {
  const command = inlineCommand(record.command);
  if (record.outcome === 'passed') {
    return `- ${command}: passed in ${durationText(record.duration_ms)} on iteration ${iteration}.`;
  }
  if (record.outcome === 'accepted_failing' && record.accepted_from === 'unavailable') {
    return `- ${command}: could not run (${record.reason ?? 'unknown reason'}); accepted by the user without tests.`;
  }
  if (record.outcome === 'accepted_failing') {
    return `- ${command}: failed (${failureText(record)}); accepted by the user without passing tests.`;
  }
  if (record.outcome === 'unavailable') {
    return `- ${command}: could not run (${record.reason ?? 'unknown reason'}).`;
  }
  return `- ${command}: failed (${failureText(record)}).`;
}
