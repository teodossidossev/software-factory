// Software Factory dashboard v2. Loads api/jobs, follows one job through api/stream (server-sent
// events) and renders it. The User's approve, abort, say and Retry review (after a failed Claude
// review, SF-044) go as POSTs to api/jobs/<ws>/<ticket>/<action>: each one is a deliberate click,
// confirmed for approve and abort, never retried or replayed by the page. The start screen (Setup)
// lists the workspaces and the tickets without a job, adds a workspace, writes a ticket draft,
// opens the ChatGPT conversation that plans a ticket (a link the User clicks) and starts the job
// of a ticket whose Task file is written (SF-040). Every value goes in through textContent; the
// one href is the server's ChatGPT URL, checked against its fixed prefix.
'use strict';

const RECONNECT_MS = 3000;
const READ_TIMEOUT_MS = 10000;
const TERMINAL_STATES = ['pushed', 'aborted', 'failed'];
const SAY_STATES = ['working', 'awaiting_review', 'needs_human', 'ready_for_human_review'];
const ACTION_LABELS = { approve: 'Approve', abort: 'Abort', say: 'Send', review: 'Retry review', archive: 'Archive' };
const PENDING_REASONS = {
  approve: 'the push was requested; waiting for its outcome.',
  abort: 'abort was requested; waiting for its outcome.',
  say: 'the message is being sent.',
  review: 'the review is being restarted.',
  archive: 'the job is being archived.',
};
const PENDING_TEXT = {
  approve: 'Pushing the branch…',
  abort: 'Abort requested; waiting for the job to end.',
  say: 'Sending the message…',
  review: 'Restarting the review…',
  archive: 'Archiving the job…',
};
const $ = (id) => document.getElementById(id);
// The views of the selected job, one tab panel each (#tab-<name>).
const JOB_TABS = [['iterations', 'Iterations'], ['mr', 'Merge request'], ['history', 'State history'], ['events', 'Event stream']];

const state = {
  jobs: [],
  key: null, // "<ws>/<ticket>" of the selected job
  detail: null,
  iteration: null, // selected iteration number
  view: 'report',
  // The selected job view; kept across jobs.
  tab: 'iterations',
  cache: new Map(), // "<n>/<view>" -> text, for the selected job
  source: null,
  retry: null,
  lastLine: -1,
  // Actions, per job: "<action>\n<key>" while its request is out; the last outcome shown for the
  // job; the draft message; the job's unknown outcome until a current state is read after it,
  // and its warning; and the open confirmation, with the job it was opened for.
  pending: new Set(),
  outcomes: new Map(),
  drafts: new Map(),
  unresolved: new Map(),
  doubts: new Map(),
  confirm: null,
  // The files expanded in the Files view: "<iteration>/<path>" of the selected job.
  expanded: new Set(),
  // The start screen: the registry and the tickets without a job (null until the stream sends
  // them), whether the section's open state was decided from the first data, the requests out
  // for its forms and the open delete confirmation of a ticket.
  workspaces: null,
  tickets: null,
  archived: [],
  setupDecided: false,
  setupPending: new Set(),
  ticketConfirm: null,
};
// The only URL the page links to: the ChatGPT composer prefilled by the server (the prefix of
// src/conversation.ts).
const CHATGPT_PREFILL_URL = 'https://chatgpt.com/?q=';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

const keyOf = (job) => `${job.workspace}/${job.ticket}`;
const jobPath = (key) => key.split('/').map(encodeURIComponent).join('/');
const shortTime = (ts) => (typeof ts === 'string' ? ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '');
const pendingId = (action, key) => `${action}\n${key}`;

async function getText(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return response.text();
}

// A refusal of an action by the factory: its code and message, shown as they are.
class ActionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// The action's answer. A 4xx, and a 5xx that names a factory refusal, is definite: ActionError.
// Anything else (no answer, a body cut or unreadable after the headers, a 2xx without a result,
// an internal failure) throws a plain Error: the action may have run.
async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const refused = response.status >= 400 && response.status < 500;
  let data;
  try {
    data = await response.json();
  } catch {
    if (refused) {
      // Not the factory's JSON (an empty 404 of a rotated token or a vanished job, a 405).
      throw new ActionError(`http_${response.status}`, `The factory answered HTTP ${response.status} without a result; nothing was done. If sf serve restarted, open the new dashboard URL.`);
    }
    throw new Error(`HTTP ${response.status}, the answer could not be read`);
  }
  if (response.ok && data !== null && typeof data === 'object' && data.ok === true && Object.hasOwn(data, 'result')) {
    return data.result;
  }
  const error = data !== null && typeof data === 'object' && typeof data.error === 'object' && data.error !== null ? data.error : {};
  if (refused || (response.status >= 500 && typeof error.code === 'string' && error.code !== 'internal_error')) {
    throw new ActionError(String(error.code ?? `http_${response.status}`), String(error.message ?? `HTTP ${response.status}`));
  }
  throw new Error(`HTTP ${response.status}${error.code ? ` ${error.code}` : ''}, no result`);
}

function setConnection(text, kind) {
  const node = $('connection');
  node.textContent = text;
  node.className = `connection ${kind}`;
}

// The file badges of a job (SF-024): the count of the last iteration, and warnings for undeclared
// sensitive and deleted files.
function fileBadges(job) {
  const badges = [];
  if (typeof job.files === 'number' && job.files > 0) {
    badges.push(el('span', 'badge f-count', `${job.files} file${job.files === 1 ? '' : 's'}`));
  }
  if (typeof job.undeclared === 'number' && job.undeclared > 0) {
    badges.push(el('span', 'badge f-undeclared', `${job.undeclared} sensitive`));
  }
  if (typeof job.deleted === 'number' && job.deleted > 0) {
    badges.push(el('span', 'badge f-deleted', `${job.deleted} deleted`));
  }
  return badges;
}

function renderJobs() {
  const list = $('job-list');
  $('no-jobs').hidden = state.jobs.length > 0;
  if (!state.setupDecided && state.workspaces !== null) {
    renderSetup();
  }
  const sorted = [...state.jobs].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  list.replaceChildren(...sorted.map((job) => {
    const button = el('button');
    button.type = 'button';
    button.setAttribute('aria-current', String(keyOf(job) === state.key));
    button.append(el('div', 'job-name', keyOf(job)));
    button.append(el('div', 'job-workspace', `${job.workspace} · ${job.branch}`));
    const line = el('div', 'job-line');
    line.append(el('span', `badge s-${job.state}`, job.state));
    line.append(...fileBadges(job));
    line.append(el('span', 'iter', `iteration ${job.iteration}`));
    button.append(line);
    button.addEventListener('click', () => select(keyOf(job)));
    const item = el('li');
    item.append(button);
    return item;
  }));
}

function mostRecent() {
  return [...state.jobs].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

function renderHeader(detail) {
  const job = detail.job;
  $('job-ticket').textContent = job.ticket;
  const badge = $('job-state');
  badge.textContent = job.state;
  badge.className = `badge s-${job.state}`;
  $('job-branch').textContent = job.branch;
  $('job-base').textContent = job.base;
  $('job-iteration').textContent = job.mr_attempts > 0 ? `${job.iteration} (MR attempts ${job.mr_attempts})` : String(job.iteration);
  // The iterations and their reviews.
  const costs = detail.iterations.flatMap((iteration) => [iteration.cost_usd, iteration.review?.cost_usd]).filter((cost) => typeof cost === 'number');
  // An estimate of the API-equivalent price, not a charge: the session usually runs on a Claude plan.
  $('job-cost').textContent = costs.length > 0 ? `est. $${costs.reduce((sum, cost) => sum + cost, 0).toFixed(4)}` : 'n/a';
  $('job-updated').textContent = shortTime(job.updated_at);
  $('job-worktree').textContent = typeof job.worktree === 'string' ? job.worktree : (job.state === 'ready_for_human_review' ? 'none: the branch is in the checkout' : 'none');
  $('job-badges').replaceChildren(...fileBadges(job));
  const error = $('job-error');
  error.hidden = job.error === null;
  error.textContent = job.error === null ? '' : `${job.error.code}: ${job.error.message}`;
}

function renderHistory(history) {
  $('history').replaceChildren(...history.map((entry) => {
    const item = el('li');
    item.append(el('time', '', shortTime(entry.ts)), document.createTextNode(`${entry.from ?? '-'} → ${entry.to}`));
    if (entry.error) {
      item.append(el('span', 'history-error', ` (${entry.error.code}: ${entry.error.message})`));
    }
    return item;
  }));
}

function renderIterationTabs(iterations) {
  $('no-iterations').hidden = iterations.length > 0;
  $('iteration-views').hidden = iterations.length === 0;
  $('iteration-tabs').replaceChildren(...iterations.map((iteration) => {
    const button = el('button', '', `Iteration ${iteration.number}`);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(iteration.number === state.iteration));
    button.addEventListener('click', () => {
      state.iteration = iteration.number;
      renderIterationTabs(state.detail.iterations);
      void showIteration();
    });
    return button;
  }));
  for (const button of $('iteration-views').querySelectorAll('button')) {
    button.setAttribute('aria-selected', String(button.dataset.view === state.view));
  }
}

// Report: preformatted, Markdown headings bold.
function renderReport(text) {
  return text.split('\n').map((line) => el('span', /^#{1,6}\s/.test(line) ? 'heading' : '', `${line}\n`));
}

// Patch: preformatted, + and - lines coloured, file headers bold.
function renderPatch(text) {
  return text.split('\n').map((line) => {
    let className = '';
    if (/^(diff --git |\+\+\+ |--- |index |new file mode |deleted file mode |rename |similarity |Binary files )/.test(line)) {
      className = 'file';
    } else if (line.startsWith('@@')) {
      className = 'hunk';
    } else if (line.startsWith('+')) {
      className = 'add';
    } else if (line.startsWith('-')) {
      className = 'del';
    }
    return el('span', className, `${line}\n`);
  });
}

async function showIteration() {
  const key = state.key;
  const body = $('iteration-body');
  const meta = state.detail?.iterations.find((iteration) => iteration.number === state.iteration);
  if (meta === undefined) {
    body.replaceChildren();
    $('iteration-meta').textContent = '';
    renderReview($('iteration-review'), null);
    renderReview($('iteration-gate'), null);
    return;
  }
  const cost = typeof meta.cost_usd === 'number' ? `$${meta.cost_usd.toFixed(4)}` : 'n/a';
  $('iteration-meta').textContent = `${shortTime(meta.started_at)} – ${shortTime(meta.ended_at)}, cost ${cost}, ` +
    `${meta.changed_files} changed file(s), ${meta.denials} denial(s)${meta.patch_truncated ? ', patch truncated' : ''}`;
  renderReview($('iteration-review'), meta.review ?? null);
  renderReview($('iteration-gate'), meta.gate ?? null);
  const filesView = state.view === 'files';
  $('files-view').hidden = !filesView;
  body.hidden = filesView;
  if (filesView) {
    body.replaceChildren();
    renderFiles(meta);
    return;
  }
  const text = await iterationText(key, meta.number, state.view);
  if (text === undefined) {
    return;
  }
  if (`${meta.number}/${state.view}` === `${state.iteration}/${state.view}`) {
    body.replaceChildren(...(state.view === 'patch' ? renderPatch(text) : renderReport(text)));
  }
}

// A review of the selected iteration in its block: Claude's (SF-038) or the gate's (SF-039), with
// its verdict, summary and items, or why it failed; hidden while none ended.
function renderReview(block, review) {
  block.hidden = review === null;
  if (review === null) {
    block.replaceChildren();
    return;
  }
  if (typeof review.error === 'string') {
    block.className = 'review v-failed';
    block.replaceChildren(el('p', 'review-verdict', `Review by ${review.reviewer}: failed`), el('p', 'review-summary', review.error));
    return;
  }
  const count = review.items.length;
  const verdict = review.verdict === 'fix' ? `fix (${count} ${count === 1 ? 'item' : 'items'})` : review.verdict;
  const cost = typeof review.cost_usd === 'number' ? `, cost $${review.cost_usd.toFixed(4)}` : '';
  const tokens = review.tokens !== null && typeof review.tokens === 'object' && typeof review.tokens.input === 'number'
    ? `, ${review.tokens.input + review.tokens.output} tokens` : '';
  block.className = `review v-${review.verdict}`;
  const children = [el('p', 'review-verdict', `Review by ${review.reviewer}: ${verdict}${cost}${tokens}`), el('p', 'review-summary', review.summary)];
  if (review.verdict === 'fix' && count > 0) {
    const list = el('ol', 'review-items');
    list.append(...review.items.map((item) => {
      const entry = el('li');
      entry.append(el('code', '', item.path), document.createTextNode(`: ${item.problem} Expected: ${item.expected}`));
      return entry;
    }));
    children.push(list);
  }
  if (review.accepted_sensitive.length > 0) {
    children.push(el('p', 'review-accepted', `Accepted sensitive paths: ${review.accepted_sensitive.join(', ')}`));
  }
  block.replaceChildren(...children);
}

// The Report or the Patch of an iteration, loaded once per job; undefined when the selection
// changed while it loaded.
async function iterationText(key, number, view) {
  const cacheKey = `${number}/${view}`;
  let text = state.cache.get(cacheKey);
  if (text === undefined) {
    try {
      text = await getText(`api/jobs/${jobPath(key)}/iterations/${number}/${view}`);
    } catch (error) {
      text = `Could not load: ${error.message}`;
    }
    if (key !== state.key) {
      return undefined;
    }
    state.cache.set(cacheKey, text);
  }
  return text;
}

// The rows of the Files view in order: undeclared sensitive, declared sensitive, deleted, the
// rest by file name; each row knows its group label.
function fileRows(files) {
  const name = (file) => file.path.slice(file.path.lastIndexOf('/') + 1);
  const byName = (a, b) => name(a).localeCompare(name(b)) || a.path.localeCompare(b.path);
  const undeclared = files.filter((file) => file.sensitive === 'undeclared').sort(byName);
  const declared = files.filter((file) => file.sensitive === 'declared').sort(byName);
  const deleted = files.filter((file) => file.sensitive === 'no' && file.status === 'deleted').sort(byName);
  const rest = files.filter((file) => file.sensitive === 'no' && file.status !== 'deleted').sort(byName);
  return [
    ...undeclared.map((file) => ({ file, group: 'Sensitive, undeclared' })),
    ...declared.map((file) => ({ file, group: 'Sensitive, declared' })),
    ...deleted.map((file) => ({ file, group: 'Deleted' })),
    ...rest.map((file) => ({ file, group: 'Changed' })),
  ];
}

// The part of a unified Patch that belongs to one file: from its "diff --git" header to the next
// header; undefined when the Patch omits it (binary, or beyond the size limit).
function fileDiff(patch, path) {
  const lines = patch.split('\n');
  const plain = `diff --git a/${path} b/${path}`;
  const start = lines.findIndex((line) => line === plain || (line.startsWith('diff --git "a/') && line.includes(path)));
  if (start < 0) {
    return undefined;
  }
  let end = lines.findIndex((line, index) => index > start && line.startsWith('diff --git '));
  if (end < 0) {
    end = lines.length;
  }
  return lines.slice(start, end).join('\n');
}

function renderFiles(meta) {
  const files = Array.isArray(meta.files) ? meta.files : null;
  $('no-files').hidden = files !== null && files.length > 0;
  $('no-files').textContent = files === null ? 'This iteration was published before the file list existed; the Report lists its files.' : 'No files changed.';
  const undeclared = (files ?? []).filter((file) => file.sensitive === 'undeclared').length;
  const deleted = (files ?? []).filter((file) => file.status === 'deleted').length;
  const parts = [`Files ${(files ?? []).length}`];
  if (undeclared > 0) {
    parts.push(`${undeclared} sensitive undeclared`);
  }
  if (deleted > 0) {
    parts.push(`${deleted} deleted`);
  }
  $('files-summary').textContent = parts.join(' · ');
  const rows = fileRows(files ?? []);
  $('files-expand').disabled = rows.length === 0;
  $('files-collapse').disabled = rows.length === 0;
  let group = null;
  const items = [];
  for (const { file, group: label } of rows) {
    if (label !== group) {
      group = label;
      const heading = el('li', 'file-group', label);
      items.push(heading);
    }
    items.push(fileRow(meta, file));
  }
  $('files-list').replaceChildren(...items);
}

function fileRow(meta, file) {
  const item = el('li');
  const row = el('button', `file-row s-${file.status}`);
  row.type = 'button';
  const slash = file.path.lastIndexOf('/');
  row.append(el('span', 'file-name', file.path.slice(slash + 1)));
  if (slash >= 0) {
    row.append(el('span', 'file-dir', file.path.slice(0, slash)));
  }
  if (file.status === 'renamed' && typeof file.from === 'string') {
    row.append(el('span', 'file-dir', `← ${file.from}`));
  }
  const labels = el('span', 'file-labels');
  if (file.sensitive !== 'no') {
    labels.append(el('span', `file-label ${file.sensitive}`, `sensitive, ${file.sensitive}`));
  }
  if (file.status === 'deleted') {
    labels.append(el('span', 'file-label deleted', 'deleted'));
  }
  const counts = el('span', 'file-counts');
  counts.append(el('span', 'add', `+${file.additions}`), document.createTextNode(' '), el('span', 'del', `−${file.deletions}`));
  labels.append(counts);
  row.append(labels);
  const id = `${meta.number}/${file.path}`;
  row.setAttribute('aria-expanded', String(state.expanded.has(id)));
  row.addEventListener('click', () => void toggleFile(meta, file));
  item.append(row);
  if (state.expanded.has(id)) {
    const diff = el('pre', 'document file-diff');
    diff.textContent = 'Loading the Patch…';
    item.append(diff);
    void fillDiff(diff, meta, file);
  }
  return item;
}

async function fillDiff(node, meta, file) {
  const text = await iterationText(state.key, meta.number, 'patch');
  if (text === undefined) {
    return;
  }
  const section = fileDiff(text, file.path);
  if (section === undefined) {
    node.replaceChildren(document.createTextNode(`The Patch omits ${file.path}: a binary file, or beyond the Patch size limit.`));
  } else {
    node.replaceChildren(...renderPatch(section));
  }
}

async function toggleFile(meta, file) {
  const id = `${meta.number}/${file.path}`;
  if (state.expanded.has(id)) {
    state.expanded.delete(id);
  } else {
    state.expanded.add(id);
  }
  renderFiles(meta);
}

function setAllExpanded(expanded) {
  const meta = state.detail?.iterations.find((iteration) => iteration.number === state.iteration);
  if (meta === undefined) {
    return;
  }
  for (const file of Array.isArray(meta.files) ? meta.files : []) {
    const id = `${meta.number}/${file.path}`;
    if (expanded) {
      state.expanded.add(id);
    } else {
      state.expanded.delete(id);
    }
  }
  renderFiles(meta);
}

async function showMr() {
  const key = state.key;
  const panel = $('mr-panel');
  if (!state.detail?.mr) {
    panel.hidden = true;
    $('no-mr').hidden = false;
    return;
  }
  let text;
  try {
    text = await getText(`api/jobs/${jobPath(key)}/mr`);
  } catch (error) {
    text = `Could not load: ${error.message}`;
  }
  if (key === state.key) {
    $('mr-body').replaceChildren(...renderReport(text));
    panel.hidden = false;
    $('no-mr').hidden = true;
  }
}

function renderDetail(detail) {
  const previous = state.detail;
  state.detail = detail;
  $('detail').hidden = false;
  const numbers = detail.iterations.map((iteration) => iteration.number);
  const newest = numbers.length > 0 ? numbers[numbers.length - 1] : null;
  // Follow the newest iteration unless the user picked an older one.
  const wasNewest = previous === null || state.iteration === null ||
    state.iteration === previous.iterations[previous.iterations.length - 1]?.number;
  if (wasNewest || !numbers.includes(state.iteration)) {
    state.iteration = newest;
  }
  renderHeader(detail);
  renderHistory(detail.history);
  renderIterationTabs(detail.iterations);
  void showIteration();
  void showMr();
  renderActions();
}

// The job waits for the user after a failed Claude review: Retry review runs it again.
const reviewFailed = (job) => job.state === 'needs_human' && job.error?.code === 'review_failed';

const preparationKnown = (job) => job.state === 'preparing_mr' || state.pending.has(pendingId('approve', keyOf(job)));

// Why an action is unavailable for the job, or '' when the page lets it through. Guidance only:
// the factory's own guards decide, and their refusal is shown as it comes.
function availability(action, job) {
  if (job === null) {
    return 'the job is loading.';
  }
  if (state.pending.has(pendingId(action, keyOf(job)))) {
    return PENDING_REASONS[action];
  }
  const unresolved = state.unresolved.get(keyOf(job));
  // Abort stays for a preparation known to run: it is the only way to stop it.
  if (unresolved !== undefined && !(action === 'abort' && preparationKnown(job))) {
    return unresolved.failed
      ? "the last action's outcome is unknown and the current state could not be loaded."
      : "the last action's outcome is unknown; waiting for the current state.";
  }
  if (action === 'approve') {
    if (job.state === 'ready_for_human_review' || (job.state === 'needs_human' && typeof job.prepared_commit === 'string' && job.worktree === null)) {
      return '';
    }
    if (job.state === 'needs_human') {
      return 'approve pushes a branch prepared at Clean; this job has none yet.';
    }
    if (job.state === 'preparing_mr') {
      return 'the branch is being prepared.';
    }
    if (job.state === 'awaiting_review') {
      return 'the reviewers have not reached Clean yet.';
    }
    return `not available while the job is ${job.state}.`;
  }
  if (action === 'abort') {
    return TERMINAL_STATES.includes(job.state) ? `the job is already ${job.state}.` : '';
  }
  if (action === 'review') {
    return reviewFailed(job) ? '' : 'only after a failed review.';
  }
  return SAY_STATES.includes(job.state) ? '' : `messages need working, awaiting_review, needs_human or ready_for_human_review; the job is ${job.state}.`;
}

function renderActions() {
  const job = state.detail?.job ?? null;
  // A confirmation opened before the doubt is not one the User could open now.
  if (state.confirm !== null && state.unresolved.has(state.confirm.key) && availability(state.confirm.action, job) !== '') {
    closeConfirm();
    return;
  }
  const reasons = [];
  for (const action of ['approve', 'abort']) {
    const reason = availability(action, job);
    // Both stay off while a confirmation is open, so it cannot be retargeted.
    $(`${action}-button`).disabled = reason !== '' || state.confirm !== null;
    if (reason !== '') {
      reasons.push(`${ACTION_LABELS[action]}: ${reason}`);
    }
  }
  // Retry review shows only after a failed review; while it is held, its reason says why.
  const retryable = job !== null && reviewFailed(job);
  const retryReason = availability('review', job);
  $('retry-review-button').hidden = !retryable;
  $('retry-review-button').disabled = !retryable || retryReason !== '';
  if (retryable && retryReason !== '') {
    reasons.push(`${ACTION_LABELS.review}: ${retryReason}`);
  }
  $('action-reasons').textContent = reasons.join(' ');
  $('refresh-button').hidden = state.unresolved.get(state.key)?.failed !== true;
  // A finished job can leave the list: Archive replaces Approve and Abort, which are off anyway.
  const finished = job !== null && TERMINAL_STATES.includes(job.state);
  $('archive-job-button').hidden = !finished;
  $('approve-button').hidden = finished;
  $('abort-button').hidden = finished;
  $('archive-job-button').disabled = !finished || state.pending.has(pendingId('archive', state.key ?? ''));
  const input = $('say-input');
  const sayReason = availability('say', job);
  // The draft stays editable while a message is out; only sending waits.
  input.disabled = job === null || !SAY_STATES.includes(job.state);
  $('say-button').disabled = sayReason !== '' || input.value.trim() === '';
  $('say-reason').textContent = sayReason === '' ? '' : `${ACTION_LABELS.say}: ${sayReason}`;
}

function renderOutcome(outcome) {
  const node = $('action-status');
  if (outcome === null) {
    node.className = 'status';
    node.replaceChildren();
    return;
  }
  node.className = `status ${outcome.level}`;
  // The link too is inert text, to copy; nothing on this page is clickable data.
  node.replaceChildren(document.createTextNode(typeof outcome.link === 'string' ? `${outcome.text} ${outcome.link}` : outcome.text));
}

function setOutcome(key, outcome) {
  state.outcomes.set(key, outcome);
  if (key === state.key) {
    renderOutcome(outcome);
  }
}

// The outcome of a completed call, as the factory reported it: HTTP 200 is not success.
function describeOutcome(action, result) {
  const data = result !== null && typeof result === 'object' ? result : {};
  const detail = data.error ? `${data.error.code}: ${data.error.message}` : '';
  if (action === 'archive') {
    return { level: 'ok', text: `Archived: the job left the list (its history is in ${data.archived ?? 'the state directory'}); the branch ${data.branch ?? ''} is untouched.` };
  }
  if (action === 'approve') {
    if (data.state === 'pushed') {
      const text = `Pushed ${data.branch}.${data.title ? ` ${data.title}` : ''}`;
      return typeof data.link === 'string'
        ? { level: 'ok', text: `${text} Merge request:`, link: data.link }
        : { level: 'ok', text: `${text} No merge request link: the origin URL could not be parsed. Open the merge request for branch ${data.branch} by hand.` };
    }
    if (data.state === 'needs_human') {
      return { level: 'error', text: `Not pushed: the push failed (${detail || 'no details'}). Fix it, then approve again.` };
    }
    return { level: 'warn', text: `Not pushed: the job is ${data.state}${detail ? ` (${detail})` : ''}.` };
  }
  if (action === 'review') {
    return { level: 'ok', text: `The review of iteration ${data.iteration} runs again (state ${data.state}).` };
  }
  if (action === 'abort') {
    if (data.error) {
      return { level: 'error', text: `The job ended (${data.state}), but discard failed: ${detail} The discard may be partial: look at the branch ${data.branch} and the worktree by hand before relying on either.` };
    }
    return data.discarded === true
      ? { level: 'ok', text: `Aborted; the branch ${data.branch}, its worktree and its changes were removed.` }
      : { level: 'ok', text: `Aborted; the branch ${data.branch} stays${typeof data.worktree === 'string' ? ` with its worktree ${data.worktree}` : ''}.` };
  }
  return data.queued === true
    ? { level: 'ok', text: `Queued: the message runs after the current turn ends (state ${data.state}); it has not run yet.` }
    : { level: 'ok', text: `Sent: the Implementer is working on it (state ${data.state}).` };
}

// One request for one job; the result goes to that job only, whatever is selected by then.
async function run(action, key, body) {
  const id = pendingId(action, key);
  if (state.pending.has(id)) {
    return;
  }
  state.pending.add(id);
  if (!state.unresolved.has(key)) {
    clearDoubt(key);
  }
  const waiting = { level: 'pending', text: PENDING_TEXT[action] };
  setOutcome(key, waiting);
  renderActions();
  let outcome;
  let unknownReason;
  try {
    const result = await post(`api/jobs/${jobPath(key)}/${action}`, body);
    outcome = describeOutcome(action, result);
    // The sent draft goes; text edited meanwhile stays.
    if (action === 'say' && state.drafts.get(key) === body.message) {
      state.drafts.delete(key);
      if (key === state.key) {
        $('say-input').value = '';
      }
    }
  } catch (error) {
    if (error instanceof ActionError) {
      outcome = { level: 'error', text: `${error.code}: ${error.message}` };
    } else {
      unknownReason = error.message;
    }
  }
  state.pending.delete(id);
  if (unknownReason !== undefined) {
    if (state.outcomes.get(key) === waiting) {
      setOutcome(key, null);
    }
    markUnknown(key, unknownReason);
    return;
  }
  setOutcome(key, outcome);
  renderActions();
  void refreshDetail(key);
}

async function readDetail(key) {
  return JSON.parse(await getText(`api/jobs/${jobPath(key)}`));
}

// A read that never answers must not hold the controls without a way out.
function withinTime(read) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer in time')), READ_TIMEOUT_MS);
    read.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function refreshDetail(key) {
  let detail;
  try {
    detail = await readDetail(key);
  } catch {
    return;
  }
  if (key === state.key) {
    renderDetail(detail);
  }
}

// The warning of an unknown outcome has its own line: a definite answer never replaces it, and it
// never replaces one. It outlives the hold, until the next action for the job starts.
function showDoubt(key, text) {
  state.doubts.set(key, text);
  if (key === state.key) {
    $('action-doubt').textContent = text;
  }
}

function clearDoubt(key) {
  state.doubts.delete(key);
  if (key === state.key) {
    $('action-doubt').textContent = '';
  }
}

// The action may have run: the job's controls wait for a state read after this moment. The
// entry's identity is that moment; nothing is ever re-sent.
function markUnknown(key, reason) {
  state.unresolved.set(key, { reason, refreshing: false, failed: false });
  void settleUnknown(key);
}

// Reads the job's current state for its unknown outcome: the only thing that lifts the hold. A
// read that an even later unknown outcome overtook decides nothing; that one has its own.
async function settleUnknown(key) {
  const entry = state.unresolved.get(key);
  if (entry === undefined || entry.refreshing) {
    return;
  }
  const lead = `The request failed (${entry.reason}). Its outcome is unknown`;
  entry.refreshing = true;
  entry.failed = false;
  showDoubt(key, `${lead}: the state below is being refreshed; check it before choosing a next action.`);
  renderActions();
  let detail;
  let failure;
  try {
    detail = await withinTime(readDetail(key));
  } catch (error) {
    failure = error;
  }
  entry.refreshing = false;
  if (state.unresolved.get(key) !== entry) {
    return;
  }
  if (failure !== undefined) {
    entry.failed = true;
    showDoubt(key, `${lead} and the current state could not be loaded (${failure.message}). The controls stay off until it is: use Refresh state, or wait for the page to reconnect. If sf serve restarted, open the new dashboard URL.`);
    renderActions();
    return;
  }
  state.unresolved.delete(key);
  showDoubt(key, `${lead}: it may have taken effect. The state below is current; check it and the event stream before choosing a next action.`);
  if (key === state.key) {
    renderDetail(detail);
  } else {
    renderActions();
  }
}

function openConfirm(action) {
  const job = state.detail?.job ?? null;
  if (job === null || availability(action, job) !== '' || state.confirm !== null) {
    return;
  }
  const key = keyOf(job);
  state.confirm = { action, key };
  $('confirm-title').textContent = `${ACTION_LABELS[action]} ${key}?`;
  $('confirm-text').textContent = action === 'approve'
    ? `Pushes branch ${job.branch} to origin: the one commit the factory prepared at Clean, rebased onto ${job.base}. Nothing is committed or rebased now; a tip edited by hand is refused unless pushed as it is.`
    : `Ends the job on branch ${job.branch}: the Implementer session stops and queued messages are dropped. The branch and its worktree stay as they are.`;
  $('discard').checked = false;
  $('as-is').checked = false;
  $('discard-label').hidden = action !== 'abort';
  $('as-is-label').hidden = action !== 'approve';
  $('confirm').hidden = false;
  renderConfirmButton();
  renderActions();
  $('confirm-cancel').focus();
}

function renderConfirmButton() {
  const confirm = state.confirm;
  if (confirm === null) {
    return;
  }
  const discard = confirm.action === 'abort' && $('discard').checked;
  const ok = $('confirm-ok');
  ok.textContent = confirm.action === 'approve' ? ($('as-is').checked ? 'Approve: push as it is' : 'Approve: push the branch') : discard ? 'Abort and discard the branch' : 'Abort, keep the worktree';
  ok.className = discard ? 'btn btn-danger' : 'btn btn-primary';
}

function closeConfirm() {
  state.confirm = null;
  $('confirm').hidden = true;
  $('discard').checked = false;
  $('as-is').checked = false;
  renderActions();
}

function submitConfirm() {
  const confirm = state.confirm;
  if (confirm === null) {
    return;
  }
  const discard = confirm.action === 'abort' && $('discard').checked;
  const asIs = confirm.action === 'approve' && $('as-is').checked;
  closeConfirm();
  // The target was captured when the confirmation opened; a selection changed since drops it.
  if (confirm.key !== state.key) {
    return;
  }
  void run(confirm.action, confirm.key, confirm.action === 'abort' ? { discard } : asIs ? { as_is: true } : {});
}

function sendSay() {
  const key = state.key;
  const message = $('say-input').value;
  if (key === null || message.trim() === '' || availability('say', state.detail?.job ?? null) !== '') {
    return;
  }
  void run('say', key, { message });
}

// The start screen.
function renderSetup() {
  const workspaces = state.workspaces ?? [];
  const tickets = state.tickets ?? [];
  const parts = [`${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`, `${tickets.length} ticket${tickets.length === 1 ? '' : 's'} without a job`];
  $('setup-summary').textContent = parts.join(' · ');
  // Open until there is a workspace and a job; decided once, from the first data, so the User's
  // own toggling is kept afterwards.
  if (!state.setupDecided && state.workspaces !== null) {
    state.setupDecided = true;
    $('setup').open = workspaces.length === 0 || state.jobs.length === 0;
  }
  renderWorkspaces();
  renderTickets();
}

function renderWorkspaces() {
  const rows = state.workspaces ?? [];
  $('no-workspaces').hidden = state.workspaces === null || rows.length > 0;
  $('workspace-list').replaceChildren(...rows.map((row) => {
    const item = el('li');
    item.append(el('div', 'ws-name', row.name));
    item.append(el('div', 'ws-path', row.path));
    if (row.problem) {
      item.append(el('div', 'ws-problem', row.problem));
    }
    const line = el('div', 'row');
    const remove = el('button', 'btn btn-sm', 'Remove');
    remove.type = 'button';
    remove.disabled = state.setupPending.has('workspace') || row.liveJobs > 0;
    remove.addEventListener('click', () => void removeWorkspace(row.name));
    line.append(remove, el('span', 'hint', row.liveJobs > 0 ? `${row.liveJobs} live job${row.liveJobs === 1 ? '' : 's'}: finish or abort them first.` : 'The registration only; nothing on disk changes.'));
    item.append(line);
    return item;
  }));
  // The workspace choice of the form keeps its value while the options are replaced.
  const select = $('ticket-workspace');
  const chosen = select.value;
  select.replaceChildren(...rows.map((row) => {
    const option = el('option', '', row.name);
    option.value = row.name;
    return option;
  }));
  select.value = rows.some((row) => row.name === chosen) ? chosen : (rows[0]?.name ?? '');
  select.disabled = rows.length === 0;
  $('ticket-create').disabled = rows.length === 0 || state.setupPending.has('ticket');
}

// What the ticket waits for, in one line: the conversation, the User's start, or a new start.
function ticketNext(row) {
  if (row.draft) {
    return 'Next: open the conversation. ChatGPT investigates, discusses it with you and writes the Task file; then start the job here.';
  }
  if (row.job !== null) {
    return `The last job ended ${row.job}. To run it again, Start it here; or archive the ticket.`;
  }
  return 'The Task file is written. Read it, then Start: the factory runs the job and its reviewers.';
}

function renderArchived() {
  const rows = state.archived ?? [];
  $('archived').hidden = rows.length === 0;
  $('archived-count').textContent = `(${rows.length})`;
  $('archived-list').replaceChildren(...rows.map((row) => {
    const key = `${row.workspace}/${row.ticket}`;
    const item = el('li');
    item.append(el('div', 'ticket-name', `${key} · ${row.title}`));
    const buttons = el('div', 'row');
    const busy = state.setupPending.has(`ticket:${key}`) || state.ticketConfirm !== null;
    const restore = el('button', 'btn btn-sm', 'Restore');
    restore.type = 'button';
    restore.disabled = busy;
    restore.addEventListener('click', () => void ticketAction('restore', row));
    const remove = el('button', 'btn btn-sm btn-ghost-danger', 'Delete…');
    remove.type = 'button';
    remove.disabled = busy;
    remove.addEventListener('click', () => openDeleteConfirm({ ...row, archivedRow: true }));
    buttons.append(restore, remove);
    item.append(buttons);
    return item;
  }));
}

function renderTickets() {
  renderArchived();
  const rows = state.tickets ?? [];
  $('no-tickets').hidden = state.tickets === null || rows.length > 0;
  $('ticket-list').replaceChildren(...rows.map((row) => {
    const key = `${row.workspace}/${row.ticket}`;
    const item = el('li');
    const name = el('div', 'ticket-name', `${key} · ${row.title}`);
    if (row.draft) {
      name.append(el('span', 'badge t-draft', 'waiting for the plan'));
    }
    if (row.job !== null) {
      name.append(el('span', 'badge t-job', `last job ${row.job}`));
    }
    item.append(name);
    item.append(el('div', 'ticket-line', `.software-factory/${row.ticket}.md · base ${row.base}`));
    item.append(el('p', 'ticket-next', ticketNext(row)));
    const buttons = el('div', 'row');
    const busy = state.setupPending.has(`ticket:${key}`) || state.ticketConfirm !== null;
    // The User's start (SF-040): only once the planner wrote the Task file over the skeleton.
    if (!row.draft) {
      const start = el('button', 'btn btn-sm btn-primary', 'Start');
      start.type = 'button';
      start.disabled = busy;
      start.title = 'Start the job: a branch in a worktree of its own and the first iteration';
      start.addEventListener('click', () => void ticketAction('start', row));
      buttons.append(start);
    }
    const url = typeof row.conversation?.url === 'string' && row.conversation.url.startsWith(CHATGPT_PREFILL_URL) ? row.conversation.url : null;
    if (url !== null) {
      const link = el('a', `btn btn-sm${row.draft ? ' btn-primary' : ''}`, 'Open the conversation');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      buttons.append(link);
    }
    const archive = el('button', 'btn btn-sm', 'Archive');
    archive.type = 'button';
    archive.disabled = busy;
    archive.title = 'Move the Task file to .software-factory/archive/; a finished job of the ticket leaves the Jobs list';
    archive.addEventListener('click', () => void ticketAction('archive', row));
    const remove = el('button', 'btn btn-sm btn-ghost-danger', 'Delete…');
    remove.type = 'button';
    remove.disabled = busy;
    remove.addEventListener('click', () => openDeleteConfirm(row));
    buttons.append(archive, remove);
    item.append(buttons);
    if (url !== null) {
      item.append(el('p', 'hint', 'The link opens ChatGPT in a new tab with the message in the composer; press Enter if it is not sent by itself. The same link, to copy:'));
      const box = el('div', 'copy-box');
      const input = el('input');
      input.type = 'text';
      input.value = url;
      input.setAttribute('readonly', '');
      input.setAttribute('aria-label', `Conversation link of ${key}`);
      const copy = el('button', 'btn btn-sm', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', () => copyText(input, 'conversation-copy-status'));
      box.append(input, copy);
      item.append(box);
    } else if (typeof row.conversation?.message === 'string') {
      // Too long for a link: the first message to paste into a new ChatGPT conversation.
      item.append(el('p', 'hint', 'The first message is too long for a link: copy it and paste it into a new ChatGPT conversation of this project.'));
      const box = el('div', 'copy-box');
      const area = el('textarea');
      area.rows = 4;
      area.value = row.conversation.message;
      area.setAttribute('readonly', '');
      area.setAttribute('aria-label', `First message of ${key}`);
      const copy = el('button', 'btn btn-sm', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', () => copyText(area, 'conversation-copy-status'));
      box.append(area, copy);
      item.append(box);
    }
    return item;
  }));
}

// Copies a field's text; without the clipboard the text is selected for Ctrl+C.
function copyText(box, statusId) {
  const done = (text) => {
    $(statusId).textContent = text;
  };
  const select = () => {
    box.focus();
    box.select();
    done('Selected: press Ctrl+C to copy.');
  };
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
    select();
    return;
  }
  navigator.clipboard.writeText(box.value).then(() => done('Copied.'), select);
}

function setSetupStatus(id, outcome) {
  const node = $(id);
  node.className = outcome === null ? 'status' : `status ${outcome.level}`;
  node.textContent = outcome === null ? '' : outcome.text;
}

// One request for one form; the page sends nothing twice.
async function setupRequest(what, path, body, statusId, describe) {
  if (state.setupPending.has(what)) {
    return undefined;
  }
  state.setupPending.add(what);
  setSetupStatus(statusId, { level: 'pending', text: 'Sending…' });
  renderSetup();
  let result;
  let outcome;
  try {
    result = await post(path, body);
    outcome = describe(result);
  } catch (error) {
    outcome = error instanceof ActionError
      ? { level: 'error', text: `${error.code}: ${error.message}` }
      : { level: 'error', text: `The request failed (${error.message}); it may have taken effect. The lists below refresh on the next change; reload the page to see the current state.` };
  }
  state.setupPending.delete(what);
  setSetupStatus(statusId, outcome);
  renderSetup();
  return outcome.level === 'ok' ? result : undefined;
}

async function submitWorkspace() {
  const name = $('workspace-name').value.trim();
  const path = $('workspace-path').value.trim();
  if (name === '' || path === '') {
    setSetupStatus('workspace-status', { level: 'error', text: 'A name and the path of the local checkout are needed.' });
    return;
  }
  const result = await setupRequest('workspace', 'api/workspaces', { name, path }, 'workspace-status', (data) =>
    ({ level: 'ok', text: `Registered ${data.name} (${data.path}). Next: New ticket.` }));
  if (result !== undefined) {
    $('workspace-name').value = '';
    $('workspace-path').value = '';
  }
}

async function removeWorkspace(name) {
  await setupRequest('workspace', `api/workspaces/${encodeURIComponent(name)}/remove`, {}, 'workspace-status', (data) =>
    ({ level: 'ok', text: `Removed ${data.removed} from the registry; the checkout and its files are untouched.` }));
}

async function submitTicket() {
  const workspace = $('ticket-workspace').value;
  const ticket = $('ticket-key').value.trim();
  const title = $('ticket-title').value.trim();
  const request = $('ticket-request').value;
  if (workspace === '' || ticket === '' || title === '' || request.trim() === '') {
    setSetupStatus('ticket-status', { level: 'error', text: 'The workspace, the ticket key, the title and the request are all needed.' });
    return;
  }
  const result = await setupRequest('ticket', 'api/tickets', { workspace, ticket, title, request }, 'ticket-status', (data) =>
    ({ level: 'ok', text: `Ticket created: ${data.path} in ${data.workspace} (base ${data.base}), an empty skeleton. Next, under Tickets: Open the conversation; your words are its first message.` }));
  if (result !== undefined) {
    $('ticket-key').value = '';
    $('ticket-title').value = '';
    $('ticket-request').value = '';
  }
}

// Start, archive, restore or delete one ticket; one request per ticket at a time, the outcome in
// the start status line.
async function ticketAction(action, row) {
  const key = `${row.workspace}/${row.ticket}`;
  const id = `ticket:${key}`;
  if (state.setupPending.has(id)) {
    return;
  }
  const texts = {
    start: (data) => `Started ${key}: branch ${data.branch}, ${data.state}. It is in the Jobs list.`,
    archive: (data) => `Archived ${key}: ${data.path}.${data.jobArchived ? ' Its finished job left the Jobs list.' : ''}`,
    restore: (data) => `Restored ${key}: ${data.path}.`,
    delete: (data) => `Deleted ${key}: ${Array.isArray(data.deleted) ? data.deleted.join(', ') : ''}.${data.jobArchived ? ' Its finished job left the Jobs list.' : ''}`,
  };
  await setupRequest(id, `api/tickets/${jobPath(key)}/${action}`, {}, 'ticket-action-status', (data) => ({ level: 'ok', text: texts[action](data ?? {}) }));
}

// Delete asks first: it cannot be undone.
function openDeleteConfirm(row) {
  const key = `${row.workspace}/${row.ticket}`;
  if (state.ticketConfirm !== null) {
    return;
  }
  state.ticketConfirm = { key, row };
  $('ticket-confirm-title').textContent = `Delete ${key}?`;
  $('ticket-confirm-text').textContent = `Deletes .software-factory/${row.ticket}.md and its MR text${row.archivedRow ? ' from the archive' : ''}. Cannot be undone; Archive keeps the file instead. A finished job of the ticket leaves the Jobs list (its history stays in the state directory).`;
  $('ticket-ok').textContent = 'Delete the ticket';
  $('ticket-ok').className = 'btn btn-danger';
  $('ticket-confirm').hidden = false;
  renderTickets();
  $('ticket-cancel').focus();
}

function closeTicketConfirm() {
  state.ticketConfirm = null;
  $('ticket-confirm').hidden = true;
  renderTickets();
}

async function submitTicketConfirm() {
  const confirm = state.ticketConfirm;
  if (confirm === null) {
    return;
  }
  closeTicketConfirm();
  await ticketAction('delete', confirm.row);
}

function appendEvent(event) {
  const events = $('events');
  const block = el('div', `event t-${event.type}`, event.text);
  events.append(block);
  if ($('follow').checked) {
    events.scrollTop = events.scrollHeight;
  }
}

function closeStream() {
  clearTimeout(state.retry);
  state.retry = null;
  if (state.source !== null) {
    state.source.close();
    state.source = null;
  }
}

function openStream() {
  closeStream();
  const params = new URLSearchParams();
  if (state.key !== null) {
    params.set('job', state.key);
    params.set('from', String(state.lastLine + 1));
  }
  const key = state.key;
  const source = new EventSource(`api/stream?${params}`);
  state.source = source;
  source.addEventListener('open', () => setConnection('live', 'live'));
  source.addEventListener('jobs', (message) => {
    state.jobs = JSON.parse(message.data).jobs;
    renderJobs();
    if (state.key !== null && !state.jobs.some((job) => keyOf(job) === state.key)) {
      // The selected job left the list (its ticket was archived or deleted).
      if (state.jobs.length > 0) {
        select(keyOf(mostRecent()));
      } else {
        state.key = null;
        state.detail = null;
        $('detail').hidden = true;
        history.replaceState(null, '', '#');
        openStream();
      }
      return;
    }
    if (state.key === null && state.jobs.length > 0) {
      select(keyOf(mostRecent()));
    }
  });
  source.addEventListener('workspaces', (message) => {
    state.workspaces = JSON.parse(message.data).workspaces;
    renderSetup();
  });
  source.addEventListener('tickets', (message) => {
    const data = JSON.parse(message.data);
    state.tickets = data.tickets;
    state.archived = Array.isArray(data.archived) ? data.archived : [];
    renderSetup();
  });
  source.addEventListener('job', (message) => {
    if (key === state.key) {
      renderDetail(JSON.parse(message.data));
      // The stream is back: try the read that failed, on its own or after a reconnect.
      if (state.unresolved.get(key)?.failed === true) {
        void settleUnknown(key);
      }
    }
  });
  source.addEventListener('event', (message) => {
    const event = JSON.parse(message.data);
    if (key === state.key && event.line > state.lastLine) {
      state.lastLine = event.line;
      appendEvent(event);
    }
  });
  source.addEventListener('error', () => {
    // Reconnect ourselves after 3 s, resuming after the last line seen.
    source.close();
    if (state.source === source) {
      state.source = null;
      setConnection('reconnecting', 'down');
      state.retry = setTimeout(openStream, RECONNECT_MS);
    }
  });
}

function select(key) {
  if (key === state.key && state.source !== null) {
    return;
  }
  state.key = key;
  state.detail = null;
  state.iteration = null;
  state.cache = new Map();
  state.expanded = new Set();
  state.lastLine = -1;
  $('events').replaceChildren();
  $('iteration-body').replaceChildren();
  $('mr-panel').hidden = true;
  $('follow').checked = true;
  // The controls go off until this job's detail arrives; its draft and last outcome come back.
  closeConfirm();
  $('say-input').value = state.drafts.get(key) ?? '';
  renderOutcome(state.outcomes.get(key) ?? null);
  $('action-doubt').textContent = state.doubts.get(key) ?? '';
  renderActions();
  history.replaceState(null, '', `#${key}`);
  renderJobs();
  openStream();
}

function renderJobTabs() {
  for (const button of $('job-tabs').querySelectorAll('button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === state.tab));
  }
  for (const [name] of JOB_TABS) {
    $(`tab-${name}`).hidden = name !== state.tab;
  }
}

function selectTab(name) {
  state.tab = name;
  renderJobTabs();
  if (name === 'events' && $('follow').checked) {
    const events = $('events');
    events.scrollTop = events.scrollHeight;
  }
}

function init() {
  $('job-tabs').replaceChildren(...JOB_TABS.map(([name, label]) => {
    const button = el('button', '', label);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.dataset.tab = name;
    button.addEventListener('click', () => selectTab(name));
    return button;
  }));
  renderJobTabs();
  for (const button of $('iteration-views').querySelectorAll('button')) {
    button.addEventListener('click', () => {
      state.view = button.dataset.view;
      renderIterationTabs(state.detail?.iterations ?? []);
      void showIteration();
    });
  }
  const events = $('events');
  events.addEventListener('scroll', () => {
    // Scrolling up switches follow off; the checkbox turns it on again.
    if (events.scrollTop + events.clientHeight < events.scrollHeight - 8) {
      $('follow').checked = false;
    }
  });
  $('follow').addEventListener('change', () => {
    if ($('follow').checked) {
      events.scrollTop = events.scrollHeight;
    }
  });
  window.addEventListener('hashchange', () => {
    const key = decodeURIComponent(location.hash.slice(1));
    if (key !== '' && key !== state.key && state.jobs.some((job) => keyOf(job) === key)) {
      select(key);
    }
  });

  $('approve-button').addEventListener('click', () => openConfirm('approve'));
  $('archive-job-button').addEventListener('click', () => {
    if (state.key !== null) {
      void run('archive', state.key, {});
    }
  });
  $('abort-button').addEventListener('click', () => openConfirm('abort'));
  $('retry-review-button').addEventListener('click', () => {
    if (state.key !== null) {
      void run('review', state.key, {});
    }
  });
  $('confirm-ok').addEventListener('click', submitConfirm);
  $('confirm-cancel').addEventListener('click', closeConfirm);
  $('confirm').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeConfirm();
    }
  });
  $('discard').addEventListener('change', renderConfirmButton);
  $('as-is').addEventListener('change', renderConfirmButton);
  $('files-expand').addEventListener('click', () => setAllExpanded(true));
  $('files-collapse').addEventListener('click', () => setAllExpanded(false));
  $('refresh-button').addEventListener('click', () => void settleUnknown(state.key));
  $('say-input').addEventListener('input', () => {
    if (state.key !== null) {
      state.drafts.set(state.key, $('say-input').value);
    }
    renderActions();
  });
  // Enter in the textarea adds a line; only the Send button submits the form.
  $('say-form').addEventListener('submit', (event) => {
    event.preventDefault();
    sendSay();
  });

  $('workspace-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void submitWorkspace();
  });
  $('ticket-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void submitTicket();
  });
  $('ticket-ok').addEventListener('click', () => void submitTicketConfirm());
  $('ticket-cancel').addEventListener('click', closeTicketConfirm);
  $('ticket-confirm').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeTicketConfirm();
    }
  });

  renderSetup();
  load();
}

function load() {
  getText('api/jobs').then((text) => {
    state.jobs = JSON.parse(text).jobs;
    renderJobs();
    const wanted = decodeURIComponent(location.hash.slice(1));
    const job = state.jobs.find((candidate) => keyOf(candidate) === wanted) ?? mostRecent();
    if (job !== undefined) {
      select(keyOf(job));
    } else {
      openStream();
    }
  }, () => {
    setConnection('reconnecting', 'down');
    state.retry = setTimeout(load, RECONNECT_MS);
  });
}

document.addEventListener('DOMContentLoaded', init);
