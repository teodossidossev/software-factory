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
- Answer each Fix item: fixed; contested only with evidence a reviewer can check without you (a path:line in the worktree, a test name, a §section of the Task file, or the user's own message to this job quoted as: user message "<its exact words, at least 8 characters>"), else it reads as open; escalated only when it turns on something only the user knows, outside the repository and the Task file (the note is the question); left for nits only. An item that conflicts with the Task file only because the user's message asked for what you did is contested with that message, never escalated.`;

// The line of factoryPrompt that names the Task's images; the job stream recognises it.
export function imagesLine(dir: string, names: readonly string[]): string {
  return `The Task's images are in ${dir}: ${names.join(', ')}. Read them when you need them.`;
}

// first: the command or the user's message; iteration: the number of the iteration to be published.
// images: the job's images, dir the absolute path of their folder in the worktree; with
// any, one line names them before the rules.
export function factoryPrompt(first: string, ticket: string, iteration: number, images?: { dir: string; names: string[] }): string {
  const line = images !== undefined && images.names.length > 0 ? `${imagesLine(images.dir, images.names)}\n\n` : '';
  return `${first}\n\n${line}${FACTORY_PROMPT_RULES.replaceAll('<ticket>', ticket).replace('<N>', String(iteration))}`;
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

// The prompt of the morning digest: the rules, today's date and the Git data of every
// workspace as JSON (src/digest-run.ts builds it, capped at 150,000 characters). The model has no
// tools but the structured output.
export function digestPrompt(today: string, language: string, data: unknown): string {
  return [
    'You write the user\'s morning digest of their repositories and a draft of their stand-up ("my daily"), from the Git data below only. You have no tools besides the structured output.',
    '',
    'Rules:',
    `- Facts only from the data. Mark a guess with the word for "likely" in ${language}. Problems and plans are suggestions, never facts.`,
    `- Short, plain sentences in ${language}, one fact per sentence. Ticket keys and people's names stay as they are. Unless ${language} is English, no English word in any script (a transliteration counts as English), except ticket keys, people's names and product names.`,
    '- In headline, problem, what, impact_on_me, by_workspace and for_me: no commit SHAs, no branch names, no counts of commits ahead or behind, and a file path only when the reader must open that file; the page shows the SHAs and branch names beside them. Name a piece of work by its ticket key and a topic of two to five words. Say what changed for the product\'s users or for the team, and what I have to do, in plain words.',
    '- When a workspace\'s description and its Git data disagree, the data wins.',
    '- "I", "me" and "mine" are the user: the entries with mine: true.',
    '- repos: one per workspace with followed: true, in the order of the data, with its name. headline: one or two plain sentences: what happened and where the work is heading. merged: one per landed entry, sha: its sha exactly as given, problem: the problem it solves, in one plain sentence. branches: one per live branch that has not landed, ref: its name exactly as given, what: what is going on there, in one plain sentence. impact_on_me: per affected ticket of mine, what I have to do and why, e.g. "ABC-124 (the read-only superclasses) needs the latest changes; the translations changed on both sides, so expect a conflict there" (from overlap and hit_by: the same files changed by what landed; from behind: my work needs the latest changes; the same ticket in another workspace of the same app). One item per ticket, never one per file or commit. A branch of mine that likely landed already is one item: "likely done; the branch can go". [] when there are none.',
    '- cross_repo: only between workspaces of the same app (see apps), at most 6, the most relevant for me first. ticket: one ticket key, or two keys of one feature joined by " + ". by_workspace: one short sentence per workspace of the app, keyed by its name. for_me: what it means for me, "" when nothing. [] when no ticket spans two workspaces of one app.',
    '- dailies: one per entry of daily (an app where I have commits or open branches), with its app and workspaces as given. A daily is what I say at the team\'s stand-up, to colleagues and a product owner who do not read Git.',
    '- In a daily, name a piece of work by its ticket key and a topic of two to five words taken from its commits, e.g. "ABC-123 (the property counts in the class view)"; work without a ticket key by its topic only. One item per ticket, never one per commit.',
    '- A daily never holds commit SHAs, branch names, file paths, counts of commits ahead or behind, or the words commit, push, rebase, merge, branch, master or main in any spelling. Say what changed for the product\'s users or for the team instead.',
    '- yesterday: what I did yesterday (the commits dated in daily_days.yesterday), in product words, one item per ticket. problems: only what the team should hear (a change waiting for a review, a conflict with a colleague\'s work on the same screen or feature, unfinished work that blocks another ticket); keeping a branch up to date, duplicate or unpushed commits are never a problem here; [] when there is none. plan: one step per problem, in the same plain words; [] when problems is []. next: what I continue with today, by ticket and topic.',
    '',
    `Today: ${today}.`,
    '',
    '<git_data>',
    JSON.stringify(data),
    '</git_data>',
  ].join('\n');
}

// The prompt of a stop's plain explanation: the rules, then the stop's data as JSON
// (src/explain.ts builds and caps it): the Task's title and goal, the stop's code and message, the
// ledger entries of the stop, the last Report's Done and Open questions, the user's own messages and
// the stop's real answers. The model has no tools but the structured output; it explains and
// recommends, it never decides or acts.
export function explainPrompt(language: string, data: unknown): string {
  return [
    'A job of the Software Factory stopped and waits for the user. Explain to the user, in plain words, what is needed from them, from the data below only. You have no tools besides the structured output. You explain and recommend; you never decide or act.',
    '',
    'Rules:',
    `- Write every text in ${language}: short sentences, plain words, for a reader who did not follow the job and may not be a developer.`,
    '- No ledger ids (R5), acceptance-criterion numbers (AC3), function or variable names, unless the user must type one. Name a file only when the user needs it to find the thing.',
    '- Facts only from the data. Mark a guess with "likely".',
    '- The data: task (the Task file\'s title and goal), stop (the code and the factory\'s message), entries (the findings the stop is about: each with its problem, what was expected, the Implementer\'s response and any dispute), report (the Implementer\'s last Report: what it did and its open questions), your_messages (what the user told the job lately), answers (the only answers the user has: each a button label and its sf command).',
    '- headline: one sentence, at most 140 characters: what is needed from the user.',
    '- explanation: at most 120 words, short sentences: what the user would see in the product (a concrete example), what was planned, what happened, and why the job cannot decide alone.',
    '- choices: 1 to 4 items: choice, what the user can do in plain words; effect, what then happens; recommended, true for exactly one choice and false for the others. Each choice is made with the answers given: name a button by its label, or the command when the user must type it. Never invent a button, a command or an action that the answers do not contain.',
    '- recommendation: one sentence: which choice and why. When the case is rare or narrow, recommend the simplest choice.',
    '',
    '<stop_data>',
    JSON.stringify(data),
    '</stop_data>',
  ].join('\n');
}
