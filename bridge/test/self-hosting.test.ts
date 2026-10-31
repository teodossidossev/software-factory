// SF-009 self-hosting: the operator's separate, local opt-in that lets one app work on the Software
// Factory checkout itself, beside the operator's uncommitted work. Runs against a throwaway
// mediator that is also the app repository, with a fake stream-json Claude; no real Claude Code.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { loadAppConfig } from '../src/execution/app-config.js';
import { SELF_HOSTED_DENIED_TOOLS } from '../src/execution/runner.js';
import { preexistingBaselineName } from '../src/execution/service.js';
import { ExecutorState, repoSha256 } from '../src/executor/policy.js';
import { readStatus, renderStatus, waitingReason } from '../src/executor/status.js';
import { acceptedJob, createFixture, destroyFixture, git, invocations, jobDir, sha256, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, managedService, setStreamMode, startSupervisor, waitForStatus } from './support/executor-fixture.js';
import { CLAUDE, code, enableSelfHosting, EXISTING, existingWorkIntact, selfHostedMediator } from './support/self-hosting-fixture.js';

test('app config: the mediator only with a matching self-hosting grant; ancestors and descendants never', async () => {
  const fx = await createFixture('sf-self');
  try {
    await writeFile(join(fx.mediator, 'factory-data', 'apps', fx.app, '.env'), `APP_REPO=${fx.mediator}\n`, { mode: 0o600 });
    const sha = repoSha256(fx.mediator);
    assert.equal(await code(loadAppConfig(fx.mediator, fx.app)), 'invalid_repo', 'refused by default');
    assert.equal(await code(loadAppConfig(fx.mediator, fx.app, { appId: 'other-app', repoSha256: sha })), 'invalid_repo', 'a grant for another app');
    assert.equal(await code(loadAppConfig(fx.mediator, fx.app, { appId: fx.app, repoSha256: '0'.repeat(64) })), 'invalid_repo', 'a grant for another checkout');
    assert.deepEqual(await loadAppConfig(fx.mediator, fx.app, { appId: fx.app, repoSha256: sha }), { appId: fx.app, repo: fx.mediator, selfHosted: true });

    // A repository inside the mediator, and one containing it, stay refused even with the grant.
    const inner = join(fx.mediator, 'nested');
    await mkdir(inner);
    git(inner, 'init', '-q');
    for (const repo of [inner, fx.sandbox]) {
      if (repo === fx.sandbox) {
        git(fx.sandbox, 'init', '-q');
      }
      await writeFile(join(fx.mediator, 'factory-data', 'apps', fx.app, '.env'), `APP_REPO=${repo}\n`, { mode: 0o600 });
      assert.equal(await code(loadAppConfig(fx.mediator, fx.app, { appId: fx.app, repoSha256: repoSha256(repo) })), 'invalid_repo', repo === inner ? 'descendant' : 'ancestor');
    }
    // A separate repository is unaffected by the grant and is not self-hosted.
    await writeFile(join(fx.mediator, 'factory-data', 'apps', fx.app, '.env'), `APP_REPO=${fx.appRepo}\n`, { mode: 0o600 });
    assert.deepEqual(await loadAppConfig(fx.mediator, fx.app, { appId: fx.app, repoSha256: sha }), { appId: fx.app, repo: fx.appRepo });
  } finally {
    await destroyFixture(fx);
  }
});

test('opt-in: separate private record bound to the app and this checkout; never a disposable pilot', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    const state = await ExecutorState.open(fx.stateHome, fx.mediator);
    // An app with a separate repository cannot be enabled for self-hosting.
    assert.equal(await code(state.enable(fx.app, CLAUDE, [], new Date(), 'self_hosting_unconfined')), 'unsafe_state');
    assert.equal(await state.selfHosting(), undefined);

    await writeFile(join(fx.mediator, 'factory-data', 'apps', fx.app, '.env'), `APP_REPO=${fx.mediator}\n`, { mode: 0o600 });
    // As a disposable pilot the mediator stays refused (no grant), and isolation none is never enabled.
    assert.equal(await code(state.enable(fx.app, CLAUDE, [], new Date(), 'disposable_pilot')), 'invalid_repo');
    assert.equal(await code(state.enable(fx.app, CLAUDE, [], new Date(), 'none')), 'unsupported_isolation');

    const policy = await state.enable(fx.app, CLAUDE, [], new Date(), 'self_hosting_unconfined');
    assert.equal(policy.apps[fx.app]?.isolation, 'self_hosting_unconfined');
    assert.equal(policy.apps[fx.app]?.app_repo_sha256, repoSha256(fx.mediator));
    const record = await state.selfHosting();
    assert.equal(record?.app_id, fx.app);
    assert.equal(record?.repo_sha256, repoSha256(fx.mediator));
    assert.equal(record?.declaration, 'operator_controlled_unconfined');
    assert.equal((await stat(join(state.dir, 'self-hosting.json'))).mode & 0o777, 0o600);
    const view = JSON.parse(await readFile(join(fx.mediator, 'factory-data', 'apps', fx.app, 'executor-policy.json'), 'utf8')) as { isolation: string; repo_identity: string | null };
    assert.equal(view.isolation, 'self_hosting_unconfined');
    assert.notEqual(view.repo_identity, null);
    assert.ok(!JSON.stringify(view).includes(fx.mediator), 'no host path in the public view');

    // One self-hosting app at a time; it cannot be re-enabled as a disposable pilot.
    await mkdir(join(fx.mediator, 'factory-data', 'apps', 'sf-other'), { mode: 0o700 });
    await writeFile(join(fx.mediator, 'factory-data', 'apps', 'sf-other', '.env'), `APP_REPO=${fx.mediator}\n`, { mode: 0o600 });
    assert.equal(await code(state.enable('sf-other', CLAUDE, [], new Date(), 'self_hosting_unconfined')), 'conflict');
    assert.equal(await code(state.enable(fx.app, CLAUDE, [], new Date(), 'disposable_pilot')), 'conflict');

    // disable withdraws the opt-in with its app.
    await state.disable(fx.app);
    assert.equal(await state.selfHosting(), undefined);
    assert.equal(await code(loadAppConfig(fx.mediator, fx.app, await state.selfHostingGrant())), 'invalid_repo');
  } finally {
    await destroyFixture(fx);
  }
});

test('prepare: a dirty repository stays refused without self-hosting (repo_dirty)', async () => {
  const fx = await createExecutorFixture();
  try {
    await writeFile(join(fx.appRepo, 'wip.txt'), 'existing work\n');
    await acceptedJob(fx, 'job-dirty');
    const service = managedService(fx);
    assert.equal(await code(service.prepare(fx.app, 'job-dirty')), 'repo_dirty');
    const report = await service.preflight(fx.app, 'job-dirty');
    assert.equal(report.checks.find((check) => check.name === 'app repository clean')?.code, 'repo_dirty');
    assert.equal(await readFile(join(fx.appRepo, 'wip.txt'), 'utf8'), 'existing work\n');
  } finally {
    await destroyFixture(fx);
  }
});

test('prepare: self-hosting records a verified baseline of the existing work; the launch needs it unchanged', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    await selfHostedMediator(fx);
    const state = await enableSelfHosting(fx);
    const service = managedService(fx, { selfHosting: () => state.selfHostingGrant() });
    // Without the opt-in wired in, the mediator stays refused.
    await acceptedJob(fx, 'job-base');
    assert.equal(await code(managedService(fx).prepare(fx.app, 'job-base')), 'invalid_repo');

    const report = await service.preflight(fx.app, 'job-base');
    assert.equal(report.checks.find((check) => check.name === 'existing work baseline')?.ok, true);
    assert.equal(report.checks.some((check) => check.code === 'repo_dirty'), false);
    await service.prepare(fx.app, 'job-base');
    const record = JSON.parse(await readFile(join(jobDir(fx, 'job-base'), 'execution.json'), 'utf8')) as { preexisting: { paths: number; sha256: string }; git_initial: { changed_paths: string[] } };
    assert.equal(record.preexisting.paths, 3);
    assert.deepEqual(record.git_initial.changed_paths, [], 'existing paths are not listed in the record');
    const baselinePath = join(fx.mediator, 'factory-data', 'apps', fx.app, preexistingBaselineName('job-base'));
    const baselineBytes = await readFile(baselinePath);
    assert.equal(sha256(baselineBytes), record.preexisting.sha256);
    assert.equal((await stat(baselinePath)).mode & 0o777, 0o600);
    const baseline = JSON.parse(baselineBytes.toString('utf8')) as { entries: Array<[string, string]> };
    assert.deepEqual(baseline.entries.map(([path]) => path), ['notes.md', 'staged.txt', 'wip.txt']);
    assert.ok(!baselineBytes.toString('utf8').includes('work in progress'), 'hashes only, no content');
    await existingWorkIntact(fx);

    // The operator changes existing work after prepare: nothing launches.
    await writeFile(join(fx.mediator, 'wip.txt'), 'work in progress\nmore\n');
    const drive = async () => ({ kind: 'ended' as const });
    const expected = { requestId: (record as unknown as { request_id: string }).request_id, instructionSha256: (record as unknown as { instruction_sha256: string }).instruction_sha256, appRepoSha256: repoSha256(fx.mediator) };
    assert.equal(await code(service.runManaged(fx.app, 'job-base', expected, drive)), 'repo_changed');
    await writeFile(join(fx.mediator, 'wip.txt'), EXISTING['wip.txt']);
    // A baseline that is not the recorded one: nothing launches either.
    await writeFile(baselinePath, baselineBytes.toString('utf8').replace('"wip.txt"', '"other.txt"'), { mode: 0o600 });
    assert.equal(await code(service.runManaged(fx.app, 'job-base', expected, drive)), 'baseline_invalid');
    assert.equal((await invocations(fx)).length, 0, 'no Claude process was started');
  } finally {
    await destroyFixture(fx);
  }
});

test('self-hosting end to end: authorized once, the job diff leaves existing work out, final acceptance closes', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    await selfHostedMediator(fx);
    const state = await enableSelfHosting(fx);
    const job = 'job-self';
    const accepted = await acceptedJob(fx, job);
    const running = await startSupervisor(fx, { service: managedService(fx, { selfHosting: () => state.selfHostingGrant() }) });
    try {
      const status = await gateway(fx).status(fx.app, job);
      assert.equal(status.policy?.isolation, 'self_hosting_unconfined');
      await authorize(fx, job, accepted, randomUUID());
      const ready = await waitForStatus(fx, job, (value) => value.status === 'awaiting_review', 'iteration-001 ready');
      assert.equal(ready.job?.current_iteration, 'iteration-001');

      const calls = await invocations(fx);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.cwd, fx.mediator, 'the session works in the mediator checkout');
      for (const denied of SELF_HOSTED_DENIED_TOOLS) {
        assert.ok(calls[0]!.argv.includes(denied), `${denied} is denied`);
      }

      const snap = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
      assert.deepEqual(snap.snapshot.export.changed_paths, ['README.md']);
      assert.deepEqual(snap.snapshot.export.preexisting, { paths: 3, untouched: 3, changed: [], removed: [], changed_more: 0, removed_more: 0 });
      const diff = await readFile(join(fx.mediator, snap.diff.path), 'utf8');
      assert.match(diff, /^# Existing uncommitted work: 3 path\(s\) recorded before the session; 3 unchanged/);
      assert.match(diff, /\+iteration 1/);
      for (const content of Object.values(EXISTING)) {
        assert.ok(!diff.includes(content.trim()), 'existing work is not in the diff');
      }
      const report = await readFile(join(jobDir(fx, job), 'iteration-001.report.md'), 'utf8');
      assert.match(report, /Existing uncommitted work \(self-hosting baseline\) \| 3 path\(s\), 3 unchanged/);

      // The operator's status view: the actual repository, app/job, the process, the iteration and why it waits.
      const view = await readStatus({ mediatorRoot: fx.mediator, state, projectsDir: fx.projects });
      assert.equal(view.jobs.length, 1);
      const entry = view.jobs[0]!;
      assert.equal(entry.repository, fx.mediator);
      assert.match(entry.repository_note, /this Software Factory checkout/);
      assert.equal(entry.isolation, 'self_hosting_unconfined');
      assert.equal(entry.state, 'awaiting_review');
      assert.equal(entry.iteration?.id, 'iteration-001');
      assert.equal(entry.claude?.process?.pid, calls[0]!.pid);
      assert.equal(entry.claude?.process?.alive, true);
      assert.notEqual(entry.last_activity, null);
      assert.match(entry.waiting, /review or acceptance of iteration-001/);
      const text = renderStatus(view);
      assert.match(text, new RegExp(`app ${fx.app} / job ${job}`));
      assert.match(text, new RegExp(`pid ${calls[0]!.pid} \\(start \\d+\\), alive`));
      assert.match(text, /Self-hosting: enabled for sf-self .*unconfined: no sandbox/);
      assert.match(text, /Supervisor: {3}running/);

      await gateway(fx).accept({ app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, acceptance_id: randomUUID() });
      const closed = await waitForStatus(fx, job, (value) => value.status === 'closed', 'closed');
      assert.equal(closed.job?.execution_state, 'completed');
      const exported = await readFile(join(jobDir(fx, job), 'implementation.diff'), 'utf8');
      assert.equal(sha256(exported), snap.diff.sha256, 'the collected diff is the accepted one');
      assert.match(await readFile(join(jobDir(fx, job), 'report.md'), 'utf8'), /Existing work unchanged \| 3 \|/);
    } finally {
      await running.stop();
    }
    await existingWorkIntact(fx);
    assert.match(await readFile(join(fx.mediator, 'README.md'), 'utf8'), /iteration 1/);
    assert.equal(git(fx.mediator, 'rev-list', '--count', 'HEAD').trim(), '1', 'nothing was committed');
  } finally {
    await destroyFixture(fx);
  }
});

test('self-hosting: existing work the session removes is named and needs the operator', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    await selfHostedMediator(fx);
    const state = await enableSelfHosting(fx);
    await setStreamMode(fx, 'ok', { shell: 'rm wip.txt' });
    const job = 'job-removes';
    const accepted = await acceptedJob(fx, job);
    const running = await startSupervisor(fx, { service: managedService(fx, { selfHosting: () => state.selfHostingGrant() }) });
    try {
      await authorize(fx, job, accepted, randomUUID());
      const status = await waitForStatus(fx, job, (value) => value.status === 'needs_operator', 'needs_operator');
      assert.equal(status.job?.diagnostic?.code, 'existing_work_removed');
      const snap = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
      assert.deepEqual(snap.snapshot.export.preexisting?.removed, ['wip.txt']);
      assert.equal(snap.snapshot.export.preexisting?.untouched, 2);
      assert.match(await readFile(join(fx.mediator, snap.diff.path), 'utf8'), /# Reverted or removed by the session .*: wip\.txt/);
    } finally {
      await running.stop();
    }
  } finally {
    await destroyFixture(fx);
  }
});

test('self-hosting: existing work the session changes is named; a deletion before the job and factory-data writes are not job changes', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    await selfHostedMediator(fx);
    // A committed file the operator deleted before the job: existing work, too.
    await writeFile(join(fx.mediator, 'old.md'), 'old\n');
    git(fx.mediator, 'add', 'old.md');
    // Only old.md: staged.txt stays staged, uncommitted.
    git(fx.mediator, 'commit', '-q', '-m', 'old', '--', 'old.md');
    await rm(join(fx.mediator, 'old.md'));
    const state = await enableSelfHosting(fx);
    // The session appends to a file that already held uncommitted work, and writes mediator state.
    await setStreamMode(fx, 'ok', { shell: 'echo session-line >> notes.md; echo x > factory-data/session-scratch.txt' });
    const job = 'job-changes';
    const accepted = await acceptedJob(fx, job);
    const running = await startSupervisor(fx, { service: managedService(fx, { selfHosting: () => state.selfHostingGrant() }) });
    try {
      await authorize(fx, job, accepted, randomUUID());
      const ready = await waitForStatus(fx, job, (value) => value.status === 'awaiting_review', 'iteration-001 ready');
      assert.equal(ready.job?.diagnostic, null);
      const snap = await gateway(fx).snapshot(fx.app, job, 'iteration-001');
      assert.deepEqual(snap.snapshot.export.preexisting, { paths: 4, untouched: 3, changed: ['notes.md'], removed: [], changed_more: 0, removed_more: 0 });
      assert.deepEqual([...snap.snapshot.export.changed_paths].sort(), ['README.md', 'notes.md']);
      const diff = await readFile(join(fx.mediator, snap.diff.path), 'utf8');
      assert.match(diff, /# Changed by the session although they held uncommitted work before it .*: notes\.md/);
      assert.match(diff, /\+session-line/);
      assert.ok(!diff.includes('old.md'), 'the earlier deletion is not shown as a job change');
      assert.ok(!diff.includes('session-scratch'), 'mediator state is never exported');
    } finally {
      await running.stop();
    }
  } finally {
    await destroyFixture(fx);
  }
});

test('self-hosting: the supervisor refuses a self-hosting app whose separate opt-in is gone', async () => {
  const fx = await createExecutorFixture('sf-self');
  try {
    await selfHostedMediator(fx);
    const state = await enableSelfHosting(fx);
    const job = 'job-no-optin';
    const accepted = await acceptedJob(fx, job);
    await authorize(fx, job, accepted, randomUUID());
    // The opt-in record alone is removed (the policy entry stays): nothing may launch.
    await rm(join(state.dir, 'self-hosting.json'));
    const running = await startSupervisor(fx, { service: managedService(fx, { selfHosting: () => state.selfHostingGrant() }) });
    try {
      const status = await waitForStatus(fx, job, (value) => value.status === 'blocked', 'blocked');
      assert.equal(status.job?.diagnostic?.code, 'self_hosting_not_enabled');
      assert.equal((await invocations(fx)).length, 0);
    } finally {
      await running.stop();
    }
  } finally {
    await destroyFixture(fx);
  }
});

test('a disposable pilot is unaffected: separate repository, no baseline, no extra deny rules', async () => {
  const fx = await createExecutorFixture();
  try {
    await enableApp(fx);
    const state = await ExecutorState.open(fx.stateHome, fx.mediator);
    assert.equal(await state.selfHosting(), undefined);
    await acceptedJob(fx, 'job-pilot');
    await managedService(fx).prepare(fx.app, 'job-pilot');
    const record = JSON.parse(await readFile(join(jobDir(fx, 'job-pilot'), 'execution.json'), 'utf8')) as Record<string, unknown>;
    assert.equal('preexisting' in record, false);
  } finally {
    await destroyFixture(fx);
  }
});

test('status: why a job waits, in words', () => {
  const now = new Date('2026-10-29T10:00:00Z');
  const future = { expires_at: '2026-10-29T10:20:00Z' };
  assert.match(waitingReason(undefined, future, false, now), /supervisor: it is not running/);
  assert.match(waitingReason(undefined, future, true, now), /next pass/);
  assert.match(waitingReason(undefined, { expires_at: '2026-10-29T09:00:00Z' }, true, now), /expired/);
});
