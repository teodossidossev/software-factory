// A job's lead time and where it went: from its first state change to its push (or its merged
// merge request), split into the time the agents worked on it, the time it waited for the user, the
// time it lay in the user's checkout and the time it was parked, against the target of the
// workspace's norms for the Task's size (src/norms.ts). Read from the history of the job's detail
// (src/dashboard-payloads.ts): the state changes and merge request records of its events.jsonl.
import { norms } from './norms.js';
import { type JobState, type JobStore, statesWith, TERMINAL_STATES } from './jobs.js';
import { parseFrontMatter, type TaskSize, taskSize } from './task-file.js';

export type LeadPart = 'working' | 'waiting_for_user' | 'in_user_hands' | 'parked';

// The states of each part. The terminal states (pushed, aborted, failed) end the clock and are in
// none; a state of no part (a name this factory does not know) counts nowhere. Not the `waiting`
// trait of src/jobs.ts: a handed_over job is in the user's hands, apart from the waits for the user.
export const LEAD_PARTS: Readonly<Record<LeadPart, readonly JobState[]>> = Object.freeze({
  working: ['starting', 'working', 'awaiting_review', 'preparing_mr'],
  waiting_for_user: ['needs_human', 'ready_for_human_review'],
  in_user_hands: ['handed_over'],
  parked: ['paused', 'waiting_limit'],
});

const PART_OF: ReadonlyMap<string, LeadPart> = new Map(
  (Object.entries(LEAD_PARTS) as Array<[LeadPart, readonly JobState[]]>).flatMap(([part, states]) => states.map((state) => [state, part] as const)),
);
// As strings: the history's states are the log's, not checked against JobState.
const READY_STATES: readonly string[] = statesWith('ready');
const ENDING_STATES: readonly string[] = TERMINAL_STATES;
const PARTS = Object.keys(LEAD_PARTS) as LeadPart[];

// An entry of the detail's history: a state change has `to`; a merge request record has
// `event: 'merge_request'` and `state` (its mr_state). Any other entry is ignored.
export interface LeadEvent { ts: string; to?: string; event?: string; state?: string }

export interface LeadClock {
  started_at: string | null;
  ready_at: string | null;
  done_at: string | null;
  // Whole seconds; total is the sum of the four parts.
  seconds: Record<LeadPart | 'total', number>;
  // The changes back to working right after a change to a ready state (statesWith('ready')).
  returns: number;
  over_target: boolean;
}

// The clock of a job from its history in log order, now for a clock still running. It ends at the
// first change to a terminal state or the first merged merge request record; later entries are
// ignored (after a merged record before any state change, the clock is the empty one). An entry
// whose ts is not a date is skipped; a time going backwards counts as none.
export function leadTime(events: readonly LeadEvent[], now: Date, targetHours: number): LeadClock {
  const millis: Record<LeadPart, number> = { working: 0, waiting_for_user: 0, in_user_hands: 0, parked: 0 };
  let startedAt: string | null = null;
  let readyAt: string | null = null;
  let doneAt: string | null = null;
  let returns = 0;
  // The state of the open interval and when it began; undefined before the first state change.
  let current: string | undefined;
  let since = 0;
  let ended = false;
  const close = (at: number): void => {
    const part = current === undefined ? undefined : PART_OF.get(current);
    if (part !== undefined) {
      millis[part] += Math.max(0, at - since);
    }
  };
  for (const event of events) {
    const at = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN;
    if (Number.isNaN(at)) {
      continue;
    }
    if (typeof event.to === 'string') {
      if (startedAt === null) {
        startedAt = event.ts;
      } else {
        close(at);
      }
      if (event.to === 'working' && current !== undefined && READY_STATES.includes(current)) {
        returns += 1;
      }
      if (readyAt === null && READY_STATES.includes(event.to)) {
        readyAt = event.ts;
      }
      current = event.to;
      since = at;
      if (ENDING_STATES.includes(event.to)) {
        doneAt = event.to === 'pushed' ? event.ts : null;
        ended = true;
        break;
      }
    } else if (event.event === 'merge_request' && event.state === 'merged') {
      // Before any state change there is no clock: it stays empty (no state change, the times null).
      if (startedAt !== null) {
        close(at);
        doneAt = event.ts;
      }
      ended = true;
      break;
    }
  }
  if (!ended && startedAt !== null) {
    close(now.getTime());
  }
  const seconds = { working: 0, waiting_for_user: 0, in_user_hands: 0, parked: 0, total: 0 };
  for (const part of PARTS) {
    seconds[part] = Math.round(millis[part] / 1000);
    seconds.total += seconds[part];
  }
  return { started_at: startedAt, ready_at: readyAt, done_at: doneAt, seconds, returns, over_target: seconds.total > targetHours * 3600 };
}

export type JobLead = { size: TaskSize; target_hours: number } & LeadClock;

// The lead of a job: its size from its own copy of the Task file (medium without a readable one),
// the target of the workspace's norms in normsDir (configDir() of src/registry.ts), and the clock of
// events. name: the job directory's name. Never throws.
export async function jobLead(jobs: JobStore, workspace: string, name: string, events: readonly LeadEvent[], normsDir: string, now = new Date()): Promise<JobLead> {
  let size: TaskSize = 'medium';
  try {
    const copy = await jobs.readTaskCopy(workspace, name);
    const fields = copy === undefined ? undefined : parseFrontMatter(copy);
    if (fields !== undefined) {
      size = taskSize(fields);
    }
  } catch { // an unreadable copy: medium
  }
  // norms never throws: a bad or missing file is the defaults.
  const targetHours = (await norms(workspace, normsDir)).norms.lead_time_hours[size];
  return { size, target_hours: targetHours, ...leadTime(events, now, targetHours) };
}
