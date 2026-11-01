// Runs Git with a fixed argv, no shell, a minimal environment and a bounded output.
import { spawn } from 'node:child_process';

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  // True when stdout reached maxBytes and Git was stopped early.
  truncated: boolean;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_OPTIONAL_LOCKS: '0' };
  for (const name of ['PATH', 'HOME', 'LANG'] as const) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return env;
}

export function runGit(cwd: string, args: string[], maxBytes = 1024 * 1024): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
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
