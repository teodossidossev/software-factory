// SF-009 Review 01, R1-4: bounded discovery is never silently incomplete. The supervisor reports
// its last scan in the heartbeat (complete, counts, bounded issue codes with app ids, no paths), the
// bridge's status never calls an authorized job "pending_supervisor" while that scan is incomplete,
// and the review-ready listing says when it may omit entries. The bounds are lowered through the
// test seams (scanLimits, the gateway's limits) to reach them quickly; the defaults are checked too.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { ExecutionGateway } from '../src/executor/gateway.js';
import { HEARTBEAT_FILE, heartbeatSchema, SCAN_LIMITS, type ScanSummary } from '../src/executor/records.js';
import { FactoryJobs } from '../src/factory-jobs.js';
import { acceptedJob, destroyFixture, invocations, jobDir, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, startSupervisor, waitFor } from './support/executor-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

const LIMITS = { apps: 3, jobs: 4 };
const apps = (fx: Fixture) => join(fx.mediator, 'factory-data', 'apps');

async function fixture(): Promise<Fixture> {
  const fx = await createExecutorFixture();
  cleanup.push(async () => {
    // Undo permission changes so the throwaway tree can be removed.
    await chmod(join(apps(fx), fx.app, 'jobs'), 0o700).catch(() => undefined);
    await destroyFixture(fx);
  });
  await enableApp(fx);
  return fx;
}

async function supervisor(fx: Fixture, limits = LIMITS): Promise<void> {
  const running = await startSupervisor(fx, { scanLimits: limits });
  cleanup.push(running.stop);
}

// Plain, private job directories without records.
async function emptyJobs(fx: Fixture, app: string, names: string[]): Promise<void> {
  for (const name of names) await mkdir(join(apps(fx), app, 'jobs', name), { recursive: true, mode: 0o700 });
}

async function otherApps(fx: Fixture, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, index) => `app-x${String(index).padStart(2, '0')}`);
  for (const id of ids) await mkdir(join(apps(fx), id, 'jobs'), { recursive: true, mode: 0o700 });
  return ids;
}

// The supervisor's last scan from its heartbeat (as the bridge reads it), once it matches.
const scan = (fx: Fixture, wanted: (value: ScanSummary) => boolean, what: string) =>
  waitFor(async () => {
    const heartbeat = heartbeatSchema.parse(JSON.parse(await readFile(join(fx.mediator, 'factory-data', HEARTBEAT_FILE), 'utf8')));
    return heartbeat.scan !== undefined && wanted(heartbeat.scan) ? { supervisor: { scan: heartbeat.scan } } : undefined;
  }, what);

const codes = (issues: Array<{ code: string; app_id: string | null }>) => issues.map((issue) => `${issue.code}${issue.app_id ? `:${issue.app_id}` : ''}`).sort();

test('the default bounds are the documented ones', () => {
  assert.deepEqual(SCAN_LIMITS, { apps: 100, jobs: 5000, readyJobsPerApp: 1000, ready: 200 });
});

test('a healthy complete scan is reported as complete, and an authorized job is pending until taken', async () => {
  const fx = await fixture();
  await emptyJobs(fx, fx.app, ['job-a']);
  const accepted = await acceptedJob(fx, 'job-b');
  await supervisor(fx);
  const status = await scan(fx, (value) => value.complete && value.jobs === 2, 'complete scan');
  assert.deepEqual(status.supervisor.scan.issues, []);
  assert.equal(status.supervisor.scan.apps, 1);
  assert.equal((await gateway(fx).status(fx.app, 'job-b')).status, 'not_authorized');
  await authorize(fx, 'job-b', accepted, randomUUID());
  await waitFor(async () => (await gateway(fx).status(fx.app, 'job-b')).status === 'awaiting_review', 'launched');
});

test('exactly the job bound is complete; one above it is SCAN INCOMPLETE and the omitted authorized job is never shown as pending, processed or blocked', async () => {
  const fx = await fixture();
  // job-a .. job-d plus job-z (sorted last): five jobs against a bound of four.
  await emptyJobs(fx, fx.app, ['job-a', 'job-b', 'job-c', 'job-d']);
  const accepted = await acceptedJob(fx, 'job-z');
  const lines: string[] = [];
  const running = await startSupervisor(fx, { scanLimits: LIMITS, log: (line) => lines.push(line) });
  cleanup.push(running.stop);
  await authorize(fx, 'job-z', accepted, randomUUID());
  const incomplete = await scan(fx, (value) => !value.complete, 'incomplete scan');
  assert.deepEqual(codes(incomplete.supervisor.scan!.issues), [`job_limit:${fx.app}`]);
  assert.equal(incomplete.supervisor.scan!.jobs, 4);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const omitted = await gateway(fx).status(fx.app, 'job-z');
  assert.equal(omitted.status, 'scan_incomplete');
  assert.match(omitted.note, /may be outside what it scans\. Nothing was started/);
  assert.equal(omitted.job, null, 'no managed record: neither processed nor blocked');
  assert.equal((await invocations(fx)).length, 0);
  assert.ok(lines.some((line) => /^SCAN INCOMPLETE: job_limit app-one x1/.test(line)));
  assert.ok(!lines.some((line) => line.includes(fx.mediator)), 'no host paths in the log');
  // Exactly at the bound the scan is complete again, and the job is taken.
  await rm(join(jobDir(fx, 'job-d')), { recursive: true });
  await scan(fx, (value) => value.complete && value.jobs === 4, 'complete at the bound');
  await waitFor(async () => (await gateway(fx).status(fx.app, 'job-z')).status === 'awaiting_review', 'launched once seen');
  assert.equal((await invocations(fx)).length, 1);
});

test('exactly the app bound is complete; one above it reports app_limit', async () => {
  const fx = await fixture();
  // app-one plus two others: three apps against a bound of three.
  await otherApps(fx, 2);
  await supervisor(fx);
  await scan(fx, (value) => value.complete && value.apps === 3, 'complete at the app bound');
  await mkdir(join(apps(fx), 'app-zz', 'jobs'), { recursive: true, mode: 0o700 });
  const status = await scan(fx, (value) => !value.complete, 'app bound exceeded');
  assert.deepEqual(codes(status.supervisor.scan!.issues), ['app_limit']);
});

test('an unreadable jobs directory, a substituted symlink and a symlinked job are reported, never followed', async () => {
  const fx = await fixture();
  const [unreadable, substituted, linkedApp] = await otherApps(fx, 3);
  await chmod(join(apps(fx), unreadable!, 'jobs'), 0o000);
  cleanup.push(() => chmod(join(apps(fx), unreadable!, 'jobs'), 0o700));
  // A jobs directory replaced by a symlink to a directory holding a job.
  const elsewhere = join(fx.sandbox, 'elsewhere');
  await mkdir(join(elsewhere, 'job-hidden'), { recursive: true, mode: 0o700 });
  await rm(join(apps(fx), substituted!, 'jobs'), { recursive: true });
  await symlink(elsewhere, join(apps(fx), substituted!, 'jobs'));
  // An app directory replaced by a symlink.
  await rm(join(apps(fx), linkedApp!), { recursive: true });
  await symlink(join(apps(fx), fx.app), join(apps(fx), linkedApp!));
  // A job directory that is a symlink.
  await mkdir(join(fx.sandbox, 'job-target'), { mode: 0o700 });
  await mkdir(join(apps(fx), fx.app, 'jobs'), { recursive: true, mode: 0o700 });
  await symlink(join(fx.sandbox, 'job-target'), join(apps(fx), fx.app, 'jobs', 'job-link'));
  await supervisor(fx, { apps: 10, jobs: 100 });
  const status = await scan(fx, (value) => !value.complete && value.issues.length >= 4, 'incomplete scan');
  assert.deepEqual(codes(status.supervisor.scan!.issues), [`app_not_directory:${linkedApp}`, `job_unreadable:${fx.app}`, `jobs_not_directory:${substituted}`, `jobs_unreadable:${unreadable}`].sort());
  assert.ok(!JSON.stringify(status.supervisor.scan).includes(fx.sandbox), 'no host paths');
  // The bridge's listing reports the same kinds of gaps.
  const listed = await gateway(fx).listReviewReady(undefined);
  assert.equal(listed.complete, false);
  assert.ok(codes(listed.issues).includes(`jobs_unreadable:${unreadable}`));
  assert.ok(codes(listed.issues).includes(`jobs_not_directory:${substituted}`));
  assert.ok(codes(listed.issues).includes(`app_not_directory:${linkedApp}`), 'a symlinked app directory is not followed by the listing either');
});

test('a missing apps directory is a clean empty discovery; one replaced by a symlink is not', async () => {
  const fx = await fixture();
  await supervisor(fx);
  await scan(fx, (value) => value.complete, 'complete');
  const gw = new ExecutionGateway(new FactoryJobs(fx.mediator), fx.mediator);
  await rm(apps(fx), { recursive: true });
  const empty = await gw.listReviewReady(undefined);
  assert.deepEqual([empty.complete, empty.ready.length, empty.apps], [true, 0, 0]);
  await mkdir(join(fx.sandbox, 'apps-elsewhere'));
  await symlink(join(fx.sandbox, 'apps-elsewhere'), apps(fx));
  const substituted = await gw.listReviewReady(undefined);
  assert.deepEqual([substituted.complete, codes(substituted.issues)], [false, ['apps_not_directory']]);
});

test('the review-ready listing is complete at its bounds and says so one above them', async () => {
  const fx = await fixture();
  await emptyJobs(fx, fx.app, ['job-a', 'job-b', 'job-c']);
  const accepted = await acceptedJob(fx, 'job-d');
  await supervisor(fx);
  await authorize(fx, 'job-d', accepted, randomUUID());
  await waitFor(async () => (await gateway(fx).status(fx.app, 'job-d')).status === 'awaiting_review', 'ready');
  const at = (limits: { apps: number; readyJobsPerApp: number; ready: number }) => new ExecutionGateway(new FactoryJobs(fx.mediator), fx.mediator, undefined, limits);
  const exact = await at({ apps: 1, readyJobsPerApp: 4, ready: 1 }).listReviewReady(undefined);
  assert.deepEqual([exact.complete, exact.ready.map((entry) => entry.job_id)], [true, ['job-d']]);
  // The ready job is the fourth: beyond a per-app bound of three it is not listed, and that is said.
  const beyond = await at({ apps: 1, readyJobsPerApp: 3, ready: 1 }).listReviewReady(fx.app);
  assert.deepEqual([beyond.complete, beyond.ready.length, codes(beyond.issues)], [false, 0, [`job_limit:${fx.app}`]]);
  const tooFew = await at({ apps: 1, readyJobsPerApp: 4, ready: 0 }).listReviewReady(undefined);
  assert.deepEqual([tooFew.complete, codes(tooFew.issues)], [false, ['ready_limit']]);
  await mkdir(join(apps(fx), 'app-zz', 'jobs'), { recursive: true, mode: 0o700 });
  const apps2 = await at({ apps: 1, readyJobsPerApp: 4, ready: 1 }).listReviewReady(undefined);
  assert.deepEqual([apps2.complete, codes(apps2.issues)], [false, ['app_limit']]);
});

test('the issue list is bounded: more distinct issues than it holds are flagged', async () => {
  const fx = await fixture();
  const ids = await otherApps(fx, 22);
  for (const id of ids) await chmod(join(apps(fx), id, 'jobs'), 0o000);
  cleanup.push(async () => {
    for (const id of ids) await chmod(join(apps(fx), id, 'jobs'), 0o700);
  });
  await supervisor(fx, { apps: 50, jobs: 100 });
  const status = await scan(fx, (value) => !value.complete, 'incomplete');
  assert.equal(status.supervisor.scan!.issues.length, 20);
  assert.equal(status.supervisor.scan!.more_issues, true);
});
