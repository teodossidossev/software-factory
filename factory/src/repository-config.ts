// The repository's Claude Code configuration in a planning copy: the sparse checkout that leaves it
// out of the copy's working tree (every tracked file under a .claude folder at any depth but
// CLAUDE.md, and the top .mcp.json), and what of it a working tree still holds (a tracked file with
// changes of the user's, which a sparse checkout leaves; a .mcp.json Git does not track; a path
// tracked as .claude itself, which no pattern can leave out without its CLAUDE.md files).
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';

// The planning copy's sparse checkout: the repository's code and its CLAUDE.md files, never a
// tracked file under a .claude folder at any depth (its Claude Code configuration) nor the top
// .mcp.json (its MCP servers).
export const COPY_SPARSE_PATTERNS = ['/*', '!**/.claude/*', '**/.claude/CLAUDE.md', '!/.mcp.json'] as const;

// The longest a Git call here may take, and the most of its output read.
const CONFIG_GIT_TIMEOUT_MS = 60_000;
const LISTED_BYTES = 4 * 1024 * 1024;

// The repository's Claude Code configuration that the copy's working tree holds, by path: the
// tracked paths under a .claude folder, or tracked as .claude itself (a link, a file or a
// submodule), at any depth, but CLAUDE.md, in Git's order, then .mcp.json; of these the ones that
// exist there in any form (a file, a folder, a link).
export async function repositoryConfigIn(copy: string): Promise<string[]> {
  const listed = await runGit(copy, ['ls-files', '-z', '--', ':(glob)**/.claude/**', ':(glob)**/.claude'], LISTED_BYTES, CONFIG_GIT_TIMEOUT_MS);
  if (listed.code !== 0 || listed.truncated) {
    const detail = listed.truncated ? 'its output passed 4 MiB' : listed.code === null ? 'it did not run to its end' : `exit ${listed.code}`;
    throw new FactoryError('planning_copy_unsafe', `The planning copy could not be checked for the repository's Claude Code configuration: git ls-files failed (${detail}).`);
  }
  const tracked = listed.stdout.toString('utf8').split('\0')
    .filter((path) => path !== '' && path !== '.claude/CLAUDE.md' && !path.endsWith('/.claude/CLAUDE.md'));
  const present: string[] = [];
  for (const path of [...tracked, '.mcp.json']) {
    // Any form counts: lstat succeeds for a file, a folder or a link, its target never read.
    if (await lstat(join(copy, path)).then(() => true, () => false)) {
      present.push(path);
    }
  }
  return present;
}
