// The last review's comments (iterations/NNN/last-review.json, src/last-review.ts) while a job waits
// for the User, and the User's choice of which go back to the Implementer, as the planner's
// suggestion (src/planner.ts) is offered and sent.
// - Shown only while the job waits for the User at the iteration the last review read
//   (shownLastReview); a job that moves on shows none, and the record stays as the session wrote it.
// - Send (sendShownComments): the stored texts of the comments the page named (by id, at the
//   iteration it showed), in the record's order, as one message through say, the User's own (on a
//   handed_over job, Ask for changes). While its say runs, <job dir>/last-review-send.json says what
//   is being sent, and the job's runner refuses it where it takes the message unless the job still
//   waits for the User at the same iteration (checkLastReviewSend). The ids are recorded sent only
//   once say answered.
// - Dismiss (dismissShownComments): the ids recorded dismissed; they are no longer shown.
// - The choices: iterations/NNN/last-review-choices.json, { sent: [{id, at}], dismissed: [{id, at}] },
//   replaced atomically.
// A Send and a Dismiss of one job's comments run one at a time within the process.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import type { Job, JobStore } from './jobs.js';
import type { CommentKind, LastReviewComment, LastReviewRecord } from './last-review.js';
import { noteSha256, waits } from './planner.js';
import { MAX_USER_MESSAGE_CHARS } from './prompts.js';
import { oneLine } from './review.js';

// The choices' file in the iteration's directory, beside last-review.json.
export const CHOICES_FILE = 'last-review-choices.json';
// <job dir>/last-review-send.json while a Send's say runs: the message's sha256 and the iteration it
// was checked at. Removed when the say answered; a Dismiss removes one an interrupted Send left.
export const SENDING_FILE = 'last-review-send.json';

// What the dashboard shows of the last review of the job's iteration: a success's summary and the
// comments neither sent nor dismissed (in the record's order) with the counts of the others; a
// failure's error and timed_out, with nothing to send or dismiss.
export interface LastReviewView {
  iteration: number;
  summary: string | null;
  comments: LastReviewComment[];
  sent: number;
  dismissed: number;
  error: string | null;
  timed_out: boolean;
  ended_at: string;
}

type ChoicesJobs = Pick<JobStore, 'dir' | 'iterationDir' | 'readLastReview'>;

const SHA256 = /^[0-9a-f]{64}$/;
const choice = z.strictObject({ id: z.string(), at: z.iso.datetime() });
const choicesSchema = z.strictObject({ sent: z.array(choice), dismissed: z.array(choice) });
type Choices = z.output<typeof choicesSchema>;
const sendingSchema = z.strictObject({ sha256: z.string().regex(SHA256), iteration: z.number().int().min(1) });
type SendingRecord = z.output<typeof sendingSchema>;

const choicesPath = (jobs: Pick<JobStore, 'iterationDir'>, workspace: string, ticket: string, iteration: number): string =>
  join(jobs.iterationDir(workspace, ticket, iteration), CHOICES_FILE);
const sendingPath = (jobs: Pick<JobStore, 'dir'>, workspace: string, ticket: string): string => join(jobs.dir(workspace, ticket), SENDING_FILE);

// The tail of the work on each job's comments, keyed by the job directory: a Send and a Dismiss of
// one job run one at a time (the pattern of src/planner.ts).
const pending = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const result = (pending.get(key) ?? Promise.resolve()).then(work, work);
  const tail = result.catch(() => undefined);
  pending.set(key, tail);
  void tail.then(() => {
    if (pending.get(key) === tail) {
      pending.delete(key);
    }
  });
  return result;
}

// The file's JSON, or undefined when it is missing or not JSON.
async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch { // not JSON: read as none
    return undefined;
  }
}

// The choices of an iteration; a file that is missing, cannot be read (logged) or is not of their
// shape is no choice, so one bad file never fails a payload.
async function readChoices(jobs: Pick<JobStore, 'iterationDir'>, workspace: string, ticket: string, iteration: number): Promise<Choices> {
  let data: unknown;
  try {
    data = await readJson(choicesPath(jobs, workspace, ticket, iteration));
  } catch (error) {
    console.error(`The last review's choices of ${workspace}/${ticket} at iteration ${iteration} cannot be read: ${(error as Error).message}`);
  }
  const parsed = choicesSchema.safeParse(data);
  return parsed.success ? parsed.data : { sent: [], dismissed: [] };
}

// The record of the job's iteration; undefined without one, and for one that cannot be read or
// parsed or is of neither shape (logged), so one bad file never fails a payload.
async function readRecord(jobs: Pick<JobStore, 'readLastReview'>, job: Job): Promise<LastReviewRecord | undefined> {
  let record: LastReviewRecord | undefined;
  try {
    record = await jobs.readLastReview(job.workspace, job.ticket, job.iteration);
  } catch (error) {
    console.error(`The last review of ${job.workspace}/${job.ticket} at iteration ${job.iteration} cannot be read: ${(error as Error).message}`);
    return undefined;
  }
  if (record === undefined) {
    return undefined;
  }
  const shaped = typeof record === 'object' && record !== null && typeof record.ended_at === 'string'
    && ('error' in record ? typeof record.error === 'string' : Array.isArray(record.comments) && typeof record.summary === 'string');
  if (!shaped) {
    console.error(`The last review of ${job.workspace}/${job.ticket} at iteration ${job.iteration} is not a last review's record.`);
    return undefined;
  }
  return record;
}

// The last review the dashboard shows for the job: only while the job waits for the User and its
// iteration has a record; else null.
export async function shownLastReview(jobs: Pick<JobStore, 'iterationDir' | 'readLastReview'>, job: Job): Promise<LastReviewView | null> {
  if (!waits(job.state) || job.iteration < 1) {
    return null;
  }
  const record = await readRecord(jobs, job);
  if (record === undefined) {
    return null;
  }
  if ('error' in record) {
    return { iteration: job.iteration, summary: null, comments: [], sent: 0, dismissed: 0, error: record.error, timed_out: record.timed_out === true, ended_at: record.ended_at };
  }
  const choices = await readChoices(jobs, job.workspace, job.ticket, job.iteration);
  const sent = new Set(choices.sent.map((item) => item.id));
  const dismissed = new Set(choices.dismissed.map((item) => item.id));
  return {
    iteration: job.iteration,
    summary: record.summary,
    comments: record.comments.filter((item) => !sent.has(item.id) && !dismissed.has(item.id)),
    sent: record.comments.filter((item) => sent.has(item.id)).length,
    dismissed: record.comments.filter((item) => !sent.has(item.id) && dismissed.has(item.id)).length,
    error: null,
    timed_out: false,
    ended_at: record.ended_at,
  };
}

// The board row's count of the shown comments; null without a view.
export function lastReviewCount(view: LastReviewView | null): { comments: number } | null {
  return view === null ? null : { comments: view.comments.length };
}

// How the message writes a comment's kind.
const KIND_WORDS: Record<CommentKind, string> = { change: 'change', question: 'question', follow_up: 'follow-up' };

// The message a Send gives the Implementer: a heading line, then one line per comment, in the order given.
export function lastReviewMessage(iteration: number, comments: LastReviewComment[]): string {
  const lines = comments.map((item) => `- \`${oneLine(item.path)}:${item.line}\` (${KIND_WORDS[item.kind]}): ${oneLine(item.text)}`);
  return [`From the last review of iteration ${iteration}:`, ...lines].join('\n');
}

// The view the job shows now at the page's iteration and the comments the page chose, in the
// record's order. Refused: no view at that iteration (invalid_state); no ids, an id given twice or
// not among the shown comments (invalid_content).
async function chosen(jobs: ChoicesJobs, workspace: string, ticket: string, iteration: number, ids: string[], job: Job): Promise<LastReviewComment[]> {
  const view = await shownLastReview(jobs, job);
  if (view === null || view.iteration !== iteration) {
    throw new FactoryError('invalid_state', `The job for ${workspace}/${ticket} shows no comments of a last review at iteration ${iteration}.`);
  }
  if (ids.length === 0) {
    throw new FactoryError('invalid_content', 'Choose at least one comment.');
  }
  const shown = new Set(view.comments.map((item) => item.id));
  const seen = new Set<string>();
  for (const id of ids) {
    if (!shown.has(id) || seen.has(id)) {
      throw new FactoryError('invalid_content', `${id} is not a comment the page can send: it was sent, dismissed or is not of this review.`);
    }
    seen.add(id);
  }
  return view.comments.filter((item) => seen.has(item.id));
}

// The ids added to the iteration's choices as sent or dismissed, at the time now.
async function recordChoices(jobs: ChoicesJobs, workspace: string, ticket: string, iteration: number, choice: keyof Choices, ids: string[]): Promise<void> {
  const choices = await readChoices(jobs, workspace, ticket, iteration);
  const at = new Date().toISOString();
  choices[choice] = [...choices[choice], ...ids.map((id) => ({ id, at }))];
  await writeFileAtomic(choicesPath(jobs, workspace, ticket, iteration), Buffer.from(`${JSON.stringify(choices, null, 2)}\n`, 'utf8'));
}

// Send: in one step under the job's lock, the job read now (job), the page's ids checked against
// the comments it shows at the page's iteration, their stored texts given to send (say) as one
// message, and, once send answered, the ids recorded sent. A Dismiss waits for the whole step.
// Refused without sending: the refusals of chosen, and a message over MAX_USER_MESSAGE_CHARS
// (invalid_content). A refused or failed send records nothing; the sending file goes either way.
export function sendShownComments<T>(
  jobs: ChoicesJobs, workspace: string, ticket: string, iteration: number, ids: string[], job: () => Promise<Job>, send: (message: string) => Promise<T>,
): Promise<T> {
  return serialized(jobs.dir(workspace, ticket), async () => {
    const now = await job();
    const comments = await chosen(jobs, workspace, ticket, iteration, ids, now);
    const message = lastReviewMessage(iteration, comments);
    if (message.length > MAX_USER_MESSAGE_CHARS) {
      throw new FactoryError('invalid_content', `The chosen comments make a message of ${message.length} characters, at most ${MAX_USER_MESSAGE_CHARS}: send fewer at once.`);
    }
    // What is being sent, for the runner's check where it takes the message (checkLastReviewSend).
    const sending = sendingPath(jobs, workspace, ticket);
    const sendingRecord: SendingRecord = { sha256: noteSha256(message), iteration };
    await writeFileAtomic(sending, Buffer.from(`${JSON.stringify(sendingRecord)}\n`, 'utf8'));
    let answer: T;
    try {
      answer = await send(message);
    } finally {
      await rm(sending, { force: true });
    }
    await recordChoices(jobs, workspace, ticket, iteration, 'sent', comments.map((item) => item.id));
    return answer;
  });
}

// Dismiss: under the job's lock, a sending file an interrupted Send left removed, then the page's
// ids checked as a Send's are (chosen) and recorded dismissed; dismissed: how many this call recorded.
export function dismissShownComments(
  jobs: ChoicesJobs, workspace: string, ticket: string, iteration: number, ids: string[], job: () => Promise<Job>,
): Promise<{ dismissed: number }> {
  return serialized(jobs.dir(workspace, ticket), async () => {
    await rm(sendingPath(jobs, workspace, ticket), { force: true });
    const comments = await chosen(jobs, workspace, ticket, iteration, ids, await job());
    await recordChoices(jobs, workspace, ticket, iteration, 'dismissed', comments.map((item) => item.id));
    return { dismissed: comments.length };
  });
}

// Where the job's runner takes a message (sayInRunner, before anything changes): a message that is
// the one a Send is sending goes only while the job still waits for the User at the iteration the
// Send checked; else invalid_state and nothing is sent. Any other message passes.
export async function checkLastReviewSend(jobs: Pick<JobStore, 'dir'>, job: Job, message: string): Promise<void> {
  const sending = sendingSchema.safeParse(await readJson(sendingPath(jobs, job.workspace, job.ticket)));
  if (!sending.success || sending.data.sha256 !== noteSha256(message)) {
    return;
  }
  if (!waits(job.state) || job.iteration !== sending.data.iteration) {
    throw new FactoryError('invalid_state', `The job for ${job.workspace}/${job.ticket} is ${job.state} at iteration ${job.iteration}: it no longer waits for you at the iteration of the last review; the comments were not sent.`);
  }
}
