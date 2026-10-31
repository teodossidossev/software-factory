// Contract tests for the SF-006 execution adapter: a throwaway mediator with an
// accepted SF-005 job, a registered application Git repository, a stubbed
// OpenClaw receiver lookup and a fake `claude` executable. The fake is a real
// child process: it records its argv, cwd and environment, writes a session
// transcript in Claude Code's format and changes the repository according to
// a scenario. No real Claude Code, Docker or network is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { auditLegacyRecords, formatLegacyAudit, type LegacyAuditEntry } from '../src/execution/legacy-audit.js';
import { ProcessClaudeRunner } from '../src/execution/runner.js';
import { SessionGate } from '../src/execution/session-gate.js';
import { RepoFiles } from '../src/repo-files.js';
import { ExecutionService, type ExecutionDeps } from '../src/execution/service.js';
import type { ReceiverRecord } from '../src/openclaw-channel.js';

const APP = 'app-one';
// Computed independently (Python hashlib).
const INSTRUCTION = '# Задача\n\nДобави ред „готово“ в README. ✓\n';
const INSTRUCTION_SHA = createHash('sha256').update(Buffer.from(INSTRUCTION, 'utf8')).digest('hex');

// The fake claude: behaviour comes from control.json next to it.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const control = JSON.parse(fs.readFileSync(path.join(__dirname, 'control.json'), 'utf8'));
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'invocations.jsonl'), JSON.stringify({
  argv, cwd: process.cwd(), env: Object.keys(process.env).filter((k) => /^(SF_|FACTORY_|OPENCLAW_|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|MESSAGING_TOKEN))/.test(k)), home: Boolean(process.env.HOME), pid: process.pid,
}) + '\n');
const sid = argv[argv.indexOf('--session-id') + 1];
const prompt = argv[argv.length - 1];
const [command, ...rest] = prompt.split(' ');
const dir = path.join(control.projects, control.mode === 'wrong-project' ? 'some-other-project' : process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const line = (entry) => fs.appendFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify({ sessionId: sid, cwd: process.cwd(), ...entry }) + '\n');
if (control.mode !== 'no-skill') {
  line({ type: 'user', message: { role: 'user', content: '<command-message>' + command.slice(1) + '</command-message>\n<command-name>' + command + '</command-name>\n<command-args>' + rest.join(' ') + '</command-args>' } });
  const skillDir = control.mode === 'project-skill' ? path.join(process.cwd(), '.claude', 'skills', command.slice(1)) : path.join(control.home, '.claude', 'skills', command.slice(1));
  line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: ' + skillDir + '\n\nImplement...' } });
} else {
  line({ type: 'user', message: { role: 'user', content: 'please implement the instruction' } });
}
const sensitive = control.mode === 'sensitive-text' ? ' # internal note PIN-4711-NOT-A-TOKEN' : '';
line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cd ' + process.cwd() + ' && npm test' + sensitive } }] } });
line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: control.mode === 'exit1', content: 'ok' }] } });
const repoFile = (name, text) => { fs.mkdirSync(path.dirname(path.join(process.cwd(), name)), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), name), text); };
fs.appendFileSync(path.join(process.cwd(), 'README.md'), 'готово\n');
repoFile('src/feature.txt', 'new feature\n');
if (control.mode === 'secret-file') repoFile('.env', 'TOKEN=fixture-only\n');
if (control.mode === 'secret-content') repoFile('src/key.pem', '-----BEGIN RSA PRIVATE KEY-----\nfixture\n');
if (control.mode === 'commit') execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'by claude']);
if (control.mode === 'stage' || control.mode === 'stage-exit1') execFileSync('git', ['add', 'README.md']);
if (control.mode === 'leak-path') repoFile('src/paths.txt', 'repo at ' + process.cwd() + '\n');
if (control.mode === 'ignored-secret') fs.writeFileSync(path.join(process.cwd(), '.env'), 'TOKEN=fixture-only\n');
if (control.mode === 'sensitive-text') repoFile('.env', 'TOKEN=fixture-only\n');
if (control.mode === 'ignored-nested' || control.mode === 'ignored-nested-new') repoFile('hidden/deep/.env', 'TOKEN=changed-fixture\n');
const hidden = (p) => path.join(process.cwd(), 'hidden', 'deep', p);
if (control.mode === 'delete-ignored') fs.rmSync(hidden('.env'));
if (control.mode === 'delete-ignored-dir') fs.rmSync(path.join(process.cwd(), 'hidden'), { recursive: true });
if (control.mode === 'symlink-new' || control.mode === 'symlink-replace') { fs.rmSync(hidden('.env'), { force: true }); fs.symlinkSync(control.target, hidden('.env')); }
if (control.mode === 'symlink-remove') fs.rmSync(hidden('.env'));
if (control.mode === 'symlink-alter') { fs.rmSync(hidden('.env')); fs.symlinkSync(control.target + '-other', hidden('.env')); }
if (control.mode === 'outside-change') fs.writeFileSync(path.join(control.target, '.env'), 'TOKEN=changed-outside\n');
if (control.mode === 'many-files') for (let i = 0; i < 1100; i += 1) repoFile('gen/f' + i + '.txt', 'x\n');
if (control.mode === 'big-diff') for (let i = 0; i < 3; i += 1) repoFile('big/b' + i + '.txt', ('line of text ' + i + '\n').repeat(60000));
process.stdout.write('fake claude stdout\n');
process.stderr.write('fake claude stderr\n');
line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done: README updated in ' + process.cwd() + '.' + sensitive }] } });
if (control.mode === 'hang') { setInterval(() => {}, 1000); return; }
if (control.mode === 'crash') process.kill(process.pid, 'SIGKILL');
process.exit(control.mode === 'exit1' || control.mode === 'stage-exit1' ? 1 : 0);
`;

let sandbox: string;
let mediator: string;
let appRepo: string;
let fakeDir: string;
let projects: string;
let receiver: Map<string, ReceiverRecord>;
let receiverDown: boolean;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
}

function jobDir(job: string): string {
  return join(mediator, 'factory-data', 'apps', APP, 'jobs', job);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

async function invocations(): Promise<Array<{ argv: string[]; cwd: string; env: string[]; home: boolean }>> {
  try {
    return (await readFile(join(fakeDir, 'invocations.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function setMode(mode: string, target?: string): Promise<void> {
  await writeFile(join(fakeDir, 'control.json'), JSON.stringify({ mode, projects, home: sandbox, target }));
}

// An accepted SF-005 job as the bridge would leave it: instruction, dispatch.json, receipt, receiver record.
async function acceptedJob(job: string, content = INSTRUCTION): Promise<{ requestId: string; sha: string }> {
  const dir = jobDir(job);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'instruction.md'), content, { mode: 0o600 });
  const sha = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
  const requestId = randomUUID();
  const run = { automation_id: 'f431a516-c14c-4f88-b7a8-4745b8bd3b48', run_id: `manual:f431a516:${requestId}`, status: 'ok', completion_status: 'succeeded' };
  const now = new Date().toISOString();
  const ack = { sf_dispatch: 'accepted', request_id: requestId, app_id: APP, job_id: job, instruction_sha256: sha, accepted_at: now };
  await writeFile(join(dir, 'dispatch.json'), JSON.stringify({
    schema: 'software-factory.dispatch/v1', request_id: requestId, app_id: APP, job_id: job, instruction_sha256: sha,
    state: 'accepted', revision: 3, attempts: 1, created_at: now, updated_at: now, last_error: null,
    receipt: 'openclaw-receipt.json', openclaw: run,
    history: [{ attempt: 1, outcome: 'accepted', finished_at: now, openclaw: run, error: null }],
  }));
  await writeFile(join(dir, 'openclaw-receipt.json'), JSON.stringify({
    schema: 'software-factory.openclaw-receipt/v1', request_id: requestId, app_id: APP, job_id: job, instruction_sha256: sha,
    attempt: 1, outcome: 'accepted', recorded_at: now, openclaw: { ...run, output: JSON.stringify(ack) }, acknowledgement: ack,
  }));
  receiver.set(requestId, { request_id: requestId, app_id: APP, job_id: job, instruction_sha256: sha, accepted_at: now });
  return { requestId, sha };
}

function service(overrides: Partial<ExecutionDeps> = {}): ExecutionService {
  return new ExecutionService({
    mediatorRoot: mediator,
    receiverLookup: async (requestId) => {
      if (receiverDown) {
        throw new Error('service "gateway" is not running');
      }
      return receiver.get(requestId);
    },
    // A throwaway session gate (Review 01): never the operator's real one.
    runner: new ProcessClaudeRunner(join(fakeDir, 'claude'), 'fake 0.0.0', 'ignore', new SessionGate(join(sandbox, 'gate', 'claude-session.lock'))),
    claudeProjectsDir: projects,
    claudeConfigDir: join(sandbox, '.claude'),
    authStatus: async () => ({ loggedIn: true, method: 'fake' }),
    insideClaudeSession: false,
    ...overrides,
  });
}

const confirmYes = async (): Promise<boolean> => true;

function rejectsWith(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code, String(error));
    assert.doesNotMatch(String((error as Error).message), new RegExp(appRepo.replaceAll('/', '\\/')));
    return true;
  };
}

// Every file the adapter exported to the mediator for one job, as one string.
async function exported(job: string): Promise<string> {
  const names = (await readdir(jobDir(job))).filter((name) => !['instruction.md', 'dispatch.json', 'openclaw-receipt.json'].includes(name));
  return (await Promise.all(names.map((name) => readFile(join(jobDir(job), name), 'utf8')))).join('\n');
}

before(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'sf-execution-')));
  mediator = join(sandbox, 'mediator');
  fakeDir = join(sandbox, 'fake');
  projects = join(sandbox, 'projects');
  await mkdir(join(mediator, 'factory-data', 'apps', APP), { recursive: true });
  git(sandbox, 'init', '-q', 'mediator');
  await mkdir(fakeDir);
  await writeFile(join(fakeDir, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  await mkdir(join(sandbox, '.claude', 'skills', 'implement'), { recursive: true });
  await writeFile(join(sandbox, '.claude', 'skills', 'implement', 'SKILL.md'), '---\nname: implement\n---\nfixture\n');
});

beforeEach(async () => {
  // A fresh, clean application repository and registration for every test.
  appRepo = join(sandbox, `app-${randomUUID().slice(0, 8)}`);
  await mkdir(appRepo);
  git(appRepo, 'init', '-q');
  await writeFile(join(appRepo, 'README.md'), '# App\n');
  git(appRepo, 'add', 'README.md');
  git(appRepo, 'commit', '-q', '-m', 'init');
  await writeFile(join(mediator, 'factory-data', 'apps', APP, '.env'), `APP_REPO=${appRepo}\n`, { mode: 0o600 });
  receiver = new Map();
  receiverDown = false;
  await rm(join(fakeDir, 'invocations.jsonl'), { force: true });
  await setMode('ok');
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

test('prepare copies the exact instruction bytes into the app repository and records prepared', async () => {
  const { requestId } = await acceptedJob('job-copy');
  const indexBefore = git(appRepo, 'ls-files', '-s');
  const prepared = await service().prepare(APP, 'job-copy');
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.destination, '.software-factory/jobs/job-copy/instruction.md');
  const copy = await readFile(join(appRepo, '.software-factory', 'jobs', 'job-copy', 'instruction.md'));
  assert.ok(copy.equals(Buffer.from(INSTRUCTION, 'utf8')));
  assert.equal(createHash('sha256').update(copy).digest('hex'), INSTRUCTION_SHA);

  const record = await readJson(join(jobDir('job-copy'), 'execution.json'));
  assert.deepEqual([record.schema, record.state, record.request_id, record.instruction_sha256], ['software-factory.execution/v1', 'prepared', requestId, INSTRUCTION_SHA]);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(appRepo.replaceAll('/', '\\/')));
  // Acceptance artifacts are unchanged, the index is untouched, Claude was not started.
  assert.equal((await readJson(join(jobDir('job-copy'), 'dispatch.json'))).state, 'accepted');
  assert.equal(git(appRepo, 'ls-files', '-s'), indexBefore);
  assert.equal((await invocations()).length, 0);

  // Repeating prepare is a no-op; it never rewrites the copy.
  assert.equal((await service().prepare(APP, 'job-copy')).state, 'prepared');
});

test('every acceptance precondition is required before anything is written to the app repository', async () => {
  const cases: Array<[string, string, (job: string) => Promise<void>]> = [
    ['no dispatch', 'not_accepted', async (job) => rm(join(jobDir(job), 'dispatch.json'))],
    ['dispatch not accepted', 'not_accepted', async (job) => {
      const record = await readJson(join(jobDir(job), 'dispatch.json'));
      await writeFile(join(jobDir(job), 'dispatch.json'), JSON.stringify({ ...record, state: 'requested', history: [] }));
    }],
    ['malformed dispatch', 'invalid_record', async (job) => writeFile(join(jobDir(job), 'dispatch.json'), '{"schema":"software-factory.dispatch/v1"}')],
    ['receipt missing', 'invalid_record', async (job) => rm(join(jobDir(job), 'openclaw-receipt.json'))],
    ['instruction changed after acceptance', 'instruction_mismatch', async (job) => writeFile(join(jobDir(job), 'instruction.md'), `${INSTRUCTION}x`)],
    ['no receiver record in OpenClaw', 'openclaw_unconfirmed', async () => receiver.clear()],
    ['receiver record for another job', 'openclaw_unconfirmed', async () => {
      for (const [id, entry] of receiver) receiver.set(id, { ...entry, job_id: 'other-job' });
    }],
    ['receiver record with another sha256', 'openclaw_unconfirmed', async () => {
      for (const [id, entry] of receiver) receiver.set(id, { ...entry, instruction_sha256: '0'.repeat(64) });
    }],
    ['OpenClaw not reachable', 'openclaw_unavailable', async () => {
      receiverDown = true;
    }],
  ];
  for (const [label, code, breakIt] of cases) {
    const job = `job-${label.replace(/[^a-z]+/g, '-').replace(/-$/, '')}`;
    await acceptedJob(job);
    await breakIt(job);
    await assert.rejects(service().prepare(APP, job), rejectsWith(code), label);
    await assert.rejects(readdir(join(appRepo, '.software-factory')), { code: 'ENOENT' }, label);
    await assert.rejects(readFile(join(jobDir(job), 'execution.json')), { code: 'ENOENT' }, label);
  }
  // Read-only preflight reports the same problem without writing anything.
  receiverDown = false;
  await acceptedJob('job-pre');
  receiver.clear();
  const report = await service().preflight(APP, 'job-pre');
  assert.equal(report.ready, false);
  assert.ok(report.checks.some((check) => !check.ok && check.code === 'openclaw_unconfirmed'));
  await assert.rejects(readFile(join(jobDir('job-pre'), 'execution.json')), { code: 'ENOENT' });
});

test('wrong app, invalid ids, unconfigured apps and unsafe destinations are refused', async () => {
  await acceptedJob('job-ids');
  await assert.rejects(service().prepare('../app-one', 'job-ids'), rejectsWith('invalid_id'));
  await assert.rejects(service().prepare(APP, '../job-ids'), rejectsWith('invalid_id'));
  await assert.rejects(service().prepare('other-app', 'job-ids'), rejectsWith('app_not_registered'));
  await mkdir(join(mediator, 'factory-data', 'apps', 'sf-pilot'), { recursive: true });
  await assert.rejects(service().prepare('sf-pilot', 'job-ids'), rejectsWith('app_not_configured'));
  await assert.rejects(service().prepare(APP, 'job-missing'), rejectsWith('not_found'));

  // A symlinked .software-factory in the app repository could redirect the copy elsewhere.
  await mkdir(join(sandbox, 'elsewhere'), { recursive: true });
  await symlink(join(sandbox, 'elsewhere'), join(appRepo, '.software-factory'));
  await assert.rejects(service().prepare(APP, 'job-ids'), rejectsWith('unsafe_destination'));
  assert.deepEqual(await readdir(join(sandbox, 'elsewhere')), []);
});

test('a dirty app repository or a different existing copy is refused, never overwritten', async () => {
  await acceptedJob('job-dirty');
  await writeFile(join(appRepo, 'README.md'), '# App\nuser work in progress\n');
  await assert.rejects(service().prepare(APP, 'job-dirty'), rejectsWith('repo_dirty'));
  assert.equal(await readFile(join(appRepo, 'README.md'), 'utf8'), '# App\nuser work in progress\n');
  git(appRepo, 'checkout', '-q', 'README.md');

  await mkdir(join(appRepo, '.software-factory', 'jobs', 'job-dirty'), { recursive: true });
  await writeFile(join(appRepo, '.software-factory', 'jobs', 'job-dirty', 'instruction.md'), 'something else\n');
  await assert.rejects(service().prepare(APP, 'job-dirty'), rejectsWith('destination_conflict'));
  assert.equal(await readFile(join(appRepo, '.software-factory', 'jobs', 'job-dirty', 'instruction.md'), 'utf8'), 'something else\n');
});

test('run launches exactly one Claude session with the fixed command, cwd and clean environment, then collects', async () => {
  await acceptedJob('job-run');
  await service().prepare(APP, 'job-run');
  const indexBefore = git(appRepo, 'ls-files', '-s');
  process.env.SF_GATEWAY_TOKEN = 'must-not-reach-claude';
  process.env.FACTORY_REPO_ROOT = mediator;
  let result;
  try {
    result = await service().run(APP, 'job-run', confirmYes);
  } finally {
    delete process.env.SF_GATEWAY_TOKEN;
    delete process.env.FACTORY_REPO_ROOT;
  }
  assert.equal(result.state, 'completed');

  const calls = await invocations();
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call!.cwd, appRepo);
  const sessionId = (await readJson(join(jobDir('job-run'), 'execution.json'))).session as { id: string; name: string };
  assert.deepEqual(call!.argv, ['--permission-mode', 'manual', '--session-id', sessionId.id, '--name', sessionId.name, '/implement .software-factory/jobs/job-run/instruction.md']);
  assert.deepEqual(call!.env, []);
  assert.equal(call!.home, true);

  const record = await readJson(join(jobDir('job-run'), 'execution.json'));
  assert.equal(record.state, 'completed');
  assert.deepEqual(record.evidence, { transcript_found: true, skill_invoked: true, args_match: true, cwd_match: true });
  assert.equal((record.session as { exit_code: number }).exit_code, 0);
  const artifacts = record.artifacts as Record<string, string>;
  for (const name of ['report.md', 'implementation.diff', 'new-files.md', 'checks.md']) {
    const bytes = await readFile(join(jobDir('job-run'), name));
    assert.equal(artifacts[name], createHash('sha256').update(bytes).digest('hex'), name);
  }
  const diff = await readFile(join(jobDir('job-run'), 'implementation.diff'), 'utf8');
  assert.match(diff, /\+готово/);
  assert.match(diff, /src\/feature\.txt/);
  assert.doesNotMatch(diff, /\.software-factory/);
  assert.match(await readFile(join(jobDir('job-run'), 'new-files.md'), 'utf8'), /src\/feature\.txt/);
  assert.match(await readFile(join(jobDir('job-run'), 'checks.md'), 'utf8'), /npm test/);
  // Nothing exported names the private repository path.
  assert.doesNotMatch(await exported('job-run'), new RegExp(appRepo.replaceAll('/', '\\/')));
  // The adapter never staged or committed.
  assert.equal(git(appRepo, 'ls-files', '-s'), indexBefore);
  assert.equal(git(appRepo, 'rev-list', '--count', 'HEAD').trim(), '1');

  // A second run, a re-prepare or a collect never starts another session.
  await assert.rejects(service().run(APP, 'job-run', confirmYes), rejectsWith('wrong_state'));
  assert.equal((await service().prepare(APP, 'job-run')).state, 'completed');
  assert.equal((await service().collect(APP, 'job-run', { sessionFinished: true })).state, 'completed');
  assert.equal((await invocations()).length, 1);
});

test('concurrent run attempts start one session; the rest are refused', async () => {
  await acceptedJob('job-race');
  await service().prepare(APP, 'job-race');
  const results = await Promise.allSettled([service().run(APP, 'job-race', confirmYes), service().run(APP, 'job-race', confirmYes), service().run(APP, 'job-race', confirmYes)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results.filter((x) => x.status === 'rejected')) {
    assert.ok(['locked', 'wrong_state'].includes((r.reason as { code: string }).code), String(r.reason));
  }
  assert.equal((await invocations()).length, 1);
});

test('failed, interrupted and skill-less executions are never reported as completed', async () => {
  const outcomes: Array<[string, string, string | null]> = [
    ['exit1', 'failed', 'claude_exit'],
    ['crash', 'interrupted', 'claude_signal'],
    ['no-skill', 'failed', 'skill_not_invoked'],
    ['commit', 'failed', 'git_changed'],
    ['stage', 'failed', 'git_changed'],
  ];
  for (const [mode, state, code] of outcomes) {
    const job = `job-${mode}`;
    await acceptedJob(job);
    // Each scenario needs a clean repository again.
    git(appRepo, 'reset', '-q', '--hard');
    git(appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
    await service().prepare(APP, job);
    await setMode(mode);
    const result = await service().run(APP, job, confirmYes);
    assert.equal(result.state, state, mode);
    assert.equal(result.error?.code ?? null, code, mode);
    assert.ok(result.recovery, `${mode} explains recovery`);
    // Results are still collected for review.
    await readFile(join(jobDir(job), 'implementation.diff'));
    await assert.rejects(service().run(APP, job, confirmYes), rejectsWith('wrong_state'), mode);
  }
  assert.equal((await invocations()).length, outcomes.length);
});

test('a run whose adapter died is detected as interrupted and never relaunched', async () => {
  await acceptedJob('job-died');
  await service().prepare(APP, 'job-died');
  // Simulate an adapter that crashed after recording the launch: a running record whose process is gone.
  const path = join(jobDir('job-died'), 'execution.json');
  const record = await readJson(path);
  const sessionId = randomUUID();
  await writeFile(path, JSON.stringify({
    ...record, state: 'running', revision: (record.revision as number) + 1,
    session: { id: sessionId, name: 'sf-app-one-job-died', mode: 'interactive', runner: 'fake 0.0.0', pid: 2147483646, pid_start: '1', boot_id: 'other-boot', started_at: new Date().toISOString(), ended_at: null, exit_code: null, signal: null },
  }));
  const status = await service().status(APP, 'job-died');
  assert.equal(status.state, 'running');
  assert.equal(status.process_alive, false);
  // status is read-only.
  assert.equal((await readJson(path)).state, 'running');

  await assert.rejects(service().run(APP, 'job-died', confirmYes), rejectsWith('wrong_state'));
  const collected = await service().collect(APP, 'job-died', { sessionFinished: false });
  assert.equal(collected.state, 'interrupted');
  assert.match(collected.recovery ?? '', new RegExp(`claude --resume ${sessionId}`));
  assert.equal((await invocations()).length, 0);
});

test('handoff hands the exact command to the operator and collect verifies the manual session', async () => {
  await acceptedJob('job-manual');
  await service().prepare(APP, 'job-manual');
  const handoff = await service().handoff(APP, 'job-manual');
  assert.equal(handoff.state, 'pending_manual');
  const sessionId = ((await readJson(join(jobDir('job-manual'), 'execution.json'))).session as { id: string }).id;
  assert.deepEqual(handoff.command, ['claude', '--permission-mode', 'manual', '--session-id', sessionId, '--name', `sf-${APP}-job-manual`, '/implement .software-factory/jobs/job-manual/instruction.md']);
  assert.equal(handoff.cwd, appRepo);
  assert.equal((await invocations()).length, 0);

  // Without a transcript the job stays pending_manual.
  await assert.rejects(service().collect(APP, 'job-manual', { sessionFinished: true }), rejectsWith('transcript_missing'));
  // The operator runs the handed-off command (here: the fake) in the app repository.
  execFileSync(join(fakeDir, 'claude'), handoff.command.slice(1), { cwd: appRepo, stdio: 'ignore' });
  await assert.rejects(service().collect(APP, 'job-manual', { sessionFinished: false }), rejectsWith('session_not_finished'));
  const collected = await service().collect(APP, 'job-manual', { sessionFinished: true });
  assert.equal(collected.state, 'completed');
  assert.equal((await readJson(join(jobDir('job-manual'), 'execution.json'))).state, 'completed');
});

test('sensitive results are withheld for operator inspection instead of being exported', async () => {
  for (const mode of ['secret-file', 'secret-content']) {
    const job = `job-${mode}`;
    await acceptedJob(job);
    git(appRepo, 'reset', '-q', '--hard');
    git(appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
    await service().prepare(APP, job);
    await setMode(mode);
    const result = await service().run(APP, job, confirmYes);
    assert.equal(result.state, 'needs_inspection', mode);
    const out = await exported(job);
    assert.doesNotMatch(out, /fixture-only|BEGIN RSA PRIVATE KEY/, mode);
    assert.doesNotMatch(out, /\+готово/, `${mode}: no diff exported`);
  }
});

test('preflight is read-only and reports readiness without private paths', async () => {
  await acceptedJob('job-ready');
  const before = await readdir(jobDir('job-ready'));
  const report = await service().preflight(APP, 'job-ready');
  assert.equal(report.ready, true, JSON.stringify(report.checks));
  assert.deepEqual(await readdir(jobDir('job-ready')), before);
  await assert.rejects(readdir(join(appRepo, '.software-factory')), { code: 'ENOENT' });
  assert.doesNotMatch(JSON.stringify(report), new RegExp(appRepo.replaceAll('/', '\\/')));

  // A non-executable runner makes preflight not ready.
  await chmod(join(fakeDir, 'claude'), 0o644);
  try {
    assert.equal((await service().preflight(APP, 'job-ready')).ready, false);
  } finally {
    await chmod(join(fakeDir, 'claude'), 0o755);
  }
});

async function freshRepoJob(job: string, mode: string): Promise<void> {
  await acceptedJob(job);
  git(appRepo, 'reset', '-q', '--hard');
  git(appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
  await service().prepare(APP, job);
  await setMode(mode);
}

test('a hung session is reported as running, blocks collect and relaunch, and ends as interrupted', async () => {
  await freshRepoJob('job-hang', 'hang');
  const running = service().run(APP, 'job-hang', confirmYes);
  let status;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await service().status(APP, 'job-hang').catch(() => undefined);
    if (status?.state === 'running' && status.process_alive === true && (await invocations()).length === 1) break;
  }
  assert.equal(status?.state, 'running');
  assert.equal(status?.process_alive, true);
  // Another adapter process can neither collect nor launch while it runs.
  await assert.rejects(service().collect(APP, 'job-hang', { sessionFinished: true }), (e: unknown) => ['locked', 'still_running'].includes((e as { code: string }).code));
  await assert.rejects(service().run(APP, 'job-hang', confirmYes), (e: unknown) => ['locked', 'wrong_state'].includes((e as { code: string }).code));
  const [call] = await invocations();
  process.kill((call as unknown as { pid: number }).pid, 'SIGTERM');
  const result = await running;
  assert.equal(result.state, 'interrupted');
  assert.equal(result.error?.code, 'claude_signal');
  assert.equal((await invocations()).length, 1);
});

test('an unconfirmed end is interrupted; after a manual resume, collect with confirmation completes it', async () => {
  await freshRepoJob('job-unconfirmed', 'ok');
  const result = await service().run(APP, 'job-unconfirmed', async () => false);
  assert.equal(result.state, 'interrupted');
  assert.equal(result.error?.code, 'not_confirmed');
  assert.match(result.recovery ?? '', /claude --resume [0-9a-f-]{36}/);
  // The operator resumed and finished the session by hand, then collects.
  const collected = await service().collect(APP, 'job-unconfirmed', { sessionFinished: true });
  assert.equal(collected.state, 'completed');
  const record = await readJson(join(jobDir('job-unconfirmed'), 'execution.json'));
  assert.equal(record.completion, 'operator_confirmed');
  assert.equal((await invocations()).length, 1);
});

test('launch.claim prevents a second launch even if execution.json is rolled back', async () => {
  await freshRepoJob('job-claim', 'ok');
  assert.equal((await service().run(APP, 'job-claim', confirmYes)).state, 'completed');
  const path = join(jobDir('job-claim'), 'execution.json');
  const record = await readJson(path);
  await writeFile(path, JSON.stringify({ ...record, state: 'prepared', session: null, revision: (record.revision as number) + 1 }));
  // Even with a clean repository again, only the claim stands between this record and a second launch.
  git(appRepo, 'checkout', '-q', '--', '.');
  git(appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
  await assert.rejects(service().run(APP, 'job-claim', confirmYes), rejectsWith('wrong_state'));
  await assert.rejects(service().handoff(APP, 'job-claim'), rejectsWith('wrong_state'));
  assert.equal((await invocations()).length, 1);
  // A malformed execution record is refused, not repaired.
  await writeFile(path, '{"schema":"software-factory.execution/v1"}');
  await assert.rejects(service().status(APP, 'job-claim'), rejectsWith('invalid_record'));
  // Review 02: a record without a known state now blocks every launch on the host (fail closed),
  // so the shared fixture gets its completed record back for the following tests.
  await writeFile(path, JSON.stringify(record));
});

test('exports are withheld when they name the private repository or touch ignored credentials', async () => {
  await freshRepoJob('job-leak', 'leak-path');
  const leaked = await service().run(APP, 'job-leak', confirmYes);
  assert.equal(leaked.state, 'needs_inspection');
  assert.doesNotMatch(await exported('job-leak'), new RegExp(appRepo.replaceAll('/', '\\/')));

  await writeFile(join(appRepo, '.gitignore'), '.env\n');
  git(appRepo, 'add', '.gitignore');
  git(appRepo, 'commit', '-q', '-m', 'ignore .env');
  await freshRepoJob('job-ignored', 'ignored-secret');
  const ignored = await service().run(APP, 'job-ignored', confirmYes);
  assert.equal(ignored.state, 'needs_inspection');
  assert.match(ignored.error?.message ?? '', /Git-ignored credential-style entries: 1 appeared, 0 disappeared, 0 changed/);
  assert.doesNotMatch(await exported('job-ignored'), /fixture-only/);
});

test('the transcript must show the personal skill, in the app repository project, as the first message', async () => {
  await freshRepoJob('job-project-skill', 'project-skill');
  const projectSkill = await service().run(APP, 'job-project-skill', confirmYes);
  assert.equal(projectSkill.state, 'failed');
  assert.equal(projectSkill.error?.code, 'skill_not_invoked');

  await freshRepoJob('job-wrong-project', 'wrong-project');
  const wrongProject = await service().run(APP, 'job-wrong-project', confirmYes);
  assert.equal(wrongProject.state, 'failed');
  assert.equal(wrongProject.error?.code, 'transcript_missing');
});

test('index changes are an explicit failure even when Claude also exited non-zero', async () => {
  await freshRepoJob('job-stage-exit1', 'stage-exit1');
  const result = await service().run(APP, 'job-stage-exit1', confirmYes);
  assert.equal(result.state, 'failed');
  assert.equal(result.error?.code, 'git_changed');
  assert.match(result.error?.message ?? '', /exited with code 1/);
});

test('preflight refuses a nested Claude session and a project skill that shadows /implement', async () => {
  await acceptedJob('job-nested');
  const nested = await service({ insideClaudeSession: true }).preflight(APP, 'job-nested');
  assert.equal(nested.ready, false);
  assert.ok(nested.checks.some((check) => check.code === 'inside_claude_session'));

  await mkdir(join(appRepo, '.claude', 'skills', 'implement'), { recursive: true });
  await writeFile(join(appRepo, '.claude', 'skills', 'implement', 'SKILL.md'), '---\nname: implement\n---\n');
  git(appRepo, 'add', '.claude');
  git(appRepo, 'commit', '-q', '-m', 'project skill');
  const shadowed = await service().preflight(APP, 'job-nested');
  assert.equal(shadowed.ready, false);
  assert.ok(shadowed.checks.some((check) => check.code === 'skill_shadowed'));
});

// ---- Review 02 ----

test('R1: inspection never runs repository-configured filters, textconv, external diff or fsmonitor', async () => {
  const marker = join(sandbox, `marker-${randomUUID()}`);
  // Records which git process ran it (its grandparent's command line), then passes the content through.
  const evil = `sh -c 'g=$(cut -d" " -f4 /proc/$PPID/stat); tr "\\0" " " < /proc/$g/cmdline >> ${marker}; echo >> ${marker}; cat'`;
  const arm = async (attributes: string) => {
    await writeFile(join(appRepo, '.git', 'info', 'attributes'), attributes);
    for (const [key, value] of [
      ['filter.evil.clean', evil],
      ['filter.evil.smudge', evil],
      ['filter.evil.process', evil],
      ['filter.evil.required', 'true'],
      ['diff.evil.textconv', evil],
      ['diff.external', evil],
      ['core.fsmonitor', evil],
    ]) {
      git(appRepo, 'config', key!, value!);
    }
    // A same-size change and a touched file make `git status` and `git diff` run the clean filter.
    await writeFile(join(appRepo, 'README.md'), '# Apq\n');
    await writeFile(join(appRepo, 'README.md'), '# App\n');
  };
  const ran = async () => readFile(marker, 'utf8').catch(() => '');

  // (a) Drivers configured, no conversion attribute: exported normally, nothing ran.
  await freshRepoJob('job-filters', 'ok');
  await arm('* diff=evil\n');
  const plain = await service().run(APP, 'job-filters', confirmYes);
  assert.equal(plain.state, 'completed', JSON.stringify(plain.error));
  assert.equal(await ran(), '', 'a repository-configured command ran during inspection');
  const diff = await readFile(join(jobDir('job-filters'), 'implementation.diff'), 'utf8');
  assert.match(diff, /\+готово/);
  assert.match(diff, /^diff --git a\/README\.md b\/README\.md$/m);

  // (b) A filter attribute on changed paths: nothing ran, and the raw content is not exported.
  git(appRepo, 'config', '--unset', 'core.fsmonitor');
  git(appRepo, 'checkout', '-q', '--', '.');
  git(appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
  await acceptedJob('job-filtered');
  await service().prepare(APP, 'job-filtered');
  await arm('* filter=evil diff=evil\n');
  const filtered = await service().run(APP, 'job-filtered', confirmYes);
  assert.equal(filtered.state, 'needs_inspection');
  assert.match(filtered.error?.message ?? '', /content conversions/);
  assert.equal(await ran(), '', 'a repository-configured command ran during inspection');
  assert.doesNotMatch(await exported('job-filtered'), /готово/);

  // Positive control: the trap is armed. Plain `git status` on the same repository runs it.
  await writeFile(join(appRepo, 'README.md'), (await readFile(join(appRepo, 'README.md'), 'utf8')).replace('#', '%'));
  git(appRepo, 'status', '--porcelain');
  assert.notEqual(await ran(), '', 'the configured commands should run for plain git status');
});

test('R1: a repository with content conversions on dirty paths is refused at prepare with its own code', async () => {
  await acceptedJob('job-crlf');
  await writeFile(join(appRepo, '.gitattributes'), '*.txt text eol=crlf\n');
  await writeFile(join(appRepo, 'notes.txt'), 'one\r\ntwo\r\n');
  await assert.rejects(service().prepare(APP, 'job-crlf'), rejectsWith('unsupported_conversions'));
  await rm(join(appRepo, '.gitattributes'));
  await rm(join(appRepo, 'notes.txt'));
});

test('R2: a withheld export carries no transcript commands, messages or path names', async () => {
  await freshRepoJob('job-sensitive', 'sensitive-text');
  const result = await service().run(APP, 'job-sensitive', confirmYes);
  assert.equal(result.state, 'needs_inspection');
  const out = await exported('job-sensitive');
  for (const text of ['PIN-4711-NOT-A-TOKEN', 'npm test', 'Done: README', 'fixture-only', '.env', 'src/feature.txt', 'README.md']) {
    assert.ok(!out.includes(text), `exported artifacts contain ${JSON.stringify(text)}`);
  }
  assert.match(out, /1 changed credential-style path\(s\)/);
  const record = await readJson(join(jobDir('job-sensitive'), 'execution.json'));
  assert.deepEqual((record.git_final as { changed_paths: string[] }).changed_paths, []);
});

test('R3: credential-style files inside ignored directories are checked, existing or new', async () => {
  await writeFile(join(appRepo, '.gitignore'), 'hidden/\n');
  git(appRepo, 'add', '.gitignore');
  git(appRepo, 'commit', '-q', '-m', 'ignore hidden/');
  await mkdir(join(appRepo, 'hidden', 'deep'), { recursive: true });
  await writeFile(join(appRepo, 'hidden', 'deep', '.env'), 'TOKEN=original-fixture\n');
  await acceptedJob('job-ignored-dir');
  await service().prepare(APP, 'job-ignored-dir');
  await setMode('ignored-nested');
  const changed = await service().run(APP, 'job-ignored-dir', confirmYes);
  assert.equal(changed.state, 'needs_inspection');
  assert.match(changed.error?.message ?? '', /credential-style entries: 0 appeared, 0 disappeared, 1 changed/);
  // The baseline that names and fingerprints credential files is private: not in execution.json,
  // but next to the app's .env, where factory_read_file refuses it.
  assert.doesNotMatch(await readFile(join(jobDir('job-ignored-dir'), 'execution.json'), 'utf8'), /hidden\/deep\/\.env/);
  const privatePath = `factory-data/apps/${APP}/.env.sf006-ignored-job-ignored-dir`;
  assert.match(await readFile(join(mediator, privatePath), 'utf8'), /hidden\/deep\/\.env/);
  await assert.rejects(new RepoFiles(mediator).read({ path: privatePath }), (e: unknown) => (e as { code: string }).code === 'forbidden_path');

  await rm(join(appRepo, 'hidden', 'deep', '.env'));
  git(appRepo, 'checkout', '-q', '--', '.');
  git(appRepo, 'clean', '-q', '-fd', '-e', '.software-factory');
  await acceptedJob('job-ignored-new');
  await service().prepare(APP, 'job-ignored-new');
  await setMode('ignored-nested-new');
  const created = await service().run(APP, 'job-ignored-new', confirmYes);
  assert.equal(created.state, 'needs_inspection');
  assert.doesNotMatch(await exported('job-ignored-new'), /changed-fixture|original-fixture/);
});

test('R4: file-count and aggregate diff limits stop the export during collection', async () => {
  await freshRepoJob('job-many', 'many-files');
  const many = await service().run(APP, 'job-many', confirmYes);
  assert.equal(many.state, 'needs_inspection');
  assert.match(many.error?.message ?? '', /More than 1000 changed files/);

  await freshRepoJob('job-big', 'big-diff');
  const big = await service().run(APP, 'job-big', confirmYes);
  assert.equal(big.state, 'needs_inspection');
  assert.match(big.error?.message ?? '', /larger than 2097152 bytes/);
  const diff = await readFile(join(jobDir('job-big'), 'implementation.diff'), 'utf8');
  assert.ok(diff.length < 1000, 'no partial diff is exported');
  assert.doesNotMatch(await readFile(join(jobDir('job-big'), 'new-files.md'), 'utf8'), /big\/b0\.txt/);
});

test('R5: when the result files cannot be written the job is never completed and says why', async () => {
  await freshRepoJob('job-unwritable', 'ok');
  // A directory where report.md should go makes that artifact unwritable.
  await mkdir(join(jobDir('job-unwritable'), 'report.md'));
  const result = await service().run(APP, 'job-unwritable', confirmYes);
  assert.equal(result.state, 'needs_inspection');
  assert.equal(result.error?.code, 'artifacts_failed');
  assert.match(result.error?.message ?? '', /would have been: completed/);
  const record = await readJson(join(jobDir('job-unwritable'), 'execution.json'));
  assert.equal(record.state, 'needs_inspection');
  // Result files written before the failure are removed; no partial set is left.
  for (const name of ['implementation.diff', 'new-files.md', 'checks.md']) {
    await assert.rejects(readFile(join(jobDir('job-unwritable'), name)), { code: 'ENOENT' }, name);
  }
  assert.deepEqual(record.artifacts, {});
  assert.ok(record.recovery);
  assert.equal((await invocations()).length, 1);
});

test('R3: nested .git directories are skipped; unreadable or oversized ignored trees withhold the export', async () => {
  await writeFile(join(appRepo, '.gitignore'), 'vendor/\nlocked/\nkeys/\n');
  git(appRepo, 'add', '.gitignore');
  git(appRepo, 'commit', '-q', '-m', 'ignore vendor, locked, keys');
  await mkdir(join(appRepo, 'vendor', 'pkg', '.git', 'objects'), { recursive: true });
  await writeFile(join(appRepo, 'vendor', 'pkg', '.git', 'config'), '[core]\n');
  await writeFile(join(appRepo, 'vendor', 'pkg', '.git', 'objects', 'pack.key'), 'object\n');
  await acceptedJob('job-vendor');
  await service().prepare(APP, 'job-vendor');
  await setMode('ok');
  assert.equal((await service().run(APP, 'job-vendor', confirmYes)).state, 'completed');
  assert.doesNotMatch(await readFile(join(mediator, 'factory-data', 'apps', APP, '.env.sf006-ignored-job-vendor'), 'utf8'), /\.git/);

  git(appRepo, 'checkout', '-q', '--', '.');
  git(appRepo, 'clean', '-q', '-fd', '-e', '.software-factory');
  await mkdir(join(appRepo, 'locked', 'inner'), { recursive: true });
  await chmod(join(appRepo, 'locked'), 0o000);
  try {
    await acceptedJob('job-locked');
    await service().prepare(APP, 'job-locked');
    const locked = await service().run(APP, 'job-locked', confirmYes);
    assert.equal(locked.state, 'needs_inspection');
    // Incomplete already when the session started (Review 04: the baseline's own completeness is checked first).
    assert.match(locked.error?.message ?? '', /records an incomplete check/);
  } finally {
    await chmod(join(appRepo, 'locked'), 0o755);
    await rm(join(appRepo, 'locked'), { recursive: true });
  }

  git(appRepo, 'checkout', '-q', '--', '.');
  git(appRepo, 'clean', '-q', '-fd', '-e', '.software-factory');
  await mkdir(join(appRepo, 'keys'), { recursive: true });
  for (let i = 0; i < 1001; i += 1) await writeFile(join(appRepo, 'keys', `k${i}.key`), 'k\n');
  await acceptedJob('job-many-keys');
  await service().prepare(APP, 'job-many-keys');
  const keys = await service().run(APP, 'job-many-keys', confirmYes);
  assert.equal(keys.state, 'needs_inspection');
  assert.match(keys.error?.message ?? '', /records an incomplete check/);
  await rm(join(appRepo, 'keys'), { recursive: true });
});

// ---- Review 03 ----

// An app repository whose ignored hidden/ holds hidden/deep/.env, prepared for one job, then run with a fake mode.
async function ignoredScenario(job: string, mode: string, setup: (deep: string) => Promise<void>, target?: string) {
  git(appRepo, 'checkout', '-q', '--', '.');
  git(appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
  await writeFile(join(appRepo, '.gitignore'), 'hidden/\n');
  git(appRepo, 'add', '.gitignore');
  git(appRepo, 'commit', '-q', '--allow-empty', '-m', `ignore hidden/ for ${job}`);
  const deep = join(appRepo, 'hidden', 'deep');
  await mkdir(deep, { recursive: true });
  await setup(deep);
  await acceptedJob(job);
  await service().prepare(APP, job);
  await setMode(mode, target);
  return service().run(APP, job, confirmYes);
}

async function assertWithheldWithoutNames(job: string, result: { state: string; error: { message: string } | null }, pattern: RegExp, extra: string[] = []) {
  assert.equal(result.state, 'needs_inspection', JSON.stringify(result.error));
  assert.match(result.error?.message ?? '', pattern);
  const out = await exported(job);
  for (const text of ['hidden', '.env', 'fixture-only', sandbox, ...extra]) {
    assert.ok(!out.includes(text), `exported artifacts contain ${JSON.stringify(text)}`);
  }
}

test('R3-F1: a deleted ignored credential file fails closed, also when its whole ignored directory is gone', async () => {
  const deleted = await ignoredScenario('job-del-file', 'delete-ignored', (deep) => writeFile(join(deep, '.env'), 'TOKEN=fixture-only\n'));
  await assertWithheldWithoutNames('job-del-file', deleted, /0 appeared, 1 disappeared, 0 changed/);

  const gone = await ignoredScenario('job-del-dir', 'delete-ignored-dir', (deep) => writeFile(join(deep, '.env'), 'TOKEN=fixture-only\n'));
  await assertWithheldWithoutNames('job-del-dir', gone, /0 appeared, 1 disappeared, 0 changed/);
});

test('R3-F2: credential-named symlinks are recorded by their own target, never followed, and every change fails closed', async () => {
  const outside = join(sandbox, `outside-${randomUUID().slice(0, 8)}`);
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, '.env'), 'TOKEN=outside-fixture\n');
  const target = join(outside, '.env');

  const created = await ignoredScenario('job-link-new', 'symlink-new', async () => undefined, target);
  await assertWithheldWithoutNames('job-link-new', created, /1 appeared, 0 disappeared, 0 changed/, [outside]);

  const replaced = await ignoredScenario('job-link-replace', 'symlink-replace', (deep) => writeFile(join(deep, '.env'), 'TOKEN=fixture-only\n'), target);
  await assertWithheldWithoutNames('job-link-replace', replaced, /0 appeared, 0 disappeared, 1 changed/, [outside]);

  const removed = await ignoredScenario('job-link-remove', 'symlink-remove', (deep) => symlink(target, join(deep, '.env')));
  await assertWithheldWithoutNames('job-link-remove', removed, /0 appeared, 1 disappeared, 0 changed/, [outside]);

  const altered = await ignoredScenario('job-link-alter', 'symlink-alter', (deep) => symlink(target, join(deep, '.env')), target);
  await assertWithheldWithoutNames('job-link-alter', altered, /0 appeared, 0 disappeared, 1 changed/, [outside]);

  // A stable credential symlink is no change.
  const stable = await ignoredScenario('job-link-stable', 'ok', (deep) => symlink(target, join(deep, '.env')));
  assert.equal(stable.state, 'completed', JSON.stringify(stable.error));
  // The private baseline holds a fingerprint of the target bytes, not the target or its content.
  const baseline = await readFile(join(mediator, 'factory-data', 'apps', APP, '.env.sf006-ignored-job-link-stable'), 'utf8');
  assert.match(baseline, /"hidden\/deep\/\.env":"symlink:[0-9a-f]{64}"/);
  assert.ok(!baseline.includes(outside) && !baseline.includes('outside-fixture'));

  // A symlink to a directory outside the repository is not walked into: a change there is not seen and does not block.
  const notFollowed = await ignoredScenario('job-link-dir', 'outside-change', (deep) => symlink(outside, join(deep, 'linked-dir')), outside);
  assert.equal(notFollowed.state, 'completed', JSON.stringify(notFollowed.error));
  assert.doesNotMatch(await readFile(join(mediator, 'factory-data', 'apps', APP, '.env.sf006-ignored-job-link-dir'), 'utf8'), /linked-dir\//);
});

test('R3-F3: records without a private baseline, including pre-Review 02 records, never pass the ignored-file check', async () => {
  // A current record whose private baseline was removed; another whose baseline is a symlink.
  await freshRepoJob('job-no-baseline', 'ok');
  const manual = await service().handoff(APP, 'job-no-baseline');
  await rm(join(mediator, 'factory-data', 'apps', APP, '.env.sf006-ignored-job-no-baseline'));
  execFileSync(join(fakeDir, 'claude'), manual.command.slice(1), { cwd: appRepo, stdio: 'ignore' });
  const missing = await service().collect(APP, 'job-no-baseline', { sessionFinished: true });
  assert.equal(missing.state, 'needs_inspection');
  assert.match(missing.error?.message ?? '', /ignored-file baseline of the session is missing/);

  await freshRepoJob('job-linked-baseline', 'ok');
  const linkedManual = await service().handoff(APP, 'job-linked-baseline');
  const baselinePath = join(mediator, 'factory-data', 'apps', APP, '.env.sf006-ignored-job-linked-baseline');
  await rm(baselinePath);
  await writeFile(join(sandbox, 'planted-baseline.json'), JSON.stringify({ entries: [], credentials: {}, complete: true }));
  await symlink(join(sandbox, 'planted-baseline.json'), baselinePath);
  execFileSync(join(fakeDir, 'claude'), linkedManual.command.slice(1), { cwd: appRepo, stdio: 'ignore' });
  const linked = await service().collect(APP, 'job-linked-baseline', { sessionFinished: true });
  assert.equal(linked.state, 'needs_inspection');
  assert.match(linked.error?.message ?? '', /not readable as a baseline/);

  // A pre-Review 02 record: the baseline sits in execution.json (ignored_initial), claims to be complete,
  // and there is no private file. It must not be used.
  await freshRepoJob('job-legacy', 'ok');
  const legacyManual = await service().handoff(APP, 'job-legacy');
  await rm(join(mediator, 'factory-data', 'apps', APP, '.env.sf006-ignored-job-legacy'));
  const path = join(jobDir('job-legacy'), 'execution.json');
  const record = await readJson(path);
  const { ignored_summary: _summary, ...legacy } = record;
  await writeFile(path, JSON.stringify({ ...legacy, ignored_initial: { entries: ['legacy-dir/'], credentials: { 'legacy-dir/.env': 'f'.repeat(64) }, complete: true } }));
  execFileSync(join(fakeDir, 'claude'), legacyManual.command.slice(1), { cwd: appRepo, stdio: 'ignore' });
  const legacyResult = await service().collect(APP, 'job-legacy', { sessionFinished: true });
  assert.equal(legacyResult.state, 'needs_inspection');
  assert.match(legacyResult.error?.message ?? '', /predates the private ignored-file baseline/);
  // Nothing new names the legacy entries; the historical field itself is left as it was.
  const after = await readJson(path);
  assert.deepEqual(after.ignored_initial, { entries: ['legacy-dir/'], credentials: { 'legacy-dir/.env': 'f'.repeat(64) }, complete: true });
  for (const name of ['report.md', 'implementation.diff', 'new-files.md', 'checks.md']) {
    assert.doesNotMatch(await readFile(join(jobDir('job-legacy'), name), 'utf8'), /legacy-dir/, name);
  }

  // The read-only audit reports that record by counts, without names, and changes nothing.
  const before = await readFile(path, 'utf8');
  const audit = (await auditLegacyRecords(mediator)).entries;
  const entry = audit.find((candidate) => candidate.job_id === 'job-legacy');
  assert.deepEqual(entry, {
    app_id: APP,
    job_id: 'job-legacy',
    record: 'ok',
    coverage: 'verified',
    issue: null,
    state: 'needs_inspection',
    ignored_initial: { entries: 1, credentials: 1 },
    private_baseline: 'missing',
    exposes_names: true,
  });
  assert.ok(!JSON.stringify(audit).includes('legacy-dir'));
  assert.equal(audit.find((candidate) => candidate.job_id === 'job-no-baseline')?.exposes_names, false);
  assert.equal(audit.find((candidate) => candidate.job_id === 'job-linked-baseline')?.private_baseline, 'invalid');
  // A record of the earliest format is reported as such, not as ok.
  const early = join(jobDir('job-no-baseline'), 'execution.json');
  const earlyRecord = await readJson(early);
  const { checks: _c, completion: _p, ignored_initial: _i, ...earliest } = earlyRecord;
  await writeFile(early, JSON.stringify(earliest));
  assert.equal((await auditLegacyRecords(mediator)).entries.find((candidate) => candidate.job_id === 'job-no-baseline')?.record, 'legacy-format');
  assert.equal(await readFile(path, 'utf8'), before);
});

// ---- Review 04 ----

test('R4-1: a private baseline must carry complete: true to support an export', async () => {
  const cases: Array<[string, (baseline: Record<string, unknown>) => unknown, string, RegExp | null]> = [
    ['missing', ({ complete: _c, ...rest }) => rest, 'needs_inspection', /not readable as a baseline/],
    ['false', (baseline) => ({ ...baseline, complete: false }), 'needs_inspection', /records an incomplete check/],
    ['string', (baseline) => ({ ...baseline, complete: 'yes' }), 'needs_inspection', /not readable as a baseline/],
    ['number', (baseline) => ({ ...baseline, complete: 1 }), 'needs_inspection', /not readable as a baseline/],
    ['proto-credentials', (baseline) => JSON.parse(`${JSON.stringify(baseline).slice(0, -1)},"credentials":{"__proto__":"x"}}`.replace('"credentials":{},', '')), 'needs_inspection', /not readable as a baseline/],
    ['true', (baseline) => ({ ...baseline, complete: true }), 'completed', null],
  ];
  for (const [label, mutate, state, reason] of cases) {
    const job = `job-complete-${label}`;
    await freshRepoJob(job, 'ok');
    const manual = await service().handoff(APP, job);
    const file = join(mediator, 'factory-data', 'apps', APP, `.env.sf006-ignored-${job}`);
    const baseline = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal(baseline.complete, true, `${label}: the adapter writes complete: true for a finished scan`);
    await writeFile(file, JSON.stringify(mutate(baseline)), { mode: 0o600 });
    execFileSync(join(fakeDir, 'claude'), manual.command.slice(1), { cwd: appRepo, stdio: 'ignore' });
    const result = await service().collect(APP, job, { sessionFinished: true });
    assert.equal(result.state, state, `${label}: ${JSON.stringify(result.error)}`);
    if (reason !== null) assert.match(result.error?.message ?? '', reason, label);
  }
});

test('R4-2: the legacy audit treats every malformed ignored_initial as exposing names, prints no values and changes nothing', async () => {
  // Records built from a current one, differing only in ignored_initial.
  await freshRepoJob('job-audit-base', 'ok');
  await service().prepare(APP, 'job-audit-base');
  const base = await readJson(join(jobDir('job-audit-base'), 'execution.json'));
  const variants: Array<[string, unknown, LegacyAuditEntry['ignored_initial']]> = [
    ['extra-key', { entries: [], credentials: {}, note: 'SECRET-prod-db/.env' }, 'malformed'],
    ['entry-type', { entries: [4711, 'SECRET-entry/'], credentials: {} }, 'malformed'],
    ['fingerprint-type', { entries: [], credentials: { 'SECRET-cred/.env': 9876 } }, 'malformed'],
    ['array-map', { entries: [], credentials: ['SECRET-array/.env'] }, 'malformed'],
    ['complete-type', { entries: [], credentials: {}, complete: 'yes' }, 'malformed'],
    // zod drops a "__proto__" key silently; the audit must still see it.
    ['proto-key', JSON.parse('{"entries":[],"credentials":{"__proto__":{"SECRET-proto/.env":"x"}}}'), 'malformed'],
    ['proto-top', JSON.parse('{"entries":[],"credentials":{},"__proto__":{"SECRET-top":"x"}}'), 'malformed'],
    ['valid-empty', { entries: [], credentials: {} }, { entries: 0, credentials: 0 }],
  ];
  const before = new Map<string, string>();
  for (const [label, legacy] of variants) {
    const dir = jobDir(`job-audit-${label}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const text = JSON.stringify({ ...base, job_id: `job-audit-${label}`, ignored_initial: legacy, ...(label === 'extra-key' ? { state: 'SECRET-state/.env' } : {}) });
    await writeFile(join(dir, 'execution.json'), text, { mode: 0o600 });
    before.set(label, text);
  }
  const audit = (await auditLegacyRecords(mediator)).entries;
  for (const [label, , expected] of variants) {
    const entry = audit.find((candidate) => candidate.job_id === `job-audit-${label}`);
    assert.deepEqual(entry?.ignored_initial, expected, label);
    assert.equal(entry?.exposes_names, expected === 'malformed', label);
    assert.equal(await readFile(join(jobDir(`job-audit-${label}`), 'execution.json'), 'utf8'), before.get(label), `${label} unchanged`);
  }
  const printed = formatLegacyAudit({ data: 'present', entries: audit, gaps: [], unprepared: [] });
  assert.equal(printed.exitCode, 1);
  const text = printed.lines.join('\n');
  for (const secret of ['SECRET', '4711', '9876', sandbox]) {
    assert.ok(!text.includes(secret), `audit output contains ${JSON.stringify(secret)}`);
  }
  // Review 05: the free-text state also makes that record unverified (unknown_shape).
  assert.match(text, /job-audit-extra-key: record \S+, UNVERIFIED \(unknown_shape\), state -, ignored_initial malformed, .*EXPOSES NAMES/);
  // Positive control: the valid empty legacy field alone exposes nothing, so the exit code is 0.
  const control = formatLegacyAudit({ data: 'present', entries: audit.filter((candidate) => candidate.job_id === 'job-audit-valid-empty'), gaps: [], unprepared: [] });
  assert.equal(control.exitCode, 0);
  assert.match(control.lines[0]!, /ignored_initial present \(entries 0, credential files 0\)/);
});
