// The Claude review of one published iteration (SF-038): a fresh, read-only Agent SDK query() in
// the job's worktree, with the Task file, the Report, the Patch and the sensitive and deleted paths
// in its prompt and a structured verdict as its output. Knows nothing about job states; the
// Execution applies the verdict.
import { dirname, resolve } from 'node:path';
import { type Options, query, type SandboxSettings, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod/v4';
import type { FileChange } from './jobs.js';
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

const reviewItem = z.strictObject({
  path: z.string().describe('The file the item is about.'),
  problem: z.string().describe('What is wrong.'),
  expected: z.string().describe('What is expected instead.'),
});
export const reviewOutput = z.strictObject({
  verdict: z.enum(['clean', 'fix']),
  summary: z.string().describe('Why, including every undeclared sensitive path accepted.'),
  items: z.array(reviewItem),
  accepted_sensitive: z.array(z.string()).describe('The undeclared sensitive paths you accept, each justified in summary.'),
});
export type ReviewOutput = z.output<typeof reviewOutput>;
export type ReviewItem = z.output<typeof reviewItem>;
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
}

function cutBuffer(buffer: Buffer, maxBytes: number): string {
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
// rules and the material of the iteration: the Task file, the Report, the sensitive and deleted
// paths and the Patch, inline up to MAX_REVIEW_PATCH_BYTES.
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
    '- Return `fix` with concrete items (path, what is wrong, what is expected), or `clean` when the change needs no further fix. Items of `clean` are ignored.',
    '- An undeclared sensitive path stays only when you name it in accepted_sensitive and justify it in summary; otherwise it becomes a fix item.',
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
    '<sensitive_and_deleted_paths>',
    ...pathLines(input.files),
    '</sensitive_and_deleted_paths>',
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
  return {
    abortController,
    cwd: options.cwd,
    permissionMode: 'auto',
    settingSources: ['project'],
    settings: { claudeMdExcludes: outsideInstructionFiles(options.cwd) },
    tools: REVIEW_TOOLS,
    disallowedTools: REVIEW_DENIED_TOOLS,
    outputFormat: { type: 'json_schema', schema: REVIEW_SCHEMA },
    maxTurns: options.maxTurns,
    // A known startup failure (such as an unavailable sandbox) then ends with a result message.
    env: { ...sessionEnvironment(), CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.claudePath !== undefined ? { pathToClaudeCodeExecutable: options.claudePath } : {}),
  };
}

export type ReviewOutcome =
  | { ok: true; output: ReviewOutput; costUsd: number | null; startedAt: string; endedAt: string }
  | { ok: false; message: string; startedAt: string; endedAt: string };

export function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ');
}

// Runs one review session. Never throws: an error, a turn that is not a success, or a missing or
// invalid structured output is a failed outcome. Nothing is retried.
export async function runReview(prompt: string, options: ReviewOptions): Promise<ReviewOutcome> {
  const startedAt = new Date().toISOString();
  const failed = (message: string): ReviewOutcome => ({ ok: false, message: message.slice(0, 1000), startedAt, endedAt: new Date().toISOString() });
  const abortController = new AbortController();
  const onAbort = (): void => abortController.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });
  let result: SDKResultMessage | undefined;
  try {
    const session = query({ prompt, options: reviewSessionOptions(options, abortController) });
    for await (const message of session) {
      await options.onMessage?.(message).catch((error: unknown) => console.error(error));
      if (message.type === 'result') {
        result = message;
      }
    }
  } catch (error) {
    return failed(`The review session failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    // Ends the child process when the session stopped early.
    abortController.abort();
  }
  if (result === undefined) {
    return failed('The review ended without a result.');
  }
  if (result.subtype !== 'success' || result.is_error) {
    const detail = result.subtype === 'success' ? result.result : result.errors.join('; ');
    return failed(`The review ended with ${result.subtype}: ${detail}`.trim());
  }
  if (result.structured_output === undefined || result.structured_output === null) {
    return failed('The review returned no structured output.');
  }
  const parsed = reviewOutput.safeParse(result.structured_output);
  if (!parsed.success) {
    return failed(`The review returned an invalid verdict: ${issues(parsed.error)}`);
  }
  if (parsed.data.verdict === 'fix' && parsed.data.items.length === 0) {
    return failed('The review returned fix without items.');
  }
  return { ok: true, output: parsed.data, costUsd: result.total_cost_usd ?? null, startedAt, endedAt: new Date().toISOString() };
}

// Text on one line: every run of whitespace a single space.
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

// The body of the Fix section the factory writes for a review: the summary as a lead line (by: who
// reviewed), then one numbered item per entry.
export function fixContent(summary: string, items: ReviewItem[], by = 'Claude'): string {
  return [
    `Review by ${by}: ${oneLine(summary) || 'see the items.'}`,
    '',
    ...items.map((item, index) => `${index + 1}. \`${oneLine(item.path)}\`: ${oneLine(item.problem)} Expected: ${oneLine(item.expected)}`),
  ].join('\n');
}

// The fix item of an undeclared sensitive path a clean verdict did not accept.
export function sensitiveItem(path: string): ReviewItem {
  return { path, problem: 'Undeclared sensitive path.', expected: 'Remove it, or justify it in the Report.' };
}
