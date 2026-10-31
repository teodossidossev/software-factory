// SF-007 operator state: the host-local, private record of operator decisions.
// It lives outside the mediator repository (default
// ${XDG_STATE_HOME:-~/.local/state}/software-factory/operator), so neither
// factory_read_file nor any bridge tool can read or write it. Directories are
// 0700, files 0600, written completely before they appear (temp file + link or
// rename) and read without following symlinks.
//
//   jobs/<app>/<job>/approval.json                  the one pending approval (exclusive)
//   jobs/<app>/<job>/approval-<id>.<outcome>.json   a settled approval (consumed, cancelled, expired, refused)
//   jobs/<app>/<job>/rejected.json                  final rejection
//   jobs/<app>/<job>/deferred.json                  "Later"
//   jobs/<app>/<job>/launch.json                    the latest launch attempt and its outcome
//   events.jsonl                                    audit log: ids, digests, timestamps; never paths
//
// The host-wide Claude session gate is not here: it belongs to SF-006
// (execution/session-gate.ts), so the manual CLI and the console share it.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import * as z from 'zod/v4';
import { acquireLock } from '../execution/process-identity.js';
import { AppConfigError } from '../execution/app-config.js';
import { ExecutionError } from '../execution/errors.js';
import { FactoryJobError, ID_PATTERN } from '../factory-jobs.js';

export const APPROVAL_SCHEMA = 'software-factory.operator-approval/v1';
export const APPROVAL_TTL_MS = 15 * 60 * 1000;
const MAX_STATE_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_EVENT_LOG_BYTES = 16 * 1024 * 1024;

export type OperatorErrorCode =
  | 'invalid_id'
  | 'unsafe_state'
  | 'invalid_record'
  | 'conflict'
  | 'not_found'
  | 'busy'
  | 'expired'
  | 'not_ready'
  | 'wrong_status'
  | 'mismatch'
  | 'no_tty'
  | 'unsupported_isolation';

// Errors whose messages are written for the operator (ids and repository-relative paths only).
export type CodedError = OperatorError | ExecutionError | AppConfigError | FactoryJobError;
export const isCodedError = (error: unknown): error is CodedError =>
  error instanceof OperatorError || error instanceof ExecutionError || error instanceof AppConfigError || error instanceof FactoryJobError;

// Messages carry ids, digests and fixed text only, never host paths or tokens.
export class OperatorError extends Error {
  readonly code: OperatorErrorCode;

  constructor(code: OperatorErrorCode, message: string) {
    super(message);
    this.name = 'OperatorError';
    this.code = code;
  }
}

const sha = z.string().regex(SHA256);
const id = z.string().regex(ID_PATTERN);
const approvalSchema = z.strictObject({
  schema: z.literal(APPROVAL_SCHEMA),
  id: z.uuid(),
  app_id: id,
  job_id: id,
  request_id: z.string().min(1).max(128),
  instruction_sha256: sha,
  app_repo_sha256: sha,
  approved_at: z.iso.datetime(),
});
export type ApprovalRecord = z.infer<typeof approvalSchema>;
export type ApprovalOutcome = 'consumed' | 'cancelled' | 'expired' | 'refused';
const OUTCOMES: readonly ApprovalOutcome[] = ['consumed', 'cancelled', 'expired', 'refused'];

// What the operator was shown and decided about.
export const shownFields = { request_id: z.string().min(1).max(128), instruction_sha256: sha };
const decisionSchema = z.strictObject({ ...shownFields, at: z.iso.datetime() });
export type Decision = z.infer<typeof decisionSchema>;

const identitySchema = z.strictObject({ pid: z.number().int(), pid_start: z.string(), boot_id: z.string() });
const launchSchema = z.strictObject({
  approval_id: z.uuid(),
  // started: the attend process consumed the approval; finished: SF-006 reached a final view;
  // refused: a check (preflight, session gate, expiry, TTY) stopped it before Claude started;
  // failed: an error stopped it; cancelled: the operator withdrew the approval.
  outcome: z.enum(['started', 'refused', 'failed', 'finished', 'cancelled']),
  code: z.string().max(64).nullable(),
  message: z.string().max(500).nullable(),
  at: z.iso.datetime(),
  attend: identitySchema.nullable(),
  final_state: z.string().max(32).nullable(),
});
export type LaunchRecord = z.infer<typeof launchSchema>;

export function launchRecord(
  outcome: LaunchRecord['outcome'],
  now: Date,
  details: Partial<Pick<LaunchRecord, 'code' | 'message' | 'attend' | 'final_state'>> = {},
): Omit<LaunchRecord, 'approval_id'> {
  return { outcome, code: null, message: null, at: now.toISOString(), attend: null, final_state: null, ...details };
}

export interface JobOperatorState {
  pending: ApprovalRecord | undefined;
  rejected: Decision | undefined;
  deferred: Decision | undefined;
  launch: LaunchRecord | undefined;
}

export interface OperatorEvent {
  event: 'approved' | 'rejected' | 'deferred' | 'cancelled' | 'consumed' | 'expired' | 'refused' | 'failed' | 'finished' | ExecutorEventName;
  app_id?: string;
  job_id?: string;
  request_id?: string;
  instruction_sha256?: string;
  approval_id?: string;
  code?: string;
  final_state?: string;
  // SF-009 supervisor events: who approved (the MCP authorization) and what it referred to.
  source?: 'console' | 'mcp_authorization';
  authorization_id?: string;
  iteration_id?: string;
  review_id?: string;
  request_id_context?: string;
  snapshot_sha256?: string;
  outcome?: string;
}

export type ExecutorEventName =
  | 'executor_started'
  | 'executor_stopped'
  | 'authorization_refused'
  | 'authorization_queued'
  | 'iteration_ready'
  | 'snapshot_failed'
  | 'review_delivered'
  | 'review_rejected'
  | 'context_action'
  | 'acceptance'
  | 'needs_operator'
  | 'session_closed'

const isoNow = (now: Date): string => now.toISOString();

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function defaultStateHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)) return env.XDG_STATE_HOME;
  if (!env.HOME || !isAbsolute(env.HOME)) throw new OperatorError('unsafe_state', 'Neither XDG_STATE_HOME nor HOME is an absolute path.');
  return join(env.HOME, '.local', 'state');
}

export const stateDirectory = (stateHome: string): string => join(stateHome, 'software-factory', 'operator');

// A 0700 directory owned by this user, created if needed, never a symlink.
export async function privateDirectory(path: string, create: boolean): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new OperatorError('unsafe_state', 'An operator state directory is not a plain directory.');
    if (stats.uid !== process.getuid!() || (stats.mode & 0o077) !== 0) {
      throw new OperatorError('unsafe_state', 'An operator state directory is accessible by other users; it must be 0700 and owned by you.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
    // A concurrent creator may win; the result is checked the same way either way.
    await mkdir(path, { mode: 0o700 }).catch((mkdirError: NodeJS.ErrnoException) => {
      if (mkdirError.code !== 'EEXIST') throw mkdirError;
    });
    await privateDirectory(path, false);
  }
}

// Reads a private JSON file without following symlinks; undefined when it does not exist.
export async function readPrivate<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new OperatorError('invalid_record', 'An operator state file cannot be opened (symlink or no access).');
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_STATE_BYTES || (stats.mode & 0o077) !== 0 || stats.uid !== process.getuid!()) {
      throw new OperatorError('invalid_record', 'An operator state file is not a private regular file.');
    }
    const parsed = schema.safeParse(JSON.parse(await handle.readFile('utf8')));
    if (!parsed.success) throw new OperatorError('invalid_record', 'An operator state file does not match its schema.');
    return parsed.data;
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    throw new OperatorError('invalid_record', 'An operator state file is not valid JSON.');
  } finally {
    await handle.close();
  }
}

// Complete temp file, then link (exclusive: 'conflict' if the name exists) or rename (replace).
export async function writePrivate(dir: string, name: string, value: unknown, mode: 'create' | 'replace'): Promise<void> {
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode === 'create') {
      try {
        await link(temp, join(dir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new OperatorError('conflict', `${name} already exists.`);
        throw error;
      }
    } else {
      await rename(temp, join(dir, name));
    }
  } finally {
    await rm(temp, { force: true });
  }
}

function checkIds(appId: string, jobId: string): void {
  if (!ID_PATTERN.test(appId) || !ID_PATTERN.test(jobId)) throw new OperatorError('invalid_id', 'app_id and job_id must be valid identifiers.');
}

export class OperatorStore {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  // Opens (creating if needed) the private state directory. It must not lie inside the mediator.
  static async open(stateHome: string, mediatorRoot: string): Promise<OperatorStore> {
    if (!isAbsolute(stateHome)) throw new OperatorError('unsafe_state', 'The operator state home must be an absolute path.');
    await mkdir(stateHome, { recursive: true, mode: 0o700 });
    // Compared by real path, so a symlinked state home cannot lead into the mediator.
    const dir = stateDirectory(await realpath(stateHome));
    const mediator = await realpath(mediatorRoot);
    if (inside(mediator, dir) || inside(dir, mediator)) {
      throw new OperatorError('unsafe_state', 'The operator state directory must be outside the Software Factory repository.');
    }
    for (const path of [join(stateHome, 'software-factory'), dir, join(dir, 'jobs')]) {
      await privateDirectory(path, true);
    }
    return new OperatorStore(dir);
  }

  // ---- per-job decisions ----

  async #jobDir(appId: string, jobId: string, create: boolean): Promise<string | undefined> {
    checkIds(appId, jobId);
    const appDir = join(this.dir, 'jobs', appId);
    const jobDir = join(appDir, jobId);
    try {
      await privateDirectory(appDir, create);
      await privateDirectory(jobDir, create);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return jobDir;
  }

  // Serializes decisions about one job across the server and attend processes.
  async #locked<T>(appId: string, jobId: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = (await this.#jobDir(appId, jobId, true))!;
    const release = await waitForLock(dir, `operator state of ${appId}/${jobId}`);
    try {
      return await fn(dir);
    } finally {
      await release();
    }
  }

  async jobState(appId: string, jobId: string): Promise<JobOperatorState> {
    const dir = await this.#jobDir(appId, jobId, false);
    if (dir === undefined) return { pending: undefined, rejected: undefined, deferred: undefined, launch: undefined };
    return {
      pending: await readPrivate(join(dir, 'approval.json'), approvalSchema),
      rejected: await readPrivate(join(dir, 'rejected.json'), decisionSchema),
      deferred: await readPrivate(join(dir, 'deferred.json'), decisionSchema),
      launch: await readPrivate(join(dir, 'launch.json'), launchSchema),
    };
  }

  // Creates the one pending approval. check runs under the job's lock first and may throw.
  // id: a caller-chosen approval id (SF-009 records it before creating, to find it after a restart).
  async createApproval(
    tuple: Omit<ApprovalRecord, 'schema' | 'id' | 'approved_at'>,
    now: Date,
    check: (state: JobOperatorState) => Promise<void>,
    id: string = randomUUID(),
  ): Promise<ApprovalRecord> {
    return this.#locked(tuple.app_id, tuple.job_id, async (dir) => {
      const state = await this.jobState(tuple.app_id, tuple.job_id);
      if (state.pending !== undefined && expired(state.pending, now)) {
        await this.#settle(dir, state.pending, 'expired');
        state.pending = undefined;
      }
      await check(state);
      if ((await this.#find(dir, id)) !== undefined) throw new OperatorError('conflict', `Approval ${id} already exists.`);
      const record: ApprovalRecord = { schema: APPROVAL_SCHEMA, id, ...tuple, approved_at: isoNow(now) };
      approvalSchema.parse(record);
      await writePrivate(dir, 'approval.json', record, 'create');
      return record;
    });
  }

  // The approval with this id, pending or settled (and how), or undefined when there is none.
  async approvalById(appId: string, jobId: string, approvalId: string): Promise<{ status: 'pending' | ApprovalOutcome; record: ApprovalRecord } | undefined> {
    return this.#locked(appId, jobId, (dir) => this.#find(dir, approvalId));
  }

  async #find(dir: string, approvalId: string): Promise<{ status: 'pending' | ApprovalOutcome; record: ApprovalRecord } | undefined> {
    if (!z.uuid().safeParse(approvalId).success) throw new OperatorError('invalid_id', 'An approval id must be a UUID.');
    const pending = await readPrivate(join(dir, 'approval.json'), approvalSchema);
    if (pending?.id === approvalId) return { status: 'pending', record: pending };
    for (const outcome of OUTCOMES) {
      const record = await readPrivate(join(dir, `approval-${approvalId}.${outcome}.json`), approvalSchema);
      if (record !== undefined && record.id !== approvalId) throw new OperatorError('invalid_record', 'A settled approval record names another approval id.');
      if (record !== undefined) return { status: outcome, record };
    }
    return undefined;
  }

  async #settle(dir: string, approval: ApprovalRecord, outcome: ApprovalOutcome): Promise<void> {
    await rename(join(dir, 'approval.json'), join(dir, `approval-${approval.id}.${outcome}.json`));
  }

  // Settles the pending approval with this id (or any pending one when id is undefined).
  // Returns it, or undefined when there is none: someone else settled it first.
  async settleApproval(appId: string, jobId: string, approvalId: string | undefined, outcome: ApprovalOutcome, launch?: Omit<LaunchRecord, 'approval_id'>): Promise<ApprovalRecord | undefined> {
    if (!OUTCOMES.includes(outcome)) throw new OperatorError('invalid_record', 'Unknown approval outcome.');
    return this.#locked(appId, jobId, async (dir) => {
      const pending = await readPrivate(join(dir, 'approval.json'), approvalSchema);
      if (pending === undefined || (approvalId !== undefined && pending.id !== approvalId)) return undefined;
      await this.#settle(dir, pending, outcome);
      if (launch !== undefined) await writePrivate(dir, 'launch.json', { approval_id: pending.id, ...launch }, 'replace');
      return pending;
    });
  }

  async writeLaunch(appId: string, jobId: string, launch: LaunchRecord): Promise<void> {
    launchSchema.parse(launch);
    await this.#locked(appId, jobId, async (dir) => writePrivate(dir, 'launch.json', launch, 'replace'));
  }

  async reject(appId: string, jobId: string, decision: Decision, check: (state: JobOperatorState) => Promise<void>): Promise<void> {
    await this.#locked(appId, jobId, async (dir) => {
      await check(await this.jobState(appId, jobId));
      await writePrivate(dir, 'rejected.json', decisionSchema.parse(decision), 'create');
    });
  }

  async defer(appId: string, jobId: string, decision: Decision, check: (state: JobOperatorState) => Promise<void>): Promise<void> {
    await this.#locked(appId, jobId, async (dir) => {
      await check(await this.jobState(appId, jobId));
      await writePrivate(dir, 'deferred.json', decisionSchema.parse(decision), 'replace');
    });
  }

  // Every pending approval of every job (for the global "one launch at a time" check).
  // An unreadable job record counts as pending: the check fails closed.
  async pendingApprovals(): Promise<Array<ApprovalRecord | 'unreadable'>> {
    const found: Array<ApprovalRecord | 'unreadable'> = [];
    for (const appId of (await readdir(join(this.dir, 'jobs'))).filter((name) => ID_PATTERN.test(name))) {
      for (const jobId of (await readdir(join(this.dir, 'jobs', appId))).filter((name) => ID_PATTERN.test(name))) {
        try {
          const { pending } = await this.jobState(appId, jobId);
          if (pending !== undefined) found.push(pending);
        } catch {
          found.push('unreadable');
        }
      }
    }
    return found;
  }

  // Appends one line to the audit log, never through a symlink; the log stops growing at 16 MiB.
  async appendEvent(event: OperatorEvent, now: Date): Promise<void> {
    const handle = await open(join(this.dir, 'events.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_EVENT_LOG_BYTES) return;
      await handle.write(`${JSON.stringify({ at: isoNow(now), ...event })}\n`);
    } finally {
      await handle.close();
    }
  }
}

// The short-lived state locks are held for a few file operations; contenders wait up to about 5 s.
export async function waitForLock(dir: string, label: string): Promise<() => Promise<void>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await acquireLock(dir, label);
    } catch (error) {
      if ((error as { code?: string }).code !== 'locked' || attempt >= 250) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export function expired(approval: ApprovalRecord, now: Date): boolean {
  return now.getTime() - Date.parse(approval.approved_at) > APPROVAL_TTL_MS;
}
