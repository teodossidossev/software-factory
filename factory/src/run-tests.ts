// The test runner behind npm test and npm run test:browser (SF-108), started by
// scripts/run-tests.mjs. It runs node --test as a child process with at most half the cores
// (--test-concurrency) and lowers the child's priority to nice 10, which the test processes it
// starts inherit, so the user's IDE stays responsive while the suite runs. The child's exit code
// is the result: a failing test never exits 0.
import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export type Mode = 'unit' | 'browser';

type Env = Record<string, string | undefined>;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// What main needs of a child process: its pid and its events ('error', 'close').
export type ChildLike = {
  readonly pid?: number | undefined;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

export type RunTestsDeps = {
  spawn: (command: string, args: readonly string[], options: { cwd: string; stdio: 'inherit' }) => ChildLike;
  setPriority: (pid: number, priority: number) => void;
  env: Env;
  cores: number;
  log: (line: string) => void;
};

const MODES: Record<Mode, { flags: readonly string[]; files: string }> = {
  unit: { flags: ['--test-timeout=120000'], files: 'dist/test/*.test.js' },
  browser: { flags: [], files: 'dist/test/browser/*.test.js' },
};

const DEFAULT_NICE = 10;

// factory/, the directory the file globs are relative to (this file is dist/src/run-tests.js).
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function isMode(value: string | undefined): value is Mode {
  return value === 'unit' || value === 'browser';
}

// The number of test files node --test runs at once: half the cores rounded down, at least 1;
// SF_TEST_CONCURRENCY replaces it when set (empty counts as unset) to a positive integer.
export function concurrency(env: Env, cores: number): Result<number> {
  const raw = env.SF_TEST_CONCURRENCY;
  if (raw === undefined || raw === '') return { ok: true, value: Math.max(1, Math.floor(cores / 2)) };
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) {
    return { ok: false, error: `SF_TEST_CONCURRENCY must be a positive integer, not ${JSON.stringify(raw)}` };
  }
  return { ok: true, value };
}

// The nice value of the child: unset or empty is 10, exactly 0 skips the priority change.
export function niceValue(env: Env): Result<number> {
  const raw = env.SF_TEST_NICE;
  if (raw === undefined || raw === '') return { ok: true, value: DEFAULT_NICE };
  if (raw === '0') return { ok: true, value: 0 };
  return { ok: false, error: `SF_TEST_NICE must be unset (nice ${DEFAULT_NICE}) or 0 (no priority change), not ${JSON.stringify(raw)}` };
}

// The child's arguments: --test, the mode's flags, the concurrency, the caller's arguments, the files.
export function testArgs(mode: Mode, n: number, extra: readonly string[], files: readonly string[]): string[] {
  return ['--test', ...MODES[mode].flags, `--test-concurrency=${n}`, ...extra, ...files];
}

// The mode's test files, relative to factory/ and sorted, expanded without a shell.
export function testFiles(mode: Mode, root: string = PACKAGE_ROOT): string[] {
  return globSync(MODES[mode].files, { cwd: root }).map((file) => file.split('\\').join('/')).sort();
}

// Runs the tests of mode argv[0], passing argv[1..] on to node --test. Resolves to the exit code:
// 2 for a usage error (nothing runs), 1 when the child could not start or was killed by a signal,
// otherwise the child's own exit code. Never calls process.exit.
export async function main(
  argv: string[],
  deps: RunTestsDeps = { spawn, setPriority: os.setPriority, env: process.env, cores: os.availableParallelism(), log: console.error },
): Promise<number> {
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
  const files = testFiles(mode);
  if (files.length === 0) {
    deps.log(`run-tests: no test files match ${MODES[mode].files} (run npm run build first)`);
    return 1;
  }

  const child = deps.spawn(process.execPath, testArgs(mode, n.value, extra, files), { cwd: PACKAGE_ROOT, stdio: 'inherit' });
  return new Promise<number>((resolve) => {
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.on('error', (err: Error) => {
      deps.log(`run-tests: could not start node --test: ${err.message}`);
      settle(1);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === null) {
        deps.log(`run-tests: node --test was killed by ${signal ?? 'a signal'}`);
        settle(1);
        return;
      }
      settle(code);
    });
    if (nice.value !== 0 && child.pid !== undefined) {
      try {
        deps.setPriority(child.pid, nice.value);
      } catch (err) {
        deps.log(`run-tests: warning: could not lower the test priority to nice ${nice.value}: ${(err as Error).message}`);
      }
    }
  });
}
