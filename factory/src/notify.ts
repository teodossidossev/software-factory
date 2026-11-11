// Notifications to the user: a desktop notification (notify-send) and ntfy (a push service for
// the phone), for the states that need the user. Best-effort: a failure is reported, never thrown.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { pushedBranch } from './continues.js';
import { withoutHostTokens } from './forge.js';
import type { Job, JobState, JobStore } from './jobs.js';
import { now, statesWith } from './jobs.js';
import { localTime } from './local-time.js';
import { HANDOFF_OFF_CODE } from './registry.js';
import { type CheckRecord, recordVerdict, severityCounts } from './task-check.js';
import { turnLimitLine } from './turn-limit.js';

const DESKTOP_TIMEOUT_MS = 5_000;
const NTFY_TIMEOUT_MS = 10_000;
export const NOTIFIED_STATES = statesWith('notified');
// The name of a usage limit's provider in a notification.
const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' } as const;

export interface NotifyConfig {
  desktop: boolean;
  // SF_NOTIFY_ITERATIONS=on: awaiting_review (a published iteration) is notified too.
  iterations: boolean;
  ntfyUrl: string | undefined;
  ntfyToken: string | undefined;
}

export interface Notification {
  title: string;
  // At most three lines.
  body: string;
  priority: 'high' | 'default';
  tags: string;
}

export interface ChannelResult {
  channel: 'desktop' | 'ntfy';
  status: 'sent' | 'skipped' | 'failed';
  message: string;
}

export function notifyConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
  return {
    desktop: env.SF_DESKTOP_NOTIFY !== 'off',
    iterations: env.SF_NOTIFY_ITERATIONS === 'on',
    ntfyUrl: env.SF_NTFY_URL || undefined,
    ntfyToken: env.SF_NTFY_TOKEN || undefined,
  };
}

// The states notified with this configuration.
export function notifiedStates(config: NotifyConfig): readonly JobState[] {
  return config.iterations ? [...NOTIFIED_STATES, 'awaiting_review'] : NOTIFIED_STATES;
}

// The notification for a job that reached state (or whose merge request was opened or merged);
// extra: the MR title and link (or the merge request's) when pushed, the
// sensitive, out-of-scope and deleted paths of the iteration.
export function jobNotification(job: Job, extra: string[] = []): Notification {
  // A chain that went on by itself after a turn limit says so in one line.
  const turnLimit = turnLimitLine(job);
  const lines = turnLimit !== undefined ? [turnLimit, ...extra] : extra;
  if (job.state === 'awaiting_review') {
    return {
      title: `${job.ticket}: ${job.state}`,
      body: [`Report and Patch of iteration ${job.iteration} are ready for the reviewers`, ...lines].slice(0, 3).join('\n'),
      priority: 'default',
      tags: 'eyes',
    };
  }
  if (job.state === 'paused') {
    // What the pause interrupted, which Resume runs again.
    const step = job.paused?.step;
    return {
      title: `${job.ticket}: paused`,
      body: [`branch: ${job.branch}`, step !== undefined && step !== null ? `Paused during the ${step}; Resume goes on from there.` : 'Paused; Resume goes on from there.', ...lines].slice(0, 3).join('\n'),
      priority: 'default',
      tags: 'pause_button',
    };
  }
  if (job.state === 'waiting_limit') {
    // Whose usage limit, and until when (local time, HH:MM) the job is parked.
    const limit = job.limit;
    const until = limit !== undefined ? localTime(limit.resets_at)?.slice(11, 16) : undefined;
    return {
      title: `${job.ticket}: waiting for limits`,
      body: [`Usage limit (${limit !== undefined ? PROVIDER_NAMES[limit.provider] : 'unknown'}): parked until ${until ?? 'the reset'}`, `branch: ${job.branch}`, ...lines].slice(0, 3).join('\n'),
      priority: 'default',
      tags: 'hourglass',
    };
  }
  if (job.state === 'handed_over') {
    // The changes wait in the user's checkout; extra holds the MR title and the file lines.
    return {
      title: `${job.ticket}: in your checkout`,
      body: [`in your checkout on ${job.branch}`, ...(job.error !== undefined ? [`${job.error.code}: ${job.error.message}`] : []), ...lines].slice(0, 3).join('\n'),
      priority: 'default',
      tags: 'eyes',
    };
  }
  // Why the automatic hand-over did not happen; not when hand-over is off: a
  // setting the user chose is not news, and the files line stays in the body.
  const skipped = job.state === 'ready_for_human_review' && job.handoff_skipped !== undefined && job.handoff_skipped.code !== HANDOFF_OFF_CODE ? [job.handoff_skipped.message] : [];
  // A pushed job names the branch it pushed (src/continues.ts).
  const body = [`branch: ${job.state === 'pushed' ? pushedBranch(job) : job.branch}`, ...(job.error !== undefined ? [`${job.error.code}: ${job.error.message}`] : []), ...skipped, ...lines].slice(0, 3);
  // A pushed job's merge request on the Git host names the title once it is opened or merged.
  const mr = job.state === 'pushed' && job.mr !== null && job.mr !== undefined ? job.mr : undefined;
  return {
    title: mr !== undefined ? `${job.ticket}: merge request #${mr.number} ${mr.state === 'open' ? 'opened' : mr.state}` : `${job.ticket}: ${job.state}`,
    body: body.join('\n'),
    priority: job.state === 'needs_human' || job.state === 'failed' ? 'high' : 'default',
    tags: job.state === 'pushed' ? 'white_check_mark' : job.state === 'ready_for_human_review' ? 'eyes' : 'warning',
  };
}

// The one notification of the run queue at a usage limit's reset: the parked jobs it
// resumed, or (rule wait) those that wait for the user.
export function limitResetNotification(resumed: number, waiting: number): Notification {
  const jobs = (count: number): string => `${count} job${count === 1 ? '' : 's'}`;
  const parts = [...(resumed > 0 ? [`${jobs(resumed)} resumed`] : []), ...(waiting > 0 ? [`${jobs(waiting)} ${waiting === 1 ? 'waits' : 'wait'} for you`] : [])];
  return { title: 'Usage limit reset', body: `Usage limit reset: ${parts.join(', ')}`, priority: 'default', tags: 'hourglass' };
}

// The notification for an automatic Task check that ended not ready ("N blocker, M major ·
// <workspace>", the counts as the board writes them) or failed (the first line of its error);
// undefined for a ready one.
export function taskCheckNotification(record: CheckRecord): Notification | undefined {
  const verdict = recordVerdict(record);
  if (verdict === 'ready') {
    return undefined;
  }
  if (verdict === 'failed') {
    return { title: `${record.ticket}: plan check failed`, body: (record.error ?? 'unknown error').split(/\r?\n/)[0]!, priority: 'default', tags: 'warning' };
  }
  const counts = severityCounts(record.output);
  return { title: `${record.ticket}: plan not ready`, body: `${counts.blocker} blocker, ${counts.major} major · ${record.workspace}`, priority: 'default', tags: 'warning' };
}

// Sends the notification of an automatic Task check that ended not ready or failed; each failed
// channel is logged, nothing is stored. Never rejects.
export async function notifyTaskCheck(record: CheckRecord, config: NotifyConfig, send: typeof sendNotification = sendNotification): Promise<void> {
  const notification = taskCheckNotification(record);
  if (notification === undefined) {
    return;
  }
  try {
    for (const result of await send(notification, config)) {
      if (result.status === 'failed') {
        console.error(`${record.workspace}/${record.ticket}: plan-check notification via ${result.channel} failed: ${result.message}`);
      }
    }
  } catch (error) {
    console.error(error);
  }
}

// The notification of a scheduled morning digest: counts only, never a name, subject or code.
export function digestNotification(counts: { landed: number; impact: number }): Notification {
  return { title: 'Morning digest ready', body: `Morning digest ready: ${counts.landed} landed, ${counts.impact} of mine need attention`, priority: 'default', tags: 'newspaper' };
}

// The notification of a health check that turned down, or is ok again after it was down:
// its label and detail (the checks' details carry no token).
export function healthNotification(check: { label: string; detail: string }, turned: 'down' | 'ok'): Notification {
  const detail = check.detail.replace(/\s+/g, ' ').trim().slice(0, 300);
  return turned === 'down'
    ? { title: `Factory health: ${check.label} is down`, body: detail === '' ? `${check.label} is down` : detail, priority: 'high', tags: 'rotating_light' }
    : { title: `Factory health: ${check.label} is ok again`, body: detail === '' ? `${check.label} is ok again` : detail, priority: 'default', tags: 'white_check_mark' };
}

async function findExecutable(name: string, path: string | undefined): Promise<string | undefined> {
  for (const dir of (path ?? '').split(delimiter).filter((entry) => entry !== '')) {
    try {
      await access(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch { // not here or not executable: the next PATH directory
    }
  }
  return undefined;
}

async function desktop(notification: Notification, config: NotifyConfig): Promise<ChannelResult> {
  if (!config.desktop) {
    return { channel: 'desktop', status: 'skipped', message: 'SF_DESKTOP_NOTIFY=off' };
  }
  const executable = await findExecutable('notify-send', process.env.PATH);
  if (executable === undefined) {
    return { channel: 'desktop', status: 'skipped', message: 'notify-send is not on PATH' };
  }
  const { SF_NTFY_TOKEN: _token, ...env } = withoutHostTokens();
  return new Promise((resolve) => {
    const child = spawn(executable, ['--app-name=Software Factory', notification.title, notification.body], {
      env, stdio: ['ignore', 'ignore', 'pipe'], timeout: DESKTOP_TIMEOUT_MS,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', (error) => resolve({ channel: 'desktop', status: 'failed', message: error.message }));
    child.once('close', (code) => {
      resolve(code === 0
        ? { channel: 'desktop', status: 'sent', message: 'notify-send succeeded' }
        : { channel: 'desktop', status: 'failed', message: `notify-send exited with ${code ?? 'a timeout'}: ${stderr.trim().slice(0, 300)}`.trim() });
    });
  });
}

async function ntfy(notification: Notification, config: NotifyConfig): Promise<ChannelResult> {
  if (config.ntfyUrl === undefined) {
    return { channel: 'ntfy', status: 'skipped', message: 'SF_NTFY_URL is not set' };
  }
  try {
    const response = await fetch(config.ntfyUrl, {
      method: 'POST',
      body: notification.body,
      headers: {
        Title: notification.title,
        Priority: notification.priority,
        Tags: notification.tags,
        ...(config.ntfyToken !== undefined ? { Authorization: `Bearer ${config.ntfyToken}` } : {}),
      },
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok
      ? { channel: 'ntfy', status: 'sent', message: `HTTP ${response.status}` }
      : { channel: 'ntfy', status: 'failed', message: `HTTP ${response.status}` };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return { channel: 'ntfy', status: 'failed', message: `${(error as Error).message}${cause !== undefined ? ` (${cause})` : ''}` };
  }
}

export async function sendNotification(notification: Notification, config: NotifyConfig): Promise<ChannelResult[]> {
  return Promise.all([desktop(notification, config), ntfy(notification, config)]);
}

// The listener behind Execution's onStateChange: notifies for the user's states and records each
// failed channel in the job's events.jsonl. Iterations (awaiting_review) are silent unless
// SF_NOTIFY_ITERATIONS=on. The promise settles when every channel is done (a job's runner waits for
// it before it exits); it never rejects.
export function stateNotifier(config: NotifyConfig, jobs: JobStore): (job: Job, from: JobState | null, lines?: string[]) => Promise<void> {
  const states = notifiedStates(config);
  return (job, _from, lines) => {
    if (!states.includes(job.state)) {
      return Promise.resolve();
    }
    return (async () => {
      for (const result of await sendNotification(jobNotification(job, lines), config)) {
        if (result.status === 'failed') {
          await jobs.appendEvent(job.workspace, job.ticket, {
            ts: now(), iteration: job.iteration, type: 'notify_failed', channel: result.channel, message: result.message,
          });
        }
      }
    })().catch((error: unknown) => console.error(error));
  };
}
