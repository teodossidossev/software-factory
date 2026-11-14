// The Merge requests page in review-page.js and its rows in mr-row.js, run under node:vm against the
// fake page of test/support/fake-dom.ts: #merge-requests and its header tab; the read of the open
// merge requests when the page opens (the tab, the page select, the hash before and after the
// workspaces event), once, and when another workspace is chosen, never on a re-render (SF-209);
// Refresh and the read's age on the board's one-minute tick; the overviews, at most 4 at a time;
// each row's badges, a refused overview; expanding a row reads its threads (open ones first, the
// resolved and the bot threads behind their toggles); Refresh keeps the expanded row and its
// instructions; Create job's enabled state and its post (thread ids and instructions only), the new
// ticket's link and a refusal's message; host text with <script> shown as text; the other pages
// hiding it. Script checks, not browser acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
process.env.TZ = 'Europe/Sofia';

const SCRIPT = '<script>alert(1)</script><img src=x onerror=alert(2)>';
const REQUESTS = [
  { number: 4, title: 'Add the export', author: 'alice', source: 'SF-12-export', target: 'main', url: 'https://git.example/app/-/merge_requests/4', updated_at: '2026-11-09T10:00:00Z', draft: false },
  { number: 2, title: SCRIPT, author: 'bob', source: 'fix-login', target: 'develop', url: 'javascript:alert(3)', updated_at: '2026-11-08T10:00:00Z', draft: true },
];
const human = (author: string, body: string, created_at: string) => ({ author, body, created_at, bot: false });
const bot = (author: string, body: string, created_at: string) => ({ author, body, created_at, bot: true });
const THREADS = [
  { id: 'd1', resolved: true, path: 'README.md', line: 3, comments: [human('carol', 'Typo.', '2026-11-09T09:00:00Z')] },
  { id: 'd2', resolved: false, path: 'src/export.ts', line: 12, comments: [human('carol', SCRIPT, '2026-11-09T09:05:00Z'), human('alice', 'Done,\nrenamed.', '2026-11-09T09:10:00Z')] },
  { id: 'd3', resolved: null, path: null, line: null, comments: [human('dave', 'Add a test.', '2026-11-09T09:20:00Z')] },
  // Only bots: hidden behind their toggle, resolved or not.
  { id: 'd4', resolved: null, path: null, line: null, comments: [bot('sonarcloud[bot]', `Quality Gate failed ${SCRIPT}`, '2026-11-09T09:30:00Z')] },
  { id: 'd5', resolved: true, path: null, line: null, comments: [bot('ci-bot', 'Deployed.', '2026-11-09T09:31:00Z')] },
  // A person answered a bot: a people's thread.
  { id: 'd6', resolved: null, path: null, line: null, comments: [bot('ci-bot', 'Coverage dropped.', '2026-11-09T09:40:00Z'), human('alice', 'Expected.', '2026-11-09T09:41:00Z')] },
];
const OVERVIEW_4 = {
  number: 4, ready: true, reasons: [], behind: 0, pipeline: { state: 'passed', text: 'success', url: 'https://git.example/app/-/pipelines/41' },
  sonar: null, comments: { human: 3, bot: 2 },
};
const OVERVIEW_2 = {
  number: 2, ready: false, reasons: [`it is a draft ${SCRIPT}`, 'it is 3 commits behind the target branch'], behind: 3, pipeline: { state: 'failed', text: 'failed', url: null },
  sonar: { gate_failed: true, new_issues: 5, url: 'https://sonar.example/issues?id=app' }, comments: { human: 0, bot: 1 },
};

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

// The page's clock (Date.now) and the board's interval, which the test runs by hand.
interface Clock {
  now: number;
  intervals: Array<() => void>;
}

// The page at the hash, with the board's data and two workspaces; the host's reads stay pending.
async function openPage(hash: string, clock: Clock = { now: Date.parse('2026-11-14T10:00:00Z'), intervals: [] }): Promise<Page> {
  const jobs = [job('T-1')];
  const RealDate = Date;
  const FakeDate = class extends RealDate {
    static override now(): number {
      return clock.now;
    }
  };
  const setInterval = (callback: () => void): number => clock.intervals.push(callback);
  const page = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs } : undefined), undefined, { Date: FakeDate, setInterval });
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
const lists = (page: Page): string[] => reads(page, '/merge-requests').map((request) => request.path);
const overviewRead = (page: Page, number: number): FetchRequest => reads(page, `/merge-requests/${number}/overview`).at(-1)!;
const rows = (page: Page): FakeElement[] => root(page).querySelectorAll('.mq-row');
const badges = (row: FakeElement): string[] => row.querySelectorAll('.mq-badge').map((badge) => `${badge.className.replace('mq-badge ', '')}: ${badge.textContent}`);
const threadItems = (page: Page): FakeElement[] => root(page).querySelectorAll('.mq-thread');
const whereOf = (page: Page): string[] => threadItems(page).map((item) => item.querySelector('.mq-where')!.textContent);
const age = (page: Page): string => root(page).querySelector('[data-mq-age]')!.textContent;

// The page with app's merge requests read, their overviews answered, and !4 expanded.
async function expanded(): Promise<Page> {
  const page = await openPage('#merge-requests');
  reads(page, '/merge-requests').at(-1)!.respond(200, REQUESTS);
  await page.flush();
  overviewRead(page, 4).respond(200, OVERVIEW_4);
  overviewRead(page, 2).respond(200, OVERVIEW_2);
  await page.flush();
  control(page, 'request:4')!.click();
  await page.flush();
  return page;
}

test('review client: the page reads the open merge requests when it opens, once: by the hash before and after the workspaces event, the tab and the page select', async () => {
  // The hash at the start, before the workspaces are known: read when the event names them.
  const early = await openPage('#merge-requests');
  assert.equal(root(early).hidden, false);
  assert.deepEqual(reads(early, '/merge-requests').map((request) => [request.method, request.path]), [['GET', 'api/workspaces/app/merge-requests']]);
  assert.equal(root(early).querySelector('.mq-body')!.textContent, 'Loading the merge requests…');
  assert.equal(control(early, 'refresh')!.disabled, true);
  assert.equal(control(early, 'load'), undefined);

  // The board first, then the hash: read at once.
  const later = await openPage('');
  assert.deepEqual(lists(later), []);
  later.location.hash = '#merge-requests';
  later.window.dispatch('hashchange');
  await later.flush();
  assert.deepEqual(lists(later), ['api/workspaces/app/merge-requests']);

  // The tab, then the page select after going back: one read each time it opens.
  const tab = await openPage('');
  tab.$('open-merge-requests').click();
  await tab.flush();
  assert.deepEqual([root(tab).hidden, tab.$('board').hidden, tab.location.hash, lists(tab).length], [false, true, '#merge-requests', 1]);
  reads(tab, '/merge-requests')[0]!.respond(200, []);
  await tab.flush();
  assert.match(root(tab).querySelector('.mq-body')!.textContent, /No open merge requests in app\./);
  tab.key('Escape');
  assert.equal(root(tab).hidden, true);
  tab.$('page-select').value = 'merge-requests';
  tab.$('page-select').dispatch('change');
  await tab.flush();
  assert.deepEqual(lists(tab), ['api/workspaces/app/merge-requests', 'api/workspaces/app/merge-requests']);
});

test('review client: another workspace reads at once; a workspaces event reads only when it changes the workspace; a re-render never reads', async () => {
  const page = await openPage('#merge-requests');
  const pick = control(page, 'workspace')!;
  assert.deepEqual(pick.querySelectorAll('option').map((option) => option.textContent), ['app', 'web']);
  reads(page, '/merge-requests')[0]!.respond(200, REQUESTS);
  await page.flush();
  assert.equal(rows(page).length, 2);

  // A workspaces event that keeps app: drawn again, not read.
  const stream = page.streams.at(-1)!;
  stream.emit('workspaces', { workspaces: [workspaceRow('app'), workspaceRow('web'), workspaceRow('docs')] });
  await page.flush();
  assert.deepEqual(lists(page), ['api/workspaces/app/merge-requests']);
  assert.equal(control(page, 'workspace')!.querySelectorAll('option').length, 3);
  // Ticking, typing and toggling redraw the page without a read either.
  control(page, 'request:4')!.click();
  await page.flush();
  control(page, 'request:4')!.click();
  await page.flush();
  assert.deepEqual(lists(page), ['api/workspaces/app/merge-requests']);

  control(page, 'workspace')!.value = 'web';
  control(page, 'workspace')!.dispatch('change');
  await page.flush();
  assert.equal(rows(page).length, 0);
  assert.equal(lists(page).at(-1), 'api/workspaces/web/merge-requests');
  // An old overview answer of app's read is dropped.
  overviewRead(page, 4).respond(200, OVERVIEW_4);
  await page.flush();
  reads(page, '/merge-requests').at(-1)!.respond(409, { ok: false, error: { code: 'mr_token_missing', message: 'Merge requests are off for this workspace: SF_GITLAB_TOKEN is not set.' } });
  await page.flush();
  assert.match(root(page).querySelector('.err-text')!.textContent, /SF_GITLAB_TOKEN is not set\.$/);
  assert.equal(rows(page).length, 0);
  assert.equal(control(page, 'refresh')!.disabled, false);

  // web removed: the page falls back to app, a change, read at once; one read only.
  stream.emit('workspaces', { workspaces: [workspaceRow('app')] });
  await page.flush();
  assert.deepEqual(lists(page), ['api/workspaces/app/merge-requests', 'api/workspaces/web/merge-requests', 'api/workspaces/app/merge-requests']);
  stream.emit('workspaces', { workspaces: [workspaceRow('app')] });
  await page.flush();
  assert.equal(lists(page).length, 3);
});

test('review client: the overviews are read after the list, at most 4 at a time, in the list\'s order; Refresh waits for them; the read\'s age follows the board\'s tick without a read or a redraw', async () => {
  const clock: Clock = { now: Date.parse('2026-11-14T10:00:00Z'), intervals: [] };
  const page = await openPage('#merge-requests', clock);
  assert.equal(age(page), '');
  const six = [9, 8, 7, 6, 5, 3].map((number) => ({ ...REQUESTS[0]!, number, title: `MR ${number}` }));
  reads(page, '/merge-requests')[0]!.respond(200, six);
  await page.flush();
  assert.deepEqual(reads(page, '/overview').map((request) => request.path), [9, 8, 7, 6].map((n) => `api/workspaces/app/merge-requests/${n}/overview`));
  assert.ok(rows(page).every((row) => row.querySelector('.mq-status')!.textContent === 'Reading status…'));
  assert.equal(control(page, 'refresh')!.disabled, true);
  assert.equal(age(page), 'Read just now');
  overviewRead(page, 8).respond(200, { ...OVERVIEW_4, number: 8 });
  await page.flush();
  assert.deepEqual(reads(page, '/overview').length, 5);
  assert.equal(reads(page, '/overview').at(-1)!.path, 'api/workspaces/app/merge-requests/5/overview');
  for (const number of [9, 7, 6, 5]) {
    overviewRead(page, number).respond(200, { ...OVERVIEW_4, number });
  }
  await page.flush();
  assert.equal(reads(page, '/overview').length, 6);
  assert.equal(control(page, 'refresh')!.disabled, true);
  overviewRead(page, 3).respond(200, { ...OVERVIEW_4, number: 3 });
  await page.flush();
  assert.equal(control(page, 'refresh')!.disabled, false);
  assert.ok(rows(page).every((row) => row.querySelector('.mq-status')!.textContent === 'passedReady to merge'));

  // The board's interval sets the age's text only: the same element, no request.
  assert.equal(clock.intervals.length, 1);
  const shown = root(page).querySelector('[data-mq-age]')!;
  const firstRow = rows(page)[0]!;
  const sent = page.requests.length;
  const readAt = clock.now;
  clock.now = readAt + 59_000;
  clock.intervals[0]!();
  assert.equal(shown.textContent, 'Read just now');
  clock.now = readAt + 14 * 60_000;
  clock.intervals[0]!();
  assert.equal(shown.textContent, 'Read 14 min ago');
  clock.now = readAt + 64 * 60_000;
  clock.intervals[0]!();
  assert.equal(shown.textContent, 'Read 1 h 4 min ago');
  assert.equal(root(page).querySelector('[data-mq-age]'), shown);
  assert.equal(rows(page)[0], firstRow);
  assert.equal(page.requests.length, sent);

  // Refresh: the list and every overview again; the age from the new answer.
  control(page, 'refresh')!.click();
  await page.flush();
  assert.equal(lists(page).length, 2);
  reads(page, '/merge-requests').at(-1)!.respond(200, six.slice(0, 2));
  await page.flush();
  assert.equal(age(page), 'Read just now');
  assert.equal(reads(page, '/overview').length, 8);
});

test('review client: each row: title with its author and update, the host link (http(s) only), branches, the pipeline, readiness, rebase, Sonar only when failing, the comments button; a refused overview; host text as text', async () => {
  const page = await openPage('#merge-requests');
  const third = { ...REQUESTS[0]!, number: 7, title: 'Third', url: 'https://git.example/app/-/merge_requests/7', source: 'ci', target: 'main' };
  const fourth = { ...REQUESTS[0]!, number: 9, title: 'Fourth', source: 'docs', target: 'main' };
  reads(page, '/merge-requests')[0]!.respond(200, [...REQUESTS, third, fourth]);
  await page.flush();
  overviewRead(page, 4).respond(200, OVERVIEW_4);
  overviewRead(page, 2).respond(200, OVERVIEW_2);
  overviewRead(page, 7).respond(200, {
    number: 7, ready: null, reasons: ['GitLab is still checking whether it can be merged'], behind: null,
    pipeline: { state: 'other', text: SCRIPT, url: 'javascript:alert(4)' }, sonar: { gate_failed: false, new_issues: 2, url: null }, comments: { human: 1, bot: 0 },
  });
  overviewRead(page, 9).respond(502, { ok: false, error: { code: 'mr_host_error', message: 'GitLab 127.0.0.1 refused to read merge request !9: HTTP 500.' } });
  await page.flush();
  const [first, second, seventh, ninth] = rows(page);

  const title = first!.querySelector('.mq-title')!;
  assert.deepEqual([title.textContent, title.getAttribute('title')], ['!4 Add the export', 'alice · updated 2026-11-09 12:00:00']);
  assert.equal(first!.querySelector('.mq-open')!.href, 'https://git.example/app/-/merge_requests/4');
  assert.equal(first!.querySelector('.mq-branches')!.textContent, 'SF-12-export → main');
  assert.deepEqual(badges(first!), ['ok: passed', 'ok: Ready to merge']);
  const pipeline = first!.querySelector('.mq-badge')!;
  assert.deepEqual([pipeline.tagName, pipeline.href, pipeline.target, pipeline.rel], ['A', 'https://git.example/app/-/pipelines/41', '_blank', 'noopener noreferrer']);
  const comments = control(page, 'request:4')!;
  assert.deepEqual([comments.textContent, comments.getAttribute('title'), comments.getAttribute('aria-expanded')], ['3 comments', '2 bot comments hidden', 'false']);

  // A <script> title, a javascript: URL (no link), a failed pipeline without a URL, not ready with
  // the reasons, behind, a failing Sonar with its link.
  assert.equal(second!.querySelector('.mq-title')!.textContent, `!2 ${SCRIPT}`);
  assert.equal(second!.querySelector('.mq-open'), null);
  assert.deepEqual(badges(second!), [
    'bad: failed', `warn: Not ready: it is a draft ${SCRIPT}; it is 3 commits behind the target branch`, 'bad: Rebase needed: 3 behind develop', 'bad: Sonar: gate failed, 5 new issues',
  ]);
  assert.equal(second!.querySelector('.mq-badge')!.tagName, 'SPAN');
  const sonar = second!.querySelectorAll('.mq-badge').at(-1)!;
  assert.deepEqual([sonar.tagName, sonar.href], ['A', 'https://sonar.example/issues?id=app']);
  assert.deepEqual([control(page, 'request:2')!.textContent, control(page, 'request:2')!.getAttribute('title')], ['No comments', '1 bot comment hidden']);

  // The host's own word for another state, as text and without a javascript: link; the host
  // undecided; new issues on a passed gate; no bot comment, no title.
  assert.deepEqual(badges(seventh!), [`grey: ${SCRIPT}`, 'grey: Checking mergeability', 'bad: Sonar: 2 new issues']);
  assert.ok(seventh!.querySelectorAll('.mq-badge').every((badge) => badge.tagName === 'SPAN'));
  assert.deepEqual([control(page, 'request:7')!.textContent, control(page, 'request:7')!.getAttribute('title')], ['1 comment', null]);

  // A refused overview: the factory's message, muted; the row still expands.
  assert.equal(ninth!.querySelector('.mq-status')!.textContent, 'Status unavailable: GitLab 127.0.0.1 refused to read merge request !9: HTTP 500.');
  assert.ok(ninth!.querySelector('.mq-status .muted') !== null);
  assert.deepEqual(badges(ninth!), []);
  assert.equal(control(page, 'request:9')!.textContent, 'Comments');

  // No element was made of host text.
  assert.equal(root(page).querySelectorAll('script').length + root(page).querySelectorAll('img').length, 0);
});

test('review client: expanding a row reads its threads: open ones first, the resolved and the bot threads behind their toggles; another row closes the first; a <script> body is text', async () => {
  const page = await expanded();
  assert.deepEqual([control(page, 'request:4')!.getAttribute('aria-expanded'), control(page, 'title:4')!.getAttribute('aria-expanded')], ['true', 'true']);
  assert.equal(control(page, 'fetch'), undefined);
  assert.deepEqual(reads(page, '/threads').map((request) => request.path), ['api/workspaces/app/merge-requests/4/threads']);
  assert.match(root(page).querySelector('.mq-chosen')!.textContent, /^Loading the comments…/);
  reads(page, '/threads')[0]!.respond(200, THREADS);
  await page.flush();
  assert.deepEqual(whereOf(page), ['src/export.ts:12', 'General', 'General']);
  assert.ok(threadItems(page).every((item) => item.querySelector('input')!.checked !== true));
  const resolved = control(page, 'resolved')!;
  assert.deepEqual([resolved.textContent, resolved.getAttribute('aria-expanded')], ['Show resolved (1)', 'false']);
  const bots = control(page, 'bots')!;
  assert.deepEqual([bots.textContent, bots.getAttribute('aria-expanded')], ['Show bot comments (2)', 'false']);
  assert.doesNotMatch(root(page).querySelector('.mq-chosen')!.textContent, /Quality Gate|Deployed/);
  resolved.click();
  assert.deepEqual(whereOf(page), ['src/export.ts:12', 'General', 'General', 'README.md:3']);
  assert.equal(control(page, 'resolved')!.textContent, 'Hide resolved (1)');
  assert.match(threadItems(page)[3]!.textContent, /resolved/);
  control(page, 'resolved')!.click();
  control(page, 'bots')!.click();
  assert.deepEqual([control(page, 'bots')!.textContent, control(page, 'bots')!.getAttribute('aria-expanded')], ['Hide bot comments (2)', 'true']);
  assert.equal(threadItems(page).length, 5);
  assert.deepEqual(threadItems(page).slice(3).map((item) => item.querySelector('.mq-chead b')!.textContent), ['sonarcloud[bot]', 'ci-bot']);
  control(page, 'bots')!.click();
  assert.equal(threadItems(page).length, 3);

  // The bodies are text nodes: no element was made of them.
  const bodies = threadItems(page)[0]!.querySelectorAll('.mq-cbody');
  assert.deepEqual(bodies.map((node) => node.textContent), [SCRIPT, 'Done,\nrenamed.']);
  assert.ok(bodies[0]!.children.every((child) => !('tagName' in child)));
  assert.equal(root(page).querySelectorAll('script').length + root(page).querySelectorAll('img').length, 0);
  assert.deepEqual(threadItems(page)[0]!.querySelectorAll('.mq-chead b').map((node) => node.textContent), ['carol', 'alice']);

  // Another row (by its title) closes the first and reads its own threads; its ticks start empty.
  control(page, 'thread:d2')!.checked = true;
  control(page, 'thread:d2')!.dispatch('change');
  control(page, 'title:2')!.click();
  await page.flush();
  assert.deepEqual([control(page, 'request:4')!.getAttribute('aria-expanded'), control(page, 'request:2')!.getAttribute('aria-expanded')], ['false', 'true']);
  assert.equal(root(page).querySelectorAll('.mq-chosen').length, 1);
  assert.equal(reads(page, '/threads').at(-1)!.path, 'api/workspaces/app/merge-requests/2/threads');
  reads(page, '/threads').at(-1)!.respond(200, []);
  await page.flush();
  assert.equal(root(page).querySelector('.mq-chosen p')!.textContent, 'No review comments on this merge request.');
  // Its title again closes it.
  control(page, 'title:2')!.click();
  assert.equal(root(page).querySelectorAll('.mq-chosen').length, 0);
});

test('review client: Refresh keeps the expanded row and its instructions, reads its threads again and drops the ticks of threads gone; a merge request gone closes it', async () => {
  const page = await expanded();
  reads(page, '/threads')[0]!.respond(200, THREADS);
  await page.flush();
  for (const id of ['d2', 'd3']) {
    control(page, `thread:${id}`)!.checked = true;
    control(page, `thread:${id}`)!.dispatch('change');
  }
  control(page, 'text')!.value = 'Keep the old name.';
  control(page, 'text')!.dispatch('input');
  control(page, 'refresh')!.click();
  await page.flush();
  reads(page, '/merge-requests').at(-1)!.respond(200, REQUESTS);
  await page.flush();
  assert.equal(control(page, 'request:4')!.getAttribute('aria-expanded'), 'true');
  assert.equal(control(page, 'text')!.value, 'Keep the old name.');
  assert.equal(reads(page, '/threads').length, 2);
  reads(page, '/threads').at(-1)!.respond(200, THREADS.filter((thread) => thread.id !== 'd3'));
  await page.flush();
  assert.equal(control(page, 'thread:d2')!.checked, true);
  assert.equal(control(page, 'thread:d3'), undefined);
  assert.match(root(page).querySelector('.mq-chosen .hint')!.textContent, /^1 comment ticked\./);

  // !4 is no longer open: nothing is expanded.
  overviewRead(page, 4).respond(200, OVERVIEW_4);
  overviewRead(page, 2).respond(200, OVERVIEW_2);
  await page.flush();
  control(page, 'refresh')!.click();
  await page.flush();
  reads(page, '/merge-requests').at(-1)!.respond(200, REQUESTS.slice(1));
  await page.flush();
  assert.equal(root(page).querySelectorAll('.mq-chosen').length, 0);
  assert.equal(reads(page, '/threads').length, 2);
});

test('review client: Create job is on with a ticked thread or instructions; it posts the ids and the text only; the new ticket links to its page; a refusal shows the server\'s message', async () => {
  const page = await expanded();
  const create = () => control(page, 'create')!;
  // Instructions alone, while the comments are still read.
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
  // While it posts, no Refresh and no other workspace: its answer belongs to this list.
  assert.deepEqual([control(page, 'refresh')!.disabled, control(page, 'workspace')!.disabled], [true, true]);
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
  // Nothing but GETs and the job's POST reached the factory.
  assert.ok(page.requests.filter((request) => request.path.startsWith('api/workspaces/')).every((request) => request.method === 'GET' || request.path.endsWith('/job')));
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
