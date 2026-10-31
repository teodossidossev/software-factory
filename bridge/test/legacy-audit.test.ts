// Review 05 regressions for the read-only legacy audit: every ChatGPT-readable
// execution.json and job directory is either inspected or reported as a coverage
// gap, and any gap or unverified record gives a nonzero exit code. Each test builds
// its own throwaway mediator; nothing outside it is touched.
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { auditLegacyRecords, formatLegacyAudit, type LegacyAudit } from '../src/execution/legacy-audit.js';
import { EXECUTION_SCHEMA as SCHEMA } from '../src/execution/service.js';
import { RepoFiles } from '../src/repo-files.js';

const roots: string[] = [];
// Root bypasses permission bits, so the chmod-based cases only run unprivileged.
const unprivileged = process.getuid?.() !== 0;

after(async () => {
  for (const root of roots) {
    await chmodTree(root);
    await rm(root, { recursive: true, force: true });
  }
});

// Restores owner access so the sandbox can be removed after the chmod cases.
async function chmodTree(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory()) return;
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await chmodTree(join(path, name));
}

async function mediator(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sf-legacy-audit-')));
  roots.push(root);
  return root;
}

const jobPath = (root: string, app: string, job: string): string => join(root, 'factory-data', 'apps', app, 'jobs', job);

// A record that passes the current schema; ignored_initial is the only variable part.
function currentRecord(app: string, job: string, ignoredInitial: unknown): Record<string, unknown> {
  const at = '2026-10-26T00:00:00.000Z';
  const git = { head: null, index_sha256: '0'.repeat(64), changed_paths: [] };
  return {
    schema: SCHEMA, app_id: app, job_id: job, request_id: 'r', instruction_sha256: '0'.repeat(64), instruction_bytes: 1,
    state: 'completed', revision: 1, created_at: at, updated_at: at, destination: `.software-factory/jobs/${job}/instruction.md`,
    acceptance: { openclaw_run_id: 'run', automation_id: 'auto', receiver_accepted_at: at }, checks: [], git_initial: git,
    ignored_initial: ignoredInitial, ignored_summary: null, git_final: null, session: null, completion: null, evidence: null,
    artifacts: {}, error: null, recovery: null, history: [{ state: 'completed', at }],
  };
}

async function writeRecord(root: string, app: string, job: string, content: string | Buffer): Promise<void> {
  await mkdir(jobPath(root, app, job), { recursive: true });
  await writeFile(join(jobPath(root, app, job), 'execution.json'), content);
}

// Every path under root with its type and bytes or link target, without following links.
async function snapshot(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(path: string): Promise<void> {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      result.set(path, `link:${await readlink(path)}`);
      return;
    }
    // Paths made unreadable on purpose are compared by type and mode only.
    try {
      if (stats.isDirectory()) {
        result.set(path, `dir:${stats.mode}`);
        for (const name of await readdir(path)) await walk(join(path, name));
      } else result.set(path, `file:${stats.mode}:${(await readFile(path)).toString('base64')}`);
    } catch {
      result.set(path, `unreadable:${stats.mode}`);
    }
  }
  await walk(root);
  return result;
}

// Runs the audit, checks that nothing changed and that the output names nothing sensitive.
async function audit(root: string, secrets: string[] = []): Promise<{ result: LegacyAudit; text: string; exitCode: 0 | 1 }> {
  const before = await snapshot(root);
  const result = await auditLegacyRecords(root);
  assert.deepEqual(await snapshot(root), before, 'the audit changed the mediator');
  const { lines, exitCode } = formatLegacyAudit(result);
  const text = lines.join('\n');
  for (const secret of [...secrets, root, tmpdir()]) {
    assert.ok(!text.includes(secret), `audit output contains ${JSON.stringify(secret)}`);
    assert.ok(!JSON.stringify(result).includes(secret), `audit result contains ${JSON.stringify(secret)}`);
  }
  return { result, text, exitCode };
}

test('R5-1: an existing execution.json that cannot be parsed is unverified, printed without contents, and fails the audit', async () => {
  const root = await mediator();
  const legacy = '"ignored_initial":{"entries":["SECRET-dir/"],"credentials":{"SECRET-dir/.env":"' + 'a'.repeat(64) + '"}}';
  const cases: Array<[string, string | Buffer, string]> = [
    // Valid UTF-8 that factory_read_file would return as is.
    ['truncated', `{"schema":"${SCHEMA}",${legacy}`, 'invalid_json'],
    ['trailing-text', `{"schema":"${SCHEMA}",${legacy}} SECRET-tail`, 'invalid_json'],
    ['invalid-utf8', Buffer.concat([Buffer.from(`{"schema":"${SCHEMA}",${legacy},"x":"`), Buffer.from([0xff]), Buffer.from('"}')]), 'invalid_utf8'],
    ['array', JSON.stringify(['SECRET-array/.env']), 'not_record'],
    ['no-schema', JSON.stringify({ ignored_initial: { entries: ['SECRET-noschema/'], credentials: {} } }), 'not_record'],
    ['oversized', JSON.stringify({ ...currentRecord('app-one', 'job-oversized', null), padding: 'SECRET-'.repeat(160_000) }), 'too_large'],
  ];
  for (const [label, content] of cases) await writeRecord(root, 'app-one', `job-${label}`, content);
  const { result, text, exitCode } = await audit(root, ['SECRET', 'a'.repeat(64)]);
  for (const [label, , issue] of cases) {
    assert.deepEqual(
      result.entries.find((entry) => entry.job_id === `job-${label}`),
      { app_id: 'app-one', job_id: `job-${label}`, record: 'unreadable', coverage: 'unverified', issue, state: null, ignored_initial: 'unknown', private_baseline: 'missing', exposes_names: null },
      label,
    );
    assert.match(text, new RegExp(`^app-one/job-${label}: record unreadable, UNVERIFIED \\(${issue}\\), state -, ignored_initial unknown, private baseline missing$`, 'm'));
  }
  assert.equal(exitCode, 1);
  assert.match(text, /6 unverified/);
  assert.match(text, /coverage INCOMPLETE/);
  assert.doesNotMatch(text, /coverage complete/);
});

test('R5-1: a record whose JSON hides content from the parser or the schema is unverified, not clean', async () => {
  const root = await mediator();
  const clean = (job: string) => currentRecord('app-one', job, null);
  const names = { entries: ['SECRET-dup/'], credentials: { 'SECRET-dup/.env': 'b'.repeat(64) } };
  // JSON.parse keeps the last duplicate, so the earlier value is only visible in the raw text.
  const duplicate = JSON.stringify(clean('job-duplicate')).replace('"ignored_initial":null', `"ignored_initial":${JSON.stringify(names)}, "ignored_initial" : null`);
  const cases: Array<[string, string, LegacyAudit['entries'][number]['record'], string]> = [
    ['job-duplicate', duplicate, 'ok', 'duplicate_key'],
    ['job-duplicate-nested', JSON.stringify(clean('job-duplicate-nested')).replace('"error":null', '"error":{"code":"x","message":"SECRET-a","message":"y"}'), 'ok', 'duplicate_key'],
    ['job-extra-field', JSON.stringify({ ...clean('job-extra-field'), baseline: names }), 'legacy-format', 'unknown_shape'],
    ['job-proto-artifacts', JSON.stringify(clean('job-proto-artifacts')).replace('"artifacts":{}', '"artifacts":{"__proto__":"SECRET-proto/.env"}'), 'ok', 'unknown_shape'],
  ];
  for (const [job, content] of cases) await writeRecord(root, 'app-one', job, content);
  const { result, text, exitCode } = await audit(root, ['SECRET', 'b'.repeat(64)]);
  for (const [job, , record, issue] of cases) {
    const entry = result.entries.find((candidate) => candidate.job_id === job);
    assert.deepEqual([entry?.record, entry?.coverage, entry?.issue, entry?.exposes_names], [record, 'unverified', issue, null], job);
    assert.match(text, new RegExp(`^app-one/${job}: record ${record}, UNVERIFIED \\(${issue}\\), `, 'm'));
  }
  assert.equal(exitCode, 1);
  assert.match(text, /coverage INCOMPLETE/);
});

test('R5-2: a symlinked, non-regular or unreadable execution.json is never skipped and never passes', async () => {
  const root = await mediator();
  // The link target is a valid, harmless record inside the mediator; the audit must still not follow it.
  await writeRecord(root, 'app-one', 'job-target', JSON.stringify(currentRecord('app-one', 'job-target', null)));
  await mkdir(jobPath(root, 'app-one', 'job-link'), { recursive: true });
  await symlink('../job-target/execution.json', join(jobPath(root, 'app-one', 'job-link'), 'execution.json'));
  await mkdir(join(jobPath(root, 'app-one', 'job-dir'), 'execution.json'), { recursive: true });
  await mkdir(jobPath(root, 'app-one', 'job-dangling'), { recursive: true });
  await symlink('missing-target.json', join(jobPath(root, 'app-one', 'job-dangling'), 'execution.json'));
  if (unprivileged) {
    await writeRecord(root, 'app-one', 'job-noperm', JSON.stringify(currentRecord('app-one', 'job-noperm', { entries: ['SECRET-noperm/'], credentials: {} })));
    await chmod(join(jobPath(root, 'app-one', 'job-noperm'), 'execution.json'), 0o000);
  }
  const { result, text, exitCode } = await audit(root, ['SECRET']);
  const issue = (job: string) => result.entries.find((entry) => entry.job_id === job);
  assert.equal(issue('job-target')?.coverage, 'verified');
  for (const [job, expected] of [['job-link', 'symlink'], ['job-dangling', 'symlink'], ['job-dir', 'not_regular'], ...(unprivileged ? [['job-noperm', 'unreadable']] : [])] as const) {
    assert.equal(issue(job)?.coverage, 'unverified', job);
    assert.equal(issue(job)?.issue, expected, job);
    assert.equal(issue(job)?.exposes_names, null, job);
  }
  // A dangling link is not mistaken for a missing record.
  assert.ok(!result.unprepared.some((job) => job.job_id === 'job-dangling'));
  assert.equal(exitCode, 1);
  assert.match(text, /coverage INCOMPLETE/);
});

test('R5-3: symlinked or uninspectable app, jobs and job directories are reported as coverage gaps and never traversed', async () => {
  const root = await mediator();
  const exposing = (app: string, job: string) => JSON.stringify(currentRecord(app, job, { entries: ['SECRET-linked/'], credentials: {} }));
  // An exposing record that is reachable only through the links below.
  await writeRecord(root, 'real-app', 'job-hidden', exposing('real-app', 'job-hidden'));
  await mkdir(join(root, 'stash', 'job-stashed'), { recursive: true });
  await writeFile(join(root, 'stash', 'job-stashed', 'execution.json'), exposing('linked-jobs', 'job-stashed'));
  const apps = join(root, 'factory-data', 'apps');
  // App directory as an in-root symlink.
  await symlink('real-app', join(apps, 'linked-app'));
  // Jobs directory as an in-root symlink.
  await mkdir(join(apps, 'linked-jobs'));
  await symlink('../../../stash', join(apps, 'linked-jobs', 'jobs'));
  // Job directory as an in-root symlink, next to a healthy job of the same app.
  await writeRecord(root, 'mixed-app', 'job-good', JSON.stringify(currentRecord('mixed-app', 'job-good', null)));
  await symlink('../../real-app/jobs/job-hidden', join(apps, 'mixed-app', 'jobs', 'job-linked'));
  // A plain file where an app, a jobs directory and a job directory belong.
  await writeFile(join(apps, 'file-app'), 'SECRET-file-app');
  await mkdir(join(apps, 'file-jobs'));
  await writeFile(join(apps, 'file-jobs', 'jobs'), 'SECRET-file-jobs');
  await writeFile(join(apps, 'mixed-app', 'jobs', 'job-file'), 'SECRET-file-job');
  // Names outside the id pattern can still be read through factory_read_file.
  await writeRecord(root, 'mixed-app', 'Job_SECRET', exposing('mixed-app', 'x'));
  await mkdir(join(apps, 'App_SECRET'));
  if (unprivileged) {
    await writeRecord(root, 'locked-app', 'job-locked', exposing('locked-app', 'job-locked'));
    await chmod(join(apps, 'locked-app', 'jobs'), 0o000);
  }

  // The MCP reader resolves the in-root links, so these records are exposed.
  const reader = new RepoFiles(root);
  for (const path of ['factory-data/apps/linked-app/jobs/job-hidden/execution.json', 'factory-data/apps/mixed-app/jobs/job-linked/execution.json', 'factory-data/apps/linked-jobs/jobs/job-stashed/execution.json']) {
    assert.match((await reader.read({ path })).text, /SECRET-linked/, path);
  }

  const { result, text, exitCode } = await audit(root, ['SECRET', 'stash']);
  const gaps = result.gaps.map((gap) => `${gap.path} ${gap.kind} ${gap.reason}`).sort();
  assert.deepEqual(gaps, [
    'factory-data/apps apps unexpected_name',
    'factory-data/apps/file-app app not_directory',
    'factory-data/apps/file-jobs/jobs jobs not_directory',
    'factory-data/apps/linked-app app symlink',
    'factory-data/apps/linked-jobs/jobs jobs symlink',
    ...(unprivileged ? ['factory-data/apps/locked-app/jobs jobs unreadable'] : []),
    'factory-data/apps/mixed-app/jobs jobs unexpected_name',
    'factory-data/apps/mixed-app/jobs/job-file job not_directory',
    'factory-data/apps/mixed-app/jobs/job-linked job symlink',
  ].sort());
  // Nothing was read through a link: the only exposing record found is the real one.
  assert.deepEqual(result.entries.map((entry) => `${entry.app_id}/${entry.job_id} ${entry.coverage} ${entry.exposes_names}`).sort(), [
    'mixed-app/job-good verified false',
    'real-app/job-hidden verified true',
  ]);
  assert.match(text, /^factory-data\/apps\/linked-app: COVERAGE GAP \(app directory is a symlink, not followed\)$/m);
  assert.match(text, /^factory-data\/apps: COVERAGE GAP \(1 entry with a name outside the id pattern, not inspected\)$/m);
  assert.equal(exitCode, 1);
});

test('R5-3: an uninspectable factory-data or apps directory fails the audit instead of passing as empty', async () => {
  const cases: Array<[string, (root: string) => Promise<void>, string]> = [
    ['data symlink', async (root) => {
      // An in-root factory-data elsewhere, reachable only through the link.
      await writeRecord(join(root, 'real'), 'app-one', 'job-one', JSON.stringify(currentRecord('app-one', 'job-one', { entries: ['SECRET-x/'], credentials: {} })));
      await symlink('real/factory-data', join(root, 'factory-data'));
    }, 'factory-data data symlink'],
    ['data file', async (root) => writeFile(join(root, 'factory-data'), 'x'), 'factory-data data not_directory'],
    ['apps symlink', async (root) => {
      await mkdir(join(root, 'factory-data', 'elsewhere'), { recursive: true });
      await symlink('elsewhere', join(root, 'factory-data', 'apps'));
    }, 'factory-data/apps apps symlink'],
    ['apps file', async (root) => {
      await mkdir(join(root, 'factory-data'));
      await writeFile(join(root, 'factory-data', 'apps'), 'x');
    }, 'factory-data/apps apps not_directory'],
    ...(unprivileged
      ? [['apps unreadable', async (root: string) => {
          await writeRecord(root, 'app-one', 'job-one', '{}');
          await chmod(join(root, 'factory-data', 'apps'), 0o000);
        }, 'factory-data/apps apps unreadable'] as [string, (root: string) => Promise<void>, string]]
      : []),
  ];
  for (const [label, build, gap] of cases) {
    const root = await mediator();
    await build(root);
    const { result, text, exitCode } = await audit(root, ['SECRET']);
    assert.equal(result.data, 'present', label);
    assert.deepEqual(result.gaps.map((entry) => `${entry.path} ${entry.kind} ${entry.reason}`), [gap], label);
    assert.deepEqual(result.entries, [], label);
    assert.equal(exitCode, 1, label);
    assert.match(text, /coverage INCOMPLETE/, label);
  }
});

test('R5-4: a genuinely absent execution.json or data directory is classified distinctly from a failure', async () => {
  const root = await mediator();
  await mkdir(jobPath(root, 'app-one', 'job-unprepared'), { recursive: true });
  await writeFile(join(jobPath(root, 'app-one', 'job-unprepared'), 'instruction.md'), '# SECRET-instruction\n');
  // A registered app without a jobs directory yet.
  await mkdir(join(root, 'factory-data', 'apps', 'app-new'));
  const { result, text, exitCode } = await audit(root, ['SECRET']);
  assert.deepEqual(result, { data: 'present', entries: [], gaps: [], unprepared: [{ app_id: 'app-one', job_id: 'job-unprepared' }] });
  assert.match(text, /1 job\(s\) without execution\.json \(not prepared\)/);
  assert.equal(exitCode, 0);

  // Never initialized: no factory-data, or factory-data without apps.
  for (const build of [async () => undefined, async (dir: string) => mkdir(join(dir, 'factory-data'))]) {
    const empty = await mediator();
    await build(empty);
    const absent = await audit(empty);
    assert.deepEqual(absent.result, { data: 'absent', entries: [], gaps: [], unprepared: [] });
    assert.match(absent.text, /^factory-data\/apps does not exist: never initialized, no execution records\.$/m);
    assert.equal(absent.exitCode, 0);
  }
});

test('R5-5: positive control: only fully inspected, valid, non-exposing records give exit 0', async () => {
  const root = await mediator();
  await writeRecord(root, 'app-one', 'job-current', JSON.stringify(currentRecord('app-one', 'job-current', null)));
  await writeRecord(root, 'app-one', 'job-empty-legacy', JSON.stringify(currentRecord('app-one', 'job-empty-legacy', { entries: [], credentials: {}, complete: true })));
  // Quotes, backslashes and colons inside values are not keys.
  const tricky = { ...currentRecord('app-one', 'job-tricky', null), error: { code: 'c', message: 'a "key": \\ "b":\n{"x": 1}' }, recovery: '\\' };
  await writeRecord(root, 'app-one', 'job-tricky', JSON.stringify(tricky, null, 2));
  await writeRecord(root, 'app-two', 'job-earliest', JSON.stringify({ schema: SCHEMA, app_id: 'app-two', job_id: 'job-earliest', state: 'completed' }));
  await mkdir(jobPath(root, 'app-two', 'job-unprepared'), { recursive: true });
  const { result, text, exitCode } = await audit(root);
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.entries.map((entry) => [entry.job_id, entry.record, entry.coverage, entry.issue, entry.exposes_names]), [
    ['job-current', 'ok', 'verified', null, false],
    ['job-empty-legacy', 'ok', 'verified', null, false],
    ['job-tricky', 'ok', 'verified', null, false],
    ['job-earliest', 'legacy-format', 'verified', null, false],
  ]);
  assert.match(text, /^app-one\/job-current: record ok, state completed, ignored_initial null, private baseline missing$/m);
  assert.match(text, /^4 execution record\(s\): 4 verified, 0 unverified; 0 may expose ignored-file names in execution\.json; 0 coverage gap\(s\); 1 job\(s\) without execution\.json \(not prepared\)\.$/m);
  assert.match(text, /^Audit coverage complete: every record and directory was inspected; none exposes ignored-file names\.$/m);
  assert.equal(exitCode, 0);

  // One exposing record, all else verified: still nonzero, reported as exposure, not as a coverage gap.
  await writeRecord(root, 'app-two', 'job-exposing', JSON.stringify(currentRecord('app-two', 'job-exposing', { entries: ['SECRET-exposed/'], credentials: {} })));
  const exposing = await audit(root, ['SECRET']);
  assert.equal(exposing.exitCode, 1);
  assert.match(exposing.text, /1 may expose ignored-file names/);
  assert.match(exposing.text, /^Audit FAILED: 1 record\(s\) may expose ignored-file names in execution\.json\.$/m);
  assert.doesNotMatch(exposing.text, /coverage INCOMPLETE/);
});
