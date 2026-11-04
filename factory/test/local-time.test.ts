// The local time of a stored timestamp (SF-049): the factory stores ISO 8601 UTC, the CLI shows
// the time of the zone the sf process runs in. The zone is set here, not taken from the machine.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localTime } from '../src/local-time.js';
import { formatEvent } from '../src/watch.js';

process.env.TZ = 'Europe/Sofia';

test('localTime: the date and time of the process zone, winter and summer time; undefined when it does not parse', () => {
  assert.equal(localTime('2026-11-04T10:14:25.668Z'), '2026-11-04 12:14:25');
  assert.equal(localTime('2026-07-01T22:30:00.000Z'), '2026-07-02 01:30:00');
  assert.equal(localTime('not a time'), undefined);
  assert.equal(localTime(undefined), undefined);
  assert.equal(localTime(42), undefined);
});

test('sf watch: an event stored at 10:14:25 UTC prints at 12:14:25 in Sofia; a missing or bad time as --:--:--', () => {
  const line = (ts: unknown): string[] => formatEvent(JSON.stringify({ ts, iteration: 1, state: { from: 'working', to: 'awaiting_review' } }));
  assert.deepEqual(line('2026-11-04T10:14:25.668Z'), ['12:14:25 [1] state working -> awaiting_review']);
  assert.deepEqual(line(undefined), ['--:--:-- [1] state working -> awaiting_review']);
  assert.deepEqual(line('yesterday'), ['--:--:-- [1] state working -> awaiting_review']);
});
