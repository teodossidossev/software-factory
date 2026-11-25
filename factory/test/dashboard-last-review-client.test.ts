// Behaviour of the job page's last review panel in web/last-review.ts (SF-309-4), run under node:vm
// against the fake page of test/support/fake-dom.ts: the panel at the top of the Stream screen
// with the review's note, the comments by kind with Send and Dismiss, Send chosen and Dismiss all
// (the ids and the iteration they post), when their buttons are off and why, a failed review and
// one with no comment left, the dismiss outcome, and that a jobs event that changes nothing the
// panel shows leaves it as it is (its node, its scroll, the focus on a box); and (SF-309-5) the job
// card's count of the comments and the Stream's one line that leads to the panel. Script checks,
// not browser acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { served, servedDetail } from './support/dashboard-client.js';
import { type FakeElement, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
process.env.TZ = 'Europe/Sofia';

const LR_PENDING = "the last review's request is out; waiting for its outcome.";

// A job waiting for the user after its Fix round limit, as the server sends it: it takes a message.
function job(extra: Record<string, unknown> = {}) {
  return served({
    workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', state: 'needs_human', iteration: 1, mr_attempts: 0,
    updated_at: '2026-11-01T10:05:00.000Z', created_at: '2026-11-01T10:00:00.000Z', error: { code: 'iteration_limit', message: 'Three Fix sections.' },
    prepared_commit: null, worktree: '/wt/T-1', fixes: 0, gate_fixes: 0, gate_tokens: 0, files: 0, undeclared: 0, deleted: 0, title: 'Demo', ...extra,
  });
}

type Job = ReturnType<typeof job>;

// The detail with its job's say off for a reason of its own (the rest of its availability as
// served; servedDetail serves the job again, so this goes after it).
function noMessage(shown: Detail): Detail {
  const row = shown.job as Job & { availability?: Record<string, string> };
  const changed: Job & { availability: Record<string, string> } = { ...row, availability: { ...row.availability, say: 'the job takes no message now.' } };
  return { ...shown, job: changed };
}

const comment = (id: string, kind: string, path: string, line: number, text: string) => ({ id, path, line, text, kind });
// Two changes and a question, the question between them in the record's order.
const COMMENTS = [
  comment('C1', 'change', 'src/a.ts', 3, 'Rename **it**'),
  comment('C2', 'question', 'README.md', 1, 'Why here?'),
  comment('C3', 'change', 'src/deep/b.ts', 40, 'Guard null'),
];

function view(extra: Record<string, unknown> = {}) {
  return { iteration: 1, summary: 'Check the retry first.', comments: COMMENTS, sent: 0, dismissed: 0, error: null, timed_out: false, ended_at: '2026-11-01T10:06:00.000Z', ...extra };
}

function detail(row: Job, lastReview: unknown, omit = false) {
  const base = { job: row, iterations: [], mr: false, gate: true, history: [{ ts: '2026-11-01T10:00:00.000Z', from: null, to: 'starting' }] };
  return servedDetail(omit ? base : { ...base, last_review: lastReview });
}

type Detail = ReturnType<typeof detail>;

// The page with the job open on its Stream; hold.detail set leaves the next detail reads pending;
// entries: the Stream's one page (none: its read stays pending).
async function openJob(shown: Detail, hold = { detail: false }, entries?: unknown[]): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs: [shown.job] };
    }
    if (path === 'api/jobs/app/T-1') {
      return hold.detail ? undefined : shown;
    }
    if (entries !== undefined && path === 'api/jobs/app/T-1/stream?from=0') {
      return { entries, next: entries.length, end: true };
    }
    return undefined;
  });
  page.location.hash = '#app/T-1';
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs: [shown.job] });
  stream.emit('job', shown);
  await page.flush();
  return page;
}

async function emit(page: Page, name: 'jobs' | 'job', data: unknown): Promise<void> {
  page.streams.at(-1)!.emit(name, data);
  await page.flush();
}

const panel = (page: Page): FakeElement => page.$('last-review');
const block = (page: Page): FakeElement => panel(page).children[0] as FakeElement;
const lr = (page: Page, value: string): FakeElement => panel(page).querySelector(`[data-lr="${value}"]`)!;
const pick = (page: Page, id: string): FakeElement => panel(page).querySelector(`[data-lrpick="${id}"]`)!;
const posts = (page: Page) => page.requests.filter((request) => request.method === 'POST');
const posted = (page: Page): Array<[string, unknown]> => posts(page).map((request) => [request.path, JSON.parse(request.body!)]);
const offState = (node: FakeElement): [boolean, string | null] => [node.disabled, node.getAttribute('title')];

// Ticks a comment's box as a click does in a browser (the fake click does not toggle it).
async function tick(page: Page, id: string): Promise<void> {
  const box = pick(page, id);
  box.checked = true;
  box.focus();
  box.click();
  await page.flush();
}

test('last review panel (LR4-1): the note first, then the changes and the questions, each comment with its id, file:line, text, Send and Dismiss', async () => {
  const page = await openJob(detail(job(), view()));
  const scr = page.$('scrStream');
  assert.equal(scr.children[0], panel(page));
  assert.deepEqual([panel(page).hidden, panel(page).className, panel(page).children.length], [false, 'lastreview', 1]);
  const shown = block(page);
  assert.equal(shown.className, 'block');
  const parts = shown.children as FakeElement[];
  assert.deepEqual(parts.map((part) => `${part.tagName.toLowerCase()}.${part.className}`), ['div.bh', 'div.lr-acts', 'h4.lr-kind', 'ul.findings', 'h4.lr-kind', 'ul.findings']);
  const head = parts[0]!;
  assert.deepEqual([head.querySelector('.verdict')!.className, head.querySelector('.verdict')!.textContent, head.querySelector('.lr-note')!.textContent], ['verdict fix', 'Last review', 'Check the retry first.']);
  assert.deepEqual([parts[2]!.textContent, parts[4]!.textContent], ['Changes (2)', 'Questions (1)']);
  assert.equal(parts[1]!.textContent.startsWith('iteration 1 · 3 comments'), true);
  const rows = (list: FakeElement) => list.querySelectorAll('li.finding').map((item) => [
    item.dataset.id, item.querySelector('.fid')!.textContent, item.querySelector('.pathlink')!.textContent, item.querySelector('.pathlink')!.dataset.cfile,
    item.querySelector('.problem')!.textContent, item.querySelector('.decide')!.querySelectorAll('button').map((node) => node.textContent),
  ]);
  assert.deepEqual(rows(parts[3]!), [
    ['C1', 'C1', 'src/a.ts:3', 'src/a.ts', 'Rename it', ['Send', 'Dismiss']],
    ['C3', 'C3', 'src/deep/b.ts:40', 'src/deep/b.ts', 'Guard null', ['Send', 'Dismiss']],
  ]);
  assert.deepEqual(rows(parts[5]!), [['C2', 'C2', 'README.md:1', 'README.md', 'Why here?', ['Send', 'Dismiss']]]);
  assert.deepEqual([pick(page, 'C1').type, pick(page, 'C1').getAttribute('aria-label'), pick(page, 'C1').checked], ['checkbox', 'Choose C1', false]);
  assert.deepEqual([lr(page, 'send-chosen').id, lr(page, 'send-chosen').textContent, lr(page, 'dismiss-all').id, lr(page, 'dismiss-all').textContent], ['lr-send-chosen', 'Send chosen (0)', 'lr-dismiss-all', 'Dismiss all']);
  // A summary that is empty reads "No note.".
  await emit(page, 'job', detail(job(), view({ summary: '' })));
  assert.equal(block(page).querySelector('.lr-note')!.textContent, 'No note.');
});

test('last review panel (LR4-2): Send posts the one id, Send chosen the ticked ids in the panel\'s order, Dismiss all every shown id, each with the view\'s iteration', async () => {
  const page = await openJob(detail(job(), view()));
  lr(page, 'send:C2').click();
  await page.flush();
  assert.deepEqual(posted(page), [['api/jobs/app/T-1/last-review-send', { iteration: 1, ids: ['C2'] }]]);
  posts(page)[0]!.respond(200, { ok: true, result: { state: 'working', queued: false } });
  await page.flush();
  assert.match(page.$('action-status').textContent, /Sent: the Implementer is working on it \(state working\)\./);
  assert.equal(page.$('toast-text').textContent, 'Comments sent');

  await tick(page, 'C3');
  await tick(page, 'C1');
  assert.equal(lr(page, 'send-chosen').textContent, 'Send chosen (2)');
  lr(page, 'send-chosen').click();
  await page.flush();
  assert.deepEqual(posted(page)[1], ['api/jobs/app/T-1/last-review-send', { iteration: 1, ids: ['C1', 'C3'] }]);
  posts(page)[1]!.respond(200, { ok: true, result: { state: 'working', queued: true } });
  await page.flush();

  lr(page, 'dismiss-all').click();
  await page.flush();
  assert.deepEqual(posted(page)[2], ['api/jobs/app/T-1/last-review-dismiss', { iteration: 1, ids: ['C1', 'C2', 'C3'] }]);
});

test('last review panel (LR4-3): while a Send is out every Send and Dismiss is off with a title; with say off Send is off with its reason and Dismiss on; with none chosen Send chosen is off', async () => {
  const page = await openJob(detail(job(), view()));
  lr(page, 'send:C1').click();
  await page.flush();
  const buttons = panel(page).querySelectorAll('[data-lr]');
  assert.equal(buttons.length, 8);
  assert.deepEqual(buttons.map(offState), buttons.map(() => [true, LR_PENDING]));
  // A second click while it is out posts nothing.
  lr(page, 'dismiss:C2').click();
  await page.flush();
  assert.equal(posts(page).length, 1);
  // While it is out the outcome line is empty; the buttons' titles say why.
  assert.equal(page.$('action-status').textContent, '');
  posts(page)[0]!.respond(200, { ok: true, result: { state: 'needs_human', queued: false } });
  await page.flush();
  assert.deepEqual(offState(lr(page, 'send:C1')), [false, null]);

  const quiet = await openJob(noMessage(detail(job(), view())));
  for (const id of ['C1', 'C2', 'C3']) {
    assert.deepEqual(offState(lr(quiet, `send:${id}`)), [true, 'the job takes no message now.']);
    assert.deepEqual(offState(lr(quiet, `dismiss:${id}`)), [false, null]);
  }
  assert.deepEqual(offState(lr(quiet, 'send-chosen')), [true, 'the job takes no message now.']);
  assert.deepEqual(offState(lr(quiet, 'dismiss-all')), [false, null]);

  const fresh = await openJob(detail(job(), view()));
  assert.deepEqual(offState(lr(fresh, 'send-chosen')), [true, 'choose a comment first.']);
  await tick(fresh, 'C2');
  assert.deepEqual(offState(lr(fresh, 'send-chosen')), [false, null]);
});

test('last review panel (LR4-4): no panel without a last review; a failed one shows its error without buttons; one with no comment left says what became of them', async () => {
  for (const shown of [detail(job(), null), detail(job(), undefined, true)]) {
    const page = await openJob(shown);
    assert.deepEqual([panel(page).hidden, panel(page).children.length], [true, 0]);
  }
  const failed = await openJob(detail(job(), view({ summary: null, comments: [], error: 'The session ended: no answer in 10 minutes.', timed_out: true })));
  const head = block(failed).querySelector('.bh')!;
  assert.deepEqual([head.querySelector('.verdict')!.className, head.textContent], ['verdict stop', 'Last review failediteration 1']);
  assert.equal(block(failed).querySelector('pre.raw')!.textContent, 'The session ended: no answer in 10 minutes.');
  assert.equal(panel(failed).querySelectorAll('button').length, 0);

  const done = await openJob(detail(job(), view({ comments: [], sent: 1, dismissed: 2 })));
  assert.equal(block(done).querySelector('div.muted')!.textContent, 'No comment left: 1 sent, 2 dismissed.');
  assert.equal(panel(done).querySelectorAll('button').length, 0);
  await emit(done, 'job', detail(job(), view({ comments: [] })));
  assert.equal(block(done).querySelector('div.muted')!.textContent, 'No comments.');
  // The review going away hides the panel.
  await emit(done, 'job', detail(job(), null));
  assert.deepEqual([panel(done).hidden, panel(done).children.length], [true, 0]);
});

test('last review panel (LR4-5): the dismiss outcome counts the comments dismissed', async () => {
  const page = await openJob(detail(job(), view()));
  lr(page, 'dismiss-all').click();
  await page.flush();
  posts(page)[0]!.respond(200, { ok: true, result: { dismissed: 2 } });
  await page.flush();
  assert.match(page.$('action-status').textContent, /Dismissed 2 comments of the last review\./);
  assert.equal(page.$('toast-text').textContent, 'Comments dismissed');
});

test('last review panel (LR4-6): a jobs event that changes nothing it shows keeps its node and scroll; a new view or a request going out draws it again', async () => {
  const shown = detail(job(), view());
  const page = await openJob(shown);
  const first = block(page);
  panel(page).scrollTop = 40;
  await emit(page, 'jobs', { jobs: [shown.job] });
  await emit(page, 'job', shown);
  assert.deepEqual([block(page) === first, panel(page).scrollTop], [true, 40]);
  await emit(page, 'job', detail(job(), view({ comments: COMMENTS.slice(1), dismissed: 1 })));
  const second = block(page);
  assert.notEqual(second, first);
  assert.equal(panel(page).scrollTop, 40);
  lr(page, 'send:C2').click();
  await page.flush();
  assert.notEqual(block(page), second);
});

test('last review panel (LR4-7): a box ticked under iteration 1 is not ticked when iteration 2 shows a comment with the same id', async () => {
  const page = await openJob(detail(job(), view()));
  await tick(page, 'C1');
  assert.equal(lr(page, 'send-chosen').textContent, 'Send chosen (1)');
  await emit(page, 'job', detail(job({ iteration: 2 }), view({ iteration: 2, comments: [comment('C1', 'change', 'src/z.ts', 7, 'Another')] })));
  assert.deepEqual([pick(page, 'C1').checked, lr(page, 'send-chosen').textContent], [false, 'Send chosen (0)']);
  // Nor when iteration 1's view comes back: its entry went with it.
  await emit(page, 'job', detail(job(), view()));
  assert.equal(pick(page, 'C1').checked, false);
});

test('last review panel (LR4-8): after ticking a box, a jobs event that changes nothing keeps the panel, the box ticked and the focus on it', async () => {
  const shown = detail(job(), view());
  const page = await openJob(shown);
  const first = block(page);
  await tick(page, 'C1');
  const box = pick(page, 'C1');
  assert.equal(block(page), first);
  await emit(page, 'jobs', { jobs: [shown.job] });
  await emit(page, 'job', shown);
  assert.deepEqual([block(page) === first, page.document.activeElement === box, box.checked, lr(page, 'send-chosen').textContent], [true, true, true, 'Send chosen (1)']);
  // Unticking it follows the box.
  box.checked = false;
  box.click();
  await page.flush();
  assert.deepEqual([lr(page, 'send-chosen').textContent, lr(page, 'send-chosen').disabled], ['Send chosen (0)', true]);
});

test('last review panel (LR4-9): an unknown outcome turns Dismiss off with its reason; with say off for another reason and no request out, Dismiss stays on', async () => {
  const hold = { detail: false };
  const page = await openJob(detail(job(), view()), hold);
  hold.detail = true;
  lr(page, 'send:C1').click();
  await page.flush();
  posts(page)[0]!.fail();
  await page.flush();
  const unknown = "the last action's outcome is unknown; waiting for the current state.";
  assert.deepEqual(offState(lr(page, 'dismiss:C2')), [true, unknown]);
  assert.deepEqual(offState(lr(page, 'dismiss-all')), [true, unknown]);
  assert.deepEqual(offState(lr(page, 'send:C2')), [true, unknown]);

  const quiet = await openJob(noMessage(detail(job(), view())));
  assert.deepEqual(offState(lr(quiet, 'dismiss:C2')), [false, null]);
  lr(quiet, 'dismiss:C2').click();
  await quiet.flush();
  assert.deepEqual(posted(quiet), [['api/jobs/app/T-1/last-review-dismiss', { iteration: 1, ids: ['C2'] }]]);
});

// The board with these jobs (no job open).
async function openBoard(rows: Job[]): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs: rows } : undefined));
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs: rows });
  await page.flush();
  return page;
}

const cardOf = (page: Page, key: string): FakeElement => page.document.querySelectorAll('li.card').find((item) => item.dataset.open === key)!;
const reviewLines = (item: FakeElement): string[] => item.all().filter((node) => node.className === 'meta note' && node.textContent.startsWith('Review:')).map((node) => node.textContent);

test('job card (LR5-1): a waiting job counts the last review\'s comments shown, "Review: N comment(s)"; none at 0, without a review, or while it runs; a click opens the job', async () => {
  const rows = [
    job({ ticket: 'T-1', last_review: { comments: 3 } }),
    job({ ticket: 'T-2', state: 'handed_over', error: undefined, last_review: { comments: 1 } }),
    job({ ticket: 'T-3', last_review: { comments: 0 } }),
    job({ ticket: 'T-4', last_review: null }),
    job({ ticket: 'T-5' }),
    job({ ticket: 'T-6', state: 'working', error: undefined, last_review: { comments: 3 } }),
  ];
  const page = await openBoard(rows);
  assert.deepEqual(['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6'].map((ticket) => reviewLines(cardOf(page, `app/${ticket}`))), [
    ['Review: 3 comments'], ['Review: 1 comment'], [], [], [], [],
  ]);
  cardOf(page, 'app/T-1').all().find((node) => node.textContent === 'Review: 3 comments')!.click();
  await page.flush();
  assert.equal(page.location.hash, '#app/T-1');
});

// A Stream entry of the last review of iteration it.
const lastReviewEntry = (k: string, it: number, comments: number, error: string | null = null) => ({ k, ts: '2026-11-01T10:06:00.000Z', it, who: 'claude', t: 'last_review', comments, error });
const streamLine = (page: Page, k: string): FakeElement => page.$('stream').children.find((node) => (node as FakeElement).dataset.k === k) as FakeElement;

test('Stream (LR5-3): a last review is one line, "Last review: N comments", without its comments; a click brings the panel of its iteration into view and focuses it, else a toast', async () => {
  const page = await openJob(detail(job(), view()), { detail: false }, [lastReviewEntry('4', 1, 2)]);
  const line = streamLine(page, '4');
  const buttons = line.querySelectorAll('button');
  assert.deepEqual(buttons.map((node) => [node.className, node.dataset.lr, node.textContent]), [['line', 'panel:1', 'Last review: 2 comments']]);
  for (const text of ['Rename', 'Why here?', 'Guard null']) {
    assert.equal(line.textContent.includes(text), false, text);
  }
  assert.equal(panel(page).getAttribute('tabindex'), '-1');
  buttons[0]!.click();
  await page.flush();
  assert.deepEqual([panel(page).scrolledIntoView, page.document.activeElement === panel(page), posts(page).length], [1, true, 0]);
  assert.equal(page.$('toast').hidden, true);

  // The panel shows iteration 2's review: the line of iteration 1 gives the toast.
  await emit(page, 'job', detail(job({ iteration: 2 }), view({ iteration: 2 })));
  page.$('stream').querySelector('[data-lr="panel:1"]')!.click();
  await page.flush();
  assert.equal(panel(page).scrolledIntoView, 1);
  assert.deepEqual([page.$('toast').hidden, page.$('toast-text').textContent], [false, "The last review's comments are no longer shown: the job moved on."]);

  // No panel at all: the toast too.
  const gone = await openJob(detail(job(), null), { detail: false }, [lastReviewEntry('4', 1, 2)]);
  streamLine(gone, '4').querySelector('button')!.click();
  await gone.flush();
  assert.deepEqual([panel(gone).scrolledIntoView, gone.$('toast-text').textContent], [0, "The last review's comments are no longer shown: the job moved on."]);
});

test('Stream (LR5-3): a failed last review\'s line names the error\'s first line and brings the failed panel of its iteration into view', async () => {
  const error = 'The session ended: no answer in 10 minutes.\nmore detail';
  const page = await openJob(detail(job(), view({ summary: null, comments: [], error, timed_out: true })), { detail: false }, [lastReviewEntry('4', 1, 0, error)]);
  const button = streamLine(page, '4').querySelector('button')!;
  assert.equal(button.textContent, 'Last review failed: The session ended: no answer in 10 minutes.');
  button.click();
  await page.flush();
  assert.deepEqual([panel(page).scrolledIntoView, page.document.activeElement === panel(page), page.$('toast').hidden], [1, true, true]);
});
