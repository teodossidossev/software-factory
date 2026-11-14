// Back to the planner while a job waits for the User (the waiting trait of src/jobs.ts): the
// planner's suggestion and the planner's read of the job's result.
// - The suggestion: suggest_changes (src/server.ts) stores one note for the ticket's job in
//   <job dir>/planner-suggestion.json, replacing any earlier one; it starts nothing. It is shown
//   only while the job waits for the User at the iteration it was stored at; only the User's Send
//   on the dashboard sends it (Execution.sendSuggestion, through say), and only the note the page
//   showed (its sha256). While its say runs, <job dir>/planner-send.json says what is being sent,
//   and the job's runner refuses it where it takes the message unless the job still waits for the
//   User at the same iteration (checkSuggestionSend).
// - read_job: the job's state, its stop, and one iteration's Report and reviews, each text with the
//   job's worktree and the workspace's checkout paths replaced: a real path never reaches a client.
// A store, a Send (its check, the say and the removal, as one step) and a Dismiss of one job's
// suggestion run one at a time within the process (sf serve holds both the MCP endpoint and the
// dashboard).
import { createHash } from 'node:crypto';
import { readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import { MAX_REPORT_BYTES } from './execution/shared.js';
import { type GateRecord, type Job, type JobState, type JobStore, type ReviewRecord, statesWith } from './jobs.js';
import { MAX_USER_MESSAGE_CHARS } from './prompts.js';
import { cutBuffer, type Severity } from './review.js';

export { MAX_REPORT_BYTES };

// The suggestion's file in the job directory.
export const SUGGESTION_FILE = 'planner-suggestion.json';
// A note is one User message to the Implementer: the reviewers' cap of one.
export const MAX_NOTE_CHARS = MAX_USER_MESSAGE_CHARS;
// The states in which a job waits for the User: needs_human, ready_for_human_review, handed_over.
export const WAITING_STATES: readonly JobState[] = statesWith('waiting');

const SHA256 = /^[0-9a-f]{64}$/;
const suggestionSchema = z.strictObject({
  note: z.string(),
  sha256: z.string().regex(SHA256),
  at: z.iso.datetime(),
  // The job's iteration when it was stored: shown only while the job is still at it.
  iteration: z.number().int().min(0),
});
export type StoredSuggestion = z.output<typeof suggestionSchema>;
// What the dashboard shows of a suggestion.
export type ShownSuggestion = Pick<StoredSuggestion, 'note' | 'sha256' | 'at'>;

type SuggestionJobs = Pick<JobStore, 'read' | 'dir'>;

// The hex SHA-256 of the note's UTF-8 bytes.
export function noteSha256(note: string): string {
  return createHash('sha256').update(note, 'utf8').digest('hex');
}

export const waits = (state: JobState): boolean => WAITING_STATES.includes(state);

const suggestionPath = (jobs: Pick<JobStore, 'dir'>, workspace: string, ticket: string): string => join(jobs.dir(workspace, ticket), SUGGESTION_FILE);

// The tail of the work on each job's suggestion file: a store, a Send and a Dismiss of one job run
// one at a time.
const pending = new Map<string, Promise<unknown>>();

function serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
  const result = (pending.get(path) ?? Promise.resolve()).then(work, work);
  const tail = result.catch(() => undefined);
  pending.set(path, tail);
  void tail.then(() => {
    if (pending.get(path) === tail) {
      pending.delete(path);
    }
  });
  return result;
}

// A note the Implementer can be given: non-empty after trimming, without NUL, at most MAX_NOTE_CHARS.
export function checkNote(note: string): void {
  if (note.trim() === '' || note.includes('\0') || note.length > MAX_NOTE_CHARS) {
    throw new FactoryError('invalid_content', `The note must be non-empty text of at most ${MAX_NOTE_CHARS} characters.`);
  }
}

// suggest_changes: stores the note for the ticket's job, replacing any earlier one; refused without a
// job (job_not_found), for a job that does not wait for the User (invalid_state) and for a note the
// Implementer cannot be given (invalid_content). Starts nothing.
// The job is read under the suggestion file's lock: a store waits for a Send in progress, and then
// sees the job as that Send left it.
export function storeSuggestion(jobs: SuggestionJobs, workspace: string, ticket: string, note: string): Promise<{ stored: true; sha256: string }> {
  const path = suggestionPath(jobs, workspace, ticket);
  return serialized(path, async () => {
    const job = await jobs.read(workspace, ticket);
    if (job === undefined) {
      throw new FactoryError('job_not_found', `There is no job for ${workspace}/${ticket}.`);
    }
    if (!waits(job.state)) {
      const states = `${WAITING_STATES.slice(0, -1).join(', ')} or ${WAITING_STATES.at(-1)}`;
      throw new FactoryError('invalid_state', `The job is ${job.state}; suggest_changes needs a job that waits for the user: ${states}.`);
    }
    checkNote(note);
    const record: StoredSuggestion = { note, sha256: noteSha256(note), at: new Date().toISOString(), iteration: job.iteration };
    await rm(sendingPath(jobs, workspace, ticket), { force: true });
    await writeFileAtomic(path, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'));
    return { stored: true as const, sha256: record.sha256 };
  });
}

// The stored suggestion, or undefined without one; a file that is not one reads as none.
async function readStored(jobs: Pick<JobStore, 'dir'>, workspace: string, ticket: string): Promise<StoredSuggestion | undefined> {
  let text: string;
  try {
    text = await readFile(suggestionPath(jobs, workspace, ticket), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch { // not JSON: no suggestion
    return undefined;
  }
  const parsed = suggestionSchema.safeParse(data);
  return parsed.success && parsed.data.sha256 === noteSha256(parsed.data.note) ? parsed.data : undefined;
}

// The suggestion the dashboard shows for the job: only while the job waits for the User and is at
// the iteration the note was stored at; else null (a stale file stays until the next store).
export async function shownSuggestion(jobs: Pick<JobStore, 'dir'>, job: Job): Promise<ShownSuggestion | null> {
  if (!waits(job.state)) {
    return null;
  }
  const stored = await readStored(jobs, job.workspace, job.ticket);
  return stored === undefined || stored.iteration !== job.iteration ? null : { note: stored.note, sha256: stored.sha256, at: stored.at };
}

// Send: in one step under the suggestion file's lock, the job read now (job), the suggestion it
// shows checked against the page's sha256, the note given to send (say) and, once send answered,
// the file removed. A store or a Dismiss waits for the whole step, so the note sent is always the
// one checked and still stored. Refused without sending: no suggestion shown (no_suggestion: none,
// a job that does not wait for the User, an older iteration's), another one shown
// (suggestion_changed). A refused send leaves the file.
export function sendShownSuggestion<T>(
  jobs: Pick<JobStore, 'dir'>, workspace: string, ticket: string, sha256: string, job: () => Promise<Job>, send: (note: string) => Promise<T>,
): Promise<T> {
  const path = suggestionPath(jobs, workspace, ticket);
  return serialized(path, async () => {
    const now = await job();
    const shown = await shownSuggestion(jobs, now);
    if (shown === null) {
      throw new FactoryError('no_suggestion', `The job for ${workspace}/${ticket} shows no suggestion of the planner.`);
    }
    if (shown.sha256 !== sha256) {
      throw new FactoryError('suggestion_changed', 'The planner replaced its suggestion since the page showed it; nothing was sent. Read the new one.');
    }
    // What is being sent, for the runner's check where it takes the message (checkSuggestionSend).
    const sending = sendingPath(jobs, workspace, ticket);
    const record: SendingRecord = { sha256, iteration: now.iteration };
    await writeFileAtomic(sending, Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'));
    let answer: T;
    try {
      answer = await send(shown.note);
    } finally {
      await rm(sending, { force: true });
    }
    await rm(path, { force: true });
    return answer;
  });
}

// <job dir>/planner-send.json while a Send's say runs: the note's sha256 and the job's iteration at
// the check. Removed when the say answered; a store and a Dismiss remove one an interrupted Send left.
export const SENDING_FILE = 'planner-send.json';
const sendingSchema = z.strictObject({ sha256: z.string().regex(SHA256), iteration: z.number().int().min(0) });
type SendingRecord = z.output<typeof sendingSchema>;
const sendingPath = (jobs: Pick<JobStore, 'dir'>, workspace: string, ticket: string): string => join(jobs.dir(workspace, ticket), SENDING_FILE);

// Where the job's runner takes a message (sayInRunner, before anything changes): a message that is the
// note a Send is sending goes only while the job still waits for the User at the iteration the Send
// checked; else no_suggestion and nothing is sent (another message, the User's own, came first and
// the job works now, or it moved on). Any other message passes.
export async function checkSuggestionSend(jobs: Pick<JobStore, 'dir'>, job: Job, message: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(sendingPath(jobs, job.workspace, job.ticket), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch { // not JSON: no Send under way
    return;
  }
  const sending = sendingSchema.safeParse(data);
  if (!sending.success || sending.data.sha256 !== noteSha256(message)) {
    return;
  }
  if (!waits(job.state) || job.iteration !== sending.data.iteration) {
    throw new FactoryError('no_suggestion', `The job for ${job.workspace}/${job.ticket} is ${job.state} at iteration ${job.iteration}: it no longer waits for you at the iteration the planner's suggestion was for; the suggestion was not sent.`);
  }
}

// Dismiss: removes the suggestion's file; whether there was one.
export function removeSuggestion(jobs: Pick<JobStore, 'dir'>, workspace: string, ticket: string): Promise<boolean> {
  const path = suggestionPath(jobs, workspace, ticket);
  return serialized(path, async () => {
    await rm(sendingPath(jobs, workspace, ticket), { force: true });
    try {
      await rm(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  });
}

// A review or gate as read_job gives it: the verdict, the summary and the items, or the error of a
// failed run.
export type ReviewView =
  | { verdict: 'clean' | 'fix'; summary: string; items: Array<{ path: string; problem: string; expected: string; severity: Severity }> }
  | { error: string };

export interface ReadJobAnswer {
  state: JobState;
  iteration: number;
  shown_iteration: number;
  stop: { code: string; message: string } | null;
  report: string | null;
  report_truncated: boolean;
  review: ReviewView | null;
  gate: ReviewView | null;
}

// The real paths read_job hides: the job's worktree as <worktree> (as recorded, and where the
// factory puts it, worktreeDir: the record is null after Clean; each also resolved), the
// workspace's checkout as <checkout>; the longest first, so a path inside another is replaced whole.
async function pathHider(job: Job, checkout: string, worktreeDir: string | undefined): Promise<(text: string) => string> {
  const pairs: Array<[string, string]> = [[checkout, '<checkout>']];
  for (const worktree of [job.worktree, worktreeDir]) {
    if (worktree === null || worktree === undefined) {
      continue;
    }
    pairs.push([worktree, '<worktree>']);
    const real = await realpath(worktree).catch(() => undefined);
    if (real !== undefined) {
      pairs.push([real, '<worktree>']);
    }
  }
  const sorted = pairs.filter(([path]) => path !== '').sort(([a], [b]) => b.length - a.length);
  return (text) => sorted.reduce((result, [path, label]) => result.split(path).join(label), text);
}

function reviewView(record: ReviewRecord | GateRecord | undefined, hide: (text: string) => string): ReviewView | null {
  if (record === undefined) {
    return null;
  }
  if (!('verdict' in record)) {
    return { error: hide(record.error) };
  }
  return {
    verdict: record.verdict,
    summary: hide(record.summary),
    items: record.items.map((item) => ({ path: hide(item.path), problem: hide(item.problem), expected: hide(item.expected), severity: item.severity ?? 'major' })),
  };
}

// read_job: the job's state and iteration, its stop while needs_human, and one iteration's Report
// (at most MAX_REPORT_BYTES, cut on a character boundary after the paths are replaced) and reviews,
// read only from the job's directory. iteration: 1..the job's iteration, default its last; 0 when it
// has none yet. Refused: no job (job_not_found), an iteration outside the range (invalid_iteration).
// worktreeRoot: where the factory puts the jobs' worktrees (Config.worktreeRoot).
export async function readJob(
  jobs: JobStore, workspace: { name: string; readCheckout: string }, ticket: string, iteration: number | undefined, worktreeRoot: string | undefined,
): Promise<ReadJobAnswer> {
  const job = await jobs.read(workspace.name, ticket);
  if (job === undefined) {
    throw new FactoryError('job_not_found', `There is no job for ${workspace.name}/${ticket}.`);
  }
  if (iteration !== undefined && (!Number.isInteger(iteration) || iteration < 1 || iteration > job.iteration)) {
    throw new FactoryError('invalid_iteration', job.iteration === 0
      ? `The job for ${workspace.name}/${ticket} has no iteration yet.`
      : `iteration must be 1 to ${job.iteration} for ${workspace.name}/${ticket}.`);
  }
  const hide = await pathHider(job, workspace.readCheckout, worktreeRoot === undefined ? undefined : join(worktreeRoot, workspace.name, ticket));
  const shown = iteration ?? job.iteration;
  const stop = job.state === 'needs_human' && job.error !== undefined ? { code: job.error.code, message: hide(job.error.message) } : null;
  const answer: ReadJobAnswer = { state: job.state, iteration: job.iteration, shown_iteration: shown, stop, report: null, report_truncated: false, review: null, gate: null };
  if (shown === 0) {
    return answer;
  }
  let text: string | undefined;
  try {
    text = await readFile(join(jobs.iterationDir(workspace.name, ticket, shown), 'report.md'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (text !== undefined) {
    const bytes = Buffer.from(hide(text), 'utf8');
    answer.report_truncated = bytes.length > MAX_REPORT_BYTES;
    answer.report = answer.report_truncated ? cutBuffer(bytes, MAX_REPORT_BYTES) : bytes.toString('utf8');
  }
  answer.review = reviewView(await jobs.readReview(workspace.name, ticket, shown), hide);
  answer.gate = reviewView(await jobs.readGate(workspace.name, ticket, shown), hide);
  return answer;
}
