// The last review after a clean round (ReviewsPart's): one advisory, read-only session per clean
// iteration (src/last-review.ts) that starts as MR preparation starts and runs beside the test step
// and the MR text turn, in a slot of its own (the test step aborts the job's running review). Its
// end, under the lock, writes iterations/NNN/last-review.json and the last_review event, and lets
// an MR preparation that waited for it go on (holds). It never stops, parks or fixes the job: a
// failure or a timeout is recorded as a failed run; a cancelled run (abort, reset, stop(), a newer
// iteration's run) leaves no trace.
import { rm } from 'node:fs/promises';
import { FactoryError } from '../errors.js';
import { type Job, now } from '../jobs.js';
import { copySkill, LAST_REVIEW_TIMEOUT_MS, LAST_REVIEWER, lastReviewComments, type LastReviewOutput, lastReviewPrompt, type LastReviewRecord, runLastReview, skillMethod, type SkillCopy } from '../last-review.js';
import { Redactor } from '../redact.js';
import type { StructuredOutcome } from '../review.js';
import { pathDenials } from '../sandbox-denials.js';
import { factoryTokens } from '../secrets.js';
import { TASK_DIR } from '../task-file.js';
import type { JobStorePort, LivePort, LockPort, RunnerPort, SettingsPort, StopPort } from './ports.js';
import { exists } from './shared.js';

// What LastReviewStep uses: ReviewsPart's ports.
export interface LastReviewStepPorts {
  store: JobStorePort;
  locks: LockPort;
  sessions: LivePort;
  runner: RunnerPort;
  settings: SettingsPort;
  stop: StopPort;
}

// The outcome of one run (runLastReview's).
export type LastReviewOutcome = StructuredOutcome<LastReviewOutput> & { timedOut: boolean };

// A run of the job's last review: the iteration it reads, what cancels it, and the MR
// preparation that waits for its end (holds).
interface LastReviewRun {
  iteration: number;
  controller: AbortController;
  held?: (job: Job) => Promise<void>;
}

// The record of a run: its comments (lastReviewComments) with the skill's copy, or its error (the
// time limit's own sentence when it timed out). A success always comes with the copy: the session
// runs only after it.
export function lastReviewRecord(outcome: LastReviewOutcome, skill: SkillCopy | null): LastReviewRecord {
  const times = { started_at: outcome.startedAt, ended_at: outcome.endedAt };
  if (outcome.ok) {
    return { reviewer: LAST_REVIEWER, ...lastReviewComments(outcome.output), skill: skill!, cost_usd: outcome.costUsd, model: outcome.model, ...times };
  }
  const error = outcome.timedOut ? `The last review timed out after ${LAST_REVIEW_TIMEOUT_MS / 60_000} minutes.` : outcome.message;
  return { reviewer: LAST_REVIEWER, error, timed_out: outcome.timedOut, skill, ...times };
}

const keyOf = (job: Job): string => `${job.workspace}/${job.ticket}`;

export class LastReviewStep {
  readonly #ports: LastReviewStepPorts;
  readonly #store: JobStorePort;
  // The runs under way, by "<workspace>/<ticket>": at most one per job.
  readonly #runs = new Map<string, LastReviewRun>();

  constructor(ports: LastReviewStepPorts) {
    this.#ports = ports;
    this.#store = ports.store;
  }

  // Starts the last review of the job's iteration, once per iteration: nothing when the runner
  // stops, the job has no worktree, a run of this iteration is under way or ended (its
  // last-review.json), or the workspace (as the registry holds it now) names no last_review_skill.
  // A run of an earlier iteration is replaced. It runs outside the lock; its end applies under it
  // (#ended). Only under the lock, in the runner.
  async start(job: Job): Promise<void> {
    const { runner, stop, settings } = this.#ports;
    runner.runnerJob();
    if (stop.isStopping() || job.worktree === null) {
      return;
    }
    const key = keyOf(job);
    const earlier = this.#runs.get(key);
    if (earlier?.iteration === job.iteration) {
      return;
    }
    // A record that cannot be read counts as one: it is never overwritten.
    const record = await this.#store.jobs.readLastReview(job.workspace, job.ticket, job.iteration).catch((error: unknown) => (console.error(error), null));
    if (record !== undefined) {
      return;
    }
    // A workspace that cannot be resolved counts as one without a last review.
    const workspace = await settings.resolve(job.workspace).catch(() => undefined);
    if (workspace?.lastReviewSkill === undefined) {
      return;
    }
    // The run of an earlier iteration is replaced: cancelled, it leaves no trace.
    earlier?.controller.abort();
    const run: LastReviewRun = { iteration: job.iteration, controller: new AbortController() };
    this.#runs.set(key, run);
    this.#run(job, run, workspace.lastReviewSkill, workspace.workCheckout).catch((error: unknown) => console.error(error));
  }

  // Whether an MR preparation of the job has to wait for its iteration's last review: true while a
  // run of job.iteration is under way, which then calls resume, under the lock, at its end.
  holds(job: Job, resume: (job: Job) => Promise<void>): boolean {
    const run = this.#runs.get(keyOf(job));
    if (run === undefined || run.iteration !== job.iteration) {
      return false;
    }
    run.held = resume;
    return true;
  }

  // Whether a run is under way (the runner stays while one is).
  running(): boolean {
    return this.#runs.size > 0;
  }

  // Cancels every run (stop()): their end is never applied, and no MR preparation they held goes on.
  stopAll(): void {
    for (const run of this.#runs.values()) {
      run.controller.abort();
    }
    this.#runs.clear();
  }

  // The job's copy of the skill: the one it has, else a new copy of source (a folder its runner
  // left without last-review-skill.json is removed first).
  async #skill(job: Job, source: string): Promise<SkillCopy> {
    const { workspace, ticket } = job;
    const dir = this.#store.jobs.lastReviewSkillDir(workspace, ticket);
    const copy = await this.#store.jobs.readLastReviewSkill(workspace, ticket);
    if (copy !== undefined && (await exists(dir))) {
      return copy;
    }
    await rm(dir, { recursive: true, force: true });
    const made = await copySkill(source, dir);
    await this.#store.jobs.writeLastReviewSkill(workspace, ticket, made);
    return made;
  }

  // The run: the skill's copy, the input (the factory's copy of the Task file, the iteration's
  // Patch, the copy's method), then the session (the review's settings, SF_REVIEW_MODEL, the job's
  // path denials; no live messages, no images). Any error before the session ends is a failed run.
  // The output and a failure message are redacted; then the sandbox's leftovers go and the end
  // applies under the lock.
  async #run(job: Job, run: LastReviewRun, source: string, checkout: string): Promise<void> {
    const { settings, sessions, locks } = this.#ports;
    const { config } = settings;
    const { workspace, ticket, iteration } = job;
    const worktree = job.worktree!;
    const redactor = new Redactor({ cwd: worktree, secrets: await factoryTokens(config) });
    let skill: SkillCopy | null = null;
    let outcome: LastReviewOutcome;
    try {
      skill = await this.#skill(job, source);
      const task = await this.#store.jobs.readReviewTask(workspace, ticket);
      if (task === undefined) {
        throw new Error(`the job has no copy of ${TASK_DIR}/${ticket}.md`);
      }
      const [{ patch }, meta] = await Promise.all([this.#store.jobs.readIteration(workspace, ticket, iteration), this.#store.jobs.readMeta(workspace, ticket, iteration)]);
      const method = await skillMethod(this.#store.jobs.lastReviewSkillDir(workspace, ticket));
      outcome = await runLastReview(lastReviewPrompt({ ticket, iteration, task, patch, patchTruncated: meta.patch_truncated, method }), {
        cwd: worktree, claudePath: config.claudePath, sandbox: config.sandbox, model: config.reviewModel, effort: config.reviewEffort, maxTurns: config.reviewMaxTurns, signal: run.controller.signal,
        pathDenials: (sessionTmp) => pathDenials({ session: 'job', workspace, checkout, worktree, stateDir: config.stateDir, worktreeRoot: config.worktreeRoot, sessionTmp }),
      });
    } catch (error) {
      const at = now();
      const text = error instanceof Error ? error.message : String(error);
      const message = error instanceof FactoryError && error.code === 'last_review_skill' ? text : `The last review could not start: ${text}`;
      outcome = { ok: false, message: message.slice(0, 1000), model: null, startedAt: at, endedAt: at, timedOut: false };
    }
    outcome = outcome.ok ? { ...outcome, output: redactor.output(outcome.output) } : { ...outcome, message: redactor.failure(outcome.message) };
    const ended = outcome;
    await sessions.afterSession(job).catch((error: unknown) => console.error(error));
    await locks.locked(() => this.#ended(job, run, skill, ended));
  }

  // The end of a run. A cancelled one, or one of a job that is gone or another, leaves no trace.
  // Otherwise the iteration's last-review.json and the last_review event are written (ignored:
  // the job is past the run's iteration); then an MR preparation it held goes on, when the job is
  // still preparing_mr at the run's iteration, with the job as it is now.
  async #ended(started: Job, run: LastReviewRun, skill: SkillCopy | null, outcome: LastReviewOutcome): Promise<void> {
    const { workspace, ticket } = started;
    const key = keyOf(started);
    if (this.#runs.get(key) !== run || run.controller.signal.aborted) {
      return;
    }
    this.#runs.delete(key);
    const job = await this.#store.jobs.read(workspace, ticket);
    if (job === undefined || job.created_at !== started.created_at) {
      return;
    }
    try {
      const record = lastReviewRecord(outcome, skill);
      await this.#store.jobs.writeLastReview(workspace, ticket, run.iteration, record);
      await this.#store.jobs.appendEvent(workspace, ticket, {
        ts: now(), iteration: run.iteration, type: 'last_review', comments: 'comments' in record ? record.comments.length : 0,
        ...('error' in record ? { error: record.error } : {}), ...('error' in record && record.timed_out ? { timed_out: true as const } : {}),
        ...(job.iteration !== run.iteration ? { ignored: true as const } : {}),
      });
    } catch (error) {
      console.error(error);
    }
    if (run.held !== undefined && job.state === 'preparing_mr' && job.iteration === run.iteration) {
      // mrIdle stops the job itself on its own failures.
      await run.held(job).catch((error: unknown) => console.error(error));
    }
  }
}
