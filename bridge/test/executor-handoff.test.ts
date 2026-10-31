// SF-009 Review 03, R3-2 and R3-4: the session's processes are checked again at the review and
// acceptance handoff. A process of the session started after a stable snapshot that stays silent
// (no output, no write yet) passes the idle gate and the tree fingerprint; it must not let a review
// or acceptance be handed over while it runs. The handoff is deferred to a new verified quiet
// boundary, which revalidates the snapshot and the tree. The scan tells proven writers of the
// session from same-user processes it cannot attribute, each with its own reason code.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { scanBlocker, SESSION_TAG, sessionWriters } from '../src/executor/quiescence.js';
import type { SupervisorOptions } from '../src/executor/supervisor.js';
import { acceptedJob, destroyFixture, invocations, jobDir, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, messages, setStreamMode, startSupervisor, waitFor } from './support/executor-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

// ---- R3-4: the scan on a fake /proc ----

async function fakeProc(): Promise<{ root: string; add: (pid: number, p: { ppid: number; start: number; name?: string; env?: string[] | 'unreadable' }) => Promise<void>; remove: (pid: number) => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'sf009-proc-'));
  cleanup.push(async () => {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    add: async (pid, p) => {
      const dir = join(root, String(pid));
      await mkdir(dir);
      const fields = ['S', String(p.ppid), ...Array<string>(17).fill('0'), String(p.start), '0', '0'];
      await writeFile(join(dir, 'stat'), `${pid} (${p.name ?? 'node'}) ${fields.join(' ')}\n`);
      await writeFile(join(dir, 'environ'), p.env === 'unreadable' ? 'FIXTURE_ONLY_VARIABLE=do-not-show\0' : `${(p.env ?? ['PATH=/bin']).join('\0')}\0`);
      if (p.env === 'unreadable') await chmod(join(dir, 'environ'), 0o000);
    },
    remove: async (pid) => rm(join(root, String(pid)), { recursive: true, force: true }),
  };
}

test('proven session writers and unattributed processes are counted apart, with their own codes; nothing private is shown', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads any file');
  const proc = await fakeProc();
  const tag = randomUUID();
  await proc.add(100, { ppid: 1, start: 500, name: 'claude' });
  // Detached and tagged: a proven writer.
  await proc.add(101, { ppid: 1, start: 510, name: 'sleep', env: [`${SESSION_TAG}=${tag}`] });
  // Foreign: another session's tag; and an untagged one: neither counted.
  await proc.add(102, { ppid: 1, start: 520, env: [`${SESSION_TAG}=${randomUUID()}`] });
  await proc.add(103, { ppid: 1, start: 530 });
  // Unrelated same-user process whose environment cannot be read: unattributed, never ignored.
  await proc.add(104, { ppid: 1, start: 540, name: 'ssh-agent', env: 'unreadable' });
  // Started before the session: cannot carry its tag; also a recycled pid carrying the tag.
  await proc.add(105, { ppid: 1, start: 100, env: 'unreadable' });
  await proc.add(106, { ppid: 1, start: 90, env: [`${SESSION_TAG}=${tag}`] });
  const both = await sessionWriters(100, [tag], '500', proc.root);
  assert.deepEqual(both.writers.map((ref) => ref.pid), [101]);
  assert.deepEqual(both.unattributed, [{ pid: 104, start: '540', name: 'ssh-agent' }]);
  assert.equal(both.indeterminate, 1);
  assert.equal(scanBlocker(both)?.code, 'session_writers', 'a proven writer is named first');
  // The writer ended (vanished): only the unattributed process is left, under its own code.
  await proc.remove(101);
  const unknown = await sessionWriters(100, [tag], '500', proc.root);
  const blocker = scanBlocker(unknown);
  assert.equal(blocker?.code, 'unattributed_processes');
  assert.match(blocker!.message, /pid 104 ssh-agent/);
  assert.doesNotMatch(blocker!.message, /FIXTURE_ONLY_VARIABLE|do-not-show|PATH=/, 'no environment content');
  // Both kinds of unknown at once: neither is hidden by the other.
  assert.match(scanBlocker({ ...unknown, indeterminate: unknown.indeterminate + 1 })!.message, /pid 104 ssh-agent.*and 1 more could not be identified at all/);
  // It ended too: quiet.
  await proc.remove(104);
  assert.equal(scanBlocker(await sessionWriters(100, [tag], '500', proc.root)), null);
  // A process list that cannot be read is its own code.
  assert.equal(scanBlocker(await sessionWriters(100, [tag], '500', join(proc.root, 'missing')))?.code, 'process_scan_incomplete');
});

// ---- R3-2: the supervisor with the fake stream-json Claude ----

const OPTIONS: Partial<SupervisorOptions> = { quiesceTimeoutMs: 12_000 };

async function launch(extra: Record<string, string>, options: Partial<SupervisorOptions> = {}): Promise<{ fx: Fixture; job: string }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  await setStreamMode(fx, 'tagged-writer-on-signal', extra);
  const job = 'job-handoff';
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx, { ...OPTIONS, ...options });
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  return { fx, job };
}

const status = async (fx: Fixture, job: string, wanted: (value: Awaited<ReturnType<ReturnType<typeof gateway>['status']>>) => boolean, what: string, timeoutMs = 25_000) => {
  let last = '';
  try {
    return await waitFor(async () => {
      const value = await gateway(fx).status(fx.app, job);
      last = `${value.status} ${value.job?.current_iteration} ${value.job?.diagnostic?.code} ${value.job?.diagnostic?.message}`;
      return wanted(value) ? value : undefined;
    }, what, timeoutMs);
  } catch (error) {
    throw new Error(`${(error as Error).message}; last seen: ${last}`);
  }
};

const events = async (fx: Fixture, job: string) => (JSON.parse(await readFile(join(jobDir(fx, job), 'managed.json'), 'utf8')) as { events: Array<{ event: string; detail: string | null }> }).events;

// Starts the silent tagged writer once, at a seam, and waits until it runs.
const startWriterOnce = (fx: () => Fixture, kind: 'review' | 'acceptance') => {
  let fired = false;
  return async (current: 'review' | 'acceptance') => {
    if (current !== kind || fired) return;
    fired = true;
    await writeFile(join(fx().fakeDir, 'writer-signal'), '');
    await new Promise((resolve) => setTimeout(resolve, 300));
  };
};

async function submit(fx: Fixture, job: string, kind: 'review' | 'acceptance'): Promise<string> {
  await status(fx, job, (value) => value.status === 'awaiting_review', 'awaiting_review');
  const gw = gateway(fx);
  const snap = await gw.snapshot(fx.app, job, 'iteration-001');
  const id = randomUUID();
  if (kind === 'review') await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: id, findings: [{ text: 'FAKE-EDIT notes.txt handed-over' }] });
  else await gw.accept({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, acceptance_id: id });
  return id;
}

for (const seam of ['beforeRequestCommit', 'afterRequestRecorded'] as const) {
  for (const kind of ['review', 'acceptance'] as const) {
    test(`a silent tagged writer started after the snapshot (at ${seam}) that writes later: the ${kind} is never handed over`, async () => {
      const holder: { fx?: Fixture } = {};
      const { fx, job } = await launch({ writerWrites: '1', writerSleep: '1.5' }, { [seam]: startWriterOnce(() => holder.fx!, kind) });
      holder.fx = fx;
      await submit(fx, job, kind);
      const ended = await status(fx, job, (value) => value.status === 'needs_inspection', 'needs_inspection');
      assert.match(`${ended.job?.diagnostic?.code} ${ended.job?.diagnostic?.message}`, /conflict.*tree_changed_after_publication/);
      const log = await events(fx, job);
      assert.ok(log.some((entry) => (entry.event === 'handoff_deferred' || entry.event === `${kind}_withdrawn`) && /session_writers/.test(entry.detail ?? '')), log.map((entry) => entry.event).join(','));
      assert.equal((await messages(fx)).length, 1, 'no review message reached Claude');
      if (kind === 'review') assert.ok(ended.job?.reviews.every((entry) => entry.outcome !== 'delivered' && entry.outcome !== 'sending'));
      else {
        assert.ok(ended.job?.acceptances.every((entry) => entry.outcome === 'rejected'));
        const execution = JSON.parse(await readFile(join(jobDir(fx, job), 'execution.json'), 'utf8')) as { state: string };
        assert.notEqual(execution.state, 'completed');
      }
      assert.equal((await invocations(fx)).length, 1);
    });
  }
}

test('positive: a tagged process that ends without writing defers the review until it ended; then it is delivered once', async () => {
  const holder: { fx?: Fixture } = {};
  const { fx, job } = await launch({ writerSleep: '1.5' }, { beforeRequestCommit: startWriterOnce(() => holder.fx!, 'review') });
  holder.fx = fx;
  const reviewId = await submit(fx, job, 'review');
  const next = await status(fx, job, (value) => value.job?.current_iteration === 'iteration-002' && value.status === 'awaiting_review', 'iteration-002');
  assert.deepEqual(next.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'delivered']]);
  assert.ok((await events(fx, job)).some((entry) => entry.event === 'handoff_deferred'));
  const done = await stat(join(fx.fakeDir, 'writer-done'));
  const received = await stat(join(fx.fakeDir, 'messages.jsonl'));
  assert.ok(done.mtimeMs <= received.mtimeMs, 'the review reached Claude only after the writer had ended');
  assert.equal((await messages(fx)).length, 2, 'delivered exactly once');
});

test('positive: no process of the session at the handoff: delivered without deferral', async () => {
  const { fx, job } = await launch({});
  const reviewId = await submit(fx, job, 'review');
  const next = await status(fx, job, (value) => value.job?.current_iteration === 'iteration-002' && value.status === 'awaiting_review', 'iteration-002');
  assert.deepEqual(next.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'delivered']]);
  assert.ok(!(await events(fx, job)).some((entry) => entry.event === 'handoff_deferred'));
});

test('an unattributable same-user process at the handoff: deferred and shown under its own code (bounded); once it is gone, delivered', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads any file');
  const proc = await fakeProc();
  const pid = 4_000_000;
  let fired = false;
  const { fx, job } = await launch({}, {
    procRoot: proc.root,
    quiesceTimeoutMs: 2500,
    beforeRequestCommit: async (kind) => {
      if (kind !== 'review' || fired) return;
      fired = true;
      await proc.add(pid, { ppid: 1, start: 1e12, name: 'unrelated', env: 'unreadable' });
    },
  });
  const reviewId = await submit(fx, job, 'review');
  const unstable = await status(fx, job, (value) => value.status === 'needs_operator' && value.job?.diagnostic?.code === 'boundary_unstable', 'boundary_unstable');
  assert.match(unstable.job!.diagnostic!.message, new RegExp(`pid ${pid} unrelated.*\\[unattributed_processes\\]`));
  assert.doesNotMatch(unstable.job!.diagnostic!.message, /FIXTURE_ONLY_VARIABLE|do-not-show/);
  assert.deepEqual(unstable.job?.reviews, [], 'the review stays pending: neither delivered nor rejected');
  assert.equal((await messages(fx)).length, 1);
  // The operator's recovery: the process is ended (here: it vanishes); the next quiet window hands it over.
  await proc.remove(pid);
  const next = await status(fx, job, (value) => value.job?.current_iteration === 'iteration-002' && value.status === 'awaiting_review', 'iteration-002');
  assert.deepEqual(next.job?.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'delivered']]);
  assert.equal((await messages(fx)).length, 2);
});
