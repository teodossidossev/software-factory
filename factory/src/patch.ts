// The Patch of an iteration: the work checkout against the base commit, tracked changes plus
// untracked files, without touching the index. .software-factory/, ignored and credential-like
// paths and sandbox placeholders (src/placeholders.ts) are left out; the result is valid UTF-8 and at most MAX_PATCH_BYTES.
import { createHash } from 'node:crypto';
import { runGit, runGitToFile, runGitToHash } from './git.js';
import type { ChangedFile, FileChange, IterationMeta } from './jobs.js';
import { isPlaceholder } from './placeholders.js';
import { isForbidden } from './repo-files.js';
import { deltaFiles, type IterationDelta } from './review-delta.js';
import { type Marks, sensitivityOf } from './rules.js';
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

// The Patch text per file, by the path changedFiles reads (which files an iteration changed,
// by comparing two iterations' Patches file by file).
export function fileSections(patch: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const part of patch.split(/^(?=diff --git )/mu)) {
    const [file] = part.startsWith('diff --git ') ? changedFiles(part).files : [];
    if (file !== undefined) {
      sections.set(file.path, (sections.get(file.path) ?? '') + part);
    }
  }
  return sections;
}

// Appended to the Implementer's report by the factory. With the structured file list the
// sensitive paths (declared or undeclared by may_touch), the paths outside the Task's scope and
// the deleted paths come first, each under its own heading, so a reviewer never folds them into
// the rest.
export function changedFilesSection(files: ChangedFile[], truncated: boolean, changes: FileChange[] = []): string {
  const lines = ['## Changed files', ''];
  const sensitive = changes.filter((change) => change.sensitive !== 'no');
  const outside = changes.filter((change) => change.scope === 'out');
  const deleted = changes.filter((change) => change.status === 'deleted');
  if (sensitive.length > 0) {
    lines.push('### Sensitive', '', ...sensitive.map((change) => `- ${change.path} (${change.sensitive}${change.status === 'deleted' ? ', deleted' : ''})`), '');
  }
  if (outside.length > 0) {
    lines.push("### Outside the Task's scope", '', ...outside.map((change) => `- ${change.path}${change.status === 'deleted' ? ' (deleted)' : ''}`), '');
  }
  if (deleted.length > 0) {
    lines.push('### Deleted', '', ...deleted.map((change) => `- ${change.path}`), '');
  }
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

// The sensitive, the out-of-scope (only when the Task declares a scope) and the deleted paths of
// an iteration as sf status prints them.
export function fileSummaryLines(changes: FileChange[]): string[] {
  const list = (paths: string[]): string => (paths.length === 0 ? 'none' : paths.join(', '));
  const sensitive = changes.filter((change) => change.sensitive !== 'no').map((change) => `${change.path}${change.sensitive === 'undeclared' ? ' (undeclared)' : ''}`);
  const scoped = changes.some((change) => change.scope !== 'none');
  const outside = changes.filter((change) => change.scope === 'out').map((change) => change.path);
  const deleted = changes.filter((change) => change.status === 'deleted').map((change) => change.path);
  return [`sensitive: ${list(sensitive)}`, ...(scoped ? [`out of scope: ${list(outside)}`] : []), `deleted: ${list(deleted)}`];
}

// The same summaries on one line, as the notifications carry them: a body holds three lines, so
// with the branch and the MR title before it none of the marked paths is cut.
export function notificationLine(changes: FileChange[]): string {
  return fileSummaryLines(changes).join('; ');
}

const STATUS_LETTERS: Record<string, FileChange['status']> = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' };

// The structured file list of an iteration: the status of every changed tracked file
// (`git diff --name-status`) and every untracked file as added, the line counts from the Patch
// table (0 for a file the Patch omits), and the marks of each path (marksOf): the sensitivity from
// the rules and may_touch, and the scope from the Task's scope and may_touch.
export async function fileChanges(
  cwd: string, baseCommit: string, counted: ChangedFile[], marks: (path: string) => Marks,
): Promise<FileChange[]> {
  const { tracked, untracked } = await changedPaths(cwd, baseCommit);
  const statuses = new Map<string, FileChange['status']>();
  if (tracked.length > 0) {
    const entries = nulList(await git(cwd, ['diff', '--name-status', '-z', '--no-renames', baseCommit, '--', ...tracked.map((path) => `:(literal)${path}`)]));
    for (let index = 0; index + 1 < entries.length; index += 2) {
      statuses.set(entries[index + 1]!, STATUS_LETTERS[entries[index]!.charAt(0)] ?? 'modified');
    }
  }
  const counts = new Map(counted.map((file) => [file.path, file]));
  const changes: FileChange[] = [];
  for (const path of [...tracked, ...untracked]) {
    const file = counts.get(path);
    changes.push({
      path, status: statuses.get(path) ?? 'added', ...marks(path),
      additions: file?.added ?? 0, deletions: file?.removed ?? 0,
    });
  }
  return changes;
}

export { sensitivityOf };

// The paths a Patch against baseCommit covers: changed tracked files and untracked files,
// filtered as the Patch is, never cut by its size limit. An untracked sandbox placeholder is
// skipped, in case the sandbox recreated it after the factory's cleanup.
export async function changedPaths(cwd: string, baseCommit: string): Promise<{ tracked: string[]; untracked: string[] }> {
  const tracked = nulList(await git(cwd, ['diff', '--name-only', '-z', '--no-renames', baseCommit])).filter(included);
  const untracked: string[] = [];
  for (const path of nulList(await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).filter(included)) {
    if (!(await isPlaceholder(cwd, path))) {
      untracked.push(path);
    }
  }
  return { tracked, untracked };
}

export async function buildPatch(cwd: string, baseCommit: string): Promise<Patch> {
  const { tracked, untracked } = await changedPaths(cwd, baseCommit);
  const parts: Buffer[] = [];
  let size = 0;
  if (tracked.length > 0) {
    const part = await git(cwd, ['diff', ...DIFF_FLAGS, baseCommit, '--', ...tracked.map((path) => `:(literal)${path}`)]);
    parts.push(part);
    size += part.length;
  }
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

// The whole Patch against baseCommit as a sha256, never cut at MAX_PATCH_BYTES, with the paths it
// covers, sorted (the turn limit's progress test): the paths and filters of buildPatch,
// binary content included, streamed through the hash. buildPatch stays the bounded one for display.
export async function patchDigest(cwd: string, baseCommit: string): Promise<{ paths: string[]; hash: string }> {
  const { tracked, untracked } = await changedPaths(cwd, baseCommit);
  const hash = createHash('sha256');
  const diff = async (args: string[], okCodes: number[]): Promise<void> => {
    const result = await runGitToHash(cwd, ['diff', ...DIFF_FLAGS, '--binary', ...args], hash);
    if (result.code === null || !okCodes.includes(result.code)) {
      throw new Error(`git diff failed (${result.code}): ${result.stderr.trim()}`);
    }
  };
  if (tracked.length > 0) {
    await diff([baseCommit, '--', ...tracked.map((path) => `:(literal)${path}`)], [0]);
  }
  for (const path of untracked) {
    // Exit code 1 means "differences found", which is always the case here.
    await diff(['--no-index', '--', '/dev/null', path], [0, 1]);
  }
  return { paths: [...tracked, ...untracked].sort(), hash: hash.digest('hex') };
}

// Writes the working tree against commit to the open file fd as a patch `git apply` takes, binary
// files included: the paths of the Patch (tracked and untracked, filtered as the Patch is). Git
// writes straight into the file, so the patch is never cut, whatever its size. It saves a
// conflict resolution the rebase could not continue (src/mr.ts).
export async function writeResolutionPatch(cwd: string, commit: string, fd: number): Promise<void> {
  const { tracked, untracked } = await changedPaths(cwd, commit);
  const diff = async (args: string[], okCodes: number[]): Promise<void> => {
    const result = await runGitToFile(cwd, ['diff', ...DIFF_FLAGS, '--binary', ...args], fd);
    if (result.code === null || !okCodes.includes(result.code)) {
      throw new Error(`git diff failed (${result.code}): ${result.stderr.trim()}`);
    }
  };
  if (tracked.length > 0) {
    await diff([commit, '--', ...tracked.map((path) => `:(literal)${path}`)], [0]);
  }
  for (const path of untracked) {
    // Exit code 1 means "differences found", which is always the case here.
    await diff(['--no-index', '--', '/dev/null', path], [0, 1]);
  }
}

// One path of the change between two trees: its status and line counts (0 for a binary file).
export interface TreeChange {
  path: string;
  status: FileChange['status'];
  added: number;
  removed: number;
}

const literal = (paths: readonly string[]): string[] => paths.map((path) => `:(literal)${path}`);

// Git's whole output, never cut: refused when Git fails or its output does not fit. The message
// names no path.
async function wholeOutput(cwd: string, args: string[], input?: string): Promise<Buffer> {
  const result = await runGit(cwd, args, MAX_PATCH_BYTES, undefined, {}, input);
  if (result.code !== 0 || result.truncated) {
    throw new Error(result.truncated ? `git ${args[0]} gave more than ${MAX_PATCH_BYTES} bytes` : `git ${args[0]} failed (exit ${String(result.code)})`);
  }
  return result.stdout;
}

// The change from the tree from to the tree to in cwd's repository, limited to paths (literal
// pathspecs, git diff --no-renames): each changed path's status and line counts. No paths: none.
export async function treeChanges(cwd: string, from: string, to: string, paths: readonly string[]): Promise<TreeChange[]> {
  if (paths.length === 0) {
    return [];
  }
  const args = ['--no-renames', '--no-ext-diff', '--no-textconv', '-z', from, to, '--', ...literal(paths)];
  const statuses = nulList(await wholeOutput(cwd, ['diff', '--name-status', ...args]));
  // --numstat -z: "<added>\t<deleted>\t<path>" for each path, "-\t-\t<path>" for a binary one.
  const counts = new Map<string, [number, number]>();
  for (const record of nulList(await wholeOutput(cwd, ['diff', '--numstat', ...args]))) {
    const [added = '', removed = '', ...rest] = record.split('\t');
    counts.set(rest.join('\t'), [/^\d+$/.test(added) ? Number(added) : 0, /^\d+$/.test(removed) ? Number(removed) : 0]);
  }
  const changes: TreeChange[] = [];
  for (let index = 0; index + 1 < statuses.length; index += 2) {
    const path = statuses[index + 1]!;
    const [added, removed] = counts.get(path) ?? [0, 0];
    changes.push({ path, status: STATUS_LETTERS[statuses[index]!.charAt(0)] ?? 'modified', added, removed });
  }
  return changes;
}

// The text of the change from the tree from to the tree to, limited to paths, as the Patch shows
// a change (valid UTF-8, at most MAX_PATCH_BYTES), and whether it was cut at that limit: git()
// reads one byte more than the limit, so a longer text is always seen as cut. No paths: empty.
export async function treeDiff(cwd: string, from: string, to: string, paths: readonly string[]): Promise<{ patch: Buffer; truncated: boolean }> {
  if (paths.length === 0) {
    return { patch: Buffer.alloc(0), truncated: false };
  }
  return assemblePatch([await git(cwd, ['diff', ...DIFF_FLAGS, from, to, '--', ...literal(paths)])]);
}

// Which of paths are files (blobs) of tree in cwd's repository (git cat-file --batch-check of
// <tree>:<path>): a directory, a submodule or a path that is not there is not. An empty path, or one
// with a line break, never is. Throws when Git fails or answers with another number of lines.
export async function filesOfTree(cwd: string, tree: string, paths: readonly string[]): Promise<Set<string>> {
  const asked = [...new Set(paths)].filter((path) => path !== '' && !/[\r\n]/.test(path));
  if (asked.length === 0) {
    return new Set();
  }
  const input = asked.map((path) => `${tree}:${path}\n`).join('');
  const lines = (await wholeOutput(cwd, ['cat-file', '--batch-check=%(objecttype)'], input)).toString('utf8').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  if (lines.length !== asked.length) {
    throw new Error(`git cat-file answered ${lines.length} lines for ${asked.length} paths`);
  }
  return new Set(asked.filter((_path, index) => lines[index] === 'blob'));
}

// The delta of an iteration published after the clean round of iteration from (meta.json's delta,
// src/review-delta.ts): the change from base's commit_tree (base: that iteration's meta.json,
// undefined when it cannot be read) to tree, the new iteration's, limited to the paths of either
// file list. Skipped, with why, when the baseline has no commit_tree or file list, a Patch was cut
// at either end, or Git cannot compare the trees (a tree object gone).
export async function iterationDelta(cwd: string, from: number, base: IterationMeta | undefined, to: { tree: string; truncated: boolean; files: FileChange[] }): Promise<IterationDelta> {
  const skipped = (why: string): IterationDelta => ({ from, skipped: why });
  if (base === undefined) {
    return skipped(`the meta.json of iteration ${from} cannot be read`);
  }
  if (base.commit_tree === undefined || base.files === undefined) {
    return skipped(`iteration ${from} has no ${base.commit_tree === undefined ? 'commit_tree' : 'file list'}`);
  }
  if (base.patch_truncated || to.truncated) {
    return skipped(`the Patch of ${base.patch_truncated ? `iteration ${from}` : 'this iteration'} was cut at its size limit`);
  }
  const paths = [...new Set([...base.files, ...to.files].map((file) => file.path))];
  try {
    return { from, from_tree: base.commit_tree, files: deltaFiles(await treeChanges(cwd, base.commit_tree, to.tree, paths), to.files, base.files) };
  } catch (error) {
    console.error(error);
    return skipped(`git could not compare the trees of iteration ${from} and this iteration`);
  }
}
