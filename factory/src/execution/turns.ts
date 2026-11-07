// The Implementer's turns (SF-089, from src/execution.ts): the session of each job, the end of a
// turn (#idle: the Report, the Patch and the published iteration), the turn limit (SF-076), the
// answers to the Fix items, say (a user message), requestFix and the Fix section the factory
// appends, and goOn (the path after a verdict).
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve as resolvePath, sep } from 'node:path';
import { withoutImageData } from '../attachments.js';
import { FactoryError } from '../errors.js';
import { runGit } from '../git.js';
import { attachWorktree, checkBranchFree } from '../handoff.js';
import { jobUserMessages } from '../job-stream.js';
import { type FileChange, type Job, type JobState, now } from '../jobs.js';
import { answerFix, escalationMessage, headings, type LedgerEntry, userFixItems } from '../ledger.js';
import { buildPatch, changedFilesSection, fileChanges, notificationLine, type Patch } from '../patch.js';
import { factoryPrompt, iterationCost } from '../prompts.js';
import { DENIED_TOOLS, type Marks, marksOf } from '../rules.js';
import type { Workspace } from '../registry.js';
import { copyRulesRecord } from '../rules-docs.js';
import { fixContent } from '../review.js';
import { pathDenials } from '../sandbox-denials.js';
import { type IdleOutcome, ImplementerSession, type LimitAnswer, type LimitedTurn } from '../session.js';
import { CONTINUE_PROMPT, limitDecision, worktreeChanged, type WorktreeState, worktreeState } from '../turn-limit.js';
import { appendFix, mayTouch, parseFrontMatter, readTask, TASK_DIR, taskScope } from '../task-file.js';
import { TicketHistory } from '../ticket-history.js';
import { usageLimit } from '../usage-limit.js';
import { changeNote, checkNotInCheckout, cutOffError, exists, type Live } from './shared.js';
import type { Core } from './core.js';

type Success = Extract<IdleOutcome, { ok: true }>;

// The options of a Fix section (fix).
interface FixOptions {
  // What else the Fix counts for (the gate's gate_fixes).
  counts?: Partial<Pick<Job, 'gate_fixes'>>;
  ledger?: LedgerEntry[];
  fromStop?: boolean;
  title?: string;
  overLimit?: boolean;
}

export class TurnsPart {
  readonly core: Core;
  // The tickets' history (SF-081): each Fix section the factory appends is recorded as fix_added.
  readonly #history: TicketHistory;

  constructor(core: Core) {
    this.core = core;
    this.#history = new TicketHistory(core.config.stateDir);
  }

  // The prompt of an Implementer turn, with the change of the Task file since the Implementer was
  // last given it (SF-067: changed while paused) when there is one. change: taskChange's.
  withChange(prompt: string, ticket: string, change: { diff: string | undefined } | undefined): string {
    return change === undefined ? prompt : `${prompt}\n\n${changeNote(ticket, change.diff)}`;
  }

  // The images line of the job's prompts (SF-065): their folder in the worktree and their names;
  // undefined without images.
  imagesLine(job: Job): { dir: string; names: string[] } | undefined {
    const attachments = job.attachments ?? [];
    if (attachments.length === 0 || job.worktree === null) {
      return undefined;
    }
    return { dir: join(job.worktree, TASK_DIR, job.ticket), names: attachments.map((image) => image.name) };
  }

  // The job's live session, created on first use with the worktree as cwd. Runner mode only.
  session(job: Job, workspace: Workspace): ImplementerSession {
    this.core.runnerJob();
    if (this.core.stopping) {
      throw new FactoryError('runner_stopping', 'The runner of the job is stopping; no turn starts.');
    }
    const key = `${job.workspace}/${job.ticket}`;
    const live = this.core.live.get(key);
    if (live !== undefined) {
      return live.session;
    }
    if (job.worktree === null) {
      throw new FactoryError('worktree_missing', `The job for ${key} has no worktree; it cannot run a turn.`);
    }
    const cwd = job.worktree;
    const { workspace: name, ticket } = job;
    let iteration = job.iteration + 1;
    // The worktree at the start of the turn running, for its turn limit (SF-069).
    let start: WorktreeState | undefined;
    const probe = this.core.config.smokeProbeAllow;
    const session = new ImplementerSession(
      {
        cwd, maxTurns: this.core.config.maxTurns, claudePath: this.core.config.claudePath,
        sessionId: job.session_id ?? undefined, sandbox: this.core.config.sandbox, model: this.core.config.model,
        turnLimitContinues: this.core.config.turnLimitContinues,
        // sf smoke's probe only (SF-104), in mode dontAsk (SF-109): undefined and false for every
        // real job's state directory.
        allowCommands: probe !== undefined ? [probe] : undefined,
        smokeMode: probe !== undefined,
        // Built by the session's first turn, again for every session the factory creates (SF-100).
        pathDenials: () => pathDenials({
          session: 'job', workspace: name, checkout: workspace.workCheckout, worktree: cwd, stateDir: this.core.config.stateDir, worktreeRoot: this.core.config.worktreeRoot,
        }),
      },
      {
        prompt: async (prompt, continued, images) => {
          const current = await this.core.jobs.read(name, ticket);
          iteration = (current?.iteration ?? 0) + 1;
          // The images by name, type and size only, never their bytes (SF-065).
          const sent = images === undefined ? undefined : await Promise.all(images.map(async (image) => ({
            name: image.name, type: image.type,
            bytes: current?.attachments?.find((record) => record.name === image.name)?.bytes ?? (await stat(image.path).then((info) => info.size, () => 0)),
          })));
          await this.core.jobs.appendEvent(name, ticket, { ts: now(), iteration, prompt, ...(sent !== undefined ? { images: sent } : {}) });
          start = await this.#worktreeState(cwd, current);
          // A prompt sent starts a new chain: the continuations of the last one no longer show.
          if (continued === 0 && current?.turn_limit !== undefined) {
            void this.#recordTurnLimit(name, ticket, undefined).catch(console.error);
          }
        },
        turnLimit: (turn) => this.#turnLimit(name, ticket, iteration, cwd, start, turn),
        message: async (message: SDKMessage) => {
          // No image bytes in events.jsonl (SF-065): a Read of an image returns them.
          await this.core.jobs.appendEvent(name, ticket, { ts: now(), iteration, message: withoutImageData(message) });
          if (message.type === 'system' && message.subtype === 'init' && message.permissionMode === session.permissionMode) {
            // Queued, not awaited: the session must never wait for the lock (abort holds it while
            // it closes the session).
            void this.#recordSession(name, ticket, message.session_id);
          }
        },
        idle: (outcome) => this.#idle(name, ticket, outcome),
      },
    );
    this.core.live.set(key, { workspace, session, cwd });
    return session;
  }

  // The worktree's state for the turn limit; undefined (no change seen) when Git fails.
  async #worktreeState(cwd: string, job: Job | undefined): Promise<WorktreeState | undefined> {
    if (job?.base_commit === null || job?.base_commit === undefined) {
      return undefined;
    }
    try {
      return await worktreeState(cwd, job.base_commit);
    } catch (error) {
      console.error(error);
      return undefined;
    }
  }

  // A turn of the job ended at maxTurns (SF-069): go on with a continuation when the worktree
  // changed since start and the turn was not repeating itself, and the chain has one left (the
  // session's bound, turn.allowed); else the plain reason it stops. Never waits for the lock.
  async #turnLimit(name: string, ticket: string, iteration: number, cwd: string, start: WorktreeState | undefined, turn: LimitedTurn): Promise<LimitAnswer> {
    const end = await this.#worktreeState(cwd, await this.core.jobs.read(name, ticket));
    const { allowed } = turn;
    const decision = limitDecision({ maxTurns: this.core.config.maxTurns, changed: worktreeChanged(start, end), calls: turn.calls, continued: turn.continued, allowed });
    if (!decision.continue) {
      return { stop: decision.message };
    }
    const continued = turn.continued + 1;
    await this.core.jobs.appendEvent(name, ticket, {
      ts: now(), iteration, type: 'turn_limit_continued', continued, allowed, max_turns: this.core.config.maxTurns, changed_paths: end?.paths.length ?? 0, tool_calls: turn.calls.length,
    });
    void this.#recordTurnLimit(name, ticket, { continued, allowed }).catch(console.error);
    return { prompt: CONTINUE_PROMPT };
  }

  // Writes the continuations of the job's current chain (undefined: a new chain began). Queued,
  // not awaited by the session's hooks, as #recordSession.
  #recordTurnLimit(workspace: string, ticket: string, turnLimit: Job['turn_limit']): Promise<void> {
    return this.core.locked(async () => {
      const job = await this.core.jobs.read(workspace, ticket);
      if (job === undefined || job.turn_limit?.continued === turnLimit?.continued) {
        return;
      }
      const { turn_limit: _old, ...rest } = job;
      await this.core.jobs.write(turnLimit === undefined ? rest : { ...rest, turn_limit: turnLimit });
    });
  }

  #recordSession(workspace: string, ticket: string, sessionId: string): Promise<void> {
    return this.core.locked(async () => {
      const job = await this.core.jobs.read(workspace, ticket);
      if (job !== undefined && job.session_id !== sessionId) {
        await this.core.jobs.write({ ...job, session_id: sessionId });
      }
    });
  }

  // The session's queue is empty: publish the iteration, finish MR preparation, or hand the job
  // to a person.
  #idle(workspaceName: string, ticket: string, outcome: IdleOutcome): Promise<void> {
    return this.core.locked(async () => {
      const live = this.core.live.get(`${workspaceName}/${ticket}`);
      const job = await this.core.jobs.read(workspaceName, ticket);
      // A prompt sent after the queue drained started another turn; its idle publishes.
      if (live === undefined || job === undefined || live.session.busy) {
        return;
      }
      if (job.state !== 'working' && job.state !== 'preparing_mr') {
        return;
      }
      // Before the Patch and before the MR commit, whatever the outcome of the turn.
      await this.core.parts.control.clean(job, job.iteration + 1, live.cwd);
      // The turn's sandbox has ended (SF-085), before the hand-over at the end of MR preparation.
      await this.core.afterSession(job, job.iteration + 1);
      if (job.state === 'preparing_mr') {
        await this.core.parts.mr.mrIdle(job, live, outcome);
        return;
      }
      if (!outcome.ok) {
        // A turn that hit the plan's usage limit parks the job (SF-072); its turn runs again on Resume.
        const limit = outcome.code === 'session_failed' || outcome.code === 'turn_failed' ? usageLimit(outcome.message, new Date(), 'claude') : undefined;
        if (limit !== undefined) {
          await this.core.parts.control.park(job, 'turn', limit);
          return;
        }
        // from: working (#idle: preparing_mr went to mrIdle)
        await this.core.transition(job, 'needs_human', 'publish', { code: outcome.code, message: outcome.message });
        return;
      }
      try {
        const { job: published, changes } = await this.publish(job, live, outcome, await buildPatch(live.cwd, job.base_commit!), []);
        // The Report's answers to the last Fix section go into the ledger (SF-052); an escalated
        // item stops the job before the review.
        const escalated = await this.#answerFix(published, live.cwd, outcome.text);
        if (escalated.length > 0) {
          // from: working (#idle: preparing_mr went to mrIdle)
          await this.core.transition(published, 'needs_human', 'publish', { code: 'escalated', message: escalationMessage(escalated) }, [notificationLine(changes)]);
          return;
        }
        // from: working (#idle: preparing_mr went to mrIdle)
        this.core.parts.reviews.startReview(await this.core.transition(published, 'awaiting_review', 'publish', undefined, [notificationLine(changes)]));
      } catch (error) {
        console.error(error);
        // from: working (#idle: preparing_mr went to mrIdle)
        await this.core.transition(job, 'needs_human', 'publish', { code: 'publish_failed', message: 'The Report and Patch could not be published.' });
      }
    });
  }

  // The ledger after the Report of the job's last iteration (SF-052): the entries the Fix section it
  // answers listed take the Implementer's answers; returns the entries it escalated. Nothing before
  // the first Fix section. Only under the lock.
  async #answerFix(job: Job, cwd: string, report: string): Promise<LedgerEntry[]> {
    const ledger = await this.core.jobs.readLedger(job.workspace, job.ticket);
    const fix = job.iteration - 1;
    if (!ledger.some((entry) => entry.asked === fix)) {
      return [];
    }
    let task = '';
    try {
      task = await readFile(join(cwd, TASK_DIR, `${job.ticket}.md`), 'utf8');
    } catch (error) {
      console.error(error);
    }
    const root = resolvePath(cwd);
    const lines = async (path: string): Promise<number | undefined> => {
      const file = resolvePath(root, path);
      if (!file.startsWith(`${root}${sep}`)) {
        return undefined;
      }
      try {
        const text = await readFile(file, 'utf8');
        return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      } catch {
        return undefined;
      }
    };
    // A test's name counts when a test file of the worktree (tracked or new) holds it.
    const testNamed = async (name: string): Promise<boolean> =>
      (await runGit(cwd, ['grep', '--untracked', '-q', '-F', '-e', name, '--', '*test*', '*spec*'])).code === 0;
    // The user's own messages up to this iteration: a contest may quote one (SF-112).
    const userMessages = (await jobUserMessages(this.core.jobs, job.workspace, job.ticket)).filter((m) => m.iteration <= job.iteration).map((m) => m.text);
    const answered = await answerFix(ledger, report, fix, { lines, testNamed, sections: headings(task), userMessages });
    await this.core.jobs.writeLedger(job.workspace, job.ticket, answered.ledger);
    return answered.escalated;
  }

  // The marks rule of a job: the Task file's may_touch plus SF_SENSITIVE_PATHS for the
  // sensitivity, and its scope plus may_touch for the scope (SF-053).
  async #marks(workspace: Workspace, ticket: string): Promise<(path: string) => Marks> {
    let declared: string[] = [];
    let scope: string[] | undefined;
    try {
      const fields = parseFrontMatter(await readTask(workspace, ticket)) ?? new Map<string, string>();
      declared = mayTouch(fields);
      scope = taskScope(fields);
    } catch (error) {
      console.error(error);
    }
    return marksOf(declared, scope, this.core.config.sensitivePaths);
  }

  // Writes the next iteration (Report, Patch and the file list) and returns the job with its
  // iteration counted.
  async publish(job: Job, live: Live, outcome: Success, built: Patch, extraSections: string[]): Promise<{ job: Job; changes: FileChange[] }> {
    const { workspace: workspaceName, ticket } = job;
    const number = job.iteration + 1;
    const total = outcome.result.total_cost_usd ?? null;
    const previousTotal = number > 1 ? ((await this.core.jobs.readMeta(workspaceName, ticket, number - 1)).cost_usd_total ?? null) : null;
    const changes = await fileChanges(live.cwd, job.base_commit!, built.files, await this.#marks(live.workspace, ticket));
    const sections = [outcome.text.trim() || '(The Implementer wrote no report text.)', ...extraSections, changedFilesSection(built.files, built.truncated, changes)];
    if (outcome.denials.length > 0) {
      sections.push(['## Denied actions', '', ...outcome.denials.map((tool) => `- ${tool}`)].join('\n'));
    }
    // The rules the iteration was given (SF-059), before the Report that marks it complete.
    await copyRulesRecord(this.core.jobs.dir(workspaceName, ticket), this.core.jobs.iterationDir(workspaceName, ticket, number));
    await this.core.jobs.writeIteration(workspaceName, ticket, {
      report: `${sections.join('\n\n')}\n`,
      patch: built.patch,
      meta: {
        iteration: number,
        started_at: outcome.startedAt,
        ended_at: now(),
        denials: outcome.denials,
        changed_files: built.files,
        files: changes,
        patch_truncated: built.truncated,
        submodule_changed: built.submodules,
        cost_usd: iterationCost(total, previousTotal),
        cost_usd_total: total,
        duration_ms: outcome.result.duration_ms ?? null,
        base_commit: job.base_commit!,
      },
    });
    return { job: { ...job, iteration: number }, changes };
  }

  // The job a ledger stop held goes on (SF-052): a Fix section when the user decided a fix (with the
  // open blocker and major entries), otherwise the review that was stopped runs again: the gate
  // when it stopped the job, else the Claude review. Only under the lock.
  async goOn(job: Job, ledger: LedgerEntry[]): Promise<JobState> {
    const { workspace: workspaceName, ticket, iteration } = job;
    const fix = userFixItems(ledger, iteration);
    if (fix.items.length > 0) {
      // The lead line names the user's decisions only; open entries carried along keep their ids.
      const decided = fix.items.filter((item) => item.userNote !== undefined).map((item) => item.id).join(', ');
      try {
        await this.fix(job, fixContent(`The user settled the stop (${job.error?.code}): ${decided} to fix.`, fix.items, 'the user'), { ledger: fix.ledger, fromStop: true });
      } catch (error) {
        if (error instanceof FactoryError && error.code === 'iteration_limit') {
          return 'needs_human';
        }
        throw error;
      }
      return 'working';
    }
    if (job.worktree === null || !(await exists(job.worktree))) {
      throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
    }
    const review = await this.core.jobs.readReview(workspaceName, ticket, iteration);
    const gate = job.error?.code === 'escalated' ? undefined : await this.core.jobs.readGate(workspaceName, ticket, iteration);
    await this.core.jobs.removeGate(workspaceName, ticket, iteration);
    if (gate !== undefined && 'verdict' in gate && review !== undefined && 'verdict' in review) {
      // from: needs_human (checkSettle)
      await this.core.parts.reviews.startGate(await this.core.transition(job, 'awaiting_review', 'go_on'), review);
    } else {
      await this.core.jobs.removeReview(workspaceName, ticket, iteration);
      // from: needs_human (checkSettle)
      this.core.parts.reviews.startReview(await this.core.transition(job, 'awaiting_review', 'go_on'));
    }
    return (await this.core.job(workspaceName, ticket)).state;
  }

  // After Clean the branch holds the one commit: a further fix or message works on in the worktree,
  // which is kept until the push (SF-073), or recreates it from the branch when it is gone; the next
  // Clean commits the whole change again as one commit.
  async #reopen(job: Job, workspace: Workspace): Promise<Job> {
    const worktree = job.worktree ?? this.core.parts.handover.worktreePath(job.workspace, job.ticket);
    await this.core.gitLocked(job.workspace, () => attachWorktree(workspace.workCheckout, worktree, job.branch));
    const next: Job = { ...job, worktree, prepared_commit: null };
    await this.core.jobs.write(next);
    return next;
  }

  requestFix(workspaceName: string, ticket: string, content: string): Promise<{ iteration: number; check_after_minutes: number }> {
    return this.core.parts.control.request(workspaceName, ticket, { kind: 'fix', content }) as Promise<{ iteration: number; check_after_minutes: number }>;
  }

  // A Fix section needs a job awaiting review or in human review.
  checkFix(job: Job): void {
    checkNotInCheckout(job);
    if (job.state !== 'awaiting_review' && job.state !== 'ready_for_human_review') {
      throw new FactoryError('invalid_state', `request_fix needs awaiting_review or ready_for_human_review; the job is ${job.state}.`);
    }
  }

  // The work of request_fix, also run for a fix verdict of the review: appends ## Fix N and starts
  // the next iteration. SF_MAX_ITERATIONS limits the Fix sections; an sf say turn does not count.
  // counts: what else the Fix counts for (the gate's gate_fixes). Only under the lock.
  // ledger: the findings ledger with the section's items (SF-052), written once the section is.
  // fromStop: the Fix of the user's settlement or Simplify (SF-055), from needs_human.
  // title: the section's title after its number (## Fix N: Simplify).
  // overLimit: written even at SF_MAX_ITERATIONS (Simplify, once per job).
  async fix(current: Job, content: string, options: FixOptions = {}): Promise<{ iteration: number; check_after_minutes: number }> {
    const { counts = {}, ledger, fromStop = false, title, overLimit = false } = options;
    let job = current;
    const { workspace: workspaceName, ticket } = job;
    if (!(fromStop && job.state === 'needs_human')) {
      this.checkFix(job);
    }
    if (!overLimit && job.fixes >= this.core.config.maxIterations) {
      const message = `${job.fixes} Fix sections were written, the limit of SF_MAX_ITERATIONS`;
      // from: awaiting_review, ready_for_human_review (checkFix), needs_human (fromStop)
      await this.core.transition(job, 'needs_human', 'fix', { code: 'iteration_limit', message: `${message}; the user decides how to go on: sf accept takes iteration ${job.iteration} as it is when Claude's review of it is clean (the open findings go unapplied), sf say gives a direction.` });
      throw new FactoryError('iteration_limit', `${message}; the job needs the user.`);
    }
    const workspace = await this.core.resolve(workspaceName);
    // No turn while the user's checkout holds the branch (SF-073); nothing is written before.
    const free = job;
    await this.core.gitLocked(workspaceName, () => checkBranchFree(workspace.workCheckout, free.worktree, free.branch, ticket));
    if (job.state === 'ready_for_human_review') {
      job = await this.#reopen(job, workspace);
    }
    const fix = job.iteration;
    // A change made while the job was paused, before the factory's own Fix section (SF-067).
    const change = job.task_sha256 === undefined || job.worktree === null ? undefined : await this.core.parts.control.taskChange(workspace, job);
    await appendFix(workspace, ticket, fix, content, title, { record: (sha256) => this.#history.append(workspaceName, ticket, { kind: 'fix_added', by: 'factory', sha256, fix }) });
    if (ledger !== undefined) {
      await this.core.jobs.writeLedger(workspaceName, ticket, ledger);
    }
    job = await this.core.parts.start.syncTask(workspace, job);
    // A commit prepared before this turn is never pushed (SF-073).
    // from: awaiting_review, ready_for_human_review (checkFix), needs_human (fromStop)
    job = await this.core.transition({ ...job, ...counts, fixes: job.fixes + 1, prepared_commit: null }, 'working', 'fix');
    this.session(job, workspace).send(factoryPrompt(this.withChange(`/implement ${TASK_DIR}/${ticket}.md Fix ${fix}`, ticket, change), ticket, job.iteration + 1, this.imagesLine(job)), DENIED_TOOLS);
    return { iteration: job.iteration + 1, check_after_minutes: this.core.config.checkAfterFixMin };
  }

  // A user message into the session, queued as its next turn (in the runner's queue first, then,
  // while a turn runs, in the session's).
  say(workspaceName: string, ticket: string, message: string): Promise<{ state: JobState; queued: boolean }> {
    return this.core.parts.control.request(workspaceName, ticket, { kind: 'say', message }) as Promise<{ state: JobState; queued: boolean }>;
  }

  // sf say needs a job with a session to go on with and a non-empty text message.
  checkSay(job: Job, message: string): void {
    // A step of the hand-over that was cut off is repaired by recover() first (SF-073).
    if (job.handover !== undefined && job.handover.step !== null) {
      throw cutOffError(job, job.handover.step);
    }
    // A parked job (SF-072) has no session to queue a message in: Resume carries it.
    if (job.state === 'waiting_limit') {
      throw new FactoryError('invalid_state', `The job waits for the usage limit to reset. Resume the job with a message: sf resume ${job.workspace} ${job.ticket} [message]`);
    }
    if (!['working', 'awaiting_review', 'needs_human', 'ready_for_human_review', 'handed_over'].includes(job.state)) {
      throw new FactoryError('invalid_state', `sf say needs working, awaiting_review, needs_human, ready_for_human_review or handed_over; the job is ${job.state}.`);
    }
    if (job.state === 'handed_over') {
      this.core.parts.handover.checkHandedOverJob(job, 'sf say');
    }
    if (message.trim() === '' || message.includes('\0')) {
      throw new FactoryError('invalid_content', 'The message must be non-empty text.');
    }
  }

  // The message in the runner.
  sayInRunner(workspaceName: string, ticket: string, message: string): Promise<{ state: JobState; queued: boolean }> {
    return this.core.locked(async () => {
      let job = await this.core.job(workspaceName, ticket);
      this.checkSay(job, message);
      const workspace = this.core.live.get(`${workspaceName}/${ticket}`)?.workspace ?? (await this.core.resolve(workspaceName));
      if (job.state === 'handed_over') {
        // Ask for changes (SF-073): the checkout's state back into the job; by hand, so the run
        // queue's limit does not apply (SF-071).
        job = await this.core.parts.handover.askForChanges(job, workspace);
      }
      // No turn while the user's checkout holds the branch (SF-073), before anything else is written.
      const free = job;
      await this.core.gitLocked(workspaceName, () => checkBranchFree(workspace.workCheckout, free.worktree, free.branch, ticket));
      if (job.state === 'ready_for_human_review') {
        job = await this.#reopen(job, workspace);
      }
      // A commit prepared before this turn is never pushed (SF-073).
      if (job.prepared_commit !== null) {
        job = { ...job, prepared_commit: null };
        await this.core.jobs.write(job);
      }
      if (job.worktree === null || !(await exists(job.worktree))) {
        throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
      }
      const session = this.session(job, workspace);
      const queued = session.busy;
      // A change made while the job was paused and not handed on yet (SF-067).
      const change = job.task_sha256 === undefined ? undefined : await this.core.parts.control.taskChange(workspace, job);
      job = await this.core.parts.start.syncTask(workspace, job);
      if (job.state !== 'working') {
        // from: awaiting_review, needs_human, ready_for_human_review, handed_over (checkSay; working changes no state)
        job = await this.core.transition(job, 'working', 'say');
      }
      session.send(factoryPrompt(this.withChange(message, ticket, change), ticket, job.iteration + 1, this.imagesLine(job)), DENIED_TOOLS);
      return { state: job.state, queued };
    });
  }
}
