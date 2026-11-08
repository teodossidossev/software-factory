// main.js, the dashboard's last script (DASHBOARD_SCRIPTS in src/dashboard.ts): the stream, the
// job selected, the page's start and its loading. A classic script, loaded in order with defer,
// sharing the page's globals with the others.
'use strict';

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
