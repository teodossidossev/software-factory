// The images of a ticket: .software-factory/<ticket>/<name> in the work checkout, next to
// the Task file (kept out of Git with the folder). One set of rules for the dashboard, the CLI and
// the MCP tools: the type from the magic bytes only (PNG, JPEG, WebP, GIF), at most
// MAX_ATTACHMENT_BYTES each and MAX_ATTACHMENTS per ticket, names of ATTACHMENT_NAME_PATTERN with
// the extension of the detected type, the active Task file required, and the guard of write_task
// (no change while a job of the ticket runs, paused aside). Nothing here reads or writes outside
// the ticket's folder.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
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
  return imageReferences(content).map((reference) => reference.target);
}

// The attachment names a Task file of ticket refers to (attachmentReferences: valid <ticket>/<name>
// targets outside fenced code, each once, in the order of the text) that the ticket's folder does
// not have. Every other target ("./", a nested path, "..", another ticket's, a URL, an invalid
// name) is no attachment and is not checked.
export async function missingAttachments(workspace: Workspace, ticket: string, content: string): Promise<string[]> {
  const wanted = attachmentReferences(ticket, content).map((reference) => reference.name);
  if (wanted.length === 0) {
    return [];
  }
  const present = canHaveAttachments(ticket) ? (await scan(await folderOf(workspace, ticket))).attachments.map((attachment) => attachment.name) : [];
  return wanted.filter((name) => !present.includes(name));
}

// ---------------------------------------------------------------------------------------------
// The images a job gives its agents: the attachments the Task file refers to, resolved at
// Start, Restart and every Resume, copied into the job directory (the job's own copy, which the
// factory reads for the image blocks, the gate and the hashes) and into the worktree.

// One image reference of a Task file: an attachment name and the alt text of its first reference.
export interface AttachmentReference {
  name: string;
  alt: string;
}

// The Markdown images ![alt](<target>) outside fenced code blocks, as imageTargets reads them, with
// their alt texts.
function imageReferences(content: string): Array<{ alt: string; target: string }> {
  const references: Array<{ alt: string; target: string }> = [];
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
    for (const match of line.matchAll(/!\[([^\]]*)\]\(([^\s)]*)/g)) {
      references.push({ alt: match[1]!, target: match[2]! });
    }
  }
  return references;
}

// The attachments a Task file of ticket refers to: the targets "<ticket>/<name>" whose name matches
// ATTACHMENT_NAME_PATTERN, each once, at its first reference, in the order of the text. Every other
// target ("./", a nested path, another ticket's folder, "..", a URL) is no attachment and ignored.
export function attachmentReferences(ticket: string, content: string): AttachmentReference[] {
  const prefix = `${ticket}/`;
  const seen = new Map<string, AttachmentReference>();
  for (const { alt, target } of imageReferences(content)) {
    const name = target.slice(prefix.length);
    if (target.startsWith(prefix) && ATTACHMENT_NAME_PATTERN.test(name) && !seen.has(name)) {
      seen.set(name, { name, alt });
    }
  }
  return [...seen.values()];
}

// The record of one image of a job (job.json's attachments, the attachments event): never its bytes.
export interface JobAttachment extends Attachment {
  sha256: string;
}

// One image resolved from a folder: its record, the alt text of its first reference, and its bytes.
export interface ResolvedImage extends JobAttachment {
  alt: string;
  data: Buffer;
}

// One image of a prompt (an Implementer turn, a review, the simplification pass, the Task check):
// its name and alt text, its type, and the absolute path of the file the factory reads (the job's
// copy, or the work checkout's folder for the Task check); ticket names it as <ticket>/<name>.
export interface ImageRef {
  ticket: string;
  name: string;
  alt: string;
  type: AttachmentType;
  path: string;
}

// The sha256 of bytes, in hex.
const sha256Of = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

// Why the file at path is no usable attachment of its name, or its bytes and type: a regular file
// (never through a symbolic link) of at most MAX_ATTACHMENT_BYTES whose type, told by its bytes,
// matches its name's extension.
async function readImage(path: string, name: string): Promise<{ data: Buffer; type: AttachmentType } | { reason: string }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : code === 'ELOOP' ? 'not a regular file' : 'not readable' };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return { reason: 'not a regular file' };
    }
    if (stats.size > MAX_ATTACHMENT_BYTES) {
      return { reason: `over ${MAX_ATTACHMENT_BYTES} bytes (5 MB)` };
    }
    const data = await handle.readFile();
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      return { reason: `over ${MAX_ATTACHMENT_BYTES} bytes (5 MB)` };
    }
    const ext = sniffExtension(data);
    if (ext === undefined || ext !== ATTACHMENT_NAME_PATTERN.exec(name)![1]) {
      return { reason: 'not the image its name says (PNG, JPEG, WebP or GIF, told by its bytes)' };
    }
    return { data, type: ATTACHMENT_TYPES[ext] };
  } catch {
    return { reason: 'not readable' };
  } finally {
    await handle.close();
  }
}

// The referenced images read from dir (the ticket's folder), in the order of the references.
// attachment_invalid, naming every image that cannot be used and why: a missing file, a wrong type,
// a file over MAX_ATTACHMENT_BYTES, or more than MAX_ATTACHMENTS images.
export async function resolveImages(dir: string, ticket: string, references: readonly AttachmentReference[]): Promise<ResolvedImage[]> {
  const images: ResolvedImage[] = [];
  const problems: string[] = [];
  for (const { name, alt } of references) {
    const read = await readImage(join(dir, name), name);
    if ('reason' in read) {
      problems.push(`${ticket}/${name}: ${read.reason}`);
    } else {
      images.push({ name, alt, type: read.type, bytes: read.data.byteLength, sha256: sha256Of(read.data), data: read.data });
    }
  }
  if (references.length > MAX_ATTACHMENTS) {
    problems.push(`${references.length} images are referenced; a ticket has at most ${MAX_ATTACHMENTS}`);
  }
  if (problems.length > 0) {
    throw new FactoryError('attachment_invalid', `The Task file refers to images that cannot be used: ${problems.join('; ')}.`);
  }
  return images;
}

// The images a Task file of ticket in the work checkout refers to, read from its folder
// (.software-factory/<ticket>/); [] without a reference. attachment_invalid as resolveImages.
export function resolveTaskImages(workCheckout: string, ticket: string, content: string): Promise<ResolvedImage[]> {
  const references = attachmentReferences(ticket, content);
  return references.length === 0 ? Promise.resolve([]) : resolveImages(join(workCheckout, TASK_DIR, ticket), ticket, references);
}

// The record of a resolved image, without its alt text and bytes.
export const jobAttachment = ({ name, type, bytes, sha256 }: JobAttachment): JobAttachment => ({ name, type, bytes, sha256 });

// Whether two sets of images are the same: the same names, in the same order, with the same hashes.
export function sameImages(a: readonly JobAttachment[], b: readonly JobAttachment[]): boolean {
  return a.length === b.length && a.every((image, index) => image.name === b[index]!.name && image.sha256 === b[index]!.sha256);
}

// The names of the images that changed from before to after: added, removed or with other bytes.
export function changedImages(before: readonly JobAttachment[], after: readonly JobAttachment[]): string[] {
  const old = new Map(before.map((image) => [image.name, image.sha256]));
  const now = new Set(after.map((image) => image.name));
  return [
    ...after.filter((image) => old.get(image.name) !== image.sha256).map((image) => image.name),
    ...before.filter((image) => !now.has(image.name)).map((image) => image.name),
  ];
}

// Writes the images into dir, which holds nothing else afterwards (the earlier copies go).
export async function writeImages(dir: string, images: readonly ResolvedImage[]): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const image of images) {
    await writeFileAtomic(join(dir, image.name), image.data);
  }
}

// The images of a job as prompt images: its records, their files in dir (the job's copy), and the
// alt texts of their first references in the Task text ('' for one it no longer names).
export function imageRefs(ticket: string, dir: string, attachments: readonly JobAttachment[], task: string): ImageRef[] {
  const alts = new Map(attachmentReferences(ticket, task).map((reference) => [reference.name, reference.alt]));
  return attachments.map(({ name, type }) => ({ ticket, name, alt: alts.get(name) ?? '', type, path: join(dir, name) }));
}

// The content of a user message with images: the prompt text, then per image a line naming it and
// its image block (base64, its media type), in order. The files are read here, when the message is
// sent.
export async function imageContent(prompt: string, images: readonly ImageRef[]): Promise<Array<Record<string, unknown>>> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
  for (const image of images) {
    const data = await readFile(image.path);
    content.push(
      { type: 'text', text: `Image ${image.ticket}/${image.name} ("${image.alt}"), referenced in the Task file:` },
      { type: 'image', source: { type: 'base64', media_type: image.type, data: data.toString('base64') } },
    );
  }
  return content;
}

// The prompt of a query(): the string itself without images; with images, one SDK user message
// with imageContent (the files read now, so a missing one fails here, not inside the SDK), given as
// a stream that stays open until done() (the turn's result, or its end), as the SDK keeps its input
// open for a string prompt.
export async function promptInput(prompt: string, images: readonly ImageRef[] | undefined): Promise<{ prompt: string | AsyncIterable<SDKUserMessage>; done: () => void }> {
  if (images === undefined || images.length === 0) {
    return { prompt, done: () => {} };
  }
  const content = await imageContent(prompt, images);
  let done = (): void => {};
  const ended = new Promise<void>((resolve) => {
    done = resolve;
  });
  async function* messages(): AsyncIterable<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: content as never }, parent_tool_use_id: null } as SDKUserMessage;
    await ended;
  }
  return { prompt: messages(), done: () => done() };
}

// A value as the factory logs it: every base64 image block's data replaced by a note of its length,
// so no image bytes reach events.jsonl (a Read of an image file returns one).
export function withoutImageData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutImageData);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  const source = record.source as Record<string, unknown> | undefined;
  if (record.type === 'image' && source !== null && typeof source === 'object' && typeof source.data === 'string') {
    return { ...record, source: { ...source, data: `[${source.data.length} base64 characters omitted]` } };
  }
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, withoutImageData(entry)]));
}

// The hash input of an image for the Task check: name:sha256 of its bytes, or name:missing
// when no regular file of that name can be read in dir.
export async function imageHashes(dir: string, references: readonly AttachmentReference[]): Promise<Array<{ name: string; sha256: string }>> {
  const hashes: Array<{ name: string; sha256: string }> = [];
  for (const { name } of references) {
    let sha256 = 'missing';
    try {
      const handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await handle.stat()).isFile()) {
          sha256 = sha256Of(await handle.readFile());
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Gone, a link or unreadable: missing.
    }
    hashes.push({ name, sha256 });
  }
  return hashes;
}
