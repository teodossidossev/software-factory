// The shared part of the end-to-end tests of the hand-over (SF-073; test/handoff.test.ts and, since
// SF-152, test/handoff-recover.test.ts, split so that no file runs near run-tests' per-file limit):
// the MR text turn, the Git probes of a checkout and the setup of a workspace with SF_HANDOFF=checkout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { type Job, JobStore } from '../../src/jobs.js';
import { call, git, newEnv, newRepo, putTask, serve, type Served, temp, waitFor } from './harness.js';

export type Env = Awaited<ReturnType<typeof newEnv>>;

export function mrText(header: string): string {
  return [
    header, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'npm test: passed', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

export const mrTurn = (ticket: string, title = 'Hand it over'): Record<string, unknown> => ({ write: { [`.software-factory/${ticket}.mr.md`]: mrText(`feat(${ticket}): ${title}`) }, text: 'MR text' });

export const worktreeOf = (env: Env, ticket: string): string => join(env.state, 'worktrees', 'app', ticket);

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// Git's exit code, without throwing.
export function gitCode(cwd: string, ...args: string[]): number {
  try {
    git(cwd, ...args);
    return 0;
  } catch (error) {
    return (error as { status: number }).status;
  }
}

export const head = (repo: string): string => git(repo, 'symbolic-ref', '-q', 'HEAD').trim();
export const rev = (repo: string, name: string): string => git(repo, 'rev-parse', name).trim();
export const config = (repo: string, key: string): string | null => {
  try {
    return git(repo, 'config', '--local', '--get', key).trim();
  } catch {
    return null;
  }
};
// The checkout's status without the Task files of the factory.
export const status = (repo: string): string => git(repo, 'status', '--porcelain', '--untracked-files=all').replace(/^\?\? \.software-factory\/.*\n/gm, '');
export const remoteTip = (origin: string, branch: string): string | undefined => {
  try {
    return execFileSync('git', ['--git-dir', origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
};

export interface Setup {
  env: Env;
  repo: string;
  origin: string;
  served: Served;
  jobs: JobStore;
}

// sf serve on a fresh checkout with origin and SF_HANDOFF=checkout (unless extra says otherwise).
export async function setup(name: string, extra: Record<string, string> = {}): Promise<Setup> {
  const env = await newEnv(name, { SF_HANDOFF: 'checkout', ...extra });
  const repo = await newRepo(env, `${name}-repo`, true);
  return { env, repo, origin: join(temp, `${name}-repo-origin.git`), served: await serve(env), jobs: new JobStore(env.state) };
}

// Starts the job and takes it through review to Clean; the turns are already scripted.
export async function toClean(s: Setup, ticket: string, title = 'Hand it over'): Promise<void> {
  await putTask(s.env, s.repo, ticket, title);
  await call(s.served, 'start', { workspace: 'app', ticket });
  await waitFor(s.served, ticket, 'awaiting_review');
  await call(s.served, 'mark_clean', { workspace: 'app', ticket });
}

export async function waitState(s: Setup, ticket: string, ...states: string[]): Promise<Record<string, any>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const checked = await call(s.served, 'check', { workspace: 'app', ticket });
    if (states.includes(checked.state)) {
      return checked;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${states.join('/')}: ${JSON.stringify(checked)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const job = async (s: Setup, ticket: string): Promise<Job> => (await s.jobs.read('app', ticket))!;

// A socket command refused by sf serve, with its code and message.
export async function refusedSocket(s: Setup, command: string, args: string[]): Promise<{ code: string; message: string }> {
  const { callSocket } = await import('../../src/ipc.js');
  const response = await callSocket(s.env.state, { command, args });
  assert.equal(response.ok, false, `expected ${command} to be refused: ${JSON.stringify(response)}`);
  return (response as { error: { code: string; message: string } }).error;
}
