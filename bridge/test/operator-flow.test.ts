// SF-007 operator flow: discovery, the console's Reject / Later / Approve & Run
// on a real pseudo-terminal with scripted operator keystrokes, binding to the
// exact accepted job, at-most-once approval use, restarts and crashes, and the
// SF-006 outcomes. The host-wide session gate is covered by operator-gate.test.ts.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { approve } from '../src/operator/approval.js';
import { inspectJob, scanQueue, type QueueDeps } from '../src/operator/queue.js';
import { launchRecord, OperatorStore } from '../src/operator/store.js';
import {
  acceptedJob,
  createFixture,
  destroyFixture,
  fixtureService,
  git,
  invocations,
  jobDir,
  setMode,
  sha256,
  writeReceiver,
  type Fixture,
} from './support/operator-fixture.js';
import { liveProcesses, runInPty, type Answer } from './support/pty.js';

const ATTEND = fileURLToPath(new URL('./support/attend-fixture.js', import.meta.url));
const CONSOLE = fileURLToPath(new URL('./support/console-fixture.js', import.meta.url));
let fx: Fixture;
let store: OperatorStore;
let fixtureJson: string;

before(async () => {
  fx = await createFixture();
  store = await OperatorStore.open(fx.stateHome, fx.mediator);
  fixtureJson = join(fx.sandbox, 'fixture.json');
  await writeFile(fixtureJson, JSON.stringify(fx));
});

after(async () => {
  await destroyFixture(fx);
});

beforeEach(async () => {
  git(fx.appRepo, 'reset', '-q', '--hard');
  git(fx.appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
  await setMode(fx, 'ok');
});

const deps = (overrides: Partial<QueueDeps> = {}): QueueDeps => ({ mediatorRoot: fx.mediator, store, service: fixtureService(fx), now: () => new Date(), ...overrides });
const env = { ...process.env, SF_GATEWAY_TOKEN: 'must-not-reach-claude' };
const console_ = (answers: Answer[]) => runInPty(fx.sandbox, [process.execPath, CONSOLE, fixtureJson], answers, { env }).done;
const attendPty = (job: string, answers: Answer[] = [['Press Enter to close', '\r']]) =>
  runInPty(fx.sandbox, [process.execPath, ATTEND, fixtureJson, fx.app, job], answers, { env }).done;
// Select a job in the console by its id.
const select = (job: string): Answer => ['to review, r to refresh, q to quit:', `${fx.app}/${job}\r`];
const quit: Answer = ['to review, r to refresh, q to quit:', 'q\r'];
const FINISH_YES: Answer[] = [['Did /implement finish', 'y\r']];

const shown = async (job: string) => {
  const entry = await inspectJob(deps(), fx.app, job);
  return { request_id: entry!.request_id!, instruction_sha256: entry!.instruction_sha256! };
};
const claudeCalls = async (job: string) => (await invocations(fx)).filter((call) => call.argv.at(-1)!.includes(`/${job}/`));

async function untouched(job: string): Promise<void> {
  await assert.rejects(readFile(join(jobDir(fx, job), 'execution.json')), { code: 'ENOENT' }, `${job}: execution.json`);
  await assert.rejects(readFile(join(jobDir(fx, job), 'launch.claim')), { code: 'ENOENT' }, `${job}: launch.claim`);
  await assert.rejects(lstat(join(fx.appRepo, '.software-factory', 'jobs', job)), { code: 'ENOENT' }, `${job}: app-side copy`);
  assert.equal((await claudeCalls(job)).length, 0, `${job}: Claude started`);
}

async function tree(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(path: string): Promise<void> {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) result.set(path, `link:${await readlink(path)}`);
    else if (stats.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name));
    else result.set(path, sha256(await readFile(path)));
  }
  await walk(root);
  return result;
}

test('1: discovered jobs are only listed: no prepare, no claim, no app-side change, no Claude', async () => {
  await acceptedJob(fx, 'job-listed-a');
  await acceptedJob(fx, 'job-listed-b');
  const before = await tree(fx.mediator);
  const head = git(fx.appRepo, 'rev-parse', 'HEAD');
  const { entries } = await scanQueue(deps());
  for (const job of ['job-listed-a', 'job-listed-b']) {
    const entry = entries.find((candidate) => candidate.job_id === job);
    assert.equal(entry?.status, 'awaiting_operator', job);
    assert.deepEqual(entry?.actions, ['approve', 'reject', 'later']);
    await untouched(job);
  }
  // Listing and reviewing in the console, then quitting, changes nothing either.
  const { output } = await console_([select('job-listed-a'), ['anything else = back', '\r'], quit]);
  assert.match(output, /awaiting your decision/);
  assert.deepEqual(await tree(fx.mediator), before);
  assert.equal(git(fx.appRepo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(fx.appRepo, 'status', '--porcelain'), '');
});

test('1: malformed jobs are diagnosed without details and do not hide valid ones', async () => {
  await acceptedJob(fx, 'job-valid');
  await acceptedJob(fx, 'job-broken');
  await writeFile(join(jobDir(fx, 'job-broken'), 'dispatch.json'), '{"schema":"software-factory.dispatch/v1","note":"SECRET-broken"}');
  await acceptedJob(fx, 'job-swapped');
  await writeFile(join(jobDir(fx, 'job-swapped'), 'instruction.md'), 'something else\n');
  const { entries } = await scanQueue(deps());
  assert.equal(entries.find((entry) => entry.job_id === 'job-valid')?.status, 'awaiting_operator');
  const broken = entries.find((entry) => entry.job_id === 'job-broken');
  assert.deepEqual([broken?.status, broken?.problem?.code, broken?.actions], ['invalid', 'invalid_record', []]);
  // Not proven: never labelled "accepted".
  const swapped = entries.find((entry) => entry.job_id === 'job-swapped');
  assert.deepEqual([swapped?.status, swapped?.problem?.code, swapped?.actions], ['invalid', 'instruction_mismatch', []]);
  // An app without .env: accepted by OpenClaw, but not executable here.
  await mkdir(join(fx.mediator, 'factory-data', 'apps', 'app-unconfigured'));
  await acceptedJob(fx, 'job-elsewhere', undefined, 'app-unconfigured');
  const elsewhere = await inspectJob(deps(), 'app-unconfigured', 'job-elsewhere');
  assert.deepEqual([elsewhere?.status, elsewhere?.problem?.code, elsewhere?.actions], ['accepted', 'app_not_configured', []]);
  assert.ok(!JSON.stringify(entries).includes('SECRET'));
});

test('2: Reject and Later in the console never launch; a rejected job cannot be approved', async () => {
  await acceptedJob(fx, 'job-rejected');
  await acceptedJob(fx, 'job-later');
  await acceptedJob(fx, 'job-not-rejected');
  const { output } = await console_([
    select('job-later'),
    ['anything else = back', 'l\r'],
    select('job-not-rejected'),
    ['anything else = back', 'x\r'],
    ['Type "reject" to confirm', 'no\r'],
    select('job-rejected'),
    ['anything else = back', 'x\r'],
    ['Type "reject" to confirm', 'reject\r'],
    quit,
  ]);
  assert.match(output, /stays in the queue for later/);
  assert.match(output, /Not rejected/);
  assert.match(output, /Rejected app-one\/job-rejected/);
  assert.equal((await inspectJob(deps(), fx.app, 'job-rejected'))?.status, 'rejected');
  assert.equal((await inspectJob(deps(), fx.app, 'job-not-rejected'))?.status, 'awaiting_operator');
  const deferred = await inspectJob(deps(), fx.app, 'job-later');
  assert.equal(deferred?.status, 'awaiting_operator');
  assert.ok(deferred?.deferred_at);
  await assert.rejects(approve(deps(), fx.app, 'job-rejected', await shown('job-rejected')), { code: 'wrong_status' });
  for (const job of ['job-rejected', 'job-later', 'job-not-rejected']) await untouched(job);
});

test('2, 6, 7: one Approve & Run in the console takes the job through the whole SF-006 chain on this terminal', async () => {
  const { requestId, sha } = await acceptedJob(fx, 'job-one-click');
  const { output } = await console_([select('job-one-click'), ['anything else = back', 'a\r'], ...FINISH_YES, ['Press Enter to return to the queue', '\r'], quit]);
  // What the operator saw and answered.
  assert.match(output, /--- instruction \(exact text as accepted/);
  assert.match(output, /a = Approve & Run, l = Later, x = Reject \(final\)/);
  assert.match(output, new RegExp(`request ${requestId}`));
  assert.match(output, /\[PASS\] Claude session gate/);
  assert.match(output, /Starting Claude Code \(manual permission mode\)/);
  assert.match(output, /FAKE-CLAUDE-STDOUT-MARKER/);
  assert.match(output, /FAKE-CLAUDE-STDERR-MARKER/);
  assert.match(output, /app-one\/job-one-click: completed/);

  // Claude: one session, a real TTY on all three streams, manual permissions, clean environment.
  const [claude, ...more] = await claudeCalls('job-one-click');
  assert.equal(more.length, 0);
  assert.deepEqual(claude!.tty, { stdin: true, stdout: true, stderr: true });
  const record = JSON.parse(await readFile(join(jobDir(fx, 'job-one-click'), 'execution.json'), 'utf8'));
  assert.deepEqual(claude!.argv, ['--permission-mode', 'manual', '--session-id', record.session.id, '--name', record.session.name, '/implement .software-factory/jobs/job-one-click/instruction.md']);
  assert.deepEqual(claude!.env, []);
  assert.equal(claude!.cwd, fx.appRepo);
  assert.equal(record.request_id, requestId);
  assert.equal(record.instruction_sha256, sha);

  // The queue shows exactly what execution.json says; the artifacts match and hold no child output or private paths.
  assert.equal(record.state, 'completed');
  const entry = await inspectJob(deps(), fx.app, 'job-one-click');
  assert.equal(entry?.status, 'completed');
  assert.deepEqual(entry?.execution?.artifacts, record.artifacts);
  for (const [name, digest] of Object.entries(record.artifacts as Record<string, string>)) {
    const bytes = await readFile(join(jobDir(fx, 'job-one-click'), name));
    assert.equal(sha256(bytes), digest, name);
    for (const forbidden of ['FAKE-CLAUDE-STDOUT-MARKER', 'FAKE-CLAUDE-STDERR-MARKER', fx.appRepo, fx.stateHome]) {
      assert.ok(!bytes.toString('utf8').includes(forbidden), `${name} contains ${forbidden}`);
    }
  }
  const stateFiles = await readdir(join(fx.stateDir, 'jobs', fx.app, 'job-one-click'));
  assert.ok(stateFiles.some((name) => /^approval-.*\.consumed\.json$/.test(name)));
  assert.ok(!stateFiles.includes('approval.json'));
  const events = await readFile(join(fx.stateDir, 'events.jsonl'), 'utf8');
  for (const event of ['approved', 'consumed', 'finished']) assert.match(events, new RegExp(`"event":"${event}","app_id":"app-one","job_id":"job-one-click"`));
  assert.ok(!events.includes(fx.appRepo) && !events.includes('MARKER'));
  // A completed job offers no decision.
  await assert.rejects(approve(deps(), fx.app, 'job-one-click', await shown('job-one-click')), { code: 'wrong_status' });
});

test('3: an approval is bound to the exact job; any swap fails closed before an app-side write', async () => {
  const swaps: Array<[string, (job: string) => Promise<void>, RegExp]> = [
    ['instruction', async (job) => writeFile(join(jobDir(fx, job), 'instruction.md'), 'swapped instruction\n'), /instruction_mismatch|not ready/i],
    ['receipt', async (job) => rm(join(jobDir(fx, job), 'openclaw-receipt.json')), /invalid_record|not ready/i],
    ['receiver record', async (job) => {
      const dispatch = JSON.parse(await readFile(join(jobDir(fx, job), 'dispatch.json'), 'utf8'));
      await writeReceiver(fx, { request_id: dispatch.request_id, app_id: fx.app, job_id: 'other-job', instruction_sha256: dispatch.instruction_sha256, accepted_at: new Date().toISOString() });
    }, /openclaw_unconfirmed|not ready/i],
    // A fully consistent re-acceptance with another request id and instruction: only the binding catches it.
    ['whole acceptance', async (job) => {
      await acceptedJob(fx, job, '# Another task\n');
    }, /approval_mismatch/],
    ['private .env', async () => {
      await writeFile(join(fx.mediator, 'factory-data', 'apps', fx.app, '.env'), `APP_REPO=${join(fx.sandbox, 'missing-repo')}\n`, { mode: 0o600 });
    }, /invalid_repo|not ready/i],
    ['approval data', async (job) => {
      const path = join(fx.stateDir, 'jobs', fx.app, job, 'approval.json');
      const approval = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...approval, request_id: 'forged' }), { mode: 0o600 });
    }, /approval_mismatch/],
    ['approval symlink', async (job) => {
      const path = join(fx.stateDir, 'jobs', fx.app, job, 'approval.json');
      await writeFile(join(fx.sandbox, 'forged-approval.json'), await readFile(path));
      await rm(path);
      await symlink(join(fx.sandbox, 'forged-approval.json'), path);
    }, /invalid_record/],
  ];
  for (const [label, swap, expected] of swaps) {
    const job = `job-swap-${label.replace(/[^a-z]+/g, '-')}`;
    await acceptedJob(fx, job);
    await approve(deps(), fx.app, job, await shown(job));
    await swap(job);
    const { output } = await attendPty(job);
    await writeFile(join(fx.mediator, 'factory-data', 'apps', fx.app, '.env'), `APP_REPO=${fx.appRepo}\n`, { mode: 0o600 });
    assert.match(output, expected, `${label}: ${output}`);
    assert.doesNotMatch(output, /Starting Claude Code/, label);
    await assert.rejects(readFile(join(jobDir(fx, job), 'launch.claim')), { code: 'ENOENT' }, label);
    await assert.rejects(lstat(join(fx.appRepo, '.software-factory', 'jobs', job)), { code: 'ENOENT' }, label);
    assert.equal((await claudeCalls(job)).length, 0, `${label}: Claude was started`);
    assert.ok(!output.includes(fx.appRepo), `${label}: host path shown`);
    if (label === 'approval symlink') {
      // A forged (unreadable) approval blocks every other approval until removed by hand.
      await acceptedJob(fx, 'job-after-forged');
      await assert.rejects(approve(deps(), fx.app, 'job-after-forged', await shown('job-after-forged')), { code: 'busy' });
      await rm(join(fx.stateDir, 'jobs', fx.app, job, 'approval.json'));
    }
  }
});

test('5: duplicate decisions and competing attend processes use an approval at most once; stale ones never', async () => {
  await acceptedJob(fx, 'job-race');
  const view = await shown('job-race');
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => approve(deps(), fx.app, 'job-race', view)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of results.filter((candidate) => candidate.status === 'rejected')) {
    assert.ok(['conflict', 'busy', 'wrong_status'].includes((result as PromiseRejectedResult).reason.code), String((result as PromiseRejectedResult).reason));
  }
  // Whichever attend wins is asked the end-of-session question; the others only see the refusal.
  const outputs = await Promise.all([1, 2, 3].map(() => attendPty('job-race', [['Did /implement finish', 'y\r', true], ['Press Enter to close', '\r']])));
  assert.equal((await claudeCalls('job-race')).length, 1);
  // The others lost the atomic consumption (before or after reading the pending approval).
  assert.equal(outputs.filter(({ output }) => /no pending approval|cancelled or used meanwhile/.test(output)).length, 2, outputs.map(({ output }) => output).join('\n----\n'));
  assert.equal(JSON.parse(await readFile(join(jobDir(fx, 'job-race'), 'execution.json'), 'utf8')).state, 'completed');

  // An approval older than 15 minutes is not used.
  git(fx.appRepo, 'reset', '-q', '--hard');
  git(fx.appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
  await acceptedJob(fx, 'job-stale');
  const old = new Date(Date.now() - 16 * 60 * 1000);
  await approve(deps({ now: () => old }), fx.app, 'job-stale', await shown('job-stale'));
  assert.equal((await inspectJob(deps(), fx.app, 'job-stale'))?.approval?.expired, true);
  assert.match((await attendPty('job-stale')).output, /approval has expired/);
  await untouched('job-stale');
  const entry = await inspectJob(deps(), fx.app, 'job-stale');
  assert.deepEqual([entry?.status, entry?.last_launch?.code], ['awaiting_operator', 'expired']);
});

test('5, 7: an abandoned launch is shown; an unreadable approval blocks approvals', async () => {
  await acceptedJob(fx, 'job-abandoned');
  const approval = await approve(deps(), fx.app, 'job-abandoned', await shown('job-abandoned'));
  await store.settleApproval(fx.app, 'job-abandoned', approval.id, 'consumed', launchRecord('started', new Date(), { attend: { pid: 2 ** 22 + 7, pid_start: '1', boot_id: 'gone' } }));
  const abandoned = await inspectJob(deps(), fx.app, 'job-abandoned');
  assert.deepEqual([abandoned?.status, abandoned?.last_launch?.outcome], ['awaiting_operator', 'abandoned']);
  await untouched('job-abandoned');

  await acceptedJob(fx, 'job-blocked');
  const brokenDir = join(fx.stateDir, 'jobs', fx.app, 'job-broken-approval');
  await mkdir(brokenDir, { recursive: true, mode: 0o700 });
  await writeFile(join(brokenDir, 'approval.json'), '{"not":"an approval"}', { mode: 0o600 });
  await assert.rejects(approve(deps(), fx.app, 'job-blocked', await shown('job-blocked')), { code: 'busy' });
  await rm(brokenDir, { recursive: true });
  await untouched('job-blocked');
});

test('5: a restart re-approves and relaunches nothing; a crashed session is never relaunched', async () => {
  await acceptedJob(fx, 'job-crash');
  await setMode(fx, 'hang');
  const run = runInPty(fx.sandbox, [process.execPath, CONSOLE, fixtureJson], [select('job-crash'), ['anything else = back', 'a\r']], { env, timeout: 60 });
  let claude;
  for (let attempt = 0; attempt < 400 && claude === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    claude = (await claudeCalls('job-crash'))[0];
  }
  assert.ok(claude, 'the session started');
  // The whole console dies, then the Claude process (a crash or a closed window).
  process.kill(await run.pid(), 'SIGKILL');
  process.kill(claude.pid, 'SIGKILL');
  await run.done;
  assert.deepEqual(await liveProcesses(join(fx.fakeDir, 'claude')), []);

  // "Restart": a fresh store. Nothing is launched or re-approved by itself.
  const restarted = { ...deps(), store: await OperatorStore.open(fx.stateHome, fx.mediator) };
  const entry = await inspectJob(restarted, fx.app, 'job-crash');
  assert.equal(entry?.status, 'running');
  assert.equal(entry?.execution?.process_alive, false);
  assert.deepEqual(entry?.actions, []);
  assert.equal(entry?.next, `scripts/sf006-execute.sh collect ${fx.app} job-crash`);
  await assert.rejects(approve(restarted, fx.app, 'job-crash', await shown('job-crash')), { code: 'wrong_status' });
  assert.equal((await claudeCalls('job-crash')).length, 1);
  // SF-006 collect (the documented recovery) ends it as interrupted, never completed.
  assert.equal((await fixtureService(fx).collect(fx.app, 'job-crash', { sessionFinished: false })).state, 'interrupted');
  await assert.rejects(fixtureService(fx).run(fx.app, 'job-crash', async () => true), { code: 'wrong_state' });
});

test('6: without a TTY the console and attend refuse; nothing runs headless', async () => {
  await acceptedJob(fx, 'job-no-tty');
  const run = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = execFile(process.execPath, args, { env }, (_error, stdout) => resolve({ code: child.exitCode, stdout }));
    });
  const consoleRun = await run([CONSOLE, fixtureJson]);
  assert.equal(consoleRun.code, 1);
  assert.match(consoleRun.stdout, /needs an interactive terminal/);
  await approve(deps(), fx.app, 'job-no-tty', await shown('job-no-tty'));
  const attendRun = await run([ATTEND, fixtureJson, fx.app, 'job-no-tty']);
  assert.equal(attendRun.code, 1);
  assert.match(attendRun.stdout, /refusing to run Claude Code headless/);
  assert.equal((await inspectJob(deps(), fx.app, 'job-no-tty'))?.last_launch?.code, 'no_tty');
  await untouched('job-no-tty');
});

test('8: No, signals, a missing transcript, Git changes and unsafe exports never become completed', async () => {
  const cases: Array<[string, string, Answer[], string, string]> = [
    ['answer-no', 'ok', [['Did /implement finish', 'n\r']], 'interrupted', 'not_confirmed'],
    ['sigterm', 'term', [], 'interrupted', 'claude_signal'],
    ['sigkill', 'crash', [], 'interrupted', 'claude_signal'],
    ['no-transcript', 'no-transcript', FINISH_YES, 'failed', 'transcript_missing'],
    ['commit', 'commit', FINISH_YES, 'failed', 'git_changed'],
    ['stage', 'stage', FINISH_YES, 'failed', 'git_changed'],
    ['secret', 'secret-file', FINISH_YES, 'needs_inspection', 'export_withheld'],
  ];
  for (const [label, mode, answers, state, code] of cases) {
    git(fx.appRepo, 'reset', '-q', '--hard');
    git(fx.appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
    const job = `job-end-${label}`;
    await acceptedJob(fx, job);
    await setMode(fx, mode);
    await approve(deps(), fx.app, job, await shown(job));
    const { output } = await attendPty(job, [...answers, ['Press Enter to close', '\r']]);
    const record = JSON.parse(await readFile(join(jobDir(fx, job), 'execution.json'), 'utf8'));
    assert.equal(record.state, state, `${label}: ${output}`);
    assert.equal(record.error?.code, code, label);
    const entry = await inspectJob(deps(), fx.app, job);
    assert.equal(entry?.status, state, label);
    assert.equal(entry?.last_launch?.final_state, state, label);
  }
});
