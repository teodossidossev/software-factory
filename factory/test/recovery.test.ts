// sf serve's recovery (SF-154), with a fake tunnel script (SF_TUNNEL_SCRIPT) that is its own fake
// health endpoint: the tunnel child starts with a profile and not without one or with SF_TUNNEL=off;
// nothing starts when the health address already answers; killing the child's group makes the
// check recovering, then ok with a new child; three failed recoveries in an hour stop the retries
// and say so, with one notification at the cap and none while recovering; a live group in
// tunnel.pid is ended before a new start (a pid reused by another program, or with another start
// time, is not), and one that
// does not end blocks the start, the restart and the removal of tunnel.pid, as does one that cannot
// be checked; with
// SF_HEALTH=off the reaper timer runs and nothing is recovered; no token reaches the log.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { HealthCheck } from '../src/health.js';
import type { Notification } from '../src/notify.js';
import { Recovery, RECOVERY_WINDOW_MS, upkeep } from '../src/recovery.js';
import { MCP_TOKEN_FILE } from '../src/server.js';
import { TUNNEL_PID_FILE, TUNNEL_START_GRACE_MS, TunnelChild } from '../src/tunnel.js';
import { answers, fakeTunnel, type FakeTunnel, processAlive, until } from './support/fake-tunnel.js';
import { stopChild, trackChild } from './support/children.js';
import { CLI, type Env, newEnv, processEnv, runCli } from './support/harness.js';
import { deps, fakeServer } from './support/health.js';

const TOKEN = 'a'.repeat(64);
const PASS_MS = 30_000;

// A tunnel.pid line as sf serve writes it: the leader's pid and its start time (field 22 of its stat).
async function recorded(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return `${pid} ${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}\n`;
}

// The pid tunnel.pid names.
const pidIn = async (file: string): Promise<number> => Number((await readFile(file, 'utf8')).trim().split(/\s+/)[0]);

// Every pid a fake tunnel started: none outlives the file.
const tunnels: FakeTunnel[] = [];
after(async () => {
  for (const tunnel of tunnels) {
    for (const pid of await tunnel.starts().catch(() => [])) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Gone.
      }
    }
    await rm(tunnel.dir, { recursive: true, force: true });
  }
});

interface Rig {
  tunnel: FakeTunnel;
  child: TunnelChild;
  state: string;
  profile: string;
  lines: string[];
  sent: Notification[];
  clock: { now: number };
  upkept: ReturnType<typeof upkeep>;
  // One health pass, the clock 30 s on; the tunnel check's result.
  pass(): Promise<HealthCheck>;
}

// A TunnelChild on a fake tunnel with sf serve's upkeep (SF_HEALTH on unless health is false), its
// health checks on a test clock; every log line kept. address: where the start and the check ask
// (default the fake's own endpoint; another one stands for a tunnel that runs but never answers).
async function rig(name: string, health = true, address?: string): Promise<Rig> {
  const state = await mkdtemp(join(tmpdir(), `sf-recovery-${name}-`));
  await writeFile(join(state, MCP_TOKEN_FILE), `${TOKEN}\n`, { mode: 0o600 });
  const profileDir = await mkdtemp(join(tmpdir(), `sf-recovery-profile-${name}-`));
  const profile = join(profileDir, 'software-factory.yaml');
  await writeFile(profile, 'config_version: 1\n');
  const tunnel = await fakeTunnel(join(state, MCP_TOKEN_FILE));
  tunnels.push(tunnel);
  const lines: string[] = [];
  const sent: Notification[] = [];
  const clock = { now: Date.now() };
  const log = (line: string): void => void lines.push(line);
  const asked = address ?? tunnel.address;
  const child = new TunnelChild({ script: tunnel.script, stateDir: state, address: asked, token: async () => TOKEN, log, graceMs: 1000, now: () => clock.now });
  const upkept = upkeep({
    health, tunnel: child, roots: () => [], watch: { scan: async () => ({ found: 0, persisting: [] }) }, reap: async () => undefined, reapEveryMs: 20, log, now: () => clock.now,
    deps: deps(() => new Date(clock.now), { tunnelProfile: profile, tunnelAddress: asked }),
    monitor: { notify: async (notification) => sent.push(notification) },
  });
  const pass = async (): Promise<HealthCheck> => {
    clock.now += PASS_MS;
    await upkept.monitor!.check();
    return upkept.monitor!.list().find((check) => check.id === 'tunnel')!;
  };
  return { tunnel, child, state, profile, lines, sent, clock, upkept, pass };
}

// Kills the child's whole group, as a crash would, and waits until its endpoint is gone.
async function crash(r: Rig): Promise<void> {
  const group = r.child.group;
  assert.ok(group !== undefined, 'no tunnel child runs');
  process.kill(-group, 'SIGKILL');
  await until(async () => !(await answers(r.tunnel.address)) && r.child.group === undefined, 'the endpoint and the child to go');
}

test('killing the child\'s group makes the check recovering, then ok with a new child; no notification; one log line', async () => {
  const r = await rig('restart');
  try {
    assert.equal(await r.child.start(), 'started');
    await until(() => answers(r.tunnel.address), 'the first child');
    const [first] = await r.tunnel.starts();
    assert.equal(await pidIn(join(r.state, TUNNEL_PID_FILE)), first);
    assert.equal((await r.pass()).status, 'ok');
    // Past the start's grace, a crash is recovered.
    r.clock.now += TUNNEL_START_GRACE_MS;
    await crash(r);
    const recovering = await r.pass();
    assert.equal(recovering.status, 'recovering');
    assert.match(recovering.detail, /; recovering: restart the tunnel \(attempt 1 of 3 this hour\); the tunnel restarted: in ChatGPT, refresh the plugin and start a new chat if it still fails$/);
    await until(async () => (await r.tunnel.starts()).length === 2 && (await answers(r.tunnel.address)), 'the new child');
    const ok = await r.pass();
    assert.equal(ok.status, 'ok');
    assert.match(ok.detail, /^ready; .*; the tunnel restarted: in ChatGPT, refresh the plugin/);
    const [, second] = await r.tunnel.starts();
    assert.notEqual(second, first);
    assert.equal(r.child.group, second);
    assert.equal(await pidIn(join(r.state, TUNNEL_PID_FILE)), second);
    assert.equal(r.sent.length, 0);
    assert.deepEqual(r.lines.filter((line) => line.startsWith('health recovery:')), ['health recovery: tunnel: restart the tunnel: succeeded']);
    // The relay shows the token as <token>; no line holds it.
    assert.ok(r.lines.includes('tunnel | sf-tunnel: ok: fake tunnel up, url http://127.0.0.1:1/mcp/<token>'), r.lines.join('\n'));
    assert.ok(r.lines.includes('tunnel | fake warning <token>'));
    assert.ok(r.lines.every((line) => !line.includes(TOKEN)));
  } finally {
    r.upkept.close();
    await r.child.stop();
  }
  // The stop ended the group and removed tunnel.pid.
  assert.equal(await answers(r.tunnel.address), false);
  await assert.rejects(readFile(join(r.state, TUNNEL_PID_FILE), 'utf8'));
});

test('within the start\'s first 90 s every down result is a counted attempt: a dead child is restarted at once, a live one is left to come up', async () => {
  const r = await rig('early');
  try {
    assert.equal(await r.child.start(), 'started');
    await until(() => answers(r.tunnel.address), 'the first child');
    // The child dies right after the start, well within the grace.
    await crash(r);
    const recovering = await r.pass();
    assert.equal(recovering.status, 'recovering');
    assert.match(recovering.detail, /recovering: restart the tunnel \(attempt 1 of 3 this hour\)/);
    await until(async () => (await r.tunnel.starts()).length === 2 && (await answers(r.tunnel.address)), 'the restarted child');
    assert.equal((await r.pass()).status, 'ok');
    assert.deepEqual(r.lines.filter((line) => line.startsWith('health recovery:')), ['health recovery: tunnel: restart the tunnel: succeeded']);
  } finally {
    r.upkept.close();
    await r.child.stop();
  }

  // A child that runs but does not answer yet: the attempt counts and leaves it; once the grace is
  // over, the next attempt restarts it.
  const quiet = await fakeServer(() => ({ status: 404, text: '' }));
  await quiet.close();
  const slow = await rig('early-slow', true, `127.0.0.1:${quiet.port}`);
  try {
    assert.equal(await slow.child.start(), 'started');
    await until(() => answers(slow.tunnel.address), 'the child');
    const first = await slow.pass();
    assert.equal(first.status, 'recovering');
    assert.match(first.detail, /attempt 1 of 3 this hour/);
    await until(() => slow.lines.some((line) => /^tunnel: not restarted: it started \d+ s ago and still runs; left to come up$/.test(line)), 'the left-to-come-up line');
    assert.equal((await slow.tunnel.starts()).length, 1, 'not killed while it comes up');
    // The attempt fails after 3 more passes without ok; the next one is past the grace.
    assert.equal((await slow.pass()).status, 'recovering');
    assert.equal((await slow.pass()).status, 'recovering');
    const second = await slow.pass();
    assert.match(second.detail, /attempt 2 of 3 this hour/);
    await until(async () => (await slow.tunnel.starts()).length === 2, 'the restart after the grace');
    assert.equal(slow.sent.length, 0);
  } finally {
    slow.upkept.close();
    await slow.child.stop();
  }
});

test('three failed recoveries in an hour stop the retries and say so: one notification at the cap, none while recovering; the next hour tries again', async () => {
  const r = await rig('cap');
  try {
    assert.equal(await r.child.start(), 'started');
    await until(() => answers(r.tunnel.address), 'the first child');
    r.clock.now += TUNNEL_START_GRACE_MS;
    assert.equal((await r.pass()).status, 'ok');
    await writeFile(r.tunnel.failMarker, '');
    await crash(r);
    const statuses: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const started = await r.pass();
      statuses.push(started.status);
      assert.match(started.detail, new RegExp(`attempt ${attempt} of 3 this hour`));
      await until(async () => (await r.tunnel.starts()).length === 1 + attempt, `start ${attempt}`);
      statuses.push((await r.pass()).status, (await r.pass()).status);
    }
    assert.deepEqual(statuses, Array(9).fill('recovering'));
    assert.equal(r.sent.length, 0, 'nothing while recovering');
    const capped = await r.pass();
    assert.equal(capped.status, 'down');
    assert.match(capped.detail, /^recovery failed 3 times: the tunnel client does not answer at /);
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0]!.title, 'Factory health: ChatGPT tunnel is down');
    assert.match(r.sent[0]!.body, /^recovery failed 3 times: /);
    // No more tries within the hour, nor notifications.
    for (let more = 0; more < 4; more += 1) {
      assert.equal((await r.pass()).status, 'down');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await r.tunnel.starts()).length, 4, 'one start and three attempts');
    assert.equal(r.sent.length, 1);
    assert.equal(r.lines.filter((line) => /^health recovery: tunnel: restart the tunnel: failed: /.test(line)).length, 3);
    // The hour frees the attempts: the next one succeeds, and the ok again is notified.
    await rm(r.tunnel.failMarker);
    r.clock.now += RECOVERY_WINDOW_MS;
    assert.equal((await r.pass()).status, 'recovering');
    await until(async () => (await r.tunnel.starts()).length === 5 && (await answers(r.tunnel.address)), 'the fifth start');
    assert.equal((await r.pass()).status, 'ok');
    assert.deepEqual(r.sent.map((one) => one.title), ['Factory health: ChatGPT tunnel is down', 'Factory health: ChatGPT tunnel is ok again']);
  } finally {
    r.upkept.close();
    await r.child.stop();
  }
});

test('Recovery: at most 3 attempts per check in a rolling hour, whatever their outcome; a check without an action passes through', () => {
  let now = 0;
  let runs = 0;
  const recovery = new Recovery({
    now: () => now, log: () => undefined,
    actions: { tunnel: { action: 'restart', applies: () => true, run: async () => void (runs += 1) } },
  });
  const result = (status: HealthCheck['status']): HealthCheck => ({ id: 'tunnel', label: 'ChatGPT tunnel', status, detail: 'd', since: '' });
  const review = (status: HealthCheck['status']): HealthCheck => recovery.review([result(status)])[0]!;
  // Attempts that succeed count too.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(review('down').status, 'recovering');
    assert.equal(review('ok').status, 'ok');
    now += 60_000;
  }
  assert.equal(runs, 3);
  assert.deepEqual(review('down'), { ...result('down'), detail: 'recovery failed 3 times: d' });
  assert.equal(runs, 3);
  // The first attempt leaves the window.
  now = RECOVERY_WINDOW_MS;
  assert.equal(review('down').status, 'recovering');
  assert.equal(runs, 4);
  assert.deepEqual(recovery.review([{ ...result('down'), id: 'mcp' }]), [{ ...result('down'), id: 'mcp' }]);
});

test('nothing starts when the health address already answers; that tunnel is never ended or recovered', async () => {
  const outside = await fakeServer((path) => (path === '/readyz' ? { status: 503, text: 'not ready' } : { status: 404, text: '' }));
  const r = await rig('outside');
  const child = new TunnelChild({ script: r.tunnel.script, stateDir: r.state, address: `127.0.0.1:${outside.port}`, token: async () => TOKEN, log: (line) => void r.lines.push(line) });
  try {
    assert.equal(await child.start(), 'outside');
    assert.ok(r.lines.includes(`tunnel: not started: a tunnel already runs outside sf serve (http://127.0.0.1:${outside.port}/readyz answers)`));
    assert.equal(child.owned, false);
    await child.restart();
    await child.stop();
    assert.deepEqual(await r.tunnel.starts(), []);
    assert.equal(await answers(`127.0.0.1:${outside.port}`), true);
    // Its check is down, not recovering: sf serve does not take it over.
    const upkept = upkeep({
      health: true, tunnel: child, roots: () => [], watch: { scan: async () => ({ found: 0, persisting: [] }) }, reap: async () => undefined, log: () => undefined,
      deps: deps(() => new Date(), { tunnelProfile: r.profile, tunnelAddress: `127.0.0.1:${outside.port}` }),
    });
    await upkept.monitor!.check();
    assert.equal(upkept.monitor!.list().find((check) => check.id === 'tunnel')!.status, 'down');
    assert.deepEqual(await r.tunnel.starts(), []);
  } finally {
    await outside.close();
  }
});

test('a live group in tunnel.pid that runs the tunnel script is ended before a new start; one that does not is left alone', async () => {
  const r = await rig('leftover');
  // A crashed sf serve's tunnel: its own group, still serving the endpoint.
  const left = spawn(r.tunnel.script, ['run'], { detached: true, stdio: 'ignore' });
  left.unref();
  await until(() => answers(r.tunnel.address), 'the leftover');
  await writeFile(join(r.state, TUNNEL_PID_FILE), await recorded(left.pid!));
  try {
    assert.equal(await r.child.start(), 'started');
    assert.ok(r.lines.includes(`tunnel: ending the tunnel a previous sf serve left (process group ${left.pid})`));
    assert.ok((await r.tunnel.terms()).includes(left.pid!));
    assert.equal(await processAlive(left.pid!), false);
    await until(() => answers(r.tunnel.address), 'the new child');
    const starts = await r.tunnel.starts();
    assert.equal(starts.length, 2);
    assert.equal(await pidIn(join(r.state, TUNNEL_PID_FILE)), starts[1]);
  } finally {
    await r.child.stop();
  }
  // Another program under the pid: not touched.
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  other.unref();
  await writeFile(join(r.state, TUNNEL_PID_FILE), await recorded(other.pid!));
  const next = new TunnelChild({ script: r.tunnel.script, stateDir: r.state, address: r.tunnel.address, token: async () => TOKEN, log: (line) => void r.lines.push(line) });
  try {
    assert.equal(await next.start(), 'started');
    assert.equal(await processAlive(other.pid!), true);
  } finally {
    await next.stop();
    process.kill(-other.pid!, 'SIGKILL');
  }
});

test('a reused pid in tunnel.pid (same pid, another start time) is not ended; tunnel.pid is left alone and no tunnel starts while /readyz answers', async () => {
  const r = await rig('reused');
  const pidFile = join(r.state, TUNNEL_PID_FILE);
  // A live tunnel under the recorded pid, but not the process recorded: its start time differs.
  const left = spawn(r.tunnel.script, ['run'], { detached: true, stdio: 'ignore' });
  left.unref();
  await until(() => answers(r.tunnel.address), 'the tunnel under the pid');
  const [pid, start] = (await recorded(left.pid!)).trim().split(' ');
  const line = `${pid} ${Number(start) + 1}\n`;
  await writeFile(pidFile, line);
  try {
    assert.equal(await r.child.start(), 'outside');
    assert.ok(r.lines.includes(`tunnel: tunnel.pid names process group ${left.pid}, which is not the tunnel it recorded; left alone`), r.lines.join('\n'));
    assert.ok(!r.lines.some((one) => one.startsWith('tunnel: ending')), 'nothing ended');
    assert.deepEqual(await r.tunnel.terms(), []);
    assert.equal(await processAlive(left.pid!), true);
    assert.equal(await readFile(pidFile, 'utf8'), line, 'tunnel.pid left alone');
    assert.deepEqual(await r.tunnel.starts(), [left.pid], 'no second tunnel');
  } finally {
    await r.child.stop();
    process.kill(-left.pid!, 'SIGKILL');
  }
});

test('a tunnel group that does not end blocks the start, the restart and the removal of tunnel.pid: never two tunnels', async () => {
  const r = await rig('unended');
  const pidFile = join(r.state, TUNNEL_PID_FILE);
  // Signals that never arrive: the group outlives SIGTERM and SIGKILL.
  let deaf = true;
  const kill = (pid: number, signal: NodeJS.Signals): void => {
    if (!deaf) {
      process.kill(pid, signal);
    }
  };
  // A leftover whose endpoint does not answer where the new tunnel would listen.
  const left = spawn(r.tunnel.script, ['run'], { detached: true, stdio: 'ignore' });
  left.unref();
  await until(() => answers(r.tunnel.address), 'the leftover');
  await writeFile(pidFile, await recorded(left.pid!));
  const lines: string[] = [];
  const quiet = await fakeServer(() => ({ status: 404, text: '' }));
  await quiet.close();
  const elsewhere = `127.0.0.1:${quiet.port}`;
  const blocked = new TunnelChild({ script: r.tunnel.script, stateDir: r.state, address: elsewhere, token: async () => TOKEN, log: (line) => void lines.push(line), graceMs: 100, kill });
  try {
    assert.equal(await blocked.start(), 'failed');
    assert.ok(lines.includes(`tunnel: not started: the tunnel a previous sf serve left (process group ${left.pid}) did not end; end it, then restart sf serve`), lines.join('\n'));
    assert.deepEqual(await r.tunnel.starts(), [left.pid], 'nothing started beside it');
    assert.equal(blocked.owned, false);
    assert.equal(await pidIn(pidFile), left.pid, 'tunnel.pid keeps it');
  } finally {
    process.kill(-left.pid!, 'SIGKILL');
  }
  await until(async () => !(await processAlive(left.pid!)), 'the leftover to end');

  // sf serve's own child that does not end: the restart fails without a new start, the stop keeps
  // tunnel.pid; once it can end, the next stop ends it and removes tunnel.pid.
  deaf = false;
  // Its clock past the start's grace: a restart ends the child.
  const clock = { now: Date.now() };
  const own = new TunnelChild({ script: r.tunnel.script, stateDir: r.state, address: r.tunnel.address, token: async () => TOKEN, log: (line) => void lines.push(line), graceMs: 100, kill, now: () => clock.now });
  assert.equal(await own.start(), 'started');
  await until(() => answers(r.tunnel.address), 'the child');
  const [, child] = await r.tunnel.starts();
  clock.now += TUNNEL_START_GRACE_MS;
  deaf = true;
  await assert.rejects(own.restart(), /the tunnel's process group did not end/);
  assert.equal((await r.tunnel.starts()).length, 2, 'no second tunnel');
  await own.stop();
  assert.ok(lines.includes(`tunnel: process group ${child} did not end; tunnel.pid keeps it for the next start`), lines.join('\n'));
  assert.equal(await pidIn(pidFile), child);
  assert.equal(await answers(r.tunnel.address), true);
  deaf = false;
  await own.stop();
  assert.equal(await answers(r.tunnel.address), false);
  await assert.rejects(readFile(pidFile, 'utf8'));
  assert.ok(lines.every((line) => !line.startsWith('tunnel | exited')), 'the asked-for exit is no failure');
});

test('a tunnel.pid group that cannot be checked (no readable /proc, a process file that fails to read) keeps tunnel.pid and starts no tunnel', async () => {
  const r = await rig('uncheckable');
  const pidFile = join(r.state, TUNNEL_PID_FILE);
  await writeFile(pidFile, '5004242\n');
  // A fake /proc whose one process's stat cannot be read.
  const proc = await mkdtemp(join(tmpdir(), 'sf-recovery-proc-'));
  await mkdir(join(proc, '5004242'));
  await writeFile(join(proc, '5004242', 'stat'), '5004242 (bash) S 1 5004242\n', { mode: 0o000 });
  const unreadable = process.getuid?.() !== 0;
  for (const where of [join(proc, 'missing'), ...(unreadable ? [proc] : [])]) {
    const lines: string[] = [];
    const child = new TunnelChild({ script: r.tunnel.script, stateDir: r.state, address: r.tunnel.address, token: async () => TOKEN, log: (line) => void lines.push(line), proc: where });
    assert.equal(await child.start(), 'failed', where);
    assert.deepEqual(lines, ['tunnel.pid names a group that cannot be checked; no tunnel started'], where);
    assert.equal(child.owned, false);
    assert.equal(await readFile(pidFile, 'utf8'), '5004242\n', 'tunnel.pid kept');
  }
  assert.deepEqual(await r.tunnel.starts(), [], 'no tunnel started');

  // A live leftover tunnel, /proc unreadable, and nothing answering where the new tunnel would ask:
  // the leftover is neither ended nor joined by a second tunnel.
  const left = spawn(r.tunnel.script, ['run'], { detached: true, stdio: 'ignore' });
  left.unref();
  await until(() => answers(r.tunnel.address), 'the leftover');
  await writeFile(pidFile, `${left.pid}\n`);
  const quiet = await fakeServer(() => ({ status: 404, text: '' }));
  await quiet.close();
  const lines: string[] = [];
  const blind = new TunnelChild({ script: r.tunnel.script, stateDir: r.state, address: `127.0.0.1:${quiet.port}`, token: async () => TOKEN, log: (line) => void lines.push(line), proc: join(proc, 'missing') });
  try {
    assert.equal(await blind.start(), 'failed');
    assert.deepEqual(lines, ['tunnel.pid names a group that cannot be checked; no tunnel started']);
    assert.deepEqual(await r.tunnel.starts(), [left.pid], 'no second tunnel');
    assert.equal(await processAlive(left.pid!), true, 'the leftover is not ended unchecked');
    assert.equal(await readFile(pidFile, 'utf8'), `${left.pid}\n`, 'tunnel.pid kept');
  } finally {
    process.kill(-left.pid!, 'SIGKILL');
    await rm(proc, { recursive: true, force: true });
  }
});

test('a refused start, then stop, then a new start: tunnel.pid stays untouched and no second tunnel starts', async () => {
  const r = await rig('refused-stop');
  const pidFile = join(r.state, TUNNEL_PID_FILE);
  // A live leftover tunnel that the start cannot check (no readable /proc), and nothing answering
  // where the new tunnel would ask.
  const left = spawn(r.tunnel.script, ['run'], { detached: true, stdio: 'ignore' });
  left.unref();
  await until(() => answers(r.tunnel.address), 'the leftover');
  await writeFile(pidFile, `${left.pid}\n`);
  const quiet = await fakeServer(() => ({ status: 404, text: '' }));
  await quiet.close();
  const missing = join(r.state, 'no-proc');
  const lines: string[] = [];
  const serveOnce = (): TunnelChild => new TunnelChild({
    script: r.tunnel.script, stateDir: r.state, address: `127.0.0.1:${quiet.port}`, token: async () => TOKEN, log: (line) => void lines.push(line), proc: missing,
  });
  try {
    const first = serveOnce();
    assert.equal(await first.start(), 'failed');
    await first.stop();
    assert.equal(await readFile(pidFile, 'utf8'), `${left.pid}\n`, 'the stop left tunnel.pid untouched');
    const second = serveOnce();
    assert.equal(await second.start(), 'failed');
    await second.stop();
    assert.deepEqual(lines, Array(2).fill('tunnel.pid names a group that cannot be checked; no tunnel started'));
    assert.equal(await readFile(pidFile, 'utf8'), `${left.pid}\n`);
    assert.deepEqual(await r.tunnel.starts(), [left.pid], 'no second tunnel');
    assert.equal(await processAlive(left.pid!), true);
  } finally {
    process.kill(-left.pid!, 'SIGKILL');
  }
});

test('with SF_HEALTH=off the reaper timer runs and nothing is recovered', async () => {
  let reaps = 0;
  const r = await rig('health-off', false);
  const upkept = upkeep({
    health: false, tunnel: r.child, roots: () => [], watch: { scan: async () => ({ found: 0, persisting: [] }) }, reap: async () => void (reaps += 1), reapEveryMs: 20,
    deps: deps(() => new Date()),
  });
  try {
    assert.equal(upkept.monitor, undefined);
    upkept.start();
    assert.equal(await r.child.start(), 'started');
    await until(() => answers(r.tunnel.address), 'the child');
    await crash(r);
    await until(() => reaps >= 3, 'three reaps');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await r.tunnel.starts()).length, 1, 'not restarted');
  } finally {
    upkept.close();
    await r.child.stop();
  }
});

interface Serving {
  tunnel: FakeTunnel;
  env: Env;
  // Everything sf serve printed so far, both streams.
  text(): string;
  stop(): Promise<number | null>;
}

// sf serve with a fake tunnel, every byte of its output kept; the env's own HOME holds the profile
// when withProfile.
async function serveWithTunnel(name: string, tunnelSetting: string, withProfile: boolean): Promise<Serving> {
  const base = await newEnv(name);
  const tunnel = await fakeTunnel(join(base.state, MCP_TOKEN_FILE));
  tunnels.push(tunnel);
  const env = { ...base, extra: { SF_TUNNEL: tunnelSetting, SF_TUNNEL_SCRIPT: tunnel.script, SF_TUNNEL_HEALTH: tunnel.address } };
  if (withProfile) {
    await mkdir(join(env.home, '.config', 'tunnel-client'), { recursive: true });
    await writeFile(join(env.home, '.config', 'tunnel-client', 'software-factory.yaml'), 'config_version: 1\n');
  }
  const child = spawn(process.execPath, [CLI, 'serve'], { env: processEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  trackChild(child, ['serve']);
  let text = '';
  child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  try {
    await until(() => /listening on http/.test(text) || child.exitCode !== null, 'the listening line');
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return {
    tunnel, env, text: () => text,
    stop: async () => {
      child.kill('SIGTERM');
      return exited;
    },
  };
}

test('sf serve starts the tunnel child with a profile, its lines with <token> and never the token; a stop ends its group', async () => {
  const { tunnel, env, text: err, stop } = await serveWithTunnel('recovery-serve', 'auto', true);
  const token = (await readFile(join(env.state, MCP_TOKEN_FILE), 'utf8')).trim();
  try {
    await until(() => err().includes('tunnel | sf-tunnel: ok') && err().includes('tunnel | fake warning'), 'the tunnel lines');
    assert.match(err(), /^tunnel \| sf-tunnel: ok: fake tunnel up, url http:\/\/127\.0\.0\.1:1\/mcp\/<token>$/m);
    assert.match(err(), /^tunnel \| fake warning <token>$/m);
    const starts = await tunnel.starts();
    assert.equal(starts.length, 1);
    assert.equal(await pidIn(join(env.state, TUNNEL_PID_FILE)), starts[0]);
  } finally {
    assert.equal(await stop(), 0);
  }
  assert.ok(!err().includes(token), 'the token reached the log');
  assert.deepEqual(await tunnel.terms(), await tunnel.starts());
  assert.equal(await answers(tunnel.address), false);
  await assert.rejects(readFile(join(env.state, TUNNEL_PID_FILE), 'utf8'));
});

test('sf serve starts no tunnel without a profile or with SF_TUNNEL=off; an invalid SF_TUNNEL refuses the start', async () => {
  for (const [name, setting, withProfile, line] of [
    ['recovery-no-profile', 'auto', false, /^tunnel: not started \(no tunnel profile: .*software-factory\.yaml\)$/m],
    ['recovery-off', 'off', true, /^tunnel: not started \(SF_TUNNEL=off\)$/m],
  ] as const) {
    const { tunnel, text, stop } = await serveWithTunnel(name, setting, withProfile);
    try {
      await until(() => line.test(text()), `the not-started line of ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(await tunnel.starts(), [], name);
    } finally {
      assert.equal(await stop(), 0);
    }
  }
  const invalid = await runCli(await newEnv('recovery-invalid', { SF_TUNNEL: 'on' }), ['serve']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /SF_TUNNEL must be auto or off, got "on"/);
});
