// digest-brief.js, a dashboard script (DASHBOARD_SCRIPTS in src/dashboard.ts), built from
// web/digest-brief.ts into dist/web/: the Digest page's two languages (the headings in English and
// Bulgarian, the switch Local · English · Both, the model's {text, en} texts), its Brief tab with
// Copy for the stand-up, and the schedule line with its Edit. reports.js holds the page itself and
// the Repositories tab. A classic script, loaded in order with defer, sharing the page's globals
// with the others: no import or export on purpose, so its top-level names stay the page's globals.
'use strict';

// ---------- The two languages ----------

// The switch: the record's language, English, or both (the default), kept in the browser.
type DgLang = 'local' | 'en' | 'both';
const DIGEST_LANG_KEY = 'sf-digest-lang';
const DG_LANGS: readonly DgLang[] = ['local', 'en', 'both'];

const dgLanguageIn = (record: DigestRecord, names: readonly string[]): boolean => names.includes(String(record.language ?? '').trim().toLowerCase());
// A Bulgarian record (bulgarian, bg or български, any case) has headings in both languages.
const dgBulgarian = (record: DigestRecord): boolean => dgLanguageIn(record, ['bulgarian', 'bg', 'български']);
// An English record (english or en, any case; or none) has no switch.
const dgEnglish = (record: DigestRecord): boolean => dgLanguageIn(record, ['english', 'en', '']);

// The fixed headings, [English, Bulgarian].
type DgWords = readonly [string, string];
const DG_WORDS = {
  brief: ['Brief', 'Обзор'],
  repos: ['Repositories', 'Хранилища'],
  yesterday: ['Yesterday', 'Вчера'],
  progress: ['In progress now', 'В момента'],
  today: ['Today', 'Днес'],
  merged: ['Merged by colleagues', 'Слято от колегите'],
  waiting: ['Waiting on me', 'Чака мен'],
  cross: ['One ticket across the app', 'Една задача в приложението'],
  effect: ['Effect on my work', 'Ефект върху моята работа'],
  live: ['Live branches', 'Живи клонове'],
} as const satisfies Record<string, DgWords>;
const dgLandedOn = (main: string): DgWords => [`Landed on ${main}`, `Слято в ${main}`];

// The words of a job's state in In progress now, [English, Bulgarian].
const DG_STATE_WORDS: Readonly<Partial<Record<JobState, DgWords>>> = {
  awaiting_review: ['In review', 'В преглед'],
  preparing_mr: ['Writing the MR text', 'Пише текста на MR'],
  needs_human: ['Waits for you', 'Чака теб'],
  ready_for_human_review: ['Ready for your review', 'Готово за твоя преглед'],
  handed_over: ['In your checkout', 'В твоето копие'],
  paused: ['Paused', 'На пауза'],
  waiting_limit: ['Waits for the usage limit', 'Чака лимита'],
};
function dgStateWords(row: DigestInProgress): DgWords {
  if (row.state === 'starting' || row.state === 'working') {
    return [`Working, iteration ${row.iteration}`, `Работи, итерация ${row.iteration}`];
  }
  return DG_STATE_WORDS[row.state] ?? [String(row.state), String(row.state)];
}

// The switch's choice for the record: an English record shows its texts as they are.
function dgLang(record: DigestRecord): DgLang {
  if (dgEnglish(record)) {
    return 'local';
  }
  const stored = store.get(DIGEST_LANG_KEY);
  return DG_LANGS.find((lang) => lang === stored) ?? 'both';
}

// A heading as shown: for a Bulgarian record "<Bulgarian> · <English>" in Both, one of them
// otherwise; in English for any other language (the page has no dictionary for it).
function dgHead(record: DigestRecord, pair: DgWords, lang: DgLang): string {
  if (!dgBulgarian(record)) {
    return pair[0];
  }
  return lang === 'both' ? `${pair[1]} · ${pair[0]}` : lang === 'en' ? pair[0] : pair[1];
}

// The first heading of the Brief: "Yesterday" when the daily's span starts the day before the
// digest (local dates) or is unknown, else "Since <weekday>".
function dgYesterdayWords(record: DigestRecord): DgWords {
  const from = new Date(record.daily_days?.yesterday?.from ?? Number.NaN);
  const start = new Date(record.started_at);
  const before = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
  if (Number.isNaN(from.getTime() - start.getTime()) || from.toDateString() === before.toDateString()) {
    return DG_WORDS.yesterday;
  }
  const weekday = (locale: string): string => new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(from);
  return [`Since ${weekday('en')}`, `От ${weekday('bg')}`];
}

// A model text as {text, en}: a plain string of an older record has no en.
function dgPair(value: DigestText | null | undefined): { text: string; en: string | null } {
  if (typeof value === 'string') {
    return { text: value, en: null };
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return { text: '', en: null };
  }
  return { text: typeof value.text === 'string' ? value.text : '', en: typeof value.en === 'string' ? value.en : null };
}

// The text one language shows: local the text, English the en (the text of an old string).
function dgIn(value: DigestText | null | undefined, lang: 'local' | 'en'): string {
  const pair = dgPair(value);
  return lang === 'en' ? pair.en ?? pair.text : pair.text;
}

// A model text as the switch shows it: Local the text, English the en, Both the text and the en in a
// muted line below it when it differs.
function dgText(value: DigestText | null | undefined, lang: DgLang, className = ''): HTMLElement[] {
  const pair = dgPair(value);
  if (lang !== 'both') {
    return [el('span', className, dgIn(value, lang))];
  }
  const nodes = [el('span', className, pair.text)];
  if (pair.en !== null && pair.en !== pair.text) {
    nodes.push(el('div', 'dg-en muted fs12', pair.en));
  }
  return nodes;
}

// The switch in the page header's tools: "<language> · English · Both", for a record not in English.
function dgSwitch(record: DigestRecord): HTMLElement | null {
  if (dgEnglish(record)) {
    return null;
  }
  const lang = dgLang(record);
  const group = el('div', 'dg-lang');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Language of the digest');
  const names: ReadonlyArray<[DgLang, string]> = [['local', String(record.language)], ['en', 'English'], ['both', 'Both']];
  for (const [value, text] of names) {
    const node = button(lang === value ? 'btn small on' : 'btn small', text, { dglang: value });
    node.setAttribute('aria-pressed', String(lang === value));
    node.addEventListener('click', () => {
      store.set(DIGEST_LANG_KEY, value);
      renderDigest();
    });
    group.append(node);
  }
  return group;
}

// ---------- The Brief ----------

// One line of a section: a model text (a cross_repo row with its ticket), a job in progress, or a
// colleague's landed commit.
type DgEntry =
  | { kind: 'text'; value: DigestText; ticket?: string }
  | { kind: 'job'; row: DigestInProgress }
  | { kind: 'landed'; entry: DigestLanded; problem: DigestText | undefined };
// The lines of an app (sections 1, 2, 3 and 5) or a workspace (section 4); folded: the landed
// commits older than 24 hours before the period's end.
interface DgGroup {
  key: string;
  entries: DgEntry[];
  folded: DgEntry[];
}
type DgSectionId = 'yesterday' | 'progress' | 'today' | 'merged' | 'waiting';
interface DgSection {
  id: DgSectionId;
  title: DgWords;
  groups: DgGroup[];
}
// The sections Copy gives, per app.
const DG_COPIED: readonly DgSectionId[] = ['yesterday', 'progress', 'today', 'waiting'];

// The apps of the Brief: those of the record's workspaces in order, then any only a daily or a job
// names.
function dgApps(record: DigestRecord): string[] {
  const apps: string[] = [];
  const add = (app: string): void => {
    if (!apps.includes(app)) {
      apps.push(app);
    }
  };
  record.workspaces.forEach((workspace) => add(workspace.app));
  (record.output?.dailies ?? []).forEach((daily) => add(daily.app));
  (record.in_progress ?? []).forEach((row) => add(row.app));
  return apps;
}

const dgTexts = (values: readonly DigestText[] | undefined): DgEntry[] => (values ?? []).map((value) => ({ kind: 'text', value }));
const dgFilled = (value: DigestText | undefined): boolean => dgPair(value).text.trim() !== '' || (dgPair(value).en ?? '').trim() !== '';

// The five sections in their order, each with its groups (empty ones too).
function dgBrief(record: DigestRecord): DgSection[] {
  const apps = dgApps(record);
  const dailies = record.output?.dailies ?? [];
  const repos = record.output?.repos ?? [];
  // A cross_repo row's app: that of the first workspace of the record it names, else the first app.
  const crossApp = (row: DigestCross): string | undefined => record.workspaces.find((workspace) => Object.hasOwn(row.by_workspace ?? {}, workspace.name))?.app ?? apps[0];
  const perApp = (entries: (app: string) => DgEntry[]): DgGroup[] => apps.map((app) => ({ key: app, entries: entries(app), folded: [] }));
  const ofApp = (app: string) => dailies.filter((daily) => daily.app === app);
  const recent = Date.parse(record.period.to) - 86400000;
  const merged = record.workspaces.filter((workspace) => workspace.track && workspace.git !== null && workspace.git !== undefined).map((workspace): DgGroup => {
    const repo = repos.find((entry) => entry.name === workspace.name);
    const landed = workspace.git!.landed.filter((entry) => !entry.mine).map((entry): DgEntry & { kind: 'landed' } => ({
      kind: 'landed', entry, problem: dgProblem(repo, entry),
    }));
    return { key: workspace.name, entries: landed.filter((item) => Date.parse(item.entry.date) >= recent), folded: landed.filter((item) => !(Date.parse(item.entry.date) >= recent)) };
  });
  return [
    { id: 'yesterday', title: dgYesterdayWords(record), groups: perApp((app) => ofApp(app).flatMap((daily) => dgTexts(daily.yesterday))) },
    { id: 'progress', title: DG_WORDS.progress, groups: perApp((app) => (record.in_progress ?? []).filter((row) => row.app === app).map((row) => ({ kind: 'job', row }))) },
    { id: 'today', title: DG_WORDS.today, groups: perApp((app) => ofApp(app).flatMap((daily) => [...dgTexts(daily.next), ...dgTexts(daily.plan)])) },
    { id: 'merged', title: DG_WORDS.merged, groups: merged },
    {
      id: 'waiting', title: DG_WORDS.waiting, groups: perApp((app) => [
        ...record.workspaces.filter((workspace) => workspace.track && workspace.app === app).flatMap((workspace) => dgTexts(repos.find((repo) => repo.name === workspace.name)?.impact_on_me)),
        ...ofApp(app).flatMap((daily) => dgTexts(daily.problems)),
        ...(record.output?.cross_repo ?? []).filter((row) => dgFilled(row.for_me) && crossApp(row) === app).map((row): DgEntry => ({ kind: 'text', value: row.for_me, ticket: row.ticket })),
      ]),
    },
  ];
}

// The model's problem of a landed entry (its sha, or a prefix of its full sha), else undefined.
function dgProblem(repo: DigestRepo | null | undefined, entry: DigestLanded): DigestText | undefined {
  return repo?.merged?.find((merged) => merged.sha === entry.sha || entry.full_sha?.startsWith(merged.sha))?.problem;
}

const dgGroupFilled = (group: DgGroup): boolean => group.entries.length > 0 || group.folded.length > 0;

// "HH:MM" of a time on the digest's day, else its date.
function dgWhen(ts: string, record: DigestRecord): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toDateString() === new Date(record.started_at).toDateString() ? localTime(ts).slice(11, 16) : localTime(ts).slice(0, 10);
}

// One line of the page.
function dgLine(record: DigestRecord, entry: DgEntry, lang: DgLang): HTMLElement {
  const item = el('li', `dg-line dg-${entry.kind}`);
  if (entry.kind === 'job') {
    const { row } = entry;
    item.append(el('span', 'chipx', row.ticket), el('span', 'dg-tx', ` ${row.title}: `), el('span', 'dg-state', dgHead(record, dgStateWords(row), lang)));
    if (row.state === 'needs_human' && row.stop_code !== null) {
      item.append(el('span', 'mono dg-code', row.stop_code));
    }
    item.append(el('span', 'muted fs12 dg-at', dgWhen(row.since, record)));
    return item;
  }
  if (entry.kind === 'landed') {
    if (entry.entry.ticket) {
      item.append(el('span', 'chipx', entry.entry.ticket));
    }
    // The author and the time stay on the item's line, before the English line of Both.
    const [text, ...english] = entry.problem === undefined ? [el('span', 'dg-tx', entry.entry.subject)] : dgText(entry.problem, lang, 'dg-tx');
    item.append(text!, el('span', 'muted fs12 dg-at', `${entry.entry.author} · ${dgWhen(entry.entry.date, record)}`), ...english);
    return item;
  }
  if (entry.ticket !== undefined) {
    item.append(el('span', 'mono dg-ticket', `${entry.ticket}:`));
  }
  item.append(...dgText(entry.value, lang, 'dg-tx'));
  return item;
}

// A line of Copy's text, in one language.
function dgCopyLine(record: DigestRecord, entry: DgEntry, lang: 'local' | 'en'): string {
  if (entry.kind === 'job') {
    return `${entry.row.ticket} ${entry.row.title}: ${dgHead(record, dgStateWords(entry.row), lang)}`;
  }
  if (entry.kind === 'landed') {
    return entry.problem === undefined ? entry.entry.subject : dgIn(entry.problem, lang);
  }
  return `${entry.ticket !== undefined ? `${entry.ticket}: ` : ''}${dgIn(entry.value, lang)}`;
}

// What Copy for the stand-up puts on the clipboard for an app: its lines of sections 1, 2, 3 and 5
// under their headings ("Heading:", then "- " lines), in the language the switch shows; in Both the
// local block, an empty line, then the English block (the local one alone for an older record,
// whose plain strings have no English).
function dgCopyText(record: DigestRecord, sections: readonly DgSection[], app: string, lang: DgLang): string {
  const copied = sections.filter((section) => DG_COPIED.includes(section.id)).map((section) => ({ section, entries: section.groups.find((group) => group.key === app)?.entries ?? [] }));
  const texts = copied.flatMap(({ entries }) => entries.flatMap((entry) => (entry.kind === 'text' ? [entry.value] : [])));
  const english = texts.length === 0 || texts.some((value) => dgPair(value).en !== null);
  const blocks: ReadonlyArray<'local' | 'en'> = lang !== 'both' ? [lang] : english ? ['local', 'en'] : ['local'];
  return blocks.map((block) => copied.flatMap(({ section, entries }) => (entries.length === 0 ? [] : [`${dgHead(record, section.title, block)}:`, ...entries.map((entry) => `- ${dgCopyLine(record, entry, block)}`)])).join('\n')).join('\n\n');
}

// A group's title: an app's name with its workspace chips, or a workspace's name.
function dgGroupTitle(record: DigestRecord, section: DgSection, key: string): HTMLElement {
  const title = el('div', 'dg-group');
  if (section.id === 'merged') {
    title.append(wsDot(key), el('span', 'dg-name', key));
  } else {
    title.append(el('span', 'dg-name', key), ...record.workspaces.filter((workspace) => workspace.app === key).map((workspace) => wsChip(workspace.name)));
  }
  return title;
}

// The Brief tab: its sections with lines, then per app Copy for the stand-up and the commits its
// daily was made from. A Brief without a line keeps the empty card.
function dgBriefTab(record: DigestRecord): HTMLElement[] {
  const lang = dgLang(record);
  const sections = dgBrief(record);
  const apps = dgApps(record);
  const card = el('article', 'card2 dg-brief');
  let shown = 0;
  for (const section of sections) {
    const groups = section.groups.filter(dgGroupFilled);
    if (groups.length === 0) {
      continue;
    }
    const titled = section.id === 'merged' ? section.groups.length > 1 : apps.length > 1;
    const box = el('section', 'dg-sec');
    box.dataset.sec = section.id;
    box.append(el('h4', '', dgHead(record, section.title, lang)));
    for (const group of groups) {
      if (titled) {
        box.append(dgGroupTitle(record, section, group.key));
      }
      if (group.entries.length > 0) {
        const list = el('ul', 'dg-lines');
        list.append(...group.entries.map((entry) => dgLine(record, entry, lang)));
        box.append(list);
      }
      if (group.folded.length > 0) {
        const fold = el('details', 'dg-fold');
        const list = el('ul', 'dg-lines');
        list.append(...group.folded.map((entry) => dgLine(record, entry, lang)));
        fold.append(el('summary', '', `Earlier in the period (${group.folded.length})`), list);
        box.append(fold);
      }
    }
    card.append(box);
    shown += 1;
  }
  if (shown === 0) {
    const empty = el('div', 'card2 dg-empty');
    empty.append(el('p', 'fs13', 'No daily in this digest: no workspace has My daily on (Workspaces → Edit), or you have no commits or open branches there in the two days.'));
    return [empty];
  }
  const copied = sections.filter((section) => DG_COPIED.includes(section.id));
  for (const app of apps.filter((name) => copied.some((section) => section.groups.some((group) => group.key === name && group.entries.length > 0)))) {
    card.append(dgAppRow(record, sections, app, apps.length > 1, lang));
  }
  return [card];
}

// An app's row below the sections: its name (with more than one app), Copy for the stand-up, and
// the fold of the commits its daily was made from.
function dgAppRow(record: DigestRecord, sections: readonly DgSection[], app: string, named: boolean, lang: DgLang): HTMLElement {
  const row = el('div', 'dg-app');
  row.dataset.app = app;
  const line = el('div', 'dg-copyrow');
  if (named) {
    line.append(el('span', 'dg-name', app));
  }
  const copy = button('btn small', 'Copy for the stand-up', { dg: 'copy' });
  copy.addEventListener('click', () => void copyDaily(app, dgCopyText(record, sections, app, lang)));
  line.append(copy);
  const copied = dg.copied.get(app);
  if (copied !== undefined) {
    line.append(el('span', copied.ok ? 'muted fs12' : 'err-text fs12', copied.text));
  }
  row.append(line);
  const source = (record.daily_sources ?? []).find((entry) => entry.app === app);
  if (source !== undefined) {
    const fold = el('details', 'dg-fold');
    const list = el('ul', 'dg-commits');
    list.append(...source.commits.map((commit) => {
      const item = el('li', 'fs12');
      item.append(el('span', 'mono', commit.sha), document.createTextNode(` ${commit.subject} `), el('span', 'muted', `${commit.workspace} · ${commit.ref} · ${dgTime(commit.date).slice(5)}`));
      return item;
    }));
    fold.append(el('summary', '', `The commits it was made from (${source.commits.length})`), list);
    row.append(fold);
  }
  return row;
}

async function copyDaily(app: string, text: string): Promise<void> {
  try {
    if (typeof navigator.clipboard?.writeText !== 'function') {
      throw new Error('the browser gives no clipboard here');
    }
    await navigator.clipboard.writeText(text);
    dg.copied.set(app, { ok: true, text: 'Copied.' });
  } catch (error) {
    dg.copied.set(app, { ok: false, text: `Copy failed: ${errorMessage(error)}` });
  }
  renderDigest();
}

// ---------- The schedule line ----------

// The times typed in a field: split at commas, trimmed, the empty parts dropped.
const digestTimesOf = (text: string): string[] => text.split(',').map((part) => part.trim()).filter((part) => part !== '');

// "Updates at 08:30 · 10:45 (weekdays)" and Edit; while Edit is open, the times as one field with
// Save and Cancel, and a refusal's message next to it. None until the workspaces event gave the
// settings.
function dgSchedule(): HTMLElement | null {
  const settings = state.wsSettings.digest;
  if (settings === null) {
    return null;
  }
  const times = Array.isArray(settings.times) ? settings.times : [];
  const line = el('div', 'dg-sched');
  const edit = dg.edit;
  if (edit === null) {
    line.append(el('span', 'muted fs13', `Updates at ${times.join(' · ')} (${settings.weekdays_only ? 'weekdays' : 'every day'})`));
    const open = button('btn small', 'Edit', { dg: 'sched-edit' });
    open.addEventListener('click', () => {
      dg.edit = { text: times.join(', '), error: null, saving: false };
      renderDigest();
      byId('digest').querySelector<HTMLElement>('[data-dg="times"]')?.focus();
    });
    line.append(open);
    return line;
  }
  const input = el('input', 'dg-times');
  input.type = 'text';
  input.value = edit.text;
  input.dataset.dg = 'times';
  input.setAttribute('aria-label', 'Times of the digest (HH:MM, comma-separated)');
  input.setAttribute('placeholder', '08:30, 10:45');
  input.addEventListener('input', () => {
    edit.text = input.value;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void dgSaveTimes();
    }
  });
  const save = button('btn small primary', edit.saving ? 'Saving…' : 'Save', { dg: 'sched-save' });
  save.disabled = edit.saving;
  save.addEventListener('click', () => void dgSaveTimes());
  const cancel = button('btn small', 'Cancel', { dg: 'sched-cancel' });
  cancel.addEventListener('click', () => {
    dg.edit = null;
    renderDigest();
  });
  line.append(input, save, cancel);
  if (edit.error !== null) {
    line.append(el('span', 'err-text fs12', edit.error));
  }
  return line;
}

// Save: posts the times; the answer is the settings (the workspaces event that follows says the same).
async function dgSaveTimes(): Promise<void> {
  const edit = dg.edit;
  if (edit === null || edit.saving) {
    return;
  }
  edit.saving = true;
  edit.error = null;
  renderDigest();
  try {
    const answer = await post('api/digest-settings', { times: digestTimesOf(edit.text) });
    if (isRecord(answer) && Array.isArray(answer.times) && state.wsSettings.digest !== null) {
      state.wsSettings.digest = { ...state.wsSettings.digest, times: answer.times.filter((time): time is string => typeof time === 'string') };
    }
    if (dg.edit === edit) {
      dg.edit = null;
    }
  } catch (error) {
    edit.error = error instanceof ActionError ? error.message : `The request failed (${errorMessage(error)}); it may have been saved.`;
  }
  edit.saving = false;
  renderDigest();
}
