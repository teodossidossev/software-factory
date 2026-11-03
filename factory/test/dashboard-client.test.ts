// Behaviour of static/app.js, run under node:vm against the fake page of test/support/fake-dom.ts:
// the action matrix per state, the confirmations (cancel, discard, double submission), the say
// draft rules, the outcome texts and what happens when the selection changes while a request is
// out, and the Reviewer block (its three states, the setup boxes, the test event), the reviewer
// badges and the Subscriptions section. These are script checks, not browser acceptance: the
// manual steps are in factory/README.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);

interface JobShape {
  workspace: string;
  ticket: string;
  state: string;
  mr_attempts?: number;
  iteration?: number;
  updated_at?: string;
}

function job(shape: JobShape) {
  return {
    workspace: shape.workspace, ticket: shape.ticket, branch: `${shape.ticket}-demo`, base: 'main', state: shape.state,
    iteration: shape.iteration ?? 1, mr_attempts: shape.mr_attempts ?? 0, updated_at: shape.updated_at ?? '2026-11-01T10:05:00.000Z',
    created_at: '2026-11-01T10:00:00.000Z', error: null,
  };
}

function detail(shape: JobShape) {
  return { job: job(shape), iterations: [], mr: false, history: [{ ts: '2026-11-01T10:00:00.000Z', from: null, to: 'starting' }] };
}

const A = { workspace: 'app', ticket: 'T-1', state: 'awaiting_review', updated_at: '2026-11-01T10:05:00.000Z' };
const B = { workspace: 'app', ticket: 'T-2', state: 'working', updated_at: '2026-11-01T10:04:00.000Z' };

// The page with two jobs, A selected (the most recent) and its detail shown.
// With hold.on, detail GETs stay pending until the test answers them.
async function openPage(states: Record<string, JobShape> = { 'app/T-1': A, 'app/T-2': B }, hold = { on: false }): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs: Object.values(states).map(job) };
    }
    const match = /^api\/jobs\/([^/]+)\/([^/]+)$/.exec(path);
    return match && !hold.on ? detail(states[`${match[1]}/${match[2]}`]!) : undefined;
  });
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs: Object.values(states).map(job) });
  stream.emit('job', detail(states['app/T-1']!));
  await page.flush();
  return page;
}

const posts = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'POST');
// The outcome line and the line of an unknown outcome, as the User reads them.
const status = (page: Page): string => [page.$('action-status').textContent, page.$('action-doubt').textContent].filter((text) => text !== '').join('\n');
const refreshes = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'GET' && request.path === 'api/jobs/app/T-1');

async function sendDraft(page: Page, text: string): Promise<void> {
  page.$('say-input').value = text;
  page.$('say-input').dispatch('input');
  page.$('say-form').dispatch('submit');
  await page.flush();
}

function assertControls(page: Page, label: string, approve: boolean, abort: boolean, send: boolean): void {
  assert.deepEqual([!page.$('approve-button').disabled, !page.$('abort-button').disabled, !page.$('say-button').disabled], [approve, abort, send], label);
}

function jobButton(page: Page, key: string) {
  return page.$('job-list').all().find((element) => element.tagName === 'BUTTON' && element.textContent.startsWith(key))!;
}

async function selectJob(page: Page, key: string): Promise<void> {
  jobButton(page, key).click();
  await page.flush();
}

test('client: the controls follow the state matrix and the pending action', async () => {
  const page = await openPage();
  const matrix: Array<[string, number, boolean, boolean, boolean]> = [
    // state, mr_attempts, approve on, abort on, say on
    ['starting', 0, false, true, false],
    ['working', 0, false, true, true],
    ['awaiting_review', 0, true, true, true],
    ['needs_human', 0, false, true, true],
    ['needs_human', 1, true, true, true],
    ['ready_for_human_review', 0, true, true, false],
    ['preparing_mr', 1, false, true, false],
    ['pushed', 1, false, false, false],
    ['aborted', 0, false, false, false],
    ['failed', 0, false, false, false],
  ];
  const stream = page.streams.at(-1)!;
  for (const [state, attempts, approve, abort, say] of matrix) {
    stream.emit('job', detail({ ...A, state, mr_attempts: attempts }));
    page.$('say-input').value = 'draft';
    page.$('say-input').dispatch('input');
    const label = `${state}/${attempts}`;
    assert.equal(!page.$('approve-button').disabled, approve, `approve ${label}`);
    assert.equal(!page.$('abort-button').disabled, abort, `abort ${label}`);
    assert.equal(!page.$('say-input').disabled, say, `say input ${label}`);
    assert.equal(!page.$('say-button').disabled, say, `say button ${label}`);
    const reasons = page.$('action-reasons').textContent;
    assert.equal(reasons.includes('Approve:'), !approve, label);
    assert.equal(reasons.includes('Abort:'), !abort, label);
    assert.equal(page.$('say-reason').textContent !== '', !say, label);
  }
  // Send is off with an empty or blank draft.
  stream.emit('job', detail(A));
  for (const text of ['', '   \n\t']) {
    page.$('say-input').value = text;
    page.$('say-input').dispatch('input');
    assert.equal(page.$('say-button').disabled, true, JSON.stringify(text));
  }
  // The reasons name the rule for needs_human before an MR attempt.
  stream.emit('job', detail({ ...A, state: 'needs_human' }));
  assert.match(page.$('action-reasons').textContent, /Approve: approve can only retry an MR preparation/);
  // While approve is pending, approve is off with its own reason and abort stays on.
  stream.emit('job', detail(A));
  page.$('approve-button').click();
  page.$('confirm-ok').click();
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.equal(page.$('approve-button').disabled, true);
  assert.match(page.$('action-reasons').textContent, /Approve: MR preparation was requested/);
  assert.equal(page.$('abort-button').disabled, false);
  assert.match(status(page), /^MR preparation started; waiting for it to end/);
  assert.equal(page.$('action-status').className, 'status pending');
  // A state change meanwhile keeps the pending rule.
  stream.emit('job', detail({ ...A, state: 'preparing_mr', mr_attempts: 1 }));
  assert.equal(page.$('approve-button').disabled, true);
  assert.equal(page.$('abort-button').disabled, false);
  assert.equal(page.$('say-input').disabled, true);
});

test('client: approve and abort need a confirmation that names the job; cancel sends nothing; one request per confirmation', async () => {
  const page = await openPage();
  assert.equal(page.$('confirm').hidden, true);
  page.$('approve-button').click();
  assert.equal(page.$('confirm').hidden, false);
  assert.equal(page.$('confirm-title').textContent, 'Approve app/T-1?');
  assert.match(page.$('confirm-text').textContent, /branch T-1-demo.*rebases onto main.*pushes/);
  assert.equal(page.$('discard-label').hidden, true);
  assert.equal(page.$('confirm-ok').textContent, 'Approve: prepare and push');
  assert.equal(page.document.activeElement, page.$('confirm-cancel'));
  // Both action buttons are off while the confirmation is open: no retargeting.
  assert.equal(page.$('approve-button').disabled, true);
  assert.equal(page.$('abort-button').disabled, true);
  page.$('confirm-cancel').click();
  assert.equal(page.$('confirm').hidden, true);
  assert.equal(posts(page).length, 0);
  assert.equal(page.$('approve-button').disabled, false);
  page.$('approve-button').click();
  page.$('confirm').dispatch('keydown', { key: 'Escape' });
  assert.equal(page.$('confirm').hidden, true);
  assert.equal(posts(page).length, 0);

  page.$('approve-button').click();
  page.$('confirm-ok').click();
  page.$('confirm-ok').click();
  await page.flush();
  const [request] = posts(page);
  assert.equal(posts(page).length, 1);
  assert.deepEqual([request!.path, request!.body, request!.headers['content-type']], ['api/jobs/app/T-1/approve', '{}', 'application/json']);
  assert.equal(page.$('confirm').hidden, true);
  // A second click while pending opens nothing and sends nothing.
  page.$('approve-button').click();
  assert.equal(page.$('confirm').hidden, true);
  assert.equal(posts(page).length, 1);

  // Pushed with a link: the link is shown as text, to copy; the detail is refreshed.
  const before = page.requests.length;
  request!.respond(200, { ok: true, result: { state: 'pushed', branch: 'T-1-demo', title: 'feat(T-1): Demo', link: 'https://example.invalid/compare/main...T-1-demo' } });
  await page.flush();
  assert.equal(page.$('action-status').className, 'status ok');
  assert.equal(status(page), 'Pushed T-1-demo. feat(T-1): Demo Merge request: https://example.invalid/compare/main...T-1-demo');
  assert.equal(page.$('action-status').all().length, 0);
  assert.ok(page.requests.slice(before).some((entry) => entry.method === 'GET' && entry.path === 'api/jobs/app/T-1'));
  assert.equal(page.$('approve-button').disabled, false);

  // Every other outcome is reported as what it is, never as a success; nothing becomes an element.
  const outcomes: Array<[Record<string, unknown>, RegExp, string]> = [
    [{ state: 'pushed', branch: 'T-1-demo', title: 'feat(T-1): Demo' }, /No merge request link: the origin URL could not be parsed\. Open the merge request for branch T-1-demo by hand\./, 'ok'],
    [{ state: 'pushed', branch: 'T-1-demo', title: 't', link: 'javascript:alert(1)' }, /Merge request: javascript:alert\(1\)$/, 'ok'],
    [{ state: 'awaiting_review', branch: 'T-1-demo', changed_paths: ['b.txt', 'c.txt'] }, /^Not pushed: the prepared commit differs from the reviewed change in b\.txt, c\.txt\. It went back to the Context owner/, 'warn'],
    [{ state: 'needs_human', branch: 'T-1-demo', error: { code: 'mr_dirty', message: 'The work checkout has 1 uncommitted change(s).' } }, /^Not pushed: MR preparation failed \(mr_dirty: The work checkout has 1 uncommitted change\(s\)\.\)\. Fix it with a message below or by hand, then approve again\./, 'error'],
    [{ state: 'aborted', branch: 'T-1-demo' }, /^Not pushed: the job was aborted during MR preparation\./, 'warn'],
  ];
  for (const [result, expected, level] of outcomes) {
    page.$('approve-button').click();
    page.$('confirm-ok').click();
    await page.flush();
    posts(page).at(-1)!.respond(200, { ok: true, result });
    await page.flush();
    assert.match(status(page), expected);
    assert.equal(page.$('action-status').className, `status ${level}`);
    assert.equal(page.$('action-status').all().length, 0, JSON.stringify(result));
  }
  // A refusal shows its code and message; a network failure says the outcome is unknown.
  page.$('approve-button').click();
  page.$('confirm-ok').click();
  await page.flush();
  posts(page).at(-1)!.respond(409, { ok: false, error: { code: 'turn_running', message: 'A turn of the Implementer is running; wait for it to end.' } });
  await page.flush();
  assert.equal(status(page), 'turn_running: A turn of the Implementer is running; wait for it to end.');
  page.$('approve-button').click();
  page.$('confirm-ok').click();
  await page.flush();
  posts(page).at(-1)!.fail();
  await page.flush();
  assert.match(status(page), /^The request failed \(Failed to fetch\)\. Its outcome is unknown: it may have taken effect\. The state below is current/);
  assert.equal(page.requests.at(-1)!.path, 'api/jobs/app/T-1');
  // An answer that is not the factory's JSON (a rotated token's empty 404) is a definite refusal.
  page.$('approve-button').click();
  page.$('confirm-ok').click();
  await page.flush();
  posts(page).at(-1)!.respond(404, '');
  await page.flush();
  assert.match(status(page), /^http_404: The factory answered HTTP 404 without a result; nothing was done\./);
});

test('client: abort keeps the files unless discard is explicitly checked; the choice resets on every confirmation', async () => {
  const page = await openPage();
  page.$('abort-button').click();
  assert.equal(page.$('confirm-title').textContent, 'Abort app/T-1?');
  assert.match(page.$('confirm-text').textContent, /branch T-1-demo.*The branch and the files stay as they are\./);
  assert.equal(page.$('discard-label').hidden, false);
  assert.equal(page.$('discard').checked, false);
  assert.equal(page.$('confirm-ok').textContent, 'Abort, keep the files');
  page.$('discard').checked = true;
  page.$('discard').dispatch('change');
  assert.equal(page.$('confirm-ok').textContent, 'Abort and discard the branch');
  assert.equal(page.$('confirm-ok').className, 'btn btn-danger');
  page.$('confirm-cancel').click();
  assert.equal(posts(page).length, 0);

  // Opened again: unchecked; the plain abort sends discard false.
  page.$('abort-button').click();
  assert.equal(page.$('discard').checked, false);
  assert.equal(page.$('confirm-ok').className, 'btn btn-primary');
  page.$('confirm-ok').click();
  await page.flush();
  assert.deepEqual([posts(page)[0]!.path, posts(page)[0]!.body], ['api/jobs/app/T-1/abort', '{"discard":false}']);
  posts(page)[0]!.respond(200, { ok: true, result: { state: 'aborted', branch: 'T-1-demo', discarded: false } });
  await page.flush();
  assert.equal(status(page), 'Aborted; the branch T-1-demo and the files stay.');

  // The explicit discard sends true; its outcomes.
  page.streams.at(-1)!.emit('job', detail(A));
  page.$('abort-button').click();
  page.$('discard').checked = true;
  page.$('discard').dispatch('change');
  page.$('confirm-ok').click();
  await page.flush();
  assert.equal(posts(page)[1]!.body, '{"discard":true}');
  posts(page)[1]!.respond(200, { ok: true, result: { state: 'aborted', branch: 'T-1-demo', discarded: true } });
  await page.flush();
  assert.equal(status(page), 'Aborted; the branch T-1-demo and its changes were removed.');
  page.streams.at(-1)!.emit('job', detail(A));
  page.$('abort-button').click();
  page.$('discard').checked = true;
  page.$('confirm-ok').click();
  await page.flush();
  posts(page)[2]!.respond(200, { ok: true, result: { state: 'aborted', branch: 'T-1-demo', discarded: false, error: { code: 'discard_failed', message: 'git branch -D T-1-demo failed: not found. The work checkout needs a look.' } } });
  await page.flush();
  assert.match(status(page), /^The job ended \(aborted\), but discard failed: discard_failed: git branch -D T-1-demo failed: not found\. The work checkout needs a look\. The discard may be partial: look at the branch T-1-demo and the work checkout by hand/);
  assert.doesNotMatch(status(page), /were removed|were not removed/);
  assert.equal(page.$('action-status').className, 'status error');
  // A refusal of discard keeps the job and the draft choice visible as an error.
  page.streams.at(-1)!.emit('job', detail(A));
  page.$('abort-button').click();
  page.$('discard').checked = true;
  page.$('confirm-ok').click();
  await page.flush();
  posts(page)[3]!.respond(409, { ok: false, error: { code: 'rebase_in_progress', message: 'A rebase or a Git lock is in progress.' } });
  await page.flush();
  assert.equal(status(page), 'rebase_in_progress: A rebase or a Git lock is in progress.');
});

test('client: say sends the exact draft once per submission, keeps it on errors, clears only what was sent', async () => {
  const page = await openPage();
  const input = page.$('say-input');
  const message = 'Please  keep "quotes",\nnew lines — ünïcödé 🚀 ';
  input.value = message;
  input.dispatch('input');
  assert.equal(page.$('say-button').disabled, false);
  page.$('say-form').dispatch('submit');
  page.$('say-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.deepEqual([posts(page)[0]!.path, JSON.parse(posts(page)[0]!.body!)], ['api/jobs/app/T-1/say', { message }]);
  assert.equal(page.$('say-button').disabled, true);
  assert.match(page.$('say-reason').textContent, /the message is being sent/);
  assert.equal(input.disabled, false);
  // Edited while the request is out: the acknowledgement must not wipe the edit.
  input.value = `${message}and more`;
  input.dispatch('input');
  posts(page)[0]!.respond(200, { ok: true, result: { state: 'working', queued: true } });
  await page.flush();
  assert.match(status(page), /^Queued: the message runs after the current turn ends \(state working\); it has not run yet\./);
  assert.equal(input.value, `${message}and more`);
  assert.equal(page.$('say-button').disabled, false);

  // Sent unchanged: cleared on acknowledgement.
  page.$('say-form').dispatch('submit');
  await page.flush();
  posts(page)[1]!.respond(200, { ok: true, result: { state: 'working', queued: false } });
  await page.flush();
  assert.equal(status(page), 'Sent: the Implementer is working on it (state working).');
  assert.equal(input.value, '');
  assert.equal(page.$('say-button').disabled, true);

  // A refusal and a network failure keep the draft.
  input.value = 'again';
  input.dispatch('input');
  page.$('say-form').dispatch('submit');
  await page.flush();
  posts(page)[2]!.respond(400, { ok: false, error: { code: 'invalid_content', message: 'The message must be non-empty text.' } });
  await page.flush();
  assert.equal(status(page), 'invalid_content: The message must be non-empty text.');
  assert.equal(input.value, 'again');
  page.$('say-form').dispatch('submit');
  await page.flush();
  posts(page)[3]!.fail();
  await page.flush();
  assert.match(status(page), /outcome is unknown/);
  assert.equal(input.value, 'again');
  // A blank draft is never sent.
  input.value = '  \n';
  input.dispatch('input');
  page.$('say-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 4);
  // A state that refuses say disables the input but the draft survives for later.
  input.value = 'later';
  input.dispatch('input');
  page.streams.at(-1)!.emit('job', detail({ ...A, state: 'preparing_mr', mr_attempts: 1 }));
  assert.equal(input.disabled, true);
  page.streams.at(-1)!.emit('job', detail(A));
  assert.equal(input.value, 'later');
  assert.equal(input.disabled, false);
});

test('client: switching jobs keeps drafts and outcomes per job, closes a confirmation and ignores late results and details', async () => {
  const page = await openPage();
  const input = page.$('say-input');
  input.value = 'for T-1';
  input.dispatch('input');
  page.$('abort-button').click();
  assert.equal(page.$('confirm').hidden, false);

  // Select B: the confirmation closes with no request, the controls go off until B's detail
  // arrives, the draft shown is B's (none).
  await selectJob(page, 'app/T-2');
  assert.equal(page.$('confirm').hidden, true);
  assert.equal(posts(page).length, 0);
  assert.equal(input.value, '');
  assert.equal(page.$('approve-button').disabled, true);
  assert.equal(page.$('abort-button').disabled, true);
  assert.equal(input.disabled, true);
  assert.match(page.$('action-reasons').textContent, /the job is loading/);
  const streamB = page.streams.at(-1)!;
  assert.ok(streamB.url.includes('job=app%2FT-2'));
  streamB.emit('job', detail(B));
  assert.equal(page.$('job-ticket').textContent, 'T-2');
  assert.equal(page.$('approve-button').disabled, true);
  assert.equal(page.$('abort-button').disabled, false);
  assert.equal(input.disabled, false);
  // A late detail on A's old stream changes nothing.
  page.streams[0]!.emit('job', detail({ ...A, state: 'pushed' }));
  assert.equal(page.$('job-ticket').textContent, 'T-2');
  assert.equal(page.$('abort-button').disabled, false);

  // Confirm abort on B, switch to A before confirming: nothing is sent.
  page.$('abort-button').click();
  assert.equal(page.$('confirm-title').textContent, 'Abort app/T-2?');
  await selectJob(page, 'app/T-1');
  assert.equal(page.$('confirm').hidden, true);
  assert.equal(input.value, 'for T-1');
  page.streams.at(-1)!.emit('job', detail(A));

  // Send for A, switch to B while it is out: the answer goes to A only.
  page.$('say-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 1);
  await selectJob(page, 'app/T-2');
  page.streams.at(-1)!.emit('job', detail(B));
  input.value = 'for T-2';
  input.dispatch('input');
  assert.equal(status(page), '');
  posts(page)[0]!.respond(200, { ok: true, result: { state: 'working', queued: true } });
  await page.flush();
  assert.equal(status(page), '');
  assert.equal(input.value, 'for T-2');
  assert.equal(page.$('job-ticket').textContent, 'T-2');
  // A's say was acknowledged, so A's draft is gone and A's outcome is shown when A comes back.
  await selectJob(page, 'app/T-1');
  assert.equal(input.value, '');
  assert.match(status(page), /^Queued:/);
  page.streams.at(-1)!.emit('job', detail(A));
  assert.equal(page.$('say-button').disabled, true);

  // An approve for A answered after switching to B leaves B's controls and status alone.
  page.$('approve-button').click();
  page.$('confirm-ok').click();
  await page.flush();
  await selectJob(page, 'app/T-2');
  page.streams.at(-1)!.emit('job', detail(B));
  posts(page)[1]!.respond(200, { ok: true, result: { state: 'needs_human', branch: 'T-1-demo', error: { code: 'mr_dirty', message: 'dirty' } } });
  await page.flush();
  assert.equal(status(page), '');
  assert.equal(page.$('abort-button').disabled, false);
  assert.equal(page.$('approve-button').disabled, true);
  await selectJob(page, 'app/T-1');
  assert.match(status(page), /^Not pushed: MR preparation failed \(mr_dirty: dirty\)/);
  // The refresh after the answer was for A; it never rendered into B.
  assert.ok(page.requests.some((request) => request.method === 'GET' && request.path === 'api/jobs/app/T-1'));
});

test('client: an action answer that cannot be read is an unknown outcome, not a refusal; only a 4xx without JSON is definite', async () => {
  const hold = { on: false };
  const page = await openPage(undefined, hold);
  const input = page.$('say-input');
  // HTTP 200 headers, then the body is cut: the message may have been delivered.
  await sendDraft(page, 'exactly once');
  posts(page)[0]!.failBody(200);
  await page.flush();
  assert.match(status(page), /outcome is unknown/);
  assert.doesNotMatch(status(page), /nothing was done|Sending/);
  assert.equal(input.value, 'exactly once');
  assert.equal(refreshes(page).length, 1);
  assert.equal(posts(page).length, 1);

  // The same for a truncated or foreign 2xx, an empty 5xx and an internal failure.
  const unknown: Array<(request: FetchRequest) => void> = [
    (request) => request.respond(200, '{"ok":tr'),
    (request) => request.respond(200, { ok: false }),
    (request) => request.respond(200, { ok: true }),
    (request) => request.respond(500, ''),
    (request) => request.respond(500, { ok: false, error: { code: 'internal_error', message: 'The request failed inside the factory.' } }),
  ];
  for (const [index, answer] of unknown.entries()) {
    page.$('say-form').dispatch('submit');
    await page.flush();
    answer(posts(page)[index + 1]!);
    await page.flush();
    assert.match(status(page), /outcome is unknown/, String(index));
    assert.equal(input.value, 'exactly once', String(index));
  }
  assert.equal(posts(page).length, 6);

  // A 4xx is definite, even with an empty or an unreadable body; the draft stays and no hold.
  hold.on = true;
  const definite = [
    (request: FetchRequest) => request.respond(404, ''),
    (request: FetchRequest) => request.failBody(409),
    (request: FetchRequest) => request.respond(500, { ok: false, error: { code: 'fetch_failed', message: 'nothing was done: git fetch failed.' } }),
  ];
  for (const answer of definite) {
    page.$('say-form').dispatch('submit');
    await page.flush();
    answer(posts(page).at(-1)!);
    await page.flush();
    assert.match(status(page), /nothing was done/);
    assert.equal(input.value, 'exactly once');
    assert.equal(page.$('say-button').disabled, false);
  }
});

test('client: after an unknown outcome the controls wait for a current state; a failed refresh stays visible and resolves by hand or by the stream', async () => {
  const hold = { on: true };
  const page = await openPage(undefined, hold);
  const stream = page.streams.at(-1)!;
  assertControls(page, 'before', true, true, false);
  await sendDraft(page, 'once');
  posts(page)[0]!.fail();
  await page.flush();

  // The refresh is out: nothing can be sent or opened, the draft stays.
  assert.equal(refreshes(page).length, 1);
  assertControls(page, 'refreshing', false, false, false);
  page.$('say-form').dispatch('submit');
  page.$('approve-button').click();
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.equal(page.$('confirm').hidden, true);
  assert.equal(page.$('say-input').value, 'once');
  assert.match(page.$('action-reasons').textContent, /outcome is unknown/);
  // The stream alone does not resolve it: a queued message changes no state.
  stream.emit('job', detail(A));
  assertControls(page, 'stream while refreshing', false, false, false);

  // The refresh fails: it says so, the controls stay off, and a button offers the read again.
  refreshes(page)[0]!.fail();
  await page.flush();
  assert.match(status(page), /current state could not be loaded/);
  assertControls(page, 'refresh failed', false, false, false);
  assert.equal(page.$('refresh-button').hidden, false);

  // Isolation: the other job's controls are its own; coming back keeps the unresolved state.
  await selectJob(page, 'app/T-2');
  assert.equal(page.$('refresh-button').hidden, true);
  page.streams.at(-1)!.emit('job', detail(B));
  assert.equal(page.$('abort-button').disabled, false);
  assert.equal(status(page), '');
  await selectJob(page, 'app/T-1');
  assert.equal(page.$('refresh-button').hidden, false);
  assert.match(status(page), /current state could not be loaded/);

  // The stream's job event (a reconnect sends one) tries the read again; it fails too.
  const live = page.streams.at(-1)!;
  live.emit('job', detail(A));
  await page.flush();
  assert.equal(refreshes(page).length, 2);
  assertControls(page, 'retrying', false, false, false);
  refreshes(page)[1]!.respond(503, '');
  await page.flush();
  assertControls(page, 'failed again', false, false, false);

  // Two quick clicks are one read.
  page.$('refresh-button').click();
  page.$('refresh-button').click();
  await page.flush();
  assert.equal(refreshes(page).length, 3);
  refreshes(page)[2]!.fail();
  await page.flush();

  // By hand: the read succeeds, the current state decides, the draft is still there, nothing was replayed.
  page.$('refresh-button').click();
  await page.flush();
  assert.equal(refreshes(page).length, 4);
  assert.equal(page.$('refresh-button').hidden, true);
  refreshes(page)[3]!.respond(200, detail({ ...A, state: 'working' }));
  await page.flush();
  assert.equal(page.$('job-state').textContent, 'working');
  assertControls(page, 'resolved', false, true, true);
  assert.match(status(page), /outcome is unknown.*state below is current/s);
  assert.equal(page.$('say-input').value, 'once');
  assert.equal(posts(page).length, 1);
  // A deliberate send is possible again.
  page.$('say-form').dispatch('submit');
  await page.flush();
  assert.equal(posts(page).length, 2);
});

test('client: an unknown outcome keeps abort for a known preparation, closes a stale confirmation, and only a refresh started after it resolves it', async () => {
  const hold = { on: true };
  const page = await openPage(undefined, hold);
  const stream = page.streams.at(-1)!;

  // A plain refresh is out when the unknown outcome arrives; its late answer proves nothing.
  page.$('approve-button').click();
  page.$('confirm-ok').click();
  await page.flush();
  posts(page)[0]!.respond(409, { ok: false, error: { code: 'turn_running', message: 'busy' } });
  await page.flush();
  assert.equal(refreshes(page).length, 1);
  await sendDraft(page, 'x');
  page.$('abort-button').click();
  assert.equal(page.$('confirm').hidden, false);
  posts(page)[1]!.fail();
  await page.flush();
  // The open confirmation goes with the certainty it was opened on.
  assert.equal(page.$('confirm').hidden, true);
  assert.equal(refreshes(page).length, 2);
  refreshes(page)[0]!.respond(200, detail(A));
  await page.flush();
  assertControls(page, 'stale refresh', false, false, false);
  refreshes(page)[1]!.respond(200, detail(A));
  await page.flush();
  assertControls(page, 'own refresh', true, true, true);

  // An approve is out and a say fails: approve stays pending, abort stays on, an open abort
  // confirmation stays, and it can be sent.
  page.$('approve-button').click();
  page.$('confirm-ok').click();
  await page.flush();
  page.$('say-form').dispatch('submit');
  await page.flush();
  page.$('abort-button').click();
  const approve = posts(page)[2]!;
  posts(page)[3]!.fail();
  await page.flush();
  assert.equal(page.$('confirm').hidden, false);
  page.$('confirm-ok').click();
  await page.flush();
  assert.equal(posts(page)[4]!.body, '{"discard":false}');
  posts(page)[4]!.respond(200, { ok: true, result: { state: 'aborted', branch: 'T-1-demo', discarded: false } });
  approve.respond(200, { ok: true, result: { state: 'aborted', branch: 'T-1-demo' } });
  await page.flush();
  // The definite answer and the unknown outcome are both shown, before and after the refresh.
  assert.match(status(page), /^Not pushed: the job was aborted[^]*outcome is unknown: the state below is being refreshed/);
  for (const request of refreshes(page)) {
    request.respond(200, detail({ ...A, state: 'aborted' }));
  }
  await page.flush();
  assert.match(status(page), /^Not pushed: the job was aborted[^]*outcome is unknown: it may have taken effect/);

  // A lost approve request with the preparation visible on the stream: abort stays reachable.
  stream.emit('job', detail(A));
  await page.flush();
  for (const request of refreshes(page)) {
    request.respond(200, detail(A));
  }
  await page.flush();
  const before = refreshes(page).length;
  page.$('approve-button').click();
  page.$('confirm-ok').click();
  await page.flush();
  posts(page).at(-1)!.fail();
  await page.flush();
  assert.equal(refreshes(page).length, before + 1);
  assertControls(page, 'approve lost', false, false, false);
  stream.emit('job', detail({ ...A, state: 'preparing_mr', mr_attempts: 1 }));
  assert.equal(page.$('abort-button').disabled, false);
  assert.equal(page.$('approve-button').disabled, true);
});

test('client: the hold has no way around it: an open confirmation closes when it stops being allowed, a later unknown outcome keeps it, a hung read ends', async () => {
  const hold = { on: true };
  const page = await openPage(undefined, hold);
  // Approve out, abort confirmation open, a say fails: abort is kept for the preparation...
  page.$('approve-button').click();
  page.$('confirm-ok').click();
  await page.flush();
  await sendDraft(page, 'x');
  page.$('abort-button').click();
  posts(page)[1]!.fail();
  await page.flush();
  assert.equal(page.$('confirm').hidden, false);
  // ...until the approve ends definitely: the confirmation goes, nothing can be sent through it.
  posts(page)[0]!.respond(200, { ok: true, result: { state: 'needs_human', branch: 'T-1-demo', error: { code: 'mr_dirty', message: 'dirty' } } });
  await page.flush();
  assert.equal(page.$('confirm').hidden, true);
  page.$('confirm-ok').click();
  await page.flush();
  assert.equal(posts(page).length, 2);
  for (const request of refreshes(page)) {
    request.respond(200, detail(A));
  }
  await page.flush();

  // A later unknown outcome overtakes the read of an earlier one.
  page.$('approve-button').click();
  page.$('confirm-ok').click();
  await page.flush();
  page.$('say-form').dispatch('submit');
  await page.flush();
  posts(page)[3]!.fail();
  await page.flush();
  page.$('abort-button').click();
  page.$('confirm-ok').click();
  await page.flush();
  posts(page)[4]!.fail();
  await page.flush();
  const [overtaken, current] = refreshes(page).slice(-2);
  overtaken!.respond(200, detail(A));
  await page.flush();
  assert.equal(page.$('say-button').disabled, true);
  assert.match(page.$('say-reason').textContent, /outcome is unknown/);
  current!.respond(200, detail(A));
  await page.flush();
  assert.equal(page.$('say-button').disabled, false);
});

test('client: a read that never answers becomes a failed refresh; the warning stays until the next action, whatever is answered meanwhile', async () => {
  const hold = { on: true };
  const page = await openPage(undefined, hold);
  await sendDraft(page, 'x');
  posts(page)[0]!.fail();
  await page.flush();
  assert.equal(page.$('refresh-button').hidden, true);
  const timer = page.timers.find((entry) => entry.ms === 10000 && !entry.cleared)!;
  timer.fire();
  await page.flush();
  assert.match(status(page), /current state could not be loaded \(no answer in time\)/);
  assert.equal(page.$('refresh-button').hidden, false);
  assertControls(page, 'timed out', false, false, false);
  // The late answer of that read changes nothing; the button's read works.
  refreshes(page)[0]!.respond(200, detail(A));
  await page.flush();
  assertControls(page, 'late answer', false, false, false);
  page.$('refresh-button').click();
  await page.flush();
  refreshes(page)[1]!.respond(200, detail(A));
  await page.flush();
  assert.equal(page.timers.filter((entry) => entry.ms === 10000 && !entry.cleared).length, 0);

  // The warning of the lifted hold stays; a new deliberate action starts clean.
  assert.match(status(page), /outcome is unknown/);
  page.$('abort-button').click();
  page.$('discard').checked = true;
  page.$('confirm-ok').click();
  await page.flush();
  assert.doesNotMatch(status(page), /outcome is unknown/);
  posts(page)[1]!.respond(200, { ok: true, result: { state: 'aborted', branch: 'T-1-demo', discarded: false, error: { code: 'discard_failed', message: 'failed.' } } });
  await page.flush();
  assert.match(status(page), /discard failed/);
});

// The detail with a reviewer, as the server sends it.
const SETUP = { guide: 'Call guide.', instruction: 'When you receive the event software_factory.job for ticket T-1 …' };
const OWN = { status: 'subscribed', id: 'sub_own', host: 'chatgpt.example', input: { workspace: 'app', ticket: 'T-1' }, broad: [] as string[] };
function reviewed(shape: JobShape, reviewer: Record<string, unknown>) {
  return { ...detail(shape), reviewer, reviewerSetup: { ...SETUP, instruction: SETUP.instruction.replace('T-1', shape.ticket) } };
}
const testPosts = (page: Page): FetchRequest[] => posts(page).filter((request) => request.path.endsWith('/test-event'));

test('client: the Reviewer block for subscribed, none, broad and subscribed with broad ones; the setup boxes only for none', async () => {
  const page = await openPage();
  const stream = page.streams.at(-1)!;
  // A detail without a reviewer (an older server) shows no block.
  assert.equal(page.$('reviewer').hidden, true);

  stream.emit('job', reviewed(A, OWN));
  assert.equal(page.$('reviewer').hidden, false);
  assert.equal(page.$('reviewer-line').textContent, 'Reviewer: subscribed sub_own, chatgpt.example, filter {"workspace":"app","ticket":"T-1"}');
  assert.equal((page.$('reviewer-line').children[0] as FakeElement).className, 'r-subscribed');
  assert.equal(page.$('reviewer-warning').hidden, true);
  assert.equal(page.$('reviewer-setup').hidden, true);

  stream.emit('job', reviewed(A, { status: 'none' }));
  assert.equal(page.$('reviewer-line').textContent, 'Reviewer: none Nobody will review this job.');
  assert.equal((page.$('reviewer-line').children[0] as FakeElement).className, 'r-none');
  assert.equal(page.$('reviewer-setup').hidden, false);
  assert.equal(page.$('setup-guide').value, 'Call guide.');
  assert.equal(page.$('setup-instruction').value, SETUP.instruction);
  assert.equal(page.$('reviewer-warning').hidden, true);

  stream.emit('job', reviewed(A, { status: 'broad', id: 'sub_app', host: 'chatgpt.example', input: { workspace: 'app' }, broad: ['sub_app', 'sub_all'] }));
  assert.equal(page.$('reviewer-line').textContent, 'Reviewer: broad sub_app, chatgpt.example, filter {"workspace":"app"}');
  assert.equal((page.$('reviewer-line').children[0] as FakeElement).className, 'r-broad');
  assert.equal(page.$('reviewer-warning').hidden, false);
  assert.match(page.$('reviewer-warning').textContent, /sub_app, sub_all has no ticket filter/);
  assert.match(page.$('reviewer-warning').textContent, /sf events remove sub_app; sf events remove sub_all/);
  assert.equal(page.$('reviewer-setup').hidden, true);
  assert.equal(page.$('setup-guide').value, '');

  stream.emit('job', reviewed(A, { ...OWN, broad: ['sub_all'] }));
  assert.match(page.$('reviewer-line').textContent, /^Reviewer: subscribed sub_own/);
  assert.equal(page.$('reviewer-warning').hidden, false);
  assert.match(page.$('reviewer-warning').textContent, /sub_all\. ChatGPT would review it twice\. Remove with: sf events remove sub_all$/);
  assert.equal(page.$('reviewer-setup').hidden, true);
});

test('client: the Copy buttons write the setup message to the clipboard, or select it when there is none', async () => {
  const copied: string[] = [];
  const withClipboard = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs: [job(A)] } : undefined), { writeText: async (text) => void copied.push(text) });
  withClipboard.document.dispatch('DOMContentLoaded');
  await withClipboard.flush();
  withClipboard.streams.at(-1)!.emit('job', reviewed(A, { status: 'none' }));
  withClipboard.$('copy-instruction').click();
  await withClipboard.flush();
  withClipboard.$('copy-guide').click();
  await withClipboard.flush();
  assert.deepEqual(copied, [SETUP.instruction, 'Call guide.']);
  assert.equal(withClipboard.$('copy-status').textContent, 'Copied.');

  // No clipboard, or one that refuses: the text is selected for Ctrl+C.
  const page = await openPage();
  page.streams.at(-1)!.emit('job', reviewed(A, { status: 'none' }));
  page.$('copy-guide').click();
  assert.equal(page.$('setup-guide').selected, true);
  assert.equal(page.document.activeElement, page.$('setup-guide'));
  assert.equal(page.$('copy-status').textContent, 'Selected: press Ctrl+C to copy.');
  const refusing = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs: [job(A)] } : undefined), { writeText: async () => Promise.reject(new Error('denied')) });
  refusing.document.dispatch('DOMContentLoaded');
  await refusing.flush();
  refusing.streams.at(-1)!.emit('job', reviewed(A, { status: 'none' }));
  refusing.$('copy-instruction').click();
  await refusing.flush();
  assert.equal(refusing.$('setup-instruction').selected, true);
  assert.match(refusing.$('copy-status').textContent, /press Ctrl\+C/);
});

test('client: Send test event only when subscribed, one request at a time, the outcome or the error as text, never retried', async () => {
  const page = await openPage();
  const stream = page.streams.at(-1)!;
  const button = page.$('test-event-button');
  for (const reviewer of [{ status: 'none' }, { status: 'broad', id: 'sub_all', host: 'h', input: {}, broad: ['sub_all'] }]) {
    stream.emit('job', reviewed(A, reviewer));
    assert.equal(button.disabled, true, reviewer.status);
    assert.match(page.$('test-event-reason').textContent, /needs a subscription filtered on this ticket/);
    button.click();
  }
  await page.flush();
  assert.equal(testPosts(page).length, 0);

  stream.emit('job', reviewed(A, OWN));
  assert.equal(button.disabled, false);
  assert.equal(page.$('test-event-reason').textContent, '');
  button.click();
  await page.flush();
  assert.equal(testPosts(page).length, 1);
  const sent = testPosts(page)[0]!;
  assert.deepEqual([sent.path, sent.body, sent.headers['content-type']], ['api/jobs/app/T-1/test-event', '{}', 'application/json']);
  assert.equal(page.$('test-event-status').textContent, 'Sending…');
  assert.equal(button.disabled, true);
  // A detail arriving meanwhile keeps it off.
  stream.emit('job', reviewed(A, OWN));
  assert.equal(button.disabled, true);
  button.click();
  await page.flush();
  assert.equal(testPosts(page).length, 1);
  sent.respond(200, { ok: true, result: { subscription: 'sub_own', delivered: true, status: 200 } });
  await page.flush();
  assert.match(page.$('test-event-status').textContent, /^Test event to sub_own: delivered, status 200\./);
  assert.equal(page.$('test-event-status').className, 'status ok');
  assert.equal(button.disabled, false);

  button.click();
  await page.flush();
  testPosts(page)[1]!.respond(200, { ok: true, result: { subscription: 'sub_own', delivered: false, status: 'timeout' } });
  await page.flush();
  assert.equal(page.$('test-event-status').textContent, 'Test event to sub_own: not delivered, status timeout.');
  assert.equal(page.$('test-event-status').className, 'status error');

  button.click();
  await page.flush();
  testPosts(page)[2]!.respond(404, { ok: false, error: { code: 'no_subscription', message: 'No subscription is filtered on T-1.' } });
  await page.flush();
  assert.equal(page.$('test-event-status').textContent, 'no_subscription: No subscription is filtered on T-1.');

  button.click();
  await page.flush();
  testPosts(page)[3]!.fail();
  await page.flush();
  assert.match(page.$('test-event-status').textContent, /^The test event failed \(Failed to fetch\); it may have been sent\. Nothing is retried\./);
  assert.equal(testPosts(page).length, 4);
  assert.equal(page.timers.filter((timer) => !timer.cleared).length, 0);
  // The approve, abort and say controls never took part.
  assert.equal(page.$('action-status').textContent, '');
});

test('client: a late test-event answer lands on its own job only; each job keeps its outcome', async () => {
  const page = await openPage();
  page.streams.at(-1)!.emit('job', reviewed(A, OWN));
  page.$('test-event-button').click();
  await page.flush();
  assert.equal(testPosts(page).length, 1);

  await selectJob(page, 'app/T-2');
  assert.equal(page.$('reviewer').hidden, true);
  page.streams.at(-1)!.emit('job', reviewed(B, { ...OWN, id: 'sub_b', input: { ticket: 'T-2' } }));
  assert.equal(page.$('test-event-status').textContent, '');
  assert.equal(page.$('test-event-button').disabled, false);
  testPosts(page)[0]!.respond(200, { ok: true, result: { subscription: 'sub_own', delivered: true, status: 200 } });
  await page.flush();
  assert.equal(page.$('test-event-status').textContent, '');
  assert.equal(page.$('test-event-button').disabled, false);
  assert.equal(page.$('job-ticket').textContent, 'T-2');

  await selectJob(page, 'app/T-1');
  page.streams.at(-1)!.emit('job', reviewed(A, OWN));
  assert.match(page.$('test-event-status').textContent, /^Test event to sub_own: delivered/);
});

test('client: the job cards badge a missing or broad reviewer; the Subscriptions section follows the stream', async () => {
  const page = await openPage();
  const stream = page.streams.at(-1)!;
  // Before the first subscriptions event: neither the table nor "No subscriptions.".
  assert.deepEqual([page.$('no-subscriptions').hidden, page.$('subscriptions-table').hidden], [true, true]);
  stream.emit('jobs', { jobs: [{ ...job(A), reviewer: 'none' }, { ...job(B), reviewer: 'broad' }, { ...job({ ...B, ticket: 'T-3' }), reviewer: 'subscribed' }, { ...job({ ...B, ticket: 'T-4', state: 'pushed' }), reviewer: 'none' }] });
  const badges = (key: string): string[] => jobButton(page, key).all().filter((node) => node.className.startsWith('badge')).map((node) => `${node.className}:${node.textContent}`);
  assert.deepEqual(badges('app/T-1'), ['badge s-awaiting_review:awaiting_review', 'badge r-none:no reviewer']);
  assert.deepEqual(badges('app/T-2'), ['badge s-working:working', 'badge r-broad:broad']);
  // A finished job has nothing to review: no reviewer badge.
  assert.deepEqual(badges('app/T-4'), ['badge s-pushed:pushed']);
  assert.deepEqual(badges('app/T-3'), ['badge s-working:working']);

  stream.emit('subscriptions', { subscriptions: [] });
  assert.deepEqual([page.$('no-subscriptions').hidden, page.$('subscriptions-table').hidden], [false, true]);
  stream.emit('subscriptions', {
    subscriptions: [
      { id: 'sub_own', principal: 'user-1', input: { workspace: 'app', ticket: 'T-1' }, host: 'chatgpt.example', createdAt: '2026-11-01T09:00:00.000Z', refreshBefore: '2026-11-08T09:00:00.000Z', job: 'app/T-1' },
      { id: 'sub_all', principal: 'user-1', input: {}, host: '<b>x</b>', createdAt: '2026-11-01T09:00:00.000Z', refreshBefore: '2026-11-08T09:00:00.123Z', job: null },
    ],
  });
  assert.deepEqual([page.$('no-subscriptions').hidden, page.$('subscriptions-table').hidden], [true, false]);
  const rows = page.$('subscriptions-body').children.map((row) => (row as FakeElement).children.map((cell) => cell.textContent));
  assert.deepEqual(rows, [
    ['sub_own', '{"workspace":"app","ticket":"T-1"}', 'chatgpt.example', '2026-11-08 09:00:00Z', 'app/T-1'],
    ['sub_all', '{}', '<b>x</b>', '2026-11-08 09:00:00Z', '–'],
  ]);
  stream.emit('subscriptions', { subscriptions: [] });
  assert.equal(page.$('subscriptions-body').children.length, 0);
  assert.equal(page.$('no-subscriptions').hidden, false);
});

test('client: the job views are tabs; the selected one is kept across jobs; the MR tab says when there is no text', async () => {
  const page = await openPage();
  const tabs = page.$('job-tabs').querySelectorAll('button');
  assert.deepEqual(tabs.map((button) => button.textContent), ['Iterations', 'Merge request', 'State history', 'Event stream']);
  assert.deepEqual(tabs.map((button) => button.getAttribute('aria-selected')), ['true', 'false', 'false', 'false']);
  assert.deepEqual(['tab-iterations', 'tab-mr', 'tab-history', 'tab-events'].map((id) => page.$(id).hidden), [false, true, true, true]);
  assert.equal(page.$('no-mr').hidden, false);
  assert.equal(page.$('mr-panel').hidden, true);
  tabs[1]!.click();
  assert.deepEqual(['tab-iterations', 'tab-mr', 'tab-history', 'tab-events'].map((id) => page.$(id).hidden), [true, false, true, true]);
  assert.equal(tabs[1]!.getAttribute('aria-selected'), 'true');
  // The MR text, once there is one, replaces the note.
  page.streams.at(-1)!.emit('job', { ...detail(A), mr: true });
  await page.flush();
  page.requests.filter((request) => request.method === 'GET' && request.path === 'api/jobs/app/T-1/mr').at(-1)!.respond(200, 'feat(T-1): Demo\n\n## What\nIt.\n');
  await page.flush();
  assert.equal(page.$('no-mr').hidden, true);
  assert.equal(page.$('mr-panel').hidden, false);
  assert.equal(page.$('mr-body').textContent, 'feat(T-1): Demo\n\n## What\nIt.\n\n');
  // Another job keeps the tab.
  await selectJob(page, 'app/T-2');
  assert.equal(tabs[1]!.getAttribute('aria-selected'), 'true');
  assert.equal(page.$('tab-mr').hidden, false);
  page.streams.at(-1)!.emit('job', detail(B));
  await page.flush();
  assert.equal(page.$('no-mr').hidden, false);
  assert.equal(page.$('mr-panel').hidden, true);
  tabs[3]!.click();
  assert.equal(page.$('tab-events').hidden, false);
  assert.equal(page.$('tab-mr').hidden, true);
});
