// A part of a split ticket that builds on the part before it: `builds_on: <ticket>` in the Task's
// front matter names a ticket of the same workspace whose change is not merged yet; `base` stays the
// branch the merge request will target. While that ticket is not merged, the job starts from the
// commit its job prepared, in the workspace's checkout (nothing is fetched or pushed for it), MR
// preparation replays this part's own commit onto that ticket's current prepared commit, and Approve
// is refused: the parts are submitted one at a time, each once the one before it is merged. Once
// that ticket is merged, the job starts from, and is rebased onto, origin/<base> as any job, and a
// part already prepared on it is moved onto origin/<base> by the pass of merged jobs
// (MrPart.moveInRunner).
// The Task check of a part reads the chain it builds on from the Task files (buildsOnChain): the
// texts of the tickets not merged yet go into its prompt (checkChain), and the chain's sha256 lines
// (chainLines) into the sha256 the check is stored by. Once the ticket a Task builds on has a
// prepared commit, its check reads that commit in place of the Task files (preparedPoint), and a
// check counts only while what it read of that ticket holds (buildsOnHolds).
import { createHash } from 'node:crypto';
import { mergedOnTarget } from './digest-jobs.js';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import { type Job, type JobState, JobStore } from './jobs.js';
import type { Workspace } from './registry.js';
import { ticketMerged } from './setup.js';
import { ARCHIVE_DIR, isDraft, MAX_SLICES, parseFrontMatter, readTask, TASK_DIR, taskBuildsOn, TICKET_PATTERN } from './task-file.js';

// The states of the job a part builds on in which its prepared commit is the one to build on.
export const BUILDS_ON_STATES: readonly JobState[] = ['ready_for_human_review', 'handed_over', 'pushed'];

// The commit a part can build on: the prepared commit of the job of the ticket it builds on, in one
// of BUILDS_ON_STATES; null otherwise (no job, another state, or no prepared commit).
export function buildsOnCommit(job: Pick<Job, 'state' | 'prepared_commit'> | undefined): string | null {
  return job !== undefined && BUILDS_ON_STATES.includes(job.state) ? job.prepared_commit : null;
}

// The states a part is moved onto its base from: it waits for the user's review.
export const MOVE_STATES: readonly JobState[] = ['ready_for_human_review'];

// Whether the job's change sits on the prepared commit of the ticket it builds on
// (builds_on_commit, set at the start and by every MR preparation, null once the change is on
// its base): such a part is moved onto its base once that ticket is merged
// (MrPart.moveInRunner).
export function sitsOnPart(job: Pick<Job, 'builds_on' | 'builds_on_commit'>): boolean {
  return job.builds_on !== null && job.builds_on_commit !== null;
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

// The prepared commit of the ticket a Task builds on, as a start of the Task's job takes it.
export interface PreparedPoint { ticket: string; ref: string; commit: string }

// The prepared commit of the ticket the Task text task builds on, as buildsOnPoint gives it for a
// start of the Task's job; undefined without builds_on (or with a value that is no ticket key,
// nothing read), when that ticket is merged, when it has no prepared commit to build on, or when
// its job cannot be read. Never throws.
export async function preparedPoint(stateDir: string, workspace: Workspace, task: string): Promise<PreparedPoint | undefined> {
  const ticket = textBuildsOn(task);
  if (ticket === null || !TICKET_PATTERN.test(ticket)) {
    return undefined;
  }
  const point = await buildsOnPoint(new JobStore(stateDir), workspace.name, workspace.workCheckout, ticket).catch(() => undefined);
  return point === undefined || point === 'merged' ? undefined : { ticket, ref: point.ref, commit: point.commit };
}

// Whether a check record's reading of the ticket its Task builds on (record: its builds_on) is the
// one a check would make now, by what the job store of the workspace records. Without builds_on, or
// with the first entry merged: true, nothing read. A prepared entry holds while the ticket's live
// job offers that same commit (buildsOnCommit) and its merge is not recorded (pushed with
// merged_on_target or its merge request merged); no live job (archived, merged or not), another
// commit or none, or a recorded merge end it. A sent or left_out entry holds while that job offers
// no prepared commit. The one difference from buildsOnPoint: a merge only Git shows (branchMerged,
// a job pushed without a merge request the factory knows) counts once the pass of merged jobs
// records it. Never throws.
export async function buildsOnHolds(stateDir: string, workspace: string, record: readonly BuildsOnRecord[] | undefined): Promise<boolean> {
  const first = record?.[0];
  if (first === undefined || first.how === 'merged') {
    return true;
  }
  const jobs = new JobStore(stateDir);
  const job = await jobs.read(workspace, first.ticket).catch(() => undefined);
  const commit = buildsOnCommit(job);
  if (first.how !== 'prepared') {
    return commit === null;
  }
  if (job === undefined || commit !== first.commit) {
    return false;
  }
  const merged = job.state === 'pushed' && ((await mergedOnTarget(jobs.eventsPath(workspace, first.ticket))) || job.mr?.state === 'merged');
  return !merged;
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

// A Task of the chain a Task builds on, as its check reads it.
export interface ChainTask {
  ticket: string;
  // null with problem 'missing' or 'invalid'.
  text: string | null;
  // The sha256 of text (UTF-8), hex; null when text is null.
  sha256: string | null;
  // Read from .software-factory/archive/.
  archived: boolean;
  problem: 'missing' | 'invalid' | 'draft' | null;
}
// The chain, nearest first, and what cut the walk short.
export interface TaskChain { tasks: ChainTask[]; problem: 'cycle' | 'too_long' | null }

// The ticket a Task text builds on; null without builds_on or with front matter that cannot be parsed.
function textBuildsOn(text: string): string | null {
  const fields = parseFrontMatter(text);
  return fields === undefined ? null : taskBuildsOn(fields);
}

// The Task file of ticket X for the chain: the active file, else the archived copy.
async function chainTask(workspace: Workspace, ticket: string): Promise<ChainTask> {
  const notFound = (error: unknown): boolean => error instanceof FactoryError && error.code === 'task_not_found';
  const unread = (problem: 'missing' | 'invalid'): ChainTask => ({ ticket, text: null, sha256: null, archived: false, problem });
  for (const archived of [false, true]) {
    let text: string;
    try {
      text = await readTask(workspace, ticket, archived);
    } catch (error) {
      if (notFound(error)) {
        continue;
      }
      return unread('invalid');
    }
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    return { ticket, text, sha256, archived, problem: isDraft(text) ? 'draft' : null };
  }
  return unread('missing');
}

// The chain of Tasks the Task of ticket (its text: task) builds on, followed upwards through the
// Task files of the workspace (active file first, then the archived copy) until a Task without
// builds_on, a Task that cannot be used (it ends the chain, with its problem), a ticket the chain
// already holds (cycle) or more than MAX_SLICES Tasks (too_long). Never throws; reads no file for a
// Task without builds_on.
export async function buildsOnChain(workspace: Workspace, ticket: string, task: string): Promise<TaskChain> {
  const tasks: ChainTask[] = [];
  let text = task;
  for (;;) {
    const next = textBuildsOn(text);
    if (next === null) {
      return { tasks, problem: null };
    }
    if (next === ticket || tasks.some((item) => item.ticket === next)) {
      return { tasks, problem: 'cycle' };
    }
    if (tasks.length >= MAX_SLICES) {
      return { tasks, problem: 'too_long' };
    }
    const item: ChainTask = TICKET_PATTERN.test(next)
      ? await chainTask(workspace, next).catch((): ChainTask => ({ ticket: next, text: null, sha256: null, archived: false, problem: 'invalid' }))
      : { ticket: next, text: null, sha256: null, archived: false, problem: 'invalid' };
    tasks.push(item);
    if (item.problem !== null || item.text === null) {
      return { tasks, problem: null };
    }
    text = item.text;
  }
}

// The lines of a chain in the sha256 its check is stored by: "builds_on <ticket>:<sha256>" per
// Task, in the chain's order (the problem's word for a Task that was not read), then
// "builds_on:cycle" or "builds_on:too_long" when the walk was cut short.
export function chainLines(chain: TaskChain): string[] {
  return [
    ...chain.tasks.map((item) => `builds_on ${item.ticket}:${item.sha256 ?? item.problem}`),
    ...(chain.problem === null ? [] : [`builds_on:${chain.problem}`]),
  ];
}

// The most of the <builds_on_task> blocks one check prompt takes, all together.
export const MAX_BUILDS_ON_BYTES = 128 * 1024;
// A Task of the chain in the check's prompt: text null when the cap left it out.
export type CheckChain = Array<{ ticket: string; path: string; text: string | null }>;
// How the check used a Task of the chain, for its record; prepared carries the commit the check read
// (the prepared commit of the ticket its Task builds on).
export type BuildsOnRecord =
  | { ticket: string; sha256: string | null; how: 'sent' | 'left_out' | 'merged' }
  | { ticket: string; sha256: string | null; how: 'prepared'; commit: string };

// What the Task check of ticket sends of its chain: the Tasks up to the first merged one (it and
// the ones above it are recorded merged: the repository holds their code), whole, nearest first,
// at most maxBytes of text in all; a Task that does not fit is left out (text null) and the next
// ones are still tried. A Task that cannot be used, a cycle or a chain too long is the error the
// check fails with. Never throws.
export async function checkChain(
  stateDir: string, workspace: Workspace, ticket: string, chain: TaskChain, maxBytes = MAX_BUILDS_ON_BYTES,
): Promise<{ chain: CheckChain; record: BuildsOnRecord[] } | { error: string }> {
  const jobs = new JobStore(stateDir);
  const sent: CheckChain = [];
  const record: BuildsOnRecord[] = [];
  let total = 0;
  for (const [index, item] of chain.tasks.entries()) {
    if (await ticketMerged(jobs, { workspace: workspace.name, ticket: item.ticket }, workspace.workCheckout).catch(() => false)) {
      record.push(...chain.tasks.slice(index).map((merged): BuildsOnRecord => ({ ticket: merged.ticket, sha256: merged.sha256, how: 'merged' })));
      return { chain: sent, record };
    }
    if (item.problem === 'missing') {
      return { error: `${ticket} builds on ${item.ticket}, which has no Task file.` };
    }
    if (item.problem === 'invalid' || item.text === null) {
      return { error: `${ticket} builds on ${item.ticket}, whose Task file is not valid.` };
    }
    if (item.problem === 'draft') {
      return { error: `${ticket} builds on ${item.ticket}, whose Task file is still the skeleton.` };
    }
    const path = item.archived ? `${TASK_DIR}/${ARCHIVE_DIR}/${item.ticket}.md` : `${TASK_DIR}/${item.ticket}.md`;
    const bytes = Buffer.byteLength(item.text.trimEnd(), 'utf8');
    if (total + bytes <= maxBytes) {
      total += bytes;
      sent.push({ ticket: item.ticket, path, text: item.text });
      record.push({ ticket: item.ticket, sha256: item.sha256, how: 'sent' });
    } else {
      sent.push({ ticket: item.ticket, path, text: null });
      record.push({ ticket: item.ticket, sha256: item.sha256, how: 'left_out' });
    }
  }
  if (chain.problem === 'cycle') {
    return { error: `The builds_on chain of ${ticket} comes back to a ticket it already holds: ${[ticket, ...chain.tasks.map((item) => item.ticket)].join(' → ')}.` };
  }
  if (chain.problem === 'too_long') {
    return { error: `The builds_on chain of ${ticket} is longer than ${MAX_SLICES} Tasks.` };
  }
  return { chain: sent, record };
}
