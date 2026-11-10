// The check before the automatic hand-over: the paths of the prepared change that the sensitive
// rules name. The user's checkout is open in their IDE and tools, which run some of its files by
// themselves (a Gradle or Maven build, the Gradle wrapper, VS Code tasks, agent hooks, Git hooks),
// as the user and outside any sandbox; a change to one of them waits for a person to read it.
// The Task's may_touch exempts nothing here.
import { runGit } from './git.js';
import type { Job } from './jobs.js';
import { sensitivityOf } from './rules.js';

// The handoff_skipped code of a job not handed over by itself because of this check.
export const HANDOFF_SENSITIVE_CODE = 'handoff_sensitive';

// How many paths the skip's message names.
const NAMED = 5;

// The bound of Git's output: a change whose list of paths is larger fails the check.
const MAX_BYTES = 16 * 1024 * 1024;

// Every path the change from base to prepared adds, changes, deletes or renames (a rename's
// old and new paths both), in Git's order. Throws when Git fails or its output is cut.
async function changedPaths(cwd: string, base: string, prepared: string): Promise<string[]> {
  const result = await runGit(cwd, ['diff', '--no-color', '--no-relative', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', base, prepared, '--'], MAX_BYTES);
  if (result.code !== 0 || result.truncated) {
    const reason = result.truncated ? 'the list is too large' : result.stderr.trim() || `git diff exited with ${result.code}`;
    throw new Error(reason.slice(0, 300));
  }
  // Entries: a status, then one path, or two for a rename or copy (R100, C75).
  const fields = result.stdout.toString('utf8').split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index]!;
    if (status === '') {
      continue;
    }
    const count = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    paths.push(...fields.slice(index + 1, index + 1 + count).filter((path) => path !== ''));
    index += count;
  }
  return paths;
}

// The changed paths that SENSITIVE_PATHS or the extra globs (SF_SENSITIVE_PATHS) name, each once.
export async function sensitiveChanges(cwd: string, base: string, prepared: string, extra: readonly string[]): Promise<string[]> {
  const paths = await changedPaths(cwd, base, prepared);
  return [...new Set(paths.filter((path) => sensitivityOf(path, [], extra) !== 'no'))];
}

// The handoff_skipped of a change the factory does not hand over by itself: one that touches a
// sensitive path, or one whose paths could not be listed. undefined: it may be handed over.
export async function handoffSensitive(cwd: string, base: string, prepared: string, extra: readonly string[]): Promise<NonNullable<Job['handoff_skipped']> | undefined> {
  let paths: string[];
  try {
    paths = await sensitiveChanges(cwd, base, prepared, extra);
  } catch (error) {
    return { code: HANDOFF_SENSITIVE_CODE, message: `could not list the change's files: ${(error as Error).message}` };
  }
  if (paths.length === 0) {
    return undefined;
  }
  const more = paths.length > NAMED ? ` and ${paths.length - NAMED} more` : '';
  return { code: HANDOFF_SENSITIVE_CODE, message: `it changes files your IDE or tools may run: ${paths.slice(0, NAMED).join(', ')}${more}; read them, then hand it over` };
}
