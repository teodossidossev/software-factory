// Behaviour of the v3 board in static/app.js (SF-046, SF-077), run under node:vm against the fake page
// of test/support/fake-dom.ts: the five columns from the job states and the tickets, Done's last
// eight, each card kind (the Now line and the tool calls, the reason and the one button of STOPS for
// every stop code, ready, paused, done), the iteration shown, the cost and the elapsed time, the
// Queue card's Start with its confirmation, refusal and unknown outcome, the Queue card opening the
// planned ticket's page (SF-081; the page itself is in dashboard-ticket-client.test.ts), the workspace filter, the job's full page and the routing by the URL hash, the keys, the
// 15 s read of api/jobs, the toast, the queue controls hidden without SF-071, and no inline style or
// prototype-only part; SF-084: the dependency chips and their states, Needed by, the highlight, the
// chip's focus, the cycle line, the workspace stripe and chip, the filter chips and the ⋯ menu. Script checks, not browser acceptance: the manual steps are in factory/README.md.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { type WorkspaceColor, workspaceColor } from '../src/registry.js';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
process.env.TZ = 'Europe/Sofia';
const COLUMNS = ['queue', 'implementing', 'reviewing', 'you', 'done'] as const;
const LISTS: Record<(typeof COLUMNS)[number], string> = { queue: 'qlist', implementing: 'list-implementing', reviewing: 'list-reviewing', you: 'list-you', done: 'list-done' };
const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60000).toISOString();

function job(ticket: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    workspace: 'app', ticket, branch: `${ticket}-demo`, base: 'main', state, iteration: 1, mr_attempts: 0,
    updated_at: minutesAgo(4), created_at: '2026-11-01T10:00:00.000Z', error: null,
    prepared_commit: state === 'ready_for_human_review' ? 'a'.repeat(40) : null, worktree: state === 'ready_for_human_review' ? null : `/wt/${ticket}`,
    fixes: 0, gate_fixes: 0, gate_tokens: 0, files: 0, undeclared: 0, deleted: 0, title: `Title of ${ticket}`, cost_usd: null, review: null, review_ended_at: null, gate: null,
    now: null, tool_calls: 0, stop: null, ...extra,
  };
}

function detail(row: ReturnType<typeof job>) {
  return { job: row, iterations: [], mr: false, gate: true, history: [] };
}

function ticket(key: string, extra: Record<string, unknown> = {}) {
  const [workspace, name] = key.split('/') as [string, string];
  return { workspace, ticket: name, title: `Ticket ${name}`, base: 'main', draft: false, request: null, job: null, conversation: { message: 'm', url: null }, ...extra };
}

// The colour as the server sends it (SF-084): the configured one, else the hash of the name.
const workspace = (name: string, color?: WorkspaceColor) => ({ name, path: `/srv/${name}`, liveJobs: 0, problem: null, handoff: null, color: workspaceColor(name, color) });

type Job = ReturnType<typeof job>;

// answer.jobs off leaves later api/jobs reads to the test.
async function openBoard(jobs: Job[], tickets: ReturnType<typeof ticket>[], workspaces = [workspace('app')], hash = '', answer = { jobs: true }): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return answer.jobs ? { jobs } : undefined;
    }
    const match = /^api\/jobs\/([^/]+)\/([^/]+)$/.exec(path);
    const found = match ? jobs.find((row) => row.ticket === match[2]) : undefined;
    return found ? detail(found) : undefined;
  });
  page.location.hash = hash;
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs });
  stream.emit('workspaces', { workspaces });
  stream.emit('tickets', { tickets, archived: [] });
  await page.flush();
  return page;
}

const isCard = (child: unknown): child is FakeElement => (child as FakeElement).classList?.contains('card') === true;
const cards = (page: Page, column: (typeof COLUMNS)[number]): FakeElement[] => page.$(LISTS[column]).children.filter(isCard);
const keyOfCard = (item: FakeElement): string => item.dataset.open ?? item.dataset.ticket!;
const keys = (page: Page, column: (typeof COLUMNS)[number]): string[] => cards(page, column).map(keyOfCard);
const card = (page: Page, key: string): FakeElement => COLUMNS.flatMap((column) => cards(page, column)).find((item) => keyOfCard(item) === key)!;
const buttons = (item: FakeElement): FakeElement[] => item.all().filter((element) => element.tagName === 'BUTTON');
const labels = (item: FakeElement): string[] => buttons(item).map((element) => element.textContent);
const button = (item: FakeElement, label: string): FakeElement | undefined => buttons(item).find((element) => element.textContent === label);
const part = (item: FakeElement, className: string): FakeElement | undefined => item.all().find((element) => element.classList.contains(className));
const posts = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'POST');
const jobReads = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'GET' && request.path === 'api/jobs');
const onJobPage = (page: Page): boolean => !page.$('job').hidden && page.$('board').hidden;

test('board client: the five columns follow the states, the Queue holds the planned tickets, the headers count, Done shows the last eight', async () => {
  const states = ['starting', 'working', 'awaiting_review', 'preparing_mr', 'needs_human', 'ready_for_human_review', 'paused', 'pushed', 'aborted', 'failed'];
  const jobs = states.map((state, index) => job(`J-${index}`, state));
  const page = await openBoard(jobs, [ticket('app/T-1', { draft: true }), ticket('app/T-2', { job: 'failed' })]);
  assert.deepEqual(keys(page, 'queue'), ['app/T-1', 'app/T-2']);
  assert.deepEqual(keys(page, 'implementing').sort(), ['app/J-0', 'app/J-1']);
  assert.deepEqual(keys(page, 'reviewing').sort(), ['app/J-2', 'app/J-3']);
  assert.deepEqual(keys(page, 'you').sort(), ['app/J-4', 'app/J-5', 'app/J-6']);
  assert.deepEqual(keys(page, 'done').sort(), ['app/J-7', 'app/J-8', 'app/J-9']);
  assert.deepEqual(COLUMNS.map((column) => page.$(`count-${column}`).textContent), ['2', '2', '2', '3', '3']);
  // The column headings and the top bar: "N wait for you · M running", and the page title.
  assert.deepEqual(page.document.querySelectorAll('#cols .col h2').map((heading) => heading.textContent), ['Queue 2', 'Implementing 2', 'Reviewing 2', 'Your turn 3', 'Done 3']);
  assert.equal(page.$('summary').textContent, '3 wait for you · 4 running');
  // Connected: no connection tag; not connected: a tag says so.
  assert.equal(page.$('connection').hidden, true);
  page.streams.at(-1)!.emit('error');
  assert.deepEqual([page.$('connection').hidden, page.$('connection').className, page.$('connection').textContent], [false, 'tag down', 'reconnecting']);
  assert.equal(page.document.title, '(3) Software Factory');
  // A card: the key, the title (the branch without one); the Queue's card the last job's state.
  assert.match(card(page, 'app/J-1').textContent, /^J-1/);
  assert.equal(part(card(page, 'app/J-1'), 'title')!.textContent, 'Title of J-1');
  assert.match(card(page, 'app/T-2').textContent, /last job failed/);
  // An empty column says so: the Queue with Planned's text, the others with the prototype's.
  page.streams.at(-1)!.emit('tickets', { tickets: [], archived: [] });
  page.streams.at(-1)!.emit('jobs', { jobs: [] });
  assert.deepEqual(COLUMNS.map((column) => page.$(LISTS[column]).children.map((child) => [(child as FakeElement).className, child.textContent])), [
    [['empty', 'No ticket waits to start.']], [['empty', 'Nothing is being implemented.']], [['empty', 'Nothing is in review.']],
    [['empty', 'Nothing waits for you.']], [['empty', 'No finished job.']],
  ]);
  assert.deepEqual([page.$('summary').textContent, page.document.title], ['0 wait for you · 0 running', 'Software Factory']);
  // Without SF-071 the Queue has no queued part: no empty-queue line, no "Not queued" divider.
  assert.equal(page.document.querySelectorAll('#qlist .qdiv').length, 0);

  // Done: pushed, aborted and failed, the most recent first, the last eight, then Show all and back.
  const done = Array.from({ length: 12 }, (_, index) => job(`D-${String(index).padStart(2, '0')}`, ['pushed', 'aborted', 'failed'][index % 3]!, { updated_at: `2026-11-01T10:${String(index).padStart(2, '0')}:00.000Z`, title: null }));
  page.streams.at(-1)!.emit('jobs', { jobs: done });
  assert.equal(page.$('count-done').textContent, '12');
  assert.deepEqual(keys(page, 'done'), ['app/D-11', 'app/D-10', 'app/D-09', 'app/D-08', 'app/D-07', 'app/D-06', 'app/D-05', 'app/D-04']);
  assert.equal(part(card(page, 'app/D-11'), 'title')!.textContent, 'D-11-demo');
  assert.deepEqual([page.$('done-all').hidden, page.$('done-all').className, page.$('done-all').textContent], [false, 'linkish', 'Show all 12']);
  page.$('done-all').click();
  assert.equal(keys(page, 'done').length, 12);
  assert.equal(page.$('done-all').textContent, 'Show the last 8');
  page.$('done-all').click();
  assert.equal(keys(page, 'done').length, 8);
});

test('board client: one column per ticket: a pushed one only in Done, a failed or aborted one in the Queue with Start, an active one once', async () => {
  // The tickets list says what the jobs were when it was read; the jobs list is newer (W-1 was
  // started again since). A failed job whose Task file is archived has no Queue card: it stays
  // in Done.
  const jobs = [job('P-1', 'pushed'), job('F-1', 'failed', { error: { code: 'boom', message: 'it broke' } }), job('A-1', 'aborted'), job('W-1', 'working'), job('X-1', 'failed')];
  const tickets = [ticket('app/A-1', { job: 'aborted' }), ticket('app/F-1', { job: 'failed' }), ticket('app/N-1'), ticket('app/P-1', { job: 'pushed' }), ticket('app/W-1', { job: 'failed' })];
  const page = await openBoard(jobs, tickets);
  assert.deepEqual(keys(page, 'queue'), ['app/A-1', 'app/F-1', 'app/N-1']);
  assert.deepEqual(keys(page, 'implementing'), ['app/W-1']);
  assert.deepEqual(keys(page, 'done').sort(), ['app/P-1', 'app/X-1']);
  assert.deepEqual(COLUMNS.map((column) => page.$(`count-${column}`).textContent), ['3', '1', '0', '0', '2']);
  const all = COLUMNS.flatMap((column) => keys(page, column));
  assert.equal(new Set(all).size, all.length);
  // The Done card of the pushed job: its Task file is still active, so the card archives it; a
  // failed Done card has no button.
  assert.deepEqual(labels(card(page, 'app/X-1')), []);
  button(card(page, 'app/P-1'), 'Archive ticket')!.click();
  await page.flush();
  assert.deepEqual(posts(page).map((request) => request.path), ['api/tickets/app/P-1/archive']);
  for (const [key, mark] of [['app/F-1', 'last job failed'], ['app/A-1', 'last job aborted']] as const) {
    const item = card(page, key);
    assert.ok(button(item, 'Start'), key);
    assert.equal(button(item, mark)!.className, 'tag', key);
  }
  assert.doesNotMatch(card(page, 'app/N-1').textContent, /last job/);
  // The mark opens the last job's page.
  button(card(page, 'app/F-1'), 'last job failed')!.click();
  await page.flush();
  assert.equal(page.location.hash, '#app/F-1');
  assert.ok(onJobPage(page));
  // A job pushed since the tickets were read leaves the Queue at once.
  page.streams.at(-1)!.emit('jobs', { jobs: [job('P-1', 'pushed'), job('F-1', 'pushed'), job('A-1', 'aborted'), job('W-1', 'working'), job('X-1', 'failed')] });
  assert.deepEqual(keys(page, 'queue'), ['app/A-1', 'app/N-1']);
  assert.deepEqual(keys(page, 'done').sort(), ['app/F-1', 'app/P-1', 'app/X-1']);
});

test('board client: a Queue card: the check chip, Start (secondary), Task and the ⋯ menu with Check, Archive and Delete…; a skeleton waits for the plan', async () => {
  const check = (extra: Record<string, unknown> = {}) => ({ state: 'none', stale: false, running: false, blockers: 0, majors: 0, nits: 0, ended_at: null, start_note: 'not checked', ...extra });
  const page = await openBoard([], [
    ticket('app/T-1', { draft: true, check: check() }), ticket('app/T-2', { check: check({ state: 'ready', start_note: null }) }), ticket('app/T-3'),
  ]);
  const chip = (item: FakeElement) => part(item, 'cnote')!;
  const skeleton = card(page, 'app/T-1');
  assert.equal(chip(skeleton).textContent, 'draft');
  assert.match(part(skeleton, 'act')!.textContent, /^waiting for the plan/);
  // The check note twice: on the first line, and under the title for a card too narrow (CSS).
  assert.deepEqual(labels(skeleton), ['draft', 'draft', 'Task', '⋯', 'Archive', 'Delete…']);
  const ready = card(page, 'app/T-2');
  assert.equal(chip(ready).textContent, 'check: ready');
  assert.deepEqual(buttons(ready).map((element) => [element.textContent, element.className]), [
    ['check: ready', 'tag cnote'], ['check: ready', 'tag cnote below'], ['Start', 'btn small'], ['Task', 'btn small'], ['⋯', 'btn small more'],
    ['Check', 'btn small'], ['Archive', 'btn small'], ['Delete…', 'btn small danger'],
  ]);
  // In the Queue no button is primary (SF-084): the only solid ones are Your turn's.
  assert.deepEqual(['app/T-1', 'app/T-2', 'app/T-3'].map((key) => buttons(card(page, key)).filter((element) => element.classList.contains('primary')).length), [0, 0, 0]);
  // Without the Task checks there is no Check.
  assert.deepEqual([chip(card(page, 'app/T-3')).textContent, labels(card(page, 'app/T-3'))], ['not checked', ['not checked', 'not checked', 'Start', 'Task', '⋯', 'Archive', 'Delete…']]);
  // The ⋯ menu is closed until its button opens it; a click elsewhere or Escape closes it.
  const menu = () => part(card(page, 'app/T-3'), 'cmenu')!;
  const toggle = () => button(card(page, 'app/T-3'), '⋯')!;
  assert.deepEqual([menu().hidden, menu().getAttribute('role'), toggle().getAttribute('aria-expanded'), toggle().getAttribute('aria-haspopup')], [true, 'menu', 'false', 'menu']);
  toggle().click();
  assert.deepEqual([menu().hidden, toggle().getAttribute('aria-expanded'), page.document.activeElement?.textContent], [false, 'true', 'Archive']);
  assert.equal(part(card(page, 'app/T-2'), 'cmenu')!.hidden, true);
  page.key('Escape');
  assert.deepEqual([menu().hidden, page.document.activeElement], [true, toggle()]);
  toggle().click();
  page.$('summary').click();
  assert.equal(menu().hidden, true);
  // Archive and Delete… go through the confirmation and the routes of today.
  toggle().click();
  button(card(page, 'app/T-3'), 'Delete…')!.click();
  assert.deepEqual([page.$('ticket-confirm').hidden, page.$('ticket-confirm-title').textContent, menu().hidden], [false, 'Delete app/T-3?', true]);
  page.$('ticket-cancel').click();
  button(card(page, 'app/T-3'), 'Archive')!.click();
  await page.flush();
  button(card(page, 'app/T-2'), 'Check')!.click();
  await page.flush();
  assert.deepEqual(posts(page).map((request) => request.path), ['api/tickets/app/T-3/archive', 'api/tickets/app/T-2/check']);
  // A click on a button does not open the ticket; the check chip and Task open its page (SF-081).
  assert.equal(page.$('ticket').hidden, true);
  chip(card(page, 'app/T-2')).click();
  await page.flush();
  assert.deepEqual([page.$('ticket').hidden, page.$('board').hidden, page.$('drawer').hidden, page.location.hash], [false, true, true, '#app/T-2/ticket']);
  page.$('ticket').querySelector('[data-back]')!.click();
  button(card(page, 'app/T-3'), 'Task')!.click();
  await page.flush();
  assert.deepEqual([page.$('ticket').hidden, page.location.hash], [false, '#app/T-3/ticket']);
});

test('board client: Start asks first, naming the workspace, the ticket and the base; Cancel sends nothing; a refusal shows in the toast as it comes', async () => {
  const page = await openBoard([], [ticket('app/T-1', { draft: true }), ticket('app/T-2', { base: 'develop', job: 'failed' })]);
  assert.equal(button(card(page, 'app/T-1'), 'Start'), undefined);
  const start = button(card(page, 'app/T-2'), 'Start')!;
  assert.equal(start.disabled, false);

  start.click();
  assert.equal(page.$('ticket-confirm').hidden, false);
  assert.equal(page.$('ticket-confirm-title').textContent, 'Start T-2 in app?');
  assert.match(page.$('ticket-confirm-text').textContent, /\.software-factory\/T-2\.md of workspace app: a new branch from develop in its own worktree/);
  assert.equal(page.$('ticket-ok').textContent, 'Start the job');
  // While it is open, the card's buttons are off.
  assert.equal(button(card(page, 'app/T-2'), 'Start')!.disabled, true);
  page.$('ticket-cancel').click();
  await page.flush();
  assert.equal(page.$('ticket-confirm').hidden, true);
  assert.equal(posts(page).length, 0);

  // Confirmed: one POST, off while it is out, a second click sends nothing.
  button(card(page, 'app/T-2'), 'Start')!.click();
  page.$('ticket-ok').click();
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.deepEqual([posts(page)[0]!.path, posts(page)[0]!.body, posts(page)[0]!.headers['content-type']], ['api/tickets/app/T-2/start', '{}', 'application/json']);
  assert.match(page.$('toast-text').textContent, /^Starting app\/T-2/);
  assert.equal(button(card(page, 'app/T-2'), 'Start')!.disabled, true);
  page.$('ticket-ok').click();
  await page.flush();
  assert.equal(posts(page).length, 1);
  posts(page)[0]!.respond(409, { ok: false, error: { code: 'job_limit', message: 'Workspace app has 2 live job(s); SF_MAX_JOBS is 2.' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'job_limit: Workspace app has 2 live job(s); SF_MAX_JOBS is 2.');
  assert.deepEqual([page.$('toast').hidden, page.$('toast').className, page.$('toast').getAttribute('role')], [false, 'err', 'alert']);
  assert.equal(button(card(page, 'app/T-2'), 'Start')!.disabled, false);
  assert.equal(posts(page).length, 1);

  // Accepted: the result as text; the card moves when the stream says so.
  button(card(page, 'app/T-2'), 'Start')!.click();
  page.$('ticket-ok').click();
  await page.flush();
  posts(page)[1]!.respond(200, { ok: true, result: { branch: 'T-2-ticket-t-2', state: 'working', check_after_minutes: 15, worktree: '/wt/T-2' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'Started app/T-2: branch T-2-ticket-t-2, working. The Implementer runs iteration 1.');
  assert.deepEqual([page.$('toast').className, page.$('toast').getAttribute('role')], ['', 'status']);
  const stream = page.streams.at(-1)!;
  stream.emit('jobs', { jobs: [job('T-2', 'working')] });
  stream.emit('tickets', { tickets: [ticket('app/T-1', { draft: true })], archived: [] });
  assert.deepEqual([keys(page, 'queue'), keys(page, 'implementing')], [['app/T-1'], ['app/T-2']]);
});

test('board client: the toast: ok and info go after 6 s but not while hovered, errors stay until closed, × and Escape close, a new message replaces the old', async () => {
  const page = await openBoard([], [ticket('app/T-2'), ticket('app/T-3')]);
  button(card(page, 'app/T-2'), 'Archive')!.click();
  await page.flush();
  posts(page)[0]!.respond(200, { ok: true, result: { workspace: 'app', ticket: 'T-2', path: '.software-factory/archive/T-2.md', jobArchived: false } });
  await page.flush();
  assert.deepEqual([page.$('toast').hidden, page.$('toast-text').textContent], [false, 'Archived app/T-2: .software-factory/archive/T-2.md.']);
  // Hovered, it stays; left, it goes 6 s later.
  page.$('toast').dispatch('mouseenter');
  assert.equal(page.tick(6000), 0);
  assert.equal(page.$('toast').hidden, false);
  page.$('toast').dispatch('mouseleave');
  assert.equal(page.tick(6000), 1);
  assert.equal(page.$('toast').hidden, true);
  // An error stays; a new message replaces it; × closes.
  button(card(page, 'app/T-3'), 'Archive')!.click();
  await page.flush();
  posts(page)[1]!.respond(409, { ok: false, error: { code: 'job_active', message: 'A job runs.' } });
  await page.flush();
  assert.equal(page.tick(6000), 0);
  assert.deepEqual([page.$('toast').hidden, page.$('toast-text').textContent, page.$('toast').getAttribute('role')], [false, 'job_active: A job runs.', 'alert']);
  page.$('toast-close').click();
  assert.equal(page.$('toast').hidden, true);
  button(card(page, 'app/T-3'), 'Archive')!.click();
  await page.flush();
  posts(page)[2]!.respond(409, { ok: false, error: { code: 'job_active', message: 'Still.' } });
  await page.flush();
  assert.equal(page.$('toast').hidden, false);
  page.key('Escape');
  assert.equal(page.$('toast').hidden, true);
});

test('board client: a start whose answer is lost holds Start until the board is read again; nothing is re-sent', async () => {
  const answer = { jobs: true };
  const page = await openBoard([], [ticket('app/T-2')], [workspace('app')], '', answer);
  answer.jobs = false;
  button(card(page, 'app/T-2'), 'Start')!.click();
  page.$('ticket-ok').click();
  await page.flush();
  posts(page)[0]!.fail();
  await page.flush();
  assert.match(page.$('toast-text').textContent, /^The start of app\/T-2 failed \(Failed to fetch\)\. Its outcome is unknown: the job may have started; the board is being read again\.$/);
  assert.equal(button(card(page, 'app/T-2'), 'Start')!.disabled, true);
  // The read: the job exists, so the ticket is only on Implementing (one column per ticket); once
  // the job has failed the ticket is in the Queue again and Start is back.
  const read = jobReads(page).at(-1)!;
  read.respond(200, { jobs: [job('T-2', 'starting')] });
  await page.flush();
  assert.deepEqual([keys(page, 'queue'), keys(page, 'implementing')], [[], ['app/T-2']]);
  assert.match(page.$('toast-text').textContent, /The board is current: check it before starting again\.$/);
  page.streams.at(-1)!.emit('jobs', { jobs: [job('T-2', 'failed')] });
  assert.deepEqual([keys(page, 'queue'), keys(page, 'done')], [['app/T-2'], []]);
  assert.equal(button(card(page, 'app/T-2'), 'Start')!.disabled, false);

  // A failed read keeps the hold until the stream's next jobs event.
  button(card(page, 'app/T-2'), 'Start')!.click();
  page.$('ticket-ok').click();
  await page.flush();
  posts(page)[1]!.failBody(200);
  await page.flush();
  jobReads(page).at(-1)!.fail();
  await page.flush();
  assert.match(page.$('toast-text').textContent, /the board could not be read \(Failed to fetch\)\. Start stays off for app\/T-2 until the page reconnects/);
  assert.equal(button(card(page, 'app/T-2'), 'Start')!.disabled, true);
  page.streams.at(-1)!.emit('jobs', { jobs: [] });
  assert.equal(button(card(page, 'app/T-2'), 'Start')!.disabled, false);
  assert.equal(posts(page).length, 2);
});

test('board client: a click on a Queue card opens the planned ticket as a full page (SF-081), read from its page route; ← Board goes back, the focus on the card; no drawer', async () => {
  const page = await openBoard([], [ticket('app/T-2', { base: 'develop' })]);
  card(page, 'app/T-2').click();
  await page.flush();
  assert.deepEqual([page.$('drawer').hidden, page.$('board').hidden, page.$('ticket').hidden, page.location.hash], [true, true, false, '#app/T-2/ticket']);
  const read = page.requests.at(-1)!;
  assert.deepEqual([read.method, read.path], ['GET', 'api/tickets/app/T-2/page']);
  assert.match(page.$('ticket').textContent, /Loading the ticket…/);
  page.$('ticket').querySelector('[data-back]')!.click();
  assert.deepEqual([page.$('ticket').hidden, page.$('board').hidden, page.location.hash], [true, false, '#']);
  assert.equal(page.document.activeElement, card(page, 'app/T-2'));
  // The drawer's Task panel is the archived ticket's only: no conversation, no check in it.
  for (const id of ['task-conversation', 'task-check']) {
    assert.equal(page.document.getElementById(id), null, id);
  }
});

test('board client: a card moves column on a jobs event; the workspace filter chips keep one workspace and give all back; every card shows its workspace', async () => {
  const page = await openBoard([job('T-1', 'working'), { ...job('W-1', 'working'), workspace: 'web' }], [ticket('web/W-2')], [workspace('app'), workspace('web')]);
  const stream = page.streams.at(-1)!;
  assert.deepEqual(keys(page, 'implementing').sort(), ['app/T-1', 'web/W-1']);
  assert.equal(part(card(page, 'web/W-1'), 'wschip')!.textContent, 'web');
  stream.emit('jobs', { jobs: [job('T-1', 'awaiting_review'), { ...job('W-1', 'working'), workspace: 'web' }] });
  assert.deepEqual([keys(page, 'implementing'), keys(page, 'reviewing')], [['web/W-1'], ['app/T-1']]);
  stream.emit('jobs', { jobs: [job('T-1', 'ready_for_human_review'), { ...job('W-1', 'working'), workspace: 'web' }] });
  assert.deepEqual([keys(page, 'reviewing'), keys(page, 'you')], [[], ['app/T-1']]);
  assert.equal(page.$('count-you').textContent, '1');

  // The filter: All and one chip per workspace (its dot and name); one workspace keeps its cards and counts.
  const filters = () => page.$('workspace-filter').children as FakeElement[];
  assert.deepEqual(filters().map((element) => [element.textContent, element.getAttribute('aria-pressed'), element.className]), [['All workspaces', 'true', 'on'], ['app', 'false', ''], ['web', 'false', '']]);
  assert.deepEqual(filters().slice(1).map((element) => (element.children[0] as FakeElement).className), ['wsdot ws-teal', 'wsdot ws-purple']);
  filters()[2]!.click();
  assert.deepEqual([keys(page, 'queue'), keys(page, 'implementing'), keys(page, 'you')], [['web/W-2'], ['web/W-1'], []]);
  assert.equal(page.$('count-you').textContent, '0');
  // The workspace shows on every card, even when the board shows one workspace (SF-084).
  assert.equal(part(card(page, 'web/W-1'), 'wschip')!.textContent, 'web');
  // The same chip again: every workspace.
  filters()[2]!.click();
  assert.deepEqual([keys(page, 'you'), filters()[0]!.getAttribute('aria-pressed')], [['app/T-1'], 'true']);
  filters()[2]!.click();
  // A removed workspace drops its filter.
  stream.emit('workspaces', { workspaces: [workspace('app')] });
  assert.deepEqual(keys(page, 'you'), ['app/T-1']);
});

test('board client: a running card: the Now line and the tool calls, the cost so far and the time since the start; a finished one the cost and the time it took', async () => {
  const running = job('W', 'working', {
    created_at: minutesAgo(14), cost_usd: 1.234, tool_calls: 14, iteration: 1,
    now: { who: 'Implementer', what: 'Read factory/src/jobs.ts', ts: minutesAgo(1) },
  });
  const review = job('C', 'awaiting_review', { created_at: minutesAgo(64), now: { who: 'Codex gate', what: 'reviewing iteration 2', ts: minutesAgo(1) }, iteration: 2, tool_calls: 1 });
  const fresh = job('S', 'starting', { created_at: minutesAgo(1), iteration: 0 });
  const pushed = job('P', 'pushed', { created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T11:04:00.000Z', cost_usd: 1.234, iteration: 2 });
  const page = await openBoard([running, review, fresh, pushed], []);
  const now = (key: string): [string, string, string | null] => {
    const line = part(card(page, key), 'now')!;
    return [line.children.map((child) => (child as FakeElement).tagName).join(','), line.textContent, (line.children[2] as FakeElement).getAttribute('title')];
  };
  assert.deepEqual(now('app/W'), ['I,B,SPAN', 'Now: ImplementerRead factory/src/jobs.ts', 'Read factory/src/jobs.ts']);
  assert.equal(part(card(page, 'app/W'), 'pulse')!.tagName, 'I');
  assert.equal(part(card(page, 'app/W'), 'meta')!.textContent, 'Iteration 2 · 14 tool calls');
  assert.equal(part(card(page, 'app/W'), 'money')!.textContent, '$1.23 so far · 14 min');
  assert.deepEqual(now('app/C'), ['I,B,SPAN', 'Now: Codex gatereviewing iteration 2', 'reviewing iteration 2']);
  assert.equal(part(card(page, 'app/C'), 'meta')!.textContent, 'Iteration 2 · 1 tool call');
  // No cost yet: nothing about it until one exists (SF-084), only the time.
  assert.equal(part(card(page, 'app/C'), 'money')!.textContent, '1 h 4 min');
  // Before the log has a step: who the state says.
  assert.deepEqual(now('app/S'), ['I,B,SPAN', 'Now: Implementerstarting', 'starting']);
  assert.equal(part(card(page, 'app/S'), 'meta')!.textContent, 'Iteration 1 · 0 tool calls');
  // Not running: the cost and created_at to updated_at; Pushed · 2 iterations · 13:04 (Sofia).
  assert.equal(part(card(page, 'app/P'), 'money')!.textContent, '$1.23 · 1 h 4 min');
  assert.equal(part(card(page, 'app/P'), 'meta')!.textContent, 'Pushed · 2 iterations · 13:04');
  // No primary button outside Your turn.
  assert.deepEqual(['app/W', 'app/C', 'app/S', 'app/P'].map((key) => buttons(card(page, key)).filter((element) => element.classList.contains('primary')).length), [0, 0, 0, 0]);
});

// The stop codes of factory/src and their card: kind, reason, the one button; the counts from stop.
const STOP_CARDS: Array<[string, 'decision' | 'error', string, string, Record<string, unknown>?]> = [
  ['simplify_offered', 'decision', 'Simplification offered', 'Simplify or skip', { stop: { items: [{}, {}], saves_lines: 15 } }],
  ['escalated', 'decision', 'Question for you', 'Answer 2 questions', { stop: { items: [{}, {}], saves_lines: null } }],
  ['review_disputed', 'decision', 'A reviewer disputes a contest', 'Settle 1 finding', { stop: { items: [{}], saves_lines: null } }],
  ['review_churn', 'decision', 'Fixes keep making findings', 'Decide 3 findings', { stop: { items: [{}, {}, {}], saves_lines: null } }],
  ['gate_rounds', 'decision', 'Codex round limit reached', 'Decide 2 findings', { stop: { items: [{}, {}], saves_lines: null } }],
  ['gate_budget', 'decision', 'Codex token budget used up', 'Decide'],
  ['iteration_limit', 'decision', 'Fix round limit reached', 'Give a direction'],
  ['max_turns', 'decision', 'Turn limit reached', 'Tell it to go on'],
  ['gate_failed', 'error', 'Codex gate gave no verdict', 'Decide'],
  ['review_failed', 'error', 'Claude review could not run', 'Retry review'],
  ['serve_restarted', 'error', 'Interrupted by a restart', 'Tell it to go on'],
  ['mr_serve_restarted', 'error', 'MR preparation interrupted', 'Tell it to go on'],
  ['mr_interrupted', 'error', 'MR preparation interrupted', 'Tell it to go on'],
  ['session_failed', 'error', 'Usage limit reached', 'Tell it to go on', { error: { code: 'session_failed', message: "You've hit your weekly limit · resets 3am (Europe/Sofia)" } }],
  ['session_failed', 'error', 'Implementer session failed', 'Tell it to go on'],
  ['turn_failed', 'error', 'Implementer session failed', 'Tell it to go on'],
  ['permission_mode_mismatch', 'error', 'Implementer session failed', 'Tell it to go on'],
  ['sandbox_unavailable', 'error', 'Sandbox unavailable', 'Tell it to go on'],
  ['publish_failed', 'error', 'Iteration not published', 'Tell it to go on'],
  ['mr_conflict', 'error', 'Rebase conflict', 'Tell it how'],
  ['mr_text_missing', 'error', 'MR text missing or invalid', 'Tell it to fix it'],
  ['mr_text_invalid', 'error', 'MR text missing or invalid', 'Tell it to fix it'],
  ['mr_empty', 'error', 'Nothing to commit', 'Tell it what is missing'],
  ['mr_commit_failed', 'error', 'MR preparation failed', 'Tell it to go on'],
  ['mr_rebase_failed', 'error', 'MR preparation failed', 'Tell it to go on'],
  ['mr_failed', 'error', 'MR preparation failed', 'Tell it to go on'],
  ['worktree_remove_failed', 'error', 'Worktree not removed', 'Tell it to go on'],
  ['mr_push_failed', 'error', 'Push failed', 'Push again', { prepared_commit: 'b'.repeat(40), worktree: null }],
  ['mr_push_protected', 'error', 'Push refused', 'Open the job'],
  ['something_new', 'error', 'Stopped', 'Open the job'],
];

test('board client: a needs_human card for every stop code: the reason in plain words, the code as a tag, one primary button; a decision is never an error', async () => {
  const jobs = STOP_CARDS.map(([code, , , , extra], index) => job(`N-${index}`, 'needs_human', { error: { code, message: `The ${code} message.\nMore.` }, updated_at: '2026-11-01T10:07:00.000Z', ...(extra ?? {}) }));
  const page = await openBoard(jobs, []);
  STOP_CARDS.forEach(([code, kind, reason, label, extra], index) => {
    const item = card(page, `app/N-${index}`);
    const line = part(item, 'reason')!;
    assert.deepEqual([line.textContent, line.className], [reason, kind === 'decision' ? 'reason' : 'reason err'], code);
    assert.deepEqual(item.all().filter((element) => element.className === 'tag').map((element) => [element.textContent, element.getAttribute('title')]), [[code, 'error code']], code);
    const primaries = buttons(item).filter((element) => element.classList.contains('primary'));
    assert.deepEqual(primaries.map((element) => [element.textContent, element.className]), [[label, 'btn primary small']], code);
    // A decision never shows red, "!" or "Stopped".
    if (kind === 'decision') {
      assert.doesNotMatch(item.textContent, /!|Stopped/, code);
    }
    const n = Array.isArray((extra?.stop as { items?: unknown[] } | undefined)?.items) ? (extra!.stop as { items: unknown[] }).items.length : 0;
    assert.match(part(item, 'meta')!.textContent, n > 0 ? new RegExp(` · ${n} findings? to decide$`) : / · stopped at 12:07$/, code);
  });
  // A prepared branch also keeps Create merge request… as a secondary button.
  const pushFailed = card(page, `app/N-${STOP_CARDS.findIndex(([code]) => code === 'mr_push_failed')}`);
  assert.deepEqual(buttons(pushFailed).map((element) => [element.textContent, element.className]), [['Push again', 'btn primary small'], ['Create merge request…', 'btn small']]);
  // The card's button opens the job page at the stop (or with the Approve confirmation to push again).
  const decide = card(page, `app/N-${STOP_CARDS.findIndex(([code]) => code === 'gate_rounds')}`);
  assert.deepEqual([button(decide, 'Decide 2 findings')!.dataset.focus, button(card(page, 'app/N-7'), 'Tell it to go on')!.dataset.focus], ['stop', 'composer']);
  button(pushFailed, 'Push again')!.click();
  await page.flush();
  page.streams.at(-1)!.emit('job', detail(jobs[STOP_CARDS.findIndex(([code]) => code === 'mr_push_failed')]!));
  assert.ok(onJobPage(page));
  assert.deepEqual([page.$('confirm').hidden, page.$('confirm-title').textContent], [false, `Approve app/N-${STOP_CARDS.findIndex(([code]) => code === 'mr_push_failed')}?`]);
});

test('board client: a stop card\'s button opens the job page at the message box, or at the stop with its findings', async () => {
  const turns = job('M', 'needs_human', { error: { code: 'max_turns', message: 'x' } });
  const churn = job('C', 'needs_human', { error: { code: 'review_churn', message: 'x' }, stop: { items: [{}], saves_lines: null } });
  const page = await openBoard([turns, churn], []);
  button(card(page, 'app/M'), 'Tell it to go on')!.click();
  await page.flush();
  assert.equal(page.document.activeElement === page.$('msg'), false);
  page.streams.at(-1)!.emit('job', detail(turns));
  assert.equal(page.document.activeElement, page.$('msg'));
  (page.$('jhead').children[0] as FakeElement).click();
  // The stop block comes with the Stream: its needs_human state entry.
  const stop = { k: '0', ts: minutesAgo(1), it: 1, who: 'factory', t: 'state', from: 'awaiting_review', to: 'needs_human', code: 'review_churn', msg: 'x' };
  button(card(page, 'app/C'), 'Decide 1 finding')!.click();
  await page.flush();
  page.streams.at(-1)!.emit('job', detail(churn));
  assert.equal(page.document.getElementById('stopblock'), null);
  page.streams.at(-1)!.emit('entries', { line: 0, entries: [stop] });
  assert.equal(page.$('stopblock').scrolledIntoView, 1);
});

test('board client: the job page says the sentence of the stop with the numbers of the job', async () => {
  const sentences: Array<[Record<string, unknown>, string]> = [
    [{ error: { code: 'simplify_offered', message: 'x' }, stop: { items: [{}, {}], saves_lines: 15 } }, 'The simplification pass suggests 2 changes (saves about 15 lines). Simplify or skip'],
    [{ error: { code: 'simplify_offered', message: 'x' } }, 'The simplification pass suggests changes. Simplify or skip'],
    [{ error: { code: 'escalated', message: 'x' }, stop: { items: [{}, {}], saves_lines: null } }, 'The Implementer asks you about 2 findings. Answer each: Accept risk or Must fix'],
    [{ error: { code: 'gate_rounds', message: 'x' }, gate_fixes: 3, stop: { items: [{}, {}], saves_lines: null } }, 'Codex asked for fixes 3 times, the limit. Accept the change without its 2 open findings, or tell the Implementer what to fix'],
    [{ error: { code: 'iteration_limit', message: 'x' }, fixes: 5 }, 'The reviewers asked for fixes 5 times, the limit. Give the Implementer a direction, or abort'],
    [{ error: { code: 'max_turns', message: 'x' }, iteration: 2 }, 'The Implementer used all its turns on iteration 3. Tell it to go on'],
    [{ error: { code: 'review_failed', message: 'x' }, iteration: 2 }, 'The Claude review of iteration 2 could not run. Retry it'],
    [{ error: { code: 'session_failed', message: "You've hit your limit · resets 3am (Europe/Sofia)" } }, 'The Claude usage limit was reached; it resets at 3am (Europe/Sofia). Tell the Implementer to go on after that'],
    [{ error: { code: 'turn_failed', message: 'The turn ended with error_during_execution.\nstack' } }, "The Implementer's session failed: The turn ended with error_during_execution. Tell it to go on, or restart"],
    [{ error: { code: 'mr_conflict', message: 'x' }, base: 'develop' }, 'The rebase onto develop conflicts and the Implementer could not resolve it. Tell it how, or abort'],
    [{ error: { code: 'mr_push_failed', message: 'rejected\nhint' } }, 'The push of S-demo failed: rejected. Fix the cause, then push again'],
    [{ error: { code: 'odd_code', message: 'Something odd.' } }, 'The job stopped: Something odd. Tell the Implementer what to do, or abort'],
  ];
  for (const [extra, text] of sentences) {
    const row = job('S', 'needs_human', extra);
    const page = await openBoard([row], [], [workspace('app')], '#app/S');
    assert.equal(page.$('jhead').all().find((element) => element.className === 'sentence')!.textContent, text);
  }
});

test('board client: the iteration is numbered from 1 and the same on the card and on the job page', async () => {
  const rows: Array<[Job, string]> = [
    [job('S', 'starting', { iteration: 0 }), 'Iteration 1'],
    [job('W', 'working', { iteration: 1 }), 'Iteration 2'],
    [job('A', 'awaiting_review', { iteration: 1 }), 'Iteration 1'],
    [job('M', 'preparing_mr', { iteration: 2 }), 'Iteration 2'],
    [job('PT', 'paused', { iteration: 1, paused: { from: 'working', step: 'turn', at: minutesAgo(1) } }), 'Iteration 2'],
    [job('PR', 'paused', { iteration: 1, paused: { from: 'awaiting_review', step: 'review', at: minutesAgo(1) } }), 'Iteration 1'],
    [job('R', 'ready_for_human_review', { iteration: 3 }), 'Iteration 3'],
    ...['serve_restarted', 'session_failed', 'turn_failed', 'max_turns', 'sandbox_unavailable', 'permission_mode_mismatch', 'publish_failed'].map((code): [Job, string] =>
      [job(`H-${code}`, 'needs_human', { iteration: 1, error: { code, message: 'x' } }), 'Iteration 2']),
    [job('G', 'needs_human', { iteration: 2, error: { code: 'gate_rounds', message: 'x' } }), 'Iteration 2'],
    [job('Z', 'needs_human', { iteration: 0, error: { code: 'iteration_limit', message: 'x' } }), 'Iteration 1'],
  ];
  const page = await openBoard(rows.map(([row]) => row), []);
  for (const [row, text] of rows) {
    assert.match(part(card(page, `app/${row.ticket}`), 'meta')!.textContent, new RegExp(`^${text}(?: ·|$)`), row.ticket);
    card(page, `app/${row.ticket}`).click();
    await page.flush();
    assert.ok(page.$('jhead').all().some((element) => new RegExp(`^${text}(?: \\(running\\))?$`).test(element.textContent)), row.ticket);
    page.key('Escape');
  }
});

test('board client: the ready card offers Review the MR and push (Approve confirmation on the job page) and Create merge request…; the paused card Resume; Retry review posts once', async () => {
  const failed = job('T-3', 'needs_human', { error: { code: 'review_failed', message: 'overloaded' } });
  const paused = job('T-4', 'paused', { paused: { from: 'working', step: 'turn', at: minutesAgo(1) }, task_changed: true });
  const page = await openBoard([job('T-1', 'ready_for_human_review'), failed, paused], []);
  const ready = card(page, 'app/T-1');
  assert.deepEqual([part(ready, 'reason')!.className, part(ready, 'reason')!.textContent], ['reason ready', 'Ready to push: reviews clean, MR text written']);
  assert.deepEqual(buttons(ready).map((element) => [element.textContent, element.className]), [['Review the MR and push', 'btn primary small'], ['Create merge request…', 'btn small']]);
  assert.deepEqual([part(card(page, 'app/T-4'), 'reason')!.textContent, part(card(page, 'app/T-4'), 'meta')!.textContent], ['Paused by you', 'Iteration 2']);
  assert.match(card(page, 'app/T-4').textContent, /Task file changed since the job started/);
  assert.deepEqual(labels(card(page, 'app/T-4')), ['Resume']);

  button(ready, 'Review the MR and push')!.click();
  await page.flush();
  assert.ok(onJobPage(page));
  // The detail arrives (the GET of the stream's first job event): the confirmation opens on it.
  page.streams.at(-1)!.emit('job', detail(job('T-1', 'ready_for_human_review')));
  assert.equal(page.$('confirm').hidden, false);
  assert.equal(page.$('confirm-title').textContent, 'Approve app/T-1?');
  assert.equal(posts(page).length, 0);
  page.$('confirm-cancel').click();
  (page.$('jhead').children[0] as FakeElement).click();
  assert.equal(onJobPage(page), false);

  button(card(page, 'app/T-3'), 'Retry review')!.click();
  await page.flush();
  assert.deepEqual(posts(page).map((request) => [request.path, request.body]), [['api/jobs/app/T-3/review', '{}']]);
  assert.equal(button(card(page, 'app/T-3'), 'Retry review')!.disabled, true);
  button(card(page, 'app/T-3'), 'Retry review')!.click();
  await page.flush();
  assert.equal(posts(page).length, 1);
  posts(page)[0]!.respond(409, { ok: false, error: { code: 'review_off', message: 'SF_REVIEW is off.' } });
  await page.flush();
  assert.match(card(page, 'app/T-3').textContent, /review_off: SF_REVIEW is off\./);
  assert.equal(button(card(page, 'app/T-3'), 'Retry review')!.disabled, false);
  // The job page did not open for it.
  assert.equal(onJobPage(page), false);
  button(card(page, 'app/T-4'), 'Resume')!.click();
  await page.flush();
  assert.deepEqual(posts(page).at(-1)!.path, 'api/jobs/app/T-4/resume');
  assert.equal(onJobPage(page), false);
});

test('board client: a job card opens the job as a full page, following it on the stream; ← Board and Escape go back, the focus on the card', async () => {
  const page = await openBoard([job('T-1', 'working'), job('T-2', 'awaiting_review')], []);
  assert.equal(page.streams.at(-1)!.url, 'api/stream?');
  card(page, 'app/T-1').click();
  await page.flush();
  assert.ok(onJobPage(page));
  assert.deepEqual([page.$('drawer').hidden, page.$('scrStream').hidden], [true, false]);
  // The Stream is read first, then followed live from the next line.
  assert.deepEqual(page.requests.filter((request) => request.path.includes('/stream')).map((request) => request.path), ['api/jobs/app/T-1/stream?from=0']);
  assert.equal(page.streams.at(-1)!.url, 'api/stream?job=app%2FT-1&from=0');
  assert.equal(page.location.hash, '#app/T-1');
  // The header: ← Board, the key and the title; the Stream and the composer below it.
  const head = page.$('jhead');
  assert.deepEqual([head.children[0]!.textContent, (head.children[0] as FakeElement).className], ['← Board', 'btn back']);
  assert.equal(head.children[1]!.textContent, 'T-1appTitle of T-1');
  page.streams.at(-1)!.emit('job', detail(job('T-1', 'working')));
  assert.match(page.$('composer-sentence').textContent, /^The Implementer is working on iteration 2\./);
  assert.equal(page.$('job').className, 'st-working');
  // ← Board: the board again, the stream follows no job, the focus on the card that opened it.
  (head.children[0] as FakeElement).click();
  assert.deepEqual([onJobPage(page), page.location.hash, page.streams.at(-1)!.url], [false, '#', 'api/stream?']);
  assert.equal(page.document.activeElement, card(page, 'app/T-1'));
  // Enter on the focused card opens it again; Escape goes back.
  page.key('Enter');
  await page.flush();
  assert.deepEqual([onJobPage(page), page.location.hash], [true, '#app/T-1']);
  page.key('Escape');
  assert.deepEqual([onJobPage(page), page.document.activeElement], [false, card(page, 'app/T-1')]);
  // The open job leaving the board goes back to the board.
  card(page, 'app/T-2').click();
  await page.flush();
  page.streams.at(-1)!.emit('jobs', { jobs: [job('T-1', 'working')] });
  assert.deepEqual([onJobPage(page), page.location.hash], [false, '#']);
});

test('board client: the hashes: #ws/T the job, /changes and /mr its tab, /ticket the planned ticket, an unknown one the board; Back and Forward move between them', async () => {
  const jobs = [job('T-1', 'working'), { ...job('T-9', 'pushed'), workspace: 'web' }];
  const tickets = [ticket('app/T-2'), ticket('app/T-1', { job: 'working' })];
  // The screen the header's switch selects, and the one shown.
  const selected = (page: Page): string => {
    const tab = page.$('jhead').querySelectorAll('[role="tab"]').find((element) => element.getAttribute('aria-selected') === 'true')!.dataset.goto!;
    assert.deepEqual(['stream', 'changes', 'mr'].filter((screen) => !page.$(`scr${screen === 'mr' ? 'Mr' : screen[0]!.toUpperCase() + screen.slice(1)}`).hidden), [tab]);
    return tab;
  };
  for (const [hash, check] of [
    ['#app/T-1', (page: Page) => assert.deepEqual([onJobPage(page), selected(page)], [true, 'stream'])],
    ['#app/T-1/changes', (page: Page) => assert.deepEqual([onJobPage(page), selected(page)], [true, 'changes'])],
    ['#app/T-1/mr', (page: Page) => assert.deepEqual([onJobPage(page), selected(page)], [true, 'mr'])],
    ['#web/T-9', (page: Page) => assert.equal(page.streams.at(-1)!.url, 'api/stream?job=web%2FT-9&from=0')],
    ['#app/T-2/ticket', (page: Page) => assert.deepEqual([onJobPage(page), page.$('ticket').hidden, page.$('board').hidden, page.requests.at(-1)!.path], [false, false, true, 'api/tickets/app/T-2/page'])],
    ['#app/NOPE', (page: Page) => assert.deepEqual([onJobPage(page), page.$('board').hidden, page.$('ticket').hidden], [false, false, true])],
    ['#app/NOPE/ticket', (page: Page) => assert.deepEqual([onJobPage(page), page.$('board').hidden, page.$('ticket').hidden], [false, false, true])],
    // A ticket with a live job has no planned page.
    ['#app/T-1/ticket', (page: Page) => assert.deepEqual([onJobPage(page), page.$('board').hidden, page.$('ticket').hidden], [false, false, true])],
  ] as const) {
    const page = await openBoard(jobs, tickets, [workspace('app'), workspace('web')], hash);
    check(page);
    assert.equal(page.$('drawer').hidden, true, hash);
  }

  const page = await openBoard(jobs, tickets, [workspace('app'), workspace('web')]);
  const visit = async (hash: string): Promise<void> => {
    page.location.hash = hash;
    page.window.dispatch('hashchange');
    await page.flush();
  };
  await visit('#app/T-1/mr');
  assert.deepEqual([onJobPage(page), selected(page)], [true, 'mr']);
  await visit('#app/T-1');
  assert.deepEqual([onJobPage(page), selected(page)], [true, 'stream']);
  await visit('#app/T-2/ticket');
  assert.deepEqual([onJobPage(page), page.$('ticket').hidden, page.streams.at(-1)!.url], [false, false, 'api/stream?']);
  await visit('');
  assert.deepEqual([onJobPage(page), page.$('ticket').hidden, page.$('board').hidden], [false, true, false]);
  // Opening a page is a new history entry.
  card(page, 'app/T-1').click();
  await page.flush();
  assert.equal(page.pushed.at(-1), '#app/T-1');
});

test('board client: Escape on a job screen goes to its Stream, from the Stream to the board; j and k move between the cards, Enter opens a Queue card', async () => {
  const page = await openBoard([job('T-1', 'working'), job('T-3', 'pushed')], [ticket('app/T-2')], [workspace('app')], '#app/T-1/changes');
  assert.equal(onJobPage(page), true);
  page.key('Escape');
  assert.deepEqual([onJobPage(page), page.location.hash], [true, '#app/T-1']);
  page.key('Escape');
  assert.deepEqual([onJobPage(page), page.location.hash], [false, '#']);
  assert.equal(page.document.activeElement, card(page, 'app/T-1'));
  // j and k, in board order: the Queue, Implementing, …, Done.
  page.key('j');
  assert.equal(page.document.activeElement, card(page, 'app/T-3'));
  page.key('k');
  page.key('k');
  assert.equal(page.document.activeElement, card(page, 'app/T-2'));
  page.key('k');
  assert.equal(page.document.activeElement, card(page, 'app/T-2'));
  page.key('Enter');
  await page.flush();
  assert.deepEqual([page.$('ticket').hidden, page.location.hash], [false, '#app/T-2/ticket']);
  // Escape on the planned ticket page: the board again, the focus on the card.
  page.key('Escape');
  assert.deepEqual([page.$('ticket').hidden, page.location.hash, page.document.activeElement], [true, '#', card(page, 'app/T-2')]);
  // A key in a text field is not the board's.
  page.$('msg').focus();
  page.key('j');
  assert.equal(page.document.activeElement, page.$('msg'));
});

test('board client: api/jobs is read again every 15 s only while a card runs and the page is visible', async () => {
  const page = await openBoard([job('T-1', 'working'), job('T-2', 'pushed')], []);
  const reads = jobReads(page).length;
  assert.equal(page.tick(15000), 1);
  await page.flush();
  assert.equal(jobReads(page).length, reads + 1);
  // One timer at a time, however often the board is drawn.
  page.streams.at(-1)!.emit('jobs', { jobs: [job('T-1', 'working')] });
  page.streams.at(-1)!.emit('jobs', { jobs: [job('T-1', 'working')] });
  assert.equal(page.timers.filter((timer) => timer.ms === 15000 && !timer.fired && !timer.cleared).length, 1);
  // Hidden: the timer reads nothing and waits for the page to be visible again.
  page.document.visibilityState = 'hidden';
  assert.equal(page.tick(15000), 1);
  await page.flush();
  assert.equal(jobReads(page).length, reads + 1);
  assert.equal(page.tick(15000), 0);
  page.document.visibilityState = 'visible';
  page.document.dispatch('visibilitychange');
  assert.equal(page.tick(15000), 1);
  await page.flush();
  assert.equal(jobReads(page).length, reads + 2);
  // A jobs event during a read is newer than its answer; once nothing runs: no timer, no read.
  page.tick(15000);
  page.streams.at(-1)!.emit('jobs', { jobs: [job('T-1', 'pushed')] });
  await page.flush();
  assert.equal(keys(page, 'done').length, 1);
  const before = jobReads(page).length;
  assert.equal(page.tick(15000), 0);
  assert.equal(jobReads(page).length, before);
});

test('board client: without SF-071 the queue controls and the Rules menu stay hidden, whatever the data carries, and no queue route is called', async () => {
  const page = await openBoard([job('T-1', 'working')], [ticket('app/T-2', { queued: true, position: 1 })]);
  page.streams.at(-1)!.emit('jobs', { jobs: [job('T-1', 'working')], queue: { order: ['app/T-2'], limit: 3, rule: 'wait', held: true } });
  assert.deepEqual(page.document.querySelectorAll('#rulesMenu input').map((input) => [input.type, input.name, input.value]),
    [['radio', 'rule', 'resume-then-queue'], ['radio', 'rule', 'resume-only'], ['radio', 'rule', 'wait']]);
  for (const selector of ['.qctl', '.menuwrap', '#rulesMenu']) {
    assert.equal(page.document.querySelector(selector)!.hidden, true, selector);
  }
  assert.equal(page.document.querySelector('.qctl')!.closest('.topbar')!.tagName, 'HEADER');
  assert.equal(page.document.querySelectorAll('#qlist .pos, #qlist .waits, #qlist .qdiv, #qlist [draggable]').length, 0);
  for (const id of ['limUp', 'limDown', 'rulesBtn']) {
    page.$(id).click();
  }
  card(page, 'app/T-2').focus();
  page.key('ArrowUp', { altKey: true });
  await page.flush();
  assert.deepEqual(page.requests.filter((request) => /queue|limit|rule/i.test(request.path)).map((request) => request.path), []);
  assert.deepEqual(keys(page, 'queue'), ['app/T-2']);
  const source = await readFile(new URL('app.js', STATIC_DIR), 'utf8');
  assert.doesNotMatch(source, /api\/queue|api\/rules|\/queue\b/);
});

test('board client: no element of the page has an inline style and no prototype-only part exists; values go in as text', async () => {
  const html = await readFile(new URL('dashboard.html', STATIC_DIR), 'utf8');
  const source = await readFile(new URL('app.js', STATIC_DIR), 'utf8');
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|setAttribute\('style'|\.style\.(?!setProperty)/);
  const jobs = [
    job('W', 'working'), job('N', 'needs_human', { error: { code: 'gate_rounds', message: 'x' } }), job('R', 'ready_for_human_review'),
    job('P', 'pushed', { mr: { number: 3, state: 'open', url: 'https://github.com/acme/app/pull/3' }, mr_host: { host: 'github', reason: null } }),
  ];
  const page = await openBoard(jobs, [ticket('app/T-1', { job: 'failed' }), ticket('app/P')], [workspace('app'), workspace('web')]);
  // A pushed card's merge request link goes to the host; it does not open the job's page.
  card(page, 'app/P').all().find((element) => element.tagName === 'A')!.click();
  assert.equal(page.$('job').hidden, true);
  card(page, 'app/T-1').click();
  card(page, 'app/W').click();
  await page.flush();
  page.streams.at(-1)!.emit('job', detail(jobs[0]!));
  const elements = page.document.documentElement.all();
  assert.deepEqual(elements.filter((element) => element.getAttribute('style') !== null).map((element) => element.id || element.className), []);
  for (const selector of ['.proto-badge', '.vbar', '#statePanel', '.simtag', '.block.sim', '#scenario', '#simBtns', '#stateBtn']) {
    assert.equal(page.document.querySelectorAll(selector).length, 0, selector);
  }
  assert.doesNotMatch(page.document.documentElement.textContent, /PROTOTYPE|\(prototype\)|Simulated|simulated/);
  assert.doesNotMatch(source, /PROTOTYPE|\(prototype\)|Simulated/);
});

test('board client: the ChatGPT reviewer is not shown anywhere', async () => {
  const page = await openBoard([job('T-1', 'awaiting_review', { reviewer: 'none' })], [ticket('app/T-2', { reviewer: { status: 'none' } })], [workspace('app')], '#app/T-1');
  page.streams.at(-1)!.emit('subscriptions', { subscriptions: [{ id: 'sub_1', input: {}, host: 'chatgpt.example', refreshBefore: '2026-11-08T09:00:00.000Z', job: null }] });
  page.streams.at(-1)!.emit('job', { ...detail(job('T-1', 'awaiting_review')), reviewer: { status: 'none' }, reviewerSetup: { guide: 'Call guide.', instruction: 'x' } });
  for (const id of ['reviewer', 'nudge-button', 'test-event-button', 'subscription-list', 'setup-guide']) {
    assert.equal(page.document.getElementById(id), null, id);
  }
  const text = [...COLUMNS.map((column) => page.$(LISTS[column]).textContent), page.$('job').textContent].join(' ');
  assert.doesNotMatch(text, /Reviewer|no reviewer|Nudge|test event|Subscriptions/);
});

test('board client: a job whose turn went on by itself after the turn limit says so in one line on its card (SF-069)', async () => {
  const line = 'The Implementer reached the turn limit while making progress; the factory went on by itself (1 of 1).';
  const page = await openBoard([job('J-1', 'working', { turn_limit: line }), job('J-2', 'working', { turn_limit: null })], []);
  const notes = (key: string) => card(page, key).all().filter((element) => element.classList.contains('note')).map((element) => element.textContent);
  assert.deepEqual(notes('app/J-1'), [line]);
  assert.deepEqual(notes('app/J-2'), []);
});

// SF-084: the dependencies of the tickets, as the server sends them in the tickets payload.
const dep = (key: string, state: string) => {
  const [workspace, name] = key.split('/') as [string, string];
  return { workspace, ticket: name, state };
};
const lineOf = (item: FakeElement, className: string): FakeElement | undefined => item.all().find((element) => element.classList.contains('deps') && element.classList.contains(className));
const chips = (line: FakeElement | undefined): Array<[string, string]> => (line === undefined ? [] : line.all().filter((element) => element.classList.contains('dchip')).map((element) => [element.textContent, element.className]));

test('board client (SF-084): Waits for with a chip per dependency and its state mark; nothing once all are merged; Start says what it waits for; Needed by on the cards waited for', async () => {
  const page = await openBoard([job('B-1', 'working'), job('M-1', 'pushed')], [
    ticket('app/Q-1', { lands_after: [dep('app/M-1', 'merged'), dep('app/B-1', 'running'), dep('app/P-1', 'pushed'), dep('app/N-1', 'planned'), dep('web/X-1', 'missing')] }),
    ticket('app/Q-2', { lands_after: [dep('app/M-1', 'merged')] }),
    ticket('app/N-1'),
    ticket('app/Q-3'),
  ], [workspace('app'), workspace('web')]);
  const waits = lineOf(card(page, 'app/Q-1'), 'waits')!;
  assert.equal(waits.children[0] instanceof Object && (waits.children[0] as FakeElement).textContent, 'Waits for');
  assert.deepEqual(chips(waits), [
    ['✓ M-1', 'dchip dep-merged'], ['⧗ B-1', 'dchip dep-running'], ['⧗ P-1', 'dchip dep-pushed'], ['⧗ N-1', 'dchip dep-planned'], ['✗ web/X-1', 'dchip dep-missing'],
  ]);
  // Never colour alone: the mark, and the state in words as the chip's title.
  assert.deepEqual(waits.all().filter((element) => element.classList.contains('dchip')).map((element) => element.getAttribute('title')),
    ['app/M-1: merged', 'app/B-1: running', 'app/P-1: pushed, not merged yet', 'app/N-1: planned, not started', 'web/X-1: no Task file and no job']);
  const start = button(card(page, 'app/Q-1'), 'Start')!;
  assert.deepEqual([start.className, start.getAttribute('title')], ['btn small', 'Waits for B-1, P-1, N-1, web/X-1']);
  // All merged: nothing extra, Start as on any card.
  assert.equal(lineOf(card(page, 'app/Q-2'), 'waits'), undefined);
  assert.equal(button(card(page, 'app/Q-2'), 'Start')!.getAttribute('title'), null);
  assert.equal(lineOf(card(page, 'app/Q-3'), 'waits'), undefined);
  // Needed by: on the Queue card, the running job's and the Done card of the tickets waited for.
  assert.deepEqual(chips(lineOf(card(page, 'app/N-1'), 'needed')), [['Q-1', 'dchip']]);
  assert.equal(lineOf(card(page, 'app/N-1'), 'needed')!.children[0] instanceof Object && (lineOf(card(page, 'app/N-1'), 'needed')!.children[0] as FakeElement).textContent, 'Needed by');
  assert.deepEqual(chips(lineOf(card(page, 'app/B-1'), 'needed')), [['Q-1', 'dchip']]);
  assert.deepEqual(chips(lineOf(card(page, 'app/M-1'), 'needed')), [['Q-1', 'dchip'], ['Q-2', 'dchip']]);
  assert.equal(lineOf(card(page, 'app/Q-3'), 'needed'), undefined);
  // A live job's Task file (job_lands_after) counts for Needed by too.
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('app/Q-3')], archived: [], job_lands_after: [{ workspace: 'app', ticket: 'B-1', lands_after: [dep('app/Q-3', 'planned')] }] });
  assert.deepEqual(chips(lineOf(card(page, 'app/Q-3'), 'needed')), [['B-1', 'dchip']]);
  assert.equal(lineOf(card(page, 'app/B-1'), 'waits'), undefined);
});

test('board client (SF-084): hovering or focusing a card outlines its dependencies and dependents and dims the rest; leaving or Escape clears it', async () => {
  const page = await openBoard([job('B-1', 'working'), job('D-1', 'pushed')], [
    ticket('app/Q-1', { lands_after: [dep('app/B-1', 'running')] }),
    ticket('app/Q-2', { lands_after: [dep('app/Q-1', 'planned')] }),
    ticket('app/Q-3'),
  ]);
  const marks = () => ['app/Q-1', 'app/Q-2', 'app/Q-3', 'app/B-1', 'app/D-1'].map((key) => {
    const item = card(page, key);
    return item.classList.contains('rel') ? 'rel' : item.classList.contains('dim') ? 'dim' : '';
  });
  assert.deepEqual(marks(), ['', '', '', '', '']);
  part(card(page, 'app/Q-1'), 'title')!.dispatch('mouseover');
  assert.deepEqual(marks(), ['', 'rel', 'dim', 'rel', 'dim']);
  // Kept across a new rendering of the board.
  page.streams.at(-1)!.emit('jobs', { jobs: [job('B-1', 'working'), job('D-1', 'pushed')] });
  assert.deepEqual(marks(), ['', 'rel', 'dim', 'rel', 'dim']);
  // Off the cards: cleared; a card without dependencies or dependents dims nothing.
  page.$('summary').dispatch('mouseover');
  assert.deepEqual(marks(), ['', '', '', '', '']);
  card(page, 'app/Q-3').dispatch('mouseover');
  assert.deepEqual(marks(), ['', '', '', '', '']);
  // The focus does it too; Escape clears it; the pointer leaving the columns clears it.
  card(page, 'app/B-1').focus();
  card(page, 'app/B-1').dispatch('focusin');
  assert.deepEqual(marks(), ['rel', 'dim', 'dim', '', 'dim']);
  page.key('Escape');
  assert.deepEqual(marks(), ['', '', '', '', '']);
  card(page, 'app/Q-2').dispatch('focusin');
  assert.deepEqual(marks(), ['rel', '', 'dim', 'dim', 'dim']);
  card(page, 'app/Q-2').dispatch('focusout', { relatedTarget: page.$('summary') });
  assert.deepEqual(marks(), ['', '', '', '', '']);
  card(page, 'app/Q-2').dispatch('mouseover');
  page.$('cols').dispatch('mouseleave');
  assert.deepEqual(marks(), ['', '', '', '', '']);
});

test('board client (SF-084): a chip scrolls to its card and focuses it, lifting a filter that hides it; a ticket without a card says so; the click opens nothing', async () => {
  const page = await openBoard([{ ...job('W-1', 'working'), workspace: 'web' }], [
    ticket('app/Q-1', { lands_after: [dep('web/W-1', 'running'), dep('app/GONE', 'missing')] }),
    ticket('app/Q-2'),
  ], [workspace('app'), workspace('web')]);
  const chip = (text: string) => lineOf(card(page, 'app/Q-1'), 'waits')!.all().find((element) => element.classList.contains('dchip') && element.textContent.endsWith(text))!;
  chip('web/W-1').click();
  await page.flush();
  const target = card(page, 'web/W-1');
  assert.deepEqual([page.document.activeElement, target.scrolledIntoView, page.location.hash, page.$('drawer').hidden], [target, 1, '', true]);
  // Its card outlined with the others dimmed.
  assert.deepEqual([card(page, 'app/Q-1').classList.contains('rel'), card(page, 'app/Q-2').classList.contains('dim')], [true, true]);
  // Filtered out: the filter goes back to every workspace.
  page.$('workspace-filter').children.map((child) => child as FakeElement).find((element) => element.textContent === 'app')!.click();
  assert.deepEqual(keys(page, 'implementing'), []);
  chip('web/W-1').click();
  assert.deepEqual([keys(page, 'implementing'), page.document.activeElement], [['web/W-1'], card(page, 'web/W-1')]);
  // No card: the toast says so.
  chip('GONE').click();
  assert.equal(page.$('toast-text').textContent, 'app/GONE has no card on the board: no Task file and no job.');
  // Needed by's chip goes the other way.
  lineOf(card(page, 'web/W-1'), 'needed')!.all().find((element) => element.classList.contains('dchip'))!.click();
  assert.equal(page.document.activeElement, card(page, 'app/Q-1'));
});

test('board client (SF-084): a dependency cycle of any length shows on each of its cards in the error colour, without hanging', async () => {
  const page = await openBoard([], [
    ticket('app/A', { lands_after: [dep('app/B', 'planned')] }),
    ticket('app/B', { lands_after: [dep('app/C', 'planned')] }),
    ticket('app/C', { lands_after: [dep('app/A', 'planned'), dep('web/W', 'planned')] }),
    ticket('app/S', { lands_after: [dep('app/S', 'planned')] }),
    ticket('app/D', { lands_after: [dep('app/A', 'planned')] }),
    ticket('web/W'),
  ], [workspace('app'), workspace('web')]);
  const cycle = (key: string) => lineOf(card(page, key), 'cycle')?.textContent;
  assert.deepEqual(['app/A', 'app/B', 'app/C', 'app/S', 'app/D', 'web/W'].map(cycle),
    ['Dependency cycle: A → B → C → A', 'Dependency cycle: B → C → A → B', 'Dependency cycle: C → A → B → C', 'Dependency cycle: S → S', undefined, undefined]);
});

test('board client (SF-084): each card has its workspace stripe and chip; the configured colour wins over the hash; a long name is shortened in the middle', async () => {
  const long = 'customer-portal-frontend-app';
  const page = await openBoard([job('T-1', 'working'), { ...job('L-1', 'needs_human'), workspace: long }], [ticket('web/W-1'), ticket(`${long}/L-2`)],
    [workspace('app'), workspace('web', 'orange'), workspace(long)]);
  assert.deepEqual(['app/T-1', 'web/W-1'].map((key) => card(page, key).className), ['card ws-teal', 'card ws-orange']);
  const chip = part(card(page, 'web/W-1'), 'wschip')!;
  assert.deepEqual([chip.className, chip.textContent, chip.getAttribute('title'), (chip.children[0] as FakeElement).className], ['wschip ws-orange', 'web', 'Workspace web', 'wsdot ws-orange']);
  // The hash of the name, as the server sends it, when none is configured: a+p+p = 321, 321 mod 8 = 1.
  assert.equal(part(card(page, 'app/T-1'), 'wschip')!.className, 'wschip ws-teal');
  for (const key of [`${long}/L-1`, `${long}/L-2`]) {
    const item = part(card(page, key), 'wschip')!;
    assert.deepEqual([item.textContent, item.getAttribute('title')], ['custome…tend-app', `Workspace ${long}`]);
  }
  // A workspace the registry no longer lists: no colour class, the name still there.
  page.streams.at(-1)!.emit('workspaces', { workspaces: [workspace('app')] });
  assert.deepEqual([card(page, 'web/W-1').className, part(card(page, 'web/W-1'), 'wschip')!.textContent], ['card', 'web']);
});

test('board client (SF-084): the job page header shows the workspace chip in its colour, Waits for and Needed by', async () => {
  const page = await openBoard([job('T-1', 'working')], [ticket('app/Q-1', { lands_after: [dep('app/T-1', 'running')] }), ticket('app/M-1')], [workspace('app', 'red')], '#app/T-1');
  page.streams.at(-1)!.emit('tickets', {
    tickets: [ticket('app/Q-1', { lands_after: [dep('app/T-1', 'running')] }), ticket('app/M-1')], archived: [],
    job_lands_after: [{ workspace: 'app', ticket: 'T-1', lands_after: [dep('app/M-1', 'planned')] }],
  });
  await page.flush();
  assert.ok(onJobPage(page));
  const head = page.$('jhead');
  assert.equal(part(head, 'wschip')!.className, 'wschip ws-red');
  assert.deepEqual([chips(lineOf(head, 'waits')), chips(lineOf(head, 'needed'))], [[['⧗ M-1', 'dchip dep-planned']], [['Q-1', 'dchip']]]);
  // A chip goes back to the board, to that card.
  lineOf(head, 'needed')!.all().find((element) => element.classList.contains('dchip'))!.click();
  await page.flush();
  assert.deepEqual([onJobPage(page), page.document.activeElement], [false, card(page, 'app/Q-1')]);
});
