// Contract tests for the dispatch service behind factory_request_dispatch, with a
// scripted OpenClaw channel standing in for the real container.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DispatchService } from '../src/dispatch.js';
import { FactoryJobs } from '../src/factory-jobs.js';
import { InstructionStore } from '../src/instruction-store.js';
import type { Delivery, DispatchRequest, OpenClawChannel } from '../src/openclaw-channel.js';
import { resolveRepoRoot } from '../src/repo-files.js';

const APP = 'sf-pilot';
// Computed independently (Python hashlib).
const CONTENT = '# Пилотна инструкция\n\nНапиши „здравей“ на кирилица. ✓\n';
const SHA = 'b3496d0aaf2cac18460200ab1a7c4363033688afb2f972f3b6a55cecff7e3bbc';
const OTHER_SHA = '3b9f94b0f082306cba94273c3840f910677adef6fddbd9346b9dad0758c18feb';

class ScriptedChannel implements OpenClawChannel {
  readonly calls: DispatchRequest[] = [];
  readonly #outcomes: Array<(request: DispatchRequest) => Delivery>;

  constructor(...outcomes: Array<(request: DispatchRequest) => Delivery>) {
    this.#outcomes = outcomes;
  }

  async deliver(request: DispatchRequest): Promise<Delivery> {
    this.calls.push(request);
    const next = this.#outcomes.shift();
    assert.ok(next, 'unexpected delivery');
    return next(request);
  }
}

function run(status: string, output: string) {
  return {
    automation_id: '9e1f4b0e-0000-4000-8000-000000000001',
    run_id: `manual:9e1f4b0e:${status}`,
    status,
    completion_status: status === 'ok' ? 'succeeded' : 'failed',
    run_at_ms: 1792997680004,
    duration_ms: 120,
    output,
  };
}

const accepted = (request: DispatchRequest): Delivery => ({
  outcome: 'accepted',
  run: run('ok', JSON.stringify({ sf_dispatch: 'accepted', ...request })),
  acknowledgement: { sf_dispatch: 'accepted', ...request, accepted_at: '2026-10-26T12:00:00.000Z' },
});
const unreachable = (): Delivery => ({ outcome: 'unreachable', reason: 'docker compose exec exited with code 1' });
const notAccepted = (): Delivery => ({ outcome: 'not_accepted', run: run('error', ''), reason: 'command exited with code 2' });

let sandbox: string;
let jobs: FactoryJobs;
let instructions: InstructionStore;

async function jobFiles(job: string): Promise<string[]> {
  return (await readdir(join(sandbox, 'factory-data', 'apps', APP, 'jobs', job))).sort();
}

async function jobJson(job: string, name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(sandbox, 'factory-data', 'apps', APP, 'jobs', job, name), 'utf8'));
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'sf-dispatch-'));
  await mkdir(join(sandbox, 'factory-data', 'apps', APP), { recursive: true });
  sandbox = await resolveRepoRoot(sandbox);
  jobs = new FactoryJobs(sandbox);
  instructions = new InstructionStore(jobs);
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

test('an accepted dispatch records OpenClaw evidence and a retry does not deliver again', async () => {
  await instructions.write({ app_id: APP, job_id: 'job-ok', content: CONTENT });
  const channel = new ScriptedChannel(accepted);
  const service = new DispatchService(jobs, channel);

  const first = await service.request({ app_id: APP, job_id: 'job-ok', instruction_sha256: SHA });
  assert.equal(first.state, 'accepted');
  assert.equal(first.replayed, false);
  assert.match(first.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first.path, `factory-data/apps/${APP}/jobs/job-ok/dispatch.json`);
  assert.equal(first.receipt_path, `factory-data/apps/${APP}/jobs/job-ok/openclaw-receipt.json`);
  assert.deepEqual(first.openclaw, { automation_id: '9e1f4b0e-0000-4000-8000-000000000001', run_id: 'manual:9e1f4b0e:ok', status: 'ok', completion_status: 'succeeded' });
  assert.deepEqual(channel.calls, [{ request_id: first.request_id, app_id: APP, job_id: 'job-ok', instruction_sha256: SHA }]);

  const record = await jobJson('job-ok', 'dispatch.json');
  assert.equal(record.schema, 'software-factory.dispatch/v1');
  assert.deepEqual(
    [record.request_id, record.state, record.revision, record.attempts, record.instruction_sha256, record.receipt, record.last_error],
    [first.request_id, 'accepted', 3, 1, SHA, 'openclaw-receipt.json', null],
  );
  const receipt = await jobJson('job-ok', 'openclaw-receipt.json');
  assert.equal(receipt.schema, 'software-factory.openclaw-receipt/v1');
  assert.equal(receipt.request_id, first.request_id);
  assert.equal(receipt.outcome, 'accepted');
  assert.deepEqual(receipt.openclaw, run('ok', JSON.stringify({ sf_dispatch: 'accepted', ...channel.calls[0] })));
  assert.deepEqual((receipt.acknowledgement as { request_id: string }).request_id, first.request_id);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retry = await service.request({ app_id: APP, job_id: 'job-ok', instruction_sha256: SHA });
    assert.deepEqual({ ...retry, replayed: false }, first);
    assert.equal(retry.replayed, true);
  }
  assert.equal(channel.calls.length, 1);
  assert.deepEqual(await jobFiles('job-ok'), ['dispatch.json', 'instruction.md', 'openclaw-receipt.json']);
});

test('concurrent requests for one job deliver once', async () => {
  await instructions.write({ app_id: APP, job_id: 'job-parallel', content: CONTENT });
  const channel = new ScriptedChannel(accepted);
  const service = new DispatchService(jobs, channel);
  const results = await Promise.all(
    [1, 2, 3].map(() => service.request({ app_id: APP, job_id: 'job-parallel', instruction_sha256: SHA })),
  );
  assert.equal(channel.calls.length, 1);
  assert.equal(new Set(results.map((result) => result.request_id)).size, 1);
  assert.deepEqual(results.map((result) => result.state), ['accepted', 'accepted', 'accepted']);
});

test('OpenClaw failures are recorded as failed and a retry reuses the request id', async () => {
  await instructions.write({ app_id: APP, job_id: 'job-fail', content: CONTENT });
  const channel = new ScriptedChannel(unreachable, notAccepted, accepted);
  const service = new DispatchService(jobs, channel);

  const down = await service.request({ app_id: APP, job_id: 'job-fail', instruction_sha256: SHA });
  assert.equal(down.state, 'failed');
  assert.deepEqual(down.error, { code: 'openclaw_unreachable', message: 'docker compose exec exited with code 1' });
  assert.equal(down.receipt_path, undefined);
  assert.equal(down.openclaw, undefined);
  assert.deepEqual(await jobFiles('job-fail'), ['dispatch.json', 'instruction.md']);

  const refused = await service.request({ app_id: APP, job_id: 'job-fail', instruction_sha256: SHA });
  assert.equal(refused.state, 'failed');
  assert.equal(refused.request_id, down.request_id);
  assert.deepEqual(refused.error, { code: 'openclaw_not_accepted', message: 'command exited with code 2' });
  assert.deepEqual(refused.openclaw?.status, 'error');
  assert.equal((await jobJson('job-fail', 'openclaw-receipt.json')).outcome, 'not_accepted');

  const recovered = await service.request({ app_id: APP, job_id: 'job-fail', instruction_sha256: SHA });
  assert.equal(recovered.state, 'accepted');
  assert.equal(recovered.attempts, 3);
  assert.deepEqual(new Set(channel.calls.map((call) => call.request_id)), new Set([down.request_id]));
  const record = await jobJson('job-fail', 'dispatch.json');
  assert.equal(record.last_error, null);
  // Earlier failures stay visible in the dispatch record after the retry succeeded.
  assert.deepEqual(
    (record.history as Array<{ attempt: number; outcome: string; error: { code: string } | null }>).map((entry) => [entry.attempt, entry.outcome, entry.error?.code ?? null]),
    [
      [1, 'unreachable', 'openclaw_unreachable'],
      [2, 'not_accepted', 'openclaw_not_accepted'],
      [3, 'accepted', null],
    ],
  );
});

test('rejects missing, changed or unknown instructions without creating a dispatch', async () => {
  const channel = new ScriptedChannel();
  const service = new DispatchService(jobs, channel);
  const rejects = (request: Parameters<DispatchService['request']>[0], code: string) =>
    assert.rejects(service.request(request), (error: unknown) => {
      assert.equal((error as { code?: string }).code, code, String(error));
      return true;
    });

  await rejects({ app_id: APP, job_id: 'job-none', instruction_sha256: SHA }, 'not_found');
  await rejects({ app_id: 'unknown-app', job_id: 'job-none', instruction_sha256: SHA }, 'app_not_found');
  await rejects({ app_id: APP, job_id: '../job', instruction_sha256: SHA }, 'invalid_id');
  await rejects({ app_id: APP, job_id: 'job-none', instruction_sha256: 'ABC' }, 'invalid_sha256');

  await instructions.write({ app_id: APP, job_id: 'job-changed', content: CONTENT });
  await rejects({ app_id: APP, job_id: 'job-changed', instruction_sha256: OTHER_SHA }, 'sha256_mismatch');
  await instructions.write({ app_id: APP, job_id: 'job-corrupt', content: CONTENT });
  await writeFile(join(sandbox, 'factory-data', 'apps', APP, 'jobs', 'job-corrupt', 'dispatch.json'), '{"schema":"software-factory.dispatch/v1"}');
  await rejects({ app_id: APP, job_id: 'job-corrupt', instruction_sha256: SHA }, 'invalid_record');
  assert.deepEqual(await jobFiles('job-changed'), ['instruction.md']);
  await assert.rejects(readdir(join(sandbox, 'factory-data', 'apps', APP, 'jobs', 'job-none')), { code: 'ENOENT' });
  assert.equal(channel.calls.length, 0);
});

test('invalid or incomplete dispatch records are refused without contacting OpenClaw or rewriting them', async () => {
  await instructions.write({ app_id: APP, job_id: 'job-record', content: CONTENT });
  const setup = new ScriptedChannel(accepted);
  await new DispatchService(jobs, setup).request({ app_id: APP, job_id: 'job-record', instruction_sha256: SHA });
  const jobDir = join(sandbox, 'factory-data', 'apps', APP, 'jobs', 'job-record');
  const valid = await jobJson('job-record', 'dispatch.json');
  const validReceipt = await jobJson('job-record', 'openclaw-receipt.json');
  const { history: _history, ...legacy } = valid;

  // The regression case: state "accepted" without the evidence fields.
  const incompleteAccepted = Object.fromEntries(
    ['schema', 'request_id', 'app_id', 'job_id', 'instruction_sha256', 'state', 'revision', 'attempts'].map((key) => [key, valid[key]]),
  );
  const openclaw = valid.openclaw as Record<string, unknown>;
  const records: Array<[string, Record<string, unknown>]> = [
    ['incomplete accepted', incompleteAccepted],
    ['accepted without receipt', { ...valid, receipt: null }],
    ['accepted without openclaw run', { ...valid, openclaw: null }],
    ['accepted with a failed run', { ...valid, openclaw: { ...openclaw, status: 'error', completion_status: 'failed' } }],
    ['accepted with last_error', { ...valid, last_error: { code: 'openclaw_unreachable', message: 'x' } }],
    ['accepted with zero attempts', { ...valid, attempts: 0 }],
    ['accepted whose history ends in a failure', { ...valid, history: [{ attempt: 1, outcome: 'unreachable', finished_at: valid.updated_at, openclaw: null, error: { code: 'openclaw_unreachable', message: 'x' } }] }],
    ['record of another job', { ...valid, job_id: 'job-other' }],
    ['record of another app', { ...valid, app_id: 'other-app' }],
    ['malformed request_id', { ...valid, request_id: 'not-a-uuid' }],
    ['unknown field', { ...valid, command: 'id' }],
    ['revision not a positive integer', { ...valid, revision: 0 }],
    ['failed without last_error', { ...valid, state: 'failed', last_error: null }],
    ['unknown state', { ...valid, state: 'completed' }],
  ];
  const channel = new ScriptedChannel();
  const service = new DispatchService(jobs, channel);
  const expectInvalid = async (label: string) => {
    const before = await readFile(join(jobDir, 'dispatch.json'), 'utf8');
    await assert.rejects(service.request({ app_id: APP, job_id: 'job-record', instruction_sha256: SHA }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'invalid_record', label);
      return true;
    });
    assert.equal(await readFile(join(jobDir, 'dispatch.json'), 'utf8'), before, label);
  };
  for (const [label, record] of records) {
    await writeFile(join(jobDir, 'dispatch.json'), JSON.stringify(record));
    await expectInvalid(label);
  }

  // An accepted record is only replayed when its receipt matches it.
  await writeFile(join(jobDir, 'dispatch.json'), JSON.stringify(valid));
  const receipts: Array<[string, Record<string, unknown> | undefined]> = [
    ['missing receipt', undefined],
    ['receipt of another request', { ...validReceipt, request_id: '11111111-2222-4333-8444-555555555555' }],
    ['receipt that was not accepted', { ...validReceipt, outcome: 'not_accepted' }],
    ['receipt of another run', { ...validReceipt, openclaw: { ...(validReceipt.openclaw as object), run_id: 'manual:other' } }],
    ['receipt without acknowledgement', { ...validReceipt, acknowledgement: undefined }],
  ];
  for (const [label, receipt] of receipts) {
    await rm(join(jobDir, 'openclaw-receipt.json'), { force: true });
    if (receipt !== undefined) {
      await writeFile(join(jobDir, 'openclaw-receipt.json'), JSON.stringify(receipt));
    }
    await expectInvalid(label);
  }
  assert.equal(channel.calls.length, 0);

  // Records written before attempt history existed are still replayed when everything else is valid.
  await writeFile(join(jobDir, 'openclaw-receipt.json'), JSON.stringify(validReceipt));
  await writeFile(join(jobDir, 'dispatch.json'), JSON.stringify(legacy));
  const replay = await service.request({ app_id: APP, job_id: 'job-record', instruction_sha256: SHA });
  assert.deepEqual([replay.state, replay.replayed, replay.request_id], ['accepted', true, valid.request_id]);
  assert.equal(channel.calls.length, 0);
});
