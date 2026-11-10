// The job-state sets derived from STATE_TRAITS (src/jobs.ts): each has the members of the literal
// it replaced (written here as the expected value), in JOB_STATES order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUNNER_STATES } from '../src/health.js';
import { ACTIVE_STATES, JOB_STATES, type JobState, PAUSABLE_STATES, RESTARTABLE_STATES, RESUMABLE_STATES, RUNNING_STATES, STATE_TRAITS, statesWith, TERMINAL_STATES } from '../src/jobs.js';
import { NOTIFIED_STATES } from '../src/notify.js';

// Each derived set, by the name of the set it replaced, with that set's literal.
const SETS: readonly [string, readonly JobState[], readonly JobState[]][] = [
  ['ACTIVE_STATES', ACTIVE_STATES, ['starting', 'working', 'awaiting_review', 'needs_human', 'ready_for_human_review', 'preparing_mr']],
  ['RUNNING_STATES', RUNNING_STATES, ['starting', 'working', 'awaiting_review', 'preparing_mr', 'waiting_limit']],
  ['TERMINAL_STATES', TERMINAL_STATES, ['failed', 'aborted', 'pushed']],
  ['PAUSABLE_STATES', statesWith('pausable'), ['working', 'awaiting_review']],
  ['RESTARTABLE_STATES', RESTARTABLE_STATES, ['paused', 'waiting_limit', 'aborted', 'failed', 'needs_human']],
  ['RESUMABLE_STATES', RESUMABLE_STATES, ['paused', 'waiting_limit']],
  ['stops.ts SAY_STATES, turns.ts checkSay', statesWith('sayable'), ['working', 'awaiting_review', 'needs_human', 'ready_for_human_review', 'handed_over']],
  ['stops.ts RESUME_STATES', statesWith('resumable'), ['paused', 'waiting_limit']],
  ['NOTIFIED_STATES', NOTIFIED_STATES, ['ready_for_human_review', 'handed_over', 'needs_human', 'paused', 'waiting_limit', 'pushed', 'failed']],
  ['update.ts IDLE_STATES', statesWith('idle'), ['needs_human', 'ready_for_human_review', 'handed_over', 'paused', 'waiting_limit', 'failed', 'aborted', 'pushed']],
  ['update.ts BUSY_STATES', statesWith('busy'), ['working', 'awaiting_review', 'starting', 'preparing_mr']],
  ['stats.ts WAITING_STATES', statesWith('waiting'), ['needs_human', 'ready_for_human_review', 'handed_over']],
  ['stats.ts READY_STATES', statesWith('ready'), ['ready_for_human_review', 'handed_over']],
  ['stats.ts DELIVERED_STATES', statesWith('delivered'), ['pushed', 'handed_over']],
  ['RUNNER_STATES', RUNNER_STATES, ['working', 'awaiting_review', 'preparing_mr']],
  ['handover-steps.ts SANDBOXED_STATES', statesWith('sandboxed'), ['working', 'awaiting_review', 'preparing_mr']],
  ['live-smoke.ts PAST_REVIEWS', statesWith('past_reviews'), ['preparing_mr', 'ready_for_human_review', 'pushed']],
  ['live-smoke.ts STOPPED', statesWith('stopped'), ['needs_human', 'failed', 'aborted']],
];

test('every derived set has the members of the literal it replaced, in JOB_STATES order', () => {
  for (const [name, derived, literal] of SETS) {
    assert.deepEqual(derived, JOB_STATES.filter((state) => literal.includes(state)), name);
  }
});

test('PAUSABLE_STATES, the tuple of paused.from, equals statesWith(pausable)', () => {
  assert.deepEqual(PAUSABLE_STATES, statesWith('pausable'));
});

test('STATE_TRAITS has an entry for every state of JOB_STATES, and no other', () => {
  assert.deepEqual(Object.keys(STATE_TRAITS), [...JOB_STATES]);
});

test('idle and busy together cover every state exactly once', () => {
  const idle = statesWith('idle');
  const busy = statesWith('busy');
  for (const state of JOB_STATES) {
    assert.equal(Number(idle.includes(state)) + Number(busy.includes(state)), 1, state);
  }
});
