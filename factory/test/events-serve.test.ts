// End-to-end tests of MCP Events: the real `sf serve` with OAuth against the test authorization
// server (test/support/fake-as.ts), callbacks on the loopback webhook sink
// (test/support/webhook-sink.ts, allowed by SF_EVENTS_ALLOW_LOOPBACK=on), the fake Implementer
// cycle and `sf events`.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AUDIENCE, type FakeAs, startFakeAs } from './support/fake-as.js';
import { call, type Env, newEnv, newRepo, putTask, runCli, script, serve, type Served, stop, waitFor } from './support/harness.js';
import { startWebhookSink, type WebhookSink } from './support/webhook-sink.js';

let as: FakeAs;
let sink: WebhookSink;

before(async () => {
  as = await startFakeAs();
  sink = await startWebhookSink();
});

after(async () => {
  await sink.close();
  await as.close();
});

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
const ADD = ['git', 'add', '-A'];
const REBASE = ['git', ...ID, 'rebase', '-q', 'origin/main'];
const commit = (message: string): string[] => ['git', ...ID, 'commit', '-q', '-m', message];

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'npm test: passed', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

function eventsEnv(name: string, extra: Record<string, string> = {}): Promise<Env> {
  return newEnv(name, { SF_AUTH_ISSUER: as.issuer, SF_AUTH_AUDIENCE: AUDIENCE, SF_EVENTS_ALLOW_LOOPBACK: 'on', ...extra });
}

interface RpcAnswer {
  status: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

let rpcId = 0;

// One JSON-RPC request; the answer is JSON or one server-sent event.
async function rpc(url: URL, method: string, params: unknown, token?: string): Promise<RpcAnswer> {
  rpcId += 1;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, ...(params !== undefined ? { params } : {}) }),
  });
  const text = await response.text();
  if (response.status !== 200) {
    return { status: response.status };
  }
  const data = text.startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '{}');
  const message = JSON.parse(data) as { result?: unknown; error?: RpcAnswer['error'] };
  return { status: response.status, ...(message.result !== undefined ? { result: message.result } : {}), ...(message.error !== undefined ? { error: message.error } : {}) };
}

async function authedClient(served: Served, token: string): Promise<Served> {
  const client = new Client({ name: 'sf-016-events', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(served.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return { ...served, client };
}

async function jobEvents(env: Env, ticket: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(env.state, 'jobs', 'app', ticket, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

async function until(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      assert.fail('timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const initialize = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.0' } };

test('events: capability, list, subscribe checks, the fake cycle delivered and signed, filters, unsubscribe and sf events', async () => {
  const env = await eventsEnv('events-cycle');
  const repo = await newRepo(env, 'events-repo', true);
  await putTask(env, repo, 'EV-1', 'Events demo');
  await script(env, [
    { write: { 'README.md': 'hello events\n' }, text: '# Report: EV-1, iteration 1\n\n## Done\nChanged the README.' },
    { write: { '.software-factory/EV-1.mr.md': mrText('feat(EV-1): Change the README') }, run: [ADD, commit('feat(EV-1): Change the README'), REBASE], text: 'Prepared.' },
  ]);
  const served = await serve(env);
  const token = as.sign(as.claims());
  const otherToken = as.sign(as.claims({ sub: 'auth0|user-2' }));
  try {
    // initialize is open and advertises events.
    const init = await rpc(served.url, 'initialize', initialize);
    assert.deepEqual(init.result.capabilities.events, {});
    // events/list needs a token; with one it returns the catalogue on one page.
    assert.equal((await rpc(served.url, 'events/list', {})).status, 401);
    const listed = await rpc(served.url, 'events/list', {}, token);
    assert.equal(listed.result.nextCursor, undefined);
    assert.deepEqual(listed.result.events.map((event: { name: string; delivery: string[] }) => [event.name, event.delivery]), [['software_factory.job', ['webhook']]]);
    assert.deepEqual(Object.keys(listed.result.events[0].inputSchema.properties), ['workspace', 'ticket']);
    assert.deepEqual(listed.result.events[0].payloadSchema.required, ['workspace', 'ticket', 'state', 'iteration', 'branch']);
    assert.equal((await rpc(served.url, 'events/subscribe', {}, undefined)).status, 401);

    const subscribe = (path: string, args: Record<string, unknown>, secret = sink.secret, url = sink.url(path)) =>
      rpc(served.url, 'events/subscribe', { name: 'software_factory.job', arguments: args, delivery: { mode: 'webhook', url, secret }, cursor: null }, token);
    const badUrl = await subscribe('/a', {}, sink.secret, 'https://10.0.0.1/hook');
    assert.deepEqual([badUrl.error?.code, badUrl.error?.data], [-32015, { reason: 'invalid_url' }]);
    const badSecret = await subscribe('/a', {}, 'whsec_c2hvcnQ=');
    assert.deepEqual([badSecret.error?.code, badSecret.error?.data], [-32602, { reason: 'invalid_secret' }]);
    sink.plan.push('wrong_challenge');
    const failed = await subscribe('/a', { workspace: 'app' });
    assert.deepEqual([failed.error?.code, failed.error?.data], [-32015, { reason: 'challenge_failed' }]);

    const subscribed = await subscribe('/a', { workspace: 'app' });
    assert.equal(subscribed.error, undefined, JSON.stringify(subscribed.error));
    const subA = subscribed.result.id as string;
    assert.match(subA, /^sub_/);
    assert.deepEqual([subscribed.result.cursor, subscribed.result.truncated, subscribed.result.ttlMs], [null, false, 7 * 24 * 3600 * 1000]);
    assert.ok(Math.abs(Date.parse(subscribed.result.refreshBefore) - Date.now() - 7 * 24 * 3600 * 1000) < 60_000);
    const verifications = await sink.waitFor('/a', 2);
    const verification = verifications[1]!;
    assert.equal(verification.json.type, 'verification');
    assert.equal(Buffer.from(verification.json.challenge, 'base64url').length, 32);
    assert.match(String(verification.headers['webhook-id']), /^msg_verification_/);
    assert.equal(verification.headers['x-mcp-subscription-id'], subA);
    assert.equal(verification.signatureValid, true);
    // The same identity again: the same id, no new challenge.
    const again = await subscribe('/a', { workspace: 'app' });
    assert.equal(again.result.id, subA);
    assert.equal(sink.requests.filter((request) => request.path === '/a').length, 2);
    // A filter on another ticket.
    const subB = (await subscribe('/b', { ticket: 'OTHER-1' })).result.id as string;

    // The cycle: awaiting_review, ready_for_human_review, pushed.
    const authed = await authedClient(served, token);
    await call(authed, 'start', { workspace: 'app', ticket: 'EV-1' });
    await waitFor(authed, 'EV-1', 'awaiting_review', 1);
    await call(authed, 'mark_clean', { workspace: 'app', ticket: 'EV-1' });
    const approved = await runCli(env, ['approve', 'app', 'EV-1']);
    assert.equal(approved.code, 0, approved.stdout + approved.stderr);
    const deliveries = (await sink.waitFor('/a', 5)).slice(2);
    assert.deepEqual(deliveries.map((request) => request.json.data.state), ['awaiting_review', 'ready_for_human_review', 'pushed']);
    for (const request of deliveries) {
      assert.equal(request.signatureValid, true);
      assert.equal(request.headers['x-mcp-subscription-id'], subA);
      assert.equal(request.headers['webhook-id'], request.json.eventId);
      assert.equal(request.headers['content-type'], 'application/json');
      assert.match(String(request.headers['webhook-timestamp']), /^\d+$/);
      assert.deepEqual(Object.keys(request.json), ['eventId', 'name', 'timestamp', 'data', 'cursor']);
      assert.equal(request.json.name, 'software_factory.job');
      assert.equal(request.json.cursor, null);
      assert.match(request.json.timestamp, /^\d{4}-\d\d-\d\dT.*Z$/);
    }
    assert.deepEqual(deliveries[0]!.json.data, { workspace: 'app', ticket: 'EV-1', state: 'awaiting_review', iteration: 1, branch: 'EV-1-events-demo' });
    assert.deepEqual(deliveries[2]!.json.data.mr, { title: 'feat(EV-1): Change the README' });
    assert.equal(new Set(deliveries.map((request) => request.json.eventId)).size, 3);
    // The ticket filter of subB matched nothing.
    assert.equal(sink.requests.filter((request) => request.path === '/b').length, 1);
    await until(async () => (await jobEvents(env, 'EV-1')).filter((record) => record.type === 'event_delivered').length === 3);
    const watched = await runCli(env, ['watch', 'app', 'EV-1', '--once']);
    assert.match(watched.stdout, new RegExp(`\\[1\\] event to ${subA} attempt 1 delivered: 200$`, 'm'));

    // Unsubscribe: another principal is refused; the owner, by the subscribe identity, succeeds.
    const refused = await rpc(served.url, 'events/unsubscribe', { id: subB }, otherToken);
    assert.deepEqual([refused.error?.code, refused.error?.data], [-32000, { reason: 'forbidden' }]);
    const unsubscribed = await rpc(served.url, 'events/unsubscribe', { name: 'software_factory.job', arguments: { ticket: 'OTHER-1' }, delivery: { mode: 'webhook', url: sink.url('/b') } }, token);
    assert.deepEqual(unsubscribed.result, {});
    // Idempotent.
    assert.deepEqual((await rpc(served.url, 'events/unsubscribe', { id: subB }, token)).result, {});

    // sf events list, test and remove.
    const list = await runCli(env, ['events', 'list']);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /^ID\s+PRINCIPAL\s+EVENT\s+INPUT\s+HOST\s+CREATED\s+REFRESH_BEFORE$/m);
    assert.match(list.stdout, new RegExp(`^${subA}\\s+auth0\\|user-1\\s+software_factory\\.job\\s+\\{"workspace":"app"\\}\\s+127\\.0\\.0\\.1:\\d+\\s`, 'm'));
    assert.doesNotMatch(list.stdout, new RegExp(subB));
    assert.ok(!list.stdout.includes(sink.secret.slice(6)));
    const tested = await runCli(env, ['events', 'test', subA]);
    assert.equal(tested.code, 0, tested.stdout + tested.stderr);
    assert.match(tested.stdout, /^delivered: true$/m);
    assert.match(tested.stdout, /^status: 200$/m);
    const testRequest = (await sink.waitFor('/a', 6))[5]!;
    assert.equal(testRequest.json.data.state, 'test');
    assert.equal(testRequest.signatureValid, true);
    sink.plan.push(500);
    const testFailed = await runCli(env, ['events', 'test', subA]);
    assert.equal(testFailed.code, 1);
    assert.match(testFailed.stdout, /^status: 500$/m);
    const removed = await runCli(env, ['events', 'remove', subA]);
    assert.equal(removed.code, 0, removed.stderr);
    assert.match((await runCli(env, ['events', 'list'])).stdout, /^No subscriptions\.$/m);
    const missing = await runCli(env, ['events', 'remove', subA]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /There is no subscription/);
    assert.equal((await runCli(env, ['events', 'frobnicate'])).code, 2);
    await authed.client.close();
  } finally {
    await stop(served);
  }
});

test('events: a delivery pending at a restart of sf serve is resumed with the same event id', async () => {
  const env = await eventsEnv('events-restart');
  const repo = await newRepo(env, 'events-restart-repo', true);
  await putTask(env, repo, 'RS-1', 'Restart demo');
  await script(env, [{ write: { 'README.md': 'hello restart\n' }, text: '# Report: RS-1, iteration 1\n\n## Done\nChanged the README.' }]);
  const token = as.sign(as.claims());
  let served = await serve(env);
  let subscription: string;
  try {
    const answer = await rpc(served.url, 'events/subscribe', {
      name: 'software_factory.job', arguments: { ticket: 'RS-1' }, delivery: { mode: 'webhook', url: sink.url('/restart'), secret: sink.secret },
    }, token);
    subscription = answer.result.id;
    sink.plan.push(500);
    const authed = await authedClient(served, token);
    await call(authed, 'start', { workspace: 'app', ticket: 'RS-1' });
    await waitFor(authed, 'RS-1', 'awaiting_review', 1);
    await sink.waitFor('/restart', 2);
    await until(async () => (await jobEvents(env, 'RS-1')).some((record) => record.type === 'event_failed'));
    await authed.client.close();
  } finally {
    await stop(served);
  }
  const queued = JSON.parse(await readFile(join(env.state, 'events-queue.json'), 'utf8')) as { deliveries: Array<{ eventId: string; attempt: number }> };
  assert.deepEqual(queued.deliveries.map((entry) => entry.attempt), [1]);
  served = await serve(env);
  try {
    const [, first, second] = await sink.waitFor('/restart', 3, 15_000);
    assert.equal(second!.headers['webhook-id'], first!.headers['webhook-id']);
    assert.equal(second!.headers['webhook-id'], queued.deliveries[0]!.eventId);
    assert.equal(second!.body, first!.body);
    assert.equal(second!.signatureValid, true);
    assert.equal(second!.headers['x-mcp-subscription-id'], subscription!);
    await until(async () => (await jobEvents(env, 'RS-1')).some((record) => record.type === 'event_delivered'));
    const outcomes = (await jobEvents(env, 'RS-1')).filter((record) => typeof record.type === 'string' && String(record.type).startsWith('event_'));
    assert.deepEqual(outcomes.map(({ type, attempt, status }) => [type, attempt, status]), [['event_failed', 1, 500], ['event_delivered', 2, 200]]);
    assert.deepEqual(JSON.parse(await readFile(join(env.state, 'events-queue.json'), 'utf8')), { deliveries: [] });
  } finally {
    await stop(served);
  }
});

test('events without OAuth are refused as unauthenticated; SF_AUTH_OPEN_METHODS cannot open them', async () => {
  const env = await newEnv('events-auth-off');
  await newRepo(env, 'events-off-repo', false);
  const served = await serve(env);
  try {
    const init = await rpc(served.url, 'initialize', initialize);
    assert.deepEqual(init.result.capabilities.events, {});
    const listed = await rpc(served.url, 'events/list', {});
    assert.deepEqual([listed.error?.code, listed.error?.data], [-32000, { reason: 'unauthenticated' }]);
  } finally {
    await stop(served);
  }
  const open = await eventsEnv('events-open', { SF_AUTH_OPEN_METHODS: 'initialize,events/list' });
  const result = await runCli(open, ['serve']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /must not contain the event method "events\/list"/);
});
