// The shared part of the Codex gate's end-to-end tests (SF-039; test/gate.test.ts and, since SF-152,
// test/gate-limits.test.ts, split so that no file runs near run-tests' per-file limit): the
// reviewers' verdicts, the MR text, the gate's environment and the job's paths and events.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type Env, fakeCodex } from './harness.js';

export const CLAUDE_CLEAN = { verdict: 'clean', summary: 'Claude found it right.', items: [], accepted_sensitive: [] };
export const GATE_FIX = {
  verdict: 'fix',
  summary: 'The greeting\nis wrong.',
  items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.', severity: 'major' }],
  accepted_sensitive: [],
};
export const GATE_CLEAN = { verdict: 'clean', summary: 'Codex found it right.', items: [], accepted_sensitive: [] };
export const FIX_SECTION = '## Fix 1\n\nReview by Codex: The greeting is wrong.\n\n1. [R1, major] `README.md`: It greets the world. Expected: It greets the reader.\n';

export function mrText(header: string): string {
  return [
    header, '',
    '## What', 'x', '## Why', 'The ticket asks for it.', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
    '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

export const gateEnv = (extra: Record<string, string> = {}): Record<string, string> => ({ SF_REVIEW: 'on', SF_GATE: 'codex', SF_GATE_LEVEL: 'full', SF_CODEX: fakeCodex, ...extra });
export const taskFile = (repo: string, ticket: string): Promise<string> => readFile(join(repo, '.software-factory', `${ticket}.md`), 'utf8');
export const worktreeOf = (env: Env, ticket: string): string => join(env.state, 'worktrees', 'app', ticket);
export const iterationDir = (env: Env, ticket: string, number: number): string => join(env.state, 'jobs', 'app', ticket, 'iterations', String(number).padStart(3, '0'));
export const option = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The lines of sf watch without their time (HH:MM:SS and a space).
export const withoutTime = (stdout: string): string[] => stdout.split('\n').map((line) => line.slice('00:00:00 '.length));

export async function eventsOf(env: Env, ticket: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(env.state, 'jobs', 'app', ticket, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

export async function until(what: string, condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
