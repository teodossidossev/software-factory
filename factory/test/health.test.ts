// The health checks (SF-153): each check's ok, down and off cases with fakes (a fake tunnel admin
// endpoint serving /readyz and /metrics with an old and a fresh poll, a stale and a fresh build, a
// job past its test limit, a stuck queue, ...), the guard that keeps a failing or hanging check from
// its caller, sf serve's monitor (since, the change callback, one notification down and one ok
// again), and sf health's exit codes and --json.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkForgeToken, type ForgeChoice } from '../src/forge.js';
import {
  checkDigest, checkDisk, checkJobs, checkLogins, checkMcp, checkQueue, checkRemote, checkSandboxes, checkTunnel, checkTunnelCli, type CommandRunner, fetchText, guarded,
  HEALTH_CHECKS, type HealthCheck, type HealthDeps, healthExitCode, healthLines, HealthMonitor, type HealthStatus, metricValue, type QueueFacts, runChecks,
} from '../src/health.js';
import type { Job } from '../src/jobs.js';
import type { Notification } from '../src/notify.js';
import { QUEUE_FILE, QueueStore, RunQueue } from '../src/queue.js';
import { STATE_VERSION } from '../src/state-version.js';
import type { Registry } from '../src/registry.js';
import { OrphanWatch } from '../src/sandbox-reaper.js';
import { newEnv, runCli } from './support/harness.js';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const MIN = 60_000;

async function tempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `sf-health-${name}-`));
}

// An HTTP server on loopback answering each path with handler's status and text.
async function fakeServer(handler: (path: string) => { status: number; text: string }): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const { status, text } = handler(req.url ?? '/');
    res.writeHead(status, { 'content-type': 'text/plain' }).end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('mcp: ok when the endpoint answers the token; down without a port, without a token, refused or unreachable; the URL shows <token>', async () => {
  const answering = await checkMcp(8787, 'secret-token', async () => ({ result: 'answers' }));
  assert.equal(answering.status, 'ok');
  assert.match(answering.detail, /127\.0\.0\.1:8787\/mcp\/<token>/);
  assert.doesNotMatch(answering.detail, /secret-token/);
  assert.equal((await checkMcp(undefined, 't', async () => ({ result: 'answers' }))).status, 'down');
  assert.match((await checkMcp(8787, undefined, async () => ({ result: 'answers' }))).detail, /no MCP token/);
  assert.match((await checkMcp(8787, 't', async () => ({ result: 'refused' }))).detail, /refused the token/);
  const unreachable = await checkMcp(8787, 't', async () => ({ result: 'unreachable' }));
  assert.deepEqual([unreachable.status, /does not answer/.test(unreachable.detail)], ['down', true]);
  assert.equal((await checkMcp(8787, 't', async () => ({ result: 'unexpected', status: 500 }))).status, 'down');
});

test('tunnel: off without a profile; ok with /readyz 200 and a fresh poll; down when /readyz is 200 but the last poll is old, when /readyz fails or nothing answers', async () => {
  const dir = await tempDir('tunnel');
  const profile = join(dir, 'software-factory.yaml');
  const nowMs = NOW;
  assert.equal((await checkTunnel(profile, '127.0.0.1:1', fetchText, nowMs)).status, 'off');
  await writeFile(profile, 'mcp: {}\n');
  let lastPoll = nowMs / 1000 - 30;
  let ready = 200;
  const admin = await fakeServer((path) => (path === '/readyz'
    ? { status: ready, text: 'ready' }
    : { status: 200, text: `# HELP x\nother_metric 1\ncommands_poll_last_successful_timestamp_seconds{tunnel="t"} ${lastPoll}\n` }));
  try {
    const address = `127.0.0.1:${admin.port}`;
    const fresh = await checkTunnel(profile, address, fetchText, nowMs);
    assert.equal(fresh.status, 'ok');
    assert.match(fresh.detail, /last poll of OpenAI 30 s ago/);
    // The case of 2026-11-09: ready on its own side, its connection to OpenAI dead for 300 s.
    lastPoll = nowMs / 1000 - 300;
    const stale = await checkTunnel(profile, address, fetchText, nowMs);
    assert.equal(stale.status, 'down');
    assert.match(stale.detail, /last poll of OpenAI 5 min ago \(more than 120 s\)/);
    lastPoll = nowMs / 1000 - 10;
    ready = 503;
    const notReady = await checkTunnel(profile, address, fetchText, nowMs);
    assert.deepEqual([notReady.status, /\/readyz answers 503/.test(notReady.detail)], ['down', true]);
  } finally {
    await admin.close();
  }
  const gone = await checkTunnel(profile, `127.0.0.1:${admin.port}`, fetchText, nowMs);
  assert.deepEqual([gone.status, /does not answer/.test(gone.detail)], ['down', true]);
  // Without the metric the poll's age is unknown: down.
  const noMetric = await fakeServer(() => ({ status: 200, text: 'ok\n' }));
  try {
    const result = await checkTunnel(profile, `127.0.0.1:${noMetric.port}`, fetchText, nowMs);
    assert.deepEqual([result.status, /no successful poll/.test(result.detail)], ['down', true]);
  } finally {
    await noMetric.close();
  }
  assert.equal(metricValue('a 1\ncommands_poll_last_successful_timestamp_seconds 1.7e9\n', 'commands_poll_last_successful_timestamp_seconds'), 1.7e9);
});

test('tunnel-cli: off without the script; ok when dist/src/cli.js is newer than every src/**/*.ts; down with a stale or missing build', async () => {
  const root = await tempDir('build');
  const script = join(root, 'sf-tunnel.sh');
  assert.equal((await checkTunnelCli(root, script)).status, 'off');
  await writeFile(script, '#!/bin/sh\n');
  await mkdir(join(root, 'src', 'execution'), { recursive: true });
  await writeFile(join(root, 'src', 'cli.ts'), '');
  await writeFile(join(root, 'src', 'execution', 'core.ts'), '');
  const missing = await checkTunnelCli(root, script);
  assert.deepEqual([missing.status, /missing: run npm run build/.test(missing.detail)], ['down', true]);
  await mkdir(join(root, 'dist', 'src'), { recursive: true });
  await writeFile(join(root, 'dist', 'src', 'cli.js'), '');
  const old = new Date(NOW - 60 * MIN);
  const built = new Date(NOW - 30 * MIN);
  await utimes(join(root, 'src', 'cli.ts'), old, old);
  await utimes(join(root, 'src', 'execution', 'core.ts'), old, old);
  await utimes(join(root, 'dist', 'src', 'cli.js'), built, built);
  assert.equal((await checkTunnelCli(root, script)).status, 'ok');
  const changed = new Date(NOW - 10 * MIN);
  await utimes(join(root, 'src', 'execution', 'core.ts'), changed, changed);
  const stale = await checkTunnelCli(root, script);
  assert.equal(stale.status, 'down');
  assert.equal(stale.detail, `src/execution/core.ts is newer than dist/src/cli.js: run npm run build in ${root}`);
});

function job(ticket: string, state: Job['state'], updatedAt: number): Job {
  return { workspace: 'app', ticket, state, updated_at: iso(updatedAt), created_at: iso(updatedAt - 60 * MIN) } as Job;
}

test('jobs: ok when every running job has its runner; down naming a job whose test run is past SF_TEST_TIMEOUT_MS plus 5 minutes, and a job in any running state whose runner is gone past its grace (starting, parked past its reset)', async () => {
  const dir = await tempDir('jobs');
  const events = (ticket: string): string => join(dir, `${ticket}.jsonl`);
  const line = (record: object): string => `${JSON.stringify(record)}\n`;
  const testTimeoutMs = 30 * MIN;
  // T-1's run started 7 hours ago and never ended (the night of 2026-11-09); T-2's run ended;
  // T-3's run started 20 minutes ago.
  await writeFile(events('T-1'), line({ type: 'tests_started', run: iso(NOW - 7 * 60 * MIN) }));
  await writeFile(events('T-2'), line({ type: 'tests_started', run: iso(NOW - 7 * 60 * MIN) }) + line({ type: 'tests', run: iso(NOW - 7 * 60 * MIN), outcome: 'passed' }));
  await writeFile(events('T-3'), line({ type: 'tests_started', run: iso(NOW - 20 * MIN) }));
  const alive = new Set(['T-1', 'T-2', 'T-3', 'T-4']);
  let jobs = [job('T-1', 'preparing_mr', NOW - 7 * 60 * MIN), job('T-2', 'preparing_mr', NOW - 60 * MIN), job('T-3', 'preparing_mr', NOW - 20 * MIN), job('T-4', 'working', NOW - 5 * MIN), job('T-5', 'needs_human', NOW - 60 * MIN)];
  const options = () => ({
    jobs: { list: async () => jobs, eventsPath: (_workspace: string, ticket: string) => events(ticket) },
    testTimeoutMs, runnerAlive: async (one: Job) => alive.has(one.ticket), nowMs: NOW,
  });
  const hung = await checkJobs(options());
  assert.equal(hung.status, 'down');
  assert.equal(hung.detail, 'app/T-1: its test run has run 7 h (limit 30 min)');
  jobs = jobs.filter((one) => one.ticket !== 'T-1');
  assert.deepEqual(await checkJobs(options()), { status: 'ok', detail: '3 running, each with its runner' });
  alive.delete('T-4');
  assert.deepEqual(await checkJobs(options()), { status: 'down', detail: 'app/T-4: working without its runner' });
  // A runner being started (a state change less than a minute ago) is not missing yet.
  jobs = jobs.map((one) => (one.ticket === 'T-4' ? { ...one, updated_at: iso(NOW - 10_000) } : one));
  assert.equal((await checkJobs(options())).status, 'ok');
  // A job sf serve is still starting (its worktree, its rules) has no runner yet; after 10 minutes it is stuck.
  alive.add('T-4');
  jobs = [job('T-6', 'starting', NOW - 5 * MIN)];
  assert.equal((await checkJobs(options())).status, 'ok');
  jobs = [job('T-6', 'starting', NOW - 12 * MIN)];
  assert.deepEqual(await checkJobs(options()), { status: 'down', detail: 'app/T-6: starting for 12 min without a runner' });
  // A parked job has no runner by design until the reset timer resumes it: down only once its reset
  // passed 10 minutes ago and no runner took it on; never when left to the user (reset_seen).
  const parked = (resetsAt: number, seen = false): Job => ({ ...job('T-7', 'waiting_limit', NOW - 60 * MIN), limit: { provider: 'claude', resets_at: iso(resetsAt), ...(seen ? { reset_seen: true as const } : {}) } });
  jobs = [parked(NOW + 30 * MIN)];
  assert.deepEqual(await checkJobs(options()), { status: 'ok', detail: '1 running, each with its runner' });
  jobs = [parked(NOW - 5 * MIN)];
  assert.equal((await checkJobs(options())).status, 'ok');
  jobs = [parked(NOW - 15 * MIN)];
  assert.deepEqual(await checkJobs(options()), { status: 'down', detail: 'app/T-7: parked on a usage limit that reset 15 min ago, and no runner resumed it' });
  alive.add('T-7');
  assert.equal((await checkJobs(options())).status, 'ok', 'a runner resumed it');
  alive.delete('T-7');
  jobs = [parked(NOW - 15 * MIN, true)];
  assert.equal((await checkJobs(options())).status, 'ok', 'left to the user under the rule wait');
  jobs = [];
  assert.deepEqual(await checkJobs(options()), { status: 'ok', detail: 'no job runs' });
});

function queueFacts(extra: Partial<QueueFacts['view']> = {}, lastStart?: number): QueueFacts {
  const entries = [{
    workspace: 'app', ticket: 'T-9', position: 1, queued_at: iso(NOW - 3 * 60 * MIN), waits_for: [], force: false, plan_reason: 'plan not ready: 1 blocker, 0 major',
  }];
  return { view: { held: false, limit_hold: null, running: 0, entries, ...extra }, lastStart: lastStart === undefined ? undefined : iso(lastStart), newestJob: undefined };
}

test('queue: down when not held, not empty, nothing runs and nothing started for 10 minutes, naming the head and why it waits; ok otherwise', () => {
  const stuck = checkQueue(queueFacts(), NOW);
  assert.equal(stuck.status, 'down');
  assert.equal(stuck.detail, 'nothing started for 3 h and nothing runs; the head app/T-9 waits: plan not ready: 1 blocker, 0 major');
  assert.equal(checkQueue(queueFacts({}, NOW - 5 * MIN), NOW).status, 'ok');
  assert.equal(checkQueue(queueFacts({}, NOW - 15 * MIN), NOW).status, 'down');
  assert.equal(checkQueue(queueFacts({ held: true }), NOW).status, 'ok');
  assert.equal(checkQueue(queueFacts({ limit_hold: { parked: 1, resets_at: null } }), NOW).status, 'ok');
  assert.equal(checkQueue(queueFacts({ running: 1 }), NOW).status, 'ok');
  assert.deepEqual(checkQueue(queueFacts({ entries: [] }), NOW), { status: 'ok', detail: 'empty' });
  // A ticket queued 2 minutes ago has not waited 10 minutes, however old the last start.
  const fresh = queueFacts({}, NOW - 5 * 60 * MIN);
  fresh.view.entries[0]!.queued_at = iso(NOW - 2 * MIN);
  assert.equal(checkQueue(fresh, NOW).status, 'ok');
  const waiting = queueFacts();
  waiting.view.entries[0] = { ...waiting.view.entries[0]!, plan_reason: null, waits_for: [{ workspace: 'app', ticket: 'T-8', state: 'pushed' } as never] };
  assert.match(checkQueue(waiting, NOW).detail, /waits: waits for T-8 \(pushed\)/);
});

test('queue.json\'s last_start: the scheduler writes it with the entry\'s removal before each start (state format 3); absent before the first', async () => {
  const state = await tempDir('queue-start');
  const store = new QueueStore(state, 3);
  assert.equal((await store.read()).last_start, undefined);
  const queue = await store.read();
  await store.write({ ...queue, last_start: iso(NOW) });
  assert.equal((await store.read()).last_start, iso(NOW));
  assert.equal(JSON.parse(await readFile(join(state, QUEUE_FILE), 'utf8')).last_start, iso(NOW));
  assert.equal(STATE_VERSION, 3);
  // A RunQueue's start records its time, in the write that takes the entry out.
  const writes: Array<string | undefined> = [];
  const recording = new QueueStore(state, 3);
  const original = recording.write.bind(recording);
  recording.write = async (file) => {
    writes.push(file.last_start);
    await original(file);
  };
  await original({ ...queue, entries: [{ workspace: 'app', ticket: 'T-1', queued_at: iso(NOW) }] });
  const started: string[] = [];
  const execution = {
    start: async (_workspace: string, ticket: string) => {
      started.push(ticket);
      return {} as never;
    },
    fetchBase: async () => undefined,
    limitReset: async () => 'skipped' as const,
  };
  const setup = { dependencyStates: async () => [], lastJobBase: async () => undefined };
  const jobs = { list: async () => [], read: async () => undefined };
  const run = new RunQueue(recording, execution as never, setup as never, jobs as never, { resolve: async () => ({ name: 'app' }) as never });
  const before = Date.now();
  await run.schedule();
  await run.idle();
  run.close();
  assert.deepEqual(started, ['T-1']);
  const last = (await recording.read()).last_start;
  assert.ok(last !== undefined && Date.parse(last) >= before - 1000, String(last));
  assert.equal(writes.at(-1), last);
});

test('remote: off without remote origins; down when the listener does not answer or tailscale serve does not proxy to it; ok otherwise', async () => {
  const origins = ['https://box.tail1234.ts.net'];
  const served = (stdout: string, code = 0): CommandRunner => async () => ({ code, stdout });
  assert.equal((await checkRemote([], 8789, async () => true, served(''))).status, 'off');
  assert.match((await checkRemote(origins, 8789, async () => false, served(''))).detail, /does not answer on 127\.0\.0\.1:8789/);
  const proxying = 'https://box.tail1234.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:8789\n';
  assert.equal((await checkRemote(origins, 8789, async () => true, served(proxying))).status, 'ok');
  assert.match((await checkRemote(origins, 8789, async () => true, served(proxying.replace('8789', '8788')))).detail, /does not proxy to 127\.0\.0\.1:8789/);
  assert.equal((await checkRemote(origins, 8789, async () => true, async () => ({ code: null, stdout: '', error: 'spawn tailscale ENOENT' }))).status, 'down');
});

const GITHUB_TARGET = (api: string, token: string): Extract<ForgeChoice, { ok: true }> => ({ ok: true, kind: 'github', host: 'github.com', path: 'o/r', api, token, tokenName: 'SF_GITHUB_TOKEN' });

test('logins: the CLIs\' own status commands and each forge token; down names which and what to run; off with nothing to log in to', async () => {
  const calls: string[] = [];
  const run = (codes: Record<string, number>): CommandRunner => async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    return { code: codes[command] ?? 0, stdout: '' };
  };
  const base = { forgeTargets: async () => [], checkToken: async () => ({ ok: true as const }) };
  assert.equal((await checkLogins({ ...base, claudePath: undefined, codexPath: undefined, run: run({}) })).status, 'off');
  const fine = await checkLogins({ ...base, claudePath: '/bin/claude', codexPath: '/bin/codex', run: run({}) });
  assert.deepEqual(fine, { status: 'ok', detail: 'logged in: Claude CLI, Codex CLI' });
  assert.deepEqual(calls, ['/bin/claude auth status', '/bin/codex login status']);
  const codexOut = await checkLogins({ ...base, claudePath: '/bin/claude', codexPath: '/bin/codex', run: run({ '/bin/codex': 1 }) });
  assert.deepEqual(codexOut, { status: 'down', detail: 'Codex CLI is not logged in: run codex login' });
  const refused = await checkLogins({
    claudePath: '/bin/claude', codexPath: undefined, run: run({}),
    forgeTargets: async () => [GITHUB_TARGET('https://api.github.com', 'ghp_x')], checkToken: async () => ({ ok: false, reason: 'GitHub refused SF_GITHUB_TOKEN (401): renew it in the environment file' }),
  });
  assert.equal(refused.status, 'down');
  assert.match(refused.detail, /GitHub refused SF_GITHUB_TOKEN/);
});

test('checkForgeToken: one GET /user with the token in the Authorization header; 200 is accepted, 401 refused; the reply body and the token never reach the reason', async () => {
  const token = 'ghp_secret_value';
  const seen: Array<{ path: string; auth: string | undefined }> = [];
  let status = 200;
  const host = createServer((req, res) => {
    seen.push({ path: req.url ?? '', auth: req.headers.authorization });
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ login: 'me', message: `Bad credentials ${token}` }));
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await checkForgeToken(GITHUB_TARGET(api, token)), { ok: true });
    assert.deepEqual(seen, [{ path: '/user', auth: `Bearer ${token}` }]);
    status = 401;
    const refused = await checkForgeToken(GITHUB_TARGET(api, token));
    assert.deepEqual(refused, { ok: false, reason: 'GitHub refused SF_GITHUB_TOKEN (401): renew it in the environment file' });
    status = 302;
    const redirected = await checkForgeToken(GITHUB_TARGET(api, token));
    assert.equal(redirected.ok, false);
    assert.doesNotMatch(JSON.stringify(redirected), /Bad credentials|ghp_secret/);
  } finally {
    await new Promise((resolve) => host.close(resolve));
  }
});

test('disk: down when a file system has less than 10 % or 5 GB free; one line per file system', async () => {
  const GB = 1024 ** 3;
  const space = (free: number, total: number, device = 1) => async () => ({ device, free, total });
  const fine = await checkDisk(['/state', '/worktrees'], space(100 * GB, 400 * GB));
  assert.deepEqual(fine, { status: 'ok', detail: '/state: 100.0 GB free (25 %)' });
  assert.equal((await checkDisk(['/state'], space(30 * GB, 400 * GB))).status, 'down');
  assert.equal((await checkDisk(['/state'], space(4 * GB, 20 * GB))).status, 'down');
  const two = await checkDisk(['/state', '/worktrees'], async (path) => (path === '/state' ? { device: 1, free: 100 * GB, total: 200 * GB } : { device: 2, free: 1 * GB, total: 200 * GB }));
  assert.deepEqual(two, { status: 'down', detail: 'low on space: /worktrees: 1.0 GB free (1 %)' });
});

test('sandboxes: the first scan is never down; a pid the previous scan found too is down with the count', async () => {
  const proc = await tempDir('proc');
  const root = '/home/u/.local/state/software-factory';
  const uid = 1000;
  // An orphaned bwrap (its parent pid 1) naming a worktree under the root.
  await mkdir(join(proc, '4242'));
  await writeFile(join(proc, '4242', 'status'), `Name:\tbwrap\nState:\tS (sleeping)\nPid:\t4242\nPPid:\t1\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  await writeFile(join(proc, '4242', 'stat'), `4242 (bwrap) S 1 ${'0 '.repeat(17)}5242 0 0\n`);
  await writeFile(join(proc, '4242', 'cmdline'), ['bwrap', '--bind', `${root}/worktrees/app/A-1`, '--', 'bash'].join('\0'));
  const watch = new OrphanWatch(() => [root], { proc, uid });
  const first = await checkSandboxes(() => watch.scan());
  assert.deepEqual(first, { status: 'ok', detail: '1 orphaned sandbox process found, not yet seen twice' });
  assert.deepEqual(await checkSandboxes(() => watch.scan()), { status: 'down', detail: '1 orphaned sandbox process outlived the reaper' });
  assert.deepEqual(await checkSandboxes(async () => ({ found: 0, persisting: [] })), { status: 'ok', detail: 'no orphaned sandbox' });
});

function registry(follow: boolean, at = '08:00'): Registry {
  return { workspaces: { app: { read_checkout: '/srv/app', ...(follow ? { digest: { track: true } } : {}) } }, digest: { at, weekdays_only: false } };
}

test('digest: off when none is scheduled; down when missed (due, none started today, more than 30 minutes past at) or when the last scheduled one failed', async () => {
  // Local times: a Monday 10:00.
  const now = new Date(2026, 10, 9, 10, 0);
  const summary = (startedAt: Date, error: string | null = null) => ({ id: 'x', trigger: 'scheduled' as const, started_at: startedAt.toISOString(), error });
  const store = (list: Array<ReturnType<typeof summary>>) => ({ list: async () => list as never });
  assert.equal((await checkDigest(registry(false), store([]), now)).status, 'off');
  const missed = await checkDigest(registry(true), store([summary(new Date(2026, 10, 8, 8, 0))]), now);
  assert.deepEqual(missed, { status: 'down', detail: "today's digest was due at 08:00 and did not start" });
  // At 10:00 the 09:30 digest is 30 minutes late, not more.
  assert.equal((await checkDigest(registry(true, '09:30'), store([]), now)).status, 'ok');
  assert.equal((await checkDigest(registry(true), store([summary(new Date(2026, 10, 9, 8, 0))]), now)).status, 'ok');
  const failed = await checkDigest(registry(true), store([summary(new Date(2026, 10, 9, 8, 0), 'the model call timed out')]), now);
  assert.deepEqual(failed, { status: 'down', detail: 'the last scheduled digest failed: the model call timed out' });
});

test('guarded: a check that throws is down with its error; one that hangs is down after its timeout', async () => {
  assert.deepEqual(await guarded(async () => {
    throw new Error('boom');
  }), { status: 'down', detail: 'the check failed: boom' });
  const started = Date.now();
  const hung = await guarded(() => new Promise(() => undefined), 50);
  assert.deepEqual(hung, { status: 'down', detail: 'the check did not finish within 0.05 s' });
  assert.ok(Date.now() - started < 2000);
});

const check = (status: HealthStatus): HealthCheck => ({ id: 'mcp', label: 'MCP endpoint', status, detail: '', since: iso(NOW) });

test('sf health\'s exit code: 0 all ok or off (off is never red), 3 any recovering and none down, 1 any down', () => {
  assert.equal(healthExitCode([check('ok'), check('off')]), 0);
  assert.equal(healthExitCode([check('off')]), 0);
  assert.equal(healthExitCode([check('ok'), check('recovering')]), 3);
  assert.equal(healthExitCode([check('recovering'), check('down')]), 1);
  assert.deepEqual(healthLines([{ ...check('down'), detail: 'refused' }]), ['DOWN       MCP endpoint  refused']);
});

// Every check's dependency, each answering ok (or off), with the parts a test changes.
function deps(now: () => Date, overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    now,
    mcp: async () => ({ port: 8787, token: 't' }),
    probe: async () => ({ result: 'answers' }),
    tunnelProfile: '/nonexistent/software-factory.yaml',
    tunnelAddress: '127.0.0.1:1',
    fetch: fetchText,
    packageRoot: '/nonexistent',
    tunnelScript: '/nonexistent/sf-tunnel.sh',
    jobs: { jobs: { list: async () => [], eventsPath: () => '/nonexistent' }, testTimeoutMs: 30 * MIN, runnerAlive: async () => true },
    queue: async () => ({ view: { held: false, limit_hold: null, running: 0, entries: [] }, lastStart: undefined, newestJob: undefined }),
    remote: () => ({ origins: [], port: 8789 }),
    answers: async () => true,
    run: async () => ({ code: 0, stdout: '' }),
    logins: { claudePath: '/bin/claude', codexPath: undefined, forgeTargets: async () => [], checkToken: async () => ({ ok: true }) },
    diskPaths: ['/state'],
    freeSpace: async () => ({ device: 1, free: 100 * 1024 ** 3, total: 200 * 1024 ** 3 }),
    sandboxes: async () => ({ found: 0, persisting: [] }),
    configDir: '/nonexistent-config',
    digests: { list: async () => [] },
    ...overrides,
  };
}

test('runChecks: one result per check in the fixed order, since the run\'s time; a check whose dependency throws is down, the others run', async () => {
  const at = new Date(NOW);
  const results = await runChecks(deps(() => at, { queue: async () => {
    throw new Error('queue.json is invalid');
  } }));
  assert.deepEqual(results.map((result) => result.id), HEALTH_CHECKS.map((one) => one.id));
  assert.ok(results.every((result) => result.since === at.toISOString()));
  const byId = Object.fromEntries(results.map((result) => [result.id, result.status]));
  assert.deepEqual(byId, { mcp: 'ok', tunnel: 'off', 'tunnel-cli': 'off', jobs: 'ok', queue: 'down', remote: 'off', logins: 'ok', disk: 'ok', sandboxes: 'ok', digest: 'off' });
});

test('HealthMonitor: since moves on a status change only; the change callback on a status change; one notification when a check turns down, none while it stays, one when it is ok again; logins hourly', async () => {
  let clock = NOW;
  let probe: 'answers' | 'refused' = 'answers';
  let loginRuns = 0;
  const changes: HealthCheck[][] = [];
  const sent: Notification[] = [];
  const monitor = new HealthMonitor(deps(() => new Date(clock), {
    probe: async () => ({ result: probe }),
    run: async () => {
      loginRuns += 1;
      return { code: 0, stdout: '' };
    },
  }), { onChange: (list) => changes.push(list), notify: async (notification) => sent.push(notification) });
  assert.deepEqual(monitor.list(), []);
  await monitor.check();
  assert.equal(changes.length, 1);
  const mcp = (): HealthCheck => monitor.list().find((one) => one.id === 'mcp')!;
  assert.deepEqual([mcp().status, mcp().since], ['ok', iso(NOW)]);
  clock += 30_000;
  await monitor.check();
  assert.equal(changes.length, 1, 'no status changed');
  assert.equal(mcp().since, iso(NOW));
  probe = 'refused';
  clock += 30_000;
  await monitor.check();
  assert.equal(changes.length, 2);
  assert.deepEqual([mcp().status, mcp().since], ['down', iso(NOW + 60_000)]);
  clock += 30_000;
  await monitor.check();
  assert.deepEqual(sent.map((one) => one.title), ['Factory health: MCP endpoint is down']);
  probe = 'answers';
  clock += 30_000;
  await monitor.check();
  assert.deepEqual(sent.map((one) => one.title), ['Factory health: MCP endpoint is down', 'Factory health: MCP endpoint is ok again']);
  assert.equal(sent[0]!.priority, 'high');
  assert.equal(loginRuns, 1, 'logins ran once in the first hour');
  clock = NOW + 61 * MIN;
  await monitor.check();
  assert.equal(loginRuns, 2);
});

test('sf health computes the checks without sf serve: one row per check, --json the list; exit 1 when one is down', { timeout: 60_000 }, async () => {
  const env = await newEnv('health-cli');
  const json = await runCli(env, ['health', '--json']);
  assert.equal(json.code, 1, json.stderr);
  const list = JSON.parse(json.stdout) as HealthCheck[];
  assert.deepEqual(list.map((one) => one.id), HEALTH_CHECKS.map((one) => one.id));
  // No sf serve and no token: the MCP endpoint is down; nothing is configured for the tunnel or the digest.
  const status = Object.fromEntries(list.map((one) => [one.id, one.status]));
  assert.equal(status.mcp, 'down');
  assert.equal(status['tunnel-cli'], 'off');
  assert.equal(status.digest, 'off');
  assert.equal(status.queue, 'ok');
  assert.ok(list.every((one) => one.since === list[0]!.since));
  const rows = await runCli(env, ['health']);
  assert.equal(rows.code, 1);
  assert.equal(rows.stdout.trim().split('\n').length, HEALTH_CHECKS.length);
  assert.match(rows.stdout, /^DOWN {7}MCP endpoint/m);
  const usage = await runCli(env, ['health', 'extra']);
  assert.equal(usage.code, 2);
});
