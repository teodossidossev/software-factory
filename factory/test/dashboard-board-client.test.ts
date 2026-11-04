// Behaviour of the board in static/app.js (SF-046), run under node:vm against the fake page of
// test/support/fake-dom.ts: the columns from the job states and the tickets, the pipeline segment
// per state, the line of who acts now, Start with its confirmation, refusal and unknown outcome,
// the Task text rendered as text, a card moving column on a jobs event, the workspace filter, Done's
// last ten, and the drawer that opens a job (and Approve… or Retry review from a Your turn card).
// Script checks, not browser acceptance: the manual steps are in factory/README.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
const COLUMNS = ['planned', 'implementing', 'reviewing', 'you', 'done'] as const;

function job(ticket: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    workspace: 'app', ticket, branch: `${ticket}-demo`, base: 'main', state, iteration: 1, mr_attempts: 0,
    updated_at: new Date(Date.now() - 4 * 60000).toISOString(), created_at: '2026-11-01T10:00:00.000Z', error: null,
    prepared_commit: state === 'ready_for_human_review' ? 'a'.repeat(40) : null, worktree: state === 'ready_for_human_review' ? null : `/wt/${ticket}`,
    files: 0, undeclared: 0, deleted: 0, title: `Title of ${ticket}`, cost_usd: null, review: null, review_ended_at: null, gate: null, ...extra,
  };
}

function detail(row: ReturnType<typeof job>) {
  return { job: row, iterations: [], mr: false, history: [] };
}

function ticket(key: string, extra: Record<string, unknown> = {}) {
  const [workspace, name] = key.split('/') as [string, string];
  return { workspace, ticket: name, title: `Ticket ${name}`, base: 'main', draft: false, request: null, job: null, conversation: { message: 'm', url: null }, ...extra };
}

const workspace = (name: string) => ({ name, path: `/srv/${name}`, liveJobs: 0, problem: null });

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

const cards = (page: Page, column: string): FakeElement[] =>
  page.$(`list-${column}`).children.filter((child): child is FakeElement => (child as FakeElement).className?.startsWith('board-card'));
const keys = (page: Page, column: string): string[] => cards(page, column).map((card) => card.dataset.key!);
const card = (page: Page, key: string): FakeElement => COLUMNS.flatMap((column) => cards(page, column)).find((item) => item.dataset.key === key)!;
const buttons = (item: FakeElement): FakeElement[] => item.all().filter((element) => element.tagName === 'BUTTON');
const button = (item: FakeElement, label: string): FakeElement | undefined => buttons(item).find((element) => element.textContent === label);
const segments = (item: FakeElement): string[] => item.all().filter((element) => element.tagName === 'I').map((element) => element.dataset.status!);
const who = (item: FakeElement): string => item.all().find((element) => element.className === 'card-who')!.textContent;
const posts = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'POST');

test('board client: the columns follow the states, Planned holds the tickets, the headers count, Done shows the last ten', async () => {
  const states = ['starting', 'working', 'awaiting_review', 'preparing_mr', 'needs_human', 'ready_for_human_review', 'pushed', 'aborted', 'failed'];
  const jobs = states.map((state, index) => job(`J-${index}`, state));
  const page = await openBoard(jobs, [ticket('app/T-1', { draft: true }), ticket('app/T-2', { job: 'pushed' })]);
  assert.deepEqual(keys(page, 'planned'), ['app/T-1', 'app/T-2']);
  assert.deepEqual(keys(page, 'implementing').sort(), ['app/J-0', 'app/J-1']);
  assert.deepEqual(keys(page, 'reviewing').sort(), ['app/J-2', 'app/J-3']);
  assert.deepEqual(keys(page, 'you').sort(), ['app/J-4', 'app/J-5']);
  assert.deepEqual(keys(page, 'done').sort(), ['app/J-6', 'app/J-7', 'app/J-8']);
  assert.deepEqual(COLUMNS.map((column) => page.$(`count-${column}`).textContent), ['2', '2', '2', '2', '3']);
  // A card: the key, the workspace, the title (the branch without one) and the chips.
  const working = card(page, 'app/J-1');
  assert.match(working.textContent, /^J-1appTitle of J-1/);
  assert.match(who(working), /^Implementer · 4 min$/);
  // The last job's state on a Planned card; an empty column says so.
  assert.match(card(page, 'app/T-2').textContent, /last job pushed/);
  page.streams.at(-1)!.emit('tickets', { tickets: [], archived: [] });
  assert.equal(page.$('list-planned').children.length, 1);
  assert.equal((page.$('list-planned').children[0] as FakeElement).className, 'col-empty');

  // Done: the most recent first, the last ten, then Show all.
  const done = Array.from({ length: 12 }, (_, index) => job(`D-${String(index).padStart(2, '0')}`, 'pushed', { updated_at: `2026-11-01T10:${String(index).padStart(2, '0')}:00.000Z`, title: null }));
  page.streams.at(-1)!.emit('jobs', { jobs: done });
  assert.equal(page.$('count-done').textContent, '12');
  assert.deepEqual(keys(page, 'done'), ['app/D-11', 'app/D-10', 'app/D-09', 'app/D-08', 'app/D-07', 'app/D-06', 'app/D-05', 'app/D-04', 'app/D-03', 'app/D-02']);
  assert.match(card(page, 'app/D-11').textContent, /D-11-demo/);
  assert.deepEqual([page.$('done-all').hidden, page.$('done-all').textContent], [false, 'Show all 12']);
  page.$('done-all').click();
  assert.equal(keys(page, 'done').length, 12);
  assert.equal(page.$('done-all').textContent, 'Show the last 10');
});

test('board client: the pipeline segment per state, a halted one red, and who acts now', async () => {
  const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60000).toISOString();
  const rows: Array<[Job, string[], RegExp]> = [
    [job('S', 'starting'), ['current', 'todo', 'todo', 'todo', 'todo'], /^Implementer · 4 min$/],
    [job('W', 'working'), ['current', 'todo', 'todo', 'todo', 'todo'], /^Implementer · 4 min$/],
    [job('C', 'awaiting_review'), ['done', 'current', 'todo', 'todo', 'todo'], /^Claude review · 4 min$/],
    [job('G', 'awaiting_review', { review: 'clean', review_ended_at: minutesAgo(2) }), ['done', 'done', 'current', 'todo', 'todo'], /^Codex gate · 2 min$/],
    [job('M', 'preparing_mr'), ['done', 'done', 'done', 'current', 'todo'], /^MR preparation · 4 min$/],
    [job('R', 'ready_for_human_review'), ['done', 'done', 'done', 'done', 'current'], /^You · approve · 4 min$/],
    [job('RF', 'needs_human', { error: { code: 'review_failed', message: 'overloaded' } }), ['done', 'halted', 'todo', 'todo', 'todo'], /^You · retry review/],
    [job('GR', 'needs_human', { error: { code: 'gate_rounds', message: 'three rounds' } }), ['done', 'done', 'halted', 'todo', 'todo'], /^You · gate_rounds/],
    [job('MC', 'needs_human', { error: { code: 'mr_conflict', message: 'conflict' } }), ['done', 'done', 'done', 'halted', 'todo'], /^You · mr_conflict/],
    [job('PF', 'needs_human', { error: { code: 'mr_push_failed', message: 'rejected' }, prepared_commit: 'b'.repeat(40), worktree: null }), ['done', 'done', 'done', 'done', 'halted'], /^You · approve/],
    [job('IL', 'needs_human', { error: { code: 'iteration_limit', message: 'five rounds' } }), ['halted', 'todo', 'todo', 'todo', 'todo'], /^You · iteration_limit/],
    [job('P', 'pushed'), ['done', 'done', 'done', 'done', 'done'], /^Pushed · 4 min ago$/],
    [job('A', 'aborted'), ['todo', 'todo', 'todo', 'todo', 'todo'], /^Aborted · 4 min ago$/],
    [job('F', 'failed', { error: { code: 'start_failed', message: 'Git failed.' } }), ['halted', 'todo', 'todo', 'todo', 'todo'], /^Failed · 4 min ago$/],
  ];
  const page = await openBoard(rows.map(([row]) => row), []);
  for (const [row, expected, line] of rows) {
    const item = card(page, `app/${row.ticket}`);
    assert.deepEqual(segments(item), expected, row.ticket);
    assert.match(who(item), line, row.ticket);
    assert.equal(item.all().find((element) => element.className === 'pipe')!.getAttribute('role'), 'img');
  }
  assert.equal(card(page, 'app/G').all().find((element) => element.className === 'pipe')!.getAttribute('aria-label'), 'Pipeline: Codex gate');
  assert.equal(card(page, 'app/RF').all().find((element) => element.className === 'pipe')!.getAttribute('aria-label'), 'Pipeline: Claude review, halted');
  // A halted job says why on its card.
  assert.match(card(page, 'app/RF').textContent, /review_failed: overloaded/);
  // The action of each Your turn card; a branch to approve also offers Create merge request… (SF-048).
  assert.deepEqual(['R', 'RF', 'GR', 'PF'].map((name) => buttons(card(page, `app/${name}`)).filter((element) => element.className.startsWith('btn')).map((element) => element.textContent)),
    [['Approve…', 'Create merge request…'], ['Retry review'], ['Open the job'], ['Approve…', 'Create merge request…']]);
});

test('board client: Start asks first, naming the workspace, the ticket and the base; Cancel sends nothing; a refusal shows as it comes; a skeleton waits for the plan', async () => {
  const page = await openBoard([], [ticket('app/T-1', { draft: true }), ticket('app/T-2', { base: 'develop', job: 'failed' })]);
  const skeleton = card(page, 'app/T-1');
  assert.equal(button(skeleton, 'Start'), undefined);
  assert.match(skeleton.textContent, /waiting for the plan/);
  assert.deepEqual(buttons(skeleton).map((element) => element.textContent), ['Task', 'Archive', 'Delete…']);
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
  assert.match(page.$('ticket-action-status').textContent, /^Starting app\/T-2/);
  assert.equal(button(card(page, 'app/T-2'), 'Start')!.disabled, true);
  page.$('ticket-ok').click();
  await page.flush();
  assert.equal(posts(page).length, 1);
  posts(page)[0]!.respond(409, { ok: false, error: { code: 'job_limit', message: 'Workspace app has 2 live job(s); SF_MAX_JOBS is 2.' } });
  await page.flush();
  assert.equal(page.$('ticket-action-status').textContent, 'job_limit: Workspace app has 2 live job(s); SF_MAX_JOBS is 2.');
  assert.equal(page.$('ticket-action-status').className, 'status toast error');
  assert.equal(button(card(page, 'app/T-2'), 'Start')!.disabled, false);
  assert.equal(posts(page).length, 1);

  // Accepted: the result as text; the card moves when the stream says so.
  button(card(page, 'app/T-2'), 'Start')!.click();
  page.$('ticket-ok').click();
  await page.flush();
  posts(page)[1]!.respond(200, { ok: true, result: { branch: 'T-2-ticket-t-2', state: 'working', check_after_minutes: 15, worktree: '/wt/T-2' } });
  await page.flush();
  assert.equal(page.$('ticket-action-status').textContent, 'Started app/T-2: branch T-2-ticket-t-2, working. The Implementer runs iteration 1.');
  const stream = page.streams.at(-1)!;
  stream.emit('jobs', { jobs: [job('T-2', 'working')] });
  stream.emit('tickets', { tickets: [ticket('app/T-1', { draft: true })], archived: [] });
  assert.deepEqual([keys(page, 'planned'), keys(page, 'implementing')], [['app/T-1'], ['app/T-2']]);
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
  assert.match(page.$('ticket-action-status').textContent, /^The start of app\/T-2 failed \(Failed to fetch\)\. Its outcome is unknown: the job may have started; the board is being read again\.$/);
  assert.equal(button(card(page, 'app/T-2'), 'Start')!.disabled, true);
  // The read: the job exists, so the card is on Implementing; Start is back for the ticket row.
  const read = page.requests.filter((request) => request.path === 'api/jobs').at(-1)!;
  read.respond(200, { jobs: [job('T-2', 'starting')] });
  await page.flush();
  assert.deepEqual(keys(page, 'implementing'), ['app/T-2']);
  assert.match(page.$('ticket-action-status').textContent, /The board is current: check it before starting again\.$/);
  assert.equal(button(card(page, 'app/T-2'), 'Start')!.disabled, false);

  // A failed read keeps the hold until the stream's next jobs event.
  button(card(page, 'app/T-2'), 'Start')!.click();
  page.$('ticket-ok').click();
  await page.flush();
  posts(page)[1]!.failBody(200);
  await page.flush();
  page.requests.filter((request) => request.path === 'api/jobs').at(-1)!.fail();
  await page.flush();
  assert.match(page.$('ticket-action-status').textContent, /the board could not be read \(Failed to fetch\)\. Start stays off for app\/T-2 until the page reconnects/);
  assert.equal(button(card(page, 'app/T-2'), 'Start')!.disabled, true);
  page.streams.at(-1)!.emit('jobs', { jobs: [] });
  assert.equal(button(card(page, 'app/T-2'), 'Start')!.disabled, false);
  assert.equal(posts(page).length, 2);
});

test('board client: Task opens the Task text in the drawer as text; a <script> stays text and headings are bold', async () => {
  const page = await openBoard([], [ticket('app/T-2', { base: 'develop' })]);
  button(card(page, 'app/T-2'), 'Task')!.click();
  await page.flush();
  assert.deepEqual([page.$('drawer').hidden, page.$('task-panel').hidden, page.$('detail').hidden], [false, false, true]);
  assert.equal(page.$('drawer-title').textContent, 'T-2 · Ticket T-2');
  assert.equal(page.$('drawer-kicker').textContent, 'app · .software-factory/T-2.md · base develop');
  const read = page.requests.at(-1)!;
  assert.deepEqual([read.method, read.path], ['GET', 'api/tickets/app/T-2/task']);
  assert.equal(page.$('task-body').textContent, 'Loading the Task file…');
  const text = '---\nticket: T-2\n---\n\n# T-2: <b>Two</b>\n\n<script>alert(1)</script>\n<img src=x onerror=alert(2)>';
  read.respond(200, text);
  await page.flush();
  const lines = page.$('task-body').children as FakeElement[];
  // One text span per line: the exact text, no element made from the file.
  assert.equal(page.$('task-body').textContent, `${text.split('\n').join('\n')}\n`);
  assert.ok(lines.every((line) => line.tagName === 'SPAN' && line.children.every((child) => child.nodeType === 3)));
  assert.deepEqual(lines.filter((line) => line.className === 'heading').map((line) => line.textContent), ['# T-2: <b>Two</b>\n']);
  assert.equal(page.$('task-body').all().some((element) => element.tagName === 'SCRIPT' || element.tagName === 'IMG' || element.tagName === 'B'), false);
  // A missing file says so.
  page.$('drawer-close').click();
  button(card(page, 'app/T-2'), 'Task')!.click();
  page.requests.at(-1)!.respond(404, '');
  await page.flush();
  assert.equal(page.$('task-body').textContent, 'Could not load the Task file: api/tickets/app/T-2/task: HTTP 404\n');
});

test('board client: a card moves column on a jobs event; the workspace filter keeps one workspace', async () => {
  const page = await openBoard([job('T-1', 'working'), { ...job('W-1', 'working'), workspace: 'web' }], [ticket('web/W-2')], [workspace('app'), workspace('web')]);
  const stream = page.streams.at(-1)!;
  assert.deepEqual(keys(page, 'implementing').sort(), ['app/T-1', 'web/W-1']);
  stream.emit('jobs', { jobs: [job('T-1', 'awaiting_review'), { ...job('W-1', 'working'), workspace: 'web' }] });
  assert.deepEqual([keys(page, 'implementing'), keys(page, 'reviewing')], [['web/W-1'], ['app/T-1']]);
  stream.emit('jobs', { jobs: [job('T-1', 'ready_for_human_review'), { ...job('W-1', 'working'), workspace: 'web' }] });
  assert.deepEqual([keys(page, 'reviewing'), keys(page, 'you')], [[], ['app/T-1']]);
  assert.equal(page.$('count-you').textContent, '1');

  // The filter: All and one button per workspace; one workspace keeps its cards and counts.
  const filters = page.$('workspace-filter').children as FakeElement[];
  assert.deepEqual(filters.map((element) => [element.textContent, element.getAttribute('aria-pressed')]), [['All workspaces', 'true'], ['app', 'false'], ['web', 'false']]);
  filters[2]!.click();
  assert.deepEqual([keys(page, 'planned'), keys(page, 'implementing'), keys(page, 'you')], [['web/W-2'], ['web/W-1'], []]);
  assert.equal(page.$('count-you').textContent, '0');
  // A removed workspace drops its filter.
  stream.emit('workspaces', { workspaces: [workspace('app')] });
  assert.deepEqual(keys(page, 'you'), ['app/T-1']);
});

test('board client: a job card opens the job in the drawer, following it on the stream; closing stops following it', async () => {
  const page = await openBoard([job('T-1', 'working'), job('T-2', 'awaiting_review')], []);
  assert.equal(page.streams.at(-1)!.url, 'api/stream?');
  const open = buttons(card(page, 'app/T-1'))[0]!;
  assert.equal(open.className, 'card-open');
  open.click();
  await page.flush();
  assert.deepEqual([page.$('drawer').hidden, page.$('detail').hidden, page.$('task-panel').hidden], [false, false, true]);
  assert.equal(page.$('drawer-title').textContent, 'T-1 · Title of T-1');
  assert.equal(page.streams.at(-1)!.url, 'api/stream?job=app%2FT-1&from=0');
  assert.equal(page.location.hash, '#app/T-1');
  page.streams.at(-1)!.emit('job', detail(job('T-1', 'working')));
  assert.equal(page.$('job-ticket').textContent, 'T-1');
  assert.equal(buttons(card(page, 'app/T-1'))[0]!.getAttribute('aria-current'), 'true');
  // Another card switches the job in the same drawer.
  buttons(card(page, 'app/T-2'))[0]!.click();
  await page.flush();
  assert.equal(page.streams.at(-1)!.url, 'api/stream?job=app%2FT-2&from=0');
  // Closing: the drawer goes and the stream follows no job.
  page.$('drawer-close').click();
  assert.deepEqual([page.$('drawer').hidden, page.$('detail').hidden], [true, true]);
  assert.equal(page.streams.at(-1)!.url, 'api/stream?');
  assert.equal(page.location.hash, '#');
  // The open job leaving the board closes the drawer.
  buttons(card(page, 'app/T-1'))[0]!.click();
  await page.flush();
  page.streams.at(-1)!.emit('jobs', { jobs: [job('T-2', 'awaiting_review')] });
  assert.equal(page.$('drawer').hidden, true);
});

test('board client: Approve… on a Your turn card opens the job with its confirmation; Retry review posts once from the card', async () => {
  const failed = job('T-3', 'needs_human', { error: { code: 'review_failed', message: 'overloaded' } });
  const page = await openBoard([job('T-1', 'ready_for_human_review'), failed], []);
  button(card(page, 'app/T-1'), 'Approve…')!.click();
  await page.flush();
  assert.equal(page.$('drawer').hidden, false);
  // The detail arrives (the GET of the stream's first job event): the confirmation opens on it.
  page.streams.at(-1)!.emit('job', detail(job('T-1', 'ready_for_human_review')));
  assert.equal(page.$('confirm').hidden, false);
  assert.equal(page.$('confirm-title').textContent, 'Approve app/T-1?');
  assert.equal(posts(page).length, 0);
  page.$('confirm-cancel').click();
  page.$('drawer-close').click();

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
  // The drawer did not open for it.
  assert.equal(page.$('drawer').hidden, true);
});

test('board client: the ChatGPT reviewer is not shown anywhere', async () => {
  const page = await openBoard([job('T-1', 'awaiting_review', { reviewer: 'none' })], [ticket('app/T-2', { reviewer: { status: 'none' } })], [workspace('app')], '#app/T-1');
  page.streams.at(-1)!.emit('subscriptions', { subscriptions: [{ id: 'sub_1', input: {}, host: 'chatgpt.example', refreshBefore: '2026-11-08T09:00:00.000Z', job: null }] });
  page.streams.at(-1)!.emit('job', { ...detail(job('T-1', 'awaiting_review')), reviewer: { status: 'none' }, reviewerSetup: { guide: 'Call guide.', instruction: 'x' } });
  for (const id of ['reviewer', 'nudge-button', 'test-event-button', 'subscription-list', 'setup-guide']) {
    assert.equal(page.document.getElementById(id), null, id);
  }
  const text = [...COLUMNS.map((column) => page.$(`list-${column}`).textContent), page.$('detail').all().map((element) => element.textContent).join('')].join(' ');
  assert.doesNotMatch(text, /Reviewer|no reviewer|Nudge|test event|Subscriptions/);
});
