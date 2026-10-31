// SF-009: what a review is bound to, and what must not change behind its back.
//   treeFingerprint     HEAD, the index, every working-tree change against it (content hashed here,
//                       never through Git filters) and the Git control files (HEAD, config,
//                       packed-refs, refs/, the worktree's own gitdir files) and Git-ignored
//                       credential-style files (by content). Equal fingerprints
//                       before and after a capture mean no write landed during it; a fingerprint
//                       that differs from the snapshot's means the tree changed while the review
//                       was pending, so that review is never replayed against it.
//   descendants         processes started by the Claude process that are still alive (a background
//                       command can keep writing after the turn ended).
// Reads only; follows no symlink; bounded.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { GitInspector, type InspectorOptions } from '../execution/git-state.js';

const MAX_HASH_BYTES = 64 * 1024 * 1024;
const MAX_REF_ENTRIES = 20_000;

export interface TreeFingerprint {
  value: string;
  head: string | null;
  index_sha256: string;
  // Only the Git control part (HEAD file, config, refs): changes there are Git operations.
  control: string;
}

async function hashFile(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    if (code === 'ELOOP') return `symlink:${createHash('sha256').update(await readlink(path).catch(() => '')).digest('hex')}`;
    return `unreadable:${code ?? 'error'}`;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return stats.isDirectory() ? 'dir' : 'other';
    if (stats.size > MAX_HASH_BYTES) return `large:${stats.size}:${stats.mtimeMs}:${stats.ino}`;
    return createHash('sha256').update(await handle.readFile()).digest('hex');
  } finally {
    await handle.close();
  }
}

// The repository's git directory and common directory (a linked worktree has both), without running Git.
async function gitDirs(repo: string): Promise<{ gitDir: string; commonDir: string } | undefined> {
  const dotGit = join(repo, '.git');
  let stats;
  try {
    stats = await lstat(dotGit);
  } catch {
    return undefined;
  }
  let gitDir = dotGit;
  if (stats.isFile()) {
    const text = (await readFile(dotGit, 'utf8').catch(() => '')).trim();
    if (!text.startsWith('gitdir: ')) return undefined;
    const target = text.slice('gitdir: '.length);
    gitDir = isAbsolute(target) ? target : resolve(repo, target);
  } else if (!stats.isDirectory()) {
    return undefined;
  }
  const common = (await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
  return { gitDir, commonDir: common === '' ? gitDir : isAbsolute(common) ? common : resolve(gitDir, common) };
}

async function refEntries(dir: string, prefix: string, out: string[]): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (out.length >= MAX_REF_ENTRIES) {
      out.push('truncated');
      return;
    }
    const path = join(dir, name);
    const stats = await lstat(path).catch(() => undefined);
    if (stats?.isDirectory()) await refEntries(path, `${prefix}${name}/`, out);
    else out.push(`${prefix}${name}=${await hashFile(path)}`);
  }
}

export async function controlFingerprint(repo: string): Promise<string> {
  const dirs = await gitDirs(repo);
  if (dirs === undefined) return 'no-git-dir';
  const parts: string[] = [];
  for (const [label, path] of [
    ['HEAD', join(dirs.gitDir, 'HEAD')],
    ['config', join(dirs.commonDir, 'config')],
    ['config.worktree', join(dirs.gitDir, 'config.worktree')],
    ['packed-refs', join(dirs.commonDir, 'packed-refs')],
    ['MERGE_HEAD', join(dirs.gitDir, 'MERGE_HEAD')],
    ['REBASE', join(dirs.gitDir, 'rebase-merge')],
  ] as const) {
    parts.push(`${label}=${await hashFile(path)}`);
  }
  await refEntries(join(dirs.commonDir, 'refs'), 'refs/', parts);
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

// options: what the inspection leaves out (a self-hosted app: the mediator's own state directory).
export async function treeFingerprint(repo: string, options: InspectorOptions = {}): Promise<TreeFingerprint> {
  const snapshot = await new GitInspector(repo, options).snapshot();
  const control = await controlFingerprint(repo);
  // Git-ignored credential-style files too (.env and the like, also inside ignored directories),
  // which working-tree changes leave out: written by content fingerprint, never exported.
  const ignored = await new GitInspector(repo, options).ignored();
  const hash = createHash('sha256');
  hash.update(`head=${snapshot.head ?? 'none'}\nindex=${snapshot.index_sha256}\ncontrol=${control}\nignored-complete=${ignored.complete}\n`);
  for (const path of Object.keys(ignored.credentials).sort()) hash.update(`ignored ${path} ${ignored.credentials[path]}\n`);
  for (const change of [...snapshot.changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${change.status} ${change.path} ${await hashFile(join(repo, change.path))}\n`);
  }
  return { value: hash.digest('hex'), head: snapshot.head, index_sha256: snapshot.index_sha256, control };
}

// Live descendants of pid (one /proc pass).
export async function descendants(pid: number): Promise<number[]> {
  const children = new Map<number, number[]>();
  for (const entry of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // fields[0] is the state, fields[1] the parent pid; zombies do not write.
      if (fields[0] === 'Z') continue;
      const parent = Number(fields[1]);
      children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
    } catch {
      // Ended meanwhile.
    }
  }
  const found: number[] = [];
  const queue = [...(children.get(pid) ?? [])];
  while (queue.length > 0 && found.length < 10_000) {
    const next = queue.shift()!;
    found.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return found;
}
