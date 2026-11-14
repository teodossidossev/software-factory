// The lead time of a job (src/lead-time.ts): the clock over event fixtures (a straight job, stops
// and returns, parks, a running job, an aborted job, a merged merge request, unknown states), the
// parts always adding up to the total, and jobLead's size and target.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JOB_STATES, JobStore, TERMINAL_STATES } from '../src/jobs.js';
import { jobLead, LEAD_PARTS, type LeadClock, type LeadEvent, type LeadPart, leadTime } from '../src/lead-time.js';
import { normsFile } from '../src/norms.js';

const BASE = Date.parse('2026-11-13T08:00:00.000Z');
// The time `minutes` after the base, as the log writes it.
const at = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString();
const to = (minutes: number, state: string): LeadEvent => ({ ts: at(minutes), to: state });
const merged = (minutes: number): LeadEvent => ({ ts: at(minutes), event: 'merge_request', state: 'merged' });
const NOW = new Date(BASE + 24 * 3600_000);

// The clock, checking that the four parts add up to the total.
function clock(events: readonly LeadEvent[], now = NOW, targetHours = 4): LeadClock {
  const result = leadTime(events, now, targetHours);
  const { total, ...parts } = result.seconds;
  assert.equal(total, Object.values(parts).reduce((sum, value) => sum + value, 0), 'the parts add up to the total');
  return result;
}

test('LEAD_PARTS: every job state is in exactly one part or ends the clock', () => {
  for (const state of JOB_STATES) {
    const parts = (Object.keys(LEAD_PARTS) as LeadPart[]).filter((part) => LEAD_PARTS[part].includes(state));
    assert.equal(parts.length + (TERMINAL_STATES.includes(state) ? 1 : 0), 1, state);
  }
});

test('leadTime: a straight job, worked, reviewed by the user and pushed', () => {
  const result = clock([
    to(0, 'starting'), to(1, 'working'), to(60, 'awaiting_review'), to(90, 'ready_for_human_review'), to(150, 'preparing_mr'), to(155, 'pushed'),
    // After the end: ignored.
    to(200, 'working'),
  ]);
  assert.deepEqual(result, {
    started_at: at(0), ready_at: at(90), done_at: at(155),
    seconds: { working: 95 * 60, waiting_for_user: 60 * 60, in_user_hands: 0, parked: 0, total: 155 * 60 },
    returns: 0, over_target: false,
  });
});

test('leadTime: stops and returns; a return through needs_human is not counted; ready_at is the first', () => {
  const result = clock([
    to(0, 'starting'), to(0, 'working'), to(30, 'needs_human'), to(50, 'working'), to(80, 'ready_for_human_review'),
    to(100, 'working'), to(130, 'handed_over'), to(400, 'working'), to(420, 'handed_over'), to(430, 'needs_human'), to(440, 'working'),
    to(460, 'preparing_mr'), to(465, 'pushed'),
  ]);
  assert.equal(result.ready_at, at(80));
  assert.equal(result.done_at, at(465));
  assert.equal(result.returns, 2);
  assert.deepEqual(result.seconds, {
    working: (30 + 30 + 30 + 20 + 20 + 5) * 60, waiting_for_user: (20 + 20 + 10) * 60, in_user_hands: (270 + 10) * 60, parked: 0, total: 465 * 60,
  });
  assert.equal(result.over_target, true);
});

test('leadTime: a pause and a usage-limit park are parked', () => {
  const result = clock([to(0, 'working'), to(10, 'paused'), to(70, 'working'), to(80, 'waiting_limit'), to(110, 'working'), to(120, 'pushed')]);
  assert.deepEqual(result.seconds, { working: 30 * 60, waiting_for_user: 0, in_user_hands: 0, parked: 90 * 60, total: 120 * 60 });
});

test('leadTime: a job still running counts its open interval to now; over the target once past it', () => {
  const events = [to(0, 'starting'), to(1, 'working')];
  const running = clock(events, new Date(BASE + 3 * 3600_000));
  assert.deepEqual([running.done_at, running.ready_at, running.seconds.working, running.seconds.total, running.over_target], [null, null, 3 * 3600, 3 * 3600, false]);
  // Exactly the target is not above it; a second more is.
  assert.equal(clock(events, new Date(BASE + 4 * 3600_000)).over_target, false);
  assert.equal(clock(events, new Date(BASE + 4 * 3600_000 + 1000)).over_target, true);
  assert.equal(clock(events, new Date(BASE + 2 * 3600_000), 1.5).over_target, true);
  // A now before the last change counts nothing for it.
  assert.equal(clock(events, new Date(BASE)).seconds.total, 60);
});

test('leadTime: an aborted or failed job stops the clock with no done_at', () => {
  for (const end of ['aborted', 'failed']) {
    const result = clock([to(0, 'working'), to(45, 'needs_human'), to(60, end), to(90, 'pushed')]);
    assert.deepEqual([result.done_at, result.seconds.working, result.seconds.waiting_for_user, result.seconds.total], [null, 45 * 60, 15 * 60, 60 * 60], end);
  }
});

test('leadTime: a merged merge request record ends the clock; other merge request records do not', () => {
  const result = clock([
    to(0, 'working'), to(30, 'ready_for_human_review'),
    { ts: at(40), event: 'merge_request', state: 'opened' }, { ts: at(50), event: 'gate_overridden' },
    merged(70), to(80, 'pushed'),
  ]);
  assert.deepEqual([result.done_at, result.seconds.working, result.seconds.waiting_for_user, result.seconds.total], [at(70), 30 * 60, 40 * 60, 70 * 60]);
  // A merged record before any state change ends the clock too: the later state changes are
  // ignored, and with no state change before it the clock is the empty one.
  assert.deepEqual(clock([merged(0), to(10, 'working'), to(15, 'ready_for_human_review'), to(17, 'working'), to(20, 'pushed')]), {
    started_at: null, ready_at: null, done_at: null,
    seconds: { working: 0, waiting_for_user: 0, in_user_hands: 0, parked: 0, total: 0 }, returns: 0, over_target: false,
  });
  // A merged record whose ts is not a date is skipped like any other entry.
  assert.equal(clock([{ ts: 'x', event: 'merge_request', state: 'merged' }, to(10, 'working'), to(20, 'pushed')]).seconds.total, 10 * 60);
});

test('leadTime: a state it does not know counts in no part and not in the total; a bad ts is skipped', () => {
  const result = clock([to(0, 'working'), to(10, 'mystery'), to(40, 'working'), { ts: 'not a date', to: 'paused' }, { ts: at(45), to: 'ready_for_human_review' }, to(55, 'pushed')]);
  assert.deepEqual(result.seconds, { working: 15 * 60, waiting_for_user: 10 * 60, in_user_hands: 0, parked: 0, total: 25 * 60 });
  // A job whose first state is unknown still starts the clock.
  assert.deepEqual([clock([to(0, 'mystery'), to(5, 'working'), to(10, 'pushed')]).started_at, clock([to(0, 'mystery')]).seconds.total], [at(0), 0]);
});

test('leadTime: no state change is the empty clock; parts are whole seconds and still add up', () => {
  for (const events of [[], [{ ts: at(0), event: 'gate_overridden' }], [{ ts: 'x', to: 'working' }]]) {
    assert.deepEqual(clock(events), {
      started_at: null, ready_at: null, done_at: null,
      seconds: { working: 0, waiting_for_user: 0, in_user_hands: 0, parked: 0, total: 0 }, returns: 0, over_target: false,
    });
  }
  const odd = (ms: number): string => new Date(BASE + ms).toISOString();
  const result = clock([{ ts: odd(0), to: 'working' }, { ts: odd(1600), to: 'paused' }, { ts: odd(3200), to: 'pushed' }]);
  assert.deepEqual(result.seconds, { working: 2, waiting_for_user: 0, in_user_hands: 0, parked: 2, total: 4 });
});

test('jobLead: the size from the job\'s Task copy (medium without one) and the target of the workspace\'s norms', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-lead-'));
  try {
    const jobs = new JobStore(join(dir, 'state'));
    const config = join(dir, 'config');
    await mkdir(config);
    await writeFile(normsFile(config), JSON.stringify({ version: 1, lead_time_hours: { complex: 10 }, workspaces: { app: { lead_time_hours: { small: 1 } } } }));
    const events = [to(0, 'working'), to(90, 'pushed')];
    const now = new Date(BASE + 3600_000);
    // No job directory, no Task copy: medium, the default target.
    assert.deepEqual(await jobLead(jobs, 'app', 'T-1', events, config, now), { size: 'medium', target_hours: 4, ...leadTime(events, now, 4) });
    const copy = async (name: string, text: string): Promise<void> => {
      await mkdir(jobs.dir('app', name), { recursive: true });
      await jobs.writeTaskCopy('app', name, Buffer.from(text));
    };
    await copy('T-1', '---\nticket: T-1\ntitle: t\nbase: main\nsize: small\n---\n');
    const small = await jobLead(jobs, 'app', 'T-1', events, config, now);
    assert.deepEqual([small.size, small.target_hours, small.over_target], ['small', 1, true]);
    // An archived job's directory name; the file's top-level target.
    await copy('T-2.20261113T080000Z', '---\nticket: T-2\ntitle: t\nbase: main\nsize: complex\n---\n');
    assert.deepEqual([(await jobLead(jobs, 'app', 'T-2.20261113T080000Z', events, config, now)).target_hours], [10]);
    // No front matter: medium; a norms directory without a file: the defaults.
    await copy('T-3', '# no front matter\n');
    assert.deepEqual((await jobLead(jobs, 'app', 'T-3', events, join(dir, 'none'), now)).target_hours, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
