// A job that continues an open merge request: `continues: <branch>` in the Task's front matter names
// the source branch of a merge request already open on origin; `base` stays that merge request's
// target. The job starts from origin/<continues>, MR preparation rebases onto it, and Approve pushes
// the prepared commit onto refs/heads/<continues> (never forced), so the open merge request shows
// the change. The job's own local branch keeps its name and is never pushed.
import { FactoryError } from './errors.js';
import type { Job } from './jobs.js';
import { PROTECTED_BRANCHES, validBranchName } from './mr.js';

// A branch name the Task file may give without Git: letters, digits, ".", "_", "/" and "-", not
// starting with "-" or "/", not ending with "/", "." or ".lock", without ".." or "//".
function plainBranchName(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(name) && !/^[-/]/.test(name) && !/(\/|\.|\.lock)$/.test(name) && !name.includes('..') && !name.includes('//');
}

// The write-time check of a Task's continues against its base (invalid_content): a branch other
// than the base, not a protected one, with a valid name.
export function validContinues(name: string, base: string): void {
  if (name === base) {
    throw new FactoryError('invalid_content', '"continues" must differ from "base".');
  }
  if (PROTECTED_BRANCHES.includes(name)) {
    throw new FactoryError('invalid_content', `"continues" must not be a protected branch (${name}).`);
  }
  if (!plainBranchName(name)) {
    throw new FactoryError('invalid_content', '"continues" must be a valid branch name.');
  }
}

// The Task's continued branch from its front matter; null without the field.
export function taskContinues(fields: Map<string, string>): string | null {
  return fields.get('continues') ?? null;
}

// The branch a Task's code is read from (its plan check, its rules): continues, else base; '' with
// neither.
export function taskStartBranch(fields: Map<string, string> | undefined): string {
  return fields?.get('continues') ?? fields?.get('base') ?? '';
}

// The branch a job starts from, checked as a branch name on the checkout first (base_not_found
// otherwise): its continued branch, else its base.
export async function startBranch(checkout: string, base: string, continues: string | null): Promise<string> {
  if (continues === null) {
    return base;
  }
  if (!(await validBranchName(checkout, continues))) {
    throw new FactoryError('base_not_found', `The continued branch "${continues}" is not a valid branch name.`);
  }
  return continues;
}

// The branch MR preparation rebases the job's commit onto: its continued branch, else its base.
export function targetBranch(job: Pick<Job, 'base' | 'continues'>): string {
  return job.continues ?? job.base;
}

// The job's branch on origin, the one Approve pushes and the merge request is opened from: its
// continued branch, else its own branch.
export function pushedBranch(job: Pick<Job, 'branch' | 'continues'>): string {
  return job.continues ?? job.branch;
}
