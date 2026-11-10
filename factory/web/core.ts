// core.js, the first of the dashboard's scripts (DASHBOARD_SCRIPTS in src/dashboard.ts), built from
// web/core.ts into dist/web/: the constants, the state, the small DOM, format and HTTP
// helpers. Each of the dashboard's scripts is a classic script, loaded in order with defer, and
// shares the page's globals with the others. This file has no import or export on purpose: the
// compiler keeps it a script, so its top-level names stay the page's globals.

// Software Factory dashboard v3, the port of docs/design/dashboard-v3/prototype.html:
// the top bar (header.js: what waits for the user, the pages, the workspace filter, the factory
// pill with the health checks, the run limit and the reset rule, and New ticket), the board's
// five columns Queue, Implementing, Reviewing, Your turn and Done, whose cards say who acts now, why
// a job stopped (one table, STOPS) and carry one primary action only where the user acts, and the
// full pages a card opens: a job's page at #<ws>/<ticket> (/changes, /mr) and a planned ticket's
// page at #<ws>/<ticket>/ticket (the Task file to preview, edit and save, the plan in plain
// words, its check, the conversation and the history, read from api/tickets/<ws>/<ticket>/page). The
// job's page: its
// header with the screen switch, and the Stream, one chronological list of the job's entries
// (read page by page from api/jobs/<ws>/<ticket>/stream, then live from the stream's entries
// events), with its stop block and the composer pinned at the bottom; the Changes screen:
// the file tree and the side-by-side or unified diff of an iteration's files, read from
// api/jobs/<ws>/<ticket>/changes and /file; the Merge request screen: the branch, the base,
// the MR title and text to edit, preview, save (api/jobs/<ws>/<ticket>/mr-view, mr-save and
// mr-reset) and push. The board's messages go to the toast. The job's actions (approve, abort, say, Retry review, Accept and prepare MR, Simplify,
// settle, Pause, Resume, Restart, archive and the merge request on the Git host) go as POSTs
// to api/jobs/<ws>/<ticket>/<action>, each one a deliberate click, confirmed inline where it pushes,
// ends, overrides or merges, never retried or replayed by the page. A Queue card starts its job
// (POST api/tickets/<ws>/<ticket>/start, confirmed, never retried; its confirmation says when the
// Task is not checked, the check is stale or not ready) and runs the Task check (Check, POST
// api/tickets/<ws>/<ticket>/check; it only advises). Every value goes in through textContent; the
// hrefs are the server's ChatGPT URL, checked against its fixed prefix, and a merge request's https
// URL from the Git host.
'use strict';

const RECONNECT_MS = 3000;
const READ_TIMEOUT_MS = 10000;
const TERMINAL_STATES: readonly JobState[] = ['pushed', 'aborted', 'failed'];
// The rule at a usage limit's reset, as the Rules menu names them.
const ON_LIMIT_RULES: readonly OnLimitRule[] = ['resume-then-queue', 'resume-only', 'wait'];
// The labels and pending texts are looked up by the action names the server's payloads carry, so a
// name without an entry reads as undefined.
const ACTION_LABELS: Readonly<Record<string, string>> = {
  approve: 'Approve', abort: 'Abort', say: 'Send', review: 'Retry review', retry: 'Retry', accept: 'Accept and prepare MR', settle: 'Settle', simplify: 'Simplify', archive: 'Archive',
  'mr-create': 'Create merge request', 'mr-merge': 'Merge', 'mr-status': 'Refresh MR status', pause: 'Pause', resume: 'Resume', restart: 'Restart',
  handover: 'Hand over to my checkout', takeback: 'Take it back', 'handed-done': 'I opened the MR myself',
  'handed-done-merged': 'Merged another way',
  'review-mr': 'Review the MR and push',
};
const PENDING_REASONS: Readonly<Record<string, string>> = {
  accept: 'the override was requested; waiting for its outcome.',
  settle: 'a settlement was requested; waiting for its outcome.',
  simplify: 'the simplification was requested; waiting for its outcome.',
  approve: 'the push was requested; waiting for its outcome.',
  abort: 'abort was requested; waiting for its outcome.',
  say: 'the message is being sent.',
  review: 'the review is being restarted.',
  retry: 'the MR preparation is being started again.',
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
  'handed-done-merged': 'marking it done; waiting for its outcome.',
};
const PENDING_TEXT: Readonly<Record<string, string>> = {
  accept: 'Accepting over the gate…',
  settle: 'Settling the finding…',
  simplify: 'Writing the Simplify Fix section…',
  approve: 'Pushing the branch…',
  abort: 'Abort requested; waiting for the job to end.',
  say: 'Sending the message…',
  review: 'Restarting the review…',
  retry: 'Preparing the MR again…',
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
  'handed-done-merged': 'Marking the job done…',
};
// The element with the id, or null when the page has none.
const $ = (id: string): HTMLElement | null => document.getElementById(id);
// The element with the id, where the page requires it: dashboard.html has it, so a missing one is a
// broken page and throws.
function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`The page has no element #${id}`);
  }
  return node;
}
// The rules of a job's stop and actions are the server's (factory/src/stops.ts). Each job
// of the payloads carries its stop's canonical row (stop_code, stop_kind, stop_group), the
// actions the page shows (actions, in order) and every action's availability ('' or why not); the
// detail carries the ledger entries to settle (settle_ids). The page renders them.

// The page's own records in the state, as the scripts that fill them write them.
// A job's last outcome, shown on its page and in the toast (job-page.js setOutcome stamps at); pending
// while its action's request is out (job-page.js run).
interface Outcome {
  level: 'ok' | 'info' | 'warn' | 'error' | 'pending';
  text: string;
  link?: string;
  at?: string;
}
// The Changes data of the job shown (see cxData): the sides and diffs are the Changes screen's
// (job-screens.js), read through their own checks.
interface CxData {
  index: unknown;
  stamp: string | null;
  loading: string | null;
  lists: Map<string, unknown>;
  sides: Map<string, unknown>;
  diffs: Map<string, unknown>;
  focusTree: boolean;
}
// The planned ticket page; its payload and check are ticket-page.js's.
interface TicketPageState {
  key: string | null;
  data: unknown;
  check: unknown;
  error: string | null;
  load: object | null;
  textarea: HTMLTextAreaElement | null;
  copied: string | null;
  imageStatus: string | null;
  uploading: number;
}
interface PageState {
  jobs: JobRow[];
  key: string | null;
  detail: JobDetail | null;
  cache: Map<string, string>;
  cx: CxData;
  taskView: { stamp: string | null; text: string | null; check: unknown } | null;
  source: EventSource | null;
  retry: ReturnType<typeof setTimeout> | null;
  lastLine: number;
  entries: Array<Record<string, unknown>>;
  seen: Set<string>;
  streamLoad: object | null;
  labels: Map<string, string | null>;
  prevLabel: string | null;
  notes: Map<string, string>;
  stopSig: string | null;
  pending: Set<string>;
  outcomes: Map<string, Outcome | null>;
  drafts: Map<string, string>;
  unresolved: Map<string, { reason: string; refreshing: boolean; failed: boolean }>;
  doubts: Map<string, string>;
  confirm: { action: string; key: string } | null;
  remote: boolean;
  ticketAsk: { ticket: string; resolve: (confirmed: boolean) => void } | null;
  handoverMenu: boolean;
  workspaces: WorkspaceRow[] | null;
  tickets: TicketRow[] | null;
  archived: ArchivedRow[];
  setupPending: Set<string>;
  ticketConfirm: { action: string; key: string; row: ConfirmedTicket } | null;
  filter: string;
  doneAll: boolean;
  drawer: 'task' | 'workspaces' | 'ticket' | 'archived' | null;
  task: { key: string } | null;
  wantConfirm: { action: string; key: string } | null;
  startHolds: Map<string, { reason: string; failed: boolean }>;
  mrStatus: Map<string, { number: number; state: string }>;
  refresh: ReturnType<typeof setTimeout> | null;
  jobsSeen: number;
  toastTimer: ReturnType<typeof setTimeout> | null;
  toastLevel: Outcome['level'] | null;
  toastHover: boolean;
  highlight: string | null;
  highlightShown: boolean;
  wantFocus: 'composer' | 'stop' | null;
  jobLandsAfter: unknown[];
  openMenu: string | null;
  queue: QueueView | null;
  drag: string | null;
  tk: TicketPageState;
  goAfterStart: string | null;
  newImages: Array<{ file: File; ext: string; url: string }>;
  wsSettings: { handoff_default: HandoffMode | null; digest: DigestSettings | null };
  wsEdit: string | null;
  wsEditForm: HTMLFormElement | null;
  digestDirty: boolean;
}

const state: PageState = {
  jobs: [],
  key: null, // "<ws>/<ticket>" of the job open on its page
  detail: null,
  cache: new Map(), // "<n>/<view>" -> text, for the selected job
  // The Changes screen's data of the selected job (cxData); the implement prompt's Task
  // (its stamp, the Task text and its check).
  cx: cxData(),
  taskView: null,
  source: null,
  retry: null,
  // The Stream: the next line of events.jsonl to read (the last page's next, then each
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
  // The page came through the remote port (api/jobs's remote), and the open ticket
  // dialog of an action that pushes or merges ({ ticket, resolve }).
  remote: false,
  ticketAsk: null,
  // The hand-over panel's More menu is open.
  handoverMenu: false,
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
  // The last merge request status read from the host, per job.
  mrStatus: new Map(),
  // The board v3: the timer of the next read of api/jobs while a card runs and the count
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
  // The tickets the live jobs' Task files land after (the tickets payload's
  // job_lands_after), and the Queue card whose ⋯ menu is open.
  jobLandsAfter: [],
  openMenu: null,
  // The run queue as the tickets payload sends it ({max_running, running, held,
  // hold_reason, next}; null without one) and the queued card being dragged.
  queue: null,
  drag: null,
  // The planned ticket page: the ticket shown, its page payload, its check as last read,
  // a read's error, the read under way, the editor (kept across redraws) and the Copy's outcome;
  // the ticket whose Start answered before its job reached the board (the page moves to the job).
  tk: { key: null, data: null, check: null, error: null, load: null, textarea: null, copied: null, imageStatus: null, uploading: 0 },
  goAfterStart: null,
  // New ticket's images, in paste order: each file, the extension of its real type and its
  // blob: URL for the thumbnail.
  newImages: [],
  // The workspaces payload's settings ({handoff_default, digest}), the workspace whose card
  // is open as the Edit form and that form (kept across redraws), and whether the Morning digest
  // section has unsaved values.
  wsSettings: { handoff_default: null, digest: null },
  wsEdit: null,
  wsEditForm: null,
  digestDirty: false,
};
// The only URL the page links to: the ChatGPT composer prefilled by the server (the prefix of
// src/conversation.ts).
const CHATGPT_PREFILL_URL = 'https://chatgpt.com/?q=';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

// A button with its data-* attributes, for the delegated click listener. Without a text it is
// empty, for the caller to fill (board.js's dependency chips and workspace filter).
function button(className: string, text?: string, data: Readonly<Record<string, string>> = {}): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  for (const [name, value] of Object.entries(data)) {
    node.dataset[name] = value;
  }
  return node;
}

// An SVG element: its attributes (class too) only through setAttribute.
function svgEl(tag: string, attributes: Readonly<Record<string, string | number>> = {}, text: string | undefined = undefined): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

const keyOf = (job: { workspace: string; ticket: string }): string => `${job.workspace}/${job.ticket}`;
const jobPath = (key: string): string => key.split('/').map(encodeURIComponent).join('/');
// "2026-11-04 12:14:25" of a stored timestamp (ISO 8601 UTC) in the browser's local time;
// empty when it is missing or does not parse.
function localTime(ts: unknown): string {
  const date = typeof ts === 'string' ? new Date(ts) : null;
  if (date === null || Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
// A <time> of a stored timestamp: the local time as text, the exact UTC moment in its datetime
// and its title, so hovering shows it. The text is empty for anything but a string.
function timeEl(ts: unknown): HTMLTimeElement {
  const text = localTime(ts);
  const node = el('time', '', text);
  if (text !== '' && typeof ts === 'string') {
    node.setAttribute('datetime', ts);
    node.setAttribute('title', ts);
  }
  return node;
}
// A duration as the prototype writes it: "14 min", "1 h 4 min".
const dur = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
// An estimated cost (the jobs payload's cost_usd): "$1.23", or "—" without one.
const money = (value: unknown): string => (typeof value === 'number' ? `$${value.toFixed(2)}` : '—');
// split always returns at least one part.
const firstLine = (text: unknown): string => (typeof text === 'string' ? (text.split('\n')[0] ?? '').trim() : '');
const counted = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;
const pendingId = (action: string, key: string): string => `${action}\n${key}`;

async function getText(path: string): Promise<string> {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return response.text();
}

// The parsed body, unchecked: each caller checks the shape it reads.
async function getJson(path: string): Promise<unknown> {
  return JSON.parse(await getText(path));
}

// A refusal of an action by the factory: its code and message, shown as they are.
class ActionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// A parsed JSON value that is an object (an array too), its fields read as unknown.
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object';
}

// The action's answer. A 4xx, and a 5xx that names a factory refusal, is definite: ActionError.
// Anything else (no answer, a body cut or unreadable after the headers, a 2xx without a result,
// an internal failure) throws a plain Error: the action may have run.
async function post(path: string, body: unknown): Promise<unknown> {
  return answerOf(await fetch(path, {
    method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

// An image upload: the file's raw bytes as the body, with the same answer as post.
async function postBytes(path: string, file: Blob): Promise<unknown> {
  return answerOf(await fetch(path, {
    method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/octet-stream' }, body: file,
  }));
}

// The result of an action's answer, or its refusal (see post).
async function answerOf(response: Response): Promise<unknown> {
  const refused = response.status >= 400 && response.status < 500;
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    if (refused) {
      // Not the factory's JSON (an empty 404 of a rotated token or a vanished job, a 405).
      throw new ActionError(`http_${response.status}`, `The factory answered HTTP ${response.status} without a result; nothing was done. If sf serve restarted, open the new dashboard URL.`);
    }
    throw new Error(`HTTP ${response.status}, the answer could not be read`);
  }
  if (response.ok && isRecord(data) && data.ok === true && Object.hasOwn(data, 'result')) {
    return data.result;
  }
  const error = isRecord(data) && isRecord(data.error) ? data.error : {};
  if (refused || (response.status >= 500 && typeof error.code === 'string' && error.code !== 'internal_error')) {
    throw new ActionError(String(error.code ?? `http_${response.status}`), String(error.message ?? `HTTP ${response.status}`));
  }
  throw new Error(`HTTP ${response.status}${error.code ? ` ${error.code}` : ''}, no result`);
}

// The Changes data of the job shown, read from the server: the index of api/jobs/<key>/changes and
// the stamp (the job's iteration and state) it was read for, the stamp being read; the file lists
// per view ("<from>|<to>"), the sides of the files per "<side>|<path>" (side "base:<N>" or "<N>"),
// each 'loading', the answer or { error }; the line diffs per pair of sides; whether the tree takes
// the focus once its list arrives.
function cxData(): CxData {
  return { index: null, stamp: null, loading: null, lists: new Map(), sides: new Map(), diffs: new Map(), focusTree: false };
}
