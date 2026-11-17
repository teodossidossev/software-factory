// The job's runner: `sf run <workspace> <ticket>`, one detached process per job that runs
// the job's Implementer turns, its reviews and its gate and writes its state, so a restart of
// sf serve leaves a working job alone. One runner per job, guarded by runner.pid in the job
// directory (src/pid-lock.ts). sf serve talks to it only through files: each request is a JSON
// file in queue/ (taken oldest first), the runner's answer to it a file of the same name in
// replies/; abort, pause, restart and reset stop it with SIGTERM. The runner exits when
// nothing is left to run: the job waits for a person or has ended. Its output goes to runner.log in the job directory.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, type FSWatcher, mkdirSync, openSync, watch } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic.js';
import type { ImageRef } from './attachments.js';
import { FactoryError } from './errors.js';
import { internalError } from './http.js';
import type { Job, JobState, JobStore } from './jobs.js';
import type { Decision } from './ledger.js';
import { isAlive, liveOwner, staleOwner, tryLock } from './pid-lock.js';

// What sf serve asks of a job's runner. turn: the first turn of a started job (its prompt, and the
// image blocks that go with it), sent without a reply being awaited; the others are the
// user's and the reviewers' requests.
export type RunnerRequest =
  | { kind: 'turn'; prompt: string; images?: ImageRef[] }
  | { kind: 'say'; message: string }
  | { kind: 'fix'; content: string }
  | { kind: 'clean'; sensitive: string[] }
  | { kind: 'review' }
  | { kind: 'accept' }
  // The user's settlement of a ledger entry.
  | { kind: 'settle'; id: string; decision: Decision; note: string }
  // The user's Simplify on the offer of the simplification pass.
  | { kind: 'simplify' }
  // The user's Resume of a paused job, with the message for the Implementer ('' for none).
  | { kind: 'resume'; message: string }
  // The user's Retry of a transient MR preparation failure: MR preparation runs again,
  // without a new review.
  | { kind: 'retry' }
  // The pass of merged jobs (and Merged — archive): the move of a part onto its base once the
  // ticket it builds on is merged (MrPart.moveInRunner).
  | { kind: 'move' };

export type RunnerReply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

// How long sf serve waits for the runner's reply to a request; how long a stopped runner has to end
// before it is killed.
const REPLY_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 15_000;
const POLL_MS = 50;
const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The job's runner lock: the pid (and start time) of its runner.
export function lockPath(jobDir: string): string {
  return join(jobDir, 'runner.pid');
}

// sf serve's requests to the job's runner, and the runner's replies.
const queueDir = (jobDir: string): string => join(jobDir, 'queue');
const repliesDir = (jobDir: string): string => join(jobDir, 'replies');

let sequence = 0;

// Queues a request and returns its id; the names sort in the order the requests were queued. The
// job directory must exist (job_not_found otherwise: a reset may have archived it).
export async function enqueue(jobDir: string, request: RunnerRequest): Promise<string> {
  sequence += 1;
  const id = `${String(Date.now()).padStart(15, '0')}-${String(sequence).padStart(9, '0')}-${randomUUID().slice(0, 8)}`;
  try {
    await mkdir(queueDir(jobDir), { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new FactoryError('job_not_found', 'The job directory is gone; the job was reset.');
    }
    if (code !== 'EEXIST') {
      throw error;
    }
  }
  await writeFileAtomic(join(queueDir(jobDir), `${id}.json`), Buffer.from(JSON.stringify(request)));
  return id;
}

// The ids of the queued requests, oldest first (the temp files of a write in progress start with
// a dot and are skipped).
async function queued(jobDir: string): Promise<string[]> {
  try {
    return (await readdir(queueDir(jobDir)))
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// Whether a request waits in the job's queue.
export async function hasRequests(jobDir: string): Promise<boolean> {
  return (await queued(jobDir)).length > 0;
}

// Takes the oldest request off the queue; an unreadable one is answered with an error and skipped.
export async function takeRequest(jobDir: string): Promise<{ id: string; request: RunnerRequest } | undefined> {
  for (const id of await queued(jobDir)) {
    const path = join(queueDir(jobDir), `${id}.json`);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    await rm(path, { force: true });
    try {
      return { id, request: JSON.parse(text) as RunnerRequest };
    } catch { // not JSON: answered with bad_request
      await writeReply(jobDir, id, { ok: false, error: { code: 'bad_request', message: 'The request file is not valid JSON.' } });
    }
  }
  return undefined;
}

// The runner's answer to the request id.
export async function writeReply(jobDir: string, id: string, reply: RunnerReply): Promise<void> {
  await mkdir(repliesDir(jobDir), { recursive: true, mode: 0o700 });
  await writeFileAtomic(join(repliesDir(jobDir), `${id}.json`), Buffer.from(JSON.stringify(reply)));
}

// The reply to a request, removed once read; undefined while there is none.
async function takeReply(jobDir: string, id: string): Promise<RunnerReply | undefined> {
  const path = join(repliesDir(jobDir), `${id}.json`);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  await rm(path, { force: true });
  return JSON.parse(text) as RunnerReply;
}

// Starts `sf run <workspace> <ticket>` detached from sf serve (its own session, so neither a
// Ctrl+C nor the end of sf serve reaches it), its output appended to log.
export type Launch = (workspace: string, ticket: string, log: string) => ChildProcess;

// The runner gets env (sf serve's environment by default, with the settings of auth.env).
export function runnerLauncher(env: NodeJS.ProcessEnv = process.env): Launch {
  return (workspace, ticket, log) => launch(workspace, ticket, log, env);
}

function launch(workspace: string, ticket: string, log: string, env: NodeJS.ProcessEnv): ChildProcess {
  const out = openSync(log, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [CLI, 'run', workspace, ticket], { detached: true, stdio: ['ignore', out, out], env });
    child.on('error', (error) => console.error(`${workspace}/${ticket}: the runner could not start: ${error.message}`));
    child.unref();
    return child;
  } finally {
    closeSync(out);
  }
}

// Whether a child this process started is still running (a failed spawn has no pid).
const childRunning = (child: ChildProcess | undefined): boolean => child?.pid !== undefined && child.exitCode === null && child.signalCode === null;

// How often sf serve starts a runner again for one request that no runner took.
const MAX_LAUNCHES = 3;

// sf serve's side of the runners: starts one when a job needs it, queues requests for it and waits
// for the replies, and stops it.
export class Runners {
  readonly #jobs: JobStore;
  readonly #launch: Launch;
  // The runner this process started last for each job, by "<workspace>/<ticket>"; it may not hold
  // the lock yet.
  readonly #spawned = new Map<string, ChildProcess>();

  constructor(jobs: JobStore, launch: Launch = runnerLauncher()) {
    this.#jobs = jobs;
    this.#launch = launch;
  }

  // The pid of the job's live runner, the one holding the lock.
  owner(workspace: string, ticket: string): Promise<number | undefined> {
    return liveOwner(lockPath(this.#jobs.dir(workspace, ticket)));
  }

  async #running(workspace: string, ticket: string): Promise<boolean> {
    return childRunning(this.#spawned.get(`${workspace}/${ticket}`)) || (await this.owner(workspace, ticket)) !== undefined;
  }

  // A runner that ended without releasing its lock (killed, crashed): what it started and left
  // behind (its process group: Claude Code, Codex) ends, and the lock goes.
  async #reap(dir: string): Promise<void> {
    const stale = await staleOwner(lockPath(dir));
    if (stale !== undefined) {
      // A pid now in use again names another process; the kernel does not hand out a pid still used
      // as a group id, so its group is not the runner's.
      if (!isAlive(stale)) {
        await endGroups([stale]);
      }
      await rm(lockPath(dir), { force: true });
    }
  }

  // Whether the job is left to sf serve: its runner, if one runs, has ended within timeoutMs (a
  // runner exits once the job waits for a person) and no request waits for one.
  async settled(workspace: string, ticket: string, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (await this.#running(workspace, ticket)) {
      if (Date.now() > deadline) {
        return false;
      }
      await sleep(POLL_MS);
    }
    return !(await hasRequests(this.#jobs.dir(workspace, ticket)));
  }

  // Starts a runner for the job unless one runs or is starting; true when it started one.
  async ensure(workspace: string, ticket: string): Promise<boolean> {
    if (await this.#running(workspace, ticket)) {
      return false;
    }
    const dir = this.#jobs.dir(workspace, ticket);
    await this.#reap(dir);
    this.#spawned.set(`${workspace}/${ticket}`, this.#launch(workspace, ticket, join(dir, 'runner.log')));
    return true;
  }

  // Queues a request for the job's runner and starts one when none runs; returns the request's id.
  async queue(workspace: string, ticket: string, request: RunnerRequest): Promise<string> {
    const id = await enqueue(this.#jobs.dir(workspace, ticket), request);
    await this.ensure(workspace, ticket);
    return id;
  }

  // The runner's reply to a queued request: its result, or its refusal thrown. A request that no
  // runner takes after MAX_LAUNCHES starts, or that a runner took and ended without answering, is
  // runner_failed; no reply within REPLY_TIMEOUT_MS is runner_timeout.
  async reply(workspace: string, ticket: string, id: string): Promise<unknown> {
    const dir = this.#jobs.dir(workspace, ticket);
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    let launches = 1;
    const failed = (what: string): FactoryError =>
      new FactoryError('runner_failed', `The runner of ${workspace}/${ticket} ${what}; see runner.log in the job directory.`);
    for (;;) {
      const reply = await takeReply(dir, id);
      if (reply !== undefined) {
        if (reply.ok) {
          return reply.result;
        }
        throw new FactoryError(reply.error.code, reply.error.message);
      }
      if (!(await this.#running(workspace, ticket))) {
        if ((await queued(dir)).includes(id)) {
          // The runner ended before it took the request (it had found nothing else to do, or failed).
          if (launches >= MAX_LAUNCHES) {
            await rm(join(queueDir(dir), `${id}.json`), { force: true });
            throw failed(`ended ${launches} times without taking the request`);
          }
          launches += 1;
          await this.ensure(workspace, ticket);
        } else if ((await takeReply(dir, id)) === undefined) {
          throw failed('ended without answering');
        }
      }
      if (Date.now() > deadline) {
        throw new FactoryError('runner_timeout', `The runner of ${workspace}/${ticket} did not answer within ${REPLY_TIMEOUT_MS / 1000} s; the request may still run.`);
      }
      await sleep(POLL_MS);
    }
  }

  // Stops the job's runner (SIGTERM; SIGKILL after STOP_TIMEOUT_MS) and drops the requests it did
  // not take: first, so a runner letting go of the job finds none to take it again for. Resolves
  // once it and its process group have ended.
  async stop(workspace: string, ticket: string): Promise<void> {
    const key = `${workspace}/${ticket}`;
    const dir = this.#jobs.dir(workspace, ticket);
    await rm(queueDir(dir), { recursive: true, force: true });
    const child = this.#spawned.get(key);
    const pids = new Set<number>();
    const owner = await this.owner(workspace, ticket);
    if (owner !== undefined) {
      pids.add(owner);
    }
    if (childRunning(child) && child!.pid !== undefined) {
      pids.add(child!.pid);
    }
    // Our own child is alive until it has exited (a zombie still answers kill 0).
    const alive = (pid: number): boolean => (child?.pid === pid ? childRunning(child) : isAlive(pid));
    const ended = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while ([...pids].some(alive)) {
        if (Date.now() > deadline) {
          return false;
        }
        await sleep(POLL_MS);
      }
      return true;
    };
    signalAll([...pids], 'SIGTERM');
    if (!(await ended(STOP_TIMEOUT_MS))) {
      signalAll([...pids], 'SIGKILL');
      await ended(2_000);
    }
    // The runner leads its own process group (detached): what it started and left behind (Claude
    // Code within the SDK's grace period after the turn was aborted, Codex) ends with the group.
    await endGroups([...pids]);
    this.#spawned.delete(key);
    await this.#reap(dir);
    await rm(queueDir(dir), { recursive: true, force: true });
    await rm(repliesDir(dir), { recursive: true, force: true });
  }
}

// Sends the signal to each pid (a negative one: its process group); one already gone is skipped.
function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch { // the process is already gone
    }
  }
}

// Whether any process of the group led by pid is left.
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Ends what is left of the process groups (SIGTERM, SIGKILL after 2 s).
async function endGroups(pids: number[]): Promise<void> {
  const groups = (): number[] => pids.filter(groupAlive).map((pid) => -pid);
  signalAll(groups(), 'SIGTERM');
  const deadline = Date.now() + 2_000;
  while (groups().length > 0) {
    if (Date.now() > deadline) {
      signalAll(groups(), 'SIGKILL');
      return;
    }
    await sleep(POLL_MS);
  }
}

// What the runner drives: the Execution of one job in runner mode.
export interface RunnerWork {
  // Applies one request; its result or refusal is the reply.
  apply(request: RunnerRequest): Promise<unknown>;
  // Picks up what the job was doing when its last runner ended (a review or gate to run).
  resume(): Promise<void>;
  // Nothing runs: no turn, no review or gate, no state change in progress.
  readonly idle: boolean;
  // Ends the turn, the review and the gate without applying their outcome.
  stop(): Promise<void>;
}

export interface RunOptions {
  // Awaited before the runner releases the job: the notifications sent so far.
  settle?: () => Promise<void>;
  pollMs?: number;
}

// The runner's loop: takes the lock (runner_running when another runner holds it), applies the
// queued requests in order, resumes the job, and returns when nothing runs and nothing is queued.
// A request queued while it releases the lock is taken by taking the lock again. SIGTERM (and
// SIGINT) stop the work and end the loop without applying any outcome.
export async function runJob(jobDir: string, work: RunnerWork, options: RunOptions = {}): Promise<void> {
  const pollMs = options.pollMs ?? 100;
  const first = await tryLock(lockPath(jobDir));
  if ('owner' in first) {
    throw new FactoryError('runner_running', `The job already has a runner (pid ${first.owner}).`);
  }
  let held: typeof first.held | undefined = first.held;
  let stopped: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  const onSignal = (): void => {
    stopped ??= work.stop();
    wake?.();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    let resumed = false;
    for (;;) {
      while (stopped === undefined) {
        const next = await takeRequest(jobDir);
        if (next !== undefined) {
          let reply: RunnerReply;
          try {
            reply = { ok: true, result: (await work.apply(next.request)) ?? {} };
          } catch (error) {
            if (!(error instanceof FactoryError)) {
              console.error(error);
            }
            reply = { ok: false, error: error instanceof FactoryError ? { code: error.code, message: error.message } : internalError('The request failed inside the runner.') };
          }
          await writeReply(jobDir, next.id, reply);
          continue;
        }
        if (!resumed) {
          resumed = true;
          await work.resume();
          continue;
        }
        if (work.idle) {
          break;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, pollMs);
        });
        wake = undefined;
      }
      if (stopped !== undefined) {
        await stopped;
        break;
      }
      await options.settle?.();
      await held.release();
      held = undefined;
      // sf serve queues first and looks for a runner second: a request it queued after this runner
      // last looked is seen here.
      if (!(await hasRequests(jobDir))) {
        break;
      }
      const again = await tryLock(lockPath(jobDir));
      if ('owner' in again) {
        break;
      }
      held = again.held;
    }
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    await options.settle?.();
    await held?.release();
  }
}

// sf serve's view of the state the runners write: the jobs whose job.json changed since the last
// look go to the listener with their previous state. A look follows each change under the jobs
// directory to a job.json or an events.jsonl (fs.watch; every state change appends its line to
// events.jsonl after job.json is written, so the look after it sees the new state), at most every
// 100 ms, and runs every interval regardless.
export function followJobs(jobs: JobStore, listener: (job: Job, from: JobState | null) => void, intervalMs = 1_000): { close(): void } {
  const seen = new Map<string, { text: string; state: JobState }>();
  let first = true;
  let busy = false;
  let again = false;
  let closed = false;
  const look = async (): Promise<void> => {
    for (const job of await jobs.list()) {
      const key = `${job.workspace}/${job.ticket}`;
      const text = JSON.stringify(job);
      const before = seen.get(key);
      if (before?.text === text) {
        continue;
      }
      seen.set(key, { text, state: job.state });
      if (!first) {
        listener(job, before?.state ?? null);
      }
    }
    first = false;
  };
  const tick = (): void => {
    if (closed) {
      return;
    }
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    // An unreadable job.json is shown by the dashboard itself; the next look tries again.
    look().catch(() => undefined).finally(() => {
      setTimeout(() => {
        busy = false;
        if (again) {
          again = false;
          tick();
        }
      }, 100).unref();
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  let watcher: FSWatcher | undefined;
  try {
    mkdirSync(jobs.root, { recursive: true, mode: 0o700 });
    watcher = watch(jobs.root, { recursive: true }, (_event, name) => {
      if (name === null || ['job.json', 'events.jsonl'].includes(basename(name))) {
        tick();
      }
    });
    watcher.on('error', () => watcher?.close());
    watcher.unref();
  } catch { // no fs.watch here: the interval alone follows the jobs
  }
  tick();
  return {
    close: () => {
      closed = true;
      clearInterval(timer);
      watcher?.close();
    },
  };
}
