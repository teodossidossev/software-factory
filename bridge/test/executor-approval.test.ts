// SF-009 Review 01, R1-1: an authorization launches only through a proven, once-consumed SF-007
// approval bound to the same tuple. consumed/<authorization_id> is a reservation, never evidence:
// a rejected job, an unrelated pending approval, a failure or a crash at either boundary of the
// approval step, and competing supervisors never lead to an implicit approval. Where recovery
// proves a valid consumed approval, exactly one Claude process is launched.
// Review 02, R2-3: an approval step is completed only within the attempt that reserved the
// authorization; a later attempt (retry or restart) proceeds only on an already consumed approval.
// A caught failure whose refusal and SF-007 settlement both could not be written never approves.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAppConfig } from '../src/execution/app-config.js';
import { ExecutorState, repoSha256 } from '../src/executor/policy.js';
import { Supervisor, type SupervisorOptions } from '../src/executor/supervisor.js';
import { launchRecord, OperatorStore } from '../src/operator/store.js';
import { acceptedJob, destroyFixture, invocations, jobDir, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, managedService, startSupervisor, waitFor } from './support/executor-fixture.js';

const ENTRY = fileURLToPath(new URL('./support/supervisor-fixture.js', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

async function fixture(): Promise<Fixture> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  return fx;
}

async function supervisor(fx: Fixture, options: Partial<SupervisorOptions> = {}): Promise<() => Promise<void>> {
  const running = await startSupervisor(fx, options);
  cleanup.push(running.stop);
  return running.stop;
}

const executorDir = (fx: Fixture) => join(fx.stateHome, 'software-factory', 'executor');
const operatorJob = (fx: Fixture, job: string) => join(fx.stateHome, 'software-factory', 'operator', 'jobs', fx.app, job);
const exists = (path: string) => readFile(path).then(() => true, () => false);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stateOf = (fx: Fixture, job: string, wanted: string, diagnostic?: RegExp) =>
  waitFor(async () => {
    const status = await gateway(fx).status(fx.app, job);
    return status.status === wanted && (diagnostic === undefined || diagnostic.test(`${status.job?.diagnostic?.code}`)) ? status : undefined;
  }, `${job} ${wanted}${diagnostic ? ` ${diagnostic}` : ''}`);

async function tuple(fx: Fixture, job: string, accepted: { requestId: string; sha: string }) {
  const config = await loadAppConfig(fx.mediator, fx.app);
  return { app_id: fx.app, job_id: job, request_id: accepted.requestId, instruction_sha256: accepted.sha, app_repo_sha256: repoSha256(config.repo) };
}

async function approvals(fx: Fixture, job: string): Promise<string[]> {
  return (await readdir(operatorJob(fx, job)).catch(() => [] as string[])).filter((name) => name.startsWith('approval')).sort();
}

// Nothing was launched or claimed for this job.
async function nothingLaunched(fx: Fixture, job: string): Promise<void> {
  assert.equal((await invocations(fx)).length, 0, 'no Claude process');
  assert.equal(await exists(join(jobDir(fx, job), 'launch.claim')), false, 'no launch.claim');
  assert.equal(await exists(join(jobDir(fx, job), 'execution.json')), false, 'not prepared');
}

test('a job the operator rejected is refused once and stays refused: the consumed marker never stands in for an approval', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-rejected');
  const store = await OperatorStore.open(fx.stateHome, fx.mediator);
  await store.reject(fx.app, 'job-rejected', { request_id: accepted.requestId, instruction_sha256: accepted.sha, at: new Date().toISOString() }, async () => undefined);
  const auth = await authorize(fx, 'job-rejected', accepted, randomUUID());
  await supervisor(fx);
  await stateOf(fx, 'job-rejected', 'blocked', /wrong_status/);
  assert.equal(await exists(join(executorDir(fx), 'consumed', auth.authorization_id)), true);
  assert.equal(await exists(join(executorDir(fx), 'refused', auth.authorization_id)), true);
  // Many retry intervals later (the bug: the next poll skipped the approval and launched).
  await pause(600);
  // Even with the rejection gone, the failed approval step does not become an approval.
  await rm(join(operatorJob(fx, 'job-rejected'), 'rejected.json'));
  await pause(600);
  assert.equal((await gateway(fx).status(fx.app, 'job-rejected')).status, 'blocked');
  await nothingLaunched(fx, 'job-rejected');
  assert.deepEqual(await approvals(fx, 'job-rejected'), []);
});

test('an unrelated pending console approval refuses the authorization; withdrawing it later launches nothing', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-pending');
  const store = await OperatorStore.open(fx.stateHome, fx.mediator);
  const console = await store.createApproval(await tuple(fx, 'job-pending', accepted), new Date(), async () => undefined);
  await authorize(fx, 'job-pending', accepted, randomUUID());
  await supervisor(fx);
  await stateOf(fx, 'job-pending', 'blocked', /conflict/);
  await store.settleApproval(fx.app, 'job-pending', console.id, 'cancelled');
  await pause(600);
  assert.equal((await gateway(fx).status(fx.app, 'job-pending')).status, 'blocked');
  await nothingLaunched(fx, 'job-pending');
  // Only the console's own approval exists (cancelled); none was created for the authorization.
  assert.deepEqual(await approvals(fx, 'job-pending'), [`approval-${console.id}.cancelled.json`]);
  // A fresh authorization, after the cause is resolved, is a new and complete approval: one launch.
  await authorize(fx, 'job-pending', accepted, randomUUID());
  await stateOf(fx, 'job-pending', 'awaiting_review');
  assert.equal((await invocations(fx)).length, 1);
});

test('a failure between the consumed marker and the approval is final: no approval, no launch', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-fail-use');
  const auth = await authorize(fx, 'job-fail-use', accepted, randomUUID());
  await supervisor(fx, { afterAuthorizationUse: async () => { throw new Error('injected'); } });
  await stateOf(fx, 'job-fail-use', 'blocked', /approval_failed/);
  await pause(500);
  assert.equal((await gateway(fx).status(fx.app, 'job-fail-use')).status, 'blocked');
  await nothingLaunched(fx, 'job-fail-use');
  assert.deepEqual(await approvals(fx, 'job-fail-use'), []);
  assert.equal(await exists(join(executorDir(fx), 'refused', auth.authorization_id)), true);
});

test('a failure between creating and consuming the approval withdraws it: no launch', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-fail-approval');
  const auth = await authorize(fx, 'job-fail-approval', accepted, randomUUID());
  await supervisor(fx, { afterApprovalCreated: async () => { throw new Error('injected'); } });
  await stateOf(fx, 'job-fail-approval', 'blocked', /approval_failed/);
  await pause(500);
  await nothingLaunched(fx, 'job-fail-approval');
  const use = JSON.parse(await readFile(join(executorDir(fx), 'consumed', auth.authorization_id), 'utf8')) as { approval_id: string };
  assert.deepEqual(await approvals(fx, 'job-fail-approval'), [`approval-${use.approval_id}.refused.json`]);
});

test('a consumed marker without an approval id (written before Review 01) fails closed', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-legacy');
  const auth = await authorize(fx, 'job-legacy', accepted, randomUUID());
  await writeFile(join(executorDir(fx), 'consumed', auth.authorization_id), JSON.stringify({ app_id: fx.app, job_id: 'job-legacy', at: new Date().toISOString() }), { mode: 0o600 });
  await supervisor(fx);
  await stateOf(fx, 'job-legacy', 'blocked', /invalid_record/);
  await pause(400);
  await nothingLaunched(fx, 'job-legacy');
  assert.deepEqual(await approvals(fx, 'job-legacy'), []);
});

test('a consumed marker bound to another tuple fails closed', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-foreign');
  const auth = await authorize(fx, 'job-foreign', accepted, randomUUID());
  const state = await ExecutorState.open(fx.stateHome, fx.mediator);
  await state.consume({ schema: 'software-factory.authorization-use/v1', authorization_id: auth.authorization_id, approval_id: randomUUID(), ...(await tuple(fx, 'job-foreign', accepted)), instruction_sha256: 'e'.repeat(64), at: new Date().toISOString() });
  await supervisor(fx);
  await stateOf(fx, 'job-foreign', 'blocked', /approval_mismatch/);
  await nothingLaunched(fx, 'job-foreign');
});

test('competing writers: one authorization use wins; a second supervisor cannot start', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-compete');
  const base = await tuple(fx, 'job-compete', accepted);
  const id = randomUUID();
  const [a, b] = await Promise.all([ExecutorState.open(fx.stateHome, fx.mediator), ExecutorState.open(fx.stateHome, fx.mediator)]);
  const uses = [randomUUID(), randomUUID()].map((approvalId) => ({ schema: 'software-factory.authorization-use/v1' as const, authorization_id: id, approval_id: approvalId, ...base, at: new Date().toISOString() }));
  const won = await Promise.all([a.consume(uses[0]!), b.consume(uses[1]!)]);
  assert.deepEqual(won.filter(Boolean).length, 1);
  const winner = uses[won.indexOf(true)]!;
  assert.deepEqual(await a.use(id), winner);
  assert.deepEqual(await b.use(id), winner);
  await supervisor(fx);
  await assert.rejects(Supervisor.start({ mediatorRoot: fx.mediator, stateHome: fx.stateHome, service: managedService(fx) }), { code: 'locked' });
});

test('a restart after the approval was consumed and before the launch proves it: exactly one launch, also after further restarts', async () => {
  const fx = await fixture();
  const accepted = await acceptedJob(fx, 'job-consumed');
  const auth = await authorize(fx, 'job-consumed', accepted, randomUUID());
  // The durable state a supervisor leaves when it stops right after consuming the approval.
  const state = await ExecutorState.open(fx.stateHome, fx.mediator);
  const store = await OperatorStore.open(fx.stateHome, fx.mediator);
  const bound = await tuple(fx, 'job-consumed', accepted);
  const approvalId = randomUUID();
  await state.consume({ schema: 'software-factory.authorization-use/v1', authorization_id: auth.authorization_id, approval_id: approvalId, ...bound, at: new Date().toISOString() });
  await store.createApproval(bound, new Date(), async () => undefined, approvalId);
  await store.settleApproval(fx.app, 'job-consumed', approvalId, 'consumed', launchRecord('started', new Date()));
  const stop = await supervisor(fx);
  await stateOf(fx, 'job-consumed', 'awaiting_review');
  await stop();
  await supervisor(fx);
  await pause(500);
  assert.equal((await invocations(fx)).length, 1, 'exactly one Claude process');
  assert.deepEqual(await approvals(fx, 'job-consumed'), [`approval-${approvalId}.consumed.json`]);
});

// ---- restarts at each boundary, with supervisors in their own processes ----

function processSupervisor(file: string, fault?: string): { first: Promise<string>; exited: Promise<number | null>; child: ChildProcess } {
  const child = spawn(process.execPath, [ENTRY, file, ...(fault ? [fault] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, pause(8000)]);
      child.kill('SIGKILL');
    }
  });
  const first = new Promise<string>((resolve) => {
    let output = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes('\n')) resolve(output.split('\n')[0]!);
    });
    child.once('exit', () => resolve(output.split('\n')[0] || 'exited'));
  });
  return { child, first, exited };
}

async function crashThenRestart(fx: Fixture, job: string, fault: string, between?: () => Promise<void>): Promise<string> {
  const file = join(fx.sandbox, 'fixture.json');
  await writeFile(file, JSON.stringify(fx));
  const accepted = await acceptedJob(fx, job);
  const crashing = processSupervisor(file, fault);
  assert.equal(await crashing.first, 'ready');
  const auth = await authorize(fx, job, accepted, randomUUID());
  await crashing.exited;
  await nothingLaunched(fx, job);
  await between?.();
  const next = processSupervisor(file);
  assert.equal(await next.first, 'ready');
  return auth.authorization_id;
}

test('a restart after the consumed marker does not resume the interrupted approval step: no approval, no launch', async () => {
  const fx = await fixture();
  const id = await crashThenRestart(fx, 'job-crash-use', 'crash-after-use');
  await stateOf(fx, 'job-crash-use', 'blocked', /approval_interrupted/);
  await pause(400);
  await nothingLaunched(fx, 'job-crash-use');
  assert.deepEqual(await approvals(fx, 'job-crash-use'), []);
  assert.equal(await exists(join(executorDir(fx), 'refused', id)), true);
});

test('a restart after the consumed marker re-checks: a rejection made meanwhile means no launch', async () => {
  const fx = await fixture();
  await crashThenRestart(fx, 'job-crash-reject', 'crash-after-use', async () => {
    const store = await OperatorStore.open(fx.stateHome, fx.mediator);
    const status = await gateway(fx).status(fx.app, 'job-crash-reject');
    assert.notEqual(status.status, 'awaiting_review');
    const accepted = JSON.parse(await readFile(join(jobDir(fx, 'job-crash-reject'), 'dispatch.json'), 'utf8')) as { request_id: string; instruction_sha256: string };
    await store.reject(fx.app, 'job-crash-reject', { request_id: accepted.request_id, instruction_sha256: accepted.instruction_sha256, at: new Date().toISOString() }, async () => undefined);
  });
  await stateOf(fx, 'job-crash-reject', 'blocked', /approval_interrupted/);
  await pause(400);
  await nothingLaunched(fx, 'job-crash-reject');
  assert.deepEqual(await approvals(fx, 'job-crash-reject'), []);
});

test('a restart after the approval was created withdraws that pending approval: no launch', async () => {
  const fx = await fixture();
  const id = await crashThenRestart(fx, 'job-crash-approval', 'crash-after-approval');
  await stateOf(fx, 'job-crash-approval', 'blocked', /approval_interrupted/);
  await pause(400);
  await nothingLaunched(fx, 'job-crash-approval');
  const use = JSON.parse(await readFile(join(executorDir(fx), 'consumed', id), 'utf8')) as { approval_id: string };
  assert.deepEqual(await approvals(fx, 'job-crash-approval'), [`approval-${use.approval_id}.refused.json`]);
  assert.equal(await exists(join(operatorJob(fx, 'job-crash-approval'), 'launch.json')), false);
});

test('a restart after the approval was created, which the operator cancelled meanwhile, launches nothing', async () => {
  const fx = await fixture();
  await crashThenRestart(fx, 'job-crash-cancel', 'crash-after-approval', async () => {
    const store = await OperatorStore.open(fx.stateHome, fx.mediator);
    assert.ok(await store.settleApproval(fx.app, 'job-crash-cancel', undefined, 'cancelled', launchRecord('cancelled', new Date())));
  });
  await stateOf(fx, 'job-crash-cancel', 'blocked', /approval_cancelled/);
  await pause(400);
  await nothingLaunched(fx, 'job-crash-cancel');
});

// ---- Review 02, R2-3: a caught failure whose refusal and settlement both fail ----

// The approval step fails with an error the supervisor catches, after the SF-007 approval was
// created; at that moment refused/ and the operator job directory cannot be written, so neither the
// refusal nor the settlement to "refused" lands. The approval stays pending on disk.
async function doubleFailure(fx: Fixture, job: string): Promise<{ approvalId: string; stop: () => Promise<void> }> {
  const accepted = await acceptedJob(fx, job);
  const auth = await authorize(fx, job, accepted, randomUUID());
  const locked = [join(executorDir(fx), 'refused'), operatorJob(fx, job)];
  const unlock = async () => {
    for (const dir of locked) await chmod(dir, 0o700).catch(() => undefined);
  };
  cleanup.push(unlock);
  const stop = await supervisor(fx, {
    afterApprovalCreated: async () => {
      for (const dir of locked) await chmod(dir, 0o500);
      throw new Error('injected');
    },
  });
  await stateOf(fx, job, 'blocked', /approval_failed/);
  await unlock();
  const use = JSON.parse(await readFile(join(executorDir(fx), 'consumed', auth.authorization_id), 'utf8')) as { approval_id: string };
  // Both writes really failed: no refusal marker, and the approval is still pending.
  assert.equal(await exists(join(executorDir(fx), 'refused', auth.authorization_id)), false);
  assert.deepEqual(await approvals(fx, job), ['approval.json']);
  return { approvalId: use.approval_id, stop };
}

test('a double failure in the approval error path is never approved by a retried poll', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  const fx = await fixture();
  await doubleFailure(fx, 'job-double');
  // Many retry periods (retryMs 40) with writable directories again.
  await pause(800);
  assert.equal((await gateway(fx).status(fx.app, 'job-double')).status, 'blocked');
  await nothingLaunched(fx, 'job-double');
  assert.deepEqual(await approvals(fx, 'job-double'), ['approval.json'], 'the pending approval was never consumed');
});

test('a double failure in the approval error path is never approved after a restart, even without its managed.json evidence', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  const fx = await fixture();
  const { stop, approvalId } = await doubleFailure(fx, 'job-double-restart');
  await stop();
  // A restarted supervisor: no in-memory evidence. First with managed.json (blocked, approval_failed).
  await supervisor(fx);
  await pause(500);
  assert.equal((await gateway(fx).status(fx.app, 'job-double-restart')).status, 'blocked');
  await nothingLaunched(fx, 'job-double-restart');
  assert.deepEqual(await approvals(fx, 'job-double-restart'), ['approval.json'], 'not even touched by a record that is never considered again');
  // Then as if that write had failed too: no managed.json at all. The pending approval is not resumed.
  await cleanup.pop()!();
  await rm(join(jobDir(fx, 'job-double-restart'), 'managed.json'));
  await supervisor(fx);
  await stateOf(fx, 'job-double-restart', 'blocked', /approval_interrupted/);
  await pause(400);
  await nothingLaunched(fx, 'job-double-restart');
  assert.deepEqual(await approvals(fx, 'job-double-restart'), [`approval-${approvalId}.refused.json`]);
});

