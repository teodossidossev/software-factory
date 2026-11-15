// My daily's factory material: the jobs of the my_work workspaces that the factory finished for me
// within the daily's two days (handed over to the checkout, pushed, or merged), current and
// archived, and which open branches of mine are live. The factory's work counts as mine, though
// I commit a hand-over later; a branch with no recent work and no job going is parked and stays out
// of the daily. And the jobs in progress now: the current ones not in a terminal state.
import { readFile, stat } from 'node:fs/promises';
import type { Span } from './digest-run.js';
import type { LiveBranch, MyCommit } from './digest.js';
import { type Job, type JobState, type JobStore, TERMINAL_STATES } from './jobs.js';
import { parseFrontMatter } from './task-file.js';

// One of my factory jobs running or waiting when the digest ran.
export interface DigestInProgress {
  workspace: string;
  app: string;
  ticket: string;
  // The Task copy's title, else the ticket.
  title: string;
  state: JobState;
  // The stop's code while needs_human, else null.
  stop_code: string | null;
  iteration: number;
  // The job's updated_at.
  since: string;
}

// The order of In progress now: waiting for the user, then running, then paused or parked.
const PROGRESS_GROUPS: ReadonlyArray<readonly JobState[]> = [
  ['needs_human', 'ready_for_human_review', 'handed_over'],
  ['starting', 'working', 'awaiting_review', 'preparing_mr'],
  ['paused', 'waiting_limit'],
];
const progressGroup = (state: JobState): number => PROGRESS_GROUPS.findIndex((group) => group.includes(state));

// The title of a job in its directory (dir): its Task copy's title, else its ticket.
async function titleOf(store: JobStore, workspace: string, dir: string, ticket: string): Promise<string> {
  const task = await store.readTaskCopy(workspace, dir).catch(() => undefined);
  return (task === undefined ? undefined : parseFrontMatter(task)?.get('title')) ?? ticket;
}

// The current jobs (jobsOf's current) not in a terminal state, as In progress rows: by group
// (PROGRESS_GROUPS), within a group oldest since first. A job's app is its workspace's, else the
// workspace's name.
export async function inProgressOf(store: JobStore, current: Job[], workspaces: ReadonlyArray<{ name: string; app: string }>): Promise<DigestInProgress[]> {
  const rows: DigestInProgress[] = [];
  for (const job of current) {
    if (TERMINAL_STATES.includes(job.state)) {
      continue;
    }
    rows.push({
      workspace: job.workspace, app: workspaces.find((workspace) => workspace.name === job.workspace)?.app ?? job.workspace,
      ticket: job.ticket, title: await titleOf(store, job.workspace, job.ticket, job.ticket), state: job.state,
      stop_code: job.state === 'needs_human' ? job.error?.code ?? null : null, iteration: job.iteration, since: job.updated_at,
    });
  }
  return rows.sort((a, b) => progressGroup(a.state) - progressGroup(b.state) || Date.parse(a.since) - Date.parse(b.since));
}

export interface DailyJob {
  workspace: string;
  ticket: string;
  // The Task's title, else the ticket.
  title: string;
  // merged: pushed, its merge request merged, or found on its target by sf serve (merged_on_target).
  state: 'handed_over' | 'pushed' | 'merged';
  // When it entered that state.
  at: string;
  branch: string;
}

type Days = { yesterday: Span; today: Span };

// done: the jobs handed over, pushed or merged within the two days; current: every current job.
export interface DailyJobs {
  done: DailyJob[];
  current: Job[];
}

export const within = (date: string, span: Span): boolean => {
  const time = Date.parse(date);
  return time >= Date.parse(span.from) && time <= Date.parse(span.to);
};
const inDays = (date: string, days: Days): boolean => within(date, days.yesterday) || within(date, days.today);

interface EventLine {
  ts?: unknown;
  type?: unknown;
  mr_state?: unknown;
  state?: { to?: unknown };
}

// The events.jsonl lines of a state change, a merge request or merged_on_target; [] when the file is
// missing or cannot be read.
async function events(path: string): Promise<EventLine[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch { // missing or unreadable: no events
    return [];
  }
  const lines: EventLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"state"') && !line.includes('"merge_request"') && !line.includes('"merged_on_target"')) {
      continue;
    }
    try {
      const record = JSON.parse(line) as unknown;
      if (typeof record === 'object' && record !== null) {
        lines.push(record as EventLine);
      }
    } catch { // a torn line: the others still count
    }
  }
  return lines;
}

// Whether a job directory's events.jsonl (path) records that sf serve's pass of merged jobs found
// its pushed commit on its target (merged_on_target): the job counts as merged.
export async function mergedOnTarget(path: string): Promise<boolean> {
  return (await events(path)).some(onTarget);
}

const onTarget = (line: EventLine): boolean => line.type === 'merged_on_target';

// The ts of the last event that matches, or undefined.
function lastTs(lines: EventLine[], matches: (line: EventLine) => boolean): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (matches(line) && typeof line.ts === 'string') {
      return line.ts;
    }
  }
  return undefined;
}

// The jobs of the workspaces: done in the order they got there; current for the live branches.
export async function jobsOf(store: JobStore, workspaces: string[], days: Days): Promise<DailyJobs> {
  const done: DailyJob[] = [];
  const current: Job[] = [];
  const since = Date.parse(days.yesterday.from);
  for (const dir of await store.listAll()) {
    const job = dir.job;
    if (job === undefined || !workspaces.includes(dir.workspace)) {
      continue;
    }
    if (!dir.archived) {
      current.push(job);
    }
    if (job.state !== 'handed_over' && job.state !== 'pushed') {
      continue;
    }
    const path = store.eventsPath(dir.workspace, dir.name);
    // A state change writes its event with the job's updated_at, so an older updated_at is an older
    // state; a merge (of the merge request, or found on the target) is an event after it: an
    // events.jsonl untouched since the two days began holds none in them.
    if (job.state === 'pushed' ? await stat(path).then((info) => info.mtimeMs < since, () => false) : Date.parse(job.updated_at) < since) {
      continue;
    }
    const lines = await events(path);
    const merged = job.state === 'pushed' && (job.mr?.state === 'merged' || lines.some(onTarget));
    const at = (merged
      ? lastTs(lines, (line) => (line.type === 'merge_request' && line.mr_state === 'merged') || onTarget(line))
      : lastTs(lines, (line) => typeof line.state === 'object' && line.state !== null && line.state.to === job.state)) ?? job.updated_at;
    if (!inDays(at, days)) {
      continue;
    }
    const title = await titleOf(store, dir.workspace, dir.name, job.ticket);
    done.push({ workspace: job.workspace, ticket: job.ticket, title, state: merged ? 'merged' : job.state, at, branch: job.branch });
  }
  return { done: done.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), current };
}

// Whether an open branch of mine (not landed) is live: a commit of mine on it within the two days,
// or a current job of the workspace on it (or continuing it) that is not failed or aborted, and,
// when pushed, whose merge request is still open (it waits for review).
export function liveBranch(branch: LiveBranch, workspace: string, myCommits: MyCommit[], current: Job[], days: Days): boolean {
  const recent = myCommits.some((commit) => (commit.ref === branch.name || commit.ref === `${branch.name} (local)`) && inDays(commit.date, days));
  return recent || current.some((job) => job.workspace === workspace && (job.branch === branch.name || job.continues === branch.name)
    && job.state !== 'failed' && job.state !== 'aborted' && (job.state !== 'pushed' || job.mr === null || job.mr.state === 'open'));
}
