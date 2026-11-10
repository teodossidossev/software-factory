// My daily's factory material: the jobs of the my_work workspaces that the factory finished for me
// within the daily's two days (handed over to the checkout, pushed, or merged), current and
// archived, and which open branches of mine are live. The factory's work counts as mine, though
// I commit a hand-over later; a branch with no recent work and no job going is parked and stays out
// of the daily.
import { readFile, stat } from 'node:fs/promises';
import type { Span } from './digest-run.js';
import type { LiveBranch, MyCommit } from './digest.js';
import type { Job, JobStore } from './jobs.js';
import { parseFrontMatter } from './task-file.js';

export interface DailyJob {
  workspace: string;
  ticket: string;
  // The Task's title, else the ticket.
  title: string;
  // merged: pushed, its merge request merged.
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

// The events.jsonl lines of a state change or a merge request; [] when the file is missing or
// cannot be read.
async function events(path: string): Promise<EventLine[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const lines: EventLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"state"') && !line.includes('"merge_request"')) {
      continue;
    }
    try {
      const record = JSON.parse(line) as unknown;
      if (typeof record === 'object' && record !== null) {
        lines.push(record as EventLine);
      }
    } catch {
      // A torn line: the others still count.
    }
  }
  return lines;
}

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
    const merged = job.state === 'pushed' && job.mr?.state === 'merged';
    const path = store.eventsPath(dir.workspace, dir.name);
    // A state change writes its event with the job's updated_at, so an older updated_at is an older
    // state; a merge is an event after it: an events.jsonl untouched since the two days began holds
    // none in them.
    if (merged ? await stat(path).then((info) => info.mtimeMs < since, () => false) : Date.parse(job.updated_at) < since) {
      continue;
    }
    const lines = await events(path);
    const at = (merged
      ? lastTs(lines, (line) => line.type === 'merge_request' && line.mr_state === 'merged')
      : lastTs(lines, (line) => typeof line.state === 'object' && line.state !== null && line.state.to === job.state)) ?? job.updated_at;
    if (!inDays(at, days)) {
      continue;
    }
    const task = await store.readTaskCopy(dir.workspace, dir.name).catch(() => undefined);
    const title = (task === undefined ? undefined : parseFrontMatter(task)?.get('title')) ?? job.ticket;
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
