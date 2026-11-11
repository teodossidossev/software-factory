// sf update: updates the Git install the running sf comes from, draining first. The
// install is pulled and built only once no job runs: the running jobs are paused (each recorded in
// the updating marker before its pause is sent), the build and typecheck run, a failed step rolls
// the install back to the commit it started from and resumes the recorded jobs on the old code, a
// good build restarts the service and the new sf serve resumes them. Without a running sf serve it
// updates directly, unless a job's runner still runs (jobs_running).
// The updating marker (<state dir>/updating, JSON, always written atomically) holds the phase, the
// pid of sf update, the start commit and the jobs the update paused. While it exists the gates of
// sf serve refuse the commands that change something (update_in_progress) and the background work
// skips (the run queue's pass, the automatic Task checks, the hand-over after config_locked); the
// skipped automatic checks are recorded in update-skipped-checks.json for the catch-up. Every path
// that resumes the recorded jobs reads the list, removes the marker, then resumes them.
// This module holds the marker's reading and writing, the gates' helpers, what sf serve does with
// the marker (at start and on a poll), and the update itself (runUpdate), with its seams (the
// server, npm, the service and the smoke) injected so that the tests use fakes.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import type { IpcResponse } from './ipc.js';
import { type Job, type JobState, JobStore, now, PAUSABLE_STATES, statesWith, TERMINAL_STATES } from './jobs.js';
import { liveOwner, ownerAlive, startTime } from './pid-lock.js';
import { lockPath } from './runner.js';
import { JOURNAL_HINT, SERVICE_NAME } from './service.js';

export const UPDATE_MARKER_FILE = 'updating';
export const SKIPPED_CHECKS_FILE = 'update-skipped-checks.json';
export const UPDATE_LOG_FILE = 'update.log';

export const UPDATE_PHASES = ['draining', 'building', 'restart_pending', 'rollback_failed'] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];

// The drain's steps 2-5 share one timeout; the new sf serve has this long to answer.
export const DRAIN_TIMEOUT_MS = 10 * 60_000;
export const SERVE_START_TIMEOUT_MS = 60_000;
// How often sf serve looks at the marker while it runs.
export const MARKER_POLL_MS = 5_000;
// How long sf update waits for a running sf serve to take over the marker of an update that died
// while it drained.
const TAKEOVER_WAIT_MS = 3 * MARKER_POLL_MS;

export interface JobRef {
  workspace: string;
  ticket: string;
}

const jobRef = z.strictObject({ workspace: z.string().min(1), ticket: z.string().min(1) });
const markerSchema = z.strictObject({
  phase: z.enum(UPDATE_PHASES),
  pid: z.number().int().positive(),
  // The start time of that process (/proc), so a reused pid is not taken for it; null without /proc.
  pid_start: z.string().nullable(),
  start_commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  paused: z.array(jobRef),
  at: z.iso.datetime(),
});
export type UpdateMarker = z.infer<typeof markerSchema>;

export const markerPath = (stateDir: string): string => join(stateDir, UPDATE_MARKER_FILE);
const skippedPath = (stateDir: string): string => join(stateDir, SKIPPED_CHECKS_FILE);
const refText = (ref: JobRef): string => `${ref.workspace}/${ref.ticket}`;
const sameRef = (a: JobRef, b: JobRef): boolean => a.workspace === b.workspace && a.ticket === b.ticket;

// Whether the marker exists: the gates' check, synchronous and cheap. An unreadable marker gates too.
export function updateMarked(stateDir: string): boolean {
  return existsSync(markerPath(stateDir));
}

// The marker; undefined when there is none. An unreadable one is update_marker_invalid.
export async function readMarker(stateDir: string): Promise<UpdateMarker | undefined> {
  let text: string;
  try {
    text = await readFile(markerPath(stateDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  try {
    return markerSchema.parse(JSON.parse(text));
  } catch { // not JSON or not a marker: reported as update_marker_invalid
    throw new FactoryError('update_marker_invalid', 'update_marker_invalid: the updating marker in the state directory cannot be read; check the install, then sf update --abandon.');
  }
}

export async function writeMarker(stateDir: string, marker: UpdateMarker): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(markerPath(stateDir), Buffer.from(`${JSON.stringify(markerSchema.parse(marker), null, 2)}\n`, 'utf8'));
}

export async function removeMarker(stateDir: string): Promise<void> {
  await rm(markerPath(stateDir), { force: true });
}

// A new marker of this process.
export function newMarker(phase: UpdatePhase, startCommit: string, paused: JobRef[] = []): UpdateMarker {
  return { phase, pid: process.pid, pid_start: startTime(process.pid) ?? null, start_commit: startCommit, paused, at: now() };
}

// Whether the sf update that wrote the marker still runs (its pid, with its start time as the pid
// lock checks it).
export function updaterAlive(marker: Pick<UpdateMarker, 'pid' | 'pid_start'>): boolean {
  return ownerAlive({ pid: marker.pid, start: marker.pid_start ?? undefined });
}

// The jobs to resume: the list is read, the marker removed, and the list returned (the order every
// caller resumes them after). An unreadable marker is removed with no jobs.
export async function takeMarkerJobs(stateDir: string): Promise<JobRef[]> {
  const marker = await readMarker(stateDir).catch((error: unknown) => {
    if (error instanceof FactoryError && error.code === 'update_marker_invalid') {
      return undefined;
    }
    throw error;
  });
  await removeMarker(stateDir);
  return marker?.paused ?? [];
}

export const UPDATE_IN_PROGRESS = 'update_in_progress';

// The gates' refusal while the marker exists, before anything changes.
export function refuseWhileUpdating(stateDir: string): void {
  if (updateMarked(stateDir)) {
    throw new FactoryError(UPDATE_IN_PROGRESS, 'The factory is being updated (sf update); try again once it is done; sf status shows the update (update_in_progress).');
  }
}

// An automatic Task check skipped under the marker: its trigger is appended for the catch-up.
export async function recordSkippedCheck(stateDir: string, ref: JobRef): Promise<void> {
  const current = await readSkippedChecks(stateDir);
  if (!current.some((other) => sameRef(other, ref))) {
    await writeFileAtomic(skippedPath(stateDir), Buffer.from(`${JSON.stringify([...current, { workspace: ref.workspace, ticket: ref.ticket }])}\n`, 'utf8'));
  }
}

export async function readSkippedChecks(stateDir: string): Promise<JobRef[]> {
  try {
    const parsed = z.array(jobRef).safeParse(JSON.parse(await readFile(skippedPath(stateDir), 'utf8')));
    return parsed.success ? parsed.data : [];
  } catch { // missing or not JSON: no skipped checks are recorded
    return [];
  }
}

export async function removeSkippedChecks(stateDir: string): Promise<void> {
  await rm(skippedPath(stateDir), { force: true });
}

const INTERRUPTED_HINT = 'check the install, then sf update --abandon';

// Whether the marker's update was interrupted and needs the user: building with its pid dead, or
// rollback_failed.
const interrupted = (marker: UpdateMarker): boolean => marker.phase === 'rollback_failed' || (marker.phase === 'building' && !updaterAlive(marker));

// sf status: the marker, its phase, and the guidance when the update was interrupted.
export async function markerLines(stateDir: string): Promise<string[]> {
  let marker: UpdateMarker | undefined;
  try {
    marker = await readMarker(stateDir);
  } catch (error) {
    if (error instanceof FactoryError && error.code === 'update_marker_invalid') {
      return [`update: the updating marker cannot be read; ${INTERRUPTED_HINT}`];
    }
    throw error;
  }
  if (marker === undefined) {
    return [];
  }
  const alive = updaterAlive(marker);
  const paused = marker.paused.length === 0 ? 'none' : marker.paused.map(refText).join(', ');
  const lines = [`update: ${marker.phase} (sf update pid ${marker.pid}, ${alive ? 'running' : 'ended'}; from ${marker.start_commit.slice(0, 12)}; paused by it: ${paused})`];
  if (interrupted(marker)) {
    lines.push(`update interrupted (${marker.phase}): the install started from ${marker.start_commit}; ${INTERRUPTED_HINT}`);
  } else if (marker.phase === 'restart_pending' && !alive) {
    lines.push(`update built: restart sf serve (systemctl --user restart ${SERVICE_NAME}, or by hand); it resumes the paused jobs`);
  } else {
    lines.push('while it runs, sf serve refuses the commands that change something (update_in_progress)');
  }
  return lines;
}

// What sf serve does with the marker at its start. resume: the recorded jobs to resume once it
// serves (the marker is removed already: restart_pending, or draining with its pid dead); gated:
// the marker stays (draining or building with its pid alive, building with it dead, rollback_failed,
// or unreadable), recovery starts no runner and the gates apply.
// taken: the marker as it was when it was removed, so that a start that fails afterwards puts it back
// (putMarkerBack) and the next sf serve still resumes the jobs.
export async function markerAtServeStart(stateDir: string, log: (line: string) => void = console.log): Promise<{ gated: boolean; resume: JobRef[] | undefined; taken?: UpdateMarker }> {
  let marker: UpdateMarker | undefined;
  try {
    marker = await readMarker(stateDir);
  } catch (error) {
    if (error instanceof FactoryError && error.code === 'update_marker_invalid') {
      log(`update: ${error.message}`);
      return { gated: true, resume: undefined };
    }
    throw error;
  }
  if (marker === undefined) {
    return { gated: false, resume: undefined };
  }
  if (marker.phase === 'restart_pending' || (marker.phase === 'draining' && !updaterAlive(marker))) {
    const jobs = await takeMarkerJobs(stateDir);
    const taken = marker;
    log(marker.phase === 'restart_pending'
      ? `update: finishing the update (restart_pending): resuming ${jobs.length} job(s) the update paused`
      : `update: the sf update that drained (pid ${marker.pid}) has ended before it pulled: resuming ${jobs.length} job(s) it paused`);
    return { gated: false, resume: jobs, taken };
  }
  if (interrupted(marker)) {
    log(`update interrupted (${marker.phase}): the install started from ${marker.start_commit}; ${INTERRUPTED_HINT}. Until then sf serve refuses the commands that change something.`);
  } else {
    log(`update: sf update (pid ${marker.pid}) is ${marker.phase}; sf serve refuses the commands that change something until it is done`);
  }
  return { gated: true, resume: undefined };
}

// sf serve's start failed after markerAtServeStart took the marker: it goes back, unless a new one
// was written meanwhile.
export async function putMarkerBack(stateDir: string, taken: UpdateMarker | undefined): Promise<void> {
  if (taken !== undefined && !updateMarked(stateDir)) {
    await writeMarker(stateDir, taken);
  }
}

export interface MarkerWatchHooks {
  // Resumes one recorded job (Execution.resumePaused).
  resume(ref: JobRef): Promise<unknown>;
  // The catch-up: what the gates skipped.
  catchUp(): Promise<void>;
  log?: (line: string) => void;
}

// sf serve's poll of the marker while it runs: a marker that went away (whoever removed it)
// runs the catch-up; a draining marker whose sf update died has its recorded jobs resumed, then the
// catch-up. finish() is the same for the jobs taken at start.
export class MarkerWatch {
  readonly #stateDir: string;
  readonly #hooks: MarkerWatchHooks;
  readonly #pollMs: number;
  #present: boolean;
  #timer: NodeJS.Timeout | undefined;
  #busy: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(stateDir: string, present: boolean, hooks: MarkerWatchHooks, pollMs = MARKER_POLL_MS) {
    this.#stateDir = stateDir;
    this.#present = present;
    this.#hooks = hooks;
    this.#pollMs = pollMs;
  }

  #log(line: string): void {
    (this.#hooks.log ?? console.log)(line);
  }

  start(): void {
    if (this.#closed) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#busy = this.#busy.then(() => this.poll()).catch((error: unknown) => console.error(error)).finally(() => this.start());
    }, this.#pollMs);
    this.#timer.unref();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
  }

  // Settles once the work begun so far has ended (tests).
  idle(): Promise<void> {
    return this.#busy;
  }

  // One look at the marker.
  async poll(): Promise<void> {
    if (this.#closed) {
      return;
    }
    let marker: UpdateMarker | undefined;
    try {
      marker = await readMarker(this.#stateDir);
    } catch (error) {
      if (error instanceof FactoryError && error.code === 'update_marker_invalid') {
        this.#present = true;
        return;
      }
      throw error;
    }
    if (marker === undefined) {
      if (this.#present) {
        this.#present = false;
        this.#log('update: the updating marker is gone; catching up on what it held back');
        await this.#hooks.catchUp();
      }
      return;
    }
    this.#present = true;
    if (marker.phase === 'draining' && !updaterAlive(marker)) {
      const jobs = await takeMarkerJobs(this.#stateDir);
      this.#present = false;
      this.#log(`update: the sf update that drained (pid ${marker.pid}) has ended before it pulled: resuming ${jobs.length} job(s) it paused`);
      await this.finish(jobs);
    }
  }

  // The recorded jobs (the marker is gone already) are resumed one by one, then the catch-up.
  async finish(jobs: JobRef[]): Promise<void> {
    for (const ref of jobs) {
      try {
        await this.#hooks.resume(ref);
        this.#log(`update: resumed ${refText(ref)}`);
      } catch (error) {
        this.#log(`update: ${refText(ref)} was not resumed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.#hooks.catchUp();
  }
}

// ---------------------------------------------------------------------------------------------
// The update itself.

// sf serve as sf update sees it: whether it answers, and one socket command.
export interface UpdateServer {
  answers(): Promise<boolean>;
  request(command: string, args: string[]): Promise<IpcResponse>;
}

// The systemd user service (src/service.ts).
export interface UpdateService {
  installed(): Promise<boolean>;
  active(): Promise<boolean>;
  restart(): Promise<void>;
  start(): Promise<void>;
}

export interface CommandResult {
  code: number | null;
  output: string;
}

export interface UpdateOptions {
  stateDir: string;
  // The Git top level of the install.
  install: string;
  // The factory's package inside it (factory), where npm runs.
  packageDir: string;
  mode: 'update' | 'check' | 'abandon';
  smoke: boolean;
  server: UpdateServer;
  service: UpdateService;
  // npm with these arguments in cwd; its output goes to update.log.
  npm(args: string[], cwd: string): Promise<CommandResult>;
  // sf smoke of the new install; true when it passed.
  runSmoke(): Promise<boolean>;
  print(line: string): void;
  drainTimeoutMs?: number;
  serveStartMs?: number;
  pollMs?: number;
}

// The job states the drain pauses, and those it waits through.
const PAUSABLE: readonly JobState[] = PAUSABLE_STATES;
// Idle for the drain: nothing of the job runs or is about to.
const IDLE_STATES = statesWith('idle');
// The states that must not exist right before the pull.
const BUSY_STATES = statesWith('busy');

interface Busy {
  checks: JobRef[];
  handovers: Array<JobRef & { step: string }>;
}

class DrainTimeout extends Error {
  readonly unsettled: string[];
  constructor(unsettled: string[]) {
    super('drain timeout');
    this.unsettled = unsettled;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// One update run (see the top of this file); returns the exit code. A refusal throws its
// FactoryError, its code in its message.
export async function runUpdate(options: UpdateOptions): Promise<number> {
  return new Updater(options).run();
}

class Updater {
  readonly #o: UpdateOptions;
  readonly #jobs: JobStore;
  readonly #poll: number;
  #marker: UpdateMarker | undefined;

  constructor(options: UpdateOptions) {
    this.#o = options;
    this.#jobs = new JobStore(options.stateDir);
    this.#poll = options.pollMs ?? 500;
  }

  #print(line: string): void {
    this.#o.print(line);
  }

  async #git(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
    const result = await runGit(this.#o.install, args);
    return { code: result.code, out: result.stdout.toString('utf8').trim(), err: result.stderr.trim() };
  }

  async run(): Promise<number> {
    if (this.#o.mode === 'abandon') {
      return this.#abandon();
    }
    if (this.#o.mode === 'check') {
      return this.#check();
    }
    // The refusals, before any job is touched or anything written.
    await this.#refuseMarker();
    const start = await this.#refuseInstall();
    if (start.behind === 0) {
      this.#print(`The install is up to date with origin/main (${start.head.slice(0, 12)}).`);
      return 0;
    }
    this.#print(`Updating the install ${this.#o.install} from ${start.head.slice(0, 12)}: ${start.behind} commit(s) behind origin/main (newest: ${start.subject}).`);
    if (!(await this.#o.server.answers())) {
      return this.#direct(start.head);
    }
    return this.#withServer(start.head);
  }

  // A marker that exists is never overwritten.
  async #refuseMarker(): Promise<void> {
    let marker = await this.#readMarkerOrRefuse();
    if (marker === undefined) {
      return;
    }
    if (marker.phase === 'draining' && !updaterAlive(marker) && (await this.#o.server.answers())) {
      // The running sf serve resumes its jobs and removes it (MarkerWatch).
      this.#print(`An earlier sf update (pid ${marker.pid}) died while it drained; waiting for sf serve to resume the jobs it paused.`);
      const deadline = Date.now() + TAKEOVER_WAIT_MS;
      while (marker !== undefined && Date.now() < deadline) {
        await sleep(this.#poll);
        marker = await this.#readMarkerOrRefuse();
      }
      if (marker === undefined) {
        return;
      }
    }
    if (updaterAlive(marker) && marker.phase !== 'rollback_failed') {
      throw new FactoryError(UPDATE_IN_PROGRESS, `update_in_progress: another sf update (pid ${marker.pid}) is ${marker.phase}; wait for it to end.`);
    }
    if (marker.phase === 'restart_pending') {
      throw new FactoryError(UPDATE_IN_PROGRESS, 'update_in_progress: the last update is built and waits for sf serve to restart (restart_pending); restart sf serve, then run sf update again.');
    }
    throw new FactoryError(
      'update_interrupted',
      `update_interrupted: an earlier sf update (pid ${marker.pid}) ended in ${marker.phase}; the install started from ${marker.start_commit}: ${INTERRUPTED_HINT}.`,
    );
  }

  async #readMarkerOrRefuse(): Promise<UpdateMarker | undefined> {
    try {
      return await readMarker(this.#o.stateDir);
    } catch (error) {
      if (error instanceof FactoryError && error.code === 'update_marker_invalid') {
        throw new FactoryError('update_interrupted', `update_interrupted: the updating marker cannot be read; ${INTERRUPTED_HINT}.`);
      }
      throw error;
    }
  }

  // Fetches origin main and returns where the install is; refuses a dirty install, another branch
  // and one that cannot fast-forward.
  async #refuseInstall(): Promise<{ head: string; behind: number; subject: string }> {
    const found = await this.#look();
    if (found.problems.length > 0) {
      throw found.problems[0]!;
    }
    return found;
  }

  async #look(): Promise<{ head: string; behind: number; subject: string; problems: FactoryError[] }> {
    const install = this.#o.install;
    const fetched = await this.#git(['fetch', '--quiet', 'origin', 'main']);
    if (fetched.code !== 0) {
      throw new FactoryError('fetch_failed', `fetch_failed: git fetch origin main failed in the install: ${fetched.err.slice(0, 500)}`);
    }
    const head = (await this.#git(['rev-parse', 'HEAD'])).out;
    const remote = (await this.#git(['rev-parse', 'origin/main'])).out;
    const behind = Number((await this.#git(['rev-list', '--count', 'HEAD..origin/main'])).out);
    const subject = (await this.#git(['log', '-1', '--format=%s', 'origin/main'])).out;
    const problems: FactoryError[] = [];
    const dirty = (await runGit(install, ['status', '--porcelain'])).stdout.toString('utf8');
    if (dirty.trim() !== '') {
      const files = dirty.split('\n').filter((line) => line !== '').slice(0, 5).map((line) => line.slice(3)).join(', ');
      problems.push(new FactoryError('install_not_clean', `install_not_clean: the install has uncommitted changes (${files}); commit, stash or discard them, then run sf update again.`));
    }
    const branch = (await this.#git(['branch', '--show-current'])).out;
    if (branch !== 'main') {
      problems.push(new FactoryError('install_not_on_main', `install_not_on_main: the install is on ${branch === '' ? 'a detached HEAD' : `branch ${branch}`}; switch it to main (git switch main), then run sf update again.`));
    }
    if (head !== remote && (await this.#git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main'])).code !== 0) {
      problems.push(new FactoryError('install_diverged', `install_diverged: the install has commits that origin/main does not (it cannot fast-forward); reset it to origin/main or push them through a merge request, then run sf update again.`));
    }
    return { head, behind: head === remote ? 0 : behind, subject, problems };
  }

  // sf update --check: fetches and reports; changes nothing.
  async #check(): Promise<number> {
    const found = await this.#look();
    this.#print(found.behind === 0
      ? `The install ${this.#o.install} is up to date with origin/main (${found.head.slice(0, 12)}).`
      : `The install ${this.#o.install} is ${found.behind} commit(s) behind origin/main; newest: ${found.subject}`);
    for (const problem of found.problems) {
      this.#print(`sf update would refuse: ${problem.message}`);
    }
    const marker = await readMarker(this.#o.stateDir).catch(() => undefined);
    if (marker !== undefined) {
      this.#print(`An updating marker exists (${marker.phase}); sf status shows it.`);
    }
    return 0;
  }

  // sf update --abandon: the marker goes, then the recorded jobs are resumed.
  async #abandon(): Promise<number> {
    let marker: UpdateMarker | undefined;
    try {
      marker = await readMarker(this.#o.stateDir);
    } catch (error) {
      if (!(error instanceof FactoryError && error.code === 'update_marker_invalid')) {
        throw error;
      }
    }
    if (marker === undefined && !updateMarked(this.#o.stateDir)) {
      this.#print('There is no updating marker; nothing to abandon.');
      return 0;
    }
    if (marker !== undefined && marker.phase !== 'rollback_failed' && updaterAlive(marker) && marker.pid !== process.pid) {
      throw new FactoryError(UPDATE_IN_PROGRESS, `update_in_progress: sf update (pid ${marker.pid}) is still ${marker.phase}; stop it first.`);
    }
    this.#print(`Abandoning the update${marker !== undefined ? ` (${marker.phase}, from ${marker.start_commit.slice(0, 12)})` : ''}.`);
    return (await this.#handBack()) ? 0 : 1;
  }

  // The jobs the update paused go back. With sf serve answering, the marker is removed, then each
  // one is resumed. Without one, the marker is left in draining with them: once this sf update has
  // ended, the next sf serve resumes them as the jobs of an update that died before it pulled (an
  // unreadable marker or one without jobs is removed). True when every one was resumed.
  async #handBack(): Promise<boolean> {
    const marker = await readMarker(this.#o.stateDir).catch(() => undefined);
    if (marker !== undefined && marker.paused.length > 0 && !(await this.#o.server.answers())) {
      await writeMarker(this.#o.stateDir, { ...marker, phase: 'draining' });
      this.#print(`sf serve does not answer: the updating marker stays (draining) with the jobs the update paused, and the next sf serve resumes them: ${marker.paused.map(refText).join(', ')}`);
      return false;
    }
    if (marker === undefined && updateMarked(this.#o.stateDir)) {
      this.#print('Removed the unreadable updating marker.');
    }
    return this.#resumeJobs(await takeMarkerJobs(this.#o.stateDir));
  }

  // Resumes the jobs (the marker is gone already); true when every one was resumed.
  async #resumeJobs(jobs: JobRef[]): Promise<boolean> {
    if (jobs.length === 0) {
      return true;
    }
    if (!(await this.#o.server.answers())) {
      this.#print(`sf serve does not answer: these jobs stay paused; sf resume each once it runs: ${jobs.map(refText).join(', ')}`);
      return false;
    }
    let all = true;
    for (const ref of jobs) {
      const response = await this.#o.server.request('resume', [ref.workspace, ref.ticket]).catch((error: unknown): IpcResponse => ({
        ok: false, error: { code: 'serve_not_running', message: error instanceof Error ? error.message : String(error) },
      }));
      if (response.ok) {
        this.#print(`resumed ${refText(ref)}`);
      } else {
        all = false;
        this.#print(`${refText(ref)} was not resumed: ${response.error.code}: ${response.error.message}`);
      }
    }
    return all;
  }

  async #writeMarker(): Promise<void> {
    await writeMarker(this.#o.stateDir, this.#marker!);
  }

  async #setPhase(phase: UpdatePhase): Promise<void> {
    this.#marker = { ...this.#marker!, phase };
    await this.#writeMarker();
  }

  // The live runners of the jobs (runner.pid, as the pid lock checks it).
  async #liveRunners(jobs: Job[]): Promise<Job[]> {
    const live: Job[] = [];
    for (const job of jobs) {
      if ((await liveOwner(lockPath(this.#jobs.dir(job.workspace, job.ticket)))) !== undefined) {
        live.push(job);
      }
    }
    return live;
  }

  // No sf serve answers: the runners may still run (they are detached).
  async #direct(start: string): Promise<number> {
    const refuseRunning = async (): Promise<void> => {
      const running = await this.#liveRunners((await this.#jobs.list()).filter((job) => !TERMINAL_STATES.includes(job.state)));
      if (running.length > 0) {
        throw new FactoryError('jobs_running', `jobs_running: sf serve is not running, but these jobs' runners are: ${running.map((job) => `${refText(job)} (${job.state})`).join(', ')}; start sf serve and run sf update again.`);
      }
    };
    await refuseRunning();
    this.#marker = newMarker('building', start);
    await this.#writeMarker();
    try {
      await refuseRunning();
    } catch (error) {
      await removeMarker(this.#o.stateDir);
      throw error;
    }
    if (!(await this.#build(start))) {
      return 1;
    }
    if (await this.#o.service.installed()) {
      await this.#setPhase('restart_pending');
      this.#print(`Restarting the service: systemctl --user restart ${SERVICE_NAME}`);
      await this.#serviceStep(() => this.#o.service.restart());
      return this.#afterRestart();
    }
    await removeMarker(this.#o.stateDir);
    this.#print('The install is updated. Start sf serve (the service is not installed: sf service install, or sf serve by hand).');
    return 0;
  }

  // The drain, the build and the restart with a running sf serve.
  async #withServer(start: string): Promise<number> {
    this.#marker = newMarker('draining', start);
    await this.#writeMarker();
    this.#print('Draining: sf serve refuses changes now; pausing the running jobs.');
    const deadline = Date.now() + (this.#o.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
    try {
      await this.#drain(deadline);
    } catch (error) {
      if (!(error instanceof DrainTimeout)) {
        // A failure of the drain itself: nothing was pulled; the jobs it paused go on.
        await this.#giveUp([`the drain failed: ${error instanceof Error ? error.message : String(error)}`]);
        throw error;
      }
      await this.#giveUp(error.unsettled);
      throw new FactoryError('drain_timeout', `drain_timeout: these did not settle within ${Math.round((this.#o.drainTimeoutMs ?? DRAIN_TIMEOUT_MS) / 1000)} s: ${error.unsettled.join('; ')}. Nothing was pulled; the jobs the update paused are resumed.`);
    }
    if (!(await this.#build(start))) {
      return 1;
    }
    return this.#restart();
  }

  // Gives up without pulling: names what did not settle, removes the marker, resumes the jobs.
  async #giveUp(unsettled: string[]): Promise<void> {
    for (const line of unsettled) {
      this.#print(`did not settle: ${line}`);
    }
    await this.#handBack();
  }

  async #busy(): Promise<Busy> {
    const response = await this.#o.server.request('serve-busy', []);
    if (!response.ok) {
      throw new FactoryError(response.error.code, response.error.message);
    }
    const result = response.result as Partial<Busy>;
    return { checks: result.checks ?? [], handovers: result.handovers ?? [] };
  }

  // Waits until probe finds nothing unsettled; DrainTimeout with what it found last at the deadline.
  async #until(deadline: number, probe: () => Promise<string[]>): Promise<void> {
    for (;;) {
      const unsettled = await probe();
      if (unsettled.length === 0) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new DrainTimeout(unsettled);
      }
      await sleep(this.#poll);
    }
  }

  // The drain (checks and hand-overs, pauses, idle jobs, no runner), then the last check before
  // the pull, from the pauses again while it finds work.
  async #drain(deadline: number): Promise<void> {
    // 2. No Task check and no hand-over runs inside sf serve.
    await this.#until(deadline, async () => {
      const busy = await this.#busy();
      return [...busy.checks.map((check) => `the Task check of ${refText(check)}`), ...busy.handovers.map((step) => `the ${step.step} of ${refText(step)}`)];
    });
    for (;;) {
      // 3-4. Every job idle, pausing any that is pausable.
      await this.#until(deadline, async () => {
        for (const job of await this.#jobs.list()) {
          if (PAUSABLE.includes(job.state)) {
            await this.#pause(job);
          }
        }
        const busy = await this.#busy();
        const unsettled: string[] = [];
        for (const job of await this.#jobs.list()) {
          if (!IDLE_STATES.includes(job.state)) {
            unsettled.push(`${refText(job)} (${job.state})`);
            continue;
          }
          const step = job.handover?.step ?? null;
          if (step !== null && ((await this.#liveRunners([job])).length > 0 || busy.handovers.some((other) => sameRef(other, job)))) {
            unsettled.push(`${refText(job)} (hand-over step ${step})`);
          }
        }
        return unsettled;
      });
      // 5. No runner left: a resumed job runs the new code in a new runner.
      await this.#until(deadline, async () => (await this.#liveRunners(await this.#jobs.list())).map((job) => `the runner of ${refText(job)} (${job.state})`));
      // Once more right before the pull; work already past a gate goes back to the pauses.
      const jobs = await this.#jobs.list();
      const busyJobs = jobs.filter((job) => BUSY_STATES.includes(job.state));
      if (busyJobs.length === 0 && (await this.#liveRunners(jobs)).length === 0) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new DrainTimeout(busyJobs.map((job) => `${refText(job)} (${job.state})`));
      }
    }
  }

  // One pause, recorded in the marker before it is sent; the job read again after it.
  async #pause(job: Job): Promise<void> {
    const ref = { workspace: job.workspace, ticket: job.ticket };
    const drop = async (): Promise<void> => {
      this.#marker = { ...this.#marker!, paused: this.#marker!.paused.filter((other) => !sameRef(other, ref)) };
      await this.#writeMarker();
    };
    if (!this.#marker!.paused.some((other) => sameRef(other, ref))) {
      this.#marker = { ...this.#marker!, paused: [...this.#marker!.paused, ref] };
      await this.#writeMarker();
    }
    const response = await this.#o.server.request('pause', [job.workspace, job.ticket]).catch((error: unknown): IpcResponse => ({
      ok: false, error: { code: 'pause_failed', message: error instanceof Error ? error.message : String(error) },
    }));
    const after = await this.#jobs.read(job.workspace, job.ticket);
    if (after?.state === 'paused' && (response.ok || response.error.code !== 'invalid_state')) {
      if (response.ok) {
        this.#print(`paused ${refText(ref)} (it was ${job.state})`);
      }
      return;
    }
    await drop();
    // The job moved meanwhile: classified again in the next round.
    if (!response.ok && response.error.code === 'invalid_state') {
      return;
    }
    if (after === undefined) {
      this.#print(`${refText(ref)}: not paused by the update; its job is gone`);
      return;
    }
    if (after.state === 'needs_human' && after.error?.code === 'mr_interrupted') {
      this.#print(`${refText(ref)}: not paused by the update: the pause cut off the start of its MR preparation, so it is needs_human (mr_interrupted); sf say goes on with it`);
      return;
    }
    this.#print(`${refText(ref)}: not paused by the update; it is ${after.state}${response.ok ? '' : ` (${response.error.code}: ${response.error.message})`}`);
  }

  async #log(text: string): Promise<void> {
    await appendFile(join(this.#o.stateDir, UPDATE_LOG_FILE), text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
  }

  async #logTail(lines = 20): Promise<string> {
    const text = await readFile(join(this.#o.stateDir, UPDATE_LOG_FILE), 'utf8').catch(() => '');
    return text.trimEnd().split('\n').slice(-lines).join('\n');
  }

  // One step of the build, its output in update.log; true when it succeeded.
  async #step(name: string, work: () => Promise<CommandResult>): Promise<boolean> {
    await this.#log(`\n$ ${name}`);
    const result = await work().catch((error: unknown): CommandResult => ({ code: null, output: error instanceof Error ? error.message : String(error) }));
    await this.#log(result.output);
    await this.#log(`[${name}: exit ${result.code ?? 'none'}]`);
    if (result.code !== 0) {
      this.#print(`${name} failed`);
      return false;
    }
    this.#print(`${name}: ok`);
    return true;
  }

  async #gitStep(args: string[]): Promise<CommandResult> {
    const result = await runGit(this.#o.install, args);
    return { code: result.code, output: `${result.stdout.toString('utf8')}${result.stderr}` };
  }

  // Building: true after a good build. A failed step rolls back and resumes, then throws
  // update_failed; a failed rollback leaves rollback_failed and throws it.
  async #build(start: string): Promise<boolean> {
    await this.#setPhase('building');
    const logPath = join(this.#o.stateDir, UPDATE_LOG_FILE);
    await writeFile(logPath, `sf update ${now()} from ${start} in ${this.#o.install}\n`, { mode: 0o600 });
    const pkg = join(this.#o.install, this.#o.packageDir);
    const lockFile = `${this.#o.packageDir === '' ? '' : `${this.#o.packageDir}/`}package-lock.json`;
    let lockChanged = false;
    let ok = await this.#step('git pull --ff-only origin main', () => this.#gitStep(['pull', '--ff-only', '--quiet', 'origin', 'main']));
    if (ok) {
      lockChanged = (await runGit(this.#o.install, ['diff', '--quiet', start, 'HEAD', '--', lockFile])).code !== 0;
      const rest: Array<[string, string[]]> = [...(lockChanged ? [['npm ci', ['ci']] as [string, string[]]] : []), ['npm run build', ['run', 'build']], ['npm run typecheck', ['run', 'typecheck']]];
      for (const [name, args] of rest) {
        if (!(await this.#step(name, () => this.#o.npm(args, pkg)))) {
          ok = false;
          break;
        }
      }
    }
    if (ok) {
      const head = (await this.#git(['rev-parse', 'HEAD'])).out;
      this.#print(`Built ${head.slice(0, 12)} (${lockChanged ? 'with npm ci: the lockfile changed' : 'the lockfile did not change'}).`);
      return true;
    }
    const tail = await this.#logTail();
    this.#print(`The update failed; rolling back to ${start.slice(0, 12)}.`);
    // The tree was clean (checked before the drain), so the reset loses nothing.
    const back = await this.#step(`git reset --hard ${start.slice(0, 12)}`, () => this.#gitStep(['reset', '--hard', '--quiet', start]))
      && (!lockChanged || (await this.#step('npm ci', () => this.#o.npm(['ci'], pkg))))
      && (await this.#step('npm run build', () => this.#o.npm(['run', 'build'], pkg)));
    if (!back) {
      await this.#setPhase('rollback_failed');
      throw new FactoryError(
        'rollback_failed',
        `rollback_failed: the update failed and so did the rollback to ${start}: the install may not run. The updating marker stays (rollback_failed) and sf serve refuses changes; fix the install by hand (update.log in the state directory), then sf update --abandon.\n${await this.#logTail()}`,
      );
    }
    this.#print(`Rolled back to ${start.slice(0, 12)} and rebuilt; resuming the jobs the update paused on the old code.`);
    await this.#handBack();
    throw new FactoryError('update_failed', `update_failed: a step of the update failed; the install is back at ${start.slice(0, 12)}. See update.log in the state directory; its last lines:\n${tail}`);
  }

  // After a good build with a running sf serve: the restart.
  async #restart(): Promise<number> {
    await this.#setPhase('restart_pending');
    const service = this.#o.service;
    if (await service.installed()) {
      if (await service.active()) {
        this.#print(`Restarting the service: systemctl --user restart ${SERVICE_NAME}`);
        await this.#serviceStep(() => service.restart());
        return this.#afterRestart();
      }
      if (!(await this.#o.server.answers())) {
        this.#print(`Starting the service: systemctl --user start ${SERVICE_NAME}`);
        await this.#serviceStep(() => service.start());
        return this.#afterRestart();
      }
    }
    this.#print('The install is built. Restart sf serve now (it was started by hand): the new one finishes the update and resumes the jobs the update paused. Until then sf serve refuses changes.');
    return 0;
  }

  // systemctl restart or start; a failure is serve_not_started, the marker left in restart_pending.
  async #serviceStep(step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      throw new FactoryError(
        'serve_not_started',
        `serve_not_started: ${error instanceof Error ? error.message : String(error)}. The smoke was skipped and the marker stays (restart_pending): the first sf serve that starts resumes the paused jobs. See ${JOURNAL_HINT}.`,
      );
    }
  }

  // Waits for the new sf serve, then the smoke.
  async #afterRestart(): Promise<number> {
    const deadline = Date.now() + (this.#o.serveStartMs ?? SERVE_START_TIMEOUT_MS);
    while (!(await this.#o.server.answers())) {
      if (Date.now() >= deadline) {
        throw new FactoryError(
          'serve_not_started',
          `serve_not_started: the new sf serve did not answer within ${Math.round((this.#o.serveStartMs ?? SERVE_START_TIMEOUT_MS) / 1000)} s; the smoke was skipped and the marker stays (restart_pending): the first sf serve that starts resumes the paused jobs. See ${JOURNAL_HINT}.`,
        );
      }
      await sleep(this.#poll);
    }
    this.#print('sf serve answers on the new code.');
    if (!this.#o.smoke) {
      this.#print('smoke: skipped (--no-smoke)');
      return 0;
    }
    const passed = await this.#o.runSmoke();
    this.#print(`smoke: ${passed ? 'PASS' : 'FAIL (nothing is rolled back)'}`);
    return passed ? 0 : 1;
  }
}

// The default npm: npm with stdout and stderr together.
export function runCommand(file: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.once('error', (error) => resolve({ code: null, output: `${output}${error.message}` }));
    child.once('close', (code) => resolve({ code, output }));
  });
}
