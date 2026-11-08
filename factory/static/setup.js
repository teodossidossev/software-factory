// setup.js, the dashboard's eighth script (DASHBOARD_SCRIPTS in src/dashboard.ts): the drawer and
// the setup (workspaces, new ticket, archived, ticket actions). A classic script, loaded in order
// with defer, sharing the page's globals with the others.
'use strict';

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
