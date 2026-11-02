// The mount-point placeholders Claude Code's sandbox (bubblewrap) leaves in the work checkout:
// zero-byte files with mode exactly 0444 for masked paths that did not exist, in the root (names
// starting with ".") and in .claude/ (any name), plus the empty .claude/.cc-writes directory.
// This module knows only the file system; callers decide when to clean and what to log.
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const CLAUDE_DIR = '.claude';
const CC_WRITES = '.cc-writes';
const PLACEHOLDER_MODE = 0o444;

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// A relative path at which the sandbox creates placeholders: ".<name>" in the root or
// ".claude/<name>".
function placeholderName(path: string): boolean {
  const parts = path.split('/');
  if (parts.length === 1) {
    return parts[0]!.startsWith('.') && parts[0] !== '.' && parts[0] !== '..';
  }
  return parts.length === 2 && parts[0] === CLAUDE_DIR && parts[1] !== '' && parts[1] !== '.' && parts[1] !== '..';
}

async function placeholderFile(absolute: string): Promise<boolean> {
  try {
    const stats = await lstat(absolute);
    return stats.isFile() && stats.size === 0 && (stats.mode & 0o7777) === PLACEHOLDER_MODE;
  } catch (error) {
    if (missing(error)) {
      return false;
    }
    throw error;
  }
}

// True when path (relative to cwd, "/"-separated) currently is a sandbox placeholder.
export async function isPlaceholder(cwd: string, path: string): Promise<boolean> {
  return placeholderName(path) && placeholderFile(join(cwd, path));
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (missing(error)) {
      return [];
    }
    throw error;
  }
}

async function remove(absolute: string, removeIt: (path: string) => Promise<void>): Promise<boolean> {
  try {
    await removeIt(absolute);
    return true;
  } catch (error) {
    if (missing(error)) {
      return false;
    }
    throw error;
  }
}

// Removes an empty, real directory; false when it is absent, not a directory, or not empty.
async function removeEmptyDir(absolute: string): Promise<boolean> {
  try {
    const stats = await lstat(absolute);
    if (!stats.isDirectory() || (await readdir(absolute)).length > 0) {
      return false;
    }
  } catch (error) {
    if (missing(error)) {
      return false;
    }
    throw error;
  }
  return remove(absolute, rmdir);
}

// Removes every placeholder in the root of cwd and in cwd/.claude/, then .claude/.cc-writes and
// .claude when they are empty. Returns the relative paths removed, sorted.
export async function removeSandboxPlaceholders(cwd: string): Promise<string[]> {
  const removed: string[] = [];
  const candidates = [
    ...(await names(cwd)).filter((name) => name.startsWith('.')),
    ...(await claudeNames(cwd)).map((name) => `${CLAUDE_DIR}/${name}`),
  ];
  for (const path of candidates) {
    if ((await isPlaceholder(cwd, path)) && (await remove(join(cwd, path), unlink))) {
      removed.push(path);
    }
  }
  for (const dir of [`${CLAUDE_DIR}/${CC_WRITES}`, CLAUDE_DIR]) {
    if (await removeEmptyDir(join(cwd, dir))) {
      removed.push(dir);
    }
  }
  return removed.sort();
}

// The entries of .claude/ when it is a real directory (a symbolic link is not followed).
async function claudeNames(cwd: string): Promise<string[]> {
  try {
    if (!(await lstat(join(cwd, CLAUDE_DIR))).isDirectory()) {
      return [];
    }
  } catch (error) {
    if (missing(error)) {
      return [];
    }
    throw error;
  }
  return names(join(cwd, CLAUDE_DIR));
}
