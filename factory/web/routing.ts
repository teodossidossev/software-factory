// routing.js, the dashboard's sixth script (DASHBOARD_SCRIPTS in src/dashboard.ts), built from
// web/routing.ts into dist/web/: the view shown, the routing and the page's delegated
// click, input, change and key handlers. A classic script, loaded in order with defer, sharing the
// page's globals with the others. This file has no import or export on purpose: the compiler keeps
// it a script, so its top-level names stay the page's globals.
'use strict';

// An event's target as the page's element, or null when it is none (the tests' fake events may
// have no target: undefined).
const targetOf = (target: EventTarget | null | undefined): HTMLElement | null => (target !== undefined && isElement(target) && hasDataset(target) ? target : null);
// Whether a control is disabled (an element that has no disabled is not). No instanceof: the
// tests' fake page has no element classes.
const isDisabled = (node: HTMLElement): boolean => 'disabled' in node && node.disabled === true;
// A form field of the page: an input, a textarea or a select (by its tag name).
type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const isField = (node: Element | null): node is Field => isTag(node, 'input') || isTag(node, 'textarea') || isTag(node, 'select');

// ---------- The job page and the routing (the prototype's go, openTicket, route, setHash) ----------

// The two main views under the top bar (home.js showMain): the home and the board. FIRST_VIEW is
// the view of an empty hash.
type MainView = 'home' | 'board';
const FIRST_VIEW: MainView = 'board';

// The view shown: a main view, 'home' or 'board', a job's 'stream', 'changes' or 'mr' (ui.job is
// its key "<ws>/<ticket>"), or a planned ticket's page 'ticket' (ui.ticket); ui.opener is the key
// of the card that opened it, focused again by the main view back() shows (home.js);
// pending: the hash names a job or ticket not loaded yet. On the Stream: sel, the selected
// entry (j, k, G), and open, the toggles open.
// related: the card whose dependencies and dependents the board shows, or null. On
// Changes, cx as the prototype's: the view ('all' or an iteration), the selected file, the
// tree's cursor and rows, the filter, the flat list, the closed folders, the diff layout ('side' or
// 'uni', kept in localStorage), Collapse unchanged, the folds opened, the path a path link
// opened, checked against its iteration's list once it is read, and whether the tree is open
// (a phone folds it above the diff).
interface UiState {
  screen: string;
  job: string | null;
  ticket: string | null;
  opener: string | null;
  pending: boolean;
  sel: number;
  open: Set<string>;
  related: string | null;
  cx: {
    view: CxView;
    sel: string | null;
    cursor: string | null;
    rows: TreeRow[];
    q: string;
    flat: boolean;
    collapsed: Set<string>;
    mode: 'side' | 'uni';
    collapse: boolean;
    unfolded: Set<string>;
    check: string | null;
    tree: boolean;
  };
}
const ui: UiState = {
  screen: FIRST_VIEW, job: null, ticket: null, opener: null, pending: false, sel: -1, open: new Set(), related: null,
  cx: { view: 'all', sel: null, cursor: null, rows: [], q: '', flat: false, collapsed: new Set(), mode: 'side', collapse: true, unfolded: new Set(), check: null, tree: true },
};

// The URL hash of the view: none for FIRST_VIEW, #home or #board for the other main view,
// #<ws>/<ticket> (the Stream), #<ws>/<ticket>/changes, /mr, /ticket; a new one is a new history
// entry, so Back and Forward move between them.
function setHash(): void {
  const h = ui.screen === FIRST_VIEW ? '' : ['home', 'board', 'stats', 'merge-requests', 'skills'].includes(ui.screen) ? ui.screen : ui.screen === 'digest' ? (dg.id === null ? 'digest' : `digest/${dg.id}`) : ui.screen === 'ticket' ? `${ui.ticket}/ticket` : ui.screen === 'stream' ? ui.job : `${ui.job}/${ui.screen}`;
  if (decodeURIComponent(location.hash.slice(1)) !== h) {
    history.pushState(null, '', `#${h}`);
  }
}

// The job page's screen (the prototype's renderJobScreen): the header, and the Stream, the Changes
// or the Merge request screen.
function renderJobScreen(): void {
  renderHead();
  byId('scrStream').hidden = ui.screen !== 'stream';
  byId('scrChanges').hidden = ui.screen !== 'changes';
  byId('scrMr').hidden = ui.screen !== 'mr';
  if (state.detail === null || keyOf(state.detail.job) !== ui.job) {
    return;
  }
  if (ui.screen === 'changes') {
    renderChanges();
  } else if (ui.screen === 'mr') {
    showMr();
  }
}

// Opens a job's page on a screen; focus 'stop' or 'composer' is where its card's action points;
// confirm ('approve', 'mr-create', 'mr-merge', 'archive') opens that confirmation once its detail is shown.
// The Merge request screen waits for the MR text (written at Clean).
function go(key: string, screen = 'stream', focus: 'composer' | 'stop' | undefined = undefined, confirm: string | undefined = undefined): void {
  if (jobByKey(key) === null) {
    return;
  }
  if (screen === 'mr' && state.detail !== null && keyOf(state.detail.job) === key && state.detail.mr !== true) {
    toast({ level: 'info', text: 'No MR text yet: written at Clean' });
    if (ui.job === key && ui.screen !== 'board' && ui.screen !== 'home') {
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
    ui.cx = { ...ui.cx, view: screen === 'changes' ? ui.cx.view : 'all', sel: screen === 'changes' ? ui.cx.sel : null, q: '', collapsed: new Set(), unfolded: new Set(), cursor: null, check: screen === 'changes' ? ui.cx.check : null, tree: true };
  }
  if (screen !== 'changes') {
    byId('scrChanges').replaceChildren();
  }
  ui.screen = screen;
  ui.job = key;
  ui.ticket = null;
  ui.opener = key;
  ui.pending = false;
  byId('board').hidden = true;
  byId('ticket').hidden = true;
  leavePages();
  byId('job').hidden = false;
  state.wantConfirm = confirm === undefined ? null : { action: confirm, key };
  select(key);
  renderJobScreen();
  setHash();
  openWantedConfirm();
  state.wantFocus = focus ?? null;
  applyWantedFocus();
  if (screen === 'stream' && state.wantFocus === null && state.confirm === null) {
    byId('streamwrap').focus();
  } else if (screen === 'changes') {
    // The selected row, now or once the list arrives.
    const row = document.querySelector<HTMLElement>('#tlist .trow.sel');
    state.cx.focusTree = row === null;
    row?.focus();
  }
}

// Where a card's button points once the job's detail is shown: the message box, or the primary
// action when the box takes nothing now ('composer'), or the stop block ('stop').
function applyWantedFocus(): void {
  const focus = state.wantFocus;
  if (focus === null || state.detail === null || keyOf(state.detail.job) !== ui.job) {
    return;
  }
  state.wantFocus = null;
  if (focus === 'composer') {
    const box = byIdAs('msg', 'textarea');
    if (!box.disabled && !box.hidden) {
      box.focus();
    } else {
      byId('acts').querySelector<HTMLElement>('.btn.primary')?.focus();
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

// The view of the URL hash (on load and on every hashchange): #home and #board their main view; a
// hash of a job or ticket the board does not have, or an unknown one, shows FIRST_VIEW; a job or
// ticket is tried again when the jobs and tickets first arrive.
function route(): void {
  const hash = decodeURIComponent(location.hash.slice(1));
  // The Merge requests page hides on any other hash (the other pages' openers do not know it).
  byId('merge-requests').hidden = hash !== 'merge-requests';
  if (hash === 'home' || hash === 'board') {
    ui.pending = false;
    if (ui.screen !== hash) {
      showMain(hash);
    }
    return;
  }
  // The morning digest: #digest, the newest, or #digest/<id>.
  const digest = /^digest(?:\/([0-9A-Za-z-]+))?$/.exec(hash);
  if (digest !== null) {
    const id = digest[1] ?? null;
    if (ui.screen !== 'digest' || dg.id !== id) {
      openDigest(id);
    }
    return;
  }
  // The Stats, the Merge requests and the Skills pages.
  if (hash === 'stats' || hash === 'merge-requests' || hash === 'skills') {
    if (ui.screen !== hash) {
      ({ stats: openStats, 'merge-requests': openMergeRequests, skills: openSkills })[hash]();
    }
    return;
  }
  const match = /^([^/]+\/[^/]+?)(?:\/(changes|mr|ticket))?$/.exec(hash);
  if (match === null) {
    ui.pending = false;
    if (ui.screen !== FIRST_VIEW) {
      showMain(FIRST_VIEW);
    }
    return;
  }
  // The key's group always matches when the hash does.
  const key = match[1] ?? '';
  const sub = match[2];
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
  if (ui.screen !== FIRST_VIEW) {
    showMain(FIRST_VIEW);
  }
}

// The jobs changed (the stream, a read): the main views and the open job's header, its composer
// and its stop; a job page whose job left the board (its ticket archived or deleted) goes back to
// the main view back() shows (home.js).
function renderJobs(): void {
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

// The elements whose tap does something of its own: their titles are not shown by a tap.
const TIP_CONTROLS = 'button, a, input, select, textarea, summary, label, [role="tab"], [role="treeitem"], [role="menuitem"], .card';
// On a phone or a device without hover a tap shows what a hover shows: the title of
// the element tapped when it is the only place of that detail (not a control, not inside a
// card, whose tap opens its page), or a dependency chip's (its state in words).
function tipOf(target: EventTarget | null | undefined): string {
  const node = targetOf(target);
  if (!media(TOUCH_QUERY) || node === null) {
    return '';
  }
  const holder = node.closest('[title]');
  if (holder === null || (!holder.classList.contains('dchip') && holder.closest(TIP_CONTROLS) !== null)) {
    return '';
  }
  return holder.getAttribute('title') ?? '';
}

// The delegated click listener of the top bar, the board, the cards, the job page (its header, the
// Stream and the composer), the planned ticket page and the toast (the drawer keeps its own
// listeners).
function onClick(event: MouseEvent): void {
  const tip = tipOf(event.target);
  if (tip !== '') {
    toast({ level: 'info', text: tip });
  }
  const clicked = targetOf(event.target);
  const target = clicked !== null
    ? clicked.closest<HTMLElement>('[data-colfold],[data-cxtree],[data-tk],[data-tkimg],[data-tktab],[data-dep],[data-menu],[data-qact],[data-qtoggle],[data-qforce],#limUp,#limDown,[data-run],[data-open],[data-ticket],[data-back],[data-goto],[data-cfile],[data-changes],[data-fstep],[data-trow],[data-fold],[data-mode],[data-flat],[data-toggle],[data-act],[data-homenu],[data-dismiss],[data-settle],[data-copy-branch],[data-mr],[data-mrtab],[data-mrdiff],#stream li.e,#done-all,#toast-close,#open-workspaces,#open-new-ticket,#open-archived,#open-digest,#open-stats')
    : null;
  // An open ⋯ menu closes on any click but its own toggle (its items act, then it is closed).
  if (state.openMenu !== null && (target === null || target.dataset.menu === undefined)) {
    setCardMenu(null);
  }
  // The factory pill's popover closes on a click outside it.
  if (clicked !== null && clicked.closest('#health-wrap') === null) {
    closeHealth(false);
  }
  // The hand-over panel's More menu closes on a choice and on a click outside it.
  if (state.handoverMenu && clicked !== null && clicked.closest('[data-homenu]') === null
    && (clicked.closest('.ho-menu') === null || clicked.closest('[role="menuitem"]') !== null)) {
    setHandoverMenu(false);
  }
  if (target?.dataset.homenu !== undefined) {
    setHandoverMenu(!state.handoverMenu);
    return;
  }
  if (target?.dataset.dismiss !== undefined) {
    dismissOutcome();
    return;
  }
  // A link (a merge request's) goes where it points; it does not open the card around it.
  if (target === null || isDisabled(target) || (clicked !== null && clicked.closest('a') !== null)) {
    return;
  }
  if (target.dataset.tk !== undefined) {
    tkAction(target.dataset.tk);
    return;
  }
  if (target.dataset.tkimg !== undefined) {
    tkImageAction(target.dataset.tkimg, target.dataset.name);
    return;
  }
  // The Merge request screen: its bar, Edit | Preview, and the diff against the factory's text.
  if (target.dataset.mr !== undefined) {
    mrAction(target.dataset.mr);
    return;
  }
  if (target.dataset.mrtab !== undefined || target.dataset.mrdiff !== undefined) {
    const m = state.key === null ? undefined : MR.get(state.key);
    if (m?.view) {
      if (target.dataset.mrtab !== undefined) {
        m.tab = target.dataset.mrtab === 'preview' ? 'preview' : 'edit';
        m.showChanges = false;
      } else {
        m.showChanges = target.dataset.mrdiff === 'on' ? true : !m.showChanges;
      }
      renderMr();
    }
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
  if (target.dataset.colfold !== undefined) {
    toggleFold(target.dataset.colfold);
    return;
  }
  if (target.dataset.cxtree !== undefined) {
    ui.cx.tree = !ui.cx.tree;
    renderChanges();
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
  } else if (target.id === 'open-digest' || target.id === 'open-stats') {
    // The tabs open their page without a hashchange: the Merge requests page hides here.
    byId('merge-requests').hidden = true;
    (target.id === 'open-digest' ? () => openDigest(null) : openStats)();
  } else if (target.dataset.qact !== undefined) {
    // The Queue card's buttons carry data-key (board.js queueCard); no ticket has the key ''.
    queueAction(target.dataset.qact, target.dataset.key ?? '');
  } else if (target.dataset.qtoggle !== undefined) {
    queueToggle(target.dataset.qtoggle);
  } else if (target.dataset.qforce !== undefined) {
    queueForce(target.dataset.qforce);
  } else if (target.id === 'limUp' || target.id === 'limDown') {
    setLimit(target.id === 'limUp' ? 1 : -1);
  } else if (target.dataset.run !== undefined) {
    // A card's buttons carry data-key (board.js); no job has the key ''.
    cardRun(target.dataset.run, target.dataset.key ?? '');
  } else if (target.dataset.open !== undefined) {
    go(target.dataset.open, target.dataset.screen ?? 'stream', focusOf(target.dataset.focus), target.dataset.confirm);
  } else if (target.dataset.ticket !== undefined) {
    openTicket(target.dataset.ticket);
  } else if (target.hasAttribute('data-back')) {
    back();
  } else if (target.dataset.goto !== undefined) {
    if (target.dataset.goto === 'changes') {
      openChanges(null, null);
    } else if (ui.job !== null) {
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
    // On a phone a chosen file folds the tree, so its diff is in view.
    if (row?.type === 'file' && media(NARROW_QUERY)) {
      ui.cx.tree = false;
      renderChanges();
      byId('dbody').focus();
    }
  } else if (target.dataset.fold !== undefined) {
    ui.cx.unfolded.add(target.dataset.fold);
    const body = byId('dbody');
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
    // "<id>:<decision>" (job-screens.js ledgerFinding): both parts are there.
    const [id = '', decision = ''] = target.dataset.settle.split(':');
    settle(id, decision);
  } else if (target.hasAttribute('data-copy-branch')) {
    const job = shownJob();
    if (job !== null) {
      copyValue(`git checkout ${job.branch}`, byIdAs('checkout-text', 'textarea'), (text) => toast({ level: 'info', text: `${text} git checkout ${job.branch}` }));
    }
  } else if (target.matches('#stream li.e')) {
    ui.sel = entries().indexOf(target);
    markSel(false);
  }
}

// A card's data-focus (board.js): where its button points on the job page; a value other than
// 'composer' is the stop block's, as applyWantedFocus reads it.
const focusOf = (value: string | undefined): 'composer' | 'stop' | undefined => (value === undefined ? undefined : value === 'composer' ? 'composer' : 'stop');

// The Merge request screen's fields and the draft's field each one types into.
const MR_INPUTS: ReadonlyMap<string, MrField> = new Map([['mrTitle', 'title'], ['mrBranch', 'branch'], ['mrBase', 'base'], ['mrBody', 'body']]);

// What typing in the job page keeps: the draft of the message box (and Send follows it), a note on
// a ledger entry.
function onInput(event: Event): void {
  const node = targetOf(event.target);
  const target = isField(node) ? node : null;
  if (target?.id === 'tkText' && ui.screen === 'ticket') {
    // The planned ticket page's editor: Unsaved changes and Save follow it (the page has its ticket).
    if (ui.ticket !== null) {
      const s = tkState(ui.ticket);
      s.text = target.value;
      const bar = byId('ticket').querySelector('.edtabs');
      bar?.replaceWith(tkTabs(ui.ticket, s));
    }
    return;
  }
  const mrField = target === null ? undefined : MR_INPUTS.get(target.id);
  if (target !== null && mrField !== undefined && ui.screen === 'mr' && state.key !== null) {
    // The Merge request screen: the draft, and the checks, the side panel and the bar after it.
    const m = mrState(state.key);
    m[mrField] = target.value;
    m.outcome = null;
    renderMrChecks();
    return;
  }
  if (target?.id === 'msg') {
    if (state.key !== null) {
      state.drafts.set(state.key, target.value);
    }
    renderComposer();
  } else if (typeof target?.dataset.note === 'string') {
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
function onChange(event: Event): void {
  const node = targetOf(event.target);
  const target = isField(node) ? node : null;
  // A rule of the factory pill's popover.
  if (isTag(target, 'input') && target.name === 'rule' && target.checked) {
    setRule(target.value);
    return;
  }
  if (target?.id === 'cxview') {
    ui.cx.view = target.value === 'all' ? 'all' : Number(target.value);
    renderChanges();
  } else if (isTag(target, 'input') && target.id === 'cxcollapse') {
    ui.cx.collapse = target.checked;
    renderDiffPane();
  }
}

// The delegated keys, after point mode's (pins.js pinKey): on a main view j and k move between its
// cards (the home's, or the board's unfolded columns'), Enter opens the focused one. On a
// job page: Escape closes an open confirmation, then goes back one level (a screen of the job to
// its Stream, the Stream to the main view back() shows, home.js); c, m and s switch the screens; on the Stream j and k select
// an entry, G the last, Enter toggles the selected one; Ctrl+Enter in the message box sends.
// Escape closes the toast first. Alt+Up and Alt+Down move a queued card with the run queue (the board). On
// Changes: / the filter (Arrow Down or Enter in it goes to the tree), the tree's keys
// (treeKey), F7 / Shift+F7 and n / p the next and previous file, Arrow Left and Right on the
// divider its width.
function onKey(event: KeyboardEvent): void {
  // Point mode's keys first (pins.js): Shift+P, and Escape while pointing.
  if (pinKey(event)) {
    return;
  }
  if (event.defaultPrevented) {
    return;
  }
  const target = targetOf(event.target);
  // Escape closes the factory pill's open popover first.
  if (event.key === 'Escape' && closeHealth(true)) {
    event.preventDefault();
    return;
  }
  // The hand-over panel's More menu: Escape closes it only (the page stays), the focus back
  // on More; Arrow Down and Up move between its items.
  if (state.handoverMenu && event.key === 'Escape') {
    event.preventDefault();
    setHandoverMenu(false);
    $('handover-panel')?.querySelector<HTMLElement>('[data-homenu]')?.focus();
    return;
  }
  if (state.handoverMenu && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && target !== null && target.closest('.ho-more') !== null) {
    event.preventDefault();
    handoverMenuKey(event);
    return;
  }
  if (target?.id === 'vdiv' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    dividerKey(event);
    return;
  }
  // The Merge request screen: Ctrl+S saves, in a field or not.
  if (ui.screen === 'mr' && (event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 's' || event.key === 'S')) {
    event.preventDefault();
    mrAction('save');
    return;
  }
  // The planned ticket page: Ctrl+S saves while editing.
  if (ui.screen === 'ticket' && (event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 's' || event.key === 'S') && ui.ticket !== null && TK[ui.ticket]?.tab === 'edit') {
    event.preventDefault();
    tkAction('save');
    return;
  }
  if (target !== null && target.closest('textarea, input, select') !== null) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && target.id === 'msg') {
      event.preventDefault();
      act('say');
    } else if (event.key === 'Escape' && ui.screen !== 'board' && ui.screen !== 'home') {
      target.blur();
    } else if (target.id === 'cxq' && (event.key === 'ArrowDown' || event.key === 'Enter')) {
      event.preventDefault();
      document.querySelector<HTMLElement>('#tlist .trow.sel')?.focus();
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
  if (event.key === 'Escape' && !byId('toast').hidden) {
    event.preventDefault();
    toast(null);
    return;
  }
  // The drawer and the ticket confirmation handle their own keys.
  if (state.drawer !== null || state.ticketConfirm !== null) {
    return;
  }
  // Alt+Up / Alt+Down move the focused queued card one place.
  if (ui.screen === 'board' && event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    const item = closestOf(document.activeElement, '#qlist .card[data-q]');
    const row = item ? ticketByKey(item.dataset.ticket ?? null) : null;
    if (row !== null && isQueued(row)) {
      event.preventDefault();
      moveQueued(keyOf(row), row.queue_position + (event.key === 'ArrowUp' ? -1 : 1));
    }
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  if ((ui.screen === 'board' || ui.screen === 'home') && event.key === 'Escape' && (state.openMenu !== null || ui.related !== null)) {
    // Escape closes a card's ⋯ menu (the focus back on its toggle), else clears the highlight.
    event.preventDefault();
    const menu = state.openMenu;
    if (menu !== null) {
      setCardMenu(null);
      cardOf(menu)?.querySelector<HTMLElement>('[data-menu]')?.focus();
    } else {
      relate(null);
    }
    return;
  }
  if (ui.screen === 'board' || ui.screen === 'home') {
    // The home's cards; on the board a folded column's cards are passed over. Escape on a main
    // view goes nowhere.
    const cards = [...document.querySelectorAll<HTMLElement>(ui.screen === 'home' ? '#home .card' : '#cols .col:not(.folded) .card')];
    const at = cards.findIndex((card) => card === document.activeElement);
    if (event.key === 'j' || event.key === 'k') {
      event.preventDefault();
      cards[Math.min(cards.length - 1, Math.max(0, at + (event.key === 'j' ? 1 : -1)))]?.focus();
    } else if (event.key === 'Enter' && document.activeElement?.classList?.contains('card')) {
      const card = targetOf(document.activeElement);
      if (card === null) {
        return;
      }
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
    } else if (skillTextShown()) {
      closeSkillText();
    } else if (ui.screen === 'changes' || ui.screen === 'mr') {
      if (ui.job !== null) {
        go(ui.job, 'stream');
      }
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
      const toggleOf = all[ui.sel]?.querySelector<HTMLElement>('[data-toggle]');
      if (toggleOf !== null && toggleOf !== undefined) {
        event.preventDefault();
        // The selector asks for its data-toggle.
        toggle(toggleOf.dataset.toggle ?? '');
      }
    }
  } else if (ui.screen === 'changes') {
    // A key that targets the filter or the rows of a tree folded on a phone opens it first;
    // Enter and Space on the fold itself toggle it as a button.
    if (event.key === '/') {
      event.preventDefault();
      if (!ui.cx.tree) {
        ui.cx.tree = true;
        renderChanges();
      }
      $('cxq')?.focus();
    } else if (event.key === 'n' || event.key === 'p') {
      event.preventDefault();
      fileStep(event.key === 'n' ? 1 : -1);
    } else if (target?.id !== 'cxtree' && !(target !== null && target.closest('#dbody') !== null && (event.key === 'ArrowUp' || event.key === 'ArrowDown'))) {
      if (!ui.cx.tree && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        ui.cx.tree = true;
        renderChanges();
      }
      treeKey(event);
    }
  }
}

// The buttons of a Queue card.
function queueAction(action: string, key: string): void {
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
  } else if ((action === 'up' || action === 'down') && isQueued(row)) {
    moveQueued(key, row.queue_position + (action === 'up' ? -1 : 1));
  }
}

// Retry review, Retry and Resume of a Your turn card: posted at once, once; Merged — archive armed first (armOrRun).
function cardRun(action: string, key: string): void {
  const job = jobByKey(key);
  if (job === null || availability(action, job) !== '' || (action === 'review' && !reviewFailed(job)) || (action === 'retry' && !retryOn(job))) {
    return;
  }
  armOrRun(action, key);
}
