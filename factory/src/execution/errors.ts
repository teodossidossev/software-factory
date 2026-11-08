// The stop codes and the refusals of the job lifecycle (SF-142, from src/execution/shared.ts): the
// codes sf accept and sf retry take on, and the errors more than one part throws.
import { FactoryError } from '../errors.js';
import { internalError } from '../http.js';
import type { Job } from '../jobs.js';
import { codesWith, storedCodesWithAction } from '../stops.js';

// The codes of a job the gate handed to the user, which sf accept may take on to MR preparation
// (src/stops.ts, the gate group).
export const GATE_OVERRIDE_CODES: readonly string[] = codesWith('gate');

// The ledger's stops (SF-052) that sf accept takes on as well, with a clean Claude review.
export const LEDGER_ACCEPT_CODES: readonly string[] = codesWith('ledger');

// The needs_human codes of a transient stop of MR preparation after the deciding clean verdict and
// before the branch is prepared (SF-087): sf retry runs MR preparation again, without a new review.
// Not after a conflict turn (mr_conflict_turn): its resolution is code no reviewer saw. Every code
// of a row with a Retry in src/stops.ts, aliases included: the guard's stops of MR preparation too
// (SF-122: after a "!" line in guard-terms.txt, for example), and a test command that could not
// run (SF-128). The order is the one sf retry has always named them in; a code it does not name
// goes last.
const RETRY_ORDER: readonly string[] = [
  'fetch_failed', 'mr_serve_restarted', 'mr_interrupted', 'mr_commit_failed', 'mr_rebase_failed', 'mr_failed', 'guard_hit', 'guard_terms_invalid', 'guard_failed', 'tests_unavailable',
];
const retryRank = (code: string): number => (RETRY_ORDER.includes(code) ? RETRY_ORDER.indexOf(code) : RETRY_ORDER.length);
export const MR_RETRY_CODES: readonly string[] = storedCodesWithAction('retry').sort((a, b) => retryRank(a) - retryRank(b));

// An error as an outcome's {code, message}; anything but a FactoryError is logged and kept generic.
export function mrFailure(error: unknown): { code: string; message: string } {
  if (error instanceof FactoryError) {
    return { code: error.code, message: error.message };
  }
  console.error(error);
  return internalError('The merge request failed inside the factory.');
}

// The refusal of an action a handed-over job does not take before Take it back (SF-073).
function handedOverError(job: Job): FactoryError {
  return new FactoryError('handed_over', `${job.ticket} is in your checkout on ${job.branch}; take it back first.`);
}

// The refusal of the actions that need the branch back from the user's checkout (SF-073): a
// handed-over job, or one whose hand-over step was cut off and waits for recover().
export function checkNotInCheckout(job: Job): void {
  if (job.state === 'handed_over') {
    throw handedOverError(job);
  }
  if (job.handover !== undefined && job.handover.step !== null) {
    throw cutOffError(job, job.handover.step);
  }
}

// The refusal of an action on a job whose hand-over step was cut off (SF-073): recover() repairs it.
export function cutOffError(job: Job, step: string): FactoryError {
  return new FactoryError('invalid_state', `A step of the hand-over of ${job.workspace}/${job.ticket} (${step}) was cut off; sf serve repairs it when it starts again.`);
}
