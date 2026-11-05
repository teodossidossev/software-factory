// The images of a ticket (SF-064): .software-factory/<ticket>/<name> in the work checkout, next to
// the Task file (kept out of Git with the folder). One set of rules for the dashboard, the CLI and
// the MCP tools: the type from the magic bytes only (PNG, JPEG, WebP, GIF), at most
// MAX_ATTACHMENT_BYTES each and MAX_ATTACHMENTS per ticket, names of ATTACHMENT_NAME_PATTERN with
// the extension of the detected type, the active Task file required, and the guard of write_task
// (no change while a job of the ticket runs, paused aside). Nothing here reads or writes outside
// the ticket's folder.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import type { JobStore } from './jobs.js';
import type { Workspace } from './registry.js';
import { ARCHIVE_DIR, refuseWhileJobRunning, TASK_DIR, TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const ATTACHMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|jpg|webp|gif)$/;
export const ATTACHMENT_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as const;
export type AttachmentExtension = keyof typeof ATTACHMENT_TYPES;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[AttachmentExtension];

export interface Attachment {
  name: string;
  bytes: number;
  type: AttachmentType;
}

// The bytes a type is told by: 12 cover every signature.
const HEAD_BYTES = 12;
// An automatic name: a number, the highest one in the folder + 1. Any number a valid name allows
// (up to 64 digits) counts, read as a BigInt so none loses precision.
const NUMBERED = /^(\d+)\.(png|jpg|webp|gif)$/;

const startsWith = (data: Uint8Array, bytes: number[], at = 0): boolean => data.length >= at + bytes.length && bytes.every((byte, index) => data[at + index] === byte);
const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

// The type of an image from its first bytes, as the extension its name must have; undefined for
// anything else.
export function sniffExtension(data: Uint8Array): AttachmentExtension | undefined {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'png';
  }
  if (startsWith(data, [0xff, 0xd8, 0xff])) {
    return 'jpg';
  }
  if (startsWith(data, ascii('GIF87a')) || startsWith(data, ascii('GIF89a'))) {
    return 'gif';
  }
  if (startsWith(data, ascii('RIFF')) && startsWith(data, ascii('WEBP'), 8)) {
    return 'webp';
  }
  return undefined;
}

// A ticket that can have attachments: a valid key, not the archive folder's name, not ending in
// ".md" (its folder would look like a Task file).
export function canHaveAttachments(ticket: string): boolean {
  return TICKET_PATTERN.test(ticket) && ticket !== ARCHIVE_DIR && !ticket.endsWith('.md');
}

function checkTicket(ticket: string): void {
  if (!canHaveAttachments(ticket)) {
    throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}, not "${ARCHIVE_DIR}" and not ending in ".md".`);
  }
}

// A valid attachment name; with ext, its extension must be that type's.
function checkName(name: string, ext?: AttachmentExtension): void {
  const match = ATTACHMENT_NAME_PATTERN.exec(name);
  if (match === null) {
    throw new FactoryError('invalid_name', 'An attachment name is 1-64 characters of A-Z, a-z, 0-9, ".", "_" and "-", starting with a letter or digit, then .png, .jpg, .webp or .gif.');
  }
  if (ext !== undefined && match[1] !== ext) {
    throw new FactoryError('invalid_name', `The image is ${ATTACHMENT_TYPES[ext]}: its name must end in .${ext}.`);
  }
}

// At most MAX_ATTACHMENT_BYTES; also for a file the CLI has not read yet.
export function checkSize(bytes: number): void {
  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw new FactoryError('attachment_too_large', `An image must be at most ${MAX_ATTACHMENT_BYTES} bytes (5 MB).`);
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

// The checkout-relative path of the ticket's folder, for messages.
const folderPath = (ticket: string): string => `${TASK_DIR}/${ticket}`;

// The active Task file must exist (and .software-factory be a plain directory).
async function requireTask(workspace: Workspace, ticket: string): Promise<void> {
  const dir = await lstatOrMissing(join(workspace.workCheckout, TASK_DIR));
  const file = dir?.isDirectory() === true ? await lstatOrMissing(join(workspace.workCheckout, TASK_DIR, `${ticket}.md`)) : undefined;
  if (file?.isFile() !== true) {
    throw new FactoryError('task_not_found', `${TASK_DIR}/${ticket}.md does not exist in the work checkout of "${workspace.name}".`);
  }
}

// The ticket's folder, or undefined when it does not exist; anything but a plain directory is
// forbidden_path.
async function folderOf(workspace: Workspace, ticket: string): Promise<string | undefined> {
  const dir = join(workspace.workCheckout, TASK_DIR, ticket);
  const stats = await lstatOrMissing(dir);
  if (stats === undefined) {
    return undefined;
  }
  if (!stats.isDirectory()) {
    throw new FactoryError('forbidden_path', `${folderPath(ticket)} is not a plain directory.`);
  }
  return dir;
}

// The first bytes of a regular file, never through a symbolic link.
async function headOf(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// The attachments in a folder: the regular files whose names match the pattern and whose type is
// detected and matches the extension, in natural order (2.png before 10.png); anything else is
// ignored. The names of every entry too, for the next number and a name taken.
async function scan(dir: string | undefined): Promise<{ attachments: Attachment[]; names: string[] }> {
  if (dir === undefined) {
    return { attachments: [], names: [] };
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const attachments: Attachment[] = [];
  for (const entry of entries) {
    const match = ATTACHMENT_NAME_PATTERN.exec(entry.name);
    if (match === null || !entry.isFile()) {
      continue;
    }
    try {
      const path = join(dir, entry.name);
      const ext = sniffExtension(await headOf(path));
      const stats = await lstat(path);
      if (ext !== undefined && ext === match[1] && stats.isFile()) {
        attachments.push({ name: entry.name, bytes: stats.size, type: ATTACHMENT_TYPES[ext] });
      }
    } catch {
      // Gone or replaced meanwhile: not an attachment.
    }
  }
  attachments.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  return { attachments, names: entries.map((entry) => entry.name) };
}

// The next automatic name: the highest number in the folder + 1 (a gap is not reused).
function nextName(names: string[], ext: AttachmentExtension): string {
  let highest = 0n;
  for (const name of names) {
    const match = NUMBERED.exec(name);
    if (match !== null && ATTACHMENT_NAME_PATTERN.test(name)) {
      const number = BigInt(match[1]!);
      highest = number > highest ? number : highest;
    }
  }
  const next = `${highest + 1n}.${ext}`;
  if (!ATTACHMENT_NAME_PATTERN.test(next)) {
    throw new FactoryError('invalid_name', `The next number after ${highest} is too long for a name; give the image a name.`);
  }
  return next;
}

// One change at a time in this process, so two adds cannot both pass the count.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(work);
  queue = next;
  return next;
}

// The attachments of a ticket whose Task file exists.
export async function listAttachments(workspace: Workspace, ticket: string): Promise<Attachment[]> {
  checkTicket(ticket);
  await requireTask(workspace, ticket);
  return (await scan(await folderOf(workspace, ticket))).attachments;
}

// Adds one image under name, or the next number when name is undefined.
export function addAttachment(workspace: Workspace, ticket: string, data: Uint8Array, jobs: JobStore, name?: string): Promise<Attachment> {
  return serialized(async () => {
    checkTicket(ticket);
    await requireTask(workspace, ticket);
    await refuseWhileJobRunning(workspace, ticket, jobs, 'its images cannot be changed now');
    checkSize(data.byteLength);
    const ext = sniffExtension(data);
    if (ext === undefined) {
      throw new FactoryError('attachment_type', 'Only PNG, JPEG, WebP and GIF images can be attached (told by their first bytes, not their name).');
    }
    if (name !== undefined) {
      checkName(name, ext);
    }
    let dir = await folderOf(workspace, ticket);
    if (dir === undefined) {
      dir = join(workspace.workCheckout, TASK_DIR, ticket);
      await mkdir(dir, { mode: 0o700 });
    }
    const { attachments, names } = await scan(dir);
    if (attachments.length >= MAX_ATTACHMENTS) {
      throw new FactoryError('attachment_limit', `A ticket has at most ${MAX_ATTACHMENTS} images; remove one first.`);
    }
    const chosen = name ?? nextName(names, ext);
    if (names.includes(chosen)) {
      throw new FactoryError('invalid_name', `${folderPath(ticket)}/${chosen} already exists; remove it first or choose another name.`);
    }
    await writeFileAtomic(join(dir, chosen), Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    return { name: chosen, bytes: data.byteLength, type: ATTACHMENT_TYPES[ext] };
  });
}

// Removes one file of the ticket's folder by its name (an attachment, or a file with an
// attachment's name that is none).
export function removeAttachment(workspace: Workspace, ticket: string, name: string, jobs: JobStore): Promise<{ name: string }> {
  return serialized(async () => {
    checkTicket(ticket);
    await requireTask(workspace, ticket);
    await refuseWhileJobRunning(workspace, ticket, jobs, 'its images cannot be changed now');
    checkName(name);
    const dir = await folderOf(workspace, ticket);
    const stats = dir === undefined ? undefined : await lstatOrMissing(join(dir, name));
    if (dir === undefined || stats === undefined) {
      throw new FactoryError('attachment_missing', `${folderPath(ticket)}/${name} does not exist.`);
    }
    if (!stats.isFile()) {
      throw new FactoryError('forbidden_path', `${folderPath(ticket)}/${name} is not a regular file.`);
    }
    await rm(join(dir, name));
    return { name };
  });
}

// Reads one attachment: its bytes and its type, the type told by its bytes and matching its name.
export async function readAttachment(workspace: Workspace, ticket: string, name: string): Promise<Attachment & { data: Buffer }> {
  checkTicket(ticket);
  await requireTask(workspace, ticket);
  checkName(name);
  const dir = await folderOf(workspace, ticket);
  const missing = new FactoryError('attachment_missing', `${folderPath(ticket)}/${name} does not exist.`);
  if (dir === undefined) {
    throw missing;
  }
  let handle;
  try {
    handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw missing;
    }
    if (code === 'ELOOP') {
      throw new FactoryError('forbidden_path', `${folderPath(ticket)}/${name} is not a regular file.`);
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new FactoryError('forbidden_path', `${folderPath(ticket)}/${name} is not a regular file.`);
    }
    checkSize(stats.size);
    const data = await handle.readFile();
    checkSize(data.byteLength);
    const ext = sniffExtension(data);
    if (ext === undefined || ext !== ATTACHMENT_NAME_PATTERN.exec(name)![1]) {
      throw new FactoryError('attachment_type', `${folderPath(ticket)}/${name} is not the image its name says.`);
    }
    return { name, bytes: data.byteLength, type: ATTACHMENT_TYPES[ext], data };
  } finally {
    await handle.close();
  }
}

// The targets of the Markdown images ![…](<target>) outside fenced code blocks: the text after
// "(" up to the first space or ")", as written (no "./" normalisation).
export function imageTargets(content: string): string[] {
  const targets: string[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of content.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker !== null) {
      const char = marker[1]![0]!;
      const length = marker[1]!.length;
      if (fence === undefined) {
        // A backtick fence's info string has no backtick.
        if (char === '~' || !line.slice(marker[0].length).includes('`')) {
          fence = { char, length };
        }
        continue;
      }
      if (char === fence.char && length >= fence.length && line.slice(marker[0].length).trim() === '') {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) {
      continue;
    }
    for (const match of line.matchAll(/!\[[^\]]*\]\(([^\s)]*)/g)) {
      targets.push(match[1]!);
    }
  }
  return targets;
}

// The attachment names a Task file of ticket refers to (targets starting with "<ticket>/") that the
// ticket's folder does not have, each once, in the order of the text. Other targets are not
// attachments and are not checked.
export async function missingAttachments(workspace: Workspace, ticket: string, content: string): Promise<string[]> {
  const prefix = `${ticket}/`;
  const wanted = [...new Set(imageTargets(content).filter((target) => target.startsWith(prefix)).map((target) => target.slice(prefix.length)))];
  if (wanted.length === 0) {
    return [];
  }
  const present = canHaveAttachments(ticket) ? (await scan(await folderOf(workspace, ticket))).attachments.map((attachment) => attachment.name) : [];
  return wanted.filter((name) => !present.includes(name));
}
