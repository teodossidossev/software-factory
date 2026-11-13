// skills.js, the dashboard's script after setup.js (DASHBOARD_SCRIPTS in src/dashboard.ts), built from
// web/skills.ts into dist/web/: the Skills page (#skills), a full page like the Stats page. One row
// per installed skill (GET api/skills) with a checkbox per agent role; a click sends the role's new
// list at once (PUT api/skills/roles/<role>), every box disabled while it is sent; a refusal
// or a network error puts the box back, shows the message next to the table and reads the list
// again. The last column is the coordinator's, the Claude Code session in the factory's own checkout:
// its list is the skills that are on in Claude Code's skillOverrides there (PUT
// api/skills/roles/coordinator sends it the same way); a name-only or user-invocable-only skill is an
// indeterminate box with the value in its title, which a click sets on; a column the server could
// not read has the reason in its head's title and no boxes. The skills a role chose that are not
// installed are listed below the table, with their boxes to switch them off. A skill's name opens its SKILL.md (GET api/skills/<name>) in a side
// panel as plain text, never as HTML. A classic script, loaded in order with defer, sharing the
// page's globals with the others. This file has no import or export on purpose: the compiler keeps
// it a script, so its top-level names stay the page's globals.
'use strict';

// A column: the role (an agent role, or the coordinator) and its head.
interface SkColumn {
  role: SkillRole | 'coordinator';
  head: string;
}
// The agent roles' columns, in order (src/skill-roles.ts ROLES).
const SK_ROLES: readonly SkColumn[] = [
  { role: 'implementer', head: 'Implementer' },
  { role: 'claude_review', head: 'Claude review' },
  { role: 'codex_gate', head: 'Codex gate' },
  { role: 'task_check', head: 'Task check' },
  { role: 'planner', head: 'Planner (ChatGPT)' },
];
// The table's columns: the roles', then the coordinator's.
const SK_COLUMNS: readonly SkColumn[] = [...SK_ROLES, { role: 'coordinator', head: 'Coordinator (Claude Code)' }];

// The Skills page: the list as last read (or as the last PUT answered), a read's error, the read
// under way, the filter, the PUT under way (its role and the list sent; one at a time, so no two
// answers race), the message of the last switch that failed, and the side panel: the skill shown,
// its text or error, the read under way. In page memory only; read on open and on Refresh, never
// on a timer.
const sk: {
  data: SkillsPayload | null;
  error: string | null;
  load: number;
  filter: string;
  sending: { role: SkColumn['role']; skills: string[] } | null;
  message: string | null;
  panelSkill: string | null;
  text: SkillText | null;
  textError: string | null;
  textLoad: number;
} = { data: null, error: null, load: 0, filter: '', sending: null, message: null, panelSkill: null, text: null, textError: null, textLoad: 0 };

function openSkills(): void {
  if (ui.job !== null) {
    leaveJob();
  }
  if (state.drawer !== null) {
    hideDrawer();
  }
  ui.screen = 'skills';
  ui.job = null;
  ui.ticket = null;
  ui.pending = false;
  byId('board').hidden = true;
  byId('job').hidden = true;
  byId('ticket').hidden = true;
  leavePages();
  sk.panelSkill = null;
  sk.message = null;
  const page = byId('skills');
  page.hidden = false;
  renderSkills();
  setHash();
  page.querySelector<HTMLElement>('[data-back]')?.focus();
  void loadSkills();
}

// One read of the list; its answer is applied only when it is the last read and no PUT was
// answered since it started (a PUT's answer counts as a read: switchSkill).
async function loadSkills(): Promise<void> {
  sk.load += 1;
  const load = sk.load;
  try {
    const data = payload<SkillsPayload>(await getText('api/skills'));
    if (load !== sk.load) {
      return;
    }
    sk.data = data;
    sk.error = null;
  } catch (error) {
    if (load !== sk.load) {
      return;
    }
    sk.error = errorMessage(error);
  }
  renderSkills();
}

// A column's stored list: a role's, or the coordinator's skills that are on (none when its column
// could not be read).
function storedList(data: SkillsPayload, role: SkColumn['role']): string[] {
  if (role !== 'coordinator') {
    return data.roles[role];
  }
  const coordinator = data.coordinator;
  return 'error' in coordinator ? [] : Object.keys(coordinator.skills).filter((name) => coordinator.skills[name] === 'on');
}

// The column's list the page shows: the one being sent, else the one stored.
const shownList = (data: SkillsPayload, role: SkColumn['role']): string[] => (sk.sending?.role === role ? sk.sending.skills : storedList(data, role));

// A skill's coordinator override that is neither on nor off (name-only, user-invocable-only); null otherwise.
function partialOverride(data: SkillsPayload, name: string): string | null {
  const value = 'error' in data.coordinator ? undefined : data.coordinator.skills[name];
  return value === 'name-only' || value === 'user-invocable-only' ? value : null;
}

// A box clicked: the role's list with the skill added at its end or taken out, sent at once; the
// role's boxes show that list and every box is disabled until the answer. The answer is the list
// the server stored, and outdates a read under way; a failure puts the box back (the list as it
// was), shows the message and reads the list again, in case a request that failed on the way had
// been stored.
async function switchSkill(column: SkColumn, name: string, on: boolean): Promise<void> {
  const data = sk.data;
  if (data === null || sk.sending !== null) {
    renderSkills();
    return;
  }
  const list = storedList(data, column.role).filter((other) => other !== name);
  const skills = on ? [...list, name] : list;
  sk.sending = { role: column.role, skills };
  sk.message = null;
  renderSkills();
  try {
    const stored = await post(`api/skills/roles/${encodeURIComponent(column.role)}`, { skills }, 'PUT');
    sk.load += 1;
    sk.data = stored as SkillsPayload;
    sk.error = null;
    sk.sending = null;
  } catch (error) {
    sk.sending = null;
    sk.message = `${name} for ${column.head} was not ${on ? 'switched on' : 'switched off'}: ${errorMessage(error)}`;
    void loadSkills();
  }
  renderSkills();
}

// The skill's SKILL.md in the side panel, read once per opening.
async function openSkillText(name: string): Promise<void> {
  sk.panelSkill = name;
  sk.text = null;
  sk.textError = null;
  sk.textLoad += 1;
  const load = sk.textLoad;
  renderSkills();
  byId('skills').querySelector<HTMLElement>('[data-sk="close"]')?.focus();
  try {
    const text = payload<SkillText>(await getText(`api/skills/${encodeURIComponent(name)}`));
    if (load === sk.textLoad) {
      sk.text = text;
    }
  } catch (error) {
    if (load === sk.textLoad) {
      sk.textError = errorMessage(error);
    }
  }
  if (load === sk.textLoad) {
    renderSkills();
  }
}

// Whether the side panel is open (Escape closes it before it leaves the page: routing.js onKey).
const skillTextShown = (): boolean => ui.screen === 'skills' && sk.panelSkill !== null;

// Closes the side panel, the focus back on the skill's name.
function closeSkillText(): void {
  const name = sk.panelSkill;
  sk.panelSkill = null;
  sk.text = null;
  sk.textError = null;
  sk.textLoad += 1;
  renderSkills();
  [...byId('skills').querySelectorAll<HTMLElement>('[data-sk-open]')].find((node) => node.dataset.skOpen === name)?.focus();
}

// Whether a skill passes the filter: its name or description holds the filter's words, any case.
function skillMatches(skill: SkillRow): boolean {
  const filter = sk.filter.trim().toLowerCase();
  return filter === '' || skill.name.toLowerCase().includes(filter) || (skill.description ?? '').toLowerCase().includes(filter);
}

// A column's box for a skill, labelled for screen readers; disabled while a list is sent. The
// coordinator's box of a skill neither on nor off is indeterminate, the value in its title.
function skillBox(column: SkColumn, name: string, data: SkillsPayload): HTMLInputElement {
  const box = el('input', 'sk-box');
  box.type = 'checkbox';
  box.checked = shownList(data, column.role).includes(name);
  const partial = column.role === 'coordinator' && !box.checked ? partialOverride(data, name) : null;
  if (partial !== null) {
    box.indeterminate = true;
    box.setAttribute('title', `${partial} in Claude Code's skillOverrides; a click switches it on`);
  }
  box.disabled = sk.sending !== null;
  box.setAttribute('aria-label', `${name} for ${column.head}`);
  box.dataset.sk = `box:${column.role}:${name}`;
  box.addEventListener('change', () => void switchSkill(column, name, box.checked));
  return box;
}

// The table: the skill (its name, a link to its SKILL.md; its description's first line, the whole
// on hover; its source and updated date, muted), then a box per role, each head with its count.
function skillsTable(data: SkillsPayload): HTMLElement {
  const table = el('table', 'sk-table');
  const headRow = el('tr');
  headRow.append(el('th', '', 'Skill'));
  const unread = 'error' in data.coordinator ? data.coordinator.error.message : null;
  for (const { role, head } of SK_COLUMNS) {
    const th = el('th', 'sk-role', role === 'coordinator' && unread !== null ? head : `${head} · ${shownList(data, role).length}`);
    if (role === 'planner') {
      th.append(el('span', 'sk-note', 'Applies to the next planning request'));
    }
    if (role === 'coordinator' && unread !== null) {
      th.setAttribute('title', unread);
    }
    headRow.append(th);
  }
  const thead = el('thead');
  thead.append(headRow);
  const tbody = el('tbody');
  for (const skill of data.skills) {
    const row = el('tr');
    row.dataset.skRow = skill.name;
    row.hidden = !skillMatches(skill);
    const cell = el('td', 'sk-skill');
    const nameButton = button('linkish sk-name', skill.name, { skOpen: skill.name, sk: `open:${skill.name}` });
    nameButton.setAttribute('title', `Read ${skill.name}'s SKILL.md`);
    nameButton.addEventListener('click', () => void openSkillText(skill.name));
    cell.append(nameButton);
    if (skill.description !== null) {
      const description = el('div', 'sk-desc', firstLine(skill.description));
      description.setAttribute('title', skill.description);
      cell.append(description);
    }
    const meta = [skill.source, skill.updated?.slice(0, 10)].filter((part): part is string => typeof part === 'string' && part !== '');
    if (meta.length > 0) {
      cell.append(el('div', 'sk-meta muted', meta.join(' · ')));
    }
    row.append(cell);
    for (const column of SK_COLUMNS) {
      const td = el('td', 'sk-role');
      if (column.role !== 'coordinator' || unread === null) {
        td.append(skillBox(column, skill.name, data));
      }
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(thead, tbody);
  const wrap = el('div', 'sk-scroll');
  wrap.append(table);
  return wrap;
}

// The skills chosen but not installed, each with the boxes of the roles that chose it (as stored:
// a box being switched off stays until the answer).
function skillsMissing(data: SkillsPayload): HTMLElement {
  const list = el('ul', 'sk-missing');
  for (const name of data.missing) {
    const roles = SK_ROLES.filter(({ role }) => storedList(data, role).includes(name));
    const item = el('li');
    item.append(el('span', 'sk-missing-text', `Chosen but not installed: ${name} (${roles.map(({ head }) => head).join(', ')})`));
    for (const column of roles) {
      const label = el('label', 'sk-off');
      label.append(skillBox(column, name, data), document.createTextNode(` ${column.head}`));
      item.append(label);
    }
    list.append(item);
  }
  return list;
}

// The side panel: the skill's SKILL.md as text (textContent: never read as HTML), Close and Esc.
function skillPanel(name: string): HTMLElement {
  const panel = el('aside', 'sk-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `${name}: SKILL.md`);
  const top = el('div', 'sk-panel-head');
  const close = button('btn', 'Close', { sk: 'close' });
  close.setAttribute('title', 'Close (Esc)');
  close.addEventListener('click', closeSkillText);
  top.append(el('span', 'title', `${name} · SKILL.md`), close);
  panel.append(top);
  if (sk.textError !== null) {
    panel.append(el('p', 'err-text fs13', `The skill could not be read (${sk.textError}).`));
  } else if (sk.text === null) {
    panel.append(el('p', 'muted fs13', 'Loading…'));
  } else {
    panel.append(el('pre', 'sk-text', sk.text.text));
    if (sk.text.truncated) {
      panel.append(el('p', 'muted fs13', 'The file is longer: only its first 256 KB are shown.'));
    }
  }
  return panel;
}

function renderSkills(): void {
  if (ui.screen !== 'skills') {
    return;
  }
  const page = byId('skills');
  const data = sk.data;
  const backButton = button('btn back', '← Board ', { back: '', sk: 'back' });
  backButton.append(el('span', 'kbd', 'Esc'));
  backButton.setAttribute('title', 'Back to the board (Esc)');
  const t1 = el('div', 't1');
  t1.append(el('span', 'title', 'Skills'));
  const refresh = button('btn', 'Refresh', { sk: 'refresh' });
  refresh.addEventListener('click', () => void loadSkills());
  const tools = el('div', 'tools');
  tools.append(refresh);
  const head = el('header', 'jhead');
  head.append(backButton, t1, tools);
  const body = el('div', 'sk-body');
  if (sk.error !== null) {
    const card = el('div', 'card2');
    const retry = button('btn', 'Retry', { sk: 'retry' });
    retry.addEventListener('click', () => void loadSkills());
    card.append(el('p', 'err-text fs13', `The skills could not be read (${sk.error}).`), retry);
    body.append(card);
  }
  if (data === null) {
    if (sk.error === null) {
      body.append(el('p', 'muted fs13', 'Loading the skills…'));
    }
  } else {
    const filter = el('input', 'sk-filter');
    filter.type = 'search';
    filter.value = sk.filter;
    filter.placeholder = 'Filter by name or description';
    filter.setAttribute('aria-label', 'Filter the skills');
    filter.dataset.sk = 'filter';
    filter.addEventListener('input', () => {
      sk.filter = filter.value;
      for (const row of page.querySelectorAll<HTMLElement>('[data-sk-row]')) {
        const skill = sk.data?.skills.find((one) => one.name === row.dataset.skRow);
        row.hidden = skill === undefined || !skillMatches(skill);
      }
    });
    body.append(filter, el('p', 'muted fs13', 'Changes apply to jobs started after; running jobs keep their skills.'));
    if (sk.message !== null) {
      const message = el('p', 'err-text fs13 sk-message', sk.message);
      message.setAttribute('role', 'alert');
      body.append(message);
    }
    body.append(data.skills.length > 0 ? skillsTable(data) : el('p', 'muted fs13', 'No skills installed: npx skills add <source> installs one.'));
    const coordinator = data.coordinator;
    body.append(el('p', 'muted fs13 sk-coordinator', 'error' in coordinator
      ? `Coordinator (Claude Code): ${coordinator.error.message}`
      : `The coordinator's choice is Claude Code's skillOverrides in the ${coordinator.workspace} checkout's .claude/settings.local.json; it applies to the next Claude Code session there (or after /skills).`));
    if (data.missing.length > 0) {
      body.append(skillsMissing(data));
    }
  }
  // The focus stays on the control it was on; the scroll where it was.
  const active = document.activeElement;
  const focused = active !== null && page.contains(active) && hasDataset(active) ? active.dataset?.sk : undefined;
  const scroll = page.querySelector('.form2')?.scrollTop ?? 0;
  const wrap = el('div', 'form2');
  wrap.append(body);
  page.replaceChildren(head, wrap, ...(sk.panelSkill === null ? [] : [skillPanel(sk.panelSkill)]));
  wrap.scrollTop = scroll;
  if (focused !== undefined) {
    [...page.querySelectorAll<HTMLElement>('[data-sk]')].find((node) => node.dataset.sk === focused)?.focus();
  }
}
