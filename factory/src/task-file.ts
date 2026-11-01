// Task files: <work_checkout>/.software-factory/<ticket>.md, kept out of Git through the
// repository-local .git/info/exclude (never .gitignore).
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import type { Workspace } from './registry.js';

export const TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const TICKET_DESCRIPTION = '1-64 characters of A-Z, a-z, 0-9, ".", "_" and "-", starting with a letter or digit';
export const MAX_TASK_BYTES = 256 * 1024;
export const TASK_DIR = '.software-factory';
const EXCLUDE_ENTRY = `${TASK_DIR}/`;
const EXCLUDE_EQUIVALENTS = new Set([TASK_DIR, `/${TASK_DIR}`, EXCLUDE_ENTRY, `/${EXCLUDE_ENTRY}`]);

export interface WriteTaskResult {
  path: string;
  status: 'created' | 'replaced';
  bytes: number;
  sha256: string;
}

// Reads the leading `---` block as `key: value` lines; a trailing ` # comment` and one pair
// of surrounding quotes are dropped from values.
export function parseFrontMatter(content: string): Map<string, string> | undefined {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') {
    return undefined;
  }
  const end = lines.indexOf('---', 1);
  if (end < 0) {
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (match) {
      const value = match[2]!.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
      fields.set(match[1]!, value);
    }
  }
  return fields;
}

// Validates the content of a Task file for ticket and returns its UTF-8 bytes.
export function checkTaskContent(ticket: string, content: string): Buffer {
  if (content.includes('\0') || /\p{Surrogate}/u.test(content)) {
    throw new FactoryError('invalid_content', 'content must be well-formed UTF-8 text without NUL characters.');
  }
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.byteLength < 1 || buffer.byteLength > MAX_TASK_BYTES) {
    throw new FactoryError('invalid_content', `content must be 1 to ${MAX_TASK_BYTES} bytes of UTF-8.`);
  }
  const fields = parseFrontMatter(content);
  if (fields === undefined) {
    throw new FactoryError('invalid_content', 'content must start with a front-matter block between two "---" lines.');
  }
  if (fields.get('ticket') !== ticket) {
    throw new FactoryError('invalid_content', `the front matter must contain "ticket: ${ticket}".`);
  }
  for (const key of ['title', 'base']) {
    if (!fields.get(key)) {
      throw new FactoryError('invalid_content', `the front matter must contain a non-empty "${key}:".`);
    }
  }
  return buffer;
}

// Seam for the execution subtask: write_task is refused while a job on this ticket is running.
// No job state exists yet, so nothing is running and every write is allowed.
export async function refuseWhileJobRunning(_workspace: Workspace, _ticket: string): Promise<void> {}

async function lstatOrMissing(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

// Appends ".software-factory/" to the repository's info/exclude once.
export async function ensureExcluded(workCheckout: string): Promise<void> {
  const result = await runGit(workCheckout, ['rev-parse', '--git-path', 'info/exclude']);
  const relativePath = result.stdout.toString('utf8').trim();
  if (result.code !== 0 || relativePath === '') {
    throw new FactoryError('workspace_invalid', 'Git could not locate info/exclude of the work checkout.');
  }
  const excludePath = resolve(workCheckout, relativePath);
  await mkdir(dirname(excludePath), { recursive: true });
  const stats = await lstatOrMissing(excludePath);
  if (stats !== undefined && !stats.isFile()) {
    throw new FactoryError('forbidden_path', 'info/exclude of the work checkout is not a regular file.');
  }
  const current = stats === undefined ? '' : await readFile(excludePath, 'utf8');
  if (current.split(/\r?\n/).some((line) => EXCLUDE_EQUIVALENTS.has(line.trim()))) {
    return;
  }
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  const handle = await open(excludePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(`${separator}${EXCLUDE_ENTRY}\n`);
  } finally {
    await handle.close();
  }
}

// One write at a time in this process, so concurrent calls cannot append the exclude twice.
let queue: Promise<unknown> = Promise.resolve();

export function writeTask(workspace: Workspace, ticket: string, content: string): Promise<WriteTaskResult> {
  const next = queue.catch(() => undefined).then(() => writeTaskNow(workspace, ticket, content));
  queue = next;
  return next;
}

async function writeTaskNow(workspace: Workspace, ticket: string, content: string): Promise<WriteTaskResult> {
  if (!TICKET_PATTERN.test(ticket)) {
    throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
  }
  const buffer = checkTaskContent(ticket, content);
  await refuseWhileJobRunning(workspace, ticket);
  await ensureExcluded(workspace.workCheckout);

  const dir = join(workspace.workCheckout, TASK_DIR);
  const dirStats = await lstatOrMissing(dir);
  if (dirStats === undefined) {
    await mkdir(dir, { mode: 0o700 });
  } else if (!dirStats.isDirectory()) {
    throw new FactoryError('forbidden_path', `${TASK_DIR} in the work checkout is not a plain directory.`);
  }
  const path = `${TASK_DIR}/${ticket}.md`;
  const target = join(workspace.workCheckout, path);
  const fileStats = await lstatOrMissing(target);
  if (fileStats !== undefined && !fileStats.isFile()) {
    throw new FactoryError('forbidden_path', `${path} is not a regular file.`);
  }
  await writeFileAtomic(target, buffer);
  return {
    path,
    status: fileStats === undefined ? 'created' : 'replaced',
    bytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}
