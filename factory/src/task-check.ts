// The Task check: before Start, a fresh, read-only Agent SDK query() reads the Task file, the
// Task files it builds on (builds_on, src/builds-on.ts) and the repository only, and says whether an
// Implementer could build it without a design decision of its own. It runs in a temporary detached
// worktree of the work checkout at the Task's base or at the prepared commit of the ticket it builds
// on, which has no .software-factory folder, and a PreToolUse hook refuses every Read, Grep or Glob
// that reaches outside that worktree and every other tool but the SDK's StructuredOutput. Its prompt holds the repository's and the user's
// coding rules read at the checkout's commit (src/rules-docs.ts), the list of the workspace's
// decision documents in that checkout (src/decisions.ts; prompt: src/prompts.ts), the Task files it builds on
// that are not merged (none when it reads such a prepared commit) and the Task file, and nothing of the Context owner's conversation, the jobs or the ledger; its output is a paraphrase first, then
// findings, the files it expects to change and a verdict. A check is stored by the sha256 that folds the Task file's images and
// chain in (taskCheckSha256), and counts while what it read of the ticket it builds on holds (CheckStore.read), under the state directory, never in the work checkout. It only advises: nothing here starts, refuses or changes
// a job. A Task not written by ChatGPT's write_task is read by Codex too, at the same time in the
// same checkout (src/task-check-codex.ts), and the record holds both checks. The checked Task text
// is kept beside its record, and an automatic re-check of a revised not_ready Task may start from the
// previous check's findings and the Task file's diff (a follow-up: followUpPlan, runTaskCheck).
import { createHash, randomUUID } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SandboxSettings, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { type BuildsOnRecord, buildsOnChain, buildsOnHolds, buildsOnTarget, chainLines, checkChain, type PreparedPoint, preparedPoint } from './builds-on.js';
import { attachmentReferences, imageHashes, type ImageRef, type ResolvedImage, resolveImages, writeImages } from './attachments.js';
import type { Config } from './config.js';
import { taskStartBranch } from './continues.js';
import { workspaceDecisionDocs } from './decisions.js';
import { FactoryError } from './errors.js';
import { tmpRoots } from './host-tmp.js';
import { Redactor } from './redact.js';
import { runGit } from './git.js';
import { resolveTarget } from './mr.js';
import { norms } from './norms.js';
import { checkPrompt } from './prompts.js';
import type { Workspace } from './registry.js';
import { runStructuredSession, SEVERITIES, SEVERITY_DEFINITIONS, type Severity } from './review.js';
import { collectRules } from './rules-docs.js';
import { matchesGlob, scopeOf } from './rules.js';
import { pathDenials, prepareTaskChecksDir, TASK_CHECK_DIR_UNSAFE } from './sandbox-denials.js';
import { roleSkillBlocks, type SkillNames } from './skills.js';
import { sliceFindings } from './slices.js';
import { checkDeniedRules, cutOutsideLinks, guardHooks } from './task-check-guard.js';
import { type CodexCheck, codexCheckDue, codexCheckLines, type CodexCheckSettings, runCodexCheck } from './task-check-codex.js';
import { movedIntoScope, scopeGlobs } from './task-check-recheck.js';
import { ARCHIVE_DIR, checkNeed, isDraft, mayTouch, parseFrontMatter, readTask, TASK_DIR, taskDiff, taskScope, TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';
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

// A follow-up check's output (see runTaskCheck): checkOutput plus, after the paraphrase, its answer
// on each previous finding (previous), and on each finding the previous finding it restates.
export const PREVIOUS_STATUSES = ['resolved', 'open'] as const;
export const previousAnswer = z.strictObject({
  id: z.string().describe('The previous finding\'s id: F1, F2, ...'),
  status: z.enum(PREVIOUS_STATUSES).describe('resolved: the current Task file resolves it, verified against the repository; open: it does not, or you cannot verify that it does.'),
  note: z.string().describe('Why: what in the current Task file resolves it, or what is still wrong.'),
});
export const followUpFinding = z.strictObject({
  ...checkFinding.shape,
  previous_id: z.string().nullable().describe('The F<n> of the previous finding this one restates, or null for a new finding.'),
});
export const followUpOutput = z.strictObject({
  paraphrase: checkOutput.shape.paraphrase,
  previous: z.array(previousAnswer).describe('One answer for each previous finding (F1, F2, ...).'),
  findings: z.array(followUpFinding),
  files: checkOutput.shape.files,
  verdict: checkOutput.shape.verdict,
});
export type PreviousAnswer = z.output<typeof previousAnswer>;
export type FollowUpOutput = z.output<typeof followUpOutput>;
const { $schema: _followUpDraft, ...followUpSchema } = z.toJSONSchema(followUpOutput, { target: 'draft-7' });
export const FOLLOW_UP_SCHEMA: Record<string, unknown> = followUpSchema;

// The verdict rule: ready when no finding is a blocker or major, whatever the checker wrote.
export function checkVerdict(findings: readonly CheckFinding[]): CheckVerdict {
  return findings.some((item) => item.severity !== 'nit') ? 'not_ready' : 'ready';
}

// A previous finding's id in a follow-up check: F1 for the first.
const previousId = (index: number): string => `F${index + 1}`;
const sameId = (given: string | null | undefined, id: string): boolean => given?.trim().toUpperCase() === id;

// The previous findings a follow-up check keeps as they were: each one it did not answer resolved
// (an answer open, or none) and restated under no finding's previous_id. An id answered both
// resolved and open counts as open.
export function openPrevious(output: CheckOutput | FollowUpOutput, previous: readonly CheckFinding[]): CheckFinding[] {
  const answers = 'previous' in output ? output.previous : [];
  return previous.filter((_item, index) => {
    const id = previousId(index);
    const mine = answers.filter((answer) => sameId(answer.id, id));
    const resolved = mine.length > 0 && mine.every((answer) => answer.status === 'resolved');
    const restated = output.findings.some((item: CheckFinding & { previous_id?: string | null }) => sameId(item.previous_id, id));
    return !resolved && !restated;
  });
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
// and the slice findings (src/slices.ts; maxFiles: the norm's slice.change_max_files) are added,
// and the verdict is the rule's. For a follow-up check (previous: the previous check's findings, in
// their order), every previous finding it keeps open (openPrevious) is added back unchanged after
// its own, unless the factory's scope or slice findings give the same one; previous_id is not kept.
export function settleCheck(task: string, output: CheckOutput | FollowUpOutput, maxFiles?: number, previous: readonly CheckFinding[] = []): CheckOutput {
  const own = output.findings.map(({ kind, severity, where, problem, expected }): CheckFinding => ({ kind, severity: kind === 'contradiction' ? 'blocker' : severity, where, problem, expected }));
  const kept = openPrevious(output, previous);
  const factory = [...scopeFindings(task, output.files, [...own, ...kept]), ...sliceFindings(task, output.files, maxFiles)];
  const same = (a: CheckFinding, b: CheckFinding): boolean => a.kind === b.kind && a.where === b.where && a.problem === b.problem;
  const findings = [...own, ...kept.filter((item) => !factory.some((other) => same(item, other))), ...factory];
  return { paraphrase: output.paraphrase, findings, files: output.files, verdict: checkVerdict(findings) };
}

// The sha256 of a Task file's text (UTF-8), as write_task reports it.
export const taskSha256 = (task: string): string => createHash('sha256').update(task, 'utf8').digest('hex');
// The sha256 a check of a Task file is stored and found by: taskSha256 of the text when
// it refers to no image and builds on nothing; otherwise the sha256 of the text, a newline and the sorted
// "<name>:<sha256>" lines of its referenced images ("<name>:missing" for one that cannot be read),
// then the lines of its builds_on chain in order (chainLines), so a changed image or a changed Task
// file in the chain makes the check stale.
export function taskCheckSha256(task: string, images: ReadonlyArray<{ name: string; sha256: string }>, chain: readonly string[] = []): string {
  if (images.length === 0 && chain.length === 0) {
    return taskSha256(task);
  }
  const lines = [...images.map((image) => `${image.name}:${image.sha256}`).sort(), ...chain];
  return createHash('sha256').update(`${task}\n${lines.join('\n')}`, 'utf8').digest('hex');
}

// The folder of a ticket's images in the work checkout; under archive/ for an archived Task file.
const imagesDir = (workspace: Workspace, ticket: string, archived = false): string =>
  join(workspace.workCheckout, TASK_DIR, ...(archived ? [ARCHIVE_DIR] : []), ticket);

// taskCheckSha256 of a Task text with its referenced images as they are in the folder now and the
// Task files of its builds_on chain as they are now.
export async function currentCheckSha256(workspace: Workspace, ticket: string, task: string, archived = false): Promise<string> {
  const references = attachmentReferences(ticket, task);
  const images = references.length === 0 ? [] : await imageHashes(imagesDir(workspace, ticket, archived), references);
  return taskCheckSha256(task, images, chainLines(await buildsOnChain(workspace, ticket, task)));
}

// The name of a check's file: the first 16 hex of the Task file's sha256.
export const checkId = (sha256: string): string => sha256.slice(0, 16);

// A stored check, by the sha256 that folds the Task file's images and builds_on chain in: the output
// (null when the check failed) or its redacted error, the commit it read: the Task's base, or the
// prepared commit of the ticket it builds on (null when it failed before), the model, the estimated cost and the times. ok checks
// have a verdict (its session's skills: SkillNames, the task_check role's); a failed one never counts as ready.
// builds_on: how the session's prompt used each Task file of the chain, when the Task has one; for a
// check that read the prepared commit of the ticket its Task builds on, that one entry (prepared,
// with the commit), on every record of it.
export interface CheckRecord extends SkillNames {
  workspace: string;
  ticket: string;
  sha256: string;
  builds_on?: BuildsOnRecord[];
  commit: string | null;
  status: 'checked' | 'failed';
  output: CheckOutput | null;
  error: string | null;
  model: string | null;
  cost_usd: number | null;
  started_at: string;
  ended_at: string;
  // The Codex check of the same run, when it was due (src/task-check-codex.ts): absent when Codex did
  // not check this version.
  codex?: CodexCheck;
  // How the Claude check ran: full, or follow_up of the previous check (see runTaskCheck), with that
  // record's sha256 and, once its session answered, its answer on each previous finding. A record
  // without mode counts as full.
  mode?: CheckMode;
  follow_up_of?: string;
  previous?: PreviousAnswer[];
}

export type CheckMode = 'full' | 'follow_up';

// One check's record and the Task text it checked (runTaskCheck), stored together (CheckStore.write).
export interface CheckRun {
  record: CheckRecord;
  task: string;
}

// <state>/checks/<ws>/<ticket>/<sha256, first 16 hex>.json, and the checked Task text beside it in
// <sha256, first 16 hex>.task.md (0600), read by the next check of the ticket (a follow-up's diff).
export class CheckStore {
  readonly root: string;
  readonly #stateDir: string;

  constructor(stateDir: string) {
    this.root = join(stateDir, 'checks');
    this.#stateDir = stateDir;
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

  // The path of the Task text a check read, beside its record.
  taskPath(workspace: string, ticket: string, sha256: string): string {
    return join(this.#dir(workspace, ticket), `${checkId(sha256)}.task.md`);
  }

  // The record and, when given, the Task text it checked (task, written first).
  async write(record: CheckRecord, task?: string): Promise<string> {
    const path = this.path(record.workspace, record.ticket, record.sha256);
    await mkdir(this.#dir(record.workspace, record.ticket), { recursive: true, mode: 0o700 });
    if (task !== undefined) {
      await writeFileAtomic(this.taskPath(record.workspace, record.ticket, record.sha256), Buffer.from(task, 'utf8'));
    }
    await writeFileAtomic(path, Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
    return path;
  }

  // The record of an automatic check and the Task text it checked (task, when given), unless signal
  // aborts first: complete temp files are written, then signal is looked at and the files renamed
  // into place in one synchronous step, so a cancel either comes before the commit (nothing stored,
  // the temp files go) or after it (the run had ended). Returns the path, or undefined when cancelled.
  async writeUnless(record: CheckRecord, signal: AbortSignal, task?: string): Promise<string | undefined> {
    const path = this.path(record.workspace, record.ticket, record.sha256);
    if (signal.aborted) {
      return undefined;
    }
    await mkdir(this.#dir(record.workspace, record.ticket), { recursive: true, mode: 0o700 });
    const files: Array<{ temp: string; target: string; text: string }> = [
      ...(task === undefined ? [] : [{ target: this.taskPath(record.workspace, record.ticket, record.sha256), text: task }]),
      { target: path, text: `${JSON.stringify(record, null, 2)}\n` },
    ].map((file) => ({ ...file, temp: `${file.target}.${randomUUID()}.tmp` }));
    try {
      for (const file of files) {
        const handle = await open(file.temp, 'wx', 0o600);
        try {
          await handle.writeFile(file.text);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      // No await between the look at signal and the renames: no cancel can come in between.
      if (signal.aborted) {
        return undefined;
      }
      for (const file of files) {
        renameSync(file.temp, file.target);
      }
      return path;
    } finally {
      for (const file of files) {
        rmSync(file.temp, { force: true });
      }
    }
  }

  // The Task text the record's check read, or undefined when it was not kept.
  async checkedTask(record: Pick<CheckRecord, 'workspace' | 'ticket' | 'sha256'>): Promise<string | undefined> {
    try {
      return await readFile(this.taskPath(record.workspace, record.ticket, record.sha256), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  // The check of the Task file with this sha256 while it counts (holds), or undefined.
  async read(workspace: string, ticket: string, sha256: string): Promise<CheckRecord | undefined> {
    const record = await readRecord(this.path(workspace, ticket, sha256));
    return record?.sha256 === sha256 && (await this.holds(record)) ? record : undefined;
  }

  // Whether the record still counts for its Task file's version: what its check read of the ticket
  // its Task builds on is what a check would read now (buildsOnHolds).
  holds(record: CheckRecord): Promise<boolean> {
    return buildsOnHolds(this.#stateDir, record.workspace, record.builds_on);
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

// What a stored check counts as: failed when the Claude check failed (never ready); not_ready when
// its Codex part gave an output that is not ready; else the Claude check's verdict. A failed Codex
// part holds nothing.
export const recordVerdict = (record: CheckRecord): CheckVerdict | 'failed' =>
  record.status === 'failed' || record.output === null ? 'failed' : record.codex?.output?.verdict === 'not_ready' ? 'not_ready' : record.output.verdict;

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

// The counts of a record's findings by severity: the Claude check's and its Codex part's, a Codex
// finding with the kind, where and problem of a Claude finding counted once.
export function recordCounts(record: CheckRecord): Record<Severity, number> {
  const counts = severityCounts(record.output);
  const claude = record.output?.findings ?? [];
  for (const item of record.codex?.output?.findings ?? []) {
    if (!claude.some((other) => other.kind === item.kind && other.where === item.where && other.problem === item.problem)) {
      counts[item.severity] += 1;
    }
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
  const counts = record === undefined ? severityCounts(null) : recordCounts(record);
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
  // The Codex check's settings; absent: no Codex check (SF_TASK_CHECK_CODEX=off).
  codex?: CodexCheckSettings;
  // Whether this check may be a follow-up (followUpPlan): SF_TASK_CHECK_FOLLOW_UP=on, and an
  // automatic check (TaskChecks.startAuto); a manual check is always full.
  followUp?: boolean;
  signal?: AbortSignal;
  // Every SDK message of the session, in order; a failing call changes nothing of the outcome.
  onMessage?: (message: SDKMessage) => Promise<void>;
}

// The path guard of the check's session and its worktree's link cut (src/task-check-guard.ts).
export { braceAlternatives, checkDeniedRules, cutOutsideLinks, guardHooks, guardReason, OUTSIDE_LINK_NOTE } from './task-check-guard.js';

// The check's checkout: a detached worktree of the work checkout at the Task's base, or its
// continues (fetched from origin when there is one, as Start does), or at the prepared commit,
// nothing fetched; one the checkout does not have fails (base_not_found). It is made in a new
// directory check-* under the Task checks' parent directory (<tmp>/sf-task-checks-<uid>, which
// every other session denies; an unsafe one fails the check with task_check_dir_unsafe), with its
// symbolic links out of it cut (cutOutsideLinks). remove() takes it away and prunes its registration.
async function checkCheckout(checkout: string, task: string, prepared?: PreparedPoint): Promise<{ root: string; commit: string; remove: () => Promise<void> }> {
  const base = taskStartBranch(parseFrontMatter(task));
  if (base === '' || base.startsWith('-') || (await runGit(checkout, ['check-ref-format', '--branch', base])).code !== 0) {
    throw new FactoryError('base_not_found', `The base "${base}" is not a valid branch name.`);
  }
  const { commit } = prepared === undefined ? await resolveTarget(checkout, base) : await buildsOnTarget(checkout, prepared);
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

// The most a follow-up check's diff may change: added plus removed lines, as a share of the lines of
// the text the previous check read.
export const FOLLOW_UP_MAX_CHANGED = 0.4;

// The lines added plus removed in a unified diff (its --- and +++ header lines left out).
export function changedLineCount(diff: string): number {
  let count = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && (line.startsWith('+') || line.startsWith('-'))) {
      count += 1;
    }
  }
  return count;
}

// The lines of a text, a final newline ending the last one.
const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

// What a follow-up check starts from: the previous record, its findings and the diff of the Task
// text it read to the current one.
export interface FollowUpPlan {
  of: CheckRecord;
  findings: CheckFinding[];
  diff: string;
}

// Whether the check of task (its check sha256 folding in chain, the current chainLines; reading the
// checkout at commit) is a follow-up of the ticket's previous check, and what it starts from; undefined
// for a full check. A follow-up only when all of these hold:
// - the newest stored record of the ticket is a completed Claude check (not failed) whose verdict is
//   not_ready, and the Task text it read was kept (CheckStore.checkedTask);
// - that text, with its images as they are now and the current chain lines, gives that record's
//   sha256: the builds_on chain (and the images it refers to) did not change;
// - its commit is commit, or the commits in between touch none of the Task's scope or may_touch
//   paths (movedIntoScope, src/task-check-recheck.ts);
// - the added plus removed lines of the unified diff (taskDiff) are at most FOLLOW_UP_MAX_CHANGED of
//   the old text's lines, and the texts differ;
// - the newest two records are not both follow-ups: after two in a row the next check is full.
// Never throws: anything it cannot read or decide makes the check full.
export async function followUpPlan(store: CheckStore, workspace: Workspace, ticket: string, task: string, chain: readonly string[], commit: string): Promise<FollowUpPlan | undefined> {
  try {
    const records = await store.records(workspace.name, ticket);
    const of = records.at(-1);
    if (of === undefined || of.status !== 'checked' || of.output === null || of.output.verdict !== 'not_ready') {
      return undefined;
    }
    if (records.length >= 2 && records.slice(-2).every((record) => record.mode === 'follow_up')) {
      return undefined;
    }
    const old = await store.checkedTask(of);
    if (old === undefined) {
      return undefined;
    }
    const references = attachmentReferences(ticket, old);
    const images = references.length === 0 ? [] : await imageHashes(imagesDir(workspace, ticket), references);
    if (taskCheckSha256(old, images, chain) !== of.sha256) {
      return undefined;
    }
    const fields = parseFrontMatter(task) ?? new Map<string, string>();
    if (await movedIntoScope(workspace.workCheckout, of.commit, commit, scopeGlobs(fields))) {
      return undefined;
    }
    const diff = await taskDiff(ticket, old, task);
    if (diff === undefined || changedLineCount(diff) > FOLLOW_UP_MAX_CHANGED * lineCount(old)) {
      return undefined;
    }
    return { of, findings: of.output.findings, diff };
  } catch (error) {
    console.error(`warning: the Task check of ${workspace.name}/${ticket} is full: its follow-up could not be prepared: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

// Runs one check of the given Task text in its own worktree of the work checkout at the Task's
// base, and returns its record with the text it checked. Never throws: a checkout that cannot be
// made or a failed session is a failed record, its error redacted like a failed review's. The
// worktree is removed afterwards.
//
// With options.followUp, the check is a follow-up when followUpPlan says so: its prompt is the full
// prompt with the previous findings and the Task file's diff (checkPrompt), its schema
// FOLLOW_UP_SCHEMA, and every previous finding it keeps open stays in its findings (settleCheck). Its
// tools, model, turns and hooks are a full check's. The Codex check always gets the full prompt and
// CHECK_SCHEMA.
export async function runTaskCheck(workspace: Workspace, ticket: string, task: string, options: CheckOptions): Promise<CheckRun> {
  return { record: await checkRecordOf(workspace, ticket, task, options), task };
}

async function checkRecordOf(workspace: Workspace, ticket: string, task: string, options: CheckOptions): Promise<CheckRecord> {
  const startedAt = new Date().toISOString();
  // The chain of Tasks it builds on, read once from the Task files (never throws).
  const chain = await buildsOnChain(workspace, ticket, task);
  // The prepared commit of the ticket it builds on, which the check reads in place of the chain's
  // Task files, and its entry on every record of the run (never throws).
  const prepared = await preparedPoint(options.stateDir, workspace, task);
  const reading = prepared === undefined ? {} : { builds_on: [{ ticket: prepared.ticket, sha256: chain.tasks[0]?.sha256 ?? null, how: 'prepared', commit: prepared.commit } satisfies BuildsOnRecord] };
  // The referenced images, read by the factory from the work checkout's folder: the
  // session may not read .software-factory/. One that cannot be used fails the check; no session runs.
  const references = attachmentReferences(ticket, task);
  let images: ResolvedImage[];
  try {
    images = references.length === 0 ? [] : await resolveImages(imagesDir(workspace, ticket), ticket, references);
  } catch (error) {
    const message = error instanceof FactoryError ? error.message : 'The Task file\'s images could not be read.';
    return {
      workspace: workspace.name, ticket, sha256: taskCheckSha256(task, await imageHashes(imagesDir(workspace, ticket), references), chainLines(chain)), ...reading, commit: null, status: 'failed', output: null,
      error: message, model: options.model ?? null, cost_usd: null, started_at: startedAt, ended_at: new Date().toISOString(), mode: 'full',
    };
  }
  const lines = chainLines(chain);
  // A check that fails before its follow-up was decided is full.
  const fullRecord = { workspace: workspace.name, ticket, sha256: taskCheckSha256(task, images, lines), ...reading, mode: 'full' as CheckMode };
  let checkout: Awaited<ReturnType<typeof checkCheckout>>;
  try {
    checkout = await checkCheckout(workspace.workCheckout, task, prepared);
  } catch (error) {
    const unsafe = error instanceof FactoryError && error.code === TASK_CHECK_DIR_UNSAFE ? `${TASK_CHECK_DIR_UNSAFE}: ` : '';
    const message = `${unsafe}The check could not prepare its checkout: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ...fullRecord, commit: null, status: 'failed', output: null, error: new Redactor({ cwd: workspace.workCheckout }).failure(message.slice(0, 1000)),
      model: options.model ?? null, cost_usd: null, started_at: startedAt, ended_at: new Date().toISOString(),
    };
  }
  try {
    const cwd = checkout.root;
    // A follow-up of the previous check (followUpPlan), when allowed and due; else full.
    const plan = options.followUp === true ? await followUpPlan(new CheckStore(options.stateDir), workspace, ticket, task, lines, checkout.commit) : undefined;
    const record = plan === undefined ? fullRecord : { ...fullRecord, mode: 'follow_up' as CheckMode, follow_up_of: plan.of.sha256 };
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
    // The Task files of the chain not merged yet, for the prompt; a chain that cannot be used fails
    // the check before any session (its message holds ticket keys only). None at a prepared commit.
    const sent = prepared === undefined ? await checkChain(options.stateDir, workspace, ticket, chain) : { chain: [], record: [] };
    if ('error' in sent) {
      return failed(sent.error);
    }
    let rules: string;
    try {
      rules = (await collectRules(workspace.workCheckout, checkout.commit, { workspace: workspace.name, skip: workspace.rulesSkip ?? [], configDir: options.configDir, maxBytes: options.rulesMaxBytes })).block;
    } catch (error) {
      return failed(redactor.failure(`The check could not collect the coding rules: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000)));
    }
    if (options.signal?.aborted === true) {
      return failed('The check was cancelled.');
    }
    // The paths off limits to every session, but the Task checks' parent directory the check runs in: on top of checkDeniedRules for the tools, and for the sandbox, with the session's
    // temporary folder and the check's own folder (not its siblings) kept. The check's own guard (guardHooks) holds the tools, not the job's. Its skills: the choice and the link now;
    // the workspace's decision documents: listed in the check's checkout, at the Task's base.
    let outcome: Awaited<ReturnType<typeof runStructuredSession<CheckOutput | FollowUpOutput>>>;
    const skills = await roleSkillBlocks(options.stateDir, 'task_check');
    const signal = options.signal ?? new AbortController().signal;
    // norms never throws: a bad or missing norms.json is the defaults.
    const maxFiles = (await norms(workspace.name, options.configDir)).norms.slice.change_max_files;
    // The Codex check, when due, runs beside the session; it never throws, and every way out of the
    // block below waits for it, so the checkout outlives it.
    let codex: Promise<CodexCheck> | undefined;
    try {
      const decisions = await workspaceDecisionDocs(workspace.name, cwd, options.configDir);
      // The full prompt, Codex's always; the follow-up's adds the previous findings and the diff.
      const fullPrompt = checkPrompt(ticket, task, rules, skills.text, decisions, sent.chain, prepared);
      const prompt = plan === undefined ? fullPrompt : checkPrompt(ticket, task, rules, skills.text, decisions, sent.chain, prepared, { findings: plan.findings, diff: plan.diff });
      const due = options.codex === undefined ? { due: false as const } : await codexCheckDue(options.stateDir, workspace.name, ticket, task);
      if (due.due) {
        codex = runCodexCheck(fullPrompt, options.codex!, {
          workspace, root: cwd, images: refs.map((ref) => ref.path), stateDir: options.stateDir, worktreeRoot: options.worktreeRoot, configDir: options.configDir,
          sandbox: options.sandbox !== undefined, signal, reason: due.reason, schema: CHECK_SCHEMA, output: checkOutput,
        });
      }
      outcome = await runStructuredSession(prompt, {
        cwd, claudePath: options.claudePath, sandbox: options.sandbox, model: options.model, maxTurns: options.maxTurns,
        pathDenials: async (sessionTmp) => ({ ...(await pathDenials({ session: 'task_check', workspace: workspace.name, checkout: workspace.workCheckout, sessionTmp,
          checkFolder: dirname(cwd), stateDir: options.stateDir, worktreeRoot: options.worktreeRoot, configDir: options.configDir })), hooks: undefined }),
        signal, images: refs,
        // Every message passes the redactor, so a failure after a withheld read is withheld too.
        onMessage: async (message) => {
          redactor.reviewMessage(message);
          await options.onMessage?.(message);
        },
      }, {
        ...(plan === undefined ? { schema: CHECK_SCHEMA, output: checkOutput } : { schema: FOLLOW_UP_SCHEMA, output: followUpOutput }), noun: 'check', outputNoun: 'output',
        deny: checkDeniedRules(workspace.workCheckout, options.stateDir, options.configDir), hooks: guardHooks(cwd, await tmpRoots()),
      });
    } catch (error) {
      await codex;
      // Only the path denials throw (runStructuredSession).
      return failed(redactor.failure(`The check could not build its path denials: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000)));
    }
    // The Codex part, its output settled by the factory's rules as the Claude check's.
    const part = await codex;
    const codexKey = part === undefined ? {} : { codex: part.output === null ? part : { ...part, output: settleCheck(task, part.output, maxFiles) } };
    const base = { ...record, ...(sent.record.length > 0 ? { builds_on: sent.record } : {}), ...skills.names, commit: checkout.commit, model: outcome.model ?? options.model ?? null, started_at: startedAt, ended_at: outcome.endedAt, ...codexKey };
    if (!outcome.ok) {
      return { ...base, status: 'failed', output: null, error: redactor.failure(outcome.message), cost_usd: null };
    }
    const previous = plan !== undefined && 'previous' in outcome.output ? { previous: outcome.output.previous } : {};
    return { ...base, ...previous, status: 'checked', output: settleCheck(task, outcome.output, maxFiles, plan?.findings), error: null, cost_usd: outcome.costUsd };
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
// turn limit and the directories off limits; with SF_TASK_CHECK_CODEX=auto, the Codex check's from
// the gate's; followUp: SF_TASK_CHECK_FOLLOW_UP (TaskChecks uses it for its automatic checks only).
export function checkSettings(config: Config, configDir: string): Omit<CheckOptions, 'signal' | 'onMessage'> {
  return {
    claudePath: config.claudePath, sandbox: config.sandbox, model: config.reviewModel, maxTurns: config.taskCheckMaxTurns, rulesMaxBytes: config.rulesMaxBytes,
    stateDir: config.stateDir, configDir, worktreeRoot: config.worktreeRoot, followUp: config.taskCheckFollowUp === true,
    ...(config.taskCheckCodex === 'auto' ? { codex: { gate: config.gate, model: config.codexModel, timeoutMs: config.gateTimeoutMs, maxTokens: config.gateMaxTokens } } : {}),
  };
}

export interface TaskChecksOptions extends Omit<CheckOptions, 'signal' | 'onMessage'> {
  resolve: (name: string) => Promise<Workspace>;
  // Called when a check started by start() or startAuto() has been stored (or has failed to be),
  // or was cancelled: settled.record is the stored record (undefined when none was), settled.auto
  // whether startAuto started it.
  onSettled?: (workspace: string, ticket: string, settled: Settled) => void;
}

// How a check of TaskChecks ended, for onSettled.
export interface Settled {
  record: CheckRecord | undefined;
  auto: boolean;
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
      this.#end(key, name, ticket, undefined);
      throw error;
    }
    // A manual check is always full; an automatic one may be a follow-up when the setting allows it.
    const ended = runTaskCheck(workspace, ticket, task, { ...this.#options, followUp: this.#options.followUp === true && signal !== undefined, ...(signal !== undefined ? { signal } : {}) })
      .then(async (run) => {
        if (signal === undefined) {
          await this.store.write(run.record, run.task);
          return run.record;
        }
        // An automatic check: stored only when no cancel came before the commit.
        return (await this.store.writeUnless(run.record, signal, run.task)) === undefined ? undefined : run.record;
      })
      .catch((error: unknown) => {
        console.error(error);
        return undefined;
      })
      .then((record) => {
        this.#end(key, name, ticket, { record, auto: signal !== undefined });
        return record;
      });
    return { started: true, sha256: await currentCheckSha256(workspace, ticket, task), ended };
  }

  // The ticket's check no longer runs: onSettled (when it ran: settled) and the observers hear of it.
  #end(key: string, name: string, ticket: string, settled: Settled | undefined): void {
    this.#running.delete(key);
    if (settled !== undefined) {
      this.#options.onSettled?.(name, ticket, settled);
    }
    for (const observer of this.#observers) {
      observer.ended?.(name, ticket);
    }
  }

  async view(name: string, ticket: string): Promise<CheckView> {
    const workspace = await this.#options.resolve(name);
    const current = await currentTask(workspace, ticket);
    const check = (await this.store.last(name, ticket)) ?? null;
    const stale = check !== null && (check.sha256 !== current?.sha256 || !(await this.store.holds(check)));
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
    // A stale view's check counts as one of another version.
    return checkSummary(view.check ?? undefined, view.stale ? undefined : view.current_sha256 ?? undefined, view.running);
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

// A check as sf check-task prints it: the paraphrase first, the findings by severity, the files, the
// Codex part when there is one, and the record's verdict and counts; a failed check with its error.
export function checkLines(record: CheckRecord): string[] {
  const head = [
    `Task check of ${record.workspace}/${record.ticket} (${TASK_DIR}/${record.ticket}.md, sha256 ${checkId(record.sha256)}), model ${record.model ?? 'default'}`,
    ...(record.builds_on === undefined ? [] : [`Builds on: ${record.builds_on.map((item) => (item.how === 'prepared' ? `${item.ticket} (prepared ${item.commit.slice(0, 12)})` : `${item.ticket} (${item.how === 'left_out' ? 'left out' : item.how})`)).join(', ')}`]),
  ];
  if (record.status === 'failed' || record.output === null) {
    return [...head, `Check failed: ${record.error ?? 'unknown error'}`, 'Verdict: failed (a failed check never counts as ready)'];
  }
  const { output } = record;
  const counts = recordCounts(record);
  const lines = [...head, '', 'Paraphrase:', ...indent(output.paraphrase, '  '), '', 'Findings:'];
  for (const severity of SEVERITIES) {
    const items = output.findings.filter((item) => item.severity === severity);
    lines.push(`  ${severity} (${items.length})${items.length === 0 ? ': none' : ':'}`);
    for (const item of items) {
      lines.push(`    - [${item.kind}] ${item.where}: ${item.problem} Expected: ${item.expected}`);
    }
  }
  lines.push('', 'Files:', ...(output.files.length === 0 ? ['  none'] : output.files.map((file) => `  ${file.action} ${file.path}`)));
  lines.push(...codexCheckLines(record.codex));
  lines.push('', `Verdict: ${recordVerdict(record) === 'ready' ? 'ready' : 'not ready'} (${counts.blocker} blocker, ${counts.major} major, ${counts.nit} nit)`);
  return lines;
}
