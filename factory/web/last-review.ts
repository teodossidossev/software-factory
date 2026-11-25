// last-review.js, a dashboard script (DASHBOARD_SCRIPTS in src/dashboard.ts) right after composer.js,
// built from web/last-review.ts into dist/web/: the job page's last review panel, at the top of the
// Stream screen (#last-review): the review's note, then the comments neither sent nor dismissed by
// kind (changes, questions, follow-ups), each with its id, its file:line, its text, Send and
// Dismiss, with Send chosen and Dismiss all for several at once; a failed review its error. It is
// drawn again only when what it shows changed. Also the job card's count of the comments and the
// Stream line's jump to the panel. A classic script, loaded in order with defer,
// sharing the page's globals with the others. This file has no import or export on purpose: the
// compiler keeps it a script, so its top-level names stay the page's globals.
'use strict';

// Why Send and Dismiss are off while a Send or a Dismiss of the job's comments is out.
const LR_PENDING = "the last review's request is out; waiting for its outcome.";
// Why Send chosen is off while no comment is chosen.
const LR_NONE_CHOSEN = 'choose a comment first.';
// The kinds of comments, in the panel's order, with their headings.
const LR_KINDS: ReadonlyArray<readonly [LastReviewComment['kind'], string]> = [['change', 'Changes'], ['question', 'Questions'], ['follow_up', 'Follow-ups']];

// The comments ticked on each job's panel, by the job's key, with the iteration of the view they
// were ticked under (ids C1, C2, … start again in every iteration). Only ids the panel shows are
// kept; a job's entry goes when its panel is hidden or shows another iteration.
const lrChosen = new Map<string, { iteration: number; ids: Set<string> }>();
// The signature of the panel as drawn ('' while hidden), and the key of the job it shows.
let lrDrawn = '';
let lrDrawnKey: string | null = null;

// The shown job's last review, while its detail has one.
function lastReviewShown(): { key: string; job: JobRow; view: LastReviewView } | null {
  const detail = shownDetail();
  const job = shownJob();
  const view = detail?.last_review;
  if (job === null || view === null || view === undefined) {
    return null;
  }
  return { key: keyOf(job), job, view };
}

// The ids chosen on the job's panel, among those its view shows, in the view's order (none chosen
// under another iteration).
function lastReviewChosen(key: string, view: LastReviewView): string[] {
  const entry = lrChosen.get(key);
  if (entry === undefined || entry.iteration !== view.iteration) {
    return [];
  }
  return view.comments.map((comment) => comment.id).filter((id) => entry.ids.has(id));
}

// The job's entry kept to what its view shows: replaced for another iteration, the ids no longer
// shown dropped. Its set of ids, for a pick to change.
function lastReviewKeep(key: string, view: LastReviewView): Set<string> {
  let entry = lrChosen.get(key);
  if (entry === undefined || entry.iteration !== view.iteration) {
    entry = { iteration: view.iteration, ids: new Set() };
    lrChosen.set(key, entry);
  }
  const shown = new Set(view.comments.map((comment) => comment.id));
  for (const id of [...entry.ids]) {
    if (!shown.has(id)) {
      entry.ids.delete(id);
    }
  }
  return entry.ids;
}

// Whether a Send or a Dismiss of the job's comments is out.
const lastReviewPending = (key: string): boolean =>
  state.pending.has(pendingId('last-review-send', key)) || state.pending.has(pendingId('last-review-dismiss', key));

// Why Send is off ('' when on): a request out, else why the job takes no message now.
const lastReviewSendOff = (key: string, job: JobRow): string => (lastReviewPending(key) ? LR_PENDING : availability('say', job));

// Why Dismiss is off ('' when on): a request out, or the job's last action with an unknown outcome.
// It never reads Send's availability: a job that takes no message can still dismiss.
function lastReviewDismissOff(key: string): string {
  if (lastReviewPending(key)) {
    return LR_PENDING;
  }
  const unresolved = state.unresolved.get(key);
  if (unresolved === undefined) {
    return '';
  }
  return unresolved.failed
    ? "the last action's outcome is unknown and the current state could not be loaded."
    : "the last action's outcome is unknown; waiting for the current state.";
}

// What the panel shows depends on ('' while it shows nothing); it is drawn again only when this
// changed, so a box's focus and the panel's scroll stay on every jobs event.
function lastReviewSignature(): string {
  const shown = lastReviewShown();
  if (shown === null) {
    return '';
  }
  const { key, job, view } = shown;
  const unresolved = state.unresolved.get(key);
  return JSON.stringify([key, view, availability('say', job), state.pending.has(pendingId('last-review-send', key)),
    state.pending.has(pendingId('last-review-dismiss', key)), unresolved === undefined ? null : { failed: unresolved.failed }, lastReviewChosen(key, view)]);
}

// A button off with its reason as its title, or on without a title.
function lastReviewOff(node: HTMLButtonElement, reason: string): void {
  node.disabled = reason !== '';
  if (reason !== '') {
    node.setAttribute('title', reason);
  } else {
    node.removeAttribute('title');
  }
}

// Send chosen (n): off while Send is, else while none is chosen.
function lastReviewSendChosen(node: HTMLButtonElement, sendOff: string, chosen: number): void {
  node.textContent = `Send chosen (${chosen})`;
  lastReviewOff(node, sendOff !== '' ? sendOff : chosen === 0 ? LR_NONE_CHOSEN : '');
}

// One comment: its box, id, file:line (opening Changes at that line), text, Send and Dismiss.
function lastReviewItem(comment: LastReviewComment, chosen: readonly string[], sendOff: string, dismissOff: string): HTMLElement {
  const node = el('li', 'finding');
  node.dataset.id = comment.id;
  const pick = el('input');
  pick.type = 'checkbox';
  pick.checked = chosen.includes(comment.id);
  pick.dataset.lrpick = comment.id;
  pick.setAttribute('aria-label', `Choose ${comment.id}`);
  const path = pathLink(comment.path, null, comment.line);
  path.append(el('span', 'lrline', `:${comment.line}`));
  const problem = el('div', 'problem');
  problem.append(...prose(comment.text));
  const send = button('btn small', 'Send', { lr: `send:${comment.id}` });
  lastReviewOff(send, sendOff);
  const dismiss = button('btn small', 'Dismiss', { lr: `dismiss:${comment.id}` });
  lastReviewOff(dismiss, dismissOff);
  const decide = el('div', 'decide');
  decide.append(send, dismiss);
  node.append(pick, el('span', 'fid', comment.id), path, problem, decide);
  return node;
}

// The panel's block: a failure's error, or the note, the row of Send chosen and Dismiss all, and the
// comments by kind (or what became of them).
function lastReviewBlock(key: string, job: JobRow, view: LastReviewView): HTMLElement {
  const block = el('div', 'block');
  const head = el('div', 'bh');
  block.append(head);
  if (view.error !== null) {
    head.append(el('span', 'verdict stop', 'Last review failed'), `iteration ${view.iteration}`);
    block.append(el('pre', 'raw', view.error));
    return block;
  }
  const note = el('span', 'lr-note');
  const summary = view.summary ?? '';
  if (summary.trim() === '') {
    note.textContent = 'No note.';
  } else {
    note.append(...prose(summary));
  }
  head.append(el('span', 'verdict fix', 'Last review'), note);
  const acts = el('div', 'lr-acts');
  acts.append(el('span', 'muted', `iteration ${view.iteration} · ${counted(view.comments.length, 'comment')}`));
  block.append(acts);
  if (view.comments.length === 0) {
    block.append(el('div', 'muted', view.sent + view.dismissed === 0 ? 'No comments.' : `No comment left: ${view.sent} sent, ${view.dismissed} dismissed.`));
    return block;
  }
  const chosen = lastReviewChosen(key, view);
  const sendOff = lastReviewSendOff(key, job);
  const dismissOff = lastReviewDismissOff(key);
  const sendChosen = button('btn small primary', '', { lr: 'send-chosen' });
  sendChosen.id = 'lr-send-chosen';
  lastReviewSendChosen(sendChosen, sendOff, chosen.length);
  const dismissAll = button('btn small', 'Dismiss all', { lr: 'dismiss-all' });
  dismissAll.id = 'lr-dismiss-all';
  lastReviewOff(dismissAll, dismissOff);
  acts.append(sendChosen, dismissAll);
  for (const [kind, label] of LR_KINDS) {
    const comments = view.comments.filter((comment) => comment.kind === kind);
    if (comments.length > 0) {
      const list = el('ul', 'findings');
      list.append(...comments.map((comment) => lastReviewItem(comment, chosen, sendOff, dismissOff)));
      block.append(el('h4', 'lr-kind', `${label} (${comments.length})`), list);
    }
  }
  return block;
}

// The panel of the shown job's last review, hidden without one; drawn again only when its signature
// changed, keeping the focus on the control it was on and the panel's scroll.
function renderLastReview(): void {
  const panel = byId('last-review');
  const shown = lastReviewShown();
  if (shown === null) {
    if (lrDrawnKey !== null) {
      lrChosen.delete(lrDrawnKey);
    }
    if (ui.job !== null) {
      lrChosen.delete(ui.job);
    }
    lrDrawn = '';
    lrDrawnKey = null;
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  if (lrDrawnKey !== null && lrDrawnKey !== shown.key) {
    lrChosen.delete(lrDrawnKey);
  }
  lastReviewKeep(shown.key, shown.view);
  const signature = lastReviewSignature();
  if (signature === lrDrawn && !panel.hidden) {
    return;
  }
  const active = document.activeElement;
  const focused = active !== null && panel.contains(active) && hasDataset(active) ? active.dataset : {};
  const top = panel.scrollTop;
  panel.replaceChildren(lastReviewBlock(shown.key, shown.job, shown.view));
  // Focusable, for the Stream's line that leads here (lastReviewJump).
  panel.setAttribute('tabindex', '-1');
  panel.hidden = false;
  panel.scrollTop = top;
  lrDrawn = signature;
  lrDrawnKey = shown.key;
  const { lr, lrpick } = focused;
  [...panel.querySelectorAll<HTMLElement>('[data-lr],[data-lrpick]')]
    .find((node) => (lr !== undefined && node.dataset.lr === lr) || (lrpick !== undefined && node.dataset.lrpick === lrpick))?.focus();
}

// The job card's count of the last review's comments still shown (the row's last_review), while
// the job waits for the user and there is at least one: "Review: N comment(s)". A click on it
// opens the job, as any click on the card does.
function lastReviewCardLine(job: JobRow): HTMLElement[] {
  const comments = job.last_review?.comments;
  if (!WAITING_STATES.includes(job.state) || typeof comments !== 'number' || comments < 1) {
    return [];
  }
  return [el('div', 'meta note', `Review: ${counted(comments, 'comment')}`)];
}

// The Stream's line of a last review (data-lr panel:<iteration>): the panel into view and focused
// when it shows that iteration's review (a failed one too), else a toast that it is gone.
function lastReviewJump(iteration: string): void {
  const shown = lastReviewShown();
  const panel = byId('last-review');
  if (shown === null || panel.hidden || String(shown.view.iteration) !== iteration) {
    toast({ level: 'info', text: "The last review's comments are no longer shown: the job moved on." });
    return;
  }
  panel.scrollIntoView({ block: 'nearest' });
  panel.focus();
}

// A click on Send, Send chosen, Dismiss or Dismiss all (data-lr: send:<id>, send-chosen,
// dismiss:<id>, dismiss-all): posts the ids it names, among those shown, with the iteration of the
// view shown, when its button is on; or on the Stream's line of a last review (panel:<iteration>).
function lastReviewAct(value: string): void {
  if (value.startsWith('panel:')) {
    lastReviewJump(value.slice('panel:'.length));
    return;
  }
  const shown = lastReviewShown();
  if (shown === null || shown.view.error !== null) {
    return;
  }
  const { key, job, view } = shown;
  const ids = view.comments.map((comment) => comment.id);
  const at = value.indexOf(':');
  const verb = at < 0 ? value : value.slice(0, at);
  const named = at < 0 ? '' : value.slice(at + 1);
  let action: 'last-review-send' | 'last-review-dismiss';
  let posted: string[];
  if (value === 'send-chosen') {
    action = 'last-review-send';
    posted = lastReviewChosen(key, view);
  } else if (value === 'dismiss-all') {
    action = 'last-review-dismiss';
    posted = ids;
  } else if ((verb === 'send' || verb === 'dismiss') && ids.includes(named)) {
    action = verb === 'send' ? 'last-review-send' : 'last-review-dismiss';
    posted = [named];
  } else {
    return;
  }
  const off = action === 'last-review-send' ? lastReviewSendOff(key, job) : lastReviewDismissOff(key);
  if (off !== '' || posted.length === 0) {
    return;
  }
  void run(action, key, { iteration: view.iteration, ids: posted });
}

// A comment's box clicked: the choice follows the box (never toggled here), and Send chosen is
// updated in place; the list is not drawn again, so the focus stays on the box. A panel that was
// already behind what it shows is drawn again instead (the focus kept on the box).
function lastReviewPick(id: string, box: HTMLElement): void {
  const shown = lastReviewShown();
  if (shown === null || !shown.view.comments.some((comment) => comment.id === id)) {
    return;
  }
  const { key, job, view } = shown;
  const current = lastReviewSignature() === lrDrawn;
  const ids = lastReviewKeep(key, view);
  if ('checked' in box && box.checked === true) {
    ids.add(id);
  } else {
    ids.delete(id);
  }
  const sendChosen = byId('last-review').querySelector<HTMLButtonElement>('#lr-send-chosen');
  if (!current || sendChosen === null) {
    renderLastReview();
    return;
  }
  lastReviewSendChosen(sendChosen, lastReviewSendOff(key, job), lastReviewChosen(key, view).length);
  lrDrawn = lastReviewSignature();
}
