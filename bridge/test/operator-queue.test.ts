// SF-007 Review 01, Finding 4: the queue listing is bounded (100 apps, 1,000
// jobs per app, 5,000 jobs in total) and reports every limit that cuts it; the
// console shows that the list is incomplete. No safety decision uses the
// listing: a live session in a job the listing never reaches still blocks every
// other launch through the session gate.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { approve } from '../src/operator/approval.js';
import { describeCoverage, describeTruncation } from '../src/operator/console.js';
import { inspectJob, QUEUE_LIMITS, scanQueue, type QueueDeps } from '../src/operator/queue.js';
import { OperatorStore } from '../src/operator/store.js';
import { acceptedJob, createFixture, destroyFixture, fixtureService, git, setMode, type Fixture } from './support/operator-fixture.js';
import { liveProcesses, runInPty } from './support/pty.js';

const RUN = fileURLToPath(new URL('./support/run-fixture.js', import.meta.url));
const CONSOLE = fileURLToPath(new URL('./support/console-fixture.js', import.meta.url));
let fx: Fixture;
let deps: QueueDeps;
let fixtureJson: string;

before(async () => {
  fx = await createFixture();
  deps = { mediatorRoot: fx.mediator, store: await OperatorStore.open(fx.stateHome, fx.mediator), service: fixtureService(fx), now: () => new Date() };
  fixtureJson = join(fx.sandbox, 'fixture.json');
  await writeFile(fixtureJson, JSON.stringify(fx));
});

after(async () => {
  for (const pid of await liveProcesses(join(fx.fakeDir, 'claude'))) process.kill(pid, 'SIGKILL');
  await destroyFixture(fx);
});

const pad = (n: number) => String(n).padStart(4, '0');
const jobDirs = async (app: string, count: number) => {
  for (let index = 0; index < count; index += 1) await mkdir(join(fx.mediator, 'factory-data', 'apps', app, 'jobs', `job-${pad(index)}`), { recursive: true });
};

test('every limit that cuts the listing is reported, and the console says the list is incomplete', async () => {
  // 101 apps after app-one (sorted first); app-z-0099 and app-zz-big are cut by the app limit.
  for (let index = 0; index < 100; index += 1) await mkdir(join(fx.mediator, 'factory-data', 'apps', `app-z-${pad(index)}`, 'jobs'), { recursive: true });
  await mkdir(join(fx.mediator, 'factory-data', 'apps', 'app-zz-big', 'jobs'), { recursive: true });
  // app-one: more jobs than the per-app limit.
  await jobDirs(fx.app, QUEUE_LIMITS.jobsPerApp + 1);
  const { truncation } = await scanQueue(deps);
  assert.equal(truncation.apps_omitted, 2, 'app-z-0099 and app-zz-big are beyond the first 100 apps');
  assert.deepEqual(truncation.jobs_omitted_in, [{ app_id: fx.app, omitted: 1 }]);
  assert.equal(truncation.total_omitted, 0);
  const text = describeTruncation(truncation).join('\n');
  assert.match(text, /^LIST INCOMPLETE:/);
  assert.match(text, /2 app\(s\) beyond the first 100 are not listed/);
  assert.match(text, /app-one: 1 job\(s\) beyond the first 1000 are not listed/);
  assert.match(text, /the session gate counts every session/);
  const { output } = await runInPty(fx.sandbox, [process.execPath, CONSOLE, fixtureJson], [['to review, r to refresh, q to quit:', 'q\r']], { timeout: 60 }).done;
  assert.match(output, /LIST INCOMPLETE:/);
});

test('the total limit is reported when more than 5,000 jobs would be inspected', async () => {
  // app-one already has 1001 job directories (1000 inspected); add 5 apps x 1000 more.
  for (let index = 0; index < 5; index += 1) await jobDirs(`app-z-${pad(index)}`, 1000);
  const { truncation } = await scanQueue(deps);
  assert.equal(truncation.total_omitted, 1000);
  assert.match(describeTruncation(truncation).join('\n'), /1000 job\(s\) beyond the total limit of 5000 are not listed/);
});

test('a live manual session in a job the listing never reaches still blocks every launch', async () => {
  // app-zz-big is beyond the app limit; give it its own throwaway repository and a live session there.
  const otherRepo = join(fx.sandbox, 'other-repo');
  await mkdir(otherRepo);
  git(otherRepo, 'init', '-q');
  await writeFile(join(otherRepo, 'README.md'), '# Other\n');
  git(otherRepo, 'add', 'README.md');
  git(otherRepo, 'commit', '-q', '-m', 'init');
  await writeFile(join(fx.mediator, 'factory-data', 'apps', 'app-zz-big', '.env'), `APP_REPO=${otherRepo}\n`, { mode: 0o600 });
  await acceptedJob(fx, 'job-hidden', undefined, 'app-zz-big');
  await fixtureService(fx).prepare('app-zz-big', 'job-hidden');
  assert.ok(!(await scanQueue(deps)).entries.some((entry) => entry.app_id === 'app-zz-big'), 'the app is outside the listing');
  // A listed job of app-one, accepted and prepared.
  await acceptedJob(fx, 'job-0000');
  await fixtureService(fx).prepare(fx.app, 'job-0000');
  await acceptedJob(fx, 'job-0001');

  await setMode(fx, 'hang');
  const manual = spawn(process.execPath, [RUN, fixtureJson, 'no', 'app-zz-big', 'job-hidden'], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 200 && (await liveProcesses(join(fx.fakeDir, 'claude'))).length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await liveProcesses(join(fx.fakeDir, 'claude'))).length, 1);

  // A listed job cannot be approved, and the manual CLI cannot start one either.
  const entry = await inspectJob(deps, fx.app, 'job-0001');
  await assert.rejects(approve(deps, fx.app, 'job-0001', { request_id: entry!.request_id!, instruction_sha256: entry!.instruction_sha256! }), { code: 'busy' });
  await assert.rejects(fixtureService(fx).run(fx.app, 'job-0000', async () => true), { code: 'session_busy' });
  assert.equal((await liveProcesses(join(fx.fakeDir, 'claude'))).length, 1);
  await assert.rejects(readFile(join(fx.mediator, 'factory-data', 'apps', fx.app, 'jobs', 'job-0000', 'launch.claim')), { code: 'ENOENT' });
  assert.equal((await inspectJob(deps, fx.app, 'job-0000'))?.status, 'prepared');
  for (const pid of await liveProcesses(join(fx.fakeDir, 'claude'))) process.kill(pid, 'SIGKILL');
  await new Promise((resolve) => manual.once('exit', resolve));
});

// ---- Review 02, R2-3: directories that cannot be inspected are never an empty list ----

async function scratchMediator(): Promise<string> {
  const { mkdtemp, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  return realpath(await mkdtemp(join(tmpdir(), 'sf-queue-coverage-')));
}

async function snapshot(root: string): Promise<string[]> {
  const { readdir, lstat, readlink } = await import('node:fs/promises');
  const out: string[] = [];
  async function walk(path: string): Promise<void> {
    const stats = await lstat(path);
    out.push(`${path} ${stats.mode} ${stats.isSymbolicLink() ? await readlink(path) : stats.size}`);
    if (stats.isDirectory() && !stats.isSymbolicLink()) for (const name of (await readdir(path).catch(() => [] as string[])).sort()) await walk(join(path, name));
  }
  await walk(root);
  return out;
}

test('R2-3: a missing root is a clean, uninitialized empty state; a symlinked, file or unreadable root is LIST INCOMPLETE', async () => {
  const { chmod, rm, symlink } = await import('node:fs/promises');
  const scan = async (root: string) => scanQueue({ ...deps, mediatorRoot: root });
  const cases: Array<[string, (root: string) => Promise<void>, string | null]> = [
    ['no factory-data', async () => undefined, null],
    ['no apps', async (root) => mkdir(join(root, 'factory-data')), null],
    ['factory-data symlink', async (root) => {
      await mkdir(join(root, 'real', 'apps', 'app-x', 'jobs', 'job-x'), { recursive: true });
      await symlink(join(root, 'real'), join(root, 'factory-data'));
    }, 'factory-data: a symlink or not a directory'],
    ['factory-data file', async (root) => writeFile(join(root, 'factory-data'), 'x'), 'factory-data: a symlink or not a directory'],
    ['apps symlink', async (root) => {
      await mkdir(join(root, 'factory-data', 'elsewhere'), { recursive: true });
      await symlink(join(root, 'factory-data', 'elsewhere'), join(root, 'factory-data', 'apps'));
    }, 'factory-data/apps: a symlink or not a directory'],
    ...(process.getuid?.() !== 0
      ? [['apps unreadable', async (root: string) => {
          await mkdir(join(root, 'factory-data', 'apps', 'app-x'), { recursive: true });
          await chmod(join(root, 'factory-data', 'apps'), 0o000);
        }, 'factory-data/apps: cannot be listed'] as [string, (root: string) => Promise<void>, string]]
      : []),
  ];
  for (const [label, build, expected] of cases) {
    const root = await scratchMediator();
    try {
      await build(root);
      const before = await snapshot(root);
      const { entries, truncation } = await scan(root);
      assert.deepEqual(entries, [], label);
      const text = describeTruncation(truncation).join('\n');
      if (expected === null) {
        assert.equal(truncation.uninitialized, true, label);
        assert.equal(text, '', label);
        assert.match(describeCoverage(truncation).join('\n'), /not initialized yet \(no factory-data\/apps\): nothing has been dispatched/, label);
      } else {
        assert.equal(truncation.uninitialized, false, label);
        assert.match(text, /^LIST INCOMPLETE:/, label);
        assert.match(text, new RegExp(`  ${expected.replace(/[/()]/g, '\\$&')}; not inspected`), label);
        assert.doesNotMatch(text, new RegExp(root), label);
      }
      assert.deepEqual(await snapshot(root), before, `${label}: nothing written`);
    } finally {
      await chmod(join(root, 'factory-data', 'apps'), 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('R2-3: symlinked, non-directory or unreadable app and jobs directories are reported, never followed; healthy ones are clean', async () => {
  const { chmod, rm, symlink } = await import('node:fs/promises');
  const root = await scratchMediator();
  try {
    const apps = join(root, 'factory-data', 'apps');
    await mkdir(join(apps, 'app-healthy', 'jobs'), { recursive: true });
    await mkdir(join(apps, 'app-no-jobs-yet'), { recursive: true });
    // A real job elsewhere that must never be discovered through the links.
    await mkdir(join(root, 'outside', 'jobs', 'job-outside'), { recursive: true });
    await writeFile(join(root, 'outside', 'jobs', 'job-outside', 'dispatch.json'), '{}');
    await symlink(join(root, 'outside'), join(apps, 'app-linked'));
    await mkdir(join(apps, 'app-linked-jobs'));
    await symlink(join(root, 'outside', 'jobs'), join(apps, 'app-linked-jobs', 'jobs'));
    await writeFile(join(apps, 'app-file'), 'x');
    await mkdir(join(apps, 'app-file-jobs'));
    await writeFile(join(apps, 'app-file-jobs', 'jobs'), 'x');
    const unprivileged = process.getuid?.() !== 0;
    if (unprivileged) {
      await mkdir(join(apps, 'app-locked', 'jobs'), { recursive: true });
      await chmod(join(apps, 'app-locked', 'jobs'), 0o000);
    }
    const before = await snapshot(root);
    const { entries, truncation } = await scanQueue({ ...deps, mediatorRoot: root });
    assert.deepEqual(entries, []);
    assert.deepEqual(
      truncation.uninspected.map(({ path, reason }) => `${path}: ${reason}`).sort(),
      [
        'factory-data/apps/app-file: a symlink or not a directory',
        'factory-data/apps/app-file-jobs/jobs: a symlink or not a directory',
        'factory-data/apps/app-linked: a symlink or not a directory',
        'factory-data/apps/app-linked-jobs/jobs: a symlink or not a directory',
        ...(unprivileged ? ['factory-data/apps/app-locked/jobs: cannot be listed'] : []),
      ].sort(),
    );
    const text = describeTruncation(truncation).join('\n');
    assert.match(text, /^LIST INCOMPLETE:/);
    assert.doesNotMatch(text, /outside|job-outside/);
    assert.doesNotMatch(text, new RegExp(root));
    assert.deepEqual(await snapshot(root), before, 'nothing written');
    // Without the broken directories the listing is complete and clean.
    for (const name of ['app-linked', 'app-linked-jobs', 'app-file', 'app-file-jobs']) await rm(join(apps, name), { recursive: true, force: true });
    if (unprivileged) await chmod(join(apps, 'app-locked', 'jobs'), 0o700);
    await rm(join(apps, 'app-locked'), { recursive: true, force: true });
    const clean = (await scanQueue({ ...deps, mediatorRoot: root })).truncation;
    assert.deepEqual(describeTruncation(clean), []);
    assert.equal(clean.uninitialized, false);
  } finally {
    await chmod(join(root, 'factory-data', 'apps', 'app-locked', 'jobs'), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('R2-3: an app directory that can be listed but not searched is reported as "cannot be inspected"', { skip: process.getuid?.() === 0 }, async () => {
  const { chmod, rm } = await import('node:fs/promises');
  const root = await scratchMediator();
  const apps = join(root, 'factory-data', 'apps');
  try {
    await mkdir(join(apps, 'app-hidden', 'jobs'), { recursive: true });
    // Readable (names can be listed) but not searchable: lstat of an entry fails with EACCES.
    await chmod(apps, 0o600);
    const { entries, truncation } = await scanQueue({ ...deps, mediatorRoot: root });
    assert.deepEqual(entries, []);
    assert.deepEqual(truncation.uninspected, [{ path: 'factory-data/apps/app-hidden', reason: 'cannot be inspected' }]);
    assert.match(describeTruncation(truncation).join('\n'), /factory-data\/apps\/app-hidden: cannot be inspected; not inspected/);
  } finally {
    await chmod(apps, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

