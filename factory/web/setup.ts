// setup.js, the dashboard's eighth script (DASHBOARD_SCRIPTS in src/dashboard.ts), built from
// web/setup.ts into dist/web/: the drawer and the setup (workspaces, new ticket, archived,
// ticket actions). A classic script, loaded in order with defer, sharing the page's globals with
// the others. This file has no import or export on purpose: the compiler keeps it a script, so its
// top-level names stay the page's globals.
'use strict';

// The ticket Start or Delete asks about (openTicketConfirm): a ticket of the board or of the planned
// ticket page, or an archived one (the drawer's Delete…, archivedRow), which has no check and no base.
type ConfirmedTicket = (TicketEntry & { archivedRow?: false }) | (ArchivedRow & { archivedRow: true; check?: undefined; base?: undefined });
// A ticket an action names: its workspace and key.
interface TicketKey {
  workspace: string;
  ticket: string;
}

// ---------- The drawer: Workspaces, New ticket, Archived and an archived ticket's Task ----------

// The job opens as its page (#job), a planned ticket as its page (#ticket); the drawer stays
// for the setup panels and an archived ticket's Task.
type DrawerKind = NonNullable<PageState['drawer']>;
const PANELS: Readonly<Record<DrawerKind, string>> = { task: 'task-panel', workspaces: 'workspaces-panel', ticket: 'ticket-panel', archived: 'archived-panel' };

function showDrawer(kind: DrawerKind, kicker: string, title: string): void {
  state.drawer = kind;
  if (kind !== 'task') {
    state.task = null;
  }
  for (const [name, id] of Object.entries(PANELS)) {
    byId(id).hidden = name !== kind;
  }
  byId('drawer-kicker').textContent = kicker;
  byId('drawer-title').textContent = title;
  byId('drawer').hidden = false;
  byId('scrim').hidden = false;
  byId('drawer-close').focus();
}

function hideDrawer(): void {
  state.drawer = null;
  state.task = null;
  byId('drawer').hidden = true;
  byId('scrim').hidden = true;
}

// The drawer's ✕, its scrim and Escape.
function closeDrawer(): void {
  if (state.drawer === null) {
    return;
  }
  hideDrawer();
  renderBoard();
}

// The job page closes: no job is followed any more; drafts and outcomes stay with their jobs.
function leaveJob(): void {
  closeConfirm();
  state.key = null;
  state.detail = null;
  state.wantConfirm = null;
  state.wantFocus = null;
  state.streamLoad = null;
  openStream();
}

function openWantedConfirm(): void {
  const wanted = state.wantConfirm;
  if (wanted === null || state.detail === null || keyOf(state.detail.job) !== wanted.key) {
    return;
  }
  state.wantConfirm = null;
  openConfirm(wanted.action);
}

// An archived ticket's Task text in the drawer, as text: headings bold by a line rule, never HTML
// from the file. A planned ticket opens as its page.
async function openTask(row: ArchivedRow): Promise<void> {
  const key = `${row.workspace}/${row.ticket}`;
  const task = { key };
  showDrawer('task', `${row.workspace} · .software-factory/archive/${row.ticket}.md`, `${row.ticket} · ${row.title}`);
  state.task = task;
  byId('task-body').replaceChildren(document.createTextNode('Loading the Task file…'));
  let text: string;
  try {
    text = await getText(`api/tickets/${jobPath(key)}/task?archived=1`);
  } catch (error) {
    text = `Could not load the Task file: ${errorMessage(error)}`;
  }
  if (state.task === task) {
    byId('task-body').replaceChildren(...renderReport(text));
  }
}

function openWorkspaces(): void {
  showDrawer('workspaces', 'Setup', 'Workspaces');
  renderWorkspaces();
}

function openNewTicket(): void {
  showDrawer('ticket', 'Setup', 'New ticket');
  renderWorkspaces();
}

function openArchived(): void {
  showDrawer('archived', 'Setup', 'Archived tickets');
  renderArchived();
}

// ---------- Setup: workspaces, new ticket, archived, ticket actions ----------

function renderSetup(): void {
  renderWorkspaces();
  renderArchived();
  renderBoard();
  renderTicket();
}

function renderWorkspaces(): void {
  const rows = state.workspaces ?? [];
  byId('no-workspaces').hidden = state.workspaces === null || rows.length > 0;
  if (state.wsEdit !== null && !rows.some((row) => row.name === state.wsEdit)) {
    state.wsEdit = null;
    state.wsEditForm = null;
  }
  byId('workspace-list').replaceChildren(...rows.map((row) => {
    const item = el('li');
    if (state.wsEdit === row.name && state.wsEditForm !== null) {
      // The Edit form, kept across redraws so what is typed stays.
      item.append(state.wsEditForm);
      return item;
    }
    const name = el('div', 'ws-name');
    name.append(wsDot(row.name), document.createTextNode(row.name));
    // Its app, when it is not the workspace itself.
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
    if (typeof row.label === 'string' && row.label !== '') {
      item.append(el('div', 'ws-label hint', `Label on its cards: ${row.label}`));
    }
    // The workspace's own hand-over setting, or SF_HANDOFF's.
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
    line.append(...(row.vision === true ? [tabLink('btn btn-sm', 'Vision ↗', `vision/${encodeURIComponent(row.name)}`)] : []), edit, remove, el('span', 'hint', row.liveJobs > 0 ? `${row.liveJobs} live job${row.liveJobs === 1 ? '' : 's'}: finish or abort them first.` : 'The registration only; nothing on disk changes.'));
    item.append(line);
    return item;
  }));
  // The existing apps, the App field's suggestions.
  const apps = [...new Set(rows.map((row) => row.app).filter((app): app is string => typeof app === 'string' && app !== ''))].sort();
  byId('workspace-apps').replaceChildren(...apps.map((app) => {
    const option = el('option');
    option.value = app;
    return option;
  }));
  // Default's words: what SF_HANDOFF says now.
  const handoffDefault = handoffDefaultText();
  for (const select of [byId('workspace-handoff'), state.wsEditForm?.querySelector('[data-wsf="handoff"]')]) {
    const first = select?.children?.[0];
    if (first !== undefined && first !== null) {
      first.textContent = handoffDefault;
    }
  }
  renderDigestSettings();
  // The Digest page's schedule line reads the same settings.
  renderDigest();
  // The workspace choice of the form keeps its value while the options are replaced; else the one
  // the last ticket was created in (in this browser), else the board's filter, else the first.
  const select = byIdAs('ticket-workspace', 'select');
  const chosen = [select.value, store.get(TICKET_WORKSPACE_KEY), state.filter].find((name) => rows.some((row) => row.name === name)) ?? rows[0]?.name ?? '';
  select.replaceChildren(...rows.map((row) => {
    const option = el('option', '', row.name);
    option.value = row.name;
    return option;
  }));
  select.value = chosen;
  select.disabled = rows.length === 0;
  byIdAs('ticket-create', 'button').disabled = rows.length === 0 || state.setupPending.has('ticket') || state.setupPending.has('ticket-images');
  byIdAs('ticket-plan', 'button').disabled = byIdAs('ticket-create', 'button').disabled;
}

function renderArchived(): void {
  const rows = state.archived ?? [];
  byId('no-archived').hidden = rows.length > 0;
  byId('archived-list').replaceChildren(...rows.map((row) => {
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
function setSetupStatus(id: string, outcome: Outcome | null): void {
  if (id === 'toast') {
    toast(outcome);
    return;
  }
  const node = byId(id);
  node.className = outcome === null ? 'status' : `status ${outcome.level}`;
  node.textContent = outcome === null ? '' : outcome.text;
}

// One request for one form or ticket; the page sends nothing twice.
async function setupRequest(what: string, path: string, body: unknown, statusId: string, describe: (result: unknown) => Outcome): Promise<unknown> {
  if (state.setupPending.has(what)) {
    return undefined;
  }
  state.setupPending.add(what);
  setSetupStatus(statusId, { level: 'pending', text: 'Sending…' });
  renderSetup();
  let result: unknown;
  let outcome: Outcome;
  try {
    result = await post(path, body);
    outcome = describe(result);
  } catch (error) {
    outcome = error instanceof ActionError
      ? { level: 'error', text: `${error.code}: ${error.message}` }
      : { level: 'error', text: `The request failed (${errorMessage(error)}); it may have taken effect. The board refreshes on the next change; reload the page to see the current state.` };
  }
  state.setupPending.delete(what);
  setSetupStatus(statusId, outcome);
  renderSetup();
  return outcome.level === 'ok' ? result : undefined;
}

// "Default (now: yes, from SF_HANDOFF)": the hand-over field's first option.
function handoffDefaultText(): string {
  const now = state.wsSettings.handoff_default;
  return now === 'checkout' || now === 'off' ? `Default (now: ${now === 'checkout' ? 'yes' : 'no'}, from SF_HANDOFF)` : 'Default (from SF_HANDOFF)';
}

// The colour the workspace sets itself, or 'auto': the row's colour when it is not the one its name
// picks (the sum of the name's UTF-16 code units mod the palette's size, src/registry.ts).
function ownColor(row: WorkspaceRow): string {
  let sum = 0;
  for (let index = 0; index < row.name.length; index += 1) {
    sum += row.name.charCodeAt(index);
  }
  return WS_COLORS.includes(row.color) && row.color !== WS_COLORS[sum % WS_COLORS.length] ? row.color : 'auto';
}

// A field of the Edit form: its label, the control and the help text under it, each on its own line.
function wsField(label: string, control: Field, help: string): HTMLElement {
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

function wsSelect(key: string, options: ReadonlyArray<readonly [string, string]>, value: string): HTMLSelectElement {
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

// The copy of src/registry.ts MAX_LABEL_CHARS: the Label field's maxLength.
const WS_LABEL_CHARS = 24;

// Edit: the card becomes the form: the checkout's path, Description (its placeholder the
// repository's own description), App (the existing apps as suggestions), Hand-over, Colour, Label
// (its placeholder the name) and the two digest switches. Save posts every field; Cancel changes
// nothing. The name stays.
function openWorkspaceEdit(row: WorkspaceRow): void {
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
  const color = wsSelect('color', [['auto', 'Automatic (from the name)'], ...WS_COLORS.map((name): [string, string] => [name, name])], ownColor(row));
  const label = el('input');
  label.dataset.wsf = 'label';
  label.type = 'text';
  label.value = row.label ?? '';
  label.placeholder = row.name;
  label.maxLength = WS_LABEL_CHARS;
  label.setAttribute('autocomplete', 'off');
  label.setAttribute('spellcheck', 'false');
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
    wsField('Label on its cards', label, `Optional: what its cards show instead of the name, at most ${WS_LABEL_CHARS} characters. Empty: the name.`),
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

function closeWorkspaceEdit(): void {
  state.wsEdit = null;
  state.wsEditForm = null;
  renderWorkspaces();
}

async function submitWorkspaceEdit(name: string): Promise<void> {
  const form = state.wsEditForm;
  if (form === null || state.wsEdit !== name) {
    return;
  }
  // A part of the Edit form, as openWorkspaceEdit made it: a missing one or one of another tag is a
  // broken form and throws.
  const field = <K extends keyof HTMLElementTagNameMap>(key: string, tag: K): HTMLElementTagNameMap[K] => {
    const node = form.querySelector(`[data-wsf="${key}"]`);
    if (!isTag(node, tag)) {
      throw new Error(`The Edit form has no <${tag}> ${key}`);
    }
    return node;
  };
  const status = field('status', 'div');
  const path = field('path', 'input').value.trim();
  if (path === '') {
    status.className = 'status error';
    status.textContent = 'The path of the local checkout is needed.';
    return;
  }
  const body = {
    path, description: field('description', 'textarea').value, app: field('app', 'input').value, handoff: field('handoff', 'select').value, color: field('color', 'select').value,
    label: field('label', 'input').value,
    digest: { track: field('track', 'input').checked === true, my_work: field('my_work', 'input').checked === true },
  };
  if (state.setupPending.has('workspace')) {
    return;
  }
  state.setupPending.add('workspace');
  field('save', 'button').disabled = true;
  status.className = 'status pending';
  status.textContent = 'Saving…';
  let outcome: string | null = null;
  try {
    await post(`api/workspaces/${encodeURIComponent(name)}/edit`, body);
  } catch (error) {
    outcome = error instanceof ActionError ? `${error.code}: ${error.message}` : `The request failed (${errorMessage(error)}); it may have taken effect. Reload the page to see the current state.`;
  }
  state.setupPending.delete('workspace');
  field('save', 'button').disabled = false;
  if (outcome === null) {
    closeWorkspaceEdit();
    setSetupStatus('workspace-status', { level: 'ok', text: `Saved ${name}.` });
    return;
  }
  status.className = 'status error';
  status.textContent = outcome;
  renderSetup();
}

// The Morning digest section: the stored settings, unless values are typed and not saved.
function renderDigestSettings(): void {
  const settings = state.wsSettings.digest;
  if (settings === null || state.digestDirty || state.setupPending.has('digest')) {
    return;
  }
  byIdAs('digest-at', 'input').value = (settings.times ?? []).join(', ');
  byIdAs('digest-weekdays', 'input').checked = settings.weekdays_only === true;
  byIdAs('digest-language', 'input').value = settings.language;
}

async function submitDigestSettings(): Promise<void> {
  const times = digestTimesOf(byIdAs('digest-at', 'input').value);
  const language = byIdAs('digest-language', 'input').value.trim();
  if (times.length === 0 || times.some((time) => !/^\d\d:\d\d$/.test(time)) || language === '') {
    setSetupStatus('digest-status', { level: 'error', text: 'At least one time (HH:MM, comma-separated) and a language are needed.' });
    return;
  }
  const result = await setupRequest('digest', 'api/digest-settings', { times, weekdays_only: byIdAs('digest-weekdays', 'input').checked === true, language }, 'digest-status', (data) => {
    const saved = fieldOf(data, 'times');
    return { level: 'ok', text: `Saved: ${Array.isArray(saved) ? saved.join(', ') : ''}${fieldOf(data, 'weekdays_only') ? ' on weekdays' : ' every day'}, in ${fieldOf(data, 'language')}. sf serve uses it at its next check.` };
  });
  if (result !== undefined) {
    state.digestDirty = false;
  }
}

async function submitWorkspace(): Promise<void> {
  const name = byIdAs('workspace-name', 'input').value.trim();
  const path = byIdAs('workspace-path', 'input').value.trim();
  // The workspace's own hand-over setting; empty: SF_HANDOFF applies. Its colour on the
  // board; empty: the server picks one by its name. Its description, app and digest
  // switches; empty or off: none, its name, off.
  const handoff = byIdAs('workspace-handoff', 'select').value;
  const color = byIdAs('workspace-color', 'select').value;
  const description = byIdAs('workspace-description', 'textarea').value.trim();
  const app = byIdAs('workspace-app', 'input').value.trim();
  const track = byIdAs('workspace-track', 'input').checked === true;
  const myWork = byIdAs('workspace-mywork', 'input').checked === true;
  if (name === '' || path === '') {
    setSetupStatus('workspace-status', { level: 'error', text: 'A name and the path of the local checkout are needed.' });
    return;
  }
  const body = {
    name, path, ...(handoff !== '' ? { handoff } : {}), ...(color !== '' ? { color } : {}), ...(description !== '' ? { description } : {}), ...(app !== '' ? { app } : {}),
    ...(track || myWork ? { digest: { track, my_work: myWork } } : {}),
  };
  const result = await setupRequest('workspace', 'api/workspaces', body, 'workspace-status', (data) =>
    ({ level: 'ok', text: `Registered ${fieldOf(data, 'name')} (${fieldOf(data, 'path')}). Next: New ticket.` }));
  if (result !== undefined) {
    for (const field of [byIdAs('workspace-name', 'input'), byIdAs('workspace-path', 'input'), byIdAs('workspace-handoff', 'select'), byIdAs('workspace-color', 'select'), byIdAs('workspace-description', 'textarea'), byIdAs('workspace-app', 'input')]) {
      field.value = '';
    }
    byIdAs('workspace-track', 'input').checked = false;
    byIdAs('workspace-mywork', 'input').checked = false;
  }
}

async function removeWorkspace(name: string): Promise<void> {
  await setupRequest('workspace', `api/workspaces/${encodeURIComponent(name)}/remove`, {}, 'workspace-status', (data) =>
    ({ level: 'ok', text: `Removed ${fieldOf(data, 'removed')} from the registry; the checkout and its files are untouched.` }));
}

// plan: Create & plan, which then opens the planning conversation (main.ts) and the ticket's page.
async function submitTicket(plan = false): Promise<void> {
  const workspace = byIdAs('ticket-workspace', 'select').value;
  const ticket = byIdAs('ticket-key', 'input').value.trim();
  const title = byIdAs('ticket-title', 'input').value.trim();
  const request = byIdAs('ticket-request', 'textarea').value;
  if (workspace === '' || ticket === '' || title === '' || request.trim() === '') {
    setSetupStatus('ticket-status', { level: 'error', text: 'The workspace, the ticket key, the title and the request are all needed.' });
    return;
  }
  if (state.setupPending.has('ticket') || state.setupPending.has('ticket-images')) {
    return;
  }
  const submission = newTicketSubmission();
  // Before any wait: a browser blocks a tab opened later. Every failure closes it.
  const tab = plan ? openPlanningTab() : undefined;
  if (await newImagesSettled()) {
    tab?.close();
    return;
  }
  const describe = (data: unknown): Outcome => ({ level: 'ok', text: `Ticket created: ${fieldOf(data, 'path')} in ${fieldOf(data, 'workspace')} (base ${fieldOf(data, 'base')}), an empty skeleton in the Queue. Next: a click on its card opens the conversation; your words are its first message.` });
  // The images go with this ticket as they are now; one pasted while it is being created stays for
  // the next ticket (Fix 4). The Context owner is the form's choice, kept for the next ticket.
  const sending = snapshotNewImages();
  const owner = byIdAs('owner-claude', 'input').checked ? 'claude_code' : 'chatgpt';
  const result = await setupRequest('ticket', 'api/tickets', { workspace, ticket, title, request, owner }, 'ticket-status', describe);
  if (result === undefined) {
    releaseNewImages();
    tab?.close();
    return;
  }
  // Created: the dialog closes and the new ticket's card is highlighted (a click on it opens its
  // page); a failure keeps the dialog open with the error and the input. Then its images go up; one
  // that fails leaves the ticket created, and the form stays open saying which and why. Its
  // workspace is the form's next default.
  store.set(TICKET_WORKSPACE_KEY, workspace);
  byIdAs('ticket-key', 'input').value = '';
  byIdAs('ticket-title', 'input').value = '';
  byIdAs('ticket-request', 'textarea').value = '';
  const key = `${fieldOf(result, 'workspace') ?? workspace}/${fieldOf(result, 'ticket') ?? ticket}`;
  state.highlight = key;
  state.highlightShown = false;
  let uploaded: { count: number; failed: string[] } = { count: 0, failed: [] };
  if (sending.length > 0) {
    state.setupPending.add('ticket-images');
    setSetupStatus('ticket-status', { level: 'pending', text: `Ticket created; attaching ${counted(sending.length, 'image')}…` });
    renderSetup();
    const done = await uploadNewImages(key, sending);
    uploaded = done;
    state.setupPending.delete('ticket-images');
    // Only the images sent leave the form; one pasted meanwhile stays for the next ticket.
    for (const image of done.sent) {
      URL.revokeObjectURL(image.url);
    }
    state.newImages = state.newImages.filter((image) => !done.sent.includes(image));
    renderSetup();
  }
  releaseNewImages();
  // A newer submission may have the form by now (Create & plan's read is a wait): see finishTicketForm.
  const note = tab === undefined ? '' : await pointPlanningTab(tab, key);
  // Create & plan with Claude Code: the ticket's planner session starts now (planner.js); its page shows it.
  if (plan && owner === 'claude_code') {
    void tkPlannerStart(key);
  }
  if (uploaded.failed.length > 0) {
    setSetupStatus(submission === state.ticketSubmits ? 'ticket-status' : 'toast', { level: 'error', text: `Ticket created: ${fieldOf(result, 'path')} in ${fieldOf(result, 'workspace') ?? workspace}. Not attached: ${uploaded.failed.join('; ')}. Add ${uploaded.failed.length === 1 ? 'it' : 'them'} on the ticket's page: paste or drop on its Images card.${note}` });
    renderBoard();
    return;
  }
  const outcome = describe(result);
  toast({ ...outcome, text: `${outcome.text}${uploaded.count > 0 ? ` ${counted(uploaded.count, 'image')} attached.` : ''}${note}` });
  finishTicketForm(submission, plan ? key : null);
}

// Archive, restore or delete one ticket; one request per ticket at a time, the outcome in the
// board's status line.
async function ticketAction(action: 'archive' | 'restore' | 'delete', row: TicketKey): Promise<void> {
  const key = `${row.workspace}/${row.ticket}`;
  const id = `ticket:${key}`;
  if (state.setupPending.has(id)) {
    return;
  }
  const deletedOf = (data: unknown): string => {
    const deleted = fieldOf(data, 'deleted');
    return Array.isArray(deleted) ? deleted.join(', ') : '';
  };
  const texts: Readonly<Record<typeof action, (data: unknown) => string>> = {
    archive: (data) => `Archived ${key}: ${fieldOf(data, 'path')}.${fieldOf(data, 'jobArchived') ? ' Its finished job left the board.' : ''}`,
    restore: (data) => `Restored ${key}: ${fieldOf(data, 'path')}.`,
    delete: (data) => `Deleted ${key}: ${deletedOf(data)}.${fieldOf(data, 'jobArchived') ? ' Its finished job left the board.' : ''}`,
  };
  await setupRequest(id, `api/tickets/${jobPath(key)}/${action}`, {}, 'toast', (data) => ({ level: 'ok', text: texts[action](data ?? {}) }));
}

// Start, Delete and End (a ticket's planner session) ask first: Start names the workspace, the
// ticket and the base branch; Delete cannot be undone; End stops Claude Code even in the middle of
// an answer. extra: what the planned ticket page adds to Start's text (what it waits for).
function openTicketConfirm(action: 'start' | 'delete' | 'planner-stop', row: ConfirmedTicket, extra = ''): void {
  const key = `${row.workspace}/${row.ticket}`;
  if (state.ticketConfirm !== null) {
    return;
  }
  state.ticketConfirm = { action, key, row };
  if (action === 'start') {
    byId('ticket-confirm-title').textContent = `Start ${row.ticket} in ${row.workspace}?`;
    // The Task check only advises: its note is part of the text, Start stays on.
    const note = typeof row.check?.start_note === 'string' ? ` Task check: ${row.check.start_note}.` : '';
    byId('ticket-confirm-text').textContent = `Starts a job on .software-factory/${row.ticket}.md of workspace ${row.workspace}: a new branch from ${row.base} in its own worktree, where the Implementer runs iteration 1. Claude reviews it, the Codex gate checks it, and the branch comes back to you to approve.${note}${extra}`;
    byId('ticket-ok').textContent = 'Start the job';
    byId('ticket-ok').className = 'btn btn-primary';
  } else if (action === 'planner-stop') {
    byId('ticket-confirm-title').textContent = `End the planner of ${row.ticket}?`;
    byId('ticket-confirm-text').textContent = `Ends the Claude Code session that plans ${row.ticket} in the planning copy of ${row.workspace}, even in the middle of an answer. What it already wrote, such as the Task file, stays; Start the planner then begins a new session.`;
    byId('ticket-ok').textContent = 'End the session';
    byId('ticket-ok').className = 'btn btn-danger';
  } else {
    byId('ticket-confirm-title').textContent = `Delete ${key}?`;
    byId('ticket-confirm-text').textContent = `Deletes .software-factory/${row.ticket}.md and its MR text${row.archivedRow ? ' from the archive' : ''}. Cannot be undone; Archive keeps the file instead. A finished job of the ticket leaves the board (its history stays in the state directory).`;
    byId('ticket-ok').textContent = 'Delete the ticket';
    byId('ticket-ok').className = 'btn btn-danger';
  }
  byId('ticket-confirm').hidden = false;
  renderBoard();
  renderArchived();
  renderTicket();
  byId('ticket-cancel').focus();
}

function closeTicketConfirm(): void {
  state.ticketConfirm = null;
  byId('ticket-confirm').hidden = true;
  renderBoard();
  renderArchived();
  renderTicket();
}

async function submitTicketConfirm(): Promise<void> {
  const confirm = state.ticketConfirm;
  if (confirm === null) {
    return;
  }
  closeTicketConfirm();
  if (confirm.action === 'start') {
    await startTicket(confirm.row);
  } else if (confirm.action === 'planner-stop') {
    await tkPlannerStop(confirm.key);
  } else {
    await ticketAction('delete', confirm.row);
  }
}

// One start per confirmation, never re-sent. A refusal is shown as it comes; an answer that does
// not settle the outcome holds Start for the ticket until the board is read again.
async function startTicket(row: TicketKey): Promise<void> {
  const key = `${row.workspace}/${row.ticket}`;
  const id = `ticket:${key}`;
  if (state.setupPending.has(id) || state.startHolds.has(key)) {
    return;
  }
  state.setupPending.add(id);
  setSetupStatus('toast', { level: 'pending', text: `Starting ${key}: creating the branch and its worktree…` });
  renderBoard();
  renderTicket();
  let outcome: Outcome | undefined;
  let unknown: string | undefined;
  // Started from its planned ticket page: the page goes to the new job's Stream, whether
  // the stream brings the job before or after this answer.
  if (ui.screen === 'ticket' && ui.ticket === key) {
    state.goAfterStart = key;
  }
  try {
    const result = await post(`api/tickets/${jobPath(key)}/start`, {});
    outcome = { level: 'ok', text: `Started ${key}: branch ${fieldOf(result, 'branch')}, ${fieldOf(result, 'state')}. The Implementer runs iteration 1.` };
  } catch (error) {
    if (error instanceof ActionError) {
      outcome = { level: 'error', text: `${error.code}: ${error.message}` };
    } else {
      unknown = errorMessage(error);
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
  // Set by now: the request answered, or was refused.
  setSetupStatus('toast', outcome ?? null);
  renderBoard();
  renderTicket();
  goToStarted();
}

// The start may have created the job: Start stays off for the ticket until api/jobs is read
// after this moment (or, when that read fails, until the stream's next jobs event); the page
// sends nothing by itself.
async function holdStart(key: string, reason: string): Promise<void> {
  const hold = { reason, failed: false };
  state.startHolds.set(key, hold);
  const lead = `The start of ${key} failed (${reason}). Its outcome is unknown: the job may have started`;
  setSetupStatus('toast', { level: 'error', text: `${lead}; the board is being read again.` });
  renderBoard();
  let jobs: JobRow[];
  try {
    jobs = jobsOf(await withinTime(getText('api/jobs')));
  } catch (error) {
    if (state.startHolds.get(key) === hold) {
      hold.failed = true;
      setSetupStatus('toast', { level: 'error', text: `${lead}, and the board could not be read (${errorMessage(error)}). Start stays off for ${key} until the page reconnects; check the board before starting again.` });
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
