// The Task check's findings of the factory on a Task's slice (Handbook: Slicing a solution): a
// slice key that is not valid is a nit, and a change or switch slice whose expected files are more
// than the norm's change_max_files (src/norms.ts) is a major, a nit when the Task says under
// "## Why whole" why it is only safe whole. Added by settleCheck (src/task-check.ts).
import type { CheckFinding, CheckOutput } from './task-check.js';
import { MAX_SLICES, parseFrontMatter, SLICE_KINDS, taskSlice } from './task-file.js';

const WHY_WHOLE_HEADING = '## Why whole';
const KEYS_EXPECTED = `part_of is a ticket name, slice is N/M with 1 <= N <= M <= ${MAX_SLICES}, kind is one of ${SLICE_KINDS.join(', ')}.`;

// Whether the Task has the line "## Why whole" and a non-blank line under it, before the next
// "## " heading or the end.
export function saysWhyWhole(task: string): boolean {
  const lines = task.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === WHY_WHOLE_HEADING);
  if (start < 0) {
    return false;
  }
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) {
      return false;
    }
    if (line.trim() !== '') {
      return true;
    }
  }
  return false;
}

// The factory's findings on the Task's slice keys and its size against the norm (maxFiles: the
// workspace's slice.change_max_files; without it, no size finding).
export function sliceFindings(task: string, files: CheckOutput['files'], maxFiles?: number): CheckFinding[] {
  const slice = taskSlice(parseFrontMatter(task) ?? new Map<string, string>());
  const findings: CheckFinding[] = slice.problems.map((problem) => ({
    kind: 'unclear', severity: 'nit', where: 'front matter', problem, expected: KEYS_EXPECTED,
  }));
  if (maxFiles !== undefined && (slice.kind === 'change' || slice.kind === 'switch') && files.length > maxFiles) {
    const whole = saysWhyWhole(task);
    findings.push({
      kind: 'overreach', severity: whole ? 'nit' : 'major', where: 'slice norm',
      problem: `${files.length} files are expected; the norm of a change slice is ${maxFiles}.`,
      expected: whole
        ? 'Get the user\'s agreement to keep it whole.'
        : 'Cut it again along the next axis (Handbook: Slicing a solution), or say under "## Why whole" why it is only safe whole.',
    });
  }
  return findings;
}
