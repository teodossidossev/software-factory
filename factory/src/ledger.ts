// The findings ledger: jobs/<ws>/<ticket>/ledger.json, one entry per review item that went
// into a Fix section, with how it was settled. The Implementer answers each item in the Report's
// Fix table (fixed, contested with evidence, escalated to the user, left as a nit); the reviewers
// see every settled entry and may reopen one only with a reason; the user settles what is escalated
// or disputed. This module is pure: the Execution reads and writes the file (src/jobs.ts) under the
// job lock and applies the outcomes to the job.
import * as z from 'zod/v4';
import type { ReviewItem, Severity } from './review.js';

export const LEDGER_STATUSES = ['open', 'fixed', 'contested', 'escalated', 'left', 'accepted_risk', 'user_fix'] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];
// The answers of the Implementer in the Report's Fix table.
export const ANSWERS = ['fixed', 'contested', 'escalated', 'left'] as const;
export type Answer = (typeof ANSWERS)[number];
// The user's decisions (sf settle).
export const DECISIONS = ['accept', 'fix'] as const;
export type Decision = (typeof DECISIONS)[number];
// The ledger id of an entry: R1, R2, … per job, in Fix order.
export const LEDGER_ID = /^R[1-9]\d{0,5}$/;
// A reference to an entry in a review item (reopens, caused_by): a ledger id, or "" for none.
export const LEDGER_REF = /^(?:R[1-9]\d{0,5})?$/;
// Which stops the user settles in, and whose settlement moves the job on, is src/stops.ts's table
// (settleCodes). It is not imported here: src/stops.ts reads src/review.ts, which reads this module.
// The codes of a stop the ledger made.
export type LedgerStop = 'review_disputed' | 'review_churn';

const entrySchema = z.strictObject({
  id: z.string().regex(LEDGER_ID),
  // The iteration whose review raised the item.
  iteration: z.number().int().min(0),
  // claude, codex, or user for a fix the user decided.
  reviewer: z.string().min(1),
  severity: z.enum(['blocker', 'major', 'nit']),
  path: z.string(),
  problem: z.string(),
  expected: z.string(),
  status: z.enum(LEDGER_STATUSES),
  // The Implementer's note (or question, for escalated), or the user's note once settled.
  response: z.string(),
  // What a reviewer can check of a contest: path:line, test names, §sections; "" otherwise.
  evidence: z.string(),
  // How often a reviewer reopened the entry after it was fixed or left.
  reopened: z.number().int().min(0),
  // The Fix section that listed the entry last.
  asked: z.number().int().min(0),
  // The ledger id of the fix whose change caused the item, as the reviewer gave it; "" otherwise.
  caused_by: z.string(),
  // A reviewer reopened the contested entry (review_disputed): its reason, until the user settles it.
  dispute: z.strictObject({ reviewer: z.string(), iteration: z.number().int().min(0), reason: z.string() }).nullable(),
  // The user's settlement (sf settle); null before.
  settled: z.strictObject({ decision: z.enum(DECISIONS), note: z.string(), at: z.iso.datetime() }).nullable(),
  // The iteration whose clean deciding verdict settled the open entry as fixed; absent otherwise.
  fixed_by_clean: z.number().int().min(0).optional(),
});
export const ledgerSchema = z.array(entrySchema);
export type LedgerEntry = z.output<typeof entrySchema>;

// An item of a Fix section: its ledger id, the item, the user's note for a fix the user decided,
// and in a joint round's Fix who raised it (src/round.ts: "Claude", "Codex", "Claude and Codex").
export interface FixItem {
  id: string;
  item: ReviewItem;
  userNote?: string;
  by?: string;
}

// The problem of the factory's item for an undeclared sensitive path a reviewer did not accept
// (src/review.ts, sensitiveItem), and of its item for a path outside the Task's scope
// (scopeItem). Such an entry is settled by the reviewers' acceptance of the path, not by the
// Report: the factory raises it again each round while it stands.
export const SENSITIVE_PROBLEM = 'Undeclared sensitive path.';
export const SCOPE_PROBLEM = "Outside the Task's scope.";
export const FACTORY_PROBLEMS: readonly string[] = [SENSITIVE_PROBLEM, SCOPE_PROBLEM];
const isFactory = (entry: { problem: string }): boolean => FACTORY_PROBLEMS.includes(entry.problem);
// The key of a factory item or entry: its path and problem.
export const factoryKey = (entry: { path: string; problem: string }): string => `${entry.problem}\n${entry.path}`;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const blocks = (entry: { severity: Severity }): boolean => entry.severity !== 'nit';
export const SEVERITY_RANK: Record<Severity, number> = { nit: 0, major: 1, blocker: 2 };

// An entry as a review item: its path, problem, expected and severity.
export function entryItem(entry: LedgerEntry): ReviewItem {
  return { path: entry.path, problem: entry.problem, expected: entry.expected, severity: entry.severity };
}

// One Fix item on one line: `[R7, major] \`path\`: problem Expected: expected`, for a fix the
// user decided "The user decided: fix." with the note, and in a joint round "(raised by <by>)".
export function fixItemLine({ id, item, userNote, by }: FixItem): string {
  const user = userNote === undefined ? '' : ` The user decided: fix.${oneLine(userNote) !== '' ? ` ${oneLine(userNote)}` : ''}`;
  const raised = by === undefined ? '' : ` (raised by ${by})`;
  return `[${id}, ${item.severity}] \`${oneLine(item.path)}\`: ${oneLine(item.problem)} Expected: ${oneLine(item.expected)}${user}${raised}`;
}

// The number of the next id: one above the highest in the ledger.
export function nextNumber(ledger: LedgerEntry[]): number {
  return ledger.reduce((max, entry) => Math.max(max, Number(entry.id.slice(1))), 0) + 1;
}

// What the factory can check of a contest's evidence: the lines of a file in the worktree
// (undefined when it is not one), and the headings of the Task file.
export interface EvidenceContext {
  lines(path: string): Promise<number | undefined>;
  // Whether a test file of the worktree holds the text (a test's name).
  testNamed(name: string): Promise<boolean>;
  sections: string[];
  // The texts of the user's own messages to the job; absent means none.
  userMessages?: readonly string[];
}

const PATH_LINE = /(?<![\w/.-])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.\w+):(\d+)(?:-\d+)?/gu;
const TEST_FILE = /(?<![\w/.-])((?:[\w@.-]+\/)*(?:[\w@.-]*[._-](?:test|spec)\.\w+|test_[\w.-]+\.\w+))(?![\w/:.-])/giu;
const TEST_NAME = /\btests?\b[^"'`\n]{0,40}["'`]([^"'`\n]{3,})["'`]/giu;
const SECTION = /§\s*([^|§\n]+)/gu;
// A quote of the user's own message to the job, in double quotes or backticks.
const USER_MESSAGE = /\buser(?:'s)? message\b[^"`\n]{0,40}["`]([^"`\n]{8,})["`]/giu;
// The longest quote of a user's message recorded as evidence, in characters.
const MAX_QUOTE_CHARS = 200;

const insideWorktree = (path: string): boolean => !path.startsWith('/') && !path.split('/').includes('..');

// The evidence in a contest's note a reviewer can check without the Implementer: a path:line of a
// file in the worktree (the line within it), a test file in the worktree or a quoted test name a
// test file of the worktree holds, a §section of the Task file, a quote of the user's own message
// to the job that message holds, case and spacing aside; joined with "; ", "" when there
// is none. A wish to contest is not evidence.
export async function findEvidence(note: string, context: EvidenceContext): Promise<string> {
  const found: string[] = [];
  for (const match of note.matchAll(PATH_LINE)) {
    const [token, path, line] = match;
    const count = insideWorktree(path!) ? await context.lines(path!) : undefined;
    if (count !== undefined && Number(line) >= 1 && Number(line) <= count) {
      found.push(token);
    }
  }
  for (const match of note.matchAll(TEST_FILE)) {
    const path = match[1]!;
    if (insideWorktree(path) && !found.some((token) => token.startsWith(`${path}:`)) && (await context.lines(path)) !== undefined) {
      found.push(path);
    }
  }
  for (const match of note.matchAll(TEST_NAME)) {
    const name = match[1]!.trim();
    if (await context.testNamed(name)) {
      found.push(`test "${name}"`);
    }
  }
  const headings = context.sections.map((heading) => oneLine(heading).toLowerCase()).filter((heading) => heading !== '');
  for (const match of note.matchAll(SECTION)) {
    const text = oneLine(match[1]!).toLowerCase();
    const heading = headings.find((candidate) => text.startsWith(candidate));
    if (heading !== undefined) {
      found.push(`§${heading}`);
    }
  }
  const messages = (context.userMessages ?? []).map((text) => oneLine(text).toLowerCase());
  for (const match of note.matchAll(USER_MESSAGE)) {
    const quote = oneLine(match[1]!);
    if (quote !== '' && messages.some((text) => text.includes(quote.toLowerCase()))) {
      found.push(`user message "${cutQuote(quote)}"`);
    }
  }
  return [...new Set(found)].join('; ');
}

// A quote cut to MAX_QUOTE_CHARS, the last one "…", without splitting a surrogate pair.
function cutQuote(quote: string): string {
  if (quote.length <= MAX_QUOTE_CHARS) {
    return quote;
  }
  let end = MAX_QUOTE_CHARS - 1;
  const code = quote.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return `${quote.slice(0, end)}…`;
}

// The headings of a Markdown text (the Task file), without their #s, outside code fences.
export function headings(text: string): string[] {
  let fenced = false;
  const result: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      fenced = !fenced;
    } else if (!fenced && /^#{1,6} /u.test(line)) {
      result.push(line.replace(/^#+\s+/u, '').trim());
    }
  }
  return result;
}

// One row of the Report's Fix table as the factory reads it.
export interface ReportRow {
  id: string;
  answer: Answer;
  note: string;
}

const cellWord = (cell: string): string => cell.toLowerCase().replace(/[^a-z_]/gu, '');

// The rows of the Report's Fix table: `| R7 | fixed / contested / escalated / left | note |`.
// Lenient: any table row whose first cell holding an id (R7, [R7], **R7**) is followed by a cell
// with an answer; "rejected" (the earlier template) reads as contested. The first row of an id
// counts; a row it cannot read is skipped.
export function reportRows(report: string): ReportRow[] {
  const rows = new Map<string, ReportRow>();
  for (const line of report.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      continue;
    }
    const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
    const idIndex = cells.findIndex((cell) => /^\W*R[1-9]\d*\W*$/u.test(cell));
    if (idIndex < 0) {
      continue;
    }
    const id = cells[idIndex]!.replace(/[^R\d]/gu, '');
    const answerIndex = cells.findIndex((cell, index) => index > idIndex && [...ANSWERS, 'rejected'].includes(cellWord(cell)));
    if (answerIndex < 0 || rows.has(id)) {
      continue;
    }
    const word = cellWord(cells[answerIndex]!);
    const answer: Answer = word === 'rejected' ? 'contested' : (word as Answer);
    rows.set(id, { id, answer, note: cells.slice(answerIndex + 1).join(' | ').trim() });
  }
  return [...rows.values()];
}

// The ledger after the Report of an iteration that answers Fix fix: each entry that section listed
// takes the Implementer's answer, read leniently; a row it cannot read leaves the entry open.
// contested needs evidence (findEvidence), escalated a question, left a nit; otherwise the entry
// is open. A fix the user decided (user_fix) is settled by fixed only. Returns the escalated
// entries as well.
export async function answerFix(ledger: LedgerEntry[], report: string, fix: number, context: EvidenceContext): Promise<{ ledger: LedgerEntry[]; escalated: LedgerEntry[] }> {
  const rows = new Map(reportRows(report).map((row) => [row.id, row]));
  const result: LedgerEntry[] = [];
  for (const entry of ledger) {
    const row = rows.get(entry.id);
    // A simplification the Implementer did not apply is no longer the user's removal: left,
    // with the Implementer's note, so the reviewers may judge it again.
    if (entry.asked === fix && isSimplification(entry) && entry.status === 'accepted_risk' && row !== undefined && row.answer !== 'fixed') {
      result.push({ ...entry, status: 'left', response: row.note, settled: null });
      continue;
    }
    if (entry.asked !== fix || !['open', 'user_fix'].includes(entry.status)) {
      result.push(entry);
      continue;
    }
    const open = { ...entry, status: 'open' as const, response: row?.note ?? '', evidence: '' };
    if (row === undefined) {
      result.push(open);
    } else if (row.answer === 'fixed') {
      result.push({ ...open, status: 'fixed' });
    } else if (entry.status === 'user_fix') {
      result.push(open);
    } else if (row.answer === 'contested') {
      const evidence = await findEvidence(row.note, context);
      result.push(evidence === '' ? open : { ...open, status: 'contested', evidence });
    } else if (row.answer === 'escalated') {
      result.push(row.note === '' ? open : { ...open, status: 'escalated' });
    } else {
      result.push(blocks(entry) ? open : { ...open, status: 'left' });
    }
  }
  return { ledger: result, escalated: result.filter((entry) => entry.status === 'escalated' && entry.asked === fix) };
}

// How a verdict reads against the ledger.
export type Applied = { ledger: LedgerEntry[]; dropped: ReviewItem[] } & (
  | { kind: 'stop'; code: LedgerStop; message: string }
  | { kind: 'fix'; items: FixItem[] }
  | { kind: 'clean' }
);

export interface VerdictInput {
  ledger: LedgerEntry[];
  // The reviewer's items.
  items: ReviewItem[];
  // The factory's own blocking items (the undeclared sensitive paths and the paths outside the
  // Task's scope not accepted).
  extra: ReviewItem[];
  reviewer: string;
  // The reviewed iteration; a fix is Fix <iteration>.
  iteration: number;
  // Whether this verdict decides the round (a reviewer alone, or both of a joint round when both are
  // clean): only then does a clean one settle the open entries of earlier rounds. Absent: false.
  decides?: boolean;
  // A joint round's (src/round.ts) factory items (factoryKey) the other reviewer raises: kept open, not carried.
  keep?: ReadonlySet<string>;
}

const reviewerName = (reviewer: string): string => (reviewer === 'codex' ? 'Codex' : reviewer === 'claude' ? 'Claude' : reviewer);
const entryLabel = (entry: Pick<LedgerEntry, 'id' | 'severity' | 'path' | 'problem'>): string => `${entry.id} (${entry.severity}, \`${oneLine(entry.path)}\`): ${oneLine(entry.problem)}`;
const reasonOf = (item: ReviewItem): string => `${oneLine(item.problem)} Expected: ${oneLine(item.expected)}`;
// The bound of a stop's message (the job's error), in characters.
export const MAX_STOP_MESSAGE = 2000;
const shorten = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`);

// The shortest a shown fact gets before fewer facts are shown instead.
const MIN_FACT = 120;
// How many ids a stop's lead names; the rest are counted.
const MAX_LEAD_IDS = 10;

// The ids for a stop's lead: the first MAX_LEAD_IDS, then how many more.
function idList(ids: string[]): string {
  const shown = ids.slice(0, MAX_LEAD_IDS).join(', ');
  return ids.length > MAX_LEAD_IDS ? `${shown} and ${ids.length - MAX_LEAD_IDS} more` : shown;
}

// A stop's message within MAX_STOP_MESSAGE: the lead (what happened), the facts and the tail (how
// to answer, the one question) joined by spaces. The tail is fixed text and always kept whole; the
// lead is capped at 300 characters (its ids by idList). The facts get the room left: as many as fit
// at MIN_FACT characters or more, each shortened to an equal share, the rest counted in a last line
// ("… and N more <noun>: see <where>."). Nothing is cut from the assembled message.
export function stopMessage(lead: string, facts: string[], tail: string, noun = 'findings', where = 'ledger.json'): string {
  const whole = [lead, ...facts, tail].join(' ');
  if (whole.length <= MAX_STOP_MESSAGE) {
    return whole;
  }
  const head = shorten(lead, 300);
  const room = MAX_STOP_MESSAGE - head.length - tail.length - 2;
  for (let count = facts.length; count >= 0; count -= 1) {
    const rest = facts.length - count;
    const more = rest > 0 ? [`… and ${rest} more ${noun}: see ${where}.`] : [];
    const free = room - more.reduce((total, line) => total + line.length + 1, 0) - count;
    const share = count === 0 ? 0 : Math.floor(free / count);
    if (count === 0 || share >= MIN_FACT) {
      const shown = facts.slice(0, count).map((fact) => shorten(fact, share));
      return [head, ...shown, ...more, tail].join(' ');
    }
  }
  return [head, tail].join(' ');
}

// The stop's one question with three answers.
const QUESTION = 'Accept and prepare the MR (when Claude\'s review of the iteration is clean; the open findings go unapplied), continue (sf settle the entries or sf say), or back to planning (abort, keeping the branch)?';

// Applies the ledger to a reviewer's verdict, in this order: an item that reopens an
// accepted_risk entry is dropped (the user decided); one that reopens a contested entry is a
// dispute (review_disputed, the user settles it); one that reopens a fixed or left entry opens it
// again, and a second reopening is churn (review_churn); when every blocker and major item left
// names the fix that caused it (caused_by), the fixes make the findings (review_churn). Otherwise
// the verdict applies: the blocking items (the reviewer's, the extra ones, the
// open blocker and major entries and the fixes the user decided) make a fix, with the reviewer's
// nits as optional; each item of a fix keeps or gets its ledger id. A deciding verdict without a
// blocking item first settles the open blocker and major entries of earlier rounds as fixed.
export function applyVerdict(input: VerdictInput): Applied {
  const known = new Map(input.ledger.map((entry) => [entry.id, entry]));
  const ledger = input.ledger.map((entry) => ({ ...entry }));
  const byId = new Map(ledger.map((entry) => [entry.id, entry]));
  // The entry an item reopens: by its reopens id, or, for a risk the user accepted, by the same path
  // and problem text (a reviewer that raises it again without naming it).
  const sameText = (candidate: LedgerEntry, item: ReviewItem): boolean => oneLine(candidate.path) === oneLine(item.path) && oneLine(candidate.problem).toLowerCase() === oneLine(item.problem).toLowerCase();
  const target = (item: ReviewItem): LedgerEntry | undefined => {
    const named = item.reopens !== undefined && item.reopens.trim() !== '' ? byId.get(item.reopens.trim()) : undefined;
    return named ?? ledger.find((candidate) => candidate.status === 'accepted_risk' && sameText(candidate, item));
  };
  const name = reviewerName(input.reviewer);
  // The factory's own items (undeclared sensitive paths and paths outside the Task's scope not
  // accepted) go through the rules like the reviewer's: one whose path has an entry of the same
  // problem reopens it. They stay out of rule 4 (no caused_by) and keep their own reason.
  const factoryItems = new Set<ReviewItem>();
  const extras = input.extra.map((raised) => {
    const entry = ledger.find((candidate) => factoryKey(candidate) === factoryKey(raised));
    const reopening = entry === undefined ? raised : { ...raised, reopens: entry.id };
    factoryItems.add(reopening);
    return reopening;
  });
  const reasonFor = (item: ReviewItem): string => (factoryItems.has(item)
    ? `${name} does not accept the ${item.problem === SCOPE_PROBLEM ? "path outside the Task's scope" : 'undeclared sensitive path'} ${oneLine(item.path)} (it is not in its accepted_sensitive).`
    : reasonOf(item));

  // 1. The user decided: an accepted risk is never raised again, whatever its severity (the user's
  // simplifications too: an independent defect their removal causes comes without reopens).
  const all = [...input.items, ...extras];
  const dropped = all.filter((item) => target(item)?.status === 'accepted_risk');
  const items = all.filter((item) => target(item)?.status !== 'accepted_risk');

  // 2. A reopened contest is a dispute for the user (a nit never stops the job: it stays a nit).
  const disputes = items.filter((item) => target(item)?.status === 'contested' && item.severity !== 'nit');
  if (disputes.length > 0) {
    const lines: string[] = [];
    for (const item of disputes) {
      const entry = target(item)!;
      entry.dispute = { reviewer: input.reviewer, iteration: input.iteration, reason: reasonFor(item) };
      lines.push(`${entryLabel(entry)} The Implementer contests it: ${oneLine(entry.response) || '(no note)'} Evidence: ${entry.evidence}. ${name} reopens it: ${reasonFor(item)}`);
    }
    const message = stopMessage(`${name} disputes the contest of ${idList(disputes.map((item) => target(item)!.id))}.`, lines, `Settle each disputed entry: accept the risk or must fix (sf settle <workspace> <ticket> <id> accept|fix [note]). ${QUESTION}`);
    return { kind: 'stop', code: 'review_disputed', message, ledger, dropped };
  }

  // 3. A reopened fix (or nit left) is open again; a second reopening is churn.
  const carried = new Map<string, ReviewItem>();
  const churned: LedgerEntry[] = [];
  // What a reopened entry said before, and how it was answered: the facts of a churn stop.
  const previous = new Map<string, string>();
  for (const item of items) {
    const entry = target(item);
    if (entry === undefined) {
      continue;
    }
    if (entry.status === 'contested') {
      // A nit on a contest (a blocker or major is a dispute, above): optional, under the entry's id.
      carried.set(entry.id, item);
      continue;
    }
    // A nit never reopens a fix: it stays optional, under the entry's id, and counts for no churn.
    if ((entry.status === 'fixed' || entry.status === 'left') && item.severity !== 'nit') {
      previous.set(entry.id, `${oneLine(entry.problem)} (answered ${entry.status}${oneLine(entry.response) !== '' ? `: ${oneLine(entry.response)}` : ''})`);
      entry.status = 'open';
      entry.reopened += 1;
      // The entry keeps the higher severity of the two.
      const severity = SEVERITY_RANK[item.severity] >= SEVERITY_RANK[entry.severity] ? item.severity : entry.severity;
      Object.assign(entry, { severity, problem: item.problem, expected: item.expected, response: '', evidence: '' });
      delete entry.fixed_by_clean;
      if (entry.reopened >= 2) {
        churned.push(entry);
      }
    }
    carried.set(entry.id, item);
  }
  if (churned.length > 0) {
    const facts = churned.map((entry) => `${entryLabel(entry)} Before: ${previous.get(entry.id)}.`);
    const message = stopMessage(`${name} reopened ${idList(churned.map((entry) => entry.id))} a second time after it was fixed:`, facts, `The fixes do not settle it. ${QUESTION}`);
    return { kind: 'stop', code: 'review_churn', message, ledger, dropped };
  }

  // 4. Every blocking item left was caused by a fix: the fixes are making the findings. The
  // factory's own items are no reviewer's finding and never count here.
  const blockingItems = items.filter((item) => item.severity !== 'nit' && !factoryItems.has(item));
  const causedBy = (item: ReviewItem): string | undefined => {
    const id = item.caused_by?.trim() ?? '';
    return known.has(id) ? id : undefined;
  };
  if (blockingItems.length > 0 && blockingItems.every((item) => causedBy(item) !== undefined)) {
    const lines = blockingItems.map((item) => {
      const cause = known.get(causedBy(item)!)!;
      // The cause first: the problem text is what a long message shortens.
      return `[${item.severity}] \`${oneLine(item.path)}\` (caused by ${cause.id}, the fix of: ${shorten(oneLine(cause.problem), 200)}): ${oneLine(item.problem)}`;
    });
    const message = stopMessage(`Every blocker and major item of ${name}'s review was caused by an earlier fix:`, lines, `The fixes are making the findings. ${QUESTION}`, 'items');
    return { kind: 'stop', code: 'review_churn', message, ledger, dropped };
  }

  // 5. Otherwise the verdict applies, with the ledger's open blocking entries and the user's fixes. An
  // open entry of the factory's whose path is no longer raised (with the same problem) is fixed.
  const raised = new Set(input.extra.map(factoryKey));
  const kept = (entry: LedgerEntry): boolean => isFactory(entry) && input.keep !== undefined && input.keep.has(factoryKey(entry));
  for (const entry of ledger) {
    if (isFactory(entry) && entry.status === 'open' && !raised.has(factoryKey(entry)) && !carried.has(entry.id) && !kept(entry)) {
      Object.assign(entry, { status: 'fixed', response: 'The reviewer accepted the path, or the change no longer has it.' });
    }
  }
  const extra = items.filter((item) => factoryItems.has(item));
  let number = nextNumber(ledger);
  const assign = (item: ReviewItem): FixItem => {
    const id = `R${number}`;
    number += 1;
    ledger.push({
      id, iteration: input.iteration, reviewer: input.reviewer, severity: item.severity, path: item.path, problem: item.problem, expected: item.expected,
      status: 'open', response: '', evidence: '', reopened: 0, asked: input.iteration, caused_by: causedBy(item) ?? '', dispute: null, settled: null,
    });
    return { id, item };
  };
  const blocking = [...blockingItems, ...extra];
  // A clean deciding verdict saw the whole change: the open blocker and major entries of earlier
  // rounds it does not carry again are fixed by it (never a factory entry, nor what the user decided).
  if (input.decides === true && blocking.length === 0) {
    for (const entry of ledger) {
      if (entry.status === 'open' && blocks(entry) && !isFactory(entry) && entry.asked < input.iteration && !carried.has(entry.id)) {
        Object.assign(entry, { status: 'fixed', response: `Settled by the clean ${name} verdict of iteration ${input.iteration}.`, fixed_by_clean: input.iteration });
      }
    }
  }
  const pending = pendingEntries(ledger, input.iteration).filter((entry) => !carried.has(entry.id) && !kept(entry));
  if (blocking.length === 0 && pending.filter((entry) => entry.status === 'user_fix' || blocks(entry)).length === 0) {
    return { kind: 'clean', ledger, dropped };
  }
  // The id of an item that reopened an entry (step 3) or raises a factory item again, or a new one.
  const fixItem = (item: ReviewItem): FixItem => {
    const id = [...carried].find(([, carriedItem]) => carriedItem === item)?.[0];
    return id !== undefined ? { id, item } : assign(item);
  };
  const fixItems: FixItem[] = blocking.map(fixItem);
  for (const entry of pending.filter((candidate) => candidate.status === 'user_fix' || blocks(candidate))) {
    fixItems.push(userFixItem(entry));
  }
  fixItems.push(...items.filter((candidate) => candidate.severity === 'nit').map(fixItem));
  const asked = new Set(fixItems.map((fixItem) => fixItem.id));
  for (const entry of ledger) {
    if (asked.has(entry.id)) {
      entry.asked = input.iteration;
    }
  }
  return { kind: 'fix', items: fixItems, ledger, dropped };
}

// An entry a Fix section carries again, with the user's note when the user decided the fix.
function userFixItem(entry: LedgerEntry): FixItem {
  return entry.status === 'user_fix' ? { id: entry.id, item: entryItem(entry), userNote: entry.settled?.note ?? '' } : { id: entry.id, item: entryItem(entry) };
}

// The entries a Fix section at fix must carry: open ones and the fixes the user decided, not
// listed in that section already.
export function pendingEntries(ledger: LedgerEntry[], fix: number): LedgerEntry[] {
  return ledger.filter((entry) => (entry.status === 'open' || entry.status === 'user_fix') && entry.asked < fix);
}

// The Fix items after the user settled the stop: the fixes the user decided and, with them, the open
// blocker and major entries; the ledger with each of them asked in Fix fix. None (and the ledger as
// it is) when the user decided no fix.
export function userFixItems(ledger: LedgerEntry[], fix: number): { items: FixItem[]; ledger: LedgerEntry[] } {
  const pending = pendingEntries(ledger, fix).filter((entry) => entry.status === 'user_fix' || blocks(entry));
  // Only the user's decision makes this Fix; without one the stopped review runs again and brings
  // the open entries back itself.
  if (!pending.some((entry) => entry.status === 'user_fix')) {
    return { items: [], ledger };
  }
  const ids = new Set(pending.map((entry) => entry.id));
  return { items: pending.map(userFixItem), ledger: ledger.map((entry) => (ids.has(entry.id) ? { ...entry, asked: fix } : entry)) };
}

// What is left for the user to settle: escalated entries and contests a reviewer disputed.
export function unsettled(ledger: LedgerEntry[]): LedgerEntry[] {
  return ledger.filter((entry) => entry.status === 'escalated' || (entry.status === 'contested' && entry.dispute !== null));
}

// The user's settlement of an escalated or contested entry: accept is accepted_risk, fix is
// user_fix (the next Fix section carries it). invalid_state for any other entry.
export function settle(ledger: LedgerEntry[], id: string, decision: Decision, note: string, at: string): LedgerEntry[] | string {
  const entry = ledger.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    return `The ledger has no entry ${id}.`;
  }
  if (entry.status !== 'escalated' && entry.status !== 'contested') {
    return `${id} is ${entry.status}; only an escalated or contested entry is settled.`;
  }
  return ledger.map((candidate) => (candidate.id === id
    ? { ...candidate, status: decision === 'accept' ? 'accepted_risk' : 'user_fix', dispute: null, settled: { decision, note, at } }
    : candidate));
}

// The message of an escalation stop: one question per escalated entry, and how to answer.
export function escalationMessage(escalated: LedgerEntry[]): string {
  const questions = escalated.map((entry) => `${entryLabel(entry)} Question: ${oneLine(entry.response)}`);
  return stopMessage(`The Implementer escalated ${idList(escalated.map((entry) => entry.id))}: only you know the answer.`, questions, 'Settle each: accept the risk or must fix (sf settle <workspace> <ticket> <id> accept|fix [note]); then the review runs, or the Fix you decided.');
}

// The reviewer of the entries the user's Simplify recorded: one per suggestion of the
// simplification pass, accepted_risk, so a reviewer item that reopens one is dropped (rule 1).
export const SIMPLIFIER = 'simplify';
export const isSimplification = (entry: LedgerEntry): boolean => entry.reviewer === SIMPLIFIER;

// The settled entries for the reviewers (every entry that is not open), one line each.
export function settledLines(ledger: LedgerEntry[]): string[] {
  const settled = ledger.filter((entry) => entry.status !== 'open');
  if (settled.length === 0) {
    return ['None.'];
  }
  return settled.map((entry) => {
    if (isSimplification(entry) && entry.status === 'accepted_risk') {
      return `- ${entry.id} · simplified by the user's choice · \`${oneLine(entry.path)}\`: ${oneLine(entry.problem)} Do not ask to bring it back; a defect its removal causes is a new item, or reopens the entry whose fix the removal undid.`;
    }
    const parts = [`- ${entry.id} · ${entry.status} · ${entry.severity} · \`${oneLine(entry.path)}\`: ${oneLine(entry.problem)}`];
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
  });
}

// The entries the MR text lists as not fixed: accepted risks, contests and nits left.
// The user's simplifications are not findings and stay out.
export function notFixed(ledger: LedgerEntry[]): LedgerEntry[] {
  return ledger.filter((entry) => !isSimplification(entry) && (entry.status === 'accepted_risk' || entry.status === 'contested' || entry.status === 'left'));
}

const STATUS_WORDS: Partial<Record<LedgerStatus, string>> = { accepted_risk: 'accepted risk', contested: 'contested', left: 'left' };

// One line of the MR text's `### Review findings not fixed`.
export function notFixedLine(entry: LedgerEntry): string {
  const why = entry.status === 'accepted_risk' ? oneLine(entry.settled?.note ?? '') : oneLine(entry.response);
  const evidence = entry.status === 'contested' && entry.evidence !== '' ? ` Evidence: ${entry.evidence}.` : '';
  return `- ${entry.id} [${entry.severity}, ${STATUS_WORDS[entry.status] ?? entry.status}] \`${oneLine(entry.path)}\`: ${oneLine(entry.problem)}${why !== '' ? ` — ${why}` : ''}${evidence}`;
}

// The ledger's open findings an Accept goes without (review_churn, review_disputed): open entries,
// the fixes the user decided and the disputed contests, as items with their ids.
export function unappliedEntries(ledger: LedgerEntry[]): Array<ReviewItem & { id: string }> {
  return ledger
    .filter((entry) => entry.status === 'open' || entry.status === 'user_fix' || (entry.status === 'contested' && entry.dispute !== null))
    .map((entry) => ({ id: entry.id, ...entryItem(entry) }));
}
