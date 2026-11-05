// The start screen's HTTP contract (SF-025, SF-028, SF-040): api/workspaces and api/tickets on GET
// and POST, api/workspaces/<name>/remove and api/tickets/<ws>/<ticket>/start on POST (the board's
// Task route is in dashboard-board.test.ts), with the action checks of SF-018, against fake setup
// and actions in process; the stream's workspaces and tickets events; then end to end through
// `sf serve`: a workspace added from the page, a ticket draft, the Task file written by the
// planner over MCP, and the User's start from the page.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_ACTION_BODY_BYTES } from '../src/dashboard.js';
import { FactoryError } from '../src/errors.js';
import { CHATGPT_PREFILL_URL, conversationUrl, ticketConversation } from '../src/conversation.js';
import { JobStore } from '../src/jobs.js';
import { loadRegistry } from '../src/registry.js';
import { draftContent } from '../src/setup.js';
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
    assert.deepEqual(JSON.parse(workspaces.body), { workspaces: [{ name: 'app', path: '/srv/app', liveJobs: 1, problem: null, handoff: null }, { name: 'web', path: '/srv/web', liveJobs: 0, problem: null, handoff: null }] });

    const tickets = await fetchRaw(new URL('api/tickets', base));
    assert.equal(tickets.status, 200);
    const rows = JSON.parse(tickets.body).tickets;
    assert.deepEqual(Object.keys(rows[0]).sort(), ['base', 'conversation', 'draft', 'job', 'request', 'ticket', 'title', 'workspace']);
    assert.deepEqual([rows[1].draft, rows[1].job], [false, 'pushed']);
    // The conversation: the message names the connector, guide, the draft, write_task with the
    // Review brief, and the hand-back to the User, who starts on the dashboard; ChatGPT only plans.
    const message = rows[0].conversation.message as string;
    assert.equal(message, ticketConversation('app', 'T-5'));
    for (const part of ['Software Factory connector', 'Call guide', 'ticket T-5 in workspace app', 'read_file and search', 'write_task (workspace "app", ticket "T-5")', '## Review brief', 'I start the job on the dashboard', 'You only plan']) {
      assert.ok(message.includes(part), part);
    }
    for (const gone of ['subscribe', 'software_factory.job', 'request_fix', 'mark_clean', 'call start', 'check']) {
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
    assert.deepEqual(result(await act(base, 'api/workspaces', { name: 'web', path: '/srv/web' })), { name: 'web', path: '/srv/web', liveJobs: 0, problem: null, handoff: null });
    assert.deepEqual(setup.calls.at(-1), ['addWorkspace', 'web', '/srv/web']);
    await stream.next('workspaces');
    await stream.next('tickets');
    // The workspace's own hand-over setting (SF-083).
    assert.deepEqual(result(await act(base, 'api/workspaces', { name: 'web', path: '/srv/web', handoff: 'off' })), { name: 'web', path: '/srv/web', liveJobs: 0, problem: null, handoff: 'off' });
    assert.deepEqual(setup.calls.at(-1), ['addWorkspace', 'web', '/srv/web', 'off']);
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

test('dashboard setup end to end: a workspace from the page, a ticket draft, the Task file over MCP, the User starts the job from the page', async () => {
  const env = await newEnv('dash-setup-e2e');
  // The registry starts empty: the page registers the checkout.
  const repo = await newRepo(env, 'dash-setup-repo', true);
  await runCli(env, ['workspace', 'remove', 'app']);
  await script(env, [{ write: { 'README.md': 'hello world\n' }, text: '# Report: T-1, iteration 1\n\n## Done\nChanged.' }]);
  const served = await serve(env);
  try {
    const base = served.dashboard!;
    assert.deepEqual(JSON.parse((await fetchRaw(new URL('api/workspaces', base))).body), { workspaces: [] });
    const stream = await openStream(new URL('api/stream', base));
    assert.deepEqual((await stream.next('workspaces')).workspaces, []);
    assert.deepEqual((await stream.next('tickets')).tickets, []);

    // Add: the CLI's rules and texts, then the registry the CLI reads.
    const missing = await act(base, 'api/workspaces', { name: 'app', path: join(temp, 'nowhere') });
    assert.deepEqual(JSON.parse(missing.body), { ok: false, error: { code: 'workspace_invalid', message: 'The path does not exist.' } });
    assert.deepEqual(result(await act(base, 'api/workspaces', { name: 'app', path: repo, handoff: 'off' })), { name: 'app', path: repo, liveJobs: 0, problem: null, handoff: 'off' });
    assert.deepEqual((await stream.next('workspaces')).workspaces, [{ name: 'app', path: repo, liveJobs: 0, problem: null, handoff: 'off' }]);
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
