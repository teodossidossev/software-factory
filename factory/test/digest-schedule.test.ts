// The morning digest's timer (SF-103, src/digest-schedule.ts) with a fake clock and fake digests:
// it runs at each of the times once, not on a weekend with weekdays_only, once after missed times
// (for the latest), not when no workspace follows, still at a time after a manual run earlier that
// day, a run going delays the slot, a legacy `at` still runs, and a changed time applies at the
// next tick.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DigestSchedule, dueSlot, type ScheduledDigests } from '../src/digest-schedule.js';
import { type Registry, saveRegistry } from '../src/registry.js';

let temp: string;
let count = 0;

before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sf-digest-schedule-'));
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

// A registry with one workspace (followed or not) and the digest settings.
async function config(follow: { track?: boolean; my_work?: boolean } | null, digest: Registry['digest'] = undefined): Promise<string> {
  count += 1;
  const dir = join(temp, `config-${count}`);
  await saveRegistry({ workspaces: { app: { read_checkout: '/srv/app', ...(follow !== null ? { digest: follow } : {}) } }, ...(digest !== undefined ? { digest } : {}) }, dir);
  return dir;
}

// Fake digests: the starts, by trigger and time; a scheduled start is stored at the clock's time.
class FakeDigests implements ScheduledDigests {
  running = false;
  readonly starts: Array<{ trigger: string; at: Date }> = [];
  constructor(readonly clock: { now: Date }) {}
  async scheduledSince(since: Date): Promise<boolean> {
    return this.starts.some((start) => start.trigger === 'scheduled' && start.at.getTime() >= since.getTime());
  }
  start(trigger: 'scheduled' | 'manual'): { started: true } {
    this.starts.push({ trigger, at: this.clock.now });
    return { started: true };
  }
}

function setUp(dir: string, now: Date): { clock: { now: Date }; digests: FakeDigests; schedule: DigestSchedule } {
  const clock = { now };
  const digests = new FakeDigests(clock);
  return { clock, digests, schedule: new DigestSchedule({ digests, configDir: dir, now: () => clock.now }) };
}

// Friday 2026-11-06 and the weekend after it, local time.
const friday = (hours: number, minutes = 0): Date => new Date(2026, 10, 6, hours, minutes);

test('runs at `at` (08:00 by default), once a day', async () => {
  const { clock, digests, schedule } = setUp(await config({ track: true }), friday(7, 59));
  assert.equal(await schedule.tick(), false);
  clock.now = friday(8, 0);
  assert.equal(await schedule.tick(), true);
  clock.now = friday(8, 1);
  assert.equal(await schedule.tick(), false);
  clock.now = friday(23, 59);
  assert.equal(await schedule.tick(), false);
  assert.deepEqual(digests.starts.map((start) => start.trigger), ['scheduled']);
  // The next working day again.
  clock.now = new Date(2026, 10, 9, 8, 5);
  assert.equal(await schedule.tick(), true);
  assert.equal(digests.starts.length, 2);
});

test('weekdays_only: not on a weekend; with it off, on Saturday too', async () => {
  const off = setUp(await config({ track: true }), new Date(2026, 10, 7, 9, 0));
  assert.equal(await off.schedule.tick(), false);
  off.clock.now = new Date(2026, 10, 8, 9, 0);
  assert.equal(await off.schedule.tick(), false);
  const on = setUp(await config({ track: true }, { weekdays_only: false }), new Date(2026, 10, 7, 9, 0));
  assert.equal(await on.schedule.tick(), true);
});

test('once after a missed time: a machine that slept through `at`, or a later start', async () => {
  const { clock, digests, schedule } = setUp(await config({ my_work: true }), friday(13, 37));
  assert.equal(await schedule.tick(), true);
  clock.now = friday(13, 38);
  assert.equal(await schedule.tick(), false);
  assert.equal(digests.starts.length, 1);
});

test('not when no workspace follows', async () => {
  for (const follow of [null, { track: false, my_work: false }]) {
    const { schedule, digests } = setUp(await config(follow), friday(9));
    assert.equal(await schedule.tick(), false);
    assert.equal(digests.starts.length, 0);
  }
});

test('still at `at` after a manual run earlier that day; not while a run is going', async () => {
  const { clock, digests, schedule } = setUp(await config({ track: true }), friday(7, 30));
  digests.start('manual');
  clock.now = friday(8, 0);
  digests.running = true;
  assert.equal(await schedule.tick(), false);
  digests.running = false;
  assert.equal(await schedule.tick(), true);
  assert.deepEqual(digests.starts.map((start) => start.trigger), ['manual', 'scheduled']);
});

test('two times: each runs once a day; a run going at the second time delays it until the run ends', async () => {
  const { clock, digests, schedule } = setUp(await config({ track: true }, { times: ['12:30', '08:30'] }), friday(8, 29));
  assert.equal(await schedule.tick(), false);
  clock.now = friday(8, 30);
  assert.equal(await schedule.tick(), true);
  clock.now = friday(9, 0);
  assert.equal(await schedule.tick(), false);
  // The 08:30 run is still going at 12:30.
  digests.running = true;
  clock.now = friday(12, 30);
  assert.equal(await schedule.tick(), false);
  digests.running = false;
  clock.now = friday(12, 45);
  assert.equal(await schedule.tick(), true);
  clock.now = friday(23, 0);
  assert.equal(await schedule.tick(), false);
  assert.deepEqual(digests.starts.map((start) => [start.trigger, start.at.getHours(), start.at.getMinutes()]), [['scheduled', 8, 30], ['scheduled', 12, 45]]);
  // Monday: both again.
  clock.now = new Date(2026, 10, 9, 8, 31);
  assert.equal(await schedule.tick(), true);
  clock.now = new Date(2026, 10, 9, 12, 31);
  assert.equal(await schedule.tick(), true);
  assert.equal(digests.starts.length, 4);
});

test('a machine asleep through both times runs once at wake-up, for the latest; a time added today that has passed runs at the next check', async () => {
  const dir = await config({ track: true }, { times: ['08:30', '10:45'] });
  const { clock, digests, schedule } = setUp(dir, friday(14, 0));
  assert.equal(await schedule.tick(), true);
  clock.now = friday(14, 1);
  assert.equal(await schedule.tick(), false);
  assert.equal(digests.starts.length, 1);
  // 13:00 added at 14:05: it passed after the run at 14:00, which counts for it.
  await saveRegistry({ workspaces: { app: { read_checkout: '/srv/app', digest: { track: true } } }, digest: { times: ['08:30', '10:45', '13:00'] } }, dir);
  clock.now = friday(14, 5);
  assert.equal(await schedule.tick(), false);
  // 14:30 added at 14:40: it runs at the next check.
  await saveRegistry({ workspaces: { app: { read_checkout: '/srv/app', digest: { track: true } } }, digest: { times: ['08:30', '14:30'] } }, dir);
  clock.now = friday(14, 40);
  assert.equal(await schedule.tick(), true);
  assert.equal(digests.starts.length, 2);
});

test('a legacy `at` in workspaces.json still runs, once a day', async () => {
  const { clock, digests, schedule } = setUp(await config({ track: true }, { at: '09:15' }), friday(9, 14));
  assert.equal(await schedule.tick(), false);
  clock.now = friday(9, 15);
  assert.equal(await schedule.tick(), true);
  clock.now = friday(18, 0);
  assert.equal(await schedule.tick(), false);
  assert.equal(digests.starts.length, 1);
});

test('dueSlot: the latest passed time of a digest day with a followed workspace, else null', async () => {
  const registry = (digest: Registry['digest'], follow = true): Registry => ({ workspaces: { app: { read_checkout: '/srv/app', ...(follow ? { digest: { my_work: true } } : {}) } }, ...(digest !== undefined ? { digest } : {}) });
  const times = { times: ['08:30', '10:45'] };
  assert.equal(dueSlot(registry(times), friday(8, 29)), null);
  assert.deepEqual(dueSlot(registry(times), friday(8, 30)), friday(8, 30));
  assert.deepEqual(dueSlot(registry(times), friday(10, 44)), friday(8, 30));
  assert.deepEqual(dueSlot(registry(times), friday(23, 59)), friday(10, 45));
  assert.equal(dueSlot(registry(times, false), friday(12)), null);
  // Saturday: none with weekdays_only (the default), the latest without it.
  assert.equal(dueSlot(registry(times), new Date(2026, 10, 7, 12)), null);
  assert.deepEqual(dueSlot(registry({ ...times, weekdays_only: false }), new Date(2026, 10, 7, 12)), new Date(2026, 10, 7, 10, 45));
  // The default 08:00; a legacy at.
  assert.deepEqual(dueSlot(registry(undefined), friday(9)), friday(8));
  assert.deepEqual(dueSlot(registry({ at: '07:10' }), friday(9)), friday(7, 10));
});

test('a stored scheduled digest of today counts (sf serve restarted); a changed `at` applies at the next tick', async () => {
  const dir = await config({ track: true }, { at: '10:00' });
  const first = setUp(dir, friday(9, 0));
  assert.equal(await first.schedule.tick(), false);
  await saveRegistry({ workspaces: { app: { read_checkout: '/srv/app', digest: { track: true } } }, digest: { at: '08:30' } }, dir);
  assert.equal(await first.schedule.tick(), true);
  // Another sf serve the same day: the stored scheduled digest of today keeps it from running.
  const second = new DigestSchedule({ digests: first.digests, configDir: dir, now: () => friday(11) });
  assert.equal(await second.tick(), false);
  assert.equal(first.digests.starts.length, 1);
});
