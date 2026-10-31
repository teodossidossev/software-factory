// SF-010 records of the independent review coordinator. All of them live in the operator's private
// state directory (${XDG_STATE_HOME:-~/.local/state}/software-factory/reviewer, 0700/0600, outside
// the mediator), never in factory-data: ChatGPT, the bridge and the managed session cannot write them.
//
//   provider.json                          the operator's provider opt-in (which ReviewProvider may run)
//   delegations/<app>/<job>.json           the operator's per-job review delegation, with finite limits
//   revoked/<delegation_id>                a revocation marker (exclusive create; never undone)
//   events/<app>/<job>/<event_id>.json     durable review-ready events (one per published snapshot)
//   jobs/<app>/<job>.json                  the coordinator's own per-job state: budgets and reviews
//   coordinator/execution.lock             one coordinator per user
//
// Nothing here holds a secret, a transcript, a host path or a process argument. An event or a
// delegation never authorizes an execution; a delegation authorizes review only, for one job.
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { ID_PATTERN, SHA256_PATTERN } from '../factory-jobs.js';
import { ITERATION_PATTERN, MAX_FINDING_CHARS, MAX_FINDINGS, MAX_SUMMARY_CHARS } from '../executor/records.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id = z.string().regex(ID_PATTERN);
const sha = z.string().regex(SHA256_PATTERN);
const uuid = z.string().regex(UUID_PATTERN);
const iso = z.iso.datetime();
const iteration = z.string().regex(ITERATION_PATTERN);
const code = z.string().regex(/^[a-z0-9_]{1,64}$/);
// Untrusted text (provider output): no NUL or other C0 controls except tab and newline.
export const safeText = (max: number) => z.string().max(max).refine((value) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value), 'control characters are not allowed');

// The hard ceilings of a delegation. A delegation must name every limit, each within these.
export const LIMIT_CEILINGS = {
  max_attempts: 20,
  max_reviews: 20,
  max_elapsed_ms: 24 * 60 * 60 * 1000,
  max_input_bytes: 8 * 1024 * 1024,
  attempt_timeout_ms: 30 * 60 * 1000,
} as const;
export const limitsSchema = z.strictObject({
  // Provider calls in total for this job (every retry and every invalid response counts).
  max_attempts: z.number().int().min(1).max(LIMIT_CEILINGS.max_attempts),
  // Reviewed iterations (findings submitted or a clean verdict) in total for this job.
  max_reviews: z.number().int().min(1).max(LIMIT_CEILINGS.max_reviews),
  // Wall time from the delegation's creation after which nothing new is started.
  max_elapsed_ms: z.number().int().min(1000).max(LIMIT_CEILINGS.max_elapsed_ms),
  // The verified review input of one iteration (instruction, snapshot, diff and report bytes).
  max_input_bytes: z.number().int().min(1024).max(LIMIT_CEILINGS.max_input_bytes),
  // One provider call.
  attempt_timeout_ms: z.number().int().min(100).max(LIMIT_CEILINGS.attempt_timeout_ms),
});
export type ReviewLimits = z.infer<typeof limitsSchema>;

export const DELEGATION_SCHEMA = 'software-factory.review-delegation/v1';
export const delegationSchema = z.strictObject({
  schema: z.literal(DELEGATION_SCHEMA),
  delegation_id: uuid,
  app_id: id,
  job_id: id,
  // The execution authorization of the managed job this review delegation is for. Binding it does
  // not make the authorization a review delegation: both are required, and this file is the only
  // source of review authority.
  authorization_id: uuid,
  provider: id,
  limits: limitsSchema,
  created_at: iso,
  expires_at: iso,
  issuer: z.literal('operator:sf010-reviewer delegate'),
});
export type ReviewDelegation = z.infer<typeof delegationSchema>;

export const PROVIDER_OPT_IN_SCHEMA = 'software-factory.reviewer-provider/v1';
export const providerOptInSchema = z.strictObject({
  schema: z.literal(PROVIDER_OPT_IN_SCHEMA),
  provider: id,
  enabled_at: iso,
  issuer: z.literal('operator:sf010-reviewer provider-enable'),
});
export type ProviderOptIn = z.infer<typeof providerOptInSchema>;

// A review-ready event: "this exact snapshot was published and is referenced by managed.json".
// It is a notification with a stable identity, not an instruction and not an authorization.
export const EVENT_SCHEMA = 'software-factory.review-ready-event/v1';
export const eventSchema = z.strictObject({
  schema: z.literal(EVENT_SCHEMA),
  event_id: sha,
  app_id: id,
  job_id: id,
  iteration_id: iteration,
  iteration_number: z.number().int().min(1),
  snapshot_sha256: sha,
  // supervisor: written right after the publication; reconciliation: recovered later from managed.json.
  source: z.enum(['supervisor', 'reconciliation']),
  created_at: iso,
});
export type ReviewReadyEvent = z.infer<typeof eventSchema>;

// The deterministic identity of a review-ready event: schema, app, job, iteration and snapshot.
export function eventId(appId: string, jobId: string, iterationId: string, snapshotSha256: string): string {
  return createHash('sha256').update(`${EVENT_SCHEMA}\0${appId}\0${jobId}\0${iterationId}\0${snapshotSha256}`).digest('hex');
}

// The deterministic review id of an event (a version-8 UUID from its hash): every coordinator, and
// every restart, submits the review of one event under the same id, so the bridge's replay rule
// and the supervisor's handled set make a second delivery impossible.
export function reviewIdOf(event: string): string {
  const hex = createHash('sha256').update(`software-factory.autonomous-review/v1\0${event}`).digest('hex');
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// What a provider may return (validated; anything else is an invalid response and costs an attempt).
export const MAX_PROVIDER_FINDINGS = Math.min(MAX_FINDINGS, 30);
export const SEVERITIES = ['blocker', 'major', 'minor'] as const;
export const providerFindingSchema = z.strictObject({
  // A path the snapshot changed (validated against the review input), or null for a general finding.
  file: z.string().min(1).max(512).nullable(),
  line: z.number().int().min(1).max(10_000_000).nullable(),
  severity: z.enum(SEVERITIES),
  text: safeText(MAX_FINDING_CHARS - 600).min(1),
});
export type ProviderFinding = z.infer<typeof providerFindingSchema>;
export const providerResponseSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('findings'), summary: safeText(MAX_SUMMARY_CHARS), findings: z.array(providerFindingSchema).min(1).max(MAX_PROVIDER_FINDINGS) }),
  z.strictObject({ outcome: z.literal('clean'), summary: safeText(MAX_SUMMARY_CHARS) }),
  // The provider declines to review this input (e.g. it judged the material unsafe to process).
  z.strictObject({ outcome: z.literal('refusal'), code, summary: safeText(MAX_SUMMARY_CHARS) }),
  z.strictObject({ outcome: z.literal('error'), code, retryable: z.boolean() }),
]);
export type ProviderResponse = z.infer<typeof providerResponseSchema>;

// The life of one event's review (jobs/<app>/<job>.json reviews[]):
//   pending            seen, nothing started
//   provider_running   an attempt was counted and the provider called (a crash here costs that attempt)
//   submitting         findings are recorded here (fixed content) and are being submitted
//   submitted          the request file exists in the job directory; the supervisor decides
//   delivered          the supervisor recorded the review as acknowledged by the same session
// Terminal codes, each visible in status:
//   clean_awaiting_acceptance  a clean verdict bound to the snapshot; the operator decides
//   rejected                   the supervisor refused the review (reason recorded)
//   unconfirmed                the supervisor could not confirm delivery; never resent
//   superseded                 the snapshot is no longer the current one (stale; nothing delivered)
//   competing_review           another review of this iteration was pending or handled first
//   input_blocked              withheld, oversized, malformed or incomplete material
//   provider_refused           the provider declined
//   provider_failed            the provider reported a non-retryable error
//   attempts_exhausted, review_limit, elapsed_limit, delegation_invalid, job_ended
export const REVIEW_STATES = [
  'pending',
  'provider_running',
  'submitting',
  'submitted',
  'delivered',
  'clean_awaiting_acceptance',
  'rejected',
  'unconfirmed',
  'superseded',
  'competing_review',
  'input_blocked',
  'provider_refused',
  'provider_failed',
  'attempts_exhausted',
  'review_limit',
  'elapsed_limit',
  'delegation_invalid',
  'job_ended',
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
// Managed job states in which nothing can be reviewed any more.
export const ENDED_JOB_STATES: readonly string[] = ['approved', 'closed', 'failed', 'needs_inspection', 'blocked'];
export const OPEN_REVIEW_STATES: readonly ReviewState[] = ['pending', 'provider_running', 'submitting', 'submitted'];

export const reviewEntrySchema = z.strictObject({
  event_id: sha,
  review_id: uuid,
  // The grant this entry's work belongs to. Recorded findings are submitted only under it: a new
  // delegation never relabels them (records.ts review provenance).
  delegation_id: uuid,
  provider: id,
  iteration_id: iteration,
  snapshot_sha256: sha,
  session_id: uuid.nullable(),
  context_epoch: z.number().int().min(0).nullable(),
  state: z.enum(REVIEW_STATES),
  // A coded reason (e.g. input_withheld, provider_output_invalid, tree_changed); never free text from a provider.
  code: code.nullable(),
  attempts: z.number().int().min(0),
  // The sha256 of the verified review input the provider saw (instruction, snapshot, diff, report).
  input_sha256: sha.nullable(),
  // Recorded before submission so a restart submits exactly the same content. Kept only while the
  // entry is submitting; afterwards only submission_sha256 remains (the request file has the body).
  submission: z
    .strictObject({
      summary: safeText(MAX_SUMMARY_CHARS),
      findings: z.array(z.strictObject({ text: safeText(MAX_FINDING_CHARS).min(1) })).min(1).max(MAX_FINDINGS),
      sha256: sha,
    })
    .nullable(),
  submission_sha256: sha.nullable(),
  created_at: iso,
  updated_at: iso,
});
export type ReviewEntry = z.infer<typeof reviewEntrySchema>;

export const JOB_STATE_SCHEMA = 'software-factory.reviewer-job/v1';
export const MAX_REVIEW_ENTRIES = 200;
// The bound of one reviewer state file, enforced on every write and every read (store.ts), and of
// one recorded submission: a larger provider answer is a coded outcome, never unreadable state.
// The submission bound keeps the whole review request (summary, findings, ids, provenance, the
// pretty-printed JSON) below what the supervisor reads (executor/records.ts MAX_REQUEST_BYTES,
// 64 KiB). 200 entries without bodies stay far below the file bound.
export const MAX_STATE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SUBMISSION_BYTES = 48 * 1024;
export const jobStateSchema = z.strictObject({
  schema: z.literal(JOB_STATE_SCHEMA),
  app_id: id,
  job_id: id,
  delegation_id: uuid,
  // Durable budgets: counted before the work they pay for, so a restart never resets them.
  usage: z.strictObject({ attempts: z.number().int().min(0), reviews: z.number().int().min(0) }),
  reviews: z.array(reviewEntrySchema).max(MAX_REVIEW_ENTRIES),
  revision: z.number().int().min(1),
  updated_at: iso,
});
export type ReviewerJobState = z.infer<typeof jobStateSchema>;

// Coordinator errors: coded messages with ids and fixed text only, never host paths or provider text.
export type ReviewerErrorCode = 'not_ready' | 'unsafe_state' | 'invalid_record' | 'conflict' | 'not_found' | 'invalid_input' | 'provider_unavailable' | 'locked';
export class ReviewerError extends Error {
  readonly code: ReviewerErrorCode;

  constructor(code: ReviewerErrorCode, message: string) {
    super(message);
    this.name = 'ReviewerError';
    this.code = code;
  }
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
