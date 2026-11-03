// The start screen's HTTP contract (SF-025, SF-028): api/workspaces and api/tickets on GET and POST,
// api/workspaces/<name>/remove on POST (no start route: the job starts in the conversation), with the action checks
// of SF-018, against fake setup and actions in process; the stream's workspaces and tickets
// events; then end to end through `sf serve`: a workspace added from the page, a ticket draft, a
// subscription that turns the ticket's reviewer line, and a start that creates the real job.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MAX_ACTION_BODY_BYTES } from '../src/dashboard.js';
import { FactoryError } from '../src/errors.js';
import { CHATGPT_PREFILL_URL, conversationUrl, ticketConversation, ticketInstruction } from '../src/events.js';
import { JobStore } from '../src/jobs.js';
import { loadRegistry } from '../src/registry.js';
import { draftContent } from '../src/setup.js';
import { act, CSP, fakeActions, fakeReviewers, fakeSetup, fetchRaw, openStream, type Reply, subscription, ticketRow, workspaceRow } from './support/dashboard-client.js';
import { withDashboard } from './support/dashboard-state.js';
import { AUDIENCE, type FakeAs, startFakeAs } from './support/fake-as.js';
import { call, git, newEnv, newRepo, refused, runCli, script, serve, type Served, stop, temp, waitFor } from './support/harness.js';
import { startWebhookSink } from './support/webhook-sink.js';

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
  const reviewers = fakeReviewers([subscription('sub_own', { workspace: 'app', ticket: 'T-5' }), subscription('sub_web', { workspace: 'web' })]);
  await withDashboard('dash-setup-reads', fake, async (dashboard) => {
    const base = dashboard.url;
    const workspaces = await fetchRaw(new URL('api/workspaces', base));
    assert.equal(workspaces.status, 200);
    assert.equal(workspaces.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(workspaces.headers['content-security-policy'], CSP);
    assert.deepEqual(JSON.parse(workspaces.body), { workspaces: [{ name: 'app', path: '/srv/app', liveJobs: 1, problem: null }, { name: 'web', path: '/srv/web', liveJobs: 0, problem: null }] });

    const tickets = await fetchRaw(new URL('api/tickets', base));
    assert.equal(tickets.status, 200);
    const rows = JSON.parse(tickets.body).tickets;
    assert.deepEqual(Object.keys(rows[0]).sort(), ['base', 'conversation', 'draft', 'job', 'request', 'reviewer', 'ticket', 'title', 'workspace']);
    assert.deepEqual(rows[0].reviewer, { status: 'subscribed', id: 'sub_own', host: 'chatgpt.example', input: { workspace: 'app', ticket: 'T-5' }, broad: [] });
    assert.deepEqual([rows[1].reviewer.status, rows[1].reviewer.id, rows[1].draft, rows[1].job], ['broad', 'sub_web', false, 'pushed']);
    // The conversation: the message names the connector, guide, the draft, write_task, the subscription and the wait; the URL is the prefilled composer.
    const message = rows[0].conversation.message as string;
    assert.equal(message, ticketConversation('app', 'T-5'));
    for (const part of ['Software Factory connector', 'Call guide', 'ticket T-5 in workspace app', 'read_file and search', 'write_task (workspace "app", ticket "T-5")', ticketInstruction('app', 'T-5'), 'Do not call start until I say start']) {
      assert.ok(message.includes(part), part);
    }
    assert.equal(rows[0].conversation.url, `${CHATGPT_PREFILL_URL}${encodeURIComponent(message)}`);
    assert.equal(rows[0].conversation.url, conversationUrl(message));
    assert.equal(decodeURIComponent(rows[0].conversation.url.slice(CHATGPT_PREFILL_URL.length)), message);

    // Method rules: the two list-or-act paths answer GET and POST, 405 "GET, POST" otherwise; remove
    // and start are POST only; the reads stay GET only.
    const origin = `http://127.0.0.1:${base.port}`;
    const headers = { origin, 'content-type': 'application/json' };
    for (const path of ['api/workspaces', 'api/tickets']) {
      for (const method of ['HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH']) {
        const reply = await fetchRaw(new URL(path, base), { method, headers, body: '{}' });
        assert.deepEqual([reply.status, reply.headers.allow, reply.body], [405, 'GET, POST', ''], `${method} ${path}`);
      }
    }
    // No start route: a POST there is an unknown path (GET only), and nothing is dispatched.
    const noStart = await act(base, 'api/jobs/app/T-5/start', {});
    assert.deepEqual([noStart.status, noStart.headers.allow], [405, 'GET']);
    for (const path of ['api/workspaces/app/remove']) {
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
    for (const path of [`/d/${wrong}/api/workspaces`, `/d/${wrong}/api/tickets`, '/api/workspaces', `/d/${wrong}/api/jobs/app/T-5/start`]) {
      const reply = await fetchRaw(`${origin}${path}`, { method: 'POST', headers, body: '{}' });
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
    }
    assert.deepEqual(setup.calls, []);
    assert.deepEqual(fake.calls, []);
  }, reviewers, setup);
});

test('dashboard setup: the action checks apply to the setup POSTs; exact arguments, results and error mapping; the pages refresh', async () => {
  const fake = fakeActions({ branch: 'T-5-ticket-t-5', state: 'working', check_after_minutes: 15 });
  const setup = fakeSetup([workspaceRow('app')], [ticketRow('app', 'T-5')]);
  const reviewers = fakeReviewers();
  await withDashboard('dash-setup-posts', fake, async (dashboard) => {
    const base = dashboard.url;
    const port = Number(base.port);
    // Origin, content type, body bounds and JSON: as for the job actions.
    for (const path of ['api/workspaces', 'api/tickets', 'api/workspaces/app/remove']) {
      assert.deepEqual(error(await act(base, path, {}, { headers: { origin: `http://localhost:${port}` } })), { status: 403, code: 'invalid_origin' }, path);
      assert.deepEqual(error(await act(base, path, {}, { headers: { origin: '' } })), { status: 403, code: 'invalid_origin' }, path);
      assert.deepEqual(error(await act(base, path, {}, { headers: { 'content-type': 'text/plain' } })), { status: 415, code: 'unsupported_media_type' }, path);
      assert.deepEqual(error(await act(base, path, undefined, { body: '{' })), { status: 400, code: 'invalid_json' }, path);
      assert.deepEqual(error(await act(base, path, undefined, { body: 'x'.repeat(MAX_ACTION_BODY_BYTES + 1) })), { status: 413, code: 'body_too_large' }, path);
    }
    const bad: Array<[string, string]> = [
      ['api/workspaces', '{}'], ['api/workspaces', '{"name":"app"}'], ['api/workspaces', '{"name":"app","path":1}'], ['api/workspaces', '{"name":"app","path":"/x","work":"/y"}'], ['api/workspaces', '[]'], ['api/workspaces', 'null'],
      ['api/tickets', '{}'], ['api/tickets', '{"workspace":"app","ticket":"T-1","title":"t"}'], ['api/tickets', '{"workspace":"app","ticket":"T-1","title":"t","request":null}'], ['api/tickets', '{"workspace":"app","ticket":"T-1","title":"t","request":"r","base":"main"}'],
      ['api/workspaces/app/remove', '{"force":true}'], ['api/workspaces/app/remove', '[]'],
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
    assert.deepEqual(result(await act(base, 'api/workspaces', { name: 'web', path: '/srv/web' })), { name: 'web', path: '/srv/web', liveJobs: 0, problem: null });
    assert.deepEqual(setup.calls.at(-1), ['addWorkspace', 'web', '/srv/web']);
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
  }, reviewers, setup);
});

let rpcId = 0;

async function subscribeRpc(url: URL, token: string, args: Record<string, unknown>, callback: string, secret: string): Promise<string> {
  rpcId += 1;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'events/subscribe', params: { name: 'software_factory.job', arguments: args, delivery: { mode: 'webhook', url: callback, secret }, cursor: null } }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const data = text.startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '{}');
  const message = JSON.parse(data) as { result?: { id: string }; error?: unknown };
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  return message.result!.id;
}

test('dashboard setup end to end: a workspace from the page, a ticket draft, the reviewer line over the stream, start creates the job', async () => {
  const as: FakeAs = await startFakeAs();
  const sink = await startWebhookSink();
  const env = await newEnv('dash-setup-e2e', { SF_AUTH_ISSUER: as.issuer, SF_AUTH_AUDIENCE: AUDIENCE, SF_EVENTS_ALLOW_LOOPBACK: 'on' });
  // The registry starts empty: the page registers the checkout.
  const repo = await newRepo(env, 'dash-setup-repo', true);
  await runCli(env, ['workspace', 'remove', 'app']);
  await script(env, [{ write: { 'README.md': 'hello world\n' }, text: '# Report: T-1, iteration 1\n\n## Done\nChanged.' }]);
  const served = await serve(env);
  // The tools need a token with OAuth on; the dashboard does not.
  const token = as.sign(as.claims());
  const client = new Client({ name: 'sf-025-setup', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(served.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const authed: Served = { ...served, client };
  try {
    const base = served.dashboard!;
    assert.deepEqual(JSON.parse((await fetchRaw(new URL('api/workspaces', base))).body), { workspaces: [] });
    const stream = await openStream(new URL('api/stream', base));
    assert.deepEqual((await stream.next('workspaces')).workspaces, []);
    assert.deepEqual((await stream.next('tickets')).tickets, []);

    // Add: the CLI's rules and texts, then the registry the CLI reads.
    const missing = await act(base, 'api/workspaces', { name: 'app', path: join(temp, 'nowhere') });
    assert.deepEqual(JSON.parse(missing.body), { ok: false, error: { code: 'workspace_invalid', message: 'The path does not exist.' } });
    assert.deepEqual(result(await act(base, 'api/workspaces', { name: 'app', path: repo })), { name: 'app', path: repo, liveJobs: 0, problem: null });
    assert.deepEqual((await stream.next('workspaces')).workspaces, [{ name: 'app', path: repo, liveJobs: 0, problem: null }]);
    assert.deepEqual((await loadRegistry(env.config)).workspaces, { app: { read_checkout: repo } });
    const listed = await runCli(env, ['workspace', 'list']);
    assert.match(listed.stdout, new RegExp(`^app\\n  checkout: ${repo}$`, 'm'));
    assert.deepEqual(error(await act(base, 'api/workspaces', { name: 'app', path: repo })), { status: 409, code: 'workspace_exists' });

    // A ticket skeleton: the exact file without the user's words, listed with Reviewer none; the
    // words are in the conversation's first message; a second ticket is refused.
    const words = 'Say hello world in the README.';
    const created = result(await act(base, 'api/tickets', { workspace: 'app', ticket: 'T-1', title: 'Change README', request: words }));
    assert.deepEqual(created, { workspace: 'app', ticket: 'T-1', path: '.software-factory/T-1.md', base: 'main' });
    assert.equal(await readFile(join(repo, '.software-factory', 'T-1.md'), 'utf8'), draftContent('T-1', 'Change README', 'main'));
    assert.doesNotMatch(await readFile(join(repo, '.software-factory', 'T-1.md'), 'utf8'), /hello world/);
    const tickets = (await stream.next('tickets', (data) => data.tickets.length === 1)).tickets;
    assert.deepEqual([tickets[0].ticket, tickets[0].draft, tickets[0].request, tickets[0].job, tickets[0].reviewer], ['T-1', true, words, null, { status: 'none' }]);
    assert.equal(tickets[0].conversation.url, conversationUrl(ticketConversation('app', 'T-1', words)));
    assert.match(tickets[0].conversation.message, /Here is what I want, in my words:\n\nSay hello world in the README\./);
    assert.deepEqual(error(await act(base, 'api/tickets', { workspace: 'app', ticket: 'T-1', title: 'Again', request: 'x' })), { status: 409, code: 'ticket_exists' });

    // ChatGPT subscribes to the ticket: the line turns to subscribed without a reload.
    const id = await subscribeRpc(served.url, token, { workspace: 'app', ticket: 'T-1' }, sink.url('/t1'), sink.secret);
    const subscribed = (await stream.next('tickets', (data) => data.tickets[0]?.reviewer.status === 'subscribed')).tickets[0];
    assert.deepEqual([subscribed.reviewer.id, subscribed.reviewer.input], [id, { workspace: 'app', ticket: 'T-1' }]);

    // The Context owner cannot start on the skeleton; it writes the Task file, then starts (on
    // the user's word, in the conversation). The ticket leaves the list, the workspace counts a
    // live job, and the checkout cannot be removed meanwhile.
    const draft = await refused(authed, 'start', { workspace: 'app', ticket: 'T-1' });
    assert.equal(draft.code, 'task_draft');
    assert.equal(await new JobStore(env.state).read('app', 'T-1'), undefined);
    await call(authed, 'write_task', { workspace: 'app', ticket: 'T-1', content: '---\nticket: T-1\ntitle: Change README\nbase: main\n---\n\n# T-1: Change README\n\nSay hello world in the README.\n' });
    const written = JSON.parse((await fetchRaw(new URL('api/tickets', base))).body).tickets[0];
    assert.deepEqual([written.ticket, written.draft], ['T-1', false]);
    const started = await call(authed, 'start', { workspace: 'app', ticket: 'T-1' });
    assert.deepEqual([started.branch, started.state, started.check_after_minutes], ['T-1-change-readme', 'working', 15]);
    assert.equal((await stream.next('tickets', (data) => data.tickets.length === 0)).tickets.length, 0);
    assert.equal((await stream.next('workspaces', (data) => data.workspaces[0]?.liveJobs === 1)).workspaces[0].name, 'app');
    assert.deepEqual(error(await act(base, 'api/workspaces/app/remove', {})), { status: 409, code: 'workspace_busy' });
    await waitFor(authed, 'T-1', 'awaiting_review', 1);
    const job = (await new JobStore(env.state).read('app', 'T-1'))!;
    assert.deepEqual([job.branch, job.base, job.iteration], ['T-1-change-readme', 'main', 1]);
    // The subscription received the event, so the conversation of the ticket reviews it.
    assert.deepEqual((await sink.waitFor('/t1', 2)).slice(1).map((request) => request.json.data.state), ['awaiting_review']);
    // Ended: the ticket is listed again with its last job, and the workspace can be removed.
    await call(authed, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    assert.equal((await runCli(env, ['abort', 'app', 'T-1'])).code, 0);
    const back = (await stream.next('tickets', (data) => data.tickets.length === 1)).tickets[0];
    assert.deepEqual([back.ticket, back.draft, back.job], ['T-1', false, 'aborted']);
    assert.deepEqual(result(await act(base, 'api/workspaces/app/remove', {})), { removed: 'app' });
    assert.deepEqual((await loadRegistry(env.config)).workspaces, {});
    stream.close();
  } finally {
    await client.close();
    await stop(served);
    await sink.close();
    await as.close();
  }
});
