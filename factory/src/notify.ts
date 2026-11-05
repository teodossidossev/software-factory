// Notifications to the user: a desktop notification (notify-send) and ntfy (a push service for
// the phone), for the states that need the user. Best-effort: a failure is reported, never thrown.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { withoutHostTokens } from './forge.js';
import type { Job, JobState, JobStore } from './jobs.js';
import { now } from './jobs.js';

const DESKTOP_TIMEOUT_MS = 5_000;
const NTFY_TIMEOUT_MS = 10_000;
export const NOTIFIED_STATES: readonly JobState[] = ['ready_for_human_review', 'needs_human', 'pushed', 'failed'];

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
// lines: the MR title and link (or the merge request's) when pushed, the
// sensitive, out-of-scope and deleted paths of the iteration (SF-024, SF-053).
export function jobNotification(job: Job, lines: string[] = []): Notification {
  if (job.state === 'awaiting_review') {
    return {
      title: `${job.ticket}: ${job.state}`,
      body: [`Report and Patch of iteration ${job.iteration} are ready for the reviewers`, ...lines].slice(0, 3).join('\n'),
      priority: 'default',
      tags: 'eyes',
    };
  }
  const body = [`branch: ${job.branch}`, ...(job.error !== undefined ? [`${job.error.code}: ${job.error.message}`] : []), ...lines].slice(0, 3);
  // A pushed job's merge request on the Git host (SF-048) names the title once it is opened or merged.
  const mr = job.state === 'pushed' && job.mr !== null && job.mr !== undefined ? job.mr : undefined;
  return {
    title: mr !== undefined ? `${job.ticket}: merge request #${mr.number} ${mr.state === 'open' ? 'opened' : mr.state}` : `${job.ticket}: ${job.state}`,
    body: body.join('\n'),
    priority: job.state === 'needs_human' || job.state === 'failed' ? 'high' : 'default',
    tags: job.state === 'pushed' ? 'white_check_mark' : job.state === 'ready_for_human_review' ? 'eyes' : 'warning',
  };
}

async function findExecutable(name: string, path: string | undefined): Promise<string | undefined> {
  for (const dir of (path ?? '').split(delimiter).filter((entry) => entry !== '')) {
    try {
      await access(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // Not in this directory.
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
