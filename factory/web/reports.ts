// reports.js, the dashboard's seventh script (DASHBOARD_SCRIPTS in src/dashboard.ts), built from
// web/reports.ts into dist/web/: the morning digest and the Stats page. A classic script,
// loaded in order with defer, sharing the page's globals with the others. This file has no import
// or export on purpose: the compiler keeps it a script, so its top-level names stay the page's
// globals.
'use strict';

// ---------- The morning digest ----------

// The Digest page (#digest, #digest/<id>): the list as last read ({running, digests}, newest first),
// the digest shown (its id; null: the newest) and its record, a read's error, the tab ('repos' or
// 'daily'), the poll's timer while a run goes, the ids known when a run was seen starting (the new
// one opens when it appears), Generate now's request, the Copy outcome per app, and the read under way.
const DIGEST_POLL_MS = 10000;
const dg: {
  list: DigestList | null;
  id: string | null;
  record: DigestRecord | null;
  error: string | null;
  tab: 'repos' | 'daily';
  poll: ReturnType<typeof setTimeout> | null;
  known: Set<string> | null;
  starting: boolean;
  copied: Map<string, { ok: boolean; text: string }>;
  load: number;
} = { list: null, id: null, record: null, error: null, tab: 'repos', poll: null, known: null, starting: false, copied: new Map(), load: 0 };

function openDigest(id: string | null): void {
  if (ui.job !== null) {
    leaveJob();
  }
  if (state.drawer !== null) {
    hideDrawer();
  }
  ui.screen = 'digest';
  ui.job = null;
  ui.ticket = null;
  ui.pending = false;
  dg.id = id;
  dg.error = null;
  if (id === null || dg.record?.id !== id) {
    dg.record = id === null && dg.list !== null && dg.record?.id === dg.list.digests[0]?.id ? dg.record : null;
  }
  byId('board').hidden = true;
  byId('job').hidden = true;
  byId('ticket').hidden = true;
  byId('stats').hidden = true;
  const page = byId('digest');
  page.hidden = false;
  renderDigest();
  setHash();
  page.querySelector<HTMLElement>('[data-back]')?.focus();
  void loadDigests();
}

// The page closes: no more polling.
function leaveDigest(): void {
  clearTimeout(dg.poll ?? undefined);
  dg.poll = null;
}

// Reads the list, then the digest shown; while a run goes, again every 10 s, and a digest that
// appears meanwhile opens.
async function loadDigests(): Promise<void> {
  dg.load += 1;
  const load = dg.load;
  clearTimeout(dg.poll ?? undefined);
  dg.poll = null;
  let list: DigestList;
  try {
    list = payload<DigestList>(await getText('api/digests'));
  } catch (error) {
    if (load === dg.load && ui.screen === 'digest') {
      dg.error = `The digests could not be read (${errorMessage(error)}).`;
      renderDigest();
    }
    return;
  }
  if (load !== dg.load || ui.screen !== 'digest') {
    return;
  }
  dg.list = list;
  dg.error = null;
  if (list.running && dg.known === null) {
    dg.known = new Set(list.digests.map((digest) => digest.id));
  }
  const known = dg.known;
  if (known !== null) {
    const fresh = list.digests.find((digest) => !known.has(digest.id));
    if (fresh !== undefined) {
      dg.known = null;
      dg.id = fresh.id;
      dg.record = null;
      setHash();
    } else if (!list.running) {
      dg.known = null;
    }
  }
  if (list.running) {
    dg.poll = setTimeout(() => void loadDigests(), DIGEST_POLL_MS);
  }
  const id = dg.id ?? list.digests[0]?.id ?? null;
  if (id !== null && dg.record?.id !== id) {
    renderDigest();
    try {
      const record = payload<DigestRecord>(await getText(`api/digests/${encodeURIComponent(id)}`));
      if (load === dg.load && ui.screen === 'digest') {
        dg.record = record;
      }
    } catch {
      if (load === dg.load && ui.screen === 'digest') {
        dg.record = null;
        dg.error = `The digest ${id} could not be read: it may be gone (digests are kept 60 days).`;
      }
    }
  }
  if (load === dg.load) {
    renderDigest();
  }
}

// Generate now: one manual run, never sent twice; the page polls until its digest appears.
async function generateNow(): Promise<void> {
  if (dg.starting || dg.list?.running === true) {
    return;
  }
  dg.starting = true;
  dg.known = new Set((dg.list?.digests ?? []).map((digest) => digest.id));
  renderDigest();
  try {
    await post('api/digests/run', {});
    toast({ level: 'info', text: 'Generating the digest; this page opens it when it is ready.' });
  } catch (error) {
    if (error instanceof ActionError && error.code === 'digest_running') {
      toast({ level: 'info', text: 'A digest is being generated already; this page opens it when it is ready.' });
    } else {
      dg.known = null;
      toast({ level: 'error', text: error instanceof ActionError ? `${error.code}: ${error.message}` : `The request failed (${errorMessage(error)}); it may have started. The page reads the list again.` });
    }
  }
  dg.starting = false;
  await loadDigests();
}

const dgTime = (ts: unknown): string => localTime(ts).slice(0, 16);
const dgCost = (cost: unknown): string => (typeof cost === 'number' ? `$${cost.toFixed(2)}` : 'cost unknown');

function renderDigest(): void {
  if (ui.screen !== 'digest') {
    return;
  }
  const page = byId('digest');
  const list = dg.list;
  const record = dg.record;
  const running = list?.running === true || dg.starting;
  const backButton = button('btn back', '← Board ', { back: '' });
  backButton.append(el('span', 'kbd', 'Esc'));
  backButton.setAttribute('title', 'Back to the board (Esc)');
  const t1 = el('div', 't1');
  t1.append(el('span', 'title', 'Morning digest'));
  const tools = el('div', 'tools');
  const newest = list?.digests[0];
  if (list !== null && newest !== undefined) {
    const pick = el('select', 'dg-pick');
    pick.setAttribute('aria-label', 'Earlier digests');
    for (const digest of list.digests) {
      const option = el('option', '', `${dgTime(digest.ended_at)} · ${digest.trigger}`);
      option.value = digest.id;
      pick.append(option);
    }
    pick.value = record?.id ?? dg.id ?? newest.id;
    pick.addEventListener('change', () => openDigest(pick.value === newest.id ? null : pick.value));
    tools.append(pick);
  }
  const generate = button('btn primary', running ? 'Generating…' : 'Generate now', { dg: 'generate' });
  generate.disabled = running;
  generate.setAttribute('title', 'Make a digest now from the latest Git data; it does not replace the day\'s scheduled one');
  generate.addEventListener('click', () => void generateNow());
  tools.append(generate);
  const t2 = el('div', 't2');
  if (record !== null) {
    t2.append(el('span', 'dg-period', `since ${dgTime(record.period.from)} · generated ${dgTime(record.ended_at)}`), el('span', 'dg-cost', dgCost(record.cost_usd)));
  }
  const head = el('header', 'jhead');
  head.append(backButton, t1, tools, t2);
  const body = el('div', 'dg-body');
  if (running) {
    body.append(el('p', 'notline', 'Generating a digest… This page opens it when it is ready.'));
  }
  if (dg.error !== null) {
    body.append(el('p', 'err-text fs13', dg.error));
  }
  if (list === null) {
    body.append(el('p', 'muted fs13', dg.error === null ? 'Loading the digests…' : ''));
  } else if (list.digests.length === 0) {
    const empty = el('div', 'card2 dg-empty');
    empty.append(el('h3', '', 'No digest yet'), el('p', 'fs13', 'Generate now makes one from the followed workspaces. sf serve makes one every day at the time set in Workspaces → Morning digest, when a workspace is followed or has My daily on.'));
    body.append(empty);
  } else if (record === null) {
    body.append(el('p', 'muted fs13', dg.error === null ? 'Loading the digest…' : ''));
  } else {
    const tabs = el('div', 'edtabs dg-tabs');
    tabs.setAttribute('role', 'tablist');
    const names: ReadonlyArray<[typeof dg.tab, string]> = [['repos', 'Repositories'], ['daily', 'My daily']];
    for (const [tab, text] of names) {
      const node = button(dg.tab === tab ? 'on' : '', text, { dgtab: tab });
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', String(dg.tab === tab));
      node.addEventListener('click', () => {
        dg.tab = tab;
        renderDigest();
      });
      tabs.append(node);
    }
    body.append(tabs);
    if (record.error !== null && record.error !== undefined) {
      body.append(el('p', 'notline bad', `The model call failed (${record.error}); the Git data is shown without its summary.`));
    }
    for (const note of record.notes ?? []) {
      body.append(el('p', 'notline', note));
    }
    body.append(...(dg.tab === 'daily' ? dgDaily(record) : dgRepos(record)));
  }
  const scroll = page.querySelector('.form2')?.scrollTop ?? 0;
  const wrap = el('div', 'form2');
  wrap.append(body);
  keepFocus(page, () => page.replaceChildren(head, wrap));
  wrap.scrollTop = scroll;
}

function dgList(items: readonly string[], className = 'dg-items'): HTMLElement {
  if (items.length === 0) {
    return el('p', 'muted fs13', 'None.');
  }
  const list = el('ul', className);
  list.append(...items.map((item) => el('li', '', item)));
  return list;
}

function dgSection(title: string, ...content: Node[]): HTMLElement {
  const section = el('section', 'dg-sec');
  section.append(el('h4', '', title), ...content);
  return section;
}

// The Repositories tab: "One ticket across the app", then a card per followed workspace.
function dgRepos(record: DigestRecord): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  const cross = record.output?.cross_repo ?? [];
  if (cross.length > 0) {
    nodes.push(dgCross(cross, record));
  }
  const followed = record.workspaces.filter((workspace) => workspace.track);
  if (followed.length === 0) {
    const empty = el('div', 'card2 dg-empty');
    empty.append(el('p', 'fs13', 'No workspace is followed in this digest. Workspaces → Edit → "Morning digest: follow this repository".'));
    nodes.push(empty);
  }
  for (const workspace of followed) {
    nodes.push(dgRepoCard(workspace, record.output?.repos?.find((repo) => repo.name === workspace.name) ?? null, record));
  }
  return nodes;
}

function dgCross(rows: readonly DigestCross[], record: DigestRecord): HTMLElement {
  const names = record.workspaces.map((workspace) => workspace.name).filter((name) => rows.some((row) => Object.hasOwn(row.by_workspace ?? {}, name)));
  const card = el('div', 'card2 dg-cross');
  card.append(el('h3', '', 'One ticket across the app'));
  const scroller = el('div', 'dg-scroll');
  const table = el('table', 'dgx');
  const headRow = el('tr');
  headRow.append(el('th', '', 'Ticket'), ...names.map((name) => el('th', '', name)), el('th', '', 'For me'));
  const thead = el('thead');
  thead.append(headRow);
  const tbody = el('tbody');
  for (const row of rows) {
    const line = el('tr');
    const ticket = el('td', 'mono');
    ticket.append(el('span', 'chipx', row.ticket));
    line.append(ticket, ...names.map((name) => el('td', '', row.by_workspace?.[name] ?? '—')), el('td', row.for_me ? 'dg-forme' : 'muted', row.for_me || '—'));
    tbody.append(line);
  }
  table.append(thead, tbody);
  scroller.append(table);
  card.append(scroller);
  return card;
}

type DigestRepo = DigestOutput['repos'][number];

function dgRepoCard(workspace: DigestWorkspace, repo: DigestRepo | null, record: DigestRecord): HTMLElement {
  const card = el('article', 'card2 dg-repo');
  card.dataset.ws = workspace.name;
  const title = el('h3', 'dg-title');
  title.append(wsDot(workspace.name), el('span', 'dg-name', workspace.name));
  if (workspace.app !== workspace.name) {
    title.append(el('span', 'chipx', workspace.app));
  }
  card.append(title);
  if (workspace.fetch?.message) {
    card.append(el('p', 'notline', workspace.fetch.message));
  }
  for (const note of workspace.fetch?.notes ?? []) {
    card.append(el('p', 'notline', note));
  }
  if (workspace.error) {
    card.append(el('p', 'err-text fs13', workspace.error));
  }
  const git = workspace.git;
  if (git === null || git === undefined) {
    card.append(el('p', 'muted fs13', 'No Git data for this workspace in this digest.'));
    return card;
  }
  for (const note of git.notes ?? []) {
    card.append(el('p', 'notline', note));
  }
  if (repo?.headline) {
    card.append(el('p', 'dg-headline', repo.headline));
  }
  const impact = repo?.impact_on_me ?? [];
  if (impact.length > 0) {
    const box = el('div', 'dg-impact');
    box.append(el('h4', '', 'Effect on my work'), dgList(impact));
    card.append(box);
  }
  // Landed: the last 24 hours of the period shown, the earlier ones folded away. Each index of
  // entries is one of git.landed.
  const recent = Date.parse(record.period.to) - 86400000;
  const entries = git.landed.map((entry) => dgLanded(entry, repo));
  const shown = entries.filter((_, index) => Date.parse(git.landed[index]?.date ?? '') >= recent);
  const earlier = entries.filter((_, index) => Date.parse(git.landed[index]?.date ?? '') < recent);
  const landed: HTMLElement[] = [];
  if (git.landed.length === 0) {
    landed.push(el('p', 'muted fs13', 'Nothing landed in the period.'));
  }
  if (shown.length > 0) {
    const list = el('ul', 'dg-landed');
    list.append(...shown);
    landed.push(list);
  }
  if (earlier.length > 0) {
    const fold = el('details', 'dg-fold');
    const list = el('ul', 'dg-landed');
    list.append(...earlier);
    fold.append(el('summary', '', `Earlier in the period (${earlier.length})`), list);
    landed.push(fold);
  }
  card.append(dgSection(`Landed on ${git.main}`, ...landed));
  const branches = git.branches.filter((branch) => !branch.landed);
  card.append(dgSection('Live branches', ...(branches.length === 0 ? [el('p', 'muted fs13', 'No live branch.')] : [dgBranches(branches, repo)])));
  return card;
}

function dgLanded(entry: DigestLanded, repo: DigestRepo | null): HTMLElement {
  const item = el('li', entry.mine ? 'dg-entry mine' : 'dg-entry');
  const meta = el('div', 'dg-meta');
  meta.append(el('span', 'mono', dgTime(entry.date).slice(5)), el('span', 'dg-who', entry.author));
  if (entry.mine) {
    meta.append(el('span', 'tag', 'mine'));
  }
  const what = el('div', 'dg-what');
  if (entry.ticket) {
    what.append(el('span', 'chipx', entry.ticket));
  }
  const problem = repo?.merged?.find((merged) => merged.sha === entry.sha || entry.full_sha?.startsWith(merged.sha))?.problem;
  what.append(el('span', '', problem ?? entry.subject));
  item.append(meta, what);
  if (problem !== undefined) {
    item.append(el('div', 'muted fs12 dg-subject', entry.subject));
  }
  const where = el('div', 'muted fs12 dg-where');
  where.append(el('span', 'mono', entry.sha), el('span', '', entry.dirs.join(', ')), el('span', '', entry.stat));
  item.append(where);
  return item;
}

function dgBranches(branches: readonly DigestBranch[], repo: DigestRepo | null): HTMLElement {
  const list = el('ul', 'dg-branches');
  for (const branch of branches) {
    const item = el('li', branch.mine ? 'dg-entry mine' : 'dg-entry');
    const meta = el('div', 'dg-meta');
    meta.append(el('span', 'mono dg-ref', branch.name));
    if (branch.local) {
      meta.append(el('span', 'tag', 'local'));
    }
    if (branch.mine) {
      meta.append(el('span', 'tag', 'mine'));
    }
    meta.append(el('span', 'dg-who', branch.author));
    const counts = el('span', 'mono dg-counts');
    counts.append(el('span', 'plus', `+${branch.ahead}`), document.createTextNode('/'), el('span', branch.behind > 10 ? 'minus dg-behind' : 'minus', `−${branch.behind}`));
    if (branch.behind > 10) {
      counts.setAttribute('title', `${branch.behind} commits behind ${'the main branch'}: a rebase is due`);
    }
    meta.append(counts, el('span', 'muted', branch.age_days === 0 ? 'today' : `${branch.age_days} d`));
    if (branch.local_only > 0) {
      meta.append(el('span', 'muted', `${branch.local_only} local only`));
    }
    item.append(meta);
    const what = repo?.branches?.find((entry) => entry.ref === branch.name)?.what;
    item.append(el('div', 'dg-what', what ?? branch.subject));
    const overlap = branch.overlap ?? [];
    if (branch.mine && overlap.length > 0) {
      item.append(el('div', 'fs12 dg-overlap', `Shares with main: ${overlap.join(', ')}`));
    }
    list.append(item);
  }
  return list;
}

// The daily's sections with items (no empty one, on the card or in Copy), in Bulgarian (language bulgarian, bg or
// български, any case) or English: "Yesterday" when the span starts the day before the digest (local dates) or is unknown, else "Since <weekday>".
function dailyParts(record: DigestRecord, daily: DigestDaily): Array<[string, readonly string[]]> {
  const bg = ['bulgarian', 'bg', 'български'].includes(String(record.language ?? '').trim().toLowerCase());
  const from = new Date(record.daily_days?.yesterday?.from ?? Number.NaN);
  const start = new Date(record.started_at);
  const before = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
  const since = Number.isNaN(from.getTime() - start.getTime()) || from.toDateString() === before.toDateString() ? null : new Intl.DateTimeFormat(bg ? 'bg' : 'en', { weekday: 'long' }).format(from);
  const titles = bg ? [since === null ? 'Вчера' : `От ${since}`, 'Проблеми', 'План', 'Днес'] : [since === null ? 'Yesterday' : `Since ${since}`, 'Problems', 'Plan', 'Today'];
  return [daily.yesterday, daily.problems, daily.plan, daily.next].flatMap((items, index): Array<[string, readonly string[]]> => (items.length === 0 ? [] : [[titles[index]!, items]]));
}

// My daily: a card per app, its sections with items, the commits it was made from and Copy.
function dgDaily(record: DigestRecord): HTMLElement[] {
  const sources = record.daily_sources ?? [];
  const dailies: DigestDaily[] = record.output?.dailies ?? sources.map((source) => ({ app: source.app, workspaces: source.workspaces, yesterday: [], problems: [], plan: [], next: [] }));
  if (dailies.length === 0) {
    const empty = el('div', 'card2 dg-empty');
    empty.append(el('p', 'fs13', 'No daily in this digest: no workspace has My daily on (Workspaces → Edit), or you have no commits or open branches there in the two days.'));
    return [empty];
  }
  return dailies.map((daily) => {
    const card = el('article', 'card2 dg-daily');
    card.dataset.app = daily.app;
    const title = el('h3', 'dg-title');
    title.append(el('span', 'dg-name', daily.app), ...daily.workspaces.map((name) => wsChip(name)));
    const parts = dailyParts(record, daily);
    card.append(title, ...parts.map(([heading, items]) => dgSection(heading, dgList(items))));
    const commits = sources.find((source) => source.app === daily.app)?.commits ?? [];
    const fold = el('details', 'dg-fold');
    const list = el('ul', 'dg-commits');
    list.append(...commits.map((commit) => {
      const item = el('li', 'fs12');
      item.append(el('span', 'mono', commit.sha), document.createTextNode(` ${commit.subject} `), el('span', 'muted', `${commit.workspace} · ${commit.ref} · ${dgTime(commit.date).slice(5)}`));
      return item;
    }));
    fold.append(el('summary', '', `The commits it was made from (${commits.length})`), list);
    card.append(fold);
    const row = el('div', 'dg-copyrow');
    const copy = button('btn small', 'Copy', { dg: 'copy' });
    copy.addEventListener('click', () => void copyDaily(daily.app, parts));
    row.append(copy);
    const copied = dg.copied.get(daily.app);
    if (copied !== undefined) {
      row.append(el('span', copied.ok ? 'muted fs12' : 'err-text fs12', copied.text));
    }
    card.append(row);
    return card;
  });
}

// The daily as plain text: each heading as on the page ("Yesterday:", "Problems:"…), with "- " items.
const dailyText = (parts: ReadonlyArray<[string, readonly string[]]>): string => parts.flatMap(([heading, items]) => [`${heading}:`, ...items.map((item) => `- ${item}`)]).join('\n');

async function copyDaily(app: string, parts: ReadonlyArray<[string, readonly string[]]>): Promise<void> {
  try {
    if (typeof navigator.clipboard?.writeText !== 'function') {
      throw new Error('the browser gives no clipboard here');
    }
    await navigator.clipboard.writeText(dailyText(parts));
    dg.copied.set(app, { ok: true, text: 'Copied.' });
  } catch (error) {
    dg.copied.set(app, { ok: false, text: `Copy failed: ${errorMessage(error)}` });
  }
  renderDigest();
}

// ---------- The Stats page ----------

// A series of a chart: its colour key, its name and its value of an item.
interface StSeries<T> {
  key: string;
  name: string;
  value: (item: T) => number;
}

// The Stats page (#stats): the period (7, 30 or 90 days) and the workspace chosen (null: all), the
// payload as last read, a read's error, the read under way, and the charts shown as tables. In page
// memory only; read on open, on a change and on Refresh, never on a timer.
const st: {
  days: number;
  workspace: string | null;
  data: StatsPayload | null;
  error: string | null;
  load: number;
  tables: Set<string>;
  warningsAll: boolean;
} = { days: 30, workspace: null, data: null, error: null, load: 0, tables: new Set(), warningsAll: false };
const SVG_NS = 'http://www.w3.org/2000/svg';
const ST_ROLES: Readonly<Record<StatsRole, string>> = { implementer: 'Implementer', claude_review: 'Claude review', simplify: 'Simplification', codex_gate: 'Codex gate', task_check: 'Plan check', digest: 'Digest', explanation: 'Explanations' };
const ST_COST_ROLES: readonly StatsCostRole[] = ['implementer', 'claude_review', 'simplify', 'task_check', 'digest', 'explanation'];
const ST_STAGES: Readonly<Record<string, string>> = { claude_review: 'Claude review', codex_gate: 'Codex gate', task_check: 'Plan check' };
const ST_SEVERITIES: ReadonlyArray<{ key: keyof StatsFindings; name: string }> = [{ key: 'blocker', name: 'Blocker' }, { key: 'major', name: 'Major' }, { key: 'nit', name: 'Nit' }];
const ST_DAY_CHARTS: readonly string[] = ['cost-day', 'tokens-day', 'started-day'];
// The warnings listed before "Show all N".
const ST_WARNINGS_SHOWN = 10;
// The rules of the warnings (src/stats.ts), one plain sentence each.
const ST_RULES = [
  'A job costs more than three times the median of the last 30 finished jobs of its workspace, and at least $5 (with at least 5 such jobs).',
  'A job uses more than three times the median Codex gate tokens of those jobs.',
  'A job takes more than three times the median iterations of those jobs, and at least 5.',
  'A job gives one line, which lists each of these measures it is unusual on.',
  'A finding of a job was reopened twice or more, or the job stopped with review churn or a disputed review.',
  'The job and review-churn warnings are only of the jobs updated in the last 7 days, whatever the period.',
  'The last 3 runs of a stage (Claude review, Codex gate, simplification, plan check, digest, explanation) all failed.',
  'A day costs more than twice the median of the days with a cost among the 30 days before (with at least 7 such days), and at least $5.',
];

// The formats: $1.23 ($100 on without decimals, — for none), 950 / 1.5k / 340k / 2.1M, 45s / 12m / 3.2h / 1.5d.
const stMoney = (value: unknown): string => (typeof value !== 'number' ? '—' : value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`);
function stTokens(value: number): string {
  if (value >= 999500) {
    return `${(value / 1e6).toFixed(1)}M`;
  }
  if (value >= 9950) {
    return `${Math.round(value / 1000)}k`;
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(value));
}
function stDuration(seconds: unknown): string {
  if (typeof seconds !== 'number') {
    return '—';
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  return seconds < 86400 ? `${(seconds / 3600).toFixed(1)}h` : `${(seconds / 86400).toFixed(1)}d`;
}
const stCount = (value: unknown): string => (typeof value !== 'number' ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(1));
const stPercent = (part: number, whole: number): string => `${Math.round((part / whole) * 100)}%`;
function stTokenLine(tokens: StatsClaudeTokens | StatsGateTokens | null | undefined): string {
  if (tokens === null || tokens === undefined) {
    return 'not recorded';
  }
  return 'cached_input' in tokens
    ? `${stTokens(tokens.input)} in (${stTokens(tokens.cached_input)} cached) · ${stTokens(tokens.output)} out`
    : `${stTokens(tokens.input)} in · ${stTokens(tokens.output)} out`;
}
const stFindings = (findings: StatsFindings): string => `${findings.blocker} / ${findings.major} / ${findings.nit}`;

function openStats(): void {
  if (ui.job !== null) {
    leaveJob();
  }
  if (state.drawer !== null) {
    hideDrawer();
  }
  ui.screen = 'stats';
  ui.job = null;
  ui.ticket = null;
  ui.pending = false;
  byId('board').hidden = true;
  byId('job').hidden = true;
  byId('ticket').hidden = true;
  byId('digest').hidden = true;
  leaveDigest();
  const page = byId('stats');
  page.hidden = false;
  renderStats();
  setHash();
  page.querySelector<HTMLElement>('[data-back]')?.focus();
  void loadStats();
}

// One read of the payload; its answer is applied only when it is the last read and the page is shown.
async function loadStats(): Promise<void> {
  st.load += 1;
  const load = st.load;
  const path = `api/stats?days=${st.days}${st.workspace === null ? '' : `&workspace=${encodeURIComponent(st.workspace)}`}`;
  try {
    const data = payload<StatsPayload>(await getText(path));
    if (load !== st.load || ui.screen !== 'stats') {
      return;
    }
    st.data = data;
    st.error = null;
  } catch (error) {
    if (load !== st.load || ui.screen !== 'stats') {
      return;
    }
    st.error = errorMessage(error);
  }
  renderStats();
}

// The top of a chart's axis: the smallest of 1, 2, 2.5, 5, 10 × a power of ten at or above max.
function stTop(max: number): number {
  if (!(max > 0)) {
    return 1;
  }
  const power = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 2.5, 5, 10].map((step) => step * power).find((top) => top >= max) ?? 10 * power;
}

// The colour key above a stacked chart.
function stLegend(series: ReadonlyArray<{ key: string; name: string }>): HTMLElement {
  const legend = el('div', 'st-legend');
  for (const one of series) {
    const item = el('span', 'st-key');
    item.append(el('span', `st-swatch st-c-${one.key}`), document.createTextNode(one.name));
    legend.append(item);
  }
  return legend;
}

function stScroll(table: HTMLElement): HTMLElement {
  const wrap = el('div', 'st-scroll');
  wrap.append(table);
  return wrap;
}

// A table of rows of cells (a text or a node).
function stTable(head: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | Node>>): HTMLElement {
  const table = el('table', 'st-table');
  const thead = el('thead');
  const top = el('tr');
  for (const text of head) {
    top.append(el('th', '', text));
  }
  thead.append(top);
  const tbody = el('tbody');
  for (const cells of rows) {
    const row = el('tr');
    for (const cell of cells) {
      const td = el('td');
      td.append(cell);
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(thead, tbody);
  return stScroll(table);
}

// A chart's box, whatever the data: its title and its Table toggle, then the SVG, the same numbers
// as a table, or the muted line when every value is 0 (the toggle then shows the table of zeros).
function stChart<T extends { label: string }>(id: string, title: string, items: readonly T[], series: ReadonlyArray<StSeries<T>>, format: (value: number) => string, empty: string, draw: () => SVGElement): HTMLElement {
  const box = el('div', 'st-chart');
  box.dataset.chart = id;
  const head = el('div', 'st-chart-head');
  const tabled = st.tables.has(id);
  const toggle = button('btn small', tabled ? 'Chart' : 'Table', { st: `table-${id}` });
  toggle.setAttribute('aria-pressed', String(tabled));
  toggle.addEventListener('click', () => {
    if (st.tables.has(id)) {
      st.tables.delete(id);
    } else {
      st.tables.add(id);
    }
    renderStats();
  });
  head.append(el('h4', '', title), toggle);
  box.append(head);
  if (tabled) {
    const total = series.length > 1 ? ['Total'] : [];
    box.append(stTable([ST_DAY_CHARTS.includes(id) ? 'Day' : 'Name', ...series.map((one) => one.name), ...total], items.map((item) => {
      const values = series.map((one) => one.value(item));
      return [item.label, ...values.map(format), ...(total.length === 0 ? [] : [format(values.reduce((sum, value) => sum + value, 0))])];
    })));
  } else if (items.every((item) => series.every((one) => one.value(item) === 0))) {
    box.append(el('p', 'muted fs13 st-none', empty));
  } else {
    if (series.length > 1) {
      box.append(stLegend(series));
    }
    box.append(draw());
  }
  return box;
}

// Columns over the days: a y axis with gridlines at 0, ¼, ½, ¾ and the top, one column per day with
// its series stacked in order, at most 12 day labels.
function stColumns<R extends { day: string }>(id: string, title: string, rows: readonly R[], series: ReadonlyArray<StSeries<R>>, format: (value: number) => string, empty: string): HTMLElement {
  const items = rows.map((row) => ({ ...row, label: row.day }));
  return stChart(id, title, items, series, format, empty, () => {
    const svg = svgEl('svg', { viewBox: '0 0 720 220', width: '100%', role: 'img', 'aria-label': title, class: 'st-svg' });
    const left = 60;
    const right = 712;
    const top = 10;
    const bottom = 194;
    const max = stTop(Math.max(0, ...items.map((item) => series.reduce((sum, one) => sum + one.value(item), 0))));
    const y = (value: number): number => bottom - (value / max) * (bottom - top);
    for (const part of [0, 0.25, 0.5, 0.75, 1]) {
      svg.append(svgEl('line', { x1: left, x2: right, y1: y(max * part), y2: y(max * part), class: 'st-grid' }));
      svg.append(svgEl('text', { x: left - 6, y: y(max * part) + 4, 'text-anchor': 'end', class: 'st-axis' }, format(max * part)));
    }
    const slot = (right - left) / Math.max(1, items.length);
    const width = Math.max(1, slot * 0.7);
    const every = Math.ceil(items.length / 12);
    items.forEach((item, index) => {
      const x = left + index * slot + (slot - width) / 2;
      let base = 0;
      for (const one of series) {
        const value = one.value(item);
        if (value > 0) {
          const rect = svgEl('rect', { x: x.toFixed(1), y: y(base + value).toFixed(1), width: width.toFixed(1), height: (y(base) - y(base + value)).toFixed(1), class: `st-c-${one.key}` });
          rect.append(svgEl('title', {}, `${item.label} · ${one.name}: ${format(value)}`));
          svg.append(rect);
          base += value;
        }
      }
      if (index % every === 0) {
        svg.append(svgEl('text', { x: (x + width / 2).toFixed(1), y: 212, 'text-anchor': 'middle', class: 'st-axis' }, item.label.slice(5)));
      }
    });
    return svg;
  });
}

// One horizontal bar per item: its label left, its series stacked, its value right; 28 high each.
function stBars<T extends { label: string }>(id: string, title: string, items: readonly T[], series: ReadonlyArray<StSeries<T>>, format: (value: number) => string, empty: string): HTMLElement {
  return stChart(id, title, items, series, format, empty, () => {
    const svg = svgEl('svg', { viewBox: `0 0 720 ${28 * Math.max(1, items.length)}`, width: '100%', role: 'img', 'aria-label': title, class: 'st-svg' });
    const left = 150;
    const span = 470;
    const max = Math.max(0, ...items.map((item) => series.reduce((sum, one) => sum + one.value(item), 0))) || 1;
    items.forEach((item, index) => {
      const y = index * 28;
      svg.append(svgEl('text', { x: 4, y: y + 18, class: 'st-axis st-label' }, item.label));
      let base = 0;
      for (const one of series) {
        const value = one.value(item);
        if (value > 0) {
          const rect = svgEl('rect', { x: (left + (base / max) * span).toFixed(1), y: y + 6, width: Math.max(1, (value / max) * span).toFixed(1), height: 16, class: `st-c-${one.key}` });
          rect.append(svgEl('title', {}, `${item.label} · ${one.name}: ${format(value)}`));
          svg.append(rect);
          base += value;
        }
      }
      svg.append(svgEl('text', { x: 716, y: y + 18, 'text-anchor': 'end', class: 'st-axis' }, format(base)));
    });
    return svg;
  });
}

function stSection(title: string, className = ''): HTMLElement {
  const section = el('section', className === '' ? 'st-sec' : `st-sec ${className}`);
  section.append(el('h3', '', title));
  return section;
}

function stTile(label: string, value: string, sub: string | undefined = undefined): HTMLElement {
  const tile = el('div', 'st-tile');
  tile.append(el('div', 'st-tile-label', label), el('div', 'st-tile-value', value));
  if (sub !== undefined) {
    tile.append(el('div', 'st-tile-sub', sub));
  }
  return tile;
}

function stTiles(...tiles: HTMLElement[]): HTMLElement {
  const grid = el('div', 'st-tiles');
  grid.append(...tiles);
  return grid;
}

// Where a warning or a case points: a job that is not archived, a planned ticket, a digest; null otherwise.
function stHref(target: StatsTarget | null | undefined): string | null {
  if (target === null || target === undefined) {
    return null;
  }
  if (target.kind === 'job') {
    return target.archived ? null : `#${jobPath(`${target.workspace}/${target.ticket}`)}`;
  }
  if (target.kind === 'ticket') {
    return `#${jobPath(`${target.workspace}/${target.ticket}`)}/ticket`;
  }
  return target.kind === 'digest' ? `#digest/${encodeURIComponent(target.id)}` : null;
}

// text as a link to the target, or "(archived)" (after the ticket's name) without one.
function stLink(target: StatsTarget | null | undefined, text: string): HTMLElement {
  const href = stHref(target);
  if (href === null) {
    return el('span', 'muted', text === 'Open' ? '(archived)' : `${text} (archived)`);
  }
  const link = el('a', 'st-link', text);
  link.href = href;
  return link;
}

function stWarnings(data: StatsPayload): HTMLElement {
  const section = stSection(`Warnings (${data.warnings.length})`, 'st-warnings');
  if (data.warnings.length === 0) {
    section.append(el('p', 'muted fs13', 'No warnings: nothing is far from the usual.'));
  } else {
    const list = el('ul', 'st-warn');
    const item = (warning: StatsPayload['warnings'][number]): HTMLElement => {
      const row = el('li');
      row.append(el('span', 'st-warn-text', warning.text));
      if (warning.target !== null) {
        row.append(stLink(warning.target, 'Open'));
      }
      return row;
    };
    const shown = st.warningsAll ? data.warnings.length : ST_WARNINGS_SHOWN;
    list.append(...data.warnings.slice(0, shown).map(item));
    section.append(list);
    if (data.warnings.length > shown) {
      // The rest in place; the page remembers it until it is reloaded.
      const more = button('btn small', `Show all ${data.warnings.length}`, { st: 'warnings-all' });
      more.addEventListener('click', () => {
        st.warningsAll = true;
        list.append(...data.warnings.slice(shown).map(item));
        more.remove();
      });
      section.append(more);
    }
  }
  const how = el('details', 'st-how');
  how.append(el('summary', '', 'How warnings are found'));
  const rules = el('ul', 'fs13');
  for (const rule of ST_RULES) {
    rules.append(el('li', '', rule));
  }
  how.append(rules);
  section.append(how);
  return section;
}

function stOpinionCard(title: string, opinion: StatsSecondOpinion, note: string | undefined = undefined): HTMLElement {
  const card = el('div', 'card2 st-opinion');
  card.append(el('h4', '', title));
  if (opinion.iterations === 0) {
    card.append(el('p', 'muted fs13', 'No iteration in this period had both reviews.'));
    return card;
  }
  card.append(el('p', 'st-big', `${opinion.caught} of ${opinion.iterations} iterations (${stPercent(opinion.caught, opinion.iterations)})`));
  card.append(el('p', 'fs13', `${opinion.fixed} of its ${opinion.findings} findings were fixed`));
  if (note !== undefined) {
    card.append(el('p', 'muted fs13', note));
  }
  if (opinion.cases.length > 0) {
    const list = el('ul', 'st-cases fs13');
    for (const one of opinion.cases) {
      const item = el('li');
      item.append(stLink({ kind: 'job', workspace: one.workspace, ticket: one.ticket, archived: one.archived }, one.ticket),
        el('span', 'muted', `iteration ${one.iteration} · ${one.findings} findings · ${one.fixed} fixed`));
      list.append(item);
    }
    card.append(list);
  }
  return card;
}

function stSecondOpinion(data: StatsPayload): HTMLElement {
  const section = stSection('Does a second model pay?');
  const pair = el('div', 'st-pair');
  pair.append(
    stOpinionCard('Codex found a blocker or major after Claude passed', data.second_opinion.codex_after_claude),
    stOpinionCard('Claude found a new blocker or major right after a clean Codex gate', data.second_opinion.claude_after_codex,
      'The next iteration is usually MR preparation or your own request, so a finding here can be about new work.'),
  );
  section.append(pair);
  return section;
}

// The Claude review experiment: one line per arm, on and off, of the jobs that recorded
// claude_review; the empty text when neither has a job.
const ST_ARMS: Readonly<Record<string, string>> = { on: 'On', off: 'Off' };
function stArms(data: StatsPayload): HTMLElement {
  const section = stSection('Claude review on/off');
  if (data.arms.every((row) => row.jobs === 0)) {
    section.append(el('p', 'muted fs13', 'No jobs of the experiment yet.'));
    return section;
  }
  const cost = (value: number | null, complete: boolean): string => (value === null ? '—' : complete ? stMoney(value) : `at least ${stMoney(value)}`);
  section.append(stTable(['Claude review', 'Jobs', 'Delivered', 'Aborted', 'Cost', 'Per delivered', 'Median iterations', 'Codex findings', 'Per job'], data.arms.map((row) => [
    ST_ARMS[row.arm] ?? row.arm, String(row.jobs), String(row.delivered), String(row.aborted), cost(row.cost_usd, row.cost_complete),
    cost(row.usd_per_delivered, row.cost_complete), stCount(row.median_iterations), String(row.codex_findings), stCount(row.codex_findings_per_job),
  ])), el('p', 'muted fs13', 'Jobs started before the experiment are in neither arm.'));
  return section;
}

function stStages(data: StatsPayload): HTMLElement {
  const section = stSection('Review stages');
  const items = data.stages.map((row) => ({ ...row, label: ST_STAGES[row.stage] ?? row.stage }));
  const charts = el('div', 'st-charts');
  charts.append(stBars('findings', 'Findings per stage', items, ST_SEVERITIES.map((one) => ({ ...one, value: (row: StatsStageRow) => row.findings[one.key] })), String, 'No findings in this period.'));
  // Rounds per ticket: the plan check's (runs + failed) / tickets; "—" for the other stages.
  section.append(charts, stTable(['Stage', 'Runs', 'Failed', 'Blocker', 'Major', 'Nit', 'Led to a fix', 'Cost', 'Tokens', 'Cost per run', 'Rounds per ticket'], items.map((row) => [
    row.label, String(row.runs), String(row.failed), String(row.findings.blocker), String(row.findings.major), String(row.findings.nit),
    row.stage === 'task_check' ? `${row.fixed} (Task revised)` : String(row.fixed), stMoney(row.cost_usd), stTokenLine(row.tokens),
    row.cost_usd === null || row.runs === 0 ? '—' : stMoney(row.cost_usd / row.runs),
    typeof row.tickets === 'number' && row.tickets > 0 ? ((row.runs + row.failed) / row.tickets).toFixed(1) : '—',
  ])));
  return section;
}

function stSpend(data: StatsPayload): HTMLElement {
  const section = stSection('Spend');
  const codex = data.totals.codex_tokens;
  section.append(stTiles(
    stTile('Cost', stMoney(data.totals.cost_usd), 'Codex gate in tokens only'),
    stTile('Codex gate tokens', stTokens(codex.input + codex.output), `${stTokens(codex.input)} in (${stTokens(codex.cached_input)} cached) · ${stTokens(codex.output)} out`),
  ));
  const charts = el('div', 'st-charts');
  charts.append(
    stColumns('cost-day', 'Cost per day', data.days_rows, ST_COST_ROLES.map((key) => ({ key, name: ST_ROLES[key], value: (row: StatsDayRow) => row.cost[key] })), stMoney, 'No cost in this period.'),
    stColumns('tokens-day', 'Codex gate tokens per day', data.days_rows, [
      { key: 'codex_gate', name: 'Input', value: (row) => row.codex_tokens.input },
      { key: 'codex_out', name: 'Output', value: (row) => row.codex_tokens.output },
    ], stTokens, 'No Codex gate run in this period.'),
  );
  // The simplification's line also has its offers and the user's choices.
  const offers = ({ offered, taken, skipped }: StatsPayload['simplify']): string => ` · offered ${offered} · taken ${taken} · skipped ${skipped}`;
  section.append(charts, el('h4', 'st-sub', 'By role'), stTable(['Role', 'Cost', 'Tokens', 'Runs'], data.roles.map((row) => [
    ST_ROLES[row.role] ?? row.role, row.cost_usd === null ? 'tokens only' : row.complete ? stMoney(row.cost_usd) : `at least ${stMoney(row.cost_usd)}`,
    stTokenLine(row.tokens), row.role === 'simplify' ? `${row.runs}${offers(data.simplify)}` : String(row.runs),
  ])));
  const roles = ST_COST_ROLES.filter((key): key is Exclude<StatsCostRole, 'digest'> => key !== 'digest');
  const items = data.by_workspace.map((row) => ({ ...row, label: row.workspace }));
  const byWorkspace = el('div', 'st-charts');
  byWorkspace.append(stBars('by-workspace', 'Cost by workspace', items, roles.map((key) => ({ key, name: ST_ROLES[key], value: (row: StatsWorkspaceRow) => row.cost[key] })), stMoney, 'No cost in this period.'));
  section.append(el('h4', 'st-sub', 'By workspace'), byWorkspace, stTable(['Workspace', ...roles.map((key) => ST_ROLES[key]), 'Total', 'Codex tokens', 'Jobs started', 'Median time to ready'], data.by_workspace.map((row) => [
    row.workspace, ...roles.map((key) => stMoney(row.cost[key])), stMoney(row.total_usd), stTokens(row.codex_tokens), String(row.jobs_started), stDuration(row.median_time_to_ready_s),
  ])));
  return section;
}

function stLoad(data: StatsPayload): HTMLElement {
  const section = stSection('Load');
  const done = data.totals.jobs_finished;
  section.append(stTiles(
    stTile('Jobs started', String(data.totals.jobs_started)),
    stTile('Finished', String(done.total), `pushed ${done.pushed} · aborted ${done.aborted} · failed ${done.failed}`),
    stTile('Time to ready', stDuration(data.totals.median_time_to_ready_s), 'median'),
    stTile('Iterations', stCount(data.totals.median_iterations), 'median of pushed jobs'),
  ));
  const charts = el('div', 'st-charts');
  charts.append(stColumns('started-day', 'Jobs started per day', data.days_rows, [{ key: 'started', name: 'Jobs started', value: (row) => row.started }], stCount, 'No job started in this period.'));
  section.append(charts);
  return section;
}

// A job's plan checks, all-time: "N rounds · $X" ("at least $X" when a cost is unknown),
// "—" without one.
function stPlanChecks(row: StatsJobRow): string {
  if (typeof row.plan_checks !== 'number' || row.plan_checks === 0) {
    return '—';
  }
  return roundsText(row.plan_checks, row.plan_check_usd, row.plan_check_usd_complete !== false, stMoney);
}

function stJobs(data: StatsPayload): HTMLElement {
  const section = stSection(`Jobs (${data.jobs.length})`);
  if (data.jobs.length === 0) {
    section.append(el('p', 'muted fs13', 'No job in this period.'));
    return section;
  }
  section.append(stTable(['Workspace', 'Ticket', 'Title', 'State', 'Started', 'Iterations', 'Cost', 'Plan', 'Codex tokens', 'Claude B/M/N', 'Codex B/M/N', 'Time to ready'], data.jobs.map((row) => [
    row.workspace, stLink({ kind: 'job', workspace: row.workspace, ticket: row.ticket, archived: row.archived }, row.ticket), row.title ?? '', row.state.replace(/_/g, ' '),
    localTime(row.created_at).slice(0, 16), String(row.iterations), row.cost_complete ? stMoney(row.cost_usd) : `at least ${stMoney(row.cost_usd)}`, stPlanChecks(row), stTokens(row.codex_tokens),
    stFindings(row.claude), stFindings(row.codex), stDuration(row.time_to_ready_s),
  ])));
  return section;
}

function stNotes(data: StatsPayload): HTMLElement[] {
  const { notes } = data;
  const lines = [
    ...(notes.truncated > 0 ? [`Only the newest 1000 jobs are counted; ${notes.truncated} older ones are left out.`] : []),
    ...(notes.unreadable > 0 ? [`${notes.unreadable} files could not be read and are left out.`] : []),
    ...(notes.events_skipped > 0 ? [`${notes.events_skipped} event logs are too large to read; their tokens and time to ready are missing.`] : []),
    ...(notes.digest_excluded ? ['Digests have no workspace and are not counted here.'] : []),
  ];
  if (lines.length === 0) {
    return [];
  }
  const section = stSection('Notes', 'st-notes');
  for (const line of lines) {
    section.append(el('p', 'muted fs13', line));
  }
  return [section];
}

function renderStats(): void {
  if (ui.screen !== 'stats') {
    return;
  }
  const page = byId('stats');
  const data = st.data;
  const backButton = button('btn back', '← Board ', { back: '', st: 'back' });
  backButton.append(el('span', 'kbd', 'Esc'));
  backButton.setAttribute('title', 'Back to the board (Esc)');
  const t1 = el('div', 't1');
  t1.append(el('span', 'title', 'Stats'));
  const period = el('span', 'seg2');
  period.setAttribute('role', 'group');
  period.setAttribute('aria-label', 'Period');
  for (const days of [7, 30, 90]) {
    const node = button(st.days === days ? 'on' : '', `${days} days`, { st: `days-${days}` });
    node.setAttribute('aria-pressed', String(st.days === days));
    node.addEventListener('click', () => {
      if (st.days !== days) {
        st.days = days;
        renderStats();
        void loadStats();
      }
    });
    period.append(node);
  }
  const pick = el('select', 'dg-pick');
  pick.setAttribute('aria-label', 'Workspace');
  pick.dataset.st = 'workspace';
  const names = [...new Set([...(data?.workspaces ?? []), ...(st.workspace === null ? [] : [st.workspace])])];
  const options: Array<[string, string]> = [['', 'All workspaces'], ...names.map((name): [string, string] => [name, name])];
  for (const [value, text] of options) {
    const option = el('option', '', text);
    option.value = value;
    pick.append(option);
  }
  pick.value = st.workspace ?? '';
  pick.addEventListener('change', () => {
    st.workspace = pick.value === '' ? null : pick.value;
    renderStats();
    void loadStats();
  });
  const refresh = button('btn', 'Refresh', { st: 'refresh' });
  refresh.addEventListener('click', () => void loadStats());
  const tools = el('div', 'tools');
  tools.append(period, pick, refresh);
  const t2 = el('div', 't2');
  if (data !== null) {
    t2.append(el('span', '', `${data.period.from} to ${data.period.to} · as of ${localTime(data.generated_at).slice(11, 16)}`));
  }
  const head = el('header', 'jhead');
  head.append(backButton, t1, tools, t2);
  const body = el('div', 'st-body');
  if (st.error !== null) {
    const card = el('div', 'card2');
    const retry = button('btn', 'Retry', { st: 'retry' });
    retry.addEventListener('click', () => void loadStats());
    card.append(el('p', 'err-text fs13', `The stats could not be read (${st.error}).`), retry);
    body.append(card);
  } else if (data === null) {
    body.append(el('p', 'muted fs13', 'Loading the stats…'));
  } else if (data.workspaces.length === 0 && data.roles.every((row) => row.runs === 0)) {
    const card = el('div', 'card2');
    card.append(el('p', 'fs13', 'No jobs yet. The stats fill in once the factory has run a job.'));
    body.append(card);
  } else {
    const now = stSection('Now');
    now.append(stTiles(
      stTile('Running', String(data.now.running)), stTile('Waiting for you', String(data.now.waiting_for_you)),
      stTile('Paused', String(data.now.paused)), stTile('Queued', data.now.queued === null ? '—' : String(data.now.queued)),
    ));
    body.append(stWarnings(data), now, stSecondOpinion(data), stArms(data), stStages(data), stSpend(data), stLoad(data), stJobs(data), ...stNotes(data));
  }
  // The focus stays on the control it was on; the scroll where it was.
  const active = document.activeElement;
  const focused = active !== null && page.contains(active) && hasDataset(active) ? active.dataset?.st : undefined;
  const scroll = page.querySelector('.form2')?.scrollTop ?? 0;
  const wrap = el('div', 'form2');
  wrap.append(body);
  page.replaceChildren(head, wrap);
  wrap.scrollTop = scroll;
  if (focused !== undefined) {
    [...page.querySelectorAll<HTMLElement>('[data-st]')].find((node) => node.dataset.st === focused)?.focus();
  }
}
