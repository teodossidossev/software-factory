// The review and gate pipeline (SF-089, from src/execution.ts): the Claude review of an iteration
// (SF-038), the Codex gate (SF-039) at the iteration's gate level (SF-092), the ledger of findings
// (settle, SF-052), the user's retry of a failed review (SF-044) and override of a stopped gate
// (SF-047), and the simplification pass after a clean verdict (SF-055).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ImageRef, imageRefs } from '../attachments.js';
import { FactoryError } from '../errors.js';
import { gateDecision } from '../gate-level.js';
import { GATE_REVIEWER, type GateOutcome, gatePrompt, noTokens, runGate } from '../gate.js';
import { type GateOverride, type GateRecord, type IterationMeta, type Job, type JobState, now, type ReviewRecord, type SimplifyRecord } from '../jobs.js';
import { applyVerdict, isSimplification, SIMPLIFIER, type Applied, type Decision, DECISIONS, LEDGER_ID, FACTORY_PROBLEMS, settle, SETTLE_CODES, unappliedEntries, unsettled } from '../ledger.js';
import { Redactor } from '../redact.js';
import { readJobRules } from '../rules-docs.js';
import { actedVerdict, decide, type Verdict, fixContent, oneLine, REVIEWER, type ReviewInput, type ReviewItem, type ReviewOutcome, type ReviewOutput, reviewPrompt, runReview, type StructuredOutcome, unacceptedItems } from '../review.js';
import { changedBetween, type FixFiles, fixNumbers, guardSuggestions, offerMessage, runSimplify, SIMPLIFY_CODE, SIMPLIFY_TITLE, simplifyFix, type SimplifyInput, type SimplifyOutput, simplifyPrompt, type Suggestion } from '../simplify.js';
import { mayTouch, parseFrontMatter, readTask, TASK_DIR } from '../task-file.js';
import { type UsageLimit, usageLimit } from '../usage-limit.js';
import { exists, GATE_OVERRIDE_CODES, LEDGER_ACCEPT_CODES, markedGroups, type RunningReview, withoutDropped } from './shared.js';
import type { Core } from './core.js';

// The offer of the simplification pass (SF-055): sf accept is its Skip.
const ACCEPT_CODES: readonly string[] = [...GATE_OVERRIDE_CODES, ...LEDGER_ACCEPT_CODES, SIMPLIFY_CODE];

export class ReviewsPart {
  readonly core: Core;

  constructor(core: Core) {
    this.core = core;
  }

  // The job's images as prompt images (SF-065): the job's own copy, with the alt texts of the Task
  // text given (the one the agent reads); [] without images.
  imageRefs(job: Job, task: string): ImageRef[] {
    return imageRefs(job.ticket, this.core.jobs.attachmentsDir(job.workspace, job.ticket), job.attachments ?? [], task);
  }

  // Starts the Claude review of the job's last iteration; it runs outside the lock. A review still
  // running for the job is cancelled. Nothing with SF_REVIEW=off.
  startReview(job: Job): void {
    this.core.runnerJob();
    if (!this.core.config.review || this.core.stopping) {
      return;
    }
    const key = `${job.workspace}/${job.ticket}`;
    this.core.reviews.get(key)?.controller.abort();
    const running: RunningReview = { reviewer: REVIEWER, iteration: job.iteration, controller: new AbortController() };
    this.core.reviews.set(key, running);
    this.#review(job, running).catch((error: unknown) => console.error(error));
  }

  // The user's retry of a failed review (sf review, the dashboard's Retry review): the job goes
  // back to awaiting_review without a new iteration, the failed review.json goes, and the review
  // of the last iteration runs again.
  retryReview(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number }> {
    return this.core.parts.control.request(workspaceName, ticket, { kind: 'review' }) as Promise<{ state: JobState; iteration: number }>;
  }

  // sf review needs the review on and a job that a failed review handed to the user.
  checkRetryReview(job: Job): void {
    if (!this.core.config.review) {
      throw new FactoryError('review_off', 'The Claude review is off (SF_REVIEW=off); nothing would review the iteration.');
    }
    if (job.state !== 'needs_human' || job.error?.code !== 'review_failed') {
      throw new FactoryError('invalid_state', `sf review needs needs_human after a failed review (review_failed); the job is ${job.state}${job.error !== undefined ? ` (${job.error.code})` : ''}.`);
    }
  }

  // The retry in the runner.
  retryReviewInRunner(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number }> {
    return this.core.locked(async () => {
      const job = await this.core.job(workspaceName, ticket);
      this.checkRetryReview(job);
      if (job.worktree === null || !(await exists(job.worktree))) {
        throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
      }
      await this.core.jobs.removeReview(workspaceName, ticket, job.iteration);
      // from: needs_human (checkRetryReview)
      const next = await this.core.transition(job, 'awaiting_review', 'review_retry');
      this.startReview(next);
      return { state: next.state, iteration: next.iteration };
    });
  }

  // The user's override of a stopped gate (sf accept, the dashboard's Accept and prepare MR): a job
  // the gate handed over (needs_human with gate_rounds, gate_budget or gate_failed) whose last
  // iteration has a clean Claude review goes on as after a clean gate, to MR preparation with the
  // paths Claude accepted. The override is recorded first: gate-override.json with the Codex
  // items not applied (or the gate's error) and a gate_overridden event.
  acceptGate(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.core.parts.control.request(workspaceName, ticket, { kind: 'accept' }) as Promise<{ state: JobState; iteration: number; branch: string }>;
  }

  // The code the gate (or the ledger, SF-052) stopped with; invalid_state unless it is one sf
  // accept takes on.
  checkAcceptGate(job: Job): string {
    const code = job.error?.code;
    if (job.state !== 'needs_human' || code === undefined || !ACCEPT_CODES.includes(code)) {
      throw new FactoryError('invalid_state', `sf accept needs needs_human after the gate or the ledger stopped the job, or the simplification pass offered suggestions (${ACCEPT_CODES.join(', ')}); the job is ${job.state}${code !== undefined ? ` (${code})` : ''}.`);
    }
    return code;
  }

  // What an Accept over a ledger stop (review_churn, review_disputed) goes without: the ledger's
  // open findings with their ids, and the items of the iteration's gate that neither reopen one of
  // them nor were dropped.
  async #ledgerUnapplied(job: Job, gate: GateRecord | undefined): Promise<Array<ReviewItem & { id?: string }>> {
    const ledger = await this.core.jobs.readLedger(job.workspace, job.ticket);
    const open = unappliedEntries(ledger);
    const ids = new Set(open.map((entry) => entry.id));
    const accepted = new Set(ledger.filter((entry) => entry.status === 'accepted_risk').map((entry) => entry.id));
    const rest = gate !== undefined && 'verdict' in gate
      ? gate.items.filter((item) => !ids.has(item.reopens ?? '') && !accepted.has(item.reopens ?? ''))
      : [];
    return [...open, ...rest];
  }

  // The override in the runner.
  acceptGateInRunner(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.core.locked(async () => {
      const job = await this.core.job(workspaceName, ticket);
      const code = this.checkAcceptGate(job);
      const review = job.iteration > 0 ? await this.core.jobs.readReview(workspaceName, ticket, job.iteration) : undefined;
      // Items the ledger dropped (they reopened an accepted risk, SF-052) never count.
      if (review === undefined || !('verdict' in review) || actedVerdict(withoutDropped(review)) !== 'clean') {
        const what = review === undefined ? 'has none' : !('verdict' in review) ? 'failed' : review.verdict === 'fix' ? 'says fix' : 'says clean with a blocker or major item';
        throw new FactoryError('invalid_state', `sf accept needs a clean Claude review of the last iteration (${job.iteration}); it ${what}.`);
      }
      const unaccepted = await this.unaccepted(job, review.accepted_sensitive);
      if (unaccepted.length > 0) {
        throw new FactoryError('invalid_state', `sf accept needs a clean Claude review of the last iteration (${job.iteration}); it does not accept the ${markedGroups(unaccepted).map((group) => `${group.label} ${group.paths.join(', ')}`).join(' and the ')}.`);
      }
      const gate = await this.core.jobs.readGate(workspaceName, ticket, job.iteration);
      if (code === SIMPLIFY_CODE) {
        // Skip (SF-055): MR preparation as after the clean gate, with the paths both reviewers
        // accepted; simplify.json is marked skipped, so the suggestions go into the MR text (mrIdle).
        // No gate override: the gate was clean.
        const record = await this.core.jobs.readSimplify(workspaceName, ticket, job.iteration);
        const sensitive = [...new Set([...review.accepted_sensitive, ...(gate !== undefined && 'verdict' in gate ? gate.accepted_sensitive : [])])];
        return this.core.parts.mr.prepareMr(job, sensitive, { onAccepted: async () => {
          const at = now();
          if (record !== undefined && 'suggestions' in record) {
            await this.core.jobs.writeSimplify(workspaceName, ticket, job.iteration, { ...record, skipped_at: at });
          }
          await this.core.jobs.appendEvent(workspaceName, ticket, {
            ts: at, iteration: job.iteration, type: 'simplify_chosen', choice: 'skip', suggestions: record !== undefined && 'suggestions' in record ? record.suggestions.length : 0,
          });
        } });
      }
      const unapplied = LEDGER_ACCEPT_CODES.includes(code)
        ? await this.#ledgerUnapplied(job, gate)
        : gate === undefined ? [] : 'verdict' in gate ? gate.items : gate.error;
      const override: GateOverride = { at: now(), code, unapplied };
      return this.core.parts.mr.prepareMr(job, review.accepted_sensitive, { onAccepted: async () => {
        await this.core.jobs.writeGateOverride(workspaceName, ticket, job.iteration, override);
        await this.core.jobs.appendEvent(workspaceName, ticket, {
          ts: override.at, iteration: job.iteration, type: 'gate_overridden', code: override.code,
          unapplied: Array.isArray(override.unapplied) ? override.unapplied.length : 0,
        });
      } });
    });
  }

  // The user's settlement of an escalated or contested ledger entry (SF-052: sf settle, the
  // dashboard's Accept risk and Must fix) while the job is needs_human: accept makes it
  // accepted_risk, fix user_fix. Once an escalated or review_disputed stop has no escalated entry
  // and no disputed contest left, the job goes on by itself: a Fix section with the fixes the user
  // decided, or else the review that was stopped runs again. After review_churn the settlement is
  // only recorded; sf say goes on.
  settle(workspaceName: string, ticket: string, id: string, decision: Decision, note = ''): Promise<{ state: JobState; id: string; status: string; waiting: string[] }> {
    return this.core.parts.control.request(workspaceName, ticket, { kind: 'settle', id, decision, note }) as Promise<{ state: JobState; id: string; status: string; waiting: string[] }>;
  }

  // sf settle needs needs_human, a ledger id, accept or fix, and a note of plain text; the entry
  // itself is checked against the ledger in the runner.
  checkSettle(job: Job, id: string, decision: string, note: string): void {
    if (job.state !== 'needs_human') {
      throw new FactoryError('invalid_state', `sf settle needs needs_human; the job is ${job.state}.`);
    }
    if (!LEDGER_ID.test(id)) {
      throw new FactoryError('invalid_content', 'id must be a ledger id such as R7.');
    }
    if (!(DECISIONS as readonly string[]).includes(decision)) {
      throw new FactoryError('invalid_content', 'decision must be accept or fix.');
    }
    if (note.includes('\0') || note.length > 2000) {
      throw new FactoryError('invalid_content', 'note must be text of at most 2000 characters.');
    }
  }

  // The settlement in the runner.
  settleInRunner(workspaceName: string, ticket: string, id: string, decision: Decision, note: string): Promise<{ state: JobState; id: string; status: string; waiting: string[] }> {
    return this.core.locked(async () => {
      const job = await this.core.job(workspaceName, ticket);
      this.checkSettle(job, id, decision, note);
      const ledger = settle(await this.core.jobs.readLedger(workspaceName, ticket), id, decision, note, now());
      if (typeof ledger === 'string') {
        throw new FactoryError('invalid_state', ledger);
      }
      await this.core.jobs.writeLedger(workspaceName, ticket, ledger);
      const status = ledger.find((entry) => entry.id === id)!.status;
      const waiting = unsettled(ledger).map((entry) => entry.id);
      const code = job.error?.code;
      if (waiting.length > 0 || code === undefined || !SETTLE_CODES.includes(code)) {
        return { state: job.state, id, status, waiting };
      }
      return { state: await this.core.parts.turns.goOn(job, ledger), id, status, waiting };
    });
  }

  // The material of a review of the job's last iteration, the Task file read in the worktree.
  async #reviewInput(job: Job, worktree: string): Promise<ReviewInput> {
    const { workspace: name, ticket, iteration } = job;
    const { report, patch } = await this.core.jobs.readIteration(name, ticket, iteration);
    const meta = await this.core.jobs.readMeta(name, ticket, iteration);
    return {
      ticket, iteration, report, patch, patchTruncated: meta.patch_truncated, files: meta.files, handbook: this.core.handbook,
      task: await readFile(join(worktree, TASK_DIR, `${ticket}.md`), 'utf8'), ledger: await this.core.jobs.readLedger(name, ticket),
      rules: await readJobRules(this.core.jobs.dir(name, ticket)),
    };
  }

  // Runs the review session, then applies its outcome under the lock.
  async #review(job: Job, running: RunningReview): Promise<void> {
    let outcome: ReviewOutcome;
    const redactor = new Redactor({ cwd: job.worktree ?? '' });
    try {
      if (job.worktree === null) {
        throw new Error('the job has no worktree');
      }
      const input = await this.#reviewInput(job, job.worktree);
      outcome = await runReview(reviewPrompt(input), {
        cwd: job.worktree, claudePath: this.core.config.claudePath, sandbox: this.core.config.sandbox, model: this.core.config.reviewModel,
        maxTurns: this.core.config.reviewMaxTurns, signal: running.controller.signal, images: this.imageRefs(job, input.task),
        // The session live in events.jsonl (SF-045).
        onMessage: (message) => this.core.appendLive(job, 'review_message', redactor.reviewMessage(message)),
      });
    } catch (error) {
      const at = now();
      outcome = { ok: false, message: `The review could not start: ${(error as Error).message}`.slice(0, 1000), startedAt: at, endedAt: at };
    }
    // A usage limit (SF-072) is read from the message as the session wrote it, before redaction.
    const limit = outcome.ok ? undefined : usageLimit(outcome.message, new Date(), 'claude');
    // The failure message goes to review.json, the event and the job's error: withheld or redacted
    // like the session's prose (src/redact.ts, failure).
    if (!outcome.ok) {
      outcome = { ...outcome, message: redactor.failure(outcome.message) };
    }
    const ended = outcome;
    await this.core.afterSession(job);
    await this.core.locked(() => this.#reviewed(job, running, ended, limit));
  }

  // The end of a review. A cancelled one leaves no trace. One that hit a usage limit (limit) while
  // the job still awaits review of the same iteration parks the job (SF-072) and writes nothing of
  // the round. Otherwise review.json and the event are written; the verdict applies only while the
  // job still awaits review of the same iteration.
  async #reviewed(reviewed: Job, running: RunningReview, outcome: ReviewOutcome, limit?: UsageLimit): Promise<void> {
    const { workspace: name, ticket, iteration } = reviewed;
    const key = `${name}/${ticket}`;
    if (this.core.reviews.get(key) !== running || running.controller.signal.aborted) {
      return;
    }
    this.core.reviews.delete(key);
    const job = await this.core.jobs.read(name, ticket);
    // Another job of the ticket (after a reset) is not this review's.
    if (job === undefined || job.created_at !== reviewed.created_at) {
      return;
    }
    const current = job.state === 'awaiting_review' && job.iteration === iteration;
    if (current && limit !== undefined) {
      await this.core.parts.control.park(job, 'review', limit);
      return;
    }
    const ignored = current ? {} : { ignored: true as const };
    const record: ReviewRecord = outcome.ok
      ? { reviewer: REVIEWER, ...outcome.output, cost_usd: outcome.costUsd, started_at: outcome.startedAt, ended_at: outcome.endedAt }
      : { reviewer: REVIEWER, error: outcome.message };
    await this.core.jobs.writeReview(name, ticket, iteration, record);
    await this.core.jobs.appendEvent(name, ticket, outcome.ok
      ? { ts: now(), iteration, type: 'review', reviewer: REVIEWER, ...(await this.#verdictOf(job, outcome.output)), items: outcome.output.items.length, ...ignored }
      : { ts: now(), iteration, type: 'review_failed', reviewer: REVIEWER, error: outcome.message, ...ignored });
    if (!current) {
      return;
    }
    if (!outcome.ok) {
      // from: awaiting_review (current)
      await this.core.transition(job, 'needs_human', 'verdict', { code: 'review_failed', message: outcome.message });
      return;
    }
    await this.applying(job, () => this.afterClaude(job, outcome.output));
  }

  // The undeclared sensitive paths and the paths outside the Task's scope (SF-053) of the job's
  // last iteration not in accepted, nor accepted by the user as a risk (SF-052), as fix items.
  async unaccepted(job: Job, accepted: string[]): Promise<ReviewItem[]> {
    const byUser = await this.#markedAcceptedByUser(job);
    return unacceptedItems((await this.core.parts.status.lastFiles(job)) ?? [], [...accepted, ...byUser]);
  }

  // The marked paths (undeclared sensitive, outside the Task's scope) whose ledger entry the user
  // settled as an accepted risk.
  async #markedAcceptedByUser(job: Job): Promise<string[]> {
    return (await this.core.jobs.readLedger(job.workspace, job.ticket))
      .filter((entry) => entry.status === 'accepted_risk' && FACTORY_PROBLEMS.includes(entry.problem))
      .map((entry) => entry.path);
  }

  // The reviewer's verdict for the event, with the one the factory acts on (decide) when it differs.
  async #verdictOf(job: Job, output: ReviewOutput): Promise<{ verdict: Verdict; effective?: Verdict }> {
    const effective = decide(output, await this.unaccepted(job, output.accepted_sensitive)).verdict;
    return effective === output.verdict ? { verdict: output.verdict } : { verdict: output.verdict, effective };
  }

  // The Claude verdict as the factory acts on it (decide, SF-051): fix (a blocker or major item, or
  // an undeclared sensitive path or a path outside the Task's scope it does not accept) is the
  // next Fix section; clean (a fix with nits only too) starts the gate, or with the gate off runs
  // Clean. Only under the lock.
  // The ledger applies first (SF-052, #applyLedger): a dropped item never counts, a dispute or
  // churn hands the job to the user.
  async afterClaude(job: Job, output: ReviewOutput): Promise<void> {
    const { summary, accepted_sensitive: accepted } = output;
    const applied = await this.#applyLedger(job, REVIEWER, output);
    if (applied.kind === 'stop') {
      // from: awaiting_review (#reviewed current, #pickUp through resumable)
      await this.core.transition(job, 'needs_human', 'verdict', { code: applied.code, message: applied.message });
    } else if (applied.kind === 'fix') {
      await this.core.parts.turns.fix(job, fixContent(summary, applied.items), { ledger: applied.ledger });
    } else if (this.core.config.gate.on && (await this.#gateRuns(job))) {
      await this.startGate(job, output);
    } else {
      // The gate off, or skipped by the iteration's gate level (SF-092): the same way to Clean.
      await this.afterClean(job, accepted);
    }
  }

  // Whether the gate runs on the job's last iteration, by its gate level (SF-092,
  // src/gate-level.ts): decided once per iteration, before the gate's budget check, so a gate that
  // does not run never stops on gate_budget. A decision already recorded in gate-level.json (the
  // job picked up again after a pause, a park or a restart of sf serve) is used as it is; otherwise
  // the level is decided from the job's change at the iteration (its meta.json files) and the
  // Task's may_touch, and recorded with its gate_level event. Only under the lock.
  async #gateRuns(job: Job): Promise<boolean> {
    const { workspace, ticket, iteration } = job;
    const recorded = await this.core.jobs.readGateLevel(workspace, ticket, iteration);
    if (recorded !== undefined) {
      return recorded.ran;
    }
    let meta: IterationMeta | undefined;
    try {
      meta = await this.core.jobs.readMeta(workspace, ticket, iteration);
    } catch (error) {
      // No file list: the level cannot be known, so it is full.
      console.error(error);
    }
    const { config } = this.core;
    const decision = gateDecision({
      files: meta?.files, patchTruncated: meta?.patch_truncated === true, mayTouch: await this.#mayTouch(job), setting: config.gateLevel, fullPaths: config.gateFullPaths,
      sensitivePaths: config.sensitivePaths,
    }, job.gate_fixes);
    const at = now();
    await this.core.jobs.writeGateLevel(workspace, ticket, iteration, { ...decision, at });
    await this.core.jobs.appendEvent(workspace, ticket, { ts: at, iteration, type: 'gate_level', level: decision.level, ran: decision.ran, reasons: decision.reasons });
    return decision.ran;
  }

  // The may_touch of the Task file in the work checkout, as the marks of the job's files read it
  // (never the worktree's copy, which the Implementer could edit); undefined when it cannot be read
  // (the level is then full).
  async #mayTouch(job: Job): Promise<string[] | undefined> {
    try {
      return mayTouch(parseFrontMatter(await readTask(await this.core.resolve(job.workspace), job.ticket)) ?? new Map<string, string>());
    } catch (error) {
      console.error(error);
      return undefined;
    }
  }

  // The ledger applied to a reviewer's verdict on the job's last iteration (SF-052, applyVerdict):
  // the items that reopen an accepted risk are recorded as dropped in review.json or gate.json,
  // and the ledger is written unless the verdict is a fix (fix writes it with its Fix section).
  // Only under the lock.
  async #applyLedger(job: Job, reviewer: typeof REVIEWER | typeof GATE_REVIEWER, output: ReviewOutput): Promise<Applied> {
    const { workspace, ticket, iteration } = job;
    const applied = applyVerdict({
      ledger: await this.core.jobs.readLedger(workspace, ticket), items: output.items, extra: await this.unaccepted(job, output.accepted_sensitive), reviewer, iteration,
    });
    if (applied.dropped.length > 0) {
      const record = reviewer === REVIEWER ? await this.core.jobs.readReview(workspace, ticket, iteration) : await this.core.jobs.readGate(workspace, ticket, iteration);
      if (record !== undefined && 'verdict' in record) {
        const marked = { ...record, dropped: applied.dropped };
        await (reviewer === REVIEWER ? this.core.jobs.writeReview(workspace, ticket, iteration, marked as ReviewRecord) : this.core.jobs.writeGate(workspace, ticket, iteration, marked as GateRecord));
      }
    }
    if (applied.kind !== 'fix') {
      await this.core.jobs.writeLedger(workspace, ticket, applied.ledger);
    }
    return applied;
  }

  // Applies a verdict (work) to a job awaiting review; a failure to apply it hands the job to the
  // user. Only under the lock.
  async applying(job: Job, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      // iteration_limit has already handed the job to the user.
      if (error instanceof FactoryError && error.code === 'iteration_limit') {
        return;
      }
      console.error(error);
      const latest = await this.core.jobs.read(job.workspace, job.ticket);
      if (latest?.state === 'awaiting_review') {
        const code = error instanceof FactoryError ? error.code : 'review_failed';
        // from: awaiting_review (the guard above)
        await this.core.transition(latest, 'needs_human', 'verdict', { code, message: `The review's verdict could not be applied: ${(error as Error).message}`.slice(0, 1000) });
      }
    }
  }

  // Starts the gate after a clean Claude verdict (claude) whose gate level runs it (SF-092); it runs
  // outside the lock. A job whose gate runs used up SF_GATE_MAX_TOKENS goes to the user instead.
  // Only under the lock.
  async startGate(job: Job, claude: ReviewOutput): Promise<void> {
    if (job.gate_tokens >= this.core.config.gateMaxTokens) {
      // from: awaiting_review (afterClaude, and goOn after its transition)
      await this.core.transition(job, 'needs_human', 'verdict', {
        code: 'gate_budget',
        message: `The gate runs of this job used ${job.gate_tokens} tokens, the limit of SF_GATE_MAX_TOKENS (${this.core.config.gateMaxTokens}); the user decides how to go on.`,
      });
      return;
    }
    this.core.runnerJob();
    if (this.core.stopping) {
      return;
    }
    const key = `${job.workspace}/${job.ticket}`;
    this.core.reviews.get(key)?.controller.abort();
    const running: RunningReview = { reviewer: GATE_REVIEWER, iteration: job.iteration, controller: new AbortController() };
    this.core.reviews.set(key, running);
    this.#gate(job, running, claude).catch((error: unknown) => console.error(error));
  }

  // Runs the gate, then applies its outcome under the lock.
  async #gate(job: Job, running: RunningReview, claude: ReviewOutput): Promise<void> {
    const { workspace: name, ticket, iteration } = job;
    const gate = this.core.config.gate;
    let outcome: GateOutcome;
    const redactor = new Redactor({ cwd: job.worktree ?? '' });
    try {
      if (job.worktree === null || job.base_commit === null || !gate.on) {
        throw new Error('the job has no worktree or base commit');
      }
      const input = await this.#reviewInput(job, job.worktree);
      outcome = await runGate(gatePrompt({ ...input, baseCommit: job.base_commit }), {
        codexPath: gate.codexPath, cwd: job.worktree, dir: this.core.jobs.iterationDir(name, ticket, iteration), model: this.core.config.codexModel,
        images: this.imageRefs(job, input.task).map((image) => image.path),
        timeoutMs: this.core.config.gateTimeoutMs, signal: running.controller.signal,
        // The run live in events.jsonl (SF-045).
        onEvent: (event) => this.core.appendLive(job, 'gate_event', redactor.codexEvent(event)),
      });
    } catch (error) {
      const at = now();
      outcome = { ok: false, message: `The gate could not start: ${(error as Error).message}`.slice(0, 1000), tokens: noTokens(), startedAt: at, endedAt: at };
    }
    // A usage limit of the plan (SF-072), read before redaction.
    const limit = outcome.ok ? undefined : usageLimit(outcome.message, new Date(), 'codex');
    // The failure message (Codex's stderr or error event) goes to gate.json, the event and the
    // job's error: withheld or redacted like the run's prose (src/redact.ts, failure).
    if (!outcome.ok) {
      outcome = { ...outcome, message: redactor.failure(outcome.message) };
    }
    const ended = outcome;
    await this.core.afterSession(job);
    await this.core.locked(() => this.#gated(job, running, claude, ended, limit));
  }

  // The end of a gate run. A cancelled one leaves no trace. Otherwise its tokens count for the job,
  // gate.json and the event are written, and the verdict applies only while the job still awaits
  // review of the same iteration, as the factory acts on it (decide, SF-051): clean (a fix with nits
  // only too) runs Clean with the paths both reviewers accepted, fix (a blocker or major item, or an
  // undeclared sensitive path or a path outside the Task's scope the gate does not accept) is the
  // next Fix section unless the gate's rounds are used up. A run that hit a usage limit (limit) while
  // the job still awaits review of the same iteration parks the job (SF-072): no gate.json, no event,
  // no tokens charged.
  async #gated(gated: Job, running: RunningReview, claude: ReviewOutput, outcome: GateOutcome, limit?: UsageLimit): Promise<void> {
    const { workspace: name, ticket, iteration } = gated;
    const key = `${name}/${ticket}`;
    if (this.core.reviews.get(key) !== running || running.controller.signal.aborted) {
      return;
    }
    this.core.reviews.delete(key);
    const read = await this.core.jobs.read(name, ticket);
    if (read === undefined || read.created_at !== gated.created_at) {
      return;
    }
    const current = read.state === 'awaiting_review' && read.iteration === iteration;
    // A run that hit a usage limit is discarded whole (SF-072): its tokens are not charged either,
    // so a parked and rerun round never counts toward SF_GATE_MAX_TOKENS.
    if (current && limit !== undefined) {
      await this.core.parts.control.park(read, 'gate', limit);
      return;
    }
    let job = read;
    const used = outcome.tokens.input + outcome.tokens.output;
    if (used > 0) {
      job = { ...job, gate_tokens: job.gate_tokens + used };
      await this.core.jobs.write(job);
    }
    const ignored = current ? {} : { ignored: true as const };
    const model = this.core.config.codexModel !== undefined ? { model: this.core.config.codexModel } : {};
    const times = { started_at: outcome.startedAt, ended_at: outcome.endedAt };
    const record: GateRecord = outcome.ok
      ? { reviewer: GATE_REVIEWER, ...outcome.output, ...model, tokens: outcome.tokens, ...times }
      : { reviewer: GATE_REVIEWER, error: outcome.message, ...model, tokens: outcome.tokens, ...times };
    await this.core.jobs.writeGate(name, ticket, iteration, record);
    await this.core.jobs.appendEvent(name, ticket, outcome.ok
      ? { ts: now(), iteration, type: 'review', reviewer: GATE_REVIEWER, ...(await this.#verdictOf(job, outcome.output)), items: outcome.output.items.length, ...ignored }
      : { ts: now(), iteration, type: 'review_failed', reviewer: GATE_REVIEWER, error: outcome.message, ...ignored });
    if (!current) {
      return;
    }
    if (!outcome.ok) {
      // from: awaiting_review (current)
      await this.core.transition(job, 'needs_human', 'verdict', { code: 'gate_failed', message: outcome.message });
      return;
    }
    if (job.gate_tokens > this.core.config.gateMaxTokens) {
      // from: awaiting_review (current)
      await this.core.transition(job, 'needs_human', 'verdict', {
        code: 'gate_budget',
        message: `The gate runs of this job used ${job.gate_tokens} tokens, over the limit of SF_GATE_MAX_TOKENS (${this.core.config.gateMaxTokens}); the gate's verdict (${outcome.output.verdict}) was not applied.`,
      });
      return;
    }
    const { summary, accepted_sensitive: accepted } = outcome.output;
    // The ledger applies first (SF-052): a dropped item never counts, a dispute or churn hands the
    // job to the user.
    const applied = await this.#applyLedger(job, GATE_REVIEWER, outcome.output);
    if (applied.kind === 'stop') {
      // from: awaiting_review (current)
      await this.core.transition(job, 'needs_human', 'verdict', { code: applied.code, message: applied.message });
      return;
    }
    const fixing = applied.kind === 'fix';
    if (fixing && job.gate_fixes >= this.core.config.gateMaxRounds) {
      const message = `The gate asked for a fix ${job.gate_fixes + 1} times, over the limit of SF_GATE_MAX_ROUNDS (${this.core.config.gateMaxRounds}); the fix was not applied. Claude: ${oneLine(claude.summary)} Codex: ${oneLine(summary)}`;
      // from: awaiting_review (current)
      await this.core.transition(job, 'needs_human', 'verdict', { code: 'gate_rounds', message: message.slice(0, 2000) });
      return;
    }
    const decided = job;
    await this.applying(decided, async () => {
      if (applied.kind === 'fix') {
        await this.core.parts.turns.fix(decided, fixContent(summary, applied.items, 'Codex'), { counts: { gate_fixes: decided.gate_fixes + 1 }, ledger: applied.ledger });
      } else {
        await this.afterClean(decided, [...new Set([...claude.accepted_sensitive, ...accepted])]);
      }
    });
  }

  // After the deciding clean verdict (SF-055): the simplification pass when it is due, else MR
  // preparation with the accepted paths (sensitive). A pass that already ended on this iteration
  // (its runner stopped before the outcome applied) applies its record; one that started on it and
  // never ended (its runner stopped while it ran) is recorded as failed and goes on, as a failed
  // run does. Only under the lock.
  async afterClean(job: Job, sensitive: string[]): Promise<void> {
    const { workspace, ticket, iteration } = job;
    const record = await this.core.jobs.readSimplify(workspace, ticket, iteration);
    if (record !== undefined) {
      await this.#offerSimplify(job, record, sensitive);
    } else if (job.simplify_iteration === iteration) {
      const at = now();
      const error = 'The simplification pass was interrupted (its runner ended while it ran); it runs once per job.';
      await this.core.jobs.writeSimplify(workspace, ticket, iteration, { reviewer: SIMPLIFIER, error, started_at: at, ended_at: at });
      await this.core.jobs.appendEvent(workspace, ticket, { ts: at, iteration, type: 'simplify', reviewer: SIMPLIFIER, suggestions: 0, dropped: 0, error });
      await this.core.parts.mr.prepareMr(job, sensitive);
    } else if (this.#simplifyDue(job)) {
      await this.#startSimplify(job, sensitive);
    } else {
      await this.core.parts.mr.prepareMr(job, sensitive);
    }
  }

  // Whether the simplification pass runs on the job (SF-055): SF_SIMPLIFY on, at least one Fix
  // section written (at SF_MAX_ITERATIONS too: Simplify may go over it), and never before: the job's
  // simplify_iteration, written before a pass starts, is still absent. So it runs at most once per job,
  // whether that run ended, failed, was interrupted or the job moved on.
  #simplifyDue(job: Job): boolean {
    return this.core.config.simplify && job.fixes >= 1 && job.simplify_iteration === undefined;
  }

  // The suggestions the user skipped (SF-055), with the iteration the pass ran on: the simplify.json
  // marked skipped_at by sf accept. A Simplify, or an answer by sf say, leaves none.
  async skippedSimplifications(job: Job): Promise<{ suggestions: Suggestion[]; iteration: number } | undefined> {
    for (let number = job.iteration; number >= 1; number -= 1) {
      const record = await this.core.jobs.readSimplify(job.workspace, job.ticket, number);
      if (record !== undefined) {
        return 'suggestions' in record && record.skipped_at !== undefined ? { suggestions: record.suggestions, iteration: number } : undefined;
      }
    }
    return undefined;
  }

  // Starts the simplification pass after the deciding clean verdict: the job's simplify_iteration is
  // written first, so the pass is used up before it runs. It runs outside the lock, as the reviews
  // do, and stops with them (abort, reset). Only under the lock.
  async #startSimplify(current: Job, sensitive: string[]): Promise<void> {
    this.core.runnerJob();
    if (this.core.stopping) {
      return;
    }
    const job: Job = { ...current, simplify_iteration: current.iteration };
    await this.core.jobs.write(job);
    const key = `${job.workspace}/${job.ticket}`;
    this.core.reviews.get(key)?.controller.abort();
    const running: RunningReview = { reviewer: SIMPLIFIER, iteration: job.iteration, controller: new AbortController() };
    this.core.reviews.set(key, running);
    this.#runSimplifyPass(job, running, sensitive).catch((error: unknown) => console.error(error));
  }

  // The material of the pass: the Task file in the worktree, the final Patch, the ledger and, per
  // Fix section N, the files iteration N+1 changed against iteration N (their Patches compared).
  async #simplifyInput(job: Job, worktree: string): Promise<SimplifyInput> {
    const { workspace, ticket, iteration } = job;
    const { patch } = await this.core.jobs.readIteration(workspace, ticket, iteration);
    const meta = await this.core.jobs.readMeta(workspace, ticket, iteration);
    const task = await readFile(join(worktree, TASK_DIR, `${ticket}.md`), 'utf8');
    const fixes: FixFiles[] = [];
    for (const fix of fixNumbers(task)) {
      let files: string[] | undefined;
      if (fix >= 1 && fix + 1 <= iteration) {
        try {
          const before = (await this.core.jobs.readIteration(workspace, ticket, fix)).patch.toString('utf8');
          const after = (await this.core.jobs.readIteration(workspace, ticket, fix + 1)).patch.toString('utf8');
          files = changedBetween(before, after);
        } catch {
          files = undefined;
        }
      }
      fixes.push({ fix, files });
    }
    return { ticket, iteration, task, patch, patchTruncated: meta.patch_truncated, ledger: await this.core.jobs.readLedger(workspace, ticket), fixes };
  }

  // Runs the pass (the review's session settings: SF_REVIEW_MODEL, SF_REVIEW_MAX_TURNS, the
  // sandbox), then applies its outcome under the lock. Its messages go to events.jsonl redacted, as
  // the review's; a failure message is redacted before it is recorded.
  async #runSimplifyPass(job: Job, running: RunningReview, sensitive: string[]): Promise<void> {
    let outcome: StructuredOutcome<SimplifyOutput>;
    const redactor = new Redactor({ cwd: job.worktree ?? '' });
    try {
      if (job.worktree === null) {
        throw new Error('the job has no worktree');
      }
      const input = await this.#simplifyInput(job, job.worktree);
      outcome = await runSimplify(simplifyPrompt(input), {
        cwd: job.worktree, claudePath: this.core.config.claudePath, sandbox: this.core.config.sandbox, model: this.core.config.reviewModel,
        maxTurns: this.core.config.reviewMaxTurns, signal: running.controller.signal, images: this.imageRefs(job, input.task),
        onMessage: (message) => this.core.appendLive(job, 'review_message', redactor.reviewMessage(message), SIMPLIFIER),
      });
    } catch (error) {
      const at = now();
      outcome = { ok: false, message: `The simplification pass could not start: ${(error as Error).message}`.slice(0, 1000), model: null, startedAt: at, endedAt: at };
    }
    // A usage limit of the plan (SF-072), read before redaction.
    const limit = outcome.ok ? undefined : usageLimit(outcome.message, new Date(), 'claude');
    if (!outcome.ok) {
      outcome = { ...outcome, message: redactor.failure(outcome.message) };
    }
    const ended = outcome;
    await this.core.afterSession(job);
    await this.core.locked(() => this.#simplifyEnded(job, running, sensitive, ended, limit));
  }

  // The end of the pass. A cancelled one leaves no trace; one the job moved on from leaves only its
  // event (ignored); either way the job's simplify_iteration keeps any later pass from running. Otherwise simplify.json (the suggestions the
  // ledger guard kept, and those it dropped) and the event are written and the outcome applies. A
  // pass that hit a usage limit (limit) while the job is still current parks the job instead
  // (SF-072): no simplify.json, no event, and the pass runs again on Resume.
  async #simplifyEnded(started: Job, running: RunningReview, sensitive: string[], outcome: StructuredOutcome<SimplifyOutput>, limit?: UsageLimit): Promise<void> {
    const { workspace, ticket, iteration } = started;
    const key = `${workspace}/${ticket}`;
    if (this.core.reviews.get(key) !== running || running.controller.signal.aborted) {
      return;
    }
    this.core.reviews.delete(key);
    const job = await this.core.jobs.read(workspace, ticket);
    if (job === undefined || job.created_at !== started.created_at) {
      return;
    }
    const current = job.state === 'awaiting_review' && job.iteration === iteration;
    if (current && limit !== undefined) {
      await this.core.parts.control.park(job, 'simplify', limit);
      return;
    }
    const guarded = outcome.ok ? guardSuggestions(outcome.output.suggestions, await this.core.jobs.readLedger(workspace, ticket)) : undefined;
    await this.core.jobs.appendEvent(workspace, ticket, {
      ts: now(), iteration, type: 'simplify', reviewer: SIMPLIFIER, suggestions: guarded?.kept.length ?? 0, dropped: guarded?.dropped.length ?? 0,
      ...(outcome.ok ? {} : { error: outcome.message }), ...(current ? {} : { ignored: true as const }),
    });
    if (!current) {
      return;
    }
    const record: SimplifyRecord = outcome.ok
      ? { reviewer: SIMPLIFIER, summary: outcome.output.summary, suggestions: guarded!.kept, dropped: guarded!.dropped, cost_usd: outcome.costUsd, model: outcome.model, started_at: outcome.startedAt, ended_at: outcome.endedAt }
      : { reviewer: SIMPLIFIER, error: outcome.message, started_at: outcome.startedAt, ended_at: outcome.endedAt };
    await this.core.jobs.writeSimplify(workspace, ticket, iteration, record);
    await this.applying(job, () => this.#offerSimplify(job, record, sensitive));
  }

  // The outcome of the pass: suggestions are offered to the user (needs_human, simplify_offered);
  // none, or a failed run, goes on to MR preparation. Only under the lock.
  async #offerSimplify(job: Job, record: SimplifyRecord, sensitive: string[]): Promise<void> {
    if (!('suggestions' in record) || record.suggestions.length === 0) {
      await this.core.parts.mr.prepareMr(job, sensitive);
      return;
    }
    // from: awaiting_review (afterClean from afterClaude, #gated and #pickUp; #simplifyEnded current)
    await this.core.transition(job, 'needs_human', 'verdict', { code: SIMPLIFY_CODE, message: offerMessage(record.suggestions) });
  }

  // The user's Simplify on the offer (sf simplify, the dashboard's Simplify, SF-055): one Fix section
  // "Simplify" with the suggestions, each recorded in the ledger as accepted_risk of reviewer
  // simplify, and the normal pipeline (the Implementer, the Claude review, the gate). Never twice.
  simplify(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; check_after_minutes: number }> {
    return this.core.parts.control.request(workspaceName, ticket, { kind: 'simplify' }) as Promise<{ state: JobState; iteration: number; check_after_minutes: number }>;
  }

  // sf simplify needs needs_human with simplify_offered.
  checkSimplify(job: Job): void {
    if (job.state !== 'needs_human' || job.error?.code !== SIMPLIFY_CODE) {
      throw new FactoryError('invalid_state', `sf simplify needs needs_human with ${SIMPLIFY_CODE}; the job is ${job.state}${job.error !== undefined ? ` (${job.error.code})` : ''}.`);
    }
  }

  // The Simplify in the runner.
  applySimplify(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; check_after_minutes: number }> {
    return this.core.locked(async () => {
      const job = await this.core.job(workspaceName, ticket);
      this.checkSimplify(job);
      const ledger = await this.core.jobs.readLedger(workspaceName, ticket);
      if (ledger.some(isSimplification)) {
        throw new FactoryError('invalid_state', 'The simplification was applied on this job already; it runs once per job.');
      }
      const record = await this.core.jobs.readSimplify(workspaceName, ticket, job.iteration);
      if (record === undefined || !('suggestions' in record) || record.suggestions.length === 0) {
        throw new FactoryError('invalid_state', `Iteration ${job.iteration} has no suggestion of the simplification pass.`);
      }
      if (job.worktree === null || !(await exists(job.worktree))) {
        throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
      }
      const fix = simplifyFix(ledger, record.summary, record.suggestions, job.iteration, now());
      const result = await this.core.parts.turns.fix(job, fix.content, { ledger: fix.ledger, fromStop: true, title: SIMPLIFY_TITLE, overLimit: true });
      await this.core.jobs.appendEvent(workspaceName, ticket, { ts: now(), iteration: job.iteration, type: 'simplify_chosen', choice: 'simplify', suggestions: record.suggestions.length });
      return { state: 'working', ...result };
    });
  }
}
