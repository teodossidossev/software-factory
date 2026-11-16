// coordinator.js, a dashboard script (DASHBOARD_SCRIPTS in src/dashboard.ts) right after board.js,
// built from web/coordinator.ts into dist/web/: the Coordinator card (#coord, under Needs you on
// the Home and above the columns on the board; home.js places it). It shows what the coordinator
// (the user's Claude Code session in the factory's checkout) does now as it answers "status?":
// paragraphs and "- " lists, each ticket key of the board a link with its title; a long status
// folds to its first lines behind Show all. Under it a footer with the status's age and Open the
// chat, and the questions that wait for the user's answer. It is read-only: sf coordinator writes
// the state through sf serve; the page reads GET api/coordinator on each coordinator event of the
// stream (one on connect, one after each write: main.js), and every board render (renderBoard)
// renders the card again, so its ages and ticket links follow the board without a timer of its
// own. Every text goes in through textContent or a text node, never as HTML; a ticket link opens
// only a page of the board's own tickets; the chat link is checked again here, claude.ai only. A
// classic script, loaded in order with defer, sharing the page's globals with the others. This
// file has no import or export on purpose: the compiler keeps it a script, so its top-level names
// stay the page's globals.
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
// else the title and a box with the status (a p per paragraph, a ul per list; a long one's
// preview until Show all), Show all or Show less when the preview leaves something out, the
// footer (the status's age, muted with "quiet since <time>" after two hours, at the left; Open the
// chat at the right), and the open questions in the order asked, each with its age. An open
// question gives the card its accent border. Every board render draws it again; the element that
// had the focus inside it (by its data-coord-focus) has it again after.
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
  card.replaceChildren(el('h2', 'coord-title', 'Coordinator'), box);
  if (focused !== null) {
    card.querySelector<HTMLElement>(`[data-coord-focus="${focused}"]`)?.focus();
  }
}
