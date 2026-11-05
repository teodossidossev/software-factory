// The usage limit of a failure message (SF-072): the known Claude and Codex messages as fixtures,
// only the caller's source's pattern, only the first line, and the reset-time rules.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resetTime, usageLimit } from '../src/usage-limit.js';

// 2026-11-05 01:00 in Sofia (UTC+2 in November).
const NOW = new Date('2026-11-04T23:00:00.000Z');

test('the Claude messages are detected with their reset time in the named zone', () => {
  assert.deepEqual(usageLimit("You've hit your 5-hour limit · resets 3am (Europe/Sofia)", NOW, 'claude'), { provider: 'claude', resets_at: '2026-11-05T01:00:00.000Z' });
  assert.deepEqual(usageLimit("You've hit your weekly limit · resets Nov 7, 3am (Europe/Sofia)", NOW, 'claude'), { provider: 'claude', resets_at: '2026-11-07T01:00:00.000Z' });
  const plain = usageLimit("You've hit your limit · resets 3am", NOW, 'claude');
  assert.equal(plain?.provider, 'claude');
  assert.notEqual(plain?.resets_at, null);
});

test('the Codex messages are detected from the gate and reported as codex', () => {
  assert.deepEqual(usageLimit("Codex reported an error: You've hit your usage limit. Try again in 2 hours 13 minutes.", NOW, 'codex'), {
    provider: 'codex', resets_at: new Date(NOW.getTime() + (2 * 60 + 13) * 60_000).toISOString(),
  });
  assert.deepEqual(usageLimit('Codex exited with code 1: Rate limit reached for requests. Try again in 20s.', NOW, 'codex'), {
    provider: 'codex', resets_at: new Date(NOW.getTime() + 20_000).toISOString(),
  });
});

test('only the source of the caller applies', () => {
  assert.equal(usageLimit("You've hit your usage limit. Try again in 2 hours 13 minutes.", NOW, 'claude')?.provider, 'claude');
  assert.equal(usageLimit('Rate limit reached for requests. Try again in 20s.', NOW, 'claude'), undefined);
  assert.equal(usageLimit("You've hit your 5-hour limit · resets 3am (Europe/Sofia)", NOW, 'codex'), undefined);
});

test('a failure that is no usage limit is not detected', () => {
  assert.equal(usageLimit('The turn ended with error_during_execution: the process exited', NOW, 'claude'), undefined);
  assert.equal(usageLimit('Codex exited with code 1: unexpected argument', NOW, 'codex'), undefined);
  assert.equal(usageLimit('The Implementer ended the turn without a result.', NOW, 'claude'), undefined);
});

test('only the first line is read', () => {
  assert.equal(usageLimit("The review failed\nquoted: You've hit your 5-hour limit · resets 3am", NOW, 'claude'), undefined);
  assert.equal(usageLimit("You've hit your 5-hour limit · resets 3am (Europe/Sofia)\nmore", NOW, 'claude')?.resets_at, '2026-11-05T01:00:00.000Z');
});

test('a time already past today is the same time tomorrow', () => {
  // 05:00 in Sofia: 3am is past.
  const later = new Date('2026-11-05T03:00:00.000Z');
  assert.equal(resetTime('resets 3am (Europe/Sofia)', later), '2026-11-06T01:00:00.000Z');
  assert.equal(resetTime('resets 3:30pm (Europe/Sofia)', later), '2026-11-05T13:30:00.000Z');
  assert.equal(resetTime('resets 12am (UTC)', later), '2026-11-06T00:00:00.000Z');
});

test('a date already past is next year', () => {
  assert.equal(resetTime('resets Nov 1, 3am (Europe/Sofia)', NOW), '2027-11-01T01:00:00.000Z');
});

test('no zone or an unknown zone is the zone of this process', () => {
  const local = new Date(NOW);
  local.setHours(3, 0, 0, 0);
  if (local.getTime() <= NOW.getTime()) {
    local.setDate(local.getDate() + 1);
  }
  assert.equal(resetTime('resets 3am', NOW), local.toISOString());
  assert.equal(resetTime('resets 3am (Mars/Olympus)', NOW), local.toISOString());
});

test('nothing parseable is null', () => {
  assert.deepEqual(usageLimit("You've hit your limit", NOW, 'claude'), { provider: 'claude', resets_at: null });
  assert.equal(resetTime('resets soon', NOW), null);
  assert.equal(resetTime('resets 13pm', NOW), null);
  assert.equal(resetTime('try again in a while', NOW), null);
});
