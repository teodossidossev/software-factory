// SF-309-3: the last review's comments while a job waits for the user, and the user's Send and
// Dismiss of the chosen ones (src/last-review-choices.ts), on a JobStore in a temporary state
// directory with records written by writeLastReview.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { type Job, type JobState, JobStore } from '../src/jobs.js';
import {
  CHOICES_FILE, checkLastReviewSend, dismissShownComments, lastReviewCount, lastReviewMessage, sendShownComments, SENDING_FILE, shownLastReview,
} from '../src/last-review-choices.js';
import type { LastReviewComment, LastReviewRecord } from '../src/last-review.js';
import { noteSha256 } from '../src/planner.js';
import { newEnv } from './support/harness.js';

const T0 = '2026-11-14T10:00:00.000Z';
const SKILL = { path: '/skills/review', sha256: 'b'.repeat(64), files: 1 };

function jobOf(ticket: string, state: JobState, extra: Partial<Job> = {}): Job {
  return {
    workspace: 'app', ticket, branch: `${ticket}-x`, base: 'main', continues: null, builds_on: null, builds_on_commit: null, base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state, iteration: 0, session_id: null, mr: null, created_at: T0, updated_at: T0, ...extra,
  };
}

const C1: LastReviewComment = { id: 'C1', path: 'src/app.ts', line: 12, text: 'Use formatDate of\n  src/date.ts instead of a new helper.', kind: 'change' };
const C2: LastReviewComment = { id: 'C2', path: 'src/app.ts', line: 30, text: 'Why a second cache?', kind: 'question' };
const C3: LastReviewComment = { id: 'C3', path: 'README.md', line: 1, text: 'The install steps are out of date.', kind: 'follow_up' };
const COMMENTS = [C1, C2, C3];

const success = (comments: LastReviewComment[] = COMMENTS): LastReviewRecord => ({
  reviewer: 'last_review', summary: 'Two things to raise.', comments, dropped: 0, skill: SKILL, cost_usd: 0.1, model: 'm', started_at: T0, ended_at: '2026-11-14T10:05:00.000Z',
});

async function refusedWith(work: Promise<unknown>, code: string): Promise<string> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof FactoryError, String(error));
    assert.equal(error.code, code, error.message);
    return error.message;
  }
  assert.fail(`expected ${code}`);
}

async function world(name: string, ticket: string, state: JobState = 'needs_human', iteration = 3) {
  const env = await newEnv(name);
  const jobs = new JobStore(env.state);
  await jobs.write(jobOf(ticket, state, { iteration }));
  // The iterations' directories, as a published iteration has one.
  for (const number of [1, 2, 3, 4]) {
    await mkdir(jobs.iterationDir('app', ticket, number), { recursive: true });
  }
  const read = async (): Promise<Job> => (await jobs.read('app', ticket))!;
  return { jobs, read };
}

test('LR3-1: the comments are shown only while the job waits for the user at the record\'s iteration; sent and dismissed ones are left out and counted; a failed run shows its error', async () => {
  const { jobs, read } = await world('lr-shown', 'L-1');
  // No record: no view.
  assert.equal(await shownLastReview(jobs, await read()), null);
  assert.equal(lastReviewCount(null), null);
  await jobs.writeLastReview('app', 'L-1', 3, success());
  const view = await shownLastReview(jobs, await read());
  assert.deepEqual(view, {
    iteration: 3, summary: 'Two things to raise.', comments: COMMENTS, sent: 0, dismissed: 0, error: null, timed_out: false, ended_at: '2026-11-14T10:05:00.000Z',
  });
  assert.deepEqual(lastReviewCount(view), { comments: 3 });
  for (const state of ['ready_for_human_review', 'handed_over'] as const) {
    assert.notEqual(await shownLastReview(jobs, { ...(await read()), state }), null, state);
  }
  // A job that does not wait for the user, or is at another iteration, shows none; the record stays.
  for (const job of [{ ...(await read()), state: 'working' as const }, { ...(await read()), state: 'awaiting_review' as const }, { ...(await read()), iteration: 4 }]) {
    assert.equal(await shownLastReview(jobs, job), null, `${job.state} ${job.iteration}`);
  }
  assert.notEqual(await jobs.readLastReview('app', 'L-1', 3), undefined);
  // Sent and dismissed comments are left out and counted; a choices file not of its shape is no choice.
  const choices = join(jobs.iterationDir('app', 'L-1', 3), CHOICES_FILE);
  await writeFile(choices, JSON.stringify({ sent: [{ id: 'C2', at: T0 }], dismissed: [{ id: 'C1', at: T0 }] }));
  assert.deepEqual(await shownLastReview(jobs, await read()), { ...view, comments: [C3], sent: 1, dismissed: 1 });
  for (const bad of ['not json', JSON.stringify({ sent: [{ id: 'C2' }], dismissed: [] }), JSON.stringify([])]) {
    await writeFile(choices, bad);
    assert.deepEqual(await shownLastReview(jobs, await read()), view, bad);
  }
  // One that cannot be read (a directory in its place) is no choice either, logged.
  await rm(choices);
  await mkdir(choices);
  const unreadable = mock.method(console, 'error', () => undefined);
  try {
    assert.deepEqual(await shownLastReview(jobs, await read()), view);
    assert.equal(unreadable.mock.callCount(), 1);
  } finally {
    unreadable.mock.restore();
  }
  // A failed run: its error and timed_out, nothing to send or dismiss.
  await jobs.writeLastReview('app', 'L-1', 3, { reviewer: 'last_review', error: 'The session timed out.', timed_out: true, skill: SKILL, started_at: T0, ended_at: T0 });
  assert.deepEqual(await shownLastReview(jobs, await read()), {
    iteration: 3, summary: null, comments: [], sent: 0, dismissed: 0, error: 'The session timed out.', timed_out: true, ended_at: T0,
  });
  // A last-review.json that cannot be parsed is no view, logged.
  const errors = mock.method(console, 'error', () => undefined);
  try {
    await writeFile(join(jobs.iterationDir('app', 'L-1', 3), 'last-review.json'), '{ not json');
    assert.equal(await shownLastReview(jobs, await read()), null);
    assert.equal(errors.mock.callCount(), 1);
  } finally {
    errors.mock.restore();
  }
});

test('LR3-2: the message names the iteration, then one line per comment with its place and kind, each text on one line', () => {
  assert.equal(
    lastReviewMessage(3, [C1, C3]),
    'From the last review of iteration 3:\n- `src/app.ts:12` (change): Use formatDate of src/date.ts instead of a new helper.\n- `README.md:1` (follow-up): The install steps are out of date.',
  );
  assert.equal(lastReviewMessage(1, [C2]), 'From the last review of iteration 1:\n- `src/app.ts:30` (question): Why a second cache?');
});

test('LR3-3: a Send gives the stored texts of the chosen ids, in the record\'s order, to send, then records them sent; refused Sends send nothing', async () => {
  const { jobs, read } = await world('lr-send', 'L-2');
  await jobs.writeLastReview('app', 'L-2', 3, success());
  const sending = join(jobs.dir('app', 'L-2'), SENDING_FILE);
  const said: Array<[string, unknown]> = [];
  const say = async (message: string): Promise<string> => {
    said.push([message, JSON.parse(await readFile(sending, 'utf8'))]);
    // Not recorded yet while say runs.
    assert.equal((await shownLastReview(jobs, await read()))?.comments.length, 3);
    return 'said';
  };
  assert.equal(await sendShownComments(jobs, 'app', 'L-2', 3, ['C3', 'C1'], read, say), 'said');
  const message = lastReviewMessage(3, [C1, C3]);
  assert.deepEqual(said, [[message, { sha256: noteSha256(message), iteration: 3 }]]);
  await assert.rejects(readFile(sending), { code: 'ENOENT' });
  const recorded = JSON.parse(await readFile(join(jobs.iterationDir('app', 'L-2', 3), CHOICES_FILE), 'utf8'));
  assert.deepEqual(recorded.sent.map((item: { id: string }) => item.id), ['C1', 'C3']);
  assert.deepEqual(recorded.dismissed, []);
  assert.deepEqual((await shownLastReview(jobs, await read()))?.comments, [C2]);
  said.length = 0;
  // A second Send of one of them, no ids, an unknown id, an id given twice: invalid_content.
  assert.equal(await refusedWith(sendShownComments(jobs, 'app', 'L-2', 3, ['C1'], read, say), 'invalid_content'),
    'C1 is not a comment the page can send: it was sent, dismissed or is not of this review.');
  assert.equal(await refusedWith(sendShownComments(jobs, 'app', 'L-2', 3, [], read, say), 'invalid_content'), 'Choose at least one comment.');
  await refusedWith(sendShownComments(jobs, 'app', 'L-2', 3, ['C9'], read, say), 'invalid_content');
  await refusedWith(sendShownComments(jobs, 'app', 'L-2', 3, ['C2', 'C2'], read, say), 'invalid_content');
  // Another iteration, a job that stopped waiting: invalid_state.
  assert.equal(await refusedWith(sendShownComments(jobs, 'app', 'L-2', 2, ['C2'], read, say), 'invalid_state'),
    'The job for app/L-2 shows no comments of a last review at iteration 2.');
  await jobs.write({ ...(await read()), state: 'working' });
  await refusedWith(sendShownComments(jobs, 'app', 'L-2', 3, ['C2'], read, say), 'invalid_state');
  await jobs.write({ ...(await read()), state: 'needs_human' });
  assert.deepEqual(said, []);
  // A send that throws records nothing and leaves no sending file.
  await refusedWith(sendShownComments(jobs, 'app', 'L-2', 3, ['C2'], read, async () => {
    throw new FactoryError('invalid_state', 'refused in the runner');
  }), 'invalid_state');
  await assert.rejects(readFile(sending), { code: 'ENOENT' });
  assert.deepEqual((await shownLastReview(jobs, await read()))?.comments, [C2]);
  // A message over 4000 characters is refused.
  const long = (id: string): LastReviewComment => ({ id, path: 'a.ts', line: 1, text: 'x'.repeat(1000), kind: 'change' });
  await jobs.writeLastReview('app', 'L-2', 4, success(['C1', 'C2', 'C3', 'C4'].map(long)));
  await jobs.write({ ...(await read()), iteration: 4 });
  assert.match(await refusedWith(sendShownComments(jobs, 'app', 'L-2', 4, ['C1', 'C2', 'C3', 'C4'], read, say), 'invalid_content'),
    /^The chosen comments make a message of \d+ characters, at most 4000: send fewer at once\.$/);
  assert.deepEqual(said, []);
  // Three of them fit.
  assert.equal(await sendShownComments(jobs, 'app', 'L-2', 4, ['C1', 'C2', 'C3'], read, async () => 'said'), 'said');
  assert.equal((await shownLastReview(jobs, await read()))?.comments.length, 1);
});

test('LR3-4: a Dismiss records the ids dismissed, which are no longer shown; it removes a sending file an interrupted Send left and takes the Send\'s refusals', async () => {
  const { jobs, read } = await world('lr-dismiss', 'L-3', 'handed_over', 2);
  await jobs.writeLastReview('app', 'L-3', 2, success());
  const sending = join(jobs.dir('app', 'L-3'), SENDING_FILE);
  await writeFile(sending, JSON.stringify({ sha256: 'a'.repeat(64), iteration: 2 }));
  assert.deepEqual(await dismissShownComments(jobs, 'app', 'L-3', 2, ['C2', 'C3'], read), { dismissed: 2 });
  await assert.rejects(readFile(sending), { code: 'ENOENT' });
  const view = await shownLastReview(jobs, await read());
  assert.deepEqual([view?.comments, view?.dismissed, view?.sent], [[C1], 2, 0]);
  await refusedWith(dismissShownComments(jobs, 'app', 'L-3', 2, ['C2'], read), 'invalid_content');
  await refusedWith(dismissShownComments(jobs, 'app', 'L-3', 2, [], read), 'invalid_content');
  await refusedWith(dismissShownComments(jobs, 'app', 'L-3', 1, ['C1'], read), 'invalid_state');
  // A failed run shows no comment: a Dismiss names an id it does not show.
  await jobs.writeLastReview('app', 'L-3', 2, { reviewer: 'last_review', error: 'failed', timed_out: false, skill: null, started_at: T0, ended_at: T0 });
  await refusedWith(dismissShownComments(jobs, 'app', 'L-3', 2, ['C1'], read), 'invalid_content');
});

test('LR3-5: the runner\'s check refuses the message being sent once the job no longer waits at its iteration, and lets any other message through', async () => {
  const { jobs, read } = await world('lr-check', 'L-4');
  await jobs.writeLastReview('app', 'L-4', 3, success());
  const other = 'Something of my own';
  // No Send under way: every message passes.
  await checkLastReviewSend(jobs, { ...(await read()), state: 'working' }, lastReviewMessage(3, [C1]));
  await sendShownComments(jobs, 'app', 'L-4', 3, ['C1'], read, async (message) => {
    // As sayInRunner makes it: the message passes while the job waits at iteration 3 ...
    await checkLastReviewSend(jobs, await read(), message);
    // ... and not once another message moved the job on, nor at another iteration; another message passes.
    for (const job of [{ ...(await read()), state: 'working' as const }, { ...(await read()), iteration: 4 }]) {
      assert.equal(await refusedWith(checkLastReviewSend(jobs, job, message), 'invalid_state'),
        `The job for app/L-4 is ${job.state} at iteration ${job.iteration}: it no longer waits for you at the iteration of the last review; the comments were not sent.`);
      await checkLastReviewSend(jobs, job, other);
    }
    return 'said';
  });
  // A sending file that is not JSON of its shape: no Send under way.
  await writeFile(join(jobs.dir('app', 'L-4'), SENDING_FILE), 'not json');
  await checkLastReviewSend(jobs, { ...(await read()), state: 'working' }, other);
});
