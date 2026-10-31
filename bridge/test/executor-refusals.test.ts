// SF-009: a pending job is refused safely: no opt-in, no supervisor, a disallowed app, a changed
// instruction, a dirty repository, an occupied session gate, an expired, forged or replayed
// authorization, or a Claude Code without auto mode. Nothing is claimed or started by a refusal.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { SessionGate } from '../src/execution/session-gate.js';
import { ExecutorState } from '../src/executor/policy.js';
import { Supervisor } from '../src/executor/supervisor.js';
import { acceptedJob, destroyFixture, gatePath, invocations, jobDir, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, managedService, setStreamMode, startSupervisor, waitFor } from './support/executor-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

async function fixture(enable = true): Promise<Fixture> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  if (enable) await enableApp(fx);
  return fx;
}

async function supervisor(fx: Fixture): Promise<void> {
  const running = await startSupervisor(fx);
  cleanup.push(running.stop);
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

const stateOf = async (fx: Fixture, job: string, wanted: string, diagnostic?: RegExp) =>
  waitFor(async () => {
    const status = await gateway(fx).status(fx.app, job);
    return status.status === wanted && (diagnostic === undefined || diagnostic.test(`${status.job?.diagnostic?.code} ${status.job?.diagnostic?.message}`)) ? status : undefined;
  }, `${job} ${wanted}${diagnostic ? ` ${diagnostic}` : ''}`);

// flock(1) holding the fixture's gate; its child (sleep) inherits the lock, so the whole group is ended.
function holdGate(fx: Fixture): { release: () => void } {
  const child: ChildProcess = spawn('flock', ['--nonblock', gatePath(fx), 'sleep', '60'], { stdio: 'ignore', detached: true });
  const release = () => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      // Already gone.
    }
  };
  cleanup.push(async () => release());
  return { release };
}

const exists = (path: string) => readFile(path).then(() => true, () => false);

test('without the operator opt-in nothing can be authorized and no supervisor starts', async () => {
  const fx = await fixture(false);
  const accepted = await acceptedJob(fx, 'job-a');
  const gw = gateway(fx);
  const status = await gw.status(fx.app, 'job-a');
  assert.equal(status.status, 'not_authorized');
  assert.equal(status.policy, null);
  assert.match(status.note, /opt in/);
  const input = { app_id: fx.app, job_id: 'job-a', request_id: accepted.requestId, instruction_sha256: accepted.sha, repo_identity: 'a'.repeat(64), permission_mode: 'auto' as const, policy_epoch: 1, authorization_id: randomUUID() };
  assert.equal(await code(gw.authorize(input)), 'conflict');
  assert.equal(await exists(join(jobDir(fx, 'job-a'), 'authorization.json')), false);
  assert.equal(await code(Supervisor.start({ mediatorRoot: fx.mediator, stateHome: fx.stateHome, service: managedService(fx) })), 'not_ready');
});

test('an authorization without a running supervisor is reported as needing the operator, never as started', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-b');
  await authorize(fx, 'job-b', accepted, randomUUID());
  const status = await gateway(fx).status(fx.app, 'job-b');
  assert.equal(status.status, 'needs_operator');
  assert.equal(status.supervisor.online, false);
  assert.match(status.note, /supervisor is not running/);
  assert.equal((await invocations(fx)).length, 0);
});

test('authorize checks the accepted dispatch, the hash, the repository identity, the epoch and replays', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-c');
  const gw = gateway(fx);
  const view = (await gw.status(fx.app, 'job-c')).policy!;
  const base = { app_id: fx.app, job_id: 'job-c', request_id: accepted.requestId, instruction_sha256: accepted.sha, repo_identity: view.repo_identity!, permission_mode: 'auto' as const, policy_epoch: view.policy_epoch, authorization_id: randomUUID() };
  assert.equal(await code(gw.authorize({ ...base, instruction_sha256: 'b'.repeat(64) })), 'sha256_mismatch');
  assert.equal(await code(gw.authorize({ ...base, request_id: randomUUID() })), 'dispatch_conflict');
  assert.equal(await code(gw.authorize({ ...base, repo_identity: 'c'.repeat(64) })), 'conflict');
  assert.equal(await code(gw.authorize({ ...base, policy_epoch: view.policy_epoch + 1 })), 'conflict');
  assert.equal(await code(gw.authorize({ ...base, permission_mode: 'manual' as never })), 'invalid_content');
  assert.equal(await code(gw.authorize({ ...base, job_id: 'job-none' })), 'not_found');
  const first = await gw.authorize(base);
  assert.equal(first.replayed, false);
  assert.equal(first.status, 'needs_operator');
  assert.equal((await gw.authorize(base)).replayed, true);
  assert.equal(await code(gw.authorize({ ...base, authorization_id: randomUUID() })), 'conflict');
});

test('a dirty repository blocks without consuming; the still valid authorization launches once it is clean', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-d');
  await writeFile(join(fx.appRepo, 'stray.txt'), 'uncommitted\n');
  await supervisor(fx);
  const auth = await authorize(fx, 'job-d', accepted, randomUUID());
  await stateOf(fx, 'job-d', 'blocked', /repo_dirty/);
  assert.equal((await invocations(fx)).length, 0);
  assert.equal(await exists(join(fx.stateHome, 'software-factory', 'executor', 'consumed', auth.authorization_id)), false);
  assert.equal(await exists(join(jobDir(fx, 'job-d'), 'launch.claim')), false);
  await rm(join(fx.appRepo, 'stray.txt'));
  await stateOf(fx, 'job-d', 'awaiting_review');
  assert.equal((await invocations(fx)).length, 1);
});

test('an instruction changed after authorization blocks the launch', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-e');
  await authorize(fx, 'job-e', accepted, randomUUID());
  await appendFile(join(jobDir(fx, 'job-e'), 'instruction.md'), 'injected\n');
  await supervisor(fx);
  await stateOf(fx, 'job-e', 'blocked', /instruction_mismatch/);
  assert.equal((await invocations(fx)).length, 0);
});

test('an app withdrawn from the opt-in, or a new policy epoch, blocks a pending authorization', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-f');
  await authorize(fx, 'job-f', accepted, randomUUID());
  const state = await ExecutorState.open(fx.stateHome, fx.mediator);
  await state.disable(fx.app);
  await state.enable(fx.app, { executable: join(fx.fakeDir, 'claude-stream'), version: 'fake 0.0.0' }, [], new Date(), 'disposable_pilot');
  await supervisor(fx);
  await stateOf(fx, 'job-f', 'blocked', /stale_policy/);
  await state.disable(fx.app);
  const second = await acceptedJob(fx, 'job-f2');
  assert.equal(await code(authorize(fx, 'job-f2', second, randomUUID())), 'Error: no policy view');
  assert.equal((await invocations(fx)).length, 0);
});

test('an occupied session gate queues the job; it launches when the gate clears while still valid', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-g');
  await new SessionGate(gatePath(fx)).ensure();
  const holder = holdGate(fx);
  await waitFor(async () => (await new SessionGate(gatePath(fx)).holders()).length > 0, 'gate held');
  await supervisor(fx);
  await authorize(fx, 'job-g', accepted, randomUUID());
  const queued = await stateOf(fx, 'job-g', 'queued', /session_busy/);
  assert.match(queued.note, /nothing claimed or started/);
  assert.equal((await invocations(fx)).length, 0);
  assert.equal(await exists(join(jobDir(fx, 'job-g'), 'launch.claim')), false);
  holder.release();
  await stateOf(fx, 'job-g', 'awaiting_review');
  assert.equal((await invocations(fx)).length, 1);
});

test('an authorization that expires while the gate is busy never launches', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-h');
  await new SessionGate(gatePath(fx)).ensure();
  const holder = holdGate(fx);
  await waitFor(async () => (await new SessionGate(gatePath(fx)).holders()).length > 0, 'gate held');
  // Issued as if 29 min 58 s ago: it expires about 2 s from now.
  const view = (await gateway(fx).status(fx.app, 'job-h')).policy!;
  await gateway(fx, () => new Date(Date.now() - 30 * 60 * 1000 + 2000)).authorize({
    app_id: fx.app, job_id: 'job-h', request_id: accepted.requestId, instruction_sha256: accepted.sha,
    repo_identity: view.repo_identity!, permission_mode: 'auto', policy_epoch: view.policy_epoch, authorization_id: randomUUID(),
  });
  await supervisor(fx);
  await stateOf(fx, 'job-h', 'queued');
  await stateOf(fx, 'job-h', 'blocked', /authorization_expired/);
  holder.release();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await gateway(fx).status(fx.app, 'job-h')).status, 'blocked');
  assert.equal((await invocations(fx)).length, 0);
});

test('forged authorization files are not acted on', async () => {
  const fx = await fixture();
  await supervisor(fx);
  const forge = async (job: string, change: (record: Record<string, unknown>) => void, mode = 0o600) => {
    const accepted = await acceptedJob(fx, job);
    const policy = (await gateway(fx).status(fx.app, job)).policy!;
    const record: Record<string, unknown> = {
      schema: 'software-factory.execution-authorization/v1', authorization_id: randomUUID(), app_id: fx.app, job_id: job,
      request_id: accepted.requestId, instruction_sha256: accepted.sha, repo_identity: policy.repo_identity, permission_mode: 'auto',
      policy_epoch: policy.policy_epoch, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(),
      issuer: 'mcp:factory_authorize_execution',
    };
    change(record);
    await writeFile(join(jobDir(fx, job), 'authorization.json'), JSON.stringify(record), { mode });
    await chmod(join(jobDir(fx, job), 'authorization.json'), mode);
  };
  await forge('job-i1', (record) => (record.repo_identity = 'd'.repeat(64)));
  await forge('job-i2', (record) => (record.permission_mode = 'bypassPermissions'));
  await forge('job-i3', () => undefined, 0o660);
  await forge('job-i4', (record) => (record.job_id = 'job-other'));
  // A symlink to a file outside the job directory (here: a copy of a valid authorization of job-i1's shape).
  await acceptedJob(fx, 'job-i5');
  await writeFile(join(fx.sandbox, 'elsewhere.json'), await readFile(join(jobDir(fx, 'job-i1'), 'authorization.json')));
  await symlink(join(fx.sandbox, 'elsewhere.json'), join(jobDir(fx, 'job-i5'), 'authorization.json'));
  await stateOf(fx, 'job-i1', 'blocked', /repo_mismatch/);
  await stateOf(fx, 'job-i4', 'blocked', /authorization_mismatch/);
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const job of ['job-i2', 'job-i3', 'job-i5']) {
    assert.equal(await exists(join(jobDir(fx, job), 'managed.json')), false, `${job} untouched`);
  }
  assert.equal((await invocations(fx)).length, 0);
});

test('a Claude Code that does not run in auto mode is stopped, never continued in another mode', async () => {
  const fx = await fixture();
  await setStreamMode(fx, 'auto-unavailable');
  const accepted = await acceptedJob(fx, 'job-j');
  await supervisor(fx);
  await authorize(fx, 'job-j', accepted, randomUUID());
  const failed = await stateOf(fx, 'job-j', 'failed', /auto_mode_unavailable/);
  assert.match(failed.job!.diagnostic!.message, /reported: default.*stopped at once/);
  assert.equal((await invocations(fx)).length, 1);
  assert.equal(failed.job?.iterations[0]?.state, 'abandoned');
  assert.equal(failed.job?.iterations[0]?.snapshot_sha256, null);
  assert.notEqual(JSON.parse(await readFile(join(jobDir(fx, 'job-j'), 'execution.json'), 'utf8')).state, 'completed');
});

test('a second authorization after a launch, or a racing replay, never starts the job again', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-k');
  await supervisor(fx);
  const first = randomUUID();
  await authorize(fx, 'job-k', accepted, first);
  await stateOf(fx, 'job-k', 'awaiting_review');
  assert.equal(await code(authorize(fx, 'job-k', accepted, randomUUID())), 'conflict');
  assert.equal(await code(authorize(fx, 'job-k', accepted, first)), 'conflict');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await invocations(fx)).length, 1);
});
