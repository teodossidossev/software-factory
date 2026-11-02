// What `sf status` derives for display from a Job and its published iterations: the recorded cost
// (an estimate of the API-equivalent price, not a charge) and the elapsed wall-clock time. Nothing here is persisted; the Job schema and meta.json stay as
// they are.
import { type Job, type JobStore, TERMINAL_STATES } from './jobs.js';

export interface StatusRow {
  job: Job;
  // The recorded cost in USD with four decimals, or "unknown"; an estimate, shown as EST_USD.
  cost: string;
  // The elapsed time as HH:MM:SS.
  elapsed: string;
}

// Whole seconds from created_at to now, or to updated_at (the last state change) once the job is
// terminal, so a finished job stops counting. Waiting for review, the user or MR preparation counts.
// A negative difference (clock skew) is zero.
export function elapsedSeconds(job: Job, now: Date): number {
  const end = TERMINAL_STATES.includes(job.state) ? Date.parse(job.updated_at) : now.getTime();
  return Math.max(0, Math.floor((end - Date.parse(job.created_at)) / 1000));
}

// HH:MM:SS with at least two hour digits; hours go beyond 23.
export function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secondsLeft = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secondsLeft).padStart(2, '0')}`;
}

export function formatCost(cost: number | undefined): string {
  return cost === undefined ? 'unknown' : cost.toFixed(4);
}

// The rows of the status table; now is captured once by the caller so every row shares it.
export async function statusRows(jobs: JobStore, list: Job[], now: Date): Promise<StatusRow[]> {
  const rows: StatusRow[] = [];
  for (const job of list) {
    rows.push({ job, cost: formatCost(await jobs.recordedCost(job.workspace, job.ticket, job.iteration)), elapsed: formatElapsed(elapsedSeconds(job, now)) });
  }
  return rows;
}
