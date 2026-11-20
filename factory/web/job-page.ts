// job-page.js, the dashboard's third script (DASHBOARD_SCRIPTS in src/dashboard.ts), built from
// web/job-page.ts into dist/web/: the job page's header and the job's detail and actions
// (availability, the outcome line, the requests, the confirmations and the ticket dialog); the
// composer is composer.js's. A classic script, loaded in order with defer, sharing the page's
// globals with the others. This file has no import or export on purpose: the compiler keeps
// it a script, so its top-level names stay the page's globals.
'use strict';

// The element with the id, where the page requires it as that tag (dashboard.html has it so, or
// the page made it): a missing one or one of another tag is a broken page and throws.
function byIdAs<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
  const node = byId(id);
  if (!isTag(node, tag)) {
    throw new Error(`The page's element #${id} is not a <${tag}>`);
  }
  return node;
}

// An element read as an HTML element, which has a dataset (an Element's type has none). No
// instanceof: the tests' fake page has no element classes.
const hasDataset = (node: Element): node is HTMLElement => 'dataset' in node;

// ---------- The header (the prototype's renderHead) ----------

// Draws a part of the job page again (the header, the composer's actions: on every jobs event,
// every 15 s while the job runs) and keeps the focus on the button it was on.
function keepFocus(container: HTMLElement, work: () => void): void {
  const active = document.activeElement;
  const data: Readonly<DOMStringMap> = active !== null && active !== undefined && container.contains(active) && hasDataset(active) ? active.dataset ?? {} : {};
  const name = ['act', 'goto', 'back', 'copyBranch', 'tk', 'tktab', 'homenu'].find((key) => data[key] !== undefined);
  work();
  if (name !== undefined) {
    const attribute = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    [...container.querySelectorAll<HTMLElement>(`[data-${attribute}]`)].find((node) => node.dataset[name] === data[name])?.focus();
  }
}

// ← Board (Esc), the key, the title and the code of a stop; the switch Stream (s), Changes (N) (c)
// and Merge request (m); the sentence with the state's dot, the iteration, the cost, the time and
// the branch, which copies its checkout command.
function renderHead(): void {
  const job = shownJob();
  if (job === null) {
    return;
  }
  byId('job').className = `st-${job.state}`;
  const backButton = button('btn back', '← Board', { back: '' });
  backButton.setAttribute('title', 'Back to the board (Esc)');
  const t1 = el('div', 't1');
  const title = el('span', 'title', titleOf(job));
  title.setAttribute('title', titleOf(job));
  t1.append(el('span', 'key', job.ticket), wsChip(job.workspace), title);
  if (job.state === 'needs_human' && typeof job.error?.code === 'string') {
    t1.append(el('span', 'tag', job.error.code));
  }
  const switcher = el('div', 'switch');
  switcher.setAttribute('role', 'tablist');
  switcher.setAttribute('aria-label', 'Job screens');
  const mrOk = mrAvailable();
  for (const [screen, text, key] of [['stream', 'Stream', 's'], ['changes', typeof job.files === 'number' ? `Changes (${job.files})` : 'Changes', 'c'], ['mr', 'Merge request', 'm']] as const) {
    const tab = button(ui.screen === screen ? 'on' : '', `${text} `, { goto: screen });
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(ui.screen === screen));
    tab.append(el('span', 'kbd', key));
    if (screen === 'mr') {
      tab.setAttribute('aria-disabled', String(!mrOk));
      // On a phone or a device without hover the tab stays tappable, and its tap says why
      // (go's toast); with a mouse its title does.
      tab.disabled = !mrOk && !media(TOUCH_QUERY);
      tab.setAttribute('title', mrOk ? 'The merge request text' : 'No MR text yet: written at Clean');
    }
    switcher.append(tab);
  }
  const tools = el('div', 'tools');
  tools.append(switcher);
  const running = RUNNING.includes(job.state);
  const t2 = el('div', 't2');
  const line = el('span', 'sentence');
  line.append(el('span', 'dot'), document.createTextNode(headSentence(job)));
  const branch = button('mono fs12 branch', job.branch, { copyBranch: '' });
  branch.setAttribute('title', `Copy the checkout command: git checkout ${job.branch}`);
  const end = running ? Date.now() : Date.parse(job.updated_at);
  t2.append(line, el('span', '', `Iteration ${shownIteration(job)}${job.state === 'working' || job.state === 'starting' ? ' (running)' : ''}`),
    el('span', '', `${money(job.cost_usd)}${running ? ' so far' : ''} (Claude, est.)`), el('span', '', `${dur(end - Date.parse(job.created_at))} elapsed`), branch);
  // What the ticket waits for, who waits for it, and a cycle it is part of.
  t2.append(...dependencyLines(keyOf(job), dependencyGraph(), 'span').lines);
  keepFocus(byId('jhead'), () => byId('jhead').replaceChildren(backButton, t1, tools, t2, ...progressBlock(job, nowLine(job).what, false)));
}

// The job has its MR text (written at Clean): the Merge request screen applies.
const mrAvailable = (): boolean => shownDetail()?.mr === true;

// ---------- The job's detail and its actions ----------

function renderDetail(detail: JobDetail): void {
  state.detail = detail;
  renderHead();
  // Changes reads its index again when the job's iteration or state moved; the screen stays as it
  // is until the new index arrives.
  if (ui.screen === 'changes') {
    if (byId('scrChanges').children.length === 0) {
      renderChanges();
    } else {
      cxIndex();
    }
  } else if (ui.screen === 'mr') {
    showMr();
  }
  renderComposer();
  refreshStop();
  // Approve… on a Your turn card opens its confirmation once the job is shown, and a card's button
  // its stop or its message box.
  openWantedConfirm();
  applyWantedFocus();
}

// The job waits for the user after a failed Claude review: Retry review runs it again.
const reviewFailed = (job: JobRow): boolean => job.stop_code === 'review_failed';
// Retry applies to the job's stop, as the server says: the job's own availability,
// without the page's pending and unresolved layer.
const retryOn = (job: JobRow): boolean => job.availability?.retry === '';

const preparationKnown = (job: JobRow): boolean => job.state === 'preparing_mr' || state.pending.has(pendingId('approve', keyOf(job)));

// Why an action is unavailable for the job, or '' when the page lets it through. Guidance only:
// the factory's own guards decide, and their refusal is shown as it comes.
function availability(action: string, job: JobRow | null): string {
  if (job === null) {
    return 'the job is loading.';
  }
  // Review the MR and push only opens the Merge request screen.
  if (action === 'review-mr') {
    return mrAvailable() ? '' : 'no MR text yet: written at Clean.';
  }
  if (state.pending.has(pendingId(action, keyOf(job)))) {
    // Every action run() posts has its reason; the fallback keeps any other one off too.
    return PENDING_REASONS[action] ?? 'its request is out; waiting for its outcome.';
  }
  const unresolved = state.unresolved.get(keyOf(job));
  // Abort stays for a preparation known to run: it is the only way to stop it.
  if (unresolved !== undefined && !(action === 'abort' && preparationKnown(job))) {
    return unresolved.failed
      ? "the last action's outcome is unknown and the current state could not be loaded."
      : "the last action's outcome is unknown; waiting for the current state.";
  }
  // The job's own rules are the server's (factory/src/stops.ts).
  const given = job.availability?.[action];
  return typeof given === 'string' ? given : "the job's actions are not known yet.";
}

// A job paused or parked on a usage limit during the Implementer's turn: its
// Resume takes the message.
const pausedTurn = (job: JobRow): boolean => job.availability?.resume === '' && job.paused?.from === 'working';

// The outcome line. On a handed-over job's panel it has a × to dismiss it, and an outcome
// from before the hand-over is a muted note "Earlier, at …" with Dismiss, never a current line.
function renderOutcome(outcome: Outcome | null): void {
  const node = byId('action-status');
  if (outcome === null) {
    node.className = 'status';
    node.replaceChildren();
    return;
  }
  // The link too is inert text, to copy; nothing on this page is clickable data.
  const text = typeof outcome.link === 'string' ? `${outcome.text} ${outcome.link}` : outcome.text;
  const job = state.detail !== null && keyOf(state.detail.job) === state.key ? state.detail.job : null;
  if (job?.state !== 'handed_over') {
    node.className = `status ${outcome.level}`;
    node.replaceChildren(document.createTextNode(text));
    return;
  }
  const handedAt = Date.parse(job.handover?.at ?? '');
  if (typeof outcome.at === 'string' && Date.parse(outcome.at) < handedAt) {
    node.className = 'status earlier';
    node.replaceChildren(el('span', 'muted', `Earlier, at ${clock(outcome.at)} (before the hand-over): ${text}`), button('btn small', 'Dismiss', { dismiss: '' }));
    return;
  }
  node.className = `status ${outcome.level} dismissable`;
  const close = button('ho-x', '×', { dismiss: '' });
  close.setAttribute('aria-label', 'Dismiss');
  close.setAttribute('title', 'Dismiss');
  node.replaceChildren(el('span', '', text), close);
}

// Dismissing the outcome of the shown job (the hand-over panel's × or Dismiss): it leaves the
// page's memory, so it does not come back while the page is open.
function dismissOutcome(): void {
  if (state.key !== null) {
    state.outcomes.delete(state.key);
  }
  renderOutcome(null);
}

// The outcome of a job, stamped with when it was set (one from before a hand-over is not current).
function setOutcome(key: string, outcome: Outcome | null): void {
  if (outcome !== null) {
    outcome.at = new Date().toISOString();
  }
  state.outcomes.set(key, outcome);
  if (key === state.key) {
    renderOutcome(outcome);
  }
}

// The result of an action, as web/types.d.ts declares it; {} for anything but an object.
const actionResult = (result: unknown): ActionResult => (result !== null && typeof result === 'object' ? (result as ActionResult) : {});

// The outcome of a completed call, as the factory reported it: HTTP 200 is not success.
function describeOutcome(action: string, result: unknown): Outcome {
  const data = actionResult(result);
  const detail = data.error ? `${data.error.code}: ${data.error.message}` : '';
  if (action === 'archive') {
    return { level: 'ok', text: `Archived: the job left the list (its history is in ${data.archived ?? 'the state directory'}); the branch ${data.branch ?? ''} is untouched.` };
  }
  if (action === 'approve') {
    if (data.state === 'pushed') {
      const text = `Pushed ${data.branch}.${data.title ? ` ${data.title}` : ''}${typeof data.message === 'string' ? ` ${data.message}` : ''}`;
      return typeof data.link === 'string'
        ? { level: 'ok', text: `${text} Merge request:`, link: data.link }
        : { level: 'ok', text: `${text} No merge request link: the origin URL could not be parsed. Open the merge request for branch ${data.branch} by hand.` };
    }
    if (data.state === 'needs_human' || (data.state === 'handed_over' && data.error)) {
      return { level: 'error', text: `Not pushed: the push failed (${detail || 'no details'}). Fix it, then approve again.` };
    }
    return { level: 'warn', text: `Not pushed: the job is ${data.state}${detail ? ` (${detail})` : ''}.` };
  }
  if (action === 'handover') {
    return { level: 'ok', text: `Handed over: ${data.branch} is checked out in your checkout with the job's changes as Local Changes and the commit message prefilled.` };
  }
  if (action === 'takeback') {
    return { level: 'ok', text: `Taken back: your checkout is back where it was; ${data.branch} waits for you to approve (state ${data.state}).` };
  }
  if (action === 'handed-done') {
    return { level: 'ok', text: `Pushed by you: ${data.branch} is on origin${typeof data.commit === 'string' ? ` at ${data.commit.slice(0, 12)}` : ''}; the job is ${data.state}.` };
  }
  if (action === 'merged-archive') {
    return { level: 'ok', text: `Merged and archived: the job left the board (its history is in ${data.archived ?? 'the state directory'}); the branch ${data.branch ?? ''} is untouched.` };
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
    if (data.state === 'needs_human' || (data.state === 'handed_over' && data.error)) {
      return { level: 'error', text: `Not pushed: the push failed (${detail || 'no details'}). Fix it, then try again.` };
    }
    return { level: 'warn', text: `No merge request: the job is ${data.state}${detail ? ` (${detail})` : ''}.` };
  }
  if (action === 'mr-merge') {
    const commit = typeof data.mr?.merge_commit === 'string' ? ` (merge commit ${data.mr.merge_commit.slice(0, 12)})` : '';
    return { level: 'ok', text: `Merged merge request #${data.mr?.number}${commit}.` };
  }
  if (action === 'mr-status') {
    const text = [mrFoundText(data), data.status !== null && typeof data.status === 'object' ? mrStatusText(data.status) : ''].filter((part) => part !== '').join(' ');
    return text !== '' ? { level: 'ok', text } : { level: 'warn', text: 'The host said nothing of the merge request.' };
  }
  if (action === 'review') {
    return { level: 'ok', text: `The review of iteration ${data.iteration} runs again (state ${data.state}).` };
  }
  if (action === 'suggestion-dismiss') {
    return data.dismissed === true ? { level: 'ok', text: 'Dismissed the planner\'s suggestion.' } : { level: 'info', text: 'There was no suggestion of the planner to dismiss.' };
  }
  if (action === 'retry') {
    return { level: 'ok', text: `MR preparation runs again (state ${data.state}).` };
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

// The short words of a success, for the toast of the job page.
const DONE_TEXT: Readonly<Record<string, string>> = {
  say: 'Message sent', approve: 'Pushed', abort: 'Aborted', review: 'The review runs again', accept: 'The MR is being prepared', settle: 'Settled',
  simplify: 'Simplify sent to the Implementer', archive: 'Archived', 'mr-create': 'Merge request opened', 'mr-merge': 'Merged', 'mr-status': 'MR status read',
  pause: 'Paused', resume: 'Resumed', restart: 'Restarted', handover: 'Handed over to your checkout', takeback: 'Taken back', 'handed-done': 'Your push is recorded',
  'merged-archive': 'Merged and archived',
  'suggestion-send': 'Suggestion sent', 'suggestion-dismiss': 'Suggestion dismissed',
};

// The jobs of an api/jobs answer or a jobs event; its remote says which port the page uses.
function jobsOf(text: string): JobRow[] {
  const data = payload<JobsPayload>(text);
  if (typeof data.remote === 'boolean') {
    state.remote = data.remote;
  }
  return data.jobs;
}

// What the dialog says of each action that asks for the job's ticket from another device.
// Which actions ask is the server's (the detail's confirm_actions, the confirm routes of
// POST_ROUTES in src/dashboard-routes.ts).
const REMOTE_CONFIRM_TEXT: Readonly<Record<string, string>> = {
  approve: 'it pushes the branch to origin.',
  retry: 'it runs the MR preparation again, and pushes again after a failed push.',
  'mr-create': 'it opens the merge request on the Git host, pushing the branch first when it is not pushed yet.',
  'mr-merge': 'it merges the merge request on the Git host.',
  'merged-archive': 'it marks the job merged and archives it without asking origin.',
  archive: 'it removes the job\'s worktree and the job leaves the board; the branch and its commits stay.',
};

// The ticket dialog, made on first use: a title, the action's text, the input and two buttons.
function ticketDialog(): HTMLDialogElement {
  const found = $('remote-confirm');
  if (found !== null) {
    // Made below, as a dialog.
    if (!isTag(found, 'dialog')) {
      throw new Error("The page's element #remote-confirm is not a <dialog>");
    }
    return found;
  }
  // A native modal dialog, styled by the browser: app.css's .confirm would display it while closed.
  const dialog = el('dialog');
  dialog.id = 'remote-confirm';
  dialog.hidden = true;
  dialog.setAttribute('aria-labelledby', 'remote-confirm-title');
  dialog.setAttribute('aria-describedby', 'remote-confirm-text');
  const title = el('h4');
  title.id = 'remote-confirm-title';
  const text = el('p');
  text.id = 'remote-confirm-text';
  const input = el('input');
  input.id = 'remote-confirm-input';
  input.type = 'text';
  for (const [name, value] of [['autocomplete', 'off'], ['autocapitalize', 'off'], ['spellcheck', 'false'], ['aria-labelledby', 'remote-confirm-title']] as const) {
    input.setAttribute(name, value);
  }
  const ok = el('button', 'btn btn-primary');
  ok.id = 'remote-confirm-ok';
  ok.type = 'button';
  const cancel = el('button', 'btn', 'Cancel');
  cancel.id = 'remote-confirm-cancel';
  cancel.type = 'button';
  const row = el('div', 'row');
  row.append(ok, cancel);
  dialog.append(title, text, input, row);
  input.addEventListener('input', () => {
    ok.disabled = state.ticketAsk === null || input.value !== state.ticketAsk.ticket;
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === input) {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (!ok.disabled) {
        settleTicketAsk(true);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopPropagation?.();
      settleTicketAsk(false);
    }
  });
  // The browser's own Escape of a modal dialog.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault?.();
    settleTicketAsk(false);
  });
  ok.addEventListener('click', () => settleTicketAsk(true));
  cancel.addEventListener('click', () => settleTicketAsk(false));
  document.body.append(dialog);
  return dialog;
}

// "Type <ticket> to continue": true once the exact ticket is typed and confirmed, false on Cancel
// (or while another such dialog is open).
function askTicket(action: string, ticket: string): Promise<boolean> {
  if (state.ticketAsk !== null) {
    return Promise.resolve(false);
  }
  const dialog = ticketDialog();
  byId('remote-confirm-title').textContent = `Type ${ticket} to continue`;
  byId('remote-confirm-text').textContent = `${ACTION_LABELS[action]} from another device: ${REMOTE_CONFIRM_TEXT[action]}`;
  const input = byIdAs('remote-confirm-input', 'input');
  input.value = '';
  const ok = byIdAs('remote-confirm-ok', 'button');
  ok.textContent = ACTION_LABELS[action] ?? null;
  ok.disabled = true;
  dialog.hidden = false;
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.open = true;
  }
  input.focus();
  return new Promise((resolve) => {
    state.ticketAsk = { ticket, resolve };
  });
}

// Closes the ticket dialog: true only when confirmed with the exact ticket typed.
function settleTicketAsk(confirmed: boolean): void {
  const ask = state.ticketAsk;
  if (ask === null) {
    return;
  }
  const typed = byIdAs('remote-confirm-input', 'input').value;
  state.ticketAsk = null;
  const dialog = byIdAs('remote-confirm', 'dialog');
  if (typeof dialog.close === 'function') {
    dialog.close();
  } else {
    dialog.open = false;
  }
  dialog.hidden = true;
  ask.resolve(confirmed && typed === ask.ticket);
}

// The actions that ask for the job's ticket from another device: the detail's confirm_actions
// (the same for every job), read from the job's detail when the page has none (a board card's
// Retry); none when that read fails (the server then refuses with confirm_required).
async function confirmActions(key: string): Promise<string[]> {
  let detail = state.detail;
  if (!Array.isArray(detail?.confirm_actions)) {
    try {
      detail = await withinTime(readDetail(key));
    } catch { // the read failed or timed out: none, and the server then refuses with confirm_required
      return [];
    }
  }
  return Array.isArray(detail?.confirm_actions) ? detail.confirm_actions : [];
}

// One request for one job; the result goes to that job only, whatever is selected by then. From
// another device an action of the server's confirm_actions asks for the ticket first.
async function run(action: string, key: string, body: Readonly<Record<string, unknown>>): Promise<void> {
  const id = pendingId(action, key);
  if (state.pending.has(id)) {
    return;
  }
  if (state.remote && (await confirmActions(key)).includes(action)) {
    const ticket = key.slice(key.indexOf('/') + 1);
    if (state.pending.has(id) || !(await askTicket(action, ticket)) || state.pending.has(id)) {
      return;
    }
    body = { ...body, confirm: ticket };
  }
  state.pending.add(id);
  if (!state.unresolved.has(key)) {
    clearDoubt(key);
  }
  // Every action run() posts has its text.
  const waiting: Outcome = { level: 'pending', text: PENDING_TEXT[action] ?? '' };
  setOutcome(key, waiting);
  renderComposer();
  refreshStop();
  renderBoard();
  let outcome: Outcome | undefined;
  let unknownReason: string | undefined;
  try {
    const result = await post(`api/jobs/${jobPath(key)}/${action}`, body);
    outcome = describeOutcome(action, result);
    if (action === 'mr-status') {
      noteMrRead(key, actionResult(result));
    }
    // The sent draft goes; text edited meanwhile stays.
    if ((action === 'say' || action === 'resume') && typeof body.message === 'string' && state.drafts.get(key) === body.message) {
      state.drafts.delete(key);
      if (key === state.key) {
        byIdAs('msg', 'textarea').value = '';
      }
    }
    if (action === 'settle' && typeof body.id === 'string') {
      state.notes.delete(`${key}/${body.id}`);
    }
  } catch (error) {
    if (error instanceof ActionError) {
      outcome = { level: 'error', text: `${error.code}: ${error.message}` };
    } else {
      unknownReason = errorMessage(error);
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
  // The try set it, or its catch did: an ActionError's outcome or the unknown reason.
  if (outcome === undefined) {
    throw new Error(`The outcome of ${action} was not set`);
  }
  setOutcome(key, outcome);
  if (outcome.level === 'ok' && key === ui.job) {
    toast({ level: 'ok', text: DONE_TEXT[action] ?? 'Done' });
  }
  renderComposer();
  refreshStop();
  renderBoard();
  void refreshDetail(key);
}

async function readDetail(key: string): Promise<JobDetail> {
  return payload<JobDetail>(await getText(`api/jobs/${jobPath(key)}`));
}

// A read that never answers must not hold the controls without a way out.
function withinTime<T>(read: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer in time')), READ_TIMEOUT_MS);
    read.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function refreshDetail(key: string): Promise<void> {
  let detail: JobDetail;
  try {
    detail = await readDetail(key);
  } catch { // the detail cannot be read: the page keeps the one it shows
    return;
  }
  if (key === state.key) {
    renderDetail(detail);
  }
}

// The warning of an unknown outcome has its own line: a definite answer never replaces it, and it
// never replaces one. It outlives the hold, until the next action for the job starts.
function showDoubt(key: string, text: string): void {
  state.doubts.set(key, text);
  if (key === state.key) {
    byId('action-doubt').textContent = text;
  }
}

function clearDoubt(key: string): void {
  state.doubts.delete(key);
  if (key === state.key) {
    byId('action-doubt').textContent = '';
  }
}

// The action may have run: the job's controls wait for a state read after this moment. The
// entry's identity is that moment; nothing is ever re-sent.
function markUnknown(key: string, reason: string): void {
  state.unresolved.set(key, { reason, refreshing: false, failed: false });
  void settleUnknown(key);
}

// Reads the job's current state for its unknown outcome: the only thing that lifts the hold. A
// read that an even later unknown outcome overtook decides nothing; that one has its own.
async function settleUnknown(key: string): Promise<void> {
  const entry = state.unresolved.get(key);
  if (entry === undefined || entry.refreshing) {
    return;
  }
  const lead = `The request failed (${entry.reason}). Its outcome is unknown`;
  entry.refreshing = true;
  entry.failed = false;
  showDoubt(key, `${lead}: the state is being refreshed; check it before choosing a next action.`);
  renderComposer();
  refreshStop();
  renderBoard();
  let detail: JobDetail | undefined;
  let failure: unknown;
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
    showDoubt(key, `${lead} and the current state could not be loaded (${errorMessage(failure)}). The controls stay off until it is: use Refresh state, or wait for the page to reconnect. If sf serve restarted, open the new dashboard URL.`);
    renderComposer();
    refreshStop();
    renderBoard();
    return;
  }
  // A read that did not fail gave the detail.
  if (detail === undefined) {
    throw new Error(`The detail of ${key} was not read`);
  }
  state.unresolved.delete(key);
  showDoubt(key, `${lead}: it may have taken effect. The state shown is current; check it and the Stream before choosing a next action.`);
  if (key === state.key) {
    renderDetail(detail);
  } else {
    renderComposer();
  }
  renderBoard();
}

// The confirmations, inline in the composer (the prototype's Abort), each with today's content;
// the action is posted only from its button.
function openConfirm(action: string): void {
  const detail = state.detail;
  const job = detail?.job ?? null;
  if (detail === null || job === null || availability(action, job) !== '' || state.confirm !== null) {
    return;
  }
  const key = keyOf(job);
  state.confirm = { action, key };
  byId('confirm-title').textContent = `${ACTION_LABELS[action]} ${key}?`;
  const host = job.mr_host?.host === 'gitlab' ? 'GitLab' : 'GitHub';
  const mrTitle = typeof detail.mr_title === 'string' ? detail.mr_title : '(the MR text\'s first line)';
  const texts: Readonly<Record<string, string>> = {
    'mr-create': canApprove(job)
      ? `Pushes branch ${job.branch} to origin as Approve does, then opens a merge request on ${host} from ${job.branch} into ${job.base}, titled “${mrTitle}”, with the rest of the MR text as its description.`
      : `Opens a merge request on ${host} from ${job.branch} into ${job.base}, titled “${mrTitle}”, with the rest of the MR text as its description. One already open for the branch is reused.`,
    'mr-merge': hasMr(job)
      ? `Merges merge request #${job.mr.number} (${job.branch}) into ${job.base} on ${host} through its API, as a merge commit. Nothing is pushed or forced; the host refuses a merge request it cannot merge (conflicts, failing required checks, a draft) and says why.`
      : '',
    approve: job.state === 'handed_over'
      ? `Pushes branch ${job.branch} to origin from your checkout: the factory's commit when you did not commit on the branch, else your commits on the job's base. Your uncommitted changes stay in your checkout and are not pushed.`
      : `Pushes branch ${job.branch} to origin: the one commit the factory prepared at Clean, rebased onto ${job.base}. Nothing is committed or rebased now; a tip edited by hand is refused unless pushed as it is.`,
    abort: `Ends the job on branch ${job.branch}: the Implementer session stops and queued messages are dropped. The branch and its worktree stay as they are.`,
    archive: 'Archive the job: its worktree is removed and it leaves the board. The branch and its commits stay.',
    restart: `Starts ${job.ticket} again from its current Task file, as a new job on a fresh worktree and branch from ${job.base}. Thrown away: the Implementer session${job.state === 'paused' || job.state === 'needs_human' ? ' and its queued messages' : ''}, the worktree${typeof job.worktree === 'string' ? ` ${job.worktree}` : ''} with its uncommitted changes (unless kept below) and the branch ${job.branch}, deleted only when it has no commit beyond the base and was never pushed: otherwise nothing is touched and the restart is refused. The job's history is archived as sf reset does.`,
    simplify: `Writes one Fix section “Simplify” with the suggestions below into the Task file; the Implementer applies them and the Claude review and the gate review the result as usual. The suggestions are recorded in the ledger as your choice, so a reviewer cannot ask for them back. It runs once per job.`,
    accept: job.stop_group === 'tests'
      ? `Accepts iteration ${job.iteration} without passing tests (${testsCommand(key)}); the MR text records it under ### Checks.`
      : job.stop_group === 'simplify'
      ? `Skips the simplification: iteration ${job.iteration}, which the reviewers found clean, goes on to MR preparation as it is. The suggestions are listed on the Merge request screen, under the MR text, for a follow-up ticket.`
      : job.stop_group === 'limit'
      ? `Accepts iteration ${job.iteration} at the Fix round limit with its open findings unapplied (listed on the Merge request screen). The factory commits it and rebases it onto ${job.base}, and the branch comes back to you to approve. The override is recorded in the job's history.`
      : !claudeOn(job)
      ? `Accepts iteration ${job.iteration}, which only the Codex gate reviewed, over ${job.error?.code}. The factory commits it and rebases it onto ${job.base}, and the branch comes back to you to approve. ${job.stop_group === 'ledger' ? 'The open findings are not applied; the override' : 'The override'} is recorded in the job's history.`
      : job.stop_group === 'ledger'
      ? `Accepts iteration ${job.iteration} over the ledger's stop (${job.error?.code}). The factory commits it and rebases it onto ${job.base}, and the branch comes back to you to approve. The open findings are not applied; the override is recorded in the job's history.`
      : `Overrides the Codex gate (${job.error?.code}): iteration ${job.iteration} goes on as after a clean gate. The factory commits it and rebases it onto ${job.base}, and the branch comes back to you to approve. The override is recorded in the job's history.`,
  };
  byId('confirm-text').textContent = texts[action] ?? null;
  renderConfirmItems(action === 'simplify' || (action === 'accept' && job.stop_group === 'simplify') ? offeredSuggestions(detail)
    : action === 'accept' ? gateLeftovers(detail) : null);
  byIdAs('discard', 'input').checked = false;
  byIdAs('as-is', 'input').checked = false;
  byId('discard-label').hidden = action !== 'abort';
  byIdAs('keep-files', 'input').checked = false;
  byId('keep-files-label').hidden = action !== 'restart';
  byId('as-is-label').hidden = action !== 'approve';
  byId('confirm').hidden = false;
  renderConfirmButton();
  renderComposer();
  byId('confirm-cancel').focus();
}

// The Codex items Accept and prepare MR goes without, listed in its confirmation (path, problem).
function renderConfirmItems(leftovers: Leftovers | ReturnType<typeof offeredSuggestions> | null): void {
  byId('confirm-items').hidden = leftovers === null;
  if (leftovers === null) {
    byId('confirm-items-list').replaceChildren();
    return;
  }
  if ('suggestions' in leftovers) {
    byId('confirm-items-title').textContent = `Suggestions of the simplification pass (${leftovers.items.length}):`;
    byId('confirm-items-list').replaceChildren(...leftovers.items.map((item) => {
      const entry = el('li');
      entry.append(el('code', '', item.path), document.createTextNode(`: ${item.what} Why: ${item.why} (about ${item.saves_lines} lines)`));
      return entry;
    }));
    return;
  }
  byId('confirm-items-title').textContent = leftovers.limit === true
    ? (leftovers.items.length === 0 ? 'No open finding is left.' : `Open findings that will not be applied (${leftovers.items.length}):`)
    : leftovers.ledger === true
    ? (leftovers.items.length === 0 ? 'No open finding is left in the ledger.' : `Open findings of the ledger that will not be applied (${leftovers.items.length}):`)
    : leftovers.error !== null
    ? `The gate failed, so no Codex item is known: ${leftovers.error}`
    : !leftovers.ran ? 'Codex did not review this iteration (its token budget was used up before it ran), so what it would ask for is not known.'
      : leftovers.items.length === 0 ? 'The gate left no Codex item on this iteration.' : `Codex items that will not be applied (${leftovers.items.length}):`;
  byId('confirm-items-list').replaceChildren(...leftovers.items.map((item) => itemEntry(item, false)));
}

function renderConfirmButton(): void {
  const confirm = state.confirm;
  if (confirm === null) {
    return;
  }
  const discard = confirm.action === 'abort' && byIdAs('discard', 'input').checked;
  const ok = byId('confirm-ok');
  const job = state.detail?.job;
  ok.textContent = confirm.action === 'mr-create' ? 'Create the merge request'
    : confirm.action === 'mr-merge' ? `Merge #${job?.mr?.number} into ${job?.base}`
    : confirm.action === 'simplify' || confirm.action === 'archive' ? ACTION_LABELS[confirm.action]!
    : confirm.action === 'accept' ? (job?.stop_group === 'simplify' ? 'Skip and prepare the MR' : 'Accept and prepare the MR')
    : confirm.action === 'restart' ? (byIdAs('keep-files', 'input').checked ? 'Restart, keep the files' : 'Restart')
    : confirm.action === 'approve' ? (byIdAs('as-is', 'input').checked ? 'Approve: push as it is' : 'Approve: push the branch') : discard ? 'Abort and discard the branch' : 'Abort, keep the worktree';
  ok.className = confirm.action === 'abort' ? 'btn small danger' : 'btn small primary';
}

function closeConfirm(): void {
  state.confirm = null;
  byId('confirm').hidden = true;
  renderConfirmItems(null);
  byIdAs('discard', 'input').checked = false;
  byIdAs('as-is', 'input').checked = false;
  byIdAs('keep-files', 'input').checked = false;
  renderComposer();
}

function submitConfirm(): void {
  const confirm = state.confirm;
  if (confirm === null) {
    return;
  }
  const discard = confirm.action === 'abort' && byIdAs('discard', 'input').checked;
  const asIs = confirm.action === 'approve' && byIdAs('as-is', 'input').checked;
  const keepFiles = confirm.action === 'restart' && byIdAs('keep-files', 'input').checked;
  closeConfirm();
  // The target was captured when the confirmation opened; a selection changed since drops it.
  if (confirm.key !== state.key) {
    return;
  }
  void run(confirm.action, confirm.key, confirm.action === 'abort' ? { discard } : confirm.action === 'restart' ? { keep_files: keepFiles } : asIs ? { as_is: true } : {});
}

// Send, and Tell it to go on ("Go on." for an empty box): the message box's text, once.
function sendSay(goOn = false): void {
  const key = state.key;
  const text = byIdAs('msg', 'textarea').value;
  if (key === null || (text.trim() === '' && !goOn) || availability('say', state.detail?.job ?? null) !== '') {
    return;
  }
  void run('say', key, { message: text.trim() === '' ? 'Go on.' : text });
}

// The composer's actions posted without a dialog: Pause, Retry review, Retry, Refresh MR status and the
// hand-over's at once; Merged — archive on a second click, confirmed in place (armOrRun).
const POSTED_AT_ONCE: readonly string[] = ['pause', 'review', 'retry', 'mr-status', 'handover', 'takeback', 'handed-done', 'merged-archive'];

// A button of the composer (the prototype's act): the ones that ask first (Archive too) open their
// confirmation; Send, Tell it to go on, Resume and POSTED_AT_ONCE post without one.
function act(action: string): void {
  const job = state.detail?.job ?? null;
  if (job === null) {
    return;
  }
  const key = keyOf(job);
  if (action === 'say' || action === 'goon') {
    sendSay(action === 'goon');
  } else if (COMPOSER_ACTS.includes(action)) {
    // The composer's own buttons go to composerAct (composer.js).
    composerAct(action, job);
  } else if (action === 'review-mr') {
    go(key, 'mr');
  } else if (['abort', 'restart', 'approve', 'accept', 'simplify', 'mr-create', 'mr-merge', 'archive'].includes(action)) {
    openConfirm(action);
  } else if (action === 'resume') {
    const message = byIdAs('msg', 'textarea').value;
    if (availability('resume', job) === '') {
      void run('resume', key, pausedTurn(job) && message.trim() !== '' ? { message } : {});
    }
  } else if (POSTED_AT_ONCE.includes(action) && availability(action, job) === '') {
    armOrRun(action, key);
  }
}

// Accept risk or Must fix on a ledger entry of the stop: posted at once, with its note.
function settle(id: string, decision: string): void {
  const job = state.detail?.job ?? null;
  if (job === null || availability('settle', job) !== '') {
    return;
  }
  void run('settle', keyOf(job), { id, decision, note: state.notes.get(noteKey(id)) ?? '' });
}
