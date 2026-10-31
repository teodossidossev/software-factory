// Canonical Markdown instructions: factory-data/apps/<app-id>/jobs/<job-id>/instruction.md.
// Creation is exclusive, updates are compare-and-swap on the current SHA-256,
// and an instruction is frozen once a dispatch exists for its job.
import { createHash } from 'node:crypto';
import {
  checkSha256,
  FactoryJobError,
  FactoryJobs,
  jobFileExists,
  readJobFile,
  writeJobFile,
  type JobDir,
} from './factory-jobs.js';

export const INSTRUCTION_FILE = 'instruction.md';
export const DISPATCH_FILE = 'dispatch.json';
export const MAX_INSTRUCTION_BYTES = 256 * 1024;

export interface WriteInstructionRequest {
  app_id: string;
  job_id: string;
  content: string;
  expected_sha256?: string | undefined;
}

export interface WriteInstructionResult {
  path: string;
  status: 'created' | 'updated' | 'unchanged';
  bytes: number;
  sha256: string;
}

export interface StoredInstruction {
  path: string;
  bytes: number;
  sha256: string;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function encode(content: string): Buffer {
  if (/\p{Surrogate}/u.test(content) || content.includes('\0')) {
    throw new FactoryJobError('invalid_content', 'content must be well-formed UTF-8 text without NUL characters.');
  }
  if (content.trim().length === 0) {
    throw new FactoryJobError('invalid_content', 'content must not be blank.');
  }
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.byteLength > MAX_INSTRUCTION_BYTES) {
    throw new FactoryJobError('too_large', `content is larger than ${MAX_INSTRUCTION_BYTES} bytes of UTF-8.`);
  }
  return buffer;
}

export async function readInstruction(job: JobDir): Promise<StoredInstruction | undefined> {
  const buffer = await readJobFile(job, INSTRUCTION_FILE, MAX_INSTRUCTION_BYTES);
  return buffer && { path: `${job.path}/${INSTRUCTION_FILE}`, bytes: buffer.byteLength, sha256: sha256(buffer) };
}

export class InstructionStore {
  readonly #jobs: FactoryJobs;

  constructor(jobs: FactoryJobs) {
    this.#jobs = jobs;
  }

  async write(request: WriteInstructionRequest): Promise<WriteInstructionResult> {
    if (request.expected_sha256 !== undefined) {
      checkSha256(request.expected_sha256);
    }
    const buffer = encode(request.content);
    const next = { bytes: buffer.byteLength, sha256: sha256(buffer) };

    return this.#jobs.withJob(request.app_id, request.job_id, true, async (job) => {
      const path = `${job.path}/${INSTRUCTION_FILE}`;
      const current = await readInstruction(job);
      // Identical content is a no-op whatever expected_sha256 says, so a retried update is harmless.
      if (current?.sha256 === next.sha256) {
        return { path, status: 'unchanged', ...next };
      }
      if (current === undefined) {
        if (request.expected_sha256 !== undefined) {
          throw new FactoryJobError('conflict', `${path} does not exist; omit expected_sha256 to create it.`);
        }
        await writeJobFile(job, INSTRUCTION_FILE, buffer, 'create');
        return { path, status: 'created', ...next };
      }
      if (await jobFileExists(job, DISPATCH_FILE)) {
        throw new FactoryJobError('dispatched', `${path} was already requested for dispatch and can no longer change.`);
      }
      if (request.expected_sha256 !== current.sha256) {
        throw new FactoryJobError(
          'conflict',
          `${path} has sha256 ${current.sha256}; pass it as expected_sha256 to replace the instruction.`,
        );
      }
      await writeJobFile(job, INSTRUCTION_FILE, buffer, 'replace');
      return { path, status: 'updated', ...next };
    });
  }
}
