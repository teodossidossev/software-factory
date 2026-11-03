// The job lifecycle: start, check, request_fix, mark_clean (the MR preparation and the branch,
// SF-019), say, approve (the push), abort, reset, status and the restart rule. Owns the
// Implementer session of each job, which works in the job's own worktree, and publishes an
// iteration (Report, Patch and the file list) when the session goes idle. Every state change
// goes through #transition, the seam for notifications. Several jobs of one workspace run at the
// same time, up to SF_MAX_JOBS; the Git operations on the shared checkout are serialized per
// workspace.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import { type FileChange, isActive, type Job, type JobState, JobStore, now, TERMINAL_STATES } from './jobs.js';
import { deleteSnapshotRef, gitBusy, mergeRequestLink, originUrl, pushBranch, resolveTarget, snapshotDiff, takeSnapshot, verifyPrepared } from './mr.js';
import { buildPatch, changedFilesSection, fileChanges, fileSummaryLines, type Patch } from './patch.js';
import { removeSandboxPlaceholders } from './placeholders.js';
import { factoryPrompt, iterationCost, mrPrompt } from './prompts.js';
import { DENIED_TOOLS, MR_DENIED_TOOLS, sensitivityOf } from './rules.js';
import type { Workspace } from './registry.js';
import { DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES, MIN_PAGE_BYTES, type Page, pageBuffer } from './repo-files.js';
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

interface Live {
  workspace: Workspace;
  session: ImplementerSession;
  // The session's cwd: the job's worktree.
  cwd: string;
}

export class Execution {
  readonly jobs: JobStore;
  readonly #config: Config;
  readonly #resolve: (name: string) => Promise<Workspace>;
  readonly #onStateChange: StateListener;
  readonly #handbook: string;
  readonly #live = new Map<string, Live>();
  #lock: Promise<unknown> = Promise.resolve();
  // One Git lock per workspace for the operations on the shared checkout.
  readonly #gitLocks = new Map<string, Promise<unknown>>();

  // handbook: the loaded Handbook text; MR preparation sends its Git rules and MR template.
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
  // with a start (the workspace registry of the dashboard's start screen).
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.#locked(work);
  }

  // The checkout's Git operations of one workspace (fetch, worktree add and remove, branch
  // delete, snapshot ref, push) never interleave; the rest runs concurrently.
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

  // At serve start no turn is live: working jobs need a person, interrupted starts failed.
  recover(): Promise<void> {
    return this.#locked(async () => {
      for (const job of await this.jobs.list()) {
        if (job.state === 'working') {
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
        iteration: 0, session_id: null, target_commit: null, mr_attempts: 0, created_at: created, updated_at: created,
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

  // Removes the sandbox's placeholder files from the worktree; a failure is logged and the
  // checks that follow (Patch, MR verification) still skip or report them.
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
      // Before the Patch and before the MR verification, whatever the outcome of the turn.
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
        await this.#transition(published, 'awaiting_review', undefined, fileSummaryLines(changes));
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

  // The end of the MR preparation turn (mark_clean): verify, compare with the reviewed change,
  // then record the branch tip, remove the worktree and hand the job to the user.
  async #mrIdle(job: Job, live: Live, outcome: IdleOutcome): Promise<void> {
    const key = `${job.workspace}/${job.ticket}`;
    const cwd = live.cwd;
    const needsHuman = async (code: string, message: string): Promise<void> => {
      await this.#transition(job, 'needs_human', { code, message });
    };
    try {
      if (!outcome.ok) {
        await needsHuman(outcome.code, outcome.message);
        return;
      }
      const snapshot = (await this.jobs.readSnapshot(job.workspace, job.ticket))!;
      const verified = await verifyPrepared(cwd, job, snapshot.target_commit);
      if (!verified.ok) {
        await needsHuman(verified.code, verified.message);
        return;
      }
      const differing = await snapshotDiff(cwd, snapshot, job.branch);
      if (differing.length > 0) {
        // The change is no longer the reviewed one: it goes back to the Context owner, now
        // against the target.
        const rebased: Job = { ...job, base_commit: snapshot.target_commit, target_commit: snapshot.target_commit };
        const note = [
          '## MR preparation',
          '',
          `The prepared commit differs from the reviewed change in: ${differing.join(', ')}. The Patch is now against the target ${snapshot.target_ref} (${snapshot.target_commit}).`,
        ].join('\n');
        const { job: published, changes } = await this.#publish(rebased, live, outcome, await buildPatch(cwd, snapshot.target_commit), [note]);
        await this.jobs.writeMrText(job.workspace, job.ticket, verified.mrText);
        await this.#transition(published, 'awaiting_review', undefined, fileSummaryLines(changes));
        return;
      }
      const tip = (await runGit(cwd, ['rev-parse', '--verify', `refs/heads/${job.branch}`])).stdout.toString('utf8').trim();
      await this.jobs.writeMrText(job.workspace, job.ticket, verified.mrText);
      const title = verified.mrText.split(/\r?\n/)[0]!;
      // The worktree goes: the branch, with its one commit, is in the checkout for the IDE.
      const failure = await this.#gitLocked(job.workspace, () => removeWorktree(live.workspace.workCheckout, cwd));
      if (failure !== undefined) {
        await needsHuman('worktree_remove_failed', `${failure} The branch ${job.branch} is prepared; remove the worktree by hand and call mark_clean again.`);
        return;
      }
      this.#live.delete(key);
      const lines = [title, ...fileSummaryLines((await this.#lastFiles(job)) ?? [])];
      await this.#transition({ ...job, base_commit: snapshot.target_commit, target_commit: snapshot.target_commit, prepared_commit: tip, worktree: null }, 'ready_for_human_review', undefined, lines);
      console.log(`${job.workspace}/${job.ticket}: branch ${job.branch} ready (${title})`);
    } catch (error) {
      console.error(error);
      await needsHuman('mr_failed', `MR preparation failed inside the factory: ${(error as Error).message}`.slice(0, 1000));
    }
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
  // acknowledged; then the MR preparation turn runs in the worktree (snapshot, commit, rebase,
  // verification), and the job ends in ready_for_human_review with the branch in the checkout.
  // Also the retry after a failed preparation (needs_human with mr_attempts > 0).
  markClean(workspaceName: string, ticket: string, sensitive: string[] = []): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
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
      const target = await this.#gitLocked(workspaceName, () => resolveTarget(workspace.workCheckout, job.base));
      // A retry keeps the snapshot of the reviewed change: the branch may already be rebased.
      const previous = retry ? await this.jobs.readSnapshot(workspaceName, ticket) : undefined;
      const snapshot = previous?.snapshot_commit !== undefined
        ? { ...previous, target_ref: target.ref, target_commit: target.commit }
        : await takeSnapshot(cwd, ticket, job.base_commit!, target, this.jobs.dir(workspaceName, ticket));
      await this.jobs.writeSnapshot(workspaceName, ticket, snapshot);
      const attempt = job.mr_attempts + 1;
      const next = await this.#transition({ ...job, mr_attempts: attempt }, 'preparing_mr');
      await this.#syncTask(workspace, next);
      const prompt = mrPrompt({
        ticket, branch: job.branch, targetRef: target.ref, targetCommit: target.commit, attempt,
        previousError: retry ? job.error?.message : undefined, handbook: this.#handbook,
      });
      this.#session(next, workspace).send(prompt, MR_DENIED_TOOLS);
      return { state: next.state, iteration: next.iteration, branch: next.branch };
    });
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
      await this.#dropSnapshotRef(ticket, checkout);
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
      await this.#dropSnapshotRef(ticket, workspace.workCheckout);
      const kept = discard && failure === undefined ? null : worktree;
      const next = await this.#transition({ ...job, worktree: kept }, 'aborted', failure);
      return { state: next.state, branch: next.branch, discarded: discard && failure === undefined, worktree: kept, ...(failure !== undefined ? { error: failure } : {}) };
    });
  }

  // Best effort: the snapshot ref of the job goes with it (pushed, abort, reset); a failure is
  // logged and ignored.
  async #dropSnapshotRef(ticket: string, checkout: string): Promise<void> {
    try {
      if (!(await deleteSnapshotRef(checkout, ticket))) {
        console.error(`${ticket}: could not delete the snapshot ref in ${checkout}`);
      }
    } catch (error) {
      console.error(error);
    }
  }

  async #endSession(key: string): Promise<void> {
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
  // the branch is not touched, only the job's snapshot ref is removed.
  reset(workspaceName: string, ticket: string): Promise<{ archived: string; branch: string }> {
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      const key = `${workspaceName}/${ticket}`;
      const live = this.#live.get(key);
      const workspace = live?.workspace ?? (await this.#resolve(workspaceName));
      await this.#endSession(key);
      const worktree = job.worktree ?? this.#worktreePath(workspaceName, ticket);
      const failure = await this.#gitLocked(workspaceName, () => removeWorktree(workspace.workCheckout, worktree));
      if (failure !== undefined) {
        console.error(`${key}: ${failure}`);
      }
      await this.#dropSnapshotRef(ticket, workspace.workCheckout);
      const archived = await this.jobs.archive(workspaceName, ticket);
      return { archived: `jobs/${workspaceName}/${archived}`, branch: job.branch };
    });
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
    return result;
  }

  // After Clean the worktree is gone: a further fix or message recreates it from the branch, and
  // the next Clean amends the prepared commit.
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
    return this.#locked(async () => {
      let job = await this.#job(workspaceName, ticket);
      if (job.state !== 'awaiting_review' && job.state !== 'ready_for_human_review') {
        throw new FactoryError('invalid_state', `request_fix needs awaiting_review or ready_for_human_review; the job is ${job.state}.`);
      }
      if (job.iteration >= this.#config.maxIterations) {
        await this.#transition(job, 'needs_human', {
          code: 'iteration_limit',
          message: `${job.iteration} iterations were published without Clean; the user decides how to go on.`,
        });
        throw new FactoryError('iteration_limit', `${job.iteration} iterations were published without Clean; the job needs the user.`);
      }
      const workspace = await this.#resolve(workspaceName);
      if (job.state === 'ready_for_human_review') {
        job = await this.#reopen(job, workspace);
      }
      const fix = job.iteration;
      await appendFix(workspace, ticket, fix, content);
      await this.#syncTask(workspace, job);
      job = await this.#transition(job, 'working');
      this.#session(job, workspace).send(factoryPrompt(`/implement ${TASK_DIR}/${ticket}.md Fix ${fix}`, ticket, job.iteration + 1), DENIED_TOOLS);
      return { iteration: job.iteration + 1, check_after_minutes: this.#config.checkAfterFixMin };
    });
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
