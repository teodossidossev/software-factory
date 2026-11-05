// Behaviour of the job page's header and its Changes and Merge request screens in static/app.js
// (SF-078), run under node:vm against the fake page of test/support/fake-dom.ts: the URL hash that
// opens the page, the header for each state (the sentence, the iteration from shownIteration, the
// cost, the elapsed time, the branch that copies its checkout command), the screen switch and its
// keys s, c and m, Merge request off without MR text; the old MR view (Copy MR text, the Codex
// items not applied) inside its screen until SF-080, and that the old Changes view is gone (SF-079:
// the Changes screen is tested in dashboard-changes-client.test.ts). The Stream, its stop blocks
// and the composer are tested in dashboard-stream-client.test.ts. Script checks, not browser
// acceptance: the manual steps are in factory/README.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);

// The page shows local time (SF-049); the zone is set, not the machine's: Sofia is UTC+2 in November.
process.env.TZ = 'Europe/Sofia';

function job(state: string, extra: Record<string, unknown> = {}) {
  const prepared = state === 'ready_for_human_review' || state === 'pushed';
  return {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', state, iteration: 1, mr_attempts: 0,
    updated_at: '2026-11-01T10:05:00.000Z', created_at: '2026-11-01T10:00:00.000Z', error: null,
    prepared_commit: prepared ? 'a'.repeat(40) : null, worktree: prepared ? null : '/wt/T-1',
    fixes: 0, gate_fixes: 0, gate_tokens: 0, files: 0, undeclared: 0, deleted: 0, title: 'Demo', ...extra,
  };
}

type Job = ReturnType<typeof job>;
type Detail = { job: Job; iterations: Array<Record<string, unknown>>; mr: boolean; gate: boolean; history: Array<Record<string, unknown>> };

const times = { started_at: '2026-11-01T10:05:01.000Z', ended_at: '2026-11-01T10:06:00.000Z' };
const META = { started_at: '2026-11-01T10:00:01.000Z', ended_at: '2026-11-01T10:05:00.000Z', cost_usd: 0.5, changed_files: 1, patch_truncated: false, denials: 0, files: null };
const CLEAN = { reviewer: 'claude', verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [], cost_usd: 0.25, ...times };
const CLAUDE_FIX = {
  reviewer: 'claude', verdict: 'fix', summary: 'The greeting is wrong.', accepted_sensitive: [], cost_usd: 0.25,
  items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.' }, { path: 'a.txt', problem: 'Empty.', expected: 'A line.' }], ...times,
};
const GATE_FIX = {
  reviewer: 'codex', verdict: 'fix', summary: 'Not quite.', accepted_sensitive: [], model: 'gpt-x', tokens: { input: 1000, cached_input: 200, output: 100 },
  items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.' }], ...times,
};
const GATE_FAILED = { reviewer: 'codex', error: 'Codex wrote no output.', tokens: { input: 0, cached_input: 0, output: 0 }, ...times };

function iteration(number: number, extra: Record<string, unknown> = {}) {
  return { number, ...META, review: null, gate: null, gate_override: null, ...extra };
}

function detail(row: Job, extra: Partial<Omit<Detail, 'job'>> = {}): Detail {
  return { job: row, iterations: [], mr: false, gate: true, history: [{ ts: '2026-11-01T10:00:00.000Z', from: null, to: 'starting' }], ...extra };
}

// The page with the job of shown open through the URL's hash (screen: '', '/changes' or '/mr'); get
// answers the other GETs (undefined leaves them pending; an empty Stream page by default).
async function openJob(shown: Detail, get: (path: string) => unknown = () => undefined, clipboard?: { writeText(text: string): Promise<void> }, others: Job[] = [], screen = ''): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs: [shown.job, ...others] };
    }
    if (path === 'api/jobs/app/T-1') {
      return shown;
    }
    return get(path);
  }, clipboard);
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
  assert.deepEqual([tabOf(page, 'mr').getAttribute('aria-disabled'), tabOf(page, 'mr').getAttribute('title')], ['true', 'No MR text yet: written at Clean']);
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
  assert.deepEqual([tabOf(page, 'mr').getAttribute('aria-disabled'), tabOf(page, 'changes').textContent], ['false', 'Changes c']);
  page.key('m');
  await page.flush();
  assert.deepEqual([shownScreens(page), page.location.hash], [['scrMr'], '#app/T-1/mr']);
  assert.equal(gets(page, 'api/jobs/app/T-1/mr').length, 1);
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

const clipboardOf = (fail = false) => {
  const written: string[] = [];
  return {
    written,
    writeText: async (text: string): Promise<void> => {
      if (fail) {
        throw new Error('denied');
      }
      written.push(text);
    },
  };
};

test('job client: the Merge request screen shows the MR text; Copy MR text puts the title, a blank line and the body on the clipboard, or selects it; the Codex items not applied under it', async () => {
  const mr = 'feat(T-1): Demo\r\n\r\n\r\n## What\r\nIt.\r\n\r\n';
  const clipboard = clipboardOf();
  const shown = detail(job('ready_for_human_review', { iteration: 2 }), { mr: true, iterations: [iteration(1), iteration(2, { review: CLEAN, gate: GATE_FIX })] });
  const page = await openJob(detail(job('working')), (path) => (path === 'api/jobs/app/T-1/mr' ? mr : undefined), clipboard, [], '/mr');
  assert.deepEqual(shownScreens(page), ['scrMr']);
  assert.deepEqual([page.$('no-mr').hidden, page.$('mr-panel').hidden, page.$('mr-unapplied').hidden], [false, true, true]);

  await show(page, shown);
  assert.deepEqual([page.$('no-mr').hidden, page.$('mr-panel').hidden], [true, false]);
  assert.match(page.$('mr-body').textContent, /^feat\(T-1\): Demo\r?\n/);
  page.$('mr-copy').click();
  await page.flush();
  assert.deepEqual(clipboard.written, ['feat(T-1): Demo\n\n## What\nIt.']);
  assert.equal(page.$('mr-copy-status').textContent, 'Copied.');
  assert.equal(page.$('mr-copy-text').hidden, true);

  // The user accepted the change over the gate: the Codex items not applied, for a follow-up.
  const accepted = { ...shown, iterations: [iteration(1), iteration(2, { review: CLEAN, gate: GATE_FIX, gate_override: { at: times.ended_at, code: 'gate_rounds', unapplied: GATE_FIX.items } })] };
  await show(page, accepted);
  assert.equal(page.$('mr-unapplied').hidden, false);
  assert.equal(page.$('mr-unapplied-note').textContent, 'You accepted the change over the gate (gate_rounds); these could go into a follow-up ticket:');
  assert.deepEqual(texts(page.$('mr-unapplied-list')), ['README.md: It greets the world. Expected: It greets the reader.']);
  await show(page, { ...shown, iterations: [iteration(1, { gate_override: { at: times.ended_at, code: 'gate_failed', unapplied: 'Codex wrote no output.' } })] });
  assert.equal(page.$('mr-unapplied-note').textContent, 'You accepted the change over the gate (gate_failed); the gate failed: Codex wrote no output.');
  assert.deepEqual(texts(page.$('mr-unapplied-list')), []);
  // An override an iteration later reviewed by the gate again replaced: nothing listed.
  await show(page, { ...accepted, iterations: [...accepted.iterations, iteration(3, { review: CLEAN, gate: { ...GATE_FIX, verdict: 'clean', items: [] } })] });
  assert.equal(page.$('mr-unapplied').hidden, true);


  // Without the clipboard, or when the browser refuses it: the text shown and selected for Ctrl+C.
  for (const refusing of [undefined, clipboardOf(true)]) {
    const other = await openJob(shown, (path) => (path === 'api/jobs/app/T-1/mr' ? mr : undefined), refusing, [], '/mr');
    other.$('mr-copy').click();
    await other.flush();
    const box = other.$('mr-copy-text');
    assert.deepEqual([box.hidden, box.value, box.selected], [false, 'feat(T-1): Demo\n\n## What\nIt.', true]);
    assert.equal(other.$('mr-copy-status').textContent, 'Selected: press Ctrl+C to copy.');
  }
});

// The hand-over (SF-073) in the composer: the actions of a handed-over job and of a ready one the
// hand-over skipped, each posted at once.
test('job client (SF-073): a handed-over job says "In your checkout on <branch>" and offers Approve, Ask for changes, I opened the MR myself and Take it back; a ready one with handoff_skipped offers Hand over to my checkout with the skip message', async () => {
  const handover = { branch: 'T-1-demo', saved: 'a'.repeat(40), base: 'b'.repeat(40), previous: { branch: 'main' }, untracked: [], template: null, cleanup: null, at: '2026-11-01T10:06:00.000Z', checked_at: null, step: null };
  const handed = job('handed_over', { prepared_commit: 'a'.repeat(40), worktree: null, handover, handoff_skipped: null, mr_host: { host: 'github', reason: null } });
  const page = await openJob(detail(handed, { mr: true, mr_title: 'feat(T-1): Demo' } as Partial<Omit<Detail, 'job'>>));
  const acts = (): FakeElement[] => page.$('acts').children as FakeElement[];
  const act = (label: string): FakeElement => acts().find((node) => node.textContent === label)!;
  const posted = (action: string): FetchRequest[] => page.requests.filter((request) => request.method === 'POST' && request.path === `api/jobs/app/T-1/${action}`);
  assert.equal(facts(page)[0], 'In your checkout on T-1-demo');
  assert.equal(page.$('composer-sentence').children[0]!.textContent, 'In your checkout on T-1-demo.');
  assert.match(page.$('composer-sentence').children[1]!.textContent, /^Read, run and change it there\. Approve pushes it; Ask for changes sends your edits/);
  assert.deepEqual(acts().map((node) => node.textContent), ['Approve…', 'Ask for changes', 'I opened the MR myself', 'Take it back', 'Create merge request', 'Abort…']);
  assert.deepEqual([act('Approve…').className, act('Approve…').disabled, page.$('msg').disabled], ['btn primary', false, false]);
  // The card on the board says where the job is.
  assert.notEqual(page.$('list-you').all().find((node) => node.className === 'reason ready' && node.textContent === 'In your checkout on T-1-demo'), undefined);

  // Take it back goes at once.
  act('Take it back').click();
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
  assert.deepEqual(acts().map((node) => node.textContent), ['Approve…', 'Hand over to my checkout', 'Create merge request', 'Send', 'Abort…']);
  act('Hand over to my checkout').click();
  await page.flush();
  assert.deepEqual(posted('handover').map((request) => request.body), ['{}']);
});
