// A workspace's vision: its Markdown files in English (the source) and in Bulgarian (the
// translation), kept in the state directory as the folder one would commit, and the page built from
// them (src/vision-page.ts). The layout, folders 0700 and files 0600:
//   <state dir>/vision/<workspace>/<lang>/VISION.md, CODEMAP.md, chapters/<name>.md
//   <state dir>/vision/<workspace>/page.html, built from en and bg at each put and remove
// sf serve makes <state dir>/vision at its start, so that every agent session denies it; only the
// sf vision commands, run by sf serve one write at a time, change the store. A put checks the whole
// folder before it writes anything, and replaces a language's files all or nothing (two gaps: sf
// serve killed between the swap's two renames, and a failed write of page.html; see putVision).
// Every folder of the store is opened without following a link and reached through its handle,
// so no read or write follows a link put anywhere in it (inFolder).
// The dashboard serves page.html at vision/<workspace> (src/dashboard-reads.ts) and links it from
// the Workspaces drawer. Below the store, the sf vision commands of src/commands.ts's table (spread
// into its COMMANDS) and how the CLI prints their answers.
import { constants, mkdirSync } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import type { Answer, Command, Result } from './commands.js';
import { stateDir as serveStateDir } from './config.js';
import { FactoryError } from './errors.js';
import { localTime } from './local-time.js';
import { configDir, loadRegistry, WORKSPACE_NAME_PATTERN } from './registry.js';
import { VISION_LANGUAGES, type VisionLanguage, visionPage } from './vision-page.js';

export const VISION_DIR = 'vision';
export const VISION_FILE = 'VISION.md';
export const CODEMAP_FILE = 'CODEMAP.md';
export const CHAPTERS_DIR = 'chapters';
export const PAGE_FILE = 'page.html';
// A chapter's file name: a lower-case letter or digit, then up to 60 lower-case letters, digits or "-", then .md.
export const CHAPTER_PATTERN = /^[a-z0-9][a-z0-9-]{0,60}\.md$/;
export const MAX_VISION_CHAPTERS = 64;
export const MAX_VISION_FILE_BYTES = 512 * 1024;
export const MAX_VISION_BYTES = 2 * 1024 * 1024; // one language, its files together
// The page's own policy: a sandbox with scripts only (an opaque origin, without the dashboard's
// cookie, storage or API) that loads nothing.
export const VISION_PAGE_CSP = "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";

export interface StoredLanguage { lang: VisionLanguage; files: number; updated: string }
export interface VisionEntry { workspace: string; languages: StoredLanguage[] }
export interface VisionIndex { visions: VisionEntry[] }
export interface VisionPaths { stateDir: string; configDir: string }

export const visionRoot = (stateDir: string): string => join(stateDir, VISION_DIR);

// <state dir>/vision, and the state directory when it is missing, both 0700; nothing that exists changes.
export function ensureVisionRoot(stateDir: string): void {
  mkdirSync(visionRoot(stateDir), { recursive: true, mode: 0o700 });
}

// ------------------------------------------------------------------ the checks of a folder

const isLanguage = (lang: string): lang is VisionLanguage => (VISION_LANGUAGES as readonly string[]).includes(lang);

function checkLanguage(lang: string): VisionLanguage {
  if (!isLanguage(lang)) {
    throw new FactoryError('invalid_language', `The language must be bg or en, got ${JSON.stringify(lang.slice(0, 20))}.`);
  }
  return lang;
}

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? 'error';
// An entry's path relative to the folder, as the refusals write it.
const shown = (entry: string): string => JSON.stringify(entry.slice(0, 80));
const entryError = (entry: string, text: string): FactoryError => new FactoryError('vision_entry', `${shown(entry)}: ${text}`);
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

async function listed(dir: string) {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => byCodeUnit(a.name, b.name));
  } catch (error) {
    throw new FactoryError('vision_folder', `The folder cannot be read (${errorCode(error)}).`);
  }
}

// The files of a folder to put, by their paths relative to it (VISION.md, CODEMAP.md, chapters/<name>.md),
// checked by their listing: no link, no other name, the right kind.
async function folderPaths(dir: string): Promise<string[]> {
  if (!isAbsolute(dir) || dir.includes('\0')) {
    throw new FactoryError('vision_folder', 'The folder must be an absolute path: sf serve reads it, not your terminal. Give the whole path, such as "$PWD/vision".');
  }
  const paths: string[] = [];
  let chapters = false;
  for (const entry of await listed(dir)) {
    if (entry.isSymbolicLink()) {
      throw entryError(entry.name, 'a symbolic link; a vision holds plain files only.');
    }
    if (entry.name !== VISION_FILE && entry.name !== CODEMAP_FILE && entry.name !== CHAPTERS_DIR) {
      throw entryError(entry.name, `not part of a vision; its folder holds ${VISION_FILE}, ${CODEMAP_FILE} and ${CHAPTERS_DIR}/<name>.md only.`);
    }
    if (entry.name === CHAPTERS_DIR) {
      if (!entry.isDirectory()) {
        throw entryError(entry.name, 'not a folder.');
      }
      chapters = true;
    } else if (!entry.isFile()) {
      throw entryError(entry.name, 'not a regular file.');
    } else {
      paths.push(entry.name);
    }
  }
  const chapterPaths: string[] = [];
  for (const entry of chapters ? await listed(join(dir, CHAPTERS_DIR)) : []) {
    const path = `${CHAPTERS_DIR}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw entryError(path, 'a symbolic link; a vision holds plain files only.');
    }
    if (!CHAPTER_PATTERN.test(entry.name)) {
      throw entryError(path, 'not a chapter\'s name; it is a lower-case letter or digit, then up to 60 lower-case letters, digits or "-", then ".md".');
    }
    if (!entry.isFile()) {
      throw entryError(path, 'not a regular file.');
    }
    chapterPaths.push(path);
  }
  if (!paths.includes(VISION_FILE)) {
    throw new FactoryError('vision_entry', `${shown(VISION_FILE)}: missing; a vision needs it.`);
  }
  if (chapterPaths.length > MAX_VISION_CHAPTERS) {
    throw new FactoryError('vision_too_large', `The folder has ${chapterPaths.length} chapters; at most ${MAX_VISION_CHAPTERS}.`);
  }
  // VISION.md, CODEMAP.md, the chapters by name.
  return [VISION_FILE, ...paths.filter((path) => path === CODEMAP_FILE), ...chapterPaths];
}

const tooLarge = (path: string, bytes: number): FactoryError => new FactoryError('vision_too_large', `${shown(path)}: ${bytes} bytes; at most ${MAX_VISION_FILE_BYTES}.`);

// One file's bytes, opened without following a link or waiting on a pipe, a regular file of at
// most MAX_VISION_FILE_BYTES.
async function fileBytes(dir: string, path: string): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(join(dir, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw entryError(path, `cannot be read (${errorCode(error)}).`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw entryError(path, 'not a regular file.');
    }
    if (stats.size > MAX_VISION_FILE_BYTES) {
      throw tooLarge(path, stats.size);
    }
    // One byte more than the bound tells a file that grew since its size was read.
    const buffer = Buffer.alloc(MAX_VISION_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      length += bytesRead;
      if (bytesRead === 0 || length === buffer.length) {
        break;
      }
    }
    if (length > MAX_VISION_FILE_BYTES) {
      throw tooLarge(path, length);
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

interface VisionFile { path: string; bytes: Buffer; text: string }

// The folder's files with their bytes and their text, once the folder, its entries, the files'
// sizes and their text are checked.
async function readFolder(dir: string): Promise<VisionFile[]> {
  const files: VisionFile[] = [];
  let total = 0;
  for (const path of await folderPaths(dir)) {
    const bytes = await fileBytes(dir, path);
    let text: string | undefined;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch { // not UTF-8: refused below as not text
    }
    if (text === undefined || text.includes('\0')) {
      throw new FactoryError('vision_not_text', `${shown(path)}: not UTF-8 text.`);
    }
    total += bytes.length;
    if (total > MAX_VISION_BYTES) {
      throw new FactoryError('vision_too_large', `The folder's files have more than ${MAX_VISION_BYTES} bytes together.`);
    }
    files.push({ path, bytes, text });
  }
  return files;
}

// ------------------------------------------------------------------ the store

// Every folder under <state dir>/vision is opened without following a link, and what is in it is
// reached only through that handle (Linux's /proc/self/fd/<fd>): a folder swapped for a link
// meanwhile sends no read or write anywhere else.
const FOLDER_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

// Runs work with the folder at path open, given its handle's path; undefined when the folder is
// missing, a link or no folder. Any other failure is thrown.
async function inFolder<T>(path: string, work: (dir: string | undefined) => Promise<T>): Promise<T> {
  let handle: FileHandle;
  try {
    handle = await open(path, FOLDER_FLAGS);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(errorCode(error))) {
      return work(undefined);
    }
    throw error;
  }
  try {
    return await work(`/proc/self/fd/${handle.fd}`);
  } finally {
    await handle.close();
  }
}

// A workspace's folder, open through the vision root's handle (undefined as inFolder's).
const inWorkspace = <T>(stateDir: string, workspace: string, work: (home: string | undefined) => Promise<T>): Promise<T> =>
  inFolder(visionRoot(stateDir), (root) => (root === undefined ? work(undefined) : inFolder(join(root, workspace), work)));

// A store entry (its path relative to the state directory) that is not what it must be.
const unsafe = (entry: string, kind: 'plain folder' | 'regular file'): FactoryError =>
  new FactoryError('vision_unsafe', `${shown(entry)} in the store is not a ${kind}; nothing was changed.`);

async function isKind(path: string, kind: 'file' | 'dir'): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return kind === 'file' ? stats.isFile() : stats.isDirectory();
  } catch { // missing or unreadable: not there
    return false;
  }
}

// The regular files of a chapters folder (its handle's path) whose names match, by name.
async function chapterNames(chapters: string): Promise<string[]> {
  try {
    return (await readdir(chapters, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && CHAPTER_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort(byCodeUnit);
  } catch { // unreadable: no chapters
    return [];
  }
}

interface Stored { paths: string[]; texts: Map<string, string> | undefined; updated: Date }

// A stored language as it is read back, through its folders' handles: VISION.md, a regular
// CODEMAP.md and the regular chapters whose names match, with their texts when read, and its
// folder's modification time; undefined when the language is not stored (its folder, no link,
// holds no regular VISION.md). Each file is read through a handle opened without following a link
// or waiting on a pipe, and only when that handle is a regular file: a file swapped since the
// listing ends the put or remove, which has changed nothing yet (vision_unsafe).
async function storedLanguage(home: string, workspace: string, lang: VisionLanguage, read: boolean): Promise<Stored | undefined> {
  return inFolder(join(home, lang), async (langDir) => {
    if (langDir === undefined || !(await isKind(join(langDir, VISION_FILE), 'file'))) {
      return undefined;
    }
    const updated = (await stat(langDir)).mtime;
    const top = (await isKind(join(langDir, CODEMAP_FILE), 'file')) ? [VISION_FILE, CODEMAP_FILE] : [VISION_FILE];
    return inFolder(join(langDir, CHAPTERS_DIR), async (chapters) => {
      const files = [
        ...top.map((path) => ({ path, at: join(langDir, path) })),
        ...(chapters === undefined ? [] : await chapterNames(chapters)).map((name) => ({ path: `${CHAPTERS_DIR}/${name}`, at: join(chapters!, name) })),
      ];
      const texts = read ? new Map<string, string>() : undefined;
      for (const { path, at } of read ? files : []) {
        const notRegular = unsafe(`${VISION_DIR}/${workspace}/${lang}/${path}`, 'regular file');
        const handle = await open(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => Promise.reject(notRegular));
        try {
          if (!(await handle.stat()).isFile()) {
            throw notRegular;
          }
          texts!.set(path, await handle.readFile('utf8'));
        } finally {
          await handle.close();
        }
      }
      return { paths: files.map((file) => file.path), texts, updated };
    });
  });
}

const writePage = (home: string, page: string): Promise<void> => writeFileAtomic(join(home, PAGE_FILE), Buffer.from(page));

// The writes one after the other, puts and removes alike: each sees what the one before left.
let writes: Promise<unknown> = Promise.resolve();
function inTurn<T>(write: () => Promise<T>): Promise<T> {
  const done = writes.then(write);
  writes = done.catch(() => undefined);
  return done;
}

// Replaces the files of <workspace>/<lang> with those of the folder dir and builds the page again.
// Nothing is written before the language, the workspace, the folder and its files are checked and
// the page is built. The swap leaves <lang> as it was on a failure, but two gaps: sf serve killed
// between its two renames leaves <lang> missing (its old files in .<lang>.old until the next put
// or remove), and a failed write of page.html leaves the new files with the old page.
export async function putVision(paths: VisionPaths, workspace: string, lang: string, dir: string, now = new Date()): Promise<StoredLanguage & { workspace: string }> {
  const language = checkLanguage(lang);
  if (!Object.hasOwn((await loadRegistry(paths.configDir)).workspaces, workspace)) {
    throw new FactoryError('workspace_not_found', `Workspace "${workspace}" is not registered.`);
  }
  const files = await readFolder(dir);
  return inTurn(async () => {
    const other: VisionLanguage = language === 'en' ? 'bg' : 'en';
    const otherFiles = await inWorkspace(paths.stateDir, workspace, async (home) => (home === undefined ? undefined : (await storedLanguage(home, workspace, other, true))?.texts));
    if (language === 'bg' && otherFiles === undefined) {
      throw new FactoryError('vision_needs_en', `${workspace} has no English vision; store it first (sf vision put ${workspace} en <dir>): the page is built from it.`);
    }
    const put = new Map(files.map((file) => [file.path, file.text]));
    const page = visionPage(language === 'en' ? { en: put, ...(otherFiles === undefined ? {} : { bg: otherFiles }) } : { en: otherFiles!, bg: put });
    await mkdir(visionRoot(paths.stateDir), { recursive: true, mode: 0o700 });
    return inFolder(visionRoot(paths.stateDir), async (root) => {
      if (root === undefined) {
        throw unsafe(VISION_DIR, 'plain folder');
      }
      await mkdir(join(root, workspace), { mode: 0o700 }).catch((error: unknown) => (errorCode(error) === 'EEXIST' ? undefined : Promise.reject(error)));
      return inFolder(join(root, workspace), async (home) => {
        if (home === undefined) {
          throw unsafe(`${VISION_DIR}/${workspace}`, 'plain folder');
        }
        await swapIn(home, `${VISION_DIR}/${workspace}`, language, files, now);
        await writePage(home, page);
        return { workspace, lang: language, files: files.length, updated: now.toISOString() };
      });
    });
  });
}

// The files written into <home>/.<lang>.new, through the staging folder's handle (and its
// chapters folder's), each created anew (a link there is not followed), then the folder's times set.
async function stage(staging: string, entry: string, files: readonly VisionFile[], now: Date): Promise<void> {
  await inFolder(staging, async (dir) => {
    if (dir === undefined) {
      throw unsafe(entry, 'plain folder');
    }
    const write = (folder: string, name: string, bytes: Buffer): Promise<void> => writeFile(join(folder, name), bytes, { mode: 0o600, flag: 'wx' });
    const chapters = files.filter((file) => file.path.startsWith(`${CHAPTERS_DIR}/`));
    for (const file of files.filter((one) => !chapters.includes(one))) {
      await write(dir, file.path, file.bytes);
    }
    if (chapters.length > 0) {
      await mkdir(join(dir, CHAPTERS_DIR), { mode: 0o700 });
      await inFolder(join(dir, CHAPTERS_DIR), async (folder) => {
        if (folder === undefined) {
          throw unsafe(`${entry}/${CHAPTERS_DIR}`, 'plain folder');
        }
        for (const file of chapters) {
          await write(folder, file.path.slice(CHAPTERS_DIR.length + 1), file.bytes);
        }
      });
    }
    await utimes(dir, now, now);
  });
}

// Stages the files and swaps them in for <home>/<lang>; a failure leaves <lang> as it was and
// removes the staging folder.
async function swapIn(home: string, entry: string, language: VisionLanguage, files: readonly VisionFile[], now: Date): Promise<void> {
  const target = join(home, language);
  const staging = join(home, `.${language}.new`);
  const old = join(home, `.${language}.old`);
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(staging, { mode: 0o700 });
    await stage(staging, `${entry}/.${language}.new`, files, now);
    await rm(old, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  // Whatever is in <lang>'s place, a link too (moved aside and removed, never followed).
  const exists = await lstat(target).then(() => true, () => false);
  let moved = false;
  try {
    if (exists) {
      await rename(target, old);
      moved = true;
    }
    await rename(staging, target);
  } catch (error) {
    try {
      if (moved) {
        await rename(old, target);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    throw error;
  }
  try {
    await rm(old, { recursive: true, force: true });
  } catch { // the new files are in place: a leftover .<lang>.old goes with the next put or remove
  }
}

// Removes one language of a workspace's vision, or every one without lang. When no language is
// left, the workspace's folder goes whole; when en stays, the page is built from it first. The
// registry is not read: the vision of a workspace that left it can be removed.
export async function removeVision(stateDir: string, workspace: string, lang?: string): Promise<{ workspace: string; removed: VisionLanguage[] }> {
  const language = lang === undefined ? undefined : checkLanguage(lang);
  const none = (): FactoryError => new FactoryError('vision_not_found', `${workspace} has no vision.`);
  if (!WORKSPACE_NAME_PATTERN.test(workspace)) {
    throw none();
  }
  return inTurn(() => inFolder(visionRoot(stateDir), async (root) => {
    if (root === undefined) {
      throw none();
    }
    return inFolder(join(root, workspace), async (home) => {
      const stored: VisionLanguage[] = [];
      for (const one of home === undefined ? [] : VISION_LANGUAGES) {
        if ((await storedLanguage(home!, workspace, one, false)) !== undefined) {
          stored.push(one);
        }
      }
      if (home === undefined || stored.length === 0) {
        throw none();
      }
      if (language !== undefined && !stored.includes(language)) {
        throw new FactoryError('vision_not_found', `${workspace} has no vision in ${language}.`);
      }
      if (language === 'en' && stored.includes('bg')) {
        throw new FactoryError('vision_needs_en', `The English vision of ${workspace} is the source of its page; remove bg first, or the whole vision (sf vision remove ${workspace}).`);
      }
      const removed = language === undefined ? stored : [language];
      if (stored.every((stays) => removed.includes(stays))) {
        // Through the root's handle: a link put in the workspace folder's place is removed, not followed.
        await rm(join(root, workspace), { recursive: true, force: true });
      } else {
        // bg goes, en stays.
        const en = (await storedLanguage(home, workspace, 'en', true))?.texts;
        if (en === undefined) {
          throw unsafe(`${VISION_DIR}/${workspace}/en`, 'plain folder');
        }
        const page = visionPage({ en });
        await rm(join(home, 'bg'), { recursive: true, force: true });
        await writePage(home, page);
      }
      return { workspace, removed };
    });
  }));
}

// The workspace folders of the vision root (its handle's path) whose names are workspace names, by
// name; none when it cannot be read.
async function workspaceFolders(root: string | undefined): Promise<string[]> {
  try {
    return root === undefined ? [] : (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && WORKSPACE_NAME_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort(byCodeUnit);
  } catch { // unreadable: no vision
    return [];
  }
}

// Runs look on each workspace folder of the vision root, open, by name; a folder that is not one
// or cannot be read is skipped, a root that cannot be read is none. Never throws.
async function eachWorkspace<T>(stateDir: string, look: (workspace: string, home: string) => Promise<T | undefined>): Promise<T[]> {
  try {
    return await inFolder(visionRoot(stateDir), async (root) => {
      const found: T[] = [];
      for (const workspace of await workspaceFolders(root)) {
        try {
          const one = await inFolder(join(root!, workspace), (home) => (home === undefined ? Promise.resolve(undefined) : look(workspace, home)));
          if (one !== undefined) {
            found.push(one);
          }
        } catch { // unreadable or changed while read: skipped
        }
      }
      return found;
    });
  } catch { // the root cannot be opened: no vision
    return [];
  }
}

// What is stored: each workspace with a stored language, by name; its languages, bg before en,
// with their counts of files and their folders' modification times. Never refused.
export async function visionIndex(stateDir: string): Promise<VisionIndex> {
  const visions = await eachWorkspace(stateDir, async (workspace, home): Promise<VisionEntry | undefined> => {
    const languages: StoredLanguage[] = [];
    for (const lang of VISION_LANGUAGES) {
      const stored = await storedLanguage(home, workspace, lang, false);
      if (stored !== undefined) {
        languages.push({ lang, files: stored.paths.length, updated: stored.updated.toISOString() });
      }
    }
    return languages.length > 0 ? { workspace, languages } : undefined;
  });
  return { visions };
}

// The workspaces whose folder holds a regular page.html, sorted. Never throws.
export function visionPages(stateDir: string): Promise<string[]> {
  return eachWorkspace(stateDir, async (workspace, home) => ((await isKind(join(home, PAGE_FILE), 'file')) ? workspace : undefined));
}

// The bytes of a workspace's page.html, through the folders' handles and opened without following
// a link; undefined when the name is no workspace name, its folder is missing or no folder (a
// link), or there is no such regular file. Any other failure is thrown.
export async function readVisionPage(stateDir: string, workspace: string): Promise<Buffer | undefined> {
  if (!WORKSPACE_NAME_PATTERN.test(workspace)) {
    return undefined;
  }
  return inWorkspace(stateDir, workspace, async (home) => {
    if (home === undefined) {
      return undefined;
    }
    let handle: FileHandle;
    try {
      handle = await open(join(home, PAGE_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(errorCode(error))) {
        return undefined;
      }
      throw error;
    }
    try {
      return (await handle.stat()).isFile() ? await handle.readFile() : undefined;
    } finally {
      await handle.close();
    }
  });
}

// ------------------------------------------------------------------ the commands

// The commands of the table in src/commands.ts (spread into its COMMANDS): sf serve runs them, the
// writes one at a time.
export const VISION_COMMANDS = {
  vision: {
    name: 'vision', args: [], openWhileUpdating: true,
    description: 'The stored visions: each workspace\'s languages with their files and last put; the Workspaces drawer links each page',
    run: () => visionIndex(serveStateDir()),
  },
  visionPut: {
    name: 'vision put', args: ['<workspace>', '<lang>', '<dir>'],
    description: 'Store one language (en, then bg) of a workspace\'s vision from a folder with VISION.md, CODEMAP.md and chapters/*.md, an absolute path that sf serve reads; it replaces that language\'s files, all or nothing, and builds the page again',
    run: (_s, [workspace = '', lang = '', dir = '']) => putVision({ stateDir: serveStateDir(), configDir: configDir() }, workspace, lang, dir),
  },
  visionRemove: {
    name: 'vision remove', args: ['<workspace>', '[lang]'],
    description: 'Remove one language of a workspace\'s vision (bg first: en is the page\'s source), or every language without one',
    run: (_s, [workspace = '', lang]) => removeVision(serveStateDir(), workspace, lang),
  },
} satisfies Record<string, Command>;

// sf vision's lines: a row per workspace and language, each column padded to its widest cell.
export function visionLines(index: VisionIndex): string[] {
  if (index.visions.length === 0) {
    return ['No workspace has a vision (sf vision put <workspace> en <dir> stores one).'];
  }
  const rows = [
    ['workspace', 'language', 'files', 'updated'],
    ...index.visions.flatMap((vision) => vision.languages.map((stored) => [vision.workspace, stored.lang, String(stored.files), localTime(stored.updated) ?? stored.updated])),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd());
}

// How the CLI shows the commands' answers (src/commands.ts ANSWERS).
export const VISION_ANSWERS: ReadonlyArray<[Command, (result: Result) => Answer]> = [
  [VISION_COMMANDS.vision, (result) => ({ lines: visionLines(result as unknown as VisionIndex), failed: false })],
  [VISION_COMMANDS.visionPut, (result) => ({
    lines: [`Stored the vision of ${String(result.workspace)} (${String(result.lang)}): ${String(result.files)} ${result.files === 1 ? 'file' : 'files'}.`],
    failed: false,
  })],
  [VISION_COMMANDS.visionRemove, (result) => ({
    lines: [`Removed the vision of ${String(result.workspace)} (${(result.removed as string[]).join(', ')}).`],
    failed: false,
  })],
];
