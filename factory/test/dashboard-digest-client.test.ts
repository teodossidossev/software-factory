// My daily's headings in static/reports.js (SF-156), run under node:vm against the fake page of
// test/support/fake-dom.ts: the first heading names the span ("Yesterday", or "Since <weekday>"
// when it starts earlier than the day before the digest, local dates), the four headings follow the
// record's language (Bulgarian, else English), and Copy's text has the same headings. Script
// checks, not browser acceptance: the layout is test/browser/digest-page.test.ts.
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

function record(extra: Record<string, unknown>) {
  return {
    id: ID, trigger: 'scheduled', ended_at: '2026-11-09T05:02:00.000Z', period: { from: '2026-11-06T06:00:00.000Z', to: '2026-11-09T05:00:00.000Z' },
    model: 'sonnet', language: 'English', workspaces: [], notes: [], cost_usd: 0.2, error: null, counts: { landed: 0, live_branches: 0, impact: 0 },
    daily_sources: [{ app: 'shop', workspaces: ['api'], commits: [], open_branches: [] }],
    output: { repos: [], cross_repo: [], dailies: [{ app: 'shop', workspaces: ['api'], yesterday: ['Работих по SHOP-8.'], problems: ['P.'], plan: ['Пл.'], next: ['Д.'] }] },
    ...MONDAY, ...extra,
  };
}

// The digest page with the record, on its My daily tab; Copy writes to the returned clipboard.
async function openDaily(data: Record<string, unknown>): Promise<{ page: Page; copied: string[] }> {
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
  }, clipboard);
  page.location.hash = `#digest/${ID}`;
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  page.streams.at(-1)!.emit('open');
  await page.flush();
  tab(page, 'My daily').click();
  await page.flush();
  return { page, copied };
}

const tab = (page: Page, name: string): FakeElement => page.$('digest').querySelectorAll('[role="tab"]').find((node) => node.textContent === name)!;
const tabNames = (page: Page): string[] => page.$('digest').querySelectorAll('[role="tab"]').map((node) => node.textContent);
const daily = (page: Page): FakeElement => page.$('digest').querySelector('.dg-daily[data-app="shop"]')!;
const headings = (page: Page): string[] => daily(page).querySelectorAll('.dg-sec h4').map((node) => node.textContent);

async function copy(page: Page, copied: string[]): Promise<string[]> {
  daily(page).querySelector('[data-dg="copy"]')!.click();
  await page.flush();
  return copied.at(-1)!.split('\n').filter((line) => !line.startsWith('- '));
}

test('digest client: a Monday daily from Friday shows "Since Friday", in Bulgarian "От петък"; Copy has the same headings', async () => {
  const english = await openDaily(record({}));
  assert.deepEqual(headings(english.page), ['Since Friday', 'Problems', 'Plan', 'Today']);
  assert.deepEqual(await copy(english.page, english.copied), ['Since Friday:', 'Problems:', 'Plan:', 'Today:']);

  const bulgarian = await openDaily(record({ language: 'Bulgarian' }));
  assert.deepEqual(headings(bulgarian.page), ['От петък', 'Проблеми', 'План', 'Днес']);
  assert.deepEqual(await copy(bulgarian.page, bulgarian.copied), ['От петък:', 'Проблеми:', 'План:', 'Днес:']);
  assert.equal(bulgarian.copied[0], ['От петък:', '- Работих по SHOP-8.', 'Проблеми:', '- P.', 'План:', '- Пл.', 'Днес:', '- Д.'].join('\n'));
  // Nothing else on the page changes language.
  assert.deepEqual(tabNames(bulgarian.page), ['Repositories', 'My daily']);
  assert.equal(daily(bulgarian.page).querySelector('summary')!.textContent, 'The commits it was made from (0)');
  assert.equal(daily(bulgarian.page).querySelector('[data-dg="copy"]')!.textContent, 'Copy');
});

test('digest client: a Wednesday daily (03:00 local) shows "Yesterday" and "Вчера"; a record without daily_days shows "Yesterday"', async () => {
  const english = await openDaily(record(WEDNESDAY));
  assert.deepEqual(headings(english.page), ['Yesterday', 'Problems', 'Plan', 'Today']);
  assert.deepEqual(await copy(english.page, english.copied), ['Yesterday:', 'Problems:', 'Plan:', 'Today:']);
  for (const language of ['bg', 'BG', 'български', 'Български', 'bulgarian']) {
    const bulgarian = await openDaily(record({ ...WEDNESDAY, language }));
    assert.deepEqual(headings(bulgarian.page), ['Вчера', 'Проблеми', 'План', 'Днес'], language);
    assert.deepEqual(await copy(bulgarian.page, bulgarian.copied), ['Вчера:', 'Проблеми:', 'План:', 'Днес:'], language);
  }
  const older = await openDaily(record({ daily_days: undefined }));
  assert.deepEqual(headings(older.page), ['Yesterday', 'Problems', 'Plan', 'Today']);
});

test('digest client: an unknown, empty or missing language gets the English headings', async () => {
  for (const language of ['Deutsch', '', undefined, null]) {
    const { page, copied } = await openDaily(record({ language }));
    assert.deepEqual(headings(page), ['Since Friday', 'Problems', 'Plan', 'Today'], String(language));
    assert.deepEqual(await copy(page, copied), ['Since Friday:', 'Problems:', 'Plan:', 'Today:'], String(language));
  }
});

test('digest client: a section with no items is left out, on the card and in Copy; an empty daily keeps its title, commits and Copy', async () => {
  const quiet = (sections: Record<string, string[]>) => record({ output: { repos: [], cross_repo: [], dailies: [{ app: 'shop', workspaces: ['api'], yesterday: ['SHOP-8 (the order list): the shop lists its orders.'], problems: [], plan: [], next: ['SHOP-8 (the order list): add paging.'], ...sections }] } });
  const { page, copied } = await openDaily(quiet({}));
  assert.deepEqual(headings(page), ['Since Friday', 'Today']);
  assert.doesNotMatch(daily(page).textContent, /None\./);
  await copy(page, copied);
  assert.equal(copied[0], ['Since Friday:', '- SHOP-8 (the order list): the shop lists its orders.', 'Today:', '- SHOP-8 (the order list): add paging.'].join('\n'));
  assert.doesNotMatch(copied[0]!, /Problems|Plan/);

  const empty = await openDaily(quiet({ yesterday: [], next: [] }));
  assert.deepEqual(headings(empty.page), []);
  assert.doesNotMatch(daily(empty.page).textContent, /None\./);
  assert.equal(daily(empty.page).querySelector('.dg-name')!.textContent, 'shop');
  assert.equal(daily(empty.page).querySelector('summary')!.textContent, 'The commits it was made from (0)');
  assert.equal(daily(empty.page).querySelector('[data-dg="copy"]')!.textContent, 'Copy');
});
