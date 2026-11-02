// The fixed block the factory appends to every prompt it sends to the Implementer: the factory's
// rules and the Report template, which the Implementer cannot read anywhere else; and the prompt
// of the MR preparation turn.
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
  ## Fix N items (only when answering a Fix section: a table of each item, fixed or rejected, with a note)`;

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

// The prompt of the MR preparation turn. FACTORY_PROMPT_RULES is not sent here: its first rule
// forbids what this turn must do; the Task-file rule and the Report form are restated instead.
export function mrPrompt(input: MrPromptInput): string {
  const { ticket, branch, targetRef, targetCommit } = input;
  const lines = [
    `MR preparation for ${ticket} on branch ${branch}. The user approved the reviewed change.`,
    `Target: ${targetRef} at ${targetCommit}.`,
    '',
  ];
  if (input.previousError !== undefined) {
    lines.push(`This is attempt ${input.attempt}. The previous attempt failed the factory's checks: ${input.previousError}`, '');
  }
  lines.push(
    'Do this, in order:',
    '1. Stage the files of the reviewed change by path (`git add <path>...`); never `git add -A`, `git add .` or `git add -u`. Inside the sandbox `git status` shows placeholder files such as .bashrc, .gitconfig, .idea and .mcp.json as untracked; they are not part of the change. .software-factory/ stays uncommitted.',
    `2. Commit by the Git rules below, as one commit on this branch. When the branch already has a commit on top of ${targetRef} (a second approve after a review), amend that commit (\`git commit --amend\`) instead of adding a second one.`,
    `3. Run \`git rebase ${targetRef}\`.`,
    '4. Resolve conflicts, if any, keeping the reviewed behaviour.',
    "5. Run the repository's checks after the rebase.",
    `6. Write the MR text to ${TASK_DIR}/${ticket}.mr.md: the first line is the title, exactly the commit subject, then a blank line, then the body by the MR template below.`,
    '7. Do not push, fetch, merge, reset or switch branches; the factory verifies and pushes. For the current branch use `git rev-parse --abbrev-ref HEAD`; `git branch` is denied.',
    `Do not edit ${TASK_DIR}/${ticket}.md; the Context owner owns it.`,
    'End your turn with a short report in this form, as your last message:',
    `  # Report: ${ticket}, MR preparation ${input.attempt}`,
    '  ## Done        (what was committed and rebased; which files changed during conflict resolution, or "none")',
    '  ## Checks      (each command run with its result; "not run" and why, when not run)',
    '  ## Open questions   ("None." when there are none)',
    '',
    handbookSection(input.handbook, '## Git rules'),
    '',
    handbookSection(input.handbook, '## MR template'),
  );
  return lines.join('\n');
}
