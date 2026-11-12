// A running job's progress for the board and the job page: the steps the Implementer keeps in
// .software-factory/<ticket>.steps.md of its worktree (a checklist, read where it is, never copied),
// the phase the job is in, and when it is likely ready: a range from the history of the finished
// jobs' iterations (their meta.json, review.json and gate.json, and the MR text's span in
// events.jsonl), recomputed at most once an hour. Read-only.
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeReviews, type Job, type JobDir, type JobStore, statesWith, TERMINAL_STATES } from './jobs.js';
import { TASK_DIR } from './task-file.js';

// The steps file is read up to this size; each step's text is cut to STEP_CHARS.
const MAX_STEPS_BYTES = 64 * 1024;
const STEP_CHARS = 200;
// The history is read again after this long; a workspace with fewer finished jobs than
// MIN_JOBS is estimated from every workspace's.
export const HISTORY_TTL_MS = 60 * 60_000;
export const MIN_JOBS = 10;
// Finished: ended (pushed, aborted, failed) or ready for the user (ready_for_human_review,
// handed_over); every iteration such a job has is over.
const FINISHED = [...TERMINAL_STATES, ...statesWith('ready')];

export const PHASES = ['code', 'claude', 'codex', 'mr_text'] as const;
export type Phase = (typeof PHASES)[number];

export interface Step {
  text: string;
  done: boolean;
}

// The worktree-relative path of a job's steps file; under TASK_DIR, so it never reaches the Patch,
// the commit or a review (src/patch.ts leaves TASK_DIR out).
export function stepsPath(ticket: string): string {
  return `${TASK_DIR}/${ticket}.steps.md`;
}

// The checklist lines of a steps file, in order: "- [ ] step" open, "- [x] step" done (also with
// * or +, an X, and indented); every other line is ignored, and there is no upper count.
export function parseSteps(text: string): Step[] {
  const steps: Step[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*+]\s+\[([ xX])\]\s+(\S.*?)\s*$/.exec(line);
    if (match !== null) {
      const words = match[2]!;
      steps.push({ text: words.length > STEP_CHARS ? `${words.slice(0, STEP_CHARS - 1)}…` : words, done: match[1] !== ' ' });
    }
  }
  return steps;
}

// The steps of a job from its worktree's steps file: none without a worktree, without the file, or
// when it is not a regular file (a link is not followed) or cannot be read.
export async function readSteps(worktree: string | null, ticket: string): Promise<Step[]> {
  if (worktree === null) {
    return [];
  }
  let handle;
  try {
    handle = await open(join(worktree, stepsPath(ticket)), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch { // missing, a link or unreadable: no steps
    return [];
  }
  try {
    if (!(await handle.stat()).isFile()) {
      return [];
    }
    const buffer = Buffer.alloc(MAX_STEPS_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_STEPS_BYTES, 0);
    return parseSteps(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { // a read error: no steps
    return [];
  } finally {
    await handle.close();
  }
}

export interface Spread {
  p25: number;
  median: number;
  p75: number;
}

// The p25, median and p75 of some durations (ms), interpolated between the sorted values; null of none.
export function spread(values: readonly number[]): Spread | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => {
    const position = (sorted.length - 1) * q;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
  };
  return { p25: at(0.25), median: at(0.5), p75: at(0.75) };
}

// What the estimate reads of the history, in ms: a working turn's spread, the medians of the Claude
// review, the Codex gate and the MR text; null where the history has none.
export interface Durations {
  working: Spread | null;
  claude: number | null;
  codex: number | null;
  mr_text: number | null;
}

// The durations (ms) of one or more finished jobs, per kind.
interface Samples {
  working: number[];
  claude: number[];
  codex: number[];
  mr_text: number[];
}

// A record's ended_at − started_at in ms; null when either is missing or it is negative.
const span = (record: { started_at?: unknown; ended_at?: unknown } | undefined): number | null => {
  const ms = Date.parse(String(record?.ended_at)) - Date.parse(String(record?.started_at));
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

// The durations of one finished job: per iteration its working turn (meta.json), its Claude review
// (review.json with a verdict) and its gate (gate.json); each span of preparing_mr up to the next
// state change in events.jsonl. A file that is missing or cannot be read is skipped.
async function jobSamples(jobs: JobStore, dir: JobDir & { job: Job }): Promise<Samples> {
  const samples: Samples = { working: [], claude: [], codex: [], mr_text: [] };
  const add = (list: number[], ms: number | null): void => {
    if (ms !== null) {
      list.push(ms);
    }
  };
  const quiet = <T>(read: () => Promise<T>): Promise<T | undefined> => read().catch(() => undefined);
  for (let number = 1; number <= dir.job.iteration; number += 1) {
    add(samples.working, span(await quiet(() => jobs.readMeta(dir.workspace, dir.name, number))));
    const review = await quiet(() => jobs.readReview(dir.workspace, dir.name, number));
    add(samples.claude, review !== undefined && 'verdict' in review ? span(review) : null);
    add(samples.codex, span(await quiet(() => jobs.readGate(dir.workspace, dir.name, number))));
  }
  const text = await quiet(() => readFile(jobs.eventsPath(dir.workspace, dir.name), 'utf8'));
  let since: number | null = null;
  for (const line of (text ?? '').split('\n')) {
    if (!line.includes('"state":{')) {
      continue;
    }
    let record: { ts?: unknown; state?: { to?: unknown } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch { // a cut line: not a state change
      continue;
    }
    const at = Date.parse(String(record.ts));
    if (record.state === undefined || record.state === null || Number.isNaN(at)) {
      continue;
    }
    if (since !== null) {
      add(samples.mr_text, at - since);
    }
    since = record.state.to === 'preparing_mr' ? at : null;
  }
  return samples;
}

// The durations of the jobs' samples together: the working turn's spread, the other medians.
function durationsOf(all: readonly Samples[]): Durations {
  const flat = (key: keyof Samples): number[] => all.flatMap((samples) => samples[key]);
  const median = (key: keyof Samples): number | null => spread(flat(key))?.median ?? null;
  return { working: spread(flat('working')), claude: median('claude'), codex: median('codex'), mr_text: median('mr_text') };
}

// The durations of the history per workspace, read from every finished job of the store at most
// once per HISTORY_TTL_MS (one read at a time); a workspace with fewer than MIN_JOBS finished jobs
// gets every workspace's.
export class History {
  #read: { at: number; samples: Promise<Map<string, Samples[]>> } | undefined;

  constructor(private readonly jobs: JobStore, private readonly clock: () => number = Date.now) {}

  async of(workspace: string): Promise<Durations> {
    const now = this.clock();
    if (this.#read === undefined || now - this.#read.at >= HISTORY_TTL_MS) {
      // A failed read gives no history, and the next call reads again.
      this.#read = { at: now, samples: this.#samples().catch((error: unknown) => {
        console.error(error);
        this.#read = undefined;
        return new Map<string, Samples[]>();
      }) };
    }
    const byWorkspace = await this.#read.samples;
    const own = byWorkspace.get(workspace) ?? [];
    return durationsOf(own.length >= MIN_JOBS ? own : [...byWorkspace.values()].flat());
  }

  async #samples(): Promise<Map<string, Samples[]>> {
    const byWorkspace = new Map<string, Samples[]>();
    for (const dir of await this.jobs.listAll()) {
      if (dir.job !== undefined && FINISHED.includes(dir.job.state)) {
        byWorkspace.set(dir.workspace, [...(byWorkspace.get(dir.workspace) ?? []), await jobSamples(this.jobs, { ...dir, job: dir.job })]);
      }
    }
    return byWorkspace;
  }
}

// One History per job store, so every payload of a dashboard shares its hourly read.
const histories = new WeakMap<JobStore, History>();
export function historyOf(jobs: JobStore): History {
  let history = histories.get(jobs);
  if (history === undefined) {
    history = new History(jobs);
    histories.set(jobs, history);
  }
  return history;
}

// The factory's own history when this estimate was planned (316 iterations: a working turn p25 10,
// median 19, p75 32 min; a review about 2 min; the MR text about 1 min): the durations the estimate
// starts from while the store's history has no working turn yet.
const MINUTE = 60_000;
const BASE_WORKING: Spread = { p25: 10 * MINUTE, median: 19 * MINUTE, p75: 32 * MINUTE };
export const BASE_DURATIONS: Durations = { working: BASE_WORKING, claude: 2 * MINUTE, codex: 2 * MINUTE, mr_text: MINUTE };

// A running job's progress (times ISO).
export interface Progress {
  steps: Step[];
  phase: Phase;
  fix_round: number;
  ready_from: string;
  ready_to: string;
}

// The phase of a job, null for one that does not run (waiting_limit and paused included): starting
// and working code; awaiting_review the Claude review while it runs on the job and the iteration has
// no verdict of it yet, else the Codex gate; preparing_mr the MR text.
export function phaseOf(job: Pick<Job, 'state' | 'claude_review'>, claudeDone: boolean): Phase | null {
  switch (job.state) {
    case 'starting':
    case 'working':
      return 'code';
    case 'awaiting_review':
      return claudeReviews(job) && !claudeDone ? 'claude' : 'codex';
    case 'preparing_mr':
      return 'mr_text';
    default:
      return null;
  }
}

// The progress of a job, null when it does not run. done: whether the current iteration has the
// Claude review's and the gate's verdict. Remaining from = the part of the steps left (all with no
// steps, none past code) × a working turn's p25, plus the medians of the reviews still ahead and of
// the MR text; to = the same with the p75, plus one fix round (a working turn's median and the
// medians of the job's reviews) while none has happened. A history without a working turn gives
// BASE_DURATIONS.
export function progressOf(job: Pick<Job, 'state' | 'claude_review' | 'fixes'>, input: { steps: Step[]; done: { claude: boolean; codex: boolean }; durations: Durations; now: number }): Progress | null {
  const { steps, done, now } = input;
  const durations = input.durations.working === null ? BASE_DURATIONS : input.durations;
  const phase = phaseOf(job, done.claude);
  if (phase === null) {
    return null;
  }
  const working = input.durations.working ?? BASE_WORKING;
  const claude = durations.claude ?? 0;
  const codex = durations.codex ?? 0;
  const left = phase !== 'code' ? 0 : steps.length === 0 ? 1 : steps.filter((step) => !step.done).length / steps.length;
  const ahead = (phase === 'code' || phase === 'claude' ? (claudeReviews(job) ? claude : 0) : 0)
    + (phase === 'code' || phase === 'claude' || (phase === 'codex' && !done.codex) ? codex : 0)
    + (durations.mr_text ?? 0);
  const fixRound = job.fixes === 0 ? working.median + (claudeReviews(job) ? claude : 0) + codex : 0;
  const at = (ms: number): string => new Date(now + Math.round(ms)).toISOString();
  return {
    steps, phase, fix_round: job.fixes,
    ready_from: at(left * working.p25 + ahead),
    ready_to: at(left * working.p75 + ahead + fixRound),
  };
}
