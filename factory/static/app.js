// Software Factory dashboard v2. Loads api/jobs, follows one job through api/stream (server-sent
// events) and renders it. The User's approve, abort and say go as POSTs to
// api/jobs/<ws>/<ticket>/<action>: each one is a deliberate click, confirmed for approve and
// abort, never retried or replayed by the page. Every value goes in through textContent.
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

const state = {
  jobs: [],
  key: null, // "<ws>/<ticket>" of the selected job
  detail: null,
  iteration: null, // selected iteration number
  view: 'report',
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
};

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
  const sorted = [...state.jobs].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  list.replaceChildren(...sorted.map((job) => {
    const button = el('button');
    button.type = 'button';
    button.setAttribute('aria-current', String(keyOf(job) === state.key));
    button.append(el('div', 'job-name', keyOf(job)));
    const line = el('div', 'job-line');
    line.append(el('span', `badge s-${job.state}`, job.state), el('span', '', `iter ${job.iteration}`));
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
  const costs = detail.iterations.map((iteration) => iteration.cost_usd).filter((cost) => typeof cost === 'number');
  // An estimate of the API-equivalent price, not a charge: the session usually runs on a subscription.
  $('job-cost').textContent = costs.length > 0 ? `est. $${costs.reduce((sum, cost) => sum + cost, 0).toFixed(4)}` : 'n/a';
  $('job-updated').textContent = shortTime(job.updated_at);
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
  ok.className = discard ? 'danger' : '';
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
  history.replaceState(null, '', `#${key}`);
  renderJobs();
  openStream();
}

function init() {
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
