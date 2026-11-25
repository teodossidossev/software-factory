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
import type { LastReviewRecord } from '../src/last-review.js';
import {
  briefJobBody, type ChannelResult, digestNotification, healthNotification, jobNotification, jobPriority, lastReviewNote, limitResetNotification, type Notification, type NotifyConfig, NOTIFIED_STATES,
  NTFY_RETRY_MS, plannerNotification, sendNotification, stateNotifier, taskCheckNotification, testNotification,
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
    workspace: 'app', ticket: 'T-1', branch: BRANCH, base: 'main', continues: null, builds_on: null, builds_on_commit: null,base_commit: null, worktree: null, prepared_commit: null, target_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state, iteration: 2, session_id: null, mr: null, created_at: CREATED, updated_at: CREATED,
    ...extra,
  };
}

const CONFIG: NotifyConfig = { desktop: true, iterations: true, ntfyUrl: undefined, ntfyToken: undefined };
const NO_EVENTS = { appendEvent: async (): Promise<void> => undefined, readLastReview: async () => undefined };

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

test('a part on its base that waits for the user is titled ready to submit, with its state\'s body, priority and tags; a part still on the part before it and a job without builds_on keep their titles; brief sends ntfy the title and the workspace', async () => {
  const onBase = { builds_on: 'T-0', builds_on_commit: null };
  const onPart = { builds_on: 'T-0', builds_on_commit: 'a'.repeat(40) };
  const handedOver = jobNotification(job('handed_over', onBase));
  const review = jobNotification(job('ready_for_human_review', onBase));
  assert.deepEqual(handedOver, { ...jobNotification(job('handed_over')), title: 'T-1: ready to submit' });
  assert.deepEqual(review, { ...jobNotification(job('ready_for_human_review')), title: 'T-1: ready to submit' });
  assert.deepEqual([handedOver.body, handedOver.priority, handedOver.tags], ['in your checkout on T-1-secret-branch', 'high', 'eyes']);
  assert.deepEqual([review.body, review.priority, review.tags], ['branch: T-1-secret-branch', 'high', 'eyes']);
  for (const extra of [onPart, {}]) {
    assert.equal(jobNotification(job('handed_over', extra)).title, 'T-1: in your checkout');
    assert.equal(jobNotification(job('ready_for_human_review', extra)).title, 'T-1: ready_for_human_review');
  }
  // Only a part waiting for the user: another state of a part on its base keeps its title.
  assert.equal(jobNotification(job('needs_human', onBase)).title, 'T-1: needs_human');
  assert.equal(jobNotification(job('pushed', onBase)).title, 'T-1: pushed');

  const { sent, send } = recorder();
  const notify = stateNotifier(CONFIG, NO_EVENTS, async () => 'brief', send);
  await notify(job('ready_for_human_review', onBase), 'preparing_mr');
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0]!.title, sent[0]!.ntfyBody], ['T-1: ready to submit', 'app']);
});

const SKILL = { path: 'skill', sha256: 'f'.repeat(64), files: 1 };
const reviewed = (count: number): LastReviewRecord => ({
  reviewer: 'last_review', summary: 'Fine.', comments: Array.from({ length: count }, (_, index) => ({ id: `C${index + 1}`, path: 'src/a.ts', line: index + 1, text: 'Secret comment', kind: 'change' as const })),
  dropped: 0, skill: SKILL, cost_usd: 0.1, model: 'opus', started_at: CREATED, ended_at: CREATED,
});
const FAILED: LastReviewRecord = { reviewer: 'last_review', error: 'The session ended: /home/me/app', timed_out: false, skill: null, started_at: CREATED, ended_at: CREATED };

// A store whose iterations hold the given last reviews; a record of 'unreadable' fails to read.
function reviews(records: Record<number, LastReviewRecord | 'unreadable'>, reads: number[] = []) {
  return {
    appendEvent: async (): Promise<void> => undefined,
    readLastReview: async (_workspace: string, _ticket: string, number: number): Promise<LastReviewRecord | undefined> => {
      reads.push(number);
      const record = records[number];
      if (record === 'unreadable') {
        throw new SyntaxError('Unexpected token');
      }
      return record;
    },
  };
}

test('lastReviewNote: the count of comments, one comment, a failure, nothing without a record', () => {
  assert.equal(lastReviewNote(reviewed(3)), 'last review: 3 comments');
  assert.equal(lastReviewNote(reviewed(1)), 'last review: 1 comment');
  assert.equal(lastReviewNote(reviewed(0)), 'last review: 0 comments');
  assert.equal(lastReviewNote(FAILED), 'last review failed');
  assert.equal(lastReviewNote(undefined), undefined);
});

test('stateNotifier (LR5-4): handed_over and ready_for_human_review end their first line with the iteration\'s last review, keeping three lines; without a record, unreadable or in another state the body is as before; brief ntfy stays the brief one; off reads and sends nothing', async () => {
  const lines = ['feat(T-1): Title', '2 files changed', 'a fourth line'];
  const reads: number[] = [];
  const { sent, send } = recorder();
  const notify = stateNotifier(CONFIG, reviews({ 2: reviewed(3), 3: FAILED, 5: 'unreadable', 6: reviewed(1) }, reads), async (workspace) => (workspace === 'brief' ? 'brief' : workspace === 'quiet' ? 'off' : 'full'), send);
  // Off: nothing sent, and the record is not read.
  await notify(job('handed_over', { workspace: 'quiet', iteration: 7 }), 'preparing_mr', lines);
  await notify(job('handed_over'), 'preparing_mr', lines);
  await notify(job('ready_for_human_review', { iteration: 3 }), 'preparing_mr', lines);
  await notify(job('handed_over', { iteration: 4 }), 'preparing_mr', lines);
  await notify(job('handed_over', { iteration: 5 }), 'preparing_mr', lines);
  await notify(job('needs_human', { iteration: 6 }), 'working');
  await notify(job('handed_over', { workspace: 'brief', iteration: 6 }), 'preparing_mr', lines);
  assert.deepEqual(reads, [2, 3, 4, 5, 6]);
  assert.deepEqual(sent.map((note) => note.body.split('\n')), [
    [`in your checkout on ${BRANCH} · last review: 3 comments`, 'feat(T-1): Title', '2 files changed'],
    [`branch: ${BRANCH} · last review failed`, 'feat(T-1): Title', '2 files changed'],
    jobNotification(job('handed_over'), lines).body.split('\n'),
    jobNotification(job('handed_over'), lines).body.split('\n'),
    jobNotification(job('needs_human', { iteration: 6 })).body.split('\n'),
    [`in your checkout on ${BRANCH} · last review: 1 comment`, 'feat(T-1): Title', '2 files changed'],
  ]);
  // Neither the comments' text nor the error goes out.
  for (const note of sent) {
    assert.equal(note.body.includes('Secret comment') || note.body.includes('/home/me'), false);
  }
  assert.equal(sent[5]!.ntfyBody, 'brief');
  assert.equal(sent.slice(0, 5).every((note) => note.ntfyBody === undefined), true);
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

test("PW-4: ntfy sends Click for a notification with a click (a planner's session page), and no Click otherwise", async () => {
  const config = { ...CONFIG, desktop: false, ntfyUrl };
  received.length = 0;
  await sendNotification(plannerNotification('app', false, 'session_01Ab'), config);
  await sendNotification(plannerNotification('app', true, undefined), config);
  await sendNotification(digestNotification({ landed: 1, impact: 0 }), config);
  assert.deepEqual(received.map((entry) => [entry.headers.title, entry.headers.priority, entry.headers.tags, entry.headers.click, entry.body]), [
    ['Planner waits for you', 'high', 'speech_balloon', 'https://claude.ai/code/session_01Ab', 'app'],
    ['Planner waits for a permission', 'high', 'speech_balloon', undefined, 'app'],
    ['Morning digest ready', 'default', 'newspaper', undefined, 'Morning digest ready: 1 landed, 0 of mine need attention'],
  ]);
});

test('plannerNotification links the session only for an id of letters, digits, _ and -, at most 128 long', () => {
  assert.equal(plannerNotification('app', false, 'session_01Ab').click, 'https://claude.ai/code/session_01Ab');
  assert.equal(plannerNotification('app', false, 'a'.repeat(128)).click, `https://claude.ai/code/${'a'.repeat(128)}`);
  for (const id of [undefined, '', 'a'.repeat(129), '../x', 'id?x=1', 'a b', 'a/b']) {
    assert.equal('click' in plannerNotification('app', false, id), false, String(id));
  }
});
