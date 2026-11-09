// Runs Git with a fixed argv, no shell, a minimal environment and a bounded output. The only
// module that starts a `git` process (test/git.test.ts scans src/ for any other).
import { spawn } from 'node:child_process';
import type { Hash } from 'node:crypto';

// Put before every caller's arguments, with no way to leave it out: the factory runs Git
// as the user, outside the sandbox, so neither the repository's hooks (a core.hooksPath such as
// .husky resolves into files a job wrote) nor an fsmonitor program ever runs from here.
export const GIT_SAFETY_ARGS: readonly string[] = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

// The one value of each GIT_SAFETY_ARGS key a caller may repeat (live-smoke.ts's wrapper does).
const SAFE_VALUES: ReadonlyMap<string, string> = new Map([['core.hookspath', '/dev/null'], ['core.fsmonitor', 'false']]);

// The argv of a factory Git call: GIT_SAFETY_ARGS, then the caller's. A caller's own -c or
// --config-env would come later and win, so one that sets core.hooksPath or core.fsmonitor to
// anything else throws. Every argument is checked, not only those before the command (an option
// such as -C <dir> takes a value): a later `-c <name>` (`switch -c`) is refused only when it
// names one of those keys.
function gitArgs(args: string[]): string[] {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    let setting: string | undefined;
    let fromEnv = false;
    if (arg === '-c' || arg === '--config-env') {
      setting = args[index + 1];
      fromEnv = arg === '--config-env';
    } else if (arg.startsWith('--config-env=')) {
      setting = arg.slice('--config-env='.length);
      fromEnv = true;
    }
    if (setting === undefined) {
      continue;
    }
    const at = setting.indexOf('=');
    const key = (at < 0 ? setting : setting.slice(0, at)).toLowerCase();
    const safe = SAFE_VALUES.get(key);
    if (safe !== undefined && (fromEnv || at < 0 || setting.slice(at + 1) !== safe)) {
      throw new Error(`refusing a factory Git call that sets ${key}: hooks and fsmonitor stay off`);
    }
  }
  return [...GIT_SAFETY_ARGS, ...args];
}

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  // True when stdout reached maxBytes and Git was stopped early.
  truncated: boolean;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_OPTIONAL_LOCKS: '0' };
  // SSH_AUTH_SOCK lets `git fetch` reach an SSH remote with the user's agent.
  for (const name of ['PATH', 'HOME', 'LANG', 'SSH_AUTH_SOCK'] as const) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return env;
}

// timeoutMs, when given, stops Git with SIGTERM; the result then has code null. env: variables
// added to the minimal environment (e.g. GIT_INDEX_FILE for a snapshot in a temporary index).
// input, when given, is Git's whole stdin (e.g. for `check-attr --stdin`); stdin is closed otherwise.
export function runGit(
  cwd: string, args: string[], maxBytes = 1024 * 1024, timeoutMs?: number, env: Record<string, string> = {}, input?: string,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs(args), {
      cwd, env: { ...gitEnv(), ...env }, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGTERM',
    });
    if (input !== undefined) {
      // Git may exit before it reads it all; its exit code tells, not the broken pipe.
      child.stdin!.on('error', () => {});
      child.stdin!.end(input);
    }
    const chunks: Buffer[] = [];
    let length = 0;
    let truncated = false;
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      if (truncated) {
        return;
      }
      const room = maxBytes - length;
      chunks.push(chunk.subarray(0, room));
      length += Math.min(room, chunk.length);
      if (chunk.length >= room) {
        truncated = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stdout: Buffer.concat(chunks, length), stderr, truncated });
    });
  });
}

// Runs Git with its stdout written to the open file fd (no limit, nothing held in memory).
export function runGitToFile(cwd: string, args: string[], fd: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs(args), { cwd, env: gitEnv(), stdio: ['ignore', fd, 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

// Runs Git and feeds its whole stdout into hash, unbounded and never held in memory.
export function runGitToHash(cwd: string, args: string[], hash: Hash): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs(args), { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      hash.update(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

// Runs Git and hands its stdout to onRecord one record at a time, the records split at the byte
// separator (a byte that cannot occur inside a UTF-8 character, such as 0x1e), the last one
// without it too. Unbounded and never held whole in memory (e.g. the morning digest's log of my
// commits). timeoutMs and env as for runGit; a timeout gives code null. An onRecord that throws
// stops Git and rejects with its error.
export function streamGitRecords(
  cwd: string, args: string[], separator: number, onRecord: (record: string) => void, timeoutMs?: number, env: Record<string, string> = {},
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs(args), { cwd, env: { ...gitEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGTERM' });
    let rest: Buffer = Buffer.alloc(0);
    let stderr = '';
    let failed: unknown;
    child.stdout.on('data', (chunk: Buffer) => {
      if (failed !== undefined) {
        return;
      }
      let data = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk;
      let at = data.indexOf(separator);
      while (at >= 0 && failed === undefined) {
        const record = data.subarray(0, at).toString('utf8');
        data = data.subarray(at + 1);
        try {
          onRecord(record);
        } catch (error) {
          failed = error;
          child.kill('SIGTERM');
        }
        at = data.indexOf(separator);
      }
      rest = Buffer.from(data);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (failed !== undefined) {
        reject(failed);
        return;
      }
      if (rest.length > 0) {
        try {
          onRecord(rest.toString('utf8'));
        } catch (error) {
          reject(error);
          return;
        }
      }
      resolve({ code, stderr });
    });
  });
}

// The Git work tree root containing cwd, or undefined (not a repository, bare, or Git failed).
export async function gitToplevel(cwd: string): Promise<string | undefined> {
  try {
    const result = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    const top = result.stdout.toString('utf8').trim();
    return result.code === 0 && top !== '' ? top : undefined;
  } catch {
    return undefined;
  }
}
