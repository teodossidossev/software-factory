// Behaviour of static/app.js, run under node:vm against the fake page of test/support/fake-dom.ts:
// the action matrix per state, the confirmations (cancel, discard, double submission), the say
// draft rules, the outcome texts and what happens when the selection changes while a request is
// out, the job views and the reviews. These are script checks, not browser acceptance: the
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
  // The prepared branch tip (set for ready_for_human_review and a failed push) and the worktree.
  prepared_commit?: string | null;
  worktree?: string | null;
}

function job(shape: JobShape) {
  const prepared = shape.state === 'ready_for_human_review' || shape.state === 'pushed';
  return {
    workspace: shape.workspace, ticket: shape.ticket, branch: `${shape.ticket}-demo`, base: 'main', state: shape.state,
    iteration: shape.iteration ?? 1, mr_attempts: shape.mr_attempts ?? 0, updated_at: shape.updated_at ?? '2026-11-01T10:05:00.000Z',
    created_at: '2026-11-01T10:00:00.000Z', error: null,
    prepared_commit: shape.prepared_commit !== undefined ? shape.prepared_commit : (prepared ? 'a'.repeat(40) : null),
    worktree: shape.worktree !== undefined ? shape.worktree : (prepared ? null : `/wt/${shape.ticket}`),
    files: 0, undeclared: 0, deleted: 0,
  };
}

function detail(shape: JobShape) {
  return { job: job(shape), iterations: [], mr: false, history: [{ ts: '2026-11-01T10:00:00.000Z', from: null, to: 'starting' }] };
}

// A is the job the user acts on: ready_for_human_review, the branch prepared at Clean.
const A = { workspace: 'app', ticket: 'T-1', state: 'ready_for_human_review', updated_at: '2026-11-01T10:05:00.000Z' };
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
  const matrix: Array<[string, number, boolean, boolean, boolean, Partial<JobShape>?]> = [
    // state, mr_attempts, approve on, abort on, say on
    ['starting', 0, false, true, false],
    ['working', 0, false, true, true],
    ['awaiting_review', 0, false, true, true],
    ['needs_human', 0, false, true, true],
    ['needs_human', 1, false, true, true],
    // A failed push: the branch is prepared and the worktree gone, so approve can retry.
    ['needs_human', 1, true, true, true, { prepared_commit: 'b'.repeat(40), worktree: null }],
    ['ready_for_human_review', 0, true, true, true],
    ['preparing_mr', 1, false, true, false],
    ['pushed', 1, false, false, false],
    ['aborted', 0, false, false, false],
    ['failed', 0, false, false, false],
  ];
  const stream = page.streams.at(-1)!;
  for (const [state, attempts, approve, abort, say, extra] of matrix) {
    stream.emit('job', detail({ ...A, state, mr_attempts: attempts, ...(extra ?? {}) }));
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
  // The reasons name the rule for needs_human without a prepared branch, and for awaiting_review.
  stream.emit('job', detail({ ...A, state: 'needs_human' }));
  assert.match(page.$('action-reasons').textContent, /Approve: approve pushes a branch prepared at Clean; this job has none yet\./);
  stream.emit('job', detail({ ...A, state: 'awaiting_review' }));
  assert.match(page.$('action-reasons').textContent, /Approve: the reviewers have not reached Clean yet\./);
  // While approve is pending, approve is off with its own reason and abort stays on.
  stream.emit('job', detail(A));
  page.$('approve-button').click();
  page.$('confirm-ok').click();
  await page.flush();
  assert.equal(posts(page).length, 1);
  assert.equal(page.$('approve-button').disabled, true);
  assert.match(page.$('action-reasons').textContent, /Approve: the push was requested/);
  assert.equal(page.$('abort-button').disabled, false);
  assert.match(status(page), /^Pushing the branch…/);
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
  assert.match(page.$('confirm-text').textContent, /Pushes branch T-1-demo to origin.*prepared at Clean, rebased onto main/);
  assert.equal(page.$('discard-label').hidden, true);
  assert.equal(page.$('as-is-label').hidden, false);
  assert.equal(page.$('as-is').checked, false);
  assert.equal(page.$('confirm-ok').textContent, 'Approve: push the branch');
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
    [{ state: 'needs_human', branch: 'T-1-demo', error: { code: 'mr_push_failed', message: 'git push origin T-1-demo failed: rejected.' } }, /^Not pushed: the push failed \(mr_push_failed: git push origin T-1-demo failed: rejected\.\)\. Fix it, then approve again\./, 'error'],
    [{ state: 'aborted', branch: 'T-1-demo' }, /^Not pushed: the job is aborted\./, 'warn'],
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
  assert.match(page.$('confirm-text').textContent, /branch T-1-demo.*The branch and its worktree stay as they are\./);
  assert.equal(page.$('as-is-label').hidden, true);
  assert.equal(page.$('discard-label').hidden, false);
  assert.equal(page.$('discard').checked, false);
  assert.equal(page.$('confirm-ok').textContent, 'Abort, keep the worktree');
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
  assert.equal(status(page), 'Aborted; the branch T-1-demo stays.');

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
  assert.equal(status(page), 'Aborted; the branch T-1-demo, its worktree and its changes were removed.');
  page.streams.at(-1)!.emit('job', detail(A));
  page.$('abort-button').click();
  page.$('discard').checked = true;
  page.$('confirm-ok').click();
  await page.flush();
  posts(page)[2]!.respond(200, { ok: true, result: { state: 'aborted', branch: 'T-1-demo', discarded: false, error: { code: 'discard_failed', message: 'git branch -D T-1-demo failed: not found. The work checkout needs a look.' } } });
  await page.flush();
  assert.match(status(page), /^The job ended \(aborted\), but discard failed: discard_failed: git branch -D T-1-demo failed: not found\. The work checkout needs a look\. The discard may be partial: look at the branch T-1-demo and the worktree by hand/);
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
  posts(page)[1]!.respond(200, { ok: true, result: { state: 'needs_human', branch: 'T-1-demo', error: { code: 'mr_push_failed', message: 'rejected' } } });
  await page.flush();
  assert.equal(status(page), '');
  assert.equal(page.$('abort-button').disabled, false);
  assert.equal(page.$('approve-button').disabled, true);
  await selectJob(page, 'app/T-1');
  assert.match(status(page), /^Not pushed: the push failed \(mr_push_failed: rejected\)/);
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
  assert.match(status(page), /^Not pushed: the job is aborted[^]*outcome is unknown: the state below is being refreshed/);
  for (const request of refreshes(page)) {
    request.respond(200, detail({ ...A, state: 'aborted' }));
  }
  await page.flush();
  assert.match(status(page), /^Not pushed: the job is aborted[^]*outcome is unknown: it may have taken effect/);

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

// The Files view (SF-024): the rows in IntelliJ's shape and order, the diff of one file on
// demand from the loaded Patch, the badges on the job card and in the list.
test('client: the Files view lists sensitive, deleted and the rest in order, expands one file\'s diff from the Patch, and the badges count them', async () => {
  const files = [
    { path: 'src/zeta.ts', status: 'modified', sensitive: 'no', additions: 2, deletions: 1 },
    { path: 'package.json', status: 'modified', sensitive: 'declared', additions: 1, deletions: 1 },
    { path: 'src/old.ts', status: 'deleted', sensitive: 'no', additions: 0, deletions: 3 },
    { path: '.github/workflows/ci.yml', status: 'added', sensitive: 'undeclared', additions: 5, deletions: 0 },
    { path: 'lib/alpha.ts', status: 'added', sensitive: 'no', additions: 1, deletions: 0 },
    { path: 'img.png', status: 'added', sensitive: 'no', additions: 0, deletions: 0 },
  ];
  const patch = [
    'diff --git a/src/zeta.ts b/src/zeta.ts', 'index 1..2 100644', '--- a/src/zeta.ts', '+++ b/src/zeta.ts', '@@ -1,2 +1,3 @@', '-old', '+new', '+more', ' same',
    'diff --git a/src/old.ts b/src/old.ts', 'deleted file mode 100644', '--- a/src/old.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-a', '-b', '-c',
    'diff --git a/lib/alpha.ts b/lib/alpha.ts', 'new file mode 100644', '--- /dev/null', '+++ b/lib/alpha.ts', '@@ -0,0 +1 @@', '+alpha', '',
  ].join('\n');
  const withFiles = (shape: JobShape) => ({
    ...detail(shape),
    job: { ...job(shape), files: 6, undeclared: 1, deleted: 1 },
    iterations: [{ number: 1, started_at: '2026-11-01T10:00:01.000Z', ended_at: '2026-11-01T10:05:00.000Z', cost_usd: 0.5, changed_files: 6, patch_truncated: false, denials: 0, files }],
  });
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs: [{ ...job(A), files: 6, undeclared: 1, deleted: 1 }] };
    }
    if (path === 'api/jobs/app/T-1') {
      return withFiles(A);
    }
    return path === 'api/jobs/app/T-1/iterations/1/patch' ? patch : undefined;
  });
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs: [{ ...job(A), files: 6, undeclared: 1, deleted: 1 }] });
  stream.emit('job', withFiles(A));
  await page.flush();

  // Badges: on the job card and on the list card.
  assert.deepEqual(page.$('job-badges').all().map((element) => `${element.className}:${element.textContent}`), ['badge f-count:6 files', 'badge f-undeclared:1 sensitive', 'badge f-deleted:1 deleted']);
  const card = jobButton(page, 'app/T-1');
  assert.deepEqual(card.all().filter((element) => element.className.startsWith('badge f-')).map((element) => element.textContent), ['6 files', '1 sensitive', '1 deleted']);

  // The Files view: hidden under Report, shown under Files; the summary and the order.
  assert.equal(page.$('files-view').hidden, true);
  const views = page.$('iteration-views').querySelectorAll('button');
  views.find((button) => button.dataset.view === 'files')!.click();
  await page.flush();
  assert.equal(page.$('files-view').hidden, false);
  assert.equal(page.$('iteration-body').hidden, true);
  assert.equal(page.$('files-summary').textContent, 'Files 6 · 1 sensitive undeclared · 1 deleted');
  const items = page.$('files-list').children as FakeElement[];
  const rows = items.filter((item) => item.className !== 'file-group');
  const groups = items.filter((item) => item.className === 'file-group').map((item) => item.textContent);
  assert.deepEqual(groups, ['Sensitive, undeclared', 'Sensitive, declared', 'Deleted', 'Changed']);
  const rowOf = (item: FakeElement): FakeElement => item.children[0] as FakeElement;
  const name = (item: FakeElement): string => (rowOf(item).children[0] as FakeElement).textContent;
  assert.deepEqual(rows.map(name), ['ci.yml', 'package.json', 'old.ts', 'alpha.ts', 'img.png', 'zeta.ts']);
  assert.deepEqual(rows.map((item) => rowOf(item).className), ['file-row s-added', 'file-row s-modified', 'file-row s-deleted', 'file-row s-added', 'file-row s-added', 'file-row s-modified']);
  // The directory in a muted span, the labels and the counts.
  const first = rowOf(rows[0]!);
  assert.equal((first.children[1] as FakeElement).className, 'file-dir');
  assert.equal((first.children[1] as FakeElement).textContent, '.github/workflows');
  assert.equal(first.textContent, 'ci.yml.github/workflowssensitive, undeclared+5 −0');
  assert.equal(rowOf(rows[2]!).textContent, 'old.tssrcdeleted+0 −3');
  assert.ok(rowOf(rows[1]!).all().some((element) => element.className === 'file-label declared'));
  assert.ok(rows.every((item) => rowOf(item).getAttribute('aria-expanded') === 'false'));
  assert.equal(page.requests.filter((request) => request.path.endsWith('/patch')).length, 0);

  // A click expands exactly that file's diff, split from the Patch loaded once; a second click collapses it.
  rowOf(rows[5]!).click();
  await page.flush();
  const expanded = (page.$('files-list').children as FakeElement[]).filter((item) => item.className !== 'file-group');
  assert.equal(rowOf(expanded[5]!).getAttribute('aria-expanded'), 'true');
  const diff = expanded[5]!.children[1] as FakeElement;
  assert.equal(diff.className, 'document file-diff');
  assert.equal(diff.textContent, 'diff --git a/src/zeta.ts b/src/zeta.ts\nindex 1..2 100644\n--- a/src/zeta.ts\n+++ b/src/zeta.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n same\n');
  assert.deepEqual(diff.all().map((element) => element.className).slice(0, 6), ['file', 'file', 'file', 'file', 'hunk', 'del']);
  assert.equal(expanded[4]!.children.length, 1);
  assert.equal(page.requests.filter((request) => request.path.endsWith('/patch')).length, 1);
  rowOf(expanded[5]!).click();
  await page.flush();
  assert.equal(((page.$('files-list').children as FakeElement[]).filter((item) => item.className !== 'file-group')[5]!).children.length, 1);
  // A deleted file's diff; a file the Patch omits says so; the Patch is not fetched again.
  page.$('files-expand').click();
  await page.flush();
  const all = (page.$('files-list').children as FakeElement[]).filter((item) => item.className !== 'file-group');
  assert.ok(all.every((item) => item.children.length === 2));
  assert.match((all[2]!.children[1] as FakeElement).textContent, /^diff --git a\/src\/old\.ts b\/src\/old\.ts\ndeleted file mode 100644\n/);
  assert.equal((all[4]!.children[1] as FakeElement).textContent, 'The Patch omits img.png: a binary file, or beyond the Patch size limit.');
  assert.equal((all[0]!.children[1] as FakeElement).textContent, 'The Patch omits .github/workflows/ci.yml: a binary file, or beyond the Patch size limit.');
  assert.equal(page.requests.filter((request) => request.path.endsWith('/patch')).length, 1);
  page.$('files-collapse').click();
  await page.flush();
  assert.ok((page.$('files-list').children as FakeElement[]).filter((item) => item.className !== 'file-group').every((item) => item.children.length === 1));

  // An iteration without a list says so; Report hides the view again.
  stream.emit('job', { ...withFiles(A), iterations: [{ number: 1, started_at: '', ended_at: '', cost_usd: null, changed_files: 0, patch_truncated: false, denials: 0, files: null }] });
  await page.flush();
  assert.equal(page.$('no-files').hidden, false);
  assert.match(page.$('no-files').textContent, /published before the file list existed/);
  views.find((button) => button.dataset.view === 'report')!.click();
  await page.flush();
  assert.equal(page.$('files-view').hidden, true);
  assert.equal(page.$('iteration-body').hidden, false);
});

// The Claude review of each iteration (SF-038): verdict, summary and items under the meta line, a
// failure, nothing while none ended; the job's cost counts the reviews.
test('client: the Iterations tab shows the review of the selected iteration, and the job cost includes the reviews', async () => {
  const meta = { started_at: '2026-11-01T10:00:01.000Z', ended_at: '2026-11-01T10:05:00.000Z', changed_files: 1, patch_truncated: false, denials: 0, files: null };
  const fix = {
    reviewer: 'claude', verdict: 'fix', summary: 'The greeting is wrong.', accepted_sensitive: [], cost_usd: 0.25,
    items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.' }, { path: 'a.txt', problem: 'Empty.', expected: 'A line.' }],
    started_at: '2026-11-01T10:05:01.000Z', ended_at: '2026-11-01T10:06:00.000Z',
  };
  const clean = { ...fix, verdict: 'clean', summary: 'Right now.', items: [], accepted_sensitive: ['package.json'], cost_usd: 0.125 };
  const withReviews = (third: unknown) => ({
    ...detail(A),
    iterations: [
      { number: 1, cost_usd: 0.5, ...meta, review: fix },
      { number: 2, cost_usd: 0.5, ...meta, review: clean },
      { number: 3, cost_usd: null, ...meta, review: third },
    ],
  });
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs: [job(A)] };
    }
    if (path === 'api/jobs/app/T-1') {
      return withReviews(null);
    }
    return path.endsWith('/report') ? '# Report' : undefined;
  });
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs: [job(A)] });
  stream.emit('job', withReviews(null));
  await page.flush();
  const review = page.$('iteration-review');
  const select = async (number: number): Promise<void> => {
    (page.$('iteration-tabs').children as FakeElement[])[number - 1]!.click();
    await page.flush();
  };
  assert.equal(page.$('job-cost').textContent, 'est. $1.3750');

  await select(3);
  assert.deepEqual([review.hidden, review.children.length], [true, 0]);
  await select(1);
  assert.deepEqual([review.hidden, review.className], [false, 'review v-fix']);
  const children = review.children as FakeElement[];
  assert.deepEqual(children.map((child) => child.textContent), [
    'Review by claude: fix (2 items), cost $0.2500',
    'The greeting is wrong.',
    'README.md: It greets the world. Expected: It greets the reader.a.txt: Empty. Expected: A line.',
  ]);
  assert.equal(children[2]!.tagName, 'OL');
  await select(2);
  assert.deepEqual((review.children as FakeElement[]).map((child) => child.textContent), [
    'Review by claude: clean, cost $0.1250', 'Right now.', 'Accepted sensitive paths: package.json',
  ]);
  stream.emit('job', withReviews({ reviewer: 'claude', error: 'The review returned no structured output.' }));
  await page.flush();
  await select(3);
  assert.equal(review.className, 'review v-failed');
  assert.deepEqual((review.children as FakeElement[]).map((child) => child.textContent), ['Review by claude: failed', 'The review returned no structured output.']);
});

const reviewPosts = (page: Page): FetchRequest[] => posts(page).filter((request) => request.path.endsWith('/review'));

test('client: Retry review shows only in needs_human after a failed review; one request at a time; the outcome or the refusal as text', async () => {
  const page = await openPage();
  const stream = page.streams.at(-1)!;
  const button = page.$('retry-review-button');
  const stuck = (code: string | null) => {
    const shown = detail({ ...A, state: 'needs_human' });
    return { ...shown, job: { ...shown.job, error: code === null ? null : { code, message: `The ${code} message.` } } };
  };
  // Hidden in every other state, and for needs_human with another cause.
  assert.equal(button.hidden, true);
  for (const shown of [stuck(null), stuck('iteration_limit'), detail({ ...A, state: 'awaiting_review' })]) {
    stream.emit('job', shown);
    assert.equal(button.hidden, true, JSON.stringify(shown.job.error));
  }
  stream.emit('job', stuck('review_failed'));
  assert.deepEqual([button.hidden, button.disabled], [false, false]);
  assert.doesNotMatch(page.$('action-reasons').textContent, /Retry review/);

  button.click();
  await page.flush();
  const sent = reviewPosts(page)[0]!;
  assert.deepEqual([sent.path, sent.body, sent.headers['content-type']], ['api/jobs/app/T-1/review', '{}', 'application/json']);
  assert.equal(page.$('action-status').textContent, 'Restarting the review…');
  assert.equal(button.disabled, true);
  assert.match(page.$('action-reasons').textContent, /Retry review: the review is being restarted\./);
  button.click();
  await page.flush();
  assert.equal(reviewPosts(page).length, 1);
  sent.respond(200, { ok: true, result: { state: 'awaiting_review', iteration: 1 } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'The review of iteration 1 runs again (state awaiting_review).');
  assert.equal(page.$('action-status').className, 'status ok');
  stream.emit('job', detail({ ...A, state: 'awaiting_review' }));
  assert.equal(button.hidden, true);

  // A refusal is shown as it comes.
  stream.emit('job', stuck('review_failed'));
  button.click();
  await page.flush();
  reviewPosts(page)[1]!.respond(409, { ok: false, error: { code: 'review_off', message: 'The Claude review is off (SF_REVIEW=off); nothing would review the iteration.' } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'review_off: The Claude review is off (SF_REVIEW=off); nothing would review the iteration.');
  assert.equal(page.$('action-status').className, 'status error');
  // Nothing holds the button after a definite answer (the fake's refreshed detail is another state).
  stream.emit('job', stuck('review_failed'));
  assert.deepEqual([button.hidden, button.disabled], [false, false]);
  assert.equal(reviewPosts(page).length, 2);
});

// The gate (SF-039): its verdict in its own block under Claude's, with its tokens; hidden while none
// ended.
test('client: the Iterations tab shows the gate\'s verdict under the Claude review', async () => {
  const meta = { started_at: '2026-11-01T10:00:01.000Z', ended_at: '2026-11-01T10:05:00.000Z', changed_files: 1, patch_truncated: false, denials: 0, files: null };
  const times = { started_at: '2026-11-01T10:05:01.000Z', ended_at: '2026-11-01T10:06:00.000Z' };
  const claude = { reviewer: 'claude', verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [], cost_usd: 0.25, ...times };
  const gate = {
    reviewer: 'codex', verdict: 'fix', summary: 'Not quite.', accepted_sensitive: [], model: 'gpt-x', tokens: { input: 1000, cached_input: 200, output: 100 },
    items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.' }], ...times,
  };
  const withGate = {
    ...detail(A),
    iterations: [
      { number: 1, cost_usd: 0.5, ...meta, review: claude, gate },
      { number: 2, cost_usd: 0.5, ...meta, review: claude, gate: { reviewer: 'codex', error: 'Codex wrote no output.', tokens: { input: 0, cached_input: 0, output: 0 }, ...times } },
      { number: 3, cost_usd: 0.5, ...meta, review: claude, gate: null },
    ],
  };
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs: [job(A)] };
    }
    if (path === 'api/jobs/app/T-1') {
      return withGate;
    }
    return path.endsWith('/report') ? '# Report' : undefined;
  });
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs: [job(A)] });
  stream.emit('job', withGate);
  await page.flush();
  const select = async (number: number): Promise<void> => {
    (page.$('iteration-tabs').children as FakeElement[])[number - 1]!.click();
    await page.flush();
  };
  const texts = (id: string): string[] => (page.$(id).children as FakeElement[]).map((child) => child.textContent);
  await select(1);
  assert.deepEqual(texts('iteration-review'), ['Review by claude: clean, cost $0.2500', 'Right.']);
  assert.deepEqual([page.$('iteration-gate').hidden, page.$('iteration-gate').className], [false, 'review v-fix']);
  assert.deepEqual(texts('iteration-gate'), ['Review by codex: fix (1 item), 1100 tokens', 'Not quite.', 'README.md: It greets the world. Expected: It greets the reader.']);
  await select(2);
  assert.equal(page.$('iteration-gate').className, 'review v-failed');
  assert.deepEqual(texts('iteration-gate'), ['Review by codex: failed', 'Codex wrote no output.']);
  await select(3);
  assert.deepEqual([page.$('iteration-review').hidden, page.$('iteration-gate').hidden, page.$('iteration-gate').children.length], [false, true, 0]);
});
