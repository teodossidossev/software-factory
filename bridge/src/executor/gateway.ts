// SF-009, bridge side: the narrow MCP operations for automatic execution and review iterations.
// The bridge never starts anything. It validates a request against what it can see (the stored
// instruction, the accepted dispatch and receipt, the public policy view, the supervisor's
// managed.json and published snapshots) and writes one request file for the local supervisor,
// which validates it again against private state before acting (records.ts, supervisor.ts).
//
// Trust boundary: a call arrives as an authenticated MCP tool invocation from the ChatGPT
// connector. That is what the bridge knows; it is not cryptographic proof of the person's chat
// text, and no signed approval token exists. What makes a launch possible is the operator's own
// one-time local opt-in (policy.ts) plus this call bound to the exact job, instruction hash,
// request id, repository identity, auto mode, policy epoch and an expiry. Statuses report what is
// recorded: "authorized" is not "started", and an offline supervisor is reported as such.
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type * as z from 'zod/v4';
import { checkAcceptedReceipt, readDispatchRecord } from '../dispatch.js';
import { APPS_PATH, FactoryJobError, FactoryJobs, jobFileExists, readJobFile, writeJobFile, type JobDir } from '../factory-jobs.js';
import { EXECUTION_FILE } from '../execution/service.js';
import { readInstruction } from '../instruction-store.js';
import {
  acceptanceFile,
  AUTHORIZATION_FILE,
  AUTHORIZATION_TTL_MS,
  authorizationSchema,
  contextFile,
  contextSchema,
  HEARTBEAT_FILE,
  HEARTBEAT_INTERVAL_MS,
  heartbeatSchema,
  listIds,
  listingIssue,
  listRequests,
  MAX_MANAGED_BYTES,
  MAX_REQUEST_BYTES,
  POLICY_VIEW_FILE,
  policyViewSchema,
  readManaged,
  readRecord,
  readTrustedFile,
  reviewFile,
  reviewSchema,
  SCAN_LIMITS,
  ScanIssues,
  snapshotSchema,
  toJson,
  verifiedArtifacts,
  acceptanceSchema,
  contextEpoch,
  type ReviewProvenance,
  type AcceptanceRequest,
  type Authorization,
  type ContextRequest,
  type ManagedRecord,
  type PolicyView,
  type ReviewRequest,
  type ReviewSnapshot,
  type ScanLimits,
  type ScanSummary,
  sessionClosing,
} from './records.js';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const MAX_REPORT_CHARS = 60_000;

export interface AuthorizeInput {
  app_id: string;
  job_id: string;
  request_id: string;
  instruction_sha256: string;
  repo_identity: string;
  permission_mode: 'auto';
  policy_epoch: number;
  authorization_id: string;
}

export interface ReviewInput {
  app_id: string;
  job_id: string;
  iteration_id: string;
  snapshot_sha256: string;
  review_id: string;
  summary?: string;
  findings: Array<{ text: string }>;
}

export interface ContextInput {
  app_id: string;
  job_id: string;
  iteration_id: string;
  session_id: string;
  action: 'compact' | 'reset';
  request_id: string;
  focus?: string;
}

export interface AcceptInput {
  app_id: string;
  job_id: string;
  iteration_id: string;
  snapshot_sha256: string;
  acceptance_id: string;
}

// What the bridge can honestly say about a job. "status" is one of:
//   not_authorized        no authorization recorded
//   pending_supervisor    authorized; the supervisor is online, its last discovery scan was complete, and
//                         it has not taken the job yet
//   scan_incomplete       authorized; the supervisor is online but its last discovery scan was incomplete
//                         (a bound, an unreadable or substituted directory, a race): this job may be outside
//                         what it sees. Nothing was started; see supervisor.scan
//   needs_operator        authorized, but the supervisor is offline or not opted in (the operator must
//                         start or enable it), or a live session needs a person (see diagnostic)
//   queued | blocked | launching | running | awaiting_review | approved | closed | failed | needs_inspection
//                         as the supervisor recorded it (managed.json)
export interface ExecutionStatus {
  app_id: string;
  job_id: string;
  status: string;
  policy: { enabled: boolean; policy_epoch: number; repo_identity: string | null; permission_mode: 'auto'; isolation: PolicyView['isolation'] } | null;
  supervisor: { online: boolean; state: string | null; updated_at: string | null; scan: ScanSummary | null };
  authorization: { authorization_id: string; expires_at: string; expired: boolean } | null;
  job: {
    state: string;
    diagnostic: { code: string; message: string } | null;
    current_iteration: string | null;
    current_session_id: string | null;
    session_process: string;
    sessions: number;
    iterations: Array<{ id: string; state: string; snapshot_sha256: string | null; blocked_actions: Array<{ action: string; count: number }> }>;
    // source: mcp (a factory_submit_review call) or autonomous_reviewer (SF-010).
    reviews: Array<{ review_id: string; iteration_id: string; outcome: string; reason: string | null; source: 'mcp' | 'autonomous_reviewer' }>;
    context_actions: Array<{ request_id: string; action: string; outcome: string; reason: string | null; continuation: string | null }>;
    acceptances: Array<{ acceptance_id: string; iteration_id: string; outcome: string; reason: string | null }>;
    execution_state: string | null;
    revision: number;
  } | null;
  note: string;
}

export type ReviewReadyList = ScanSummary & {
  ready: Array<{ app_id: string; job_id: string; iteration_id: string; snapshot_sha256: string; job_state: string; ready_at: string | null }>;
};

export class ExecutionGateway {
  readonly #jobs: FactoryJobs;
  readonly #root: string;
  readonly #now: () => Date;

  readonly #limits: Pick<ScanLimits, 'apps' | 'readyJobsPerApp' | 'ready'>;

  // limits: SCAN_LIMITS; tests lower them to reach the bounds quickly.
  constructor(jobs: FactoryJobs, repoRoot: string, now: () => Date = () => new Date(), limits: Pick<ScanLimits, 'apps' | 'readyJobsPerApp' | 'ready'> = SCAN_LIMITS) {
    this.#jobs = jobs;
    this.#root = repoRoot;
    this.#now = now;
    this.#limits = limits;
  }

  async #policyView(appId: string): Promise<PolicyView | undefined> {
    const path = `${APPS_PATH}/${appId}/${POLICY_VIEW_FILE}`;
    const buffer = await readTrustedFile(join(this.#root, path), path, 16 * 1024);
    if (buffer === undefined) return undefined;
    const parsed = policyViewSchema.safeParse(JSON.parse(buffer.toString('utf8')));
    if (!parsed.success || parsed.data.app_id !== appId) throw new FactoryJobError('invalid_record', `${path} is not a valid executor policy view.`);
    return parsed.data;
  }

  async #supervisor(): Promise<ExecutionStatus['supervisor']> {
    try {
      const buffer = await readTrustedFile(join(this.#root, 'factory-data', HEARTBEAT_FILE), `factory-data/${HEARTBEAT_FILE}`, 16 * 1024);
      if (buffer === undefined) return { online: false, state: null, updated_at: null, scan: null };
      const heartbeat = heartbeatSchema.parse(JSON.parse(buffer.toString('utf8')));
      const fresh = this.#now().getTime() - Date.parse(heartbeat.updated_at) <= 3 * HEARTBEAT_INTERVAL_MS;
      return { online: heartbeat.state === 'running' && fresh, state: heartbeat.state, updated_at: heartbeat.updated_at, scan: heartbeat.scan ?? null };
    } catch {
      return { online: false, state: 'unreadable', updated_at: null, scan: null };
    }
  }

  // ---- factory_authorize_execution ----

  async authorize(input: AuthorizeInput): Promise<ExecutionStatus & { authorization_path: string; replayed: boolean }> {
    if (input.permission_mode !== 'auto') throw new FactoryJobError('invalid_content', 'Only the auto permission mode can be authorized.');
    const replayed = await this.#jobs.withJob(input.app_id, input.job_id, false, async (job) => {
      const instruction = await readInstruction(job);
      if (instruction === undefined) throw new FactoryJobError('not_found', `${job.path}/instruction.md does not exist.`);
      if (instruction.sha256 !== input.instruction_sha256) throw new FactoryJobError('sha256_mismatch', `${instruction.path} has sha256 ${instruction.sha256}, not the authorized ${input.instruction_sha256}.`);
      const dispatch = await readDispatchRecord(job, input.app_id, input.job_id);
      if (dispatch === undefined || dispatch.state !== 'accepted') throw new FactoryJobError('dispatch_conflict', `${input.app_id}/${input.job_id} has no accepted dispatch; request and confirm the dispatch first.`);
      await checkAcceptedReceipt(job, dispatch);
      if (dispatch.request_id !== input.request_id || dispatch.instruction_sha256 !== input.instruction_sha256) {
        throw new FactoryJobError('dispatch_conflict', 'The request id or instruction sha256 is not the accepted dispatch of this job.');
      }
      const view = await this.#policyView(input.app_id);
      if (view === undefined || !view.enabled) throw new FactoryJobError('conflict', `Automatic execution is not enabled for ${input.app_id} on the host (the operator's one-time opt-in is missing). Nothing was authorized.`);
      // Neither runnable isolation is a sandbox; the supervisor verifies the private opt-in again.
      if (view.isolation === 'none') {
        throw new FactoryJobError('conflict', `unsupported_isolation: no enforceable sandbox confines automatic execution for ${input.app_id}, and it is enabled neither as a disposable pilot nor for self-hosting. Nothing was authorized.`);
      }
      if (view.policy_epoch !== input.policy_epoch) throw new FactoryJobError('conflict', 'policy_epoch is not the current executor policy epoch; read factory_execution_status again.');
      if (view.repo_identity !== input.repo_identity) throw new FactoryJobError('conflict', 'repo_identity is not the registered repository of this app.');
      if (await jobFileExists(job, EXECUTION_FILE)) throw new FactoryJobError('conflict', `${input.app_id}/${input.job_id} already has an execution record; it cannot be authorized again.`);
      const existing = await readRecord(job, AUTHORIZATION_FILE, authorizationSchema);
      if (existing !== undefined) {
        const same =
          existing.authorization_id === input.authorization_id &&
          existing.request_id === input.request_id &&
          existing.instruction_sha256 === input.instruction_sha256 &&
          existing.repo_identity === input.repo_identity &&
          existing.policy_epoch === input.policy_epoch;
        if (same) return true;
        const managed = await readManaged(job);
        const launched = managed !== undefined && (managed.session.lineage.length > 0 || !['queued', 'blocked'].includes(managed.state));
        const live = Date.parse(existing.expires_at) > this.#now().getTime() && !(managed?.state === 'blocked' && managed.authorization_id === existing.authorization_id);
        if (launched || live) throw new FactoryJobError('conflict', `${input.app_id}/${input.job_id} already has a ${launched ? 'used' : 'valid'} authorization (${existing.authorization_id}); a different one is refused.`);
      }
      const issued = this.#now();
      const record: Authorization = {
        schema: 'software-factory.execution-authorization/v1',
        authorization_id: input.authorization_id,
        app_id: input.app_id,
        job_id: input.job_id,
        request_id: input.request_id,
        instruction_sha256: input.instruction_sha256,
        repo_identity: input.repo_identity,
        permission_mode: 'auto',
        policy_epoch: input.policy_epoch,
        issued_at: issued.toISOString(),
        expires_at: new Date(issued.getTime() + AUTHORIZATION_TTL_MS).toISOString(),
        issuer: 'mcp:factory_authorize_execution',
      };
      authorizationSchema.parse(record);
      await writeJobFile(job, AUTHORIZATION_FILE, toJson(record), existing === undefined ? 'create' : 'replace');
      return false;
    });
    const status = await this.status(input.app_id, input.job_id);
    return { ...status, authorization_path: `${APPS_PATH}/${input.app_id}/jobs/${input.job_id}/${AUTHORIZATION_FILE}`, replayed };
  }

  // ---- factory_execution_status ----

  async status(appId: string, jobId: string): Promise<ExecutionStatus> {
    const supervisor = await this.#supervisor();
    return this.#jobs.withJob(appId, jobId, false, async (job) => {
      const view = await this.#policyView(appId);
      const auth = await readRecord(job, AUTHORIZATION_FILE, authorizationSchema);
      const managed = await readManaged(job);
      const now = this.#now().getTime();
      const policy = view === undefined ? null : { enabled: view.enabled, policy_epoch: view.policy_epoch, repo_identity: view.repo_identity, permission_mode: view.permission_mode, isolation: view.isolation };
      let status: string;
      let note: string;
      // A record of an earlier authorization that never launched does not describe a newer authorization.
      const launched = managed !== undefined && managed.session.lineage.length > 0;
      const current = managed !== undefined && (launched || managed.authorization_id === auth?.authorization_id) ? managed : undefined;
      if (current !== undefined) {
        status = sessionClosing(current) ? 'session_ending' : current.state;
        note = describe(current);
        if (!supervisor.online && !['closed', 'failed', 'needs_inspection', 'blocked'].includes(current.state)) {
          note += ' The supervisor is not reporting (offline or stopped): nothing advances until the operator starts it.';
        }
      } else if (auth === undefined) {
        status = 'not_authorized';
        note = view?.enabled ? 'Not authorized. After the user explicitly approves this job, call factory_authorize_execution.' : 'Automatic execution is not enabled for this app on the host; the operator must opt in once (see the SF-009 runbook).';
      } else if (!view?.enabled) {
        status = 'needs_operator';
        note = 'Authorized, but automatic execution is not enabled on the host. Nothing was started.';
      } else if (!supervisor.online) {
        status = 'needs_operator';
        note = 'Authorized, but the local supervisor is not running. Nothing was started; the operator must start it.';
      } else if (supervisor.scan === null || !supervisor.scan.complete) {
        status = 'scan_incomplete';
        note =
          supervisor.scan === null
            ? 'Authorized; the supervisor has not reported a discovery scan yet, so it cannot be shown to see this job. Nothing was started yet.'
            : `Authorized, but the supervisor's last discovery scan was incomplete (${supervisor.scan.issues.map((issue) => issue.code).join(', ') || 'more issues'}): this job may be outside what it scans. Nothing was started; the operator must resolve the scan issues.`;
      } else {
        status = 'pending_supervisor';
        note = 'Authorized; the supervisor has not taken it yet. Nothing was started yet.';
      }
      return {
        app_id: appId,
        job_id: jobId,
        status,
        policy,
        supervisor,
        authorization: auth === undefined ? null : { authorization_id: auth.authorization_id, expires_at: auth.expires_at, expired: Date.parse(auth.expires_at) <= now },
        job: current === undefined ? null : jobView(current),
        note,
      };
    });
  }

  // ---- factory_list_review_ready ----

  // Bounded (SCAN_LIMITS). complete is false, with the issues, when an apps or jobs directory could
  // not be listed completely (unreadable, not a plain directory, a race) or a bound was hit: the
  // list then may omit ready jobs.
  async listReviewReady(appId: string | undefined): Promise<ReviewReadyList> {
    const issues = new ScanIssues();
    let apps: string[];
    if (appId === undefined) {
      const root = await listIds(join(this.#root, APPS_PATH), this.#limits.apps);
      if (root.issue !== null) issues.add(listingIssue('apps', root.issue));
      apps = root.names;
    } else {
      apps = [appId];
    }
    const ready: ReviewReadyList['ready'] = [];
    let jobsSeen = 0;
    for (const app of apps) {
      // An app directory that is not a plain directory (e.g. a substituted symlink) is never followed.
      const stats = await lstat(join(this.#root, APPS_PATH, app)).catch(() => undefined);
      if (stats === undefined) {
        if (appId === undefined) issues.add('enumeration_race', app);
        continue;
      }
      if (!stats.isDirectory()) {
        issues.add('app_not_directory', app);
        continue;
      }
      const jobs = await listIds(join(this.#root, APPS_PATH, app, 'jobs'), this.#limits.readyJobsPerApp);
      if (jobs.issue !== null) issues.add(listingIssue('jobs', jobs.issue), app);
      for (const jobId of jobs.names) {
        jobsSeen += 1;
        let managed: ManagedRecord | undefined;
        try {
          managed = await this.#jobs.withJob(app, jobId, false, (job) => readManaged(job));
        } catch {
          issues.add('job_unreadable', app);
          continue;
        }
        const iteration = managed?.iterations.find((entry) => entry.id === managed.current_iteration);
        if (managed === undefined || iteration === undefined || iteration.state !== 'ready_for_review' || iteration.snapshot === null) continue;
        if (!['awaiting_review', 'needs_operator'].includes(managed.state) || sessionClosing(managed)) continue;
        if (ready.length >= this.#limits.ready) {
          issues.add('ready_limit');
          return { ready, ...issues.summary(this.#now().toISOString(), apps.length, jobsSeen) };
        }
        ready.push({ app_id: app, job_id: jobId, iteration_id: iteration.id, snapshot_sha256: iteration.snapshot.sha256, job_state: managed.state, ready_at: iteration.ready_at });
      }
    }
    return { ready, ...issues.summary(this.#now().toISOString(), apps.length, jobsSeen) };
  }

  // ---- factory_review_snapshot ----

  // A published snapshot, verified: managed.json references it, its bytes hash to that sha256, and
  // its diff and report hash to what it records. Anything else is refused, never shown as evidence.
  async snapshot(appId: string, jobId: string, iterationId: string): Promise<{ snapshot: ReviewSnapshot; snapshot_sha256: string; snapshot_path: string; diff: { path: string; sha256: string; bytes: number }; report: { path: string; sha256: string; text: string; truncated: boolean }; current_iteration: string | null; job_state: string }> {
    return this.#jobs.withJob(appId, jobId, false, async (job) => {
      const managed = await readManaged(job);
      const iteration = managed?.iterations.find((entry) => entry.id === iterationId);
      if (managed === undefined || iteration === undefined || iteration.snapshot === null) throw new FactoryJobError('not_found', `${appId}/${jobId} has no published snapshot for ${iterationId}.`);
      const bytes = await readJobFile(job, iteration.snapshot.file, MAX_MANAGED_BYTES);
      if (bytes === undefined || sha256(bytes) !== iteration.snapshot.sha256) throw new FactoryJobError('invalid_record', `The snapshot of ${iterationId} does not match its recorded sha256; it is not evidence.`);
      const snapshot = snapshotSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (snapshot.app_id !== appId || snapshot.job_id !== jobId || snapshot.iteration_id !== iterationId) throw new FactoryJobError('invalid_record', 'The snapshot names another iteration.');
      const { diff, report } = await verifiedArtifacts(job, snapshot);
      const text = report.toString('utf8');
      return {
        snapshot,
        snapshot_sha256: iteration.snapshot.sha256,
        snapshot_path: `${job.path}/${iteration.snapshot.file}`,
        diff: { path: `${job.path}/${snapshot.artifacts.diff.file}`, sha256: snapshot.artifacts.diff.sha256, bytes: diff.byteLength },
        report: { path: `${job.path}/${snapshot.artifacts.report.file}`, sha256: snapshot.artifacts.report.sha256, text: text.slice(0, MAX_REPORT_CHARS), truncated: text.length > MAX_REPORT_CHARS },
        current_iteration: managed.current_iteration,
        job_state: managed.state,
      };
    });
  }

  // ---- shared request validation ----

  async #currentIteration(job: JobDir, appId: string, jobId: string, iterationId: string, snapshotSha: string | undefined): Promise<ManagedRecord> {
    const managed = await readManaged(job);
    if (managed === undefined) throw new FactoryJobError('not_found', `${appId}/${jobId} has no managed session.`);
    if (!['awaiting_review', 'needs_operator'].includes(managed.state)) throw new FactoryJobError('conflict', `${appId}/${jobId} is ${managed.state}; requests are accepted only while it awaits review.`);
    // Nothing would consume the request any more: it must not wait in the queue.
    if (sessionClosing(managed)) throw new FactoryJobError('conflict', `${appId}/${jobId}: the session is shutting down or has ended (${managed.session.process}); the request was not accepted.`);
    const iteration = managed.iterations.find((entry) => entry.id === managed.current_iteration);
    if (iteration === undefined || iteration.id !== iterationId) throw new FactoryJobError('conflict', `${iterationId} is not the current iteration (${managed.current_iteration ?? 'none'}); the request is stale.`);
    if (iteration.state !== 'ready_for_review' || iteration.snapshot === null) throw new FactoryJobError('conflict', `${iterationId} is ${iteration.state}, not ready for review.`);
    if (snapshotSha !== undefined && iteration.snapshot.sha256 !== snapshotSha) throw new FactoryJobError('sha256_mismatch', `The snapshot of ${iterationId} has sha256 ${iteration.snapshot.sha256}, not ${snapshotSha}.`);
    return managed;
  }

  // An identical request is an idempotent replay; the same id with other content, or a second
  // pending request for the same iteration, is a conflict.
  async #submit<T extends { iteration_id: string }>(
    job: JobDir,
    name: string,
    kind: 'review' | 'context' | 'acceptance',
    record: T,
    schema: z.ZodType<T>,
    comparable: (value: T) => string,
    handled: Set<string>,
  ): Promise<boolean> {
    const existing = await readRecord(job, name, schema);
    if (existing !== undefined) {
      if (comparable(existing) === comparable(record)) return true;
      throw new FactoryJobError('conflict', `${name} already exists with different content.`);
    }
    for (const request of await listRequests(job)) {
      if (request.kind !== kind || handled.has(request.id)) continue;
      const other = await readRecord(job, request.name, schema).catch(() => undefined);
      if (other !== undefined && other.iteration_id === record.iteration_id) {
        throw new FactoryJobError('conflict', `Another ${kind} request (${request.id}) for ${record.iteration_id} is still pending; wait for it.`);
      }
    }
    schema.parse(record);
    await writeJobFile(job, name, toJson(record), 'create');
    return false;
  }

  // ---- factory_submit_review ----

  async submitReview(input: ReviewInput): Promise<{ review_id: string; status: string; replayed: boolean; path: string }> {
    return this.#submitReview(input, undefined);
  }

  // SF-010: the same validation and the same request file for the local review coordinator
  // (bridge/src/reviewer), with its provenance recorded. Never reachable through MCP (server.ts
  // calls submitReview only). Additionally bound to the live session and context the review input
  // was read in. The supervisor checks all of it again, and the operator's delegation, before delivery.
  async submitAutonomousReview(input: ReviewInput, provenance: ReviewProvenance): Promise<{ review_id: string; status: string; replayed: boolean; path: string }> {
    return this.#submitReview(input, provenance);
  }

  async #submitReview(input: ReviewInput, provenance: ReviewProvenance | undefined): Promise<{ review_id: string; status: string; replayed: boolean; path: string }> {
    return this.#jobs.withJob(input.app_id, input.job_id, false, async (job) => {
      const record: ReviewRequest = {
        schema: 'software-factory.review-request/v1',
        review_id: input.review_id,
        app_id: input.app_id,
        job_id: input.job_id,
        iteration_id: input.iteration_id,
        snapshot_sha256: input.snapshot_sha256,
        summary: input.summary ?? '',
        findings: input.findings.map((finding) => ({ text: finding.text })),
        submitted_at: this.#now().toISOString(),
        ...(provenance === undefined ? {} : { provenance }),
      };
      const managed = await readManaged(job);
      const prior = managed?.reviews.find((review) => review.review_id === input.review_id);
      const comparable = (value: ReviewRequest) => JSON.stringify([value.iteration_id, value.snapshot_sha256, value.summary, value.findings, value.provenance ?? null]);
      if (prior !== undefined) {
        const existing = await readRecord(job, reviewFile(input.review_id), reviewSchema);
        if (existing === undefined || comparable(existing) !== comparable(record)) throw new FactoryJobError('conflict', `Review ${input.review_id} was already submitted with different content.`);
        return { review_id: input.review_id, status: prior.outcome, replayed: true, path: `${job.path}/${reviewFile(input.review_id)}` };
      }
      const current = await this.#currentIteration(job, input.app_id, input.job_id, input.iteration_id, input.snapshot_sha256);
      if (provenance !== undefined) {
        if (current.session.process !== 'alive' || current.session.current_session_id !== provenance.session_id) {
          throw new FactoryJobError('conflict', `session_replaced: the review was made for session ${provenance.session_id}, the current one is ${current.session.current_session_id ?? 'none'} (${current.session.process}).`);
        }
        if (contextEpoch(current) !== provenance.context_epoch) {
          throw new FactoryJobError('conflict', 'context_changed: a context action was performed after the review input was read.');
        }
      }
      // SF-010: never write an autonomous request the supervisor would refuse to read.
      if (provenance !== undefined && toJson(record).byteLength > MAX_REQUEST_BYTES) {
        throw new FactoryJobError('too_large', `The review request would be larger than ${MAX_REQUEST_BYTES} bytes; nothing was written.`);
      }
      const handled = new Set(current.reviews.map((review) => review.review_id));
      const replayed = await this.#submit(job, reviewFile(input.review_id), 'review', record, reviewSchema, comparable, handled);
      return { review_id: input.review_id, status: 'submitted', replayed, path: `${job.path}/${reviewFile(input.review_id)}` };
    });
  }

  // ---- factory_manage_session_context ----

  async manageContext(input: ContextInput): Promise<{ request_id: string; status: string; replayed: boolean; path: string }> {
    return this.#jobs.withJob(input.app_id, input.job_id, false, async (job) => {
      const record: ContextRequest = {
        schema: 'software-factory.context-request/v1',
        request_id: input.request_id,
        app_id: input.app_id,
        job_id: input.job_id,
        iteration_id: input.iteration_id,
        session_id: input.session_id,
        action: input.action,
        focus: input.focus ?? '',
        submitted_at: this.#now().toISOString(),
      };
      const managed = await readManaged(job);
      const prior = managed?.context_actions.find((action) => action.request_id === input.request_id);
      const comparable = (value: ContextRequest) => JSON.stringify([value.iteration_id, value.session_id, value.action, value.focus]);
      if (prior !== undefined) {
        const existing = await readRecord(job, contextFile(input.request_id), contextSchema);
        if (existing === undefined || comparable(existing) !== comparable(record)) throw new FactoryJobError('conflict', `Context request ${input.request_id} was already submitted with different content.`);
        return { request_id: input.request_id, status: prior.outcome, replayed: true, path: `${job.path}/${contextFile(input.request_id)}` };
      }
      const current = await this.#currentIteration(job, input.app_id, input.job_id, input.iteration_id, undefined);
      const resumable = input.action === 'reset' && current.session.process === 'none';
      if (current.session.current_session_id !== input.session_id && !resumable) {
        throw new FactoryJobError('conflict', `session_id is not the current session (${current.session.current_session_id ?? 'none'}).`);
      }
      const handled = new Set(current.context_actions.map((action) => action.request_id));
      const replayed = await this.#submit(job, contextFile(input.request_id), 'context', record, contextSchema, comparable, handled);
      return { request_id: input.request_id, status: 'submitted', replayed, path: `${job.path}/${contextFile(input.request_id)}` };
    });
  }

  // ---- factory_accept_job ----

  async accept(input: AcceptInput): Promise<{ acceptance_id: string; status: string; replayed: boolean; path: string }> {
    return this.#jobs.withJob(input.app_id, input.job_id, false, async (job) => {
      const record: AcceptanceRequest = {
        schema: 'software-factory.acceptance-request/v1',
        acceptance_id: input.acceptance_id,
        app_id: input.app_id,
        job_id: input.job_id,
        iteration_id: input.iteration_id,
        snapshot_sha256: input.snapshot_sha256,
        submitted_at: this.#now().toISOString(),
      };
      const managed = await readManaged(job);
      const prior = managed?.acceptances.find((entry) => entry.acceptance_id === input.acceptance_id);
      const comparable = (value: AcceptanceRequest) => JSON.stringify([value.iteration_id, value.snapshot_sha256]);
      if (prior !== undefined) {
        const existing = await readRecord(job, acceptanceFile(input.acceptance_id), acceptanceSchema);
        if (existing === undefined || comparable(existing) !== comparable(record)) throw new FactoryJobError('conflict', `Acceptance ${input.acceptance_id} was already submitted with different content.`);
        return { acceptance_id: input.acceptance_id, status: prior.outcome, replayed: true, path: `${job.path}/${acceptanceFile(input.acceptance_id)}` };
      }
      const current = await this.#currentIteration(job, input.app_id, input.job_id, input.iteration_id, input.snapshot_sha256);
      const handled = new Set(current.acceptances.map((entry) => entry.acceptance_id));
      const replayed = await this.#submit(job, acceptanceFile(input.acceptance_id), 'acceptance', record, acceptanceSchema, comparable, handled);
      return { acceptance_id: input.acceptance_id, status: 'submitted', replayed, path: `${job.path}/${acceptanceFile(input.acceptance_id)}` };
    });
  }
}

function describe(record: ManagedRecord): string {
  const diagnostic = record.diagnostic ? ` ${record.diagnostic.code}: ${record.diagnostic.message}` : '';
  if (record.session.process === 'unconfirmed') {
    return `The Claude process was not shown to have ended; the operator must find it.${diagnostic}`;
  }
  if (sessionClosing(record)) {
    return record.session.process === 'ending' ? `The session is shutting down; no exit observed yet.${diagnostic}` : `The session has ended (its exit was observed) and is being collected.${diagnostic}`;
  }
  switch (record.state) {
    case 'queued':
      return `Authorized and checked; waiting (nothing claimed or started).${diagnostic}`;
    case 'blocked':
      return `Not started: a check refused the launch.${diagnostic}`;
    case 'launching':
      return 'The authorization was consumed; the session is being prepared and started.';
    case 'running':
      return `Claude is working on ${record.current_iteration ?? 'the first iteration'}.`;
    case 'awaiting_review':
      return `Claude is idle and its session is alive. ${record.current_iteration} has a verified snapshot (factory_review_snapshot). This is not job completion.`;
    case 'needs_operator':
      return `The session needs attention.${diagnostic}`;
    case 'approved':
      return 'The final acceptance was received; the session is being ended and collected.';
    case 'closed':
      return `Closed after the final acceptance (execution ${record.execution_state ?? 'unknown'}). Git staging, commits and pushes remain the operator's.`;
    default:
      return `Ended: ${record.state}.${diagnostic}`;
  }
}

function jobView(record: ManagedRecord): NonNullable<ExecutionStatus['job']> {
  return {
    state: record.state,
    diagnostic: record.diagnostic,
    current_iteration: record.current_iteration,
    current_session_id: record.session.current_session_id,
    session_process: record.session.process,
    sessions: record.session.lineage.length,
    iterations: record.iterations.map((entry) => ({ id: entry.id, state: entry.state, snapshot_sha256: entry.snapshot?.sha256 ?? null, blocked_actions: entry.blocked_actions })),
    reviews: record.reviews.slice(-50).map((entry) => ({ review_id: entry.review_id, iteration_id: entry.iteration_id, outcome: entry.outcome, reason: entry.reason, source: entry.source ?? 'mcp' })),
    context_actions: record.context_actions.slice(-50).map((entry) => ({ request_id: entry.request_id, action: entry.action, outcome: entry.outcome, reason: entry.reason, continuation: entry.continuation?.file ?? null })),
    acceptances: record.acceptances.slice(-20).map((entry) => ({ acceptance_id: entry.acceptance_id, iteration_id: entry.iteration_id, outcome: entry.outcome, reason: entry.reason })),
    execution_state: record.execution_state,
    revision: record.revision,
  };
}
