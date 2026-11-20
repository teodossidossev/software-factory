// The last review: a fresh read-only Agent SDK query() (the review's tools, isolation and sandbox,
// src/review.ts) that reads a change its reviewers found clean the way a review skill says (the
// workspace's last_review_skill), with the Task file, the Patch and the worktree as its input, and
// answers with a summary and comments that only advise. The skill's folder is copied (copySkill)
// and hashed, so every run of a job can read one fixed copy; the prompt takes the copy's text
// (skillMethod). Knows nothing about job states; the caller records and applies the outcome.
import { createHash, randomBytes } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { FactoryError } from './errors.js';
import { cutBuffer, MAX_REVIEW_PATCH_BYTES, type ReviewOptions, runStructuredSession, type StructuredOutcome } from './review.js';
import { MAX_SKILL_BLOCKS_BYTES } from './skills.js';
import { TASK_DIR } from './task-file.js';

// The reviewer name of the last review's records.
export const LAST_REVIEWER = 'last_review';
export const COMMENT_KINDS = ['change', 'question', 'follow_up'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];
// The comments kept of one answer, and the length a comment's text and the summary are cut at.
export const MAX_COMMENTS = 30;
export const MAX_COMMENT_CHARS = 1000;
export const MAX_SUMMARY_CHARS = 2000;
// The most files and bytes a skill folder may hold to be copied.
export const MAX_SKILL_FILES = 50;
export const MAX_SKILL_BYTES = 512 * 1024;
// The session is aborted past this time.
export const LAST_REVIEW_TIMEOUT_MS = 10 * 60_000;

const comment = z.strictObject({
  path: z.string().describe('The file the comment is about, relative to the repository.'),
  line: z.number().int().min(1).describe('The line of the file as the change leaves it (the + side of the Patch); 1 for the whole file.'),
  text: z.string().describe('The comment, as the review method writes one.'),
  kind: z.enum(COMMENT_KINDS).describe('change: ask for a change; question: ask why; follow_up: worth a later ticket, not this change.'),
});
export const lastReviewOutput = z.strictObject({
  summary: z.string().describe('One note on the whole change: what to raise with its author first, or that nothing stands out.'),
  comments: z.array(comment),
});
export type LastReviewOutput = z.output<typeof lastReviewOutput>;
// The schema sent as outputFormat: draft-07 without $schema, as the review's.
const { $schema: _draft, ...lastReviewSchema } = z.toJSONSchema(lastReviewOutput, { target: 'draft-7' });
export const LAST_REVIEW_SCHEMA: Record<string, unknown> = lastReviewSchema;

export interface LastReviewComment {
  id: string;
  path: string;
  line: number;
  text: string;
  kind: CommentKind;
}

// A copy of the skill folder: path, the folder the setting named when it was copied; sha256, the
// copy's hash (skillSha256); files, the count copied.
export interface SkillCopy {
  path: string;
  sha256: string;
  files: number;
}

// iterations/NNN/last-review.json: the comments kept (dropped: those past MAX_COMMENTS), or the
// error (timed_out: the session reached LAST_REVIEW_TIMEOUT_MS; skill null when no copy was made).
export type LastReviewRecord =
  | { reviewer: string; summary: string; comments: LastReviewComment[]; dropped: number; skill: SkillCopy; cost_usd: number | null; model: string | null; started_at: string; ended_at: string }
  | { reviewer: string; error: string; timed_out: boolean; skill: SkillCopy | null; started_at: string; ended_at: string };

// The text's first max characters, never splitting a surrogate pair; a cut text ends in "…".
function cutText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

// The answer as the factory keeps it: the first MAX_COMMENTS comments, with the ids C1, C2, … in
// order and paths without a leading "./" or "/"; texts and the summary cut at their limits.
export function lastReviewComments(output: LastReviewOutput): { summary: string; comments: LastReviewComment[]; dropped: number } {
  const kept = output.comments.slice(0, MAX_COMMENTS);
  return {
    summary: cutText(output.summary, MAX_SUMMARY_CHARS),
    comments: kept.map((item, index) => ({
      id: `C${index + 1}`, path: item.path.replace(/^(?:\.\/|\/)+/u, ''), line: item.line, text: cutText(item.text, MAX_COMMENT_CHARS), kind: item.kind,
    })),
    dropped: output.comments.length - kept.length,
  };
}

// The relative paths ('/'-separated, sorted) of the folder's regular files, recursively; symbolic
// links, other non-files and names starting with "." are skipped. A folder it would read that is a
// symbolic link (dir itself, or one swapped for a link while it walks) is refused, before readdir
// could follow it. Stops with over once there are more than limit.
async function regularFiles(dir: string, limit = Number.POSITIVE_INFINITY): Promise<{ files: string[]; over: boolean }> {
  const files: string[] = [];
  const walk = async (relative: string): Promise<boolean> => {
    // Without a trailing "/", with which lstat would follow a link.
    const folder = relative === '' ? dir.replace(/(?<=.)\/+$/u, '') : join(dir, relative);
    if ((await lstat(folder)).isSymbolicLink()) {
      throw new Error(`${folder} is a symbolic link`);
    }
    const entries: Dirent[] = await readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (entry.isDirectory() && !(await walk(path))) {
        return false;
      }
      if (entry.isFile()) {
        files.push(path);
        if (files.length > limit) {
          return false;
        }
      }
    }
    return true;
  };
  const complete = await walk('');
  return { files: files.sort(), over: !complete };
}

// A regular file's bytes, never through a symbolic link (O_NOFOLLOW); refused when the path is not
// a regular file, and with a RangeError, before anything is read, when it has more than maxBytes.
async function readRegular(path: string, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`${path} is not a regular file`);
    }
    if (stats.size > maxBytes) {
      throw new RangeError(`${path} has more than ${maxBytes} bytes`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// Copies the folder's regular files (regularFiles) into dest, through a temporary folder next to it
// renamed to dest once complete (a copy already at dest is moved aside first, then removed). Refused
// with last_review_skill, nothing left at dest, when the folder has no regular SKILL.md at its top,
// holds more than MAX_SKILL_FILES files or MAX_SKILL_BYTES bytes, or cannot be read.
export async function copySkill(source: string, dest: string): Promise<SkillCopy> {
  const refuse = (what: string): FactoryError => new FactoryError('last_review_skill', `The last review's skill folder ${source} ${what}.`);
  const tooLarge = `holds more than ${MAX_SKILL_FILES} files or ${MAX_SKILL_BYTES / 1024} KiB`;
  const cause = (error: unknown): FactoryError => refuse(`could not be read: ${(error instanceof Error ? error.message : String(error)).replace(/\.+$/u, '')}`);
  let listed: { files: string[]; over: boolean };
  try {
    listed = await regularFiles(source, MAX_SKILL_FILES);
  } catch (error) {
    throw cause(error);
  }
  if (listed.over) {
    throw refuse(tooLarge);
  }
  // regularFiles lists regular files only: a SKILL.md that is a link or a folder is not there.
  if (!listed.files.includes('SKILL.md')) {
    throw refuse('has no SKILL.md');
  }
  const contents: Array<[string, Buffer]> = [];
  let bytes = 0;
  for (const path of listed.files) {
    let content: Buffer;
    try {
      content = await readRegular(join(source, path), MAX_SKILL_BYTES - bytes);
    } catch (error) {
      throw error instanceof RangeError ? refuse(tooLarge) : cause(error);
    }
    bytes += content.length;
    if (bytes > MAX_SKILL_BYTES) {
      throw refuse(tooLarge);
    }
    contents.push([path, content]);
  }
  const temp = join(dirname(dest), `.${basename(dest)}.${process.pid}.${randomBytes(4).toString('hex')}`);
  const old = `${temp}.old`;
  try {
    for (const [path, content] of contents) {
      await mkdir(dirname(join(temp, path)), { recursive: true });
      await writeFile(join(temp, path), content);
    }
    await rename(dest, old).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
    await rename(temp, dest);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  await rm(old, { recursive: true, force: true });
  return { path: source, sha256: await skillSha256(dest), files: contents.length };
}

// The hex SHA-256 of the folder's regular files (regularFiles) in path order: each file's relative
// path, a NUL, its size in decimal, a NUL and its bytes. Depends on names and bytes only.
export async function skillSha256(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const path of (await regularFiles(dir)).files) {
    const content = await readRegular(join(dir, path));
    hash.update(`${path}\0${content.length}\0`).update(content);
  }
  return hash.digest('hex');
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

// The file's text, or undefined when it holds a NUL byte or is not valid UTF-8.
function textOf(content: Buffer): string | undefined {
  if (content.includes(0)) {
    return undefined;
  }
  try {
    return UTF8.decode(content);
  } catch { // not valid UTF-8: the file is left out of the method and named
    return undefined;
  }
}

// The method the prompt takes from a skill folder (the job's copy): SKILL.md's body without its
// front matter, then each other file in path order in a <skill_file> block. A file that is not
// text, or that would bring the text past MAX_SKILL_BLOCKS_BYTES, is left out and named in omitted;
// later files are still tried.
export async function skillMethod(dir: string): Promise<{ text: string; omitted: string[] }> {
  const files = (await regularFiles(dir)).files;
  const ordered = [...files.filter((path) => path === 'SKILL.md'), ...files.filter((path) => path !== 'SKILL.md')];
  const parts: string[] = [];
  const omitted: string[] = [];
  let bytes = 0;
  for (const path of ordered) {
    const text = textOf(await readRegular(join(dir, path)));
    const part = text === undefined ? undefined
      : path === 'SKILL.md' ? text.replace(/^---\r?\n[\s\S]*?\r?\n---[^\S\n]*(?:\r?\n|$)/, '').trim()
      : `<skill_file path="${path}">\n${text.trimEnd()}\n</skill_file>`;
    if (part === '') {
      continue;
    }
    const size = part === undefined ? 0 : Buffer.byteLength(part) + (parts.length > 0 ? 2 : 0);
    if (part === undefined || bytes + size > MAX_SKILL_BLOCKS_BYTES) {
      omitted.push(path);
      continue;
    }
    parts.push(part);
    bytes += size;
  }
  return { text: parts.join('\n\n'), omitted };
}

export interface LastReviewInput {
  ticket: string;
  iteration: number;
  // The Task file (the factory's copy).
  task: string;
  // The job's whole change: the clean iteration's Patch, against the job's base.
  patch: Buffer;
  // The published Patch was cut at its size limit.
  patchTruncated: boolean;
  // The skill's text (skillMethod).
  method: { text: string; omitted: string[] };
}

// The prompt of the last review: what it reads and answers, then the review method, the Task file
// and the Patch.
export function lastReviewPrompt(input: LastReviewInput): string {
  const { ticket } = input;
  const cut = input.patch.length > MAX_REVIEW_PATCH_BYTES;
  const notes: string[] = [];
  if (cut) {
    notes.push(`The Patch has ${input.patch.length} bytes; only the first ${MAX_REVIEW_PATCH_BYTES} are below. Read the changed files in the worktree for the rest.`);
  }
  if (input.patchTruncated) {
    notes.push('The published Patch was cut at its size limit. Read the changed files in the worktree for the rest.');
  }
  const omitted = input.method.omitted;
  return [
    `Last review of ticket ${ticket}, iteration ${input.iteration}: its reviewers found the change clean. You read; you change nothing.`,
    "The current directory is the job's worktree: it holds the change, not committed. The factory may commit and rebase it while you read: take each line number from the Patch below (its + side), not from the files. Your tools are Read, Grep and Glob; nothing else is available.",
    "Review the change the way the review method below says. Your comments are advice for the user, who chooses which go to the change's author; none of them blocks the change.",
    '- Do not spawn sub-agents and ask nothing. Where the method says to run a command or to read a diff, read the Patch and the files instead.',
    '- Each comment: the path, the line of the file as the change leaves it (1 for the whole file), the text, and its kind: change (ask for a change), question (ask why), follow_up (worth a later ticket, not this change).',
    '- summary: one note on the whole change. No comment is a good answer when nothing stands out.',
    '- Answer only with the output schema.',
    '',
    '<review_method>',
    input.method.text.trimEnd(),
    ...(omitted.length > 0 ? [`(Left out of the method, over ${MAX_SKILL_BLOCKS_BYTES / 1024} KiB or not text: ${omitted.join(', ')}.)`] : []),
    '</review_method>',
    '',
    `<task_file path="${TASK_DIR}/${ticket}.md">`,
    input.task.trimEnd(),
    '</task_file>',
    '',
    ...notes.map((note) => `Note: ${note}`),
    '<patch>',
    (cut ? cutBuffer(input.patch, MAX_REVIEW_PATCH_BYTES) : input.patch.toString('utf8')).trimEnd(),
    '</patch>',
  ].join('\n');
}

// Runs the last review, aborted through its signal by options.signal or at LAST_REVIEW_TIMEOUT_MS
// (timedOut: a failed outcome the time limit, not options.signal, aborted). Never throws but its
// path denials' error (runStructuredSession).
export async function runLastReview(prompt: string, options: ReviewOptions): Promise<StructuredOutcome<LastReviewOutput> & { timedOut: boolean }> {
  const timeout = AbortSignal.timeout(LAST_REVIEW_TIMEOUT_MS);
  const outcome = await runStructuredSession(prompt, { ...options, signal: AbortSignal.any([options.signal, timeout]) }, {
    schema: LAST_REVIEW_SCHEMA, output: lastReviewOutput, noun: 'last review', outputNoun: 'answer',
  });
  return { ...outcome, timedOut: !outcome.ok && timeout.aborted && !options.signal.aborted };
}
