// Operational job directories under <repo>/factory-data/apps/<app-id>/jobs/<job-id>.
// Callers pass identifiers only, never paths. An app exists only when an
// operator created its directory; job directories are created on demand.
// Every directory on the way must be a real directory, not a symlink.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const APPS_PATH = 'factory-data/apps';
export const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const ID_DESCRIPTION = '1-64 characters of a-z, 0-9 and "-", starting and ending with a letter or digit';
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type FactoryJobErrorCode =
  | 'invalid_id'
  | 'invalid_sha256'
  | 'invalid_content'
  | 'too_large'
  | 'app_not_found'
  | 'not_found'
  | 'forbidden_path'
  | 'conflict'
  | 'dispatched'
  | 'sha256_mismatch'
  | 'dispatch_conflict'
  | 'invalid_record'
  | 'io_failed';

// Messages never contain absolute host paths, only identifiers and repository-relative paths.
export class FactoryJobError extends Error {
  readonly code: FactoryJobErrorCode;

  constructor(code: FactoryJobErrorCode, message: string) {
    super(message);
    this.name = 'FactoryJobError';
    this.code = code;
  }
}

export interface JobDir {
  // Absolute directory, for file operations only; never returned to callers.
  dir: string;
  // Repository-relative directory, e.g. factory-data/apps/sf-pilot/jobs/job-001.
  path: string;
}

function checkId(kind: 'app_id' | 'job_id', value: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new FactoryJobError('invalid_id', `${kind} must be ${ID_DESCRIPTION}.`);
  }
}

export function checkSha256(value: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new FactoryJobError('invalid_sha256', 'sha256 values must be 64 lowercase hexadecimal characters.');
  }
}

// Returns 'missing' for ENOENT; rejects symlinks and non-directories.
async function directoryState(path: string, label: string): Promise<'present' | 'missing'> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new FactoryJobError('forbidden_path', `${label} is not a plain directory.`);
    }
    return 'present';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

export class FactoryJobs {
  readonly #root: string;
  readonly #locks = new Map<string, Promise<unknown>>();

  // root must already be resolved by resolveRepoRoot.
  constructor(root: string) {
    this.#root = root;
  }

  // Runs fn with exclusive access to one job inside this process. The bridge
  // is the only writer of factory-data/apps, so this serializes all updates.
  async withJob<T>(appId: string, jobId: string, create: boolean, fn: (job: JobDir) => Promise<T>): Promise<T> {
    checkId('app_id', appId);
    checkId('job_id', jobId);
    const key = `${appId}/${jobId}`;
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => fn(await this.#jobDir(appId, jobId, create)));
    this.#locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.#locks.get(key) === current) {
        this.#locks.delete(key);
      }
    }
  }

  async #jobDir(appId: string, jobId: string, create: boolean): Promise<JobDir> {
    const appPath = `${APPS_PATH}/${appId}`;
    for (const path of ['factory-data', APPS_PATH, appPath]) {
      if ((await directoryState(join(this.#root, path), path)) === 'missing') {
        throw new FactoryJobError('app_not_found', `App "${appId}" is not registered (${appPath} does not exist).`);
      }
    }
    const path = `${appPath}/jobs/${jobId}`;
    for (const step of [`${appPath}/jobs`, path]) {
      const absolute = join(this.#root, step);
      if ((await directoryState(absolute, step)) === 'missing') {
        if (!create) {
          throw new FactoryJobError('not_found', `Job "${jobId}" of app "${appId}" does not exist.`);
        }
        await mkdir(absolute, { mode: 0o700 });
      }
    }
    return { dir: join(this.#root, path), path };
  }
}

// Reads a regular file without following symlinks; undefined when it does not exist.
export async function readJobFile(job: JobDir, name: string, maxBytes: number): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(join(job.dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return undefined;
    }
    if (code === 'ELOOP') {
      throw new FactoryJobError('forbidden_path', `${job.path}/${name} is a symlink.`);
    }
    throw new FactoryJobError('io_failed', `${job.path}/${name} could not be opened (${code ?? 'unknown error'}).`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new FactoryJobError('forbidden_path', `${job.path}/${name} is not a regular file.`);
    }
    if (stats.size > maxBytes) {
      throw new FactoryJobError('too_large', `${job.path}/${name} is larger than ${maxBytes} bytes.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function jobFileExists(job: JobDir, name: string): Promise<boolean> {
  try {
    await lstat(join(job.dir, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

// Writes a complete temp file (0600, fsynced) and then either links it to the
// name, failing with 'conflict' if the name exists, or renames it over the name.
export async function writeJobFile(job: JobDir, name: string, data: Buffer, mode: 'create' | 'replace'): Promise<void> {
  const tempPath = join(job.dir, `.${name}.${randomUUID()}.tmp`);
  const target = join(job.dir, name);
  try {
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode === 'create') {
      try {
        await link(tempPath, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new FactoryJobError('conflict', `${job.path}/${name} already exists.`);
        }
        throw error;
      }
    } else {
      await rename(tempPath, target);
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}
