// Contract tests for the Docker Compose channel: how the fixed docker commands are
// built and how OpenClaw's own answers are interpreted. The docker process is
// replaced by a runner that replays output shaped like real OpenClaw 2026.10.7
// output (recorded in review/SF-005/logs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DockerComposeChannel,
  readReceiverRecord,
  RECEIVER_ARGV,
  RECEIVER_AUTOMATION,
  type CommandResult,
  type DispatchRequest,
} from '../src/openclaw-channel.js';

const COMPOSE = 'deploy/openclaw/compose.yaml';
const EXEC = ['compose', '-f', COMPOSE, '-p', 'software-factory-openclaw', 'exec', '-T', 'gateway'];
const AUTOMATION_ID = 'a1b2c3d4-0000-4000-8000-000000000005';
const REQUEST: DispatchRequest = {
  request_id: '0b7a1c55-3f0e-4c1e-9f55-8d1e2a6f0c11',
  app_id: 'sf-pilot',
  job_id: 'job-001',
  instruction_sha256: 'b3496d0aaf2cac18460200ab1a7c4363033688afb2f972f3b6a55cecff7e3bbc',
};
const ACK = { sf_dispatch: 'accepted', ...REQUEST, accepted_at: '2026-10-26T12:00:00.000Z' };

function receiverJob(overrides: Record<string, unknown> = {}) {
  return {
    id: AUTOMATION_ID,
    name: RECEIVER_AUTOMATION,
    enabled: false,
    payload: { kind: 'command', argv: [...RECEIVER_ARGV] },
    ...overrides,
  };
}

function cronRun(status: 'ok' | 'error', summary: string, error?: string) {
  const runId = `manual:${AUTOMATION_ID}:1792997679789:1`;
  return {
    ok: true,
    enqueued: true,
    runId,
    completed: true,
    status,
    completionStatus: status === 'ok' ? 'succeeded' : 'failed',
    run: {
      jobId: AUTOMATION_ID,
      action: 'finished',
      status,
      completionStatus: status === 'ok' ? 'succeeded' : 'failed',
      ...(error === undefined ? {} : { error }),
      summary,
      runId,
      runAtMs: 1792997680004,
      durationMs: 307,
      deliveryStatus: 'not-requested',
    },
  };
}

interface Script {
  enqueue?: CommandResult;
  list?: CommandResult;
  run?: CommandResult;
}

function ok(value: unknown): CommandResult {
  return { code: 0, stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: '' };
}

function channel(script: Script) {
  const calls: Array<{ args: readonly string[]; input: string | undefined }> = [];
  const runner = async (args: readonly string[], input?: string): Promise<CommandResult> => {
    calls.push({ args, input });
    const tail = args.slice(EXEC.length).join(' ');
    if (tail === 'node /home/node/.openclaw/sf-dispatch/receiver.mjs enqueue') {
      return script.enqueue ?? ok({ enqueued: true, request_id: REQUEST.request_id });
    }
    if (tail === 'node openclaw.mjs cron list --all --json') {
      return script.list ?? ok({ jobs: [{ id: 'heartbeat', name: 'heartbeat-main', enabled: false, payload: { kind: 'heartbeat' } }, receiverJob()] });
    }
    if (tail === `node openclaw.mjs cron run ${AUTOMATION_ID} --wait --wait-timeout 60s --json`) {
      return script.run ?? ok(cronRun('ok', JSON.stringify(ACK)));
    }
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };
  return { channel: new DockerComposeChannel(runner), calls };
}

test('accepts only when the OpenClaw run is ok and acknowledges this request id', async () => {
  const { channel: subject, calls } = channel({});
  const delivery = await subject.deliver(REQUEST);
  assert.deepEqual(delivery, {
    outcome: 'accepted',
    acknowledgement: ACK,
    run: {
      automation_id: AUTOMATION_ID,
      run_id: `manual:${AUTOMATION_ID}:1792997679789:1`,
      status: 'ok',
      completion_status: 'succeeded',
      run_at_ms: 1792997680004,
      duration_ms: 307,
      output: JSON.stringify(ACK),
    },
  });
  // Fixed argv only; the request travels as JSON on stdin of the enqueue step.
  for (const call of calls) {
    assert.deepEqual(call.args.slice(0, EXEC.length), EXEC);
  }
  assert.equal(calls[0]!.input, JSON.stringify(REQUEST));
  assert.deepEqual(calls.map((call) => call.input === undefined), [false, true, true]);

  const replayed = channel({ run: ok(cronRun('ok', JSON.stringify({ ...ACK, sf_dispatch: 'already_accepted' }))) });
  assert.equal((await replayed.channel.deliver(REQUEST)).outcome, 'accepted');
});

test('a run that succeeded without acknowledging this exact request is not accepted', async () => {
  for (const summary of [
    JSON.stringify({ sf_dispatch: 'idle' }),
    JSON.stringify({ sf_dispatch: 'conflict', entry: `${REQUEST.request_id}.json`, request_id: REQUEST.request_id }),
    JSON.stringify({ ...ACK, request_id: '11111111-2222-4333-8444-555555555555' }),
    JSON.stringify({ ...ACK, instruction_sha256: '0'.repeat(64) }),
    'accepted 0b7a1c55-3f0e-4c1e-9f55-8d1e2a6f0c11',
    '',
  ]) {
    const delivery = await channel({ run: ok(cronRun('ok', summary)) }).channel.deliver(REQUEST);
    assert.equal(delivery.outcome, 'not_accepted', summary);
  }
  const failed = await channel({
    run: { ...ok(cronRun('error', JSON.stringify(ACK), 'command exited with code 2')), code: 1 },
  }).channel.deliver(REQUEST);
  assert.equal(failed.outcome, 'not_accepted');
  assert.equal(failed.outcome === 'not_accepted' && failed.reason, 'command exited with code 2');
  assert.equal(failed.outcome === 'not_accepted' && failed.run.status, 'error');
});

test('docker, receiver or automation problems are unreachable, never accepted', async () => {
  const cases: Script[] = [
    { enqueue: { code: 1, stdout: '', stderr: 'service "gateway" is not running' } },
    { enqueue: { code: 1, stdout: '', stderr: 'open /home/someone/repo/deploy/openclaw/compose.yaml: no such file or directory' } },
    { enqueue: { code: 2, stdout: '', stderr: 'invalid request' } },
    { list: { code: 1, stdout: '', stderr: 'gateway closed' } },
    { list: ok({ jobs: [] }) },
    { list: ok({ jobs: [receiverJob(), receiverJob({ id: 'second' })] }) },
    { list: ok({ jobs: [receiverJob({ enabled: true })] }) },
    { list: ok({ jobs: [receiverJob({ payload: { kind: 'command', argv: ['sh', '-lc', 'true'] } })] }) },
    { run: { code: 1, stdout: '', stderr: 'missing scope: operator.admin' } },
    { run: ok({ ok: false, error: 'not found' }) },
    { run: ok({ ...cronRun('ok', JSON.stringify(ACK)), runId: 'manual:other' }) },
    { run: { code: 0, stdout: 'not json', stderr: '' } },
  ];
  for (const script of cases) {
    const delivery = await channel(script).channel.deliver(REQUEST);
    assert.equal(delivery.outcome, 'unreachable', JSON.stringify(script).slice(0, 120));
    assert.ok(delivery.outcome === 'unreachable' && delivery.reason.length > 0);
    assert.doesNotMatch(delivery.outcome === 'unreachable' ? delivery.reason : '', /\/home\//);
  }
});

test('deliveries are serialized so concurrent requests cannot take each other\'s inbox entries', async () => {
  let active = 0;
  let maxActive = 0;
  const runner = async (args: readonly string[]): Promise<CommandResult> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const tail = args.slice(EXEC.length).join(' ');
    if (tail.endsWith('enqueue')) {
      return ok({ enqueued: true });
    }
    if (tail.includes('cron list')) {
      return ok({ jobs: [receiverJob()] });
    }
    return ok(cronRun('ok', JSON.stringify(ACK)));
  };
  const subject = new DockerComposeChannel(runner);
  await Promise.all([subject.deliver(REQUEST), subject.deliver(REQUEST), subject.deliver(REQUEST)]);
  assert.equal(maxActive, 1);
});

test('readReceiverRecord asks OpenClaw with one fixed read-only command and validates the answer', async () => {
  const record = { ...REQUEST, accepted_at: '2026-10-26T12:00:00.000Z' };
  const calls: Array<readonly string[]> = [];
  const answer = (result: CommandResult) => async (args: readonly string[]) => {
    calls.push(args);
    return result;
  };
  assert.deepEqual(await readReceiverRecord(answer(ok(record)), REQUEST.request_id), record);
  assert.deepEqual(calls[0], [...EXEC, 'cat', `/home/node/.openclaw/sf-dispatch/accepted/${REQUEST.request_id}.json`]);

  const missing = { code: 1, stdout: '', stderr: `cat: /home/node/.openclaw/sf-dispatch/accepted/${REQUEST.request_id}.json: No such file or directory` };
  assert.equal(await readReceiverRecord(answer(missing), REQUEST.request_id), undefined);
  await assert.rejects(readReceiverRecord(answer({ code: 1, stdout: '', stderr: 'service "gateway" is not running' }), REQUEST.request_id), /failed/);
  await assert.rejects(readReceiverRecord(answer({ code: 0, stdout: 'nope', stderr: '' }), REQUEST.request_id), /not JSON/);
  await assert.rejects(readReceiverRecord(answer(ok({ request_id: REQUEST.request_id })), REQUEST.request_id), /malformed/);
  // The id is validated before any command is built.
  const before = calls.length;
  await assert.rejects(readReceiverRecord(answer(ok(record)), '../../../etc/passwd'), /not a UUID/);
  assert.equal(calls.length, before);
});
