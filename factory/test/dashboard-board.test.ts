// The board's HTTP contract (SF-046), in process against fake actions and setup: the start of a
// job from a ticket (POST api/tickets/<ws>/<ticket>/start, Execution.start), the Task text (GET
// api/tickets/<ws>/<ticket>/task, ?archived=1) and the facts each job row carries for its card.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ACTION_BODY_BYTES } from '../src/dashboard.js';
import { FactoryError } from '../src/errors.js';
import { act, CSP, fakeActions, fakeSetup, fetchRaw, openStream, type Reply, ticketRow, workspaceRow } from './support/dashboard-client.js';
import { withDashboard } from './support/dashboard-state.js';
import { taskSha256 } from '../src/task-file.js';

const error = (reply: Reply): { status: number; code: string } => ({ status: reply.status, code: JSON.parse(reply.body).error.code });

const TASK = '---\nticket: T-5\ntitle: Five <b>bold</b>\nbase: main\n---\n\n# T-5: Five\n\n<script>alert(1)</script>\n';

test('board start: POST only, the action checks, Execution.start once with the names, its result and its refusals as they come; the pages refresh', async () => {
  const fake = fakeActions({ branch: 'T-5-five', state: 'working', check_after_minutes: 15, worktree: '/wt/T-5' });
  const setup = fakeSetup([workspaceRow('app')], [ticketRow('app', 'T-5', 'Five', false)]);
  await withDashboard('dash-board-start', fake, async (dashboard) => {
    const base = dashboard.url;
    const port = Number(base.port);
    const origin = `http://127.0.0.1:${port}`;
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']) {
      const reply = await fetchRaw(new URL('api/tickets/app/T-5/start', base), { method, headers: { origin, 'content-type': 'application/json' }, body: '{}' });
      assert.deepEqual([reply.status, reply.headers.allow, reply.body], [405, 'POST', ''], method);
      assert.equal(reply.headers['content-security-policy'], CSP);
    }
    // Bad names: an empty 404, before the body is read.
    for (const path of ['api/tickets/App/T-5/start', 'api/tickets/-app/T-5/start', 'api/tickets/app/.T-5/start', 'api/tickets/app/T-5%2Fx/start', 'api/tickets/app/T-5/start/x']) {
      const reply = await act(base, path, {});
      assert.equal(reply.status, path.endsWith('/x') ? 405 : 404, path);
      assert.equal(reply.body, '', path);
    }
    // The token.
    const token = base.pathname.split('/')[2]!;
    const wrong = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    for (const path of [`/d/${wrong}/api/tickets/app/T-5/start`, '/api/tickets/app/T-5/start']) {
      const reply = await fetchRaw(`${origin}${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
    }
    // Origin, content type, body bounds, JSON and shape.
    const path = 'api/tickets/app/T-5/start';
    assert.deepEqual(error(await act(base, path, {}, { headers: { origin: `http://localhost:${port}` } })), { status: 403, code: 'invalid_origin' });
    assert.deepEqual(error(await act(base, path, {}, { headers: { 'content-type': 'text/plain' } })), { status: 415, code: 'unsupported_media_type' });
    assert.deepEqual(error(await act(base, path, undefined, { body: '{' })), { status: 400, code: 'invalid_json' });
    assert.deepEqual(error(await act(base, path, undefined, { body: 'x'.repeat(MAX_ACTION_BODY_BYTES + 1) })), { status: 413, code: 'body_too_large' });
    for (const text of ['{"base":"main"}', '[]', 'null', '{"force":true}']) {
      assert.deepEqual(error(await act(base, path, undefined, { body: text })), { status: 400, code: 'invalid_body' }, text);
    }
    assert.deepEqual(fake.calls, []);

    // Accepted: one call with the names, the result unchanged; every page gets the jobs again.
    const stream = await openStream(new URL('api/stream', base));
    await stream.next('jobs');
    await stream.next('tickets');
    const reply = await act(base, path, {});
    assert.equal(reply.status, 200, reply.body);
    assert.deepEqual(JSON.parse(reply.body), { ok: true, result: { branch: 'T-5-five', state: 'working', check_after_minutes: 15, worktree: '/wt/T-5' } });
    assert.deepEqual(fake.calls, [['start', 'app', 'T-5']]);
    await stream.next('jobs');
    await stream.next('workspaces');
    await stream.next('tickets');
    assert.deepEqual(setup.calls, []);

    // Refused: the Execution's codes and messages as they come, each once.
    const refusals: Array<[string, number]> = [
      ['task_draft', 409], ['job_limit', 409], ['job_exists', 409], ['branch_exists', 409], ['checkout_dirty', 409],
      ['task_not_found', 404], ['workspace_not_found', 404], ['invalid_content', 400], ['start_failed', 500],
    ];
    for (const [code, status] of refusals) {
      fake.calls.length = 0;
      fake.answer = new FactoryError(code, `The ${code} message.`);
      const refused = await act(base, path, {});
      assert.equal(refused.status, status, code);
      assert.deepEqual(JSON.parse(refused.body), { ok: false, error: { code, message: `The ${code} message.` } });
      assert.deepEqual(fake.calls, [['start', 'app', 'T-5']], code);
    }
    // Anything else is internal_error, the cause not exposed.
    fake.answer = new Error('secret detail');
    const failed = await act(base, path, {});
    assert.deepEqual(JSON.parse(failed.body), { ok: false, error: { code: 'internal_error', message: 'The request failed inside the factory.' } });
    stream.close();
  }, setup);
});

test('board task: GET only, the Task file as text/markdown through the reader, the archive with ?archived=1; 404 for bad names and missing files', async () => {
  const fake = fakeActions();
  const setup = fakeSetup([workspaceRow('app')], [ticketRow('app', 'T-5', 'Five', false)]);
  setup.texts.set('app/T-5', TASK);
  setup.texts.set('app/archive/T-4', '---\nticket: T-4\ntitle: Four\nbase: main\n---\n\nArchived.\n');
  await withDashboard('dash-board-task', fake, async (dashboard) => {
    const base = dashboard.url;
    const origin = `http://127.0.0.1:${base.port}`;
    const reply = await fetchRaw(new URL('api/tickets/app/T-5/task', base));
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['content-type'], 'text/markdown; charset=utf-8');
    assert.equal(reply.headers['content-security-policy'], CSP);
    assert.equal(reply.headers['x-content-type-options'], 'nosniff');
    // The bytes as the reader returned them: nothing parsed, nothing escaped server side.
    assert.equal(reply.body, TASK);
    const archived = await fetchRaw(new URL('api/tickets/app/T-4/task?archived=1', base));
    assert.deepEqual([archived.status, archived.body], [200, '---\nticket: T-4\ntitle: Four\nbase: main\n---\n\nArchived.\n']);
    assert.deepEqual(setup.reads, ['app/T-5', 'app/archive/T-4']);

    // A missing file (active or archived) is an empty 404; the archive is only read with archived=1.
    for (const path of ['api/tickets/app/T-4/task', 'api/tickets/app/T-5/task?archived=1', 'api/tickets/web/T-5/task']) {
      const missing = await fetchRaw(new URL(path, base));
      assert.deepEqual([missing.status, missing.body], [404, ''], path);
    }
    // Bad names, another archived value, extra segments: 404 without a read.
    setup.reads.length = 0;
    for (const path of ['api/tickets/App/T-5/task', 'api/tickets/-app/T-5/task', 'api/tickets/app/.T-5/task', 'api/tickets/app/T-5%2F..%2Fx/task', 'api/tickets/app/T-5/task/x',
      'api/tickets/app/T-5/task?archived=true', 'api/tickets/app/T-5/task?archived=0', 'api/tickets/app/T-5/task?archived=1&archived=1', 'api/tickets/app/T-5/text', 'api/tickets/app/T-5']) {
      const bad = await fetchRaw(new URL(path, base));
      assert.deepEqual([bad.status, bad.body], [404, ''], path);
    }
    assert.deepEqual(setup.reads, []);
    // A file the reader refuses answers the refusal.
    setup.taskText = async () => {
      throw new FactoryError('invalid_content', 'the front matter must contain "ticket: T-5".');
    };
    const invalid = await fetchRaw(new URL('api/tickets/app/T-5/task', base));
    assert.deepEqual(error(invalid), { status: 400, code: 'invalid_content' });
    // GET only.
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const other = await fetchRaw(new URL('api/tickets/app/T-5/task', base), { method, headers: { origin, 'content-type': 'application/json' }, body: '{}' });
      assert.deepEqual([other.status, other.headers.allow, other.body], [405, 'GET', ''], method);
    }
    // The token.
    const token = base.pathname.split('/')[2]!;
    const wrong = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    for (const path of [`/d/${wrong}/api/tickets/app/T-5/task`, '/api/tickets/app/T-5/task']) {
      const denied = await fetchRaw(`${origin}${path}`);
      assert.deepEqual([denied.status, denied.body], [404, ''], path);
    }
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(setup.calls, []);
  }, setup);
});

test('board jobs: every row carries the title of its Task file, the estimated cost and the last iteration\'s reviews', async () => {
  const setup = fakeSetup([workspaceRow('app')]);
  setup.texts.set('app/T-1', '---\nticket: T-1\ntitle: One thing\nbase: main\n---\n');
  await withDashboard('dash-board-jobs', fakeActions(), async (dashboard, store) => {
    const rows = async (): Promise<Record<string, any>> => {
      const list = JSON.parse((await fetchRaw(new URL('api/jobs', dashboard.url))).body).jobs as Array<Record<string, any>>;
      return Object.fromEntries(list.map((row) => [row.ticket, row]));
    };
    let jobs = await rows();
    // T-1: one iteration of $0.50, no review yet; T-0: no Task file, no iteration.
    assert.deepEqual([jobs['T-1'].title, jobs['T-1'].cost_usd, jobs['T-1'].review, jobs['T-1'].review_ended_at, jobs['T-1'].gate], ['One thing', 0.5, null, null, null]);
    assert.deepEqual([jobs['T-0'].title, jobs['T-0'].cost_usd, jobs['T-0'].review, jobs['T-0'].gate], [null, null, null, null]);
    // A clean Claude review: its cost joins the sum and its end is when the gate began.
    await store.jobs.writeReview('app', 'T-1', 1, {
      reviewer: 'claude', verdict: 'clean', summary: 'Fine.', items: [], accepted_sensitive: [], cost_usd: 0.25,
      started_at: '2026-11-01T10:05:01.000Z', ended_at: '2026-11-01T10:06:00.000Z',
    });
    jobs = await rows();
    assert.deepEqual([jobs['T-1'].cost_usd, jobs['T-1'].review, jobs['T-1'].review_ended_at, jobs['T-1'].gate], [0.75, 'clean', '2026-11-01T10:06:00.000Z', null]);
    await store.jobs.writeGate('app', 'T-1', 1, { reviewer: 'codex', error: 'timed out', tokens: { input: 1, cached_input: 0, output: 1 }, started_at: '2026-11-01T10:06:00.000Z', ended_at: '2026-11-01T10:07:00.000Z' });
    assert.equal((await rows())['T-1'].gate, 'failed');
  }, setup);
});

test('board jobs (SF-067): a paused job carries what the pause interrupted and whether its Task file changed; Pause, Resume and Restart reach the Execution', async () => {
  const setup = fakeSetup([workspaceRow('app')]);
  const text = '---\nticket: T-1\ntitle: One thing\nbase: main\n---\n';
  setup.texts.set('app/T-1', text);
  const fake = fakeActions({ state: 'paused' });
  await withDashboard('dash-board-paused', fake, async (dashboard, store) => {
    const row = async (): Promise<Record<string, any>> =>
      (JSON.parse((await fetchRaw(new URL('api/jobs', dashboard.url))).body).jobs as Array<Record<string, any>>).find((job) => job.ticket === 'T-1')!;
    assert.deepEqual([(await row()).paused, (await row()).task_changed], [null, null]);
    const paused = { from: 'awaiting_review' as const, step: 'review' as const, at: '2026-11-01T10:06:00.000Z' };
    await store.jobs.write({ ...store.job, state: 'paused', paused, task_sha256: taskSha256(text) });
    assert.deepEqual([(await row()).paused, (await row()).task_changed], [paused, false]);
    setup.texts.set('app/T-1', `${text}\nMore.\n`);
    assert.equal((await row()).task_changed, true);
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', dashboard.url))).body);
    assert.deepEqual([detail.job.paused, detail.job.task_changed], [paused, true]);

    for (const [action, body] of [['pause', {}], ['resume', {}], ['resume', { message: 'Go.' }], ['restart', {}], ['restart', { keep_files: true }]] as const) {
      assert.equal((await act(dashboard.url, `api/jobs/app/T-1/${action}`, body)).status, 200, action);
    }
    for (const [action, body] of [['pause', { x: 1 }], ['resume', { message: 1 }], ['restart', { keep_files: 'yes' }]] as const) {
      assert.equal((await act(dashboard.url, `api/jobs/app/T-1/${action}`, body)).status, 400, action);
    }
    assert.deepEqual(fake.calls, [
      ['pause', 'app', 'T-1'], ['resumePaused', 'app', 'T-1', ''], ['resumePaused', 'app', 'T-1', 'Go.'], ['restart', 'app', 'T-1', false], ['restart', 'app', 'T-1', true],
    ]);
    fake.answer = new FactoryError('restart_refused', 'The restart was refused: the branch T-1-demo was pushed (origin/T-1-demo). Nothing was changed.');
    const refused = await act(dashboard.url, 'api/jobs/app/T-1/restart', {});
    assert.deepEqual([refused.status, JSON.parse(refused.body).error.code], [409, 'restart_refused']);
  }, setup);
});
