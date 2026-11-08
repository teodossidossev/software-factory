// The Dashboard's live stream after a change (SF-140): the calls of one tick are sent by one flush,
// each changed kind once, tickets naming the tickets it is about (none on 'all' and on a stream's
// first event), and a change that arrives while a flush builds is sent by the next flush.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Job } from '../src/jobs.js';
import { fakeActions, fakeSetup, openStream, type SseEvent, type Stream, ticketRow, workspaceRow } from './support/dashboard-client.js';
import { withDashboard } from './support/dashboard-state.js';

const PAGE_EVENTS = new Set(['jobs', 'job', 'workspaces', 'tickets']);

// The page events (not the job's own lines) received since index `from`, after the stream has
// been quiet for a while.
async function settled(stream: Stream, from: number): Promise<SseEvent[]> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return stream.events.slice(from).filter((item) => PAGE_EVENTS.has(item.event));
}

// A stream that has had its first events: jobs, workspaces, tickets and, with a job, its detail.
async function opened(url: URL, job: boolean): Promise<Stream> {
  const stream = await openStream(url);
  await stream.next('tickets');
  if (job) {
    await stream.next('job');
  }
  return stream;
}

test('dashboard stream (SF-140): three state changes in one tick send one jobs event, one job event and one tickets event naming the three tickets; the first tickets event names none', async () => {
  const setup = fakeSetup([workspaceRow('app')], [ticketRow('app', 'T-5')]);
  await withDashboard('dash-stream-coalesce', fakeActions(), async (dashboard, { jobs, job }) => {
    const other: Job = { ...job, ticket: 'T-2', branch: 'T-2-x', state: 'working' };
    await jobs.write(other);
    const stream = await opened(new URL('api/stream?job=app/T-1', dashboard.url), true);
    assert.equal('changed' in stream.events.find((item) => item.event === 'tickets')!.data, false);
    const from = stream.events.length;
    const ready: Job = { ...job, state: 'ready_for_human_review' };
    await jobs.write(ready);
    const failed = (await jobs.read('app', 'T-0'))!;
    dashboard.onStateChange(ready, 'awaiting_review');
    dashboard.onStateChange(other, 'starting');
    dashboard.onStateChange(failed, 'working');
    const events = await settled(stream, from);
    assert.deepEqual(events.map((item) => item.event), ['jobs', 'job', 'workspaces', 'tickets']);
    assert.equal(events[0]!.data.jobs.find((entry: Job) => entry.ticket === 'T-1').state, 'ready_for_human_review');
    assert.equal(events[1]!.data.job.state, 'ready_for_human_review');
    assert.deepEqual(events[3]!.data.changed, [{ workspace: 'app', ticket: 'T-1' }, { workspace: 'app', ticket: 'T-2' }, { workspace: 'app', ticket: 'T-0' }]);
    assert.deepEqual(events[3]!.data.tickets.map((row: { ticket: string }) => row.ticket), ['T-5']);
    stream.close();
  }, setup);
});

test('dashboard stream (SF-140): refreshSetup sends workspaces and one tickets event without changed; with a state change in the same tick, every ticket wins', async () => {
  await withDashboard('dash-stream-setup', fakeActions(), async (dashboard, { job }) => {
    const stream = await opened(new URL('api/stream', dashboard.url), false);
    let from = stream.events.length;
    dashboard.refreshSetup();
    let events = await settled(stream, from);
    assert.deepEqual(events.map((item) => item.event), ['workspaces', 'tickets']);
    assert.equal('changed' in events[1]!.data, false);

    from = stream.events.length;
    dashboard.onStateChange(job, 'working');
    dashboard.refreshSetup();
    events = await settled(stream, from);
    assert.deepEqual(events.map((item) => item.event), ['jobs', 'workspaces', 'tickets']);
    assert.equal('changed' in events[2]!.data, false);
    stream.close();
  }, fakeSetup([workspaceRow('app')], [ticketRow('app', 'T-5')]));
});

test('dashboard stream (SF-140): a change that arrives while a flush builds is sent by the next flush, after it', async () => {
  const setup = fakeSetup([workspaceRow('app')], [ticketRow('app', 'T-5')]);
  const read = setup.workspaces.bind(setup);
  let gate: Promise<void> | undefined;
  let building: (() => void) | undefined;
  setup.workspaces = async () => {
    building?.();
    await gate;
    return read();
  };
  await withDashboard('dash-stream-during', fakeActions(), async (dashboard, { job }) => {
    const stream = await opened(new URL('api/stream?job=app/T-1', dashboard.url), true);
    const from = stream.events.length;
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (building = resolve));
    dashboard.refreshSetup();
    await started;
    building = undefined;
    gate = undefined;
    // The first flush is building: the state change waits for it, and is not lost.
    dashboard.onStateChange(job, 'working');
    assert.deepEqual(await settled(stream, from), []);
    release();
    const events = await settled(stream, from);
    assert.deepEqual(events.map((item) => item.event), ['workspaces', 'tickets', 'jobs', 'job', 'workspaces', 'tickets']);
    assert.equal('changed' in events[1]!.data, false);
    assert.deepEqual(events[5]!.data.changed, [{ workspace: 'app', ticket: 'T-1' }]);
    stream.close();
  }, setup);
});
