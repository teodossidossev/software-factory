// What the job lifecycle writes to a job's stream of events (SF-142): the run of the workspace's
// test command (SF-128) under its reviewer name, and its tests event.
import { type EventRecord, now } from '../jobs.js';
import { EVENT_TAIL_BYTES, EVENT_TAIL_LINES, lastLines, type TestsRecord } from '../test-command.js';

// The reviewer name of the run of a workspace's test command among the running reviews (SF-128).
export const TESTS_RUNNER = 'tests';

// The tests event of a record (run: the tests_started event's): its outcome and the last lines of
// its output for the Stream.
export function testsEvent(iteration: number, run: string, record: TestsRecord): EventRecord {
  const tail = lastLines(record.output, EVENT_TAIL_LINES, EVENT_TAIL_BYTES);
  const truncated = record.output_truncated || tail !== record.output.replace(/\n+$/u, '');
  return {
    ts: now(), iteration, type: 'tests', run, command: record.command, outcome: record.outcome, exit_code: record.exit_code, timed_out: record.timed_out,
    duration_ms: record.duration_ms, ...(record.reason !== undefined ? { reason: record.reason } : {}), tail, ...(truncated ? { tail_truncated: true as const } : {}),
  };
}
