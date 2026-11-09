// The HTTP helpers of the factory's two listeners: the MCP endpoint (src/server.ts) and the
// dashboard (src/dashboard.ts). The loopback listen with its port_in_use, a JSON answer, the
// constant-time compare of a secret, the internal_error answer of a failure that is not a
// FactoryError, and the dashboard's HTTP status of a FactoryError's code.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FactoryError } from './errors.js';

export const LOOPBACK_HOST = '127.0.0.1';

// A listener on 127.0.0.1:port; a taken port is port_in_use naming the setting that chose it.
export function listen(server: Server, port: number, setting: string): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(error.code === 'EADDRINUSE'
        ? new FactoryError('port_in_use', `Port ${port} on ${LOOPBACK_HOST} is already in use. Set ${setting} to a free port.`)
        : error);
    };
    server.once('error', onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off('error', onError);
      resolve(server.address() as AddressInfo);
    });
  });
}

// A JSON answer: application/json; charset=utf-8 unless headers give another content-type.
export function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(value));
}

// Two secrets compared in constant time: the SHA-256 of each, so not even their lengths leak.
export function sameSecret(given: string, expected: string): boolean {
  const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
  return timingSafeEqual(digest(given), digest(expected));
}

// The answer to a failure that is not a FactoryError (logged by the caller): its details stay in
// the log.
export function internalError(message = 'The request failed inside the factory.'): { code: 'internal_error'; message: string } {
  return { code: 'internal_error', message };
}

// The dashboard's HTTP status of a FactoryError the methods can throw; any other code answers
// statusOf's fallback (500) and keeps its code and message.
export const ERROR_STATUS: Readonly<Record<string, number>> = {
  // sf update is draining or building: update.ts's UPDATE_IN_PROGRESS, written out so this
  // module imports nothing of the factory but its errors (runner.ts imports it, and update.ts runner.ts).
  update_in_progress: 409,
  invalid_state: 409, turn_running: 409, rebase_in_progress: 409, review_off: 409, runner_active: 409,
  job_exists: 409, job_active: 409, job_limit: 409, task_draft: 409, checkout_dirty: 409, branch_exists: 409, branch_changed: 409, branch_missing: 409, worktree_exists: 409,
  worktree_missing: 409, sensitive_unacknowledged: 409, ticket_exists: 409, workspace_exists: 409, workspace_busy: 409,
  job_not_found: 404, workspace_not_found: 404, task_not_found: 404,
  // Save of the planned ticket page: the Task file is another version than the one read.
  // Not the job view's task_changed field.
  task_changed: 409,
  // The Task check: one at a time per ticket.
  check_running: 409,
  // A Restart that would delete a branch with commits or a pushed one.
  restart_refused: 409,
  // The hand-over to the user's checkout and its way back.
  checkout_busy: 409, handover_refused: 409, handover_mismatch: 409, checkout_changing: 409, checkout_moved: 409,
  takeback_changed: 409, takeback_switch_failed: 409, branch_in_checkout: 409, not_pushed: 409, handed_over: 409, handover_interrupted: 409, ask_interrupted: 409,
  invalid_content: 400, invalid_ticket: 400, invalid_name: 400, workspace_invalid: 400,
  // The merge request: the host's refusals and the actions being off are conflicts; a host
  // that failed or refused the token is a bad gateway.
  // mr_check_failed: the merge check refused the change on the base as it is now;
  // runner_stopping: the check was cancelled (stop, sf reset), or nothing new starts while stopping.
  mr_not_mergeable: 409, mr_check_failed: 409, runner_stopping: 409, mr_not_open: 409, mr_token_missing: 409, mr_host_unsupported: 409, mr_host_changed: 409, mr_text_missing: 409,
  mr_auth_failed: 502, mr_host_error: 502, mr_host_unreachable: 502,
  // The Merge request screen: a text that breaks the rules (also approve's, while the MR
  // text is invalid or not the prepared commit's message), a rename or a base change refused.
  mr_text_invalid: 400, branch_locked: 409, base_unrelated: 409,
  // origin did not say where a handed-over branch is.
  push_check_failed: 502,
  // The morning digest: one run at a time; its settings.
  digest_running: 409, invalid_digest_settings: 400,
  // The run queue.
  already_queued: 409, not_queued: 409, invalid_limit: 400, invalid_position: 400, invalid_rule: 400,
  // A ticket's images: not an image, too large, too many, and a Task file that refers to
  // one the ticket does not have (also an image to remove that is not there); a Start, Restart or
  // Resume whose Task file refers to images that cannot be used.
  attachment_type: 400, attachment_too_large: 413, attachment_limit: 409, attachment_missing: 400, attachment_invalid: 409,
};

// The HTTP status of a FactoryError's code: ERROR_STATUS's, else fallback.
export function statusOf(code: string, fallback = 500): number {
  return Object.hasOwn(ERROR_STATUS, code) ? ERROR_STATUS[code]! : fallback;
}
