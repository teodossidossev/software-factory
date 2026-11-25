// Behaviour of the job page's header and its Changes and Merge request screens in
// static/job-page.js and static/job-screens.js (SF-078), run under node:vm against the fake page of
// test/support/fake-dom.ts: the URL hash that opens the page, the header for each state (the
// sentence, the iteration from shownIteration, the cost, the elapsed time, the branch that copies
// its checkout command), the screen switch and its keys s, c and m, Merge request off without MR
// text; the old MR view (Copy MR text, the Codex items not applied) inside its screen until SF-080,
// and that the old Changes view is gone (SF-079: the Changes screen is tested in
// dashboard-changes-client.test.ts). The Stream, its stop blocks and the composer are tested in
// dashboard-stream-client.test.ts. Script checks, not browser acceptance: the manual steps are in
// factory/README.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { served, servedDetail } from './support/dashboard-client.js';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);

// The page shows local time (SF-049); the zone is set, not the machine's: Sofia is UTC+2 in November.
process.env.TZ = 'Europe/Sofia';

// The job as the server sends it: with its stop's row, its actions and their availability (SF-129).
function job(state: string, extra: Record<string, unknown> = {}) {
  const prepared = state === 'ready_for_human_review' || state === 'pushed';
  return served({
    workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', state, iteration: 1, mr_attempts: 0,
    updated_at: '2026-11-01T10:05:00.000Z', created_at: '2026-11-01T10:00:00.000Z', error: null,
    prepared_commit: prepared ? 'a'.repeat(40) : null, worktree: prepared ? null : '/wt/T-1',
    fixes: 0, gate_fixes: 0, gate_tokens: 0, files: 0, undeclared: 0, deleted: 0, title: 'Demo', ...extra,
  });
}

type Job = ReturnType<typeof job>;
type Detail = { job: Job; iterations: Array<Record<string, unknown>>; mr: boolean; gate: boolean; history: Array<Record<string, unknown>> };

const META = { started_at: '2026-11-01T10:00:01.000Z', ended_at: '2026-11-01T10:05:00.000Z', cost_usd: 0.5, changed_files: 1, patch_truncated: false, denials: 0, files: null };

function iteration(number: number, extra: Record<string, unknown> = {}) {
  return { number, ...META, review: null, gate: null, gate_override: null, ...extra };
}

function detail(row: Job, extra: Partial<Omit<Detail, 'job'>> = {}): Detail {
  return servedDetail({ job: row, iterations: [], mr: false, gate: true, history: [{ ts: '2026-11-01T10:00:00.000Z', from: null, to: 'starting' }], ...extra });
}

// The page with the job of shown open through the URL's hash (screen: '', '/changes' or '/mr'); get
// answers the other GETs (undefined leaves them pending; an empty Stream page by default).
// globals: names added to the page's context (a matchMedia: SF-119).
async function openJob(shown: Detail, get: (path: string) => unknown = () => undefined, clipboard?: { writeText(text: string): Promise<void> }, others: Job[] = [], screen = '', globals: Record<string, unknown> = {}): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs: [shown.job, ...others] };
    }
    if (path === 'api/jobs/app/T-1') {
      return shown;
    }
    return get(path);
  }, clipboard, globals);
  page.location.hash = `#app/T-1${screen}`;
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs: [shown.job, ...others] });
  stream.emit('job', shown);
  await page.flush();
  return page;
}

async function show(page: Page, shown: Detail): Promise<void> {
  page.streams.at(-1)!.emit('job', shown);
  await page.flush();
}

const texts = (node: FakeElement): string[] => (node.children as FakeElement[]).map((child) => child.textContent);
const gets = (page: Page, path: string): FetchRequest[] => page.requests.filter((request) => request.method === 'GET' && request.path === path);

// The header's parts: the key and the title (t1), the switch's tabs, and the facts line (t2).
const t1 = (page: Page): FakeElement => page.$('jhead').children[1] as FakeElement;
const tabs = (page: Page): FakeElement[] => page.$('jhead').querySelectorAll('[role="tab"]');
const tabOf = (page: Page, screen: string): FakeElement => tabs(page).find((tab) => tab.dataset.goto === screen)!;
const facts = (page: Page): string[] => texts(page.$('jhead').children[3] as FakeElement);
const shownScreens = (page: Page): string[] => ['scrStream', 'scrChanges', 'scrMr'].filter((id) => !page.$(id).hidden);
const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60000).toISOString();

test('job client: the hash opens the job as its full page on the Stream; a hash change opens another; ← Board clears the hash', async () => {
  const other = { ...job('working'), ticket: 'T-2', branch: 'T-2-demo', title: 'Other' };
  const page = await openJob(detail(job('working')), () => undefined, undefined, [other]);
  assert.deepEqual([page.$('job').hidden, page.$('board').hidden, page.$('drawer').hidden], [false, true, true]);
  assert.deepEqual(shownScreens(page), ['scrStream']);
  assert.deepEqual([t1(page).textContent, page.location.hash], ['T-1appDemo', '#app/T-1']);
  assert.equal(page.streams.at(-1)!.url, 'api/stream?job=app%2FT-1&from=0');
  // No element of the old job detail is left.
  for (const id of ['detail', 'job-tabs', 'job-stepper', 'next-panel', 'job-facts', 'history', 'events', 'ledger-panel', 'say-form', 'action-reasons', 'job-task']) {
    assert.equal(page.document.getElementById(id), null, id);
  }

  page.location.hash = '#app/T-2';
  page.window.dispatch('hashchange');
  await page.flush();
  assert.equal(page.streams.at(-1)!.url, 'api/stream?job=app%2FT-2&from=0');
  assert.equal(t1(page).textContent, 'T-2appOther');

  (page.$('jhead').children[0] as FakeElement).click();
  assert.deepEqual([page.$('job').hidden, page.$('board').hidden, page.location.hash], [true, false, '#']);
});

test('job client: the header for each state: the sentence with its dot, the iteration from shownIteration, the cost, the elapsed time and the branch', async () => {
  const page = await openJob(detail(job('starting', { iteration: 0 })));
  const cases: Array<[Job, string[]]> = [
    [job('starting', { iteration: 0, cost_usd: null, created_at: minutesAgo(3) }),
      ['The worktree is being created and the Implementer starts', 'Iteration 1 (running)', '— so far (Claude, est.)', '3 min elapsed', 'T-1-demo']],
    [job('working', { iteration: 1, cost_usd: 1.234, created_at: minutesAgo(65) }),
      ['The Implementer is working on iteration 2', 'Iteration 2 (running)', '$1.23 so far (Claude, est.)', '1 h 5 min elapsed', 'T-1-demo']],
    [job('awaiting_review', { iteration: 1, cost_usd: 2, created_at: minutesAgo(10) }),
      ['Claude and Codex are reviewing iteration 1', 'Iteration 1', '$2.00 so far (Claude, est.)', '10 min elapsed', 'T-1-demo']],
    // Without the Claude review (SF-131) the gate alone reviews.
    [job('awaiting_review', { iteration: 1, cost_usd: 2, created_at: minutesAgo(10), claude_review: false }),
      ['The Codex gate is reviewing iteration 1', 'Iteration 1', '$2.00 so far (Claude, est.)', '10 min elapsed', 'T-1-demo']],
    [job('preparing_mr', { iteration: 2, created_at: minutesAgo(10) }), ['Writing the MR text', 'Iteration 2', '— so far (Claude, est.)', '10 min elapsed', 'T-1-demo']],
    [job('ready_for_human_review', { iteration: 2, cost_usd: 3.5 }), ['Reviews are clean and the MR text is written. Push when you are happy', 'Iteration 2', '$3.50 (Claude, est.)', '5 min elapsed', 'T-1-demo']],
    [job('pushed', { iteration: 2, cost_usd: 3.5 }), ['Pushed at 12:05', 'Iteration 2', '$3.50 (Claude, est.)', '5 min elapsed', 'T-1-demo']],
    [job('aborted'), ['Aborted by you. The branch stays', 'Iteration 1', '— (Claude, est.)', '5 min elapsed', 'T-1-demo']],
    [job('paused', { paused: { from: 'working', step: 'turn', at: '2026-11-01T10:04:00.000Z' } }),
      ['Paused by you during iteration 2. Resume continues the same session (with your message, if you write one below); Restart starts the ticket again from its current Task file', 'Iteration 2', '— (Claude, est.)', '5 min elapsed', 'T-1-demo']],
    [job('paused', { paused: { from: 'awaiting_review', step: 'gate', at: '2026-11-01T10:04:00.000Z' } }),
      ['Paused by you during iteration 1. Resume runs it again; Restart starts the ticket again from its current Task file', 'Iteration 1', '— (Claude, est.)', '5 min elapsed', 'T-1-demo']],
    [job('needs_human', { iteration: 2, error: { code: 'max_turns', message: 'x' } }),
      ['The Implementer used all its turns on iteration 3. Tell it to go on', 'Iteration 3', '— (Claude, est.)', '5 min elapsed', 'T-1-demo']],
  ];
  for (const [row, expected] of cases) {
    page.streams.at(-1)!.emit('jobs', { jobs: [row] });
    await show(page, detail(row));
    assert.deepEqual(facts(page), expected, row.state);
    assert.equal(page.$('job').className, `st-${row.state}`, row.state);
    const sentence = (page.$('jhead').children[3] as FakeElement).children[0] as FakeElement;
    assert.deepEqual([sentence.className, (sentence.children[0] as FakeElement).className], ['sentence', 'dot']);
    // The code of a stop as a tag beside the title, only while the job waits.
    assert.deepEqual(t1(page).all().filter((element) => element.className === 'tag').map((element) => element.textContent), row.state === 'needs_human' ? ['max_turns'] : [], row.state);
  }
  // The branch is a button that copies the checkout command.
  const branch = (page.$('jhead').children[3] as FakeElement).children[4] as FakeElement;
  assert.deepEqual([branch.tagName, branch.className], ['BUTTON', 'mono fs12 branch']);
});

test('job client: the branch copies its checkout command; without the clipboard it is shown, selected', async () => {
  const written: string[] = [];
  const page = await openJob(detail(job('working')), () => undefined, { writeText: async (text) => void written.push(text) });
  ((page.$('jhead').children[3] as FakeElement).children[4] as FakeElement).click();
  await page.flush();
  assert.deepEqual(written, ['git checkout T-1-demo']);
  assert.deepEqual([page.$('toast').hidden, page.$('toast-text').textContent], [false, 'Copied. git checkout T-1-demo']);
  const bare = await openJob(detail(job('working')));
  ((bare.$('jhead').children[3] as FakeElement).children[4] as FakeElement).click();
  const box = bare.$('checkout-text');
  assert.deepEqual([box.hidden, box.value, box.selected, bare.document.activeElement], [false, 'git checkout T-1-demo', true, box]);
});

test('job client: the switch: Stream (s), Changes (N) (c), Merge request (m), aria-selected on the current one; Merge request is off without MR text; Escape goes back', async () => {
  const shown = detail(job('awaiting_review', { files: 3 }), { iterations: [iteration(1)] });
  const page = await openJob(shown, (path) => (path.endsWith('/report') || path.endsWith('/patch') || path.endsWith('/mr') ? 'text' : undefined));
  assert.deepEqual(tabs(page).map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]), [['Stream s', 'true'], ['Changes (3) c', 'false'], ['Merge request m', 'false']]);
  assert.deepEqual([tabOf(page, 'mr').getAttribute('aria-disabled'), tabOf(page, 'mr').disabled, tabOf(page, 'mr').getAttribute('title')], ['true', true, 'No MR text yet: written at Clean']);
  // c opens Changes; s goes back to the Stream; a click on Changes as well.
  page.key('c');
  await page.flush();
  assert.deepEqual([shownScreens(page), page.location.hash, tabOf(page, 'changes').getAttribute('aria-selected')], [['scrChanges'], '#app/T-1/changes', 'true']);
  page.key('s');
  assert.deepEqual([shownScreens(page), page.location.hash], [['scrStream'], '#app/T-1']);
  tabOf(page, 'changes').click();
  assert.deepEqual(shownScreens(page), ['scrChanges']);
  // Without MR text, m and a click say so and stay.
  page.key('m');
  assert.deepEqual([shownScreens(page), page.$('toast-text').textContent], [['scrChanges'], 'No MR text yet: written at Clean']);
  tabOf(page, 'mr').click();
  assert.deepEqual(shownScreens(page), ['scrChanges']);
  // Escape: a screen of the job to its Stream, the Stream to the board.
  page.key('Escape');
  page.key('Escape');
  assert.deepEqual([shownScreens(page), page.location.hash], [['scrStream'], '#app/T-1']);
  // With MR text: m opens it, the count is left out when it is not a number.
  page.streams.at(-1)!.emit('jobs', { jobs: [job('ready_for_human_review', { files: null })] });
  await show(page, detail(job('ready_for_human_review', { files: null }), { mr: true, iterations: [iteration(1)] }));
  assert.deepEqual([tabOf(page, 'mr').getAttribute('aria-disabled'), tabOf(page, 'mr').disabled, tabOf(page, 'changes').textContent], ['false', false, 'Changes c']);
  page.key('m');
  await page.flush();
  assert.deepEqual([shownScreens(page), page.location.hash], [['scrMr'], '#app/T-1/mr']);
  assert.deepEqual([gets(page, 'api/jobs/app/T-1/mr-view').length, gets(page, 'api/jobs/app/T-1/mr').length], [1, 0]);
  page.$('toast-close').click();
  page.key('Escape');
  assert.deepEqual(shownScreens(page), ['scrStream']);
  page.key('Escape');
  assert.deepEqual([page.$('job').hidden, page.location.hash], [true, '#']);
});

// SF-079: the Changes screen replaced the old Changes view: none of its elements is left, and the
// tab's count is still job.files. The screen itself is tested in dashboard-changes-client.test.ts.
test('job client: the old Changes view is gone; Changes (N) counts job.files; the screen reads the changes route', async () => {
  const shown = detail(job('awaiting_review', { iteration: 1, files: 4 }), { iterations: [iteration(1)] });
  const page = await openJob(shown, (path) => (path === 'api/jobs/app/T-1/changes' ? { base: { ref: 'main', commit: null }, iterations: [] } : undefined), undefined, [], '/changes');
  for (const id of ['no-iterations', 'changes-body', 'iteration-picker', 'iteration-meta', 'report-box', 'iteration-report', 'files-summary', 'no-files', 'files-list', 'patch-note', 'patch-body']) {
    assert.equal(page.document.getElementById(id), null, id);
  }
  assert.deepEqual([shownScreens(page), tabOf(page, 'changes').textContent], [['scrChanges'], 'Changes (4) c']);
  assert.equal(gets(page, 'api/jobs/app/T-1/changes').length, 1);
  assert.equal(page.requests.filter((request) => /\/iterations\/\d+\/patch$/.test(request.path)).length, 0);
});

// SF-080: the Merge request screen replaced the old MR view: none of its elements is left and the
// page reads mr-view, never the plain mr route. The screen itself is tested in
// merge-request-client.test.ts.
test('job client: the old MR view is gone; the Merge request screen reads mr-view; without MR text it says when it comes', async () => {
  const page = await openJob(detail(job('working')), () => undefined, undefined, [], '/mr');
  for (const id of ['no-mr', 'mr-panel', 'mr-copy', 'mr-copy-status', 'mr-copy-text', 'mr-body', 'mr-unapplied', 'mr-unapplied-note', 'mr-unapplied-list']) {
    assert.equal(page.document.getElementById(id), null, id);
  }
  assert.deepEqual(shownScreens(page), ['scrMr']);
  assert.equal(page.$('scrMr').textContent, 'No MR text yet: written at Clean, after a clean review or your Accept.');
  await show(page, detail(job('ready_for_human_review'), { mr: true }));
  assert.deepEqual([gets(page, 'api/jobs/app/T-1/mr-view').length, gets(page, 'api/jobs/app/T-1/mr').length], [1, 0]);
});

// ---------- The hand-over (SF-073) and its panel (SF-107) ----------

const HANDOVER = {
  branch: 'T-1-demo', saved: 'a'.repeat(40), base: 'b'.repeat(40), previous: { branch: 'main' }, untracked: [], template: null, cleanup: null,
  at: '2026-11-01T10:06:00.000Z', checked_at: null, step: null,
};

function handedOver(extra: Record<string, unknown> = {}): Job {
  return job('handed_over', { prepared_commit: 'a'.repeat(40), worktree: null, handover: HANDOVER, handoff_skipped: null, mr_host: { host: 'github', reason: null }, ...extra });
}

const FILE_CHANGES = [
  { path: 'README.md', status: 'modified', sensitive: 'no', scope: 'none', additions: 3, deletions: 1 },
  { path: 'a.txt', status: 'added', sensitive: 'no', scope: 'none', additions: 2, deletions: 0 },
];

function entry(id: string, status: string, reviewer = 'claude') {
  return {
    id, iteration: 1, reviewer, severity: 'major', path: 'README.md', problem: `Problem of ${id}.`, expected: 'Better.', status,
    response: '', evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null,
  };
}

const panelOf = (page: Page): FakeElement => page.$('handover-panel');
// The panel's button whose text starts with the label (a menu item has a second line).
const inPanel = (page: Page, label: string): FakeElement => panelOf(page).querySelectorAll('button').find((node) => node.textContent.startsWith(label))!;
const menuOf = (page: Page): FakeElement => panelOf(page).querySelector('.ho-menu')!;
const posts = (page: Page, action: string): FetchRequest[] => page.requests.filter((request) => request.method === 'POST' && request.path === `api/jobs/app/T-1/${action}`);
const typeMessage = (page: Page, text: string): void => {
  page.$('msg').value = text;
  page.$('msg').dispatch('input');
};
// The ready panel (SF-286): its row's labels (More ▾ by its toggle), its menu, its toggle, .crow.
const readyOf = (page: Page): FakeElement => page.$('ready-panel');
const rowLabels = (page: Page): string[] => (readyOf(page).querySelector('.rd-row')!.children as FakeElement[])
  .map((node) => (node.classList.contains('ho-more') ? (node.children[0] as FakeElement).textContent : node.textContent));
const readyMenu = (page: Page): FakeElement => readyOf(page).querySelector('.ho-menu')!;
const moreOf = (page: Page): FakeElement => readyOf(page).querySelector('[data-homenu]')!;
const crowOf = (page: Page): FakeElement => page.$('composer').querySelector('.crow')!;

// The hand-over (SF-073) in the composer: a handed-over job's hand-over panel (SF-107) and a ready
// one the hand-over skipped, each action posted at once.
test('job client (SF-073): a handed-over job says "In your checkout on <branch>" and shows its hand-over panel; a ready one with handoff_skipped offers Hand over to my checkout with the skip message', async () => {
  const handed = handedOver();
  const page = await openJob(detail(handed, { mr: true, mr_title: 'feat(T-1): Demo' } as Partial<Omit<Detail, 'job'>>));
  const acts = (): FakeElement[] => page.$('acts').children as FakeElement[];
  const posted = (action: string): FetchRequest[] => page.requests.filter((request) => request.method === 'POST' && request.path === `api/jobs/app/T-1/${action}`);
  assert.equal(facts(page)[0], 'In your checkout on T-1-demo');
  // Only the bold sentence stays above the panel; the bar's row is empty.
  assert.deepEqual(texts(page.$('composer-sentence')), ['In your checkout on T-1-demo.']);
  assert.deepEqual([acts().length, page.$('msg').disabled, panelOf(page).contains(page.$('msg'))], [0, false, true]);
  // The card on the board says where the job is.
  assert.notEqual(page.$('list-you').all().find((node) => node.className === 'reason ready' && node.textContent === 'In your checkout on T-1-demo'), undefined);

  // Take it back (in More) goes at once.
  inPanel(page, 'More ▾').click();
  inPanel(page, 'Take it back').click();
  await page.flush();
  assert.deepEqual(posted('takeback').map((request) => request.body), ['{}']);
  posted('takeback')[0]!.respond(200, { ok: true, result: { state: 'ready_for_human_review', branch: 'T-1-demo', worktree: '/wt/T-1' } });
  await page.flush();
  assert.match(page.$('action-status').textContent, /^Taken back: /);

  // Ready for review, not handed over: the skip message and Hand over to my checkout.
  const skipped = job('ready_for_human_review', { worktree: '/wt/T-1', handoff_skipped: { code: 'checkout_dirty', message: 'T-1: ready, but your checkout has changes; hand it over when you are ready' }, handover: null, mr_host: { host: 'github', reason: null } });
  page.streams.at(-1)!.emit('jobs', { jobs: [skipped] });
  await show(page, detail(skipped));
  const note = page.$('composer-sentence').children[1] as FakeElement;
  assert.deepEqual([note.textContent, note.className], ['Not handed over to your checkout: T-1: ready, but your checkout has changes; hand it over when you are ready', 'muted ready-note']);
  // The workspace does not hand over: Review the MR and push leads the ready panel's row, Hand over is in More.
  assert.deepEqual(rowLabels(page), ['Review the MR and push', 'Ask for a change', 'More ▾', 'Abort…']);
  assert.equal(page.$('handover-button').getAttribute('role'), 'menuitem');
  page.$('handover-button').click();
  await page.flush();
  assert.deepEqual(posted('handover').map((request) => request.body), ['{}']);
});

test('job client (SF-107): a handed-over job shows the hand-over panel: the heading with More, the facts, the two paths and Ask for changes, in place of the button row', async () => {
  const ledger = [entry('R4', 'accepted_risk'), entry('S1', 'accepted_risk', 'simplify'), entry('R5', 'open')];
  const page = await openJob({ ...detail(handedOver(), { iterations: [iteration(1, { files: FILE_CHANGES })] }), ledger } as unknown as Detail);
  const composer = page.$('composer');
  const panel = panelOf(page);
  // The panel right after #confirm; .crow hidden and #acts empty; #msg and #action-status inside it.
  assert.equal(composer.children.indexOf(panel), composer.children.indexOf(page.$('confirm')) + 1);
  assert.deepEqual([composer.querySelector('.crow')!.hidden, (page.$('acts').children as FakeElement[]).length], [true, 0]);
  assert.deepEqual([panel.contains(page.$('msg')), panel.contains(page.$('action-status')), page.$('action-status').getAttribute('role')], [true, true, 'status']);
  const top = panel.querySelector('.ho-top')!;
  // The heading and More ▾, its menu closed.
  assert.deepEqual(texts(top.querySelector('.ho-head')!), ['It is in your checkout. How do you finish it?', inPanel(page, 'More ▾').parentNode!.textContent]);
  assert.deepEqual([inPanel(page, 'More ▾').getAttribute('aria-expanded'), menuOf(page).hidden, menuOf(page).getAttribute('role')], ['false', true, 'menu']);
  // The facts: the branch, since when (local time), the last iteration's files and lines, the accepted risks (no simplification).
  assert.deepEqual(texts(top.querySelector('.ho-facts')!), ['T-1-demo', 'In your checkout since 12:06', '2 files, +5 −1 as Local Changes', 'Accepted risks:R4']);
  const chips = top.querySelectorAll('.ho-chip');
  assert.deepEqual(chips.map((chip) => [chip.textContent, chip.getAttribute('title'), chip.tagName]), [['R4', 'Problem of R4.', 'SPAN']]);
  // The two paths, each with its steps and its primary button.
  const paths = top.querySelectorAll('.ho-path');
  assert.deepEqual(paths.map((path) => [path.children[0]!.textContent, texts(path.children[1] as FakeElement), path.children[2]!.textContent, (path.children[2] as FakeElement).className]), [
    ['I push it myself', ['Review and run it in the IDE.', 'Commit (the message is prefilled with the MR text) and push.', 'Open the MR on the forge.'], 'I opened the MR', 'btn primary'],
    ['The factory pushes it', ['Review it in the IDE.', 'The factory pushes its commit (or your own commits, if you committed); your uncommitted edits stay in your checkout and are not pushed.', 'Then it opens the MR.'],
      'Push and open the MR…', 'btn primary'],
  ]);
  // Ask for changes: the moved #msg with its placeholder, the button and its line.
  const ask = panel.querySelector('.ho-ask')!;
  assert.equal(ask.children[0], page.$('msg'));
  assert.equal((page.$('msg') as unknown as { placeholder: string }).placeholder, 'What should the Implementer change? Your edits in the checkout go with the message.');
  assert.deepEqual(texts(ask.querySelector('.ho-askrow')!), ['Ask for changes', 'Quick fix', 'Ask for changes: the full loop. Quick fix: one turn and the checks, no review while the change stays small.']);
  // No muted SF-073 sentence and none of the old row's buttons.
  assert.deepEqual(texts(page.$('composer-sentence')), ['In your checkout on T-1-demo.']);
  for (const label of ['Approve…', 'I opened the MR myself', 'Create merge request', 'Abort…']) {
    assert.equal(page.$('composer').all().some((node) => node.tagName === 'BUTTON' && node.textContent === label), false, label);
  }

  // No accepted risk: no "Accepted risks"; a last iteration without a file list: no files fact.
  await show(page, { ...detail(handedOver(), { iterations: [iteration(1, { files: FILE_CHANGES }), iteration(2, { files: null })] }), ledger: [entry('S1', 'accepted_risk', 'simplify')] } as unknown as Detail);
  assert.deepEqual(texts(panelOf(page).querySelector('.ho-facts')!), ['T-1-demo', 'In your checkout since 12:06']);
  // Without an iteration either.
  await show(page, detail(handedOver()));
  assert.deepEqual(texts(panelOf(page).querySelector('.ho-facts')!), ['T-1-demo', 'In your checkout since 12:06']);
});

test('job client (SF-107): the panel\'s actions: I opened the MR posts handed-done; Push and open the MR… or Push… opens the existing confirmation; Ask for changes sends say; More holds Take it back and Abort', async () => {
  const page = await openJob(detail(handedOver(), { mr: true, mr_title: 'feat(T-1): Demo' } as Partial<Omit<Detail, 'job'>>));
  // I opened the MR posts handed-done at once; while it is out its button is off with the reason.
  inPanel(page, 'I opened the MR').click();
  await page.flush();
  assert.deepEqual(posts(page, 'handed-done').map((request) => request.body), ['{}']);
  assert.deepEqual([inPanel(page, 'I opened the MR').disabled, inPanel(page, 'I opened the MR').getAttribute('title')], [true, 'origin is being asked for your push.']);
  posts(page, 'handed-done')[0]!.respond(200, { ok: true, result: { state: 'handed_over', branch: 'T-1-demo', error: { code: 'branch_not_pushed', message: 'origin has no T-1-demo.' } } });
  await page.flush();

  // With an MR host: Push and open the MR… opens mr-create's confirmation; nothing is posted before Confirm.
  inPanel(page, 'Push and open the MR…').click();
  assert.deepEqual([page.$('confirm').hidden, page.$('confirm-title').textContent, page.$('confirm-ok').textContent], [false, 'Create merge request app/T-1?', 'Create the merge request']);
  assert.match(page.$('confirm-text').textContent, /^Pushes branch T-1-demo to origin as Approve does, then opens a merge request on GitHub/);
  // An open confirmation turns the panel's buttons off, as the bar's.
  assert.deepEqual([inPanel(page, 'I opened the MR').disabled, inPanel(page, 'I opened the MR').getAttribute('title')], [true, 'a confirmation is open: confirm or cancel it first.']);
  page.$('confirm-ok').click();
  await page.flush();
  assert.deepEqual(posts(page, 'mr-create').map((request) => request.body), ['{}']);
  posts(page, 'mr-create')[0]!.respond(200, { ok: true, result: { state: 'handed_over', branch: 'T-1-demo', error: { code: 'push_failed', message: 'offline' } } });
  await page.flush();

  // Without one: Push… opens approve's confirmation; path B does not open an MR.
  const off = handedOver({ mr_host: { host: 'github', reason: 'SF_GITHUB_TOKEN is not set' } });
  page.streams.at(-1)!.emit('jobs', { jobs: [off] });
  await show(page, detail(off));
  const pathB = panelOf(page).querySelectorAll('.ho-path')[1]!;
  assert.deepEqual([texts(pathB.children[1] as FakeElement).length, pathB.children[2]!.textContent], [2, 'Push…']);
  inPanel(page, 'Push…').click();
  assert.deepEqual([page.$('confirm-title').textContent, page.$('confirm-ok').textContent], ['Approve app/T-1?', 'Approve: push the branch']);
  assert.match(page.$('confirm-text').textContent, /^Pushes branch T-1-demo to origin from your checkout/);
  page.$('confirm-cancel').click();
  assert.equal(posts(page, 'approve').length, 0);

  // Ask for changes: off for an empty or blank box; it sends say with the text.
  assert.deepEqual([inPanel(page, 'Ask for changes').disabled, inPanel(page, 'Ask for changes').getAttribute('title')], [true, 'write a message first.']);
  typeMessage(page, '   ');
  assert.equal(inPanel(page, 'Ask for changes').disabled, true);
  typeMessage(page, 'Rename the helper.');
  assert.equal(inPanel(page, 'Ask for changes').disabled, false);
  inPanel(page, 'Ask for changes').click();
  await page.flush();
  assert.deepEqual(posts(page, 'say').map((request) => request.body), ['{"message":"Rename the helper."}']);
  posts(page, 'say')[0]!.respond(200, { ok: true, result: { state: 'working' } });
  await page.flush();

  // More ▾: opens on a click with the focus on Take it back; the arrows move between its items.
  inPanel(page, 'More ▾').click();
  assert.deepEqual([menuOf(page).hidden, inPanel(page, 'More ▾').getAttribute('aria-expanded'), page.document.activeElement?.textContent.startsWith('Take it back')], [false, 'true', true]);
  assert.deepEqual(menuOf(page).children.map((node) => [(node as FakeElement).getAttribute('role'), (node as FakeElement).className]),
    [['menuitem', 'ho-item'], ['menuitem', 'ho-item'], ['separator', 'ho-sep'], ['menuitem', 'ho-item danger']]);
  const focused = (): string => page.document.activeElement?.textContent ?? '';
  page.key('ArrowDown');
  assert.equal(focused(), 'Refresh MR status');
  page.key('ArrowDown');
  assert.equal(focused(), 'Abort the job…');
  page.key('ArrowDown');
  assert.equal(focused().startsWith('Take it back'), true);
  page.key('ArrowUp');
  assert.equal(focused(), 'Abort the job…');
  // A click outside closes it.
  page.$('composer-sentence').click();
  assert.equal(menuOf(page).hidden, true);
  // Abort the job… opens Abort's confirmation and closes the menu.
  inPanel(page, 'More ▾').click();
  inPanel(page, 'Abort the job…').click();
  assert.deepEqual([menuOf(page).hidden, page.$('confirm-title').textContent], [true, 'Abort app/T-1?']);
  page.$('confirm-ok').click();
  await page.flush();
  assert.deepEqual(posts(page, 'abort').map((request) => request.body), ['{"discard":false}']);
  posts(page, 'abort')[0]!.respond(200, { ok: true, result: { state: 'aborted', branch: 'T-1-demo', discarded: false } });
  await page.flush();
  // Take it back posts takeback and closes the menu.
  inPanel(page, 'More ▾').click();
  inPanel(page, 'Take it back').click();
  await page.flush();
  assert.deepEqual([menuOf(page).hidden, posts(page, 'takeback').map((request) => request.body)], [true, ['{}']]);
});

test('job client (SF-200): More\'s Refresh MR status on a handed-over job without a record posts mr-status; none found says so alone; one found by the branch shows its line and the host\'s status; a later read by number shows the status only', async () => {
  const page = await openJob(detail(handedOver(), { mr: true, mr_title: 'feat(T-1): Demo' } as Partial<Omit<Detail, 'job'>>));
  assert.equal(page.document.getElementById('mr-status-line'), null);
  inPanel(page, 'More ▾').click();
  inPanel(page, 'Refresh MR status').click();
  await page.flush();
  assert.deepEqual(posts(page, 'mr-status').map((request) => request.body), ['{}']);
  posts(page, 'mr-status')[0]!.respond(200, { ok: true, result: { state: 'handed_over', branch: 'T-1-demo', mr: null, found: { count: 0 } } });
  await page.flush();
  assert.equal(page.$('mr-status-line').textContent, 'No open merge request for branch T-1-demo.');
  assert.equal(page.document.getElementById('mr-line'), null);

  inPanel(page, 'More ▾').click();
  inPanel(page, 'Refresh MR status').click();
  await page.flush();
  const mr = { host: 'github', number: 7, url: 'https://github.com/o/r/pull/7', state: 'open' };
  const status = { number: 7, url: mr.url, state: 'open', draft: false, mergeable: false, reason: 'its pipeline is still running', checks: 'pipeline running' };
  posts(page, 'mr-status')[1]!.respond(200, { ok: true, result: { state: 'handed_over', branch: 'T-1-demo', mr, status, found: { count: 2 } } });
  await page.flush();
  // The refresh reads the job again; it now has the record.
  const recorded = handedOver({ mr });
  page.streams.at(-1)!.emit('jobs', { jobs: [recorded] });
  await show(page, detail(recorded, { mr: true, mr_title: 'feat(T-1): Demo' } as Partial<Omit<Detail, 'job'>>));
  assert.equal(page.$('mr-line').textContent, 'Merge request #7 (open): https://github.com/o/r/pull/7');
  assert.equal(page.$('mr-status-line').textContent,
    'Found by branch T-1-demo (newest of 2 open). On the host: #7 open, not mergeable: its pipeline is still running, checks: pipeline running.');

  inPanel(page, 'More ▾').click();
  inPanel(page, 'Refresh MR status').click();
  await page.flush();
  posts(page, 'mr-status')[2]!.respond(200, { ok: true, result: { state: 'handed_over', branch: 'T-1-demo', mr, status: { ...status, mergeable: true, reason: undefined, checks: 'pipeline success' } } });
  await page.flush();
  page.streams.at(-1)!.emit('jobs', { jobs: [recorded] });
  await show(page, detail(recorded, { mr: true, mr_title: 'feat(T-1): Demo' } as Partial<Omit<Detail, 'job'>>));
  assert.equal(page.$('mr-status-line').textContent, 'On the host: #7 open, mergeable, checks: pipeline success.');
});

test('job client: the panel\'s Merged — archive is confirmed in place: a first click arms it (no dialog, nothing posted), a second posts merged-archive once and the outcome says the job left the board; a pushed job\'s row has it before Archive', async () => {
  const page = await openJob(detail(handedOver(), { mr: true, mr_title: 'feat(T-1): Demo' } as Partial<Omit<Detail, 'job'>>));
  const path = panelOf(page).querySelectorAll('.ho-path')[0]!;
  assert.deepEqual(path.querySelectorAll('button').map((node) => node.textContent), ['I opened the MR', 'Merged — archive']);
  const merged = page.$('merged-archive-button');
  assert.deepEqual([merged.className, merged.getAttribute('title')], ['btn', 'Marks the job merged and archives it: the worktree is removed and the Task file archived; no branch is checked or deleted. Click twice.']);
  merged.click();
  await page.flush();
  assert.deepEqual([page.$('merged-archive-button').textContent, page.$('merged-archive-button').className, page.$('confirm').hidden], ['Click again to archive', 'btn primary', true]);
  assert.equal(posts(page, 'merged-archive').length, 0);
  page.$('merged-archive-button').click();
  await page.flush();
  assert.deepEqual(posts(page, 'merged-archive').map((request) => request.body), ['{}']);
  assert.equal(page.$('merged-archive-button').textContent, 'Merged — archive');
  posts(page, 'merged-archive')[0]!.respond(200, { ok: true, result: { state: 'pushed', branch: 'T-1-demo', archived: 'jobs/app/T-1.20261113T100000Z' } });
  await page.flush();
  assert.match(page.document.body.textContent, /Merged and archived: the job left the board \(its history is in jobs\/app\/T-1\.20261113T100000Z\); the branch T-1-demo is untouched\./);

  const pushed = await openJob(detail(job('pushed', { prepared_commit: 'a'.repeat(40), worktree: null })));
  const row = pushed.$('acts').querySelectorAll('button').map((node) => node.textContent);
  assert.deepEqual(row.slice(row.indexOf('Merged — archive')), ['Merged — archive', 'Archive']);
  pushed.$('merged-archive-button').click();
  await pushed.flush();
  assert.equal(pushed.$('merged-archive-button').textContent, 'Click again to archive');
  assert.equal(pushed.tick(4000), 1);
  await pushed.flush();
  assert.equal(pushed.$('merged-archive-button').textContent, 'Merged — archive');
  assert.equal(posts(pushed, 'merged-archive').length, 0);
});

test('job client (SF-107): an outcome from before the hand-over is the "Earlier, at …" note and Dismiss hides it for good; an action on the panel shows as current, with a ×', async () => {
  const ready = job('ready_for_human_review', { worktree: '/wt/T-1', handover: null, handoff_skipped: null, mr_host: { host: 'github', reason: null } });
  const current = detail(ready);
  const page = await openJob(current);
  typeMessage(page, 'One more test.');
  page.$('say-button').click();
  await page.flush();
  posts(page, 'say')[0]!.respond(200, { ok: true, result: { state: 'working' } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'Sent: the Implementer is working on it (state working).');

  // Handed over after it: the outcome is a muted note, not the current line.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const handed = handedOver({ handover: { ...HANDOVER, at: new Date().toISOString() } });
  current.job = handed;
  page.streams.at(-1)!.emit('jobs', { jobs: [handed] });
  await show(page, current);
  const status = page.$('action-status');
  assert.equal(panelOf(page).contains(status), true);
  assert.equal(status.className, 'status earlier');
  assert.match(status.textContent, /^Earlier, at \d\d:\d\d \(before the hand-over\): Sent: the Implementer is working on it \(state working\)\.Dismiss$/);
  (status.querySelector('button') as FakeElement).click();
  assert.deepEqual([status.textContent, status.className], ['', 'status']);
  // It does not come back with the next event.
  await show(page, current);
  assert.equal(page.$('action-status').textContent, '');

  // An action taken on the panel: its outcome is current, with a × that dismisses it.
  inPanel(page, 'I opened the MR').click();
  await page.flush();
  assert.equal(page.$('action-status').className, 'status pending dismissable');
  posts(page, 'handed-done')[0]!.respond(200, { ok: true, result: { state: 'handed_over', branch: 'T-1-demo', error: { code: 'branch_not_pushed', message: 'origin has no T-1-demo.' } } });
  await page.flush();
  assert.equal(page.$('action-status').className, 'status ok dismissable');
  assert.match(page.$('action-status').textContent, /^Pushed by you: T-1-demo is on origin; the job is handed_over\.×$/);
  const close = page.$('action-status').querySelector('button')!;
  assert.deepEqual([close.textContent, close.getAttribute('aria-label')], ['×', 'Dismiss']);
  close.click();
  assert.equal(page.$('action-status').textContent, '');

  // Another state: the outcome line exactly as before (no ×, no note), #msg and #action-status back in place.
  const back = job('ready_for_human_review', { worktree: '/wt/T-1', handover: null, handoff_skipped: null, mr_host: { host: 'github', reason: null } });
  current.job = back;
  page.streams.at(-1)!.emit('jobs', { jobs: [back] });
  await show(page, current);
  const composer = page.$('composer');
  const crow = composer.querySelector('.crow')!;
  assert.equal(page.document.getElementById('handover-panel'), null);
  // A ready job: .crow hidden until Ask for a change.
  assert.equal(crow.hidden, true);
  page.$('ask-button').click();
  assert.deepEqual([crow.hidden, crow.children.indexOf(page.$('msg')), crow.children.indexOf(page.$('acts'))], [false, 0, 1]);
  assert.equal(composer.children.indexOf(page.$('action-status')), composer.children.indexOf(crow) + 1);
  assert.equal((composer.children[composer.children.indexOf(crow) + 2] as FakeElement).className, 'doubt');
  typeMessage(page, 'And one more.');
  page.$('say-button').click();
  await page.flush();
  posts(page, 'say')[1]!.respond(200, { ok: true, result: { state: 'working' } });
  await page.flush();
  assert.deepEqual([page.$('action-status').className, page.$('action-status').children.length], ['status ok', 1]);
});

test('job client (SF-107): Escape with the More menu open closes it only: the job page stays and the focus is on More', async () => {
  const page = await openJob(detail(handedOver()));
  inPanel(page, 'More ▾').click();
  assert.equal(menuOf(page).hidden, false);
  page.key('Escape');
  assert.deepEqual([menuOf(page).hidden, page.$('job').hidden, page.location.hash], [true, false, '#app/T-1']);
  assert.equal(page.document.activeElement, inPanel(page, 'More ▾'));
  assert.equal(inPanel(page, 'More ▾').getAttribute('aria-expanded'), 'false');
  // The next Escape goes back as before.
  page.key('Escape');
  assert.equal(page.$('job').hidden, true);
});

test('job client (SF-107): a handed-over job with an error shows its code and message at the top of the panel, above the heading', async () => {
  const page = await openJob(detail(handedOver({ error: { code: 'handover_restore_failed', message: 'git checkout main failed.' } })));
  const top = panelOf(page).querySelector('.ho-top')!;
  assert.deepEqual([(top.children[0] as FakeElement).className, top.children[0]!.textContent], ['ho-error', 'handover_restore_failed: git checkout main failed.']);
  assert.equal((top.children[1] as FakeElement).className, 'ho-head');
  assert.deepEqual(texts(page.$('composer-sentence')), ['In your checkout on T-1-demo.']);
});

// The ready panel (SF-286): a job ready for review, its workspace not handing over unless said.
const readyJob = (extra: Record<string, unknown> = {}) => job('ready_for_human_review', { worktree: '/wt/T-1', mr_host: { host: 'github', reason: null }, ...extra });

test('job client (SF-286): a ready job shows the chip and the ready panel in place of the box and the row; Ask for a change opens the box with Send and closes it, the draft and its state kept per job; another state takes the panel away', async () => {
  const other = { ...job('working'), ticket: 'T-2', branch: 'T-2-demo', title: 'Other' };
  const page = await openJob(detail(readyJob(), { mr: true }), () => undefined, undefined, [other]);
  // The chip and its line in place of the bold sentence; no hand-over note without handoff_skipped.
  const status = page.$('composer-sentence').children[0] as FakeElement;
  assert.deepEqual([status.className, texts(status)], ['ready-status', ['Ready to push', 'Reviews are clean and the MR text is written.']]);
  assert.equal(page.$('composer-sentence').querySelector('.ready-note'), null);
  // The panel right after #confirm; the row's primary first, Abort… last; .crow hidden with Send and Quick fix alone in #acts.
  const composer = page.$('composer');
  const panel = readyOf(page);
  assert.equal(composer.children.indexOf(panel), composer.children.indexOf(page.$('confirm')) + 1);
  assert.deepEqual([panel.getAttribute('role'), panel.getAttribute('aria-label'), panel.dataset.key], ['group', 'Ready to push', 'app/T-1']);
  assert.deepEqual(rowLabels(page), ['Review the MR and push', 'Ask for a change', 'More ▾', 'Abort…']);
  assert.deepEqual(panel.all().filter((node) => node.classList.contains('primary')).map((node) => node.id), ['review-mr-button']);
  assert.equal(page.$('abort-button').className, 'btn danger rd-abort');
  assert.deepEqual([crowOf(page).hidden, texts(page.$('acts'))], [true, ['Send', 'Quick fix']]);

  // Ask for a change opens .crow with the focus in the box; Send is off while it is empty.
  assert.equal(page.$('ask-button').getAttribute('aria-expanded'), 'false');
  page.$('ask-button').click();
  assert.deepEqual([crowOf(page).hidden, page.$('ask-button').getAttribute('aria-expanded'), page.document.activeElement], [false, 'true', page.$('msg')]);
  assert.deepEqual([page.$('say-button').disabled, page.$('say-button').getAttribute('title')], [true, 'write a message first.']);
  typeMessage(page, 'Rename the helper.');
  // Again: closed, the focus back on it, the draft kept.
  page.$('ask-button').click();
  assert.deepEqual([crowOf(page).hidden, page.$('ask-button').getAttribute('aria-expanded'), page.document.activeElement], [true, 'false', page.$('ask-button')]);
  page.$('ask-button').click();
  assert.equal(page.$('msg').value, 'Rename the helper.');

  // Another job and back: the box open again, with its draft.
  page.location.hash = '#app/T-2';
  page.window.dispatch('hashchange');
  await page.flush();
  page.streams.at(-1)!.emit('job', detail(other as Job));
  await page.flush();
  assert.deepEqual([page.document.getElementById('ready-panel'), crowOf(page).hidden], [null, false]);
  page.location.hash = '#app/T-1';
  page.window.dispatch('hashchange');
  await page.flush();
  page.streams.at(-1)!.emit('job', detail(readyJob(), { mr: true }));
  await page.flush();
  assert.deepEqual([crowOf(page).hidden, page.$('ask-button').getAttribute('aria-expanded'), page.$('msg').value], [false, 'true', 'Rename the helper.']);
  // Send posts the message as before.
  page.$('say-button').click();
  await page.flush();
  assert.deepEqual(posts(page, 'say').map((request) => request.body), ['{"message":"Rename the helper."}']);
  posts(page, 'say')[0]!.respond(200, { ok: true, result: { state: 'working' } });
  await page.flush();

  // Another state: no panel; .crow shown with #msg and #acts in place.
  await show(page, detail(job('working')));
  assert.equal(page.document.getElementById('ready-panel'), null);
  assert.deepEqual([crowOf(page).hidden, crowOf(page).children.indexOf(page.$('msg')), crowOf(page).children.indexOf(page.$('acts'))], [false, 0, 1]);
  assert.deepEqual(texts(page.$('acts')), ['Send', 'Pause', 'Abort…']);
  assert.equal((page.$('composer-sentence').children[0] as FakeElement).tagName, 'B');
  // Ready again: Ask for a change comes back closed.
  await show(page, detail(readyJob(), { mr: true }));
  assert.deepEqual([crowOf(page).hidden, page.$('ask-button').getAttribute('aria-expanded')], [true, 'false']);
});

test('job client (SF-286): with the hand-over on, Hand over to my checkout leads the row; More ▾ holds the rest with their second lines, moves with the arrows, closes on Escape, a click outside and a choice; each item runs its action as before', async () => {
  const shown = detail(readyJob(), { mr: true });
  shown.job = served(readyJob(), { handsOver: true });
  const page = await openJob(shown);
  assert.deepEqual(rowLabels(page), ['Hand over to my checkout', 'Ask for a change', 'More ▾', 'Abort…']);
  assert.equal(page.$('handover-button').className, 'btn primary');
  const more = moreOf(page);
  assert.deepEqual([more.className, more.getAttribute('aria-haspopup'), more.getAttribute('aria-expanded'), readyMenu(page).hidden], ['btn', 'menu', 'false', true]);
  more.click();
  assert.deepEqual([readyMenu(page).hidden, moreOf(page).getAttribute('aria-expanded')], [false, 'true']);
  const items = (): FakeElement[] => readyMenu(page).children as FakeElement[];
  assert.deepEqual(items().map((node) => [node.getAttribute('role'), node.textContent]), [
    ['menuitem', 'Review the MR and pushPush from here instead of your checkout.'],
    ['menuitem', 'Approve without review…Push the prepared branch, without the Merge request screen.'],
    ['menuitem', 'Create merge request'],
    ['separator', ''],
    ['menuitem', 'Refresh MR status'],
  ]);
  assert.equal(page.document.activeElement, items()[0]);
  page.key('ArrowDown');
  assert.equal(page.document.activeElement, items()[1]);
  page.key('ArrowUp');
  page.key('ArrowUp');
  assert.equal(page.document.activeElement, items()[4]);
  // Escape closes the menu only: the page stays, the focus on More ▾.
  page.key('Escape');
  assert.deepEqual([readyMenu(page).hidden, page.$('job').hidden, page.document.activeElement, moreOf(page).getAttribute('aria-expanded')], [true, false, moreOf(page), 'false']);
  // A click outside closes it.
  moreOf(page).click();
  page.$('composer-sentence').click();
  assert.equal(readyMenu(page).hidden, true);

  // Approve without review… opens the approve confirmation and closes the menu; while it is open the
  // row's and the menu's actions are off with the reason, Ask for a change and More ▾ aside.
  moreOf(page).click();
  page.$('approve-button').click();
  assert.deepEqual([readyMenu(page).hidden, page.$('confirm-title').textContent, page.$('confirm-ok').textContent], [true, 'Approve app/T-1?', 'Approve: push the branch']);
  const actions = readyOf(page).all().filter((node) => node.tagName === 'BUTTON' && node.dataset.act !== undefined && node.dataset.act !== 'ask');
  assert.deepEqual([...new Set(actions.map((node) => `${node.disabled} ${node.getAttribute('title')}`))], ['true a confirmation is open: confirm or cancel it first.']);
  assert.equal(actions.length, 6);
  assert.deepEqual([page.$('ask-button').disabled, moreOf(page).disabled], [false, false]);
  // An item that is off says why as its second line.
  moreOf(page).click();
  assert.equal(page.$('mr-create-button').textContent, 'Create merge requesta confirmation is open: confirm or cancel it first.');
  page.key('Escape');
  page.$('confirm-cancel').click();
  // Create merge request opens its confirmation.
  page.$('mr-create-button').click();
  assert.equal(page.$('confirm-title').textContent, 'Create merge request app/T-1?');
  page.$('confirm-cancel').click();
  // Refresh MR status and Hand over post at once.
  moreOf(page).click();
  page.$('mr-status-button').click();
  await page.flush();
  assert.deepEqual([readyMenu(page).hidden, posts(page, 'mr-status').length], [true, 1]);
  page.$('handover-button').click();
  await page.flush();
  assert.deepEqual(posts(page, 'handover').map((request) => request.body), ['{}']);
  // Abort… its confirmation.
  page.$('abort-button').click();
  assert.equal(page.$('confirm-title').textContent, 'Abort app/T-1?');
  page.$('confirm-cancel').click();
  // Review the MR and push opens the Merge request screen.
  moreOf(page).click();
  page.$('review-mr-button').click();
  await page.flush();
  assert.deepEqual([readyMenu(page).hidden, page.location.hash], [true, '#app/T-1/mr']);
});

test('job client (SF-286): a ready panel\'s item that is off says why under its label: Create merge request without a token', async () => {
  const page = await openJob(detail(readyJob({ mr_host: { host: 'github', reason: 'SF_GITHUB_TOKEN is not set' } })));
  const create = page.$('mr-create-button');
  assert.deepEqual([create.disabled, create.textContent, create.querySelector('.muted')!.textContent], [true, 'Create merge requestSF_GITHUB_TOKEN is not set.', 'SF_GITHUB_TOKEN is not set.']);
  // Without the MR text, Review the MR and push (the primary here) is off with its reason as its title.
  assert.deepEqual([page.$('review-mr-button').disabled, page.$('review-mr-button').getAttribute('title')], [true, 'no MR text yet: written at Clean.']);
});

test('job client (SF-072): a job waiting for limits offers Resume now and Abort…; from a turn Resume now carries the message box\'s text, from a review round none; after a reset under wait it says so', async () => {
  const limit = { provider: 'claude', resets_at: '2026-11-05T01:00:00.000Z' };
  const turn = job('waiting_limit', { iteration: 1, paused: { from: 'working', step: 'turn', at: '2026-11-01T10:04:00.000Z' }, limit });
  const page = await openJob(detail(turn));
  const acts = (): FakeElement[] => page.$('acts').children as FakeElement[];
  const act = (label: string): FakeElement => acts().find((node) => node.textContent === label)!;
  const posted = (): FetchRequest[] => page.requests.filter((request) => request.method === 'POST' && request.path === 'api/jobs/app/T-1/resume');
  const placeholder = (): string => (page.$('msg') as unknown as { placeholder: string }).placeholder;
  assert.deepEqual(facts(page).slice(0, 2), [
    'Waiting for limits: the Claude usage limit resets at 03:00 (iteration 2). The factory resumes it then; Resume now goes on before the reset (with your message, if you write one below)', 'Iteration 2',
  ]);
  assert.equal(page.$('job').className, 'st-waiting_limit');
  assert.deepEqual(acts().map((node) => [node.textContent, node.className]), [['Resume now', 'btn primary'], ['Abort…', 'btn danger']]);
  assert.deepEqual([page.$('msg').disabled, placeholder()], [false, 'Resume now sends this to the Implementer, if you write one']);
  page.$('msg').value = 'Go on with the tests.';
  page.$('msg').dispatch('input');
  act('Resume now').click();
  await page.flush();
  assert.deepEqual(posted().map((request) => request.body), ['{"message":"Go on with the tests."}']);
  posted()[0]!.respond(200, { ok: true, result: { state: 'working', iteration: 1, step: 'turn', task_changed: false } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'Resumed: the Implementer goes on with iteration 2.');

  // Parked in the gate: no message goes with Resume now.
  const gate = job('waiting_limit', { iteration: 1, paused: { from: 'awaiting_review', step: 'gate', at: '2026-11-01T10:04:00.000Z' }, limit: { provider: 'codex', resets_at: '2026-11-05T01:00:00.000Z', reset_seen: true, notified_at: '2026-11-05T01:00:01.000Z' } });
  page.streams.at(-1)!.emit('jobs', { jobs: [gate] });
  await show(page, detail(gate));
  assert.equal(facts(page)[0], 'The Codex usage limit reset during iteration 1; the job waits for you. Resume now goes on');
  assert.deepEqual([page.$('msg').disabled, placeholder()], [true, 'Resume now, then message the Implementer']);
  act('Resume now').click();
  await page.flush();
  assert.equal(posted().at(-1)!.body, '{}');
});

test('job client (SF-087): fetch_failed offers Retry first and posts it once; mr_failed offers Retry before Tell it to go on, not after a conflict turn; mr_push_failed keeps Push again', async () => {
  const fetchFailed = job('needs_human', { error: { code: 'fetch_failed', message: 'git fetch origin main failed.' } });
  const page = await openJob(detail(fetchFailed));
  const acts = (): FakeElement[] => page.$('acts').children as FakeElement[];
  const labels = (): string[] => acts().map((node) => node.textContent);
  const posted = (): FetchRequest[] => page.requests.filter((request) => request.method === 'POST' && request.path === 'api/jobs/app/T-1/retry');
  assert.deepEqual(acts().map((node) => [node.textContent, node.className]), [['Retry', 'btn primary'], ['Abort…', 'btn danger']]);
  acts()[0]!.click();
  acts()[0]!.click();
  await page.flush();
  assert.deepEqual(posted().map((request) => request.body), ['{}']);
  posted()[0]!.respond(200, { ok: true, result: { state: 'preparing_mr', iteration: 1, branch: 'T-1-demo' } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'MR preparation runs again (state preparing_mr).');

  // mr_rebase_failed (an alias of mr_failed): Retry, then Tell it to go on; after a conflict turn no Retry.
  const rebase = job('needs_human', { error: { code: 'mr_rebase_failed', message: 'git rebase failed.' } });
  page.streams.at(-1)!.emit('jobs', { jobs: [rebase] });
  await show(page, detail(rebase));
  assert.deepEqual(labels(), ['Retry', 'Tell it to go on', 'Abort…']);
  const conflicted = job('needs_human', { error: { code: 'mr_failed', message: 'MR preparation failed inside the factory: boom' }, mr_conflict_turn: true });
  page.streams.at(-1)!.emit('jobs', { jobs: [conflicted] });
  await show(page, detail(conflicted));
  assert.deepEqual(labels(), ['Tell it to go on', 'Abort…']);

  // A failed push keeps Push again (Approve), with no Retry.
  const push = job('needs_human', { error: { code: 'mr_push_failed', message: 'git push origin T-1-demo failed: offline' }, prepared_commit: 'a'.repeat(40) });
  page.streams.at(-1)!.emit('jobs', { jobs: [push] });
  await show(page, detail(push));
  assert.deepEqual(labels(), ['Push again', 'Abort…']);
});

// ---------- The plain explanation of the stop (SF-106) ----------

const EXPLAINED = {
  headline: 'Keep your version of the rows, or go back?', explanation: 'You asked for one shared row. The Task file says one row each.',
  choices: [{ choice: 'Keep your version', effect: 'The row stays shared.', recommended: true }, { choice: 'Go back', effect: 'One row each again.', recommended: false }],
  recommendation: 'Keep your version: you asked for it last.',
};

test('job client (SF-106): a matching explanation is a box above the stop panel with Recommended and the model and cost; the technical content is under Details; pending says Explaining…; an error, another stop\'s or none leaves today\'s panel', async () => {
  const row = job('needs_human', { error: { code: 'escalated', message: 'The Implementer escalated R1.' }, stop: { items: [{}], saves_lines: null } });
  const ledger = [{
    id: 'R1', iteration: 1, reviewer: 'claude', severity: 'major', path: 'README.md', problem: 'Problem of R1.', expected: 'Better.', status: 'escalated',
    response: 'Which row?', evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null,
  }];
  const record = (extra: Record<string, unknown> = {}) => ({
    stop: { at: row.updated_at, code: 'escalated' }, model: 'sonnet', language: 'English', started_at: row.updated_at, ended_at: '2026-11-01T10:06:00.000Z',
    cost_usd: 0.0123, output: EXPLAINED, error: null, ...extra,
  });
  const entries = [{ k: '0', ts: '2026-11-01T10:05:00.000Z', it: 1, who: 'factory', t: 'state', from: 'working', to: 'needs_human', code: 'escalated', msg: 'x' }];
  const pageOf = (explanation: unknown): Promise<Page> => openJob({ ...detail(row), ledger, explanation } as unknown as Detail,
    (path) => (/\/stream\?from=0$/.test(path) ? { entries, next: 1, end: true } : undefined));
  const blockOf = (page: Page): FakeElement => page.$('stopblock');
  const parts = (page: Page): string[] => texts(blockOf(page));

  // Today's panel: the head, the sentence and the entries to settle.
  const today = await pageOf(null);
  const panel = parts(today);
  assert.equal(panel.length, 3);
  assert.equal(blockOf(today).all().filter((node) => node.className === 'explain').length, 0);
  for (const other of [record({ output: null, error: 'Overloaded.' }), record({ stop: { at: '2026-11-01T10:00:00.000Z', code: 'escalated' } }), record({ stop: { at: row.updated_at, code: 'review_churn' } })]) {
    const page = await pageOf(other);
    assert.deepEqual(parts(page), panel, JSON.stringify(other.stop));
    assert.equal(blockOf(page).all().filter((node) => node.className === 'explain').length, 0);
  }

  // Pending: Explaining… above today's content, not collapsed.
  const pending = await pageOf(record({ ended_at: null, output: null, cost_usd: null }));
  assert.deepEqual(parts(pending), [panel[0]!, 'Explaining…', ...panel.slice(1)]);
  assert.equal((blockOf(pending).children[1] as FakeElement).className, 'explain');

  // Written: the box, then Details; the technical content collapsed.
  const page = await pageOf(record());
  const box = blockOf(page).children[1] as FakeElement;
  assert.equal(box.className, 'explain');
  assert.deepEqual(texts(box), [
    EXPLAINED.headline, EXPLAINED.explanation, 'Keep your versionRecommendedThe row stays shared.Go backOne row each again.', EXPLAINED.recommendation, 'Explained by sonnet · $0.01',
  ]);
  assert.equal((box.children[0] as FakeElement).tagName, 'B');
  const items = (box.children[2] as FakeElement).children as FakeElement[];
  assert.deepEqual(items.map((item) => item.all().filter((node) => node.textContent === 'Recommended').length), [1, 0]);
  assert.deepEqual(parts(page), [panel[0]!, box.textContent, 'Details']);
  assert.equal(blockOf(page).all().some((node) => node.textContent === panel[1]), false);
  // Details opens the technical content below the box, as it was, and the raw message (SF-203).
  (blockOf(page).children[2] as FakeElement).click();
  await page.flush();
  assert.deepEqual(parts(page).slice(0, 3), [panel[0]!, box.textContent, 'Hide details']);
  assert.deepEqual(texts(blockOf(page).children[3] as FakeElement), [...panel.slice(1), 'The Implementer escalated R1.']);
});

test('job client (SF-106): an explanation that arrives with a new detail on an open page redraws the stop block: none → pending → written, without a reload', async () => {
  const row = job('needs_human', { error: { code: 'escalated', message: 'The Implementer escalated R1.' }, stop: { items: [{}], saves_lines: null } });
  const ledger = [{
    id: 'R1', iteration: 1, reviewer: 'claude', severity: 'major', path: 'README.md', problem: 'Problem of R1.', expected: 'Better.', status: 'escalated',
    response: 'Which row?', evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null,
  }];
  const pending = {
    stop: { at: row.updated_at, code: 'escalated' }, model: 'sonnet', language: 'English', started_at: row.updated_at, ended_at: null, cost_usd: null, output: null, error: null,
  };
  const entries = [{ k: '0', ts: '2026-11-01T10:05:00.000Z', it: 1, who: 'factory', t: 'state', from: 'working', to: 'needs_human', code: 'escalated', msg: 'x' }];
  const shown = (explanation: unknown) => ({ ...detail(row), ledger, explanation }) as unknown as Detail;
  const page = await openJob(shown(null), (path) => (/\/stream\?from=0$/.test(path) ? { entries, next: 1, end: true } : undefined));
  const parts = (): string[] => texts(page.$('stopblock'));
  const panel = parts();
  assert.equal(panel.length, 3);

  await show(page, shown(pending));
  assert.deepEqual(parts(), [panel[0]!, 'Explaining…', ...panel.slice(1)]);

  await show(page, shown({ ...pending, ended_at: '2026-11-01T10:06:00.000Z', cost_usd: 0.0123, output: EXPLAINED }));
  const box = page.$('stopblock').children[1] as FakeElement;
  assert.equal(box.className, 'explain');
  assert.equal((box.children[0] as FakeElement).textContent, EXPLAINED.headline);
  assert.deepEqual(parts(), [panel[0]!, box.textContent, 'Details']);

  // A failed one after all: today's panel again.
  await show(page, shown({ ...pending, ended_at: '2026-11-01T10:06:00.000Z', error: 'Overloaded.' }));
  assert.deepEqual(parts(), panel);
});

// SF-119: a matchMedia whose matches the test sets (narrow: below 768 px or no hover, the same answer
// for both queries).
const mediaOf = (narrow: boolean) => (query: string) => ({ matches: narrow, media: query, addEventListener: () => undefined });
const whyText = (page: Page): string[] => page.$('acts-why').children.map((line) => line.textContent);

test('job client (SF-119): the reasons line names the disabled buttons with their reason, one line per reason, never Send; empty when nothing is off', async () => {
  const page = await openJob(detail(job('working')));
  const actButtons = () => page.$('acts').children.map((node) => node as FakeElement);
  assert.deepEqual(actButtons().map((node) => node.textContent), ['Send', 'Pause', 'Abort…']);
  // Send is off (the box is empty) and has its reason as its title, but is not named.
  assert.deepEqual([actButtons()[0]!.disabled, whyText(page)], [true, []]);
  actButtons().find((node) => node.textContent === 'Abort…')!.click();
  await page.flush();
  assert.equal(page.$('confirm').hidden, false);
  assert.deepEqual(whyText(page), ['Off: Pause, Abort… (a confirmation is open: confirm or cancel it first.)']);
  page.$('confirm-cancel').click();
  await page.flush();
  assert.deepEqual(whyText(page), []);
  // The reasons line is the composer's last child; the SF-107 order before it stays.
  const children = page.$('composer').children.map((node) => (node as FakeElement).id || (node as FakeElement).className);
  assert.deepEqual(children.slice(-4), ['crow', 'action-status', 'doubt', 'acts-why']);
});

test('job client (SF-119): on a phone or without hover a tap on the workspace chip shows its title in the toast; a control\'s tap shows none; with a mouse none', async () => {
  const phone = await openJob(detail(job('working')), () => undefined, undefined, [], '', { matchMedia: mediaOf(true) });
  phone.$('jhead').querySelector('.t1 .wschip')!.click();
  assert.deepEqual([phone.$('toast').hidden, phone.$('toast-text').textContent], [false, 'Workspace app']);
  phone.key('Escape');
  assert.deepEqual([phone.$('toast').hidden, phone.$('job').hidden], [true, false]);
  // The job's title (cut with an ellipsis on a wide screen) by a tap too.
  phone.$('jhead').querySelector('.t1 .title')!.click();
  assert.equal(phone.$('toast-text').textContent, 'Demo');
  phone.$('toast-close').click();
  // ← Board has a title, but it is a control: its label says it.
  phone.$('jhead').querySelector('[data-back]')!.click();
  assert.equal(phone.$('toast').hidden, true);
  const mouse = await openJob(detail(job('working')), () => undefined, undefined, [], '', { matchMedia: mediaOf(false) });
  mouse.$('jhead').querySelector('.t1 .wschip')!.click();
  assert.equal(mouse.$('toast').hidden, true);
});

test('job client (SF-119): on a phone or without hover the Merge request tab without MR text stays tappable, aria-disabled, and its tap says why and stays on the Stream', async () => {
  const page = await openJob(detail(job('working')), () => undefined, undefined, [], '', { matchMedia: mediaOf(true) });
  const tab = () => page.$('jhead').querySelector('[data-goto="mr"]')!;
  assert.deepEqual([tab().getAttribute('aria-disabled'), tab().disabled, tab().getAttribute('title')], ['true', false, 'No MR text yet: written at Clean']);
  tab().click();
  await page.flush();
  assert.deepEqual([page.$('toast-text').textContent, page.location.hash, page.$('scrStream').hidden, page.$('scrMr').hidden], ['No MR text yet: written at Clean', '#app/T-1', false, true]);
  // With a mouse: disabled, as the switch test says.
  const mouse = await openJob(detail(job('working')), () => undefined, undefined, [], '', { matchMedia: mediaOf(false) });
  assert.equal(mouse.$('jhead').querySelector('[data-goto="mr"]')!.disabled, true);
});

// Back to the planner (SF-208): a job's planner block as plannerOf sends it.
const SUGGESTION = { note: '<b>Keep</b> the button,\nrename it', sha256: 'a'.repeat(64), at: '2026-11-01T10:06:00.000Z' };
const DISCUSS = { message: 'Use the Software Factory connector. Call guide.', url: 'https://chatgpt.com/?q=Use%20the' };
const planned = (state: string, planner: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  job(state, { planner: { owner: 'chatgpt', chat: null, discuss: null, suggestion: null, ...planner }, ...extra });
const posted = (page: Page): Array<[string, unknown]> => page.requests.filter((request) => request.method === 'POST').map((request) => [request.path, JSON.parse(request.body!)]);
const links = (node: FakeElement): Array<[string, string, string, string]> => node.querySelectorAll('a').map((link) => [link.textContent, link.href, link.target, link.rel]);

test('job client: the planner block shows the planner\'s note as plain text with Send (the shown sha256) and Dismiss, their outcomes in the status line; Discuss the result and Open the planning chat open new tabs', async () => {
  const shown = planned('needs_human', { chat: 'https://chatgpt.com/c/abc', discuss: DISCUSS, suggestion: SUGGESTION }, { error: { code: 'iteration_limit', message: 'Three Fix sections.' } });
  const page = await openJob(detail(shown));
  const block = page.$('planner');
  assert.equal(block.hidden, false);
  // Right after the composer's sentence.
  const composer = page.$('composer').children as FakeElement[];
  assert.equal(composer[composer.indexOf(page.$('composer-sentence')) + 1], block);
  const box = page.$('planner-suggestion');
  assert.equal((box.children[0] as FakeElement).textContent, 'Planner suggests changes');
  const note = box.querySelector('.planner-note')!;
  // The note as text: no element of it, never HTML.
  assert.deepEqual([note.textContent, note.children.every((child) => (child as FakeElement).tagName === undefined)], [SUGGESTION.note, true]);
  assert.deepEqual(links(block), [
    ['Discuss the result ↗', DISCUSS.url, '_blank', 'noopener noreferrer'],
    ['Open the planning chat ↗', 'https://chatgpt.com/c/abc', '_blank', 'noopener noreferrer'],
  ]);
  const send = page.$('suggestion-send-button');
  assert.deepEqual([send.textContent, send.disabled, send.className], ['Send', false, 'btn primary']);
  send.click();
  await page.flush();
  assert.deepEqual(posted(page), [['api/jobs/app/T-1/suggestion-send', { sha256: SUGGESTION.sha256 }]]);
  // While it is out, Send and Dismiss are off with the reason.
  assert.deepEqual([page.$('suggestion-send-button').disabled, page.$('suggestion-send-button').getAttribute('title')], [true, 'the planner\'s suggestion is being sent.']);
  assert.equal(page.$('suggestion-dismiss-button').disabled, true);
  assert.equal(page.$('action-status').textContent.includes('Sending the planner\'s suggestion…'), true);
  page.requests.filter((request) => request.method === 'POST')[0]!.respond(200, { ok: true, result: { state: 'working', queued: false } });
  await page.flush();
  assert.match(page.$('action-status').textContent, /Sent: the Implementer is working on it \(state working\)\./);

  page.$('suggestion-dismiss-button').click();
  await page.flush();
  assert.deepEqual(posted(page)[1], ['api/jobs/app/T-1/suggestion-dismiss', {}]);
  page.requests.filter((request) => request.method === 'POST')[1]!.respond(200, { ok: true, result: { dismissed: true } });
  await page.flush();
  assert.match(page.$('action-status').textContent, /Dismissed the planner's suggestion\./);
});

test('job client: Send is off when the job takes no message; no suggestion, no Send; without a link Discuss is a Copy of the message; a stored link that is not a https://chatgpt.com/ one is never linked', async () => {
  // The server says say is off (as for a cut-off step of the hand-over): so is Send, with its reason.
  const reason = 'the hand-over was cut off; it is repaired first.';
  const base = detail(planned('handed_over', { suggestion: SUGGESTION, discuss: DISCUSS }));
  const row = base.job as unknown as { availability: Record<string, string> };
  const off = await openJob({ ...base, job: { ...row, availability: { ...row.availability, say: reason } } as unknown as Job });
  assert.deepEqual([off.$('suggestion-send-button').disabled, off.$('suggestion-send-button').getAttribute('title')], [true, reason]);
  off.$('suggestion-send-button').click();
  await off.flush();
  assert.deepEqual(posted(off), []);

  const written: string[] = [];
  const page = await openJob(detail(planned('ready_for_human_review', { chat: 'https://evil.example/c/abc', discuss: { message: 'Use the software-factory MCP server.', url: null } })), () => undefined, { writeText: async (text) => void written.push(text) });
  const block = page.$('planner');
  assert.equal(page.document.getElementById('planner-suggestion'), null);
  assert.deepEqual([links(block), links(readyOf(page))], [[], []]);
  // A ready job's Copy is in its panel's More ▾; no ChatGPT link, no Planning chat link….
  const copy = readyOf(page).querySelector('[data-act="planner-copy"]')!;
  assert.equal(copy.textContent, 'Copy the message for the planner');
  assert.equal(page.document.getElementById('chat-open-button'), null);
  copy.click();
  await page.flush();
  assert.deepEqual(written, ['Use the software-factory MCP server.']);
  // A discuss URL that is not ChatGPT's prefill is not linked either.
  await show(page, detail(planned('ready_for_human_review', { discuss: { message: 'm', url: 'https://evil.example/?q=m' } })));
  assert.deepEqual([links(page.$('planner')), links(readyOf(page)), page.document.getElementById('chat-open-button')], [[], [], null]);
  // A job that does not wait for the user: no Discuss, the field only.
  await show(page, detail(planned('working', {})));
  assert.deepEqual([page.$('planner').hidden, links(page.$('planner')), page.$('planner').querySelector('[data-act="planner-copy"]')], [false, [], null]);
  assert.notEqual(page.document.getElementById('job-chat-input'), null);
});

test('job client: the planning chat link field saves, removes and shows a refusal next to it', async () => {
  const page = await openJob(detail(planned('needs_human', { discuss: DISCUSS }, { error: { code: 'iteration_limit', message: 'm' } })));
  const input = page.$('job-chat-input');
  assert.equal(input.value, '');
  assert.equal(page.$('planner').querySelector('[data-act="chat-remove"]'), null);
  input.value = 'https://evil.example/c/1';
  page.$('planner').querySelector('[data-act="chat-save"]')!.click();
  await page.flush();
  assert.deepEqual(posted(page), [['api/tickets/app/T-1/chat', { url: 'https://evil.example/c/1' }]]);
  page.requests.filter((request) => request.method === 'POST')[0]!.respond(400, { ok: false, error: { code: 'invalid_chat_link', message: 'Only a https://chatgpt.com/ conversation link can be saved.' } });
  await page.flush();
  assert.equal(page.$('planner').querySelector('.chat-field .err-text')!.textContent, 'Only a https://chatgpt.com/ conversation link can be saved.');
  // The box keeps what was typed.
  assert.equal(page.$('job-chat-input').value, 'https://evil.example/c/1');

  page.$('job-chat-input').value = 'https://chatgpt.com/c/ok';
  page.$('planner').querySelector('[data-act="chat-save"]')!.click();
  await page.flush();
  assert.deepEqual(posted(page)[1], ['api/tickets/app/T-1/chat', { url: 'https://chatgpt.com/c/ok' }]);
  page.requests.filter((request) => request.method === 'POST')[1]!.respond(200, { ok: true, result: { workspace: 'app', ticket: 'T-1', planning_chat: 'https://chatgpt.com/c/ok' } });
  await page.flush();
  assert.equal(page.$('planner').querySelector('.chat-field .err-text')!.textContent, '');
  assert.deepEqual(links(page.$('planner')).map(([text, href]) => [text, href]), [['Discuss the result ↗', DISCUSS.url], ['Open the planning chat ↗', 'https://chatgpt.com/c/ok']]);
  page.$('planner').querySelector('[data-act="chat-remove"]')!.click();
  await page.flush();
  assert.deepEqual(posted(page)[2], ['api/tickets/app/T-1/chat', { url: null }]);
  page.requests.filter((request) => request.method === 'POST')[2]!.respond(200, { ok: true, result: { workspace: 'app', ticket: 'T-1', planning_chat: null } });
  await page.flush();
  assert.deepEqual([page.$('job-chat-input').value, page.$('planner').querySelector('[data-act="chat-remove"]')], ['', null]);
});

test('job client (SF-286): a ready job ChatGPT plans: More ▾ ends with Discuss the result ↗ and Planning chat link…, which opens the field under the row; Save posts, a refusal shows next to it, a saved link closes it and shows in the planner block', async () => {
  const shown = detail(planned('ready_for_human_review', { discuss: DISCUSS }, { worktree: '/wt/T-1', mr_host: { host: 'github', reason: null } }), { mr: true });
  shown.job = served(shown.job, { handsOver: true });
  const page = await openJob(shown);
  // The planner block holds neither Discuss nor the field: they are in the panel.
  assert.deepEqual([links(page.$('planner')), page.$('planner').querySelector('.chat-field')], [[], null]);
  moreOf(page).click();
  assert.deepEqual(readyMenu(page).children.map((node) => [(node as FakeElement).getAttribute('role'), (node as FakeElement).textContent]), [
    ['menuitem', 'Review the MR and pushPush from here instead of your checkout.'],
    ['menuitem', 'Approve without review…Push the prepared branch, without the Merge request screen.'],
    ['menuitem', 'Create merge request'],
    ['separator', ''],
    ['menuitem', 'Refresh MR status'],
    ['menuitem', 'Discuss the result ↗'],
    ['menuitem', 'Planning chat link…'],
  ]);
  assert.deepEqual(links(readyMenu(page)), [['Discuss the result ↗', DISCUSS.url, '_blank', 'noopener noreferrer']]);

  // Planning chat link… opens the field under the row, the focus in its box; again, it closes, the focus on More ▾.
  page.$('chat-open-button').click();
  const chat = readyOf(page).querySelector('.rd-chat')!;
  assert.deepEqual([readyOf(page).children.indexOf(chat), readyMenu(page).hidden, page.document.activeElement], [1, true, page.$('job-chat-input')]);
  moreOf(page).click();
  page.$('chat-open-button').click();
  assert.deepEqual([readyOf(page).querySelector('.rd-chat'), page.document.activeElement], [null, moreOf(page)]);
  moreOf(page).click();
  page.$('chat-open-button').click();

  // Save posts; a refusal shows next to the field, which stays open with what was typed.
  page.$('job-chat-input').value = 'https://evil.example/c/1';
  readyOf(page).querySelector('[data-act="chat-save"]')!.click();
  await page.flush();
  assert.deepEqual(posted(page), [['api/tickets/app/T-1/chat', { url: 'https://evil.example/c/1' }]]);
  page.requests.filter((request) => request.method === 'POST')[0]!.respond(400, { ok: false, error: { code: 'invalid_chat_link', message: 'Only a https://chatgpt.com/ conversation link can be saved.' } });
  await page.flush();
  assert.deepEqual([readyOf(page).querySelector('.rd-chat .err-text')!.textContent, page.$('job-chat-input').value], ['Only a https://chatgpt.com/ conversation link can be saved.', 'https://evil.example/c/1']);
  // A saved link closes the field and the item; Open the planning chat ↗ shows in the planner block.
  page.$('job-chat-input').value = 'https://chatgpt.com/c/ok';
  readyOf(page).querySelector('[data-act="chat-save"]')!.click();
  await page.flush();
  page.requests.filter((request) => request.method === 'POST')[1]!.respond(200, { ok: true, result: { workspace: 'app', ticket: 'T-1', planning_chat: 'https://chatgpt.com/c/ok' } });
  await page.flush();
  assert.deepEqual([readyOf(page).querySelector('.rd-chat'), page.document.getElementById('chat-open-button')], [null, null]);
  assert.deepEqual(links(page.$('planner')), [['Open the planning chat ↗', 'https://chatgpt.com/c/ok', '_blank', 'noopener noreferrer']]);
  // Shown again with the stored link: still no item, Discuss stays in More.
  const stored = detail(planned('ready_for_human_review', { discuss: DISCUSS, chat: 'https://chatgpt.com/c/abc' }));
  await show(page, stored);
  assert.deepEqual([page.document.getElementById('chat-open-button'), links(readyMenu(page)).map(([text]) => text)], [null, ['Discuss the result ↗']]);
  assert.deepEqual(links(page.$('planner')).map(([text, href]) => [text, href]), [['Open the planning chat ↗', 'https://chatgpt.com/c/abc']]);
});

test('job client (SF-286): a card\'s Review the suggestion of a ready job opens Ask for a change, the focus in the box, once the job\'s detail is shown', async () => {
  const ready = planned('ready_for_human_review', { suggestion: SUGGESTION, discuss: DISCUSS });
  const page = await openJob(detail(ready));
  assert.equal(crowOf(page).hidden, true);
  (page.$('jhead').children[0] as FakeElement).click();
  await page.flush();
  const review = page.$('board').all().find((node) => node.dataset.open === 'app/T-1' && node.dataset.focus === 'composer')!;
  assert.equal(review.textContent, 'Review the suggestion');
  review.click();
  await page.flush();
  page.streams.at(-1)!.emit('job', detail(ready));
  await page.flush();
  assert.deepEqual([crowOf(page).hidden, page.$('ask-button').getAttribute('aria-expanded'), page.document.activeElement], [false, 'true', page.$('msg')]);
});

// Discuss the result for a ticket Claude Code plans (SF-308-3): the job page reads the ticket's
// planner session (web/planner.ts jobPlanner) and opens it, or starts one on the result.
const CLAUDE_DISCUSS = { message: 'Use the software-factory MCP server. Call read_job.', url: null };
const SESSION_LINK = 'https://claude.ai/code/session_01Ab';
const POLL_MS = 10000;
const claudeJob = (state: string, planner: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  planned(state, { owner: 'claude_code', discuss: CLAUDE_DISCUSS, ...planner }, state === 'needs_human' ? { error: { code: 'iteration_limit', message: 'm' }, ...extra } : extra);
const plannerSession = (extra: Record<string, unknown> = {}) => ({ name: 'sf-plan-app-T-1', started_at: '2026-11-01T10:07:00.000Z', link: null, result_of: null, ...extra });
const sessionLine = (name: string) => `Planner session "${name}" runs; its link shows here once it first waits for you, or find it under that name in the Claude app or on claude.ai/code.`;
const STARTED = 'The planner of app/T-1 started with the message about the result: it reads the job and sums it up. Its link shows here once it first waits for you.';
const plannerReads = (page: Page, ticket = 'T-1'): FetchRequest[] => gets(page, `api/tickets/app/${ticket}/planner`);
const discussPost = (page: Page): FetchRequest => page.requests.filter((request) => request.method === 'POST' && request.path === 'api/tickets/app/T-1/planner/discuss').at(-1)!;
// The timers of the next read armed and not fired yet.
const armed = (page: Page) => page.timers.filter((timer) => timer.ms === POLL_MS && !timer.cleared && !timer.fired);

// Answers the last read of the ticket's session with session.
async function answerRead(page: Page, session: unknown, ticket = 'T-1'): Promise<void> {
  plannerReads(page, ticket).at(-1)!.respond(200, { session, prototypes: [] });
  await page.flush();
}

// The page goes to the hash, the job's stream sending it.
async function goTo(page: Page, hash: string, shown?: Detail): Promise<void> {
  page.location.hash = hash;
  page.window.dispatch('hashchange');
  await page.flush();
  if (shown !== undefined) {
    page.streams.at(-1)!.emit('open');
    page.streams.at(-1)!.emit('job', shown);
    await page.flush();
  }
}

test('job client (SF-308-3): a waiting job Claude Code plans without a session: one read, Discuss the result posts discuss once at a time, the session it started on this result shows its line without Copy, and the next read comes 10 s after the answer', async () => {
  const page = await openJob(detail(claudeJob('needs_human')));
  assert.equal(plannerReads(page).length, 1);
  await answerRead(page, null);
  const start = page.$('planner-discuss-button');
  assert.deepEqual([start.textContent, start.disabled, start.dataset.act, start.getAttribute('title')], ['Discuss the result', false, 'planner-discuss', 'Starts the planner in the planning copy of app with the message about the result']);
  // No ChatGPT link and no Copy of the message.
  assert.deepEqual([links(page.$('planner')), page.$('planner').querySelector('[data-act="planner-copy"]')], [[], null]);
  start.click();
  await page.flush();
  assert.deepEqual(posted(page), [['api/tickets/app/T-1/planner/discuss', {}]]);
  assert.deepEqual([page.$('planner-discuss-button').textContent, page.$('planner-discuss-button').disabled], ['Starting the planner…', true]);
  // A second click while it is out posts nothing, even on a button not disabled.
  page.$('planner-discuss-button').click();
  page.$('planner-discuss-button').disabled = false;
  page.$('planner-discuss-button').click();
  await page.flush();
  assert.equal(posted(page).length, 1);
  const before = page.timers.length;
  discussPost(page).respond(200, { ok: true, result: { started: true, session: plannerSession({ result_of: 1 }) } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, STARTED);
  assert.deepEqual([page.$('planner').querySelector('[role="status"]')!.textContent, page.document.getElementById('planner-discuss-button'), page.$('planner').querySelector('[data-act="planner-copy"]')], [sessionLine('sf-plan-app-T-1'), null, null]);
  // One read armed, by the answer: 10 s after it the page reads the session again.
  assert.deepEqual([armed(page).length, page.timers.indexOf(armed(page)[0]!) >= before], [1, true]);
  page.tick(POLL_MS);
  await page.flush();
  assert.equal(plannerReads(page).length, 2);
});

test('job client (SF-308-3): Discuss the result\'s outcomes in the toast: started, running with and without a link, a refusal, no answer', async () => {
  const outcome = async (answer: (request: FetchRequest) => void): Promise<string> => {
    const page = await openJob(detail(claudeJob('needs_human')));
    await answerRead(page, null);
    page.$('planner-discuss-button').click();
    await page.flush();
    answer(discussPost(page));
    await page.flush();
    return page.$('toast-text').textContent;
  };
  assert.equal(await outcome((request) => request.respond(200, { ok: true, result: { started: true, session: plannerSession() } })), STARTED);
  assert.equal(await outcome((request) => request.respond(200, { ok: true, result: { started: false, session: plannerSession({ link: SESSION_LINK }) } })), 'The planner of app/T-1 runs already: Discuss the result opens it.');
  assert.equal(await outcome((request) => request.respond(200, { ok: true, result: { started: false, session: plannerSession({ link: 'https://evil.example/code/x' }) } })), 'The planner of app/T-1 runs already; its link shows here once it first waits for you.');
  const refused = 'The job is working; Discuss the result needs a job that waits for the user: needs_human, ready_for_human_review or handed_over.';
  assert.equal(await outcome((request) => request.respond(409, { ok: false, error: { code: 'invalid_state', message: refused } })), `invalid_state: ${refused}`);
  assert.match(await outcome((request) => request.fail('connection reset')), /^Starting the planner failed \(.+\); it may have started\.$/);
});

test('job client (SF-308-3): a session with a link: Discuss the result ↗ opens it in a new tab and its click copies the message to paste; one started on this result copies nothing; a link that is not claude.ai/code is not linked', async () => {
  const written: string[] = [];
  const page = await openJob(detail(claudeJob('needs_human')), () => undefined, { writeText: async (text) => void written.push(text) });
  await answerRead(page, plannerSession({ link: SESSION_LINK }));
  assert.deepEqual(links(page.$('planner')), [['Discuss the result ↗', SESSION_LINK, '_blank', 'noopener noreferrer']]);
  assert.equal(page.$('planner-discuss-link').getAttribute('title'), 'Opens the planner session; the message about the result is copied, to paste there');
  page.$('planner-discuss-link').click();
  await page.flush();
  assert.deepEqual([written, page.$('toast-text').textContent], [[CLAUDE_DISCUSS.message], 'Copied. The message for the planner: paste it into the session.']);
  // Started on this iteration's result: nothing to paste.
  page.tick(POLL_MS);
  await answerRead(page, plannerSession({ link: SESSION_LINK, result_of: 1 }));
  page.$('planner-discuss-link').click();
  await page.flush();
  assert.deepEqual([written.length, page.$('planner-discuss-link').getAttribute('title')], [1, 'Opens the planner session, which got the message about this result']);
  // A link that fails TK_PLANNER_LINK: the line and Copy instead.
  page.tick(POLL_MS);
  await answerRead(page, plannerSession({ link: 'https://evil.example/code/x' }));
  assert.deepEqual([links(page.$('planner')), page.$('planner').querySelector('[role="status"]')!.textContent], [[], sessionLine('sf-plan-app-T-1')]);
  page.$('planner').querySelector('[data-act="planner-copy"]')!.click();
  await page.flush();
  assert.deepEqual(written, [CLAUDE_DISCUSS.message, CLAUDE_DISCUSS.message]);
});

test('job client (SF-308-3): the job page reads the session every 10 s while it shows the waiting job, none while hidden (the timer goes on), on the board or on another job; back on it, one read at once; a redraw sends nothing; a late read of A leaves B alone; a session gone shows the button; iteration 2 reads at once', async () => {
  const a = claudeJob('needs_human');
  const b = claudeJob('needs_human', {}, { ticket: 'T-2', branch: 'T-2-demo', title: 'Other' });
  const page = await openJob(detail(a), (path) => (path === 'api/jobs/app/T-2' ? detail(b) : undefined), undefined, [b]);
  await answerRead(page, null);
  // Without a session too.
  page.tick(POLL_MS);
  await page.flush();
  assert.equal(plannerReads(page).length, 2);
  await answerRead(page, plannerSession({ link: SESSION_LINK }));
  assert.equal(page.$('planner-discuss-link').href, SESSION_LINK);
  // A redraw sends nothing.
  await show(page, detail(a));
  assert.equal(plannerReads(page).length, 2);
  // Hidden: no read, the timer goes on.
  page.document.visibilityState = 'hidden';
  page.tick(POLL_MS);
  await page.flush();
  assert.deepEqual([plannerReads(page).length, armed(page).length], [2, 1]);
  page.document.visibilityState = 'visible';
  page.tick(POLL_MS);
  await page.flush();
  assert.equal(plannerReads(page).length, 3);
  // The session ended: the button again.
  await answerRead(page, null);
  assert.deepEqual([page.$('planner-discuss-button').textContent, page.document.getElementById('planner-discuss-link')], ['Discuss the result', null]);
  // On the board: no read, no timer after.
  await goTo(page, '#board');
  page.tick(POLL_MS);
  await page.flush();
  assert.deepEqual([plannerReads(page).length, armed(page).length], [3, 0]);
  // Back on the job: one read at once.
  await goTo(page, '#app/T-1', detail(a));
  assert.equal(plannerReads(page).length, 4);
  // On B while A's read is out: B's own read; A's late answer leaves B's link, reads and timer alone.
  await goTo(page, '#app/T-2', detail(b));
  assert.equal(plannerReads(page, 'T-2').length, 1);
  await answerRead(page, plannerSession({ name: 'sf-plan-app-T-2', link: 'https://claude.ai/code/session_02Cd' }), 'T-2');
  assert.equal(armed(page).length, 1);
  await answerRead(page, plannerSession({ link: SESSION_LINK }));
  assert.deepEqual([page.$('planner-discuss-link').href, armed(page).length], ['https://claude.ai/code/session_02Cd', 1]);
  page.tick(POLL_MS);
  await page.flush();
  assert.deepEqual([plannerReads(page).length, plannerReads(page, 'T-2').length], [4, 2]);
  // Back on A, waiting again at iteration 2 while a read is armed: one read at once.
  await goTo(page, '#app/T-1', detail(a));
  assert.equal(plannerReads(page).length, 5);
  await answerRead(page, null);
  await show(page, detail(claudeJob('needs_human', {}, { iteration: 2 })));
  assert.equal(plannerReads(page).length, 6);
});

test('job client (SF-308-3): left before its timer fires, the job reads at once when shown again; a read answered while the page shows the board or a ChatGPT job is dropped whole', async () => {
  const a = claudeJob('needs_human');
  const c = planned('needs_human', { discuss: DISCUSS }, { ticket: 'T-3', branch: 'T-3-demo', title: 'ChatGPT', error: { code: 'iteration_limit', message: 'm' } });
  const page = await openJob(detail(a), (path) => (path === 'api/jobs/app/T-3' ? detail(c) : undefined), undefined, [c]);
  await answerRead(page, null);
  assert.equal(armed(page).length, 1);
  // To the board and back before the timer fires: the timer is gone, one read at once.
  await goTo(page, '#board');
  await goTo(page, '#app/T-1', detail(a));
  assert.deepEqual([plannerReads(page).length, armed(page).length], [2, 0]);
  // The board while that read is out: its answer changes nothing, arms nothing.
  await goTo(page, '#board');
  await answerRead(page, plannerSession({ link: SESSION_LINK }));
  assert.equal(armed(page).length, 0);
  await goTo(page, '#app/T-1', detail(a));
  // Back on the job: the dropped answer's link is not shown, and a read goes out at once.
  assert.deepEqual([page.document.getElementById('planner-discuss-link'), page.$('planner-discuss-button').textContent, plannerReads(page).length], [null, 'Discuss the result', 3]);
  // A ChatGPT job while that read is out: the same.
  await goTo(page, '#app/T-3', detail(c));
  await answerRead(page, plannerSession({ link: SESSION_LINK }));
  assert.deepEqual([armed(page).length, links(page.$('planner')).map(([text, href]) => [text, href])], [0, [['Discuss the result ↗', DISCUSS.url]]]);
  await goTo(page, '#app/T-1', detail(a));
  assert.deepEqual([page.document.getElementById('planner-discuss-link'), plannerReads(page).length], [null, 4]);
  await answerRead(page, plannerSession({ link: SESSION_LINK }));
  assert.deepEqual([page.$('planner-discuss-link').href, armed(page).length], [SESSION_LINK, 1]);
});

test('job client (SF-308-3): a ready job Claude Code plans: More ▾ holds Discuss the result by case, then Planning chat link… (none once a link is stored); a ready ChatGPT job whose message is too long has none', async () => {
  const written: string[] = [];
  const page = await openJob(detail(claudeJob('ready_for_human_review')), () => undefined, { writeText: async (text) => void written.push(text) });
  // The items from Discuss the result (or its pending label) on: [tag, text, disabled].
  const tail = (): Array<[string, string, boolean]> => {
    const items = (readyMenu(page).children as FakeElement[]).map((node): [string, string, boolean] => [node.tagName, node.textContent, node.disabled === true]);
    return items.slice(items.findIndex(([, text]) => text.startsWith('Discuss the result') || text === 'Starting the planner…'));
  };
  await answerRead(page, null);
  // The planner block holds no Discuss: it is in the panel.
  assert.equal(page.$('planner').querySelector('[data-act="planner-discuss"]'), null);
  assert.deepEqual(tail(), [['BUTTON', 'Discuss the result', false], ['BUTTON', 'Planning chat link…', false]]);
  page.$('planner-discuss-button').click();
  await page.flush();
  assert.deepEqual([posted(page), tail()[0]], [[['api/tickets/app/T-1/planner/discuss', {}]], ['BUTTON', 'Starting the planner…', true]]);
  discussPost(page).respond(200, { ok: true, result: { started: false, session: plannerSession() } });
  await page.flush();
  // A session without a link: the disabled item with the line as its note, then Copy.
  assert.deepEqual(tail(), [['BUTTON', `Discuss the result${sessionLine('sf-plan-app-T-1')}`, true], ['BUTTON', 'Copy the message for the planner', false], ['BUTTON', 'Planning chat link…', false]]);
  assert.equal(readyMenu(page).querySelector('[data-act="planner-copy"]')!.className, 'ho-item');
  // With a link: the link, whose click copies the message.
  page.tick(POLL_MS);
  await answerRead(page, plannerSession({ link: SESSION_LINK }));
  assert.deepEqual(tail(), [['A', 'Discuss the result ↗', false], ['BUTTON', 'Planning chat link…', false]]);
  assert.deepEqual(links(readyMenu(page)), [['Discuss the result ↗', SESSION_LINK, '_blank', 'noopener noreferrer']]);
  page.$('planner-discuss-link').click();
  await page.flush();
  assert.deepEqual([written, page.$('toast-text').textContent], [[CLAUDE_DISCUSS.message], 'Copied. The message for the planner: paste it into the session.']);
  // A stored link: no Planning chat link….
  await show(page, detail(claudeJob('ready_for_human_review', { chat: 'https://claude.ai/code/session_09' })));
  assert.deepEqual([tail(), page.document.getElementById('chat-open-button')], [[['A', 'Discuss the result ↗', false]], null]);
  // ChatGPT plans a ready job whose message is too long for its link: no Planning chat link….
  const chatgpt = await openJob(detail(planned('ready_for_human_review', { discuss: { message: 'm', url: null } })));
  assert.deepEqual([chatgpt.document.getElementById('chat-open-button'), plannerReads(chatgpt).length], [null, 0]);
});

// ---------- Quick fix on the job page (SF-313-3) ----------

// The detail with its served job's availability.quickfix set to the reason (the server's answer for
// a job it refuses).
const quickFixOff = (shown: Detail, reason: string): Detail => {
  const row = shown.job as unknown as { availability: Record<string, string> };
  return { ...shown, job: { ...row, availability: { ...row.availability, quickfix: reason } } as unknown as Job };
};

test('job client (SF-313-3, QF3-1): a ready job with Ask for a change open shows Quick fix beside Send, not in More ▾; an empty box keeps it off and the reasons line never names it; a message is posted to quickfix and the box emptied', async () => {
  const page = await openJob(detail(readyJob(), { mr: true }));
  page.$('ask-button').click();
  assert.deepEqual([crowOf(page).hidden, texts(page.$('acts'))], [false, ['Send', 'Quick fix']]);
  assert.equal(page.$('quickfix-button').className, 'btn');
  // More ▾ holds no Quick fix item.
  moreOf(page).click();
  assert.equal(readyMenu(page).children.some((node) => node.textContent.startsWith('Quick fix')), false);
  assert.equal(readyOf(page).contains(page.$('quickfix-button')), false);
  page.key('Escape');
  // The empty box: off with its reason, and the reasons line does not name it (nor Send).
  assert.deepEqual([page.$('quickfix-button').disabled, page.$('quickfix-button').getAttribute('title')], [true, 'write a message first.']);
  assert.equal(whyText(page).some((line) => line.includes('Quick fix') || line.includes('Send')), false);
  // A click on it posts nothing, "Go on." neither.
  page.$('quickfix-button').click();
  await page.flush();
  assert.deepEqual([posts(page, 'quickfix').length, posts(page, 'say').length], [0, 0]);
  // Whatever the reason: with a confirmation open it is off and still not named.
  moreOf(page).click();
  page.$('approve-button').click();
  typeMessage(page, 'Rename the helper.');
  assert.deepEqual([page.$('quickfix-button').disabled, page.$('quickfix-button').getAttribute('title')], [true, 'a confirmation is open: confirm or cancel it first.']);
  assert.equal(whyText(page).length > 0, true);
  assert.equal(whyText(page).some((line) => line.includes('Quick fix') || line.includes('Send')), false);
  page.$('confirm-cancel').click();

  // With a message: on; a click posts the box's text to quickfix, never to say.
  assert.equal(page.$('quickfix-button').disabled, false);
  page.$('quickfix-button').click();
  await page.flush();
  assert.deepEqual(posts(page, 'quickfix').map((request) => request.body), ['{"message":"Rename the helper."}']);
  assert.equal(posts(page, 'say').length, 0);
  // While it is out only Quick fix is off with its reason; the box keeps the text until the answer.
  assert.deepEqual([page.$('quickfix-button').disabled, page.$('quickfix-button').getAttribute('title'), page.$('say-button').disabled], [true, 'the quick fix is being sent.', false]);
  assert.deepEqual([page.$('action-status').textContent, page.$('msg').value], ['Sending the quick fix…', 'Rename the helper.']);
  posts(page, 'quickfix')[0]!.respond(200, { ok: true, result: { state: 'working' } });
  await page.flush();
  assert.deepEqual([page.$('msg').value, page.$('action-status').textContent, page.$('toast-text').textContent], ['', 'Sent: the Implementer is working on it (state working).', 'Quick fix sent']);
});

test('job client (SF-313-3, QF3-2): a handed-over job\'s panel row holds Ask for changes, Quick fix and its line; Quick fix posts quickfix with the message, Ask for changes still posts say', async () => {
  const page = await openJob(detail(handedOver()));
  const row = panelOf(page).querySelector('.ho-askrow')!;
  assert.deepEqual(texts(row), ['Ask for changes', 'Quick fix', 'Ask for changes: the full loop. Quick fix: one turn and the checks, no review while the change stays small.']);
  assert.deepEqual([page.$('quickfix-button').disabled, page.$('quickfix-button').getAttribute('title')], [true, 'write a message first.']);
  typeMessage(page, 'Fix the typo.');
  inPanel(page, 'Quick fix').click();
  await page.flush();
  assert.deepEqual(posts(page, 'quickfix').map((request) => request.body), ['{"message":"Fix the typo."}']);
  assert.equal(posts(page, 'say').length, 0);
  posts(page, 'quickfix')[0]!.respond(200, { ok: true, result: { state: 'working' } });
  await page.flush();
  assert.equal(page.$('msg').value, '');

  // Ask for changes posts say as before, not quickfix.
  await show(page, detail(handedOver()));
  typeMessage(page, 'Rename the helper.');
  inPanel(page, 'Ask for changes').click();
  await page.flush();
  assert.deepEqual(posts(page, 'say').map((request) => request.body), ['{"message":"Rename the helper."}']);
  assert.equal(posts(page, 'quickfix').length, 1);
});

test('job client (SF-313-3, QF3-3): a job whose availability.quickfix is a reason shows Quick fix off with that reason, and a click posts nothing', async () => {
  const reason = 'a quick fix needs a job ready for review or handed over; it is working.';
  // The hand-over panel's button.
  const page = await openJob(quickFixOff(detail(handedOver()), reason));
  typeMessage(page, 'Fix the typo.');
  assert.deepEqual([page.$('quickfix-button').disabled, page.$('quickfix-button').getAttribute('title'), page.$('say-button').disabled], [true, reason, false]);
  page.$('quickfix-button').click();
  await page.flush();
  assert.equal(posts(page, 'quickfix').length, 0);

  // The ready job's button beside Send.
  const ready = await openJob(quickFixOff(detail(readyJob(), { mr: true }), reason));
  ready.$('ask-button').click();
  typeMessage(ready, 'Fix the typo.');
  assert.deepEqual([ready.$('quickfix-button').disabled, ready.$('quickfix-button').getAttribute('title'), ready.$('say-button').disabled], [true, reason, false]);
  ready.$('quickfix-button').click();
  await ready.flush();
  assert.equal(posts(ready, 'quickfix').length, 0);
});
