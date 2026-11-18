// coordinator.js, a dashboard script (DASHBOARD_SCRIPTS in src/dashboard.ts) right after board.js,
// built from web/coordinator.ts into dist/web/: the Coordinator card (#coord, under Needs you on
// the Home and above the columns on the board; home.js places it). It shows what the coordinator
// (the user's Claude Code session in the factory's checkout) does now as it answers "status?":
// paragraphs and "- " lists, each ticket key of the board a link with its title; a long status
// folds to its first lines behind Show all. Under it a footer with the status's age and Open the
// chat, and the questions that wait for the user's answer. It is read-only but for one click: sf
// coordinator writes the state through sf serve, and a click on Zen's screen asks the coordinator
// for a status (POST api/coordinator/request, which records the request's time in the state). The
// page reads GET api/coordinator on each coordinator event of the stream (one on connect, one after
// each write or request: main.js), and every board render (renderBoard) renders the card again, so
// its ages and ticket links follow the board without a timer of its own. The title holds Zen's
// lights (the ship's computer of Blake's 7): a small octagonal screen of ten lights, the bar in the
// middle and nine small ones, faint at rest. Zen thinks (the small lights blink, the bar glows) for
// 3 s when a jobs event of the stream (main.js) differs from the last one by a job's state, a job
// new to the list or a job gone from it, in any workspace, or when the screen is clicked (the first
// list lights nothing); and on every page while a request for a status is open (younger than 2
// minutes; one timer ends it, and the card then says the coordinator is not answering). Zen speaks
// when the requested status arrives on a page that had the request open: the status shows whole at
// once, the small lights stand still spelling a number in binary, and the bar flickers for a time
// that grows with the status's length (with reduced motion: the pattern and the bar lit for 1 s).
// The state lives here, not on the element, so a render draws the screen as it was (coordZenPaint),
// and a card without a title (hidden, or "has not reported") draws none. Every text goes in through
// textContent or a text node, never as HTML; a ticket link opens only a page of the board's own
// tickets; the chat link is checked again here, claude.ai only. A classic script, loaded in order
// with defer, sharing the page's globals with the others. This file has no import or export on
// purpose: the compiler keeps it a script, so its top-level names stay the page's globals.
'use strict';

// A status older than this is muted, with "quiet since <time>".
const COORD_QUIET_MS = 2 * 60 * 60 * 1000;
// A long status's preview: its first block's first lines (a paragraph's lines or a list's items),
// and the characters they hold at most before the cut.
const COORD_PREVIEW_LINES = 3;
const COORD_PREVIEW_CHARS = 200;

// The state as last read; null until a read answers (the card stays hidden).
let coordState: CoordinatorState | null = null;
// The reads started; only the last one's answer is shown.
let coordReads = 0;
// Whether a long status shows whole: the page's choice, one for the Home and the board (the card
// is one element), not stored.
let coordOpen = false;

// How long the Zen lights stay lit after a change of the jobs list or a click on the screen.
const COORD_ZEN_MS = 3000;
// The lights on Zen's screen: the bar, then the nine small ones (app.css places and times them).
const COORD_ZEN_LIGHTS = 10;
// The small lights in reading order, as a page is read: the two above the bar, the four down the
// right, then below the bar the two upper ones (left, right) and last the lower one between them.
// Reading position k (0 first) is small light COORD_ZEN_READING[k] (in child order after the bar)
// and holds bit 8 - k of the number they spell.
const COORD_ZEN_READING = [4, 5, 0, 1, 2, 3, 6, 8, 7];
// The jobs list as last seen (each job's state by its key, every workspace's); null before the
// first jobs event.
let coordJobsSeen: Map<string, string> | null = null;
// Whether the Zen lights are lit for COORD_ZEN_MS: every render draws them from it.
let coordZenLit = false;
// The timer that dims them; null while they are dim.
let coordZenTimer: ReturnType<typeof setTimeout> | null = null;

// How long a request for a status stays open on the page (sf serve's STATUS_REQUEST_MS).
const COORD_ASK_MS = 2 * 60 * 1000;
// Whether this page's POST api/coordinator/request waits for its answer: a click then sends no other.
let coordAsking = false;
// The timer that ends an open request at its time + COORD_ASK_MS, and the request's time it was
// set for; null when none is set.
let coordAskTimer: ReturnType<typeof setTimeout> | null = null;
let coordAskTimerFor: string | null = null;
// The request's time the timer saw end: from then on that request reads as late, whatever the
// page's clock says.
let coordAskEnded: string | null = null;

// The request for a status of the state read: 'open' while it is younger than COORD_ASK_MS by the
// page's clock and its timer has not ended it, 'late' after, null when none is open.
function coordAsked(): 'open' | 'late' | null {
  const at = coordState?.status_requested_at ?? null;
  if (at === null) {
    return null;
  }
  return at !== coordAskEnded && Date.now() - Date.parse(at) < COORD_ASK_MS ? 'open' : 'late';
}

// The timer of the open request (called by each render): set once for a request whose timer is not
// set yet, at its time + COORD_ASK_MS, then the request is late and the card renders; cleared when
// no request is open.
function coordAskWatch(): void {
  const at = coordState?.status_requested_at ?? null;
  if (at === null || coordAsked() !== 'open') {
    clearTimeout(coordAskTimer ?? undefined);
    coordAskTimer = null;
    coordAskTimerFor = null;
    return;
  }
  if (coordAskTimer !== null && coordAskTimerFor === at) {
    return;
  }
  clearTimeout(coordAskTimer ?? undefined);
  coordAskTimerFor = at;
  coordAskTimer = setTimeout(() => {
    coordAskTimer = null;
    coordAskTimerFor = null;
    coordAskEnded = at;
    renderCoordinator();
  }, Date.parse(at) + COORD_ASK_MS - Date.now());
}

// A speech of Zen (one at a time): the small lights' pattern, the bar on or off, the small lights
// switched now (by their index), the time its steps spent, how long the bar flickers, when the next
// switch comes (in the steps' time), and its timers. Time is counted by adding the steps' lengths,
// never by the clock.
interface CoordSpeech {
  pattern: boolean[];
  bar: boolean;
  switched: Set<number>;
  spent: number;
  length: number;
  nextSwitch: number;
  timers: Set<ReturnType<typeof setTimeout>>;
}
let coordSpeech: CoordSpeech | null = null;

// The nine small lights (in child order) from the 9 low bits of count, read in COORD_ZEN_READING's
// order, the first the largest bit.
function coordZenPattern(count: number): boolean[] {
  const pattern = Array.from({ length: COORD_ZEN_READING.length }, () => false);
  COORD_ZEN_READING.forEach((light, position) => {
    pattern[light] = ((count >> (8 - position)) & 1) === 1;
  });
  return pattern;
}

// Paints Zen's screen from the script's state: thinking (lit) while lit for COORD_ZEN_MS or a
// request for a status is open, and no speech; speaking during one, with the bar's on and each
// small light's on (its pattern bit, the opposite while switched); at rest no on anywhere.
function coordZenPaint(zen: HTMLElement): void {
  const speech = coordSpeech;
  zen.classList.toggle('lit', speech === null && (coordZenLit || coordAsked() === 'open'));
  zen.classList.toggle('speaking', speech !== null);
  const [bar, ...small] = Array.from(zen.children);
  bar?.classList.toggle('on', speech?.bar === true);
  small.forEach((light, index) => light.classList.toggle('on', speech !== null && speech.pattern[index] !== speech.switched.has(index)));
}

// The Zen lights drawn on the card, if any: painted in place, with no render.
function coordZenShow(): void {
  const zen = byId('coord').querySelector<HTMLElement>('.coord-zen');
  if (zen !== null) {
    coordZenPaint(zen);
  }
}

// A whole number from low to high, both included, drawn with Math.random.
const coordDraw = (low: number, high: number): number => low + Math.floor(Math.random() * (high - low + 1));

// A timer of the speech, forgotten once it fires; the speech's end clears the others.
function coordSpeechTimer(speech: CoordSpeech, ms: number, then: () => void): void {
  const timer = setTimeout(() => {
    speech.timers.delete(timer);
    then();
  }, ms);
  speech.timers.add(timer);
}

// Zen speaks the status of text (the last speech ended first): the small lights spell landed, the
// jobs landed today that sf serve counted for this read of api/coordinator, up to 511 (all nine
// on); without it (an older sf serve) a random number from 1 to 511. The bar flickers for
// min(7 s, 1.5 s + 35 ms per character), then is off for one 300 ms step, and the speech ends. With
// reduced motion: the pattern and the bar on for one 1 s step.
function coordSpeak(text: string, landed: number | null): void {
  coordSpeechEnd();
  const speech: CoordSpeech = {
    pattern: coordZenPattern(landed === null ? coordDraw(1, 511) : Math.min(511, landed)), bar: true, switched: new Set(), spent: 0,
    length: Math.min(7000, 1500 + 35 * [...text].length), nextSwitch: coordDraw(1500, 3000), timers: new Set(),
  };
  coordSpeech = speech;
  if (media('(prefers-reduced-motion: reduce)')) {
    coordSpeechTimer(speech, 1000, coordSpeechEnd);
    coordZenShow();
    return;
  }
  coordSpeechStep(speech, true);
}

// One step of the speech: the bar on for 70 to 260 ms or off for 40 to 170 ms, then the next one,
// until the steps' time reaches the speech's length. After an off step past the next switch time,
// one or two small lights switch.
function coordSpeechStep(speech: CoordSpeech, on: boolean): void {
  speech.bar = on;
  coordZenShow();
  const ms = on ? coordDraw(70, 260) : coordDraw(40, 170);
  coordSpeechTimer(speech, ms, () => {
    speech.spent += ms;
    if (!on && speech.spent >= speech.nextSwitch) {
      coordSpeechSwitch(speech);
      speech.nextSwitch = speech.spent + coordDraw(1500, 3000);
    }
    if (speech.spent < speech.length) {
      coordSpeechStep(speech, !on);
      return;
    }
    speech.bar = false;
    coordZenShow();
    coordSpeechTimer(speech, 300, coordSpeechEnd);
  });
}

// One small light (two when a draw is .7 or more), drawn at random, shows the opposite of its
// pattern bit until a timer of its own, 500 to 900 ms, puts it back.
function coordSpeechSwitch(speech: CoordSpeech): void {
  const free = speech.pattern.map((_bit, index) => index).filter((index) => !speech.switched.has(index));
  const count = Math.random() >= 0.7 ? 2 : 1;
  for (let drawn = 0; drawn < count && free.length > 0; drawn += 1) {
    const [light] = free.splice(Math.floor(Math.random() * free.length), 1);
    if (light === undefined) {
      break;
    }
    speech.switched.add(light);
    coordSpeechTimer(speech, coordDraw(500, 900), () => {
      speech.switched.delete(light);
      coordZenShow();
    });
  }
  coordZenShow();
}

// Ends the speech, if any, at once: its timers cleared, the screen painted at rest (or thinking).
function coordSpeechEnd(): void {
  const speech = coordSpeech;
  if (speech === null) {
    return;
  }
  speech.timers.forEach((timer) => clearTimeout(timer));
  coordSpeech = null;
  coordZenShow();
}

// A click on Zen's screen: a speech ends, the screen lights for COORD_ZEN_MS as on a change, and,
// when no request is open and this page's last one is answered, the page asks the coordinator for
// a status. A refusal shows its code and message, a failure without an answer its message.
function coordZenClick(): void {
  coordSpeechEnd();
  coordZenLight();
  if (coordAsked() === 'open' || coordAsking) {
    return;
  }
  coordAsking = true;
  post('api/coordinator/request', {}).catch((error: unknown) => {
    toast({ level: 'error', text: error instanceof ActionError ? `${error.code}: ${error.message}` : `The request for a status failed (${errorMessage(error)}).` });
  }).finally(() => {
    coordAsking = false;
  });
}

// Called with each jobs event's list: when it differs from the last list seen by a job's state, a
// job new to it or a job gone from it, it calls coordZenLight(). The first list only sets the
// starting point.
function coordZenOnJobs(jobs: readonly JobRow[]): void {
  const seen = new Map(jobs.map((job) => [keyOf(job), job.state]));
  const last = coordJobsSeen;
  coordJobsSeen = seen;
  if (last === null || (last.size === seen.size && [...seen].every(([key, jobState]) => last.get(key) === jobState))) {
    return;
  }
  coordZenLight();
}

// Lights the Zen lights for COORD_ZEN_MS from now (a change of the jobs list or a click on the
// screen): the flag set, the last timer cleared, so lighting them while lit starts the time again,
// and a new timer that dims them.
function coordZenLight(): void {
  coordZenLit = true;
  clearTimeout(coordZenTimer ?? undefined);
  coordZenTimer = setTimeout(() => {
    coordZenTimer = null;
    coordZenLit = false;
    coordZenShow();
  }, COORD_ZEN_MS);
  coordZenShow();
}

// The Zen lights: Zen's screen after the title's text, holding COORD_ZEN_LIGHTS empty lights, the
// first the bar, then the nine small ones; painted from the script's state (coordZenPaint):
// thinking, speaking or at rest. A click asks for a status (coordZenClick). Decorative, so hidden
// from a screen reader, with a tooltip for the mouse.
function coordZen(): HTMLElement {
  const zen = el('span', 'coord-zen');
  zen.setAttribute('aria-hidden', 'true');
  zen.setAttribute('title', 'Zen: lights up when a job changes state; click to ask the coordinator for a status');
  zen.append(el('i', 'bar'), ...Array.from({ length: COORD_ZEN_LIGHTS - 1 }, () => el('i')));
  coordZenPaint(zen);
  zen.addEventListener('click', coordZenClick);
  return zen;
}

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
// a link not of claude.ai is none, a request's time that is not a string Date.parse reads is none.
function coordStateOf(data: unknown): CoordinatorState {
  const file: Readonly<Record<string, unknown>> = isRecord(data) ? data : {};
  const status = isRecord(file.status) && typeof file.status.text === 'string' && typeof file.status.at === 'string' ? { text: file.status.text, at: file.status.at } : null;
  const questions = (Array.isArray(file.questions) ? file.questions : [])
    .filter((entry: unknown): entry is CoordinatorQuestion => isRecord(entry) && typeof entry.id === 'string' && typeof entry.text === 'string' && typeof entry.at === 'string')
    .map(({ id, text, at }) => ({ id, text, at }));
  const requested = file.status_requested_at;
  const statusRequestedAt = typeof requested === 'string' && Number.isFinite(Date.parse(requested)) ? requested : null;
  const landed = file.landed_today;
  const landedToday = typeof landed === 'number' && Number.isSafeInteger(landed) && landed >= 0 ? landed : null;
  return { status, questions, link: chatHref(file.link), status_requested_at: statusRequestedAt, landed_today: landedToday };
}

// Reads the state and renders the card; a read that fails keeps the card as it was (the next
// coordinator event reads again), and an answer that comes after a later read's is dropped. A
// status with another time than the last state's ends a speech; when it answers the request this
// page had open (no request left, the last state's request open), Zen speaks it.
async function readCoordinatorCard(): Promise<void> {
  coordReads += 1;
  const read = coordReads;
  try {
    const data = await getJson('api/coordinator');
    if (read === coordReads) {
      const next = coordStateOf(data);
      const asked = coordAsked();
      const statusChanged = (next.status?.at ?? null) !== (coordState?.status?.at ?? null);
      if (statusChanged) {
        coordSpeechEnd();
      }
      coordState = next;
      if (statusChanged && next.status !== null && asked === 'open' && next.status_requested_at === null) {
        coordSpeak(next.status.text, next.landed_today ?? null);
      }
      renderCoordinator();
    }
  } catch { // sf serve did not answer: the card keeps the last state read
  }
}

// A block of the status: a paragraph's lines, or a list's items.
type CoordBlock = { list: boolean; lines: string[] };

// The status's blocks. A blank line ends a block. A line that starts with "- " after any spaces is
// a list item (its text after the "- "), and items in a row make one list; a line that starts with
// two or more spaces right after an item continues it, joined with one space. Other lines make a
// paragraph, each its own line. An item after a paragraph line, or a paragraph line after an item,
// starts a new block. Each line is trimmed at its end (a \r before the line break with it).
function coordBlocks(text: string): CoordBlock[] {
  const blocks: CoordBlock[] = [];
  let open: CoordBlock | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const item = /^\s*- (.*)$/.exec(line);
    if (line === '') {
      open = null;
    } else if (item !== null) {
      if (open?.list !== true) {
        open = { list: true, lines: [] };
        blocks.push(open);
      }
      open.lines.push(item[1]!);
    } else if (open?.list === true && /^ {2}/.test(line)) {
      open.lines[open.lines.length - 1] += ` ${line.trimStart()}`;
    } else {
      if (open?.list !== false) {
        open = { list: false, lines: [] };
        blocks.push(open);
      }
      open.lines.push(line);
    }
  }
  return blocks;
}

// A long status's preview: its first block, at most COORD_PREVIEW_LINES of its lines; when those
// lines, joined with a line break each, hold more than COORD_PREVIEW_CHARS characters, the first
// ones cut before the last space among them (whole without one), the end trimmed and "…" added,
// split back into the block's lines. long: the preview leaves something out (a second block, a
// further line, or a cut), and the card offers Show all.
function coordPreview(blocks: CoordBlock[]): { blocks: CoordBlock[]; long: boolean } {
  const [first] = blocks;
  if (first === undefined) {
    return { blocks: [], long: false };
  }
  let lines = first.lines.slice(0, COORD_PREVIEW_LINES);
  const chars = [...lines.join('\n')];
  const cut = chars.length > COORD_PREVIEW_CHARS;
  if (cut) {
    const head = chars.slice(0, COORD_PREVIEW_CHARS).join('');
    const space = head.lastIndexOf(' ');
    lines = `${(space >= 0 ? head.slice(0, space) : head).trimEnd()}…`.split('\n');
  }
  return { blocks: [{ list: first.list, lines }], long: cut || blocks.length > 1 || first.lines.length > COORD_PREVIEW_LINES };
}

// The tickets a status word links to, keyed by "<ws>/<ticket>" and by each bare ticket name one
// workspace alone has: a ticket of the board's Queue opens its ticket page, else a job its job page.
// None before the tickets arrive (the next board render draws the links).
function coordTickets(): Map<string, { href: string; title: string }> {
  const found = new Map<string, { href: string; title: string }>();
  if (state.tickets === null) {
    return found;
  }
  for (const row of state.tickets) {
    if (isPlanned(row)) {
      found.set(keyOf(row), { href: `#${jobPath(keyOf(row))}/ticket`, title: row.title });
    }
  }
  for (const job of state.jobs) {
    if (!found.has(keyOf(job))) {
      found.set(keyOf(job), { href: `#${jobPath(keyOf(job))}`, title: titleOf(job) });
    }
  }
  const names = new Map<string, string[]>();
  for (const key of found.keys()) {
    const name = key.slice(key.indexOf('/') + 1);
    names.set(name, [...(names.get(name) ?? []), key]);
  }
  for (const [name, keys] of names) {
    if (keys.length === 1 && !found.has(name)) {
      found.set(name, found.get(keys[0]!)!);
    }
  }
  return found;
}

// A word of a status line: a longest run of letters, digits, ".", "_", "-" and "/"; its dots at
// the end are a full stop, not the word's.
const COORD_WORD = /[A-Za-z0-9._/-]+/g;

// One line of the status as nodes: text, and each word that is a ticket of tickets as a link
// (its title as the tooltip, data-coord-focus t<n> by drawn.links), followed at the ticket's first
// mention by its title, muted. mentioned holds the tickets (their hrefs) already shown with their
// title, one set for the whole status in order.
function coordLine(text: string, tickets: ReadonlyMap<string, { href: string; title: string }>, mentioned: Set<string>, drawn: { links: number }): Node[] {
  const nodes: Node[] = [];
  let at = 0;
  for (const match of text.matchAll(COORD_WORD)) {
    const word = match[0].replace(/\.+$/, '');
    const ticket = tickets.get(word);
    if (word === '' || ticket === undefined) {
      continue;
    }
    if (match.index > at) {
      nodes.push(document.createTextNode(text.slice(at, match.index)));
    }
    const link = el('a', 'coord-tk', word);
    link.href = ticket.href;
    link.setAttribute('title', ticket.title);
    link.dataset.coordFocus = `t${drawn.links}`;
    drawn.links += 1;
    nodes.push(link);
    if (!mentioned.has(ticket.href)) {
      mentioned.add(ticket.href);
      nodes.push(el('span', 'coord-ttl', ` (${ticket.title})`));
    }
    at = match.index + word.length;
  }
  if (at < text.length) {
    nodes.push(document.createTextNode(text.slice(at)));
  }
  return nodes;
}

// The card: hidden before the first read; one muted line when the coordinator never reported;
// else the title (with the Zen lights after its text, lit while coordZenLit is set or a request
// for a status is open) and a box with the status (a p per paragraph, a ul per list; a long one's
// preview until Show all), Show all or Show less when the preview leaves something out, the muted
// line "The coordinator is not answering (no status in 2 minutes)" when a request for a status went
// unanswered, the footer (the status's age, muted with "quiet since <time>" after two hours, at the
// left; Open the chat at the right), and the open questions in the order asked, each with its age.
// An open question gives the card its accent border. Every board render draws it again; the element that
// had the focus inside it (by its data-coord-focus) has it again after.
function renderCoordinator(): void {
  const card = byId('coord');
  card.hidden = coordState === null;
  if (coordState === null) {
    return;
  }
  coordAskWatch();
  // The link was checked when it was read (coordStateOf).
  const { status, questions, link: href } = coordState;
  card.classList.toggle('asks', questions.length > 0);
  if (status === null && questions.length === 0 && href === null) {
    card.replaceChildren(el('p', 'coord-none muted', 'The coordinator has not reported (sf coordinator)'));
    return;
  }
  const focused = closestOf(document.activeElement, '#coord [data-coord-focus]')?.dataset.coordFocus ?? null;
  const box = el('div', 'coord-box');
  const foot = el('div', 'coord-foot');
  const quiet = status !== null && Date.now() - Date.parse(status.at) > COORD_QUIET_MS;
  const text = el('div', status === null || quiet ? 'coord-status muted' : 'coord-status', status === null ? 'No status' : undefined);
  text.id = 'coord-text';
  box.append(text);
  if (status !== null) {
    const blocks = coordBlocks(status.text);
    const preview = coordPreview(blocks);
    const tickets = coordTickets();
    const mentioned = new Set<string>();
    const drawn = { links: 0 };
    for (const block of preview.long && !coordOpen ? preview.blocks : blocks) {
      const lines = block.lines.map((line) => coordLine(line, tickets, mentioned, drawn));
      if (block.list) {
        const list = el('ul');
        list.append(...lines.map((nodes) => {
          const item = el('li');
          item.append(...nodes);
          return item;
        }));
        text.append(list);
      } else {
        const paragraph = el('p');
        lines.forEach((nodes, index) => paragraph.append(...(index > 0 ? [document.createTextNode('\n')] : []), ...nodes));
        text.append(paragraph);
      }
    }
    if (preview.long) {
      const more = button('linkish coord-more', coordOpen ? 'Show less' : 'Show all', { coordFocus: 'more' });
      more.setAttribute('aria-expanded', String(coordOpen));
      more.setAttribute('aria-controls', 'coord-text');
      more.addEventListener('click', () => {
        coordOpen = !coordOpen;
        renderCoordinator();
        card.querySelector<HTMLElement>('[data-coord-focus="more"]')?.focus();
      });
      box.append(more);
    }
    const age = el('span', 'coord-age', quiet ? 'quiet since ' : ago(status.at));
    if (quiet) {
      age.append(sinceEl(status.at));
    }
    foot.append(age);
  }
  if (href !== null) {
    const chat = tabLink('btn linkbtn coord-chat', 'Open the chat', href);
    chat.dataset.coordFocus = 'chat';
    foot.append(chat);
  }
  if (coordAsked() === 'late') {
    box.append(el('div', 'coord-late muted', 'The coordinator is not answering (no status in 2 minutes)'));
  }
  if (foot.children.length > 0) {
    box.append(foot);
  }
  if (questions.length > 0) {
    const list = el('ul', 'coord-qs');
    list.setAttribute('aria-label', 'Questions for you');
    list.append(...questions.map((question) => {
      const row = el('li', 'coord-q');
      row.append(el('span', 'coord-qtext', question.text), el('span', 'coord-age', ago(question.at)));
      return row;
    }));
    box.append(list);
  }
  const title = el('h2', 'coord-title', 'Coordinator');
  title.append(coordZen());
  card.replaceChildren(title, box);
  if (focused !== null) {
    card.querySelector<HTMLElement>(`[data-coord-focus="${focused}"]`)?.focus();
  }
}
