// The review and gate pipeline: the Claude review of an iteration, the Codex gate at the
// iteration's gate level, the ledger of findings (settle), the user's retry of a failed review and
// override of a stopped gate, and the simplification pass after a clean verdict.
// The gate runs inside the wrapper of the sessions' read denials, and every reviewer's
// output is redacted (Redactor.output) right after its session ends, before it is stored or used.
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ImageRef, imageRefs } from '../attachments.js';
import { workspaceDecisionDocs } from '../decisions.js';
import { FactoryError } from '../errors.js';
import { gateDecision } from '../gate-level.js';
import { findBwrap, GATE_REVIEWER, type GateOutcome, gatePrompt, noTokens, redactedGateOutcome, runGate } from '../gate.js';
import { jobUserMessages } from '../job-stream.js';
import { claudeReviews, type FileChange, type GateOverride, type GateRecord, type IterationMeta, type Job, type JobState, now, type PauseStep, type ReviewRecord, type SimplifyRecord } from '../jobs.js';
import { entryItem, isSimplification, SIMPLIFIER, type Decision, DECISIONS, LEDGER_ID, type LedgerEntry, FACTORY_PROBLEMS, settle, unappliedEntries, unsettled } from '../ledger.js';
import { Redactor } from '../redact.js';
import { budgetMessage, type GatePlace, gatePlace, roundOutcome, roundRuns, type SessionEnd } from '../round.js';
import { readJobRules } from '../rules-docs.js';
import { actedVerdict, decide, type Verdict, REVIEWER, type ReviewInput, type ReviewItem, type RecordedSkills, reviewerSkills, type ReviewOutcome, type ReviewOutput, reviewPrompt, runReview, type StructuredOutcome, unacceptedItems } from '../review.js';
import { type DenialScope, gateWrapperFor, type PathDenials, pathDenials, USER_SETTINGS_WEAKEN_SANDBOX } from '../sandbox-denials.js';
import { factoryTokens } from '../secrets.js';
import { jobSkills } from '../skills.js';
import { changedBetween, type FixFiles, fixNumbers, guardSuggestions, offerMessage, runSimplify, SIMPLIFY_CODE, SIMPLIFY_TITLE, simplifyFix, type SimplifyInput, type SimplifyOutput, simplifyPrompt, type Suggestion } from '../simplify.js';
import { codesWithAction, settleCodes, withoutDropped } from '../stops.js';
import { mayTouch, parseFrontMatter, readTask, TASK_DIR } from '../task-file.js';
import { TEST_CODES, type TestsRecord } from '../test-command.js';
import { type UsageLimit, usageLimit } from '../usage-limit.js';
import type { RunnerRequest } from '../runner.js';
import type { JobStorePort, LivePort, LockPort, RunnerPort, SettingsPort, StopPort } from './ports.js';
import { LEDGER_ACCEPT_CODES } from './errors.js';
import { testsEvent } from './events.js';
import { markedGroups } from './prompts.js';
import { exists, type FixOptions, type RunningReview } from './shared.js';

// The stops whose settlement moves the job on by itself once nothing is left to settle
// (src/stops.ts: escalated, review_disputed). A churn stop's settlement is only recorded: the job
// stays needs_human, and sf say moves it on.
const SETTLE_CODES: readonly string[] = settleCodes({ resumes: true });

// The stops sf accept takes on (src/stops.ts: every row with an Accept): the gate's and the
// ledger's, the Fix round limit, the simplification pass's offer (its Skip) and the test
// step's (without passing tests).
const ACCEPT_CODES: readonly string[] = codesWithAction('accept');

// The code of a session the factory refused to start because the user settings weaken the sandbox;
// undefined for any other failure.
const refusalCode = (error: unknown): string | undefined =>
  error instanceof FactoryError && error.code === USER_SETTINGS_WEAKEN_SANDBOX ? error.code : undefined;

// What ReviewsPart calls of the other parts, by just those methods.
export interface ReviewsControl {
  park(job: Job, step: PauseStep, limit: UsageLimit): Promise<void>;
  request(workspaceName: string, ticket: string, request: Exclude<RunnerRequest, { kind: 'turn' }>): Promise<unknown>;
}

export interface ReviewsMr {
  prepareMr(job: Job, sensitive: string[], options?: { onAccepted?: () => Promise<void>; retry?: boolean }): Promise<{ state: JobState; iteration: number; branch: string }>;
}

export interface ReviewsStatus {
  lastFiles(job: Job): Promise<FileChange[] | undefined>;
}

export interface ReviewsTurns {
  fix(current: Job, content: string, options?: FixOptions): Promise<{ iteration: number; check_after_minutes: number }>;
  goOn(job: Job, ledger: LedgerEntry[]): Promise<JobState>;
}

export interface ReviewsPeers {
  readonly control: ReviewsControl;
  readonly mr: ReviewsMr;
  readonly status: ReviewsStatus;
  readonly turns: ReviewsTurns;
}

export class ReviewsPart {
  readonly #store: JobStorePort;
  readonly #locks: LockPort;
  readonly #sessions: LivePort;
  readonly #runner: RunnerPort;
  readonly #settings: SettingsPort;
  readonly #stop: StopPort;
  // The parts it calls (src/execution.ts wires them).
  readonly #peers: ReviewsPeers;

  constructor(store: JobStorePort, locks: LockPort, sessions: LivePort, runner: RunnerPort, settings: SettingsPort, stop: StopPort, peers: ReviewsPeers) {
    this.#store = store;
    this.#locks = locks;
    this.#sessions = sessions;
    this.#runner = runner;
    this.#settings = settings;
    this.#stop = stop;
    this.#peers = peers;
  }

  // The job's images as prompt images: the job's own copy, with the alt texts of the Task
  // text given (the one the agent reads); [] without images.
  imageRefs(job: Job, task: string): ImageRef[] {
    return imageRefs(job.ticket, this.#store.jobs.attachmentsDir(job.workspace, job.ticket), job.attachments ?? [], task);
  }

  // Starts the review round of the job's last iteration (src/round.ts); it runs outside the lock. The
  // gate level is decided and recorded first; then each reviewer of the round without a stored
  // verdict starts, both together in a joint round, as one RunningReview (one AbortController
  // cancels both); with every verdict stored the outcome applies at once. A job without the Claude
  // review gets the gate alone, which is then its review; one whose gate runs used up
  // SF_GATE_MAX_TOKENS gets no gate. A review still running for the job is cancelled. Nothing with
  // SF_REVIEW=off. Every caller (the publish, the go-on after a settlement, the end of a conflict
  // turn, the retry, the pick-up of a runner) goes through here. Only under the lock.
  async startReview(job: Job): Promise<void> {
    this.#runner.runnerJob();
    const { config } = this.#settings;
    if (!config.review || this.#stop.isStopping()) {
      return;
    }
    const { workspace, ticket, iteration } = job;
    const review = claudeReviews(job) ? await this.#store.jobs.readReview(workspace, ticket, iteration) : undefined;
    const gate = await this.#store.jobs.readGate(workspace, ticket, iteration);
    const stored = { claude: review !== undefined && 'verdict' in review, gate: gate !== undefined && 'verdict' in gate };
    const levelRuns = (!claudeReviews(job) || config.gate.on) && (await this.#gateRuns(job));
    const place = gatePlace({ claudeReview: claudeReviews(job), levelRuns, stored: stored.gate, tokens: job.gate_tokens, maxTokens: config.gateMaxTokens });
    if (place === 'only' && !stored.gate && job.gate_tokens >= config.gateMaxTokens) {
      // from: awaiting_review (every caller)
      await this.#store.transition(job, 'needs_human', 'verdict', { code: 'gate_budget', message: budgetMessage(job.gate_tokens, config.gateMaxTokens) });
      return;
    }
    const runs = roundRuns(place, stored);
    if (!runs.claude && !runs.gate) {
      await this.applying(job, () => this.#applyRound(job, place, {}));
      return;
    }
    const key = `${workspace}/${ticket}`;
    this.#sessions.reviews.get(key)?.controller.abort();
    const running: RunningReview = { reviewer: runs.claude ? REVIEWER : GATE_REVIEWER, iteration, controller: new AbortController() };
    this.#sessions.reviews.set(key, running);
    this.#round(job, running, runs, place).catch((error: unknown) => console.error(error));
  }

  // Runs the reviewers of a round at the same time; each end keeps its record; once both ended, the
  // round's outcome applies under the lock while the job still awaits review of the same iteration.
  async #round(job: Job, running: RunningReview, runs: { claude: boolean; gate: boolean }, place: GatePlace): Promise<void> {
    const [claude, gate] = await Promise.all([runs.claude ? this.#review(job, running) : undefined, runs.gate ? this.#gate(job, running) : undefined]);
    await this.#locks.locked(async () => {
      const key = `${job.workspace}/${job.ticket}`;
      if (this.#sessions.reviews.get(key) !== running || running.controller.signal.aborted) {
        return;
      }
      this.#sessions.reviews.delete(key);
      const read = await this.#store.jobs.read(job.workspace, job.ticket);
      // Another job of the ticket (after a reset), or one that moved on, is not this round's.
      if (read !== undefined && read.created_at === job.created_at && read.state === 'awaiting_review' && read.iteration === job.iteration) {
        await this.applying(read, () => this.#applyRound(read, place, { claude, gate }));
      }
    });
  }

  // The round's outcome (roundOutcome) from the reviewers' records of the iteration and how each
  // ended in this round: a usage limit parks the job, a failure or a stop hands it to the user, a fix
  // is the next Fix section, clean goes on to Clean with the paths the verdicts accepted. The items
  // a verdict dropped (they reopened an accepted risk) are marked in its record. Only under the lock.
  async #applyRound(job: Job, place: GatePlace, ends: { claude?: SessionEnd; gate?: SessionEnd }): Promise<void> {
    const { workspace, ticket, iteration } = job;
    const { config } = this.#settings;
    const review = place !== 'only' ? await this.#store.jobs.readReview(workspace, ticket, iteration) : undefined;
    const gate = place === 'only' || place === 'joint' ? await this.#store.jobs.readGate(workspace, ticket, iteration) : undefined;
    const extra = async (record: ReviewRecord | GateRecord | undefined): Promise<ReviewItem[]> => (record !== undefined && 'verdict' in record ? this.unaccepted(job, record.accepted_sensitive) : []);
    const outcome = roundOutcome({
      place, ledger: await this.#store.jobs.readLedger(workspace, ticket), iteration,
      claude: place !== 'only' ? { record: review, extra: await extra(review), ...ends.claude } : undefined,
      gate: place === 'only' || place === 'joint' ? { record: gate, extra: await extra(gate), ...ends.gate } : undefined,
      gateFixes: job.gate_fixes, gateTokens: job.gate_tokens, maxRounds: config.gateMaxRounds, maxTokens: config.gateMaxTokens,
    });
    if (review !== undefined && 'verdict' in review && (outcome.dropped.claude?.length ?? 0) > 0) {
      await this.#store.jobs.writeReview(workspace, ticket, iteration, { ...review, dropped: outcome.dropped.claude });
    }
    if (gate !== undefined && 'verdict' in gate && (outcome.dropped.gate?.length ?? 0) > 0) {
      await this.#store.jobs.writeGate(workspace, ticket, iteration, { ...gate, dropped: outcome.dropped.gate });
    }
    if (outcome.kind === 'park') {
      await this.#peers.control.park(job, outcome.step, outcome.limit);
    } else if (outcome.kind === 'fix') {
      await this.#peers.turns.fix(job, outcome.content, { ledger: outcome.ledger, ...(outcome.gateFix ? { counts: { gate_fixes: job.gate_fixes + 1 } } : {}) });
    } else {
      if (outcome.ledger !== undefined) {
        await this.#store.jobs.writeLedger(workspace, ticket, outcome.ledger);
      }
      // from: awaiting_review (#round, startReview)
      await (outcome.kind === 'stop' ? this.#store.transition(job, 'needs_human', 'verdict', { code: outcome.code, message: outcome.message }) : this.afterClean(job, outcome.accepted));
    }
  }

  // The user's retry of a failed review (sf review, the dashboard's Retry review): the job goes
  // back to awaiting_review without a new iteration, the failed review.json goes, and the review
  // of the last iteration runs again.
  retryReview(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number }> {
    return this.#peers.control.request(workspaceName, ticket, { kind: 'review' }) as Promise<{ state: JobState; iteration: number }>;
  }

  // sf review needs the review on and a job that a failed review handed to the user.
  checkRetryReview(job: Job): void {
    if (!this.#settings.config.review) {
      throw new FactoryError('review_off', 'The Claude review is off (SF_REVIEW=off); nothing would review the iteration.');
    }
    if (job.state !== 'needs_human' || job.error?.code !== 'review_failed') {
      throw new FactoryError('invalid_state', `sf review needs needs_human after a failed review (review_failed); the job is ${job.state}${job.error !== undefined ? ` (${job.error.code})` : ''}.`);
    }
  }

  // The retry in the runner.
  retryReviewInRunner(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number }> {
    return this.#locks.locked(async () => {
      const job = await this.#store.job(workspaceName, ticket);
      this.checkRetryReview(job);
      if (job.worktree === null || !(await exists(job.worktree))) {
        throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
      }
      await this.#store.jobs.removeReview(workspaceName, ticket, job.iteration);
      // from: needs_human (checkRetryReview)
      const next = await this.#store.transition(job, 'awaiting_review', 'review_retry');
      await this.startReview(next);
      // The job as the start left it: a gate over its budget hands it to the user at once.
      const started = await this.#store.job(workspaceName, ticket);
      return { state: started.state, iteration: started.iteration };
    });
  }

  // The user's override of a stopped gate (sf accept, the dashboard's Accept and prepare MR): a job
  // the gate handed over (needs_human with gate_rounds, gate_budget or gate_failed), or the ledger
  // or the Fix round limit (iteration_limit) stopped, goes on as after a clean gate, to MR
  // preparation with the accepted paths. With the Claude review on, its last iteration needs a
  // clean Claude review, except at the Fix round limit (whatever the last verdict), and the
  // paths are the review's accepted_sensitive; with it off no clean review is needed, and
  // the paths are the last gate.json's. The override is recorded first: gate-override.json with what
  // goes unapplied (the Codex items, the gate's error, or the ledger's open findings) and a
  // gate_overridden event; MR preparation lists it in the MR text.
  acceptGate(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.#peers.control.request(workspaceName, ticket, { kind: 'accept' }) as Promise<{ state: JobState; iteration: number; branch: string }>;
  }

  // The code the gate (or the ledger, or the Fix round limit) stopped with;
  // invalid_state unless it is one sf accept takes on.
  checkAcceptGate(job: Job): string {
    const code = job.error?.code;
    if (job.state !== 'needs_human' || code === undefined || !ACCEPT_CODES.includes(code)) {
      throw new FactoryError('invalid_state', `sf accept needs needs_human after the gate or the ledger stopped the job or at the Fix round limit, or when the simplification pass offered suggestions (${ACCEPT_CODES.join(', ')}); the job is ${job.state}${code !== undefined ? ` (${code})` : ''}.`);
    }
    return code;
  }

  // What an Accept over a ledger stop (review_churn, review_disputed) or the Fix round limit
  // (iteration_limit) goes without: the ledger's open findings with their ids, and, after a
  // ledger stop, the items of the iteration's gate that neither reopen one of them nor were dropped.
  // At the limit the ledger's open entries alone: the refused Fix wrote its items there as
  // open; the fixes the user decided and the disputed contests are not taken.
  async #ledgerUnapplied(job: Job, gate: GateRecord | undefined, code: string): Promise<Array<ReviewItem & { id?: string }>> {
    const ledger = await this.#store.jobs.readLedger(job.workspace, job.ticket);
    if (code === 'iteration_limit') {
      return ledger.filter((entry) => entry.status === 'open').map((entry) => ({ id: entry.id, ...entryItem(entry) }));
    }
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
    return this.#locks.locked(async () => {
      const job = await this.#store.job(workspaceName, ticket);
      const code = this.checkAcceptGate(job);
      const gate = job.iteration > 0 ? await this.#store.jobs.readGate(workspaceName, ticket, job.iteration) : undefined;
      const gateAccepted = gate !== undefined && 'verdict' in gate ? gate.accepted_sensitive : [];
      // The paths the deciding review accepted: Claude's (whatever its verdict at the Fix round
      // limit), or with the Claude review off the last gate.json's. prepareMr refuses the
      // marked paths they leave (sensitive_unacknowledged).
      let accepted = gateAccepted;
      if (claudeReviews(job)) {
        const review = job.iteration > 0 ? await this.#store.jobs.readReview(workspaceName, ticket, job.iteration) : undefined;
        // Items the ledger dropped (they reopened an accepted risk) never count.
        if (code !== 'iteration_limit') {
          if (review === undefined || !('verdict' in review) || actedVerdict(withoutDropped(review)) !== 'clean') {
            const what = review === undefined ? 'has none' : !('verdict' in review) ? 'failed' : review.verdict === 'fix' ? 'says fix' : 'says clean with a blocker or major item';
            throw new FactoryError('invalid_state', `sf accept needs a clean Claude review of the last iteration (${job.iteration}); it ${what}.`);
          }
          const unaccepted = await this.unaccepted(job, review.accepted_sensitive);
          if (unaccepted.length > 0) {
            throw new FactoryError('invalid_state', `sf accept needs a clean Claude review of the last iteration (${job.iteration}); it does not accept the ${markedGroups(unaccepted).map((group) => `${group.label} ${group.paths.join(', ')}`).join(' and the ')}.`);
          }
        }
        accepted = review !== undefined && 'verdict' in review ? review.accepted_sensitive : [];
      }
      if (TEST_CODES.includes(code)) {
        return this.#acceptTests(job, accepted, gate);
      }
      if (code === SIMPLIFY_CODE) {
        // Skip: MR preparation as after the clean gate, with the paths both reviewers
        // accepted; simplify.json is marked skipped, so the suggestions go into the MR text (mrIdle).
        // No gate override: the gate was clean.
        const record = await this.#store.jobs.readSimplify(workspaceName, ticket, job.iteration);
        const sensitive = [...new Set([...accepted, ...gateAccepted])];
        return this.#peers.mr.prepareMr(job, sensitive, { onAccepted: async () => {
          const at = now();
          if (record !== undefined && 'suggestions' in record) {
            await this.#store.jobs.writeSimplify(workspaceName, ticket, job.iteration, { ...record, skipped_at: at });
          }
          await this.#store.jobs.appendEvent(workspaceName, ticket, {
            ts: at, iteration: job.iteration, type: 'simplify_chosen', choice: 'skip', suggestions: record !== undefined && 'suggestions' in record ? record.suggestions.length : 0,
          });
        } });
      }
      const unapplied = LEDGER_ACCEPT_CODES.includes(code) || code === 'iteration_limit'
        ? await this.#ledgerUnapplied(job, gate, code)
        : gate === undefined ? [] : 'verdict' in gate ? gate.items : gate.error;
      const override: GateOverride = { at: now(), code, unapplied };
      return this.#peers.mr.prepareMr(job, accepted, { onAccepted: async () => {
        await this.#store.jobs.writeGateOverride(workspaceName, ticket, job.iteration, override);
        await this.#store.jobs.appendEvent(workspaceName, ticket, {
          ts: override.at, iteration: job.iteration, type: 'gate_overridden', code: override.code,
          unapplied: Array.isArray(override.unapplied) ? override.unapplied.length : 0,
        });
      } });
    });
  }

  // The Accept of a stop of the test step (tests_failed, tests_unavailable): MR preparation
  // without passing tests. No gate override: the gate was clean, off or already overridden. The
  // accepted paths are the Retry's: accepted (the Claude review's, or the gate's without the Claude
  // review), plus with the Claude review the gate's when it was clean and not overridden.
  // Once every check passed, the iteration's record says accepted_failing (with the run's details),
  // so the test step is skipped, and a tests event records it. Only under the lock.
  async #acceptTests(job: Job, accepted: string[], gate: GateRecord | undefined): Promise<{ state: JobState; iteration: number; branch: string }> {
    const { workspace: workspaceName, ticket, iteration } = job;
    const record = await this.#store.jobs.readTests(workspaceName, ticket, iteration);
    if (record === undefined || (record.outcome !== 'failed' && record.outcome !== 'unavailable')) {
      throw new FactoryError('invalid_state', `sf accept needs a failed run of the test command on the last iteration (${iteration}); ${record === undefined ? 'it has none' : `its run says ${record.outcome}`}.`);
    }
    const overridden = (await this.#store.jobs.readGateOverride(workspaceName, ticket, iteration)) !== undefined;
    const gateAccepted = claudeReviews(job) && !overridden && gate !== undefined && 'verdict' in gate && actedVerdict(withoutDropped(gate)) === 'clean' ? gate.accepted_sensitive : [];
    const from = record.outcome;
    return this.#peers.mr.prepareMr(job, [...new Set([...accepted, ...gateAccepted])], { onAccepted: async () => {
      const at = now();
      const acceptedRecord: TestsRecord = { ...record, outcome: 'accepted_failing', accepted_at: at, accepted_from: from };
      await this.#store.jobs.writeTests(workspaceName, ticket, iteration, acceptedRecord);
      await this.#store.jobs.appendEvent(workspaceName, ticket, { ...testsEvent(iteration, at, acceptedRecord), ts: at });
    } });
  }

  // The user's settlement of an escalated or contested ledger entry (sf settle, the
  // dashboard's Accept risk and Must fix) while the job is needs_human: accept makes it
  // accepted_risk, fix user_fix. Once an escalated or review_disputed stop has no escalated entry
  // and no disputed contest left, the job goes on by itself: a Fix section with the fixes the user
  // decided, or else the review that was stopped runs again. After review_churn the settlement is
  // only recorded; sf say goes on.
  settle(workspaceName: string, ticket: string, id: string, decision: Decision, note = ''): Promise<{ state: JobState; id: string; status: string; waiting: string[] }> {
    return this.#peers.control.request(workspaceName, ticket, { kind: 'settle', id, decision, note }) as Promise<{ state: JobState; id: string; status: string; waiting: string[] }>;
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
    return this.#locks.locked(async () => {
      const job = await this.#store.job(workspaceName, ticket);
      this.checkSettle(job, id, decision, note);
      const ledger = settle(await this.#store.jobs.readLedger(workspaceName, ticket), id, decision, note, now());
      if (typeof ledger === 'string') {
        throw new FactoryError('invalid_state', ledger);
      }
      await this.#store.jobs.writeLedger(workspaceName, ticket, ledger);
      const status = ledger.find((entry) => entry.id === id)!.status;
      const waiting = unsettled(ledger).map((entry) => entry.id);
      const code = job.error?.code;
      if (waiting.length > 0 || code === undefined || !SETTLE_CODES.includes(code)) {
        return { state: job.state, id, status, waiting };
      }
      return { state: await this.#peers.turns.goOn(job, ledger), id, status, waiting };
    });
  }

  // The denial scope of a review, simplification or gate session in the job's worktree.
  async #denialScope(job: Job, worktree: string): Promise<DenialScope> {
    const { config } = this.#settings;
    const workspace = await this.#settings.resolve(job.workspace);
    return { session: 'job', workspace: job.workspace, checkout: workspace.workCheckout, worktree, stateDir: config.stateDir, worktreeRoot: config.worktreeRoot };
  }

  // The path denials of a review or simplification session in the job's worktree, built
  // as each session starts, for its own temporary folder.
  async #pathDenials(job: Job, worktree: string, sessionTmp: string): Promise<PathDenials> {
    return pathDenials({ ...(await this.#denialScope(job, worktree)), sessionTmp });
  }

  // The Redactor of a reviewer's run in the job's worktree, with the dashboard and MCP tokens as
  // literal secrets; a token file that is missing or unreadable adds none.
  async #redactor(job: Job): Promise<Redactor> {
    return new Redactor({ cwd: job.worktree ?? '', secrets: await factoryTokens(this.#settings.config) });
  }

  // The material of a review of the job's last iteration, the Task file read in the worktree, and the skills of role by its list the job's start recorded.
  async #reviewInput(job: Job, worktree: string, role: 'claude_review' | 'codex_gate'): Promise<ReviewInput & { recorded: RecordedSkills }> {
    const { workspace: name, ticket, iteration } = job;
    const [{ report, patch }, meta] = await Promise.all([this.#store.jobs.readIteration(name, ticket, iteration), this.#store.jobs.readMeta(name, ticket, iteration)]);
    return {
      ticket, iteration, report, patch, patchTruncated: meta.patch_truncated, files: meta.files, handbook: this.#settings.handbook,
      task: await readFile(join(worktree, TASK_DIR, `${ticket}.md`), 'utf8'), ledger: await this.#store.jobs.readLedger(name, ticket),
      rules: await readJobRules(this.#store.jobs.dir(name, ticket)),
      // The workspace's decision documents as they are in the job's worktree.
      decision_docs: await workspaceDecisionDocs(name, worktree),
      // Every message sent up to and including the reviewed iteration.
      userMessages: (await jobUserMessages(this.#store.jobs, name, ticket)).filter((m) => m.iteration <= iteration),
      ...(await reviewerSkills(await jobSkills(this.#settings.config.stateDir, this.#store.jobs.eventsPath(name, ticket)), role, this.#settings.config.reviewSkill, this.#settings.config.reviewSkillSet)),
    };
  }

  // Runs the review session, then keeps its end under the lock; how it ended, for the round.
  async #review(job: Job, running: RunningReview): Promise<SessionEnd> {
    let outcome: ReviewOutcome;
    let method: RecordedSkills = { review_method: 'none' };
    // The code a session refused before it started stops the job with (user_settings_weaken_sandbox).
    let stop: string | undefined;
    const redactor = await this.#redactor(job);
    try {
      if (job.worktree === null) {
        throw new Error('the job has no worktree');
      }
      const worktree = job.worktree;
      const input = await this.#reviewInput(job, worktree, 'claude_review');
      method = input.recorded;
      outcome = await runReview(reviewPrompt(input), {
        cwd: worktree, claudePath: this.#settings.config.claudePath, sandbox: this.#settings.config.sandbox, model: this.#settings.config.reviewModel,
        pathDenials: (sessionTmp) => this.#pathDenials(job, worktree, sessionTmp),
        maxTurns: this.#settings.config.reviewMaxTurns, signal: running.controller.signal, images: this.imageRefs(job, input.task),
        // The session live in events.jsonl.
        onMessage: (message) => this.#sessions.appendLive(job, 'review_message', redactor.reviewMessage(message)),
      });
    } catch (error) {
      const at = now();
      stop = refusalCode(error);
      outcome = { ok: false, message: `The review could not start: ${(error as Error).message}`.slice(0, 1000), startedAt: at, endedAt: at };
    }
    // A usage limit is read from the message as the session wrote it, before redaction.
    const limit = outcome.ok ? undefined : usageLimit(outcome.message, new Date(), 'claude');
    // The failure message goes to review.json, the event and the job's error: withheld or redacted
    // like the session's prose (src/redact.ts, failure); a refusal is the factory's own text, which
    // names the settings file and the key for the user (no session ran).
    if (!outcome.ok && stop === undefined) {
      outcome = { ...outcome, message: redactor.failure(outcome.message) };
    }
    // The verdict redacted before review.json, the events, the Fix section and the prompts.
    if (outcome.ok) {
      outcome = { ...outcome, output: redactor.output(outcome.output) };
    }
    const ended = outcome;
    await this.#sessions.afterSession(job);
    await this.#locks.locked(() => this.#reviewed(job, running, ended, method, limit));
    return { limit, code: stop };
  }

  // The end of a review. A cancelled one leaves no trace. One that hit a usage limit (limit) while
  // the job still awaits review of the same iteration writes nothing (the round parks the job).
  // Otherwise review.json (with method, the review method's record) and the event are written;
  // the round applies them.
  async #reviewed(reviewed: Job, running: RunningReview, outcome: ReviewOutcome, method: RecordedSkills, limit?: UsageLimit): Promise<void> {
    const { workspace: name, ticket, iteration } = reviewed;
    const job = await this.#ended(reviewed, running);
    if (job === undefined || (limit !== undefined && job.state === 'awaiting_review' && job.iteration === iteration)) {
      return;
    }
    const ignored = job.state === 'awaiting_review' && job.iteration === iteration ? {} : { ignored: true as const };
    const record: ReviewRecord = outcome.ok
      ? { reviewer: REVIEWER, ...outcome.output, cost_usd: outcome.costUsd, started_at: outcome.startedAt, ended_at: outcome.endedAt, ...method }
      : { reviewer: REVIEWER, error: outcome.message, ...method };
    await this.#store.jobs.writeReview(name, ticket, iteration, record);
    await this.#store.jobs.appendEvent(name, ticket, outcome.ok
      ? { ts: now(), iteration, type: 'review', reviewer: REVIEWER, ...(await this.#verdictOf(job, outcome.output)), items: outcome.output.items.length, ...ignored }
      : { ts: now(), iteration, type: 'review_failed', reviewer: REVIEWER, error: outcome.message, ...ignored });
  }

  // The job a reviewer's end belongs to: undefined when its round was cancelled, or the ticket's
  // job is another one (after a reset).
  async #ended(started: Job, running: RunningReview): Promise<Job | undefined> {
    if (this.#sessions.reviews.get(`${started.workspace}/${started.ticket}`) !== running || running.controller.signal.aborted) {
      return undefined;
    }
    const job = await this.#store.jobs.read(started.workspace, started.ticket);
    return job !== undefined && job.created_at === started.created_at ? job : undefined;
  }

  // The undeclared sensitive paths and the paths outside the Task's scope of the job's
  // last iteration not in accepted, nor accepted by the user as a risk, as fix items.
  async unaccepted(job: Job, accepted: string[]): Promise<ReviewItem[]> {
    const byUser = await this.#markedAcceptedByUser(job);
    return unacceptedItems((await this.#peers.status.lastFiles(job)) ?? [], [...accepted, ...byUser]);
  }

  // The marked paths (undeclared sensitive, outside the Task's scope) whose ledger entry the user
  // settled as an accepted risk.
  async #markedAcceptedByUser(job: Job): Promise<string[]> {
    return (await this.#store.jobs.readLedger(job.workspace, job.ticket))
      .filter((entry) => entry.status === 'accepted_risk' && FACTORY_PROBLEMS.includes(entry.problem))
      .map((entry) => entry.path);
  }

  // The reviewer's verdict for the event, with the one the factory acts on (decide) when it differs.
  async #verdictOf(job: Job, output: ReviewOutput): Promise<{ verdict: Verdict; effective?: Verdict }> {
    const effective = decide(output, await this.unaccepted(job, output.accepted_sensitive)).verdict;
    return effective === output.verdict ? { verdict: output.verdict } : { verdict: output.verdict, effective };
  }

  // Whether the gate runs on the job's last iteration, by its gate level
  // (src/gate-level.ts): decided once per iteration as its round starts, before either review and
  // before the gate's budget check, so a gate that does not run never stops on gate_budget. A
  // decision already recorded in gate-level.json (the job picked up again after a pause, a park or
  // a restart of sf serve) is used as it is; otherwise the level is decided from the job's change at
  // the iteration (its meta.json files) and the Task's may_touch, and recorded with its gate_level
  // event. Only under the lock.
  async #gateRuns(job: Job): Promise<boolean> {
    const { workspace, ticket, iteration } = job;
    const recorded = await this.#store.jobs.readGateLevel(workspace, ticket, iteration);
    if (recorded !== undefined) {
      return recorded.ran;
    }
    let meta: IterationMeta | undefined;
    try {
      meta = claudeReviews(job) ? await this.#store.jobs.readMeta(workspace, ticket, iteration) : undefined;
    } catch (error) {
      // No file list: the level cannot be known, so it is full.
      console.error(error);
    }
    const { config } = this.#settings;
    // Without the Claude review the gate is the job's only review: it always runs, at level full.
    const decision = !claudeReviews(job) ? { level: 'full' as const, ran: true, reasons: ['no Claude review'], files: null, lines: null } : gateDecision({
      files: meta?.files, patchTruncated: meta?.patch_truncated === true, mayTouch: await this.#mayTouch(job), setting: config.gateLevel, fullPaths: config.gateFullPaths,
      sensitivePaths: config.sensitivePaths,
    }, job.gate_fixes);
    const at = now();
    await this.#store.jobs.writeGateLevel(workspace, ticket, iteration, { ...decision, at });
    await this.#store.jobs.appendEvent(workspace, ticket, { ts: at, iteration, type: 'gate_level', level: decision.level, ran: decision.ran, reasons: decision.reasons });
    return decision.ran;
  }

  // The may_touch of the Task file in the work checkout, as the marks of the job's files read it
  // (never the worktree's copy, which the Implementer could edit); undefined when it cannot be read
  // (the level is then full).
  async #mayTouch(job: Job): Promise<string[] | undefined> {
    try {
      return mayTouch(parseFrontMatter(await readTask(await this.#settings.resolve(job.workspace), job.ticket)) ?? new Map<string, string>());
    } catch (error) {
      console.error(error);
      return undefined;
    }
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
      const latest = await this.#store.jobs.read(job.workspace, job.ticket);
      if (latest?.state === 'awaiting_review') {
        const code = error instanceof FactoryError ? error.code : 'review_failed';
        // from: awaiting_review (the guard above)
        await this.#store.transition(latest, 'needs_human', 'verdict', { code, message: `The review's verdict could not be applied: ${(error as Error).message}`.slice(0, 1000) });
      }
    }
  }

  // Runs the gate, then keeps its end under the lock; how it ended, for the round. Its role in the
  // prompt: the only reviewer without the Claude review, else one of the joint round's two.
  async #gate(job: Job, running: RunningReview): Promise<SessionEnd> {
    const { workspace: name, ticket, iteration } = job;
    const gate = this.#settings.config.gate;
    let outcome: GateOutcome;
    let method: RecordedSkills = { review_method: 'none' };
    const redactor = await this.#redactor(job);
    try {
      if (!gate.on) {
        throw new Error(`the gate is off (${gate.reason})`);
      }
      if (job.worktree === null || job.base_commit === null) {
        throw new Error('the job has no worktree or base commit');
      }
      const input = await this.#reviewInput(job, job.worktree, 'codex_gate');
      method = input.recorded;
      const dir = this.#store.jobs.iterationDir(name, ticket, iteration);
      const images = this.imageRefs(job, input.task).map((image) => image.path);
      // Codex inside bubblewrap under the sessions' read denials; unwrapped with SF_SANDBOX=off.
      const wrapper = this.#settings.config.sandbox === undefined ? undefined : await gateWrapperFor(await this.#denialScope(job, job.worktree), {
        worktree: job.worktree, codexPath: gate.codexPath, codexHome: process.env.CODEX_HOME || join(homedir(), '.codex'), iterationDir: dir, images, tmp: tmpdir(),
      });
      outcome = await runGate(gatePrompt({ ...input, baseCommit: job.base_commit, onlyReviewer: !claudeReviews(job) }), {
        codexPath: gate.codexPath, cwd: job.worktree, dir, model: this.#settings.config.codexModel, images, wrapper, bwrapPath: findBwrap(),
        timeoutMs: this.#settings.config.gateTimeoutMs, signal: running.controller.signal,
        // The run live in events.jsonl.
        onEvent: (event) => this.#sessions.appendLive(job, 'gate_event', redactor.codexEvent(event)),
      });
    } catch (error) {
      const at = now();
      outcome = { ok: false, message: `The gate could not start: ${(error as Error).message}`.slice(0, 1000), tokens: noTokens(), startedAt: at, endedAt: at };
    }
    // A usage limit of the plan, read before redaction.
    const limit = outcome.ok ? undefined : usageLimit(outcome.message, new Date(), 'codex');
    const ended = redactedGateOutcome(outcome, redactor);
    await this.#sessions.afterSession(job);
    await this.#locks.locked(() => this.#gated(job, running, ended, method, limit));
    return { limit, code: ended.ok ? undefined : ended.code };
  }

  // The end of a gate run. A cancelled one leaves no trace. Otherwise its tokens count for the job,
  // and gate.json (with method: the review method's record, the skills' names) and the event (naming
  // a skill left out) are written; the round applies them. A run that hit a usage limit (limit) while
  // the job still awaits review of the same iteration is discarded whole: no gate.json, no event, no
  // tokens charged, so a parked and rerun round never counts toward SF_GATE_MAX_TOKENS.
  async #gated(gated: Job, running: RunningReview, outcome: GateOutcome, method: RecordedSkills, limit?: UsageLimit): Promise<void> {
    const { workspace: name, ticket, iteration } = gated;
    const read = await this.#ended(gated, running);
    const current = read !== undefined && read.state === 'awaiting_review' && read.iteration === iteration;
    if (read === undefined || (current && limit !== undefined)) {
      return;
    }
    let job = read;
    const used = outcome.tokens.input + outcome.tokens.output;
    if (used > 0) {
      job = { ...job, gate_tokens: job.gate_tokens + used };
      await this.#store.jobs.write(job);
    }
    const ignored = current ? {} : { ignored: true as const };
    const model = this.#settings.config.codexModel !== undefined ? { model: this.#settings.config.codexModel } : {};
    const times = { started_at: outcome.startedAt, ended_at: outcome.endedAt };
    const record: GateRecord = outcome.ok
      ? { reviewer: GATE_REVIEWER, ...outcome.output, ...model, tokens: outcome.tokens, ...times, ...method }
      : { reviewer: GATE_REVIEWER, error: outcome.message, ...model, tokens: outcome.tokens, ...times, ...method };
    await this.#store.jobs.writeGate(name, ticket, iteration, record);
    const omitted = method.skills_omitted !== undefined && method.skills_omitted.length > 0 ? { skills_omitted: method.skills_omitted } : {};
    await this.#store.jobs.appendEvent(name, ticket, outcome.ok
      ? { ts: now(), iteration, type: 'review', reviewer: GATE_REVIEWER, ...(await this.#verdictOf(job, outcome.output)), items: outcome.output.items.length, ...ignored, ...omitted }
      : { ts: now(), iteration, type: 'review_failed', reviewer: GATE_REVIEWER, error: outcome.message, ...ignored });
  }

  // After the deciding clean verdict: the simplification pass when it is due, else MR
  // preparation with the accepted paths (sensitive). A pass that already ended on this iteration
  // (its runner stopped before the outcome applied) applies its record; one that started on it and
  // never ended (its runner stopped while it ran) is recorded as failed and goes on, as a failed
  // run does. Only under the lock.
  async afterClean(job: Job, sensitive: string[]): Promise<void> {
    const { workspace, ticket, iteration } = job;
    const record = await this.#store.jobs.readSimplify(workspace, ticket, iteration);
    if (record !== undefined) {
      await this.#offerSimplify(job, record, sensitive);
    } else if (job.simplify_iteration === iteration) {
      const at = now();
      const error = 'The simplification pass was interrupted (its runner ended while it ran); it runs once per job.';
      await this.#store.jobs.writeSimplify(workspace, ticket, iteration, { reviewer: SIMPLIFIER, error, started_at: at, ended_at: at });
      await this.#store.jobs.appendEvent(workspace, ticket, { ts: at, iteration, type: 'simplify', reviewer: SIMPLIFIER, suggestions: 0, dropped: 0, error });
      await this.#peers.mr.prepareMr(job, sensitive);
    } else if (this.#simplifyDue(job)) {
      await this.#startSimplify(job, sensitive);
    } else {
      await this.#peers.mr.prepareMr(job, sensitive);
    }
  }

  // Whether the simplification pass runs on the job: SF_SIMPLIFY on, at least one Fix
  // section written (at SF_MAX_ITERATIONS too: Simplify may go over it), and never before: the job's
  // simplify_iteration, written before a pass starts, is still absent. So it runs at most once per job,
  // whether that run ended, failed, was interrupted or the job moved on.
  #simplifyDue(job: Job): boolean {
    return this.#settings.config.simplify && job.fixes >= 1 && job.simplify_iteration === undefined;
  }

  // The suggestions the user skipped, with the iteration the pass ran on: the simplify.json
  // marked skipped_at by sf accept. A Simplify, or an answer by sf say, leaves none.
  async skippedSimplifications(job: Job): Promise<{ suggestions: Suggestion[]; iteration: number } | undefined> {
    for (let number = job.iteration; number >= 1; number -= 1) {
      const record = await this.#store.jobs.readSimplify(job.workspace, job.ticket, number);
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
    this.#runner.runnerJob();
    if (this.#stop.isStopping()) {
      return;
    }
    const job: Job = { ...current, simplify_iteration: current.iteration };
    await this.#store.jobs.write(job);
    const key = `${job.workspace}/${job.ticket}`;
    this.#sessions.reviews.get(key)?.controller.abort();
    const running: RunningReview = { reviewer: SIMPLIFIER, iteration: job.iteration, controller: new AbortController() };
    this.#sessions.reviews.set(key, running);
    this.#runSimplifyPass(job, running, sensitive).catch((error: unknown) => console.error(error));
  }

  // The material of the pass: the Task file in the worktree, the final Patch, the ledger and, per
  // Fix section N, the files iteration N+1 changed against iteration N (their Patches compared).
  async #simplifyInput(job: Job, worktree: string): Promise<SimplifyInput> {
    const { workspace, ticket, iteration } = job;
    const { patch } = await this.#store.jobs.readIteration(workspace, ticket, iteration);
    const meta = await this.#store.jobs.readMeta(workspace, ticket, iteration);
    const task = await readFile(join(worktree, TASK_DIR, `${ticket}.md`), 'utf8');
    const fixes: FixFiles[] = [];
    for (const fix of fixNumbers(task)) {
      let files: string[] | undefined;
      if (fix >= 1 && fix + 1 <= iteration) {
        try {
          const before = (await this.#store.jobs.readIteration(workspace, ticket, fix)).patch.toString('utf8');
          const after = (await this.#store.jobs.readIteration(workspace, ticket, fix + 1)).patch.toString('utf8');
          files = changedBetween(before, after);
        } catch { // an iteration that cannot be read: its files are unknown
          files = undefined;
        }
      }
      fixes.push({ fix, files });
    }
    return { ticket, iteration, task, patch, patchTruncated: meta.patch_truncated, ledger: await this.#store.jobs.readLedger(workspace, ticket), fixes };
  }

  // Runs the pass (the review's session settings: SF_REVIEW_MODEL, SF_REVIEW_MAX_TURNS, the
  // sandbox), then applies its outcome under the lock. Its messages go to events.jsonl redacted, as
  // the review's; a failure message is redacted before it is recorded.
  async #runSimplifyPass(job: Job, running: RunningReview, sensitive: string[]): Promise<void> {
    let outcome: StructuredOutcome<SimplifyOutput>;
    let stop: string | undefined;
    const redactor = await this.#redactor(job);
    try {
      if (job.worktree === null) {
        throw new Error('the job has no worktree');
      }
      const worktree = job.worktree;
      const input = await this.#simplifyInput(job, worktree);
      outcome = await runSimplify(simplifyPrompt(input), {
        cwd: worktree, claudePath: this.#settings.config.claudePath, sandbox: this.#settings.config.sandbox, model: this.#settings.config.reviewModel,
        pathDenials: (sessionTmp) => this.#pathDenials(job, worktree, sessionTmp),
        maxTurns: this.#settings.config.reviewMaxTurns, signal: running.controller.signal, images: this.imageRefs(job, input.task),
        onMessage: (message) => this.#sessions.appendLive(job, 'review_message', redactor.reviewMessage(message), SIMPLIFIER),
      });
    } catch (error) {
      const at = now();
      stop = refusalCode(error);
      outcome = { ok: false, message: `The simplification pass could not start: ${(error as Error).message}`.slice(0, 1000), model: null, startedAt: at, endedAt: at };
    }
    // A usage limit of the plan, read before redaction.
    const limit = outcome.ok ? undefined : usageLimit(outcome.message, new Date(), 'claude');
    if (!outcome.ok && stop === undefined) {
      outcome = { ...outcome, message: redactor.failure(outcome.message) };
    }
    // The suggestions redacted before simplify.json, the events and the Simplify Fix.
    if (outcome.ok) {
      outcome = { ...outcome, output: redactor.output(outcome.output) };
    }
    const ended = outcome;
    await this.#sessions.afterSession(job);
    await this.#locks.locked(() => this.#simplifyEnded(job, running, sensitive, ended, limit, stop));
  }

  // The end of the pass. A cancelled one leaves no trace; one the job moved on from leaves only its
  // event (ignored); either way the job's simplify_iteration keeps any later pass from running. Otherwise simplify.json (the suggestions the
  // ledger guard kept, and those it dropped) and the event are written and the outcome applies. A
  // pass that hit a usage limit (limit) while the job is still current parks the job instead:
  // no simplify.json, no event, and the pass runs again on Resume.
  // stop: the code of a pass refused before it started: the job stops with it instead of going on.
  async #simplifyEnded(started: Job, running: RunningReview, sensitive: string[], outcome: StructuredOutcome<SimplifyOutput>, limit?: UsageLimit, stop?: string): Promise<void> {
    const { workspace, ticket, iteration } = started;
    const key = `${workspace}/${ticket}`;
    if (this.#sessions.reviews.get(key) !== running || running.controller.signal.aborted) {
      return;
    }
    this.#sessions.reviews.delete(key);
    const job = await this.#store.jobs.read(workspace, ticket);
    if (job === undefined || job.created_at !== started.created_at) {
      return;
    }
    const current = job.state === 'awaiting_review' && job.iteration === iteration;
    if (current && limit !== undefined) {
      await this.#peers.control.park(job, 'simplify', limit);
      return;
    }
    const guarded = outcome.ok ? guardSuggestions(outcome.output.suggestions, await this.#store.jobs.readLedger(workspace, ticket)) : undefined;
    await this.#store.jobs.appendEvent(workspace, ticket, {
      ts: now(), iteration, type: 'simplify', reviewer: SIMPLIFIER, suggestions: guarded?.kept.length ?? 0, dropped: guarded?.dropped.length ?? 0,
      ...(outcome.ok ? {} : { error: outcome.message }), ...(current ? {} : { ignored: true as const }),
    });
    if (!current) {
      return;
    }
    const record: SimplifyRecord = outcome.ok
      ? { reviewer: SIMPLIFIER, summary: outcome.output.summary, suggestions: guarded!.kept, dropped: guarded!.dropped, cost_usd: outcome.costUsd, model: outcome.model, started_at: outcome.startedAt, ended_at: outcome.endedAt }
      : { reviewer: SIMPLIFIER, error: outcome.message, started_at: outcome.startedAt, ended_at: outcome.endedAt };
    await this.#store.jobs.writeSimplify(workspace, ticket, iteration, record);
    if (stop !== undefined && !outcome.ok) {
      // from: awaiting_review (current)
      await this.#store.transition(job, 'needs_human', 'verdict', { code: stop, message: outcome.message });
      return;
    }
    await this.applying(job, () => this.#offerSimplify(job, record, sensitive));
  }

  // The outcome of the pass: suggestions are offered to the user (needs_human, simplify_offered);
  // none, or a failed run, goes on to MR preparation. Only under the lock.
  async #offerSimplify(job: Job, record: SimplifyRecord, sensitive: string[]): Promise<void> {
    if (!('suggestions' in record) || record.suggestions.length === 0) {
      await this.#peers.mr.prepareMr(job, sensitive);
      return;
    }
    // from: awaiting_review (afterClean from afterClaude, #gated and #pickUp; #simplifyEnded current)
    await this.#store.transition(job, 'needs_human', 'verdict', { code: SIMPLIFY_CODE, message: offerMessage(record.suggestions) });
  }

  // The user's Simplify on the offer (sf simplify, the dashboard's Simplify): one Fix section
  // "Simplify" with the suggestions, each recorded in the ledger as accepted_risk of reviewer
  // simplify, and the normal pipeline (the Implementer, the Claude review, the gate). Never twice.
  simplify(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; check_after_minutes: number }> {
    return this.#peers.control.request(workspaceName, ticket, { kind: 'simplify' }) as Promise<{ state: JobState; iteration: number; check_after_minutes: number }>;
  }

  // sf simplify needs needs_human with simplify_offered.
  checkSimplify(job: Job): void {
    if (job.state !== 'needs_human' || job.error?.code !== SIMPLIFY_CODE) {
      throw new FactoryError('invalid_state', `sf simplify needs needs_human with ${SIMPLIFY_CODE}; the job is ${job.state}${job.error !== undefined ? ` (${job.error.code})` : ''}.`);
    }
  }

  // The Simplify in the runner.
  applySimplify(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number; check_after_minutes: number }> {
    return this.#locks.locked(async () => {
      const job = await this.#store.job(workspaceName, ticket);
      this.checkSimplify(job);
      const ledger = await this.#store.jobs.readLedger(workspaceName, ticket);
      if (ledger.some(isSimplification)) {
        throw new FactoryError('invalid_state', 'The simplification was applied on this job already; it runs once per job.');
      }
      const record = await this.#store.jobs.readSimplify(workspaceName, ticket, job.iteration);
      if (record === undefined || !('suggestions' in record) || record.suggestions.length === 0) {
        throw new FactoryError('invalid_state', `Iteration ${job.iteration} has no suggestion of the simplification pass.`);
      }
      if (job.worktree === null || !(await exists(job.worktree))) {
        throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
      }
      const fix = simplifyFix(ledger, record.summary, record.suggestions, job.iteration, now());
      const result = await this.#peers.turns.fix(job, fix.content, { ledger: fix.ledger, fromStop: true, title: SIMPLIFY_TITLE, overLimit: true });
      await this.#store.jobs.appendEvent(workspaceName, ticket, { ts: now(), iteration: job.iteration, type: 'simplify_chosen', choice: 'simplify', suggestions: record.suggestions.length });
      return { state: 'working', ...result };
    });
  }
}
