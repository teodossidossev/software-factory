// header.js, the dashboard's fourth script (DASHBOARD_SCRIPTS in src/dashboard.ts), built from
// web/header.ts into dist/web/: the board's top bar. One row from 1100 px: the name, "N waits for
// you", the page tabs, the workspace select, the factory pill and New ticket; below 1100 px a second
// row holds a page select and the workspace select (app.css). The pill's dot, words and popover
// with the checks are health.js's; this file gives the pill its running count and fills the
// popover's run queue part (the run limit's stepper, the queue's status and the rule at a usage
// limit's reset), which shows only when the tickets payload carries the queue. A classic script,
// loaded in order with defer, sharing the page's globals with the others. This file has no import
// or export on purpose: the compiler keeps it a script, so its top-level names stay the page's
// globals.
'use strict';

// The run limit's range.
const LIMIT_MIN = 1;
const LIMIT_MAX = 20;

// The pages of the page select (below 1100 px) and what each opens: the same as the tabs.
const PAGE_OPEN: Readonly<Record<string, () => void>> = {
  digest: () => openDigest(null),
  stats: () => openStats(),
  'merge-requests': () => openMergeRequests(),
  archived: () => openArchived(),
  workspaces: () => openWorkspaces(),
  skills: () => openSkills(),
};

// The jobs that wait for the user, in every workspace whatever the filter: Your turn's.
const waitingJobs = (): JobRow[] => state.jobs.filter((job) => COLUMN_OF[job.state] === 'you');

// The running count of the pill: the queue's when the payload has the queue, with its limit; else
// the running jobs of every workspace.
function runningText(): string {
  const queue = state.queue;
  return queue !== null ? `${queue.running}/${queue.max_running} running` : `${state.jobs.filter((job) => RUNNING.includes(job.state)).length} running`;
}

// "N waits for you": hidden at 0; "(hidden)" when the workspace filter hides some of them.
function renderWaits(): void {
  const node = byId('waits');
  const waiting = waitingJobs();
  const n = waiting.length;
  node.hidden = n === 0;
  const hidden = waiting.filter((job) => !visible(job.workspace)).length;
  const words = [document.createTextNode(`${n} wait${n === 1 ? 's' : ''} for you`)];
  node.replaceChildren(...words, ...(hidden > 0 ? [el('span', 'hid', ' (hidden)')] : []));
  node.title = hidden > 0 ? `${hidden} of them in a workspace the filter hides: a click shows every workspace` : 'Show Your turn';
}

// The workspace filter: a select with every workspace, its full name and its count of jobs.
function renderFilter(): void {
  const names = (state.workspaces ?? []).map((row) => row.name);
  if (state.filter !== '' && state.workspaces !== null && !names.includes(state.filter)) {
    state.filter = '';
  }
  const node = byIdAs('workspace-filter', 'select');
  node.hidden = names.length === 0;
  const count = (name: string): number => state.jobs.filter((job) => name === '' || job.workspace === name).length;
  node.replaceChildren(...[['', 'All workspaces'] as const, ...names.map((name) => [name, name] as const)].map(([name, label]) => {
    const option = el('option', '', `${label} (${count(name)})`);
    option.value = name;
    return option;
  }));
  node.value = state.filter;
}

// The top bar: the waits, the filter, Archived's count, the pill's running count and the run queue.
function renderHeader(): void {
  renderWaits();
  renderFilter();
  const archived = `(${state.archived.length})`;
  byId('archived-count').textContent = archived;
  byId('page-archived').textContent = `Archived ${archived}`;
  byId('health-run').textContent = runningText();
  renderPill();
  renderRunQueue();
}

// "N waits for you"'s click: a filter that hides some of them goes, and Your turn scrolls into view.
function showYourTurn(): void {
  if (waitingJobs().some((job) => !visible(job.workspace))) {
    state.filter = '';
    renderBoard();
  }
  document.querySelector<HTMLElement>('#cols .col.you')?.scrollIntoView({ block: 'nearest' });
}

// The popover's run queue: Run up to N jobs at once with its stepper, and the status line (the
// running count, the free slots and the next ticket, or the hold); hidden without the queue.
function renderRunQueue(): void {
  const bar = byId('qctl');
  const queue = state.queue;
  bar.hidden = queue === null;
  if (queue === null) {
    return;
  }
  const busy = state.setupPending.has('queue:limit');
  byId('limVal').textContent = String(queue.max_running);
  byIdAs('limDown', 'button').disabled = busy || queue.max_running <= LIMIT_MIN;
  byIdAs('limUp', 'button').disabled = busy || queue.max_running >= LIMIT_MAX;
  const status = byId('qstatus');
  // A job parked on a usage limit holds the queue, whatever the hold by hand.
  const limitHold = queue.limit_hold !== null && typeof queue.limit_hold === 'object' ? queue.limit_hold : null;
  status.className = queue.held || limitHold !== null ? 'qstatus held' : 'qstatus';
  const free = Math.max(0, queue.max_running - queue.running);
  status.textContent = limitHold !== null
    ? `Queue held: usage limit${typeof limitHold.resets_at === 'string' ? `, resets at ${clock(limitHold.resets_at)}` : ' reset, resume the parked jobs'} · ${queue.running} running`
    : queue.held
      ? `Queue held${queue.hold_reason ? `: ${queue.hold_reason}` : ''} · ${queue.running} running`
      : `${queue.running} running · ${free} slot${free === 1 ? '' : 's'} free · next: ${queue.next?.ticket ?? 'nothing ready'}`;
  const busyRule = state.setupPending.has('queue:rule');
  for (const rule of ON_LIMIT_RULES) {
    const input = byIdAs(`rule-${rule}`, 'input');
    input.checked = queue.on_limit === rule;
    input.disabled = busyRule;
  }
}

// The toast after a rule was saved.
const RULE_TEXT: Readonly<Record<string, string>> = {
  'resume-then-queue': 'At a usage limit reset the parked jobs resume, then the queue goes on.',
  'resume-only': 'At a usage limit reset the parked jobs resume; the queue stays held until you release it.',
  wait: 'At a usage limit reset nothing resumes: you resume the parked jobs.',
};
// A rule chosen in the popover: posted once unless it is the queue's already (api/queue/rule); the
// board shows the server's queue.
function setRule(rule: string): void {
  if (state.queue === null || !ON_LIMIT_RULES.some((known) => known === rule) || rule === state.queue.on_limit) {
    return;
  }
  void setupRequest('queue:rule', 'api/queue/rule', { rule }, 'toast', (data) => ({ level: 'ok', text: RULE_TEXT[String(fieldOf(data, 'on_limit'))] ?? 'Rule saved.' }));
}

// One job more or fewer at once (the stepper), within 1-20.
function setLimit(delta: number): void {
  const queue = state.queue;
  const next = queue === null ? NaN : queue.max_running + delta;
  if (!(next >= LIMIT_MIN && next <= LIMIT_MAX)) {
    return;
  }
  void setupRequest('queue:limit', 'api/queue/limit', { max_running: next }, 'toast', (data) =>
    ({ level: 'ok', text: `Run up to ${fieldOf(data, 'max_running')} job${fieldOf(data, 'max_running') === 1 ? '' : 's'} at once.` }));
}

function initHeader(): void {
  byId('waits').addEventListener('click', showYourTurn);
  byId('open-merge-requests').addEventListener('click', openMergeRequests);
  byId('open-skills').addEventListener('click', openSkills);
  // The page select opens what the tabs open, then shows the board again (the bar is the board's).
  const pages = byIdAs('page-select', 'select');
  pages.value = 'board';
  pages.addEventListener('change', () => {
    const open = PAGE_OPEN[pages.value];
    pages.value = 'board';
    // A page opened here comes without a hashchange: the Merge requests page hides first (it shows
    // itself again when it is the one chosen).
    byId('merge-requests').hidden = true;
    open?.();
  });
  const filter = byIdAs('workspace-filter', 'select');
  filter.addEventListener('change', () => {
    state.filter = filter.value;
    renderBoard();
  });
}
