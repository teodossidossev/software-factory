// The job lifecycle: start, check, request_fix, mark_clean, say, status and the restart rule.
// Owns the Implementer session of each job and publishes an iteration (Report and Patch) when the
// session goes idle. Every state change goes through #transition, the seam for notifications.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.js';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import { isActive, type Job, type JobState, JobStore, now, TERMINAL_STATES } from './jobs.js';
import { buildPatch, changedFilesSection } from './patch.js';
import { factoryPrompt, iterationCost } from './prompts.js';
import type { Workspace } from './registry.js';
import { DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES, MIN_PAGE_BYTES, type Page, pageBuffer } from './repo-files.js';
import { type IdleOutcome, ImplementerSession } from './session.js';
import { appendFix, parseFrontMatter, readTask, TASK_DIR, TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';

export const MAX_REPORT_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
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
}

export type StateListener = (job: Job, from: JobState | null) => void;

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
  readonly #live = new Map<string, Live>();
  #lock: Promise<unknown> = Promise.resolve();

  constructor(config: Config, resolve: (name: string) => Promise<Workspace>, onStateChange: StateListener = () => {}) {
    this.#config = config;
    this.jobs = new JobStore(config.stateDir);
    this.#resolve = resolve;
    this.#onStateChange = onStateChange;
  }

  // One state-changing operation at a time.
  #locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#lock.catch(() => undefined).then(work);
    this.#lock = next;
    return next;
  }

  async #transition(job: Job, to: JobState, error?: { code: string; message: string }): Promise<Job> {
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
      this.#onStateChange(next, from);
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

      const active = (await this.jobs.list()).find(isActive);
      if (active !== undefined) {
        throw new FactoryError('job_active', `Job ${active.workspace}/${active.ticket} is ${active.state}; one job runs at a time.`);
      }
      const existing = await this.jobs.read(workspace.name, ticket);
      if (existing !== undefined && !TERMINAL_STATES.includes(existing.state)) {
        throw new FactoryError('job_exists', `The job for ${workspace.name}/${ticket} is ${existing.state}.`);
      }
      await this.#refuseDirty(workspace);
      if (existing !== undefined) {
        await this.jobs.archive(workspace.name, ticket);
      }

      const created = now();
      let job: Job = {
        workspace: workspace.name, ticket, branch, base, base_commit: null, state: 'starting',
        iteration: 0, session_id: null, created_at: created, updated_at: created,
      };
      await this.jobs.write(job);
      await this.jobs.appendEvent(workspace.name, ticket, { ts: created, iteration: 0, state: { from: null, to: 'starting' } });
      try {
        job = { ...job, base_commit: await this.#createBranch(workspace.workCheckout, base, branch) };
        await this.jobs.write(job);
      } catch (error) {
        const failure = error instanceof FactoryError ? error : new FactoryError('start_failed', 'Git failed while creating the branch.');
        await this.#transition(job, 'failed', { code: failure.code, message: failure.message });
        throw failure;
      }
      job = await this.#transition(job, 'working');
      this.#session(job, workspace).send(factoryPrompt(`/implement ${TASK_DIR}/${ticket}.md`, ticket, job.iteration + 1));
      return { branch, state: job.state, check_after_minutes: this.#config.checkAfterStartMin };
    });
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
    const remotes = (await runGit(cwd, ['remote'])).stdout.toString('utf8').split('\n');
    let ref = `refs/heads/${base}`;
    if (remotes.includes('origin')) {
      const fetch = await runGit(cwd, ['fetch', '--no-recurse-submodules', 'origin', base], 1024 * 1024, FETCH_TIMEOUT_MS);
      if (fetch.code !== 0) {
        if (/couldn't find remote ref/i.test(fetch.stderr)) {
          throw new FactoryError('base_not_found', `The base "${base}" does not exist on origin.`);
        }
        throw new FactoryError('fetch_failed', fetch.code === null ? 'git fetch origin did not finish within 60 s.' : 'git fetch origin failed.');
      }
      ref = `refs/remotes/origin/${base}`;
    }
    const resolved = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const commit = resolved.stdout.toString('utf8').trim();
    if (resolved.code !== 0 || commit === '') {
      throw new FactoryError('base_not_found', `The base "${base}" was not found${ref.startsWith('refs/remotes') ? ' on origin' : ''}.`);
    }
    if ((await runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
      throw new FactoryError('branch_exists', `The branch ${branch} already exists in the work checkout.`);
    }
    const checkout = await runGit(cwd, ['-c', 'submodule.recurse=false', 'checkout', '--no-track', '-b', branch, ref.replace(/^refs\/(heads|remotes)\//, '')]);
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
      { cwd: workspace.workCheckout, maxTurns: this.#config.maxTurns, claudePath: this.#config.claudePath, sessionId: job.session_id ?? undefined },
      {
        prompt: async (prompt) => {
          iteration = ((await this.jobs.read(name, ticket))?.iteration ?? 0) + 1;
          await this.jobs.appendEvent(name, ticket, { ts: now(), iteration, prompt });
        },
        message: async (message: SDKMessage) => {
          await this.jobs.appendEvent(name, ticket, { ts: now(), iteration, message });
          if (message.type === 'system' && message.subtype === 'init' && message.permissionMode === 'auto') {
            await this.#recordSession(name, ticket, message.session_id);
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

  // The session's queue is empty: publish the iteration, or hand the job to a person.
  #idle(workspaceName: string, ticket: string, outcome: IdleOutcome): Promise<void> {
    return this.#locked(async () => {
      const live = this.#live.get(`${workspaceName}/${ticket}`);
      const job = await this.jobs.read(workspaceName, ticket);
      // A prompt sent after the queue drained started another turn; its idle publishes.
      if (live === undefined || job === undefined || live.session.busy || job.state !== 'working') {
        return;
      }
      if (!outcome.ok) {
        await this.#transition(job, 'needs_human', { code: outcome.code, message: outcome.message });
        return;
      }
      try {
        const built = await buildPatch(live.workspace.workCheckout, job.base_commit!);
        const number = job.iteration + 1;
        const total = outcome.result.total_cost_usd ?? null;
        const previousTotal = number > 1 ? ((await this.jobs.readMeta(workspaceName, ticket, number - 1)).cost_usd_total ?? null) : null;
        const sections = [outcome.text.trim() || '(The Implementer wrote no report text.)', changedFilesSection(built.files, built.truncated)];
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
        await this.#transition({ ...job, iteration: number }, 'awaiting_review');
      } catch (error) {
        console.error(error);
        await this.#transition(job, 'needs_human', { code: 'publish_failed', message: 'The Report and Patch could not be published.' });
      }
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
      check_after_minutes: job.state === 'working' ? this.#checkAfter(job) : null,
      ...(job.error !== undefined ? { error: job.error } : {}),
    };
    // The last published Report and Patch, in every state but the ones where an iteration runs.
    if (job.iteration > 0 && job.state !== 'working' && job.state !== 'starting') {
      const { report, patch } = await this.jobs.readIteration(workspace, ticket, job.iteration);
      result.report = cutUtf8(report, MAX_REPORT_BYTES);
      result.patch = pageBuffer(patch, offset, maxBytes, 'the patch');
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
      this.#session(job, workspace).send(factoryPrompt(`/implement ${TASK_DIR}/${ticket}.md Fix ${fix}`, ticket, job.iteration + 1));
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
      session.send(factoryPrompt(message, ticket, job.iteration + 1));
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
