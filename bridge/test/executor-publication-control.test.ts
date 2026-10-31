// Deterministic publication tests: actual Supervisor/Gateway/records and disposable Git trees;
// in-memory streams, execution service and lock seams. No Claude process or OS gate is launched.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import type { ExecutionService, ManagedControl } from '../src/execution/service.js';
import type { ManagedProcess } from '../src/execution/runner.js';

const identity = await import('../src/execution/process-identity.js');
const locks = new Set<string>();
mock.module(new URL('../src/execution/process-identity.js', import.meta.url).href, {
  namedExports: {
    ...identity,
    acquireLock: async (dir: string): Promise<() => Promise<void>> => {
      assert.ok(!locks.has(dir), 'test lock must be exclusive');
      locks.add(dir);
      return async () => { locks.delete(dir); };
    },
  },
});
const fingerprintModule = await import('../src/executor/fingerprint.js');
mock.module(new URL('../src/executor/fingerprint.js', import.meta.url).href, {
  namedExports: {
    ...fingerprintModule,
    // This in-memory child has no OS descendants. Real process checks belong to the subprocess tests.
    descendants: async (pid: number): Promise<number[]> => {
      assert.equal(pid, process.pid);
      return [];
    },
  },
});
const { Supervisor } = await import('../src/executor/supervisor.js');
const { treeFingerprint } = await import('../src/executor/fingerprint.js');
const { acceptedJob, destroyFixture, git, jobDir } = await import('./support/operator-fixture.js');
const { authorize, createExecutorFixture, enableApp, gateway, waitFor } = await import('./support/executor-fixture.js');
type Fixture = Awaited<ReturnType<typeof createExecutorFixture>>;

async function harness(fx: Fixture, job: string, tasksAtStart: boolean, beforeSnapshotCommit?: () => Promise<void>) {
  const sid = randomUUID();
  const input = new PassThrough();
  const output = new PassThrough();
  const baseline = await treeFingerprint(fx.appRepo);
  const sent: string[] = [];
  let launches = 0;
  let resolveExit!: (exit: { code: number; signal: null }) => void;
  const child: ManagedProcess = { pid: process.pid, input, output, errors: new PassThrough(), exited: new Promise((resolve) => { resolveExit = resolve; }) };
  const emit = (event: Record<string, unknown>): void => { output.write(`${JSON.stringify({ session_id: sid, ...event })}\n`); };
  const result = (denials: unknown[] = [], isError = false): void => { emit({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, num_turns: 1, permission_denials: denials }); };
  const begin = (): void => {
    emit({ type: 'system', subtype: 'task_started', task_id: 'review-a' });
    emit({ type: 'system', subtype: 'task_started', task_id: 'review-b' });
  };
  const finish = async (): Promise<void> => {
    await mkdir(join(fx.appRepo, 'review05'), { recursive: true });
    await writeFile(join(fx.appRepo, 'review05', 'tests.log'), 'checks passed\n');
    emit({ type: 'system', subtype: 'task_updated', task_id: 'review-a', patch: { status: 'completed' } });
    emit({ type: 'system', subtype: 'task_notification', task_id: 'review-b', status: 'completed' });
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    result();
  };
  let work: Promise<void> = Promise.resolve();
  input.on('data', (raw: Buffer) => {
    const message = JSON.parse(raw.toString()) as { uuid: string; message: { content: Array<{ text: string }> } };
    sent.push(message.message.content.map((part) => part.text).join(''));
    work = work.then(async () => {
      emit({ type: 'user', uuid: message.uuid, message: message.message });
      emit({ type: 'system', subtype: 'init', permissionMode: 'auto' });
      await writeFile(join(fx.appRepo, 'README.md'), `round ${sent.length}\n`);
      if (sent.length === 1 && tasksAtStart) { begin(); }
      result();
    });
  });
  const control: ManagedControl = {
    repo: fx.appRepo,
    claimedSessionId: sid,
    current: () => ({ sessionId: sid, process: child }),
    inspect: async () => {
      const now = await treeFingerprint(fx.appRepo);
      const complete = (await readdir(fx.appRepo)).includes('review05');
      return {
        baseline: { head: baseline.head, index_sha256: baseline.index_sha256 },
        head: now.head, index_sha256: now.index_sha256, git_changed: false, withheld: null,
        diff: git(fx.appRepo, 'diff', 'HEAD') + (complete ? '\nreview05/tests.log: checks passed\n' : ''),
        changed_paths: complete ? ['README.md', 'review05/tests.log'] : ['README.md'],
        new_files: [], commands: [], message: complete ? 'Package finalized.' : 'Reviewers running.',
      };
    },
    replace: async () => { throw new Error('reset is outside this fixture'); },
    writeAdapterFile: async () => { throw new Error('context is outside this fixture'); },
  };
  const service = {
    preflight: async () => ({ ready: true, state: 'accepted', checks: [] }),
    prepare: async () => undefined,
    runManaged: async (_app: string, _job: string, _expected: unknown, drive: (control: ManagedControl) => Promise<{ kind: string }>) => {
      launches += 1;
      const ending = await drive(control);
      input.end();
      output.end();
      resolveExit({ code: 0, signal: null });
      return { state: ending.kind === 'accepted' ? 'completed' : 'failed', error: null };
    },
    status: async () => undefined,
    collect: async () => undefined,
  } as unknown as Pick<ExecutionService, 'preflight' | 'prepare' | 'runManaged' | 'status' | 'collect'>;
  const procRoot = join(fx.sandbox, 'publication-proc');
  await mkdir(join(procRoot, String(process.pid)), { recursive: true });
  const fields = ['S', '1', ...Array<string>(17).fill('0'), '1', '0', '0'];
  await writeFile(join(procRoot, String(process.pid), 'stat'), `${process.pid} (controlled) ${fields.join(' ')}\n`);
  const supervisor = await Supervisor.start({ mediatorRoot: fx.mediator, stateHome: fx.stateHome, service, pollMs: 10, retryMs: 100, quietMs: 10, quiesceTimeoutMs: 15000, procRoot, ...(beforeSnapshotCommit ? { beforeSnapshotCommit } : {}) });
  const done = supervisor.run();
  return { begin, finish, result, sent, sid, launches: () => launches, stop: async () => { await supervisor.stop(); await done; await work; await supervisor.close(); } };
}

test('active reviewers prevent publication; completed artifacts and feedback stay in one session', async () => {
  const fx = await createExecutorFixture();
  const job = 'controlled-tasks';
  let running: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await enableApp(fx);
    const accepted = await acceptedJob(fx, job);
    const head = git(fx.appRepo, 'rev-parse', 'HEAD');
    const index = await readFile(join(fx.appRepo, '.git', 'index'));
    running = await harness(fx, job, true);
    await authorize(fx, job, accepted, randomUUID());
    await waitFor(async () => running!.sent.length === 1, 'first prompt');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const gw = gateway(fx);
    assert.equal((await gw.status(fx.app, job)).status, 'running');
    assert.deepEqual((await gw.listReviewReady(fx.app)).ready, []);
    assert.ok(!(await readdir(jobDir(fx, job))).includes('iteration-001.snapshot.json'));
    await running.finish();
    await waitFor(async () => (await gw.status(fx.app, job)).status === 'awaiting_review', 'final result');
    const first = await gw.snapshot(fx.app, job, 'iteration-001');
    assert.match(await readFile(join(fx.mediator, first.diff.path), 'utf8'), /review05\/tests.log/);
    await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: first.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'Complete the focused correction.' }] });
    await waitFor(async () => (await gw.status(fx.app, job)).job?.current_iteration === 'iteration-002' && (await gw.status(fx.app, job)).status === 'awaiting_review', 'review delivered');
    assert.equal(running.launches(), 1);
    assert.equal(running.sent.length, 2);
    assert.equal((await gw.status(fx.app, job)).job?.current_session_id, running.sid);
    assert.equal(git(fx.appRepo, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(await readFile(join(fx.appRepo, '.git', 'index')), index);
  } finally {
    await running?.stop();
    await destroyFixture(fx);
  }
});

test('a result received while awaiting review advances the immutable snapshot without another prompt', async () => {
  const fx = await createExecutorFixture();
  const job = 'controlled-late';
  let running: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await enableApp(fx);
    const accepted = await acceptedJob(fx, job);
    running = await harness(fx, job, false);
    await authorize(fx, job, accepted, randomUUID());
    const gw = gateway(fx);
    await waitFor(async () => (await gw.status(fx.app, job)).status === 'awaiting_review', 'first snapshot');
    const original = await readFile(join(jobDir(fx, job), 'iteration-001.snapshot.json'));
    running.begin();
    await waitFor(async () => (await gw.status(fx.app, job)).status === 'running', 'late work observed');
    assert.deepEqual((await gw.listReviewReady(fx.app)).ready, []);
    await running.finish();
    await waitFor(async () => (await gw.status(fx.app, job)).job?.current_iteration === 'iteration-002' && (await gw.status(fx.app, job)).status === 'awaiting_review', 'late package');
    const latest = await gw.snapshot(fx.app, job, 'iteration-002');
    assert.match(await readFile(join(fx.mediator, latest.diff.path), 'utf8'), /review05\/tests.log/);
    assert.deepEqual(await readFile(join(jobDir(fx, job), 'iteration-001.snapshot.json')), original);
    assert.equal(running.launches(), 1);
    assert.equal(running.sent.length, 1);
  } finally {
    await running?.stop();
    await destroyFixture(fx);
  }
});

test('work started during snapshot commit withholds publication until a later complete result', async () => {
  const fx = await createExecutorFixture();
  const job = 'controlled-commit';
  let running: Awaited<ReturnType<typeof harness>> | undefined;
  let interrupted = false;
  try {
    await enableApp(fx);
    const accepted = await acceptedJob(fx, job);
    running = await harness(fx, job, false, async () => {
      if (!interrupted) {
        interrupted = true;
        running!.begin();
      }
    });
    await authorize(fx, job, accepted, randomUUID());
    await waitFor(async () => interrupted, 'capture interrupted');
    const gw = gateway(fx);
    assert.equal((await gw.status(fx.app, job)).status, 'running');
    assert.deepEqual((await gw.listReviewReady(fx.app)).ready, []);
    assert.ok(!(await readdir(jobDir(fx, job))).includes('iteration-001.snapshot.json'));
    await running.finish();
    await waitFor(async () => (await gw.status(fx.app, job)).status === 'awaiting_review', 'stable capture');
    const snapshot = await gw.snapshot(fx.app, job, 'iteration-001');
    assert.match(await readFile(join(fx.mediator, snapshot.diff.path), 'utf8'), /review05\/tests.log/);
    assert.equal(running.launches(), 1);
  } finally {
    await running?.stop();
    await destroyFixture(fx);
  }
});

test('a permission denial in an intermediate result survives the final package result', async () => {
  const fx = await createExecutorFixture();
  const job = 'controlled-denials';
  let running: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await enableApp(fx);
    const accepted = await acceptedJob(fx, job);
    running = await harness(fx, job, true);
    await authorize(fx, job, accepted, randomUUID());
    await waitFor(async () => running!.sent.length === 1, 'first prompt');
    await new Promise((resolve) => setTimeout(resolve, 100));
    running.result([{ tool_name: 'Write', tool_input: { file_path: '/secret-path' } }]);
    await running.finish();
    const gw = gateway(fx);
    await waitFor(async () => (await gw.status(fx.app, job)).status === 'needs_operator', 'denial retained');
    const snapshot = await gw.snapshot(fx.app, job, 'iteration-001');
    assert.deepEqual(snapshot.snapshot.blocked_actions, [{ action: 'Write', count: 1 }]);
    assert.ok(!JSON.stringify(snapshot).includes('/secret-path'));
    running.begin();
    await waitFor(async () => (await gw.status(fx.app, job)).status === 'running', 'denied round continues');
    await running.finish();
    await waitFor(async () => (await gw.status(fx.app, job)).status === 'needs_operator', 'denial survives continuation');
    const continued = await gw.snapshot(fx.app, job, 'iteration-002');
    assert.deepEqual(continued.snapshot.blocked_actions, snapshot.snapshot.blocked_actions);
  } finally {
    await running?.stop();
    await destroyFixture(fx);
  }
});

test('a damaged published artifact remains a conflict when new work opens a continuation', async () => {
  const fx = await createExecutorFixture();
  const job = 'damaged-before-continuation';
  let running: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await enableApp(fx);
    const accepted = await acceptedJob(fx, job);
    running = await harness(fx, job, false);
    await authorize(fx, job, accepted, randomUUID());
    const gw = gateway(fx);
    await waitFor(async () => (await gw.status(fx.app, job)).status === 'awaiting_review', 'initial snapshot');
    await writeFile(join(jobDir(fx, job), 'iteration-001.diff'), 'not the verified artifact\n');
    running.begin();
    const ended = await waitFor(async () => {
      const value = await gw.status(fx.app, job);
      return value.status === 'needs_inspection' ? value : undefined;
    }, 'artifact conflict');
    assert.equal(ended.job?.diagnostic?.code, 'conflict');
    assert.equal(ended.job?.iterations.length, 1, 'corrupted immutable evidence cannot be superseded silently');
    assert.equal(ended.job?.session_process, 'ended');
    assert.equal(running.launches(), 1);
  } finally {
    await running?.stop();
    await destroyFixture(fx);
  }
});

for (const variant of [
  { name: 'refused action', denials: [{ tool_name: 'Write' }], isError: false, code: 'late_turn_refused', reason: 'late_refused_actions' },
  { name: 'failed turn', denials: [], isError: true, code: 'late_turn_error', reason: 'late_turn_error' },
]) {
  test('an unchanged late ' + variant.name + ' blocks acceptance and still permits one review in the same session', async () => {
    const fx = await createExecutorFixture();
    const job = variant.isError ? 'late-error-audit' : 'late-denial-audit';
    let running: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      await enableApp(fx);
      const accepted = await acceptedJob(fx, job);
      running = await harness(fx, job, false);
      await authorize(fx, job, accepted, randomUUID());
      const gw = gateway(fx);
      await waitFor(async () => (await gw.status(fx.app, job)).status === 'awaiting_review', 'initial snapshot');
      const first = await gw.snapshot(fx.app, job, 'iteration-001');
      running.result(variant.denials, variant.isError);
      await waitFor(async () => (await gw.status(fx.app, job)).job?.diagnostic?.code === variant.code, 'late outcome audited');
      assert.equal((await gw.status(fx.app, job)).job?.current_iteration, 'iteration-001');
      const acceptanceId = randomUUID();
      await gw.accept({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: first.snapshot_sha256, acceptance_id: acceptanceId });
      const refused = await waitFor(async () => {
        const value = await gw.status(fx.app, job);
        return value.job?.acceptances.some((entry) => entry.acceptance_id === acceptanceId) ? value : undefined;
      }, 'acceptance rejected');
      assert.equal(refused.job?.acceptances.at(-1)?.outcome, 'rejected');
      assert.equal(refused.job?.acceptances.at(-1)?.reason, variant.reason);
      assert.equal(refused.job?.session_process, 'alive');
      await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: first.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'Address the late outcome.' }] });
      const corrected = await waitFor(async () => {
        const value = await gw.status(fx.app, job);
        return value.job?.current_iteration === 'iteration-002' && value.status === 'awaiting_review' ? value : undefined;
      }, 'review result');
      assert.deepEqual(corrected.job?.reviews.map((entry) => entry.outcome), ['delivered']);
      assert.equal(running.launches(), 1);
      assert.equal(running.sent.length, 2);
      assert.equal(corrected.job?.current_session_id, running.sid);
    } finally {
      await running?.stop();
      await destroyFixture(fx);
    }
  });

  test('a late ' + variant.name + ' survives subsequent work and an immutable continuation', async () => {
    const fx = await createExecutorFixture();
    const job = variant.isError ? 'carry-late-error' : 'carry-late-denial';
    let running: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      await enableApp(fx);
      const accepted = await acceptedJob(fx, job);
      running = await harness(fx, job, false);
      await authorize(fx, job, accepted, randomUUID());
      const gw = gateway(fx);
      await waitFor(async () => (await gw.status(fx.app, job)).status === 'awaiting_review', 'initial snapshot');
      const original = await readFile(join(jobDir(fx, job), 'iteration-001.snapshot.json'));
      running.result(variant.denials, variant.isError);
      await waitFor(async () => (await gw.status(fx.app, job)).job?.diagnostic?.code === variant.code, 'late outcome audited');
      running.begin();
      await waitFor(async () => (await gw.status(fx.app, job)).status === 'running', 'continuation opened');
      await running.finish();
      const current = await waitFor(async () => {
        const value = await gw.status(fx.app, job);
        return value.job?.current_iteration === 'iteration-002' && value.status === 'needs_operator' ? value : undefined;
      }, 'continuation retains the late outcome');
      if (variant.isError) {
        assert.equal(current.job?.diagnostic?.code, 'late_turn_error');
      } else {
        const snapshot = await gw.snapshot(fx.app, job, 'iteration-002');
        assert.deepEqual(snapshot.snapshot.blocked_actions, [{ action: 'Write', count: 1 }]);
      }
      assert.deepEqual(await readFile(join(jobDir(fx, job), 'iteration-001.snapshot.json')), original);
      assert.equal(running.launches(), 1);
      assert.equal(running.sent.length, 1);
    } finally {
      await running?.stop();
      await destroyFixture(fx);
    }
  });
}
