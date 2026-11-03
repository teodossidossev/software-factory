// Software Factory dashboard v2. Loads api/jobs, follows one job through api/stream (server-sent
// events) and renders it. The User's approve, abort and say go as POSTs to
// api/jobs/<ws>/<ticket>/<action>: each one is a deliberate click, confirmed for approve and
// abort, never retried or replayed by the page. Who reviews the job comes with its detail (the
// Reviewer block, with the two messages of sf ticket to copy and a test event to send) and the
// subscriptions with the stream. The start screen (Setup) lists the workspaces and the tickets
// without a job, adds a workspace, writes a ticket draft, opens the ChatGPT conversation of a
// ticket (a link the User clicks) and starts a job (confirmed). Every value goes in through
// textContent; the one href is the server's ChatGPT URL, checked against its fixed prefix.
'use strict';

const RECONNECT_MS = 3000;
const READ_TIMEOUT_MS = 10000;
const TERMINAL_STATES = ['pushed', 'aborted', 'failed'];
const SAY_STATES = ['working', 'awaiting_review', 'needs_human'];
const ACTION_LABELS = { approve: 'Approve', abort: 'Abort', say: 'Send' };
const PENDING_REASONS = {
  approve: 'MR preparation was requested; waiting for its outcome.',
  abort: 'abort was requested; waiting for its outcome.',
  say: 'the message is being sent.',
};
const PENDING_TEXT = {
  approve: 'MR preparation started; waiting for it to end (the state history and the event stream below follow it). Closing this page stops waiting, not the preparation; the outcome stays in the job.',
  abort: 'Abort requested; waiting for the job to end.',
  say: 'Sending the message…',
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
  // The test event, per job: "<key>" while its request is out, and the last outcome shown.
  testing: new Set(),
  testOutcomes: new Map(),
  subscriptions: null,
  // The start screen: the registry and the tickets without a job (null until the stream sends
  // them), whether the section's open state was decided from the first data, the requests out
  // for its forms, the open start confirmation and the tickets whose start is out.
  workspaces: null,
  tickets: null,
  setupDecided: false,
  setupPending: new Set(),
  startConfirm: null,
  starting: new Set(),
};
// The only URL the page links to: the ChatGPT composer prefilled by the server.
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
    // Only a missing or a broad reviewer of a live job is worth a badge; a subscribed or a
    // finished job shows none.
    if (TERMINAL_STATES.includes(job.state)) {
      // Nothing to review any more.
    } else if (job.reviewer === 'none') {
      line.append(el('span', 'badge r-none', 'no reviewer'));
    } else if (job.reviewer === 'broad') {
      line.append(el('span', 'badge r-broad', 'broad'));
    }
    line.append(el('span', 'iter', `iteration ${job.iteration}`));
    button.append(line);
    button.addEventListener('click', () => select(keyOf(job)));
    const item = el('li');
    item.append(button);
    return item;
  }));
}

const filterText = (input) => JSON.stringify(input ?? {});

function renderSubscriptions() {
  const rows = state.subscriptions;
  $('no-subscriptions').hidden = rows === null || rows.length > 0;
  $('subscriptions-table').hidden = rows === null || rows.length === 0;
  $('subscriptions-body').replaceChildren(...(rows ?? []).map((row) => {
    const tr = el('tr');
    tr.append(
      el('td', 'mono', row.id), el('td', 'mono', filterText(row.input)), el('td', '', row.host),
      el('td', 'mono', shortTime(row.refreshBefore)), el('td', 'mono', row.job ?? '–'),
    );
    return tr;
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
  const costs = detail.iterations.map((iteration) => iteration.cost_usd).filter((cost) => typeof cost === 'number');
  // An estimate of the API-equivalent price, not a charge: the session usually runs on a subscription.
  $('job-cost').textContent = costs.length > 0 ? `est. $${costs.reduce((sum, cost) => sum + cost, 0).toFixed(4)}` : 'n/a';
  $('job-updated').textContent = shortTime(job.updated_at);
  const error = $('job-error');
  error.hidden = job.error === null;
  error.textContent = job.error === null ? '' : `${job.error.code}: ${job.error.message}`;
}

// The Reviewer block: who receives this job's events, the messages that set it up when nobody
// does, and the test event.
function renderReviewer() {
  const detail = state.detail;
  const reviewer = detail?.reviewer;
  const block = $('reviewer');
  block.hidden = reviewer === undefined;
  if (reviewer === undefined) {
    // Loading another job: its setup boxes start afresh.
    $('reviewer-setup').hidden = true;
    $('copy-status').textContent = '';
    return;
  }
  const line = $('reviewer-line');
  const warning = $('reviewer-warning');
  const broad = Array.isArray(reviewer.broad) ? reviewer.broad : [];
  const removal = broad.map((id) => `sf events remove ${id}`).join('; ');
  if (reviewer.status === 'subscribed') {
    line.replaceChildren(el('span', 'r-subscribed', 'Reviewer: subscribed'), document.createTextNode(` ${reviewer.id}, ${reviewer.host}, filter ${filterText(reviewer.input)}`));
    warning.textContent = broad.length > 0
      ? `Also receiving this job's events, without a ticket filter: ${broad.join(', ')}. ChatGPT would review it twice. Remove with: ${removal}`
      : '';
  } else if (reviewer.status === 'broad') {
    line.replaceChildren(el('span', 'r-broad', 'Reviewer: broad'), document.createTextNode(` ${reviewer.id}, ${reviewer.host}, filter ${filterText(reviewer.input)}`));
    warning.textContent = `${broad.join(', ')} has no ticket filter: that conversation reviews this job along with every other job it matches. Remove with: ${removal}, then set up this ticket with sf ticket.`;
  } else {
    line.replaceChildren(el('span', 'r-none', 'Reviewer: none'), document.createTextNode(' Nobody will review this job.'));
    warning.textContent = '';
  }
  warning.hidden = warning.textContent === '';
  const setup = $('reviewer-setup');
  // The setup messages matter while the job can still be reviewed; a finished job only shows the line.
  const showSetup = reviewer.status === 'none' && detail.reviewerSetup !== undefined && !TERMINAL_STATES.includes(detail.job.state);
  if (setup.hidden && showSetup) {
    $('copy-status').textContent = '';
  }
  setup.hidden = !showSetup;
  $('setup-guide').value = showSetup ? detail.reviewerSetup.guide : '';
  $('setup-instruction').value = showSetup ? detail.reviewerSetup.instruction : '';
  const key = keyOf(detail.job);
  const sending = state.testing.has(key);
  $('test-event-button').disabled = reviewer.status !== 'subscribed' || sending;
  $('test-event-reason').textContent = reviewer.status === 'subscribed' || sending ? '' : 'needs a subscription filtered on this ticket.';
  renderTestOutcome(state.testOutcomes.get(key) ?? null);
}

function renderTestOutcome(outcome) {
  const node = $('test-event-status');
  node.className = outcome === null ? 'status' : `status ${outcome.level}`;
  node.textContent = outcome === null ? '' : outcome.text;
}

// One test event to the job's own subscription; the answer goes to that job only.
async function sendTestEvent() {
  const key = state.key;
  if (key === null || state.detail?.reviewer?.status !== 'subscribed' || state.testing.has(key)) {
    return;
  }
  state.testing.add(key);
  state.testOutcomes.set(key, { level: 'pending', text: 'Sending…' });
  renderReviewer();
  let outcome;
  try {
    const result = await post(`api/jobs/${jobPath(key)}/test-event`, {});
    const data = result !== null && typeof result === 'object' ? result : {};
    outcome = data.delivered === true
      ? { level: 'ok', text: `Test event to ${data.subscription}: delivered, status ${data.status}. ChatGPT should answer in that conversation.` }
      : { level: 'error', text: `Test event to ${data.subscription}: not delivered, status ${data.status}.` };
  } catch (error) {
    outcome = error instanceof ActionError
      ? { level: 'error', text: `${error.code}: ${error.message}` }
      : { level: 'error', text: `The test event failed (${error.message}); it may have been sent. Nothing is retried.` };
  }
  state.testing.delete(key);
  state.testOutcomes.set(key, outcome);
  if (key === state.key && state.detail !== null) {
    renderReviewer();
  }
}

// Copies a setup message; without the clipboard the text is selected for Ctrl+C.
function copySetup(id) {
  const box = $(id);
  const done = (text) => {
    $('copy-status').textContent = text;
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
    return;
  }
  const cost = typeof meta.cost_usd === 'number' ? `$${meta.cost_usd.toFixed(4)}` : 'n/a';
  $('iteration-meta').textContent = `${shortTime(meta.started_at)} – ${shortTime(meta.ended_at)}, cost ${cost}, ` +
    `${meta.changed_files} changed file(s), ${meta.denials} denial(s)${meta.patch_truncated ? ', patch truncated' : ''}`;
  const cacheKey = `${meta.number}/${state.view}`;
  let text = state.cache.get(cacheKey);
  if (text === undefined) {
    try {
      text = await getText(`api/jobs/${jobPath(key)}/iterations/${meta.number}/${state.view}`);
    } catch (error) {
      text = `Could not load: ${error.message}`;
    }
    if (key !== state.key) {
      return;
    }
    state.cache.set(cacheKey, text);
  }
  if (cacheKey === `${state.iteration}/${state.view}`) {
    body.replaceChildren(...(state.view === 'patch' ? renderPatch(text) : renderReport(text)));
  }
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
  renderReviewer();
}

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
    if (job.state === 'awaiting_review' || job.state === 'ready_for_human_review' || (job.state === 'needs_human' && job.mr_attempts > 0)) {
      return '';
    }
    if (job.state === 'needs_human') {
      return 'approve can only retry an MR preparation; send a message or fix by hand first.';
    }
    if (job.state === 'preparing_mr') {
      return 'MR preparation is already running.';
    }
    return `not available while the job is ${job.state}.`;
  }
  if (action === 'abort') {
    return TERMINAL_STATES.includes(job.state) ? `the job is already ${job.state}.` : '';
  }
  return SAY_STATES.includes(job.state) ? '' : `messages need working, awaiting_review or needs_human; the job is ${job.state}.`;
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
  $('action-reasons').textContent = reasons.join(' ');
  $('refresh-button').hidden = state.unresolved.get(state.key)?.failed !== true;
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
  if (action === 'approve') {
    if (data.state === 'pushed') {
      const text = `Pushed ${data.branch}.${data.title ? ` ${data.title}` : ''}`;
      return typeof data.link === 'string'
        ? { level: 'ok', text: `${text} Merge request:`, link: data.link }
        : { level: 'ok', text: `${text} No merge request link: the origin URL could not be parsed. Open the merge request for branch ${data.branch} by hand.` };
    }
    if (data.state === 'awaiting_review') {
      const paths = Array.isArray(data.changed_paths) && data.changed_paths.length > 0 ? data.changed_paths.join(', ') : 'some paths';
      return { level: 'warn', text: `Not pushed: the prepared commit differs from the reviewed change in ${paths}. It went back to the Context owner for review; approve again after Clean.` };
    }
    if (data.state === 'needs_human') {
      return { level: 'error', text: `Not pushed: MR preparation failed (${detail || 'no details'}). Fix it with a message below or by hand, then approve again.` };
    }
    if (data.state === 'aborted') {
      return { level: 'warn', text: 'Not pushed: the job was aborted during MR preparation.' };
    }
    return { level: 'warn', text: `Not pushed: MR preparation ended with state ${data.state}${detail ? ` (${detail})` : ''}.` };
  }
  if (action === 'abort') {
    if (data.error) {
      return { level: 'error', text: `The job ended (${data.state}), but discard failed: ${detail} The discard may be partial: look at the branch ${data.branch} and the work checkout by hand before relying on either.` };
    }
    return data.discarded === true
      ? { level: 'ok', text: `Aborted; the branch ${data.branch} and its changes were removed.` }
      : { level: 'ok', text: `Aborted; the branch ${data.branch} and the files stay.` };
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
    ? `Starts MR preparation for branch ${job.branch}: the Implementer commits and rebases onto ${job.base}, the factory verifies and pushes the branch to origin.`
    : `Ends the job on branch ${job.branch}: the Implementer session stops and queued messages are dropped. The branch and the files stay as they are.`;
  $('discard').checked = false;
  $('discard-label').hidden = action !== 'abort';
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
  ok.textContent = confirm.action === 'approve' ? 'Approve: prepare and push' : discard ? 'Abort and discard the branch' : 'Abort, keep the files';
  ok.className = discard ? 'btn btn-danger' : 'btn btn-primary';
}

function closeConfirm() {
  state.confirm = null;
  $('confirm').hidden = true;
  $('discard').checked = false;
  renderActions();
}

function submitConfirm() {
  const confirm = state.confirm;
  if (confirm === null) {
    return;
  }
  const discard = confirm.action === 'abort' && $('discard').checked;
  closeConfirm();
  // The target was captured when the confirmation opened; a selection changed since drops it.
  if (confirm.key !== state.key) {
    return;
  }
  void run(confirm.action, confirm.key, confirm.action === 'abort' ? { discard } : {});
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

function reviewerLine(reviewer) {
  if (reviewer === undefined || reviewer === null) {
    return [el('span', '', 'Reviewer: unknown')];
  }
  if (reviewer.status === 'subscribed') {
    return [el('span', 'r-subscribed', 'Reviewer: subscribed'), document.createTextNode(` ${reviewer.id}, ${reviewer.host}`)];
  }
  if (reviewer.status === 'broad') {
    return [el('span', 'r-broad', 'Reviewer: broad'), document.createTextNode(` ${reviewer.id} has no ticket filter; it would review this ticket along with every other one (sf events remove ${reviewer.id}).`)];
  }
  return [el('span', 'r-none', 'Reviewer: none'), document.createTextNode(' nobody will review this ticket until ChatGPT subscribes to it: open the conversation.')];
}

function renderTickets() {
  const rows = state.tickets ?? [];
  $('no-tickets').hidden = state.tickets === null || rows.length > 0;
  $('ticket-list').replaceChildren(...rows.map((row) => {
    const key = `${row.workspace}/${row.ticket}`;
    const item = el('li');
    const name = el('div', 'ticket-name', `${key} · ${row.title}`);
    if (row.draft) {
      name.append(el('span', 'badge t-draft', 'draft'));
    }
    if (row.job !== null) {
      name.append(el('span', 'badge t-job', `last job ${row.job}`));
    }
    item.append(name);
    item.append(el('div', 'ticket-line', `.software-factory/${row.ticket}.md · base ${row.base}`));
    const reviewer = el('div', 'ticket-reviewer');
    reviewer.append(...reviewerLine(row.reviewer));
    item.append(reviewer);
    const buttons = el('div', 'row');
    const url = typeof row.conversation?.url === 'string' && row.conversation.url.startsWith(CHATGPT_PREFILL_URL) ? row.conversation.url : null;
    if (url !== null) {
      const link = el('a', 'btn btn-sm btn-primary', 'Open the conversation');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      buttons.append(link);
    }
    const start = el('button', 'btn btn-sm', 'Start…');
    start.type = 'button';
    start.disabled = state.starting.has(key) || state.startConfirm !== null;
    start.addEventListener('click', () => openStartConfirm(row));
    buttons.append(start);
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
    ({ level: 'ok', text: `Draft written: ${data.path} in ${data.workspace} (base ${data.base}). Next, under Tickets: Open the conversation, then Start… when ChatGPT has planned it and you said start.` }));
  if (result !== undefined) {
    $('ticket-key').value = '';
    $('ticket-title').value = '';
    $('ticket-request').value = '';
  }
}

function openStartConfirm(row) {
  const key = `${row.workspace}/${row.ticket}`;
  if (state.startConfirm !== null || state.starting.has(key)) {
    return;
  }
  state.startConfirm = { key, row };
  $('start-confirm-title').textContent = `Start ${key}?`;
  const lines = [`Creates the branch from ${row.base} in the work checkout of ${row.workspace} and starts the first iteration of the Implementer on .software-factory/${row.ticket}.md.`];
  if (row.draft) {
    lines.push('This ticket is still a draft: the Context owner has not rewritten it with write_task, so the Implementer would get your request text as it is.');
  }
  if (row.reviewer?.status === 'none') {
    lines.push('Nobody will review this job: ChatGPT has not subscribed to this ticket. Its iterations will wait in awaiting_review until someone calls check. Start anyway?');
  } else if (row.reviewer?.status === 'broad') {
    lines.push(`Only a subscription without a ticket filter (${row.reviewer.id}) receives its events.`);
  }
  $('start-confirm-text').textContent = lines.join(' ');
  $('start-confirm').hidden = false;
  renderTickets();
  $('start-cancel').focus();
}

function closeStartConfirm() {
  state.startConfirm = null;
  $('start-confirm').hidden = true;
  renderTickets();
}

async function submitStart() {
  const confirm = state.startConfirm;
  if (confirm === null) {
    return;
  }
  closeStartConfirm();
  const { key } = confirm;
  if (state.starting.has(key)) {
    return;
  }
  state.starting.add(key);
  setSetupStatus('start-status', { level: 'pending', text: `Starting ${key}…` });
  renderTickets();
  let outcome;
  let started = false;
  try {
    const result = await post(`api/jobs/${jobPath(key)}/start`, {});
    const data = result !== null && typeof result === 'object' ? result : {};
    started = true;
    outcome = { level: 'ok', text: `Started ${key} on branch ${data.branch} (state ${data.state}). The job is selected below; the Context owner is told by its events.` };
  } catch (error) {
    outcome = error instanceof ActionError
      ? { level: 'error', text: `${error.code}: ${error.message}` }
      : { level: 'error', text: `The request failed (${error.message}); the job may have started. Check the Jobs list; nothing is retried.` };
  }
  state.starting.delete(key);
  setSetupStatus('start-status', outcome);
  if (started) {
    $('setup').open = false;
    select(key);
  } else {
    renderTickets();
  }
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
    if (state.key === null && state.jobs.length > 0) {
      select(keyOf(mostRecent()));
    }
  });
  source.addEventListener('subscriptions', (message) => {
    state.subscriptions = JSON.parse(message.data).subscriptions;
    renderSubscriptions();
  });
  source.addEventListener('workspaces', (message) => {
    state.workspaces = JSON.parse(message.data).workspaces;
    renderSetup();
  });
  source.addEventListener('tickets', (message) => {
    state.tickets = JSON.parse(message.data).tickets;
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
  renderReviewer();
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
  $('abort-button').addEventListener('click', () => openConfirm('abort'));
  $('confirm-ok').addEventListener('click', submitConfirm);
  $('confirm-cancel').addEventListener('click', closeConfirm);
  $('confirm').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeConfirm();
    }
  });
  $('discard').addEventListener('change', renderConfirmButton);
  $('refresh-button').addEventListener('click', () => void settleUnknown(state.key));
  $('test-event-button').addEventListener('click', () => void sendTestEvent());
  $('copy-guide').addEventListener('click', () => copySetup('setup-guide'));
  $('copy-instruction').addEventListener('click', () => copySetup('setup-instruction'));
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
  $('start-ok').addEventListener('click', () => void submitStart());
  $('start-cancel').addEventListener('click', closeStartConfirm);
  $('start-confirm').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeStartConfirm();
    }
  });

  renderSubscriptions();
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
