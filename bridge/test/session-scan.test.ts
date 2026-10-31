// SF-007 Review 02, R2-2: the fail-closed scan for hand-started Claude sessions
// (run, handoff and preflight in SF-006). A record that could stand for a live
// session (running, pending_manual, interrupted) counts only with a valid
// session id; otherwise, and for an unknown state or schema, every launch is
// refused with a fixed diagnostic. Terminal and prepared records, including the
// earliest historical format, never block. Directories that cannot be inspected
// block; a mediator that was never initialized does not. No real Claude runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ProcessClaudeRunner } from '../src/execution/runner.js';
import { ExecutionService } from '../src/execution/service.js';
import { SessionGate } from '../src/execution/session-gate.js';
import { acceptedJob, createFixture, destroyFixture, fileReceiver, fixtureService, gatePath, git, invocations, jobDir, setMode, type Fixture } from './support/operator-fixture.js';
import { liveProcesses } from './support/pty.js';

let fx: Fixture;

before(async () => {
  fx = await createFixture();
  await setMode(fx, 'ok');
});

after(async () => {
  await destroyFixture(fx);
});

afterEach(async () => {
  for (const pid of await liveProcesses(join(fx.fakeDir, 'claude'))) process.kill(pid, 'SIGKILL');
  await setMode(fx, 'ok');
});

// A job whose execution.json is exactly `content` (it never runs; it only exists for the scan).
async function recordJob(job: string, content: string, app = fx.app): Promise<void> {
  await mkdir(jobDir(fx, job, app), { recursive: true });
  await writeFile(join(jobDir(fx, job, app), 'execution.json'), content);
}

const current = (state: string, session: unknown) => JSON.stringify({ schema: 'software-factory.execution/v1', app_id: fx.app, state, session });

async function prepared(job: string): Promise<void> {
  git(fx.appRepo, 'reset', '-q', '--hard');
  git(fx.appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
  await acceptedJob(fx, job);
  await fixtureService(fx).prepare(fx.app, job);
}

const claimed = (job: string) =>
  readFile(join(jobDir(fx, job), 'launch.claim')).then(
    () => true,
    () => false,
  );

// The blocked job: run refuses with session_busy and the fixed diagnostic; nothing is claimed or started.
async function assertBlocked(job: string, culprit: string, category: RegExp): Promise<void> {
  const calls = (await invocations(fx)).length;
  await assert.rejects(fixtureService(fx).run(fx.app, job, async () => true), (error: { code?: string; message: string }) => {
    assert.equal(error.code, 'session_busy', error.message);
    assert.match(error.message, new RegExp(`Running sessions cannot be verified: ${culprit.replaceAll('/', '\\/')} `));
    assert.match(error.message, category);
    assert.doesNotMatch(error.message, new RegExp(fx.sandbox));
    return true;
  });
  assert.equal(await claimed(job), false);
  assert.equal((await invocations(fx)).length, calls);
  // preflight reports the same, read-only.
  const report = await fixtureService(fx).preflight(fx.app, job);
  assert.ok(report.checks.some((check) => check.name === 'Claude session gate' && !check.ok && check.code === 'session_busy'));
}

test('a record that could be live but has no valid session id blocks every launch', async () => {
  await prepared('job-target');
  const cases: Array<[string, string]> = [
    ['missing', current('running', undefined)],
    ['null', current('running', null)],
    ['numeric', current('running', { id: 42 })],
    ['malformed', current('pending_manual', { id: 'not-a-uuid' })],
    ['invalid-uuid', current('interrupted', { id: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz' })],
    ['not-an-object', current('running', 'a5f2…')],
  ];
  for (const [label, content] of cases) {
    await recordJob(`job-bad-${label}`, content);
    await assertBlocked('job-target', `${fx.app}/job-bad-${label}`, /\(no valid session id\)/);
    await rm(jobDir(fx, `job-bad-${label}`), { recursive: true });
  }
});

test('an unknown state, schema or shape blocks; terminal and earliest-format records never do', async () => {
  await prepared('job-target-2');
  const blocking: Array<[string, string, RegExp]> = [
    ['unknown-state', current('paused', { id: randomUUID() }), /\(unknown state\)/],
    ['no-state', JSON.stringify({ schema: 'software-factory.execution/v1' }), /\(unknown state\)/],
    ['unknown-schema', JSON.stringify({ schema: 'something-else/v9', state: 'completed' }), /\(unknown schema\)/],
    ['array', '[]', /\(unknown schema\)/],
    ['not-json', '{"state": "running"', /\(not JSON\)/],
  ];
  for (const [label, content, category] of blocking) {
    await recordJob(`job-odd-${label}`, content);
    await assertBlocked('job-target-2', `${fx.app}/job-odd-${label}`, category);
    await rm(jobDir(fx, `job-odd-${label}`), { recursive: true });
  }
  // Not blocking: prepared, and terminal states whose session id is missing or invalid (Review 03: a valid
  // one would be a candidate for the liveness check, blocking only while a process carries it).
  await recordJob('job-done-garbage', current('completed', 'garbage'));
  await recordJob('job-failed-no-session', current('failed', undefined));
  await recordJob('job-inspect', current('needs_inspection', { id: 7 }));
  await recordJob('job-prepared-only', current('prepared', null));
  // The earliest SF-006 format, as in sf006-demo/demo-20261026a: changed_paths as a count, no ignored_initial.
  await recordJob('job-earliest', JSON.stringify({
    schema: 'software-factory.execution/v1', app_id: fx.app, job_id: 'job-earliest', request_id: randomUUID(), instruction_sha256: '0'.repeat(64),
    instruction_bytes: 10, state: 'completed', revision: 5, created_at: '2026-10-26T00:00:00Z', updated_at: '2026-10-26T00:00:00Z',
    destination: '.software-factory/jobs/job-earliest/instruction.md', acceptance: { openclaw_run_id: 'r', automation_id: 'a', receiver_accepted_at: 'x' },
    git_initial: { head: 'abc', index_sha256: '0'.repeat(64), changed_paths: 0 }, git_final: { head: 'abc', index_sha256: '0'.repeat(64), changed_paths: 1 },
    session: { id: randomUUID(), name: 'n', mode: 'interactive', runner: 'claude 2.1', started_at: 'x', ended_at: 'y', exit_code: 0, signal: null, pid: 1, pid_start: '1', boot_id: 'b' },
    evidence: { transcript_found: true, skill_invoked: true, args_match: true, cwd_match: true }, artifacts: {}, error: null, recovery: null, history: [],
  }));
  assert.equal((await fixtureService(fx).run(fx.app, 'job-target-2', async () => true)).state, 'completed');
});

test('well-formed records: blocked only while their session process runs (--session-id or --resume)', async () => {
  await prepared('job-target-3');
  const idle = randomUUID();
  const live = randomUUID();
  const liveById = randomUUID();
  await recordJob('job-idle-manual', current('pending_manual', { id: idle }));
  await recordJob('job-live-resume', current('interrupted', { id: live }));
  // Recorded in upper case: still matched against the lower-case id on the command line.
  await recordJob('job-live-session-id', current('pending_manual', { id: liveById.toUpperCase() }));
  await setMode(fx, 'hang');
  // Started by hand elsewhere, so it does not touch the app repository of the job under test.
  await mkdir(join(fx.sandbox, 'resume-cwd'), { recursive: true });
  const byId = spawn(join(fx.fakeDir, 'claude'), ['--permission-mode', 'manual', '--session-id', liveById, '/implement x'], { cwd: join(fx.sandbox, 'resume-cwd'), stdio: 'ignore' });
  for (let attempt = 0; attempt < 200 && (await liveProcesses(join(fx.fakeDir, 'claude'))).length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await assert.rejects(fixtureService(fx).run(fx.app, 'job-target-3', async () => true), (error: { code?: string; message: string }) => {
    assert.equal(error.code, 'session_busy');
    assert.match(error.message, new RegExp(`hand-started Claude session is running for ${fx.app}/job-live-session-id`));
    return true;
  });
  byId.kill('SIGKILL');
  await new Promise((resolve) => byId.once('exit', resolve));
  const resumed = spawn(join(fx.fakeDir, 'claude'), ['--resume', live, '--session-id', 'x', 'resume'], { cwd: join(fx.sandbox, 'resume-cwd'), stdio: 'ignore' });
  for (let attempt = 0; attempt < 200 && (await liveProcesses(join(fx.fakeDir, 'claude'))).length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await assert.rejects(fixtureService(fx).run(fx.app, 'job-target-3', async () => true), (error: { code?: string; message: string }) => {
    assert.equal(error.code, 'session_busy');
    assert.match(error.message, new RegExp(`hand-started Claude session is running for ${fx.app}/job-live-resume`));
    return true;
  });
  assert.equal(await claimed('job-target-3'), false);
  resumed.kill('SIGKILL');
  await new Promise((resolve) => resumed.once('exit', resolve));
  await rm(jobDir(fx, 'job-live-session-id'), { recursive: true });
  await setMode(fx, 'ok');
  // The idle handed-off record has no process: it does not block.
  assert.equal((await fixtureService(fx).run(fx.app, 'job-target-3', async () => true)).state, 'completed');
  await rm(jobDir(fx, 'job-idle-manual'), { recursive: true });
  await rm(jobDir(fx, 'job-live-resume'), { recursive: true });
});

test('uninspectable app or jobs directories block; a never-initialized mediator does not', async () => {
  await prepared('job-target-4');
  const apps = join(fx.mediator, 'factory-data', 'apps');
  // A symlinked app directory and a symlinked jobs directory (never followed).
  await mkdir(join(fx.sandbox, 'elsewhere', 'jobs', 'job-hidden'), { recursive: true });
  await writeFile(join(fx.sandbox, 'elsewhere', 'jobs', 'job-hidden', 'execution.json'), current('running', { id: randomUUID() }));
  await symlink(join(fx.sandbox, 'elsewhere'), join(apps, 'app-linked'));
  await assertBlocked('job-target-4', 'factory-data/apps/app-linked', /\(app directory is a symlink or not a directory\)/);
  await rm(join(apps, 'app-linked'));
  await mkdir(join(apps, 'app-linked-jobs'));
  await symlink(join(fx.sandbox, 'elsewhere', 'jobs'), join(apps, 'app-linked-jobs', 'jobs'));
  await assertBlocked('job-target-4', 'factory-data/apps/app-linked-jobs/jobs', /\(jobs directory is a symlink or not a directory\)/);
  await rm(join(apps, 'app-linked-jobs'), { recursive: true });
  // An unreadable jobs directory (runs unprivileged only: root ignores permissions).
  if (process.getuid?.() !== 0) {
    await mkdir(join(apps, 'app-locked', 'jobs'), { recursive: true });
    await chmod(join(apps, 'app-locked', 'jobs'), 0o000);
    await assertBlocked('job-target-4', 'factory-data/apps/app-locked/jobs', /\(jobs directory cannot be listed\)/);
    await chmod(join(apps, 'app-locked', 'jobs'), 0o700);
    await rm(join(apps, 'app-locked'), { recursive: true });
  }
  // A registered app without jobs yet is fine.
  await mkdir(join(apps, 'app-new'));
  assert.equal((await fixtureService(fx).run(fx.app, 'job-target-4', async () => true)).state, 'completed');

  // A mediator that was never initialized (no factory-data): the gate check passes.
  const empty = await realpath(await mkdtemp(join(tmpdir(), 'sf-empty-mediator-')));
  try {
    const service = new ExecutionService({
      mediatorRoot: empty,
      receiverLookup: (requestId) => fileReceiver(fx.receiverDir, requestId),
      runner: new ProcessClaudeRunner(join(fx.fakeDir, 'claude'), 'fake 0.0.0', 'ignore', new SessionGate(gatePath(fx))),
      claudeProjectsDir: fx.projects,
      claudeConfigDir: fx.claudeConfigDir,
      authStatus: async () => ({ loggedIn: true, method: 'fake' }),
      insideClaudeSession: false,
    });
    const report = await service.preflight('app-x', 'job-x');
    assert.ok(report.checks.some((check) => check.name === 'Claude session gate' && check.ok));
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

// ---- Review 03, R3-2: a terminal record's session can be resumed by hand ----

test('a completed (or failed / needs_inspection) job resumed by hand blocks every launch while it runs, then not', async () => {
  await prepared('job-target-5');
  await acceptedJob(fx, 'job-target-console');
  const { approve } = await import('../src/operator/approval.js');
  const { inspectJob } = await import('../src/operator/queue.js');
  const { OperatorStore } = await import('../src/operator/store.js');
  const deps = { mediatorRoot: fx.mediator, store: await OperatorStore.open(fx.stateHome, fx.mediator), service: fixtureService(fx), now: () => new Date() };
  await mkdir(join(fx.sandbox, 'resume-cwd'), { recursive: true });
  await setMode(fx, 'hang');
  const cases: Array<[string, string, (id: string) => string[]]> = [
    ['completed', 'completed', (id) => ['--resume', id]],
    ['completed-equals', 'completed', (id) => [`--resume=${id}`]],
    ['completed-mixed-case', 'completed', (id) => ['--resume', id.toUpperCase().replace(/^(.{4})/, (head) => head.toLowerCase())]],
    ['failed', 'failed', (id) => ['--resume', id]],
    ['needs-inspection', 'needs_inspection', (id) => ['--session-id', id]],
  ];
  for (const [label, state, args] of cases) {
    const id = randomUUID();
    const job = `job-resumed-${label}`;
    await recordJob(job, current(state, { id }));
    // Resumed by hand, without the gated command.
    const resumed = spawn(join(fx.fakeDir, 'claude'), [...args(id), 'resume'], { cwd: join(fx.sandbox, 'resume-cwd'), stdio: 'ignore' });
    for (let attempt = 0; attempt < 200 && (await liveProcesses(join(fx.fakeDir, 'claude'))).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // The manual CLI, preflight and the console are all refused before any claim.
    await assert.rejects(fixtureService(fx).run(fx.app, 'job-target-5', async () => true), (error: { code?: string; message: string }) => {
      assert.equal(error.code, 'session_busy', label);
      assert.match(error.message, new RegExp(`hand-started Claude session is running for ${fx.app}/${job}`), label);
      return true;
    });
    const report = await fixtureService(fx).preflight(fx.app, 'job-target-5');
    assert.ok(report.checks.some((check) => check.name === 'Claude session gate' && check.code === 'session_busy'), label);
    const entry = await inspectJob(deps, fx.app, 'job-target-console');
    await assert.rejects(approve(deps, fx.app, 'job-target-console', { request_id: entry!.request_id!, instruction_sha256: entry!.instruction_sha256! }), { code: 'busy' }, label);
    assert.equal(await claimed('job-target-5'), false, label);
    assert.equal((await liveProcesses(join(fx.fakeDir, 'claude'))).length, 1, label);
    resumed.kill('SIGKILL');
    await new Promise((resolve) => resumed.once('exit', resolve));
    // The same record no longer blocks once its session has ended.
    const reportAfter = await fixtureService(fx).preflight(fx.app, 'job-target-5');
    assert.ok(reportAfter.checks.some((check) => check.name === 'Claude session gate' && check.ok), `${label}: still blocked after exit`);
    await rm(jobDir(fx, job), { recursive: true });
  }
  // An earliest-format terminal record without a usable session identity never blocks.
  await recordJob('job-earliest-no-identity', JSON.stringify({ schema: 'software-factory.execution/v1', app_id: fx.app, state: 'completed', git_initial: { changed_paths: 0 }, session: { name: 'n', mode: 'interactive' } }));
  // After the resumed session ended (and with completed records whose sessions are not running), the launch works.
  await recordJob('job-completed-idle', current('completed', { id: randomUUID() }));
  await recordJob('job-completed-no-identity', current('completed', null));
  await setMode(fx, 'ok');
  assert.equal((await fixtureService(fx).run(fx.app, 'job-target-5', async () => true)).state, 'completed');
});
