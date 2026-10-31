// SF-007 Review 01, Finding 2: one host-wide Claude session gate shared by the
// manual SF-006 CLI path (ExecutionService.run) and SF-007 (console/attend).
// Every assertion counts the Claude processes actually alive, not approvals or
// statuses. A busy gate never claims a job: it stays prepared or untouched.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SessionGate } from '../src/execution/session-gate.js';
import { approve } from '../src/operator/approval.js';
import { inspectJob, type QueueDeps } from '../src/operator/queue.js';
import { OperatorStore } from '../src/operator/store.js';
import { acceptedJob, createFixture, destroyFixture, fixtureService, gatePath, git, invocations, jobDir, setMode, type Fixture } from './support/operator-fixture.js';
import { liveProcesses, runInPty } from './support/pty.js';

const ATTEND = fileURLToPath(new URL('./support/attend-fixture.js', import.meta.url));
const RUN = fileURLToPath(new URL('./support/run-fixture.js', import.meta.url));
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
  await setMode(fx, 'hang');
});

// No test leaves a session behind for the next one.
afterEach(async () => {
  for (const pid of await live()) process.kill(pid, 'SIGKILL');
  for (let attempt = 0; attempt < 100 && ((await new SessionGate(gatePath(fx)).holders()).length > 0); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

const deps = (): QueueDeps => ({ mediatorRoot: fx.mediator, store, service: fixtureService(fx), now: () => new Date() });
const live = () => liveProcesses(join(fx.fakeDir, 'claude'));
const shown = async (job: string) => {
  const entry = await inspectJob(deps(), fx.app, job);
  return { request_id: entry!.request_id!, instruction_sha256: entry!.instruction_sha256! };
};
const claimed = async (job: string, app = fx.app) =>
  readFile(join(jobDir(fx, job, app), 'launch.claim')).then(
    () => true,
    () => false,
  );
const state = async (job: string, app = fx.app) => JSON.parse(await readFile(join(jobDir(fx, job, app), 'execution.json'), 'utf8')).state as string;

async function waitFor<T>(probe: () => Promise<T | undefined | false>, what: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for ${what}`);
}

// A manual SF-006 run (in its own process, like scripts/sf006-execute.sh run).
function manualRun(job: string, app = fx.app): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(process.execPath, [RUN, fixtureJson, 'no', app, job], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.once('exit', () => resolve(out.trim()));
  });
}

// An accepted, prepared job; the throwaway repository is reset first (a fake session edits the README).
async function preparedJob(job: string): Promise<void> {
  git(fx.appRepo, 'reset', '-q', '--hard');
  git(fx.appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
  await acceptedJob(fx, job);
  await fixtureService(fx).prepare(fx.app, job);
}

// A second registered app with its own throwaway repository, so two sessions do not edit the same one.
async function secondApp(): Promise<string> {
  const repo = join(fx.sandbox, 'app-two-repo');
  const { mkdir, stat } = await import('node:fs/promises');
  if (!(await stat(repo).then(() => true, () => false))) {
    await mkdir(repo);
    git(repo, 'init', '-q');
    await writeFile(join(repo, 'README.md'), '# Two\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'init');
    await mkdir(join(fx.mediator, 'factory-data', 'apps', 'app-two'), { recursive: true });
    await writeFile(join(fx.mediator, 'factory-data', 'apps', 'app-two', '.env'), `APP_REPO=${repo}\n`, { mode: 0o600 });
  }
  git(repo, 'reset', '-q', '--hard');
  git(repo, 'clean', '-q', '-fdx', '-e', '.software-factory');
  return 'app-two';
}

test('a manual SF-006 start racing an SF-007 launch: exactly one Claude process, the other refused before its claim', async () => {
  for (let round = 0; round < 3; round += 1) {
    const manualJob = `job-race-manual-${round}`;
    const consoleJob = `job-race-console-${round}`;
    // The manual job is in app-two (its own repository); the console job in app-one.
    const other = await secondApp();
    await acceptedJob(fx, manualJob, undefined, other);
    await fixtureService(fx).prepare(other, manualJob);
    git(fx.appRepo, 'reset', '-q', '--hard');
    git(fx.appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
    await acceptedJob(fx, consoleJob);
    await approve(deps(), fx.app, consoleJob, await shown(consoleJob));
    const manual = manualRun(manualJob, other);
    const attended = runInPty(fx.sandbox, [process.execPath, ATTEND, fixtureJson, fx.app, consoleJob], [['Press Enter to close', '\r']], { timeout: 30 });
    const winner = await waitFor(async () => (await live()).length === 1 && (await live()), 'one session');
    // Give the loser time to finish refusing, then count again.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await live()).length, 1, `round ${round}`);
    const manualClaimed = await claimed(manualJob, other);
    const consoleClaimed = await claimed(consoleJob);
    assert.notEqual(manualClaimed, consoleClaimed, `round ${round}: exactly one job is claimed`);
    process.kill(winner[0]!, 'SIGKILL');
    const manualResult = await manual;
    const attendResult = await attended.done;
    if (manualClaimed) {
      assert.match(attendResult.output, /session_busy|Another Claude session/, `round ${round}`);
      assert.equal(manualResult, 'state interrupted');
    } else {
      assert.equal(manualResult, 'error session_busy', `round ${round}`);
      assert.equal(await state(manualJob, other), 'prepared');
      assert.match(attendResult.output, /completed|interrupted|Did \/implement finish/, `round ${round}`);
    }
    git(fx.appRepo, 'reset', '-q', '--hard');
    git(fx.appRepo, 'clean', '-q', '-fdx', '-e', '.software-factory');
  }
});

test('a manual session that starts after approval but before attend makes attend refuse; the job stays unclaimed and re-approvable', async () => {
  await preparedJob('job-late-manual');
  await acceptedJob(fx, 'job-approved-first');
  await approve(deps(), fx.app, 'job-approved-first', await shown('job-approved-first'));
  const manual = manualRun('job-late-manual');
  await waitFor(async () => (await live()).length === 1, 'the manual session');
  const { output } = await runInPty(fx.sandbox, [process.execPath, ATTEND, fixtureJson, fx.app, 'job-approved-first'], [['Press Enter to close', '\r']]).done;
  assert.match(output, /Another Claude session is running; nothing was started/);
  assert.equal((await live()).length, 1);
  assert.equal(await claimed('job-approved-first'), false);
  const entry = await inspectJob(deps(), fx.app, 'job-approved-first');
  assert.deepEqual([entry?.status, entry?.last_launch?.code, entry?.actions], ['awaiting_operator', 'session_busy', ['approve', 'reject', 'later']]);
  // While the session runs, a new approval is refused outright.
  await assert.rejects(approve(deps(), fx.app, 'job-approved-first', await shown('job-approved-first')), { code: 'busy' });
  for (const pid of await live()) process.kill(pid, 'SIGKILL');
  await manual;
});

test('competing manual launches: one Claude process; the rest stay prepared and unclaimed', async () => {
  const jobs = ['job-compete-a', 'job-compete-b', 'job-compete-c', 'job-compete-d'];
  for (const job of jobs) await preparedJob(job);
  const runs = jobs.map((job) => manualRun(job));
  await waitFor(async () => (await live()).length >= 1, 'a session');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal((await live()).length, 1);
  const claims = await Promise.all(jobs.map((job) => claimed(job)));
  assert.equal(claims.filter(Boolean).length, 1);
  for (const pid of await live()) process.kill(pid, 'SIGKILL');
  const results = await Promise.all(runs);
  assert.equal(results.filter((result) => result === 'error session_busy').length, 3, results.join(', '));
  for (const [index, job] of jobs.entries()) if (!claims[index]) assert.equal(await state(job), 'prepared', job);
});

test('a hand-started (handed-off or resumed) session blocks SF-007 and manual launches; handoff waits for a free gate', async () => {
  await preparedJob('job-handed-off');
  const handed = await fixtureService(fx).handoff(fx.app, 'job-handed-off');
  // The operator starts it by hand, outside the gate (as the handoff command does).
  const byHand = spawn(join(fx.fakeDir, 'claude'), handed.command.slice(1), { cwd: handed.cwd, stdio: 'ignore' });
  await waitFor(async () => (await live()).length === 1, 'the hand-started session');
  await acceptedJob(fx, 'job-during-hand');
  await assert.rejects(approve(deps(), fx.app, 'job-during-hand', await shown('job-during-hand')), { code: 'busy' });
  await preparedJob('job-manual-during-hand');
  assert.equal(await manualRun('job-manual-during-hand'), 'error session_busy');
  assert.equal(await claimed('job-manual-during-hand'), false);
  assert.equal((await live()).length, 1);
  byHand.kill('SIGKILL');
  await new Promise((resolve) => byHand.once('exit', resolve));

  // While a gated session runs, nothing is handed off.
  const manual = manualRun('job-manual-during-hand');
  await waitFor(async () => (await live()).length === 1, 'a gated session');
  await preparedJob('job-handoff-later');
  await assert.rejects(fixtureService(fx).handoff(fx.app, 'job-handoff-later'), { code: 'session_busy' });
  assert.equal(await state('job-handoff-later'), 'prepared');
  for (const pid of await live()) process.kill(pid, 'SIGKILL');
  await manual;
});

test('a Claude process that outlives its adapter keeps the gate until it ends; then the next launch works', async () => {
  await preparedJob('job-orphan');
  const adapter = spawn(process.execPath, [RUN, fixtureJson, 'no', fx.app, 'job-orphan'], { stdio: 'ignore' });
  const [claude] = await waitFor(async () => (await live()).length === 1 && (await live()), 'the session');
  // The adapter (or its terminal) dies; Claude goes on.
  adapter.kill('SIGKILL');
  await new Promise((resolve) => adapter.once('exit', resolve));
  assert.deepEqual(await live(), [claude]);
  assert.equal((await new SessionGate(gatePath(fx)).holders()).length > 0, true);
  await preparedJob('job-after-orphan');
  assert.equal(await manualRun('job-after-orphan'), 'error session_busy');
  assert.equal(await claimed('job-after-orphan'), false);
  assert.equal((await live()).length, 1);
  process.kill(claude!, 'SIGKILL');
  await waitFor(async () => !((await new SessionGate(gatePath(fx)).holders()).length > 0), 'the gate to be free');
  await setMode(fx, 'ok');
  assert.equal(await manualRun('job-after-orphan'), 'state interrupted');
  assert.equal((await invocations(fx)).filter((call) => call.argv.at(-1)!.includes('/job-after-orphan/')).length, 1);
});

test('crash and restart: a holder that dies before launching frees the gate; leftover gate contents never block', async () => {
  const gate = new SessionGate(gatePath(fx));
  // A process that takes the gate and is killed before launching anything.
  const holder = spawn(
    process.execPath,
    ['--input-type=module', '-e', `import { SessionGate } from ${JSON.stringify(new URL('../src/execution/session-gate.js', import.meta.url).href)}; const r = await new SessionGate(${JSON.stringify(gatePath(fx))}).reserve('ignore'); console.log('busy' in r ? 'busy' : 'held'); setInterval(() => {}, 1000);`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
  assert.equal((await gate.holders()).length > 0, true);
  // A second reservation is refused and names the holder (read from /proc/locks).
  const second = await gate.reserve('ignore');
  assert.ok('busy' in second && second.holderPids.length === 1);
  holder.kill('SIGKILL');
  await waitFor(async () => !((await gate.holders()).length > 0), 'the gate to be free after the crash');
  // The file still names the dead holder; that never blocks (the kernel lock is what counts).
  assert.match(await readFile(gatePath(fx), 'utf8'), /"pid": \d+/);
  assert.equal((await gate.holders()).length > 0, false);
  // An unsafe gate file (group-writable) fails closed instead of being used.
  const { chmod } = await import('node:fs/promises');
  await chmod(gatePath(fx), 0o660);
  await assert.rejects(gate.reserve('ignore'), { code: 'io_failed' });
  await chmod(gatePath(fx), 0o600);
  // So does a gate directory that others could write to.
  await chmod(dirname(gatePath(fx)), 0o770);
  await assert.rejects(gate.reserve('ignore'), { code: 'io_failed' });
  await chmod(dirname(gatePath(fx)), 0o700);
  const free = await gate.reserve('ignore');
  assert.ok('held' in free);
  await free.held.release();
});

test('the handed-off command takes the same gate: it refuses while a session runs, and blocks launches while it runs', async () => {
  await preparedJob('job-gated-handoff');
  const handed = await fixtureService(fx).handoff(fx.app, 'job-gated-handoff');
  assert.deepEqual(handed.gated_command.slice(0, 5), ['flock', '--nonblock', '--conflict-exit-code', '75', gatePath(fx)]);
  assert.deepEqual(handed.gated_command.slice(5), handed.command);
  const byHand = (await import('node:fs/promises')).stat;
  assert.equal(((await byHand(gatePath(fx))).mode & 0o777), 0o600, 'the gate file exists privately before flock(1) could create it');
  // The same command with the fake claude in place of claude.
  const gated = [...handed.gated_command.slice(0, 5), join(fx.fakeDir, 'claude'), ...handed.command.slice(1)];
  await preparedJob('job-gated-other');
  const manual = manualRun('job-gated-other');
  await waitFor(async () => (await live()).length === 1 && (await new SessionGate(gatePath(fx)).holders()).length > 0, 'a gated session');
  const refused = spawnSync(gated[0]!, gated.slice(1), { cwd: handed.cwd, stdio: 'ignore', timeout: 15_000 });
  assert.equal(refused.status, 75);
  assert.equal((await live()).length, 1);
  for (const pid of await live()) process.kill(pid, 'SIGKILL');
  await manual;
  await waitFor(async () => (await new SessionGate(gatePath(fx)).holders()).length === 0, 'the gate to be free');

  // Started by hand under the gate, it holds the gate itself.
  const byHandSession = spawn(gated[0]!, gated.slice(1), { cwd: handed.cwd, stdio: 'ignore' });
  await waitFor(async () => (await live()).length === 1, 'the hand-started gated session');
  assert.ok((await new SessionGate(gatePath(fx)).holders()).length > 0);
  await preparedJob('job-gated-third');
  assert.equal(await manualRun('job-gated-third'), 'error session_busy');
  assert.equal((await live()).length, 1);
  byHandSession.kill('SIGKILL');
  for (const pid of await live()) process.kill(pid, 'SIGKILL');
});

test('a resumed interrupted session (--resume <id> or --resume=<id>) blocks launches while it runs', async () => {
  for (const form of ['separate', 'joined']) {
    const job = `job-resumed-${form}`;
    await preparedJob(job);
    await setMode(fx, 'crash');
    assert.equal(await manualRun(job), 'state interrupted');
    const sessionId = JSON.parse(await readFile(join(jobDir(fx, job), 'execution.json'), 'utf8')).session.id as string;
    await setMode(fx, 'hang');
    // The operator resumes it by hand (outside the gate).
    const args = form === 'separate' ? ['--resume', sessionId] : [`--resume=${sessionId}`];
    const resumed = spawn(join(fx.fakeDir, 'claude'), [...args, '--session-id', 'x', 'resume'], { cwd: fx.appRepo, stdio: 'ignore' });
    await waitFor(async () => (await live()).length === 1, 'the resumed session');
    await acceptedJob(fx, `job-during-resume-${form}`);
    await assert.rejects(approve(deps(), fx.app, `job-during-resume-${form}`, await shown(`job-during-resume-${form}`)), { code: 'busy' });
    await preparedJob(`job-manual-during-resume-${form}`);
    assert.equal(await manualRun(`job-manual-during-resume-${form}`), 'error session_busy');
    assert.equal((await live()).length, 1, form);
    resumed.kill('SIGKILL');
    await new Promise((resolve) => resumed.once('exit', resolve));
  }
});

test('an unreadable execution record anywhere refuses every launch (fail closed) until it is fixed', async () => {
  await preparedJob('job-corrupt-other');
  const record = join(jobDir(fx, 'job-corrupt-other'), 'execution.json');
  const good = await readFile(record, 'utf8');
  await writeFile(record, '{not json');
  await preparedJob('job-blocked-by-corrupt');
  const { message } = await fixtureService(fx).run(fx.app, 'job-blocked-by-corrupt', async () => true).then(
    () => ({ message: 'started' }),
    (error: Error) => error,
  );
  assert.match(message, /Running sessions cannot be verified: app-one\/job-corrupt-other \(not JSON\)/);
  assert.equal(await claimed('job-blocked-by-corrupt'), false);
  assert.equal((await live()).length, 0);
  await writeFile(record, good);
  await setMode(fx, 'ok');
  assert.equal(await manualRun('job-blocked-by-corrupt'), 'state interrupted');
});
