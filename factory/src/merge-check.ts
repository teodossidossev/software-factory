// The merge check: before sf mr merge (and the dashboard's Merge) merges a job's merge request on
// the Git host, a workspace with a test command checks the change against its base as it is now.
// The factory fetches the base and the MR branch from origin, merges the branch's head into the
// base's commit with `git merge --no-ff --no-edit` in a temporary detached worktree
// (<worktreeRoot>/<workspace>/.merge-check-<ticket>-<random>), and runs the test command there in
// the sandbox of the job's own test runs (src/test-command.ts, with the path denials of a job
// session for that worktree). A conflict, a run that fails, times out or cannot run, or a sandbox
// that cannot be built refuses the merge (mr_check_failed); a base or a branch that moved on origin
// during a passing run is checked once more, and a second move refuses. The worktree is removed
// however a run ends; one that cannot be removed, or whose removal cannot be verified, refuses the
// merge, and so does a leftover of an earlier check that cannot be. Git runs through runGit
// (no hooks, no fsmonitor), the merge commit unsigned, under a fixed identity and without automatic
// maintenance, so no program of the repository's or of the user's Git config runs and no Git process
// outlives the check.
//
// MergeChecks wraps the merge of the job's merge request: the check runs outside the operation lock
// (it takes minutes), registered as the job's running review, so stop(), sf reset and abort cancel it
// (runner_stopping) as they cancel a test run, its Git calls and its test run killed; each check is
// one merge_checked event of the job; the merge itself happens under the lock, only after a check
// that passed.
import { randomBytes } from 'node:crypto';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_TEST_TIMEOUT_MS } from './config.js';
import { pushedBranch } from './continues.js';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import { type EventRecord, type Job, type JobMr, now } from './jobs.js';
import { gitFailure } from './mr.js';
import { pathDenials } from './sandbox-denials.js';
import { durationText, failureText, inlineCommand, lastLines, runTestCommand, type TestsRecord } from './test-command.js';
import { TESTS_RUNNER } from './execution/events.js';
import type { JobStorePort, LivePort, LockPort, SettingsPort, StopPort } from './execution/ports.js';
import type { RunningReview } from './execution/shared.js';
import type { Workspace } from './registry.js';

// How a run of the check ended: the tests passed on the merged result, failed (or could not run, or
// the check could not be set up), the merge conflicted, the run timed out, or it was cancelled.
export const MERGE_CHECK_OUTCOMES = ['passed', 'failed', 'conflict', 'timed_out', 'aborted'] as const;
export type MergeCheckOutcome = (typeof MERGE_CHECK_OUTCOMES)[number];

// The refusal of a merge whose check did not pass.
export const MERGE_CHECK_FAILED = 'mr_check_failed';

// The runs of one check at most: the first, and one more when origin moved during it.
export const MERGE_CHECK_ROUNDS = 2;

// The folder name of a check's worktree starts with this, then the ticket, "-" and RANDOM_HEX.
export const MERGE_CHECK_PREFIX = '.merge-check-';
const RANDOM_BYTES = 6;
const RANDOM_HEX = new RegExp(`^[0-9a-f]{${RANDOM_BYTES * 2}}$`);

// What a refusal quotes of a failure: its first lines; of a run's output, its last lines.
export const FAILURE_LINES = 20;
const OUTPUT_BYTES = 2048;
// The conflicting paths a refusal names at most.
const CONFLICT_PATHS = 10;

// The bound of each Git call of the check (the fetches, the worktree and its submodules, the merge).
const GIT_TIMEOUT_MS = 120_000;
// The bound of each Git call of a worktree's clean-up (remove, prune, list).
const CLEANUP_TIMEOUT_MS = 60_000;
// The signal of the clean-up's Git calls: never aborted (a cancelled check still cleans up), given
// so that runGit kills each one's whole process group at its timeout.
const CLEANUP_SIGNAL = new AbortController().signal;

// The merge commit's author and committer: it never leaves the check's worktree, and a checkout
// without a Git identity still merges.
const MERGE_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Software Factory', GIT_AUTHOR_EMAIL: 'merge-check@software-factory.invalid',
  GIT_COMMITTER_NAME: 'Software Factory', GIT_COMMITTER_EMAIL: 'merge-check@software-factory.invalid',
};

// The merge itself: no automatic gc or maintenance, which would start Git processes that outlive the
// check; unsigned, without a signature check, whatever the user's config says.
const MERGE_ARGS: readonly string[] = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'merge', '--no-ff', '--no-edit', '--no-gpg-sign', '--no-verify-signatures'];

// One run of the check: the base's commit it merged into, the MR branch's head it merged, how it
// ended, how long it took, and why it did not pass (failed, conflict, timed_out).
export interface MergeCheckRun {
  base_commit: string;
  head_commit: string;
  outcome: MergeCheckOutcome;
  duration_ms: number;
  failure?: string;
}

// The commits of the base and of the MR branch on origin.
interface Tips {
  base: string;
  head: string;
}

export interface MergeCheckOptions {
  // The workspace's work checkout: its origin, and where the worktree is registered.
  checkout: string;
  worktreeRoot: string;
  workspace: string;
  ticket: string;
  base: string;
  branch: string;
  command: string;
  timeoutMs: number;
  signal: AbortSignal;
  // The paths hidden in the run's sandbox, for the check's worktree.
  hidden: (worktree: string) => Promise<readonly string[]>;
  // The workspace's Git lock, around each Git call on the checkout.
  gitLocked: <T>(work: () => Promise<T>) => Promise<T>;
  // The clock of the durations, in ms (default: Date.now).
  now?: () => number;
  // The bound of each fetch and of the merge (default: GIT_TIMEOUT_MS).
  gitTimeoutMs?: number;
}

// A check as a whole (its merge_checked event): how it ended (failed too when the fetch failed or
// origin kept moving), the base's commit of its last run (null when no run started), and how long it
// took; its runs, and why the merge is refused (none when it passed).
export interface MergeCheck {
  outcome: MergeCheckOutcome;
  base_commit: string | null;
  duration_ms: number;
  runs: MergeCheckRun[];
  refusal?: FactoryError;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The first lines of a text.
const firstLines = (text: string): string => text.split('\n').slice(0, FAILURE_LINES).join('\n');

// The refusal of a check that was cancelled: nothing is merged.
const cancelled = (): FactoryError => new FactoryError('runner_stopping', 'The merge check was cancelled; nothing was merged.');

// Fetches the base and the MR branch from origin into their remote-tracking refs, in one fetch that
// the check's cancellation stops, and reads their commits.
async function fetchTips(options: MergeCheckOptions): Promise<Tips> {
  const baseRef = `refs/remotes/origin/${options.base}`;
  const headRef = `refs/remotes/origin/${options.branch}`;
  const args = ['fetch', '--no-recurse-submodules', 'origin', `+refs/heads/${options.base}:${baseRef}`, `+refs/heads/${options.branch}:${headRef}`];
  return options.gitLocked(async () => {
    const limit = options.gitTimeoutMs ?? GIT_TIMEOUT_MS;
    const fetched = await runGit(options.checkout, args, 1024 * 1024, limit, {}, undefined, options.signal);
    if (options.signal.aborted) {
      throw cancelled();
    }
    if (fetched.code !== 0) {
      const missing = /couldn't find remote ref (\S+)/i.exec(fetched.stderr)?.[1];
      if (missing === `refs/heads/${options.base}`) {
        throw new FactoryError('base_not_found', `The base "${options.base}" does not exist on origin; nothing was merged.`);
      }
      if (missing !== undefined) {
        throw new FactoryError('branch_missing', `The branch ${options.branch} is not on origin; nothing was merged.`);
      }
      throw new FactoryError('fetch_failed', fetched.code === null ? `git fetch origin did not finish within ${durationText(limit)}; nothing was merged.` : `${gitFailure(args, fetched)}.`);
    }
    const commits = await runGit(options.checkout, ['rev-parse', `${baseRef}^{commit}`, `${headRef}^{commit}`]);
    const [base, head] = commits.stdout.toString('utf8').trim().split('\n');
    if (commits.code !== 0 || base === undefined || head === undefined) {
      throw new FactoryError('fetch_failed', `The base ${options.base} or the branch ${options.branch} fetched from origin names no commit.`);
    }
    return { base, head };
  });
}

// Merges head into the worktree's detached base: undefined when it merged, else a conflict with the
// paths, or a failure of Git itself.
async function mergeHead(path: string, branch: string, head: string, signal: AbortSignal, timeoutMs: number): Promise<Pick<MergeCheckRun, 'outcome' | 'failure'> | undefined> {
  const args = [...MERGE_ARGS, head];
  const merged = await runGit(path, args, 1024 * 1024, timeoutMs, MERGE_IDENTITY, undefined, signal);
  if (merged.code === 0) {
    return undefined;
  }
  const unmerged = merged.code === null ? undefined : await runGit(path, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const paths = unmerged?.code === 0 ? unmerged.stdout.toString('utf8').split('\0').filter((entry) => entry !== '') : [];
  if (paths.length > 0) {
    const named = paths.slice(0, CONFLICT_PATHS).join(', ');
    return { outcome: 'conflict', failure: `${branch} conflicts with it in ${named}${paths.length > CONFLICT_PATHS ? ` and ${paths.length - CONFLICT_PATHS} more` : ''}` };
  }
  return { outcome: 'failed', failure: merged.code === null ? `the merge did not finish within ${durationText(timeoutMs)}` : `the merge failed: ${gitFailure(args, merged)}` };
}

// How a run of the test command ended, as a run of the check.
function runEnding(record: TestsRecord): Pick<MergeCheckRun, 'outcome' | 'failure'> {
  if (record.outcome === 'passed') {
    return { outcome: 'passed' };
  }
  const command = inlineCommand(record.command);
  const how = record.outcome === 'unavailable' ? `${command} could not run (${record.reason ?? 'unknown reason'})` : `${command} failed (${failureText(record)})`;
  const tail = lastLines(record.output, FAILURE_LINES, OUTPUT_BYTES);
  return { outcome: record.timed_out ? 'timed_out' : 'failed', failure: tail === '' ? how : `${how}:\n${tail}` };
}

// Whether something is at path; anything but "not there" (ENOENT) counts as there.
const present = (path: string): Promise<boolean> => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');

// A clean-up Git call on the checkout, under the workspace's Git lock: its failure, or undefined.
async function cleanupGit(options: MergeCheckOptions, args: string[]): Promise<{ failure?: string; stdout: string }> {
  try {
    const result = await options.gitLocked(() => runGit(options.checkout, args, 4 * 1024 * 1024, CLEANUP_TIMEOUT_MS, {}, undefined, CLEANUP_SIGNAL));
    if (result.code !== 0 || result.truncated) {
      return { failure: result.code === null ? `git ${args[0]} ${args[1]} did not finish within ${durationText(CLEANUP_TIMEOUT_MS)}` : gitFailure(args, result), stdout: '' };
    }
    return { stdout: result.stdout.toString('utf8') };
  } catch (error) {
    return { failure: messageOf(error), stdout: '' };
  }
}

// The worktrees the checkout has registered, by path; the failure when Git cannot list them.
async function listedWorktrees(options: MergeCheckOptions): Promise<{ failure?: string; paths: string[] }> {
  const listed = await cleanupGit(options, ['worktree', 'list', '--porcelain', '-z']);
  if (listed.failure !== undefined) {
    return { failure: `the checkout's worktrees could not be listed: ${listed.failure}`, paths: [] };
  }
  return { paths: listed.stdout.split('\0').filter((field) => field.startsWith('worktree ')).map((field) => field.slice('worktree '.length)) };
}

// Removes a check's worktree, every step tried whatever the one before did: its folder, then
// `git worktree remove --force` (when the folder is still there) and prune; then it checks that the
// folder is gone and the checkout lists no such worktree. Returns why it may still be there (on
// disk, registered, or not known because a step or the check itself failed), or undefined once it is
// known to be gone. Never throws.
async function removeCheckWorktree(options: MergeCheckOptions, path: string): Promise<string | undefined> {
  const problems: string[] = [];
  await rm(path, { recursive: true, force: true }).catch((error: unknown) => problems.push(messageOf(error)));
  if (await present(path)) {
    const removed = await cleanupGit(options, ['worktree', 'remove', '--force', path]);
    if (removed.failure !== undefined) {
      problems.push(removed.failure);
    }
  }
  const pruned = await cleanupGit(options, ['worktree', 'prune']);
  if (pruned.failure !== undefined) {
    problems.push(pruned.failure);
  }
  // Git records the worktree by its real path.
  const real = join(await realpath(dirname(path)).catch(() => dirname(path)), basename(path));
  const listed = await listedWorktrees(options);
  if (listed.failure !== undefined) {
    problems.push(listed.failure);
  }
  const left = (await present(path)) || listed.failure !== undefined || listed.paths.some((entry) => entry === path || entry === real);
  if (!left) {
    return undefined;
  }
  const failure = `the check's worktree ${path} could not be removed${problems.length > 0 ? `: ${problems.join('; ')}` : ''}`.slice(0, 500);
  console.error(`merge check of ${options.workspace}/${options.ticket}: ${failure}`);
  return failure;
}

// Removes the worktrees of the ticket's checks that an sf serve stopped mid-check left behind, on
// disk or only registered. Only one check of a job runs at a time, so any found is a leftover.
// Returns why one may still be there (or the folder or the checkout's worktrees could not be read),
// or undefined.
async function removeLeftovers(options: MergeCheckOptions): Promise<string | undefined> {
  const folder = join(options.worktreeRoot, options.workspace);
  const start = `${MERGE_CHECK_PREFIX}${options.ticket}-`;
  const ours = (name: string): boolean => name.startsWith(start) && RANDOM_HEX.test(name.slice(start.length));
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `${folder} could not be read: ${messageOf(error)}`;
    }
    names = [];
  }
  const listed = await listedWorktrees(options);
  if (listed.failure !== undefined) {
    return listed.failure;
  }
  const leftovers = new Set([...names, ...listed.paths.map((path) => basename(path))].filter(ours));
  for (const name of leftovers) {
    const failure = await removeCheckWorktree(options, join(folder, name));
    if (failure !== undefined) {
      return failure;
    }
  }
  return undefined;
}

// Creates the check's detached worktree at commit, with its submodules, under the workspace's Git
// lock; the check's cancellation and the Git timeout stop each call with all it started (the
// checkout's filters, the submodules' fetch). Throws why it could not.
async function addCheckWorktree(options: MergeCheckOptions, path: string, commit: string): Promise<void> {
  const limit = options.gitTimeoutMs ?? GIT_TIMEOUT_MS;
  const step = async (cwd: string, args: string[]): Promise<void> => {
    const result = await runGit(cwd, args, 1024 * 1024, limit, {}, undefined, options.signal);
    if (options.signal.aborted) {
      throw cancelled();
    }
    if (result.code !== 0) {
      throw new Error(result.code === null ? `git ${args[0]} ${args[1]} did not finish within ${durationText(limit)}` : gitFailure(args, result));
    }
  };
  await options.gitLocked(async () => {
    await step(options.checkout, ['worktree', 'add', '--detach', path, commit]);
    if (await present(join(path, '.gitmodules'))) {
      await step(path, ['submodule', 'update', '--init', '--recursive']);
    }
  });
}

// One run: a detached worktree at the base's commit, the merge of the head, the test command in the
// sandbox; the worktree removed however it ends. A worktree that cannot be removed fails a run that
// passed; a cancelled one stays aborted.
async function checkOnce(options: MergeCheckOptions, tips: Tips): Promise<MergeCheckRun> {
  const clock = options.now ?? Date.now;
  const started = clock();
  const path = join(options.worktreeRoot, options.workspace, `${MERGE_CHECK_PREFIX}${options.ticket}-${randomBytes(RANDOM_BYTES).toString('hex')}`);
  let ending: Pick<MergeCheckRun, 'outcome' | 'failure'>;
  try {
    ending = await runIn(options, tips, path);
  } finally {
    const left = await removeCheckWorktree(options, path);
    if (left !== undefined) {
      ending ??= { outcome: 'failed', failure: left };
      if (ending.outcome === 'passed') {
        ending = { outcome: 'failed', failure: left };
      }
    }
  }
  return {
    base_commit: tips.base, head_commit: tips.head, outcome: ending.outcome, duration_ms: clock() - started, ...(ending.failure !== undefined ? { failure: ending.failure } : {}),
  };
}

// The steps of a run in its worktree at path, until one does not pass or the check is cancelled.
async function runIn(options: MergeCheckOptions, tips: Tips, path: string): Promise<Pick<MergeCheckRun, 'outcome' | 'failure'>> {
  const { signal } = options;
  if (signal.aborted) {
    return { outcome: 'aborted' };
  }
  try {
    await addCheckWorktree(options, path, tips.base);
  } catch (error) {
    return signal.aborted ? { outcome: 'aborted' } : { outcome: 'failed', failure: `the check's worktree could not be created: ${messageOf(error)}` };
  }
  if (signal.aborted) {
    return { outcome: 'aborted' };
  }
  const merged = await mergeHead(path, options.branch, tips.head, signal, options.gitTimeoutMs ?? GIT_TIMEOUT_MS);
  if (signal.aborted) {
    return { outcome: 'aborted' };
  }
  if (merged !== undefined) {
    return merged;
  }
  let hidden: readonly string[];
  try {
    hidden = await options.hidden(path);
  } catch (error) {
    return { outcome: 'failed', failure: `the sandbox could not be built: ${messageOf(error)}`.slice(0, 500) };
  }
  const result = await runTestCommand({ command: options.command, cwd: path, hidden, timeoutMs: options.timeoutMs, signal });
  return result.aborted ? { outcome: 'aborted' } : runEnding(result.record);
}

// The refusal of a run that did not pass.
function refusalOf(run: MergeCheckRun, base: string): FactoryError {
  if (run.outcome === 'aborted') {
    return cancelled();
  }
  return new FactoryError(MERGE_CHECK_FAILED, `The change fails on ${base} as it is now (${run.base_commit.slice(0, 12)}): ${firstLines(run.failure ?? run.outcome)}`);
}

// The check: runs until one does not pass, or one passes with origin unchanged after it, at most
// MERGE_CHECK_ROUNDS. Never throws: a fetch that fails is the refusal, and a cancellation, wherever
// it comes, is aborted (runner_stopping).
export async function checkMerge(options: MergeCheckOptions): Promise<MergeCheck> {
  const clock = options.now ?? Date.now;
  const started = clock();
  const runs: MergeCheckRun[] = [];
  const done = (outcome: MergeCheckOutcome, refusal?: FactoryError): MergeCheck => ({
    outcome, base_commit: runs.at(-1)?.base_commit ?? null, duration_ms: clock() - started, runs, ...(refusal !== undefined ? { refusal } : {}),
  });
  try {
    const leftover = await removeLeftovers(options);
    if (leftover !== undefined) {
      return done('failed', new FactoryError(MERGE_CHECK_FAILED, `An earlier merge check of ${options.ticket} left a worktree that could not be removed (${leftover}); nothing was merged.`));
    }
    let tips = await fetchTips(options);
    for (let round = 1; ; round += 1) {
      const run = await checkOnce(options, tips);
      runs.push(run);
      if (run.outcome !== 'passed') {
        return done(run.outcome, refusalOf(run, options.base));
      }
      const after = await fetchTips(options);
      if (after.base === tips.base && after.head === tips.head) {
        return done('passed');
      }
      if (round >= MERGE_CHECK_ROUNDS) {
        const moving = after.base !== tips.base ? `the base ${options.base}` : `the branch ${options.branch}`;
        return done('failed', new FactoryError(MERGE_CHECK_FAILED, `The change was checked, but ${moving} keeps moving on origin; merge again.`));
      }
      tips = after;
    }
  } catch (error) {
    if (options.signal.aborted) {
      return done('aborted', cancelled());
    }
    return done('failed', error instanceof FactoryError ? error : new FactoryError('fetch_failed', messageOf(error)));
  }
}

// The merge_checked event of a check, with how it ended for the merge (aborted when it was cancelled
// after its last step).
export function mergeCheckedEvent(iteration: number, check: MergeCheck, outcome: MergeCheckOutcome = check.outcome): EventRecord {
  return { ts: now(), iteration, type: 'merge_checked', base_commit: check.base_commit, outcome, duration_ms: check.duration_ms };
}

// Refuses a merge unless the job is pushed with an open merge request and no check of it runs.
export function checkMergeable(job: Job, running: RunningReview | undefined): asserts job is Job & { mr: JobMr } {
  if (job.state !== 'pushed' || job.mr === null) {
    throw new FactoryError('invalid_state', `sf mr merge needs a pushed job with a merge request (sf mr create opens one); the job is ${job.state}${job.state === 'pushed' ? ' without one' : ''}.`);
  }
  if (job.mr.state !== 'open') {
    throw new FactoryError('invalid_state', `The merge request #${job.mr.number} is ${job.mr.state}; only an open one is merged.`);
  }
  if (running !== undefined) {
    throw new FactoryError('invalid_state', `A merge check is running for ${job.workspace}/${job.ticket}; wait for its end.`);
  }
}

// The ports a merge with its check uses.
export interface MergeCheckPorts {
  store: JobStorePort;
  locks: LockPort;
  sessions: LivePort;
  settings: SettingsPort;
  stop: StopPort;
}

export class MergeChecks {
  readonly #ports: MergeCheckPorts;

  constructor(ports: MergeCheckPorts) {
    this.#ports = ports;
  }

  // Merges the job's merge request: prepare (under the lock, before any check) and merge (under the
  // lock, given what prepare returned and the head the check tested, undefined without a check).
  // Without a test command, both in one lock acquisition, as before the check existed.
  async merge<P, T>(workspaceName: string, ticket: string, prepare: (job: Job & { mr: JobMr }) => Promise<P>, merge: (job: Job & { mr: JobMr }, prepared: P, head: string | undefined) => Promise<T>): Promise<T> {
    const { store, locks, sessions, settings, stop } = this.#ports;
    const key = `${workspaceName}/${ticket}`;
    type Started = { checked: false; merged: T } | { checked: true; job: Job; workspace: Workspace; command: string; prepared: P; running: RunningReview };
    const started = await locks.locked(async (): Promise<Started> => {
      const job = await store.job(workspaceName, ticket);
      checkMergeable(job, sessions.reviews.get(key));
      const workspace = await settings.resolve(workspaceName);
      const prepared = await prepare(job);
      if (workspace.testCommand === undefined) {
        return { checked: false, merged: await merge(job, prepared, undefined) };
      }
      if (stop.isStopping()) {
        throw new FactoryError('runner_stopping', 'The factory is stopping; no merge check starts.');
      }
      const running: RunningReview = { reviewer: TESTS_RUNNER, iteration: job.iteration, controller: new AbortController() };
      sessions.reviews.set(key, running);
      return { checked: true, job, workspace, command: workspace.testCommand, prepared, running };
    });
    if (!started.checked) {
      return started.merged;
    }
    const { job, workspace, command, prepared, running } = started;
    const { config } = settings;
    let outcome: { check: MergeCheck } | { error: unknown };
    try {
      const check = await checkMerge({
        checkout: workspace.workCheckout, worktreeRoot: config.worktreeRoot, workspace: workspaceName, ticket, base: job.base, branch: pushedBranch(job), command,
        timeoutMs: config.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS, signal: running.controller.signal, gitLocked: (work) => locks.gitLocked(workspaceName, work),
        hidden: async (worktree) => (await pathDenials({
          session: 'job', workspace: workspaceName, checkout: workspace.workCheckout, worktree, stateDir: config.stateDir, worktreeRoot: config.worktreeRoot,
        })).sandbox.denyRead,
      });
      outcome = { check };
    } catch (error) {
      outcome = { error };
    }
    return locks.locked(async () => {
      const ours = sessions.reviews.get(key) === running;
      if (ours) {
        sessions.reviews.delete(key);
      }
      // A cancellation comes first, whatever else the check met.
      const aborted = !ours || running.controller.signal.aborted;
      if ('error' in outcome) {
        throw aborted ? cancelled() : outcome.error;
      }
      // The event goes to the job the check started on; one that reset archived gets none.
      const current = await store.jobs.read(workspaceName, ticket);
      if (current !== undefined && current.created_at === job.created_at) {
        await store.jobs.appendEvent(workspaceName, ticket, mergeCheckedEvent(current.iteration, outcome.check, aborted ? 'aborted' : outcome.check.outcome));
      }
      if (aborted) {
        throw cancelled();
      }
      if (outcome.check.refusal !== undefined) {
        throw outcome.check.refusal;
      }
      if (current === undefined || current.created_at !== job.created_at) {
        throw cancelled();
      }
      checkMergeable(current, undefined);
      return merge(current, prepared, outcome.check.runs.at(-1)!.head_commit);
    });
  }
}
