// The Archive of a finished job with its active Task file, Merged — archive, and sf serve's pass of
// merged jobs: the helpers of ControlPart's archiveFinished, markMerged and archiveMergedJobs. The
// Archive is reset for a finished job (the branch and its commits stay); with an active Task file it
// is Setup's ticket archive (SettingsPort.archiveTicket), which moves the Task file to the archive
// too. Merged — archive and the pass mark a job merged (merged_on_target) before its Archive; neither
// deletes a branch or a commit, and the pass sends only GET requests to the Git host and only
// `git fetch --no-tags origin <base>` to origin.
import { join } from 'node:path';
import { pushedBranch } from '../continues.js';
import { FactoryError } from '../errors.js';
import { chooseForge, type Forge, forgeFor } from '../forge.js';
import { mergedOnTarget } from '../digest-jobs.js';
import { runGit } from '../git.js';
import { type Job, type JobState, now } from '../jobs.js';
import { originUrl } from '../mr.js';
import type { Workspace } from '../registry.js';
import { branchMerged } from '../setup.js';
import { TASK_DIR } from '../task-file.js';
import type { Retired } from './dto.js';
import type { JobStorePort, LockPort, SettingsPort } from './ports.js';
import { exists } from './shared.js';

// How long the pass waits for the fetch of one target.
const FETCH_TIMEOUT_MS = 60_000;
// sf serve runs the pass a minute after its start, then every 10 minutes.
export const MERGED_FIRST_MS = 60_000;
export const MERGED_EVERY_MS = 10 * 60_000;

// Setup's ticket archive of a finished job whose Task file is active in the work checkout: the job
// it retired with it, in Setup's own lock acquisition. undefined when it does not apply (no Setup
// bound, a workspace that cannot be resolved, no active Task file), or when no job was left to
// retire: the caller then retires the job alone (and refuses a job that is gone).
export async function archiveWithTask(settings: SettingsPort, job: Job): Promise<Retired | undefined> {
  const archive = settings.archiveTicket;
  const workspace = archive === undefined ? undefined : await settings.resolve(job.workspace).catch(() => undefined);
  if (archive === undefined || workspace === undefined || !(await exists(join(workspace.workCheckout, TASK_DIR, `${job.ticket}.md`)))) {
    return undefined;
  }
  return archive(job.workspace, job.ticket);
}

// What the pass and Merged — archive use of ControlPart: its stores, locks and settings, the Archive
// (archiveFinished) and the hand-over's step to pushed (markHandedDone, with its refusals).
export interface MergedPorts {
  store: JobStorePort;
  locks: LockPort;
  settings: SettingsPort;
  archive(workspace: string, ticket: string): Promise<Retired>;
  markHandedDone(workspace: string, ticket: string): Promise<unknown>;
}

// How a merge was found (merged_on_target's how, mr and commit).
type Found = { how: 'base' | 'host' | 'user'; commit: string | null; mr?: number };

// The state of sf serve's pass of merged jobs across its runs (ControlPart holds one), and Merged —
// archive: the fetch targets and host reads whose failure was logged, and whether a run is under
// way; a run started meanwhile does nothing and returns no job. ports: ControlPart's, read at each call.
export class MergedPass {
  readonly #failures = new Set<string>();
  readonly #ports: () => MergedPorts;
  #running = false;

  constructor(ports: () => MergedPorts) {
    this.#ports = ports;
  }

  async run(): Promise<Job[]> {
    if (this.#running) {
      return [];
    }
    this.#running = true;
    try {
      return await archiveMerged(this.#ports(), this.#failures);
    } finally {
      this.#running = false;
    }
  }

  // Merged — archive: the user says the job's change is merged (any way; the branch may be gone).
  // A handed_over job first goes to pushed through markHandedDone (its refusals too); then the
  // pushed job gets merged_on_target (how user, once) and the Archive. Neither origin nor the host
  // is asked. When the Archive fails, the job stays pushed and marked: a second call archives it.
  async markMerged(workspaceName: string, ticket: string): Promise<Retired & { state: JobState }> {
    const ports = this.#ports();
    const job = await ports.store.job(workspaceName, ticket);
    if (job.state === 'handed_over') {
      await ports.markHandedDone(workspaceName, ticket);
    } else if (job.state !== 'pushed') {
      throw new FactoryError('invalid_state', `Merged — archive needs a handed-over or pushed job; it is ${job.state}.`);
    }
    const marked = await logMerged(ports, job, { how: 'user', commit: null });
    if (marked === undefined) {
      const current = await ports.store.jobs.read(workspaceName, ticket).catch(() => undefined);
      throw new FactoryError('invalid_state', `The job changed meanwhile; it is ${current?.state ?? 'gone'}. Nothing was archived.`);
    }
    return { state: marked.state, ...(await ports.archive(workspaceName, ticket)) };
  }
}

// What one run of the pass reads once: the fetch of each target, the Forge of each workspace.
interface Run {
  fetched: Map<string, Promise<boolean>>;
  forges: Map<string, Promise<Forge | undefined>>;
}

// The jobs the pass looks at: every pushed job, and every handed_over job with no step of the
// hand-over in progress and without continues (a continued branch's merge request was open before
// the job and may be merged without its change); with a base that is no option.
const candidate = (job: Job): boolean => !job.base.startsWith('-')
  && (job.state === 'pushed' || (job.state === 'handed_over' && job.handover?.step === null && job.continues === null));

// sf serve's pass of merged jobs. The signals of each candidate, in order; the first that says
// merged decides (signal). A merged handed_over job first goes to pushed through markHandedDone (a
// refusal leaves it for the next run, logged); then merged_on_target in its event log and the
// Archive (its Task file too). A workspace that cannot be resolved is skipped. Returns the jobs
// archived, as they were when archived (pushed).
async function archiveMerged(ports: MergedPorts, failures: Set<string>): Promise<Job[]> {
  const run: Run = { fetched: new Map(), forges: new Map() };
  const archived: Job[] = [];
  for (const job of await ports.store.jobs.list()) {
    if (!candidate(job)) {
      continue;
    }
    try {
      const workspace = await ports.settings.resolve(job.workspace).catch(() => undefined);
      const found = workspace === undefined ? undefined : await signal(ports, failures, run, job, workspace);
      if (found === undefined) {
        continue;
      }
      if (job.state === 'handed_over') {
        await ports.markHandedDone(job.workspace, job.ticket);
      }
      const marked = await logMerged(ports, job, found);
      if (marked !== undefined) {
        await ports.archive(job.workspace, job.ticket);
        archived.push(marked);
      }
    } catch (error) {
      console.error(`${job.workspace}/${job.ticket}: the pass of merged jobs failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return archived;
}

// Whether the job is merged, and how:
// 1. host, without a request: the merge request the factory recorded is merged.
// 2. host, when the workspace's forge is on: the recorded merge request (of the origin's host) the
//    host reports merged; without a record, the latest merged merge request of the job's branch
//    into its base merged at or after the job's created_at (an older job's branch of the same name
//    does not count). A host error is logged once per workspace until a host read of it works.
// Both are skipped for a job with continues.
// 3. base, for a pushed job only: one `git fetch --no-tags origin <base>` per workspace and target
//    in the work checkout under its Git lock (it moves refs/remotes/origin/<base> and FETCH_HEAD only),
//    then branchMerged (src/setup.ts): the job's tip is an ancestor of origin/<base>. A squash or
//    rebase merge is not: only the host or Merged — archive finds it. For a handed_over job no ref is
//    read and nothing fetched: its commits are the user's, and no ref shows its change on the base.
async function signal(ports: MergedPorts, failures: Set<string>, run: Run, job: Job, workspace: Workspace): Promise<Found | undefined> {
  if (job.continues === null) {
    if (job.mr?.state === 'merged') {
      return { how: 'host', mr: job.mr.number, commit: job.mr.merge_commit ?? null };
    }
    if (!run.forges.has(workspace.name)) {
      run.forges.set(workspace.name, forgeOf(ports.settings, workspace));
    }
    const forge = await run.forges.get(workspace.name);
    const found = forge === undefined ? undefined : await askHost(forge, job, workspace, failures);
    if (found !== undefined) {
      return found;
    }
  }
  if (job.state !== 'pushed') {
    return undefined;
  }
  const target = `${job.workspace}/${job.base}`;
  if (!run.fetched.has(target)) {
    run.fetched.set(target, fetchTarget(ports.locks, workspace, job.base, failures));
  }
  if (!(await run.fetched.get(target))) {
    return undefined;
  }
  const commit = await ports.locks.gitLocked(job.workspace, () => branchMerged(workspace.workCheckout, job));
  return commit === undefined ? undefined : { how: 'base', commit };
}

// The workspace's Forge when its merge requests are on (its origin's host and token), else undefined.
async function forgeOf(settings: SettingsPort, workspace: Workspace): Promise<Forge | undefined> {
  const origin = await originUrl(workspace.workCheckout).catch(() => undefined);
  return chooseForge(origin, settings.config.forge).ok ? forgeFor(origin, settings.config.forge) : undefined;
}

// Signal 2 (GET only); undefined when the host says not merged or fails, which is logged once per
// workspace until a host read of it works again.
async function askHost(forge: Forge, job: Job, workspace: Workspace, failures: Set<string>): Promise<Found | undefined> {
  const key = `${workspace.name} host`;
  // A merge request of another host than the origin's is not read (and no read clears the logged failure).
  if (job.mr !== null && job.mr.host !== forge.kind) {
    return undefined;
  }
  try {
    const found = await hostMerge(forge, job);
    failures.delete(key);
    return found;
  } catch (error) {
    if (!failures.has(key)) {
      failures.add(key);
      console.error(`${workspace.name}: the pass of merged jobs could not read ${forge.name}: ${error instanceof Error ? error.message : String(error)} Until a read works, a pushed job is checked on its base only.`);
    }
    return undefined;
  }
}

// The host's word on the job (GET only): its recorded merge request's state, else the latest merged
// merge request of its branch into its base merged at or after the job's created_at.
async function hostMerge(forge: Forge, job: Job): Promise<Found | undefined> {
  if (job.mr !== null) {
    const status = await forge.status(job.mr.number);
    return status.state === 'merged' ? { how: 'host', mr: status.number, commit: status.merge_commit ?? null } : undefined;
  }
  const created = Date.parse(job.created_at);
  const merged = (await forge.findMerged(pushedBranch(job), job.base)).find((mr) => Date.parse(mr.merged_at) >= created);
  return merged === undefined ? undefined : { how: 'host', mr: merged.number, commit: merged.merge_commit ?? null };
}

// The fetch of a target before the pass reads it; whether it worked. A failure is logged once per
// target until a fetch of it works again.
async function fetchTarget(locks: LockPort, workspace: Workspace, base: string, failures: Set<string>): Promise<boolean> {
  const key = `${workspace.name}/${base}`;
  const fetch = await locks.gitLocked(workspace.name, () => runGit(workspace.workCheckout, ['fetch', '--no-tags', 'origin', base], 1024 * 1024, FETCH_TIMEOUT_MS));
  if (fetch.code === 0) {
    failures.delete(key);
    return true;
  }
  if (!failures.has(key)) {
    failures.add(key);
    const why = fetch.code === null ? 'did not finish in time' : `failed: ${fetch.stderr.trim().slice(0, 500)}`;
    console.error(`${key}: git fetch --no-tags origin ${base} ${why}. Its pushed jobs are not checked for a merge on their base until a fetch works.`);
  }
  return false;
}

// merged_on_target in the job's event log, under the lock and only while the ticket's job is still
// this one and pushed (no new job since it was read); written once: a log that has one gets no
// second. The current job when it is marked, else undefined.
function logMerged(ports: MergedPorts, job: Job, found: Found): Promise<Job | undefined> {
  const { store, locks } = ports;
  return locks.locked(async () => {
    const current = await store.jobs.read(job.workspace, job.ticket).catch(() => undefined);
    if (current?.state !== 'pushed' || current.created_at !== job.created_at) {
      return undefined;
    }
    if (!(await mergedOnTarget(store.jobs.eventsPath(job.workspace, job.ticket)))) {
      await store.jobs.appendEvent(job.workspace, job.ticket, {
        ts: now(), iteration: current.iteration, type: 'merged_on_target', commit: found.commit, target: current.base, how: found.how, ...(found.mr !== undefined ? { mr: found.mr } : {}),
      });
    }
    return current;
  });
}
