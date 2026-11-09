// The simplification pass: reviewers add, nobody removes. Once per job, after the deciding
// clean verdict of a job that had review fixes, a fresh read-only Agent SDK query() (the review's
// tools, isolation and sandbox, src/review.ts) reads the Task file without its Fix sections, the
// final Patch, the findings ledger and the files each Fix section's iteration changed, and names
// what in the change exists only to satisfy a review item and is not needed for the Task. Never
// what a fixed blocker entry needed: the prompt says so, and the factory drops a suggestion that
// names one (guardSuggestions). Knows nothing about job states; the Execution applies the outcome.
import * as z from 'zod/v4';
import { LEDGER_ID, type LedgerEntry, nextNumber, SIMPLIFIER, stopMessage } from './ledger.js';
import { fileSections } from './patch.js';
import { cutBuffer, MAX_REVIEW_PATCH_BYTES, oneLine, type ReviewOptions, runStructuredSession, type StructuredOutcome } from './review.js';
import { TASK_DIR } from './task-file.js';

// The stop that offers the suggestions to the user.
export const SIMPLIFY_CODE = 'simplify_offered';
// The title of the Fix section the user's Simplify writes (## Fix N: Simplify).
export const SIMPLIFY_TITLE = 'Simplify';
// The response and the settlement note of a suggestion the user chose to apply (its ledger entry).
export const SIMPLIFY_NOTE = "removed by the user's choice";

const suggestion = z.strictObject({
  path: z.string().describe('The file the suggestion is about.'),
  what: z.string().describe('What to remove or make simpler.'),
  why: z.string().describe("Why the Task's goal, its acceptance and every blocker or major ledger entry still valid do not need it."),
  saves_lines: z.number().int().min(0).describe('About how many lines it removes.'),
  ledger_ids: z.array(z.string().regex(LEDGER_ID)).describe('The ledger ids of the review items whose fixes added it.'),
});
export const simplifyOutput = z.strictObject({
  summary: z.string().describe('What the review fixes added, and what of it the Task does not need.'),
  suggestions: z.array(suggestion).describe('Empty when everything the fixes added is needed.'),
});
export type Suggestion = z.output<typeof suggestion>;
export type SimplifyOutput = z.output<typeof simplifyOutput>;
// The schema sent as outputFormat: draft-07 without $schema, as the review's.
const { $schema: _draft, ...simplifySchema } = z.toJSONSchema(simplifyOutput, { target: 'draft-7' });
export const SIMPLIFY_SCHEMA: Record<string, unknown> = simplifySchema;

// A Fix section of the job and the files its iteration changed (undefined when that is not known:
// the iteration that answered it, or the one before, is missing).
export interface FixFiles {
  fix: number;
  files: string[] | undefined;
}

export interface SimplifyInput {
  ticket: string;
  iteration: number;
  // The Task file as in the worktree; its Fix sections are cut (withoutFixSections).
  task: string;
  patch: Buffer;
  patchTruncated: boolean;
  ledger: LedgerEntry[];
  fixes: FixFiles[];
}

const FIX_HEADING = /^## Fix (\d+)\b/u;

// The Task file up to its first `## Fix N` heading outside a code fence: the factory appends every
// Fix section at the end (src/task-file.ts, appendFix).
export function withoutFixSections(task: string): string {
  const lines = task.split('\n');
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('```')) {
      fenced = !fenced;
    } else if (!fenced && FIX_HEADING.test(line)) {
      return `${lines.slice(0, index).join('\n').trimEnd()}\n`;
    }
  }
  return task;
}

// The numbers of the Task file's Fix sections, in order.
export function fixNumbers(task: string): number[] {
  let fenced = false;
  const numbers: number[] = [];
  for (const line of task.split('\n')) {
    if (line.startsWith('```')) {
      fenced = !fenced;
    } else if (!fenced) {
      const match = FIX_HEADING.exec(line);
      if (match !== null) {
        numbers.push(Number(match[1]));
      }
    }
  }
  return numbers;
}

// The files whose diff differs between two Patches against the same base: what the later
// iteration changed.
export function changedBetween(before: string, after: string): string[] {
  const old = fileSections(before);
  const next = fileSections(after);
  return [...new Set([...old.keys(), ...next.keys()])].filter((path) => old.get(path) !== next.get(path)).sort();
}

// The entries a suggestion may never undo: the fixed blockers.
const isFixedBlocker = (entry: LedgerEntry): boolean => entry.status === 'fixed' && entry.severity === 'blocker';

// A path as the factory compares it: on one line, without a leading "./" or "/" and trailing "/".
const pathKey = (path: string): string => oneLine(path).replace(/^(?:\.\/|\/)+/u, '').replace(/\/+$/u, '');

// The paths of the fixed blocker entries: a suggestion on one is withheld, whatever ids it names.
export function protectedPaths(ledger: LedgerEntry[]): string[] {
  return [...new Set(ledger.filter(isFixedBlocker).map((entry) => pathKey(entry.path)).filter((path) => path !== ''))].sort();
}

// One ledger entry on one line, for the prompt: every entry, with its status and how it was settled.
function entryLine(entry: LedgerEntry): string {
  const parts = [`- ${entry.id} · ${entry.status} · ${entry.severity} · ${entry.reviewer} · \`${oneLine(entry.path)}\`: ${oneLine(entry.problem)} Expected: ${oneLine(entry.expected)}`];
  if (oneLine(entry.response) !== '') {
    parts.push(`Response: ${oneLine(entry.response)}`);
  }
  if (entry.evidence !== '') {
    parts.push(`Evidence: ${entry.evidence}`);
  }
  if (entry.settled !== null) {
    parts.push(`The user decided: ${entry.settled.decision === 'accept' ? 'accept the risk' : 'fix'}${oneLine(entry.settled.note) !== '' ? ` (${oneLine(entry.settled.note)})` : ''}`);
  }
  return parts.join(' ');
}

// The prompt of the pass: the question, the rules (above all: never undo a fixed blocker), then the
// Task file without its Fix sections, the ledger, the files of each Fix section and the final Patch.
export function simplifyPrompt(input: SimplifyInput): string {
  const { ticket } = input;
  const protectedIds = input.ledger.filter(isFixedBlocker).map((entry) => entry.id);
  const paths = protectedPaths(input.ledger);
  const cut = input.patch.length > MAX_REVIEW_PATCH_BYTES;
  const notes: string[] = [];
  if (cut) {
    notes.push(`The Patch has ${input.patch.length} bytes; only the first ${MAX_REVIEW_PATCH_BYTES} are below. Read the changed files in the worktree for the rest.`);
  }
  if (input.patchTruncated) {
    notes.push('The published Patch was cut at its size limit. Read the changed files in the worktree for the rest.');
  }
  return [
    `Simplification pass of ticket ${ticket}, after its review fixes; the change of iteration ${input.iteration} was reviewed clean. You read; you change nothing.`,
    "The current directory is the job's worktree: it holds the final change, not committed. Your tools are Read, Grep and Glob; nothing else is available.",
    '',
    'Reviewers add; nobody removes. Each review round asked for something, and the Implementer added it. The question: what in the final change exists only to satisfy a review item and is not needed for the Task\'s goal, its acceptance, or a blocker or major ledger entry that is still valid? What can be removed or made simpler without changing that?',
    '',
    '- Read the files each Fix section\'s iteration changed (<fix_sections>) first: that is where the fixes went.',
    `- Never propose removing or weakening anything a \`fixed\` blocker entry of the ledger needed, security above all${protectedIds.length > 0 ? ` (here: ${protectedIds.join(', ')})` : ''}. When in doubt, leave it.`,
    ...(paths.length > 0 ? [`- Suggest nothing in a file a fixed blocker entry is about (${paths.join(', ')}): the factory withholds any suggestion on such a path, and any that names a fixed blocker id.`] : []),
    '- Keep what the Task\'s goal, its `## Acceptance` and any blocker or major entry still valid need: a guard against a real risk of this change stays, a guard against a risk the change does not have may go.',
    '- Suggest removals and simplifications only: defensive code for cases that cannot happen here, duplicate checks, tests of the same thing many times over, options nothing uses, abstractions with one use. No new features, no style or naming changes, no rewrites of code the fixes did not add.',
    '- Each suggestion: the path, what to remove or simplify, why it is not needed, about how many lines it saves, and the ledger ids of the items whose fixes added it.',
    '- Return no suggestion when everything the fixes added is needed; that is a good answer.',
    '',
    `<task_file path="${TASK_DIR}/${ticket}.md" fix_sections="cut">`,
    withoutFixSections(input.task).trimEnd(),
    '</task_file>',
    '',
    '<ledger>',
    ...(input.ledger.length > 0 ? input.ledger.map(entryLine) : ['None.']),
    '</ledger>',
    '',
    '<fix_sections>',
    ...(input.fixes.length > 0
      ? input.fixes.map(({ fix, files }) => `- Fix ${fix}, answered by iteration ${fix + 1}: ${files === undefined ? 'not known' : files.length === 0 ? 'no file changed' : files.join(', ')}`)
      : ['None.']),
    '</fix_sections>',
    '',
    ...notes.map((note) => `Note: ${note}`),
    '<patch>',
    (cut ? cutBuffer(input.patch, MAX_REVIEW_PATCH_BYTES) : input.patch.toString('utf8')).trimEnd(),
    '</patch>',
  ].join('\n');
}

// The suggestions the factory offers, and those it drops: one that names a fixed blocker entry, or
// is on the path of one, could undo what that fix established. The path check does not trust the
// pass's ledger_ids: an empty list on a blocker's file is withheld as well.
export function guardSuggestions(suggestions: Suggestion[], ledger: LedgerEntry[]): { kept: Suggestion[]; dropped: Suggestion[] } {
  const blockers = new Set(ledger.filter(isFixedBlocker).map((entry) => entry.id));
  const paths = new Set(protectedPaths(ledger));
  const dropped = suggestions.filter((candidate) => candidate.ledger_ids.some((id) => blockers.has(id)) || paths.has(pathKey(candidate.path)));
  return { kept: suggestions.filter((candidate) => !dropped.includes(candidate)), dropped };
}

// Runs the pass; never throws (runStructuredSession). options.deny and options.filesystem carry the
// session's path denials, as for the review.
export function runSimplify(prompt: string, options: ReviewOptions): Promise<StructuredOutcome<SimplifyOutput>> {
  return runStructuredSession(prompt, options, { schema: SIMPLIFY_SCHEMA, output: simplifyOutput, noun: 'simplification pass', outputNoun: 'answer' });
}

// One suggestion on one line.
export function suggestionLine(item: Suggestion): string {
  const ids = item.ledger_ids.length > 0 ? `; added for ${item.ledger_ids.join(', ')}` : '';
  return `\`${oneLine(item.path)}\`: ${oneLine(item.what)} Why: ${oneLine(item.why)} (saves about ${item.saves_lines} lines${ids})`;
}

// The message of the simplify_offered stop: the suggestions and the two choices.
export function offerMessage(suggestions: Suggestion[]): string {
  const saves = suggestions.reduce((total, item) => total + item.saves_lines, 0);
  return stopMessage(
    `The simplification pass found ${suggestions.length} thing${suggestions.length === 1 ? '' : 's'} the review fixes added that the Task does not need (about ${saves} lines):`,
    suggestions.map((item, index) => `${index + 1}. ${suggestionLine(item)}`),
    'Simplify (sf simplify <workspace> <ticket>: one Fix section, reviewed as usual) or skip (sf accept <workspace> <ticket>: prepare the MR, the suggestions listed in it)?',
    'suggestions',
    'simplify.json',
  );
}

// The user chose Simplify: one ledger entry per suggestion (reviewer simplify, accepted_risk with
// SIMPLIFY_NOTE: a reviewer item that reopens one is dropped), asked in Fix fix, and
// the body of that Fix section.
export function simplifyFix(ledger: LedgerEntry[], summary: string, suggestions: Suggestion[], fix: number, at: string): { ledger: LedgerEntry[]; content: string } {
  let number = nextNumber(ledger);
  const entries: LedgerEntry[] = suggestions.map((item) => {
    const id = `R${number}`;
    number += 1;
    return {
      id, iteration: fix, reviewer: SIMPLIFIER, severity: 'nit', path: item.path, problem: item.what, expected: item.why,
      status: 'accepted_risk', response: SIMPLIFY_NOTE, evidence: '', reopened: 0, asked: fix, caused_by: '', dispute: null,
      settled: { decision: 'accept', note: SIMPLIFY_NOTE, at },
    };
  });
  const content = [
    `Simplify, by the user's choice: ${oneLine(summary) || 'see the items.'}`,
    '',
    'Remove or simplify each item below. Keep what the Task\'s goal and acceptance need, and never undo what a fixed blocker finding of the ledger established; leave an item (and say why) when it turns out to be needed.',
    '',
    ...entries.map((entry, index) => `${index + 1}. [${entry.id}, simplify] ${suggestionLine(suggestions[index]!)}`),
  ].join('\n');
  return { ledger: [...ledger, ...entries], content };
}
