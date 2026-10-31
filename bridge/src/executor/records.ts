// SF-009 records in a mediator job directory (factory-data/apps/<app>/jobs/<job>/). Every file
// has exactly one writer:
//   bridge (MCP tools)     authorization.json, review-<id>.json, context-<id>.json, acceptance-<id>.json
//   supervisor (local)     managed.json, iteration-NNN.{diff,report.md,snapshot.json}, continuation-NNN.md
// and is written completely (0600 temp file, fsync, then link or rename). A reader never trusts
// a file it did not write: it is read without following symlinks, must be a regular file of this
// user that nobody else can write, in a directory chain nobody else can write, within a size
// limit, and must match its strict schema. Requests are messages to the supervisor, never
// commands: the supervisor re-validates each one against its own state before acting on it.
// Nothing here contains a host path.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { FactoryJobError, ID_PATTERN, SHA256_PATTERN, type JobDir } from '../factory-jobs.js';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

export const AUTHORIZATION_FILE = 'authorization.json';
export const MANAGED_FILE = 'managed.json';
export const POLICY_VIEW_FILE = 'executor-policy.json';
export const HEARTBEAT_FILE = 'executor-heartbeat.json';
export const AUTHORIZATION_TTL_MS = 30 * 60 * 1000;
// The supervisor refreshes its heartbeat this often; three missed refreshes read as offline.
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_MANAGED_BYTES = 1024 * 1024;
export const MAX_FINDINGS = 50;
export const MAX_FINDING_CHARS = 4000;
export const MAX_SUMMARY_CHARS = 2000;
export const MAX_FOCUS_CHARS = 1000;
export const MAX_ITERATIONS = 200;
// An iteration's diff and report (the export's diff is at most 2 MiB; a withheld note is shorter).
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

export const ITERATION_PATTERN = /^iteration-\d{3}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// SF-010: the number of performed context actions (compact, reset) of a job. An autonomous review
// is bound to it: a context action after the review input was read makes that review stale.
export const contextEpoch = (record: Pick<ManagedRecord, 'context_actions'>): number => record.context_actions.filter((entry) => entry.outcome === 'performed').length;
export const iterationId = (number: number): string => `iteration-${String(number).padStart(3, '0')}`;
export const snapshotFiles = (id: string) => ({ diff: `${id}.diff`, report: `${id}.report.md`, snapshot: `${id}.snapshot.json` });
export const continuationFile = (number: number): string => `continuation-${String(number).padStart(3, '0')}.md`;
export const reviewFile = (id: string): string => `review-${id}.json`;
export const contextFile = (id: string): string => `context-${id}.json`;
export const acceptanceFile = (id: string): string => `acceptance-${id}.json`;
const REQUEST_FILE = /^(review|context|acceptance)-([0-9a-f-]{36})\.json$/;

const id = z.string().regex(ID_PATTERN);
const sha = z.string().regex(SHA256_PATTERN);
const uuid = z.string().regex(UUID_PATTERN);
const iso = z.iso.datetime();
const iteration = z.string().regex(ITERATION_PATTERN);
// Text from a reviewer: no NUL or other C0 controls except tab and newline.
const text = (max: number) => z.string().max(max).refine((value) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value), 'control characters are not allowed');

export const authorizationSchema = z.strictObject({
  schema: z.literal('software-factory.execution-authorization/v1'),
  authorization_id: uuid,
  app_id: id,
  job_id: id,
  request_id: uuid,
  instruction_sha256: sha,
  repo_identity: sha,
  permission_mode: z.literal('auto'),
  policy_epoch: z.number().int().min(1),
  issued_at: iso,
  expires_at: iso,
  // What wrote it: an authenticated MCP tool call. Not a signature of the person's chat text.
  issuer: z.literal('mcp:factory_authorize_execution'),
});
export type Authorization = z.infer<typeof authorizationSchema>;

export const findingSchema = z.strictObject({ text: text(MAX_FINDING_CHARS).min(1) });
// SF-010: who produced a review. Absent: an authenticated factory_submit_review MCP tool call (the
// only source before SF-010). autonomous_reviewer: the local review coordinator, under the
// operator's private per-job delegation (bridge/src/reviewer). It is not a signature: it tells the
// supervisor which extra checks apply (the delegation, the session and the context the review was
// made for) and the audit trail which reviewer it was. The MCP tool cannot set it.
export const reviewProvenanceSchema = z.strictObject({
  kind: z.literal('autonomous_reviewer'),
  event_id: sha,
  delegation_id: uuid,
  provider: id,
  session_id: uuid,
  // The number of performed context actions (compact, reset) when the review input was read.
  context_epoch: z.number().int().min(0),
});
export type ReviewProvenance = z.infer<typeof reviewProvenanceSchema>;
export const reviewSchema = z.strictObject({
  schema: z.literal('software-factory.review-request/v1'),
  review_id: uuid,
  app_id: id,
  job_id: id,
  iteration_id: iteration,
  snapshot_sha256: sha,
  summary: text(MAX_SUMMARY_CHARS),
  findings: z.array(findingSchema).min(1).max(MAX_FINDINGS),
  submitted_at: iso,
  provenance: reviewProvenanceSchema.optional(),
});
export type ReviewRequest = z.infer<typeof reviewSchema>;

export const contextSchema = z.strictObject({
  schema: z.literal('software-factory.context-request/v1'),
  request_id: uuid,
  app_id: id,
  job_id: id,
  iteration_id: iteration,
  session_id: uuid,
  action: z.enum(['compact', 'reset']),
  focus: text(MAX_FOCUS_CHARS),
  submitted_at: iso,
});
export type ContextRequest = z.infer<typeof contextSchema>;

export const acceptanceSchema = z.strictObject({
  schema: z.literal('software-factory.acceptance-request/v1'),
  acceptance_id: uuid,
  app_id: id,
  job_id: id,
  iteration_id: iteration,
  snapshot_sha256: sha,
  submitted_at: iso,
});
export type AcceptanceRequest = z.infer<typeof acceptanceSchema>;

// Job states (managed.json). "authorized" (an authorization without managed.json) is derived.
//   queued           authorized and checked, waiting for the session gate (nothing claimed)
//   blocked          a check refused the launch (diagnostic says which); nothing claimed
//   launching        authorization consumed, preparing and starting the one session
//   running          Claude is working on the current iteration
//   awaiting_review  Claude's turn and tasks settled; a snapshot is published; the session lives on
//   needs_operator   the session lives but needs a person: auto mode refused actions, a capture or
//                    context action failed, or auto mode is unavailable
//   approved         the final acceptance was received; the session is being ended and collected
//   closed           collected after the acceptance (execution.json says completed or why not)
//   failed           ended without acceptance with a failure (execution.json has the reason)
//   needs_inspection ended in a way that needs the operator to look at the repository
export const JOB_STATES = ['queued', 'blocked', 'launching', 'running', 'awaiting_review', 'needs_operator', 'approved', 'closed', 'failed', 'needs_inspection'] as const;
export type JobState = (typeof JOB_STATES)[number];
export const FINAL_JOB_STATES: readonly JobState[] = ['blocked', 'closed', 'failed', 'needs_inspection'];
// Iteration states: working → ready_for_review → changes_requested (→ next iteration) or accepted.
// snapshot_failed: the turn ended but no stable evidence could be captured; conflict: the tree
// changed while a review was pending; abandoned: the session ended during the iteration, or
// later stream work superseded a published boundary. A continuation retains the old evidence.
export const ITERATION_STATES = ['working', 'ready_for_review', 'changes_requested', 'accepted', 'snapshot_failed', 'conflict', 'abandoned'] as const;
export type IterationState = (typeof ITERATION_STATES)[number];

const fileRef = z.strictObject({ file: z.string().max(64), sha256: sha });
const blockedSchema = z.strictObject({ action: z.string().max(64), count: z.number().int().min(1) });
const diagnosticSchema = z.strictObject({ code: z.string().max(64), message: z.string().max(1000) });

export const managedSchema = z.strictObject({
  schema: z.literal('software-factory.managed-job/v1'),
  app_id: id,
  job_id: id,
  request_id: uuid,
  instruction_sha256: sha,
  authorization_id: uuid,
  permission_mode: z.literal('auto'),
  state: z.enum(JOB_STATES),
  revision: z.number().int().min(1),
  created_at: iso,
  updated_at: iso,
  diagnostic: diagnosticSchema.nullable(),
  session: z.strictObject({
    // process: none (not started or replaced and not yet restarted), alive, ending (the supervisor
    // is shutting it down and has not observed its exit), ended (exit observed, or job collected),
    // unconfirmed (the shutdown finished without an observed exit: it may still run; its lineage
    // entry stays open).
    process: z.enum(['none', 'alive', 'ending', 'ended', 'unconfirmed']),
    current_session_id: uuid.nullable(),
    lineage: z.array(z.strictObject({ session_id: uuid, reason: z.enum(['initial', 'reset']), started_at: iso, ended_at: iso.nullable() })).max(64),
  }),
  iterations: z
    .array(
      z.strictObject({
        id: iteration,
        number: z.number().int().min(1),
        state: z.enum(ITERATION_STATES),
        trigger: z.enum(['initial', 'review', 'continuation']),
        review_id: uuid.nullable(),
        started_at: iso,
        ready_at: iso.nullable(),
        snapshot: fileRef.nullable(),
        blocked_actions: z.array(blockedSchema).max(50),
        // Review 02: a failed turn end Claude Code reported after this iteration's snapshot was
        // published (its result subtype only). Such a snapshot is not acceptable.
        late_error: z.strictObject({ subtype: z.string().max(64), at: iso }).optional(),
      }),
    )
    .max(MAX_ITERATIONS),
  current_iteration: iteration.nullable(),
  // Review 02 (review 88e39f51): sending = recorded and being sent, not yet acknowledged by Claude
  // Code; delivered = Claude Code acknowledged that exact message (its replayed uuid); unconfirmed =
  // never acknowledged (the send failed, the acknowledgment did not come, or the supervisor ended).
  // SF-010: source is present only for a review of the autonomous reviewer (absent: an MCP tool call).
  reviews: z
    .array(
      z.strictObject({
        review_id: uuid,
        iteration_id: iteration,
        outcome: z.enum(['delivered', 'rejected', 'sending', 'unconfirmed']),
        reason: z.string().max(200).nullable(),
        at: iso,
        source: z.literal('autonomous_reviewer').optional(),
      }),
    )
    .max(1000),
  context_actions: z
    .array(
      z.strictObject({
        request_id: uuid,
        action: z.enum(['compact', 'reset']),
        iteration_id: iteration,
        outcome: z.enum(['performed', 'refused', 'failed']),
        reason: z.string().max(200).nullable(),
        continuation: fileRef.nullable(),
        session_id: uuid.nullable(),
        at: iso,
      }),
    )
    .max(1000),
  acceptances: z.array(z.strictObject({ acceptance_id: uuid, iteration_id: iteration, outcome: z.enum(['accepted', 'rejected']), reason: z.string().max(200).nullable(), at: iso })).max(100),
  // The SF-006 execution.json state once the session was collected.
  execution_state: z.string().max(32).nullable(),
  // Review 02 (R2-3): the approval step of this authorization failed with an error the supervisor
  // caught. Durable evidence besides refused/<id>: such a record is never considered again.
  approval_failed: z.literal(true).optional(),
  events: z.array(z.strictObject({ at: iso, event: z.string().max(64), detail: z.string().max(300).nullable() })).max(200),
});
export type ManagedRecord = z.infer<typeof managedSchema>;
export type IterationRecord = ManagedRecord['iterations'][number];

export const MAX_LISTED_PREEXISTING = 100;
export const preexistingSummarySchema = z.strictObject({
  paths: z.number().int().min(0),
  untouched: z.number().int().min(0),
  changed: z.array(z.string()).max(MAX_LISTED_PREEXISTING),
  removed: z.array(z.string()).max(MAX_LISTED_PREEXISTING),
  changed_more: z.number().int().min(0),
  removed_more: z.number().int().min(0),
});
export type PreexistingSummary = z.infer<typeof preexistingSummarySchema>;

export const snapshotSchema = z.strictObject({
  schema: z.literal('software-factory.review-snapshot/v1'),
  app_id: id,
  job_id: id,
  iteration_id: iteration,
  number: z.number().int().min(1),
  session_id: uuid,
  state: z.literal('ready_for_review'),
  captured_at: iso,
  // The source revision the work is based on (prepare) and what the tree is now.
  baseline: z.strictObject({ head: z.string().nullable(), index_sha256: sha }),
  current: z.strictObject({ head: z.string().nullable(), index_sha256: sha, tree_fingerprint: sha }),
  // Two captures around the export agreed (no writes during the capture).
  stable: z.literal(true),
  background_processes: z.number().int().min(0),
  // Review 02: the quiescent boundary observed before the capture (absent in older snapshots):
  // how long the supervisor waited, how many distinct processes of the session it waited for, and
  // the quiet window (no process of the session, no output, the same fingerprint) it required.
  quiescence: z.strictObject({ waited_ms: z.number().int().min(0), writers_waited_for: z.number().int().min(0), quiet_ms: z.number().int().min(0) }).optional(),
  export: z.strictObject({
    withheld: z.string().nullable(),
    changed_paths: z.array(z.string()),
    new_files: z.array(z.strictObject({ path: z.string(), bytes: z.number().int(), sha256: z.string(), note: z.string() })),
    // Self-hosting only (absent otherwise): the uncommitted work that existed before the job, left
    // out of the diff while unchanged. changed and removed: such paths the session changed since,
    // or reverted or deleted (at most MAX_LISTED_PREEXISTING each, then *_more counts the rest).
    preexisting: preexistingSummarySchema.optional(),
  }),
  checks: z.array(z.strictObject({ command: z.string(), ok: z.boolean() })),
  last_message: z.string().nullable(),
  blocked_actions: z.array(blockedSchema),
  turn: z.strictObject({ subtype: z.string().max(64), is_error: z.boolean(), num_turns: z.number().int().nullable() }),
  artifacts: z.strictObject({ diff: fileRef, report: fileRef }),
});
export type ReviewSnapshot = z.infer<typeof snapshotSchema>;

export const policyViewSchema = z.strictObject({
  schema: z.literal('software-factory.executor-policy-view/v1'),
  app_id: id,
  enabled: z.boolean(),
  policy_epoch: z.number().int().min(1),
  // An opaque, salted identity of the registered repository (not its path).
  repo_identity: sha.nullable(),
  permission_mode: z.literal('auto'),
  // none: not enabled for automatic execution (no enforceable sandbox); disposable_pilot: the
  // operator declared the app a disposable pilot; self_hosting_unconfined: the operator's separate
  // opt-in for the Software Factory checkout itself (policy.ts). Never a claim of a sandbox.
  isolation: z.enum(['none', 'disposable_pilot', 'self_hosting_unconfined']),
  updated_at: iso,
});
export type PolicyView = z.infer<typeof policyViewSchema>;

// Discovery bounds (Review 01, R1-4): the supervisor scans at most this many apps and jobs, the
// bridge lists at most this many review-ready entries. Hitting a bound is reported, never silent.
export const SCAN_LIMITS = { apps: 100, jobs: 5000, readyJobsPerApp: 1000, ready: 200 } as const;
export type ScanLimits = { -readonly [K in keyof typeof SCAN_LIMITS]: number };
// Why a discovery or listing is incomplete. *_not_directory includes a symlink substituted for a
// directory (never followed); enumeration_race: an entry vanished between listing and reading it.
export const SCAN_ISSUES = [
  'apps_unreadable',
  'apps_not_directory',
  'app_limit',
  'app_not_directory',
  'jobs_unreadable',
  'jobs_not_directory',
  'job_limit',
  'job_unreadable',
  'ready_limit',
  'enumeration_race',
] as const;
export type ScanIssueCode = (typeof SCAN_ISSUES)[number];
export const MAX_SCAN_ISSUES = 20;
const scanIssueSchema = z.strictObject({ code: z.enum(SCAN_ISSUES), app_id: id.nullable(), count: z.number().int().min(1) });
export type ScanIssue = z.infer<typeof scanIssueSchema>;
// complete: every app and job directory was listed and read. Ids and counts only, never paths.
export const scanSchema = z.strictObject({
  complete: z.boolean(),
  at: iso,
  apps: z.number().int().min(0),
  jobs: z.number().int().min(0),
  issues: z.array(scanIssueSchema).max(MAX_SCAN_ISSUES),
  // More distinct issues than listed.
  more_issues: z.boolean(),
});
export type ScanSummary = z.infer<typeof scanSchema>;

export const heartbeatSchema = z.strictObject({
  schema: z.literal('software-factory.executor-heartbeat/v1'),
  state: z.enum(['running', 'stopped']),
  policy_epoch: z.number().int().min(0),
  started_at: iso,
  updated_at: iso,
  // The last discovery pass (absent before the first, and in heartbeats written before Review 01).
  scan: scanSchema.optional(),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

// A file another component wrote: regular, this user's, not writable by group or others,
// within maxBytes; read without following symlinks. Undefined when it does not exist.
export async function readTrustedFile(path: string, label: string, maxBytes: number): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new FactoryJobError('forbidden_path', `${label} ${code === 'ELOOP' ? 'is a symlink' : `cannot be opened (${code ?? 'error'})`}.`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.uid !== process.getuid!() || (stats.mode & 0o022) !== 0) {
      throw new FactoryJobError('forbidden_path', `${label} is not a regular file of this user that only this user can write.`);
    }
    if (stats.size > maxBytes) throw new FactoryJobError('too_large', `${label} is larger than ${maxBytes} bytes.`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// The job directory and its parents up to factory-data must be plain directories of this user.
// The job, jobs and app directories must not be writable by group or others; factory-data and
// factory-data/apps (on this host 0775 with a private user group) must not be world-writable.
export async function checkJobDirectory(job: JobDir): Promise<void> {
  let dir = job.dir;
  for (let depth = 0; depth < 5; depth += 1) {
    const stats = await lstat(dir);
    const forbidden = depth < 3 ? 0o022 : 0o002;
    if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== process.getuid!() || (stats.mode & forbidden) !== 0) {
      throw new FactoryJobError('forbidden_path', `${job.path} or a directory above it is not a private directory of this user.`);
    }
    dir = dirname(dir);
  }
}

export async function readRecord<T>(job: JobDir, name: string, schema: z.ZodType<T>, maxBytes = MAX_REQUEST_BYTES): Promise<T | undefined> {
  const label = `${job.path}/${name}`;
  const buffer = await readTrustedFile(join(job.dir, name), label, maxBytes);
  if (buffer === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new FactoryJobError('invalid_record', `${label} is not JSON; it was left unchanged.`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FactoryJobError('invalid_record', `${label} does not match its schema (${issue?.path.join('.') || 'record'}: ${issue?.message ?? 'invalid'}); it was left unchanged.`);
  }
  return parsed.data;
}

// Review 02 (R2-4): the diff and report a snapshot names, verified. They must be this iteration's
// own files (never another name), regular files of this user read without following a symlink,
// within MAX_ARTIFACT_BYTES, and hash to what the snapshot records. Anything else throws
// invalid_record (forbidden_path or too_large from the read itself): the bytes are never used.
export async function verifiedArtifacts(job: JobDir, snapshot: ReviewSnapshot): Promise<{ diff: Buffer; report: Buffer }> {
  const expected = snapshotFiles(snapshot.iteration_id);
  const { diff: diffRef, report: reportRef } = snapshot.artifacts;
  if (diffRef.file !== expected.diff || reportRef.file !== expected.report) {
    throw new FactoryJobError('invalid_record', `The snapshot of ${snapshot.iteration_id} names artifacts that are not its own; it is not evidence.`);
  }
  const diff = await readTrustedFile(join(job.dir, diffRef.file), `${job.path}/${diffRef.file}`, MAX_ARTIFACT_BYTES);
  const report = await readTrustedFile(join(job.dir, reportRef.file), `${job.path}/${reportRef.file}`, MAX_ARTIFACT_BYTES);
  if (diff === undefined || report === undefined || sha256(diff) !== diffRef.sha256 || sha256(report) !== reportRef.sha256) {
    throw new FactoryJobError('invalid_record', `An artifact of ${snapshot.iteration_id} is missing or does not match its sha256; the snapshot is not evidence.`);
  }
  return { diff, report };
}

// Whether the session is leaving although the job's state does not say so yet: nothing can act on a
// request any more. A job with no process ('none') is not leaving: it can still be reset or accepted.
export function sessionClosing(record: Pick<ManagedRecord, 'state' | 'session'>): boolean {
  const { process } = record.session;
  return process === 'ending' || ((process === 'ended' || process === 'unconfirmed') && !['closed', 'failed', 'needs_inspection', 'blocked'].includes(record.state));
}

export const readManaged = (job: JobDir): Promise<ManagedRecord | undefined> => readRecord(job, MANAGED_FILE, managedSchema, MAX_MANAGED_BYTES);

// The issue for a listIds result at the apps root ("apps") or in one app's jobs directory ("jobs").
export function listingIssue(level: 'apps' | 'jobs', issue: 'unreadable' | 'not_directory' | 'limit' | 'race'): ScanIssueCode {
  if (issue === 'limit') return level === 'apps' ? 'app_limit' : 'job_limit';
  return issue === 'race' ? 'enumeration_race' : `${level}_${issue}`;
}

// Collects scan issues, bounded: one entry per (code, app), at most MAX_SCAN_ISSUES entries.
export class ScanIssues {
  readonly #entries = new Map<string, ScanIssue>();
  #more = false;

  add(code: ScanIssueCode, appId: string | null = null): void {
    const key = `${code}/${appId ?? ''}`;
    const entry = this.#entries.get(key);
    if (entry !== undefined) entry.count += 1;
    else if (this.#entries.size < MAX_SCAN_ISSUES) this.#entries.set(key, { code, app_id: appId, count: 1 });
    else this.#more = true;
  }

  get empty(): boolean {
    return this.#entries.size === 0 && !this.#more;
  }

  summary(at: string, apps: number, jobs: number): ScanSummary {
    return { complete: this.empty, at, apps, jobs, issues: [...this.#entries.values()], more_issues: this.#more };
  }
}

// The id-named entries of one directory level, sorted, at most limit. A missing directory is a
// clean empty listing. A path that is not a plain directory (a symlink is never followed), cannot
// be read, or vanished while being listed yields no names and an issue; more entries than the
// limit yields the first limit names and "limit".
export async function listIds(path: string, limit: number): Promise<{ names: string[]; issue: 'unreadable' | 'not_directory' | 'limit' | 'race' | null }> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    return { names: [], issue: (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable' };
  }
  if (!stats.isDirectory()) return { names: [], issue: 'not_directory' };
  let all: string[];
  try {
    all = (await readdir(path)).filter((name) => ID_PATTERN.test(name)).sort();
  } catch (error) {
    return { names: [], issue: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'race' : 'unreadable' };
  }
  return all.length > limit ? { names: all.slice(0, limit), issue: 'limit' } : { names: all, issue: null };
}

// The request files of a job, by kind, in name order (ids are random; order comes from submitted_at).
export async function listRequests(job: JobDir): Promise<Array<{ kind: 'review' | 'context' | 'acceptance'; id: string; name: string }>> {
  const found: Array<{ kind: 'review' | 'context' | 'acceptance'; id: string; name: string }> = [];
  for (const name of (await readdir(job.dir)).sort()) {
    const match = REQUEST_FILE.exec(name);
    if (match && UUID_PATTERN.test(match[2]!)) found.push({ kind: match[1] as 'review' | 'context' | 'acceptance', id: match[2]!, name });
    if (found.length >= 5000) break;
  }
  return found;
}

export function toJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
