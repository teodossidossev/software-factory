// The text the job lifecycle gives the Implementer: the first prompt of a job, the prompt of a fix
// round in a new session, the notes of a changed Task file or its images, and the groups of the
// factory's marked paths; and the job's copy of the workspace's findings checklist block.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic.js';
import type { FileChange } from '../jobs.js';
import { SCOPE_PROBLEM, SENSITIVE_PROBLEM } from '../ledger.js';
import type { ReviewItem } from '../review.js';
import { TASK_DIR } from '../task-file.js';

// The paths of the factory's fix items (src/review.ts, unacceptedItems) by kind, each with its
// label: the undeclared sensitive paths, then the paths outside the Task's scope.
export function markedGroups(items: ReviewItem[]): Array<{ label: string; paths: string[] }> {
  return [
    { label: 'undeclared sensitive path(s)', problem: SENSITIVE_PROBLEM },
    { label: "path(s) outside the Task's scope", problem: SCOPE_PROBLEM },
  ].map(({ label, problem }) => ({ label, paths: items.filter((item) => item.problem === problem).map((item) => item.path) }))
    .filter((group) => group.paths.length > 0);
}

// The line of a Resume's prompt when the Task's images changed while the job was paused.
export function imagesChangedNote(names: readonly string[]): string {
  return `The Task's images changed while the job was paused: ${names.join(', ')}.`;
}

// How many kept files the first prompt names.
const MAX_KEPT_NAMED = 50;

// What the Implementer is told of a Task file that changed since it was last given it (on
// Resume, or the next Fix section or sf say after a review round resumed): its diff, or, when none
// could be made, to read it again.
export function changeNote(ticket: string, diff: string | undefined): string {
  const path = `${TASK_DIR}/${ticket}.md`;
  if (diff === undefined) {
    return `The Task file ${path} changed since you were last given it (while the job was paused); the copy in your worktree is the new version. Read it again and act on what changed.`;
  }
  return [`The Task file ${path} changed since you were last given it (while the job was paused); the copy in your worktree is the new version. Act on the change:`, '', '````diff', diff, '````'].join('\n');
}

// The Implementer's command (fix: of a Fix section): /implement of the Task file when its skills (the
// job's Implementer's, src/skill-roles.ts) hold implement; else the Task file's path alone.
export function implementCommand(ticket: string, skills: readonly string[], fix?: number): string {
  return `${skills.includes('implement') ? '/implement ' : ''}${TASK_DIR}/${ticket}.md${fix === undefined ? '' : ` Fix ${fix}`}`;
}

// The first line of the <recurring_findings> block.
export const FINDINGS_INSTRUCTION = 'Before you write the Report, go through these checks, fix what applies to this change, and say in `## Checks` which applied.';

// The <recurring_findings> block of a workspace's findings checklist (src/findings-checklist.ts):
// the instruction line, then the file's checks (its "- " lines; the generated comment left out);
// '' when the file holds no check. The Implementer alone is given it, in every prompt that opens a
// session, after the <rules> block (or in its place); src/job-stream.ts cuts it.
export function findingsBlock(checklist: string): string {
  const checks = checklist.split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line.startsWith('- ') && line.length > 2);
  return checks.length === 0 ? '' : ['<recurring_findings>', FINDINGS_INSTRUCTION, ...checks, '</recurring_findings>', ''].join('\n');
}

// The job's copy of its block, in its directory.
const FINDINGS_COPY = 'findings.md';

// Writes the job's findings.md, once at Start (src/execution/start.ts) when the block is not ''.
export async function writeJobFindings(jobDir: string, block: string): Promise<void> {
  await writeFileAtomic(join(jobDir, FINDINGS_COPY), Buffer.from(block, 'utf8'));
}

// The job's <recurring_findings> block; '' in a job directory without findings.md. The checklist
// only helps, so a findings.md that cannot be read gives '' too and never stops a turn.
export async function readJobFindings(jobDir: string): Promise<string> {
  return readFile(join(jobDir, FINDINGS_COPY), 'utf8').catch(() => '');
}

// The job's blocks of a prompt that opens a session, each without its trailing newline: its <rules>
// block, then its <recurring_findings> block; either one '' is left out.
export function sessionBlocks(rules: string, findings: string): string[] {
  return [rules, findings].filter((block) => block !== '').map((block) => block.trimEnd());
}

// The line of a changed file in a fresh fix round's <changed_files>: added A, modified M, deleted D,
// renamed "R <from> -> <path>".
export function changedFileLine(change: Pick<FileChange, 'path' | 'status' | 'from'>): string {
  switch (change.status) {
    case 'added':
      return `A ${change.path}`;
    case 'modified':
      return `M ${change.path}`;
    case 'deleted':
      return `D ${change.path}`;
    case 'renamed':
      return `R ${change.from ?? change.path} -> ${change.path}`;
  }
}

// What a fresh fix round's session is given of the previous iteration: its number, its Report and
// its file list (meta.json's files).
export interface FixPack {
  iteration: number;
  report: string;
  files: Array<Pick<FileChange, 'path' | 'status' | 'from'>>;
}

// The prompt of a fix round that starts a new Implementer session (fix_session fresh), before
// factoryPrompt: the fix command (implementCommand … Fix N) first, then the job's <rules> and
// <recurring_findings> blocks when it has them, as in a first prompt; then <previous_report> with the
// previous iteration's Report, then <changed_files> with its files against the base commit, one
// "<status> <path>" line each and how to read them. No diff text. base: the job's base commit, null
// when it has none.
export function freshFixPrompt(command: string, rules: string, pack: FixPack, base: string | null, findings = ''): string {
  const commit = base ?? 'the commit your branch started from';
  return [
    command,
    ...sessionBlocks(rules, findings).flatMap((block) => ['', block]),
    '',
    `<previous_report iteration="${pack.iteration}">`,
    pack.report.trimEnd() || '(The previous iteration has no Report.)',
    '</previous_report>',
    '',
    '<changed_files>',
    `This fix round starts a new session. The files your change holds against the base commit ${commit}, as of iteration ${pack.iteration}: for A read the file; for M and D read \`git diff ${commit} -- <path>\`; for R read \`git diff ${commit} -- <from> <path>\`; all in the worktree.`,
    ...(pack.files.length > 0 ? pack.files.map(changedFileLine) : ['(none)']),
    '</changed_files>',
  ].join('\n');
}

// The first prompt of a job: its command (implementCommand), then the job's <rules> and
// <recurring_findings> blocks when it has them; after sf restart --keep-files, with the files kept
// from the previous job.
export function firstPrompt(ticket: string, kept: string[], rules = '', skills: readonly string[] = ['implement'], findings = ''): string {
  const command = [implementCommand(ticket, skills), ...sessionBlocks(rules, findings).flatMap((block) => ['', block])].join('\n');
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
