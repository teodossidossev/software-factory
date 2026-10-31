// SF-009 self-hosting with an inherited protection of the main checkout: the policy's global
// protected_paths names the Software Factory checkout itself (protected for every other app) and
// another checkout. A verified self-hosted job is exempt only from its own exact repository; every
// other protection, and Git detection in its own repository, stays in force. Throwaway mediators and
// a fake stream-json Claude only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExecutorState } from '../src/executor/policy.js';
import { sessionProtection } from '../src/executor/supervisor.js';
import { acceptedJob, destroyFixture, git, invocations, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, gateway, managedService, setStreamMode, startSupervisor, streamClaude, waitForStatus } from './support/executor-fixture.js';
import { CLAUDE, existingWorkIntact, selfHostedMediator } from './support/self-hosting-fixture.js';

// Another checkout (committed, clean) that the policy protects.
async function otherCheckout(fx: Fixture): Promise<string> {
  const other = join(fx.sandbox, 'other-checkout');
  await mkdir(other);
  git(other, 'init', '-q');
  await writeFile(join(other, 'README.md'), '# Other\n');
  git(other, 'add', 'README.md');
  git(other, 'commit', '-q', '-m', 'init');
  return other;
}

// The activation situation: a pilot app (its own repository) was enabled earlier with
// --protect <main> --protect <other>; then the self-hosting app is enabled. Returns the state.
async function inheritedProtection(fx: Fixture, other: string): Promise<ExecutorState> {
  await mkdir(join(fx.mediator, 'factory-data', 'apps', 'pilot'), { mode: 0o700 });
  await writeFile(join(fx.mediator, 'factory-data', 'apps', 'pilot', '.env'), `APP_REPO=${fx.appRepo}\n`, { mode: 0o600 });
  const state = await ExecutorState.open(fx.stateHome, fx.mediator);
  await state.enable('pilot', { executable: streamClaude(fx), version: CLAUDE.version }, [fx.mediator, other], new Date(), 'disposable_pilot');
  await state.enable(fx.app, { executable: streamClaude(fx), version: CLAUDE.version }, [], new Date(), 'self_hosting_unconfined');
  assert.deepEqual((await state.policy())?.protected_paths, [fx.mediator, other], 'both protections are in the policy');
  return state;
}

async function selfHostedJob(fx: Fixture, state: ExecutorState, job: string): Promise<{ stop: () => Promise<void> }> {
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx, { service: managedService(fx, { selfHosting: () => state.selfHostingGrant() }) });
  await authorize(fx, job, accepted, randomUUID());
  return running;
}

test('a policy protecting [main, other] lets a self-hosted job change its own repository through review, reset and acceptance', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    await selfHostedMediator(fx);
    const other = await otherCheckout(fx);
    const state = await inheritedProtection(fx, other);
    const before = await state.policy();
    const job = 'job-own';
    const running = await selfHostedJob(fx, state, job);
    try {
      const ready = await waitForStatus(fx, job, (value) => value.status === 'awaiting_review', 'iteration-001 ready');
      assert.equal(ready.job?.diagnostic, null);
      const gw = gateway(fx);
      const snap1 = await gw.snapshot(fx.app, job, 'iteration-001');
      assert.deepEqual(snap1.snapshot.export.changed_paths, ['README.md']);
      // A review round in the same session, also changing the own repository.
      await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap1.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'Add notes. FAKE-EDIT more.txt second' }] });
      const second = await waitForStatus(fx, job, (value) => value.status === 'awaiting_review' && value.job?.current_iteration === 'iteration-002', 'iteration-002 ready');
      const snap2 = await gw.snapshot(fx.app, job, 'iteration-002');
      // A context reset replaces the process; the frozen scope still exempts only the own repository.
      const resetId = randomUUID();
      await gw.manageContext({ app_id: fx.app, job_id: job, iteration_id: 'iteration-002', session_id: second.job!.current_session_id as string, action: 'reset', request_id: resetId });
      await waitForStatus(fx, job, (value) => value.status === 'awaiting_review' && value.job?.context_actions.find((entry) => entry.request_id === resetId)?.outcome === 'performed', 'reset performed');
      assert.equal((await invocations(fx)).length, 2, 'a second process after the reset');
      await gw.submitReview({ app_id: fx.app, job_id: job, iteration_id: 'iteration-002', snapshot_sha256: snap2.snapshot_sha256, review_id: randomUUID(), findings: [{ text: 'One more. FAKE-EDIT more.txt third' }] });
      await waitForStatus(fx, job, (value) => value.status === 'awaiting_review' && value.job?.current_iteration === 'iteration-003', 'iteration-003 ready');
      const snap3 = await gw.snapshot(fx.app, job, 'iteration-003');
      await gw.accept({ app_id: fx.app, job_id: job, iteration_id: 'iteration-003', snapshot_sha256: snap3.snapshot_sha256, acceptance_id: randomUUID() });
      const closed = await waitForStatus(fx, job, (value) => value.status === 'closed', 'closed');
      assert.equal(closed.job?.execution_state, 'completed');
    } finally {
      await running.stop();
    }
    assert.deepEqual((await state.policy())?.protected_paths, before?.protected_paths, 'the global list is unchanged');
    assert.deepEqual((await state.policy())?.protected_paths, [fx.mediator, other]);
    await existingWorkIntact(fx);
  } finally {
    await destroyFixture(fx);
  }
});

test('a self-hosted job changing the other protected checkout still ends protected_checkout_changed', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    await selfHostedMediator(fx);
    const other = await otherCheckout(fx);
    const state = await inheritedProtection(fx, other);
    await setStreamMode(fx, 'implement-outside', { outside: other });
    const running = await selfHostedJob(fx, state, 'job-other');
    try {
      const ended = await waitForStatus(fx, 'job-other', (value) => value.status === 'needs_inspection', 'needs_inspection');
      assert.equal(ended.job?.diagnostic?.code, 'protected_checkout_changed');
    } finally {
      await running.stop();
    }
  } finally {
    await destroyFixture(fx);
  }
});

test('Git operations in the self-hosted repository stay detected with the main checkout exempted', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    await selfHostedMediator(fx);
    const other = await otherCheckout(fx);
    const state = await inheritedProtection(fx, other);
    await setStreamMode(fx, 'ok', { shell: 'git add README.md' });
    const running = await selfHostedJob(fx, state, 'job-git');
    try {
      const ended = await waitForStatus(fx, 'job-git', (value) => value.status === 'needs_inspection', 'needs_inspection');
      assert.equal(ended.job?.diagnostic?.code, 'git_operation_detected');
    } finally {
      await running.stop();
    }
  } finally {
    await destroyFixture(fx);
  }
});

test('a separate pilot changing the protected main checkout still ends protected_checkout_changed', async () => {
  const fx = await createExecutorFixture('pilot');
  try {
    // The main checkout as in the self-hosting tests (factory-data ignored), but the app is a pilot.
    await writeFile(join(fx.mediator, '.gitignore'), 'factory-data/\n');
    await writeFile(join(fx.mediator, 'README.md'), '# Software Factory\n');
    git(fx.mediator, 'add', '.gitignore', 'README.md');
    git(fx.mediator, 'commit', '-q', '-m', 'init');
    const state = await ExecutorState.open(fx.stateHome, fx.mediator);
    await state.enable(fx.app, { executable: streamClaude(fx), version: CLAUDE.version }, [fx.mediator], new Date(), 'disposable_pilot');
    await setStreamMode(fx, 'implement-outside', { outside: fx.mediator });
    const job = 'job-pilot';
    const accepted = await acceptedJob(fx, job);
    const running = await startSupervisor(fx);
    try {
      await authorize(fx, job, accepted, randomUUID());
      const ended = await waitForStatus(fx, job, (value) => value.status === 'needs_inspection', 'needs_inspection');
      assert.equal(ended.job?.diagnostic?.code, 'protected_checkout_changed');
    } finally {
      await running.stop();
    }
    assert.deepEqual((await state.policy())?.protected_paths, [fx.mediator]);
  } finally {
    await destroyFixture(fx);
  }
});

test('the exemption is exact path equality of the verified self-hosted repository, nothing else', () => {
  const main = '/work/software-factory';
  const self = { appId: 'sf-self', repo: main, selfHosted: true as const };
  const near = [main, `${main}/`, '/work', `${main}/bridge`, `${main}-other`, '/elsewhere'];
  // Only the exact main entry is left out; trailing slash, ancestor, descendant and prefix siblings stay.
  assert.deepEqual(sessionProtection(near, self, main, main), [`${main}/`, '/work', `${main}/bridge`, `${main}-other`, '/elsewhere']);
  // No exemption unless config.repo, the session's repository and the mediator root are one path.
  assert.deepEqual(sessionProtection([main], self, '/other', main), [main]);
  assert.deepEqual(sessionProtection([main], self, main, '/other'), [main]);
  assert.deepEqual(sessionProtection([main], { ...self, repo: '/other' }, main, main), [main]);
  // Not self-hosted (a pilot), or no verified config: every entry stays.
  assert.deepEqual(sessionProtection([main], { appId: 'pilot', repo: main }, main, main), [main]);
  assert.deepEqual(sessionProtection([main], undefined, main, main), [main]);
  // The input list itself is never changed.
  const global = [main, '/elsewhere'];
  sessionProtection(global, self, main, main);
  assert.deepEqual(global, [main, '/elsewhere']);
});
