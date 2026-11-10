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
  assert.equal(page.$('scrMr').textContent, 'No MR text yet: written at Clean, when both reviews pass.');
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

// The hand-over (SF-073) in the composer: a handed-over job's hand-over panel (SF-107) and a ready
// one the hand-over skipped, each action posted at once.
test('job client (SF-073): a handed-over job says "In your checkout on <branch>" and shows its hand-over panel; a ready one with handoff_skipped offers Hand over to my checkout with the skip message', async () => {
  const handed = handedOver();
  const page = await openJob(detail(handed, { mr: true, mr_title: 'feat(T-1): Demo' } as Partial<Omit<Detail, 'job'>>));
  const acts = (): FakeElement[] => page.$('acts').children as FakeElement[];
  const act = (label: string): FakeElement => acts().find((node) => node.textContent === label)!;
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
  assert.equal(page.$('composer-sentence').children[1]!.textContent, 'Not handed over to your checkout: T-1: ready, but your checkout has changes; hand it over when you are ready');
  assert.deepEqual(acts().map((node) => node.textContent), ['Review the MR and push', 'Approve…', 'Hand over to my checkout', 'Create merge request', 'Send', 'Abort…']);
  act('Hand over to my checkout').click();
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
  assert.deepEqual(texts(ask.querySelector('.ho-askrow')!), ['Ask for changes', "The job takes your checkout's edits back and works on your message."]);
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
    [['menuitem', 'ho-item'], ['separator', 'ho-sep'], ['menuitem', 'ho-item danger']]);
  page.key('ArrowDown');
  assert.equal(page.document.activeElement?.textContent, 'Abort the job…');
  page.key('ArrowDown');
  assert.equal(page.document.activeElement?.textContent.startsWith('Take it back'), true);
  page.key('ArrowUp');
  assert.equal(page.document.activeElement?.textContent, 'Abort the job…');
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

test('job client: the panel\'s Merged another way opens its confirmation with the sentence; Confirm posts handed-done-merged and the outcome says the job is marked done', async () => {
  const page = await openJob(detail(handedOver(), { mr: true, mr_title: 'feat(T-1): Demo' } as Partial<Omit<Detail, 'job'>>));
  const path = panelOf(page).querySelectorAll('.ho-path')[0]!;
  assert.deepEqual(path.querySelectorAll('button').map((node) => node.textContent), ['I opened the MR', 'Merged another way']);
  inPanel(page, 'Merged another way').click();
  assert.deepEqual([page.$('confirm').hidden, page.$('confirm-title').textContent, page.$('confirm-ok').textContent], [false, 'Merged another way app/T-1?', 'Merged another way']);
  assert.equal(page.$('confirm-text').textContent, 'Mark the job done: you merged its changes yourself under another branch or straight into the main branch. The factory does not check origin.');
  assert.equal(posts(page, 'handed-done-merged').length, 0);
  page.$('confirm-ok').click();
  await page.flush();
  assert.deepEqual(posts(page, 'handed-done-merged').map((request) => request.body), ['{}']);
  posts(page, 'handed-done-merged')[0]!.respond(200, { ok: true, result: { state: 'pushed', branch: 'T-1-demo' } });
  await page.flush();
  assert.match(page.document.body.textContent, /Marked done: you merged T-1-demo's changes another way; the job is pushed\./);
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
  // Details opens the technical content below the box, as it was.
  (blockOf(page).children[2] as FakeElement).click();
  await page.flush();
  assert.deepEqual(parts(page).slice(0, 3), [panel[0]!, box.textContent, 'Hide details']);
  assert.deepEqual(texts(blockOf(page).children[3] as FakeElement), panel.slice(1));
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
