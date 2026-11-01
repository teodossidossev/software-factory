// The Patch of an iteration: the work checkout against the base commit, tracked changes plus
// untracked files, without touching the index. .software-factory/, ignored and credential-like
// paths are left out; the result is valid UTF-8 and at most MAX_PATCH_BYTES.
import { runGit } from './git.js';
import type { ChangedFile } from './jobs.js';
import { isForbidden } from './repo-files.js';
import { TASK_DIR } from './task-file.js';

export const MAX_PATCH_BYTES = 2 * 1024 * 1024;
export const MANY_FILES = 30;
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];

export interface Patch {
  patch: Buffer;
  truncated: boolean;
  files: ChangedFile[];
  // Paths of submodules whose recorded commit changed.
  submodules: string[];
}

function included(path: string): boolean {
  return path !== '' && !path.startsWith(`${TASK_DIR}/`) && !path.endsWith('/') && !isForbidden(path);
}

function nulList(output: Buffer): string[] {
  return output.toString('utf8').split('\0').filter((entry) => entry !== '');
}

async function git(cwd: string, args: string[], okCodes = [0]): Promise<Buffer> {
  const result = await runGit(cwd, args, MAX_PATCH_BYTES + 1);
  if (result.code === null && !result.truncated) {
    throw new Error(`git ${args[0]} was stopped: ${result.stderr.trim()}`);
  }
  if (result.code !== null && !okCodes.includes(result.code)) {
    throw new Error(`git ${args[0]} failed (${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// Concatenates diff parts into valid UTF-8 of at most maxBytes, cut after the last whole line.
export function assemblePatch(parts: Buffer[], maxBytes = MAX_PATCH_BYTES): { patch: Buffer; truncated: boolean } {
  const whole = Buffer.from(Buffer.concat(parts).toString('utf8'), 'utf8');
  if (whole.length <= maxBytes) {
    return { patch: whole, truncated: false };
  }
  const cut = whole.lastIndexOf(0x0a, maxBytes - 1);
  return { patch: whole.subarray(0, cut + 1), truncated: true };
}

// Git's quoted path form: "a/caf\303\251 \"x\"" (C escapes, octal bytes).
function unquote(path: string): string {
  if (!path.startsWith('"')) {
    return path;
  }
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, '\\': 92 };
  for (let i = 1; i < path.length - 1; i += 1) {
    const char = path[i]!;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
    } else if (/^[0-7]{3}$/.test(path.slice(i + 1, i + 4))) {
      bytes.push(parseInt(path.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(escapes[path[i + 1]!] ?? path.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function headerPath(header: string): string {
  const rest = header.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ');
    return unquote(rest.slice(0, end + 1)).replace(/^a\//, '');
  }
  // Without renames both sides name the same path: "a/<p> b/<p>".
  return rest.slice(2, 2 + (rest.length - 5) / 2);
}

// The changed-file table and the changed submodules, read from the Patch text.
export function changedFiles(patch: string): { files: ChangedFile[]; submodules: string[] } {
  const files: ChangedFile[] = [];
  const submodules: string[] = [];
  let current: ChangedFile | undefined;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { path: headerPath(line), added: 0, removed: 0 };
      files.push(current);
      inHunk = false;
    } else if (current === undefined) {
      continue;
    } else if (!inHunk) {
      if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
        current.path = unquote(line.slice(4)).replace(/^b\//, '');
      } else if (line.startsWith('--- ') && line !== '--- /dev/null') {
        current.path = unquote(line.slice(4)).replace(/^a\//, '');
      } else if (/^(index \S+ |new file mode |deleted file mode )160000$/.test(line) && !submodules.includes(current.path)) {
        submodules.push(current.path);
      } else if (line.startsWith('@@')) {
        inHunk = true;
      }
    } else if (line.startsWith('+')) {
      current.added += 1;
    } else if (line.startsWith('-')) {
      current.removed += 1;
    } else if (line.startsWith('@@')) {
      inHunk = true;
    }
  }
  return { files, submodules };
}

// Appended to the Implementer's report by the factory.
export function changedFilesSection(files: ChangedFile[], truncated: boolean): string {
  const lines = ['## Changed files', ''];
  if (files.length === 0) {
    lines.push('No changes.');
  } else {
    if (files.length > MANY_FILES) {
      lines.push(`Warning: ${files.length} files changed, more than ${MANY_FILES}.`, '');
    }
    lines.push('| Path | Added | Removed |', '|---|---|---|');
    for (const file of files) {
      lines.push(`| ${file.path.replaceAll('|', '\\|')} | ${file.added} | ${file.removed} |`);
    }
  }
  if (truncated) {
    lines.push('', `The Patch was cut at ${MAX_PATCH_BYTES} bytes; files after the cut are not listed.`);
  }
  return lines.join('\n');
}

export async function buildPatch(cwd: string, baseCommit: string): Promise<Patch> {
  const tracked = nulList(await git(cwd, ['diff', '--name-only', '-z', '--no-renames', baseCommit])).filter(included);
  const parts: Buffer[] = [];
  let size = 0;
  if (tracked.length > 0) {
    const part = await git(cwd, ['diff', ...DIFF_FLAGS, baseCommit, '--', ...tracked.map((path) => `:(literal)${path}`)]);
    parts.push(part);
    size += part.length;
  }
  const untracked = nulList(await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).filter(included);
  for (const path of untracked) {
    if (size > MAX_PATCH_BYTES) {
      break;
    }
    // Exit code 1 means "differences found", which is always the case here.
    const part = await git(cwd, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', path], [0, 1]);
    parts.push(part);
    size += part.length;
  }
  const { patch, truncated } = assemblePatch(parts);
  return { patch, truncated, ...changedFiles(patch.toString('utf8')) };
}
