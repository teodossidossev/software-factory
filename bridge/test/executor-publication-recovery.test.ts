// Initial publication recovery: a first snapshot that failed only because the bound on its wait ran
// out is published by the same live session and iteration once the blocker is gone. Deterministic:
// actual Supervisor/Gateway/records and disposable Git trees; in-memory streams, a fake process table
// and execution service. Every test has a bounded wait; no Claude process or OS gate is launched.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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
const { Supervisor } = await import('../src/executor/supervisor.js');
const { treeFingerprint } = await import('../src/executor/fingerprint.js');
const { acceptedJob, destroyFixture, git, jobDir } = await import('./support/operator-fixture.js');
const { authorize, createExecutorFixture, enableApp, gateway, waitFor } = await import('./support/executor-fixture.js');
type Fixture = Awaited<ReturnType<typeof createExecutorFixture>>;

const JOB = 'publication-recovery';
const BLOCKER = 4_000_001;
const SNAPSHOT = 'iteration-001.snapshot.json';
const FOREIGN = randomUUID();
const TIMEOUT_MS = 120;
// Long enough for many polls and for several recovery attempts if one were (wrongly) made.
const SETTLE_MS = 300;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Options {
  // The first turn's refused actions and failure.
  firstDenials?: unknown[];
  firstError?: boolean;
  // Whether the blocker is running when the first turn ends (default true).
  blocked?: boolean;
  beforeSnapshotCommit?: (calls: number) => Promise<void>;
  beforeReady?: () => Promise<void>;
}

async function start(fx: Fixture, options: Options = {}) {
  const accepted = await acceptedJob(fx, JOB);
  const sid = randomUUID();
  const input = new PassThrough();
  const output = new PassThrough();
  const baseline = await treeFingerprint(fx.appRepo);
  const sent: string[] = [];
  const ready: string[] = [];
  let launches = 0;
  let commits = 0;
  let resolveExit!: (exit: { code: number; signal: null }) => void;
  const child: ManagedProcess = { pid: process.pid, input, output, errors: new PassThrough(), exited: new Promise((resolve) => { resolveExit = resolve; }) };
  const emit = (event: Record<string, unknown>): void => { output.write(`${JSON.stringify({ session_id: sid, ...event })}\n`); };
  const result = (denials: unknown[] = [], isError = false): void => { emit({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, num_turns: 1, permission_denials: denials }); };
  const procRoot = join(fx.sandbox, 'recovery-proc');
  const blockerDir = join(procRoot, String(BLOCKER));
  await mkdir(join(procRoot, String(process.pid)), { recursive: true });
  const statFields = (ppid: number) => ['S', String(ppid), ...Array<string>(17).fill('0'), '1', '0', '0'].join(' ');
  await writeFile(join(procRoot, String(process.pid), 'stat'), `${process.pid} (controlled) ${statFields(1)}\n`);
  const block = async (): Promise<void> => {
    await mkdir(blockerDir, { recursive: true });
    await writeFile(join(blockerDir, 'environ'), 'PATH=/bin\0');
    await writeFile(join(blockerDir, 'stat'), `${BLOCKER} (blocker) ${statFields(process.pid)}\n`);
  };
  const release = (): Promise<void> => rm(blockerDir, { recursive: true, force: true });
  if (options.blocked !== false) {
    await block();
  }
  let work: Promise<void> = Promise.resolve();
  input.on('data', (raw: Buffer) => {
    const message = JSON.parse(raw.toString()) as { uuid: string; message: { content: Array<{ text: string }> } };
    sent.push(message.message.content.map((part) => part.text).join(''));
    const round = sent.length;
    work = work.then(async () => {
      emit({ type: 'user', uuid: message.uuid, message: message.message });
      emit({ type: 'system', subtype: 'init', permissionMode: 'auto' });
      await writeFile(join(fx.appRepo, 'README.md'), `round ${round}\n`);
      if (round === 1) {
        result(options.firstDenials, options.firstError);
      } else {
        result();
      }
    });
  });
  const control: ManagedControl = {
    repo: fx.appRepo,
    claimedSessionId: sid,
    current: () => ({ sessionId: sid, process: child }),
    inspect: async () => {
      const now = await treeFingerprint(fx.appRepo);
      return {
        baseline: { head: baseline.head, index_sha256: baseline.index_sha256 },
        head: now.head, index_sha256: now.index_sha256, git_changed: false, withheld: null,
        diff: git(fx.appRepo, 'diff', 'HEAD'), changed_paths: ['README.md'], new_files: [], commands: [], message: 'Done.',
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
  const supervisor = await Supervisor.start({
    mediatorRoot: fx.mediator,
    stateHome: fx.stateHome,
    service,
    pollMs: 10,
    retryMs: 100,
    quietMs: 20,
    quiesceTimeoutMs: TIMEOUT_MS,
    procRoot,
    beforeSnapshotCommit: async () => {
      commits += 1;
      await options.beforeSnapshotCommit?.(commits);
    },
    aroundPublishRecord: async (stage) => {
      if (stage === 'before') {
        await options.beforeReady?.();
      }
    },
    reviewReady: async (ref) => void ready.push(ref.snapshotSha256),
  });
  const done = supervisor.run();
  await authorize(fx, JOB, accepted, randomUUID());
  return {
    sid, sent, ready, emit, result, block, release,
    launches: () => launches,
    commits: () => commits,
    // The process's own end, as the stream sees it.
    exit: () => { output.end(); resolveExit({ code: 0, signal: null }); },
    stop: async () => { await supervisor.stop(); await done; await work; await supervisor.close(); },
  };
}

interface ManagedFile {
  state: string;
  revision: number;
  current_iteration: string;
  diagnostic: { code: string; message: string } | null;
  iterations: Array<{ id: string; state: string; snapshot: { sha256: string } | null; blocked_actions: Array<{ action: string; count: number }> }>;
  session: { process: string; current_session_id: string; lineage: Array<{ session_id: string; ended_at: string | null }> };
  reviews: Array<{ review_id: string; outcome: string }>;
  events: Array<{ event: string; detail: string | null }>;
}

const managedPath = (fx: Fixture): string => join(jobDir(fx, JOB), 'managed.json');
const managed = async (fx: Fixture): Promise<ManagedFile> => JSON.parse(await readFile(managedPath(fx), 'utf8')) as ManagedFile;
// A disputed record as one atomic change, as any writer of it makes it: the supervisor never reads half a file.
const dispute = async (fx: Fixture, record: ManagedFile): Promise<void> => {
  const path = join(fx.sandbox, 'disputed-managed.json');
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  await rename(path, managedPath(fx));
};
const count = (record: ManagedFile, event: string): number => record.events.filter((entry) => entry.event === event).length;
const hasSnapshot = async (fx: Fixture): Promise<boolean> => (await readdir(jobDir(fx, JOB))).includes(SNAPSHOT);

const failedFirst = (fx: Fixture): Promise<ManagedFile> =>
  waitFor(async () => {
    const record = await managed(fx);
    return record.diagnostic?.code === 'snapshot_failed' ? record : undefined;
  }, 'the first capture to fail');

const published = (fx: Fixture): Promise<ManagedFile> =>
  waitFor(async () => {
    const record = await managed(fx);
    return record.iterations[0]?.state === 'ready_for_review' ? record : undefined;
  }, 'the recovered snapshot');

type Running = Awaited<ReturnType<typeof start>>;

async function scenario(options: Options, body: (fx: Fixture, running: Running) => Promise<void>): Promise<void> {
  const fx = await createExecutorFixture();
  let running: Running | undefined;
  try {
    await enableApp(fx);
    running = await start(fx, options);
    await body(fx, running);
  } finally {
    await running?.stop();
    await destroyFixture(fx);
  }
}

test('a timeout followed by the blocker ending publishes once, in the same session and iteration', async () => {
  await scenario({}, async (fx, running) => {
    const failed = await failedFirst(fx);
    assert.equal(failed.state, 'needs_operator');
    assert.equal(failed.iterations[0]?.state, 'snapshot_failed');
    assert.match(failed.diagnostic!.message, /1 process\(es\) \(blocker\) started by the session still running/);
    await running.release();
    const record = await published(fx);
    assert.equal(record.state, 'awaiting_review');
    assert.equal(record.diagnostic, null);
    assert.equal(record.current_iteration, 'iteration-001');
    assert.equal(record.iterations.length, 1);
    await sleep(SETTLE_MS);
    const later = await managed(fx);
    assert.equal(count(later, 'snapshot_failed'), 1);
    assert.equal(count(later, 'iteration_ready'), 1);
    assert.equal(running.commits(), 1, 'one capture');
    assert.deepEqual(running.ready, [later.iterations[0]?.snapshot?.sha256], 'one review-ready event');
    const snapshot = await gateway(fx).snapshot(fx.app, JOB, 'iteration-001');
    assert.equal(snapshot.snapshot.session_id, running.sid);
    assert.equal(running.sent.length, 1, 'no message was invented');
    assert.equal(running.launches(), 1);
  });
});

test('while the blocker stays nothing is published, no capture runs and the record stays still', async () => {
  await scenario({}, async (fx, running) => {
    const failed = await failedFirst(fx);
    await sleep(TIMEOUT_MS + SETTLE_MS);
    const later = await managed(fx);
    assert.equal(later.revision, failed.revision, 'no busy writes');
    assert.equal(later.state, 'needs_operator');
    assert.deepEqual(later.diagnostic, failed.diagnostic, 'the real diagnostic stays');
    assert.equal(await hasSnapshot(fx), false);
    assert.equal(running.commits(), 0);
    assert.deepEqual(running.ready, []);
    assert.equal(running.sent.length, 1);
  });
});

test('after the session exited nothing is recovered: the ending stays honest', async () => {
  await scenario({}, async (fx, running) => {
    await failedFirst(fx);
    running.exit();
    const ended = await waitFor(async () => {
      const record = await managed(fx);
      return record.diagnostic?.code === 'session_exited' ? record : undefined;
    }, 'the session exit');
    await running.release();
    await sleep(SETTLE_MS);
    assert.equal(ended.iterations[0]?.state, 'snapshot_failed');
    assert.equal(await hasSnapshot(fx), false);
    assert.equal(running.commits(), 0);
    assert.deepEqual(running.ready, []);
  });
});

const OWNERSHIP: Array<[string, (record: ManagedFile) => void]> = [
  ['another current session', (record) => { record.session.current_session_id = randomUUID(); }],
  ['an ended lineage entry', (record) => { record.session.lineage[0]!.ended_at = new Date().toISOString(); }],
  ['a process no longer recorded as alive', (record) => { record.session.process = 'unconfirmed'; }],
];

for (const [name, tamper] of OWNERSHIP) {
  test(`ownership in doubt (${name}) stops the recovery, with the diagnostic kept`, async () => {
    await scenario({}, async (fx, running) => {
      const failed = await failedFirst(fx);
      const record = await managed(fx);
      tamper(record);
      await dispute(fx, record);
      await waitFor(async () => count(await managed(fx), 'publication_recovery_stopped') === 1, 'the recovery to stop');
      await running.release();
      await sleep(SETTLE_MS);
      const later = await managed(fx);
      assert.equal(later.state, 'needs_operator');
      assert.deepEqual(later.diagnostic, failed.diagnostic);
      assert.equal(await hasSnapshot(fx), false);
      assert.equal(running.commits(), 0);
      // Stopped stays stopped: activity, then a task and its real result, reach no ordinary path.
      running.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'more' }] } });
      await sleep(SETTLE_MS);
      running.emit({ type: 'system', subtype: 'task_started', task_id: 'after-stop' });
      await sleep(SETTLE_MS);
      running.emit({ type: 'system', subtype: 'task_notification', task_id: 'after-stop', status: 'completed' });
      running.result();
      await waitFor(async () => count(await managed(fx), 'publication_turn_unrecorded') === 1, 'the later turn end');
      await sleep(SETTLE_MS);
      const held = await managed(fx);
      assert.equal(held.iterations.length, 1, 'no continuation');
      assert.equal(held.current_iteration, 'iteration-001');
      assert.equal(held.state, 'needs_operator');
      assert.deepEqual(held.diagnostic, failed.diagnostic);
      assert.equal(await hasSnapshot(fx), false);
      assert.equal(running.commits(), 0);
      assert.deepEqual(running.ready, []);
      assert.equal(running.sent.length, 1);
    });
  });
}

const LATE_OWNERSHIP: Array<[string, (record: ManagedFile) => void, (record: ManagedFile) => boolean]> = [
  ['a process no longer recorded as alive', (record) => { record.session.process = 'unconfirmed'; }, (record) => record.session.process === 'unconfirmed'],
  ['another current session', (record) => { record.session.current_session_id = FOREIGN; }, (record) => record.session.current_session_id === FOREIGN],
  ['an iteration no longer owed', (record) => { record.iterations[0]!.state = 'abandoned'; }, (record) => record.iterations[0]?.state === 'abandoned'],
];

for (const stage of ['during the capture', 'right before ready'] as const) {
  for (const [name, tamper, intact] of LATE_OWNERSHIP) {
    test(`ownership lost ${stage} (${name}) publishes nothing and keeps the disputed state`, async () => {
      const holder: { fx?: Fixture } = {};
      const change = async (): Promise<void> => {
        const record = await managed(holder.fx!);
        tamper(record);
        await dispute(holder.fx!, record);
      };
      await scenario(stage === 'during the capture' ? { beforeSnapshotCommit: change } : { beforeReady: change }, async (fx, running) => {
        holder.fx = fx;
        const failed = await failedFirst(fx);
        await running.release();
        await waitFor(async () => count(await managed(fx), 'publication_recovery_stopped') === 1, 'the recovery to stop');
        await sleep(SETTLE_MS);
        const later = await managed(fx);
        assert.equal(intact(later), true, 'the disputed state was not overwritten');
        assert.equal(later.state, 'needs_operator');
        assert.deepEqual(later.diagnostic, failed.diagnostic);
        assert.equal(count(later, 'iteration_ready'), 0);
        assert.equal(later.iterations[0]?.snapshot, null);
        assert.equal(await hasSnapshot(fx), false, 'no unreferenced evidence stays');
        assert.deepEqual(running.ready, []);
        assert.equal(running.sent.length, 1);
      });
    });
  }
}

test('a stopped recovery still ends honestly with the session', async () => {
  await scenario({}, async (fx, running) => {
    await failedFirst(fx);
    const record = await managed(fx);
    record.session.process = 'unconfirmed';
    await dispute(fx, record);
    await waitFor(async () => count(await managed(fx), 'publication_recovery_stopped') === 1, 'the recovery to stop');
    running.exit();
    await waitFor(async () => (await managed(fx)).diagnostic?.code === 'session_exited', 'the session exit');
    assert.equal(await hasSnapshot(fx), false);
  });
});

test('a permanent capture failure of the first attempt is never retried', async () => {
  const failure = Object.assign(new Error('disk'), { code: 'EIO' });
  await scenario({ blocked: false, beforeSnapshotCommit: async () => { throw failure; } }, async (fx, running) => {
    const failed = await failedFirst(fx);
    assert.match(failed.diagnostic!.message, /could not be written \(EIO\)/);
    await sleep(SETTLE_MS);
    assert.equal(running.commits(), 1);
    assert.equal(await hasSnapshot(fx), false);
    assert.deepEqual(running.ready, []);
  });
});

test('a permanent capture failure during the recovery ends it with the new reason', async () => {
  const failure = Object.assign(new Error('disk'), { code: 'EIO' });
  await scenario({ beforeSnapshotCommit: async () => { throw failure; } }, async (fx, running) => {
    await failedFirst(fx);
    await running.release();
    await waitFor(async () => /could not be written \(EIO\)/.test((await managed(fx)).diagnostic?.message ?? ''), 'the permanent failure');
    await sleep(SETTLE_MS);
    assert.equal(running.commits(), 1);
    assert.equal((await managed(fx)).state, 'needs_operator');
    assert.equal(await hasSnapshot(fx), false);
  });
});

test('a tree change during the recovered capture needs a complete new boundary', async () => {
  const holder: { fx?: Fixture } = {};
  const beforeSnapshotCommit = async (calls: number): Promise<void> => {
    if (calls === 1) {
      await appendFile(join(holder.fx!.appRepo, 'README.md'), 'written during the capture\n');
    }
  };
  await scenario({ beforeSnapshotCommit }, async (fx, running) => {
    holder.fx = fx;
    await failedFirst(fx);
    await running.release();
    await published(fx);
    assert.equal(running.commits(), 2, 'the first capture was discarded');
    const snapshot = await gateway(fx).snapshot(fx.app, JOB, 'iteration-001');
    assert.equal(snapshot.snapshot.current.tree_fingerprint, (await treeFingerprint(fx.appRepo)).value);
  });
});

test('output during the recovered capture needs a complete new boundary', async () => {
  const holder: { running?: Running } = {};
  const beforeSnapshotCommit = async (calls: number): Promise<void> => {
    if (calls === 1) {
      holder.running!.emit({ type: 'system', subtype: 'hook_response' });
      await sleep(30);
    }
  };
  await scenario({ beforeSnapshotCommit }, async (fx, running) => {
    holder.running = running;
    await failedFirst(fx);
    await running.release();
    await published(fx);
    assert.equal(running.commits(), 2);
    assert.equal(count(await managed(fx), 'iteration_ready'), 1);
  });
});

test('a task opened while blocked keeps the iteration; publication waits for its real turn end', async () => {
  await scenario({}, async (fx, running) => {
    await failedFirst(fx);
    running.emit({ type: 'system', subtype: 'task_started', task_id: 'late-task' });
    await running.release();
    await sleep(SETTLE_MS);
    const waiting = await managed(fx);
    assert.equal(waiting.current_iteration, 'iteration-001', 'no continuation was opened');
    assert.equal(waiting.state, 'needs_operator');
    assert.equal(waiting.diagnostic?.code, 'snapshot_failed');
    assert.equal(await hasSnapshot(fx), false);
    running.emit({ type: 'system', subtype: 'task_notification', task_id: 'late-task', status: 'completed' });
    await sleep(SETTLE_MS);
    assert.equal(await hasSnapshot(fx), false, 'a finished task is not a turn end');
    running.result();
    const record = await published(fx);
    assert.equal(record.iterations.length, 1);
    assert.equal(count(record, 'iteration_ready'), 1);
    assert.equal(running.sent.length, 1);
  });
});

test('quiet that cannot be reached times out again without another failure event, then publishes once', async () => {
  await scenario({}, async (fx, running) => {
    const failed = await failedFirst(fx);
    await running.release();
    const chatter = setInterval(() => running.emit({ type: 'system', subtype: 'hook_response' }), 2);
    try {
      await waitFor(async () => /kept producing output/.test((await managed(fx)).diagnostic?.message ?? ''), 'the repeated timeout');
      await sleep(TIMEOUT_MS * 2);
    } finally {
      clearInterval(chatter);
    }
    const blocked = await managed(fx);
    assert.equal(blocked.state, 'needs_operator');
    assert.equal(count(blocked, 'snapshot_failed'), 1, 'a repeated timeout is no new failure');
    assert.equal(blocked.diagnostic?.code, 'snapshot_failed');
    assert.equal(count(blocked, 'snapshot_waiting'), count(failed, 'snapshot_waiting'), 'the recovery does not replace the diagnostic');
    const record = await published(fx);
    assert.equal(record.state, 'awaiting_review');
    assert.equal(running.commits(), 1);
    assert.equal(count(record, 'iteration_ready'), 1);
  });
});

test('refused actions and a failed turn survive the recovery, also across a later turn end', async () => {
  const push = { tool_name: 'Bash', tool_use_id: 'd1', tool_input: { command: 'git push origin main' } };
  const commit = { tool_name: 'Bash', tool_use_id: 'd2', tool_input: { command: 'git commit -am x' } };
  await scenario({ firstDenials: [push], firstError: true }, async (fx, running) => {
    const failed = await failedFirst(fx);
    assert.deepEqual(failed.iterations[0]?.blocked_actions, [{ action: 'Bash(git push)', count: 1 }]);
    running.result([commit]);
    await waitFor(async () => (await managed(fx)).iterations[0]?.blocked_actions.length === 2, 'the later refusal');
    await running.release();
    const record = await published(fx);
    assert.equal(record.state, 'needs_operator');
    assert.equal(record.diagnostic?.code, 'auto_mode_refused');
    assert.equal(record.iterations.length, 1);
    const snapshot = await gateway(fx).snapshot(fx.app, JOB, 'iteration-001');
    assert.deepEqual(snapshot.snapshot.blocked_actions, [{ action: 'Bash(git push)', count: 1 }, { action: 'Bash(git commit)', count: 1 }]);
    assert.deepEqual(snapshot.snapshot.turn, { subtype: 'error_during_execution', is_error: true, num_turns: 1 });
    assert.equal(running.sent.length, 1);
  });
});

test('a review bound to the recovered snapshot reaches the same session once; the evidence stays immutable', async () => {
  await scenario({}, async (fx, running) => {
    await failedFirst(fx);
    await running.release();
    await published(fx);
    const original = await readFile(join(jobDir(fx, JOB), SNAPSHOT));
    const gw = gateway(fx);
    const snapshot = await gw.snapshot(fx.app, JOB, 'iteration-001');
    const reviewId = randomUUID();
    await gw.submitReview({ app_id: fx.app, job_id: JOB, iteration_id: 'iteration-001', snapshot_sha256: snapshot.snapshot_sha256, review_id: reviewId, findings: [{ text: 'Correct this.' }] });
    const record = await waitFor(async () => {
      const value = await managed(fx);
      return value.iterations[1]?.state === 'ready_for_review' ? value : undefined;
    }, 'the reviewed iteration');
    await sleep(SETTLE_MS);
    assert.deepEqual(record.reviews.map((entry) => [entry.review_id, entry.outcome]), [[reviewId, 'delivered']]);
    assert.equal(running.sent.length, 2);
    assert.match(running.sent[1] as string, new RegExp(reviewId));
    assert.equal(running.launches(), 1);
    assert.equal(record.session.current_session_id, running.sid);
    assert.equal(running.ready.length, 2);
    assert.deepEqual(await readFile(join(jobDir(fx, JOB), SNAPSHOT)), original);
  });
});
