// SF-010: the coordinator's private state (records.ts lists the files). Reads never follow a
// symlink and accept only private regular files of this user (readPrivate); writes are complete
// temp files linked (exclusive) or renamed into place (writePrivate). Opening for reading only
// (openExisting) creates nothing.
import { lstat, open, readdir, realpath, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type * as z from 'zod/v4';
import { acquireLock } from '../execution/process-identity.js';
import { ID_PATTERN, SHA256_PATTERN } from '../factory-jobs.js';
import { constants } from 'node:fs';
import { privateDirectory, waitForLock, writePrivate } from '../operator/store.js';
import {
  MAX_STATE_FILE_BYTES,
  delegationSchema,
  eventSchema,
  jobStateSchema,
  providerOptInSchema,
  ReviewerError,
  type ProviderOptIn,
  type ReviewDelegation,
  type ReviewerJobState,
  type ReviewReadyEvent,
} from './records.js';

export const reviewerDirectory = (stateHome: string): string => join(stateHome, 'software-factory', 'reviewer');
// Bounds of what one listing reads (reported as incomplete when hit, never silently cut).
export const STORE_LIMITS = { apps: 100, jobsPerApp: 1000, eventsPerJob: 500 } as const;

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const checkIds = (appId: string, jobId: string): void => {
  if (!ID_PATTERN.test(appId) || !ID_PATTERN.test(jobId)) {
    throw new ReviewerError('invalid_input', 'app_id and job_id must be valid identifiers.');
  }
};

// The SF-007 checks (no symlink, a private regular file of this user, a strict schema) with the
// reviewer's own size bound, which every write enforces as well (writeBounded).
const read = async <T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> => {
  const invalid = () => new ReviewerError('invalid_record', 'A reviewer state file is not a private regular file of this user matching its schema (a symlink, another owner, too large or malformed).');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw invalid();
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_STATE_FILE_BYTES || (stats.mode & 0o077) !== 0 || stats.uid !== process.getuid!()) {
      throw invalid();
    }
    const parsed = schema.safeParse(JSON.parse(await handle.readFile('utf8')));
    if (!parsed.success) {
      throw invalid();
    }
    return parsed.data;
  } catch {
    throw invalid();
  } finally {
    await handle.close();
  }
};

// writePrivate, refused (nothing written) when the record would exceed what read accepts.
const writeBounded = async (dir: string, name: string, value: unknown, mode: 'create' | 'replace'): Promise<void> => {
  if (Buffer.byteLength(`${JSON.stringify(value)}\n`) > MAX_STATE_FILE_BYTES) {
    throw new ReviewerError('invalid_record', `A reviewer state record would exceed ${MAX_STATE_FILE_BYTES} bytes; nothing was written.`);
  }
  await writePrivate(dir, name, value, mode);
};

// The id-named entries of a private directory: a missing directory is empty; anything but a plain
// private directory is refused.
async function listNames(path: string, pattern: RegExp, limit: number): Promise<{ names: string[]; complete: boolean }> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { names: [], complete: true };
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== process.getuid!() || (stats.mode & 0o077) !== 0) {
    throw new ReviewerError('unsafe_state', 'A reviewer state directory is not a private plain directory of this user.');
  }
  const all = (await readdir(path)).filter((name) => pattern.test(name)).sort();
  return all.length > limit ? { names: all.slice(0, limit), complete: false } : { names: all, complete: true };
}

export class ReviewerState {
  readonly dir: string;
  readonly #writable: boolean;

  private constructor(dir: string, writable: boolean) {
    this.dir = dir;
    this.#writable = writable;
  }

  static async #resolve(stateHome: string, mediatorRoot: string, create: boolean): Promise<string> {
    if (!isAbsolute(stateHome)) {
      throw new ReviewerError('unsafe_state', 'The state home must be an absolute path.');
    }
    if (create) {
      await mkdir(stateHome, { recursive: true, mode: 0o700 });
    }
    const real = await realpath(stateHome).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && !create) {
        return stateHome;
      }
      throw error;
    });
    const dir = reviewerDirectory(real);
    const mediator = await realpath(mediatorRoot);
    if (inside(mediator, dir) || inside(dir, mediator)) {
      throw new ReviewerError('unsafe_state', 'The reviewer state directory must be outside the Software Factory repository.');
    }
    return dir;
  }

  // Opens (creating if needed) the private reviewer directory.
  static async open(stateHome: string, mediatorRoot: string): Promise<ReviewerState> {
    const dir = await ReviewerState.#resolve(stateHome, mediatorRoot, true);
    for (const path of [join(dir, '..'), dir, join(dir, 'delegations'), join(dir, 'revoked'), join(dir, 'events'), join(dir, 'jobs'), join(dir, 'coordinator')]) {
      await privateDirectory(path, true);
    }
    return new ReviewerState(dir, true);
  }

  // For status and dry-run: creates nothing. A missing directory reads as no state.
  static async openExisting(stateHome: string, mediatorRoot: string): Promise<ReviewerState> {
    const dir = await ReviewerState.#resolve(stateHome, mediatorRoot, false);
    for (const path of [join(dir, '..'), dir]) {
      await privateDirectory(path, false).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
    return new ReviewerState(dir, false);
  }

  #mustWrite(): void {
    if (!this.#writable) {
      throw new ReviewerError('unsafe_state', 'The reviewer state was opened read-only.');
    }
  }

  async #privateDir(...parts: string[]): Promise<string> {
    let path = this.dir;
    for (const part of parts) {
      path = join(path, part);
      await privateDirectory(path, true);
    }
    return path;
  }

  // ---- provider opt-in ----

  async providerOptIn(): Promise<ProviderOptIn | undefined> {
    return read(join(this.dir, 'provider.json'), providerOptInSchema);
  }

  async setProviderOptIn(value: ProviderOptIn): Promise<void> {
    this.#mustWrite();
    await writeBounded(this.dir, 'provider.json', providerOptInSchema.parse(value), 'replace');
  }

  // ---- delegations ----

  async delegation(appId: string, jobId: string): Promise<ReviewDelegation | undefined> {
    checkIds(appId, jobId);
    const value = await read(join(this.dir, 'delegations', appId, `${jobId}.json`), delegationSchema);
    if (value !== undefined && (value.app_id !== appId || value.job_id !== jobId)) {
      throw new ReviewerError('invalid_record', `The delegation file of ${appId}/${jobId} names another job.`);
    }
    return value;
  }

  // A delegation is created once per job: a second one is refused while the first is not revoked.
  async createDelegation(value: ReviewDelegation): Promise<void> {
    this.#mustWrite();
    const parsed = delegationSchema.parse(value);
    const dir = await this.#privateDir('delegations', parsed.app_id);
    const existing = await this.delegation(parsed.app_id, parsed.job_id);
    if (existing !== undefined && !(await this.revoked(existing.delegation_id))) {
      throw new ReviewerError('conflict', `${parsed.app_id}/${parsed.job_id} already has a review delegation (${existing.delegation_id}); revoke it first.`);
    }
    await writeBounded(dir, `${parsed.job_id}.json`, parsed, existing === undefined ? 'create' : 'replace');
  }

  async revoked(delegationId: string): Promise<boolean> {
    try {
      // Any entry under the name revokes, whatever its type.
      await lstat(join(this.dir, 'revoked', delegationId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      // Unreadable: treated as revoked (fail closed).
      return true;
    }
  }

  async revoke(delegationId: string): Promise<boolean> {
    this.#mustWrite();
    try {
      await (await open(join(this.dir, 'revoked', delegationId), 'wx', 0o600)).close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  }

  // The delegated jobs, in app and job order (bounded).
  async delegatedJobs(): Promise<{ jobs: Array<{ appId: string; jobId: string }>; complete: boolean }> {
    const jobs: Array<{ appId: string; jobId: string }> = [];
    const apps = await listNames(join(this.dir, 'delegations'), ID_PATTERN, STORE_LIMITS.apps);
    let complete = apps.complete;
    for (const appId of apps.names) {
      const files = await listNames(join(this.dir, 'delegations', appId), /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.json$/, STORE_LIMITS.jobsPerApp);
      complete &&= files.complete;
      for (const name of files.names) {
        jobs.push({ appId, jobId: name.slice(0, -'.json'.length) });
      }
    }
    return { jobs, complete };
  }

  // ---- events ----

  // Exclusive create. An existing event with the same identity is the same event (idempotent);
  // true when this call created it.
  async createEvent(value: ReviewReadyEvent): Promise<boolean> {
    this.#mustWrite();
    const parsed = eventSchema.parse(value);
    const dir = await this.#privateDir('events', parsed.app_id, parsed.job_id);
    try {
      await writeBounded(dir, `${parsed.event_id}.json`, parsed, 'create');
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== 'conflict') {
        throw error;
      }
      const existing = await this.event(parsed.app_id, parsed.job_id, parsed.event_id);
      if (existing === undefined || existing.iteration_id !== parsed.iteration_id || existing.snapshot_sha256 !== parsed.snapshot_sha256) {
        throw new ReviewerError('conflict', `Event ${parsed.event_id} exists with other content.`);
      }
      return false;
    }
  }

  async event(appId: string, jobId: string, id: string): Promise<ReviewReadyEvent | undefined> {
    checkIds(appId, jobId);
    if (!SHA256_PATTERN.test(id)) {
      throw new ReviewerError('invalid_input', 'An event id is a sha256.');
    }
    return read(join(this.dir, 'events', appId, jobId, `${id}.json`), eventSchema);
  }

  // The events of one job, oldest iteration first (bounded). An unreadable event is reported.
  async events(appId: string, jobId: string): Promise<{ events: ReviewReadyEvent[]; complete: boolean; invalid: number }> {
    checkIds(appId, jobId);
    const files = await listNames(join(this.dir, 'events', appId, jobId), /^[0-9a-f]{64}\.json$/, STORE_LIMITS.eventsPerJob);
    const events: ReviewReadyEvent[] = [];
    let invalid = 0;
    for (const name of files.names) {
      const value = await this.event(appId, jobId, name.slice(0, 64)).catch(() => undefined);
      if (value === undefined || value.app_id !== appId || value.job_id !== jobId || value.event_id !== name.slice(0, 64)) {
        invalid += 1;
        continue;
      }
      events.push(value);
    }
    events.sort((a, b) => a.iteration_number - b.iteration_number || a.created_at.localeCompare(b.created_at));
    return { events, complete: files.complete, invalid };
  }

  eventsDirectory(): string {
    return join(this.dir, 'events');
  }

  // ---- per-job coordinator state ----

  async jobState(appId: string, jobId: string): Promise<ReviewerJobState | undefined> {
    checkIds(appId, jobId);
    const value = await read(join(this.dir, 'jobs', appId, `${jobId}.json`), jobStateSchema);
    if (value !== undefined && (value.app_id !== appId || value.job_id !== jobId)) {
      throw new ReviewerError('invalid_record', `The reviewer state of ${appId}/${jobId} names another job.`);
    }
    return value;
  }

  // Read-modify-write under a short per-job lock (also against a coordinator that bypassed the
  // coordinator lock). update returns the next state, or undefined to leave it unchanged.
  async updateJobState(appId: string, jobId: string, update: (current: ReviewerJobState | undefined) => ReviewerJobState | undefined): Promise<ReviewerJobState | undefined> {
    this.#mustWrite();
    checkIds(appId, jobId);
    const dir = await this.#privateDir('jobs', appId);
    const lockDir = await this.#privateDir('jobs', appId, `.${jobId}.lock`);
    const release = await waitForLock(lockDir, `Reviewer state of ${appId}/${jobId}`);
    try {
      const current = await this.jobState(appId, jobId);
      const next = update(current);
      if (next === undefined) {
        return current;
      }
      const parsed = jobStateSchema.parse({ ...next, revision: (current?.revision ?? 0) + 1 });
      await writeBounded(dir, `${jobId}.json`, parsed, current === undefined ? 'create' : 'replace');
      return parsed;
    } finally {
      await release();
    }
  }

  // ---- the single coordinator ----

  async coordinatorLock(): Promise<() => Promise<void>> {
    this.#mustWrite();
    try {
      return await acquireLock(join(this.dir, 'coordinator'), 'Software Factory review coordinator');
    } catch (error) {
      if ((error as { code?: string }).code === 'locked') {
        throw new ReviewerError('locked', 'Another review coordinator of this user is running.');
      }
      throw error;
    }
  }
}
