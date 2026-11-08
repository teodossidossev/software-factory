// Behaviour of the v3 board in static/board.js (SF-046, SF-077), run under node:vm against the fake page
// of test/support/fake-dom.ts: the five columns from the job states and the tickets, Done's last
// eight, each card kind (the Now line and the tool calls, the reason and the one button of STOPS for
// every stop code, ready, paused, done), the iteration shown, the cost and the elapsed time, the
// Queue card's Start with its confirmation, refusal and unknown outcome, the Queue card opening the
// planned ticket's page (SF-081; the page itself is in dashboard-ticket-client.test.ts), the workspace filter, the job's full page and the routing by the URL hash, the keys, the
// 15 s read of api/jobs, the toast, the run queue (SF-071: the stepper, the status line, the queued cards, the
// toggle, the failed start, drag and drop and Alt+Up/Down; hidden without a queue), and no inline style or
// prototype-only part; SF-084: the dependency chips and their states, Needed by, the highlight, the
// chip's focus, the cycle line, the workspace stripe and chip, the filter chips and the ⋯ menu. Script checks, not browser acceptance: the manual steps are in factory/README.md.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { type WorkspaceColor, workspaceColor } from '../src/registry.js';
import { served, servedDetail } from './support/dashboard-client.js';
import { type FakeElement, type FetchRequest, loadPage, type Page, readScripts } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
process.env.TZ = 'Europe/Sofia';
const COLUMNS = ['queue', 'implementing', 'reviewing', 'you', 'done'] as const;
const LISTS: Record<(typeof COLUMNS)[number], string> = { queue: 'qlist', implementing: 'list-implementing', reviewing: 'list-reviewing', you: 'list-you', done: 'list-done' };
const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60000).toISOString();

// The job as the server sends it: with its stop's row, its actions and their availability (SF-129).
function job(ticket: string, state: string, extra: Record<string, unknown> = {}) {
  return served({
    workspace: 'app', ticket, branch: `${ticket}-demo`, base: 'main', state, iteration: 1, mr_attempts: 0,
    updated_at: minutesAgo(4), created_at: '2026-11-01T10:00:00.000Z', error: null,
    prepared_commit: state === 'ready_for_human_review' ? 'a'.repeat(40) : null, worktree: state === 'ready_for_human_review' ? null : `/wt/${ticket}`,
    fixes: 0, gate_fixes: 0, gate_tokens: 0, files: 0, undeclared: 0, deleted: 0, title: `Title of ${ticket}`, cost_usd: null, review: null, review_ended_at: null, gate: null,
    now: null, tool_calls: 0, stop: null, ...extra,
  });
}

function detail(row: ReturnType<typeof job>) {
  return servedDetail({ job: row, iterations: [], mr: false, gate: true, history: [] });
}

function ticket(key: string, extra: Record<string, unknown> = {}) {
  const [workspace, name] = key.split('/') as [string, string];
  return { workspace, ticket: name, title: `Ticket ${name}`, base: 'main', draft: false, request: null, job: null, conversation: { message: 'm', url: null }, ...extra };
}

// The colour as the server sends it (SF-084): the configured one, else the hash of the name.
const workspace = (name: string, color?: WorkspaceColor) => ({ name, path: `/srv/${name}`, liveJobs: 0, problem: null, handoff: null, color: workspaceColor(name, color) });

type Job = ReturnType<typeof job>;

// answer.jobs off leaves later api/jobs reads to the test.
// globals: names added to the page's context (a localStorage, a matchMedia: SF-119).
async function openBoard(jobs: Job[], tickets: ReturnType<typeof ticket>[], workspaces = [workspace('app')], hash = '', answer = { jobs: true }, globals: Record<string, unknown> = {}): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return answer.jobs ? { jobs } : undefined;
    }
    const match = /^api\/jobs\/([^/]+)\/([^/]+)$/.exec(path);
    const found = match ? jobs.find((row) => row.ticket === match[2]) : undefined;
    return found ? detail(found) : undefined;
  }, undefined, globals);
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
  const check = (extra: Record<string, unknown> = {}) => ({ state: 'none', check_reason: null, stale: false, running: false, blockers: 0, majors: 0, nits: 0, ended_at: null, start_note: 'not checked', ...extra });
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
  // SF-130: a Task that needs no check: both chips say so, titled with the reason; Check stays.
  const small = await openBoard([], [ticket('app/T-4', { check: check({ state: 'not_needed', check_reason: 'small: 2 scope entries, 500 words', start_note: null }) })]);
  assert.deepEqual(buttons(card(small, 'app/T-4')).slice(0, 2).map((element) => [element.textContent, element.getAttribute('title')]), [
    ['check not needed', 'small: 2 scope entries, 500 words'], ['check not needed', 'small: 2 scope entries, 500 words'],
  ]);
  assert.equal(labels(card(small, 'app/T-4')).includes('Check'), true);
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
  posts(page)[0]!.respond(409, { ok: false, error: { code: 'branch_exists', message: 'The branch T-2-two already exists in the checkout.' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'branch_exists: The branch T-2-two already exists in the checkout.');
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

test('board client (SF-131): a card awaiting review without its Now line names the reviewer: the Codex gate for a job without the Claude review, else Claude until its review is clean', async () => {
  const gateOnly = job('G', 'awaiting_review', { now: null, iteration: 1, claude_review: false, review: null });
  const claude = job('K', 'awaiting_review', { now: null, iteration: 1, claude_review: true, review: null });
  const before = job('B', 'awaiting_review', { now: null, iteration: 1, review: 'clean' });
  const page = await openBoard([gateOnly, claude, before], []);
  const now = (key: string): string => part(card(page, key), 'now')!.textContent;
  assert.equal(now('app/G'), 'Now: Codex gatereviewing iteration 1');
  assert.equal(now('app/K'), 'Now: Claude reviewreviewing iteration 1');
  assert.equal(now('app/B'), 'Now: Codex gatereviewing iteration 1');
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
  ['mr_serve_restarted', 'error', 'MR preparation interrupted', 'Retry'],
  ['mr_interrupted', 'error', 'MR preparation interrupted', 'Retry'],
  ['mr_serve_restarted', 'error', 'MR preparation interrupted', 'Tell it to go on', { mr_conflict_turn: true }],
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
  ['mr_commit_failed', 'error', 'MR preparation failed', 'Retry'],
  ['mr_rebase_failed', 'error', 'MR preparation failed', 'Retry'],
  ['mr_failed', 'error', 'MR preparation failed', 'Retry'],
  ['mr_failed', 'error', 'MR preparation failed', 'Tell it to go on', { mr_conflict_turn: true }],
  ['fetch_failed', 'error', 'Fetch failed', 'Retry'],
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
    [{ error: { code: 'iteration_limit', message: 'x' }, fixes: 5 }, 'The reviewers asked for fixes 5 times, the limit. Accept the change with its open findings listed in the MR text, give the Implementer a direction, or abort'],
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

test('board client: the ready card offers Review the MR and push (the job\'s Merge request screen, no confirmation; SF-080) and Create merge request…; a handed-over card the Approve confirmation; the paused card Resume; Retry review posts once', async () => {
  const failed = job('T-3', 'needs_human', { error: { code: 'review_failed', message: 'overloaded' } });
  const paused = job('T-4', 'paused', { paused: { from: 'working', step: 'turn', at: minutesAgo(1) }, task_changed: true });
  const handed = job('T-5', 'handed_over', { prepared_commit: 'a'.repeat(40) });
  const page = await openBoard([job('T-1', 'ready_for_human_review'), failed, paused, handed], []);
  const ready = card(page, 'app/T-1');
  assert.deepEqual([part(ready, 'reason')!.className, part(ready, 'reason')!.textContent], ['reason ready', 'Ready to push: reviews clean, MR text written']);
  assert.deepEqual(buttons(ready).map((element) => [element.textContent, element.className]), [['Review the MR and push', 'btn primary small'], ['Create merge request…', 'btn small']]);
  assert.deepEqual([part(card(page, 'app/T-4'), 'reason')!.textContent, part(card(page, 'app/T-4'), 'meta')!.textContent], ['Paused by you', 'Iteration 2']);
  assert.match(card(page, 'app/T-4').textContent, /Task file changed since the job started/);
  assert.deepEqual(labels(card(page, 'app/T-4')), ['Resume']);

  assert.deepEqual([button(ready, 'Review the MR and push')!.dataset.screen, button(ready, 'Review the MR and push')!.dataset.confirm], ['mr', undefined]);
  button(ready, 'Review the MR and push')!.click();
  await page.flush();
  assert.deepEqual([onJobPage(page), page.location.hash, page.$('scrMr').hidden], [true, '#app/T-1/mr', false]);
  // The detail arrives: no confirmation opens; nothing is posted.
  page.streams.at(-1)!.emit('job', { ...detail(job('T-1', 'ready_for_human_review')), mr: true });
  await page.flush();
  assert.equal(page.$('confirm').hidden, true);
  assert.equal(posts(page).length, 0);
  (page.$('jhead').children[0] as FakeElement).click();
  assert.equal(onJobPage(page), false);

  // In handed_over the card stays as it was: the job's page with the Approve confirmation.
  const handedButton = button(card(page, 'app/T-5'), 'Review the MR and push')!;
  assert.deepEqual([handedButton.dataset.screen, handedButton.dataset.confirm], [undefined, 'approve']);
  handedButton.click();
  await page.flush();
  page.streams.at(-1)!.emit('job', detail(handed));
  assert.deepEqual([page.location.hash, page.$('confirm').hidden, page.$('confirm-title').textContent], ['#app/T-5', false, 'Approve app/T-5?']);
  page.$('confirm-cancel').click();
  (page.$('jhead').children[0] as FakeElement).click();
  assert.equal(posts(page).length, 0);

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

test('board client: without a run queue (the tickets payload has none) the queue controls and the Rules menu stay hidden and no queue route is called; with the queue both show (SF-072)', async () => {
  const page = await openBoard([job('T-1', 'working')], [ticket('app/T-2', { queue_position: 1, queue_error: null })]);
  assert.deepEqual(page.document.querySelectorAll('#rulesMenu input').map((input) => [input.type, input.name, input.value]),
    [['radio', 'rule', 'resume-then-queue'], ['radio', 'rule', 'resume-only'], ['radio', 'rule', 'wait']]);
  for (const selector of ['.qctl', '.menuwrap', '#rulesMenu']) {
    assert.equal(page.document.querySelector(selector)!.hidden, true, selector);
  }
  assert.equal(page.document.querySelector('.qctl')!.closest('.topbar')!.tagName, 'HEADER');
  assert.equal(page.document.querySelectorAll('#qlist .pos, #qlist .waits, #qlist .qdiv, #qlist [draggable]').length, 0);
  assert.equal(labels(card(page, 'app/T-2')).some((label) => /queue/.test(label)), false);
  for (const id of ['limUp', 'limDown', 'rulesBtn']) {
    page.$(id).click();
  }
  card(page, 'app/T-2').focus();
  page.key('ArrowUp', { altKey: true });
  await page.flush();
  assert.deepEqual(page.requests.filter((request) => /queue|limit|rule/i.test(request.path)).map((request) => request.path), []);
  assert.deepEqual(keys(page, 'queue'), ['app/T-2']);
  // With the queue: its controls and the Rules button show; the menu itself opens on a click.
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('app/T-2', { queue_position: 1, queue_error: null })], archived: [], queue: QUEUE });
  assert.deepEqual([page.$('qctl').hidden, page.document.querySelector('.menuwrap')!.hidden, page.$('rulesMenu').hidden], [false, false, true]);
});

const QUEUE = { max_running: 2, running: 1, held: false, hold_reason: null, next: { workspace: 'app', ticket: 'T-3' }, on_limit: 'resume-then-queue', limit_hold: null };
// The Queue column's items: a card's key and position, or an item's class and text.
const queueItems = (page: Page): string[][] => page.$('qlist').children.map((child) => {
  const item = child as FakeElement;
  return item.classList.contains('card') ? [item.dataset.ticket!, part(item, 'pos')?.textContent ?? '-', item.getAttribute('draggable') ?? '-', item.dataset.q ?? '-'] : [item.className, item.textContent];
});

async function openQueue(tickets: ReturnType<typeof ticket>[], queue: Record<string, unknown> = QUEUE): Promise<Page> {
  const page = await openBoard([job('J-1', 'working')], tickets);
  page.streams.at(-1)!.emit('tickets', { tickets, archived: [], queue });
  await page.flush();
  return page;
}

const queuedTickets = () => [
  ticket('app/T-2', { queue_position: 2, queue_error: null }),
  ticket('app/T-3', { queue_position: 1, queue_error: null }),
  ticket('app/T-6', { queue_position: 3, queue_error: null }),
  ticket('app/T-4', { queue_position: null, queue_error: { code: 'branch_exists', message: 'The branch T-4-x already exists.' } }),
  ticket('app/T-5', { draft: true, queue_position: null, queue_error: null }),
];

test('board client (SF-071): the run queue in the top bar: Run up to N jobs at once with the stepper posting api/queue/limit, and the status line', async () => {
  const page = await openQueue(queuedTickets());
  assert.equal(page.$('qctl').hidden, false);
  assert.match(page.$('qctl').textContent, /^Run up to−2\+jobs at once1 running · 1 slot free · next: T-3/);
  assert.deepEqual([page.$('limVal').textContent, page.$('qstatus').className, page.$('qstatus').textContent], ['2', 'qstatus', '1 running · 1 slot free · next: T-3']);
  // One job more: posted once, both buttons off until the answer; the board shows the server's value.
  page.$('limUp').click();
  page.$('limUp').click();
  await page.flush();
  assert.deepEqual(posts(page).map((request) => [request.path, request.body]), [['api/queue/limit', '{"max_running":3}']]);
  assert.deepEqual([page.$('limUp').disabled, page.$('limDown').disabled], [true, true]);
  posts(page)[0]!.respond(200, { ok: true, result: { max_running: 3 } });
  await page.flush();
  assert.deepEqual([page.$('limUp').disabled, page.$('limDown').disabled, page.$('limVal').textContent], [false, false, '2']);
  assert.equal(page.$('toast-text').textContent, 'Run up to 3 jobs at once.');
  page.$('limDown').click();
  await page.flush();
  assert.equal(posts(page)[1]!.body, '{"max_running":1}');
  posts(page)[1]!.respond(400, { ok: false, error: { code: 'invalid_limit', message: 'The limit must be a whole number from 1 to 20.' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'invalid_limit: The limit must be a whole number from 1 to 20.');
  // The range's ends: the stepper stops there.
  const stream = page.streams.at(-1)!;
  stream.emit('tickets', { tickets: queuedTickets(), archived: [], queue: { ...QUEUE, max_running: 1 } });
  assert.deepEqual([page.$('limDown').disabled, page.$('limUp').disabled], [true, false]);
  stream.emit('tickets', { tickets: queuedTickets(), archived: [], queue: { ...QUEUE, max_running: 20 } });
  assert.deepEqual([page.$('limDown').disabled, page.$('limUp').disabled], [false, true]);
  page.$('limUp').click();
  assert.equal(posts(page).length, 2);
  // Nothing ready, every slot taken, held with and without a reason.
  stream.emit('tickets', { tickets: queuedTickets(), archived: [], queue: { ...QUEUE, running: 2, next: null } });
  assert.equal(page.$('qstatus').textContent, '2 running · 0 slots free · next: nothing ready');
  stream.emit('tickets', { tickets: queuedTickets(), archived: [], queue: { ...QUEUE, max_running: 4, running: 1 } });
  assert.equal(page.$('qstatus').textContent, '1 running · 3 slots free · next: T-3');
  stream.emit('tickets', { tickets: queuedTickets(), archived: [], queue: { ...QUEUE, held: true, hold_reason: 'usage limit' } });
  assert.deepEqual([page.$('qstatus').className, page.$('qstatus').textContent], ['qstatus held', 'Queue held: usage limit · 1 running']);
  stream.emit('tickets', { tickets: queuedTickets(), archived: [], queue: { ...QUEUE, held: true, hold_reason: null } });
  assert.equal(page.$('qstatus').textContent, 'Queue held · 1 running');
});

test('board client (SF-071): the Queue column holds the queued cards in order with their position, "Not queued", then the other planned tickets; the toggle, the failed start', async () => {
  const page = await openQueue(queuedTickets());
  assert.deepEqual(queueItems(page), [
    ['app/T-3', '1', 'true', '0'], ['app/T-2', '2', 'true', '1'], ['app/T-6', '3', 'true', '2'], ['qdiv', 'Not queued'], ['app/T-4', '-', '-', '-'], ['app/T-5', '-', '-', '-'],
  ]);
  assert.equal(page.$('count-queue').textContent, '3');
  // The actions SF-084 left, the toggle after Start (none on a skeleton), and a queued card's hint.
  const actions = (key: string): string[] => labels(card(page, key)).filter((label) => ['Start', 'Add to queue', 'Remove from queue', 'Task', '⋯', 'Check', 'Archive', 'Delete…'].includes(label));
  assert.deepEqual(actions('app/T-3'), ['Start', 'Remove from queue', 'Task', '⋯', 'Archive', 'Delete…']);
  assert.deepEqual(actions('app/T-4'), ['Start', 'Add to queue', 'Task', '⋯', 'Archive', 'Delete…']);
  assert.deepEqual(actions('app/T-5'), ['Task', '⋯', 'Archive', 'Delete…']);
  assert.equal(labels(card(page, 'app/T-5')).some((label) => /queue/.test(label)), false);
  assert.equal(part(card(page, 'app/T-3'), 'qhint')!.textContent, '⠿ drag · Alt+↑↓');
  assert.equal(part(card(page, 'app/T-4'), 'qhint'), undefined);
  assert.equal(part(card(page, 'app/T-4'), 'waits')!.textContent, 'Start failed: The branch T-4-x already exists.');
  assert.equal(part(card(page, 'app/T-3'), 'waits'), undefined);
  // Add to queue: posted once; the card stays as the server last said until the tickets come again.
  button(card(page, 'app/T-4'), 'Add to queue')!.click();
  await page.flush();
  assert.deepEqual(posts(page).map((request) => [request.path, request.body]), [['api/queue/add', '{"workspace":"app","ticket":"T-4"}']]);
  assert.equal(button(card(page, 'app/T-4'), 'Add to queue')!.disabled, true);
  assert.equal(page.$('ticket').hidden, true);
  posts(page)[0]!.respond(200, { ok: true, result: { position: 4 } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'app/T-4 is queued at position 4.');
  assert.deepEqual(queueItems(page)[4], ['app/T-4', '-', '-', '-']);
  button(card(page, 'app/T-2'), 'Remove from queue')!.click();
  await page.flush();
  assert.deepEqual([posts(page)[1]!.path, posts(page)[1]!.body], ['api/queue/remove', '{"workspace":"app","ticket":"T-2"}']);
  posts(page)[1]!.respond(409, { ok: false, error: { code: 'not_queued', message: 'app/T-2 is not in the queue.' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'not_queued: app/T-2 is not in the queue.');
  // An empty queue says so above "Not queued".
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('app/T-4', { queue_position: null, queue_error: null })], archived: [], queue: QUEUE });
  assert.deepEqual(queueItems(page), [['empty', 'The queue is empty: add a ticket below.'], ['qdiv', 'Not queued'], ['app/T-4', '-', '-', '-']]);
  assert.equal(page.$('count-queue').textContent, '0');
});

test('board client (SF-086): a queued card held by its plan says why, with Start anyway posting api/queue/force once; none when ready, forced or not queued', async () => {
  const page = await openQueue([
    ticket('app/T-3', { queue_position: 1, queue_error: null, queue_reason: 'plan not ready: 2 blocker, 1 major', queue_force: false }),
    ticket('app/T-2', { queue_position: 2, queue_error: null, queue_reason: 'plan being checked', queue_force: false }),
    ticket('app/T-6', { queue_position: 3, queue_error: null, queue_reason: null, queue_force: false }),
    ticket('app/T-7', { queue_position: 4, queue_error: null, queue_reason: null, queue_force: true }),
    ticket('app/T-4', { queue_position: null, queue_error: null, queue_reason: null, queue_force: false }),
  ]);
  const reason = (key: string): string | undefined => part(card(page, key), 'qreason')?.textContent;
  assert.deepEqual(['app/T-3', 'app/T-2', 'app/T-6', 'app/T-7', 'app/T-4'].map(reason), ['plan not ready: 2 blocker, 1 major', 'plan being checked', undefined, undefined, undefined]);
  assert.deepEqual(['app/T-3', 'app/T-2', 'app/T-6', 'app/T-7', 'app/T-4'].map((key) => button(card(page, key), 'Start anyway') !== undefined), [true, true, false, false, false]);
  button(card(page, 'app/T-3'), 'Start anyway')!.click();
  button(card(page, 'app/T-3'), 'Start anyway')!.click();
  await page.flush();
  assert.deepEqual(posts(page).map((request) => [request.path, request.body]), [['api/queue/force', '{"workspace":"app","ticket":"T-3"}']]);
  assert.equal(button(card(page, 'app/T-3'), 'Start anyway')!.disabled, true);
  posts(page)[0]!.respond(200, { ok: true, result: { force: true } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'app/T-3 starts when a slot is free, whatever its plan check says.');
  button(card(page, 'app/T-2'), 'Start anyway')!.click();
  await page.flush();
  posts(page)[1]!.respond(409, { ok: false, error: { code: 'not_queued', message: 'app/T-2 is not in the queue.' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'not_queued: app/T-2 is not in the queue.');
  // The server's next tickets: forced, the line and the button go.
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('app/T-3', { queue_position: 1, queue_error: null, queue_reason: 'plan not ready: 2 blocker, 1 major', queue_force: true })], archived: [], queue: QUEUE });
  await page.flush();
  assert.deepEqual([reason('app/T-3'), button(card(page, 'app/T-3'), 'Start anyway')], [undefined, undefined]);
});

test('board client (SF-071): drag and drop and Alt+Up / Alt+Down post api/queue/move; a drop goes before the card it lands on', async () => {
  const page = await openQueue(queuedTickets());
  const drag = (key: string, name: string, extra: Record<string, unknown> = {}) => card(page, key).dispatch(name, extra);
  const data: Record<string, string> = {};
  const transfer = { effectAllowed: '', setData: (type: string, value: string) => (data[type] = value) };
  // T-2 (2) dropped on T-3 (1): position 1.
  drag('app/T-2', 'dragstart', { dataTransfer: transfer });
  assert.deepEqual([card(page, 'app/T-2').classList.contains('dragging'), transfer.effectAllowed, data['text/plain']], [true, 'move', 'app/T-2']);
  const over = drag('app/T-3', 'dragover');
  assert.deepEqual([over.defaultPrevented, card(page, 'app/T-3').classList.contains('dropbefore')], [true, true]);
  drag('app/T-6', 'dragover');
  assert.deepEqual([card(page, 'app/T-3').classList.contains('dropbefore'), card(page, 'app/T-6').classList.contains('dropbefore')], [false, true]);
  // Over a card out of the queue: no place to drop before.
  drag('app/T-4', 'dragover');
  assert.equal(page.document.querySelectorAll('.dropbefore').length, 0);
  drag('app/T-3', 'dragover');
  drag('app/T-3', 'drop');
  await page.flush();
  assert.deepEqual(posts(page).map((request) => [request.path, request.body]), [['api/queue/move', '{"workspace":"app","ticket":"T-2","to":1}']]);
  assert.equal(page.document.querySelectorAll('.dragging, .dropbefore').length, 0);
  posts(page)[0]!.respond(200, { ok: true, result: { position: 1 } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'app/T-2 moved to position 1.');
  // T-3 (1) dropped on T-6 (3): before T-6, position 2.
  drag('app/T-3', 'dragstart');
  drag('app/T-6', 'drop');
  await page.flush();
  assert.equal(posts(page)[1]!.body, '{"workspace":"app","ticket":"T-3","to":2}');
  posts(page)[1]!.respond(200, { ok: true, result: { position: 2 } });
  await page.flush();
  // Dropped on itself or outside the queue, or a drag that ends: nothing is posted.
  drag('app/T-3', 'dragstart');
  drag('app/T-3', 'drop');
  drag('app/T-6', 'dragstart');
  drag('app/T-6', 'dragend');
  drag('app/T-4', 'drop');
  drag('app/T-4', 'dragstart');
  drag('app/T-3', 'drop');
  await page.flush();
  assert.equal(posts(page).length, 2);
  assert.equal(page.document.querySelectorAll('.dragging, .dropbefore').length, 0);
  // Alt+Up / Alt+Down on a focused queued card: one place; not past either end, not on a card out of the queue.
  card(page, 'app/T-2').focus();
  assert.equal(page.key('ArrowUp', { altKey: true }).defaultPrevented, true);
  await page.flush();
  assert.equal(posts(page)[2]!.body, '{"workspace":"app","ticket":"T-2","to":1}');
  posts(page)[2]!.respond(200, { ok: true, result: { position: 1 } });
  await page.flush();
  card(page, 'app/T-3').focus();
  page.key('ArrowUp', { altKey: true });
  card(page, 'app/T-6').focus();
  page.key('ArrowDown', { altKey: true });
  card(page, 'app/T-4').focus();
  page.key('ArrowUp', { altKey: true });
  await page.flush();
  assert.equal(posts(page).length, 3);
  card(page, 'app/T-3').focus();
  page.key('ArrowDown', { altKey: true });
  await page.flush();
  assert.equal(posts(page)[3]!.body, '{"workspace":"app","ticket":"T-3","to":2}');
});

test('board client: no element of the page has an inline style and no prototype-only part exists; values go in as text', async () => {
  const html = await readFile(new URL('dashboard.html', STATIC_DIR), 'utf8');
  assert.doesNotMatch(html, /\sstyle=/);
  const scripts = await readScripts();
  for (const { file, source } of scripts) {
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|setAttribute\('style'|\.style\.(?!setProperty)/, file);
  }
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
  for (const { file, source } of scripts) {
    assert.doesNotMatch(source, /PROTOTYPE|\(prototype\)|Simulated/, file);
  }
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

// SF-072: a job parked on a usage limit, as the jobs payload has it.
const PARK_AT = '2026-11-04T22:00:00.000Z';
const parkedJob = (ticket: string, extra: Record<string, unknown> = {}) => job(ticket, 'waiting_limit', {
  iteration: 0, paused: { from: 'working', step: 'turn', at: PARK_AT }, limit: { provider: 'claude', resets_at: '2026-11-05T01:00:00.000Z' }, ...extra,
});

test('board client (SF-072): a parked job is in Implementing, holds its slot and says when the limit resets; after a reset under wait its card asks to resume and Resume posts at once', async () => {
  const page = await openBoard([parkedJob('T-1'), parkedJob('T-2', { limit: { provider: 'codex', resets_at: '2026-11-05T01:00:00.000Z', reset_seen: true, notified_at: PARK_AT } }), job('T-3', 'working')], []);
  assert.deepEqual(keys(page, 'implementing').sort(), ['app/T-1', 'app/T-2', 'app/T-3']);
  const parked = card(page, 'app/T-1');
  // 03:00 in Sofia; the turn was under way: iteration 1.
  assert.deepEqual([part(parked, 'parked')?.textContent, part(parked, 'meta')?.textContent, part(parked, 'now')], ['Waiting for limits · resets at 03:00', 'Iteration 1 · parked, holds its slot', undefined]);
  assert.deepEqual(labels(parked), []);
  assert.match(page.$('summary').textContent, /· 3 running$/);
  const reset = card(page, 'app/T-2');
  assert.deepEqual([part(reset, 'parked')?.textContent, labels(reset)], ['Limit reset: resume?', ['Resume']]);
  button(reset, 'Resume')!.click();
  button(reset, 'Resume')!.click();
  await page.flush();
  assert.deepEqual(posts(page).map((request) => [request.path, request.body]), [['api/jobs/app/T-2/resume', '{}']]);
  // The job page's sentence (the composer is in dashboard-job-client.test.ts).
  const jobPage = await openBoard([parkedJob('T-1')], [], [workspace('app')], '#app/T-1');
  assert.equal(jobPage.$('jhead').all().find((element) => element.className === 'sentence')!.textContent,
    'Waiting for limits: the Claude usage limit resets at 03:00 (iteration 1). The factory resumes it then; Resume now goes on before the reset (with your message, if you write one below)');
});

test('board client (SF-072): #qstatus while a job is parked: held by the usage limit with its reset, whatever the hold by hand; once every reset passed under wait, the jobs to resume', async () => {
  const page = await openQueue(queuedTickets(), { ...QUEUE, running: 2, limit_hold: { parked: 1, resets_at: '2026-11-05T01:00:00.000Z' } });
  assert.deepEqual([page.$('qstatus').className, page.$('qstatus').textContent], ['qstatus held', 'Queue held: usage limit, resets at 03:00 · 2 running']);
  const stream = page.streams.at(-1)!;
  stream.emit('tickets', { tickets: queuedTickets(), archived: [], queue: { ...QUEUE, held: true, hold_reason: 'usage limit reset; release the queue to go on', limit_hold: { parked: 1, resets_at: null } } });
  assert.deepEqual([page.$('qstatus').className, page.$('qstatus').textContent], ['qstatus held', 'Queue held: usage limit reset, resume the parked jobs · 1 running']);
  stream.emit('tickets', { tickets: queuedTickets(), archived: [], queue: { ...QUEUE, held: true, hold_reason: 'usage limit reset; release the queue to go on' } });
  assert.equal(page.$('qstatus').textContent, 'Queue held: usage limit reset; release the queue to go on · 1 running');
});

test('board client (SF-072): the Rules menu opens from the top bar with the queue\'s rule checked; a choice posts api/queue/rule once; Escape and a click outside close it', async () => {
  const page = await openQueue(queuedTickets(), { ...QUEUE, on_limit: 'resume-only' });
  const rules = (): Array<[string, boolean]> => ['resume-then-queue', 'resume-only', 'wait'].map((rule) => [rule, page.$(`rule-${rule}`).checked]);
  assert.deepEqual([page.document.querySelector('.menuwrap')!.hidden, page.$('rulesMenu').hidden, page.$('rulesBtn').getAttribute('aria-expanded')], [false, true, 'false']);
  page.$('rulesBtn').click();
  assert.deepEqual([page.$('rulesMenu').hidden, page.$('rulesBtn').getAttribute('aria-expanded')], [false, 'true']);
  assert.deepEqual(rules(), [['resume-then-queue', false], ['resume-only', true], ['wait', false]]);
  page.$('rule-wait').checked = true;
  page.$('rule-wait').dispatch('change');
  await page.flush();
  assert.deepEqual(posts(page).map((request) => [request.path, request.body]), [['api/queue/rule', '{"rule":"wait"}']]);
  assert.equal(page.$('rule-wait').disabled, true);
  posts(page)[0]!.respond(200, { ok: true, result: { on_limit: 'wait' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'At a usage limit reset nothing resumes: you resume the parked jobs.');
  // The board shows the server's rule: until the tickets come again, the old one.
  assert.deepEqual(rules(), [['resume-then-queue', false], ['resume-only', true], ['wait', false]]);
  page.streams.at(-1)!.emit('tickets', { tickets: queuedTickets(), archived: [], queue: { ...QUEUE, on_limit: 'wait' } });
  assert.deepEqual(rules(), [['resume-then-queue', false], ['resume-only', false], ['wait', true]]);
  // The same rule again posts nothing.
  page.$('rule-wait').dispatch('change');
  await page.flush();
  assert.equal(posts(page).length, 1);
  page.key('Escape');
  assert.deepEqual([page.$('rulesMenu').hidden, page.$('rulesBtn').getAttribute('aria-expanded')], [true, 'false']);
  page.$('rulesBtn').click();
  assert.equal(page.$('rulesMenu').hidden, false);
  page.$('summary').click();
  assert.equal(page.$('rulesMenu').hidden, true);
});

test('board client (SF-087): a Your turn card of fetch_failed, mr_serve_restarted or mr_failed posts Retry at once, once; after a conflict turn it opens the job instead; mr_push_failed keeps Push again', async () => {
  const fetchFailed = job('T-1', 'needs_human', { error: { code: 'fetch_failed', message: 'git fetch origin main failed.' } });
  const interrupted = job('T-2', 'needs_human', { error: { code: 'mr_interrupted', message: 'paused' } });
  const conflicted = job('T-3', 'needs_human', { error: { code: 'mr_failed', message: 'boom' }, mr_conflict_turn: true });
  const push = job('T-4', 'needs_human', { error: { code: 'mr_push_failed', message: 'offline' }, prepared_commit: 'a'.repeat(40) });
  const page = await openBoard([fetchFailed, interrupted, conflicted, push], []);
  assert.equal(part(card(page, 'app/T-1'), 'reason')!.textContent, 'Fetch failed');
  assert.deepEqual(labels(card(page, 'app/T-1')), ['Retry']);
  assert.deepEqual(labels(card(page, 'app/T-2')), ['Retry']);
  assert.deepEqual(labels(card(page, 'app/T-3')), ['Tell it to go on']);
  assert.equal(button(card(page, 'app/T-3'), 'Tell it to go on')!.dataset.run, undefined);
  assert.equal(labels(card(page, 'app/T-4'))[0], 'Push again');

  button(card(page, 'app/T-1'), 'Retry')!.click();
  await page.flush();
  assert.deepEqual(posts(page).map((request) => [request.path, request.body]), [['api/jobs/app/T-1/retry', '{}']]);
  assert.equal(button(card(page, 'app/T-1'), 'Retry')!.disabled, true);
  button(card(page, 'app/T-1'), 'Retry')!.click();
  await page.flush();
  assert.equal(posts(page).length, 1);
  posts(page)[0]!.respond(200, { ok: true, result: { state: 'preparing_mr', iteration: 2, branch: 'T-1-x' } });
  await page.flush();
  assert.match(card(page, 'app/T-1').textContent, /MR preparation runs again \(state preparing_mr\)\./);
  assert.equal(onJobPage(page), false);
});

test('board client (SF-129): each Your turn card keeps its single primary, read from the payload: Retry on a retryable fetch_failed, Retry review on review_failed, the stop\'s button otherwise', async () => {
  const stop = (ticket: string, code: string, extra: Record<string, unknown> = {}) => job(ticket, 'needs_human', { error: { code, message: `The ${code} message.` }, ...extra });
  const cases: Array<[ReturnType<typeof job>, string]> = [
    [stop('A-1', 'fetch_failed'), 'Retry'],
    [stop('A-2', 'fetch_failed', { mr_conflict_turn: true }), 'Tell it to go on'],
    [stop('A-3', 'review_failed'), 'Retry review'],
    [stop('A-4', 'tests_unavailable'), 'Retry'],
    [stop('A-5', 'mr_rebase_failed'), 'Retry'],
    [stop('A-6', 'gate_budget'), 'Decide'],
    [stop('A-7', 'iteration_limit'), 'Give a direction'],
    [stop('A-8', 'session_failed', { error: { code: 'session_failed', message: "You've hit your limit · resets 3am" } }), 'Tell it to go on'],
    [stop('A-9', 'mr_conflict'), 'Tell it how'],
    [stop('B-1', 'guard_failed'), 'Retry'],
    [stop('B-5', 'odd_code'), 'Open the job'],
    [stop('B-2', 'mr_push_failed', { prepared_commit: 'a'.repeat(40) }), 'Push again'],
    [job('B-3', 'ready_for_human_review'), 'Review the MR and push'],
    [job('B-4', 'paused'), 'Resume'],
  ];
  const page = await openBoard(cases.map(([row]) => row), []);
  for (const [row, primary] of cases) {
    const shown = card(page, `app/${row.ticket}`).all().filter((node) => node.tagName === 'BUTTON' && node.classList.contains('primary'));
    assert.deepEqual(shown.map((node) => node.textContent), [primary], `${row.ticket} ${row.state} ${JSON.stringify(row.error)}`);
  }
  // A Retry the server does not offer is no card's primary, whatever the code says: the card opens
  // the job with the stop's own button, its words read the same availability.
  const fed = stop('C-1', 'fetch_failed') as ReturnType<typeof job> & { availability: Record<string, string> };
  const other = await openBoard([{ ...fed, availability: { ...fed.availability, retry: 'only after a transient MR preparation failure.' } } as ReturnType<typeof job>], []);
  assert.deepEqual(labels(card(other, 'app/C-1')), ['Tell it to go on']);
  assert.deepEqual([button(card(other, 'app/C-1'), 'Tell it to go on')!.dataset.run, button(card(other, 'app/C-1'), 'Tell it to go on')!.dataset.open], [undefined, 'app/C-1']);
  // The card's kind is the payload's stop_kind: the reason is red only for an error.
  const kinds = await openBoard([{ ...stop('D-1', 'gate_rounds'), stop_kind: 'error' } as ReturnType<typeof job>, stop('D-2', 'gate_rounds'), stop('D-3', 'mr_failed')], []);
  assert.deepEqual(['app/D-1', 'app/D-2', 'app/D-3'].map((key) => part(card(kinds, key), 'reason')!.className), ['reason err', 'reason', 'reason err']);
});

// SF-119: a localStorage over a map, and a matchMedia whose matches the test sets (narrow: below
// 768 px or no hover, the same answer for both queries).
const storageOf = (map: Map<string, string>) => ({ getItem: (name: string) => map.get(name) ?? null, setItem: (name: string, value: string) => void map.set(name, value) });
const mediaOf = (screen: { narrow: boolean }) => (query: string) => ({ get matches() { return screen.narrow; }, media: query, addEventListener: () => undefined });
const folded = (page: Page): string[] => COLUMNS.filter((column) => page.$(LISTS[column]).parentNode!.classList.contains('folded'));
const foldOf = (page: Page, column: string): FakeElement => page.document.querySelector(`[data-colfold="${column}"]`)!;

test('board client (SF-119): a column heading folds its column, kept in localStorage; a stored list keeps its column names only; the headings read as before', async () => {
  const stored = new Map<string, string>();
  const page = await openBoard([job('J-1', 'working'), job('D-1', 'pushed')], [ticket('app/T-1')], [workspace('app')], '', { jobs: true }, { localStorage: storageOf(stored) });
  assert.deepEqual([folded(page), foldOf(page, 'done').getAttribute('aria-expanded'), foldOf(page, 'done').getAttribute('aria-controls')], [[], 'true', 'list-done']);
  assert.deepEqual(COLUMNS.map((column) => page.$(`col-${column}-title`).textContent), ['Queue 1', 'Implementing 1', 'Reviewing 0', 'Your turn 0', 'Done 1']);
  foldOf(page, 'done').click();
  assert.deepEqual([folded(page), foldOf(page, 'done').getAttribute('aria-expanded'), stored.get('sf-board-folded')], [['done'], 'false', '["done"]']);
  foldOf(page, 'queue').click();
  assert.equal(stored.get('sf-board-folded'), '["queue","done"]');
  // Kept across a new rendering of the board.
  page.streams.at(-1)!.emit('jobs', { jobs: [job('J-1', 'working'), job('D-1', 'pushed')] });
  assert.deepEqual(folded(page), ['queue', 'done']);
  foldOf(page, 'queue').click();
  foldOf(page, 'done').click();
  assert.deepEqual([folded(page), stored.get('sf-board-folded'), foldOf(page, 'done').getAttribute('aria-expanded')], [[], '[]', 'true']);
  // A stored list: its column names only; anything else folds nothing.
  const again = await openBoard([], [], [workspace('app')], '', { jobs: true }, { localStorage: storageOf(new Map([['sf-board-folded', '["done","nope"]']])) });
  assert.deepEqual(folded(again), ['done']);
  const bad = await openBoard([], [], [workspace('app')], '', { jobs: true }, { localStorage: storageOf(new Map([['sf-board-folded', '{bad']])) });
  assert.deepEqual(folded(bad), []);
  const object = await openBoard([], [], [workspace('app')], '', { jobs: true }, { localStorage: storageOf(new Map([['sf-board-folded', '{"done":true}']])) });
  assert.deepEqual(folded(object), []);
});

test('board client (SF-119): a queued card\'s menu has Move up and Move down, off at the queue\'s ends, posting api/queue/move one place; none on a card out of the queue', async () => {
  const page = await openQueue(queuedTickets());
  const item = (key: string, label: string) => button(card(page, key), label);
  assert.deepEqual([item('app/T-3', 'Move up')!.disabled, item('app/T-3', 'Move down')!.disabled], [true, false]);
  assert.deepEqual([item('app/T-2', 'Move up')!.disabled, item('app/T-2', 'Move down')!.disabled], [false, false]);
  assert.deepEqual([item('app/T-6', 'Move up')!.disabled, item('app/T-6', 'Move down')!.disabled], [false, true]);
  assert.deepEqual([item('app/T-4', 'Move up'), item('app/T-4', 'Move down')], [undefined, undefined]);
  // The first items of the menu, before Archive (and Check).
  const menu = part(card(page, 'app/T-3'), 'cmenu')!;
  assert.deepEqual(labels(menu).slice(0, 2), ['Move up', 'Move down']);
  assert.equal(item('app/T-3', 'Move down')!.getAttribute('role'), 'menuitem');
  item('app/T-3', 'Move down')!.click();
  await page.flush();
  assert.deepEqual(posts(page).map((request) => [request.path, request.body]), [['api/queue/move', '{"workspace":"app","ticket":"T-3","to":2}']]);
  // Pending: both off.
  assert.deepEqual([item('app/T-3', 'Move up')!.disabled, item('app/T-3', 'Move down')!.disabled], [true, true]);
  posts(page)[0]!.respond(200, { ok: true, result: { position: 2 } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'app/T-3 moved to position 2.');
  item('app/T-6', 'Move up')!.click();
  await page.flush();
  assert.deepEqual([posts(page)[1]!.path, posts(page)[1]!.body], ['api/queue/move', '{"workspace":"app","ticket":"T-6","to":2}']);
});

test('board client (SF-119): on a phone or without hover a dependency chip\'s tap shows its state in the toast and still focuses its card; with a mouse no toast', async () => {
  const setup = async (narrow: boolean) => openBoard([{ ...job('W-1', 'working'), workspace: 'web' }], [
    ticket('app/Q-1', { lands_after: [dep('web/W-1', 'running')] }),
  ], [workspace('app'), workspace('web')], '', { jobs: true }, { matchMedia: mediaOf({ narrow }) });
  const chipOf = (page: Page) => lineOf(card(page, 'app/Q-1'), 'waits')!.all().find((element) => element.classList.contains('dchip'))!;
  const phone = await setup(true);
  chipOf(phone).click();
  await phone.flush();
  assert.deepEqual([phone.$('toast').hidden, phone.$('toast-text').textContent, phone.document.activeElement], [false, 'web/W-1: running', card(phone, 'web/W-1')]);
  // A tap on a card's own text opens the card (its page shows the detail): no toast.
  phone.$('toast-close').click();
  part(card(phone, 'app/Q-1'), 'wschip')!.click();
  assert.equal(phone.$('toast').hidden, true);
  const mouse = await setup(false);
  chipOf(mouse).click();
  await mouse.flush();
  assert.deepEqual([mouse.$('toast').hidden, mouse.document.activeElement], [true, card(mouse, 'web/W-1')]);
});

test('board client (SF-119): a chip pointing into a folded column unfolds it (stored) and focuses its card; j and k pass over a folded column\'s cards', async () => {
  const stored = new Map<string, string>([['sf-board-folded', '["implementing"]']]);
  const page = await openBoard([{ ...job('W-1', 'working'), workspace: 'web' }, job('D-1', 'pushed')], [
    ticket('app/Q-1', { lands_after: [dep('web/W-1', 'running')] }),
  ], [workspace('app'), workspace('web')], '', { jobs: true }, { localStorage: storageOf(stored) });
  assert.deepEqual(folded(page), ['implementing']);
  // j and k: Q-1 (Queue), then D-1 (Done); Implementing's W-1 is passed over.
  page.key('j');
  assert.equal(page.document.activeElement, card(page, 'app/Q-1'));
  page.key('j');
  assert.equal(page.document.activeElement, card(page, 'app/D-1'));
  page.key('k');
  assert.equal(page.document.activeElement, card(page, 'app/Q-1'));
  lineOf(card(page, 'app/Q-1'), 'waits')!.all().find((element) => element.classList.contains('dchip'))!.click();
  await page.flush();
  assert.deepEqual([folded(page), stored.get('sf-board-folded'), foldOf(page, 'implementing').getAttribute('aria-expanded'), page.document.activeElement],
    [[], '[]', 'true', card(page, 'web/W-1')]);
});
