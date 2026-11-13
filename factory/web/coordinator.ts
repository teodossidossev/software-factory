// coordinator.js, a dashboard script (DASHBOARD_SCRIPTS in src/dashboard.ts) right after board.js,
// built from web/coordinator.ts into dist/web/: the board's Coordinator card (#coord, above the
// columns). It shows what the coordinator (the user's Claude Code session in the factory's
// checkout) does now, the questions that wait for the user's answer, and Open the chat. It is
// read-only: sf coordinator writes the state through sf serve; the page reads GET api/coordinator
// on each coordinator event of the stream (one on connect, one after each write: main.js), and
// every board render (renderBoard) renders the card again, so its ages follow the board's
// refresh without a timer of its own. Every text goes in through textContent; the link is
// checked again here, claude.ai only. A classic script, loaded in order with defer, sharing the
// page's globals with the others. This file has no import or export on purpose: the compiler
// keeps it a script, so its top-level names stay the page's globals.
'use strict';

// A status older than this is muted, with "quiet since <time>".
const COORD_QUIET_MS = 2 * 60 * 60 * 1000;

// The state as last read; null until a read answers (the card stays hidden).
let coordState: CoordinatorState | null = null;
// The reads started; only the last one's answer is shown.
let coordReads = 0;

// The chat's link when it is one as sf coordinator link takes it (an https URL of the host
// claude.ai exactly, on the default port, without user or password), else null.
function chatHref(link: unknown): string | null {
  if (typeof link !== 'string') {
    return null;
  }
  let url: URL;
  try {
    url = new URL(link);
  } catch { // not a URL: no link
    return null;
  }
  return url.protocol === 'https:' && url.hostname === 'claude.ai' && url.port === '' && url.username === '' && url.password === '' ? url.href : null;
}

// The state of an answer, each part checked: a status or a question not of its form is left out,
// a link not of claude.ai is none.
function coordStateOf(data: unknown): CoordinatorState {
  const file: Readonly<Record<string, unknown>> = isRecord(data) ? data : {};
  const status = isRecord(file.status) && typeof file.status.text === 'string' && typeof file.status.at === 'string' ? { text: file.status.text, at: file.status.at } : null;
  const questions = (Array.isArray(file.questions) ? file.questions : [])
    .filter((entry: unknown): entry is CoordinatorQuestion => isRecord(entry) && typeof entry.id === 'string' && typeof entry.text === 'string' && typeof entry.at === 'string')
    .map(({ id, text, at }) => ({ id, text, at }));
  return { status, questions, link: chatHref(file.link) };
}

// Reads the state and renders the card; a read that fails keeps the card as it was (the next
// coordinator event reads again), and an answer that comes after a later read's is dropped.
async function readCoordinatorCard(): Promise<void> {
  coordReads += 1;
  const read = coordReads;
  try {
    const data = await getJson('api/coordinator');
    if (read === coordReads) {
      coordState = coordStateOf(data);
      renderCoordinator();
    }
  } catch { // sf serve did not answer: the card keeps the last state read
  }
}

// The card: hidden before the first read; one muted line when the coordinator never reported;
// else the status with its age (muted, "quiet since <time>", after two hours), Open the chat, and
// the open questions in the order asked, each with its age. An open question gives the card
// its accent border.
function renderCoordinator(): void {
  const card = byId('coord');
  card.hidden = coordState === null;
  if (coordState === null) {
    return;
  }
  // The link was checked when it was read (coordStateOf).
  const { status, questions, link: href } = coordState;
  card.classList.toggle('asks', questions.length > 0);
  if (status === null && questions.length === 0 && href === null) {
    card.replaceChildren(el('p', 'coord-none muted', 'The coordinator has not reported (sf coordinator)'));
    return;
  }
  const head = el('div', 'coord-head');
  head.append(el('h2', '', 'Coordinator'));
  if (status !== null) {
    const quiet = Date.now() - Date.parse(status.at) > COORD_QUIET_MS;
    const age = el('span', 'coord-age', quiet ? 'quiet since ' : ago(status.at));
    if (quiet) {
      age.append(sinceEl(status.at));
    }
    head.append(el('span', quiet ? 'coord-status muted' : 'coord-status', status.text), age);
  } else {
    head.append(el('span', 'coord-status muted', 'No status'));
  }
  if (href !== null) {
    head.append(tabLink('btn coord-chat', 'Open the chat', href));
  }
  const list = el('ul', 'coord-qs');
  list.setAttribute('aria-label', 'Questions for you');
  list.append(...questions.map((question) => {
    const row = el('li', 'coord-q');
    row.append(el('span', 'coord-qtext', question.text), el('span', 'coord-age', ago(question.at)));
    return row;
  }));
  card.replaceChildren(head, ...(questions.length > 0 ? [list] : []));
}
