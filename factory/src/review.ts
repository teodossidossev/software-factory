// The Claude review of one published iteration: a fresh, read-only Agent SDK query() in
// the job's worktree, with the Task file, the Report, the Patch and the marked paths (sensitive,
// outside the Task's scope, deleted) in its prompt and a structured verdict as its output. Knows
// nothing about job states; the Execution applies the verdict.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type Options, query, type SandboxSettings, type SDKMessage, type SDKResultMessage, type SettingSource } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod/v4';
import { type ImageRef, promptInput } from './attachments.js';
import type { ReviewEffort } from './config.js';
import { type DecisionDocs, reviewDecisionLines } from './decisions.js';
import { type ClaudeTmp, makeSessionTmp, removeSessionTmp } from './host-tmp.js';
import type { UserMessage } from './job-stream.js';
import type { FileChange } from './jobs.js';
import { type FixItem, fixItemLine, LEDGER_REF, type LedgerEntry, SCOPE_PROBLEM, SENSITIVE_PROBLEM, settledLines } from './ledger.js';
import { handbookSection, userDecisionLines } from './prompts.js';
import { acceptedLines, type DeltaMaterial, deltaLines, OUTSIDE_DELTA, OUTSIDE_DELTA_DESCRIPTION } from './review-delta.js';
import { ENV_FILE_RULES } from './rules.js';
import { type PathDenials, type SandboxDenials, withSandboxDenials } from './sandbox-denials.js';
import { JOB_SESSION_SETTINGS, sessionEnvironment, withSandboxEnvDenials } from './session.js';
import { SKILL_BLOCKS_LINE, skillBlocksOf, type SkillNames } from './skills.js';
import { TASK_DIR } from './task-file.js';

export const REVIEWER = 'claude';
// The Patch is sent inline up to this size; the reviewer reads the rest in the worktree.
export const MAX_REVIEW_PATCH_BYTES = 256 * 1024;
// The only tools of the review session.
export const REVIEW_TOOLS = ['Read', 'Grep', 'Glob'];
// Denied as well, should a tool outside REVIEW_TOOLS still be offered.
// 'mcp__*': every MCP server's tools, though readOnlySessionOptions loads none (strictMcpConfig).
export const REVIEW_DENIED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'mcp__*', ...ENV_FILE_RULES];

// The weight of a review item. Only blocker and major items make a fix; nits never block.
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
  // Ledger references: each a ledger id or "" (anything else is an invalid verdict); absent in
  // verdicts and records written before the findings ledger, read as "".
  reopens: z.string().regex(LEDGER_REF).default('').describe('The ledger id of the settled finding this item reopens (only when the settlement is wrong by evidence in the worktree; say why in problem), or "".'),
  caused_by: z.string().regex(LEDGER_REF).default('').describe('The ledger id of the fix whose change caused this item, or "".'),
  // Optional, with no default: a stored item holds it only when the reviewer gave a reason
  // (withoutEmptyReasons); every round's schema has it, the strict gate schema requires it.
  outside_delta: z.enum(OUTSIDE_DELTA).optional().describe(OUTSIDE_DELTA_DESCRIPTION),
});
export const reviewOutput = z.strictObject({
  verdict: z.enum(['clean', 'fix']),
  summary: z.string().describe('Why, including every undeclared sensitive or out-of-scope path accepted.'),
  items: z.array(reviewItem),
  // The name stays for stored records; it holds the out-of-scope paths accepted too.
  accepted_sensitive: z.array(z.string()).describe('The undeclared sensitive or out-of-scope paths you accept, each justified in summary.'),
});
// An item as the reviewers give it and the records keep it: reopens and caused_by may be absent
// (verdicts and records written before the findings ledger).
export type ReviewItem = z.input<typeof reviewItem>;
export type ReviewOutput = Omit<z.output<typeof reviewOutput>, 'items'> & { items: ReviewItem[] };
// The schema sent as outputFormat (the CLI's --json-schema), from the same definition as the
// validation: draft-07 output without $schema, since the CLI refuses zod's default draft 2020-12
// $schema.
const { $schema: _draft, ...reviewSchema } = z.toJSONSchema(reviewOutput, { target: 'draft-7' });
export const REVIEW_SCHEMA: Record<string, unknown> = reviewSchema;

// The review method (the user's code-review skill) is sent up to this size, cut with a note beyond.
export const MAX_REVIEW_METHOD_BYTES = 32 * 1024;
// What review.json and gate.json say of the method: none, or the skill file and the sha256 of its bytes.
export type ReviewMethod = 'none' | { path: string; sha256: string };
// The lines in front of the <review_method> block: how the skill's method fits a factory review.
export const REVIEW_METHOD_LINES = [
  '- Follow the review method below (the user\'s code-review skill), adapted to this review: do not spawn sub-agents and do not ask for a fixed point or a spec. The fixed point is the base commit; the spec is the Task file and the user\'s messages; the standards are the documents the method names plus the rules below. Cover the Spec axis first, then the Standards axis.',
  '- Begin each item\'s `problem` with `Spec:`, `Standards:` or `Decision:`.',
  '- A baseline smell is always a `nit`, never `major` or `blocker`. A breach of a documented standard or of the Task keeps the severities below.',
  '- The change is the uncommitted worktree against the base commit (`git diff <base>`, or the Patch below), not `<fixed-point>...HEAD`; do not stop on an empty `...HEAD` diff.',
  '- Answer only with the output schema: no `## Standards`/`## Spec` report, no word limits.',
  '- Ignore the issue-tracker and setup instructions.',
];

// The review method of one review (ReviewInput's method and review_method), read from the skill file
// at path (Config.reviewSkill) each time: its body without the front matter, cut at MAX_REVIEW_METHOD_BYTES with a line saying so, and its
// record. No path, or a file that is missing or unreadable: no text, and 'none'.
export async function readReviewMethod(path: string | undefined): Promise<{ method: string; review_method: ReviewMethod }> {
  if (path === undefined) {
    return { method: '', review_method: 'none' };
  }
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch { // a missing or unreadable skill: the review runs without the method, and its record says so
    return { method: '', review_method: 'none' };
  }
  const review_method = { path, sha256: createHash('sha256').update(raw).digest('hex') };
  const body = Buffer.from(raw.toString('utf8').replace(/^---\r?\n[\s\S]*?\r?\n---[^\S\n]*(?:\r?\n|$)/, '').trim());
  if (body.length <= MAX_REVIEW_METHOD_BYTES) {
    return { method: body.toString('utf8'), review_method };
  }
  const note = `(The method is cut here: the file has ${raw.length} bytes, the prompt takes ${MAX_REVIEW_METHOD_BYTES}.)`;
  return { method: `${cutBuffer(body, MAX_REVIEW_METHOD_BYTES)}\n${note}`, review_method };
}

// What review.json and gate.json record of a reviewer's skills: its method, and the names of its
// <skill> blocks (SkillNames: none when the role chose no skill besides code-review).
export type RecordedSkills = SkillNames & { review_method: ReviewMethod };

// The skills of a reviewer (job: the folder and lists its start recorded, jobSkills; role: claude_review
// or codex_gate), all read from the job's folder, so a later sync changes none of them: the method is its
// code-review/SKILL.md when the role chose code-review; with set true (Config.reviewSkillSet:
// SF_REVIEW_SKILL set) it is reviewSkill's file instead, whatever the role chose; reviewSkill undefined
// (SF_REVIEW_SKILL empty, or a Config made by hand) is none. Each other chosen skill is a <skill> block (skillBlocksOf).
export async function reviewerSkills(job: { folder: string; roles: Record<'claude_review' | 'codex_gate', string[]> }, role: 'claude_review' | 'codex_gate', reviewSkill: string | undefined, set = false): Promise<{ method: string; review_method: ReviewMethod; skillBlocks: string; recorded: RecordedSkills }> {
  const chosen = job.roles[role];
  const blocks = await skillBlocksOf(job.folder, chosen.filter((name) => name !== 'code-review'));
  const method = await readReviewMethod(set || reviewSkill === undefined ? reviewSkill : chosen.includes('code-review') ? join(job.folder, 'code-review', 'SKILL.md') : undefined);
  return { ...method, skillBlocks: blocks.text, recorded: { review_method: method.review_method, ...blocks.names } };
}

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
  // The job's findings ledger; its settled entries are sent.
  ledger?: LedgerEntry[];
  // The job's <rules> block (src/rules-docs.ts); absent or '' when it has none.
  rules?: string;
  // The user's own messages to the job up to the reviewed iteration, oldest first; absent
  // or [] when there are none.
  userMessages?: UserMessage[];
  // The review method's text (readReviewMethod); absent or '' without one: no method lines, no block.
  method?: string;
  // The review method's record for review.json and gate.json; absent counts as 'none'.
  review_method?: ReviewMethod;
  // The <skill> blocks of the reviewer's other skills (reviewerSkills); absent or '': none.
  skillBlocks?: string;
  // The workspace's decision documents in the job's worktree (src/decisions.ts); absent or none listed: no block.
  decision_docs?: DecisionDocs;
  // A delta round's material (src/review-delta.ts); absent: the round reviews the whole Patch.
  delta?: DeltaMaterial;
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

// One block of a delta round's material inline up to MAX_REVIEW_PATCH_BYTES, after a note when it
// is cut here or was cut before (cutBefore: the text was rebuilt only up to the Patch size limit).
function inlineBlock(open: string, close: string, what: string, text: Buffer, cutBefore = false): string[] {
  const shown = Math.min(text.length, MAX_REVIEW_PATCH_BYTES);
  return [
    ...(cutBefore || shown < text.length ? [`Note: ${what} has ${cutBefore ? 'more than ' : ''}${text.length} bytes; only the first ${shown} are below. Read the changed files in the worktree for the rest.`] : []),
    open, cutBuffer(text, shown).trimEnd(), close,
  ];
}

// A delta round's blocks: the delta, the whole paths' sections when there are any, the accepted change.
function deltaBlocks(delta: DeltaMaterial): string[] {
  return [
    ...inlineBlock(`<delta_patch from="${delta.from}">`, '</delta_patch>', 'The delta', delta.patch, delta.patchCut),
    ...(delta.wholePaths.length > 0 ? ['', ...inlineBlock('<patch>', '</patch>', 'The whole sections of the security-relevant paths', delta.whole)] : []),
    '',
    '<accepted_change>',
    ...acceptedLines(delta.change),
    '</accepted_change>',
  ];
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

// The rules of every reviewer (the Claude review and the gate, src/gate.ts), the review method when
// there is one (the user's code-review skill, before the review rules, which win where they differ),
// the Handbook's review rules and the material of the iteration: the job's coding rules when it has them, the
// Task file, the user's messages to the job, the Report, the marked paths (sensitive,
// outside the Task's scope, deleted), the Patch, inline up to MAX_REVIEW_PATCH_BYTES, and last the
// list of the workspace's decision documents when it has any. A delta round (input.delta) opens with
// its baseline and the rules of items outside the delta (deltaLines), lists the marked paths among
// the judged ones, and sends the delta as <delta_patch> in place of <patch>, the whole paths'
// sections as <patch>, and the whole change's file list as <accepted_change>, each inline up to
// MAX_REVIEW_PATCH_BYTES.
export function reviewBody(input: ReviewInput): string[] {
  const { ticket, delta } = input;
  const rules = input.rules ?? '';
  const method = input.method ?? '';
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
    ...(delta !== undefined ? deltaLines(delta) : []),
    '- Verify the claims of the Report against the files. Do not trust them.',
    `- Review the change against the Task file (${TASK_DIR}/${ticket}.md, below), its \`## Review brief\` section when it has one, and the repository standards: AGENTS.md, CLAUDE.md and the docs you find.`,
    ...(rules !== '' ? ['- A review item that is a rule violation names the rule\'s file (and heading) in `problem`.'] : []),
    '- The user\'s messages to the job (<user_decisions>, below) are the user\'s decisions: where one and the Task file disagree, the message wins, and a later message wins over an earlier one. A change that does what a message asked is not an item, nor is a Task requirement the message replaced; a message the change does not follow is one, citing the message in problem.',
    '- Follow the review rules below (the Handbook\'s).',
    '- Give every item a severity:',
    ...SEVERITIES.map((severity) => `  - \`${severity}\`: ${SEVERITY_DEFINITIONS[severity]}.`),
    '- Return `fix` with concrete items (path, what is wrong, what is expected, severity) when at least one item is a blocker or major; otherwise `clean`, with any nits as its items. The factory acts on the items, whatever the verdict says: a blocker or major item makes a fix, and a `fix` with nits only counts as `clean`. Nits are recorded, never block, and the Implementer may leave them.',
    '- An undeclared sensitive path, or a path outside the Task\'s scope, stays only when you name it in accepted_sensitive and justify it in summary; otherwise it becomes a major fix item, whatever severity you give it. Accept a path outside the scope only for a reason tied to the Task.',
    `- ${TASK_DIR}/ is the factory's folder (the Task file, the Implementer's steps checklist ${TASK_DIR}/${ticket}.steps.md): it is not part of the change, so never review its files or count them as changed, undeclared or out-of-scope paths.`,
    '- The settled findings below (<settled_findings>) are the ledger\'s entries already settled: fixed, contested with evidence, escalated, left (a nit), accepted by the user (accepted_risk) or to be fixed by the user\'s decision (user_fix). Do not raise a settled finding again, nor a narrower variant of it. Raise it only when the settlement is wrong by evidence in the worktree; then set `reopens` to its id and say why in problem. An item that reopens an accepted risk is dropped: the user decided.',
    '- Set `caused_by` to the id of the fix whose change caused the item. `reopens` and `caused_by` are each a ledger id or "".',
    '',
    ...(method !== '' ? [...REVIEW_METHOD_LINES, '<review_method>', method, '</review_method>', ''] : []),
    ...(input.skillBlocks !== undefined && input.skillBlocks !== '' ? [SKILL_BLOCKS_LINE, input.skillBlocks, ''] : []),
    handbookSection(input.handbook, '## Review rules'),
    '',
    ...(rules !== '' ? [rules.trimEnd(), ''] : []),
    `<task_file path="${TASK_DIR}/${ticket}.md">`,
    input.task.trimEnd(),
    '</task_file>',
    '',
    '<user_decisions>',
    ...userDecisionLines(input.userMessages ?? []),
    '</user_decisions>',
    '',
    '<report>',
    input.report.trimEnd(),
    '</report>',
    '',
    '<marked_paths>',
    ...pathLines(delta !== undefined ? delta.marked : input.files),
    '</marked_paths>',
    '',
    '<settled_findings>',
    ...settledLines(input.ledger ?? []),
    '</settled_findings>',
    '',
    ...(delta !== undefined ? deltaBlocks(delta) : [
      ...notes.map((note) => `Note: ${note}`),
      '<patch>',
      (cut ? cutBuffer(input.patch, MAX_REVIEW_PATCH_BYTES) : input.patch.toString('utf8')).trimEnd(),
      '</patch>',
    ]),
    ...reviewDecisionLines(input.decision_docs),
  ];
}

export interface ReviewOptions {
  // The job's worktree.
  cwd: string;
  claudePath: string | undefined;
  sandbox: SandboxSettings | undefined;
  model: string | undefined;
  // The session's reasoning effort (SF_REVIEW_EFFORT for the sessions that judge code); undefined
  // passes none: the model's default.
  effort?: ReviewEffort | undefined;
  maxTurns: number;
  // Aborts the session (abort, reset, a newer review).
  signal: AbortSignal;
  // Every SDK message of the session, in order, awaited before the next one; a failing
  // call changes nothing of the outcome.
  onMessage?: (message: SDKMessage) => Promise<void>;
  // The Task's images: their image blocks follow the prompt in the session's user message,
  // each after a line naming it, as for the Implementer.
  images?: ImageRef[] | undefined;
  // Builds the session's path denials (src/sandbox-denials.ts) for the temporary folder
  // runStructuredSession makes: their tools, sandbox lists, claudeTmp and hooks go into the fields
  // below. Its error is the one runStructuredSession throws (the session's refusal before it starts).
  pathDenials?: ((sessionTmp: string) => Promise<PathDenials>) | undefined;
  // The session's path denials: permission rules denied on top of the session's own, and the
  // sandbox's filesystem deny lists and the host's temporary roots' lists merged into sandbox.
  deny?: string[] | undefined;
  filesystem?: SandboxDenials | undefined;
  claudeTmp?: ClaudeTmp | undefined;
  // The path denials' hooks (the file-tool guard), merged with the session's own hooks.
  hooks?: Options['hooks'];
  // The session's own temporary folder, its CLAUDE_CODE_TMPDIR.
  sessionTmp?: string | undefined;
  // The session's tools; REVIEW_TOOLS by default. [] (the morning digest): none but the
  // SDK's structured-output tool.
  tools?: string[];
  // The settings and instruction files loaded; ['project'] by default. [] (the morning digest):
  // none, so no CLAUDE.md, AGENTS.md or user settings.
  settingSources?: SettingSource[];
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

// The query() options of a review session: read-only tools, the schema, and the
// repository's own settings and instructions only. settingSources ['project'] leaves out the user's
// settings and ~/.claude/CLAUDE.md; CLAUDE_CODE_DISABLE_AUTO_MEMORY leaves out the user's
// auto-memory of the project, which the CLI loads whatever the setting sources; claudeMdExcludes
// leaves out the instruction files above the worktree; JOB_SESSION_SETTINGS runs no settings hook.
export function reviewSessionOptions(options: Omit<ReviewOptions, 'onMessage' | 'signal' | 'pathDenials'>, abortController: AbortController): Options {
  return readOnlySessionOptions(options, abortController, REVIEW_SCHEMA);
}

// The options of every read-only session with a structured output (the review, the Task check,
// the morning digest): REVIEW_TOOLS only (or the given tools), REVIEW_DENIED_TOOLS plus deny plus
// the options' path denials, the given output schema, and the given hooks (the Task check's path
// guard) merged with the options' hooks (the file-tool guard); the environment's credentials
// denied to sandboxed commands. No MCP server: strictMcpConfig with no mcpServers leaves out the
// user's, the project's .mcp.json and the plugins' servers (tools covers built-in tools only), and
// REVIEW_DENIED_TOOLS denies 'mcp__*'. No caller gives a read-only session a server of its own.
export function readOnlySessionOptions(
  options: Omit<ReviewOptions, 'onMessage' | 'signal' | 'pathDenials'>, abortController: AbortController, schema: Record<string, unknown>, deny: readonly string[] = [],
  sessionHooks?: Options['hooks'],
): Options {
  // The environment, built once: the CLI gets it, and its credentials are hidden from sandboxed
  // commands, after the path denials, as in an Implementer turn.
  const environment = sessionEnvironment();
  const sandbox = withSandboxEnvDenials(withSandboxDenials(options.sandbox, options.filesystem, options.claudeTmp), environment);
  const hooks = mergeHooks(sessionHooks, options.hooks);
  return {
    abortController,
    cwd: options.cwd,
    permissionMode: 'auto',
    settingSources: options.settingSources ?? ['project'],
    settings: { claudeMdExcludes: outsideInstructionFiles(options.cwd), ...JOB_SESSION_SETTINGS },
    tools: options.tools ?? REVIEW_TOOLS,
    disallowedTools: [...REVIEW_DENIED_TOOLS, ...deny, ...(options.deny ?? [])],
    strictMcpConfig: true,
    mcpServers: {},
    outputFormat: { type: 'json_schema', schema },
    maxTurns: options.maxTurns,
    // A known startup failure (such as an unavailable sandbox) then ends with a result message.
    env: {
      ...environment, CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      ...(options.sessionTmp !== undefined ? { CLAUDE_CODE_TMPDIR: options.sessionTmp } : {}),
    },
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.claudePath !== undefined ? { pathToClaudeCodeExecutable: options.claudePath } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  };
}

// Two hooks options as one: each event's matchers concatenated (the first's first); undefined when
// neither has any.
export function mergeHooks(first: Options['hooks'], second: Options['hooks']): Options['hooks'] {
  if (first === undefined || second === undefined) {
    return first ?? second;
  }
  const merged: NonNullable<Options['hooks']> = { ...first };
  for (const [event, matchers] of Object.entries(second) as Array<[keyof typeof merged, NonNullable<typeof merged[keyof typeof merged]>]>) {
    merged[event] = [...(first[event] ?? []), ...matchers];
  }
  return merged;
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

// Runs one read-only session in a temporary folder of its own (makeSessionTmp, its
// CLAUDE_CODE_TMPDIR), made at its start and removed at its end, whatever the end; the path
// denials, given pathDenials, are built for that folder. Never throws but pathDenials' own error:
// any other error, a turn that is not a success, or a missing or invalid structured output is a
// failed outcome. Nothing is retried.
export async function runStructuredSession<T>(prompt: string, options: ReviewOptions, session: StructuredSession<T>): Promise<StructuredOutcome<T>> {
  const startedAt = new Date().toISOString();
  let sessionTmp: string;
  try {
    sessionTmp = await makeSessionTmp();
  } catch (error) {
    const message = `The ${session.noun} session could not make its temporary folder: ${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, message: message.slice(0, 1000), model: null, startedAt, endedAt: new Date().toISOString() };
  }
  try {
    const denials = await options.pathDenials?.(sessionTmp);
    const built: ReviewOptions = denials === undefined ? { ...options, sessionTmp } : {
      ...options, sessionTmp, deny: [...(options.deny ?? []), ...denials.tools], filesystem: denials.sandbox, claudeTmp: denials.claudeTmp, hooks: mergeHooks(options.hooks, denials.hooks),
    };
    return await runSession(prompt, built, session, startedAt);
  } finally {
    await removeSessionTmp(sessionTmp);
  }
}

// One read-only session with its options built (runStructuredSession): its outcome, never thrown.
async function runSession<T>(prompt: string, options: ReviewOptions, session: StructuredSession<T>, startedAt: string): Promise<StructuredOutcome<T>> {
  const { noun } = session;
  let model: string | null = null;
  const failed = (message: string): StructuredOutcome<T> => ({ ok: false, message: message.slice(0, 1000), model, startedAt, endedAt: new Date().toISOString() });
  const abortController = new AbortController();
  const onAbort = (): void => abortController.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });
  let result: SDKResultMessage | undefined;
  let input: Awaited<ReturnType<typeof promptInput>> | undefined;
  try {
    input = await promptInput(prompt, options.images);
    const messages = query({ prompt: input.prompt, options: readOnlySessionOptions(options, abortController, session.schema, session.deny, session.hooks) });
    for await (const message of messages) {
      await options.onMessage?.(message).catch((error: unknown) => console.error(error));
      if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string' && message.model !== '') {
        model = message.model;
      }
      if (message.type === 'result') {
        result = message;
        input.done();
      }
    }
  } catch (error) {
    return failed(`The ${noun} session failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    input?.done();
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

// Runs one review session; never throws but its path denials' error (runStructuredSession). A fix
// without items fails too.
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
// "Nits (optional):"; each item with its ledger id (fixItemLine).
export function fixContent(summary: string, items: FixItem[], by = 'Claude'): string {
  return fixBody([{ by, summary }], items);
}

// The body of a joint round's Fix section (src/round.ts): a lead line per reviewer, Claude's then
// the gate's, then the items as in fixContent.
export function jointFixContent(claude: string, gate: string, items: FixItem[]): string {
  return fixBody([{ by: 'Claude', summary: claude }, { by: 'Codex', summary: gate }], items);
}

// A Fix section's body: the lead lines, a blank line, the numbered blocker and major items, then
// the nits under "Nits (optional):".
function fixBody(leads: Array<{ by: string; summary: string }>, items: FixItem[]): string {
  // A fix the user decided is never optional, whatever its severity.
  const optional = items.filter((fixItem) => fixItem.item.severity === 'nit' && fixItem.userNote === undefined);
  const blockers = items.filter((fixItem) => !optional.includes(fixItem));
  return [
    ...leads.map(({ by, summary }) => `Review by ${by}: ${oneLine(summary) || 'see the items.'}`),
    '',
    ...blockers.map((fixItem, index) => `${index + 1}. ${fixItemLine(fixItem)}`),
    ...(optional.length > 0 ? ['', 'Nits (optional):', ...optional.map((fixItem, index) => `${blockers.length + index + 1}. ${fixItemLine(fixItem)}`)] : []),
  ].join('\n');
}

// The fix item of an undeclared sensitive path a verdict did not accept: always major.
export function sensitiveItem(path: string): ReviewItem {
  return { path, problem: SENSITIVE_PROBLEM, expected: 'Remove it, or justify it in the Report.', severity: 'major' };
}

// The fix item of a path outside the Task's scope a verdict did not accept: always major.
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

// The reviewer's verdict before the sensitive-path rule, as the factory acts on it: a round
// is clean when it has no blocker or major item, whatever the reviewer wrote; fix otherwise.
export function actedVerdict(output: { items: ReviewItem[] }): Verdict {
  return blocking(output.items).length > 0 ? 'fix' : 'clean';
}

// The verdict the factory acts on, for both reviewers: fix when the reviewer gave a
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
