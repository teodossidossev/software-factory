// The hand-over of a finished job to the workspace's checkout: the job's branch checked out
// there at its base B with the job's changes as Local Changes, the commit message prefilled; and the
// way back: Ask for changes (a snapshot of the checkout goes back into the job's worktree and the
// checkout gives the branch back), Take it back (only while the checkout is as the factory left it),
// the push check for the user's own push, and the repair of a step cut off. Only Git and the
// checkout's files; the Execution keeps the job record and calls these under the workspace's Git
// lock. Nothing here deletes or overwrites a file of the checkout that is not either unchanged since
// the factory wrote it or saved in a ref first; every refusal comes before the first change.
import { lstat, mkdir, readlink, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { FactoryError } from './errors.js';
import { type GitResult, runGit } from './git.js';
import type { Handover } from './jobs.js';
import { rebaseInProgress } from './mr.js';
import { TASK_DIR } from './task-file.js';
import { addWorktree, registeredWorktrees, removeWorktree } from './worktree.js';

// The saved refs of a ticket: the job's commit, and the checkout at Ask for changes.
export const savedRef = (ticket: string): string => `refs/factory/${ticket}`;
export const askRef = (ticket: string): string => `refs/factory/${ticket}-ask`;

// The factory's value of commit.cleanup while a job is handed over: a commit made from the command
// line keeps the # headings of the MR text.
const CLEANUP = 'scissors';
// Paths per Git call, so a long list never exceeds the argument limit.
const BATCH = 200;
// How long origin may take to say where the branch is.
const LS_REMOTE_TIMEOUT_MS = 20_000;

// A commit as the 12 characters messages show.
const short = (commit: string): string => commit.slice(0, 12);

// Every Git call of the hand-over runs without the repository's hooks: a job's branch may change a
// versioned hooks directory, and these calls run outside the sandbox. runGit (git.ts) switches
// them off for every factory Git call.
function git(cwd: string, args: string[], maxBytes = 1024 * 1024, timeoutMs?: number, env: Record<string, string> = {}): Promise<GitResult> {
  return runGit(cwd, args, maxBytes, timeoutMs, env);
}

// A failed Git call as a FactoryError with Git's text.
function gitFailure(code: string, what: string, result: GitResult): FactoryError {
  return new FactoryError(code, `${what} failed: ${result.stderr.trim().slice(0, 500) || `exit ${String(result.code)}`}`);
}

// Runs Git and returns its trimmed stdout; a failure throws code with Git's text.
async function gitOut(cwd: string, args: string[], code = 'handover_failed', env: Record<string, string> = {}): Promise<string> {
  const result = await git(cwd, args, 1024 * 1024, undefined, env);
  if (result.code !== 0) {
    throw gitFailure(code, `git ${args[0] === '--literal-pathspecs' ? args[1] : args[0]}`, result);
  }
  return result.stdout.toString('utf8').trim();
}

// NUL-separated output as a list, without empty entries.
function nulList(result: GitResult): string[] {
  return result.stdout.toString('utf8').split('\0').filter((entry) => entry !== '');
}

// Runs Git and returns its NUL-separated output as a list; a failure or a cut output throws.
async function nulOut(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string[]> {
  const result = await git(cwd, args, 64 * 1024 * 1024, undefined, env);
  if (result.code !== 0 || result.truncated) {
    throw gitFailure('handover_failed', `git ${args[0]}`, result);
  }
  return nulList(result);
}

// Runs Git once per batch of paths, as literal paths (no glob).
async function forPaths(cwd: string, args: string[], paths: string[], env: Record<string, string> = {}): Promise<void> {
  for (let start = 0; start < paths.length; start += BATCH) {
    await gitOut(cwd, ['--literal-pathspecs', ...args, '--', ...paths.slice(start, start + BATCH)], 'handover_failed', env);
  }
}

// The paths that to has and from does not (added), by tree, without rename detection.
function addedPaths(cwd: string, from: string, to: string): Promise<string[]> {
  return nulOut(cwd, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', from, to]);
}

// The checkout's untracked files that are not ignored.
function untrackedFiles(cwd: string): Promise<string[]> {
  return nulOut(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).then((paths) => paths.filter((path) => !path.endsWith('/')));
}

// Whether a path is in the Task directory, which the hand-over never puts into a job or deletes.
const inTaskDir = (path: string): boolean => path === TASK_DIR || path.startsWith(`${TASK_DIR}/`);

// The absolute path of a file in the checkout's Git directory.
async function gitPath(checkout: string, name: string): Promise<string> {
  return resolve(checkout, await gitOut(checkout, ['rev-parse', '--git-path', name]));
}

// The prefilled commit message of the ticket's handed-over branch: .git/factory/<ticket>.commit-msg.
export function commitMessagePath(checkout: string, ticket: string): Promise<string> {
  return gitPath(checkout, `factory/${ticket}.commit-msg`);
}

// The checkout's current branch (refs/heads/<name>), or undefined when HEAD is detached.
async function currentRef(checkout: string): Promise<string | undefined> {
  const result = await git(checkout, ['symbolic-ref', '-q', 'HEAD']);
  const ref = result.stdout.toString('utf8').trim();
  return result.code === 0 && ref !== '' ? ref : undefined;
}

// The commit a revision names, or undefined.
async function revParse(cwd: string, rev: string): Promise<string | undefined> {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', rev]);
  const commit = result.stdout.toString('utf8').trim();
  return result.code === 0 && commit !== '' ? commit : undefined;
}

// Whether anything (a symbolic link too) exists at path.
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// What a rebase, merge, cherry-pick or revert in progress in the checkout is, or undefined.
async function operationInProgress(checkout: string): Promise<string | undefined> {
  for (const [name, what] of [['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase'], ['MERGE_HEAD', 'a merge'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']] as const) {
    if (await pathExists(await gitPath(checkout, name))) {
      return what;
    }
  }
  return undefined;
}

// checkout_busy while a rebase, merge, cherry-pick or revert is in progress in the checkout.
async function checkNotBusy(checkout: string, ticket: string): Promise<void> {
  const busy = await operationInProgress(checkout);
  if (busy !== undefined) {
    throw new FactoryError('checkout_busy', `${ticket}: ${busy} is in progress in your checkout; finish or abort it first.`);
  }
}

// The paths of the list at which anything exists in the checkout (ignored or not), or whose parent
// directory is a file or a symbolic link there.
async function inTheWay(checkout: string, paths: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) {
    const parts = path.split('/');
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join('/');
      let info;
      try {
        info = await lstat(join(checkout, prefix));
      } catch {
        break;
      }
      if (depth === parts.length || !info.isDirectory()) {
        found.push(prefix);
        break;
      }
    }
  }
  return [...new Set(found)];
}

// The handover_refused message naming the paths in the way (the first 20).
function wayMessage(paths: string[]): string {
  const named = paths.slice(0, 20).join(', ');
  return `These files in your checkout are in the way: ${named}${paths.length > 20 ? `, and ${paths.length - 20} more` : ''}.`;
}

// The checkout's local value of a setting, or null when it is unset.
async function localConfig(checkout: string, key: string): Promise<string | null> {
  const result = await git(checkout, ['config', '--local', '--get', key]);
  return result.code === 0 ? result.stdout.toString('utf8').replace(/\n$/, '') : null;
}

// Puts commit.template and commit.cleanup back to what they were before the hand-over (unset when
// they were), but only while they still hold the factory's values: a value the user set since stays.
export async function restoreConfig(checkout: string, ticket: string, handover: Pick<Handover, 'template' | 'cleanup'>): Promise<void> {
  const template = await commitMessagePath(checkout, ticket);
  for (const [key, factory, remembered] of [['commit.template', template, handover.template], ['commit.cleanup', CLEANUP, handover.cleanup]] as const) {
    if ((await localConfig(checkout, key)) !== factory) {
      continue;
    }
    await gitOut(checkout, remembered === null ? ['config', '--local', '--unset', key] : ['config', '--local', key, remembered]);
  }
}

// The git switch arguments back to what the checkout was on before the hand-over; discard throws
// away the working tree's changes (only once they are saved in the snapshot).
function switchArgs(previous: Handover['previous'], discard = false): string[] {
  const force = discard ? ['--discard-changes'] : [];
  return 'branch' in previous ? ['switch', '-q', ...force, previous.branch] : ['switch', '-q', ...force, '--detach', previous.commit];
}

// Whether path is a registered worktree of the checkout that exists.
async function liveWorktree(checkout: string, path: string | null): Promise<boolean> {
  return path !== null && (await pathExists(path)) && (await registeredWorktrees(checkout)).includes(path);
}

// Before an Implementer turn: no job runs while the user's checkout holds its branch. The
// branch must not be checked out in the checkout, and the job's worktree must be on it: a detached
// one (a hand-over cut off, a worktree that could not be removed) is switched back to it, which Git
// refuses while another checkout has the branch. branch_in_checkout otherwise. A missing worktree,
// or one with a rebase in progress (MR preparation aborts it), is left to the caller.
export async function checkBranchFree(checkout: string, worktree: string | null, branch: string, ticket: string): Promise<void> {
  const refuse = (why: string): FactoryError => new FactoryError('branch_in_checkout', `${ticket}: ${why}; the Implementer does not work on the job until the branch is back in its worktree. Switch your checkout to another branch (your changes on ${branch} are yours to commit or move), then try again.`);
  if ((await currentRef(checkout)) === `refs/heads/${branch}`) {
    throw refuse(`the branch ${branch} is checked out in your checkout`);
  }
  if (worktree === null || !(await liveWorktree(checkout, worktree))) {
    return;
  }
  const ref = await currentRef(worktree);
  if (ref === `refs/heads/${branch}`) {
    return;
  }
  if (ref !== undefined) {
    throw refuse(`the job's worktree is on ${ref.replace(/^refs\/heads\//, '')}, not on ${branch}`);
  }
  if (await rebaseInProgress(worktree)) {
    return;
  }
  const switched = await git(worktree, ['switch', '-q', branch]);
  if (switched.code !== 0) {
    throw new FactoryError('branch_in_checkout', `${ticket}: the job's worktree could not be put back on ${branch} (${switched.stderr.trim().slice(0, 300)}); the Implementer does not work on the job until it is. Fix it in the worktree (sf status shows its path), then try again.`);
  }
}

// The job's worktree on its branch again: the existing one switched back to the branch (its files
// stay), or a new one added at path.
export async function attachWorktree(checkout: string, path: string, branch: string): Promise<void> {
  if (await liveWorktree(checkout, path)) {
    await gitOut(path, ['switch', '-q', branch]);
    return;
  }
  await removeWorktree(checkout, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await addWorktree(checkout, path, branch, { create: false });
}

export interface HandOverInput {
  checkout: string;
  // The job's worktree, which holds the branch; null or gone when it holds nothing.
  worktree: string | null;
  ticket: string;
  branch: string;
  // S: the job's commit (prepared_commit); B: the target commit the job used (base_commit).
  saved: string;
  base: string;
  // The commit message prefilled in the checkout: the MR text's title and body.
  message: string;
  at: string;
  // Writes the record on the job, before the checkout changes (step handing_over).
  record: (handover: Handover) => Promise<void>;
}

export interface HandedOver {
  handover: Handover;
  // Set when the worktree could not be removed (the job keeps its path).
  removeFailure?: string;
}

// The hand-over (steps 1 to 11 below): refused before anything changes when the checkout has
// tracked changes (checkout_dirty), an operation in progress (checkout_busy) or a file where the job
// adds one (handover_refused); undone when Git refuses the switch (handover_refused) or the working
// tree is not the job's commit afterwards (handover_mismatch). An undo that fails is
// handover_interrupted, with where things are.
export async function handOver(input: HandOverInput): Promise<HandedOver> {
  const { checkout, ticket, branch, saved, base } = input;
  // 1. No tracked change, no operation in progress.
  if ((await gitOut(checkout, ['status', '--porcelain', '--untracked-files=no'])) !== '') {
    throw new FactoryError('checkout_dirty', `${ticket}: ready, but your checkout has changes; hand it over when you are ready`);
  }
  await checkNotBusy(checkout, ticket);
  if ((await currentRef(checkout)) === `refs/heads/${branch}`) {
    throw new FactoryError('handover_refused', `Your checkout is on ${branch} already; switch to another branch, then hand it over.`);
  }
  // 2. Nothing, ignored or not, where the job adds a file: git switch would overwrite an ignored one.
  const blocked = await inTheWay(checkout, await addedPaths(checkout, 'HEAD', saved));
  if (blocked.length > 0) {
    throw new FactoryError('handover_refused', wayMessage(blocked));
  }
  // 3. The job's commit is saved before anything else.
  await gitOut(checkout, ['update-ref', savedRef(ticket), saved]);
  // 4. What the checkout was on and the user's own untracked files, recorded before any change.
  const ref = await currentRef(checkout);
  const previous: Handover['previous'] = ref !== undefined && ref.startsWith('refs/heads/')
    ? { branch: ref.slice('refs/heads/'.length) }
    : { commit: await gitOut(checkout, ['rev-parse', 'HEAD']) };
  const handover: Handover = {
    branch, saved, base, previous, untracked: await untrackedFiles(checkout),
    template: await localConfig(checkout, 'commit.template'), cleanup: await localConfig(checkout, 'commit.cleanup'),
    at: input.at, checked_at: null, step: 'handing_over',
  };
  await input.record(handover);
  // 5. The worktree lets go of the branch; its files stay.
  const worktree = (await liveWorktree(checkout, input.worktree)) ? input.worktree : null;
  if (worktree !== null) {
    await gitOut(worktree, ['switch', '-q', '--detach']);
  }
  const reattach = async (): Promise<void> => {
    if (worktree !== null) {
      await gitOut(worktree, ['switch', '-q', branch]);
    }
  };
  // 6. The branch in the checkout.
  const switched = await git(checkout, ['switch', '-q', branch]);
  if (switched.code !== 0) {
    await undo(ticket, branch, reattach, async () => undefined);
    throw new FactoryError('handover_refused', switched.stderr.trim().slice(0, 1000) || `git switch ${branch} failed.`);
  }
  const back = async (): Promise<void> => {
    await gitOut(checkout, ['reset', '-q', '--mixed', saved]);
    await gitOut(checkout, switchArgs(previous));
  };
  try {
    // 7. The branch at the base; the job's files stay and show as Local Changes.
    await gitOut(checkout, ['reset', '-q', '--mixed', base]);
    // 8. The files the job added are intent-to-add, so the IDE lists them.
    await forPaths(checkout, ['add', '-N'], await addedPaths(checkout, base, saved));
    // 9. The working tree is the job's commit.
    const same = await git(checkout, ['diff', '--quiet', saved]);
    if (same.code !== 0) {
      const files = (await nulOut(checkout, ['diff', '--name-only', '-z', '--no-renames', saved])).slice(0, 20);
      throw new FactoryError('handover_mismatch', `${ticket}: after the hand-over your checkout did not hold the job's commit ${short(saved)} (${files.join(', ')}); it was put back.`);
    }
    // 10. The commit message, prefilled for the IDE and the command line.
    const messagePath = await commitMessagePath(checkout, ticket);
    await mkdir(dirname(messagePath), { recursive: true });
    await writeFile(messagePath, input.message);
    await gitOut(checkout, ['config', '--local', 'commit.template', messagePath]);
    await gitOut(checkout, ['config', '--local', 'commit.cleanup', CLEANUP]);
  } catch (error) {
    await undo(ticket, branch, reattach, async () => {
      await back();
      await restoreConfig(checkout, ticket, handover);
    });
    throw error;
  }
  // 11. The worktree goes; a failure leaves it (detached) for the next action that needs it gone.
  const removeFailure = worktree === null ? undefined : await removeWorktree(checkout, worktree);
  return { handover: { ...handover, step: null }, ...(removeFailure !== undefined ? { removeFailure } : {}) };
}

// Undoes a hand-over cut short: the checkout first, then the worktree; a failure is
// handover_interrupted, naming where the branch and the saved commit are.
async function undo(ticket: string, branch: string, reattach: () => Promise<void>, checkoutBack: () => Promise<void>): Promise<void> {
  try {
    await checkoutBack();
    await reattach();
  } catch (error) {
    throw new FactoryError('handover_interrupted', `${ticket}: the hand-over failed and could not be undone (${(error as Error).message.slice(0, 300)}). The branch ${branch} may still be checked out in your checkout; the job's commit is saved as ${savedRef(ticket)}; the job's worktree may be detached.`);
  }
}

// The repair of a hand-over that sf serve's restart cut off (recover(), step handing_over): undone
// when it is safe, that is the checkout on the branch holding exactly S, its added files staged or
// not (reset to S, switched back), or still on what it was on; then the config restored and the worktree on the branch. Returns
// false, with the checkout untouched, when it is not safe.
export async function undoHandover(checkout: string, worktree: string, ticket: string, handover: Handover): Promise<boolean> {
  const ref = await currentRef(checkout);
  if (ref === `refs/heads/${handover.branch}`) {
    const tree = await snapshotTree(checkout, ticket, handover.untracked);
    if (tree !== (await gitOut(checkout, ['rev-parse', `${handover.saved}^{tree}`])) || (await blockedSwitchBack(checkout, handover.saved, handover)).length > 0) {
      return false;
    }
    await gitOut(checkout, ['reset', '-q', '--mixed', handover.saved]);
    if ((await git(checkout, switchArgs(handover.previous))).code !== 0) {
      return false;
    }
  } else {
    const onPrevious = 'branch' in handover.previous
      ? ref === `refs/heads/${handover.previous.branch}`
      : ref === undefined && (await revParse(checkout, 'HEAD')) === handover.previous.commit;
    if (!onPrevious) {
      return false;
    }
  }
  await restoreConfig(checkout, ticket, handover);
  await attachWorktree(checkout, worktree, handover.branch);
  return true;
}

// A snapshot of the checkout as a tree, with a temporary index: HEAD, every change and every
// untracked file that is not ignored, and every file of the checkout's index (intent-to-add ones
// too) even when ignored; without exclude and without untracked files under the Task directory
// (another ticket's Task file written meanwhile never goes into the job).
async function snapshotTree(checkout: string, ticket: string, exclude: string[]): Promise<string> {
  const index = await gitPath(checkout, `factory/${ticket}.snapshot-index`);
  await mkdir(dirname(index), { recursive: true });
  await rm(index, { force: true });
  const env = { GIT_INDEX_FILE: index };
  try {
    const own = await nulOut(checkout, ['ls-files', '-z']);
    await gitOut(checkout, ['read-tree', 'HEAD'], 'handover_failed', env);
    await gitOut(checkout, ['add', '-A'], 'handover_failed', env);
    const staged = new Set(await nulOut(checkout, ['ls-files', '-z'], env));
    const missing: string[] = [];
    for (const path of own) {
      if (!staged.has(path) && (await pathExists(join(checkout, path)))) {
        missing.push(path);
      }
    }
    await forPaths(checkout, ['add', '-f'], missing, env);
    const untracked = await untrackedFiles(checkout);
    const left = [...new Set([...exclude, ...untracked.filter(inTaskDir)])];
    await forPaths(checkout, ['rm', '--cached', '-q', '--ignore-unmatch'], left, env);
    return await gitOut(checkout, ['write-tree'], 'handover_failed', env);
  } finally {
    await rm(index, { force: true });
  }
}

// The paths whose blobs differ between two trees.
function changedBetween(cwd: string, from: string, to: string): Promise<string[]> {
  return nulOut(cwd, ['diff', '--name-only', '-z', '--no-renames', from, to]);
}

// The branch is the checkout's HEAD; checkout_moved otherwise.
async function checkOnBranch(checkout: string, branch: string): Promise<void> {
  if ((await currentRef(checkout)) !== `refs/heads/${branch}`) {
    throw new FactoryError('checkout_moved', `Your checkout is not on ${branch}; switch back to it, or use Take it back.`);
  }
}

// The files the switch back to previous would overwrite without a copy: anything at a path
// previous has and from does not that is ignored and untracked (Git treats those as expendable), or
// one of the user's own untracked files from before the hand-over or a file of the Task directory
// (neither goes into the snapshot). Any other untracked file is in the snapshot.
async function blockedSwitchBack(checkout: string, from: string, handover: Handover): Promise<string[]> {
  const { previous } = handover;
  const own = new Set(handover.untracked);
  const target = 'branch' in previous ? `refs/heads/${previous.branch}` : previous.commit;
  if ((await revParse(checkout, `${target}^{commit}`)) === undefined) {
    return [];
  }
  const present = await inTheWay(checkout, await addedPaths(checkout, from, target));
  const ignored: string[] = [];
  for (const path of present) {
    if (own.has(path) || inTaskDir(path)) {
      ignored.push(path);
      continue;
    }
    // check-ignore answers only for untracked paths (an index entry is never ignored): 0 ignored, 1 not.
    const result = await git(checkout, ['check-ignore', '-q', '--', path]);
    if (result.code === 0) {
      ignored.push(path);
    } else if (result.code !== 1) {
      throw gitFailure('handover_failed', 'git check-ignore', result);
    }
  }
  return ignored;
}

export interface AskInput {
  checkout: string;
  worktree: string;
  ticket: string;
  handover: Handover;
  // Writes the record on the job before the checkout changes (step asking, with the snapshot).
  record: (handover: Handover) => Promise<void>;
}

export interface Asked {
  snapshot: string;
  // Files left in the checkout because they changed after the snapshot.
  kept: string[];
}

// Ask for changes, the Git steps (1 to 4): the checkout must be on the branch
// (checkout_moved) and quiet (checkout_busy); its state goes into refs/factory/<ticket>-ask, the
// checkout gives the branch back (checkout_changing when a file changed meanwhile, nothing
// changed then), and the job's worktree holds the snapshot as uncommitted changes on B.
export async function askForChanges(input: AskInput): Promise<Asked> {
  const { checkout, ticket, handover } = input;
  await checkOnBranch(checkout, handover.branch);
  await checkNotBusy(checkout, ticket);
  const blocked = await blockedSwitchBack(checkout, 'HEAD', handover);
  if (blocked.length > 0) {
    throw new FactoryError('handover_refused', `${wayMessage(blocked)} The switch back would overwrite them; move them first.`);
  }
  const tip = await gitOut(checkout, ['rev-parse', 'HEAD']);
  const tree = await snapshotTree(checkout, ticket, handover.untracked);
  const snapshot = await gitOut(checkout, ['commit-tree', tree, '-p', tip, '-m', `${ticket}: your checkout at Ask for changes`]);
  await gitOut(checkout, ['update-ref', askRef(ticket), snapshot]);
  await input.record({ ...handover, step: 'asking', snapshot });
  if ((await snapshotTree(checkout, ticket, handover.untracked)) !== tree) {
    throw new FactoryError('checkout_changing', 'A file in your checkout changed during Ask for changes; try again.');
  }
  const kept = await giveBack(checkout, ticket, handover, snapshot);
  await worktreeAtSnapshot(checkout, input.worktree, handover, snapshot, tip);
  await restoreConfig(checkout, ticket, handover);
  return { snapshot, kept };
}

// Step 3 of Ask for changes once the snapshot is saved: the checkout back on previous, discarding
// what the snapshot holds, and the untracked files the switch left that are the snapshot's deleted
// (each only while its content is the snapshot's; the others are returned). The user's own
// untracked files from before the hand-over and the Task directory are never touched.
async function giveBack(checkout: string, ticket: string, handover: Handover, snapshot: string): Promise<string[]> {
  const own = new Set(handover.untracked);
  const candidate = (path: string): boolean => !own.has(path) && !inTaskDir(path);
  const before = new Set((await untrackedFiles(checkout)).filter(candidate));
  if ((await currentRef(checkout)) === `refs/heads/${handover.branch}`) {
    const switched = await git(checkout, switchArgs(handover.previous, true));
    if (switched.code !== 0) {
      throw new FactoryError('handover_failed', `${ticket}: the switch back failed (${switched.stderr.trim().slice(0, 500)}); your checkout is saved as ${askRef(ticket)}.`);
    }
  }
  const kept: string[] = [];
  for (const path of await untrackedFiles(checkout)) {
    if (!candidate(path) || !before.has(path)) {
      continue;
    }
    if (await sameAsSnapshot(checkout, snapshot, path)) {
      await rm(join(checkout, path), { force: true });
    } else {
      kept.push(path);
    }
  }
  return kept;
}

// Whether the checkout's file at path has the content of its blob in the snapshot.
async function sameAsSnapshot(checkout: string, snapshot: string, path: string): Promise<boolean> {
  const entry = nulList(await git(checkout, ['ls-tree', '-z', snapshot, '--', path]))[0];
  const match = entry === undefined ? null : /^(\d+) blob ([0-9a-f]+)\t/.exec(entry);
  if (match === null) {
    return false;
  }
  const [, mode, blob] = match;
  const info = await lstat(join(checkout, path));
  if (mode === '120000') {
    if (!info.isSymbolicLink()) {
      return false;
    }
    const target = await git(checkout, ['cat-file', 'blob', blob!]);
    return target.code === 0 && target.stdout.toString('utf8') === (await readlink(join(checkout, path)));
  }
  if (!info.isFile()) {
    return false;
  }
  const hashed = await git(checkout, ['--literal-pathspecs', 'hash-object', '--', path]);
  return hashed.code === 0 && hashed.stdout.toString('utf8').trim() === blob;
}

// Step 4: the branch moved to the snapshot (from the tip it had), the job's worktree on it, and the
// worktree reset to B, so the user's edits and commits are uncommitted changes there.
async function worktreeAtSnapshot(checkout: string, worktree: string, handover: Handover, snapshot: string, tip: string): Promise<void> {
  const ref = `refs/heads/${handover.branch}`;
  if ((await revParse(checkout, ref)) !== snapshot) {
    await removeWorktree(checkout, worktree);
    await gitOut(checkout, ['update-ref', ref, snapshot, tip]);
  }
  if (!(await liveWorktree(checkout, worktree))) {
    await removeWorktree(checkout, worktree);
    await mkdir(dirname(worktree), { recursive: true, mode: 0o700 });
    await addWorktree(checkout, worktree, handover.branch, { create: false });
  }
  await gitOut(worktree, ['reset', '-q', '--mixed', handover.base]);
}

// The rest of an Ask for changes that sf serve's restart cut off (recover(), step asking): from the
// saved snapshot, or, when the checkout is still on the branch and changed since, from a new one
// that holds the change too.
export async function finishAsk(checkout: string, worktree: string, ticket: string, handover: Handover): Promise<Asked> {
  let snapshot = handover.snapshot ?? (await revParse(checkout, askRef(ticket)));
  if (snapshot === undefined) {
    throw new FactoryError('handover_failed', `${ticket}: the snapshot of Ask for changes is missing.`);
  }
  // The branch's tip when the snapshot was taken: the snapshot's parent.
  let tip = await gitOut(checkout, ['rev-parse', `${snapshot}^`]);
  if ((await currentRef(checkout)) === `refs/heads/${handover.branch}`) {
    const tree = await snapshotTree(checkout, ticket, handover.untracked);
    if (tree !== (await gitOut(checkout, ['rev-parse', `${snapshot}^{tree}`]))) {
      tip = await gitOut(checkout, ['rev-parse', 'HEAD']);
      snapshot = await gitOut(checkout, ['commit-tree', tree, '-p', tip, '-m', `${ticket}: your checkout at Ask for changes`]);
      await gitOut(checkout, ['update-ref', askRef(ticket), snapshot]);
    }
  }
  const kept = await giveBack(checkout, ticket, handover, snapshot);
  await worktreeAtSnapshot(checkout, worktree, handover, snapshot, tip);
  await restoreConfig(checkout, ticket, handover);
  return { snapshot, kept };
}

// Take it back: only while HEAD is the branch at B and the checkout's snapshot is the
// job's commit (takeback_changed otherwise, naming the files); the branch back on S, the checkout on
// previous, the config restored and the worktree on the branch. A switch back that fails is undone
// (takeback_switch_failed): the checkout and the branch are as before.
export async function takeBack(checkout: string, worktree: string, ticket: string, handover: Handover): Promise<void> {
  const { branch, base, saved } = handover;
  const changed = (what: string): FactoryError => new FactoryError('takeback_changed', `Your checkout changed since the hand-over: ${what}. Use Ask for changes to send your edits to the job, or undo them.`);
  if ((await currentRef(checkout)) !== `refs/heads/${branch}`) {
    throw changed(`it is not on ${branch}`);
  }
  const tip = await revParse(checkout, `refs/heads/${branch}`);
  if (tip !== base) {
    throw changed(`${branch} is at ${short(tip ?? '')}, not at the base ${short(base)}`);
  }
  await checkNotBusy(checkout, ticket);
  const blocked = await blockedSwitchBack(checkout, saved, handover);
  if (blocked.length > 0) {
    throw new FactoryError('handover_refused', `${wayMessage(blocked)} The switch back would overwrite them; move them first.`);
  }
  const tree = await snapshotTree(checkout, ticket, handover.untracked);
  const files = await changedBetween(checkout, `${saved}^{tree}`, tree);
  if (files.length > 0) {
    throw changed(files.slice(0, 20).join(', ') + (files.length > 20 ? `, and ${files.length - 20} more` : ''));
  }
  await gitOut(checkout, ['reset', '-q', '--mixed', saved]);
  const switched = await git(checkout, switchArgs(handover.previous));
  if (switched.code !== 0) {
    await gitOut(checkout, ['reset', '-q', '--mixed', base]);
    await forPaths(checkout, ['add', '-N'], await addedPaths(checkout, base, saved));
    throw new FactoryError('takeback_switch_failed', `Your checkout could not switch back (${switched.stderr.trim().slice(0, 500)}); it is on ${branch} as before.`);
  }
  await restoreConfig(checkout, ticket, handover);
  await attachWorktree(checkout, worktree, branch);
}

// Whether ancestor is an ancestor of commit (or the same commit).
export async function isAncestor(cwd: string, ancestor: string, commit: string): Promise<boolean> {
  return (await git(cwd, ['merge-base', '--is-ancestor', ancestor, commit])).code === 0;
}

// After the factory pushed the saved commit of a branch the user did not commit on: the branch on S
// (the working tree untouched), only while the checkout is on the branch at B, so the IDE shows only
// the user's own edits. Returns the number of files the user changed beyond S (tracked changes and
// new untracked files), or undefined when the checkout was not touched.
export async function settleAfterPush(checkout: string, handover: Handover): Promise<number | undefined> {
  const { branch, base, saved } = handover;
  if ((await currentRef(checkout)) !== `refs/heads/${branch}` || (await revParse(checkout, `refs/heads/${branch}`)) !== base) {
    return undefined;
  }
  await gitOut(checkout, ['reset', '-q', '--mixed', saved]);
  return uncommittedCount(checkout, handover);
}

// The files the checkout changed beyond HEAD: tracked changes, and untracked files that are not
// ignored and not the user's own from before the hand-over (nor in the Task directory).
export async function uncommittedCount(checkout: string, handover: Handover): Promise<number> {
  const own = new Set(handover.untracked);
  const tracked = await nulOut(checkout, ['diff', '--name-only', '-z', '--no-renames', 'HEAD']);
  const untracked = (await untrackedFiles(checkout)).filter((path) => !own.has(path) && !inTaskDir(path));
  return new Set([...tracked, ...untracked]).size;
}

// The subject of a commit.
export function subjectOf(cwd: string, commit: string): Promise<string> {
  return gitOut(cwd, ['log', '-1', '--format=%s', commit]);
}

// Where the branch is on origin, for the user's own push: missing, still at B, or a commit R that
// counts as pushed (known locally and descending from B: pushed; same_tree whether its tree is the
// job's commit's), or one that does not (unknown locally, or not descending from B).
export type RemoteBranch =
  | { kind: 'missing' }
  | { kind: 'at_base' }
  | { kind: 'pushed'; commit: string; same_tree: boolean }
  | { kind: 'unknown'; commit: string }
  | { kind: 'unrelated'; commit: string };

// git ls-remote origin refs/heads/<branch> (20 s at most); a failure throws push_check_failed.
export async function remoteBranch(checkout: string, ticket: string, handover: Handover, branch = handover.branch): Promise<RemoteBranch> {
  const ref = `refs/heads/${branch}`;
  const result = await git(checkout, ['ls-remote', 'origin', ref], 64 * 1024, LS_REMOTE_TIMEOUT_MS);
  if (result.code !== 0) {
    throw new FactoryError('push_check_failed', result.code === null ? `origin did not answer within ${LS_REMOTE_TIMEOUT_MS / 1000} s.` : `git ls-remote origin failed: ${result.stderr.trim().slice(0, 300)}`);
  }
  const line = result.stdout.toString('utf8').split('\n').find((entry) => entry.endsWith(`\t${ref}`));
  const commit = line?.split('\t')[0];
  if (commit === undefined || !/^[0-9a-f]{40,64}$/.test(commit)) {
    return { kind: 'missing' };
  }
  if (commit === handover.base) {
    return { kind: 'at_base' };
  }
  if ((await git(checkout, ['cat-file', '-e', `${commit}^{commit}`])).code !== 0) {
    return { kind: 'unknown', commit };
  }
  if (!(await isAncestor(checkout, handover.base, commit))) {
    return { kind: 'unrelated', commit };
  }
  const same = await git(checkout, ['diff', '--quiet', savedRef(ticket), commit]);
  return { kind: 'pushed', commit, same_tree: same.code === 0 };
}
