// Unit tests of src/events.ts: Standard Webhooks signing, the secret format, the callback URL and
// address checks, the retry schedule and the delivery rules, and the hub in process against the
// loopback webhook sink (test/support/webhook-sink.ts).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  BACKOFF_MS,
  canonicalJson,
  decodeSecret,
  envelope,
  Events,
  EventsError,
  isPublicAddress,
  postJson,
  retryDelay,
  signatureHeader,
  signPayload,
  subscriptionId,
  ticketInstruction,
  validateCallbackUrl,
  verdictOf,
} from '../src/events.js';
import { type Job, JobStore } from '../src/jobs.js';
import { startWebhookSink, type WebhookSink } from './support/webhook-sink.js';

let temp: string;
let sink: WebhookSink;

before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sf-events-'));
  sink = await startWebhookSink();
});

after(async () => {
  await sink.close();
  await rm(temp, { recursive: true, force: true });
});

test('signPayload matches the Standard Webhooks reference vector', () => {
  const key = decodeSecret('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');
  assert.ok(key !== undefined);
  assert.equal(signPayload(key, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}'), 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  const other = Buffer.alloc(32, 7);
  const both = signatureHeader([key, other], 'msg_1', 1, 'x');
  assert.equal(both, `${signPayload(key, 'msg_1', 1, 'x')} ${signPayload(other, 'msg_1', 1, 'x')}`);
});

test('decodeSecret accepts whsec_ with 24 to 64 bytes of canonical base64 only', () => {
  const secret = (bytes: number): string => `whsec_${Buffer.alloc(bytes, 1).toString('base64')}`;
  assert.equal(decodeSecret(secret(24))?.length, 24);
  assert.equal(decodeSecret(secret(64))?.length, 64);
  assert.equal(decodeSecret(secret(23)), undefined);
  assert.equal(decodeSecret(secret(65)), undefined);
  assert.equal(decodeSecret(Buffer.alloc(32, 1).toString('base64')), undefined);
  assert.equal(decodeSecret('whsec_not base64!'), undefined);
  // base64url, unpadded, and a non-canonical last character.
  assert.equal(decodeSecret(`whsec_${Buffer.alloc(32, 0xfb).toString('base64url')}`), undefined);
  assert.equal(decodeSecret(`whsec_${Buffer.alloc(32, 1).toString('base64').slice(0, -2)}B=`), undefined);
});

test('validateCallbackUrl: https, no userinfo, no non-public literals or localhost; loopback only when allowed', () => {
  assert.equal(validateCallbackUrl('https://receiver.example.com/mcp-events/cb_1', false).host, 'receiver.example.com');
  assert.equal(validateCallbackUrl('https://8.8.8.8/hook', false).hostname, '8.8.8.8');
  const refused = [
    'http://receiver.example.com/hook',
    'ftp://receiver.example.com/hook',
    'https://user:pw@receiver.example.com/hook',
    'https://127.0.0.1/hook',
    'https://10.1.2.3/hook',
    'https://172.16.0.1/hook',
    'https://192.168.1.1/hook',
    'https://169.254.169.254/latest',
    'https://100.64.0.1/hook',
    'https://0.0.0.0/hook',
    'https://[::1]/hook',
    'https://[fe80::1]/hook',
    'https://[fd00::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
    'https://localhost/hook',
    'https://a.localhost/hook',
    'not a url',
    `https://receiver.example.com/${'a'.repeat(2048)}`,
  ];
  for (const raw of refused) {
    assert.throws(() => validateCallbackUrl(raw, false), (error: unknown) => error instanceof EventsError && error.code === -32015 && error.reason === 'invalid_url', raw);
  }
  assert.equal(validateCallbackUrl('http://127.0.0.1:9/hook', true).port, '9');
  assert.equal(validateCallbackUrl('http://localhost:9/hook', true).hostname, 'localhost');
  assert.throws(() => validateCallbackUrl('https://10.1.2.3/hook', true), EventsError);
  assert.throws(() => validateCallbackUrl('http://receiver.example.com/hook', true), EventsError);
});

test('ticketInstruction makes the event-triggered task review and act in the same run', () => {
  const instruction = ticketInstruction('app', 'T-1');
  assert.match(instruction, /arguments \{"workspace": "app", "ticket": "T-1"\}, nothing else/);
  assert.match(instruction, /give the task this whole instruction word for word/);
  assert.match(instruction, /on awaiting_review review the Report and the Patch in that same run and end it with request_fix or mark_clean, without waiting for me;/);
  assert.match(instruction, /on needs_human, pushed, aborted or failed only summarise the state\.$/);
});

test('isPublicAddress', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of ['127.0.0.1', '10.0.0.1', '192.168.0.1', '172.31.255.255', '169.254.1.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:8.8.8.8', '2001:db8::1', 'example.com']) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test('the retry schedule and the delivery rules', () => {
  assert.deepEqual(BACKOFF_MS, [5_000, 30_000, 120_000, 600_000, 3_600_000]);
  assert.deepEqual([1, 2, 3, 4, 5].map((attempts) => retryDelay(attempts)), [5_000, 30_000, 120_000, 600_000, 3_600_000]);
  assert.equal(retryDelay(6), undefined);
  assert.equal(retryDelay(0), undefined);
  const response = (status: number) => ({ kind: 'response' as const, status, body: '' });
  assert.deepEqual([200, 204, 302, 400, 404, 410, 413, 429, 500, 503].map((status) => verdictOf(response(status))), [
    'delivered', 'delivered', 'rejected', 'rejected', 'rejected', 'gone', 'too_large', 'rejected', 'retry', 'retry',
  ]);
  assert.equal(verdictOf({ kind: 'error', reason: 'timeout' }), 'retry');
  assert.equal(verdictOf({ kind: 'error', reason: 'connection_failed' }), 'retry');
  assert.equal(verdictOf({ kind: 'error', reason: 'blocked_address' }), 'rejected');
});

test('canonical arguments: the subscription id does not depend on key order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  const one = subscriptionId('p', 'https://x.example/h', 'software_factory.job', { workspace: 'app', ticket: 'T-1' });
  const two = subscriptionId('p', 'https://x.example/h', 'software_factory.job', { ticket: 'T-1', workspace: 'app' });
  assert.equal(one, two);
  assert.match(one, /^sub_[A-Za-z0-9_-]{32}$/);
  assert.notEqual(one, subscriptionId('q', 'https://x.example/h', 'software_factory.job', { workspace: 'app', ticket: 'T-1' }));
  assert.equal(JSON.parse(envelope('evt_1', '2026-11-02T10:00:00.000Z', { workspace: 'app', ticket: 'T-1', state: 'pushed', iteration: 1, branch: 'b' })).cursor, null);
});

test('postJson: the lookup refuses a host resolving to loopback; redirects are not followed', async () => {
  const url = new URL(sink.url('/redirect').replace('127.0.0.1', 'localhost'));
  assert.deepEqual(await postJson(url, '{}', {}, 2_000, false), { kind: 'error', reason: 'blocked_address' });
  assert.deepEqual(await postJson(new URL(sink.url('/literal')), '{}', {}, 2_000, false), { kind: 'error', reason: 'blocked_address' });
  sink.plan.push(302);
  const redirected = await postJson(new URL(sink.url('/redirect')), '{}', {}, 2_000, true);
  assert.equal(redirected.kind === 'response' && redirected.status, 302);
  assert.equal(sink.requests.filter((request) => request.path === '/elsewhere').length, 0);
});

function job(ticket: string, state: Job['state'], iteration = 1): Job {
  const at = new Date().toISOString();
  return {
    workspace: 'app', ticket, branch: `${ticket}-branch`, base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null, mr_attempts: 0, fixes: 0, gate_fixes: 0, gate_tokens: 0,
    state, iteration, session_id: null, created_at: at, updated_at: at,
  };
}

async function eventLog(jobs: JobStore, ticket: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(jobs.eventsPath('app', ticket), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((record) => typeof record.type === 'string');
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      assert.fail('timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const delivery = (path: string) => ({ mode: 'webhook', url: sink.url(path), secret: sink.secret });

test('hub: verification timeout and failure, limits, refresh, retries, 410, 413 and the 0600 store', async () => {
  const state = join(temp, 'hub');
  const jobs = new JobStore(state);
  const events = await Events.open(state, jobs, { allowLoopback: true, requestTimeoutMs: 300, backoffMs: [50, 50] });
  try {
    await assert.rejects(events.subscribe(undefined, { name: 'software_factory.job', delivery: delivery('/x') }), { code: -32000, reason: 'unauthenticated' });
    await assert.rejects(events.subscribe('p1', { name: 'other.event', delivery: delivery('/x') }), { code: -32602, reason: 'unknown_event' });
    await assert.rejects(events.subscribe('p1', { name: 'software_factory.job', arguments: { project: 'x' }, delivery: delivery('/x') }), { code: -32602, reason: 'invalid_arguments' });
    sink.plan.push('hang');
    await assert.rejects(events.subscribe('p1', { name: 'software_factory.job', delivery: delivery('/hang') }), { code: -32015, reason: 'timeout' });
    sink.plan.push(500);
    await assert.rejects(events.subscribe('p1', { name: 'software_factory.job', delivery: delivery('/500') }), { code: -32015, reason: 'challenge_failed' });

    // Eight per principal; a refresh of an existing one is not a new one.
    const ids: string[] = [];
    for (let index = 1; index <= 8; index += 1) {
      ids.push((await events.subscribe('p1', { name: 'software_factory.job', arguments: { ticket: `L-${index}` }, delivery: delivery('/limit') })).id);
    }
    await assert.rejects(events.subscribe('p1', { name: 'software_factory.job', arguments: { ticket: 'L-9' }, delivery: delivery('/limit') }), { code: -32000, reason: 'subscription_limit' });
    const verifications = sink.requests.length;
    const refreshed = await events.subscribe('p1', { name: 'software_factory.job', arguments: { ticket: 'L-1' }, delivery: delivery('/limit'), ttlMs: 1_000 });
    assert.equal(refreshed.id, ids[0]);
    // A minimum lifetime of a minute; the verification is cached.
    assert.equal(refreshed.ttlMs, 60_000);
    assert.equal(sink.requests.length, verifications);
    for (const id of ids) {
      await events.remove(id);
    }
    assert.equal((await stat(join(state, 'subscriptions.json'))).mode & 0o777, 0o600);

    // 500 twice, then delivered on the third attempt.
    const retried = await events.subscribe('p1', { name: 'software_factory.job', arguments: { ticket: 'R-1' }, delivery: delivery('/retry') });
    await jobs.write(job('R-1', 'awaiting_review'));
    sink.plan.push(500, 500);
    events.onStateChange(job('R-1', 'awaiting_review'), 'working');
    // A working state never fires.
    events.onStateChange(job('R-1', 'working'), 'awaiting_review');
    const attempts = await sink.waitFor('/retry', 4);
    const sent = attempts.slice(1);
    assert.deepEqual(sent.map((request) => request.answer), [500, 500, 200]);
    assert.ok(sent.every((request) => request.signatureValid && request.headers['webhook-id'] === sent[0]!.json.eventId && request.headers['x-mcp-subscription-id'] === retried.id));
    assert.ok(sent.every((request) => request.body === sent[0]!.body));
    await until(async () => (await eventLog(jobs, 'R-1')).length === 3);
    assert.deepEqual((await eventLog(jobs, 'R-1')).map(({ type, subscription, attempt, status }) => ({ type, subscription, attempt, status })), [
      { type: 'event_failed', subscription: retried.id, attempt: 1, status: 500 },
      { type: 'event_failed', subscription: retried.id, attempt: 2, status: 500 },
      { type: 'event_delivered', subscription: retried.id, attempt: 3, status: 200 },
    ]);
    assert.deepEqual(JSON.parse(await readFile(join(state, 'events-queue.json'), 'utf8')), { deliveries: [] });

    // 413 drops the event, the subscription stays; 410 ends the subscription.
    await jobs.write(job('G-1', 'needs_human'));
    const gone = await events.subscribe('p1', { name: 'software_factory.job', arguments: { ticket: 'G-1' }, delivery: delivery('/gone') });
    sink.plan.push(413);
    events.onStateChange(job('G-1', 'needs_human'), 'working');
    await sink.waitFor('/gone', 2);
    await until(async () => (await eventLog(jobs, 'G-1')).length === 1);
    assert.ok(events.subscriptions().some((subscription) => subscription.id === gone.id));
    sink.plan.push(410);
    events.onStateChange(job('G-1', 'failed'), 'needs_human');
    await sink.waitFor('/gone', 3);
    await until(() => !events.subscriptions().some((subscription) => subscription.id === gone.id));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sink.requests.filter((request) => request.path === '/gone').length, 3);
    assert.deepEqual((await eventLog(jobs, 'G-1')).map(({ attempt, status }) => [attempt, status]), [[1, 413], [1, 410]]);
  } finally {
    events.close();
  }
});

test('hub: a nudge sends the awaiting_review event again to every subscription of the job, once while one is on its way', async () => {
  const state = join(temp, 'nudge');
  const jobs = new JobStore(state);
  const events = await Events.open(state, jobs, { allowLoopback: true, requestTimeoutMs: 300, backoffMs: [50, 50] });
  try {
    const own = await events.subscribe('p1', { name: 'software_factory.job', arguments: { workspace: 'app', ticket: 'N-1' }, delivery: delivery('/nudge') });
    const broad = await events.subscribe('p1', { name: 'software_factory.job', arguments: { workspace: 'app' }, delivery: delivery('/nudge-broad') });
    const waiting = { ...job('N-1', 'awaiting_review', 2), updated_at: '2026-11-01T10:00:00.000Z' };
    await jobs.write(waiting);

    // Only a job waiting for review; only a job someone receives.
    await assert.rejects(events.nudge(job('N-1', 'working', 2)), { code: 'invalid_state' });
    await assert.rejects(events.nudge({ ...job('N-9', 'awaiting_review'), workspace: 'other' }), { code: 'no_subscription' });

    const before = Date.now();
    assert.deepEqual(await events.nudge(waiting), { queued: [own.id, broad.id], pending: [] });
    const [first] = (await sink.waitFor('/nudge', 2)).slice(1);
    const [second] = (await sink.waitFor('/nudge-broad', 2)).slice(1);
    for (const request of [first!, second!]) {
      assert.ok(request.signatureValid);
      assert.equal(request.json.name, 'software_factory.job');
      assert.deepEqual(request.json.data, { workspace: 'app', ticket: 'N-1', state: 'awaiting_review', iteration: 2, branch: 'N-1-branch' });
      // The time of the nudge, not of the state change.
      assert.ok(Date.parse(request.json.timestamp) >= before - 1000);
    }
    assert.notEqual(first!.json.eventId, second!.json.eventId);
    await until(async () => (await eventLog(jobs, 'N-1')).length === 2);
    assert.deepEqual((await eventLog(jobs, 'N-1')).map(({ type, attempt, status }) => [type, attempt, status]), [['event_delivered', 1, 200], ['event_delivered', 1, 200]]);

    // While a delivery is on its way, a second nudge adds nothing for that subscription.
    await events.remove(broad.id);
    sink.plan.push('hang');
    assert.deepEqual(await events.nudge(waiting), { queued: [own.id], pending: [] });
    assert.deepEqual(await events.nudge(waiting), { queued: [], pending: [own.id] });
    await until(async () => (await eventLog(jobs, 'N-1')).filter((record) => record.type === 'event_delivered').length === 3);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sink.requests.filter((request) => request.path === '/nudge').length, 4);
  } finally {
    events.close();
  }
});

test('hub: onChange hears every change of the subscriptions (subscribe, refresh, unsubscribe, remove, a 410), until stopped', async () => {
  const state = join(temp, 'hub-change');
  const events = await Events.open(state, new JobStore(state), { allowLoopback: true, requestTimeoutMs: 300 });
  let changes = 0;
  const stop = events.onChange(() => {
    changes += 1;
  });
  try {
    const first = await events.subscribe('p1', { name: 'software_factory.job', arguments: { ticket: 'C-1' }, delivery: delivery('/change') });
    assert.equal(changes, 1);
    await events.subscribe('p1', { name: 'software_factory.job', arguments: { ticket: 'C-1' }, delivery: delivery('/change') });
    assert.equal(changes, 2);
    await events.unsubscribe('p1', { id: first.id });
    assert.equal(changes, 3);
    // Unsubscribing an unknown subscription changes nothing.
    await events.unsubscribe('p1', { id: first.id });
    assert.equal(changes, 3);
    const second = await events.subscribe('p1', { name: 'software_factory.job', arguments: { ticket: 'C-2' }, delivery: delivery('/change') });
    await events.remove(second.id);
    assert.equal(changes, 5);
    const third = await events.subscribe('p1', { name: 'software_factory.job', arguments: { ticket: 'C-3' }, delivery: delivery('/change') });
    sink.plan.push(200);
    await events.test(third.id);
    assert.equal(changes, 6);
    sink.plan.push(410);
    assert.deepEqual(await events.test(third.id), { subscription: third.id, delivered: false, status: 410 });
    assert.equal(changes, 7);
    stop();
    await events.subscribe('p1', { name: 'software_factory.job', arguments: { ticket: 'C-4' }, delivery: delivery('/change') });
    assert.equal(changes, 7);
  } finally {
    events.close();
  }
});
