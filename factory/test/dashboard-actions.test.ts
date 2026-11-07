// The Dashboard's actions (approve, abort, say, review, archive, the start of a ticket, and the run
// queue's changes of SF-071): the HTTP contract in process against
// startDashboard with a fake DashboardActions (methods per route, token, Origin, content type,
// body bounds, strict JSON, error mapping, a pending and a disconnected approve), then end to
// end through `sf serve`, where the same POSTs reach the real Execution and the fake Implementer.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { ACTIONS, CONFIRM_ROUTES, MAX_ACTION_BODY_BYTES, startDashboard } from '../src/dashboard.js';
import { FactoryError } from '../src/errors.js';
import { JobStore } from '../src/jobs.js';
import { factoryPrompt } from '../src/prompts.js';
import type { DashboardQueue } from '../src/dashboard.js';
import type { QueueView } from '../src/queue.js';
import { act, CSP, fakeActions, fakeSetup, fetchRaw, openStream, type Reply, ticketRow, workspaceRow } from './support/dashboard-client.js';
import { fixture, withDashboard } from './support/dashboard-state.js';
import { call, fakeLog, git, newEnv, newRepo, putTask, refused, script, serve, stop, waitFor } from './support/harness.js';


const error = (reply: Reply): { status: number; code: string } => ({ status: reply.status, code: JSON.parse(reply.body).error.code });

const result = (reply: Reply): Record<string, any> => {
  assert.equal(reply.status, 200, reply.body);
  const data = JSON.parse(reply.body);
  assert.equal(data.ok, true);
  return data.result;
};

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('dashboard actions: POST only on the action routes, GET only elsewhere, 404 for bad names and jobs; nothing is dispatched', async () => {
  const fake = fakeActions();
  await withDashboard('dash-act-routes', fake, async (dashboard) => {
    const base = dashboard.url;
    for (const action of ACTIONS) {
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']) {
        const reply = await act(base, `api/jobs/app/T-1/${action}`, {}, { method });
        assert.deepEqual([reply.status, reply.headers.allow, reply.body], [405, 'POST', ''], `${method} ${action}`);
        assert.equal(reply.headers['content-security-policy'], CSP);
      }
    }
    for (const path of ['', 'app.js', 'api/jobs', 'api/jobs/app/T-1', 'api/jobs/app/T-1/mr', 'api/jobs/app/T-1/iterations/1/report', 'api/stream', 'api/jobs/app/T-1/approve/x', 'api/jobs/app/T-1/other']) {
      const reply = await act(base, path, {});
      assert.deepEqual([reply.status, reply.headers.allow, reply.body], [405, 'GET', ''], path);
    }
    for (const path of ['api/jobs/App/T-1/approve', 'api/jobs/-app/T-1/say', 'api/jobs/app/.T-1/approve', 'api/jobs/app/T-9/approve', 'api/jobs/app/T-1%2Fx/approve']) {
      const reply = await act(base, path, { message: 'x' });
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
    }
    assert.deepEqual(fake.calls, []);
    // The query string is ignored; the path names the job.
    assert.equal((await act(base, 'api/jobs/app/T-1/say?x=1&job=app/T-9', { message: 'x' })).status, 200);
    assert.deepEqual(fake.calls, [['say', 'app', 'T-1', 'x']]);
    fake.calls.length = 0;
    const token = base.pathname.split('/')[2]!;
    const wrong = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    const origin = `http://127.0.0.1:${base.port}`;
    for (const path of [`/d/${wrong}/api/jobs/app/T-1/approve`, `/d/${token}api/jobs/app/T-1/approve`, `/x/${token}/api/jobs/app/T-1/approve`]) {
      const reply = await fetchRaw(`${origin}${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
    }
    assert.deepEqual(fake.calls, []);
  });
});

test('dashboard actions: the exact Origin, application/json, a bounded UTF-8 JSON body of the right shape; nothing else is dispatched', async () => {
  const fake = fakeActions();
  await withDashboard('dash-act-input', fake, async (dashboard) => {
    const base = dashboard.url;
    const port = Number(base.port);
    const path = 'api/jobs/app/T-1/say';
    const body = { message: 'hi' };
    const headers = (origin: string | undefined, type: string | undefined): Record<string, string> =>
      ({ ...(origin !== undefined ? { origin } : {}), ...(type !== undefined ? { 'content-type': type } : {}) });
    const raw = (options: Parameters<typeof fetchRaw>[1]): Promise<Reply> => fetchRaw(new URL(path, base), { method: 'POST', body: JSON.stringify(body), ...options });

    // Origin: the page's exact origin, port included.
    for (const origin of [undefined, '', `http://localhost:${port}`, `http://127.0.0.1:${port + 1}`, 'http://127.0.0.1', `http://[::1]:${port}`, `https://127.0.0.1:${port}`, `http://127.0.0.1:${port}/`, `HTTP://127.0.0.1:${port}`]) {
      const reply = await raw({ headers: headers(origin, 'application/json') });
      assert.deepEqual(error(reply), { status: 403, code: 'invalid_origin' }, String(origin));
      assert.equal(reply.headers['cache-control'], 'no-store');
    }
    // "null" and foreign origins fall to the SDK's validator first; the answer is a 403 either way.
    assert.equal((await raw({ headers: headers('null', 'application/json') })).status, 403);
    assert.equal((await raw({ headers: headers('http://attacker.example', 'application/json') })).status, 403);
    assert.equal((await raw({ headers: headers('http://127.0.0.1:8787', 'application/json') })).status, 403);
    assert.equal((await raw({ host: `localhost:${port}`, headers: headers(`http://localhost:${port}`, 'application/json') })).status, 403);

    // Content type.
    const origin = `http://127.0.0.1:${port}`;
    for (const type of [undefined, '', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/json; charset=utf-16', 'application/jsonx', 'application/json; boundary=x']) {
      assert.deepEqual(error(await raw({ headers: headers(origin, type) })), { status: 415, code: 'unsupported_media_type' }, String(type));
    }
    assert.deepEqual(fake.calls, []);
    for (const type of ['application/json', 'application/json; charset=utf-8', 'application/json;charset=UTF-8', 'Application/JSON; charset="utf-8"']) {
      assert.equal((await raw({ headers: headers(origin, type) })).status, 200, type);
    }
    assert.equal(fake.calls.length, 4);
    fake.calls.length = 0;

    // Body shape, per action.
    const bad: Array<[string, string]> = [
      ['say', '[]'], ['say', 'null'], ['say', '"hi"'], ['say', '1'], ['say', '{}'], ['say', '{"message":1}'], ['say', '{"message":null}'],
      ['say', '{"message":["x"]}'], ['say', '{"message":"x","extra":1}'], ['say', '{"message":"x","discard":true}'],
      ['abort', '{"discard":"yes"}'], ['abort', '{"discard":null}'], ['abort', '{"discard":1}'], ['abort', '{"discard":true,"force":true}'], ['abort', '[]'],
      ['approve', '{"x":1}'], ['approve', '[]'], ['approve', 'null'], ['approve', '{"discard":true}'], ['approve', '{"__proto__":{}}'],
    ];
    for (const [action, text] of bad) {
      const reply = await act(base, `api/jobs/app/T-1/${action}`, undefined, { body: text });
      assert.deepEqual(error(reply), { status: 400, code: 'invalid_body' }, `${action} ${text}`);
    }
    for (const text of ['', '{', '{"message":"x"', '{"message": "x"} x', "{'message':'x'}"]) {
      assert.deepEqual(error(await act(base, 'api/jobs/app/T-1/say', undefined, { body: text })), { status: 400, code: 'invalid_json' }, JSON.stringify(text));
    }
    // Malformed UTF-8 (a lone continuation byte inside the string) is refused, not replaced.
    const broken = Buffer.concat([Buffer.from('{"message":"a'), Buffer.from([0x80]), Buffer.from('b"}')]);
    assert.deepEqual(error(await act(base, 'api/jobs/app/T-1/say', undefined, { body: broken })), { status: 400, code: 'invalid_json' });
    assert.deepEqual(fake.calls, []);

    // Bounds: exactly the limit passes; one byte more is 413, by Content-Length and while streaming.
    const fill = (bytes: number): string => `{"message":"${'a'.repeat(bytes - '{"message":""}'.length)}"}`;
    const exact = fill(MAX_ACTION_BODY_BYTES);
    assert.equal(Buffer.byteLength(exact), MAX_ACTION_BODY_BYTES);
    assert.equal((await act(base, 'api/jobs/app/T-1/say', undefined, { body: exact })).status, 200);
    assert.equal((fake.calls[0]![3] as string).length, MAX_ACTION_BODY_BYTES - '{"message":""}'.length);
    fake.calls.length = 0;
    const over = fill(MAX_ACTION_BODY_BYTES + 1);
    assert.deepEqual(error(await act(base, 'api/jobs/app/T-1/say', undefined, { body: over })), { status: 413, code: 'body_too_large' });
    assert.deepEqual(error(await act(base, 'api/jobs/app/T-1/say', undefined, { body: over, chunk: 4096 })), { status: 413, code: 'body_too_large' });
    assert.equal((await act(base, 'api/jobs/app/T-1/say', undefined, { body: fill(4 * 1024 * 1024), chunk: 65536 })).status, 413);
    assert.equal((await act(base, 'api/jobs/app/T-1/say', undefined, { body: exact, chunk: 1000 })).status, 200);
    assert.equal(fake.calls.length, 1);
    fake.calls.length = 0;

    // An interrupted body: no call, no answer, and the next request works.
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`POST /d/${base.pathname.split('/')[2]}/${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"message":"par`);
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 150);
      });
      socket.once('error', reject);
    });
    await sleep(150);
    assert.deepEqual(fake.calls, []);
    assert.equal((await act(base, path, body)).status, 200);
    assert.deepEqual(fake.calls, [['say', 'app', 'T-1', 'hi']]);
  });
});

test('dashboard actions: exact arguments, results passed through unchanged, FactoryError codes mapped, failures sanitized', async () => {
  const fake = fakeActions();
  const errors = mock.method(console, 'error', () => undefined);
  try {
    await withDashboard('dash-act-dispatch', fake, async (dashboard) => {
      const base = dashboard.url;
      const outcome = { state: 'pushed', branch: 'T-1-demo', title: 'feat(T-1): Demo', link: 'https://example.invalid/compare/main...T-1-demo' };
      fake.answer = outcome;
      const approved = await act(base, 'api/jobs/app/T-1/approve', {});
      assert.equal(approved.status, 200);
      assert.equal(approved.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(approved.headers['content-security-policy'], CSP);
      assert.deepEqual(JSON.parse(approved.body), { ok: true, result: outcome });

      fake.answer = { state: 'aborted', branch: 'T-1-demo', discarded: false, error: { code: 'discard_failed', message: 'git branch -D failed.' } };
      for (const [body, discard] of [[{}, false], [{ discard: false }, false], [{ discard: true }, true]] as const) {
        const reply = await act(base, 'api/jobs/app/T-1/abort', body);
        assert.equal(reply.status, 200);
        // An abort that ended the job but failed to discard is a completed call: 200, the error inside.
        assert.deepEqual(JSON.parse(reply.body), { ok: true, result: fake.answer });
        assert.deepEqual(fake.calls.at(-1), ['abort', 'app', 'T-1', discard]);
      }

      fake.answer = { state: 'working', queued: true };
      const message = '  Keep  "quotes", \'apostrophes\' and\nnew\r\nlines — ünïcödé 🚀 \t ';
      const said = await act(base, 'api/jobs/app/T-1/say', { message });
      assert.deepEqual(JSON.parse(said.body), { ok: true, result: { state: 'working', queued: true } });
      assert.deepEqual(fake.calls.at(-1), ['say', 'app', 'T-1', message]);
      assert.equal(fake.calls.length, 5);

      const mapping: Array<[string, number]> = [
        ['invalid_state', 409], ['turn_running', 409], ['rebase_in_progress', 409], ['job_not_found', 404], ['workspace_not_found', 404], ['invalid_content', 400], ['fetch_failed', 500], ['base_not_found', 500],
      ];
      for (const [code, status] of mapping) {
        fake.answer = new FactoryError(code, `The ${code} message.`);
        const reply = await act(base, 'api/jobs/app/T-1/say', { message: 'x' });
        assert.equal(reply.status, status, code);
        assert.deepEqual(JSON.parse(reply.body), { ok: false, error: { code, message: `The ${code} message.` } });
      }
      assert.equal(errors.mock.callCount(), 0);
      fake.answer = new Error('boom at /home/user/secret');
      const failed = await act(base, 'api/jobs/app/T-1/approve', {});
      assert.equal(failed.status, 500);
      assert.deepEqual(JSON.parse(failed.body), { ok: false, error: { code: 'internal_error', message: 'The request failed inside the factory.' } });
      assert.equal(errors.mock.callCount(), 1);
      assert.equal(fake.calls.length, 5 + mapping.length + 1);
    });
  } finally {
    errors.mock.restore();
  }
});

test('dashboard actions: a pending approve leaves reads, the stream and abort responsive; a disconnected approve settles once, without a second call', async () => {
  const fake = fakeActions();
  const errors = mock.method(console, 'error', () => undefined);
  try {
    await withDashboard('dash-act-pending', fake, async (dashboard) => {
      const base = dashboard.url;
      let settle: ((outcome: unknown) => void) | undefined;
      let pending = 0;
      fake.approve = (workspace, ticket) => {
        fake.calls.push(['approve', workspace, ticket]);
        if (pending > 0) {
          return Promise.reject(new FactoryError('invalid_state', 'the job is preparing_mr.'));
        }
        pending += 1;
        return new Promise((resolve) => {
          settle = (outcome) => {
            pending -= 1;
            resolve(outcome as never);
          };
        });
      };
      const origin = `http://127.0.0.1:${base.port}`;
      const first = request(new URL('api/jobs/app/T-1/approve', base), { method: 'POST', headers: { origin, 'content-type': 'application/json', 'content-length': '2' } });
      first.on('error', () => undefined);
      first.end('{}');
      await until(() => fake.calls.length === 1);

      // While it waits: reads, the stream, a refused second approve and abort all answer.
      assert.equal((await fetchRaw(new URL('api/jobs', base))).status, 200);
      const stream = await openStream(new URL('api/stream?job=app/T-1', base));
      assert.equal((await stream.next('jobs')).jobs.length, 2);
      assert.deepEqual(error(await act(base, 'api/jobs/app/T-1/approve', {})), { status: 409, code: 'invalid_state' });
      fake.answer = { state: 'aborted', branch: 'T-1-demo', discarded: false };
      assert.equal((await act(base, 'api/jobs/app/T-1/abort', {})).status, 200);
      assert.equal(fake.calls.length, 3);

      // The page goes away: the call goes on and settles without a second attempt or an error.
      first.destroy();
      await sleep(100);
      settle!({ state: 'pushed', branch: 'T-1-demo', title: 'feat(T-1): Demo' });
      await sleep(100);
      assert.equal(pending, 0);
      assert.equal(fake.calls.filter((entry) => entry[0] === 'approve').length, 2);
      assert.equal(errors.mock.callCount(), 0);
      assert.equal((await fetchRaw(new URL('api/jobs/app/T-1', base))).status, 200);

      // A pending approve answered normally, with the outcome as it is.
      const done = act(base, 'api/jobs/app/T-1/approve', {});
      await until(() => pending === 1);
      settle!({ state: 'needs_human', branch: 'T-1-demo', error: { code: 'mr_dirty', message: 'dirty' } });
      assert.deepEqual(JSON.parse((await done).body), { ok: true, result: { state: 'needs_human', branch: 'T-1-demo', error: { code: 'mr_dirty', message: 'dirty' } } });
      stream.close();
    });
  } finally {
    errors.mock.restore();
  }
});

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'Changes files.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change',
    'Readers need it.', '## Special things to note', '- None.', '## Change outline', '- files', '## Testing', 'npm test: passed',
    '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

test('dashboard actions end to end: say resumes needs_human, approve is refused until Clean prepared the branch, the push from the page, terminal refusals', async () => {
  const env = await newEnv('dash-needs', { SF_MAX_ITERATIONS: '1' });
  const repo = await newRepo(env, 'dash-needs-repo', true);
  await putTask(env, repo, 'N-1', 'Needs human');
  await script(env, [
    { write: { 'a.txt': 'a\n' }, text: 'iteration 1' },
    { text: 'fixed' },
    { write: { 'a.txt': 'aa\n' }, text: 'resumed' },
    { startupFailure: 'sandbox: bubblewrap is not installed' },
    { write: { '.software-factory/N-1.mr.md': mrText('feat(N-1): Add a') }, text: 'prepared' },
  ]);
  const served = await serve(env);
  try {
    const base = served.dashboard!;
    await call(served, 'start', { workspace: 'app', ticket: 'N-1' });
    await waitFor(served, 'N-1', 'awaiting_review', 1);
    // SF_MAX_ITERATIONS=1: one Fix section, then iteration_limit.
    await call(served, 'request_fix', { workspace: 'app', ticket: 'N-1', content: 'first' });
    await waitFor(served, 'N-1', 'awaiting_review', 2);
    assert.equal((await refused(served, 'request_fix', { workspace: 'app', ticket: 'N-1', content: 'more' })).code, 'iteration_limit');
    assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'N-1' })).state, 'needs_human');

    // needs_human without a prepared branch: approve is refused, say resumes the session.
    const early = await act(base, 'api/jobs/app/N-1/approve', {});
    assert.equal(early.status, 409);
    assert.match(JSON.parse(early.body).error.message, /^approve needs ready_for_human_review \(the branch prepared at Clean\); the job is needs_human\.$/);
    assert.deepEqual(result(await act(base, 'api/jobs/app/N-1/say', { message: 'go on\nplease' })), { state: 'working', queued: false });
    await waitFor(served, 'N-1', 'awaiting_review', 3);
    for (const message of ['', '   \n\t ', 'a\u0000b']) {
      assert.deepEqual(error(await act(base, 'api/jobs/app/N-1/say', { message })), { status: 400, code: 'invalid_content' }, JSON.stringify(message));
    }
    assert.deepEqual(error(await act(base, 'api/jobs/app/N-1/approve', {})), { status: 409, code: 'invalid_state' });

    // Clean: the MR turn fails to start (needs_human with the turn's code), the retry prepares the branch.
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'N-1' });
    const failed = await waitFor(served, 'N-1', 'needs_human');
    assert.deepEqual(failed.error, { code: 'sandbox_unavailable', message: 'sandbox: bubblewrap is not installed' });
    assert.deepEqual(error(await act(base, 'api/jobs/app/N-1/approve', {})), { status: 409, code: 'invalid_state' });
    assert.equal((await new JobStore(env.state).read('app', 'N-1'))!.mr_attempts, 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'N-1' });
    await waitFor(served, 'N-1', 'ready_for_human_review', 3);
    const ready = JSON.parse((await fetchRaw(new URL('api/jobs/app/N-1', base))).body);
    // The worktree stays until the push (SF-073).
    assert.equal(ready.job.worktree, join(env.state, 'worktrees', 'app', 'N-1'));
    assert.match(ready.job.prepared_commit, /^[0-9a-f]{40}$/);
    // The push from the page; no link, because the origin is a local path.
    const pushed = result(await act(base, 'api/jobs/app/N-1/approve', {}));
    assert.deepEqual(pushed, { state: 'pushed', branch: 'N-1-needs-human', title: 'feat(N-1): Add a' });
    assert.equal((await fetchRaw(new URL('api/jobs/app/N-1/mr', base))).body, mrText('feat(N-1): Add a'));

    // pushed is terminal for every action.
    for (const [action, body] of [['approve', {}], ['abort', {}], ['abort', { discard: true }], ['say', { message: 'x' }]] as const) {
      assert.deepEqual(error(await act(base, `api/jobs/app/N-1/${action}`, body)), { status: 409, code: 'invalid_state' }, action);
    }
    const log = await fakeLog(env);
    assert.equal(log.length, 5);
    assert.equal(log[2]!.prompt, factoryPrompt('go on\nplease', 'N-1', 3));
  } finally {
    await stop(served);
  }
});

test('dashboard actions end to end: say queues during a turn, a hand-edited tip needs as_is, abort ends a preparation, discard and its refusals', async () => {
  const env = await newEnv('dash-pending');
  const repo = await newRepo(env, 'dash-pending-repo', true);
  for (const ticket of ['C-1', 'C-2', 'C-3', 'C-4']) {
    await putTask(env, repo, ticket, `Job ${ticket}`);
  }
  const message = 'Please  keep "quotes",\nnew lines — ünïcödé 🚀 ';
  await script(env, [
    // C-1: the say arrives while this turn runs and is queued as the next one.
    { delayMs: 2500, write: { 'a.txt': 'a\n' }, text: 'iteration 1' },
    { text: 'the said turn' },
    // Clean: the MR text; the factory commits.
    { write: { '.software-factory/C-1.mr.md': mrText('feat(C-1): Add a') }, text: 'prepared' },
    // C-2: a preparation that abort ends.
    { write: { 'c.txt': 'c\n' } },
    { delayMs: 6000, text: 'slow preparation' },
    // C-3 and C-4: discard.
    { write: { 'd.txt': 'd\n' } },
    { write: { 'e.txt': 'e\n' } },
  ]);
  const served = await serve(env);
  try {
    const base = served.dashboard!;
    const jobs = new JobStore(env.state);
    const worktree = (ticket: string): string => join(env.state, 'worktrees', 'app', ticket);
    await call(served, 'start', { workspace: 'app', ticket: 'C-1' });
    assert.deepEqual(result(await act(base, 'api/jobs/app/C-1/say', { message })), { state: 'working', queued: true });
    await waitFor(served, 'C-1', 'awaiting_review', 1);

    // Clean: the stream shows preparing_mr, then ready; approve and say are refused meanwhile.
    const stream = await openStream(new URL('api/stream?job=app/C-1', base));
    await stream.next('jobs');
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'C-1' });
    assert.equal((await stream.next('jobs', (data) => data.jobs[0].state === 'preparing_mr')).jobs.length, 1);
    assert.deepEqual(error(await act(base, 'api/jobs/app/C-1/approve', {})), { status: 409, code: 'invalid_state' });
    assert.deepEqual(error(await act(base, 'api/jobs/app/C-1/say', { message: 'x' })), { status: 409, code: 'invalid_state' });
    assert.equal((await stream.next('jobs', (data) => data.jobs[0].state === 'ready_for_human_review')).jobs[0].ticket, 'C-1');
    stream.close();
    const prepared = (await jobs.read('app', 'C-1'))!.prepared_commit!;
    assert.equal(git(repo, 'rev-parse', 'C-1-job-c-1').trim(), prepared);
    // The tip is edited by hand: refused, then pushed as it is.
    const tree = git(repo, 'rev-parse', 'C-1-job-c-1^{tree}').trim();
    const edited = git(repo, 'commit-tree', tree, '-p', prepared, '-m', 'feat(C-1): Add a').trim();
    git(repo, 'update-ref', 'refs/heads/C-1-job-c-1', edited);
    const changed = await act(base, 'api/jobs/app/C-1/approve', {});
    assert.deepEqual(error(changed), { status: 409, code: 'branch_changed' });
    assert.match(JSON.parse(changed.body).error.message, /Approve with --as-is/);
    assert.deepEqual(error(await act(base, 'api/jobs/app/C-1/approve', { as_is: false })), { status: 409, code: 'branch_changed' });
    assert.deepEqual(result(await act(base, 'api/jobs/app/C-1/approve', { as_is: true })), { state: 'pushed', branch: 'C-1-job-c-1', title: 'feat(C-1): Add a' });
    const pushed = (await jobs.read('app', 'C-1'))!;
    assert.deepEqual([pushed.state, pushed.mr_attempts, pushed.iteration, pushed.prepared_commit], ['pushed', 1, 1, edited]);
    assert.deepEqual(error(await act(base, 'api/jobs/app/C-1/abort', {})), { status: 409, code: 'invalid_state' });
    let log = await fakeLog(env);
    assert.equal(log.length, 3);
    assert.equal(log[1]!.prompt, factoryPrompt(message, 'C-1', 1));

    // C-2: abort while the MR preparation runs ends the job; the worktree stays.
    await call(served, 'start', { workspace: 'app', ticket: 'C-2' });
    await waitFor(served, 'C-2', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'C-2' });
    await waitFor(served, 'C-2', 'preparing_mr');
    assert.deepEqual(result(await act(base, 'api/jobs/app/C-2/abort', {})), { state: 'aborted', branch: 'C-2-job-c-2', discarded: false, worktree: worktree('C-2') });
    assert.deepEqual(error(await act(base, 'api/jobs/app/C-2/abort', {})), { status: 409, code: 'invalid_state' });
    assert.equal(git(worktree('C-2'), 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'C-2-job-c-2');
    assert.equal(await readFile(join(worktree('C-2'), 'c.txt'), 'utf8'), 'c\n');
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');

    // C-3: discard is refused during a rebase in the worktree, then removes the worktree and the branch.
    await call(served, 'start', { workspace: 'app', ticket: 'C-3' });
    await waitFor(served, 'C-3', 'awaiting_review', 1);
    const gitDir = resolve(worktree('C-3'), git(worktree('C-3'), 'rev-parse', '--git-dir').trim());
    await mkdir(join(gitDir, 'rebase-merge'));
    assert.deepEqual(error(await act(base, 'api/jobs/app/C-3/abort', { discard: true })), { status: 409, code: 'rebase_in_progress' });
    assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'C-3' })).state, 'awaiting_review');
    await rm(join(gitDir, 'rebase-merge'), { recursive: true });
    assert.deepEqual(result(await act(base, 'api/jobs/app/C-3/abort', { discard: true })), { state: 'aborted', branch: 'C-3-job-c-3', discarded: true, worktree: null });
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    assert.equal(git(repo, 'branch', '--list', 'C-3-job-c-3'), '');
    await assert.rejects(stat(worktree('C-3')), { code: 'ENOENT' });

    // C-4: the branch was renamed by hand, so the discard's last step fails: aborted, discard_failed.
    await call(served, 'start', { workspace: 'app', ticket: 'C-4' });
    await waitFor(served, 'C-4', 'awaiting_review', 1);
    git(repo, 'branch', '-m', 'C-4-job-c-4', 'C-4-renamed');
    const partial = result(await act(base, 'api/jobs/app/C-4/abort', { discard: true }));
    assert.deepEqual([partial.state, partial.branch, partial.discarded, partial.error.code], ['aborted', 'C-4-job-c-4', false, 'discard_failed']);
    assert.match(partial.error.message, /^git branch -D C-4-job-c-4 failed:/);
    assert.equal((await jobs.read('app', 'C-4'))!.error?.code, 'discard_failed');
    // Six, not seven: the aborted preparation of C-2 was ended before its delayed turn logged.
    log = await fakeLog(env);
    assert.equal(log.length, 6);
  } finally {
    await stop(served);
  }
});

test('dashboard ticket start (SF-040): POST only, the action checks, Execution.start once per request, its refusals mapped; test-event and nudge are gone', async () => {
  const fake = fakeActions({ branch: 'T-5-demo', state: 'starting', check_after_minutes: 15, worktree: '/w/app/T-5' });
  await withDashboard('dash-act-start', fake, async (dashboard) => {
    const base = dashboard.url;
    const path = 'api/tickets/app/T-5/start';
    for (const method of ['GET', 'HEAD', 'PUT']) {
      const reply = await act(base, path, {}, { method });
      assert.deepEqual([reply.status, reply.headers.allow, reply.body], [405, 'POST', ''], method);
    }
    assert.deepEqual(error(await act(base, path, { now: true })), { status: 400, code: 'invalid_body' });
    assert.deepEqual(error(await act(base, path, undefined, { body: 'null' })), { status: 400, code: 'invalid_body' });
    assert.equal((await act(base, path, {}, { headers: { origin: 'http://evil.example' } })).status, 403);
    for (const other of ['api/tickets/App/T-5/start', 'api/tickets/app/.T-5/start', 'api/tickets/app/T-5/start/x']) {
      assert.notEqual((await act(base, other, {})).status, 200, other);
    }
    assert.deepEqual(fake.calls, []);

    // No job is needed: the ticket's job does not exist yet.
    assert.deepEqual(result(await act(base, path, {})), { branch: 'T-5-demo', state: 'starting', check_after_minutes: 15, worktree: '/w/app/T-5' });
    assert.deepEqual(fake.calls, [['start', 'app', 'T-5']]);
    fake.answer = new FactoryError('task_draft', 'The Task file is still the skeleton.');
    assert.deepEqual(error(await act(base, path, {})), { status: 409, code: 'task_draft' });
    fake.answer = new FactoryError('job_exists', 'The job for app/T-5 is working.');
    assert.deepEqual(error(await act(base, path, {})), { status: 409, code: 'job_exists' });
    assert.equal(fake.calls.length, 3);

    // The reviewer routes of the MCP Events era answer like any unknown path.
    for (const gone of ['api/jobs/app/T-1/test-event', 'api/jobs/app/T-1/nudge']) {
      const reply = await act(base, gone, {});
      assert.deepEqual([reply.status, reply.headers.allow, reply.body], [405, 'GET', ''], gone);
    }
    assert.equal(fake.calls.length, 3);
  });
});

// A run queue that records each change and answers with answer (thrown when it is an Error).
function fakeQueue(view: QueueView): DashboardQueue & { calls: unknown[][]; answer: unknown } {
  const fake = {
    calls: [] as unknown[][],
    answer: undefined as unknown,
    view: async () => view,
    change: async (name: string, ...args: unknown[]): Promise<any> => {
      fake.calls.push([name, ...args]);
      if (fake.answer instanceof Error) {
        throw fake.answer;
      }
      return fake.answer ?? { done: name };
    },
    add: (workspace: string, ticket: string, at?: number) => fake.change('add', workspace, ticket, at),
    remove: (workspace: string, ticket: string) => fake.change('remove', workspace, ticket),
    move: (workspace: string, ticket: string, to: number) => fake.change('move', workspace, ticket, to),
    limit: (max: number) => fake.change('limit', max),
    hold: (reason?: string) => fake.change('hold', reason),
    release: () => fake.change('release'),
    rule: (rule: string) => fake.change('rule', rule),
    force: (workspace: string, ticket: string) => fake.change('force', workspace, ticket),
    withTicket: <T>(_workspace: string, _ticket: string, work: () => Promise<T>): Promise<T> => work(),
  };
  return fake;
}

test('dashboard queue (SF-071, SF-072, SF-086): the eight POST routes with strict bodies, one queue call each, its refusals mapped, the pages refreshed; the tickets payload carries the queue and the plan reason; none without a queue', async () => {
  const view: QueueView = {
    max_running: 2, running: 1, held: true, hold_reason: 'usage limit', on_limit: 'resume-then-queue', limit_hold: null, errors: [{ workspace: 'web', ticket: 'W-1', code: 'branch_exists', message: 'The branch exists.', at: '2026-11-05T10:00:00.000Z' }],
    entries: [
      { workspace: 'app', ticket: 'T-5', position: 1, queued_at: '2026-11-05T09:00:00.000Z', waits_for: [], force: false, plan_reason: 'plan not ready: 1 blocker, 0 major' },
      { workspace: 'app', ticket: 'T-6', position: 2, queued_at: '2026-11-05T09:01:00.000Z', waits_for: [], force: true, plan_reason: null },
    ], next: { workspace: 'app', ticket: 'T-6' },
  };
  const queue = fakeQueue(view);
  const setup = fakeSetup([workspaceRow('app'), workspaceRow('web')], [ticketRow('app', 'T-5', 'Five', false), ticketRow('app', 'T-6', 'Six', false), ticketRow('web', 'W-1', 'Web', false, 'failed')]);
  await withDashboard('dash-act-queue', fakeActions(), async (dashboard) => {
    const base = dashboard.url;
    // The tickets payload: the queue's state, each row's position and failed start.
    const payload = JSON.parse((await fetchRaw(new URL('api/tickets', base))).body);
    assert.deepEqual(payload.queue, { max_running: 2, running: 1, held: true, hold_reason: 'usage limit', next: { workspace: 'app', ticket: 'T-6' }, on_limit: 'resume-then-queue', limit_hold: null });
    assert.deepEqual(payload.tickets.map((row: Record<string, unknown>) => [row.ticket, row.queue_position, row.queue_error, row.queue_reason, row.queue_force]), [
      ['T-5', 1, null, 'plan not ready: 1 blocker, 0 major', false], ['T-6', 2, null, null, true], ['W-1', null, { code: 'branch_exists', message: 'The branch exists.' }, null, false],
    ]);
    // POST only; an unknown action is no route.
    for (const method of ['GET', 'PUT']) {
      const reply = await act(base, 'api/queue/add', {}, { method });
      assert.deepEqual([reply.status, reply.headers.allow, reply.body], [405, 'POST', ''], method);
    }
    assert.equal((await act(base, 'api/queue/clear', {})).status, 405);
    assert.equal((await act(base, 'api/queue/add/x', {})).status, 405);
    assert.equal((await act(base, 'api/queue/add', { workspace: 'app', ticket: 'T-5' }, { headers: { origin: 'http://evil.example' } })).status, 403);
    // Strict bodies.
    const bad: Array<[string, unknown]> = [
      ['add', {}], ['add', { workspace: 'app', ticket: 'T-5', at: 0 }], ['add', { workspace: 'app', ticket: 'T-5', at: 1.5 }], ['add', { workspace: 'app', ticket: 'T-5', extra: 1 }],
      ['remove', { workspace: 'app' }], ['move', { workspace: 'app', ticket: 'T-5' }], ['move', { workspace: 'app', ticket: 'T-5', to: '2' }],
      ['limit', {}], ['limit', { max_running: '3' }], ['hold', { reason: null }], ['hold', { reason: 1 }], ['release', { now: true }],
      ['force', { workspace: 'app' }], ['force', { workspace: 'app', ticket: 'T-5', force: true }],
    ];
    for (const [action, body] of bad) {
      assert.deepEqual(error(await act(base, `api/queue/${action}`, body)), { status: 400, code: 'invalid_body' }, `${action} ${JSON.stringify(body)}`);
    }
    assert.deepEqual(queue.calls, []);
    // One call each, the result as it comes; every page gets the tickets again.
    const stream = await openStream(new URL('api/stream', base));
    await stream.next('tickets');
    const good: Array<[string, unknown]> = [
      ['add', { workspace: 'app', ticket: 'T-6' }], ['add', { workspace: 'app', ticket: 'T-6', at: 2 }], ['remove', { workspace: 'app', ticket: 'T-5' }],
      ['move', { workspace: 'app', ticket: 'T-6', to: 1 }], ['limit', { max_running: 5 }], ['hold', {}], ['hold', { reason: 'later' }], ['release', {}],
      ['force', { workspace: 'app', ticket: 'T-5' }],
    ];
    for (const [action, body] of good) {
      assert.deepEqual(result(await act(base, `api/queue/${action}`, body)), { done: action });
      await stream.next('workspaces');
      await stream.next('tickets');
    }
    assert.deepEqual(queue.calls, [
      ['add', 'app', 'T-6', undefined], ['add', 'app', 'T-6', 2], ['remove', 'app', 'T-5'], ['move', 'app', 'T-6', 1], ['limit', 5], ['hold', undefined], ['hold', 'later'], ['release'],
      ['force', 'app', 'T-5'],
    ]);
    stream.close();
    // The queue's refusals.
    const refusals: Array<[string, number]> = [
      ['already_queued', 409], ['not_queued', 409], ['invalid_limit', 400], ['invalid_position', 400], ['task_not_found', 404], ['task_draft', 409], ['job_exists', 409],
    ];
    for (const [code, status] of refusals) {
      queue.answer = new FactoryError(code, `The ${code} message.`);
      const refused = await act(base, 'api/queue/limit', { max_running: 30 });
      assert.deepEqual([refused.status, JSON.parse(refused.body)], [status, { ok: false, error: { code, message: `The ${code} message.` } }], code);
    }
  }, setup, { queue });
  // Without a run queue the routes are not there.
  await withDashboard('dash-act-no-queue', fakeActions(), async (dashboard) => {
    assert.deepEqual([(await act(dashboard.url, 'api/queue/add', { workspace: 'app', ticket: 'T-5' })).status], [404]);
  });
});

test('dashboard review: POST only, the action checks, Execution.retryReview once per request, its refusals mapped', async () => {
  const fake = fakeActions({ state: 'awaiting_review', iteration: 2 });
  await withDashboard('dash-act-review', fake, async (dashboard) => {
    const base = dashboard.url;
    const path = 'api/jobs/app/T-1/review';
    for (const method of ['GET', 'PUT']) {
      const reply = await act(base, path, {}, { method });
      assert.deepEqual([reply.status, reply.headers.allow, reply.body], [405, 'POST', ''], method);
    }
    assert.deepEqual(error(await act(base, path, {}, { headers: { origin: '' } })), { status: 403, code: 'invalid_origin' });
    for (const body of ['{"iteration":1}', '[]', 'null']) {
      assert.deepEqual(error(await act(base, path, undefined, { body })), { status: 400, code: 'invalid_body' }, body);
    }
    assert.deepEqual([(await act(base, 'api/jobs/app/T-9/review', {})).status], [404]);
    assert.deepEqual(fake.calls, []);

    assert.deepEqual(result(await act(base, path, {})), { state: 'awaiting_review', iteration: 2 });
    assert.deepEqual(fake.calls, [['retryReview', 'app', 'T-1']]);
    for (const [code, status] of [['invalid_state', 409], ['review_off', 409], ['worktree_missing', 409]] as const) {
      fake.answer = new FactoryError(code, `The ${code} message.`);
      assert.deepEqual(error(await act(base, path, {})), { status, code }, code);
    }
    assert.equal(fake.calls.length, 4);
  });
});

test('dashboard retry (SF-087): POST only, the action checks, Execution.retryMr once per request, 200 with its result, 409 on its refusals', async () => {
  const fake = fakeActions({ state: 'preparing_mr', iteration: 1, branch: 'T-1-demo' });
  await withDashboard('dash-act-retry', fake, async (dashboard) => {
    const base = dashboard.url;
    const path = 'api/jobs/app/T-1/retry';
    for (const method of ['GET', 'PUT']) {
      const reply = await act(base, path, {}, { method });
      assert.deepEqual([reply.status, reply.headers.allow, reply.body], [405, 'POST', ''], method);
    }
    assert.deepEqual(error(await act(base, path, {}, { headers: { origin: '' } })), { status: 403, code: 'invalid_origin' });
    for (const body of ['{"sensitive":[]}', '[]', 'null']) {
      assert.deepEqual(error(await act(base, path, undefined, { body })), { status: 400, code: 'invalid_body' }, body);
    }
    assert.deepEqual([(await act(base, 'api/jobs/app/T-9/retry', {})).status], [404]);
    assert.deepEqual(fake.calls, []);

    const reply = await act(base, path, {});
    assert.equal(reply.status, 200);
    assert.deepEqual(result(reply), { state: 'preparing_mr', iteration: 1, branch: 'T-1-demo' });
    assert.deepEqual(fake.calls, [['retryMr', 'app', 'T-1']]);
    fake.answer = new FactoryError('invalid_state', 'The MR preparation ran a conflict turn whose changes no reviewer saw; tell the Implementer to go on (the iteration is reviewed again).');
    assert.deepEqual(error(await act(base, path, {})), { status: 409, code: 'invalid_state' });
    assert.equal(fake.calls.length, 2);
  });
});

test('dashboard confirm (SF-126): on the remote port approve, retry, mr-create and mr-merge need "confirm" equal to the ticket, else 409 confirm_required and nothing runs; locally they run without it', async () => {
  const remoteOrigin = 'https://pc.tail1234.ts.net';
  const store = await fixture('dash-act-confirm');
  const fake = fakeActions();
  const dashboard = await startDashboard(0, store.state, store.jobs, fake, undefined, { remoteOrigins: [remoteOrigin], remoteLogins: ['alice@github'], remotePort: 0 });
  try {
    const token = dashboard.url.pathname.split('/')[2]!;
    const remote = new URL(`http://127.0.0.1:${dashboard.remotePort}/d/${token}/`);
    const headers = { origin: remoteOrigin, 'tailscale-user-login': 'alice@github' };
    const remoteAct = (action: string, body: unknown): Promise<Reply> => act(remote, `api/jobs/app/T-1/${action}`, body, { host: 'pc.tail1234.ts.net', headers });
    const methods: Record<string, string> = { approve: 'approve', retry: 'retryMr', 'mr-create': 'createMergeRequest', 'mr-merge': 'mergeMergeRequest' };
    assert.deepEqual(CONFIRM_ROUTES, Object.keys(methods));
    for (const [action, method] of Object.entries(methods)) {
      // Without confirm, with another ticket, another case or a non-string: refused before anything runs.
      for (const body of [{}, { confirm: 'T-0' }, { confirm: 't-1' }, { confirm: '' }, { confirm: 'app/T-1' }]) {
        const reply = await remoteAct(action, body);
        assert.deepEqual(error(reply), { status: 409, code: 'confirm_required' }, `${action} ${JSON.stringify(body)}`);
        assert.equal(JSON.parse(reply.body).error.message, `From another device, ${action} needs "confirm": the job's ticket (T-1).`);
      }
      assert.deepEqual(error(await remoteAct(action, { confirm: 1 })), { status: 400, code: 'invalid_body' }, action);
      assert.deepEqual(fake.calls, [], action);
      // With the ticket: it runs, once.
      assert.equal((await remoteAct(action, { confirm: 'T-1' })).status, 200, action);
      assert.deepEqual(fake.calls, [[method, 'app', 'T-1']], action);
      fake.calls.length = 0;
      // Locally: no confirm needed, and one sent is ignored.
      for (const body of [{}, { confirm: 'T-0' }]) {
        assert.equal((await act(dashboard.url, `api/jobs/app/T-1/${action}`, body)).status, 200, `${action} local ${JSON.stringify(body)}`);
      }
      assert.deepEqual(fake.calls, [[method, 'app', 'T-1'], [method, 'app', 'T-1']], action);
      fake.calls.length = 0;
    }
    // approve keeps as_is beside confirm.
    assert.equal((await remoteAct('approve', { as_is: true, confirm: 'T-1' })).status, 200);
    // The other actions need no confirm on the remote port (none of them pushes or merges).
    for (const [action, method] of [['abort', 'abort'], ['mr-status', 'mergeRequestStatus'], ['accept', 'acceptGate'], ['handover', 'handover'], ['pause', 'pause']] as const) {
      fake.calls.length = 0;
      assert.equal((await remoteAct(action, {})).status, 200, action);
      assert.equal(fake.calls[0]![0], method, action);
    }
    assert.deepEqual(error(await remoteAct('mr-status', { confirm: 'T-1' })), { status: 400, code: 'invalid_body' });
  } finally {
    await dashboard.close();
  }
});

test('dashboard accept (SF-047): POST only, the action checks, Execution.acceptGate once per request, its refusals mapped', async () => {
  const fake = fakeActions({ state: 'preparing_mr', iteration: 3, branch: 'T-1-demo' });
  await withDashboard('dash-act-accept', fake, async (dashboard) => {
    const base = dashboard.url;
    const path = 'api/jobs/app/T-1/accept';
    for (const method of ['GET', 'PUT']) {
      const reply = await act(base, path, {}, { method });
      assert.deepEqual([reply.status, reply.headers.allow, reply.body], [405, 'POST', ''], method);
    }
    assert.deepEqual(error(await act(base, path, {}, { headers: { origin: '' } })), { status: 403, code: 'invalid_origin' });
    for (const body of ['{"items":[]}', '[]', 'null']) {
      assert.deepEqual(error(await act(base, path, undefined, { body })), { status: 400, code: 'invalid_body' }, body);
    }
    assert.deepEqual([(await act(base, 'api/jobs/app/T-9/accept', {})).status], [404]);
    assert.deepEqual(fake.calls, []);

    assert.deepEqual(result(await act(base, path, {})), { state: 'preparing_mr', iteration: 3, branch: 'T-1-demo' });
    assert.deepEqual(fake.calls, [['acceptGate', 'app', 'T-1']]);
    for (const [code, status] of [['invalid_state', 409], ['sensitive_unacknowledged', 409], ['worktree_missing', 409], ['turn_running', 409]] as const) {
      fake.answer = new FactoryError(code, `The ${code} message.`);
      assert.deepEqual(error(await act(base, path, {})), { status, code }, code);
    }
    assert.equal(fake.calls.length, 5);
  });
});

test('dashboard settle (SF-052): POST {id, decision, note?} only, strictly parsed; Execution.settle once per request, its refusals mapped', async () => {
  const fake = fakeActions({ state: 'awaiting_review', id: 'R1', status: 'accepted_risk', waiting: [] });
  await withDashboard('dash-act-settle', fake, async (dashboard) => {
    const base = dashboard.url;
    const path = 'api/jobs/app/T-1/settle';
    assert.deepEqual([(await act(base, path, {}, { method: 'GET' })).status], [405]);
    for (const body of ['{}', '{"id":"R1"}', '{"id":"R1","decision":"maybe"}', '{"id":"R1","decision":"fix","note":3}', '{"id":"R1","decision":"fix","extra":1}', 'null']) {
      assert.deepEqual(error(await act(base, path, undefined, { body })), { status: 400, code: 'invalid_body' }, body);
    }
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(result(await act(base, path, { id: 'R1', decision: 'accept' })), { state: 'awaiting_review', id: 'R1', status: 'accepted_risk', waiting: [] });
    assert.deepEqual(result(await act(base, path, { id: 'R2', decision: 'fix', note: 'Handle null.' })), { state: 'awaiting_review', id: 'R1', status: 'accepted_risk', waiting: [] });
    assert.deepEqual(fake.calls, [['settle', 'app', 'T-1', 'R1', 'accept', ''], ['settle', 'app', 'T-1', 'R2', 'fix', 'Handle null.']]);
    fake.answer = new FactoryError('invalid_state', 'R1 is fixed; only an escalated or contested entry is settled.');
    assert.deepEqual(error(await act(base, path, { id: 'R1', decision: 'accept' })), { status: 409, code: 'invalid_state' });
  });
});

test('dashboard simplify (SF-055): POST {} only; Execution.simplify once per request, its refusals mapped', async () => {
  const fake = fakeActions({ state: 'working', iteration: 3, check_after_minutes: 5 });
  await withDashboard('dash-act-simplify', fake, async (dashboard) => {
    const base = dashboard.url;
    const path = 'api/jobs/app/T-1/simplify';
    assert.deepEqual([(await act(base, path, {}, { method: 'GET' })).status], [405]);
    for (const body of ['{"all":true}', 'null', '[]']) {
      assert.deepEqual(error(await act(base, path, undefined, { body })), { status: 400, code: 'invalid_body' }, body);
    }
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(result(await act(base, path, {})), { state: 'working', iteration: 3, check_after_minutes: 5 });
    assert.deepEqual(fake.calls, [['simplify', 'app', 'T-1']]);
    fake.answer = new FactoryError('invalid_state', 'sf simplify needs needs_human with simplify_offered; the job is working.');
    assert.deepEqual(error(await act(base, path, {})), { status: 409, code: 'invalid_state' });
  });
});

test('dashboard hand-over (SF-073): handover, takeback and handed-done POST {} only, one Execution call each, the new codes answered 409; a handed-over job\'s detail starts the push check', async () => {
  const fake = fakeActions({ state: 'handed_over', branch: 'T-1-demo' });
  await withDashboard('dash-act-handover', fake, async (dashboard, { jobs, job }) => {
    const base = dashboard.url;
    for (const [action, method] of [['handover', 'handover'], ['takeback', 'takeback'], ['handed-done', 'handedDone']] as const) {
      const path = `api/jobs/app/T-1/${action}`;
      assert.equal((await act(base, path, {}, { method: 'GET' })).status, 405);
      assert.deepEqual(error(await act(base, path, undefined, { body: '{"x":1}' })), { status: 400, code: 'invalid_body' }, action);
      fake.calls.length = 0;
      fake.answer = { state: 'handed_over', branch: 'T-1-demo' };
      assert.deepEqual(result(await act(base, path, {})), { state: 'handed_over', branch: 'T-1-demo' });
      assert.deepEqual(fake.calls, [[method, 'app', 'T-1']]);
    }
    for (const code of ['checkout_dirty', 'checkout_busy', 'handover_refused', 'handover_mismatch', 'checkout_changing', 'checkout_moved', 'takeback_changed', 'takeback_switch_failed', 'branch_in_checkout', 'not_pushed', 'handed_over', 'handover_interrupted', 'ask_interrupted']) {
      fake.answer = new FactoryError(code, `refused: ${code}`);
      assert.deepEqual(error(await act(base, 'api/jobs/app/T-1/takeback', {})), { status: 409, code }, code);
    }
    // The detail of a job that is not handed over asks nothing; a handed-over one starts the check
    // (at most once a minute, the Execution decides) and answers without waiting for it.
    fake.calls.length = 0;
    await fetchRaw(new URL('api/jobs/app/T-1', base));
    assert.deepEqual(fake.calls, []);
    const commit = 'a'.repeat(40);
    await jobs.write({
      ...job, state: 'handed_over', prepared_commit: commit, base_commit: 'b'.repeat(40),
      handover: { branch: 'T-1-demo', saved: commit, base: 'b'.repeat(40), previous: { branch: 'main' }, untracked: [], template: null, cleanup: null, at: '2026-11-01T10:06:00.000Z', checked_at: null, step: null },
    });
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body);
    assert.deepEqual([detail.job.state, detail.job.handover.branch, detail.job.handoff_skipped], ['handed_over', 'T-1-demo', null]);
    assert.deepEqual(fake.calls, [['checkHandedOver', 'app', 'T-1', 60_000]]);
  });
});
