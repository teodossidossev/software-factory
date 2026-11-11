// What a job's state reads as: check (the Report, the review and
// the gate of the last iteration, paged) and status.
import { FactoryError } from '../errors.js';
import { GATE_REVIEWER } from '../gate.js';
import { claudeReviews, type FileChange, type Job } from '../jobs.js';
import { DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES, MIN_PAGE_BYTES, pageBuffer } from '../repo-files.js';
import { actedVerdict, REVIEWER } from '../review.js';
import { withoutDropped } from '../stops.js';
import type { JobStorePort, LivePort, SettingsPort } from './ports.js';
import type { CheckResult, ReviewStatus } from './dto.js';
import { gateSkipped, MAX_REPORT_BYTES, type RunningReview } from './shared.js';

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
  readonly #store: JobStorePort;
  readonly #sessions: LivePort;
  readonly #settings: SettingsPort;

  constructor(store: JobStorePort, sessions: LivePort, settings: SettingsPort) {
    this.#store = store;
    this.#sessions = sessions;
    this.#settings = settings;
  }

  #checkAfter(job: Job): number {
    return job.iteration === 0 ? this.#settings.config.checkAfterStartMin : this.#settings.config.checkAfterFixMin;
  }

  async lastFiles(job: Job): Promise<FileChange[] | undefined> {
    if (job.iteration === 0) {
      return undefined;
    }
    try {
      return (await this.#store.jobs.readMeta(job.workspace, job.ticket, job.iteration)).files;
    } catch { // the iteration's record cannot be read: no files to show
      return undefined;
    }
  }

  async check(workspace: string, ticket: string, offset = 0, maxBytes = DEFAULT_PAGE_BYTES): Promise<CheckResult> {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxBytes) || maxBytes < MIN_PAGE_BYTES || maxBytes > MAX_PAGE_BYTES) {
      throw new FactoryError('invalid_range', `offset must be >= 0 and max_bytes ${MIN_PAGE_BYTES} to ${MAX_PAGE_BYTES}.`);
    }
    const job = await this.#store.job(workspace, ticket);
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
      const { report, patch } = await this.#store.jobs.readIteration(workspace, ticket, job.iteration);
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
    const mr = await this.#store.jobs.readMrText(workspace, ticket);
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
  // Without the Claude review: off, with the gate's status as gate.
  async #reviewStatus(job: Job): Promise<CheckResult['review']> {
    if (job.iteration === 0) {
      return undefined;
    }
    const running = this.#sessions.reviews.get(`${job.workspace}/${job.ticket}`);
    if (!claudeReviews(job)) {
      const gate = this.#settings.config.review ? await this.#gateStatus(job, running) : undefined;
      return gate !== undefined ? { status: 'off', gate } : { status: 'off' };
    }
    const record = await this.#store.jobs.readReview(job.workspace, job.ticket, job.iteration);
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
    if (!this.#settings.config.review) {
      return { status: 'off' };
    }
    return job.state === 'awaiting_review' ? { status: 'running' } : undefined;
  }

  // The gate's status for check, after a clean Claude verdict: like the review's, undefined with the
  // gate off, skipped by the iteration's gate level, and when none will run.
  async #gateStatus(job: Job, running: RunningReview | undefined): Promise<ReviewStatus | undefined> {
    const record = await this.#store.jobs.readGate(job.workspace, job.ticket, job.iteration);
    if (record !== undefined) {
      return 'verdict' in record ? { status: 'done', verdict: record.verdict, summary: record.summary } : { status: 'failed', summary: record.error };
    }
    // Off, or skipped by the iteration's gate level: no gate will run.
    if (!this.#settings.config.gate.on || (await gateSkipped(this.#store.jobs, job))) {
      return undefined;
    }
    if (running?.reviewer === GATE_REVIEWER && running.iteration === job.iteration) {
      return { status: 'running' };
    }
    return job.state === 'awaiting_review' ? { status: 'running' } : undefined;
  }

  async status(workspace?: string, ticket?: string): Promise<Job[]> {
    if (workspace !== undefined && ticket !== undefined) {
      return [await this.#store.job(workspace, ticket)];
    }
    return this.#store.jobs.list();
  }
}
