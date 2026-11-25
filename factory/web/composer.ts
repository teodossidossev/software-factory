// composer.js, a dashboard script (DASHBOARD_SCRIPTS in src/dashboard.ts) right after job-page.js,
// built from web/composer.ts into dist/web/: the job page's composer: its sentence, the planner
// block, the message box and the actions' row, the hand-over panel, the composer's More ▾ menu and
// its own buttons. A classic script, loaded in order with defer, sharing the page's globals with
// the others. This file has no import or export on purpose: the compiler keeps it a script, so its
// top-level names stay the page's globals.
'use strict';

// ---------- The composer (the prototype's renderComposer, with the server's actions) ----------

// The placeholder of the message box, per state.
const PLACEHOLDER: Readonly<Partial<Record<JobState, string>>> = {
  starting: 'Message the Implementer; it reads it at its next step (Ctrl+Enter sends)',
  working: 'Message the Implementer; it reads it at its next step (Ctrl+Enter sends)',
  awaiting_review: 'Message the job; the Implementer reads it when the reviews end',
  needs_human: 'Or tell the Implementer what to do instead',
  ready_for_human_review: 'Ask the Implementer for a last change before you push',
  handed_over: 'What should the Implementer change? Your edits in the checkout go with the message.',
  preparing_mr: 'The factory takes no message while it writes the MR text',
};

// The keys of the ready jobs whose Ask for a change (readyAsk) and whose planning chat link field
// (readyChat) are open, while the page is open; a job shown in another state leaves both.
const readyAsk = new Set<string>();
const readyChat = new Set<string>();

// The second line of a ready panel's menu item, by action, while it is on.
const READY_NOTES: Readonly<Record<string, string>> = {
  'review-mr': 'Push from here instead of your checkout.',
  approve: 'Push the prepared branch, without the Merge request screen.',
};

// The composer: the sentence in bold (and the merge request of a pushed job), the inline
// confirmation, the message box and the actions; a disabled action has its reason as its title. A
// handed-over job has its hand-over panel instead of the message box and the actions; a job ready
// for review the chip "Ready to push" in place of the bold sentence and the ready panel, its
// message box, Send and Quick fix shown only while Ask for a change is open.
function renderComposer(): void {
  const job = state.detail?.job ?? null;
  // A confirmation opened before the doubt is not one the user could open now.
  if (state.confirm !== null && state.unresolved.has(state.confirm.key) && availability(state.confirm.action, job) !== '') {
    closeConfirm();
    return;
  }
  const msg = byIdAs('msg', 'textarea');
  byId('refresh-button').hidden = state.key === null || state.unresolved.get(state.key)?.failed !== true;
  if (job === null) {
    renderReadyPanel(null);
    placeHandoverPanel(null);
    composerRow().hidden = false;
    renderPlanner(null);
    byId('composer-sentence').replaceChildren(el('span', 'muted', 'Loading the job…'));
    byId('acts').replaceChildren();
    byId('acts-why').replaceChildren();
    msg.disabled = true;
    return;
  }
  const ready = job.state === 'ready_for_human_review';
  // The detail's job, with what only the jobs payload has (the stop's numbers). A ready job: its
  // status chip and what it means instead; the primary action says what comes next.
  const cs = [ready ? readyStatus() : el('b', '', `${headSentence({ ...(shownJob() ?? {}), ...job })}.`)];
  if (job.state === 'paused' && job.task_changed === true) {
    cs.push(el('span', 'muted', TASK_CHANGED));
  }
  // The hand-over: why a job ready for review was not handed over; what a handed-over one takes.
  if (ready && skippedNote(job) !== '') {
    cs.push(el('span', 'muted ready-note', skippedNote(job).trim()));
  }
  if (hasMr(job)) {
    const line = el('span', 'mr-line');
    line.id = 'mr-line';
    line.append(document.createTextNode(`Merge request #${job.mr.number} (${job.mr.state}): `), mrLink(job.mr));
    cs.push(line);
  }
  const read = mrReadLines(job);
  if (read.length > 0) {
    const status = el('span', 'muted', read.join(' '));
    status.id = 'mr-status-line';
    cs.push(status);
  }
  const finished = TERMINAL_STATES.includes(job.state);
  if (finished) {
    cs.push(el('span', 'muted', 'The message box is hidden on a finished job.'));
  }
  byId('composer-sentence').replaceChildren(...cs);
  renderPlanner(job);
  msg.hidden = finished;
  msg.disabled = !(job.availability?.say === '' || pausedTurn(job));
  const resumeWord = job.state === 'waiting_limit' ? 'Resume now' : 'Resume';
  msg.placeholder = job.availability?.resume === '' ? (pausedTurn(job) ? `${resumeWord} sends this to the Implementer, if you write one` : `${resumeWord}, then message the Implementer`)
    : PLACEHOLDER[job.state] ?? 'Message';
  // The actions the server lists for the job, in its order; a ready job's are in its panel, Send
  // and Quick fix aside.
  const buttons = listedActions(job).filter((shown) => !ready || MESSAGE_ACTIONS.includes(shown.action))
    .map((shown) => actionButton(job, shown.action, shown.label, `btn${shown.primary ? ' primary' : ''}${shown.danger ? ' danger' : ''}`));
  keepFocus(byId('acts'), () => byId('acts').replaceChildren(...buttons));
  // The ready panel first: the More ▾ menu of a panel it removes is closed before a hand-over
  // panel draws its own.
  renderReadyPanel(job);
  if (job.state === 'handed_over') {
    renderHandoverPanel(job, state.detail);
  } else {
    placeHandoverPanel(null);
  }
  composerRow().hidden = job.state === 'handed_over' || (ready && !readyAsk.has(keyOf(job)));
  const confirm = byId('confirm');
  byId('acts-why').replaceChildren(...whyLines([...byId('composer').querySelectorAll('button')].filter((node) => !confirm.contains(node))));
}

// Why Send or Dismiss of the planner's suggestion is off, or '': either one's request out keeps both
// off; Send takes what say takes (the note goes as the user's message).
function plannerAvailability(action: 'suggestion-send' | 'suggestion-dismiss', job: JobRow): string {
  for (const other of ['suggestion-send', 'suggestion-dismiss']) {
    if (state.pending.has(pendingId(other, keyOf(job)))) {
      return PENDING_REASONS[other] ?? '';
    }
  }
  return action === 'suggestion-send' ? availability('say', job) : '';
}

// The planner block, right after the composer's sentence: the planner's suggestion while it
// is shown, as plain text, with Send (the note as the user's message) and Dismiss; Discuss the result
// (the ChatGPT link, or the message to copy; for a ticket Claude Code plans, jobPlannerControls'
// session link or start) while the job waits for the user; Open the planning chat
// and its field. A ready job's Discuss and field are in its ready panel instead. Every href is
// checked against its fixed prefix.
function renderPlanner(job: JobRow | null): void {
  const block = byId('planner');
  const planner = job?.planner;
  if (job === null || planner === undefined || planner === null) {
    jobPlannerLeave();
    withChatFocus(() => block.replaceChildren());
    block.hidden = true;
    return;
  }
  const key = keyOf(job);
  const content: HTMLElement[] = [];
  const suggestion = planner.suggestion;
  if (suggestion !== null && typeof suggestion.note === 'string') {
    const box = el('div', 'planner-suggestion');
    box.id = 'planner-suggestion';
    const note = el('p', 'planner-note', suggestion.note);
    const send = button('btn primary', 'Send', { act: 'suggestion-send' });
    send.id = 'suggestion-send-button';
    const sendOff = plannerAvailability('suggestion-send', job);
    send.disabled = sendOff !== '';
    if (sendOff !== '') {
      send.setAttribute('title', sendOff);
    }
    const dismiss = button('btn', 'Dismiss', { act: 'suggestion-dismiss' });
    dismiss.id = 'suggestion-dismiss-button';
    const dismissOff = plannerAvailability('suggestion-dismiss', job);
    dismiss.disabled = dismissOff !== '';
    if (dismissOff !== '') {
      dismiss.setAttribute('title', dismissOff);
    }
    const buttons = el('div', 'planner-acts');
    buttons.append(send, dismiss);
    box.append(el('b', 'planner-title', 'Planner suggests changes'), note, buttons);
    content.push(box);
  }
  const links = el('div', 'planner-links');
  const discuss = planner.discuss;
  // A ready job's Discuss and field are in its panel's More ▾.
  const ready = job.state === 'ready_for_human_review';
  // Claude Code plans the ticket: its session's link, or Discuss the result that starts one; any
  // other job (or none, above) leaves the session's reads.
  const claude = planner.owner === 'claude_code' && discuss !== null;
  if (claude) {
    jobPlannerWatch(job);
  } else {
    jobPlannerLeave();
  }
  if (claude && !ready) {
    links.append(...jobPlannerControls(job, false));
  } else if (!ready && discuss !== null && typeof discuss.message === 'string') {
    if (typeof discuss.url === 'string' && discuss.url.startsWith(CHATGPT_PREFILL_URL)) {
      links.append(tabLink('fs13', 'Discuss the result ↗', discuss.url));
    } else {
      links.append(button('btn small', 'Copy the message for the planner', { act: 'planner-copy' }));
    }
  }
  const chat = planningChatHref(planner.chat);
  if (chat !== null) {
    links.append(tabLink('fs13', 'Open the planning chat ↗', chat));
  }
  if (links.children.length > 0) {
    content.push(links);
  }
  if (!ready) {
    content.push(chatLinkField('job', key, typeof planner.chat === 'string' ? planner.chat : null, (what) => ({ act: `chat-${what}` })));
  }
  withChatFocus(() => keepFocus(block, () => block.replaceChildren(...content)));
  block.hidden = content.length === 0;
}

// The reasons of the disabled buttons (their titles), as text for a phone or a device
// without hover (app.css shows .why only there): one line per reason, in the buttons' order,
// "Off: <labels> (<reason>)". Only .btn buttons with a title; Send and Quick fix (data-act "say"
// and "quickfix", the message box's actions) are left out, whatever the reason.
function whyLines(buttons: readonly HTMLElement[]): HTMLElement[] {
  const byReason = new Map<string, string[]>();
  for (const node of buttons) {
    const reason = node.getAttribute('title') ?? '';
    if ('disabled' in node && node.disabled === true && reason !== '' && node.classList.contains('btn') && !MESSAGE_ACTIONS.includes(node.dataset.act ?? '')) {
      byReason.set(reason, [...(byReason.get(reason) ?? []), node.textContent.trim()]);
    }
  }
  return [...byReason].map(([reason, labels]) => el('div', '', `Off: ${labels.join(', ')} (${reason})`));
}

// The composer's row of the message box and the actions (#msg, #acts).
function composerRow(): HTMLElement {
  // dashboard.html's composer has its .crow row.
  const crow = byId('composer').querySelector<HTMLElement>('.crow');
  if (crow === null) {
    throw new Error('The composer has no .crow row');
  }
  return crow;
}

// The actions that send the message box's text: Send and Quick fix. An empty box disables them, the
// reasons line leaves them out, and a ready job shows them beside the box, not in More ▾.
const MESSAGE_ACTIONS: readonly string[] = ['say', 'quickfix'];

// The actions the server lists for the job, in its order.
const listedActions = (job: JobRow): readonly ShownAction[] => (Array.isArray(job.actions) ? job.actions : []);

// One action's button of the composer, disabled with its reason as its title: the action's
// availability, an open confirmation, an empty message box for a message.
function actionButton(job: JobRow, action: string, label: string, className: string): HTMLButtonElement {
  const node = button(className, label, { act: action });
  node.id = `${action}-button`;
  let reason = availability(action === 'goon' ? 'say' : action, job);
  if (reason === '' && state.confirm !== null) {
    reason = 'a confirmation is open: confirm or cancel it first.';
  }
  if (reason === '' && MESSAGE_ACTIONS.includes(action) && byIdAs('msg', 'textarea').value.trim() === '') {
    reason = 'write a message first.';
  }
  node.disabled = reason !== '';
  if (reason !== '') {
    node.setAttribute('title', reason);
  }
  return armable(node, action, keyOf(job));
}

// ---------- The hand-over panel (the two ways to finish a handed-over job) ----------

// Puts the hand-over panel in the composer for the job's key, or takes it away (key null): the
// panel goes right after #confirm and .crow is hidden; #msg (the Ask box) and #action-status (the
// outcome) move into it, and back to their places (#msg before #acts in .crow, #action-status right
// after .crow) when it goes. A new panel, or one taken away, draws the outcome again in its form.
// Returns the panel (null when taken away).
function placeHandoverPanel(key: string): HTMLElement;
function placeHandoverPanel(key: null): null;
function placeHandoverPanel(key: string | null): HTMLElement | null {
  const crow = composerRow();
  const msg = byId('msg');
  const status = byId('action-status');
  let panel = $('handover-panel');
  if (panel !== null && panel.dataset.key !== key) {
    // Out of the panel first: a removed panel's elements are no longer in the document.
    byId('acts').before(msg);
    crow.after(status);
    panel.remove();
    panel = null;
    state.moreMenu = false;
    crow.hidden = false;
    if (key === null) {
      renderOutcome(outcomeOf(state.key));
    }
  }
  if (key === null || panel !== null) {
    return panel;
  }
  panel = el('div', 'handover');
  panel.id = 'handover-panel';
  panel.dataset.key = key;
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-labelledby', 'handover-title');
  const ask = el('div', 'ho-ask');
  ask.append(msg, el('div', 'ho-askrow'));
  panel.append(el('div', 'ho-top'), ask, status);
  byId('confirm').after(panel);
  crow.hidden = true;
  renderOutcome(outcomeOf(state.key));
  return panel;
}

// The last outcome of a job (none without a job open).
const outcomeOf = (key: string | null): Outcome | null => (key === null ? null : state.outcomes.get(key) ?? null);

// The last iteration of the detail, or null without one.
const lastIteration = (detail: JobDetail | null): IterationRow | null => (detail?.iterations ?? []).reduce<IterationRow | null>((last, iteration) => (last === null || iteration.number > last.number ? iteration : last), null);

// The panel of a handed-over job, drawn again on each call (the focus kept): its stop, if any; the
// heading with the composer's More ▾ menu; the facts; the two paths (I push it myself, The factory
// pushes it); Ask for changes with the moved #msg.
function renderHandoverPanel(job: JobRow, detail: JobDetail | null): void {
  const panel = placeHandoverPanel(keyOf(job));
  // placeHandoverPanel made the panel with its .ho-top and .ho-askrow.
  const top = panel.querySelector<HTMLElement>('.ho-top');
  const row = panel.querySelector<HTMLElement>('.ho-askrow');
  if (top === null || row === null) {
    throw new Error('The hand-over panel has no .ho-top or .ho-askrow');
  }
  const parts: HTMLElement[] = [];
  if (job.error) {
    parts.push(el('div', 'ho-error', `${job.error.code}: ${job.error.message}`));
  }
  const head = el('div', 'ho-head');
  const title = el('b', '', 'It is in your checkout. How do you finish it?');
  title.id = 'handover-title';
  head.append(title, handoverMenu(job));
  parts.push(head, handoverFacts(job, detail));
  const viaMr = mrOff(job) === '';
  const paths = el('div', 'ho-paths');
  paths.append(
    handoverPath('I push it myself', ['Review and run it in the IDE.', 'Commit (the message is prefilled with the MR text) and push.', 'Open the MR on the forge.'],
      actionButton(job, 'handed-done', 'I opened the MR', 'btn primary'), actionButton(job, 'merged-archive', ACTION_LABELS['merged-archive']!, 'btn')),
    handoverPath('The factory pushes it', ['Review it in the IDE.', 'The factory pushes its commit (or your own commits, if you committed); your uncommitted edits stay in your checkout and are not pushed.',
      ...(viaMr ? ['Then it opens the MR.'] : [])],
    viaMr ? actionButton(job, 'mr-create', 'Push and open the MR…', 'btn primary') : actionButton(job, 'approve', 'Push…', 'btn primary')),
  );
  parts.push(paths);
  keepFocus(top, () => top.replaceChildren(...parts));
  keepFocus(row, () => row.replaceChildren(actionButton(job, 'say', 'Ask for changes', 'btn'), actionButton(job, 'quickfix', 'Quick fix', 'btn'),
    el('span', 'muted', 'Ask for changes: the full loop. Quick fix: one turn and the checks, no review while the change stays small.')));
}

// One path of the panel: its title, its steps and its buttons.
function handoverPath(title: string, steps: readonly string[], ...actions: HTMLElement[]): HTMLElement {
  const box = el('section', 'ho-path');
  const list = el('ol');
  list.append(...steps.map((step) => el('li', '', step)));
  box.append(el('b', '', title), list, ...actions);
  return box;
}

// The facts line: the branch, since when it is in the checkout, the last iteration's files and
// their lines (when it has a file list), and the accepted risks as chips (simplifications aside,
// as notFixed of src/ledger.ts).
function handoverFacts(job: JobRow, detail: JobDetail | null): HTMLElement {
  const facts = el('div', 'ho-facts');
  facts.append(el('span', 'mono', job.branch));
  const since = clock(job.handover?.at);
  if (since !== '') {
    facts.append(el('span', '', `In your checkout since ${since}`));
  }
  const files = lastIteration(detail)?.files;
  if (Array.isArray(files)) {
    const sum = (field: 'additions' | 'deletions'): number => files.reduce((total, file) => total + (Number(file[field]) || 0), 0);
    facts.append(el('span', '', `${files.length} ${files.length === 1 ? 'file' : 'files'}, +${sum('additions')} −${sum('deletions')} as Local Changes`));
  }
  const risks = (detail?.ledger ?? []).filter((entry) => entry.status === 'accepted_risk' && entry.reviewer !== 'simplify');
  if (risks.length > 0) {
    const line = el('span', 'ho-risks', 'Accepted risks:');
    for (const entry of risks) {
      const chip = el('span', 'ho-chip', entry.id);
      chip.setAttribute('title', entry.problem ?? '');
      line.append(chip);
    }
    facts.append(line);
  }
  return facts;
}

// The composer's More ▾ menu around its items: the toggle (More ▾, of the class toggleClass) and
// the menu, open while state.moreMenu is; every item but a separator is a menuitem.
function moreMenu(items: readonly HTMLElement[], toggleClass = 'btn small'): HTMLElement {
  const wrap = el('div', 'ho-more');
  const toggle = button(toggleClass, 'More ▾', { homenu: '' });
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', String(state.moreMenu));
  const menu = el('div', 'ho-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'More');
  menu.hidden = !state.moreMenu;
  for (const item of items) {
    if (item.getAttribute('role') !== 'separator') {
      item.setAttribute('role', 'menuitem');
    }
  }
  menu.append(...items);
  wrap.append(toggle, menu);
  return wrap;
}

// The hand-over panel's More ▾ menu: Take it back (with what it does), Refresh MR status, a
// separator, Abort the job….
function handoverMenu(job: JobRow): HTMLElement {
  const takeback = actionButton(job, 'takeback', 'Take it back', 'ho-item');
  takeback.append(el('span', 'muted', 'Your checkout returns to how it was; the job stays ready.'));
  const refresh = actionButton(job, 'mr-status', 'Refresh MR status', 'ho-item');
  const separator = el('div', 'ho-sep');
  separator.setAttribute('role', 'separator');
  const abort = actionButton(job, 'abort', 'Abort the job…', 'ho-item danger');
  return moreMenu([takeback, refresh, separator, abort]);
}

// The composer's More ▾ menu's items, made by moreMenu as buttons.
const moreItems = (): HTMLButtonElement[] => [...byId('composer').querySelectorAll<HTMLButtonElement>('.ho-menu [role="menuitem"]')];

// Opens or closes the composer's More ▾ menu; an opened one focuses its first item.
function setMoreMenu(open: boolean): void {
  if (state.moreMenu === open) {
    return;
  }
  state.moreMenu = open;
  renderComposer();
  if (open) {
    moreItems().find((item) => !item.disabled)?.focus();
  }
}

// Arrow Down and Up move between the open menu's items (from its toggle too).
function moreMenuKey(event: KeyboardEvent): void {
  const items = moreItems().filter((item) => !item.disabled);
  if (items.length === 0) {
    return;
  }
  const at = items.findIndex((item) => item === document.activeElement);
  const step = event.key === 'ArrowDown' ? 1 : -1;
  // In range: an index within the items, which are not empty.
  items[at < 0 ? (step === 1 ? 0 : items.length - 1) : (at + step + items.length) % items.length]?.focus();
}

// ---------- The ready panel (the ways to finish a job ready for review) ----------

// A ready job's status, in place of the bold sentence: the chip and what it means.
function readyStatus(): HTMLElement {
  const status = el('span', 'ready-status');
  status.append(el('span', 'ready-chip', 'Ready to push'), el('span', '', 'Reviews are clean and the MR text is written.'));
  return status;
}

// The ChatGPT link of the job's result, or null: the server builds it only when ChatGPT plans the
// ticket (the link of a waiting job always fits).
function chatGptLink(job: JobRow): string | null {
  const url = job.planner?.discuss?.url;
  return typeof url === 'string' && url.startsWith(CHATGPT_PREFILL_URL) ? url : null;
}

// Whether the job's ticket takes a planning chat link from the ready panel: it has none stored, and
// Claude Code plans it (the field takes its session link) or ChatGPT does with a link of the result
// (one whose message is too long for the link gets no field).
const takesChatLink = (job: JobRow): boolean => (chatGptLink(job) !== null || job.planner?.owner === 'claude_code') && job.planner?.chat === null;

// The ready panel of a job ready for review, right after #confirm, drawn again on each call (the
// focus kept): one row with the listed primary action, Ask for a change (which shows .crow), More ▾
// and the listed dangerous one (Abort…), and under it the planning chat link field while it is
// open. Any other job, or none, has no panel; a job shown in another state leaves readyAsk and
// readyChat. While a card's button wants the focus in the box (state.wantFocus 'composer'), Ask
// for a change opens, for the box to take it.
function renderReadyPanel(job: JobRow | null): void {
  const key = job === null ? null : keyOf(job);
  const ready = job !== null && job.state === 'ready_for_human_review';
  if (key !== null && !ready) {
    readyAsk.delete(key);
    readyChat.delete(key);
  }
  let panel = $('ready-panel');
  if (panel !== null && (!ready || panel.dataset.key !== key)) {
    panel.remove();
    panel = null;
    state.moreMenu = false;
  }
  if (!ready || key === null) {
    return;
  }
  if (panel === null) {
    panel = el('div', 'ready');
    panel.id = 'ready-panel';
    panel.dataset.key = key;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Ready to push');
    byId('confirm').after(panel);
  }
  if (state.wantFocus === 'composer') {
    readyAsk.add(key);
  }
  const listed = listedActions(job);
  const row = el('div', 'rd-row');
  const primary = listed.find((shown) => shown.primary);
  if (primary !== undefined) {
    row.append(actionButton(job, primary.action, primary.label, 'btn primary'));
  }
  const ask = button('btn', 'Ask for a change', { act: 'ask' });
  ask.id = 'ask-button';
  ask.setAttribute('aria-expanded', String(readyAsk.has(key)));
  row.append(ask, moreMenu(readyMenuItems(job), 'btn'));
  const danger = listed.find((shown) => shown.danger);
  if (danger !== undefined) {
    row.append(actionButton(job, danger.action, danger.label, 'btn danger rd-abort'));
  }
  const parts: HTMLElement[] = [row];
  if (readyChat.has(key) && takesChatLink(job)) {
    const chat = el('div', 'rd-chat');
    chat.append(chatLinkField('job', key, null, (what) => ({ act: `chat-${what}` })));
    parts.push(chat);
  } else {
    readyChat.delete(key);
  }
  const drawn = panel;
  withChatFocus(() => keepFocus(drawn, () => drawn.replaceChildren(...parts)));
}

// The ready panel's More ▾ items: each listed action but the primary, Send, Quick fix and the dangerous one,
// in the server's order, with its second line (why it is off, else READY_NOTES'), a separator
// before Refresh MR status; then Discuss the result ↗ (the ChatGPT link, else Copy the message for
// the planner; for a ticket Claude Code plans, jobPlannerControls' items) while the job has a
// message for the planner, and Planning chat link… while takesChatLink.
function readyMenuItems(job: JobRow): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const shown of listedActions(job)) {
    if (shown.primary || shown.danger || MESSAGE_ACTIONS.includes(shown.action)) {
      continue;
    }
    if (shown.action === 'mr-status') {
      const separator = el('div', 'ho-sep');
      separator.setAttribute('role', 'separator');
      items.push(separator);
    }
    const item = actionButton(job, shown.action, shown.label, 'ho-item');
    const note = item.disabled ? item.getAttribute('title') ?? '' : READY_NOTES[shown.action] ?? '';
    if (note !== '') {
      item.append(el('span', 'muted', note));
    }
    items.push(item);
  }
  if (job.planner?.owner === 'claude_code' && job.planner.discuss !== null) {
    items.push(...jobPlannerControls(job, true));
  } else if (typeof job.planner?.discuss?.message === 'string') {
    const url = chatGptLink(job);
    items.push(url !== null ? tabLink('ho-item', 'Discuss the result ↗', url) : button('ho-item', 'Copy the message for the planner', { act: 'planner-copy' }));
  }
  if (takesChatLink(job)) {
    const open = button('ho-item', 'Planning chat link…', { act: 'chat-open' });
    open.id = 'chat-open-button';
    items.push(open);
  }
  return items;
}

// The composer's own buttons, which composerAct handles: the planner block's, the planning chat
// link's and the ready panel's toggles.
const COMPOSER_ACTS: readonly string[] = ['suggestion-send', 'suggestion-dismiss', 'planner-copy', 'planner-discuss', 'chat-save', 'chat-remove', 'ask', 'chat-open'];

// The planner block's buttons: Send posts the sha256 of the suggestion the page shows (the server
// sends its stored note only while it is that one), Dismiss removes it; Copy puts the message for
// the planner on the clipboard; Discuss the result starts the planner on the result
// (jobPlannerDiscuss); Save and Remove of the planning chat link. The ready panel's Ask
// for a change and Planning chat link… open and close the box and the field, the focus in what
// opened or back on what opened it.
function composerAct(action: string, job: JobRow): void {
  const key = keyOf(job);
  const planner = job.planner;
  if (action === 'ask' || action === 'chat-open') {
    const open = action === 'ask' ? readyAsk : readyChat;
    const opened = !open.delete(key);
    if (opened) {
      open.add(key);
    }
    renderComposer();
    const focus = action === 'ask' ? $(opened ? 'msg' : 'ask-button')
      : opened ? $('job-chat-input') : document.querySelector<HTMLElement>('#ready-panel [data-homenu]');
    focus?.focus();
  } else if (action === 'suggestion-send' || action === 'suggestion-dismiss') {
    const suggestion = planner?.suggestion ?? null;
    if (suggestion === null || plannerAvailability(action, job) !== '') {
      return;
    }
    void run(action, key, action === 'suggestion-send' ? { sha256: suggestion.sha256 } : {});
  } else if (action === 'planner-copy') {
    const message = planner?.discuss?.message;
    if (typeof message === 'string') {
      copyValue(message, byIdAs('planner-copy-text', 'textarea'), (text) => toast({ level: 'info', text: `${text} The message for the planner.` }));
    }
  } else if (action === 'planner-discuss') {
    void jobPlannerDiscuss(key);
  } else {
    void saveChatLink('job', key, action === 'chat-remove');
  }
}
