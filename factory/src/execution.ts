// The job lifecycle: start, check, request_fix, mark_clean (the MR preparation and the branch,
// SF-019, committed and rebased by the factory, SF-037), say, retryReview (the retry of a failed
// review, SF-044), approve (the push), abort, reset
// (and the dashboard's terminal-only Archive), status and the restart rule. Owns the Implementer session of each job, which works in the
// job's own worktree, and publishes an iteration (Report, Patch and the file list) when the
// session goes idle; then the Claude review of that iteration runs (SF-038, src/review.ts), and
// after a clean one the Codex gate (SF-039, src/gate.ts); the deciding verdict takes the path of
// request_fix or mark_clean. Every state change goes through #transition, the seam for
// notifications.
// Several jobs of one workspace run at the same time, up to SF_MAX_JOBS; the Git operations on
// the shared checkout are serialized per workspace.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import { GATE_REVIEWER, type GateOutcome, gatePrompt, noTokens, runGate } from './gate.js';
import { cutEvent, type FileChange, type GateRecord, isActive, type Job, type JobState, JobStore, now, type ReviewRecord, TERMINAL_STATES } from './jobs.js';
import { abortRebase, commitAndRebase, continueRebase, gitBusy, mergeRequestLink, originUrl, pushBranch, readMrText, rebaseInProgress, resolveTarget, unmergedPaths } from './mr.js';
import { buildPatch, changedFilesSection, fileChanges, fileSummaryLines, type Patch } from './patch.js';
import { removeSandboxPlaceholders } from './placeholders.js';
import { Redactor } from './redact.js';
import { conflictPrompt, factoryPrompt, iterationCost, mrPrompt } from './prompts.js';
import { DENIED_TOOLS, sensitivityOf } from './rules.js';
import type { Workspace } from './registry.js';
import { DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES, MIN_PAGE_BYTES, type Page, pageBuffer } from './repo-files.js';
import { fixContent, oneLine, REVIEWER, type ReviewInput, type ReviewItem, type ReviewOutcome, type ReviewOutput, reviewPrompt, runReview, sensitiveItem } from './review.js';
import { type IdleOutcome, ImplementerSession } from './session.js';
import { appendFix, isDraft, mayTouch, parseFrontMatter, readTask, TASK_DIR, TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';
import { addWorktree, deleteBranch, removeWorktree } from './worktree.js';

export const MAX_REPORT_BYTES = 64 * 1024;
const MAX_SLUG = 40;

export interface CheckResult {
  state: JobState;
  iteration: number;
  branch: string;
  since: string;
  check_after_minutes: number | null;
  error?: { code: string; message: string };
  report?: string;
  patch?: Page;
  // The MR text, once MR preparation produced one.
  mr?: string;
  // The sensitive and the deleted paths of the last published iteration.
  files?: { sensitive: Array<{ path: string; declared: boolean }>; deleted: string[] };
  // The Claude review of the last published iteration, and the gate's after a clean one.
  review?: ReviewStatus & { gate?: ReviewStatus };
}

export interface ReviewStatus {
  status: 'running' | 'done' | 'failed' | 'off';
  verdict?: 'clean' | 'fix';
  summary?: string;
}

// lines: extra notification lines (the MR title and link when pushed, the file summary).
export type StateListener = (job: Job, from: JobState | null, lines?: string[]) => void;

// How approve (the push) ended.
export interface MrOutcome {
  state: JobState;
  branch: string;
  error?: { code: string; message: string };
  title?: string;
  link?: string;
}

type Success = Extract<IdleOutcome, { ok: true }>;

// Branch slug: the title lowercased, runs of other characters than a-z and 0-9 as "-", trimmed,
// at most 40 characters.
export function slugify(title: string): string {
  const trim = (value: string): string => value.replace(/^-+|-+$/g, '');
  return trim(trim(title.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, MAX_SLUG));
}

export function branchName(ticket: string, title: string): string {
  const slug = slugify(title);
  return slug === '' ? ticket : `${ticket}-${slug}`;
}

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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// What the retirement of a job did: the archived job directory, the branch left as it is, and
// whether the checkout could not be cleaned (workspace unregistered or gone).
export interface Retired {
  archived: string;
  branch: string;
  checkout?: 'unavailable';
}

// What exclusive() hands its work: new calls only until the work settles; the lock is held until
// every call made has settled.
export interface ExclusiveScope {
  // Retires the ticket's current job, which must be terminal (job_active otherwise), as reset
  // does; job_not_found without a job. A failure also fails the exclusive section.
  retireFinished(workspace: string, ticket: string): Promise<Retired>;
}

interface Live {
  workspace: Workspace;
  session: ImplementerSession;
  // The session's cwd: the job's worktree.
  cwd: string;
  // During MR preparation: the target's ref name, and the files of a stopped rebase while the
  // conflict turn runs.
  mr?: { targetRef: string; conflicts?: string[] };
}

// A review in progress, Claude's or the gate's (one at a time per job): the iteration it reviews
// and what cancels it.
interface RunningReview {
  reviewer: typeof REVIEWER | typeof GATE_REVIEWER;
  iteration: number;
  controller: AbortController;
}

export class Execution {
  readonly jobs: JobStore;
  readonly #config: Config;
  readonly #resolve: (name: string) => Promise<Workspace>;
  readonly #onStateChange: StateListener;
  readonly #handbook: string;
  readonly #live = new Map<string, Live>();
  // The running review of each job, by "<workspace>/<ticket>".
  readonly #reviews = new Map<string, RunningReview>();
  #lock: Promise<unknown> = Promise.resolve();
  // One Git lock per workspace for the operations on the shared checkout.
  readonly #gitLocks = new Map<string, Promise<unknown>>();

  // handbook: the loaded Handbook text; MR preparation sends its Git rules and MR template, the
  // review its review rules.
  constructor(config: Config, resolve: (name: string) => Promise<Workspace>, onStateChange: StateListener = () => {}, handbook = '') {
    this.#config = config;
    this.jobs = new JobStore(config.stateDir);
    this.#resolve = resolve;
    this.#onStateChange = onStateChange;
    this.#handbook = handbook;
  }

  // One state-changing operation at a time.
  #locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#lock.catch(() => undefined).then(work);
    this.#lock = next;
    return next;
  }

  // Runs work under the same lock as the job operations, for changes that must not interleave
  // with a start (the workspace registry and the ticket actions of the dashboard's start screen).
  // The scope lets the work retire a finished job inside the same lock acquisition. It closes
  // when the work settles, so a later call cannot reach a job created after it, and the lock is
  // held until every retirement started through it has settled, awaited by the work or not. A
  // retirement that fails fails the section: with the work's own error when the work failed too,
  // else with the retirement's (never a success the retirement did not have).
  exclusive<T>(work: (scope: ExclusiveScope) => Promise<T>): Promise<T> {
    return this.#locked(async () => {
      let open = true;
      // Each started retirement as a promise that never rejects; the failures are kept here. The
      // handler is attached at once, so an unawaited failure is never an unhandled rejection.
      const started: Array<Promise<void>> = [];
      const failures: unknown[] = [];
      const scope: ExclusiveScope = {
        retireFinished: (workspaceName, ticket) => {
          if (!open) {
            return Promise.reject(new FactoryError('scope_closed', 'The exclusive section has ended; the job was not retired.'));
          }
          const retirement = this.#finishedJob(workspaceName, ticket, 'job_active').then((job) => this.#retire(job));
          started.push(retirement.then(() => undefined, (error: unknown) => {
            failures.push(error);
          }));
          return retirement;
        },
      };
      let result: T;
      try {
        result = await work(scope);
      } finally {
        open = false;
        await Promise.all(started);
      }
      if (failures.length > 0) {
        throw failures[0];
      }
      return result;
    });
  }

  // The checkout's Git operations of one workspace (fetch, worktree add and remove, branch
  // delete, the commit and rebase at Clean, push) never interleave; the rest runs concurrently.
  #gitLocked<T>(workspace: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#gitLocks.get(workspace) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#gitLocks.set(workspace, next);
    return next;
  }

  async #transition(job: Job, to: JobState, error?: { code: string; message: string }, lines?: string[]): Promise<Job> {
    const from = job.state;
    const { error: _previous, ...rest } = job;
    const next: Job = { ...rest, state: to, updated_at: now(), ...(error !== undefined ? { error } : {}) };
    await this.jobs.write(next);
    await this.jobs.appendEvent(job.workspace, job.ticket, {
      ts: next.updated_at,
      iteration: job.iteration,
      state: { from, to, ...(error !== undefined ? { error } : {}) },
    });
    try {
      this.#onStateChange(next, from, lines);
    } catch (listenerError) {
      console.error(listenerError);
    }
    return next;
  }

  async #job(workspace: string, ticket: string): Promise<Job> {
    if (!TICKET_PATTERN.test(ticket)) {
      throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
    }
    const job = await this.jobs.read(workspace, ticket);
    if (job === undefined) {
      throw new FactoryError('job_not_found', `There is no job for ${workspace}/${ticket}.`);
    }
    return job;
  }

  #checkAfter(job: Job): number {
    return job.iteration === 0 ? this.#config.checkAfterStartMin : this.#config.checkAfterFixMin;
  }

  #worktreePath(workspace: string, ticket: string): string {
    return join(this.#config.worktreeRoot, workspace, ticket);
  }

  // At serve start no turn is live: working jobs need a person, interrupted starts failed, a job
  // awaiting review whose last iteration has no review gets one, and one whose last iteration has a
  // clean review but no gate.json gets its gate (or, with the gate off now, Clean).
  recover(): Promise<void> {
    return this.#locked(async () => {
      for (const job of await this.jobs.list()) {
        const review = job.state === 'awaiting_review' && job.iteration > 0 ? await this.jobs.readReview(job.workspace, job.ticket, job.iteration) : undefined;
        if (job.state === 'awaiting_review' && job.iteration > 0 && review === undefined) {
          this.#startReview(job);
        } else if (review !== undefined && 'verdict' in review && review.verdict === 'clean'
          && (await this.jobs.readGate(job.workspace, job.ticket, job.iteration)) === undefined) {
          await this.#applying(job, () => this.#afterClaude(job, review));
        } else if (job.state === 'working') {
          await this.#transition(job, 'needs_human', { code: 'serve_restarted', message: 'sf serve restarted while the iteration ran; use sf say to continue.' });
        } else if (job.state === 'preparing_mr') {
          await this.#transition(job, 'needs_human', { code: 'mr_serve_restarted', message: 'sf serve restarted during MR preparation; call mark_clean again.' });
        } else if (job.state === 'starting') {
          await this.#transition(job, 'failed', { code: 'serve_restarted', message: 'sf serve restarted while the job was starting.' });
        }
      }
    });
  }

  // Creates the job record and its worktree, then runs the first iteration. The validation and
  // the record are under the lock, the fetch and the worktree creation under the workspace's Git
  // lock only, so a long fetch holds no other job.
  async start(workspaceName: string, ticket: string): Promise<{ branch: string; state: JobState; check_after_minutes: number; worktree: string }> {
    const claimed = await this.#locked(async () => {
      if (!TICKET_PATTERN.test(ticket)) {
        throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
      }
      const workspace = await this.#resolve(workspaceName);
      const content = await readTask(workspace, ticket);
      if (isDraft(content)) {
        throw new FactoryError('task_draft', `${TASK_DIR}/${ticket}.md is still the skeleton: the Context owner writes the Task with write_task first, then starts on the user's word.`);
      }
      const fields = parseFrontMatter(content)!;
      const base = fields.get('base')!;
      const branch = branchName(ticket, fields.get('title')!);

      const existing = await this.jobs.read(workspace.name, ticket);
      if (existing !== undefined && !TERMINAL_STATES.includes(existing.state)) {
        throw new FactoryError('job_exists', `The job for ${workspace.name}/${ticket} is ${existing.state}.`);
      }
      const live = (await this.jobs.list()).filter((job) => job.workspace === workspace.name && isActive(job));
      if (live.length >= this.#config.maxJobs) {
        throw new FactoryError('job_limit', `Workspace ${workspace.name} has ${live.length} live job(s) (${live.map((job) => `${job.ticket} ${job.state}`).join(', ')}); SF_MAX_JOBS is ${this.#config.maxJobs}.`);
      }
      if (existing !== undefined) {
        await this.jobs.archive(workspace.name, ticket);
      }
      const created = now();
      const worktree = this.#worktreePath(workspace.name, ticket);
      const job: Job = {
        workspace: workspace.name, ticket, branch, base, base_commit: null, state: 'starting', worktree, prepared_commit: null,
        iteration: 0, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null, target_commit: null, mr_attempts: 0, created_at: created, updated_at: created,
      };
      await this.jobs.write(job);
      await this.jobs.appendEvent(workspace.name, ticket, { ts: created, iteration: 0, state: { from: null, to: 'starting' } });
      return { workspace, job, base, branch, worktree };
    });
    const { workspace, base, branch, worktree } = claimed;
    let baseCommit: string;
    try {
      baseCommit = await this.#gitLocked(workspace.name, () => this.#createWorktree(workspace.workCheckout, base, branch, worktree));
    } catch (error) {
      const failure = error instanceof FactoryError ? error : new FactoryError('start_failed', 'Git failed while creating the worktree.');
      await this.#locked(async () => {
        const job = await this.jobs.read(workspace.name, ticket);
        if (job !== undefined && job.state === 'starting') {
          await this.#transition({ ...job, worktree: null }, 'failed', { code: failure.code, message: failure.message });
        }
      });
      throw failure;
    }
    return this.#locked(async () => {
      let job = await this.jobs.read(workspace.name, ticket);
      if (job === undefined || job.state !== 'starting') {
        await removeWorktree(workspace.workCheckout, worktree);
        throw new FactoryError('job_ended', `The job for ${workspace.name}/${ticket} ended while it was starting.`);
      }
      job = { ...job, base_commit: baseCommit };
      await this.jobs.write(job);
      await this.#syncTask(workspace, job);
      job = await this.#transition(job, 'working');
      this.#session(job, workspace).send(factoryPrompt(`/implement ${TASK_DIR}/${ticket}.md`, ticket, job.iteration + 1), DENIED_TOOLS);
      return { branch, state: job.state, check_after_minutes: this.#config.checkAfterStartMin, worktree };
    });
  }

  // Fetches the base when origin exists, checks the names, creates the branch and its worktree
  // and returns the base commit.
  async #createWorktree(checkout: string, base: string, branch: string, path: string): Promise<string> {
    const valid = async (name: string): Promise<boolean> => !name.startsWith('-') && (await runGit(checkout, ['check-ref-format', '--branch', name])).code === 0;
    if (!(await valid(base))) {
      throw new FactoryError('base_not_found', `The base "${base}" is not a valid branch name.`);
    }
    if (!(await valid(branch))) {
      throw new FactoryError('invalid_ticket', `"${branch}" is not a valid branch name.`);
    }
    const { ref, commit } = await resolveTarget(checkout, base);
    if ((await runGit(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
      throw new FactoryError('branch_exists', `The branch ${branch} already exists in the checkout.`);
    }
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await addWorktree(checkout, path, branch, { create: true, ref });
    return commit;
  }

  // The Task file of the checkout, copied into the worktree before every Implementer turn.
  async #syncTask(workspace: Workspace, job: Job): Promise<void> {
    if (job.worktree === null) {
      return;
    }
    const dir = join(job.worktree, TASK_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await copyFile(join(workspace.workCheckout, TASK_DIR, `${job.ticket}.md`), join(dir, `${job.ticket}.md`));
  }

  // Removes the sandbox's placeholder files from the worktree; a failure is logged and the steps
  // that follow (Patch, MR commit) still skip them.
  async #removePlaceholders(cwd: string): Promise<string[]> {
    try {
      return await removeSandboxPlaceholders(cwd);
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  async #logPlaceholders(job: Job, iteration: number, paths: string[]): Promise<void> {
    if (paths.length > 0) {
      await this.jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration, type: 'placeholders_removed', paths });
    }
  }

  // Removes the placeholders and logs them under iteration (the turn's, as its messages are).
  async #clean(job: Job, iteration: number, cwd: string): Promise<void> {
    try {
      await this.#logPlaceholders(job, iteration, await this.#removePlaceholders(cwd));
    } catch (error) {
      console.error(error);
    }
  }

  // The job's live session, created on first use with the worktree as cwd.
  #session(job: Job, workspace: Workspace): ImplementerSession {
    const key = `${job.workspace}/${job.ticket}`;
    const live = this.#live.get(key);
    if (live !== undefined) {
      return live.session;
    }
    if (job.worktree === null) {
      throw new FactoryError('worktree_missing', `The job for ${key} has no worktree; it cannot run a turn.`);
    }
    const cwd = job.worktree;
    const { workspace: name, ticket } = job;
    let iteration = job.iteration + 1;
    const session = new ImplementerSession(
      {
        cwd, maxTurns: this.#config.maxTurns, claudePath: this.#config.claudePath,
        sessionId: job.session_id ?? undefined, sandbox: this.#config.sandbox, model: this.#config.model,
      },
      {
        prompt: async (prompt) => {
          iteration = ((await this.jobs.read(name, ticket))?.iteration ?? 0) + 1;
          await this.jobs.appendEvent(name, ticket, { ts: now(), iteration, prompt });
        },
        message: async (message: SDKMessage) => {
          await this.jobs.appendEvent(name, ticket, { ts: now(), iteration, message });
          if (message.type === 'system' && message.subtype === 'init' && message.permissionMode === 'auto') {
            // Queued, not awaited: the session must never wait for the lock (abort holds it while
            // it closes the session).
            void this.#recordSession(name, ticket, message.session_id);
          }
        },
        idle: (outcome) => this.#idle(name, ticket, outcome),
      },
    );
    this.#live.set(key, { workspace, session, cwd });
    return session;
  }

  #recordSession(workspace: string, ticket: string, sessionId: string): Promise<void> {
    return this.#locked(async () => {
      const job = await this.jobs.read(workspace, ticket);
      if (job !== undefined && job.session_id !== sessionId) {
        await this.jobs.write({ ...job, session_id: sessionId });
      }
    });
  }

  // The session's queue is empty: publish the iteration, finish MR preparation, or hand the job
  // to a person.
  #idle(workspaceName: string, ticket: string, outcome: IdleOutcome): Promise<void> {
    return this.#locked(async () => {
      const live = this.#live.get(`${workspaceName}/${ticket}`);
      const job = await this.jobs.read(workspaceName, ticket);
      // A prompt sent after the queue drained started another turn; its idle publishes.
      if (live === undefined || job === undefined || live.session.busy) {
        return;
      }
      if (job.state !== 'working' && job.state !== 'preparing_mr') {
        return;
      }
      // Before the Patch and before the MR commit, whatever the outcome of the turn.
      await this.#clean(job, job.iteration + 1, live.cwd);
      if (job.state === 'preparing_mr') {
        await this.#mrIdle(job, live, outcome);
        return;
      }
      if (!outcome.ok) {
        await this.#transition(job, 'needs_human', { code: outcome.code, message: outcome.message });
        return;
      }
      try {
        const { job: published, changes } = await this.#publish(job, live, outcome, await buildPatch(live.cwd, job.base_commit!), []);
        this.#startReview(await this.#transition(published, 'awaiting_review', undefined, fileSummaryLines(changes)));
      } catch (error) {
        console.error(error);
        await this.#transition(job, 'needs_human', { code: 'publish_failed', message: 'The Report and Patch could not be published.' });
      }
    });
  }

  // The sensitivity rule of a job: the Task file's may_touch plus SF_SENSITIVE_PATHS.
  async #sensitivity(workspace: Workspace, ticket: string): Promise<(path: string) => FileChange['sensitive']> {
    let declared: string[] = [];
    try {
      declared = mayTouch(parseFrontMatter(await readTask(workspace, ticket)) ?? new Map());
    } catch (error) {
      console.error(error);
    }
    return (path) => sensitivityOf(path, declared, this.#config.sensitivePaths);
  }

  // Writes the next iteration (Report, Patch and the file list) and returns the job with its
  // iteration counted.
  async #publish(job: Job, live: Live, outcome: Success, built: Patch, extraSections: string[]): Promise<{ job: Job; changes: FileChange[] }> {
    const { workspace: workspaceName, ticket } = job;
    const number = job.iteration + 1;
    const total = outcome.result.total_cost_usd ?? null;
    const previousTotal = number > 1 ? ((await this.jobs.readMeta(workspaceName, ticket, number - 1)).cost_usd_total ?? null) : null;
    const changes = await fileChanges(live.cwd, job.base_commit!, built.files, await this.#sensitivity(live.workspace, ticket));
    const sections = [outcome.text.trim() || '(The Implementer wrote no report text.)', ...extraSections, changedFilesSection(built.files, built.truncated, changes)];
    if (outcome.denials.length > 0) {
      sections.push(['## Denied actions', '', ...outcome.denials.map((tool) => `- ${tool}`)].join('\n'));
    }
    await this.jobs.writeIteration(workspaceName, ticket, {
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
      },
    });
    return { job: { ...job, iteration: number }, changes };
  }

  // The end of a turn of MR preparation (mark_clean). After the MR text turn: validate the text,
  // then the factory commits and rebases in the worktree. A rebase that stops on conflicts stays
  // in progress for one conflict turn, whose end comes back here (#conflictIdle). Ready: record
  // the branch tip, remove the worktree and hand the job to the user.
  async #mrIdle(job: Job, live: Live, outcome: IdleOutcome): Promise<void> {
    const cwd = live.cwd;
    const needsHuman = async (code: string, message: string): Promise<void> => {
      await this.#transition(job, 'needs_human', { code, message });
    };
    try {
      if (await rebaseInProgress(cwd)) {
        await this.#conflictIdle(job, live, outcome);
        return;
      }
      if (!outcome.ok) {
        await needsHuman(outcome.code, outcome.message);
        return;
      }
      const mrText = await readMrText(cwd, job.ticket);
      if (!mrText.ok) {
        await needsHuman(mrText.code, mrText.message);
        return;
      }
      const targetCommit = job.target_commit!;
      const prepared = await this.#gitLocked(job.workspace, () => commitAndRebase(cwd, { baseCommit: job.base_commit!, targetCommit, mrText: mrText.text }));
      if (prepared.kind === 'failed') {
        await needsHuman(prepared.failure.code, prepared.failure.message);
        return;
      }
      await this.jobs.writeMrText(job.workspace, job.ticket, mrText.text);
      if (prepared.kind === 'conflict') {
        // The job stays preparing_mr while the Implementer resolves the conflicts.
        const targetRef = live.mr?.targetRef ?? job.base;
        live.mr = { targetRef, conflicts: prepared.files };
        live.session.send(conflictPrompt({ ticket: job.ticket, targetRef, targetCommit, files: prepared.files }), DENIED_TOOLS);
        return;
      }
      await this.#ready(job, live, mrText.text);
    } catch (error) {
      console.error(error);
      await needsHuman('mr_failed', `MR preparation failed inside the factory: ${(error as Error).message}`.slice(0, 1000));
    }
  }

  // The end of the conflict turn: a failed turn, a file still holding a conflict marker or a
  // failing continue aborts the rebase (mr_conflict). After a continue the change is no longer the
  // reviewed one: it goes back to review against the target, in the same worktree.
  async #conflictIdle(job: Job, live: Live, outcome: IdleOutcome): Promise<void> {
    const cwd = live.cwd;
    const files = live.mr?.conflicts ?? (await unmergedPaths(cwd));
    const targetRef = live.mr?.targetRef ?? job.base;
    const targetCommit = job.target_commit!;
    live.mr = { targetRef };
    if (!outcome.ok) {
      await this.#gitLocked(job.workspace, () => abortRebase(cwd));
      const message = `The rebase had conflicts in ${files.join(', ')}; the conflict turn failed (${outcome.code}: ${outcome.message}). The rebase was aborted.`;
      await this.#transition(job, 'needs_human', { code: 'mr_conflict', message: message.slice(0, 1000) });
      return;
    }
    const failure = await this.#gitLocked(job.workspace, () => continueRebase(cwd, files));
    if (failure !== undefined) {
      await this.#transition(job, 'needs_human', failure);
      return;
    }
    const rebased: Job = { ...job, base_commit: targetCommit, target_commit: targetCommit };
    const note = [
      '## MR preparation',
      '',
      `The rebase onto ${targetRef} (${targetCommit}) had conflicts in ${files.join(', ')}, resolved by the Implementer. The Patch is now against the target.`,
    ].join('\n');
    const { job: published, changes } = await this.#publish(rebased, live, outcome, await buildPatch(cwd, targetCommit), [note]);
    this.#startReview(await this.#transition(published, 'awaiting_review', undefined, fileSummaryLines(changes)));
  }

  // Starts the Claude review of the job's last iteration; it runs outside the lock. A review still
  // running for the job is cancelled. Nothing with SF_REVIEW=off.
  #startReview(job: Job): void {
    if (!this.#config.review) {
      return;
    }
    const key = `${job.workspace}/${job.ticket}`;
    this.#reviews.get(key)?.controller.abort();
    const running: RunningReview = { reviewer: REVIEWER, iteration: job.iteration, controller: new AbortController() };
    this.#reviews.set(key, running);
    this.#review(job, running).catch((error: unknown) => console.error(error));
  }

  // The user's retry of a failed review (sf review, the dashboard's Retry review): the job goes
  // back to awaiting_review without a new iteration, the failed review.json goes, and the review
  // of the last iteration runs again.
  retryReview(workspaceName: string, ticket: string): Promise<{ state: JobState; iteration: number }> {
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      if (!this.#config.review) {
        throw new FactoryError('review_off', 'The Claude review is off (SF_REVIEW=off); nothing would review the iteration.');
      }
      if (job.state !== 'needs_human' || job.error?.code !== 'review_failed') {
        throw new FactoryError('invalid_state', `sf review needs needs_human after a failed review (review_failed); the job is ${job.state}${job.error !== undefined ? ` (${job.error.code})` : ''}.`);
      }
      if (job.worktree === null || !(await exists(job.worktree))) {
        throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
      }
      await this.jobs.removeReview(workspaceName, ticket, job.iteration);
      const next = await this.#transition(job, 'awaiting_review');
      this.#startReview(next);
      return { state: next.state, iteration: next.iteration };
    });
  }

  #cancelReview(key: string): void {
    this.#reviews.get(key)?.controller.abort();
    this.#reviews.delete(key);
  }

  // The material of a review of the job's last iteration, the Task file read in the worktree.
  async #reviewInput(job: Job, worktree: string): Promise<ReviewInput> {
    const { workspace: name, ticket, iteration } = job;
    const { report, patch } = await this.jobs.readIteration(name, ticket, iteration);
    const meta = await this.jobs.readMeta(name, ticket, iteration);
    return {
      ticket, iteration, report, patch, patchTruncated: meta.patch_truncated, files: meta.files, handbook: this.#handbook,
      task: await readFile(join(worktree, TASK_DIR, `${ticket}.md`), 'utf8'),
    };
  }

  // Appends one message of a running review (review_message) or one Codex event of a running gate
  // (gate_event), already redacted (src/redact.ts), to the job's events.jsonl, cut to its bound
  // (SF-045).
  #appendLive(job: Job, type: 'review_message' | 'gate_event', raw: unknown): Promise<void> {
    const { value, truncated } = cutEvent(raw);
    const cut = truncated ? { truncated: true as const } : {};
    return this.jobs.appendEvent(job.workspace, job.ticket, type === 'review_message'
      ? { ts: now(), iteration: job.iteration, type, reviewer: REVIEWER, message: value, ...cut }
      : { ts: now(), iteration: job.iteration, type, reviewer: GATE_REVIEWER, event: value, ...cut });
  }

  // Runs the review session, then applies its outcome under the lock.
  async #review(job: Job, running: RunningReview): Promise<void> {
    let outcome: ReviewOutcome;
    const redactor = new Redactor({ cwd: job.worktree ?? '' });
    try {
      if (job.worktree === null) {
        throw new Error('the job has no worktree');
      }
      const prompt = reviewPrompt(await this.#reviewInput(job, job.worktree));
      outcome = await runReview(prompt, {
        cwd: job.worktree, claudePath: this.#config.claudePath, sandbox: this.#config.sandbox, model: this.#config.reviewModel,
        maxTurns: this.#config.reviewMaxTurns, signal: running.controller.signal,
        // The session live in events.jsonl (SF-045).
        onMessage: (message) => this.#appendLive(job, 'review_message', redactor.reviewMessage(message)),
      });
    } catch (error) {
      const at = now();
      outcome = { ok: false, message: `The review could not start: ${(error as Error).message}`.slice(0, 1000), startedAt: at, endedAt: at };
    }
    // The failure message goes to review.json, the event and the job's error: withheld or redacted
    // like the session's prose (src/redact.ts, failure).
    if (!outcome.ok) {
      outcome = { ...outcome, message: redactor.failure(outcome.message) };
    }
    const ended = outcome;
    await this.#locked(() => this.#reviewed(job, running, ended));
  }

  // The end of a review. A cancelled one leaves no trace. Otherwise review.json and the event are
  // written; the verdict applies only while the job still awaits review of the same iteration.
  async #reviewed(reviewed: Job, running: RunningReview, outcome: ReviewOutcome): Promise<void> {
    const { workspace: name, ticket, iteration } = reviewed;
    const key = `${name}/${ticket}`;
    if (this.#reviews.get(key) !== running || running.controller.signal.aborted) {
      return;
    }
    this.#reviews.delete(key);
    const job = await this.jobs.read(name, ticket);
    // Another job of the ticket (after a reset) is not this review's.
    if (job === undefined || job.created_at !== reviewed.created_at) {
      return;
    }
    const current = job.state === 'awaiting_review' && job.iteration === iteration;
    const ignored = current ? {} : { ignored: true as const };
    const record: ReviewRecord = outcome.ok
      ? { reviewer: REVIEWER, ...outcome.output, cost_usd: outcome.costUsd, started_at: outcome.startedAt, ended_at: outcome.endedAt }
      : { reviewer: REVIEWER, error: outcome.message };
    await this.jobs.writeReview(name, ticket, iteration, record);
    await this.jobs.appendEvent(name, ticket, outcome.ok
      ? { ts: now(), iteration, type: 'review', reviewer: REVIEWER, verdict: outcome.output.verdict, items: outcome.output.items.length, ...ignored }
      : { ts: now(), iteration, type: 'review_failed', reviewer: REVIEWER, error: outcome.message, ...ignored });
    if (!current) {
      return;
    }
    if (!outcome.ok) {
      await this.#transition(job, 'needs_human', { code: 'review_failed', message: outcome.message });
      return;
    }
    await this.#applying(job, () => this.#afterClaude(job, outcome.output));
  }

  // The undeclared sensitive paths of the job's last iteration not in accepted, as fix items.
  async #unaccepted(job: Job, accepted: string[]): Promise<ReviewItem[]> {
    return ((await this.#lastFiles(job)) ?? [])
      .filter((change) => change.sensitive === 'undeclared' && !accepted.includes(change.path))
      .map((change) => sensitiveItem(change.path));
  }

  // The Claude verdict: fix (or an undeclared sensitive path it does not accept) is the next Fix
  // section; clean starts the gate, or with the gate off runs Clean. Only under the lock.
  async #afterClaude(job: Job, output: ReviewOutput): Promise<void> {
    const { verdict, summary, items, accepted_sensitive: accepted } = output;
    const unaccepted = await this.#unaccepted(job, accepted);
    if (verdict === 'fix' || unaccepted.length > 0) {
      await this.#fix(job, fixContent(summary, [...(verdict === 'fix' ? items : []), ...unaccepted]));
    } else if (this.#config.gate.on) {
      await this.#startGate(job, output);
    } else {
      await this.#prepareMr(job, accepted);
    }
  }

  // Applies a verdict (work) to a job awaiting review; a failure to apply it hands the job to the
  // user. Only under the lock.
  async #applying(job: Job, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      // iteration_limit has already handed the job to the user.
      if (error instanceof FactoryError && error.code === 'iteration_limit') {
        return;
      }
      console.error(error);
      const latest = await this.jobs.read(job.workspace, job.ticket);
      if (latest?.state === 'awaiting_review') {
        const code = error instanceof FactoryError ? error.code : 'review_failed';
        await this.#transition(latest, 'needs_human', { code, message: `The review's verdict could not be applied: ${(error as Error).message}`.slice(0, 1000) });
      }
    }
  }

  // Starts the gate after a clean Claude verdict (claude); it runs outside the lock. A job whose gate
  // runs used up SF_GATE_MAX_TOKENS goes to the user instead. Only under the lock.
  async #startGate(job: Job, claude: ReviewOutput): Promise<void> {
    if (job.gate_tokens >= this.#config.gateMaxTokens) {
      await this.#transition(job, 'needs_human', {
        code: 'gate_budget',
        message: `The gate runs of this job used ${job.gate_tokens} tokens, the limit of SF_GATE_MAX_TOKENS (${this.#config.gateMaxTokens}); the user decides how to go on.`,
      });
      return;
    }
    const key = `${job.workspace}/${job.ticket}`;
    this.#reviews.get(key)?.controller.abort();
    const running: RunningReview = { reviewer: GATE_REVIEWER, iteration: job.iteration, controller: new AbortController() };
    this.#reviews.set(key, running);
    this.#gate(job, running, claude).catch((error: unknown) => console.error(error));
  }

  // Runs the gate, then applies its outcome under the lock.
  async #gate(job: Job, running: RunningReview, claude: ReviewOutput): Promise<void> {
    const { workspace: name, ticket, iteration } = job;
    const gate = this.#config.gate;
    let outcome: GateOutcome;
    const redactor = new Redactor({ cwd: job.worktree ?? '' });
    try {
      if (job.worktree === null || job.base_commit === null || !gate.on) {
        throw new Error('the job has no worktree or base commit');
      }
      const prompt = gatePrompt({ ...(await this.#reviewInput(job, job.worktree)), baseCommit: job.base_commit });
      outcome = await runGate(prompt, {
        codexPath: gate.codexPath, cwd: job.worktree, dir: this.jobs.iterationDir(name, ticket, iteration), model: this.#config.codexModel,
        timeoutMs: this.#config.gateTimeoutMs, signal: running.controller.signal,
        // The run live in events.jsonl (SF-045).
        onEvent: (event) => this.#appendLive(job, 'gate_event', redactor.codexEvent(event)),
      });
    } catch (error) {
      const at = now();
      outcome = { ok: false, message: `The gate could not start: ${(error as Error).message}`.slice(0, 1000), tokens: noTokens(), startedAt: at, endedAt: at };
    }
    // The failure message (Codex's stderr or error event) goes to gate.json, the event and the
    // job's error: withheld or redacted like the run's prose (src/redact.ts, failure).
    if (!outcome.ok) {
      outcome = { ...outcome, message: redactor.failure(outcome.message) };
    }
    const ended = outcome;
    await this.#locked(() => this.#gated(job, running, claude, ended));
  }

  // The end of a gate run. A cancelled one leaves no trace. Otherwise its tokens count for the job,
  // gate.json and the event are written, and the verdict applies only while the job still awaits
  // review of the same iteration: clean runs Clean with the paths both reviewers accepted, fix (or an
  // undeclared sensitive path the gate does not accept) is the next Fix section unless the gate's
  // rounds are used up.
  async #gated(gated: Job, running: RunningReview, claude: ReviewOutput, outcome: GateOutcome): Promise<void> {
    const { workspace: name, ticket, iteration } = gated;
    const key = `${name}/${ticket}`;
    if (this.#reviews.get(key) !== running || running.controller.signal.aborted) {
      return;
    }
    this.#reviews.delete(key);
    const read = await this.jobs.read(name, ticket);
    if (read === undefined || read.created_at !== gated.created_at) {
      return;
    }
    let job = read;
    const used = outcome.tokens.input + outcome.tokens.output;
    if (used > 0) {
      job = { ...job, gate_tokens: job.gate_tokens + used };
      await this.jobs.write(job);
    }
    const current = job.state === 'awaiting_review' && job.iteration === iteration;
    const ignored = current ? {} : { ignored: true as const };
    const model = this.#config.codexModel !== undefined ? { model: this.#config.codexModel } : {};
    const times = { started_at: outcome.startedAt, ended_at: outcome.endedAt };
    const record: GateRecord = outcome.ok
      ? { reviewer: GATE_REVIEWER, ...outcome.output, ...model, tokens: outcome.tokens, ...times }
      : { reviewer: GATE_REVIEWER, error: outcome.message, ...model, tokens: outcome.tokens, ...times };
    await this.jobs.writeGate(name, ticket, iteration, record);
    await this.jobs.appendEvent(name, ticket, outcome.ok
      ? { ts: now(), iteration, type: 'review', reviewer: GATE_REVIEWER, verdict: outcome.output.verdict, items: outcome.output.items.length, ...ignored }
      : { ts: now(), iteration, type: 'review_failed', reviewer: GATE_REVIEWER, error: outcome.message, ...ignored });
    if (!current) {
      return;
    }
    if (!outcome.ok) {
      await this.#transition(job, 'needs_human', { code: 'gate_failed', message: outcome.message });
      return;
    }
    if (job.gate_tokens > this.#config.gateMaxTokens) {
      await this.#transition(job, 'needs_human', {
        code: 'gate_budget',
        message: `The gate runs of this job used ${job.gate_tokens} tokens, over the limit of SF_GATE_MAX_TOKENS (${this.#config.gateMaxTokens}); the gate's verdict (${outcome.output.verdict}) was not applied.`,
      });
      return;
    }
    const { verdict, summary, items, accepted_sensitive: accepted } = outcome.output;
    const unaccepted = await this.#unaccepted(job, accepted);
    const fixing = verdict === 'fix' || unaccepted.length > 0;
    if (fixing && job.gate_fixes >= this.#config.gateMaxRounds) {
      const message = `The gate asked for a fix ${job.gate_fixes + 1} times, over the limit of SF_GATE_MAX_ROUNDS (${this.#config.gateMaxRounds}); the fix was not applied. Claude: ${oneLine(claude.summary)} Codex: ${oneLine(summary)}`;
      await this.#transition(job, 'needs_human', { code: 'gate_rounds', message: message.slice(0, 2000) });
      return;
    }
    const decided = job;
    await this.#applying(decided, async () => {
      if (fixing) {
        await this.#fix(decided, fixContent(summary, [...(verdict === 'fix' ? items : []), ...unaccepted], 'Codex'), { gate_fixes: decided.gate_fixes + 1 });
      } else {
        await this.#prepareMr(decided, [...new Set([...claude.accepted_sensitive, ...accepted])]);
      }
    });
  }

  // The branch holds the one commit on top of the target: the worktree goes (the branch stays in
  // the checkout for the IDE) and the user takes over.
  async #ready(job: Job, live: Live, mrText: string): Promise<void> {
    const cwd = live.cwd;
    const tip = (await runGit(cwd, ['rev-parse', '--verify', `refs/heads/${job.branch}`])).stdout.toString('utf8').trim();
    const title = mrText.split(/\r?\n/)[0]!;
    const failure = await this.#gitLocked(job.workspace, () => removeWorktree(live.workspace.workCheckout, cwd));
    if (failure !== undefined) {
      await this.#transition(job, 'needs_human', { code: 'worktree_remove_failed', message: `${failure} The branch ${job.branch} is prepared; remove the worktree by hand and call mark_clean again.` });
      return;
    }
    this.#live.delete(`${job.workspace}/${job.ticket}`);
    const lines = [title, ...fileSummaryLines((await this.#lastFiles(job)) ?? [])];
    await this.#transition({ ...job, base_commit: job.target_commit, prepared_commit: tip, worktree: null }, 'ready_for_human_review', undefined, lines);
    console.log(`${job.workspace}/${job.ticket}: branch ${job.branch} ready (${title})`);
  }

  async #lastFiles(job: Job): Promise<FileChange[] | undefined> {
    if (job.iteration === 0) {
      return undefined;
    }
    try {
      return (await this.jobs.readMeta(job.workspace, job.ticket, job.iteration)).files;
    } catch {
      return undefined;
    }
  }

  // The Context owner's Clean: every undeclared sensitive path of the reviewed iteration must be
  // acknowledged; then the target is resolved and the MR text turn runs in the worktree. When it
  // ends the factory commits and rebases (#mrIdle), and the job ends in ready_for_human_review with
  // the branch in the checkout. Also the retry after a failed preparation (needs_human with
  // mr_attempts > 0).
  markClean(workspaceName: string, ticket: string, sensitive: string[] = []): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.#locked(async () => this.#prepareMr(await this.#job(workspaceName, ticket), sensitive));
  }

  // The work of mark_clean, also run for a clean verdict of the review. Only under the lock.
  async #prepareMr(job: Job, sensitive: string[]): Promise<{ state: JobState; iteration: number; branch: string }> {
    const { workspace: workspaceName, ticket } = job;
    const retry = job.state === 'needs_human' && job.mr_attempts > 0 && job.worktree !== null;
    if (!(job.state === 'awaiting_review' || retry)) {
      throw new FactoryError('invalid_state', `mark_clean needs awaiting_review (or needs_human after an MR preparation); the job is ${job.state}.`);
    }
    const unacknowledged = ((await this.#lastFiles(job)) ?? [])
      .filter((change) => change.sensitive === 'undeclared' && !sensitive.includes(change.path))
      .map((change) => change.path);
    if (unacknowledged.length > 0) {
      throw new FactoryError('sensitive_unacknowledged', `Undeclared sensitive path(s) in the reviewed iteration: ${unacknowledged.join(', ')}. Name each in sensitive with the reason it is needed, or request_fix its removal.`);
    }
    if (job.worktree === null || !(await exists(job.worktree))) {
      throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
    }
    const key = `${workspaceName}/${ticket}`;
    const live = this.#live.get(key);
    if (live?.session.busy === true) {
      throw new FactoryError('turn_running', 'A turn of the Implementer is running; wait for it to end.');
    }
    const workspace = live?.workspace ?? (await this.#resolve(workspaceName));
    const cwd = job.worktree;
    const target = await this.#gitLocked(workspaceName, async () => {
      // A rebase left in progress when sf serve restarted during a conflict turn.
      await abortRebase(cwd);
      return resolveTarget(workspace.workCheckout, job.base);
    });
    const attempt = job.mr_attempts + 1;
    const next = await this.#transition({ ...job, target_commit: target.commit, mr_attempts: attempt }, 'preparing_mr');
    await this.#syncTask(workspace, next);
    const prompt = mrPrompt({
      ticket, branch: job.branch, targetRef: target.ref, targetCommit: target.commit, attempt,
      previousError: retry ? job.error?.message : undefined, handbook: this.#handbook,
    });
    const session = this.#session(next, workspace);
    this.#live.get(key)!.mr = { targetRef: target.ref };
    session.send(prompt, DENIED_TOOLS);
    return { state: next.state, iteration: next.iteration, branch: next.branch };
  }

  // The user's approve: the branch the factory prepared at Clean is pushed. Nothing is committed
  // or rebased here; a tip that moved since is refused unless asIs.
  approve(workspaceName: string, ticket: string, asIs = false): Promise<MrOutcome> {
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      const pushRetry = job.state === 'needs_human' && job.prepared_commit !== null && job.worktree === null;
      if (!(job.state === 'ready_for_human_review' || pushRetry)) {
        throw new FactoryError('invalid_state', `approve needs ready_for_human_review (the branch prepared at Clean); the job is ${job.state}.`);
      }
      const workspace = await this.#resolve(workspaceName);
      const checkout = workspace.workCheckout;
      const tipResult = await runGit(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${job.branch}`]);
      const tip = tipResult.stdout.toString('utf8').trim();
      if (tipResult.code !== 0 || tip === '') {
        throw new FactoryError('branch_missing', `The branch ${job.branch} no longer exists in the checkout.`);
      }
      if (tip !== job.prepared_commit && !asIs) {
        throw new FactoryError('branch_changed', `The tip of ${job.branch} is ${tip.slice(0, 12)}, not the prepared ${(job.prepared_commit ?? '').slice(0, 12)}: it was edited by hand. Approve with --as-is to push it as it is.`);
      }
      const pushFailure = await this.#gitLocked(workspaceName, () => pushBranch(checkout, job.branch, job.base));
      if (pushFailure !== undefined) {
        const next = await this.#transition(job, 'needs_human', pushFailure);
        return { state: next.state, branch: next.branch, error: pushFailure };
      }
      const mrText = (await this.jobs.readMrText(workspaceName, ticket)) ?? '';
      const title = mrText.split(/\r?\n/)[0] ?? '';
      const url = await originUrl(checkout);
      const link = url === undefined ? undefined : mergeRequestLink(url, job.base, job.branch);
      const pushed = await this.#transition({ ...job, prepared_commit: tip }, 'pushed', undefined, [title, ...(link !== undefined ? [link] : [])]);
      this.#live.delete(`${workspaceName}/${ticket}`);
      console.log(`${job.workspace}/${job.ticket}: pushed ${job.branch}\n  ${title}${link !== undefined ? `\n  ${link}` : ''}`);
      return { state: pushed.state, branch: pushed.branch, ...(title !== '' ? { title } : {}), ...(link !== undefined ? { link } : {}) };
    });
  }

  // Ends the job: the session stops; the worktree stays unless discard, which removes it and the
  // branch.
  abort(workspaceName: string, ticket: string, discard: boolean): Promise<{ state: JobState; branch: string; discarded: boolean; worktree: string | null; error?: { code: string; message: string } }> {
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      if (TERMINAL_STATES.includes(job.state)) {
        throw new FactoryError('invalid_state', `The job is already ${job.state}.`);
      }
      const key = `${workspaceName}/${ticket}`;
      const live = this.#live.get(key);
      const workspace = live?.workspace ?? (await this.#resolve(workspaceName));
      const worktree = job.worktree !== null && (await exists(job.worktree)) ? job.worktree : null;
      if (discard && worktree !== null && (await gitBusy(worktree))) {
        throw new FactoryError('rebase_in_progress', 'A rebase or a Git lock is in progress in the worktree; discard would lose it. Finish or abort it first, or abort without --discard.');
      }
      await this.#endSession(key);
      if (worktree !== null) {
        await this.#clean(job, job.iteration, worktree);
      }
      const failure = discard ? await this.#gitLocked(workspaceName, () => this.#discard(workspace.workCheckout, job, worktree)) : undefined;
      const kept = discard && failure === undefined ? null : worktree;
      const next = await this.#transition({ ...job, worktree: kept }, 'aborted', failure);
      return { state: next.state, branch: next.branch, discarded: discard && failure === undefined, worktree: kept, ...(failure !== undefined ? { error: failure } : {}) };
    });
  }

  // Ends the session and cancels a running review, whose outcome is then never applied.
  async #endSession(key: string): Promise<void> {
    this.#cancelReview(key);
    const live = this.#live.get(key);
    this.#live.delete(key);
    await live?.session.close();
  }

  // The worktree and the branch go; the checkout is not touched.
  async #discard(checkout: string, job: Job, worktree: string | null): Promise<{ code: string; message: string } | undefined> {
    if (worktree !== null) {
      const removed = await removeWorktree(checkout, worktree);
      if (removed !== undefined) {
        return { code: 'discard_failed', message: `${removed} The worktree needs a look.` };
      }
    }
    const deleted = await deleteBranch(checkout, job.branch);
    if (deleted !== undefined) {
      return { code: 'discard_failed', message: `${deleted} The checkout needs a look.` };
    }
    return undefined;
  }

  // The escape hatch: in any state, ends the session, removes the worktree and archives the job;
  // the branch is not touched.
  // A job whose workspace is no longer registered (or whose checkout is gone) is still archived:
  // only the Git clean-up of the checkout is skipped, and the result says so.
  reset(workspaceName: string, ticket: string): Promise<Retired> {
    return this.#locked(async () => this.#retire(await this.#job(workspaceName, ticket)));
  }

  // The dashboard's Archive of a job card: reset, for a finished job only. The state is checked
  // and the job retired in one lock acquisition, so a job that replaced it is refused, never
  // retired.
  archiveFinished(workspaceName: string, ticket: string): Promise<Retired> {
    return this.#locked(async () => this.#retire(await this.#finishedJob(workspaceName, ticket, 'invalid_state')));
  }

  // The ticket's current job, refused unless it is terminal, with the code (and the message) of
  // the caller: invalid_state for the job card, job_active for a ticket action. Only under the lock.
  async #finishedJob(workspaceName: string, ticket: string, code: 'invalid_state' | 'job_active'): Promise<Job> {
    const job = await this.#job(workspaceName, ticket);
    if (!TERMINAL_STATES.includes(job.state)) {
      const message = code === 'invalid_state'
        ? `Only a finished job can be archived; the job is ${job.state}. Abort it first.`
        : `The job for ${workspaceName}/${ticket} is ${job.state}; abort it first.`;
      throw new FactoryError(code, message);
    }
    return job;
  }

  // Ends the session, removes the worktree (best effort, logged) and archives the job directory;
  // the branch is not touched. Only under the lock, with the job read under the same acquisition.
  async #retire(job: Job): Promise<Retired> {
    const { workspace: workspaceName, ticket } = job;
    const key = `${workspaceName}/${ticket}`;
    const live = this.#live.get(key);
    let workspace: Workspace | undefined = live?.workspace;
    if (workspace === undefined) {
      try {
        workspace = await this.#resolve(workspaceName);
      } catch (error) {
        if (!(error instanceof FactoryError) || (error.code !== 'workspace_not_found' && error.code !== 'workspace_invalid')) {
          throw error;
        }
      }
    }
    await this.#endSession(key);
    if (workspace !== undefined) {
      const checkout = workspace.workCheckout;
      const worktree = job.worktree ?? this.#worktreePath(workspaceName, ticket);
      const failure = await this.#gitLocked(workspaceName, () => removeWorktree(checkout, worktree));
      if (failure !== undefined) {
        console.error(`${key}: ${failure}`);
      }
    }
    const archived = await this.jobs.archive(workspaceName, ticket);
    return { archived: `jobs/${workspaceName}/${archived}`, branch: job.branch, ...(workspace === undefined ? { checkout: 'unavailable' as const } : {}) };
  }

  async check(workspace: string, ticket: string, offset = 0, maxBytes = DEFAULT_PAGE_BYTES): Promise<CheckResult> {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxBytes) || maxBytes < MIN_PAGE_BYTES || maxBytes > MAX_PAGE_BYTES) {
      throw new FactoryError('invalid_range', `offset must be >= 0 and max_bytes ${MIN_PAGE_BYTES} to ${MAX_PAGE_BYTES}.`);
    }
    const job = await this.#job(workspace, ticket);
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
      const { report, patch } = await this.jobs.readIteration(workspace, ticket, job.iteration);
      result.report = cutUtf8(report, MAX_REPORT_BYTES);
      result.patch = pageBuffer(patch, offset, maxBytes, 'the patch');
      const files = await this.#lastFiles(job);
      if (files !== undefined) {
        result.files = {
          sensitive: files.filter((change) => change.sensitive !== 'no').map((change) => ({ path: change.path, declared: change.sensitive === 'declared' })),
          deleted: files.filter((change) => change.status === 'deleted').map((change) => change.path),
        };
      }
    }
    const mr = await this.jobs.readMrText(workspace, ticket);
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
  // After a clean Claude verdict, gate is the gate's the same way; absent with the gate off.
  async #reviewStatus(job: Job): Promise<CheckResult['review']> {
    if (job.iteration === 0) {
      return undefined;
    }
    const running = this.#reviews.get(`${job.workspace}/${job.ticket}`);
    const record = await this.jobs.readReview(job.workspace, job.ticket, job.iteration);
    if (record !== undefined) {
      if (!('verdict' in record)) {
        return { status: 'failed', summary: record.error };
      }
      const done: CheckResult['review'] = { status: 'done', verdict: record.verdict, summary: record.summary };
      const gate = record.verdict === 'clean' ? await this.#gateStatus(job, running) : undefined;
      return gate !== undefined ? { ...done, gate } : done;
    }
    if (running?.reviewer === REVIEWER && running.iteration === job.iteration) {
      return { status: 'running' };
    }
    if (!this.#config.review) {
      return { status: 'off' };
    }
    return job.state === 'awaiting_review' ? { status: 'running' } : undefined;
  }

  // The gate's status for check, after a clean Claude verdict: like the review's, undefined with the
  // gate off and when none will run.
  async #gateStatus(job: Job, running: RunningReview | undefined): Promise<ReviewStatus | undefined> {
    const record = await this.jobs.readGate(job.workspace, job.ticket, job.iteration);
    if (record !== undefined) {
      return 'verdict' in record ? { status: 'done', verdict: record.verdict, summary: record.summary } : { status: 'failed', summary: record.error };
    }
    if (!this.#config.gate.on) {
      return undefined;
    }
    if (running?.reviewer === GATE_REVIEWER && running.iteration === job.iteration) {
      return { status: 'running' };
    }
    return job.state === 'awaiting_review' ? { status: 'running' } : undefined;
  }

  // After Clean the worktree is gone: a further fix or message recreates it from the branch, and
  // the next Clean commits the whole change again as one commit.
  async #reopen(job: Job, workspace: Workspace): Promise<Job> {
    const worktree = this.#worktreePath(job.workspace, job.ticket);
    await this.#gitLocked(job.workspace, async () => {
      await mkdir(join(worktree, '..'), { recursive: true, mode: 0o700 });
      await addWorktree(workspace.workCheckout, worktree, job.branch, { create: false });
    });
    const next: Job = { ...job, worktree, prepared_commit: null };
    await this.jobs.write(next);
    return next;
  }

  requestFix(workspaceName: string, ticket: string, content: string): Promise<{ iteration: number; check_after_minutes: number }> {
    return this.#locked(async () => this.#fix(await this.#job(workspaceName, ticket), content));
  }

  // The work of request_fix, also run for a fix verdict of the review: appends ## Fix N and starts
  // the next iteration. SF_MAX_ITERATIONS limits the Fix sections; an sf say turn does not count.
  // counts: what else the Fix counts for (the gate's gate_fixes). Only under the lock.
  async #fix(current: Job, content: string, counts: Partial<Pick<Job, 'gate_fixes'>> = {}): Promise<{ iteration: number; check_after_minutes: number }> {
    let job = current;
    const { workspace: workspaceName, ticket } = job;
    if (job.state !== 'awaiting_review' && job.state !== 'ready_for_human_review') {
      throw new FactoryError('invalid_state', `request_fix needs awaiting_review or ready_for_human_review; the job is ${job.state}.`);
    }
    if (job.fixes >= this.#config.maxIterations) {
      const message = `${job.fixes} Fix sections were written, the limit of SF_MAX_ITERATIONS`;
      await this.#transition(job, 'needs_human', { code: 'iteration_limit', message: `${message}; the user decides how to go on.` });
      throw new FactoryError('iteration_limit', `${message}; the job needs the user.`);
    }
    const workspace = await this.#resolve(workspaceName);
    if (job.state === 'ready_for_human_review') {
      job = await this.#reopen(job, workspace);
    }
    const fix = job.iteration;
    await appendFix(workspace, ticket, fix, content);
    await this.#syncTask(workspace, job);
    job = await this.#transition({ ...job, ...counts, fixes: job.fixes + 1 }, 'working');
    this.#session(job, workspace).send(factoryPrompt(`/implement ${TASK_DIR}/${ticket}.md Fix ${fix}`, ticket, job.iteration + 1), DENIED_TOOLS);
    return { iteration: job.iteration + 1, check_after_minutes: this.#config.checkAfterFixMin };
  }

  // A user message into the session, queued as its next turn.
  say(workspaceName: string, ticket: string, message: string): Promise<{ state: JobState; queued: boolean }> {
    return this.#locked(async () => {
      let job = await this.#job(workspaceName, ticket);
      if (!['working', 'awaiting_review', 'needs_human', 'ready_for_human_review'].includes(job.state)) {
        throw new FactoryError('invalid_state', `sf say needs working, awaiting_review, needs_human or ready_for_human_review; the job is ${job.state}.`);
      }
      if (message.trim() === '' || message.includes('\0')) {
        throw new FactoryError('invalid_content', 'The message must be non-empty text.');
      }
      const workspace = this.#live.get(`${workspaceName}/${ticket}`)?.workspace ?? (await this.#resolve(workspaceName));
      if (job.state === 'ready_for_human_review') {
        job = await this.#reopen(job, workspace);
      }
      if (job.worktree === null || !(await exists(job.worktree))) {
        throw new FactoryError('worktree_missing', `The worktree of ${workspaceName}/${ticket} is missing; sf reset the ticket and start again.`);
      }
      const session = this.#session(job, workspace);
      const queued = session.busy;
      await this.#syncTask(workspace, job);
      if (job.state !== 'working') {
        job = await this.#transition(job, 'working');
      }
      session.send(factoryPrompt(message, ticket, job.iteration + 1), DENIED_TOOLS);
      return { state: job.state, queued };
    });
  }

  async status(workspace?: string, ticket?: string): Promise<Job[]> {
    if (workspace !== undefined && ticket !== undefined) {
      return [await this.#job(workspace, ticket)];
    }
    return this.jobs.list();
  }
}
