// Software Factory dashboard v3 (SF-077), the port of docs/design/dashboard-v3/prototype.html: the
// top bar (the summary, the connection, the workspace filter, Archived, Workspaces and New ticket;
// the queue controls and the Rules menu stay hidden until SF-071 and SF-072), the board's five
// columns Queue, Implementing, Reviewing, Your turn and Done, whose cards say who acts now, why a
// job stopped (one table, STOPS) and carry one primary action only where the user acts, and the
// full pages a card opens: a job's page at #<ws>/<ticket> (/changes, /mr), with the job detail of
// SF-047 inside it until SF-078, and a planned ticket's page at #<ws>/<ticket>/ticket (its Task in
// the drawer until SF-081). The board's messages go to the toast. The job's approve, abort, say,
// Retry review, Accept and prepare MR, Pause, Resume, Restart and the merge request on the Git host
// (SF-048) go as POSTs to api/jobs/<ws>/<ticket>/<action>, each one a deliberate click, confirmed
// where it pushes, ends, overrides or merges, never retried or replayed by the page. A Queue card
// starts its job (POST api/tickets/<ws>/<ticket>/start, confirmed, never retried; its confirmation
// says when the Task is not checked, the check is stale or not ready) and runs the Task check
// (SF-054: Check, POST api/tickets/<ws>/<ticket>/check; it only advises). Every value goes in
// through textContent; the hrefs are the server's ChatGPT URL, checked against its fixed prefix,
// and a merge request's https URL from the Git host.
'use strict';

const RECONNECT_MS = 3000;
const READ_TIMEOUT_MS = 10000;
const TERMINAL_STATES = ['pushed', 'aborted', 'failed'];
const SAY_STATES = ['working', 'awaiting_review', 'needs_human', 'ready_for_human_review'];
// Pause, Resume and Restart (SF-067): the states each takes.
const PAUSE_STATES = ['working', 'awaiting_review'];
const RESTART_STATES = ['paused', 'aborted', 'failed', 'needs_human'];
const ACTION_LABELS = {
  approve: 'Approve', abort: 'Abort', say: 'Send', review: 'Retry review', accept: 'Accept and prepare MR', settle: 'Settle', simplify: 'Simplify', archive: 'Archive',
  'mr-create': 'Create merge request', 'mr-merge': 'Merge', 'mr-status': 'Refresh MR status', pause: 'Pause', resume: 'Resume', restart: 'Restart',
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
};
const $ = (id) => document.getElementById(id);
// The views of the selected job, flat tabs, one panel each (#tab-<name>).
const JOB_TABS = [['task', 'Task'], ['changes', 'Changes'], ['reviews', 'Reviews'], ['mr', 'MR'], ['log', 'Live log']];
// The steps of the job's pipeline in the drawer.
const STEPS = ['Implement', 'Claude review', 'Codex gate', 'MR preparation', 'You'];
// The codes of a job the gate stopped, which Accept and prepare MR takes on (SF-047).
const GATE_CODES = ['gate_rounds', 'gate_budget', 'gate_failed'];
// The ledger's stops (SF-052) that Accept and prepare MR takes on as well.
const LEDGER_CODES = ['review_churn', 'review_disputed'];
// The offer of the simplification pass (SF-055): Simplify applies it, Accept and prepare MR skips it.
const SIMPLIFY_CODE = 'simplify_offered';
const ACCEPT_CODES = [...GATE_CODES, ...LEDGER_CODES, SIMPLIFY_CODE];
// The stops whose findings the user settles here (Accept risk, Must fix).
const SETTLE_STOPS = ['escalated', ...LEDGER_CODES];
// The Live log's filters: who a line comes from.
const LOG_FILTERS = [['all', 'All'], ['implementer', 'Implementer'], ['claude', 'Claude review'], ['codex', 'Codex'], ['state', 'State']];

const state = {
  jobs: [],
  key: null, // "<ws>/<ticket>" of the job open on its page
  detail: null,
  iteration: null, // the iteration selected in Changes
  // The selected job tab; kept across jobs.
  tab: 'changes',
  cache: new Map(), // "<n>/<view>" -> text, for the selected job
  // "<key>/<n>" of the Report and Patch drawn in Changes; "<iteration>/<path>" of the file clicked
  // in its list; the stamp of the Task text shown; the MR text loaded; the Live log's filter.
  drawn: null,
  target: null,
  jobTask: null,
  mrText: null,
  logFilter: 'all',
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

// ---------- The job in the drawer (SF-047): header, pipeline, next action, facts, flat tabs ----------

const verdictOf = (record) => (record === null || record === undefined ? null : typeof record.error === 'string' ? 'failed' : record.verdict);
const iterationOf = (detail, number) => detail.iterations.find((iteration) => iteration.number === number) ?? null;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// "10:05" of a timestamp, local time.
const clock = (ts) => localTime(ts).slice(11, 16);

// The job of a detail with what the board adds to a card: the Claude verdict of the last
// iteration and its end, which tell the Claude review from the Codex gate in awaiting_review.
function flowJob(detail) {
  const review = iterationOf(detail, detail.job.iteration)?.review ?? null;
  return { ...detail.job, review: verdictOf(review), review_ended_at: typeof review?.ended_at === 'string' ? review.ended_at : null };
}

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
// confirmations of Simplify and of Accept (Skip).
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

function renderLedger(detail) {
  const entries = settleable(detail);
  $('ledger-panel').hidden = entries.length === 0;
  const key = keyOf(detail.job);
  const busy = state.pending.has(pendingId('settle', key));
  $('ledger-list').replaceChildren(...entries.map((entry) => {
    const item = el('li', 'ledger-entry');
    item.append(el('p', '', `${entry.id} · ${entry.status} · ${entry.severity} · ${entry.path}: ${entry.problem}`));
    if (entry.status === 'escalated') {
      item.append(el('p', 'hint', `The Implementer asks: ${entry.response}`));
    } else {
      item.append(el('p', 'hint', `The Implementer contests it: ${entry.response} Evidence: ${entry.evidence}`));
      if (entry.dispute !== null && entry.dispute !== undefined) {
        item.append(el('p', 'hint', `${entry.dispute.reviewer === 'codex' ? 'Codex' : 'Claude'} reopens it: ${entry.dispute.reason}`));
      }
    }
    const note = el('input', 'ledger-note');
    note.type = 'text';
    note.placeholder = 'Note (optional)';
    note.setAttribute('aria-label', `Note on ${entry.id}`);
    const accept = el('button', 'btn', 'Accept risk');
    const fix = el('button', 'btn btn-primary', 'Must fix');
    for (const [button, decision] of [[accept, 'accept'], [fix, 'fix']]) {
      button.type = 'button';
      button.disabled = busy;
      button.dataset.settle = `${entry.id}:${decision}`;
      button.addEventListener('click', () => void run('settle', key, { id: entry.id, decision, note: note.value }));
    }
    const row = el('div', 'row');
    row.append(note, accept, fix);
    item.append(row);
    return item;
  }));
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

// What a pause interrupted (SF-067) and what moves the job on.
function pausedSentence(job) {
  const step = job.paused?.step;
  const what = step === 'turn' ? `the Implementer's turn on iteration ${job.iteration + 1}`
    : step === 'review' ? `the Claude review of iteration ${job.iteration}`
    : step === 'gate' ? `the Codex gate on iteration ${job.iteration}`
    : step === 'simplify' ? `the simplification pass on iteration ${job.iteration}` : null;
  const again = step === 'turn' ? 'Resume continues the same session (with your message, if you write one below)' : what !== null ? 'Resume runs it again' : 'Resume goes on';
  return `${what !== null ? `You paused ${what}.` : 'You paused the job.'} ${again}; Restart starts the ticket again from its current Task file.`;
}

// A plain sentence for each code that stops a job: what happened and what moves it on.
function haltSentence(detail) {
  const job = detail.job;
  const code = job.error?.code ?? '';
  const accept = gateAcceptable(detail) ? ' Accept and prepare the MR, tell the Implementer what to do, or abort.' : ' Tell the Implementer what to do, or abort.';
  if (job.state === 'failed') {
    return 'The job failed and cannot go on; restart or archive it.';
  }
  if (job.state === 'paused') {
    return pausedSentence(job);
  }
  switch (code) {
    case SIMPLIFY_CODE:
      return 'The reviewers found the change clean, and the simplification pass found things the review fixes added that the Task does not need. Simplify (one more Fix section, reviewed as usual), or Accept and prepare the MR without them (they are listed in the MR text).';
    case 'escalated':
      return 'The Implementer escalated a question only you can answer. Settle each finding below: Accept risk or Must fix; then the job goes on.';
    case 'review_disputed':
      return `A reviewer disputes the Implementer's contest of a finding.${gateAcceptable(detail) ? ' Accept and prepare the MR,' : ''} settle the finding below (Accept risk or Must fix), message the Implementer, or abort to go back to planning (the branch stays).`;
    case 'review_churn':
      return `The fixes keep making new findings.${gateAcceptable(detail) ? ' Accept and prepare the MR,' : ''} continue (settle a finding or message the Implementer), or abort to go back to planning (the branch stays).`;
    case 'review_failed':
      return 'The Claude review could not run. Retry it.';
    case 'gate_failed':
      return `The Codex gate stopped without a verdict.${accept}`;
    case 'gate_rounds':
      return `Codex asked for fixes more often than the round limit allows.${accept}`;
    case 'gate_budget':
      return `The gate used up its token budget for this job.${accept}`;
    case 'iteration_limit':
      return 'The reviewers asked for fixes too many times. Give the Implementer a direction, or abort.';
    case 'mr_conflict':
      return `The rebase onto ${job.base} conflicts and the Implementer could not resolve it. Tell it how, or abort.`;
    case 'mr_push_failed':
    case 'mr_push_protected':
      return 'The push failed. Fix the cause, then approve again.';
    case 'serve_restarted':
    case 'mr_serve_restarted':
      return 'sf serve restarted while the job ran. Message the Implementer to go on, or abort.';
    default:
      return code.startsWith('mr_')
        ? 'The MR preparation stopped. Read the error, then message the Implementer, or abort.'
        : 'The job stopped and needs you. Read the error, then message the Implementer, or abort.';
  }
}

// The five steps of the job: done, current (with since when), halted (with the code), to do, or
// off for the gate when it is off.
function jobSteps(detail) {
  const job = flowJob(detail);
  const flow = pipeline(job);
  const overridden = standingOverride(detail) !== null;
  return STEPS.map((name, index) => {
    let status = segmentStatus(flow, index);
    let caption = '';
    // The stored time the caption's "since" is of, shown exactly on hover.
    let at = null;
    if (index === 2 && detail.gate === false && status !== 'current' && status !== 'halted') {
      status = 'off';
      caption = 'off';
    } else if (status === 'current') {
      const from = index === 2 && job.state === 'awaiting_review' ? (job.review_ended_at ?? job.updated_at) : job.updated_at;
      caption = `since ${clock(from)} (${since(from)})`;
      at = from;
    } else if (status === 'halted') {
      caption = job.error?.code ?? job.state;
    } else if (status === 'done' && index === 2 && overridden) {
      caption = 'overridden by you';
    }
    return { name, status, caption, at };
  });
}

function renderStepper(detail) {
  $('job-stepper').replaceChildren(...jobSteps(detail).map((step, index) => {
    const item = el('li', `step ${step.status}`);
    item.dataset.status = step.status;
    if (step.status === 'current' || step.status === 'halted') {
      item.setAttribute('aria-current', 'step');
    }
    const knob = step.status === 'done' ? '✓' : step.status === 'halted' ? '!' : String(index + 1);
    const caption = el('span', 'step-caption', step.caption);
    if (typeof step.at === 'string') {
      caption.setAttribute('title', step.at);
    }
    item.append(el('span', 'knob', knob), el('span', 'step-name', step.name), caption);
    return item;
  }));
  const job = detail.job;
  const halted = pipeline(flowJob(detail)).halted;
  const halt = $('job-halt');
  halt.hidden = !halted;
  halt.replaceChildren(...(halted ? [el('strong', 'mono', job.error?.code ?? job.state), document.createTextNode(` ${haltSentence(detail)}`)] : []));
}

// Who acts now, what they do and what follows.
function nextAction(detail) {
  const job = detail.job;
  const n = job.iteration;
  switch (job.state) {
    case 'starting':
      return { who: 'Now · Implementer', headline: 'The worktree is being created and the Implementer starts.', why: 'Then it works on iteration 1.' };
    case 'working':
      return { who: 'Now · Implementer', headline: `The Implementer is working on iteration ${n + 1}.`, why: 'When it publishes its Report and Patch, Claude reviews them.' };
    case 'awaiting_review':
      return flowJob(detail).review === 'clean'
        ? { who: 'Now · Codex gate', headline: `Codex is reviewing iteration ${n}.`, why: 'Its verdict decides: clean goes on to MR preparation, fix goes back to the Implementer.' }
        : { who: 'Now · Claude review', headline: `Claude is reviewing iteration ${n}.`, why: 'Clean goes on to the Codex gate; fix becomes the next Fix section.' };
    case 'preparing_mr':
      return { who: 'Now · Factory', headline: `The factory commits the change and rebases it onto ${job.base}.`, why: 'Then the branch comes to you to approve.' };
    case 'ready_for_human_review':
      return {
        who: 'Your turn', headline: 'The branch is ready: approve to push it, or create the merge request (push and open it), or abort.',
        why: `Branch ${job.branch}: one commit on ${job.base}.${typeof detail.mr_title === 'string' ? ` Merge request title: ${detail.mr_title}` : ''}`,
      };
    case 'needs_human':
      return { who: 'Your turn', headline: haltSentence(detail), why: job.error ? `${job.error.code}: ${job.error.message}` : '' };
    case 'paused':
      return { who: 'Your turn', headline: pausedSentence(job), why: job.task_changed === true ? TASK_CHANGED : '' };
    case 'pushed':
      if (hasMr(job) && job.mr.state === 'merged') {
        return { who: 'Finished', headline: `Merged merge request #${job.mr.number} into ${job.base}.`, why: 'Archive the job to take it off the board.' };
      }
      if (hasMr(job) && job.mr.state === 'open') {
        return { who: 'Finished', headline: `Pushed ${job.branch}; merge request #${job.mr.number} is open.`, why: `Merge it into ${job.base} here or on the host; archive the job when it is merged.` };
      }
      return {
        who: 'Finished', headline: `Pushed ${job.branch}.`,
        why: `Create the merge request here${typeof detail.mr_title === 'string' ? ` (${detail.mr_title})` : ''}, or open it with the MR text by hand; archive the job when it is merged.`,
      };
    case 'aborted':
      return { who: 'Finished', headline: 'Aborted.', why: 'Archive the job to take it off the board.' };
    default:
      return { who: 'Finished', headline: 'Failed.', why: job.error ? `${job.error.code}: ${job.error.message}` : '' };
  }
}

// The merge request on the Git host (SF-048): its number, state and link, and the status last read.
function renderMr(detail) {
  const job = detail.job;
  const line = $('mr-line');
  line.hidden = !hasMr(job);
  line.replaceChildren(...(hasMr(job) ? [document.createTextNode(`Merge request #${job.mr.number} (${job.mr.state}): `), mrLink(job.mr)] : []));
  // The status last read shows only while it is of the merge request the job shows now (the same
  // number and state): after a merge, a close or a new merge request it stays hidden. It is kept, so
  // a status that saw the merge first shows once the job's update records it.
  const read = state.mrStatus.get(keyOf(job));
  const status = read !== undefined && hasMr(job) && read.number === job.mr.number && read.state === job.mr.state ? read : undefined;
  $('mr-status-line').hidden = status === undefined;
  $('mr-status-line').textContent = status === undefined ? '' : mrStatusText(status);
}

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

function renderNext(detail) {
  const next = nextAction(detail);
  const waited = TERMINAL_STATES.includes(detail.job.state) ? '' : ` · for ${since(detail.job.updated_at)}`;
  $('next-who').textContent = `${next.who}${waited}`;
  $('next-panel').className = `next ${next.who === 'Your turn' ? 'you' : next.who === 'Finished' ? 'finished' : 'running'}`;
  $('next-headline').textContent = next.headline;
  $('next-why').textContent = next.why;
}

function renderHeader(detail) {
  const job = detail.job;
  $('job-ticket').textContent = job.ticket;
  const badge = $('job-state');
  badge.textContent = job.state;
  badge.className = `badge s-${job.state}`;
  $('job-branch').textContent = job.branch;
  $('job-badges').replaceChildren(...fileBadges(job));
  renderStepper(detail);
}

// The facts, stacked: one term and its value per row.
function renderFacts(detail) {
  const job = detail.job;
  const costs = detail.iterations.flatMap((iteration) => [iteration.cost_usd, iteration.review?.cost_usd]).filter((cost) => typeof cost === 'number');
  const rows = [
    ['Base', job.base],
    ['Iteration', job.mr_attempts > 0 ? `${job.iteration} (MR attempts ${job.mr_attempts})` : String(job.iteration)],
    ['Fix sections', String(job.fixes ?? 0)],
    ['Gate rounds', String(job.gate_fixes ?? 0)],
    ['Gate tokens', String(job.gate_tokens ?? 0)],
    // An estimate of the API-equivalent price, not a charge: the session usually runs on a Claude plan.
    ['Estimated cost', costs.length > 0 ? `est. $${costs.reduce((sum, cost) => sum + cost, 0).toFixed(4)}` : 'n/a'],
    ['Updated', timeEl(job.updated_at)],
    ['Worktree', typeof job.worktree === 'string' ? job.worktree : (job.state === 'ready_for_human_review' ? 'none: the branch is in the checkout' : 'none')],
  ];
  $('job-facts').replaceChildren(...rows.map(([term, value]) => {
    const row = el('div');
    const dt = el('dt', '', term);
    if (term === 'Estimated cost') {
      dt.setAttribute('title', 'An estimate of the API-equivalent price, not a charge');
    }
    const dd = el('dd');
    dd.append(value);
    row.append(dt, dd);
    return row;
  }));
}

// The state changes, and the user's override of the gate, compact: the time, the change, the code.
function renderHistory(history) {
  $('history').replaceChildren(...history.map((entry) => {
    const item = el('li');
    item.append(timeEl(entry.ts));
    if (entry.event === 'gate_overridden') {
      item.className = 'history-override';
      item.append(document.createTextNode(`gate overridden by you (${entry.code}): ${plural(entry.unapplied, 'Codex item')} not applied`));
      return item;
    }
    item.append(document.createTextNode(`${entry.from ?? '-'} → ${entry.to}`));
    if (entry.error) {
      const code = el('span', 'history-error', ` ${entry.error.code}`);
      code.setAttribute('title', entry.error.message);
      item.append(code);
    }
    return item;
  }));
}

// ---------- Tabs ----------

function renderJobTabs() {
  const detail = state.detail;
  const counts = {
    changes: detail === null ? null : (iterationOf(detail, state.iteration)?.files?.length ?? null),
    reviews: detail === null ? null : detail.iterations.filter((iteration) => iteration.review || iteration.gate).length,
  };
  for (const button of $('job-tabs').querySelectorAll('button')) {
    const name = button.dataset.tab;
    button.setAttribute('aria-selected', String(name === state.tab));
    const label = JOB_TABS.find(([tab]) => tab === name)[1];
    const count = counts[name];
    button.replaceChildren(document.createTextNode(label), ...(typeof count === 'number' && count > 0 ? [el('span', 'tab-count', String(count))] : []));
  }
  for (const [name] of JOB_TABS) {
    $(`tab-${name}`).hidden = name !== state.tab;
  }
}

function selectTab(name) {
  state.tab = name;
  renderJobTabs();
  showTab();
}

// Loads what the selected tab shows, once per job and iteration.
function showTab() {
  if (state.detail === null) {
    return;
  }
  if (state.tab === 'task') {
    void showJobTask(state.detail);
  } else if (state.tab === 'changes') {
    void showIteration();
  } else if (state.tab === 'log' && $('follow').checked) {
    const events = $('events');
    events.scrollTop = events.scrollHeight;
  }
}

// ---------- Task ----------

// The Task file of the job, Fix sections included: read again when a Fix section is written.
async function showJobTask(detail) {
  const key = state.key;
  const stamp = `${key}#${detail.job.fixes ?? 0}#${detail.job.iteration}`;
  if (state.jobTask === stamp) {
    return;
  }
  state.jobTask = stamp;
  $('job-task-path').textContent = `.software-factory/${detail.job.ticket}.md`;
  if ($('job-task').children.length === 0) {
    $('job-task').replaceChildren(document.createTextNode('Loading the Task file…'));
  }
  let text;
  try {
    text = await getText(`api/tickets/${jobPath(key)}/task`);
  } catch (error) {
    // The ticket may have been archived since the job started.
    try {
      text = await getText(`api/tickets/${jobPath(key)}/task?archived=1`);
    } catch {
      text = `Could not load the Task file: ${error.message}`;
      // The next job event tries again.
      if (state.jobTask === stamp) {
        state.jobTask = null;
      }
    }
  }
  if (state.key === key && state.jobTask === stamp) {
    $('job-task').replaceChildren(...renderReport(text));
  }
  await showCheck('job-task-check', key, () => state.key === key && state.jobTask === stamp);
}

// ---------- Task check (SF-054) ----------

// The last check of a ticket, as the Task drawer and the job's Task tab show it: the stale mark and
// the verdict, the paraphrase above the findings (by severity), then the expected files.
function renderCheck(view) {
  const box = [];
  const record = view.check;
  if (record === null) {
    box.push(el('p', 'check-head', view.running ? 'Task check: running…' : 'Task check: not checked yet. Check on the ticket\'s card runs it; it only advises.'));
    return box;
  }
  const output = record.output;
  const counts = { blocker: 0, major: 0, nit: 0 };
  for (const item of output?.findings ?? []) {
    counts[item.severity] = (counts[item.severity] ?? 0) + 1;
  }
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

// Loads a ticket's last check into the container while current() holds; hidden when the factory
// has none to show (no Task checks, no Task file).
async function showCheck(id, key, current) {
  let view = null;
  try {
    view = JSON.parse(await getText(`api/tickets/${jobPath(key)}/check`));
  } catch {
    view = null;
  }
  if (!current()) {
    return;
  }
  $(id).hidden = view === null;
  $(id).replaceChildren(...(view === null ? [] : renderCheck(view)));
}

// Check: one request per ticket at a time; the card shows the check running, then its verdict.
async function checkTicket(row) {
  const key = `${row.workspace}/${row.ticket}`;
  await setupRequest(`check:${key}`, `api/tickets/${jobPath(key)}/check`, {}, 'toast', () =>
    ({ level: 'ok', text: `Checking ${key}: a read-only Claude session reads the Task file and the repository; the card shows the verdict when it ends. It only advises: Start stays yours.` }));
}

// ---------- Changes ----------

function renderChanges(detail) {
  const iterations = detail.iterations;
  $('no-iterations').hidden = iterations.length > 0;
  $('changes-body').hidden = iterations.length === 0;
  $('iteration-picker').hidden = iterations.length < 2;
  $('iteration-picker').replaceChildren(...iterations.map((iteration) => {
    const button = el('button', '', iteration.number > 1 ? `Iteration ${iteration.number} · Fix ${iteration.number - 1}` : `Iteration ${iteration.number}`);
    button.type = 'button';
    button.dataset.iteration = String(iteration.number);
    button.setAttribute('aria-pressed', String(iteration.number === state.iteration));
    button.addEventListener('click', () => {
      state.iteration = iteration.number;
      state.target = null;
      renderChanges(state.detail);
      renderJobTabs();
      void showIteration();
    });
    return button;
  }));
  const meta = iterationOf(detail, state.iteration);
  if (meta === null) {
    $('iteration-meta').textContent = '';
    $('files-list').replaceChildren();
    return;
  }
  const cost = typeof meta.cost_usd === 'number' ? `$${meta.cost_usd.toFixed(4)}` : 'n/a';
  $('iteration-meta').replaceChildren(timeEl(meta.started_at), ' – ', timeEl(meta.ended_at), `, cost ${cost}, ` +
    `${meta.changed_files} changed file(s), ${meta.denials} denial(s)${meta.patch_truncated ? ', patch truncated' : ''}`);
  renderFiles(meta);
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

// The file of the list a Patch header belongs to; null for none.
function headerPath(header, files) {
  for (const file of files) {
    if (header === `diff --git a/${file.path} b/${file.path}` || (typeof file.from === 'string' && header === `diff --git a/${file.from} b/${file.path}`) ||
      (header.startsWith('diff --git "a/') && header.endsWith(` "b/${file.path}"`))) {
      return file.path;
    }
  }
  return null;
}

// The Patch in one block per file, each knowing its path, so a click in the list can find it.
function patchSections(text, files) {
  const sections = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (current === null || line.startsWith('diff --git ')) {
      current = { path: line.startsWith('diff --git ') ? headerPath(line, files) : null, lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
  }
  return sections.filter((section) => section.lines.some((line) => line !== ''));
}

// The Report and the Patch of the selected iteration, loaded once and drawn once per iteration.
async function showIteration() {
  const key = state.key;
  const meta = state.detail === null ? null : iterationOf(state.detail, state.iteration);
  if (meta === null) {
    state.drawn = null;
    $('iteration-report').replaceChildren();
    $('patch-body').replaceChildren();
    $('patch-note').textContent = '';
    return;
  }
  const id = `${key}/${meta.number}`;
  if (state.drawn === id) {
    return;
  }
  state.drawn = id;
  $('iteration-report').replaceChildren(document.createTextNode('Loading the Report…'));
  $('patch-body').replaceChildren(document.createTextNode('Loading the Patch…'));
  $('patch-note').textContent = '';
  // Each is drawn when it arrives, if the iteration is still the one shown.
  const current = () => state.drawn === id && state.iteration === meta.number;
  void iterationText(key, meta.number, 'report').then((report) => {
    if (report !== undefined && current()) {
      $('iteration-report').replaceChildren(...renderReport(report));
    }
  });
  const patch = await iterationText(key, meta.number, 'patch');
  if (patch === undefined || !current()) {
    return;
  }
  const files = Array.isArray(meta.files) ? meta.files : [];
  $('patch-body').replaceChildren(...patchSections(patch, files).map((section) => {
    const block = el('span', 'patch-file');
    if (section.path !== null) {
      block.dataset.path = section.path;
    }
    block.append(...renderPatch(section.lines.join('\n')));
    return block;
  }));
  markTarget(false);
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

// The rows of the file list in order: undeclared sensitive, declared sensitive, deleted, the rest
// by file name; each row knows its group label.
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

function renderFiles(meta) {
  const files = Array.isArray(meta.files) ? meta.files : null;
  $('no-files').hidden = files !== null && files.length > 0;
  $('no-files').textContent = files === null ? 'This iteration was published before the file list existed; the Report lists its files.' : 'No files changed.';
  const undeclared = (files ?? []).filter((file) => file.sensitive === 'undeclared').length;
  const outside = (files ?? []).filter((file) => file.scope === 'out').length;
  const deleted = (files ?? []).filter((file) => file.status === 'deleted').length;
  const parts = [`Files ${(files ?? []).length}`];
  if (undeclared > 0) {
    parts.push(`${undeclared} sensitive undeclared`);
  }
  if (outside > 0) {
    parts.push(`${outside} out of scope`);
  }
  if (deleted > 0) {
    parts.push(`${deleted} deleted`);
  }
  $('files-summary').textContent = parts.join(' · ');
  let group = null;
  const items = [];
  for (const { file, group: label } of fileRows(files ?? [])) {
    if (label !== group) {
      group = label;
      items.push(el('li', 'file-group', label));
    }
    items.push(fileRow(meta, file));
  }
  $('files-list').replaceChildren(...items);
}

function fileRow(meta, file) {
  const item = el('li');
  const row = el('button', `file-row s-${file.status}`);
  row.type = 'button';
  row.dataset.path = file.path;
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
  // Outside the Task's scope (SF-053); a file of a list without scope has none.
  if (file.scope === 'out') {
    labels.append(el('span', 'file-label out-of-scope', 'out of scope'));
  }
  if (file.status === 'deleted') {
    labels.append(el('span', 'file-label deleted', 'deleted'));
  }
  const counts = el('span', 'file-counts');
  counts.append(el('span', 'add', `+${file.additions}`), document.createTextNode(' '), el('span', 'del', `−${file.deletions}`));
  labels.append(counts);
  row.append(labels);
  row.setAttribute('aria-current', String(state.target === `${meta.number}/${file.path}`));
  row.addEventListener('click', () => {
    state.target = `${meta.number}/${file.path}`;
    markTarget(true);
  });
  item.append(row);
  return item;
}

// Marks the clicked file in the list and its diff in the Patch, and scrolls the diff into view;
// a file the Patch omits says so.
function markTarget(scroll) {
  const prefix = `${state.iteration}/`;
  const path = state.target !== null && state.target.startsWith(prefix) ? state.target.slice(prefix.length) : null;
  for (const row of $('files-list').querySelectorAll('button')) {
    row.setAttribute('aria-current', String(path !== null && row.dataset.path === path));
  }
  let found = false;
  const blocks = [...$('patch-body').children].filter((block) => block.nodeType === 1);
  for (const block of blocks) {
    const on = path !== null && block.dataset.path === path;
    block.setAttribute('aria-current', String(on));
    if (on) {
      found = true;
      if (scroll && typeof block.scrollIntoView === 'function') {
        block.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }
  }
  const meta = state.detail === null ? null : iterationOf(state.detail, state.iteration);
  const notes = [];
  if (meta?.patch_truncated) {
    notes.push('The Patch is cut at its size limit.');
  }
  if (path !== null && !found && blocks.length > 0) {
    notes.push(`The Patch omits ${path}: a binary file, or beyond the Patch size limit.`);
  }
  $('patch-note').textContent = notes.join(' ');
}

// ---------- Reviews ----------

// One review item as a list entry: the path as code, the problem, and what is expected.
function itemEntry(item, expected = true) {
  const entry = el('li');
  if (typeof item.id === 'string') {
    entry.append(document.createTextNode(`${item.id} `));
  }
  entry.append(el('code', '', item.path), document.createTextNode(`: ${item.problem}${expected ? ` Expected: ${item.expected}` : ''}`));
  return entry;
}

// What a review block says while it has no record.
function pendingReview(detail, iteration, reviewer) {
  const job = detail.job;
  const current = iteration.number === job.iteration && job.state === 'awaiting_review';
  if (reviewer === 'claude') {
    return current && (iteration.review ?? null) === null ? 'reviewing now…' : 'not run';
  }
  if (detail.gate === false) {
    return 'off';
  }
  if (current) {
    return verdictOf(iteration.review) === 'clean' ? 'reviewing now…' : 'after a clean Claude review';
  }
  return 'not run';
}

// One reviewer's verdict on one iteration: the verdict with its cost or tokens, the summary, the
// items, the accepted sensitive paths; or why it failed; or that there is none.
function reviewBlock(name, review, pending) {
  if (review === null || review === undefined) {
    const none = el('div', 'review v-none');
    none.append(el('p', 'review-verdict', `${name}: ${pending}`));
    return none;
  }
  if (typeof review.error === 'string') {
    const block = el('div', 'review v-failed');
    block.append(el('p', 'review-verdict', `${name}: failed`), el('p', 'review-summary', review.error));
    return block;
  }
  const count = review.items.length;
  const verdict = review.verdict === 'fix' ? `fix (${plural(count, 'item')})` : review.verdict;
  const cost = typeof review.cost_usd === 'number' ? `, cost $${review.cost_usd.toFixed(4)}` : '';
  const tokens = review.tokens !== null && typeof review.tokens === 'object' && typeof review.tokens.input === 'number'
    ? `, ${review.tokens.input + review.tokens.output} tokens` : '';
  const block = el('div', `review v-${review.verdict}`);
  block.append(el('p', 'review-verdict', `${name}: ${verdict}${cost}${tokens}`), el('p', 'review-summary', review.summary));
  if (count > 0) {
    const list = el('ol', 'review-items');
    list.append(...review.items.map((item) => itemEntry(item)));
    block.append(list);
  }
  if (Array.isArray(review.accepted_sensitive) && review.accepted_sensitive.length > 0) {
    block.append(el('p', 'review-accepted', `Accepted sensitive paths: ${review.accepted_sensitive.join(', ')}`));
  }
  return block;
}

// Per iteration, newest first: the Claude verdict and the Codex verdict side by side.
function renderReviews(detail) {
  $('no-reviews').hidden = detail.iterations.length > 0;
  $('reviews-list').replaceChildren(...[...detail.iterations].reverse().map((iteration) => {
    const row = el('section', 'review-row');
    row.dataset.iteration = String(iteration.number);
    row.append(el('h4', '', `Iteration ${iteration.number}`));
    const pair = el('div', 'review-pair');
    pair.append(
      reviewBlock('Claude review', iteration.review, pendingReview(detail, iteration, 'claude')),
      reviewBlock('Codex gate', iteration.gate, pendingReview(detail, iteration, 'codex')),
    );
    row.append(pair);
    const override = iteration.gate_override;
    if (override !== null && override !== undefined) {
      const accepted = el('p', 'review-override', `You accepted this iteration over the gate (${override.code}) at `);
      accepted.append(timeEl(override.at), '.');
      row.append(accepted);
    }
    return row;
  }));
}

// ---------- MR ----------

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

// Copies text; without the clipboard it shows the text in box, selected for Ctrl+C.
function copyValue(text, box, statusId) {
  const select = () => {
    box.value = text;
    box.hidden = false;
    box.focus();
    box.select();
    $(statusId).textContent = 'Selected: press Ctrl+C to copy.';
  };
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
    select();
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    $(statusId).textContent = 'Copied.';
  }, select);
}

// ---------- Live log ----------

// Who an event line comes from, for the log's filters.
function eventSource(event) {
  switch (event.type) {
    case 'state':
    case 'gate_overridden':
      return 'state';
    case 'gate_event':
      return 'codex';
    case 'review_message':
      return 'claude';
    case 'review':
    case 'review_failed':
      return /\breview by codex\b/.test(event.text) ? 'codex' : 'claude';
    case 'notify_failed':
    case 'placeholders_removed':
    case 'merge_request':
    case 'turn_limit_continued':
      // The factory's own lines go with the state changes.
      return 'state';
    default:
      return 'implementer';
  }
}

const logShows = (source) => state.logFilter === 'all' || state.logFilter === source;

function renderLogFilters() {
  for (const button of $('log-filters').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === state.logFilter));
  }
}

function setLogFilter(filter) {
  state.logFilter = filter;
  renderLogFilters();
  for (const line of $('events').children) {
    line.hidden = !logShows(line.dataset.source);
  }
  if ($('follow').checked) {
    $('events').scrollTop = $('events').scrollHeight;
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
  renderNext(detail);
  renderMr(detail);
  renderFacts(detail);
  renderHistory(detail.history);
  renderChanges(detail);
  renderReviews(detail);
  renderLedger(detail);
  renderJobTabs();
  showTab();
  void showMr();
  renderActions();
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
  if (job.state === 'paused') {
    return pausedTurn(job) ? 'the job is paused: Resume sends the message.' : 'the job is paused: Resume, then send the message.';
  }
  return SAY_STATES.includes(job.state) ? '' : `messages need working, awaiting_review, needs_human or ready_for_human_review; the job is ${job.state}.`;
}

// A job paused during the Implementer's turn (SF-067): its Resume takes the message.
const pausedTurn = (job) => job.state === 'paused' && job.paused?.from === 'working';

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
  // Accept and prepare MR shows only when the gate stopped the job after a clean Claude review.
  const acceptable = job !== null && gateAcceptable(state.detail);
  const acceptReason = availability('accept', job);
  $('accept-gate-button').hidden = !acceptable;
  $('accept-gate-button').disabled = !acceptable || acceptReason !== '' || state.confirm !== null;
  if (acceptable && acceptReason !== '') {
    reasons.push(`${ACTION_LABELS.accept}: ${acceptReason}`);
  }
  // Pause, Resume and Restart (SF-067): each shows where it applies; Restart is confirmed.
  for (const action of ['pause', 'resume', 'restart']) {
    const shown = job !== null && (action === 'pause' ? [...PAUSE_STATES, 'preparing_mr'] : action === 'resume' ? ['paused'] : RESTART_STATES).includes(job.state);
    const reason = availability(action, job);
    $(`${action}-button`).hidden = !shown;
    $(`${action}-button`).disabled = !shown || reason !== '' || state.confirm !== null;
    if (shown && reason !== '') {
      reasons.push(`${ACTION_LABELS[action]}: ${reason}`);
    }
  }
  // Simplify shows only on the offer of the simplification pass (SF-055).
  const offered = job !== null && simplifiable(job);
  $('simplify-button').hidden = !offered;
  $('simplify-button').disabled = !offered || availability('simplify', job) !== '' || state.confirm !== null;
  // The merge request on the Git host (SF-048): each button shows where it applies; while the
  // actions are off (a token missing), the reason names the variable.
  for (const [action, shown] of [['mr-create', job !== null && canCreateMr(job)], ['mr-merge', job !== null && canMerge(job)], ['mr-status', job !== null && hasMr(job)]]) {
    const reason = availability(action, job);
    $(`${action}-button`).hidden = !shown;
    $(`${action}-button`).disabled = !shown || reason !== '' || state.confirm !== null;
    if (shown && reason !== '') {
      reasons.push(`${ACTION_LABELS[action]}: ${reason}`);
    }
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
  input.disabled = job === null || !(SAY_STATES.includes(job.state) || pausedTurn(job));
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
  if (action === 'mr-create') {
    if (data.mr !== null && typeof data.mr === 'object') {
      // From ready_for_human_review the push came first: the outcome carries the compare link too.
      const pushed = typeof data.link === 'string' ? `Pushed ${data.branch}. ` : '';
      return { level: 'ok', text: `${pushed}Merge request #${data.mr.number} ${data.mr.reused === true ? 'was already open; reused' : 'opened'}:`, link: data.mr.url };
    }
    if (data.state === 'pushed' && data.error) {
      return { level: 'error', text: `Pushed ${data.branch}, but the merge request was not opened (${detail}). Fix it, then create the merge request again.` };
    }
    if (data.state === 'needs_human') {
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
    if (action === 'mr-status' && result !== null && typeof result === 'object' && result.status) {
      state.mrStatus.set(key, result.status);
    }
    // The sent draft goes; text edited meanwhile stays.
    if ((action === 'say' || action === 'resume') && typeof body.message === 'string' && state.drafts.get(key) === body.message) {
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
  const host = job.mr_host?.host === 'gitlab' ? 'GitLab' : 'GitHub';
  const mrTitle = typeof state.detail?.mr_title === 'string' ? state.detail.mr_title : '(the MR text\'s first line)';
  const texts = {
    'mr-create': canApprove(job)
      ? `Pushes branch ${job.branch} to origin as Approve does, then opens a merge request on ${host} from ${job.branch} into ${job.base}, titled “${mrTitle}”, with the rest of the MR text as its description.`
      : `Opens a merge request on ${host} from ${job.branch} into ${job.base}, titled “${mrTitle}”, with the rest of the MR text as its description. One already open for the branch is reused.`,
    'mr-merge': hasMr(job)
      ? `Merges merge request #${job.mr.number} (${job.branch}) into ${job.base} on ${host} through its API, as a merge commit. Nothing is pushed or forced; the host refuses a merge request it cannot merge (conflicts, failing required checks, a draft) and says why.`
      : '',
    approve: `Pushes branch ${job.branch} to origin: the one commit the factory prepared at Clean, rebased onto ${job.base}. Nothing is committed or rebased now; a tip edited by hand is refused unless pushed as it is.`,
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
  renderActions();
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
  ok.className = discard ? 'btn btn-danger' : 'btn btn-primary';
}

function closeConfirm() {
  state.confirm = null;
  $('confirm').hidden = true;
  renderConfirmItems(null);
  $('discard').checked = false;
  $('as-is').checked = false;
  $('keep-files').checked = false;
  renderActions();
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

function sendSay() {
  const key = state.key;
  const message = $('say-input').value;
  if (key === null || message.trim() === '' || availability('say', state.detail?.job ?? null) !== '') {
    return;
  }
  void run('say', key, { message });
}


// ---------- The board (SF-077: the v3 board of docs/design/dashboard-v3/prototype.html) ----------

// The column of each job state; the tickets without a live job are in the Queue. One column per
// ticket (SF-057): a ticket whose last job failed or was aborted is in the Queue (to start again),
// not also in Done; a pushed one is only in Done.
const COLUMN_OF = {
  starting: 'implementing', working: 'implementing',
  awaiting_review: 'reviewing', preparing_mr: 'reviewing',
  needs_human: 'you', ready_for_human_review: 'you', paused: 'you',
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
const canApprove = (job) => job.state === 'ready_for_human_review' || (job.state === 'needs_human' && typeof job.prepared_commit === 'string' && job.worktree === null);

// The merge request on the Git host (SF-048): the job has one; Create merge request applies to a
// branch ready to approve (push, then open) and to a pushed one without an open or merged one;
// Merge to an open one. mrOff: why the actions are off for the job's workspace, or ''.
const hasMr = (job) => job.mr !== null && typeof job.mr === 'object';
const canCreateMr = (job) => canApprove(job) || (job.state === 'pushed' && !(hasMr(job) && job.mr.state !== 'closed'));
const canMerge = (job) => job.state === 'pushed' && hasMr(job) && job.mr.state === 'open';
const mrOff = (job) => (job.mr_host === null || typeof job.mr_host !== 'object' ? 'the Git host is not known yet.'
  : typeof job.mr_host.reason === 'string' && job.mr_host.reason !== '' ? `${job.mr_host.reason}.` : '');

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
  // The simplification pass runs after the gate, before MR preparation (SF-055).
  if (code === SIMPLIFY_CODE) {
    return 3;
  }
  if (canApprove(job)) {
    return 4;
  }
  return code.startsWith('mr_') ? 3 : 0;
}

// Where a paused job stopped (SF-067): the turn, the review, the gate or the simplification pass.
function pausedSegment(job) {
  const step = job.paused?.step;
  if (step === 'turn' || job.paused?.from === 'working') {
    return 0;
  }
  return step === 'simplify' ? 3 : step === 'gate' || job.review === 'clean' ? 2 : 1;
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
    case 'paused':
      // Held where the pause stopped it (SF-067).
      return { segment: pausedSegment(job), halted: true, complete: false };
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

// A duration as the prototype writes it: "14 min", "1 h 4 min".
const dur = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
// An estimated cost (the jobs payload's cost_usd): "$1.23", or "—" without one.
const money = (value) => (typeof value === 'number' ? `$${value.toFixed(2)}` : '—');
const firstLine = (text) => (typeof text === 'string' ? text.split('\n')[0].trim() : '');
const counted = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// The iteration a job shows, numbered from 1, the same on its card and on its page (SF-078 uses it
// too): the one under way while the Implementer works on it (starting, working, paused in its
// turn, stopped by its session), else the last one published; never 0.
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

// The stop codes (SF-077): one table for the cards and the job page (SF-078 uses it for the job
// header, the stop block and the composer). A decision (the factory needs the user's choice;
// nothing failed) never shows as an error; an error does. Each entry: its kind, the card's reason,
// the sentence (with the job's numbers, or the words without one that is not known) and the
// card's button. N, M, X and T come from the job; the codes of factory/src.
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

// What the cards need of the board as a whole: whether it shows more than one workspace.
const board = { multi: false };

// The first line of a job card: the key, the workspace when the board shows more than one, the
// code of a stopped job, and the money: the cost so far and the time since the start while it
// runs, the cost and the time it took when it does not.
function cardRow(job) {
  const row = el('div', 'row1');
  row.append(el('span', 'key', job.ticket));
  if (board.multi) {
    row.append(el('span', 'tag', job.workspace));
  }
  if (job.state === 'needs_human' && typeof job.error?.code === 'string') {
    const code = el('span', 'tag', job.error.code);
    code.setAttribute('title', 'error code');
    row.append(code);
  }
  const running = RUNNING.includes(job.state);
  const end = running ? Date.now() : Date.parse(job.updated_at);
  row.append(el('span', 'money', `${money(job.cost_usd)}${running ? ' so far' : ''} · ${dur(end - Date.parse(job.created_at))}`));
  return row;
}

// A job card (the prototype's jobCard): a click opens the job's page; one primary action only where
// the user acts (Your turn); a pushed card keeps its merge request and Archive ticket.
function jobCard(job) {
  const key = keyOf(job);
  const item = el('li', 'card');
  item.setAttribute('tabindex', '0');
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
    item.append(el('div', 'reason ready', 'Ready to push: reviews clean, MR text written'), el('div', 'meta', `Iteration ${shownIteration(job)}`), ...yourTurn(job));
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
  return item;
}

// The one primary action of a Your turn card, and the job's last outcome. It opens the job's page
// at the stop or the message box (with the Approve confirmation for a branch to push), except
// Retry review and Resume, which go at once; a prepared branch also offers Create merge request….
function yourTurn(job) {
  const key = keyOf(job);
  const act = el('div', 'act');
  let primary;
  if (job.state === 'ready_for_human_review') {
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
// ticket (its Task drawer until SF-081); the last job's mark opens that failed or aborted job;
// Start (confirmed) or "waiting for the plan" for a skeleton, Check, Archive and Delete….
function queueCard(row) {
  const key = keyOf(row);
  const item = el('li', state.highlight === key ? 'card hl' : 'card');
  item.setAttribute('tabindex', '0');
  item.dataset.ticket = key;
  const head = el('div', 'row1');
  head.append(el('span', 'key', row.ticket));
  if (board.multi) {
    head.append(el('span', 'tag', row.workspace));
  }
  const last = lastJobState(row);
  if (last !== null) {
    const mark = button('tag', `last job ${last}`, { open: key });
    mark.title = 'Open the last job';
    mark.disabled = jobByKey(key) === null; // only from the tickets list: nothing to open yet
    head.append(mark);
  }
  head.append(el('span', 'money', checkNote(row)));
  item.append(head, el('div', 'title', row.title));
  const act = el('div', 'act');
  const busy = state.setupPending.has(`ticket:${key}`) || state.ticketConfirm !== null;
  if (row.draft) {
    act.append(el('span', 'muted', 'waiting for the plan'));
  } else {
    const start = button('btn primary small', 'Start', { qact: 'start', key });
    start.disabled = busy || state.startHolds.has(key);
    act.append(start);
    if (row.check !== null && typeof row.check === 'object') {
      const check = button('btn small', 'Check', { qact: 'check', key });
      check.title = 'A read-only Claude session reads the Task file and the repository and says whether it is ready; it only advises';
      check.disabled = row.check.running === true || state.setupPending.has(`check:${key}`);
      act.append(check);
    }
  }
  const archive = button('btn small', 'Archive', { qact: 'archive', key });
  archive.disabled = busy;
  archive.title = 'Move the Task file to .software-factory/archive/; a finished job of the ticket leaves the board';
  const remove = button('btn small danger', 'Delete…', { qact: 'delete', key });
  remove.disabled = busy;
  act.append(archive, remove);
  item.append(act);
  return item;
}

const visible = (workspace) => state.filter === '' || workspace === state.filter;

// The workspace filter in the top bar: All and one button per workspace.
function renderFilter() {
  const names = (state.workspaces ?? []).map((row) => row.name);
  if (state.filter !== '' && state.workspaces !== null && !names.includes(state.filter)) {
    state.filter = '';
  }
  const node = $('workspace-filter');
  node.hidden = names.length === 0;
  node.replaceChildren(...[['', 'All workspaces'], ...names.map((name) => [name, name])].map(([name, label]) => {
    const filter = button(state.filter === name ? 'on' : '', label, { ws: name });
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
  board.multi = new Set([...planned, ...jobs].map((entry) => entry.workspace)).size > 1;
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
  showHighlight();
  scheduleRefresh();
}

// The new ticket's card, once the stream lists it (SF-066): scrolled to and focused once; it stays
// highlighted until another ticket is created. Until SF-081 this stands for the ticket's page.
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
// it; pending: the hash names a job or ticket not loaded yet.
const ui = { screen: 'board', job: null, ticket: null, opener: null, pending: false };
// The tab of the moved job detail each job screen selects; the Stream keeps the tab chosen.
const SCREEN_TAB = { changes: 'changes', mr: 'mr' };

// The URL hash of the view: #<ws>/<ticket> (the Stream), #<ws>/<ticket>/changes, /mr, /ticket;
// a new one is a new history entry, so Back and Forward move between them.
function setHash() {
  const h = ui.screen === 'board' ? '' : ui.screen === 'ticket' ? `${ui.ticket}/ticket` : ui.screen === 'stream' ? ui.job : `${ui.job}/${ui.screen}`;
  if (decodeURIComponent(location.hash.slice(1)) !== h) {
    history.pushState(null, '', `#${h}`);
  }
}

// The job page's header (SF-078 adds its switch and facts): ← Board, the key and the title, the
// sentence, the iteration and the branch.
function renderHead() {
  const job = ui.job === null ? null : (jobByKey(ui.job) ?? (state.detail !== null && keyOf(state.detail.job) === ui.job ? state.detail.job : null));
  if (job === null) {
    return;
  }
  $('job').className = `st-${job.state}`;
  const backButton = button('btn back', '← Board', { back: '' });
  backButton.title = 'Back to the board';
  const t1 = el('div', 't1');
  const title = el('span', 'title', titleOf(job));
  title.setAttribute('title', titleOf(job));
  t1.append(el('span', 'key', job.ticket), title);
  if (job.state === 'needs_human' && typeof job.error?.code === 'string') {
    t1.append(el('span', 'tag', job.error.code));
  }
  const t2 = el('div', 't2');
  const line = el('span', 'sentence');
  line.append(el('span', 'dot'), document.createTextNode(sentence(job)));
  t2.append(line, el('span', '', `Iteration ${shownIteration(job)}`), el('span', 'mono fs12', job.branch));
  $('jhead').replaceChildren(backButton, t1, t2);
}

// Opens a job's page on a screen; focus 'stop' or 'composer' is where its card's action points;
// confirm ('approve', 'mr-create', 'mr-merge') opens that confirmation once its detail is shown.
function go(key, screen = 'stream', focus = undefined, confirm = undefined) {
  if (jobByKey(key) === null) {
    return;
  }
  if (state.drawer !== null) {
    hideDrawer();
  }
  const from = ui.screen;
  ui.screen = screen;
  ui.job = key;
  ui.ticket = null;
  ui.opener = key;
  ui.pending = false;
  $('board').hidden = true;
  $('ticket').hidden = true;
  $('job').hidden = false;
  if (SCREEN_TAB[screen] !== undefined) {
    selectTab(SCREEN_TAB[screen]);
  } else if (SCREEN_TAB[from] !== undefined && SCREEN_TAB[state.tab] !== undefined) {
    // From Changes or Merge request back to the Stream: the Live log is the old page's stream.
    selectTab('log');
  }
  state.wantConfirm = confirm === undefined ? null : { action: confirm, key };
  select(key);
  renderHead();
  setHash();
  openWantedConfirm();
  state.wantFocus = focus ?? null;
  applyWantedFocus();
}

// Where a card's button points once the job's detail is shown: the message box ('composer') or
// the next action with the stop's findings ('stop').
function applyWantedFocus() {
  const focus = state.wantFocus;
  if (focus === null || state.detail === null || keyOf(state.detail.job) !== ui.job) {
    return;
  }
  state.wantFocus = null;
  if (focus === 'composer' && !$('say-input').disabled) {
    $('say-input').focus();
  } else {
    $('next-panel').scrollIntoView({ block: 'center' });
  }
}

// Opens a planned ticket's page: until SF-081, the board with the ticket's Task drawer.
function openTicket(key) {
  const row = ticketByKey(key);
  if (row === null) {
    return;
  }
  if (ui.job !== null) {
    leaveJob();
  }
  ui.screen = 'ticket';
  ui.ticket = key;
  ui.job = null;
  ui.opener = key;
  ui.pending = false;
  $('job').hidden = true;
  $('ticket').hidden = true;
  $('board').hidden = false;
  void openTask(row, false);
  setHash();
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

// The jobs changed (the stream, a read): the board and the open job's header; a job page whose job
// left the board (its ticket archived or deleted) goes back to the board.
function renderJobs() {
  if (ui.job !== null && jobByKey(ui.job) === null) {
    back();
    return;
  }
  renderBoard();
  renderHead();
}

// The delegated click listener of the top bar, the board, the cards, the job page's header and
// the toast (the moved job detail and the drawer keep their own listeners until SF-078 and SF-081).
function onClick(event) {
  const target = typeof event.target?.closest === 'function'
    ? event.target.closest('[data-qact],[data-run],[data-open],[data-ticket],[data-back],[data-ws],#done-all,#toast-close,#open-workspaces,#open-new-ticket,#open-archived')
    : null;
  // A link (a merge request's) goes where it points; it does not open the card around it.
  if (target === null || target.disabled || (typeof event.target.closest === 'function' && event.target.closest('a') !== null)) {
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
    state.filter = target.dataset.ws;
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
  }
}

// The delegated keys: j and k move between the board's cards, Enter opens the focused one; Escape
// on a job or ticket page goes back one level (a screen of the job to its Stream, the Stream to the
// board) and closes the toast first. Alt+Up and Alt+Down move a queued card with SF-071's queue.
function onKey(event) {
  if (event.defaultPrevented) {
    return;
  }
  const target = event.target;
  if (typeof target?.closest === 'function' && target.closest('textarea, input, select') !== null) {
    if (event.key === 'Escape' && ui.screen !== 'board') {
      target.blur();
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
    if (ui.screen === 'changes' || ui.screen === 'mr') {
      go(ui.job, 'stream');
    } else {
      back();
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

// ---------- The drawer: Workspaces, New ticket, Archived and a planned ticket's Task ----------

// The job opens as its page (#job); the drawer stays for the setup panels and, until SF-081, a
// planned ticket's Task.
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

// The drawer's ✕, its scrim and Escape: a planned ticket's page goes back to the board.
function closeDrawer() {
  if (state.drawer === null) {
    return;
  }
  if (ui.screen === 'ticket') {
    back();
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
  $('detail').hidden = true;
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

// The Task text in the drawer, as text: headings bold by a line rule, never HTML from the file.
async function openTask(row, archived) {
  const key = `${row.workspace}/${row.ticket}`;
  const task = { key, archived, checkStamp: checkStampOf(key) };
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
  if (archived || row.draft === true) {
    $('task-check').hidden = true;
    $('task-check').replaceChildren();
  } else {
    await showCheck('task-check', key, () => state.task === task);
  }
}

// The open Task drawer shows the check again when the ticket's check changed (one started or ended).
function refreshTaskCheck() {
  const task = state.task;
  if (task === null || task.archived) {
    return;
  }
  const stamp = checkStampOf(task.key);
  if (stamp !== null && task.checkStamp !== stamp) {
    void showCheck('task-check', task.key, () => state.task === task);
  }
  task.checkStamp = stamp;
}

// What changes when a ticket's check starts, ends or goes stale; null without one on the board.
function checkStampOf(key) {
  const check = (state.tickets ?? []).find((entry) => keyOf(entry) === key)?.check;
  return check !== null && typeof check === 'object' ? `${check.running}#${check.ended_at}#${check.stale}` : null;
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
  const describe = (data) => ({ level: 'ok', text: `Ticket created: ${data.path} in ${data.workspace} (base ${data.base}), an empty skeleton in the Queue. Next: a click on its card opens the conversation; your words are its first message.` });
  const result = await setupRequest('ticket', 'api/tickets', { workspace, ticket, title, request }, 'ticket-status', describe);
  // Created (SF-066): the dialog closes and the new ticket's card is highlighted (its page, once
  // SF-081 lands); a failure keeps the dialog open with the error and the input.
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
// cannot be undone.
function openTicketConfirm(action, row) {
  const key = `${row.workspace}/${row.ticket}`;
  if (state.ticketConfirm !== null) {
    return;
  }
  state.ticketConfirm = { action, key, row };
  if (action === 'start') {
    $('ticket-confirm-title').textContent = `Start ${row.ticket} in ${row.workspace}?`;
    // The Task check only advises (SF-054): its note is part of the text, Start stays on.
    const note = typeof row.check?.start_note === 'string' ? ` Task check: ${row.check.start_note}.` : '';
    $('ticket-confirm-text').textContent = `Starts a job on .software-factory/${row.ticket}.md of workspace ${row.workspace}: a new branch from ${row.base} in its own worktree, where the Implementer runs iteration 1. Claude reviews it, the Codex gate checks it, and the branch comes back to you to approve.${note}`;
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
  setSetupStatus('toast', { level: 'pending', text: `Starting ${key}: creating the branch and its worktree…` });
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
  setSetupStatus('toast', outcome);
  renderBoard();
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

// One line of the Live log, marked with who it comes from and hidden by the filter.
function appendEvent(event) {
  const events = $('events');
  const source = eventSource(event);
  const block = el('div', `event t-${event.type} from-${source}`, event.text);
  block.dataset.source = source;
  block.hidden = !logShows(source);
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
    renderSetup();
    refreshTaskCheck();
    if (ui.pending) {
      route();
    }
  });
  source.addEventListener('job', (message) => {
    if (key === state.key) {
      renderDetail(JSON.parse(message.data));
      renderHead();
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
  state.drawn = null;
  state.target = null;
  state.jobTask = null;
  state.mrText = null;
  state.lastLine = -1;
  $('events').replaceChildren();
  $('iteration-report').replaceChildren();
  $('patch-body').replaceChildren();
  $('job-task').replaceChildren();
  $('mr-panel').hidden = true;
  $('mr-unapplied').hidden = true;
  $('follow').checked = true;
  for (const [box, status] of [['checkout-text', 'checkout-copy-status'], ['mr-copy-text', 'mr-copy-status']]) {
    $(box).hidden = true;
    $(status).textContent = '';
  }
  // The controls go off until this job's detail arrives; its draft and last outcome come back.
  closeConfirm();
  $('say-input').value = state.drafts.get(key) ?? '';
  renderOutcome(state.outcomes.get(key) ?? null);
  $('action-doubt').textContent = state.doubts.get(key) ?? '';
  renderActions();
  openStream();
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
  $('log-filters').replaceChildren(...LOG_FILTERS.map(([filter, label]) => {
    const button = el('button', '', label);
    button.type = 'button';
    button.dataset.filter = filter;
    button.addEventListener('click', () => setLogFilter(filter));
    return button;
  }));
  renderLogFilters();
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
  // Back and Forward of the browser, and a link to a job or ticket.
  window.addEventListener('hashchange', route);

  // The new parts (the top bar, the board, the cards, the routing, the keys, the toast): one
  // delegated listener each.
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
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
  $('task-conversation-copy').addEventListener('click', () => copyText($('task-conversation-text'), 'conversation-copy-status'));

  // The job detail, moved into the job page until SF-078.
  $('approve-button').addEventListener('click', () => openConfirm('approve'));
  $('mr-create-button').addEventListener('click', () => openConfirm('mr-create'));
  $('mr-merge-button').addEventListener('click', () => openConfirm('mr-merge'));
  $('mr-status-button').addEventListener('click', () => {
    const job = state.detail?.job ?? null;
    if (job !== null && availability('mr-status', job) === '') {
      void run('mr-status', keyOf(job), {});
    }
  });
  $('archive-job-button').addEventListener('click', () => {
    if (state.key !== null) {
      void run('archive', state.key, {});
    }
  });
  $('abort-button').addEventListener('click', () => openConfirm('abort'));
  // Pause and Resume go at once (SF-067); Restart is confirmed. Resume of a job paused during a
  // turn takes the message written below, if any.
  $('pause-button').addEventListener('click', () => {
    const job = state.detail?.job ?? null;
    if (job !== null && availability('pause', job) === '') {
      void run('pause', keyOf(job), {});
    }
  });
  $('resume-button').addEventListener('click', () => {
    const job = state.detail?.job ?? null;
    if (job !== null && availability('resume', job) === '') {
      const message = $('say-input').value;
      void run('resume', keyOf(job), pausedTurn(job) && message.trim() !== '' ? { message } : {});
    }
  });
  $('restart-button').addEventListener('click', () => openConfirm('restart'));
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
  $('keep-files').addEventListener('change', renderConfirmButton);
  $('accept-gate-button').addEventListener('click', () => openConfirm('accept'));
  $('simplify-button').addEventListener('click', () => openConfirm('simplify'));
  $('copy-checkout').addEventListener('click', () => {
    const job = state.detail?.job;
    if (job) {
      copyValue(`git checkout ${job.branch}`, $('checkout-text'), 'checkout-copy-status');
    }
  });
  $('mr-copy').addEventListener('click', () => {
    if (typeof state.mrText === 'string') {
      copyValue(mrCopyText(state.mrText), $('mr-copy-text'), 'mr-copy-status');
    }
  });
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
