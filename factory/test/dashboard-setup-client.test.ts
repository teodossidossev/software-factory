// Behaviour of the setup in static/setup.js (SF-025, SF-046), run under node:vm against the fake
// page of test/support/fake-dom.ts: Workspaces and New ticket in the drawer from the header, the
// workspace form and list, the new-ticket form, on the planned ticket page (SF-081) the
// conversation link (a click, never automatic) and the first message's Copy, an archived Task in
// the drawer, and the Start of a ticket whose Task file is written, on its Queue card (SF-040);
// New ticket's images (SF-064): paste and drop, the thumbnails and ×, the uploads after Create and
// a failed one.
// Script checks, not browser acceptance: the manual steps are in factory/README.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
const PREFIX = 'https://chatgpt.com/?q=';

function job(ticket: string, state = 'awaiting_review') {
  return {
    workspace: 'app', ticket, branch: `${ticket}-demo`, base: 'main', state, iteration: 1, mr_attempts: 0,
    updated_at: '2026-11-01T10:05:00.000Z', created_at: '2026-11-01T10:00:00.000Z', error: null,
  };
}

function detail(ticket: string) {
  return { job: job(ticket), iterations: [], mr: false, history: [] };
}

const workspace = (name: string, liveJobs = 0, problem: string | null = null, handoff: 'checkout' | 'off' | null = null) => ({ name, path: `/srv/${name}`, liveJobs, problem, handoff });

function ticket(key: string, extra: Record<string, unknown> = {}) {
  const [workspaceName, name] = key.split('/') as [string, string];
  const message = `Use the Software Factory connector for ${name}.`;
  return {
    workspace: workspaceName, ticket: name, title: `Ticket ${name}`, base: 'main', draft: true, job: null,
    conversation: { message, url: `${PREFIX}${encodeURIComponent(message)}` }, ...extra,
  };
}

// The page with the given jobs loaded and the stream's first workspaces and tickets delivered.
async function openPage(jobs: ReturnType<typeof job>[], workspaces: ReturnType<typeof workspace>[], tickets: ReturnType<typeof ticket>[], clipboard?: { writeText(text: string): Promise<void> }): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs };
    }
    const match = /^api\/jobs\/([^/]+)\/([^/]+)$/.exec(path);
    return match ? detail(match[2]!) : undefined;
  }, clipboard);
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs });
  stream.emit('workspaces', { workspaces });
  stream.emit('tickets', { tickets });
  if (jobs.length > 0) {
    stream.emit('job', detail(jobs[0]!.ticket));
  }
  await page.flush();
  return page;
}

const posts = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'POST');
const items = (page: Page, id: string): FakeElement[] => page.$(id).children.filter((child): child is FakeElement => (child as FakeElement).tagName === 'LI');
const buttons = (item: FakeElement): FakeElement[] => item.all().filter((element) => element.tagName === 'BUTTON');
const named = (item: FakeElement, text: string): FakeElement => buttons(item).find((button) => button.textContent === text)!;
const link = (item: FakeElement): FakeElement | undefined => item.all().find((element) => element.tagName === 'A');

test('setup client: Workspaces and New ticket open in the drawer from the header; the lists, the forms and the board hint follow the stream', async () => {
  const empty = await openPage([], [], []);
  assert.equal(empty.$('drawer').hidden, true);
  assert.equal(empty.$('board-hint').textContent, 'No workspace yet: Workspaces adds the local checkout of a repository to work in.');
  assert.equal(empty.$('ticket-create').disabled, true);
  assert.equal(empty.$('ticket-workspace').disabled, true);
  // Workspaces: the drawer shows its panel only.
  empty.$('open-workspaces').click();
  assert.deepEqual([empty.$('drawer').hidden, empty.$('scrim').hidden, empty.$('drawer-title').textContent], [false, false, 'Workspaces']);
  assert.deepEqual(['workspaces-panel', 'ticket-panel', 'archived-panel', 'task-panel'].map((id) => empty.$(id).hidden), [false, true, true, true]);
  assert.equal(empty.$('no-workspaces').hidden, false);
  assert.equal(empty.document.activeElement, empty.$('drawer-close'));

  // A workspace: the hint asks for a ticket; the ticket form is usable.
  const stream = empty.streams.at(-1)!;
  stream.emit('workspaces', { workspaces: [workspace('app')] });
  assert.equal(empty.$('no-workspaces').hidden, true);
  assert.equal(empty.$('board-hint').textContent, 'No ticket yet: New ticket writes one, and its conversation plans it.');
  empty.$('open-new-ticket').click();
  assert.deepEqual(['workspaces-panel', 'ticket-panel'].map((id) => empty.$(id).hidden), [true, false]);
  assert.equal(empty.$('drawer-title').textContent, 'New ticket');
  assert.equal(empty.$('ticket-create').disabled, false);
  assert.deepEqual(empty.$('ticket-workspace').children.map((option) => (option as FakeElement).value), ['app']);
  assert.equal(empty.$('ticket-workspace').value, 'app');
  // Close, the scrim and Escape close the drawer.
  empty.$('drawer-close').click();
  assert.deepEqual([empty.$('drawer').hidden, empty.$('scrim').hidden], [true, true]);
  empty.$('open-workspaces').click();
  empty.$('scrim').click();
  assert.equal(empty.$('drawer').hidden, true);
  empty.$('open-workspaces').click();
  empty.$('drawer').dispatch('keydown', { key: 'Escape' });
  assert.equal(empty.$('drawer').hidden, true);

  // Workspaces and jobs: no hint (one page at a time: the fake streams belong to the last page loaded).
  const busy = await openPage([job('T-1')], [workspace('app', 1), workspace('web', 0, 'The work checkout does not exist.')], [ticket('app/T-5'), ticket('web/W-1')]);
  assert.equal(busy.$('board-hint').hidden, true);
  // The list: name, path, the problem, and Remove off while a job is live.
  const [app, web] = items(busy, 'workspace-list');
  assert.equal((app!.children[0] as FakeElement).textContent, 'app');
  assert.equal((app!.children[1] as FakeElement).textContent, '/srv/app');
  assert.equal(named(app!, 'Remove').disabled, true);
  assert.match(app!.textContent, /1 live job: finish or abort them first\./);
  assert.equal((web!.children[2] as FakeElement).className, 'ws-problem');
  assert.equal((web!.children[2] as FakeElement).textContent, 'The work checkout does not exist.');
  assert.equal(named(web!, 'Remove').disabled, false);
  // The hand-over setting (SF-083): the workspace's own, or SF_HANDOFF's.
  assert.equal(app!.querySelector('.ws-handoff')!.textContent, 'Hand-over: as SF_HANDOFF');
  busy.streams.at(-1)!.emit('workspaces', { workspaces: [workspace('app', 0, null, 'off')] });
  assert.equal(items(busy, 'workspace-list')[0]!.querySelector('.ws-handoff')!.textContent, 'Hand-over: off (this workspace)');
  // The workspace choice keeps its value while the options are replaced.
  busy.$('ticket-workspace').value = 'web';
  busy.streams.at(-1)!.emit('workspaces', { workspaces: [workspace('app'), workspace('web')] });
  assert.equal(busy.$('ticket-workspace').value, 'web');
  busy.streams.at(-1)!.emit('workspaces', { workspaces: [workspace('app')] });
  assert.equal(busy.$('ticket-workspace').value, 'app');
});

test('setup client: the workspace form posts once, reports the answer, clears only on success; Remove posts the name', async () => {
  const page = await openPage([], [], []);
  page.$('workspace-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 0);
  assert.match(page.$('workspace-status').textContent, /A name and the path of the local checkout are needed\./);
  page.$('workspace-name').value = ' app ';
  page.$('workspace-path').value = '/home/me/app ';
  page.$('workspace-form').dispatch('submit');
  page.$('workspace-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.deepEqual([posts(page)[0]!.path, JSON.parse(posts(page)[0]!.body!), posts(page)[0]!.headers['content-type']], ['api/workspaces', { name: 'app', path: '/home/me/app' }, 'application/json']);
  assert.equal(page.$('workspace-status').className, 'status pending');
  assert.equal(page.$('workspace-add').disabled, false);
  posts(page)[0]!.respond(400, { ok: false, error: { code: 'workspace_invalid', message: 'The path is not the root of a non-bare Git work tree.' } });
  await page.flush();
  assert.equal(page.$('workspace-status').textContent, 'workspace_invalid: The path is not the root of a non-bare Git work tree.');
  assert.equal(page.$('workspace-status').className, 'status error');
  assert.equal(page.$('workspace-name').value, ' app ');
  page.$('workspace-form').dispatch('submit');
  await page.flush();
  posts(page)[1]!.respond(200, { ok: true, result: { name: 'app', path: '/home/me/app', liveJobs: 0, problem: null } });
  await page.flush();
  assert.equal(page.$('workspace-status').textContent, 'Registered app (/home/me/app). Next: New ticket.');
  assert.equal(page.$('workspace-status').className, 'status ok');
  assert.deepEqual([page.$('workspace-name').value, page.$('workspace-path').value], ['', '']);
  // A network failure says it may have taken effect.
  page.$('workspace-name').value = 'web';
  page.$('workspace-path').value = '/w';
  page.$('workspace-form').dispatch('submit');
  await page.flush();
  posts(page)[2]!.fail();
  await page.flush();
  assert.match(page.$('workspace-status').textContent, /^The request failed \(Failed to fetch\); it may have taken effect\./);

  // Remove: the name in the path, the answer as text.
  page.streams.at(-1)!.emit('workspaces', { workspaces: [workspace('app')] });
  named(items(page, 'workspace-list')[0]!, 'Remove').click();
  await page.flush();
  assert.deepEqual([posts(page)[3]!.path, posts(page)[3]!.body], ['api/workspaces/app/remove', '{}']);
  posts(page)[3]!.respond(200, { ok: true, result: { removed: 'app' } });
  await page.flush();
  assert.equal(page.$('workspace-status').textContent, 'Removed app from the registry; the checkout and its files are untouched.');
  page.streams.at(-1)!.emit('workspaces', { workspaces: [workspace('app', 1)] });
  named(items(page, 'workspace-list')[0]!, 'Remove').click();
  await page.flush();
  assert.equal(posts(page).length, 4);

  // The hand-over choice (SF-083): sent only when chosen, cleared with the fields on success.
  page.$('workspace-name').value = 'own';
  page.$('workspace-path').value = '/srv/own';
  page.$('workspace-handoff').value = 'off';
  page.$('workspace-form').dispatch('submit');
  await page.flush();
  assert.deepEqual(JSON.parse(posts(page)[4]!.body!), { name: 'own', path: '/srv/own', handoff: 'off' });
  posts(page)[4]!.respond(200, { ok: true, result: workspace('own', 0, null, 'off') });
  await page.flush();
  assert.deepEqual([page.$('workspace-name').value, page.$('workspace-path').value, page.$('workspace-handoff').value], ['', '', '']);
});

// A workspace row as the server sends it since SF-103.
const row103 = (name: string, extra: Record<string, unknown> = {}) => ({
  ...workspace(name), color: 'teal', app: name, description: null, derived_description: `The ${name} from its README.`, digest: { track: false, my_work: false }, ...extra,
});

test('setup client (SF-103): the card shows the app, the description and the digest switches; Add sends the new fields; Default names SF_HANDOFF\'s value', async () => {
  const page = await openPage([], [], []);
  const stream = page.streams.at(-1)!;
  stream.emit('workspaces', {
    workspaces: [row103('api', { app: 'shop', description: 'The shop backend.', digest: { track: true, my_work: false } }), row103('web', { app: 'shop' }), row103('tools')],
    handoff_default: 'off', digest: { at: '07:45', weekdays_only: false, language: 'Deutsch' },
  });
  await page.flush();
  const [api, web, tools] = items(page, 'workspace-list');
  assert.equal(api!.querySelector('.ws-app')!.textContent, 'shop');
  assert.equal(api!.querySelector('.ws-description')!.textContent, 'The shop backend.');
  assert.equal(api!.querySelector('.ws-digest')!.textContent, 'Morning digest: on · My daily: off');
  assert.equal(web!.querySelector('.ws-description')!.textContent, 'The web from its README. (from the repository)');
  assert.equal(tools!.querySelector('.ws-app'), null);
  assert.equal(tools!.querySelector('.ws-digest')!.textContent, 'Morning digest: off · My daily: off');
  // The App suggestions: the existing apps, once each.
  assert.deepEqual(page.$('workspace-apps').children.map((option) => (option as FakeElement).value), ['shop', 'tools']);
  assert.equal((page.$('workspace-handoff').children[0] as FakeElement).textContent, 'Default (now: no, from SF_HANDOFF)');
  assert.deepEqual([page.$('digest-at').value, page.$('digest-weekdays').checked, page.$('digest-language').value], ['07:45', false, 'Deutsch']);

  page.$('workspace-name').value = 'mobile';
  page.$('workspace-path').value = '/srv/mobile';
  page.$('workspace-description').value = ' The app for phones. ';
  page.$('workspace-app').value = 'shop';
  page.$('workspace-mywork').checked = true;
  page.$('workspace-form').dispatch('submit');
  await page.flush();
  assert.deepEqual(JSON.parse(posts(page)[0]!.body!), { name: 'mobile', path: '/srv/mobile', description: 'The app for phones.', app: 'shop', digest: { track: false, my_work: true } });
  posts(page)[0]!.respond(200, { ok: true, result: { name: 'mobile', path: '/srv/mobile' } });
  await page.flush();
  assert.deepEqual([page.$('workspace-description').value, page.$('workspace-app').value, page.$('workspace-mywork').checked], ['', '', false]);
});

test('setup client (SF-103): Edit opens the card as a form with every field, Save posts them all once, Cancel changes nothing; a refusal stays in the form', async () => {
  const page = await openPage([], [], []);
  const stream = page.streams.at(-1)!;
  const rows = [row103('api', { app: 'shop', description: 'The shop backend.', handoff: 'off', color: 'red', digest: { track: true, my_work: false } }), row103('web', { color: 'purple' })];
  stream.emit('workspaces', { workspaces: rows, handoff_default: 'checkout', digest: { at: '08:00', weekdays_only: true, language: 'English' } });
  await page.flush();
  named(items(page, 'workspace-list')[0]!, 'Edit').click();
  await page.flush();
  const form = (): FakeElement => items(page, 'workspace-list')[0]!.querySelector('form')!;
  const field = (key: string): FakeElement => form().querySelector(`[data-wsf="${key}"]`)!;
  assert.deepEqual([field('path').value, field('description').value, (field('description') as unknown as Record<string, unknown>).placeholder, field('app').value, field('handoff').value, field('color').value, field('track').checked, field('my_work').checked],
    ['/srv/api', 'The shop backend.', 'The api from its README.', 'shop', 'off', 'red', true, false]);
  assert.equal((field('handoff').children[0] as FakeElement).textContent, 'Default (now: yes, from SF_HANDOFF)');
  // Labels in plain words, each with its own line.
  assert.match(form().textContent, /Path of the local checkout[\s\S]*Description[\s\S]*App[\s\S]*When a job is ready, hand it over to my checkout[\s\S]*Colour of its cards on the board[\s\S]*Morning digest: follow this repository[\s\S]*My daily: my commits here go into the daily of its app/);
  // The other card's Edit is off while one is open; a redraw keeps what is typed.
  assert.equal(named(items(page, 'workspace-list')[1]!, 'Edit').disabled, true);
  field('description').value = '';
  field('app').value = 'store';
  stream.emit('workspaces', { workspaces: rows, handoff_default: 'checkout', digest: { at: '08:00', weekdays_only: true, language: 'English' } });
  await page.flush();
  assert.equal(field('app').value, 'store');
  // Cancel: no request, the card again.
  named(form(), 'Cancel').click();
  await page.flush();
  assert.equal(items(page, 'workspace-list')[0]!.querySelector('form'), null);
  assert.equal(posts(page).length, 0);
  // Save: every field, once.
  named(items(page, 'workspace-list')[0]!, 'Edit').click();
  field('path').value = ' /srv/api2 ';
  field('description').value = '';
  field('handoff').value = 'default';
  field('color').value = 'auto';
  field('my_work').checked = true;
  form().dispatch('submit');
  form().dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.equal(posts(page)[0]!.path, 'api/workspaces/api/edit');
  assert.deepEqual(JSON.parse(posts(page)[0]!.body!), { path: '/srv/api2', description: '', app: 'shop', handoff: 'default', color: 'auto', digest: { track: true, my_work: true } });
  posts(page)[0]!.respond(409, { ok: false, error: { code: 'workspace_busy', message: 'workspace "api" has a live job (A-1 working).' } });
  await page.flush();
  assert.equal(field('status').textContent, 'workspace_busy: workspace "api" has a live job (A-1 working).');
  assert.equal(field('path').value, ' /srv/api2 ');
  form().dispatch('submit');
  await page.flush();
  posts(page)[1]!.respond(200, { ok: true, result: rows[0] });
  await page.flush();
  assert.equal(items(page, 'workspace-list')[0]!.querySelector('form'), null);
  assert.equal(page.$('workspace-status').textContent, 'Saved api.');
  // A colour that is the one its name picks shows as Automatic.
  named(items(page, 'workspace-list')[1]!, 'Edit').click();
  assert.equal(items(page, 'workspace-list')[1]!.querySelector('[data-wsf="color"]')!.value, 'auto');
});

test('setup client (SF-103): the Morning digest section saves the time, weekdays only and the language; typed values stay over a redraw', async () => {
  const page = await openPage([], [], []);
  const stream = page.streams.at(-1)!;
  stream.emit('workspaces', { workspaces: [row103('app')], handoff_default: 'checkout', digest: { at: '08:00', weekdays_only: true, language: 'English' } });
  await page.flush();
  page.$('digest-at').value = '06:30';
  page.$('digest-at').dispatch('input');
  page.$('digest-weekdays').checked = false;
  page.$('digest-language').value = ' Български ';
  stream.emit('workspaces', { workspaces: [row103('app')], handoff_default: 'checkout', digest: { at: '08:00', weekdays_only: true, language: 'English' } });
  await page.flush();
  assert.equal(page.$('digest-at').value, '06:30');
  page.$('digest-form').dispatch('submit');
  await page.flush();
  assert.deepEqual([posts(page)[0]!.path, JSON.parse(posts(page)[0]!.body!)], ['api/digest-settings', { at: '06:30', weekdays_only: false, language: 'Български' }]);
  posts(page)[0]!.respond(200, { ok: true, result: { at: '06:30', weekdays_only: false, language: 'Български' } });
  await page.flush();
  assert.equal(page.$('digest-status').textContent, 'Saved: 06:30 every day, in Български. sf serve uses it at its next check.');
  page.$('digest-language').value = '';
  page.$('digest-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.equal(page.$('digest-status').textContent, 'A time (HH:MM) and a language are needed.');
});

test('setup client: the new-ticket form posts the exact fields, clears on success, keeps them on a refusal', async () => {
  const page = await openPage([], [workspace('app'), workspace('web')], []);
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 0);
  assert.match(page.$('ticket-status').textContent, /all needed/);
  assert.equal(page.$('owner-chatgpt').checked, true);
  assert.equal(page.$('owner-claude').disabled, true);
  page.$('ticket-workspace').value = 'web';
  page.$('ticket-key').value = ' W-7 ';
  page.$('ticket-title').value = ' Seven ';
  const request = 'Make it so.\n\nWith "quotes" — ünïcödé 🚀 ';
  page.$('ticket-request').value = request;
  page.$('ticket-form').dispatch('submit');
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.deepEqual([posts(page)[0]!.path, JSON.parse(posts(page)[0]!.body!)], ['api/tickets', { workspace: 'web', ticket: 'W-7', title: 'Seven', request }]);
  assert.equal(page.$('ticket-create').disabled, true);
  posts(page)[0]!.respond(409, { ok: false, error: { code: 'ticket_exists', message: '.software-factory/W-7.md already exists in workspace "web"; the ticket is listed below.' } });
  await page.flush();
  assert.equal(page.$('ticket-status').textContent, 'ticket_exists: .software-factory/W-7.md already exists in workspace "web"; the ticket is listed below.');
  assert.equal(page.$('ticket-create').disabled, false);
  assert.equal(page.$('ticket-request').value, request);
  // Created (SF-066): the dialog closes, the message goes to the toast, and the new ticket's card is
  // scrolled to and highlighted once the stream lists it; nothing else opens.
  page.$('open-new-ticket').click();
  assert.equal(page.$('drawer').hidden, false);
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  posts(page)[1]!.respond(200, { ok: true, result: { workspace: 'web', ticket: 'W-7', path: '.software-factory/W-7.md', base: 'develop' } });
  await page.flush();
  assert.equal(page.$('drawer').hidden, true);
  assert.equal(page.$('ticket-status').textContent, '');
  assert.equal(page.$('toast-text').textContent, 'Ticket created: .software-factory/W-7.md in web (base develop), an empty skeleton in the Queue. Next: a click on its card opens the conversation; your words are its first message.');
  assert.deepEqual([page.$('ticket-key').value, page.$('ticket-title').value, page.$('ticket-request').value, page.$('ticket-workspace').value], ['', '', '', 'web']);
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('web/W-7')], archived: [] });
  const card = items(page, 'qlist').find((item) => item.dataset.ticket === 'web/W-7')!;
  assert.deepEqual([card.className, card.scrolledIntoView, page.document.activeElement === card], ['card hl', 1, true]);
  assert.equal(page.location.hash, '');
  assert.deepEqual(page.requests.filter((request) => request.path.startsWith('http')), []);
});

// The planned ticket page of a Queue card (SF-081): a click on the card, its page answered from
// the card's row.
async function openTaskOf(page: Page, key: string, row: ReturnType<typeof ticket>): Promise<void> {
  items(page, 'qlist').find((item) => item.dataset.ticket === key)!.click();
  await page.flush();
  const text = `---\nticket: ${row.ticket}\ntitle: ${row.title}\nbase: main\n---\n`;
  page.requests.find((request) => request.path === `api/tickets/${key}/page`)!.respond(200, {
    ticket: row, task: { text, sha256: 'a'.repeat(64) }, plan: { starts_from: 'main', files: [], scoped: false, waits_for: [] }, check: null, history: [], queue: null,
  });
  await page.flush();
}

// The page's Planning conversation card.
const conversationCard = (page: Page): FakeElement => page.$('ticket').querySelectorAll('.card2').find((card) => card.querySelector('h3')?.textContent === 'Planning conversation')!;

test('setup client: the planned ticket page offers the ticket\'s conversation, a click away, and its first message to copy; only the server\'s ChatGPT URL becomes a link', async () => {
  const written: string[] = [];
  const rows = [ticket('app/T-5'), ticket('app/T-7', { conversation: { message: 'x', url: 'javascript:alert(1)' } })];
  const page = await openPage([], [workspace('app')], rows, { writeText: async (text) => void written.push(text) });
  // No reviewer line anywhere on the board (SF-040 removes the ChatGPT reviewer).
  assert.doesNotMatch(page.$('qlist').textContent, /Reviewer/);
  await openTaskOf(page, 'app/T-5', rows[0]!);
  const url = `${PREFIX}${encodeURIComponent('Use the Software Factory connector for T-5.')}`;
  const card = conversationCard(page);
  const open = link(card)!;
  assert.deepEqual([open.textContent, open.href, open.target, open.rel], ['Open the ChatGPT conversation ↗', url, '_blank', 'noopener noreferrer']);
  // The header's link too.
  const head = link(page.$('ticket').querySelector('header.jhead')!)!;
  assert.deepEqual([head.className, head.href, head.target, head.rel], ['btn linkbtn', url, '_blank', 'noopener noreferrer']);
  assert.equal(card.querySelector('pre.cm')!.textContent, 'Use the Software Factory connector for T-5.');
  // Nothing opened by itself: no request but the page, no navigation.
  assert.deepEqual(page.requests.filter((request) => request.path.startsWith('http')), []);
  buttons(card).find((button) => button.textContent === 'Copy')!.click();
  await page.flush();
  assert.deepEqual(written, ['Use the Software Factory connector for T-5.']);
  assert.match(conversationCard(page).textContent, /Copied\./);
  // A URL that is not the ChatGPT prefill is not linked anywhere on the page.
  page.$('ticket').querySelector('[data-back]')!.click();
  await openTaskOf(page, 'app/T-7', rows[1]!);
  assert.deepEqual(page.$('ticket').all().filter((element) => element.tagName === 'A').map((element) => element.href), []);
  assert.equal(conversationCard(page).querySelector('pre.cm')!.textContent, 'x');
});

test('setup client: a message too long for a link is offered to copy; an archived Task opens in the drawer, without a conversation', async () => {
  const long = 'x'.repeat(9000);
  const row = ticket('app/T-8', { conversation: { message: long, url: null } });
  const page = await openPage([], [workspace('app')], [row]);
  await openTaskOf(page, 'app/T-8', row);
  const card = conversationCard(page);
  assert.equal(link(card), undefined);
  assert.match(card.textContent, /too long for a link: copy it into a new ChatGPT conversation of this project/);
  assert.equal(card.querySelector('pre.cm')!.textContent, long);
  page.$('ticket').querySelector('[data-back]')!.click();
  page.streams.at(-1)!.emit('tickets', { tickets: [], archived: [{ workspace: 'app', ticket: 'T-4', title: 'Four' }] });
  page.$('open-archived').click();
  const [entry] = items(page, 'archived-list');
  buttons(entry!).find((button) => button.textContent === 'Task')!.click();
  await page.flush();
  assert.equal(page.requests.at(-1)!.path, 'api/tickets/app/T-4/task?archived=1');
  assert.deepEqual([page.$('task-panel').hidden, page.$('drawer-kicker').textContent], [false, 'app · .software-factory/archive/T-4.md']);
  assert.equal(page.$('task-panel').all().some((element) => element.tagName === 'A' || element.tagName === 'TEXTAREA'), false);
  assert.equal(posts(page).length, 0);
});

test('setup client: Start posts {} once for its ticket after the confirmation, keeps only that ticket\'s buttons off while out, and reports the job or the refusal', async () => {
  const rows = [ticket('app/T-6', { draft: false }), ticket('app/T-7', { draft: false, job: 'aborted' })];
  const page = await openPage([], [workspace('app')], rows);
  const card = (key: string): FakeElement => items(page, 'qlist').find((item) => item.dataset.ticket === key)!;
  const start = (key: string): FakeElement => buttons(card(key)).find((button) => button.textContent === 'Start')!;
  start('app/T-6').click();
  page.$('ticket-ok').click();
  page.$('ticket-ok').click();
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.deepEqual([posts(page)[0]!.path, posts(page)[0]!.body, posts(page)[0]!.headers['content-type']], ['api/tickets/app/T-6/start', '{}', 'application/json']);
  assert.match(page.$('toast-text').textContent, /^Starting app\/T-6/);
  // The ticket's action buttons are off while its request is out (a click on the card, the check
  // chip and Task, reads, still open its Task; ⋯ still opens the menu); another ticket's are not.
  assert.deepEqual(buttons(card('app/T-6')).filter((button) => !button.disabled).map((button) => button.textContent), ['not checked', 'not checked', 'Task', '⋯']);
  assert.equal(start('app/T-7').disabled, false);
  posts(page)[0]!.respond(200, { ok: true, result: { workspace: 'app', ticket: 'T-6', branch: 'T-6-demo', state: 'starting' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'Started app/T-6: branch T-6-demo, starting. The Implementer runs iteration 1.');
  assert.equal(start('app/T-6').disabled, false);

  // A refusal is the code and the message; nothing is retried.
  start('app/T-7').click();
  page.$('ticket-ok').click();
  await page.flush();
  assert.equal(posts(page)[1]!.path, 'api/tickets/app/T-7/start');
  posts(page)[1]!.respond(409, { ok: false, error: { code: 'job_exists', message: 'The job for app/T-7 is working.' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'job_exists: The job for app/T-7 is working.');
  start('app/T-6').click();
  page.$('ticket-ok').click();
  await page.flush();
  posts(page)[2]!.respond(409, { ok: false, error: { code: 'task_draft', message: '.software-factory/T-6.md is still the skeleton; the conversation writes it first.' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'task_draft: .software-factory/T-6.md is still the skeleton; the conversation writes it first.');
  assert.equal(start('app/T-6').disabled, false);
  assert.equal(posts(page).length, 3);
});

// New ticket's images (SF-064): the bytes each type is told by.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const GIF = new TextEncoder().encode('GIF89a-body');
const files = (...list: File[]) => ({ files: list, types: list.length > 0 ? ['Files'] : ['text/plain'] });
const thumbs = (page: Page): Array<[string, string, string]> => page.$('ticket-images').querySelectorAll('figure').map((figure) => [figure.querySelector('img')!.src, figure.querySelector('img')!.alt, figure.querySelector('.mono')!.textContent]);

test('setup client: New ticket takes pasted and dropped images, names them by paste order and real type, keeps text paste, and uploads each after the ticket is created', async () => {
  const page = await openPage([], [workspace('app')], []);
  page.$('open-new-ticket').click();
  assert.equal(page.$('ticket-images').hidden, true);
  assert.match(page.$('ticket-drop').textContent, /^Paste a screenshot anywhere in this form \(Ctrl\+V\) or drop images here\./);

  // A text paste into "What you want" goes on as usual: nothing is taken.
  const text = page.$('ticket-request').dispatch('paste', { clipboardData: files() });
  await page.flush();
  assert.equal(text.defaultPrevented, false);
  assert.deepEqual([page.$('ticket-images').hidden, thumbs(page)], [true, []]);

  // Cells copied from a spreadsheet carry text and a picture of them: a paste into a text field stays text.
  const cells = page.$('ticket-request').dispatch('paste', { clipboardData: { files: [new File([PNG], 'cells.png')], types: ['text/plain', 'Files'] } });
  await page.flush();
  assert.deepEqual([cells.defaultPrevented, thumbs(page)], [false, []]);

  // An image pasted into the request, or anywhere in the form: a thumbnail from a blob: URL.
  const pasted = page.$('ticket-request').dispatch('paste', { clipboardData: files(new File([PNG], 'image.png', { type: 'image/png' })) });
  assert.equal(pasted.defaultPrevented, true);
  // A JPEG whose name says .png gets the extension of its real type; a non-image is refused.
  page.$('ticket-title').dispatch('paste', { clipboardData: files(new File([JPEG], 'photo.png', { type: 'image/png' }), new File(['plain text'], 'fake.png', { type: 'image/png' })) });
  await page.flush();
  assert.deepEqual(thumbs(page), [['blob:fake/1', 'Pasted image 1.png', '1.png'], ['blob:fake/2', 'Pasted image 2.jpg', '2.jpg']]);
  assert.equal(page.$('ticket-status').textContent, 'Not added: fake.png (not a PNG, JPEG, WebP or GIF image).');
  // A drop on the form adds too.
  const over = page.$('ticket-drop').dispatch('dragover', { dataTransfer: { files: [], types: ['Files'] } });
  assert.deepEqual([over.defaultPrevented, page.$('ticket-drop').classList.contains('over')], [true, true]);
  const drop = page.$('ticket-drop').dispatch('drop', { dataTransfer: files(new File([GIF], 'anim.gif', { type: 'image/gif' })) });
  await page.flush();
  assert.deepEqual([drop.defaultPrevented, page.$('ticket-drop').classList.contains('over')], [true, false]);
  assert.deepEqual(thumbs(page).map((row) => row[2]), ['1.png', '2.jpg', '3.gif']);
  // × removes one; the names stay in paste order.
  page.$('ticket-images').querySelectorAll('button').find((node) => node.getAttribute('aria-label') === 'Remove 2.jpg')!.click();
  assert.deepEqual(thumbs(page).map((row) => row[2]), ['1.png', '2.gif']);
  assert.deepEqual(page.revokedUrls, ['blob:fake/2']);

  // Create: api/tickets as before (JSON, unchanged), then each image in order under its shown name.
  page.$('ticket-workspace').value = 'app';
  page.$('ticket-key').value = 'T-1';
  page.$('ticket-title').value = 'One';
  page.$('ticket-request').value = 'See the screenshots.';
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  assert.deepEqual([posts(page)[0]!.path, posts(page)[0]!.headers['content-type'], JSON.parse(posts(page)[0]!.body!)], ['api/tickets', 'application/json', { workspace: 'app', ticket: 'T-1', title: 'One', request: 'See the screenshots.' }]);
  posts(page)[0]!.respond(200, { ok: true, result: { workspace: 'app', ticket: 'T-1', path: '.software-factory/T-1.md', base: 'main' } });
  await page.flush();
  assert.equal(page.$('ticket-status').textContent, 'Ticket created; attaching 2 images…');
  assert.equal(page.$('ticket-create').disabled, true);
  const first = posts(page)[1]!;
  assert.deepEqual([first.path, first.headers['content-type'], first.body], ['api/tickets/app/T-1/attachments?name=1.png', 'application/octet-stream', undefined]);
  assert.deepEqual(new Uint8Array(await first.blob!.arrayBuffer()), PNG);
  assert.equal(posts(page).length, 2);
  // An image pasted while the uploads run is not sent with this ticket, and stays in the form.
  page.$('ticket-form').dispatch('paste', { clipboardData: files(new File([JPEG], 'late.jpg')) });
  await page.flush();
  first.respond(200, { ok: true, result: { name: '1.png', bytes: PNG.length, type: 'image/png' } });
  await page.flush();
  const second = posts(page)[2]!;
  assert.equal(second.path, 'api/tickets/app/T-1/attachments?name=2.gif');
  assert.deepEqual(new Uint8Array(await second.blob!.arrayBuffer()), GIF);
  second.respond(200, { ok: true, result: { name: '2.gif', bytes: GIF.length, type: 'image/gif' } });
  await page.flush();
  assert.equal(page.$('drawer').hidden, true);
  assert.match(page.$('toast-text').textContent, /^Ticket created: \.software-factory\/T-1\.md in app .* 2 images attached\.$/);
  assert.equal(posts(page).length, 3);
  assert.deepEqual([thumbs(page), page.$('ticket-create').disabled], [[['blob:fake/4', 'Pasted image 1.jpg', '1.jpg']], false]);
  assert.deepEqual(page.revokedUrls.sort(), ['blob:fake/1', 'blob:fake/2', 'blob:fake/3']);
});

test('setup client: an image upload that fails after the ticket was created keeps the ticket, and the form says which and why', async () => {
  const page = await openPage([], [workspace('app')], []);
  page.$('open-new-ticket').click();
  page.$('ticket-form').dispatch('paste', { clipboardData: files(new File([PNG], 'a.png'), new File([JPEG], 'b.jpg')) });
  await page.flush();
  page.$('ticket-workspace').value = 'app';
  page.$('ticket-key').value = 'T-2';
  page.$('ticket-title').value = 'Two';
  page.$('ticket-request').value = 'r';
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  posts(page)[0]!.respond(200, { ok: true, result: { workspace: 'app', ticket: 'T-2', path: '.software-factory/T-2.md', base: 'main' } });
  await page.flush();
  posts(page)[1]!.respond(400, { ok: false, error: { code: 'attachment_type', message: 'Only PNG, JPEG, WebP and GIF images can be attached.' } });
  await page.flush();
  posts(page)[2]!.respond(200, { ok: true, result: { name: '2.jpg', bytes: JPEG.length, type: 'image/jpeg' } });
  await page.flush();
  // The drawer stays open with what failed; the ticket's fields and the images are cleared, and its card is highlighted.
  assert.equal(page.$('drawer').hidden, false);
  assert.equal(page.$('ticket-status').textContent,
    'Ticket created: .software-factory/T-2.md in app. Not attached: 1.png (attachment_type: Only PNG, JPEG, WebP and GIF images can be attached.). Add it on the ticket\'s page: paste or drop on its Images card.');
  assert.deepEqual([page.$('ticket-key').value, page.$('ticket-images').hidden, page.$('ticket-create').disabled], ['', true, false]);
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('app/T-2')], archived: [] });
  assert.equal(items(page, 'qlist').find((item) => item.dataset.ticket === 'app/T-2')!.className, 'card hl');
  // A refused ticket uploads nothing.
  page.$('ticket-form').dispatch('paste', { clipboardData: files(new File([PNG], 'c.png')) });
  await page.flush();
  page.$('ticket-key').value = 'T-2';
  page.$('ticket-title').value = 'Again';
  page.$('ticket-request').value = 'r';
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  posts(page)[3]!.respond(409, { ok: false, error: { code: 'ticket_exists', message: 'exists' } });
  await page.flush();
  assert.equal(posts(page).length, 4);
  assert.deepEqual(thumbs(page).map((row) => row[2]), ['1.png']);
});

test('setup client: Create waits for images still being read, so each one pasted before Create goes up with this ticket (Fix 3, R2)', async () => {
  const page = await openPage([], [workspace('app')], []);
  page.$('open-new-ticket').click();
  page.$('ticket-workspace').value = 'app';
  page.$('ticket-key').value = 'T-3';
  page.$('ticket-title').value = 'Three';
  page.$('ticket-request').value = 'r';
  // Pasted, then Create at once: the image's bytes are still being read (released by the test) when Create is pressed.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  class SlowFile extends File {
    override slice(...args: Parameters<File['slice']>): Blob {
      const part = super.slice(...args);
      return { arrayBuffer: async () => (await gate, part.arrayBuffer()) } as unknown as Blob;
    }
  }
  page.$('ticket-form').dispatch('paste', { clipboardData: files(new SlowFile([PNG], 'shot.png')) });
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  // Nothing is created while the image is read.
  assert.equal(posts(page).length, 0);
  release();
  await page.flush();
  assert.equal(posts(page)[0]!.path, 'api/tickets');
  posts(page)[0]!.respond(200, { ok: true, result: { workspace: 'app', ticket: 'T-3', path: '.software-factory/T-3.md', base: 'main' } });
  await page.flush();
  assert.equal(posts(page)[1]!.path, 'api/tickets/app/T-3/attachments?name=1.png');
  posts(page)[1]!.respond(200, { ok: true, result: { name: '1.png', bytes: PNG.length, type: 'image/png' } });
  await page.flush();
  assert.deepEqual([page.$('drawer').hidden, thumbs(page)], [true, []]);
  assert.match(page.$('toast-text').textContent, /1 image attached\.$/);

  // An image refused while Create waits: nothing is created; the form says why, and Create again goes on without it.
  page.$('open-new-ticket').click();
  page.$('ticket-key').value = 'T-4';
  page.$('ticket-title').value = 'Four';
  page.$('ticket-request').value = 'r';
  page.$('ticket-form').dispatch('paste', { clipboardData: files(new File(['plain text'], 'notes.png')) });
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 2);
  assert.equal(page.$('ticket-status').textContent, 'Not added: notes.png (not a PNG, JPEG, WebP or GIF image).');
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  assert.deepEqual([posts(page).length, posts(page)[2]!.path], [3, 'api/tickets']);
});

test('setup client: Create uploads the images of the moment it was pressed; one pasted while the ticket is being created stays for the next ticket (Fix 4, R2)', async () => {
  const page = await openPage([], [workspace('app')], []);
  page.$('open-new-ticket').click();
  page.$('ticket-form').dispatch('paste', { clipboardData: files(new File([PNG], 'first.png')) });
  await page.flush();
  page.$('ticket-workspace').value = 'app';
  page.$('ticket-key').value = 'T-5';
  page.$('ticket-title').value = 'Five';
  page.$('ticket-request').value = 'r';
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page)[0]!.path, 'api/tickets');
  // The create answer is late; an image pasted meanwhile is not part of this ticket, and × is off for the one being sent.
  assert.equal(page.$('ticket-images').querySelector('button')!.disabled, true);
  page.$('ticket-form').dispatch('paste', { clipboardData: files(new File([GIF], 'later.gif')) });
  await page.flush();
  assert.deepEqual(thumbs(page).map((row) => row[2]), ['1.png', '2.gif']);
  posts(page)[0]!.respond(200, { ok: true, result: { workspace: 'app', ticket: 'T-5', path: '.software-factory/T-5.md', base: 'main' } });
  await page.flush();
  assert.equal(posts(page)[1]!.path, 'api/tickets/app/T-5/attachments?name=1.png');
  posts(page)[1]!.respond(200, { ok: true, result: { name: '1.png', bytes: PNG.length, type: 'image/png' } });
  await page.flush();
  assert.equal(posts(page).length, 2);
  assert.match(page.$('toast-text').textContent, /1 image attached\.$/);
  // The later image stays staged, first now, for the next ticket.
  assert.deepEqual(thumbs(page).map((row) => row[2]), ['1.gif']);
  assert.deepEqual(new Uint8Array(await page.objectUrls.get(thumbs(page)[0]![0])!.arrayBuffer()), GIF);

  // A refused create keeps every image, and × is on again.
  page.$('open-new-ticket').click();
  page.$('ticket-key').value = 'T-5';
  page.$('ticket-title').value = 'Again';
  page.$('ticket-request').value = 'r';
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  posts(page)[2]!.respond(409, { ok: false, error: { code: 'ticket_exists', message: 'exists' } });
  await page.flush();
  assert.deepEqual([thumbs(page).map((row) => row[2]), page.$('ticket-images').querySelector('button')!.disabled, posts(page).length], [['1.gif'], false, 3]);
});
