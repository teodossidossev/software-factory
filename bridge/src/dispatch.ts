// Dispatch requests: factory-data/apps/<app-id>/jobs/<job-id>/dispatch.json plus,
// once OpenClaw has run the receiver automation, openclaw-receipt.json.
// One job has at most one dispatch, with one request_id for its whole life:
// retries of a requested or failed dispatch redeliver that same request_id, and
// an accepted dispatch is returned as is without contacting OpenClaw again.
import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import {
  checkSha256,
  FactoryJobError,
  FactoryJobs,
  ID_PATTERN,
  readJobFile,
  SHA256_PATTERN,
  writeJobFile,
  type JobDir,
} from './factory-jobs.js';
import { DISPATCH_FILE, INSTRUCTION_FILE, readInstruction } from './instruction-store.js';
import type { Delivery, DispatchRequest, OpenClawChannel } from './openclaw-channel.js';

export const RECEIPT_FILE = 'openclaw-receipt.json';
const MAX_RECORD_BYTES = 256 * 1024;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type DispatchState = 'requested' | 'accepted' | 'failed';

export interface OpenClawRunRef {
  automation_id: string;
  run_id: string;
  status: string;
  completion_status: string;
}

// One entry per finished delivery; openclaw-receipt.json holds only the latest OpenClaw result.
interface AttemptEntry {
  attempt: number;
  outcome: 'accepted' | 'not_accepted' | 'unreachable';
  finished_at: string;
  openclaw: OpenClawRunRef | null;
  error: { code: string; message: string } | null;
}

export interface DispatchRecord {
  schema: 'software-factory.dispatch/v1';
  request_id: string;
  app_id: string;
  job_id: string;
  instruction_sha256: string;
  state: DispatchState;
  // Increases with every write of this file.
  revision: number;
  // Deliveries started so far.
  attempts: number;
  created_at: string;
  updated_at: string;
  last_error: { code: string; message: string } | null;
  receipt: typeof RECEIPT_FILE | null;
  openclaw: OpenClawRunRef | null;
  history: AttemptEntry[];
}

export interface RequestDispatchInput {
  app_id: string;
  job_id: string;
  instruction_sha256: string;
}

export interface DispatchResult {
  path: string;
  request_id: string;
  state: DispatchState;
  revision: number;
  attempts: number;
  instruction_sha256: string;
  // True when an earlier call already reached this state and nothing was delivered now.
  replayed: boolean;
  receipt_path?: string;
  openclaw?: OpenClawRunRef;
  error?: { code: string; message: string };
}

// The stored files are checked as strictly as they are written: a record that
// does not satisfy these schemas and the per-state invariants below is refused
// as invalid_record, never repaired, replayed or redelivered.
const errorSchema = z.strictObject({ code: z.string().min(1), message: z.string() });
const runRefSchema = z.strictObject({
  automation_id: z.string().min(1),
  run_id: z.string().min(1),
  status: z.string().min(1),
  completion_status: z.string().min(1),
});
const attemptSchema = z.strictObject({
  attempt: z.number().int().min(1),
  outcome: z.enum(['accepted', 'not_accepted', 'unreachable']),
  finished_at: z.iso.datetime(),
  openclaw: runRefSchema.nullable(),
  error: errorSchema.nullable(),
});
const recordSchema = z.strictObject({
  schema: z.literal('software-factory.dispatch/v1'),
  request_id: z.string().regex(REQUEST_ID_PATTERN),
  app_id: z.string().regex(ID_PATTERN),
  job_id: z.string().regex(ID_PATTERN),
  instruction_sha256: z.string().regex(SHA256_PATTERN),
  state: z.enum(['requested', 'accepted', 'failed']),
  revision: z.number().int().min(1),
  attempts: z.number().int().min(0),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  last_error: errorSchema.nullable(),
  receipt: z.literal(RECEIPT_FILE).nullable(),
  openclaw: runRefSchema.nullable(),
  // Records written before attempt history existed (first SF-005 live run) have none.
  history: z.array(attemptSchema).optional(),
});
const acceptedReceiptSchema = z.object({
  schema: z.literal('software-factory.openclaw-receipt/v1'),
  request_id: z.string(),
  app_id: z.string(),
  job_id: z.string(),
  instruction_sha256: z.string(),
  outcome: z.literal('accepted'),
  openclaw: z.object({ automation_id: z.string(), run_id: z.string(), status: z.literal('ok'), completion_status: z.literal('succeeded') }),
  acknowledgement: z.object({
    sf_dispatch: z.enum(['accepted', 'already_accepted']),
    request_id: z.string(),
    app_id: z.string(),
    job_id: z.string(),
    instruction_sha256: z.string(),
  }),
});

const succeeded = (run: OpenClawRunRef | null): boolean => run?.status === 'ok' && run.completion_status === 'succeeded';

// Returns why a schema-valid record is inconsistent, or undefined when it is consistent.
function recordProblem(record: DispatchRecord, appId: string, jobId: string): string | undefined {
  if (record.app_id !== appId || record.job_id !== jobId) {
    return 'it belongs to another job';
  }
  const attempts = record.history.map((entry) => entry.attempt);
  if (attempts.length > record.attempts || attempts.some((attempt, index) => attempt > record.attempts || (index > 0 && attempt <= attempts[index - 1]!))) {
    return 'its attempt history does not match attempts';
  }
  for (const entry of record.history) {
    const consistent =
      entry.outcome === 'accepted'
        ? succeeded(entry.openclaw) && entry.error === null
        : entry.outcome === 'not_accepted'
          ? entry.openclaw !== null && entry.error?.code === 'openclaw_not_accepted'
          : entry.openclaw === null && entry.error?.code === 'openclaw_unreachable';
    if (!consistent) {
      return `attempt ${entry.attempt} is inconsistent`;
    }
  }
  const last = record.history.at(-1);
  if (record.state === 'accepted') {
    if (record.attempts < 1 || record.last_error !== null || record.receipt === null || !succeeded(record.openclaw)) {
      return 'state accepted lacks the acceptance evidence';
    }
    if (last !== undefined && (last.outcome !== 'accepted' || last.openclaw?.run_id !== record.openclaw?.run_id)) {
      return 'state accepted does not match the last attempt';
    }
  }
  if (record.state === 'failed') {
    if (record.attempts < 1 || record.last_error === null) {
      return 'state failed lacks its error';
    }
    if (record.last_error.code === 'openclaw_not_accepted' && (record.openclaw === null || record.receipt === null)) {
      return 'state failed lacks the OpenClaw run it refers to';
    }
    if (last !== undefined && last.outcome === 'accepted') {
      return 'state failed does not match the last attempt';
    }
  }
  return undefined;
}

function result(job: JobDir, record: DispatchRecord, replayed: boolean): DispatchResult {
  return {
    path: `${job.path}/${DISPATCH_FILE}`,
    request_id: record.request_id,
    state: record.state,
    revision: record.revision,
    attempts: record.attempts,
    instruction_sha256: record.instruction_sha256,
    replayed,
    ...(record.receipt === null ? {} : { receipt_path: `${job.path}/${record.receipt}` }),
    ...(record.openclaw === null ? {} : { openclaw: record.openclaw }),
    ...(record.last_error === null ? {} : { error: record.last_error }),
  };
}

function toJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export class DispatchService {
  readonly #jobs: FactoryJobs;
  readonly #channel: OpenClawChannel;

  constructor(jobs: FactoryJobs, channel: OpenClawChannel) {
    this.#jobs = jobs;
    this.#channel = channel;
  }

  async request(input: RequestDispatchInput): Promise<DispatchResult> {
    checkSha256(input.instruction_sha256);
    return this.#jobs.withJob(input.app_id, input.job_id, false, async (job) => {
      const instruction = await readInstruction(job);
      if (instruction === undefined) {
        throw new FactoryJobError('not_found', `${job.path}/${INSTRUCTION_FILE} does not exist.`);
      }
      if (instruction.sha256 !== input.instruction_sha256) {
        throw new FactoryJobError(
          'sha256_mismatch',
          `${instruction.path} has sha256 ${instruction.sha256}, not the requested ${input.instruction_sha256}.`,
        );
      }

      let record = await readDispatchRecord(job, input.app_id, input.job_id);
      if (record !== undefined && record.instruction_sha256 !== input.instruction_sha256) {
        throw new FactoryJobError('dispatch_conflict', `${job.path} already has a dispatch for another instruction.`);
      }
      if (record?.state === 'accepted') {
        await checkAcceptedReceipt(job, record);
        return result(job, record, true);
      }
      if (record === undefined) {
        const now = new Date().toISOString();
        record = {
          schema: 'software-factory.dispatch/v1',
          request_id: randomUUID(),
          app_id: input.app_id,
          job_id: input.job_id,
          instruction_sha256: input.instruction_sha256,
          state: 'requested',
          revision: 1,
          attempts: 0,
          created_at: now,
          updated_at: now,
          last_error: null,
          receipt: null,
          openclaw: null,
          history: [],
        };
        await writeJobFile(job, DISPATCH_FILE, toJson(record), 'create');
      }

      // Persist the attempt before contacting OpenClaw, so an interrupted delivery stays visible.
      record = await this.#update(job, record, { state: 'requested', attempts: record.attempts + 1 });
      const request: DispatchRequest = {
        request_id: record.request_id,
        app_id: record.app_id,
        job_id: record.job_id,
        instruction_sha256: record.instruction_sha256,
      };
      const delivery = await this.#channel.deliver(request);
      return result(job, await this.#settle(job, record, request, delivery), false);
    });
  }

  async #settle(job: JobDir, record: DispatchRecord, request: DispatchRequest, delivery: Delivery): Promise<DispatchRecord> {
    const finished = (outcome: AttemptEntry['outcome'], openclaw: OpenClawRunRef | null, error: AttemptEntry['error']) => [
      ...record.history,
      { attempt: record.attempts, outcome, finished_at: new Date().toISOString(), openclaw, error },
    ];
    if (delivery.outcome === 'unreachable') {
      const error = { code: 'openclaw_unreachable', message: delivery.reason };
      return this.#update(job, record, { state: 'failed', last_error: error, history: finished('unreachable', null, error) });
    }
    // OpenClaw ran the receiver: keep its actual result, accepted or not.
    const receipt = {
      schema: 'software-factory.openclaw-receipt/v1',
      ...request,
      attempt: record.attempts,
      outcome: delivery.outcome,
      recorded_at: new Date().toISOString(),
      openclaw: delivery.run,
      ...(delivery.outcome === 'accepted' ? { acknowledgement: delivery.acknowledgement } : { reason: delivery.reason }),
    };
    await writeJobFile(job, RECEIPT_FILE, toJson(receipt), 'replace');
    const openclaw: OpenClawRunRef = {
      automation_id: delivery.run.automation_id,
      run_id: delivery.run.run_id,
      status: delivery.run.status,
      completion_status: delivery.run.completion_status,
    };
    if (delivery.outcome === 'accepted') {
      return this.#update(job, record, {
        state: 'accepted',
        last_error: null,
        receipt: RECEIPT_FILE,
        openclaw,
        history: finished('accepted', openclaw, null),
      });
    }
    const error = { code: 'openclaw_not_accepted', message: delivery.reason };
    return this.#update(job, record, {
      state: 'failed',
      last_error: error,
      receipt: RECEIPT_FILE,
      openclaw,
      history: finished('not_accepted', openclaw, error),
    });
  }

  async #update(job: JobDir, record: DispatchRecord, changes: Partial<DispatchRecord>): Promise<DispatchRecord> {
    const next = { ...record, ...changes, revision: record.revision + 1, updated_at: new Date().toISOString() };
    await writeJobFile(job, DISPATCH_FILE, toJson(next), 'replace');
    return next;
  }
}

// Reads and fully validates dispatch.json; undefined when the job has none.
export async function readDispatchRecord(job: JobDir, appId: string, jobId: string): Promise<DispatchRecord | undefined> {
  const buffer = await readJobFile(job, DISPATCH_FILE, MAX_RECORD_BYTES);
  if (buffer === undefined) {
    return undefined;
  }
  const invalid = (reason: string) =>
    new FactoryJobError(
      'invalid_record',
      `${job.path}/${DISPATCH_FILE} is not a valid dispatch record: ${reason} ` +
        `(sha256 ${createHash('sha256').update(buffer).digest('hex')}). It was left unchanged.`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw invalid('not JSON');
  }
  const checked = recordSchema.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw invalid(`${issue?.path.join('.') || 'record'}: ${issue?.message ?? 'invalid'}`);
  }
  const record: DispatchRecord = { ...checked.data, history: checked.data.history ?? [] };
  const problem = recordProblem(record, appId, jobId);
  if (problem !== undefined) {
    throw invalid(problem);
  }
  return record;
}

// An accepted dispatch is replayed (and executed, SF-006) only while its receipt still proves that acceptance.
export async function checkAcceptedReceipt(job: JobDir, record: DispatchRecord): Promise<void> {
  const buffer = await readJobFile(job, RECEIPT_FILE, MAX_RECORD_BYTES);
  let receipt: z.infer<typeof acceptedReceiptSchema> | undefined;
  try {
    receipt = buffer && acceptedReceiptSchema.parse(JSON.parse(buffer.toString('utf8')));
  } catch {
    receipt = undefined;
  }
  const identity = (value: { request_id: string; app_id: string; job_id: string; instruction_sha256: string }) =>
    value.request_id === record.request_id &&
    value.app_id === record.app_id &&
    value.job_id === record.job_id &&
    value.instruction_sha256 === record.instruction_sha256;
  if (
    receipt === undefined ||
    !identity(receipt) ||
    !identity(receipt.acknowledgement) ||
    receipt.openclaw.run_id !== record.openclaw?.run_id ||
    receipt.openclaw.automation_id !== record.openclaw.automation_id
  ) {
    throw new FactoryJobError(
      'invalid_record',
      `${job.path}/${RECEIPT_FILE} is missing or does not prove the accepted dispatch in ${DISPATCH_FILE}. Both were left unchanged.`,
    );
  }
}
