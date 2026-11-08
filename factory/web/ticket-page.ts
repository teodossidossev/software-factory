// ticket-page.js, the dashboard's sixth script (DASHBOARD_SCRIPTS in src/dashboard.ts), built from
// web/ticket-page.ts into dist/web/ (SF-149): the Markdown preview, the planned ticket page and a
// ticket's images. A classic script, loaded in order with defer, sharing the page's globals with
// the others. This file has no import or export on purpose: the compiler keeps it a script, so its
// top-level names stay the page's globals.
'use strict';

// ---------- Markdown preview (the prototype's md and inl, as DOM nodes) ----------

// Inline Markdown as nodes: `code`, **bold**, *italic* and [text](http(s) link); anything else is
// text. Never HTML from the text; a link opens only an http(s) URL, in a new tab.
const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*\n]+)\*\*|(?<![*\w])\*([^*\n]+)\*(?!\w)/g;
function inl(text: unknown): Node[] {
  const value = String(text);
  const nodes: Node[] = [];
  let at = 0;
  for (const match of value.matchAll(INLINE)) {
    if (match.index > at) {
      nodes.push(document.createTextNode(value.slice(at, match.index)));
    }
    // One of the five groups matched: a link's label comes with its href, and the last one is
    // italic's.
    const [, code, label, href, bold, italic] = match;
    if (code !== undefined) {
      nodes.push(el('code', '', code));
    } else if (label !== undefined) {
      const link = el('a', '', label);
      link.href = href ?? '';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      nodes.push(link);
    } else if (bold !== undefined) {
      nodes.push(el('b', '', bold));
    } else {
      nodes.push(el('i', '', italic));
    }
    at = match.index + match[0].length;
  }
  if (at < value.length) {
    nodes.push(document.createTextNode(value.slice(at)));
  }
  return nodes;
}

// The heading tags of # to ####, by the count of #.
const HEADINGS = ['h1', 'h2', 'h3', 'h4'] as const;

// A Markdown text as a div.md: headings (# to ####), lists and task lists, code fences, tables
// and paragraphs, their text through inl. mark(line, body) may give a list item a class.
function md(text: unknown, mark?: (line: string, body: string) => string): HTMLElement {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const out = el('div', 'md');
  let list: HTMLOListElement | HTMLUListElement | null = null;
  let para: string[] = [];
  const withText = <T extends HTMLElement>(node: T, value: string): T => {
    node.append(...inl(value));
    return node;
  };
  const flushP = (): void => {
    if (para.length > 0) {
      out.append(withText(el('p'), para.join(' ')));
      para = [];
    }
  };
  const closeL = (): void => {
    list = null;
  };
  // The line at an index of lines: every index read is below lines.length.
  const lineAt = (index: number): string => lines[index] ?? '';
  let i = 0;
  while (i < lines.length) {
    const line = lineAt(i);
    if (/^```/.test(line)) {
      flushP();
      closeL();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lineAt(i))) {
        buf.push(lineAt(i));
        i += 1;
      }
      i += 1;
      const pre = el('pre');
      pre.append(el('code', '', buf.join('\n')));
      out.append(pre);
      continue;
    }
    const heading = /^(#{1,4}) (.*)$/.exec(line);
    if (heading !== null) {
      flushP();
      closeL();
      // The pattern's groups always match: one to four #, then the text.
      out.append(withText(el(HEADINGS[(heading[1] ?? '').length - 1] ?? 'h4'), heading[2] ?? ''));
      i += 1;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flushP();
      closeL();
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lineAt(i))) {
        rows.push(lineAt(i));
        i += 1;
      }
      const table = el('table');
      rows.filter((row) => !/^\s*\|[\s:|-]+\|\s*$/.test(row)).forEach((row, index) => {
        const tr = el('tr');
        tr.append(...row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => withText(el(index === 0 ? 'th' : 'td'), cell.trim())));
        table.append(tr);
      });
      out.append(table);
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item !== null) {
      flushP();
      // The pattern's groups always match: the marker, then the item's text.
      const kind = /\d/.test(item[2] ?? '') ? 'OL' : 'UL';
      if (list === null || list.tagName !== kind) {
        list = el(kind === 'OL' ? 'ol' : 'ul');
        out.append(list);
      }
      let body = item[3] ?? '';
      i += 1;
      while (i < lines.length && /^\s{2,}\S/.test(lineAt(i)) && !/^\s*([-*+]|\d+[.)])\s+/.test(lineAt(i))) {
        body += ` ${lineAt(i).trim()}`;
        i += 1;
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
      const extra = typeof mark === 'function' ? mark(line, body) : '';
      if (task !== null) {
        const entry = el('li', `task${extra ? ` ${extra}` : ''}`);
        const box = el('input');
        box.type = 'checkbox';
        box.disabled = true;
        box.checked = task[1] !== ' ';
        entry.append(box, document.createTextNode(' '), ...inl(task[2]));
        list.append(entry);
      } else {
        list.append(withText(el('li', extra || ''), body));
      }
      continue;
    }
    if (line.trim() === '') {
      flushP();
      closeL();
      i += 1;
      continue;
    }
    closeL();
    para.push(line);
    i += 1;
  }
  flushP();
  return out;
}

// The front matter of a Task file and its body (the prototype's fmParse): the page previews the body.
function fmParse(text: string): { fm: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const fm: Record<string, string> = {};
  if (match !== null) {
    // The pattern's group always matches: the front matter's lines.
    for (const line of (match[1] ?? '').split(/\r?\n/)) {
      const kv = /^(\w+):\s*(.*)$/.exec(line);
      if (kv !== null) {
        fm[kv[1] ?? ''] = (kv[2] ?? '').trim();
      }
    }
  }
  return { fm, body: match !== null ? text.slice(match[0].length) : text };
}

// ---------- The planned ticket page (SF-081, the prototype's renderTicket, tkState, tkHistory, tkAction) ----------

// The page's own record of a ticket (TK).
interface TicketEditor {
  text: string;
  saved: string;
  sha256: string;
  tab: 'edit' | 'preview';
  showPara: boolean;
  edited: boolean;
  conflict: boolean;
}

// What the page keeps per ticket while the dashboard is open: the editor's text, the text and the
// sha256 of the version it started from (Save sends it; another version on disk is task_changed),
// the tab, whether the paraphrase is shown whole, whether this page saved it, and a conflict.
const TK: Record<string, TicketEditor> = {};
// The words of a finding's kind and of a dependency's state (SF-084's states).
const KIND_WORD: Readonly<Record<string, string>> = { decision: 'needs a decision', contradiction: 'contradicts itself', missing: 'something is missing', overreach: 'does more than asked', unclear: 'unclear' };
const WAIT_WORD: Readonly<Record<string, string>> = { merged: 'merged', pushed: 'pushed, not merged yet', running: 'running', planned: 'planned, not started', missing: 'unknown ticket' };
const waitWord = (stateName: string): string => WAIT_WORD[stateName] ?? WAIT_WORD.missing ?? '';
// The help line of each card of the page.
const TK_HELP = {
  base: 'The job\'s branch is created from this branch. A feature branch when this ticket needs work that is not merged yet.',
  files: 'The files the job is expected to create, change or delete. A change to a file outside this list needs your OK before it can ship. 🔒 marks a sensitive file (build, CI, packages, credentials) the ticket is allowed to change.',
  noList: 'No list: the job may change any file, and nothing is checked.',
  lock: '🔒 marks a sensitive file (build, CI, packages, credentials) the ticket is allowed to change.',
  waits: 'These tickets should be merged before this one starts; Start now still starts it.',
  noWaits: 'Nothing: it can start now.',
  check: 'A read-only Claude session reads only this plan and the code, and says whether an Implementer could build it without making a design decision of its own. About $0.50. It only advises.',
  history: 'What happened to this plan.',
  images: (ticket: string): string => `Screenshots for the plan: PNG, JPEG, WebP or GIF, at most 5 MB each and 10 per ticket. ChatGPT reads them with read_attachment; the Task file refers to one as ![what it shows](${ticket}/<name>).`,
};
// "Nov 5, 14:03" of a timestamp, in the browser's time (the prototype's day); empty without one.
const day = (ts: unknown): string => (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))
  ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '');

// The page's payload and its check, as loadTicket and tkReadCheck store them (core.ts types them
// unknown): a TicketPage that passed loadTicket's check, and a CheckView.
const tkData = (): TicketPage | null => state.tk.data as TicketPage | null;
const tkCheckView = (): CheckView | null => state.tk.check as CheckView | null;

// The page's state of a ticket (TK), made from the page's Task file the first time.
function tkState(key: string): TicketEditor {
  let s = TK[key];
  if (s === undefined) {
    const task = tkData()?.task ?? { text: '', sha256: '' };
    s = { text: task.text, saved: task.text, sha256: task.sha256, tab: 'preview', showPara: false, edited: false, conflict: false };
    TK[key] = s;
  }
  return s;
}

// The page's History, newest first, as the factory recorded and read it (src/ticket-history.ts).
function tkHistory(): TicketPage['history'] {
  const history = tkData()?.history;
  return Array.isArray(history) ? history : [];
}

// The ticket's row: the board's, which the stream keeps current, else the page's.
const tkRow = (): TicketEntry | null => ticketByKey(ui.ticket) ?? tkData()?.ticket ?? null;
const tkDirty = (s: TicketEditor): boolean => s.text !== s.saved;
const tkChecking = (key: string, view: CheckView | null): boolean => state.setupPending.has(`check:${key}`) || view?.running === true;
// The dependencies not merged yet, from the page's plan.
const tkUnmerged = (): PlanDependency[] => (tkData()?.plan?.waits_for ?? []).filter((dep) => dep.merged !== true);
// The only link the page makes of the conversation: the server's ChatGPT URL.
const tkConversationUrl = (row: TicketEntry): string | null => (typeof row?.conversation?.url === 'string' && row.conversation.url.startsWith(CHATGPT_PREFILL_URL) ? row.conversation.url : null);

// Opens a planned ticket's page (the prototype's openTicket): the page is read from
// api/tickets/<ws>/<ticket>/page; a ticket that is not planned any more goes back to the board.
function openTicket(key: string): void {
  const row = ticketByKey(key);
  if (row === null) {
    return;
  }
  if (ui.job !== null) {
    leaveJob();
  }
  if (state.drawer !== null) {
    hideDrawer();
  }
  if (state.tk.key !== key) {
    state.tk = { key, data: null, check: null, error: null, load: null, textarea: null, copied: null, imageStatus: null, uploading: 0 };
  }
  ui.screen = 'ticket';
  ui.ticket = key;
  ui.job = null;
  ui.opener = key;
  ui.pending = false;
  byId('job').hidden = true;
  byId('board').hidden = true;
  byId('digest').hidden = true;
  leaveDigest();
  byId('stats').hidden = true;
  const page = byId('ticket');
  page.hidden = false;
  renderTicket();
  setHash();
  page.querySelector<HTMLElement>('[data-back]')?.focus();
  void loadTicket(key, false);
}

// Whether a read payload is the ticket page's: an object whose task has its text.
const isTicketPage = (data: unknown): data is TicketPage => isRecord(data) && isRecord(data.task) && typeof data.task.text === 'string';

// Reads the page's payload. The editor keeps unsaved changes and the version they started from;
// without changes (or with reset, the conflict's Reload) it follows the file.
async function loadTicket(key: string, reset: boolean): Promise<void> {
  const load = {};
  state.tk.load = load;
  let response: Response | null = null;
  let data: unknown = null;
  let failure: string | null = null;
  try {
    response = await fetch(`api/tickets/${jobPath(key)}/page`, { cache: 'no-store' });
    data = response.ok ? await response.json() : null;
  } catch (error) {
    failure = errorMessage(error);
  }
  if (state.tk.load !== load || ui.screen !== 'ticket' || ui.ticket !== key) {
    return;
  }
  state.tk.load = null;
  if (response?.status === 404) {
    // Not planned any more (started, archived or deleted elsewhere).
    toast({ level: 'info', text: `${key} is not a planned ticket any more.` });
    back();
    return;
  }
  if (failure !== null || !isTicketPage(data)) {
    // Without a failure the fetch answered: response is set.
    state.tk.error = failure !== null || response === null ? `The ticket could not be read (${failure}).` : `The ticket could not be read (HTTP ${response.status}).`;
    renderTicket();
    return;
  }
  state.tk.error = null;
  state.tk.data = data;
  state.tk.check = data.check ?? null;
  const s = tkState(key);
  if (reset || !tkDirty(s)) {
    s.text = data.task.text;
    s.saved = data.task.text;
    s.sha256 = data.task.sha256;
    s.conflict = false;
  }
  renderTicket();
}

// The tickets changed (the stream): the page follows its row (title, draft, check, dependencies).
// When changed (the tickets the event names, SF-140) is null or names the page's ticket, it reads
// the check again, so a check that ends while the page is open shows at once, and reads the page
// again (a plan written meanwhile, its history; unsaved edits stay, with the version they started
// from). A ticket that left the Queue goes back to the board, unless its start is on the way to
// its job.
function refreshTicket(changed: ReadonlyArray<{ workspace: string; ticket: string }> | null = null): void {
  const data = tkData();
  if (ui.screen !== 'ticket' || data === null) {
    return;
  }
  const key = ui.ticket;
  const row = ticketByKey(key);
  if (row === null || !isPlanned(row)) {
    if (state.goAfterStart !== key) {
      back();
    }
    return;
  }
  for (const dep of data.plan?.waits_for ?? []) {
    const fresh = (row.lands_after ?? []).find((other) => (other.workspace === row.workspace ? other.ticket : keyOf(other)) === dep.ticket);
    if (fresh !== undefined) {
      dep.state = fresh.state;
      dep.merged = fresh.state === 'merged';
    }
  }
  data.ticket = row;
  renderTicket();
  // The page is open on a ticket: ui.ticket is its key.
  if (key === null || (changed !== null && !changed.some((other) => keyOf(other) === key))) {
    return;
  }
  void tkReadCheck(key);
  if (state.tk.load === null) {
    void loadTicket(key, false);
  }
}

// GET api/tickets/<ws>/<ticket>/check: the check as it is now (none without the Task checks).
async function tkReadCheck(key: string): Promise<void> {
  if (tkData()?.check === null) {
    return;
  }
  const view = await readCheck(key);
  if (view !== null && ui.screen === 'ticket' && ui.ticket === key && tkData() !== null) {
    state.tk.check = view;
    renderTicket();
  }
}

// The counts of a check's findings by severity (the job's Task toggle counts with it too).
function tkCounts(output: CheckOutput | null | undefined): { blocker: number; major: number; nit: number } {
  const counts = { blocker: 0, major: 0, nit: 0 };
  for (const item of output?.findings ?? []) {
    counts[item.severity] = (counts[item.severity] ?? 0) + 1;
  }
  return counts;
}

// The plan check in words, as the header's line says it; empty without the Task checks.
function tkCheckWord(row: TicketEntry, view: CheckView | null): string {
  if (view === null) {
    return '';
  }
  if (row.draft) {
    return 'Plan not written yet';
  }
  if (tkChecking(keyOf(row), view)) {
    return 'Checking the plan…';
  }
  // A Task that needs no check (SF-130): the board's summary says so, with checkNeed's reason.
  if (row.check?.state === 'not_needed') {
    return `Plan check not needed: ${row.check.check_reason ?? ''}`;
  }
  const record = view.check;
  if (record === null) {
    return 'Plan not checked yet';
  }
  const output = record.output;
  const counts = tkCounts(output);
  const word = output === null || record.status === 'failed' ? 'Plan check failed'
    : output.verdict === 'ready' ? 'Plan ready' : `Plan not ready: ${counted(counts.blocker, 'blocker')}, ${counted(counts.major, 'major')}`;
  return `${word}${view.stale ? ' · the plan changed after this check' : ''}`;
}

// The header (the prototype's renderTicket header): ← Board, the key, the workspace, the title and
// the draft tag; the conversation, Check the plan and Start now; the line with what it waits for,
// where it starts from and the plan check in words.
function tkHead(key: string, row: TicketEntry, view: CheckView | null): HTMLElement {
  const backButton = button('btn back', '← Board ', { back: '' });
  backButton.append(el('span', 'kbd', 'Esc'));
  backButton.setAttribute('title', 'Back to the board (Esc)');
  const t1 = el('div', 't1');
  const title = el('span', 'title', row.title);
  title.setAttribute('title', row.title);
  t1.append(el('span', 'key', row.ticket), wsChip(row.workspace), title);
  if (row.draft) {
    t1.append(el('span', 'tag', 'draft'));
  }
  const tools = el('div', 'tools');
  const url = tkConversationUrl(row);
  if (url !== null) {
    const link = el('a', 'btn linkbtn', 'Open the ChatGPT conversation ↗');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    tools.append(link);
  }
  if (view !== null) {
    const checking = tkChecking(key, view);
    const check = button('btn', checking ? 'Checking…' : view.check !== null ? 'Check again' : 'Check the plan', { tk: 'check' });
    check.disabled = checking || row.draft;
    check.setAttribute('title', row.draft ? 'The plan is not written yet' : 'A read-only Claude session reads the plan and the code and says whether it is ready; it only advises');
    tools.append(check);
  }
  const open = tkUnmerged();
  const start = button('btn primary', 'Start now', { tk: 'start' });
  start.disabled = row.draft || state.setupPending.has(`ticket:${key}`) || state.startHolds.has(key) || state.ticketConfirm !== null;
  if (row.draft) {
    start.setAttribute('title', 'Waiting for the plan: the Context owner has not written the Task file yet');
  } else if (open.length > 0) {
    start.setAttribute('title', `Waits for ${open.map((dep) => dep.ticket).join(', ')}`);
  }
  tools.append(start);
  const t2 = el('div', 't2');
  if (open.length > 0) {
    t2.append(el('span', 'sentence', `waits for ${open.map((dep) => dep.ticket).join(', ')}`));
  }
  t2.append(el('span', '', `Starts from ${tkData()?.plan?.starts_from ?? row.base}`));
  const word = tkCheckWord(row, view);
  if (word !== '') {
    t2.append(el('span', '', word));
  }
  const head = el('header', 'jhead');
  head.append(backButton, t1, tools, t2);
  return head;
}

// The editor, kept across redraws so the caret and the scroll stay.
function tkTextarea(key: string, s: TicketEditor): HTMLTextAreaElement {
  let box = state.tk.textarea;
  if (box === null || box === undefined) {
    box = el('textarea', 'mdedit fld');
    box.id = 'tkText';
    box.setAttribute('aria-label', `The Task file of ${key}, front matter included`);
    box.setAttribute('spellcheck', 'false');
    state.tk.textarea = box;
  }
  if (box.value !== s.text) {
    box.value = s.text;
  }
  return box;
}

// Edit | Preview, "Unsaved changes" and Save.
function tkTabs(key: string, s: TicketEditor): HTMLElement {
  const bar = el('div', 'edtabs');
  bar.setAttribute('role', 'tablist');
  const tabs: ReadonlyArray<[TicketEditor['tab'], string]> = [['edit', 'Edit'], ['preview', 'Preview']];
  for (const [tab, text] of tabs) {
    const node = button(s.tab === tab ? 'on' : '', text, { tktab: tab });
    node.setAttribute('role', 'tab');
    node.setAttribute('aria-selected', String(s.tab === tab));
    bar.append(node);
  }
  bar.append(el('span', 'grow'));
  if (tkDirty(s)) {
    bar.append(el('span', 'muted fs12 self-center', 'Unsaved changes'));
  }
  const saving = state.setupPending.has(`save:${key}`);
  const save = button('btn small', saving ? 'Saving…' : 'Save', { tk: 'save' });
  save.disabled = !tkDirty(s) || saving;
  save.setAttribute('title', 'Write the Task file (Ctrl+S while editing)');
  bar.append(save);
  return bar;
}

// The left card: the Task file, previewed (the body, without the front matter) or edited whole.
function tkFileCard(key: string, row: TicketEntry, s: TicketEditor): HTMLElement {
  const card = el('div', 'card2');
  const h3 = el('h3', '', 'Task file ');
  h3.append(el('span', 'mono plain', `.software-factory/${row.ticket}.md`));
  if (s.edited) {
    h3.append(el('span', 'edited', 'edited by you'));
  }
  card.append(h3, tkTabs(key, s));
  if (s.conflict) {
    const conflict = el('div', 'notline bad');
    conflict.append(el('span', 'err-text fs13', 'Not saved: the Task file changed since this page read it (the Context owner or the factory wrote it). Reload it to edit the current version; your changes here are replaced, so copy them first to keep them. '),
      button('btn small', 'Reload', { tk: 'reload' }));
    card.append(conflict);
  }
  card.append(s.tab === 'edit' ? tkTextarea(key, s) : md(fmParse(s.text).body));
  return card;
}

// A read-only card of the plan: its title, its content and a short help line.
function tkCard(title: string | HTMLElement, help: string | null, ...content: Node[]): HTMLElement {
  const card = el('div', 'card2');
  card.append(typeof title === 'string' ? el('h3', '', title) : title, ...content);
  if (help !== null) {
    card.append(el('span', 'hint', help));
  }
  return card;
}

// Files it will change: scope and may_touch in one list, one path or pattern per row, 🔒 on a
// may_touch one.
function tkFiles(plan: TicketPlan): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  if (plan.files.length > 0) {
    const list = el('ul', 'flist');
    for (const file of plan.files) {
      const item = el('li', 'mono', file.path);
      if (file.sensitive) {
        const lock = el('span', 'lock', '🔒');
        lock.setAttribute('title', 'Sensitive file, on the list on purpose');
        lock.setAttribute('aria-label', 'Sensitive file, on the list on purpose');
        item.append(lock);
      }
      list.append(item);
    }
    nodes.push(list);
  }
  if (!plan.scoped) {
    nodes.push(el('span', 'fs13', TK_HELP.noList));
  }
  return nodes;
}

// The Files card's help line: the list's meaning with a scope; without one, only the lock's, when
// a may_touch row shows it.
function tkFilesHelp(plan: TicketPlan): string | null {
  if (plan.scoped) {
    return TK_HELP.files;
  }
  return plan.files.some((file) => file.sensitive) ? TK_HELP.lock : null;
}

// Waits for: each ticket with its state in words, ✓ once merged.
function tkWaits(plan: TicketPlan): HTMLElement[] {
  if (plan.waits_for.length === 0) {
    return [el('span', 'fs13', TK_HELP.noWaits)];
  }
  return plan.waits_for.map((dep) => {
    const row = el('div', 'dep');
    row.append(el('span', dep.merged ? 'ok' : 'wait', dep.merged ? '✓' : '◷'), el('span', 'mono', dep.ticket), el('span', 'muted', waitWord(dep.state)));
    return row;
  });
}

// The plan-check rounds of the ticket, every version (SF-130): "N rounds · $X" ("at least $X" when a
// cost is unknown), or "no rounds yet".
function tkRounds(): HTMLElement {
  const data = tkData();
  const rounds = typeof data?.check_rounds === 'number' ? data.check_rounds : 0;
  if (data === null || rounds === 0) {
    return el('div', 'muted fs12 tk-rounds', 'no rounds yet');
  }
  return el('div', 'muted fs12 tk-rounds', roundsText(rounds, data.check_usd, data.check_usd_complete !== false, money));
}

// Plan-check rounds and their cost in words (SF-130): "N rounds · $X", "at least $X" when a cost
// is unknown; format: the page's money or the Stats page's.
const roundsText = (rounds: number, usd: number, complete: boolean, format: (value: number) => string): string => `${counted(rounds, 'round')} · ${complete ? format(usd) : `at least ${format(usd)}`}`;

// The Plan check card: the result in words, the findings with their kind in words, what the checker
// understood (clamped) and the files it expects to change; the date, model and cost; the rounds and
// their cost (SF-130). A Task that needs no check (SF-130) says why instead of a result.
function tkCheckCard(key: string, row: TicketEntry, view: CheckView, s: TicketEditor): HTMLElement {
  const record = view.check;
  const output = record?.output ?? null;
  const failed = record !== null && (output === null || record.status === 'failed');
  const notNeeded = row.check?.state === 'not_needed';
  const h3 = el('h3', '', 'Plan check ');
  if (notNeeded) {
    h3.append(el('span', 'tag', 'not needed'));
  } else if (record === null) {
    h3.append(el('span', 'tag', 'not checked'));
  } else {
    // A record without an output is failed.
    h3.append(failed || output === null ? el('span', 'verdict stop', 'failed') : output.verdict === 'ready' ? el('span', 'verdict clean', 'ready') : el('span', 'verdict fix', 'not ready'));
    if (view.stale) {
      const stale = el('span', 'tag', 'stale');
      stale.setAttribute('title', 'The Task file changed after this check');
      h3.append(stale);
    }
  }
  const content: HTMLElement[] = [];
  const checking = tkChecking(key, view);
  if (checking) {
    content.push(el('p', 'fs13', 'Checking… a read-only session reads the plan and the code.'));
  }
  if (notNeeded) {
    if (!checking) {
      content.push(el('p', 'fs13', `Not needed: ${row.check?.check_reason ?? ''}. It starts from the queue without a check; Check the plan runs one anyway.`));
    }
    content.push(tkRounds());
    return tkCard(h3, TK_HELP.check, ...content);
  }
  if (record === null) {
    if (!checking) {
      content.push(el('p', 'fs13', row.draft ? 'Not checked yet. The plan is checked once the Context owner has written it.' : 'Not checked yet.'));
    }
    content.push(tkRounds());
    return tkCard(h3, TK_HELP.check, ...content);
  }
  if (view.stale) {
    content.push(el('p', 'fs13 err-text', 'The plan changed after this check: check it again.'));
  }
  if (failed || output === null) {
    content.push(el('p', 'fs13', `The check failed: ${record.error ?? 'unknown error'}`));
  } else {
    const counts = tkCounts(output);
    content.push(el('p', 'fs13', output.verdict === 'ready'
      ? 'Ready: an Implementer can build this plan without a design decision of its own.'
      : `Not ready: ${counted(counts.blocker, 'blocker')}, ${counted(counts.major, 'major')}.`));
    if (output.findings.length > 0) {
      const list = el('ul', 'findings');
      output.findings.forEach((item, index) => {
        const entry = el('li', 'finding');
        const problem = el('div', 'problem');
        problem.append(el('span', 'muted mono fs12', item.where ?? ''), el('br'), ...prose(item.problem));
        entry.append(el('span', 'fid', `#${index + 1}`), el('span', `sev sev-${item.severity}`, item.severity), el('span', 'tag', KIND_WORD[item.kind] ?? item.kind), problem);
        if (item.expected) {
          const expected = el('div', 'expected', 'Expected: ');
          expected.append(...prose(item.expected));
          entry.append(expected);
        }
        list.append(entry);
      });
      content.push(list);
    }
    const understood = el('div');
    understood.append(el('b', 'fs12', 'What the checker understood'), el('div', `prose para${s.showPara ? '' : ' clamped'}`, output.paraphrase),
      button('linkish', s.showPara ? 'Show less' : 'Show all', { tk: 'para' }));
    content.push(understood);
    if (output.files.length > 0) {
      const details = el('details');
      details.append(el('summary', 'pointer fs13', `Files the checker expects to change (${output.files.length})`));
      const chips = el('div', 'chipsx mt6');
      chips.append(...output.files.map((file) => {
        const chip = el('span', 'chipx', `${file.action === 'create' ? '+' : file.action === 'delete' ? '−' : '~'} ${file.path}`);
        chip.setAttribute('title', file.action);
        return chip;
      }));
      details.append(chips);
      content.push(details);
    }
  }
  content.push(el('span', 'muted fs12', `${day(record.ended_at)} · ${record.model ?? 'default model'} · ${money(record.cost_usd)}`), tkRounds());
  return tkCard(h3, TK_HELP.check, ...content);
}

// Planning conversation: the link, the first message and its Copy.
function tkConversation(row: TicketEntry): HTMLElement {
  const url = tkConversationUrl(row);
  const message = typeof row.conversation?.message === 'string' ? row.conversation.message : '';
  const content: HTMLElement[] = [];
  if (url !== null) {
    const link = el('a', 'fs13', 'Open the ChatGPT conversation ↗');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    content.push(link);
  } else {
    content.push(el('span', 'fs13', 'The first message is too long for a link: copy it into a new ChatGPT conversation of this project.'));
  }
  const head = el('div', 'cmhead');
  const status = el('span', 'muted fs12', state.tk.copied ?? '');
  status.setAttribute('role', 'status');
  head.append(el('b', 'fs12', 'First message'), button('btn small', 'Copy', { tk: 'copy' }), status);
  const fallback = el('textarea', 'copy-fallback');
  fallback.id = 'tk-copy-text';
  fallback.readOnly = true;
  fallback.hidden = true;
  fallback.setAttribute('aria-label', 'The first message');
  content.push(head, el('pre', 'cm', message), fallback);
  return tkCard('Planning conversation', null, ...content);
}

// History: what the factory recorded and read, newest first.
function tkHistoryCard(): HTMLElement {
  const list = el('ul', 'hist');
  list.append(...tkHistory().map((entry) => {
    const item = el('li');
    const when = el('span', 't', day(entry.ts));
    if (typeof entry.ts === 'string') {
      when.setAttribute('title', entry.ts);
    }
    item.append(when, el('span', '', entry.text));
    return item;
  }));
  return tkCard('History', TK_HELP.history, list);
}

// The page (the prototype's renderTicket, with the plain labels): the header, the Task file on the
// left; on the right the plan in plain words, its check, the conversation and the history.
function renderTicket(): void {
  if (ui.screen !== 'ticket') {
    return;
  }
  const key = ui.ticket;
  const page = byId('ticket');
  const row = tkRow();
  // A row is the page's ticket: ui.ticket is its key.
  if (row === null || key === null) {
    return;
  }
  const data = tkData();
  const box = state.tk.textarea;
  const typing = box !== null && box !== undefined && document.activeElement === box;
  const caret: [number, number, number] | null = typing && typeof box.selectionStart === 'number' ? [box.selectionStart, box.selectionEnd, box.scrollTop] : null;
  const view = data === null ? null : tkCheckView();
  const grid = el('div', 'grid');
  if (data === null) {
    const waiting = el('div', 'card2');
    waiting.append(el('p', state.tk.error === null ? 'muted fs13' : 'err-text fs13', state.tk.error ?? 'Loading the ticket…'));
    if (state.tk.error !== null) {
      waiting.append(button('btn small', 'Try again', { tk: 'reload' }));
    }
    grid.append(waiting);
  } else {
    const s = tkState(key);
    const plan = data.plan;
    const side = el('div', 'stack');
    side.append(
      tkCard('Starts from', TK_HELP.base, el('span', 'mono fs13', plan.starts_from)),
      tkCard('Files it will change', tkFilesHelp(plan), ...tkFiles(plan)),
      tkCard('Waits for', plan.waits_for.length > 0 ? TK_HELP.waits : null, ...tkWaits(plan)),
    );
    if (view !== null) {
      side.append(tkCheckCard(key, row, view, s));
    }
    side.append(tkConversation(row), tkImagesCard(key, row), tkHistoryCard());
    grid.append(tkFileCard(key, row, s), side);
  }
  const form = el('div', 'form2');
  form.append(grid);
  const scroll = page.querySelector('.form2')?.scrollTop ?? 0;
  keepFocus(page, () => page.replaceChildren(tkHead(key, row, view), form));
  form.scrollTop = scroll;
  if (typing) {
    box.focus();
    if (caret !== null && typeof box.setSelectionRange === 'function') {
      box.setSelectionRange(caret[0], caret[1]);
      box.scrollTop = caret[2];
    }
  }
}

// The page's actions (the prototype's tkAction): save, check, start, para (the paraphrase whole or
// clamped), reload (the file as it is now) and copy (the first message).
function tkAction(action: string | undefined): void {
  const key = ui.ticket;
  const row = tkRow();
  // A row is the page's ticket: ui.ticket is its key.
  if (ui.screen !== 'ticket' || row === null || key === null) {
    return;
  }
  if (action === 'save') {
    void tkSave(key);
  } else if (action === 'check') {
    if (!row.draft && !tkChecking(key, tkCheckView())) {
      void checkTicket(row);
    }
  } else if (action === 'start') {
    if (!row.draft) {
      const open = tkUnmerged();
      // Start stays on: what it waits for is said in its confirmation.
      const note = open.length === 0 ? '' : ` Waits for ${open.map((dep) => `${dep.ticket} (${waitWord(dep.state)})`).join(', ')}: ${open.length === 1 ? 'it is' : 'they are'} not merged yet.`;
      openTicketConfirm('start', row, note);
    }
  } else if (action === 'para') {
    const s = tkState(key);
    s.showPara = !s.showPara;
    renderTicket();
  } else if (action === 'reload') {
    state.tk.error = null;
    renderTicket();
    void loadTicket(key, true);
  } else if (action === 'copy') {
    const message = typeof row.conversation?.message === 'string' ? row.conversation.message : '';
    // The Copy button is drawn with its textarea (tkConversation).
    copyValue(message, byIdAs('tk-copy-text', 'textarea'), (text) => {
      state.tk.copied = text;
      if (ui.screen === 'ticket' && ui.ticket === key) {
        renderTicket();
      }
    });
  }
}

// Edit | Preview: the editor gets the focus.
function tkTab(tab: string | undefined): void {
  // The tabs are drawn on the page of a ticket: ui.ticket is its key.
  if (ui.ticket === null) {
    return;
  }
  const s = tkState(ui.ticket);
  s.tab = tab === 'edit' ? 'edit' : 'preview';
  renderTicket();
  if (s.tab === 'edit') {
    state.tk.textarea?.focus();
  }
}

// Save: the whole text over the version the editor started from, once at a time. A version written
// meanwhile (task_changed) is never overwritten: the page offers to reload. A saved file makes the
// last check stale; the page is read again for its history and its check.
async function tkSave(key: string): Promise<void> {
  const s = tkState(key);
  const id = `save:${key}`;
  if (!tkDirty(s) || state.setupPending.has(id)) {
    return;
  }
  state.setupPending.add(id);
  renderTicket();
  const text = s.text;
  let outcome: Outcome;
  let saved = false;
  try {
    const result = await post(`api/tickets/${jobPath(key)}/task`, { content: text, sha256: s.sha256 });
    s.saved = text;
    s.sha256 = isRecord(result) && typeof result.sha256 === 'string' ? result.sha256 : s.sha256;
    s.edited = true;
    s.conflict = false;
    saved = true;
    const view = tkCheckView();
    const checked = view !== null && view.check !== null;
    outcome = { level: 'ok', text: `Saved .software-factory/${key.slice(key.indexOf('/') + 1)}.md.${checked ? ' The last plan check is of the version before: check it again.' : ''}` };
  } catch (error) {
    if (error instanceof ActionError && error.code === 'task_changed') {
      s.conflict = true;
      outcome = { level: 'error', text: 'Not saved: the Task file changed since this page read it. Reload it to edit the current version.' };
    } else if (error instanceof ActionError) {
      outcome = { level: 'error', text: `${error.code}: ${error.message}` };
    } else {
      outcome = { level: 'error', text: `The save failed (${errorMessage(error)}); it may have been written. Reload the page to see the file as it is.` };
    }
  }
  state.setupPending.delete(id);
  toast(outcome);
  renderTicket();
  if (saved && ui.screen === 'ticket' && ui.ticket === key) {
    void loadTicket(key, false);
  }
}

// ---------- A ticket's images (SF-064): the planned ticket page's Images card and New ticket ----------

// The server's rules (src/attachments.ts), checked here too so the page says at once why an image
// is not taken; the server checks every upload again.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 10;

// The extension of an image from its first bytes (PNG, JPEG, WebP, GIF), as the server tells it;
// null for anything else.
function sniffImage(bytes: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | null {
  const at = (offset: number, values: readonly number[]): boolean => values.every((value, index) => bytes[offset + index] === value);
  const word = (offset: number, text: string): boolean => at(offset, [...text].map((char) => char.charCodeAt(0)));
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'png';
  }
  if (at(0, [0xff, 0xd8, 0xff])) {
    return 'jpg';
  }
  if (word(0, 'GIF87a') || word(0, 'GIF89a')) {
    return 'gif';
  }
  return word(0, 'RIFF') && word(8, 'WEBP') ? 'webp' : null;
}

async function imageExtension(file: Blob): Promise<string | null> {
  return sniffImage(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
}

// The files of a paste (clipboardData) or a drop (dataTransfer), never its text: a text paste
// finds none and goes on as usual.
function eventFiles(data: DataTransfer | null | undefined): File[] {
  if (data === null || data === undefined) {
    return [];
  }
  const files = Array.from(data.files ?? []);
  if (files.length > 0) {
    return files;
  }
  return Array.from(data.items ?? []).filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => file !== null && file !== undefined);
}

// A paste into a text field that carries text too (cells copied from a spreadsheet or a word
// processor come with a picture of them) stays a text paste; a screenshot has no text.
function pastesText(event: ClipboardEvent): boolean {
  const target = event.target;
  const tag = target !== null && target !== undefined && 'tagName' in target ? target.tagName : undefined;
  return (tag === 'TEXTAREA' || tag === 'INPUT') && Array.from(event.clipboardData?.types ?? []).includes('text/plain');
}

// Whether a drag carries files.
const dragsFiles = (data: DataTransfer | null | undefined): boolean => Array.from(data?.types ?? []).includes('Files');
const fileLabel = (file: File): string => (typeof file.name === 'string' && file.name !== '' ? file.name : 'the image');
const refusalText = (error: unknown): string => (error instanceof ActionError ? `${error.code}: ${error.message}` : `${errorMessage(error)}; it may have been attached`);
const attachmentPath = (key: string, name: string): string => `api/tickets/${jobPath(key)}/attachments/${encodeURIComponent(name)}`;

// Images: the ticket's images from its row (the stream keeps it current), each opening whole in a
// new tab, with Copy image and ×, then the drop area; a paste anywhere on the page lands there too.
// No file picker (the user's decision).
function tkImagesCard(key: string, row: TicketEntry): HTMLElement {
  const images = Array.isArray(row.attachments) ? row.attachments : [];
  const content: HTMLElement[] = [];
  if (images.length > 0) {
    const thumbs = el('div', 'thumbs');
    for (const image of images) {
      const url = attachmentPath(key, image.name);
      const link = el('a', 'thumb-open');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('title', `Open ${image.name} in a new tab`);
      const img = el('img');
      img.src = url;
      img.alt = `Image ${image.name}`;
      link.append(img);
      const busy = state.setupPending.has(`image:${key}/${image.name}`);
      const copy = button('btn small', 'Copy image', { tkimg: 'copy', name: image.name });
      const remove = button('btn small', '×', { tkimg: 'remove', name: image.name });
      remove.setAttribute('aria-label', `Remove ${image.name}`);
      remove.setAttribute('title', `Remove ${image.name}`);
      remove.disabled = busy;
      const bar = el('div', 'thumb-bar');
      bar.append(el('span', 'mono fs12', image.name), copy, remove);
      const item = el('figure', 'thumb');
      item.append(link, bar);
      thumbs.append(item);
    }
    content.push(thumbs);
  } else {
    content.push(el('span', 'muted fs13', 'No image yet.'));
  }
  const uploading = state.tk.uploading;
  const drop = el('div', 'drop', uploading > 0 ? `Attaching ${counted(uploading, 'image')}…` : 'Paste an image here (Ctrl+V) or drop one.');
  drop.id = 'tkDrop';
  const status = el('span', 'muted fs12', state.tk.imageStatus ?? '');
  status.setAttribute('role', 'status');
  content.push(drop, status);
  return tkCard('Images', TK_HELP.images(row.ticket), ...content);
}

function tkImageAction(action: string | undefined, name: string | undefined): void {
  const key = ui.ticket;
  // The Images card is drawn on the page of a ticket: ui.ticket is its key.
  if (ui.screen !== 'ticket' || typeof name !== 'string' || key === null) {
    return;
  }
  if (action === 'remove') {
    void tkRemoveImage(key, name);
  } else if (action === 'copy') {
    void tkCopyImage(key, name);
  }
}

// Each image goes up at once, in order and without a name: the server tells its type and numbers
// it. The outcome is a toast; the new images reach the card through the stream.
let tkUploads: Promise<void> = Promise.resolve();
function tkAddImages(key: string, files: File[]): Promise<void> {
  if (files.length === 0) {
    return tkUploads;
  }
  state.tk.uploading += files.length;
  renderTicket();
  tkUploads = tkUploads.then(() => tkUpload(key, files)).catch((error: unknown) => console.error(error));
  return tkUploads;
}

async function tkUpload(key: string, files: File[]): Promise<void> {
  const done: string[] = [];
  const failed: string[] = [];
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      failed.push(`${fileLabel(file)} (larger than 5 MB)`);
    } else {
      try {
        const result = await postBytes(`api/tickets/${jobPath(key)}/attachments`, file);
        done.push(isRecord(result) && typeof result.name === 'string' ? result.name : fileLabel(file));
      } catch (error) {
        failed.push(`${fileLabel(file)} (${refusalText(error)})`);
      }
    }
    if (state.tk.key === key) {
      state.tk.uploading = Math.max(0, state.tk.uploading - 1);
    }
  }
  const attached = done.length > 0 ? `Attached ${done.join(', ')}.` : '';
  toast(failed.length === 0 ? { level: 'ok', text: attached } : { level: 'error', text: `${attached}${attached !== '' ? ' ' : ''}Not attached: ${failed.join('; ')}.` });
  renderTicket();
}

async function tkRemoveImage(key: string, name: string): Promise<void> {
  const id = `image:${key}/${name}`;
  if (state.setupPending.has(id)) {
    return;
  }
  state.setupPending.add(id);
  renderTicket();
  let outcome: Outcome;
  try {
    await post(`${attachmentPath(key, name)}/remove`, {});
    outcome = { level: 'ok', text: `Removed ${name}.` };
  } catch (error) {
    outcome = { level: 'error', text: error instanceof ActionError ? `${error.code}: ${error.message}` : `The removal failed (${errorMessage(error)}); it may have happened.` };
  }
  state.setupPending.delete(id);
  toast(outcome);
  renderTicket();
}

// JPEG, WebP and GIF go on the clipboard as PNG, the image type browsers take there: drawn on a
// canvas.
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') {
    return blob;
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  // A new canvas always has its 2d context; without one the copy fails as a failed drawing does.
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('the image could not be drawn');
  }
  context.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('the image could not be drawn'))), 'image/png'));
}

// Copy image: the image on the clipboard as PNG, so it can be pasted into ChatGPT by hand. The
// ClipboardItem gets the PNG as a promise, so the copy stays within the click.
async function tkCopyImage(key: string, name: string): Promise<void> {
  const say = (text: string): void => {
    state.tk.imageStatus = text;
    if (ui.screen === 'ticket' && ui.ticket === key) {
      renderTicket();
    }
  };
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.write !== 'function' || typeof ClipboardItem !== 'function') {
    say(`This browser cannot put an image on the clipboard: open ${name} and copy it there.`);
    return;
  }
  const png = (async () => {
    const response = await fetch(attachmentPath(key, name), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return asPng(await response.blob());
  })();
  png.catch(() => undefined);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    say(`Copied ${name}.`);
  } catch (error) {
    say(`${name} was not copied (${errorMessage(error)}): open it and copy it there.`);
  }
}

// The page's paste and drop: only files are taken (a text paste into the editor goes on as
// usual); New ticket's form, in the drawer, has its own.
function onPagePaste(event: ClipboardEvent): void {
  if (ui.screen !== 'ticket' || state.drawer !== null || event.defaultPrevented || tkData() === null || pastesText(event) || ui.ticket === null) {
    return;
  }
  const files = eventFiles(event.clipboardData);
  if (files.length > 0) {
    event.preventDefault();
    void tkAddImages(ui.ticket, files);
  }
}

const dropArea = (event: DragEvent): HTMLElement | null => (ui.screen === 'ticket' ? closestOf(event.target, '#tkDrop') : null);

function onPageDrag(event: DragEvent): void {
  const drop = dropArea(event);
  if (drop !== null && dragsFiles(event.dataTransfer)) {
    event.preventDefault();
    drop.classList.toggle('over', event.type === 'dragover');
  }
}

function onPageDrop(event: DragEvent): void {
  const drop = dropArea(event);
  if (drop !== null) {
    event.preventDefault();
    drop.classList.remove('over');
    // The drop area is drawn on the page of a ticket: ui.ticket is its key.
    if (ui.ticket !== null) {
      void tkAddImages(ui.ticket, eventFiles(event.dataTransfer));
    }
  }
}

// New ticket's images: pasted anywhere in the form or dropped on it, shown from blob: URLs and
// named 1.png, 2.png, … in paste order with the extension of their real type; uploaded once the
// ticket is created (submitTicket).
type NewImage = PageState['newImages'][number];
// The index is one of state.newImages.
const newImageName = (index: number): string => `${index + 1}.${state.newImages[index]?.ext ?? ''}`;
let newImagesQueue: Promise<void> = Promise.resolve();
// The pastes and drops still being read, and what they refused since none was (Create waits for
// them: Fix 3).
let newImagesReading = 0;
let newImagesRefused: string[] = [];

function addNewImages(files: File[]): Promise<void> {
  if (newImagesReading === 0) {
    newImagesRefused = [];
  }
  newImagesReading += 1;
  newImagesQueue = newImagesQueue.then(async () => {
    const refused: string[] = [];
    for (const file of files) {
      if (state.newImages.length >= MAX_IMAGES) {
        refused.push(`${fileLabel(file)} (at most ${MAX_IMAGES} images per ticket)`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        refused.push(`${fileLabel(file)} (larger than 5 MB)`);
        continue;
      }
      const ext = await imageExtension(file).catch(() => null);
      if (ext === null) {
        refused.push(`${fileLabel(file)} (not a PNG, JPEG, WebP or GIF image)`);
        continue;
      }
      state.newImages.push({ file, ext, url: URL.createObjectURL(file) });
    }
    renderNewImages();
    newImagesRefused.push(...refused);
    setSetupStatus('ticket-status', refused.length > 0 ? { level: 'error', text: `Not added: ${refused.join('; ')}.` } : null);
  }).catch((error: unknown) => console.error(error)).finally(() => {
    newImagesReading -= 1;
  });
  return newImagesQueue;
}

// Create waits for the images still being read, so each one pasted before it goes up with this
// ticket. True when one was refused meanwhile: the form says which, and Create is not sent (a second
// Create goes on without it).
async function newImagesSettled(): Promise<boolean> {
  if (newImagesReading === 0) {
    return false;
  }
  state.setupPending.add('ticket-images');
  setSetupStatus('ticket-status', { level: 'pending', text: 'Reading the pasted images…' });
  renderSetup();
  while (newImagesReading > 0) {
    await newImagesQueue;
  }
  state.setupPending.delete('ticket-images');
  renderSetup();
  if (newImagesRefused.length > 0) {
    setSetupStatus('ticket-status', { level: 'error', text: `Not added: ${newImagesRefused.join('; ')}.` });
    newImagesRefused = [];
    return true;
  }
  setSetupStatus('ticket-status', null);
  return false;
}

function removeNewImage(index: number): void {
  const [image] = state.newImages.splice(index, 1);
  if (image !== undefined) {
    URL.revokeObjectURL(image.url);
  }
  renderNewImages();
}

function renderNewImages(): void {
  const list = byId('ticket-images');
  list.replaceChildren(...state.newImages.map((image, index) => {
    const name = newImageName(index);
    const img = el('img');
    img.src = image.url;
    img.alt = `Pasted image ${name}`;
    const remove = button('btn small', '×', { newimg: String(index) });
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.setAttribute('title', `Remove ${name}`);
    remove.disabled = newImagesSending.has(image);
    const bar = el('div', 'thumb-bar');
    bar.append(el('span', 'mono fs12', name), remove);
    const item = el('figure', 'thumb');
    item.append(img, bar);
    return item;
  }));
  list.hidden = state.newImages.length === 0;
}

function onFormPaste(event: ClipboardEvent): void {
  if (pastesText(event)) {
    return;
  }
  const files = eventFiles(event.clipboardData);
  if (files.length > 0) {
    event.preventDefault();
    void addNewImages(files);
  }
}

function onFormDrag(event: DragEvent): void {
  if (dragsFiles(event.dataTransfer)) {
    event.preventDefault();
    byId('ticket-drop').classList.toggle('over', event.type === 'dragover');
  }
}

function onFormDrop(event: DragEvent): void {
  if (dragsFiles(event.dataTransfer) || eventFiles(event.dataTransfer).length > 0) {
    event.preventDefault();
    byId('ticket-drop').classList.remove('over');
    void addNewImages(eventFiles(event.dataTransfer));
  }
}

// After "Create the ticket": each image in order under the name it showed. A failed upload leaves
// the ticket created; what failed and why is returned for the form to say.
// The images Create was pressed with (Fix 4), each with the name it showed then; the form keeps
// them in place, × off, until they are uploaded or the create is refused.
interface SentImage {
  image: NewImage;
  name: string;
  file: File;
}
let newImagesSending = new Set<NewImage>();

function snapshotNewImages(): SentImage[] {
  const images = state.newImages.map((image, index) => ({ image, name: newImageName(index), file: image.file }));
  newImagesSending = new Set(images.map((entry) => entry.image));
  renderNewImages();
  return images;
}

function releaseNewImages(): void {
  newImagesSending = new Set();
  renderNewImages();
}

// images: snapshotNewImages's list, taken before the ticket was created.
async function uploadNewImages(key: string, images: SentImage[]): Promise<{ count: number; failed: string[]; sent: NewImage[] }> {
  const failed: string[] = [];
  for (const image of images) {
    try {
      await postBytes(`api/tickets/${jobPath(key)}/attachments?name=${encodeURIComponent(image.name)}`, image.file);
    } catch (error) {
      failed.push(`${image.name} (${refusalText(error)})`);
    }
  }
  return { count: images.length, failed, sent: images.map((entry) => entry.image) };
}
