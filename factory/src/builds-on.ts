// A part of a split ticket that builds on the part before it: `builds_on: <ticket>` in the Task's
// front matter names a ticket of the same workspace whose change is not merged yet; `base` stays the
// branch the merge request will target. While that ticket is not merged, the job starts from the
// commit its job prepared, in the workspace's checkout (nothing is fetched or pushed for it), MR
// preparation replays this part's own commit onto that ticket's current prepared commit, and Approve
// is refused: the parts are submitted one at a time, each once the one before it is merged. Once
// that ticket is merged, the job starts from, and is rebased onto, origin/<base> as any job.
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import type { Job, JobState, JobStore } from './jobs.js';
import { ticketMerged } from './setup.js';

// The states of the job a part builds on in which its prepared commit is the one to build on.
export const BUILDS_ON_STATES: readonly JobState[] = ['ready_for_human_review', 'handed_over', 'pushed'];

// The commit a part can build on: the prepared commit of the job of the ticket it builds on, in one
// of BUILDS_ON_STATES; null otherwise (no job, another state, or no prepared commit).
export function buildsOnCommit(job: Pick<Job, 'state' | 'prepared_commit'> | undefined): string | null {
  return job !== undefined && BUILDS_ON_STATES.includes(job.state) ? job.prepared_commit : null;
}

// Where a part that builds on ticket starts or is rebased onto, in the workspace whose checkout is
// checkout: merged when the ticket is merged (the part's base, as any job); else the ticket's job's
// branch and prepared commit; undefined when there is none to build on.
export async function buildsOnPoint(jobs: JobStore, workspace: string, checkout: string, ticket: string): Promise<'merged' | { ref: string; commit: string } | undefined> {
  if (await ticketMerged(jobs, { workspace, ticket }, checkout)) {
    return 'merged';
  }
  const job = await jobs.read(workspace, ticket).catch(() => undefined);
  const commit = buildsOnCommit(job);
  return job === undefined || commit === null ? undefined : { ref: job.branch, commit };
}

// The prepared commit a part builds on as a start or rebase target, in resolveTarget's form (ref:
// the branch of the ticket's job, for the prompts), once checked in checkout; base_not_found when
// the checkout does not have it.
export async function buildsOnTarget(checkout: string, point: { ref: string; commit: string }): Promise<{ ref: string; commit: string }> {
  if ((await runGit(checkout, ['rev-parse', '--verify', '--quiet', `${point.commit}^{commit}`])).code !== 0) {
    throw new FactoryError('base_not_found', `The prepared commit ${point.commit} (${point.ref}) is not in the checkout.`);
  }
  return point;
}

// The refusal of a start of ticket while the ticket it builds on has no prepared commit to build on.
export function notReadyAtStart(ticket: string, buildsOn: string): FactoryError {
  return new FactoryError('builds_on_not_ready', `${ticket} builds on ${buildsOn}, which has no prepared commit yet: start it once ${buildsOn} is ready, or queue it.`);
}

// The stop of MR preparation of ticket while the ticket it builds on has no prepared commit (the
// user asked for changes on it): retryable.
export function notReadyAtPreparation(ticket: string, buildsOn: string): FactoryError {
  return new FactoryError('builds_on_not_ready', `${ticket} builds on ${buildsOn}, which is being changed: Retry once ${buildsOn} is ready again.`);
}

// The refusal of Approve (the push, sf mr create) of ticket while the ticket it builds on is not merged.
export function notMerged(ticket: string, buildsOn: string): FactoryError {
  return new FactoryError('builds_on_not_merged', `${ticket} builds on ${buildsOn}, which is not merged yet: submit ${buildsOn} first.`);
}
