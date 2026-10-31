// SF-006 execution adapter: the trusted, operator-started host side that takes
// one OpenClaw-accepted job into its configured application repository, runs
// the native Claude Code /implement session there and brings reviewable
// results back to the mediator job directory.
//
// State lives in <job dir>/execution.json, separate from the SF-005 acceptance
// files, which are only read. States:
//   prepared          acceptance verified, instruction copied and verified
//   running           a Claude session was started (session id, pid recorded)
//   pending_manual    handed to the operator to start in Claude Code by hand
//   completed         the session ended normally and the operator confirmed
//                     /implement finished; the transcript shows /implement with
//                     this instruction in the app repository; HEAD and index are
//                     unchanged; the results were exported
//   failed            non-zero exit, /implement not shown, HEAD/index changed, runner error
//   interrupted       a signal, an unconfirmed end, or the adapter stopped meanwhile
//   needs_inspection  results were not safe to export, or could not be collected,
//                     or the hand-over to Claude Code could not be confirmed
// A job launches at most once: launch.claim is created exclusively before any
// session starts and is never removed.
// One session at a time on this host (SF-007 Review 01): run takes the host-wide
// session gate (an OS lock, see session-gate.ts) before claiming the job and
// hands it to the Claude process, which holds it until it (and any process it
// started that kept the lock) ends. A busy gate leaves the job prepared and
// unclaimed. A session started by hand is gated only when it is started with the
// flock(1)-wrapped command that handoff returns (gated_command); otherwise it is
// found only while its process runs with the recorded session id in its command
// line (handed off or resumed), and run, handoff and preflight refuse meanwhile.
// A hand-started session without that id is not counted (documented constraint).
//
// Self-hosting (SF-009, the operator's separate opt-in, executor/policy.ts): one app may use the
// mediator checkout itself, where the operator keeps uncommitted work. For that app only, prepare
// accepts a repository with uncommitted changes and records a verified baseline of them instead:
// the content fingerprint of every path whose state differs from HEAD, kept privately next to the
// app's .env (.env.sf006-preexisting-<job>) and bound by its sha256 in execution.json. The launch
// requires the tree to still be exactly that baseline; every export then leaves the unchanged
// pre-existing paths out and names those the session changed, reverted or removed. Nothing is
// copied, stashed, restored or committed: the existing work stays where it is. Every other app
// still needs a clean repository (repo_dirty).
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { checkAcceptedReceipt, readDispatchRecord } from '../dispatch.js';
import { APPS_PATH, FactoryJobError, FactoryJobs, ID_PATTERN, readJobFile, writeJobFile, type JobDir } from '../factory-jobs.js';
import { INSTRUCTION_FILE, MAX_INSTRUCTION_BYTES } from '../instruction-store.js';
import type { ReceiverRecord } from '../openclaw-channel.js';
import { isForbidden } from '../repo-files.js';
import { AppConfigError, inspectorOptions, loadAppConfig, type AppConfig, type SelfHostingGrant } from './app-config.js';
import { ExecutionError } from './errors.js';
import { ADAPTER_DIR, contentFingerprint, GitInspector, MAX_BASELINE_PATHS, type ChangeSet, type GitSnapshot, type InspectorOptions, type PreexistingWork } from './git-state.js';
import { acquireLock, identify, isAlive, sessionProcessesRunning, sessionProcessRunning } from './process-identity.js';
import { describeHolder } from './session-gate.js';
import { claudeArguments, type ClaudeRunner, type ManagedProcess, type ReservedLaunch, type SessionExit } from './runner.js';
import { readSessionEvidence, type SessionEvidence } from './transcript.js';

export const EXECUTION_FILE = 'execution.json';
export const EXECUTION_SCHEMA = 'software-factory.execution/v1';
// The private ignored-file baseline of a job, next to the app's .env (see #writePrivateBaseline).
export const privateBaselineName = (jobId: string): string => `.env.sf006-ignored-${jobId}`;
// Self-hosting: the private baseline of the uncommitted work that existed before the job.
export const preexistingBaselineName = (jobId: string): string => `.env.sf006-preexisting-${jobId}`;
const MAX_LISTED_PREEXISTING = 100;
const CLAIM_FILE = 'launch.claim';
const ARTIFACT_FILES = ['implementation.diff', 'new-files.md', 'checks.md', 'report.md'];
const MAX_PRIVATE_BYTES = 16 * 1024 * 1024;
const SKILL = 'implement';
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_EXPORT_FILES = 1000;
const MAX_COMMANDS = 200;
const MAX_LISTED_PATHS = 100;
const MAX_IGNORED = 2000;
const MAX_MESSAGE_CHARS = 4000;
// Bounds of the scan for live hand-started sessions; beyond them launches are refused.
const MAX_SCAN_APPS = 1000;
const MAX_SCAN_JOBS = 100_000;
// Common credential shapes. Not a general secret detector: a hit stops the export for operator inspection.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
];

export const instructionDestination = (jobId: string): string => `${ADAPTER_DIR}/jobs/${jobId}/instruction.md`;
const sessionName = (appId: string, jobId: string): string => `sf-${appId}-${jobId}`;
const prompt = (jobId: string): string => `/${SKILL} ${instructionDestination(jobId)}`;

export const STATES = ['prepared', 'running', 'pending_manual', 'completed', 'failed', 'interrupted', 'needs_inspection'] as const;
export type ExecutionState = (typeof STATES)[number];

type OutcomeCode =
  | 'runner_failed'
  | 'adapter_interrupted'
  | 'claude_signal'
  | 'claude_exit'
  | 'not_confirmed'
  | 'transcript_missing'
  | 'skill_not_invoked'
  | 'git_changed'
  | 'export_withheld'
  | 'collect_failed'
  | 'artifacts_failed'
  | 'launch_unconfirmed'
  | 'session_not_ended'
  | 'acceptance_drift';

const errorSchema = z.strictObject({ code: z.string(), message: z.string() });
const gitSchema = z.strictObject({
  head: z.string().nullable(),
  index_sha256: z.string(),
  changed_paths: z.array(z.string()),
});
// The private ignored-file baseline (.env.sf006-ignored-<job>). complete is required:
// it is the evidence that the scan finished, and only true supports an export.
const privateBaselineSchema = z.strictObject({
  entries: z.array(z.string()),
  credentials: z.record(z.string(), z.string()),
  complete: z.boolean(),
});
// The private pre-existing work baseline (.env.sf006-preexisting-<job>): the HEAD and index it was
// taken against and each path's content fingerprint (git-state.ts, preexisting). On disk the
// entries are [path, fingerprint] pairs in path order, never an object keyed by path: a key such
// as __proto__ would be lost on creation and when parsed. A repeated path makes the file invalid.
const preexistingFileSchema = z.strictObject({
  schema: z.literal('software-factory.preexisting-work/v2'),
  head: z.string().nullable(),
  index_sha256: z.string(),
  entries: z.array(z.tuple([z.string(), z.string()])).max(MAX_BASELINE_PATHS),
});
interface PreexistingBaseline {
  head: string | null;
  index_sha256: string;
  entries: PreexistingWork;
}
// The historical ignored_initial field of records written before Review 02. It is
// validated (records and the legacy audit) but never used as a baseline.
// JSON.parse makes "__proto__" an own key, but zod drops it silently instead of
// rejecting it. A parsed baseline is accepted only when it kept every own key of
// the raw object, its credential map included.
export function keptEveryKey(raw: unknown, parsed: { credentials: Record<string, string> }): boolean {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const credentials = (raw as { credentials?: unknown }).credentials;
  return (
    Object.keys(raw).every((key) => ['entries', 'credentials', 'complete'].includes(key)) &&
    credentials !== null &&
    typeof credentials === 'object' &&
    Object.keys(credentials).length === Object.keys(parsed.credentials).length
  );
}

export const legacyIgnoredSchema = z.strictObject({
  entries: z.array(z.string()),
  credentials: z.record(z.string(), z.string()),
  // Absent in records written before the ignored directories were walked.
  complete: z.boolean().optional(),
});
const sessionSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  // managed: an SF-009 supervisor session (stream-json, auto permission mode).
  mode: z.enum(['interactive', 'manual', 'managed']),
  runner: z.string(),
  pid: z.number().int().optional(),
  pid_start: z.string().optional(),
  boot_id: z.string().optional(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
});
const recordSchema = z.strictObject({
  schema: z.literal(EXECUTION_SCHEMA),
  app_id: z.string(),
  job_id: z.string(),
  request_id: z.string(),
  instruction_sha256: z.string(),
  instruction_bytes: z.number().int(),
  state: z.enum(STATES),
  revision: z.number().int().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  destination: z.string(),
  acceptance: z.strictObject({ openclaw_run_id: z.string(), automation_id: z.string(), receiver_accepted_at: z.string() }),
  checks: z.array(z.strictObject({ at: z.string(), check: z.string(), ok: z.boolean() })),
  git_initial: gitSchema,
  // Self-hosting only: the pre-existing work baseline, by its path count and the sha256 of its file.
  preexisting: z.strictObject({ paths: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
  // Before Review 02 the ignored-file baseline was kept here; now it is private (#privateBaseline).
  ignored_initial: legacyIgnoredSchema.nullable(),
  ignored_summary: z.strictObject({ entries: z.number().int(), credentials: z.number().int(), complete: z.boolean() }).nullable().optional(),
  git_final: gitSchema.nullable(),
  session: sessionSchema.nullable(),
  // SF-009: every session id started under this job's one launch.claim (a context reset starts a
  // fresh process with a new id). session.id stays the claimed, first one.
  session_lineage: z.array(z.uuid()).max(64).optional(),
  completion: z.enum(['observed_exit', 'operator_confirmed']).nullable(),
  evidence: z
    .strictObject({ transcript_found: z.boolean(), skill_invoked: z.boolean(), args_match: z.boolean(), cwd_match: z.boolean() })
    .nullable(),
  artifacts: z.record(z.string(), z.string()),
  error: errorSchema.nullable(),
  recovery: z.string().nullable(),
  history: z.array(z.strictObject({ state: z.enum(STATES), at: z.string() })),
});
type ExecutionRecord = z.infer<typeof recordSchema>;
type SessionRecord = z.infer<typeof sessionSchema>;
type GitRecord = z.infer<typeof gitSchema>;
type PrivateBaseline = z.infer<typeof privateBaselineSchema>;

export interface ExecutionView {
  app_id: string;
  job_id: string;
  state: ExecutionState;
  destination: string;
  session_id: string | null;
  error: { code: string; message: string } | null;
  recovery: string | null;
}

export interface PreflightReport {
  ready: boolean;
  state: ExecutionState | 'accepted' | 'not_started';
  checks: Array<{ name: string; ok: boolean; code?: string; detail: string }>;
}

// What an SF-007 operator approval was given for. prepare and run compare it with the
// freshly verified acceptance and the resolved app repository inside the job lock.
export interface ApprovedJob {
  requestId: string;
  instructionSha256: string;
  // sha256 of the real path of APP_REPO (the path itself is not stored with the approval).
  appRepoSha256: string;
}

// SF-009: what a managed session's working tree holds now, against the job's baseline, with the
// SF-006 export filters applied (credential-style paths, ignored credential files, conversions,
// limits, credential-like text, the host path). Nothing here changes any state.
export interface IterationInspection {
  baseline: { head: string | null; index_sha256: string };
  head: string | null;
  index_sha256: string;
  // HEAD or the Git index differ from the baseline (staging or commits).
  git_changed: boolean;
  // Why nothing is exportable, or null.
  withheld: string | null;
  diff: string;
  changed_paths: string[];
  new_files: Array<{ path: string; bytes: number; sha256: string; note: string }>;
  // Shell commands of the current session's transcript (ok/error), filtered as in checks.md.
  commands: Array<{ command: string; ok: boolean }>;
  message: string | null;
  // Self-hosting only: the existing uncommitted work, against its baseline.
  preexisting?: PreexistingSummary;
}

// How the existing uncommitted work of a self-hosted job stands: how many paths it had, how many
// are unchanged (left out of the diff), and those the session changed or reverted/removed.
export interface PreexistingSummary {
  paths: number;
  untouched: number;
  changed: string[];
  removed: string[];
  changed_more: number;
  removed_more: number;
}

export interface ManagedSessionHandle {
  sessionId: string;
  process: ManagedProcess;
}

// Handed to the SF-009 supervisor for the life of one managed session, inside the job lock.
export interface ManagedControl {
  // The id launch.claim was created for: the first of the lineage.
  readonly claimedSessionId: string;
  // The application repository (host-local; never exported).
  readonly repo: string;
  // How the repository is inspected (a self-hosted app leaves out the mediator's own state).
  readonly git?: InspectorOptions;
  current(): ManagedSessionHandle;
  inspect(): Promise<IterationInspection>;
  // Context reset: ends the current process (verified), takes the session gate again and starts a
  // fresh process with a new session id under the same claim. Throws session_busy when the gate
  // cannot be taken again (nothing is started then), still_running when the old process could not
  // be shown to have ended.
  replace(): Promise<ManagedSessionHandle>;
  // Writes a new file next to the instruction copy (.software-factory/jobs/<job>/<name>), never replacing one.
  writeAdapterFile(name: string, content: Buffer): Promise<string>;
}

// SF-009 Review 01: what the operator's final acceptance approved. After the managed process has
// ended, the tree is compared with it before and after the export, and the exported diff with the
// diff the reviewer saw. Any difference is drift: the job needs inspection, never "completed".
export interface ApprovedTree {
  // True while the application repository still has the accepted snapshot's full tree identity
  // (HEAD, index, Git control files, every working-tree change and ignored credential files).
  unchanged(): Promise<boolean>;
  // sha256 of the accepted snapshot's exported diff; null when that export was withheld.
  diffSha256: string | null;
  // Waits (bounded) for the session's background processes known at the acceptance to end; false
  // when one still runs. Called after the Claude process ended, before the first comparison.
  quiesce(): Promise<boolean>;
  // Review 02 (R2-2): null when no process of the session runs now (no wait), else what runs
  // (counts and command names). Checked again after the result files were written, right before
  // a successful state is persisted.
  busy(): Promise<string | null>;
}

// accepted: the operator's final acceptance of one snapshot; ended: anything else (exit, conflict,
// shutdown). urgent: the process must not finish its turn (e.g. it is not in auto mode): signalled at once.
export type ManagedEnding = { kind: 'accepted'; approved: ApprovedTree } | { kind: 'ended'; urgent?: boolean };

export interface ExecutionDeps {
  // Mediator repository root (resolved).
  mediatorRoot: string;
  // The OpenClaw receiver's own accepted record, read through a fixed read-only command.
  receiverLookup: (requestId: string) => Promise<ReceiverRecord | undefined>;
  runner: ClaudeRunner;
  // Claude Code's transcript directory and configuration directory (personal skills).
  claudeProjectsDir: string;
  claudeConfigDir: string;
  authStatus: () => Promise<{ loggedIn: boolean; method: string | null }>;
  // True when the adapter itself runs inside a Claude Code session (CLAUDE_CODE_CHILD_SESSION).
  insideClaudeSession: boolean;
  // SF-009 self-hosting: the operator's opt-in, read afresh for every use (a disable takes effect at
  // once). Absent (SF-006 CLI, SF-007 console): the mediator repository is refused, as before.
  selfHosting?: () => Promise<SelfHostingGrant | undefined>;
  // SF-009: how long a managed process gets to end after its stdin closed, before SIGTERM (default 30 s).
  managedStopMs?: number;
  // Test seam only (fault injection; production never sets it): runs after a managed process ended
  // and before its results are collected.
  beforeManagedCollect?: () => Promise<void>;
  // Test seam only, like beforeManagedCollect: runs after an accepted session's result files were
  // written and before its outcome is persisted in execution.json.
  afterArtifactsWritten?: () => Promise<void>;
}

interface Accepted {
  requestId: string;
  sha256: string;
  instruction: Buffer;
  acceptance: ExecutionRecord['acceptance'];
}

interface Outcome {
  state: ExecutionState;
  completion: ExecutionRecord['completion'];
  error: { code: OutcomeCode; message: string } | null;
  recovery: string | null;
}

interface ExportResult {
  // Why the changes were not exported, or null when they are exportable.
  withheld: string | null;
  diff: string;
  changedPaths: string[];
  newFiles: Array<{ path: string; bytes: number; sha256: string; note: string }>;
  newIgnored: string[];
  commands: Array<{ command: string; ok: boolean }>;
  moreCommands: number;
  message: string | null;
  preexisting?: PreexistingSummary;
}

interface ArtifactContext {
  record: ExecutionRecord;
  outcome: Outcome;
  final: GitSnapshot;
  evidence: SessionEvidence;
  exported: ExportResult;
  git: GitInspector;
}

// How the end of a session is known: observed by `run`, confirmed by the operator, or not known.
type Ending = { kind: 'observed'; confirmed: boolean } | { kind: 'operator_confirmed' } | { kind: 'lost' };

// Why the collected results are not the accepted snapshot, or null when they are.
async function acceptanceDrift(approved: ApprovedTree, before: boolean, exported: ExportResult): Promise<string | null> {
  const after = await approved.unchanged();
  if (!before || !after) return `the working tree, index, HEAD or Git control files differ from the accepted snapshot (${before ? 'during' : 'before'} the collection).`;
  const collected = exported.withheld === null ? createHash('sha256').update(exported.diff, 'utf8').digest('hex') : null;
  if (collected !== approved.diffSha256) return 'the collected diff is not the accepted diff.';
  return null;
}

// Review 02 (R2-2): the same comparison once more, after the result files were written and right
// before a successful outcome is persisted: no process of the session runs, the tree still has the
// accepted identity and the exported diff is the accepted one. An error is drift too (unverifiable).
// This narrows the race; it cannot make the write atomic against an unconfined same-user writer.
async function finalDrift(approved: ApprovedTree, exported: ExportResult): Promise<string | null> {
  try {
    const busy = await approved.busy();
    if (busy !== null) return `a process started by the session was running after the result files were written (${busy}).`;
    if (!(await approved.unchanged())) return 'the working tree, index, HEAD or Git control files changed after the result files were written.';
  } catch {
    return 'the final comparison with the accepted snapshot could not be completed.';
  }
  const collected = exported.withheld === null ? createHash('sha256').update(exported.diff, 'utf8').digest('hex') : null;
  return collected === approved.diffSha256 ? null : 'the collected diff is not the accepted diff.';
}

// Whether two pre-existing work records name the same paths with the same content.
function sameWork(a: PreexistingWork, b: PreexistingWork): boolean {
  return a.size === b.size && [...a].every(([path, fingerprint]) => b.get(path) === fingerprint);
}

// Self-hosting: separates the session's changes from the existing uncommitted work. A path of the
// baseline whose content is unchanged is existing work and is left out of the change set. One the
// session changed stays in it (its diff, against HEAD, then includes the earlier work) and is
// named; one it reverted to HEAD or deleted is named as removed. The header says all of it.
async function separateExisting(repo: string, entries: PreexistingWork, changes: ChangeSet): Promise<{ changes: ChangeSet; summary: PreexistingSummary; header: string }> {
  const current = new Map<string, string>();
  const fingerprintNow = async (path: string): Promise<string> => {
    const known = current.get(path);
    if (known !== undefined) {
      return known;
    }
    const value = await contentFingerprint(join(repo, path));
    current.set(path, value);
    return value;
  };
  const ownChange = async (path: string): Promise<boolean> => !entries.has(path) || (await fingerprintNow(path)) !== entries.get(path);
  const tracked: string[] = [];
  for (const path of changes.tracked) {
    if (await ownChange(path)) {
      tracked.push(path);
    }
  }
  const untracked: string[] = [];
  for (const path of changes.untracked) {
    if (await ownChange(path)) {
      untracked.push(path);
    }
  }
  const listed = new Set([...changes.tracked, ...changes.untracked]);
  const changed: string[] = [];
  const removed: string[] = [];
  let untouched = 0;
  for (const [path, before] of entries) {
    const after = await fingerprintNow(path);
    if (after === before) {
      untouched += 1;
    } else if (after === 'missing' || !listed.has(path)) {
      removed.push(path);
    } else {
      changed.push(path);
    }
  }
  const summary: PreexistingSummary = {
    paths: entries.size,
    untouched,
    changed: changed.slice(0, MAX_LISTED_PREEXISTING),
    removed: removed.slice(0, MAX_LISTED_PREEXISTING),
    changed_more: Math.max(0, changed.length - MAX_LISTED_PREEXISTING),
    removed_more: Math.max(0, removed.length - MAX_LISTED_PREEXISTING),
  };
  const list = (paths: string[], more: number) => `${paths.map(cell).join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
  const header = [
    `# Existing uncommitted work: ${summary.paths} path(s) recorded before the session; ${untouched} unchanged and left out of this diff.\n`,
    ...(changed.length > 0 ? [`# Changed by the session although they held uncommitted work before it (their diff is against HEAD and includes that earlier work): ${list(summary.changed, summary.changed_more)}\n`] : []),
    ...(removed.length > 0 ? [`# Reverted or removed by the session (their earlier uncommitted content is no longer in the working tree): ${list(summary.removed, summary.removed_more)}\n`] : []),
  ].join('');
  return { changes: { ...changes, tracked, untracked }, summary, header };
}

// Gives the gate back on a failure path. The original error stays the one reported; if the release
// cannot be shown complete (gate_unresponsive), its diagnostic (pid, recovery) is added to it, or
// reported alone when there is no other error. Either way an uncertain gate stays closed: the next
// reservation finds it busy.
async function releaseKeeping(reserved: Pick<ReservedLaunch, 'release'>, original: unknown): Promise<void> {
  try {
    await reserved.release();
  } catch (error) {
    if (original === undefined) throw error;
    if (original instanceof ExecutionError && error instanceof ExecutionError) {
      throw new ExecutionError(original.code, `${original.message} In addition: ${error.message}`);
    }
  }
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const now = (): string => new Date().toISOString();
const isTerminal = (state: ExecutionState): boolean => ['completed', 'failed', 'needs_inspection'].includes(state);
const hasSecret = (text: string): boolean => SECRET_PATTERNS.some((pattern) => pattern.test(text));
// Markdown cell text: no pipes, backticks or line breaks.
const cell = (text: string): string => text.replace(/[|`\n\r]/g, ' ');

export type BaselineRead = { status: 'valid'; state: PrivateBaseline } | { status: 'missing' | 'invalid' };

// Reads a private baseline without following symlinks; anything but a valid baseline file is 'invalid'.
export async function readPrivateBaselineFile(path: string): Promise<BaselineRead> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_PRIVATE_BYTES) return { status: 'invalid' };
    const raw: unknown = JSON.parse(await handle.readFile('utf8'));
    const parsed = privateBaselineSchema.safeParse(raw);
    return parsed.success && keptEveryKey(raw, parsed.data) ? { status: 'valid', state: parsed.data } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  } finally {
    await handle.close();
  }
}

// Whether a parsed execution.json matches the current record schema (records of the
// earliest SF-006 format carry the schema marker but lack later fields).
export function isCurrentExecutionRecord(value: unknown): boolean {
  return recordSchema.safeParse(value).success;
}

// What one execution.json (of any SF-006 format) says about a possibly live session, for
// the hand-started session scan:
//   prepared                      inactive: no session exists yet;
//   running, pending_manual,      a session that may be live: counted with a valid session id,
//   interrupted                   unverifiable without one (fails closed);
//   completed, failed,            the session ended, but can be resumed by hand (claude --resume
//   needs_inspection              <id>): a valid session id is a candidate for the /proc check
//                                 (Review 03); without one the record is inactive, so historical
//                                 records with no usable identity never block for being old;
//   unknown state or schema       unverifiable (fails closed).
// A candidate blocks only while a process carries its id; the record itself never does.
// SF-009: the ids of a managed job's session_lineage are candidates too; a lineage that is not
// a list of session ids is unverifiable.
const sessionIdentitySchema = z.object({ id: z.uuid() });
const lineageSchema = z.array(z.uuid()).max(64);
export type SessionActivity = { kind: 'inactive' } | { kind: 'session'; ids: string[] } | { kind: 'unverifiable'; category: string };
export function sessionActivity(raw: unknown): SessionActivity {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || (raw as { schema?: unknown }).schema !== EXECUTION_SCHEMA) {
    return { kind: 'unverifiable', category: 'unknown schema' };
  }
  const { state, session } = raw as { state?: unknown; session?: unknown };
  if (!(STATES as readonly unknown[]).includes(state)) return { kind: 'unverifiable', category: 'unknown state' };
  if (state === 'prepared') return { kind: 'inactive' };
  const identity = sessionIdentitySchema.safeParse(session);
  if (identity.success) {
    const lineage = (raw as { session_lineage?: unknown }).session_lineage;
    if (lineage === undefined) return { kind: 'session', ids: [identity.data.id] };
    const parsed = lineageSchema.safeParse(lineage);
    return parsed.success ? { kind: 'session', ids: [...new Set([identity.data.id, ...parsed.data])] } : { kind: 'unverifiable', category: 'invalid session lineage' };
  }
  return isTerminal(state as ExecutionState) ? { kind: 'inactive' } : { kind: 'unverifiable', category: 'no valid session id' };
}

// Whether a parsed execution.json of any SF-006 format has only known fields, each of its
// current type (earlier formats lack some). ignored_initial is left to the legacy checks.
const knownFieldsSchema = recordSchema.partial().extend({ ignored_initial: z.unknown().optional() });
export function hasOnlyKnownExecutionFields(value: unknown): boolean {
  return knownFieldsSchema.safeParse(value).success;
}

function view(record: ExecutionRecord): ExecutionView {
  return {
    app_id: record.app_id,
    job_id: record.job_id,
    state: record.state,
    destination: record.destination,
    session_id: record.session?.id ?? null,
    error: record.error,
    recovery: record.recovery,
  };
}

// Changed path names are listed only when the results are exportable; a withheld export keeps no names.
function gitRecord(snapshot: GitSnapshot, listPaths = true): GitRecord {
  const changed = listPaths ? snapshot.changes.map((change) => change.path).slice(0, MAX_LISTED_PATHS) : [];
  return { head: snapshot.head, index_sha256: snapshot.index_sha256, changed_paths: changed };
}

// Runs a filesystem step; unexpected errors are reported by their errno code only, never with host paths.
async function io<T>(label: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof ExecutionError || error instanceof FactoryJobError || error instanceof AppConfigError) {
      throw error;
    }
    throw new ExecutionError('io_failed', `${label} failed (${(error as NodeJS.ErrnoException).code ?? (error as Error).name}).`);
  }
}

export class ExecutionService {
  readonly #deps: ExecutionDeps;
  readonly #jobs: FactoryJobs;

  constructor(deps: ExecutionDeps) {
    this.#deps = deps;
    this.#jobs = new FactoryJobs(deps.mediatorRoot);
  }

  // Read-only: reports every precondition; writes nothing anywhere.
  async preflight(appId: string, jobId: string): Promise<PreflightReport> {
    const checks: PreflightReport['checks'] = [];
    const add = (name: string, ok: boolean, detail: string, code = 'not_ready') => checks.push({ name, ok, detail, ...(ok ? {} : { code }) });
    const failure = (error: unknown) => ({
      code: (error as { code?: string }).code ?? 'error',
      detail: error instanceof ExecutionError || error instanceof FactoryJobError || error instanceof AppConfigError ? error.message : 'unexpected error',
    });
    let state: PreflightReport['state'] = 'not_started';
    add(
      'terminal',
      !this.#deps.insideClaudeSession,
      this.#deps.insideClaudeSession
        ? 'running inside a Claude Code session; run the adapter from your own terminal (a nested session saves no transcript)'
        : 'not inside a Claude Code session',
      'inside_claude_session',
    );
    let config: AppConfig | undefined;
    try {
      config = await this.#config(appId);
      add(
        'app configuration',
        true,
        config.selfHosted === true
          ? `${appId}: .env valid, APP_REPO is this Software Factory checkout (self-hosting opt-in)`
          : `${appId}: .env valid, APP_REPO is a separate Git worktree root`,
      );
    } catch (error) {
      const { code, detail } = failure(error);
      add('app configuration', false, detail, code);
    }
    try {
      await this.#jobs.withJob(appId, jobId, false, async (job) => {
        const record = await this.#readRecord(job);
        if (record !== undefined) {
          state = record.state;
          add('execution state', record.state === 'prepared', `execution.json: ${record.state}`, 'wrong_state');
          return;
        }
        await this.#verifyAcceptance(job, appId, jobId);
        state = 'accepted';
        add('acceptance', true, 'instruction sha256, dispatch.json, openclaw-receipt.json and the OpenClaw receiver record agree');
        if (config !== undefined) {
          const snapshot = await this.#git(config).snapshot();
          if (config.selfHosted === true) {
            // The existing work is kept and recorded as the job's baseline at prepare (never cleaned).
            add('existing work baseline', true, `${snapshot.changes.length} uncommitted path(s) outside ${ADAPTER_DIR}/ stay as they are; they are recorded as the job's baseline`);
          } else {
            add('app repository clean', snapshot.changes.length === 0, `${snapshot.changes.length} changed path(s) outside ${ADAPTER_DIR}/`, 'repo_dirty');
          }
          await this.#checkDestination(config, jobId, undefined);
          add('destination', true, `${instructionDestination(jobId)} is free or already identical`);
        }
      });
    } catch (error) {
      const { code, detail } = failure(error);
      add('acceptance', false, detail, code);
    }
    add('Claude Code runner', await this.#deps.runner.available(), this.#deps.runner.identity, 'runner_unavailable');
    try {
      const auth = await this.#deps.authStatus();
      add('Claude Code login', auth.loggedIn, `logged in: ${auth.loggedIn}${auth.method ? ` (${auth.method})` : ''}`, 'not_logged_in');
    } catch {
      add('Claude Code login', false, 'login state unknown', 'auth_unknown');
    }
    const skill = await this.#skillCheck(config);
    add('/implement skill', skill.ok, skill.detail, skill.code);
    try {
      const busy = await this.#sessionBusy();
      add('Claude session gate', busy === null, busy ?? 'no other Software Factory Claude session is running', 'session_busy');
    } catch (error) {
      const { code, detail } = failure(error);
      add('Claude session gate', false, detail, code);
    }
    return { ready: checks.every((check) => check.ok), state, checks };
  }

  // With expected (an SF-007 approval), only a job without execution.json is prepared,
  // and only for exactly the approved acceptance and repository.
  async prepare(appId: string, jobId: string, expected?: ApprovedJob): Promise<ExecutionView> {
    const config = await this.#config(appId);
    return this.#locked(appId, jobId, async (job) => {
      const existing = await this.#readRecord(job);
      if (existing !== undefined && expected !== undefined) {
        throw new ExecutionError('wrong_state', `${appId}/${jobId} already has an execution record (${existing.state}); an approval only prepares a new job.`);
      }
      if (existing !== undefined) {
        if (existing.state === 'prepared') {
          await this.#checkDestination(config, jobId, existing.instruction_sha256, true);
        }
        return view(existing);
      }
      const accepted = await this.#verifyAcceptance(job, appId, jobId);
      this.#checkApproved(config, accepted, expected);
      const inspector = this.#git(config);
      const snapshot = await inspector.snapshot();
      if (snapshot.changes.length > 0 && (await inspector.conversions(snapshot.changes.map((change) => change.path))) > 0) {
        throw new ExecutionError(
          'unsupported_conversions',
          `The repository of ${appId} uses content conversions (filter, eol, text with autocrlf, ident or working-tree-encoding) ` +
            'for changed paths; the adapter compares raw content and does not support such repositories yet.',
        );
      }
      if (snapshot.changes.length > 0 && config.selfHosted !== true) {
        throw new ExecutionError(
          'repo_dirty',
          `The repository of ${appId} has ${snapshot.changes.length} uncommitted or untracked path(s) outside ${ADAPTER_DIR}/. ` +
            'Commit, stash or remove them yourself first; the adapter never touches existing work.',
        );
      }
      // Self-hosting: the existing work stays; its verified baseline is recorded before the record.
      let preexisting: ExecutionRecord['preexisting'];
      if (config.selfHosted === true) {
        const baseline: PreexistingBaseline = {
          head: snapshot.head,
          index_sha256: snapshot.index_sha256,
          entries: await inspector.preexisting(snapshot.head),
        };
        preexisting = { paths: baseline.entries.size, sha256: await this.#writePreexisting(job, jobId, baseline) };
      }
      await this.#copyInstruction(config, jobId, accepted.instruction);
      const stamp = now();
      const record: ExecutionRecord = {
        schema: EXECUTION_SCHEMA,
        app_id: appId,
        job_id: jobId,
        request_id: accepted.requestId,
        instruction_sha256: accepted.sha256,
        instruction_bytes: accepted.instruction.byteLength,
        state: 'prepared',
        revision: 1,
        created_at: stamp,
        updated_at: stamp,
        destination: instructionDestination(jobId),
        acceptance: accepted.acceptance,
        checks: this.#acceptanceChecks(stamp, 'prepare', preexisting),
        git_initial: gitRecord(snapshot, preexisting === undefined),
        ...(preexisting === undefined ? {} : { preexisting }),
        ignored_initial: null,
        git_final: null,
        session: null,
        completion: null,
        evidence: null,
        artifacts: {},
        error: null,
        recovery: null,
        history: [{ state: 'prepared', at: stamp }],
      };
      await io('writing execution.json', () => writeJobFile(job, EXECUTION_FILE, this.#json(record), 'create'));
      return view(record);
    });
  }

  // Launches the one Claude session of this job and waits for it; then asks
  // confirmFinished whether /implement finished, and collects.
  // With expected (an SF-007 approval), nothing starts unless the acceptance, the
  // record and the repository are still exactly the approved ones.
  async run(appId: string, jobId: string, confirmFinished: () => Promise<boolean>, expected?: ApprovedJob): Promise<ExecutionView> {
    const config = await this.#config(appId);
    return this.#locked(appId, jobId, async (job) => {
      let record = await this.#requireRecord(job, jobId);
      const git = await this.#checkLaunchable(job, config, record, expected);
      // The last safe point: take the host-wide gate before claiming. Busy leaves the job prepared.
      const reserved = await this.#reserveGate(`${appId}/${jobId}`);
      let launching = false;
      let session: SessionRecord;
      let failure: unknown;
      try {
        const ignored = await this.#ignoredState(git);
        await this.#writePrivateBaseline(job, jobId, ignored);
        session = await this.#claim(job, appId, jobId, 'interactive');
        // Recorded before the launch: from here on, no path leads to a second session.
        record = await this.#update(job, record, {
          state: 'running',
          session: { ...session, started_at: now() },
          ignored_summary: { entries: ignored.entries.length, credentials: Object.keys(ignored.credentials).length, complete: ignored.complete },
          checks: [...record.checks, ...this.#acceptanceChecks(now(), 'run', record.preexisting)],
        });
        launching = true;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (!launching) await releaseKeeping(reserved, failure);
      }
      let launched: Awaited<ReturnType<ReservedLaunch['launch']>>;
      try {
        launched = await reserved.launch({ cwd: config.repo, sessionId: session.id, name: session.name, prompt: prompt(jobId) });
      } catch (error) {
        await reserved.release();
        return view(await this.#launchFailed(job, record, error));
      }
      record = await this.#recordPid(job, record, launched.pid);
      const exit: SessionExit = await launched.exited;
      record = await this.#update(job, record, {
        session: { ...record.session!, ended_at: now(), exit_code: exit.code, signal: exit.signal },
      });
      const confirmed = exit.signal === null && exit.code === 0 ? await confirmFinished() : false;
      return view(await this.#finish(job, config, record, { kind: 'observed', confirmed }));
    });
  }

  // SF-009: launches the one managed session of this job (same checks, gate, private baseline and
  // launch.claim as run) and hands it to drive until the supervisor returns an ending. The job
  // lock and, through the Claude process, the session gate are held throughout: a review-idle
  // session can still change files, so nothing is released while it lives. Then the process is
  // ended (stdin EOF, bounded; SIGTERM/SIGKILL only for this confirmed child) and SF-006 collects:
  // an operator acceptance is the confirmation, anything else is an unconfirmed end.
  async runManaged(appId: string, jobId: string, expected: ApprovedJob, drive: (control: ManagedControl) => Promise<ManagedEnding>): Promise<ExecutionView> {
    const config = await this.#config(appId);
    return this.#locked(appId, jobId, async (job) => {
      let record = await this.#requireRecord(job, jobId);
      const git = await this.#checkLaunchable(job, config, record, expected);
      const label = `${appId}/${jobId}`;
      const reserved = await this.#reserveGate(label);
      let launching = false;
      let session: SessionRecord;
      let failure: unknown;
      try {
        if (reserved.launchManaged === undefined) {
          throw new ExecutionError('runner_unavailable', `${this.#deps.runner.identity} cannot start managed sessions; nothing was started.`);
        }
        const ignored = await this.#ignoredState(git);
        await this.#writePrivateBaseline(job, jobId, ignored);
        session = await this.#claim(job, appId, jobId, 'managed');
        record = await this.#update(job, record, {
          state: 'running',
          session: { ...session, started_at: now() },
          session_lineage: [session.id],
          ignored_summary: { entries: ignored.entries.length, credentials: Object.keys(ignored.credentials).length, complete: ignored.complete },
          checks: [...record.checks, ...this.#acceptanceChecks(now(), 'run (managed)', record.preexisting)],
        });
        launching = true;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (!launching) await releaseKeeping(reserved, failure);
      }
      let current: ManagedSessionHandle;
      try {
        current = { sessionId: session.id, process: await reserved.launchManaged!({ cwd: config.repo, sessionId: session.id, name: session.name, selfHosted: config.selfHosted === true }) };
      } catch (error) {
        await reserved.release();
        return view(await this.#launchFailed(job, record, error));
      }
      record = await this.#recordPid(job, record, current.process.pid);
      const control: ManagedControl = {
        claimedSessionId: session.id,
        repo: config.repo,
        git: inspectorOptions(config),
        current: () => current,
        inspect: () => this.#inspect(job, config, record, current.sessionId),
        replace: async () => {
          if ((await this.#endManaged(current.process)) === undefined) {
            throw new ExecutionError('still_running', `The Claude process of ${label} could not be shown to have ended; no new process was started.`);
          }
          const next = await this.#reserveGate(label);
          let id: string;
          try {
            if (next.launchManaged === undefined) throw new ExecutionError('runner_unavailable', 'The runner cannot start managed sessions.');
            id = randomUUID();
            // Recorded before the launch, so the hand-started session scan knows this id from the start.
            // A launch that then fails leaves the id in the lineage: still a liveness candidate (fails closed).
            record = await this.#update(job, record, { session_lineage: [...(record.session_lineage ?? [record.session!.id]), id] });
          } catch (error) {
            await releaseKeeping(next, error);
            throw error;
          }
          try {
            current = { sessionId: id, process: await next.launchManaged({ cwd: config.repo, sessionId: id, name: session.name, selfHosted: config.selfHosted === true }) };
          } catch (error) {
            await next.release();
            throw error;
          }
          record = await this.#recordPid(job, record, current.process.pid);
          return current;
        },
        writeAdapterFile: (name, content) => this.#writeAdapterFile(config, jobId, record.instruction_sha256, name, content),
      };
      let ending: ManagedEnding;
      try {
        ending = await drive(control);
      } catch {
        ending = { kind: 'ended' };
      }
      const exit = await this.#endManaged(current.process, ending.kind === 'ended' && ending.urgent === true ? 0 : undefined);
      if (exit === undefined) {
        return view(
          await this.#update(job, record, {
            state: 'needs_inspection',
            error: { code: 'session_not_ended', message: `The Claude process (pid ${current.process.pid}) did not end after its input closed and it was signalled.` },
            recovery: 'Find and end that process yourself, then inspect the application repository; this job never launches again.',
          }),
        );
      }
      record = await this.#update(job, record, { session: { ...record.session!, ended_at: now(), exit_code: exit.code, signal: exit.signal } });
      await this.#deps.beforeManagedCollect?.();
      return view(
        ending.kind === 'accepted'
          ? await this.#finish(job, config, record, { kind: 'operator_confirmed' }, ending.approved)
          : await this.#finish(job, config, record, { kind: 'observed', confirmed: false }),
      );
    });
  }

  // Hands the job to the operator: a fixed command to start in Claude Code by hand.
  // gated_command is the command to run by hand: claude under flock(1) on the session gate.
  async handoff(appId: string, jobId: string): Promise<ExecutionView & { command: string[]; gated_command: string[]; cwd: string }> {
    const config = await this.#config(appId);
    return this.#locked(appId, jobId, async (job) => {
      let record = await this.#requireRecord(job, jobId);
      if (record.state === 'prepared') {
        await this.#checkDestination(config, jobId, record.instruction_sha256, true);
        // The handed-off session is started by hand and cannot hold the gate; it is only
        // handed off while no other session runs, and is then found by its session id.
        const busy = await this.#sessionBusy();
        if (busy !== null) throw new ExecutionError('session_busy', `${busy}; nothing was handed off.`);
        const ignored = await this.#ignoredState(this.#git(config));
        await this.#writePrivateBaseline(job, jobId, ignored);
        const session = await this.#claim(job, appId, jobId, 'manual');
        record = await this.#update(job, record, {
          state: 'pending_manual',
          session,
          ignored_summary: { entries: ignored.entries.length, credentials: Object.keys(ignored.credentials).length, complete: ignored.complete },
          recovery: 'Start the handed-off command in the application repository, finish the session, then run collect.',
        });
      } else if (record.state !== 'pending_manual') {
        throw new ExecutionError('wrong_state', this.#wrongState(record, 'hand off'));
      }
      const session = record.session!;
      const command = ['claude', ...claudeArguments({ sessionId: session.id, name: session.name, prompt: prompt(jobId) })];
      return { ...view(record), command, gated_command: await this.#deps.runner.gatedCommand(command), cwd: config.repo };
    });
  }

  // Brings the results of a manual, interrupted or orphaned session back to the mediator.
  // sessionFinished is the operator's confirmation that /implement finished in that session.
  // approved (SF-009): the accepted snapshot the collected tree must still match.
  async collect(appId: string, jobId: string, options: { sessionFinished: boolean; approved?: ApprovedTree }): Promise<ExecutionView> {
    const config = await this.#config(appId);
    return this.#locked(appId, jobId, async (job) => {
      const record = await this.#requireRecord(job, jobId);
      if (isTerminal(record.state)) {
        return view(record);
      }
      if (record.state === 'prepared') {
        throw new ExecutionError('wrong_state', this.#wrongState(record, 'collect'));
      }
      const session = record.session!;
      if ((await isAlive(session)) || (await sessionProcessRunning(session.id))) {
        throw new ExecutionError('still_running', `The Claude session ${session.id} of ${appId}/${jobId} is still running; end it first.`);
      }
      if (record.state === 'running') {
        if (session.ended_at !== null && session.exit_code !== null) {
          // The adapter saw the exit but stopped before collecting.
          return view(await this.#finish(job, config, record, { kind: 'observed', confirmed: options.sessionFinished }, options.approved));
        }
        if (!options.sessionFinished) {
          return view(await this.#finish(job, config, record, { kind: 'lost' }));
        }
        return view(await this.#finish(job, config, record, { kind: 'operator_confirmed' }, options.approved));
      }
      // pending_manual or interrupted: the operator ran or resumed the session by hand.
      const evidence = await readSessionEvidence(this.#deps.claudeProjectsDir, this.#expected(config, record));
      if (!evidence.transcript_found) {
        throw new ExecutionError('transcript_missing', `No Claude Code transcript exists for session ${session.id} in the app repository's project.`);
      }
      if (!options.sessionFinished) {
        throw new ExecutionError('session_not_finished', 'Collect only after /implement has finished and the Claude session has ended (confirm it).');
      }
      return view(await this.#finish(job, config, record, { kind: 'operator_confirmed' }));
    });
  }

  // Read-only.
  async status(
    appId: string,
    jobId: string,
  ): Promise<ExecutionView & { process_alive: boolean | null; revision: number; history: ExecutionRecord['history']; artifacts: Record<string, string> }> {
    return this.#jobs.withJob(appId, jobId, false, async (job) => {
      const record = await this.#requireRecord(job, jobId);
      const session = record.session;
      const alive =
        session !== null && ['running', 'pending_manual', 'interrupted'].includes(record.state)
          ? (await isAlive(session)) || (await sessionProcessRunning(session.id))
          : null;
      return { ...view(record), process_alive: alive, revision: record.revision, history: record.history, artifacts: record.artifacts };
    });
  }

  // ---- internals ----

  async #config(appId: string): Promise<AppConfig> {
    return loadAppConfig(this.#deps.mediatorRoot, appId, await this.#deps.selfHosting?.());
  }

  #git(config: AppConfig): GitInspector {
    return new GitInspector(config.repo, inspectorOptions(config));
  }

  async #locked<T>(appId: string, jobId: string, fn: (job: JobDir) => Promise<T>): Promise<T> {
    return this.#jobs.withJob(appId, jobId, false, async (job) => {
      const release = await io('taking the execution lock', () => acquireLock(job.dir, `${appId}/${jobId}`));
      try {
        return await fn(job);
      } finally {
        await release();
      }
    });
  }

  // The checks before any launch (run, runManaged), inside the job lock: still prepared, the
  // acceptance and the approval binding verified again, the instruction copy intact, the repository
  // unchanged since prepare, the runner executable.
  async #checkLaunchable(job: JobDir, config: AppConfig, record: ExecutionRecord, expected: ApprovedJob | undefined): Promise<GitInspector> {
    const { app_id: appId, job_id: jobId } = record;
    if (record.state !== 'prepared') {
      throw new ExecutionError('wrong_state', this.#wrongState(record, 'run'));
    }
    const accepted = await this.#verifyAcceptance(job, appId, jobId);
    this.#checkApproved(config, accepted, expected);
    if (expected !== undefined && (record.request_id !== expected.requestId || record.instruction_sha256 !== expected.instructionSha256)) {
      throw new ExecutionError('approval_mismatch', `The execution record of ${appId}/${jobId} is not the approved one; nothing was started.`);
    }
    await this.#checkDestination(config, jobId, record.instruction_sha256, true);
    const git = this.#git(config);
    const snapshot = await git.snapshot();
    const repoChanged = () => new ExecutionError('repo_changed', `The repository of ${appId} changed since prepare; nothing was started. Restore it or use a new job.`);
    if (snapshot.head !== record.git_initial.head || snapshot.index_sha256 !== record.git_initial.index_sha256) {
      throw repoChanged();
    }
    if (record.preexisting === undefined || config.selfHosted !== true) {
      // A record with a baseline is only launched for the self-hosted app, and only with it.
      if (snapshot.changes.length > 0 || record.preexisting !== undefined) {
        throw repoChanged();
      }
    } else {
      // Self-hosting: the tree must still hold exactly the existing work recorded at prepare.
      const baseline = await this.#readPreexisting(job, record);
      if (baseline.head !== snapshot.head || baseline.index_sha256 !== snapshot.index_sha256 || !sameWork(baseline.entries, await git.preexisting(snapshot.head))) {
        throw repoChanged();
      }
    }
    if (!(await this.#deps.runner.available())) {
      throw new ExecutionError('runner_unavailable', `${this.#deps.runner.identity} is not executable; nothing was started.`);
    }
    return git;
  }

  // The outcome of a launch that did not hand over (shared by run and runManaged).
  async #launchFailed(job: JobDir, record: ExecutionRecord, error: unknown): Promise<ExecutionRecord> {
    // Ambiguous: the claim stays, nothing is retried, and the operator inspects the repository.
    if (error instanceof ExecutionError && error.code === 'launch_unconfirmed') {
      return this.#update(job, record, {
        state: 'needs_inspection',
        session: { ...record.session!, ended_at: now() },
        error: { code: 'launch_unconfirmed', message: error.message },
        recovery:
          'Whether Claude Code started could not be confirmed. Inspect the application repository (git status) yourself; this job never launches again. Ask for a new job id to retry.',
      });
    }
    return this.#update(job, record, {
      state: 'failed',
      session: { ...record.session!, ended_at: now() },
      error: { code: 'runner_failed', message: error instanceof ExecutionError ? error.message : 'Claude Code could not be started.' },
      recovery: 'Claude Code did not start. Fix the runner (see preflight); this job will not launch again. Ask for a new job id to retry.',
    });
  }

  // Claude runs now: a failure to record its pid must not stop the session (the session id still identifies it).
  async #recordPid(job: JobDir, record: ExecutionRecord, pid: number): Promise<ExecutionRecord> {
    try {
      const identity = await identify(pid);
      return await this.#update(job, record, { session: { ...record.session!, ...identity, pid } });
    } catch {
      return record;
    }
  }

  // Ends a managed process this service started: stdin EOF, then SIGTERM, then SIGKILL, each with a
  // bounded wait. The pid is this process's own unreaped child until its exit is observed, so it
  // cannot name another process. Undefined when no exit was observed.
  async #endManaged(child: ManagedProcess, graceMs = this.#deps.managedStopMs ?? 30_000): Promise<SessionExit | undefined> {
    const wait = async (ms: number): Promise<SessionExit | undefined> => {
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([child.exited, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))]);
      clearTimeout(timer);
      return result;
    };
    child.input.end();
    let exit = await wait(graceMs);
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (exit !== undefined) break;
      try {
        process.kill(child.pid, signal);
      } catch {
        // Already gone; its exit event settles the wait.
      }
      exit = await wait(signal === 'SIGTERM' ? 10_000 : 5_000);
    }
    return exit;
  }

  async #inspect(job: JobDir, config: AppConfig, record: ExecutionRecord, sessionId: string): Promise<IterationInspection> {
    const git = this.#git(config);
    const final = await git.snapshot();
    const evidence = await readSessionEvidence(this.#deps.claudeProjectsDir, { ...this.#expected(config, record), sessionId });
    const exported = await this.#export(job, git, config, record, final, evidence);
    return {
      baseline: { head: record.git_initial.head, index_sha256: record.git_initial.index_sha256 },
      head: final.head,
      index_sha256: final.index_sha256,
      git_changed: final.head !== record.git_initial.head || final.index_sha256 !== record.git_initial.index_sha256,
      withheld: exported.withheld,
      diff: exported.diff,
      changed_paths: exported.changedPaths,
      new_files: exported.newFiles,
      commands: exported.commands,
      message: exported.message,
      ...(exported.preexisting === undefined ? {} : { preexisting: exported.preexisting }),
    };
  }

  // A new file next to the instruction copy: the destination directories are verified plain and
  // inside the repository, the name is fixed-format, and an existing file is never replaced.
  async #writeAdapterFile(config: AppConfig, jobId: string, instructionSha: string, name: string, content: Buffer): Promise<string> {
    if (!/^[a-z0-9][a-z0-9.-]{0,62}[a-z0-9]$/.test(name) || name === 'instruction.md' || name.includes('..')) {
      throw new ExecutionError('unsafe_destination', 'The adapter file name is not allowed.');
    }
    await this.#checkDestination(config, jobId, instructionSha, true);
    const relative = `${ADAPTER_DIR}/jobs/${jobId}/${name}`;
    await io(`writing ${relative}`, async () => {
      const dir = join(config.repo, ADAPTER_DIR, 'jobs', jobId);
      if ((await realpath(dir)) !== dir) {
        throw new ExecutionError('unsafe_destination', `${ADAPTER_DIR}/jobs/${jobId} does not resolve inside the app repository.`);
      }
      const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
      try {
        const handle = await open(temp, 'wx', 0o644);
        try {
          await handle.writeFile(content);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await link(temp, join(dir, name)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'EEXIST') throw new ExecutionError('destination_conflict', `${relative} already exists; it was not changed.`);
          throw error;
        });
      } finally {
        await rm(temp, { force: true });
      }
    });
    return relative;
  }

  // Creates launch.claim exclusively; a second claim for the same job is impossible.
  async #claim(job: JobDir, appId: string, jobId: string, mode: SessionRecord['mode']): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: randomUUID(),
      name: sessionName(appId, jobId),
      mode,
      runner: mode === 'interactive' ? this.#deps.runner.identity : 'operator',
      started_at: null,
      ended_at: null,
      exit_code: null,
      signal: null,
    };
    try {
      await writeJobFile(job, CLAIM_FILE, Buffer.from(`${JSON.stringify({ session_id: session.id, mode, at: now() })}\n`), 'create');
    } catch (error) {
      if (error instanceof FactoryJobError && error.code === 'conflict') {
        throw new ExecutionError('wrong_state', `${appId}/${jobId} was already launched or handed off once (${CLAIM_FILE}); it never launches again.`);
      }
      throw error;
    }
    return session;
  }

  // Takes the session gate for one launch, or explains why another session blocks it.
  async #reserveGate(label: string): Promise<ReservedLaunch> {
    const reservation = await this.#deps.runner.reserve();
    if ('busy' in reservation) {
      throw new ExecutionError(
        'session_busy',
        `${capitalize(describeHolder(reservation.holderPids))}; ${label} stays prepared and was not started. Run it again when that session has ended.`,
      );
    }
    try {
      const live = await this.#liveHandStartedSessions();
      if (live.length > 0) {
        throw new ExecutionError(
          'session_busy',
          `A hand-started Claude session is running for ${live.slice(0, 3).join(', ')}; ${label} stays prepared and was not started.`,
        );
      }
    } catch (error) {
      await releaseKeeping(reservation, error);
      throw error;
    }
    return reservation;
  }

  // Why a new session may not start now, or null. Reads the gate's holders without taking it,
  // so a check never makes a concurrent launch busy.
  async #sessionBusy(): Promise<string | null> {
    const holders = await this.#deps.runner.gateHolders();
    if (holders.length > 0) return describeHolder(holders);
    const live = await this.#liveHandStartedSessions();
    return live.length > 0 ? `a hand-started Claude session is running for ${live.slice(0, 3).join(', ')}` : null;
  }

  // Jobs whose recorded session (handed off, running or interrupted, or a terminal one that can be resumed by hand) still has a live process
  // with that session id. Fails closed with a fixed diagnostic (verified ids and a category
  // only): a record that could stand for a live session but has no valid session id, an unknown
  // state or schema, an unreadable record, or a directory that cannot be inspected refuses the
  // launch. A missing factory-data, apps or jobs directory (never initialized, or an app without
  // jobs yet) is not a session and does not block.
  async #liveHandStartedSessions(): Promise<string[]> {
    const unverifiable = (culprit: string, category: string) =>
      new ExecutionError(
        'session_busy',
        `Running sessions cannot be verified: ${culprit} (${category}). Nothing was started; see the runbook, "Running sessions cannot be verified".`,
      );
    // missing (ENOENT), a plain directory, or a reason it cannot be inspected; never followed.
    const directory = async (path: string): Promise<'missing' | 'directory' | 'other' | 'unreadable'> => {
      try {
        const stats = await lstat(path);
        return stats.isDirectory() && !stats.isSymbolicLink() ? 'directory' : 'other';
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
      }
    };
    const list = async (path: string, culprit: string, label: string): Promise<string[]> => {
      try {
        return (await readdir(path)).filter((name) => ID_PATTERN.test(name));
      } catch {
        throw unverifiable(culprit, `${label} cannot be listed`);
      }
    };
    for (const [path, label] of [
      ['factory-data', 'factory-data'],
      [APPS_PATH, 'factory-data/apps'],
    ] as const) {
      const kind = await directory(join(this.#deps.mediatorRoot, path));
      if (kind === 'missing') return [];
      if (kind !== 'directory') throw unverifiable(label, kind === 'other' ? 'a symlink or not a directory' : 'cannot be inspected');
    }
    const apps = join(this.#deps.mediatorRoot, APPS_PATH);
    const appIds = await list(apps, 'factory-data/apps', 'the directory');
    if (appIds.length > MAX_SCAN_APPS) throw unverifiable('factory-data/apps', `more than ${MAX_SCAN_APPS} apps`);
    const sessions = new Map<string, string>();
    // A separate instance: the scan only reads, and must not wait on the job lock run already holds.
    const reader = new FactoryJobs(this.#deps.mediatorRoot);
    let scanned = 0;
    for (const appId of appIds) {
      const appKind = await directory(join(apps, appId));
      if (appKind === 'missing') continue;
      if (appKind !== 'directory') {
        throw unverifiable(`${APPS_PATH}/${appId}`, appKind === 'other' ? 'app directory is a symlink or not a directory' : 'app directory cannot be inspected');
      }
      const jobsKind = await directory(join(apps, appId, 'jobs'));
      if (jobsKind === 'missing') continue;
      if (jobsKind !== 'directory') {
        throw unverifiable(`${APPS_PATH}/${appId}/jobs`, jobsKind === 'other' ? 'jobs directory is a symlink or not a directory' : 'jobs directory cannot be inspected');
      }
      for (const jobId of await list(join(apps, appId, 'jobs'), `${APPS_PATH}/${appId}/jobs`, 'jobs directory')) {
        scanned += 1;
        if (scanned > MAX_SCAN_JOBS) throw unverifiable('factory-data/apps', `more than ${MAX_SCAN_JOBS} jobs`);
        let buffer: Buffer | undefined;
        try {
          buffer = await reader.withJob(appId, jobId, false, (job) => readJobFile(job, EXECUTION_FILE, MAX_RECORD_BYTES));
        } catch {
          throw unverifiable(`${appId}/${jobId}`, 'execution.json or its job directory cannot be read');
        }
        if (buffer === undefined) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(buffer.toString('utf8'));
        } catch {
          throw unverifiable(`${appId}/${jobId}`, 'not JSON');
        }
        const activity = sessionActivity(raw);
        if (activity.kind === 'unverifiable') throw unverifiable(`${appId}/${jobId}`, activity.category);
        if (activity.kind === 'session') for (const id of activity.ids) sessions.set(id, `${appId}/${jobId}`);
      }
    }
    const running = await sessionProcessesRunning([...sessions.keys()]);
    return [...running].map((id) => sessions.get(id)!).sort();
  }

  #checkApproved(config: AppConfig, accepted: Accepted, expected: ApprovedJob | undefined): void {
    if (expected === undefined) return;
    if (accepted.requestId !== expected.requestId || accepted.sha256 !== expected.instructionSha256 || sha256(config.repo) !== expected.appRepoSha256) {
      throw new ExecutionError(
        'approval_mismatch',
        `${config.appId}: the accepted request, the instruction or the app repository is not the one the operator approved; nothing was written.`,
      );
    }
  }

  #acceptanceChecks(at: string, step: string, preexisting?: ExecutionRecord['preexisting']): ExecutionRecord['checks'] {
    return [
      'instruction.md sha256 equals the accepted sha256',
      'dispatch.json valid and accepted',
      'openclaw-receipt.json proves the acceptance',
      'OpenClaw receiver record matches request, app, job and sha256',
      preexisting === undefined
        ? 'app repository clean outside .software-factory/'
        : `self-hosting: the ${preexisting.paths} existing uncommitted path(s) match their recorded baseline (sha256 ${preexisting.sha256})`,
    ].map((check) => ({ at, check: `${step}: ${check}`, ok: true }));
  }

  #expected(config: AppConfig, record: ExecutionRecord) {
    return {
      sessionId: record.session?.id ?? '',
      cwd: config.repo,
      skill: SKILL,
      skillDir: join(this.#deps.claudeConfigDir, 'skills', SKILL),
      args: record.destination,
    };
  }

  #wrongState(record: ExecutionRecord, action: string): string {
    return `${record.app_id}/${record.job_id} is ${record.state}; cannot ${action}. ${record.recovery ?? ''}`.trim();
  }

  // The operator's personal skill must exist, and the app repository must not shadow it with its own.
  async #skillCheck(config: AppConfig | undefined): Promise<{ ok: boolean; detail: string; code: string }> {
    const exists = async (path: string) => {
      try {
        return (await lstat(path)).isFile();
      } catch {
        return false;
      }
    };
    if (!(await exists(join(this.#deps.claudeConfigDir, 'skills', SKILL, 'SKILL.md')))) {
      return { ok: false, detail: `no personal skill ${SKILL} (plugin-provided skills are not accepted)`, code: 'skill_unavailable' };
    }
    if (config !== undefined && (await exists(join(config.repo, '.claude', 'skills', SKILL, 'SKILL.md')))) {
      return { ok: false, detail: `the app repository has its own .claude/skills/${SKILL}; it could replace the personal skill`, code: 'skill_shadowed' };
    }
    return { ok: true, detail: `personal skill ${SKILL}`, code: '' };
  }

  // Verifies every acceptance precondition and returns the instruction bytes.
  async #verifyAcceptance(job: JobDir, appId: string, jobId: string): Promise<Accepted> {
    const instruction = await readJobFile(job, INSTRUCTION_FILE, MAX_INSTRUCTION_BYTES);
    if (instruction === undefined) {
      throw new FactoryJobError('not_found', `${job.path}/${INSTRUCTION_FILE} does not exist.`);
    }
    const dispatch = await readDispatchRecord(job, appId, jobId);
    if (dispatch === undefined || dispatch.state !== 'accepted') {
      throw new ExecutionError('not_accepted', `${appId}/${jobId} has no accepted OpenClaw dispatch (${dispatch?.state ?? 'no dispatch.json'}).`);
    }
    await checkAcceptedReceipt(job, dispatch);
    const actual = sha256(instruction);
    if (actual !== dispatch.instruction_sha256) {
      throw new ExecutionError('instruction_mismatch', `${job.path}/${INSTRUCTION_FILE} has sha256 ${actual}, but ${dispatch.instruction_sha256} was accepted.`);
    }
    let receiver: ReceiverRecord | undefined;
    try {
      receiver = await this.#deps.receiverLookup(dispatch.request_id);
    } catch (error) {
      throw new ExecutionError('openclaw_unavailable', `OpenClaw could not confirm the acceptance: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (
      receiver === undefined ||
      receiver.request_id !== dispatch.request_id ||
      receiver.app_id !== appId ||
      receiver.job_id !== jobId ||
      receiver.instruction_sha256 !== dispatch.instruction_sha256
    ) {
      throw new ExecutionError('openclaw_unconfirmed', `The OpenClaw receiver has no matching accepted record for request ${dispatch.request_id}.`);
    }
    return {
      requestId: dispatch.request_id,
      sha256: actual,
      instruction,
      acceptance: {
        openclaw_run_id: dispatch.openclaw!.run_id,
        automation_id: dispatch.openclaw!.automation_id,
        receiver_accepted_at: receiver.accepted_at,
      },
    };
  }

  // Each directory of the fixed destination must be a plain directory (no
  // symlink redirect). The file must be byte-identical to expectedSha, or
  // absent unless mustExist.
  async #checkDestination(config: AppConfig, jobId: string, expectedSha: string | undefined, mustExist = false): Promise<'absent' | 'identical'> {
    const destination = instructionDestination(jobId);
    return io(`checking ${destination}`, async () => {
      const parts = [ADAPTER_DIR, 'jobs', jobId];
      let dir = config.repo;
      for (const [index, part] of parts.entries()) {
        dir = join(dir, part);
        let stats;
        try {
          stats = await lstat(dir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
          if (mustExist) {
            throw new ExecutionError('destination_conflict', `${destination} disappeared from the app repository.`);
          }
          return 'absent';
        }
        if (!stats.isDirectory()) {
          throw new ExecutionError('unsafe_destination', `${parts.slice(0, index + 1).join('/')} in the app repository is not a plain directory.`);
        }
      }
      let content: Buffer;
      try {
        const handle = await open(join(dir, 'instruction.md'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stats = await handle.stat();
          if (!stats.isFile() || stats.size > MAX_INSTRUCTION_BYTES) {
            throw new ExecutionError('unsafe_destination', `${destination} is not a regular instruction file.`);
          }
          content = await handle.readFile();
        } finally {
          await handle.close();
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' && !mustExist) {
          return 'absent';
        }
        if (code === 'ENOENT') {
          throw new ExecutionError('destination_conflict', `${destination} disappeared from the app repository.`);
        }
        if (code === 'ELOOP') {
          throw new ExecutionError('unsafe_destination', `${destination} is a symlink.`);
        }
        throw error;
      }
      if (expectedSha !== undefined && sha256(content) === expectedSha) {
        return 'identical';
      }
      throw new ExecutionError('destination_conflict', `${destination} already exists with different content; it was not changed.`);
    });
  }

  async #copyInstruction(config: AppConfig, jobId: string, instruction: Buffer): Promise<void> {
    const expected = sha256(instruction);
    // An identical copy left by an interrupted prepare is kept; different content stops here.
    if ((await this.#checkDestination(config, jobId, expected)) === 'identical') {
      return;
    }
    const destination = instructionDestination(jobId);
    await io(`copying the instruction to ${destination}`, async () => {
      let dir = config.repo;
      for (const part of [ADAPTER_DIR, 'jobs', jobId]) {
        dir = join(dir, part);
        await mkdir(dir).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') {
            throw error;
          }
        });
      }
      // Re-check the directories after creating them, and that they really lie inside the repository.
      await this.#checkDestination(config, jobId, undefined);
      if ((await realpath(dir)) !== dir) {
        throw new ExecutionError('unsafe_destination', `${destination} does not resolve inside the app repository.`);
      }
      const temp = join(dir, `.instruction.md.${randomUUID()}.tmp`);
      try {
        const handle = await open(temp, 'wx', 0o644);
        try {
          await handle.writeFile(instruction);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await link(temp, join(dir, 'instruction.md')).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'EEXIST') {
            throw new ExecutionError('destination_conflict', `${destination} appeared while copying; it was not changed.`);
          }
          throw error;
        });
      } finally {
        await rm(temp, { force: true });
      }
    });
    await this.#checkDestination(config, jobId, expected, true);
  }

  // Ignored entries plus fingerprints of ignored credential-style files, also
  // inside ignored directories, to see what the session changed there.
  async #ignoredState(git: GitInspector): Promise<PrivateBaseline> {
    const state = await git.ignored();
    return { entries: state.entries.slice(0, MAX_IGNORED), credentials: state.credentials, complete: state.complete && state.entries.length <= MAX_IGNORED };
  }

  // The ignored-file baseline names credential files and fingerprints their
  // content, so it is kept next to the app's private .env as
  // factory-data/apps/<app>/.env.sf006-ignored-<job>: factory_read_file refuses
  // .env.* files, and execution.json carries only counts.
  #privateBaseline(job: JobDir, jobId: string): string {
    return join(job.dir, '..', '..', privateBaselineName(jobId));
  }

  async #writePrivateBaseline(job: JobDir, jobId: string, state: PrivateBaseline): Promise<void> {
    const target = this.#privateBaseline(job, jobId);
    const temp = `${target}.${randomUUID()}.tmp`;
    await io('writing the private ignored-file baseline', async () => {
      try {
        const handle = await open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(state)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, target);
      } finally {
        await rm(temp, { force: true });
      }
    });
  }

  async #readPrivateBaseline(job: JobDir, jobId: string): Promise<BaselineRead> {
    return readPrivateBaselineFile(this.#privateBaseline(job, jobId));
  }

  // Self-hosting: writes the pre-existing work baseline privately (0600, next to the app's .env)
  // and returns the sha256 of its bytes, which execution.json binds it by.
  async #writePreexisting(job: JobDir, jobId: string, baseline: PreexistingBaseline): Promise<string> {
    const target = join(job.dir, '..', '..', preexistingBaselineName(jobId));
    const temp = `${target}.${randomUUID()}.tmp`;
    const file = preexistingFileSchema.parse({
      schema: 'software-factory.preexisting-work/v2',
      head: baseline.head,
      index_sha256: baseline.index_sha256,
      entries: [...baseline.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    });
    // Written only when it reads back as the same entries: never an incomplete baseline.
    const bytes = Buffer.from(`${JSON.stringify(file)}\n`, 'utf8');
    if (!sameWork(baseline.entries, new Map(preexistingFileSchema.parse(JSON.parse(bytes.toString('utf8'))).entries))) {
      throw new ExecutionError('baseline_invalid', 'The baseline of the existing work does not read back completely; nothing was prepared.');
    }
    await io('writing the pre-existing work baseline', async () => {
      try {
        const handle = await open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, target);
      } finally {
        await rm(temp, { force: true });
      }
    });
    return sha256(bytes);
  }

  // The verified baseline: a private regular file (no symlink) whose bytes hash to the sha256 the
  // record binds it by, and match its schema. Anything else throws baseline_invalid.
  async #readPreexisting(job: JobDir, record: ExecutionRecord): Promise<PreexistingBaseline> {
    const invalid = () => new ExecutionError('baseline_invalid', `The baseline of the existing work of ${record.app_id}/${record.job_id} is missing or is not the recorded one.`);
    if (record.preexisting === undefined) {
      throw invalid();
    }
    let handle;
    try {
      handle = await open(join(job.dir, '..', '..', preexistingBaselineName(record.job_id)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw invalid();
    }
    let bytes: Buffer;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_PRIVATE_BYTES || (stats.mode & 0o077) !== 0 || stats.uid !== process.getuid!()) {
        throw invalid();
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (sha256(bytes) !== record.preexisting.sha256) {
      throw invalid();
    }
    let parsed;
    try {
      parsed = preexistingFileSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    } catch {
      throw invalid();
    }
    if (!parsed.success) {
      throw invalid();
    }
    const entries: PreexistingWork = new Map(parsed.data.entries);
    // A repeated path, or a count other than the recorded one, is not the recorded baseline.
    if (entries.size !== parsed.data.entries.length || entries.size !== record.preexisting.paths) {
      throw invalid();
    }
    return { head: parsed.data.head, index_sha256: parsed.data.index_sha256, entries };
  }

  // Decides the outcome of a session and exports the results. Never leaves the job without a state.
  // With an approved tree (SF-009 acceptance), drift between the acceptance and this collection is
  // checked around the export; the artifacts then describe what was collected, never the snapshot.
  async #finish(job: JobDir, config: AppConfig, record: ExecutionRecord, ending: Ending, approved?: ApprovedTree): Promise<ExecutionRecord> {
    const git = this.#git(config);
    let final: GitSnapshot;
    let evidence: SessionEvidence;
    let exported: ExportResult;
    let drift: string | null = null;
    try {
      const quiet = approved === undefined || (await approved.quiesce());
      const before = approved === undefined || (await approved.unchanged());
      evidence = await readSessionEvidence(this.#deps.claudeProjectsDir, this.#expected(config, record));
      final = await git.snapshot();
      exported = await this.#export(job, git, config, record, final, evidence);
      if (approved !== undefined) drift = quiet ? await acceptanceDrift(approved, before, exported) : 'a background process started by the session was still running after the acceptance.';
    } catch (error) {
      return this.#update(job, record, {
        state: 'needs_inspection',
        error: { code: 'collect_failed', message: error instanceof ExecutionError ? error.message : 'Collecting the results failed.' },
        recovery: 'Inspect the application repository yourself; nothing was exported.',
      });
    }
    let outcome = this.#decide(record, ending, final, evidence, exported, drift);
    let artifacts: Record<string, string>;
    try {
      artifacts = await this.#writeArtifacts(job, { record, outcome, final, evidence, exported, git });
      if (approved !== undefined && drift === null) {
        await this.#deps.afterArtifactsWritten?.();
        const late = await finalDrift(approved, exported);
        if (late !== null) {
          // The files are written again so that they describe this outcome; the exported diff is
          // still what was collected before the change, and the accepted snapshot is untouched.
          outcome = this.#decide(record, ending, final, evidence, exported, `${late} The exported files show the tree as it was collected before that change.`);
          artifacts = await this.#writeArtifacts(job, { record, outcome, final, evidence, exported, git });
        }
      }
    } catch (error) {
      // Without its artifacts a job is never completed. Result files that were
      // written before the failure are removed, so no partial set is left behind;
      // the state file is still written if it can be.
      for (const name of ARTIFACT_FILES) {
        await lstat(join(job.dir, name))
          .then((stats) => (stats.isFile() ? rm(join(job.dir, name), { force: true }) : undefined))
          .catch(() => undefined);
      }
      return this.#update(job, record, {
        state: 'needs_inspection',
        completion: outcome.completion,
        error: {
          code: 'artifacts_failed',
          message: `The result files could not be written (${error instanceof ExecutionError ? error.message : 'write error'}). The session outcome would have been: ${outcome.state}.`,
        },
        recovery: 'Make the mediator job directory writable, inspect the application repository yourself, and ask for a new job id if the results are needed.',
        git_final: gitRecord(final, false),
        artifacts: {},
      });
    }
    return this.#update(job, record, {
      state: outcome.state,
      completion: outcome.completion,
      error: outcome.error,
      recovery: outcome.recovery,
      git_final: gitRecord(final, exported.withheld === null),
      evidence: {
        transcript_found: evidence.transcript_found,
        skill_invoked: evidence.skill_invoked,
        args_match: evidence.args_match,
        cwd_match: evidence.cwd_match,
      },
      artifacts,
    });
  }

  #decide(record: ExecutionRecord, ending: Ending, final: GitSnapshot, evidence: SessionEvidence, exported: ExportResult, drift: string | null = null): Outcome {
    const session = record.session!;
    const resume = `In the application repository run \`claude --resume ${session.id}\` to look at or finish that session yourself, then run collect for this job again.`;
    const completion = ending.kind === 'observed' ? 'observed_exit' : ending.kind === 'operator_confirmed' ? 'operator_confirmed' : null;
    const stop = (state: ExecutionState, code: OutcomeCode, message: string, recovery: string | null): Outcome => ({
      state,
      completion,
      error: { code, message },
      recovery,
    });
    if (ending.kind === 'lost') {
      return stop('interrupted', 'adapter_interrupted', 'The adapter stopped while the session ran; its end was not observed.', resume);
    }
    if (drift !== null) {
      return stop(
        'needs_inspection',
        'acceptance_drift',
        `The repository changed after the final acceptance: ${drift} The collected results are not what was accepted.`,
        'Compare the collected diff with the accepted snapshot and inspect the application repository; the accepted snapshot itself is unchanged.',
      );
    }
    if (ending.kind === 'observed' && session.signal !== null) {
      return stop('interrupted', 'claude_signal', `Claude Code ended by signal ${session.signal}.`, resume);
    }
    if (final.head !== record.git_initial.head || final.index_sha256 !== record.git_initial.index_sha256) {
      const exit = ending.kind === 'observed' && session.exit_code !== 0 ? ` Claude Code also exited with code ${session.exit_code}.` : '';
      return stop(
        'failed',
        'git_changed',
        `HEAD or the Git index changed during the session (staging or commits); the adapter repaired nothing.${exit}`,
        'Inspect the repository yourself; the diff is against the HEAD before the session.',
      );
    }
    if (ending.kind === 'observed' && session.exit_code !== 0) {
      return stop('failed', 'claude_exit', `Claude Code exited with code ${session.exit_code}.`, 'Review the results. This job will not launch again; continue by hand or ask for a new job id.');
    }
    if (ending.kind === 'observed' && !ending.confirmed) {
      return stop('interrupted', 'not_confirmed', 'The session ended, but /implement was not confirmed as finished.', resume);
    }
    if (!evidence.transcript_found) {
      return stop('failed', 'transcript_missing', 'No transcript of the session was found, so /implement cannot be shown to have run.', 'Review the results; ask for a new job id to retry.');
    }
    if (!(evidence.skill_invoked && evidence.args_match && evidence.cwd_match)) {
      return stop(
        'failed',
        'skill_not_invoked',
        'The transcript does not show the personal /implement skill invoked with this instruction in the app repository as the first message.',
        'Review the results; the native /implement workflow did not demonstrably run. Ask for a new job id to retry.',
      );
    }
    if (exported.withheld !== null) {
      return stop('needs_inspection', 'export_withheld', exported.withheld, 'Inspect the changes in the application repository yourself; they were not exported to the mediator.');
    }
    return { state: 'completed', completion, error: null, recovery: null };
  }

  // Exports the changes, or withholds everything when that is not safe. Reasons
  // name categories and counts only: no paths, commands or other free text from
  // the repository or the session reach the mediator for a withheld export.
  async #export(job: JobDir, git: GitInspector, config: AppConfig, record: ExecutionRecord, final: GitSnapshot, evidence: SessionEvidence): Promise<ExportResult> {
    const reasons: string[] = [];
    let changes = await git.changeSet(record.git_initial.head, final);
    // Self-hosting: only what the session changed is exported; the existing work is named, not shown.
    let preexisting: PreexistingSummary | undefined;
    let header = '';
    if (record.preexisting !== undefined) {
      let baseline: PreexistingBaseline | undefined;
      try {
        baseline = await this.#readPreexisting(job, record);
      } catch {
        reasons.push('The baseline of the existing uncommitted work is missing or is not the recorded one; the changes of the session cannot be told apart from it.');
      }
      if (baseline !== undefined) {
        const separated = await separateExisting(config.repo, baseline.entries, changes);
        changes = separated.changes;
        preexisting = separated.summary;
        header = separated.header;
      }
    }
    const forbidden = [...changes.tracked, ...changes.untracked].filter((path) => isForbidden(path));
    if (forbidden.length > 0) {
      reasons.push(`${forbidden.length} changed credential-style path(s).`);
    }
    // Git-ignored files are never exported; credential-style ones that appeared or changed stop the export.
    // Only the private baseline counts. A record from before Review 02 keeps its
    // ignored_initial for history, but that is never used as a baseline: without
    // the private file the check cannot be shown complete, so nothing is exported.
    const baseline = await this.#readPrivateBaseline(job, record.job_id);
    const before = baseline.status === 'valid' ? baseline.state : undefined;
    const now = await this.#ignoredState(git);
    if (baseline.status === 'invalid') {
      reasons.push('The ignored-file baseline of the session is not readable as a baseline.');
    } else if (before === undefined) {
      reasons.push(
        record.ignored_initial !== null && record.ignored_initial !== undefined
          ? 'The record predates the private ignored-file baseline (Review 02); ignored files cannot be checked.'
          : 'The ignored-file baseline of the session is missing.',
      );
    } else if (before.complete !== true) {
      reasons.push('The ignored-file baseline of the session records an incomplete check.');
    } else if (now.complete !== true) {
      reasons.push('An ignored directory could not be checked completely for credential-style files (too large or unreadable).');
    }
    const conversions = await git.conversions([...changes.tracked, ...changes.untracked]);
    if (conversions > 0) {
      reasons.push(`${conversions} changed path(s) have content conversions (filter, eol, text with autocrlf, ident or encoding); a raw diff could misrepresent them.`);
    }
    // Both directions: entries that appeared, disappeared (also with their whole
    // ignored directory) or changed type or content.
    if (before !== undefined) {
      const paths = new Set([...Object.keys(before.credentials), ...Object.keys(now.credentials)]);
      let appeared = 0;
      let disappeared = 0;
      let changed = 0;
      for (const path of paths) {
        const [was, is] = [before.credentials[path], now.credentials[path]];
        if (was === undefined) appeared += 1;
        else if (is === undefined) disappeared += 1;
        else if (was !== is) changed += 1;
      }
      if (appeared + disappeared + changed > 0) {
        reasons.push(`Git-ignored credential-style entries: ${appeared} appeared, ${disappeared} disappeared, ${changed} changed.`);
      }
    }
    let built = { stopped: null as string | null, diff: '', newFiles: [] as ExportResult['newFiles'] };
    if (reasons.length === 0) {
      built = await git.buildDiff(changes, { maxDiffBytes: MAX_DIFF_BYTES, maxFiles: MAX_EXPORT_FILES });
      if (built.stopped !== null) {
        reasons.push(built.stopped);
      } else if (hasSecret(built.diff)) {
        reasons.push('The diff contains text that looks like a credential.');
      } else if (built.diff.includes(config.repo)) {
        reasons.push("The diff contains the application repository's host path.");
      }
    }
    if (reasons.length > 0) {
      return { withheld: reasons.join(' '), diff: '', changedPaths: [], newFiles: [], newIgnored: [], commands: [], moreCommands: 0, message: null, ...(preexisting === undefined ? {} : { preexisting }) };
    }
    const redact = (text: string) => text.split(config.repo).join('<app-repo>').split(homedir()).join('~');
    return {
      withheld: null,
      diff: `${header}${built.diff}`,
      changedPaths: [...changes.tracked, ...changes.untracked].slice(0, MAX_LISTED_PATHS),
      newFiles: built.newFiles,
      newIgnored: now.entries.filter((entry) => !before?.entries.includes(entry)).slice(0, 50),
      commands: evidence.commands.slice(0, MAX_COMMANDS).map((entry) => ({
        command: hasSecret(entry.command) ? '[withheld: looks like a credential]' : redact(entry.command).slice(0, 300),
        ok: entry.ok,
      })),
      moreCommands: Math.max(0, evidence.commands.length - MAX_COMMANDS),
      message: evidence.final_message === null || hasSecret(evidence.final_message) ? null : redact(evidence.final_message).slice(0, MAX_MESSAGE_CHARS),
      ...(preexisting === undefined ? {} : { preexisting }),
    };
  }

  async #writeArtifacts(job: JobDir, context: ArtifactContext): Promise<Record<string, string>> {
    const { record, outcome, final, evidence, exported, git } = context;
    const session = record.session!;
    const files: Record<string, string> = {};
    files['implementation.diff'] =
      exported.withheld === null ? exported.diff : `# Not exported: ${exported.withheld}\n# Inspect the application repository directly.\n`;
    files['new-files.md'] = [
      `# New files: ${record.app_id}/${record.job_id}`,
      '',
      exported.withheld !== null
        ? `Not exported: ${exported.withheld}`
        : exported.newFiles.length === 0
          ? 'No new untracked files outside `.software-factory/`.'
          : ['| Path | Bytes | SHA-256 | Export |', '|---|---|---|---|', ...exported.newFiles.map((f) => `| ${cell(f.path)} | ${f.bytes} | ${f.sha256 || '-'} | ${f.note} |`)].join('\n'),
      '',
      exported.newIgnored.length === 0
        ? 'No new Git-ignored entries.'
        : `New Git-ignored entries (not exported): ${exported.newIgnored.map(cell).join(', ')}`,
      '',
      `The instruction copy \`${record.destination}\` stays in the application repository as an untracked file.`,
      '',
    ].join('\n');
    files['checks.md'] = [
      `# Checks: ${record.app_id}/${record.job_id}`,
      '',
      '## Acceptance checks by the adapter',
      '',
      '| Time | Check | Result |',
      '|---|---|---|',
      ...record.checks.map((entry) => `| ${entry.at} | ${cell(entry.check)} | ${entry.ok ? 'ok' : 'failed'} |`),
      '',
      '## Fixed, read-only Git commands run while collecting',
      '',
      '| Command | Runs | Exit codes |',
      '|---|---|---|',
      ...git.log.map((entry) => `| git ${cell(entry.check)} | ${entry.runs} | ${entry.exit_codes.join(', ')} |`),
      '',
      '## Shell commands in the Claude session (from its transcript)',
      '',
      ...(exported.withheld !== null
        ? ['Not exported: the results are withheld for operator inspection.']
        : !evidence.transcript_found
        ? ['No transcript found.']
        : exported.commands.length === 0
          ? ['No shell commands were run in the session.']
          : ['| # | Command | Result |', '|---|---|---|', ...exported.commands.map((entry, index) => `| ${index + 1} | ${cell(entry.command)} | ${entry.ok ? 'ok' : 'error'} |`)]),
      ...(exported.moreCommands > 0 ? [`| … | ${exported.moreCommands} more not listed | |`] : []),
      '',
      'Session results are the tool status recorded by Claude Code (ok or error), not process exit codes.',
      '',
    ].join('\n');
    const row = (label: string, value: string | number | boolean | null) => `| ${label} | ${value === null ? '-' : cell(String(value))} |`;
    files['report.md'] = [
      `# Execution report: ${record.app_id}/${record.job_id}`,
      '',
      '| Field | Value |',
      '|---|---|',
      row('State', outcome.state),
      row('Error', outcome.error ? `${outcome.error.code}: ${outcome.error.message}` : null),
      row('How the end is known', outcome.completion),
      row('Request id (OpenClaw)', record.request_id),
      row('Instruction sha256', record.instruction_sha256),
      row('Instruction in the app repository', record.destination),
      row('Claude session id', session.id),
      row('Session mode', session.mode),
      row('Runner', session.runner),
      row('Started', session.started_at),
      row('Ended', session.ended_at),
      row('Exit code', session.exit_code),
      row('Signal', session.signal),
      row('Transcript found', evidence.transcript_found),
      row('/implement invoked (personal skill)', evidence.skill_invoked),
      row('Invoked with this instruction', evidence.args_match),
      row('In the app repository', evidence.cwd_match),
      row('HEAD before', record.git_initial.head),
      row('HEAD after', final.head),
      row('Index unchanged', final.index_sha256 === record.git_initial.index_sha256),
      row('Changed paths', exported.withheld === null ? exported.changedPaths.length : 'not exported'),
      ...(record.preexisting === undefined
        ? []
        : [
            row('Existing uncommitted work (self-hosting baseline)', `${record.preexisting.paths} path(s), sha256 ${record.preexisting.sha256}`),
            row('Existing work unchanged', exported.preexisting === undefined ? 'unknown' : exported.preexisting.untouched),
            row('Existing work changed by the session', exported.preexisting === undefined ? 'unknown' : exported.preexisting.changed.length + exported.preexisting.changed_more),
            row('Existing work reverted or removed by the session', exported.preexisting === undefined ? 'unknown' : exported.preexisting.removed.length + exported.preexisting.removed_more),
          ]),
      '',
      '## Changed paths',
      '',
      exported.changedPaths.length === 0 ? '_None exported._' : exported.changedPaths.map((path) => `- ${cell(path)}`).join('\n'),
      '',
      "## Claude's last message (excerpt, unverified)",
      '',
      exported.message === null ? '_Not available or withheld._' : exported.message.split('\n').map((line) => `    ${line}`).join('\n'),
      '',
      '## Notes',
      '',
      '- The adapter did not stage, commit, push, reset or clean anything.',
      '- `completed` means: the session ended normally and the operator confirmed /implement finished, the transcript shows the personal `/implement` skill invoked with this instruction in the app repository, HEAD and index are unchanged, and the results were exportable. It does not mean the work is correct; review the diff.',
      '- Artifact hashes are in `execution.json`.',
      '',
    ].join('\n');
    const artifacts: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
      const bytes = Buffer.from(content, 'utf8');
      await io(`writing ${name}`, () => writeJobFile(job, name, bytes, 'replace'));
      artifacts[name] = sha256(bytes);
    }
    return artifacts;
  }

  async #readRecord(job: JobDir): Promise<ExecutionRecord | undefined> {
    const buffer = await readJobFile(job, EXECUTION_FILE, MAX_RECORD_BYTES);
    if (buffer === undefined) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      parsed = undefined;
    }
    const checked = recordSchema.safeParse(parsed);
    if (!checked.success) {
      throw new FactoryJobError('invalid_record', `${job.path}/${EXECUTION_FILE} is not a valid execution record; it was left unchanged.`);
    }
    return checked.data;
  }

  async #requireRecord(job: JobDir, jobId: string): Promise<ExecutionRecord> {
    const record = await this.#readRecord(job);
    if (record === undefined) {
      throw new ExecutionError('wrong_state', `${jobId} has not been prepared.`);
    }
    return record;
  }

  #json(record: ExecutionRecord): Buffer {
    return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  async #update(job: JobDir, record: ExecutionRecord, changes: Partial<ExecutionRecord>): Promise<ExecutionRecord> {
    const stamp = now();
    const history = changes.state !== undefined && changes.state !== record.state ? [...record.history, { state: changes.state, at: stamp }] : record.history;
    const next = { ...record, ...changes, history, revision: record.revision + 1, updated_at: stamp };
    await io('writing execution.json', () => writeJobFile(job, EXECUTION_FILE, this.#json(next), 'replace'));
    return next;
  }
}
