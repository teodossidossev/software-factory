// The morning digest's timer (SF-103, src/digest-schedule.ts) with a fake clock and fake digests:
// it runs at `at`, not on a weekend with weekdays_only, once after a missed time, not twice a day,
// not when no workspace follows, still at `at` after a manual run earlier that day, and a changed
// `at` applies at the next tick.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DigestSchedule, type ScheduledDigests } from '../src/digest-schedule.js';
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
