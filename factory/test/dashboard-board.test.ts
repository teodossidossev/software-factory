// The board's HTTP contract (SF-046), in process against fake actions and setup: the start of a
// job from a ticket (POST api/tickets/<ws>/<ticket>/start, Execution.start), the Task text (GET
// api/tickets/<ws>/<ticket>/task, ?archived=1) and the facts each job row carries for its card,
// with the v3 card's now, tool_calls and stop (SF-077).
import assert from 'node:assert/strict';
import { appendFile, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_ACTION_BODY_BYTES, NOW_TAIL_BYTES, ToolCallCounter } from '../src/dashboard.js';
import type { LedgerEntry } from '../src/ledger.js';
import { FactoryError } from '../src/errors.js';
import { act, CSP, fakeActions, fakeSetup, fetchRaw, openStream, type Reply, ticketRow, workspaceRow } from './support/dashboard-client.js';
import { withDashboard } from './support/dashboard-state.js';
import { taskSha256 } from '../src/task-file.js';
import { temp } from './support/harness.js';

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
      ['task_draft', 409], ['job_exists', 409], ['branch_exists', 409], ['checkout_dirty', 409],
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

test('board task: GET reads the Task file as text/markdown through the reader, the archive with ?archived=1; 404 for bad names and missing files', async () => {
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
    // GET reads; POST is the planned ticket page's Save (SF-081, dashboard-setup.test.ts); nothing else.
    for (const method of ['PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      const other = await fetchRaw(new URL('api/tickets/app/T-5/task', base), { method, headers: { origin, 'content-type': 'application/json' }, body: '{}' });
      assert.deepEqual([other.status, other.headers.allow, other.body], [405, 'GET, POST', ''], method);
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

// An SDK assistant message of the Implementer, as the session logs it.
const said = (ts: string, ...content: Array<Record<string, unknown>>) => ({ ts, iteration: 1, message: { type: 'assistant', message: { content } } });
const tool = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', name, input });
const text = (body: string) => ({ type: 'text', text: body });

test('board jobs (SF-077): now is the Implementer\'s last step from the tail of the log, the reviewer of the last iteration or the MR writer; null otherwise', async () => {
  await withDashboard('dash-board-now', fakeActions(), async (dashboard, store) => {
    const rows = async (): Promise<Record<string, any>> =>
      Object.fromEntries((JSON.parse((await fetchRaw(new URL('api/jobs', dashboard.url))).body).jobs as Array<Record<string, any>>).map((row) => [row.ticket, row]));
    // awaiting_review without a Claude verdict: the Claude review; once its verdict is stored, clean
    // or fix, the gate of the joint round.
    assert.deepEqual((await rows())['T-1'].now, { who: 'Claude review', what: 'reviewing iteration 1', ts: '2026-11-01T10:05:00.000Z' });
    assert.equal((await rows())['T-0'].now, null);
    await store.jobs.writeReview('app', 'T-1', 1, { reviewer: 'claude', error: 'It failed.' });
    assert.deepEqual((await rows())['T-1'].now, { who: 'Claude review', what: 'reviewing iteration 1', ts: '2026-11-01T10:05:00.000Z' });
    await store.jobs.writeReview('app', 'T-1', 1, {
      reviewer: 'claude', verdict: 'fix', summary: 'Broken.', items: [{ path: 'a.ts', problem: 'Broken.', expected: 'Fixed.', severity: 'major' }], accepted_sensitive: [], cost_usd: 0.25,
      started_at: '2026-11-01T10:05:01.000Z', ended_at: '2026-11-01T10:05:30.000Z',
    });
    assert.deepEqual((await rows())['T-1'].now, { who: 'Codex gate', what: 'reviewing iteration 1', ts: '2026-11-01T10:05:30.000Z' });
    await store.jobs.writeReview('app', 'T-1', 1, {
      reviewer: 'claude', verdict: 'clean', summary: 'Fine.', items: [], accepted_sensitive: [], cost_usd: 0.25,
      started_at: '2026-11-01T10:05:01.000Z', ended_at: '2026-11-01T10:06:00.000Z',
    });
    assert.deepEqual((await rows())['T-1'].now, { who: 'Codex gate', what: 'reviewing iteration 1', ts: '2026-11-01T10:06:00.000Z' });
    await store.jobs.write({ ...store.job, state: 'preparing_mr' });
    assert.deepEqual((await rows())['T-1'].now, { who: 'MR writer', what: 'writing the MR text', ts: '2026-11-01T10:05:00.000Z' });

    // Working: the last tool call as the verb and its short input, or the first line of the last text;
    // the reviewers' messages are not the Implementer's.
    await store.jobs.write({ ...store.job, state: 'working' });
    assert.deepEqual((await rows())['T-1'].now, { who: 'Implementer', what: 'Bash {"command":"npm test"}', ts: '2026-11-01T10:00:03.000Z' });
    await store.jobs.appendEvent('app', 'T-1', said('2026-11-01T10:10:00.000Z', text('Reading the store'), tool('Read', { file_path: 'factory/src/jobs.ts' })));
    await store.jobs.appendEvent('app', 'T-1', { ts: '2026-11-01T10:11:00.000Z', iteration: 1, type: 'review_message', reviewer: 'claude', message: said('x', tool('Grep', { pattern: 'x' })).message });
    assert.deepEqual((await rows())['T-1'].now, { who: 'Implementer', what: 'Read factory/src/jobs.ts', ts: '2026-11-01T10:10:00.000Z' });
    await store.jobs.appendEvent('app', 'T-1', said('2026-11-01T10:12:00.000Z', text('  All tests pass.\nNext: the docs.')));
    assert.deepEqual((await rows())['T-1'].now, { who: 'Implementer', what: 'All tests pass.', ts: '2026-11-01T10:12:00.000Z' });

    // Only the tail is read: a step further back than NOW_TAIL_BYTES is not found, though its tool
    // call still counts.
    const filler = JSON.stringify({ ts: '2026-11-01T10:13:00.000Z', iteration: 1, message: { type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(1000) }] } } });
    await appendFile(store.jobs.eventsPath('app', 'T-1'), `${filler}\n`.repeat(Math.ceil(NOW_TAIL_BYTES / filler.length) + 1));
    const row = (await rows())['T-1'];
    assert.deepEqual([row.now, row.tool_calls], [null, 2]);
  });
});

test('board jobs (SF-077): tool_calls counts the Implementer\'s tool uses, reading only what was added since; a replaced log is counted again', async () => {
  const path = join(temp, 'tool-calls.jsonl');
  const line = (ts: string, ...content: Array<Record<string, unknown>>) => `${JSON.stringify(said(ts, ...content))}\n`;
  const first = line('t1', tool('Read', { file_path: 'a' }), text('x'), tool('Bash', { command: 'ls' })) +
    `${JSON.stringify({ ts: 't2', iteration: 1, type: 'gate_event', reviewer: 'codex', event: { type: 'tool_use' } })}\n`;
  await writeFile(path, first);
  const counter = new ToolCallCounter();
  assert.equal(await counter.count(path), 2);
  assert.equal(counter.bytesRead, Buffer.byteLength(first));
  // Nothing new: nothing is read. A line written in two parts is counted once it is whole.
  assert.equal(await counter.count(path), 2);
  assert.equal(counter.bytesRead, Buffer.byteLength(first));
  const next = line('t3', tool('Edit', { file_path: 'b' }));
  await appendFile(path, next.slice(0, 20));
  assert.equal(await counter.count(path), 2);
  await appendFile(path, next.slice(20));
  assert.equal(await counter.count(path), 3);
  // Incremental: the bytes already read are not read again (blanking the first line in place
  // changes nothing), and the log is read once in all.
  const handle = await open(path, 'r+');
  await handle.write(' '.repeat(Buffer.byteLength(first) - 1), 0);
  await handle.close();
  await appendFile(path, line('t4', tool('Write', { file_path: 'c' })));
  assert.equal(await counter.count(path), 4);
  const total = (await open(path, 'r').then(async (file) => {
    const { size } = await file.stat();
    await file.close();
    return size;
  }));
  assert.equal(counter.bytesRead, total);
  // Concurrent counts of one log do not count twice.
  await appendFile(path, line('t5', tool('Read', { file_path: 'd' })));
  assert.deepEqual(await Promise.all([counter.count(path), counter.count(path)]), [5, 5]);
  // A restart replaces the log: it is counted from its start; a missing log has none.
  await writeFile(`${path}.new`, line('t6', tool('Read', { file_path: 'e' })));
  await rename(`${path}.new`, path);
  assert.equal(await counter.count(path), 1);
  assert.equal(await counter.count(join(temp, 'no-such-log.jsonl')), 0);
});

test('board jobs (SF-077): stop lists what a needs_human job waits on, by code; null for a job that is not stopped', async () => {
  const entry = (id: string, status: LedgerEntry['status']): LedgerEntry => ({
    id, iteration: 1, reviewer: 'claude', severity: 'major', path: 'a.ts', problem: `Problem ${id}.`, expected: 'Better.', status,
    response: status === 'escalated' ? 'Which one?' : '', evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null,
  });
  const item = { path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.', severity: 'major' as const };
  await withDashboard('dash-board-stop', fakeActions(), async (dashboard, store) => {
    const stop = async (): Promise<unknown> =>
      (JSON.parse((await fetchRaw(new URL('api/jobs', dashboard.url))).body).jobs as Array<Record<string, any>>).find((row) => row.ticket === 'T-1')!.stop;
    const halt = (code: string) => store.jobs.write({ ...store.job, state: 'needs_human', error: { code, message: `The ${code} message.` } });
    assert.equal(await stop(), null);
    // To settle: the escalated entries and the contests a reviewer disputed (not R5, undisputed).
    const disputed = { ...entry('R2', 'contested'), dispute: { reviewer: 'codex', iteration: 1, reason: 'Still wrong.' } };
    await store.jobs.writeLedger('app', 'T-1', [entry('R1', 'escalated'), disputed, entry('R3', 'open'), entry('R4', 'fixed'), entry('R5', 'contested')]);
    await halt('escalated');
    assert.deepEqual(((await stop()) as { items: LedgerEntry[] }).items.map((row) => row.id), ['R1', 'R2']);
    await halt('review_disputed');
    assert.deepEqual(((await stop()) as { items: LedgerEntry[] }).items.map((row) => row.id), ['R1', 'R2']);
    await halt('review_churn');
    assert.deepEqual(await stop(), { items: [entry('R3', 'open')], saves_lines: null });

    const suggestion = (path: string, lines: number) => ({ path, what: 'Drop it.', why: 'Not needed.', saves_lines: lines, ledger_ids: ['R4'] });
    await store.jobs.writeSimplify('app', 'T-1', 1, {
      reviewer: 'claude', summary: 'Two.', suggestions: [suggestion('a.ts', 12), suggestion('b.ts', 3)], dropped: [], cost_usd: 0.1, model: null,
      started_at: '2026-11-01T10:06:00.000Z', ended_at: '2026-11-01T10:07:00.000Z',
    });
    await halt('simplify_offered');
    assert.deepEqual(await stop(), { items: [suggestion('a.ts', 12), suggestion('b.ts', 3)], saves_lines: 15 });

    // The gate's items: of the last iteration the gate reviewed.
    await store.jobs.writeGate('app', 'T-1', 1, {
      reviewer: 'codex', verdict: 'fix', summary: 'Not quite.', items: [item], accepted_sensitive: [], tokens: { input: 1, cached_input: 0, output: 1 },
      started_at: '2026-11-01T10:06:00.000Z', ended_at: '2026-11-01T10:07:00.000Z',
    });
    for (const code of ['gate_rounds', 'gate_budget']) {
      await halt(code);
      assert.deepEqual(await stop(), { items: [item], saves_lines: null }, code);
    }
    await store.jobs.write({ ...store.job, state: 'needs_human', iteration: 2, error: { code: 'gate_budget', message: 'Used up.' } });
    assert.deepEqual(await stop(), { items: [item], saves_lines: null });
    for (const code of ['serve_restarted', 'mr_conflict', 'review_failed']) {
      await halt(code);
      assert.deepEqual(await stop(), { items: [], saves_lines: null }, code);
    }
  });
});
