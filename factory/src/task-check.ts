// The Task check: before Start, a fresh, read-only Agent SDK query() reads the Task file
// and the repository only, and says whether an Implementer could build it without a design
// decision of its own. It runs in a temporary detached worktree of the work checkout at the Task's
// base (the code the Implementer starts from), which has no .software-factory folder, and a
// PreToolUse hook refuses every Read, Grep or Glob that reaches outside that worktree and every other
// tool but the SDK's StructuredOutput. Its prompt holds the repository's and the user's
// coding rules read at the checkout's commit (src/rules-docs.ts) and the Task file, and
// nothing of the Context owner's conversation, the jobs or the ledger; its output is a paraphrase first, then
// findings, the files it expects to change and a verdict. A check is stored by the sha256 of the Task file it read, under the state
// directory, never in the work checkout. It only advises: nothing here starts, refuses or changes
// a job.
import { createHash, randomUUID } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HookCallback, SandboxSettings, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { attachmentReferences, imageHashes, type ImageRef, type ResolvedImage, resolveImages, writeImages } from './attachments.js';
import type { Config } from './config.js';
import { taskStartBranch } from './continues.js';
import { FactoryError } from './errors.js';
import { inTmpRoot, TMP_REFUSAL, tmpRoots } from './host-tmp.js';
import { Redactor } from './redact.js';
import { runGit } from './git.js';
import { resolveTarget } from './mr.js';
import type { Workspace } from './registry.js';
import { runStructuredSession, SEVERITIES, SEVERITY_DEFINITIONS, type Severity } from './review.js';
import { collectRules } from './rules-docs.js';
import { matchesGlob, scopeOf } from './rules.js';
import { absoluteRule, pathDenials, prepareTaskChecksDir, TASK_CHECK_DIR_UNSAFE } from './sandbox-denials.js';
import { ARCHIVE_DIR, checkNeed, isDraft, mayTouch, parseFrontMatter, readTask, TASK_DIR, taskScope, TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';
import { addDetachedWorktree, removeWorktree } from './worktree.js';

export const FINDING_KINDS = ['decision', 'contradiction', 'missing', 'overreach', 'unclear'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
export const FINDING_KIND_DEFINITIONS: Record<FindingKind, string> = {
  decision: 'a choice the Implementer would have to make',
  contradiction: 'a claim about the code that the code contradicts, with the path:line that contradicts it (always a blocker)',
  missing: 'a file, test or acceptance criterion the goal needs and the Task does not name',
  overreach: 'a part the stated goal does not need',
  unclear: 'a passage the Implementer could read in more than one way',
};
export const FILE_ACTIONS = ['create', 'modify', 'delete'] as const;

export const checkFinding = z.strictObject({
  kind: z.enum(FINDING_KINDS).describe(FINDING_KINDS.map((kind) => `${kind}: ${FINDING_KIND_DEFINITIONS[kind]}`).join('; ')),
  severity: z.enum(SEVERITIES).describe(SEVERITIES.map((severity) => `${severity}: ${SEVERITY_DEFINITIONS[severity]}`).join('; ')),
  where: z.string().describe('The Task section, or the path:line in the repository (always for a contradiction).'),
  problem: z.string().describe('What is wrong with the Task.'),
  expected: z.string().describe('What the Task should say instead.'),
});
export const checkFile = z.strictObject({
  path: z.string().describe('Repository-relative path.'),
  action: z.enum(FILE_ACTIONS),
});
// paraphrase is the first property: the checker writes it before anything else.
export const checkOutput = z.strictObject({
  paraphrase: z.string().min(1).describe('What the Task proposes, in your own words, written before anything else: 3-8 sentences.'),
  findings: z.array(checkFinding),
  files: z.array(checkFile).describe('Every file you expect the change to create, modify or delete, tests and docs included.'),
  verdict: z.enum(['ready', 'not_ready']).describe('ready when no finding is a blocker or major; not_ready otherwise.'),
});
export type CheckFinding = z.output<typeof checkFinding>;
export type CheckOutput = z.output<typeof checkOutput>;
export type CheckVerdict = CheckOutput['verdict'];
// The schema sent as outputFormat, draft-07 without $schema (as the review's).
const { $schema: _draft, ...checkSchema } = z.toJSONSchema(checkOutput, { target: 'draft-7' });
export const CHECK_SCHEMA: Record<string, unknown> = checkSchema;

// The verdict rule: ready when no finding is a blocker or major, whatever the checker wrote.
export function checkVerdict(findings: readonly CheckFinding[]): CheckVerdict {
  return findings.some((item) => item.severity !== 'nit') ? 'not_ready' : 'ready';
}

// The findings of the files the checker expects against the Task's scope, when it has one:
// an expected file outside scope and may_touch is missing (major: the job would get a scope fix
// item for it), a scope entry no expected file matches is overreach (nit). One the checker gave
// already (the same kind naming the path) is not repeated.
export function scopeFindings(task: string, files: CheckOutput['files'], given: readonly CheckFinding[] = []): CheckFinding[] {
  const fields = parseFrontMatter(task);
  const scope = fields === undefined ? undefined : taskScope(fields);
  if (fields === undefined || scope === undefined) {
    return [];
  }
  const touch = mayTouch(fields);
  const named = (kind: FindingKind, path: string): boolean => given.some((item) => item.kind === kind && (item.where.includes(path) || item.problem.includes(path)));
  const result: CheckFinding[] = [];
  for (const file of files) {
    if (scopeOf(file.path, scope, touch) === 'out' && !named('missing', file.path)) {
      result.push({
        kind: 'missing', severity: 'major', where: 'scope:',
        problem: `${file.path} (${file.action}) is a file the change needs, and scope: does not name it.`,
        expected: `Add ${file.path} to scope:, or say why it does not change.`,
      });
    }
  }
  for (const entry of scope) {
    if (!files.some((file) => file.path === entry || matchesGlob(file.path, entry)) && !named('overreach', entry)) {
      result.push({
        kind: 'overreach', severity: 'nit', where: 'scope:',
        problem: `scope: names ${entry}, and no change the goal needs falls under it.`,
        expected: `Remove ${entry} from scope:, or say what changes there.`,
      });
    }
  }
  return result;
}

// The output as the factory keeps it: a contradiction is always a blocker, the scope differences
// are added, and the verdict is the rule's.
export function settleCheck(task: string, output: CheckOutput): CheckOutput {
  const findings = [
    ...output.findings.map((item) => (item.kind === 'contradiction' ? { ...item, severity: 'blocker' as const } : item)),
    ...scopeFindings(task, output.files, output.findings),
  ];
  return { paraphrase: output.paraphrase, findings, files: output.files, verdict: checkVerdict(findings) };
}

// The prompt of the check: what it is and how to answer, the <rules> block when there is one,
// then the Task file. Nothing else: no conversation, job, review or ledger.
export function checkPrompt(ticket: string, task: string, rules = ''): string {
  return [
    `Readiness check of the Task file of ticket ${ticket}, before an Implementer builds it. You check; you change nothing.`,
    'The current directory is a checkout of the repository the Task is about, at the Task\'s base: the code the Implementer starts from. Your tools are Read, Grep and Glob, inside this directory only; nothing else is available. The Task file below is all you get of the plan.',
    '',
    '- First, before you look for findings, write paraphrase: what the Task proposes, in your own words, in 3 to 8 sentences: the goal, the change and how it is accepted. Where you cannot paraphrase a part, or your paraphrase could differ from what the author meant, that is a finding about the Task (`unclear`).',
    '- Readiness, the Zero-Decision Rule: the Implementer makes no design decision. Each choice the Task leaves open that the Implementer would have to make is a `decision`. Every file to change must be named as Create, Modify or Delete, and the Task must have a test plan and acceptance criteria; what the goal needs and the Task does not name is `missing`.',
    '- Codebase: check every claim of the Task about the code (files, functions, behaviour, settings) against the repository. A claim the code contradicts is a `contradiction`, always a blocker, with the path:line that contradicts it in where.',
    '- Zoom out: a part of the Task the stated goal does not need is `overreach`.',
    '- Give every finding a kind, a severity, where (the Task section, or path:line), the problem and what the Task should say instead. Severities:',
    ...SEVERITIES.map((severity: Severity) => `  - \`${severity}\`: ${SEVERITY_DEFINITIONS[severity]}.`),
    '- files: every file you expect the change to create, modify or delete, tests and docs included. When the front matter has `scope:`, a file you expect outside it is `missing`, and a scope entry no expected file needs is `overreach`.',
    '- verdict: `ready` when no finding is a blocker or major; `not_ready` otherwise. The factory applies this rule to your findings, whatever you write.',
    '',
    ...(rules !== '' ? [rules.trimEnd(), ''] : []),
    `<task_file path="${TASK_DIR}/${ticket}.md">`,
    task.trimEnd(),
    '</task_file>',
  ].join('\n');
}

// The sha256 of a Task file's text (UTF-8), as write_task reports it.
export const taskSha256 = (task: string): string => createHash('sha256').update(task, 'utf8').digest('hex');
// The sha256 a check of a Task file is stored and found by: taskSha256 of the text when
// it refers to no image; otherwise the sha256 of the text, a newline and the sorted
// "<name>:<sha256>" lines of its referenced images ("<name>:missing" for one that cannot be read),
// so a changed image makes the check stale.
export function taskCheckSha256(task: string, images: ReadonlyArray<{ name: string; sha256: string }>): string {
  if (images.length === 0) {
    return taskSha256(task);
  }
  const lines = images.map((image) => `${image.name}:${image.sha256}`).sort();
  return createHash('sha256').update(`${task}\n${lines.join('\n')}`, 'utf8').digest('hex');
}

// The folder of a ticket's images in the work checkout; under archive/ for an archived Task file.
const imagesDir = (workspace: Workspace, ticket: string, archived = false): string =>
  join(workspace.workCheckout, TASK_DIR, ...(archived ? [ARCHIVE_DIR] : []), ticket);

// taskCheckSha256 of a Task text with its referenced images as they are in the folder now.
export async function currentCheckSha256(workspace: Workspace, ticket: string, task: string, archived = false): Promise<string> {
  const references = attachmentReferences(ticket, task);
  return taskCheckSha256(task, references.length === 0 ? [] : await imageHashes(imagesDir(workspace, ticket, archived), references));
}

// The name of a check's file: the first 16 hex of the Task file's sha256.
export const checkId = (sha256: string): string => sha256.slice(0, 16);

// A stored check: the output (null when the check failed) or its redacted error, the base commit
// it read (null when it failed before), the model, the estimated cost and the times. ok checks
// have a verdict; a failed one never counts as ready.
export interface CheckRecord {
  workspace: string;
  ticket: string;
  sha256: string;
  commit: string | null;
  status: 'checked' | 'failed';
  output: CheckOutput | null;
  error: string | null;
  model: string | null;
  cost_usd: number | null;
  started_at: string;
  ended_at: string;
}

// <state>/checks/<ws>/<ticket>/<sha256, first 16 hex>.json.
export class CheckStore {
  readonly root: string;

  constructor(stateDir: string) {
    this.root = join(stateDir, 'checks');
  }

  #dir(workspace: string, ticket: string): string {
    if (!TICKET_PATTERN.test(ticket)) {
      throw new FactoryError('invalid_ticket', `ticket must be ${TICKET_DESCRIPTION}.`);
    }
    return join(this.root, workspace, ticket);
  }

  path(workspace: string, ticket: string, sha256: string): string {
    return join(this.#dir(workspace, ticket), `${checkId(sha256)}.json`);
  }

  async write(record: CheckRecord): Promise<string> {
    const path = this.path(record.workspace, record.ticket, record.sha256);
    await mkdir(this.#dir(record.workspace, record.ticket), { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
    return path;
  }

  // The record of an automatic check, unless signal aborts first: a complete temp file is
  // written, then signal is looked at and the file renamed into place in one synchronous step, so a
  // cancel either comes before the commit (nothing stored, the temp file goes) or after it (the run
  // had ended). Returns the path, or undefined when cancelled.
  async writeUnless(record: CheckRecord, signal: AbortSignal): Promise<string | undefined> {
    const path = this.path(record.workspace, record.ticket, record.sha256);
    if (signal.aborted) {
      return undefined;
    }
    await mkdir(this.#dir(record.workspace, record.ticket), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // No await between the look at signal and the rename: no cancel can come in between.
      if (signal.aborted) {
        return undefined;
      }
      renameSync(temp, path);
      return path;
    } finally {
      rmSync(temp, { force: true });
    }
  }

  // The check of the Task file with this sha256, or undefined.
  async read(workspace: string, ticket: string, sha256: string): Promise<CheckRecord | undefined> {
    const record = await readRecord(this.path(workspace, ticket, sha256));
    return record?.sha256 === sha256 ? record : undefined;
  }

  // The check that ended last, of any version of the Task file, or undefined.
  async last(workspace: string, ticket: string): Promise<CheckRecord | undefined> {
    return (await this.records(workspace, ticket)).reduce<CheckRecord | undefined>((last, record) => (last === undefined || record.ended_at > last.ended_at ? record : last), undefined);
  }

  // Every stored check of the ticket, over all versions of its Task file (its plan-check rounds and
  // cost), failed ones included, in the order they ended; an unreadable file is left out.
  async records(workspace: string, ticket: string): Promise<CheckRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir(workspace, ticket));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const records: CheckRecord[] = [];
    for (const name of names.filter((entry) => /^[0-9a-f]{16}\.json$/.test(entry)).sort()) {
      const record = await readRecord(join(this.#dir(workspace, ticket), name));
      if (record !== undefined) {
        records.push(record);
      }
    }
    return records.sort((a, b) => (a.ended_at < b.ended_at ? -1 : a.ended_at > b.ended_at ? 1 : 0));
  }
}

async function readRecord(path: string): Promise<CheckRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CheckRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

// What a stored check counts as: its verdict, or failed (never ready).
export const recordVerdict = (record: CheckRecord): CheckVerdict | 'failed' =>
  record.status === 'failed' || record.output === null ? 'failed' : record.output.verdict;

// A skeleton is not checked: the Context owner has not written the Task yet.
export function refuseDraft(ticket: string, task: string): void {
  if (isDraft(task)) {
    throw new FactoryError('task_draft', `${TASK_DIR}/${ticket}.md is a draft: the Context owner has not written the Task yet.`);
  }
}

// The counts of a check's findings by severity.
export function severityCounts(output: CheckOutput | null): Record<Severity, number> {
  const counts: Record<Severity, number> = { blocker: 0, major: 0, nit: 0 };
  for (const item of output?.findings ?? []) {
    counts[item.severity] += 1;
  }
  return counts;
}

// What the board shows of a ticket's last check: none, the verdict (ready, not_ready) or failed;
// not_needed when the current Task file has no check and checkNeed says it needs none, with
// check_reason, checkNeed's reason (null otherwise); stale when it read another version of the Task
// file than the current one; running while one runs in sf serve; and the note of Start's
// confirmation.
export interface CheckSummary {
  state: 'none' | 'ready' | 'not_ready' | 'failed' | 'not_needed';
  check_reason: string | null;
  stale: boolean;
  running: boolean;
  blockers: number;
  majors: number;
  nits: number;
  ended_at: string | null;
  start_note: string | null;
}

// The note of Start's confirmation: "not checked", "stale", "check failed" or "not ready: N blocker,
// M major"; null for a ready check of the current Task file and for a Task that needs none.
// Start is never refused for it.
export function startNote(summary: Pick<CheckSummary, 'state' | 'stale' | 'blockers' | 'majors'>): string | null {
  if (summary.state === 'not_needed') {
    return null;
  }
  if (summary.state === 'none') {
    return 'not checked';
  }
  if (summary.stale) {
    return 'stale';
  }
  if (summary.state === 'failed') {
    return 'check failed';
  }
  if (summary.state === 'not_ready') {
    return `not ready: ${summary.blockers} blocker, ${summary.majors} major`;
  }
  return null;
}

// currentSha: the sha256 of the current Task file; undefined when it cannot be read (then a
// stored check is stale).
export function checkSummary(record: CheckRecord | undefined, currentSha: string | undefined, running = false): CheckSummary {
  const counts = severityCounts(record?.output ?? null);
  const state = record === undefined ? 'none' : recordVerdict(record);
  const stale = record !== undefined && record.sha256 !== currentSha;
  const summary = { state, check_reason: null, stale, running, blockers: counts.blocker, majors: counts.major, nits: counts.nit, ended_at: record?.ended_at ?? null } as const;
  return { ...summary, start_note: startNote(summary) };
}

export interface CheckOptions {
  claudePath: string | undefined;
  sandbox: SandboxSettings | undefined;
  // The review's model (SF_REVIEW_MODEL); undefined uses the user's default.
  model: string | undefined;
  // SF_TASK_CHECK_MAX_TURNS.
  maxTurns: number;
  // SF_RULES_MAX_BYTES.
  rulesMaxBytes: number;
  // The factory's state and config directories: off limits to the checker, with the work
  // checkout's .software-factory folder (the other Task files, the MR texts, the archive).
  stateDir: string;
  configDir: string;
  // The worktree root (SF_WORKTREE_ROOT): every job's worktree is off limits too.
  worktreeRoot: string;
  signal?: AbortSignal;
  // Every SDK message of the session, in order; a failing call changes nothing of the outcome.
  onMessage?: (message: SDKMessage) => Promise<void>;
}

// Read rules on top of the guard (defence in depth): the work checkout's .software-factory folder
// (the other Task files, the MR texts, the archive), the factory's state (jobs, ledgers, requests,
// checks) and its config.
export function checkDeniedRules(checkout: string, stateDir: string, configDir: string): string[] {
  return [join(checkout, TASK_DIR), stateDir, configDir].map((dir) => `Read(${absoluteRule(dir)}/**)`);
}

// Glob characters: a pattern segment with one of them is not a fixed directory.
const GLOB_CHARS = /[*?[\]{}]/;

// The path with its deepest existing ancestor's symlinks resolved, so a link inside the root that
// points outside it is seen where it leads.
async function realTarget(path: string): Promise<string> {
  const rest: string[] = [];
  let existing = path;
  for (;;) {
    try {
      return join(await realpath(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) {
        return path;
      }
      rest.unshift(relative(parent, existing));
      existing = parent;
    }
  }
}

// The keys of a tool input that name a path; Claude Code reads any of them (Grep takes file_path
// for path, for one), so each one present is a target.
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];

// A path value the guard cannot resolve as Claude Code will: one it trims or expands (~, ~/...,
// ~user); such a call is refused rather than guessed.
const unresolvable = (value: string): boolean => value !== value.trim() || value.startsWith('~');

// The most alternatives a pattern's braces may expand to, the most brace groups it may have and
// the longest path or pattern value; more refuse the call (before any expansion).
const MAX_ALTERNATIVES = 64;
const MAX_BRACE_GROUPS = 16;
const MAX_VALUE_CHARS = 4096;

// A glob pattern's brace alternatives, nested ones included ("src/{a,{b,c}}" -> src/a, src/b,
// src/c), each to be checked on its own. undefined: braces that do not pair, a backslash (an
// escape the guard does not interpret), an extglob or "|" (alternatives it does not expand) or
// more than MAX_ALTERNATIVES.
export function braceAlternatives(pattern: string): string[] | undefined {
  if (pattern.length > MAX_VALUE_CHARS || pattern.split('{').length - 1 > MAX_BRACE_GROUPS || pattern.includes('\\') || pattern.includes('|') || /[@!+*?]\(/.test(pattern)) {
    return undefined;
  }
  const open = pattern.indexOf('{');
  if (open < 0) {
    return pattern.includes('}') ? undefined : [pattern];
  }
  if (pattern.slice(0, open).includes('}')) {
    return undefined;
  }
  let depth = 0;
  let start = open + 1;
  const parts: string[] = [];
  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}' && (depth -= 1) === 0) {
      parts.push(pattern.slice(start, index));
      const result: string[] = [];
      for (const part of parts) {
        const expanded = braceAlternatives(`${pattern.slice(0, open)}${part}${pattern.slice(index + 1)}`);
        if (expanded === undefined || result.push(...expanded) > MAX_ALTERNATIVES) {
          return undefined;
        }
      }
      return result;
    } else if (char === ',' && depth === 1) {
      parts.push(pattern.slice(start, index));
      start = index + 1;
    }
  }
  return undefined;
}

// The paths a tool call reads, relative to the root or absolute: every path key present (the root
// when Grep or Glob has none) and, for each brace alternative of Glob's pattern, its part up to
// the first glob segment. undefined: a tool the check may not use, a Read without a path, a value
// it trims or expands, a pattern it cannot expand, an alternative that climbs with "..", or an
// absolute alternative of Grep's glob filter.
function toolTargets(tool: string, input: Record<string, unknown>): string[] | undefined {
  if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Glob') {
    return undefined;
  }
  const values = (keys: string[]): Array<string | undefined> => keys.filter((key) => input[key] !== undefined).map((key) => (typeof input[key] === 'string' ? input[key] as string : undefined));
  const paths = values(PATH_KEYS);
  const patterns = values(tool === 'Glob' ? ['pattern'] : tool === 'Grep' ? ['glob'] : []);
  if ([...paths, ...patterns].some((value) => value === undefined || value.length > MAX_VALUE_CHARS || unresolvable(value))) {
    return undefined;
  }
  const given = (paths as string[]).filter((path) => path !== '');
  if (tool === 'Read' && given.length === 0) {
    return undefined;
  }
  const bases = given.length > 0 ? given : ['.'];
  const targets = [...bases];
  for (const pattern of patterns as string[]) {
    const alternatives = braceAlternatives(pattern);
    if (alternatives === undefined) {
      return undefined;
    }
    for (const alternative of alternatives) {
      const segments = alternative.split('/');
      if (unresolvable(alternative) || segments.includes('..') || (tool === 'Grep' && isAbsolute(alternative))) {
        return undefined;
      }
      if (tool === 'Glob') {
        const first = segments.findIndex((segment) => GLOB_CHARS.test(segment));
        const fixed = (first < 0 ? segments : segments.slice(0, first)).join('/');
        targets.push(...(isAbsolute(alternative) ? [fixed || '/'] : bases.map((base) => join(base, fixed))));
      }
    }
  }
  return targets;
}

// The SDK's tool through which the session gives its structured output (outputFormat): it carries
// the answer, not a file access, so the guard lets it through unchecked, by this exact name only.
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

// Why a tool call of the check is refused, or undefined when it is the session's answer
// (STRUCTURED_OUTPUT_TOOL) or every path it reads is inside root (symlinks resolved) and outside a
// .software-factory folder there. root is the check's worktree, a real path; temporary: the host's
// temporary roots (tmpRoots), whose refusal says so (TMP_REFUSAL). Never throws: a call the guard
// fails to check is refused (Claude Code would take a hook that throws as no decision and let the
// call through).
export async function guardReason(root: string, tool: string, input: unknown, temporary: readonly string[] = []): Promise<string | undefined> {
  if (tool === STRUCTURED_OUTPUT_TOOL) {
    return undefined;
  }
  try {
    return await checkedReason(root, tool, input, temporary);
  } catch {
    return `The Task check could not check this ${tool} call; it is refused.`;
  }
}

async function checkedReason(root: string, tool: string, input: unknown, temporary: readonly string[]): Promise<string | undefined> {
  const targets = typeof input === 'object' && input !== null ? toolTargets(tool, input as Record<string, unknown>) : undefined;
  if (targets === undefined) {
    return `The Task check reads the repository with Read, Grep and Glob only, inside ${root}, by plain paths (no ~, no surrounding spaces); this ${tool} call is refused.`;
  }
  for (const target of targets) {
    const real = await realTarget(resolve(root, target));
    const inside = relative(root, real);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || inside.split(sep)[0] === TASK_DIR) {
      return `The Task check may read only the repository checkout ${root}; ${target} ${inTmpRoot(real, temporary) ? `is in a temporary root: ${TMP_REFUSAL}` : 'is outside it'}.`;
    }
  }
  return undefined;
}

// The check's PreToolUse hook: guardReason (with the temporary roots) first; a refusal is a deny.
export function guardHooks(root: string, temporary: readonly string[] = []): { PreToolUse: Array<{ hooks: HookCallback[] }> } {
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {};
    }
    const reason = await guardReason(root, input.tool_name, input.tool_input, temporary).catch(() => 'The Task check could not check this call; it is refused.');
    return reason === undefined ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  };
  return { PreToolUse: [{ hooks: [guard] }] };
}

// What a symbolic link out of the check's worktree becomes there.
export const OUTSIDE_LINK_NOTE = 'A symbolic link out of the repository checkout; the Task check does not follow it.\n';

// Replaces every symbolic link under root (.git left alone) whose target is outside root, or does
// not resolve, with a regular file holding OUTSIDE_LINK_NOTE: a search from the root that follows
// links then stays inside the worktree. Links that stay inside are kept. Returns the paths replaced.
export async function cutOutsideLinks(root: string): Promise<string[]> {
  const cut: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== '.git') {
        await walk(path);
      } else if (entry.isSymbolicLink()) {
        const target = await realpath(path).catch(() => undefined);
        const inside = target === undefined ? '..' : relative(root, target);
        if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || inside.split(sep)[0] === TASK_DIR) {
          await unlink(path);
          await writeFile(path, OUTSIDE_LINK_NOTE, { flag: 'wx' });
          cut.push(relative(root, path));
        }
      }
    }
  };
  await walk(root);
  return cut;
}

// The check's checkout: a detached worktree of the work checkout at the Task's base, or its
// continues (fetched from origin when there is one, as Start does), in a new directory check-*
// under the Task checks' parent directory (<tmp>/sf-task-checks-<uid>, which every other session
// denies; an unsafe one fails the check with task_check_dir_unsafe), with its symbolic links out
// of it cut (cutOutsideLinks). remove() takes it away and prunes its registration.
async function checkCheckout(checkout: string, task: string): Promise<{ root: string; commit: string; remove: () => Promise<void> }> {
  const base = taskStartBranch(parseFrontMatter(task));
  if (base === '' || base.startsWith('-') || (await runGit(checkout, ['check-ref-format', '--branch', base])).code !== 0) {
    throw new FactoryError('base_not_found', `The base "${base}" is not a valid branch name.`);
  }
  const { commit } = await resolveTarget(checkout, base);
  const dir = await realpath(await mkdtemp(join(await prepareTaskChecksDir(), 'check-')));
  const root = join(dir, 'repo');
  const remove = async (): Promise<void> => {
    const failure = await removeWorktree(checkout, root);
    if (failure !== undefined) {
      console.error(failure);
    }
    await rm(dir, { recursive: true, force: true });
    // A registration whose removal failed goes once its directory is gone.
    await runGit(checkout, ['worktree', 'prune']);
  };
  try {
    await addDetachedWorktree(checkout, root, commit);
    await cutOutsideLinks(root);
  } catch (error) {
    await remove();
    throw error;
  }
  return { root, commit, remove };
}

// Runs one check of the given Task text in its own worktree of the work checkout at the Task's
// base. Never throws: a checkout that cannot be made or a failed session is a failed record, its
// error redacted like a failed review's. The worktree is removed afterwards.
export async function runTaskCheck(workspace: Workspace, ticket: string, task: string, options: CheckOptions): Promise<CheckRecord> {
  const startedAt = new Date().toISOString();
  // The referenced images, read by the factory from the work checkout's folder: the
  // session may not read .software-factory/. One that cannot be used fails the check; no session runs.
  const references = attachmentReferences(ticket, task);
  let images: ResolvedImage[];
  try {
    images = references.length === 0 ? [] : await resolveImages(imagesDir(workspace, ticket), ticket, references);
  } catch (error) {
    const message = error instanceof FactoryError ? error.message : 'The Task file\'s images could not be read.';
    return {
      workspace: workspace.name, ticket, sha256: await currentCheckSha256(workspace, ticket, task), commit: null, status: 'failed', output: null,
      error: message, model: options.model ?? null, cost_usd: null, started_at: startedAt, ended_at: new Date().toISOString(),
    };
  }
  const record = { workspace: workspace.name, ticket, sha256: taskCheckSha256(task, images) };
  let checkout: Awaited<ReturnType<typeof checkCheckout>>;
  try {
    checkout = await checkCheckout(workspace.workCheckout, task);
  } catch (error) {
    const unsafe = error instanceof FactoryError && error.code === TASK_CHECK_DIR_UNSAFE ? `${TASK_CHECK_DIR_UNSAFE}: ` : '';
    const message = `${unsafe}The check could not prepare its checkout: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ...record, commit: null, status: 'failed', output: null, error: new Redactor({ cwd: workspace.workCheckout }).failure(message.slice(0, 1000)),
      model: options.model ?? null, cost_usd: null, started_at: startedAt, ended_at: new Date().toISOString(),
    };
  }
  try {
    const cwd = checkout.root;
    // The images as they were read and hashed, next to the check's checkout (removed with it), so
    // the session sees exactly the bytes its sha256 names.
    const imageDir = join(dirname(checkout.root), 'images');
    if (images.length > 0) {
      await writeImages(imageDir, images);
    }
    const refs: ImageRef[] = images.map(({ name, alt, type }) => ({ ticket, name, alt, type, path: join(imageDir, name) }));
    const redactor = new Redactor({ cwd });
    // A failed record of the check, with its error, before its session ran.
    const failed = (error: string): CheckRecord => ({
      ...record, commit: checkout.commit, status: 'failed', output: null, error, model: options.model ?? null, cost_usd: null, started_at: startedAt, ended_at: new Date().toISOString(),
    });
    let rules: string;
    try {
      rules = (await collectRules(workspace.workCheckout, checkout.commit, {
        workspace: workspace.name, skip: workspace.rulesSkip ?? [], configDir: options.configDir, maxBytes: options.rulesMaxBytes,
      })).block;
    } catch (error) {
      return failed(redactor.failure(`The check could not collect the coding rules: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000)));
    }
    if (options.signal?.aborted === true) {
      return failed('The check was cancelled.');
    }
    // The paths off limits to every session, but the Task checks' parent directory the check
    // runs in: on top of checkDeniedRules for the tools, and for the sandbox, with the session's
    // temporary folder and the check's own folder (not its siblings) kept. The check's own guard (guardHooks) holds the tools, not the job's.
    let outcome: Awaited<ReturnType<typeof runStructuredSession<CheckOutput>>>;
    try {
      outcome = await runStructuredSession(checkPrompt(ticket, task, rules), {
        cwd, claudePath: options.claudePath, sandbox: options.sandbox, model: options.model, maxTurns: options.maxTurns,
        pathDenials: async (sessionTmp) => ({ ...(await pathDenials({ session: 'task_check', workspace: workspace.name, checkout: workspace.workCheckout, sessionTmp,
          checkFolder: dirname(cwd), stateDir: options.stateDir, worktreeRoot: options.worktreeRoot, configDir: options.configDir })), hooks: undefined }),
        signal: options.signal ?? new AbortController().signal, images: refs,
        // Every message passes the redactor, so a failure after a withheld read is withheld too.
        onMessage: async (message) => {
          redactor.reviewMessage(message);
          await options.onMessage?.(message);
        },
      }, {
        schema: CHECK_SCHEMA, output: checkOutput, noun: 'check', outputNoun: 'output',
        deny: checkDeniedRules(workspace.workCheckout, options.stateDir, options.configDir), hooks: guardHooks(cwd, await tmpRoots()),
      });
    } catch (error) {
      // Only the path denials throw (runStructuredSession).
      return failed(redactor.failure(`The check could not build its path denials: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000)));
    }
    const base = { ...record, commit: checkout.commit, model: outcome.model ?? options.model ?? null, started_at: startedAt, ended_at: outcome.endedAt };
    if (!outcome.ok) {
      return { ...base, status: 'failed', output: null, error: redactor.failure(outcome.message), cost_usd: null };
    }
    return { ...base, status: 'checked', output: settleCheck(task, outcome.output), error: null, cost_usd: outcome.costUsd };
  } finally {
    await checkout.remove();
  }
}

// The current Task file of a ticket and its check sha256 (taskCheckSha256); the archived copy, with
// the images under archive/, when the file was archived; undefined when there is neither.
async function currentTask(workspace: Workspace, ticket: string): Promise<{ text: string; sha256: string } | undefined> {
  for (const archived of [false, true]) {
    try {
      const text = await readTask(workspace, ticket, archived);
      return { text, sha256: await currentCheckSha256(workspace, ticket, text, archived) };
    } catch (error) {
      if (!(error instanceof FactoryError) || error.code !== 'task_not_found') {
        throw error;
      }
    }
  }
  return undefined;
}

// The last check of a ticket as the views show it: the record, whether it is stale, the sha256 of
// the current Task file, and check_reason: checkNeed's reason when the current Task file
// has no check and needs none, else null.
export interface CheckView {
  check: CheckRecord | null;
  stale: boolean;
  running: boolean;
  current_sha256: string | null;
  check_reason: string | null;
}

// The check settings of a loaded Config: the review's executable, sandbox and model, the check's
// turn limit and the directories off limits.
export function checkSettings(config: Config, configDir: string): Omit<CheckOptions, 'signal' | 'onMessage'> {
  return {
    claudePath: config.claudePath, sandbox: config.sandbox, model: config.reviewModel, maxTurns: config.taskCheckMaxTurns, rulesMaxBytes: config.rulesMaxBytes,
    stateDir: config.stateDir, configDir, worktreeRoot: config.worktreeRoot,
  };
}

export interface TaskChecksOptions extends Omit<CheckOptions, 'signal' | 'onMessage'> {
  resolve: (name: string) => Promise<Workspace>;
  // Called when a check started by start() or startAuto() has been stored (or has failed to be),
  // or was cancelled.
  onSettled?: (workspace: string, ticket: string) => void;
}

// Who hears of the checks of TaskChecks besides onSettled (the automatic checks).
export interface CheckObserver {
  // A manual check of the ticket (start) was accepted and is about to run.
  manualStart?: (workspace: string, ticket: string) => void;
  // A check of the ticket, manual or automatic, has ended: it no longer counts as running.
  ended?: (workspace: string, ticket: string) => void;
}

// The checks of sf serve: one running per ticket at most, started from the dashboard (start) or by
// the automatic checks (startAuto); the views of the dashboard and the Context owner's
// task_check tool.
export class TaskChecks {
  readonly store: CheckStore;
  readonly #options: TaskChecksOptions;
  readonly #running = new Set<string>();
  readonly #observers: CheckObserver[] = [];

  constructor(options: TaskChecksOptions) {
    this.#options = options;
    this.store = new CheckStore(options.stateDir);
  }

  // Adds an observer of the checks (AutoChecks).
  observe(observer: CheckObserver): void {
    this.#observers.push(observer);
  }

  isRunning(workspace: string, ticket: string): boolean {
    return this.#running.has(`${workspace}/${ticket}`);
  }

  // Whether a check of any ticket of the workspace runs or is being set up.
  runningIn(workspace: string): boolean {
    return [...this.#running].some((key) => key.startsWith(`${workspace}/`));
  }

  // The checks running or being set up, manual and automatic, by workspace and ticket (sf serve's
  // serve-busy). Read-only: a copy.
  running(): Array<{ workspace: string; ticket: string }> {
    return [...this.#running].map((key) => {
      const slash = key.indexOf('/');
      return { workspace: key.slice(0, slash), ticket: key.slice(slash + 1) };
    });
  }

  // The checks running or being set up, manual and automatic, over every workspace.
  runningCount(): number {
    return this.#running.size;
  }

  // Starts a check of the current Task file and answers at once; the record is stored when it ends.
  // A draft, a missing Task file and a check already running or being set up for the ticket are
  // refused. The observers hear of it first: a pending automatic check of the ticket goes.
  async start(name: string, ticket: string): Promise<{ started: true; sha256: string }> {
    const { started, sha256 } = await this.#launch(name, ticket, undefined);
    return { started, sha256 };
  }

  // An automatic check: as start, with signal passed to the check. A check cancelled
  // through signal stores nothing. ended settles with the stored record, or undefined when the
  // check was cancelled or could not be stored.
  startAuto(name: string, ticket: string, signal: AbortSignal): Promise<{ started: true; sha256: string; ended: Promise<CheckRecord | undefined> }> {
    return this.#launch(name, ticket, signal);
  }

  async #launch(name: string, ticket: string, signal: AbortSignal | undefined): Promise<{ started: true; sha256: string; ended: Promise<CheckRecord | undefined> }> {
    const key = `${name}/${ticket}`;
    if (this.#running.has(key)) {
      throw new FactoryError('check_running', `A Task check of ${key} is already running.`);
    }
    // Reserved before the first await, so a second start meanwhile is check_running; released when
    // the setup fails or the check has ended.
    this.#running.add(key);
    if (signal === undefined) {
      for (const observer of this.#observers) {
        observer.manualStart?.(name, ticket);
      }
    }
    let workspace: Workspace;
    let task: string;
    try {
      workspace = await this.#options.resolve(name);
      task = await readTask(workspace, ticket);
      refuseDraft(ticket, task);
    } catch (error) {
      this.#end(key, name, ticket, false);
      throw error;
    }
    const ended = runTaskCheck(workspace, ticket, task, { ...this.#options, ...(signal !== undefined ? { signal } : {}) })
      .then(async (record) => {
        if (signal === undefined) {
          await this.store.write(record);
          return record;
        }
        // An automatic check: stored only when no cancel came before the commit.
        return (await this.store.writeUnless(record, signal)) === undefined ? undefined : record;
      })
      .catch((error: unknown) => {
        console.error(error);
        return undefined;
      })
      .finally(() => this.#end(key, name, ticket, true));
    return { started: true, sha256: await currentCheckSha256(workspace, ticket, task), ended };
  }

  // The ticket's check no longer runs: onSettled (when it ran) and the observers hear of it.
  #end(key: string, name: string, ticket: string, ran: boolean): void {
    this.#running.delete(key);
    if (ran) {
      this.#options.onSettled?.(name, ticket);
    }
    for (const observer of this.#observers) {
      observer.ended?.(name, ticket);
    }
  }

  async view(name: string, ticket: string): Promise<CheckView> {
    const workspace = await this.#options.resolve(name);
    const current = await currentTask(workspace, ticket);
    const check = (await this.store.last(name, ticket)) ?? null;
    const stale = check !== null && check.sha256 !== current?.sha256;
    let reason: string | null = null;
    if (current !== undefined && (check === null || stale)) {
      const need = checkNeed(current.text, name);
      if (!need.needed && (await this.store.read(name, ticket, current.sha256)) === undefined) {
        reason = need.reason;
      }
    }
    return { check, stale, running: this.isRunning(name, ticket), current_sha256: current?.sha256 ?? null, check_reason: reason };
  }

  // The board's summary of a ticket's last check against its current Task file; not_needed
  // when the view has a check_reason.
  async summary(name: string, ticket: string): Promise<CheckSummary> {
    const view = await this.view(name, ticket);
    if (view.check_reason !== null) {
      const summary = { state: 'not_needed', check_reason: view.check_reason, stale: false, running: view.running, blockers: 0, majors: 0, nits: 0, ended_at: null } as const;
      return { ...summary, start_note: startNote(summary) };
    }
    return checkSummary(view.check ?? undefined, view.current_sha256 ?? undefined, view.running);
  }

  // The check sha256 of the current Task file (taskCheckSha256) and its check, for task_check;
  // record undefined when this version has none.
  async current(name: string, ticket: string): Promise<{ sha256: string; record: CheckRecord | undefined }> {
    const workspace = await this.#options.resolve(name);
    const task = await readTask(workspace, ticket);
    const sha256 = await currentCheckSha256(workspace, ticket, task);
    return { sha256, record: await this.store.read(name, ticket, sha256) };
  }
}

const indent = (text: string, prefix: string): string[] => text.trimEnd().split(/\r?\n/).map((line) => `${prefix}${line}`);

// A check as sf check-task prints it: the paraphrase first, the findings by severity, the files and
// the verdict; a failed check with its error.
export function checkLines(record: CheckRecord): string[] {
  const head = `Task check of ${record.workspace}/${record.ticket} (${TASK_DIR}/${record.ticket}.md, sha256 ${checkId(record.sha256)}), model ${record.model ?? 'default'}`;
  if (record.status === 'failed' || record.output === null) {
    return [head, `Check failed: ${record.error ?? 'unknown error'}`, 'Verdict: failed (a failed check never counts as ready)'];
  }
  const { output } = record;
  const counts = severityCounts(output);
  const lines = [head, '', 'Paraphrase:', ...indent(output.paraphrase, '  '), '', 'Findings:'];
  for (const severity of SEVERITIES) {
    const items = output.findings.filter((item) => item.severity === severity);
    lines.push(`  ${severity} (${items.length})${items.length === 0 ? ': none' : ':'}`);
    for (const item of items) {
      lines.push(`    - [${item.kind}] ${item.where}: ${item.problem} Expected: ${item.expected}`);
    }
  }
  lines.push('', 'Files:', ...(output.files.length === 0 ? ['  none'] : output.files.map((file) => `  ${file.action} ${file.path}`)));
  lines.push('', `Verdict: ${output.verdict === 'ready' ? 'ready' : 'not ready'} (${counts.blocker} blocker, ${counts.major} major, ${counts.nit} nit)`);
  return lines;
}
