// Software Factory dashboard: the board (SF-046). Five columns from the stream's jobs and
// tickets: Planned (the Task files without a live job), Implementing, Reviewing, Your turn and
// Done, each card with the pipeline bar, who acts now and since when, and on Your turn the one
// action that unblocks it. A job card opens the job in a drawer: the job card and tabs of
// version 2, whose approve, abort, say and Retry review go as POSTs to
// api/jobs/<ws>/<ticket>/<action>, each one a deliberate click, confirmed for approve and abort,
// never retried or replayed by the page. A Planned card starts its job (POST
// api/tickets/<ws>/<ticket>/start, confirmed, never retried) and opens its Task text in the same
// drawer, as do Workspaces, New ticket and Archived. Every value goes in through textContent; the
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
  key: null, // "<ws>/<ticket>" of the job open in the drawer
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
  // The registry, the tickets without a live job and the archived ones (null until the stream
  // sends them), the requests out for the setup forms and the ticket actions, and the open
  // confirmation of a ticket's start or delete.
  workspaces: null,
  tickets: null,
  archived: [],
  setupPending: new Set(),
  ticketConfirm: null,
  // The board: the workspace filter ('' for every workspace), whether Done shows every job, what
  // the drawer shows (null, 'job', 'task', 'workspaces', 'ticket' or 'archived'), the Task shown
  // in it, the confirmation a card asked the job drawer to open, and the tickets whose start has
  // an unknown outcome (Start stays off for them until the board is read again).
  filter: '',
  doneAll: false,
  drawer: null,
  task: null,
  wantConfirm: null,
  startHolds: new Map(),
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
  // Approve… on a Your turn card opens its confirmation once the job is shown.
  openWantedConfirm();
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
    if (canApprove(job)) {
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
  renderBoard();
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
  renderBoard();
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
  renderBoard();
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
    renderBoard();
    return;
  }
  state.unresolved.delete(key);
  showDoubt(key, `${lead}: it may have taken effect. The state below is current; check it and the event stream before choosing a next action.`);
  if (key === state.key) {
    renderDetail(detail);
  } else {
    renderActions();
  }
  renderBoard();
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


// ---------- The board ----------

// The column of each job state; the tickets without a live job are Planned.
const COLUMN_OF = {
  starting: 'implementing', working: 'implementing',
  awaiting_review: 'reviewing', preparing_mr: 'reviewing',
  needs_human: 'you', ready_for_human_review: 'you',
  pushed: 'done', aborted: 'done', failed: 'done',
};
const COLUMNS = ['planned', 'implementing', 'reviewing', 'you', 'done'];
const EMPTY_TEXT = { planned: 'No ticket waits to start.', implementing: 'Nothing is being implemented.', reviewing: 'Nothing is in review.', you: 'Nothing waits for you.', done: 'No finished job.' };
// Done shows the most recent jobs; "Show all" shows the rest.
const DONE_LIMIT = 10;
const SEGMENTS = ['Implement', 'Claude review', 'Codex gate', 'MR', 'You'];
const DONE_LABELS = { pushed: 'Pushed', aborted: 'Aborted', failed: 'Failed' };

// The job can be pushed: the branch prepared at Clean is ready, or its push failed and approve
// tries again.
const canApprove = (job) => job.state === 'ready_for_human_review' || (job.state === 'needs_human' && typeof job.prepared_commit === 'string' && job.worktree === null);

// Where a halted job stopped, from its error: the review, the gate, the push, the MR
// preparation, else the implementation.
function haltedSegment(job) {
  const code = typeof job.error?.code === 'string' ? job.error.code : '';
  if (code === 'review_failed') {
    return 1;
  }
  if (code.startsWith('gate_')) {
    return 2;
  }
  if (canApprove(job)) {
    return 4;
  }
  return code.startsWith('mr_') ? 3 : 0;
}

// The pipeline position of a job: the current segment (null when there is none), whether it is
// halted there, and whether the whole pipeline is done (pushed). awaiting_review is the Claude
// review until the last iteration has a clean one, then the Codex gate.
function pipeline(job) {
  switch (job.state) {
    case 'starting':
    case 'working':
      return { segment: 0, halted: false, complete: false };
    case 'awaiting_review':
      return { segment: job.review === 'clean' ? 2 : 1, halted: false, complete: false };
    case 'preparing_mr':
      return { segment: 3, halted: false, complete: false };
    case 'ready_for_human_review':
      return { segment: 4, halted: false, complete: false };
    case 'needs_human':
    case 'failed':
      return { segment: haltedSegment(job), halted: true, complete: false };
    case 'pushed':
      return { segment: null, halted: false, complete: true };
    default:
      return { segment: null, halted: false, complete: false };
  }
}

function segmentStatus(flow, index) {
  if (flow.complete) {
    return 'done';
  }
  if (flow.segment === null || index > flow.segment) {
    return 'todo';
  }
  if (index < flow.segment) {
    return 'done';
  }
  return flow.halted ? 'halted' : 'current';
}

// Five segments, the current one marked and a halted one red; the words in the label.
function pipelineBar(job) {
  const flow = pipeline(job);
  const bar = el('span', 'pipe');
  const where = flow.segment === null ? (flow.complete ? 'complete' : 'stopped') : `${SEGMENTS[flow.segment]}${flow.halted ? ', halted' : ''}`;
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `Pipeline: ${where}`);
  bar.append(...SEGMENTS.map((name, index) => {
    const status = segmentStatus(flow, index);
    const segment = el('i', `seg ${status}`);
    segment.dataset.status = status;
    segment.setAttribute('title', `${name}: ${status}`);
    return segment;
  }));
  return bar;
}

// How long ago ts was, in words: "< 1 min", "4 min", "2 h 5 min", "3 d".
function since(ts) {
  const ms = Date.now() - Date.parse(ts);
  if (!Number.isFinite(ms)) {
    return '';
  }
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) {
    return '< 1 min';
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d`;
}

// Who acts now and since when: "Codex gate · 4 min", "You · approve · 2 min", "Pushed · 1 h ago".
function nowLine(job) {
  const waited = since(job.updated_at);
  switch (job.state) {
    case 'starting':
    case 'working':
      return `Implementer · ${waited}`;
    case 'awaiting_review':
      return job.review === 'clean' ? `Codex gate · ${since(job.review_ended_at ?? job.updated_at)}` : `Claude review · ${waited}`;
    case 'preparing_mr':
      return `MR preparation · ${waited}`;
    case 'ready_for_human_review':
      return `You · approve · ${waited}`;
    case 'needs_human': {
      const what = canApprove(job) ? 'approve' : reviewFailed(job) ? 'retry review' : (job.error?.code ?? 'decide');
      return `You · ${what} · ${waited}`;
    }
    default:
      return `${DONE_LABELS[job.state] ?? job.state} · ${waited} ago`;
  }
}

function chip(text, className = '') {
  return el('span', `chip ${className}`.trim(), text);
}

// Iteration count, file count and estimated cost.
function jobChips(job) {
  const chips = el('span', 'chips');
  chips.append(chip(`iteration ${job.iteration}`));
  if (typeof job.files === 'number' && job.files > 0) {
    chips.append(chip(`${job.files} file${job.files === 1 ? '' : 's'}`));
  }
  if (typeof job.undeclared === 'number' && job.undeclared > 0) {
    chips.append(chip(`${job.undeclared} sensitive`, 'chip-bad'));
  }
  if (typeof job.cost_usd === 'number') {
    const cost = chip(`est. $${job.cost_usd.toFixed(2)}`);
    cost.setAttribute('title', 'An estimate of the API-equivalent price, not a charge');
    chips.append(cost);
  }
  return chips;
}

function cardHead(ticket, workspace, title) {
  const head = el('span', 'card-key');
  head.append(el('span', 'mono', ticket), el('span', 'card-ws', workspace));
  return [head, el('span', 'card-title', title)];
}

const jobByKey = (key) => state.jobs.find((job) => keyOf(job) === key) ?? null;
const titleOf = (job) => (typeof job.title === 'string' && job.title !== '' ? job.title : job.branch);

// A job card: a button that opens the job, and on Your turn the action that unblocks it with
// that job's last outcome.
function jobCard(job) {
  const key = keyOf(job);
  const item = el('li', 'board-card');
  item.dataset.key = key;
  const open = el('button', 'card-open');
  open.type = 'button';
  open.dataset.key = key;
  open.setAttribute('aria-current', String(state.drawer === 'job' && state.key === key));
  open.append(...cardHead(job.ticket, job.workspace, titleOf(job)));
  const now = el('span', 'card-now');
  now.append(pipelineBar(job), el('span', 'card-who', nowLine(job)));
  open.append(now);
  if ((job.state === 'needs_human' || job.state === 'failed') && job.error !== null && typeof job.error === 'object') {
    open.append(el('span', 'card-error', `${job.error.code}: ${job.error.message}`));
  }
  open.append(jobChips(job));
  open.addEventListener('click', () => openJob(key));
  item.append(open);
  if (COLUMN_OF[job.state] === 'you') {
    item.append(...yourTurn(job));
  }
  return item;
}

function yourTurn(job) {
  const key = keyOf(job);
  const foot = el('div', 'card-foot');
  let button;
  if (canApprove(job)) {
    button = el('button', 'btn btn-sm btn-primary', 'Approve…');
    button.disabled = availability('approve', job) !== '';
    button.addEventListener('click', () => openJob(key, 'approve'));
  } else if (reviewFailed(job)) {
    button = el('button', 'btn btn-sm btn-primary', ACTION_LABELS.review);
    button.disabled = availability('review', job) !== '';
    button.addEventListener('click', () => {
      const current = jobByKey(key);
      if (current !== null && reviewFailed(current) && availability('review', current) === '') {
        void run('review', key, {});
      }
    });
  } else {
    button = el('button', 'btn btn-sm', 'Open the job');
    button.addEventListener('click', () => openJob(key));
  }
  button.type = 'button';
  foot.append(button);
  const parts = [foot];
  const outcome = state.outcomes.get(key) ?? null;
  if (outcome !== null) {
    parts.push(el('p', `status ${outcome.level}`, outcome.text));
  }
  const doubt = state.doubts.get(key);
  if (doubt !== undefined && doubt !== '') {
    parts.push(el('p', 'status error', doubt));
  }
  return parts;
}

// A Planned card: the ticket, its last job, Start (or "waiting for the plan" for a skeleton),
// Task, Archive and Delete….
function ticketCard(row) {
  const key = `${row.workspace}/${row.ticket}`;
  const item = el('li', 'board-card planned');
  item.dataset.key = key;
  const body = el('div', 'card-body');
  body.append(...cardHead(row.ticket, row.workspace, row.title));
  const chips = el('span', 'chips');
  chips.append(chip(`from ${row.base}`));
  if (row.job !== null && row.job !== undefined) {
    chips.append(chip(`last job ${row.job}`, row.job === 'pushed' ? 'chip-good' : row.job === 'failed' ? 'chip-bad' : ''));
  }
  body.append(chips);
  item.append(body);
  const foot = el('div', 'card-foot');
  const busy = state.setupPending.has(`ticket:${key}`) || state.ticketConfirm !== null;
  if (row.draft) {
    foot.append(el('span', 'card-wait', 'waiting for the plan'));
  } else {
    const start = el('button', 'btn btn-sm btn-primary', 'Start');
    start.type = 'button';
    start.disabled = busy || state.startHolds.has(key);
    start.addEventListener('click', () => openTicketConfirm('start', row));
    foot.append(start);
  }
  const task = el('button', 'btn btn-sm', 'Task');
  task.type = 'button';
  task.addEventListener('click', () => void openTask(row, false));
  const archive = el('button', 'btn btn-sm', 'Archive');
  archive.type = 'button';
  archive.disabled = busy;
  archive.title = 'Move the Task file to .software-factory/archive/; a finished job of the ticket leaves the board';
  archive.addEventListener('click', () => void ticketAction('archive', row));
  const remove = el('button', 'btn btn-sm btn-ghost-danger', 'Delete…');
  remove.type = 'button';
  remove.disabled = busy;
  remove.addEventListener('click', () => openTicketConfirm('delete', row));
  foot.append(task, archive, remove);
  item.append(foot);
  return item;
}

const visible = (workspace) => state.filter === '' || workspace === state.filter;

function renderFilter() {
  const names = (state.workspaces ?? []).map((row) => row.name);
  if (state.filter !== '' && state.workspaces !== null && !names.includes(state.filter)) {
    state.filter = '';
  }
  const node = $('workspace-filter');
  node.hidden = names.length === 0;
  node.replaceChildren(...[['', 'All workspaces'], ...names.map((name) => [name, name])].map(([name, label]) => {
    const button = el('button', 'filter-button', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.filter === name));
    button.addEventListener('click', () => {
      state.filter = name;
      renderBoard();
    });
    return button;
  }));
}

function renderBoard() {
  renderFilter();
  const byUpdate = (a, b) => b.updated_at.localeCompare(a.updated_at);
  const jobs = state.jobs.filter((job) => visible(job.workspace)).sort(byUpdate);
  const lists = { planned: (state.tickets ?? []).filter((row) => visible(row.workspace)), implementing: [], reviewing: [], you: [], done: [] };
  for (const job of jobs) {
    lists[COLUMN_OF[job.state] ?? 'done'].push(job);
  }
  for (const column of COLUMNS) {
    const entries = lists[column];
    $(`count-${column}`).textContent = String(entries.length);
    const shown = column === 'done' && !state.doneAll ? entries.slice(0, DONE_LIMIT) : entries;
    const cards = shown.map(column === 'planned' ? ticketCard : jobCard);
    $(`list-${column}`).replaceChildren(...(cards.length > 0 ? cards : [el('li', 'col-empty', EMPTY_TEXT[column])]));
  }
  const more = $('done-all');
  more.hidden = lists.done.length <= DONE_LIMIT;
  more.textContent = state.doneAll ? `Show the last ${DONE_LIMIT}` : `Show all ${lists.done.length}`;
  $('archived-count').textContent = `(${state.archived.length})`;
  let hint = '';
  if (state.workspaces !== null && state.workspaces.length === 0) {
    hint = 'No workspace yet: Workspaces adds the local checkout of a repository to work in.';
  } else if (state.tickets !== null && state.tickets.length === 0 && state.jobs.length === 0) {
    hint = 'No ticket yet: New ticket writes one, and its conversation plans it.';
  }
  $('board-hint').textContent = hint;
  $('board-hint').hidden = hint === '';
}

// ---------- The drawer ----------

const PANELS = { job: 'detail', task: 'task-panel', workspaces: 'workspaces-panel', ticket: 'ticket-panel', archived: 'archived-panel' };

function showDrawer(kind, kicker, title) {
  if (state.drawer === 'job' && kind !== 'job') {
    leaveJob();
  }
  state.drawer = kind;
  if (kind !== 'task') {
    state.task = null;
  }
  for (const [name, id] of Object.entries(PANELS)) {
    $(id).hidden = name !== kind;
  }
  $('drawer-kicker').textContent = kicker;
  $('drawer-title').textContent = title;
  $('drawer').hidden = false;
  $('scrim').hidden = false;
  $('drawer-close').focus();
}

function closeDrawer() {
  if (state.drawer === null) {
    return;
  }
  if (state.drawer === 'job') {
    leaveJob();
  }
  state.drawer = null;
  state.task = null;
  $('drawer').hidden = true;
  $('scrim').hidden = true;
  renderBoard();
}

// The job drawer closes: no job is followed any more; drafts and outcomes stay with their jobs.
function leaveJob() {
  closeConfirm();
  state.key = null;
  state.detail = null;
  state.wantConfirm = null;
  $('detail').hidden = true;
  history.replaceState(null, '', '#');
  openStream();
}

// Opens a job in the drawer; confirm ('approve') opens that confirmation once its detail is shown.
function openJob(key, confirm = null) {
  const job = jobByKey(key);
  if (job === null) {
    return;
  }
  showDrawer('job', `${job.workspace} · ${job.branch}`, `${job.ticket} · ${titleOf(job)}`);
  state.wantConfirm = confirm === null ? null : { action: confirm, key };
  select(key);
  openWantedConfirm();
  renderBoard();
}

function openWantedConfirm() {
  const wanted = state.wantConfirm;
  if (wanted === null || state.detail === null || keyOf(state.detail.job) !== wanted.key) {
    return;
  }
  state.wantConfirm = null;
  openConfirm(wanted.action);
}

// The Task text in the drawer, as text: headings bold by a line rule, never HTML from the file.
async function openTask(row, archived) {
  const key = `${row.workspace}/${row.ticket}`;
  const task = { key, archived };
  showDrawer('task', `${row.workspace} · .software-factory/${archived ? 'archive/' : ''}${row.ticket}.md${typeof row.base === 'string' ? ` · base ${row.base}` : ''}`, `${row.ticket} · ${row.title}`);
  state.task = task;
  renderConversation(archived ? null : row);
  $('task-body').replaceChildren(document.createTextNode('Loading the Task file…'));
  let text;
  try {
    text = await getText(`api/tickets/${jobPath(key)}/task${archived ? '?archived=1' : ''}`);
  } catch (error) {
    text = `Could not load the Task file: ${error.message}`;
  }
  if (state.task === task) {
    $('task-body').replaceChildren(...renderReport(text));
  }
}

// The ticket's ChatGPT conversation (the Context owner plans it there): the server's link, opened
// by a click, and the same link to copy; or the first message to copy when it is too long.
function renderConversation(row) {
  const url = typeof row?.conversation?.url === 'string' && row.conversation.url.startsWith(CHATGPT_PREFILL_URL) ? row.conversation.url : null;
  const message = typeof row?.conversation?.message === 'string' ? row.conversation.message : null;
  const link = $('task-conversation-link');
  $('task-conversation').hidden = url === null && message === null;
  $('conversation-copy-status').textContent = '';
  link.hidden = url === null;
  link.href = url ?? '';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  $('task-conversation-text').value = url ?? message ?? '';
  $('task-conversation-hint').textContent = url !== null
    ? 'The conversation where the Context owner plans this ticket: the link opens ChatGPT in a new tab with the message in the composer; press Enter if it is not sent by itself. The same link, to copy:'
    : 'The first message of the ticket\'s conversation is too long for a link: copy it and paste it into a new ChatGPT conversation of this project.';
}

function openWorkspaces() {
  showDrawer('workspaces', 'Setup', 'Workspaces');
  renderWorkspaces();
}

function openNewTicket() {
  showDrawer('ticket', 'Setup', 'New ticket');
  renderWorkspaces();
}

function openArchived() {
  showDrawer('archived', 'Setup', 'Archived tickets');
  renderArchived();
}

// ---------- Setup: workspaces, new ticket, archived, ticket actions ----------

function renderSetup() {
  renderWorkspaces();
  renderArchived();
  renderBoard();
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
  // The workspace choice of the form keeps its value while the options are replaced; the
  // board's filter is the default.
  const select = $('ticket-workspace');
  const chosen = select.value !== '' ? select.value : state.filter;
  select.replaceChildren(...rows.map((row) => {
    const option = el('option', '', row.name);
    option.value = row.name;
    return option;
  }));
  select.value = rows.some((row) => row.name === chosen) ? chosen : (rows[0]?.name ?? '');
  select.disabled = rows.length === 0;
  $('ticket-create').disabled = rows.length === 0 || state.setupPending.has('ticket');
}

function renderArchived() {
  const rows = state.archived ?? [];
  $('no-archived').hidden = rows.length > 0;
  $('archived-list').replaceChildren(...rows.map((row) => {
    const key = `${row.workspace}/${row.ticket}`;
    const item = el('li');
    item.append(el('div', 'ticket-name', `${key} · ${row.title}`));
    const buttons = el('div', 'row');
    const busy = state.setupPending.has(`ticket:${key}`) || state.ticketConfirm !== null;
    const task = el('button', 'btn btn-sm', 'Task');
    task.type = 'button';
    task.addEventListener('click', () => void openTask(row, true));
    const restore = el('button', 'btn btn-sm', 'Restore');
    restore.type = 'button';
    restore.disabled = busy;
    restore.addEventListener('click', () => void ticketAction('restore', row));
    const remove = el('button', 'btn btn-sm btn-ghost-danger', 'Delete…');
    remove.type = 'button';
    remove.disabled = busy;
    remove.addEventListener('click', () => openTicketConfirm('delete', { ...row, archivedRow: true }));
    buttons.append(task, restore, remove);
    item.append(buttons);
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
  const base = id === 'ticket-action-status' ? 'status toast' : 'status';
  node.className = outcome === null ? base : `${base} ${outcome.level}`;
  node.textContent = outcome === null ? '' : outcome.text;
}

// One request for one form or ticket; the page sends nothing twice.
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
      : { level: 'error', text: `The request failed (${error.message}); it may have taken effect. The board refreshes on the next change; reload the page to see the current state.` };
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
    ({ level: 'ok', text: `Ticket created: ${data.path} in ${data.workspace} (base ${data.base}), an empty skeleton under Planned. Next: its Task button opens the conversation; your words are its first message.` }));
  if (result !== undefined) {
    $('ticket-key').value = '';
    $('ticket-title').value = '';
    $('ticket-request').value = '';
  }
}

// Archive, restore or delete one ticket; one request per ticket at a time, the outcome in the
// board's status line.
async function ticketAction(action, row) {
  const key = `${row.workspace}/${row.ticket}`;
  const id = `ticket:${key}`;
  if (state.setupPending.has(id)) {
    return;
  }
  const texts = {
    archive: (data) => `Archived ${key}: ${data.path}.${data.jobArchived ? ' Its finished job left the board.' : ''}`,
    restore: (data) => `Restored ${key}: ${data.path}.`,
    delete: (data) => `Deleted ${key}: ${Array.isArray(data.deleted) ? data.deleted.join(', ') : ''}.${data.jobArchived ? ' Its finished job left the board.' : ''}`,
  };
  await setupRequest(id, `api/tickets/${jobPath(key)}/${action}`, {}, 'ticket-action-status', (data) => ({ level: 'ok', text: texts[action](data ?? {}) }));
}

// Start and Delete ask first: Start names the workspace, the ticket and the base branch; Delete
// cannot be undone.
function openTicketConfirm(action, row) {
  const key = `${row.workspace}/${row.ticket}`;
  if (state.ticketConfirm !== null) {
    return;
  }
  state.ticketConfirm = { action, key, row };
  if (action === 'start') {
    $('ticket-confirm-title').textContent = `Start ${row.ticket} in ${row.workspace}?`;
    $('ticket-confirm-text').textContent = `Starts a job on .software-factory/${row.ticket}.md of workspace ${row.workspace}: a new branch from ${row.base} in its own worktree, where the Implementer runs iteration 1. Claude reviews it, the Codex gate checks it, and the branch comes back to you to approve.`;
    $('ticket-ok').textContent = 'Start the job';
    $('ticket-ok').className = 'btn btn-primary';
  } else {
    $('ticket-confirm-title').textContent = `Delete ${key}?`;
    $('ticket-confirm-text').textContent = `Deletes .software-factory/${row.ticket}.md and its MR text${row.archivedRow ? ' from the archive' : ''}. Cannot be undone; Archive keeps the file instead. A finished job of the ticket leaves the board (its history stays in the state directory).`;
    $('ticket-ok').textContent = 'Delete the ticket';
    $('ticket-ok').className = 'btn btn-danger';
  }
  $('ticket-confirm').hidden = false;
  renderBoard();
  renderArchived();
  $('ticket-cancel').focus();
}

function closeTicketConfirm() {
  state.ticketConfirm = null;
  $('ticket-confirm').hidden = true;
  renderBoard();
  renderArchived();
}

async function submitTicketConfirm() {
  const confirm = state.ticketConfirm;
  if (confirm === null) {
    return;
  }
  closeTicketConfirm();
  if (confirm.action === 'start') {
    await startTicket(confirm.row);
  } else {
    await ticketAction('delete', confirm.row);
  }
}

// One start per confirmation, never re-sent. A refusal is shown as it comes; an answer that does
// not settle the outcome holds Start for the ticket until the board is read again.
async function startTicket(row) {
  const key = `${row.workspace}/${row.ticket}`;
  const id = `ticket:${key}`;
  if (state.setupPending.has(id) || state.startHolds.has(key)) {
    return;
  }
  state.setupPending.add(id);
  setSetupStatus('ticket-action-status', { level: 'pending', text: `Starting ${key}: creating the branch and its worktree…` });
  renderBoard();
  let outcome;
  let unknown;
  try {
    const result = await post(`api/tickets/${jobPath(key)}/start`, {});
    const data = result !== null && typeof result === 'object' ? result : {};
    outcome = { level: 'ok', text: `Started ${key}: branch ${data.branch}, ${data.state}. The Implementer runs iteration 1.` };
  } catch (error) {
    if (error instanceof ActionError) {
      outcome = { level: 'error', text: `${error.code}: ${error.message}` };
    } else {
      unknown = error.message;
    }
  }
  state.setupPending.delete(id);
  if (unknown !== undefined) {
    await holdStart(key, unknown);
    return;
  }
  setSetupStatus('ticket-action-status', outcome);
  renderBoard();
}

// The start may have created the job: Start stays off for the ticket until api/jobs is read
// after this moment (or, when that read fails, until the stream's next jobs event); the page
// sends nothing by itself.
async function holdStart(key, reason) {
  const hold = { reason, failed: false };
  state.startHolds.set(key, hold);
  const lead = `The start of ${key} failed (${reason}). Its outcome is unknown: the job may have started`;
  setSetupStatus('ticket-action-status', { level: 'error', text: `${lead}; the board is being read again.` });
  renderBoard();
  let jobs;
  try {
    jobs = JSON.parse(await withinTime(getText('api/jobs'))).jobs;
  } catch (error) {
    if (state.startHolds.get(key) === hold) {
      hold.failed = true;
      setSetupStatus('ticket-action-status', { level: 'error', text: `${lead}, and the board could not be read (${error.message}). Start stays off for ${key} until the page reconnects; check the board before starting again.` });
    }
    return;
  }
  if (state.startHolds.get(key) !== hold) {
    return;
  }
  state.startHolds.delete(key);
  state.jobs = jobs;
  setSetupStatus('ticket-action-status', { level: 'error', text: `${lead}. The board is current: check it before starting again.` });
  renderBoard();
}

// ---------- The stream ----------

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
    // A start whose board read failed is settled by this one.
    for (const [ticket, hold] of state.startHolds) {
      if (hold.failed) {
        state.startHolds.delete(ticket);
      }
    }
    if (state.key !== null && jobByKey(state.key) === null) {
      // The open job left the board (its ticket was archived or deleted).
      closeDrawer();
      return;
    }
    renderBoard();
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

// Follows one job: its detail, its events and its controls, in the drawer.
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
    if (key !== '' && key !== state.key && jobByKey(key) !== null) {
      openJob(key);
    }
  });

  // The board and its drawer.
  $('open-workspaces').addEventListener('click', openWorkspaces);
  $('open-new-ticket').addEventListener('click', openNewTicket);
  $('open-archived').addEventListener('click', openArchived);
  $('drawer-close').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  $('drawer').addEventListener('keydown', (event) => {
    // An Escape that closed a confirmation inside stops there.
    if (event.key === 'Escape' && event.defaultPrevented !== true) {
      closeDrawer();
    }
  });
  $('done-all').addEventListener('click', () => {
    state.doneAll = !state.doneAll;
    renderBoard();
  });
  $('task-conversation-copy').addEventListener('click', () => copyText($('task-conversation-text'), 'conversation-copy-status'));
  // The ticket actions' line stays until it is clicked away (or the next action replaces it).
  $('ticket-action-status').addEventListener('click', () => {
    if (!$('ticket-action-status').className.includes('pending')) {
      setSetupStatus('ticket-action-status', null);
    }
  });

  // The job in the drawer.
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
      event.preventDefault();
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

  // Setup and the ticket actions.
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
      event.preventDefault();
      closeTicketConfirm();
    }
  });

  renderSetup();
  // "Since when" on the cards moves on by itself, unless the focus is on the board (a redraw
  // would take it away). The test stand-in has no interval.
  if (typeof setInterval === 'function') {
    setInterval(() => {
      if (!$('board').contains(document.activeElement)) {
        renderBoard();
      }
    }, 60000);
  }
  load();
}

function load() {
  getText('api/jobs').then((text) => {
    state.jobs = JSON.parse(text).jobs;
    renderBoard();
    const wanted = decodeURIComponent(location.hash.slice(1));
    if (wanted !== '' && jobByKey(wanted) !== null) {
      openJob(wanted);
    } else {
      openStream();
    }
  }, () => {
    setConnection('reconnecting', 'down');
    state.retry = setTimeout(load, RECONNECT_MS);
  });
}

document.addEventListener('DOMContentLoaded', init);
