// SF-208 end to end through sf serve: the planner's suggest_changes stores a note and starts
// nothing; the dashboard's job payloads carry the planner block while the job waits for the user;
// a stale or replaced suggestion is never sent; Send gives the shown note to say, the same path as
// the user's own message (on a handed_over job, Ask for changes), and Dismiss removes it. The
// fake Claude Code is the Implementer; everything is in temp directories.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { noteSha256, SENDING_FILE, SUGGESTION_FILE } from '../src/planner.js';
import { act, fetchRaw, type Reply } from './support/dashboard-client.js';
import { call, fakeLog, jobPrompt, putTask, refused, script, stop, waitFor } from './support/harness.js';
import { exists, head, job, mrTurn, setup, worktreeOf } from './support/handoff.js';

const error = (reply: Reply): { status: number; code: string } => ({ status: reply.status, code: JSON.parse(reply.body).error.code });
const result = (reply: Reply): Record<string, any> => {
  assert.equal(reply.status, 200, reply.body);
  return JSON.parse(reply.body).result;
};

test('suggest_changes stores a note and starts nothing; the payloads show it while the job waits at its iteration; Send of a stale or replaced note is refused, Send of the shown one is the user\'s message (Ask for changes on handed_over); Dismiss', async () => {
  const s = await setup('planner-flow');
  await script(s.env, [
    { delayMs: 2500, write: { 'README.md': 'job readme\n' }, text: 'iteration 1' },
    mrTurn('P-1'),
    { write: { 'second.txt': 'second\n' }, text: 'iteration 2 after the suggestion' },
  ]);
  try {
    const base = s.served.dashboard!;
    const detail = async (): Promise<Record<string, any>> => JSON.parse((await fetchRaw(new URL('api/jobs/app/P-1', base))).body).job;
    await putTask(s.env, s.repo, 'P-1', 'Hand it over');
    // The planner's note before the job waits: refused while its first (slow) turn runs.
    await call(s.served, 'start', { workspace: 'app', ticket: 'P-1' });
    const early = await refused(s.served, 'suggest_changes', { workspace: 'app', ticket: 'P-1', note: 'too early' });
    assert.match(early.message, /^The job is (starting|working); suggest_changes needs a job that waits for the user/);
    assert.equal((await detail()).planner.discuss, null);
    await waitFor(s.served, 'P-1', 'awaiting_review', 1);
    await call(s.served, 'mark_clean', { workspace: 'app', ticket: 'P-1' });
    await waitFor(s.served, 'P-1', 'handed_over');
    const file = join(s.jobs.dir('app', 'P-1'), SUGGESTION_FILE);

    // handed_over at iteration 1: the Discuss link and no suggestion yet.
    let planner = (await detail()).planner;
    assert.equal(planner.chat, null);
    assert.equal(planner.suggestion, null);
    assert.match(planner.discuss.message, /^Use the Software Factory connector\. Call guide\. This conversation is about the result of ticket P-1 in workspace app/);
    assert.equal(planner.discuss.url, `https://chatgpt.com/?q=${encodeURIComponent(planner.discuss.message)}`);

    // A stale note (stored at another iteration) is not shown and cannot be sent.
    const stale = 'An old note';
    await writeFile(file, JSON.stringify({ note: stale, sha256: noteSha256(stale), at: new Date().toISOString(), iteration: 0 }));
    assert.equal((await detail()).planner.suggestion, null);
    assert.deepEqual(error(await act(base, 'api/jobs/app/P-1/suggestion-send', { sha256: noteSha256(stale) })), { status: 409, code: 'no_suggestion' });

    // The planner stores one, then replaces it: the page drew the first, so its Send is refused unsent.
    const turns = (await fakeLog(s.env)).length;
    const first = await call(s.served, 'suggest_changes', { workspace: 'app', ticket: 'P-1', note: 'Rename the button' });
    const note = 'Keep my README line,\nand add second.txt — ünïcödé 🚀';
    const second = await call(s.served, 'suggest_changes', { workspace: 'app', ticket: 'P-1', note });
    assert.deepEqual(second, { stored: true, sha256: noteSha256(note) });
    planner = (await detail()).planner;
    assert.deepEqual({ ...planner.suggestion, at: 'at' }, { note, sha256: second.sha256, at: 'at' });
    const row = JSON.parse((await fetchRaw(new URL('api/jobs', base))).body).jobs.find((each: { ticket: string }) => each.ticket === 'P-1');
    assert.deepEqual(row.planner, planner);
    assert.deepEqual(error(await act(base, 'api/jobs/app/P-1/suggestion-send', { sha256: first.sha256 })), { status: 409, code: 'suggestion_changed' });
    assert.deepEqual(error(await act(base, 'api/jobs/app/P-1/suggestion-send', {})), { status: 400, code: 'invalid_body' });
    assert.equal((await fakeLog(s.env)).length, turns);
    assert.equal((await job(s, 'P-1')).state, 'handed_over');

    // Send: Ask for changes, a turn with the note as the user's message; the file goes.
    assert.deepEqual(result(await act(base, 'api/jobs/app/P-1/suggestion-send', { sha256: second.sha256 })), { state: 'working', queued: false });
    assert.equal(head(s.repo), 'refs/heads/main');
    assert.equal(await exists(file), false);
    await waitFor(s.served, 'P-1', 'awaiting_review', 2);
    const log = await fakeLog(s.env);
    assert.equal(log.length, turns + 1);
    assert.equal(log.at(-1)!.prompt, await jobPrompt(s.env, note, 'P-1', 2));
    assert.equal(log.at(-1)!.cwd, worktreeOf(s.env, 'P-1'));
    const events = (await readFile(s.jobs.eventsPath('app', 'P-1'), 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.state?.from === 'handed_over' && event.state?.to === 'working'), 'the Ask for changes transition');

    // awaiting_review does not wait for the user: no planner suggestion, no Discuss, no store.
    planner = (await detail()).planner;
    assert.deepEqual([planner.discuss, planner.suggestion], [null, null]);
    assert.equal((await refused(s.served, 'suggest_changes', { workspace: 'app', ticket: 'P-1', note: 'x' })).code, 'invalid_state');
    assert.deepEqual(result(await act(base, 'api/jobs/app/P-1/suggestion-dismiss', {})), { dismissed: false });
    // A note left on disk (stored at iteration 2 by hand) can be dismissed; one that is not shown cannot be sent.
    await writeFile(file, JSON.stringify({ note, sha256: second.sha256, at: new Date().toISOString(), iteration: 2 }));
    assert.deepEqual(error(await act(base, 'api/jobs/app/P-1/suggestion-send', { sha256: second.sha256 })), { status: 409, code: 'no_suggestion' });
    assert.deepEqual(result(await act(base, 'api/jobs/app/P-1/suggestion-dismiss', {})), { dismissed: true });
    assert.equal(await exists(file), false);
    // The runner's own check: while a Send of a note checked at iteration 1 is under way, another
    // message moved the job on (it is awaiting_review at iteration 2); the note reaching the runner is
    // refused there, nothing is sent, and the job stays as it is.
    const late = 'Send this only while the job waits';
    await writeFile(join(s.jobs.dir('app', 'P-1'), SENDING_FILE), JSON.stringify({ sha256: noteSha256(late), iteration: 1 }));
    const before = (await fakeLog(s.env)).length;
    const refusedSay = await act(base, 'api/jobs/app/P-1/say', { message: late });
    assert.deepEqual(error(refusedSay), { status: 409, code: 'no_suggestion' });
    assert.match(JSON.parse(refusedSay.body).error.message, /is awaiting_review at iteration 2: it no longer waits for you/);
    assert.deepEqual([(await fakeLog(s.env)).length, (await job(s, 'P-1')).state, (await job(s, 'P-1')).iteration], [before, 'awaiting_review', 2]);
    // No job: an empty 404, as every job action.
    assert.equal((await act(base, 'api/jobs/app/P-9/suggestion-dismiss', {})).status, 404);
  } finally {
    await stop(s.served);
  }
});
