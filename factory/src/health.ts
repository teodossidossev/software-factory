// The factory's health checks: a fixed list of checks, each answering ok, down or off (not
// configured, which counts as green); recovering is set by the recovery only. sf serve runs
// them every 30 s (logins hourly) in a HealthMonitor, keeps the last result for the dashboard's
// traffic light (GET api/health, the stream's health event) and notifies a check down for 3 minutes
// and that is ok again; sf health runs them once in its own process. A check never throws and never
// hangs its caller: each runs under a timeout, and a check that fails to run is down with its error.
// No check's detail holds a token or the body of a host's answer.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readdir, stat, statfs } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { DigestStore } from './digest-run.js';
import { digestFollowed, dueSlot } from './digest-schedule.js';
import { type ForgeChoice, withoutHostTokens } from './forge.js';
import { type Job, type JobStore, runningJobs, statesWith } from './jobs.js';
import { localTime } from './local-time.js';
import { healthNotification, type Notification } from './notify.js';
import type { QueueView } from './queue.js';
import { digestSettings, loadRegistry, type Registry } from './registry.js';
import { mcpUrl, type ProbeOutcome } from './server.js';
import { durationText } from './test-command.js';

export const HEALTH_STATUSES = ['ok', 'recovering', 'down', 'off'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

// One check's result: since is when its status last changed (sf health: the run's time).
export interface HealthCheck {
  id: HealthId;
  label: string;
  status: HealthStatus;
  detail: string;
  since: string;
}

export interface CheckOutcome {
  status: HealthStatus;
  detail: string;
}

// The checks, in the order they are shown.
export const HEALTH_CHECKS = [
  { id: 'mcp', label: 'MCP endpoint' },
  { id: 'tunnel', label: 'ChatGPT tunnel' },
  { id: 'tunnel-cli', label: "Tunnel's sf build" },
  { id: 'jobs', label: 'Jobs' },
  { id: 'queue', label: 'Run queue' },
  { id: 'remote', label: 'Remote dashboard' },
  { id: 'logins', label: 'Logins' },
  { id: 'disk', label: 'Disk space' },
  { id: 'sandboxes', label: 'Sandbox leftovers' },
  { id: 'digest', label: 'Morning digest' },
] as const;
export type HealthId = (typeof HEALTH_CHECKS)[number]['id'];

// sf serve's rhythm: every check every 30 s, logins hourly; a down check notified after 3 minutes.
export const CHECK_EVERY_MS = 30_000;
export const LOGINS_EVERY_MS = 60 * 60_000;
export const NOTIFY_AFTER_MS = 3 * 60_000;
// The bound of one check's run; a subprocess or request inside it has a shorter one of its own.
export const CHECK_TIMEOUT_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 3_000;
export const COMMAND_TIMEOUT_MS = 10_000;
// tunnel: the last successful poll of OpenAI's commands may be at most this old.
export const TUNNEL_POLL_MAX_AGE_S = 120;
export const TUNNEL_POLL_METRIC = 'commands_poll_last_successful_timestamp_seconds';
// jobs: a test run counts as hung this long past SF_TEST_TIMEOUT_MS; a job's runner may be missing
// this long after its last state change (it is being started).
export const TEST_RUN_GRACE_MS = 5 * 60_000;
export const RUNNER_GRACE_MS = 60_000;
// The states in which a job's runner runs (src/runner.ts).
export const RUNNER_STATES = statesWith('sandboxed');
// starting: sf serve creates the worktree and collects the rules before it starts the runner, so a
// job may be starting without one for this long.
export const STARTING_GRACE_MS = 10 * 60_000;
// waiting_limit: a parked job has no runner by design (a runner ends once its job is idle,
// src/runner.ts); the run queue's reset timer resumes it with a new one. It is stuck when its reset
// passed this long ago, it was not left to the user (reset_seen, the rule wait), and no runner took
// it on.
export const PARKED_GRACE_MS = 10 * 60_000;
// How much of the end of a job's events.jsonl the jobs check reads for its test run.
export const EVENTS_TAIL_BYTES = 256 * 1024;
// queue: nothing started for this long while the queue waits.
export const QUEUE_STUCK_MS = 10 * 60_000;
// disk: down below either bound.
export const DISK_MIN_FREE_RATIO = 0.1;
export const DISK_MIN_FREE_BYTES = 5 * 1024 ** 3;
// digest: missed this long after its due slot.
export const DIGEST_GRACE_MS = 30 * 60_000;

const ok = (detail: string): CheckOutcome => ({ status: 'ok', detail });
const down = (detail: string): CheckOutcome => ({ status: 'down', detail });
const off = (detail: string): CheckOutcome => ({ status: 'off', detail });
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------- mcp ----------

// The MCP endpoint answers an initialize with the token, as sf mcp-url --probe sends it. The URL is
// shown with <token>.
export async function checkMcp(port: number | undefined, token: string | undefined, probe: (port: number, token: string) => Promise<ProbeOutcome>): Promise<CheckOutcome> {
  if (port === undefined) {
    return down('the MCP port is unknown: SF_PORT is 0 and no sf serve answers on the state directory');
  }
  if (token === undefined) {
    return down('no MCP token yet: start sf serve');
  }
  const outcome = await probe(port, token);
  switch (outcome.result) {
    case 'answers':
      return ok(`answers at ${mcpUrl(port)}`);
    case 'refused':
      return down(`refused the token at ${mcpUrl(port)}`);
    case 'unreachable':
      return down(`does not answer at ${mcpUrl(port)}`);
    case 'unexpected':
      return down(`answered HTTP ${outcome.status} without an MCP result at ${mcpUrl(port)}`);
  }
}

// ---------- tunnel ----------

export type Fetcher = (url: string, timeoutMs: number) => Promise<{ status: number; text: string }>;

// A GET that reads the body as text, bounded by timeoutMs.
export const fetchText: Fetcher = async (url, timeoutMs) => {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, text: await response.text() };
};

// The value of a Prometheus metric in a /metrics text (the first sample, labels or not).
export function metricValue(text: string, name: string): number | undefined {
  for (const line of text.split('\n')) {
    const match = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+(\\S+)`).exec(line.trim());
    if (match !== null) {
      const value = Number(match[1]);
      return Number.isFinite(value) ? value : undefined;
    }
  }
  return undefined;
}

// off without the tunnel's profile. Otherwise its admin endpoint answers /readyz with 200 and its
// /metrics says the last successful poll of OpenAI's commands is at most 120 s old: a client can be
// ready on its own side while its connection to OpenAI is dead.
export async function checkTunnel(profile: string, address: string, fetcher: Fetcher, nowMs: number): Promise<CheckOutcome> {
  if (!existsSync(profile)) {
    return off(`no tunnel profile (${profile})`);
  }
  const base = `http://${address}`;
  let ready: number;
  try {
    ready = (await fetcher(`${base}/readyz`, REQUEST_TIMEOUT_MS)).status;
  } catch { // refused or timed out: the tunnel client is down, and the returned failure says so
    return down(`the tunnel client does not answer at ${base}/readyz, so the age of its last poll of OpenAI is unknown: start it (sf serve starts it with SF_TUNNEL=auto; or npm run tunnel)`);
  }
  let age: number | undefined;
  try {
    const metrics = await fetcher(`${base}/metrics`, REQUEST_TIMEOUT_MS);
    const last = metrics.status === 200 ? metricValue(metrics.text, TUNNEL_POLL_METRIC) : undefined;
    age = last === undefined || last <= 0 ? undefined : Math.max(0, Math.round(nowMs / 1000 - last));
  } catch { // no metrics: the age of the last poll is unknown
    age = undefined;
  }
  const poll = age === undefined ? 'no successful poll of OpenAI reported' : `last poll of OpenAI ${durationText(age * 1000)} ago`;
  if (ready !== 200) {
    return down(`/readyz answers ${ready}; ${poll}: restart the tunnel`);
  }
  if (age === undefined || age > TUNNEL_POLL_MAX_AGE_S) {
    return down(`${poll} (more than ${TUNNEL_POLL_MAX_AGE_S} s): the connection to OpenAI is dead; restart the tunnel, then refresh the plugin in ChatGPT and start a new chat`);
  }
  return ok(`ready; ${poll}`);
}

// ---------- tunnel-cli ----------

// The newest .ts file under dir, with its modification time; undefined when there is none.
async function newestSource(dir: string): Promise<{ path: string; mtimeMs: number } | undefined> {
  let newest: { path: string; mtimeMs: number } | undefined;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    const { mtimeMs } = await stat(path);
    if (newest === undefined || mtimeMs > newest.mtimeMs) {
      newest = { path, mtimeMs };
    }
  }
  return newest;
}

// The sf that scripts/sf-tunnel.sh runs (this package's bin/sf) is built from its sources: no
// src/**/*.ts is newer than dist/src/cli.js. off without the script.
export async function checkTunnelCli(packageRoot: string, script: string): Promise<CheckOutcome> {
  if (!existsSync(script)) {
    return off(`no tunnel script (${script})`);
  }
  const built = join(packageRoot, 'dist', 'src', 'cli.js');
  let builtAt: number;
  try {
    builtAt = (await stat(built)).mtimeMs;
  } catch { // no build output: the returned failure says so
    return down(`${built} is missing: run npm run build in ${packageRoot}`);
  }
  const newest = await newestSource(join(packageRoot, 'src'));
  if (newest !== undefined && newest.mtimeMs > builtAt) {
    return down(`${relative(packageRoot, newest.path)} is newer than dist/src/cli.js: run npm run build in ${packageRoot}`);
  }
  return ok('built from its sources');
}

// ---------- jobs ----------

// The last lines of a file, at most bytes from its end (the first, cut line dropped); [] without it.
async function tailLines(path: string, bytes: number): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch { // missing or unreadable: no lines
    return [];
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    return length < size ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

// The start of the job's test run that has not ended, from the end of its events.jsonl: the last
// tests_started without a tests event of the same run after it.
export async function openTestRun(eventsPath: string): Promise<string | undefined> {
  let started: string | undefined;
  for (const line of await tailLines(eventsPath, EVENTS_TAIL_BYTES)) {
    let record: { type?: unknown; run?: unknown };
    try {
      record = JSON.parse(line) as typeof record;
    } catch { // not a JSON line (a cut first line or a partial write): skipped
      continue;
    }
    if (record.type === 'tests_started' && typeof record.run === 'string') {
      started = record.run;
    } else if (record.type === 'tests' && record.run === started) {
      started = undefined;
    }
  }
  return started;
}

// What a job in a running state (RUNNING_STATES of src/jobs.ts) lacks when no runner runs it by
// now: undefined while it may be without one (its grace, a parked job before its reset, or one left
// to the user).
export function runnerDue(job: Job, nowMs: number): string | undefined {
  const since = nowMs - Date.parse(job.updated_at);
  if (RUNNER_STATES.includes(job.state)) {
    return since > RUNNER_GRACE_MS ? `${job.state} without its runner` : undefined;
  }
  if (job.state === 'starting') {
    return since > STARTING_GRACE_MS ? `starting for ${durationText(since)} without a runner` : undefined;
  }
  if (job.state === 'waiting_limit' && job.limit?.reset_seen !== true) {
    const reset = Date.parse(job.limit?.resets_at ?? job.updated_at);
    return nowMs - reset > PARKED_GRACE_MS ? `parked on a usage limit that reset ${durationText(nowMs - reset)} ago, and no runner resumed it` : undefined;
  }
  return undefined;
}

export interface JobsCheckOptions {
  jobs: Pick<JobStore, 'list' | 'eventsPath'>;
  testTimeoutMs: number;
  // Whether the job's runner (the owner of its runner.pid) is alive.
  runnerAlive(job: Job): Promise<boolean>;
  nowMs: number;
}

// down naming each job whose test run has run longer than SF_TEST_TIMEOUT_MS plus 5 minutes, and
// each job in a running state whose runner is gone past its grace (runnerDue).
export async function checkJobs(options: JobsCheckOptions): Promise<CheckOutcome> {
  const problems: string[] = [];
  const jobs = await options.jobs.list();
  for (const job of jobs) {
    const name = `${job.workspace}/${job.ticket}`;
    if (job.state === 'preparing_mr') {
      const run = await openTestRun(options.jobs.eventsPath(job.workspace, job.ticket));
      const ran = run === undefined ? 0 : options.nowMs - Date.parse(run);
      if (ran > options.testTimeoutMs + TEST_RUN_GRACE_MS) {
        problems.push(`${name}: its test run has run ${durationText(ran)} (limit ${durationText(options.testTimeoutMs)})`);
      }
    }
    const due = runnerDue(job, options.nowMs);
    if (due !== undefined && !(await options.runnerAlive(job))) {
      problems.push(`${name}: ${due}`);
    }
  }
  if (problems.length > 0) {
    return down(problems.join('; '));
  }
  const running = runningJobs(jobs).length;
  return ok(running === 0 ? 'no job runs' : `${running} running, each with its runner`);
}

// ---------- queue ----------

// What the queue check reads: the queue as it shows it (sf serve's run queue, or one built for sf
// health), when the scheduler last started a ticket (queue.json's last_start) and when the newest
// job was created (a start by hand).
export interface QueueFacts {
  view: Pick<QueueView, 'held' | 'limit_hold' | 'running' | 'entries'>;
  lastStart: string | undefined;
  newestJob: string | undefined;
}

// Why a queued ticket waits, as its row says it.
function waitReason(row: QueueView['entries'][number]): string {
  if (row.retry !== null) {
    return `start failed (${row.retry.code}); next try ${localTime(row.retry.at)?.slice(11, 16) ?? row.retry.at}`;
  }
  if (row.plan_reason !== null) {
    return row.plan_reason;
  }
  if (row.waits_for.length > 0) {
    return `waits for ${row.waits_for.map((dependency) => `${dependency.ticket} (${dependency.state})`).join(', ')}`;
  }
  return 'nothing holds it, yet it did not start';
}

// down when the queue is not held, not empty, nothing runs, and nothing started for 10 minutes
// (since the last start, or since the oldest entry was queued when that is later). An entry whose
// start could not fetch and whose next try is ahead (its row's retry) waits, it is not stuck: it
// counts for neither, and a queue of such entries only is ok.
export function checkQueue(facts: QueueFacts, nowMs: number): CheckOutcome {
  const { view } = facts;
  if (view.entries.length === 0) {
    return ok('empty');
  }
  if (view.held || view.limit_hold !== null) {
    return ok(`held with ${view.entries.length} queued`);
  }
  if (view.running > 0) {
    return ok(`${view.entries.length} queued, ${view.running} running`);
  }
  const waiting = view.entries.filter((entry) => entry.retry === null);
  if (waiting.length === 0) {
    const first = view.entries[0]!;
    return ok(`${view.entries.length} queued, each waiting for a next try; the head ${first.workspace}/${first.ticket}: ${waitReason(first)}`);
  }
  const queuedSince = Math.min(...waiting.map((entry) => Date.parse(entry.queued_at)));
  const since = Math.max(queuedSince, ...[facts.lastStart, facts.newestJob].filter((mark): mark is string => mark !== undefined).map(Date.parse));
  const head = waiting[0]!;
  if (nowMs - since > QUEUE_STUCK_MS) {
    return down(`nothing started for ${durationText(nowMs - since)} and nothing runs; the head ${head.workspace}/${head.ticket} waits: ${waitReason(head)}`);
  }
  return ok(`${view.entries.length} queued; the head ${head.workspace}/${head.ticket}: ${waitReason(head)}`);
}

// ---------- remote ----------

export interface CommandResult {
  code: number | null;
  stdout: string;
  // Set when the command could not start or did not end in time.
  error?: string;
}
export type CommandRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<CommandResult>;

// Runs a command without input and without the Git hosts' tokens in its environment; killed after
// timeoutMs. Never rejects.
export const runCheckCommand: CommandRunner = (command, args, timeoutMs) => new Promise((resolve) => {
  let stdout = '';
  let settled = false;
  const finish = (result: CommandResult): void => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
  };
  const child = spawn(command, [...args], { env: withoutHostTokens(), stdio: ['ignore', 'pipe', 'ignore'] });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish({ code: null, stdout, error: `did not end within ${timeoutMs / 1000} s` });
  }, timeoutMs);
  timer.unref();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-64 * 1024);
  });
  child.once('error', (error) => finish({ code: null, stdout, error: error.message }));
  child.once('close', (code) => finish({ code, stdout }));
});

export type PortProbe = (port: number, timeoutMs: number) => Promise<boolean>;

// Whether something answers HTTP on 127.0.0.1:port (any status).
export const httpAnswers: PortProbe = async (port, timeoutMs) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel().catch(() => undefined);
    return true;
  } catch { // refused or timed out: nothing answers on the port
    return false;
  }
};

// off without remote origins. Otherwise the remote listener answers on its port, and tailscale
// serve status proxies to it.
export async function checkRemote(origins: readonly string[], port: number, answers: PortProbe, run: CommandRunner): Promise<CheckOutcome> {
  if (origins.length === 0) {
    return off('no remote origins (SF_DASHBOARD_REMOTE_ORIGINS)');
  }
  if (!(await answers(port, REQUEST_TIMEOUT_MS))) {
    return down(`the remote listener does not answer on 127.0.0.1:${port}`);
  }
  const status = await run('tailscale', ['serve', 'status'], COMMAND_TIMEOUT_MS);
  if (status.error !== undefined || status.code !== 0) {
    return down(`tailscale serve status failed (${status.error ?? `exit ${status.code}`})`);
  }
  if (!new RegExp(`(?:127\\.0\\.0\\.1|localhost):${port}\\b`).test(status.stdout)) {
    return down(`tailscale serve does not proxy to 127.0.0.1:${port}: run tailscale serve --bg ${port}`);
  }
  return ok(`listening on ${port}, served by Tailscale`);
}

// ---------- logins ----------

export type ForgeTarget = Extract<ForgeChoice, { ok: true }>;

export interface LoginsCheckOptions {
  // The Claude CLI the factory runs; undefined: not checked.
  claudePath: string | undefined;
  // The Codex CLI of the gate; undefined (gate off): not checked.
  codexPath: string | undefined;
  run: CommandRunner;
  // The forge tokens the registered workspaces use, one per host API and variable.
  forgeTargets(): Promise<ForgeTarget[]>;
  checkToken(target: ForgeTarget): Promise<{ ok: true } | { ok: false; reason: string }>;
}

// The Claude CLI and the Codex CLI are logged in (claude auth status, codex login status: exit 0),
// and each forge token of a registered workspace is accepted by its host.
export async function checkLogins(options: LoginsCheckOptions): Promise<CheckOutcome> {
  // One answer per login: undefined when it is fine, else what is wrong; null when not checked.
  const cli = async (name: string, path: string | undefined, args: string[], fix: string): Promise<{ name: string; problem: string | undefined } | null> => {
    if (path === undefined) {
      return null;
    }
    const result = await options.run(path, args, COMMAND_TIMEOUT_MS);
    const problem = result.error !== undefined ? `${name}: ${path} ${args.join(' ')} ${result.error}` : result.code !== 0 ? `${name} is not logged in: run ${fix}` : undefined;
    return { name, problem };
  };
  const tokens = async (): Promise<Array<{ name: string; problem: string | undefined }>> => Promise.all((await options.forgeTargets()).map(async (target) => {
    const answer = await options.checkToken(target);
    return { name: target.tokenName, problem: answer.ok ? undefined : answer.reason };
  }));
  const [claude, codex, forges] = await Promise.all([
    cli('Claude CLI', options.claudePath, ['auth', 'status'], 'claude /login'),
    cli('Codex CLI', options.codexPath, ['login', 'status'], 'codex login'),
    tokens(),
  ]);
  const answers = [claude, codex, ...forges].filter((answer) => answer !== null);
  const problems = answers.map((answer) => answer.problem).filter((problem) => problem !== undefined);
  if (problems.length > 0) {
    return down(problems.join('; '));
  }
  return answers.length === 0 ? off('nothing to log in to') : ok(`logged in: ${answers.map((answer) => answer.name).join(', ')}`);
}

// The forge tokens of the registered workspaces: each workspace's origin on a host whose token is
// set, one per host API and variable.
export async function forgeTargets(registry: Registry, origin: (checkout: string) => Promise<string | undefined>, choose: (origin: string | undefined) => ForgeChoice): Promise<ForgeTarget[]> {
  const targets = new Map<string, ForgeTarget>();
  for (const entry of Object.values(registry.workspaces)) {
    const choice = choose(await origin(entry.read_checkout).catch(() => undefined));
    if (choice.ok) {
      targets.set(`${choice.api} ${choice.tokenName}`, choice);
    }
  }
  return [...targets.values()];
}

// ---------- disk ----------

export type FreeSpace = (path: string) => Promise<{ device: number; free: number; total: number }>;

// The file system of path (of its nearest existing parent when it does not exist yet).
export const freeSpace: FreeSpace = async (path) => {
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) {
    existing = dirname(existing);
  }
  const [fs, info] = await Promise.all([statfs(existing), stat(existing)]);
  return { device: info.dev, free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize };
};

const gigabytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

// down when the file system of a path (the state directory, a worktree root) has less than 10 %
// or less than 5 GB free.
export async function checkDisk(paths: readonly string[], space: FreeSpace): Promise<CheckOutcome> {
  const seen = new Set<number>();
  const low: string[] = [];
  const shown: string[] = [];
  for (const path of paths) {
    const { device, free, total } = await space(path);
    if (seen.has(device)) {
      continue;
    }
    seen.add(device);
    const ratio = total === 0 ? 1 : free / total;
    const line = `${path}: ${gigabytes(free)} free (${Math.round(ratio * 100)} %)`;
    shown.push(line);
    if (ratio < DISK_MIN_FREE_RATIO || free < DISK_MIN_FREE_BYTES) {
      low.push(line);
    }
  }
  return low.length > 0 ? down(`low on space: ${low.join('; ')}`) : ok(shown.join('; '));
}

// ---------- sandboxes ----------

// A fresh orphan scan (OrphanWatch of sandbox-reaper.ts); down when a pid it found was also found
// by the previous scan, so the reaper did not end it. The first scan is never down.
export async function checkSandboxes(scan: () => Promise<{ found: number; persisting: number[] }>): Promise<CheckOutcome> {
  const { found, persisting } = await scan();
  if (persisting.length > 0) {
    return down(`${persisting.length} orphaned sandbox process${persisting.length === 1 ? '' : 'es'} outlived the reaper`);
  }
  return ok(found === 0 ? 'no orphaned sandbox' : `${found} orphaned sandbox process${found === 1 ? '' : 'es'} found, not yet seen twice`);
}

// ---------- digest ----------

// off when no digest is scheduled. down when it was missed (a due slot, dueSlot, with no scheduled
// digest started at or after it, more than 30 minutes past), or when the last scheduled digest's
// record has an error. ok names the times.
export async function checkDigest(registry: Registry, digests: Pick<DigestStore, 'list'>, now: Date): Promise<CheckOutcome> {
  if (!digestFollowed(registry)) {
    return off('no digest scheduled (no workspace follows)');
  }
  const scheduled = (await digests.list()).filter((summary) => summary.trigger === 'scheduled');
  const last = scheduled[0];
  const slot = dueSlot(registry, now);
  if (slot !== null && !scheduled.some((summary) => Date.parse(summary.started_at) >= slot.getTime()) && now.getTime() - slot.getTime() > DIGEST_GRACE_MS) {
    return down(`the digest due at ${slot.toTimeString().slice(0, 5)} did not start`);
  }
  if (last?.error !== null && last?.error !== undefined) {
    return down(`the last scheduled digest failed: ${last.error.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  const times = `scheduled at ${digestSettings(registry).times.join(', ')}`;
  return ok(last === undefined ? times : `${times}; last scheduled digest ${last.started_at}`);
}

// ---------- the list ----------

// What the checks are run with: sf serve's and sf health's each (src/cli.ts).
export interface HealthDeps {
  now(): Date;
  mcp(): Promise<{ port: number | undefined; token: string | undefined }>;
  probe(port: number, token: string): Promise<ProbeOutcome>;
  tunnelProfile: string;
  tunnelAddress: string;
  fetch: Fetcher;
  packageRoot: string;
  tunnelScript: string;
  jobs: Omit<JobsCheckOptions, 'nowMs'>;
  queue(): Promise<QueueFacts>;
  // The remote origins and the remote listener's port, read when the check runs (an invalid setting
  // makes the check down).
  remote(): { origins: readonly string[]; port: number };
  answers: PortProbe;
  run: CommandRunner;
  logins: Omit<LoginsCheckOptions, 'run'>;
  diskPaths: readonly string[];
  freeSpace: FreeSpace;
  sandboxes(): Promise<{ found: number; persisting: number[] }>;
  configDir: string;
  digests: Pick<DigestStore, 'list'>;
}

// Each check's run, by id.
function runners(deps: HealthDeps): Record<HealthId, () => Promise<CheckOutcome>> {
  return {
    mcp: async () => {
      const { port, token } = await deps.mcp();
      return checkMcp(port, token, deps.probe);
    },
    tunnel: () => checkTunnel(deps.tunnelProfile, deps.tunnelAddress, deps.fetch, deps.now().getTime()),
    'tunnel-cli': () => checkTunnelCli(deps.packageRoot, deps.tunnelScript),
    jobs: () => checkJobs({ ...deps.jobs, nowMs: deps.now().getTime() }),
    queue: async () => checkQueue(await deps.queue(), deps.now().getTime()),
    remote: () => {
      const { origins, port } = deps.remote();
      return checkRemote(origins, port, deps.answers, deps.run);
    },
    logins: () => checkLogins({ ...deps.logins, run: deps.run }),
    disk: () => checkDisk(deps.diskPaths, deps.freeSpace),
    sandboxes: () => checkSandboxes(deps.sandboxes),
    digest: async () => checkDigest(await loadRegistry(deps.configDir), deps.digests, deps.now()),
  };
}

// One check's run that never throws and never takes longer than timeoutMs: a failure or a timeout
// is down with its reason.
export async function guarded(work: () => Promise<CheckOutcome>, timeoutMs = CHECK_TIMEOUT_MS): Promise<CheckOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CheckOutcome>((resolve) => {
    timer = setTimeout(() => resolve(down(`the check did not finish within ${timeoutMs / 1000} s`)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([Promise.resolve().then(work).catch((error: unknown) => down(`the check failed: ${message(error)}`)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const labelOf = (id: HealthId): string => HEALTH_CHECKS.find((check) => check.id === id)!.label;

// Runs the checks of ids (all by default) at once; each since is the run's time.
export async function runChecks(deps: HealthDeps, ids: readonly HealthId[] = HEALTH_CHECKS.map((check) => check.id), timeoutMs = CHECK_TIMEOUT_MS): Promise<HealthCheck[]> {
  const run = runners(deps);
  const since = deps.now().toISOString();
  return Promise.all(ids.map(async (id) => ({ id, label: labelOf(id), ...(await guarded(run[id], timeoutMs)), since })));
}

// The light's colour: red when any check is down, else yellow when any recovers, else green.
export function overall(checks: readonly HealthCheck[]): 'red' | 'yellow' | 'green' {
  return checks.some((check) => check.status === 'down') ? 'red' : checks.some((check) => check.status === 'recovering') ? 'yellow' : 'green';
}

// sf health's exit code: 0 all ok or off, 3 any recovering and none down, 1 any down.
export function healthExitCode(checks: readonly HealthCheck[]): number {
  return { red: 1, yellow: 3, green: 0 }[overall(checks)];
}

// sf health's rows: one per check, its status, label and detail.
export function healthLines(checks: readonly HealthCheck[]): string[] {
  const width = Math.max(...checks.map((check) => check.label.length));
  return checks.map((check) => `${check.status.toUpperCase().padEnd(10)} ${check.label.padEnd(width)}  ${check.detail}`);
}

// ---------- sf serve's monitor ----------

export interface HealthMonitorOptions {
  everyMs?: number;
  loginsEveryMs?: number;
  notifyAfterMs?: number;
  timeoutMs?: number;
  // Called after a pass in which any status changed (the dashboard's health event; a changed detail
  // alone is read with GET api/health); never throws.
  onChange?: (checks: HealthCheck[]) => void;
  // A check down for notifyAfterMs, or ok again after it was notified down; never rejects.
  notify?: (notification: Notification) => Promise<unknown>;
  // The recovery (src/recovery.ts): each pass's results as they are shown and notified; never throws.
  recover?: (results: HealthCheck[]) => HealthCheck[];
}

// sf serve's checks: every everyMs, logins every loginsEveryMs; the last result kept, since moved
// on a status change only. A pass never overlaps the previous one.
export class HealthMonitor {
  readonly #deps: HealthDeps;
  readonly #everyMs: number;
  readonly #loginsEveryMs: number;
  readonly #notifyAfterMs: number;
  readonly #timeoutMs: number;
  readonly #onChange: (checks: HealthCheck[]) => void;
  readonly #notify: (notification: Notification) => Promise<unknown>;
  readonly #recover: (results: HealthCheck[]) => HealthCheck[];
  readonly #checks = new Map<HealthId, HealthCheck>();
  // Each check out of ok and off: since when (recovering does not break it), or notified once down.
  readonly #outages = new Map<HealthId, number | 'notified'>();
  #loginsAt: number | undefined;
  #timer: NodeJS.Timeout | undefined;
  #pass: Promise<void> | undefined;

  constructor(deps: HealthDeps, options: HealthMonitorOptions = {}) {
    this.#deps = deps;
    this.#everyMs = options.everyMs ?? CHECK_EVERY_MS;
    this.#loginsEveryMs = options.loginsEveryMs ?? LOGINS_EVERY_MS;
    this.#notifyAfterMs = options.notifyAfterMs ?? NOTIFY_AFTER_MS;
    this.#timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
    this.#onChange = options.onChange ?? (() => {});
    this.#notify = options.notify ?? (() => Promise.resolve());
    this.#recover = options.recover ?? ((results) => results);
  }

  // The last result, in the checks' order; [] before the first pass ended.
  list(): HealthCheck[] {
    return HEALTH_CHECKS.map((check) => this.#checks.get(check.id)).filter((check): check is HealthCheck => check !== undefined);
  }

  // One pass (the one running, when one runs).
  check(): Promise<void> {
    this.#pass ??= this.#run().finally(() => (this.#pass = undefined));
    return this.#pass;
  }

  async #run(): Promise<void> {
    const nowMs = this.#deps.now().getTime();
    const loginsDue = this.#loginsAt === undefined || nowMs - this.#loginsAt >= this.#loginsEveryMs;
    const ids = HEALTH_CHECKS.map((check) => check.id).filter((id) => id !== 'logins' || loginsDue);
    this.#loginsAt = loginsDue ? nowMs : this.#loginsAt;
    const results = this.#recover(await runChecks(this.#deps, ids, this.#timeoutMs));
    let changed = false;
    for (const result of results) {
      const before = this.#checks.get(result.id);
      changed ||= before?.status !== result.status;
      this.#checks.set(result.id, before?.status === result.status ? { ...result, since: before.since } : result);
      this.#notifyChange(result);
    }
    if (changed) {
      try {
        this.#onChange(this.list());
      } catch (error) {
        console.error(error);
      }
    }
  }

  // One notification once a check is down notifyAfterMs after it left ok and off, one when it is back.
  #notifyChange(result: HealthCheck): void {
    const atMs = Date.parse(result.since);
    const outage = this.#outages.get(result.id) ?? atMs;
    let turned: 'down' | 'ok' | undefined;
    if (result.status === 'ok' || result.status === 'off') {
      turned = this.#outages.delete(result.id) && outage === 'notified' ? 'ok' : undefined;
    } else {
      turned = result.status === 'down' && outage !== 'notified' && atMs - outage >= this.#notifyAfterMs ? 'down' : undefined;
      this.#outages.set(result.id, turned === 'down' ? 'notified' : outage);
    }
    if (turned !== undefined) {
      this.#notify(healthNotification(result, turned)).catch((error: unknown) => console.error(error));
    }
  }

  // The first pass now, then every everyMs.
  start(): void {
    void this.check();
    this.#timer = setInterval(() => void this.check(), this.#everyMs).unref();
  }

  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
