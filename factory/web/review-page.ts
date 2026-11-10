// review-page.js, the dashboard's script after reports.js (DASHBOARD_SCRIPTS in
// src/dashboard.ts), built from web/review-page.ts into dist/web/: the Merge requests page
// (#merge-requests), and leavePages, which hides the pages besides the board. The user picks a
// registered workspace, loads its open merge requests, chooses one, fetches its review threads,
// ticks the ones to implement, adds instructions of their own, and creates a job that continues the
// merge request's branch (POST api/workspaces/<ws>/merge-requests/<number>/job, src/review-job.ts).
// The server reads the comments from the Git host again; the page sends only the thread ids. Every
// host text (titles, authors, paths, comment bodies) is set as text, never as HTML. A classic
// script, loaded in order with defer, sharing the page's globals with the others. This file has no
// import or export on purpose: the compiler keeps it a script, so its top-level names stay the
// page's globals.
'use strict';

// The most characters of the user's instructions (src/review-job.ts MAX_INSTRUCTIONS_CHARS).
const MQ_MAX_INSTRUCTIONS = 4000;

// The page's state, in page memory only: the workspace chosen, its open merge requests as last
// loaded (listed: the workspace they are of), the merge request chosen and its threads as last
// fetched, the threads ticked, whether the resolved ones are shown, the instructions typed, the read
// or post under way, the last error, the job created, and the count of reads (an older answer is
// ignored).
const mq: {
  workspace: string;
  listed: string | null;
  requests: OpenMergeRequest[] | null;
  number: number | null;
  threads: ReviewThread[] | null;
  ticked: Set<string>;
  resolved: boolean;
  text: string;
  busy: 'load' | 'fetch' | 'create' | null;
  error: string | null;
  created: ReviewJobResult | null;
  load: number;
} = { workspace: '', listed: null, requests: null, number: null, threads: null, ticked: new Set(), resolved: false, text: '', busy: null, error: null, created: null, load: 0 };

// The pages besides the board, a job's and a ticket's, hidden (a page that opens shows its own).
function leavePages(): void {
  byId('digest').hidden = true;
  leaveDigest();
  byId('stats').hidden = true;
  byId('merge-requests').hidden = true;
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
  } catch {
    // An empty refusal (an unknown workspace): the status says it.
  }
  throw new Error(message);
}

// Load: the open merge requests of the workspace chosen; the choice below it starts again.
async function loadMergeRequests(): Promise<void> {
  const workspace = mq.workspace;
  if (workspace === '' || mq.busy !== null) {
    return;
  }
  mq.load += 1;
  const load = mq.load;
  Object.assign(mq, { busy: 'load', error: null, requests: null, listed: null, created: null });
  chooseRequest(null);
  try {
    const requests = await mqGet(`api/workspaces/${encodeURIComponent(workspace)}/merge-requests`);
    if (load === mq.load) {
      mq.requests = Array.isArray(requests) ? (requests as OpenMergeRequest[]) : [];
      mq.listed = workspace;
    }
  } catch (error) {
    if (load === mq.load) {
      mq.error = `The merge requests could not be read: ${errorMessage(error)}`;
    }
  }
  if (load === mq.load) {
    mq.busy = null;
    renderMergeRequests();
  }
}

// The merge request chosen (null: none): its threads, ticks and instructions start empty.
function chooseRequest(number: number | null): void {
  Object.assign(mq, { number, threads: null, ticked: new Set<string>(), resolved: false, text: '', created: null });
  renderMergeRequests();
}

// Fetch comments: the review threads of the merge request chosen; the ticks start again.
async function fetchThreads(): Promise<void> {
  const { listed: workspace, number } = mq;
  if (workspace === null || number === null || mq.busy !== null) {
    return;
  }
  mq.load += 1;
  const load = mq.load;
  Object.assign(mq, { busy: 'fetch', error: null, threads: null, ticked: new Set<string>(), created: null });
  renderMergeRequests();
  try {
    const threads = await mqGet(`api/workspaces/${encodeURIComponent(workspace)}/merge-requests/${number}/threads`);
    if (load === mq.load) {
      mq.threads = Array.isArray(threads) ? (threads as ReviewThread[]) : [];
    }
  } catch (error) {
    if (load === mq.load) {
      mq.error = `The review comments could not be read: ${errorMessage(error)}`;
    }
  }
  if (load === mq.load) {
    mq.busy = null;
    renderMergeRequests();
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
    const result = await post(`api/workspaces/${encodeURIComponent(workspace)}/merge-requests/${number}/job`, { threads: [...mq.ticked], instructions: mq.text });
    Object.assign(mq, { created: result as ReviewJobResult, ticked: new Set<string>(), text: '' });
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

// The threads: the open ones first, the resolved ones behind "Show resolved (N)".
function mqThreads(threads: readonly ReviewThread[]): HTMLElement[] {
  if (threads.length === 0) {
    return [el('p', 'muted fs13', 'No review comments on this merge request.')];
  }
  const open = threads.filter((thread) => thread.resolved !== true);
  const resolved = threads.filter((thread) => thread.resolved === true);
  const list = el('ul', 'mq-threads');
  list.append(...open.map(mqThread));
  const parts: HTMLElement[] = [list];
  if (resolved.length > 0) {
    const toggle = button('linkish', `${mq.resolved ? 'Hide' : 'Show'} resolved (${resolved.length})`, { mq: 'resolved' });
    toggle.setAttribute('aria-expanded', String(mq.resolved));
    toggle.addEventListener('click', () => {
      mq.resolved = !mq.resolved;
      renderMergeRequests();
    });
    parts.push(toggle);
    if (mq.resolved) {
      const shown = el('ul', 'mq-threads');
      shown.append(...resolved.map(mqThread));
      parts.push(shown);
    }
  }
  return parts;
}

// The merge request chosen: Fetch comments, its threads, Your instructions and Create job.
function mqChosen(request: OpenMergeRequest): HTMLElement {
  const card = el('section', 'card2 mq-chosen');
  const title = el('h3', '', `!${request.number} ${request.title}`);
  // The host's URL as a link only when it is http(s).
  if (/^https?:\/\//i.test(request.url)) {
    const link = el('a', 'linkish', 'Open on the host');
    link.href = request.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    title.append(link);
  }
  const fetchButton = button('btn', mq.busy === 'fetch' ? 'Fetching…' : 'Fetch comments', { mq: 'fetch' });
  fetchButton.disabled = mq.busy !== null;
  fetchButton.addEventListener('click', () => void fetchThreads());
  card.append(title, fetchButton);
  if (mq.threads !== null) {
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
  if (mq.workspace === '' || !names.includes(mq.workspace)) {
    mq.workspace = names[0] ?? '';
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
  // Another workspace: the list shown was the other's (a read under way is ignored).
  pick.addEventListener('change', () => {
    mq.load += 1;
    Object.assign(mq, { workspace: pick.value, requests: null, listed: null, error: null, busy: null });
    chooseRequest(null);
  });
  const load = button('btn', mq.busy === 'load' ? 'Loading…' : 'Load', { mq: 'load' });
  load.disabled = mq.workspace === '' || mq.busy !== null;
  load.addEventListener('click', () => void loadMergeRequests());
  const tools = el('div', 'tools');
  tools.append(pick, load);
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
  if (mq.busy === 'load') {
    body.append(el('p', 'muted fs13', 'Loading the merge requests…'));
  }
  const requests = mq.requests ?? [];
  if (mq.requests !== null && requests.length === 0) {
    body.append(el('p', 'muted fs13', `No open merge requests in ${mq.listed ?? ''}.`));
  } else if (requests.length > 0) {
    const list = el('ul', 'mq-list');
    for (const request of requests) {
      const choice = button(request.number === mq.number ? 'mq-req on' : 'mq-req', undefined, { mq: `request:${request.number}` });
      choice.setAttribute('aria-pressed', String(request.number === mq.number));
      const meta = el('span', 'mq-meta', `${request.author} · ${request.source} → ${request.target} · updated `);
      meta.append(timeEl(request.updated_at));
      if (request.draft) {
        meta.append(' · draft');
      }
      choice.append(el('span', 'mq-title', `!${request.number} ${request.title}`), meta);
      choice.addEventListener('click', () => chooseRequest(request.number === mq.number ? null : request.number));
      const item = el('li');
      item.append(choice);
      list.append(item);
    }
    body.append(list);
  }
  const chosen = requests.find((request) => request.number === mq.number);
  if (chosen !== undefined) {
    body.append(mqChosen(chosen));
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
