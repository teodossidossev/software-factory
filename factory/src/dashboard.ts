// The Dashboard: a second loopback HTTP listener with the static page, JSON endpoints, one
// server-sent event stream per open page and, since version 2, the User's actions approve, abort,
// say and the retry of a failed review (SF-044) as POST endpoints, the override of a stopped
// gate (SF-047) and the merge request on the Git host (SF-048). Every path starts with
// /d/<token>/; anything else is an empty 404.
// Reads JobStore and events.jsonl; job state changes arrive through onStateChange, which
// `sf serve` composes with the notifier. The actions validate the HTTP request and delegate once
// to the Execution of `sf serve` (DashboardActions); nothing here changes a job by itself. The
// start screen (SF-025) adds the workspaces and the tickets (DashboardSetup: the registry and the
// Task files), the ChatGPT conversation that plans a ticket, and the User's start of a ticket
// whose Task file is written (SF-040); the board (SF-046) adds the text of a Task file; the Task
// check (SF-054) adds each ticket's last check, its start (Check) and its view. The board v3
// (SF-077) adds to each job row what its card shows: who acts now, the Implementer's tool calls
// and the findings a stopped job waits on. The Changes screen (SF-079) reads the file lists and the
// file versions of the iterations (src/changes.ts), read-only. The planned ticket page (SF-081)
// reads a ticket's Task file, its plan in plain words, its check and its history in one payload,
// and saves the Task file (only over the version it read). A ticket's images (SF-064) are uploaded
// as raw bytes, served and removed through the attachments module's rules (src/attachments.ts).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { hostHeaderValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';
import { writeFileAtomic } from './atomic.js';
import { Changes } from './changes.js';
import { conversationUrl, MAX_CONVERSATION_URL, ticketConversation } from './conversation.js';
import { FactoryError } from './errors.js';
import type { Digests } from './digest-run.js';
import type { Execution } from './execution.js';
import type { RunQueue } from './queue.js';
import { currentExplanation, ledgerStopEntries } from './explain.js';
import { lineEntries, type StreamEntry, streamContext } from './job-stream.js';
import { MAX_MR_TEXT_BYTES } from './mr.js';
import { claudeReviews, type Job, type JobState, type JobStore } from './jobs.js';
import { DECISIONS } from './ledger.js';
import { DIGEST_DEFAULTS, HANDOFF_MODES, WORKSPACE_COLORS, WORKSPACE_NAME_PATTERN } from './registry.js';
import type { Setup, TicketRow } from './setup.js';
import type { CheckRecord, CheckSummary, TaskChecks } from './task-check.js';
import { turnLimitLine } from './turn-limit.js';
import { MAX_TASK_BYTES, mayTouch, parseFrontMatter, taskScope, taskSha256, TICKET_PATTERN } from './task-file.js';
import { TicketHistory } from './ticket-history.js';
import { Stats, STATS_DAYS, type StatsDays } from './stats.js';
import { type JobFacts, jobActions, NO_FACTS, settleEntries, stopFields } from './stops.js';
import { refuseWhileUpdating, UPDATE_IN_PROGRESS } from './update.js';
import { describeEvent, followLines, shortInput } from './watch.js';

export const DEFAULT_DASHBOARD_PORT = 8788;
// The remote listener's port (SF-126), where `tailscale serve --bg 8789` points.
export const DEFAULT_DASHBOARD_REMOTE_PORT = 8789;
export const TOKEN_FILE = 'dashboard-token';
export const MAX_STREAMS = 8;
// The events.jsonl lines of one page of the job's Stream (SF-082).
export const STREAM_PAGE_LINES = 2000;
// The raw body of an action request, in bytes: a transport bound, not a lifecycle rule.
export const MAX_ACTION_BODY_BYTES = 128 * 1024;
// mr-save (SF-080): an MR text of MAX_MR_TEXT_BYTES, every character JSON-escaped at worst.
const MAX_MR_BODY_BYTES = 6 * MAX_MR_TEXT_BYTES + 1024;
// The raw body of the planned ticket page's Save (SF-081): a whole Task file as a JSON string, whose
// escapes can take up to twice its bytes; the content's own size is checked by the Task file writer.
// A file of mostly non-ASCII or control characters can need more and is written with write_task.
export const MAX_TASK_BODY_BYTES = 2 * MAX_TASK_BYTES + 1024;
const LOOPBACK_HOST = '127.0.0.1';
// The Host names of the local listener, and the loopback Hosts the remote one takes with a listed Origin.
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const KEEP_ALIVE_MS = 15_000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
// Compiled to dist/src/dashboard.js; the package root is two levels up.
const STATIC_DIR = new URL('../../static/', import.meta.url);
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:",
  'referrer-policy': 'no-referrer',
};
// The dashboard's script (SF-136): classic scripts that share the page's globals, in load order.
// dashboard.html has one deferred <script> per entry, in this order; nothing at the top level of a
// file uses a name defined in a later one.
export const DASHBOARD_SCRIPTS = ['core.js', 'job-screens.js', 'job-page.js', 'board.js', 'app.js'] as const;
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '': { file: 'dashboard.html', type: 'text/html; charset=utf-8' },
  ...Object.fromEntries(DASHBOARD_SCRIPTS.map((file) => [file, { file, type: 'text/javascript; charset=utf-8' }])),
  'app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  'favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml; charset=utf-8' },
};

// The User's actions, bound by `sf serve` to its one Execution: the same methods, guards and
// results as the socket commands of sf start, sf approve, sf abort, sf say, sf review and sf retry
// (SF-087: retryMr, the Retry of a transient MR preparation failure). A job is
// started from its ticket on the start screen once the Task file is written (SF-040), or with
// sf start. Archive of a job card is archiveFinished (terminal only), never the any-state reset.
// The merge request on the Git host (SF-048): mr-create, mr-merge and mr-status as sf mr create,
// merge and status, and mergeRequestHost for whether they are on for a job's workspace.
// Pause, Resume and Restart (SF-067) as sf pause, resume and restart.
// The hand-over to the user's checkout (SF-073): handover, takeback and handed-done as sf handover,
// takeback and handed-done, and checkHandedOver, the check for the user's own push that the job's
// detail starts. The Merge request screen (SF-080): mergeRequestView (GET mr-view), saveMr and
// resetMr (POST mr-save and mr-reset).
export type DashboardActions = Pick<Execution, 'start' | 'approve' | 'abort' | 'say' | 'retryReview' | 'retryMr' | 'acceptGate' | 'settle' | 'simplify' | 'archiveFinished'
  | 'createMergeRequest' | 'mergeMergeRequest' | 'mergeRequestStatus' | 'mergeRequestHost' | 'pause' | 'resumePaused' | 'restart'
  | 'handover' | 'takeback' | 'handedDone' | 'checkHandedOver' | 'mergeRequestView' | 'saveMr' | 'resetMr'>;
export type DashboardAction = 'approve' | 'abort' | 'say' | 'review' | 'retry' | 'accept' | 'settle' | 'simplify' | 'archive' | 'mr-create' | 'mr-merge' | 'mr-status' | 'pause' | 'resume' | 'restart'
  | 'handover' | 'takeback' | 'handed-done' | 'mr-save' | 'mr-reset';
export const ACTIONS: DashboardAction[] = [
  'approve', 'abort', 'say', 'review', 'retry', 'accept', 'settle', 'simplify', 'archive', 'mr-create', 'mr-merge', 'mr-status', 'pause', 'resume', 'restart', 'handover', 'takeback', 'handed-done',
  'mr-save', 'mr-reset',
];
// How often the job's detail asks origin for the user's push of a handed-over branch (SF-073).
const PUSH_CHECK_INTERVAL_MS = 60_000;

// The start screen's data and changes: the workspace registry and the Task files (src/setup.ts).
// jobDependencies: the tickets a live job's Task file lands after (SF-084). taskFile and saveTask:
// the planned ticket page's Task file and its Save (SF-081). addAttachment, removeAttachment and
// readAttachment: a ticket's images (SF-064).
// editWorkspace, workspaceSettings and saveDigestSettings: the Workspaces dialog's Edit, the
// payload's settings and the Morning digest section (SF-103).
export type DashboardSetup = Pick<Setup, 'workspaces' | 'addWorkspace' | 'editWorkspace' | 'workspaceSettings' | 'saveDigestSettings' | 'removeWorkspace' | 'tickets' | 'jobDependencies' | 'createTicket' | 'archiveTicket' | 'restoreTicket' | 'deleteTicket' | 'archivedTickets' | 'taskText' | 'taskTitle'
  | 'taskFile' | 'saveTask' | 'addAttachment' | 'removeAttachment' | 'readAttachment'>;

// The morning digest (SF-103): the list, one record, a manual run.
export type DashboardDigests = Pick<Digests, 'list' | 'read' | 'start'>;

// The Task checks (SF-054): start one, a ticket's view and its board summary.
// store: the records of a ticket's checks, its plan-check rounds and cost (SF-130).
export type DashboardChecks = Pick<TaskChecks, 'start' | 'view' | 'summary' | 'store'>;

// The run queue (SF-071): its view for the tickets payload and the board's changes.
// rule: the rule at a usage limit's reset (SF-072). force: the card's Start anyway (SF-086);
// withTicket: Save writes under the queue's lock of the ticket (SF-086).
export type DashboardQueue = Pick<RunQueue, 'view' | 'add' | 'remove' | 'move' | 'limit' | 'hold' | 'release' | 'rule' | 'force' | 'withTicket'>;
export const QUEUE_ACTIONS = ['add', 'remove', 'move', 'limit', 'hold', 'release', 'rule', 'force'] as const;
type QueueAction = (typeof QUEUE_ACTIONS)[number];

// A dashboard without a start screen (in-process tests of the older endpoints).
const NO_SETUP: DashboardSetup = {
  workspaces: async () => [],
  workspaceSettings: async () => ({ handoff_default: 'checkout', digest: { at: DIGEST_DEFAULTS.at, weekdays_only: DIGEST_DEFAULTS.weekdays_only, language: DIGEST_DEFAULTS.language } }),
  tickets: async () => [],
  jobDependencies: async () => [],
  archivedTickets: async () => [],
  taskTitle: async () => null,
  taskText: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
  taskFile: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
  saveTask: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
  archiveTicket: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
  restoreTicket: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
  deleteTicket: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
  addWorkspace: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
  removeWorkspace: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
  editWorkspace: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
  saveDigestSettings: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
  createTicket: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
  addAttachment: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
  removeAttachment: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
  readAttachment: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
};

// The request body of each POST route, strict: unknown keys, null, arrays and wrong types are
// refused; shape is what the refusal names.
const BODIES = {
  // confirm (SF-126): the job's ticket, which the remote port needs on the four routes that can
  // push or merge (CONFIRM_ROUTES); the local port ignores it.
  approve: { shape: '{"as_is"?: boolean, "confirm"?: string}', schema: z.strictObject({ as_is: z.boolean().optional(), confirm: z.string().optional() }) },
  abort: { shape: '{"discard"?: boolean}', schema: z.strictObject({ discard: z.boolean().optional() }) },
  say: { shape: '{"message": string}', schema: z.strictObject({ message: z.string() }) },
  review: { shape: '{}', schema: z.strictObject({}) },
  retry: { shape: '{"confirm"?: string}', schema: z.strictObject({ confirm: z.string().optional() }) },
  accept: { shape: '{}', schema: z.strictObject({}) },
  settle: { shape: '{"id": string, "decision": "accept" | "fix", "note"?: string}', schema: z.strictObject({ id: z.string(), decision: z.enum(DECISIONS), note: z.string().optional() }) },
  simplify: { shape: '{}', schema: z.strictObject({}) },
  archive: { shape: '{}', schema: z.strictObject({}) },
  'mr-create': { shape: '{"confirm"?: string}', schema: z.strictObject({ confirm: z.string().optional() }) },
  'mr-merge': { shape: '{"confirm"?: string}', schema: z.strictObject({ confirm: z.string().optional() }) },
  'mr-status': { shape: '{}', schema: z.strictObject({}) },
  pause: { shape: '{}', schema: z.strictObject({}) },
  resume: { shape: '{"message"?: string}', schema: z.strictObject({ message: z.string().optional() }) },
  restart: { shape: '{"keep_files"?: boolean}', schema: z.strictObject({ keep_files: z.boolean().optional() }) },
  handover: { shape: '{}', schema: z.strictObject({}) },
  takeback: { shape: '{}', schema: z.strictObject({}) },
  'handed-done': { shape: '{}', schema: z.strictObject({}) },
  // The Merge request screen (SF-080): the MR title and text, and the branch and the base when they change.
  'mr-save': {
    shape: '{"title": string, "body": string, "branch"?: string, "base"?: string}',
    schema: z.strictObject({ title: z.string(), body: z.string(), branch: z.string().optional(), base: z.string().optional() }),
  },
  'mr-reset': { shape: '{}', schema: z.strictObject({}) },
  'workspace-add': {
    shape: `{"name": string, "path": string, "handoff"?: "checkout" | "off", "color"?: ${WORKSPACE_COLORS.map((color) => `"${color}"`).join(' | ')}, "description"?: string, "app"?: string, "digest"?: {"track": boolean, "my_work": boolean}}`,
    schema: z.strictObject({
      name: z.string(), path: z.string(), handoff: z.enum(HANDOFF_MODES).optional(), color: z.enum(WORKSPACE_COLORS).optional(),
      description: z.string().optional(), app: z.string().optional(), digest: z.strictObject({ track: z.boolean(), my_work: z.boolean() }).optional(),
    }),
  },
  // Edit of a workspace (SF-103): every field of the form; "" removes description and app,
  // "default" the handoff, "auto" the color.
  'workspace-edit': {
    shape: `{"path": string, "description": string, "app": string, "handoff": "default" | "checkout" | "off", "color": "auto" | ${WORKSPACE_COLORS.map((color) => `"${color}"`).join(' | ')}, "digest": {"track": boolean, "my_work": boolean}}`,
    schema: z.strictObject({
      path: z.string(), description: z.string(), app: z.string(), handoff: z.enum(['default', ...HANDOFF_MODES]), color: z.enum(['auto', ...WORKSPACE_COLORS]),
      digest: z.strictObject({ track: z.boolean(), my_work: z.boolean() }),
    }),
  },
  // The Morning digest section of the Setup (SF-103).
  'digest-settings': {
    shape: '{"at": "HH:MM", "weekdays_only": boolean, "language": string}',
    schema: z.strictObject({ at: z.string(), weekdays_only: z.boolean(), language: z.string() }),
  },
  // Generate now on the Digest page (SF-103).
  'digest-run': { shape: '{}', schema: z.strictObject({}) },
  'workspace-remove': { shape: '{}', schema: z.strictObject({}) },
  'ticket-archive': { shape: '{}', schema: z.strictObject({}) },
  'ticket-restore': { shape: '{}', schema: z.strictObject({}) },
  'ticket-delete': { shape: '{}', schema: z.strictObject({}) },
  'ticket-start': { shape: '{}', schema: z.strictObject({}) },
  'ticket-check': { shape: '{}', schema: z.strictObject({}) },
  // Save of the planned ticket page (SF-081): the whole Task file and the sha256 of the version read.
  'ticket-task': { shape: '{"content": string, "sha256": string}', schema: z.strictObject({ content: z.string(), sha256: z.string() }) },
  // A ticket's images (SF-064): the upload's body is the image's raw bytes (Content-Type:
  // application/octet-stream), not JSON; removing one takes {}.
  'ticket-attachment-add': { shape: 'the image\'s bytes', schema: z.instanceof(Buffer) },
  'ticket-attachment-remove': { shape: '{}', schema: z.strictObject({}) },
  'ticket-new': { shape: '{"workspace": string, "ticket": string, "title": string, "request": string}', schema: z.strictObject({ workspace: z.string(), ticket: z.string(), title: z.string(), request: z.string() }) },
  // The run queue (SF-071): positions are 1-based; the limit's range is the queue's own check
  // (invalid_limit).
  'queue-add': { shape: '{"workspace": string, "ticket": string, "at"?: integer >= 1}', schema: z.strictObject({ workspace: z.string(), ticket: z.string(), at: z.number().int().min(1).optional() }) },
  'queue-remove': { shape: '{"workspace": string, "ticket": string}', schema: z.strictObject({ workspace: z.string(), ticket: z.string() }) },
  'queue-move': { shape: '{"workspace": string, "ticket": string, "to": integer >= 1}', schema: z.strictObject({ workspace: z.string(), ticket: z.string(), to: z.number().int().min(1) }) },
  'queue-limit': { shape: '{"max_running": number}', schema: z.strictObject({ max_running: z.number() }) },
  'queue-hold': { shape: '{"reason"?: string}', schema: z.strictObject({ reason: z.string().optional() }) },
  'queue-release': { shape: '{}', schema: z.strictObject({}) },
  // The Rules menu (SF-072): the rule at a usage limit's reset; its values are the queue's own check
  // (invalid_rule).
  'queue-rule': { shape: '{"rule": string}', schema: z.strictObject({ rule: z.string() }) },
  // Start anyway (SF-086): the queued ticket starts whatever its plan check says.
  'queue-force': { shape: '{"workspace": string, "ticket": string}', schema: z.strictObject({ workspace: z.string(), ticket: z.string() }) },
};
type PostRoute = keyof typeof BODIES;
// The routes that can push or merge (SF-126): approve, retry (which pushes again after
// mr_push_failed), mr-create and mr-merge. On the remote port each needs "confirm": the ticket.
export const CONFIRM_ROUTES: readonly PostRoute[] = ['approve', 'retry', 'mr-create', 'mr-merge'];

// The POSTs that still answer while the factory is being updated (SF-101): Pause, the update's own
// tool, and the merge request's status, which starts nothing.
const OPEN_WHILE_UPDATING: ReadonlySet<PostRoute> = new Set<PostRoute>(['pause', 'mr-status']);

// The HTTP status of a FactoryError the methods can throw; any other code answers 500 and keeps
// its code and message.
const ERROR_STATUS: Record<string, number> = {
  // sf update is draining or building (SF-101).
  [UPDATE_IN_PROGRESS]: 409,
  invalid_state: 409, turn_running: 409, rebase_in_progress: 409, review_off: 409, runner_active: 409,
  job_exists: 409, job_active: 409, job_limit: 409, task_draft: 409, checkout_dirty: 409, branch_exists: 409, branch_changed: 409, branch_missing: 409, worktree_exists: 409,
  worktree_missing: 409, sensitive_unacknowledged: 409, ticket_exists: 409, workspace_exists: 409, workspace_busy: 409,
  job_not_found: 404, workspace_not_found: 404, task_not_found: 404,
  // Save of the planned ticket page (SF-081): the Task file is another version than the one read.
  // Not the job view's task_changed field (SF-067).
  task_changed: 409,
  // The Task check (SF-054): one at a time per ticket.
  check_running: 409,
  // A Restart that would delete a branch with commits or a pushed one (SF-067).
  restart_refused: 409,
  // The hand-over to the user's checkout (SF-073) and its way back.
  checkout_busy: 409, handover_refused: 409, handover_mismatch: 409, checkout_changing: 409, checkout_moved: 409,
  takeback_changed: 409, takeback_switch_failed: 409, branch_in_checkout: 409, not_pushed: 409, handed_over: 409, handover_interrupted: 409, ask_interrupted: 409,
  invalid_content: 400, invalid_ticket: 400, invalid_name: 400, workspace_invalid: 400,
  // The merge request (SF-048): the host's refusals and the actions being off are conflicts; a host
  // that failed or refused the token is a bad gateway.
  mr_not_mergeable: 409, mr_not_open: 409, mr_token_missing: 409, mr_host_unsupported: 409, mr_host_changed: 409, mr_text_missing: 409,
  mr_auth_failed: 502, mr_host_error: 502, mr_host_unreachable: 502,
  // The Merge request screen (SF-080): a text that breaks the rules (also approve's, while the MR
  // text is invalid or not the prepared commit's message), a rename or a base change refused.
  mr_text_invalid: 400, branch_locked: 409, base_unrelated: 409,
  // origin did not say where a handed-over branch is (SF-073).
  push_check_failed: 502,
  // The morning digest (SF-103): one run at a time; its settings.
  digest_running: 409, invalid_digest_settings: 400,
  // The run queue (SF-071).
  already_queued: 409, not_queued: 409, invalid_limit: 400, invalid_position: 400, invalid_rule: 400,
  // A ticket's images (SF-064): not an image, too large, too many, and a Task file that refers to
  // one the ticket does not have (also an image to remove that is not there); a Start, Restart or
  // Resume whose Task file refers to images that cannot be used (SF-065).
  attachment_type: 400, attachment_too_large: 413, attachment_limit: 409, attachment_missing: 400, attachment_invalid: 409,
};

export interface RunningDashboard {
  url: URL;
  // The dashboard's URLs through Tailscale (SF-118), one per remote origin; empty without them.
  remoteUrls: URL[];
  // The bound port of the remote listener (SF-126); undefined without remote origins.
  remotePort: number | undefined;
  // The state listener: refreshes every open page; never throws.
  onStateChange(job: Job, from: JobState | null): void;
  // A ticket's data changed without a job (a Task check ended): every page gets the tickets again.
  refreshSetup(): void;
  // The job's files changed without a state change (its stop's explanation, SF-106): every page
  // gets the jobs again, and the pages that show the job its detail, as the POST mr-status route
  // does; never throws.
  refreshJob(workspace: string, ticket: string): void;
  close(): Promise<void>;
}

export function dashboardUrl(port: number, token: string): URL {
  return new URL(`http://${LOOPBACK_HOST}:${port}/d/${token}/`);
}

// SF_DASHBOARD_REMOTE_ORIGINS (SF-118): the origins of the user's `tailscale serve`, whose
// requests the dashboard accepts as loopback ones. Only https://<machine>.<tailnet>.ts.net, with
// no port, path, query, fragment or user info, so the setting cannot put the dashboard on any
// other name; the first entry that is not one stops the start.
const TAILSCALE_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/;

export function dashboardRemoteOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins: string[] = [];
  for (const entry of (env.SF_DASHBOARD_REMOTE_ORIGINS ?? '').split(',').map((part) => part.trim()).filter((part) => part !== '')) {
    const url = URL.parse(entry);
    const lower = entry.toLowerCase();
    if (url === null || url.protocol !== 'https:' || url.port !== '' || (lower !== url.origin && lower !== `${url.origin}/`) || !TAILSCALE_HOSTNAME.test(url.hostname)) {
      throw new FactoryError(
        'invalid_config',
        `SF_DASHBOARD_REMOTE_ORIGINS: "${entry}" is not an https://<machine>.<tailnet>.ts.net origin (https only, a Tailscale name, no port or path); the dashboard is only opened through Tailscale.`,
      );
    }
    if (!origins.includes(url.origin)) {
      origins.push(url.origin);
    }
  }
  return origins;
}

export function remoteDashboardUrls(origins: readonly string[], token: string): URL[] {
  return origins.map((origin) => new URL(`/d/${token}/`, origin));
}

// SF_DASHBOARD_REMOTE_LOGINS (SF-126): the Tailscale logins (Tailscale-User-Login) that may use
// the remote port, comma-separated, compared ignoring case. Required with remote origins: without
// one, anyone on the tailnet with the URL could push and merge.
export function dashboardRemoteLogins(origins: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const logins: string[] = [];
  for (const entry of (env.SF_DASHBOARD_REMOTE_LOGINS ?? '').split(',').map((part) => part.trim().toLowerCase()).filter((part) => part !== '')) {
    if (!logins.includes(entry)) {
      logins.push(entry);
    }
  }
  if (origins.length > 0 && logins.length === 0) {
    throw new FactoryError(
      'invalid_config',
      'SF_DASHBOARD_REMOTE_LOGINS is required with SF_DASHBOARD_REMOTE_ORIGINS: the comma-separated Tailscale logins (as tailscale status shows them) that may use the dashboard from another device.',
    );
  }
  return logins;
}

// The remote listener's port (SF-126) next to the local one: the same port is refused, unless both
// are 0 (each then gets a free port of its own).
export function checkDashboardPorts(port: number, remotePort: number): void {
  if (port === remotePort && port !== 0) {
    throw new FactoryError('invalid_config', `SF_DASHBOARD_REMOTE_PORT must differ from SF_DASHBOARD_PORT (both are ${port}).`);
  }
}

// A new secret token: 32 random bytes as 64 lower-case hex digits; the dashboard's and the MCP
// endpoint's (SF-099) alike.
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

// A token file of the state directory: its token, or undefined when the file is missing; invalid
// (the error never holds the file's content) when it does not hold one token.
export async function readTokenFile(stateDir: string, file: string, invalid: () => FactoryError): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(stateDir, file), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const token = text.trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw invalid();
  }
  return token;
}

// The dashboard token, or undefined when the file is missing; kept across `sf serve` starts.
export function readToken(stateDir: string): Promise<string | undefined> {
  return readTokenFile(stateDir, TOKEN_FILE, () => new FactoryError('invalid_token', `${TOKEN_FILE} does not hold a dashboard token.`));
}

// With the dashboard off, a token of an earlier start must not point at a dead page.
export async function removeToken(stateDir: string): Promise<void> {
  await rm(join(stateDir, TOKEN_FILE), { force: true });
}

// The file counts of the last published iteration (SF-024): every file, the undeclared sensitive
// ones and the deleted ones; zeros before the first iteration or for an iteration without a list.
async function fileCounts(jobs: JobStore, job: Job): Promise<{ files: number; undeclared: number; deleted: number }> {
  const none = { files: 0, undeclared: 0, deleted: 0 };
  if (job.iteration === 0) {
    return none;
  }
  try {
    const files = (await jobs.readMeta(job.workspace, job.ticket, job.iteration)).files ?? [];
    return {
      files: files.length,
      undeclared: files.filter((change) => change.sensitive === 'undeclared').length,
      deleted: files.filter((change) => change.status === 'deleted').length,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return none;
    }
    throw error;
  }
}

type Verdict = 'clean' | 'fix' | 'failed' | null;
const verdictOf = (record: { verdict: 'clean' | 'fix' } | { error: string } | undefined): Verdict =>
  record === undefined ? null : 'verdict' in record ? record.verdict : 'failed';

// What a board card shows besides the job record (SF-046): the estimated cost of the iterations
// and their Claude reviews (the job card's sum), and the last iteration's Claude review and gate
// with the end of that review, which tell the pipeline segment of awaiting_review and since when
// the gate runs.
async function boardFacts(jobs: JobStore, job: Job): Promise<{ cost_usd: number | null; review: Verdict; review_ended_at: string | null; gate: Verdict }> {
  let cost: number | null = null;
  const add = (value: number | null | undefined): void => {
    if (typeof value === 'number') {
      cost = (cost ?? 0) + value;
    }
  };
  let review: Awaited<ReturnType<JobStore['readReview']>>;
  for (let number = 1; number <= job.iteration; number += 1) {
    try {
      add((await jobs.readMeta(job.workspace, job.ticket, number)).cost_usd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    review = await jobs.readReview(job.workspace, job.ticket, number);
    add(review !== undefined && 'verdict' in review ? review.cost_usd : undefined);
  }
  const gate = job.iteration > 0 ? await jobs.readGate(job.workspace, job.ticket, job.iteration) : undefined;
  return {
    cost_usd: cost,
    review: verdictOf(review),
    review_ended_at: review !== undefined && 'verdict' in review ? review.ended_at : null,
    gate: verdictOf(gate),
  };
}

// Whether the merge request actions are on for a workspace (SF-048): its Git host, or why not.
type MrHost = Awaited<ReturnType<DashboardActions['mergeRequestHost']>>;

async function mrHostOf(actions: DashboardActions, workspace: string): Promise<MrHost> {
  try {
    return await actions.mergeRequestHost(workspace);
  } catch (error) {
    console.error(error);
    return { host: null, reason: 'the Git host could not be determined' };
  }
}

// Whether the Task file of a paused job changed since the Implementer was last given it (SF-067):
// its sha256 against the job's; null for a job not paused, without a recorded sha256, or whose Task
// file cannot be read.
async function taskChangedOf(setup: DashboardSetup, job: Job): Promise<boolean | null> {
  if (job.state !== 'paused' || job.task_sha256 === undefined) {
    return null;
  }
  try {
    return taskSha256(await setup.taskText(job.workspace, job.ticket)) !== job.task_sha256;
  } catch {
    return null;
  }
}

// mr: the merge request on the Git host (SF-048), null before one is opened; mr_host: whether the
// merge request actions are on for the job's workspace; paused: what a pause interrupted (SF-067),
// null unless paused (or parked on a usage limit, SF-072); limit: the usage limit of a parked job
// (provider, resets_at, reset_seen), null otherwise; task_changed: taskChangedOf; turn_limit: the line of a chain that went on by
// itself after a turn limit (SF-069), null without one; handover: the job in the user's checkout
// (SF-073), null otherwise; handoff_skipped: why the automatic hand-over did not happen, null
// otherwise; mr_conflict_turn: the MR preparation ran a conflict turn, so no Retry (SF-087);
// claude_review: whether the Claude review runs on the job (SF-131; absent in job.json: true).
// SF-129, src/stops.ts: stop_code, stop_kind and stop_group, the canonical row of a needs_human
// job's stop (null in any other state); actions, the actions the job page shows in order;
// availability, every action's '' or why it is off. The page renders them and decides no rule.
function jobSummary(job: Job, counts: { files: number; undeclared: number; deleted: number }, mrHost: MrHost, taskChanged: boolean | null, facts: JobFacts) {
  const now = new Date();
  return {
    workspace: job.workspace, ticket: job.ticket, branch: job.branch, base: job.base, state: job.state,
    iteration: job.iteration, mr_attempts: job.mr_attempts, mr_conflict_turn: job.mr_conflict_turn, updated_at: job.updated_at, created_at: job.created_at,
    error: job.error ?? null, worktree: job.worktree, prepared_commit: job.prepared_commit,
    fixes: job.fixes, gate_fixes: job.gate_fixes, gate_tokens: job.gate_tokens, ...counts,
    mr: job.mr, mr_host: mrHost, paused: job.paused ?? null, limit: job.limit ?? null, task_changed: taskChanged, turn_limit: turnLimitLine(job) ?? null,
    handover: job.handover ?? null, handoff_skipped: job.handoff_skipped ?? null, claude_review: claudeReviews(job),
    ...stopFields(job, now), ...jobActions(job, facts, now),
  };
}

// What the rules of a job's actions read (src/stops.ts): for a needs_human job its ledger and the
// last iteration's Claude review and gate; for every job the workspace's Git host. Only the
// stopped jobs cost the extra reads.
async function ruleFacts(jobs: JobStore, job: Job, mrHost: MrHost): Promise<JobFacts> {
  if (job.state !== 'needs_human') {
    return { ...NO_FACTS, mrHost };
  }
  const last = job.iteration >= 1;
  return {
    ledger: await jobs.readLedger(job.workspace, job.ticket),
    review: last ? await jobs.readReview(job.workspace, job.ticket, job.iteration) : undefined,
    gate: last ? await jobs.readGate(job.workspace, job.ticket, job.iteration) : undefined,
    mrHost,
  };
}

// The Now line reads at most this much of the end of events.jsonl; the tool calls are counted in
// chunks of TOOL_CALL_CHUNK_BYTES.
export const NOW_TAIL_BYTES = 256 * 1024;
const TOOL_CALL_CHUNK_BYTES = 1024 * 1024;
const NOW_TEXT_CHARS = 200;

interface NowLine {
  who: string;
  what: string;
  ts: string | null;
}

// The content blocks of an Implementer message: an SDK assistant message the session logged as it
// came (the reviewers' come as review_message and gate_event records); none for any other record.
function implementerBlocks(raw: string): { ts: string | null; blocks: Array<Record<string, unknown>> } | undefined {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (record === null || typeof record !== 'object' || record.type !== undefined) {
    return undefined;
  }
  const message = record.message as { type?: unknown; message?: { content?: unknown } } | undefined;
  const content = message?.type === 'assistant' ? message.message?.content : undefined;
  return Array.isArray(content) ? { ts: typeof record.ts === 'string' ? record.ts : null, blocks: content as Array<Record<string, unknown>> } : undefined;
}

// The complete lines of the last bytes of a file (the first, cut one dropped); none when it is missing.
async function tailLines(path: string, bytes: number): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

// The last thing the Implementer did, from the tail of the log: its last tool call (the verb and
// the short input of sf watch) or the first line of its last text.
function lastImplementerStep(lines: string[]): NowLine | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const found = implementerBlocks(lines[index]!);
    for (const block of [...(found?.blocks ?? [])].reverse()) {
      if (block.type === 'tool_use') {
        return { who: 'Implementer', what: `${String(block.name)} ${shortInput(block.input)}`, ts: found!.ts };
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        const first = block.text.trim().split('\n')[0]!.replace(/\s+/g, ' ').trim();
        return { who: 'Implementer', what: first.length > NOW_TEXT_CHARS ? `${first.slice(0, NOW_TEXT_CHARS - 1)}…` : first, ts: found!.ts };
      }
    }
  }
  return null;
}

// Who acts now on a running job and what it does (SF-077): the Implementer's last step, the
// reviewer of the last iteration (Codex once Claude's review of it is clean, or from the start
// without the Claude review, SF-131), the MR writer; null for a job that is not running, or an
// Implementer with no step in the tail yet.
async function nowOf(jobs: JobStore, job: Job, facts: { review: Verdict; review_ended_at: string | null }): Promise<NowLine | null> {
  switch (job.state) {
    case 'starting':
    case 'working':
      return lastImplementerStep(await tailLines(jobs.eventsPath(job.workspace, job.ticket), NOW_TAIL_BYTES));
    case 'awaiting_review':
      if (!claudeReviews(job)) {
        return { who: 'Codex gate', what: `reviewing iteration ${job.iteration}`, ts: job.updated_at };
      }
      return facts.review === 'clean'
        ? { who: 'Codex gate', what: `reviewing iteration ${job.iteration}`, ts: facts.review_ended_at }
        : { who: 'Claude review', what: `reviewing iteration ${job.iteration}`, ts: job.updated_at };
    case 'preparing_mr':
      return { who: 'MR writer', what: 'writing the MR text', ts: job.updated_at };
    default:
      return null;
  }
}

const toolUses = (raw: string): number =>
  raw.includes('"tool_use"') ? (implementerBlocks(raw)?.blocks.filter((block) => block.type === 'tool_use').length ?? 0) : 0;

// The Implementer's tool calls of each job, counted incrementally: per events.jsonl the bytes
// already read, the count so far and the cut line at the end; a log replaced (a restart) or cut
// shorter is counted again from the start. One count per log at a time.
export class ToolCallCounter {
  private readonly seen = new Map<string, { ino: number; offset: number; count: number; rest: Buffer }>();
  private readonly running = new Map<string, Promise<number>>();
  // The bytes read so far, for the tests.
  bytesRead = 0;

  count(path: string): Promise<number> {
    const next = (this.running.get(path) ?? Promise.resolve(0)).catch(() => 0).then(() => this.read(path));
    this.running.set(path, next);
    return next;
  }

  private async read(path: string): Promise<number> {
    let handle;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.seen.delete(path);
        return 0;
      }
      throw error;
    }
    try {
      const { ino, size } = await handle.stat();
      let entry = this.seen.get(path);
      if (entry === undefined || entry.ino !== ino || size < entry.offset) {
        entry = { ino, offset: 0, count: 0, rest: Buffer.alloc(0) };
      }
      while (entry.offset < size) {
        const chunk = Buffer.alloc(Math.min(TOOL_CALL_CHUNK_BYTES, size - entry.offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, entry.offset);
        if (bytesRead === 0) {
          break;
        }
        entry.offset += bytesRead;
        this.bytesRead += bytesRead;
        const data = Buffer.concat([entry.rest, chunk.subarray(0, bytesRead)]);
        let start = 0;
        for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
          entry.count += toolUses(data.toString('utf8', start, end));
          start = end + 1;
        }
        entry.rest = Buffer.from(data.subarray(start));
      }
      this.seen.set(path, entry);
      return entry.count;
    } finally {
      await handle.close();
    }
  }
}

// What a stopped job waits on (SF-077), for its card: the suggestions of the last simplification
// pass and the lines they save (simplify_offered), the ledger entries to settle (escalated,
// review_disputed: the ledger's unsettled ones), the open ones (review_churn), the items of the last gate (gate_rounds,
// gate_budget); none for any other stop; null unless the job is needs_human.
async function stopOf(jobs: JobStore, job: Job): Promise<{ items: unknown[]; saves_lines: number | null } | null> {
  if (job.state !== 'needs_human') {
    return null;
  }
  const code = job.error?.code;
  if (code === 'simplify_offered') {
    const record = await jobs.readSimplify(job.workspace, job.ticket, job.iteration);
    const items = record !== undefined && 'suggestions' in record ? record.suggestions : [];
    return { items, saves_lines: items.reduce((sum, item) => sum + item.saves_lines, 0) };
  }
  const entries = ledgerStopEntries(code ?? '', await jobs.readLedger(job.workspace, job.ticket));
  if (entries !== null) {
    return { items: entries, saves_lines: null };
  }
  if (code === 'gate_rounds' || code === 'gate_budget') {
    for (let number = job.iteration; number >= 1; number -= 1) {
      const gate = await jobs.readGate(job.workspace, job.ticket, number);
      if (gate !== undefined && 'verdict' in gate) {
        return { items: gate.items, saves_lines: null };
      }
    }
  }
  return { items: [], saves_lines: null };
}

// now: nowOf; tool_calls: the Implementer's tool calls in the job (ToolCallCounter); stop: stopOf.
async function jobsPayload(jobs: JobStore, setup: DashboardSetup, actions: DashboardActions, toolCalls: ToolCallCounter) {
  const list = [];
  const hosts = new Map<string, MrHost>();
  for (const job of await jobs.list()) {
    if (!hosts.has(job.workspace)) {
      hosts.set(job.workspace, await mrHostOf(actions, job.workspace));
    }
    const facts = await boardFacts(jobs, job);
    const host = hosts.get(job.workspace)!;
    list.push({
      ...jobSummary(job, await fileCounts(jobs, job), host, await taskChangedOf(setup, job), await ruleFacts(jobs, job, host)),
      title: await setup.taskTitle(job.workspace, job.ticket), ...facts,
      now: await nowOf(jobs, job, facts), tool_calls: await toolCalls.count(jobs.eventsPath(job.workspace, job.ticket)), stop: await stopOf(jobs, job),
    });
  }
  return { jobs: list };
}

// The workspaces and, since SF-103, the hand-over default and the morning digest's settings.
async function workspacesPayload(setup: DashboardSetup) {
  return { workspaces: await setup.workspaces(), ...(await setup.workspaceSettings()) };
}

// A ticket's check summary for the board, or none when it cannot be read.
async function checkOf(checks: DashboardChecks, workspace: string, ticket: string): Promise<CheckSummary | null> {
  try {
    return await checks.summary(workspace, ticket);
  } catch (error) {
    console.error(error);
    return null;
  }
}

// The tickets without a live job, each with the ChatGPT conversation that plans it (the message
// and the prefilled URL), the tickets it lands after with their states (SF-084), with the Task
// checks its last check (SF-054), and its place in the run queue (SF-071: queue_position, 1-based or
// null, and queue_error, the queue's failed start or null; SF-086: queue_reason, why its plan holds
// it in the queue or null, and queue_force, whether Start anyway was given); job_lands_after: the same for the
// tickets with a live job, for the job page's Waits for and the board's Needed by; queue: the run
// queue's limit, running count, hold and next ticket (null without a queue).
async function ticketsPayload(setup: DashboardSetup, checks: DashboardChecks | undefined, queue: DashboardQueue | undefined) {
  const view = queue === undefined ? undefined : await queue.view();
  const same = (row: TicketRow) => (other: { workspace: string; ticket: string }): boolean => other.workspace === row.workspace && other.ticket === row.ticket;
  const tickets = [];
  for (const row of await setup.tickets()) {
    const failed = view?.errors.find(same(row));
    const entry = view?.entries.find(same(row));
    tickets.push({
      ...(await ticketEntry(row, checks)),
      queue_position: entry?.position ?? null,
      queue_error: failed === undefined ? null : { code: failed.code, message: failed.message },
      queue_reason: entry?.plan_reason ?? null,
      queue_force: entry?.force ?? false,
    });
  }
  return {
    tickets, archived: await setup.archivedTickets(), job_lands_after: await setup.jobDependencies(),
    queue: view === undefined ? null : {
      max_running: view.max_running, running: view.running, held: view.held, hold_reason: view.hold_reason, next: view.next, on_limit: view.on_limit, limit_hold: view.limit_hold,
    },
  };
}

// A row of the tickets payload: the ticket, its conversation and, with the Task checks, its check.
async function ticketEntry(row: TicketRow, checks: DashboardChecks | undefined) {
  const message = ticketConversation(row.workspace, row.ticket, row.request ?? undefined, row.attachments.map((attachment) => attachment.name));
  const url = conversationUrl(message);
  // A very long message does not fit a link; the page offers it to copy instead.
  return {
    ...row, conversation: { message, url: url.length <= MAX_CONVERSATION_URL ? url : null },
    ...(checks !== undefined ? { check: await checkOf(checks, row.workspace, row.ticket) } : {}),
  };
}

// The planned ticket page's plan in plain words (SF-081), from the Task file's front matter as the
// jobs read it: the branch it starts from, the files it will change (scope, then may_touch, each
// path once, a may_touch one marked sensitive), whether there is a scope, and the tickets it waits
// for with SF-084's state of each, from the tickets row (a ticket of another workspace as
// <workspace>/<ticket>).
function planOf(text: string, row: TicketRow) {
  const fields = parseFrontMatter(text) ?? new Map<string, string>();
  const scope = taskScope(fields);
  const sensitive = mayTouch(fields);
  const files: Array<{ path: string; sensitive: boolean }> = [];
  for (const path of [...(scope ?? []), ...sensitive]) {
    if (!files.some((file) => file.path === path)) {
      files.push({ path, sensitive: sensitive.includes(path) });
    }
  }
  const waits = row.lands_after.map((dep) => ({ ticket: dep.workspace === row.workspace ? dep.ticket : `${dep.workspace}/${dep.ticket}`, state: dep.state, merged: dep.state === 'merged' }));
  return { starts_from: fields.get('base') ?? row.base, files, scoped: scope !== undefined, waits_for: waits };
}

async function stateHistory(jobs: JobStore, workspace: string, ticket: string) {
  let text = '';
  try {
    text = await readFile(jobs.eventsPath(workspace, ticket), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  type Entry = { ts: string; from: string | null; to: string; error?: { code: string; message: string } }
    | { ts: string; event: 'gate_overridden'; code: string; unapplied: number }
    | { ts: string; event: 'merge_request'; action: string; number: number; url: string; state: string };
  const history: Entry[] = [];
  for (const line of text.split('\n')) {
    let record: {
      ts?: unknown; type?: unknown; code?: unknown; unapplied?: unknown; action?: unknown; number?: unknown; url?: unknown; mr_state?: unknown;
      state?: { from: string | null; to: string; error?: { code: string; message: string } };
    };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (typeof record === 'object' && record !== null && record.type === 'merge_request') {
      // The merge request opened, reused, merged or found changed on the host (SF-048).
      history.push({ ts: String(record.ts), event: 'merge_request', action: String(record.action), number: Number(record.number), url: String(record.url), state: String(record.mr_state) });
    } else if (typeof record === 'object' && record !== null && typeof record.state === 'object' && record.state !== null) {
      const { from, to, error } = record.state;
      history.push({ ts: String(record.ts), from: from ?? null, to, ...(error !== undefined ? { error } : {}) });
    } else if (typeof record === 'object' && record !== null && record.type === 'gate_overridden') {
      // The user's override of the gate (SF-047) is part of the job's history.
      history.push({ ts: String(record.ts), event: 'gate_overridden', code: String(record.code), unapplied: typeof record.unapplied === 'number' ? record.unapplied : 0 });
    }
  }
  return history;
}

async function jobDetail(jobs: JobStore, job: Job, gate: boolean, actions: DashboardActions, setup: DashboardSetup) {
  const iterations = [];
  for (let number = 1; number <= job.iteration; number += 1) {
    try {
      const meta = await jobs.readMeta(job.workspace, job.ticket, number);
      iterations.push({
        number, started_at: meta.started_at, ended_at: meta.ended_at, cost_usd: meta.cost_usd,
        changed_files: meta.changed_files.length, patch_truncated: meta.patch_truncated, denials: meta.denials.length,
        // The structured file list (SF-024); null for an iteration published before it.
        files: meta.files ?? null,
        // The Claude review (SF-038): review.json as written; null while none ended.
        review: (await jobs.readReview(job.workspace, job.ticket, number)) ?? null,
        // The gate (SF-039): gate.json as written; null while none ended.
        gate: (await jobs.readGate(job.workspace, job.ticket, number)) ?? null,
        // The user's override of the stopped gate (SF-047): gate-override.json; null when none.
        gate_override: (await jobs.readGateOverride(job.workspace, job.ticket, number)) ?? null,
        // The simplification pass (SF-055): simplify.json as written; null when none ran.
        simplify: (await jobs.readSimplify(job.workspace, job.ticket, number)) ?? null,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  const mrText = await jobs.readMrText(job.workspace, job.ticket);
  const mrHost = await mrHostOf(actions, job.workspace);
  const facts = await ruleFacts(jobs, job, mrHost);
  const ledger = job.state === 'needs_human' ? facts.ledger : await jobs.readLedger(job.workspace, job.ticket);
  return {
    job: jobSummary(job, await fileCounts(jobs, job), mrHost, await taskChangedOf(setup, job), facts),
    iterations,
    mr: mrText !== undefined,
    // The merge request's title on the Git host: the MR text's first line (SF-048).
    mr_title: mrText === undefined ? null : (mrText.split(/\r?\n/)[0] ?? ''),
    // Whether the Codex gate is on (SF_GATE): the pipeline shows its step as off otherwise.
    gate,
    // The findings ledger (SF-052): ledger.json as written; [] before the first Fix section.
    ledger,
    // SF-129: the ids of the ledger entries the stop block offers Accept risk and Must fix for
    // (src/stops.ts settleEntries); [] unless the stop is one the user settles in.
    settle_ids: settleEntries(job, ledger, new Date()).map((entry) => entry.id),
    history: await stateHistory(jobs, job.workspace, job.ticket),
    // The plain explanation of the current stop (SF-106): explanation.json while it is the job's
    // current stop's (pending, written or failed); null otherwise.
    explanation: await currentExplanation(jobs, job),
  };
}

function sameToken(given: string, token: Buffer): boolean {
  const candidate = Buffer.from(given, 'utf8');
  return candidate.length === token.length && timingSafeEqual(candidate, token);
}

// Whether the Cookie header holds the cookie name with the value, compared in constant time.
// Every entry is compared (no early return), so the answer's time does not tell which one matched.
function hasCookie(header: string | undefined, name: string, value: Buffer): boolean {
  let found = false;
  for (const part of (header ?? '').split(';')) {
    const equals = part.indexOf('=');
    if (equals > 0 && part.slice(0, equals).trim() === name && sameToken(part.slice(equals + 1).trim(), value)) {
      found = true;
    }
  }
  return found;
}

// The lower-case hostname of a Host header (a port dropped), or undefined when it is not one.
function hostnameOf(host: string | undefined): string | undefined {
  const url = host === undefined ? null : URL.parse(`http://${host}`);
  return url !== null && url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === '' ? url.hostname : undefined;
}

// A refused login as a log line shows it: printable ASCII only, at most 128 characters.
function printableLogin(login: string): string {
  return login.replace(/[^\x21-\x7e]/g, '?').slice(0, 128);
}

// An iteration number of a query or a path: 1 to 9999, written without a leading zero.
function iterationParam(value: string | null | undefined): number | undefined {
  return typeof value === 'string' && /^[1-9]\d{0,3}$/.test(value) ? Number(value) : undefined;
}

// "<ws>/<ticket>" as validated names, or undefined.
function jobKey(workspace: string | undefined, ticket: string | undefined): [string, string] | undefined {
  if (workspace === undefined || ticket === undefined || !WORKSPACE_NAME_PATTERN.test(workspace) || !TICKET_PATTERN.test(ticket)) {
    return undefined;
  }
  return [workspace, ticket];
}

// What a path is for the method rule: a job action (POST only), a setup action (POST only), a
// path that lists on GET and acts on POST, or a read (GET only).
type Target =
  | { kind: 'action'; action: DashboardAction; workspace: string | undefined; ticket: string | undefined }
  | { kind: 'workspace-remove'; name: string | undefined }
  // The Workspaces dialog's Edit and the Morning digest section (SF-103), POST only.
  | { kind: 'workspace-edit'; name: string | undefined }
  | { kind: 'digest-settings' }
  // Generate now (SF-103): POST api/digests/run.
  | { kind: 'digest-run' }
  | { kind: 'ticket-action'; action: 'archive' | 'restore' | 'delete' | 'start'; workspace: string | undefined; ticket: string | undefined }
  // The Task check (SF-054): GET reads the ticket's last check, POST starts one.
  | { kind: 'ticket-check'; workspace: string | undefined; ticket: string | undefined }
  // The Task file (SF-081): GET reads it, POST saves it.
  | { kind: 'ticket-task'; workspace: string | undefined; ticket: string | undefined }
  // A ticket's images (SF-064): POST api/tickets/<ws>/<ticket>/attachments uploads one (name: the
  // name to give it, or undefined), POST .../attachments/<name>/remove removes one; GET
  // .../attachments/<name> is a read.
  | { kind: 'ticket-attachment-add'; workspace: string | undefined; ticket: string | undefined }
  | { kind: 'ticket-attachment-remove'; workspace: string | undefined; ticket: string | undefined; name: string | undefined }
  | { kind: 'both'; route: 'workspace-add' | 'ticket-new' }
  // The run queue (SF-071): api/queue/<action>, POST only.
  | { kind: 'queue'; action: QueueAction }
  | { kind: 'read' };

function targetOf(path: string[]): Target {
  const [api, kind, a, b, c] = path;
  if (api !== 'api') {
    return { kind: 'read' };
  }
  if (kind === 'jobs' && path.length === 5) {
    const action = ACTIONS.find((known) => known === c);
    if (action !== undefined) {
      return { kind: 'action', action, workspace: a, ticket: b };
    }
  }
  if (kind === 'workspaces' && path.length === 2) {
    return { kind: 'both', route: 'workspace-add' };
  }
  if (kind === 'workspaces' && path.length === 4 && b === 'remove' && c === undefined) {
    return { kind: 'workspace-remove', name: a };
  }
  if (kind === 'workspaces' && path.length === 4 && b === 'edit') {
    return { kind: 'workspace-edit', name: a };
  }
  if (kind === 'digest-settings' && path.length === 2) {
    return { kind: 'digest-settings' };
  }
  if (kind === 'digests' && path.length === 3 && a === 'run') {
    return { kind: 'digest-run' };
  }
  if (kind === 'tickets' && path.length === 2) {
    return { kind: 'both', route: 'ticket-new' };
  }
  if (kind === 'tickets' && path.length === 5 && (c === 'archive' || c === 'restore' || c === 'delete' || c === 'start')) {
    return { kind: 'ticket-action', action: c, workspace: a, ticket: b };
  }
  if (kind === 'tickets' && path.length === 5 && c === 'check') {
    return { kind: 'ticket-check', workspace: a, ticket: b };
  }
  if (kind === 'tickets' && path.length === 5 && c === 'task') {
    return { kind: 'ticket-task', workspace: a, ticket: b };
  }
  if (kind === 'tickets' && path.length === 5 && c === 'attachments') {
    return { kind: 'ticket-attachment-add', workspace: a, ticket: b };
  }
  if (kind === 'tickets' && path.length === 7 && c === 'attachments' && path[6] === 'remove') {
    return { kind: 'ticket-attachment-remove', workspace: a, ticket: b, name: path[5] };
  }
  const queueAction = QUEUE_ACTIONS.find((known) => known === a);
  if (kind === 'queue' && path.length === 3 && queueAction !== undefined) {
    return { kind: 'queue', action: queueAction };
  }
  return { kind: 'read' };
}

// application/json, optionally with a UTF-8 charset parameter; nothing else.
function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) {
    return false;
  }
  const [type, ...params] = header.split(';').map((part) => part.trim().toLowerCase());
  return type === 'application/json' && params.every((param) => param === '' || /^charset="?utf-?8"?$/.test(param));
}

// application/octet-stream, without parameters: the raw bytes of an image upload (SF-064).
function isOctetStream(header: string | undefined): boolean {
  return header !== undefined && header.trim().toLowerCase() === 'application/octet-stream';
}

// The whole body up to limit bytes, counted while streaming and against Content-Length first.
// 'interrupted' when the connection ends before the body does: nothing is answered then.
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | 'too_large' | 'interrupted'> {
  return new Promise((resolve) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
      resolve('too_large');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: Buffer | 'too_large' | 'interrupted'): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        settle('too_large');
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => settle(Buffer.concat(chunks)));
    req.once('error', () => settle('interrupted'));
    req.once('close', () => settle('interrupted'));
  });
}

interface Stream {
  res: ServerResponse;
  job: [string, string] | undefined;
  abort: AbortController;
  // Opened on the remote port (SF-126): its jobs events say remote: true.
  remote: boolean;
}

// One POST, validated and dispatched: the body shape, the one call it stands for, and whether
// the page refreshes its setup data after it.
interface Post {
  route: PostRoute;
  // A check before the body is read; false answers an empty 404.
  exists?: () => Promise<boolean>;
  // The job's ticket, which "confirm" must equal on the remote port (SF-126: CONFIRM_ROUTES).
  confirm?: string;
  call: (data: unknown) => (() => Promise<unknown>) | undefined;
  // The raw body's bound in bytes; MAX_ACTION_BODY_BYTES by default.
  bodyLimit?: number;
  // The body is the raw bytes of an image (SF-064), not JSON: Content-Type
  // application/octet-stream, call gets the Buffer, and a body over the bound is
  // attachment_too_large.
  bytes?: boolean;
  refreshSetup?: boolean;
  // The action may end a job too (archive, delete): every page gets the jobs again.
  refreshJobs?: boolean;
  // The action may change the job's record without a state change (mr-status, SF-048): every page
  // gets the jobs again, and the pages that show the job its detail, as on a state change.
  refreshJob?: [string, string];
}

// gate: whether the Codex gate is on (SF_GATE), shown in the job's pipeline; checks: the Task
// checks (SF-054), none without (the check routes answer 404, the tickets have no check); queue:
// the run queue (SF-071), none without (the queue routes answer 404, the tickets payload's queue is
// null); onWorkspacesChanged: called after a workspace was added, edited or removed (SF-086: the
// automatic checks read the registry again); digests: the morning digest (SF-103), none without (the
// digest routes answer 404); remoteOrigins: the origins of SF_DASHBOARD_REMOTE_ORIGINS (SF-118), as
// dashboardRemoteOrigins returns them (not parsed again); with them a second listener opens on
// remotePort (SF-126, SF_DASHBOARD_REMOTE_PORT), the only one that accepts them, and only from
// remoteLogins (SF_DASHBOARD_REMOTE_LOGINS, as dashboardRemoteLogins returns them). The logins and the
// two ports are checked here too (invalid_config), for a caller that did not check them.
export async function startDashboard(
  port: number, stateDir: string, jobs: JobStore, actions: DashboardActions, setup: DashboardSetup = NO_SETUP,
  { gate: gateOn = true, checks, queue, onWorkspacesChanged, digests, remoteOrigins = [], remoteLogins = [], remotePort = DEFAULT_DASHBOARD_REMOTE_PORT }: {
    gate?: boolean; checks?: DashboardChecks; queue?: DashboardQueue; onWorkspacesChanged?: () => void; digests?: DashboardDigests;
    remoteOrigins?: readonly string[]; remoteLogins?: readonly string[]; remotePort?: number;
  } = {},
): Promise<RunningDashboard> {
  const remoteOn = remoteOrigins.length > 0;
  if (remoteOn) {
    dashboardRemoteLogins(remoteOrigins, { SF_DASHBOARD_REMOTE_LOGINS: remoteLogins.join(',') });
    checkDashboardPorts(port, remotePort);
  }
  // The workspace change succeeded: the hook hears of it (a failing hook is logged).
  const workspacesChanged = <T>(result: T): T => {
    try {
      onWorkspacesChanged?.();
    } catch (error) {
      console.error(error);
    }
    return result;
  };
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const [path, { file, type }] of Object.entries(STATIC_FILES)) {
    files.set(path, { body: await readFile(new URL(file, STATIC_DIR)), type });
  }
  // The token persists across starts, so a bookmark keeps working; a missing or unusable file
  // gets a new one (sf dashboard --rotate removes the file on purpose).
  let tokenText = await readToken(stateDir).catch(() => undefined);
  if (tokenText === undefined) {
    tokenText = newToken();
    await writeFileAtomic(join(stateDir, TOKEN_FILE), Buffer.from(`${tokenText}\n`));
  }
  const token = Buffer.from(tokenText, 'utf8');
  // The cookie of a token visit (SF-126): the hex HMAC-SHA256 of the token over the side's label,
  // so it survives restarts and dies with the token. The local name carries the port (cookies are
  // not kept apart by port); the remote one is __Host- and Secure (the phone reaches it over https).
  const cookieOf = (side: 'local' | 'remote'): Buffer => Buffer.from(createHmac('sha256', tokenText).update(`dashboard-cookie:${side}`).digest('hex'), 'utf8');
  const cookies = {
    local: { name: '', value: cookieOf('local'), attributes: 'HttpOnly; SameSite=Strict; Path=/' },
    remote: { name: '__Host-sf_dashboard', value: cookieOf('remote'), attributes: 'HttpOnly; Secure; SameSite=Strict; Path=/' },
  };

  const streams = new Set<Stream>();
  const toolCalls = new ToolCallCounter();
  const changes = new Changes(jobs);
  // The tickets' history (SF-081), read for the planned ticket page.
  const history = new TicketHistory(stateDir);
  // The Stats page's numbers (SF-117), with their caches.
  const stats = new Stats(stateDir, jobs);
  // The local port accepts loopback Hosts and Origins only, as before SF-118, and ignores any
  // Tailscale-User-* header.
  const validateHost = hostHeaderValidation([...LOOPBACK_NAMES]);
  const validateOrigin = localhostOriginValidation();
  // The remote port (SF-126): remote is a fact of the socket. Tailscale's identity header names a
  // listed login; the Host is a listed ts.net name (a proxy may keep it), or loopback (a proxy may
  // rewrite it) with a listed Origin; an Origin, when sent, is a listed one, and only GET and HEAD
  // may come without one. Anything else is an empty 403; a login refused is one log line that
  // names the login, never the path.
  const remoteHosts = new Set(remoteOrigins.map((remote) => new URL(remote).hostname));
  const remoteAllowed = (req: IncomingMessage): boolean => {
    const sentLogin = req.headers['tailscale-user-login'];
    const login = typeof sentLogin === 'string' && sentLogin.trim() !== '' ? sentLogin.trim() : undefined;
    if (login === undefined || !remoteLogins.includes(login.toLowerCase())) {
      console.error(`dashboard: refused a request on the remote port from login ${login === undefined ? 'none' : printableLogin(login)} (not in SF_DASHBOARD_REMOTE_LOGINS)`);
      return false;
    }
    const host = hostnameOf(req.headers.host);
    const sent = req.headers.origin;
    if (sent === undefined) {
      return (req.method === 'GET' || req.method === 'HEAD') && host !== undefined && remoteHosts.has(host);
    }
    return remoteOrigins.includes(sent) && host !== undefined && (remoteHosts.has(host) || LOOPBACK_NAMES.has(host));
  };
  // The exact origin of the page, known once the listener has its port.
  let origin = '';
  const send = (stream: Stream, event: string, data: unknown): void => {
    if (!stream.abort.signal.aborted) {
      stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  const empty = (res: ServerResponse, status: number, headers: Record<string, string> = {}): void => {
    res.writeHead(status, headers).end();
  };
  const body = (res: ServerResponse, type: string, data: string | Buffer): void => {
    res.writeHead(200, { 'content-type': type }).end(data);
  };
  const json = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(data));
  };

  // The start screen's data, sent to every page on connect and after every change.
  async function sendSetup(targets: Iterable<Stream>): Promise<void> {
    const workspaces = await workspacesPayload(setup);
    const tickets = await ticketsPayload(setup, checks, queue);
    for (const stream of targets) {
      send(stream, 'workspaces', workspaces);
      send(stream, 'tickets', tickets);
    }
  }

  // The jobs as api/jobs and the jobs events send them (SF-126): remote says which port asked.
  const jobsOf = async (remote: boolean) => ({ ...(await jobsPayload(jobs, setup, actions, toolCalls)), remote });

  async function openStream(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, remote: boolean): Promise<void> {
    const [workspace, ticket, ...more] = (query.get('job') ?? '').split('/');
    const from = query.get('from') ?? '0';
    let key: [string, string] | undefined;
    if (query.has('job')) {
      key = more.length === 0 ? jobKey(workspace, ticket) : undefined;
      if (key === undefined || (await jobs.read(...key)) === undefined) {
        empty(res, 404);
        return;
      }
    }
    if (!/^\d{1,9}$/.test(from)) {
      empty(res, 404);
      return;
    }
    if (req.socket.destroyed) {
      return;
    }
    if (streams.size >= MAX_STREAMS) {
      empty(res, 503);
      return;
    }
    const stream: Stream = { res, job: key, abort: new AbortController(), remote };
    streams.add(stream);
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), KEEP_ALIVE_MS);
    const end = (): void => {
      clearInterval(keepAlive);
      stream.abort.abort();
      streams.delete(stream);
    };
    req.once('close', end);
    res.once('close', end);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
    res.flushHeaders();
    send(stream, 'jobs', await jobsOf(remote));
    await sendSetup([stream]);
    if (key === undefined) {
      return;
    }
    const job = await jobs.read(...key);
    if (job !== undefined) {
      send(stream, 'job', await jobDetail(jobs, job, gateOn, actions, setup));
    }
    const start = Number(from);
    const [workspaceName, ticketName] = key;
    // The job's Stream (SF-082): each line's entries, built asynchronously but sent strictly in
    // line order on one promise chain; the job's files are read fresh for each line.
    let entries: Promise<void> = Promise.resolve();
    try {
      await followLines(jobs.eventsPath(...key), true, (raw, line) => {
        const event = line >= start ? describeEvent(raw) : undefined;
        if (event !== undefined && event.lines.length > 0) {
          send(stream, 'event', { line, ts: event.ts, iteration: event.iteration, type: event.type, text: event.lines.join('\n') });
        }
        if (line >= start) {
          entries = entries.then(async () => {
            if (stream.abort.signal.aborted) {
              return;
            }
            const built = await lineEntries(raw, line, streamContext(jobs, workspaceName, ticketName));
            if (built.length > 0) {
              send(stream, 'entries', { line, entries: built });
            }
          }).catch((error: unknown) => console.error(error));
        }
      }, stream.abort.signal);
    } catch (error) {
      // A job without events.jsonl yet has nothing to follow; the stream stays open for state changes.
      if (!(error instanceof FactoryError)) {
        throw error;
      }
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string[], query: URLSearchParams, remote: boolean): Promise<void> {
    const joined = path.join('/');
    const file = files.get(joined);
    if (file !== undefined) {
      body(res, file.type, file.body);
      return;
    }
    if (path[0] !== 'api') {
      empty(res, 404);
      return;
    }
    if (joined === 'api/jobs') {
      body(res, 'application/json; charset=utf-8', JSON.stringify(await jobsOf(remote)));
      return;
    }
    if (joined === 'api/workspaces') {
      body(res, 'application/json; charset=utf-8', JSON.stringify(await workspacesPayload(setup)));
      return;
    }
    if (joined === 'api/tickets') {
      body(res, 'application/json; charset=utf-8', JSON.stringify(await ticketsPayload(setup, checks, queue)));
      return;
    }
    if (joined === 'api/stream') {
      await openStream(req, res, query, remote);
      return;
    }
    if (path[1] === 'stats') {
      await statsView(res, path, query);
      return;
    }
    const [, kind, ...rest] = path;
    // The morning digest (SF-103): the list, newest first, and one stored record.
    if (kind === 'digests' && digests !== undefined && [...query.keys()].length === 0 && rest.length <= 1) {
      if (rest.length === 0) {
        json(res, 200, await digests.list());
        return;
      }
      const record = await digests.read(rest[0]!);
      if (record === undefined) {
        empty(res, 404);
        return;
      }
      json(res, 200, record);
      return;
    }
    if (kind === 'tickets' && rest.length === 3 && rest[2] === 'page') {
      await ticketPage(res, rest, query);
      return;
    }
    if (kind === 'tickets' && rest.length === 4 && rest[2] === 'attachments') {
      await attachmentFile(res, rest, query);
      return;
    }
    if (kind === 'tickets') {
      await taskText(res, rest, query);
      return;
    }
    const key = kind === 'jobs' ? jobKey(rest[0], rest[1]) : undefined;
    const job = key === undefined ? undefined : await jobs.read(...key);
    if (key === undefined || job === undefined) {
      empty(res, 404);
      return;
    }
    const [, , ...tail] = rest;
    if (tail.length === 0) {
      // A handed-over job (SF-073): origin is asked for the user's push, without waiting and at most
      // once a minute; a push found reaches the page through the job's events.
      if (job.state === 'handed_over') {
        void actions.checkHandedOver(job.workspace, job.ticket, PUSH_CHECK_INTERVAL_MS).catch((error: unknown) => console.error(error));
      }
      body(res, 'application/json; charset=utf-8', JSON.stringify(await jobDetail(jobs, job, gateOn, actions, setup)));
      return;
    }
    if (tail.length === 1 && tail[0] === 'stream') {
      const from = query.get('from') ?? '0';
      if (!/^\d{1,9}$/.test(from)) {
        empty(res, 404);
        return;
      }
      json(res, 200, await streamPage(...key, Number(from)));
      return;
    }
    if (tail.length === 1 && tail[0] === 'mr') {
      const text = await jobs.readMrText(...key);
      if (text === undefined) {
        empty(res, 404);
        return;
      }
      body(res, 'text/markdown; charset=utf-8', text);
      return;
    }
    if (tail.length === 1 && tail[0] === 'mr-view' && [...query.keys()].length === 0) {
      // The Merge request screen (SF-080); an empty 404 without MR text.
      let view;
      try {
        view = await actions.mergeRequestView(...key);
      } catch (error) {
        refuseRead(res, error);
        return;
      }
      if (view === undefined) {
        empty(res, 404);
        return;
      }
      json(res, 200, view);
      return;
    }
    if (tail.length === 1 && (tail[0] === 'changes' || tail[0] === 'file')) {
      const data = tail[0] === 'changes' ? await changesOf(job, query) : await fileOf(job, query);
      if (data === undefined) {
        empty(res, 404);
        return;
      }
      json(res, 200, data);
      return;
    }
    const number = Number(tail[1]);
    if (tail.length === 3 && tail[0] === 'iterations' && iterationParam(tail[1]) !== undefined && number <= job.iteration
      && (tail[2] === 'report' || tail[2] === 'patch')) {
      const iteration = await jobs.readIteration(...key, number);
      if (tail[2] === 'report') {
        body(res, 'text/markdown; charset=utf-8', iteration.report);
      } else {
        body(res, 'text/x-diff; charset=utf-8', iteration.patch);
      }
      return;
    }
    empty(res, 404);
  }

  // GET api/stats?days=7|30|90[&workspace=<name>] (SF-117): the Stats page's payload. Any other
  // key or value, a repeated key or a longer path is an empty 404.
  async function statsView(res: ServerResponse, path: string[], query: URLSearchParams): Promise<void> {
    const keys = [...query.keys()];
    const days = STATS_DAYS.find((value) => String(value) === query.get('days'));
    const workspace = query.get('workspace');
    if (path.length !== 2 || days === undefined || new Set(keys).size !== keys.length || keys.some((key) => key !== 'days' && key !== 'workspace')
      || (workspace !== null && !WORKSPACE_NAME_PATTERN.test(workspace))) {
      empty(res, 404);
      return;
    }
    json(res, 200, await stats.compute({ days: days satisfies StatsDays, workspace }));
  }

  // GET api/jobs/<ws>/<ticket>/changes (SF-079): the base and the published iterations; with
  // ?from=base|<N>&to=<N> the files of that view (the base of to against to, or to - 1 against to).
  // Any other query or pair is undefined (an empty 404).
  async function changesOf(job: Job, query: URLSearchParams): Promise<unknown> {
    const keys = [...query.keys()];
    if (keys.length === 0) {
      return changes.index(job);
    }
    const from = query.get('from');
    const to = iterationParam(query.get('to'));
    if (keys.length !== 2 || from === null || to === undefined || (from !== 'base' && iterationParam(from) === undefined)) {
      return undefined;
    }
    return changes.files(job, from === 'base' ? 'base' : Number(from), to);
  }

  // GET api/jobs/<ws>/<ticket>/file?at=base|<N>&path=<path> (SF-079; &of=<N> with at=base, the
  // last iteration when left out): one side of one file of a view's list.
  async function fileOf(job: Job, query: URLSearchParams): Promise<unknown> {
    const at = query.get('at');
    const path = query.get('path');
    const of = query.get('of');
    const allowed = new Set(['at', 'path', ...(at === 'base' ? ['of'] : [])]);
    const keys = [...query.keys()];
    if (at === null || path === null || keys.some((name) => !allowed.has(name)) || new Set(keys).size !== keys.length) {
      return undefined;
    }
    if (at === 'base') {
      const n = of === null ? job.iteration : iterationParam(of);
      return n === undefined ? undefined : changes.file(job, 'base', n, path);
    }
    const n = iterationParam(at);
    return n === undefined ? undefined : changes.file(job, n, n, path);
  }

  // GET api/jobs/<ws>/<ticket>/stream?from=<line> (SF-082): the entries of at most STREAM_PAGE_LINES
  // lines of events.jsonl from the 0-based from, in line order; next is the first line not read, end
  // whether the file has no more lines. The job's files are read once for the page.
  async function streamPage(workspace: string, ticket: string, from: number): Promise<{ entries: StreamEntry[]; next: number; end: boolean }> {
    const lines: Array<[string, number]> = [];
    let end = true;
    const stop = new AbortController();
    try {
      await followLines(jobs.eventsPath(workspace, ticket), false, (raw, line) => {
        if (line >= from + STREAM_PAGE_LINES) {
          end = false;
          stop.abort();
        } else if (line >= from) {
          lines.push([raw, line]);
        }
      }, stop.signal);
    } catch (error) {
      // A job without events.jsonl has no entries yet.
      if (!(error instanceof FactoryError)) {
        throw error;
      }
      return { entries: [], next: 0, end: true };
    }
    const ctx = streamContext(jobs, workspace, ticket);
    const entries: StreamEntry[] = [];
    for (const [raw, line] of lines) {
      entries.push(...(await lineEntries(raw, line, ctx)));
    }
    return { entries, next: from + lines.length, end };
  }

  // A read of a Task file the reader refused: an empty 404 for a missing ticket, workspace or file,
  // as for the other reads, else the refusal; anything but a FactoryError is thrown on.
  function refuseRead(res: ServerResponse, error: unknown): void {
    if (!(error instanceof FactoryError)) {
      throw error;
    }
    const status = ERROR_STATUS[error.code] ?? 500;
    if (status === 404) {
      empty(res, 404);
    } else {
      json(res, status, { ok: false, error: { code: error.code, message: error.message } });
    }
  }

  // GET api/tickets/<ws>/<ticket>/page (SF-081): the planned ticket page in one payload: the tickets
  // row with its conversation, the Task file and its sha256 (the version a Save starts from), the
  // plan in plain words, the last check (null without the Task checks), the plan-check rounds of
  // every version (SF-130: check_rounds, failed ones included; check_usd, the sum of the known costs;
  // check_usd_complete, false when a cost is unknown; all-time), the history, newest first, and
  // queue null (SF-071 adds it). A ticket that is not in the tickets list is an empty 404.
  async function ticketPage(res: ServerResponse, rest: string[], query: URLSearchParams): Promise<void> {
    const key = jobKey(rest[0], rest[1]);
    const row = key === undefined || [...query.keys()].length > 0 ? undefined : (await setup.tickets()).find((entry) => entry.workspace === key[0] && entry.ticket === key[1]);
    if (key === undefined || row === undefined) {
      empty(res, 404);
      return;
    }
    let file;
    try {
      file = await setup.taskFile(...key);
    } catch (error) {
      refuseRead(res, error);
      return;
    }
    let check = null;
    let records: CheckRecord[] = [];
    if (checks !== undefined) {
      try {
        check = await checks.view(...key);
        records = await checks.store.records(...key);
      } catch (error) {
        console.error(error);
      }
    }
    json(res, 200, {
      ticket: await ticketEntry(row, checks),
      task: { text: file.text, sha256: file.sha256 },
      plan: planOf(file.text, row),
      check,
      check_rounds: records.length,
      check_usd: records.reduce((total, record) => total + (record.cost_usd ?? 0), 0),
      check_usd_complete: records.every((record) => record.cost_usd !== null),
      history: await history.timeline(...key, { sha256: file.sha256, mtime: file.mtime }),
      queue: null,
    });
  }

  // GET api/tickets/<ws>/<ticket>/task[?archived=1]: the Task file through the Task file reader,
  // as text/markdown. A missing ticket, workspace or file is an empty 404, as for the other reads;
  // a file the reader refuses (not a Task file, not a regular file) answers its refusal.
  async function taskText(res: ServerResponse, rest: string[], query: URLSearchParams): Promise<void> {
    const key = rest.length === 3 && rest[2] === 'task' ? jobKey(rest[0], rest[1]) : undefined;
    const archived = query.get('archived');
    if (key === undefined || (archived !== null && archived !== '1') || query.getAll('archived').length > 1) {
      empty(res, 404);
      return;
    }
    let text: string;
    try {
      text = await setup.taskText(...key, archived === '1');
    } catch (error) {
      refuseRead(res, error);
      return;
    }
    body(res, 'text/markdown; charset=utf-8', text);
  }

  // GET api/tickets/<ws>/<ticket>/attachments/<name> (SF-064): one image of the ticket with the
  // type told by its bytes and nosniff. A missing ticket, workspace, Task file or image is an empty
  // 404; anything the attachments module refuses answers its refusal.
  async function attachmentFile(res: ServerResponse, rest: string[], query: URLSearchParams): Promise<void> {
    const key = jobKey(rest[0], rest[1]);
    if (key === undefined || [...query.keys()].length > 0) {
      empty(res, 404);
      return;
    }
    let image;
    try {
      image = await setup.readAttachment(...key, rest[3]!);
    } catch (error) {
      if (error instanceof FactoryError && error.code === 'attachment_missing') {
        empty(res, 404);
        return;
      }
      refuseRead(res, error);
      return;
    }
    res.writeHead(200, { 'content-type': image.type, 'x-content-type-options': 'nosniff' }).end(image.data);
  }

  // GET api/tickets/<ws>/<ticket>/check (SF-054): the ticket's last check as JSON, with whether it
  // is stale (the Task file changed since) and running; check null when there is none. A missing
  // workspace or Task file is an empty 404.
  async function checkView(res: ServerResponse, key: [string, string]): Promise<void> {
    if (checks === undefined) {
      empty(res, 404);
      return;
    }
    let view;
    try {
      view = await checks.view(...key);
    } catch (error) {
      if (error instanceof FactoryError && ERROR_STATUS[error.code] === 404) {
        empty(res, 404);
        return;
      }
      throw error;
    }
    if (view.current_sha256 === null && view.check === null) {
      empty(res, 404);
      return;
    }
    json(res, 200, view);
  }

  // POST api/tickets/<ws>/<ticket>/check: starts a check and answers at once; its end reaches every
  // page through refreshSetup.
  function checkPost(key: [string, string]): Post | undefined {
    if (checks === undefined) {
      return undefined;
    }
    const run = (): Promise<unknown> => checks.start(...key);
    return { route: 'ticket-check', call: (data) => (BODIES['ticket-check'].schema.safeParse(data).success ? run : undefined), refreshSetup: true };
  }

  // The job action as the one Execution call it stands for.
  function jobPost(action: DashboardAction, [workspace, ticket]: [string, string]): Post {
    const parse = <T>(schema: z.ZodType<T>, data: unknown): T | undefined => {
      const parsed = schema.safeParse(data);
      return parsed.success ? parsed.data : undefined;
    };
    const exists = async (): Promise<boolean> => (await jobs.read(workspace, ticket)) !== undefined;
    if (action === 'approve') {
      return {
        route: action, exists, confirm: ticket,
        call: (data) => {
          const parsed = parse(BODIES.approve.schema, data);
          return parsed ? () => actions.approve(workspace, ticket, parsed.as_is === true) : undefined;
        },
      };
    }
    if (action === 'abort') {
      return {
        route: action, exists,
        call: (data) => {
          const parsed = parse(BODIES.abort.schema, data);
          return parsed ? () => actions.abort(workspace, ticket, parsed.discard === true) : undefined;
        },
      };
    }
    if (action === 'review') {
      // sf review: the Execution refuses any state but needs_human with review_failed.
      const run = (): Promise<unknown> => actions.retryReview(workspace, ticket);
      return { route: action, exists, call: (data) => (parse(BODIES.review.schema, data) ? run : undefined) };
    }
    if (action === 'retry') {
      // sf retry (SF-087): the Execution refuses any job but one a transient MR preparation failure
      // stopped; on mr_push_failed it pushes again.
      const run = (): Promise<unknown> => actions.retryMr(workspace, ticket);
      return { route: action, exists, confirm: ticket, call: (data) => (parse(BODIES.retry.schema, data) ? run : undefined) };
    }
    if (action === 'accept') {
      // sf accept: the Execution refuses any state but needs_human after a stop it takes on (the
      // gate's, the ledger's, the Fix round limit), with the checks of acceptGateInRunner.
      const run = (): Promise<unknown> => actions.acceptGate(workspace, ticket);
      return { route: action, exists, call: (data) => (parse(BODIES.accept.schema, data) ? run : undefined) };
    }
    if (action === 'simplify') {
      // sf simplify (SF-055): the Execution refuses any state but needs_human with simplify_offered.
      const run = (): Promise<unknown> => actions.simplify(workspace, ticket);
      return { route: action, exists, call: (data) => (parse(BODIES.simplify.schema, data) ? run : undefined) };
    }
    if (action === 'settle') {
      // sf settle (SF-052): the Execution refuses any state but needs_human, and any entry but an
      // escalated or contested one.
      return {
        route: action, exists,
        call: (data) => {
          const parsed = parse(BODIES.settle.schema, data);
          return parsed ? () => actions.settle(workspace, ticket, parsed.id, parsed.decision, parsed.note ?? '') : undefined;
        },
      };
    }
    if (action === 'mr-create' || action === 'mr-merge' || action === 'mr-status') {
      // sf mr create, merge and status (SF-048). The Execution announces an opened or merged merge
      // request to every page; a state the status found changed on the host reaches them here: the
      // jobs, and the job's detail to the pages that show it.
      const methods = { 'mr-create': actions.createMergeRequest, 'mr-merge': actions.mergeMergeRequest, 'mr-status': actions.mergeRequestStatus };
      const method = methods[action].bind(actions);
      const run = (): Promise<unknown> => method(workspace, ticket);
      return {
        route: action, exists, call: (data) => (parse(BODIES[action].schema, data) ? run : undefined),
        ...(action === 'mr-status' ? { refreshJob: [workspace, ticket] as [string, string] } : { confirm: ticket }),
      };
    }
    if (action === 'pause') {
      // sf pause (SF-067): the Execution refuses any state but working and awaiting_review.
      const run = (): Promise<unknown> => actions.pause(workspace, ticket);
      return { route: action, exists, call: (data) => (parse(BODIES.pause.schema, data) ? run : undefined) };
    }
    if (action === 'resume') {
      // sf resume (SF-067): paused only; a message only when a turn was paused.
      return {
        route: action, exists,
        call: (data) => {
          const parsed = parse(BODIES.resume.schema, data);
          return parsed ? () => actions.resumePaused(workspace, ticket, parsed.message ?? '') : undefined;
        },
      };
    }
    if (action === 'restart') {
      // sf restart (SF-067): a new job replaces the old one, so every page gets the jobs again.
      return {
        route: action, exists, refreshJobs: true,
        call: (data) => {
          const parsed = parse(BODIES.restart.schema, data);
          return parsed ? () => actions.restart(workspace, ticket, parsed.keep_files === true) : undefined;
        },
      };
    }
    if (action === 'handover' || action === 'takeback' || action === 'handed-done') {
      // sf handover, takeback and handed-done (SF-073): the Execution refuses any state but
      // ready_for_human_review (handover) and handed_over (the others).
      const methods = { handover: actions.handover, takeback: actions.takeback, 'handed-done': actions.handedDone };
      const method = methods[action].bind(actions);
      const run = (): Promise<unknown> => method(workspace, ticket);
      return { route: action, exists, call: (data) => (parse(BODIES[action].schema, data) ? run : undefined) };
    }
    if (action === 'mr-save' || action === 'mr-reset') {
      // The Merge request screen (SF-080): the Execution refuses any state but ready_for_human_review
      // and needs_human after a failed push; the job's detail reaches every page that shows it.
      return {
        route: action, exists, bodyLimit: MAX_MR_BODY_BYTES, refreshJob: [workspace, ticket],
        call: (data) => {
          if (action === 'mr-reset') {
            return parse(BODIES['mr-reset'].schema, data) ? () => actions.resetMr(workspace, ticket) : undefined;
          }
          const parsed = parse(BODIES['mr-save'].schema, data);
          return parsed ? () => actions.saveMr(workspace, ticket, parsed) : undefined;
        },
      };
    }
    if (action === 'archive') {
      // A finished job leaves the Jobs list as with sf reset (the history is archived, a kept
      // worktree removed, the branch untouched). A live job is refused (invalid_state); the
      // Execution checks the state and retires the job under one lock acquisition.
      const run = (): Promise<unknown> => actions.archiveFinished(workspace, ticket);
      return { route: action, exists, call: (data) => (parse(BODIES.archive.schema, data) ? run : undefined), refreshJobs: true };
    }
    return {
      route: action, exists,
      call: (data) => {
        const parsed = parse(BODIES.say.schema, data);
        return parsed ? () => actions.say(workspace, ticket, parsed.message) : undefined;
      },
    };
  }

  // POST api/tickets/<ws>/<ticket>/task (SF-081): Save of the planned ticket page, through
  // Setup.saveTask; the new version (and the check it made stale) reaches every page. With the run
  // queue, under its lock of the ticket (SF-086): never between its last look at the plan and the
  // start.
  function taskPost([workspace, ticket]: [string, string]): Post {
    return {
      route: 'ticket-task',
      bodyLimit: MAX_TASK_BODY_BYTES,
      call: (data) => {
        const parsed = BODIES['ticket-task'].schema.safeParse(data);
        if (!parsed.success) {
          return undefined;
        }
        const save = (): ReturnType<DashboardSetup['saveTask']> => setup.saveTask(workspace, ticket, parsed.data.content, parsed.data.sha256);
        return () => (queue === undefined ? save() : queue.withTicket(workspace, ticket, save));
      },
      refreshSetup: true,
    };
  }

  // POST api/tickets/<ws>/<ticket>/attachments[?name=<name>] (SF-064): one image as raw bytes, at
  // most MAX_ATTACHMENT_BYTES; the next number when name is left out. The ticket's new images reach
  // every page (its row, its conversation).
  function attachmentAddPost([workspace, ticket]: [string, string], name: string | undefined): Post {
    return {
      route: 'ticket-attachment-add',
      bytes: true,
      bodyLimit: MAX_ATTACHMENT_BYTES,
      call: (data) => (data instanceof Buffer ? () => setup.addAttachment(workspace, ticket, data, name) : undefined),
      refreshSetup: true,
    };
  }

  // POST api/tickets/<ws>/<ticket>/attachments/<name>/remove (SF-064) with {}.
  function attachmentRemovePost([workspace, ticket]: [string, string], name: string): Post {
    return {
      route: 'ticket-attachment-remove',
      call: (data) => (BODIES['ticket-attachment-remove'].schema.safeParse(data).success ? () => setup.removeAttachment(workspace, ticket, name) : undefined),
      refreshSetup: true,
    };
  }

  function setupPost(target: Exclude<Target, { kind: 'read' | 'action' | 'ticket-check' | 'ticket-task' | 'queue' | 'ticket-attachment-add' | 'ticket-attachment-remove' }>): Post | undefined {
    if (target.kind === 'workspace-edit') {
      const name = target.name;
      if (name === undefined || !WORKSPACE_NAME_PATTERN.test(name)) {
        return undefined;
      }
      return {
        route: 'workspace-edit',
        call: (data) => {
          const parsed = BODIES['workspace-edit'].schema.safeParse(data);
          return parsed.success ? () => setup.editWorkspace(name, parsed.data).then(workspacesChanged) : undefined;
        },
        refreshSetup: true,
      };
    }
    if (target.kind === 'digest-settings') {
      return {
        route: 'digest-settings',
        call: (data) => {
          const parsed = BODIES['digest-settings'].schema.safeParse(data);
          return parsed.success ? () => setup.saveDigestSettings(parsed.data) : undefined;
        },
        refreshSetup: true,
      };
    }
    if (target.kind === 'digest-run') {
      const run = digests;
      if (run === undefined) {
        return undefined;
      }
      return { route: 'digest-run', call: (data) => (BODIES['digest-run'].schema.safeParse(data).success ? async () => run.start('manual') : undefined) };
    }
    if (target.kind === 'ticket-action') {
      const key = jobKey(target.workspace, target.ticket);
      if (key === undefined) {
        return undefined;
      }
      const [workspace, ticket] = key;
      if (target.action === 'start') {
        // sf start: the Execution refuses a skeleton (task_draft), a live job and every other
        // reason a job cannot start; the new job and the shorter ticket list reach every page.
        const run = (): Promise<unknown> => actions.start(workspace, ticket);
        return { route: 'ticket-start', call: (data) => (BODIES['ticket-start'].schema.safeParse(data).success ? run : undefined), refreshJobs: true };
      }
      const route = `ticket-${target.action}` as const;
      const methods = { archive: setup.archiveTicket, restore: setup.restoreTicket, delete: setup.deleteTicket };
      const method = methods[target.action].bind(setup);
      return { route, call: (data) => (BODIES[route].schema.safeParse(data).success ? () => method(workspace, ticket) : undefined), refreshSetup: true, refreshJobs: target.action !== 'restore' };
    }
    if (target.kind === 'workspace-remove') {
      const name = target.name;
      if (name === undefined || !WORKSPACE_NAME_PATTERN.test(name)) {
        return undefined;
      }
      return { route: 'workspace-remove', call: (data) => (BODIES['workspace-remove'].schema.safeParse(data).success ? () => setup.removeWorkspace(name).then(workspacesChanged) : undefined), refreshSetup: true };
    }
    if (target.route === 'workspace-add') {
      return {
        route: 'workspace-add',
        call: (data) => {
          const parsed = BODIES['workspace-add'].schema.safeParse(data);
          if (!parsed.success) {
            return undefined;
          }
          const { name, path, ...options } = parsed.data;
          return () => setup.addWorkspace(name, path, options).then(workspacesChanged);
        },
        refreshSetup: true,
      };
    }
    return {
      route: 'ticket-new',
      call: (data) => {
        const parsed = BODIES['ticket-new'].schema.safeParse(data);
        return parsed.success ? () => setup.createTicket(parsed.data) : undefined;
      },
      refreshSetup: true,
    };
  }

  // The run queue's changes (SF-071): each body to its one call; every page gets the tickets again.
  function queuePost(action: QueueAction, runQueue: DashboardQueue): Post {
    const calls: { [A in QueueAction]: (data: z.infer<(typeof BODIES)[`queue-${A}`]['schema']>) => Promise<unknown> } = {
      add: (data) => runQueue.add(data.workspace, data.ticket, data.at),
      remove: (data) => runQueue.remove(data.workspace, data.ticket),
      move: (data) => runQueue.move(data.workspace, data.ticket, data.to),
      limit: (data) => runQueue.limit(data.max_running),
      hold: (data) => runQueue.hold(data.reason),
      release: () => runQueue.release(),
      rule: (data) => runQueue.rule(data.rule),
      force: (data) => runQueue.force(data.workspace, data.ticket),
    };
    const route = `queue-${action}` as const;
    return {
      route,
      call: (data) => {
        const parsed = BODIES[route].schema.safeParse(data);
        return parsed.success ? () => (calls[action] as (body: unknown) => Promise<unknown>)(parsed.data) : undefined;
      },
      refreshSetup: true,
    };
  }

  // A POST: the transport checks, then one call. A page that goes away while the call runs stops
  // waiting; the call itself goes on and settles here.
  async function handlePost(req: IncomingMessage, res: ServerResponse, post: Post, remote: boolean): Promise<void> {
    let gone = false;
    res.once('close', () => {
      gone = true;
    });
    const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}): void => {
      json(res, status, { ok: false, error: { code, message } }, headers);
    };
    // The page's exact origin: the local one on the local port, a listed one on the remote port.
    if (remote ? req.headers.origin === undefined || !remoteOrigins.includes(req.headers.origin) : req.headers.origin !== origin) {
      fail(403, 'invalid_origin', `Actions need the Origin ${remote ? remoteOrigins.join(' or ') : origin}.`);
      return;
    }
    // The updating marker's gate (SF-101), before anything is read or changed.
    if (!OPEN_WHILE_UPDATING.has(post.route)) {
      try {
        refuseWhileUpdating(stateDir);
      } catch (error) {
        const refusal = error as FactoryError;
        fail(ERROR_STATUS[refusal.code] ?? 409, refusal.code, refusal.message);
        return;
      }
    }
    if (post.bytes === true ? !isOctetStream(req.headers['content-type']) : !isJsonContentType(req.headers['content-type'])) {
      fail(415, 'unsupported_media_type', post.bytes === true ? 'An image upload needs Content-Type: application/octet-stream.' : 'Actions need Content-Type: application/json.');
      return;
    }
    if (post.exists !== undefined && !(await post.exists())) {
      empty(res, 404);
      return;
    }
    const limit = post.bodyLimit ?? MAX_ACTION_BODY_BYTES;
    const raw = await readBody(req, limit);
    if (raw === 'interrupted') {
      return;
    }
    if (raw === 'too_large') {
      if (post.bytes === true) {
        fail(413, 'attachment_too_large', `An image must be at most ${limit} bytes (5 MB).`, { connection: 'close' });
      } else {
        fail(413, 'body_too_large', `The body must be at most ${limit} bytes.`, { connection: 'close' });
      }
      return;
    }
    let data: unknown = raw;
    if (post.bytes !== true) {
      try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      } catch {
        fail(400, 'invalid_json', 'The body must be UTF-8 JSON.');
        return;
      }
    }
    const run = post.call(data);
    if (run === undefined) {
      fail(400, 'invalid_body', `${post.route} expects ${BODIES[post.route].shape}; no other keys, no null.`);
      return;
    }
    // The second confirmation from another device (SF-126): the job's ticket, typed by the user.
    if (remote && CONFIRM_ROUTES.includes(post.route) && (post.confirm === undefined || (data as { confirm?: unknown }).confirm !== post.confirm)) {
      fail(409, 'confirm_required', `From another device, ${post.route} needs "confirm": the job's ticket${post.confirm === undefined ? '' : ` (${post.confirm})`}.`);
      return;
    }
    let result: unknown;
    try {
      result = await run();
    } catch (error) {
      if (gone) {
        return;
      }
      if (error instanceof FactoryError) {
        fail(ERROR_STATUS[error.code] ?? 500, error.code, error.message);
        return;
      }
      console.error(error);
      fail(500, 'internal_error', 'The request failed inside the factory.');
      return;
    }
    if (post.refreshJob !== undefined) {
      const key = post.refreshJob;
      jobs.read(...key).then((job) => (job !== undefined ? refresh(job) : refreshAll())).catch((error: unknown) => console.error(error));
    } else if (post.refreshJobs === true) {
      refreshAll().catch((error: unknown) => console.error(error));
    } else if (post.refreshSetup === true) {
      sendSetup(streams).catch((error: unknown) => console.error(error));
    }
    if (gone) {
      return;
    }
    json(res, 200, { ok: true, result });
  }

  // One request on the local port or, with remote true, on the remote one (SF-126).
  const handle = (req: IncomingMessage, res: ServerResponse, remote: boolean): void => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    if (remote ? !remoteAllowed(req) : !validateHost(req, res) || !validateOrigin(req, res)) {
      if (remote) {
        empty(res, 403);
      }
      return;
    }
    const target = URL.parse(req.url ?? '/', 'http://localhost');
    if (target === null) {
      empty(res, 404);
      return;
    }
    const segments = target.pathname.split('/').slice(1);
    const [first, given, ...rest] = segments;
    const cookie = remote ? cookies.remote : cookies.local;
    let path: string[];
    // /d/<token>/...: the token segment must be followed by a slash, so path has at least one
    // entry. Without the token, the cookie of a token visit (SF-126) opens every path at the root.
    if (first === 'd' && given !== undefined && rest.length > 0 && sameToken(given, token)) {
      path = rest;
      if (path.length === 1 && path[0] === '' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.setHeader('set-cookie', `${cookie.name}=${cookie.value.toString('utf8')}; ${cookie.attributes}`);
      }
    } else if (hasCookie(req.headers.cookie, cookie.name, cookie.value)) {
      path = segments;
    } else {
      empty(res, 404);
      return;
    }
    const failed = (error: unknown): void => {
      console.error(error);
      if (res.destroyed) {
        return;
      }
      if (!res.headersSent) {
        empty(res, 500);
      } else {
        res.end();
      }
    };
    const what = targetOf(path);
    if (what.kind === 'action' || what.kind === 'workspace-remove' || what.kind === 'ticket-action' || what.kind === 'workspace-edit' || what.kind === 'digest-settings' || what.kind === 'digest-run') {
      if (req.method !== 'POST') {
        empty(res, 405, { allow: 'POST' });
        return;
      }
      let post: Post | undefined;
      if (what.kind === 'action') {
        const key = jobKey(what.workspace, what.ticket);
        post = key === undefined ? undefined : jobPost(what.action, key);
      } else {
        post = setupPost(what);
      }
      if (post === undefined) {
        empty(res, 404);
        return;
      }
      handlePost(req, res, post, remote).catch(failed);
      return;
    }
    if (what.kind === 'ticket-check') {
      const key = jobKey(what.workspace, what.ticket);
      if (req.method !== 'GET' && req.method !== 'POST') {
        empty(res, 405, { allow: 'GET, POST' });
        return;
      }
      const post = key === undefined || req.method === 'GET' ? undefined : checkPost(key);
      if (key === undefined || (req.method === 'POST' && post === undefined)) {
        empty(res, 404);
        return;
      }
      (post !== undefined ? handlePost(req, res, post, remote) : checkView(res, key)).catch(failed);
      return;
    }
    if (what.kind === 'ticket-task') {
      const key = jobKey(what.workspace, what.ticket);
      if (req.method !== 'GET' && req.method !== 'POST') {
        empty(res, 405, { allow: 'GET, POST' });
        return;
      }
      if (req.method === 'POST') {
        if (key === undefined) {
          empty(res, 404);
          return;
        }
        handlePost(req, res, taskPost(key), remote).catch(failed);
        return;
      }
      route(req, res, path, target.searchParams, remote).catch(failed);
      return;
    }
    if (what.kind === 'ticket-attachment-add' || what.kind === 'ticket-attachment-remove') {
      if (req.method !== 'POST') {
        empty(res, 405, { allow: 'POST' });
        return;
      }
      const key = jobKey(what.workspace, what.ticket);
      const query = target.searchParams;
      let post: Post | undefined;
      if (key !== undefined && what.kind === 'ticket-attachment-add' && [...query.keys()].every((name) => name === 'name') && query.getAll('name').length <= 1) {
        post = attachmentAddPost(key, query.get('name') ?? undefined);
      } else if (key !== undefined && what.kind === 'ticket-attachment-remove' && what.name !== undefined && [...query.keys()].length === 0) {
        post = attachmentRemovePost(key, what.name);
      }
      if (post === undefined) {
        empty(res, 404);
        return;
      }
      handlePost(req, res, post, remote).catch(failed);
      return;
    }
    if (what.kind === 'queue') {
      if (req.method !== 'POST') {
        empty(res, 405, { allow: 'POST' });
        return;
      }
      if (queue === undefined) {
        empty(res, 404);
        return;
      }
      handlePost(req, res, queuePost(what.action, queue), remote).catch(failed);
      return;
    }
    if (what.kind === 'both' && req.method === 'POST') {
      handlePost(req, res, setupPost(what)!, remote).catch(failed);
      return;
    }
    if (req.method !== 'GET') {
      empty(res, 405, { allow: what.kind === 'both' ? 'GET, POST' : 'GET' });
      return;
    }
    route(req, res, path, target.searchParams, remote).catch(failed);
  };

  // A listener on 127.0.0.1:at; a taken port is port_in_use naming the setting that chose it.
  const listen = (server: Server, at: number, setting: string): Promise<AddressInfo> => new Promise<AddressInfo>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(error.code === 'EADDRINUSE'
        ? new FactoryError('port_in_use', `Port ${at} on ${LOOPBACK_HOST} is already in use. Set ${setting} to a free port.`)
        : error);
    };
    server.once('error', onError);
    server.listen(at, LOOPBACK_HOST, () => {
      server.off('error', onError);
      resolve(server.address() as AddressInfo);
    });
  });
  // A listener closed, its open connections (event streams too) cut.
  const closeServer = (server: Server): Promise<void> => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  const httpServer = createServer((req, res) => handle(req, res, false));
  const address = await listen(httpServer, port, 'SF_DASHBOARD_PORT');
  cookies.local.name = `sf_dashboard_${address.port}`;
  const remoteServer = remoteOn ? createServer((req, res) => handle(req, res, true)) : undefined;
  let remoteAddress: AddressInfo | undefined;
  if (remoteServer !== undefined) {
    try {
      remoteAddress = await listen(remoteServer, remotePort, 'SF_DASHBOARD_REMOTE_PORT');
    } catch (error) {
      await closeServer(httpServer);
      throw error;
    }
  }
  origin = `http://${LOOPBACK_HOST}:${address.port}`;

  // A state change: every page gets the list, the setup data (a job that starts or ends changes
  // the tickets and the live counts) and, where it is selected, the job.
  const refresh = async (job: Job): Promise<void> => {
    if (streams.size === 0) {
      return;
    }
    const list = await jobsPayload(jobs, setup, actions, toolCalls);
    const selected = [...streams].filter((stream) => stream.job?.[0] === job.workspace && stream.job[1] === job.ticket);
    const detail = selected.length > 0 ? await jobDetail(jobs, job, gateOn, actions, setup) : undefined;
    for (const stream of streams) {
      send(stream, 'jobs', { ...list, remote: stream.remote });
      if (detail !== undefined && selected.includes(stream)) {
        send(stream, 'job', detail);
      }
    }
    await sendSetup(streams);
  };

  // A ticket action that may have archived or started a job: every page gets the jobs and the
  // setup data again (a page following an archived job sees it gone from the list).
  async function refreshAll(): Promise<void> {
    if (streams.size === 0) {
      return;
    }
    const list = await jobsPayload(jobs, setup, actions, toolCalls);
    for (const stream of streams) {
      send(stream, 'jobs', { ...list, remote: stream.remote });
    }
    await sendSetup(streams);
  }

  return {
    url: dashboardUrl(address.port, tokenText),
    remoteUrls: remoteDashboardUrls(remoteOrigins, tokenText),
    remotePort: remoteAddress?.port,
    onStateChange(job) {
      refresh(job).catch((error: unknown) => console.error(error));
    },
    refreshSetup() {
      sendSetup(streams).catch((error: unknown) => console.error(error));
    },
    refreshJob(workspace, ticket) {
      jobs.read(workspace, ticket).then((job) => (job !== undefined ? refresh(job) : refreshAll())).catch((error: unknown) => console.error(error));
    },
    async close() {
      for (const stream of streams) {
        stream.abort.abort();
        stream.res.end();
      }
      await Promise.all([httpServer, ...(remoteServer !== undefined ? [remoteServer] : [])].map(closeServer));
    },
  };
}
