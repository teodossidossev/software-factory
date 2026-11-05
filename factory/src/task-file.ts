// Task files: <work_checkout>/.software-factory/<ticket>.md, kept out of Git through the
// repository-local .git/info/exclude (never .gitignore).
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import { TERMINAL_STATES, type JobStore } from './jobs.js';
import type { Workspace } from './registry.js';

export const TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const TICKET_DESCRIPTION = '1-64 characters of A-Z, a-z, 0-9, ".", "_" and "-", starting with a letter or digit';
export const MAX_TASK_BYTES = 256 * 1024;
export const TASK_DIR = '.software-factory';
// Archived Task files: .software-factory/archive/<ticket>.md (SF-027).
export const ARCHIVE_DIR = 'archive';
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

// A front matter list of paths or globs, as "[a, b]" or "a, b" (comma or whitespace separated).
function pathList(fields: Map<string, string>, key: string): string[] {
  const raw = (fields.get(key) ?? '').trim().replace(/^\[|\]$/g, '');
  return raw.split(/[,\s]+/).map((entry) => entry.trim().replace(/^(["'])(.*)\1$/, '$2')).filter((entry) => entry !== '');
}

// The sensitive paths or globs the Task file declares it is expected to change: `may_touch:` in
// the front matter.
export function mayTouch(fields: Map<string, string>): string[] {
  return pathList(fields, 'may_touch');
}

// The file scope of the Task (SF-053): `scope:` in the front matter, in the forms of may_touch, the
// files the ticket is expected to create, modify or delete, tests and docs included. Undefined when
// the Task declares none (no field, or an empty list): then nothing is checked.
export function taskScope(fields: Map<string, string>): string[] | undefined {
  const scope = pathList(fields, 'scope');
  return scope.length > 0 ? scope : undefined;
}

// The skeleton of a ticket created from the dashboard (SF-028), and the draft of SF-025: the
// Context owner has not written the Task yet, so no job may start on it.
export const DRAFT_MARKER = '## Status: waiting for the Context owner';
const OLD_DRAFT_MARKER = '## Status: draft';

export function isDraft(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === DRAFT_MARKER || line.trim() === OLD_DRAFT_MARKER);
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

export const MAX_FIX_BYTES = 64 * 1024;

// write_task is refused while a job for the ticket exists in a non-terminal state.
export async function refuseWhileJobRunning(workspace: Workspace, ticket: string, jobs: JobStore): Promise<void> {
  const job = await jobs.read(workspace.name, ticket);
  if (job !== undefined && !TERMINAL_STATES.includes(job.state)) {
    throw new FactoryError('job_active', `The job for ${workspace.name}/${ticket} is ${job.state}; the Task file cannot be replaced now.`);
  }
}

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

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(work);
  queue = next;
  return next;
}

export function writeTask(workspace: Workspace, ticket: string, content: string, jobs: JobStore): Promise<WriteTaskResult> {
  return serialized(async () => {
    if (!TICKET_PATTERN.test(ticket)) {
      throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
    }
    const buffer = checkTaskContent(ticket, content);
    await refuseWhileJobRunning(workspace, ticket, jobs);
    return writeTaskFile(workspace, ticket, buffer);
  });
}

// Reads the Task file of the work checkout (or its archived copy) and returns its validated text.
export async function readTask(workspace: Workspace, ticket: string, archived = false): Promise<string> {
  const path = archived ? `${TASK_DIR}/${ARCHIVE_DIR}/${ticket}.md` : `${TASK_DIR}/${ticket}.md`;
  const stats = await lstatOrMissing(join(workspace.workCheckout, path));
  if (stats === undefined) {
    throw new FactoryError('task_not_found', `${path} does not exist in the work checkout of "${workspace.name}".`);
  }
  if (!stats.isFile()) {
    throw new FactoryError('forbidden_path', `${path} is not a regular file.`);
  }
  const content = await readFile(join(workspace.workCheckout, path), 'utf8');
  checkTaskContent(ticket, content);
  return content;
}

// Appends "## Fix N" to the Task file, keeping its existing content; returns the new text. A title
// goes after the number: "## Fix N: <title>" (SF-055, Simplify).
export function appendFix(workspace: Workspace, ticket: string, fix: number, content: string, title?: string): Promise<string> {
  return serialized(async () => {
    if (content.includes('\0') || /\p{Surrogate}/u.test(content) || content.length === 0 || Buffer.byteLength(content, 'utf8') > MAX_FIX_BYTES) {
      throw new FactoryError('invalid_content', `content must be 1 to ${MAX_FIX_BYTES} bytes of well-formed UTF-8 without NUL characters.`);
    }
    const text = `${await readTask(workspace, ticket)}\n\n## Fix ${fix}${title !== undefined ? `: ${title}` : ''}\n\n${content}\n`;
    await writeTaskFile(workspace, ticket, checkTaskContent(ticket, text));
    return text;
  });
}

async function writeTaskFile(workspace: Workspace, ticket: string, buffer: Buffer): Promise<WriteTaskResult> {
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
