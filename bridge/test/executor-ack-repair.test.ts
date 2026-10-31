// SF-009 review acknowledgment repair (incident sf010-chatgpt-event-live-20261030). Claude Code
// 2.1.312 and 2.1.314 hold the replay of a message until the first model output of its turn, so a slow first
// output looked like a missing acknowledgment. Managed sessions stream partial messages, which
// release the replay at the first stream event; nothing else became an acknowledgment. The
// correlation diagnostics are content-free and bounded, and a session being shut down is not
// reported as a working turn or as an observed exit.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, test } from 'node:test';
import { managedArguments } from '../src/execution/runner.js';
import { CORRELATION_ALIASES, CORRELATION_ENTRIES, CORRELATION_OUTPUT_CHARS, CorrelationLog } from '../src/executor/correlation-log.js';
import { StreamSession } from '../src/executor/stream-session.js';
import { waitingReason } from '../src/executor/status.js';
import { sessionClosing, type ManagedRecord } from '../src/executor/records.js';
import type { SupervisorOptions } from '../src/executor/supervisor.js';
import { acceptedJob, destroyFixture, jobDir, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, managedService, messages, setStreamMode, startSupervisor, waitForStatus } from './support/executor-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

const SECRET = 'SECRET-PROMPT-TEXT';

function fakeSession(input: Writable = new PassThrough()): { stream: StreamSession; emit: (event: object) => void; raw: (line: string) => void; flush: () => Promise<void>; sent: string[] } {
  const output = new PassThrough();
  const sent: string[] = [];
  input.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      sent.push((JSON.parse(line) as { uuid: string }).uuid);
    }
  });
  const stream = new StreamSession({ pid: 1, input, output, errors: new PassThrough(), exited: new Promise(() => undefined) }, randomUUID());
  return { sent, stream, emit: (event) => void output.write(`${JSON.stringify(event)}\n`), raw: (line) => void output.write(`${line}\n`), flush: () => new Promise((resolve) => setTimeout(resolve, 30)) };
}

const RESULT = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, permission_denials: [] };
const ack = (uuid: string) => ({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: [{ type: 'text', text: SECRET }] } });

async function bSent(): Promise<{ session: ReturnType<typeof fakeSession>; a: string; b: string }> {
  const session = fakeSession();
  await session.stream.send(`A ${SECRET}`);
  await session.flush();
  session.emit(ack(session.sent[0]!));
  session.emit(RESULT);
  await session.flush();
  await session.stream.nextTurn();
  await session.stream.send(`B ${SECRET}`);
  await session.flush();
  return { session, a: session.sent[0]!, b: session.sent[1]! };
}

test('managed sessions release the replay at the first stream event', () => {
  const argv = managedArguments({ sessionId: randomUUID(), name: 'sf-x' });
  assert.ok(argv.includes('--replay-user-messages'));
  assert.ok(argv.includes('--include-partial-messages'));
});

test('stream events and other output never acknowledge a message', async () => {
  const { session } = await bSent();
  session.emit({ type: 'stream_event', event: { type: 'message_start' } });
  session.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } });
  session.emit({ type: 'system', subtype: 'init', session_id: session.stream.sessionId, permissionMode: 'auto' });
  await session.flush();
  assert.equal(session.stream.unacknowledged, 1);
});

for (const [label, make, reason] of [
  ['a duplicate acknowledgment', (ids: { a: string; b: string }) => ack(ids.a), 'duplicate'],
  ['a foreign uuid', () => ack(randomUUID()), 'foreign'],
  ['no uuid', () => ({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text: SECRET }] } }), 'no_uuid'],
  ["a tool result with the message's uuid", (ids: { a: string; b: string }) => ({ type: 'user', isReplay: true, uuid: ids.b, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: SECRET }] } }), 'tool_result'],
] as Array<[string, (ids: { a: string; b: string }) => object, string]>) {
  test(`${label} is rejected and recorded as ${reason}`, async () => {
    const { session, a, b } = await bSent();
    session.emit(make({ a, b }));
    await session.flush();
    assert.equal(session.stream.unacknowledged, 1);
    assert.match(session.stream.correlationReport('timeout').join(''), new RegExp(`ack_rejected:${reason}`));
  });
}

test('an out-of-order acknowledgment is rejected', async () => {
  const session = fakeSession();
  await session.stream.send('A');
  await session.stream.send('B');
  await session.flush();
  session.emit(ack(session.sent[1]!));
  await session.flush();
  assert.equal(session.stream.unacknowledged, 2);
  assert.match(session.stream.correlationReport('timeout').join(''), /ack_rejected:out_of_order/);
});

test('the report shows the order of send, write, acknowledgment and results, relative to the first send', async () => {
  const { session, b } = await bSent();
  session.emit(RESULT);
  session.emit(ack(b));
  session.emit(RESULT);
  await session.flush();
  const report = session.stream.correlationReport('closed').join('');
  const order = ['send:m1', 'write_ok:m1', 'ack_accepted:m1', 'result:after_ack', 'send:m2', 'write_ok:m2', 'result:before_ack', 'ack_accepted:m2', 'result:after_ack', 'end:closed'];
  let from = 0;
  for (const step of order) {
    const at = report.indexOf(step, from);
    assert.ok(at >= 0, `${step} in order in ${report}`);
    from = at + step.length;
  }
});

test('a failed write is recorded, and the message stays unacknowledged', async () => {
  const input = new Writable({ write: (_chunk, _encoding, done) => done(new Error(`EPIPE ${SECRET}`)) });
  const session = fakeSession(input);
  await assert.rejects(session.stream.send('A'));
  await session.flush();
  assert.equal(session.stream.unacknowledged, 1);
  const report = session.stream.correlationReport('review_not_delivered').join('');
  assert.match(report, /write_failed:m1/);
  assert.ok(!report.includes(SECRET));
});

test('diagnostics hold no content or identifiers, whatever the events carry', async () => {
  const { session, a, b } = await bSent();
  const foreign = randomUUID();
  session.emit({ ...ack(foreign), subtype: SECRET, type: 'user' });
  session.emit({ type: SECRET, uuid: foreign });
  session.emit({ type: 'stream_event', event: { type: SECRET }, uuid: foreign });
  session.emit({ type: 'result', subtype: SECRET, result: SECRET, session_id: SECRET });
  session.raw(`not json ${SECRET}`);
  await session.flush();
  const report = session.stream.correlationReport('timeout').join('');
  for (const secret of [SECRET, a, b, foreign, session.stream.sessionId]) {
    assert.ok(!report.includes(secret), `${secret} leaked`);
  }
  assert.match(report, /x1/);
});

test('the log keeps a bounded number of entries and aliases, and its output is capped', () => {
  const log = new CorrelationLog();
  for (let index = 0; index < 10 * CORRELATION_ENTRIES; index += 1) {
    log.note('ack_rejected', 'foreign', randomUUID());
    log.note('result', 'before_ack');
  }
  assert.ok(log.size <= CORRELATION_ENTRIES);
  const report = log.report('timeout');
  assert.ok(report.join('').length <= CORRELATION_OUTPUT_CHARS);
  assert.ok(report.every((chunk) => chunk.length <= 300));
  assert.match(report.join(''), /dropped=\d+/);
  assert.match(report.join(''), /end:timeout/, 'the end state survives the cap');
  assert.match(report.join(''), /x\+/, 'aliases are capped');
});

test('retained identifiers are bounded: many messages, many foreign uuids, oversized identifiers', () => {
  const log = new CorrelationLog();
  const huge = 'y'.repeat(4 * 1024 * 1024);
  for (let index = 0; index < 5000; index += 1) {
    log.own(`message-${index}-${huge.slice(0, 1024)}`);
    log.note('ack_rejected', 'foreign', `${huge}${index}`);
  }
  assert.ok(log.aliases <= 2 * CORRELATION_ALIASES, `${log.aliases} aliases`);
  assert.ok(log.identifierBytes <= 2 * CORRELATION_ALIASES * 64, `${log.identifierBytes} bytes`);
  assert.ok(!log.report('timeout').join('').includes('yyyy'));
});

test('a recent message of ours stays ours; one evicted from the bound no longer does', () => {
  const log = new CorrelationLog();
  log.own('old');
  for (let index = 0; index < CORRELATION_ALIASES; index += 1) {
    log.own(`new-${index}`);
  }
  assert.equal(log.ours('old'), false);
  assert.equal(log.ours(`new-${CORRELATION_ALIASES - 1}`), true);
  log.note('send', undefined, `new-${CORRELATION_ALIASES - 1}`);
  assert.match(log.report('x').join(''), new RegExp(`send:m${CORRELATION_ALIASES + 1}`));
});

test('an oversized uuid in an event never reaches the report, and exact matching is unaffected', async () => {
  const { session, b } = await bSent();
  session.emit(ack('z'.repeat(1024 * 1024)));
  session.emit(ack(`${b}z`));
  await session.flush();
  assert.equal(session.stream.unacknowledged, 1);
  session.emit(ack(b));
  await session.flush();
  assert.equal(session.stream.unacknowledged, 0);
  assert.ok(!session.stream.correlationReport('closed').join('').includes('zzzz'));
});

test('repeated progress of one kind is recorded once per message', async () => {
  const { session } = await bSent();
  for (let index = 0; index < 50; index += 1) {
    session.emit({ type: 'stream_event', event: { type: 'content_block_delta' } });
  }
  await session.flush();
  const report = session.stream.correlationReport('timeout').join('');
  assert.equal(report.match(/first:stream_event/g)?.length, 1);
});

// ---- waiting reasons ----

const record = (state: string, process: string, code: string | null): ManagedRecord => ({ state, current_iteration: 'iteration-002', session: { process }, diagnostic: code === null ? null : { code, message: 'x' }, events: [] }) as unknown as ManagedRecord;

test('shutdown in progress, an observed exit and a working turn read differently', () => {
  const now = new Date();
  assert.match(waitingReason(record('running', 'alive', null), undefined, true, now), /turn in progress/);
  const ending = waitingReason(record('running', 'ending', 'turn_correlation_unavailable'), undefined, true, now);
  assert.match(ending, /shutting down \(turn_correlation_unavailable\)/);
  assert.match(ending, /no exit observed yet/);
  const exited = waitingReason(record('running', 'ended', 'session_exited'), undefined, true, now);
  assert.match(exited, /exit was observed/);
  assert.doesNotMatch(exited, /shutting down|turn in progress/);
  const unconfirmed = waitingReason(record('needs_inspection', 'unconfirmed', 'turn_correlation_unavailable'), undefined, true, now);
  assert.match(unconfirmed, /not shown to have ended/);
  assert.doesNotMatch(unconfirmed, /exit was observed/);
});

// ---- the supervisor with the fake stream-json Claude ----

async function launch(firstOutputMs: number, ackTimeoutMs: number): Promise<{ fx: Fixture; job: string }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  await setStreamMode(fx, 'replay-at-first-output', { firstOutputMs: String(firstOutputMs) });
  const job = 'job-ack';
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx, { ackTimeoutMs });
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  return { fx, job };
}

async function submit(fx: Fixture, job: string): Promise<string> {
  await waitForStatus(fx, job, (value) => value.status === 'awaiting_review', 'awaiting_review');
  const gw = gateway(fx);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  const reviewId = randomUUID();
  await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: reviewId, findings: [{ text: `FAKE-EDIT notes.txt slow ${SECRET}` }] });
  return reviewId;
}

const events = async (fx: Fixture, job: string) => (JSON.parse(await readFile(join(jobDir(fx, job), 'managed.json'), 'utf8')) as { events: Array<{ event: string; detail: string | null }> }).events;

test('incident regression: first output slower than the acknowledgment bound still delivers the review', async () => {
  const { fx, job } = await launch(2000, 800);
  const reviewId = await submit(fx, job);
  const next = await waitForStatus(fx, job, (value) => value.job?.current_iteration === 'iteration-002' && value.status === 'awaiting_review', 'iteration-002 published');
  assert.deepEqual(next.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'delivered']]);
  assert.equal((await messages(fx)).length, 2, 'one review message');
  const diagnostics = (await events(fx, job)).filter((entry) => entry.event === 'ack_diagnostics');
  assert.ok(diagnostics.length > 0);
  const text = diagnostics.map((entry) => entry.detail).join('');
  assert.match(text, /ack_accepted:m2/);
  assert.ok(!text.includes(SECRET) && !text.includes(reviewId));
});

test('while a failed session shuts down its process is ending, not alive and not ended', async () => {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  await setStreamMode(fx, 'ok', { noReplayAfterFirst: '1', onClose: 'linger' });
  const job = 'job-ack';
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx, { ackTimeoutMs: 300 });
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  await submit(fx, job);
  const ending = await waitForStatus(fx, job, (value) => value.job?.session_process === 'ending', 'ending');
  assert.notEqual(ending.status, 'awaiting_review');
  const ended = await waitForStatus(fx, job, (value) => value.status === 'needs_inspection', 'needs_inspection');
  assert.equal(ended.job?.session_process, 'ended');
});

test('no acknowledgment at all still fails closed at the same bound, with its diagnostics recorded', async () => {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  await setStreamMode(fx, 'ok', { noReplayAfterFirst: '1' });
  const job = 'job-ack';
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx, { ackTimeoutMs: 500 });
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  const reviewId = await submit(fx, job);
  const ended = await waitForStatus(fx, job, (value) => value.status === 'needs_inspection', 'needs_inspection');
  assert.equal(ended.job?.diagnostic?.code, 'turn_correlation_unavailable');
  assert.deepEqual(ended.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'unconfirmed']]);
  assert.equal(ended.job?.session_process, 'ended');
  assert.equal(ended.job?.iterations[1]?.snapshot_sha256 ?? null, null, 'nothing published');
  const log = await events(fx, job);
  const text = log.filter((entry) => entry.event === 'ack_diagnostics').map((entry) => entry.detail).join('');
  assert.match(text, /write_ok:m2/);
  assert.match(text, /result:before_ack/, 'the unattributed result is visible');
  assert.match(text, /end:turn_correlation_unavailable/);
  assert.equal((await messages(fx)).length, 2, 'never re-sent');
});

// ---- diagnostics are best effort ----

async function launchWith(job: string, control: Record<string, string>, options: Partial<SupervisorOptions>, mode = 'ok'): Promise<{ fx: Fixture; stop: () => Promise<void> }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  await setStreamMode(fx, mode, control);
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx, options);
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  return { fx, stop: running.stop };
}

const failingDiagnostics = { beforeCorrelationSave: async () => { throw new Error('disk full'); } };

test('a diagnostic write failure after a valid delivery does not end healthy work', async () => {
  const { fx } = await launchWith('job-ack', {}, failingDiagnostics);
  const reviewId = await submit(fx, 'job-ack');
  const next = await waitForStatus(fx, 'job-ack', (value) => value.job?.current_iteration === 'iteration-002' && value.status === 'awaiting_review', 'iteration-002 published');
  assert.deepEqual(next.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'delivered']]);
  assert.equal(next.job?.session_process, 'alive');
  assert.ok(!(await events(fx, 'job-ack')).some((entry) => entry.event === 'ack_diagnostics'));
});

test('a diagnostic write failure on an acknowledgment timeout keeps the original failure and its cleanup', async () => {
  const { fx } = await launchWith('job-ack', { noReplayAfterFirst: '1', onClose: 'linger' }, { ...failingDiagnostics, ackTimeoutMs: 300 });
  const reviewId = await submit(fx, 'job-ack');
  const ending = await waitForStatus(fx, 'job-ack', (value) => value.job?.session_process === 'ending', 'ending');
  assert.equal(ending.job?.iterations[1]?.state, 'abandoned');
  const ended = await waitForStatus(fx, 'job-ack', (value) => value.status === 'needs_inspection', 'needs_inspection');
  assert.equal(ended.job?.diagnostic?.code, 'turn_correlation_unavailable');
  assert.deepEqual(ended.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'unconfirmed']]);
  assert.equal(ended.job?.session_process, 'ended');
  assert.ok((await events(fx, 'job-ack')).some((entry) => entry.event === 'session_ending'));
});

// ---- the gateway during shutdown ----

async function assertRefusesRequests(fx: Fixture, job: string): Promise<void> {
  const gw = gateway(fx);
  const status = await gw.status(fx.app, job);
  const iteration = status.job!.current_iteration!;
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  const conflict = (error: unknown) => (error as { code?: string }).code === 'conflict' && /shutting down|ended/.test((error as Error).message);
  await assert.rejects(gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: iteration, snapshot_sha256: snap.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'x' }] }), conflict);
  await assert.rejects(gw.accept({ app_id: fx.app, job_id: job, iteration_id: iteration, snapshot_sha256: snap.snapshot_sha256, acceptance_id: randomUUID() }), conflict);
  await assert.rejects(gw.manageContext({ app_id: fx.app, job_id: job, iteration_id: iteration, session_id: status.job!.current_session_id!, action: 'compact', request_id: randomUUID() }), conflict);
  assert.deepEqual((await gw.listReviewReady(fx.app)).ready, []);
}

test('an idle published session entering shutdown is not reported idle, not listed ready, and takes no requests', async () => {
  const { fx, stop } = await launchWith('job-ack', { onClose: 'linger' }, {});
  await waitForStatus(fx, 'job-ack', (value) => value.status === 'awaiting_review', 'awaiting_review');
  assert.equal((await gateway(fx).listReviewReady(fx.app)).ready.length, 1, 'ready while alive');
  const stopping = stop();
  const ending = await waitForStatus(fx, 'job-ack', (value) => value.job?.session_process === 'ending', 'ending');
  assert.equal(ending.status, 'session_ending');
  assert.match(ending.note, /shutting down/);
  assert.doesNotMatch(ending.note, /Claude is idle|session is alive/);
  await assertRefusesRequests(fx, 'job-ack');
  await stopping;
});

test('a running turn entering shutdown is not reported as working', async () => {
  const { fx } = await launchWith('job-ack', { noReplayAfterFirst: '1', onClose: 'linger' }, { ackTimeoutMs: 300 });
  await submit(fx, 'job-ack');
  const ending = await waitForStatus(fx, 'job-ack', (value) => value.job?.session_process === 'ending', 'ending');
  assert.equal(ending.status, 'session_ending');
  assert.match(ending.note, /shutting down/);
  assert.doesNotMatch(ending.note, /is working/);
});

test('needs_operator with no process keeps accepting the operator\'s requests', () => {
  const status = sessionClosing(record('needs_operator', 'none', 'reset_incomplete'));
  assert.equal(status, false);
  assert.equal(sessionClosing(record('awaiting_review', 'alive', null)), false);
  assert.equal(sessionClosing(record('needs_inspection', 'ended', 'session_exited')), false);
  assert.equal(sessionClosing(record('awaiting_review', 'ended', 'session_exited')), true);
});

// ---- an exit that was never observed ----

test('an unconfirmed shutdown is never an observed exit: the cause and the cleanup failure both stay visible', async () => {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  await setStreamMode(fx, 'ok', { noReplayAfterFirst: '1' });
  const real = managedService(fx);
  const service: SupervisorOptions['service'] = {
    preflight: real.preflight.bind(real),
    prepare: real.prepare.bind(real),
    status: real.status.bind(real),
    collect: real.collect.bind(real),
    runManaged: async (...args) => ({ ...(await real.runManaged(...args)), state: 'needs_inspection', error: { code: 'session_not_ended', message: 'The Claude process (pid 1) did not end after its input closed and it was signalled.' } }),
  };
  const accepted = await acceptedJob(fx, 'job-ack');
  const running = await startSupervisor(fx, { ackTimeoutMs: 300, service });
  cleanup.push(running.stop);
  await authorize(fx, 'job-ack', accepted, randomUUID());
  await submit(fx, 'job-ack');
  const ended = await waitForStatus(fx, 'job-ack', (value) => value.status === 'needs_inspection', 'needs_inspection');
  assert.equal(ended.job?.session_process, 'unconfirmed');
  assert.equal(ended.job?.diagnostic?.code, 'turn_correlation_unavailable', 'the original cause stays');
  assert.match(ended.job?.diagnostic?.message ?? '', /did not acknowledge message 2/);
  assert.match(ended.job?.diagnostic?.message ?? '', /session_not_ended.*did not end after its input closed/);
  assert.match(ended.note, /not shown to have ended/);
  const managed = JSON.parse(await readFile(join(jobDir(fx, 'job-ack'), 'managed.json'), 'utf8')) as { session: { lineage: Array<{ ended_at: string | null }> } };
  assert.equal(managed.session.lineage.at(-1)?.ended_at, null, 'the lineage stays open');
});
