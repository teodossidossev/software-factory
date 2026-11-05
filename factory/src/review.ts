// The Claude review of one published iteration (SF-038): a fresh, read-only Agent SDK query() in
// the job's worktree, with the Task file, the Report, the Patch and the marked paths (sensitive,
// outside the Task's scope, deleted) in its prompt and a structured verdict as its output. Knows
// nothing about job states; the Execution applies the verdict.
import { dirname, resolve } from 'node:path';
import { type Options, query, type SandboxSettings, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod/v4';
import type { FileChange } from './jobs.js';
import { type FixItem, fixItemLine, LEDGER_REF, type LedgerEntry, SCOPE_PROBLEM, SENSITIVE_PROBLEM, settledLines } from './ledger.js';
import { handbookSection } from './prompts.js';
import { ENV_FILE_RULES } from './rules.js';
import { sessionEnvironment } from './session.js';
import { TASK_DIR } from './task-file.js';

export const REVIEWER = 'claude';
// The Patch is sent inline up to this size; the reviewer reads the rest in the worktree.
export const MAX_REVIEW_PATCH_BYTES = 256 * 1024;
// The only tools of the review session.
export const REVIEW_TOOLS = ['Read', 'Grep', 'Glob'];
// Denied as well, should a tool outside REVIEW_TOOLS still be offered.
export const REVIEW_DENIED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', ...ENV_FILE_RULES];

// The weight of a review item (SF-051). Only blocker and major items make a fix; nits never block.
export const SEVERITIES = ['blocker', 'major', 'nit'] as const;
export type Severity = (typeof SEVERITIES)[number];
// The definitions both reviewers read (reviewBody) and the schema carries.
export const SEVERITY_DEFINITIONS: Record<Severity, string> = {
  blocker: "the change is wrong, unsafe or breaks the Task's acceptance",
  major: 'a real defect or a Task requirement not met, but contained',
  nit: 'style, naming, wording, a narrower variant of a risk already accepted, a nice-to-have',
};
const reviewItem = z.strictObject({
  path: z.string().describe('The file the item is about.'),
  problem: z.string().describe('What is wrong.'),
  expected: z.string().describe('What is expected instead.'),
  severity: z.enum(SEVERITIES).describe(SEVERITIES.map((severity) => `${severity}: ${SEVERITY_DEFINITIONS[severity]}`).join('; ')),
  // The ledger (SF-052): each a ledger id or "" (anything else is an invalid verdict); absent in
  // verdicts and records before it, read as "".
  reopens: z.string().regex(LEDGER_REF).default('').describe('The ledger id of the settled finding this item reopens (only when the settlement is wrong by evidence in the worktree; say why in problem), or "".'),
  caused_by: z.string().regex(LEDGER_REF).default('').describe('The ledger id of the fix whose change caused this item, or "".'),
});
export const reviewOutput = z.strictObject({
  verdict: z.enum(['clean', 'fix']),
  summary: z.string().describe('Why, including every undeclared sensitive or out-of-scope path accepted.'),
  items: z.array(reviewItem),
  // The name stays for stored records; it holds the out-of-scope paths accepted too (SF-053).
  accepted_sensitive: z.array(z.string()).describe('The undeclared sensitive or out-of-scope paths you accept, each justified in summary.'),
});
// An item as the reviewers give it and the records keep it: reopens and caused_by may be absent
// (verdicts and records before SF-052).
export type ReviewItem = z.input<typeof reviewItem>;
export type ReviewOutput = Omit<z.output<typeof reviewOutput>, 'items'> & { items: ReviewItem[] };
// The schema sent as outputFormat (the CLI's --json-schema), from the same definition as the
// validation: draft-07 output without $schema, since the CLI refuses zod's default draft 2020-12
// $schema (SF-044).
const { $schema: _draft, ...reviewSchema } = z.toJSONSchema(reviewOutput, { target: 'draft-7' });
export const REVIEW_SCHEMA: Record<string, unknown> = reviewSchema;

export interface ReviewInput {
  ticket: string;
  iteration: number;
  // The Task file as the Implementer saw it.
  task: string;
  report: string;
  patch: Buffer;
  // The published Patch was cut at its size limit.
  patchTruncated: boolean;
  // The file list of the iteration; undefined for an iteration published before it existed.
  files: FileChange[] | undefined;
  // The loaded Handbook text; its review rules are sent verbatim.
  handbook: string;
  // The job's findings ledger (SF-052); its settled entries are sent.
  ledger?: LedgerEntry[];
}

// The buffer's first maxBytes bytes as text, never splitting a UTF-8 character.
export function cutBuffer(buffer: Buffer, maxBytes: number): string {
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString('utf8');
}

function pathLines(files: FileChange[] | undefined): string[] {
  if (files === undefined) {
    return ['Not recorded for this iteration; see the changed files in the Report.'];
  }
  const lines = [
    ...files.filter((change) => change.sensitive === 'undeclared').map((change) => `- sensitive, undeclared: ${change.path}`),
    ...files.filter((change) => change.sensitive === 'declared').map((change) => `- sensitive, declared by may_touch: ${change.path}`),
    ...files.filter((change) => change.scope === 'out').map((change) => `- outside the Task's scope: ${change.path}`),
    ...files.filter((change) => change.status === 'deleted').map((change) => `- deleted: ${change.path}`),
  ];
  return lines.length > 0 ? lines : ['None.'];
}

// The prompt of the review: what it is and how to answer, the Handbook's review rules, then the
// material of the iteration.
export function reviewPrompt(input: ReviewInput): string {
  return [
    `Code review of iteration ${input.iteration} of ticket ${input.ticket}. You review; you change nothing.`,
    'The current directory is the job\'s worktree: it holds the change of this iteration, not committed. Your tools are Read, Grep and Glob; nothing else is available.',
    ...reviewBody(input),
  ].join('\n');
}

// The rules of every reviewer (the Claude review and the gate, src/gate.ts), the Handbook's review
// rules and the material of the iteration: the Task file, the Report, the marked paths (sensitive,
// outside the Task's scope, deleted) and the Patch, inline up to MAX_REVIEW_PATCH_BYTES.
export function reviewBody(input: ReviewInput): string[] {
  const { ticket } = input;
  const cut = input.patch.length > MAX_REVIEW_PATCH_BYTES;
  const notes: string[] = [];
  if (cut) {
    notes.push(`The Patch has ${input.patch.length} bytes; only the first ${MAX_REVIEW_PATCH_BYTES} are below. Read the changed files in the worktree for the rest.`);
  }
  if (input.patchTruncated) {
    notes.push('The published Patch was cut at its size limit. Read the changed files in the worktree for the rest.');
  }
  return [
    '',
    '- Verify the claims of the Report against the files. Do not trust them.',
    `- Review the change against the Task file (${TASK_DIR}/${ticket}.md, below), its \`## Review brief\` section when it has one, and the repository standards: AGENTS.md, CLAUDE.md and the docs you find.`,
    '- Follow the review rules below (the Handbook\'s).',
    '- Give every item a severity:',
    ...SEVERITIES.map((severity) => `  - \`${severity}\`: ${SEVERITY_DEFINITIONS[severity]}.`),
    '- Return `fix` with concrete items (path, what is wrong, what is expected, severity) when at least one item is a blocker or major; otherwise `clean`, with any nits as its items. The factory acts on the items, whatever the verdict says: a blocker or major item makes a fix, and a `fix` with nits only counts as `clean`. Nits are recorded, never block, and the Implementer may leave them.',
    '- An undeclared sensitive path, or a path outside the Task\'s scope, stays only when you name it in accepted_sensitive and justify it in summary; otherwise it becomes a major fix item, whatever severity you give it. Accept a path outside the scope only for a reason tied to the Task.',
    '- The settled findings below (<settled_findings>) are the ledger\'s entries already settled: fixed, contested with evidence, escalated, left (a nit), accepted by the user (accepted_risk) or to be fixed by the user\'s decision (user_fix). Do not raise a settled finding again, nor a narrower variant of it. Raise it only when the settlement is wrong by evidence in the worktree; then set `reopens` to its id and say why in problem. An item that reopens an accepted risk is dropped: the user decided.',
    '- Set `caused_by` to the id of the fix whose change caused the item. `reopens` and `caused_by` are each a ledger id or "".',
    '',
    handbookSection(input.handbook, '## Review rules'),
    '',
    `<task_file path="${TASK_DIR}/${ticket}.md">`,
    input.task.trimEnd(),
    '</task_file>',
    '',
    '<report>',
    input.report.trimEnd(),
    '</report>',
    '',
    '<marked_paths>',
    ...pathLines(input.files),
    '</marked_paths>',
    '',
    '<settled_findings>',
    ...settledLines(input.ledger ?? []),
    '</settled_findings>',
    '',
    ...notes.map((note) => `Note: ${note}`),
    '<patch>',
    (cut ? cutBuffer(input.patch, MAX_REVIEW_PATCH_BYTES) : input.patch.toString('utf8')).trimEnd(),
    '</patch>',
  ];
}

export interface ReviewOptions {
  // The job's worktree.
  cwd: string;
  claudePath: string | undefined;
  sandbox: SandboxSettings | undefined;
  model: string | undefined;
  maxTurns: number;
  // Aborts the session (abort, reset, a newer review).
  signal: AbortSignal;
  // Every SDK message of the session, in order, awaited before the next one (SF-045); a failing
  // call changes nothing of the outcome.
  onMessage?: (message: SDKMessage) => Promise<void>;
}

// The instruction files the CLI loads as project instructions from a directory, with
// settingSources ['project']: it walks up from its cwd and loads each directory's.
const PROJECT_INSTRUCTION_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', '.claude/AGENTS.md', '.claude/rules/**'];

// A path as a picomatch pattern that matches only itself.
const literalPattern = (path: string): string => path.replace(/[\\*?[\]{}()!+@|]/g, '\\$&');

// The project instruction files of every directory above the worktree, as claudeMdExcludes
// patterns: the user's files there (such as ~/CLAUDE.md, or ~/.claude/CLAUDE.md read as a project
// file of the home directory) are not the repository's standards.
export function outsideInstructionFiles(cwd: string): string[] {
  const patterns: string[] = [];
  let dir = resolve(cwd);
  while (dirname(dir) !== dir) {
    dir = dirname(dir);
    patterns.push(...PROJECT_INSTRUCTION_FILES.map((file) => `${literalPattern(dir === '/' ? '' : dir)}/${file}`));
  }
  return patterns;
}

// The query() options of a review session (SF-050): read-only tools, the schema, and the
// repository's own settings and instructions only. settingSources ['project'] leaves out the user's
// settings and ~/.claude/CLAUDE.md; CLAUDE_CODE_DISABLE_AUTO_MEMORY leaves out the user's
// auto-memory of the project, which the CLI loads whatever the setting sources; claudeMdExcludes
// leaves out the instruction files above the worktree.
export function reviewSessionOptions(options: Omit<ReviewOptions, 'onMessage' | 'signal'>, abortController: AbortController): Options {
  return readOnlySessionOptions(options, abortController, REVIEW_SCHEMA);
}

// The options of every read-only session with a structured output (the review, the Task check of
// SF-054): REVIEW_TOOLS only, REVIEW_DENIED_TOOLS plus deny, the given output schema, and the
// given hooks (the Task check's path guard).
export function readOnlySessionOptions(
  options: Omit<ReviewOptions, 'onMessage' | 'signal'>, abortController: AbortController, schema: Record<string, unknown>, deny: readonly string[] = [],
  hooks?: Options['hooks'],
): Options {
  return {
    abortController,
    cwd: options.cwd,
    permissionMode: 'auto',
    settingSources: ['project'],
    settings: { claudeMdExcludes: outsideInstructionFiles(options.cwd) },
    tools: REVIEW_TOOLS,
    disallowedTools: [...REVIEW_DENIED_TOOLS, ...deny],
    outputFormat: { type: 'json_schema', schema },
    maxTurns: options.maxTurns,
    // A known startup failure (such as an unavailable sandbox) then ends with a result message.
    env: { ...sessionEnvironment(), CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.claudePath !== undefined ? { pathToClaudeCodeExecutable: options.claudePath } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  };
}

export type ReviewOutcome =
  | { ok: true; output: ReviewOutput; costUsd: number | null; startedAt: string; endedAt: string }
  | { ok: false; message: string; startedAt: string; endedAt: string };

export function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ');
}

// A read-only session with a structured output: its schema, the zod definition that validates
// the output, what the failure messages call the session ("review") and its output ("verdict"),
// the permission rules denied on top of REVIEW_DENIED_TOOLS, and the session's hooks.
export interface StructuredSession<T> {
  schema: Record<string, unknown>;
  output: z.ZodType<T>;
  noun: string;
  outputNoun: string;
  deny?: readonly string[];
  hooks?: Options['hooks'];
}

// model: what the session's init message names, or null when it named none.
export type StructuredOutcome<T> =
  | { ok: true; output: T; costUsd: number | null; model: string | null; startedAt: string; endedAt: string }
  | { ok: false; message: string; model: string | null; startedAt: string; endedAt: string };

// Runs one read-only session. Never throws: an error, a turn that is not a success, or a missing
// or invalid structured output is a failed outcome. Nothing is retried.
export async function runStructuredSession<T>(prompt: string, options: ReviewOptions, session: StructuredSession<T>): Promise<StructuredOutcome<T>> {
  const { noun } = session;
  const startedAt = new Date().toISOString();
  let model: string | null = null;
  const failed = (message: string): StructuredOutcome<T> => ({ ok: false, message: message.slice(0, 1000), model, startedAt, endedAt: new Date().toISOString() });
  const abortController = new AbortController();
  const onAbort = (): void => abortController.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });
  let result: SDKResultMessage | undefined;
  try {
    const messages = query({ prompt, options: readOnlySessionOptions(options, abortController, session.schema, session.deny, session.hooks) });
    for await (const message of messages) {
      await options.onMessage?.(message).catch((error: unknown) => console.error(error));
      if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string' && message.model !== '') {
        model = message.model;
      }
      if (message.type === 'result') {
        result = message;
      }
    }
  } catch (error) {
    return failed(`The ${noun} session failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    // Ends the child process when the session stopped early.
    abortController.abort();
  }
  if (result === undefined) {
    return failed(`The ${noun} ended without a result.`);
  }
  if (result.subtype !== 'success' || result.is_error) {
    const detail = result.subtype === 'success' ? result.result : result.errors.join('; ');
    return failed(`The ${noun} ended with ${result.subtype}: ${detail}`.trim());
  }
  if (result.structured_output === undefined || result.structured_output === null) {
    return failed(`The ${noun} returned no structured output.`);
  }
  const parsed = session.output.safeParse(result.structured_output);
  if (!parsed.success) {
    return failed(`The ${noun} returned an invalid ${session.outputNoun}: ${issues(parsed.error)}`);
  }
  return { ok: true, output: parsed.data, costUsd: result.total_cost_usd ?? null, model, startedAt, endedAt: new Date().toISOString() };
}

// Runs one review session; never throws (runStructuredSession). A fix without items fails too.
export async function runReview(prompt: string, options: ReviewOptions): Promise<ReviewOutcome> {
  const outcome = await runStructuredSession(prompt, options, { schema: REVIEW_SCHEMA, output: reviewOutput, noun: 'review', outputNoun: 'verdict' });
  const { startedAt, endedAt } = outcome;
  if (!outcome.ok) {
    return { ok: false, message: outcome.message, startedAt, endedAt };
  }
  if (outcome.output.verdict === 'fix' && outcome.output.items.length === 0) {
    return { ok: false, message: 'The review returned fix without items.', startedAt, endedAt };
  }
  return { ok: true, output: outcome.output, costUsd: outcome.costUsd, startedAt, endedAt };
}

// Text on one line: every run of whitespace a single space.
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

// One item on one line: its severity, path, problem and what is expected.
export function itemLine(item: ReviewItem): string {
  return `[${item.severity}] \`${oneLine(item.path)}\`: ${oneLine(item.problem)} Expected: ${oneLine(item.expected)}`;
}

// The body of the Fix section the factory writes for a review: the summary as a lead line (by: who
// reviewed), then one numbered item per blocker or major entry, then the nits, numbered on, under
// "Nits (optional):"; each item with its ledger id (SF-052).
export function fixContent(summary: string, items: FixItem[], by = 'Claude'): string {
  // A fix the user decided is never optional, whatever its severity.
  const optional = items.filter((fixItem) => fixItem.item.severity === 'nit' && fixItem.userNote === undefined);
  const blockers = items.filter((fixItem) => !optional.includes(fixItem));
  return [
    `Review by ${by}: ${oneLine(summary) || 'see the items.'}`,
    '',
    ...blockers.map((fixItem, index) => `${index + 1}. ${fixItemLine(fixItem)}`),
    ...(optional.length > 0 ? ['', 'Nits (optional):', ...optional.map((fixItem, index) => `${blockers.length + index + 1}. ${fixItemLine(fixItem)}`)] : []),
  ].join('\n');
}

// The fix item of an undeclared sensitive path a verdict did not accept: always major.
export function sensitiveItem(path: string): ReviewItem {
  return { path, problem: SENSITIVE_PROBLEM, expected: 'Remove it, or justify it in the Report.', severity: 'major' };
}

// The fix item of a path outside the Task's scope a verdict did not accept (SF-053): always major.
export function scopeItem(path: string): ReviewItem {
  return { path, problem: SCOPE_PROBLEM, expected: 'Remove the change, or justify it in the Report.', severity: 'major' };
}

// The factory's fix items for the marked paths of an iteration a verdict did not accept: an
// undeclared sensitive path not in accepted, then a path outside the Task's scope not in accepted.
// A path that is both raises both items, each with its own ledger entry; accepted is by path, so
// one acceptance settles both.
export function unacceptedItems(files: FileChange[], accepted: readonly string[]): ReviewItem[] {
  const open = files.filter((change) => !accepted.includes(change.path));
  return [
    ...open.filter((change) => change.sensitive === 'undeclared').map((change) => sensitiveItem(change.path)),
    ...open.filter((change) => change.scope === 'out').map((change) => scopeItem(change.path)),
  ];
}

// The items that block: blocker and major.
export const blocking = (items: ReviewItem[]): ReviewItem[] => items.filter((item) => item.severity !== 'nit');
// The items that never block.
export const nits = (items: ReviewItem[]): ReviewItem[] => items.filter((item) => item.severity === 'nit');

// A verdict as the reviewer writes it, or as the factory acts on it.
export type Verdict = 'clean' | 'fix';

// The reviewer's verdict before the sensitive-path rule, as the factory acts on it (SF-051): a round
// is clean when it has no blocker or major item, whatever the reviewer wrote; fix otherwise.
export function actedVerdict(output: { items: ReviewItem[] }): Verdict {
  return blocking(output.items).length > 0 ? 'fix' : 'clean';
}

// The verdict the factory acts on, for both reviewers (SF-051): fix when the reviewer gave a
// blocker or major item, or when an undeclared sensitive path or a path outside the Task's scope
// is not accepted (unaccepted, always major); clean otherwise, whatever the reviewer wrote. The
// items of a fix are the blocking ones (the reviewer's, then the unaccepted paths), then the
// reviewer's nits; none for clean.
export function decide(output: { items: ReviewItem[] }, unaccepted: ReviewItem[]): { verdict: Verdict; items: ReviewItem[] } {
  const own = blocking(output.items);
  if (own.length === 0 && unaccepted.length === 0) {
    return { verdict: 'clean', items: [] };
  }
  return { verdict: 'fix', items: [...own, ...unaccepted, ...nits(output.items)] };
}

// The nits of the given verdicts, deduplicated by path and problem text (on one line), in order.
export function uniqueNits(outputs: Array<{ items: ReviewItem[] }>): ReviewItem[] {
  const seen = new Set<string>();
  const result: ReviewItem[] = [];
  for (const item of outputs.flatMap((output) => nits(output.items))) {
    const key = `${oneLine(item.path)}\n${oneLine(item.problem)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}
