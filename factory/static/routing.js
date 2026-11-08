// routing.js, the dashboard's fifth script (DASHBOARD_SCRIPTS in src/dashboard.ts): the view
// shown, the routing and the page's delegated click, input, change and key handlers. A classic
// script, loaded in order with defer, sharing the page's globals with the others.
'use strict';

// ---------- The job page and the routing (the prototype's go, back, openTicket, route, setHash) ----------

// The view shown: 'board', a job's 'stream', 'changes' or 'mr' (ui.job is its key "<ws>/<ticket>"),
// or a planned ticket's page 'ticket' (ui.ticket); ui.opener is the key of the card that opened
// it; pending: the hash names a job or ticket not loaded yet. On the Stream: sel, the selected
// entry (j, k, G), and open, the toggles open.
// related: the card whose dependencies and dependents the board shows (SF-084), or null. On
// Changes (SF-079), cx as the prototype's: the view ('all' or an iteration), the selected file, the
// tree's cursor and rows, the filter, the flat list, the closed folders, the diff layout ('side' or
// 'uni', kept in localStorage), Collapse unchanged, the folds opened, the path a path link
// opened, checked against its iteration's list once it is read, and whether the tree is open
// (SF-119: a phone folds it above the diff).
const ui = {
  screen: 'board', job: null, ticket: null, opener: null, pending: false, sel: -1, open: new Set(), related: null,
  cx: { view: 'all', sel: null, cursor: null, rows: [], q: '', flat: false, collapsed: new Set(), mode: 'side', collapse: true, unfolded: new Set(), check: null, tree: true },
};

// The URL hash of the view: #<ws>/<ticket> (the Stream), #<ws>/<ticket>/changes, /mr, /ticket;
// a new one is a new history entry, so Back and Forward move between them.
function setHash() {
  const h = ui.screen === 'board' ? '' : ui.screen === 'stats' ? 'stats' : ui.screen === 'digest' ? (dg.id === null ? 'digest' : `digest/${dg.id}`) : ui.screen === 'ticket' ? `${ui.ticket}/ticket` : ui.screen === 'stream' ? ui.job : `${ui.job}/${ui.screen}`;
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
    showMr();
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
    ui.cx = { ...ui.cx, view: screen === 'changes' ? ui.cx.view : 'all', sel: screen === 'changes' ? ui.cx.sel : null, q: '', collapsed: new Set(), unfolded: new Set(), cursor: null, check: screen === 'changes' ? ui.cx.check : null, tree: true };
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
  $('digest').hidden = true;
  leaveDigest();
  $('stats').hidden = true;
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
  $('digest').hidden = true;
  leaveDigest();
  $('stats').hidden = true;
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
  // The morning digest (SF-103): #digest, the newest, or #digest/<id>.
  const digest = /^digest(?:\/([0-9A-Za-z-]+))?$/.exec(decodeURIComponent(location.hash.slice(1)));
  if (digest !== null) {
    const id = digest[1] ?? null;
    if (ui.screen !== 'digest' || dg.id !== id) {
      openDigest(id);
    }
    return;
  }
  // The Stats page (SF-117).
  if (decodeURIComponent(location.hash.slice(1)) === 'stats') {
    if (ui.screen !== 'stats') {
      openStats();
    }
    return;
  }
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

// The elements whose tap does something of its own: their titles are not shown by a tap (SF-119).
const TIP_CONTROLS = 'button, a, input, select, textarea, summary, label, [role="tab"], [role="treeitem"], [role="menuitem"], .card';
// SF-119: on a phone or a device without hover a tap shows what a hover shows: the title of
// the element tapped when it is the only place of that detail (not a control, not inside a
// card, whose tap opens its page), or a dependency chip's (its state in words).
function tipOf(target) {
  if (!media(TOUCH_QUERY) || typeof target?.closest !== 'function') {
    return '';
  }
  const holder = target.closest('[title]');
  if (holder === null || (!holder.classList.contains('dchip') && holder.closest(TIP_CONTROLS) !== null)) {
    return '';
  }
  return holder.getAttribute('title') ?? '';
}

// The delegated click listener of the top bar, the board, the cards, the job page (its header, the
// Stream and the composer), the planned ticket page (SF-081) and the toast (the drawer keeps its own
// listeners).
function onClick(event) {
  const tip = tipOf(event.target);
  if (tip !== '') {
    toast({ level: 'info', text: tip });
  }
  const target = typeof event.target?.closest === 'function'
    ? event.target.closest('[data-colfold],[data-cxtree],[data-tk],[data-tkimg],[data-tktab],[data-dep],[data-menu],[data-qact],[data-qtoggle],[data-qforce],#limUp,#limDown,#rulesBtn,[data-run],[data-open],[data-ticket],[data-back],[data-ws],[data-goto],[data-cfile],[data-changes],[data-fstep],[data-trow],[data-fold],[data-mode],[data-flat],[data-toggle],[data-act],[data-homenu],[data-dismiss],[data-settle],[data-copy-branch],[data-mr],[data-mrtab],[data-mrdiff],#stream li.e,#done-all,#toast-close,#open-workspaces,#open-new-ticket,#open-archived,#open-digest,#open-stats')
    : null;
  // An open ⋯ menu closes on any click but its own toggle (its items act, then it is closed).
  if (state.openMenu !== null && (target === null || target.dataset.menu === undefined)) {
    setCardMenu(null);
  }
  // The Rules menu (SF-072) closes on a click outside it.
  if (typeof event.target?.closest === 'function' && event.target.closest('.menuwrap') === null && !$('rulesMenu').hidden) {
    closeRules();
  }
  if (target?.id === 'rulesBtn') {
    toggleRules();
    return;
  }
  // The hand-over panel's More menu (SF-107) closes on a choice and on a click outside it.
  if (state.handoverMenu && typeof event.target?.closest === 'function' && event.target.closest('[data-homenu]') === null
    && (event.target.closest('.ho-menu') === null || event.target.closest('[role="menuitem"]') !== null)) {
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
  if (target === null || target.disabled || (typeof event.target.closest === 'function' && event.target.closest('a') !== null)) {
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
  // The Merge request screen (SF-080): its bar, Edit | Preview, and the diff against the factory's text.
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
  } else if (target.id === 'open-digest') {
    openDigest(null);
  } else if (target.id === 'open-stats') {
    openStats();
  } else if (target.hasAttribute('data-ws')) {
    // A workspace's chip again: back to all.
    state.filter = state.filter === target.dataset.ws ? '' : target.dataset.ws;
    renderBoard();
  } else if (target.dataset.qact !== undefined) {
    queueAction(target.dataset.qact, target.dataset.key);
  } else if (target.dataset.qtoggle !== undefined) {
    queueToggle(target.dataset.qtoggle);
  } else if (target.dataset.qforce !== undefined) {
    queueForce(target.dataset.qforce);
  } else if (target.id === 'limUp' || target.id === 'limDown') {
    setLimit(target.id === 'limUp' ? 1 : -1);
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
    // SF-119: on a phone a chosen file folds the tree, so its diff is in view.
    if (row?.type === 'file' && media(NARROW_QUERY)) {
      ui.cx.tree = false;
      renderChanges();
      $('dbody').focus();
    }
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
  if (['mrTitle', 'mrBranch', 'mrBase', 'mrBody'].includes(target?.id) && ui.screen === 'mr' && state.key !== null) {
    // The Merge request screen (SF-080): the draft, and the checks, the side panel and the bar after it.
    const m = mrState(state.key);
    m[{ mrTitle: 'title', mrBranch: 'branch', mrBase: 'base', mrBody: 'body' }[target.id]] = target.value;
    m.outcome = null;
    renderMrChecks();
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
  // A rule of the Rules menu (SF-072).
  if (target?.name === 'rule' && target.checked) {
    setRule(target.value);
    return;
  }
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
  // Escape closes the open Rules menu first (SF-072).
  if (event.key === 'Escape' && !$('rulesMenu').hidden) {
    event.preventDefault();
    closeRules();
    $('rulesBtn').focus();
    return;
  }
  // The hand-over panel's More menu (SF-107): Escape closes it only (the page stays), the focus back
  // on More; Arrow Down and Up move between its items.
  if (state.handoverMenu && event.key === 'Escape') {
    event.preventDefault();
    setHandoverMenu(false);
    $('handover-panel')?.querySelector('[data-homenu]')?.focus();
    return;
  }
  if (state.handoverMenu && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && typeof target?.closest === 'function' && target.closest('.ho-more') !== null) {
    event.preventDefault();
    handoverMenuKey(event);
    return;
  }
  if (target?.id === 'vdiv' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    dividerKey(event);
    return;
  }
  // The Merge request screen (SF-080): Ctrl+S saves, in a field or not.
  if (ui.screen === 'mr' && (event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 's' || event.key === 'S')) {
    event.preventDefault();
    mrAction('save');
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
  if (state.drawer !== null || state.ticketConfirm !== null) {
    return;
  }
  // SF-071: Alt+Up / Alt+Down move the focused queued card one place.
  if (ui.screen === 'board' && event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    const item = document.activeElement?.closest?.('#qlist .card[data-q]');
    const row = item ? ticketByKey(item.dataset.ticket) : null;
    if (row !== null && Number.isInteger(row.queue_position)) {
      event.preventDefault();
      moveQueued(keyOf(row), row.queue_position + (event.key === 'ArrowUp' ? -1 : 1));
    }
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey) {
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
    // A folded column's cards are passed over (SF-119).
    const cards = [...document.querySelectorAll('#cols .col:not(.folded) .card')];
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
    // SF-119: a key that targets the filter or the rows of a tree folded on a phone opens it first;
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
    } else if (target?.id !== 'cxtree' && !(typeof target?.closest === 'function' && target.closest('#dbody') !== null && (event.key === 'ArrowUp' || event.key === 'ArrowDown'))) {
      if (!ui.cx.tree && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        ui.cx.tree = true;
        renderChanges();
      }
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
  } else if ((action === 'up' || action === 'down') && Number.isInteger(row.queue_position)) {
    moveQueued(key, row.queue_position + (action === 'up' ? -1 : 1));
  }
}

// Retry review, Retry and Resume of a Your turn card: posted at once, once.
function cardRun(action, key) {
  const job = jobByKey(key);
  if (job === null || availability(action, job) !== '' || (action === 'review' && !reviewFailed(job)) || (action === 'retry' && !retryOn(job))) {
    return;
  }
  void run(action, key, {});
}
