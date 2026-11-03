// The worktree of a job (SF-019): created from the workspace's checkout at start, recreated from
// the branch after Clean when the Context owner asks for another fix, and removed at Clean, at
// the end of the job and by reset. Every Git call runs through runGit; nothing here knows about
// jobs or sessions.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';

const SUBMODULE_TIMEOUT_MS = 120_000;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// The worktree paths Git knows for the checkout, absolute.
export async function registeredWorktrees(checkout: string): Promise<string[]> {
  const result = await runGit(checkout, ['worktree', 'list', '--porcelain']);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout.toString('utf8').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
}

// `git worktree add` at path: with a new branch from ref (create), or of the existing branch.
// A leftover directory or a registration at the path is worktree_exists.
export async function addWorktree(checkout: string, path: string, branch: string, options: { create: true; ref: string } | { create: false }): Promise<void> {
  if ((await exists(path)) || (await registeredWorktrees(checkout)).includes(path)) {
    throw new FactoryError('worktree_exists', `A worktree directory or registration already exists for ${branch}; sf reset the ticket removes it.`);
  }
  const args = options.create ? ['worktree', 'add', '--no-track', '-b', branch, path, options.ref] : ['worktree', 'add', path, branch];
  const result = await runGit(checkout, args);
  if (result.code !== 0) {
    throw new FactoryError('start_failed', `git worktree add failed: ${result.stderr.trim().slice(0, 500)}`);
  }
  if (await exists(join(path, '.gitmodules'))) {
    const submodules = await runGit(path, ['submodule', 'update', '--init', '--recursive'], 1024 * 1024, SUBMODULE_TIMEOUT_MS);
    if (submodules.code !== 0) {
      throw new FactoryError('start_failed', submodules.code === null ? 'git submodule update did not finish within 120 s.' : `git submodule update failed: ${submodules.stderr.trim().slice(0, 500)}`);
    }
  }
}

// Removes the worktree (its files too, --force) and prunes stale registrations; a missing
// worktree is not an error. Returns a failure message, or undefined.
export async function removeWorktree(checkout: string, path: string): Promise<string | undefined> {
  if (await exists(path)) {
    const removed = await runGit(checkout, ['worktree', 'remove', '--force', path]);
    if (removed.code !== 0) {
      return `git worktree remove failed: ${removed.stderr.trim().slice(0, 500)}`;
    }
  }
  await runGit(checkout, ['worktree', 'prune']);
  return undefined;
}

// Deletes the job's branch in the checkout.
export async function deleteBranch(checkout: string, branch: string): Promise<string | undefined> {
  const result = await runGit(checkout, ['branch', '-D', branch]);
  return result.code === 0 ? undefined : `git branch -D ${branch} failed: ${result.stderr.trim().slice(0, 500)}`;
}
