// Behaviour of the setup in static/setup.js (SF-025, SF-046), run under node:vm against the fake
// page of test/support/fake-dom.ts: Workspaces and New ticket in the drawer from the header, the
// workspace form and list, the new-ticket form, on the planned ticket page (SF-081) the
// conversation link (a click, never automatic) and the first message's Copy, an archived Task in
// the drawer, and the Start of a ticket whose Task file is written, on its Queue card (SF-040);
// New ticket's images (SF-064): paste and drop, the thumbnails and ×, the uploads after Create and
// a failed one; the planner session of a ticket Claude Code plans (planner.js): Create & plan's
// start, Start the planner, its lines and link, its read every 10 s, End.
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

const workspace = (name: string, liveJobs = 0, problem: string | null = null, handoff: 'checkout' | 'off' | null = null): { name: string; path: string; liveJobs: number; problem: string | null; handoff: 'checkout' | 'off' | null; vision?: true } => ({ name, path: `/srv/${name}`, liveJobs, problem, handoff });

function ticket(key: string, extra: Record<string, unknown> = {}) {
  const [workspaceName, name] = key.split('/') as [string, string];
  const message = `Use the Software Factory connector for ${name}.`;
  return {
    workspace: workspaceName, ticket: name, title: `Ticket ${name}`, base: 'main', draft: true, owner: 'chatgpt', job: null,
    conversation: { message, url: `${PREFIX}${encodeURIComponent(message)}` }, ...extra,
  };
}

// The page with the given jobs loaded and the stream's first workspaces and tickets delivered;
// globals: names added to the page's context (a localStorage).
async function openPage(jobs: ReturnType<typeof job>[], workspaces: ReturnType<typeof workspace>[], tickets: ReturnType<typeof ticket>[], clipboard?: { writeText(text: string): Promise<void> }, globals: Record<string, unknown> = {}): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs };
    }
    const match = /^api\/jobs\/([^/]+)\/([^/]+)$/.exec(path);
    return match ? detail(match[2]!) : undefined;
  }, clipboard, globals);
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
    workspaces: [row103('api', { app: 'shop', description: 'The shop backend.', label: 'exp', digest: { track: true, my_work: false } }), row103('web', { app: 'shop' }), row103('tools')],
    handoff_default: 'off', digest: { times: ['07:45'], weekdays_only: false, language: 'Deutsch' },
  });
  await page.flush();
  const [api, web, tools] = items(page, 'workspace-list');
  assert.equal(api!.querySelector('.ws-app')!.textContent, 'shop');
  assert.equal(api!.querySelector('.ws-description')!.textContent, 'The shop backend.');
  // The label, under the description, only for a workspace that has one.
  assert.equal(api!.querySelector('.ws-label')!.textContent, 'Label on its cards: exp');
  assert.equal(web!.querySelector('.ws-label'), null);
  assert.equal(tools!.querySelector('.ws-label'), null);
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
  const rows = [row103('api', { app: 'shop', description: 'The shop backend.', handoff: 'off', color: 'red', label: 'exp', digest: { track: true, my_work: false } }), row103('web', { color: 'purple' })];
  stream.emit('workspaces', { workspaces: rows, handoff_default: 'checkout', digest: { times: ['08:00'], weekdays_only: true, language: 'English' } });
  await page.flush();
  named(items(page, 'workspace-list')[0]!, 'Edit').click();
  await page.flush();
  const form = (): FakeElement => items(page, 'workspace-list')[0]!.querySelector('form')!;
  const field = (key: string): FakeElement => form().querySelector(`[data-wsf="${key}"]`)!;
  assert.deepEqual([field('path').value, field('description').value, (field('description') as unknown as Record<string, unknown>).placeholder, field('app').value, field('handoff').value, field('color').value, field('track').checked, field('my_work').checked],
    ['/srv/api', 'The shop backend.', 'The api from its README.', 'shop', 'off', 'red', true, false]);
  assert.equal((field('handoff').children[0] as FakeElement).textContent, 'Default (now: yes, from SF_HANDOFF)');
  // The Label field: the row's label, the name as its placeholder, at most 24 characters.
  const label = field('label') as unknown as Record<string, unknown>;
  assert.deepEqual([label.value, label.placeholder, label.maxLength, label.type], ['exp', 'api', 24, 'text']);
  // Labels in plain words, each with its own line.
  assert.match(form().textContent, /Path of the local checkout[\s\S]*Description[\s\S]*App[\s\S]*When a job is ready, hand it over to my checkout[\s\S]*Colour of its cards on the board[\s\S]*Label on its cards[\s\S]*Morning digest: follow this repository[\s\S]*My daily: my commits here go into the daily of its app/);
  // The other card's Edit is off while one is open; a redraw keeps what is typed.
  assert.equal(named(items(page, 'workspace-list')[1]!, 'Edit').disabled, true);
  field('description').value = '';
  field('app').value = 'store';
  stream.emit('workspaces', { workspaces: rows, handoff_default: 'checkout', digest: { times: ['08:00'], weekdays_only: true, language: 'English' } });
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
  assert.deepEqual(JSON.parse(posts(page)[0]!.body!), { path: '/srv/api2', description: '', app: 'shop', handoff: 'default', color: 'auto', label: 'exp', digest: { track: true, my_work: true } });
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
  // A row without a label: an empty Label field, the name as its placeholder.
  const empty = items(page, 'workspace-list')[1]!.querySelector('[data-wsf="label"]') as unknown as Record<string, unknown>;
  assert.deepEqual([empty.value, empty.placeholder], ['', 'web']);
});

test('setup client (SF-103): the Morning digest section saves the times, weekdays only and the language; typed values stay over a redraw', async () => {
  const page = await openPage([], [], []);
  const stream = page.streams.at(-1)!;
  stream.emit('workspaces', { workspaces: [row103('app')], handoff_default: 'checkout', digest: { times: ['08:00', '12:30'], weekdays_only: true, language: 'English' } });
  await page.flush();
  // The Times field: a text field with the times comma-separated.
  assert.deepEqual([page.$('digest-at').getAttribute('type'), page.$('digest-at').value], ['text', '08:00, 12:30']);
  page.$('digest-at').value = ' 06:30 ,, 13:15, ';
  page.$('digest-at').dispatch('input');
  page.$('digest-weekdays').checked = false;
  page.$('digest-language').value = ' Български ';
  stream.emit('workspaces', { workspaces: [row103('app')], handoff_default: 'checkout', digest: { times: ['08:00'], weekdays_only: true, language: 'English' } });
  await page.flush();
  assert.equal(page.$('digest-at').value, ' 06:30 ,, 13:15, ');
  page.$('digest-form').dispatch('submit');
  await page.flush();
  assert.deepEqual([posts(page)[0]!.path, JSON.parse(posts(page)[0]!.body!)], ['api/digest-settings', { times: ['06:30', '13:15'], weekdays_only: false, language: 'Български' }]);
  posts(page)[0]!.respond(200, { ok: true, result: { times: ['06:30', '13:15'], weekdays_only: false, language: 'Български' } });
  await page.flush();
  assert.equal(page.$('digest-status').textContent, 'Saved: 06:30, 13:15 every day, in Български. sf serve uses it at its next check.');
  page.$('digest-language').value = '';
  page.$('digest-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.equal(page.$('digest-status').textContent, 'At least one time (HH:MM, comma-separated) and a language are needed.');
  page.$('digest-language').value = 'English';
  for (const times of ['', ' , ', '8:00', '08:00, noon']) {
    page.$('digest-at').value = times;
    page.$('digest-form').dispatch('submit');
    await page.flush();
    assert.equal(posts(page).length, 1, times);
  }
});

test('setup client: a workspace with a vision has a Vision ↗ link before Edit, in a new tab without the opener; it follows the workspaces event', async () => {
  const page = await openPage([], [{ ...workspace('bookshop'), vision: true }, workspace('web')], []);
  page.$('open-workspaces').click();
  const [bookshop, web] = items(page, 'workspace-list');
  const links = bookshop!.all().filter((element) => element.tagName === 'A');
  assert.equal(links.length, 1);
  const vision = links[0]!;
  assert.deepEqual([vision.textContent, vision.href, vision.target, vision.rel, vision.className], ['Vision ↗', 'vision/bookshop', '_blank', 'noopener noreferrer', 'btn btn-sm']);
  const row = vision.parentNode as FakeElement;
  assert.equal(row.children.indexOf(vision), row.children.indexOf(named(bookshop!, 'Edit')) - 1);
  assert.equal(link(web!), undefined);
  page.streams.at(-1)!.emit('workspaces', { workspaces: [workspace('bookshop'), workspace('web')] });
  await page.flush();
  assert.equal(link(items(page, 'workspace-list')[0]!), undefined);
});

test('setup client: the new-ticket form posts the exact fields, clears on success, keeps them on a refusal', async () => {
  const page = await openPage([], [workspace('app'), workspace('web')], []);
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 0);
  assert.match(page.$('ticket-status').textContent, /all needed/);
  // The Context owner: ChatGPT by default, Claude Code a real choice.
  assert.deepEqual([page.$('owner-chatgpt').checked, page.$('owner-claude').checked, page.$('owner-claude').disabled, page.$('owner-claude').value], [true, false, false, 'claude_code']);
  page.$('ticket-workspace').value = 'web';
  page.$('ticket-key').value = ' W-7 ';
  page.$('ticket-title').value = ' Seven ';
  const request = 'Make it so.\n\nWith "quotes" — ünïcödé 🚀 ';
  page.$('ticket-request').value = request;
  page.$('ticket-form').dispatch('submit');
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.deepEqual([posts(page)[0]!.path, JSON.parse(posts(page)[0]!.body!)], ['api/tickets', { workspace: 'web', ticket: 'W-7', title: 'Seven', request, owner: 'chatgpt' }]);
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
  // Claude Code, in a planner session: the choice goes with the request; Create alone starts no
  // planner session.
  page.$('open-new-ticket').click();
  page.$('owner-chatgpt').checked = false;
  page.$('owner-claude').checked = true;
  page.$('ticket-key').value = 'W-8';
  page.$('ticket-title').value = 'Eight';
  page.$('ticket-request').value = 'Prototype it.';
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  assert.deepEqual(JSON.parse(posts(page)[2]!.body!), { workspace: 'web', ticket: 'W-8', title: 'Eight', request: 'Prototype it.', owner: 'claude_code' });
  posts(page)[2]!.respond(200, created('web', 'W-8'));
  await page.flush();
  assert.equal(posts(page).length, 3);
});

// A ticket's planner session as the server shows it (planner_session, GET .../planner).
interface SessionView { name: string; started_at: string; link: string | null }
const SESSION: SessionView = { name: 'Planner app T-5', started_at: '2026-11-16T12:03:00.000Z', link: null };
// SESSION's start as the page shows it (ticket-page.js day, in this machine's time).
const SESSION_DAY = new Date(SESSION.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const HINT = ' Its link shows here once it first waits for you; until then find it under that name in the Claude app or on claude.ai/code.';

// The planned ticket page's payload of a row, its planner session and then its prototypes the last
// keys (prototypes undefined: a payload without the key).
function pagePayload(row: ReturnType<typeof ticket>, session: SessionView | null = null, prototypes: unknown[] | undefined = []) {
  const text = `---\nticket: ${row.ticket}\ntitle: ${row.title}\nbase: main\n---\n`;
  return {
    ticket: row, task: { text, sha256: 'a'.repeat(64) }, plan: { starts_from: 'main', files: [], scoped: false, waits_for: [] }, check: null, history: [], queue: null, planner_session: session,
    ...(prototypes !== undefined ? { prototypes } : {}),
  };
}

// The planned ticket page of a Queue card (SF-081): a click on the card, its page answered from
// the card's row (and the planner session and the prototypes, none by default).
async function openTaskOf(page: Page, key: string, row: ReturnType<typeof ticket>, session: SessionView | null = null, prototypes: unknown[] | undefined = []): Promise<void> {
  items(page, 'qlist').find((item) => item.dataset.ticket === key)!.click();
  await page.flush();
  page.requests.find((request) => request.path === `api/tickets/${key}/page`)!.respond(200, pagePayload(row, session, prototypes));
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

// The planner session's line in the Planning conversation card (a p), the card's links, the
// page's header, and the GET reads of app/T-5's session.
const plannerLine = (page: Page): FakeElement | null => conversationCard(page).querySelector('p');
const pageLinks = (node: FakeElement): FakeElement[] => node.all().filter((element) => element.tagName === 'A');
const ticketHead = (page: Page): FakeElement => page.$('ticket').querySelector('header.jhead')!;
const sessionReads = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'GET' && request.path === 'api/tickets/app/T-5/planner');
const claudeRow = () => ticket('app/T-5', { owner: 'claude_code', conversation: { message: 'Use the software-factory MCP server.', url: null } });

test('setup client: a ticket Claude Code plans offers Start the planner; Start posts the planner route once and shows Starting… then the session; runs already and a refusal go to the toast', async () => {
  const row = claudeRow();
  const page = await openPage([], [workspace('app')], [row]);
  await openTaskOf(page, 'app/T-5', row);
  const card = conversationCard(page);
  assert.deepEqual([plannerLine(page)!.textContent, plannerLine(page)!.getAttribute('role')], ['No planner session runs.', 'status']);
  const start = named(card, 'Start the planner');
  assert.equal(start.getAttribute('title'), 'Starts Claude Code with Remote Control in the planning copy of app, with /planning-tasks workspace app, ticket T-5');
  // The paste line and the first message with its Copy stay.
  assert.match(card.textContent, /Paste it into a Claude Code session that has the software-factory MCP server \(see the planning guide\)/);
  assert.equal(card.querySelector('pre.cm')!.textContent, 'Use the software-factory MCP server.');
  start.click();
  start.click();
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.deepEqual([posts(page)[0]!.path, posts(page)[0]!.body], ['api/tickets/app/T-5/planner', '{}']);
  // While it is out: the line alone, no Start.
  assert.equal(plannerLine(page)!.textContent, 'Starting the planner in the planning copy of app…');
  assert.deepEqual(buttons(conversationCard(page)).filter((button) => ['Start the planner', 'End'].includes(button.textContent)), []);
  posts(page)[0]!.respond(200, { ok: true, result: { started: false, session: SESSION } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'The planner of app/T-5 runs already.');
  assert.equal(plannerLine(page)!.textContent, `Planner session "Planner app T-5" runs since ${SESSION_DAY}.${HINT}`);
  const end = named(conversationCard(page), 'End');
  assert.deepEqual([end.className, end.getAttribute('title'), end.disabled], ['btn small', 'End this Claude Code session (asks first)', false]);
  assert.equal(named(conversationCard(page), 'Start the planner'), undefined);
  assert.equal(posts(page).length, 1);

  // A refusal: its code and message in the toast; the card offers Start again.
  const refused = await openPage([], [workspace('app')], [row]);
  await openTaskOf(refused, 'app/T-5', row);
  named(conversationCard(refused), 'Start the planner').click();
  await refused.flush();
  const message = 'Claude Code does not trust the planning copy of app yet: run sf planner trust app, accept its trust dialog, then start the planner again.';
  posts(refused)[0]!.respond(409, { ok: false, error: { code: 'planning_copy_untrusted', message } });
  await refused.flush();
  assert.equal(refused.$('toast-text').textContent, `planning_copy_untrusted: ${message}`);
  assert.equal(plannerLine(refused)!.textContent, 'No planner session runs.');
  assert.equal(named(conversationCard(refused), 'Start the planner').disabled, false);
  assert.equal(posts(refused).length, 1);
});

test('setup client: a running planner session: its link in the card and the header, only a claude.ai/code one; its read every 10 s while shown and visible; the end it sees', async () => {
  const row = claudeRow();
  const page = await openPage([], [workspace('app')], [row]);
  await openTaskOf(page, 'app/T-5', row, SESSION);
  // No link known yet: the hint, nothing linked.
  assert.equal(plannerLine(page)!.textContent, `Planner session "Planner app T-5" runs since ${SESSION_DAY}.${HINT}`);
  assert.deepEqual([pageLinks(conversationCard(page)), pageLinks(ticketHead(page))], [[], []]);
  assert.equal(sessionReads(page).length, 0);
  // 10 s later the session is read again; its link is shown, in the card and the header.
  assert.equal(page.tick(10000), 1);
  await page.flush();
  assert.equal(sessionReads(page).length, 1);
  const href = 'https://claude.ai/code/session_01Ab';
  sessionReads(page)[0]!.respond(200, { session: { ...SESSION, link: href } });
  await page.flush();
  assert.equal(plannerLine(page)!.textContent, `Planner session "Planner app T-5" runs since ${SESSION_DAY}.`);
  const [open] = pageLinks(conversationCard(page));
  assert.deepEqual([open!.textContent, open!.className, open!.href, open!.target, open!.rel], ['Open the planner session ↗', 'btn small linkbtn', href, '_blank', 'noopener noreferrer']);
  const [head] = pageLinks(ticketHead(page));
  assert.deepEqual([head!.textContent, head!.className, head!.href, head!.target, head!.rel], ['Open the planner session ↗', 'btn linkbtn', href, '_blank', 'noopener noreferrer']);
  assert.equal(named(conversationCard(page), 'End').disabled, false);
  // A hidden page reads nothing; the timer goes on.
  page.document.visibilityState = 'hidden';
  assert.equal(page.tick(10000), 1);
  await page.flush();
  assert.equal(sessionReads(page).length, 1);
  page.document.visibilityState = 'visible';
  // A failed read keeps the card as it was.
  assert.equal(page.tick(10000), 1);
  await page.flush();
  assert.equal(sessionReads(page).length, 2);
  sessionReads(page)[1]!.fail();
  await page.flush();
  assert.equal(pageLinks(conversationCard(page))[0]!.href, href);
  assert.equal(plannerLine(page)!.textContent, `Planner session "Planner app T-5" runs since ${SESSION_DAY}.`);
  // A link that is not a claude.ai/code session page is linked nowhere.
  assert.equal(page.tick(10000), 1);
  await page.flush();
  sessionReads(page)[2]!.respond(200, { session: { ...SESSION, link: 'https://evil.example/x' } });
  await page.flush();
  assert.deepEqual([pageLinks(conversationCard(page)), pageLinks(ticketHead(page))], [[], []]);
  assert.equal(plannerLine(page)!.textContent, `Planner session "Planner app T-5" runs since ${SESSION_DAY}.${HINT}`);
  // The read that finds none: ended, Start the planner, no further read.
  assert.equal(page.tick(10000), 1);
  await page.flush();
  sessionReads(page)[3]!.respond(200, { session: null });
  await page.flush();
  assert.equal(plannerLine(page)!.textContent, 'The planner session ended.');
  assert.equal(named(conversationCard(page), 'End'), undefined);
  assert.equal(named(conversationCard(page), 'Start the planner').disabled, false);
  assert.equal(page.tick(10000), 0);
  assert.equal(sessionReads(page).length, 4);

  // A page that left the ticket reads nothing.
  const left = await openPage([], [workspace('app')], [row]);
  await openTaskOf(left, 'app/T-5', row, SESSION);
  left.$('ticket').querySelector('[data-back]')!.click();
  await left.flush();
  left.tick(10000);
  await left.flush();
  assert.equal(sessionReads(left).length, 0);
});

test('setup client: End asks first, then posts the stop route once and shows the session ended', async () => {
  const row = claudeRow();
  const page = await openPage([], [workspace('app')], [row]);
  await openTaskOf(page, 'app/T-5', row, SESSION);
  named(conversationCard(page), 'End').click();
  assert.equal(page.$('ticket-confirm').hidden, false);
  assert.deepEqual([page.$('ticket-confirm-title').textContent, page.$('ticket-confirm-text').textContent, page.$('ticket-ok').textContent, page.$('ticket-ok').className], [
    'End the planner of T-5?',
    'Ends the Claude Code session that plans T-5 in the planning copy of app, even in the middle of an answer. What it already wrote, such as the Task file, stays; Start the planner then begins a new session.',
    'End the session', 'btn btn-danger',
  ]);
  // Cancel posts nothing.
  page.$('ticket-cancel').click();
  await page.flush();
  assert.deepEqual([page.$('ticket-confirm').hidden, posts(page).length], [true, 0]);
  // The confirmation posts once; End reads Ending… and is off meanwhile.
  named(conversationCard(page), 'End').click();
  page.$('ticket-ok').click();
  page.$('ticket-ok').click();
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.deepEqual([posts(page)[0]!.path, posts(page)[0]!.body], ['api/tickets/app/T-5/planner/stop', '{}']);
  const ending = named(conversationCard(page), 'Ending…');
  assert.equal(ending.disabled, true);
  posts(page)[0]!.respond(200, { ok: true, result: { stopped: SESSION } });
  await page.flush();
  assert.equal(plannerLine(page)!.textContent, 'The planner session ended.');
  assert.equal(page.$('toast-text').textContent, 'Ended the planner of app/T-5.');
  assert.equal(named(conversationCard(page), 'Start the planner').disabled, false);
  // No read is due any more.
  assert.equal(page.tick(10000), 0);
  assert.equal(posts(page).length, 1);
});

test('setup client: an answer of Start the planner for a ticket the page left changes nothing of the ticket it shows: its session and its read every 10 s stay', async () => {
  const left = claudeRow();
  const shown = ticket('app/T-6', { owner: 'claude_code', conversation: { message: 'Use the software-factory MCP server.', url: null } });
  const running = { ...SESSION, name: 'Planner app T-6' };
  const runningLine = `Planner session "Planner app T-6" runs since ${SESSION_DAY}.${HINT}`;
  const shownReads = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'GET' && request.path === 'api/tickets/app/T-6/planner');

  // Start on T-5; T-6, whose session runs, opened before the answer.
  const page = await openPage([], [workspace('app')], [left, shown]);
  await openTaskOf(page, 'app/T-5', left);
  named(conversationCard(page), 'Start the planner').click();
  await page.flush();
  page.$('ticket').querySelector('[data-back]')!.click();
  await openTaskOf(page, 'app/T-6', shown, running);
  posts(page)[0]!.respond(200, { ok: true, result: { started: true, session: SESSION } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'The planner of app/T-5 started.');
  assert.equal(plannerLine(page)!.textContent, runningLine);
  assert.equal(page.tick(10000), 1);
  await page.flush();
  assert.equal(shownReads(page).length, 1);
  shownReads(page)[0]!.respond(200, { session: running });
  await page.flush();
  assert.equal(plannerLine(page)!.textContent, runningLine);
  assert.equal(page.tick(10000), 1);
  await page.flush();
  assert.equal(shownReads(page).length, 2);
});

test('setup client: a read of a ticket\'s session sent before its End answered, while the page showed another ticket, is not applied once the ticket is open again', async () => {
  const row = claudeRow();
  const other = ticket('app/T-6', { owner: 'claude_code', conversation: { message: 'Use the software-factory MCP server.', url: null } });
  const page = await openPage([], [workspace('app')], [row, other]);
  await openTaskOf(page, 'app/T-5', row, SESSION);
  // T-5's read goes out; End is confirmed while it is out.
  assert.equal(page.tick(10000), 1);
  await page.flush();
  assert.equal(sessionReads(page).length, 1);
  named(conversationCard(page), 'End').click();
  page.$('ticket-ok').click();
  await page.flush();
  // T-6 opened; End answers there.
  page.$('ticket').querySelector('[data-back]')!.click();
  await openTaskOf(page, 'app/T-6', other);
  posts(page)[0]!.respond(200, { ok: true, result: { stopped: SESSION } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'Ended the planner of app/T-5.');
  // T-5 opened again: its payload has no session; then the old read answers with the session before End.
  page.$('ticket').querySelector('[data-back]')!.click();
  items(page, 'qlist').find((item) => item.dataset.ticket === 'app/T-5')!.click();
  await page.flush();
  page.requests.filter((request) => request.path === 'api/tickets/app/T-5/page').at(-1)!.respond(200, pagePayload(row));
  await page.flush();
  assert.equal(plannerLine(page)!.textContent, 'No planner session runs.');
  sessionReads(page)[0]!.respond(200, { session: SESSION });
  await page.flush();
  assert.equal(plannerLine(page)!.textContent, 'No planner session runs.');
  assert.equal(named(conversationCard(page), 'End'), undefined);
  assert.equal(page.tick(10000), 0);
  assert.equal(sessionReads(page).length, 1);
});

test('setup client: a ticket ChatGPT plans has no planner line unless its session runs', async () => {
  const row = ticket('app/T-7');
  const page = await openPage([], [workspace('app')], [row]);
  await openTaskOf(page, 'app/T-7', row);
  assert.equal(plannerLine(page), null);
  assert.deepEqual(buttons(conversationCard(page)).filter((button) => ['Start the planner', 'End'].includes(button.textContent)), []);
  assert.equal(pageLinks(conversationCard(page))[0]!.textContent, 'Open the ChatGPT conversation ↗');

  // Its session runs: the running line and End, no Start; the ChatGPT link stays.
  const running = await openPage([], [workspace('app')], [row]);
  await openTaskOf(running, 'app/T-7', row, { ...SESSION, name: 'Planner app T-7' });
  assert.equal(plannerLine(running)!.textContent, `Planner session "Planner app T-7" runs since ${SESSION_DAY}.${HINT}`);
  assert.equal(named(conversationCard(running), 'End').disabled, false);
  assert.equal(named(conversationCard(running), 'Start the planner'), undefined);
  assert.equal(pageLinks(conversationCard(running))[0]!.textContent, 'Open the ChatGPT conversation ↗');
});

// A ticket's prototypes as the server lists them (the payload's prototypes, GET .../planner's), newest first.
interface ProtoEntry { name: string; modified: string }
const PROTOS: ProtoEntry[] = [{ name: 'b-states.html', modified: '2026-11-16T14:03:00.000Z' }, { name: 'a-layout.html', modified: '2026-11-16T12:00:00.000Z' }];
// A time as the page shows it (ticket-page.js day, in this machine's time).
const shownDay = (ts: string): string => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// The card's list of prototypes: per row its time, the time's title, the link's text, href, target and rel.
const protoRows = (page: Page): string[][] => (conversationCard(page).querySelector('ul.hist')?.querySelectorAll('li') ?? []).map((item) => {
  const when = item.querySelector('span.t')!;
  const link = item.querySelector('a')!;
  return [when.textContent, when.getAttribute('title') ?? '', link.textContent, link.href, link.target, link.rel];
});
const protoRow = (entry: ProtoEntry, key = 'app/T-5'): string[] => [shownDay(entry.modified), entry.modified, `${entry.name} ↗`, `/prototypes/${key}/${entry.name}`, '_blank', 'noopener noreferrer'];
// The header's link to the newest prototype: its text, href, title, target and rel; null without one.
const headProto = (page: Page): string[] | null => {
  const link = pageLinks(ticketHead(page)).find((element) => element.href.startsWith('/prototypes/'));
  return link === undefined ? null : [link.textContent, link.className, link.href, link.getAttribute('title') ?? '', link.target, link.rel];
};
const LISTED = 'Prototypes the planner made, newest first:';

test('setup client: a ticket\'s prototypes in the card, newest first, and the newest in the header', async () => {
  const row = claudeRow();
  const page = await openPage([], [workspace('app')], [row]);
  const href = 'https://claude.ai/code/session_01Ab';
  await openTaskOf(page, 'app/T-5', row, { ...SESSION, link: href }, PROTOS);
  // After the session's line and its row: the words, then the list in the server's order.
  // The card's children: its title, Plan with, the session's line and row, the words and the list.
  const [, , line, acts, words, list] = conversationCard(page).children as FakeElement[];
  assert.equal(line!.textContent, `Planner session "Planner app T-5" runs since ${SESSION_DAY}.`);
  assert.equal(acts!.className, 'planner-acts');
  assert.deepEqual([words!.tagName, words!.className, words!.textContent], ['DIV', 'fs13', LISTED]);
  assert.deepEqual([list!.tagName, list!.className], ['UL', 'hist']);
  assert.deepEqual(protoRows(page), [protoRow(PROTOS[0]!), protoRow(PROTOS[1]!)]);
  // The header: the planner session's link, then the newest prototype's.
  const head = pageLinks(ticketHead(page)).map((link) => link.textContent);
  assert.deepEqual(head, ['Open the planner session ↗', 'b-states.html ↗']);
  assert.deepEqual(headProto(page), ['b-states.html ↗', 'btn linkbtn', '/prototypes/app/T-5/b-states.html', 'The newest prototype of app/T-5', '_blank', 'noopener noreferrer']);
});

test('setup client: a ChatGPT ticket lists its prototypes too', async () => {
  const row = ticket('app/T-7');
  const page = await openPage([], [workspace('app')], [row]);
  await openTaskOf(page, 'app/T-7', row, null, [PROTOS[1]!]);
  assert.equal(plannerLine(page), null);
  assert.equal(conversationCard(page).all().find((element) => element.textContent === LISTED)?.tagName, 'DIV');
  assert.deepEqual(protoRows(page), [protoRow(PROTOS[1]!, 'app/T-7')]);
  assert.deepEqual(headProto(page), ['a-layout.html ↗', 'btn linkbtn', '/prototypes/app/T-7/a-layout.html', 'The newest prototype of app/T-7', '_blank', 'noopener noreferrer']);
  assert.ok(pageLinks(conversationCard(page)).some((link) => link.textContent === 'Open the ChatGPT conversation ↗'));
});

test('setup client: prototypes with a bad name or time are left out; none draws nothing', async () => {
  const row = claudeRow();
  const bad = [
    { name: 'X.html', modified: PROTOS[0]!.modified }, { name: '../x.html', modified: PROTOS[0]!.modified }, { name: 'x.htm', modified: PROTOS[0]!.modified },
    { name: 'no-time.html' }, { name: 'num-time.html', modified: 5 }, 'a.html', null, PROTOS[1]!,
  ];
  const page = await openPage([], [workspace('app')], [row]);
  await openTaskOf(page, 'app/T-5', row, null, bad);
  assert.deepEqual(protoRows(page), [protoRow(PROTOS[1]!)]);
  assert.equal(headProto(page)![2], '/prototypes/app/T-5/a-layout.html');

  // An empty list, and a payload without the key: neither the list, its words nor the header link.
  for (const prototypes of [[], undefined]) {
    const none = await openPage([], [workspace('app')], [row]);
    await openTaskOf(none, 'app/T-5', row, null, prototypes);
    const card = conversationCard(none);
    assert.equal(card.querySelector('ul.hist'), null);
    assert.equal(card.all().some((element) => element.textContent === LISTED), false);
    assert.equal(headProto(none), null);
    assert.equal(pageLinks(ticketHead(none)).length, 0);
  }
});

test('setup client: the session\'s read every 10 s brings a new prototype; a failed read keeps the list', async () => {
  const row = claudeRow();
  const page = await openPage([], [workspace('app')], [row]);
  await openTaskOf(page, 'app/T-5', row, SESSION, PROTOS);
  assert.deepEqual(protoRows(page), [protoRow(PROTOS[0]!), protoRow(PROTOS[1]!)]);
  const third = { name: 'c-flow.html', modified: '2026-11-16T15:30:00.000Z' };
  assert.equal(page.tick(10000), 1);
  await page.flush();
  sessionReads(page)[0]!.respond(200, { session: SESSION, prototypes: [third, ...PROTOS] });
  await page.flush();
  assert.deepEqual(protoRows(page), [protoRow(third), protoRow(PROTOS[0]!), protoRow(PROTOS[1]!)]);
  assert.equal(headProto(page)![0], 'c-flow.html ↗');
  // A failed read keeps the list and the header link.
  assert.equal(page.tick(10000), 1);
  await page.flush();
  sessionReads(page)[1]!.fail();
  await page.flush();
  assert.deepEqual(protoRows(page), [protoRow(third), protoRow(PROTOS[0]!), protoRow(PROTOS[1]!)]);
  assert.equal(headProto(page)![0], 'c-flow.html ↗');
  // The read that finds the session ended still gives the list.
  assert.equal(page.tick(10000), 1);
  await page.flush();
  sessionReads(page)[2]!.respond(200, { session: null, prototypes: [third] });
  await page.flush();
  assert.equal(plannerLine(page)!.textContent, 'The planner session ended.');
  assert.deepEqual(protoRows(page), [protoRow(third)]);
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
  assert.deepEqual([posts(page)[0]!.path, posts(page)[0]!.headers['content-type'], JSON.parse(posts(page)[0]!.body!)], ['api/tickets', 'application/json', { workspace: 'app', ticket: 'T-1', title: 'One', request: 'See the screenshots.', owner: 'chatgpt' }]);
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

// A localStorage for the page: its entries, or (refuse) one whose getItem and setItem throw, as a
// browser that refuses storage.
function storage(entries: Record<string, string> = {}, refuse = false) {
  const items = new Map(Object.entries(entries));
  const check = (): void => {
    if (refuse) {
      throw new Error('SecurityError: storage is refused');
    }
  };
  return {
    items,
    getItem: (name: string): string | null => (check(), items.get(name) ?? null),
    setItem: (name: string, value: string): void => (check(), void items.set(name, value)),
  };
}

// The New ticket form filled for a ticket of a workspace.
function fill(page: Page, key: string, workspaceName = 'web'): void {
  page.$('ticket-workspace').value = workspaceName;
  page.$('ticket-key').value = key;
  page.$('ticket-title').value = `Ticket ${key}`;
  page.$('ticket-request').value = 'Make it so.';
}

const created = (workspaceName: string, name: string) => ({ ok: true, result: { workspace: workspaceName, ticket: name, path: `.software-factory/${name}.md`, base: 'main' } });
// The create's answer in a workspace with auto_planner.
const createdAutoPlanner = (workspaceName: string, name: string) => ({ ok: true, result: { ...created(workspaceName, name).result, auto_planner: true } });
const createdText = (workspaceName: string, name: string): string => `Ticket created: .software-factory/${name}.md in ${workspaceName} (base main), an empty skeleton in the Queue. Next: a click on its card opens the conversation; your words are its first message.`;
const pageReads = (page: Page, key: string): FetchRequest[] => page.requests.filter((request) => request.method === 'GET' && request.path === `api/tickets/${key}/page`);
// The ticket's planned page as the server answers it: only its row matters to Create & plan.
const answerPage = (request: FetchRequest, row: ReturnType<typeof ticket>): void => request.respond(200, { ticket: row, task: { text: '---\n---\n', sha256: 'a'.repeat(64) }, plan: null, check: null, history: [], queue: null });
const LINKLESS = 'Open the conversation on the ticket\'s page.';
const BLOCKED = 'The browser blocked the new tab: open the conversation on the ticket\'s page.';

test('setup client: the New ticket form starts on the workspace of the last ticket created in this browser, else the filter\'s, else the first; storage that throws changes nothing', async () => {
  // A stored workspace that is registered is the default.
  const remembered = await openPage([], [workspace('app'), workspace('web')], [], undefined, { localStorage: storage({ 'sf-ticket-workspace': 'web' }) });
  assert.equal(remembered.$('ticket-workspace').value, 'web');

  // One no longer registered falls through to the board's filter, else to the first workspace.
  const gone = await openPage([], [workspace('app'), workspace('web')], [], undefined, { localStorage: storage({ 'sf-ticket-workspace': 'old' }) });
  assert.equal(gone.$('ticket-workspace').value, 'app');
  gone.$('workspace-filter').value = 'web';
  gone.$('workspace-filter').dispatch('change');
  gone.$('ticket-workspace').value = '';
  gone.streams.at(-1)!.emit('workspaces', { workspaces: [workspace('app'), workspace('web')] });
  assert.equal(gone.$('ticket-workspace').value, 'web');

  // A create stores its workspace; a refused one stores nothing.
  const store = storage();
  const page = await openPage([], [workspace('app'), workspace('web')], [], undefined, { localStorage: store });
  assert.equal(page.$('ticket-workspace').value, 'app');
  fill(page, 'W-7');
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  posts(page)[0]!.respond(409, { ok: false, error: { code: 'ticket_exists', message: 'exists' } });
  await page.flush();
  assert.deepEqual([...store.items], []);
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  posts(page)[1]!.respond(200, created('web', 'W-7'));
  await page.flush();
  assert.deepEqual([...store.items], [['sf-ticket-workspace', 'web']]);

  // Storage that throws: the first workspace, and a create without an error.
  const refused = await openPage([], [workspace('app'), workspace('web')], [], undefined, { localStorage: storage({}, true) });
  assert.equal(refused.$('ticket-workspace').value, 'app');
  fill(refused, 'W-7');
  refused.$('ticket-form').dispatch('submit');
  await refused.flush();
  posts(refused)[0]!.respond(200, created('web', 'W-7'));
  await refused.flush();
  assert.deepEqual([refused.$('drawer').hidden, refused.$('toast-text').textContent], [true, createdText('web', 'W-7')]);
});

test('setup client: Create & plan with ChatGPT opens the tab in the click itself, closes it on a refusal, points it at the conversation once created, then opens the ticket\'s page when it is listed', async () => {
  const page = await openPage([], [workspace('app'), workspace('web')], []);
  page.$('open-new-ticket').click();
  // The button sits after Create, off exactly when Create is.
  assert.deepEqual([page.$('ticket-plan').textContent, page.$('ticket-plan').type, page.$('ticket-plan').disabled], ['Create & plan', 'button', false]);
  assert.equal(page.$('ticket-plan').getAttribute('title'), 'Creates the ticket, then opens its planning conversation in a new tab (ChatGPT), or starts its planner session and opens its page (Claude Code)');
  assert.equal(page.$('owner-claude').parentNode!.textContent.trim(), 'Claude Code, in a planner session');

  // A field missing: no tab, no request, Create's words.
  page.$('ticket-plan').click();
  await page.flush();
  assert.deepEqual([page.opened, posts(page), page.$('ticket-status').textContent], [[], [], 'The workspace, the ticket key, the title and the request are all needed.']);

  // Refused: the tab opened in the click's own call (before any wait) closes; the form says why and keeps the input.
  fill(page, 'W-7');
  page.$('ticket-plan').click();
  assert.equal(page.opened.length, 1);
  assert.deepEqual([page.opened[0]!.url, page.opened[0]!.target, page.opened[0]!.tab!.opener], ['', '_blank', null]);
  await page.flush();
  assert.equal(page.$('ticket-plan').disabled, true);
  posts(page)[0]!.respond(409, { ok: false, error: { code: 'ticket_exists', message: 'exists' } });
  await page.flush();
  assert.equal(page.opened[0]!.tab!.closed, true);
  assert.deepEqual([page.$('ticket-status').textContent, page.$('ticket-key').value, page.$('ticket-plan').disabled], ['ticket_exists: exists', 'W-7', false]);

  // Created: the tab gets the server's URL read from the ticket's page; the drawer closes with Create's words.
  page.$('ticket-plan').click();
  await page.flush();
  assert.equal(page.opened.length, 2);
  posts(page)[1]!.respond(200, created('web', 'W-7'));
  await page.flush();
  const row = ticket('web/W-7');
  assert.equal(pageReads(page, 'web/W-7').length, 1);
  answerPage(pageReads(page, 'web/W-7')[0]!, row);
  await page.flush();
  const tab = page.opened[1]!.tab!;
  assert.deepEqual([tab.location.href, tab.opener, tab.closed], [row.conversation.url, null, false]);
  assert.deepEqual([page.$('drawer').hidden, page.$('toast-text').textContent, page.location.hash], [true, createdText('web', 'W-7'), '']);
  // The ticket's page opens once the stream lists the ticket.
  page.streams.at(-1)!.emit('tickets', { tickets: [row], archived: [] });
  await page.flush();
  assert.equal(page.location.hash, '#web/W-7/ticket');

  // A ticket the board already lists when the answer comes: its page opens at once.
  page.$('ticket').querySelector('[data-back]')!.click();
  page.$('open-new-ticket').click();
  fill(page, 'W-8');
  page.$('ticket-plan').click();
  await page.flush();
  page.streams.at(-1)!.emit('tickets', { tickets: [row, ticket('web/W-8')], archived: [] });
  posts(page)[2]!.respond(200, created('web', 'W-8'));
  await page.flush();
  answerPage(pageReads(page, 'web/W-8')[0]!, ticket('web/W-8'));
  await page.flush();
  assert.equal(page.location.hash, '#web/W-8/ticket');
  assert.equal(page.opened[2]!.tab!.location.href, ticket('web/W-8').conversation.url);
  // Only a URL of the ChatGPT prefill ever reached a tab.
  assert.deepEqual(page.opened.filter((entry) => entry.tab!.location.href !== '').map((entry) => entry.tab!.location.href.startsWith(PREFIX)), [true, true]);
});

test('setup client: Create & plan without a link closes the tab, with a blocked tab reads nothing, and for Claude Code opens no tab; each opens the ticket\'s page', async () => {
  const page = await openPage([], [workspace('web')], []);
  page.$('open-new-ticket').click();
  // A message too long for a link: the tab closes and the toast says where the conversation is.
  fill(page, 'W-7');
  page.$('ticket-plan').click();
  await page.flush();
  posts(page)[0]!.respond(200, created('web', 'W-7'));
  await page.flush();
  answerPage(pageReads(page, 'web/W-7')[0]!, ticket('web/W-7', { conversation: { message: 'x'.repeat(9000), url: null } }));
  await page.flush();
  assert.deepEqual([page.opened[0]!.tab!.closed, page.opened[0]!.tab!.location.href], [true, '']);
  assert.equal(page.$('toast-text').textContent, `${createdText('web', 'W-7')} ${LINKLESS}`);
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('web/W-7')], archived: [] });
  await page.flush();
  assert.equal(page.location.hash, '#web/W-7/ticket');

  // A read that fails: the same.
  page.$('ticket').querySelector('[data-back]')!.click();
  page.$('open-new-ticket').click();
  fill(page, 'W-8');
  page.$('ticket-plan').click();
  await page.flush();
  posts(page)[1]!.respond(200, created('web', 'W-8'));
  await page.flush();
  pageReads(page, 'web/W-8')[0]!.fail();
  await page.flush();
  assert.deepEqual([page.opened[1]!.tab!.closed, page.$('toast-text').textContent], [true, `${createdText('web', 'W-8')} ${LINKLESS}`]);

  // The browser blocks the tab: nothing is read, no error, the toast says so, the ticket's page opens.
  page.$('ticket').querySelector('[data-back]')!.click();
  page.$('open-new-ticket').click();
  page.window.blockPopups = true;
  fill(page, 'W-9');
  page.$('ticket-plan').click();
  await page.flush();
  assert.deepEqual([page.opened.length, page.opened[2]!.tab], [3, null]);
  posts(page)[2]!.respond(200, created('web', 'W-9'));
  await page.flush();
  assert.equal(pageReads(page, 'web/W-9').length, 0);
  assert.deepEqual([page.$('drawer').hidden, page.$('toast-text').textContent], [true, `${createdText('web', 'W-9')} ${BLOCKED}`]);
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('web/W-9')], archived: [] });
  await page.flush();
  assert.equal(page.location.hash, '#web/W-9/ticket');

  // Claude Code: no tab; once created, the ticket's planner session starts (one post, {}), and the
  // ticket's page opens, where the planning card shows it starting, then running.
  page.$('ticket').querySelector('[data-back]')!.click();
  page.$('open-new-ticket').click();
  page.window.blockPopups = false;
  page.$('owner-chatgpt').checked = false;
  page.$('owner-claude').checked = true;
  fill(page, 'W-10');
  page.$('ticket-plan').click();
  await page.flush();
  assert.equal(page.opened.length, 3);
  assert.equal(posts(page).length, 4);
  posts(page)[3]!.respond(200, created('web', 'W-10'));
  await page.flush();
  assert.deepEqual([pageReads(page, 'web/W-10').length, page.$('toast-text').textContent], [0, createdText('web', 'W-10')]);
  assert.equal(posts(page).length, 5);
  assert.deepEqual([posts(page)[4]!.path, posts(page)[4]!.body], ['api/tickets/web/W-10/planner', '{}']);
  const row = ticket('web/W-10', { owner: 'claude_code' });
  page.streams.at(-1)!.emit('tickets', { tickets: [row], archived: [] });
  await page.flush();
  assert.equal(page.location.hash, '#web/W-10/ticket');
  pageReads(page, 'web/W-10')[0]!.respond(200, pagePayload(row));
  await page.flush();
  assert.equal(plannerLine(page)!.textContent, 'Starting the planner in the planning copy of web…');
  posts(page)[4]!.respond(200, { ok: true, result: { started: true, session: { ...SESSION, name: 'Planner web W-10' } } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'The planner of web/W-10 started.');
  assert.equal(plannerLine(page)!.textContent, `Planner session "Planner web W-10" runs since ${SESSION_DAY}.${HINT}`);
  assert.equal(posts(page).length, 5);
});

test('setup client: Create with Claude Code, answered with auto_planner, is Create & plan: the images go up, then the planner starts once, and the ticket\'s page opens; an image that fails still starts it and keeps the form open', async () => {
  const page = await openPage([], [workspace('web')], []);
  page.$('open-new-ticket').click();
  page.$('owner-chatgpt').checked = false;
  page.$('owner-claude').checked = true;
  const create = async (key: string): Promise<FetchRequest> => {
    page.$('ticket-form').dispatch('paste', { clipboardData: files(new File([PNG], 'shot.png')) });
    await page.flush();
    fill(page, key);
    page.$('ticket-form').dispatch('submit');
    await page.flush();
    const before = posts(page).length;
    posts(page).at(-1)!.respond(200, createdAutoPlanner('web', key));
    await page.flush();
    // The image goes up first; no start while it is in flight.
    assert.equal(posts(page).length, before + 1);
    const upload = posts(page).at(-1)!;
    assert.equal(upload.path, `api/tickets/web/${key}/attachments?name=1.png`);
    return upload;
  };

  // Every image attached: then the start, once, with {}; a refusal says why in the toast.
  const upload = await create('W-8');
  upload.respond(200, { ok: true, result: { name: '1.png', bytes: PNG.length, type: 'image/png' } });
  await page.flush();
  assert.equal(posts(page).length, 3);
  assert.deepEqual([posts(page)[2]!.path, posts(page)[2]!.body], ['api/tickets/web/W-8/planner', '{}']);
  assert.deepEqual([page.opened.length, page.$('drawer').hidden, page.$('toast-text').textContent], [0, true, `${createdText('web', 'W-8')} 1 image attached.`]);
  const message = 'Claude Code does not trust the planning copy of web yet: run sf planner trust web, accept its trust dialog, then start the planner again.';
  posts(page)[2]!.respond(409, { ok: false, error: { code: 'planning_copy_untrusted', message } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, `planning_copy_untrusted: ${message}`);
  const row = ticket('web/W-8', { owner: 'claude_code' });
  page.streams.at(-1)!.emit('tickets', { tickets: [row], archived: [] });
  await page.flush();
  assert.equal(page.location.hash, '#web/W-8/ticket');
  pageReads(page, 'web/W-8')[0]!.respond(200, pagePayload(row));
  await page.flush();
  assert.equal(plannerLine(page)!.textContent, 'No planner session runs.');
  assert.equal(posts(page).length, 3);

  // An image that fails: the start is still posted; the form stays open with what failed; no page opens.
  page.$('ticket').querySelector('[data-back]')!.click();
  page.$('open-new-ticket').click();
  const failed = await create('W-9');
  failed.respond(400, { ok: false, error: { code: 'attachment_type', message: 'no' } });
  await page.flush();
  assert.equal(posts(page).length, 6);
  assert.deepEqual([posts(page)[5]!.path, posts(page)[5]!.body], ['api/tickets/web/W-9/planner', '{}']);
  assert.deepEqual([page.$('drawer').hidden, page.$('ticket-status').textContent],
    [false, 'Ticket created: .software-factory/W-9.md in web. Not attached: 1.png (attachment_type: no). Add it on the ticket\'s page: paste or drop on its Images card.']);
  posts(page)[5]!.respond(200, { ok: true, result: { started: true, session: { ...SESSION, name: 'Planner web W-9' } } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'The planner of web/W-9 started.');
  page.streams.at(-1)!.emit('tickets', { tickets: [row, ticket('web/W-9', { owner: 'claude_code' })], archived: [] });
  await page.flush();
  assert.deepEqual([page.location.hash, page.$('drawer').hidden, posts(page).length, page.opened.length], ['#', false, 6, 0]);
});

test('setup client: Create starts no planner when the answer has no auto_planner, nor for ChatGPT when it has; no page opens', async () => {
  const page = await openPage([], [workspace('web')], []);
  // Claude Code, the answer without auto_planner: Create as it was.
  page.$('open-new-ticket').click();
  page.$('owner-chatgpt').checked = false;
  page.$('owner-claude').checked = true;
  fill(page, 'W-8');
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  posts(page)[0]!.respond(200, created('web', 'W-8'));
  await page.flush();
  assert.deepEqual([posts(page).length, page.$('drawer').hidden, page.$('toast-text').textContent], [1, true, createdText('web', 'W-8')]);
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('web/W-8', { owner: 'claude_code' })], archived: [] });
  await page.flush();
  assert.equal(page.location.hash, '');

  // ChatGPT, the answer with auto_planner: no start, no tab, no page.
  page.$('open-new-ticket').click();
  page.$('owner-claude').checked = false;
  page.$('owner-chatgpt').checked = true;
  fill(page, 'W-9');
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  posts(page)[1]!.respond(200, createdAutoPlanner('web', 'W-9'));
  await page.flush();
  assert.deepEqual([posts(page).length, page.opened.length, page.$('drawer').hidden, page.$('toast-text').textContent], [2, 0, true, createdText('web', 'W-9')]);
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('web/W-8', { owner: 'claude_code' }), ticket('web/W-9')], archived: [] });
  await page.flush();
  assert.equal(page.location.hash, '');
  assert.equal(pageReads(page, 'web/W-9').length, 0);
});

test('setup client: a ticket Create & plan made opens only where the create left the user; Create alone opens nothing', async () => {
  const page = await openPage([], [workspace('web')], []);
  page.$('open-new-ticket').click();
  fill(page, 'W-7');
  page.$('ticket-plan').click();
  await page.flush();
  posts(page)[0]!.respond(200, created('web', 'W-7'));
  await page.flush();
  answerPage(pageReads(page, 'web/W-7')[0]!, ticket('web/W-7'));
  await page.flush();
  // The New ticket drawer opened again before the stream lists it: nothing opens, and the wait is over.
  page.$('open-new-ticket').click();
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('web/W-7')], archived: [] });
  await page.flush();
  assert.deepEqual([page.location.hash, page.$('drawer').hidden], ['', false]);
  page.$('drawer-close').click();
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('web/W-7')], archived: [] });
  await page.flush();
  assert.equal(page.location.hash, '');

  // Create & plan answered, then Create: the plain create drops the earlier wait; nothing opens.
  page.$('open-new-ticket').click();
  fill(page, 'W-8');
  page.$('ticket-plan').click();
  await page.flush();
  posts(page)[1]!.respond(200, created('web', 'W-8'));
  await page.flush();
  answerPage(pageReads(page, 'web/W-8')[0]!, ticket('web/W-8'));
  await page.flush();
  page.$('open-new-ticket').click();
  fill(page, 'W-9');
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  posts(page)[2]!.respond(200, created('web', 'W-9'));
  await page.flush();
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('web/W-7'), ticket('web/W-8'), ticket('web/W-9')], archived: [] });
  await page.flush();
  assert.equal(page.location.hash, '');
  assert.equal(page.opened.length, 2);
});

test('setup client: a create sent while an earlier Create & plan still reads its link replaces it; the earlier one points its tab but opens no page', async () => {
  const page = await openPage([], [workspace('web')], []);
  page.$('open-new-ticket').click();
  const submit = async (key: string, plan: boolean, index: number): Promise<void> => {
    fill(page, key);
    if (plan) {
      page.$('ticket-plan').click();
    } else {
      page.$('ticket-form').dispatch('submit');
    }
    await page.flush();
    posts(page)[index]!.respond(200, created('web', key));
    await page.flush();
  };

  // Create & plan W-1 waits for its page read; Create W-2 goes in and is answered; then W-1's read answers.
  await submit('W-1', true, 0);
  const firstRead = pageReads(page, 'web/W-1')[0]!;
  await submit('W-2', false, 1);
  answerPage(firstRead, ticket('web/W-1'));
  await page.flush();
  assert.equal(page.opened[0]!.tab!.location.href, ticket('web/W-1').conversation.url);
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('web/W-1'), ticket('web/W-2')], archived: [] });
  await page.flush();
  assert.equal(page.location.hash, '');

  // Create & plan W-3 waits for its read; Create & plan W-4 goes in and completes; W-3's late read opens nothing.
  page.$('open-new-ticket').click();
  await submit('W-3', true, 2);
  const thirdRead = pageReads(page, 'web/W-3')[0]!;
  await submit('W-4', true, 3);
  answerPage(pageReads(page, 'web/W-4')[0]!, ticket('web/W-4'));
  await page.flush();
  answerPage(thirdRead, ticket('web/W-3'));
  await page.flush();
  assert.deepEqual([page.opened[1]!.tab!.location.href, page.opened[2]!.tab!.location.href], [ticket('web/W-3').conversation.url, ticket('web/W-4').conversation.url]);
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('web/W-1'), ticket('web/W-2'), ticket('web/W-3')], archived: [] });
  await page.flush();
  assert.equal(page.location.hash, '');
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('web/W-1'), ticket('web/W-2'), ticket('web/W-3'), ticket('web/W-4')], archived: [] });
  await page.flush();
  assert.equal(page.location.hash, '#web/W-4/ticket');

  // W-5's read answers while the newer W-6 is still being created: the form stays W-6's (its status,
  // the drawer open), W-5's outcome goes to the toast, and W-6's refusal shows in the form.
  page.$('ticket').querySelector('[data-back]')!.click();
  page.$('open-new-ticket').click();
  await submit('W-5', true, 4);
  fill(page, 'W-6');
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  answerPage(pageReads(page, 'web/W-5')[0]!, ticket('web/W-5'));
  await page.flush();
  assert.deepEqual([page.$('drawer').hidden, page.$('ticket-status').textContent, page.$('toast-text').textContent], [false, 'Sending…', createdText('web', 'W-5')]);
  posts(page)[5]!.respond(409, { ok: false, error: { code: 'ticket_exists', message: 'exists' } });
  await page.flush();
  assert.deepEqual([page.$('drawer').hidden, page.$('ticket-status').textContent, page.$('ticket-key').value], [false, 'ticket_exists: exists', 'W-6']);

  // An image of W-7 not attached, its read answering while the newer W-8 is being created: W-7's words go to the toast.
  page.$('ticket-form').dispatch('paste', { clipboardData: files(new File([PNG], 'shot.png')) });
  await page.flush();
  await submit('W-7', true, 6);
  posts(page)[7]!.respond(400, { ok: false, error: { code: 'attachment_type', message: 'no' } });
  await page.flush();
  fill(page, 'W-8');
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  answerPage(pageReads(page, 'web/W-7')[0]!, ticket('web/W-7'));
  await page.flush();
  assert.deepEqual([page.$('drawer').hidden, page.$('ticket-status').textContent], [false, 'Sending…']);
  assert.equal(page.$('toast-text').textContent, 'Ticket created: .software-factory/W-7.md in web. Not attached: 1.png (attachment_type: no). Add it on the ticket\'s page: paste or drop on its Images card.');
});

test('setup client: Create & plan uploads the images before it reads the link; an upload that fails keeps the form open with Create\'s words, still points the tab, and opens no page', async () => {
  const page = await openPage([], [workspace('web')], []);
  page.$('open-new-ticket').click();
  const plan = async (key: string): Promise<{ create: FetchRequest; upload: FetchRequest }> => {
    page.$('ticket-form').dispatch('paste', { clipboardData: files(new File([PNG], 'shot.png')) });
    await page.flush();
    fill(page, key);
    page.$('ticket-plan').click();
    await page.flush();
    const create = posts(page).at(-1)!;
    create.respond(200, created('web', key));
    await page.flush();
    return { create, upload: posts(page).at(-1)! };
  };
  const failText = (key: string): string => `Ticket created: .software-factory/${key}.md in web. Not attached: 1.png (attachment_type: no). Add it on the ticket's page: paste or drop on its Images card.`;

  // Every image attached: the upload, then the read; Create's words with the count, then the page.
  const first = await plan('W-1');
  assert.equal(first.upload.path, 'api/tickets/web/W-1/attachments?name=1.png');
  assert.equal(pageReads(page, 'web/W-1').length, 0);
  first.upload.respond(200, { ok: true, result: { name: '1.png', bytes: PNG.length, type: 'image/png' } });
  await page.flush();
  const read = pageReads(page, 'web/W-1')[0]!;
  assert.ok(page.requests.indexOf(first.upload) < page.requests.indexOf(read));
  answerPage(read, ticket('web/W-1'));
  await page.flush();
  assert.deepEqual([page.opened[0]!.tab!.location.href, page.$('toast-text').textContent], [ticket('web/W-1').conversation.url, `${createdText('web', 'W-1')} 1 image attached.`]);
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('web/W-1')], archived: [] });
  await page.flush();
  assert.equal(page.location.hash, '#web/W-1/ticket');
  page.$('ticket').querySelector('[data-back]')!.click();
  page.$('open-new-ticket').click();

  // An upload that fails: the tab still gets the conversation; the form stays with Create's words; no page opens.
  const second = await plan('W-2');
  second.upload.respond(400, { ok: false, error: { code: 'attachment_type', message: 'no' } });
  await page.flush();
  answerPage(pageReads(page, 'web/W-2')[0]!, ticket('web/W-2'));
  await page.flush();
  assert.deepEqual([page.opened[1]!.tab!.location.href, page.$('drawer').hidden, page.$('ticket-status').textContent], [ticket('web/W-2').conversation.url, false, failText('W-2')]);
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('web/W-1'), ticket('web/W-2')], archived: [] });
  await page.flush();
  assert.deepEqual([page.location.hash, page.$('drawer').hidden], ['#', false]);

  // Without a link, the status line ends with where the conversation is.
  const third = await plan('W-3');
  third.upload.respond(400, { ok: false, error: { code: 'attachment_type', message: 'no' } });
  await page.flush();
  answerPage(pageReads(page, 'web/W-3')[0]!, ticket('web/W-3', { conversation: { message: 'x', url: null } }));
  await page.flush();
  assert.deepEqual([page.opened[2]!.tab!.closed, page.$('ticket-status').textContent], [true, `${failText('W-3')} ${LINKLESS}`]);

  // A blocked tab: nothing read; the status line ends with the blocked tab.
  page.window.blockPopups = true;
  const fourth = await plan('W-4');
  fourth.upload.respond(400, { ok: false, error: { code: 'attachment_type', message: 'no' } });
  await page.flush();
  assert.deepEqual([pageReads(page, 'web/W-4').length, page.$('ticket-status').textContent], [0, `${failText('W-4')} ${BLOCKED}`]);
});
