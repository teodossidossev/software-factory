// Errors of the SF-006 execution adapter. Messages name app and job ids and
// repository-relative paths only, never the configured application path.
export type ExecutionErrorCode =
  | 'not_accepted'
  | 'instruction_mismatch'
  | 'openclaw_unconfirmed'
  | 'openclaw_unavailable'
  | 'repo_dirty'
  | 'unsupported_conversions'
  | 'repo_changed'
  // Self-hosting: the baseline of the existing uncommitted work is too large, or not the recorded one.
  | 'baseline_too_large'
  | 'baseline_invalid'
  | 'unsafe_destination'
  | 'destination_conflict'
  | 'wrong_state'
  | 'locked'
  | 'still_running'
  | 'runner_unavailable'
  | 'transcript_missing'
  | 'session_not_finished'
  | 'git_failed'
  | 'approval_mismatch'
  | 'session_busy'
  | 'launch_unconfirmed'
  | 'gate_unresponsive'
  | 'session_ended'
  | 'io_failed';

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
  }
}
