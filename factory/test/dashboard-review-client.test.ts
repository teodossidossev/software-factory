// The Merge requests page in review-page.js, run under node:vm against the fake page of
// test/support/fake-dom.ts: #merge-requests and its header tab, Load (the workspace's open merge
// requests), Fetch comments (the threads, open ones first, the resolved toggle), Create job's
// enabled state and its post (thread ids and instructions only), the new ticket's link and a
// refusal's message, a comment body with <script> shown as text, and the other pages hiding it.
// Script checks, not browser acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
process.env.TZ = 'Europe/Sofia';

const REQUESTS = [
  { number: 4, title: 'Add the export', author: 'alice', source: 'SF-12-export', target: 'main', url: 'https://git.example/app/-/merge_requests/4', updated_at: '2026-11-09T10:00:00Z', draft: false },
  { number: 2, title: 'Fix the login', author: 'bob', source: 'fix-login', target: 'develop', url: 'javascript:alert(3)', updated_at: '2026-11-08T10:00:00Z', draft: true },
];
const SCRIPT = '<script>alert(1)</script><img src=x onerror=alert(2)>';
const THREADS = [
  { id: 'd1', resolved: true, path: 'README.md', line: 3, comments: [{ author: 'carol', body: 'Typo.', created_at: '2026-11-09T09:00:00Z' }] },
  {
    id: 'd2', resolved: false, path: 'src/export.ts', line: 12, comments: [
      { author: 'carol', body: SCRIPT, created_at: '2026-11-09T09:05:00Z' }, { author: 'alice', body: 'Done,\nrenamed.', created_at: '2026-11-09T09:10:00Z' },
    ],
  },
  { id: 'd3', resolved: null, path: null, line: null, comments: [{ author: 'dave', body: 'Add a test.', created_at: '2026-11-09T09:20:00Z' }] },
];

function job(ticket: string) {
  return {
    workspace: 'app', ticket, branch: `${ticket}-x`, base: 'main', state: 'working', iteration: 1, mr_attempts: 0, updated_at: '2026-11-05T10:00:00.000Z', created_at: '2026-11-05T10:00:00.000Z',
    error: null, prepared_commit: null, worktree: `/wt/${ticket}`, fixes: 0, gate_fixes: 0, gate_tokens: 0, files: 0, undeclared: 0, deleted: 0, title: `Ticket ${ticket}`,
    cost_usd: null, review: null, review_ended_at: null, gate: null, now: null, tool_calls: 0, stop: null,
  };
}

function ticketRow(name: string) {
  return {
    workspace: 'app', ticket: name, title: `Ticket ${name}`, base: 'main', draft: false, request: null, job: null, lands_after: [],
    conversation: { message: 'Plan.', url: 'https://chatgpt.com/?q=Plan.' },
    check: { state: 'none', check_reason: null, stale: false, running: false, blockers: 0, majors: 0, nits: 0, ended_at: null, start_note: 'not checked' },
  };
}

const workspaceRow = (name: string) => ({ name, path: `/srv/${name}`, liveJobs: 0, problem: null, handoff: null, color: 'teal' });

// The page at the hash, with the board's data and two workspaces; the host's reads stay pending.
async function openPage(hash: string): Promise<Page> {
  const jobs = [job('T-1')];
  const page = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs } : undefined));
  page.location.hash = hash;
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs });
  stream.emit('workspaces', { workspaces: [workspaceRow('app'), workspaceRow('web')] });
  stream.emit('tickets', { tickets: [ticketRow('P-1')], archived: [] });
  await page.flush();
  return page;
}

const root = (page: Page): FakeElement => page.$('merge-requests');
const control = (page: Page, mq: string): FakeElement | undefined => root(page).querySelectorAll('[data-mq]').find((node) => node.dataset.mq === mq);
const reads = (page: Page, tail: string): FetchRequest[] => page.requests.filter((request) => request.path.startsWith('api/workspaces/') && request.path.endsWith(tail));
const threadItems = (page: Page): FakeElement[] => root(page).querySelectorAll('.mq-thread');
const whereOf = (page: Page): string[] => threadItems(page).map((item) => item.querySelector('.mq-where')!.textContent);

// The page with app's merge requests loaded and !4 chosen.
async function chosen(): Promise<Page> {
  const page = await openPage('#merge-requests');
  control(page, 'load')!.click();
  await page.flush();
  reads(page, '/merge-requests').at(-1)!.respond(200, REQUESTS);
  await page.flush();
  control(page, 'request:4')!.click();
  await page.flush();
  return page;
}

test('review client: the tab and #merge-requests open the page; Load lists the workspace\'s open merge requests; another workspace loads its own', async () => {
  const board = await openPage('');
  assert.equal(root(board).hidden, true);
  board.$('open-merge-requests').click();
  await board.flush();
  assert.deepEqual([root(board).hidden, board.$('board').hidden, board.location.hash], [false, true, '#merge-requests']);

  const page = await openPage('#merge-requests');
  assert.equal(root(page).hidden, false);
  const pick = control(page, 'workspace')!;
  assert.deepEqual(pick.querySelectorAll('option').map((option) => option.textContent), ['app', 'web']);
  assert.equal(page.requests.filter((request) => request.path.startsWith('api/workspaces/')).length, 0);
  control(page, 'load')!.click();
  await page.flush();
  assert.equal(control(page, 'load')!.textContent, 'Loading…');
  assert.deepEqual(reads(page, '/merge-requests').map((request) => [request.method, request.path]), [['GET', 'api/workspaces/app/merge-requests']]);
  reads(page, '/merge-requests')[0]!.respond(200, REQUESTS);
  await page.flush();
  const rows = root(page).querySelectorAll('.mq-req');
  assert.deepEqual(rows.map((row) => row.querySelector('.mq-title')!.textContent), ['!4 Add the export', '!2 Fix the login']);
  assert.deepEqual(rows.map((row) => row.querySelector('.mq-meta')!.textContent), [
    'alice · SF-12-export → main · updated 2026-11-09 12:00:00', 'bob · fix-login → develop · updated 2026-11-08 12:00:00 · draft',
  ]);
  assert.equal(control(page, 'fetch'), undefined);

  pick.value = 'web';
  pick.dispatch('change');
  assert.equal(root(page).querySelectorAll('.mq-req').length, 0);
  control(page, 'load')!.click();
  await page.flush();
  assert.equal(reads(page, '/merge-requests').at(-1)!.path, 'api/workspaces/web/merge-requests');
  reads(page, '/merge-requests').at(-1)!.respond(409, { ok: false, error: { code: 'mr_token_missing', message: 'Merge requests are off for this workspace: SF_GITLAB_TOKEN is not set.' } });
  await page.flush();
  assert.match(root(page).querySelector('.err-text')!.textContent, /SF_GITLAB_TOKEN is not set\.$/);
  assert.equal(root(page).querySelectorAll('.mq-req').length, 0);
});

test('review client: Fetch comments lists the threads, open ones first, the resolved behind "Show resolved (1)"; a <script> body is text', async () => {
  const page = await chosen();
  assert.equal(control(page, 'request:4')!.getAttribute('aria-pressed'), 'true');
  assert.equal(root(page).querySelector('.mq-chosen h3 a')!.href, 'https://git.example/app/-/merge_requests/4');
  // A URL that is not http(s) is no link.
  control(page, 'request:4')!.click();
  control(page, 'request:2')!.click();
  assert.equal(root(page).querySelector('.mq-chosen h3 a'), null);
  control(page, 'request:2')!.click();
  control(page, 'request:4')!.click();
  control(page, 'fetch')!.click();
  await page.flush();
  assert.deepEqual(reads(page, '/threads').map((request) => request.path), ['api/workspaces/app/merge-requests/4/threads']);
  reads(page, '/threads')[0]!.respond(200, THREADS);
  await page.flush();
  assert.deepEqual(whereOf(page), ['src/export.ts:12', 'General']);
  assert.ok(threadItems(page).every((item) => item.querySelector('input')!.checked !== true));
  const toggle = control(page, 'resolved')!;
  assert.deepEqual([toggle.textContent, toggle.getAttribute('aria-expanded')], ['Show resolved (1)', 'false']);
  toggle.click();
  assert.deepEqual(whereOf(page), ['src/export.ts:12', 'General', 'README.md:3']);
  assert.equal(control(page, 'resolved')!.textContent, 'Hide resolved (1)');
  assert.match(threadItems(page)[2]!.textContent, /resolved/);
  control(page, 'resolved')!.click();
  assert.deepEqual(whereOf(page), ['src/export.ts:12', 'General']);

  // The body is one text node: no element was made of it.
  const bodies = threadItems(page)[0]!.querySelectorAll('.mq-cbody');
  assert.deepEqual(bodies.map((node) => node.textContent), [SCRIPT, 'Done,\nrenamed.']);
  assert.ok(bodies[0]!.children.every((child) => !('tagName' in child)));
  assert.equal(root(page).querySelectorAll('script').length + root(page).querySelectorAll('img').length, 0);
  assert.deepEqual(threadItems(page)[0]!.querySelectorAll('.mq-chead b').map((node) => node.textContent), ['carol', 'alice']);
});

test('review client: Create job is on with a ticked thread or instructions; it posts the ids and the text only; the new ticket links to its page; a refusal shows the server\'s message', async () => {
  const page = await chosen();
  const create = () => control(page, 'create')!;
  // Instructions alone, without fetching the comments.
  assert.equal(create().disabled, true);
  const text = control(page, 'text')!;
  assert.equal((text as unknown as { maxLength: number }).maxLength, 4000);
  text.value = '   ';
  text.dispatch('input');
  assert.equal(create().disabled, true);
  text.value = 'Fix this and that.';
  text.dispatch('input');
  assert.equal(create().disabled, false);
  text.value = '';
  text.dispatch('input');
  assert.equal(create().disabled, true);

  control(page, 'fetch')!.click();
  await page.flush();
  reads(page, '/threads')[0]!.respond(200, THREADS);
  await page.flush();
  const box = control(page, 'thread:d2')!;
  box.checked = true;
  box.dispatch('change');
  assert.equal(create().disabled, false);
  // The page drew the list again: the checkbox is a new element.
  const again = control(page, 'thread:d2')!;
  assert.equal(again.checked, true);
  again.checked = false;
  again.dispatch('change');
  assert.equal(create().disabled, true);
  for (const id of ['d2', 'd3']) {
    const tick = control(page, `thread:${id}`)!;
    tick.checked = true;
    tick.dispatch('change');
  }
  control(page, 'text')!.value = 'Keep the old name.';
  control(page, 'text')!.dispatch('input');

  create().click();
  await page.flush();
  assert.equal(create().disabled, true);
  const posts = page.requests.filter((request) => request.method === 'POST');
  assert.deepEqual(posts.map((request) => [request.path, JSON.parse(request.body!)]), [
    ['api/workspaces/app/merge-requests/4/job', { threads: ['d2', 'd3'], instructions: 'Keep the old name.' }],
  ]);
  posts[0]!.respond(200, { ok: true, result: { workspace: 'app', ticket: 'SF-12-review-1', path: '.software-factory/SF-12-review-1.md', position: 2 } });
  await page.flush();
  const done = root(page).querySelector('.mq-created')!;
  assert.equal(done.textContent, 'Created SF-12-review-1, queued at position 2.');
  assert.equal(done.querySelector('a')!.href, '#app/SF-12-review-1/ticket');
  assert.equal(create().disabled, true);
  assert.equal(control(page, 'text')!.value, '');

  control(page, 'thread:d3')!.checked = true;
  control(page, 'thread:d3')!.dispatch('change');
  create().click();
  await page.flush();
  page.requests.filter((request) => request.method === 'POST')[1]!.respond(400, { ok: false, error: { code: 'invalid_request', message: 'Merge request !4 has no review thread d3.' } });
  await page.flush();
  assert.equal(root(page).querySelector('.err-text')!.textContent, 'Merge request !4 has no review thread d3.');
  assert.equal(root(page).querySelector('.mq-created'), null);
  assert.equal(create().disabled, false);
});

test('review client: Escape goes back to the board; the board, job, ticket, digest and stats pages hide #merge-requests', async () => {
  const page = await openPage('#merge-requests');
  root(page).querySelector('[data-back]')!.focus();
  page.key('Escape');
  assert.deepEqual([root(page).hidden, page.$('board').hidden, page.location.hash], [true, false, '#']);

  for (const [hash, shown] of [['#app/T-1', 'job'], ['#app/P-1/ticket', 'ticket'], ['#digest', 'digest'], ['#stats', 'stats'], ['', 'board']] as const) {
    page.location.hash = '#merge-requests';
    page.window.dispatch('hashchange');
    await page.flush();
    assert.equal(root(page).hidden, false, hash);
    page.location.hash = hash;
    page.window.dispatch('hashchange');
    await page.flush();
    assert.deepEqual([root(page).hidden, page.$(shown).hidden], [true, false], hash);
  }
});

test('review client: Digest and Stats opened by their tab or the page select, without a hashchange, hide #merge-requests', async () => {
  const page = await openPage('#merge-requests');
  const opens: Array<[string, () => void]> = [
    ['digest', () => page.$('open-digest').click()],
    ['stats', () => page.$('open-stats').click()],
    ['digest', () => {
      page.$('page-select').value = 'digest';
      page.$('page-select').dispatch('change');
    }],
    ['stats', () => {
      page.$('page-select').value = 'stats';
      page.$('page-select').dispatch('change');
    }],
  ];
  for (const [shown, open] of opens) {
    page.$('page-select').value = 'merge-requests';
    page.$('page-select').dispatch('change');
    await page.flush();
    assert.deepEqual([root(page).hidden, page.location.hash], [false, '#merge-requests'], shown);
    const hashchanges = page.pushed.length;
    open();
    await page.flush();
    assert.deepEqual([root(page).hidden, page.$(shown).hidden, page.location.hash.startsWith(`#${shown}`)], [true, false, true], shown);
    // The page was opened by pushState only: no hashchange reached route().
    assert.equal(page.pushed.length, hashchanges + 1, shown);
  }
});
