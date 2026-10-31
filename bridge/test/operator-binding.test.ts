// SF-007 seam in SF-006: prepare and run accept an optional approval binding
// (request id, instruction sha256, app repository) that is compared inside the
// per-job lock before anything is written to the application repository.
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { acceptedJob, createFixture, destroyFixture, fixtureService, git, invocations, jobDir, sha256, type Fixture } from './support/operator-fixture.js';

let fx: Fixture;

before(async () => {
  fx = await createFixture();
});

after(async () => {
  await destroyFixture(fx);
});

const repoSha = async (path: string) => sha256(await realpath(path));
const rejectsWith = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code, String(error));
  assert.doesNotMatch(String((error as Error).message), new RegExp(fx.appRepo.replaceAll('/', '\\/')));
  return true;
};

test('prepare with a matching binding prepares; any mismatch fails closed before an app-side write', async () => {
  const { requestId, sha } = await acceptedJob(fx, 'job-bound');
  const expected = { requestId, instructionSha256: sha, appRepoSha256: await repoSha(fx.appRepo) };
  const mismatches: Array<[string, typeof expected]> = [
    ['request id', { ...expected, requestId: '00000000-0000-4000-8000-000000000000' }],
    ['instruction', { ...expected, instructionSha256: '0'.repeat(64) }],
    ['app repository', { ...expected, appRepoSha256: '1'.repeat(64) }],
  ];
  for (const [label, wrong] of mismatches) {
    await assert.rejects(fixtureService(fx).prepare(fx.app, 'job-bound', wrong), rejectsWith('approval_mismatch'), label);
    await assert.rejects(readdir(join(fx.appRepo, '.software-factory')), { code: 'ENOENT' }, label);
    await assert.rejects(readFile(join(jobDir(fx, 'job-bound'), 'execution.json')), { code: 'ENOENT' }, label);
  }
  assert.equal((await fixtureService(fx).prepare(fx.app, 'job-bound', expected)).state, 'prepared');
  // A bound prepare never adopts an existing record.
  await assert.rejects(fixtureService(fx).prepare(fx.app, 'job-bound', expected), rejectsWith('wrong_state'));
});

test('a swapped .env (another repository) no longer matches the approved repository', async () => {
  const { requestId, sha } = await acceptedJob(fx, 'job-env-swap');
  const expected = { requestId, instructionSha256: sha, appRepoSha256: await repoSha(fx.appRepo) };
  const other = join(fx.sandbox, 'other-repo');
  await mkdir(other);
  git(other, 'init', '-q');
  await writeFile(join(other, 'README.md'), '# Other\n');
  git(other, 'add', 'README.md');
  git(other, 'commit', '-q', '-m', 'init');
  const env = join(fx.mediator, 'factory-data', 'apps', fx.app, '.env');
  await writeFile(env, `APP_REPO=${other}\n`, { mode: 0o600 });
  try {
    await assert.rejects(fixtureService(fx).prepare(fx.app, 'job-env-swap', expected), rejectsWith('approval_mismatch'));
    await assert.rejects(readdir(join(other, '.software-factory')), { code: 'ENOENT' });
  } finally {
    await writeFile(env, `APP_REPO=${fx.appRepo}\n`, { mode: 0o600 });
  }
});

test('run with a mismatching binding starts nothing and claims nothing; status reports the artifacts', async () => {
  git(fx.appRepo, 'reset', '-q', '--hard');
  git(fx.appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
  const { requestId, sha } = await acceptedJob(fx, 'job-run-bound');
  const expected = { requestId, instructionSha256: sha, appRepoSha256: await repoSha(fx.appRepo) };
  await fixtureService(fx).prepare(fx.app, 'job-run-bound', expected);
  const before = (await invocations(fx)).length;
  await assert.rejects(
    fixtureService(fx).run(fx.app, 'job-run-bound', async () => true, { ...expected, instructionSha256: 'f'.repeat(64) }),
    rejectsWith('approval_mismatch'),
  );
  await assert.rejects(readFile(join(jobDir(fx, 'job-run-bound'), 'launch.claim')), { code: 'ENOENT' });
  assert.equal((await invocations(fx)).length, before);
  const result = await fixtureService(fx).run(fx.app, 'job-run-bound', async () => true, expected);
  assert.equal(result.state, 'completed');
  const status = await fixtureService(fx).status(fx.app, 'job-run-bound');
  assert.deepEqual(Object.keys(status.artifacts).sort(), ['checks.md', 'implementation.diff', 'new-files.md', 'report.md']);
  for (const [name, digest] of Object.entries(status.artifacts)) {
    assert.equal(sha256(await readFile(join(jobDir(fx, 'job-run-bound'), name))), digest, name);
  }
});
