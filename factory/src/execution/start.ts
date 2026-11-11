// The start of a job and its recovery: start (the record, the fetch, the worktree and the first
// turn), the Task file's copy in the worktree and its images, restart and the rule for a restart of
// sf serve (recover).
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type ImageRef, jobAttachment, type ResolvedImage, resolveTaskImages, writeImages } from '../attachments.js';
import { FactoryError } from '../errors.js';
import { runGit } from '../git.js';
import { claudeReviewDecision } from '../config.js';
import { startBranch, taskContinues } from '../continues.js';
import { checkTransition, claudeReviews, type Handover, type Job, type JobState, now, RESTARTABLE_STATES, runningJobs, TERMINAL_STATES } from '../jobs.js';
import { resolveTarget } from '../mr.js';
import { changedPaths } from '../patch.js';
import { removeSandboxPlaceholders } from '../placeholders.js';
import { factoryPrompt } from '../prompts.js';
import { configDir, type Workspace } from '../registry.js';
import { collectRules, writeJobRules } from '../rules-docs.js';
import { actedVerdict } from '../review.js';
import { Runners } from '../runner.js';
import { withoutDropped } from '../stops.js';
import { isDraft, parseFrontMatter, readTask, TASK_DIR, type TaskReview, taskReview, taskSha256, TICKET_DESCRIPTION, TICKET_PATTERN } from '../task-file.js';
import { addWorktree, deleteBranch, removeWorktree } from '../worktree.js';
import type { JobStorePort, LockPort, RunnerPort, SettingsPort } from './ports.js';
import { checkNotInCheckout } from './errors.js';
import { firstPrompt } from './prompts.js';
import { branchName, exists } from './shared.js';

// A job record claimed by start or restart, before its worktree exists.
interface Claimed {
  workspace: Workspace;
  ticket: string;
  base: string;
  continues: string | null;
  branch: string;
  worktree: string;
  // The images the Task file refers to, read when the start was accepted.
  images: ResolvedImage[];
}

// The files sf restart --keep-files keeps: their paths relative to the worktree, saved
// under dir until the new worktree exists.
interface Kept {
  dir: string;
  paths: string[];
}

// How long sf restart waits for origin to say whether the old branch was pushed.
const LS_REMOTE_TIMEOUT_MS = 30_000;

// The run queue's fetch of a base (fetchBase), as the fetch of a start.
const FETCH_TIMEOUT_MS = 60_000;

// Copies one regular file (with its mode) or symbolic link from to to, creating its directory;
// anything else, or a path that is gone (a deleted file), is skipped. Returns whether it copied.
async function copyEntry(from: string, to: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(from);
  } catch { // a path that is gone (a deleted file): skipped
    return false;
  }
  if (!info.isFile() && !info.isSymbolicLink()) {
    return false;
  }
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  if (info.isSymbolicLink()) {
    await rm(to, { force: true });
    await symlink(await readlink(from), to);
  } else {
    await copyFile(from, to);
    await chmod(to, info.mode & 0o777);
  }
  return true;
}

// Saves the worktree's changed and new files against baseCommit (the Patch's paths: ignored and
// credential-like files left out) under dir; returns their paths.
async function saveKept(worktree: string, baseCommit: string, dir: string): Promise<string[]> {
  const { tracked, untracked } = await changedPaths(worktree, baseCommit);
  const paths: string[] = [];
  for (const path of [...tracked, ...untracked]) {
    if (await copyEntry(join(worktree, path), join(dir, path))) {
      paths.push(path);
    }
  }
  return paths;
}

// Copies the kept files into the new worktree; one that cannot be copied is logged and skipped.
async function copyKept(kept: Kept, worktree: string): Promise<void> {
  for (const path of kept.paths) {
    try {
      await copyEntry(join(kept.dir, path), join(worktree, path));
    } catch (error) {
      console.error(error);
    }
  }
}

// What StartPart calls of the other parts, by just those methods.
export interface StartControl {
  endSession(workspace: string, ticket: string): Promise<void>;
}

export interface StartHandover {
  worktreePath(workspace: string, ticket: string): string;
  repairHandover(job: Job, handover: Handover): Promise<void>;
  cleanSavedRefs(): Promise<void>;
}

export interface StartReviews {
  imageRefs(job: Job, task: string): ImageRef[];
}

export interface StartTurns {
  imagesLine(job: Job): { dir: string; names: string[] } | undefined;
}

export interface StartPeers {
  readonly control: StartControl;
  readonly handover: StartHandover;
  readonly reviews: StartReviews;
  readonly turns: StartTurns;
}

export class StartPart {
  readonly #store: JobStorePort;
  readonly #locks: LockPort;
  readonly #runner: RunnerPort;
  readonly #settings: SettingsPort;
  // The parts it calls (src/execution.ts wires them).
  readonly #peers: StartPeers;

  constructor(store: JobStorePort, locks: LockPort, runner: RunnerPort, settings: SettingsPort, peers: StartPeers) {
    this.#store = store;
    this.#locks = locks;
    this.#runner = runner;
    this.#settings = settings;
    this.#peers = peers;
  }

  // At serve start: a job in working, preparing_mr or awaiting_review whose runner is alive is left
  // alone, and so is a paused one and one parked on a usage limit (the run queue arms its timer from
  // limit.resets_at). Without a runner, a working job and an MR preparation need a person, an
  // interrupted start failed, and a job awaiting review whose last iteration has no review, or a
  // clean review but no gate.json, or a clean gate.json and a simplification pass that never applied,
  // gets a runner, which resumes it (resume: the review, the gate, the pass, or, with the gate off,
  // Clean). With startRunners false (under an updating marker that stays) the states are repaired
  // but no runner starts: ensureResumable starts them in the catch-up.
  recover({ startRunners = true }: { startRunners?: boolean } = {}): Promise<void> {
    return this.#locks.locked(async () => {
      const runners = this.#runner.serveRunners();
      for (const job of await this.#store.jobs.list()) {
        // One job's error is logged and the others are recovered all the same (an illegal
        // state change of one job cannot stop sf serve's start).
        await this.#recoverJob(runners, job, startRunners).catch((error: unknown) => console.error(error));
      }
      await this.#peers.handover.cleanSavedRefs().catch((error: unknown) => console.error(error));
    });
  }

  // The catch-up after an update: a runner for each job awaiting review that has something
  // to resume and none running, as recover() starts them.
  ensureResumable(): Promise<void> {
    return this.#locks.locked(async () => {
      const runners = this.#runner.serveRunners();
      for (const job of await this.#store.jobs.list()) {
        if (job.state === 'awaiting_review' && (job.handover === undefined || job.handover.step === null) && (await runners.owner(job.workspace, job.ticket)) === undefined) {
          await (async () => {
            if (await this.resumable(job)) {
              await runners.ensure(job.workspace, job.ticket);
            }
          })().catch((error: unknown) => console.error(error));
        }
      }
    });
  }

  // recover() for one job. Only under the lock.
  async #recoverJob(runners: Runners, job: Job, startRunners: boolean): Promise<void> {
    // A step of the hand-over cut off, before the job's generic handling; left alone
    // while its runner still runs it.
    if (job.handover !== undefined && job.handover.step !== null) {
      if ((await runners.owner(job.workspace, job.ticket)) === undefined) {
        await this.#peers.handover.repairHandover(job, job.handover).catch((error: unknown) => console.error(error));
      }
      return;
    }
    if (['working', 'preparing_mr', 'awaiting_review'].includes(job.state) && (await runners.owner(job.workspace, job.ticket)) !== undefined) {
      return;
    }
    if (job.state === 'awaiting_review') {
      if (startRunners && (await this.resumable(job))) {
        await runners.ensure(job.workspace, job.ticket);
      }
    } else if (job.state === 'working') {
      // from: working (the branch above)
      await this.#store.transition(job, 'needs_human', 'recover', { code: 'serve_restarted', message: 'sf serve restarted and the runner of the job had ended while the iteration ran; use sf say to continue.' });
    } else if (job.state === 'preparing_mr') {
      // from: preparing_mr (the branch above)
      await this.#store.transition(job, 'needs_human', 'recover', { code: 'mr_serve_restarted', message: 'sf serve restarted and the runner of the job had ended during MR preparation; go on with sf say (its iteration is reviewed again and a clean verdict prepares the branch again), or abort or reset the job.' });
    } else if (job.state === 'starting') {
      // from: starting (the branch above)
      await this.#store.transition(job, 'failed', 'recover', { code: 'serve_restarted', message: 'sf serve restarted while the job was starting.' });
    }
  }

  // A job awaiting review that has something to resume: its last iteration has no review (with the
  // review on), or one acted on as clean (a fix with nits only is) and no gate.json, or a clean
  // gate.json too and a simplification pass that never applied. With the Claude review off the
  // gate is the review: no gate.json (with the review on), or a clean one.
  async resumable(job: Job): Promise<boolean> {
    if (job.state !== 'awaiting_review' || job.iteration === 0) {
      return false;
    }
    if (!claudeReviews(job)) {
      const gate = await this.#store.jobs.readGate(job.workspace, job.ticket, job.iteration);
      if (gate === undefined) {
        return this.#settings.config.review;
      }
      return 'verdict' in gate && actedVerdict(withoutDropped(gate)) === 'clean';
    }
    const review = await this.#store.jobs.readReview(job.workspace, job.ticket, job.iteration);
    if (review === undefined) {
      return this.#settings.config.review;
    }
    // Items the ledger dropped (they reopened an accepted risk) never count, as in acceptGate.
    if (!('verdict' in review) || actedVerdict(withoutDropped(review)) !== 'clean') {
      return false;
    }
    const gate = await this.#store.jobs.readGate(job.workspace, job.ticket, job.iteration);
    if (gate === undefined) {
      return true;
    }
    // A clean gate whose outcome never applied (the pass, its record or MR preparation).
    return 'verdict' in gate && actedVerdict(withoutDropped(gate)) === 'clean';
  }

  // Creates the job record and its worktree, then runs the first iteration. The validation and
  // the record are under the lock, the fetch and the worktree creation under the workspace's Git
  // lock only, so a long fetch holds no other job. queued: the run queue's own start,
  // refused with job_limit unless fewer than max_running jobs run; a start by hand has no limit.
  async start(workspaceName: string, ticket: string, { queued = false }: { queued?: boolean } = {}): Promise<{ branch: string; state: JobState; check_after_minutes: number; worktree: string }> {
    const claimed = await this.#locks.locked(async () => {
      if (!TICKET_PATTERN.test(ticket)) {
        throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
      }
      const workspace = await this.#settings.resolve(workspaceName);
      const plan = await this.#plan(workspace, ticket);
      // Every image the Task file refers to must be usable: attachment_invalid otherwise.
      const images = await resolveTaskImages(workspace.workCheckout, ticket, plan.content);
      const existing = await this.#store.jobs.read(workspace.name, ticket);
      if (existing !== undefined && !TERMINAL_STATES.includes(existing.state)) {
        throw new FactoryError('job_exists', `The job for ${workspace.name}/${ticket} is ${existing.state}.`);
      }
      if (queued) {
        await this.#checkSlot(workspace.name, ticket);
      }
      if (existing !== undefined) {
        await this.#store.jobs.archive(workspace.name, ticket);
      }
      return this.#claim(workspace, ticket, plan, images);
    });
    return this.#launch(claimed);
  }

  // The base, continues and branch of a job from the Task file (readTask validates it, continues
  // too: invalid_content), which must not be a draft, and the Task text they were read from.
  async #plan(workspace: Workspace, ticket: string): Promise<{ base: string; continues: string | null; branch: string; content: string; review: TaskReview | undefined }> {
    const content = await readTask(workspace, ticket);
    if (isDraft(content)) {
      throw new FactoryError('task_draft', `${TASK_DIR}/${ticket}.md is still the skeleton: the Context owner writes the Task with write_task first, then the user starts the job.`);
    }
    const fields = parseFrontMatter(content)!;
    return { base: fields.get('base')!, continues: taskContinues(fields), branch: branchName(ticket, fields.get('title')!), content, review: taskReview(fields) };
  }

  // The run queue's limit: the running jobs of every workspace (RUNNING_STATES), the
  // ticket's own aside, are fewer than max_running (ExecutionOptions.maxRunning: sf serve reads
  // queue.json; without it, config.maxJobs); job_limit otherwise. Only the queue's own start runs
  // it, only under the lock.
  async #checkSlot(workspaceName: string, ticket: string): Promise<void> {
    const limit = this.#settings.maxRunning === undefined ? this.#settings.config.maxJobs : await this.#settings.maxRunning();
    const running = runningJobs(await this.#store.jobs.list()).filter((job) => !(job.workspace === workspaceName && job.ticket === ticket));
    if (running.length >= limit) {
      throw new FactoryError('job_limit', `${running.length} job${running.length === 1 ? '' : 's'} run (${running.map((job) => `${job.ticket} ${job.state}`).join(', ')}); the limit is ${limit}.`);
    }
  }

  // git fetch of the base from origin in the workspace's checkout (the run queue, before it
  // checks again whether a ticket it waits for is merged), under the workspace's Git lock; nothing
  // without an origin. fetch_failed when Git fails.
  async fetchBase(workspaceName: string, base: string): Promise<void> {
    const workspace = await this.#settings.resolve(workspaceName);
    if (base.startsWith('-') || (await runGit(workspace.workCheckout, ['check-ref-format', '--branch', base])).code !== 0) {
      throw new FactoryError('base_not_found', `The base "${base}" is not a valid branch name.`);
    }
    await this.#locks.gitLocked(workspaceName, async () => {
      if (!(await runGit(workspace.workCheckout, ['remote'])).stdout.toString('utf8').split('\n').includes('origin')) {
        return;
      }
      const fetch = await runGit(workspace.workCheckout, ['fetch', '--no-recurse-submodules', 'origin', base], 1024 * 1024, FETCH_TIMEOUT_MS);
      if (fetch.code !== 0) {
        throw new FactoryError('fetch_failed', fetch.code === null ? `git fetch origin ${base} did not finish in time.` : `git fetch origin ${base} failed.`);
      }
    });
  }

  // Writes the record of a new job in starting (the ticket's directory must be free); under the lock.
  // The job's Claude review is decided here, once: claude_review and its review_setup event.
  async #claim(workspace: Workspace, ticket: string, plan: { base: string; continues: string | null; branch: string; review: TaskReview | undefined }, images: ResolvedImage[]): Promise<Claimed> {
    const { base, continues, branch } = plan;
    const created = now();
    const worktree = this.#peers.handover.worktreePath(workspace.name, ticket);
    const setup = claudeReviewDecision(this.#settings.config, plan.review);
    const job: Job = {
      workspace: workspace.name, ticket, branch, base, continues, base_commit: null, state: 'starting', worktree, prepared_commit: null,
      iteration: 0, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null, mr: null, target_commit: null, mr_attempts: 0, mr_conflict_turn: false, created_at: created, updated_at: created,
      claude_review: setup.claude_review,
    };
    checkTransition(null, 'starting', 'create');
    await this.#store.jobs.write(job);
    await this.#store.jobs.appendEvent(workspace.name, ticket, { ts: created, iteration: 0, state: { from: null, to: 'starting' } });
    await this.#store.jobs.appendEvent(workspace.name, ticket, { ts: created, iteration: 0, type: 'review_setup', ...setup });
    return { workspace, ticket, base, continues, branch, worktree, images };
  }

  // The claimed job's worktree, then its first turn. kept (sf restart --keep-files): the
  // files of the previous job, saved in a directory of their own, are copied into the worktree
  // before the first turn, whose prompt names them; the directory goes once they are copied, and
  // stays (named in the error) when the job could not start.
  async #launch(claimed: Claimed, kept?: Kept): Promise<{ branch: string; state: JobState; check_after_minutes: number; worktree: string }> {
    const { workspace, ticket, base, continues, branch, worktree } = claimed;
    const keptNote = kept !== undefined && kept.paths.length > 0 ? ` The files kept from the previous job are in ${kept.dir}.` : '';
    let baseCommit: string;
    try {
      baseCommit = await this.#locks.gitLocked(workspace.name, () => this.#createWorktree(workspace.workCheckout, base, continues, branch, worktree));
    } catch (error) {
      const failure = error instanceof FactoryError ? error : new FactoryError('start_failed', 'Git failed while creating the worktree.');
      await this.#locks.locked(async () => {
        const job = await this.#store.jobs.read(workspace.name, ticket);
        if (job !== undefined && job.state === 'starting') {
          // from: starting (the guard above)
          await this.#store.transition({ ...job, worktree: null }, 'failed', 'launch', { code: failure.code, message: `${failure.message}${keptNote}` });
        }
      });
      throw new FactoryError(failure.code, `${failure.message}${keptNote}`);
    }
    const result = await this.#locks.locked(async () => {
      let job = await this.#store.jobs.read(workspace.name, ticket);
      if (job === undefined || job.state !== 'starting') {
        await removeWorktree(workspace.workCheckout, worktree);
        throw new FactoryError('job_ended', `The job for ${workspace.name}/${ticket} ended while it was starting.${keptNote}`);
      }
      job = { ...job, base_commit: baseCommit };
      await this.#store.jobs.write(job);
      let rules: string;
      try {
        rules = await this.#collectJobRules(workspace, ticket, baseCommit);
      } catch (error) {
        // No Implementer session without the rules: the job fails with its worktree, which
        // sf restart removes once the cause is fixed.
        const failure = error instanceof FactoryError ? error : new FactoryError('rules_failed', 'The coding rules could not be collected or stored.');
        if (!(error instanceof FactoryError)) {
          console.error(error);
        }
        const message = `${failure.message} Fix it, then sf restart the ticket.${keptNote}`;
        // from: starting (checked when the job was read above)
        await this.#store.transition(job, 'failed', 'launch', { code: failure.code, message });
        throw new FactoryError(failure.code, message);
      }
      if (kept !== undefined) {
        await copyKept(kept, worktree);
      }
      job = await this.storeImages(job, claimed.images);
      // from: starting (checked when the job was read above)
      job = await this.#store.transition(await this.syncTask(workspace, job), 'working', 'launch');
      // The first turn runs in the job's runner, with the images' blocks.
      const prompt = factoryPrompt(firstPrompt(ticket, kept?.paths ?? [], rules), ticket, job.iteration + 1, this.#peers.turns.imagesLine(job), job.base_commit);
      const images = this.#peers.reviews.imageRefs(job, (await this.#store.jobs.readTaskCopy(workspace.name, ticket)) ?? '');
      await this.#runner.serveRunners().queue(workspace.name, ticket, { kind: 'turn', prompt, ...(images.length > 0 ? { images } : {}) });
      return { branch, state: job.state, check_after_minutes: this.#settings.config.checkAfterStartMin, worktree };
    });
    if (kept !== undefined) {
      await rm(kept.dir, { recursive: true, force: true });
    }
    return result;
  }

  // The job's coding rules, collected once at its first base commit and stored in its
  // directory (rules.md, rules.json) for every later prompt; the block, '' when none were found.
  // Throws when they cannot be collected or stored: the job does not start without them.
  async #collectJobRules(workspace: Workspace, ticket: string, baseCommit: string): Promise<string> {
    const collected = await collectRules(workspace.workCheckout, baseCommit, {
      workspace: workspace.name, skip: workspace.rulesSkip ?? [], configDir: configDir(), maxBytes: this.#settings.config.rulesMaxBytes,
    });
    await writeJobRules(this.#store.jobs.dir(workspace.name, ticket), collected);
    return collected.block;
  }

  // Checks the names, fetches the start branch (continues, else the base) when origin exists,
  // creates the branch and its worktree from it and returns the base commit.
  async #createWorktree(checkout: string, base: string, continues: string | null, branch: string, path: string): Promise<string> {
    const valid = async (name: string): Promise<boolean> => !name.startsWith('-') && (await runGit(checkout, ['check-ref-format', '--branch', name])).code === 0;
    if (!(await valid(base))) {
      throw new FactoryError('base_not_found', `The base "${base}" is not a valid branch name.`);
    }
    if (!(await valid(branch))) {
      throw new FactoryError('invalid_ticket', `"${branch}" is not a valid branch name.`);
    }
    const { ref, commit } = await resolveTarget(checkout, await startBranch(checkout, base, continues));
    if ((await runGit(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
      throw new FactoryError('branch_exists', `The branch ${branch} already exists in the checkout.`);
    }
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await addWorktree(checkout, path, branch, { create: true, ref });
    return commit;
  }

  // The Task file of the checkout, copied into the worktree before every Implementer turn. The
  // version copied is the one the Implementer was last given: kept as task.md in the job
  // directory, and recorded as the job's version (recordTask). Returns the job.
  async syncTask(workspace: Workspace, job: Job): Promise<Job> {
    const content = await this.copyTask(workspace, job);
    if (content === undefined) {
      return job;
    }
    if ((await this.#store.jobs.readTaskCopy(job.workspace, job.ticket)) !== content) {
      await this.#store.jobs.writeTaskCopy(job.workspace, job.ticket, Buffer.from(content, 'utf8'));
    }
    return this.recordTask(job, content);
  }

  // The Task file's version the job works from: its sha256 in job.json, written when it changed.
  async recordTask(job: Job, content: string): Promise<Job> {
    const sha256 = taskSha256(content);
    if (job.task_sha256 === sha256) {
      return job;
    }
    const next: Job = { ...job, task_sha256: sha256 };
    await this.#store.jobs.write(next);
    return next;
  }

  // Copies the checkout's Task file into the worktree, for the reviewers only (a review round on
  // Resume): what the Implementer was last given stays recorded, so its next prompt carries
  // the change. Returns the text copied; undefined without a worktree.
  async copyTask(workspace: Workspace, job: Job): Promise<string | undefined> {
    if (job.worktree === null) {
      return undefined;
    }
    const dir = join(job.worktree, TASK_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await copyFile(join(workspace.workCheckout, TASK_DIR, `${job.ticket}.md`), join(dir, `${job.ticket}.md`));
    return readFile(join(dir, `${job.ticket}.md`), 'utf8');
  }

  // The job's images: copied into its directory (attachments/, the copy its agents are
  // given) and into the worktree's .software-factory/<ticket>/ (kept out of Git as the Task file
  // there), each replacing the copy before; recorded in job.json (absent with none) and logged with
  // an attachments event. A job that had none and gets none is left as it is. Returns the job.
  async storeImages(job: Job, images: ResolvedImage[]): Promise<Job> {
    const { workspace, ticket } = job;
    if (images.length === 0 && job.attachments === undefined) {
      return job;
    }
    const dirs = [this.#store.jobs.attachmentsDir(workspace, ticket), ...(job.worktree !== null ? [join(job.worktree, TASK_DIR, ticket)] : [])];
    for (const dir of dirs) {
      if (images.length > 0) {
        await writeImages(dir, images);
      } else {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const records = images.map(jobAttachment);
    const { attachments: _before, ...rest } = job;
    const next: Job = records.length > 0 ? { ...rest, attachments: records } : rest;
    await this.#store.jobs.write(next);
    await this.#store.jobs.appendEvent(workspace, ticket, { ts: now(), iteration: job.iteration, type: 'attachments', images: records });
    return next;
  }

  // Removes the sandbox's placeholder files from the worktree; a failure is logged and the steps
  // that follow (Patch, MR commit) still skip them.
  async removePlaceholders(cwd: string): Promise<string[]> {
    try {
      return await removeSandboxPlaceholders(cwd);
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  // sf restart: the ticket starts again from its current Task file, as a new job on a fresh worktree
  // and branch from the Task's base, for a job that is paused, parked on a usage limit, aborted,
  // failed or needs the user. The old job is retired as reset does (its runner stopped, its worktree
  // removed, its directory archived), and its branch deleted, only when it has no commit beyond the job's base
  // and was never pushed; otherwise nothing is touched and the restart is refused with the reason
  // (restart_refused). keepFiles: the old worktree's changed and new files go into the new worktree
  // before the first turn, whose prompt says so.
  async restart(workspaceName: string, ticket: string, keepFiles = false): Promise<{ branch: string; state: JobState; check_after_minutes: number; worktree: string; archived: string; branch_deleted: string | null; kept: string[] }> {
    const { claimed, kept, archived, deleted } = await this.#locks.locked(async () => {
      const old = await this.#store.job(workspaceName, ticket);
      checkNotInCheckout(old);
      if (!RESTARTABLE_STATES.includes(old.state)) {
        throw new FactoryError('invalid_state', `sf restart needs paused, waiting_limit, aborted, failed or needs_human; the job is ${old.state}.`);
      }
      const workspace = await this.#settings.resolve(workspaceName);
      const checkout = workspace.workCheckout;
      const plan = await this.#plan(workspace, ticket);
      // Every image the Task file refers to must be usable, before anything changes.
      const images = await resolveTaskImages(checkout, ticket, plan.content);
      // Checked before anything changes, and again below, in the Git lock that deletes the branch,
      // once the runner has stopped: nothing can add a commit between that check and the deletion.
      const branchCheck = async (): Promise<boolean> => {
        const oldExists = await this.#restartableBranch(checkout, old);
        if (plan.branch !== old.branch && (await runGit(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`])).code === 0) {
          throw new FactoryError('branch_exists', `The branch ${plan.branch} of the current Task file already exists in the checkout.`);
        }
        return oldExists;
      };
      await this.#locks.gitLocked(workspaceName, branchCheck);
      await this.#peers.control.endSession(workspaceName, ticket);
      const worktree = old.worktree ?? this.#peers.handover.worktreePath(workspaceName, ticket);
      let saved: Kept | undefined;
      if (keepFiles && old.base_commit !== null && (await exists(worktree))) {
        await mkdir(join(this.#settings.config.stateDir, 'tmp'), { recursive: true, mode: 0o700 });
        const dir = await mkdtemp(join(this.#settings.config.stateDir, 'tmp', `restart-${ticket}-`));
        saved = { dir, paths: await saveKept(worktree, old.base_commit, dir) };
      }
      // Once the old worktree is gone, the saved files are the only copy: they stay on a failure.
      let removed = false;
      const keptNote = (): string => (removed && saved !== undefined && saved.paths.length > 0 ? ` The files kept from the old worktree are in ${saved.dir}.` : '');
      try {
        const { deleteOld, failure } = await this.#locks.gitLocked(workspaceName, async () => {
          const deleting = await branchCheck();
          const notRemoved = await removeWorktree(checkout, worktree);
          if (notRemoved !== undefined) {
            return { deleteOld: deleting, failure: `${notRemoved} Nothing else was changed; the job is ${old.state}.` };
          }
          removed = true;
          const notDeleted = deleting ? await deleteBranch(checkout, old.branch) : undefined;
          return { deleteOld: deleting, failure: notDeleted === undefined ? undefined : `${notDeleted} The old worktree was removed; the branch and the job (${old.state}) are as they were.` };
        });
        if (failure !== undefined) {
          throw new FactoryError('restart_failed', failure);
        }
        const name = await this.#store.jobs.archive(workspaceName, ticket);
        return { claimed: await this.#claim(workspace, ticket, plan, images), kept: saved, archived: `jobs/${workspaceName}/${name}`, deleted: deleteOld ? old.branch : null };
      } catch (error) {
        if (saved !== undefined && !removed) {
          await rm(saved.dir, { recursive: true, force: true });
        }
        if (error instanceof FactoryError && keptNote() !== '') {
          throw new FactoryError(error.code, `${error.message}${keptNote()}`);
        }
        throw error;
      }
    });
    const started = await this.#launch(claimed, kept);
    return { ...started, archived, branch_deleted: deleted, kept: kept?.paths ?? [] };
  }

  // Whether the old job's branch is to be deleted at restart: false when the checkout has no such
  // branch; true when it has no commit beyond the job's base commit and was never pushed (no
  // merge request, no upstream, no remote-tracking branch, on no configured remote); refused otherwise
  // (restart_refused, with the reason). Only under the workspace's Git lock.
  async #restartableBranch(checkout: string, job: Job): Promise<boolean> {
    const ref = `refs/heads/${job.branch}`;
    if ((await runGit(checkout, ['rev-parse', '--verify', '--quiet', ref])).code !== 0) {
      return false;
    }
    const refuse = (reason: string): FactoryError => new FactoryError('restart_refused', `The restart was refused: ${reason}. Nothing was changed.`);
    if (job.base_commit === null) {
      throw refuse(`the branch ${job.branch} exists, but the job never created it (it has no base commit); rename or delete it by hand`);
    }
    const count = await runGit(checkout, ['rev-list', '--count', `${job.base_commit}..${ref}`]);
    const commits = Number(count.stdout.toString('utf8').trim());
    if (count.code !== 0 || !Number.isInteger(commits)) {
      throw refuse(`the commits of ${job.branch} beyond the base could not be counted (${count.stderr.trim().slice(0, 300)})`);
    }
    if (commits > 0) {
      throw refuse(`the branch ${job.branch} has ${commits} commit(s) beyond the base; push or delete it by hand first`);
    }
    if (job.mr !== null) {
      throw refuse(`the branch ${job.branch} has a merge request (#${job.mr.number})`);
    }
    const upstream = await runGit(checkout, ['config', '--get', `branch.${job.branch}.remote`]);
    if (upstream.code === 0 && upstream.stdout.toString('utf8').trim() !== '') {
      throw refuse(`the branch ${job.branch} has an upstream (${upstream.stdout.toString('utf8').trim()}): it was pushed`);
    }
    const tracking = (await runGit(checkout, ['for-each-ref', '--format=%(refname)', 'refs/remotes/'])).stdout.toString('utf8').split('\n')
      .filter((name) => name.endsWith(`/${job.branch}`));
    if (tracking.length > 0) {
      throw refuse(`the branch ${job.branch} was pushed (${tracking.map((name) => name.replace(/^refs\/remotes\//, '')).join(', ')})`);
    }
    // Every configured remote is asked: a push needs no upstream and no fetched
    // remote-tracking branch. One that cannot answer refuses: the branch may be on it.
    const remotes = await runGit(checkout, ['remote']);
    if (remotes.code !== 0) {
      throw refuse(`the remotes of the checkout could not be listed (${remotes.stderr.trim().slice(0, 300)})`);
    }
    for (const name of remotes.stdout.toString('utf8').split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
      const remote = await runGit(checkout, ['ls-remote', '--heads', name, ref], 64 * 1024, LS_REMOTE_TIMEOUT_MS);
      if (remote.code !== 0) {
        throw refuse(`the remote ${name} could not be asked whether ${job.branch} was pushed (${remote.code === null ? `no answer within ${LS_REMOTE_TIMEOUT_MS / 1000} s` : remote.stderr.trim().slice(0, 300)})`);
      }
      if (remote.stdout.toString('utf8').trim() !== '') {
        throw refuse(`the branch ${job.branch} is on the remote ${name}: it was pushed`);
      }
    }
    return true;
  }
}
