// Behaviour of the start screen in static/app.js (SF-025), run under node:vm against the fake
// page of test/support/fake-dom.ts: the Setup section open or collapsed from the first data,
// the workspace form and list, the new-ticket form, the tickets with their reviewer line, the
// conversation link (a click, never automatic) and its copy box, and the start confirmation.
// Script checks, not browser acceptance: the manual steps are in factory/README.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
const PREFIX = 'https://chatgpt.com/?q=';

function job(ticket: string, state = 'awaiting_review') {
  return {
    workspace: 'app', ticket, branch: `${ticket}-demo`, base: 'main', state, iteration: 1, mr_attempts: 0,
    updated_at: '2026-11-01T10:05:00.000Z', created_at: '2026-11-01T10:00:00.000Z', error: null, reviewer: 'none',
  };
}

function detail(ticket: string) {
  return { job: job(ticket), iterations: [], mr: false, history: [], reviewer: { status: 'none' }, reviewerSetup: { guide: 'Call guide.', instruction: 'x' } };
}

const workspace = (name: string, liveJobs = 0, problem: string | null = null) => ({ name, path: `/srv/${name}`, liveJobs, problem });

function ticket(key: string, extra: Record<string, unknown> = {}) {
  const [workspaceName, name] = key.split('/') as [string, string];
  const message = `Use the Software Factory connector for ${name}.`;
  return {
    workspace: workspaceName, ticket: name, title: `Ticket ${name}`, base: 'main', draft: true, job: null,
    reviewer: { status: 'none' }, conversation: { message, url: `${PREFIX}${encodeURIComponent(message)}` }, ...extra,
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
  stream.emit('subscriptions', { subscriptions: [] });
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
const link = (item: FakeElement): FakeElement | undefined => item.all().find((element) => element.tagName === 'A');

test('setup client: open until there is a workspace and a job, collapsed with a summary afterwards; the lists and the forms follow the stream', async () => {
  const empty = await openPage([], [], []);
  assert.equal(empty.$('setup').open, true);
  assert.equal(empty.$('setup-summary').textContent, '0 workspaces · 0 tickets without a job');
  assert.equal(empty.$('no-workspaces').hidden, false);
  assert.equal(empty.$('no-tickets').hidden, false);
  assert.equal(empty.$('ticket-create').disabled, true);
  assert.equal(empty.$('ticket-workspace').disabled, true);
  assert.equal(empty.$('detail').hidden, true);

  // A workspace but no job: still open; the ticket form is usable.
  const stream = empty.streams.at(-1)!;
  stream.emit('workspaces', { workspaces: [workspace('app')] });
  assert.equal(empty.$('setup').open, true);
  assert.equal(empty.$('no-workspaces').hidden, true);
  assert.equal(empty.$('ticket-create').disabled, false);
  assert.deepEqual(empty.$('ticket-workspace').children.map((option) => (option as FakeElement).value), ['app']);
  assert.equal(empty.$('ticket-workspace').value, 'app');
  assert.equal(empty.$('setup-summary').textContent, '1 workspace · 0 tickets without a job');

  // Workspaces and jobs: collapsed from the first data, and the User's toggle is kept afterwards
  // (one page at a time: the fake streams belong to the last page loaded).
  const busy = await openPage([job('T-1')], [workspace('app', 1), workspace('web', 0, 'The work checkout does not exist.')], [ticket('app/T-5'), ticket('web/W-1')]);
  assert.equal(busy.$('setup').open, false);
  assert.equal(busy.$('setup-summary').textContent, '2 workspaces · 2 tickets without a job');
  // The list: name, path, the problem, and Remove off while a job is live.
  const [app, web] = items(busy, 'workspace-list');
  assert.equal((app!.children[0] as FakeElement).textContent, 'app');
  assert.equal((app!.children[1] as FakeElement).textContent, '/srv/app');
  assert.equal(buttons(app!)[0]!.disabled, true);
  assert.match(app!.textContent, /1 live job: finish or abort them first\./);
  assert.equal((web!.children[2] as FakeElement).className, 'ws-problem');
  assert.equal((web!.children[2] as FakeElement).textContent, 'The work checkout does not exist.');
  assert.equal(buttons(web!)[0]!.disabled, false);
  busy.$('setup').open = true;
  busy.streams.at(-1)!.emit('workspaces', { workspaces: [workspace('app', 1), workspace('web')] });
  assert.equal(busy.$('setup').open, true);
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
  buttons(items(page, 'workspace-list')[0]!)[0]!.click();
  await page.flush();
  assert.deepEqual([posts(page)[3]!.path, posts(page)[3]!.body], ['api/workspaces/app/remove', '{}']);
  posts(page)[3]!.respond(200, { ok: true, result: { removed: 'app' } });
  await page.flush();
  assert.equal(page.$('workspace-status').textContent, 'Removed app from the registry; the checkout and its files are untouched.');
  page.streams.at(-1)!.emit('workspaces', { workspaces: [workspace('app', 1)] });
  buttons(items(page, 'workspace-list')[0]!)[0]!.click();
  await page.flush();
  assert.equal(posts(page).length, 4);
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
  page.$('ticket-form').dispatch('submit');
  await page.flush();
  posts(page)[1]!.respond(200, { ok: true, result: { workspace: 'web', ticket: 'W-7', path: '.software-factory/W-7.md', base: 'develop' } });
  await page.flush();
  assert.equal(page.$('ticket-status').textContent, 'Ticket created: .software-factory/W-7.md in web (base develop), an empty skeleton. Next, under Tickets: Open the conversation; your words are its first message.');
  assert.deepEqual([page.$('ticket-key').value, page.$('ticket-title').value, page.$('ticket-request').value, page.$('ticket-workspace').value], ['', '', '', 'web']);
});

test('setup client: the tickets with badges, the reviewer line, the conversation link and its copy box; only the server\'s ChatGPT URL becomes a link', async () => {
  const written: string[] = [];
  const page = await openPage([], [workspace('app')], [
    ticket('app/T-5'),
    ticket('app/T-6', { draft: false, job: 'pushed', reviewer: { status: 'subscribed', id: 'sub_own', host: 'chatgpt.example', input: { ticket: 'T-6' }, broad: [] } }),
    ticket('app/T-7', { reviewer: { status: 'broad', id: 'sub_all', host: 'chatgpt.example', input: {}, broad: ['sub_all'] }, conversation: { message: 'x', url: 'javascript:alert(1)' } }),
  ], { writeText: async (text) => void written.push(text) });
  const [five, six, seven] = items(page, 'ticket-list');
  assert.equal((five!.children[0] as FakeElement).textContent, 'app/T-5 · Ticket T-5waiting for the conversation');
  assert.equal((five!.children[0] as FakeElement).all().map((element) => element.className).join(' '), 'badge t-draft');
  assert.equal((five!.children[1] as FakeElement).textContent, '.software-factory/T-5.md · base main');
  assert.equal((five!.children[2] as FakeElement).className, 'ticket-next');
  assert.equal((five!.children[3] as FakeElement).textContent, 'Reviewer: none nobody will review this ticket until ChatGPT subscribes to it: open the conversation.');
  assert.equal(((five!.children[3] as FakeElement).children[0] as FakeElement).className, 'r-none');
  const open = link(five!)!;
  assert.deepEqual([open.textContent, open.href, open.target, open.rel], ['Open the conversation', `${PREFIX}${encodeURIComponent('Use the Software Factory connector for T-5.')}`, '_blank', 'noopener noreferrer']);
  const box = five!.all().find((element) => element.tagName === 'INPUT')!;
  assert.equal(box.value, open.href);
  assert.equal(box.getAttribute('readonly'), '');
  assert.match(five!.textContent, /press Enter if it is not sent by itself/);
  // Nothing opened by itself: no request, no navigation; the link waits for the click.
  assert.equal(page.requests.filter((request) => request.path.startsWith('http')).length, 0);
  // Copy puts the URL on the clipboard.
  buttons(five!).find((button) => button.textContent === 'Copy')!.click();
  await page.flush();
  assert.deepEqual(written, [open.href]);
  assert.equal(page.$('conversation-copy-status').textContent, 'Copied.');

  assert.equal((six!.children[0] as FakeElement).textContent, 'app/T-6 · Ticket T-6last job pushed');
  assert.equal((six!.children[3] as FakeElement).textContent, 'Reviewer: subscribed sub_own, chatgpt.example');
  assert.equal((seven!.children[3] as FakeElement).textContent, 'Reviewer: broad sub_all has no ticket filter; it would review this ticket along with every other one (sf events remove sub_all).');
  // A URL that is not the ChatGPT prefill is not linked and not offered to copy.
  assert.equal(link(seven!), undefined);
  assert.equal(seven!.all().some((element) => element.tagName === 'INPUT'), false);
  // The message is still offered as text to copy; it is never a link.
  assert.equal(buttons(seven!).map((button) => button.textContent).join(','), 'Archive,Delete…,Copy');
});

test('setup client: no Start button; each ticket says what it waits for; a message too long for a link is offered to copy', async () => {
  const long = 'x'.repeat(9000);
  const page = await openPage([], [workspace('app')], [
    ticket('app/T-5'),
    ticket('app/T-6', { draft: false }),
    ticket('app/T-7', { draft: false, job: 'aborted' }),
    ticket('app/T-8', { conversation: { message: long, url: null } }),
  ]);
  const cards = items(page, 'ticket-list');
  assert.ok(cards.every((card) => !buttons(card).some((button) => /Start/.test(button.textContent))));
  const next = (card: FakeElement): string => card.all().find((element) => element.className === 'ticket-next')!.textContent;
  assert.match(next(cards[0]!), /^Next: open the conversation\. The LLM investigates, discusses it with you and writes the Task file; then say start there\.$/);
  assert.equal(next(cards[1]!), "The Task file is written. Say start in the ticket's conversation and the LLM starts the job.");
  assert.equal(next(cards[2]!), "The last job ended aborted. To run it again, say start in the ticket's conversation; or archive the ticket.");
  // Too long for a link: no link, the message in a box with Copy.
  assert.equal(link(cards[3]!), undefined);
  const area = cards[3]!.all().find((element) => element.tagName === 'TEXTAREA')!;
  assert.equal(area.value, long);
  assert.match(cards[3]!.textContent, /too long for a link: copy it and paste it into a new ChatGPT conversation/);
  assert.equal(page.requests.filter((request) => request.method === 'POST').length, 0);
});
