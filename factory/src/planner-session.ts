// The planner session of a ticket: sf planner start|stop <workspace> <ticket> and the calls behind
// them, and sf planner trust <workspace>, the copy's one-time trust dialog. Claude Code with
// Remote Control runs in the workspace's planning copy, in a terminal of its own (script), detached so that it outlives its starter and a restart of sf serve; one runs per
// ticket, recorded in <state dir>/planner/<workspace>/<ticket>.json; its claude.ai link is recorded
// by the copy's hook (sf planner waiting) when the session first waits for the user.
// Start takes the ticket's lock and answers with the session that runs, if any; else it checks, in
// this order, the workspace, the copy set up (.claude/planning-copy.md), none of the repository's
// Claude Code configuration in the copy's working tree, and the copy's own entry trusted in Claude
// Code's global config (read, never written), before it spawns anything. An untrusted copy is
// refused with SF_PLANNER_TRUST=ask (the default: the user runs sf planner trust); with auto, start
// first answers Claude Code's trust dialog for the copy itself (acceptTrustDialog), under the lock,
// and refuses only when that fails. It never refreshes the copy. A session whose record cannot be
// written is ended before the lock is released.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { checkJob, checkName, UsageError } from './commands.js';
import { planningDir, plannerTrustSetting } from './config.js';
import { FactoryError } from './errors.js';
import { localTime } from './local-time.js';
import { type HeldLock, ownerAlive, startTime, tryLock } from './pid-lock.js';
import { resolveWorkspace } from './registry.js';
import { repositoryConfigIn } from './repository-config.js';
import { claudeUserSettings } from './sandbox-denials.js';
import { COPIED_SETTINGS, runCommand } from './service.js';
import { sessionEnvironment } from './session.js';
import { TICKET_PATTERN } from './task-file.js';

export const START_CHECK_MS = 3_000;   // how long start watches a new session
export const STOP_GRACE_MS = 10_000;   // how long stop waits after SIGTERM
export const TRUST_DIALOG_MS = 30_000; // from the trust run's spawn to the saved answer

export interface SessionDeps {
  env: NodeJS.ProcessEnv;   // SF_PLANNING_DIR, HOME, CLAUDE_CONFIG_DIR, and what the session's environment keeps
  stateDir: string;         // config.ts stateDir(env)
  configDir: string;        // registry.ts configDir(env)
}

export interface PlannerSession {
  workspace: string;
  ticket: string;
  name: string;         // the session's name in Claude Code
  id: string;           // this start's id, also the session's SF_PLANNER_ID
  pid: number;          // the pid of script, the session's terminal
  pid_start?: string;   // its start time (pid-lock.ts startTime), so a reused pid is not taken for it
  started_at: string;   // ISO 8601
  link?: string;        // https://claude.ai/code/<id>, once the session's hook recorded it
}

// A Claude Code session id the link may hold.
const BRIDGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
// The Anthropic and Claude Code variables the session does not get (a key or token of the factory's
// own sessions would replace the user's claude.ai login), but where that login is; and the cloud
// credentials, which a claude.ai session does not use.
const LEFT_OUT = /^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|CLOUD_ML_)/;
const POLL_MS = 100;
const KILL_WAIT_MS = 2_000;
// How long stop waits for the ticket's lock beyond a start's watch (its checks and the spawn).
const LOCK_WAIT_MORE_MS = 10_000;
// The trust run: how long after the dialog showed Down is sent, how much output the match reads,
// how long after Down Claude Code has to write its selection mark again, and the keys.
const TRUST_SETTLE_MS = 500;
const TRUST_OUTPUT_CHARS = 64 * 1024;
const TRUST_MARK_MS = 2_000;
const DOWN = '\x1b[B';
const MARK = '❯';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function sessionFile(stateDir: string, workspace: string, ticket: string): string {
  return join(stateDir, 'planner', workspace, `${ticket}.json`);
}

// The ticket's lock: the record's path with .lock for .json.
const lockFile = (file: string): string => file.replace(/\.json$/, '.lock');

// text in single quotes for the shell, a ' inside written as '\''.
const word = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

// The session's name in Claude Code.
const sessionName = (workspace: string, ticket: string): string => `Planner ${workspace} ${ticket}`;

// The command line script runs: fixed text and validated names only.
function commandLine(workspace: string, ticket: string): string {
  return `exec claude --remote-control ${word(sessionName(workspace, ticket))} ${word(`/planning-tasks workspace ${workspace}, ticket ${ticket}`)}`;
}

// The environment of any Claude Code the planner commands open in the copy: sessionEnvironment's
// without the Anthropic, Claude Code and cloud variables (CLAUDE_CONFIG_DIR kept), and the
// directory settings the hook needs to find this factory's state.
function baseEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(sessionEnvironment(env))) {
    if (name === 'CLAUDE_CONFIG_DIR' || !LEFT_OUT.test(name)) {
      result[name] = value;
    }
  }
  for (const name of COPIED_SETTINGS) {
    const value = env[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

// The session's environment: the base environment, a fixed TERM (the terminal is script's) and the
// hook's two markers.
function plannerEnvironment(env: NodeJS.ProcessEnv, ticket: string, id: string): Record<string, string> {
  return { ...baseEnvironment(env), TERM: 'xterm-256color', SF_PLANNER_TICKET: ticket, SF_PLANNER_ID: id };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The record at file: 'missing' when there is no file, undefined when the file is no record.
async function readRecord(file: string, workspace: string, ticket: string): Promise<PlannerSession | 'missing' | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch { // not JSON: no record
    return undefined;
  }
  if (!isObject(data) || typeof data.id !== 'string' || typeof data.started_at !== 'string' || !Number.isInteger(data.pid) || (data.pid as number) <= 0) {
    return undefined;
  }
  return {
    workspace,
    ticket,
    name: typeof data.name === 'string' ? data.name : sessionName(workspace, ticket),
    id: data.id,
    pid: data.pid as number,
    pid_start: typeof data.pid_start === 'string' ? data.pid_start : undefined,
    started_at: data.started_at,
    link: typeof data.link === 'string' ? data.link : undefined,
  };
}

// The record, its keys in the order of PlannerSession (undefined ones left out).
function writeRecord(file: string, session: PlannerSession): Promise<void> {
  const { workspace, ticket, name, id, pid, pid_start, started_at, link } = session;
  return writeFileAtomic(file, Buffer.from(`${JSON.stringify({ workspace, ticket, name, id, pid, pid_start, started_at, link }, null, 2)}\n`), 0o600);
}

// A session's process, or the trust run's script.
type ProcessRef = Pick<PlannerSession, 'pid' | 'pid_start'>;

const alive = (session: ProcessRef): boolean => ownerAlive({ pid: session.pid, start: session.pid_start });

// The ticket's record while its process lives. A file that is no live record is removed: at once
// with locked (the caller holds the ticket's lock), else only when one try takes the lock and the
// file read again under it is still no live record. A missing file takes no lock and makes no folder.
async function liveSession(workspace: string, ticket: string, stateDir: string, locked: boolean): Promise<PlannerSession | undefined> {
  const file = sessionFile(stateDir, workspace, ticket);
  const found = await readRecord(file, workspace, ticket);
  if (found === 'missing') {
    return undefined;
  }
  if (found !== undefined && alive(found)) {
    return found;
  }
  if (locked) {
    await rm(file, { force: true });
    return undefined;
  }
  const taken = await tryLock(lockFile(file));
  if ('held' in taken) {
    try {
      const again = await readRecord(file, workspace, ticket);
      if (again !== 'missing' && (again === undefined || !alive(again))) {
        await rm(file, { force: true });
      }
    } finally {
      await taken.held.release();
    }
  }
  return undefined;
}

// Claude Code trusts the copy: the own entry of its global config's projects named copy, or copy
// made real, has hasTrustDialogAccepted true. A parent's entry does not count. Nothing is written.
export async function copyTrusted(copy: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const home = env.HOME || homedir();
  let data: unknown;
  try {
    data = JSON.parse(await readFile(claudeUserSettings(env, home)[1]!, 'utf8'));
  } catch { // missing, unreadable or not JSON: not trusted
    return false;
  }
  const projects = isObject(data) ? data.projects : undefined;
  if (!isObject(projects)) {
    return false;
  }
  const real = await realpath(copy).catch(() => copy);
  return [copy, real].some((path) => {
    const entry = Object.hasOwn(projects, path) ? projects[path] : undefined;
    return isObject(entry) && entry.hasTrustDialogAccepted === true;
  });
}

// The ticket's session while its process lives; a record whose process ended is removed when the
// ticket's lock is free.
export async function plannerSession(workspace: string, ticket: string, deps: SessionDeps): Promise<PlannerSession | undefined> {
  const [name, checked] = checkJob([workspace, ticket], 'planner session');
  return liveSession(name, checked, deps.stateDir, false);
}

const starting = (workspace: string, ticket: string): FactoryError =>
  new FactoryError('planner_starting', `A start or stop of the planner of ${workspace} ${ticket} is under way: try again in a few seconds.`);

const startFailed = (workspace: string, ticket: string, why: string): FactoryError =>
  new FactoryError('planner_start_failed', `The planner of ${workspace} ${ticket} did not start: ${why}`);

// Starts the ticket's session, or answers with the one that runs (started false).
export async function startPlanner(workspace: string, ticket: string, deps: SessionDeps): Promise<{ started: boolean; session: PlannerSession }> {
  const [w, t] = checkJob([workspace, ticket], 'planner start');
  const trust = plannerTrustSetting(deps.env);
  const file = sessionFile(deps.stateDir, w, t);
  const taken = await tryLock(lockFile(file));
  if ('owner' in taken) {
    throw starting(w, t);
  }
  try {
    const running = await liveSession(w, t, deps.stateDir, true);
    if (running !== undefined) {
      return { started: false, session: running };
    }
    const copy = await safeCopy(w, deps, 'start the planner again');
    if (!(await copyTrusted(copy, deps.env))) {
      if (trust === 'ask') {
        throw new FactoryError('planning_copy_untrusted', `Claude Code does not trust the planning copy of ${w} yet: run sf planner trust ${w}, accept its trust dialog, then start the planner again.`);
      }
      const why = await acceptTrustDialog(w, deps.env);
      if (why !== undefined) {
        throw new FactoryError('planning_copy_untrusted', `Claude Code does not trust the planning copy of ${w} yet, and the factory could not accept its trust dialog: ${why}. Run sf planner trust ${w}, accept its trust dialog, then start the planner again.`);
      }
    }
    return { started: true, session: await launch(w, t, copy, file, deps.env) };
  } finally {
    await taken.held.release();
  }
}

// The workspace's planning copy, once the workspace is known, the copy set up and none of the
// repository's Claude Code configuration in its working tree. retry ends the unsafe message: what
// the user runs once the configuration is removed and the copy set up again.
async function safeCopy(w: string, deps: SessionDeps, retry: string): Promise<string> {
  await resolveWorkspace(w, deps.configDir);
  const copy = join(planningDir(deps.env), w);
  const pointers = await lstat(join(copy, '.claude', 'planning-copy.md')).catch(() => undefined);
  if (pointers === undefined || !pointers.isFile()) {
    throw new FactoryError('planning_copy_missing', `The planning copy of ${w} is not set up: run sf planner setup ${w} first.`);
  }
  const config = await repositoryConfigIn(copy);
  if (config.length > 0) {
    throw new FactoryError('planning_copy_unsafe', `${config[0]} is in the planning copy of ${w}, and Claude Code would load it: remove it, run sf planner setup ${w}, then ${retry}.`);
  }
  return copy;
}

// sf planner trust <workspace>: Claude Code in the workspace's planning copy, in this terminal,
// for the user to accept its trust dialog once; the factory only reads the answer, before (a
// trusted copy opens nothing) and after Claude Code ended. Ctrl+C goes to Claude Code while it runs.
// Nothing is written.
export async function trustPlanner(workspace: string, deps: SessionDeps & { print: (line: string) => void }): Promise<void> {
  const w = checkName(workspace);
  const copy = await safeCopy(w, deps, `sf planner trust ${w}`);
  if (await copyTrusted(copy, deps.env)) {
    deps.print(`Claude Code trusts the planning copy of ${w} already.`);
    return;
  }
  deps.print(`Claude Code opens in the planning copy of ${w}: accept its trust dialog, then leave it with /exit.`);
  const ignore = (): void => undefined;
  process.on('SIGINT', ignore);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('claude', [], { cwd: copy, env: baseEnvironment(deps.env), stdio: 'inherit' });
      child.once('exit', () => resolve());
      child.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT'
        ? new FactoryError('claude_not_found', `Claude Code (claude) is not on PATH: install it, then run sf planner trust ${w} again.`)
        : new FactoryError('planner_trust_failed', `Claude Code could not start in the planning copy of ${w} (${error.code}).`)));
    });
  } finally {
    process.off('SIGINT', ignore);
  }
  if (!(await copyTrusted(copy, deps.env))) {
    throw new FactoryError('planning_copy_untrusted', `Claude Code still does not trust the planning copy of ${w}: its trust dialog was not accepted. Run sf planner trust ${w} again.`);
  }
  deps.print(`Claude Code trusts the planning copy of ${w} now: start its planner with sf planner start ${w} <ticket>.`);
}

// Claude Code's trust dialog is on the screen: the output, escape sequences removed, holds its
// accepting choice "Yes, I trust this folder" in its letters alone.
export function trustDialogShown(output: string): boolean {
  const letters = output
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')   // OSC, up to BEL or ESC \
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')         // CSI
    .replace(/\x1b[\s\S]?/g, '')                     // any other ESC and the character after it
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return letters.includes('yesitrustthisfolder');
}

// SF_PLANNER_TRUST=auto: Claude Code in the workspace's planning copy, in a terminal of its own
// (script), its trust dialog recognised on the screen, its selection moved from the default
// "No, exit" to "Yes, I trust this folder" with Down and, once Claude Code has written its
// selection mark again, confirmed with Enter; the answer read back with copyTrusted. Claude Code is
// always ended before it returns. undefined when Claude Code trusts the copy, else why not. Never
// writes Claude Code's config; its output is matched and dropped, never printed or kept.
export async function acceptTrustDialog(workspace: string, env: NodeJS.ProcessEnv, limitMs = TRUST_DIALOG_MS): Promise<string | undefined> {
  const copy = join(planningDir(env), checkName(workspace));
  const pointers = await lstat(join(copy, '.claude', 'planning-copy.md')).catch(() => undefined);
  if (pointers === undefined || !pointers.isFile()) {
    return 'the copy is not set up';
  }
  const paths = await repositoryConfigIn(copy);
  if (paths.length > 0) {
    return `${paths[0]} is in the copy, and Claude Code would load it`;
  }

  const child = spawn('script', ['-qfec', 'exec claude', '/dev/null'], {
    cwd: copy, env: { ...baseEnvironment(env), TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const deadline = Date.now() + limitMs;
  child.stdin.on('error', () => undefined); // the process gone: nothing more to answer
  let ended = false;
  let endedAt = 0;
  // Before any await, so an early exit is not missed.
  const exited = new Promise<void>((resolve) => child.once('exit', () => {
    ended = true;
    endedAt = Date.now();
    resolve();
  }));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.on('error', reject);
    });
  } catch (error) {
    child.stdout.destroy();
    child.stdin.destroy();
    return `script could not run (${(error as NodeJS.ErrnoException).code})`;
  }
  const run: ProcessRef ={ pid: child.pid!, pid_start: startTime(child.pid!) };

  // The output: kept (its tail) until the dialog shows, then only what follows Down, until it holds
  // the mark; each chunk wakes the step that waits for it.
  let kept = '';
  let shown = false;
  let afterDown: string | undefined;
  let wake = (): void => undefined;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (!shown) {
      kept = `${kept}${chunk}`.slice(-TRUST_OUTPUT_CHARS);
      shown = trustDialogShown(kept);
      if (shown) {
        kept = '';
      }
    } else if (afterDown !== undefined && !afterDown.includes(MARK)) {
      afterDown += chunk;
    }
    wake();
  });
  // Until ms passed, script exited or (output true) output arrived.
  const pause = (ms: number, output: boolean): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const outputCame = output ? new Promise<void>((resolve) => (wake = resolve)) : new Promise<void>(() => undefined);
    return Promise.race([exited, outputCame, new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, ms))))]).finally(() => {
      clearTimeout(timer);
      wake = () => undefined;
    });
  };
  const running = (): boolean => !ended && Date.now() < deadline;

  let entered = false;
  // Read when the wait ends, before Claude Code is ended: whether script exited of itself before
  // the deadline, and whether the dialog showed in time (output read while it is ended does not count).
  let endedEarly = false;
  let shownInTime = false;
  try {
    while (!shown && running()) {
      await pause(deadline - Date.now(), true);
    }
    if (shown && running()) {
      const settled = Math.min(Date.now() + TRUST_SETTLE_MS, deadline);
      while (!ended && Date.now() < settled) {
        await pause(settled - Date.now(), false);
      }
    }
    if (shown && running()) {
      afterDown = '';
      child.stdin.write(DOWN);
      const moved = Math.min(Date.now() + TRUST_MARK_MS, deadline);
      while (!afterDown.includes(MARK) && !ended && Date.now() < moved) {
        await pause(moved - Date.now(), true);
      }
      if (afterDown.includes(MARK) && running()) {
        child.stdin.write('\r');
        entered = true;
        while (running() && !(await copyTrusted(copy, env))) {
          await pause(Math.min(POLL_MS, deadline - Date.now()), false);
        }
      }
    }
  } finally {
    endedEarly = ended && endedAt < deadline;
    shownInTime = shown;
    if (!ended) {
      await endSession(run);
      await exited;
    }
    child.stdin.destroy();
    child.stdout.destroy();
  }

  if (await copyTrusted(copy, env)) {
    return undefined;
  }
  if (!shownInTime) {
    return endedEarly ? 'Claude Code ended before the dialog showed' : `the dialog did not show within ${limitMs / 1000} s`;
  }
  return entered ? 'Claude Code did not save the answer' : 'the selection did not move to "Yes, I trust this folder"';
}

// The session's input: a FIFO beside the record, opened for reading and writing (the open never
// blocks, and the session's own write end keeps its reads from ending), its name removed at once.
async function openInput(workspace: string, ticket: string, file: string, id: string): Promise<number> {
  const fifo = join(dirname(file), `.${ticket}.${id}.fifo`);
  const made = await runCommand('mkfifo', ['-m', '600', fifo]);
  if (made.code !== 0) {
    throw startFailed(workspace, ticket, made.code === null ? 'mkfifo could not run.' : `mkfifo failed (exit ${made.code}).`);
  }
  try {
    return openSync(fifo, 'r+');
  } finally {
    await rm(fifo, { force: true });
  }
}

// script running Claude Code in the copy, detached and unreferenced; its record written before the
// watch, which removes it when the session ends within START_CHECK_MS.
async function launch(workspace: string, ticket: string, copy: string, file: string, env: NodeJS.ProcessEnv): Promise<PlannerSession> {
  const id = randomUUID();
  // The record's folder exists: the ticket's lock (tryLock) made it, mode 0700.
  const fd = await openInput(workspace, ticket, file, id);
  let exited: Promise<void>;
  let child: ChildProcess;
  try {
    child = spawn('script', ['-qfec', commandLine(workspace, ticket), '/dev/null'], {
      cwd: copy, env: plannerEnvironment(env, ticket, id), detached: true, stdio: [fd, 'ignore', 'ignore'],
    });
    // Before any await, so an exit while the record is written is not missed.
    exited = new Promise((resolve) => child.once('exit', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error: NodeJS.ErrnoException) => reject(startFailed(workspace, ticket, `script could not run (${error.code}).`)));
    });
  } finally {
    closeSync(fd);
  }
  child.unref();
  const pid = child.pid!;
  const session: PlannerSession = { workspace, ticket, name: sessionName(workspace, ticket), id, pid, pid_start: startTime(pid), started_at: new Date().toISOString() };
  try {
    await writeRecord(file, session);
  } catch (error) {
    // A session without its record is one nothing could find or stop: ended before the ticket's
    // lock is released. The write is atomic, so no record was left.
    await endSession(session);
    throw startFailed(workspace, ticket, `its record could not be written (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
  }
  let timer: NodeJS.Timeout | undefined;
  const ended = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), START_CHECK_MS))),
  ]);
  clearTimeout(timer);
  if (ended) {
    await rm(file, { force: true });
    throw new FactoryError('planner_start_failed', `The planner of ${workspace} ${ticket} ended within 3 s of its start: open Claude Code in the planning copy of ${workspace} by hand to see why (claude on PATH, its login, its sandbox).`);
  }
  return session;
}

// The ticket's lock, tried every POLL_MS while a live process holds it, at most START_CHECK_MS +
// 10 s (a start holds it through its checks, the spawn and the watch).
async function waitForLock(file: string, workspace: string, ticket: string): Promise<HeldLock> {
  const deadline = Date.now() + START_CHECK_MS + LOCK_WAIT_MORE_MS;
  for (;;) {
    const taken = await tryLock(lockFile(file));
    if ('held' in taken) {
      return taken.held;
    }
    if (Date.now() >= deadline) {
      throw starting(workspace, ticket);
    }
    await sleep(POLL_MS);
  }
}

// The first child of pid (script's: Claude Code); undefined when /proc does not tell.
function firstChild(pid: number): number | undefined {
  try {
    const first = Number(readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/)[0]);
    return Number.isInteger(first) && first > 0 ? first : undefined;
  } catch { // no such process or no /proc: no child known
    return undefined;
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch { // the process is already gone
  }
}

// A zombie (ended, not yet reaped) counts as ended.
function zombie(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch { // no such process: not a zombie (ownerAlive tells it ended)
    return false;
  }
}

// Waits, polling every POLL_MS, at most ms, until the session ended; whether it did.
async function waitEnded(session: ProcessRef,ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!alive(session) || zombie(session.pid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(POLL_MS);
  }
}

// Ends the ticket's session: SIGTERM to its Claude Code (SIGKILL to script when it has no child),
// SIGKILL to both after STOP_GRACE_MS; the record removed. undefined when none runs.
export async function stopPlanner(workspace: string, ticket: string, deps: SessionDeps): Promise<PlannerSession | undefined> {
  const [w, t] = checkJob([workspace, ticket], 'planner stop');
  const file = sessionFile(deps.stateDir, w, t);
  if (!(await lstat(file).then(() => true, () => false))) {
    return undefined;
  }
  const held = await waitForLock(file, w, t);
  try {
    const session = await liveSession(w, t, deps.stateDir, true);
    if (session === undefined) {
      return undefined;
    }
    await endSession(session);
    await rm(file, { force: true });
    return session;
  } finally {
    await held.release();
  }
}

// SIGTERM to the session's Claude Code (SIGKILL to script when it has no child), SIGKILL to both
// when it still runs after STOP_GRACE_MS; then at most KILL_WAIT_MS more.
async function endSession(session: ProcessRef): Promise<void> {
  const child = firstChild(session.pid);
  if (child !== undefined) {
    signal(child, 'SIGTERM');
  } else {
    signal(session.pid, 'SIGKILL');
  }
  if (!(await waitEnded(session, STOP_GRACE_MS))) {
    if (child !== undefined) {
      signal(child, 'SIGKILL');
    }
    signal(session.pid, 'SIGKILL');
    await waitEnded(session, KILL_WAIT_MS);
  }
}

// The copy's hook: the session's claude.ai link written into the ticket's record whose id is the
// session's SF_PLANNER_ID. Never rejects; a failure is one stderr line. A session the user opened by
// hand (no markers), a record of another start, or none, records nothing and creates nothing.
export async function recordLink(workspace: string, deps: { env: NodeJS.ProcessEnv; stateDir: string }): Promise<void> {
  try {
    const { SF_PLANNER_TICKET: ticket, SF_PLANNER_ID: id, CLAUDE_CODE_BRIDGE_SESSION_ID: bridge } = deps.env;
    if (ticket === undefined || !TICKET_PATTERN.test(ticket) || !id || bridge === undefined || !BRIDGE_ID.test(bridge)) {
      return;
    }
    const file = sessionFile(deps.stateDir, workspace, ticket);
    const found = await readRecord(file, workspace, ticket);
    if (found === 'missing' || found === undefined || found.id !== id) {
      return;
    }
    // A start or stop under way: the hook's next run records the link.
    const taken = await tryLock(lockFile(file));
    if ('owner' in taken) {
      return;
    }
    try {
      const again = await readRecord(file, workspace, ticket);
      const link = `https://claude.ai/code/${bridge}`;
      if (again !== 'missing' && again !== undefined && again.id === id && again.link !== link) {
        await writeRecord(file, { ...again, link });
      }
    } finally {
      await taken.held.release();
    }
  } catch (error) {
    console.error(`sf planner waiting: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ')}`);
  }
}

// sf planner start|stop <workspace> <ticket>, sf planner trust <workspace>.
export async function plannerSessionCommand(args: string[], deps: SessionDeps & { print: (line: string) => void }): Promise<void> {
  const [verb, workspace, ticket] = args;
  if (verb === 'trust' && args.length === 2 && workspace !== undefined) {
    await trustPlanner(workspace, deps);
    return;
  }
  if (args.length !== 3 || (verb !== 'start' && verb !== 'stop') || workspace === undefined || ticket === undefined) {
    throw new UsageError('planner start and planner stop need <workspace> <ticket>; planner trust needs <workspace>.');
  }
  if (verb === 'stop') {
    const stopped = await stopPlanner(workspace, ticket, deps);
    deps.print(stopped === undefined ? `No planner of ${workspace} ${ticket} is running.` : `Stopped the planner of ${workspace} ${ticket} (pid ${stopped.pid}).`);
    return;
  }
  const { started, session: s } = await startPlanner(workspace, ticket, deps);
  const [w, t] = [s.workspace, s.ticket];
  if (started) {
    deps.print(`Planner of ${w} ${t} started: Claude Code session "${s.name}" in the planning copy of ${w} (pid ${s.pid}).`);
    deps.print(`Open it in the Claude app or on claude.ai/code under that name; once the planner first waits for you, sf planner start ${w} ${t} prints its link.`);
    return;
  }
  const since = localTime(s.started_at) ?? s.started_at;
  deps.print(s.link !== undefined
    ? `Planner of ${w} ${t} is running since ${since} (pid ${s.pid}): ${s.link}`
    : `Planner of ${w} ${t} is running since ${since} (pid ${s.pid}); its link is recorded when it first waits for you.`);
}
