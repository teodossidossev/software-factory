// The coordinator's state, the dashboard's Coordinator card: what the coordinator (the user's
// Claude Code session in the factory's checkout) does now, the questions it put to the user that
// wait for an answer, and the link to its chat on claude.ai. In <state dir>/coordinator.json
// ({ version: 1, status: { text, at } | null, questions: [{ id, text, at }], link, next_question,
// status_requested_at }), written atomically with mode 0600 by sf serve only (one write at a time):
// by its sf coordinator commands, and by the dashboard's POST api/coordinator/request, whose only
// write is status_requested_at, the time of an open request for a status (requestStatus). A missing
// file reads as empty; one that is not JSON too, with one warning line. Question ids are q1, q2,
// ...: next_question is the next one's number, never lower than the highest open one's + 1, so an id
// is not given twice while the file lives. The waits of sf coordinator wait-request live here too,
// in sf serve, per state directory (waitRequest): requestStatus wakes them.
// Below the state, the sf coordinator commands of src/commands.ts's table (spread into its
// COMMANDS, which has no room for them under the size limit) and how the CLI prints their answers.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import type { Answer, Command, Flags, Result } from './commands.js';
import { stateDir as serveStateDir } from './config.js';
import { FactoryError } from './errors.js';
import { localTime } from './local-time.js';

// The bounds, in characters: a status, a question; and the open questions at most.
export const MAX_STATUS_CHARS = 2000;
export const MAX_QUESTION_CHARS = 1000;
export const MAX_QUESTIONS = 10;

export interface CoordinatorQuestion {
  id: string;
  text: string;
  at: string;
}

export interface CoordinatorState {
  version: 1;
  status: { text: string; at: string } | null;
  questions: CoordinatorQuestion[];
  link: string | null;
  next_question: number;
  // The time (ISO) the dashboard last asked for a status; null when none was asked or a status
  // answered it. Open while younger than STATUS_REQUEST_MS (requestOpen).
  status_requested_at: string | null;
}

// How long a request for a status stays open: past it, it is expired (unanswered), and a new one
// may open.
export const STATUS_REQUEST_MS = 2 * 60 * 1000;

export const coordinatorFile = (stateDir: string): string => join(stateDir, 'coordinator.json');

// An id's number has at most 15 digits, so it parses back as one and stays a safe integer.
// next_question is read up to one past that bound: the ids are used up, and that stays so while
// the file lives (an ask is refused with ids_exhausted, never given an id the read would drop).
const QUESTION_ID = /^q([1-9]\d{0,14})$/;
export const MAX_QUESTION_NUMBER = 999_999_999_999_999;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';

// The chat's link when it is one: an https URL of the host claude.ai exactly, on the default port,
// without user or password; its normalized form (URL's href), else undefined.
export function chatLink(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch { // not a URL at all: not a chat link
    return undefined;
  }
  const ok = url.protocol === 'https:' && url.hostname === 'claude.ai' && url.port === '' && url.username === '' && url.password === '';
  return ok ? url.href : undefined;
}

// The state of a parsed file (anything): each part the file holds in its form, else empty; a
// question with an id that is not q<N> or given twice is dropped; a link that is not a chat link
// is none; a request's time that is not a string Date.parse reads is none.
export function stateOf(data: unknown): CoordinatorState {
  const file = isRecord(data) ? data : {};
  const status = isRecord(file.status) && isString(file.status.text) && isString(file.status.at) ? { text: file.status.text, at: file.status.at } : null;
  const questions: CoordinatorQuestion[] = [];
  for (const entry of Array.isArray(file.questions) ? file.questions : []) {
    if (isRecord(entry) && isString(entry.id) && QUESTION_ID.test(entry.id) && isString(entry.text) && isString(entry.at) && !questions.some((question) => question.id === entry.id)) {
      questions.push({ id: entry.id, text: entry.text, at: entry.at });
    }
  }
  const link = isString(file.link) ? chatLink(file.link) ?? null : null;
  const after = Math.max(0, ...questions.map((question) => Number(QUESTION_ID.exec(question.id)![1]))) + 1;
  const given = file.next_question;
  const next = typeof given === 'number' && Number.isInteger(given) && given >= after && given <= MAX_QUESTION_NUMBER + 1 ? given : after;
  const requested = file.status_requested_at;
  const statusRequestedAt = isString(requested) && Number.isFinite(Date.parse(requested)) ? requested : null;
  return { version: 1, status, questions, link, next_question: next, status_requested_at: statusRequestedAt };
}

// Whether a request for a status is open at now: asked, and less than STATUS_REQUEST_MS ago.
export function requestOpen(state: CoordinatorState, now: Date): boolean {
  return state.status_requested_at !== null && now.getTime() - Date.parse(state.status_requested_at) < STATUS_REQUEST_MS;
}

// The state now: the file's, empty when it is missing; a file that is not JSON reads as empty,
// with one warning line.
export async function readCoordinator(stateDir: string): Promise<CoordinatorState> {
  let text: string;
  try {
    text = await readFile(coordinatorFile(stateDir), 'utf8');
  } catch { // no file (or one that cannot be read): the coordinator has not reported
    return stateOf(undefined);
  }
  try {
    return stateOf(JSON.parse(text));
  } catch { // not JSON: empty, said once per read
    console.error(`warning: ${coordinatorFile(stateDir)} is not JSON; the coordinator's state reads as empty`);
    return stateOf(undefined);
  }
}

// The writes one after the other: each reads the state the one before wrote. A refused text is
// refused before its write is queued (the functions below are async: a refusal is a rejection).
// A change that returns the very state it was given writes nothing.
let writes: Promise<unknown> = Promise.resolve();
function update<T>(stateDir: string, change: (state: CoordinatorState) => { state: CoordinatorState; result: T }): Promise<T> {
  const done = writes.then(async () => {
    const read = await readCoordinator(stateDir);
    const { state, result } = change(read);
    if (state !== read) {
      await writeFileAtomic(coordinatorFile(stateDir), Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
    }
    return result;
  });
  writes = done.catch(() => undefined);
  return done;
}

// A text as given: not empty, at most max characters.
function checkedText(text: string, max: number, what: string): string {
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new FactoryError('bad_request', `The ${what} is empty.`);
  }
  if ([...trimmed].length > max) {
    throw new FactoryError('too_long', `The ${what} has ${[...trimmed].length} characters; at most ${max}.`);
  }
  return trimmed;
}

// sf coordinator status: what the coordinator does now, or none (null). A status answers the
// request for one asked at or before its time (status_requested_at back to null); none answers
// nothing.
export async function setStatus(stateDir: string, text: string | null, now = new Date()): Promise<CoordinatorState> {
  const status = text === null ? null : { text: checkedText(text, MAX_STATUS_CHARS, 'status'), at: now.toISOString() };
  return update(stateDir, (state) => {
    const requested = state.status_requested_at;
    const answered = status !== null && requested !== null && Date.parse(requested) <= now.getTime();
    const next = { ...state, status, status_requested_at: answered ? null : requested };
    return { state: next, result: next };
  });
}

// The waits of sf coordinator wait-request in sf serve, by state directory: each is woken with the
// request's time, or ended with a refusal.
interface RequestWait {
  wake(requestedAt: string): void;
  end(error: FactoryError): void;
}
const requestWaits = new Map<string, Set<RequestWait>>();

// The dashboard's request for a status (POST api/coordinator/request): while one is open, nothing
// is written and its time is answered (opened false); else the time of now is written (opened true)
// and every wait of the state directory is woken with it.
export async function requestStatus(stateDir: string, now = new Date()): Promise<{ requested_at: string; opened: boolean }> {
  const result = await update(stateDir, (state) => {
    if (requestOpen(state, now)) {
      return { state, result: { requested_at: state.status_requested_at!, opened: false } };
    }
    const requestedAt = now.toISOString();
    return { state: { ...state, status_requested_at: requestedAt }, result: { requested_at: requestedAt, opened: true } };
  });
  if (result.opened) {
    for (const wait of requestWaits.get(stateDir) ?? []) {
      wait.wake(result.requested_at);
    }
  }
  return result;
}

// setTimeout's bound in ms: a longer wait is armed in parts.
const MAX_TIMER_MS = 2 ** 31 - 1;

// sf coordinator wait-request: the time of the open request for a status, at once when one is
// open (an expired one does not count), else when the next one opens; null when timeoutMs passes
// first (0 looks once; null waits without end). The wait is registered before the state is read,
// so a request written between the two wakes it. sf serve's stop ends it (endRequestWaits).
export function waitRequest(stateDir: string, timeoutMs: number | null, now: () => Date = () => new Date()): Promise<{ requested_at: string | null }> {
  return new Promise((resolve, reject) => {
    const waits = requestWaits.get(stateDir) ?? new Set<RequestWait>();
    requestWaits.set(stateDir, waits);
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const finish = (): boolean => {
      if (done) {
        return false;
      }
      done = true;
      clearTimeout(timer);
      waits.delete(wait);
      if (waits.size === 0 && requestWaits.get(stateDir) === waits) {
        requestWaits.delete(stateDir);
      }
      return true;
    };
    const wait: RequestWait = {
      wake: (requestedAt) => void (finish() && resolve({ requested_at: requestedAt })),
      end: (error) => void (finish() && reject(error)),
    };
    waits.add(wait);
    // The timeout counted in the parts armed, not by the clock.
    const arm = (left: number): void => {
      const part = Math.min(left, MAX_TIMER_MS);
      timer = setTimeout(() => (left - part > 0 ? arm(left - part) : void (finish() && resolve({ requested_at: null }))), part);
    };
    readCoordinator(stateDir).then((state) => {
      if (requestOpen(state, now())) {
        wait.wake(state.status_requested_at!);
      } else if (timeoutMs === 0) {
        void (finish() && resolve({ requested_at: null }));
      } else if (timeoutMs !== null && !done) {
        arm(timeoutMs);
      }
    }, (error: unknown) => void (finish() && reject(error)));
  });
}

// sf serve stops: every wait ends with serve_stopping, so no open connection holds its socket's close.
export function endRequestWaits(): void {
  const error = new FactoryError('serve_stopping', 'sf serve is stopping; run sf coordinator wait-request again when it answers.');
  for (const waits of [...requestWaits.values()]) {
    for (const wait of [...waits]) {
      wait.end(error);
    }
  }
}

// sf coordinator ask: one more open question, with the next id.
export async function askQuestion(stateDir: string, text: string, now = new Date()): Promise<{ id: string; state: CoordinatorState }> {
  const question = checkedText(text, MAX_QUESTION_CHARS, 'question');
  return update(stateDir, (state) => {
    if (state.questions.length >= MAX_QUESTIONS) {
      throw new FactoryError('too_many_questions', `${MAX_QUESTIONS} questions are open already; mark one answered first (sf coordinator answered <id>).`);
    }
    if (state.next_question > MAX_QUESTION_NUMBER) {
      throw new FactoryError('ids_exhausted', `The question ids are used up (q${MAX_QUESTION_NUMBER} was the last); remove ${coordinatorFile(stateDir)} to start again at q1.`);
    }
    const id = `q${state.next_question}`;
    const next = { ...state, questions: [...state.questions, { id, text: question, at: now.toISOString() }], next_question: state.next_question + 1 };
    return { state: next, result: { id, state: next } };
  });
}

// sf coordinator answered: the question is no longer open.
export function answerQuestion(stateDir: string, id: string): Promise<CoordinatorState> {
  return update(stateDir, (state) => {
    if (!state.questions.some((question) => question.id === id)) {
      throw new FactoryError('unknown_question', `There is no open question "${id}"${state.questions.length > 0 ? `; open: ${state.questions.map((question) => question.id).join(', ')}` : ''}.`);
    }
    const next = { ...state, questions: state.questions.filter((question) => question.id !== id) };
    return { state: next, result: next };
  });
}

// sf coordinator link: the chat's link (a claude.ai one only), or none (null).
export async function setLink(stateDir: string, text: string | null): Promise<CoordinatorState> {
  const link = text === null ? null : chatLink(text);
  if (link === undefined) {
    throw new FactoryError('bad_link', 'The link must be an https://claude.ai/ URL without user or password.');
  }
  return update(stateDir, (state) => {
    const next = { ...state, link };
    return { state: next, result: next };
  });
}

// ------------------------------------------------------------------ sf coordinator

// The text of sf coordinator status|link, or null with --clear; neither or both is refused.
function textOrClear(words: readonly string[], flags: Flags, what: string): string | null {
  if ((flags.clear === true) === (words.length > 0)) {
    throw new FactoryError('bad_request', `coordinator ${what} needs the ${what} or --clear, one of them.`);
  }
  return flags.clear === true ? null : words.join(' ');
}

// The commands of the table in src/commands.ts (spread into its COMMANDS): sf serve runs them, one
// write at a time; after a write but the read, its socket handler tells the open pages.
export const COORDINATOR_COMMANDS = {
  coordinator: {
    name: 'coordinator', args: [], openWhileUpdating: true,
    description: 'The coordinator\'s state on the dashboard\'s Coordinator card: its status, the open questions with their ids, the chat\'s link',
    run: () => readCoordinator(serveStateDir()),
  },
  coordinatorStatus: {
    name: 'coordinator status', args: ['[text...]'], flags: ['--clear'],
    description: `What the coordinator does now, on the dashboard's Coordinator card with its time: at most ${MAX_STATUS_CHARS} characters, several lines in one quoted argument (lines starting with "- " are a list; put -- before a text that starts with "-"); --clear removes it`,
    run: (_s, words, flags) => setStatus(serveStateDir(), textOrClear(words, flags, 'status')),
  },
  coordinatorAsk: {
    name: 'coordinator ask', args: ['<text...>'],
    description: `Put a question that waits for the user's answer on the card (at most ${MAX_QUESTION_CHARS} characters, ${MAX_QUESTIONS} open); prints its id (q1, q2, ...)`,
    run: (_s, words) => askQuestion(serveStateDir(), words.join(' ')),
  },
  coordinatorAnswered: {
    name: 'coordinator answered', args: ['<id>'],
    description: 'Take an answered question off the card',
    run: (_s, [id = '']) => answerQuestion(serveStateDir(), id),
  },
  coordinatorLink: {
    name: 'coordinator link', args: ['[url]'], flags: ['--clear'],
    description: 'The chat\'s link for the card\'s Open the chat: an https://claude.ai/ URL only; --clear removes it',
    run: (_s, words, flags) => setLink(serveStateDir(), textOrClear(words, flags, 'link')),
  },
  // It writes nothing: no change event follows it (src/ipc-handlers.ts).
  coordinatorWaitRequest: {
    name: 'coordinator wait-request', args: [], flags: ['--timeout N'],
    description: 'Wait until the dashboard asks for a status (a click on Zen\'s screen on the Coordinator card) and print the request\'s time; a request open already answers at once; --timeout N gives up after N seconds (exit 3). For a background task of the coordinator\'s session',
    run: (_s, _words, { timeout }) => waitRequest(serveStateDir(), typeof timeout === 'string' ? Number(timeout) * 1000 : null),
  },
} satisfies Record<string, Command>;

// The state as sf coordinator prints it: the status's first line with its time and its further
// lines indented by the width of "status: " under it, each open question with its id and time (a
// text of several lines indented under it), the link.
export function coordinatorLines(state: CoordinatorState): string[] {
  const when = (at: string): string => localTime(at) ?? at;
  const [statusFirst = '', ...statusMore] = state.status === null ? [] : state.status.text.split('\n');
  return [
    `status: ${state.status === null ? 'none' : `${statusFirst.trimEnd()}  (${when(state.status.at)})`}`,
    ...statusMore.map((line) => `        ${line}`.trimEnd()),
    state.questions.length === 0 ? 'questions: none' : 'questions:',
    ...state.questions.flatMap((question) => {
      const [first = '', ...more] = question.text.split('\n');
      return [`  ${question.id}  ${when(question.at)}  ${first}`, ...more.map((line) => `      ${line}`.trimEnd())];
    }),
    `link: ${state.link ?? 'none'}`,
  ];
}

// How the CLI shows the commands' answers (src/commands.ts ANSWERS): sf coordinator ask its id
// alone, wait-request the request's time or the timeout (exit 3), the others the state after them.
const stateAnswer = (result: Result): Answer => ({ lines: coordinatorLines(result as unknown as CoordinatorState), failed: false });
function waitAnswer(result: Result): Answer {
  const at = result.requested_at;
  return typeof at === 'string'
    ? { lines: [`status requested at ${localTime(at) ?? at}`], failed: false }
    : { lines: ['no status request before the timeout'], failed: true, exitCode: 3 };
}
export const COORDINATOR_ANSWERS: ReadonlyArray<[Command, (result: Result) => Answer]> = [
  [COORDINATOR_COMMANDS.coordinator, stateAnswer],
  [COORDINATOR_COMMANDS.coordinatorStatus, stateAnswer],
  [COORDINATOR_COMMANDS.coordinatorAsk, (result) => ({ lines: [String(result.id)], failed: false })],
  [COORDINATOR_COMMANDS.coordinatorAnswered, stateAnswer],
  [COORDINATOR_COMMANDS.coordinatorLink, stateAnswer],
  [COORDINATOR_COMMANDS.coordinatorWaitRequest, waitAnswer],
];
