// The coordinator's state (src/coordinator.ts): the status set and cleared, the bounds, the
// questions asked and answered with ids never given twice, the chat link's rules, the read of a
// missing or not-JSON file, the atomic write with mode 0600, and how sf coordinator prints it.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { answerLines, COMMANDS } from '../src/commands.js';
import {
  answerQuestion, askQuestion, chatLink, coordinatorFile, coordinatorLines, endRequestWaits, MAX_QUESTION_CHARS, MAX_QUESTION_NUMBER, MAX_QUESTIONS, MAX_STATUS_CHARS, readCoordinator,
  requestOpen, requestStatus, setLink, setStatus, stateOf, STATUS_REQUEST_MS, waitRequest,
} from '../src/coordinator.js';
import { FactoryError } from '../src/errors.js';
import { localTime } from '../src/local-time.js';

const state = (name: string): Promise<string> => mkdtemp(join(tmpdir(), `sf-coordinator-${name}-`));
const EMPTY = { version: 1, status: null, questions: [], link: null, next_question: 1, status_requested_at: null };
const refused = (code: string) => (error: unknown): boolean => error instanceof FactoryError && error.code === code;
const AT = new Date('2026-11-13T09:30:00.000Z');

test('no file: the state is empty', async () => {
  assert.deepEqual(await readCoordinator(await state('none')), EMPTY);
});

test('a file that is not JSON reads as empty, said in one warning line', async () => {
  const dir = await state('bad');
  await writeFile(coordinatorFile(dir), '{ not json');
  const lines: string[] = [];
  const errorMock = mock.method(console, 'error', (line: unknown) => void lines.push(String(line)));
  try {
    assert.deepEqual(await readCoordinator(dir), EMPTY);
  } finally {
    errorMock.mock.restore();
  }
  assert.deepEqual(lines, [`warning: ${coordinatorFile(dir)} is not JSON; the coordinator's state reads as empty`]);
});

test('the status: set with its time, replaced, cleared; written atomically with mode 0600', async () => {
  const dir = await state('status');
  assert.deepEqual(await setStatus(dir, '  Planning SF-210  ', AT), { ...EMPTY, status: { text: 'Planning SF-210', at: AT.toISOString() } });
  assert.deepEqual((await readCoordinator(dir)).status, { text: 'Planning SF-210', at: AT.toISOString() });
  assert.equal((await stat(coordinatorFile(dir))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['coordinator.json']);
  await setStatus(dir, 'Reviewing SF-205');
  assert.equal((await readCoordinator(dir)).status?.text, 'Reviewing SF-205');
  assert.deepEqual(await setStatus(dir, null), EMPTY);
  assert.equal(JSON.parse(await readFile(coordinatorFile(dir), 'utf8')).version, 1);
});

test('a request for a status: opened once while open, again 2 minutes on; a status answers it, --clear does not; a missing or invalid time reads as none', async () => {
  const dir = await state('request');
  const at = (ms: number): Date => new Date(AT.getTime() + ms);
  assert.equal(STATUS_REQUEST_MS, 120_000);
  assert.deepEqual(await requestStatus(dir, AT), { requested_at: AT.toISOString(), opened: true });
  assert.equal((await readCoordinator(dir)).status_requested_at, AT.toISOString());
  // Open: nothing is written, the open request's time is answered.
  const written = await readFile(coordinatorFile(dir), 'utf8');
  await writeFile(coordinatorFile(dir), written.replace('"version": 1', '"version": 1, "mark": true'));
  assert.deepEqual(await requestStatus(dir, at(STATUS_REQUEST_MS - 1)), { requested_at: AT.toISOString(), opened: false });
  assert.match(await readFile(coordinatorFile(dir), 'utf8'), /"mark": true/);
  assert.equal(requestOpen(await readCoordinator(dir), at(STATUS_REQUEST_MS - 1)), true);
  assert.equal(requestOpen(await readCoordinator(dir), at(STATUS_REQUEST_MS)), false);
  // 2 minutes on: a new one opens.
  assert.deepEqual(await requestStatus(dir, at(STATUS_REQUEST_MS)), { requested_at: at(STATUS_REQUEST_MS).toISOString(), opened: true });
  // --clear answers nothing; a status before the request neither; a status at or after it does.
  assert.equal((await setStatus(dir, null, at(STATUS_REQUEST_MS + 1))).status_requested_at, at(STATUS_REQUEST_MS).toISOString());
  assert.equal((await setStatus(dir, 'Earlier', at(STATUS_REQUEST_MS - 1))).status_requested_at, at(STATUS_REQUEST_MS).toISOString());
  assert.equal((await setStatus(dir, 'Done', at(STATUS_REQUEST_MS + 5))).status_requested_at, null);
  assert.equal((await readCoordinator(dir)).status_requested_at, null);
  // The read: a missing, not a string or not a time reads as none.
  assert.equal(stateOf({}).status_requested_at, null);
  for (const bad of [7, 'yesterday', '', null, { at: AT.toISOString() }]) {
    assert.equal(stateOf({ status_requested_at: bad }).status_requested_at, null, String(bad));
  }
  assert.equal(stateOf({ status_requested_at: AT.toISOString() }).status_requested_at, AT.toISOString());
});

test('waitRequest: an open request answers at once; an expired one is waited past until a new one; a timeout answers none (exit 3); sf serve\'s stop ends a wait with serve_stopping', async () => {
  const dir = await state('wait');
  const answer = (result: { requested_at: string | null }) => answerLines(COMMANDS.coordinatorWaitRequest, result, {});
  // No request: --timeout 0 looks once.
  const none = await waitRequest(dir, 0, () => AT);
  assert.deepEqual(none, { requested_at: null });
  assert.deepEqual(answer(none), { lines: ['no status request before the timeout'], failed: true, exitCode: 3 });
  await requestStatus(dir, AT);
  const open = await waitRequest(dir, 0, () => AT);
  assert.deepEqual(open, { requested_at: AT.toISOString() });
  assert.deepEqual(answer(open), { lines: [`status requested at ${localTime(AT.toISOString())}`], failed: false });
  // Expired (2 minutes on): it waits, and the next request wakes it.
  const later = new Date(AT.getTime() + STATUS_REQUEST_MS);
  const waiting = waitRequest(dir, null, () => later);
  let settled = false;
  void waiting.finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  await requestStatus(dir, later);
  assert.deepEqual(await waiting, { requested_at: later.toISOString() });
  // A short timeout with no new request answers none.
  await setStatus(dir, 'Done', later);
  assert.deepEqual(await waitRequest(dir, 10, () => later), { requested_at: null });
  // The stop ends a pending wait.
  const stopped = waitRequest(dir, null, () => later);
  await new Promise((resolve) => setTimeout(resolve, 20));
  endRequestWaits();
  await assert.rejects(stopped, refused('serve_stopping'));
});

test('the bounds: a status of 2,000 characters, a question of 1,000, 10 open; more is refused and nothing changes; a status keeps its line breaks', async () => {
  const dir = await state('bounds');
  assert.equal(MAX_STATUS_CHARS, 2000);
  await setStatus(dir, 'é'.repeat(MAX_STATUS_CHARS));
  await assert.rejects(setStatus(dir, 'x'.repeat(MAX_STATUS_CHARS + 1)), refused('too_long'));
  assert.equal((await readCoordinator(dir)).status?.text, 'é'.repeat(MAX_STATUS_CHARS));
  await setStatus(dir, '  Waiting.\n\n- SF-1 a\n  more\n');
  assert.equal((await readCoordinator(dir)).status?.text, 'Waiting.\n\n- SF-1 a\n  more');
  await assert.rejects(setStatus(dir, '   '), refused('bad_request'));
  await assert.rejects(askQuestion(dir, 'x'.repeat(MAX_QUESTION_CHARS + 1)), refused('too_long'));
  await assert.rejects(askQuestion(dir, ''), refused('bad_request'));
  for (let index = 0; index < MAX_QUESTIONS; index += 1) {
    await askQuestion(dir, index === 0 ? 'x'.repeat(MAX_QUESTION_CHARS) : `Question ${index + 1}?`);
  }
  await assert.rejects(askQuestion(dir, 'One more?'), refused('too_many_questions'));
  assert.equal((await readCoordinator(dir)).questions.length, 10);
});

test('ask and answered: ids q1, q2, ... in order, never given again while the file lives', async () => {
  const dir = await state('questions');
  assert.equal((await askQuestion(dir, 'Merge SF-204 first?', AT)).id, 'q1');
  const second = await askQuestion(dir, 'Which base?', AT);
  assert.equal(second.id, 'q2');
  assert.deepEqual(second.state.questions, [{ id: 'q1', text: 'Merge SF-204 first?', at: AT.toISOString() }, { id: 'q2', text: 'Which base?', at: AT.toISOString() }]);
  assert.deepEqual((await answerQuestion(dir, 'q2')).questions.map((question) => question.id), ['q1']);
  assert.equal((await askQuestion(dir, 'Again?')).id, 'q3');
  await answerQuestion(dir, 'q1');
  await answerQuestion(dir, 'q3');
  assert.equal((await askQuestion(dir, 'After all answered?')).id, 'q4');
  await assert.rejects(answerQuestion(dir, 'q1'), refused('unknown_question'));
  await assert.rejects(answerQuestion(dir, 'nope'), refused('unknown_question'));
});

test('the last id: q999999999999999 is given and read back; then an ask is ids_exhausted, also after it is answered', async () => {
  const dir = await state('last-id');
  await writeFile(coordinatorFile(dir), JSON.stringify({ version: 1, status: null, questions: [], link: null, next_question: MAX_QUESTION_NUMBER }));
  const last = await askQuestion(dir, 'The last one?', AT);
  assert.equal(last.id, `q${MAX_QUESTION_NUMBER}`);
  const read = await readCoordinator(dir);
  assert.deepEqual([read.questions.map((question) => question.id), read.next_question], [[`q${MAX_QUESTION_NUMBER}`], MAX_QUESTION_NUMBER + 1]);
  await assert.rejects(askQuestion(dir, 'One more?'), refused('ids_exhausted'));
  await answerQuestion(dir, `q${MAX_QUESTION_NUMBER}`);
  assert.equal((await readCoordinator(dir)).next_question, MAX_QUESTION_NUMBER + 1);
  await assert.rejects(askQuestion(dir, 'After it was answered?'), refused('ids_exhausted'));
  assert.deepEqual((await readCoordinator(dir)).questions, []);
  // An open last id with no next_question reads as used up too: never given again.
  await writeFile(coordinatorFile(dir), JSON.stringify({ version: 1, questions: [{ id: `q${MAX_QUESTION_NUMBER}`, text: 't', at: AT.toISOString() }] }));
  await assert.rejects(askQuestion(dir, 'Again?'), refused('ids_exhausted'));
});

test('asks at once get ids of their own', async () => {
  const dir = await state('race');
  const ids = await Promise.all(['a', 'b', 'c', 'd'].map((text) => askQuestion(dir, text)));
  assert.deepEqual(ids.map(({ id }) => id).sort(), ['q1', 'q2', 'q3', 'q4']);
  assert.equal((await readCoordinator(dir)).questions.length, 4);
});

test('next_question: missing or invalid reads as 1 + the highest open id; never below it', () => {
  const question = (id: string) => ({ id, text: 't', at: AT.toISOString() });
  assert.equal(stateOf({ questions: [question('q3'), question('q7')] }).next_question, 8);
  assert.equal(stateOf({ questions: [], next_question: 'x' }).next_question, 1);
  assert.equal(stateOf({ questions: [question('q3')], next_question: 2 }).next_question, 4);
  assert.equal(stateOf({ questions: [question('q3')], next_question: 12 }).next_question, 12);
  assert.equal(stateOf({ questions: [question('q3')], next_question: 5.5 }).next_question, 4);
  // One past the ids' 15 digits (used up) is read as it is; beyond, it is not.
  assert.equal(stateOf({ questions: [question('q3')], next_question: 1e15 }).next_question, 1e15);
  assert.equal(stateOf({ questions: [question('q3')], next_question: 1e15 + 1 }).next_question, 4);
  assert.equal(stateOf({ questions: [question('q999999999999999')], next_question: 1e15 - 1 }).next_question, 1e15);
  // An entry not of the form, or an id given twice, is dropped.
  assert.deepEqual(stateOf({ questions: [question('q1'), question('q1'), question('x1'), { id: 'q2' }, 7] }).questions.map((entry) => entry.id), ['q1']);
});

test('the link: only https://claude.ai/ URLs, with no user or password; cleared', async () => {
  const dir = await state('link');
  assert.equal((await setLink(dir, 'https://claude.ai/chat/abc-123')).link, 'https://claude.ai/chat/abc-123');
  assert.equal(chatLink('https://CLAUDE.ai/chat/x'), 'https://claude.ai/chat/x');
  for (const bad of [
    'http://claude.ai/chat/x', 'https://claude.ai.evil.com/chat/x', 'https://evil.com/claude.ai/', 'https://user@claude.ai/chat/x',
    'https://user:pw@claude.ai/', 'javascript:alert(1)', 'https://www.claude.ai/', 'https://claude.ai:8443/', 'claude.ai/chat/x', '',
  ]) {
    assert.equal(chatLink(bad), undefined, bad);
    await assert.rejects(setLink(dir, bad), refused('bad_link'), bad);
  }
  assert.equal((await readCoordinator(dir)).link, 'https://claude.ai/chat/abc-123');
  assert.equal((await setLink(dir, null)).link, null);
  // A link edited into the file by hand is checked on the read too.
  await writeFile(coordinatorFile(dir), JSON.stringify({ version: 1, link: 'javascript:alert(1)' }));
  assert.equal((await readCoordinator(dir)).link, null);
});

test('sf coordinator prints a status\'s further lines under its first, indented by the width of "status: "', () => {
  const at = AT.toISOString();
  const lines = coordinatorLines({ ...EMPTY, version: 1, status: { text: 'Waiting.\n\n- SF-1 a\n  more', at }, questions: [{ id: 'q1', text: 'Which?\nThis one', at }] });
  assert.deepEqual(lines, [
    `status: Waiting.  (${localTime(at)})`, '', '        - SF-1 a', '          more',
    'questions:', `  q1  ${localTime(at)}  Which?`, '      This one', 'link: none',
  ]);
  assert.deepEqual(coordinatorLines({ ...EMPTY, version: 1, status: { text: 'Planning', at } }).slice(0, 2), [`status: Planning  (${localTime(at)})`, 'questions: none']);
});
