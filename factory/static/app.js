// app.js, the dashboard's last script (DASHBOARD_SCRIPTS in src/dashboard.ts): the routing, the
// Markdown preview, the planned ticket page, the digest, the Stats page, the drawer, the setup, the
// stream and the page's start. A classic script, loaded in order with defer, sharing the page's
// globals with the others.
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
  images: (ticket) => `Screenshots for the plan: PNG, JPEG, WebP or GIF, at most 5 MB each and 10 per ticket. ChatGPT reads them with read_attachment; the Task file refers to one as ![what it shows](${ticket}/<name>).`,
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
    state.tk = { key, data: null, check: null, error: null, load: null, textarea: null, copied: null, imageStatus: null, uploading: 0 };
  }
  ui.screen = 'ticket';
  ui.ticket = key;
  ui.job = null;
  ui.opener = key;
  ui.pending = false;
  $('job').hidden = true;
  $('board').hidden = true;
  $('digest').hidden = true;
  leaveDigest();
  $('stats').hidden = true;
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
  // A Task that needs no check (SF-130): the board's summary says so, with checkNeed's reason.
  if (row.check?.state === 'not_needed') {
    return `Plan check not needed: ${row.check.check_reason ?? ''}`;
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

// The plan-check rounds of the ticket, every version (SF-130): "N rounds · $X" ("at least $X" when a
// cost is unknown), or "no rounds yet".
function tkRounds() {
  const data = state.tk.data;
  const rounds = typeof data?.check_rounds === 'number' ? data.check_rounds : 0;
  if (rounds === 0) {
    return el('div', 'muted fs12 tk-rounds', 'no rounds yet');
  }
  return el('div', 'muted fs12 tk-rounds', roundsText(rounds, data.check_usd, data.check_usd_complete !== false, money));
}

// Plan-check rounds and their cost in words (SF-130): "N rounds · $X", "at least $X" when a cost
// is unknown; format: the page's money or the Stats page's.
const roundsText = (rounds, usd, complete, format) => `${counted(rounds, 'round')} · ${complete ? format(usd) : `at least ${format(usd)}`}`;

// The Plan check card: the result in words, the findings with their kind in words, what the checker
// understood (clamped) and the files it expects to change; the date, model and cost; the rounds and
// their cost (SF-130). A Task that needs no check (SF-130) says why instead of a result.
function tkCheckCard(key, row, view, s) {
  const record = view.check;
  const output = record?.output ?? null;
  const failed = record !== null && (output === null || record.status === 'failed');
  const notNeeded = row.check?.state === 'not_needed';
  const h3 = el('h3', '', 'Plan check ');
  if (notNeeded) {
    h3.append(el('span', 'tag', 'not needed'));
  } else if (record === null) {
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
  if (notNeeded) {
    if (!checking) {
      content.push(el('p', 'fs13', `Not needed: ${row.check.check_reason ?? ''}. It starts from the queue without a check; Check the plan runs one anyway.`));
    }
    content.push(tkRounds());
    return tkCard(h3, TK_HELP.check, ...content);
  }
  if (record === null) {
    if (!checking) {
      content.push(el('p', 'fs13', row.draft ? 'Not checked yet. The plan is checked once the Context owner has written it.' : 'Not checked yet.'));
    }
    content.push(tkRounds());
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
  content.push(el('span', 'muted fs12', `${day(record.ended_at)} · ${record.model ?? 'default model'} · ${money(record.cost_usd)}`), tkRounds());
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
    side.append(tkConversation(row), tkImagesCard(key, row), tkHistoryCard());
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

// ---------- A ticket's images (SF-064): the planned ticket page's Images card and New ticket ----------

// The server's rules (src/attachments.ts), checked here too so the page says at once why an image
// is not taken; the server checks every upload again.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 10;

// The extension of an image from its first bytes (PNG, JPEG, WebP, GIF), as the server tells it;
// null for anything else.
function sniffImage(bytes) {
  const at = (offset, values) => values.every((value, index) => bytes[offset + index] === value);
  const word = (offset, text) => at(offset, [...text].map((char) => char.charCodeAt(0)));
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'png';
  }
  if (at(0, [0xff, 0xd8, 0xff])) {
    return 'jpg';
  }
  if (word(0, 'GIF87a') || word(0, 'GIF89a')) {
    return 'gif';
  }
  return word(0, 'RIFF') && word(8, 'WEBP') ? 'webp' : null;
}

async function imageExtension(file) {
  return sniffImage(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
}

// The files of a paste (clipboardData) or a drop (dataTransfer), never its text: a text paste
// finds none and goes on as usual.
function eventFiles(data) {
  if (data === null || data === undefined) {
    return [];
  }
  const files = Array.from(data.files ?? []);
  if (files.length > 0) {
    return files;
  }
  return Array.from(data.items ?? []).filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file) => file !== null && file !== undefined);
}

// A paste into a text field that carries text too (cells copied from a spreadsheet or a word
// processor come with a picture of them) stays a text paste; a screenshot has no text.
function pastesText(event) {
  const tag = event.target?.tagName;
  return (tag === 'TEXTAREA' || tag === 'INPUT') && Array.from(event.clipboardData?.types ?? []).includes('text/plain');
}

// Whether a drag carries files.
const dragsFiles = (data) => Array.from(data?.types ?? []).includes('Files');
const fileLabel = (file) => (typeof file.name === 'string' && file.name !== '' ? file.name : 'the image');
const refusalText = (error) => (error instanceof ActionError ? `${error.code}: ${error.message}` : `${error.message}; it may have been attached`);
const attachmentPath = (key, name) => `api/tickets/${jobPath(key)}/attachments/${encodeURIComponent(name)}`;

// Images: the ticket's images from its row (the stream keeps it current), each opening whole in a
// new tab, with Copy image and ×, then the drop area; a paste anywhere on the page lands there too.
// No file picker (the user's decision).
function tkImagesCard(key, row) {
  const images = Array.isArray(row.attachments) ? row.attachments : [];
  const content = [];
  if (images.length > 0) {
    const thumbs = el('div', 'thumbs');
    for (const image of images) {
      const url = attachmentPath(key, image.name);
      const link = el('a', 'thumb-open');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('title', `Open ${image.name} in a new tab`);
      const img = el('img');
      img.src = url;
      img.alt = `Image ${image.name}`;
      link.append(img);
      const busy = state.setupPending.has(`image:${key}/${image.name}`);
      const copy = button('btn small', 'Copy image', { tkimg: 'copy', name: image.name });
      const remove = button('btn small', '×', { tkimg: 'remove', name: image.name });
      remove.setAttribute('aria-label', `Remove ${image.name}`);
      remove.setAttribute('title', `Remove ${image.name}`);
      remove.disabled = busy;
      const bar = el('div', 'thumb-bar');
      bar.append(el('span', 'mono fs12', image.name), copy, remove);
      const item = el('figure', 'thumb');
      item.append(link, bar);
      thumbs.append(item);
    }
    content.push(thumbs);
  } else {
    content.push(el('span', 'muted fs13', 'No image yet.'));
  }
  const uploading = state.tk.uploading;
  const drop = el('div', 'drop', uploading > 0 ? `Attaching ${counted(uploading, 'image')}…` : 'Paste an image here (Ctrl+V) or drop one.');
  drop.id = 'tkDrop';
  const status = el('span', 'muted fs12', state.tk.imageStatus ?? '');
  status.setAttribute('role', 'status');
  content.push(drop, status);
  return tkCard('Images', TK_HELP.images(row.ticket), ...content);
}

function tkImageAction(action, name) {
  const key = ui.ticket;
  if (ui.screen !== 'ticket' || typeof name !== 'string') {
    return;
  }
  if (action === 'remove') {
    void tkRemoveImage(key, name);
  } else if (action === 'copy') {
    void tkCopyImage(key, name);
  }
}

// Each image goes up at once, in order and without a name: the server tells its type and numbers
// it. The outcome is a toast; the new images reach the card through the stream.
let tkUploads = Promise.resolve();
function tkAddImages(key, files) {
  if (files.length === 0) {
    return tkUploads;
  }
  state.tk.uploading += files.length;
  renderTicket();
  tkUploads = tkUploads.then(() => tkUpload(key, files)).catch((error) => console.error(error));
  return tkUploads;
}

async function tkUpload(key, files) {
  const done = [];
  const failed = [];
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      failed.push(`${fileLabel(file)} (larger than 5 MB)`);
    } else {
      try {
        const result = await postBytes(`api/tickets/${jobPath(key)}/attachments`, file);
        done.push(typeof result?.name === 'string' ? result.name : fileLabel(file));
      } catch (error) {
        failed.push(`${fileLabel(file)} (${refusalText(error)})`);
      }
    }
    if (state.tk.key === key) {
      state.tk.uploading = Math.max(0, state.tk.uploading - 1);
    }
  }
  const attached = done.length > 0 ? `Attached ${done.join(', ')}.` : '';
  toast(failed.length === 0 ? { level: 'ok', text: attached } : { level: 'error', text: `${attached}${attached !== '' ? ' ' : ''}Not attached: ${failed.join('; ')}.` });
  renderTicket();
}

async function tkRemoveImage(key, name) {
  const id = `image:${key}/${name}`;
  if (state.setupPending.has(id)) {
    return;
  }
  state.setupPending.add(id);
  renderTicket();
  let outcome;
  try {
    await post(`${attachmentPath(key, name)}/remove`, {});
    outcome = { level: 'ok', text: `Removed ${name}.` };
  } catch (error) {
    outcome = { level: 'error', text: error instanceof ActionError ? `${error.code}: ${error.message}` : `The removal failed (${error.message}); it may have happened.` };
  }
  state.setupPending.delete(id);
  toast(outcome);
  renderTicket();
}

// JPEG, WebP and GIF go on the clipboard as PNG, the image type browsers take there: drawn on a
// canvas.
async function asPng(blob) {
  if (blob.type === 'image/png') {
    return blob;
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('the image could not be drawn'))), 'image/png'));
}

// Copy image: the image on the clipboard as PNG, so it can be pasted into ChatGPT by hand. The
// ClipboardItem gets the PNG as a promise, so the copy stays within the click.
async function tkCopyImage(key, name) {
  const say = (text) => {
    state.tk.imageStatus = text;
    if (ui.screen === 'ticket' && ui.ticket === key) {
      renderTicket();
    }
  };
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.write !== 'function' || typeof ClipboardItem !== 'function') {
    say(`This browser cannot put an image on the clipboard: open ${name} and copy it there.`);
    return;
  }
  const png = (async () => {
    const response = await fetch(attachmentPath(key, name), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return asPng(await response.blob());
  })();
  png.catch(() => undefined);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    say(`Copied ${name}.`);
  } catch (error) {
    say(`${name} was not copied (${error.message}): open it and copy it there.`);
  }
}

// The page's paste and drop: only files are taken (a text paste into the editor goes on as
// usual); New ticket's form, in the drawer, has its own.
function onPagePaste(event) {
  if (ui.screen !== 'ticket' || state.drawer !== null || event.defaultPrevented || state.tk.data === null || pastesText(event)) {
    return;
  }
  const files = eventFiles(event.clipboardData);
  if (files.length > 0) {
    event.preventDefault();
    void tkAddImages(ui.ticket, files);
  }
}

const dropArea = (event) => (ui.screen === 'ticket' && typeof event.target?.closest === 'function' ? event.target.closest('#tkDrop') : null);

function onPageDrag(event) {
  const drop = dropArea(event);
  if (drop !== null && dragsFiles(event.dataTransfer)) {
    event.preventDefault();
    drop.classList.toggle('over', event.type === 'dragover');
  }
}

function onPageDrop(event) {
  const drop = dropArea(event);
  if (drop !== null) {
    event.preventDefault();
    drop.classList.remove('over');
    void tkAddImages(ui.ticket, eventFiles(event.dataTransfer));
  }
}

// New ticket's images: pasted anywhere in the form or dropped on it, shown from blob: URLs and
// named 1.png, 2.png, … in paste order with the extension of their real type; uploaded once the
// ticket is created (submitTicket).
const newImageName = (index) => `${index + 1}.${state.newImages[index].ext}`;
let newImagesQueue = Promise.resolve();
// The pastes and drops still being read, and what they refused since none was (Create waits for
// them: Fix 3).
let newImagesReading = 0;
let newImagesRefused = [];

function addNewImages(files) {
  if (newImagesReading === 0) {
    newImagesRefused = [];
  }
  newImagesReading += 1;
  newImagesQueue = newImagesQueue.then(async () => {
    const refused = [];
    for (const file of files) {
      if (state.newImages.length >= MAX_IMAGES) {
        refused.push(`${fileLabel(file)} (at most ${MAX_IMAGES} images per ticket)`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        refused.push(`${fileLabel(file)} (larger than 5 MB)`);
        continue;
      }
      const ext = await imageExtension(file).catch(() => null);
      if (ext === null) {
        refused.push(`${fileLabel(file)} (not a PNG, JPEG, WebP or GIF image)`);
        continue;
      }
      state.newImages.push({ file, ext, url: URL.createObjectURL(file) });
    }
    renderNewImages();
    newImagesRefused.push(...refused);
    setSetupStatus('ticket-status', refused.length > 0 ? { level: 'error', text: `Not added: ${refused.join('; ')}.` } : null);
  }).catch((error) => console.error(error)).finally(() => {
    newImagesReading -= 1;
  });
  return newImagesQueue;
}

// Create waits for the images still being read, so each one pasted before it goes up with this
// ticket. True when one was refused meanwhile: the form says which, and Create is not sent (a second
// Create goes on without it).
async function newImagesSettled() {
  if (newImagesReading === 0) {
    return false;
  }
  state.setupPending.add('ticket-images');
  setSetupStatus('ticket-status', { level: 'pending', text: 'Reading the pasted images…' });
  renderSetup();
  while (newImagesReading > 0) {
    await newImagesQueue;
  }
  state.setupPending.delete('ticket-images');
  renderSetup();
  if (newImagesRefused.length > 0) {
    setSetupStatus('ticket-status', { level: 'error', text: `Not added: ${newImagesRefused.join('; ')}.` });
    newImagesRefused = [];
    return true;
  }
  setSetupStatus('ticket-status', null);
  return false;
}

function removeNewImage(index) {
  const [image] = state.newImages.splice(index, 1);
  if (image !== undefined) {
    URL.revokeObjectURL(image.url);
  }
  renderNewImages();
}

function renderNewImages() {
  const list = $('ticket-images');
  list.replaceChildren(...state.newImages.map((image, index) => {
    const name = newImageName(index);
    const img = el('img');
    img.src = image.url;
    img.alt = `Pasted image ${name}`;
    const remove = button('btn small', '×', { newimg: String(index) });
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.setAttribute('title', `Remove ${name}`);
    remove.disabled = newImagesSending.has(image);
    const bar = el('div', 'thumb-bar');
    bar.append(el('span', 'mono fs12', name), remove);
    const item = el('figure', 'thumb');
    item.append(img, bar);
    return item;
  }));
  list.hidden = state.newImages.length === 0;
}

function onFormPaste(event) {
  if (pastesText(event)) {
    return;
  }
  const files = eventFiles(event.clipboardData);
  if (files.length > 0) {
    event.preventDefault();
    void addNewImages(files);
  }
}

function onFormDrag(event) {
  if (dragsFiles(event.dataTransfer)) {
    event.preventDefault();
    $('ticket-drop').classList.toggle('over', event.type === 'dragover');
  }
}

function onFormDrop(event) {
  if (dragsFiles(event.dataTransfer) || eventFiles(event.dataTransfer).length > 0) {
    event.preventDefault();
    $('ticket-drop').classList.remove('over');
    void addNewImages(eventFiles(event.dataTransfer));
  }
}

// After "Create the ticket": each image in order under the name it showed. A failed upload leaves
// the ticket created; what failed and why is returned for the form to say.
// The images Create was pressed with (Fix 4), each with the name it showed then; the form keeps
// them in place, × off, until they are uploaded or the create is refused.
let newImagesSending = new Set();

function snapshotNewImages() {
  const images = state.newImages.map((image, index) => ({ image, name: newImageName(index), file: image.file }));
  newImagesSending = new Set(images.map((entry) => entry.image));
  renderNewImages();
  return images;
}

function releaseNewImages() {
  newImagesSending = new Set();
  renderNewImages();
}

// images: snapshotNewImages's list, taken before the ticket was created.
async function uploadNewImages(key, images) {
  const failed = [];
  for (const image of images) {
    try {
      await postBytes(`api/tickets/${jobPath(key)}/attachments?name=${encodeURIComponent(image.name)}`, image.file);
    } catch (error) {
      failed.push(`${image.name} (${refusalText(error)})`);
    }
  }
  return { count: images.length, failed, sent: images.map((entry) => entry.image) };
}

// ---------- The morning digest (SF-103) ----------

// The Digest page (#digest, #digest/<id>): the list as last read ({running, digests}, newest first),
// the digest shown (its id; null: the newest) and its record, a read's error, the tab ('repos' or
// 'daily'), the poll's timer while a run goes, the ids known when a run was seen starting (the new
// one opens when it appears), Generate now's request, the Copy outcome per app, and the read under way.
const DIGEST_POLL_MS = 10000;
const dg = { list: null, id: null, record: null, error: null, tab: 'repos', poll: null, known: null, starting: false, copied: new Map(), load: 0 };

function openDigest(id) {
  if (ui.job !== null) {
    leaveJob();
  }
  if (state.drawer !== null) {
    hideDrawer();
  }
  ui.screen = 'digest';
  ui.job = null;
  ui.ticket = null;
  ui.pending = false;
  dg.id = id;
  dg.error = null;
  if (id === null || dg.record?.id !== id) {
    dg.record = id === null && dg.list !== null && dg.record?.id === dg.list.digests[0]?.id ? dg.record : null;
  }
  $('board').hidden = true;
  $('job').hidden = true;
  $('ticket').hidden = true;
  $('stats').hidden = true;
  $('digest').hidden = false;
  renderDigest();
  setHash();
  $('digest').querySelector('[data-back]')?.focus();
  void loadDigests();
}

// The page closes: no more polling.
function leaveDigest() {
  clearTimeout(dg.poll);
  dg.poll = null;
}

async function getJson(path) {
  return JSON.parse(await getText(path));
}

// Reads the list, then the digest shown; while a run goes, again every 10 s, and a digest that
// appears meanwhile opens.
async function loadDigests() {
  dg.load += 1;
  const load = dg.load;
  clearTimeout(dg.poll);
  dg.poll = null;
  let list;
  try {
    list = await getJson('api/digests');
  } catch (error) {
    if (load === dg.load && ui.screen === 'digest') {
      dg.error = `The digests could not be read (${error.message}).`;
      renderDigest();
    }
    return;
  }
  if (load !== dg.load || ui.screen !== 'digest') {
    return;
  }
  dg.list = list;
  dg.error = null;
  if (list.running && dg.known === null) {
    dg.known = new Set(list.digests.map((digest) => digest.id));
  }
  if (dg.known !== null) {
    const fresh = list.digests.find((digest) => !dg.known.has(digest.id));
    if (fresh !== undefined) {
      dg.known = null;
      dg.id = fresh.id;
      dg.record = null;
      setHash();
    } else if (!list.running) {
      dg.known = null;
    }
  }
  if (list.running) {
    dg.poll = setTimeout(() => void loadDigests(), DIGEST_POLL_MS);
  }
  const id = dg.id ?? list.digests[0]?.id ?? null;
  if (id !== null && dg.record?.id !== id) {
    renderDigest();
    try {
      const record = await getJson(`api/digests/${encodeURIComponent(id)}`);
      if (load === dg.load && ui.screen === 'digest') {
        dg.record = record;
      }
    } catch {
      if (load === dg.load && ui.screen === 'digest') {
        dg.record = null;
        dg.error = `The digest ${id} could not be read: it may be gone (digests are kept 60 days).`;
      }
    }
  }
  if (load === dg.load) {
    renderDigest();
  }
}

// Generate now: one manual run, never sent twice; the page polls until its digest appears.
async function generateNow() {
  if (dg.starting || dg.list?.running === true) {
    return;
  }
  dg.starting = true;
  dg.known = new Set((dg.list?.digests ?? []).map((digest) => digest.id));
  renderDigest();
  try {
    await post('api/digests/run', {});
    toast({ level: 'info', text: 'Generating the digest; this page opens it when it is ready.' });
  } catch (error) {
    if (error instanceof ActionError && error.code === 'digest_running') {
      toast({ level: 'info', text: 'A digest is being generated already; this page opens it when it is ready.' });
    } else {
      dg.known = null;
      toast({ level: 'error', text: error instanceof ActionError ? `${error.code}: ${error.message}` : `The request failed (${error.message}); it may have started. The page reads the list again.` });
    }
  }
  dg.starting = false;
  await loadDigests();
}

const dgTime = (ts) => localTime(ts).slice(0, 16);
const dgCost = (cost) => (typeof cost === 'number' ? `$${cost.toFixed(2)}` : 'cost unknown');

function renderDigest() {
  if (ui.screen !== 'digest') {
    return;
  }
  const page = $('digest');
  const list = dg.list;
  const record = dg.record;
  const running = list?.running === true || dg.starting;
  const backButton = button('btn back', '← Board ', { back: '' });
  backButton.append(el('span', 'kbd', 'Esc'));
  backButton.setAttribute('title', 'Back to the board (Esc)');
  const t1 = el('div', 't1');
  t1.append(el('span', 'title', 'Morning digest'));
  const tools = el('div', 'tools');
  if (list !== null && list.digests.length > 0) {
    const pick = el('select', 'dg-pick');
    pick.setAttribute('aria-label', 'Earlier digests');
    for (const digest of list.digests) {
      const option = el('option', '', `${dgTime(digest.ended_at)} · ${digest.trigger}`);
      option.value = digest.id;
      pick.append(option);
    }
    pick.value = record?.id ?? dg.id ?? list.digests[0].id;
    pick.addEventListener('change', () => openDigest(pick.value === list.digests[0].id ? null : pick.value));
    tools.append(pick);
  }
  const generate = el('button', 'btn primary', running ? 'Generating…' : 'Generate now');
  generate.type = 'button';
  generate.dataset.dg = 'generate';
  generate.disabled = running;
  generate.setAttribute('title', 'Make a digest now from the latest Git data; it does not replace the day\'s scheduled one');
  generate.addEventListener('click', () => void generateNow());
  tools.append(generate);
  const t2 = el('div', 't2');
  if (record !== null) {
    t2.append(el('span', 'dg-period', `since ${dgTime(record.period.from)} · generated ${dgTime(record.ended_at)}`), el('span', 'dg-cost', dgCost(record.cost_usd)));
  }
  const head = el('header', 'jhead');
  head.append(backButton, t1, tools, t2);
  const body = el('div', 'dg-body');
  if (running) {
    body.append(el('p', 'notline', 'Generating a digest… This page opens it when it is ready.'));
  }
  if (dg.error !== null) {
    body.append(el('p', 'err-text fs13', dg.error));
  }
  if (list === null) {
    body.append(el('p', 'muted fs13', dg.error === null ? 'Loading the digests…' : ''));
  } else if (list.digests.length === 0) {
    const empty = el('div', 'card2 dg-empty');
    empty.append(el('h3', '', 'No digest yet'), el('p', 'fs13', 'Generate now makes one from the followed workspaces. sf serve makes one every day at the time set in Workspaces → Morning digest, when a workspace is followed or has My daily on.'));
    body.append(empty);
  } else if (record === null) {
    body.append(el('p', 'muted fs13', dg.error === null ? 'Loading the digest…' : ''));
  } else {
    const tabs = el('div', 'edtabs dg-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const [tab, text] of [['repos', 'Repositories'], ['daily', 'My daily']]) {
      const node = el('button', dg.tab === tab ? 'on' : '', text);
      node.type = 'button';
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', String(dg.tab === tab));
      node.dataset.dgtab = tab;
      node.addEventListener('click', () => {
        dg.tab = tab;
        renderDigest();
      });
      tabs.append(node);
    }
    body.append(tabs);
    if (record.error !== null && record.error !== undefined) {
      body.append(el('p', 'notline bad', `The model call failed (${record.error}); the Git data is shown without its summary.`));
    }
    for (const note of record.notes ?? []) {
      body.append(el('p', 'notline', note));
    }
    body.append(...(dg.tab === 'daily' ? dgDaily(record) : dgRepos(record)));
  }
  const scroll = page.querySelector('.form2')?.scrollTop ?? 0;
  const wrap = el('div', 'form2');
  wrap.append(body);
  keepFocus(page, () => page.replaceChildren(head, wrap));
  wrap.scrollTop = scroll;
}

function dgList(items, className = 'dg-items') {
  if (items.length === 0) {
    return el('p', 'muted fs13', 'None.');
  }
  const list = el('ul', className);
  list.append(...items.map((item) => el('li', '', item)));
  return list;
}

function dgSection(title, ...content) {
  const section = el('section', 'dg-sec');
  section.append(el('h4', '', title), ...content);
  return section;
}

// The Repositories tab: "One ticket across the app", then a card per followed workspace.
function dgRepos(record) {
  const nodes = [];
  const cross = record.output?.cross_repo ?? [];
  if (cross.length > 0) {
    nodes.push(dgCross(cross, record));
  }
  const followed = record.workspaces.filter((workspace) => workspace.track);
  if (followed.length === 0) {
    const empty = el('div', 'card2 dg-empty');
    empty.append(el('p', 'fs13', 'No workspace is followed in this digest. Workspaces → Edit → "Morning digest: follow this repository".'));
    nodes.push(empty);
  }
  for (const workspace of followed) {
    nodes.push(dgRepoCard(workspace, record.output?.repos?.find((repo) => repo.name === workspace.name) ?? null, record));
  }
  return nodes;
}

function dgCross(rows, record) {
  const names = record.workspaces.map((workspace) => workspace.name).filter((name) => rows.some((row) => Object.hasOwn(row.by_workspace ?? {}, name)));
  const card = el('div', 'card2 dg-cross');
  card.append(el('h3', '', 'One ticket across the app'));
  const scroller = el('div', 'dg-scroll');
  const table = el('table', 'dgx');
  const headRow = el('tr');
  headRow.append(el('th', '', 'Ticket'), ...names.map((name) => el('th', '', name)), el('th', '', 'For me'));
  const thead = el('thead');
  thead.append(headRow);
  const tbody = el('tbody');
  for (const row of rows) {
    const line = el('tr');
    const ticket = el('td', 'mono');
    ticket.append(el('span', 'chipx', row.ticket));
    line.append(ticket, ...names.map((name) => el('td', '', row.by_workspace?.[name] ?? '—')), el('td', row.for_me ? 'dg-forme' : 'muted', row.for_me || '—'));
    tbody.append(line);
  }
  table.append(thead, tbody);
  scroller.append(table);
  card.append(scroller);
  return card;
}

function dgRepoCard(workspace, repo, record) {
  const card = el('article', 'card2 dg-repo');
  card.dataset.ws = workspace.name;
  const title = el('h3', 'dg-title');
  title.append(wsDot(workspace.name), el('span', 'dg-name', workspace.name));
  if (workspace.app !== workspace.name) {
    title.append(el('span', 'chipx', workspace.app));
  }
  card.append(title);
  if (workspace.fetch?.message) {
    card.append(el('p', 'notline', workspace.fetch.message));
  }
  for (const note of workspace.fetch?.notes ?? []) {
    card.append(el('p', 'notline', note));
  }
  if (workspace.error) {
    card.append(el('p', 'err-text fs13', workspace.error));
  }
  const git = workspace.git;
  if (git === null || git === undefined) {
    card.append(el('p', 'muted fs13', 'No Git data for this workspace in this digest.'));
    return card;
  }
  for (const note of git.notes ?? []) {
    card.append(el('p', 'notline', note));
  }
  if (repo?.headline) {
    card.append(el('p', 'dg-headline', repo.headline));
  }
  const impact = repo?.impact_on_me ?? [];
  if (impact.length > 0) {
    const box = el('div', 'dg-impact');
    box.append(el('h4', '', 'Effect on my work'), dgList(impact));
    card.append(box);
  }
  // Landed: the last 24 hours of the period shown, the earlier ones folded away.
  const recent = Date.parse(record.period.to) - 86400000;
  const entries = git.landed.map((entry) => dgLanded(entry, repo));
  const shown = entries.filter((_, index) => Date.parse(git.landed[index].date) >= recent);
  const earlier = entries.filter((_, index) => Date.parse(git.landed[index].date) < recent);
  const landed = [];
  if (git.landed.length === 0) {
    landed.push(el('p', 'muted fs13', 'Nothing landed in the period.'));
  }
  if (shown.length > 0) {
    const list = el('ul', 'dg-landed');
    list.append(...shown);
    landed.push(list);
  }
  if (earlier.length > 0) {
    const fold = el('details', 'dg-fold');
    const list = el('ul', 'dg-landed');
    list.append(...earlier);
    fold.append(el('summary', '', `Earlier in the period (${earlier.length})`), list);
    landed.push(fold);
  }
  card.append(dgSection(`Landed on ${git.main}`, ...landed));
  const branches = git.branches.filter((branch) => !branch.landed);
  card.append(dgSection('Live branches', ...(branches.length === 0 ? [el('p', 'muted fs13', 'No live branch.')] : [dgBranches(branches, repo)])));
  return card;
}

function dgLanded(entry, repo) {
  const item = el('li', entry.mine ? 'dg-entry mine' : 'dg-entry');
  const meta = el('div', 'dg-meta');
  meta.append(el('span', 'mono', dgTime(entry.date).slice(5)), el('span', 'dg-who', entry.author));
  if (entry.mine) {
    meta.append(el('span', 'tag', 'mine'));
  }
  const what = el('div', 'dg-what');
  if (entry.ticket) {
    what.append(el('span', 'chipx', entry.ticket));
  }
  const problem = repo?.merged?.find((merged) => merged.sha === entry.sha || entry.full_sha?.startsWith(merged.sha))?.problem;
  what.append(el('span', '', problem ?? entry.subject));
  item.append(meta, what);
  if (problem !== undefined) {
    item.append(el('div', 'muted fs12 dg-subject', entry.subject));
  }
  const where = el('div', 'muted fs12 dg-where');
  where.append(el('span', 'mono', entry.sha), el('span', '', entry.dirs.join(', ')), el('span', '', entry.stat));
  item.append(where);
  return item;
}

function dgBranches(branches, repo) {
  const list = el('ul', 'dg-branches');
  for (const branch of branches) {
    const item = el('li', branch.mine ? 'dg-entry mine' : 'dg-entry');
    const meta = el('div', 'dg-meta');
    meta.append(el('span', 'mono dg-ref', branch.name));
    if (branch.local) {
      meta.append(el('span', 'tag', 'local'));
    }
    if (branch.mine) {
      meta.append(el('span', 'tag', 'mine'));
    }
    meta.append(el('span', 'dg-who', branch.author));
    const counts = el('span', 'mono dg-counts');
    counts.append(el('span', 'plus', `+${branch.ahead}`), document.createTextNode('/'), el('span', branch.behind > 10 ? 'minus dg-behind' : 'minus', `−${branch.behind}`));
    if (branch.behind > 10) {
      counts.setAttribute('title', `${branch.behind} commits behind ${'the main branch'}: a rebase is due`);
    }
    meta.append(counts, el('span', 'muted', branch.age_days === 0 ? 'today' : `${branch.age_days} d`));
    if (branch.local_only > 0) {
      meta.append(el('span', 'muted', `${branch.local_only} local only`));
    }
    item.append(meta);
    const what = repo?.branches?.find((entry) => entry.ref === branch.name)?.what;
    item.append(el('div', 'dg-what', what ?? branch.subject));
    if (branch.mine && (branch.overlap ?? []).length > 0) {
      item.append(el('div', 'fs12 dg-overlap', `Shares with main: ${branch.overlap.join(', ')}`));
    }
    list.append(item);
  }
  return list;
}

// My daily: a card per app, its four sections, the commits it was made from and Copy.
function dgDaily(record) {
  const sources = record.daily_sources ?? [];
  const dailies = record.output?.dailies ?? sources.map((source) => ({ app: source.app, workspaces: source.workspaces, yesterday: [], problems: [], plan: [], next: [] }));
  if (dailies.length === 0) {
    const empty = el('div', 'card2 dg-empty');
    empty.append(el('p', 'fs13', 'No daily in this digest: no workspace has My daily on (Workspaces → Edit), or you have no commits or open branches there in the two days.'));
    return [empty];
  }
  return dailies.map((daily) => {
    const card = el('article', 'card2 dg-daily');
    card.dataset.app = daily.app;
    const title = el('h3', 'dg-title');
    title.append(el('span', 'dg-name', daily.app), ...daily.workspaces.map((name) => wsChip(name)));
    card.append(title);
    card.append(
      dgSection('Yesterday', dgList(daily.yesterday)), dgSection('Problems', dgList(daily.problems)),
      dgSection('Plan', dgList(daily.plan)), dgSection('Today', dgList(daily.next)),
    );
    const commits = sources.find((source) => source.app === daily.app)?.commits ?? [];
    const fold = el('details', 'dg-fold');
    const list = el('ul', 'dg-commits');
    list.append(...commits.map((commit) => {
      const item = el('li', 'fs12');
      item.append(el('span', 'mono', commit.sha), document.createTextNode(` ${commit.subject} `), el('span', 'muted', `${commit.workspace} · ${commit.ref} · ${dgTime(commit.date).slice(5)}`));
      return item;
    }));
    fold.append(el('summary', '', `The commits it was made from (${commits.length})`), list);
    card.append(fold);
    const row = el('div', 'dg-copyrow');
    const copy = el('button', 'btn small', 'Copy');
    copy.type = 'button';
    copy.dataset.dg = 'copy';
    copy.addEventListener('click', () => void copyDaily(daily));
    row.append(copy);
    const copied = dg.copied.get(daily.app);
    if (copied !== undefined) {
      row.append(el('span', copied.ok ? 'muted fs12' : 'err-text fs12', copied.text));
    }
    card.append(row);
    return card;
  });
}

// The daily as plain text: "Yesterday:", "Problems:", "Plan:", "Today:", each with "- " items.
function dailyText(daily) {
  const part = (title, items) => [`${title}:`, ...items.map((item) => `- ${item}`)];
  return [...part('Yesterday', daily.yesterday), ...part('Problems', daily.problems), ...part('Plan', daily.plan), ...part('Today', daily.next)].join('\n');
}

async function copyDaily(daily) {
  try {
    if (typeof navigator.clipboard?.writeText !== 'function') {
      throw new Error('the browser gives no clipboard here');
    }
    await navigator.clipboard.writeText(dailyText(daily));
    dg.copied.set(daily.app, { ok: true, text: 'Copied.' });
  } catch (error) {
    dg.copied.set(daily.app, { ok: false, text: `Copy failed: ${error.message}` });
  }
  renderDigest();
}

// ---------- The Stats page (SF-117) ----------

// The Stats page (#stats): the period (7, 30 or 90 days) and the workspace chosen (null: all), the
// payload as last read, a read's error, the read under way, and the charts shown as tables. In page
// memory only; read on open, on a change and on Refresh, never on a timer.
const st = { days: 30, workspace: null, data: null, error: null, load: 0, tables: new Set(), warningsAll: false };
const SVG_NS = 'http://www.w3.org/2000/svg';
const ST_ROLES = { implementer: 'Implementer', claude_review: 'Claude review', simplify: 'Simplification', codex_gate: 'Codex gate', task_check: 'Plan check', digest: 'Digest', explanation: 'Explanations' };
const ST_COST_ROLES = ['implementer', 'claude_review', 'simplify', 'task_check', 'digest', 'explanation'];
const ST_STAGES = { claude_review: 'Claude review', codex_gate: 'Codex gate', task_check: 'Plan check' };
const ST_SEVERITIES = [{ key: 'blocker', name: 'Blocker' }, { key: 'major', name: 'Major' }, { key: 'nit', name: 'Nit' }];
const ST_DAY_CHARTS = ['cost-day', 'tokens-day', 'started-day'];
// The warnings listed before "Show all N".
const ST_WARNINGS_SHOWN = 10;
// The rules of the warnings (src/stats.ts), one plain sentence each.
const ST_RULES = [
  'A job costs more than three times the median of the last 30 finished jobs of its workspace, and at least $5 (with at least 5 such jobs).',
  'A job uses more than three times the median Codex gate tokens of those jobs.',
  'A job takes more than three times the median iterations of those jobs, and at least 5.',
  'A job gives one line, which lists each of these measures it is unusual on.',
  'A finding of a job was reopened twice or more, or the job stopped with review churn or a disputed review.',
  'The job and review-churn warnings are only of the jobs updated in the last 7 days, whatever the period.',
  'The last 3 runs of a stage (Claude review, Codex gate, simplification, plan check, digest, explanation) all failed.',
  'A day costs more than twice the median of the days with a cost among the 30 days before (with at least 7 such days), and at least $5.',
];

// The formats: $1.23 ($100 on without decimals, — for none), 950 / 1.5k / 340k / 2.1M, 45s / 12m / 3.2h / 1.5d.
const stMoney = (value) => (typeof value !== 'number' ? '—' : value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`);
function stTokens(value) {
  if (value >= 999500) {
    return `${(value / 1e6).toFixed(1)}M`;
  }
  if (value >= 9950) {
    return `${Math.round(value / 1000)}k`;
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(value));
}
function stDuration(seconds) {
  if (typeof seconds !== 'number') {
    return '—';
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  return seconds < 86400 ? `${(seconds / 3600).toFixed(1)}h` : `${(seconds / 86400).toFixed(1)}d`;
}
const stCount = (value) => (typeof value !== 'number' ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(1));
const stPercent = (part, whole) => `${Math.round((part / whole) * 100)}%`;
function stTokenLine(tokens) {
  if (tokens === null || tokens === undefined) {
    return 'not recorded';
  }
  return 'cached_input' in tokens
    ? `${stTokens(tokens.input)} in (${stTokens(tokens.cached_input)} cached) · ${stTokens(tokens.output)} out`
    : `${stTokens(tokens.input)} in · ${stTokens(tokens.output)} out`;
}
const stFindings = (findings) => `${findings.blocker} / ${findings.major} / ${findings.nit}`;

function openStats() {
  if (ui.job !== null) {
    leaveJob();
  }
  if (state.drawer !== null) {
    hideDrawer();
  }
  ui.screen = 'stats';
  ui.job = null;
  ui.ticket = null;
  ui.pending = false;
  $('board').hidden = true;
  $('job').hidden = true;
  $('ticket').hidden = true;
  $('digest').hidden = true;
  leaveDigest();
  $('stats').hidden = false;
  renderStats();
  setHash();
  $('stats').querySelector('[data-back]')?.focus();
  void loadStats();
}

// One read of the payload; its answer is applied only when it is the last read and the page is shown.
async function loadStats() {
  st.load += 1;
  const load = st.load;
  const path = `api/stats?days=${st.days}${st.workspace === null ? '' : `&workspace=${encodeURIComponent(st.workspace)}`}`;
  try {
    const data = await getJson(path);
    if (load !== st.load || ui.screen !== 'stats') {
      return;
    }
    st.data = data;
    st.error = null;
  } catch (error) {
    if (load !== st.load || ui.screen !== 'stats') {
      return;
    }
    st.error = error.message;
  }
  renderStats();
}

// An SVG element: its attributes (class too) only through setAttribute.
function svgEl(tag, attributes = {}, text = undefined) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

// The top of a chart's axis: the smallest of 1, 2, 2.5, 5, 10 × a power of ten at or above max.
function stTop(max) {
  if (!(max > 0)) {
    return 1;
  }
  const power = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 2.5, 5, 10].map((step) => step * power).find((top) => top >= max) ?? 10 * power;
}

// The colour key above a stacked chart.
function stLegend(series) {
  const legend = el('div', 'st-legend');
  for (const one of series) {
    const item = el('span', 'st-key');
    item.append(el('span', `st-swatch st-c-${one.key}`), document.createTextNode(one.name));
    legend.append(item);
  }
  return legend;
}

function stScroll(table) {
  const wrap = el('div', 'st-scroll');
  wrap.append(table);
  return wrap;
}

// A table of rows of cells (a text or a node).
function stTable(head, rows) {
  const table = el('table', 'st-table');
  const thead = el('thead');
  const top = el('tr');
  for (const text of head) {
    top.append(el('th', '', text));
  }
  thead.append(top);
  const tbody = el('tbody');
  for (const cells of rows) {
    const row = el('tr');
    for (const cell of cells) {
      const td = el('td');
      td.append(cell);
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(thead, tbody);
  return stScroll(table);
}

// A chart's box, whatever the data: its title and its Table toggle, then the SVG, the same numbers
// as a table, or the muted line when every value is 0 (the toggle then shows the table of zeros).
function stChart(id, title, items, series, format, empty, draw) {
  const box = el('div', 'st-chart');
  box.dataset.chart = id;
  const head = el('div', 'st-chart-head');
  const tabled = st.tables.has(id);
  const toggle = button('btn small', tabled ? 'Chart' : 'Table', { st: `table-${id}` });
  toggle.setAttribute('aria-pressed', String(tabled));
  toggle.addEventListener('click', () => {
    if (st.tables.has(id)) {
      st.tables.delete(id);
    } else {
      st.tables.add(id);
    }
    renderStats();
  });
  head.append(el('h4', '', title), toggle);
  box.append(head);
  if (tabled) {
    const total = series.length > 1 ? ['Total'] : [];
    box.append(stTable([ST_DAY_CHARTS.includes(id) ? 'Day' : 'Name', ...series.map((one) => one.name), ...total], items.map((item) => {
      const values = series.map((one) => one.value(item));
      return [item.label, ...values.map(format), ...(total.length === 0 ? [] : [format(values.reduce((sum, value) => sum + value, 0))])];
    })));
  } else if (items.every((item) => series.every((one) => one.value(item) === 0))) {
    box.append(el('p', 'muted fs13 st-none', empty));
  } else {
    if (series.length > 1) {
      box.append(stLegend(series));
    }
    box.append(draw());
  }
  return box;
}

// Columns over the days: a y axis with gridlines at 0, ¼, ½, ¾ and the top, one column per day with
// its series stacked in order, at most 12 day labels.
function stColumns(id, title, rows, series, format, empty) {
  const items = rows.map((row) => ({ ...row, label: row.day }));
  return stChart(id, title, items, series, format, empty, () => {
    const svg = svgEl('svg', { viewBox: '0 0 720 220', width: '100%', role: 'img', 'aria-label': title, class: 'st-svg' });
    const left = 60;
    const right = 712;
    const top = 10;
    const bottom = 194;
    const max = stTop(Math.max(0, ...items.map((item) => series.reduce((sum, one) => sum + one.value(item), 0))));
    const y = (value) => bottom - (value / max) * (bottom - top);
    for (const part of [0, 0.25, 0.5, 0.75, 1]) {
      svg.append(svgEl('line', { x1: left, x2: right, y1: y(max * part), y2: y(max * part), class: 'st-grid' }));
      svg.append(svgEl('text', { x: left - 6, y: y(max * part) + 4, 'text-anchor': 'end', class: 'st-axis' }, format(max * part)));
    }
    const slot = (right - left) / Math.max(1, items.length);
    const width = Math.max(1, slot * 0.7);
    const every = Math.ceil(items.length / 12);
    items.forEach((item, index) => {
      const x = left + index * slot + (slot - width) / 2;
      let base = 0;
      for (const one of series) {
        const value = one.value(item);
        if (value > 0) {
          const rect = svgEl('rect', { x: x.toFixed(1), y: y(base + value).toFixed(1), width: width.toFixed(1), height: (y(base) - y(base + value)).toFixed(1), class: `st-c-${one.key}` });
          rect.append(svgEl('title', {}, `${item.label} · ${one.name}: ${format(value)}`));
          svg.append(rect);
          base += value;
        }
      }
      if (index % every === 0) {
        svg.append(svgEl('text', { x: (x + width / 2).toFixed(1), y: 212, 'text-anchor': 'middle', class: 'st-axis' }, item.label.slice(5)));
      }
    });
    return svg;
  });
}

// One horizontal bar per item: its label left, its series stacked, its value right; 28 high each.
function stBars(id, title, items, series, format, empty) {
  return stChart(id, title, items, series, format, empty, () => {
    const svg = svgEl('svg', { viewBox: `0 0 720 ${28 * Math.max(1, items.length)}`, width: '100%', role: 'img', 'aria-label': title, class: 'st-svg' });
    const left = 150;
    const span = 470;
    const max = Math.max(0, ...items.map((item) => series.reduce((sum, one) => sum + one.value(item), 0))) || 1;
    items.forEach((item, index) => {
      const y = index * 28;
      svg.append(svgEl('text', { x: 4, y: y + 18, class: 'st-axis st-label' }, item.label));
      let base = 0;
      for (const one of series) {
        const value = one.value(item);
        if (value > 0) {
          const rect = svgEl('rect', { x: (left + (base / max) * span).toFixed(1), y: y + 6, width: Math.max(1, (value / max) * span).toFixed(1), height: 16, class: `st-c-${one.key}` });
          rect.append(svgEl('title', {}, `${item.label} · ${one.name}: ${format(value)}`));
          svg.append(rect);
          base += value;
        }
      }
      svg.append(svgEl('text', { x: 716, y: y + 18, 'text-anchor': 'end', class: 'st-axis' }, format(base)));
    });
    return svg;
  });
}

function stSection(title, className = '') {
  const section = el('section', className === '' ? 'st-sec' : `st-sec ${className}`);
  section.append(el('h3', '', title));
  return section;
}

function stTile(label, value, sub = undefined) {
  const tile = el('div', 'st-tile');
  tile.append(el('div', 'st-tile-label', label), el('div', 'st-tile-value', value));
  if (sub !== undefined) {
    tile.append(el('div', 'st-tile-sub', sub));
  }
  return tile;
}

function stTiles(...tiles) {
  const grid = el('div', 'st-tiles');
  grid.append(...tiles);
  return grid;
}

// Where a warning or a case points: a job that is not archived, a planned ticket, a digest; null otherwise.
function stHref(target) {
  if (target === null || target === undefined) {
    return null;
  }
  if (target.kind === 'job') {
    return target.archived ? null : `#${jobPath(`${target.workspace}/${target.ticket}`)}`;
  }
  if (target.kind === 'ticket') {
    return `#${jobPath(`${target.workspace}/${target.ticket}`)}/ticket`;
  }
  return target.kind === 'digest' ? `#digest/${encodeURIComponent(target.id)}` : null;
}

// text as a link to the target, or "(archived)" (after the ticket's name) without one.
function stLink(target, text) {
  const href = stHref(target);
  if (href === null) {
    return el('span', 'muted', text === 'Open' ? '(archived)' : `${text} (archived)`);
  }
  const link = el('a', 'st-link', text);
  link.href = href;
  return link;
}

function stWarnings(data) {
  const section = stSection(`Warnings (${data.warnings.length})`, 'st-warnings');
  if (data.warnings.length === 0) {
    section.append(el('p', 'muted fs13', 'No warnings: nothing is far from the usual.'));
  } else {
    const list = el('ul', 'st-warn');
    const item = (warning) => {
      const row = el('li');
      row.append(el('span', 'st-warn-text', warning.text));
      if (warning.target !== null) {
        row.append(stLink(warning.target, 'Open'));
      }
      return row;
    };
    const shown = st.warningsAll ? data.warnings.length : ST_WARNINGS_SHOWN;
    list.append(...data.warnings.slice(0, shown).map(item));
    section.append(list);
    if (data.warnings.length > shown) {
      // The rest in place; the page remembers it until it is reloaded.
      const more = button('btn small', `Show all ${data.warnings.length}`, { st: 'warnings-all' });
      more.addEventListener('click', () => {
        st.warningsAll = true;
        list.append(...data.warnings.slice(shown).map(item));
        more.remove();
      });
      section.append(more);
    }
  }
  const how = el('details', 'st-how');
  how.append(el('summary', '', 'How warnings are found'));
  const rules = el('ul', 'fs13');
  for (const rule of ST_RULES) {
    rules.append(el('li', '', rule));
  }
  how.append(rules);
  section.append(how);
  return section;
}

function stOpinionCard(title, opinion, note = undefined) {
  const card = el('div', 'card2 st-opinion');
  card.append(el('h4', '', title));
  if (opinion.iterations === 0) {
    card.append(el('p', 'muted fs13', 'No iteration in this period had both reviews.'));
    return card;
  }
  card.append(el('p', 'st-big', `${opinion.caught} of ${opinion.iterations} iterations (${stPercent(opinion.caught, opinion.iterations)})`));
  card.append(el('p', 'fs13', `${opinion.fixed} of its ${opinion.findings} findings were fixed`));
  if (note !== undefined) {
    card.append(el('p', 'muted fs13', note));
  }
  if (opinion.cases.length > 0) {
    const list = el('ul', 'st-cases fs13');
    for (const one of opinion.cases) {
      const item = el('li');
      item.append(stLink({ kind: 'job', workspace: one.workspace, ticket: one.ticket, archived: one.archived }, one.ticket),
        el('span', 'muted', `iteration ${one.iteration} · ${one.findings} findings · ${one.fixed} fixed`));
      list.append(item);
    }
    card.append(list);
  }
  return card;
}

function stSecondOpinion(data) {
  const section = stSection('Does a second model pay?');
  const pair = el('div', 'st-pair');
  pair.append(
    stOpinionCard('Codex found a blocker or major after Claude passed', data.second_opinion.codex_after_claude),
    stOpinionCard('Claude found a new blocker or major right after a clean Codex gate', data.second_opinion.claude_after_codex,
      'The next iteration is usually MR preparation or your own request, so a finding here can be about new work.'),
  );
  section.append(pair);
  return section;
}

// The Claude review experiment (SF-132): one line per arm, on and off, of the jobs that recorded
// claude_review; the empty text when neither has a job.
const ST_ARMS = { on: 'On', off: 'Off' };
function stArms(data) {
  const section = stSection('Claude review on/off');
  if (data.arms.every((row) => row.jobs === 0)) {
    section.append(el('p', 'muted fs13', 'No jobs of the experiment yet.'));
    return section;
  }
  const cost = (value, complete) => (value === null ? '—' : complete ? stMoney(value) : `at least ${stMoney(value)}`);
  section.append(stTable(['Claude review', 'Jobs', 'Delivered', 'Aborted', 'Cost', 'Per delivered', 'Median iterations', 'Codex findings', 'Per job'], data.arms.map((row) => [
    ST_ARMS[row.arm] ?? row.arm, String(row.jobs), String(row.delivered), String(row.aborted), cost(row.cost_usd, row.cost_complete),
    cost(row.usd_per_delivered, row.cost_complete), stCount(row.median_iterations), String(row.codex_findings), stCount(row.codex_findings_per_job),
  ])), el('p', 'muted fs13', 'Jobs started before the experiment are in neither arm.'));
  return section;
}

function stStages(data) {
  const section = stSection('Review stages');
  const items = data.stages.map((row) => ({ ...row, label: ST_STAGES[row.stage] ?? row.stage }));
  const charts = el('div', 'st-charts');
  charts.append(stBars('findings', 'Findings per stage', items, ST_SEVERITIES.map((one) => ({ ...one, value: (row) => row.findings[one.key] })), String, 'No findings in this period.'));
  // Rounds per ticket (SF-130): the plan check's (runs + failed) / tickets; "—" for the other stages.
  section.append(charts, stTable(['Stage', 'Runs', 'Failed', 'Blocker', 'Major', 'Nit', 'Led to a fix', 'Cost', 'Tokens', 'Cost per run', 'Rounds per ticket'], items.map((row) => [
    row.label, String(row.runs), String(row.failed), String(row.findings.blocker), String(row.findings.major), String(row.findings.nit),
    row.stage === 'task_check' ? `${row.fixed} (Task revised)` : String(row.fixed), stMoney(row.cost_usd), stTokenLine(row.tokens),
    row.cost_usd === null || row.runs === 0 ? '—' : stMoney(row.cost_usd / row.runs),
    typeof row.tickets === 'number' && row.tickets > 0 ? ((row.runs + row.failed) / row.tickets).toFixed(1) : '—',
  ])));
  return section;
}

function stSpend(data) {
  const section = stSection('Spend');
  const codex = data.totals.codex_tokens;
  section.append(stTiles(
    stTile('Cost', stMoney(data.totals.cost_usd), 'Codex gate in tokens only'),
    stTile('Codex gate tokens', stTokens(codex.input + codex.output), `${stTokens(codex.input)} in (${stTokens(codex.cached_input)} cached) · ${stTokens(codex.output)} out`),
  ));
  const charts = el('div', 'st-charts');
  charts.append(
    stColumns('cost-day', 'Cost per day', data.days_rows, ST_COST_ROLES.map((key) => ({ key, name: ST_ROLES[key], value: (row) => row.cost[key] })), stMoney, 'No cost in this period.'),
    stColumns('tokens-day', 'Codex gate tokens per day', data.days_rows, [
      { key: 'codex_gate', name: 'Input', value: (row) => row.codex_tokens.input },
      { key: 'codex_out', name: 'Output', value: (row) => row.codex_tokens.output },
    ], stTokens, 'No Codex gate run in this period.'),
  );
  // The simplification's line also has its offers and the user's choices (SF-132).
  const offers = ({ offered, taken, skipped }) => ` · offered ${offered} · taken ${taken} · skipped ${skipped}`;
  section.append(charts, el('h4', 'st-sub', 'By role'), stTable(['Role', 'Cost', 'Tokens', 'Runs'], data.roles.map((row) => [
    ST_ROLES[row.role] ?? row.role, row.cost_usd === null ? 'tokens only' : row.complete ? stMoney(row.cost_usd) : `at least ${stMoney(row.cost_usd)}`,
    stTokenLine(row.tokens), row.role === 'simplify' ? `${row.runs}${offers(data.simplify)}` : String(row.runs),
  ])));
  const roles = ST_COST_ROLES.filter((key) => key !== 'digest');
  const items = data.by_workspace.map((row) => ({ ...row, label: row.workspace }));
  const byWorkspace = el('div', 'st-charts');
  byWorkspace.append(stBars('by-workspace', 'Cost by workspace', items, roles.map((key) => ({ key, name: ST_ROLES[key], value: (row) => row.cost[key] })), stMoney, 'No cost in this period.'));
  section.append(el('h4', 'st-sub', 'By workspace'), byWorkspace, stTable(['Workspace', ...roles.map((key) => ST_ROLES[key]), 'Total', 'Codex tokens', 'Jobs started', 'Median time to ready'], data.by_workspace.map((row) => [
    row.workspace, ...roles.map((key) => stMoney(row.cost[key])), stMoney(row.total_usd), stTokens(row.codex_tokens), String(row.jobs_started), stDuration(row.median_time_to_ready_s),
  ])));
  return section;
}

function stLoad(data) {
  const section = stSection('Load');
  const done = data.totals.jobs_finished;
  section.append(stTiles(
    stTile('Jobs started', String(data.totals.jobs_started)),
    stTile('Finished', String(done.total), `pushed ${done.pushed} · aborted ${done.aborted} · failed ${done.failed}`),
    stTile('Time to ready', stDuration(data.totals.median_time_to_ready_s), 'median'),
    stTile('Iterations', stCount(data.totals.median_iterations), 'median of pushed jobs'),
  ));
  const charts = el('div', 'st-charts');
  charts.append(stColumns('started-day', 'Jobs started per day', data.days_rows, [{ key: 'started', name: 'Jobs started', value: (row) => row.started }], stCount, 'No job started in this period.'));
  section.append(charts);
  return section;
}

// A job's plan checks (SF-130), all-time: "N rounds · $X" ("at least $X" when a cost is unknown),
// "—" without one.
function stPlanChecks(row) {
  if (typeof row.plan_checks !== 'number' || row.plan_checks === 0) {
    return '—';
  }
  return roundsText(row.plan_checks, row.plan_check_usd, row.plan_check_usd_complete !== false, stMoney);
}

function stJobs(data) {
  const section = stSection(`Jobs (${data.jobs.length})`);
  if (data.jobs.length === 0) {
    section.append(el('p', 'muted fs13', 'No job in this period.'));
    return section;
  }
  section.append(stTable(['Workspace', 'Ticket', 'Title', 'State', 'Started', 'Iterations', 'Cost', 'Plan', 'Codex tokens', 'Claude B/M/N', 'Codex B/M/N', 'Time to ready'], data.jobs.map((row) => [
    row.workspace, stLink({ kind: 'job', workspace: row.workspace, ticket: row.ticket, archived: row.archived }, row.ticket), row.title ?? '', row.state.replace(/_/g, ' '),
    localTime(row.created_at).slice(0, 16), String(row.iterations), row.cost_complete ? stMoney(row.cost_usd) : `at least ${stMoney(row.cost_usd)}`, stPlanChecks(row), stTokens(row.codex_tokens),
    stFindings(row.claude), stFindings(row.codex), stDuration(row.time_to_ready_s),
  ])));
  return section;
}

function stNotes(data) {
  const { notes } = data;
  const lines = [
    ...(notes.truncated > 0 ? [`Only the newest 1000 jobs are counted; ${notes.truncated} older ones are left out.`] : []),
    ...(notes.unreadable > 0 ? [`${notes.unreadable} files could not be read and are left out.`] : []),
    ...(notes.events_skipped > 0 ? [`${notes.events_skipped} event logs are too large to read; their tokens and time to ready are missing.`] : []),
    ...(notes.digest_excluded ? ['Digests have no workspace and are not counted here.'] : []),
  ];
  if (lines.length === 0) {
    return [];
  }
  const section = stSection('Notes', 'st-notes');
  for (const line of lines) {
    section.append(el('p', 'muted fs13', line));
  }
  return [section];
}

function renderStats() {
  if (ui.screen !== 'stats') {
    return;
  }
  const page = $('stats');
  const data = st.data;
  const backButton = button('btn back', '← Board ', { back: '', st: 'back' });
  backButton.append(el('span', 'kbd', 'Esc'));
  backButton.setAttribute('title', 'Back to the board (Esc)');
  const t1 = el('div', 't1');
  t1.append(el('span', 'title', 'Stats'));
  const period = el('span', 'seg2');
  period.setAttribute('role', 'group');
  period.setAttribute('aria-label', 'Period');
  for (const days of [7, 30, 90]) {
    const node = button(st.days === days ? 'on' : '', `${days} days`, { st: `days-${days}` });
    node.setAttribute('aria-pressed', String(st.days === days));
    node.addEventListener('click', () => {
      if (st.days !== days) {
        st.days = days;
        renderStats();
        void loadStats();
      }
    });
    period.append(node);
  }
  const pick = el('select', 'dg-pick');
  pick.setAttribute('aria-label', 'Workspace');
  pick.dataset.st = 'workspace';
  const names = [...new Set([...(data?.workspaces ?? []), ...(st.workspace === null ? [] : [st.workspace])])];
  for (const [value, text] of [['', 'All workspaces'], ...names.map((name) => [name, name])]) {
    const option = el('option', '', text);
    option.value = value;
    pick.append(option);
  }
  pick.value = st.workspace ?? '';
  pick.addEventListener('change', () => {
    st.workspace = pick.value === '' ? null : pick.value;
    renderStats();
    void loadStats();
  });
  const refresh = button('btn', 'Refresh', { st: 'refresh' });
  refresh.addEventListener('click', () => void loadStats());
  const tools = el('div', 'tools');
  tools.append(period, pick, refresh);
  const t2 = el('div', 't2');
  if (data !== null) {
    t2.append(el('span', '', `${data.period.from} to ${data.period.to} · as of ${localTime(data.generated_at).slice(11, 16)}`));
  }
  const head = el('header', 'jhead');
  head.append(backButton, t1, tools, t2);
  const body = el('div', 'st-body');
  if (st.error !== null) {
    const card = el('div', 'card2');
    const retry = button('btn', 'Retry', { st: 'retry' });
    retry.addEventListener('click', () => void loadStats());
    card.append(el('p', 'err-text fs13', `The stats could not be read (${st.error}).`), retry);
    body.append(card);
  } else if (data === null) {
    body.append(el('p', 'muted fs13', 'Loading the stats…'));
  } else if (data.workspaces.length === 0 && data.roles.every((row) => row.runs === 0)) {
    const card = el('div', 'card2');
    card.append(el('p', 'fs13', 'No jobs yet. The stats fill in once the factory has run a job.'));
    body.append(card);
  } else {
    const now = stSection('Now');
    now.append(stTiles(
      stTile('Running', String(data.now.running)), stTile('Waiting for you', String(data.now.waiting_for_you)),
      stTile('Paused', String(data.now.paused)), stTile('Queued', data.now.queued === null ? '—' : String(data.now.queued)),
    ));
    body.append(stWarnings(data), now, stSecondOpinion(data), stArms(data), stStages(data), stSpend(data), stLoad(data), stJobs(data), ...stNotes(data));
  }
  // The focus stays on the control it was on; the scroll where it was.
  const focused = page.contains(document.activeElement) ? document.activeElement?.dataset?.st : undefined;
  const scroll = page.querySelector('.form2')?.scrollTop ?? 0;
  const wrap = el('div', 'form2');
  wrap.append(body);
  page.replaceChildren(head, wrap);
  wrap.scrollTop = scroll;
  if (focused !== undefined) {
    [...page.querySelectorAll('[data-st]')].find((node) => node.dataset.st === focused)?.focus();
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
  if (state.wsEdit !== null && !rows.some((row) => row.name === state.wsEdit)) {
    state.wsEdit = null;
    state.wsEditForm = null;
  }
  $('workspace-list').replaceChildren(...rows.map((row) => {
    const item = el('li');
    if (state.wsEdit === row.name && state.wsEditForm !== null) {
      // The Edit form (SF-103), kept across redraws so what is typed stays.
      item.append(state.wsEditForm);
      return item;
    }
    const name = el('div', 'ws-name');
    name.append(wsDot(row.name), document.createTextNode(row.name));
    // Its app (SF-103), when it is not the workspace itself.
    if (typeof row.app === 'string' && row.app !== row.name) {
      name.append(el('span', 'chipx ws-app', row.app));
    }
    item.append(name);
    item.append(el('div', 'ws-path', row.path));
    if (row.problem) {
      item.append(el('div', 'ws-problem', row.problem));
    }
    if (typeof row.description === 'string' && row.description !== '') {
      item.append(el('div', 'ws-description', row.description));
    } else if (typeof row.derived_description === 'string' && row.derived_description !== '') {
      item.append(el('div', 'ws-description hint', `${row.derived_description} (from the repository)`));
    }
    // The workspace's own hand-over setting (SF-083), or SF_HANDOFF's.
    item.append(el('div', 'ws-handoff hint', row.handoff === 'checkout' || row.handoff === 'off' ? `Hand-over: ${row.handoff} (this workspace)` : 'Hand-over: as SF_HANDOFF'));
    const digest = row.digest ?? { track: false, my_work: false };
    item.append(el('div', 'ws-digest hint', `Morning digest: ${digest.track ? 'on' : 'off'} · My daily: ${digest.my_work ? 'on' : 'off'}`));
    const line = el('div', 'row');
    const edit = el('button', 'btn btn-sm', 'Edit');
    edit.type = 'button';
    edit.disabled = state.setupPending.has('workspace') || state.wsEdit !== null;
    edit.addEventListener('click', () => openWorkspaceEdit(row));
    const remove = el('button', 'btn btn-sm', 'Remove');
    remove.type = 'button';
    remove.disabled = state.setupPending.has('workspace') || row.liveJobs > 0;
    remove.addEventListener('click', () => void removeWorkspace(row.name));
    line.append(edit, remove, el('span', 'hint', row.liveJobs > 0 ? `${row.liveJobs} live job${row.liveJobs === 1 ? '' : 's'}: finish or abort them first.` : 'The registration only; nothing on disk changes.'));
    item.append(line);
    return item;
  }));
  // The existing apps, the App field's suggestions (SF-103).
  const apps = [...new Set(rows.map((row) => row.app).filter((app) => typeof app === 'string' && app !== ''))].sort();
  $('workspace-apps').replaceChildren(...apps.map((app) => {
    const option = el('option');
    option.value = app;
    return option;
  }));
  // Default's words: what SF_HANDOFF says now.
  const handoffDefault = handoffDefaultText();
  for (const select of [$('workspace-handoff'), state.wsEditForm?.querySelector('[data-wsf="handoff"]')]) {
    const first = select?.children?.[0];
    if (first !== undefined && first !== null) {
      first.textContent = handoffDefault;
    }
  }
  renderDigestSettings();
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
  $('ticket-create').disabled = rows.length === 0 || state.setupPending.has('ticket') || state.setupPending.has('ticket-images');
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

// "Default (now: yes, from SF_HANDOFF)": the hand-over field's first option (SF-103).
function handoffDefaultText() {
  const now = state.wsSettings.handoff_default;
  return now === 'checkout' || now === 'off' ? `Default (now: ${now === 'checkout' ? 'yes' : 'no'}, from SF_HANDOFF)` : 'Default (from SF_HANDOFF)';
}

// The colour the workspace sets itself, or 'auto': the row's colour when it is not the one its name
// picks (the sum of the name's UTF-16 code units mod the palette's size, src/registry.ts).
function ownColor(row) {
  let sum = 0;
  for (let index = 0; index < row.name.length; index += 1) {
    sum += row.name.charCodeAt(index);
  }
  return WS_COLORS.includes(row.color) && row.color !== WS_COLORS[sum % WS_COLORS.length] ? row.color : 'auto';
}

// A field of the Edit form: its label, the control and the help text under it, each on its own line.
function wsField(label, control, help) {
  const field = el('div', 'field');
  if (control.type === 'checkbox') {
    const choice = el('label', 'choice');
    choice.append(control, document.createTextNode(` ${label}`));
    field.append(choice);
  } else {
    const id = `wsf-${control.dataset.wsf}`;
    control.id = id;
    const text = el('label', '', label);
    text.setAttribute('for', id);
    field.append(text, control);
  }
  if (help !== '') {
    field.append(el('p', 'hint', help));
  }
  return field;
}

function wsSelect(key, options, value) {
  const select = el('select');
  select.dataset.wsf = key;
  for (const [optionValue, text] of options) {
    const option = el('option', '', text);
    option.value = optionValue;
    select.append(option);
  }
  select.value = value;
  return select;
}

// Edit (SF-103): the card becomes the form: the checkout's path, Description (its placeholder the
// repository's own description), App (the existing apps as suggestions), Hand-over, Colour and the
// two digest switches. Save posts every field; Cancel changes nothing. The name stays.
function openWorkspaceEdit(row) {
  const form = el('form', 'form ws-edit');
  form.dataset.ws = row.name;
  const title = el('div', 'ws-name');
  title.append(wsDot(row.name), document.createTextNode(`Edit ${row.name}`));
  const path = el('input');
  path.dataset.wsf = 'path';
  path.type = 'text';
  path.value = row.path;
  path.setAttribute('autocomplete', 'off');
  path.setAttribute('spellcheck', 'false');
  const description = el('textarea');
  description.dataset.wsf = 'description';
  description.rows = 2;
  description.value = row.description ?? '';
  description.placeholder = row.derived_description ?? '';
  const app = el('input');
  app.dataset.wsf = 'app';
  app.type = 'text';
  app.value = row.app === row.name ? '' : (row.app ?? '');
  app.placeholder = row.name;
  app.setAttribute('list', 'workspace-apps');
  app.setAttribute('autocomplete', 'off');
  const handoff = wsSelect('handoff', [['default', handoffDefaultText()], ['checkout', 'Yes'], ['off', 'No']], row.handoff ?? 'default');
  const color = wsSelect('color', [['auto', 'Automatic (from the name)'], ...WS_COLORS.map((name) => [name, name])], ownColor(row));
  const track = el('input');
  track.type = 'checkbox';
  track.dataset.wsf = 'track';
  track.checked = row.digest?.track === true;
  const mine = el('input');
  mine.type = 'checkbox';
  mine.dataset.wsf = 'my_work';
  mine.checked = row.digest?.my_work === true;
  const buttons = el('div', 'row');
  const save = el('button', 'btn btn-sm btn-primary', 'Save');
  save.type = 'submit';
  save.dataset.wsf = 'save';
  const cancel = el('button', 'btn btn-sm', 'Cancel');
  cancel.type = 'button';
  cancel.dataset.wsf = 'cancel';
  cancel.addEventListener('click', closeWorkspaceEdit);
  buttons.append(save, cancel);
  const status = el('div', 'status');
  status.dataset.wsf = 'status';
  status.setAttribute('role', 'status');
  form.append(
    title,
    wsField('Path of the local checkout', path, 'Changing it is refused while the workspace has a live job.'),
    wsField('Description', description, 'Optional. Empty: the repository\'s own description (shown greyed) is used.'),
    wsField('App', app, 'Workspaces with the same app share one daily. Empty: its own name.'),
    wsField('When a job is ready, hand it over to my checkout', handoff, ''),
    wsField('Colour of its cards on the board', color, ''),
    wsField('Morning digest: follow this repository', track, ''),
    wsField('My daily: my commits here go into the daily of its app', mine, ''),
    buttons, status,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitWorkspaceEdit(row.name);
  });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeWorkspaceEdit();
    }
  });
  state.wsEdit = row.name;
  state.wsEditForm = form;
  renderWorkspaces();
  path.focus();
}

function closeWorkspaceEdit() {
  state.wsEdit = null;
  state.wsEditForm = null;
  renderWorkspaces();
}

async function submitWorkspaceEdit(name) {
  const form = state.wsEditForm;
  if (form === null || state.wsEdit !== name) {
    return;
  }
  const field = (key) => form.querySelector(`[data-wsf="${key}"]`);
  const status = field('status');
  const path = field('path').value.trim();
  if (path === '') {
    status.className = 'status error';
    status.textContent = 'The path of the local checkout is needed.';
    return;
  }
  const body = {
    path, description: field('description').value, app: field('app').value, handoff: field('handoff').value, color: field('color').value,
    digest: { track: field('track').checked === true, my_work: field('my_work').checked === true },
  };
  if (state.setupPending.has('workspace')) {
    return;
  }
  state.setupPending.add('workspace');
  field('save').disabled = true;
  status.className = 'status pending';
  status.textContent = 'Saving…';
  let outcome = null;
  try {
    await post(`api/workspaces/${encodeURIComponent(name)}/edit`, body);
  } catch (error) {
    outcome = error instanceof ActionError ? `${error.code}: ${error.message}` : `The request failed (${error.message}); it may have taken effect. Reload the page to see the current state.`;
  }
  state.setupPending.delete('workspace');
  field('save').disabled = false;
  if (outcome === null) {
    closeWorkspaceEdit();
    setSetupStatus('workspace-status', { level: 'ok', text: `Saved ${name}.` });
    return;
  }
  status.className = 'status error';
  status.textContent = outcome;
  renderSetup();
}

// The Morning digest section (SF-103): the stored settings, unless values are typed and not saved.
function renderDigestSettings() {
  const settings = state.wsSettings.digest;
  if (settings === null || state.digestDirty || state.setupPending.has('digest')) {
    return;
  }
  $('digest-at').value = settings.at;
  $('digest-weekdays').checked = settings.weekdays_only === true;
  $('digest-language').value = settings.language;
}

async function submitDigestSettings() {
  const at = $('digest-at').value;
  const language = $('digest-language').value.trim();
  if (!/^\d\d:\d\d$/.test(at) || language === '') {
    setSetupStatus('digest-status', { level: 'error', text: 'A time (HH:MM) and a language are needed.' });
    return;
  }
  const result = await setupRequest('digest', 'api/digest-settings', { at, weekdays_only: $('digest-weekdays').checked === true, language }, 'digest-status', (data) =>
    ({ level: 'ok', text: `Saved: ${data.at}${data.weekdays_only ? ' on weekdays' : ' every day'}, in ${data.language}. sf serve uses it at its next check.` }));
  if (result !== undefined) {
    state.digestDirty = false;
  }
}

async function submitWorkspace() {
  const name = $('workspace-name').value.trim();
  const path = $('workspace-path').value.trim();
  // The workspace's own hand-over setting (SF-083); empty: SF_HANDOFF applies. Its colour on the
  // board (SF-084); empty: the server picks one by its name. Its description, app and digest
  // switches (SF-103); empty or off: none, its name, off.
  const handoff = $('workspace-handoff').value;
  const color = $('workspace-color').value;
  const description = $('workspace-description').value.trim();
  const app = $('workspace-app').value.trim();
  const track = $('workspace-track').checked === true;
  const myWork = $('workspace-mywork').checked === true;
  if (name === '' || path === '') {
    setSetupStatus('workspace-status', { level: 'error', text: 'A name and the path of the local checkout are needed.' });
    return;
  }
  const body = {
    name, path, ...(handoff !== '' ? { handoff } : {}), ...(color !== '' ? { color } : {}), ...(description !== '' ? { description } : {}), ...(app !== '' ? { app } : {}),
    ...(track || myWork ? { digest: { track, my_work: myWork } } : {}),
  };
  const result = await setupRequest('workspace', 'api/workspaces', body, 'workspace-status', (data) =>
    ({ level: 'ok', text: `Registered ${data.name} (${data.path}). Next: New ticket.` }));
  if (result !== undefined) {
    for (const id of ['workspace-name', 'workspace-path', 'workspace-handoff', 'workspace-color', 'workspace-description', 'workspace-app']) {
      $(id).value = '';
    }
    $('workspace-track').checked = false;
    $('workspace-mywork').checked = false;
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
  if (state.setupPending.has('ticket-images') || (await newImagesSettled())) {
    return;
  }
  const describe = (data) => ({ level: 'ok', text: `Ticket created: ${data.path} in ${data.workspace} (base ${data.base}), an empty skeleton in the Queue. Next: a click on its card opens the conversation; your words are its first message.` });
  // The images go with this ticket as they are now; one pasted while it is being created stays for
  // the next ticket (Fix 4).
  const sending = snapshotNewImages();
  const result = await setupRequest('ticket', 'api/tickets', { workspace, ticket, title, request }, 'ticket-status', describe);
  if (result === undefined) {
    releaseNewImages();
  }
  // Created (SF-066): the dialog closes and the new ticket's card is highlighted (a click on it
  // opens its page); a failure keeps the dialog open with the error and the input. Then its images
  // go up (SF-064); one that fails leaves the ticket created, and the form stays open saying which
  // and why.
  if (result !== undefined) {
    $('ticket-key').value = '';
    $('ticket-title').value = '';
    $('ticket-request').value = '';
    const key = `${result.workspace ?? workspace}/${result.ticket ?? ticket}`;
    state.highlight = key;
    state.highlightShown = false;
    let uploaded = { count: 0, failed: [] };
    if (sending.length > 0) {
      state.setupPending.add('ticket-images');
      setSetupStatus('ticket-status', { level: 'pending', text: `Ticket created; attaching ${counted(sending.length, 'image')}…` });
      renderSetup();
      uploaded = await uploadNewImages(key, sending);
      state.setupPending.delete('ticket-images');
      // Only the images sent leave the form; one pasted meanwhile stays for the next ticket.
      for (const image of uploaded.sent) {
        URL.revokeObjectURL(image.url);
      }
      state.newImages = state.newImages.filter((image) => !uploaded.sent.includes(image));
      renderSetup();
    }
    releaseNewImages();
    if (uploaded.failed.length > 0) {
      setSetupStatus('ticket-status', { level: 'error', text: `Ticket created: ${result.path} in ${result.workspace ?? workspace}. Not attached: ${uploaded.failed.join('; ')}. Add ${uploaded.failed.length === 1 ? 'it' : 'them'} on the ticket's page: paste or drop on its Images card.` });
      renderBoard();
      return;
    }
    setSetupStatus('ticket-status', null);
    closeDrawer();
    const outcome = describe(result);
    toast(uploaded.count > 0 ? { ...outcome, text: `${outcome.text} ${counted(uploaded.count, 'image')} attached.` } : outcome);
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
    jobs = jobsOf(await withinTime(getText('api/jobs')));
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
    state.jobs = jobsOf(message.data);
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
    const data = JSON.parse(message.data);
    state.workspaces = data.workspaces;
    // SF-103: the hand-over default and the morning digest's settings.
    state.wsSettings = { handoff_default: data.handoff_default ?? null, digest: data.digest ?? null };
    renderSetup();
  });
  source.addEventListener('tickets', (message) => {
    const data = JSON.parse(message.data);
    state.tickets = data.tickets;
    state.archived = Array.isArray(data.archived) ? data.archived : [];
    state.jobLandsAfter = Array.isArray(data.job_lands_after) ? data.job_lands_after : [];
    state.queue = data.queue !== null && typeof data.queue === 'object' ? data.queue : null;
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
  state.lastLine = 0;
  state.entries = [];
  state.seen = new Set();
  state.stopSig = null;
  renderStream();
  $('scrChanges').replaceChildren();
  $('scrMr').replaceChildren();
  $('checkout-text').hidden = true;
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
  document.addEventListener('dragstart', onDragStart);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('drop', onDrop);
  document.addEventListener('dragend', onDragEnd);
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
  // SF-119: a phone's turn or a resized window across 768 px redraws the diff in its layout.
  if (typeof matchMedia === 'function') {
    const narrow = matchMedia(NARROW_QUERY);
    if (typeof narrow?.addEventListener === 'function') {
      narrow.addEventListener('change', () => {
        if (ui.screen === 'changes') {
          renderDiffPane();
        }
      });
    }
  }
  // The board's folded columns (SF-119).
  board.folded = readFolds();
  applyFolds();
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

  // The job page: the composer's confirmation (its buttons go through the delegated listener) and
  // Refresh state of an unknown outcome; the browser's "leave the page?" over an unsaved MR text.
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
  window.addEventListener('beforeunload', onBeforeUnload);
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
  // The Morning digest section (SF-103): typed values stay until saved.
  $('digest-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void submitDigestSettings();
  });
  for (const id of ['digest-at', 'digest-weekdays', 'digest-language']) {
    $(id).addEventListener('input', () => (state.digestDirty = true));
    $(id).addEventListener('change', () => (state.digestDirty = true));
  }
  // A ticket's images (SF-064): New ticket's paste, drop and ×; the planned ticket page's paste and
  // drop.
  $('ticket-form').addEventListener('paste', onFormPaste);
  $('ticket-form').addEventListener('dragover', onFormDrag);
  $('ticket-form').addEventListener('dragleave', onFormDrag);
  $('ticket-form').addEventListener('drop', onFormDrop);
  $('ticket-images').addEventListener('click', (event) => {
    const target = typeof event.target?.closest === 'function' ? event.target.closest('[data-newimg]') : null;
    if (target !== null && !target.disabled) {
      removeNewImage(Number(target.dataset.newimg));
    }
  });
  document.addEventListener('paste', onPagePaste);
  document.addEventListener('dragover', onPageDrag);
  document.addEventListener('dragleave', onPageDrag);
  document.addEventListener('drop', onPageDrop);
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
    state.jobs = jobsOf(text);
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
