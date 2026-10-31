// Stream-only publication evidence: no OS process or gate is used by these tests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { ManagedProcess } from '../src/execution/runner.js';
import { StreamSession } from '../src/executor/stream-session.js';

function stream() {
  const sid = randomUUID();
  const output = new PassThrough();
  const input = new PassThrough();
  let finish!: (exit: { code: number; signal: null }) => void;
  const child: ManagedProcess = { pid: process.pid, input, output, errors: new PassThrough(), exited: new Promise((resolve) => { finish = resolve; }) };
  const session = new StreamSession(child, sid);
  const emit = (event: Record<string, unknown>): void => { output.write(`${JSON.stringify({ session_id: sid, ...event })}\n`); };
  const result = async (extra: Record<string, unknown> = {}): Promise<void> => {
    emit({ type: 'result', subtype: 'success', ...extra });
    assert.equal((await session.nextTurn())?.kind, 'result');
  };
  return { session, emit, result, close: () => { input.end(); output.end(); finish({ code: 0, signal: null }); } };
}

test('a result with outstanding tasks waits for every terminal task event and a final result', async () => {
  const fx = stream();
  try {
    fx.emit({ type: 'system', subtype: 'task_started', task_id: 'a' });
    fx.emit({ type: 'system', subtype: 'task_started', task_id: 'b' });
    await fx.result();
    assert.equal(fx.session.reviewReady, false);
    fx.emit({ type: 'system', subtype: 'task_updated', task_id: 'a', patch: { status: 'completed' } });
    await fx.result();
    assert.equal(fx.session.reviewReady, false);
    fx.emit({ type: 'system', subtype: 'task_notification', task_id: 'b', status: 'completed' });
    assert.equal(fx.session.reviewReady, false, 'task completion does not prove package synthesis');
    await fx.result();
    assert.equal(fx.session.reviewReady, true);
  } finally { fx.close(); }
});

test('authoritative task membership, progress and task updates keep the boundary open', async () => {
  const fx = stream();
  try {
    fx.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a' }] });
    await fx.result();
    assert.equal(fx.session.reviewReady, false);
    fx.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    await fx.result();
    assert.equal(fx.session.reviewReady, true);
    fx.emit({ type: 'system', subtype: 'task_progress', task_id: 'b' });
    await fx.result();
    assert.equal(fx.session.reviewReady, false);
    fx.emit({ type: 'system', subtype: 'task_updated', task_id: 'b', patch: { status: 'killed' } });
    fx.emit({ type: 'system', subtype: 'task_updated', task_id: 'c', patch: { status: 'running' } });
    await fx.result();
    assert.equal(fx.session.reviewReady, false);
    fx.emit({ type: 'system', subtype: 'task_notification', task_id: 'c', status: 'failed' });
    await fx.result();
    assert.equal(fx.session.reviewReady, true);
  } finally { fx.close(); }
});

test('a stale terminal event cannot complete a newer run of the same task', async () => {
  const fx = stream();
  try {
    fx.emit({ type: 'system', subtype: 'task_started', task_id: 'a', run_id: '002' });
    fx.emit({ type: 'system', subtype: 'task_notification', task_id: 'a', run_id: '001', status: 'completed' });
    await fx.result();
    assert.equal(fx.session.reviewReady, false);
    fx.emit({ type: 'system', subtype: 'task_notification', task_id: 'a', run_id: '002', status: 'completed' });
    await fx.result();
    assert.equal(fx.session.reviewReady, true);
  } finally { fx.close(); }
});

test('queued turns and queued results cannot be published as the final result', async () => {
  const fx = stream();
  try {
    await fx.result({ queued_turn_count: 1 });
    assert.equal(fx.session.reviewReady, false);
    fx.emit({ type: 'result', subtype: 'success' });
    fx.emit({ type: 'result', subtype: 'success' });
    await fx.session.nextTurn();
    assert.equal(fx.session.reviewReady, false);
    await fx.session.nextTurn();
    assert.equal(fx.session.reviewReady, true);
  } finally { fx.close(); }
});

test('later work and new sends revoke readiness; arbitrary text cannot establish it', async () => {
  const fx = stream();
  try {
    fx.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'READY FOR REVIEW' }] } });
    assert.equal(fx.session.reviewReady, false);
    await fx.result();
    const activity = fx.session.activity;
    fx.emit({ type: 'assistant', message: { content: [] } });
    assert.ok(fx.session.activity > activity);
    assert.equal(fx.session.reviewReady, false);
    await fx.result();
    await fx.session.send('feedback');
    assert.equal(fx.session.reviewReady, false);
  } finally { fx.close(); }
});

test('foreign task events do not affect this session and a mode violation remains immediate', async () => {
  const fx = stream();
  try {
    fx.emit({ type: 'system', subtype: 'task_started', task_id: 'a', session_id: randomUUID() });
    await fx.result();
    assert.equal(fx.session.reviewReady, true);
    fx.emit({ type: 'system', subtype: 'task_started', task_id: 'b' });
    fx.emit({ type: 'system', subtype: 'init', permissionMode: 'default' });
    assert.deepEqual(await fx.session.nextTurn(), { kind: 'mode', mode: 'default' });
    assert.equal(fx.session.reviewReady, false);
  } finally { fx.close(); }
});
