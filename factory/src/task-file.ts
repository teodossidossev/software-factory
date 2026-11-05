// Task files: <work_checkout>/.software-factory/<ticket>.md, kept out of Git through the
// repository-local .git/info/exclude (never .gitignore).
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import { TERMINAL_STATES, type JobStore } from './jobs.js';
import { type Workspace, WORKSPACE_NAME_PATTERN } from './registry.js';

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

// A ticket this one lands after (SF-084): its workspace and its name.
export interface TicketRef {
  workspace: string;
  ticket: string;
}

// The tickets the Task waits for (SF-084): `lands_after:` in the front matter, in the forms of
// may_touch, each entry `<ticket>` (in workspace, this Task's own) or `<workspace>/<ticket>`.
// Entries that name no valid workspace or ticket are dropped (they could not be looked up safely),
// and each ticket is listed once.
export function landsAfter(fields: Map<string, string>, workspace: string): TicketRef[] {
  const refs: TicketRef[] = [];
  for (const entry of pathList(fields, 'lands_after')) {
    const parts = entry.split('/');
    const ref = parts.length === 1 ? { workspace, ticket: parts[0]! } : parts.length === 2 ? { workspace: parts[0]!, ticket: parts[1]! } : undefined;
    if (ref === undefined || !WORKSPACE_NAME_PATTERN.test(ref.workspace) || !TICKET_PATTERN.test(ref.ticket)) {
      continue;
    }
    if (!refs.some((other) => other.workspace === ref.workspace && other.ticket === ref.ticket)) {
      refs.push(ref);
    }
  }
  return refs;
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

// write_task is refused while a job for the ticket exists in a non-terminal state, paused aside
// (SF-067): the Task file changes while the job is paused, and Resume hands the change on.
export async function refuseWhileJobRunning(workspace: Workspace, ticket: string, jobs: JobStore): Promise<void> {
  const job = await jobs.read(workspace.name, ticket);
  if (job !== undefined && !TERMINAL_STATES.includes(job.state) && job.state !== 'paused') {
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

// Records a write of the Task file in the ticket's history (SF-081), given the sha256 of the text
// written; called inside the write's serialized section, so the history follows the file's order.
export type RecordWrite = (sha256: string) => Promise<unknown>;

// A failed history append does not undo or fail the write that happened: it is logged.
async function recordWrite(record: RecordWrite | undefined, sha256: string): Promise<void> {
  try {
    await record?.(sha256);
  } catch (error) {
    console.error(error);
  }
}

// expectedSha256 (the page's Save, SF-081): the sha256 of the version the edit started from; the
// write is refused with task_changed when the file is another version now (or task_not_found when
// it is gone), so a concurrent write is never overwritten unseen. record: see RecordWrite.
export interface WriteTaskOptions {
  expectedSha256?: string;
  record?: RecordWrite;
}

export function writeTask(workspace: Workspace, ticket: string, content: string, jobs: JobStore, options: WriteTaskOptions = {}): Promise<WriteTaskResult> {
  return serialized(async () => {
    if (!TICKET_PATTERN.test(ticket)) {
      throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
    }
    const buffer = checkTaskContent(ticket, content);
    await refuseWhileJobRunning(workspace, ticket, jobs);
    if (options.expectedSha256 !== undefined) {
      const current = await readTaskRaw(workspace, ticket);
      if (taskSha256(current) !== options.expectedSha256) {
        throw new FactoryError('task_changed', `${TASK_DIR}/${ticket}.md changed since this version was read; reload it before saving.`);
      }
    }
    const result = await writeTaskFile(workspace, ticket, buffer);
    await recordWrite(options.record, result.sha256);
    return result;
  });
}

// The Task file's text (or its archived copy's) as it is on disk, unvalidated; a missing file is
// task_not_found, anything but a regular file forbidden_path.
async function readTaskRaw(workspace: Workspace, ticket: string, archived = false): Promise<string> {
  const path = archived ? `${TASK_DIR}/${ARCHIVE_DIR}/${ticket}.md` : `${TASK_DIR}/${ticket}.md`;
  const stats = await lstatOrMissing(join(workspace.workCheckout, path));
  if (stats === undefined) {
    throw new FactoryError('task_not_found', `${path} does not exist in the work checkout of "${workspace.name}".`);
  }
  if (!stats.isFile()) {
    throw new FactoryError('forbidden_path', `${path} is not a regular file.`);
  }
  return readFile(join(workspace.workCheckout, path), 'utf8');
}

// The sha256 of a Task file's text (SF-067): what a job records of the version it was given.
export function taskSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// The bound of a Task file diff (SF-067) in bytes; a longer one is not sent.
export const MAX_TASK_DIFF_BYTES = 64 * 1024;

// The unified diff of the ticket's Task file from before to after (SF-067), with the file's own
// path in its header (a/ and b/ .software-factory/<ticket>.md); undefined when Git cannot make one
// or it is longer than MAX_TASK_DIFF_BYTES.
export async function taskDiff(ticket: string, before: string, after: string): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'sf-task-diff-'));
  try {
    await mkdir(join(dir, 'a'));
    await mkdir(join(dir, 'b'));
    await writeFile(join(dir, 'a', `${ticket}.md`), before, 'utf8');
    await writeFile(join(dir, 'b', `${ticket}.md`), after, 'utf8');
    // Exit code 1: the files differ.
    const result = await runGit(dir, ['diff', '--no-index', '--no-color', '--no-ext-diff', '-U3', '--', `a/${ticket}.md`, `b/${ticket}.md`], MAX_TASK_DIFF_BYTES + 4096);
    if (result.code !== 1 || result.truncated) {
      return undefined;
    }
    const lines = result.stdout.toString('utf8').split('\n');
    const first = lines.findIndex((line) => line.startsWith('@@'));
    if (first < 0) {
      return undefined;
    }
    const diff = [`--- a/${TASK_DIR}/${ticket}.md`, `+++ b/${TASK_DIR}/${ticket}.md`, ...lines.slice(first)].join('\n').replace(/\n$/, '');
    return Buffer.byteLength(diff, 'utf8') > MAX_TASK_DIFF_BYTES ? undefined : diff;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Reads the Task file of the work checkout (or its archived copy) and returns its validated text.
export async function readTask(workspace: Workspace, ticket: string, archived = false): Promise<string> {
  const content = await readTaskRaw(workspace, ticket, archived);
  checkTaskContent(ticket, content);
  return content;
}

// Appends "## Fix N" to the Task file, keeping its existing content; returns the new text. A title
// goes after the number: "## Fix N: <title>" (SF-055, Simplify). record: see RecordWrite.
export function appendFix(workspace: Workspace, ticket: string, fix: number, content: string, title?: string, options: { record?: RecordWrite } = {}): Promise<string> {
  return serialized(async () => {
    if (content.includes('\0') || /\p{Surrogate}/u.test(content) || content.length === 0 || Buffer.byteLength(content, 'utf8') > MAX_FIX_BYTES) {
      throw new FactoryError('invalid_content', `content must be 1 to ${MAX_FIX_BYTES} bytes of well-formed UTF-8 without NUL characters.`);
    }
    const text = `${await readTask(workspace, ticket)}\n\n## Fix ${fix}${title !== undefined ? `: ${title}` : ''}\n\n${content}\n`;
    const result = await writeTaskFile(workspace, ticket, checkTaskContent(ticket, text));
    await recordWrite(options.record, result.sha256);
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
