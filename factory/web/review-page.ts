// review-page.js, the dashboard's script after mr-row.js (DASHBOARD_SCRIPTS in
// src/dashboard.ts), built from web/review-page.ts into dist/web/: the Merge requests page
// (#merge-requests), and leavePages, which hides the pages besides the board. Opening the page, or
// choosing another workspace, reads that workspace's open merge requests at once, then each one's
// overview (at most MQ_OVERVIEW_READS at a time), drawn as one row each by mrRow (mr-row.js); a
// re-render never reads. Refresh reads them again; the read's age beside it follows the board's
// one-minute tick (tickMergeRequestAge). Expanding a row reads its review threads: the user ticks the
// ones to implement (the bots' behind their own toggle), adds instructions of their own, and creates
// a job that continues the merge request's branch (POST
// api/workspaces/<ws>/merge-requests/<number>/job, src/review-job.ts). The server reads the comments
// from the Git host again; the page sends only the thread ids. Every host text (titles, authors,
// paths, comment bodies) is set as text, never as HTML. A classic script, loaded in order with
// defer, sharing the page's globals with the others. This file has no import or export on purpose:
// the compiler keeps it a script, so its top-level names stay the page's globals.
'use strict';

// The most characters of the user's instructions (src/review-job.ts MAX_INSTRUCTIONS_CHARS).
const MQ_MAX_INSTRUCTIONS = 4000;
// The most overviews read at a time.
const MQ_OVERVIEW_READS = 4;

// The page's state, in page memory only: the workspace chosen, whether the page still owes it a
// read (fresh: opened or the workspace changed since its last read), its open merge requests as
// last read (listed: the workspace they are of; readAt: when the list's answer arrived) and each
// one's overview, whether the list or an overview is still being read, the merge request expanded
// and its threads as last read, the threads ticked, whether the resolved and the bot threads are
// shown, the instructions typed, the post under way, the last error, the job created, and the count
// of each kind of read (an older answer is ignored).
const mq: {
  workspace: string;
  fresh: boolean;
  listed: string | null;
  requests: OpenMergeRequest[] | null;
  readAt: number | null;
  overviews: Map<number, MergeRequestOverview | 'reading' | { error: string }>;
  reading: boolean;
  number: number | null;
  threads: ReviewThread[] | null;
  threadsReading: boolean;
  ticked: Set<string>;
  resolved: boolean;
  bots: boolean;
  text: string;
  busy: 'create' | null;
  error: string | null;
  created: ReviewJobResult | null;
  load: number;
  threadsLoad: number;
} = {
  workspace: '', fresh: false, listed: null, requests: null, readAt: null, overviews: new Map(), reading: false, number: null, threads: null, threadsReading: false,
  ticked: new Set(), resolved: false, bots: false, text: '', busy: null, error: null, created: null, load: 0, threadsLoad: 0,
};

// The pages besides the board, a job's and a ticket's, hidden (a page that opens shows its own).
function leavePages(): void {
  byId('digest').hidden = true;
  leaveDigest();
  byId('stats').hidden = true;
  byId('merge-requests').hidden = true;
  byId('skills').hidden = true;
}

function openMergeRequests(): void {
  if (ui.job !== null) {
    leaveJob();
  }
  if (state.drawer !== null) {
    hideDrawer();
  }
  ui.screen = 'merge-requests';
  ui.job = null;
  ui.ticket = null;
  ui.pending = false;
  byId('board').hidden = true;
  byId('job').hidden = true;
  byId('ticket').hidden = true;
  leavePages();
  const page = byId('merge-requests');
  page.hidden = false;
  // The page owes a read, unless one is under way: its answer is this opening's.
  mq.fresh = !mq.reading;
  renderMergeRequests();
  setHash();
  page.querySelector<HTMLElement>('[data-back]')?.focus();
}

// A GET of the host's reads: the parsed body, or an Error with the factory's message.
async function mqGet(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: 'no-store' });
  if (response.ok) {
    return response.json();
  }
  let message = `HTTP ${response.status}`;
  try {
    const data: unknown = await response.json();
    if (isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string') {
      message = data.error.message;
    }
  } catch { // an empty refusal (an unknown workspace): the status says it
  }
  throw new Error(message);
}

const mqBase = (workspace: string): string => `api/workspaces/${encodeURIComponent(workspace)}/merge-requests`;

// Another workspace chosen: the list shown was the other's (a read under way is ignored), and the
// page owes the new one a read.
function mqSetWorkspace(workspace: string): void {
  if (workspace === mq.workspace) {
    return;
  }
  mq.load += 1;
  mq.threadsLoad += 1;
  Object.assign(mq, {
    workspace, fresh: true, listed: null, requests: null, readAt: null, overviews: new Map(), reading: false, error: null,
    number: null, threads: null, threadsReading: false, ticked: new Set<string>(), resolved: false, bots: false, text: '', created: null,
  });
}

// The read: the open merge requests of the workspace chosen, then each one's overview. The merge
// request expanded stays expanded when it is still listed, and its threads are read again.
async function loadMergeRequests(): Promise<void> {
  const workspace = mq.workspace;
  if (workspace === '' || mq.reading || mq.busy !== null) {
    return;
  }
  mq.load += 1;
  const load = mq.load;
  Object.assign(mq, { fresh: false, reading: true, error: null });
  renderMergeRequests();
  let requests: OpenMergeRequest[];
  try {
    const answer = await mqGet(mqBase(workspace));
    requests = Array.isArray(answer) ? (answer as OpenMergeRequest[]) : [];
  } catch (error) {
    if (load === mq.load) {
      Object.assign(mq, { error: `The merge requests could not be read: ${errorMessage(error)}`, requests: null, listed: null, readAt: null, overviews: new Map(), reading: false });
      chooseRequest(null);
    }
    return;
  }
  if (load !== mq.load) {
    return;
  }
  Object.assign(mq, { requests, listed: workspace, readAt: Date.now(), overviews: new Map(requests.map((request) => [request.number, 'reading'])) });
  if (requests.some((request) => request.number === mq.number)) {
    void readThreads();
  } else {
    chooseRequest(null);
  }
  renderMergeRequests();
  await readOverviews(workspace, requests.map((request) => request.number), load);
  if (load === mq.load) {
    mq.reading = false;
    renderMergeRequests();
  }
}

// The overviews of numbers, in their order, at most MQ_OVERVIEW_READS at a time; each answer of
// this read drawn as it arrives.
async function readOverviews(workspace: string, numbers: readonly number[], load: number): Promise<void> {
  let next = 0;
  const reader = async (): Promise<void> => {
    while (next < numbers.length && load === mq.load) {
      const number = numbers[next]!;
      next += 1;
      let overview: MergeRequestOverview | { error: string };
      try {
        overview = await mqGet(`${mqBase(workspace)}/${number}/overview`) as MergeRequestOverview;
      } catch (error) {
        overview = { error: errorMessage(error) };
      }
      if (load === mq.load) {
        mq.overviews.set(number, overview);
        renderMergeRequests();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MQ_OVERVIEW_READS, numbers.length) }, reader));
}

// The merge request expanded (null: none): its threads, ticks and instructions start empty, and
// its threads are read.
function chooseRequest(number: number | null): void {
  mq.threadsLoad += 1;
  Object.assign(mq, { number, threads: null, threadsReading: false, ticked: new Set<string>(), resolved: false, bots: false, text: '', created: null });
  if (number !== null) {
    void readThreads();
  }
  renderMergeRequests();
}

// The review threads of the merge request expanded; the ticks of threads no longer there are dropped.
async function readThreads(): Promise<void> {
  const { listed: workspace, number } = mq;
  if (workspace === null || number === null) {
    return;
  }
  mq.threadsLoad += 1;
  const load = mq.threadsLoad;
  Object.assign(mq, { threads: null, threadsReading: true });
  renderMergeRequests();
  try {
    const answer = await mqGet(`${mqBase(workspace)}/${number}/threads`);
    if (load === mq.threadsLoad) {
      const threads = Array.isArray(answer) ? (answer as ReviewThread[]) : [];
      mq.threads = threads;
      mq.ticked = new Set([...mq.ticked].filter((id) => threads.some((thread) => thread.id === id)));
    }
  } catch (error) {
    if (load === mq.threadsLoad) {
      mq.error = `The review comments could not be read: ${errorMessage(error)}`;
    }
  }
  if (load === mq.threadsLoad) {
    mq.threadsReading = false;
    renderMergeRequests();
  }
}

// "Read just now" under a minute, else "Read 14 min ago"; nothing before the first answer.
const mqAge = (): string => {
  if (mq.readAt === null) {
    return '';
  }
  const ms = Date.now() - mq.readAt;
  return ms < 60000 ? 'Read just now' : `Read ${dur(ms)} ago`;
};

// The board's one-minute tick: the read's age, and nothing else (no redraw, no read).
function tickMergeRequestAge(): void {
  const age = byId('merge-requests').querySelector<HTMLElement>('[data-mq-age]');
  if (age !== null) {
    age.textContent = mqAge();
  }
}

// Whether Create job can be pressed: a thread ticked or instructions written, nothing under way.
const mqCanCreate = (): boolean => mq.busy === null && mq.listed !== null && mq.number !== null && (mq.ticked.size > 0 || mq.text.trim() !== '');

// Create job: the ids of the ticked threads and the instructions; the server reads the comments.
async function createFromReview(): Promise<void> {
  const { listed: workspace, number } = mq;
  if (!mqCanCreate() || workspace === null || number === null) {
    return;
  }
  Object.assign(mq, { busy: 'create', error: null, created: null });
  renderMergeRequests();
  try {
    const result = await post(`${mqBase(workspace)}/${number}/job`, { threads: [...mq.ticked], instructions: mq.text });
    // Another merge request expanded meanwhile keeps its own ticks and instructions; the new ticket is on the board.
    if (mq.listed === workspace && mq.number === number) {
      Object.assign(mq, { created: result as ReviewJobResult, ticked: new Set<string>(), text: '' });
    }
  } catch (error) {
    mq.error = error instanceof ActionError ? error.message : `The request failed (${errorMessage(error)}); it may have taken effect: look for the ticket on the board.`;
  }
  mq.busy = null;
  renderMergeRequests();
}

// "src/export.ts:12", "src/export.ts" without a line, "General" without a path.
const mqWhere = (thread: ReviewThread): string => (thread.path === null ? 'General' : thread.line === null ? thread.path : `${thread.path}:${thread.line}`);

// One thread: its checkbox, where it is, whether it is resolved, and each comment as text.
function mqThread(thread: ReviewThread): HTMLElement {
  const item = el('li', 'mq-thread');
  const label = el('label', 'mq-tick');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = mq.ticked.has(thread.id);
  box.dataset.mq = `thread:${thread.id}`;
  box.addEventListener('change', () => {
    if (box.checked) {
      mq.ticked.add(thread.id);
    } else {
      mq.ticked.delete(thread.id);
    }
    renderMergeRequests();
  });
  label.append(box, el('span', 'mq-where', mqWhere(thread)));
  if (thread.resolved === true) {
    label.append(el('span', 'mq-tag', 'resolved'));
  }
  item.append(label);
  for (const comment of thread.comments) {
    const row = el('div', 'mq-comment');
    const head = el('div', 'mq-chead');
    head.append(el('b', '', comment.author), timeEl(comment.created_at));
    row.append(head, el('div', 'mq-cbody', comment.body));
    item.append(row);
  }
  return item;
}

// A toggle of hidden threads ("Show resolved (2)"), and the threads when it is on.
function mqHidden(threads: readonly ReviewThread[], what: string, key: 'resolved' | 'bots'): HTMLElement[] {
  if (threads.length === 0) {
    return [];
  }
  const toggle = button('linkish', `${mq[key] ? 'Hide' : 'Show'} ${what} (${threads.length})`, { mq: key });
  toggle.setAttribute('aria-expanded', String(mq[key]));
  toggle.addEventListener('click', () => {
    mq[key] = !mq[key];
    renderMergeRequests();
  });
  if (!mq[key]) {
    return [toggle];
  }
  const shown = el('ul', 'mq-threads');
  shown.append(...threads.map(mqThread));
  return [toggle, shown];
}

// The threads: the people's open ones first, their resolved ones behind "Show resolved (N)", and
// the threads only bots wrote behind "Show bot comments (M)".
function mqThreads(threads: readonly ReviewThread[]): HTMLElement[] {
  if (threads.length === 0) {
    return [el('p', 'muted fs13', 'No review comments on this merge request.')];
  }
  const bots = threads.filter((thread) => thread.comments.every((comment) => comment.bot));
  const people = threads.filter((thread) => !bots.includes(thread));
  const list = el('ul', 'mq-threads');
  list.append(...people.filter((thread) => thread.resolved !== true).map(mqThread));
  return [list, ...mqHidden(people.filter((thread) => thread.resolved === true), 'resolved', 'resolved'), ...mqHidden(bots, 'bot comments', 'bots')];
}

// The merge request expanded: its threads, Your instructions and Create job.
function mqChosen(request: OpenMergeRequest): HTMLElement {
  const card = el('section', 'card2 mq-chosen');
  if (mq.threadsReading) {
    card.append(el('p', 'muted fs13', 'Loading the comments…'));
  } else if (mq.threads !== null) {
    card.append(...mqThreads(mq.threads));
  }
  const label = el('label', 'mq-label', 'Your instructions');
  label.htmlFor = 'mq-text';
  const text = el('textarea', 'mq-text');
  text.id = 'mq-text';
  text.rows = 4;
  text.maxLength = MQ_MAX_INSTRUCTIONS;
  text.value = mq.text;
  text.dataset.mq = 'text';
  text.placeholder = 'Fix this and that (optional with ticked comments)';
  const create = button('btn primary', mq.busy === 'create' ? 'Creating…' : 'Create job', { mq: 'create' });
  create.disabled = !mqCanCreate();
  create.addEventListener('click', () => void createFromReview());
  text.addEventListener('input', () => {
    mq.text = text.value;
    create.disabled = !mqCanCreate();
  });
  const hint = el('p', 'hint', `${counted(mq.ticked.size, 'comment')} ticked. The job continues ${request.source}; it ends as any job does: handed over to your checkout, or Approve pushes onto the merge request's branch.`);
  card.append(label, text, hint, create);
  if (mq.created !== null) {
    const done = el('p', 'fs13 mq-created');
    const open = el('a', '', mq.created.ticket);
    open.href = `#${mq.created.workspace}/${mq.created.ticket}/ticket`;
    done.append('Created ', open, `, queued at position ${mq.created.position}.`);
    card.append(done);
  }
  return card;
}

function renderMergeRequests(): void {
  if (ui.screen !== 'merge-requests') {
    return;
  }
  const page = byId('merge-requests');
  const names = (state.workspaces ?? []).map((row) => row.name);
  // The workspace chosen, or the first when it is gone: a change, read at once.
  mqSetWorkspace(mq.workspace !== '' && names.includes(mq.workspace) ? mq.workspace : names[0] ?? '');
  if (mq.fresh && mq.workspace !== '' && !mq.reading) {
    // The read draws the page.
    void loadMergeRequests();
    return;
  }
  const backButton = button('btn back', '← Board ', { back: '', mq: 'back' });
  backButton.append(el('span', 'kbd', 'Esc'));
  backButton.setAttribute('title', 'Back to the board (Esc)');
  const t1 = el('div', 't1');
  t1.append(el('span', 'title', 'Merge requests'));
  const pick = el('select', 'dg-pick');
  pick.setAttribute('aria-label', 'Workspace');
  pick.dataset.mq = 'workspace';
  for (const name of names) {
    const option = el('option', '', name);
    option.value = name;
    pick.append(option);
  }
  pick.value = mq.workspace;
  // Not while Create job posts: its answer belongs to this workspace's list.
  pick.disabled = mq.busy !== null;
  pick.addEventListener('change', () => {
    mqSetWorkspace(pick.value);
    renderMergeRequests();
  });
  const refresh = button('btn', 'Refresh', { mq: 'refresh' });
  refresh.disabled = mq.workspace === '' || mq.reading || mq.busy !== null;
  refresh.addEventListener('click', () => void loadMergeRequests());
  const age = el('span', 'muted fs13 mq-age', mqAge());
  age.dataset.mqAge = '';
  const tools = el('div', 'tools');
  tools.append(pick, refresh, age);
  const t2 = el('div', 't2', 'Review comments of an open merge request, as a job on its branch. Nothing is written to the Git host.');
  const head = el('header', 'jhead');
  head.append(backButton, t1, tools, t2);
  const body = el('div', 'mq-body');
  if (names.length === 0) {
    body.append(el('p', 'muted fs13', 'No workspace yet: add one under Workspaces.'));
  }
  if (mq.error !== null) {
    body.append(el('p', 'err-text fs13', mq.error));
  }
  if (mq.reading && mq.requests === null) {
    body.append(el('p', 'muted fs13', 'Loading the merge requests…'));
  }
  const requests = mq.requests ?? [];
  if (mq.requests !== null && requests.length === 0) {
    body.append(el('p', 'muted fs13', `No open merge requests in ${mq.listed ?? ''}.`));
  } else if (requests.length > 0) {
    const list = el('ul', 'mq-list');
    for (const request of requests) {
      const expanded = request.number === mq.number;
      const item = el('li');
      item.append(mrRow(request, mq.overviews.get(request.number) ?? 'reading', expanded, () => chooseRequest(expanded ? null : request.number)));
      if (expanded) {
        item.append(mqChosen(request));
      }
      list.append(item);
    }
    body.append(list);
  }
  // The focus stays on the control it was on; the scroll where it was.
  const active = document.activeElement;
  const focused = active !== null && page.contains(active) && hasDataset(active) ? active.dataset?.mq : undefined;
  const scroll = page.querySelector('.form2')?.scrollTop ?? 0;
  const wrap = el('div', 'form2');
  wrap.append(body);
  page.replaceChildren(head, wrap);
  wrap.scrollTop = scroll;
  if (focused !== undefined) {
    [...page.querySelectorAll<HTMLElement>('[data-mq]')].find((node) => node.dataset.mq === focused)?.focus();
  }
}
