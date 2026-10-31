// Contract tests for the instruction store behind factory_write_instruction,
// run against a throwaway repository root with a registered pilot app.
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FactoryJobs } from '../src/factory-jobs.js';
import { InstructionStore, MAX_INSTRUCTION_BYTES } from '../src/instruction-store.js';
import { RepoFiles, resolveRepoRoot } from '../src/repo-files.js';

// Expected byte counts and digests were computed independently (Python hashlib).
const FIRST = {
  content: '# Пилотна инструкция\n\nНапиши „здравей“ на кирилица. ✓\n',
  bytes: 100,
  sha256: 'b3496d0aaf2cac18460200ab1a7c4363033688afb2f972f3b6a55cecff7e3bbc',
};
const SECOND = {
  content: '# Пилотна инструкция v2\n\nПромяна №2 — 🚀\n',
  bytes: 71,
  sha256: '3b9f94b0f082306cba94273c3840f910677adef6fddbd9346b9dad0758c18feb',
};
const APP = 'sf-pilot';

let sandbox: string;
let root: string;
let store: InstructionStore;

function rejectsWith(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code, String(error));
    assert.doesNotMatch(String((error as Error).message), new RegExp(sandbox.replaceAll('/', '\\/')));
    return true;
  };
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'sf-instructions-'));
  root = join(sandbox, 'repo');
  await mkdir(join(root, 'factory-data', 'apps', APP), { recursive: true });
  await writeFile(join(root, 'factory-data', 'apps', APP, '.env'), 'REPO_PATH=/fixture-only\n');
  root = await resolveRepoRoot(root);
  store = new InstructionStore(new FactoryJobs(root));
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

test('creates a Cyrillic instruction that factory_read_file returns byte for byte', async () => {
  const created = await store.write({ app_id: APP, job_id: 'job-001', content: FIRST.content });
  const path = `factory-data/apps/${APP}/jobs/job-001/instruction.md`;
  assert.deepEqual(created, { path, status: 'created', bytes: FIRST.bytes, sha256: FIRST.sha256 });

  const read = await new RepoFiles(root).read({ path });
  assert.deepEqual([read.text, read.bytes, read.sha256], [FIRST.content, FIRST.bytes, FIRST.sha256]);
  assert.equal((await lstat(join(root, path))).mode & 0o777, 0o600);
});

test('repeating the same content is a no-op and changes need the current sha256', async () => {
  await store.write({ app_id: APP, job_id: 'job-002', content: FIRST.content });
  const file = join(root, 'factory-data', 'apps', APP, 'jobs', 'job-002', 'instruction.md');
  const original = await lstat(file);

  for (const expected_sha256 of [undefined, FIRST.sha256]) {
    const again = await store.write({ app_id: APP, job_id: 'job-002', content: FIRST.content, expected_sha256 });
    assert.equal(again.status, 'unchanged');
    assert.equal(again.sha256, FIRST.sha256);
  }
  const unchanged = await lstat(file);
  assert.deepEqual([unchanged.ino, unchanged.mtimeMs], [original.ino, original.mtimeMs]);

  // Without expected_sha256, or with a stale one, the existing content stays.
  await assert.rejects(store.write({ app_id: APP, job_id: 'job-002', content: SECOND.content }), rejectsWith('conflict'));
  await assert.rejects(
    store.write({ app_id: APP, job_id: 'job-002', content: SECOND.content, expected_sha256: SECOND.sha256 }),
    rejectsWith('conflict'),
  );
  assert.equal(await readFile(file, 'utf8'), FIRST.content);

  const updated = await store.write({ app_id: APP, job_id: 'job-002', content: SECOND.content, expected_sha256: FIRST.sha256 });
  assert.deepEqual([updated.status, updated.bytes, updated.sha256], ['updated', SECOND.bytes, SECOND.sha256]);
  assert.equal(await readFile(file, 'utf8'), SECOND.content);

  // The old sha256 is now stale.
  await assert.rejects(
    store.write({ app_id: APP, job_id: 'job-002', content: FIRST.content, expected_sha256: FIRST.sha256 }),
    rejectsWith('conflict'),
  );
  // expected_sha256 on a missing instruction is a conflict too, not a silent create.
  await assert.rejects(
    store.write({ app_id: APP, job_id: 'job-new', content: FIRST.content, expected_sha256: FIRST.sha256 }),
    rejectsWith('conflict'),
  );
  assert.deepEqual(await readdir(join(root, 'factory-data', 'apps', APP, 'jobs', 'job-002')), ['instruction.md']);
});

test('concurrent updates from the same sha256 let exactly one win', async () => {
  await store.write({ app_id: APP, job_id: 'job-race', content: FIRST.content });
  const attempts = await Promise.allSettled(
    ['A', 'B', 'C', 'D'].map((tag) =>
      store.write({ app_id: APP, job_id: 'job-race', content: `${SECOND.content}${tag}\n`, expected_sha256: FIRST.sha256 }),
    ),
  );
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  for (const attempt of attempts.filter((candidate) => candidate.status === 'rejected')) {
    rejectsWith('conflict')(attempt.reason);
  }
  const concurrentCreates = await Promise.allSettled(
    ['A', 'B'].map((tag) => store.write({ app_id: APP, job_id: 'job-race-new', content: tag })),
  );
  assert.equal(concurrentCreates.filter((attempt) => attempt.status === 'fulfilled').length, 1);
});

test('rejects invalid identifiers, unknown apps, bad content and oversized instructions', async () => {
  for (const id of ['', '..', '.', 'a/b', '/etc', 'A', 'a b', 'a\0b', '-a', 'a-', 'a'.repeat(65), 'а', 'a..b', '.env']) {
    await assert.rejects(store.write({ app_id: id, job_id: 'job-x', content: 'x' }), rejectsWith('invalid_id'), `app ${JSON.stringify(id)}`);
    await assert.rejects(store.write({ app_id: APP, job_id: id, content: 'x' }), rejectsWith('invalid_id'), `job ${JSON.stringify(id)}`);
  }
  await assert.rejects(store.write({ app_id: 'unknown-app', job_id: 'job-x', content: 'x' }), rejectsWith('app_not_found'));
  await assert.rejects(store.write({ app_id: APP, job_id: 'job-x', content: 'a\0b' }), rejectsWith('invalid_content'));
  await assert.rejects(store.write({ app_id: APP, job_id: 'job-x', content: ' \n\t' }), rejectsWith('invalid_content'));
  await assert.rejects(store.write({ app_id: APP, job_id: 'job-x', content: '\ud800' }), rejectsWith('invalid_content'));
  await assert.rejects(store.write({ app_id: APP, job_id: 'job-x', content: 'x', expected_sha256: 'ABC' }), rejectsWith('invalid_sha256'));

  const atLimit = 'я'.repeat(MAX_INSTRUCTION_BYTES / 2);
  assert.equal((await store.write({ app_id: APP, job_id: 'job-limit', content: atLimit })).bytes, MAX_INSTRUCTION_BYTES);
  await assert.rejects(store.write({ app_id: APP, job_id: 'job-big', content: `${atLimit}x` }), rejectsWith('too_large'));
  await assert.rejects(lstat(join(root, 'factory-data', 'apps', APP, 'jobs', 'job-big')), { code: 'ENOENT' });
});

test('refuses symlinked apps, job directories and instruction files', async () => {
  const outside = join(sandbox, 'outside');
  await mkdir(join(outside, 'jobs', 'job-1'), { recursive: true });
  await writeFile(join(outside, 'target.md'), 'outside\n');
  const apps = join(root, 'factory-data', 'apps');
  await symlink(outside, join(apps, 'linked-app'));
  await mkdir(join(apps, 'app-two', 'jobs'), { recursive: true });
  await symlink(join(outside, 'jobs', 'job-1'), join(apps, 'app-two', 'jobs', 'linked-job'));
  await mkdir(join(apps, 'app-two', 'jobs', 'linked-file'));
  await symlink(join(outside, 'target.md'), join(apps, 'app-two', 'jobs', 'linked-file', 'instruction.md'));
  await mkdir(join(apps, 'app-three'));
  await symlink(join(outside, 'jobs'), join(apps, 'app-three', 'jobs'));

  await assert.rejects(store.write({ app_id: 'linked-app', job_id: 'job-1', content: 'x' }), rejectsWith('forbidden_path'));
  await assert.rejects(store.write({ app_id: 'app-two', job_id: 'linked-job', content: 'x' }), rejectsWith('forbidden_path'));
  await assert.rejects(store.write({ app_id: 'app-two', job_id: 'linked-file', content: 'x' }), rejectsWith('forbidden_path'));
  await assert.rejects(store.write({ app_id: 'app-three', job_id: 'job-1', content: 'x' }), rejectsWith('forbidden_path'));
  assert.equal(await readFile(join(outside, 'target.md'), 'utf8'), 'outside\n');
  assert.deepEqual(await readdir(join(outside, 'jobs', 'job-1')), []);
});

test('freezes an instruction once a dispatch exists for the job', async () => {
  const created = await store.write({ app_id: APP, job_id: 'job-frozen', content: FIRST.content });
  await writeFile(join(root, 'factory-data', 'apps', APP, 'jobs', 'job-frozen', 'dispatch.json'), '{}');
  assert.equal((await store.write({ app_id: APP, job_id: 'job-frozen', content: FIRST.content })).status, 'unchanged');
  await assert.rejects(
    store.write({ app_id: APP, job_id: 'job-frozen', content: SECOND.content, expected_sha256: created.sha256 }),
    rejectsWith('dispatched'),
  );
});
