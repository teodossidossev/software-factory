// The planners' prototypes: <planning dir>/prototypes/<workspace>/<ticket>/<name>.html, one
// self-contained HTML file for each question a Claude Code planner settles with the user before it
// cuts a ticket (the planning-tasks skill, step 3). <planning dir> is planningDir's (src/config.ts),
// beside the planning copies. sf planner setup makes the prototypes folder and the workspace's
// (0700, never through a link) and gives the workspace's planning copy Write and Edit there alone
// (src/planning-copy.ts); the planner's Write tool makes a ticket's folder and its files.
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { FactoryError } from './errors.js';

export const PROTOTYPES_DIR = 'prototypes';

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
