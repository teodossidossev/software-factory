// The Archive of a finished job with its active Task file, and sf serve's pass of merged jobs: the
// helpers of ControlPart's archiveFinished and archiveMergedJobs. The Archive is reset for a
// finished job (the branch and its commits stay); with an active Task file it is Setup's ticket
// archive (SettingsPort.archiveTicket), which moves the Task file to the archive too.
import { join } from 'node:path';
import { runGit } from '../git.js';
import { type Job, now } from '../jobs.js';
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

// The state of sf serve's pass of merged jobs across its runs (ControlPart holds one): the targets
// whose failed fetch was logged, and whether a run is under way; a run started meanwhile does
// nothing and returns no job.
export class MergedPass {
  readonly #failures = new Set<string>();
  #running = false;

  async run(ports: PassPorts, archive: (job: Job) => Promise<unknown>): Promise<Job[]> {
    if (this.#running) {
      return [];
    }
    this.#running = true;
    try {
      return await archiveMerged(ports, this.#failures, archive);
    } finally {
      this.#running = false;
    }
  }
}

type PassPorts = { store: JobStorePort; locks: LockPort; settings: SettingsPort };

// sf serve's pass of merged jobs: every pushed job without a merge request, or with a closed one,
// whose commit is on its target's history. Per workspace and target (the job's base), one
// `git fetch --no-tags origin <base>` in the workspace's work checkout under its Git lock: it
// moves refs/remotes/origin/<base> (and FETCH_HEAD) only, never a branch, the index or a file of
// the checkout. Then branchMerged (src/setup.ts) reads, without a change, whether the job's tip is
// an ancestor of origin/<base>; a squash or rebase merge is not, and the Archive covers it. A merged
// job gets merged_on_target in its event log, then archive (the Archive, its Task file too). A
// fetch that fails leaves the jobs of its target alone and is logged once (failures: the targets
// logged) until a fetch of it works again. A workspace that cannot be resolved is skipped. Returns
// the jobs archived.
async function archiveMerged(ports: PassPorts, failures: Set<string>, archive: (job: Job) => Promise<unknown>): Promise<Job[]> {
  const { store, locks, settings } = ports;
  const fetched = new Map<string, Promise<boolean>>();
  const archived: Job[] = [];
  for (const job of await store.jobs.list()) {
    if (job.state !== 'pushed' || (job.mr !== null && job.mr.state !== 'closed') || job.base.startsWith('-')) {
      continue;
    }
    try {
      const workspace = await settings.resolve(job.workspace).catch(() => undefined);
      if (workspace === undefined) {
        continue;
      }
      const target = `${job.workspace}/${job.base}`;
      if (!fetched.has(target)) {
        fetched.set(target, fetchTarget(locks, workspace, job.base, failures));
      }
      if (!(await fetched.get(target))) {
        continue;
      }
      const commit = await locks.gitLocked(job.workspace, () => branchMerged(workspace.workCheckout, job));
      if (commit !== undefined && (await logMerged(store, locks, job, commit))) {
        await archive(job);
        archived.push(job);
      }
    } catch (error) {
      console.error(`${job.workspace}/${job.ticket}: the pass of merged jobs failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return archived;
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
    console.error(`${key}: git fetch --no-tags origin ${base} ${why}. Its pushed jobs are not checked for a merge until a fetch works.`);
  }
  return false;
}

// merged_on_target in the job's event log, under the lock and only while the ticket's job is still
// this pushed one (no new job since the pass read it); whether it was written.
function logMerged(store: JobStorePort, locks: LockPort, job: Job, commit: string): Promise<boolean> {
  return locks.locked(async () => {
    const current = await store.jobs.read(job.workspace, job.ticket).catch(() => undefined);
    if (current?.state !== 'pushed' || current.created_at !== job.created_at) {
      return false;
    }
    await store.jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration: job.iteration, type: 'merged_on_target', commit, target: job.base });
    return true;
  });
}
