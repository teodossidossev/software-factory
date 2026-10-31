// SF-009 self-hosting, independent review corrections (SH-R1 to SH-R5): a staged deletion the
// session reverses, a path named __proto__ in the baseline, stale self-hosting policy entries
// after a global disable, the status of a job whose registration moved, and status discovery
// issues. Throwaway mediators and a fake stream-json Claude only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { preexistingBaselineName } from '../src/execution/service.js';
import type { ExecutionGateway } from '../src/executor/gateway.js';
import { ExecutorState, policyRunnable } from '../src/executor/policy.js';
import { readStatus, renderStatus } from '../src/executor/status.js';
import { Supervisor } from '../src/executor/supervisor.js';
import { acceptedJob, destroyFixture, git, jobDir, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, managedService, setStreamMode, startSupervisor, waitForStatus } from './support/executor-fixture.js';
import { CLAUDE, code, enableSelfHosting, selfHostedMediator } from './support/self-hosting-fixture.js';

type Snapshot = Awaited<ReturnType<ExecutionGateway['snapshot']>>;

// One self-hosted job up to its first published snapshot: setup prepares the checkout (after the
// usual existing work), shell is what the fake Claude runs in it during /implement.
async function firstSnapshot(fx: Fixture, setup: () => Promise<void>, shell: string): Promise<{ snapshot: Snapshot; diff: string; status: string; diagnostic: string | null }> {
  await selfHostedMediator(fx);
  await setup();
  const state = await enableSelfHosting(fx);
  await setStreamMode(fx, 'ok', { shell });
  const job = 'job-review';
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx, { service: managedService(fx, { selfHosting: () => state.selfHostingGrant() }) });
  try {
    await authorize(fx, job, accepted, randomUUID());
    const ready = await waitForStatus(fx, job, (value) => ['awaiting_review', 'needs_operator'].includes(value.status) && value.job?.iterations[0]?.state === 'ready_for_review', 'iteration-001 published');
    const snapshot = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
    return { snapshot, diff: await readFile(join(fx.mediator, snapshot.diff.path), 'utf8'), status: ready.status, diagnostic: ready.job?.diagnostic?.code ?? null };
  } finally {
    await running.stop();
  }
}

const fileHeaders = (diff: string, path: string): number => diff.split('\n').filter((line) => line.startsWith('diff --git') && line.endsWith(`/${path}`)).length;

// HEAD has gone.md; the operator stages its deletion (git rm) before the job.
async function stagedDeletion(fx: Fixture): Promise<void> {
  await writeFile(join(fx.mediator, 'gone.md'), 'gone\n');
  git(fx.mediator, 'add', 'gone.md');
  git(fx.mediator, 'commit', '-q', '-m', 'gone', '--', 'gone.md');
  git(fx.mediator, 'rm', '-q', 'gone.md');
}

test('SH-R1: a staged deletion the session recreates with other content is one modification against HEAD', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    const { snapshot, diff, status } = await firstSnapshot(fx, () => stagedDeletion(fx), "printf 'recreated\\n' > gone.md");
    assert.equal(status, 'awaiting_review');
    const exported = snapshot.snapshot.export;
    assert.equal(exported.changed_paths.filter((path) => path === 'gone.md').length, 1, 'listed once');
    assert.equal(exported.new_files.some((file) => file.path === 'gone.md'), false, 'not a new file');
    assert.equal(fileHeaders(diff, 'gone.md'), 1, 'one patch for the path');
    assert.match(diff, /-gone\n\+recreated/);
    assert.deepEqual(exported.preexisting?.changed, ['gone.md']);
    assert.deepEqual(exported.preexisting?.removed, []);
    // The index keeps the operator's staged deletion: it was not changed, so no Git operation is reported.
    assert.equal(git(fx.mediator, 'ls-files', '--stage', '--', 'gone.md'), '', 'the staged deletion stays staged');
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R1: a staged deletion the session reverses to the HEAD content is existing work removed', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    const { snapshot, diff, status, diagnostic } = await firstSnapshot(fx, () => stagedDeletion(fx), "printf 'gone\\n' > gone.md");
    assert.equal(status, 'needs_operator');
    assert.equal(diagnostic, 'existing_work_removed');
    const exported = snapshot.snapshot.export;
    assert.deepEqual(exported.preexisting?.removed, ['gone.md']);
    assert.deepEqual(exported.preexisting?.changed, []);
    assert.equal(exported.changed_paths.includes('gone.md'), false);
    assert.equal(exported.new_files.some((file) => file.path === 'gone.md'), false);
    assert.equal(fileHeaders(diff, 'gone.md'), 0);
    assert.match(diff, /# Reverted or removed by the session .*: gone\.md/);
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R2: a root file named __proto__ is counted, left out while untouched, and kept through the baseline file', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    const { snapshot, diff, status } = await firstSnapshot(fx, () => writeFile(join(fx.mediator, '__proto__'), 'proto work\n'), 'true');
    assert.equal(status, 'awaiting_review');
    assert.deepEqual(snapshot.snapshot.export.preexisting, { paths: 4, untouched: 4, changed: [], removed: [], changed_more: 0, removed_more: 0 });
    assert.equal(snapshot.snapshot.export.changed_paths.includes('__proto__'), false);
    assert.ok(!diff.includes('proto work'), 'existing content is not exported');
    const baseline = await readFile(join(fx.mediator, 'factory-data', 'apps', fx.app, preexistingBaselineName('job-review')), 'utf8');
    assert.ok(baseline.includes('"__proto__"'), 'the path is in the serialized baseline');
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R2: removing a root file named __proto__ raises the deletion warning', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    const { snapshot, status, diagnostic } = await firstSnapshot(fx, () => writeFile(join(fx.mediator, '__proto__'), 'proto work\n'), 'rm __proto__');
    assert.equal(status, 'needs_operator');
    assert.equal(diagnostic, 'existing_work_removed');
    assert.deepEqual(snapshot.snapshot.export.preexisting?.removed, ['__proto__']);
    assert.equal(snapshot.snapshot.export.preexisting?.untouched, 3);
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R1: staging the recreated file is still an index change (git_operation_detected)', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    await selfHostedMediator(fx);
    await stagedDeletion(fx);
    const state = await enableSelfHosting(fx);
    await setStreamMode(fx, 'ok', { shell: "printf 'gone\\n' > gone.md; git add gone.md" });
    const job = 'job-index';
    const accepted = await acceptedJob(fx, job);
    const running = await startSupervisor(fx, { service: managedService(fx, { selfHosting: () => state.selfHostingGrant() }) });
    try {
      await authorize(fx, job, accepted, randomUUID());
      const ended = await waitForStatus(fx, job, (value) => value.status === 'needs_inspection', 'needs_inspection');
      assert.equal(ended.job?.diagnostic?.code, 'git_operation_detected');
    } finally {
      await running.stop();
    }
  } finally {
    await destroyFixture(fx);
  }
});

// Two apps registered for the mediator checkout (sf-a, sf-b) beside the fixture's pilot app.
async function twoSelfHostingApps(fx: Fixture): Promise<ExecutorState> {
  for (const app of ['sf-a', 'sf-b']) {
    await mkdir(join(fx.mediator, 'factory-data', 'apps', app), { mode: 0o700 });
    await writeFile(join(fx.mediator, 'factory-data', 'apps', app, '.env'), `APP_REPO=${fx.mediator}\n`, { mode: 0o600 });
  }
  return ExecutorState.open(fx.stateHome, fx.mediator);
}

const view = async (fx: Fixture, app: string) =>
  JSON.parse(await readFile(join(fx.mediator, 'factory-data', 'apps', app, 'executor-policy.json'), 'utf8')) as { enabled: boolean; isolation: string; repo_identity: string | null };

test('SH-R3: self-hosting A, global disable, then self-hosting B: A is withdrawn everywhere', async () => {
  const fx = await createExecutorFixture('pilot');
  try {
    const state = await twoSelfHostingApps(fx);
    await state.enable('sf-a', CLAUDE, [], new Date(), 'self_hosting_unconfined');
    const disabled = await state.disable(undefined);
    assert.deepEqual(Object.keys(disabled?.apps ?? {}), [], 'the stale self-hosting entry is not kept');
    assert.equal(await state.selfHosting(), undefined);
    const withdrawn = await view(fx, 'sf-a');
    assert.equal(withdrawn.enabled, false);
    assert.equal(withdrawn.isolation, 'none');
    assert.equal(withdrawn.repo_identity, null);

    const policy = await state.enable('sf-b', CLAUDE, [], new Date(), 'self_hosting_unconfined');
    assert.deepEqual(Object.keys(policy.apps), ['sf-b']);
    assert.deepEqual(Object.keys((await state.policy())?.apps ?? {}), ['sf-b'], 'the private policy on disk agrees');
    assert.equal((await state.selfHosting())?.app_id, 'sf-b');
    const b = await view(fx, 'sf-b');
    assert.equal(b.enabled, true);
    assert.equal(b.isolation, 'self_hosting_unconfined');
    assert.notEqual(b.repo_identity, null);
    const a = await view(fx, 'sf-a');
    assert.equal(a.enabled, false);
    assert.equal(a.isolation, 'none');
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R3: self-hosting A, global disable, then a separate pilot: no stale entry, no grant', async () => {
  const fx = await createExecutorFixture('pilot');
  try {
    const state = await twoSelfHostingApps(fx);
    await state.enable('sf-a', CLAUDE, [], new Date(), 'self_hosting_unconfined');
    await state.disable(undefined);
    const policy = await state.enable('pilot', CLAUDE, [], new Date(), 'disposable_pilot');
    assert.deepEqual(Object.keys(policy.apps), ['pilot']);
    assert.deepEqual(Object.keys((await state.policy())?.apps ?? {}), ['pilot']);
    assert.equal(await state.selfHosting(), undefined);
    assert.equal((await view(fx, 'pilot')).isolation, 'disposable_pilot');
    assert.equal((await view(fx, 'pilot')).enabled, true);
    assert.equal((await view(fx, 'sf-a')).enabled, false);
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R3: a failing public view changes nothing (no half-written policy or grant)', async () => {
  const fx = await createExecutorFixture('pilot');
  try {
    const state = await twoSelfHostingApps(fx);
    await state.enable('pilot', CLAUDE, [], new Date(), 'disposable_pilot');
    const before = await state.policy();
    // The pilot's registration breaks: its view can no longer be computed.
    await writeFile(join(fx.mediator, 'factory-data', 'apps', 'pilot', '.env'), `APP_REPO=${join(fx.sandbox, 'missing')}\n`, { mode: 0o600 });
    assert.equal(await code(state.enable('sf-a', CLAUDE, [], new Date(), 'self_hosting_unconfined')), 'invalid_repo');
    assert.deepEqual(await state.policy(), before);
    assert.equal(await state.selfHosting(), undefined);
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R4: after APP_REPO moves to another repository, status never presents it as the job\'s repository', async () => {
  const fx = await createExecutorFixture();
  try {
    await enableApp(fx);
    const state = await ExecutorState.open(fx.stateHome, fx.mediator);
    const job = 'job-moved';
    const accepted = await acceptedJob(fx, job);
    const running = await startSupervisor(fx);
    const other = join(fx.sandbox, 'app-b');
    let future = new Date(0);
    try {
      await authorize(fx, job, accepted, randomUUID());
      await waitForStatus(fx, job, (value) => value.status === 'awaiting_review', 'iteration-001 ready');
      const before = (await readStatus({ mediatorRoot: fx.mediator, state, projectsDir: fx.projects, job })).jobs[0]!;
      assert.equal(before.repository, fx.appRepo);
      assert.equal(before.repository_binding, 'verified');

      // The registration migrates to repository B while the job's session (in A) still lives.
      await mkdir(other);
      git(other, 'init', '-q');
      await writeFile(join(fx.mediator, 'factory-data', 'apps', fx.app, '.env'), `APP_REPO=${other}\n`, { mode: 0o600 });
      // A transcript for this session id in B's project directory, newer than anything else: it
      // would be the last activity if status looked for transcripts in B.
      const decoy = join(fx.projects, other.replace(/[^A-Za-z0-9]/g, '-'));
      await mkdir(decoy, { recursive: true });
      await writeFile(join(decoy, `${before.claude!.session_id}.jsonl`), '{}\n');
      future = new Date(Date.now() + 3_600_000);
      await utimes(join(decoy, `${before.claude!.session_id}.jsonl`), future, future);
      const live = (await readStatus({ mediatorRoot: fx.mediator, state, projectsDir: fx.projects, job })).jobs[0]!;
      assert.equal(live.repository_binding, 'mismatch');
      assert.equal(live.repository, fx.appRepo, 'the live Claude process shows where the job really runs');
      assert.equal(live.registered_now, other);
      assert.notEqual(Date.parse(live.last_activity!.at), future.getTime(), 'B\'s transcripts are not searched');
      const text = renderStatus(await readStatus({ mediatorRoot: fx.mediator, state, projectsDir: fx.projects, job }));
      assert.match(text, new RegExp(`registered now +${other} \\(NOT verified as this job's repository: mismatch\\)`));
    } finally {
      await running.stop();
    }
    // Once the session has ended, the job's repository is unknown, never B.
    const ended = (await readStatus({ mediatorRoot: fx.mediator, state, projectsDir: fx.projects, job })).jobs[0]!;
    assert.equal(ended.claude?.process?.alive, false);
    assert.equal(ended.repository, null);
    assert.equal(ended.repository_binding, 'mismatch');
    assert.match(ended.repository_note, /now names another repository/);
    assert.equal(ended.registered_now, other);
    assert.notEqual(Date.parse(ended.last_activity!.at), future.getTime(), 'B\'s transcripts are not searched');
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R5: an unreadable known job is shown with its code, and discovery is incomplete', async () => {
  const fx = await createExecutorFixture();
  try {
    const state = await ExecutorState.open(fx.stateHome, fx.mediator);
    await acceptedJob(fx, 'job-bad');
    await writeFile(join(jobDir(fx, 'job-bad'), 'managed.json'), 'not json', { mode: 0o600 });
    const report = await readStatus({ mediatorRoot: fx.mediator, state, projectsDir: fx.projects });
    assert.equal(report.discovery.complete, false);
    assert.deepEqual(report.discovery.issues, [{ code: 'job_unreadable', app_id: fx.app, job_id: 'job-bad', error: 'invalid_record' }]);
    assert.equal(report.jobs.length, 1);
    assert.equal(report.jobs[0]!.state, 'unreadable');
    assert.equal(report.jobs[0]!.read_error, 'invalid_record');
    const text = renderStatus(report);
    assert.match(text, /Discovery: {4}INCOMPLETE: job_unreadable app-one\/job-bad \(invalid_record\)/);
    assert.match(text, /read error +invalid_record/);
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R5: incomplete discovery is never reported as "no jobs"', async () => {
  const fx = await createExecutorFixture();
  try {
    const state = await ExecutorState.open(fx.stateHome, fx.mediator);
    // A second app whose jobs directory is a symlink: never followed, so its jobs are not seen.
    await mkdir(join(fx.mediator, 'factory-data', 'apps', 'app-two'), { mode: 0o700 });
    await mkdir(join(fx.sandbox, 'elsewhere'));
    await symlink(join(fx.sandbox, 'elsewhere'), join(fx.mediator, 'factory-data', 'apps', 'app-two', 'jobs'));
    const report = await readStatus({ mediatorRoot: fx.mediator, state, projectsDir: fx.projects });
    assert.equal(report.jobs.length, 0);
    assert.equal(report.discovery.complete, false);
    assert.deepEqual(report.discovery.issues, [{ code: 'jobs_not_directory', app_id: 'app-two', job_id: null, error: null }]);
    const text = renderStatus(report);
    assert.match(text, /No authorized or managed jobs found, but discovery was incomplete/);
    assert.ok(!text.includes('No authorized or managed jobs.\n'));

    // A complete, empty discovery still says so plainly.
    const clean = await createExecutorFixture();
    try {
      const plain = renderStatus(await readStatus({ mediatorRoot: clean.mediator, state: await ExecutorState.open(clean.stateHome, clean.mediator), projectsDir: clean.projects }));
      assert.match(plain, /Discovery: {4}complete/);
      assert.match(plain, /No authorized or managed jobs\./);
    } finally {
      await destroyFixture(clean);
    }
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R3: an opt-in record that no longer matches its entry is withdrawn with it', async () => {
  const fx = await createExecutorFixture('pilot');
  try {
    const state = await twoSelfHostingApps(fx);
    await state.enable('sf-a', CLAUDE, [], new Date(), 'self_hosting_unconfined');
    // The opt-in record names another checkout than the policy entry (e.g. written by hand).
    const record = JSON.parse(await readFile(join(state.dir, 'self-hosting.json'), 'utf8')) as Record<string, string>;
    await writeFile(join(state.dir, 'self-hosting.json'), JSON.stringify({ ...record, repo_sha256: '0'.repeat(64) }), { mode: 0o600 });
    const policy = await state.enable('pilot', CLAUDE, [], new Date(), 'disposable_pilot');
    assert.deepEqual(Object.keys(policy.apps), ['pilot']);
    assert.equal(await state.selfHosting(), undefined, 'no grant without its entry');
    assert.equal((await view(fx, 'sf-a')).enabled, false);
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R3: a disable whose views cannot be computed changes nothing, the grant included', async () => {
  const fx = await createExecutorFixture('pilot');
  try {
    const state = await twoSelfHostingApps(fx);
    await state.enable('pilot', CLAUDE, [], new Date(), 'disposable_pilot');
    await state.enable('sf-a', CLAUDE, [], new Date(), 'self_hosting_unconfined');
    const before = await state.policy();
    await writeFile(join(fx.mediator, 'factory-data', 'apps', 'pilot', '.env'), `APP_REPO=${join(fx.sandbox, 'missing')}\n`, { mode: 0o600 });
    assert.equal(await code(state.disable('sf-a')), 'invalid_repo');
    assert.deepEqual(await state.policy(), before);
    assert.equal((await state.selfHosting())?.app_id, 'sf-a');
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R4: an authorized job not yet launched is verified by its repo_identity; a moved registration is a mismatch', async () => {
  const fx = await createExecutorFixture();
  try {
    await enableApp(fx);
    const state = await ExecutorState.open(fx.stateHome, fx.mediator);
    const job = 'job-authorized';
    await authorize(fx, job, await acceptedJob(fx, job), randomUUID());
    const before = (await readStatus({ mediatorRoot: fx.mediator, state, projectsDir: fx.projects, job })).jobs[0]!;
    assert.equal(before.state, 'authorized');
    assert.equal(before.repository, fx.appRepo);
    assert.equal(before.repository_binding, 'verified');
    const other = join(fx.sandbox, 'app-b');
    await mkdir(other);
    git(other, 'init', '-q');
    await writeFile(join(fx.mediator, 'factory-data', 'apps', fx.app, '.env'), `APP_REPO=${other}\n`, { mode: 0o600 });
    const moved = (await readStatus({ mediatorRoot: fx.mediator, state, projectsDir: fx.projects, job })).jobs[0]!;
    assert.equal(moved.repository, null);
    assert.equal(moved.repository_binding, 'mismatch');
    assert.equal(moved.registered_now, other);
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R5: an unreadable execution.json and an unreadable opt-in record are coded issues, not absences', async () => {
  const fx = await createExecutorFixture();
  try {
    await enableApp(fx);
    const state = await ExecutorState.open(fx.stateHome, fx.mediator);
    const job = 'job-exec';
    await authorize(fx, job, await acceptedJob(fx, job), randomUUID());
    await writeFile(join(jobDir(fx, job), 'execution.json'), '{', { mode: 0o600 });
    await writeFile(join(state.dir, 'self-hosting.json'), 'not json', { mode: 0o600 });
    const report = await readStatus({ mediatorRoot: fx.mediator, state, projectsDir: fx.projects });
    assert.equal(report.discovery.complete, false);
    assert.deepEqual(report.discovery.issues.map((entry) => [entry.code, entry.job_id, entry.error]), [
      ['self_hosting_unreadable', null, 'invalid_record'],
      ['execution_unreadable', job, 'invalid_record'],
    ]);
    assert.match(renderStatus(report), /Discovery: {4}INCOMPLETE: self_hosting_unreadable \(invalid_record\), execution_unreadable app-one\/job-exec \(invalid_record\)/);
  } finally {
    await destroyFixture(fx);
  }
});

// SH-R3 (write failure): B's public view cannot be written (its app directory is read-only) while
// its registration stays readable. The failed enable must leave nothing runnable at a new epoch.
async function failingViewWrite(fx: Fixture, firstEnable: boolean): Promise<void> {
  const state = await twoSelfHostingApps(fx);
  if (!firstEnable) {
    await state.enable('sf-a', CLAUDE, [], new Date(), 'self_hosting_unconfined');
  }
  await state.enable('pilot', CLAUDE, [], new Date(), 'disposable_pilot');
  const before = await state.policy();
  const pilotDir = join(fx.mediator, 'factory-data', 'apps', 'pilot');
  await chmod(pilotDir, 0o500);
  try {
    await assert.rejects(state.enable('sf-a', CLAUDE, [], new Date(), 'self_hosting_unconfined'));
  } finally {
    await chmod(pilotDir, 0o700);
  }
  const after = await state.policy();
  assert.equal(policyRunnable(after), false, 'the partially published policy is not runnable');
  assert.equal(after?.epoch, (before?.epoch ?? 0) + 1);
  assert.equal(await state.selfHosting(), undefined, 'no grant during an incomplete enable');
  assert.equal(await code(Supervisor.start({ mediatorRoot: fx.mediator, stateHome: fx.stateHome, service: managedService(fx) })), 'not_ready');

  // Once the write can succeed, enable completes the transaction: committed, grant, views agree.
  const done = await state.enable('sf-a', CLAUDE, [], new Date(), 'self_hosting_unconfined');
  assert.equal(policyRunnable(await state.policy()), true);
  assert.deepEqual(Object.keys(done.apps).sort(), ['pilot', 'sf-a']);
  assert.equal((await state.selfHosting())?.app_id, 'sf-a');
  for (const app of ['pilot', 'sf-a']) {
    const published = (await view(fx, app)) as { enabled: boolean; policy_epoch?: number };
    assert.equal(published.enabled, true, app);
    assert.equal(published.policy_epoch, done.epoch, app);
  }
}

// A read-only directory does not stop root: these write-failure tests need an ordinary user.
const asRoot = { skip: process.getuid?.() === 0 ? 'read-only directories do not stop root' : false };

test('SH-R3: a view WRITE failure while re-enabling the self-hosting app leaves nothing runnable', asRoot, async () => {
  const fx = await createExecutorFixture('pilot');
  try {
    await failingViewWrite(fx, false);
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R3: a view WRITE failure on the first self-hosting enable leaves nothing runnable', asRoot, async () => {
  const fx = await createExecutorFixture('pilot');
  try {
    await failingViewWrite(fx, true);
  } finally {
    await destroyFixture(fx);
  }
});

test('SH-R3: a view WRITE failure while disabling leaves nothing runnable and withdraws the grant', asRoot, async () => {
  const fx = await createExecutorFixture('pilot');
  try {
    const state = await twoSelfHostingApps(fx);
    await state.enable('sf-a', CLAUDE, [], new Date(), 'self_hosting_unconfined');
    await state.enable('pilot', CLAUDE, [], new Date(), 'disposable_pilot');
    const pilotDir = join(fx.mediator, 'factory-data', 'apps', 'pilot');
    await chmod(pilotDir, 0o500);
    try {
      await assert.rejects(state.disable('sf-a'));
    } finally {
      await chmod(pilotDir, 0o700);
    }
    assert.equal(policyRunnable(await state.policy()), false);
    assert.equal(await state.selfHosting(), undefined);
    const done = await state.disable('sf-a');
    assert.equal(policyRunnable(await state.policy()), true);
    assert.deepEqual(Object.keys(done?.apps ?? {}), ['pilot']);
    assert.equal((await view(fx, 'sf-a')).enabled, false);
  } finally {
    await destroyFixture(fx);
  }
});
