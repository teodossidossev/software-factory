// The re-checks of the automatic Task checks: AutoChecks with the run queue's entries, a fake clock,
// a fake runner and a temporary Git repository as the work checkout. A queued ticket's failed check
// is tried again 15 minutes after it ended, at most 3 times (a dropped retry does not count), and
// notified once, after the last; a
// queued not-ready one is checked again when a commit on its base touches its scope (any path
// without a scope), never a ready one; a fetch error skips the workspace for one sweep.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Job } from '../src/jobs.js';
import type { Workspace } from '../src/registry.js';
import { type CheckRecord, taskSha256 } from '../src/task-check.js';
import { AutoChecks } from '../src/task-check-auto.js';
import { MAX_RETRIES, movedIntoScope, type QueuedTicket, RETRY_AFTER_MS, scopeGlobs, SWEEP_MS, touchesScope } from '../src/task-check-recheck.js';
import { FakeClock, FakeRunner } from './support/auto-checks.js';
import { git, temp } from './support/harness.js';

const MINUTE = 60_000;
// The fake clock's zero as a wall time: the records' ended_at and the sweep's now.
const START = Date.parse('2026-11-10T08:00:00.000Z');

const text = (ticket: string, scope = 'scope: [src/**]'): string =>
  `---\nticket: ${ticket}\ntitle: Ticket ${ticket}\nbase: main\n${scope === '' ? '' : `${scope}\n`}---\n\n# ${ticket}\n\nChange the code.\n`;

interface Rig {
  dir: string;
  clock: FakeClock;
  runner: FakeRunner;
  auto: AutoChecks;
  queue: QueuedTicket[];
  jobs: Map<string, Job>;
  ended: CheckRecord[];
  // Writes the ticket's Task file and stores a check of it.
  put(ticket: string, verdict: 'ready' | 'not_ready' | 'failed', commit: string | null, scope?: string): Promise<string>;
  // A record of the ticket's Task file ending now.
  record(ticket: string, verdict: 'ready' | 'not_ready' | 'failed', commit: string | null): CheckRecord;
  // A commit on main of the work checkout that changes path; its hash.
  commit(path: string): Promise<string>;
}

// A work checkout on main with src/a.ts and README.md (a clone of a bare origin when withOrigin),
// the checks' state outside it, and AutoChecks over the fake runner, started.
async function rig(name: string, withOrigin = false): Promise<Rig> {
  const root = join(temp, name);
  const seed = join(root, withOrigin ? 'seed' : 'repo');
  await mkdir(join(seed, 'src'), { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(join(seed, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(seed, 'README.md'), 'hello\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'initial');
  let dir = seed;
  if (withOrigin) {
    git(root, 'clone', '-q', '--bare', seed, join(root, 'origin.git'));
    git(root, 'clone', '-q', join(root, 'origin.git'), join(root, 'repo'));
    dir = join(root, 'repo');
  }
  await mkdir(join(dir, '.software-factory'));
  const clock = new FakeClock();
  const runner = new FakeRunner(join(root, 'state'));
  const queue: QueuedTicket[] = [];
  const jobs = new Map<string, Job>();
  const ended: CheckRecord[] = [];
  const workspace: Workspace = { name: 'app', readCheckout: dir, workCheckout: dir };
  const auto = new AutoChecks({
    checks: runner, jobs: { read: async (ws, ticket) => jobs.get(`${ws}/${ticket}`) }, resolve: async () => workspace, workspaces: async () => [],
    parallel: 1, timers: clock, onCheckEnded: (record) => ended.push(record), queued: async () => queue, now: () => START + clock.now,
  });
  await auto.start();
  const contents = new Map<string, string>();
  const record = (ticket: string, verdict: 'ready' | 'not_ready' | 'failed', commit: string | null): CheckRecord => {
    const at = new Date(START + clock.now).toISOString();
    const findings = verdict === 'not_ready' ? [{ kind: 'missing' as const, severity: 'blocker' as const, where: 'w', problem: 'p', expected: 'e' }] : [];
    return {
      workspace: 'app', ticket, sha256: taskSha256(contents.get(ticket) ?? text(ticket)), commit, status: verdict === 'failed' ? 'failed' : 'checked',
      output: verdict === 'failed' ? null : { paraphrase: 'p', findings, files: [], verdict }, error: verdict === 'failed' ? 'The check timed out.' : null,
      model: null, cost_usd: null, started_at: at, ended_at: at,
    };
  };
  const put = async (ticket: string, verdict: 'ready' | 'not_ready' | 'failed', commit: string | null, scope?: string): Promise<string> => {
    const content = text(ticket, scope);
    contents.set(ticket, content);
    await writeFile(join(dir, '.software-factory', `${ticket}.md`), content);
    await runner.store.write(record(ticket, verdict, commit));
    return content;
  };
  const commit = async (path: string): Promise<string> => {
    await writeFile(join(dir, path), `${path} ${Math.random()}\n`);
    git(dir, 'add', path);
    git(dir, 'commit', '-q', '-m', `change ${path}`);
    if (withOrigin) {
      git(dir, 'push', '-q', 'origin', 'main');
    }
    return git(dir, 'rev-parse', 'HEAD').trim();
  };
  return { dir, clock, runner, auto, queue, jobs, ended, put, record, commit };
}

// Moves the clock a minute at a time, letting the sweeps, starts and notifications that follow
// settle after each: a sweep reads the clock after it fired.
async function advance(r: Rig, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= MINUTE) {
    r.clock.advance(Math.min(left, MINUTE));
    await r.auto.idle();
  }
}

// The next sweep (SWEEP_MS on), then the trigger's delay: a re-check it asked for has started.
async function sweepAndDelay(r: Rig): Promise<void> {
  await advance(r, SWEEP_MS);
  await advance(r, MINUTE);
}

const head = (r: Rig): string => git(r.dir, 'rev-parse', 'HEAD').trim();

test('the constants: a sweep every 10 minutes, a retry 15 minutes after the failure, at most 3', () => {
  assert.deepEqual([SWEEP_MS, RETRY_AFTER_MS, MAX_RETRIES], [10 * MINUTE, 15 * MINUTE, 3]);
});

test('a queued ticket whose check failed is checked again 15 minutes after it ended, at most 3 times; the notification comes once, after the last failure', async (t) => {
  const r = await rig('recheck-retry');
  t.after(() => r.auto.close());
  await writeFile(join(r.dir, '.software-factory', 'R-1.md'), text('R-1'));
  r.queue.push({ workspace: 'app', ticket: 'R-1', force: false });
  // The first automatic check fails: a retry follows, so no notification.
  r.auto.trigger('app', 'R-1');
  await advance(r, MINUTE);
  await r.runner.end('app', 'R-1', r.record('R-1', 'failed', null));
  await r.auto.idle();
  r.runner.starts.length = 0;
  assert.equal(r.ended.length, 0);
  // 10 minutes after the failure: too early.
  await advance(r, SWEEP_MS);
  await advance(r, MINUTE);
  assert.deepEqual(r.runner.starts, []);
  for (let retry = 1; retry <= MAX_RETRIES; retry += 1) {
    // The next sweep at least 15 minutes after the last failure, then the trigger's delay.
    for (let minute = 0; minute < 40 && r.runner.starts.length < retry; minute += 1) {
      await advance(r, MINUTE);
    }
    assert.deepEqual(r.runner.starts, Array.from({ length: retry }, () => 'auto app/R-1'));
    await r.runner.end('app', 'R-1', r.record('R-1', 'failed', head(r)));
    await r.auto.idle();
    assert.equal(r.ended.length, retry === MAX_RETRIES ? 1 : 0);
    if (retry < MAX_RETRIES) {
      // Not before the 15 minutes.
      await advance(r, RETRY_AFTER_MS - MINUTE);
      assert.equal(r.runner.starts.length, retry);
    }
  }
  assert.equal(r.ended[0]!.status, 'failed');
  // The cap: no more retries, no more notifications.
  for (let sweep = 0; sweep < 6; sweep += 1) {
    await sweepAndDelay(r);
  }
  assert.equal(r.runner.starts.length, MAX_RETRIES);
  assert.equal(r.ended.length, 1);
});

test('a failed check of a ticket that is not queued, or forced, is not retried, and its failure is notified at once; nor one whose job runs, until it no longer does', async (t) => {
  const r = await rig('recheck-not-queued');
  t.after(() => r.auto.close());
  await r.put('N-1', 'failed', null);
  await r.put('N-2', 'failed', null);
  await r.put('N-3', 'failed', null);
  r.queue.push({ workspace: 'app', ticket: 'N-2', force: true }, { workspace: 'app', ticket: 'N-3', force: false });
  r.jobs.set('app/N-3', { workspace: 'app', ticket: 'N-3', state: 'working' } as Job);
  for (let sweep = 0; sweep < 5; sweep += 1) {
    await sweepAndDelay(r);
  }
  assert.deepEqual(r.runner.starts, []);
  // The retries dropped for N-3's job did not count: once the job is gone, it is retried.
  r.jobs.delete('app/N-3');
  await sweepAndDelay(r);
  assert.deepEqual(r.runner.starts, ['auto app/N-3']);
  await r.runner.end('app', 'N-3', r.record('N-3', 'failed', null));
  await r.auto.idle();
  assert.equal(r.ended.length, 0);
  r.runner.starts.length = 0;
  // An automatic check of a ticket outside the queue that fails: no retry follows, so it is notified.
  r.auto.trigger('app', 'N-4');
  await writeFile(join(r.dir, '.software-factory', 'N-4.md'), text('N-4'));
  await advance(r, MINUTE);
  assert.deepEqual(r.runner.starts, ['auto app/N-4']);
  await r.runner.end('app', 'N-4', r.record('N-4', 'failed', null));
  await r.auto.idle();
  assert.deepEqual(r.ended.map((record) => record.ticket), ['N-4']);
});

test('a queued not-ready ticket is checked again after a commit on the base touches its scope, not after one outside it; a re-check that ends not_ready again is not notified; a ready one is never re-checked', async (t) => {
  const r = await rig('recheck-moved');
  t.after(() => r.auto.close());
  const first = head(r);
  await r.put('M-1', 'not_ready', first);
  await r.put('M-2', 'ready', first);
  await r.put('M-3', 'not_ready', first, 'scope: [docs/**]\nmay_touch: [src/a.ts]');
  r.queue.push({ workspace: 'app', ticket: 'M-1', force: false }, { workspace: 'app', ticket: 'M-2', force: false });
  // The base has not moved.
  await sweepAndDelay(r);
  assert.deepEqual(r.runner.starts, []);
  // A commit outside src/**: nothing starts.
  await r.commit('README.md');
  await sweepAndDelay(r);
  assert.deepEqual(r.runner.starts, []);
  // A commit in src/**: M-1 is checked again, M-2 (ready) not.
  const tip = await r.commit('src/a.ts');
  await sweepAndDelay(r);
  assert.deepEqual(r.runner.starts, ['auto app/M-1']);
  await r.runner.end('app', 'M-1', r.record('M-1', 'not_ready', tip));
  await r.auto.idle();
  assert.deepEqual(r.ended, []);
  assert.equal((await r.runner.store.read('app', 'M-1', taskSha256(text('M-1'))))?.commit, tip);
  // Its record now reads the tip: nothing more.
  await sweepAndDelay(r);
  await sweepAndDelay(r);
  assert.deepEqual(r.runner.starts, ['auto app/M-1']);
  // may_touch counts as scope; once queued, M-3 is checked again for the src/a.ts change.
  r.queue.push({ workspace: 'app', ticket: 'M-3', force: false });
  await sweepAndDelay(r);
  assert.deepEqual(r.runner.starts, ['auto app/M-1', 'auto app/M-3']);
  await r.runner.end('app', 'M-3', r.record('M-3', 'ready', tip));
  await r.auto.idle();
  // A ready record: never again, whatever moves (M-1 has left the queue).
  r.queue.splice(0, 1);
  await r.commit('src/a.ts');
  await sweepAndDelay(r);
  assert.deepEqual(r.runner.starts, ['auto app/M-1', 'auto app/M-3']);
  assert.deepEqual(r.ended, []);
});

test('without scope or may_touch any changed path counts, and a commit Git does not know counts as moved', async (t) => {
  const r = await rig('recheck-no-scope');
  t.after(() => r.auto.close());
  const first = head(r);
  await r.put('U-1', 'not_ready', first, '');
  await r.put('U-2', 'not_ready', 'f'.repeat(40));
  r.queue.push({ workspace: 'app', ticket: 'U-1', force: false }, { workspace: 'app', ticket: 'U-2', force: false });
  // The unknown commit: U-2 at the first sweep; U-1's base has not moved.
  await sweepAndDelay(r);
  assert.deepEqual(r.runner.starts, ['auto app/U-2']);
  await r.runner.end('app', 'U-2', r.record('U-2', 'not_ready', first));
  await r.auto.idle();
  await r.commit('README.md');
  await sweepAndDelay(r);
  assert.deepEqual(r.runner.starts, ['auto app/U-2', 'auto app/U-1']);
  assert.deepEqual([touchesScope([], []), touchesScope([], ['x']), touchesScope(['src/**'], ['README.md']), touchesScope(['src/**'], undefined)], [false, true, false, true]);
});

test('movedIntoScope (SF-317), the test the sweep and the follow-up check share: the same commit has not moved; another moved into scope only when a path between them matches', async (t) => {
  const r = await rig('recheck-moved-into-scope');
  t.after(() => r.auto.close());
  const first = head(r);
  const readme = await r.commit('README.md');
  const source = await r.commit('src/a.ts');
  assert.equal(await movedIntoScope(r.dir, first, first, ['src/**']), false);
  assert.equal(await movedIntoScope(r.dir, first, readme, ['src/**']), false);
  assert.equal(await movedIntoScope(r.dir, first, source, ['src/**']), true);
  assert.equal(await movedIntoScope(r.dir, readme, source, ['README.md']), false);
  // Without globs any changed path counts; a commit Git does not know, or none, counts as moved.
  assert.equal(await movedIntoScope(r.dir, first, readme, []), true);
  assert.equal(await movedIntoScope(r.dir, 'f'.repeat(40), first, ['src/**']), true);
  assert.equal(await movedIntoScope(r.dir, null, first, ['src/**']), true);
  assert.deepEqual(scopeGlobs(new Map([['scope', '[src/**]'], ['may_touch', '[docs/x.md]']])), ['src/**', 'docs/x.md']);
});

test('a fetch error skips the workspace for the sweep, logged once; the next sweep tries again', async (t) => {
  const r = await rig('recheck-fetch', true);
  t.after(() => r.auto.close());
  const errors: string[] = [];
  t.mock.method(console, 'error', (message: unknown) => void errors.push(String(message)));
  const first = head(r);
  await r.put('F-1', 'not_ready', first);
  await r.put('F-2', 'not_ready', first);
  r.queue.push({ workspace: 'app', ticket: 'F-1', force: false }, { workspace: 'app', ticket: 'F-2', force: false });
  await r.commit('src/a.ts');
  const origin = git(r.dir, 'remote', 'get-url', 'origin').trim();
  git(r.dir, 'remote', 'set-url', 'origin', join(temp, 'recheck-fetch', 'gone.git'));
  await sweepAndDelay(r);
  assert.deepEqual(r.runner.starts, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /re-check of the not-ready Task checks of app skipped this sweep: git fetch origin failed/);
  git(r.dir, 'remote', 'set-url', 'origin', origin);
  await sweepAndDelay(r);
  assert.deepEqual(r.runner.starts, ['auto app/F-1']);
  assert.equal(errors.length, 1);
});
