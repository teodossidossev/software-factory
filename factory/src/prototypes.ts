// The planners' prototypes: <planning dir>/prototypes/<workspace>/<ticket>/<name>.html, one
// self-contained HTML file for each question a Claude Code planner settles with the user before it
// cuts a ticket (the planning-tasks skill, step 3). <planning dir> is planningDir's (src/config.ts),
// beside the planning copies. sf planner setup makes the prototypes folder and the workspace's
// (0700, never through a link) and gives the workspace's planning copy Write and Edit there alone
// (src/planning-copy.ts); the planner's Write tool makes a ticket's folder and its files. The
// dashboard shows a ticket's prototype read-only, in a sandboxed frame of a page of its own, and
// lists a ticket's prototypes (src/dashboard-reads.ts).
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { FactoryError } from './errors.js';
import { WORKSPACE_NAME_PATTERN } from './registry.js';
import { TICKET_PATTERN } from './task-file.js';

export const PROTOTYPES_DIR = 'prototypes';

// A prototype's file name: lower-case letters, digits and "-", starting with a letter or a digit,
// then .html; at most 64 characters.
export const PROTOTYPE_FILE = /^[a-z0-9][a-z0-9-]{0,58}\.html$/;
// The largest prototype the dashboard serves or lists.
export const MAX_PROTOTYPE_BYTES = 4 * 1024 * 1024;
// The most prototypes a ticket's list holds, the newest.
export const MAX_PROTOTYPES = 50;

// A ticket's prototype as its payloads list it: the file's name and when it last changed (ISO).
export interface PrototypeEntry {
  name: string;
  modified: string;
}

// The policy of the factory's page that shows one prototype: no script of its own, one frame, from
// the dashboard's origin only, so the frame's navigations stay there.
export const PROTOTYPE_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'";
// The prototype's own policy: a sandbox with scripts only (an opaque origin, without the dashboard's
// cookie, storage or API) that loads nothing and runs only in a frame of the dashboard's origin.
export const PROTOTYPE_FRAME_CSP = "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; webrtc 'block'";

// The factory's page for one prototype: its title, and the file in a sandboxed frame that fills the
// screen, from the frame's root address (through the dashboard's cookie, never the token). The names
// are checked ones (jobKey, PROTOTYPE_FILE): none holds a character to escape.
export function prototypePage(workspace: string, ticket: string, name: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${name} · ${ticket}</title>`,
    '<style>html,body{margin:0;height:100%;background:#fff}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style>',
    '</head>',
    `<body><iframe src="/prototype-frames/${workspace}/${ticket}/${name}" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${name}"></iframe></body>`,
    '</html>',
    '',
  ].join('\n');
}

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? 'error';
// The codes of a path that is missing, a link, or not what its open asks for.
const ABSENT = ['ENOENT', 'ENOTDIR', 'ELOOP'];

// Every folder on the way to a prototype is opened without following a link, and what is in it is
// reached only through that handle (Linux's /proc/self/fd/<fd>): a folder swapped for a link
// meanwhile sends no read anywhere else.
const FOLDER_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

// Runs work with the folder at path open, given its handle's path; undefined when the folder is
// missing, a link or no folder. Any other failure is thrown.
async function inFolder<T>(path: string, work: (dir: string | undefined) => Promise<T>): Promise<T> {
  let handle: FileHandle;
  try {
    handle = await open(path, FOLDER_FLAGS);
  } catch (error) {
    if (ABSENT.includes(errorCode(error))) {
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

// A ticket's folder, open through the root's and the workspace's handles (undefined as inFolder's).
function inTicket<T>(root: string, workspace: string, ticket: string, work: (dir: string | undefined) => Promise<T>): Promise<T> {
  // The folder name, opened in parent's handle, or undefined when parent is.
  const inChild = (parent: string | undefined, name: string, next: (dir: string | undefined) => Promise<T>): Promise<T> =>
    parent === undefined ? next(undefined) : inFolder(join(parent, name), next);
  return inFolder(root, (rootDir) => inChild(rootDir, workspace, (workspaceDir) => inChild(workspaceDir, ticket, work)));
}

const validNames = (workspace: string, ticket: string): boolean => WORKSPACE_NAME_PATTERN.test(workspace) && TICKET_PATTERN.test(ticket);

// A prototype's bytes, read through each folder's handle (the root, the workspace's, the ticket's),
// none followed through a link, the file opened without following one or waiting on a pipe;
// undefined when a name fails its pattern (WORKSPACE_NAME_PATTERN, TICKET_PATTERN, PROTOTYPE_FILE),
// a folder or the file is missing or a link, the file is no regular file or holds more than
// MAX_PROTOTYPE_BYTES. Any other failure is thrown.
export async function readPrototype(root: string, workspace: string, ticket: string, name: string): Promise<Buffer | undefined> {
  if (!validNames(workspace, ticket) || !PROTOTYPE_FILE.test(name)) {
    return undefined;
  }
  return inTicket(root, workspace, ticket, async (dir) => (dir === undefined ? undefined : fileBytes(join(dir, name))));
}

// The file's bytes, opened without following a link or waiting on a pipe; undefined when it is
// missing, a link, no regular file or more than MAX_PROTOTYPE_BYTES. Any other failure is thrown.
async function fileBytes(path: string): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (ABSENT.includes(errorCode(error))) {
      return undefined;
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_PROTOTYPE_BYTES) {
      return undefined;
    }
    // One byte more than the bound tells a file that grew since its size was read.
    const buffer = Buffer.alloc(MAX_PROTOTYPE_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      length += bytesRead;
      if (bytesRead === 0 || length === buffer.length) {
        break;
      }
    }
    return length > MAX_PROTOTYPE_BYTES ? undefined : buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

// A ticket's prototypes: each regular file of its folder with a PROTOTYPE_FILE name and at most
// MAX_PROTOTYPE_BYTES, newest first (then by name), at most MAX_PROTOTYPES. Never throws: names that
// fail their patterns, or a folder that is missing, a link or unreadable, give [].
export async function listPrototypes(root: string, workspace: string, ticket: string): Promise<PrototypeEntry[]> {
  if (!validNames(workspace, ticket)) {
    return [];
  }
  try {
    return await inTicket(root, workspace, ticket, async (dir) => {
      if (dir === undefined) {
        return [];
      }
      const found: { name: string; mtime: Date; mtimeMs: number }[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !PROTOTYPE_FILE.test(entry.name)) {
          continue;
        }
        // A file gone or unreadable since the listing is left out.
        const stats = await lstat(join(dir, entry.name)).catch(() => undefined);
        if (stats !== undefined && stats.isFile() && stats.size <= MAX_PROTOTYPE_BYTES) {
          found.push({ name: entry.name, mtime: stats.mtime, mtimeMs: stats.mtimeMs });
        }
      }
      found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return found.slice(0, MAX_PROTOTYPES).map(({ name, mtime }) => ({ name, modified: mtime.toISOString() }));
    });
  } catch { // unreadable: no prototypes listed
    return [];
  }
}

// <planning dir>/prototypes.
export const prototypesRoot = (planningDir: string): string => join(planningDir, PROTOTYPES_DIR);

// The code of a prototypes folder whose path cannot be checked (lstat or realpath failed).
export const PROTOTYPES_UNCHECKED = 'prototypes_folder_unchecked';

// The refusal of shown, a path relative to the planning folder, that error kept from being checked.
const unchecked = (shown: string, error: unknown): FactoryError =>
  new FactoryError(PROTOTYPES_UNCHECKED, `${shown} in the planning folder cannot be checked (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}): fix its permissions and run sf planner setup again.`);

// Checks <planning dir>/prototypes, then its folder of workspace, without writing anything: each
// one that exists must be a folder, not a link (lstat, never followed), else planning_copy_unsafe;
// a path lstat fails on other than by its absence, or the workspace's folder realpath fails on, is
// prototypes_folder_unchecked. The missing ones, in that order (the workspace's is missing when the
// first is).
export async function checkPrototypes(planningDir: string, workspace: string): Promise<string[]> {
  const missing: string[] = [];
  const workspaceShown = `${PROTOTYPES_DIR}/${workspace}`;
  for (const shown of [PROTOTYPES_DIR, workspaceShown]) {
    const path = join(planningDir, shown);
    const found = missing.length > 0 ? undefined : await lstat(path).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : Promise.reject(unchecked(shown, error))));
    if (found === undefined) {
      missing.push(path);
    } else if (!found.isDirectory()) {
      throw new FactoryError('planning_copy_unsafe', `${shown} in the planning folder is a link or not a folder: remove it and run sf planner setup again.`);
    }
  }
  if (missing.length === 0) {
    await realpath(join(planningDir, workspaceShown)).catch((error: unknown) => Promise.reject(unchecked(workspaceShown, error)));
  }
  return missing;
}

// Makes <planning dir>/prototypes, then its folder of workspace, each with mode 0700 when missing,
// after checkPrototypes. Nothing in them changes. The workspace folder's real path (a failure is
// prototypes_folder_unchecked).
export async function preparePrototypes(planningDir: string, workspace: string): Promise<string> {
  for (const path of await checkPrototypes(planningDir, workspace)) {
    await mkdir(path, { mode: 0o700 });
  }
  const shown = `${PROTOTYPES_DIR}/${workspace}`;
  return realpath(join(planningDir, shown)).catch((error: unknown) => Promise.reject(unchecked(shown, error)));
}
