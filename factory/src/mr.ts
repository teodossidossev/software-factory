// MR preparation steps on the work checkout, all through runGit: the target, the snapshot of the
// reviewed change, the verification at turn end, the diff check by three-way merge, the push and
// the merge request link. The Execution drives them around the Implementer's turn; this module runs
// no turn.
import { lstat, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FactoryError } from './errors.js';
import { type GitExtraEnv, runGit } from './git.js';
import type { MrSnapshot } from './jobs.js';
import { changedPaths } from './patch.js';
import { isPlaceholder } from './placeholders.js';
import { headerProblem, MR_REQUIRED_HEADINGS } from './rules.js';
import { TASK_DIR } from './task-file.js';

const FETCH_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;
// update-index arguments per Git call, well below the argv limit.
const UPDATE_INDEX_CHUNK = 200;
// The identity of the snapshot commit, which never leaves the work checkout.
const SNAPSHOT_IDENTITY = ['-c', 'user.name=Software Factory', '-c', 'user.email=software-factory@localhost'];
export const MAX_MR_TEXT_BYTES = 64 * 1024;
export const ABSENT = 'absent';

export interface MrFailure {
  code: string;
  message: string;
}

export function mrTextPath(ticket: string): string {
  return `${TASK_DIR}/${ticket}.mr.md`;
}

async function gitText(cwd: string, args: string[]): Promise<{ ok: boolean; text: string; stderr: string }> {
  const result = await runGit(cwd, args);
  return { ok: result.code === 0, text: result.stdout.toString('utf8').trim(), stderr: result.stderr.trim() };
}

// The ref to start from or rebase onto: origin/<base> after a fetch when origin exists, else the
// local <base>; and its commit.
export async function resolveTarget(cwd: string, base: string): Promise<{ ref: string; commit: string }> {
  const remotes = (await gitText(cwd, ['remote'])).text.split('\n');
  let ref = `refs/heads/${base}`;
  if (remotes.includes('origin')) {
    const fetch = await runGit(cwd, ['fetch', '--no-recurse-submodules', 'origin', base], 1024 * 1024, FETCH_TIMEOUT_MS);
    if (fetch.code !== 0) {
      if (/couldn't find remote ref/i.test(fetch.stderr)) {
        throw new FactoryError('base_not_found', `The base "${base}" does not exist on origin.`);
      }
      throw new FactoryError('fetch_failed', fetch.code === null ? 'git fetch origin did not finish within 60 s.' : 'git fetch origin failed.');
    }
    ref = `refs/remotes/origin/${base}`;
  }
  const resolved = await gitText(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!resolved.ok || resolved.text === '') {
    throw new FactoryError('base_not_found', `The base "${base}" was not found${ref.startsWith('refs/remotes') ? ' on origin' : ''}.`);
  }
  return { ref: ref.replace(/^refs\/(heads|remotes)\//, ''), commit: resolved.text };
}

// The ref that keeps the snapshot commit of a job, so that gc does not remove it.
export function snapshotRef(ticket: string): string {
  return `refs/sf/snapshot/${ticket}`;
}

// stdout of a Git command that must succeed, trimmed.
async function gitOk(cwd: string, args: string[], env?: GitExtraEnv): Promise<string> {
  const result = await runGit(cwd, args, 1024 * 1024, undefined, env);
  if (result.code !== 0) {
    throw new Error(`git ${args.find((arg) => !arg.startsWith('-')) ?? args[0]} failed: ${result.stderr.trim().slice(0, 500)}`);
  }
  return result.stdout.toString('utf8').trim();
}

// The --cacheinfo value ("<mode>,<object>,<path>") of the working tree content of path, its blob
// written to the object database; undefined when the path is deleted. hash-object follows a
// symbolic link, so the link's target text is hashed from the scratch file instead.
async function cacheInfo(cwd: string, path: string, scratch: string): Promise<string | undefined> {
  let stats;
  try {
    stats = await lstat(join(cwd, path));
  } catch {
    return undefined;
  }
  if (stats.isSymbolicLink()) {
    await writeFile(scratch, await readlink(join(cwd, path), { encoding: 'buffer' }));
    return `120000,${await gitOk(cwd, ['hash-object', '-w', '--no-filters', '--', scratch])},${path}`;
  }
  if (stats.isDirectory()) {
    // A submodule: the commit checked out in it.
    return `160000,${await gitOk(join(cwd, path), ['rev-parse', '--verify', 'HEAD'])},${path}`;
  }
  const mode = (stats.mode & 0o111) !== 0 ? '100755' : '100644';
  return `${mode},${await gitOk(cwd, ['hash-object', '-w', '--', path])},${path}`;
}

// The reviewed change as a commit on top of baseCommit: a temporary index in scratchDir (the job
// directory) reads baseCommit, takes every Patch path from the working tree (deleted paths are
// removed), and its tree is committed and kept under snapshotRef(ticket), replacing an earlier one.
// The work checkout's index, HEAD and files are not touched.
export async function takeSnapshot(
  cwd: string,
  ticket: string,
  baseCommit: string,
  target: { ref: string; commit: string },
  scratchDir: string,
): Promise<MrSnapshot> {
  const { tracked, untracked } = await changedPaths(cwd, baseCommit);
  const paths = [...new Set([...tracked, ...untracked])].sort();
  // Absolute: Git runs in the work checkout, and SF_STATE_DIR may be relative.
  const index = resolve(scratchDir, 'snapshot.index');
  const scratch = resolve(scratchDir, 'snapshot.link');
  const env: GitExtraEnv = { GIT_INDEX_FILE: index };
  try {
    await rm(index, { force: true });
    await gitOk(cwd, ['read-tree', baseCommit], env);
    const added: string[] = [];
    const removed: string[] = [];
    for (const path of paths) {
      const info = await cacheInfo(cwd, path, scratch);
      if (info === undefined) {
        removed.push(path);
      } else {
        added.push(info);
      }
    }
    for (let start = 0; start < added.length; start += UPDATE_INDEX_CHUNK) {
      await gitOk(cwd, ['update-index', '--add', ...added.slice(start, start + UPDATE_INDEX_CHUNK).flatMap((info) => ['--cacheinfo', info])], env);
    }
    for (let start = 0; start < removed.length; start += UPDATE_INDEX_CHUNK) {
      await gitOk(cwd, ['update-index', '--force-remove', '--', ...removed.slice(start, start + UPDATE_INDEX_CHUNK)], env);
    }
    const tree = await gitOk(cwd, ['write-tree'], env);
    const commit = await gitOk(cwd, [...SNAPSHOT_IDENTITY, 'commit-tree', '--no-gpg-sign', tree, '-p', baseCommit, '-m', `sf snapshot ${ticket}`]);
    await gitOk(cwd, ['update-ref', snapshotRef(ticket), commit]);
    return { target_ref: target.ref, target_commit: target.commit, base_commit: baseCommit, snapshot_commit: commit, paths };
  } finally {
    await rm(index, { force: true });
    await rm(scratch, { force: true });
  }
}

// Removes snapshotRef(ticket); true when it is gone (or was never there).
export async function deleteSnapshotRef(cwd: string, ticket: string): Promise<boolean> {
  return (await runGit(cwd, ['update-ref', '-d', snapshotRef(ticket)])).code === 0;
}

// Paths whose object differs between expected and actual (ABSENT on both sides is equal), or that
// only one of them lists. Sorted.
export function compareSnapshot(expected: Record<string, string>, actual: Record<string, string>): string[] {
  const paths = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...paths].filter((path) => expected[path] !== actual[path]).sort();
}

async function gitDir(cwd: string): Promise<string> {
  return resolve(cwd, (await gitText(cwd, ['rev-parse', '--git-dir'])).text);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// True while a rebase is in progress or Git holds the index lock.
export async function gitBusy(cwd: string): Promise<boolean> {
  const dir = await gitDir(cwd);
  for (const name of ['rebase-merge', 'rebase-apply', 'index.lock']) {
    if (await exists(join(dir, name))) {
      return true;
    }
  }
  return false;
}

// Problems of the MR text, or undefined when it is valid; subject, when given, is the commit
// subject the title must equal.
export function mrTextProblem(ticket: string, text: string, subject?: string): string | undefined {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (text.trim() === '') {
    return 'it is empty';
  }
  if (bytes > MAX_MR_TEXT_BYTES) {
    return `it has ${bytes} bytes, more than ${MAX_MR_TEXT_BYTES}`;
  }
  const lines = text.split(/\r?\n/);
  const header = headerProblem(ticket, lines[0]!);
  if (header !== undefined) {
    return `its first line "${lines[0]!.slice(0, 100)}" is not a valid title: ${header}`;
  }
  if (subject !== undefined && lines[0] !== subject) {
    return `its title "${lines[0]!.slice(0, 100)}" differs from the commit subject "${subject.slice(0, 100)}"`;
  }
  const missing = MR_REQUIRED_HEADINGS.filter((heading) => !lines.some((line) => line.trimEnd() === heading));
  if (missing.length > 0) {
    return `it lacks the heading(s) ${missing.join(', ')}`;
  }
  return undefined;
}

// The checks after the MR preparation turn, the first failure winning; the MR text on success.
export async function verifyPrepared(
  cwd: string,
  job: { ticket: string; branch: string },
  targetCommit: string,
): Promise<{ ok: true; mrText: string } | ({ ok: false } & MrFailure)> {
  const fail = (code: string, message: string) => ({ ok: false as const, code, message });
  const { ticket, branch } = job;
  const head = await gitText(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!head.ok || head.text !== branch) {
    return fail('mr_branch_mismatch', `HEAD is ${head.ok ? `on ${head.text}` : 'detached'}, not on ${branch}.`);
  }
  if (await gitBusy(cwd)) {
    return fail('mr_rebase_in_progress', 'A rebase (or a Git lock) is still in progress in the work checkout.');
  }
  // Not trimmed: porcelain lines start with a status column that may be a space. An untracked
  // sandbox placeholder recreated after the cleanup does not count (its plain name is never quoted).
  const status = await runGit(cwd, ['status', '--porcelain', '--untracked-files=all']);
  const dirty: string[] = [];
  for (const line of status.stdout.toString('utf8').split('\n')) {
    if (line === '' || /^.. "?\.software-factory\//.test(line) || (line.startsWith('?? ') && (await isPlaceholder(cwd, line.slice(3))))) {
      continue;
    }
    dirty.push(line);
  }
  if (status.code !== 0 || dirty.length > 0) {
    return fail('mr_dirty', `The work checkout has ${dirty.length} uncommitted change(s): ${dirty.slice(0, 5).map((line) => line.slice(3)).join(', ')}.`);
  }
  if (!(await gitText(cwd, ['merge-base', '--is-ancestor', targetCommit, branch])).ok) {
    return fail('mr_not_rebased', `${branch} does not contain the target commit ${targetCommit.slice(0, 12)}; it is not rebased.`);
  }
  const count = (await gitText(cwd, ['rev-list', '--count', `${targetCommit}..${branch}`])).text;
  if (count !== '1') {
    return fail('mr_commit_count', `${branch} has ${count} commit(s) on top of the target; the rules want exactly 1.`);
  }
  const subject = (await gitText(cwd, ['log', '-1', '--format=%s', branch])).text;
  const problem = headerProblem(ticket, subject);
  if (problem !== undefined) {
    return fail('mr_commit_header', `The commit header "${subject.slice(0, 100)}" breaks the rules: ${problem}.`);
  }
  const path = mrTextPath(ticket);
  let text: string;
  try {
    const stats = await lstat(join(cwd, path));
    if (!stats.isFile()) {
      return fail('mr_text_missing', `${path} is not a regular file.`);
    }
    if (stats.size > MAX_MR_TEXT_BYTES) {
      return fail('mr_text_invalid', `${path} has ${stats.size} bytes, more than ${MAX_MR_TEXT_BYTES}.`);
    }
    text = await readFile(join(cwd, path), 'utf8');
  } catch {
    return fail('mr_text_missing', `${path} does not exist.`);
  }
  const invalid = mrTextProblem(ticket, text, subject);
  if (invalid !== undefined) {
    return fail(text.trim() === '' ? 'mr_text_missing' : 'mr_text_invalid', `${path} is invalid: ${invalid}.`);
  }
  return { ok: true, mrText: text };
}

// The tree a clean three-way merge of the reviewed change onto the target gives, and the paths that
// merge left in conflict. Exit code 1 means conflicts; with --no-messages --name-only -z stdout is
// "<tree>\0" followed by "<path>\0" for each conflicted path.
export async function expectedMerge(cwd: string, snapshot: MrSnapshot): Promise<{ tree: string; conflicted: string[] }> {
  const merged = await runGit(cwd, [
    'merge-tree', '--write-tree', '--no-messages', '--name-only', '-z',
    '--merge-base', snapshot.base_commit, snapshot.target_commit, snapshot.snapshot_commit,
  ]);
  const [tree, ...conflicted] = merged.stdout.toString('utf8').split('\0').filter((entry) => entry !== '');
  if ((merged.code !== 0 && merged.code !== 1) || merged.truncated || tree === undefined || !/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new Error(`git merge-tree failed: ${merged.stderr.trim().slice(0, 500)}`);
  }
  return { tree, conflicted: [...new Set(conflicted)] };
}

async function objectAt(cwd: string, spec: string): Promise<string> {
  const object = await gitText(cwd, ['rev-parse', '--verify', '--quiet', spec]);
  return object.ok && object.text !== '' ? object.text : ABSENT;
}

// Paths whose content on the branch differs from what a clean three-way merge of the reviewed
// change onto the target gives: every conflicted path, and every reviewed path or path changed
// between the target and the branch whose blob differs from the merge result's.
export async function snapshotDiff(cwd: string, snapshot: MrSnapshot, branch: string): Promise<string[]> {
  const { tree, conflicted } = await expectedMerge(cwd, snapshot);
  const listed = await runGit(cwd, ['diff', '--name-only', '-z', '--no-renames', snapshot.target_commit, branch]);
  if (listed.code !== 0) {
    throw new Error(`git diff failed: ${listed.stderr.trim()}`);
  }
  const paths = new Set([...snapshot.paths, ...listed.stdout.toString('utf8').split('\0').filter((entry) => entry !== '')]);
  const expected: Record<string, string> = {};
  const actual: Record<string, string> = {};
  for (const path of paths) {
    expected[path] = await objectAt(cwd, `${tree}:${path}`);
    actual[path] = await objectAt(cwd, `${branch}:${path}`);
  }
  return [...new Set([...compareSnapshot(expected, actual), ...conflicted])].sort();
}

// Nothing is pushed to main (or master) or to the job's base directly; every change reaches it
// through a merge request (Handbook, Git rules).
export const PROTECTED_BRANCHES: readonly string[] = ['main', 'master'];

export function pushProtection(branch: string, base: string): MrFailure | undefined {
  if (branch !== base && !PROTECTED_BRANCHES.includes(branch)) {
    return undefined;
  }
  return {
    code: 'mr_push_protected',
    message: `refusing to push ${branch}: nothing is pushed to main, master or the base branch (${base}) directly; every change goes through a merge request`,
  };
}

export async function pushBranch(cwd: string, branch: string, base: string): Promise<MrFailure | undefined> {
  const protectedFailure = pushProtection(branch, base);
  if (protectedFailure !== undefined) {
    return protectedFailure;
  }
  const result = await runGit(cwd, ['push', 'origin', `${branch}:${branch}`], 1024 * 1024, PUSH_TIMEOUT_MS);
  if (result.code === 0) {
    return undefined;
  }
  const detail = result.code === null ? 'it did not finish within 120 s' : result.stderr.trim().slice(0, 1000);
  return { code: 'mr_push_failed', message: `git push origin ${branch} failed: ${detail}` };
}

export async function originUrl(cwd: string): Promise<string | undefined> {
  const result = await gitText(cwd, ['remote', 'get-url', 'origin']);
  return result.ok && result.text !== '' ? result.text : undefined;
}

// The page that opens a merge request for branch into base, derived from the origin URL:
// GitHub's compare view for github.com, GitLab's new merge request form otherwise.
export function mergeRequestLink(url: string, base: string, branch: string): string | undefined {
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(url);
  if (/^(https?|ssh|git):\/\//.test(url)) {
    const parsed = URL.parse(url);
    if (parsed === null || parsed.hostname === '') {
      return undefined;
    }
    host = parsed.protocol.startsWith('http') ? parsed.host : parsed.hostname;
    path = parsed.pathname;
  } else if (scp !== null) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return undefined;
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (path === '' || !path.includes('/')) {
    return undefined;
  }
  if (host === 'github.com') {
    return `https://${host}/${path}/compare/${base}...${branch}?expand=1`;
  }
  return `https://${host}/${path}/-/merge_requests/new?merge_request[source_branch]=${branch}&merge_request[target_branch]=${base}`;
}
