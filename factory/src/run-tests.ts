// The test runner behind npm test and npm run test:browser (SF-108), started by
// scripts/run-tests.mjs. It runs each test file as its own `node --test <file>` child, at most N at
// once (half the cores), each at nice 10, which the test processes it starts inherit, so the
// user's IDE stays responsive while the suite runs. Since SF-152 each child is detached (a process
// group of its own) and has SF_TEST_FILE_TIMEOUT_MS (5 minutes by default): a file that runs
// longer is killed, with every process below it and every process of its mark (RUN_MARK), and the
// run fails, so one file cannot hold the suite forever; so is a file whose output processes it left
// still hold open after it exited. A child's output is printed whole: a passing file's when it ends, a failing
// file's at the end of the run. A failing file never exits 0.
import { spawn } from 'node:child_process';
import { globSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Mode = 'unit' | 'browser';

type Env = Record<string, string | undefined>;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// What main needs of a child process: its pid, its output and its events ('error', 'exit', 'close').
export type ChildLike = {
  readonly pid?: number | undefined;
  readonly stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  readonly stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

// How main spawns a child: detached, its output piped, in env with the run's compile cache and its
// own RUN_MARK.
export type SpawnOptions = { cwd: string; env: Env; detached: true; stdio: ['ignore', 'pipe', 'pipe'] };

export type RunTestsDeps = {
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildLike;
  setPriority: (pid: number, priority: number) => void;
  // Ends the child's process group and every process below the child, with SIGKILL.
  kill: (pid: number) => void;
  // The processes that carry RUN_MARK=mark (default: marked).
  marked?: (mark: string) => number[];
  // How long main waits for the child's output to close after it exited (default: CLOSE_GRACE_MS).
  closeGraceMs?: number;
  env: Env;
  cores: number;
  // run-tests' own lines (stderr); write: a child's output (stdout).
  log: (line: string) => void;
  write: (text: string) => void;
  // factory/, the directory the file globs are relative to.
  root?: string;
  // Calls stop on SIGINT or SIGTERM until the returned function is called.
  onInterrupt?: (stop: () => void) => () => void;
};

const MODES: Record<Mode, { flags: readonly string[]; files: string }> = {
  unit: { flags: ['--test-timeout=120000'], files: 'dist/test/*.test.js' },
  browser: { flags: [], files: 'dist/test/browser/*.test.js' },
};

const DEFAULT_NICE = 10;

// SF_TEST_FILE_TIMEOUT_MS: how long one test file may run.
export const DEFAULT_FILE_TIMEOUT_MS = 5 * 60_000;
// Node's compile cache of a run's processes, under root (SF-152): each sf process a test starts loads
// the same modules, and compiles them again without it. dist/ is removed by every build, and the
// cache with it.
export const COMPILE_CACHE_DIR = 'dist/.compile-cache';

// The longest delay a Node timer keeps (a longer one fires at once).
export const MAX_FILE_TIMEOUT_MS = 2 ** 31 - 1;

// How long main waits for a child's output to close after the child exited. A process the file left
// behind may hold it, one that escaped the child's group and tree too: after this the file failed,
// and those processes are killed (SF-152).
export const CLOSE_GRACE_MS = 5_000;

// factory/ (this file is dist/src/run-tests.js).
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function isMode(value: string | undefined): value is Mode {
  return value === 'unit' || value === 'browser';
}

// A positive integer setting: undefined when unset or empty, else the value or the error.
function positiveSetting(env: Env, name: string): Result<number | undefined> {
  const raw = env[name];
  if (raw === undefined || raw === '') return { ok: true, value: undefined };
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) {
    return { ok: false, error: `${name} must be a positive integer, not ${JSON.stringify(raw)}` };
  }
  return { ok: true, value };
}

// The number of test files run at once: half the cores rounded down, at least 1;
// SF_TEST_CONCURRENCY replaces it when set (empty counts as unset) to a positive integer.
export function concurrency(env: Env, cores: number): Result<number> {
  const set = positiveSetting(env, 'SF_TEST_CONCURRENCY');
  return set.ok ? { ok: true, value: set.value ?? Math.max(1, Math.floor(cores / 2)) } : set;
}

// How long one test file may run, in ms: DEFAULT_FILE_TIMEOUT_MS; SF_TEST_FILE_TIMEOUT_MS replaces
// it when set (empty counts as unset) to a positive integer up to MAX_FILE_TIMEOUT_MS.
export function fileTimeout(env: Env): Result<number> {
  const set = positiveSetting(env, 'SF_TEST_FILE_TIMEOUT_MS');
  if (set.ok && set.value !== undefined && set.value > MAX_FILE_TIMEOUT_MS) {
    return { ok: false, error: `SF_TEST_FILE_TIMEOUT_MS must be at most ${MAX_FILE_TIMEOUT_MS}, not ${set.value}` };
  }
  return set.ok ? { ok: true, value: set.value ?? DEFAULT_FILE_TIMEOUT_MS } : set;
}

// The nice value of the children: unset or empty is 10, exactly 0 skips the priority change.
export function niceValue(env: Env): Result<number> {
  const raw = env.SF_TEST_NICE;
  if (raw === undefined || raw === '') return { ok: true, value: DEFAULT_NICE };
  if (raw === '0') return { ok: true, value: 0 };
  return { ok: false, error: `SF_TEST_NICE must be unset (nice ${DEFAULT_NICE}) or 0 (no priority change), not ${JSON.stringify(raw)}` };
}

// A child's arguments: --test, the mode's flags, the caller's arguments, the file.
export function testArgs(mode: Mode, extra: readonly string[], file: string): string[] {
  return ['--test', ...MODES[mode].flags, ...extra, file];
}

// The mode's test files, relative to root and sorted, expanded without a shell.
export function testFiles(mode: Mode, root: string = PACKAGE_ROOT): string[] {
  return globSync(MODES[mode].files, { cwd: root }).map((file) => file.split('\\').join('/')).sort();
}

// The pids below pid (its children, theirs, and so on) as proc shows them now; none without proc.
export function descendants(pid: number, proc = '/proc'): number[] {
  const children = new Map<number, number[]>();
  let names: string[];
  try {
    names = readdirSync(proc);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(join(proc, name, 'stat'), 'utf8');
    } catch {
      continue;
    }
    // "<pid> (<comm>) <state> <ppid> …"; comm may hold spaces and parentheses.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    children.set(ppid, [...(children.get(ppid) ?? []), Number(name)]);
  }
  const found: number[] = [];
  for (let queue = [pid]; queue.length > 0; ) {
    const next = children.get(queue.shift()!) ?? [];
    found.push(...next);
    queue.push(...next);
  }
  return found;
}

// Ends pid's process group and every process below pid, those that left the group (a detached
// server a test started) included. The tree is stopped first, until no new process shows up (a
// stopped process starts none, and its children stay its own), then all of it is killed.
export function killTree(pid: number, signal: (pid: number, signal: NodeJS.Signals) => void = process.kill, below: (pid: number) => number[] = descendants): void {
  const send = (target: number, name: NodeJS.Signals): void => {
    try {
      signal(target, name);
    } catch {
      // Already gone.
    }
  };
  const tree = new Set<number>([pid]);
  send(-pid, 'SIGSTOP');
  send(pid, 'SIGSTOP');
  for (let round = 0; round < 20; round += 1) {
    const found = below(pid).filter((entry) => !tree.has(entry));
    if (found.length === 0) break;
    for (const entry of found) {
      tree.add(entry);
      send(entry, 'SIGSTOP');
    }
  }
  send(-pid, 'SIGKILL');
  for (const entry of tree) send(entry, 'SIGKILL');
}

// The environment variable that marks the processes of one file's child (SF-152): every process it
// starts inherits it, one that left the child's group and tree too, unless it is given an
// environment without it. test/support/harness.ts passes it on to the sf processes it starts.
export const RUN_MARK = 'RUN_TESTS_MARK';

// The processes other than self that carry RUN_MARK=mark in their environment, as proc shows them now.
export function marked(mark: string, proc = '/proc', self = process.pid): number[] {
  const wanted = `${RUN_MARK}=${mark}`;
  const found: number[] = [];
  let names: string[];
  try {
    names = readdirSync(proc);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === self) continue;
    try {
      if (readFileSync(join(proc, name, 'environ'), 'utf8').split('\0').includes(wanted)) found.push(Number(name));
    } catch {
      // Gone, or not ours.
    }
  }
  return found;
}

// SIGINT and SIGTERM call stop until the returned function removes them.
function processInterrupt(stop: () => void): () => void {
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  };
}

// The real process functions, this process's environment and cores, stdout and stderr.
const defaultDeps = (): RunTestsDeps => ({
  spawn,
  setPriority: os.setPriority,
  kill: (pid) => killTree(pid),
  marked,
  env: process.env,
  cores: os.availableParallelism(),
  log: console.error,
  write: (text) => void process.stdout.write(text),
  onInterrupt: processInterrupt,
});

// How one file ended: its exit code, or why it has none (a phrase after the file's name); its
// output and how long it ran.
type FileEnd = ({ code: number } | { failure: string }) & { output: string; ms: number };

// Whether a file passed: it exited 0.
const passed = (end: FileEnd): boolean => 'code' in end && end.code === 0;

// A file's output as printed: a line that names the file, how it ended and how long it ran, then
// its output.
function fileReport(file: string, end: FileEnd): string {
  const how = 'code' in end ? `exit ${end.code}` : end.failure;
  return `run-tests: ${file} (${how}, ${(end.ms / 1000).toFixed(1)} s)\n${end.output}`;
}

// Runs the tests of mode argv[0], each file as `node --test <argv[1..]> <file>`. A passing file's
// output is printed when it ends; a failing file's at the end of the run, with the line that says
// why, so the last lines of the run show the failures. Resolves to the exit code: 2 for a usage
// error (nothing runs); 1 when no file matches, or a file could not start, was killed by a signal
// or ran past its limit; else the first failing file's exit code, or 0. Never calls process.exit.
export async function main(argv: string[], deps: RunTestsDeps = defaultDeps()): Promise<number> {
  const [mode, ...extra] = argv;
  if (!isMode(mode)) {
    deps.log(`run-tests: the mode must be unit or browser, not ${JSON.stringify(mode ?? '')}`);
    return 2;
  }
  const n = concurrency(deps.env, deps.cores);
  if (!n.ok) {
    deps.log(`run-tests: ${n.error}`);
    return 2;
  }
  const nice = niceValue(deps.env);
  if (!nice.ok) {
    deps.log(`run-tests: ${nice.error}`);
    return 2;
  }
  const limit = fileTimeout(deps.env);
  if (!limit.ok) {
    deps.log(`run-tests: ${limit.error}`);
    return 2;
  }
  const files = testFiles(mode, deps.root);
  if (files.length === 0) {
    deps.log(`run-tests: no test files match ${MODES[mode].files} (run npm run build first)`);
    return 1;
  }

  const root = deps.root ?? PACKAGE_ROOT;
  // NODE_COMPILE_CACHE as the caller set it, else the run's own; the test processes pass it on.
  const childEnv: Env = { ...deps.env, NODE_COMPILE_CACHE: deps.env.NODE_COMPILE_CACHE || join(root, COMPILE_CACHE_DIR) };
  const running = new Set<number>();
  let marks = 0;
  let interrupted = false;
  let warned = false;
  const removeInterrupt = deps.onInterrupt?.(() => {
    if (!interrupted) {
      interrupted = true;
      deps.log('run-tests: interrupted; the running test files are killed');
    }
    for (const pid of running) deps.kill(pid);
  });

  // One file in its own child; resolves when the child has ended.
  const runFile = (file: string): Promise<FileEnd> => new Promise<FileEnd>((resolve) => {
    const started = Date.now();
    const output: Buffer[] = [];
    const mark = `${process.pid}-${(marks += 1)}`;
    const child = deps.spawn(process.execPath, testArgs(mode, extra, file), { cwd: root, env: { ...childEnv, [RUN_MARK]: mark }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk));
    let timedOut = false;
    let failed: string | undefined;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    // Kills the child's group and tree, and every process of it that left both (by its mark).
    const killAll = (): void => {
      const left = deps.marked?.(mark) ?? [];
      if (child.pid !== undefined) deps.kill(child.pid);
      for (const pid of left) deps.kill(pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      deps.log(`run-tests: ${file} exceeded ${limit.value} ms and was killed`);
      killAll();
    }, limit.value);
    // The end of the child, once: the timer goes, and the limit's kill wins over how it ended.
    const settle = (end: { code: number } | { failure: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (child.pid !== undefined) running.delete(child.pid);
      const how = timedOut ? { failure: `exceeded ${limit.value} ms and was killed` } : end;
      resolve({ ...how, output: Buffer.concat(output).toString('utf8'), ms: Date.now() - started });
    };
    child.on('error', (err: Error) => {
      failed = `could not start node --test: ${err.message}`;
      settle({ failure: failed });
    });
    // How the child ended: an exit code, a signal, or the spawn error before either.
    const ended = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle(failed !== undefined ? { failure: failed } : code === null ? { failure: `was killed by ${signal ?? 'a signal'}` } : { code });
    };
    // An exited child is no longer past its limit; its output may close later. Still open after the
    // grace, it is held by processes the file left: the file failed, and they are killed with every
    // other process of its mark.
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      const graceMs = deps.closeGraceMs ?? CLOSE_GRACE_MS;
      grace = setTimeout(() => {
        if (settled) return;
        const left = `exited (${code ?? signal ?? '?'}), but processes it left kept its output open ${graceMs} ms later and were killed`;
        if (!timedOut) deps.log(`run-tests: ${file} ${left}`);
        killAll();
        settle(timedOut ? { code: 1 } : { failure: left });
      }, graceMs);
    });
    child.on('close', ended);
    if (child.pid !== undefined) {
      running.add(child.pid);
      if (nice.value !== 0) {
        try {
          deps.setPriority(child.pid, nice.value);
        } catch (err) {
          if (!warned) deps.log(`run-tests: warning: could not lower the test priority to nice ${nice.value}: ${(err as Error).message}`);
          warned = true;
        }
      }
    }
  });

  const ends = new Map<string, FileEnd>();
  const queue = [...files];
  // One lane of the pool: takes the next file until none is left or the run was interrupted.
  const lane = async (): Promise<void> => {
    for (let file = queue.shift(); file !== undefined && !interrupted; file = queue.shift()) {
      const end = await runFile(file);
      ends.set(file, end);
      if (passed(end)) deps.write(fileReport(file, end));
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(n.value, files.length) }, lane));
  } finally {
    removeInterrupt?.();
  }

  const failing = files.filter((file) => ends.has(file) && !passed(ends.get(file)!));
  for (const file of failing) deps.write(fileReport(file, ends.get(file)!));
  if (interrupted) return 1;
  if (failing.length === 0) return 0;
  deps.log(`run-tests: ${failing.length} of ${files.length} test files failed: ${failing.join(', ')}`);
  const first = ends.get(failing[0]!)!;
  // A failure (no exit code) anywhere is 1; else the first failing file's exit code.
  return 'code' in first && failing.every((file) => 'code' in ends.get(file)!) ? first.code : 1;
}
