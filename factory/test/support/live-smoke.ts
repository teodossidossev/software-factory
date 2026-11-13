// The shared part of the end-to-end tests of `sf smoke` (SF-090; test/live-smoke.test.ts,
// test/live-smoke-halt.test.ts, test/live-smoke-sandbox.test.ts and test/live-smoke-gate.test.ts,
// split so that no file runs near run-tests' per-file limit):
// the fake turns and reviews of a clean run, sf smoke run as the user would, and what a run must
// leave behind.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PROBES, STEPS } from '../../src/live-smoke.js';
import { taskChecksDir } from '../../src/sandbox-denials.js';
import { trackChild } from './children.js';
import { CLI, codexScript, type Env, fakeCodex, newEnv, processEnv, reviewScript, script, temp } from './harness.js';

const MR_PATH = '.software-factory/SMOKE-1.mr.md';
export const BRANCH = 'SMOKE-1-add-a-second-greeting-line';
export const CHECK_READY = { paraphrase: 'Add a second greeting line to greeting.txt.', findings: [], files: [{ path: 'greeting.txt', action: 'modify' }], verdict: 'ready' };
export const CLAUDE_CLEAN = { verdict: 'clean', summary: 'Claude found it right.', items: [], accepted_sensitive: [] };

export function mrText(header: string): string {
  return [
    header, '',
    '## What', 'Adds a greeting line.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- greeting.txt', '## Testing', 'grep -c hello greeting.txt: 2', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

// The sandbox probe's output (SF-100) as the fake Implementer writes it: every probe refused, or
// one of them with another outcome.
export function probeOutput(changed: Record<string, string> = {}): string {
  return `${JSON.stringify(PROBES.map((name) => ({ name, outcome: changed[name] ?? 'refused', code: changed[name] === undefined ? 'EACCES' : null })), null, 2)}\n`;
}

// The Write of the smoke's outside.txt the Task asks for (SF-123), from the worktree
// <dir>/worktrees/smoke/SMOKE-1: the file-tool guard refuses it.
export const OUTSIDE_WRITE = { tool: 'Write', input: { file_path: '../../../outside.txt', content: 'outside\n' } };

// The turns of a clean run: the Implementer's change, the probe's output and the Write outside the
// worktree, then the MR text at Clean.
export const CLEAN_TURNS = [
  { write: { 'greeting.txt': 'hello\nhello again\n', 'probe.json': probeOutput() }, calls: [OUTSIDE_WRITE], text: '# Report: SMOKE-1, iteration 1\n\n## Done\nAdded the line.' },
  { write: { [MR_PATH]: mrText('feat(SMOKE-1): Add a second greeting line') }, text: 'prepared' },
];

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  env: Env;
  tmp: string;
  // The smoke's temporary directory: the first line of its output.
  dir: string;
  // The rows of the table by step: [result, detail].
  rows: Map<string, { status: string; detail: string }>;
}

// The TMPDIR of one smoke run: a short directory of its own under the test file's temp, so the
// socket of the smoke's state (<tmp>/sf-smoke-XXXXXX/state/sf.sock) stays within the 107 bytes a
// socket path may have (src/ipc.ts) under a long TMPDIR too, such as a sandbox's.
export async function smokeTmp(): Promise<string> {
  return mkdtemp(join(temp, 's'));
}

// Runs sf smoke as the user would, with the test's own state, config (and env file) and TMPDIR.
// onStdout: called with the output so far on each chunk, with the child (to signal it).
export async function smoke(name: string, args: string[], setup: (env: Env) => Promise<void>, extra: Record<string, string> = {}, onStdout?: (text: string, child: ChildProcess) => void, extraOf?: (env: Env) => Record<string, string>): Promise<Ran> {
  const env = await newEnv(name);
  const tmp = await smokeTmp();
  await mkdir(env.config, { recursive: true });
  // The user's env file: a Git host token and a notification token the child must never see.
  await writeFile(join(env.config, 'auth.env'), 'SF_GITHUB_TOKEN=ghp_fakeFakeFakeFakeFakeFake1234\nSF_NTFY_TOKEN=tk_fake\n');
  await setup(env);
  const childEnvironment = { ...processEnv(env), SF_GATE: 'codex', SF_CODEX: fakeCodex, SF_NTFY_URL: 'http://127.0.0.1:9/never', TMPDIR: tmp, ...extra, ...extraOf?.(env) };
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, 'smoke', ...args], { env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    trackChild(child, ['smoke', ...args]);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      onStdout?.(out, child);
    });
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.once('close', (exit) => resolve({ code: exit, stdout: out, stderr: err }));
  });
  const lines = stdout.split('\n');
  const rows = new Map<string, { status: string; detail: string }>();
  for (const line of lines) {
    const match = /^(.+?): (PASS|FAIL|SKIP) \(\d+\.\d s\)(?: (.*))?$/.exec(line);
    if (match !== null && (STEPS as readonly string[]).includes(match[1]!)) {
      rows.set(match[1]!, { status: match[2]!, detail: match[3] ?? '' });
    }
  }
  return { code, stdout, stderr, env, tmp, dir: lines[0]!, rows };
}

export const statuses = (ran: Ran): string[] => STEPS.map((step) => ran.rows.get(step)?.status ?? 'missing');

// What a run leaves in its TMPDIR: at most the Task checks' shared parent directory (SF-100, made by
// sf serve and the checks, kept for the next run), empty.
export async function onlyChecksDir(tmp: string): Promise<void> {
  const left = await readdir(tmp);
  assert.deepEqual(left.filter((name) => name !== basename(taskChecksDir(tmp))), []);
  if (left.length > 0) {
    assert.deepEqual(await readdir(taskChecksDir(tmp)), []);
  }
}

// The user's state and config of the test: no state directory, the config only the env file.
export async function untouched(ran: Ran): Promise<void> {
  assert.equal(existsSync(ran.env.state), false, 'the user\'s state directory was created');
  assert.deepEqual(await readdir(ran.env.config), ['auth.env']);
}

export async function cleanScripts(env: Env): Promise<void> {
  await script(env, CLEAN_TURNS);
  await reviewScript(env, [{ output: CHECK_READY }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{}]);
}

// The live processes whose environment has HOME=home: the test's fakes and sf processes (Linux /proc).
export async function processesOf(home: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid)) {
    const environ = await readFile(`/proc/${name}/environ`, 'utf8').catch(() => '');
    if (environ.split('\0').includes(`HOME=${home}`)) {
      found.push(`${name}: ${(await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '')).replaceAll('\0', ' ')}`);
    }
  }
  return found;
}
