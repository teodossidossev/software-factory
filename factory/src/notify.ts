// Notifications to the user: a desktop notification (notify-send) and ntfy (a push service for
// the phone), for the states that need the user. The ntfy priority says who must act; a workspace's
// notify setting (full, brief, off) says how much its notifications tell. Best-effort: a failure is
// reported, never thrown.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { sitsOnPart } from './builds-on.js';
import { pushedBranch } from './continues.js';
import { withoutHostTokens } from './forge.js';
import type { Job, JobState, JobStore } from './jobs.js';
import { now, statesWith } from './jobs.js';
import type { LastReviewRecord } from './last-review.js';
import { localTime } from './local-time.js';
import { HANDOFF_OFF_CODE, type NotifyMode } from './registry.js';
import { type CheckRecord, recordCounts, recordVerdict } from './task-check.js';
import { turnLimitLine } from './turn-limit.js';

const DESKTOP_TIMEOUT_MS = 5_000;
const NTFY_TIMEOUT_MS = 10_000;
// The wait before the one retry of an ntfy send that got no HTTP response.
export const NTFY_RETRY_MS = 3_000;
export const NOTIFIED_STATES = statesWith('notified');
// The name of a usage limit's provider in a notification.
const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' } as const;

export interface NotifyConfig {
  desktop: boolean;
  // SF_NOTIFY_ITERATIONS=on: awaiting_review (a published iteration) is notified too.
  iterations: boolean;
  ntfyUrl: string | undefined;
  ntfyToken: string | undefined;
  // The wait before ntfy's retry; NTFY_RETRY_MS when not given (tests pass a short one).
  ntfyRetryMs?: number;
}

export interface Notification {
  title: string;
  // At most three lines.
  body: string;
  // The body ntfy sends instead of body (a brief workspace's); the desktop always shows body.
  ntfyBody?: string;
  // ntfy's Priority: high when the user must act, low when nothing is to do.
  priority: 'high' | 'default' | 'low';
  tags: string;
  click?: string; // ntfy's Click: the page a tap opens
}

// The states whose notification is high: the job waits for the user (the waiting trait) or failed.
const ACT_STATES: readonly JobState[] = [...statesWith('waiting'), 'failed'];

// The priority of a job's notification: high when the user must act, low otherwise (pushed,
// paused, waiting_limit, awaiting_review).
export function jobPriority(state: JobState): 'high' | 'low' {
  return ACT_STATES.includes(state) ? 'high' : 'low';
}

// The workspace's notify setting (src/registry.ts), asked for each notification.
export type NotifyModeOf = (workspace: string) => Promise<NotifyMode>;

// A factory error code (snake_case); any other text is not a code and is not sent in a brief body.
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

// The one line ntfy sends for a job of a brief workspace: the workspace's name and, when the job
// has an error, its code; never the branch, a path, the error's message, an MR title or a link.
export function briefJobBody(job: Job): string {
  const code = job.error?.code;
  return code === undefined ? job.workspace : `${job.workspace} · ${ERROR_CODE.test(code) ? code : 'error'}`;
}

// The notification as the workspace's setting has it: undefined when off (no channel sends it);
// brief, ntfy sends the brief body (a click is kept: only a planner's has one, its session's opaque
// claude.ai page); full, as it is.
export function withNotifyMode(notification: Notification, mode: NotifyMode, brief: string): Notification | undefined {
  if (mode === 'off') {
    return undefined;
  }
  return mode === 'brief' ? { ...notification, ntfyBody: brief } : notification;
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
// sensitive, out-of-scope and deleted paths of the iteration. A part whose change is on its base
// and that waits for the user is titled ready to submit (src/builds-on.ts sitsOnPart); lastReview:
// the note of the iteration's last review (lastReviewNote), appended to the first body line of
// handed_over and ready_for_human_review as " · <note>".
export function jobNotification(job: Job, extra: string[] = [], lastReview?: string): Notification {
  const withNote = (line: string): string => (lastReview === undefined ? line : `${line} · ${lastReview}`);
  // A chain that went on by itself after a turn limit says so in one line.
  const turnLimit = turnLimitLine(job);
  const lines = turnLimit !== undefined ? [turnLimit, ...extra] : extra;
  const readyToSubmit = (job.state === 'ready_for_human_review' || job.state === 'handed_over') && job.builds_on !== null && !sitsOnPart(job);
  if (job.state === 'awaiting_review') {
    return {
      title: `${job.ticket}: ${job.state}`,
      body: [`Report and Patch of iteration ${job.iteration} are ready for the reviewers`, ...lines].slice(0, 3).join('\n'),
      priority: jobPriority(job.state),
      tags: 'eyes',
    };
  }
  if (job.state === 'paused') {
    // What the pause interrupted, which Resume runs again.
    const step = job.paused?.step;
    return {
      title: `${job.ticket}: paused`,
      body: [`branch: ${job.branch}`, step !== undefined && step !== null ? `Paused during the ${step}; Resume goes on from there.` : 'Paused; Resume goes on from there.', ...lines].slice(0, 3).join('\n'),
      priority: jobPriority(job.state),
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
      priority: jobPriority(job.state),
      tags: 'hourglass',
    };
  }
  if (job.state === 'handed_over') {
    // The changes wait in the user's checkout; extra holds the MR title and the file lines.
    return {
      title: readyToSubmit ? `${job.ticket}: ready to submit` : `${job.ticket}: in your checkout`,
      body: [withNote(`in your checkout on ${job.branch}`), ...(job.error !== undefined ? [`${job.error.code}: ${job.error.message}`] : []), ...lines].slice(0, 3).join('\n'),
      priority: jobPriority(job.state),
      tags: 'eyes',
    };
  }
  // Why the automatic hand-over did not happen; not when hand-over is off: a
  // setting the user chose is not news, and the files line stays in the body.
  const skipped = job.state === 'ready_for_human_review' && job.handoff_skipped !== undefined && job.handoff_skipped.code !== HANDOFF_OFF_CODE ? [job.handoff_skipped.message] : [];
  // A pushed job names the branch it pushed (src/continues.ts).
  const branch = `branch: ${job.state === 'pushed' ? pushedBranch(job) : job.branch}`;
  const body = [job.state === 'ready_for_human_review' ? withNote(branch) : branch, ...(job.error !== undefined ? [`${job.error.code}: ${job.error.message}`] : []), ...skipped, ...lines].slice(0, 3);
  // A pushed job's merge request on the Git host names the title once it is opened or merged.
  const mr = job.state === 'pushed' && job.mr !== null && job.mr !== undefined ? job.mr : undefined;
  return {
    title: mr !== undefined ? `${job.ticket}: merge request #${mr.number} ${mr.state === 'open' ? 'opened' : mr.state}` : readyToSubmit ? `${job.ticket}: ready to submit` : `${job.ticket}: ${job.state}`,
    body: body.join('\n'),
    priority: jobPriority(job.state),
    tags: job.state === 'pushed' ? 'white_check_mark' : job.state === 'ready_for_human_review' ? 'eyes' : 'warning',
  };
}

// The notification of `sf notify-test`: that of a test job that waits for the user (needs_human),
// with its title, tags and high priority, so the test shows what an important notification does
// on the phone and the watch.
export function testNotification(at: string): Notification {
  const job: Job = {
    workspace: 'test', ticket: 'SF-TEST', branch: 'SF-TEST-notification', base: 'main', continues: null, builds_on: null, builds_on_commit: null, base_commit: null, worktree: null, prepared_commit: null,
    target_commit: null, mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'needs_human', iteration: 0, session_id: null, mr: null, created_at: at, updated_at: at,
  };
  return jobNotification(job, ['A test notification from sf notify-test']);
}

// The one notification of the run queue at a usage limit's reset: the parked jobs it
// resumed, or (rule wait) those that wait for the user.
export function limitResetNotification(resumed: number, waiting: number): Notification {
  const jobs = (count: number): string => `${count} job${count === 1 ? '' : 's'}`;
  const parts = [...(resumed > 0 ? [`${jobs(resumed)} resumed`] : []), ...(waiting > 0 ? [`${jobs(waiting)} ${waiting === 1 ? 'waits' : 'wait'} for you`] : [])];
  return { title: 'Usage limit reset', body: `Usage limit reset: ${parts.join(', ')}`, priority: 'low', tags: 'hourglass' };
}

// The notification for an automatic Task check that ended not ready ("N blocker, M major ·
// <workspace>", the counts of both checks as the board writes them) or failed (the first line of
// its error); undefined for a ready one.
export function taskCheckNotification(record: CheckRecord): Notification | undefined {
  const verdict = recordVerdict(record);
  if (verdict === 'ready') {
    return undefined;
  }
  if (verdict === 'failed') {
    return { title: `${record.ticket}: plan check failed`, body: (record.error ?? 'unknown error').split(/\r?\n/)[0]!, priority: 'default', tags: 'warning' };
  }
  const counts = recordCounts(record);
  return { title: `${record.ticket}: plan not ready`, body: `${counts.blocker} blocker, ${counts.major} major · ${record.workspace}`, priority: 'default', tags: 'warning' };
}

// The one line ntfy sends for a Task check of a brief workspace: a "plan not ready" keeps its body
// (the counts and the workspace), a "plan check failed" names the workspace only.
function briefTaskCheckBody(record: CheckRecord, full: Notification): string {
  return recordVerdict(record) === 'failed' ? record.workspace : full.body;
}

// Sends the notification of an automatic Task check that ended not ready or failed, as the
// workspace's notify setting has it (brief: "plan not ready" keeps its body, which holds no text
// of the repository; "plan check failed" names the workspace only); each failed channel is
// logged, nothing is stored. Never rejects.
export async function notifyTaskCheck(record: CheckRecord, config: NotifyConfig, notifyModeOf: NotifyModeOf, send: typeof sendNotification = sendNotification): Promise<void> {
  const full = taskCheckNotification(record);
  if (full === undefined) {
    return;
  }
  try {
    const notification = withNotifyMode(full, await notifyModeOf(record.workspace), briefTaskCheckBody(record, full));
    if (notification === undefined) {
      return;
    }
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

// A Claude Code session id that may go into a claude.ai link.
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

// The notification of a planner session that waits for the user (or for a permission): the
// workspace as its body, the session's ticket first in its title when it has one, and the
// session's page when its id is known.
export function plannerNotification(workspace: string, permission: boolean, sessionId: string | undefined, ticket?: string): Notification {
  const waits = permission ? 'waits for a permission' : 'waits for you';
  return {
    title: ticket !== undefined ? `${ticket}: planner ${waits}` : `Planner ${waits}`,
    body: workspace,
    priority: 'high',
    tags: 'speech_balloon',
    ...(sessionId !== undefined && SESSION_ID.test(sessionId) ? { click: `https://claude.ai/code/${sessionId}` } : {}),
  };
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

// One POST to ntfy, with its own timeout: the HTTP status, or the network error's one-line message.
async function ntfyPost(notification: Notification, url: string, token: string | undefined): Promise<{ ok: boolean; status: number } | { error: string }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: notification.ntfyBody ?? notification.body,
      headers: {
        Title: notification.title,
        Priority: notification.priority,
        Tags: notification.tags,
        ...(notification.click !== undefined ? { Click: notification.click } : {}),
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    });
    // The answer is in; a body that will not cancel does not make it a network error.
    await response.body?.cancel().catch(() => undefined);
    return { ok: response.ok, status: response.status };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return { error: `${(error as Error).message}${cause !== undefined ? ` (${cause})` : ''}`.replace(/\s+/g, ' ').trim() };
  }
}

// A send that got no HTTP response (a network error or a timeout) is tried once more after
// NTFY_RETRY_MS; an HTTP error status is not. The message names the retry.
async function ntfy(notification: Notification, config: NotifyConfig): Promise<ChannelResult> {
  if (config.ntfyUrl === undefined) {
    return { channel: 'ntfy', status: 'skipped', message: 'SF_NTFY_URL is not set' };
  }
  let attempt = await ntfyPost(notification, config.ntfyUrl, config.ntfyToken);
  const retried = 'error' in attempt;
  if (retried) {
    await sleep(config.ntfyRetryMs ?? NTFY_RETRY_MS);
    attempt = await ntfyPost(notification, config.ntfyUrl, config.ntfyToken);
  }
  if ('error' in attempt) {
    return { channel: 'ntfy', status: 'failed', message: `${attempt.error} (after a retry)` };
  }
  if (!attempt.ok) {
    return { channel: 'ntfy', status: 'failed', message: `HTTP ${attempt.status}${retried ? ' (after a retry)' : ''}` };
  }
  return { channel: 'ntfy', status: 'sent', message: `HTTP ${attempt.status}${retried ? ', after a retry' : ''}` };
}

export async function sendNotification(notification: Notification, config: NotifyConfig): Promise<ChannelResult[]> {
  return Promise.all([desktop(notification, config), ntfy(notification, config)]);
}

// The notification's note of a last review (iterations/NNN/last-review.json): its count of
// comments, or that it failed; undefined without a record.
export function lastReviewNote(record: LastReviewRecord | undefined): string | undefined {
  if (record === undefined) {
    return undefined;
  }
  return 'error' in record ? 'last review failed' : `last review: ${record.comments.length} comment${record.comments.length === 1 ? '' : 's'}`;
}

// The states whose notification carries the last review's note.
const LAST_REVIEW_STATES: readonly JobState[] = ['handed_over', 'ready_for_human_review'];

// The listener behind Execution's onStateChange: notifies for the user's states and records each
// failed channel in the job's events.jsonl. Iterations (awaiting_review) are silent unless
// SF_NOTIFY_ITERATIONS=on. A job reaching handed_over or ready_for_human_review has its iteration's
// last review counted on the body's first line (lastReviewNote; a record that cannot be read counts
// as none, as the notification is best-effort). The workspace's notify setting is asked for each
// notification: off sends nothing, brief sends ntfy one line (briefJobBody). The promise settles
// when every channel is done (a job's runner waits for it before it exits); it never rejects.
export function stateNotifier(
  config: NotifyConfig, jobs: Pick<JobStore, 'appendEvent' | 'readLastReview'>, notifyModeOf: NotifyModeOf, send: typeof sendNotification = sendNotification,
): (job: Job, from: JobState | null, lines?: string[]) => Promise<void> {
  const states = notifiedStates(config);
  return (job, _from, lines) => {
    if (!states.includes(job.state)) {
      return Promise.resolve();
    }
    return (async () => {
      const mode = await notifyModeOf(job.workspace);
      // Off sends nothing: the record is not read.
      const record = mode !== 'off' && LAST_REVIEW_STATES.includes(job.state)
        ? await jobs.readLastReview(job.workspace, job.ticket, job.iteration).catch(() => undefined) : undefined;
      const notification = withNotifyMode(jobNotification(job, lines, lastReviewNote(record)), mode, briefJobBody(job));
      if (notification === undefined) {
        return;
      }
      for (const result of await send(notification, config)) {
        if (result.status === 'failed') {
          await jobs.appendEvent(job.workspace, job.ticket, {
            ts: now(), iteration: job.iteration, type: 'notify_failed', channel: result.channel, message: result.message,
          });
        }
      }
    })().catch((error: unknown) => console.error(error));
  };
}
