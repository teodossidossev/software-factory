// sf update (SF-101) with real Git on temporary repositories (a bare origin and an install clone
// with factory/package.json and factory/package-lock.json) and fakes for npm, the service
// (systemctl) and sf serve, injected through runUpdate's options. The fake sf serve keeps the job
// records on disk as the real one does (pause, resume, serve-busy), each job's behaviour scripted.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import type { IpcResponse } from '../src/ipc.js';
import { type Job, type JobState, JobStore, now } from '../src/jobs.js';
import { lockPath } from '../src/runner.js';
import {
  type JobRef, markerAtServeStart, markerLines, readMarker, runUpdate, UPDATE_LOG_FILE, type UpdateMarker, type UpdateOptions, type UpdateServer, type UpdateService, writeMarker,
} from '../src/update.js';
import { callSocket } from '../src/ipc.js';
import { fileURLToPath } from 'node:url';
import { git, newEnv, newRepo, processEnv, putTask, runCli, script, serve, type Served, stop, temp, turnsStarted } from './support/harness.js';

const COMMIT = 'a'.repeat(40);

// ---------------------------------------------------------------- the repositories

interface Repos {
  origin: string;
  install: string;
  // A clone that pushes new commits to origin.
  dev: string;
  state: string;
}

let counter = 0;

async function repos(name: string): Promise<Repos> {
  counter += 1;
  const root = join(temp, `update-${counter}-${name}`);
  const dev = join(root, 'dev');
  await mkdir(join(dev, 'factory'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main', dev);
  await writeFile(join(dev, '.gitignore'), 'node_modules/\ndist/\n');
  await writeFile(join(dev, 'factory', 'package.json'), '{"name":"f"}\n');
  await writeFile(join(dev, 'factory', 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(join(dev, 'factory', 'code.txt'), 'v1\n');
  git(dev, 'add', '.');
  git(dev, 'commit', '-q', '-m', 'first');
  const origin = join(root, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', dev, origin]);
  git(dev, 'remote', 'add', 'origin', origin);
  git(dev, 'fetch', '-q', 'origin');
  git(dev, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
  const install = join(root, 'install');
  execFileSync('git', ['clone', '-q', origin, install]);
  const state = join(root, 'state');
  await mkdir(state, { recursive: true });
  return { origin, install, dev, state };
}

// A new commit on origin/main; files: path (under the repository) to content.
async function push(r: Repos, subject: string, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(r.dev, path), content);
  }
  git(r.dev, 'add', '.');
  git(r.dev, 'commit', '-q', '-m', subject);
  git(r.dev, 'push', '-q', 'origin', 'main');
  return git(r.dev, 'rev-parse', 'HEAD').trim();
}

const head = (r: Repos): string => git(r.install, 'rev-parse', 'HEAD').trim();

// ---------------------------------------------------------------- the jobs

function job(workspace: string, ticket: string, state: JobState, extra: Partial<Job> = {}): Job {
  const at = now();
  return {
    workspace, ticket, branch: `${ticket}-x`, base: 'main', base_commit: COMMIT, worktree: null, prepared_commit: null, target_commit: null, mr_attempts: 0, mr_conflict_turn: false,
    fixes: 0, gate_fixes: 0, gate_tokens: 0, state, iteration: 1, session_id: null, mr: null, created_at: at, updated_at: at, ...extra,
  };
}

async function setState(jobs: JobStore, ref: JobRef, state: JobState, extra: Partial<Job> = {}): Promise<void> {
  const current = (await jobs.read(ref.workspace, ref.ticket))!;
  const { paused: _paused, ...rest } = current;
  await jobs.write({ ...rest, state, ...(state === 'paused' ? { paused: { from: current.state as 'working' | 'awaiting_review', step: 'turn', at: now() } } : {}), ...extra });
}

// A live process standing for a job's runner: its pid in runner.pid. end() ends it.
async function liveRunner(jobs: JobStore, ref: JobRef): Promise<{ end(): Promise<void>; child: ChildProcess }> {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('spawn', resolve));
  await writeFile(lockPath(jobs.dir(ref.workspace, ref.ticket)), `${child.pid}\n`);
  return {
    child,
    end: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await ended;
      }
    },
  };
}

// A pid that names no process: a child that has ended.
async function deadPid(): Promise<number> {
  const child = spawn('true', [], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

// ---------------------------------------------------------------- the fake sf serve

type Handler = (ref: JobRef, jobs: JobStore) => Promise<IpcResponse | undefined>;

class FakeServer implements UpdateServer {
  up = true;
  readonly calls: string[] = [];
  readonly jobs: JobStore;
  readonly state: string;
  // What serve-busy answers, read at each call.
  busy: () => { checks: JobRef[]; handovers: Array<JobRef & { step: string }> } = () => ({ checks: [], handovers: [] });
  // A job's own pause behaviour, by "<workspace>/<ticket>"; undefined: the default.
  readonly onPause = new Map<string, Handler>();
  // The marker as it was when each pause was sent.
  readonly markerAtPause = new Map<string, UpdateMarker | undefined>();

  constructor(state: string) {
    this.state = state;
    this.jobs = new JobStore(state);
  }

  async answers(): Promise<boolean> {
    return this.up;
  }

  async request(command: string, args: string[]): Promise<IpcResponse> {
    if (!this.up) {
      throw new FactoryError('serve_not_running', 'sf serve is not running.');
    }
    this.calls.push([command, ...args].join(' '));
    const [workspace = '', ticket = ''] = args;
    const ref = { workspace, ticket };
    if (command === 'serve-busy') {
      return { ok: true, result: this.busy() };
    }
    if (command === 'pause') {
      this.markerAtPause.set(`${workspace}/${ticket}`, await readMarker(this.state));
      const own = await this.onPause.get(`${workspace}/${ticket}`)?.(ref, this.jobs);
      if (own !== undefined) {
        return own;
      }
      const current = await this.jobs.read(workspace, ticket);
      if (current === undefined || !['working', 'awaiting_review'].includes(current.state)) {
        return { ok: false, error: { code: 'invalid_state', message: `not pausable: ${current?.state}` } };
      }
      await setState(this.jobs, ref, 'paused');
      return { ok: true, result: { state: 'paused' } };
    }
    if (command === 'resume') {
      const current = await this.jobs.read(workspace, ticket);
      if (current?.state !== 'paused') {
        return { ok: false, error: { code: 'invalid_state', message: `not paused: ${current?.state}` } };
      }
      await setState(this.jobs, ref, current.paused?.from ?? 'working');
      return { ok: true, result: { state: 'working' } };
    }
    return { ok: false, error: { code: 'bad_request', message: command } };
  }

  // The commands but the polls of serve-busy.
  sent(): string[] {
    return this.calls.filter((call) => call !== 'serve-busy');
  }
}

// The fake service: installed and active by default; restart stands for the new sf serve, which
// finishes the update as sf serve does at its start (markerAtServeStart, then the resumes).
class FakeService implements UpdateService {
  isInstalled = true;
  isActive = true;
  readonly calls: string[] = [];
  readonly server: FakeServer;
  // The new sf serve answers after the restart (false: it never comes up).
  comesUp = true;

  constructor(server: FakeServer) {
    this.server = server;
  }

  async installed(): Promise<boolean> {
    return this.isInstalled;
  }

  async active(): Promise<boolean> {
    return this.isActive;
  }

  async #newServe(): Promise<void> {
    this.server.up = false;
    if (!this.comesUp) {
      return;
    }
    const { resume } = await markerAtServeStart(this.server.state, () => undefined);
    this.server.up = true;
    for (const ref of resume ?? []) {
      await this.server.request('resume', [ref.workspace, ref.ticket]);
    }
  }

  async restart(): Promise<void> {
    this.calls.push('restart');
    await this.#newServe();
  }

  async start(): Promise<void> {
    this.calls.push('start');
    await this.#newServe();
  }
}

interface Run {
  options: UpdateOptions;
  server: FakeServer;
  service: FakeService;
  npm: string[];
  lines: string[];
  smokes: number;
}

// The options of one run; the fake npm fails a step named in failOn (by the tree: a file
// factory/BROKEN makes npm run build fail, unless the step is told otherwise).
function setup(r: Repos, extra: Partial<UpdateOptions> & { failOn?: (args: string[], cwd: string) => boolean } = {}): Run {
  const server = new FakeServer(r.state);
  const service = new FakeService(server);
  const run: Run = { server, service, npm: [], lines: [], smokes: 0, options: undefined as unknown as UpdateOptions };
  const failOn = extra.failOn ?? ((args, cwd) => args.join(' ') === 'run build' && existsSync(join(cwd, 'BROKEN')));
  run.options = {
    stateDir: r.state, install: r.install, packageDir: 'factory', mode: 'update', smoke: true, server, service,
    npm: async (args, cwd) => {
      run.npm.push(`${args.join(' ')} @${git(r.install, 'rev-parse', '--short', 'HEAD').trim()}`);
      assert.equal(cwd, join(r.install, 'factory'));
      if (args[0] === 'ci') {
        // What npm ci leaves: ignored files only.
        await mkdir(join(cwd, 'node_modules'), { recursive: true });
        await writeFile(join(cwd, 'node_modules', 'x.js'), '');
      }
      return failOn(args, cwd) ? { code: 1, output: 'error TS2322: broken\nlast line of the failure' } : { code: 0, output: `${args.join(' ')} done` };
    },
    runSmoke: async () => {
      run.smokes += 1;
      return true;
    },
    print: (line) => run.lines.push(line),
    pollMs: 20, drainTimeoutMs: 5_000, serveStartMs: 2_000,
    ...extra,
  };
  return run;
}

const A = { workspace: 'app', ticket: 'A-1' };
const B = { workspace: 'app', ticket: 'B-1' };

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<FactoryError> {
  let caught: unknown;
  await assert.rejects(promise, (error: unknown) => {
    caught = error;
    return error instanceof FactoryError && error.code === code;
  });
  return caught as FactoryError;
}

// ---------------------------------------------------------------- the tests

test('sf update refuses a dirty install, another branch and a diverged one before it pauses anything or writes the marker', async () => {
  const r = await repos('refusals');
  await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const run = setup(r);
  await run.server.jobs.write(job('app', 'A-1', 'working'));

  await writeFile(join(r.install, 'factory', 'code.txt'), 'local edit\n');
  const dirty = await rejectsWith(runUpdate(run.options), 'install_not_clean');
  assert.match(dirty.message, /factory\/code\.txt/);
  git(r.install, 'checkout', '-q', '--', '.');

  git(r.install, 'switch', '-q', '-c', 'other');
  const branch = await rejectsWith(runUpdate(run.options), 'install_not_on_main');
  assert.match(branch.message, /branch other/);
  git(r.install, 'switch', '-q', 'main');

  await writeFile(join(r.install, 'local.txt'), 'x\n');
  git(r.install, 'add', '.');
  git(r.install, 'commit', '-q', '-m', 'local commit');
  const diverged = await rejectsWith(runUpdate(run.options), 'install_diverged');
  assert.match(diverged.message, /cannot fast-forward/);

  assert.deepEqual(run.server.sent(), []);
  assert.deepEqual(run.npm, []);
  assert.equal(await readMarker(r.state), undefined);
  assert.equal((await run.server.jobs.read('app', 'A-1'))!.state, 'working');
});

test('sf update does nothing when the install is up to date; --check reports how far behind and changes nothing', async () => {
  const r = await repos('uptodate');
  const run = setup(r);
  await run.server.jobs.write(job('app', 'A-1', 'working'));
  assert.equal(await runUpdate(run.options), 0);
  assert.match(run.lines.join('\n'), /up to date with origin\/main/);
  assert.deepEqual(run.server.sent(), []);

  const before = head(r);
  await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  await push(r, 'third: the newest', { 'factory/code.txt': 'v3\n' });
  const check = setup(r, { mode: 'check' });
  assert.equal(await runUpdate(check.options), 0);
  assert.match(check.lines.join('\n'), /2 commit\(s\) behind origin\/main; newest: third: the newest/);
  assert.equal(head(r), before);
  assert.deepEqual(check.server.sent(), []);
  assert.deepEqual(check.npm, []);
  assert.equal(await readMarker(r.state), undefined);
});

test('acceptance: one job working, one paused by the user: the first is paused, its runner awaited, the install pulled, built, the service restarted, only it resumed, sf smoke run', async () => {
  const r = await repos('acceptance');
  const target = await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const start = head(r);
  const run = setup(r);
  const jobs = run.server.jobs;
  await jobs.write(job('app', 'A-1', 'working'));
  await jobs.write(job('app', 'B-1', 'paused', { paused: { from: 'working', step: 'turn', at: now() } }));
  await jobs.write(job('web', 'C-1', 'needs_human'));
  const runner = await liveRunner(jobs, A);
  // The runner ends a little after the pause; nothing is pulled before.
  run.server.onPause.set('app/A-1', async (ref) => {
    await setState(jobs, ref, 'paused');
    setTimeout(() => void runner.end(), 300);
    return { ok: true, result: { state: 'paused' } };
  });
  let pulledUnderRunner = false;
  const npm = run.options.npm;
  run.options.npm = async (args, cwd) => {
    pulledUnderRunner ||= runner.child.exitCode === null && runner.child.signalCode === null;
    return npm(args, cwd);
  };
  assert.equal(await runUpdate(run.options), 0, run.lines.join('\n'));
  assert.equal(pulledUnderRunner, false);
  assert.equal(head(r), target);
  assert.deepEqual(run.npm, [`run build @${target.slice(0, 7)}`, `run typecheck @${target.slice(0, 7)}`]);
  assert.deepEqual(run.service.calls, ['restart']);
  // Only the job it paused was paused and resumed; the user's paused job stays paused.
  assert.deepEqual(run.server.sent(), ['pause app A-1', 'resume app A-1']);
  assert.equal((await jobs.read('app', 'A-1'))!.state, 'working');
  assert.equal((await jobs.read('app', 'B-1'))!.state, 'paused');
  assert.equal((await jobs.read('web', 'C-1'))!.state, 'needs_human');
  // The marker held the job before its pause was sent, and is gone now.
  assert.deepEqual(run.server.markerAtPause.get('app/A-1')?.paused, [A]);
  assert.equal(run.server.markerAtPause.get('app/A-1')?.start_commit, start);
  assert.equal(await readMarker(r.state), undefined);
  assert.equal(run.smokes, 1);
  assert.match(run.lines.join('\n'), /smoke: PASS/);
  assert.equal(git(r.install, 'status', '--porcelain'), '');
  assert.match(await readFile(join(r.state, UPDATE_LOG_FILE), 'utf8'), /\$ npm run typecheck/);
});

test('--no-smoke skips the smoke; npm ci runs only when the lockfile changed, and the install is clean afterwards', async () => {
  const r = await repos('lockfile');
  const run = setup(r, { smoke: false });
  const second = await push(r, 'code only', { 'factory/code.txt': 'v2\n' });
  assert.equal(await runUpdate(run.options), 0, run.lines.join('\n'));
  assert.equal(run.smokes, 0);
  assert.match(run.lines.join('\n'), /smoke: skipped \(--no-smoke\)/);
  assert.deepEqual(run.npm, [`run build @${second.slice(0, 7)}`, `run typecheck @${second.slice(0, 7)}`]);

  const third = await push(r, 'a dependency', { 'factory/package-lock.json': '{"lockfileVersion":3,"x":1}\n' });
  const again = setup(r, { smoke: false });
  assert.equal(await runUpdate(again.options), 0, again.lines.join('\n'));
  assert.deepEqual(again.npm, [`ci @${third.slice(0, 7)}`, `run build @${third.slice(0, 7)}`, `run typecheck @${third.slice(0, 7)}`]);
  assert.equal(git(r.install, 'status', '--porcelain'), '');
  assert.ok(existsSync(join(r.install, 'factory', 'node_modules', 'x.js')));
});

test('acceptance: a broken build on origin/main resets the install to the start commit, rebuilds it, resumes the job and reports update_failed', async () => {
  const r = await repos('broken');
  const start = head(r);
  await push(r, 'broken', { 'factory/BROKEN': 'x\n', 'factory/package-lock.json': '{"lockfileVersion":3,"y":2}\n' });
  const run = setup(r);
  await run.server.jobs.write(job('app', 'A-1', 'awaiting_review'));
  const failure = await rejectsWith(runUpdate(run.options), 'update_failed');
  assert.match(failure.message, /last line of the failure/);
  assert.match(failure.message, /update\.log/);
  assert.equal(head(r), start);
  assert.equal(git(r.install, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(r.install, 'factory', 'BROKEN')), false);
  // npm ci for the new lockfile, the build that failed, then npm ci and the build of the old commit.
  const short = start.slice(0, 7);
  assert.deepEqual(run.npm.slice(-2), [`ci @${short}`, `run build @${short}`]);
  assert.equal(run.npm.length, 4);
  assert.deepEqual(run.server.sent(), ['pause app A-1', 'resume app A-1']);
  assert.equal((await run.server.jobs.read('app', 'A-1'))!.state, 'awaiting_review');
  assert.equal(await readMarker(r.state), undefined);
  assert.deepEqual(run.service.calls, []);
  assert.equal(run.smokes, 0);
});

test('a failed rollback leaves the marker in rollback_failed and says so; sf status shows it; --abandon removes it and resumes', async () => {
  const r = await repos('rollback-failed');
  const start = head(r);
  await push(r, 'broken', { 'factory/BROKEN': 'x\n' });
  // Every build fails, the old one too.
  const run = setup(r, { failOn: (args) => args.join(' ') === 'run build' });
  await run.server.jobs.write(job('app', 'A-1', 'working'));
  const failure = await rejectsWith(runUpdate(run.options), 'rollback_failed');
  assert.match(failure.message, /the install may not run/);
  const marker = (await readMarker(r.state))!;
  assert.equal(marker.phase, 'rollback_failed');
  assert.deepEqual(marker.paused, [A]);
  assert.equal(head(r), start);
  assert.equal((await run.server.jobs.read('app', 'A-1'))!.state, 'paused');
  const lines = (await markerLines(r.state)).join('\n');
  assert.match(lines, /update interrupted \(rollback_failed\)/);
  assert.match(lines, new RegExp(start));
  assert.match(lines, /check the install, then sf update --abandon/);
  // sf update again refuses; --abandon removes the marker, then resumes.
  await rejectsWith(runUpdate(setup(r).options), 'update_interrupted');
  const abandon = setup(r, { mode: 'abandon' });
  assert.equal(await runUpdate(abandon.options), 0);
  assert.deepEqual(abandon.server.sent(), ['resume app A-1']);
  assert.equal(await readMarker(r.state), undefined);
  assert.equal((await abandon.server.jobs.read('app', 'A-1'))!.state, 'working');
});

test('a pause that does not pause drops the job from the list and names it: the job moved on, or the pause cut off an MR preparation (mr_interrupted)', async () => {
  const r = await repos('not-paused');
  const target = await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const run = setup(r);
  const jobs = run.server.jobs;
  await jobs.write(job('app', 'A-1', 'working'));
  await jobs.write(job('app', 'B-1', 'awaiting_review'));
  run.server.onPause.set('app/A-1', async (ref) => {
    await setState(jobs, ref, 'ready_for_human_review');
    return { ok: true, result: { state: 'ready_for_human_review' } };
  });
  run.server.onPause.set('app/B-1', async (ref) => {
    await setState(jobs, ref, 'needs_human', { error: { code: 'mr_interrupted', message: 'paused as its MR preparation began' } });
    return { ok: true, result: { state: 'needs_human' } };
  });
  assert.equal(await runUpdate(run.options), 0, run.lines.join('\n'));
  assert.equal(head(r), target);
  const out = run.lines.join('\n');
  assert.match(out, /app\/A-1: not paused by the update; it is ready_for_human_review/);
  assert.match(out, /app\/B-1: not paused by the update: .*mr_interrupted.*sf say goes on with it/);
  // Neither is resumed.
  assert.deepEqual(run.server.sent(), ['pause app A-1', 'pause app B-1']);
  assert.deepEqual(run.server.markerAtPause.get('app/B-1')?.paused, [B]);
});

test('a pause refused with invalid_state is classified again; a job that parks meanwhile does not hold the drain', async () => {
  const r = await repos('invalid-state');
  await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const run = setup(r);
  const jobs = run.server.jobs;
  await jobs.write(job('app', 'A-1', 'working'));
  await jobs.write(job('app', 'B-1', 'working'));
  let first = true;
  // A-1 went from working to awaiting_review as the pause arrived: refused, then paused next round.
  run.server.onPause.set('app/A-1', async (ref) => {
    if (first) {
      first = false;
      await setState(jobs, ref, 'awaiting_review');
      return { ok: false, error: { code: 'invalid_state', message: 'moved' } };
    }
    return undefined;
  });
  // B-1 hit a usage limit: parked, idle.
  run.server.onPause.set('app/B-1', async (ref) => {
    await setState(jobs, ref, 'waiting_limit', { paused: { from: 'working', step: 'turn', at: now() }, limit: { provider: 'claude', resets_at: new Date(Date.now() + 3600_000).toISOString() } });
    return { ok: false, error: { code: 'invalid_state', message: 'parked' } };
  });
  assert.equal(await runUpdate(run.options), 0, run.lines.join('\n'));
  assert.deepEqual(run.server.sent(), ['pause app A-1', 'pause app B-1', 'pause app A-1', 'resume app A-1']);
  assert.equal((await jobs.read('app', 'B-1'))!.state, 'waiting_limit');
  assert.equal((await jobs.read('app', 'A-1'))!.state, 'awaiting_review');
});

test('a job in starting is waited for, reaches working with its first turn and is then paused; a runner started past a gate is paused too', async () => {
  const r = await repos('starting');
  await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const run = setup(r);
  const jobs = run.server.jobs;
  await jobs.write(job('app', 'A-1', 'starting'));
  await jobs.write(job('app', 'B-1', 'needs_human'));
  setTimeout(() => void setState(jobs, A, 'working'), 200);
  // A say already past the gate relaunches B-1's runner while A-1 is paused.
  let runner: Awaited<ReturnType<typeof liveRunner>> | undefined;
  run.server.onPause.set('app/A-1', async (ref) => {
    await setState(jobs, ref, 'paused');
    runner = await liveRunner(jobs, B);
    await setState(jobs, B, 'working');
    return { ok: true, result: { state: 'paused' } };
  });
  run.server.onPause.set('app/B-1', async (ref) => {
    await setState(jobs, ref, 'paused');
    await runner?.end();
    return { ok: true, result: { state: 'paused' } };
  });
  assert.equal(await runUpdate(run.options), 0, run.lines.join('\n'));
  const sent = run.server.sent();
  assert.ok(sent.includes('pause app A-1') && sent.includes('pause app B-1'), sent.join(', '));
  assert.deepEqual(sent.filter((call) => call.startsWith('resume')).sort(), ['resume app A-1', 'resume app B-1']);
});

test('sf update waits for a running Task check and a hand-over in sf serve; a handover.step without a live runner does not hold the drain', async () => {
  const r = await repos('busy');
  const target = await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const run = setup(r);
  const jobs = run.server.jobs;
  const handover = {
    branch: 'C-1-x', saved: COMMIT, base: COMMIT, previous: { branch: 'main' }, untracked: [], template: null, cleanup: null, at: now(), checked_at: null, step: 'handing_over' as const,
  };
  await jobs.write(job('web', 'C-1', 'ready_for_human_review', { handover }));
  const startedAt = Date.now();
  run.server.busy = () => (Date.now() - startedAt < 400 ? { checks: [{ workspace: 'app', ticket: 'T-9' }], handovers: [{ ...B, step: 'take_back' }] } : { checks: [], handovers: [] });
  let pulledAt = 0;
  const npm = run.options.npm;
  run.options.npm = async (args, cwd) => {
    pulledAt ||= Date.now();
    return npm(args, cwd);
  };
  assert.equal(await runUpdate(run.options), 0, run.lines.join('\n'));
  assert.ok(pulledAt - startedAt >= 400, `pulled after ${pulledAt - startedAt} ms`);
  assert.equal(head(r), target);
});

test('sf update gives up when a runner outlives the timeout: the marker removed, the paused jobs resumed, nothing pulled', async () => {
  const r = await repos('timeout');
  const start = head(r);
  await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const run = setup(r, { drainTimeoutMs: 600 });
  const jobs = run.server.jobs;
  await jobs.write(job('app', 'A-1', 'working'));
  await jobs.write(job('app', 'B-1', 'needs_human'));
  // A-1 pauses; B-1's runner never ends.
  const runner = await liveRunner(jobs, B);
  try {
    const failure = await rejectsWith(runUpdate(run.options), 'drain_timeout');
    assert.match(failure.message, /the runner of app\/B-1/);
    assert.match(failure.message, /Nothing was pulled/);
  } finally {
    await runner.end();
  }
  assert.equal(head(r), start);
  assert.deepEqual(run.npm, []);
  assert.equal(await readMarker(r.state), undefined);
  assert.deepEqual(run.server.sent(), ['pause app A-1', 'resume app A-1']);
  assert.equal((await jobs.read('app', 'A-1'))!.state, 'working');
});

test('an existing marker is never overwritten: a live update refuses with update_in_progress, a dead one in building with update_interrupted', async () => {
  const r = await repos('marker');
  await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const live: UpdateMarker = { phase: 'draining', pid: process.pid, pid_start: null, start_commit: COMMIT, paused: [A], at: now() };
  await writeMarker(r.state, live);
  await rejectsWith(runUpdate(setup(r).options), 'update_in_progress');
  assert.deepEqual(await readMarker(r.state), live);

  const building: UpdateMarker = { ...live, phase: 'building', pid: await deadPid(), pid_start: '1' };
  await writeMarker(r.state, building);
  const interrupted = await rejectsWith(runUpdate(setup(r).options), 'update_interrupted');
  assert.match(interrupted.message, /sf update --abandon/);
  assert.deepEqual(await readMarker(r.state), building);
  // A dead draining update without a running sf serve: update_interrupted too.
  const draining: UpdateMarker = { ...building, phase: 'draining' };
  await writeMarker(r.state, draining);
  const run = setup(r);
  run.server.up = false;
  await rejectsWith(runUpdate(run.options), 'update_interrupted');
  assert.deepEqual(await readMarker(r.state), draining);
});

test('--abandon removes the marker, then resumes the recorded jobs', async () => {
  const r = await repos('abandon');
  const run = setup(r, { mode: 'abandon' });
  await run.server.jobs.write(job('app', 'A-1', 'paused', { paused: { from: 'awaiting_review', step: 'review', at: now() } }));
  await run.server.jobs.write(job('app', 'B-1', 'paused', { paused: { from: 'working', step: 'turn', at: now() } }));
  await writeMarker(r.state, { phase: 'building', pid: await deadPid(), pid_start: '1', start_commit: COMMIT, paused: [A], at: now() });
  let markerAtResume: boolean | undefined;
  const request = run.server.request.bind(run.server);
  run.server.request = async (command, args) => {
    markerAtResume ??= command === 'resume' ? (await readMarker(r.state)) !== undefined : undefined;
    return request(command, args);
  };
  assert.equal(await runUpdate(run.options), 0);
  assert.equal(markerAtResume, false);
  assert.deepEqual(run.server.sent(), ['resume app A-1']);
  assert.equal((await run.server.jobs.read('app', 'A-1'))!.state, 'awaiting_review');
  assert.equal((await run.server.jobs.read('app', 'B-1'))!.state, 'paused');
  assert.equal(await readMarker(r.state), undefined);
});

test('the new sf serve does not answer within its time: serve_not_started, no smoke, the marker stays in restart_pending', async () => {
  const r = await repos('not-started');
  await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const run = setup(r, { serveStartMs: 300 });
  run.service.comesUp = false;
  await run.server.jobs.write(job('app', 'A-1', 'working'));
  const failure = await rejectsWith(runUpdate(run.options), 'serve_not_started');
  assert.match(failure.message, /journalctl --user -u software-factory/);
  assert.equal(run.smokes, 0);
  const marker = (await readMarker(r.state))!;
  assert.equal(marker.phase, 'restart_pending');
  assert.deepEqual(marker.paused, [A]);
});

test('without the service, sf update leaves the marker for a restart by hand; an inactive service with a hand-started sf serve is not touched; an inactive one alone is started', async () => {
  const r = await repos('no-service');
  await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const run = setup(r);
  run.service.isInstalled = false;
  await run.server.jobs.write(job('app', 'A-1', 'working'));
  assert.equal(await runUpdate(run.options), 0);
  assert.match(run.lines.join('\n'), /Restart sf serve now/);
  assert.equal((await readMarker(r.state))!.phase, 'restart_pending');
  assert.deepEqual(run.service.calls, []);
  assert.equal(run.smokes, 0);
  // The hand restart: the new sf serve takes the marker and resumes.
  const { resume } = await markerAtServeStart(r.state, () => undefined);
  assert.deepEqual(resume, [A]);
  assert.equal(await readMarker(r.state), undefined);

  await push(r, 'third', { 'factory/code.txt': 'v3\n' });
  const handStarted = setup(r);
  handStarted.service.isActive = false;
  assert.equal(await runUpdate(handStarted.options), 0);
  assert.deepEqual(handStarted.service.calls, []);
  assert.equal((await readMarker(r.state))!.phase, 'restart_pending');
  await markerAtServeStart(r.state, () => undefined);

  // No sf serve answers and the service is inactive: updated directly, then started (3h).
  await push(r, 'fourth', { 'factory/code.txt': 'v4\n' });
  const alone = setup(r);
  alone.server.up = false;
  alone.service.isActive = false;
  assert.equal(await runUpdate(alone.options), 0, alone.lines.join('\n'));
  assert.deepEqual(alone.service.calls, ['restart']);
  assert.equal(await readMarker(r.state), undefined);
  assert.equal(alone.smokes, 1);
});

test('without a running sf serve: jobs_running while a runner lives; otherwise updated directly, with the marker in building meanwhile', async () => {
  const r = await repos('direct');
  const target = await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const run = setup(r);
  run.server.up = false;
  run.service.isInstalled = false;
  const jobs = run.server.jobs;
  await jobs.write(job('app', 'A-1', 'working'));
  const runner = await liveRunner(jobs, A);
  try {
    const refusal = await rejectsWith(runUpdate(run.options), 'jobs_running');
    assert.match(refusal.message, /app\/A-1 \(working\)/);
    assert.match(refusal.message, /start sf serve and run sf update again/);
  } finally {
    await runner.end();
  }
  assert.equal(await readMarker(r.state), undefined);
  let phase: string | undefined;
  const npm = run.options.npm;
  run.options.npm = async (args, cwd) => {
    phase ??= (await readMarker(r.state))?.phase;
    return npm(args, cwd);
  };
  assert.equal(await runUpdate(run.options), 0, run.lines.join('\n'));
  assert.equal(phase, 'building');
  assert.equal(head(r), target);
  assert.equal(await readMarker(r.state), undefined);
  assert.match(run.lines.join('\n'), /Start sf serve/);
  assert.deepEqual(run.server.calls, []);
});

test('end to end with a real sf serve: the working job is paused and its runner ends, the install is pulled and built, the restarted sf serve resumes only that job; the user\'s paused job stays paused', { timeout: 120_000 }, async () => {
  const r = await repos('real-serve');
  const target = await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const env = await newEnv('update-real-serve');
  const repo = await newRepo(env, 'update-real-serve-repo', false);
  await putTask(env, repo, 'W-1', 'Working');
  await putTask(env, repo, 'U-1', 'Paused by the user');
  await script(env, [{ delayMs: 60_000, write: { 'w.txt': 'x\n' } }, { delayMs: 60_000, write: { 'u.txt': 'x\n' } }, { write: { 'w2.txt': 'w\n' }, text: 'Went on.' }]);
  let served: Served = await serve(env);
  try {
    assert.equal((await runCli(env, ['start', 'app', 'W-1'])).code, 0);
    await turnsStarted(env, 1);
    assert.equal((await runCli(env, ['start', 'app', 'U-1'])).code, 0);
    await turnsStarted(env, 2);
    assert.equal((await runCli(env, ['pause', 'app', 'U-1'])).code, 0);
    const jobs = new JobStore(env.state);
    const lines: string[] = [];
    const npm: string[] = [];
    let runnerAtBuild: boolean | undefined;
    const restarts: string[] = [];
    const answers = async (): Promise<boolean> => callSocket(env.state, { command: 'ping', args: [] }).then((response) => response.ok, () => false);
    const service: UpdateService = {
      installed: async () => true,
      active: async () => true,
      restart: async () => {
        restarts.push('restart');
        await stop(served);
        served = await serve(env);
      },
      start: async () => assert.fail('not started'),
    };
    const code = await runUpdate({
      stateDir: env.state, install: r.install, packageDir: 'factory', mode: 'update', smoke: false,
      server: { answers, request: (command, args) => callSocket(env.state, { command, args }) },
      service,
      npm: async (args) => {
        runnerAtBuild ??= existsSync(lockPath(jobs.dir('app', 'W-1')));
        npm.push(args.join(' '));
        return { code: 0, output: '' };
      },
      runSmoke: async () => assert.fail('no smoke with --no-smoke'),
      print: (line) => lines.push(line),
      pollMs: 100,
    });
    assert.equal(code, 0, lines.join('\n'));
    assert.equal(runnerAtBuild, false);
    assert.equal(head(r), target);
    assert.deepEqual(npm, ['run build', 'run typecheck']);
    assert.deepEqual(restarts, ['restart']);
    assert.match(lines.join('\n'), /paused app\/W-1 \(it was working\)/);
    // The new sf serve resumed W-1, and only it.
    const deadline = Date.now() + 20_000;
    while ((await jobs.read('app', 'W-1'))!.state !== 'awaiting_review') {
      assert.ok(Date.now() < deadline, `W-1 is ${(await jobs.read('app', 'W-1'))!.state}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await jobs.read('app', 'U-1'))!.state, 'paused');
    assert.equal(await readMarker(env.state), undefined);
    assert.match(served.output, /finishing the update/);
  } finally {
    await stop(served);
  }
});

test('sf serve gone while the update gives up: the marker stays in draining with the jobs it paused, for the next sf serve to resume', async () => {
  const r = await repos('gone');
  const start = head(r);
  await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const run = setup(r, { drainTimeoutMs: 2_000 });
  const jobs = run.server.jobs;
  await jobs.write(job('app', 'A-1', 'working'));
  await jobs.write(job('app', 'B-1', 'starting'));
  // sf serve stops right after it paused A-1; the next serve-busy fails.
  run.server.onPause.set('app/A-1', async (ref) => {
    await setState(jobs, ref, 'paused');
    setTimeout(() => void (run.server.up = false), 50);
    return { ok: true, result: { state: 'paused' } };
  });
  await assert.rejects(runUpdate(run.options));
  assert.equal(head(r), start);
  const marker = (await readMarker(r.state))!;
  assert.deepEqual([marker.phase, marker.paused], ['draining', [A]]);
  assert.match(run.lines.join('\n'), /the next sf serve resumes them: app\/A-1/);
  assert.equal((await jobs.read('app', 'A-1'))!.state, 'paused');
  // Without sf serve, --abandon leaves it so too.
  const abandon = setup(r, { mode: 'abandon' });
  abandon.server.up = false;
  assert.equal(await runUpdate(abandon.options), 1);
  assert.deepEqual((await readMarker(r.state))!.paused, [A]);
});

test('an sf update killed mid-drain leaves every job it paused in the marker, and the running sf serve resumes them', { timeout: 120_000 }, async () => {
  const r = await repos('killed');
  const start = head(r);
  await push(r, 'second', { 'factory/code.txt': 'v2\n' });
  const env = await newEnv('update-killed', { SF_TEST_MARKER_POLL_MS: '200' });
  const repo = await newRepo(env, 'update-killed-repo', false);
  await putTask(env, repo, 'W-1', 'Working');
  await putTask(env, repo, 'V-1', 'Working too');
  await script(env, [{ delayMs: 60_000, write: { 'w.txt': 'x\n' } }, { delayMs: 60_000, write: { 'v.txt': 'x\n' } }, { write: { 'w2.txt': 'w\n' }, text: 'Went on.' }, { write: { 'v2.txt': 'v\n' }, text: 'Went on.' }]);
  const served = await serve(env);
  const child = { process: undefined as ChildProcess | undefined };
  try {
    assert.equal((await runCli(env, ['start', 'app', 'W-1'])).code, 0);
    await turnsStarted(env, 1);
    assert.equal((await runCli(env, ['start', 'app', 'V-1'])).code, 0);
    await turnsStarted(env, 2);
    const jobs = new JobStore(env.state);
    // A job left in starting, with no runner, holds the drain after the pauses.
    await jobs.write(job('app', 'S-1', 'starting'));
    // sf update in a process of its own, against the real sf serve.
    const updater = join(temp, 'updater.mjs');
    const dist = (path: string): string => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    await writeFile(updater, [
      `import { runUpdate } from ${dist('../src/update.js')};`,
      `import { callSocket } from ${dist('../src/ipc.js')};`,
      'const [state, install] = process.argv.slice(2);',
      'await runUpdate({ stateDir: state, install, packageDir: "factory", mode: "update", smoke: false, pollMs: 100,',
      '  server: { answers: () => callSocket(state, { command: "ping", args: [] }).then((r) => r.ok, () => false), request: (command, args) => callSocket(state, { command, args }) },',
      '  service: { installed: async () => false, active: async () => false, restart: async () => {}, start: async () => {} },',
      '  npm: async () => ({ code: 0, output: "" }), runSmoke: async () => true, print: (line) => console.log(line) });',
    ].join('\n'));
    child.process = spawn(process.execPath, [updater, env.state, r.install], { env: processEnv(env), stdio: 'ignore' });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const marker = await readMarker(env.state).catch(() => undefined);
      if (marker?.paused.length === 2 && (await jobs.read('app', 'W-1'))!.state === 'paused' && (await jobs.read('app', 'V-1'))!.state === 'paused') {
        assert.deepEqual(marker.paused.map((ref) => ref.ticket).sort(), ['V-1', 'W-1']);
        break;
      }
      assert.ok(Date.now() < deadline, 'the drain did not pause both jobs');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const ended = new Promise((resolve) => child.process!.once('exit', resolve));
    child.process.kill('SIGKILL');
    await ended;
    const until = Date.now() + 30_000;
    while ((await readMarker(env.state).catch(() => undefined)) !== undefined || (await jobs.read('app', 'W-1'))!.state === 'paused' || (await jobs.read('app', 'V-1'))!.state === 'paused') {
      assert.ok(Date.now() < until, 'sf serve did not resume the jobs of the killed update');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Killed before the pull: the install is where it was.
    assert.equal(head(r), start);
  } finally {
    child.process?.kill('SIGKILL');
    await stop(served);
  }
});
