// The fixed block the factory appends to every prompt it sends to the Implementer: the factory's
// rules and the Report template, which the Implementer cannot read anywhere else; and the prompts
// of the MR text turn and the conflict turn at Clean.
import { MR_TESTING_RULE } from './rules.js';
import { TASK_DIR } from './task-file.js';

export const FACTORY_PROMPT_RULES = `Rules from the Software Factory:
- Do not commit, stage, stash, push or switch branches; the factory handles Git after review.
- Do not edit .software-factory/<ticket>.md; the Context owner owns it.
- While working, run the tests of the files you change; run the repository's full test suite once, before the report.
- End your turn with a report in this form, as your last message:
  # Report: <ticket>, iteration <N>
  ## Done        (what was built or changed, by responsibility)
  ## Checks      (each command run with its result; "not run" and why, when not run)
  ## Open questions   ("None." when there are none)
  ## Fix N items (only when answering a Fix section: one row per item, by its id: | R7 | fixed / contested / escalated / left | <evidence or note> |)
- Answer each Fix item: fixed; contested only with evidence a reviewer can check without you (a path:line in the worktree, a test name, or a §section of the Task file), else it reads as open; escalated only when it turns on something only the user knows, outside the repository and the Task file (the note is the question); left for nits only.`;

// first: the command or the user's message; iteration: the number of the iteration to be published.
export function factoryPrompt(first: string, ticket: string, iteration: number): string {
  return `${first}\n\n${FACTORY_PROMPT_RULES.replaceAll('<ticket>', ticket).replace('<N>', String(iteration))}`;
}

// This iteration's cost from the SDK's cumulative session total; a total below the previous one
// means a new session started, so the total is this iteration's cost.
export function iterationCost(total: number | null, previousTotal: number | null): number | null {
  if (total === null || previousTotal === null || total < previousTotal) {
    return total;
  }
  return Math.round((total - previousTotal) * 1e6) / 1e6;
}

// One level-2 section of the Handbook, from its heading up to the next level-2 heading outside a
// fenced code block (the MR template's fence contains "## " lines of its own).
export function handbookSection(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start < 0) {
    throw new Error(`The handbook has no "${heading}" section.`);
  }
  let fenced = false;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('```')) {
      fenced = !fenced;
    } else if (!fenced && line.startsWith('## ')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

export interface MrPromptInput {
  ticket: string;
  branch: string;
  targetRef: string;
  targetCommit: string;
  attempt: number;
  // The error message of the previous attempt, on a retry.
  previousError?: string | undefined;
  // The loaded Handbook text; its Git rules and MR template are sent verbatim.
  handbook: string;
}

// The prompt of the MR text turn at Clean. FACTORY_PROMPT_RULES is not sent here: this turn writes
// the MR text only; the Task-file rule and the Report form are restated instead.
export function mrPrompt(input: MrPromptInput): string {
  const { ticket, branch, targetRef, targetCommit } = input;
  const path = `${TASK_DIR}/${ticket}.mr.md`;
  const lines = [
    `MR preparation for ${ticket} on branch ${branch}. The user approved the reviewed change.`,
    `Target: ${targetRef} at ${targetCommit}.`,
    '',
  ];
  if (input.previousError !== undefined) {
    lines.push(`This is attempt ${input.attempt}. The previous attempt failed: ${input.previousError}`, '');
  }
  lines.push(
    `Your only task in this turn: write the MR text to ${path}. Its first line is the title, which is also the commit header by the Git rules below; then a blank line; then the body by the MR template below.`,
    `The factory commits, rebases and pushes, not you. It commits the reviewed change as one commit on this branch; the commit message is the whole MR text: the title as the header, then the body. Then it rebases that commit onto ${targetRef}.`,
    `${MR_TESTING_RULE}.`,
    'Change no other file and run no Git command that changes the repository; those commands are denied.',
    `Do not edit ${TASK_DIR}/${ticket}.md; the Context owner owns it.`,
    'End your turn with a short report in this form, as your last message:',
    `  # Report: ${ticket}, MR preparation ${input.attempt}`,
    '  ## Done        (the MR title)',
    '  ## Open questions   ("None." when there are none)',
    '',
    handbookSection(input.handbook, '## Git rules'),
    '',
    handbookSection(input.handbook, '## MR template'),
  );
  return lines.join('\n');
}

export interface ConflictPromptInput {
  ticket: string;
  targetRef: string;
  targetCommit: string;
  // The files the stopped rebase left unmerged.
  files: string[];
}

// The prompt of the conflict turn: the factory's rebase at Clean stopped and stays in progress;
// the Implementer only edits the listed files, the factory stages them and continues.
export function conflictPrompt(input: ConflictPromptInput): string {
  const { ticket, targetRef, targetCommit, files } = input;
  return [
    `The factory's rebase of ${ticket} onto ${targetRef} (${targetCommit}) stopped with conflicts in these files:`,
    ...files.map((file) => `- ${file}`),
    '',
    'Resolve the conflicts by editing these files. Keep the reviewed behaviour and the changes of the target. Leave no conflict markers: no line starting with `<<<<<<< `, `=======` or `>>>>>>> `.',
    'Run the checks of these files.',
    'Edit other files only as far as the merge needs them to build and pass. Run no Git command; the factory stages every change and continues the rebase. A file left with a marker aborts the rebase.',
    `Do not edit ${TASK_DIR}/${ticket}.md; the Context owner owns it.`,
    'End your turn with a report in this form, as your last message:',
    `  # Report: ${ticket}, conflict resolution`,
    '  ## Done        (per file: how the conflict was resolved)',
    '  ## Checks      (each command run with its result; "not run" and why, when not run)',
    '  ## Open questions   ("None." when there are none)',
  ].join('\n');
}
