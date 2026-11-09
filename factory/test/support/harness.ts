// Shared helpers of the end-to-end tests: the real `sf serve` and `sf` CLI with private config
// and state directories, throwaway Git repositories and the fake Claude Code
// (test/support/fake-claude.ts) as the Implementer executable, the fake Codex
// (test/support/fake-codex.ts) for the gate, run inside the fake bubblewrap (test/support/fake-bwrap.ts,
// first on every sf process's PATH, SF-125), the planning tools driven through the official
// MCP client and the job steps through the socket of sf serve: start as sf start sends it, and with
// SF_TEST_HOOKS=on check and a reviewer's verdict without a review session (fix, clean). Importing it registers the before/after hooks
// that create and remove the temp dir, and stop every sf process the tests started
// (test/support/children.ts, SF-114).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { dashboardUrl, readToken } from '../../src/dashboard.js';
import { callSocket } from '../../src/ipc.js';
import { JobStore, refusedTransitions } from '../../src/jobs.js';
import { saveRegistry } from '../../src/registry.js';
import { MCP_TOKEN_FILE } from '../../src/server.js';
import { cliRuleList, FACTORY_MCP_SERVER } from '../../src/sandbox-denials.js';
import { rulesBlock } from '../../src/rules-docs.js';
import { CheckStore, taskSha256 } from '../../src/task-check.js';
import { writeTask } from '../../src/task-file.js';
import { bwrapArgs } from '../../src/test-command.js';
import { checkChildren, isServe, REFUSAL_MS, removeOnExit, stopChild, trackChild } from './children.js';

export const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
export const FAKE = fileURLToPath(new URL('./fake-claude.js', import.meta.url));
const FAKE_CODEX_SCRIPT = fileURLToPath(new URL('./fake-codex.js', import.meta.url));
const FAKE_BWRAP_SCRIPT = fileURLToPath(new URL('./fake-bwrap.js', import.meta.url));
const READY = /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)\/<token>$/m;
// sf serve prints the dashboard's port with <token> in the token's place (SF-126).
const DASHBOARD = /dashboard http:\/\/127\.0\.0\.1:(\d+)\/d\/<token>\/ \(sf dashboard prints the full URL\)$/m;

export let temp: string;
// The fake Codex executable (test/support/fake-codex.ts behind a shell wrapper), for SF_CODEX.
export let fakeCodex: string;
// The folder of the fake bwrap (SF-125: test/support/fake-bwrap.ts, then an exec of the command
// after "--" from the folder of --chdir, when given), first on every sf process's PATH: a nested real
// bubblewrap may not run where the tests do, and the gate and the workspace's test command
// (SF-128) run inside one. An Env with realBwrap leaves it off (SF-152).
export let fakeBwrapBin: string;
// Everything the sf processes of this test file wrote to stdout and stderr (SF-088): the after hook
// fails on a refused state change in it.
const outputs: Array<{ command: string; text: string }> = [];

// Keeps every byte the child writes to stdout and stderr in outputs.
function collect(child: ChildProcess, args: string[]): void {
  const output = { command: `sf ${args.join(' ')}`, text: '' };
  outputs.push(output);
  child.stdout?.on('data', (chunk: Buffer) => (output.text += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output.text += chunk.toString('utf8')));
}

export interface Env {
  config: string;
  state: string;
  home: string;
  // The /proc the sandbox's config lock check of the sf processes scans (SF_TEST_PROC_DIR, SF-105):
  // empty, nobody holds the lock; a test that needs a holder adds a <pid>/fd/<n> link to it.
  // newEnv always makes one; only an Env never given to an sf process goes without.
  proc?: string;
  extra?: Record<string, string>;
  // The real bubblewrap (SF-152): the fake bwrap stays off the PATH of the sf processes. Only for a
  // test that skips where bubblewrap cannot start (bubblewrapStarts).
  realBwrap?: boolean;
}

export interface Served {
  child: ChildProcess;
  client: Client;
  // The MCP endpoint URL with the token of the state directory (SF-099); sf serve prints it as /mcp/<token>.
  url: URL;
  // What sf serve printed up to the listening line.
  output: string;
  // The printed dashboard URL; undefined with SF_DASHBOARD=off.
  dashboard: URL | undefined;
  // The state directory, for the socket.
  state: string;
}

// Why a test that needs the real bubblewrap skips (bubblewrapStarts).
export const BWRAP_CANNOT_START = 'bubblewrap cannot start here';
let bwrapStarted: boolean | undefined;

// Whether the real bwrap starts the sandbox of a workspace's test command (SF-128) here: the exact
// arguments bwrapArgs gives a run in a temporary worktree, /run hidden as in every run, and its start
// script reports the start. It cannot inside another sandbox (no new namespace, or no mount over /run
// there); the tests that need it skip with BWRAP_CANNOT_START. Probed once per process.
export function bubblewrapStarts(): boolean {
  if (bwrapStarted === undefined) {
    const cwd = mkdtempSync(join(tmpdir(), 'sf-bwrap-probe-'));
    try {
      const probe = spawnSync('bwrap', bwrapArgs({ command: 'true', cwd, hidden: [{ path: '/run', directory: true }] }), {
        cwd, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore', 'pipe'], timeout: 30_000,
      });
      bwrapStarted = probe.status === 0 && probe.output[3] === 'started';
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
  return bwrapStarted;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function processEnv(env: Env): NodeJS.ProcessEnv {
  return {
    PATH: env.realBwrap === true ? process.env.PATH ?? '' : `${fakeBwrapBin}${delimiter}${process.env.PATH ?? ''}`,
    HOME: env.home,
    SF_CONFIG_DIR: env.config,
    SF_STATE_DIR: env.state,
    SF_PORT: '0',
    SF_DASHBOARD_PORT: '0',
    SF_CLAUDE: FAKE,
    // The machine's real notify-send stays quiet; the notification test sets its own PATH.
    SF_DESKTOP_NOTIFY: 'off',
    // No real tunnel: sf serve starts none, its health address is one nothing listens on, and the
    // script is missing unless the test gives a fake one.
    SF_TUNNEL: 'off',
    SF_TUNNEL_HEALTH: '127.0.0.1:1',
    SF_TUNNEL_SCRIPT: join(temp, 'no-such-tunnel.sh'),
    // No Claude review unless the test turns it on (test/review.test.ts).
    SF_REVIEW: 'off',
    // No gate unless the test turns it on (test/gate.test.ts).
    SF_GATE: 'off',
    // The Claude review on every ticket and five Fix sections (SF-131), so the tests keep the flow
    // of before; test/review-setting-flow.test.ts sets ticket.
    SF_CLAUDE_REVIEW: 'always',
    SF_MAX_ITERATIONS: '5',
    // No simplification pass unless the test turns it on (test/simplify.test.ts).
    SF_SIMPLIFY: 'off',
    // No hand-over to the checkout unless the test turns it on (test/handoff.test.ts, SF-073).
    SF_HANDOFF: 'off',
    // No automatic Task check unless the test turns it on (test/task-check-auto.test.ts, SF-086).
    SF_TASK_CHECK_AUTO: 'off',
    // No health checks in the tests' sf serve (SF-153): they would run the fake CLIs' login status.
    SF_HEALTH: 'off',
    // The job steps of call() and refused() through the socket.
    SF_TEST_HOOKS: 'on',
    // The config lock check scans this fake /proc, not the machine's (SF-105).
    ...(env.proc !== undefined ? { SF_TEST_PROC_DIR: env.proc } : {}),
    // Temporary directories (the Task check's worktree, SF-054, under its parent sf-task-checks-<uid>,
    // SF-100) in the test run's own directory, never the machine's: the user's running factory owns
    // <tmp>/sf-task-checks-<uid>, and a sandbox that runs the tests may mask it read-only.
    TMPDIR: join(temp, 'tmp'),
    // The zone of the times sf prints: the test file's own (SF-049), else the machine's.
    ...(process.env.TZ !== undefined ? { TZ: process.env.TZ } : {}),
    // Node's compile cache of the test run (SF-152, set by src/run-tests.ts): an sf process loads its
    // modules from it instead of compiling them again.
    ...(process.env.NODE_COMPILE_CACHE !== undefined ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE } : {}),
    // The mark of the test file's processes (SF-152, RUN_MARK of src/run-tests.ts): run-tests kills
    // the sf processes a file left behind by it.
    ...(process.env.RUN_TESTS_MARK !== undefined ? { RUN_TESTS_MARK: process.env.RUN_TESTS_MARK } : {}),
    ...env.extra,
  };
}

export async function newEnv(name: string, extra: Record<string, string> = {}, options: { realBwrap?: boolean } = {}): Promise<Env & { proc: string }> {
  const root = join(temp, name);
  const env = { config: join(root, 'config'), state: join(root, 'state'), home: join(root, 'home'), proc: join(root, 'proc'), extra, ...options };
  await mkdir(env.home, { recursive: true });
  await mkdir(env.proc, { recursive: true });
  // The factory commits at Clean with the user's Git identity. No automatic gc or maintenance
  // (SF-152): the tiny repositories of a test never need them, and each would start git processes
  // after the factory's commits and fetches.
  await writeFile(join(env.home, '.gitconfig'), '[user]\n\tname = Test User\n\temail = test@example.invalid\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
  return env;
}

// Makes a process of env's fake /proc (SF_TEST_PROC_DIR, SF-105) hold path open, as the sandbox or
// Git holds the config lock: a <pid>/fd/<n> link to its real path. One holder per Env at a time;
// the undo it returns ends it.
export async function holdOpen(env: Env, path: string): Promise<() => Promise<void>> {
  assert.ok(env.proc !== undefined, 'the Env has no fake /proc');
  const dir = join(env.proc, '4242');
  await mkdir(join(dir, 'fd'), { recursive: true });
  await symlink(await realpath(path), join(dir, 'fd', '3'));
  return () => rm(dir, { recursive: true, force: true });
}

export async function script(env: Env, turns: unknown[]): Promise<void> {
  await writeFile(join(env.home, 'fake-claude.json'), JSON.stringify({ turns }));
  await rm(join(env.home, 'fake-claude.count'), { force: true });
}

// Waits until the fake Claude Code has started count Implementer runs (each takes its turn script
// when it starts, before a delayed turn writes anything): since SF-042 sf start answers before the
// job's runner has started the first turn.
export async function turnsStarted(env: Env, count: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const text = await readFile(join(env.home, 'fake-claude.count'), 'utf8').catch(() => '0');
    if (Number(text) >= count) {
      return;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${count} Implementer run(s); ${text} started`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// A user message's blocks as the fake logs them (SF-065): only when one is not text.
export type LoggedBlock = { type: 'text'; text: string } | { type: 'image'; media_type: string; bytes: number; sha256: string };

export async function fakeLog(env: Env): Promise<Array<{ argv: string[]; prompt: string; sessionId: string; cwd: string; env: string[]; blocks?: LoggedBlock[] }>> {
  return (await readFile(join(env.home, 'fake-claude.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

// The fake's review script (runs with --json-schema), consumed in order.
export async function reviewScript(env: Env, reviews: unknown[]): Promise<void> {
  await writeFile(join(env.home, 'fake-review.json'), JSON.stringify({ reviews }));
  await rm(join(env.home, 'fake-review.count'), { force: true });
}

export async function reviewLog(env: Env): Promise<Array<{ argv: string[]; prompt: string; sessionId: string; cwd: string; env: string[]; blocks?: LoggedBlock[] }>> {
  return (await readFile(join(env.home, 'fake-review.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

// What the fake Claude's probes did (the Task check, SF-054): each call, the hooks' decision and
// the output the session saw; last, when the session had hooks, its StructuredOutput answer (SF-070).
export async function probeLog(env: Env): Promise<Array<{ tool: string; input: Record<string, unknown>; decision: 'allow' | 'deny'; output: string; hooks: number }>> {
  return (await readFile(join(env.home, 'fake-probe.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}
// The fake Codex's run script, consumed in order.
export async function codexScript(env: Env, runs: unknown[]): Promise<void> {
  await writeFile(join(env.home, 'fake-codex.json'), JSON.stringify({ runs }));
  await rm(join(env.home, 'fake-codex.count'), { force: true });
}

// The argv of each run of the fake bwrap (SF-125); none when it never ran.
export async function bwrapLog(env: Env): Promise<Array<{ argv: string[] }>> {
  const text = await readFile(join(env.home, 'fake-bwrap.log'), 'utf8').catch(() => '');
  return text.trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

// What the fake Codex logged of each run.
export async function codexLog(env: Env): Promise<Array<{ argv: string[]; cwd: string; prompt: string; env: string[]; pid: number; images: Array<{ path: string; sha256: string }> }>> {
  return (await readFile(join(env.home, 'fake-codex.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

// A repository with one commit on main; with origin, the work checkout is a clone of a bare repo.
export async function newRepo(env: Env, name: string, withOrigin: boolean): Promise<string> {
  const seed = join(temp, `${name}-seed`);
  await mkdir(seed);
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(join(seed, 'README.md'), 'hello\n');
  await writeFile(join(seed, '.gitignore'), '*.log\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'initial');
  let repo = seed;
  if (withOrigin) {
    const bare = join(temp, `${name}-origin.git`);
    execFileSync('git', ['clone', '-q', '--bare', seed, bare]);
    repo = join(temp, name);
    execFileSync('git', ['clone', '-q', bare, repo]);
  }
  await saveRegistry({ workspaces: { app: { read_checkout: repo, work_checkout: repo } } }, env.config);
  return repo;
}

// SF-059: coding rules for the workspace "app": AGENTS.md linking docs/style.md, committed on main
// (and pushed when the checkout has an origin), and the workspace's rules file in the config
// directory. Returns the <rules> block the agents are given.
export async function putRules(env: Env, repo: string): Promise<string> {
  const files = { 'AGENTS.md': '# Agents\n\nFollow [the style](docs/style.md#naming).\n', 'docs/style.md': '# Style\n\nName things plainly.\n' };
  await mkdir(join(repo, 'docs'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(repo, path), content);
  }
  git(repo, 'add', ...Object.keys(files));
  git(repo, 'commit', '-q', '-m', 'coding rules');
  if (git(repo, 'remote').split('\n').includes('origin')) {
    git(repo, 'push', '-q', 'origin', 'main');
  }
  const own = 'Mine: no abbreviations.\n';
  await mkdir(join(env.config, 'rules'), { recursive: true });
  await writeFile(join(env.config, 'rules', 'app.md'), own);
  return rulesBlock([
    ...Object.entries(files).map(([path, text]) => ({ source: 'repository' as const, path, text })),
    { source: 'workspace' as const, path: 'rules/app.md', text: own },
  ], []);
}

export function task(ticket: string, title: string, base = 'main'): string {
  return `---\nticket: ${ticket}\ntitle: ${title}\nbase: ${base}\n---\n\n# ${ticket}: ${title}\n\nChange the README.\n`;
}

export async function putTask(env: Env, repo: string, ticket: string, title: string, base = 'main'): Promise<void> {
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, ticket, task(ticket, title, base), new JobStore(env.state));
}

// A ready Task check of the ticket's current Task file in workspace app, stored as sf serve stores
// one: the run queue starts only a ticket whose plan is ready (SF-086).
export async function readyCheck(env: Env, repo: string, ticket: string): Promise<void> {
  const text = await readFile(join(repo, '.software-factory', `${ticket}.md`), 'utf8');
  const at = new Date().toISOString();
  await new CheckStore(env.state).write({
    workspace: 'app', ticket, sha256: taskSha256(text), commit: null, status: 'checked', output: { paraphrase: 'Ready.', findings: [], files: [], verdict: 'ready' },
    error: null, model: null, cost_usd: null, started_at: at, ended_at: at,
  });
}

// A serve or up (expected to refuse) that still runs after REFUSAL_MS is stopped and rejects.
export function runCli(env: Env, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: processEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    trackChild(child, args);
    collect(child, args);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = isServe(args)
      ? setTimeout(() => {
        // First: the close the kill causes must not resolve the Promise.
        timedOut = true;
        void stopChild(child).then(() => reject(new Error(`sf ${args.join(' ')} did not exit within ${REFUSAL_MS / 1000} s; a refused start was expected:\n${stdout}${stderr}`)));
      }, REFUSAL_MS)
      : undefined;
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('close', (code) => {
      if (timedOut) {
        return;
      }
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// The printed endpoint (http://127.0.0.1:<port>/mcp) with the MCP token of env's state directory (SF-099).
export async function mcpUrlOf(env: Env, printed: URL): Promise<URL> {
  const token = (await readFile(join(env.state, MCP_TOKEN_FILE), 'utf8')).trim();
  return new URL(`${printed.href}/${token}`);
}

// The dashboard of sf serve's output (SF-126): the printed port with the token of env's state
// directory; undefined when no dashboard line was printed. The output never holds a token.
export async function dashboardUrlOf(env: Env, output: string): Promise<URL | undefined> {
  assert.doesNotMatch(output, /[0-9a-f]{64}/, 'sf serve printed a token');
  const printed = DASHBOARD.exec(output);
  if (printed === null) {
    return undefined;
  }
  const token = await readToken(env.state);
  assert.ok(token !== undefined, 'sf serve wrote no dashboard-token');
  return dashboardUrl(Number(printed[1]), token);
}

// args: the sf command line (`serve`, or `up` with its options).
export async function serve(env: Env, args: string[] = ['serve']): Promise<Served> {
  const child = spawn(process.execPath, [CLI, ...args], { env: processEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  collect(child, args);
  trackChild(child, args);
  let output = '';
  const url = await new Promise<URL>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = READY.exec(output);
      if (match) {
        child.stdout.off('data', onData);
        resolve(new URL(match[1]!));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.once('exit', (code) => reject(new Error(`sf serve exited with ${code}:\n${output}`)));
  });
  const client = new Client({ name: 'sf-011-execution', version: '0.0.0' });
  let withToken: URL;
  let dashboard: URL | undefined;
  try {
    dashboard = await dashboardUrlOf(env, output);
    withToken = await mcpUrlOf(env, url);
    await client.connect(new StreamableHTTPClientTransport(withToken));
  } catch (err) {
    await stopChild(child);
    throw err;
  }
  return { child, client, url: withToken, output, dashboard, state: env.state };
}

export async function stop(served: Served, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  await served.client.close();
  await new Promise<void>((resolve) => {
    if (served.child.exitCode !== null) {
      resolve();
      return;
    }
    served.child.once('exit', () => resolve());
    served.child.kill(signal);
  });
}

// The job steps that are no MCP tools since SF-040, as the socket commands of sf serve: the user's
// start (sf start), check, and the verdicts of a reviewer (fix, clean). The tests keep the old tool
// names (request_fix, mark_clean) for the steps: they name the Execution paths the steps take.
const SOCKET_STEPS: Record<string, (args: Record<string, any>) => { command: string; args: string[] }> = {
  start: ({ workspace, ticket }) => ({ command: 'start', args: [workspace, ticket] }),
  check: ({ workspace, ticket, offset, max_bytes }) => ({
    command: 'check',
    args: [workspace, ticket, ...(offset !== undefined || max_bytes !== undefined ? [String(offset ?? 0)] : []), ...(max_bytes !== undefined ? [String(max_bytes)] : [])],
  }),
  request_fix: ({ workspace, ticket, content }) => ({ command: 'fix', args: [workspace, ticket, content] }),
  mark_clean: ({ workspace, ticket, sensitive }) => ({ command: 'clean', args: [workspace, ticket, ...(sensitive ?? [])] }),
};

// One step: a planning tool through MCP, a job step through the socket; ok with its result, or
// refused with the code and message.
async function step(served: Served, name: string, args: Record<string, unknown>): Promise<{ ok: true; result: Record<string, any> } | { ok: false; error: { code: string; message: string } }> {
  const viaSocket = SOCKET_STEPS[name];
  if (viaSocket !== undefined) {
    const response = await callSocket(served.state, viaSocket(args));
    return response.ok ? { ok: true, result: response.result as Record<string, any> } : response;
  }
  const result = await served.client.callTool({ name, arguments: args });
  if (result.isError === true) {
    const [block] = result.content as Array<{ text: string }>;
    return { ok: false, error: JSON.parse(block!.text) };
  }
  return { ok: true, result: result.structuredContent as Record<string, any> };
}

export async function call(served: Served, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const outcome = await step(served, name, args);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return (outcome as { result: Record<string, any> }).result;
}

export async function refused(served: Served, name: string, args: Record<string, unknown>): Promise<{ code: string; message: string }> {
  const outcome = await step(served, name, args);
  assert.equal(outcome.ok, false, `expected ${name} to be refused`);
  return (outcome as { error: { code: string; message: string } }).error;
}

export async function waitFor(served: Served, ticket: string, state: string, iteration?: number): Promise<Record<string, any>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const checked = await call(served, 'check', { workspace: 'app', ticket });
    if (checked.state === state && (iteration === undefined || checked.iteration === iteration)) {
      return checked;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${state}: ${JSON.stringify(checked)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

before(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'sf-exec-')));
  removeOnExit(temp);
  await mkdir(join(temp, 'tmp'));
  fakeCodex = join(temp, 'fake-codex');
  await writeFile(fakeCodex, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_SCRIPT}' "$@"\n`);
  await chmod(fakeCodex, 0o755);
  fakeBwrapBin = join(temp, 'bwrap-bin');
  await mkdir(fakeBwrapBin);
  await writeFile(join(fakeBwrapBin, 'bwrap'), [
    '#!/bin/sh',
    `'${process.execPath}' '${FAKE_BWRAP_SCRIPT}' "$@" || exit $?`,
    'dir=',
    'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do',
    '  if [ "$1" = --chdir ]; then dir=$2; fi',
    '  shift',
    'done',
    'shift',
    'if [ -n "$dir" ]; then cd "$dir" || exit 1; fi',
    'exec "$@"',
    '',
  ].join('\n'));
  await chmod(join(fakeBwrapBin, 'bwrap'), 0o755);
});

// The pids of the job runners (SF-042) whose lock is under dir: they outlive sf serve by design.
export async function runnerPids(dir: string): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === 'runner.pid') {
      const pid = Number((await readFile(join(entry.parentPath, entry.name), 'utf8').catch(() => '')).trim().split(' ')[0]);
      if (Number.isInteger(pid) && pid > 0) {
        pids.push(pid);
      }
    }
  }
  return pids;
}

// The refused state changes (SF-088) of this test file: the lines illegal_transition: of every sf
// process it ran and of every runner.log under dir (the runners' output), and the refusals of this
// process (the in-process Executions).
async function illegalTransitions(dir: string): Promise<string[]> {
  const texts = outputs.map((output) => ({ source: output.command, text: output.text }));
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name === 'runner.log') {
      const path = join(entry.parentPath, entry.name);
      texts.push({ source: path, text: await readFile(path, 'utf8').catch(() => '') });
    }
  }
  const lines = texts.flatMap(({ source, text }) => text.split('\n').filter((line) => line.startsWith('illegal_transition:')).map((line) => `${source}: ${line}`));
  const refusals = refusedTransitions().map((row) => `this process: illegal_transition: ${row.from} -> ${row.to} by ${row.action}`);
  return [...lines, ...refusals];
}

after(async () => {
  let problems: string[];
  let illegal: string[];
  try {
    // The sf processes of the tests (SF-114): stopped, and a serve left running is a problem.
    problems = await checkChildren(temp);
    for (const pid of await runnerPids(temp).catch(() => [])) {
      // Only a live `sf run` of these tests, never a process that reused a stale lock's pid.
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      if (command.includes(`${CLI}\0run\0`)) {
        process.kill(pid, 'SIGKILL');
      }
    }
    // Before the temp directory goes: the runners' logs are in it.
    illegal = await illegalTransitions(temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  const sections = [
    ...(problems.length > 0 ? [`sf processes left running by this test file:\n${problems.join('\n')}`] : []),
    ...(illegal.length > 0 ? [`State changes outside JOB_TRANSITIONS (src/jobs.ts):\n${illegal.join('\n')}`] : []),
  ];
  if (sections.length > 0) {
    // A failed root after hook does not set the exit code of a plain `node <file>` run (Node 24), only
    // of node --test: the file fails either way.
    process.exitCode = 1;
    throw new assert.AssertionError({ message: sections.join('\n\n') });
  }
});


// The path denials (SF-100) a logged Claude session got, checked from its argv: the deny rules in
// --disallowedTools after the session's own (given), and the sandbox's filesystem lists in --settings
// (required unless sandboxed is false: SF_SANDBOX=off). Always present: the state's jobs/ folder and
// the config directory, for reading and writing, absolute; never the session's own directory (own).
// Returns the extra rules.
export function assertPathDenials(argv: string[], env: Env, own: string, given: readonly string[] = [], sandboxed = true): string[] {
  const inline = argv.find((arg) => arg.startsWith('--disallowedTools='))?.slice('--disallowedTools='.length) ?? '';
  // Read as the installed CLI reads it: a comma inside a rule's parentheses does not split it.
  const rules = cliRuleList([inline]);
  assert.deepEqual(rules.slice(0, given.length), [...given]);
  const extra = rules.slice(given.length);
  const jobs = join(env.state, 'jobs');
  for (const rule of [`Read(/${jobs})`, `Read(/${jobs}/**)`, `Edit(/${jobs}/**)`, `Write(/${jobs}/**)`, `Read(/${env.config})`, `Read(/${env.config}/**)`]) {
    assert.ok(extra.includes(rule), `${rule} not in ${extra.join(', ')}`);
  }
  // The factory's own MCP server's tools (SF-099), then path rules only.
  assert.ok(extra.includes(`mcp__${FACTORY_MCP_SERVER}`), extra.join(', '));
  const pathRules = extra.filter((rule) => rule !== `mcp__${FACTORY_MCP_SERVER}`);
  assert.ok(pathRules.every((rule) => /^(Read|Edit|Write)\(\/\/.+\)$/.test(rule)), extra.join(', '));
  const paths = pathRules.map((rule) => rule.replace(/^\w+\(\//, '').replace(/(\/\*\*)?\)$/, ''));
  assert.ok(!paths.some((path) => path === own || own.startsWith(`${path}/`)), `the own ${own} is denied: ${extra.join(', ')}`);
  const at = argv.indexOf('--settings');
  const sandbox = at < 0 ? undefined : (JSON.parse(argv[at + 1]!) as { sandbox?: { filesystem?: { denyRead?: string[]; denyWrite?: string[] } } }).sandbox;
  assert.equal(sandbox !== undefined, sandboxed, `a sandbox was ${sandboxed ? 'expected' : 'not expected'}: ${argv.join(' ')}`);
  if (sandbox !== undefined) {
    assert.ok(sandbox.filesystem?.denyRead !== undefined && sandbox.filesystem.denyWrite !== undefined, JSON.stringify(sandbox));
    for (const list of [sandbox.filesystem.denyRead, sandbox.filesystem.denyWrite]) {
      assert.ok(list.includes(jobs) && list.includes(env.config), list.join(', '));
      assert.ok(list.every((path) => path.startsWith('/')), list.join(', '));
      assert.ok(!list.some((path) => path === own || own.startsWith(`${path}/`)), `the own ${own} is denied: ${list.join(', ')}`);
    }
  }
  return extra;
}
