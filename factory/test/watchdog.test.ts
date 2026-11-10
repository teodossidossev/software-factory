// sf health --notify, the watchdog outside sf serve, with a fake MCP endpoint row, a fake
// systemctl and a fake notifier: one notification when sf serve stops answering (or its unit is
// failed), one when it answers again, none while nothing changes; --force (the alert unit, systemd
// gave up) sends the down one even without a change; a missing or corrupt watchdog.json counts as
// up; a failed send is printed and exits 1, the state is kept.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HealthCheck } from '../src/health.js';
import type { ChannelResult, Notification } from '../src/notify.js';
import type { CommandOutput } from '../src/service.js';
import { WATCHDOG_FILE, type WatchdogOptions, watchdog } from '../src/watchdog.js';
import { temp } from './support/harness.js';

const SHOW_ACTIVE_STATE = 'systemctl --user show software-factory --property=ActiveState --value';
const T0 = '2026-11-10T08:00:00.000Z';
const T1 = '2026-11-10T08:05:00.000Z';

const row = (status: 'ok' | 'down'): HealthCheck => ({ id: 'mcp', label: 'MCP endpoint', status, detail: status === 'ok' ? 'answers at http://127.0.0.1:1/mcp/<token>' : 'does not answer at http://127.0.0.1:1/mcp/<token>', since: T1 });

interface Run {
  code: number;
  sent: Notification[];
  lines: string[];
  calls: string[];
}

let dirs = 0;
async function stateDir(stored?: string): Promise<string> {
  const dir = join(temp, `watchdog-${++dirs}`);
  await mkdir(dir, { recursive: true });
  if (stored !== undefined) {
    await writeFile(join(dir, WATCHDOG_FILE), stored);
  }
  return dir;
}

async function runWatchdog(dir: string, status: 'ok' | 'down', extra: Partial<WatchdogOptions> & { activeState?: Partial<CommandOutput> } = {}): Promise<Run> {
  const sent: Notification[] = [];
  const lines: string[] = [];
  const calls: string[] = [];
  const { activeState, ...rest } = extra;
  const code = await watchdog({
    stateDir: dir,
    check: async () => row(status),
    run: async (file, args) => {
      const line = [file, ...args].join(' ');
      calls.push(line);
      return { code: 0, stdout: line === SHOW_ACTIVE_STATE ? 'active\n' : '', stderr: '', ...(line === SHOW_ACTIVE_STATE ? activeState : {}) };
    },
    send: async (notification): Promise<ChannelResult[]> => {
      sent.push(notification);
      return [{ channel: 'desktop', status: 'sent', message: 'ok' }, { channel: 'ntfy', status: 'skipped', message: 'SF_NTFY_URL is not set' }];
    },
    now: () => new Date(T1),
    print: (line) => lines.push(line),
    ...rest,
  });
  return { code, sent, lines, calls };
}

const stored = async (dir: string): Promise<unknown> => JSON.parse(await readFile(join(dir, WATCHDOG_FILE), 'utf8'));
const up = JSON.stringify({ down: false, since: T0 });
const down = JSON.stringify({ down: true, since: T0 });

test('up → down sends one high notification with the time and the journal, and records down since now', async () => {
  const dir = await stateDir(up);
  const run = await runWatchdog(dir, 'down');
  assert.equal(run.code, 0);
  assert.equal(run.sent.length, 1);
  const [notification] = run.sent;
  assert.equal(notification!.title, 'Software Factory: sf serve does not answer');
  assert.match(notification!.body, /^since \d{4}-\d\d-\d\d \d\d:\d\d:\d\d; journalctl --user -u software-factory$/);
  assert.equal(notification!.priority, 'high');
  assert.equal(notification!.tags, 'rotating_light');
  assert.deepEqual(await stored(dir), { down: true, since: T1 });
  assert.deepEqual(run.calls, [SHOW_ACTIVE_STATE]);
  assert.ok(run.lines.some((line) => line.startsWith('DOWN') && line.includes('MCP endpoint')), run.lines.join('\n'));
});

test('down → down sends nothing and keeps since', async () => {
  const dir = await stateDir(down);
  const run = await runWatchdog(dir, 'down');
  assert.equal(run.code, 0);
  assert.deepEqual(run.sent, []);
  assert.deepEqual(await stored(dir), { down: true, since: T0 });
});

test('down → up sends "answers again" with the time it went down', async () => {
  const dir = await stateDir(down);
  const run = await runWatchdog(dir, 'ok');
  assert.equal(run.code, 0);
  assert.equal(run.sent.length, 1);
  assert.equal(run.sent[0]!.title, 'Software Factory: sf serve answers again');
  assert.match(run.sent[0]!.body, /^down since \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(run.sent[0]!.priority, 'default');
  assert.equal(run.sent[0]!.tags, 'white_check_mark');
  assert.deepEqual(await stored(dir), { down: false, since: T1 });
});

test('up → up sends nothing', async () => {
  const dir = await stateDir(up);
  const run = await runWatchdog(dir, 'ok');
  assert.equal(run.code, 0);
  assert.deepEqual(run.sent, []);
  assert.deepEqual(await stored(dir), { down: false, since: T0 });
});

test('a failed unit counts as down even when the endpoint answers; an unanswered systemctl or a unit not installed does not', async () => {
  const failed = await runWatchdog(await stateDir(up), 'ok', { activeState: { stdout: 'failed\n' } });
  assert.equal(failed.sent.length, 1);
  assert.equal(failed.sent[0]!.title, 'Software Factory: sf serve does not answer');
  for (const activeState of [{ code: null, stdout: '', stderr: 'spawn systemctl ENOENT' }, { code: 1, stdout: 'failed\n' }, { stdout: 'inactive\n' }]) {
    const run = await runWatchdog(await stateDir(up), 'ok', { activeState });
    assert.deepEqual(run.sent, [], JSON.stringify(activeState));
  }
});

test('--force sends the down notification when already down, keeping since, and even when the endpoint answers', async () => {
  const already = await stateDir(down);
  const forced = await runWatchdog(already, 'down', { force: true });
  assert.equal(forced.code, 0);
  assert.equal(forced.sent.length, 1);
  assert.equal(forced.sent[0]!.title, 'Software Factory: sf serve does not answer');
  assert.deepEqual(await stored(already), { down: true, since: T0 });

  const answering = await stateDir(up);
  const gaveUp = await runWatchdog(answering, 'ok', { force: true });
  assert.equal(gaveUp.sent.length, 1);
  assert.equal(gaveUp.sent[0]!.priority, 'high');
  assert.deepEqual(await stored(answering), { down: true, since: T1 });
});

test('a missing or corrupt watchdog.json counts as up', async () => {
  for (const content of [undefined, '{not json', JSON.stringify({ down: 'yes', since: 3 }), 'null']) {
    const quiet = await stateDir(content);
    assert.deepEqual((await runWatchdog(quiet, 'ok')).sent, [], String(content));
    assert.deepEqual(await stored(quiet), { down: false, since: T1 }, String(content));
    const turned = await runWatchdog(await stateDir(content), 'down');
    assert.equal(turned.sent.length, 1, String(content));
  }
});

test('a failed send is printed and exits 1; the new state is kept, so the next run does not send again', async () => {
  const dir = await stateDir(up);
  const failing = await runWatchdog(dir, 'down', {
    send: async () => [{ channel: 'desktop', status: 'failed', message: 'notify-send exited with 1' }, { channel: 'ntfy', status: 'sent', message: 'HTTP 200' }],
  });
  assert.equal(failing.code, 1);
  assert.ok(failing.lines.some((line) => line.includes('desktop') && line.includes('notify-send exited with 1')), failing.lines.join('\n'));
  assert.deepEqual(await stored(dir), { down: true, since: T1 });
  assert.deepEqual((await runWatchdog(dir, 'down')).sent, []);

  const throwing = await runWatchdog(await stateDir(up), 'down', { send: async () => { throw new Error('boom'); } });
  assert.equal(throwing.code, 1);
  assert.ok(throwing.lines.some((line) => line.includes('boom')), throwing.lines.join('\n'));
});
