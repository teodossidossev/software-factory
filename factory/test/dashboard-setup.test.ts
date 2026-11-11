// The start screen's HTTP contract (SF-025, SF-028, SF-040): api/workspaces and api/tickets on GET
// and POST, api/workspaces/<name>/remove and api/tickets/<ws>/<ticket>/start on POST (the board's
// Task route is in dashboard-board.test.ts), with the action checks of SF-018, against fake setup
// and actions in process; the stream's workspaces and tickets events; then end to end through
// `sf serve`: a workspace added from the page, a ticket draft, the Task file written by the
// planner over MCP, and the User's start from the page. A ticket's images (SF-064): the upload, the
// type by the magic bytes, the limits, the names and the removal through the real Setup, the image
// served with its type, the guard, the payload's attachments and the first message that names them.
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_ATTACHMENT_BYTES } from '../src/attachments.js';
import { MAX_ACTION_BODY_BYTES, MAX_TASK_BODY_BYTES, startDashboard } from '../src/dashboard.js';
import { FactoryError } from '../src/errors.js';
import { CHATGPT_PREFILL_URL, conversationUrl, ticketConversation } from '../src/conversation.js';
import { JobStore } from '../src/jobs.js';
import { loadRegistry, resolveWorkspace } from '../src/registry.js';
import { draftContent, type JobDependencies, Setup } from '../src/setup.js';
import { CheckStore, TaskChecks } from '../src/task-check.js';
import { MAX_TASK_BYTES, taskSha256 } from '../src/task-file.js';
import { TicketHistory } from '../src/ticket-history.js';
import { act, CSP, fakeActions, fakeSetup, fetchRaw, openStream, type Reply, ticketRow, workspaceRow } from './support/dashboard-client.js';
import { withDashboard } from './support/dashboard-state.js';
import { call, newEnv, newRepo, runCli, script, serve, stop, temp, waitFor } from './support/harness.js';

const error = (reply: Reply): { status: number; code: string } => ({ status: reply.status, code: JSON.parse(reply.body).error.code });

const result = (reply: Reply): Record<string, any> => {
  assert.equal(reply.status, 200, reply.body);
  const data = JSON.parse(reply.body);
  assert.equal(data.ok, true);
  return data.result;
};

test('dashboard setup: the reads, the method rules per path and the token; nothing is dispatched', async () => {
  const fake = fakeActions();
  const setup = fakeSetup([workspaceRow('app', '/srv/app', 1), workspaceRow('web')], [ticketRow('app', 'T-5'), ticketRow('web', 'W-1', 'Web thing', false, 'pushed')]);
  await withDashboard('dash-setup-reads', fake, async (dashboard) => {
    const base = dashboard.url;
    const workspaces = await fetchRaw(new URL('api/workspaces', base));
    assert.equal(workspaces.status, 200);
    assert.equal(workspaces.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(workspaces.headers['content-security-policy'], CSP);
    // SF-103: the hand-over default and the morning digest's settings at the top level; each row its app, description, derived description and switches.
    assert.deepEqual(JSON.parse(workspaces.body), {
      workspaces: [{ name: 'app', path: '/srv/app', liveJobs: 1, problem: null, handoff: null, color: 'teal', app: 'app', description: null, derived_description: null, digest: { track: false, my_work: false } }, { name: 'web', path: '/srv/web', liveJobs: 0, problem: null, handoff: null, color: 'purple', app: 'web', description: null, derived_description: null, digest: { track: false, my_work: false } }],
      handoff_default: 'checkout', digest: { at: '08:00', weekdays_only: true, language: 'English' },
    });

    const tickets = await fetchRaw(new URL('api/tickets', base));
    assert.equal(tickets.status, 200);
    const rows = JSON.parse(tickets.body).tickets;
    assert.deepEqual(Object.keys(rows[0]).sort(), ['attachments', 'base', 'conversation', 'draft', 'job', 'lands_after', 'queue_error', 'queue_force', 'queue_position', 'queue_reason', 'request', 'ticket', 'title', 'workspace']);
    // SF-071: without a run queue, no ticket is queued and the payload's queue is null.
    assert.deepEqual([rows[0].queue_position, rows[0].queue_error, JSON.parse(tickets.body).queue], [null, null, null]);
    assert.deepEqual([rows[1].draft, rows[1].job], [false, 'pushed']);
    // SF-084: each ticket's lands_after as the setup lists it, and the live jobs' as job_lands_after.
    assert.deepEqual(rows[0].lands_after, []);
    assert.deepEqual(JSON.parse(tickets.body).job_lands_after, []);
    const waits: JobDependencies[] = [{ workspace: 'app', ticket: 'T-9', lands_after: [{ workspace: 'web', ticket: 'W-1', state: 'running' }] }];
    setup.rows.jobDependencies = waits;
    const listed = setup.rows.tickets;
    setup.rows.tickets = [{ ...listed[0]!, lands_after: [{ workspace: 'app', ticket: 'T-9', state: 'missing' }] }, ...listed.slice(1)];
    const again = JSON.parse((await fetchRaw(new URL('api/tickets', base))).body);
    assert.deepEqual([again.tickets[0].lands_after, again.job_lands_after], [[{ workspace: 'app', ticket: 'T-9', state: 'missing' }], waits]);
    setup.rows.tickets = listed;
    setup.rows.jobDependencies = [];
    // The conversation: the message names the connector, guide, the draft, write_task with the
    // Review brief, and the hand-back to the User, who starts on the dashboard; ChatGPT only plans.
    const message = rows[0].conversation.message as string;
    assert.equal(message, ticketConversation('app', 'T-5'));
    // SF-191: the Context owner grills the user in rounds and writes only after the user confirms.
    for (const part of [
      'Software Factory connector', 'Call guide', 'ticket T-5 in workspace app', 'read_file and search', 'write_task (workspace "app", ticket "T-5")', '## Review brief', 'I start the job on the dashboard', 'You only plan',
      'grill me on it in rounds: number your questions, give your recommended answer to each, look facts up yourself, and write the Task file only after I confirm we agree',
    ]) {
      assert.ok(message.includes(part), part);
    }
    for (const gone of ['subscribe', 'software_factory.job', 'request_fix', 'mark_clean', 'call start', 'check', 'ask me what is unclear', 'discuss the solution']) {
      assert.ok(!message.includes(gone), gone);
    }
    assert.equal(rows[0].conversation.url, `${CHATGPT_PREFILL_URL}${encodeURIComponent(message)}`);
    assert.equal(rows[0].conversation.url, conversationUrl(message));
    assert.equal(decodeURIComponent(rows[0].conversation.url.slice(CHATGPT_PREFILL_URL.length)), message);

    // Method rules: the two list-or-act paths answer GET and POST, 405 "GET, POST" otherwise; remove
    // and the ticket's start are POST only; the reads stay GET only.
    const origin = `http://127.0.0.1:${base.port}`;
    const headers = { origin, 'content-type': 'application/json' };
    for (const path of ['api/workspaces', 'api/tickets']) {
      for (const method of ['HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH']) {
        const reply = await fetchRaw(new URL(path, base), { method, headers, body: '{}' });
        assert.deepEqual([reply.status, reply.headers.allow, reply.body], [405, 'GET, POST', ''], `${method} ${path}`);
      }
    }
    // The start is the ticket's (SF-040), not a job's: a POST on the job path is an unknown path.
    const noJobStart = await act(base, 'api/jobs/app/T-5/start', {});
    assert.deepEqual([noJobStart.status, noJobStart.headers.allow], [405, 'GET']);
    for (const path of ['api/workspaces/app/remove', 'api/tickets/app/T-5/start']) {
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']) {
        const reply = await fetchRaw(new URL(path, base), { method, headers, body: '{}' });
        assert.deepEqual([reply.status, reply.headers.allow, reply.body], [405, 'POST', ''], `${method} ${path}`);
      }
    }
    for (const path of ['api/workspaces/app', 'api/workspaces/app/remove/x', 'api/tickets/x']) {
      const got = await fetchRaw(new URL(path, base));
      assert.deepEqual([got.status, got.body], [404, ''], `GET ${path}`);
      const posted = await act(base, path, {});
      assert.deepEqual([posted.status, posted.headers.allow, posted.body], [405, 'GET', ''], `POST ${path}`);
    }
    // The method rule is the route's; a bad name on a remove route is 404 on POST.
    for (const path of ['api/workspaces/App/remove', 'api/workspaces/-app/remove', 'api/workspaces/a%2Fb/remove']) {
      const got = await fetchRaw(new URL(path, base));
      assert.deepEqual([got.status, got.headers.allow, got.body], [405, 'POST', ''], `GET ${path}`);
      const posted = await act(base, path, {});
      assert.deepEqual([posted.status, posted.body], [404, ''], `POST ${path}`);
    }
    const token = base.pathname.split('/')[2]!;
    const wrong = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    for (const path of [`/d/${wrong}/api/workspaces`, `/d/${wrong}/api/tickets`, '/api/workspaces', `/d/${wrong}/api/tickets/app/T-5/start`]) {
      const reply = await fetchRaw(`${origin}${path}`, { method: 'POST', headers, body: '{}' });
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
    }
    assert.deepEqual(setup.calls, []);
    assert.deepEqual(fake.calls, []);
  }, setup);
});

test('dashboard setup: the action checks apply to the setup POSTs; exact arguments, results and error mapping; the pages refresh', async () => {
  const fake = fakeActions({ branch: 'T-5-ticket-t-5', state: 'working', check_after_minutes: 15 });
  const setup = fakeSetup([workspaceRow('app')], [ticketRow('app', 'T-5')]);
  await withDashboard('dash-setup-posts', fake, async (dashboard) => {
    const base = dashboard.url;
    const port = Number(base.port);
    // Origin, content type, body bounds and JSON: as for the job actions.
    for (const path of ['api/workspaces', 'api/tickets', 'api/workspaces/app/remove', 'api/tickets/app/T-5/start']) {
      assert.deepEqual(error(await act(base, path, {}, { headers: { origin: `http://localhost:${port}` } })), { status: 403, code: 'invalid_origin' }, path);
      assert.deepEqual(error(await act(base, path, {}, { headers: { origin: '' } })), { status: 403, code: 'invalid_origin' }, path);
      assert.deepEqual(error(await act(base, path, {}, { headers: { 'content-type': 'text/plain' } })), { status: 415, code: 'unsupported_media_type' }, path);
      assert.deepEqual(error(await act(base, path, undefined, { body: '{' })), { status: 400, code: 'invalid_json' }, path);
      assert.deepEqual(error(await act(base, path, undefined, { body: 'x'.repeat(MAX_ACTION_BODY_BYTES + 1) })), { status: 413, code: 'body_too_large' }, path);
    }
    const bad: Array<[string, string]> = [
      ['api/workspaces', '{}'], ['api/workspaces', '{"name":"app"}'], ['api/workspaces', '{"name":"app","path":1}'], ['api/workspaces', '{"name":"app","path":"/x","work":"/y"}'], ['api/workspaces', '{"name":"app","path":"/x","handoff":"on"}'], ['api/workspaces', '{"name":"app","path":"/x","handoff":null}'], ['api/workspaces', '[]'], ['api/workspaces', 'null'],
      ['api/tickets', '{}'], ['api/tickets', '{"workspace":"app","ticket":"T-1","title":"t"}'], ['api/tickets', '{"workspace":"app","ticket":"T-1","title":"t","request":null}'], ['api/tickets', '{"workspace":"app","ticket":"T-1","title":"t","request":"r","base":"main"}'],
      ['api/workspaces/app/remove', '{"force":true}'], ['api/workspaces/app/remove', '[]'],
      ['api/tickets/app/T-5/start', '{"now":true}'], ['api/tickets/app/T-5/start', '[]'], ['api/tickets/app/T-5/start', 'null'],
    ];
    for (const [path, text] of bad) {
      const reply = await act(base, path, undefined, { body: text });
      assert.deepEqual(error(reply), { status: 400, code: 'invalid_body' }, `${path} ${text}`);
    }
    assert.deepEqual(setup.calls, []);
    assert.deepEqual(fake.calls, []);

    // Exact arguments and results; every change refreshes the open pages' workspaces and tickets.
    const stream = await openStream(new URL('api/stream', base));
    assert.deepEqual((await stream.next('workspaces')).workspaces.map((row: { name: string }) => row.name), ['app']);
    assert.equal((await stream.next('tickets')).tickets[0].ticket, 'T-5');
    assert.deepEqual(result(await act(base, 'api/workspaces', { name: 'web', path: '/srv/web' })), { name: 'web', path: '/srv/web', liveJobs: 0, problem: null, handoff: null, color: 'purple', app: 'web', description: null, derived_description: null, digest: { track: false, my_work: false } });
    assert.deepEqual(setup.calls.at(-1), ['addWorkspace', 'web', '/srv/web']);
    await stream.next('workspaces');
    await stream.next('tickets');
    // The workspace's own hand-over setting (SF-083).
    assert.deepEqual(result(await act(base, 'api/workspaces', { name: 'web', path: '/srv/web', handoff: 'off' })), { name: 'web', path: '/srv/web', liveJobs: 0, problem: null, handoff: 'off', color: 'purple', app: 'web', description: null, derived_description: null, digest: { track: false, my_work: false } });
    assert.deepEqual(setup.calls.at(-1), ['addWorkspace', 'web', '/srv/web', { handoff: 'off' }]);
    await stream.next('workspaces');
    await stream.next('tickets');
    // The workspace's colour on the board (SF-084): one of the palette; anything else is a 400.
    assert.deepEqual(result(await act(base, 'api/workspaces', { name: 'web', path: '/srv/web', color: 'olive' })), { name: 'web', path: '/srv/web', liveJobs: 0, problem: null, handoff: null, color: 'olive', app: 'web', description: null, derived_description: null, digest: { track: false, my_work: false } });
    assert.deepEqual(setup.calls.at(-1), ['addWorkspace', 'web', '/srv/web', { color: 'olive' }]);
    const pink = await act(base, 'api/workspaces', { name: 'web', path: '/srv/web', color: 'pink' });
    assert.equal(pink.status, 400);
    assert.match(JSON.parse(pink.body).error.message, /"color"\?: "blue" \| "teal" \| "green" \| "olive" \| "orange" \| "red" \| "purple" \| "grey"/);
    assert.deepEqual(setup.calls.at(-1), ['addWorkspace', 'web', '/srv/web', { color: 'olive' }]);
    // The morning digest's fields (SF-103): description, app and digest, all optional.
    const digestFields = { description: 'The web front end.', app: 'shop', digest: { track: true, my_work: true } };
    assert.equal(result(await act(base, 'api/workspaces', { name: 'web', path: '/srv/web', ...digestFields })).name, 'web');
    assert.deepEqual(setup.calls.at(-1), ['addWorkspace', 'web', '/srv/web', digestFields]);
    for (const extra of [{ digest: { track: true } }, { app: 1 }, { digest: null }]) {
      assert.deepEqual(error(await act(base, 'api/workspaces', { name: 'web', path: '/srv/web', ...extra })), { status: 400, code: 'invalid_body' }, JSON.stringify(extra));
    }
    await stream.next('workspaces');
    await stream.next('tickets');
    setup.rows.workspaces = [...setup.rows.workspaces, workspaceRow('web')];
    await stream.next('workspaces');
    await stream.next('tickets');
    assert.deepEqual(result(await act(base, 'api/workspaces/web/remove', {})), { removed: 'web' });
    assert.deepEqual(setup.calls.at(-1), ['removeWorkspace', 'web']);
    await stream.next('workspaces');
    const request = 'Please  keep "quotes",\nnew lines — ünïcödé 🚀 ';
    assert.deepEqual(result(await act(base, 'api/tickets', { workspace: 'app', ticket: 'T-6', title: 'Six', request })), { workspace: 'app', ticket: 'T-6', path: '.software-factory/T-6.md', base: 'main' });
    assert.deepEqual(setup.calls.at(-1), ['createTicket', { workspace: 'app', ticket: 'T-6', title: 'Six', request }]);
    await stream.next('tickets');
    assert.deepEqual(fake.calls, []);

    // Error mapping: the guards of the setup with their codes and messages.
    const mapping: Array<[string, string, number]> = [
      ['api/workspaces', 'workspace_exists', 409], ['api/workspaces', 'workspace_invalid', 400], ['api/workspaces', 'invalid_name', 400],
      ['api/workspaces/app/remove', 'workspace_busy', 409], ['api/workspaces/app/remove', 'workspace_not_found', 404],
      ['api/tickets', 'ticket_exists', 409], ['api/tickets', 'invalid_content', 400], ['api/tickets', 'job_active', 409],
    ];
    for (const [path, code, status] of mapping) {
      const failure = new FactoryError(code, `The ${code} message.`);
      fake.answer = failure;
      setup.answer = failure;
      const body = path === 'api/workspaces' ? { name: 'x', path: '/x' } : path === 'api/tickets' ? { workspace: 'app', ticket: 'T-7', title: 't', request: 'r' } : {};
      const reply = await act(base, path, body);
      assert.equal(reply.status, status, `${path} ${code}`);
      assert.deepEqual(JSON.parse(reply.body), { ok: false, error: { code, message: `The ${code} message.` } });
    }
    stream.close();
  }, setup);
});

const PLAN = '---\nticket: T-2\ntitle: Planned\nbase: feature/x\nscope: [src/**, test/a.test.ts, package.json]\nmay_touch: [package.json, .github/**]\nlands_after: [T-1, T-3, T-4, T-5, T-6, web/W-1]\n---\n\n# T-2: Planned\n\nDo it.\n';

test('dashboard ticket page (SF-081): the page payload of a skeleton and of a written plan, each dependency state, 404s and the method rules', async () => {
  const fake = fakeActions();
  const deps = [
    { workspace: 'app', ticket: 'T-1', state: 'merged' }, { workspace: 'app', ticket: 'T-3', state: 'pushed' }, { workspace: 'app', ticket: 'T-4', state: 'running' },
    { workspace: 'app', ticket: 'T-5', state: 'planned' }, { workspace: 'app', ticket: 'T-6', state: 'missing' }, { workspace: 'web', ticket: 'W-1', state: 'planned' },
  ] as const;
  const setup = fakeSetup([workspaceRow('app')], [ticketRow('app', 'T-1', 'Skeleton'), { ...ticketRow('app', 'T-2', 'Planned', false), base: 'feature/x', lands_after: [...deps] }]);
  setup.texts.set('app/T-1', draftContent('T-1', 'Skeleton', 'main'));
  setup.texts.set('app/T-2', PLAN);
  await withDashboard('dash-ticket-page', fake, async (dashboard) => {
    const base = dashboard.url;
    const skeleton = JSON.parse((await fetchRaw(new URL('api/tickets/app/T-1/page', base))).body);
    assert.deepEqual(Object.keys(skeleton), ['ticket', 'task', 'plan', 'check', 'check_rounds', 'check_usd', 'check_usd_complete', 'history', 'queue']);
    assert.deepEqual([skeleton.ticket.ticket, skeleton.ticket.draft, skeleton.ticket.conversation.message], ['T-1', true, ticketConversation('app', 'T-1')]);
    assert.deepEqual(skeleton.task, { text: draftContent('T-1', 'Skeleton', 'main'), sha256: taskSha256(draftContent('T-1', 'Skeleton', 'main')) });
    assert.deepEqual(skeleton.plan, { starts_from: 'main', files: [], scoped: false, waits_for: [] });
    // Without the Task checks there is no check; the queue is SF-071's; nothing recorded, the
    // fixture's job of T-1 read from the state directory.
    assert.deepEqual([skeleton.check, skeleton.queue], [null, null]);
    assert.deepEqual(skeleton.history.map((entry: { kind: string; text: string }) => [entry.kind, entry.text]), [
      ['started', 'Started as a job (now: awaiting_review)'], ['note', 'Older steps were not recorded; they are known only from checks and jobs.'],
    ]);

    const planned = await fetchRaw(new URL('api/tickets/app/T-2/page', base));
    assert.equal(planned.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(planned.headers['content-security-policy'], CSP);
    const page = JSON.parse(planned.body);
    assert.deepEqual(page.plan, {
      starts_from: 'feature/x',
      files: [
        { path: 'src/**', sensitive: false }, { path: 'test/a.test.ts', sensitive: false }, { path: 'package.json', sensitive: true }, { path: '.github/**', sensitive: true },
      ],
      scoped: true,
      // SF-084's states, one per dependency; another workspace's ticket with its workspace.
      waits_for: [
        { ticket: 'T-1', state: 'merged', merged: true }, { ticket: 'T-3', state: 'pushed', merged: false }, { ticket: 'T-4', state: 'running', merged: false },
        { ticket: 'T-5', state: 'planned', merged: false }, { ticket: 'T-6', state: 'missing', merged: false }, { ticket: 'web/W-1', state: 'planned', merged: false },
      ],
    });

    // Not in the tickets list (a live job's ticket, an unknown one), bad names, a query, more
    // segments: an empty 404; POST is not a route of the page.
    const origin = `http://127.0.0.1:${base.port}`;
    for (const path of ['api/tickets/app/T-9/page', 'api/tickets/web/T-2/page', 'api/tickets/App/T-2/page', 'api/tickets/app/..%2FT-2/page', 'api/tickets/app/T-2/page?x=1', 'api/tickets/app/T-2/page/x']) {
      const missing = await fetchRaw(new URL(path, base));
      assert.deepEqual([missing.status, missing.body], [404, ''], path);
    }
    const posted = await fetchRaw(new URL('api/tickets/app/T-2/page', base), { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual([posted.status, posted.headers.allow], [405, 'GET']);
    // A Task file the reader refuses answers the refusal.
    setup.texts.set('app/T-2', 'no front matter');
    setup.taskFile = async () => {
      throw new FactoryError('invalid_content', 'content must start with a front-matter block.');
    };
    assert.deepEqual(error(await fetchRaw(new URL('api/tickets/app/T-2/page', base))), { status: 400, code: 'invalid_content' });
    assert.deepEqual(setup.calls, []);
    assert.deepEqual(fake.calls, []);
  }, setup);
});

test('dashboard ticket page (SF-081): Save posts the content and the sha256 read; the body checks, a body over 128 KB taken, the error mapping and the refresh', async () => {
  const fake = fakeActions();
  const setup = fakeSetup([workspaceRow('app')], [ticketRow('app', 'T-2', 'Planned', false)]);
  setup.texts.set('app/T-2', PLAN);
  await withDashboard('dash-ticket-save', fake, async (dashboard) => {
    const base = dashboard.url;
    const path = 'api/tickets/app/T-2/task';
    const sha256 = taskSha256(PLAN);
    assert.deepEqual(error(await act(base, path, { content: PLAN, sha256 }, { headers: { origin: 'http://localhost' } })), { status: 403, code: 'invalid_origin' });
    assert.deepEqual(error(await act(base, path, { content: PLAN, sha256 }, { headers: { 'content-type': 'text/plain' } })), { status: 415, code: 'unsupported_media_type' });
    assert.deepEqual(error(await act(base, path, undefined, { body: '{' })), { status: 400, code: 'invalid_json' });
    for (const text of ['{}', `{"content":"x"}`, `{"sha256":"x"}`, `{"content":null,"sha256":"x"}`, `{"content":"x","sha256":"y","force":true}`, '[]', 'null']) {
      const reply = await act(base, path, undefined, { body: text });
      assert.deepEqual(error(reply), { status: 400, code: 'invalid_body' }, text);
      assert.match(JSON.parse(reply.body).error.message, /\{"content": string, "sha256": string\}/);
    }
    assert.deepEqual(error(await act(base, path, undefined, { body: 'x'.repeat(MAX_TASK_BODY_BYTES + 1) })), { status: 413, code: 'body_too_large' });
    assert.match(JSON.parse((await act(base, path, undefined, { body: 'x'.repeat(MAX_TASK_BODY_BYTES + 1) })).body).error.message, new RegExp(`at most ${MAX_TASK_BODY_BYTES} bytes`));
    for (const name of ['App', '-app']) {
      const reply = await act(base, `api/tickets/${name}/T-2/task`, { content: PLAN, sha256 });
      assert.deepEqual([reply.status, reply.body], [404, '']);
    }
    assert.deepEqual(setup.calls, []);

    const stream = await openStream(new URL('api/stream', base));
    await stream.next('tickets');
    // A Task file bigger than the job actions' 128 KB bound, within the Task file's own.
    const big = `${PLAN}${'x'.repeat(MAX_ACTION_BODY_BYTES + 1024)}\n`;
    assert.ok(Buffer.byteLength(big) < MAX_TASK_BYTES);
    assert.deepEqual(result(await act(base, path, { content: big, sha256 })), { path: '.software-factory/T-2.md', status: 'replaced', bytes: Buffer.byteLength(big), sha256: taskSha256(big) });
    assert.deepEqual(setup.calls, [['saveTask', 'app', 'T-2', big, sha256]]);
    // The new version (and the stale check) reaches every page.
    await stream.next('tickets');
    stream.close();

    for (const [code, status] of [['task_changed', 409], ['job_active', 409], ['invalid_content', 400], ['task_not_found', 404]] as const) {
      setup.answer = new FactoryError(code, `The ${code} message.`);
      const reply = await act(base, path, { content: PLAN, sha256 });
      assert.deepEqual([reply.status, JSON.parse(reply.body)], [status, { ok: false, error: { code, message: `The ${code} message.` } }], code);
    }
    assert.deepEqual(fake.calls, []);
  }, setup);
});

test('dashboard ticket page (SF-081) through the real Setup: the history and the check of the page, Save over the version read, a stale sha256, an invalid file and a running job refused', async () => {
  const env = await newEnv('dash-ticket-real');
  const repo = await newRepo(env, 'dash-ticket-real-repo', true);
  await mkdir(env.state, { recursive: true });
  const jobs = new JobStore(env.state);
  const history = new TicketHistory(env.state);
  let lock: Promise<unknown> = Promise.resolve();
  const setup = new Setup({
    configDir: env.config, jobs, history,
    exclusive: (work) => {
      const next = lock.catch(() => undefined).then(() => work({ retireFinished: async () => assert.fail('nothing is retired here') }));
      lock = next;
      return next;
    },
  });
  const checks = new TaskChecks({ claudePath: undefined, sandbox: undefined, model: undefined, maxTurns: 1, rulesMaxBytes: 49152, stateDir: env.state, configDir: env.config, worktreeRoot: join(env.state, 'worktrees'), resolve: (name) => resolveWorkspace(name, env.config) });
  const dashboard = await startDashboard(0, env.state, jobs, fakeActions(), setup, { checks });
  try {
    const base = dashboard.url;
    const pageOf = async (): Promise<Record<string, any>> => JSON.parse((await fetchRaw(new URL('api/tickets/app/T-1/page', base))).body);
    await setup.createTicket({ workspace: 'app', ticket: 'T-1', title: 'One', request: 'r' });
    const skeleton = await pageOf();
    assert.deepEqual(skeleton.history.map((entry: { text: string }) => entry.text), ['Created by you']);
    assert.deepEqual([skeleton.check.check, skeleton.check.stale, skeleton.check.running], [null, false, false]);

    // Save over the version read: written, recorded, the page shows the new version.
    const plan = PLAN.replaceAll('T-2', 'T-1');
    assert.equal(result(await act(base, 'api/tickets/app/T-1/task', { content: plan, sha256: skeleton.task.sha256 })).sha256, taskSha256(plan));
    assert.equal(await readFile(join(repo, '.software-factory', 'T-1.md'), 'utf8'), plan);
    const saved = await pageOf();
    assert.deepEqual(saved.task, { text: plan, sha256: taskSha256(plan) });
    assert.deepEqual(saved.history.map((entry: { text: string }) => entry.text), ['Edited by you', 'Created by you']);
    // A checked plan: the check of this version; a save makes it stale.
    await new CheckStore(env.state).write({
      workspace: 'app', ticket: 'T-1', sha256: taskSha256(plan), commit: null, status: 'checked', error: null, model: 'm', cost_usd: 0.48,
      started_at: '2099-01-01T00:00:00.000Z', ended_at: '2099-01-01T00:01:00.000Z', output: { paraphrase: 'p', verdict: 'ready', files: [], findings: [] },
    });
    const checked = await pageOf();
    assert.deepEqual([checked.check.check.output.verdict, checked.check.stale], ['ready', false]);
    assert.equal(checked.history[0].text, 'Checked: ready · $0.48');

    // A stale sha256 (the skeleton's): refused, nothing written. An invalid file. A running job.
    assert.deepEqual(error(await act(base, 'api/tickets/app/T-1/task', { content: `${plan}More.\n`, sha256: skeleton.task.sha256 })), { status: 409, code: 'task_changed' });
    assert.deepEqual(error(await act(base, 'api/tickets/app/T-1/task', { content: 'no front matter', sha256: taskSha256(plan) })), { status: 400, code: 'invalid_content' });
    const edited = `${plan}More.\n`;
    assert.equal(result(await act(base, 'api/tickets/app/T-1/task', { content: edited, sha256: taskSha256(plan) })).sha256, taskSha256(edited));
    assert.equal((await pageOf()).check.stale, true);
    await jobs.write({
      workspace: 'app', ticket: 'T-1', branch: 'T-1-x', base: 'main', continues: null, base_commit: null, target_commit: null, worktree: null, prepared_commit: null, mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0,
      state: 'working', iteration: 0, session_id: null, mr: null, created_at: '2026-11-05T10:00:00.000Z', updated_at: '2026-11-05T10:00:00.000Z',
    });
    assert.deepEqual(error(await act(base, 'api/tickets/app/T-1/task', { content: `${edited}Again.\n`, sha256: taskSha256(edited) })), { status: 409, code: 'job_active' });
    assert.equal(await readFile(join(repo, '.software-factory', 'T-1.md'), 'utf8'), edited);
    // A ticket with a live job is not in the tickets list: no page.
    assert.equal((await fetchRaw(new URL('api/tickets/app/T-1/page', base))).status, 404);
  } finally {
    await dashboard.close();
  }
});

test('dashboard images (SF-064) through the real Setup: upload by bytes, the type, size, count and name rules, the image served, removal, the guard, the payload and the first message', async () => {
  const env = await newEnv('dash-images');
  const repo = await newRepo(env, 'dash-images-repo', true);
  await mkdir(env.state, { recursive: true });
  const jobs = new JobStore(env.state);
  let lock: Promise<unknown> = Promise.resolve();
  const setup = new Setup({
    configDir: env.config, jobs,
    exclusive: (work) => {
      const next = lock.catch(() => undefined).then(() => work({ retireFinished: async () => assert.fail('nothing is retired here') }));
      lock = next;
      return next;
    },
  });
  const dashboard = await startDashboard(0, env.state, jobs, fakeActions(), setup);
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png')]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  try {
    const base = dashboard.url;
    const origin = `http://127.0.0.1:${base.port}`;
    const upload = (path: string, body: Buffer, headers: Record<string, string> = {}): Promise<Reply> =>
      fetchRaw(new URL(path, base), { method: 'POST', headers: { origin, 'content-type': 'application/octet-stream', ...headers }, body });
    const dir = join(repo, '.software-factory', 'T-1');
    // No Task file: task_not_found (404).
    assert.deepEqual(error(await upload('api/tickets/app/T-1/attachments', PNG)), { status: 404, code: 'task_not_found' });
    await setup.createTicket({ workspace: 'app', ticket: 'T-1', title: 'One', request: 'See the screenshot.' });

    // Uploads: without a name the next number, with one as given; the answer {name, bytes, type}.
    assert.deepEqual(result(await upload('api/tickets/app/T-1/attachments', PNG)), { name: '1.png', bytes: PNG.length, type: 'image/png' });
    assert.deepEqual(result(await upload('api/tickets/app/T-1/attachments?name=2.jpg', JPEG)), { name: '2.jpg', bytes: JPEG.length, type: 'image/jpeg' });
    assert.deepEqual(await readFile(join(dir, '1.png')), PNG);
    // A non-image renamed .png, a name with another extension, names that leave the folder.
    assert.deepEqual(error(await upload('api/tickets/app/T-1/attachments?name=fake.png', Buffer.from('not an image'))), { status: 400, code: 'attachment_type' });
    assert.deepEqual(error(await upload('api/tickets/app/T-1/attachments?name=x.jpg', PNG)), { status: 400, code: 'invalid_name' });
    for (const name of ['../T-1.md', '..%2FT-1.png', 'a/b.png', '%2Fetc%2Fx.png', '.x.png']) {
      assert.deepEqual(error(await upload(`api/tickets/app/T-1/attachments?name=${name}`, PNG)), { status: 400, code: 'invalid_name' }, name);
    }
    // At most 5 MB: the body's bound answers attachment_too_large (413), declared or streamed.
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
    assert.deepEqual(error(await upload('api/tickets/app/T-1/attachments', big)), { status: 413, code: 'attachment_too_large' });
    assert.deepEqual(error(await fetchRaw(new URL('api/tickets/app/T-1/attachments', base), { method: 'POST', headers: { origin, 'content-type': 'application/octet-stream' }, body: big, chunk: 1024 * 1024 })), { status: 413, code: 'attachment_too_large' });
    // The transport checks: Origin, the content type (not JSON), the method, the query, the names in the path.
    assert.deepEqual(error(await upload('api/tickets/app/T-1/attachments', PNG, { origin: 'http://127.0.0.1:1' })), { status: 403, code: 'invalid_origin' });
    assert.deepEqual(error(await upload('api/tickets/app/T-1/attachments', PNG, { 'content-type': 'application/json' })), { status: 415, code: 'unsupported_media_type' });
    assert.deepEqual(error(await upload('api/tickets/app/T-1/attachments', PNG, { 'content-type': 'image/png' })), { status: 415, code: 'unsupported_media_type' });
    assert.equal((await fetchRaw(new URL('api/tickets/app/T-1/attachments', base))).status, 405);
    assert.equal((await upload('api/tickets/app/T-1/attachments?name=a.png&name=b.png', PNG)).status, 404);
    assert.equal((await upload('api/tickets/app/T-1/attachments?other=1', PNG)).status, 404);
    assert.equal((await upload('api/tickets/App/T-1/attachments', PNG)).status, 404);
    assert.deepEqual(error(await upload('api/tickets/app/archive/attachments', PNG)), { status: 400, code: 'invalid_ticket' });
    assert.deepEqual((await readdir(dir)).sort(), ['1.png', '2.jpg']);

    // Served with the type its bytes tell and nosniff; a missing one, a bad name.
    const served = await fetchRaw(new URL('api/tickets/app/T-1/attachments/2.jpg', base));
    assert.deepEqual([served.status, served.headers['content-type'], served.headers['x-content-type-options'], served.raw], [200, 'image/jpeg', 'nosniff', JPEG]);
    assert.equal(served.headers['content-security-policy'], CSP);
    assert.equal((await fetchRaw(new URL('api/tickets/app/T-1/attachments/9.png', base))).status, 404);
    assert.equal((await fetchRaw(new URL('api/tickets/app/T-1/attachments/1.png?x=1', base))).status, 404);
    assert.equal((await fetchRaw(new URL('api/tickets/app/T-9/attachments/1.png', base))).status, 404);
    assert.deepEqual(error(await fetchRaw(new URL('api/tickets/app/T-1/attachments/1.txt', base))), { status: 400, code: 'invalid_name' });
    await writeFile(join(dir, '5.png'), 'renamed text');
    assert.deepEqual(error(await fetchRaw(new URL('api/tickets/app/T-1/attachments/5.png', base))), { status: 400, code: 'attachment_type' });

    // The payload lists the images (the renamed text file is none) and the first message names them.
    const row = JSON.parse((await fetchRaw(new URL('api/tickets', base))).body).tickets[0];
    assert.deepEqual(row.attachments, [{ name: '1.png', bytes: PNG.length, type: 'image/png' }, { name: '2.jpg', bytes: JPEG.length, type: 'image/jpeg' }]);
    assert.equal(row.conversation.message, ticketConversation('app', 'T-1', 'See the screenshot.', ['1.png', '2.jpg']));
    assert.ok(row.conversation.message.includes('The ticket has images: 1.png, 2.jpg. Read each with read_attachment (workspace "app", ticket "T-1", name). In the Task file, refer to the images the Task needs as ![what it shows](T-1/<name>). You only plan'));

    // At most 10 per ticket: attachment_limit (409).
    for (let index = 0; index < 8; index += 1) {
      result(await upload('api/tickets/app/T-1/attachments', PNG));
    }
    assert.deepEqual(error(await upload('api/tickets/app/T-1/attachments', PNG)), { status: 409, code: 'attachment_limit' });

    // Remove: POST with {}; a missing one is attachment_missing; the body is checked.
    assert.deepEqual(result(await act(base, 'api/tickets/app/T-1/attachments/1.png/remove', {})), { name: '1.png' });
    assert.deepEqual(error(await act(base, 'api/tickets/app/T-1/attachments/1.png/remove', {})), { status: 400, code: 'attachment_missing' });
    assert.deepEqual(error(await act(base, 'api/tickets/app/T-1/attachments/2.jpg/remove', { name: 'x' })), { status: 400, code: 'invalid_body' });
    assert.deepEqual(error(await act(base, 'api/tickets/app/T-1/attachments/..png/remove', {})), { status: 400, code: 'invalid_name' });
    assert.equal((await fetchRaw(new URL('api/tickets/app/T-1/attachments/2.jpg/remove', base))).status, 405);
    // The gap is not reused: after 5.png (the renamed text) the uploads were 6.png to 13.png.
    assert.equal(result(await upload('api/tickets/app/T-1/attachments', PNG)).name, '14.png');

    // The guard: a running job refuses both, a paused one does not.
    const jobOf = (state: 'working' | 'paused') => ({
      workspace: 'app', ticket: 'T-1', branch: 'T-1-x', base: 'main', continues: null, base_commit: null, target_commit: null, worktree: null, prepared_commit: null, mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0,
      state, iteration: 0, session_id: null, mr: null, created_at: '2026-11-05T10:00:00.000Z', updated_at: '2026-11-05T10:00:00.000Z',
    });
    await jobs.write(jobOf('working'));
    assert.deepEqual(error(await act(base, 'api/tickets/app/T-1/attachments/2.jpg/remove', {})), { status: 409, code: 'job_active' });
    assert.deepEqual(error(await upload('api/tickets/app/T-1/attachments', PNG)), { status: 409, code: 'job_active' });
    await jobs.write(jobOf('paused'));
    assert.deepEqual(result(await act(base, 'api/tickets/app/T-1/attachments/2.jpg/remove', {})), { name: '2.jpg' });
  } finally {
    await dashboard.close();
  }
});

test('dashboard images (SF-064): the upload reaches the setup with its bytes and name, and the pages refresh', async () => {
  const setup = fakeSetup([workspaceRow('app')], [ticketRow('app', 'T-1')]);
  await withDashboard('dash-images-fake', fakeActions(), async (dashboard) => {
    const base = dashboard.url;
    const stream = await openStream(new URL('api/stream', base));
    try {
      await stream.next('tickets');
      const origin = `http://127.0.0.1:${base.port}`;
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const reply = await fetchRaw(new URL('api/tickets/app/T-1/attachments?name=1.png', base), { method: 'POST', headers: { origin, 'content-type': 'application/octet-stream' }, body: bytes });
      assert.equal(reply.status, 200, reply.body);
      assert.deepEqual(setup.calls.at(-1), ['addAttachment', 'app', 'T-1', bytes.toString('hex'), '1.png']);
      await stream.next('tickets');
      await fetchRaw(new URL('api/tickets/app/T-1/attachments', base), { method: 'POST', headers: { origin, 'content-type': 'application/octet-stream' }, body: bytes });
      assert.deepEqual(setup.calls.at(-1), ['addAttachment', 'app', 'T-1', bytes.toString('hex'), null]);
      assert.equal((await act(base, 'api/tickets/app/T-1/attachments/1.png/remove', {})).status, 200);
      assert.deepEqual(setup.calls.at(-1), ['removeAttachment', 'app', 'T-1', '1.png']);
    } finally {
      stream.close();
    }
  }, setup);
});

test('dashboard setup end to end: a workspace from the page, a ticket draft, the Task file over MCP, the User starts the job from the page', async () => {
  const env = await newEnv('dash-setup-e2e');
  // The registry starts empty: the page registers the checkout.
  const repo = await newRepo(env, 'dash-setup-repo', true);
  await runCli(env, ['workspace', 'remove', 'app']);
  await script(env, [{ write: { 'README.md': 'hello world\n' }, text: '# Report: T-1, iteration 1\n\n## Done\nChanged.' }]);
  const served = await serve(env);
  try {
    const base = served.dashboard!;
    assert.deepEqual(JSON.parse((await fetchRaw(new URL('api/workspaces', base))).body), { workspaces: [], handoff_default: 'off', digest: { at: '08:00', weekdays_only: true, language: 'English' } });
    const stream = await openStream(new URL('api/stream', base));
    assert.deepEqual((await stream.next('workspaces')).workspaces, []);
    assert.deepEqual((await stream.next('tickets')).tickets, []);

    // Add: the CLI's rules and texts, then the registry the CLI reads.
    const missing = await act(base, 'api/workspaces', { name: 'app', path: join(temp, 'nowhere') });
    assert.deepEqual(JSON.parse(missing.body), { ok: false, error: { code: 'workspace_invalid', message: 'The path does not exist.' } });
    const row = { name: 'app', path: repo, liveJobs: 0, problem: null, handoff: 'off', color: 'teal', app: 'app', description: null, derived_description: 'hello', digest: { track: false, my_work: false } };
    assert.deepEqual(result(await act(base, 'api/workspaces', { name: 'app', path: repo, handoff: 'off' })), row);
    assert.deepEqual((await stream.next('workspaces')).workspaces, [row]);
    assert.deepEqual((await loadRegistry(env.config)).workspaces, { app: { read_checkout: repo, handoff: 'off' } });
    const listed = await runCli(env, ['workspace', 'list']);
    assert.match(listed.stdout, new RegExp(`^app\\n  checkout: ${repo}\\n  hand-over: off \\(this workspace\\)$`, 'm'));
    assert.deepEqual(error(await act(base, 'api/workspaces', { name: 'app', path: repo })), { status: 409, code: 'workspace_exists' });

    // A ticket skeleton: the exact file without the user's words; the words are in the
    // conversation's first message; a second ticket is refused.
    const words = 'Say hello world in the README.';
    const created = result(await act(base, 'api/tickets', { workspace: 'app', ticket: 'T-1', title: 'Change README', request: words }));
    assert.deepEqual(created, { workspace: 'app', ticket: 'T-1', path: '.software-factory/T-1.md', base: 'main' });
    assert.equal(await readFile(join(repo, '.software-factory', 'T-1.md'), 'utf8'), draftContent('T-1', 'Change README', 'main'));
    assert.doesNotMatch(await readFile(join(repo, '.software-factory', 'T-1.md'), 'utf8'), /hello world/);
    const tickets = (await stream.next('tickets', (data) => data.tickets.length === 1)).tickets;
    assert.deepEqual([tickets[0].ticket, tickets[0].draft, tickets[0].request, tickets[0].job], ['T-1', true, words, null]);
    assert.equal(tickets[0].conversation.url, conversationUrl(ticketConversation('app', 'T-1', words)));
    assert.match(tickets[0].conversation.message, /Here is what I want, in my words:\n\nSay hello world in the README\./);
    assert.deepEqual(error(await act(base, 'api/tickets', { workspace: 'app', ticket: 'T-1', title: 'Again', request: 'x' })), { status: 409, code: 'ticket_exists' });

    // The User cannot start the skeleton; the planner writes the Task file over MCP (no token),
    // then the User starts it from the page. The ticket leaves the list, the workspace counts a
    // live job, and the checkout cannot be removed meanwhile.
    assert.deepEqual(error(await act(base, 'api/tickets/app/T-1/start', {})), { status: 409, code: 'task_draft' });
    assert.equal(await new JobStore(env.state).read('app', 'T-1'), undefined);
    await call(served, 'write_task', { workspace: 'app', ticket: 'T-1', content: '---\nticket: T-1\ntitle: Change README\nbase: main\n---\n\n# T-1: Change README\n\nSay hello world in the README.\n' });
    const written = JSON.parse((await fetchRaw(new URL('api/tickets', base))).body).tickets[0];
    assert.deepEqual([written.ticket, written.draft], ['T-1', false]);
    const started = result(await act(base, 'api/tickets/app/T-1/start', {}));
    assert.deepEqual([started.branch, started.state, started.check_after_minutes], ['T-1-change-readme', 'working', 15]);
    assert.equal((await stream.next('tickets', (data) => data.tickets.length === 0)).tickets.length, 0);
    assert.equal((await stream.next('workspaces', (data) => data.workspaces[0]?.liveJobs === 1)).workspaces[0].name, 'app');
    assert.deepEqual(error(await act(base, 'api/workspaces/app/remove', {})), { status: 409, code: 'workspace_busy' });
    // A second start of the live job is refused.
    assert.deepEqual(error(await act(base, 'api/tickets/app/T-1/start', {})), { status: 409, code: 'job_exists' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    const job = (await new JobStore(env.state).read('app', 'T-1'))!;
    assert.deepEqual([job.branch, job.base, job.iteration], ['T-1-change-readme', 'main', 1]);
    // Ended: the ticket is listed again with its last job, and the workspace can be removed.
    assert.equal((await runCli(env, ['abort', 'app', 'T-1'])).code, 0);
    const back = (await stream.next('tickets', (data) => data.tickets.length === 1)).tickets[0];
    assert.deepEqual([back.ticket, back.draft, back.job], ['T-1', false, 'aborted']);
    assert.deepEqual(result(await act(base, 'api/workspaces/app/remove', {})), { removed: 'app' });
    assert.deepEqual((await loadRegistry(env.config)).workspaces, {});
    stream.close();
  } finally {
    await stop(served);
  }
});
