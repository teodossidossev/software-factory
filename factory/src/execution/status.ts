// What a job's state reads as (SF-089, from src/execution.ts): check (the Report, the review and
// the gate of the last iteration, paged) and status.
import { FactoryError } from '../errors.js';
import { GATE_REVIEWER } from '../gate.js';
import type { FileChange, Job } from '../jobs.js';
import { DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES, MIN_PAGE_BYTES, pageBuffer } from '../repo-files.js';
import { actedVerdict, REVIEWER } from '../review.js';
import { type CheckResult, MAX_REPORT_BYTES, type ReviewStatus, type RunningReview, withoutDropped } from './shared.js';
import type { Core } from './core.js';

function cutUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString('utf8');
}

export class StatusPart {
  readonly core: Core;

  constructor(core: Core) {
    this.core = core;
  }

  #checkAfter(job: Job): number {
    return job.iteration === 0 ? this.core.config.checkAfterStartMin : this.core.config.checkAfterFixMin;
  }

  async lastFiles(job: Job): Promise<FileChange[] | undefined> {
    if (job.iteration === 0) {
      return undefined;
    }
    try {
      return (await this.core.jobs.readMeta(job.workspace, job.ticket, job.iteration)).files;
    } catch {
      return undefined;
    }
  }

  async check(workspace: string, ticket: string, offset = 0, maxBytes = DEFAULT_PAGE_BYTES): Promise<CheckResult> {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxBytes) || maxBytes < MIN_PAGE_BYTES || maxBytes > MAX_PAGE_BYTES) {
      throw new FactoryError('invalid_range', `offset must be >= 0 and max_bytes ${MIN_PAGE_BYTES} to ${MAX_PAGE_BYTES}.`);
    }
    const job = await this.core.job(workspace, ticket);
    const result: CheckResult = {
      state: job.state,
      iteration: job.iteration,
      branch: job.branch,
      since: job.updated_at,
      check_after_minutes: job.state === 'working' || job.state === 'preparing_mr' ? this.#checkAfter(job) : null,
      ...(job.error !== undefined ? { error: job.error } : {}),
    };
    // The last published Report and Patch, in every state but the ones where an iteration runs.
    if (job.iteration > 0 && job.state !== 'working' && job.state !== 'starting') {
      const { report, patch } = await this.core.jobs.readIteration(workspace, ticket, job.iteration);
      result.report = cutUtf8(report, MAX_REPORT_BYTES);
      result.patch = pageBuffer(patch, offset, maxBytes, 'the patch');
      const files = await this.lastFiles(job);
      if (files !== undefined) {
        result.files = {
          sensitive: files.filter((change) => change.sensitive !== 'no').map((change) => ({ path: change.path, declared: change.sensitive === 'declared' })),
          deleted: files.filter((change) => change.status === 'deleted').map((change) => change.path),
        };
      }
    }
    const mr = await this.core.jobs.readMrText(workspace, ticket);
    if (mr !== undefined) {
      result.mr = cutUtf8(mr, MAX_REPORT_BYTES);
    }
    const review = await this.#reviewStatus(job);
    if (review !== undefined) {
      result.review = review;
    }
    return result;
  }

  // The review of the last published iteration: its record once it ended, running while it runs or
  // is due, off with SF_REVIEW=off; undefined before the first iteration and when none will run.
  // After a Claude verdict acted on as clean, gate is the gate's the same way; absent with the gate off.
  async #reviewStatus(job: Job): Promise<CheckResult['review']> {
    if (job.iteration === 0) {
      return undefined;
    }
    const running = this.core.reviews.get(`${job.workspace}/${job.ticket}`);
    const record = await this.core.jobs.readReview(job.workspace, job.ticket, job.iteration);
    if (record !== undefined) {
      if (!('verdict' in record)) {
        return { status: 'failed', summary: record.error };
      }
      const done: CheckResult['review'] = { status: 'done', verdict: record.verdict, summary: record.summary };
      // Acted on as clean, the ledger's dropped items aside (as in resumable): the gate follows.
      const gate = actedVerdict(withoutDropped(record)) === 'clean' ? await this.#gateStatus(job, running) : undefined;
      return gate !== undefined ? { ...done, gate } : done;
    }
    if (running?.reviewer === REVIEWER && running.iteration === job.iteration) {
      return { status: 'running' };
    }
    if (!this.core.config.review) {
      return { status: 'off' };
    }
    return job.state === 'awaiting_review' ? { status: 'running' } : undefined;
  }

  // The gate's status for check, after a clean Claude verdict: like the review's, undefined with the
  // gate off and when none will run.
  async #gateStatus(job: Job, running: RunningReview | undefined): Promise<ReviewStatus | undefined> {
    const record = await this.core.jobs.readGate(job.workspace, job.ticket, job.iteration);
    if (record !== undefined) {
      return 'verdict' in record ? { status: 'done', verdict: record.verdict, summary: record.summary } : { status: 'failed', summary: record.error };
    }
    if (!this.core.config.gate.on) {
      return undefined;
    }
    if (running?.reviewer === GATE_REVIEWER && running.iteration === job.iteration) {
      return { status: 'running' };
    }
    return job.state === 'awaiting_review' ? { status: 'running' } : undefined;
  }

  async status(workspace?: string, ticket?: string): Promise<Job[]> {
    if (workspace !== undefined && ticket !== undefined) {
      return [await this.core.job(workspace, ticket)];
    }
    return this.core.jobs.list();
  }
}
