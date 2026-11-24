// The Implementer's turns: the session of each job, the end of a turn (#idle: the Report, the
// Patch and the published iteration), the turn limit, the answers to the Fix items, say (a user
// message; the Send of the planner's suggestion takes it too), requestFix and the Fix section the
// factory appends, and goOn (the path after a verdict).
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve as resolvePath, sep } from 'node:path';
import { type ImageRef, jobAttachment, type ResolvedImage, resolveTaskImages, sameImages, withoutImageData } from '../attachments.js';
import { DEFAULT_TOOL_STALL_MIN } from '../config.js';
import { FactoryError } from '../errors.js';
import { runGit } from '../git.js';
import { worktreeTree } from '../guard.js';
import { attachWorktree, checkBranchFree, isAncestor } from '../handoff.js';
import { jobUserMessages } from '../job-stream.js';
import { claudeReviews, type FileChange, type Handover, type Job, type JobState, now, type PauseStep, statesWith } from '../jobs.js';
import { checkLastReviewSend, dismissShownComments, sendShownComments } from '../last-review-choices.js';
import { answerFix, escalationMessage, headings, heldBackNote, type LedgerEntry, roundProgress, type RoundProgress, userFixItems } from '../ledger.js';
import { rebaseInProgress } from '../mr.js';
import { checkSuggestionSend, removeSuggestion, sendShownSuggestion } from '../planner.js';
import { buildPatch, changedFilesSection, fileChanges, notificationLine, type Patch } from '../patch.js';
import { factoryPrompt, iterationCost, quickFixNote, roundUsd } from '../prompts.js';
import { quickFixBaseline, quickFixRecord, withoutQuickFix } from '../quick-fix.js';
import { DENIED_TOOLS, type Marks, marksOf } from '../rules.js';
import type { Workspace } from '../registry.js';
import { copyRulesRecord, readJobRules } from '../rules-docs.js';
import { fixContent } from '../review.js';
import { pathDenials } from '../sandbox-denials.js';
import { endSession, type IdleOutcome, ImplementerSession, type LimitAnswer, type LimitedTurn } from '../session.js';
import { CONTINUE_PROMPT, limitDecision, worktreeChanged, type WorktreeState, worktreeState } from '../turn-limit.js';
import { appendFix, mayTouch, parseFrontMatter, readTask, TASK_DIR, taskScope } from '../task-file.js';
import { TicketHistory } from '../ticket-history.js';
import { usageLimit, type UsageLimit } from '../usage-limit.js';
import type { RunnerRequest } from '../runner.js';
import { implementerSkills, jobSkills } from '../skills.js';
import type { JobStorePort, LivePort, LockPort, RunnerPort, SettingsPort, StopPort } from './ports.js';
import { checkNotInCheckout, cutOffError } from './errors.js';
import { changeNote, type FixPack, freshFixPrompt, implementCommand, readJobFindings } from './prompts.js';
import { exists, type FixOptions, type Live } from './shared.js';

type Success = Extract<IdleOutcome, { ok: true }>;

// The skill the Implementer's first prompt runs (/implement, firstPrompt) when chosen, and the event of its absence.
const IMPLEMENT_SKILL = 'implement';
const SKILL_MISSING = 'skill_missing';

// The stops of the limits: the user's message at one starts their counts again.
const LIMIT_STOPS: readonly string[] = ['iteration_limit', 'gate_rounds', 'gate_budget'];

// The stop at the Fix round limit: stalled the job's review rounds without progress, max
// SF_MAX_ITERATIONS, round the judgement of the refused round (its open blocker and major findings,
// those it raised and reopened), iteration the one an Accept takes.
export function iterationLimitMessage(stalled: number, max: number, round: RoundProgress, iteration: number): string {
  return `${stalled} of the job's review rounds made no progress (SF_MAX_ITERATIONS is ${max}): each left no fewer open blocker and major findings than the fewest before, or reopened a fixed or left one. Open blocker or major findings: ${round.open} (${round.raised} raised by the last review, ${round.reopened} of them reopened; ${round.open - round.raised} carried from earlier rounds). The user decides how to go on: sf accept takes iteration ${iteration} as it is (the open findings go unapplied and are listed on the Merge request screen), sf say goes on: the count starts again, and the held-back findings go with the message.`;
}

// What TurnsPart calls of the other parts, by just those methods.
export interface TurnsControl {
  clean(job: Job, iteration: number, cwd: string): Promise<void>;
  park(job: Job, step: PauseStep, limit: UsageLimit): Promise<void>;
  request(workspaceName: string, ticket: string, request: Exclude<RunnerRequest, { kind: 'turn' }>): Promise<unknown>;
  taskChange(workspace: Workspace, job: Job): Promise<{ diff: string | undefined; sha256: string } | undefined>;
}

export interface TurnsHandover {
  askForChanges(job: Job, workspace: Workspace): Promise<Job>;
  checkHandedOverJob(job: Job, command: string): Handover;
  worktreePath(workspace: string, ticket: string): string;
}

export interface TurnsMr {
  conflictIdle(job: Job, live: Live, outcome: IdleOutcome): Promise<void>;
  mrIdle(job: Job, live: Live, outcome: IdleOutcome): Promise<void>;
}

export interface TurnsReviews {
  startReview(job: Job): Promise<void>;
  holdsMr(job: Job, resume: (job: Job) => Promise<void>): boolean;
  imageRefs(job: Job, task: string): ImageRef[];
}

export interface TurnsStart {
  syncTask(workspace: Workspace, job: Job): Promise<Job>;
  storeImages(job: Job, images: ResolvedImage[]): Promise<Job>;
}

export interface TurnsPeers {
  readonly control: TurnsControl;
  readonly handover: TurnsHandover;
  readonly mr: TurnsMr;
  readonly reviews: TurnsReviews;
  readonly start: TurnsStart;
}

export class TurnsPart {
  readonly #store: JobStorePort;
  readonly #locks: LockPort;
  readonly #sessions: LivePort;
  readonly #runner: RunnerPort;
  readonly #settings: SettingsPort;
  readonly #stop: StopPort;
  // The parts it calls (src/execution.ts wires them).
  readonly #peers: TurnsPeers;
  // The tickets' history: each Fix section the factory appends is recorded as fix_added.
  readonly #history: TicketHistory;

  constructor(store: JobStorePort, locks: LockPort, sessions: LivePort, runner: RunnerPort, settings: SettingsPort, stop: StopPort, peers: TurnsPeers) {
    this.#store = store;
    this.#locks = locks;
    this.#sessions = sessions;
    this.#runner = runner;
    this.#settings = settings;
    this.#stop = stop;
    this.#peers = peers;
    this.#history = new TicketHistory(settings.config.stateDir);
  }

  // The prompt of an Implementer turn, with the change of the Task file since the Implementer was
  // last given it (changed while paused) when there is one. change: taskChange's.
  withChange(prompt: string, ticket: string, change: { diff: string | undefined } | undefined): string {
    return change === undefined ? prompt : `${prompt}\n\n${changeNote(ticket, change.diff)}`;
  }

  // The images line of the job's prompts: their folder in the worktree and their names;
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
    this.#runner.runnerJob();
    if (this.#stop.isStopping()) {
      throw new FactoryError('runner_stopping', 'The runner of the job is stopping; no turn starts.');
    }
    const key = `${job.workspace}/${job.ticket}`;
    const live = this.#sessions.live.get(key);
    if (live !== undefined) {
      return live.session;
    }
    if (job.worktree === null) {
      throw new FactoryError('worktree_missing', `The job for ${key} has no worktree; it cannot run a turn.`);
    }
    const cwd = job.worktree;
    const { workspace: name, ticket } = job;
    let iteration = job.iteration + 1;
    // The worktree at the start of the turn running, for its turn limit.
    let start: WorktreeState | undefined;
    const probe = this.#settings.config.smokeProbeAllow;
    const toolStallMin = this.#settings.config.toolStallMin ?? DEFAULT_TOOL_STALL_MIN;
    const session = new ImplementerSession(
      {
        cwd, maxTurns: this.#settings.config.maxTurns, claudePath: this.#settings.config.claudePath,
        sessionId: job.session_id ?? undefined, sandbox: this.#settings.config.sandbox, model: this.#settings.config.model,
        turnLimitContinues: this.#settings.config.turnLimitContinues,
        // The watch of the turns' Bash calls; SF_TOOL_STALL_MIN=0 leaves it out.
        ...(toolStallMin > 0 ? { toolStall: { afterMs: toolStallMin * 60_000 } } : {}),
        // sf smoke's probe only, in mode dontAsk: undefined and false for every
        // real job's state directory.
        allowCommands: probe !== undefined ? [probe] : undefined,
        smokeMode: probe !== undefined,
        // The Implementer's skills the job's start recorded, in the folder it recorded (else the snapshot
        // link), bound read-only under the wrapper of each turn: a later sync or choice does not change them.
        skills: () => implementerSkills(this.#settings.config.stateDir, this.#store.jobs.eventsPath(name, ticket)),
        // Built by the session's first turn, again for every session the factory creates, with
        // the session's own temporary folder kept; under the wrapper (the sandbox on) its skills readable.
        pathDenials: (sessionTmp) => pathDenials({
          session: 'job', workspace: name, checkout: workspace.workCheckout, worktree: cwd, sessionTmp, stateDir: this.#settings.config.stateDir, worktreeRoot: this.#settings.config.worktreeRoot,
          wrappedSkills: this.#settings.config.sandbox !== undefined,
        }),
      },
      {
        prompt: async (prompt, continued, images) => {
          const current = await this.#store.jobs.read(name, ticket);
          iteration = (current?.iteration ?? 0) + 1;
          // The images by name, type and size only, never their bytes.
          const sent = images === undefined ? undefined : await Promise.all(images.map(async (image) => ({
            name: image.name, type: image.type,
            bytes: current?.attachments?.find((record) => record.name === image.name)?.bytes ?? (await stat(image.path).then((info) => info.size, () => 0)),
          })));
          await this.#store.jobs.appendEvent(name, ticket, { ts: now(), iteration, prompt, ...(sent !== undefined ? { images: sent } : {}) });
          start = await this.#worktreeState(cwd, current);
          // A prompt sent starts a new chain: the continuations of the last one no longer show.
          if (continued === 0 && current?.turn_limit !== undefined) {
            void this.#recordTurnLimit(name, ticket, undefined).catch(console.error);
          }
        },
        turnLimit: (turn) => this.#turnLimit(name, ticket, iteration, cwd, start, turn),
        // The session ended a stream stuck after its result; the turn goes on with that result.
        streamStuck: (waitedS) => this.#store.jobs.appendEvent(name, ticket, { ts: now(), iteration, type: 'turn_stream_stuck', waited_s: waitedS }),
        // The session ended a turn whose Bash call hung: its instruction goes again, or the job stops.
        toolStalled: (stall, action) => this.#store.jobs.appendEvent(name, ticket, {
          ts: now(), iteration, type: 'tool_stalled', tool: stall.tool, command: stall.command, open_s: stall.openS, reason: stall.reason, action,
        }),
        message: async (message: SDKMessage) => {
          // No image bytes in events.jsonl: a Read of an image returns them.
          await this.#store.jobs.appendEvent(name, ticket, { ts: now(), iteration, message: withoutImageData(message) });
          if (message.type === 'system' && message.subtype === 'init' && message.permissionMode === session.permissionMode) {
            // Queued, not awaited: the session must never wait for the lock (abort holds it while
            // it closes the session).
            void this.#recordSession(name, ticket, message.session_id);
          }
          if (message.type === 'system' && message.subtype === 'init' && !message.slash_commands.includes(IMPLEMENT_SKILL) && (await jobSkills(this.#settings.config.stateDir, this.#store.jobs.eventsPath(name, ticket))).roles.implementer.includes(IMPLEMENT_SKILL)) {
            await this.#recordSkillMissing(name, ticket, iteration);
          }
        },
        idle: (outcome) => this.#idle(name, ticket, outcome),
      },
    );
    this.#sessions.live.set(key, { workspace, session, cwd });
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

  // A turn of the job ended at maxTurns: go on with a continuation when the worktree
  // changed since start and the turn was not repeating itself, and the chain has one left (the
  // session's bound, turn.allowed); else the plain reason it stops. Never waits for the lock.
  async #turnLimit(name: string, ticket: string, iteration: number, cwd: string, start: WorktreeState | undefined, turn: LimitedTurn): Promise<LimitAnswer> {
    const end = await this.#worktreeState(cwd, await this.#store.jobs.read(name, ticket));
    const { allowed } = turn;
    const decision = limitDecision({ maxTurns: this.#settings.config.maxTurns, changed: worktreeChanged(start, end), calls: turn.calls, continued: turn.continued, allowed });
    if (!decision.continue) {
      return { stop: decision.message };
    }
    const continued = turn.continued + 1;
    await this.#store.jobs.appendEvent(name, ticket, {
      ts: now(), iteration, type: 'turn_limit_continued', continued, allowed, max_turns: this.#settings.config.maxTurns, changed_paths: end?.paths.length ?? 0, tool_calls: turn.calls.length,
    });
    void this.#recordTurnLimit(name, ticket, { continued, allowed }).catch(console.error);
    return { prompt: CONTINUE_PROMPT };
  }

  // Writes the continuations of the job's current chain (undefined: a new chain began). Queued,
  // not awaited by the session's hooks, as #recordSession.
  #recordTurnLimit(workspace: string, ticket: string, turnLimit: Job['turn_limit']): Promise<void> {
    return this.#locks.locked(async () => {
      const job = await this.#store.jobs.read(workspace, ticket);
      if (job === undefined || job.turn_limit?.continued === turnLimit?.continued) {
        return;
      }
      const { turn_limit: _old, ...rest } = job;
      await this.#store.jobs.write(turnLimit === undefined ? rest : { ...rest, turn_limit: turnLimit });
    });
  }

  // The session's init message lists no implement skill: /implement reaches the model as plain text.
  // Recorded once per job (none when the event log has one); the job carries on.
  async #recordSkillMissing(workspace: string, ticket: string, iteration: number): Promise<void> {
    // A log not there yet has no record.
    const log = await readFile(this.#store.jobs.eventsPath(workspace, ticket), 'utf8').catch(() => '');
    const recorded = (line: string): boolean => {
      try {
        return (JSON.parse(line) as { type?: unknown }).type === SKILL_MISSING;
      } catch { // a line that is not JSON is no record of it
        return false;
      }
    };
    if (!log.split('\n').some((line) => line.includes(`"${SKILL_MISSING}"`) && recorded(line))) {
      await this.#store.jobs.appendEvent(workspace, ticket, { ts: now(), iteration, type: SKILL_MISSING, skill: IMPLEMENT_SKILL });
    }
  }

  #recordSession(workspace: string, ticket: string, sessionId: string): Promise<void> {
    return this.#locks.locked(async () => {
      const job = await this.#store.jobs.read(workspace, ticket);
      if (job !== undefined && job.session_id !== sessionId) {
        await this.#store.jobs.write({ ...job, session_id: sessionId });
      }
    });
  }

  // The session's queue is empty: publish the iteration, finish MR preparation, or stop for a person.
  #idle(workspaceName: string, ticket: string, outcome: IdleOutcome): Promise<void> {
    return this.#locks.locked(async () => {
      const live = this.#sessions.live.get(`${workspaceName}/${ticket}`);
      const read = await this.#store.jobs.read(workspaceName, ticket);
      // A prompt sent after the queue drained started another turn; its idle publishes.
      if (live === undefined || read === undefined || live.session.busy) {
        return;
      }
      if (read.state !== 'working' && read.state !== 'preparing_mr') {
        return;
      }
      const job = await this.#recordSessionCost(read, outcome);
      // Before the Patch and before the MR commit, whatever the outcome of the turn.
      await this.#peers.control.clean(job, job.iteration + 1, live.cwd);
      // The turn's sandbox has ended, before the hand-over at the end of MR preparation.
      await this.#sessions.afterSession(job, job.iteration + 1);
      if (job.state === 'preparing_mr') {
        // MR preparation waits here, before its commit, while the iteration's last review runs:
        // its end goes on with this turn's outcome.
        if (this.#peers.reviews.holdsMr(job, (held) => this.#peers.mr.mrIdle(held, live, outcome))) {
          return;
        }
        await this.#peers.mr.mrIdle(job, live, outcome);
        return;
      }
      // A turn that hit the plan's usage limit parks the job; its turn runs again on Resume.
      const limit = !outcome.ok && (outcome.code === 'session_failed' || outcome.code === 'turn_failed') ? usageLimit(outcome.message, new Date(), 'claude') : undefined;
      if (limit !== undefined) {
        await this.#peers.control.park(job, 'turn', limit);
        return;
      }
      // A rebase of MR preparation left in progress (a stop, then a message) ends as a conflict turn.
      if (job.target_commit !== null && (await rebaseInProgress(live.cwd))) {
        await this.#peers.mr.conflictIdle(job, live, outcome);
        return;
      }
      if (!outcome.ok) {
        // from: working (#idle: preparing_mr went to mrIdle)
        await this.#store.transition(job, 'needs_human', 'publish', { code: outcome.code, message: outcome.message });
        return;
      }
      try {
        // Already rebased onto the target: measured against it, and back to review (as conflictIdle).
        const onTarget = job.target_commit !== null && job.target_commit !== job.base_commit && (await isAncestor(live.cwd, job.target_commit, 'HEAD'));
        const based = onTarget ? { ...job, base_commit: job.target_commit, mr_conflict_turn: false } : job;
        const { job: published, changes } = await this.publish(based, live, outcome, await buildPatch(live.cwd, based.base_commit!), []);
        // The Report's answers to the last Fix go into the ledger; an escalation stops the job.
        const escalated = await this.#answerFix(published, live.cwd, outcome.text);
        if (escalated.length > 0) {
          // from: working (#idle: preparing_mr went to mrIdle)
          await this.#store.transition(published, 'needs_human', 'publish', { code: 'escalated', message: escalationMessage(escalated) }, [notificationLine(changes)]);
          return;
        }
        // from: working (#idle: preparing_mr went to mrIdle)
        await this.#peers.reviews.startReview(await this.#store.transition(published, 'awaiting_review', 'publish', undefined, [notificationLine(changes)]));
      } catch (error) {
        console.error(error);
        // from: working (#idle: preparing_mr went to mrIdle)
        await this.#store.transition(job, 'needs_human', 'publish', { code: 'publish_failed', message: 'The Report and Patch could not be published.' });
      }
    });
  }

  // The ledger after the Report of the job's last iteration: the entries the Fix section it
  // answers listed take the Implementer's answers; returns the entries it escalated. Nothing before
  // the first Fix section. A contest's §section is checked against the Task file the reviewers read
  // (readReviewTask). Only under the lock.
  async #answerFix(job: Job, cwd: string, report: string): Promise<LedgerEntry[]> {
    const ledger = await this.#store.jobs.readLedger(job.workspace, job.ticket);
    const fix = job.iteration - 1;
    if (!ledger.some((entry) => entry.asked === fix)) {
      return [];
    }
    const task = (await this.#store.jobs.readReviewTask(job.workspace, job.ticket)) ?? '';
    const root = resolvePath(cwd);
    const lines = async (path: string): Promise<number | undefined> => {
      const file = resolvePath(root, path);
      if (!file.startsWith(`${root}${sep}`)) {
        return undefined;
      }
      try {
        const text = await readFile(file, 'utf8');
        return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      } catch { // missing or unreadable: no line count
        return undefined;
      }
    };
    // A test's name counts when a test file of the worktree (tracked or new) holds it.
    const testNamed = async (name: string): Promise<boolean> =>
      (await runGit(cwd, ['grep', '--untracked', '-q', '-F', '-e', name, '--', '*test*', '*spec*'])).code === 0;
    // The user's own messages up to this iteration: a contest may quote one.
    const userMessages = (await jobUserMessages(this.#store.jobs, job.workspace, job.ticket)).filter((m) => m.iteration <= job.iteration).map((m) => m.text);
    const answered = await answerFix(ledger, report, fix, { lines, testNamed, sections: headings(task), userMessages });
    await this.#store.jobs.writeLedger(job.workspace, job.ticket, answered.ledger);
    return answered.escalated;
  }

  // The marks rule of a job: the Task file's may_touch plus SF_SENSITIVE_PATHS for the
  // sensitivity, and its scope plus may_touch for the scope.
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
    return marksOf(declared, scope, this.#settings.config.sensitivePaths);
  }

  // Writes the next iteration (Report, Patch, the file list and commit_tree, the tree the
  // factory's commit of the worktree would have against the job's base) and returns the job with
  // its iteration counted.
  async publish(job: Job, live: Live, outcome: Success, built: Patch, extraSections: string[]): Promise<{ job: Job; changes: FileChange[] }> {
    const { workspace: workspaceName, ticket } = job;
    const number = job.iteration + 1;
    const total = outcome.result.total_cost_usd ?? null;
    const previous = number > 1 ? await this.#store.jobs.readMeta(workspaceName, ticket, number - 1) : undefined;
    const changes = await fileChanges(live.cwd, job.base_commit!, built.files, await this.#marks(live.workspace, ticket));
    const commitTree = await worktreeTree(live.cwd, job.base_commit!);
    const sections = [outcome.text.trim() || '(The Implementer wrote no report text.)', ...extraSections, changedFilesSection(built.files, built.truncated, changes)];
    if (outcome.denials.length > 0) {
      sections.push(['## Denied actions', '', ...outcome.denials.map((tool) => `- ${tool}`)].join('\n'));
    }
    // The rules the iteration was given, before the Report that marks it complete.
    await copyRulesRecord(this.#store.jobs.dir(workspaceName, ticket), this.#store.jobs.iterationDir(workspaceName, ticket, number));
    await this.#store.jobs.writeIteration(workspaceName, ticket, {
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
        cost_usd: iterationCost(total, previous, outcome.sessionId, job.unpublished_cost_usd ?? 0),
        cost_usd_total: total,
        session_id: outcome.sessionId,
        duration_ms: outcome.result.duration_ms ?? null,
        base_commit: job.base_commit!,
        commit_tree: commitTree,
      },
    });
    // The carried spend is in this iteration's cost now.
    return { job: { ...job, iteration: number, ...(job.unpublished_cost_usd !== undefined ? { unpublished_cost_usd: 0 } : {}) }, changes };
  }

  // The job a ledger stop held goes on: a Fix section when the user decided a fix (with the
  // open blocker and major entries), otherwise the round runs again (startReview): gate.json goes,
  // and review.json too unless both verdicts were stored; only the reviewer without a stored
  // verdict runs. Without the Claude review the gate is the round. Only under the lock.
  async goOn(job: Job, ledger: LedgerEntry[]): Promise<JobState> {
    const { workspace: workspaceName, ticket, iteration } = job;
    const fix = userFixItems(ledger, iteration);
    if (fix.items.length > 0) {
      // The lead line names the user's decisions only; open entries carried along keep their ids.
      const decided = fix.items.filter((item) => item.userNote !== undefined).map((item) => item.id).join(', ');
      // The user decided this Fix: SF_MAX_ITERATIONS does not stop it, only the next review's.
      await this.fix(job, fixContent(`The user settled the stop (${job.error?.code}): ${decided} to fix.`, fix.items, 'the user'), { ledger: fix.ledger, fromStop: true, byUser: true });
      return 'working';
    }
    if (job.worktree === null || !(await exists(job.worktree))) {
      throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
    }
    const review = claudeReviews(job) ? await this.#store.jobs.readReview(workspaceName, ticket, iteration) : undefined;
    const gate = job.error?.code === 'escalated' ? undefined : await this.#store.jobs.readGate(workspaceName, ticket, iteration);
    await this.#store.jobs.removeGate(workspaceName, ticket, iteration);
    if (claudeReviews(job) && !(gate !== undefined && 'verdict' in gate && review !== undefined && 'verdict' in review)) {
      await this.#store.jobs.removeReview(workspaceName, ticket, iteration);
    }
    // from: needs_human (checkSettle)
    await this.#peers.reviews.startReview(await this.#store.transition(job, 'awaiting_review', 'go_on'));
    return (await this.#store.job(workspaceName, ticket)).state;
  }

  // After Clean the branch holds the one commit: a further fix or message works on in the worktree,
  // which is kept until the push, or recreates it from the branch when it is gone; the next
  // Clean commits the whole change again as one commit.
  async #reopen(job: Job, workspace: Workspace): Promise<Job> {
    const worktree = job.worktree ?? this.#peers.handover.worktreePath(job.workspace, job.ticket);
    await this.#locks.gitLocked(job.workspace, () => attachWorktree(workspace.workCheckout, worktree, job.branch));
    const next: Job = { ...job, worktree, prepared_commit: null };
    await this.#store.jobs.write(next);
    return next;
  }

  requestFix(workspaceName: string, ticket: string, content: string): Promise<{ iteration: number; check_after_minutes: number }> {
    return this.#peers.control.request(workspaceName, ticket, { kind: 'fix', content }) as Promise<{ iteration: number; check_after_minutes: number }>;
  }

  // A Fix section needs a job awaiting review or in human review.
  checkFix(job: Job): void {
    checkNotInCheckout(job);
    if (job.state !== 'awaiting_review' && job.state !== 'ready_for_human_review') {
      throw new FactoryError('invalid_state', `request_fix needs awaiting_review or ready_for_human_review; the job is ${job.state}.`);
    }
  }

  // The work of request_fix, also run for a fix verdict of the review: appends ## Fix N and starts
  // the next iteration. SF_MAX_ITERATIONS limits the review rounds without progress
  // (roundProgress): the one that reaches it is refused; an sf say turn does not count, and a
  // message at a limit stop starts the limits' counts again. An important job's Fix is never refused
  // at SF_MAX_ITERATIONS.
  // counts: what else the Fix counts for (the gate's gate_fixes and gate_stalled). Only under the lock.
  // ledger: the findings ledger with the section's items, written once the section is.
  // fromStop: the Fix of the user's settlement or Simplify, from needs_human.
  // title: the section's title after its number (## Fix N: Simplify).
  // overLimit: never judged, so never refused (Simplify, once per job).
  // fromTests: the Tests Fix of a failed test run, from preparing_mr.
  // byUser: the Fix of the user's Must fix on a resuming settle, never judged, so never refused.
  async fix(current: Job, content: string, options: FixOptions = {}): Promise<{ iteration: number; check_after_minutes: number }> {
    const { counts = {}, ledger, fromStop = false, title, fromTests = false, byUser = false } = options;
    const overLimit = options.overLimit === true || fromTests || byUser;
    let job = current;
    const { workspace: workspaceName, ticket } = job;
    if (fromTests) {
      if (job.state !== 'preparing_mr') {
        throw new FactoryError('invalid_state', `A Tests Fix needs preparing_mr; the job is ${job.state}.`);
      }
    } else if (!(fromStop && job.state === 'needs_human')) {
      this.checkFix(job);
    }
    // The judgement of a round that may be refused: the job's new count and low, written with the Fix.
    let judged: Pick<Job, 'stalled_fixes' | 'least_open'> = {};
    if (!overLimit) {
      // Nothing is written before: an unreadable ledger refuses the Fix with nothing written.
      const before = await this.#store.jobs.readLedger(workspaceName, ticket);
      const round = roundProgress(before, ledger ?? before, job.least_open);
      const stalled = (job.stalled_fixes ?? 0) + (round.progress ? 0 : 1);
      const { maxIterations } = this.#settings.config;
      judged = { stalled_fixes: stalled, least_open: round.least };
      if (!round.progress && stalled >= maxIterations && job.important !== true) {
        // The refused verdict's items become open ledger entries with ids: the stop lists
        // them, and an Accept leaves them unapplied, listed on the Merge request screen.
        if (ledger !== undefined) {
          await this.#store.jobs.writeLedger(workspaceName, ticket, ledger);
        }
        // from: awaiting_review, ready_for_human_review (checkFix), needs_human (fromStop)
        await this.#store.transition({ ...job, ...judged }, 'needs_human', 'fix', { code: 'iteration_limit', message: iterationLimitMessage(stalled, maxIterations, round, job.iteration) });
        throw new FactoryError('iteration_limit', `${stalled} of the job's review rounds made no progress (SF_MAX_ITERATIONS is ${maxIterations}); the job needs the user.`);
      }
    }
    const workspace = await this.#settings.resolve(workspaceName);
    // No turn while the user's checkout holds the branch; nothing is written before.
    const free = job;
    await this.#locks.gitLocked(workspaceName, () => checkBranchFree(workspace.workCheckout, free.worktree, free.branch, ticket));
    // A fresh fix round gives the images the Task file refers to now, read as a Resume reads them:
    // one that cannot be used refuses the Fix (attachment_invalid) before anything is written.
    const images = job.fix_session === 'fresh' ? await resolveTaskImages(workspace.workCheckout, ticket, await readTask(workspace, ticket)) : undefined;
    if (job.state === 'ready_for_human_review') {
      job = await this.#reopen(job, workspace);
    }
    const fix = job.iteration;
    // A change made while the job was paused, before the factory's own Fix section; a fresh fix
    // round gives none.
    const change = job.task_sha256 === undefined || job.worktree === null || job.fix_session === 'fresh' ? undefined : await this.#peers.control.taskChange(workspace, job);
    await appendFix(workspace, ticket, fix, content, title, { record: (sha256) => this.#history.append(workspaceName, ticket, { kind: 'fix_added', by: byUser ? 'you' : 'factory', sha256, fix }) });
    if (ledger !== undefined) {
      await this.#store.jobs.writeLedger(workspaceName, ticket, ledger);
    }
    job = await this.#peers.start.syncTask(workspace, job);
    // A commit prepared before this turn is never pushed.
    job = fromTests
      // from: preparing_mr (fromTests)
      ? await this.#store.transition({ ...job, ...counts, prepared_commit: null }, 'working', 'tests')
      // from: awaiting_review, ready_for_human_review (checkFix), needs_human (fromStop)
      : await this.#store.transition({ ...job, ...counts, ...judged, fixes: job.fixes + 1, prepared_commit: null }, 'working', 'fix');
    const command = implementCommand(ticket, (await jobSkills(this.#settings.config.stateDir, this.#store.jobs.eventsPath(workspaceName, ticket))).roles.implementer, fix);
    let first = this.withChange(command, ticket, change);
    let blocks: ImageRef[] | undefined;
    if (job.fix_session === 'fresh') {
      // A new session reads the Task file as it is now: no change note; its images, as it refers to
      // them now, go as blocks.
      job = await this.#currentImages(await this.#endSessionForFix(job), images ?? []);
      const dir = this.#store.jobs.dir(workspaceName, ticket);
      first = freshFixPrompt(command, await readJobRules(dir), await this.#fixPack(job), job.base_commit, await readJobFindings(dir));
      blocks = this.#peers.reviews.imageRefs(job, (await this.#store.jobs.readTaskCopy(workspaceName, ticket)) ?? '');
    }
    this.session(job, workspace).send(factoryPrompt(first, ticket, job.iteration + 1, this.imagesLine(job), job.base_commit), DENIED_TOOLS, blocks);
    return { iteration: job.iteration + 1, check_after_minutes: this.#settings.config.checkAfterFixMin };
  }

  // Before a fix round of a job whose fix rounds run fresh: its live session object ends and
  // session_id is cleared, so session() builds a new one (denials, hooks and temporary folder fresh);
  // what the ended session spent after its last published iteration (session_cost_usd against that
  // iteration's total) is added to unpublished_cost_usd for the next published iteration. Only under the lock.
  async #endSessionForFix(job: Job): Promise<Job> {
    await endSession(this.#sessions.live, `${job.workspace}/${job.ticket}`);
    const { session_cost_usd: spent, ...rest } = job;
    let carried = job.unpublished_cost_usd ?? 0;
    if (spent !== undefined) {
      const last = job.iteration > 0 ? await this.#store.jobs.readMeta(job.workspace, job.ticket, job.iteration).catch(() => undefined) : undefined;
      carried += Math.max(0, iterationCost(spent.usd, last, spent.session_id) ?? 0);
    }
    const next: Job = { ...rest, session_id: null, ...(carried > 0 ? { unpublished_cost_usd: roundUsd(carried) } : {}) };
    await this.#store.jobs.write(next);
    return next;
  }

  // The job with the images the Task file refers to now (resolved by fix): when they differ from
  // the job's, they are copied into the job directory and the worktree and recorded (storeImages).
  // Only under the lock.
  async #currentImages(job: Job, images: ResolvedImage[]): Promise<Job> {
    return sameImages(job.attachments ?? [], images.map(jobAttachment)) ? job : this.#peers.start.storeImages(job, images);
  }

  // The previous iteration a fresh fix round's prompt gives (freshFixPrompt): its Report and its
  // file list (meta.json's files); either one that cannot be read is empty.
  async #fixPack(job: Job): Promise<FixPack> {
    const { workspace, ticket, iteration } = job;
    const report = await this.#store.jobs.readIteration(workspace, ticket, iteration).then((read) => read.report, () => '');
    const files = await this.#store.jobs.readMeta(workspace, ticket, iteration).then((meta) => meta.files ?? [], () => []);
    return { iteration, report, files };
  }

  // A turn's outcome in a job whose fix rounds run fresh: the running total of its session, published
  // or not, in session_cost_usd. Nothing in a job that resumes its session. Only under the lock.
  async #recordSessionCost(job: Job, outcome: IdleOutcome): Promise<Job> {
    const usd = outcome.ok ? outcome.result.total_cost_usd : undefined;
    if (job.fix_session !== 'fresh' || !outcome.ok || typeof usd !== 'number') {
      return job;
    }
    const next: Job = { ...job, session_cost_usd: { session_id: outcome.sessionId, usd } };
    await this.#store.jobs.write(next);
    return next;
  }

  // A user message into the session, queued as its next turn (in the runner's queue first, then,
  // while a turn runs, in the session's).
  say(workspaceName: string, ticket: string, message: string): Promise<{ state: JobState; queued: boolean }> {
    return this.#peers.control.request(workspaceName, ticket, { kind: 'say', message }) as Promise<{ state: JobState; queued: boolean }>;
  }

  // Send of the planner's suggestion on the dashboard: the note the page showed (sha256), sent
  // verbatim through say as the User's own message (on a handed_over job, Ask for changes). The check,
  // the say and the file's removal are one step under the suggestion's lock (sendShownSuggestion), so
  // a note the planner replaces or the User dismisses meanwhile is never sent. Refused without sending
  // when no suggestion is shown (no_suggestion: none, a job that does not wait for the User, an older
  // iteration's) and when the shown one is not the page's (suggestion_changed).
  sendSuggestion(workspaceName: string, ticket: string, sha256: string): Promise<{ state: JobState; queued: boolean }> {
    return sendShownSuggestion(this.#store.jobs, workspaceName, ticket, sha256, () => this.#store.job(workspaceName, ticket), (note) => this.say(workspaceName, ticket, note));
  }

  // Dismiss of the planner's suggestion: its file removed; whether there was one.
  async dismissSuggestion(workspaceName: string, ticket: string): Promise<{ dismissed: boolean }> {
    await this.#store.job(workspaceName, ticket);
    return { dismissed: await removeSuggestion(this.#store.jobs, workspaceName, ticket) };
  }

  // Send of the last review's comments on the dashboard: the stored texts of the comments the page
  // chose (ids, at the iteration it showed), as one message through say, the User's own (on a
  // handed_over job, Ask for changes). The check, the say and the record of the ids sent are one step
  // under the job's lock (sendShownComments). Refused without sending when the job shows no comments
  // at that iteration (invalid_state) and for no ids, an id not shown or given twice, or a message
  // too long (invalid_content).
  sendLastReview(workspaceName: string, ticket: string, iteration: number, ids: string[]): Promise<{ state: JobState; queued: boolean }> {
    return sendShownComments(this.#store.jobs, workspaceName, ticket, iteration, ids, () => this.#store.job(workspaceName, ticket), (message) => this.say(workspaceName, ticket, message));
  }

  // Dismiss of the last review's comments: the chosen ids recorded dismissed, refused as a Send is
  // except for the message's length; how many were recorded.
  dismissLastReview(workspaceName: string, ticket: string, iteration: number, ids: string[]): Promise<{ dismissed: number }> {
    return dismissShownComments(this.#store.jobs, workspaceName, ticket, iteration, ids, () => this.#store.job(workspaceName, ticket));
  }

  // sf say needs a job with a session to go on with and a non-empty text message.
  checkSay(job: Job, message: string): void {
    // A step of the hand-over that was cut off is repaired by recover() first.
    if (job.handover !== undefined && job.handover.step !== null) {
      throw cutOffError(job, job.handover.step);
    }
    // A parked job has no session to queue a message in: Resume carries it.
    if (job.state === 'waiting_limit') {
      throw new FactoryError('invalid_state', `The job waits for the usage limit to reset. Resume the job with a message: sf resume ${job.workspace} ${job.ticket} [message]`);
    }
    if (!statesWith('sayable').includes(job.state)) {
      throw new FactoryError('invalid_state', `sf say needs working, awaiting_review, needs_human, ready_for_human_review or handed_over; the job is ${job.state}.`);
    }
    if (job.state === 'handed_over') {
      this.#peers.handover.checkHandedOverJob(job, 'sf say');
    }
    if (message.trim() === '' || message.includes('\0')) {
      throw new FactoryError('invalid_content', 'The message must be non-empty text.');
    }
  }

  // sf quickfix: a user message as one turn, then MR preparation without a review round while the
  // change stays small (src/quick-fix.ts); only on a job ready for human review or handed over.
  quickFix(workspaceName: string, ticket: string, message: string): Promise<{ state: JobState; queued: boolean }> {
    return this.#peers.control.request(workspaceName, ticket, { kind: 'quick_fix', message }) as Promise<{ state: JobState; queued: boolean }>;
  }

  // sf quickfix needs ready_for_human_review or handed_over, the commit the user had (the hand-over's
  // saved commit, or the prepared commit) to measure the fix against, and what sf say needs.
  checkQuickFix(job: Job, message: string): void {
    if (job.state !== 'ready_for_human_review' && job.state !== 'handed_over') {
      throw new FactoryError('invalid_state', `sf quickfix needs ready_for_human_review or handed_over; the job is ${job.state}. Use sf say.`);
    }
    this.checkSay(job, message);
    quickFixBaseline(job);
  }

  // The quick fix in the runner: sayInRunner's steps with the quick fix's record and note.
  quickFixInRunner(workspaceName: string, ticket: string, message: string): Promise<{ state: JobState; queued: boolean }> {
    return this.#userTurn(workspaceName, ticket, message, true);
  }

  // The message in the runner. A message at a limit stop starts the limits' counts again
  // (stalled_fixes and gate_stalled to 0, the gate budget from the tokens used so far; least_open
  // stays), written with the turn's transition; after iteration_limit it carries the findings the
  // refused Fix held back (heldBackNote), which the turn's Report answers as a Fix section's. A
  // message ends a quick fix: its record goes, and the next iteration gets a review round.
  sayInRunner(workspaceName: string, ticket: string, message: string): Promise<{ state: JobState; queued: boolean }> {
    return this.#userTurn(workspaceName, ticket, message, false);
  }

  // The user's turn of sf say or, with quick, of sf quickfix. The quick fix's record is read on the
  // job as the user had it, before Ask for changes and #reopen change it, and written with the turn's
  // transition, before the turn is sent.
  #userTurn(workspaceName: string, ticket: string, message: string, quick: boolean): Promise<{ state: JobState; queued: boolean }> {
    return this.#locks.locked(async () => {
      let job = await this.#store.job(workspaceName, ticket);
      if (quick) {
        this.checkQuickFix(job, message);
      } else {
        this.checkSay(job, message);
        // The planner's note or the last review's comments a Send is sending go only while the job
        // still waits for the User at the iteration the Send checked: a message that came first may
        // have moved it on.
        await checkSuggestionSend(this.#store.jobs, job, message);
        await checkLastReviewSend(this.#store.jobs, job, message);
      }
      // Read on the job as it stopped, before anything below changes it; an unreadable ledger
      // refuses the message with nothing written.
      const atLimit = job.state === 'needs_human' && LIMIT_STOPS.includes(job.error?.code ?? '');
      const note = job.state === 'needs_human' && job.error?.code === 'iteration_limit' ? heldBackNote(await this.#store.jobs.readLedger(workspaceName, ticket), job.iteration) : '';
      const restart: Pick<Job, 'stalled_fixes' | 'gate_stalled' | 'gate_budget_from'> = atLimit ? { stalled_fixes: 0, gate_stalled: 0, gate_budget_from: job.gate_tokens } : {};
      const workspace = this.#sessions.live.get(`${workspaceName}/${ticket}`)?.workspace ?? (await this.#settings.resolve(workspaceName));
      const record = quick ? await quickFixRecord(job, workspace.workCheckout, await this.#store.jobs.readMeta(workspaceName, ticket, job.iteration)) : undefined;
      if (job.state === 'handed_over') {
        // Ask for changes: the checkout's state back into the job; by hand, so the run queue's
        // limit does not apply.
        job = await this.#peers.handover.askForChanges(job, workspace);
      }
      // No turn while the user's checkout holds the branch, before anything else is written.
      const free = job;
      await this.#locks.gitLocked(workspaceName, () => checkBranchFree(workspace.workCheckout, free.worktree, free.branch, ticket));
      if (job.state === 'ready_for_human_review') {
        job = await this.#reopen(job, workspace);
      }
      // A commit prepared before this turn is never pushed.
      if (job.prepared_commit !== null) {
        job = { ...job, prepared_commit: null };
        await this.#store.jobs.write(job);
      }
      if (job.worktree === null || !(await exists(job.worktree))) {
        throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
      }
      const session = this.session(job, workspace);
      const queued = session.busy;
      // A change made while the job was paused and not handed on yet.
      const change = job.task_sha256 === undefined ? undefined : await this.#peers.control.taskChange(workspace, job);
      job = await this.#peers.start.syncTask(workspace, job);
      let text = note === '' ? message : `${message}\n\n${note}`;
      if (record !== undefined) {
        await this.#store.jobs.appendEvent(workspaceName, ticket, { ts: now(), iteration: job.iteration, type: 'quick_fix', action: 'asked', from: record.from });
        // from: ready_for_human_review, handed_over (checkQuickFix)
        job = await this.#store.transition({ ...job, quick_fix: record }, 'working', 'quick_fix');
        text = `${message}\n\n${quickFixNote(this.#settings.config.quickFixMaxLines, this.#settings.config.quickFixMaxFiles)}`;
      } else if (job.state !== 'working') {
        // from: awaiting_review, needs_human, ready_for_human_review, handed_over (checkSay; working changes no state)
        job = await this.#store.transition({ ...withoutQuickFix(job), ...restart }, 'working', 'say');
      } else if (job.quick_fix !== undefined) {
        job = withoutQuickFix(job);
        await this.#store.jobs.write(job);
      }
      session.send(factoryPrompt(this.withChange(text, ticket, change), ticket, job.iteration + 1, this.imagesLine(job), job.base_commit), DENIED_TOOLS);
      return { state: job.state, queued };
    });
  }
}
