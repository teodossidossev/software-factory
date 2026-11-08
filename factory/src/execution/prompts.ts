// The text the job lifecycle gives the Implementer (SF-142, from src/execution/shared.ts): the
// first prompt of a job, the notes of a changed Task file or its images, and the groups of the
// factory's marked paths.
import { SCOPE_PROBLEM, SENSITIVE_PROBLEM } from '../ledger.js';
import type { ReviewItem } from '../review.js';
import { TASK_DIR } from '../task-file.js';

// The paths of the factory's fix items (src/review.ts, unacceptedItems) by kind, each with its
// label: the undeclared sensitive paths, then the paths outside the Task's scope (SF-053).
export function markedGroups(items: ReviewItem[]): Array<{ label: string; paths: string[] }> {
  return [
    { label: 'undeclared sensitive path(s)', problem: SENSITIVE_PROBLEM },
    { label: "path(s) outside the Task's scope", problem: SCOPE_PROBLEM },
  ].map(({ label, problem }) => ({ label, paths: items.filter((item) => item.problem === problem).map((item) => item.path) }))
    .filter((group) => group.paths.length > 0);
}

// The line of a Resume's prompt when the Task's images changed while the job was paused (SF-065).
export function imagesChangedNote(names: readonly string[]): string {
  return `The Task's images changed while the job was paused: ${names.join(', ')}.`;
}

// How many kept files the first prompt names.
const MAX_KEPT_NAMED = 50;

// What the Implementer is told of a Task file that changed since it was last given it (SF-067:
// on Resume, or the next Fix section or sf say after a review round resumed): its diff, or, when
// none could be made, to read it again.
export function changeNote(ticket: string, diff: string | undefined): string {
  const path = `${TASK_DIR}/${ticket}.md`;
  if (diff === undefined) {
    return `The Task file ${path} changed since you were last given it (while the job was paused); the copy in your worktree is the new version. Read it again and act on what changed.`;
  }
  return [`The Task file ${path} changed since you were last given it (while the job was paused); the copy in your worktree is the new version. Act on the change:`, '', '````diff', diff, '````'].join('\n');
}

// The first prompt of a job: /implement of its Task file, then the job's <rules> block when it has
// one (SF-059); after sf restart --keep-files (SF-067), with the files kept from the previous job.
export function firstPrompt(ticket: string, kept: string[], rules = ''): string {
  const command = [`/implement ${TASK_DIR}/${ticket}.md`, ...(rules !== '' ? ['', rules.trimEnd()] : [])].join('\n');
  if (kept.length === 0) {
    return command;
  }
  const more = kept.length > MAX_KEPT_NAMED ? `, and ${kept.length - MAX_KEPT_NAMED} more` : '';
  return [
    command,
    '',
    `This job restarts an earlier job of ${ticket}. The files that job had changed or added were copied into this worktree before this turn, uncommitted: ${kept.slice(0, MAX_KEPT_NAMED).join(', ')}${more}. They may predate the current Task file: keep what fits it, change or remove the rest.`,
  ].join('\n');
}
