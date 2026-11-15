// home.js, a dashboard script (DASHBOARD_SCRIPTS in src/dashboard.ts) right after routing.js,
// built from web/home.ts into dist/web/: the two main views under the top bar, the home
// (#home) and the board (#cols), and the home itself. The home shows what needs the user, the
// jobs of Your turn of the workspaces the filter shows, the oldest wait first, each card with the
// board's own buttons (board.js yourTurn) and the job page's sentence (board.js sentence); the
// Coordinator card (coordinator.js) moves under it while the home is shown. It decides no rule of
// a stop and reads nothing from the server: renderBoard draws it, so it follows the stream, the
// 15 s refresh and the one-minute tick as the board does. Every value goes in through
// textContent. A classic script, loaded in order with defer, sharing the page's globals with the
// others. This file has no import or export on purpose: the compiler keeps it a script, so its
// top-level names stay the page's globals.
'use strict';

// Shows a main view (the home or the board) under the shared top bar: leaves a job page and closes
// the drawer, hides the job and ticket pages and the other pages, places the Coordinator card,
// draws, and puts the focus on the card that opened the page left, when the view shows it.
function showMain(view: MainView): void {
  if (ui.job !== null) {
    leaveJob();
  }
  if (state.drawer !== null) {
    hideDrawer();
  }
  ui.screen = view;
  ui.job = null;
  ui.ticket = null;
  byId('job').hidden = true;
  byId('ticket').hidden = true;
  leavePages();
  byId('board').hidden = false;
  byId('home').hidden = view !== 'home';
  byId('cols').hidden = view !== 'board';
  placeCoordinator();
  renderBoard();
  setHash();
  if (ui.opener !== null) {
    document.querySelector<HTMLElement>(`#${view === 'home' ? 'home' : 'cols'} .card[data-key="${ui.opener}"]`)?.focus();
  }
}

// Back from a page: the main view it shows, the focus on the card that opened the page. Every Back
// goes to the board for now.
function back(): void {
  showMain('board');
}

// The Home tab, the page select's Home and #home.
function openHome(): void {
  showMain('home');
}

// The one Coordinator card on the main view shown: right after Needs you on the home, right before
// the columns on the board (its place in dashboard.html). Only placeCoordinator moves it, so a card
// already inside the view's parent is in place and stays.
function placeCoordinator(): void {
  const card = byId('coord');
  if (ui.screen === 'home') {
    if (card.parentElement !== byId('home')) {
      byId('home-needs').after(card);
    }
  } else if (card.parentElement !== byId('board')) {
    byId('cols').before(card);
  }
}

// The class of a card's sentence: an error stop, another stop (a question), a branch ready, or
// none (paused).
function sayClass(job: JobRow): string {
  if (job.state === 'needs_human') {
    return job.stop_kind === 'error' ? 'err' : 'ask';
  }
  return job.state === 'ready_for_human_review' || job.state === 'handed_over' ? 'ready' : '';
}

// A Needs you card: the board's card (its stripe, its key, a click opens the job's Stream) with the
// first line (the key, the workspace, a stop's code and how long it waits), the title, the job
// page's sentence, the note of a refused hand-over or of a changed Task file, and Your turn's
// buttons and last outcome.
function homeNeedCard(job: JobRow): HTMLLIElement {
  const key = keyOf(job);
  const item = boardCard(key, job.workspace);
  item.dataset.open = key;
  const row = el('div', 'row1');
  row.append(el('span', 'key', job.ticket), wsChip(job.workspace));
  if (job.state === 'needs_human' && typeof job.error?.code === 'string') {
    const code = el('span', 'tag', job.error.code);
    code.setAttribute('title', 'error code');
    row.append(code);
  }
  const age = el('span', 'hm-age', ago(job.updated_at));
  age.setAttribute('title', `Waiting since ${localTime(job.updated_at)}`);
  row.append(age);
  const said = sentence(job);
  item.append(row, el('div', 'title', titleOf(job)), el('div', `hm-say ${sayClass(job)}`.trim(), /[.!?]$/.test(said) ? said : `${said}.`));
  const note = job.state === 'ready_for_human_review' ? skippedNote(job).trim()
    : job.state === 'paused' && job.task_changed === true ? 'Task file changed since the job started' : '';
  if (note !== '') {
    item.append(el('div', 'meta note', note));
  }
  item.append(...yourTurn(job));
  return item;
}

// The home (renderBoard calls it): Needs you, the jobs that wait for the user in the workspaces the
// filter shows, the oldest wait first (a tie by key), and their count. Nothing while another view
// is shown; a focused card of the home has the focus again after the drawing.
function renderHome(): void {
  if (ui.screen !== 'home') {
    return;
  }
  const focused = closestOf(document.activeElement, '#home .card')?.dataset.key ?? null;
  const jobs = waitingJobs().filter((job) => visible(job.workspace))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || keyOf(a).localeCompare(keyOf(b)));
  byId('home-needs-count').textContent = String(jobs.length);
  byId('home-needs-list').replaceChildren(...(jobs.length > 0 ? jobs.map(homeNeedCard) : [el('li', 'empty', EMPTY_TEXT.you)]));
  if (focused !== null) {
    document.querySelector<HTMLElement>(`#home .card[data-key="${focused}"]`)?.focus();
  }
}
