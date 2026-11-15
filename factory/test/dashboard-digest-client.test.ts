// The Digest page's Brief and languages (web/digest-brief.ts, web/reports.ts), run under node:vm
// against the fake page of test/support/fake-dom.ts: the Brief's sections in order with their
// headings in English and Bulgarian; the switch Local · English · Both on items and headings, kept
// across a reload, none for an English record; an old record with plain strings and no
// in_progress; In progress now; Copy for the stand-up per app in each mode; the schedule line's Edit
// and Save; and the Repositories tab through the switch. Script checks, not browser acceptance: the
// layout is test/browser/digest-page.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
// UTC+2 in November: a span's first day and the digest's day differ from their UTC dates.
process.env.TZ = 'Europe/Sofia';

const ID = '20261109T050000Z-scheduled';
// Monday 2026-11-09 07:00 local; yesterday from Friday 00:00 local (Thursday in UTC).
const MONDAY = { started_at: '2026-11-09T05:00:00.000Z', daily_days: { yesterday: { from: '2026-11-05T22:00:00.000Z', to: '2026-11-08T22:00:00.000Z' }, today: { from: '2026-11-08T22:00:00.000Z', to: '2026-11-09T05:00:00.000Z' } } };
// Wednesday 2026-11-11 03:00 local (01:00 UTC); yesterday from Tuesday 00:00 local (Monday 22:00 UTC).
const WEDNESDAY = { started_at: '2026-11-11T01:00:00.000Z', daily_days: { yesterday: { from: '2026-11-09T22:00:00.000Z', to: '2026-11-10T22:00:00.000Z' }, today: { from: '2026-11-10T22:00:00.000Z', to: '2026-11-11T01:00:00.000Z' } } };

// A model text: the local text and its English.
const t = (text: string, en: string) => ({ text, en });

function git(landed: Array<Record<string, unknown>>) {
  return { main: 'main', me: 'me@example.invalid', landed, branches: [], my_commits: [], notes: [] };
}
function landedEntry(sha: string, date: string, extra: Record<string, unknown> = {}) {
  return { sha, full_sha: `${sha}000000`, author: 'Ana', mine: false, date, subject: `SHOP-7: Subject ${sha}`, merge: false, ticket: 'SHOP-7', why: '', files: [], files_total: 0, dirs: ['src'], stat: '1 file', ...extra };
}
function workspace(name: string, app: string, extra: Record<string, unknown> = {}) {
  return { name, app, description: null, description_source: null, track: true, my_work: true, fetch: { status: 'ok', message: null, last_fetch_ok_at: null, notes: [] }, git: git([]), error: null, ...extra };
}

// A Bulgarian record of one app (shop: api and web) with every section filled.
function record(extra: Record<string, unknown> = {}) {
  return {
    id: ID, trigger: 'scheduled', ended_at: '2026-11-09T05:02:00.000Z', period: { from: '2026-11-06T06:00:00.000Z', to: '2026-11-09T05:00:00.000Z' },
    model: 'sonnet', language: 'Bulgarian', notes: [], cost_usd: 0.2, error: null, counts: { landed: 1, live_branches: 0, impact: 1 },
    workspaces: [
      workspace('api', 'shop', { git: git([landedEntry('aaa1', '2026-11-09T03:00:00.000Z'), landedEntry('bbb2', '2026-11-06T09:00:00.000Z', { ticket: null, subject: 'Old cleanup' }), landedEntry('ccc3', '2026-11-09T04:00:00.000Z', { mine: true })]) }),
      workspace('web', 'shop', { git: null }),
    ],
    daily_sources: [{ app: 'shop', workspaces: ['api'], commits: [{ sha: 'ccc3', ref: 'SHOP-8', date: '2026-11-09T04:00:00.000Z', subject: 'SHOP-8: mine', why: '', stat: '', workspace: 'api' }], jobs: [], open_branches: [] }],
    output: {
      repos: [{ name: 'api', headline: t('Списъкът слезе.', 'The list landed.'), merged: [{ sha: 'aaa1', problem: t('Магазинът показва поръчките.', 'The shop shows its orders.') }], branches: [], impact_on_me: [t('SHOP-8 трябва да се обнови.', 'SHOP-8 needs the latest changes.')] }],
      cross_repo: [{ ticket: 'SHOP-7', by_workspace: { api: t('Крайна точка.', 'An endpoint.'), web: t('Страница.', 'A page.') }, for_me: t('Нищо.', 'Nothing.') }],
      dailies: [{
        app: 'shop', workspaces: ['api'], yesterday: [t('SHOP-8: поръчки.', 'SHOP-8: orders.')], problems: [t('SHOP-8 изостава.', 'SHOP-8 is behind.')],
        plan: [t('Обнови SHOP-8.', 'Update SHOP-8.')], next: [t('SHOP-8: довърши.', 'SHOP-8: finish.')],
      }],
    },
    in_progress: [
      { workspace: 'api', app: 'shop', ticket: 'SHOP-9', title: 'The payment form', state: 'needs_human', stop_code: 'gate_failed', iteration: 2, since: '2026-11-09T04:30:00.000Z' },
      { workspace: 'api', app: 'shop', ticket: 'SHOP-10', title: 'The receipts', state: 'working', stop_code: null, iteration: 3, since: '2026-11-08T10:00:00.000Z' },
    ],
    ...MONDAY, ...extra,
  };
}

// A localStorage over a map, shared by the pages of one test (a reload keeps it).
function storage(items = new Map<string, string>()) {
  return { items, getItem: (name: string): string | null => items.get(name) ?? null, setItem: (name: string, value: string): void => void items.set(name, value) };
}

const SETTINGS = { times: ['08:30', '10:45'], weekdays_only: true, language: 'Bulgarian' };

// The digest page with the record on its default tab (the Brief); Copy writes to the returned
// clipboard; the workspaces event gives the settings unless settings is null.
async function openDigest(data: Record<string, unknown>, store = storage(), settings: Record<string, unknown> | null = SETTINGS): Promise<{ page: Page; copied: string[] }> {
  const copied: string[] = [];
  const clipboard = { writeText: async (text: string): Promise<void> => void copied.push(text) };
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs: [] };
    }
    if (path === 'api/digests') {
      return { running: false, digests: [{ id: ID, trigger: 'scheduled', period: data.period, ended_at: data.ended_at, counts: data.counts, cost_usd: 0.2, error: null }] };
    }
    return path === `api/digests/${ID}` ? data : undefined;
  }, clipboard, { localStorage: store });
  page.location.hash = `#digest/${ID}`;
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  page.streams.at(-1)!.emit('open');
  if (settings !== null) {
    page.streams.at(-1)!.emit('workspaces', { workspaces: [], handoff_default: 'checkout', digest: settings });
  }
  await page.flush();
  return { page, copied };
}

const digest = (page: Page): FakeElement => page.$('digest');
const tabs = (page: Page): string[] => digest(page).querySelectorAll('[role="tab"]').map((node) => node.textContent);
const tab = (page: Page, index: number): FakeElement => digest(page).querySelectorAll('[role="tab"]')[index]!;
const brief = (page: Page): FakeElement => digest(page).querySelector('.dg-brief')!;
const headings = (page: Page): string[] => brief(page).querySelectorAll('.dg-sec h4').map((node) => node.textContent);
const section = (page: Page, id: string): FakeElement => brief(page).querySelector(`.dg-sec[data-sec="${id}"]`)!;
const lines = (node: FakeElement): string[] => node.querySelectorAll('.dg-lines > li').map((item) => item.textContent);
const langButtons = (page: Page): FakeElement[] => digest(page).querySelectorAll('[data-dglang]');

async function choose(page: Page, lang: 'local' | 'en' | 'both'): Promise<void> {
  langButtons(page).find((node) => node.dataset.dglang === lang)!.click();
  await page.flush();
}

async function copy(page: Page, copied: string[], app = 'shop'): Promise<string> {
  digest(page).querySelector(`.dg-app[data-app="${app}"] [data-dg="copy"]`)!.click();
  await page.flush();
  return copied.at(-1)!;
}

test('digest client: the Brief is the default tab; its sections in order with "<Bulgarian> · <English>" headings in Both; "Since Friday" on a Monday', async () => {
  const { page } = await openDigest(record());
  assert.deepEqual(tabs(page), ['Обзор · Brief', 'Хранилища · Repositories']);
  assert.equal(tab(page, 0).getAttribute('aria-selected'), 'true');
  assert.deepEqual(headings(page), ['От петък · Since Friday', 'В момента · In progress now', 'Днес · Today', 'Слято от колегите · Merged by colleagues', 'Чака мен · Waiting on me']);
  // One app: no group titles; Both: the text, and the English in a muted line below it.
  assert.equal(brief(page).querySelectorAll('.dg-group').length, 0);
  const yesterday = section(page, 'yesterday').querySelector('li')!;
  assert.equal(yesterday.querySelector('.dg-tx')!.textContent, 'SHOP-8: поръчки.');
  assert.equal(yesterday.querySelector('.dg-en')!.textContent, 'SHOP-8: orders.');
  // Today: next, then plan. Waiting on me: the impact, the problems, then the cross_repo row.
  assert.deepEqual(section(page, 'today').querySelectorAll('.dg-tx').map((node) => node.textContent), ['SHOP-8: довърши.', 'Обнови SHOP-8.']);
  assert.deepEqual(section(page, 'waiting').querySelectorAll('li').map((node) => node.querySelector('.dg-tx')!.textContent), ['SHOP-8 трябва да се обнови.', 'SHOP-8 изостава.', 'Нищо.']);
  assert.equal(section(page, 'waiting').querySelectorAll('li')[2]!.querySelector('.dg-ticket')!.textContent, 'SHOP-7:');
  // Merged by colleagues: not mine; the model's problem else the subject; the older one folded.
  const merged = section(page, 'merged');
  // The author and the time on the item's line, the English line below it.
  assert.match(lines(merged)[0]!, /^SHOP-7Магазинът показва поръчките\.Ana · 05:00The shop shows its orders\.$/);
  assert.deepEqual(merged.querySelector('li')!.children.map((node) => (node as FakeElement).className), ['chipx', 'dg-tx', 'muted fs12 dg-at', 'dg-en muted fs12']);
  assert.equal(merged.querySelector('summary')!.textContent, 'Earlier in the period (1)');
  assert.match(merged.querySelector('details')!.textContent, /Old cleanupAna · 2026-11-06/);
  // Below the sections: Copy for the stand-up and the commits the daily was made from.
  const row = digest(page).querySelector('.dg-app[data-app="shop"]')!;
  assert.equal(row.querySelector('[data-dg="copy"]')!.textContent, 'Copy for the stand-up');
  assert.equal(row.querySelector('summary')!.textContent, 'The commits it was made from (1)');
  assert.equal(row.querySelector('.dg-name'), null);
});

test('digest client: In progress now: ticket, title and state words, the stop code, the time (HH:MM today, else the date); never a second line', async () => {
  const { page } = await openDigest(record());
  const items = section(page, 'progress').querySelectorAll('li');
  assert.deepEqual(items.map((item) => item.querySelector('.chipx')!.textContent), ['SHOP-9', 'SHOP-10']);
  assert.equal(items[0]!.querySelector('.dg-state')!.textContent, 'Чака теб · Waits for you');
  assert.equal(items[0]!.querySelector('.dg-code')!.textContent, 'gate_failed');
  assert.equal(items[0]!.querySelector('.dg-at')!.textContent, '06:30');
  assert.equal(items[1]!.querySelector('.dg-state')!.textContent, 'Работи, итерация 3 · Working, iteration 3');
  assert.equal(items[1]!.querySelector('.dg-code'), null);
  assert.equal(items[1]!.querySelector('.dg-at')!.textContent, '2026-11-08');
  assert.equal(section(page, 'progress').querySelectorAll('.dg-en').length, 0);
  await choose(page, 'local');
  assert.equal(section(page, 'progress').querySelector('.dg-state')!.textContent, 'Чака теб');
  await choose(page, 'en');
  assert.equal(section(page, 'progress').querySelector('.dg-state')!.textContent, 'Waits for you');
  // Every state's words.
  const states: Array<[string, string]> = [
    ['starting', 'Working, iteration 1'], ['awaiting_review', 'In review'], ['preparing_mr', 'Writing the MR text'], ['ready_for_human_review', 'Ready for your review'],
    ['handed_over', 'In your checkout'], ['paused', 'Paused'], ['waiting_limit', 'Waits for the usage limit'],
  ];
  const english = await openDigest(record({ language: 'English', in_progress: states.map(([state], index) => ({ workspace: 'api', app: 'shop', ticket: `S-${index}`, title: 'T', state, stop_code: null, iteration: 1, since: '2026-11-09T04:00:00.000Z' })) }));
  assert.deepEqual(section(english.page, 'progress').querySelectorAll('.dg-state').map((node) => node.textContent), states.map(([, words]) => words));
});

test('digest client: the switch shows Local, English or Both on items and headings, is kept across a reload, and Copy follows it', async () => {
  const store = storage();
  const first = await openDigest(record(), store);
  assert.deepEqual(langButtons(first.page).map((node) => node.textContent), ['Bulgarian', 'English', 'Both']);
  assert.equal(langButtons(first.page)[2]!.getAttribute('aria-pressed'), 'true');
  // Both: the local block, an empty line, then the English block.
  assert.equal(await copy(first.page, first.copied), [
    'От петък:', '- SHOP-8: поръчки.', 'В момента:', '- SHOP-9 The payment form: Чака теб', '- SHOP-10 The receipts: Работи, итерация 3',
    'Днес:', '- SHOP-8: довърши.', '- Обнови SHOP-8.', 'Чака мен:', '- SHOP-8 трябва да се обнови.', '- SHOP-8 изостава.', '- SHOP-7: Нищо.',
    '',
    'Since Friday:', '- SHOP-8: orders.', 'In progress now:', '- SHOP-9 The payment form: Waits for you', '- SHOP-10 The receipts: Working, iteration 3',
    'Today:', '- SHOP-8: finish.', '- Update SHOP-8.', 'Waiting on me:', '- SHOP-8 needs the latest changes.', '- SHOP-8 is behind.', '- SHOP-7: Nothing.',
  ].join('\n'));
  assert.equal(digest(first.page).querySelector('.dg-app [data-dg="copy"]')!.parentNode!.textContent.includes('Copied.'), true);

  await choose(first.page, 'local');
  assert.equal(store.items.get('sf-digest-lang'), 'local');
  assert.deepEqual(tabs(first.page), ['Обзор', 'Хранилища']);
  assert.deepEqual(headings(first.page), ['От петък', 'В момента', 'Днес', 'Слято от колегите', 'Чака мен']);
  assert.equal(brief(first.page).querySelectorAll('.dg-en').length, 0);
  assert.equal(section(first.page, 'yesterday').querySelector('li')!.textContent, 'SHOP-8: поръчки.');
  assert.equal(await copy(first.page, first.copied), [
    'От петък:', '- SHOP-8: поръчки.', 'В момента:', '- SHOP-9 The payment form: Чака теб', '- SHOP-10 The receipts: Работи, итерация 3',
    'Днес:', '- SHOP-8: довърши.', '- Обнови SHOP-8.', 'Чака мен:', '- SHOP-8 трябва да се обнови.', '- SHOP-8 изостава.', '- SHOP-7: Нищо.',
  ].join('\n'));

  await choose(first.page, 'en');
  assert.deepEqual(headings(first.page), ['Since Friday', 'In progress now', 'Today', 'Merged by colleagues', 'Waiting on me']);
  assert.equal(section(first.page, 'yesterday').querySelector('li')!.textContent, 'SHOP-8: orders.');
  assert.equal(brief(first.page).querySelectorAll('.dg-en').length, 0);
  assert.equal(await copy(first.page, first.copied), [
    'Since Friday:', '- SHOP-8: orders.', 'In progress now:', '- SHOP-9 The payment form: Waits for you', '- SHOP-10 The receipts: Working, iteration 3',
    'Today:', '- SHOP-8: finish.', '- Update SHOP-8.', 'Waiting on me:', '- SHOP-8 needs the latest changes.', '- SHOP-8 is behind.', '- SHOP-7: Nothing.',
  ].join('\n'));

  // A reload keeps English.
  const second = await openDigest(record(), store);
  assert.equal(langButtons(second.page)[1]!.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(headings(second.page), ['Since Friday', 'In progress now', 'Today', 'Merged by colleagues', 'Waiting on me']);
  // A value it does not know: Both.
  const third = await openDigest(record(), storage(new Map([['sf-digest-lang', 'klingon']])));
  assert.equal(langButtons(third.page)[2]!.getAttribute('aria-pressed'), 'true');
});

test('digest client: no switch for an English record; another language gets English headings, its items through the switch', async () => {
  for (const language of ['English', 'en', 'EN', '', null]) {
    const { page, copied } = await openDigest(record({ language, output: { ...record().output, dailies: [{ ...record().output.dailies[0]!, yesterday: [t('Did it.', 'Did it.')] }] } }));
    assert.equal(langButtons(page).length, 0, String(language));
    assert.deepEqual(tabs(page), ['Brief', 'Repositories']);
    assert.equal(headings(page)[0], 'Since Friday');
    assert.equal(brief(page).querySelectorAll('.dg-en').length, 0);
    assert.doesNotMatch(await copy(page, copied), /\n\n/);
  }
  const { page, copied } = await openDigest(record({ language: 'Deutsch' }));
  assert.deepEqual(langButtons(page).map((node) => node.textContent), ['Deutsch', 'English', 'Both']);
  assert.deepEqual(headings(page), ['Since Friday', 'In progress now', 'Today', 'Merged by colleagues', 'Waiting on me']);
  assert.equal(section(page, 'progress').querySelector('.dg-state')!.textContent, 'Waits for you');
  const text = await copy(page, copied);
  assert.match(text, /^Since Friday:\n- SHOP-8: поръчки\.\n[\s\S]*\n\nSince Friday:\n- SHOP-8: orders\./);
});

test('digest client: "Yesterday" and "Вчера" on a Wednesday at 03:00 and without daily_days', async () => {
  const { page } = await openDigest(record(WEDNESDAY));
  assert.equal(headings(page)[0], 'Вчера · Yesterday');
  const older = await openDigest(record({ daily_days: undefined }));
  assert.equal(headings(older.page)[0], 'Вчера · Yesterday');
  for (const language of ['bg', 'BG', 'български', 'Български', 'bulgarian']) {
    const each = await openDigest(record({ ...WEDNESDAY, language }));
    assert.equal(headings(each.page)[0], 'Вчера · Yesterday', language);
  }
});

test('digest client: an old record (plain strings, no in_progress) shows its strings in every mode; a section without items is left out', async () => {
  const old = record({
    in_progress: undefined,
    output: {
      repos: [{ name: 'api', headline: 'Стар.', merged: [{ sha: 'aaa1', problem: 'Стар проблем.' }], branches: [], impact_on_me: [] }],
      cross_repo: [{ ticket: 'SHOP-7', by_workspace: { api: 'А.' }, for_me: '' }],
      dailies: [{ app: 'shop', workspaces: ['api'], yesterday: ['Вчера работих.'], problems: [], plan: [], next: [] }],
    },
  });
  const { page, copied } = await openDigest(old);
  assert.deepEqual(headings(page), ['От петък · Since Friday', 'Слято от колегите · Merged by colleagues']);
  // Both: one block, since the plain strings have no English.
  assert.equal(await copy(page, copied), 'От петък:\n- Вчера работих.');
  assert.equal(section(page, 'yesterday').querySelector('li')!.textContent, 'Вчера работих.');
  assert.equal(brief(page).querySelectorAll('.dg-en').length, 0);
  await choose(page, 'en');
  assert.equal(section(page, 'yesterday').querySelector('li')!.textContent, 'Вчера работих.');
  assert.match(lines(section(page, 'merged'))[0]!, /Стар проблем\./);
  assert.equal(await copy(page, copied), 'Since Friday:\n- Вчера работих.');
  // Repositories: the old strings too.
  tab(page, 1).click();
  await page.flush();
  assert.equal(digest(page).querySelector('.dg-headline')!.textContent, 'Стар.');
});

test('digest client: several apps group the lines under the app (sections 1, 2, 3, 5) or the workspace (section 4), each app its own Copy', async () => {
  const data = record({
    workspaces: [workspace('api', 'shop', { git: git([landedEntry('aaa1', '2026-11-09T03:00:00.000Z')]) }), workspace('tool', 'tools', { git: git([landedEntry('ddd4', '2026-11-09T03:30:00.000Z', { ticket: 'TL-1', subject: 'TL-1: A tool' })]) })],
    output: {
      repos: [], cross_repo: [{ ticket: 'TL-2', by_workspace: { tool: t('Т.', 'T.') }, for_me: t('Виж TL-2.', 'See TL-2.') }],
      dailies: [
        { app: 'shop', workspaces: ['api'], yesterday: [t('Магазин.', 'Shop.')], problems: [], plan: [], next: [] },
        { app: 'tools', workspaces: ['tool'], yesterday: [t('Инструмент.', 'Tool.')], problems: [], plan: [], next: [] },
      ],
    },
    in_progress: [],
    daily_sources: [],
  });
  const { page, copied } = await openDigest(data);
  assert.deepEqual(section(page, 'yesterday').querySelectorAll('.dg-group .dg-name').map((node) => node.textContent), ['shop', 'tools']);
  assert.deepEqual(section(page, 'merged').querySelectorAll('.dg-group .dg-name').map((node) => node.textContent), ['api', 'tool']);
  assert.deepEqual(section(page, 'waiting').querySelectorAll('.dg-group .dg-name').map((node) => node.textContent), ['tools']);
  assert.deepEqual(digest(page).querySelectorAll('.dg-app').map((node) => node.dataset.app), ['shop', 'tools']);
  assert.deepEqual(digest(page).querySelectorAll('.dg-app .dg-name').map((node) => node.textContent), ['shop', 'tools']);
  assert.equal(digest(page).querySelectorAll('.dg-app summary').length, 0);
  await choose(page, 'local');
  assert.equal(await copy(page, copied, 'tools'), 'От петък:\n- Инструмент.\nЧака мен:\n- TL-2: Виж TL-2.');
  assert.equal(await copy(page, copied, 'shop'), 'От петък:\n- Магазин.');
});

test('digest client: a Brief with no item keeps the empty card', async () => {
  const { page } = await openDigest(record({ output: null, in_progress: [], workspaces: [workspace('api', 'shop', { git: git([]) })], daily_sources: [] }));
  assert.match(digest(page).querySelector('.dg-empty')!.textContent, /^No daily in this digest/);
  assert.equal(digest(page).querySelector('.dg-brief'), null);
});

test('digest client: the schedule line, its Edit, Save (the refusal next to the field, kept over a redraw) and Cancel', async () => {
  const none = await openDigest(record(), storage(), null);
  assert.equal(digest(none.page).querySelector('.dg-sched'), null);
  const { page } = await openDigest(record());
  const sched = (): FakeElement => digest(page).querySelector('.dg-sched')!;
  assert.equal(sched().querySelector('span')!.textContent, 'Updates at 08:30 · 10:45 (weekdays)');
  page.streams.at(-1)!.emit('workspaces', { workspaces: [], handoff_default: 'checkout', digest: { ...SETTINGS, weekdays_only: false } });
  await page.flush();
  assert.equal(sched().querySelector('span')!.textContent, 'Updates at 08:30 · 10:45 (every day)');
  sched().querySelector('[data-dg="sched-edit"]')!.click();
  await page.flush();
  const field = (): FakeElement => sched().querySelector('[data-dg="times"]')!;
  assert.equal(field().value, '08:30, 10:45');
  field().value = '07:00, 07:00';
  field().dispatch('input');
  sched().querySelector('[data-dg="sched-save"]')!.click();
  await page.flush();
  const posts = page.requests.filter((request) => request.method === 'POST');
  assert.deepEqual([posts[0]!.path, JSON.parse(posts[0]!.body!)], ['api/digest-settings', { times: ['07:00', '07:00'] }]);
  posts[0]!.respond(400, { ok: false, error: { code: 'invalid_digest_settings', message: '1 to 4 times, each HH:MM from 00:00 to 23:59, no time twice.' } });
  await page.flush();
  assert.equal(sched().querySelector('.err-text')!.textContent, '1 to 4 times, each HH:MM from 00:00 to 23:59, no time twice.');
  // A redraw (the next workspaces event) keeps the typed text and the refusal.
  page.streams.at(-1)!.emit('workspaces', { workspaces: [], handoff_default: 'checkout', digest: SETTINGS });
  await page.flush();
  assert.equal(field().value, '07:00, 07:00');
  assert.equal(sched().querySelector('.err-text')!.textContent, '1 to 4 times, each HH:MM from 00:00 to 23:59, no time twice.');
  field().value = ' 07:00 , 12:15,';
  field().dispatch('input');
  sched().querySelector('[data-dg="sched-save"]')!.click();
  await page.flush();
  const second = page.requests.filter((request) => request.method === 'POST')[1]!;
  assert.deepEqual(JSON.parse(second.body!), { times: ['07:00', '12:15'] });
  second.respond(200, { ok: true, result: { times: ['07:00', '12:15'], weekdays_only: true, language: 'Bulgarian' } });
  await page.flush();
  assert.equal(sched().querySelector('[data-dg="times"]'), null);
  assert.equal(sched().querySelector('span')!.textContent, 'Updates at 07:00 · 12:15 (weekdays)');
  // Cancel closes without a post.
  sched().querySelector('[data-dg="sched-edit"]')!.click();
  await page.flush();
  sched().querySelector('[data-dg="sched-cancel"]')!.click();
  await page.flush();
  assert.equal(sched().querySelector('[data-dg="times"]'), null);
  assert.equal(page.requests.filter((request) => request.method === 'POST').length, 2);
});

test('digest client: the Repositories tab: its headings and the model texts through the switch', async () => {
  const { page } = await openDigest(record());
  tab(page, 1).click();
  await page.flush();
  const card = digest(page).querySelector('.dg-repo[data-ws="api"]')!;
  assert.equal(digest(page).querySelector('.dg-cross h3')!.textContent, 'Една задача в приложението · One ticket across the app');
  assert.equal(card.querySelector('.dg-impact h4')!.textContent, 'Ефект върху моята работа · Effect on my work');
  assert.deepEqual(card.querySelectorAll('.dg-sec h4').map((node) => node.textContent), ['Слято в main · Landed on main', 'Живи клонове · Live branches']);
  assert.equal(card.querySelector('.dg-headline')!.textContent, 'Списъкът слезе.The list landed.');
  assert.equal(card.querySelector('.dg-headline .dg-en')!.textContent, 'The list landed.');
  assert.deepEqual(digest(page).querySelectorAll('.dgx tbody td').map((node) => node.textContent), ['SHOP-7', 'Крайна точка.An endpoint.', 'Страница.A page.', 'Нищо.Nothing.']);
  await choose(page, 'en');
  assert.equal(digest(page).querySelector('.dg-cross h3')!.textContent, 'One ticket across the app');
  assert.equal(digest(page).querySelector('.dg-repo[data-ws="api"] .dg-headline')!.textContent, 'The list landed.');
  assert.match(digest(page).querySelector('.dg-repo[data-ws="api"] .dg-landed')!.textContent, /The shop shows its orders\./);
  assert.equal(digest(page).querySelector('.dg-repo[data-ws="api"] .dg-impact li')!.textContent, 'SHOP-8 needs the latest changes.');
  await choose(page, 'local');
  assert.equal(digest(page).querySelector('.dg-repo[data-ws="api"] .dg-headline')!.textContent, 'Списъкът слезе.');
});
