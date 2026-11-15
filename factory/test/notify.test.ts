// Unit tests of the notifications (SF-215): the priority follows who must act, and a workspace's
// notify setting (full, brief, off) decides how much its jobs' and Task checks' notifications tell.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { type Job, type JobMr, type JobState, statesWith } from '../src/jobs.js';
import {
  briefJobBody, type ChannelResult, digestNotification, healthNotification, jobNotification, jobPriority, limitResetNotification, type Notification, type NotifyConfig, NOTIFIED_STATES,
  NTFY_RETRY_MS, sendNotification, stateNotifier, taskCheckNotification, testNotification,
} from '../src/notify.js';
import { type NotifyMode, saveRegistry, workspaceNotifyMode } from '../src/registry.js';
import type { CheckRecord } from '../src/task-check.js';

const CREATED = '2026-11-13T10:00:00.000Z';
const BRANCH = 'T-1-secret-branch';
const SECRET = 'push refused for /home/me/app: see https://git.example.org/acme/app/pull/7';
const MR_LINE = 'Merge request #7: https://git.example.org/acme/app/pull/7';
const MR: JobMr = { host: 'github', number: 7, url: 'https://git.example.org/acme/app/pull/7', state: 'open' };

function job(state: JobState, extra: Partial<Job> = {}): Job {
  return {
    workspace: 'app', ticket: 'T-1', branch: BRANCH, base: 'main', continues: null, base_commit: null, worktree: null, prepared_commit: null, target_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state, iteration: 2, session_id: null, mr: null, created_at: CREATED, updated_at: CREATED,
    ...extra,
  };
}

const CONFIG: NotifyConfig = { desktop: true, iterations: true, ntfyUrl: undefined, ntfyToken: undefined };
const NO_EVENTS = { appendEvent: async (): Promise<void> => undefined };

// Records what was sent instead of sending it.
function recorder(): { sent: Notification[]; send: (notification: Notification) => Promise<ChannelResult[]> } {
  const sent: Notification[] = [];
  return {
    sent,
    send: async (notification) => {
      sent.push(notification);
      return [];
    },
  };
}

interface Received { headers: IncomingHttpHeaders; body: string }

let temp: string;
let ntfy: Server;
let ntfyUrl: string;
const received: Received[] = [];

before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sf-notify-'));
  ntfy = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => ntfy.listen(0, '127.0.0.1', resolve));
  ntfyUrl = `http://127.0.0.1:${(ntfy.address() as AddressInfo).port}/sf-notify`;
});

after(async () => {
  await new Promise<void>((resolve) => ntfy.close(() => resolve()));
  await rm(temp, { recursive: true, force: true });
});

test('the priority follows who must act: high for the waiting states and failed, low for the others; the limit reset low, a Task check default', () => {
  const table: Record<string, Notification['priority']> = {
    needs_human: 'high', ready_for_human_review: 'high', handed_over: 'high', failed: 'high',
    pushed: 'low', paused: 'low', waiting_limit: 'low', awaiting_review: 'low',
  };
  // Every notified state is in the table (a new one must be given its priority here).
  assert.deepEqual([...NOTIFIED_STATES, 'awaiting_review'].sort(), Object.keys(table).sort());
  for (const [state, priority] of Object.entries(table)) {
    assert.equal(jobNotification(job(state as JobState)).priority, priority, state);
  }
  // A pushed job's merge request opened: still nothing to do.
  assert.equal(jobNotification(job('pushed', { mr: MR })).priority, 'low');
  assert.equal(limitResetNotification(1, 1).priority, 'low');
  const record = (verdict: 'not_ready' | 'failed'): CheckRecord => ({
    workspace: 'app', ticket: 'T-1', sha256: 'x', commit: null, status: verdict === 'failed' ? 'failed' : 'checked',
    output: verdict === 'failed' ? null : { paraphrase: 'p', findings: [], files: [], verdict },
    error: verdict === 'failed' ? 'boom' : null, model: null, cost_usd: null, started_at: CREATED, ended_at: CREATED,
  });
  assert.equal(taskCheckNotification(record('not_ready'))?.priority, 'default');
  assert.equal(taskCheckNotification(record('failed'))?.priority, 'default');
  // Health and digest unchanged.
  assert.equal(healthNotification({ label: 'MCP', detail: '' }, 'down').priority, 'high');
  assert.equal(healthNotification({ label: 'MCP', detail: '' }, 'ok').priority, 'default');
  assert.equal(digestNotification({ landed: 1, impact: 0 }).priority, 'default');
});

test('briefJobBody: the workspace and, with an error, its code; never the branch, the error message, a path or a link', () => {
  assert.equal(briefJobBody(job('ready_for_human_review')), 'app');
  assert.equal(briefJobBody(job('failed', { error: { code: 'push_failed', message: SECRET } })), 'app · push_failed');
  // Anything that is not a code is not sent.
  assert.equal(briefJobBody(job('failed', { error: { code: 'see /home/me https://x', message: SECRET } })), 'app · error');
});

test('stateNotifier: brief keeps the title, priority and tags and gives ntfy one line, the desktop the full body; off sends nothing and silences only its own workspace', async () => {
  const modes: Record<string, NotifyMode> = { app: 'brief', quiet: 'off' };
  const { sent, send } = recorder();
  const notify = stateNotifier(CONFIG, NO_EVENTS, async (workspace) => modes[workspace] ?? 'full', send);
  const pushed = job('pushed', { mr: MR });
  const failed = job('failed', { error: { code: 'push_failed', message: SECRET } });
  await notify(pushed, 'preparing_mr', ['feat(T-1): Secret title', MR_LINE]);
  await notify(failed, 'working');
  await notify(job('needs_human', { workspace: 'quiet' }), 'working');
  await notify(job('needs_human', { workspace: 'other' }), 'working');
  // Not a notified state: nothing, whatever the setting.
  await notify(job('working'), 'starting');
  assert.equal(sent.length, 3);
  const [briefPushed, briefFailed, other] = sent;
  assert.deepEqual({ ...briefPushed, body: undefined }, { ...jobNotification(pushed, ['feat(T-1): Secret title', MR_LINE]), body: undefined, ntfyBody: 'app' });
  assert.equal(briefPushed!.title, 'T-1: merge request #7 opened');
  assert.equal(briefPushed!.body, jobNotification(pushed, ['feat(T-1): Secret title', MR_LINE]).body);
  assert.deepEqual([briefFailed!.title, briefFailed!.priority, briefFailed!.tags, briefFailed!.ntfyBody], ['T-1: failed', 'high', 'warning', 'app · push_failed']);
  assert.match(briefFailed!.body, /push refused for \/home\/me\/app/);
  for (const note of [briefPushed!, briefFailed!]) {
    for (const leak of [BRANCH, SECRET, 'push refused', '/home/me', 'https://', 'Secret title', '\n']) {
      assert.equal(note.ntfyBody!.includes(leak), false, `${note.title}: ${leak}`);
    }
  }
  assert.equal(other!.title, 'T-1: needs_human');
  assert.equal(other!.ntfyBody, undefined);
});

test('sendNotification: ntfy sends ntfyBody with the title, priority and tags; the desktop shows the full body', async () => {
  const bin = join(temp, 'bin');
  const log = join(temp, 'desktop.log');
  await rm(bin, { recursive: true, force: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'notify-send'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
  await chmod(join(bin, 'notify-send'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = bin;
  received.length = 0;
  try {
    const full = jobNotification(job('failed', { error: { code: 'push_failed', message: SECRET } }));
    const results = await sendNotification({ ...full, ntfyBody: 'app · push_failed' }, { ...CONFIG, ntfyUrl });
    assert.deepEqual(results.map((result) => [result.channel, result.status]), [['desktop', 'sent'], ['ntfy', 'sent']]);
  } finally {
    process.env.PATH = path;
  }
  assert.equal(received.length, 1);
  assert.deepEqual([received[0]!.headers.title, received[0]!.headers.priority, received[0]!.headers.tags, received[0]!.body], ['T-1: failed', 'high', 'warning', 'app · push_failed']);
  assert.equal(await readFile(log, 'utf8'), `--app-name=Software Factory\nT-1: failed\nbranch: ${BRANCH}\npush_failed: ${SECRET}\n`);
});

test('with a workspace off in the registry: its jobs send nothing, another workspace\'s still go out, and health and digest notifications go out on ntfy', async () => {
  const dir = join(temp, 'config');
  await saveRegistry({ workspaces: { app: { read_checkout: '/srv/app', notify: 'off' }, shop: { read_checkout: '/srv/shop' } } }, dir);
  received.length = 0;
  const config = { ...CONFIG, desktop: false, ntfyUrl };
  const notify = stateNotifier(config, NO_EVENTS, (name) => workspaceNotifyMode(name, dir));
  await notify(job('needs_human'), 'working');
  await notify(job('needs_human', { workspace: 'shop' }), 'working');
  await sendNotification(healthNotification({ label: 'MCP', detail: 'refused' }, 'down'), config);
  await sendNotification(digestNotification({ landed: 2, impact: 1 }), config);
  assert.deepEqual(received.map((entry) => [entry.headers.title, entry.body]), [
    ['T-1: needs_human', `branch: ${BRANCH}`],
    ['Factory health: MCP is down', 'refused'],
    ['Morning digest ready', 'Morning digest ready: 2 landed, 1 of mine need attention'],
  ]);
});

test('sf notify-test sends a waiting state\'s notification: its title names the state, at the waiting states\' priority (high)', () => {
  const tested = testNotification(CREATED);
  for (const state of statesWith('waiting')) {
    assert.equal(tested.priority, jobPriority(state), state);
  }
  assert.equal(tested.priority, 'high');
  assert.equal(statesWith('waiting').includes('needs_human'), true);
  assert.deepEqual([tested.title, tested.tags, tested.body], ['SF-TEST: needs_human', 'warning', 'branch: SF-TEST-notification\nA test notification from sf notify-test']);
});

// An ntfy server that answers its requests in turn: 'drop' closes the connection with no HTTP
// response (a network error for fetch), a number is that HTTP status. The result and the request count.
async function ntfyWith(answers: Array<'drop' | number>): Promise<{ result: ChannelResult; requests: number }> {
  let requests = 0;
  const server = createServer((req, res) => {
    const answer = answers[requests++] ?? 200;
    req.resume();
    if (answer === 'drop') {
      req.socket.destroy();
    } else {
      res.writeHead(answer).end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sf-notify`;
    const results = await sendNotification(digestNotification({ landed: 1, impact: 0 }), { ...CONFIG, desktop: false, ntfyUrl: url, ntfyRetryMs: 10 });
    return { result: results.find((result) => result.channel === 'ntfy')!, requests };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('ntfy: a send with no HTTP response is tried once more and the result names the retry; an HTTP error is not retried', async () => {
  assert.equal(NTFY_RETRY_MS, 3000);
  const recovered = await ntfyWith(['drop', 200]);
  assert.deepEqual([recovered.result.status, recovered.result.message, recovered.requests], ['sent', 'HTTP 200, after a retry', 2]);
  const lost = await ntfyWith(['drop', 'drop', 200]);
  assert.deepEqual([lost.result.status, lost.requests], ['failed', 2]);
  assert.match(lost.result.message, /^fetch failed.* \(after a retry\)$/);
  assert.equal(lost.result.message.includes('\n'), false);
  const refused = await ntfyWith([500, 200]);
  assert.deepEqual([refused.result.status, refused.result.message, refused.requests], ['failed', 'HTTP 500', 1]);
  // A retry answered with an HTTP error: that second failure's message, then the retry.
  const refusedLater = await ntfyWith(['drop', 500, 200]);
  assert.deepEqual([refusedLater.result.status, refusedLater.result.message, refusedLater.requests], ['failed', 'HTTP 500 (after a retry)', 2]);
  const first = await ntfyWith([200]);
  assert.deepEqual([first.result.status, first.result.message, first.requests], ['sent', 'HTTP 200', 1]);
});
