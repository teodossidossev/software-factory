// Software Factory dashboard v3 (SF-077, SF-078), the port of docs/design/dashboard-v3/prototype.html:
// the top bar (the summary, the connection, the workspace filter, Archived, Workspaces and New
// ticket; the queue controls and the Rules menu stay hidden until SF-071 and SF-072), the board's
// five columns Queue, Implementing, Reviewing, Your turn and Done, whose cards say who acts now, why
// a job stopped (one table, STOPS) and carry one primary action only where the user acts, and the
// full pages a card opens: a job's page at #<ws>/<ticket> (/changes, /mr) and a planned ticket's
// page at #<ws>/<ticket>/ticket (SF-081: the Task file to preview, edit and save, the plan in plain
// words, its check, the conversation and the history, read from api/tickets/<ws>/<ticket>/page). The
// job's page (SF-078): its
// header with the screen switch, and the Stream, one chronological list of the job's entries
// (SF-082: read page by page from api/jobs/<ws>/<ticket>/stream, then live from the stream's entries
// events), with its stop block and the composer pinned at the bottom; the Changes screen (SF-079):
// the file tree and the side-by-side or unified diff of an iteration's files, read from
// api/jobs/<ws>/<ticket>/changes and /file; the Merge request screen shows the old MR view until
// SF-080. The board's messages go to the toast. The job's actions (approve, abort, say, Retry review, Accept and prepare MR, Simplify,
// settle, Pause, Resume, Restart, archive and the merge request on the Git host, SF-048) go as POSTs
// to api/jobs/<ws>/<ticket>/<action>, each one a deliberate click, confirmed inline where it pushes,
// ends, overrides or merges, never retried or replayed by the page. A Queue card starts its job
// (POST api/tickets/<ws>/<ticket>/start, confirmed, never retried; its confirmation says when the
// Task is not checked, the check is stale or not ready) and runs the Task check (SF-054: Check, POST
// api/tickets/<ws>/<ticket>/check; it only advises). Every value goes in through textContent; the
// hrefs are the server's ChatGPT URL, checked against its fixed prefix, and a merge request's https
// URL from the Git host.
'use strict';

const RECONNECT_MS = 3000;
const READ_TIMEOUT_MS = 10000;
const TERMINAL_STATES = ['pushed', 'aborted', 'failed'];
const SAY_STATES = ['working', 'awaiting_review', 'needs_human', 'ready_for_human_review', 'handed_over'];
// The hand-over to the user's checkout (SF-073): the composer's actions, each with the state it takes.
const HANDOVER_ACTIONS = [['handover', 'ready_for_human_review'], ['handed-done', 'handed_over'], ['takeback', 'handed_over']];
// Pause, Resume and Restart (SF-067): the states each takes.
const PAUSE_STATES = ['working', 'awaiting_review'];
const RESTART_STATES = ['paused', 'aborted', 'failed', 'needs_human'];
const ACTION_LABELS = {
  approve: 'Approve', abort: 'Abort', say: 'Send', review: 'Retry review', accept: 'Accept and prepare MR', settle: 'Settle', simplify: 'Simplify', archive: 'Archive',
  'mr-create': 'Create merge request', 'mr-merge': 'Merge', 'mr-status': 'Refresh MR status', pause: 'Pause', resume: 'Resume', restart: 'Restart',
  handover: 'Hand over to my checkout', takeback: 'Take it back', 'handed-done': 'I opened the MR myself',
};
const PENDING_REASONS = {
  accept: 'the override was requested; waiting for its outcome.',
  settle: 'a settlement was requested; waiting for its outcome.',
  simplify: 'the simplification was requested; waiting for its outcome.',
  approve: 'the push was requested; waiting for its outcome.',
  abort: 'abort was requested; waiting for its outcome.',
  say: 'the message is being sent.',
  review: 'the review is being restarted.',
  archive: 'the job is being archived.',
  'mr-create': 'the merge request was requested; waiting for its outcome.',
  'mr-merge': 'the merge was requested; waiting for its outcome.',
  'mr-status': 'the merge request is being read from the host.',
  pause: 'the pause was requested; waiting for the job to stop.',
  resume: 'the resume was requested; waiting for its outcome.',
  restart: 'the restart was requested; waiting for its outcome.',
  handover: 'the hand-over was requested; waiting for its outcome.',
  takeback: 'Take it back was requested; waiting for its outcome.',
  'handed-done': 'origin is being asked for your push.',
};
const PENDING_TEXT = {
  accept: 'Accepting over the gate…',
  settle: 'Settling the finding…',
  simplify: 'Writing the Simplify Fix section…',
  approve: 'Pushing the branch…',
  abort: 'Abort requested; waiting for the job to end.',
  say: 'Sending the message…',
  review: 'Restarting the review…',
  archive: 'Archiving the job…',
  'mr-create': 'Opening the merge request…',
  'mr-merge': 'Merging the merge request…',
  'mr-status': 'Reading the merge request from the host…',
  pause: 'Pausing: stopping the job…',
  resume: 'Resuming the job…',
  restart: 'Restarting the ticket…',
  handover: 'Handing the branch over to your checkout…',
  takeback: 'Taking the branch back from your checkout…',
  'handed-done': 'Asking origin for your push…',
};
const $ = (id) => document.getElementById(id);
// The codes of a job the gate stopped, which Accept and prepare MR takes on (SF-047).
const GATE_CODES = ['gate_rounds', 'gate_budget', 'gate_failed'];
// The ledger's stops (SF-052) that Accept and prepare MR takes on as well.
const LEDGER_CODES = ['review_churn', 'review_disputed'];
// The offer of the simplification pass (SF-055): Simplify applies it, Accept and prepare MR skips it.
const SIMPLIFY_CODE = 'simplify_offered';
const ACCEPT_CODES = [...GATE_CODES, ...LEDGER_CODES, SIMPLIFY_CODE];
// The stops whose findings the user settles here (Accept risk, Must fix).
const SETTLE_STOPS = ['escalated', ...LEDGER_CODES];

const state = {
  jobs: [],
  key: null, // "<ws>/<ticket>" of the job open on its page
  detail: null,
  cache: new Map(), // "<n>/<view>" -> text, for the selected job
  // The Changes screen's data of the selected job (SF-079, cxData); the implement prompt's Task
  // (its stamp, the Task text and its check); the MR text loaded.
  cx: cxData(),
  taskView: null,
  mrText: null,
  source: null,
  retry: null,
  // The Stream (SF-078): the next line of events.jsonl to read (the last page's next, then each
  // live entries event's line + 1); the entries shown in order (a tool carries its joined result
  // as res) and the keys taken; the token of the page load under way; the label before each entry
  // (a continuation hides its author), the last label; the notes typed on ledger entries; what the
  // stop block was last drawn from.
  lastLine: 0,
  entries: [],
  seen: new Set(),
  streamLoad: null,
  labels: new Map(),
  prevLabel: null,
  notes: new Map(),
  stopSig: null,
  // Actions, per job: "<action>\n<key>" while its request is out; the last outcome shown for the
  // job; the draft message; the job's unknown outcome until a current state is read after it,
  // and its warning; and the open confirmation, with the job it was opened for.
  pending: new Set(),
  outcomes: new Map(),
  drafts: new Map(),
  unresolved: new Map(),
  doubts: new Map(),
  confirm: null,
  // The registry, the tickets without a live job and the archived ones (null until the stream
  // sends them), the requests out for the setup forms and the ticket actions, and the open
  // confirmation of a ticket's start or delete.
  workspaces: null,
  tickets: null,
  archived: [],
  setupPending: new Set(),
  ticketConfirm: null,
  // The board: the workspace filter ('' for every workspace), whether Done shows every job, what
  // the drawer shows (null, 'task', 'workspaces', 'ticket' or 'archived'), the Task shown in it,
  // the confirmation a card asked the job page to open, and the tickets whose start has an
  // unknown outcome (Start stays off for them until the board is read again).
  filter: '',
  doneAll: false,
  drawer: null,
  task: null,
  wantConfirm: null,
  startHolds: new Map(),
  // The last merge request status read from the host, per job (SF-048).
  mrStatus: new Map(),
  // The board v3 (SF-077): the timer of the next read of api/jobs while a card runs and the count
  // of the stream's jobs events (a read they overtook is dropped); the toast's
  // timer, its message's level and whether the pointer is on it; the new ticket whose card is
  // highlighted, and whether it was scrolled to.
  refresh: null,
  jobsSeen: 0,
  toastTimer: null,
  toastLevel: null,
  toastHover: false,
  highlight: null,
  highlightShown: false,
  // Where the job page's focus goes once its detail is shown (a card's button): 'composer', 'stop' or null.
  wantFocus: null,
  // SF-084: the tickets the live jobs' Task files land after (the tickets payload's
  // job_lands_after), and the Queue card whose ⋯ menu is open.
  jobLandsAfter: [],
  openMenu: null,
  // The planned ticket page (SF-081): the ticket shown, its page payload, its check as last read,
  // a read's error, the read under way, the editor (kept across redraws) and the Copy's outcome;
  // the ticket whose Start answered before its job reached the board (the page moves to the job).
  tk: { key: null, data: null, check: null, error: null, load: null, textarea: null, copied: null },
  goAfterStart: null,
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
// "2026-11-04 12:14:25" of a stored timestamp (ISO 8601 UTC) in the browser's local time (SF-049);
// empty when it is missing or does not parse.
function localTime(ts) {
  const date = typeof ts === 'string' ? new Date(ts) : null;
  if (date === null || Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
// A <time> of a stored timestamp: the local time as text, the exact UTC moment in its datetime
// and its title, so hovering shows it.
function timeEl(ts) {
  const text = localTime(ts);
  const node = el('time', '', text);
  if (text !== '') {
    node.setAttribute('datetime', ts);
    node.setAttribute('title', ts);
  }
  return node;
}
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

// The connection, a tag in the top bar while the stream is not connected.
function setConnection(text, kind) {
  const node = $('connection');
  node.textContent = text;
  node.className = `tag ${kind}`;
  node.hidden = kind === 'live';
}

// ---------- The job page (SF-078): what its header, Stream, stop block and composer read ----------

const verdictOf = (record) => (record === null || record === undefined ? null : typeof record.error === 'string' ? 'failed' : record.verdict);
const iterationOf = (detail, number) => detail.iterations.find((iteration) => iteration.number === number) ?? null;
// "10:05" of a timestamp, local time.
const clock = (ts) => localTime(ts).slice(11, 16);

// The user may accept the last iteration over the stopped gate (Accept and prepare MR): the gate
// handed the job over (gate_rounds, gate_budget, gate_failed), or the ledger did (SF-052:
// review_churn, review_disputed), and Claude's review of that iteration is clean. Guidance only:
// the factory checks it again.
function gateAcceptable(detail) {
  const job = detail?.job;
  if (job === undefined || job === null || job.state !== 'needs_human' || !ACCEPT_CODES.includes(job.error?.code)) {
    return false;
  }
  return actedClean(iterationOf(detail, job.iteration)?.review);
}

// A Claude review the factory acts on as clean, as the factory decides it: a verdict without a
// blocker or major item (an item without a severity reads as major), the items the ledger dropped
// aside (SF-052).
function actedClean(review) {
  if (verdictOf(review) !== 'clean' && verdictOf(review) !== 'fix') {
    return false;
  }
  const dropped = new Set((review.dropped ?? []).map((item) => JSON.stringify(item)));
  return (review.items ?? []).every((item) => item.severity === 'nit' || dropped.has(JSON.stringify(item)));
}

// The Codex items the gate asked for on the job's last iteration, or its error: what Accept and
// prepare MR goes without. ran is false when no gate ran on it (the budget was used up first).
function gateLeftovers(detail) {
  if (LEDGER_CODES.includes(detail.job.error?.code)) {
    return { items: ledgerOpen(detail), error: null, ran: true, ledger: true };
  }
  const gate = iterationOf(detail, detail.job.iteration)?.gate ?? null;
  if (gate === null) {
    return { items: [], error: null, ran: false };
  }
  return typeof gate.error === 'string' ? { items: [], error: gate.error, ran: true } : { items: gate.items ?? [], error: null, ran: true };
}

// The ledger's findings an Accept over a ledger stop goes without (SF-052): open entries, the
// fixes the user decided and the disputed contests.
function ledgerOpen(detail) {
  return (detail.ledger ?? []).filter((entry) => entry.status === 'open' || entry.status === 'user_fix' || (entry.status === 'contested' && entry.dispute !== null));
}

// The job waits on the offer of the simplification pass (SF-055).
const simplifiable = (job) => job !== null && job !== undefined && job.state === 'needs_human' && job.error?.code === SIMPLIFY_CODE;

// The suggestions the simplification pass offers on the job's last iteration (SF-055), for the
// stop block and the confirmations of Simplify and of Skip (accept).
function offeredSuggestions(detail) {
  const record = iterationOf(detail, detail?.job?.iteration)?.simplify ?? null;
  return { items: Array.isArray(record?.suggestions) ? record.suggestions : [], suggestions: true };
}

// The ledger's findings the user settles while the job waits (SF-052): escalated entries and
// contests, each with Accept risk and Must fix.
function settleable(detail) {
  if (detail?.job?.state !== 'needs_human' || !SETTLE_STOPS.includes(detail.job.error?.code)) {
    return [];
  }
  return (detail.ledger ?? []).filter((entry) => entry.status === 'escalated' || entry.status === 'contested');
}

// The user's override of the gate that still stands (SF-047): the newest gate-override.json, unless
// a later iteration was reviewed by the gate again; null when there is none.
function standingOverride(detail) {
  for (const iteration of [...detail.iterations].reverse()) {
    if (iteration.gate_override !== null && iteration.gate_override !== undefined) {
      return iteration.gate_override;
    }
    if (iteration.gate !== null && iteration.gate !== undefined) {
      return null;
    }
  }
  return null;
}

// The notice of a paused job whose Task file changed since the Implementer was last given it (SF-067).
const TASK_CHANGED = 'Task file changed since the job started: Resume hands the change to the Implementer and the reviewers.';

// What moves a paused job on (SF-067), after "Paused by you during iteration N".
function pausedNext(job) {
  const step = job.paused?.step;
  const again = step === 'turn' ? 'Resume continues the same session (with your message, if you write one below)'
    : ['review', 'gate', 'simplify'].includes(step) ? 'Resume runs it again' : 'Resume goes on';
  return `${again}; Restart starts the ticket again from its current Task file`;
}

// The sentence of the job page's header and composer: sentence(), and for a paused job what moves it on.
const headSentence = (job) => (job.state === 'paused' ? `${sentence(job)}. ${pausedNext(job)}` : sentence(job));

// A merge request's URL as a link when it is https, else as text.
function mrLink(mr) {
  if (typeof mr.url === 'string' && /^https:\/\/[^\s]+$/.test(mr.url)) {
    const link = el('a', 'mono', mr.url);
    link.href = mr.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }
  return el('span', 'mono', String(mr.url));
}

// What the host said of the merge request: "open, mergeable, checks 2 passed" or why not.
function mrStatusText(status) {
  const parts = [`#${status.number} ${status.state}${status.draft ? ' (draft)' : ''}`];
  if (status.state === 'open') {
    parts.push(status.mergeable === true ? 'mergeable' : status.mergeable === false ? `not mergeable: ${status.reason ?? 'no reason given'}` : `mergeable not known yet${status.reason ? ` (${status.reason})` : ''}`);
  }
  if (typeof status.checks === 'string') {
    parts.push(`checks: ${status.checks}`);
  }
  return `On the host: ${parts.join(', ')}.`;
}

// ---------- Task check (SF-054) ----------

// The last check of a ticket, as the implement prompt's Task toggle shows it (the planned ticket
// page has its own Plan check card, SF-081):
// the stale mark and the verdict, the paraphrase above the findings (by severity), then the
// expected files.
function renderCheck(view) {
  const box = [];
  const record = view.check;
  if (record === null) {
    box.push(el('p', 'check-head', view.running ? 'Task check: running…' : 'Task check: not checked yet. Check on the ticket\'s card runs it; it only advises.'));
    return box;
  }
  const output = record.output;
  const counts = tkCounts(output);
  const verdict = output === null ? 'check failed' : output.verdict === 'ready' ? 'ready' : `not ready: ${counts.blocker} blocker, ${counts.major} major`;
  const head = el('p', 'check-head');
  head.append(document.createTextNode(`Task check: ${verdict} · `), timeEl(record.ended_at), document.createTextNode(` · ${record.model ?? 'default model'}${view.running ? ' · a new check is running…' : ''}`));
  box.push(head);
  if (view.stale) {
    box.push(el('p', 'check-stale', 'Stale: the Task file changed since this check.'));
  }
  if (output === null) {
    box.push(el('p', 'check-error', record.error ?? 'The check failed.'));
    return box;
  }
  box.push(el('h4', 'check-title', 'Paraphrase'), el('p', 'check-paraphrase', output.paraphrase));
  box.push(el('h4', 'check-title', 'Findings'));
  for (const severity of ['blocker', 'major', 'nit']) {
    const items = output.findings.filter((item) => item.severity === severity);
    if (items.length === 0) {
      continue;
    }
    box.push(el('p', `check-severity s-${severity}`, `${severity} (${items.length})`));
    const list = el('ul', 'check-findings');
    list.append(...items.map((item) => {
      const entry = el('li');
      entry.append(el('span', 'check-kind', item.kind), document.createTextNode(' '), el('code', '', item.where), document.createTextNode(`: ${item.problem} Expected: ${item.expected}`));
      return entry;
    }));
    box.push(list);
  }
  if (output.findings.length === 0) {
    box.push(el('p', 'hint', 'None.'));
  }
  if (output.files.length > 0) {
    box.push(el('h4', 'check-title', 'Files'));
    const files = el('ul', 'check-files');
    files.append(...output.files.map((file) => {
      const entry = el('li');
      entry.append(document.createTextNode(`${file.action} `), el('code', '', file.path));
      return entry;
    }));
    box.push(files);
  }
  return box;
}

// A ticket's last check as the factory has it; null when it has none to show (no Task checks, no
// Task file).
async function readCheck(key) {
  try {
    return JSON.parse(await getText(`api/tickets/${jobPath(key)}/check`));
  } catch {
    return null;
  }
}

// Check: one request per ticket at a time; the card shows the check running, then its verdict.
async function checkTicket(row) {
  const key = `${row.workspace}/${row.ticket}`;
  await setupRequest(`check:${key}`, `api/tickets/${jobPath(key)}/check`, {}, 'toast', () =>
    ({ level: 'ok', text: `Checking ${key}: a read-only Claude session reads the Task file and the repository; the card shows the verdict when it ends. It only advises: Start stays yours.` }));
}

// ---------- The Changes screen (SF-079): the prototype's file tree, diff pane and iteration selector ----------

// Report: preformatted, Markdown headings bold (the Stream's changes entries and the MR text).
function renderReport(text) {
  return text.split('\n').map((line) => el('span', /^#{1,6}\s/.test(line) ? 'heading' : '', `${line}\n`));
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

// localStorage as the prototype's store: a browser that refuses it keeps the default.
const store = {
  get(name) {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  set(name, value) {
    try {
      localStorage.setItem(name, value);
    } catch {
      // none
    }
  },
};
const DIFF_MODE_KEY = 'sf-diff-mode';

// The Changes data of the job shown, read from the server: the index of api/jobs/<key>/changes and
// the stamp (the job's iteration and state) it was read for, the stamp being read; the file lists
// per view ("<from>|<to>"), the sides of the files per "<side>|<path>" (side "base:<N>" or "<N>"),
// each 'loading', the answer or { error }; the line diffs per pair of sides; whether the tree takes
// the focus once its list arrives.
function cxData() {
  return { index: null, stamp: null, loading: null, lists: new Map(), sides: new Map(), diffs: new Map(), focusTree: false };
}

// Reads path into map at id once; done runs when it arrives for the same job's data.
function cxGet(map, id, path, done) {
  if (map.has(id)) {
    return map.get(id);
  }
  map.set(id, 'loading');
  const data = state.cx;
  getText(path).then((text) => JSON.parse(text)).catch((error) => ({ error: error.message })).then((value) => {
    if (state.cx === data && map.get(id) === 'loading') {
      map.set(id, value);
      done();
    }
  });
  return 'loading';
}

// The index of the job's iterations, read again when the job's iteration or state changes (a new
// iteration, a rebase); the one read before stays shown until the new one arrives. A new index
// whose bases differ from the old one's drops the lists and sides read against them.
function cxIndex() {
  const job = shownJob();
  const data = state.cx;
  const stamp = `${job.iteration}|${job.state}`;
  if (data.stamp !== stamp && data.loading !== stamp) {
    data.loading = stamp;
    const key = state.key;
    getText(`api/jobs/${jobPath(key)}/changes`).then((text) => JSON.parse(text)).catch((error) => ({ error: error.message })).then((index) => {
      if (state.cx !== data || data.loading !== stamp) {
        return;
      }
      const bases = (value) => (Array.isArray(value?.iterations) ? value.iterations.map((iteration) => iteration.base_commit) : []);
      const fresh = bases(index);
      if (bases(data.index).some((base, at) => fresh[at] !== base)) {
        data.lists.clear();
        data.sides.clear();
        data.diffs.clear();
      }
      data.loading = null;
      data.stamp = stamp;
      data.index = index;
      if (ui.screen === 'changes' && ui.job === key) {
        renderChanges(data.focusTree || ($('tlist')?.contains(document.activeElement) ?? false));
      }
    });
  }
  return data.index;
}

function itersOf() {
  const index = state.cx.index;
  return index !== null && Array.isArray(index.iterations) ? index.iterations : [];
}

// The pair of a view: All changes is the last iteration's base against it, Iteration 1 its base
// against it, Iteration N iteration N - 1 against N.
function viewPair(view) {
  const its = itersOf();
  const to = view === 'all' ? its[its.length - 1].n : view;
  return [view === 'all' || to === 1 ? 'base' : to - 1, to];
}

// The file list of a view: 'loading', { error } or { files, more }.
function listOf(view) {
  const [from, to] = viewPair(view);
  return cxGet(state.cx.lists, `${from}|${to}`, `api/jobs/${jobPath(state.key)}/changes?from=${from}&to=${to}`, () => {
    if (ui.screen === 'changes') {
      renderChanges(state.cx.focusTree);
    }
  });
}

function changeSet(view) {
  const list = itersOf().length === 0 ? null : listOf(view ?? 'all');
  return list !== null && Array.isArray(list.files) ? list.files : [];
}

// The two sides of a view, as the file route names them: "base:<N>" (the base of iteration N) or "<N>".
function sidesOf(view) {
  const [from, to] = viewPair(view);
  return [from === 'base' ? `base:${to}` : String(from), String(to)];
}

function sideOf(side, path) {
  const [at, of] = side.startsWith('base:') ? ['base', side.slice(5)] : [side, null];
  return cxGet(state.cx.sides, `${side}|${path}`, `api/jobs/${jobPath(state.key)}/file?at=${at}${of === null ? '' : `&of=${of}`}&path=${encodeURIComponent(path)}`, () => {
    if (ui.screen === 'changes') {
      renderDiffPane();
    }
  });
}

// The lines of one side ("<side>|<path>"): none when the file is absent there.
const linesOf = (id) => {
  const version = state.cx.sides.get(id);
  if (version?.kind !== 'text') {
    return [];
  }
  const ls = version.text.split('\n');
  if (ls.length && ls[ls.length - 1] === '') {
    ls.pop();
  }
  return ls;
};

// ---- line diff (Myers, with common prefix and suffix trimmed first), the prototype's. One change:
// off is max + 1 (the prototype's max), so the trace's slice at d = max starts at 0, not at -1 (a
// one-line replacement read the wrong trace).
function myers(A, B) {
  const N = A.length, M = B.length;
  if (!N) return B.map((_, j) => ['+', -1, j]);
  if (!M) return A.map((_, i) => ['-', i, -1]);
  const max = N + M, off = max + 1, V = new Int32Array(2 * max + 3), trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > 2500) return [...A.map((_, i) => ['-', i, -1]), ...B.map((_, j) => ['+', -1, j])];
    trace.push(V.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      V[off + k] = x;
      if (x >= N && y >= M) {
        const ops = []; let cx = N, cy = M;
        for (let dd = d; dd >= 0; dd--) {
          const v = trace[dd], at = (kk) => v[kk + dd + 1];
          const kk = cx - cy;
          const pk = (kk === -dd || (kk !== dd && at(kk - 1) < at(kk + 1))) ? kk + 1 : kk - 1;
          const px = dd === 0 ? 0 : at(pk), py = px - pk;
          while (cx > px && cy > py) { ops.push(['=', cx - 1, cy - 1]); cx--; cy--; }
          if (dd > 0) { if (cx === px) ops.push(['+', -1, cy - 1]); else ops.push(['-', cx - 1, -1]); }
          cx = px; cy = py;
        }
        return ops.reverse();
      }
    }
  }
  return [];
}
function getDiff(f) {
  const key = f.a + '|' + f.b;
  if (state.cx.diffs.has(key)) return state.cx.diffs.get(key);
  const A = linesOf(f.a), B = linesOf(f.b);
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length; while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const mid = myers(A.slice(s, ea), B.slice(s, eb)).map(([t, i, j]) => [t, i < 0 ? -1 : i + s, j < 0 ? -1 : j + s]);
  const ops = [];
  for (let i = 0; i < s; i++) ops.push(['=', i, i]);
  ops.push(...mid);
  for (let i = 0; i < A.length - ea; i++) ops.push(['=', ea + i, eb + i]);
  const d = { ops, A, B, add: ops.filter((o) => o[0] === '+').length, del: ops.filter((o) => o[0] === '-').length };
  state.cx.diffs.set(key, d);
  return d;
}
// The changed words of a line pair: the part between the common prefix and suffix, as nodes.
function wordHl(a, b) {
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const wrap = (t, cls) => { const m = t.slice(p, t.length - s); return [t.slice(0, p), ...(m ? [el('span', cls, m)] : []), t.slice(t.length - s)].filter((part) => part !== ''); };
  return [wrap(a, 'w-del'), wrap(b, 'w-add')];
}
// The diff of a file as rows (the prototype's diffHtml, built as nodes): side-by-side or unified,
// unchanged runs folded to "⋯ N unchanged lines" with 3 lines of context, none at the file's edges.
function diffHtml(f) {
  const d = getDiff(f); const { A, B, ops } = d;
  const side = ui.cx.mode === 'side', C = 3;
  const segs = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i][0] === '=') { const s = { t: 'eq', rows: [] }; while (i < ops.length && ops[i][0] === '=') { s.rows.push(ops[i]); i++; } segs.push(s); }
    else { const s = { t: 'chg', dels: [], adds: [] }; while (i < ops.length && ops[i][0] !== '=') { if (ops[i][0] === '-') s.dels.push(ops[i][1]); else s.adds.push(ops[i][2]); i++; } segs.push(s); }
  }
  const ln = (n) => el('span', 'ln', n === null ? '' : String(n));
  const cell = (cls, parts) => { const c = el('span', cls); c.append(...parts); return c; };
  const rowOf = (cls, ...cells) => { const r = el('div', cls); r.append(...cells); return r; };
  const eq = (o) => side ? rowOf('r', ln(o[1] + 1), el('span', 'c', A[o[1]]), ln(o[2] + 1), el('span', 'c', B[o[2]]))
    : rowOf('r', ln(o[1] + 1), ln(o[2] + 1), el('span', 'sg'), el('span', 'c', A[o[1]]));
  const rows = [];
  segs.forEach((s, si) => {
    if (s.t === 'eq') {
      const fid = `${f.path}|${ui.cx.view}|${si}`;
      const head = si === 0 ? 0 : C, tail = si === segs.length - 1 ? 0 : C;
      if (ui.cx.collapse && !ui.cx.unfolded.has(fid) && s.rows.length > head + tail + 2) {
        rows.push(...s.rows.slice(0, head).map(eq), button('fold', `⋯ ${s.rows.length - head - tail} unchanged lines`, { fold: fid }), ...s.rows.slice(s.rows.length - tail).map(eq));
      } else rows.push(...s.rows.map(eq));
      return;
    }
    const n = Math.max(s.dels.length, s.adds.length);
    const pair = (k) => { const ai = s.dels[k], bi = s.adds[k]; return ai != null && bi != null && s.dels.length === s.adds.length ? wordHl(A[ai], B[bi]) : [ai != null ? [A[ai]] : [], bi != null ? [B[bi]] : []]; };
    if (side) {
      for (let k = 0; k < n; k++) { const ai = s.dels[k], bi = s.adds[k]; const [ah, bh] = pair(k);
        rows.push(rowOf('r', ln(ai != null ? ai + 1 : null), cell(`c ${ai != null ? 'del' : 'void'}`, ah), ln(bi != null ? bi + 1 : null), cell(`c ${bi != null ? 'add' : 'void'}`, bh))); }
    } else {
      const hs = Array.from({ length: n }, (_, k) => pair(k));
      s.dels.forEach((ai, k) => { rows.push(rowOf('r del', ln(ai + 1), ln(null), el('span', 'sg', '−'), cell('c', hs[k][0]))); });
      s.adds.forEach((bi, k) => { rows.push(rowOf('r add', ln(null), ln(bi + 1), el('span', 'sg', '+'), cell('c', hs[k][1]))); });
    }
  });
  const node = el('div', `dfile${side ? '' : ' uni'}`);
  node.append(...(ops.length ? rows : [el('div', 'dempty', 'Empty file.')]));
  return node;
}

// ---- the tree
function visibleFiles() { const all = changeSet(ui.cx.view); const q = ui.cx.q.toLowerCase(); return { all, files: q ? all.filter((f) => f.path.toLowerCase().includes(q)) : all }; }
function treeRows(files) {
  if (ui.cx.flat) return files.map((f) => ({ id: 'f:' + f.path, type: 'file', f, depth: 0 }));
  const root = { dirs: new Map(), files: [] };
  for (const f of files) { const parts = f.path.split('/'); let n = root; for (const p of parts.slice(0, -1)) { if (!n.dirs.has(p)) n.dirs.set(p, { dirs: new Map(), files: [] }); n = n.dirs.get(p); } n.files.push(f); }
  const count = (n) => n.files.length + [...n.dirs.values()].reduce((s, c) => s + count(c), 0);
  const out = [];
  const walk = (node, prefix, depth, parent) => {
    for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      let nm = name, c = child, full = prefix + name;
      while (c.files.length === 0 && c.dirs.size === 1) { const [n2, c2] = [...c.dirs][0]; nm += '/' + n2; full += '/' + n2; c = c2; }
      const id = 'd:' + full;
      out.push({ id, type: 'dir', path: full, name: nm, depth, count: count(c), parent, open: !ui.cx.collapsed.has(full) });
      if (!ui.cx.collapsed.has(full)) walk(c, full + '/', depth + 1, id);
    }
    for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) out.push({ id: 'f:' + f.path, type: 'file', f, depth, parent });
  };
  walk(root, '', 0, null);
  return out;
}
const LETTER = { modified: 'M', added: 'A', deleted: 'D' };
// One row of the tree: a folder (▾/▸, its name compacted, its file count) or a file (M/A/D, its
// name, its folder in the flat list, a binary or unavailable tag, +a −d), its depth as --d.
function rowHtml(r) {
  const cur = ui.cx.cursor === r.id;
  const li = el('li');
  li.setAttribute('role', 'none');
  let row;
  if (r.type === 'dir') {
    row = button(`trow dir${cur ? ' sel' : ''}`, '', { trow: r.id });
    row.setAttribute('aria-expanded', String(r.open));
    row.append(el('span', 'tw', r.open ? '▾' : '▸'), el('span', 'ic', '▤'), el('span', 'nm', r.name), el('span', 'cnt', String(r.count)));
  } else {
    const f = r.f, [dir, name] = splitPath(f.path);
    row = button(`trow vcs-${f.status}${cur ? ' sel' : ''}`, '', { trow: r.id });
    row.setAttribute('title', `${f.path} (${f.status})`);
    row.append(el('span', 'tw'), el('span', 'lt', LETTER[f.status] ?? 'M'), el('span', 'nm', name));
    if (ui.cx.flat) row.append(el('span', 'dn', dir));
    if (f.unavailable) row.append(el('span', 'tag', 'unavailable'));
    else if (f.binary) row.append(el('span', 'tag', 'binary'));
    const cnt = el('span', 'cnt');
    cnt.append(el('span', 'a', `+${f.additions}`), ' ', el('span', 'r', `−${f.deletions}`));
    row.append(cnt);
  }
  row.setAttribute('role', 'treeitem');
  row.setAttribute('tabindex', cur ? '0' : '-1');
  row.style.setProperty('--d', String(r.depth));
  li.append(row);
  return li;
}
function renderTree(focus) {
  const { all, files } = visibleFiles();
  const rows = treeRows(files);
  ui.cx.rows = rows;
  if (!rows.some((r) => r.id === ui.cx.cursor)) ui.cx.cursor = ui.cx.sel && rows.some((r) => r.id === 'f:' + ui.cx.sel) ? 'f:' + ui.cx.sel : rows.find((r) => r.type === 'file')?.id ?? rows[0]?.id ?? null;
  const n = (s) => all.filter((f) => f.status === s).length;
  let add = 0, del = 0; for (const f of all) { add += f.additions; del += f.deletions; }
  const more = listOf(ui.cx.view)?.more === true;
  $('cxsum').replaceChildren(el('b', '', `${all.length} files`), `: ${n('modified')} modified, ${n('added')} added, ${n('deleted')} deleted · `, el('span', 'a', `+${add}`), ' ', el('span', 'r', `−${del}`),
    ...(files.length !== all.length ? [` · ${files.length} match`] : []), ...(more ? [' · the first 3000 files only'] : []));
  // The focus stays in the tree when it was there: on the cursor's row.
  const inTree = $('tlist').contains(document.activeElement);
  $('tlist').replaceChildren(...(rows.length ? rows.map(rowHtml) : [el('li', 'dempty', 'No file matches the filter.')]));
  const node = [...$('tlist').querySelectorAll('.trow')].find((row) => row.dataset.trow === ui.cx.cursor);
  if (node) { node.scrollIntoView({ block: 'nearest' }); if (focus || inTree) node.focus(); }
}
function iterLabel(v) { const its = itersOf(); return v === 'all' ? `All changes (final${its.length ? ', after iteration ' + its[its.length - 1].n : ''})` : `Iteration ${v}${v > 1 ? ` (Fix ${v - 1})` : ''}`; }
// A commit in a note, short (12 characters, as elsewhere on the page).
const shortCommit = (commit) => commit.slice(0, 12);
// The diff pane's toolbar (◀ ⇧F7, F7 ▶, the path, i/n · status, the iteration selector, the
// layout, Collapse unchanged) and its body: the notes and the diff of the selected file, its two
// sides read from the file route when it is selected.
function renderDiffPane() {
  if ($('dtool') === null) return;
  const { files } = visibleFiles();
  const f = files.find((x) => x.path === ui.cx.sel) || null;
  const idx = f ? files.indexOf(f) : -1;
  const its = itersOf();
  const focused = document.activeElement?.id;
  const prev = button('btn small', '◀ ', { fstep: '-1' });
  prev.setAttribute('title', 'Previous file (Shift+F7 or p)');
  prev.append(el('span', 'kbd', '⇧F7'));
  prev.disabled = idx <= 0;
  const next = button('btn small', '', { fstep: '1' });
  next.setAttribute('title', 'Next file (F7 or n)');
  next.append(el('span', 'kbd', 'F7'), ' ▶');
  next.disabled = idx < 0 || idx >= files.length - 1;
  const dpath = el('span', 'dpath', f ? f.path : 'No file selected');
  dpath.setAttribute('title', f?.path || '');
  const select = el('select');
  select.id = 'cxview';
  select.setAttribute('aria-label', 'Which changes');
  for (const v of ['all', ...its.map((x) => x.n)]) {
    const option = el('option', '', iterLabel(v));
    option.value = String(v);
    option.selected = ui.cx.view === v;
    select.append(option);
  }
  select.value = String(ui.cx.view);
  const seg = el('span', 'seg2');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Diff layout');
  seg.append(button(ui.cx.mode === 'side' ? 'on' : '', 'Side-by-side', { mode: 'side' }), button(ui.cx.mode === 'uni' ? 'on' : '', 'Unified', { mode: 'uni' }));
  const collapse = el('input');
  collapse.type = 'checkbox';
  collapse.id = 'cxcollapse';
  collapse.checked = ui.cx.collapse;
  const label = el('label');
  label.append(collapse, ' Collapse unchanged');
  $('dtool').replaceChildren(prev, next, dpath, ...(f ? [el('span', 'muted fs12', `${idx + 1}/${files.length} · ${f.status}`)] : []), el('span', 'sp'), select, seg, label);
  if (focused === 'cxview' || focused === 'cxcollapse') $(focused).focus();
  const body = $('dbody');
  if (!f) { body.replaceChildren(el('div', 'dempty', listOf(ui.cx.view) === 'loading' ? 'Loading…' : 'Select a file on the left.')); return; }
  const notes = [];
  if (f.status === 'deleted') notes.push(el('div', 'dnote', 'Deleted file: the old content, all removed.'));
  else if (f.status === 'added') notes.push(el('div', 'dnote', 'New file: all added.'));
  // A conflict-resolved rebase between iteration N - 1 and N: this view also shows the upstream changes.
  if (ui.cx.view !== 'all' && ui.cx.view > 1) {
    const before = its.find((x) => x.n === ui.cx.view - 1)?.base_commit, after = its.find((x) => x.n === ui.cx.view)?.base_commit;
    if (before && after && before !== after) notes.push(el('div', 'dnote', `The base moved from ${shortCommit(before)} to ${shortCommit(after)} before iteration ${ui.cx.view}: this view also shows those upstream changes.`));
  }
  const [a, b] = sidesOf(ui.cx.view);
  const versions = [sideOf(a, f.path), sideOf(b, f.path)];
  const message = (text) => { body.replaceChildren(...notes, el('div', 'dempty', text)); body.scrollTop = 0; };
  if (versions.includes('loading')) return message('Loading…');
  const failed = versions.find((v) => typeof v?.error === 'string');
  if (failed) return message(`Could not load the file: ${failed.error}`);
  const unavailable = versions.find((v) => v.kind === 'unavailable');
  if (unavailable) return message(unavailable.reason);
  if (f.binary || versions.some((v) => v.kind === 'binary')) return message('Binary file: not shown.');
  if (versions.some((v) => v.kind === 'too_large')) return message('Larger than 1 MiB: not shown.');
  if (f.unavailable) return message('This file is not available.');
  if (f.status === 'modified' && ui.cx.mode === 'side') {
    const split = el('div', 'dnote split');
    split.append(el('span', '', `Before (${ui.cx.view === 'all' || ui.cx.view === 1 ? state.cx.index.base?.ref ?? '' : 'iteration ' + (ui.cx.view - 1)})`),
      el('span', '', `After (iteration ${ui.cx.view === 'all' ? its[its.length - 1].n : ui.cx.view})`));
    notes.push(split);
  }
  body.replaceChildren(...notes, diffHtml({ path: f.path, a: `${a}|${f.path}`, b: `${b}|${f.path}` }));
  body.scrollTop = 0;
}
// The Changes screen: the empty states, else the tree, the divider and the diff pane, built once
// and redrawn in place.
function renderChanges(focusTree) {
  const job = shownJob(); const node = $('scrChanges');
  if (job === null) return;
  const index = cxIndex();
  const notice = (text) => { node.replaceChildren(el('div', 'dempty span', text)); };
  if (index === null) return notice('Loading…');
  if (typeof index.error === 'string') return notice(`Could not load the changes: ${index.error}`);
  const its = itersOf();
  if (!its.length) return notice(`No iteration has ended yet. The changes appear here when the Implementer finishes iteration ${shownIteration(job) || 1}; until then its edits are in the stream.`);
  if (ui.cx.view !== 'all' && !its.some((x) => x.n === ui.cx.view)) ui.cx.view = 'all';
  if (node.querySelector('#tlist') === null) {
    const q = el('input', 'ffq');
    q.id = 'cxq';
    q.type = 'search';
    q.setAttribute('placeholder', 'Filter files (/)');
    q.setAttribute('aria-label', 'Filter files');
    const seg = el('span', 'seg2');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Tree layout');
    seg.append(button('', 'Group by directory', { flat: '0' }), button('', 'Flat list', { flat: '1' }));
    const row = el('div', 'row');
    row.append(seg);
    const sum = el('div', 'sum');
    sum.id = 'cxsum';
    const tb = el('div', 'tb');
    tb.append(q, row, sum);
    const list = el('ul', 'tlist');
    list.id = 'tlist';
    list.setAttribute('role', 'tree');
    list.setAttribute('aria-label', 'Changed files');
    const tree = el('div', 'tree');
    tree.append(tb, list);
    const vdiv = el('div', 'vdiv');
    vdiv.id = 'vdiv';
    vdiv.setAttribute('role', 'separator');
    vdiv.setAttribute('aria-orientation', 'vertical');
    vdiv.setAttribute('aria-label', 'Resize the file tree');
    vdiv.setAttribute('tabindex', '0');
    const tool = el('div', 'dtool');
    tool.id = 'dtool';
    const body = el('div', 'dbody');
    body.id = 'dbody';
    body.setAttribute('tabindex', '-1');
    const pane = el('div', 'dpane');
    pane.append(tool, body);
    node.replaceChildren(tree, vdiv, pane);
  }
  $('cxq').value = ui.cx.q;
  node.querySelectorAll('[data-flat]').forEach((b) => b.classList.toggle('on', (b.dataset.flat === '1') === ui.cx.flat));
  const list = listOf(ui.cx.view);
  if (list === 'loading' || typeof list?.error === 'string') {
    $('cxsum').textContent = '';
    $('tlist').replaceChildren(el('li', 'dempty', list === 'loading' ? 'Loading…' : `Could not load the files: ${list.error}`));
    renderDiffPane();
    return;
  }
  // A path link's file that did not change in its iteration: All changes.
  if (ui.cx.check !== null) {
    const path = ui.cx.check;
    ui.cx.check = null;
    if (ui.cx.view !== 'all' && !list.files.some((f) => f.path === path)) {
      ui.cx.view = 'all';
      return renderChanges(focusTree);
    }
  }
  const { files } = visibleFiles();
  if (!ui.cx.sel || !files.some((f) => f.path === ui.cx.sel)) ui.cx.sel = files[0]?.path ?? null;
  ui.cx.cursor = ui.cx.sel ? 'f:' + ui.cx.sel : ui.cx.cursor;
  state.cx.focusTree = false;
  renderTree(focusTree); renderDiffPane();
}
function selectRow(id, focus) {
  ui.cx.cursor = id;
  if (id && id.startsWith('f:')) { const p = id.slice(2); if (p !== ui.cx.sel) { ui.cx.sel = p; renderDiffPane(); } }
  renderTree(focus);
}
// The tree's keys: Up and Down move, Left closes a folder or goes to the parent, Right opens a
// folder or goes into it, Enter opens or closes a folder, or shows the file's diff.
function treeKey(ev) {
  const rows = ui.cx.rows || []; const i = rows.findIndex((r) => r.id === ui.cx.cursor); const r = rows[i];
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); const n = rows[Math.max(0, Math.min(rows.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))]; if (n) selectRow(n.id, true); return true; }
  if (!r) return false;
  if (ev.key === 'ArrowLeft') { ev.preventDefault(); if (r.type === 'dir' && r.open) { ui.cx.collapsed.add(r.path); renderTree(true); } else if (r.parent) selectRow(r.parent, true); return true; }
  if (ev.key === 'ArrowRight') { ev.preventDefault(); if (r.type === 'dir' && !r.open) { ui.cx.collapsed.delete(r.path); renderTree(true); } else if (r.type === 'dir') { const n = rows[i + 1]; if (n) selectRow(n.id, true); } return true; }
  if (ev.key === 'Enter') { ev.preventDefault(); if (r.type === 'dir') { if (r.open) ui.cx.collapsed.add(r.path); else ui.cx.collapsed.delete(r.path); renderTree(true); } else { selectRow(r.id, false); $('dbody').focus(); } return true; }
  return false;
}
// F7 / Shift+F7 and n / p: the next or previous file of the list, the folders on the way opened.
function fileStep(d) {
  const { files } = visibleFiles();
  const i = files.findIndex((f) => f.path === ui.cx.sel); const n = files[i + d];
  if (!n) return toast({ level: 'info', text: d > 0 ? 'Last file' : 'First file' });
  for (const r of (ui.cx.rows || [])) if (r.type === 'dir' && n.path.startsWith(r.path + '/')) ui.cx.collapsed.delete(r.path);
  selectRow('f:' + n.path, false);
}
// Open the Changes screen on a file, at an iteration when that file changed in it (All changes
// otherwise, decided once that iteration's list is read), the folders on the way opened.
function openChanges(path, it) {
  if (ui.job === null) return;
  ui.cx.q = '';
  let view = it ? Number(it) : 'all';
  if (!Number.isInteger(view) || view < 1) view = 'all';
  if (state.cx.index !== null && !itersOf().some((x) => x.n === view)) view = 'all';
  ui.cx.view = view;
  ui.cx.check = path && view !== 'all' ? path : null;
  if (path) { ui.cx.sel = path; for (const p of [...ui.cx.collapsed]) if (path.startsWith(p + '/')) ui.cx.collapsed.delete(p); }
  go(ui.job, 'changes');
}
// The divider between the tree and the diff: dragged with the pointer, Arrow Left and Right with
// the keyboard; the width (--tree-w on the page) is kept for the page's life.
let treeW = 320;
function treeWidth(width) {
  treeW = Math.round(width);
  document.documentElement.style.setProperty('--tree-w', `${treeW}px`);
}
function onDividerDown(ev) {
  const d = typeof ev.target?.closest === 'function' ? ev.target.closest('#vdiv') : null; if (!d) return;
  d.setPointerCapture?.(ev.pointerId); d.classList.add('drag');
  const move = (e) => { const r = $('scrChanges').getBoundingClientRect(); treeWidth(Math.max(200, Math.min(r.width - 360, e.clientX - r.left))); };
  const up = () => { d.classList.remove('drag'); d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up); };
  d.addEventListener('pointermove', move); d.addEventListener('pointerup', up);
}
function dividerKey(ev) {
  const tree = document.querySelector('#scrChanges .tree');
  const w = typeof tree?.getBoundingClientRect === 'function' ? tree.getBoundingClientRect().width : treeW;
  treeWidth(Math.max(200, w + (ev.key === 'ArrowLeft' ? -32 : 32)));
}

// One review item as a list entry: the path as code, the problem, and what is expected.
function itemEntry(item, expected = true) {
  const entry = el('li');
  if (typeof item.id === 'string') {
    entry.append(document.createTextNode(`${item.id} `));
  }
  entry.append(el('code', '', item.path), document.createTextNode(`: ${item.problem}${expected ? ` Expected: ${item.expected}` : ''}`));
  return entry;
}

// ---------- The Merge request screen: the old MR view until SF-080 ----------

// The MR text as it is copied: the title line, a blank line and the body.
function mrCopyText(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const body = lines.slice(1).join('\n').replace(/^(\s*\n)+/, '').trimEnd();
  return body === '' ? lines[0] : `${lines[0]}\n\n${body}`;
}

async function showMr() {
  const key = state.key;
  renderUnapplied(state.detail);
  if (!state.detail?.mr) {
    state.mrText = null;
    $('mr-panel').hidden = true;
    $('no-mr').hidden = false;
    return;
  }
  let text;
  let failure = null;
  try {
    text = await getText(`api/jobs/${jobPath(key)}/mr`);
  } catch (error) {
    failure = error;
  }
  if (key !== state.key) {
    return;
  }
  state.mrText = failure === null ? text : null;
  $('mr-body').replaceChildren(...renderReport(failure === null ? text : `Could not load: ${failure.message}`));
  $('mr-copy').disabled = failure !== null;
  $('mr-panel').hidden = false;
  $('no-mr').hidden = true;
}

// The Codex items the user accepted the change without (SF-047), for a follow-up ticket.
function renderUnapplied(detail) {
  const override = detail === null ? null : standingOverride(detail);
  $('mr-unapplied').hidden = override === null;
  if (override === null) {
    $('mr-unapplied-list').replaceChildren();
    return;
  }
  const items = Array.isArray(override.unapplied) ? override.unapplied : [];
  $('mr-unapplied-note').textContent = typeof override.unapplied === 'string'
    ? `You accepted the change over the gate (${override.code}); the gate failed: ${override.unapplied}`
    : `You accepted the change over the gate (${override.code}); ${items.length === 0 ? 'the gate left no item.' : 'these could go into a follow-up ticket:'}`;
  $('mr-unapplied-list').replaceChildren(...items.map((item) => itemEntry(item)));
}

// Copies text; without the clipboard it shows the text in box, selected for Ctrl+C. say tells the
// user which.
function copyValue(text, box, say) {
  const select = () => {
    box.value = text;
    box.hidden = false;
    box.focus();
    box.select();
    say('Selected: press Ctrl+C to copy.');
  };
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
    select();
    return;
  }
  navigator.clipboard.writeText(text).then(() => say('Copied.'), select);
}

// ---------- The Stream (SF-078): SF-082's entries, as the prototype's renderStream and entryHtml ----------

// Who an entry is of, as the prototype names them.
const WHO = { implementer: 'Implementer', claude: 'Claude review', codex: 'Codex gate', mr: 'MR writer', factory: 'Factory', you: 'You' };
const STATE_WORD = {
  starting: 'Starting', working: 'Implementing', awaiting_review: 'In review', preparing_mr: 'Writing the MR', needs_human: 'Waiting for you',
  ready_for_human_review: 'Ready for you', handed_over: 'Handed over to your checkout', paused: 'Paused by you', pushed: 'Pushed', aborted: 'Aborted', failed: 'Failed',
};
// The line of a state change that is not a stop.
const STATE_TEXT = (entry) => {
  if (entry.to === 'awaiting_review') {
    return 'The Implementer finished; the reviews start';
  }
  if (entry.to === 'working' && entry.from === 'awaiting_review') {
    return 'Codex asked for fixes; back to the Implementer';
  }
  if (entry.to === 'working') {
    return 'The Implementer starts';
  }
  if (entry.to === 'preparing_mr') {
    return 'Both reviews clean; the MR text is being written';
  }
  if (entry.to === 'ready_for_human_review') {
    return 'Ready for you';
  }
  if (entry.to === 'pushed') {
    return 'Pushed';
  }
  return STATE_WORD[entry.to] ?? entry.to;
};
// A text entry longer than this many lines is clamped, with "Show all N lines".
const CLAMP_LINES = 8;
// A changes entry links this many files, then "and N more".
const SHOWN_FILES = 14;

// A path as its folder and its file name ('' without a folder).
const splitPath = (path) => {
  const at = path.lastIndexOf('/');
  return at < 0 ? ['', path] : [path.slice(0, at), path.slice(at + 1)];
};

// A path that opens the Changes screen at that file and iteration (the prototype's pathLink).
function pathLink(path, it) {
  const text = String(path ?? '');
  const [dir, name] = splitPath(text);
  const node = button('pathlink', '', { cfile: text, cit: it ? String(it) : '' });
  node.setAttribute('title', `Open ${text} in Changes${it ? ` at iteration ${it}` : ''}`);
  if (dir !== '') {
    node.append(el('span', 'd', `${dir}/`));
  }
  node.append(name);
  return node;
}

// Text with `code`, **bold** and Markdown headings (the prototype's prose), as nodes.
function prose(text) {
  const nodes = [];
  String(text ?? '').split('\n').forEach((line, index) => {
    if (index > 0) {
      nodes.push(document.createTextNode('\n'));
    }
    if (/^#{1,4} /.test(line)) {
      nodes.push(el('span', 'h', line));
      return;
    }
    for (const part of line.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
      if (/^`[^`\n]+`$/.test(part)) {
        nodes.push(el('code', '', part.slice(1, -1)));
      } else if (/^\*\*[^*\n]+\*\*$/.test(part)) {
        nodes.push(el('b', '', part.slice(2, -2)));
      } else if (part !== '') {
        nodes.push(document.createTextNode(part));
      }
    }
  });
  return nodes;
}

// The tool's line: its verb, the rest, and once its result came, "→ <out>" (.bad on a failure).
function toolLine(entry) {
  const line = String(entry.line ?? '');
  const at = line.indexOf(' ');
  const nodes = [el('span', 'verb', at < 0 ? line : line.slice(0, at)), document.createTextNode(at < 0 ? '' : ` ${line.slice(at + 1)}`)];
  if (entry.res !== undefined) {
    nodes.push(document.createTextNode(' '), el('span', entry.res.err ? 'out bad' : 'out', `→ ${entry.res.out}`));
  }
  return nodes;
}

// A finding's severity as its pill (.sev-<severity>); an item without one reads as major.
function severityTag(value) {
  const severity = String(value ?? 'major');
  return el('span', `sev sev-${/^[a-z]+$/.test(severity) ? severity : 'major'}`, severity);
}

// A finding of a verdict or a Fix section: its ledger id (or #n), severity, path, problem and what
// is expected.
function findingHtml(item, index, it) {
  const node = el('li', 'finding');
  node.append(el('span', 'fid', typeof item.id === 'string' && item.id !== '' ? item.id : `#${index + 1}`), severityTag(item.severity), pathLink(item.path, it));
  const problem = el('div', 'problem');
  problem.append(...prose(item.problem));
  node.append(problem);
  if (typeof item.expected === 'string' && item.expected !== '') {
    const expected = el('div', 'expected');
    expected.append('Expected: ', ...prose(item.expected));
    node.append(expected);
  }
  return node;
}

// The items of a Fix section as the factory writes them (fixItemLine, src/ledger.ts): one line each,
// "1. [R1, major] `path`: problem Expected: expected".
function fixItems(text) {
  const items = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\d+\. \[(R\d+), (\w+)\] `([^`]*)`: (.*)$/.exec(line);
    if (match !== null) {
      const [problem, ...expected] = match[4].split(' Expected: ');
      items.push({ id: match[1], severity: match[2], path: match[3], problem, expected: expected.join(' Expected: ') });
    }
  }
  return items;
}

// A toggle of an entry (data-toggle: the entry's key, or "<key>/task", "<key>/report").
const toggleButton = (key, text) => button('linkish', text, { toggle: key });

// The changes entry: the iteration's files as path links, Open these changes (c) and its Report.
function changesEntry(entry) {
  const block = el('div', 'block');
  const paths = Array.isArray(entry.paths) ? entry.paths : [];
  const head = el('div', 'bh', `Iteration ${entry.it} ended: ${counted(typeof entry.files === 'number' ? entry.files : paths.length, 'file')} changed`);
  const open = button('btn small', 'Open these changes ', { changes: String(entry.it) });
  open.append(el('span', 'kbd', 'c'));
  head.append(el('span', 'grow'), open);
  const links = el('div', 'flinks');
  links.append(...paths.slice(0, SHOWN_FILES).map((path) => pathLink(path, entry.it)));
  if (paths.length > SHOWN_FILES) {
    links.append(button('linkish', `and ${paths.length - SHOWN_FILES} more`, { changes: String(entry.it) }));
  }
  const report = `${entry.k}/report`;
  const shown = ui.open.has(report);
  const toggleRow = el('div');
  toggleRow.append(toggleButton(report, shown ? 'Hide the Report' : 'Report'));
  block.append(head, links, toggleRow);
  if (shown) {
    const text = state.cache.get(`${entry.it}/report`);
    const pre = el('pre', 'raw doc');
    pre.append(...(text === undefined ? [document.createTextNode('Loading the Report…')] : renderReport(text)));
    block.append(pre);
  }
  return block;
}

// The implement prompt's Task: the Task file and its last check, from the sources of the old Task
// tab, once per job and Fix section.
async function loadTaskView() {
  const key = state.key;
  const job = state.detail?.job ?? jobByKey(key);
  const stamp = `${key}#${job?.fixes ?? 0}#${job?.iteration ?? 0}`;
  if (key === null || state.taskView?.stamp === stamp) {
    return;
  }
  const view = { stamp, text: null, check: null };
  state.taskView = view;
  let text;
  try {
    text = await getText(`api/tickets/${jobPath(key)}/task`);
  } catch (error) {
    // The ticket may have been archived since the job started.
    try {
      text = await getText(`api/tickets/${jobPath(key)}/task?archived=1`);
    } catch {
      text = `Could not load the Task file: ${error.message}`;
      // The next toggle tries again.
      view.stamp = null;
    }
  }
  view.check = await readCheck(key);
  view.text = text;
  if (state.key === key && state.taskView === view) {
    redrawWhere((entry) => entry.t === 'prompt' && entry.kind === 'implement');
  }
}

// A prompt: the Fix section with its items, or a line with the prompt behind a toggle (and the Task
// behind another for the implement prompt); "Continue where you stopped." as a factory line.
function promptBody(entry, open) {
  const changed = entry.task_changed === true ? [document.createTextNode(' '), el('span', 'muted fs12', "with the Task file's change")] : [];
  if (entry.kind === 'continue') {
    const line = el('div', '', 'Continue where you stopped.');
    line.append(...changed);
    return [line];
  }
  if (entry.kind === 'fix') {
    const items = fixItems(entry.fix);
    const block = el('div', 'block fixsec');
    const head = el('div', 'bh', `Fix ${entry.fix_n} sent to the Implementer `);
    head.append(el('span', 'muted light', counted(items.length, 'item')), ...changed);
    const intro = el('div', 'summary');
    intro.append(...prose(String(entry.fix ?? '').split(/\n\d+\. \[R/)[0].trim()));
    const list = el('ul', 'findings');
    list.append(...items.map((item, index) => findingHtml(item, index, entry.it)));
    block.append(head, intro, list, toggleButton(entry.k, open ? 'Hide the full prompt' : 'Show the full prompt'));
    if (open) {
      block.append(el('pre', 'raw', entry.text));
    }
    return [block];
  }
  const what = { implement: 'The Implementer got the Task file', mr: 'MR preparation started', conflict: 'The Implementer is asked to resolve the rebase conflict' }[entry.kind] ?? 'Prompt';
  const line = el('div');
  line.append(el('b', '', what), ' ', el('span', 'mono muted fs12', entry.first ?? ''), ' ', toggleButton(entry.k, open ? 'hide prompt' : 'prompt'));
  const task = `${entry.k}/task`;
  if (entry.kind === 'implement') {
    line.append(' ', toggleButton(task, ui.open.has(task) ? 'hide Task' : 'Task'));
  }
  line.append(...changed);
  const nodes = [line];
  if (open) {
    nodes.push(el('pre', 'raw', entry.text));
  }
  if (entry.kind === 'implement' && ui.open.has(task)) {
    const view = state.taskView;
    if (view === null || view.text === null) {
      nodes.push(el('div', 'muted', 'Loading the Task file…'));
    } else {
      if (view.check !== null) {
        const check = el('div', 'task-check');
        check.append(...renderCheck(view.check));
        nodes.push(check);
      }
      const text = el('pre', 'raw doc');
      text.append(...renderReport(view.text));
      nodes.push(text);
    }
  }
  return nodes;
}

// A verdict of the Claude review or the Codex gate: the pill, the count, the summary (clamped) and
// the findings.
function verdictBody(entry, open) {
  const items = Array.isArray(entry.items) ? entry.items : [];
  const effective = entry.effective ?? entry.verdict;
  const block = el('div', open ? 'block' : 'block clamp');
  const head = el('div', 'bh', `${entry.who === 'codex' ? 'Codex gate' : 'Claude review'} · iteration ${entry.it} `);
  head.append(el('span', `verdict ${effective === 'clean' ? 'clean' : 'fix'}`, effective === 'clean' ? 'clean' : 'asks for fixes'),
    el('span', 'muted light', items.length > 0 ? counted(items.length, entry.who === 'codex' ? 'finding' : 'note') : 'no findings'));
  block.append(head);
  if (typeof entry.summary === 'string' && entry.summary !== '') {
    const summary = el('div', 'summary');
    summary.append(...prose(entry.summary));
    block.append(summary, toggleButton(entry.k, open ? 'Show less' : 'Show the whole summary'));
  }
  if (items.length > 0) {
    const list = el('ul', 'findings');
    list.append(...items.map((item, index) => findingHtml(item, index, entry.it)));
    block.append(list);
  }
  return block;
}

// The suggestions of a simplification pass, as findings: the path, what, why and the lines it saves.
function suggestionItems(suggestions, it) {
  const list = el('ul', 'findings');
  list.append(...suggestions.map((item, index) => {
    const node = el('li', 'finding');
    node.append(el('span', 'fid', `#${index + 1}`), pathLink(item.path, it));
    const what = el('div', 'problem');
    what.append(...prose(item.what));
    const why = el('div', 'expected');
    why.append('Why: ', ...prose(item.why));
    node.append(what, why, el('div', 'expected', `saves about ${counted(Number(item.saves_lines) || 0, 'line')}`));
    return node;
  }));
  return list;
}

// The note typed on a ledger entry, per job: ledger ids (R1, R2, …) start again in every job.
const noteKey = (id) => `${state.key}/${id}`;

// One ledger entry of a stop: the id, severity, path and problem, what the Implementer said, a
// dispute's reason, and Accept risk / Must fix with a note; a settled one shows its decision.
function ledgerFinding(entry, busy) {
  const node = el('li', 'finding');
  node.dataset.id = entry.id;
  node.append(el('span', 'fid', entry.id), severityTag(entry.severity), pathLink(entry.path, entry.iteration > 0 ? entry.iteration : null));
  const problem = el('div', 'problem');
  problem.append(...prose(entry.problem));
  node.append(problem);
  if (entry.status === 'escalated') {
    node.append(el('div', 'expected', `The Implementer asks: ${entry.response}`));
  } else if (entry.status === 'contested' || (entry.dispute !== null && entry.dispute !== undefined)) {
    node.append(el('div', 'expected', `The Implementer contests it: ${entry.response}`), el('div', 'expected', `Evidence: ${entry.evidence || 'none given'}`));
    if (entry.dispute !== null && entry.dispute !== undefined) {
      node.append(el('div', 'expected', `${entry.dispute.reviewer === 'codex' ? 'Codex' : 'Claude'} reopens it: ${entry.dispute.reason}`));
    }
  } else {
    node.append(el('div', 'expected', `Expected: ${entry.expected}`));
  }
  const decide = el('div', 'decide');
  if (entry.settled !== null && entry.settled !== undefined) {
    decide.append(el('span', 'decided', entry.settled.decision === 'accept' ? 'Accepted risk' : 'Must fix'));
    if (entry.settled.note) {
      decide.append(el('span', 'muted', entry.settled.note));
    }
  } else if (entry.status === 'escalated' || entry.status === 'contested') {
    const note = el('input', 'note');
    note.type = 'text';
    note.placeholder = 'Note (optional)';
    note.value = state.notes.get(noteKey(entry.id)) ?? '';
    note.dataset.note = entry.id;
    note.setAttribute('aria-label', `Note on ${entry.id}`);
    decide.append(note);
    for (const [text, decision] of [['Accept risk', 'accept'], ['Must fix', 'fix']]) {
      const choice = button('btn small', text, { settle: `${entry.id}:${decision}` });
      choice.disabled = busy !== '';
      if (busy !== '') {
        choice.setAttribute('title', busy);
      }
      decide.append(choice);
    }
  } else {
    return node;
  }
  node.append(decide);
  return node;
}

// The ledger entries of a ledger stop: those to settle, the open ones of a churn stop, and the
// ones settled since the stop (with their decision), in ledger order.
function stopLedger(detail, code, since) {
  const keep = new Set([...settleable(detail), ...(code === 'review_churn' ? ledgerOpen(detail) : [])]);
  return (detail.ledger ?? []).filter((entry) => keep.has(entry) || (entry.settled !== null && entry.settled !== undefined && typeof since === 'string' && entry.settled.at >= since));
}

// What the stop block shows for its code (the Task's table): the suggestions, the entries to
// settle, the findings, the gate's tokens, an error or the message.
function stopInline(job, detail, entry) {
  const code = typeof job.error?.code === 'string' ? job.error.code : '';
  const message = typeof job.error?.message === 'string' ? job.error.message : '';
  const whole = () => (message === '' ? [] : [el('pre', 'raw', message)]);
  const last = detail === null ? null : iterationOf(detail, job.iteration);
  const findings = (items) => {
    const list = el('ul', 'findings');
    list.append(...items.map((item, index) => findingHtml(item, index, job.iteration)));
    return items.length === 0 ? [] : [list];
  };
  if (usageLimited(job)) {
    return whole();
  }
  switch (STOP_ALIASES[code] ?? code) {
    case SIMPLIFY_CODE: {
      const items = detail === null ? (job.stop?.items ?? []) : offeredSuggestions(detail).items;
      return items.length === 0 ? [] : [suggestionItems(items, job.iteration)];
    }
    case 'escalated':
    case 'review_disputed':
    case 'review_churn': {
      if (detail === null) {
        return [];
      }
      const entries = stopLedger(detail, code, entry.ts);
      if (entries.length === 0) {
        return [el('div', 'muted', 'No ledger entry is left to settle.')];
      }
      const busy = availability('settle', detail.job);
      const list = el('ul', 'findings');
      list.append(...entries.map((item) => ledgerFinding(item, busy)));
      return [list];
    }
    case 'gate_rounds':
      return findings(Array.isArray(last?.gate?.items) ? last.gate.items : (job.stop?.items ?? []));
    case 'gate_budget':
      return [el('div', '', `The Codex gate used ${typeof job.gate_tokens === 'number' ? job.gate_tokens.toLocaleString('en-US') : 'its'} tokens.`)];
    case 'iteration_limit':
      return findings([...(last?.review?.items ?? []), ...(last?.gate?.items ?? [])]);
    case 'gate_failed':
      return typeof last?.gate?.error === 'string' ? [el('pre', 'raw', last.gate.error)] : whole();
    case 'review_failed':
      return typeof last?.review?.error === 'string' ? [el('pre', 'raw', last.review.error)] : whole();
    case 'mr_conflict': {
      const files = /conflicts in (.+?);/.exec(message)?.[1];
      if (files === undefined) {
        return whole();
      }
      const list = el('div', 'flinks');
      list.append(...files.split(', ').map((path) => el('span', 'mono fs12', path)));
      return [list];
    }
    case 'worktree_remove_failed':
      return typeof job.worktree === 'string' ? [el('div', 'mono fs12', job.worktree)] : whole();
    case 'max_turns':
    case 'serve_restarted':
    case 'mr_serve_restarted':
    case 'publish_failed':
    case 'mr_empty':
    case 'mr_push_protected':
      return [];
    default:
      return whole();
  }
}

// A needs_human state entry: the stop block. The live one (the last, while the job waits) also has
// the sentence and what its code needs; an earlier one its message. A decision is labelled "Your
// decision", never as an error.
function stopBlock(entry, live) {
  const job = live ? shownJob() : null;
  const stop = stopEntry(job ?? { error: { code: entry.code ?? '', message: entry.msg ?? '' } });
  const block = el('div', 'block stop');
  const head = el('div', 'bh');
  head.append(el('span', stop.kind === 'decision' ? 'verdict fix' : 'verdict stop', stop.kind === 'decision' ? 'Your decision' : 'Stopped'), stop.reason);
  if (typeof entry.code === 'string') {
    head.append(el('span', 'tag', entry.code));
  }
  block.append(head);
  if (job === null) {
    if (typeof entry.msg === 'string' && entry.msg !== '') {
      block.append(el('div', 'muted', entry.msg));
    }
    return block;
  }
  block.id = 'stopblock';
  const detail = shownDetail();
  block.append(el('div', '', stop.sentence(job)), ...stopInline(job, detail, entry));
  return block;
}

// The body of one entry.
function entryBody(entry, open) {
  switch (entry.t) {
    case 'tool': {
      const line = button('line', '', { toggle: entry.k });
      line.setAttribute('title', entry.res === undefined ? String(entry.line ?? '') : `${entry.line}  → ${entry.res.out}`);
      line.append(...toolLine(entry));
      if (!open) {
        return [line];
      }
      const more = el('div', 'more');
      more.append(el('span', 'lbl', 'Input'), el('pre', '', String(entry.detail ?? '')));
      if (entry.res !== undefined) {
        more.append(el('span', 'lbl', 'Output'), el('pre', '', entry.res.result));
      }
      return [line, more];
    }
    case 'text': {
      const text = String(entry.text ?? '');
      const lines = text.split('\n').length;
      const body = el('div', 'prose');
      if (entry.who === 'codex' && /^\[withheld/.test(text)) {
        body.append(el('span', 'muted', '(message withheld by the factory)'));
      } else {
        body.append(...prose(text));
      }
      return lines > CLAMP_LINES ? [body, toggleButton(entry.k, open ? 'Show less' : `Show all ${lines} lines`)] : [body];
    }
    case 'result':
      return [['Turn ended', typeof entry.turns === 'number' ? counted(entry.turns, 'turn') : null, typeof entry.ms === 'number' ? dur(entry.ms) : null,
        `session ${money(entry.cost)}`].filter((part) => part !== null).join(' · ')];
    case 'state': {
      if (entry.to === 'needs_human') {
        return [stopBlock(entry, entry.k === stopKey())];
      }
      const nodes = [el('b', '', STATE_TEXT(entry)), el('span', 'tag', `${entry.from ?? '–'} → ${entry.to}`)];
      if (typeof entry.msg === 'string' && entry.msg !== '') {
        nodes.push(el('span', '', entry.msg));
      }
      return nodes;
    }
    case 'prompt':
      return promptBody(entry, open);
    case 'verdict':
      return [verdictBody(entry, open)];
    case 'changes':
      return [changesEntry(entry)];
    case 'simplify': {
      const suggestions = Array.isArray(entry.suggestions) ? entry.suggestions : [];
      const block = el('div', 'block');
      const head = el('div', 'bh', `Simplification pass · iteration ${entry.it} `);
      head.append(el('span', 'muted light', suggestions.length > 0 ? `${counted(suggestions.length, 'suggestion')}, saves about ${counted(entry.saves_lines ?? 0, 'line')}` : 'no suggestion'));
      block.append(head);
      if (suggestions.length > 0) {
        block.append(suggestionItems(suggestions, entry.it));
      }
      return [block];
    }
    case 'user': {
      const block = el('div', 'block you');
      const text = el('div', 'prose');
      text.append(...prose(entry.text));
      block.append(text);
      if (entry.task_changed === true) {
        block.append(el('span', 'muted fs12', "with the Task file's change"));
      }
      return [block];
    }
    default:
      // note, and any type the page does not know: its text.
      return [String(entry.text ?? '')];
  }
}

// One entry as li.e.e-<t>.who-<who>: the local time, who (hidden when the same author goes on) and
// the body. Returns the node and its label.
function entryHtml(entry, prevWho) {
  const open = ui.open.has(entry.k);
  const who = typeof entry.who === 'string' && Object.hasOwn(WHO, entry.who) ? entry.who : 'factory';
  const label = entry.t === 'state' ? 'State' : entry.t === 'prompt' ? 'Factory' : WHO[who];
  const cont = prevWho === label && ['tool', 'text', 'result'].includes(entry.t);
  const lines = entry.t === 'text' ? String(entry.text ?? '').split('\n').length : 0;
  const node = el('li', `e e-${/^[a-z_]+$/.test(String(entry.t)) ? entry.t : 'note'} who-${who}${open ? ' open' : ''}${entry.res?.err ? ' err' : ''}${!open && lines > CLAMP_LINES ? ' clamp' : ''}`);
  node.dataset.k = entry.k;
  const body = el('div', 'body');
  body.append(...entryBody(entry, open));
  node.append(el('span', 'ts', clock(entry.ts)), el('span', cont ? 'who cont' : 'who', label), body);
  return { node, label };
}

// The separator before a prompt: "Iteration N" (with the Fix N tag) or "MR preparation". A Fix
// section's it is the iterations published when it was sent, so its work is iteration it + 1. A
// continue prompt goes on in its iteration, without one.
function sepFor(entry) {
  const sep = el('li', 'sep', entry.kind === 'mr' || entry.kind === 'conflict' ? 'MR preparation' : `Iteration ${entry.kind === 'fix' ? entry.it + 1 : entry.it}`);
  if (entry.kind === 'fix') {
    sep.append(' ', el('span', 'tag', `Fix ${entry.fix_n}`));
  }
  return sep;
}

// The nodes of the next entry of the Stream: its separator, if any, and its li.
function streamItems(entry) {
  const nodes = [];
  if (entry.t === 'prompt' && entry.kind !== 'continue') {
    nodes.push(sepFor(entry));
    state.prevLabel = null;
  }
  state.labels.set(entry.k, state.prevLabel);
  const { node, label } = entryHtml(entry, state.prevLabel);
  state.prevLabel = label;
  nodes.push(node);
  return nodes;
}

// The whole Stream of the open job.
function renderStream() {
  state.prevLabel = null;
  state.labels.clear();
  $('stream').replaceChildren(...state.entries.flatMap(streamItems));
  state.stopSig = stopSignature();
  markSel(false);
}

// The li of an entry in the Stream, by its key.
const entryNode = (k) => [...$('stream').children].find((node) => node.nodeType === 1 && node.dataset.k === k) ?? null;

// One entry drawn again in place (a joined result, a toggle, the stop).
function redrawEntry(entry) {
  const old = entryNode(entry.k);
  if (old !== null) {
    old.replaceWith(entryHtml(entry, state.labels.get(entry.k) ?? null).node);
  }
}

// The entries that pass test drawn again, the scroll and the selection kept.
function redrawWhere(test) {
  keepScroll(() => state.entries.filter(test).forEach(redrawEntry));
  markSel(false);
}

// The open job's own job object: the jobs payload's (it has the stop's numbers), else the detail's.
function shownJob() {
  if (ui.job === null) {
    return null;
  }
  return jobByKey(ui.job) ?? shownDetail()?.job ?? null;
}

// The detail of the job on its page; null while it has not arrived.
function shownDetail() {
  return ui.job !== null && state.detail !== null && keyOf(state.detail.job) === ui.job ? state.detail : null;
}

// The key of the live stop: the last needs_human state entry while the job waits; else null.
function stopKey() {
  if (shownJob()?.state !== 'needs_human') {
    return null;
  }
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry.t === 'state' && entry.to === 'needs_human') {
      return entry.k;
    }
  }
  return null;
}

// What the stop block shows depends on; it is drawn again only when this changed, so a note being
// typed stays.
function stopSignature() {
  const job = shownJob();
  const detail = state.detail;
  const last = detail === null ? null : iterationOf(detail, detail.job.iteration);
  return JSON.stringify([stopKey(), job?.state, job?.error, job?.stop, job?.gate_tokens, job?.worktree, job?.iteration, detail?.ledger, last?.simplify, last?.review, last?.gate,
    detail === null ? '' : availability('settle', detail.job)]);
}

// The stop blocks drawn again when what they show changed.
function refreshStop() {
  const signature = stopSignature();
  if (signature !== state.stopSig) {
    state.stopSig = signature;
    redrawWhere((entry) => entry.t === 'state' && entry.to === 'needs_human');
  }
}

// The tool a result belongs to: the last tool entry with its id; null when the page has not seen it.
function toolOf(id) {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry.t === 'tool' && entry.id === id) {
      return entry;
    }
  }
  return null;
}

// Takes the entries of a page or of a live event, alike: an entry whose k is shown is ignored; a
// tool_result joins its tool by id (dropped without it). Returns the entries added and the tools
// that got their result.
function takeEntries(list) {
  const added = [];
  const joined = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.k !== 'string' || state.seen.has(entry.k)) {
      continue;
    }
    state.seen.add(entry.k);
    if (entry.t === 'tool_result') {
      const tool = typeof entry.id === 'string' && entry.id !== '' ? toolOf(entry.id) : null;
      if (tool !== null) {
        tool.res = { out: String(entry.out ?? ''), result: String(entry.result ?? ''), err: entry.err === true };
        if (!joined.includes(tool) && !added.includes(tool)) {
          joined.push(tool);
        }
      }
      continue;
    }
    state.entries.push(entry);
    added.push(entry);
  }
  return { added, joined };
}

// The Stream after new entries: appended, the joined tools drawn again, the stop moved; the view
// stays at the bottom only when it was at the bottom.
function showEntries(list) {
  const { added, joined } = takeEntries(list);
  if (added.length === 0 && joined.length === 0) {
    return;
  }
  const wrap = $('streamwrap');
  const bottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 8;
  $('stream').append(...added.flatMap(streamItems));
  joined.forEach(redrawEntry);
  if (added.some((entry) => entry.t === 'state')) {
    state.stopSig = null;
  }
  refreshStop();
  markSel(false);
  if (bottom) {
    wrap.scrollTop = wrap.scrollHeight;
  }
  // A card's button that points at the stop waits for its block.
  applyWantedFocus();
}

// Reads the job's Stream page by page from line 0, then follows it live from the last next. A page
// that cannot be read leaves the rest to the live stream, which sends every line from there.
async function loadStream(key) {
  const token = {};
  state.streamLoad = token;
  for (;;) {
    let page;
    try {
      page = JSON.parse(await getText(`api/jobs/${jobPath(key)}/stream?from=${state.lastLine}`));
    } catch {
      page = null;
    }
    if (state.streamLoad !== token || state.key !== key) {
      return;
    }
    if (page === null) {
      break;
    }
    showEntries(page.entries);
    const next = Number(page.next);
    const moved = Number.isInteger(next) && next > state.lastLine;
    if (moved) {
      state.lastLine = next;
    }
    if (page.end === true || !moved) {
      break;
    }
  }
  state.streamLoad = null;
  openStream();
  if (ui.screen === 'stream' && ui.job === key) {
    const wrap = $('streamwrap');
    wrap.scrollTop = wrap.scrollHeight;
  }
}

// The entries of the Stream, in order (the prototype's entries()).
const entries = () => [...$('stream').children].filter((node) => node.nodeType === 1 && node.classList.contains('e'));

// The selected entry (j, k, G, a click) marked .sel.
function markSel(scroll) {
  const all = entries();
  all.forEach((node) => node.classList.remove('sel'));
  if (ui.sel >= 0 && all[ui.sel] !== undefined) {
    all[ui.sel].classList.add('sel');
    if (scroll) {
      all[ui.sel].scrollIntoView({ block: 'nearest' });
    }
  }
}

// Runs work (a redraw) with the Stream's scroll position kept.
function keepScroll(work) {
  const wrap = $('streamwrap');
  const top = wrap.scrollTop;
  work();
  wrap.scrollTop = top;
}

// A toggle of an entry: its Input and Output, all its lines, the whole summary, the full prompt, the
// Task or the Report.
function toggle(key) {
  if (ui.open.has(key)) {
    ui.open.delete(key);
  } else {
    ui.open.add(key);
  }
  const [k, part] = key.split('/');
  const entry = state.entries.find((candidate) => candidate.k === k);
  if (entry === undefined) {
    return;
  }
  redrawWhere((candidate) => candidate === entry);
  if (part === 'task' && ui.open.has(key)) {
    void loadTaskView();
  } else if (part === 'report' && ui.open.has(key) && state.key !== null) {
    const shown = state.key;
    void iterationText(shown, entry.it, 'report').then((text) => {
      if (text !== undefined && state.key === shown) {
        redrawWhere((candidate) => candidate === entry);
      }
    });
  }
}

// ---------- The header (SF-078, the prototype's renderHead) ----------

// Draws a part of the job page again (the header, the composer's actions: on every jobs event,
// every 15 s while the job runs) and keeps the focus on the button it was on.
function keepFocus(container, work) {
  const active = document.activeElement;
  const data = active !== null && active !== undefined && container.contains(active) ? active.dataset ?? {} : {};
  const name = ['act', 'goto', 'back', 'copyBranch', 'tk', 'tktab'].find((key) => data[key] !== undefined);
  work();
  if (name !== undefined) {
    const attribute = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    [...container.querySelectorAll(`[data-${attribute}]`)].find((node) => node.dataset[name] === data[name])?.focus();
  }
}

// ← Board (Esc), the key, the title and the code of a stop; the switch Stream (s), Changes (N) (c)
// and Merge request (m); the sentence with the state's dot, the iteration, the cost, the time and
// the branch, which copies its checkout command.
function renderHead() {
  const job = shownJob();
  if (job === null) {
    return;
  }
  $('job').className = `st-${job.state}`;
  const backButton = button('btn back', '← Board', { back: '' });
  backButton.setAttribute('title', 'Back to the board (Esc)');
  const t1 = el('div', 't1');
  const title = el('span', 'title', titleOf(job));
  title.setAttribute('title', titleOf(job));
  t1.append(el('span', 'key', job.ticket), wsChip(job.workspace), title);
  if (job.state === 'needs_human' && typeof job.error?.code === 'string') {
    t1.append(el('span', 'tag', job.error.code));
  }
  const switcher = el('div', 'switch');
  switcher.setAttribute('role', 'tablist');
  switcher.setAttribute('aria-label', 'Job screens');
  const mrOk = mrAvailable();
  for (const [screen, text, key] of [['stream', 'Stream', 's'], ['changes', typeof job.files === 'number' ? `Changes (${job.files})` : 'Changes', 'c'], ['mr', 'Merge request', 'm']]) {
    const tab = button(ui.screen === screen ? 'on' : '', `${text} `, { goto: screen });
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(ui.screen === screen));
    tab.append(el('span', 'kbd', key));
    if (screen === 'mr') {
      tab.setAttribute('aria-disabled', String(!mrOk));
      tab.setAttribute('title', mrOk ? 'The merge request text' : 'No MR text yet: written at Clean');
    }
    switcher.append(tab);
  }
  const tools = el('div', 'tools');
  tools.append(switcher);
  const running = RUNNING.includes(job.state);
  const t2 = el('div', 't2');
  const line = el('span', 'sentence');
  line.append(el('span', 'dot'), document.createTextNode(headSentence(job)));
  const branch = button('mono fs12 branch', job.branch, { copyBranch: '' });
  branch.setAttribute('title', `Copy the checkout command: git checkout ${job.branch}`);
  const end = running ? Date.now() : Date.parse(job.updated_at);
  t2.append(line, el('span', '', `Iteration ${shownIteration(job)}${job.state === 'working' || job.state === 'starting' ? ' (running)' : ''}`),
    el('span', '', `${money(job.cost_usd)}${running ? ' so far' : ''} (Claude, est.)`), el('span', '', `${dur(end - Date.parse(job.created_at))} elapsed`), branch);
  // SF-084: what the ticket waits for, who waits for it, and a cycle it is part of.
  t2.append(...dependencyLines(keyOf(job), dependencyGraph(), 'span').lines);
  keepFocus($('jhead'), () => $('jhead').replaceChildren(backButton, t1, tools, t2));
}

// The job has its MR text (written at Clean): the Merge request screen applies.
const mrAvailable = () => shownDetail()?.mr === true;

// ---------- The composer (SF-078, the prototype's actionsFor and renderComposer) ----------

const SEND = { a: 'say', l: 'Send' };
const GO_ON = { a: 'goon', l: 'Tell it to go on' };
const ABORT = { a: 'abort', l: 'Abort…', d: true };
const RESTART = { a: 'restart', l: 'Restart…' };
const ARCHIVE = { a: 'archive', l: 'Archive' };

// The actions of a stopped job, by its code (the Task's table), primary first.
function stopActions(job, detail) {
  const accept = gateAcceptable(detail) ? [{ a: 'accept', l: 'Accept and prepare MR' }] : [];
  if (usageLimited(job)) {
    return [GO_ON, ABORT];
  }
  const code = typeof job.error?.code === 'string' ? job.error.code : '';
  switch (STOP_ALIASES[code] ?? code) {
    case SIMPLIFY_CODE:
      return [{ a: 'simplify', l: 'Simplify' }, { a: 'accept', l: 'Skip' }, SEND, ABORT];
    case 'escalated':
      return [SEND, ABORT];
    case 'review_disputed':
    case 'review_churn':
    case 'gate_rounds':
    case 'gate_budget':
      return [...accept, SEND, ABORT];
    case 'iteration_limit':
      return [SEND, RESTART, ABORT];
    case 'gate_failed':
      return [...accept, GO_ON, ABORT];
    case 'review_failed':
      return [{ a: 'review', l: 'Retry review' }, ABORT];
    case 'serve_restarted':
    case 'session_failed':
      return [GO_ON, RESTART, ABORT];
    case 'max_turns':
    case 'mr_serve_restarted':
    case 'sandbox_unavailable':
    case 'publish_failed':
    case 'mr_failed':
    case 'worktree_remove_failed':
      return [GO_ON, ABORT];
    case 'mr_conflict':
      return [{ a: 'say', l: 'Tell it how' }, ABORT];
    case 'mr_push_failed':
      return [{ a: 'approve', l: 'Push again' }, ABORT];
    case 'mr_push_protected':
      // Open the Merge request screen to rename the branch comes with SF-080.
      return [ABORT];
    default:
      return [SEND, ABORT];
  }
}

// The actions that apply to the job now, primary first ({ a: action, l: label, p: primary, d:
// danger }); a finished job has no primary.
function actionsFor(job, detail) {
  let list;
  switch (job.state) {
    case 'starting':
    case 'working':
    case 'awaiting_review':
      list = [SEND, { a: 'pause', l: 'Pause' }, ABORT];
      break;
    case 'preparing_mr':
      list = [ABORT];
      break;
    case 'paused':
      list = [{ a: 'resume', l: 'Resume' }, RESTART, ABORT];
      break;
    case 'ready_for_human_review':
      list = [{ a: 'approve', l: 'Approve…' }, { a: 'handover', l: ACTION_LABELS.handover }, ...(canCreateMr(job) ? [{ a: 'mr-create', l: 'Create merge request' }] : []), SEND, ABORT];
      break;
    case 'handed_over':
      // SF-073: the branch waits in the user's checkout; the message is Ask for changes (the
      // checkout's edits go with it).
      list = [{ a: 'approve', l: 'Approve…' }, { a: 'say', l: 'Ask for changes' }, { a: 'handed-done', l: ACTION_LABELS['handed-done'] }, { a: 'takeback', l: ACTION_LABELS.takeback },
        ...(canCreateMr(job) ? [{ a: 'mr-create', l: 'Create merge request' }] : []), ABORT];
      break;
    case 'needs_human':
      list = stopActions(job, detail);
      break;
    case 'pushed':
      return [...(canCreateMr(job) ? [{ a: 'mr-create', l: 'Create merge request' }] : []), ...(canMerge(job) ? [{ a: 'mr-merge', l: 'Merge…' }] : []),
        ...(hasMr(job) ? [{ a: 'mr-status', l: 'Refresh MR status' }] : []), ARCHIVE];
    case 'aborted':
    case 'failed':
      return [RESTART, ARCHIVE];
    default:
      list = [ABORT];
  }
  return list.map((action, index) => ({ ...action, p: index === 0 && action.d !== true }));
}

// The placeholder of the message box, per state.
const PLACEHOLDER = {
  starting: 'Message the Implementer; it reads it at its next step (Ctrl+Enter sends)',
  working: 'Message the Implementer; it reads it at its next step (Ctrl+Enter sends)',
  awaiting_review: 'Message the job; the Implementer reads it when the reviews end',
  needs_human: 'Or tell the Implementer what to do instead',
  ready_for_human_review: 'Ask the Implementer for a last change before you push',
  handed_over: 'Ask the Implementer for changes; the edits in your checkout go with it',
  preparing_mr: 'The factory takes no message while it writes the MR text',
};

// The composer: the sentence in bold (and the merge request of a pushed job), the inline
// confirmation, the message box and the actions; a disabled action has its reason as its title.
function renderComposer() {
  const job = state.detail?.job ?? null;
  // A confirmation opened before the doubt is not one the user could open now.
  if (state.confirm !== null && state.unresolved.has(state.confirm.key) && availability(state.confirm.action, job) !== '') {
    closeConfirm();
    return;
  }
  const msg = $('msg');
  $('refresh-button').hidden = state.unresolved.get(state.key)?.failed !== true;
  if (job === null) {
    $('composer-sentence').replaceChildren(el('span', 'muted', 'Loading the job…'));
    $('acts').replaceChildren();
    msg.disabled = true;
    return;
  }
  // The detail's job, with what only the jobs payload has (the stop's numbers).
  const cs = [el('b', '', `${headSentence({ ...(shownJob() ?? {}), ...job })}.`)];
  if (job.state === 'paused' && job.task_changed === true) {
    cs.push(el('span', 'muted', TASK_CHANGED));
  }
  // The hand-over (SF-073): why a job ready for review was not handed over; what a handed-over one takes.
  if (job.state === 'ready_for_human_review' && skippedNote(job) !== '') {
    cs.push(el('span', 'muted', skippedNote(job).trim()));
  }
  if (job.state === 'handed_over') {
    cs.push(el('span', 'muted', `Read, run and change it there. Approve pushes it; Ask for changes sends your edits and your message to the Implementer; Take it back returns it to the factory.${job.error ? ` ${job.error.code}: ${job.error.message}` : ''}`));
  }
  if (hasMr(job)) {
    const line = el('span', 'mr-line');
    line.id = 'mr-line';
    line.append(document.createTextNode(`Merge request #${job.mr.number} (${job.mr.state}): `), mrLink(job.mr));
    cs.push(line);
    // The status last read shows only while it is of the merge request the job shows now (the same
    // number and state): after a merge, a close or a new merge request it stays hidden.
    const read = state.mrStatus.get(keyOf(job));
    if (read !== undefined && read.number === job.mr.number && read.state === job.mr.state) {
      const status = el('span', 'muted', mrStatusText(read));
      status.id = 'mr-status-line';
      cs.push(status);
    }
  }
  const finished = TERMINAL_STATES.includes(job.state);
  if (finished) {
    cs.push(el('span', 'muted', 'The message box is hidden on a finished job.'));
  }
  $('composer-sentence').replaceChildren(...cs);
  msg.hidden = finished;
  msg.disabled = !(SAY_STATES.includes(job.state) || pausedTurn(job));
  msg.placeholder = job.state === 'paused' ? (pausedTurn(job) ? 'Resume sends this to the Implementer, if you write one' : 'Resume, then message the Implementer')
    : PLACEHOLDER[job.state] ?? 'Message';
  const buttons = actionsFor(job, state.detail).map((action) => {
    const node = button(`btn${action.p ? ' primary' : ''}${action.d ? ' danger' : ''}`, action.l, { act: action.a });
    node.id = `${action.a}-button`;
    let reason = availability(action.a === 'goon' ? 'say' : action.a, job);
    if (reason === '' && state.confirm !== null) {
      reason = 'a confirmation is open: confirm or cancel it first.';
    }
    if (reason === '' && action.a === 'say' && msg.value.trim() === '') {
      reason = 'write a message first.';
    }
    node.disabled = reason !== '';
    if (reason !== '') {
      node.setAttribute('title', reason);
    }
    return node;
  });
  keepFocus($('acts'), () => $('acts').replaceChildren(...buttons));
}

// ---------- The job's detail and its actions ----------

function renderDetail(detail) {
  state.detail = detail;
  renderHead();
  // Changes reads its index again when the job's iteration or state moved; the screen stays as it
  // is until the new index arrives.
  if (ui.screen === 'changes') {
    if ($('scrChanges').children.length === 0) {
      renderChanges();
    } else {
      cxIndex();
    }
  } else if (ui.screen === 'mr') {
    void showMr();
  }
  renderComposer();
  refreshStop();
  // Approve… on a Your turn card opens its confirmation once the job is shown, and a card's button
  // its stop or its message box.
  openWantedConfirm();
  applyWantedFocus();
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
  if (action === 'archive') {
    return TERMINAL_STATES.includes(job.state) ? '' : 'only a finished job is archived.';
  }
  if (action === 'pause') {
    if (job.state === 'preparing_mr') {
      return 'the MR is being prepared (commit, rebase); it cannot be paused now.';
    }
    return PAUSE_STATES.includes(job.state) ? '' : 'only while the Implementer works or the reviewers review.';
  }
  if (action === 'resume') {
    return job.state === 'paused' ? '' : 'only for a paused job.';
  }
  if (action === 'restart') {
    return RESTART_STATES.includes(job.state) ? '' : 'only for a paused, aborted, failed or needs_human job.';
  }
  if (action === 'mr-create') {
    if (!canCreateMr(job)) {
      return hasMr(job) && job.state === 'pushed' ? `the merge request #${job.mr.number} is ${job.mr.state}.` : 'a merge request needs a pushed branch, or one ready to approve.';
    }
    return mrOff(job);
  }
  if (action === 'mr-merge') {
    return canMerge(job) ? mrOff(job) : 'only an open merge request of a pushed job is merged.';
  }
  if (action === 'mr-status') {
    return hasMr(job) ? mrOff(job) : 'no merge request yet.';
  }
  if (action === 'review') {
    return reviewFailed(job) ? '' : 'only after a failed review.';
  }
  if (action === 'simplify') {
    return simplifiable(job) ? '' : 'only when the simplification pass offers suggestions (simplify_offered).';
  }
  if (action === 'accept') {
    return state.detail !== null && keyOf(state.detail.job) === keyOf(job) && gateAcceptable(state.detail)
      ? '' : 'only after the gate or the ledger stopped the job, or the simplification pass offered suggestions, with a clean Claude review.';
  }
  const handover = HANDOVER_ACTIONS.find(([name]) => name === action);
  if (handover !== undefined) {
    return job.state === handover[1] ? '' : `only when the job is ${handover[1]}; it is ${job.state}.`;
  }
  if (job.state === 'paused') {
    return pausedTurn(job) ? 'the job is paused: Resume sends the message.' : 'the job is paused: Resume, then send the message.';
  }
  return SAY_STATES.includes(job.state) ? '' : `messages need working, awaiting_review, needs_human, ready_for_human_review or handed_over; the job is ${job.state}.`;
}

// A job paused during the Implementer's turn (SF-067): its Resume takes the message.
const pausedTurn = (job) => job.state === 'paused' && job.paused?.from === 'working';

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
      const text = `Pushed ${data.branch}.${data.title ? ` ${data.title}` : ''}${typeof data.message === 'string' ? ` ${data.message}` : ''}`;
      return typeof data.link === 'string'
        ? { level: 'ok', text: `${text} Merge request:`, link: data.link }
        : { level: 'ok', text: `${text} No merge request link: the origin URL could not be parsed. Open the merge request for branch ${data.branch} by hand.` };
    }
    if (data.state === 'needs_human' || (data.state === 'handed_over' && data.error)) {
      return { level: 'error', text: `Not pushed: the push failed (${detail || 'no details'}). Fix it, then approve again.` };
    }
    return { level: 'warn', text: `Not pushed: the job is ${data.state}${detail ? ` (${detail})` : ''}.` };
  }
  if (action === 'handover') {
    return { level: 'ok', text: `Handed over: ${data.branch} is checked out in your checkout with the job's changes as Local Changes and the commit message prefilled.` };
  }
  if (action === 'takeback') {
    return { level: 'ok', text: `Taken back: your checkout is back where it was; ${data.branch} waits for you to approve (state ${data.state}).` };
  }
  if (action === 'handed-done') {
    return { level: 'ok', text: `Pushed by you: ${data.branch} is on origin${typeof data.commit === 'string' ? ` at ${data.commit.slice(0, 12)}` : ''}; the job is ${data.state}.` };
  }
  if (action === 'mr-create') {
    if (data.mr !== null && typeof data.mr === 'object') {
      // From ready_for_human_review the push came first: the outcome carries the compare link too.
      const pushed = typeof data.link === 'string' ? `Pushed ${data.branch}. ` : '';
      return { level: 'ok', text: `${pushed}Merge request #${data.mr.number} ${data.mr.reused === true ? 'was already open; reused' : 'opened'}:`, link: data.mr.url };
    }
    if (data.state === 'pushed' && data.error) {
      return { level: 'error', text: `Pushed ${data.branch}, but the merge request was not opened (${detail}). Fix it, then create the merge request again.` };
    }
    if (data.state === 'needs_human' || (data.state === 'handed_over' && data.error)) {
      return { level: 'error', text: `Not pushed: the push failed (${detail || 'no details'}). Fix it, then try again.` };
    }
    return { level: 'warn', text: `No merge request: the job is ${data.state}${detail ? ` (${detail})` : ''}.` };
  }
  if (action === 'mr-merge') {
    const commit = typeof data.mr?.merge_commit === 'string' ? ` (merge commit ${data.mr.merge_commit.slice(0, 12)})` : '';
    return { level: 'ok', text: `Merged merge request #${data.mr?.number}${commit}.` };
  }
  if (action === 'mr-status') {
    return data.status !== null && typeof data.status === 'object'
      ? { level: 'ok', text: mrStatusText(data.status) }
      : { level: 'warn', text: 'The host said nothing of the merge request.' };
  }
  if (action === 'review') {
    return { level: 'ok', text: `The review of iteration ${data.iteration} runs again (state ${data.state}).` };
  }
  if (action === 'accept') {
    return { level: 'ok', text: `Accepted over the gate: the factory prepares the MR of iteration ${data.iteration} (state ${data.state}).` };
  }
  if (action === 'simplify') {
    return { level: 'ok', text: `Simplify: the Implementer applies the suggestions in iteration ${data.iteration} (state ${data.state}).` };
  }
  if (action === 'settle') {
    const status = data.status === 'accepted_risk' ? 'accepted as a risk' : data.status === 'user_fix' ? 'to be fixed' : data.status;
    const waiting = Array.isArray(data.waiting) ? data.waiting : [];
    return waiting.length > 0
      ? { level: 'ok', text: `Settled ${data.id}: ${status}. Still to settle: ${waiting.join(', ')}.` }
      : { level: 'ok', text: `Settled ${data.id}: ${status} (state ${data.state}).` };
  }
  if (action === 'pause') {
    return data.state === 'paused'
      ? { level: 'ok', text: `Paused${data.step ? ` during the ${data.step}` : ''}: nothing of the job runs; the worktree, the branch ${data.branch} and the session stay.` }
      : { level: 'warn', text: `Not paused: the step had ended as the job stopped; the job is ${data.state}.` };
  }
  if (action === 'resume') {
    const changed = data.task_changed === true ? ' The changed Task file went with it.' : '';
    return data.step === 'turn' || data.state === 'working'
      ? { level: 'ok', text: `Resumed: the Implementer goes on with iteration ${Number(data.iteration) + 1}.${changed}` }
      : { level: 'ok', text: `Resumed: ${data.step ? `the ${data.step} of iteration ${data.iteration} runs again` : `the job awaits review of iteration ${data.iteration}`}.${changed}` };
  }
  if (action === 'restart') {
    const kept = Array.isArray(data.kept) && data.kept.length > 0 ? ` ${data.kept.length === 1 ? '1 file' : `${data.kept.length} files`} of the old worktree ${data.kept.length === 1 ? 'was' : 'were'} copied in.` : '';
    const branch = typeof data.branch_deleted === 'string' ? ` The old branch ${data.branch_deleted} was deleted.` : '';
    return { level: 'ok', text: `Restarted on ${data.branch} from the current Task file (the old job is in ${data.archived}).${branch}${kept}` };
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

// The short words of a success, for the toast of the job page.
const DONE_TEXT = {
  say: 'Message sent', approve: 'Pushed', abort: 'Aborted', review: 'The review runs again', accept: 'The MR is being prepared', settle: 'Settled',
  simplify: 'Simplify sent to the Implementer', archive: 'Archived', 'mr-create': 'Merge request opened', 'mr-merge': 'Merged', 'mr-status': 'MR status read',
  pause: 'Paused', resume: 'Resumed', restart: 'Restarted', handover: 'Handed over to your checkout', takeback: 'Taken back', 'handed-done': 'Your push is recorded',
};

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
  renderComposer();
  refreshStop();
  renderBoard();
  let outcome;
  let unknownReason;
  try {
    const result = await post(`api/jobs/${jobPath(key)}/${action}`, body);
    outcome = describeOutcome(action, result);
    if (action === 'mr-status' && result !== null && typeof result === 'object' && result.status) {
      state.mrStatus.set(key, result.status);
    }
    // The sent draft goes; text edited meanwhile stays.
    if ((action === 'say' || action === 'resume') && typeof body.message === 'string' && state.drafts.get(key) === body.message) {
      state.drafts.delete(key);
      if (key === state.key) {
        $('msg').value = '';
      }
    }
    if (action === 'settle' && typeof body.id === 'string') {
      state.notes.delete(`${key}/${body.id}`);
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
  if (outcome.level === 'ok' && key === ui.job) {
    toast({ level: 'ok', text: DONE_TEXT[action] ?? 'Done' });
  }
  renderComposer();
  refreshStop();
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
  showDoubt(key, `${lead}: the state is being refreshed; check it before choosing a next action.`);
  renderComposer();
  refreshStop();
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
    renderComposer();
    refreshStop();
    renderBoard();
    return;
  }
  state.unresolved.delete(key);
  showDoubt(key, `${lead}: it may have taken effect. The state shown is current; check it and the Stream before choosing a next action.`);
  if (key === state.key) {
    renderDetail(detail);
  } else {
    renderComposer();
  }
  renderBoard();
}

// The confirmations, inline in the composer (the prototype's Abort), each with today's content;
// the action is posted only from its button.
function openConfirm(action) {
  const job = state.detail?.job ?? null;
  if (job === null || availability(action, job) !== '' || state.confirm !== null) {
    return;
  }
  const key = keyOf(job);
  state.confirm = { action, key };
  $('confirm-title').textContent = `${ACTION_LABELS[action]} ${key}?`;
  const host = job.mr_host?.host === 'gitlab' ? 'GitLab' : 'GitHub';
  const mrTitle = typeof state.detail?.mr_title === 'string' ? state.detail.mr_title : '(the MR text\'s first line)';
  const texts = {
    'mr-create': canApprove(job)
      ? `Pushes branch ${job.branch} to origin as Approve does, then opens a merge request on ${host} from ${job.branch} into ${job.base}, titled “${mrTitle}”, with the rest of the MR text as its description.`
      : `Opens a merge request on ${host} from ${job.branch} into ${job.base}, titled “${mrTitle}”, with the rest of the MR text as its description. One already open for the branch is reused.`,
    'mr-merge': hasMr(job)
      ? `Merges merge request #${job.mr.number} (${job.branch}) into ${job.base} on ${host} through its API, as a merge commit. Nothing is pushed or forced; the host refuses a merge request it cannot merge (conflicts, failing required checks, a draft) and says why.`
      : '',
    approve: job.state === 'handed_over'
      ? `Pushes branch ${job.branch} to origin from your checkout: the factory's commit when you did not commit on the branch, else your commits on the job's base. Your uncommitted changes stay in your checkout and are not pushed.`
      : `Pushes branch ${job.branch} to origin: the one commit the factory prepared at Clean, rebased onto ${job.base}. Nothing is committed or rebased now; a tip edited by hand is refused unless pushed as it is.`,
    abort: `Ends the job on branch ${job.branch}: the Implementer session stops and queued messages are dropped. The branch and its worktree stay as they are.`,
    restart: `Starts ${job.ticket} again from its current Task file, as a new job on a fresh worktree and branch from ${job.base}. Thrown away: the Implementer session${job.state === 'paused' || job.state === 'needs_human' ? ' and its queued messages' : ''}, the worktree${typeof job.worktree === 'string' ? ` ${job.worktree}` : ''} with its uncommitted changes (unless kept below) and the branch ${job.branch}, deleted only when it has no commit beyond the base and was never pushed: otherwise nothing is touched and the restart is refused. The job's history is archived as sf reset does.`,
    simplify: `Writes one Fix section “Simplify” with the suggestions below into the Task file; the Implementer applies them and the Claude review and the gate review the result as usual. The suggestions are recorded in the ledger as your choice, so a reviewer cannot ask for them back. It runs once per job.`,
    accept: job.error?.code === SIMPLIFY_CODE
      ? `Skips the simplification: iteration ${job.iteration}, which the reviewers found clean, goes on to MR preparation as it is. The suggestions go into the MR text under “Simplifications not applied”, for a follow-up ticket.`
      : LEDGER_CODES.includes(job.error?.code)
      ? `Accepts iteration ${job.iteration}, which Claude reviewed clean, over the ledger's stop (${job.error?.code}). The factory commits it and rebases it onto ${job.base}, and the branch comes back to you to approve. The open findings are not applied; the override is recorded in the job's history.`
      : `Overrides the Codex gate (${job.error?.code}): iteration ${job.iteration}, which Claude reviewed clean, goes on as after a clean gate. The factory commits it and rebases it onto ${job.base}, and the branch comes back to you to approve. The override is recorded in the job's history.`,
  };
  $('confirm-text').textContent = texts[action];
  renderConfirmItems(action === 'simplify' || (action === 'accept' && job.error?.code === SIMPLIFY_CODE) ? offeredSuggestions(state.detail)
    : action === 'accept' ? gateLeftovers(state.detail) : null);
  $('discard').checked = false;
  $('as-is').checked = false;
  $('discard-label').hidden = action !== 'abort';
  $('keep-files').checked = false;
  $('keep-files-label').hidden = action !== 'restart';
  $('as-is-label').hidden = action !== 'approve';
  $('confirm').hidden = false;
  renderConfirmButton();
  renderComposer();
  $('confirm-cancel').focus();
}

// The Codex items Accept and prepare MR goes without, listed in its confirmation (path, problem).
function renderConfirmItems(leftovers) {
  $('confirm-items').hidden = leftovers === null;
  if (leftovers === null) {
    $('confirm-items-list').replaceChildren();
    return;
  }
  if (leftovers.suggestions === true) {
    $('confirm-items-title').textContent = `Suggestions of the simplification pass (${leftovers.items.length}):`;
    $('confirm-items-list').replaceChildren(...leftovers.items.map((item) => {
      const entry = el('li');
      entry.append(el('code', '', item.path), document.createTextNode(`: ${item.what} Why: ${item.why} (about ${item.saves_lines} lines)`));
      return entry;
    }));
    return;
  }
  $('confirm-items-title').textContent = leftovers.ledger === true
    ? (leftovers.items.length === 0 ? 'No open finding is left in the ledger.' : `Open findings of the ledger that will not be applied (${leftovers.items.length}):`)
    : leftovers.error !== null
    ? `The gate failed, so no Codex item is known: ${leftovers.error}`
    : !leftovers.ran ? 'Codex did not review this iteration (its token budget was used up before it ran), so what it would ask for is not known.'
      : leftovers.items.length === 0 ? 'The gate left no Codex item on this iteration.' : `Codex items that will not be applied (${leftovers.items.length}):`;
  $('confirm-items-list').replaceChildren(...leftovers.items.map((item) => itemEntry(item, false)));
}

function renderConfirmButton() {
  const confirm = state.confirm;
  if (confirm === null) {
    return;
  }
  const discard = confirm.action === 'abort' && $('discard').checked;
  const ok = $('confirm-ok');
  const job = state.detail?.job;
  ok.textContent = confirm.action === 'mr-create' ? 'Create the merge request'
    : confirm.action === 'mr-merge' ? `Merge #${job?.mr?.number} into ${job?.base}`
    : confirm.action === 'simplify' ? 'Simplify'
    : confirm.action === 'accept' ? (job?.error?.code === SIMPLIFY_CODE ? 'Skip and prepare the MR' : 'Accept and prepare the MR')
    : confirm.action === 'restart' ? ($('keep-files').checked ? 'Restart, keep the files' : 'Restart')
    : confirm.action === 'approve' ? ($('as-is').checked ? 'Approve: push as it is' : 'Approve: push the branch') : discard ? 'Abort and discard the branch' : 'Abort, keep the worktree';
  ok.className = confirm.action === 'abort' ? 'btn small danger' : 'btn small primary';
}

function closeConfirm() {
  state.confirm = null;
  $('confirm').hidden = true;
  renderConfirmItems(null);
  $('discard').checked = false;
  $('as-is').checked = false;
  $('keep-files').checked = false;
  renderComposer();
}

function submitConfirm() {
  const confirm = state.confirm;
  if (confirm === null) {
    return;
  }
  const discard = confirm.action === 'abort' && $('discard').checked;
  const asIs = confirm.action === 'approve' && $('as-is').checked;
  const keepFiles = confirm.action === 'restart' && $('keep-files').checked;
  closeConfirm();
  // The target was captured when the confirmation opened; a selection changed since drops it.
  if (confirm.key !== state.key) {
    return;
  }
  void run(confirm.action, confirm.key, confirm.action === 'abort' ? { discard } : confirm.action === 'restart' ? { keep_files: keepFiles } : asIs ? { as_is: true } : {});
}

// Send, and Tell it to go on ("Go on." for an empty box): the message box's text, once.
function sendSay(goOn = false) {
  const key = state.key;
  const text = $('msg').value;
  if (key === null || (text.trim() === '' && !goOn) || availability('say', state.detail?.job ?? null) !== '') {
    return;
  }
  void run('say', key, { message: text.trim() === '' ? 'Go on.' : text });
}

// A button of the composer (the prototype's act): the ones that ask first open their confirmation;
// Send, Tell it to go on, Pause, Resume, Retry review, Refresh MR status, Archive and the hand-over's
// actions (SF-073) post at once.
function act(action) {
  const job = state.detail?.job ?? null;
  if (job === null) {
    return;
  }
  const key = keyOf(job);
  if (action === 'say' || action === 'goon') {
    sendSay(action === 'goon');
  } else if (['abort', 'restart', 'approve', 'accept', 'simplify', 'mr-create', 'mr-merge'].includes(action)) {
    openConfirm(action);
  } else if (action === 'resume') {
    const message = $('msg').value;
    if (availability('resume', job) === '') {
      void run('resume', key, pausedTurn(job) && message.trim() !== '' ? { message } : {});
    }
  } else if (['pause', 'review', 'mr-status', 'archive', ...HANDOVER_ACTIONS.map(([name]) => name)].includes(action) && availability(action, job) === '') {
    void run(action, key, {});
  }
}

// Accept risk or Must fix on a ledger entry of the stop: posted at once, with its note.
function settle(id, decision) {
  const job = state.detail?.job ?? null;
  if (job === null || availability('settle', job) !== '') {
    return;
  }
  void run('settle', keyOf(job), { id, decision, note: state.notes.get(noteKey(id)) ?? '' });
}

// ---------- The board (SF-077: the v3 board of docs/design/dashboard-v3/prototype.html) ----------

// The column of each job state; the tickets without a live job are in the Queue. One column per
// ticket (SF-057): a ticket whose last job failed or was aborted is in the Queue (to start again),
// not also in Done; a pushed one is only in Done.
const COLUMN_OF = {
  starting: 'implementing', working: 'implementing',
  awaiting_review: 'reviewing', preparing_mr: 'reviewing',
  needs_human: 'you', ready_for_human_review: 'you', handed_over: 'you', paused: 'you',
  pushed: 'done', aborted: 'done', failed: 'done',
};
const COLUMNS = ['queue', 'implementing', 'reviewing', 'you', 'done'];
// The list of each column: #qlist as the prototype's Queue, #list-<column> for the others.
const LIST_OF = { queue: 'qlist', implementing: 'list-implementing', reviewing: 'list-reviewing', you: 'list-you', done: 'list-done' };
// Without SF-071's queue the Queue is today's Planned column, with its empty text.
const EMPTY_TEXT = { planned: 'No ticket waits to start.', implementing: 'Nothing is being implemented.', reviewing: 'Nothing is in review.', you: 'Nothing waits for you.', done: 'No finished job.' };
// Done shows the most recent jobs; "Show all" shows the rest.
const DONE_LIMIT = 8;
const DONE_LABELS = { pushed: 'Pushed', aborted: 'Aborted', failed: 'Failed' };
const RESTARTABLE = ['failed', 'aborted'];
// The states of a running card: the Now line, the tool calls, the cost "so far".
const RUNNING = ['starting', 'working', 'awaiting_review', 'preparing_mr'];
// While a card runs and the page is visible, api/jobs is read again this often.
const REFRESH_MS = 15000;
// An ok or info message of the toast goes after this long, unless the pointer is on it.
const TOAST_MS = 6000;

// The job can be pushed: the branch prepared at Clean is ready, or its push failed and approve
// tries again.
const canApprove = (job) => job.state === 'ready_for_human_review' || job.state === 'handed_over' || (job.state === 'needs_human' && typeof job.prepared_commit === 'string');

// The hand-over (SF-073): the line of a job in the user's checkout, and why a job ready for review
// was not handed over ('' when it was not refused).
const checkoutLine = (job) => `In your checkout on ${job.branch}`;
const skippedNote = (job) => (job.handoff_skipped !== null && typeof job.handoff_skipped === 'object' ? `Not handed over to your checkout: ${job.handoff_skipped.message} ` : '');

// The merge request on the Git host (SF-048): the job has one; Create merge request applies to a
// branch ready to approve (push, then open) and to a pushed one without an open or merged one;
// Merge to an open one. mrOff: why the actions are off for the job's workspace, or ''.
const hasMr = (job) => job.mr !== null && typeof job.mr === 'object';
const canCreateMr = (job) => canApprove(job) || (job.state === 'pushed' && !(hasMr(job) && job.mr.state !== 'closed'));
const canMerge = (job) => job.state === 'pushed' && hasMr(job) && job.mr.state === 'open';
const mrOff = (job) => (job.mr_host === null || typeof job.mr_host !== 'object' ? 'the Git host is not known yet.'
  : typeof job.mr_host.reason === 'string' && job.mr_host.reason !== '' ? `${job.mr_host.reason}.` : '');

// A duration as the prototype writes it: "14 min", "1 h 4 min".
const dur = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
// An estimated cost (the jobs payload's cost_usd): "$1.23", or "—" without one.
const money = (value) => (typeof value === 'number' ? `$${value.toFixed(2)}` : '—');
const firstLine = (text) => (typeof text === 'string' ? text.split('\n')[0].trim() : '');
const counted = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// The iteration a job shows, numbered from 1, the same on its card and on its page: the one under
// way while the Implementer works on it (starting, working, paused in its turn, stopped by its
// session), else the last one published; never 0.
const SESSION_CODES = ['serve_restarted', 'session_failed', 'turn_failed', 'max_turns', 'sandbox_unavailable', 'permission_mode_mismatch', 'publish_failed'];
function shownIteration(job) {
  const underWay = job.state === 'starting' || job.state === 'working' || (job.state === 'paused' && job.paused?.step === 'turn')
    || (job.state === 'needs_human' && SESSION_CODES.includes(job.error?.code));
  return Math.max(1, underWay ? job.iteration + 1 : job.iteration);
}

// The number of things a stopped job waits on (the jobs payload's stop.items); null when not known.
const stopCount = (job) => (Array.isArray(job.stop?.items) ? job.stop.items.length : null);
// The first line of the job's error message, after ": ", or nothing.
const said = (job) => (firstLine(job.error?.message) === '' ? '' : `: ${firstLine(job.error.message).replace(/\.$/, '')}`);
// A failed session that hit the Claude usage limit ("You've hit your … limit · resets 3am (Europe/Sofia)").
const usageLimited = (job) => job.error?.code === 'session_failed' && /hit your .*limit/i.test(firstLine(job.error?.message));
const resetTime = (job) => /resets\s+(.+)$/i.exec(firstLine(job.error?.message))?.[1] ?? null;

// The stop codes (SF-077): one table for the cards and the job page (its header, its stop block
// and its composer, SF-078). A decision (the factory needs the user's choice; nothing failed) never
// shows as an error; an error does. Each entry: its kind, the card's reason, the sentence (with the
// job's numbers, or the words without one that is not known) and the card's button. N, M, X and T
// come from the job; the codes of factory/src.
const STOPS = {
  simplify_offered: {
    kind: 'decision', reason: 'Simplification offered', button: () => 'Simplify or skip',
    sentence: (job) => (stopCount(job) !== null && typeof job.stop?.saves_lines === 'number'
      ? `The simplification pass suggests ${counted(stopCount(job), 'change')} (saves about ${counted(job.stop.saves_lines, 'line')}). Simplify or skip.`
      : 'The simplification pass suggests changes. Simplify or skip.'),
  },
  escalated: {
    kind: 'decision', reason: 'Question for you',
    button: (job) => (stopCount(job) ? `Answer ${counted(stopCount(job), 'question')}` : 'Answer the questions'),
    sentence: (job) => `The Implementer asks you about ${stopCount(job) ? counted(stopCount(job), 'finding') : 'findings'}. Answer each: Accept risk or Must fix.`,
  },
  review_disputed: {
    kind: 'decision', reason: 'A reviewer disputes a contest',
    button: (job) => (stopCount(job) ? `Settle ${counted(stopCount(job), 'finding')}` : 'Settle the findings'),
    sentence: (job) => `A reviewer reopened ${stopCount(job) ? counted(stopCount(job), 'finding') : 'findings'} the Implementer contested. Settle each: Accept risk or Must fix.`,
  },
  review_churn: {
    kind: 'decision', reason: 'Fixes keep making findings',
    button: (job) => (stopCount(job) ? `Decide ${counted(stopCount(job), 'finding')}` : 'Decide the findings'),
    sentence: (job) => `The fixes keep making new findings${stopCount(job) !== null ? ` (${stopCount(job)} open)` : ''}. Accept the change as it is, or tell the Implementer what to fix.`,
  },
  gate_rounds: {
    kind: 'decision', reason: 'Codex round limit reached',
    button: (job) => (stopCount(job) ? `Decide ${counted(stopCount(job), 'finding')}` : 'Decide the findings'),
    sentence: (job) => `${typeof job.gate_fixes === 'number' ? `Codex asked for fixes ${counted(job.gate_fixes, 'time')}, the limit.` : 'Codex asked for fixes as often as the limit allows.'} Accept the change without its ${stopCount(job) !== null ? counted(stopCount(job), 'open finding') : 'open findings'}, or tell the Implementer what to fix.`,
  },
  gate_budget: {
    kind: 'decision', reason: 'Codex token budget used up', button: () => 'Decide',
    sentence: () => "The Codex gate used its token budget for this job. Accept the change with Claude's clean review, or tell the Implementer what to do.",
  },
  iteration_limit: {
    kind: 'decision', reason: 'Fix round limit reached', button: () => 'Give a direction',
    sentence: (job) => `${typeof job.fixes === 'number' ? `The reviewers asked for fixes ${counted(job.fixes, 'time')}, the limit.` : 'The reviewers asked for fixes as often as the limit allows.'} Give the Implementer a direction, or abort.`,
  },
  max_turns: {
    kind: 'decision', reason: 'Turn limit reached', button: () => 'Tell it to go on',
    sentence: (job) => `The Implementer used all its turns on iteration ${shownIteration(job)}. Tell it to go on.`,
  },
  gate_failed: {
    kind: 'error', reason: 'Codex gate gave no verdict', button: () => 'Decide',
    sentence: () => "The Codex gate stopped without a verdict. Accept with Claude's clean review, or tell the Implementer to go on.",
  },
  review_failed: {
    kind: 'error', reason: 'Claude review could not run', button: () => 'Retry review',
    sentence: (job) => `The Claude review of iteration ${shownIteration(job)} could not run. Retry it.`,
  },
  serve_restarted: {
    kind: 'error', reason: 'Interrupted by a restart', button: () => 'Tell it to go on',
    sentence: (job) => `sf serve restarted while iteration ${shownIteration(job)} ran. Tell the Implementer to go on.`,
  },
  mr_serve_restarted: {
    kind: 'error', reason: 'MR preparation interrupted', button: () => 'Tell it to go on',
    sentence: () => 'The MR preparation was interrupted. Tell the Implementer to go on: the iteration is reviewed again and the MR is prepared again.',
  },
  // session_failed with the usage-limit message.
  usage_limit: {
    kind: 'error', reason: 'Usage limit reached', button: () => 'Tell it to go on',
    sentence: (job) => `The Claude usage limit was reached${resetTime(job) !== null ? `; it resets at ${resetTime(job)}` : ''}. Tell the Implementer to go on after that.`,
  },
  session_failed: {
    kind: 'error', reason: 'Implementer session failed', button: () => 'Tell it to go on',
    sentence: (job) => `The Implementer's session failed${said(job)}. Tell it to go on, or restart.`,
  },
  sandbox_unavailable: {
    kind: 'error', reason: 'Sandbox unavailable', button: () => 'Tell it to go on',
    sentence: (job) => `The Implementer's sandbox could not start${said(job)}. Fix it on this machine, then tell it to go on.`,
  },
  publish_failed: {
    kind: 'error', reason: 'Iteration not published', button: () => 'Tell it to go on',
    sentence: (job) => `The factory could not publish the Report and Patch of iteration ${shownIteration(job)}. Tell it to go on to try again.`,
  },
  mr_conflict: {
    kind: 'error', reason: 'Rebase conflict', button: () => 'Tell it how',
    sentence: (job) => `The rebase onto ${job.base} conflicts and the Implementer could not resolve it. Tell it how, or abort.`,
  },
  mr_text_missing: {
    kind: 'error', reason: 'MR text missing or invalid', button: () => 'Tell it to fix it',
    sentence: (job) => `The Implementer's MR text is missing or breaks a rule${said(job)}. Tell it to write it again.`,
  },
  mr_empty: {
    kind: 'error', reason: 'Nothing to commit', button: () => 'Tell it what is missing',
    sentence: (job) => `The reviewed change has nothing to commit against ${job.base}. Tell the Implementer what is missing, or abort.`,
  },
  mr_failed: {
    kind: 'error', reason: 'MR preparation failed', button: () => 'Tell it to go on',
    sentence: (job) => `The MR preparation failed${said(job)}. Tell the Implementer to go on (the iteration is reviewed again), or abort.`,
  },
  worktree_remove_failed: {
    kind: 'error', reason: 'Worktree not removed', button: () => 'Tell it to go on',
    sentence: (job) => `The branch is prepared, but its worktree could not be removed${said(job)}. Remove it by hand, then tell the Implementer to go on.`,
  },
  mr_push_failed: {
    kind: 'error', reason: 'Push failed', button: () => 'Push again',
    sentence: (job) => `The push of ${job.branch} failed${said(job)}. Fix the cause, then push again.`,
  },
  mr_push_protected: {
    kind: 'error', reason: 'Push refused', button: () => 'Open the job',
    sentence: (job) => `The factory never pushes to ${job.branch}. Rename the branch on the Merge request screen, or abort.`,
  },
  // Any other code.
  other: {
    kind: 'error', reason: 'Stopped', button: () => 'Open the job',
    sentence: (job) => `The job stopped${said(job)}. Tell the Implementer what to do, or abort.`,
  },
};
// The codes that share an entry of STOPS.
const STOP_ALIASES = {
  mr_interrupted: 'mr_serve_restarted', turn_failed: 'session_failed', permission_mode_mismatch: 'session_failed',
  mr_text_invalid: 'mr_text_missing', mr_commit_failed: 'mr_failed', mr_rebase_failed: 'mr_failed',
};

// The entry of STOPS for a stopped job.
function stopEntry(job) {
  if (usageLimited(job)) {
    return STOPS.usage_limit;
  }
  const code = typeof job.error?.code === 'string' ? job.error.code : '';
  return Object.hasOwn(STOPS, STOP_ALIASES[code] ?? code) ? STOPS[STOP_ALIASES[code] ?? code] : STOPS.other;
}

// The sentence of a job's state, as the job page's header says it.
function sentence(job) {
  const it = shownIteration(job);
  switch (job.state) {
    case 'starting':
      return 'The worktree is being created and the Implementer starts';
    case 'working':
      return `The Implementer is working on iteration ${it}`;
    case 'paused':
      return `Paused by you during iteration ${it}`;
    case 'awaiting_review':
      return `Claude and Codex are reviewing iteration ${it}`;
    case 'preparing_mr':
      return 'Writing the MR text';
    case 'needs_human':
      return stopEntry(job).sentence(job).replace(/\.$/, '');
    case 'ready_for_human_review':
      return 'Reviews are clean and the MR text is written. Push when you are happy';
    case 'handed_over':
      // SF-073: the branch waits in the user's checkout.
      return checkoutLine(job);
    case 'pushed':
      return `Pushed at ${clock(job.updated_at)}`;
    case 'aborted':
      return 'Aborted by you. The branch stays';
    default:
      return DONE_LABELS[job.state] ?? job.state;
  }
}

// Who acts now on a running job and what it does: the jobs payload's now, or what the state says
// while the log has nothing yet.
function nowLine(job) {
  if (job.now !== null && typeof job.now === 'object' && typeof job.now.who === 'string') {
    return { who: job.now.who, what: String(job.now.what ?? '') };
  }
  if (job.state === 'awaiting_review') {
    return { who: job.review === 'clean' ? 'Codex gate' : 'Claude review', what: `reviewing iteration ${job.iteration}` };
  }
  if (job.state === 'preparing_mr') {
    return { who: 'MR writer', what: 'writing the MR text' };
  }
  return { who: 'Implementer', what: 'starting' };
}

const jobByKey = (key) => state.jobs.find((job) => keyOf(job) === key) ?? null;
const ticketByKey = (key) => (state.tickets ?? []).find((row) => keyOf(row) === key) ?? null;
const titleOf = (job) => (typeof job.title === 'string' && job.title !== '' ? job.title : job.branch);

// A button with its data-* attributes, for the delegated click listener.
function button(className, text, data = {}) {
  const node = el('button', className, text);
  node.type = 'button';
  for (const [name, value] of Object.entries(data)) {
    node.dataset[name] = value;
  }
  return node;
}

// What the cards need of the board as a whole: the dependency graph (SF-084).
const board = { graph: { deps: new Map(), needed: new Map() } };

// ---------- Workspaces and dependencies on the board (SF-084) ----------

// The workspace palette: the --ws-<name> tokens of app.css. The server sends each workspace's
// colour (its own, else the one its name picks); the page only reads it.
const WS_COLORS = ['blue', 'teal', 'green', 'olive', 'orange', 'red', 'purple', 'grey'];
// The longest workspace name a chip shows whole; a longer one is shortened in the middle.
const WS_NAME_CHARS = 16;

// The colour class of a workspace ("ws-teal"), or '' when the registry does not list it.
function wsClass(name) {
  const color = (state.workspaces ?? []).find((row) => row.name === name)?.color;
  return WS_COLORS.includes(color) ? `ws-${color}` : '';
}

// A long workspace name shortened in the middle: "very-long…ace-name"; the full name is the title.
const shortName = (name) => (name.length <= WS_NAME_CHARS ? name : `${name.slice(0, 7)}…${name.slice(-(WS_NAME_CHARS - 8))}`);

// The workspace's colour dot (decoration: the name always goes with it).
function wsDot(name) {
  const dot = el('i', `wsdot ${wsClass(name)}`.trim());
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

// The workspace chip of a card's first line and the job page header: the dot and the name.
function wsChip(name) {
  const chip = el('span', `wschip ${wsClass(name)}`.trim());
  chip.setAttribute('title', `Workspace ${name}`);
  chip.append(wsDot(name), el('span', 'wsname', shortName(name)));
  return chip;
}

// A dependency's state as a mark and in words (the mark is never the only signal: the title and
// the label say it).
const DEP_MARK = { merged: '✓', pushed: '⧗', running: '⧗', planned: '⧗', missing: '✗' };
const DEP_WORD = { merged: 'merged', pushed: 'pushed, not merged yet', running: 'running', planned: 'planned, not started', missing: 'no Task file and no job' };
const depState = (dep) => (Object.hasOwn(DEP_MARK, dep.state) ? dep.state : 'missing');
// The key a card shows for another ticket: the ticket alone in the same workspace.
const depLabel = (key, workspace) => (key.startsWith(`${workspace}/`) ? key.slice(workspace.length + 1) : key);

// The dependency graph: "<ws>/<ticket>" -> its lands_after rows (the tickets of the Queue and the
// Done cards with a Task file, and the live jobs' Task files), and the reverse: who waits for it.
function dependencyGraph() {
  const deps = new Map();
  for (const row of [...(state.tickets ?? []), ...state.jobLandsAfter]) {
    if (Array.isArray(row.lands_after) && row.lands_after.length > 0) {
      deps.set(keyOf(row), row.lands_after);
    }
  }
  const needed = new Map();
  for (const [key, rows] of deps) {
    for (const dep of rows) {
      const target = keyOf(dep);
      needed.set(target, [...(needed.get(target) ?? []), key]);
    }
  }
  return { deps, needed };
}

// The shortest cycle through key ("A → B → A" as keys), or null: a breadth-first walk over what
// key waits for, each ticket visited once, so a loop of any length ends.
function cycleThrough(key, deps) {
  const parent = new Map([[key, null]]);
  const queue = [key];
  while (queue.length > 0) {
    const at = queue.shift();
    for (const dep of deps.get(at) ?? []) {
      const next = keyOf(dep);
      if (next === key) {
        const path = [];
        for (let step = at; step !== null; step = parent.get(step)) {
          path.unshift(step);
        }
        return [...path, key];
      }
      if (!parent.has(next)) {
        parent.set(next, at);
        queue.push(next);
      }
    }
  }
  return null;
}

// A chip of another ticket: a click scrolls to its card and focuses it.
function depChip(key, workspace, stateName) {
  const label = depLabel(key, workspace);
  const chip = button(stateName === undefined ? 'dchip' : `dchip dep-${stateName}`, undefined, { dep: key });
  if (stateName !== undefined) {
    chip.append(el('span', 'mk', DEP_MARK[stateName]), document.createTextNode(' '));
  }
  chip.append(document.createTextNode(label));
  chip.setAttribute('title', stateName === undefined ? `${key}: show its card` : `${key}: ${DEP_WORD[stateName]}`);
  return chip;
}

// The dependency lines of a card or the job page header, each null when it does not apply: Waits
// for (only while one is not merged), Needed by, and a cycle in the error colour; lines: those that
// apply, in that order; open: the keys not merged yet, for Start's title.
function dependencyLines(key, graph, className) {
  const workspace = key.slice(0, key.indexOf('/'));
  const deps = graph.deps.get(key) ?? [];
  const open = deps.filter((dep) => depState(dep) !== 'merged').map(keyOf);
  let waits = null;
  if (open.length > 0) {
    waits = el(className, 'deps waits');
    waits.append(el('span', 'lbl', 'Waits for'), ...deps.map((dep) => depChip(keyOf(dep), workspace, depState(dep))));
  }
  const dependents = graph.needed.get(key) ?? [];
  let needed = null;
  if (dependents.length > 0) {
    needed = el(className, 'deps needed');
    needed.append(el('span', 'lbl', 'Needed by'), ...dependents.map((other) => depChip(other, workspace)));
  }
  const path = deps.length > 0 ? cycleThrough(key, graph.deps) : null;
  const cycle = path === null ? null : el(className, 'deps cycle', `Dependency cycle: ${path.map((step) => depLabel(step, workspace)).join(' → ')}`);
  return { waits, needed, cycle, lines: [waits, needed, cycle].filter((line) => line !== null), open };
}

// The card of a ticket on the board, or null.
const cardOf = (key) => [...document.querySelectorAll('#cols .card')].find((card) => card.dataset.key === key) ?? null;

// A chip's click: the board with that ticket's card scrolled to and focused; a filter or Done's
// limit that hides it is lifted; a ticket without a card says so.
function showCard(key) {
  if (ui.screen !== 'board') {
    back();
  }
  let card = cardOf(key);
  if (card === null && (state.filter !== '' || !state.doneAll)) {
    state.filter = '';
    state.doneAll = true;
    renderBoard();
    card = cardOf(key);
  }
  if (card === null) {
    toast({ level: 'info', text: `${key} has no card on the board: no Task file and no job.` });
    return;
  }
  card.scrollIntoView({ block: 'nearest' });
  card.focus();
  relate(key);
}

// Hovering or focusing a card shows its dependencies and dependents (outlined) and dims the other
// cards; null clears it. Only a card with either relates.
function relate(key) {
  if (ui.related === key) {
    return;
  }
  ui.related = key;
  showRelated();
}

// Applies ui.related to the cards drawn: rel on its dependencies and dependents, dim on the rest
// (nothing when it has neither); called on a change and after every drawing of the board.
function showRelated() {
  const graph = board.graph;
  const key = ui.related;
  const related = new Set(key === null ? [] : [...(graph.deps.get(key) ?? []).map(keyOf), ...(graph.needed.get(key) ?? [])]);
  const on = related.size > 0;
  for (const card of document.querySelectorAll('#cols .card')) {
    card.classList.toggle('rel', on && related.has(card.dataset.key));
    card.classList.toggle('dim', on && card.dataset.key !== key && !related.has(card.dataset.key));
  }
}

// The card under the pointer or with the focus (mouseover, focusin), none outside the cards.
function onCardHover(event) {
  if (ui.screen !== 'board') {
    return;
  }
  const card = typeof event.target?.closest === 'function' ? event.target.closest('#cols .card') : null;
  relate(card === null ? null : card.dataset.key);
}

// The focus left the cards (focusout to outside one).
function onCardBlur(event) {
  const next = event.relatedTarget;
  if (next === null || next === undefined || typeof next.closest !== 'function' || next.closest('#cols .card') === null) {
    relate(null);
  }
}

// The first line of a job card: the key, the workspace chip (SF-084), the code of a stopped job,
// and the money: the cost so far (none before there is one) and the time since the start while it
// runs, the cost and the time it took when it does not.
function cardRow(job) {
  const row = el('div', 'row1');
  row.append(el('span', 'key', job.ticket), wsChip(job.workspace));
  if (job.state === 'needs_human' && typeof job.error?.code === 'string') {
    const code = el('span', 'tag', job.error.code);
    code.setAttribute('title', 'error code');
    row.append(code);
  }
  const running = RUNNING.includes(job.state);
  const end = running ? Date.now() : Date.parse(job.updated_at);
  const cost = running && typeof job.cost_usd !== 'number' ? '' : `${money(job.cost_usd)}${running ? ' so far' : ''} · `;
  row.append(el('span', 'money', `${cost}${dur(end - Date.parse(job.created_at))}`));
  return row;
}

// Every card (SF-084): its key for the dependency highlight and its workspace's colour stripe.
function boardCard(key, workspace) {
  const item = el('li', `card ${wsClass(workspace)}`.trim());
  item.setAttribute('tabindex', '0');
  item.dataset.key = key;
  return item;
}

// A job card (the prototype's jobCard): a click opens the job's page; one primary action only where
// the user acts (Your turn); a pushed card keeps its merge request and Archive ticket.
function jobCard(job) {
  const key = keyOf(job);
  const item = boardCard(key, job.workspace);
  item.dataset.open = key;
  item.append(cardRow(job), el('div', 'title', titleOf(job)));
  if (RUNNING.includes(job.state)) {
    const now = nowLine(job);
    const line = el('div', 'now');
    const what = el('span', '', now.what);
    what.setAttribute('title', now.what);
    line.append(el('i', 'pulse'), el('b', '', `Now: ${now.who}`), what);
    item.append(line, el('div', 'meta', `Iteration ${shownIteration(job)} · ${counted(typeof job.tool_calls === 'number' ? job.tool_calls : 0, 'tool call')}`));
  } else if (job.state === 'needs_human') {
    const stop = stopEntry(job);
    const reason = el('div', stop.kind === 'error' ? 'reason err' : 'reason', stop.reason);
    if (typeof job.error?.message === 'string') {
      reason.setAttribute('title', job.error.message);
    }
    const n = stopCount(job);
    item.append(reason, el('div', 'meta', `Iteration ${shownIteration(job)} · ${n ? `${counted(n, 'finding')} to decide` : `stopped at ${clock(job.updated_at)}`}`), ...yourTurn(job));
  } else if (job.state === 'ready_for_human_review') {
    // SF-073: why the automatic hand-over did not happen, when it was refused.
    const skipped = skippedNote(job) === '' ? [] : [el('div', 'meta note', skippedNote(job).trim())];
    item.append(el('div', 'reason ready', 'Ready to push: reviews clean, MR text written'), el('div', 'meta', `Iteration ${shownIteration(job)}`), ...skipped, ...yourTurn(job));
  } else if (job.state === 'handed_over') {
    // SF-073: the job's changes wait in the user's checkout.
    item.append(el('div', 'reason ready', checkoutLine(job)), el('div', 'meta', `Iteration ${shownIteration(job)}`), ...yourTurn(job));
  } else if (job.state === 'paused') {
    item.append(el('div', 'reason', 'Paused by you'), el('div', 'meta', `Iteration ${shownIteration(job)}`));
    if (job.task_changed === true) {
      item.append(el('div', 'meta note', 'Task file changed since the job started'));
    }
    item.append(...yourTurn(job));
  } else {
    const meta = el('div', 'meta', `${DONE_LABELS[job.state] ?? job.state} · ${counted(job.iteration, 'iteration')} · ${clock(job.updated_at)}`);
    if (typeof job.error?.message === 'string') {
      meta.setAttribute('title', `${job.error.code}: ${job.error.message}`);
    }
    item.append(meta);
    if (job.state === 'pushed') {
      item.append(...pushedFoot(job));
    }
  }
  // SF-069: the Implementer's turn went on by itself after the turn limit.
  if (typeof job.turn_limit === 'string') {
    item.append(el('div', 'meta note', job.turn_limit));
  }
  // SF-084: who waits for this ticket, and a cycle it is part of.
  const { needed, cycle } = dependencyLines(key, board.graph, 'div');
  item.append(...[needed, cycle].filter((line) => line !== null));
  return item;
}

// The one primary action of a Your turn card, and the job's last outcome. It opens the job's page
// at the stop or the message box (with the Approve confirmation for a branch to push), except
// Retry review and Resume, which go at once; a prepared branch also offers Create merge request….
function yourTurn(job) {
  const key = keyOf(job);
  const act = el('div', 'act');
  let primary;
  if (job.state === 'ready_for_human_review' || job.state === 'handed_over') {
    primary = button('btn primary small', 'Review the MR and push', { open: key, confirm: 'approve' });
    primary.disabled = availability('approve', job) !== '';
  } else if (job.state === 'paused') {
    // Resume (SF-067) needs no confirmation; a message for the Implementer is written in the job.
    primary = button('btn primary small', ACTION_LABELS.resume, { run: 'resume', key });
    primary.disabled = availability('resume', job) !== '';
  } else if (reviewFailed(job)) {
    primary = button('btn primary small', ACTION_LABELS.review, { run: 'review', key });
    primary.disabled = availability('review', job) !== '';
  } else {
    const stop = stopEntry(job);
    const data = { open: key };
    if (job.error?.code === 'mr_push_failed' && canApprove(job)) {
      data.confirm = 'approve';
    } else {
      data.focus = stop.kind === 'decision' && stopCount(job) ? 'stop' : 'composer';
    }
    primary = button('btn primary small', stop.button(job), data);
  }
  act.append(primary);
  if (canApprove(job)) {
    act.append(mrCardButton(job, 'mr-create'));
  }
  return [act, ...cardOutcome(key, true)];
}

// The job's last outcome on its card, and the warning of an unknown one.
function cardOutcome(key, doubts) {
  const parts = [];
  const outcome = state.outcomes.get(key) ?? null;
  if (outcome !== null) {
    parts.push(el('div', `outcome ${outcome.level}`, outcome.text));
  }
  const doubt = doubts ? state.doubts.get(key) : undefined;
  if (doubt !== undefined && doubt !== '') {
    parts.push(el('div', 'outcome error', doubt));
  }
  return parts;
}

// A card's Create merge request… or Merge…: opens the job's page with that confirmation; off with
// the reason as its title while the action is unavailable.
function mrCardButton(job, action) {
  const node = button('btn small', `${ACTION_LABELS[action]}…`, { open: keyOf(job), confirm: action });
  const reason = availability(action, job);
  node.disabled = reason !== '';
  if (reason !== '') {
    node.setAttribute('title', reason);
  }
  return node;
}

// A pushed job on Done (SF-048): its merge request with the link, Create merge request… or
// Merge… where they apply, Archive ticket while its Task file is active (SF-057: the ticket has
// no Queue card then), and the job's last outcome. Never a primary button.
function pushedFoot(job) {
  const key = keyOf(job);
  const parts = [];
  const row = ticketByKey(key);
  if (hasMr(job)) {
    const line = el('div', 'meta');
    line.append(document.createTextNode(`#${job.mr.number} ${job.mr.state} `), mrLink(job.mr));
    parts.push(line);
  }
  const actions = [canCreateMr(job) ? 'mr-create' : null, canMerge(job) ? 'mr-merge' : null].filter((action) => action !== null);
  if (actions.length > 0 || row !== null) {
    const act = el('div', 'act');
    act.append(...actions.map((action) => mrCardButton(job, action)));
    if (row !== null) {
      const archive = button('btn small', 'Archive ticket', { qact: 'archive', key });
      archive.disabled = state.setupPending.has(`ticket:${key}`) || state.ticketConfirm !== null;
      archive.title = 'Move the Task file to .software-factory/archive/; the finished job leaves the board';
      act.append(archive);
    }
    parts.push(act);
  }
  return [...parts, ...cardOutcome(key, false)];
}

// The state of a ticket's last job: the jobs list (read from the stream) before the tickets list,
// which may be older; null without one.
function lastJobState(row) {
  return jobByKey(keyOf(row))?.state ?? row.job ?? null;
}

// One column per ticket (SF-057): a ticket is in the Queue without a job or after a failed or
// aborted one; any other job (active, or pushed) keeps it in that job's column only.
function isPlanned(row) {
  const last = lastJobState(row);
  return last === null || RESTARTABLE.includes(last);
}

// The Task check of a Queue card in words (SF-054): checking…, check: ready, not ready: N blocker,
// M major, check failed (each with " · stale" once the Task file changed since), not checked; a
// skeleton is a draft.
function checkNote(row) {
  if (row.draft) {
    return 'draft';
  }
  const check = row.check;
  if (check !== null && typeof check === 'object' && check.running === true) {
    return 'checking…';
  }
  if (check === null || typeof check !== 'object' || check.state === 'none') {
    return 'not checked';
  }
  const text = check.state === 'ready' ? 'check: ready' : check.state === 'failed' ? 'check failed' : `not ready: ${check.blockers} blocker, ${check.majors} major`;
  return `${text}${check.stale ? ' · stale' : ''}`;
}

// A Queue card (the prototype's queueCard, without SF-071's queue): a click opens the planned
// ticket's page (SF-081); the last job's mark opens that failed or aborted job. The
// first line: the key, the workspace chip and the plan-check chip (which opens the planned ticket
// with the check's findings; under the title when the line has no room). Then the dependency lines
// (SF-084) and the actions: Start (secondary in the Queue, confirmed; its title names what it waits
// for) or "waiting for the plan" for a skeleton, Task, and the ⋯ menu with Check, Archive and
// Delete….
function queueCard(row) {
  const key = keyOf(row);
  const item = boardCard(key, row.workspace);
  if (state.highlight === key) {
    item.classList.add('hl');
  }
  item.dataset.ticket = key;
  const head = el('div', 'row1');
  head.append(el('span', 'key', row.ticket), wsChip(row.workspace));
  const last = lastJobState(row);
  if (last !== null) {
    const mark = button('tag', `last job ${last}`, { open: key });
    mark.title = 'Open the last job';
    mark.disabled = jobByKey(key) === null; // only from the tickets list: nothing to open yet
    head.append(mark);
  }
  const note = checkNote(row);
  const noteChip = (className) => {
    const chip = button(className, note, { ticket: key });
    chip.setAttribute('title', `${note}: open the ticket${row.check !== null && typeof row.check === 'object' && row.check.state !== 'none' ? ' and the check\'s findings' : ''}`);
    return chip;
  };
  head.append(noteChip('tag cnote'));
  item.append(head, el('div', 'title', row.title), noteChip('tag cnote below'));
  const { lines, open } = dependencyLines(key, board.graph, 'div');
  item.append(...lines);
  const act = el('div', 'act');
  const busy = state.setupPending.has(`ticket:${key}`) || state.ticketConfirm !== null;
  if (row.draft) {
    act.append(el('span', 'muted', 'waiting for the plan'));
  } else {
    const start = button('btn small', 'Start', { qact: 'start', key });
    start.disabled = busy || state.startHolds.has(key);
    if (open.length > 0) {
      start.setAttribute('title', `Waits for ${open.map((other) => depLabel(other, row.workspace)).join(', ')}`);
    }
    act.append(start);
  }
  const task = button('btn small', 'Task', { ticket: key });
  task.setAttribute('title', 'The Task file and its check');
  act.append(task, ...cardMenu(row, busy));
  item.append(act);
  return item;
}

// A Queue card's ⋯ menu: Check (with the Task checks, not for a skeleton), Archive and Delete…,
// shown while it is open (one card's at a time; a click elsewhere or Escape closes it).
function cardMenu(row, busy) {
  const key = keyOf(row);
  const open = state.openMenu === key;
  const toggle = button('btn small more', '⋯', { menu: key });
  toggle.setAttribute('aria-label', `More actions for ${row.ticket}`);
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', String(open));
  const menu = el('div', 'cmenu');
  menu.setAttribute('role', 'menu');
  menu.hidden = !open;
  const asItem = (node) => {
    node.setAttribute('role', 'menuitem');
    return node;
  };
  if (!row.draft && row.check !== null && typeof row.check === 'object') {
    const check = button('btn small', 'Check', { qact: 'check', key });
    check.title = 'A read-only Claude session reads the Task file and the repository and says whether it is ready; it only advises';
    check.disabled = row.check.running === true || state.setupPending.has(`check:${key}`);
    menu.append(asItem(check));
  }
  const archive = button('btn small', 'Archive', { qact: 'archive', key });
  archive.disabled = busy;
  archive.title = 'Move the Task file to .software-factory/archive/; a finished job of the ticket leaves the board';
  const remove = button('btn small danger', 'Delete…', { qact: 'delete', key });
  remove.disabled = busy;
  menu.append(asItem(archive), asItem(remove));
  return [toggle, menu];
}

// Opens or closes a Queue card's ⋯ menu; the board is drawn again with the focus where it was.
function setCardMenu(key) {
  if (state.openMenu === key) {
    return;
  }
  state.openMenu = key;
  renderBoard();
  if (key !== null) {
    cardOf(key)?.querySelector('.cmenu button:not([disabled])')?.focus();
  }
}

const visible = (workspace) => state.filter === '' || workspace === state.filter;

// The workspace filter in the top bar: All and one chip per workspace, its colour dot and its name
// (SF-084).
function renderFilter() {
  const names = (state.workspaces ?? []).map((row) => row.name);
  if (state.filter !== '' && state.workspaces !== null && !names.includes(state.filter)) {
    state.filter = '';
  }
  const node = $('workspace-filter');
  node.hidden = names.length === 0;
  node.replaceChildren(...[['', 'All workspaces'], ...names.map((name) => [name, name])].map(([name, label]) => {
    const filter = button(state.filter === name ? 'on' : '', name === '' ? label : undefined, { ws: name });
    if (name !== '') {
      filter.append(wsDot(name), el('span', 'wsname', shortName(name)));
      filter.setAttribute('title', state.filter === name ? 'Show every workspace' : `Show workspace ${name} only`);
    }
    filter.setAttribute('aria-pressed', String(state.filter === name));
    return filter;
  }));
}

// The board (the prototype's renderBoard): the top bar's summary and the five columns. The focus
// stays on the card it was on.
function renderBoard() {
  renderFilter();
  const active = document.activeElement;
  const focused = active !== null && active !== undefined && $('cols').contains(active) && active.classList?.contains('card')
    ? (active.dataset.open !== undefined ? `[data-open="${active.dataset.open}"]` : `[data-ticket="${active.dataset.ticket}"]`) : null;
  const byUpdate = (a, b) => b.updated_at.localeCompare(a.updated_at);
  const jobs = state.jobs.filter((job) => visible(job.workspace)).sort(byUpdate);
  // A failed or aborted job whose ticket is in the Queue is not also in Done.
  const planned = (state.tickets ?? []).filter((row) => visible(row.workspace) && isPlanned(row));
  const plannedKeys = new Set(planned.map(keyOf));
  const lists = { queue: planned, implementing: [], reviewing: [], you: [], done: [] };
  for (const job of jobs) {
    if (RESTARTABLE.includes(job.state) && plannedKeys.has(keyOf(job))) {
      continue;
    }
    lists[COLUMN_OF[job.state] ?? 'done'].push(job);
  }
  board.graph = dependencyGraph();
  if (state.openMenu !== null && !planned.some((row) => keyOf(row) === state.openMenu)) {
    state.openMenu = null;
  }
  for (const column of COLUMNS) {
    const entries = lists[column];
    $(`count-${column}`).textContent = String(entries.length);
    const shown = column === 'done' && !state.doneAll ? entries.slice(0, DONE_LIMIT) : entries;
    const cards = shown.map(column === 'queue' ? queueCard : jobCard);
    $(LIST_OF[column]).replaceChildren(...(cards.length > 0 ? cards : [el('li', 'empty', EMPTY_TEXT[column === 'queue' ? 'planned' : column])]));
  }
  const more = $('done-all');
  more.hidden = lists.done.length <= DONE_LIMIT;
  more.textContent = state.doneAll ? `Show the last ${DONE_LIMIT}` : `Show all ${lists.done.length}`;
  const wait = lists.you.length;
  const running = jobs.filter((job) => RUNNING.includes(job.state)).length;
  $('summary').textContent = `${wait} wait${wait === 1 ? 's' : ''} for you · ${running} running`;
  document.title = `${wait > 0 ? `(${wait}) ` : ''}Software Factory`;
  $('archived-count').textContent = `(${state.archived.length})`;
  let hint = '';
  if (state.workspaces !== null && state.workspaces.length === 0) {
    hint = 'No workspace yet: Workspaces adds the local checkout of a repository to work in.';
  } else if (state.tickets !== null && state.tickets.length === 0 && state.jobs.length === 0) {
    hint = 'No ticket yet: New ticket writes one, and its conversation plans it.';
  }
  $('board-hint').textContent = hint;
  $('board-hint').hidden = hint === '';
  if (focused !== null) {
    document.querySelector(`#cols .card${focused}`)?.focus();
  }
  showRelated();
  showHighlight();
  scheduleRefresh();
}

// The new ticket's card, once the stream lists it (SF-066): scrolled to and focused once; it stays
// highlighted until another ticket is created.
function showHighlight() {
  if (state.highlight === null || state.highlightShown || ui.screen !== 'board') {
    return;
  }
  const card = document.querySelector(`#qlist .card[data-ticket="${state.highlight}"]`);
  if (card !== null) {
    state.highlightShown = true;
    card.scrollIntoView({ block: 'nearest' });
    card.focus();
  }
}

// While a card runs and the page is visible, api/jobs is read again every REFRESH_MS, so the Now
// line and the elapsed time move: one timer, one read at a time; nothing else is polled.
const anyRunning = () => state.jobs.some((job) => visible(job.workspace) && RUNNING.includes(job.state));
function scheduleRefresh() {
  if (state.refresh !== null || !anyRunning() || document.visibilityState === 'hidden') {
    return;
  }
  state.refresh = setTimeout(() => {
    if (document.visibilityState === 'hidden' || !anyRunning()) {
      state.refresh = null;
      return;
    }
    // A jobs event of the stream during the read is newer than its answer.
    const seen = state.jobsSeen;
    getText('api/jobs').then((text) => {
      if (state.jobsSeen === seen) {
        state.jobs = JSON.parse(text).jobs;
      }
    }, () => undefined).finally(() => {
      state.refresh = null;
      renderJobs();
    });
  }, REFRESH_MS);
}

// ---------- The toast (SF-068): the board's messages ----------

// One message at a time, a new one replacing the old: ok and info go after TOAST_MS (not while
// the pointer is on it), errors stay until closed; × and Escape close it.
function toast(outcome) {
  const node = $('toast');
  clearTimeout(state.toastTimer);
  state.toastTimer = null;
  state.toastLevel = outcome?.level ?? null;
  if (outcome === null) {
    node.hidden = true;
    $('toast-text').textContent = '';
    return;
  }
  const alert = outcome.level === 'error' || outcome.level === 'warn';
  node.setAttribute('role', alert ? 'alert' : 'status');
  node.className = alert ? 'err' : '';
  $('toast-text').textContent = outcome.text;
  node.hidden = false;
  armToast();
}

function armToast() {
  if ((state.toastLevel === 'ok' || state.toastLevel === 'info') && !state.toastHover && state.toastTimer === null) {
    state.toastTimer = setTimeout(() => toast(null), TOAST_MS);
  }
}

// ---------- The job page and the routing (the prototype's go, back, openTicket, route, setHash) ----------

// The view shown: 'board', a job's 'stream', 'changes' or 'mr' (ui.job is its key "<ws>/<ticket>"),
// or a planned ticket's page 'ticket' (ui.ticket); ui.opener is the key of the card that opened
// it; pending: the hash names a job or ticket not loaded yet. On the Stream: sel, the selected
// entry (j, k, G), and open, the toggles open.
// related: the card whose dependencies and dependents the board shows (SF-084), or null. On
// Changes (SF-079), cx as the prototype's: the view ('all' or an iteration), the selected file, the
// tree's cursor and rows, the filter, the flat list, the closed folders, the diff layout ('side' or
// 'uni', kept in localStorage), Collapse unchanged, the folds opened, and the path a path link
// opened, checked against its iteration's list once it is read.
const ui = {
  screen: 'board', job: null, ticket: null, opener: null, pending: false, sel: -1, open: new Set(), related: null,
  cx: { view: 'all', sel: null, cursor: null, rows: [], q: '', flat: false, collapsed: new Set(), mode: 'side', collapse: true, unfolded: new Set(), check: null },
};

// The URL hash of the view: #<ws>/<ticket> (the Stream), #<ws>/<ticket>/changes, /mr, /ticket;
// a new one is a new history entry, so Back and Forward move between them.
function setHash() {
  const h = ui.screen === 'board' ? '' : ui.screen === 'ticket' ? `${ui.ticket}/ticket` : ui.screen === 'stream' ? ui.job : `${ui.job}/${ui.screen}`;
  if (decodeURIComponent(location.hash.slice(1)) !== h) {
    history.pushState(null, '', `#${h}`);
  }
}

// The job page's screen (the prototype's renderJobScreen): the header, and the Stream, the Changes
// or the Merge request screen.
function renderJobScreen() {
  renderHead();
  $('scrStream').hidden = ui.screen !== 'stream';
  $('scrChanges').hidden = ui.screen !== 'changes';
  $('scrMr').hidden = ui.screen !== 'mr';
  if (state.detail === null || keyOf(state.detail.job) !== ui.job) {
    return;
  }
  if (ui.screen === 'changes') {
    renderChanges();
  } else if (ui.screen === 'mr') {
    void showMr();
  }
}

// Opens a job's page on a screen; focus 'stop' or 'composer' is where its card's action points;
// confirm ('approve', 'mr-create', 'mr-merge') opens that confirmation once its detail is shown.
// The Merge request screen waits for the MR text (written at Clean).
function go(key, screen = 'stream', focus = undefined, confirm = undefined) {
  if (jobByKey(key) === null) {
    return;
  }
  if (screen === 'mr' && state.detail !== null && keyOf(state.detail.job) === key && state.detail.mr !== true) {
    toast({ level: 'info', text: 'No MR text yet: written at Clean' });
    if (ui.job === key && ui.screen !== 'board') {
      return;
    }
    screen = 'stream';
  }
  if (state.drawer !== null) {
    hideDrawer();
  }
  const fresh = ui.job !== key;
  if (fresh) {
    ui.sel = -1;
    ui.open.clear();
    ui.cx = { ...ui.cx, view: screen === 'changes' ? ui.cx.view : 'all', sel: screen === 'changes' ? ui.cx.sel : null, q: '', collapsed: new Set(), unfolded: new Set(), cursor: null, check: screen === 'changes' ? ui.cx.check : null };
  }
  if (screen !== 'changes') {
    $('scrChanges').replaceChildren();
  }
  ui.screen = screen;
  ui.job = key;
  ui.ticket = null;
  ui.opener = key;
  ui.pending = false;
  $('board').hidden = true;
  $('ticket').hidden = true;
  $('job').hidden = false;
  state.wantConfirm = confirm === undefined ? null : { action: confirm, key };
  select(key);
  renderJobScreen();
  setHash();
  openWantedConfirm();
  state.wantFocus = focus ?? null;
  applyWantedFocus();
  if (screen === 'stream' && state.wantFocus === null && state.confirm === null) {
    $('streamwrap').focus();
  } else if (screen === 'changes') {
    // The selected row, now or once the list arrives.
    const row = document.querySelector('#tlist .trow.sel');
    state.cx.focusTree = row === null;
    row?.focus();
  }
}

// Where a card's button points once the job's detail is shown: the message box, or the primary
// action when the box takes nothing now ('composer'), or the stop block ('stop').
function applyWantedFocus() {
  const focus = state.wantFocus;
  if (focus === null || state.detail === null || keyOf(state.detail.job) !== ui.job) {
    return;
  }
  state.wantFocus = null;
  if (focus === 'composer') {
    const box = $('msg');
    if (!box.disabled && !box.hidden) {
      box.focus();
    } else {
      $('acts').querySelector('.btn.primary')?.focus();
    }
  } else {
    // The stop block may come with the Stream, after the detail.
    const stop = $('stopblock');
    if (stop !== null) {
      stop.scrollIntoView({ block: 'center' });
    } else {
      state.wantFocus = focus;
    }
  }
}

// Back to the board, the focus on the card that opened the page.
function back() {
  if (ui.job !== null) {
    leaveJob();
  }
  if (state.drawer !== null) {
    hideDrawer();
  }
  ui.screen = 'board';
  ui.job = null;
  ui.ticket = null;
  $('job').hidden = true;
  $('ticket').hidden = true;
  $('board').hidden = false;
  renderBoard();
  setHash();
  if (ui.opener !== null) {
    document.querySelector(`#cols .card[data-open="${ui.opener}"], #cols .card[data-ticket="${ui.opener}"]`)?.focus();
  }
}

// The view of the URL hash (on load and on every hashchange). A hash of a job or ticket the board
// does not have shows the board; it is tried again when the jobs and tickets first arrive.
function route() {
  const match = /^([^/]+\/[^/]+?)(?:\/(changes|mr|ticket))?$/.exec(decodeURIComponent(location.hash.slice(1)));
  if (match === null) {
    ui.pending = false;
    if (ui.screen !== 'board') {
      back();
    }
    return;
  }
  const [, key, sub] = match;
  if (sub === 'ticket') {
    const row = ticketByKey(key);
    if (row !== null && isPlanned(row)) {
      if (ui.screen !== 'ticket' || ui.ticket !== key) {
        openTicket(key);
      }
      return;
    }
  } else if (jobByKey(key) !== null) {
    const screen = sub ?? 'stream';
    if (ui.job !== key || ui.screen !== screen) {
      go(key, screen);
    }
    return;
  }
  ui.pending = state.tickets === null;
  if (ui.screen !== 'board') {
    back();
  }
}

// The jobs changed (the stream, a read): the board and the open job's header, its composer and its
// stop; a job page whose job left the board (its ticket archived or deleted) goes back to the board.
function renderJobs() {
  goToStarted();
  if (ui.job !== null && jobByKey(ui.job) === null) {
    back();
    return;
  }
  renderBoard();
  if (ui.job !== null) {
    renderHead();
    renderComposer();
    refreshStop();
  }
}

// The delegated click listener of the top bar, the board, the cards, the job page (its header, the
// Stream and the composer), the planned ticket page (SF-081) and the toast (the drawer keeps its own
// listeners).
function onClick(event) {
  const target = typeof event.target?.closest === 'function'
    ? event.target.closest('[data-tk],[data-tktab],[data-dep],[data-menu],[data-qact],[data-run],[data-open],[data-ticket],[data-back],[data-ws],[data-goto],[data-cfile],[data-changes],[data-fstep],[data-trow],[data-fold],[data-mode],[data-flat],[data-toggle],[data-act],[data-settle],[data-copy-branch],#stream li.e,#done-all,#toast-close,#open-workspaces,#open-new-ticket,#open-archived')
    : null;
  // An open ⋯ menu closes on any click but its own toggle (its items act, then it is closed).
  if (state.openMenu !== null && (target === null || target.dataset.menu === undefined)) {
    setCardMenu(null);
  }
  // A link (a merge request's) goes where it points; it does not open the card around it.
  if (target === null || target.disabled || (typeof event.target.closest === 'function' && event.target.closest('a') !== null)) {
    return;
  }
  if (target.dataset.tk !== undefined) {
    tkAction(target.dataset.tk);
    return;
  }
  if (target.dataset.tktab !== undefined) {
    tkTab(target.dataset.tktab);
    return;
  }
  if (target.dataset.dep !== undefined) {
    showCard(target.dataset.dep);
    return;
  }
  if (target.dataset.menu !== undefined) {
    setCardMenu(state.openMenu === target.dataset.menu ? null : target.dataset.menu);
    return;
  }
  if (target.id === 'done-all') {
    state.doneAll = !state.doneAll;
    renderBoard();
  } else if (target.id === 'toast-close') {
    toast(null);
  } else if (target.id === 'open-workspaces') {
    openWorkspaces();
  } else if (target.id === 'open-new-ticket') {
    openNewTicket();
  } else if (target.id === 'open-archived') {
    openArchived();
  } else if (target.hasAttribute('data-ws')) {
    // A workspace's chip again: back to all.
    state.filter = state.filter === target.dataset.ws ? '' : target.dataset.ws;
    renderBoard();
  } else if (target.dataset.qact !== undefined) {
    queueAction(target.dataset.qact, target.dataset.key);
  } else if (target.dataset.run !== undefined) {
    cardRun(target.dataset.run, target.dataset.key);
  } else if (target.dataset.open !== undefined) {
    go(target.dataset.open, target.dataset.screen ?? 'stream', target.dataset.focus, target.dataset.confirm);
  } else if (target.dataset.ticket !== undefined) {
    openTicket(target.dataset.ticket);
  } else if (target.hasAttribute('data-back')) {
    back();
  } else if (target.dataset.goto !== undefined) {
    if (target.dataset.goto === 'changes') {
      openChanges(null, null);
    } else {
      go(ui.job, target.dataset.goto);
    }
  } else if (target.dataset.cfile !== undefined) {
    openChanges(target.dataset.cfile, target.dataset.cit || null);
  } else if (target.dataset.changes !== undefined) {
    ui.cx.sel = null;
    openChanges(null, target.dataset.changes);
  } else if (target.dataset.fstep !== undefined) {
    fileStep(Number(target.dataset.fstep));
  } else if (target.dataset.trow !== undefined) {
    // A click on the folder under the cursor opens or closes it.
    const row = ui.cx.rows.find((x) => x.id === target.dataset.trow);
    if (row?.type === 'dir' && ui.cx.cursor === row.id) {
      if (row.open) ui.cx.collapsed.add(row.path);
      else ui.cx.collapsed.delete(row.path);
    }
    selectRow(target.dataset.trow, true);
  } else if (target.dataset.fold !== undefined) {
    ui.cx.unfolded.add(target.dataset.fold);
    const body = $('dbody');
    const top = body.scrollTop;
    renderDiffPane();
    body.scrollTop = top;
  } else if (target.dataset.mode !== undefined) {
    ui.cx.mode = target.dataset.mode === 'uni' ? 'uni' : 'side';
    store.set(DIFF_MODE_KEY, ui.cx.mode);
    renderDiffPane();
  } else if (target.dataset.flat !== undefined) {
    ui.cx.flat = target.dataset.flat === '1';
    renderChanges();
  } else if (target.dataset.toggle !== undefined) {
    toggle(target.dataset.toggle);
  } else if (target.dataset.act !== undefined) {
    act(target.dataset.act);
  } else if (target.dataset.settle !== undefined) {
    const [id, decision] = target.dataset.settle.split(':');
    settle(id, decision);
  } else if (target.hasAttribute('data-copy-branch')) {
    const job = shownJob();
    if (job !== null) {
      copyValue(`git checkout ${job.branch}`, $('checkout-text'), (text) => toast({ level: 'info', text: `${text} git checkout ${job.branch}` }));
    }
  } else if (target.matches('#stream li.e')) {
    ui.sel = entries().indexOf(target);
    markSel(false);
  }
}

// What typing in the job page keeps: the draft of the message box (and Send follows it), a note on
// a ledger entry.
function onInput(event) {
  const target = event.target;
  if (target?.id === 'tkText' && ui.screen === 'ticket') {
    // The planned ticket page's editor: Unsaved changes and Save follow it.
    const s = tkState(ui.ticket);
    s.text = target.value;
    const bar = $('ticket').querySelector('.edtabs');
    bar?.replaceWith(tkTabs(ui.ticket, s));
    return;
  }
  if (target?.id === 'msg') {
    if (state.key !== null) {
      state.drafts.set(state.key, target.value);
    }
    renderComposer();
  } else if (typeof target?.dataset?.note === 'string') {
    state.notes.set(noteKey(target.dataset.note), target.value);
  } else if (target?.id === 'cxq') {
    // The Changes filter: the tree follows; the diff shows the first match when the selected file is filtered out.
    ui.cx.q = target.value;
    renderTree(false);
    const { files } = visibleFiles();
    if (!files.some((f) => f.path === ui.cx.sel)) {
      ui.cx.sel = files[0]?.path ?? null;
    }
    renderDiffPane();
  }
}

// The Changes screen's selector and Collapse unchanged.
function onChange(event) {
  const target = event.target;
  if (target?.id === 'cxview') {
    ui.cx.view = target.value === 'all' ? 'all' : Number(target.value);
    renderChanges();
  } else if (target?.id === 'cxcollapse') {
    ui.cx.collapse = target.checked;
    renderDiffPane();
  }
}

// The delegated keys: j and k move between the board's cards, Enter opens the focused one. On a
// job page: Escape closes an open confirmation, then goes back one level (a screen of the job to
// its Stream, the Stream to the board); c, m and s switch the screens; on the Stream j and k select
// an entry, G the last, Enter toggles the selected one; Ctrl+Enter in the message box sends.
// Escape closes the toast first. Alt+Up and Alt+Down move a queued card with SF-071's queue. On
// Changes (SF-079): / the filter (Arrow Down or Enter in it goes to the tree), the tree's keys
// (treeKey), F7 / Shift+F7 and n / p the next and previous file, Arrow Left and Right on the
// divider its width.
function onKey(event) {
  if (event.defaultPrevented) {
    return;
  }
  const target = event.target;
  if (target?.id === 'vdiv' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    dividerKey(event);
    return;
  }
  // The planned ticket page (SF-081): Ctrl+S saves while editing.
  if (ui.screen === 'ticket' && (event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 's' || event.key === 'S') && TK[ui.ticket]?.tab === 'edit') {
    event.preventDefault();
    tkAction('save');
    return;
  }
  if (typeof target?.closest === 'function' && target.closest('textarea, input, select') !== null) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && target.id === 'msg') {
      event.preventDefault();
      act('say');
    } else if (event.key === 'Escape' && ui.screen !== 'board') {
      target.blur();
    } else if (target.id === 'cxq' && (event.key === 'ArrowDown' || event.key === 'Enter')) {
      event.preventDefault();
      document.querySelector('#tlist .trow.sel')?.focus();
    }
    return;
  }
  if (event.key === 'F7') {
    if (ui.screen === 'changes' && state.drawer === null) {
      event.preventDefault();
      fileStep(event.shiftKey ? -1 : 1);
    }
    return;
  }
  if (event.key === 'Escape' && !$('toast').hidden) {
    event.preventDefault();
    toast(null);
    return;
  }
  // The drawer and the ticket confirmation handle their own keys.
  if (state.drawer !== null || state.ticketConfirm !== null || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  if (ui.screen === 'board' && event.key === 'Escape' && (state.openMenu !== null || ui.related !== null)) {
    // SF-084: Escape closes a card's ⋯ menu (the focus back on its toggle), else clears the highlight.
    event.preventDefault();
    const menu = state.openMenu;
    if (menu !== null) {
      setCardMenu(null);
      cardOf(menu)?.querySelector('[data-menu]')?.focus();
    } else {
      relate(null);
    }
    return;
  }
  if (ui.screen === 'board') {
    const cards = [...document.querySelectorAll('#cols .card')];
    const at = cards.indexOf(document.activeElement);
    if (event.key === 'j' || event.key === 'k') {
      event.preventDefault();
      cards[Math.min(cards.length - 1, Math.max(0, at + (event.key === 'j' ? 1 : -1)))]?.focus();
    } else if (event.key === 'Enter' && document.activeElement?.classList?.contains('card')) {
      const card = document.activeElement;
      if (card.dataset.open !== undefined) {
        go(card.dataset.open, 'stream');
      } else if (card.dataset.ticket !== undefined) {
        openTicket(card.dataset.ticket);
      }
    }
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    if (state.confirm !== null) {
      closeConfirm();
    } else if (ui.screen === 'changes' || ui.screen === 'mr') {
      go(ui.job, 'stream');
    } else {
      back();
    }
    return;
  }
  if (ui.job === null) {
    return;
  }
  if (event.key === 'c' && ui.screen !== 'changes') {
    event.preventDefault();
    openChanges(ui.cx.sel, null);
  } else if (event.key === 'm' && ui.screen !== 'mr') {
    event.preventDefault();
    go(ui.job, 'mr');
  } else if (event.key === 's' && ui.screen !== 'stream') {
    event.preventDefault();
    go(ui.job, 'stream');
  } else if (ui.screen === 'stream') {
    const all = entries();
    if (event.key === 'j' || event.key === 'k') {
      event.preventDefault();
      ui.sel = ui.sel < 0 ? (event.key === 'j' ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, ui.sel + (event.key === 'j' ? 1 : -1)));
      markSel(true);
    } else if (event.key === 'G') {
      event.preventDefault();
      ui.sel = all.length - 1;
      markSel(true);
    } else if (event.key === 'Enter' && ui.sel >= 0 && document.activeElement?.tagName !== 'BUTTON') {
      const toggleOf = all[ui.sel]?.querySelector('[data-toggle]');
      if (toggleOf !== null && toggleOf !== undefined) {
        event.preventDefault();
        toggle(toggleOf.dataset.toggle);
      }
    }
  } else if (ui.screen === 'changes') {
    if (event.key === '/') {
      event.preventDefault();
      $('cxq')?.focus();
    } else if (event.key === 'n' || event.key === 'p') {
      event.preventDefault();
      fileStep(event.key === 'n' ? 1 : -1);
    } else if (!(typeof target?.closest === 'function' && target.closest('#dbody') !== null && (event.key === 'ArrowUp' || event.key === 'ArrowDown'))) {
      treeKey(event);
    }
  }
}

// The buttons of a Queue card (and Archive ticket of a pushed card).
function queueAction(action, key) {
  const row = ticketByKey(key);
  if (row === null) {
    return;
  }
  if (action === 'start' || action === 'delete') {
    openTicketConfirm(action, row);
  } else if (action === 'check') {
    void checkTicket(row);
  } else if (action === 'archive') {
    void ticketAction('archive', row);
  }
}

// Retry review and Resume of a Your turn card: posted at once, once.
function cardRun(action, key) {
  const job = jobByKey(key);
  if (job === null || availability(action, job) !== '' || (action === 'review' && !reviewFailed(job))) {
    return;
  }
  void run(action, key, {});
}

// ---------- Markdown preview (the prototype's md and inl, as DOM nodes) ----------

// Inline Markdown as nodes: `code`, **bold**, *italic* and [text](http(s) link); anything else is
// text. Never HTML from the text; a link opens only an http(s) URL, in a new tab.
const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*\n]+)\*\*|(?<![*\w])\*([^*\n]+)\*(?!\w)/g;
function inl(text) {
  const value = String(text);
  const nodes = [];
  let at = 0;
  for (const match of value.matchAll(INLINE)) {
    if (match.index > at) {
      nodes.push(document.createTextNode(value.slice(at, match.index)));
    }
    const [, code, label, href, bold, italic] = match;
    if (code !== undefined) {
      nodes.push(el('code', '', code));
    } else if (label !== undefined) {
      const link = el('a', '', label);
      link.href = href;
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

// A Markdown text as a div.md: headings (# to ####), lists and task lists, code fences, tables
// and paragraphs, their text through inl. mark(line, body) may give a list item a class.
function md(text, mark) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const out = el('div', 'md');
  let list = null;
  let para = [];
  const withText = (node, value) => {
    node.append(...inl(value));
    return node;
  };
  const flushP = () => {
    if (para.length > 0) {
      out.append(withText(el('p'), para.join(' ')));
      para = [];
    }
  };
  const closeL = () => {
    list = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushP();
      closeL();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
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
      out.append(withText(el(`h${heading[1].length}`), heading[2]));
      i += 1;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flushP();
      closeL();
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i]);
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
      const kind = /\d/.test(item[2]) ? 'OL' : 'UL';
      if (list === null || list.tagName !== kind) {
        list = el(kind.toLowerCase());
        out.append(list);
      }
      let body = item[3];
      i += 1;
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        body += ` ${lines[i].trim()}`;
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
function fmParse(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const fm = {};
  if (match !== null) {
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^(\w+):\s*(.*)$/.exec(line);
      if (kv !== null) {
        fm[kv[1]] = kv[2].trim();
      }
    }
  }
  return { fm, body: match !== null ? text.slice(match[0].length) : text };
}

// ---------- The planned ticket page (SF-081, the prototype's renderTicket, tkState, tkHistory, tkAction) ----------

// What the page keeps per ticket while the dashboard is open: the editor's text, the text and the
// sha256 of the version it started from (Save sends it; another version on disk is task_changed),
// the tab, whether the paraphrase is shown whole, whether this page saved it, and a conflict.
const TK = {};
// The words of a finding's kind and of a dependency's state (SF-084's states).
const KIND_WORD = { decision: 'needs a decision', contradiction: 'contradicts itself', missing: 'something is missing', overreach: 'does more than asked', unclear: 'unclear' };
const WAIT_WORD = { merged: 'merged', pushed: 'pushed, not merged yet', running: 'running', planned: 'planned, not started', missing: 'unknown ticket' };
const waitWord = (stateName) => WAIT_WORD[stateName] ?? WAIT_WORD.missing;
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
};
// "Nov 5, 14:03" of a timestamp, in the browser's time (the prototype's day); empty without one.
const day = (ts) => (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))
  ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '');

// The page's state of a ticket (TK), made from the page's Task file the first time.
function tkState(key) {
  if (TK[key] === undefined) {
    const task = state.tk.data?.task ?? { text: '', sha256: '' };
    TK[key] = { text: task.text, saved: task.text, sha256: task.sha256, tab: 'preview', showPara: false, edited: false, conflict: false };
  }
  return TK[key];
}

// The page's History, newest first, as the factory recorded and read it (src/ticket-history.ts).
function tkHistory() {
  return Array.isArray(state.tk.data?.history) ? state.tk.data.history : [];
}

// The ticket's row: the board's, which the stream keeps current, else the page's.
const tkRow = () => ticketByKey(ui.ticket) ?? state.tk.data?.ticket ?? null;
const tkDirty = (s) => s.text !== s.saved;
const tkChecking = (key, view) => state.setupPending.has(`check:${key}`) || view?.running === true;
// The dependencies not merged yet, from the page's plan.
const tkUnmerged = () => (state.tk.data?.plan?.waits_for ?? []).filter((dep) => dep.merged !== true);
// The only link the page makes of the conversation: the server's ChatGPT URL.
const tkConversationUrl = (row) => (typeof row?.conversation?.url === 'string' && row.conversation.url.startsWith(CHATGPT_PREFILL_URL) ? row.conversation.url : null);

// Opens a planned ticket's page (the prototype's openTicket): the page is read from
// api/tickets/<ws>/<ticket>/page; a ticket that is not planned any more goes back to the board.
function openTicket(key) {
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
    state.tk = { key, data: null, check: null, error: null, load: null, textarea: null, copied: null };
  }
  ui.screen = 'ticket';
  ui.ticket = key;
  ui.job = null;
  ui.opener = key;
  ui.pending = false;
  $('job').hidden = true;
  $('board').hidden = true;
  $('ticket').hidden = false;
  renderTicket();
  setHash();
  $('ticket').querySelector('[data-back]')?.focus();
  void loadTicket(key, false);
}

// Reads the page's payload. The editor keeps unsaved changes and the version they started from;
// without changes (or with reset, the conflict's Reload) it follows the file.
async function loadTicket(key, reset) {
  const load = {};
  state.tk.load = load;
  let response = null;
  let data = null;
  let failure = null;
  try {
    response = await fetch(`api/tickets/${jobPath(key)}/page`, { cache: 'no-store' });
    data = response.ok ? await response.json() : null;
  } catch (error) {
    failure = error.message;
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
  if (failure !== null || data === null || typeof data !== 'object' || typeof data.task?.text !== 'string') {
    state.tk.error = failure !== null ? `The ticket could not be read (${failure}).` : `The ticket could not be read (HTTP ${response.status}).`;
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

// The tickets changed (the stream): the page follows its row (title, draft, check, dependencies),
// reads the check again, so a check that ends while the page is open shows at once, and reads the
// page again (a plan written meanwhile, its history; unsaved edits stay, with the version they
// started from). A ticket that left the Queue goes back to the board, unless its start is on the
// way to its job.
function refreshTicket() {
  if (ui.screen !== 'ticket' || state.tk.data === null) {
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
  for (const dep of state.tk.data.plan?.waits_for ?? []) {
    const fresh = (row.lands_after ?? []).find((other) => (other.workspace === row.workspace ? other.ticket : keyOf(other)) === dep.ticket);
    if (fresh !== undefined) {
      dep.state = fresh.state;
      dep.merged = fresh.state === 'merged';
    }
  }
  state.tk.data.ticket = row;
  renderTicket();
  void tkReadCheck(key);
  if (state.tk.load === null) {
    void loadTicket(key, false);
  }
}

// GET api/tickets/<ws>/<ticket>/check: the check as it is now (none without the Task checks).
async function tkReadCheck(key) {
  if (state.tk.data?.check === null) {
    return;
  }
  const view = await readCheck(key);
  if (view !== null && ui.screen === 'ticket' && ui.ticket === key && state.tk.data !== null) {
    state.tk.check = view;
    renderTicket();
  }
}

// The counts of a check's findings by severity (the job's Task toggle counts with it too).
function tkCounts(output) {
  const counts = { blocker: 0, major: 0, nit: 0 };
  for (const item of output?.findings ?? []) {
    counts[item.severity] = (counts[item.severity] ?? 0) + 1;
  }
  return counts;
}

// The plan check in words, as the header's line says it; empty without the Task checks.
function tkCheckWord(row, view) {
  if (view === null) {
    return '';
  }
  if (row.draft) {
    return 'Plan not written yet';
  }
  if (tkChecking(keyOf(row), view)) {
    return 'Checking the plan…';
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
function tkHead(key, row, view) {
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
  t2.append(el('span', '', `Starts from ${state.tk.data?.plan?.starts_from ?? row.base}`));
  const word = tkCheckWord(row, view);
  if (word !== '') {
    t2.append(el('span', '', word));
  }
  const head = el('header', 'jhead');
  head.append(backButton, t1, tools, t2);
  return head;
}

// The editor, kept across redraws so the caret and the scroll stay.
function tkTextarea(key, s) {
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
function tkTabs(key, s) {
  const bar = el('div', 'edtabs');
  bar.setAttribute('role', 'tablist');
  for (const [tab, text] of [['edit', 'Edit'], ['preview', 'Preview']]) {
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
function tkFileCard(key, row, s) {
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
function tkCard(title, help, ...content) {
  const card = el('div', 'card2');
  card.append(typeof title === 'string' ? el('h3', '', title) : title, ...content);
  if (help !== null) {
    card.append(el('span', 'hint', help));
  }
  return card;
}

// Files it will change: scope and may_touch in one list, one path or pattern per row, 🔒 on a
// may_touch one.
function tkFiles(plan) {
  const nodes = [];
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
function tkFilesHelp(plan) {
  if (plan.scoped) {
    return TK_HELP.files;
  }
  return plan.files.some((file) => file.sensitive) ? TK_HELP.lock : null;
}

// Waits for: each ticket with its state in words, ✓ once merged.
function tkWaits(plan) {
  if (plan.waits_for.length === 0) {
    return [el('span', 'fs13', TK_HELP.noWaits)];
  }
  return plan.waits_for.map((dep) => {
    const row = el('div', 'dep');
    row.append(el('span', dep.merged ? 'ok' : 'wait', dep.merged ? '✓' : '◷'), el('span', 'mono', dep.ticket), el('span', 'muted', waitWord(dep.state)));
    return row;
  });
}

// The Plan check card: the result in words, the findings with their kind in words, what the checker
// understood (clamped) and the files it expects to change; the date, model and cost.
function tkCheckCard(key, row, view, s) {
  const record = view.check;
  const output = record?.output ?? null;
  const failed = record !== null && (output === null || record.status === 'failed');
  const h3 = el('h3', '', 'Plan check ');
  if (record === null) {
    h3.append(el('span', 'tag', 'not checked'));
  } else {
    h3.append(failed ? el('span', 'verdict stop', 'failed') : output.verdict === 'ready' ? el('span', 'verdict clean', 'ready') : el('span', 'verdict fix', 'not ready'));
    if (view.stale) {
      const stale = el('span', 'tag', 'stale');
      stale.setAttribute('title', 'The Task file changed after this check');
      h3.append(stale);
    }
  }
  const content = [];
  const checking = tkChecking(key, view);
  if (checking) {
    content.push(el('p', 'fs13', 'Checking… a read-only session reads the plan and the code.'));
  }
  if (record === null) {
    if (!checking) {
      content.push(el('p', 'fs13', row.draft ? 'Not checked yet. The plan is checked once the Context owner has written it.' : 'Not checked yet.'));
    }
    return tkCard(h3, TK_HELP.check, ...content);
  }
  if (view.stale) {
    content.push(el('p', 'fs13 err-text', 'The plan changed after this check: check it again.'));
  }
  if (failed) {
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
  content.push(el('span', 'muted fs12', `${day(record.ended_at)} · ${record.model ?? 'default model'} · ${money(record.cost_usd)}`));
  return tkCard(h3, TK_HELP.check, ...content);
}

// Planning conversation: the link, the first message and its Copy.
function tkConversation(row) {
  const url = tkConversationUrl(row);
  const message = typeof row.conversation?.message === 'string' ? row.conversation.message : '';
  const content = [];
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
function tkHistoryCard() {
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
function renderTicket() {
  if (ui.screen !== 'ticket') {
    return;
  }
  const key = ui.ticket;
  const page = $('ticket');
  const row = tkRow();
  if (row === null) {
    return;
  }
  const data = state.tk.data;
  const box = state.tk.textarea;
  const typing = box !== null && box !== undefined && document.activeElement === box;
  const caret = typing && typeof box.selectionStart === 'number' ? [box.selectionStart, box.selectionEnd, box.scrollTop] : null;
  const view = data === null ? null : state.tk.check;
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
    side.append(tkConversation(row), tkHistoryCard());
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
function tkAction(action) {
  const key = ui.ticket;
  const row = tkRow();
  if (ui.screen !== 'ticket' || row === null) {
    return;
  }
  if (action === 'save') {
    void tkSave(key);
  } else if (action === 'check') {
    if (!row.draft && !tkChecking(key, state.tk.check)) {
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
    copyValue(message, $('tk-copy-text'), (text) => {
      state.tk.copied = text;
      if (ui.screen === 'ticket' && ui.ticket === key) {
        renderTicket();
      }
    });
  }
}

// Edit | Preview: the editor gets the focus.
function tkTab(tab) {
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
async function tkSave(key) {
  const s = tkState(key);
  const id = `save:${key}`;
  if (!tkDirty(s) || state.setupPending.has(id)) {
    return;
  }
  state.setupPending.add(id);
  renderTicket();
  const text = s.text;
  let outcome;
  let saved = false;
  try {
    const result = await post(`api/tickets/${jobPath(key)}/task`, { content: text, sha256: s.sha256 });
    s.saved = text;
    s.sha256 = typeof result?.sha256 === 'string' ? result.sha256 : s.sha256;
    s.edited = true;
    s.conflict = false;
    saved = true;
    const checked = state.tk.check !== null && state.tk.check.check !== null;
    outcome = { level: 'ok', text: `Saved .software-factory/${key.slice(key.indexOf('/') + 1)}.md.${checked ? ' The last plan check is of the version before: check it again.' : ''}` };
  } catch (error) {
    if (error instanceof ActionError && error.code === 'task_changed') {
      s.conflict = true;
      outcome = { level: 'error', text: 'Not saved: the Task file changed since this page read it. Reload it to edit the current version.' };
    } else if (error instanceof ActionError) {
      outcome = { level: 'error', text: `${error.code}: ${error.message}` };
    } else {
      outcome = { level: 'error', text: `The save failed (${error.message}); it may have been written. Reload the page to see the file as it is.` };
    }
  }
  state.setupPending.delete(id);
  toast(outcome);
  renderTicket();
  if (saved && ui.screen === 'ticket' && ui.ticket === key) {
    void loadTicket(key, false);
  }
}

// ---------- The drawer: Workspaces, New ticket, Archived and an archived ticket's Task ----------

// The job opens as its page (#job), a planned ticket as its page (#ticket, SF-081); the drawer stays
// for the setup panels and an archived ticket's Task.
const PANELS = { task: 'task-panel', workspaces: 'workspaces-panel', ticket: 'ticket-panel', archived: 'archived-panel' };

function showDrawer(kind, kicker, title) {
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

function hideDrawer() {
  state.drawer = null;
  state.task = null;
  $('drawer').hidden = true;
  $('scrim').hidden = true;
}

// The drawer's ✕, its scrim and Escape.
function closeDrawer() {
  if (state.drawer === null) {
    return;
  }
  hideDrawer();
  renderBoard();
}

// The job page closes: no job is followed any more; drafts and outcomes stay with their jobs.
function leaveJob() {
  closeConfirm();
  state.key = null;
  state.detail = null;
  state.wantConfirm = null;
  state.wantFocus = null;
  state.streamLoad = null;
  openStream();
}

function openWantedConfirm() {
  const wanted = state.wantConfirm;
  if (wanted === null || state.detail === null || keyOf(state.detail.job) !== wanted.key) {
    return;
  }
  state.wantConfirm = null;
  openConfirm(wanted.action);
}

// An archived ticket's Task text in the drawer, as text: headings bold by a line rule, never HTML
// from the file. A planned ticket opens as its page (SF-081).
async function openTask(row) {
  const key = `${row.workspace}/${row.ticket}`;
  const task = { key };
  showDrawer('task', `${row.workspace} · .software-factory/archive/${row.ticket}.md`, `${row.ticket} · ${row.title}`);
  state.task = task;
  $('task-body').replaceChildren(document.createTextNode('Loading the Task file…'));
  let text;
  try {
    text = await getText(`api/tickets/${jobPath(key)}/task?archived=1`);
  } catch (error) {
    text = `Could not load the Task file: ${error.message}`;
  }
  if (state.task === task) {
    $('task-body').replaceChildren(...renderReport(text));
  }
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
  renderTicket();
}

function renderWorkspaces() {
  const rows = state.workspaces ?? [];
  $('no-workspaces').hidden = state.workspaces === null || rows.length > 0;
  $('workspace-list').replaceChildren(...rows.map((row) => {
    const item = el('li');
    const name = el('div', 'ws-name');
    name.append(wsDot(row.name), document.createTextNode(row.name));
    item.append(name);
    item.append(el('div', 'ws-path', row.path));
    if (row.problem) {
      item.append(el('div', 'ws-problem', row.problem));
    }
    // The workspace's own hand-over setting (SF-083), or SF_HANDOFF's.
    item.append(el('div', 'ws-handoff hint', row.handoff === 'checkout' || row.handoff === 'off' ? `Hand-over: ${row.handoff} (this workspace)` : 'Hand-over: as SF_HANDOFF'));
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
    task.addEventListener('click', () => void openTask(row));
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

// A status line of a form in the drawer, or the board's message ('toast').
function setSetupStatus(id, outcome) {
  if (id === 'toast') {
    toast(outcome);
    return;
  }
  const node = $(id);
  node.className = outcome === null ? 'status' : `status ${outcome.level}`;
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
  // The workspace's own hand-over setting (SF-083); empty: SF_HANDOFF applies. Its colour on the
  // board (SF-084); empty: the server picks one by its name.
  const handoff = $('workspace-handoff').value;
  const color = $('workspace-color').value;
  if (name === '' || path === '') {
    setSetupStatus('workspace-status', { level: 'error', text: 'A name and the path of the local checkout are needed.' });
    return;
  }
  const result = await setupRequest('workspace', 'api/workspaces', { name, path, ...(handoff !== '' ? { handoff } : {}), ...(color !== '' ? { color } : {}) }, 'workspace-status', (data) =>
    ({ level: 'ok', text: `Registered ${data.name} (${data.path}). Next: New ticket.` }));
  if (result !== undefined) {
    $('workspace-name').value = '';
    $('workspace-path').value = '';
    $('workspace-handoff').value = '';
    $('workspace-color').value = '';
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
  const describe = (data) => ({ level: 'ok', text: `Ticket created: ${data.path} in ${data.workspace} (base ${data.base}), an empty skeleton in the Queue. Next: a click on its card opens the conversation; your words are its first message.` });
  const result = await setupRequest('ticket', 'api/tickets', { workspace, ticket, title, request }, 'ticket-status', describe);
  // Created (SF-066): the dialog closes and the new ticket's card is highlighted (a click on it
  // opens its page); a failure keeps the dialog open with the error and the input.
  if (result !== undefined) {
    $('ticket-key').value = '';
    $('ticket-title').value = '';
    $('ticket-request').value = '';
    setSetupStatus('ticket-status', null);
    state.highlight = `${result.workspace ?? workspace}/${result.ticket ?? ticket}`;
    state.highlightShown = false;
    closeDrawer();
    toast(describe(result));
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
  await setupRequest(id, `api/tickets/${jobPath(key)}/${action}`, {}, 'toast', (data) => ({ level: 'ok', text: texts[action](data ?? {}) }));
}

// Start and Delete ask first: Start names the workspace, the ticket and the base branch; Delete
// cannot be undone. extra: what the planned ticket page adds to Start's text (what it waits for).
function openTicketConfirm(action, row, extra = '') {
  const key = `${row.workspace}/${row.ticket}`;
  if (state.ticketConfirm !== null) {
    return;
  }
  state.ticketConfirm = { action, key, row };
  if (action === 'start') {
    $('ticket-confirm-title').textContent = `Start ${row.ticket} in ${row.workspace}?`;
    // The Task check only advises (SF-054): its note is part of the text, Start stays on.
    const note = typeof row.check?.start_note === 'string' ? ` Task check: ${row.check.start_note}.` : '';
    $('ticket-confirm-text').textContent = `Starts a job on .software-factory/${row.ticket}.md of workspace ${row.workspace}: a new branch from ${row.base} in its own worktree, where the Implementer runs iteration 1. Claude reviews it, the Codex gate checks it, and the branch comes back to you to approve.${note}${extra}`;
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
  renderTicket();
  $('ticket-cancel').focus();
}

function closeTicketConfirm() {
  state.ticketConfirm = null;
  $('ticket-confirm').hidden = true;
  renderBoard();
  renderArchived();
  renderTicket();
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
  setSetupStatus('toast', { level: 'pending', text: `Starting ${key}: creating the branch and its worktree…` });
  renderBoard();
  renderTicket();
  let outcome;
  let unknown;
  // Started from its planned ticket page (SF-081): the page goes to the new job's Stream, whether
  // the stream brings the job before or after this answer.
  if (ui.screen === 'ticket' && ui.ticket === key) {
    state.goAfterStart = key;
  }
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
  if (outcome?.level !== 'ok' && state.goAfterStart === key) {
    state.goAfterStart = null;
  }
  if (unknown !== undefined) {
    await holdStart(key, unknown);
    return;
  }
  setSetupStatus('toast', outcome);
  renderBoard();
  renderTicket();
  goToStarted();
}

// The page of a ticket started from it moves to the job's Stream once the new job is on the board
// (the stream's jobs event may come before or after Start's answer); an earlier failed or aborted
// job of the ticket is not it.
function goToStarted() {
  const key = state.goAfterStart;
  const job = key === null ? null : jobByKey(key);
  if (job === null || TERMINAL_STATES.includes(job.state)) {
    return;
  }
  state.goAfterStart = null;
  if (ui.screen === 'ticket' && ui.ticket === key) {
    go(key, 'stream');
  }
}

// The start may have created the job: Start stays off for the ticket until api/jobs is read
// after this moment (or, when that read fails, until the stream's next jobs event); the page
// sends nothing by itself.
async function holdStart(key, reason) {
  const hold = { reason, failed: false };
  state.startHolds.set(key, hold);
  const lead = `The start of ${key} failed (${reason}). Its outcome is unknown: the job may have started`;
  setSetupStatus('toast', { level: 'error', text: `${lead}; the board is being read again.` });
  renderBoard();
  let jobs;
  try {
    jobs = JSON.parse(await withinTime(getText('api/jobs'))).jobs;
  } catch (error) {
    if (state.startHolds.get(key) === hold) {
      hold.failed = true;
      setSetupStatus('toast', { level: 'error', text: `${lead}, and the board could not be read (${error.message}). Start stays off for ${key} until the page reconnects; check the board before starting again.` });
    }
    return;
  }
  if (state.startHolds.get(key) !== hold) {
    return;
  }
  state.startHolds.delete(key);
  state.jobs = jobs;
  setSetupStatus('toast', { level: 'error', text: `${lead}. The board is current: check it before starting again.` });
  renderBoard();
}

// ---------- The stream ----------

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
  // A job's stream resumes at the next line to read: after the pages, after a reconnect.
  if (state.key !== null) {
    params.set('job', state.key);
    params.set('from', String(state.lastLine));
  }
  const key = state.key;
  const source = new EventSource(`api/stream?${params}`);
  state.source = source;
  source.addEventListener('open', () => setConnection('live', 'live'));
  source.addEventListener('jobs', (message) => {
    state.jobs = JSON.parse(message.data).jobs;
    state.jobsSeen += 1;
    // A start whose board read failed is settled by this one.
    for (const [ticket, hold] of state.startHolds) {
      if (hold.failed) {
        state.startHolds.delete(ticket);
      }
    }
    renderJobs();
    if (ui.pending) {
      route();
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
    state.jobLandsAfter = Array.isArray(data.job_lands_after) ? data.job_lands_after : [];
    renderSetup();
    if (ui.job !== null) {
      renderHead();
    }
    refreshTicket();
    if (ui.pending) {
      route();
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
  // The Stream's entries of one line (SF-082), as a page gives them.
  source.addEventListener('entries', (message) => {
    const data = JSON.parse(message.data);
    if (key === state.key && Number.isInteger(data.line)) {
      state.lastLine = Math.max(state.lastLine, data.line + 1);
      showEntries(data.entries);
    }
  });
  source.addEventListener('error', () => {
    // Reconnect ourselves after 3 s, resuming at the next line to read.
    source.close();
    if (state.source === source) {
      state.source = null;
      setConnection('reconnecting', 'down');
      state.retry = setTimeout(openStream, RECONNECT_MS);
    }
  });
}

// Follows one job: its detail, its Stream (read page by page, then live) and its controls.
function select(key) {
  if (key === state.key) {
    return;
  }
  state.key = key;
  state.detail = null;
  state.cache = new Map();
  state.cx = cxData();
  state.taskView = null;
  state.mrText = null;
  state.lastLine = 0;
  state.entries = [];
  state.seen = new Set();
  state.stopSig = null;
  renderStream();
  $('scrChanges').replaceChildren();
  $('mr-panel').hidden = true;
  $('mr-unapplied').hidden = true;
  $('checkout-text').hidden = true;
  $('mr-copy-text').hidden = true;
  $('mr-copy-status').textContent = '';
  // The controls go off until this job's detail arrives; its draft and last outcome come back.
  closeConfirm();
  $('msg').value = state.drafts.get(key) ?? '';
  renderOutcome(state.outcomes.get(key) ?? null);
  $('action-doubt').textContent = state.doubts.get(key) ?? '';
  renderComposer();
  void loadStream(key);
}

function init() {
  // Back and Forward of the browser, and a link to a job or ticket.
  window.addEventListener('hashchange', route);

  // The new parts (the top bar, the board, the cards, the routing, the keys, the toast): one
  // delegated listener each.
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  document.addEventListener('mouseover', onCardHover);
  document.addEventListener('focusin', onCardHover);
  document.addEventListener('focusout', onCardBlur);
  $('cols').addEventListener('mouseleave', () => relate(null));
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('pointerdown', onDividerDown);
  // The diff layout chosen before (SF-079).
  const mode = store.get(DIFF_MODE_KEY);
  if (mode === 'side' || mode === 'uni') {
    ui.cx.mode = mode;
  }
  document.addEventListener('visibilitychange', scheduleRefresh);
  $('toast').addEventListener('mouseenter', () => {
    state.toastHover = true;
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
  });
  $('toast').addEventListener('mouseleave', () => {
    state.toastHover = false;
    armToast();
  });

  // The drawer.
  $('drawer-close').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  $('drawer').addEventListener('keydown', (event) => {
    // An Escape that closed a confirmation inside stops there.
    if (event.key === 'Escape' && event.defaultPrevented !== true) {
      closeDrawer();
    }
  });

  // The job page: the composer's confirmation (its buttons go through the delegated listener),
  // the Merge request screen's Copy MR text and Refresh state of an unknown outcome.
  $('confirm-ok').addEventListener('click', submitConfirm);
  $('confirm-cancel').addEventListener('click', closeConfirm);
  $('confirm').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.confirm !== null) {
      event.preventDefault();
      closeConfirm();
    }
  });
  $('discard').addEventListener('change', renderConfirmButton);
  $('as-is').addEventListener('change', renderConfirmButton);
  $('keep-files').addEventListener('change', renderConfirmButton);
  $('mr-copy').addEventListener('click', () => {
    if (typeof state.mrText === 'string') {
      copyValue(mrCopyText(state.mrText), $('mr-copy-text'), (text) => {
        $('mr-copy-status').textContent = text;
      });
    }
  });
  $('refresh-button').addEventListener('click', () => void settleUnknown(state.key));

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
    route();
    if (ui.job === null) {
      openStream();
    }
  }, () => {
    setConnection('reconnecting', 'down');
    state.retry = setTimeout(load, RECONNECT_MS);
  });
}

document.addEventListener('DOMContentLoaded', init);
