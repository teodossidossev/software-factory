// The shared part of the SF-067 end-to-end tests (test/pause.test.ts and, since SF-152,
// test/pause-limits.test.ts, split so that no file runs near run-tests' per-file limit): the
// reviewers' verdicts, the MR text, the job's paths and events, and the processes of a job.
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type Env, type Served } from './harness.js';

export const CLEAN = { verdict: 'clean', summary: 'Claude found it right.', items: [], accepted_sensitive: [] };
export const FIX = {
  verdict: 'fix', summary: 'The greeting is wrong.',
  items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.', severity: 'major' }], accepted_sensitive: [],
};
export const GATE_CLEAN = { verdict: 'clean', summary: 'Codex found it right.', items: [], accepted_sensitive: [] };
export const LONG = 60_000;

export function mrText(header: string): string {
  return [
    header, '',
    '## What', 'x', '## Why', 'The ticket asks for it.', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
    '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

export const jobDir = (env: Env, ticket: string): string => join(env.state, 'jobs', 'app', ticket);
export const worktreeOf = (env: Env, ticket: string): string => join(env.state, 'worktrees', 'app', ticket);

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function eventsOf(env: Env, ticket: string): Promise<Array<Record<string, any>>> {
  return (await readFile(join(jobDir(env, ticket), 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

export async function until(what: string, condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export const count = async (env: Env, name: string): Promise<number> => Number(await readFile(join(env.home, `${name}.count`), 'utf8').catch(() => '0'));

// The processes of this test's factory but sf serve: every one started with its HOME (the runners,
// the fake Claude Code of the turns and reviews, the fake Codex), alive and not a zombie.
export async function factoryProcesses(env: Env, served: Served): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === served.child.pid || Number(entry) === process.pid) {
      continue;
    }
    const environ = await readFile(`/proc/${entry}/environ`, 'utf8').catch(() => '');
    if (!environ.split('\0').includes(`HOME=${env.home}`)) {
      continue;
    }
    const status = await readFile(`/proc/${entry}/status`, 'utf8').catch(() => '');
    if (/^State:\s+Z/m.test(status)) {
      continue;
    }
    found.push(`${entry}: ${(await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '')).replaceAll('\0', ' ')}`);
  }
  return found;
}

// Nothing of the job runs: no runner, no Claude Code, no Codex.
export async function nothingRuns(env: Env, served: Served): Promise<void> {
  await until('the job\'s processes to end', async () => (await factoryProcesses(env, served)).length === 0, 3_000).catch(async () => {
    assert.deepEqual(await factoryProcesses(env, served), []);
  });
  assert.equal(await exists(join(jobDir(env, 'P-1'), 'runner.pid')), false);
}
