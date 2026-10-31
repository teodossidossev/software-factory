// SF-009 self-hosting, SH-R3 regression: a supervisor that is already running refuses every launch
// while the executor policy is uncommitted (committed: false), even for an authorization that is
// otherwise valid (its epoch is the incomplete policy's, the self-hosting grant is in place, the
// session gate is free). Once the transaction completes, that authorization is stale and never
// launches. Throwaway mediators and the fake stream-json Claude only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionGate } from '../src/execution/session-gate.js';
import { policyRunnable, repoSha256 } from '../src/executor/policy.js';
import { acceptedJob, destroyFixture, gatePath, invocations, jobDir, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, gateway, managedService, messages, startSupervisor, streamClaude, waitForStatus } from './support/executor-fixture.js';
import { enableSelfHosting, selfHostedMediator } from './support/self-hosting-fixture.js';

// A read-only directory does not stop root: the view write failure needs an ordinary user.
const asRoot = { skip: process.getuid?.() === 0 ? 'read-only directories do not stop root' : false };

const exists = (path: string) => readFile(path).then(() => true, () => false);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PILOT = 'pilot';
const fakeClaude = (fx: Fixture) => ({ executable: streamClaude(fx), version: 'fake 0.0.0' });

// A second app, a disposable pilot on the fixture's separate repository. Its public view is the
// one whose write fails, after the self-hosting app's view at the new epoch was already written.
async function registerPilot(fx: Fixture): Promise<string> {
  const dir = join(fx.mediator, 'factory-data', 'apps', PILOT);
  await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, '.env'), `APP_REPO=${fx.appRepo}\n`, { mode: 0o600 });
  return dir;
}

// Nothing of the launch path past the policy check happened for this job and authorization.
async function nothingLaunched(fx: Fixture, executorDir: string, job: string, authorizationId: string): Promise<void> {
  assert.equal((await invocations(fx)).length, 0, 'no fake Claude invocation');
  assert.deepEqual(await messages(fx), [], 'no message reached a Claude process');
  assert.equal(await exists(join(executorDir, 'consumed', authorizationId)), false, 'the authorization is not consumed');
  assert.equal(await exists(join(executorDir, 'refused', authorizationId)), false, 'no approval step ran (nothing refused)');
  assert.equal(await exists(join(jobDir(fx, job), 'launch.claim')), false, 'no launch.claim');
  assert.equal(await exists(join(jobDir(fx, job), 'execution.json')), false, 'not prepared');
  const operatorJob = join(fx.stateHome, 'software-factory', 'operator', 'jobs', fx.app, job);
  const approvals = (await readdir(operatorJob).catch(() => [] as string[])).filter((name) => name.startsWith('approval'));
  assert.deepEqual(approvals, [], 'no SF-007 approval was created');
}

// The supervisor events recorded on the job (managed.json), as [event, detail] pairs.
async function jobEvents(fx: Fixture, job: string): Promise<Array<[string, string | null]>> {
  const record = JSON.parse(await readFile(join(jobDir(fx, job), 'managed.json'), 'utf8')) as { events: Array<{ event: string; detail: string | null }> };
  return record.events.map((entry) => [entry.event, entry.detail]);
}

test('SH-R3: a running supervisor refuses an otherwise valid authorization while the policy is uncommitted; once completed it is stale', asRoot, async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    await selfHostedMediator(fx);
    const pilotDir = await registerPilot(fx);
    const state = await enableSelfHosting(fx);
    const committed = await state.policy();
    assert.equal(policyRunnable(committed), true, 'the supervisor starts under a committed policy');
    const job = 'job-uncommitted';
    const accepted = await acceptedJob(fx, job);
    // Counts the supervisor's preflight calls: the policy check must refuse before any of them.
    const service = managedService(fx, { selfHosting: () => state.selfHostingGrant() });
    const preflight = service.preflight.bind(service);
    let preflights = 0;
    service.preflight = (...args) => {
      preflights += 1;
      return preflight(...args);
    };
    const running = await startSupervisor(fx, { service });
    try {
      // Enabling the pilot fails at its view write: policy.json stays at the new epoch, uncommitted.
      await chmod(pilotDir, 0o500);
      try {
        await assert.rejects(state.enable(PILOT, fakeClaude(fx), [], new Date(), 'disposable_pilot'));
      } finally {
        await chmod(pilotDir, 0o700);
      }
      const incomplete = await state.policy();
      assert.equal(incomplete?.committed, false);
      assert.equal(incomplete?.epoch, (committed?.epoch ?? 0) + 1);
      assert.equal(policyRunnable(incomplete), false);

      // Every other check would pass: the self-hosting app's view is published at the incomplete
      // epoch, its grant is in place for this checkout, and the session gate is free.
      const auth = await authorize(fx, job, accepted, randomUUID());
      assert.equal(auth.policy_epoch, incomplete?.epoch, 'not a stale epoch');
      assert.deepEqual(await state.selfHostingGrant(), { appId: fx.app, repoSha256: repoSha256(fx.mediator) }, 'the grant is present');
      assert.equal(incomplete?.apps[fx.app]?.isolation, 'self_hosting_unconfined');
      await new SessionGate(gatePath(fx)).ensure();
      assert.deepEqual(await new SessionGate(gatePath(fx)).holders(), [], 'the gate is free');

      const refused = await waitForStatus(fx, job, (value) => value.job?.diagnostic?.code === 'policy_incomplete', 'policy_incomplete');
      assert.equal(refused.job?.state, 'blocked');
      // Several retry intervals later it is still refused for the policy alone, and nothing ran.
      await pause(400);
      const events = await jobEvents(fx, job);
      assert.ok(events.length > 0, 'the refusal is recorded on the job');
      assert.deepEqual(events.filter(([, detail]) => detail !== 'policy_incomplete'), [], 'no other refusal, preflight or launch step');
      assert.equal((await gateway(fx).status(fx.app, job)).job?.diagnostic?.code, 'policy_incomplete');
      assert.equal(preflights, 0, 'no preflight');
      await nothingLaunched(fx, state.dir, job, auth.authorization_id);

      // The fixture completes the transaction through the normal API: a new, committed epoch.
      const completed = await state.enable(PILOT, fakeClaude(fx), [], new Date(), 'disposable_pilot');
      assert.equal(policyRunnable(await state.policy()), true);
      assert.equal(completed.epoch, (incomplete?.epoch ?? 0) + 1);
      assert.equal((await gateway(fx).status(fx.app, job)).policy?.policy_epoch, completed.epoch, 'the published view moved on');

      // The prior authorization is stale now and still cannot launch.
      const stale = await waitForStatus(fx, job, (value) => value.job?.diagnostic?.code === 'stale_policy', 'stale_policy');
      assert.equal(stale.job?.state, 'blocked');
      await pause(400);
      assert.equal((await gateway(fx).status(fx.app, job)).job?.diagnostic?.code, 'stale_policy');
      assert.deepEqual((await jobEvents(fx, job)).filter(([, detail]) => !['policy_incomplete', 'stale_policy'].includes(detail ?? '')), [], 'only policy refusals');
      assert.equal(preflights, 0, 'still no preflight');
      await nothingLaunched(fx, state.dir, job, auth.authorization_id);
    } finally {
      await running.stop();
    }
  } finally {
    await destroyFixture(fx);
  }
});
