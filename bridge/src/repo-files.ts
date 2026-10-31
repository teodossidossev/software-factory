// Read-only access to UTF-8 files of one repository working tree, for review
// through factory_read_file. Callers pass repository-relative paths only; the
// root is fixed at startup.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PAGE_BYTES = 16384;
export const MIN_PAGE_BYTES = 4;
export const MAX_PAGE_BYTES = 32768;
export const MAX_PATH_LENGTH = 4096;
const READ_CHUNK_BYTES = 65536;

export type RepoReadErrorCode =
  | 'invalid_path'
  | 'forbidden_path'
  | 'not_found'
  | 'unsupported_type'
  | 'unsupported_content'
  | 'too_large'
  | 'invalid_range'
  | 'read_failed';

// Messages never contain absolute host paths, only the caller's relative path.
export class RepoReadError extends Error {
  readonly code: RepoReadErrorCode;

  constructor(code: RepoReadErrorCode, message: string) {
    super(message);
    this.name = 'RepoReadError';
    this.code = code;
  }
}

export interface ReadFileRequest {
  path: string;
  offset?: number;
  max_bytes?: number;
}

export interface ReadFileResult {
  path: string;
  encoding: 'utf-8';
  bytes: number;
  sha256: string;
  offset: number;
  returned_bytes: number;
  text: string;
  next_offset: number | null;
}

// Resolves and validates the configured root once, at startup.
export async function resolveRepoRoot(configured: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(configured);
  } catch {
    throw new Error(`Repository root "${configured}" does not exist.`);
  }
  if (!(await stat(real)).isDirectory()) {
    throw new Error(`Repository root "${configured}" is not a directory.`);
  }
  return real;
}

const ALLOWED_ENV_NAMES = new Set(['.env.example', '.env.sample', '.env.template']);
const FORBIDDEN_NAMES = new Set(['.npmrc', '.netrc', '.git-credentials', 'id_rsa', 'id_ed25519']);
const FORBIDDEN_EXTENSIONS = ['.key', '.p12', '.pfx'];

// Minimal deny list for this tool and for SF-006 result exports; it is not a general secret detector.
export function isForbidden(relativePath: string): boolean {
  const segments = relativePath.split('/');
  if (segments.includes('.git')) {
    return true;
  }
  const name = segments[segments.length - 1] ?? '';
  if (name === '.env' || (name.startsWith('.env.') && !ALLOWED_ENV_NAMES.has(name))) {
    return true;
  }
  if (FORBIDDEN_NAMES.has(name)) {
    return true;
  }
  const lowerName = name.toLowerCase();
  return FORBIDDEN_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

// Syntactic checks only: no shell expansion, no URL decoding.
function normalizeRequestPath(path: string): string {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw new RepoReadError('invalid_path', `path must be 1 to ${MAX_PATH_LENGTH} characters long.`);
  }
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/')) {
    throw new RepoReadError('invalid_path', 'path must be a relative path using "/" without NUL or backslash.');
  }
  const segments = path.split('/');
  if (segments.includes('..')) {
    throw new RepoReadError('invalid_path', 'path must not contain ".." segments.');
  }
  const normalized = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
  if (normalized === '') {
    throw new RepoReadError('invalid_path', 'path must name a file inside the repository.');
  }
  return normalized;
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class RepoFiles {
  readonly #root: string;

  // root must already be resolved by resolveRepoRoot.
  constructor(root: string) {
    this.#root = root;
  }

  async read(request: ReadFileRequest): Promise<ReadFileResult> {
    const path = normalizeRequestPath(request.path);
    const offset = request.offset ?? 0;
    const maxBytes = request.max_bytes ?? DEFAULT_PAGE_BYTES;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RepoReadError('invalid_range', 'offset must be a non-negative integer.');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < MIN_PAGE_BYTES || maxBytes > MAX_PAGE_BYTES) {
      throw new RepoReadError('invalid_range', `max_bytes must be an integer from ${MIN_PAGE_BYTES} to ${MAX_PAGE_BYTES}.`);
    }

    const buffer = await this.#readWhole(path);
    let content: string;
    try {
      content = strictUtf8.decode(buffer);
    } catch {
      throw new RepoReadError('unsupported_content', `${path} is not valid UTF-8 text.`);
    }
    if (content.includes('\0')) {
      throw new RepoReadError('unsupported_content', `${path} contains NUL bytes and is not treated as text.`);
    }

    if (offset > buffer.length || isContinuationByte(buffer[offset])) {
      throw new RepoReadError(
        'invalid_range',
        `offset ${offset} is beyond the end of ${path} (${buffer.length} bytes) or inside a UTF-8 character.`,
      );
    }
    // Move the page end back to a character boundary; max_bytes >= 4 keeps the page non-empty.
    let end = Math.min(offset + maxBytes, buffer.length);
    while (end < buffer.length && isContinuationByte(buffer[end])) {
      end -= 1;
    }
    return {
      path,
      encoding: 'utf-8',
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      offset,
      returned_bytes: end - offset,
      text: strictUtf8.decode(buffer.subarray(offset, end)),
      next_offset: end < buffer.length ? end : null,
    };
  }

  // Applies the deny list to the requested path and to its symlink-free target,
  // and keeps the target inside the root by comparing path segments.
  async #resolve(path: string): Promise<string> {
    if (isForbidden(path)) {
      throw new RepoReadError('forbidden_path', `${path} is excluded from repository reads.`);
    }
    let real: string;
    try {
      real = await realpath(join(this.#root, path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new RepoReadError('not_found', `${path} does not exist.`);
      }
      throw new RepoReadError('read_failed', `${path} could not be resolved (${code ?? 'unknown error'}).`);
    }
    const inside = relative(this.#root, real);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new RepoReadError('forbidden_path', `${path} resolves outside the repository.`);
    }
    if (isForbidden(inside.split(sep).join('/'))) {
      throw new RepoReadError('forbidden_path', `${path} resolves to a file excluded from repository reads.`);
    }
    return real;
  }

  // Reads at most MAX_FILE_BYTES + 1 bytes, so a growing file cannot force an unbounded read.
  async #readWhole(path: string): Promise<Buffer> {
    const real = await this.#resolve(path);
    if (!(await stat(real)).isFile()) {
      throw new RepoReadError('unsupported_type', `${path} is not a regular file.`);
    }
    let handle;
    try {
      // O_NONBLOCK keeps a FIFO swapped in after the stat from blocking the open.
      handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch (error) {
      throw new RepoReadError('read_failed', `${path} could not be opened (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
    }
    try {
      if (!(await handle.stat()).isFile()) {
        throw new RepoReadError('unsupported_type', `${path} is not a regular file.`);
      }
      const chunks: Buffer[] = [];
      let length = 0;
      while (length <= MAX_FILE_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_FILE_BYTES + 1 - length));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
        if (bytesRead === 0) {
          break;
        }
        chunks.push(chunk.subarray(0, bytesRead));
        length += bytesRead;
      }
      if (length > MAX_FILE_BYTES) {
        throw new RepoReadError('too_large', `${path} is larger than ${MAX_FILE_BYTES} bytes.`);
      }
      return Buffer.concat(chunks, length);
    } finally {
      await handle.close();
    }
  }
}
