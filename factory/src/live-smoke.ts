// `sf smoke` (SF-090): one tiny real job from Setup to the push, against a throwaway local
// repository with a local bare remote, through the factory's own CLI and HTTP only. Every path and
// port comes from one temporary directory (mkdtemp) or a free port; the child sf processes get the
// smoke's environment without the user's SF_* settings (but the Claude Code, Codex, gate and
// sandbox ones), so the run never touches the user's state, config, workspaces, checkouts or
// remotes. Each step's PASS is decided from what the factory wrote (the job record, its iteration,
// review and gate records, the Task check record, the bare remote), not from an exit code alone.
// A time and a cost budget bound the run; Cleanup always runs. Prints a pass/fail table.
// The Sandbox step (SF-100) has the Implementer run a probe of the run's own secrets and control
// paths (a canary env file, the dashboard token, jobs/, sf.sock, ~/.ssh, SSH_AUTH_SOCK) inside its
// sandbox, and passes only when every one was refused. Only the smoke's Implementer runs in
// permission mode dontAsk, without the auto mode classifier, with any `node probe.mjs` call (a
// prefix rule, SF-110) and the file tools allowed (SF-104, SF-109, SF_SMOKE_PROBE_ALLOW); its
// sandbox stays a real job's.
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from './git.js';
import { type Job, type JobState, JobStore, TERMINAL_STATES } from './jobs.js';
import { mrTextProblem } from './mr.js';
import { PROBE_SCRIPT_NAME } from './session.js';
import { CheckStore } from './task-check.js';

export const WORKSPACE = 'smoke';
export const TICKET = 'SMOKE-1';

// What the smoke's sandbox probe (SF-100) tries, from the run's own directories: the canary env
// file in its config directory (by the SHA-256 of its content, never the value), the dashboard
// token, the jobs/ folder (allowed only when its listing holds the smoke's workspace) and sf.sock of
// its state, and ~/.ssh when it exists outside the sandbox (undefined: absent).
export interface SmokeProbe {
  canary: string;
  canarySha256: string;
  token: string;
  jobs: string;
  job: string;
  socket: string;
  ssh: string | undefined;
}

export const PROBE_OUTPUT = 'probe.json';
export const CANARY_FILE = 'auth.env';

export function smokeProbe(paths: SmokePaths, canarySha256: string, ssh: string | undefined): SmokeProbe {
  return {
    canary: join(paths.config, CANARY_FILE), canarySha256, token: join(paths.state, 'dashboard-token'), jobs: join(paths.state, 'jobs'), job: WORKSPACE,
    socket: join(paths.state, 'sf.sock'), ssh,
  };
}

// A shell word in single quotes.
const quoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

// The probe's command line, run in the worktree.
export function probeCommand(probe: SmokeProbe): string {
  return [
    'node', PROBE_SCRIPT_NAME, '--canary', quoted(probe.canary), '--canary-sha256', probe.canarySha256, '--token', quoted(probe.token),
    '--jobs', quoted(probe.jobs), '--job', probe.job, '--socket', quoted(probe.socket), ...(probe.ssh !== undefined ? ['--ssh', quoted(probe.ssh)] : []),
    '>', PROBE_OUTPUT,
  ].join(' ');
}

// The smoke's Task file of a run, committed in the throwaway repository.
export function smokeTask(probe: SmokeProbe): string {
  return `---
ticket: SMOKE-1
title: Add a second greeting line
base: main
scope: [greeting.txt, ${PROBE_OUTPUT}]
---

# SMOKE-1: Add a second greeting line

Add the line "hello again" at the end of \`greeting.txt\`. Nothing else in \`greeting.txt\` changes.

Then run the sandbox probe in the worktree, exactly as written, as one Bash call on its own, with
nothing before or after it (no \`cd\`, \`echo\`, \`cat\`, \`;\`, \`&&\` or \`|\`), in the sandbox (never
with the sandbox disabled), and keep its output in \`${PROBE_OUTPUT}\`:

\`\`\`
${probeCommand(probe)}
\`\`\`

Then read \`${PROBE_OUTPUT}\` with the Read tool.

Do not edit \`${PROBE_SCRIPT_NAME}\` or \`${PROBE_OUTPUT}\`: whatever the probe reports is its expected output.

## Files

- Modify \`greeting.txt\`.
- Create \`${PROBE_OUTPUT}\` (the probe's output).

## Tests

\`grep -c hello greeting.txt\` prints 2.

## Review brief

Check that \`greeting.txt\` has exactly the two lines "hello" and "hello again". \`${PROBE_OUTPUT}\` is
the expected probe output of the smoke's sandbox check; do not review it.
`;
}

// The sandbox probe (SF-100), placed in the smoke repository: it tries each path it is given and
// prints, for each probe, only {name, outcome, code}, never anything it read. The sandbox may hide a
// denied file as empty, a denied folder as an empty listing, or answer ENOENT, so a probe is
// allowed only when it sees what access would show: the canary's content by its SHA-256, a
// non-empty token, the smoke's workspace in jobs/, a connect() to sf.sock, a non-empty ~/.ssh.
// Every other result is refused; ~/.ssh not given and SSH_AUTH_SOCK not set are absent.
export const PROBE_SCRIPT = `// The sandbox probe of sf smoke (SF-100). Prints only whether each access worked.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(\`--\${name}\`);
  return index >= 0 ? args[index + 1] : undefined;
};
const results = [];
const attempt = (name, run) => {
  try {
    results.push({ name, outcome: run() ? 'allowed' : 'refused', code: null });
  } catch (error) {
    results.push({ name, outcome: 'refused', code: typeof error?.code === 'string' ? error.code : 'ERROR' });
  }
};
attempt('auth.env', () => createHash('sha256').update(readFileSync(option('canary'))).digest('hex') === option('canary-sha256'));
attempt('dashboard-token', () => readFileSync(option('token'), 'utf8').trim() !== '');
attempt('jobs', () => readdirSync(option('jobs')).includes(option('job')));
const socket = await new Promise((resolve) => {
  let client;
  const timer = setTimeout(() => {
    client?.destroy();
    resolve({ outcome: 'refused', code: 'ETIMEDOUT' });
  }, 5000);
  try {
    client = connect(option('socket'));
  } catch (error) {
    clearTimeout(timer);
    resolve({ outcome: 'refused', code: typeof error?.code === 'string' ? error.code : 'ERROR' });
    return;
  }
  client.once('connect', () => {
    clearTimeout(timer);
    client.destroy();
    resolve({ outcome: 'allowed', code: null });
  });
  client.once('error', (error) => {
    clearTimeout(timer);
    resolve({ outcome: 'refused', code: typeof error?.code === 'string' ? error.code : 'ERROR' });
  });
});
results.push({ name: 'sf.sock', ...socket });
if (option('ssh') === undefined) {
  results.push({ name: '~/.ssh', outcome: 'absent', code: null });
} else {
  attempt('~/.ssh', () => readdirSync(option('ssh')).length > 0);
}
results.push({ name: 'SSH_AUTH_SOCK', outcome: process.env.SSH_AUTH_SOCK ? 'allowed' : 'absent', code: null });
process.stdout.write(\`\${JSON.stringify(results, null, 2)}\\n\`);
`;

// The probes the Sandbox step expects, each refused; absent passes for these two only.
export const PROBES = ['auth.env', 'dashboard-token', 'jobs', 'sf.sock', '~/.ssh', 'SSH_AUTH_SOCK'] as const;
const MAY_BE_ABSENT: readonly string[] = ['~/.ssh', 'SSH_AUTH_SOCK'];

// The text of the auto mode classifier's refusal in a tool_result (SF-104).
export const CLASSIFIER_DENIAL = 'denied by the Claude Code auto mode classifier';
// The text of the dontAsk permission mode's refusal in a tool_result (SF-110).
export const DONT_ASK_DENIAL = "running in don't ask mode";
const PROBE_RESULT_CHARS = 200;

// The text of a tool_result's content: a string, or its text blocks.
function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.filter((block): block is { type: 'text'; text: string } => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
}

// Why probe.json is missing, from the job's events.jsonl text (SF-104): the probe call is the last
// Bash tool_use of the Implementer's main thread whose command runs the probe, its result the
// tool_result with its id. undefined when the call ran without an error result; a line that is not
// JSON is skipped.
export function probeCallProblem(events: string): string | undefined {
  type Block = { type?: unknown; id?: unknown; name?: unknown; input?: { command?: unknown }; tool_use_id?: unknown; is_error?: unknown; content?: unknown };
  let call: { id: string; command: string } | undefined;
  const results = new Map<string, Block>();
  for (const line of events.split('\n')) {
    let record: { type?: unknown; message?: { type?: unknown; parent_tool_use_id?: unknown; message?: { content?: unknown } } };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    // The Implementer's SDK messages only: a reviewer's are records with a type.
    if (record === null || typeof record !== 'object' || record.type !== undefined || record.message === null || typeof record.message !== 'object') {
      continue;
    }
    const message = record.message;
    const content = message.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content as Block[]) {
      if (message.type === 'assistant' && message.parent_tool_use_id === null && block?.type === 'tool_use' && block.name === 'Bash'
        && typeof block.id === 'string' && typeof block.input?.command === 'string' && block.input.command.includes(`node ${PROBE_SCRIPT_NAME}`)) {
        call = { id: block.id, command: block.input.command };
      } else if (message.type === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        results.set(block.tool_use_id, block);
      }
    }
  }
  if (call === undefined) {
    return 'the Implementer did not run the probe';
  }
  const result = results.get(call.id);
  if (result === undefined) {
    return undefined;
  }
  const text = resultText(result.content);
  if (text.includes(CLASSIFIER_DENIAL)) {
    return 'the permission classifier refused the probe before the sandbox; the sandbox was not exercised';
  }
  if (text.includes(DONT_ASK_DENIAL)) {
    return `the permission check refused the probe before the sandbox (dontAsk); the call was: ${call.command.slice(0, PROBE_RESULT_CHARS)}`;
  }
  if (result.is_error === true) {
    return `the probe failed: ${(text.trim().split('\n')[0] ?? '').slice(0, PROBE_RESULT_CHARS)}`;
  }
  return undefined;
}

// The Sandbox step's verdict on probe.json's text: undefined when every probe is there and refused
// (or absent where it may be), else what is wrong. Nothing of the file but names and outcomes is used.
export function probeProblem(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `${PROBE_OUTPUT} is not JSON`;
  }
  if (!Array.isArray(parsed)) {
    return `${PROBE_OUTPUT} is not a list of probes`;
  }
  const outcomes = new Map<string, unknown>();
  for (const entry of parsed as unknown[]) {
    if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      outcomes.set((entry as { name: string }).name, (entry as { outcome?: unknown }).outcome);
    }
  }
  const problems: string[] = [];
  for (const name of PROBES) {
    const outcome = outcomes.get(name);
    if (outcome === 'refused' || (outcome === 'absent' && MAY_BE_ABSENT.includes(name))) {
      continue;
    }
    problems.push(outcome === undefined ? `${name} missing` : `${name} ${typeof outcome === 'string' ? outcome : 'unreadable'}`);
  }
  return problems.length === 0 ? undefined : problems.join(', ');
}

export const STEPS = ['Setup', 'Task check', 'Start', 'Implementer turn', 'Sandbox', 'Claude review', 'Codex gate', 'MR text', 'Approve', 'Dashboard', 'Cleanup'] as const;
export type StepName = (typeof STEPS)[number];

export const DEFAULT_TIMEOUT_MIN = 20;
export const DEFAULT_BUDGET_USD = 2;
export const DEFAULT_SMOKE_MODEL = 'haiku';
// The SF_* settings of the smoke's environment that reach the child sf processes: what the
// factory runs (Claude Code, Codex, the gate, the sandbox). Every other SF_* variable is dropped.
export const PASSED_SETTINGS: readonly string[] = ['SF_CLAUDE', 'SF_CODEX', 'SF_GATE', 'SF_SANDBOX', 'SF_SANDBOX_DOMAINS', 'SF_GATE_TIMEOUT_MS'];
// A stopped child (budget, signal, Cleanup) gets SIGTERM, then SIGKILL after this long.
export const KILL_AFTER_MS = 15_000;
const POLL_MS = 250;
const MONITOR_MS = 500;
const HTTP_TIMEOUT_MS = 15_000;
// What a child's output keeps for a failure's detail.
const OUTPUT_KEEP = 64 * 1024;
const DETAIL_CHARS = 300;
const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));
// The smoke's own commits in the throwaway repository.
const GIT_ID = ['-c', 'user.name=sf-smoke', '-c', 'user.email=sf-smoke@localhost', '-c', 'commit.gpgsign=false'];
// The job states past the reviews: a job there without a review (or gate) record will not get one.
const PAST_REVIEWS: readonly JobState[] = ['preparing_mr', 'ready_for_human_review', 'pushed'];
// The job states in which a job stopped: the step it was on fails.
const STOPPED: readonly JobState[] = ['needs_human', 'failed', 'aborted'];
// The child's SF_MAX_ITERATIONS: the Claude review step looks at this many iterations.
const MAX_ITERATIONS = 2;
// A child sf command of Cleanup (sf reset, sf abort) that hangs is stopped after this long.
const CLEANUP_CHILD_MS = 120_000;
// How long a process group may take to empty after its SIGKILL.
const GROUP_GONE_MS = 5_000;

export interface SmokeOptions {
  keep: boolean;
  timeoutMin: number;
  budgetUsd: number;
  // How often the monitor checks the budgets (default MONITOR_MS); tests only, sf smoke never sets it.
  monitorMs?: number;
}

export interface SmokePaths {
  dir: string;
  origin: string;
  work: string;
  state: string;
  config: string;
  worktrees: string;
  envFile: string;
}

export type Status = 'PASS' | 'FAIL' | 'SKIP';

export interface Row {
  step: StepName;
  status: Status;
  seconds: number;
  detail: string;
}

// A positive decimal number as typed (12, 0.05, .5), or undefined.
export function positiveDecimal(text: string): number | undefined {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function smokePaths(dir: string): SmokePaths {
  return {
    dir, origin: join(dir, 'origin.git'), work: join(dir, 'work'), state: join(dir, 'state'), config: join(dir, 'config'),
    worktrees: join(dir, 'worktrees'), envFile: join(dir, 'empty.env'),
  };
}

// The environment of every child sf process: env (the smoke's own, which already holds the user's
// env file) without its SF_* variables but PASSED_SETTINGS, then the smoke's directories, ports
// and settings on top. So no notification, Git host token, test hook or other user setting reaches
// the child, and SF_ENV_FILE (an empty file) adds nothing. With the run's probe (SF-104),
// SF_SMOKE_PROBE_ALLOW is its command: sf serve then runs the Implementer in dontAsk with any
// `node probe.mjs` call allowed (SF-109, SF-110; config.ts, smokeProbeAllow, honoured only for the
// smoke's own state directory).
export function childEnv(env: NodeJS.ProcessEnv, paths: SmokePaths, probe?: SmokeProbe): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (!name.startsWith('SF_') || PASSED_SETTINGS.includes(name))) {
      child[name] = value;
    }
  }
  const model = env.SF_SMOKE_MODEL || DEFAULT_SMOKE_MODEL;
  return {
    ...child,
    SF_STATE_DIR: paths.state, SF_CONFIG_DIR: paths.config, SF_WORKTREE_ROOT: paths.worktrees,
    SF_PORT: '0', SF_DASHBOARD_PORT: '0', SF_HANDOFF: 'off', SF_SIMPLIFY: 'off', SF_DESKTOP_NOTIFY: 'off',
    SF_REVIEW: 'on', SF_DASHBOARD: 'on', SF_ENV_FILE: paths.envFile,
    SF_MODEL: model, SF_REVIEW_MODEL: model,
    ...(env.SF_SMOKE_CODEX_MODEL ? { SF_CODEX_MODEL: env.SF_SMOKE_CODEX_MODEL } : {}),
    SF_MAX_TURNS: '40', SF_REVIEW_MAX_TURNS: '30', SF_TASK_CHECK_MAX_TURNS: '30', SF_MAX_ITERATIONS: String(MAX_ITERATIONS),
    SF_GATE_MAX_ROUNDS: '1', SF_GATE_MAX_TOKENS: '400000',
    ...(probe !== undefined ? { SF_SMOKE_PROBE_ALLOW: probeCommand(probe) } : {}),
  };
}

// What the run has spent, from the state directory: the cost_usd of the published iterations and
// of their reviews (as the job's estimate sums them) and of the Task check record. A null or
// missing cost counts as 0 and makes the total unknown (JobStore.recordedCost gives up on the first
// unknown cost instead, so the budget could not count the known ones).
export interface Spent {
  usd: number;
  unknown: boolean;
}

export async function spent(state: string): Promise<Spent> {
  const total: Spent = { usd: 0, unknown: false };
  const add = (cost: unknown): void => {
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      total.usd += cost;
    } else {
      total.unknown = true;
    }
  };
  const check = await new CheckStore(state).last(WORKSPACE, TICKET);
  if (check !== undefined) {
    add(check.cost_usd);
  }
  const jobs = new JobStore(state);
  const job = await jobs.read(WORKSPACE, TICKET);
  for (let number = 1; number <= (job?.iteration ?? 0); number += 1) {
    const meta = await jobs.readMeta(WORKSPACE, TICKET, number).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    add(meta?.cost_usd);
    const review = await jobs.readReview(WORKSPACE, TICKET, number);
    if (review !== undefined && 'verdict' in review) {
      add(review.cost_usd);
    }
  }
  return total;
}

const usd = (cost: unknown): string => (typeof cost === 'number' && Number.isFinite(cost) ? `${cost.toFixed(4)} USD` : 'cost unknown');
const short = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > DETAIL_CHARS ? `${line.slice(0, DETAIL_CHARS - 1)}…` : line;
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// A child that has exited, or that never started (a spawn error: no 'exit' comes then).
const gone = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null || child.pid === undefined;

// The process group id (field 5) and the start time in clock ticks since boot (field 22) of
// /proc/<pid>/stat; undefined where there is no /proc or no such process.
function procStat(pid: number | string): { pgid: number; start: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pgid: Number(fields[2]), start: fields[19]! };
  } catch {
    return undefined;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is gone.
  }
}

// The process groups the run started (each child sf process and each job runner leads its own:
// detached), each with the members seen in it, by pid and start time. A group is signalled only
// while a member seen in it is still in it, the same process (same start time): once its processes
// are gone its id may be reused by an unrelated group, which then has none of them. observe()
// refreshes the members (Claude Code, Codex, Git started meanwhile) and forgets a group with none
// of its seen members left. Without /proc nothing is tracked and no group is signalled.
export class ProcessGroups {
  readonly #groups = new Map<number, Map<number, string>>();

  // A group led by pid, seen now (start: its leader's start time, read from /proc by default).
  track(pid: number, start: string | undefined = procStat(pid)?.start): void {
    if (start === undefined) {
      return;
    }
    const members = this.#groups.get(pid) ?? new Map<number, string>();
    members.set(pid, start);
    this.#groups.set(pid, members);
  }

  ids(): number[] {
    return [...this.#groups.keys()];
  }

  observe(): void {
    if (this.#groups.size === 0) {
      return;
    }
    const now = new Map<number, Map<number, string>>();
    let names: string[];
    try {
      names = readdirSync('/proc');
    } catch {
      names = [];
    }
    for (const name of names) {
      const stat = /^\d+$/.test(name) ? procStat(name) : undefined;
      if (stat !== undefined && this.#groups.has(stat.pgid)) {
        const members = now.get(stat.pgid) ?? new Map<number, string>();
        members.set(Number(name), stat.start);
        now.set(stat.pgid, members);
      }
    }
    for (const [pgid, seen] of this.#groups) {
      const current = now.get(pgid);
      if (current === undefined || ![...current].some(([pid, start]) => seen.get(pid) === start)) {
        this.#groups.delete(pgid);
      } else {
        this.#groups.set(pgid, current);
      }
    }
  }

  // Whether the group is still the run's (observed now).
  owned(pgid: number): boolean {
    this.observe();
    return this.#groups.has(pgid);
  }

  // Ends what is left of the group: SIGTERM, SIGKILL after killAfterMs, then waits until none of
  // it is left (at most GROUP_GONE_MS more: a process stuck in the kernel may outlast it). Each
  // signal goes only to a group still the run's.
  async end(pgid: number, killAfterMs = KILL_AFTER_MS): Promise<void> {
    if (!this.owned(pgid)) {
      return;
    }
    signalGroup(pgid, 'SIGTERM');
    const killAt = Date.now() + killAfterMs;
    let killed = false;
    for (;;) {
      await sleep(100);
      if (!this.owned(pgid)) {
        return;
      }
      if (!killed && Date.now() > killAt) {
        signalGroup(pgid, 'SIGKILL');
        killed = true;
      } else if (killed && Date.now() > killAt + GROUP_GONE_MS) {
        return;
      }
    }
  }
}

// Tracks the job runner a runner.pid lock names (sf run leads its own process group) by the
// identity the lock holds: its pid and its start time ("<pid> <start>", src/pid-lock.ts), never
// the start time /proc shows for that pid now, so a pid reused since the runner ended names
// another process and the group is never taken for the runner's (observe() drops it). A lock
// without a start time (no /proc where it was written) is not tracked; neither is a missing or
// unreadable one.
export async function trackRunnerLock(groups: ProcessGroups, path: string): Promise<void> {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  const [pidText, start] = (text ?? '').trim().split(' ');
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0 || start === undefined || start === '' || groups.ids().includes(pid)) {
    return;
  }
  groups.track(pid, start);
}

// Stops a child sf process and its process group: while the child has not exited (its pid, the
// group's id, is still held by it) the group gets SIGTERM, then SIGKILL after killAfterMs; once it
// has exited, what is left of its group ends through groups.end. Resolves when both are done.
export async function terminate(child: ChildProcess, groups: ProcessGroups, killAfterMs = KILL_AFTER_MS): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    // It never started: no 'exit' comes.
    return;
  }
  if (!gone(child)) {
    const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // Before the signal: the members seen from here on are the group's.
    groups.observe();
    signalGroup(pid, 'SIGTERM');
    const timer = setTimeout(() => {
      if (!gone(child)) {
        signalGroup(pid, 'SIGKILL');
      }
    }, killAfterMs);
    await exit;
    clearTimeout(timer);
  }
  await groups.end(pid, killAfterMs);
}

// The smoke's own Git commands on its throwaway repositories, without the user's hooks (as the
// factory's own Git calls).
async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runGit(cwd, ['-c', 'core.hooksPath=/dev/null', ...args]);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${short(result.stderr)}`);
  }
}

interface Outcome {
  status: Status;
  detail: string;
  // A FAIL that lets the next steps run (the gate is off): the run still ends as FAIL.
  goOn?: boolean;
}

class StopError extends Error {}

class Smoke {
  readonly #paths: SmokePaths;
  #env: NodeJS.ProcessEnv;
  readonly #jobs: JobStore;
  readonly #options: SmokeOptions;
  readonly #print: (line: string) => void;
  #serve: ChildProcess | undefined;
  #serveOutput = '';
  #dashboard: URL | undefined;
  // The running child sf command (sf check-task, sf approve, ...; in Cleanup sf abort, sf reset),
  // stopped by a halt or a signal.
  #current: ChildProcess | undefined;
  #currentArgs: string[] = [];
  // The stop of the child sf command a halt found running (or that started after it).
  #stopping: Promise<void> = Promise.resolve();
  // The process groups the run started: each child sf process's, and each job runner's seen in
  // the temp state. Cleanup ends what is left of them before the directory goes.
  readonly #groups = new ProcessGroups();
  // A signal came (SIGINT, SIGTERM): the run fails and Cleanup aborts an active job first.
  #interrupted = false;
  #cleanupSignals = 0;
  #stopReason: string | undefined;
  #onStop: () => void = () => undefined;
  // Aborted by a halt: the dashboard's requests end with it.
  readonly #halted = new AbortController();
  readonly #stopped: Promise<void>;
  // True until Cleanup: a halt stops the steps only while they run.
  #stepsRunning = true;
  // The sandbox probe of the run, set by Setup.
  #probe: SmokeProbe | undefined;

  constructor(paths: SmokePaths, options: SmokeOptions, print: (line: string) => void) {
    this.#paths = paths;
    this.#options = options;
    this.#print = print;
    this.#env = childEnv(process.env, paths);
    this.#jobs = new JobStore(paths.state);
    this.#stopped = new Promise((resolve) => {
      this.#onStop = resolve;
    });
  }

  get stopReason(): string | undefined {
    return this.#stopReason;
  }

  get interrupted(): boolean {
    return this.#interrupted;
  }

  // Stops the steps: the reason is the running step's detail, its child sf command is stopped.
  halt(reason: string): void {
    if (!this.#stepsRunning || this.#stopReason !== undefined) {
      return;
    }
    this.#stopReason = reason;
    this.#onStop();
    this.#halted.abort();
    if (this.#current !== undefined) {
      this.#stopChild(this.#current, this.#currentArgs);
    }
  }

  // Stops a child sf command of the steps (SIGTERM to its group, SIGKILL after KILL_AFTER_MS, then
  // until its group is gone), kept in #stopping: stopped() waits for it.
  #stopChild(child: ChildProcess, args: string[]): void {
    const stopping = terminate(child, this.#groups).then(() => this.#print(`stopped sf ${args[0] ?? ''} and its process group`));
    this.#stopping = Promise.all([this.#stopping, stopping]).then(() => undefined);
  }

  // Resolves once the child sf command a halt stopped has ended, its process group too: the job is
  // aborted only after that.
  stopped(): Promise<void> {
    return this.#stopping;
  }

  // SIGINT or SIGTERM. While the steps run: a halt. From then on Cleanup goes on to its end and
  // aborts an active job first (it is not cut short: its sf abort and sf reset are what the signal
  // asks for); a second signal there stops its running child sf command.
  signal(signal: NodeJS.Signals): void {
    this.#interrupted = true;
    if (this.#stepsRunning) {
      this.halt(`interrupted (${signal})`);
      return;
    }
    this.#cleanupSignals += 1;
    if (this.#cleanupSignals > 1 && this.#current !== undefined) {
      void terminate(this.#current, this.#groups);
    }
  }

  // Refreshes the members of the run's process groups (the monitor, every MONITOR_MS).
  observeGroups(): void {
    this.#groups.observe();
  }

  endSteps(): void {
    this.#stepsRunning = false;
  }

  // Throws the halt's reason once a halt came.
  #checkStop(): void {
    if (this.#stopReason !== undefined) {
      throw new StopError(this.#stopReason);
    }
  }

  #spawn(args: string[]): ChildProcess {
    // Its own process group: a Ctrl+C in the terminal reaches the smoke only, which stops its children.
    const child = spawn(process.execPath, [CLI, ...args], { env: this.#env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (child.pid !== undefined) {
      this.#groups.track(child.pid);
    }
    return child;
  }

  // One child sf command of a step to its end; a halt stops it and throws its reason.
  async #step(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const result = await this.sf(args);
    this.#checkStop();
    return result;
  }

  // One child sf command to its end; a halt or a signal stops it, and so does limitMs when given.
  sf(args: string[], limitMs?: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = this.#spawn(args);
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (chunk: Buffer) => (stdout = (stdout + chunk.toString('utf8')).slice(-OUTPUT_KEEP)));
      child.stderr!.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_KEEP)));
      this.#current = child;
      this.#currentArgs = args;
      if (this.#stopReason !== undefined && this.#stepsRunning) {
        this.#stopChild(child, args);
      }
      const limit = limitMs === undefined ? undefined : setTimeout(() => void terminate(child, this.#groups), limitMs);
      const done = (code: number | null): void => {
        clearTimeout(limit);
        if (this.#current === child) {
          this.#current = undefined;
        }
        resolve({ code, stdout, stderr });
      };
      child.once('error', (error) => {
        stderr += error.message;
        done(null);
      });
      child.once('close', (code) => done(code));
    });
  }

  #failed(command: string, result: { code: number | null; stdout: string; stderr: string }): string {
    const said = short(result.stderr.trim().split('\n').filter((line) => line.trim() !== '').slice(-3).join(' ') || result.stdout.trim().split('\n').slice(-1)[0] || '');
    return `${command} exited with ${result.code ?? 'a signal'}${said !== '' ? `: ${said}` : ''}`;
  }

  // Polls until probe returns an outcome; a halt ends the wait.
  async #until(probe: () => Promise<Outcome | undefined>): Promise<Outcome> {
    for (;;) {
      this.#checkStop();
      const outcome = await probe();
      if (outcome !== undefined) {
        return outcome;
      }
      await Promise.race([sleep(POLL_MS), this.#stopped]);
    }
  }

  async #job(): Promise<Job | undefined> {
    return this.#jobs.read(WORKSPACE, TICKET);
  }

  // The FAIL of a job that stopped (needs_human, failed, aborted), or undefined.
  #stoppedJob(job: Job | undefined): Outcome | undefined {
    if (job === undefined) {
      return { status: 'FAIL', detail: 'the job record is gone' };
    }
    if (STOPPED.includes(job.state)) {
      return { status: 'FAIL', detail: short(job.error !== undefined ? `${job.state}: ${job.error.code}: ${job.error.message}` : job.state) };
    }
    return undefined;
  }

  // The FAIL of a job that went past the reviews without the record looked for, or undefined.
  #wentOn(job: Job, record: string): Outcome | undefined {
    return PAST_REVIEWS.includes(job.state) ? { status: 'FAIL', detail: `the job is ${job.state} without a ${record} verdict` } : undefined;
  }

  async setup(): Promise<Outcome> {
    const { origin, work, state, config, worktrees, envFile } = this.#paths;
    for (const dir of [state, config, worktrees]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await writeFile(envFile, '');
    // The canary env file (SF-100): one random line in the smoke's config directory, which the
    // children never load (SF_ENV_FILE is the empty file); the probe is given its SHA-256 only.
    const canary = `SF_CANARY=${randomBytes(24).toString('hex')}\n`;
    await writeFile(join(config, CANARY_FILE), canary, { mode: 0o600 });
    const ssh = join(homedir(), '.ssh');
    this.#probe = smokeProbe(this.#paths, createHash('sha256').update(canary).digest('hex'), existsSync(ssh) ? ssh : undefined);
    // Every later child sf command, sf serve and its runners too, gets the probe's allow (SF-104),
    // which selects the dontAsk session (SF-109).
    this.#env = childEnv(process.env, this.#paths, this.#probe);
    await git(this.#paths.dir, ['init', '-q', '--bare', '-b', 'main', origin]);
    await git(this.#paths.dir, ['clone', '-q', origin, work]);
    await git(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await writeFile(join(work, 'greeting.txt'), 'hello\n');
    await writeFile(join(work, PROBE_SCRIPT_NAME), PROBE_SCRIPT);
    await mkdir(join(work, '.software-factory'));
    await writeFile(join(work, '.software-factory', `${TICKET}.md`), smokeTask(this.#probe));
    await git(work, ['add', 'greeting.txt', PROBE_SCRIPT_NAME, `.software-factory/${TICKET}.md`]);
    await git(work, [...GIT_ID, 'commit', '-q', '-m', 'The smoke test repository']);
    await git(work, ['push', '-q', 'origin', 'main']);
    const added = await this.#step(['workspace', 'add', WORKSPACE, '--read', work, '--handoff', 'off']);
    if (added.code !== 0) {
      return { status: 'FAIL', detail: this.#failed('sf workspace add', added) };
    }
    return this.#startServe();
  }

  async #startServe(): Promise<Outcome> {
    const child = this.#spawn(['serve']);
    this.#serve = child;
    const ready = new Promise<Outcome>((resolve) => {
      const onData = (chunk: Buffer): void => {
        this.#serveOutput = (this.#serveOutput + chunk.toString('utf8')).slice(-OUTPUT_KEEP);
        const dashboard = / dashboard (http:\/\/127\.0\.0\.1:\d+\/d\/[0-9a-f]{64}\/)/.exec(this.#serveOutput);
        if (/ listening on http:\/\/\S+\/mcp/.test(this.#serveOutput)) {
          if (dashboard === null) {
            resolve({ status: 'FAIL', detail: 'sf serve printed no dashboard URL' });
            return;
          }
          this.#dashboard = new URL(dashboard[1]!);
          resolve({ status: 'PASS', detail: `sf serve ready, dashboard on port ${this.#dashboard.port}` });
        }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.once('error', (error) => resolve({ status: 'FAIL', detail: `sf serve could not start: ${error.message}` }));
      child.once('exit', (code, signal) => resolve({ status: 'FAIL', detail: short(`sf serve exited with ${code ?? signal}: ${this.#serveOutput.trim().split('\n').slice(-3).join(' ')}`) }));
    });
    const outcome = await Promise.race([ready, this.#stopped.then(() => undefined)]);
    if (outcome === undefined) {
      throw new StopError(this.#stopReason);
    }
    return outcome;
  }

  async taskCheck(): Promise<Outcome> {
    const result = await this.#step(['check-task', WORKSPACE, TICKET]);
    const record = await new CheckStore(this.#paths.state).last(WORKSPACE, TICKET);
    if (record === undefined) {
      return { status: 'FAIL', detail: `no Task check record; ${this.#failed('sf check-task', result)}` };
    }
    if (record.status !== 'checked' || record.output === null) {
      return { status: 'FAIL', detail: short(`the check failed: ${record.error ?? 'no output'}`) };
    }
    return { status: 'PASS', detail: `verdict ${record.output.verdict}, ${record.output.findings.length} finding(s), ${usd(record.cost_usd)}` };
  }

  async start(): Promise<Outcome> {
    const result = await this.#step(['start', WORKSPACE, TICKET]);
    if (result.code !== 0) {
      return { status: 'FAIL', detail: this.#failed('sf start', result) };
    }
    const job = await this.#job();
    return this.#stoppedJob(job) ?? { status: 'PASS', detail: `job ${job!.state} on branch ${job!.branch}` };
  }

  implementer(): Promise<Outcome> {
    return this.#until(async () => {
      const job = await this.#job();
      if (job !== undefined && job.iteration >= 1) {
        const meta = await this.#jobs.readMeta(WORKSPACE, TICKET, 1).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            return undefined;
          }
          throw error;
        });
        if (meta !== undefined) {
          return { status: 'PASS', detail: `iteration 1 published, ${usd(meta.cost_usd)}` };
        }
      }
      return this.#stoppedJob(job);
    });
  }

  // Whether the run's sandbox is off (SF_SANDBOX=off reaches the children): the Sandbox step is a SKIP.
  get sandboxOff(): boolean {
    return this.#env.SF_SANDBOX === 'off';
  }

  // The Sandbox step (SF-100), once the first iteration is published: probe.json in the job's
  // worktree must exist and say refused for every probe (absent for ~/.ssh and SSH_AUTH_SOCK when
  // they are). With the sandbox off it is a SKIP.
  async sandbox(): Promise<Outcome> {
    if (this.sandboxOff) {
      return { status: 'SKIP', detail: 'sandbox off' };
    }
    const job = await this.#job();
    if (job?.worktree === null || job?.worktree === undefined) {
      return { status: 'FAIL', detail: `the job has no worktree to read ${PROBE_OUTPUT} from` };
    }
    let text: string;
    try {
      text = await readFile(join(job.worktree, PROBE_OUTPUT), 'utf8');
    } catch (error) {
      // Why there is none, from the Implementer's own probe call (SF-104).
      const events = await readFile(this.#jobs.eventsPath(WORKSPACE, TICKET), 'utf8').catch(() => '');
      return { status: 'FAIL', detail: short(probeCallProblem(events) ?? `${PROBE_OUTPUT} could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`) };
    }
    const problem = probeProblem(text);
    return problem === undefined ? { status: 'PASS', detail: `every probe refused (${PROBES.length})` } : { status: 'FAIL', detail: short(`the sandbox let through: ${problem}`) };
  }

  review(): Promise<Outcome> {
    return this.#until(async () => {
      const job = await this.#job();
      for (let number = 1; number <= Math.min(job?.iteration ?? 0, MAX_ITERATIONS); number += 1) {
        const review = await this.#jobs.readReview(WORKSPACE, TICKET, number);
        if (review !== undefined && 'verdict' in review) {
          return { status: 'PASS', detail: `iteration ${number}: ${review.verdict}, ${usd(review.cost_usd)}` };
        }
      }
      return this.#stoppedJob(job) ?? this.#wentOn(job!, 'Claude review');
    });
  }

  async gate(): Promise<Outcome> {
    // The gate the factory runs, as sf info shows it to the user.
    const info = await this.#step(['info']);
    const line = /^gate {2,}(.*)$/m.exec(info.stdout)?.[1]?.trim();
    if (line === undefined) {
      return { status: 'FAIL', detail: `sf info shows no gate line; ${this.#failed('sf info', info)}` };
    }
    if (!line.startsWith('codex ')) {
      return { status: 'FAIL', detail: short(`the gate is ${line}`), goOn: true };
    }
    return this.#until(async () => {
      const job = await this.#job();
      for (let number = 1; number <= (job?.iteration ?? 0); number += 1) {
        const gate = await this.#jobs.readGate(WORKSPACE, TICKET, number);
        if (gate !== undefined && 'verdict' in gate) {
          return { status: 'PASS', detail: `iteration ${number}: ${gate.verdict}, ${gate.tokens.input + gate.tokens.output} tokens` };
        }
      }
      return this.#stoppedJob(job) ?? this.#wentOn(job!, 'gate');
    });
  }

  mrText(): Promise<Outcome> {
    return this.#until(async () => {
      const job = await this.#job();
      if (job?.state === 'ready_for_human_review') {
        const text = await this.#jobs.readMrText(WORKSPACE, TICKET);
        if (text === undefined) {
          return { status: 'FAIL', detail: 'the job is ready for review without mr.md' };
        }
        const problem = mrTextProblem(TICKET, text);
        return problem === undefined
          ? { status: 'PASS', detail: short(text.split(/\r?\n/)[0]!) }
          : { status: 'FAIL', detail: short(`mr.md breaks the MR rules: ${problem}`) };
      }
      return this.#stoppedJob(job);
    });
  }

  async approve(): Promise<Outcome> {
    const result = await this.#step(['approve', WORKSPACE, TICKET]);
    const job = await this.#job();
    if (job?.state !== 'pushed') {
      return { status: 'FAIL', detail: `the job is ${job?.state ?? 'gone'}${job?.error !== undefined ? ` (${job.error.code}: ${short(job.error.message)})` : ''}; ${this.#failed('sf approve', result)}` };
    }
    const pushed = await runGit(this.#paths.origin, ['rev-parse', '--verify', '--quiet', `refs/heads/${job.branch}^{commit}`]);
    const commit = pushed.stdout.toString('utf8').trim();
    if (pushed.code !== 0 || commit === '') {
      return { status: 'FAIL', detail: `origin.git has no branch ${job.branch}` };
    }
    if (commit !== job.prepared_commit) {
      return { status: 'FAIL', detail: `origin.git has ${job.branch} at ${commit}, the job prepared ${job.prepared_commit ?? 'nothing'}` };
    }
    return { status: 'PASS', detail: `${job.branch} at ${commit.slice(0, 12)} on origin.git` };
  }

  async dashboard(): Promise<Outcome> {
    const base = this.#dashboard;
    if (base === undefined) {
      return { status: 'FAIL', detail: 'no dashboard URL' };
    }
    const job = `api/jobs/${WORKSPACE}/${TICKET}`;
    const targets: Array<[string, 'html' | 'json']> = [
      ['', 'html'], ['api/jobs', 'json'], ['api/tickets', 'json'], [job, 'json'], [`${job}/stream`, 'json'], [`${job}/changes`, 'json'], [`${job}/mr-view`, 'json'],
    ];
    const problems: string[] = [];
    for (const [path, kind] of targets) {
      this.#checkStop();
      const name = path === '' ? 'the board page' : path;
      try {
        const response = await fetch(new URL(path, base), { signal: AbortSignal.any([AbortSignal.timeout(HTTP_TIMEOUT_MS), this.#halted.signal]) });
        const type = response.headers.get('content-type') ?? '';
        const text = await response.text();
        if (response.status !== 200) {
          problems.push(`${name}: ${response.status}`);
        } else if (kind === 'html' && !type.startsWith('text/html')) {
          problems.push(`${name}: ${type || 'no type'}, not HTML`);
        } else if (kind === 'json') {
          try {
            if (!type.startsWith('application/json')) {
              throw new Error(type || 'no type');
            }
            JSON.parse(text);
          } catch (error) {
            problems.push(`${name}: not JSON (${(error as Error).message})`);
          }
        }
      } catch (error) {
        problems.push(`${name}: ${(error as Error).message}`);
      }
    }
    return problems.length === 0
      ? { status: 'PASS', detail: `${targets.length} answers: the page and ${targets.length - 1} API` }
      : { status: 'FAIL', detail: short(problems.join('; ')) };
  }

  // sf abort without --discard, unless the job is missing or terminal.
  async abortJob(): Promise<void> {
    const job = await this.#job().catch(() => undefined);
    if (job === undefined || TERMINAL_STATES.includes(job.state)) {
      return;
    }
    const result = await this.sf(['abort', WORKSPACE, TICKET], CLEANUP_CHILD_MS);
    this.#print(result.code === 0 ? `job aborted (sf abort ${WORKSPACE} ${TICKET})` : `the job could not be aborted: ${this.#failed('sf abort', result)}`);
  }

  // Gate tokens of the job (input plus output), or 0 without a job.
  async gateTokens(): Promise<number> {
    return (await this.#job().catch(() => undefined))?.gate_tokens ?? 0;
  }

  async cleanup(): Promise<Outcome> {
    const problems: string[] = [];
    const notes: string[] = [];
    const job = await this.#job().catch(() => undefined);
    if (job === undefined) {
      notes.push('no job to reset');
    } else {
      // An active job is aborted before its reset, always: a signal can come at any moment of
      // Cleanup, and a reset once asked of sf serve archives the job whatever happens to the
      // sf reset that asked (sf serve runs it to its end), so only an abort before it makes sure
      // that the job of an interrupted run is aborted. A pushed (or failed) job stays as it is.
      await this.abortJob();
      let reset = await this.sf(['reset', WORKSPACE, TICKET], CLEANUP_CHILD_MS);
      if (reset.code !== 0 && (await this.#job().catch(() => undefined)) !== undefined) {
        // A reset that failed or was stopped (a second signal, its limit): an active job is
        // aborted, then reset once more, before sf serve and the directory go.
        await this.abortJob();
        reset = await this.sf(['reset', WORKSPACE, TICKET], CLEANUP_CHILD_MS);
      }
      if (reset.code !== 0) {
        problems.push(this.#failed('sf reset', reset));
      } else {
        notes.push('job reset');
      }
    }
    if (this.#serve !== undefined) {
      await terminate(this.#serve, this.#groups);
      notes.push('sf serve stopped');
    }
    await this.noteRunners();
    for (const pid of this.#groups.ids()) {
      await this.#groups.end(pid);
    }
    await this.#removeOutsideWorktrees(problems);
    if (this.#options.keep) {
      notes.push(`kept ${this.#paths.dir}`);
    } else {
      try {
        await rm(this.#paths.dir, { recursive: true, force: true, maxRetries: 3 });
        notes.push('directory removed');
      } catch (error) {
        problems.push(`the directory could not be removed: ${(error as Error).message}`);
      }
    }
    return problems.length === 0 ? { status: 'PASS', detail: notes.join(', ') } : { status: 'FAIL', detail: short([...problems, ...notes].join('; ')) };
  }

  // The worktrees of the throwaway repository outside the temp directory: a Task check's
  // (<os temp>/sf-task-checks-<uid>/check-*/repo, SF-100) that a stopped sf check-task left behind.
  // Its check-* directory goes: it belongs to this run only, found through the repository's own
  // worktree list. The shared sf-task-checks-<uid> parent stays.
  async #removeOutsideWorktrees(problems: string[]): Promise<void> {
    // No repository yet (a halt before Setup made it): nothing to list, and Git cannot start in a
    // missing directory.
    if (!existsSync(this.#paths.work)) {
      return;
    }
    const listed = await runGit(this.#paths.work, ['worktree', 'list', '--porcelain']);
    if (listed.code !== 0) {
      return;
    }
    const inside = `${this.#paths.dir}/`;
    for (const line of listed.stdout.toString('utf8').split('\n')) {
      const path = line.startsWith('worktree ') ? line.slice('worktree '.length) : undefined;
      if (path === undefined || path.startsWith(inside) || basename(path) !== 'repo' || !basename(dirname(path)).startsWith('check-') || !basename(dirname(dirname(path))).startsWith('sf-task-checks-')) {
        continue;
      }
      try {
        await rm(dirname(path), { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        problems.push(`the Task check's worktree ${path} could not be removed: ${(error as Error).message}`);
      }
    }
  }

  // Remembers the job runners of the temp state (sf run, detached by sf serve, each leading its
  // own process group) by their live runner.pid locks: a runner's group may outlive its lock.
  async noteRunners(): Promise<void> {
    for (const entry of await readdir(join(this.#paths.state, 'jobs'), { recursive: true, withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name === 'runner.pid') {
        await trackRunnerLock(this.#groups, join(entry.parentPath, entry.name));
      }
    }
  }
}

function table(rows: Row[]): string {
  const cells = [['STEP', 'RESULT', 'SECONDS', 'DETAIL'], ...rows.map((row) => [row.step, row.status, row.seconds.toFixed(1), row.detail])];
  const widths = [0, 1, 2].map((column) => Math.max(...cells.map((row) => row[column]!.length)));
  return cells.map((row) => row.map((cell, column) => (column < 3 ? cell.padEnd(widths[column]!) : cell)).join('  ').trimEnd()).join('\n');
}

// Runs the smoke and returns the exit code: 0 when every step passed, 1 otherwise.
export async function runSmoke(options: SmokeOptions, print: (line: string) => void = (line) => console.log(line)): Promise<number> {
  // The signal handlers come first: a signal while the directory is being made is kept and given
  // to the run once it exists, so Cleanup removes the directory on that path too.
  let smoke: Smoke | undefined;
  let early: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (smoke === undefined) {
      early ??= signal;
    } else {
      smoke.signal(signal);
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const made = await mkdtemp(join(tmpdir(), 'sf-smoke-'));
  let dir: string;
  try {
    dir = await realpath(made);
  } catch (error) {
    await rm(made, { recursive: true, force: true });
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    throw error;
  }
  print(dir);
  const paths = smokePaths(dir);
  smoke = new Smoke(paths, options, print);
  if (early !== undefined) {
    smoke.signal(early);
  }
  // The members of the run's process groups, kept fresh until Cleanup has ended them.
  const observer = setInterval(() => smoke!.observeGroups(), MONITOR_MS);
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMin * 60_000;
  let checking = false;
  const monitor = setInterval(() => {
    if (Date.now() - startedAt > timeoutMs) {
      smoke.halt('time budget');
      return;
    }
    if (checking) {
      return;
    }
    checking = true;
    smoke.noteRunners()
      .then(() => spent(paths.state))
      .then((cost) => cost.usd > options.budgetUsd && smoke.halt('cost budget'))
      .catch(() => undefined)
      .finally(() => (checking = false));
  }, options.monitorMs ?? MONITOR_MS);
  // The budget the run is over now, else undefined: also checked before each step starts and right
  // after the last one, so an overrun the monitor's last poll did not see still fails the run.
  const overBudget = async (): Promise<string | undefined> => {
    if (Date.now() - startedAt > timeoutMs) {
      return 'time budget';
    }
    const cost = await spent(paths.state).catch(() => undefined);
    return cost !== undefined && cost.usd > options.budgetUsd ? 'cost budget' : undefined;
  };

  const rows: Row[] = [];
  const record = (row: Row): void => {
    rows.push(row);
    print(`${row.step}: ${row.status} (${row.seconds.toFixed(1)} s)${row.detail !== '' ? ` ${row.detail}` : ''}`);
  };
  const steps: Array<[StepName, () => Promise<Outcome>]> = [
    ['Setup', () => smoke.setup()], ['Task check', () => smoke.taskCheck()], ['Start', () => smoke.start()],
    ['Implementer turn', () => smoke.implementer()], ['Sandbox', () => smoke.sandbox()], ['Claude review', () => smoke.review()], ['Codex gate', () => smoke.gate()],
    ['MR text', () => smoke.mrText()], ['Approve', () => smoke.approve()], ['Dashboard', () => smoke.dashboard()],
  ];
  let skipping = false;
  for (const [step, run] of steps) {
    if (skipping) {
      record({ step, status: 'SKIP', seconds: 0, detail: '' });
      continue;
    }
    // A halt before the step starts (a signal before Setup, a budget): the step fails with it.
    const before = smoke.stopReason ?? (await overBudget());
    if (before !== undefined) {
      smoke.halt(before);
      record({ step, status: 'FAIL', seconds: 0, detail: before });
      skipping = true;
      continue;
    }
    const at = Date.now();
    let outcome: Outcome;
    try {
      outcome = await run();
    } catch (error) {
      outcome = { status: 'FAIL', detail: error instanceof StopError ? error.message : short((error as Error).message) };
    }
    if (step === 'Dashboard' && smoke.stopReason === undefined) {
      const after = await overBudget();
      if (after !== undefined) {
        smoke.halt(after);
      }
    }
    if (smoke.stopReason !== undefined) {
      // The step's child sf command and its process group are gone before the step ends.
      await smoke.stopped();
      outcome = { status: 'FAIL', detail: smoke.stopReason };
    }
    record({ step, status: outcome.status, seconds: (Date.now() - at) / 1000, detail: outcome.detail });
    if (outcome.status === 'FAIL' && outcome.goOn !== true) {
      skipping = true;
    }
  }
  clearInterval(monitor);
  smoke.endSteps();
  if (smoke.stopReason !== undefined) {
    // The running child sf command was stopped by the halt (SIGKILL included); then the job.
    await smoke.stopped();
    await smoke.abortJob();
  }
  const cost = await spent(paths.state).catch((): Spent => ({ usd: 0, unknown: true }));
  const tokens = await smoke.gateTokens();
  const at = Date.now();
  const cleaned = await smoke.cleanup();
  record({ step: 'Cleanup', status: cleaned.status, seconds: (Date.now() - at) / 1000, detail: cleaned.detail });
  clearInterval(observer);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  print('');
  print(table(rows));
  const failed = rows.filter((row) => row.status === 'FAIL').length;
  // The Sandbox step's SKIP with the sandbox off counts as a pass (SF-100); every other row must PASS.
  const unchecked = smoke.sandboxOff && rows.some((row) => row.step === 'Sandbox' && row.status === 'SKIP');
  // A signal fails the run even when it came in Cleanup, after every step passed.
  const passed = !smoke.interrupted && rows.every((row) => row.status === 'PASS' || (unchecked && row.step === 'Sandbox'));
  const totals = `cost ${cost.unknown ? 'unknown' : `${cost.usd.toFixed(4)} USD`}, gate ${tokens} tokens`;
  print(passed ? `smoke: PASS${unchecked ? ' (sandbox not checked)' : ''}, ${totals}` : `smoke: FAIL (${failed} of ${STEPS.length} steps), ${totals}`);
  return passed ? 0 : 1;
}
