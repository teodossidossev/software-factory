// Runs Git with a fixed argv, no shell, a minimal environment and a bounded output.
import { spawn } from 'node:child_process';
import type { Hash } from 'node:crypto';

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
// added to the minimal environment (SF-073: GIT_INDEX_FILE for a snapshot in a temporary index).
export function runGit(cwd: string, args: string[], maxBytes = 1024 * 1024, timeoutMs?: number, env: Record<string, string> = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...gitEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGTERM' });
    const chunks: Buffer[] = [];
    let length = 0;
    let truncated = false;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
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
    child.stderr.on('data', (chunk: Buffer) => {
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
    const child = spawn('git', args, { cwd, env: gitEnv(), stdio: ['ignore', fd, 'pipe'] });
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

// Runs Git and feeds its whole stdout into hash, unbounded and never held in memory (SF-069).
export function runGitToHash(cwd: string, args: string[], hash: Hash): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
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
// without it too. Unbounded and never held whole in memory (SF-103: the morning digest's log of my
// commits). timeoutMs and env as for runGit; a timeout gives code null. An onRecord that throws
// stops Git and rejects with its error.
export function streamGitRecords(
  cwd: string, args: string[], separator: number, onRecord: (record: string) => void, timeoutMs?: number, env: Record<string, string> = {},
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...gitEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGTERM' });
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
