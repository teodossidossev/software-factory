// The job lifecycle: start, check, request_fix, mark_clean, say, approve (MR preparation), abort,
// reset, status and the restart rule. Owns the Implementer session of each job and publishes an
// iteration (Report and Patch) when the session goes idle. Every state change goes through
// #transition, the seam for notifications.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.js';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import { isActive, type Job, type JobState, JobStore, now, TERMINAL_STATES } from './jobs.js';
import { deleteSnapshotRef, gitBusy, mergeRequestLink, originUrl, pushBranch, resolveTarget, snapshotDiff, takeSnapshot, verifyPrepared } from './mr.js';
import { buildPatch, changedFilesSection, type Patch } from './patch.js';
import { removeSandboxPlaceholders } from './placeholders.js';
import { factoryPrompt, iterationCost, mrPrompt } from './prompts.js';
import { DENIED_TOOLS, MR_DENIED_TOOLS } from './rules.js';
import type { Workspace } from './registry.js';
import { DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES, MIN_PAGE_BYTES, type Page, pageBuffer } from './repo-files.js';
import { type IdleOutcome, ImplementerSession } from './session.js';
import { appendFix, parseFrontMatter, readTask, TASK_DIR, TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';

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
}

// lines: extra notification lines (the MR title and link when pushed).
export type StateListener = (job: Job, from: JobState | null, lines?: string[]) => void;

// How an MR preparation ended, for the terminal of `sf approve`.
export interface MrOutcome {
  state: JobState;
  branch: string;
  error?: { code: string; message: string };
  title?: string;
  link?: string;
  // Paths that differ from the reviewed change, when the change went back to review.
  changed_paths?: string[];
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

interface Live {
  workspace: Workspace;
  session: ImplementerSession;
}

export class Execution {
  readonly jobs: JobStore;
  readonly #config: Config;
  readonly #resolve: (name: string) => Promise<Workspace>;
  readonly #onStateChange: StateListener;
  readonly #handbook: string;
  readonly #live = new Map<string, Live>();
  // The `sf approve` callers waiting for the end of MR preparation, per job.
  readonly #mrWaiters = new Map<string, (outcome: MrOutcome) => void>();
  #lock: Promise<unknown> = Promise.resolve();

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

  // At serve start no turn is live: working jobs need a person, interrupted starts failed.
  recover(): Promise<void> {
    return this.#locked(async () => {
      for (const job of await this.jobs.list()) {
        if (job.state === 'working') {
          await this.#transition(job, 'needs_human', { code: 'serve_restarted', message: 'sf serve restarted while the iteration ran; use sf say to continue.' });
        } else if (job.state === 'preparing_mr') {
          await this.#transition(job, 'needs_human', { code: 'mr_serve_restarted', message: 'sf serve restarted during MR preparation; run sf approve again.' });
        } else if (job.state === 'starting') {
          await this.#transition(job, 'failed', { code: 'serve_restarted', message: 'sf serve restarted while the job was starting.' });
        }
      }
    });
  }

  start(workspaceName: string, ticket: string): Promise<{ branch: string; state: JobState; check_after_minutes: number }> {
    return this.#locked(async () => {
      if (!TICKET_PATTERN.test(ticket)) {
        throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
      }
      const workspace = await this.#resolve(workspaceName);
      const fields = parseFrontMatter(await readTask(workspace, ticket))!;
      const base = fields.get('base')!;
      const branch = branchName(ticket, fields.get('title')!);

      const existing = await this.jobs.read(workspace.name, ticket);
      if (existing !== undefined && !TERMINAL_STATES.includes(existing.state)) {
        throw new FactoryError('job_exists', `The job for ${workspace.name}/${ticket} is ${existing.state}.`);
      }
      const active = (await this.jobs.list()).find(isActive);
      if (active !== undefined) {
        throw new FactoryError('job_active', `Job ${active.workspace}/${active.ticket} is ${active.state}; one job runs at a time.`);
      }
      // Removed before the dirty check; logged once the new job has its events.jsonl.
      const placeholders = await this.#removePlaceholders(workspace.workCheckout);
      await this.#refuseDirty(workspace);
      if (existing !== undefined) {
        await this.jobs.archive(workspace.name, ticket);
      }

      const created = now();
      let job: Job = {
        workspace: workspace.name, ticket, branch, base, base_commit: null, state: 'starting',
        iteration: 0, session_id: null, target_commit: null, mr_attempts: 0, created_at: created, updated_at: created,
      };
      await this.jobs.write(job);
      await this.jobs.appendEvent(workspace.name, ticket, { ts: created, iteration: 0, state: { from: null, to: 'starting' } });
      await this.#logPlaceholders(job, 0, placeholders);
      try {
        job = { ...job, base_commit: await this.#createBranch(workspace.workCheckout, base, branch) };
        await this.jobs.write(job);
      } catch (error) {
        const failure = error instanceof FactoryError ? error : new FactoryError('start_failed', 'Git failed while creating the branch.');
        await this.#transition(job, 'failed', { code: failure.code, message: failure.message });
        throw failure;
      }
      job = await this.#transition(job, 'working');
      this.#session(job, workspace).send(factoryPrompt(`/implement ${TASK_DIR}/${ticket}.md`, ticket, job.iteration + 1), DENIED_TOOLS);
      return { branch, state: job.state, check_after_minutes: this.#config.checkAfterStartMin };
    });
  }

  // Removes the sandbox's placeholder files from the work checkout; a failure is logged and the
  // checks that follow (dirty check, Patch, MR verification) still skip or report them.
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

  async #refuseDirty(workspace: Workspace): Promise<void> {
    const status = await runGit(workspace.workCheckout, ['status', '--porcelain', '--untracked-files=all']);
    if (status.code !== 0) {
      throw new FactoryError('workspace_invalid', 'git status failed in the work checkout.');
    }
    const lines = status.stdout
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '' && !/^.. "?\.software-factory\//.test(line));
    if (lines.length > 0) {
      throw new FactoryError('checkout_dirty', `The work checkout has ${lines.length} uncommitted change(s).`);
    }
  }

  // Fetches the base when origin exists, creates the branch and returns the base commit.
  async #createBranch(cwd: string, base: string, branch: string): Promise<string> {
    const valid = async (name: string): Promise<boolean> => !name.startsWith('-') && (await runGit(cwd, ['check-ref-format', '--branch', name])).code === 0;
    if (!(await valid(base))) {
      throw new FactoryError('base_not_found', `The base "${base}" is not a valid branch name.`);
    }
    if (!(await valid(branch))) {
      throw new FactoryError('invalid_ticket', `"${branch}" is not a valid branch name.`);
    }
    const { ref, commit } = await resolveTarget(cwd, base);
    if ((await runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
      throw new FactoryError('branch_exists', `The branch ${branch} already exists in the work checkout.`);
    }
    const checkout = await runGit(cwd, ['-c', 'submodule.recurse=false', 'checkout', '--no-track', '-b', branch, ref]);
    if (checkout.code !== 0) {
      throw new FactoryError('start_failed', `git checkout -b ${branch} failed.`);
    }
    return commit;
  }

  #session(job: Job, workspace: Workspace): ImplementerSession {
    const key = `${job.workspace}/${job.ticket}`;
    const live = this.#live.get(key);
    if (live !== undefined) {
      return live.session;
    }
    const { workspace: name, ticket } = job;
    let iteration = job.iteration + 1;
    const session = new ImplementerSession(
      {
        cwd: workspace.workCheckout, maxTurns: this.#config.maxTurns, claudePath: this.#config.claudePath,
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
    this.#live.set(key, { workspace, session });
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
      await this.#clean(job, job.iteration + 1, live.workspace.workCheckout);
      if (job.state === 'preparing_mr') {
        await this.#mrIdle(job, live, outcome);
        return;
      }
      if (!outcome.ok) {
        await this.#transition(job, 'needs_human', { code: outcome.code, message: outcome.message });
        return;
      }
      try {
        const published = await this.#publish(job, outcome, await buildPatch(live.workspace.workCheckout, job.base_commit!), []);
        await this.#transition(published, 'awaiting_review');
      } catch (error) {
        console.error(error);
        await this.#transition(job, 'needs_human', { code: 'publish_failed', message: 'The Report and Patch could not be published.' });
      }
    });
  }

  // Writes the next iteration (Report and Patch) and returns the job with its iteration counted.
  async #publish(job: Job, outcome: Success, built: Patch, extraSections: string[]): Promise<Job> {
    const { workspace: workspaceName, ticket } = job;
    const number = job.iteration + 1;
    const total = outcome.result.total_cost_usd ?? null;
    const previousTotal = number > 1 ? ((await this.jobs.readMeta(workspaceName, ticket, number - 1)).cost_usd_total ?? null) : null;
    const sections = [outcome.text.trim() || '(The Implementer wrote no report text.)', ...extraSections, changedFilesSection(built.files, built.truncated)];
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
        patch_truncated: built.truncated,
        submodule_changed: built.submodules,
        cost_usd: iterationCost(total, previousTotal),
        cost_usd_total: total,
        duration_ms: outcome.result.duration_ms ?? null,
      },
    });
    return { ...job, iteration: number };
  }

  // The end of the MR preparation turn: verify, compare with the reviewed change, push.
  async #mrIdle(job: Job, live: Live, outcome: IdleOutcome): Promise<void> {
    const key = `${job.workspace}/${job.ticket}`;
    const cwd = live.workspace.workCheckout;
    const settle = (next: Job, extra: Partial<MrOutcome> = {}): void => {
      this.#settleMr(key, { state: next.state, branch: next.branch, ...(next.error !== undefined ? { error: next.error } : {}), ...extra });
    };
    const needsHuman = async (code: string, message: string): Promise<void> => {
      settle(await this.#transition(job, 'needs_human', { code, message }));
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
        const published = await this.#publish(rebased, outcome, await buildPatch(cwd, snapshot.target_commit), [note]);
        await this.jobs.writeMrText(job.workspace, job.ticket, verified.mrText);
        settle(await this.#transition(published, 'awaiting_review'), { changed_paths: differing });
        return;
      }
      const pushFailure = await pushBranch(cwd, job.branch, job.base);
      if (pushFailure !== undefined) {
        await needsHuman(pushFailure.code, pushFailure.message);
        return;
      }
      await this.jobs.writeMrText(job.workspace, job.ticket, verified.mrText);
      const title = verified.mrText.split(/\r?\n/)[0]!;
      const url = await originUrl(cwd);
      const link = url === undefined ? undefined : mergeRequestLink(url, job.base, job.branch);
      await this.#dropSnapshotRef(job.ticket, cwd);
      const pushed = await this.#transition({ ...job, target_commit: snapshot.target_commit }, 'pushed', undefined, [title, ...(link !== undefined ? [link] : [])]);
      this.#live.delete(key);
      console.log(`${job.workspace}/${job.ticket}: pushed ${job.branch}\n  ${title}${link !== undefined ? `\n  ${link}` : ''}`);
      settle(pushed, { title, ...(link !== undefined ? { link } : {}) });
    } catch (error) {
      console.error(error);
      await needsHuman('mr_failed', `MR preparation failed inside the factory: ${(error as Error).message}`.slice(0, 1000));
    }
  }

  #settleMr(key: string, outcome: MrOutcome): void {
    const waiter = this.#mrWaiters.get(key);
    this.#mrWaiters.delete(key);
    waiter?.(outcome);
  }

  // The user's approve: snapshot the reviewed change and run the MR preparation turn. Resolves
  // when the preparation has ended (pushed, needs_human, back to awaiting_review, or aborted).
  async approve(workspaceName: string, ticket: string): Promise<MrOutcome> {
    const { done } = await this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      // A retry: needs_human after any MR preparation turn (a failed check or a failed turn).
      const retry = job.state === 'needs_human' && job.mr_attempts > 0;
      if (!(job.state === 'ready_for_human_review' || job.state === 'awaiting_review' || retry)) {
        throw new FactoryError('invalid_state', `approve needs ready_for_human_review, awaiting_review or needs_human after an MR preparation; the job is ${job.state}.`);
      }
      const key = `${workspaceName}/${ticket}`;
      const live = this.#live.get(key);
      if (live?.session.busy === true) {
        throw new FactoryError('turn_running', 'A turn of the Implementer is running; wait for it to end.');
      }
      const workspace = live?.workspace ?? (await this.#resolve(workspaceName));
      const cwd = workspace.workCheckout;
      const target = await resolveTarget(cwd, job.base);
      // A retry keeps the snapshot of the reviewed change: the branch may already be rebased. A
      // snapshot written before SF-014 (blob hashes, no commit) is replaced by a new one.
      const previous = retry ? await this.jobs.readSnapshot(workspaceName, ticket) : undefined;
      const snapshot = previous?.snapshot_commit !== undefined
        ? { ...previous, target_ref: target.ref, target_commit: target.commit }
        : await takeSnapshot(cwd, ticket, job.base_commit!, target, this.jobs.dir(workspaceName, ticket));
      await this.jobs.writeSnapshot(workspaceName, ticket, snapshot);
      const attempt = job.mr_attempts + 1;
      const next = await this.#transition({ ...job, mr_attempts: attempt }, 'preparing_mr');
      const finished = new Promise<MrOutcome>((resolve) => this.#mrWaiters.set(key, resolve));
      const prompt = mrPrompt({
        ticket, branch: job.branch, targetRef: target.ref, targetCommit: target.commit, attempt,
        previousError: retry ? job.error?.message : undefined, handbook: this.#handbook,
      });
      this.#session(next, workspace).send(prompt, MR_DENIED_TOOLS);
      // Wrapped: a promise returned from the locked work would hold the lock until it settles.
      return { done: finished };
    });
    return done;
  }

  // Ends the job: the session stops; with discard the branch and its changes are removed.
  abort(workspaceName: string, ticket: string, discard: boolean): Promise<{ state: JobState; branch: string; discarded: boolean; error?: { code: string; message: string } }> {
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      if (TERMINAL_STATES.includes(job.state)) {
        throw new FactoryError('invalid_state', `The job is already ${job.state}.`);
      }
      const key = `${workspaceName}/${ticket}`;
      const live = this.#live.get(key);
      const cwd = discard ? (live?.workspace ?? (await this.#resolve(workspaceName))).workCheckout : undefined;
      if (cwd !== undefined && (await gitBusy(cwd))) {
        throw new FactoryError('rebase_in_progress', 'A rebase or a Git lock is in progress in the work checkout; reset --hard would lose it. Finish or abort it first, or abort without --discard.');
      }
      await this.#endSession(key);
      if (cwd !== undefined) {
        await this.#clean(job, job.iteration, cwd);
      }
      const failure = cwd !== undefined ? await this.#discard(cwd, job) : undefined;
      await this.#dropSnapshotRef(ticket, cwd ?? live?.workspace.workCheckout, workspaceName);
      const next = await this.#transition(job, 'aborted', failure);
      this.#settleMr(key, { state: next.state, branch: next.branch });
      return { state: next.state, branch: next.branch, discarded: cwd !== undefined && failure === undefined, ...(failure !== undefined ? { error: failure } : {}) };
    });
  }

  // Best effort: the snapshot ref of the job goes with it (pushed, abort, reset). cwd is the work
  // checkout when known, else it is resolved from workspaceName; a failure is logged and ignored.
  async #dropSnapshotRef(ticket: string, cwd: string | undefined, workspaceName?: string): Promise<void> {
    try {
      const dir = cwd ?? (workspaceName !== undefined ? (await this.#resolve(workspaceName)).workCheckout : undefined);
      if (dir !== undefined && !(await deleteSnapshotRef(dir, ticket))) {
        console.error(`${ticket}: could not delete the snapshot ref in ${dir}`);
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

  // reset --hard to the base commit, clean (ignored files stay), back to the base, branch deleted.
  async #discard(cwd: string, job: Job): Promise<{ code: string; message: string } | undefined> {
    if (job.base_commit === null) {
      return { code: 'discard_failed', message: 'The job has no base commit; nothing was discarded.' };
    }
    const steps = [
      ['reset', '--hard', job.base_commit],
      ['clean', '-fd'],
      ['-c', 'submodule.recurse=false', 'checkout', job.base],
      ['branch', '-D', job.branch],
    ];
    for (const args of steps) {
      const result = await runGit(cwd, args);
      if (result.code !== 0) {
        return { code: 'discard_failed', message: `git ${args.filter((arg) => !arg.includes('=')).join(' ')} failed: ${result.stderr.trim().slice(0, 500)} The work checkout needs a look.` };
      }
    }
    return undefined;
  }

  // The escape hatch: in any state, ends the session and archives the job; the branch and the
  // files are not touched, only the job's snapshot ref is removed.
  reset(workspaceName: string, ticket: string): Promise<{ archived: string; branch: string }> {
    return this.#locked(async () => {
      const job = await this.#job(workspaceName, ticket);
      const key = `${workspaceName}/${ticket}`;
      const live = this.#live.get(key);
      await this.#endSession(key);
      await this.#dropSnapshotRef(ticket, live?.workspace.workCheckout, workspaceName);
      const archived = await this.jobs.archive(workspaceName, ticket);
      this.#settleMr(key, { state: job.state, branch: job.branch, error: { code: 'reset', message: 'The job was reset.' } });
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
    }
    const mr = await this.jobs.readMrText(workspace, ticket);
    if (mr !== undefined) {
      result.mr = cutUtf8(mr, MAX_REPORT_BYTES);
    }
    return result;
  }

  requestFix(workspaceName: string, ticket: string, content: string): Promise<{ iteration: number; check_after_minutes: number }> {
    return this.#locked(async () => {
      let job = await this.#job(workspaceName, ticket);
      if (job.state !== 'awaiting_review') {
        throw new FactoryError('invalid_state', `request_fix needs awaiting_review; the job is ${job.state}.`);
      }
      if (job.iteration >= this.#config.maxIterations) {
        await this.#transition(job, 'needs_human', {
          code: 'iteration_limit',
          message: `${job.iteration} iterations were published without Clean; the user decides how to go on.`,
        });
        throw new FactoryError('iteration_limit', `${job.iteration} iterations were published without Clean; the job needs the user.`);
      }
      const workspace = await this.#resolve(workspaceName);
      const fix = job.iteration;
      await appendFix(workspace, ticket, fix, content);
      job = await this.#transition(job, 'working');
      this.#session(job, workspace).send(factoryPrompt(`/implement ${TASK_DIR}/${ticket}.md Fix ${fix}`, ticket, job.iteration + 1), DENIED_TOOLS);
      return { iteration: job.iteration + 1, check_after_minutes: this.#config.checkAfterFixMin };
    });
  }

  markClean(workspace: string, ticket: string): Promise<{ state: JobState; iteration: number; branch: string }> {
    return this.#locked(async () => {
      const job = await this.#job(workspace, ticket);
      if (job.state !== 'awaiting_review') {
        throw new FactoryError('invalid_state', `mark_clean needs awaiting_review; the job is ${job.state}.`);
      }
      const next = await this.#transition(job, 'ready_for_human_review');
      return { state: next.state, iteration: next.iteration, branch: next.branch };
    });
  }

  // A user message into the session, queued as its next turn.
  say(workspaceName: string, ticket: string, message: string): Promise<{ state: JobState; queued: boolean }> {
    return this.#locked(async () => {
      let job = await this.#job(workspaceName, ticket);
      if (!['working', 'awaiting_review', 'needs_human'].includes(job.state)) {
        throw new FactoryError('invalid_state', `sf say needs working, awaiting_review or needs_human; the job is ${job.state}.`);
      }
      if (message.trim() === '' || message.includes('\0')) {
        throw new FactoryError('invalid_content', 'The message must be non-empty text.');
      }
      const workspace = this.#live.get(`${workspaceName}/${ticket}`)?.workspace ?? (await this.#resolve(workspaceName));
      const session = this.#session(job, workspace);
      const queued = session.busy;
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
