// sf health --notify: the watchdog outside sf serve, run by the units sf service install writes
// (src/service.ts): software-factory-watchdog.timer every five minutes, and
// software-factory-alert.service with --force when systemd gave up restarting the service. It
// watches only sf serve itself, since sf serve notifies its own checks: the MCP endpoint row, and
// the service's systemd state, where only failed counts as down. watchdog.json in the state
// directory holds the last state; one notification when sf serve stops answering, one when it
// answers again, none while nothing changes. --force sends the down one even without a change and
// records down. A missing or corrupt watchdog.json counts as up. The exit code is 0, or 1 when the
// notification could not be sent, so the watchdog unit fails only for that.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import type { HealthCheck } from './health.js';
import { healthLines } from './health.js';
import { localTime } from './local-time.js';
import { type ChannelResult, type Notification, notifyConfig, sendNotification } from './notify.js';
import { JOURNAL_HINT, type RunCommand, runCommand, SERVICE_NAME } from './service.js';

export const WATCHDOG_FILE = 'watchdog.json';

// The last state the watchdog saw: whether sf serve was down, and since when (ISO 8601 UTC).
export interface WatchdogState {
  down: boolean;
  since: string;
}

export interface WatchdogOptions {
  stateDir: string;
  // The alert unit's run: systemd gave up restarting the service.
  force?: boolean;
  // The MCP endpoint row, as sf health computes it.
  check(): Promise<HealthCheck>;
  // systemctl, for the service's ActiveState; by default the real one.
  run?: RunCommand;
  // By default sendNotification with the settings of notifyConfig(), as sf serve sends.
  send?: (notification: Notification) => Promise<ChannelResult[]>;
  now?: () => Date;
  print?: (line: string) => void;
}

const when = (ts: string): string => localTime(ts) ?? ts;

export function downNotification(since: string): Notification {
  return { title: 'Software Factory: sf serve does not answer', body: `since ${when(since)}; ${JOURNAL_HINT}`, priority: 'high', tags: 'rotating_light' };
}

export function upNotification(downSince: string): Notification {
  return { title: 'Software Factory: sf serve answers again', body: `down since ${when(downSince)}`, priority: 'default', tags: 'white_check_mark' };
}

// The stored state; undefined when watchdog.json is missing or not a state.
async function readState(path: string): Promise<WatchdogState | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof value === 'object' && value !== null) {
      const { down, since } = value as Record<string, unknown>;
      if (typeof down === 'boolean' && typeof since === 'string') {
        return { down, since };
      }
    }
  } catch { // missing or not JSON: up
  }
  return undefined;
}

// The service's ActiveState; undefined when systemctl does not answer.
async function activeState(run: RunCommand): Promise<string | undefined> {
  const shown = await run('systemctl', ['--user', 'show', SERVICE_NAME, '--property=ActiveState', '--value']);
  return shown.code === 0 ? shown.stdout.trim() : undefined;
}

// One watchdog run; returns the exit code.
export async function watchdog(options: WatchdogOptions): Promise<number> {
  const print = options.print ?? console.log;
  const send = options.send ?? ((notification: Notification) => sendNotification(notification, notifyConfig()));
  const now = (options.now ?? (() => new Date()))().toISOString();
  const path = join(options.stateDir, WATCHDOG_FILE);

  const [check, state] = await Promise.all([options.check(), activeState(options.run ?? runCommand)]);
  print(healthLines([check]).join('\n'));
  print(`systemd: ${SERVICE_NAME} ${state === undefined ? 'unknown (systemctl does not answer)' : state === '' ? 'unknown' : state}`);
  const isDown = options.force === true || check.status === 'down' || state === 'failed';

  const before = (await readState(path)) ?? { down: false, since: now };
  const after: WatchdogState = isDown === before.down ? before : { down: isDown, since: now };
  await writeFileAtomic(path, Buffer.from(`${JSON.stringify(after)}\n`, 'utf8'), 0o644);

  let notification: Notification | undefined;
  if (isDown && (!before.down || options.force === true)) {
    notification = downNotification(after.since);
  } else if (!isDown && before.down) {
    notification = upNotification(before.since);
  }
  if (notification === undefined) {
    print(`watchdog: sf serve ${isDown ? 'is down' : 'answers'} since ${when(after.since)}; no change, nothing sent`);
    return 0;
  }
  print(`watchdog: ${notification.title}`);
  let results: ChannelResult[];
  try {
    results = await send(notification);
  } catch (error) {
    print(`watchdog: the notification could not be sent: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  for (const result of results) {
    print(`watchdog: ${result.channel} ${result.status}: ${result.message}`);
  }
  return results.some((result) => result.status === 'failed') ? 1 : 0;
}
