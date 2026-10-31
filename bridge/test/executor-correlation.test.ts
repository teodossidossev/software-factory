// SF-009 Review 03, R3-1: a result that arrives before the acknowledgment of the review it might
// answer never hangs the session. The correlation stays unresolved until a result arrives after
// that acknowledgment; while unresolved, Claude Code must keep showing progress (or a background
// task, or a process of the session) within correlationIdleMs, and the whole state is bounded by
// correlationTimeoutMs. Otherwise the session ends fail-closed (turn_correlation_unresolved) and
// the gate is released. A late acknowledgment never makes the early result the review's answer.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, test } from 'node:test';
import { SessionGate } from '../src/execution/session-gate.js';
import { StreamSession } from '../src/executor/stream-session.js';
import type { SupervisorOptions } from '../src/executor/supervisor.js';
import { acceptedJob, destroyFixture, gatePath, invocations, jobDir, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, messages, setStreamMode, startSupervisor, waitFor } from './support/executor-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

// ---- the real StreamSession over in-memory pipes ----

function fakeSession(): { stream: StreamSession; emit: (event: object) => void; flush: () => Promise<void>; sent: string[] } {
  const output = new PassThrough();
  const input = new PassThrough();
  const sent: string[] = [];
  let buffered = '';
  input.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
      sent.push((JSON.parse(buffered.slice(0, index)) as { uuid: string }).uuid);
      buffered = buffered.slice(index + 1);
    }
  });
  const stream = new StreamSession({ pid: 1, input, output, errors: new PassThrough(), exited: new Promise(() => undefined) }, randomUUID());
  return { sent, stream, emit: (event) => void output.write(`${JSON.stringify(event)}\n`), flush: () => new Promise((resolve) => setTimeout(resolve, 50)) };
}

const RESULT = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, permission_denials: [] };
const ack = (uuid: string) => ({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } });

// A answered; B sent.
async function bSent(): Promise<{ session: ReturnType<typeof fakeSession>; a: string; b: string }> {
  const session = fakeSession();
  await session.stream.send('A');
  await session.flush();
  session.emit(ack(session.sent[0]!));
  session.emit(RESULT);
  await session.flush();
  const first = await session.stream.nextTurn();
  assert.ok(first?.kind === 'result' && session.stream.answers(first));
  await session.stream.send('B');
  await session.flush();
  return { session, a: session.sent[0]!, b: session.sent[1]! };
}

test('a result before B is acknowledged leaves the correlation unresolved; a late acknowledgment does not resolve it, a later result does', async () => {
  const { session, b } = await bSent();
  assert.equal(session.stream.unresolvedSince, undefined, 'nothing unresolved on the normal path');
  session.emit(RESULT);
  await session.flush();
  const early = await session.stream.nextTurn();
  assert.ok(early?.kind === 'result' && !session.stream.answers(early));
  const since = session.stream.unresolvedSince;
  assert.ok(since !== undefined);
  session.emit(ack(b));
  await session.flush();
  assert.equal(session.stream.unacknowledged, 0);
  assert.equal(session.stream.unresolvedSince, since, 'the acknowledgment alone never resolves it (not retroactive)');
  assert.ok(!session.stream.answers(early), 'the early result is still not the answer');
  // Progress is tracked; unrelated system output is not progress.
  const before = session.stream.progressAt;
  session.emit({ type: 'system', subtype: 'hook_response' });
  await session.flush();
  assert.equal(session.stream.progressAt, before);
  session.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } });
  await session.flush();
  assert.ok(session.stream.progressAt > before);
  session.emit(RESULT);
  await session.flush();
  const answer = await session.stream.nextTurn();
  assert.ok(answer?.kind === 'result' && session.stream.answers(answer), 'a later result after the acknowledgment answers B');
  assert.equal(session.stream.unresolvedSince, undefined);
});

for (const [label, bogus] of [
  ['a duplicate acknowledgment of A', (ids: { a: string; b: string }) => ack(ids.a)],
  ['a foreign uuid', () => ack(randomUUID())],
  ["a tool_result carrying B's uuid", (ids: { a: string; b: string }) => ({ type: 'user', isReplay: true, uuid: ids.b, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })],
] as Array<[string, (ids: { a: string; b: string }) => object]>) {
  test(`after a result before B's acknowledgment, ${label} neither acknowledges B nor resolves the correlation`, async () => {
    const { session, a, b } = await bSent();
    session.emit(RESULT);
    session.emit(bogus({ a, b }));
    session.emit(RESULT);
    await session.flush();
    for (const turn of [await session.stream.nextTurn(), await session.stream.nextTurn()]) assert.ok(turn?.kind === 'result' && !session.stream.answers(turn));
    assert.equal(session.stream.unacknowledged, 1);
    assert.ok(session.stream.unresolvedSince !== undefined);
  });
}

// ---- the supervisor with the fake stream-json Claude ----

// Short bounds so that a fail-closed outcome is reached quickly.
const BOUNDS: Partial<SupervisorOptions> = { quiesceTimeoutMs: 12_000, correlationIdleMs: 1500, correlationTimeoutMs: 8000 };

async function launch(extra: Record<string, string>, options: Partial<SupervisorOptions> = {}): Promise<{ fx: Fixture; job: string; stop: () => Promise<void> }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  await setStreamMode(fx, 'answer-before-ack', extra);
  const job = 'job-correlation';
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx, { ...BOUNDS, ...options });
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  return { fx, job, stop: running.stop };
}

const status = async (fx: Fixture, job: string, wanted: (value: Awaited<ReturnType<ReturnType<typeof gateway>['status']>>) => boolean, what: string, timeoutMs = 20_000) => {
  let last = '';
  try {
    return await waitFor(async () => {
      const value = await gateway(fx).status(fx.app, job);
      last = `${value.status} ${value.job?.current_iteration} ${value.job?.diagnostic?.code} ${value.job?.diagnostic?.message}`;
      return wanted(value) ? value : undefined;
    }, what, timeoutMs);
  } catch (error) {
    throw new Error(`${(error as Error).message}; last seen: ${last}`);
  }
};

async function review(fx: Fixture, job: string, edit: string): Promise<string> {
  await status(fx, job, (value) => value.status === 'awaiting_review', 'awaiting_review');
  const gw = gateway(fx);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  const reviewId = randomUUID();
  await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: reviewId, findings: [{ text: `FAKE-EDIT notes.txt ${edit}` }] });
  return reviewId;
}

const events = async (fx: Fixture, job: string) => (JSON.parse(await readFile(join(jobDir(fx, job), 'managed.json'), 'utf8')) as { events: Array<{ event: string; detail: string | null }> }).events;

async function failsClosed(fx: Fixture, job: string, reviewId: string, started: number): Promise<void> {
  const ended = await status(fx, job, (value) => value.status === 'needs_inspection', 'needs_inspection');
  assert.equal(ended.job?.diagnostic?.code, 'turn_correlation_unresolved', ended.job?.diagnostic?.message);
  assert.ok(Date.now() - started < 15_000, 'bounded');
  assert.deepEqual(ended.job?.reviews.map((entry) => [entry.review_id, entry.outcome, entry.reason]), [[reviewId, 'delivered', 'turn_correlation_unresolved']], 'acknowledged, but no answer attributed');
  assert.equal(ended.job?.iterations[1]?.snapshot_sha256 ?? null, null, 'nothing published from the unattributed result');
  assert.equal(ended.job?.session_process, 'ended');
  assert.ok((await events(fx, job)).some((entry) => entry.event === 'stale_turn'), 'the early result was recorded as stale, not as the answer');
  assert.equal((await messages(fx)).length, 2, 'one review message, never re-sent');
  assert.equal((await invocations(fx)).length, 1, 'no second launch');
  assert.deepEqual(await new SessionGate(gatePath(fx)).holders(), [], 'gate released');
}

test('deadlock regression: a result before the review is acknowledged, then the acknowledgment, then silence: bounded fail-closed, never a hang', async () => {
  const { fx, job } = await launch({});
  const reviewId = await review(fx, job, 'early');
  await failsClosed(fx, job, reviewId, Date.now());
});

test('unrelated background output (system events only) is not progress: still bounded and fail-closed', async () => {
  const { fx, job } = await launch({ noise: '1' });
  const reviewId = await review(fx, job, 'noise');
  await failsClosed(fx, job, reviewId, Date.now());
});

test('a later valid result after the acknowledgment, with progress for longer than the idle bound, is the answer: published, never misattributed', async () => {
  const { fx, job } = await launch({ laterResultMs: '3000' });
  const reviewId = await review(fx, job, 'real-answer');
  const next = await status(fx, job, (value) => value.job?.current_iteration === 'iteration-002' && value.status === 'awaiting_review', 'iteration-002 published');
  assert.deepEqual(next.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'delivered']]);
  const snap = await gateway(fx).snapshot(fx.app, job, 'iteration-002');
  assert.match(await readFile(join(fx.mediator, snap.diff.path), 'utf8'), /\+real-answer/, 'the snapshot is of the later answer');
  const order = (await events(fx, job)).map((entry) => entry.event);
  assert.ok(order.includes('stale_turn'), 'the early result went to iteration-001');
  assert.equal((await messages(fx)).length, 2);
});

test('the supervisor stops while the correlation is unresolved: the session ends at once (supervisor_stopped)', async () => {
  const { fx, job, stop } = await launch({}, { correlationIdleMs: 60_000, correlationTimeoutMs: 120_000 });
  await review(fx, job, 'stopped');
  await waitFor(async () => (await events(fx, job)).some((entry) => entry.event === 'stale_turn'), 'stale_turn');
  const started = Date.now();
  await stop();
  const ended = await status(fx, job, (value) => value.status === 'needs_inspection', 'needs_inspection');
  assert.equal(ended.job?.diagnostic?.code, 'supervisor_stopped');
  assert.ok(Date.now() - started < 10_000);
});

test('the absolute bound holds even while progress continues', async () => {
  const { fx, job } = await launch({ laterResultMs: '60000' }, { correlationIdleMs: 1500, correlationTimeoutMs: 3000 });
  const reviewId = await review(fx, job, 'endless');
  const started = Date.now();
  const ended = await status(fx, job, (value) => value.status === 'needs_inspection', 'needs_inspection');
  assert.equal(ended.job?.diagnostic?.code, 'turn_correlation_unresolved');
  assert.match(ended.job?.diagnostic?.message ?? '', /within 3 s/);
  assert.ok(Date.now() - started < 12_000);
  assert.deepEqual(ended.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'delivered']]);
});
