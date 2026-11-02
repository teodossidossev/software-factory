// MR preparation steps on the work checkout, all through runGit: the target, the snapshot of the
// reviewed change, the verification at turn end, the diff check, the push and the merge request
// link. The Execution drives them around the Implementer's turn; this module runs no turn.
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import type { MrSnapshot } from './jobs.js';
import { changedPaths } from './patch.js';
import { headerProblem, MR_REQUIRED_HEADINGS } from './rules.js';
import { TASK_DIR } from './task-file.js';

const FETCH_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;
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

// The blob hash Git would store for the working tree content of path, or "absent". A symbolic
// link is stored as its target text, hashed here without following it (SHA-1 object format).
async function workingTreeHash(cwd: string, path: string): Promise<string> {
  let stats;
  try {
    stats = await lstat(join(cwd, path));
  } catch {
    return ABSENT;
  }
  if (stats.isSymbolicLink()) {
    const body = Buffer.from(await readlink(join(cwd, path)), 'utf8');
    return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
  }
  const result = await gitText(cwd, ['hash-object', '--', path]);
  if (!result.ok) {
    throw new Error(`git hash-object failed for ${path}: ${result.stderr}`);
  }
  return result.text;
}

// Every path of the current Patch with its working tree hash.
export async function takeSnapshot(cwd: string, baseCommit: string, target: { ref: string; commit: string }): Promise<MrSnapshot> {
  const { tracked, untracked } = await changedPaths(cwd, baseCommit);
  const files: Record<string, string> = {};
  for (const path of [...tracked, ...untracked].sort()) {
    files[path] = await workingTreeHash(cwd, path);
  }
  return { target_ref: target.ref, target_commit: target.commit, files };
}

// Paths whose committed state differs from the snapshot: listed in only one of them, or with
// another hash. Sorted.
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
  // Not trimmed: porcelain lines start with a status column that may be a space.
  const status = await runGit(cwd, ['status', '--porcelain', '--untracked-files=all']);
  const dirty = status.stdout.toString('utf8').split('\n').filter((line) => line !== '' && !/^.. "?\.software-factory\//.test(line));
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

// Paths whose content on the branch differs from the reviewed snapshot.
export async function snapshotDiff(cwd: string, snapshot: MrSnapshot, branch: string): Promise<string[]> {
  const listed = await runGit(cwd, ['diff', '--name-only', '-z', '--no-renames', snapshot.target_commit, branch]);
  if (listed.code !== 0) {
    throw new Error(`git diff failed: ${listed.stderr.trim()}`);
  }
  const actual: Record<string, string> = {};
  for (const path of listed.stdout.toString('utf8').split('\0').filter((entry) => entry !== '')) {
    const blob = await gitText(cwd, ['rev-parse', '--verify', '--quiet', `${branch}:${path}`]);
    actual[path] = blob.ok ? blob.text : ABSENT;
  }
  return compareSnapshot(snapshot.files, actual);
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
