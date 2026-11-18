// The HTTP helpers of the two listeners (SF-139, src/http.ts): the constant-time compare, the
// loopback listen and its port_in_use, the JSON answer, the internal_error answer and the
// dashboard's status of a FactoryError's code.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { ERROR_STATUS, internalError, listen, LOOPBACK_HOST, sameSecret, sendJson, statusOf } from '../src/http.js';
import { UPDATE_IN_PROGRESS } from '../src/update.js';

test('sameSecret is true only for equal inputs, whatever their lengths', () => {
  for (const text of ['', 'a', 'b'.repeat(64), 'c'.repeat(1000), 'ünïcödé 🚀']) {
    assert.equal(sameSecret(text, text), true, JSON.stringify(text));
    assert.equal(sameSecret(text, `${text}x`), false, JSON.stringify(text));
    assert.equal(sameSecret(`${text}x`, text), false, JSON.stringify(text));
  }
  assert.equal(sameSecret('a'.repeat(64), `${'a'.repeat(63)}b`), false);
  assert.equal(sameSecret('short', 'a'.repeat(64)), false);
  assert.equal(sameSecret('A', 'a'), false);
});

test('listen binds 127.0.0.1; a taken port is port_in_use naming the setting, and the error leaves the server unbound', async () => {
  const first = createServer();
  const address = await listen(first, 0, 'SF_PORT');
  try {
    assert.equal(address.address, LOOPBACK_HOST);
    for (const setting of ['SF_PORT', 'SF_DASHBOARD_PORT', 'SF_DASHBOARD_REMOTE_PORT']) {
      const second = createServer();
      await assert.rejects(listen(second, address.port, setting), (error: unknown) => {
        assert.ok(error instanceof FactoryError);
        assert.equal(error.code, 'port_in_use');
        assert.equal(error.message, `Port ${address.port} on 127.0.0.1 is already in use. Set ${setting} to a free port.`);
        return true;
      });
      assert.equal(second.listening, false);
    }
  } finally {
    await new Promise<void>((resolve) => first.close(() => resolve()));
  }
});

test('sendJson: the status, the JSON body, application/json; charset=utf-8 unless the headers give another type', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/plain') {
      sendJson(res, 404, { error: 'not found' }, { 'content-type': 'application/json' });
    } else {
      sendJson(res, 413, { ok: false, error: { code: 'body_too_large', message: 'x' } }, { connection: 'close' });
    }
  });
  const { port } = await listen(server, 0, 'SF_PORT');
  const get = (path: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> => new Promise((resolve, reject) => {
    request({ host: LOOPBACK_HOST, port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (chunk: string) => {
        body += chunk;
      }).on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on('error', reject).end();
  });
  try {
    const large = await get('/large');
    assert.deepEqual([large.status, large.headers['content-type'], large.headers.connection, large.body],
      [413, 'application/json; charset=utf-8', 'close', '{"ok":false,"error":{"code":"body_too_large","message":"x"}}']);
    const plain = await get('/plain');
    assert.deepEqual([plain.status, plain.headers['content-type'], plain.body], [404, 'application/json', '{"error":"not found"}']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('internalError: internal_error with the factory\'s words, or the caller\'s', () => {
  assert.deepEqual(internalError(), { code: 'internal_error', message: 'The request failed inside the factory.' });
  assert.deepEqual(internalError('The request failed inside the runner.'), { code: 'internal_error', message: 'The request failed inside the runner.' });
});

test('statusOf maps each code as the dashboard did before SF-139; any other code is the fallback (500, the update gate 409)', () => {
  const before: Record<string, number> = {
    update_in_progress: 409,
    invalid_state: 409, turn_running: 409, rebase_in_progress: 409, review_off: 409, runner_active: 409,
    job_exists: 409, job_active: 409, job_limit: 409, task_draft: 409, checkout_dirty: 409, branch_exists: 409, branch_changed: 409, branch_missing: 409, worktree_exists: 409,
    worktree_missing: 409, sensitive_unacknowledged: 409, ticket_exists: 409, workspace_exists: 409, workspace_busy: 409,
    job_not_found: 404, workspace_not_found: 404, task_not_found: 404,
    task_changed: 409, check_running: 409, restart_refused: 409,
    checkout_busy: 409, handover_refused: 409, handover_mismatch: 409, checkout_changing: 409, checkout_moved: 409,
    takeback_changed: 409, takeback_switch_failed: 409, branch_in_checkout: 409, not_pushed: 409, handed_over: 409, handover_interrupted: 409, ask_interrupted: 409,
    invalid_content: 400, invalid_ticket: 400, invalid_name: 400, workspace_invalid: 400, unknown_role: 400, skill_not_installed: 400, invalid_request: 400,
    mr_not_mergeable: 409, mr_check_failed: 409, runner_stopping: 409, mr_not_open: 409, mr_token_missing: 409, mr_host_unsupported: 409, mr_host_changed: 409, mr_text_missing: 409,
    mr_auth_failed: 502, mr_host_error: 502, mr_host_unreachable: 502,
    mr_text_invalid: 400, branch_locked: 409, base_unrelated: 409,
    push_check_failed: 502,
    digest_running: 409, invalid_digest_settings: 400,
    builds_on_not_ready: 409, builds_on_not_merged: 409, builds_on_not_moved: 409,
    already_queued: 409, not_queued: 409, invalid_limit: 400, invalid_position: 400, invalid_rule: 400,
    attachment_type: 400, attachment_too_large: 413, attachment_limit: 409, attachment_missing: 400, attachment_invalid: 409,
    // SF-208: the planner's suggestion and the planning chat link.
    no_suggestion: 409, suggestion_changed: 409, invalid_chat_link: 400,
    // SF-211: the dashboard's pins.
    pin_not_found: 404, too_many_pins: 409, pins_unreadable: 409, pin_holds_token: 400,
    // The ticket's planner session: a start under way and the planning copy's refusals.
    planner_starting: 409, planning_copy_missing: 409, planning_copy_unsafe: 409, planning_copy_untrusted: 409,
  };
  assert.deepEqual({ ...ERROR_STATUS }, before);
  for (const [code, status] of Object.entries(before)) {
    assert.equal(statusOf(code), status, code);
    assert.equal(statusOf(code, 409), status, code);
  }
  // The update gate's code is update.ts's.
  assert.equal(statusOf(UPDATE_IN_PROGRESS), 409);
  for (const code of ['fetch_failed', 'base_not_found', 'runner_failed', 'internal_error', 'toString', 'constructor', '__proto__']) {
    assert.equal(statusOf(code), 500, code);
    assert.equal(statusOf(code, 409), 409, code);
  }
});
