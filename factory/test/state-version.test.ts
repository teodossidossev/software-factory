// The state format version (SF-101): missing, equal, lower with a fake migration, higher refused;
// and sf run (a job's runner) and sf serve refuse a newer state with state_too_new; and the job
// store keeps job.json's limit counts and important mark and refuses invalid ones.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { type Job, JobStore } from '../src/jobs.js';
import { checkStateVersion, type Migration, MIGRATIONS, STATE_VERSION, STATE_VERSION_FILE } from '../src/state-version.js';
import { newEnv, runCli } from './support/harness.js';

async function stateDir(): Promise<string> {
  return mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'sf-state-version-'));
}

const versionIn = async (dir: string): Promise<string> => (await readFile(join(dir, STATE_VERSION_FILE), 'utf8')).trim();

test('a missing state-version gets the current version', async () => {
  const dir = await stateDir();
  try {
    assert.equal(STATE_VERSION, 6);
    const result = await checkStateVersion(dir);
    assert.deepEqual(result, { found: undefined, version: 6, migrated: [] });
    assert.equal(await versionIn(dir), '6');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an equal state-version goes on and runs no migration', async () => {
  const dir = await stateDir();
  try {
    await writeFile(join(dir, STATE_VERSION_FILE), '3\n');
    const ran: number[] = [];
    const migrations: Migration[] = [{ from: 2, run: async () => void ran.push(2) }];
    assert.deepEqual(await checkStateVersion(dir, { current: 3, migrations }), { found: 3, version: 3, migrated: [] });
    assert.deepEqual(ran, []);
    assert.equal(await versionIn(dir), '3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lower state-version runs the migrations from it to the current one in order, then writes the new number', async () => {
  const dir = await stateDir();
  try {
    await writeFile(join(dir, STATE_VERSION_FILE), '1\n');
    const ran: string[] = [];
    // Out of order on purpose: the steps run by their from.
    const migrations: Migration[] = [
      { from: 2, run: async (state) => void ran.push(`2->3 ${state === dir}`) },
      { from: 1, run: async (state) => void ran.push(`1->2 ${state === dir}`) },
      { from: 3, run: async () => void ran.push('3->4') },
    ];
    assert.deepEqual(await checkStateVersion(dir, { current: 3, migrations }), { found: 1, version: 3, migrated: [1, 2] });
    assert.deepEqual(ran, ['1->2 true', '2->3 true']);
    assert.equal(await versionIn(dir), '3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a migration that fails leaves the number of the last step done', async () => {
  const dir = await stateDir();
  try {
    await writeFile(join(dir, STATE_VERSION_FILE), '1\n');
    const migrations: Migration[] = [
      { from: 1, run: async () => undefined },
      { from: 2, run: async () => Promise.reject(new Error('broken')) },
    ];
    await assert.rejects(checkStateVersion(dir, { current: 3, migrations }), /broken/);
    assert.equal(await versionIn(dir), '2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a higher state-version is refused with state_too_new and left as it is', async () => {
  const dir = await stateDir();
  try {
    await writeFile(join(dir, STATE_VERSION_FILE), '7\n');
    await assert.rejects(checkStateVersion(dir), (error: unknown) => {
      assert.ok(error instanceof FactoryError);
      assert.equal(error.code, 'state_too_new');
      assert.match(error.message, /the state was written by a newer factory; update the factory|written by a newer factory/);
      return true;
    });
    assert.equal(await versionIn(dir), '7');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the real migrations 1 → 2 (SF-131: claude_review in job.json), 2 → 3 (SF-153: last_start in queue.json), 3 → 4 (SF-210: the digest record\'s texts and in_progress), 4 → 5 (SF-236: retry_at and retries of a queue entry) and 5 → 6 (the limits\' counts and the important mark in job.json) change nothing in the state directory', async () => {
  const dir = await stateDir();
  try {
    const jobDir = join(dir, 'jobs', 'app', 'V-1');
    await mkdir(jobDir, { recursive: true });
    const job = '{"state":"working"}\n';
    await writeFile(join(jobDir, 'job.json'), job);
    const queue = '{"version":1,"max_running":3,"held":false,"hold_reason":null,"entries":[],"errors":[]}\n';
    await writeFile(join(dir, 'queue.json'), queue);
    const digestDir = join(dir, 'digest');
    await mkdir(digestDir);
    const record = '{"id":"20261101T060000Z-scheduled","output":{"repos":[{"name":"app","headline":"Plain."}]}}\n';
    await writeFile(join(digestDir, '20261101T060000Z-scheduled.json'), record);
    await writeFile(join(dir, STATE_VERSION_FILE), '1\n');
    assert.deepEqual(MIGRATIONS.map((migration) => migration.from), [1, 2, 3, 4, 5]);
    assert.deepEqual(await checkStateVersion(dir), { found: 1, version: 6, migrated: [1, 2, 3, 4, 5] });
    assert.equal(await versionIn(dir), '6');
    assert.equal(await readFile(join(jobDir, 'job.json'), 'utf8'), job);
    assert.equal(await readFile(join(dir, 'queue.json'), 'utf8'), queue);
    assert.equal(await readFile(join(digestDir, '20261101T060000Z-scheduled.json'), 'utf8'), record);
    // From 3: the steps 3 → 4, 4 → 5 and 5 → 6.
    await writeFile(join(dir, STATE_VERSION_FILE), '3\n');
    assert.deepEqual(await checkStateVersion(dir), { found: 3, version: 6, migrated: [3, 4, 5] });
    assert.equal(await readFile(join(digestDir, '20261101T060000Z-scheduled.json'), 'utf8'), record);
    // From 4: the steps 4 → 5 and 5 → 6.
    await writeFile(join(dir, STATE_VERSION_FILE), '4\n');
    assert.deepEqual(await checkStateVersion(dir), { found: 4, version: 6, migrated: [4, 5] });
    assert.equal(await readFile(join(dir, 'queue.json'), 'utf8'), queue);
    // From 5 alone: the one step 5 → 6.
    await writeFile(join(dir, STATE_VERSION_FILE), '5\n');
    assert.deepEqual(await checkStateVersion(dir), { found: 5, version: 6, migrated: [5] });
    assert.equal(await readFile(join(jobDir, 'job.json'), 'utf8'), job);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the job store keeps job.json\'s limit counts and important mark, and refuses invalid ones', async () => {
  const dir = await stateDir();
  try {
    const jobs = new JobStore(dir);
    const at = '2026-11-16T10:00:00.000Z';
    const job: Job = {
      workspace: 'app', ticket: 'V-1', branch: 'V-1-limits', base: 'main', continues: null, builds_on: null, builds_on_commit: null,
      base_commit: null, state: 'working', worktree: null, prepared_commit: null, iteration: 1, fixes: 0, gate_fixes: 0, gate_tokens: 0,
      session_id: null, mr: null, target_commit: null, mr_attempts: 1, mr_conflict_turn: false, created_at: at, updated_at: at,
    };
    const counted: Job = { ...job, stalled_fixes: 2, least_open: 3, gate_stalled: 1, gate_budget_from: 900000, important: true };
    await jobs.write(counted);
    const read = await jobs.read('app', 'V-1');
    assert.deepEqual(read, counted);
    await jobs.write(job);
    const plain = await jobs.read('app', 'V-1');
    assert.deepEqual(plain, job);
    for (const field of ['stalled_fixes', 'least_open', 'gate_stalled', 'gate_budget_from', 'important']) {
      assert.equal(field in (plain as object), false, field);
    }
    const path = join(jobs.dir('app', 'V-1'), 'job.json');
    for (const invalid of [{ stalled_fixes: -1 }, { least_open: 1.5 }, { important: false }]) {
      await writeFile(path, `${JSON.stringify({ ...job, ...invalid }, null, 2)}\n`);
      await assert.rejects(jobs.read('app', 'V-1'), { code: 'job_invalid' });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a state-version that is not a whole number is refused', async () => {
  const dir = await stateDir();
  try {
    await writeFile(join(dir, STATE_VERSION_FILE), 'two\n');
    await assert.rejects(checkStateVersion(dir), (error: unknown) => error instanceof FactoryError && error.code === 'state_version_invalid');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a runner (sf run) and sf serve refuse a newer state version with state_too_new', async () => {
  const env = await newEnv('state-too-new');
  await mkdir(env.state, { recursive: true });
  await writeFile(join(env.state, STATE_VERSION_FILE), `${STATE_VERSION + 1}\n`);
  const run = await runCli(env, ['run', 'app', 'V-1']);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /state_too_new/);
  const served = await runCli(env, ['serve']);
  assert.equal(served.code, 1);
  assert.match(served.stderr, /state_too_new/);
  assert.equal(await versionIn(env.state), String(STATE_VERSION + 1));
});
