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
// whose Task file is written (SF-040); the board (SF-046) adds the text of a Task file.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { conversationUrl, MAX_CONVERSATION_URL, ticketConversation } from './conversation.js';
import { FactoryError } from './errors.js';
import type { Execution } from './execution.js';
import type { Job, JobState, JobStore } from './jobs.js';
import { DECISIONS } from './ledger.js';
import { WORKSPACE_NAME_PATTERN } from './registry.js';
import type { Setup } from './setup.js';
import { TICKET_PATTERN } from './task-file.js';
import { describeEvent, followLines } from './watch.js';

export const DEFAULT_DASHBOARD_PORT = 8788;
export const TOKEN_FILE = 'dashboard-token';
export const MAX_STREAMS = 8;
// The raw body of an action request, in bytes: a transport bound, not a lifecycle rule.
export const MAX_ACTION_BODY_BYTES = 128 * 1024;
const LOOPBACK_HOST = '127.0.0.1';
const KEEP_ALIVE_MS = 15_000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
// Compiled to dist/src/dashboard.js; the package root is two levels up.
const STATIC_DIR = new URL('../../static/', import.meta.url);
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'",
  'referrer-policy': 'no-referrer',
};
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '': { file: 'dashboard.html', type: 'text/html; charset=utf-8' },
  'app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  'app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

// The User's actions, bound by `sf serve` to its one Execution: the same methods, guards and
// results as the socket commands of sf start, sf approve, sf abort, sf say and sf review. A job is
// started from its ticket on the start screen once the Task file is written (SF-040), or with
// sf start. Archive of a job card is archiveFinished (terminal only), never the any-state reset.
// The merge request on the Git host (SF-048): mr-create, mr-merge and mr-status as sf mr create,
// merge and status, and mergeRequestHost for whether they are on for a job's workspace.
export type DashboardActions = Pick<Execution, 'start' | 'approve' | 'abort' | 'say' | 'retryReview' | 'acceptGate' | 'settle' | 'archiveFinished'
  | 'createMergeRequest' | 'mergeMergeRequest' | 'mergeRequestStatus' | 'mergeRequestHost'>;
export type DashboardAction = 'approve' | 'abort' | 'say' | 'review' | 'accept' | 'settle' | 'archive' | 'mr-create' | 'mr-merge' | 'mr-status';
export const ACTIONS: DashboardAction[] = ['approve', 'abort', 'say', 'review', 'accept', 'settle', 'archive', 'mr-create', 'mr-merge', 'mr-status'];

// The start screen's data and changes: the workspace registry and the Task files (src/setup.ts).
export type DashboardSetup = Pick<Setup, 'workspaces' | 'addWorkspace' | 'removeWorkspace' | 'tickets' | 'createTicket' | 'archiveTicket' | 'restoreTicket' | 'deleteTicket' | 'archivedTickets' | 'taskText' | 'taskTitle'>;

// A dashboard without a start screen (in-process tests of the older endpoints).
const NO_SETUP: DashboardSetup = {
  workspaces: async () => [],
  tickets: async () => [],
  archivedTickets: async () => [],
  taskTitle: async () => null,
  taskText: async () => {
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
  createTicket: async () => {
    throw new FactoryError('setup_unavailable', 'The start screen is not available.');
  },
};

// The request body of each POST route, strict: unknown keys, null, arrays and wrong types are
// refused; shape is what the refusal names.
const BODIES = {
  approve: { shape: '{"as_is"?: boolean}', schema: z.strictObject({ as_is: z.boolean().optional() }) },
  abort: { shape: '{"discard"?: boolean}', schema: z.strictObject({ discard: z.boolean().optional() }) },
  say: { shape: '{"message": string}', schema: z.strictObject({ message: z.string() }) },
  review: { shape: '{}', schema: z.strictObject({}) },
  accept: { shape: '{}', schema: z.strictObject({}) },
  settle: { shape: '{"id": string, "decision": "accept" | "fix", "note"?: string}', schema: z.strictObject({ id: z.string(), decision: z.enum(DECISIONS), note: z.string().optional() }) },
  archive: { shape: '{}', schema: z.strictObject({}) },
  'mr-create': { shape: '{}', schema: z.strictObject({}) },
  'mr-merge': { shape: '{}', schema: z.strictObject({}) },
  'mr-status': { shape: '{}', schema: z.strictObject({}) },
  'workspace-add': { shape: '{"name": string, "path": string}', schema: z.strictObject({ name: z.string(), path: z.string() }) },
  'workspace-remove': { shape: '{}', schema: z.strictObject({}) },
  'ticket-archive': { shape: '{}', schema: z.strictObject({}) },
  'ticket-restore': { shape: '{}', schema: z.strictObject({}) },
  'ticket-delete': { shape: '{}', schema: z.strictObject({}) },
  'ticket-start': { shape: '{}', schema: z.strictObject({}) },
  'ticket-new': { shape: '{"workspace": string, "ticket": string, "title": string, "request": string}', schema: z.strictObject({ workspace: z.string(), ticket: z.string(), title: z.string(), request: z.string() }) },
};
type PostRoute = keyof typeof BODIES;

// The HTTP status of a FactoryError the methods can throw; any other code answers 500 and keeps
// its code and message.
const ERROR_STATUS: Record<string, number> = {
  invalid_state: 409, turn_running: 409, rebase_in_progress: 409, review_off: 409, runner_active: 409,
  job_exists: 409, job_active: 409, job_limit: 409, task_draft: 409, checkout_dirty: 409, branch_exists: 409, branch_changed: 409, branch_missing: 409, worktree_exists: 409,
  worktree_missing: 409, sensitive_unacknowledged: 409, ticket_exists: 409, workspace_exists: 409, workspace_busy: 409,
  job_not_found: 404, workspace_not_found: 404, task_not_found: 404,
  invalid_content: 400, invalid_ticket: 400, invalid_name: 400, workspace_invalid: 400,
  // The merge request (SF-048): the host's refusals and the actions being off are conflicts; a host
  // that failed or refused the token is a bad gateway.
  mr_not_mergeable: 409, mr_not_open: 409, mr_token_missing: 409, mr_host_unsupported: 409, mr_host_changed: 409, mr_text_missing: 409,
  mr_auth_failed: 502, mr_host_error: 502, mr_host_unreachable: 502,
};

export interface RunningDashboard {
  url: URL;
  // The state listener: refreshes every open page; never throws.
  onStateChange(job: Job, from: JobState | null): void;
  close(): Promise<void>;
}

export function dashboardUrl(port: number, token: string): URL {
  return new URL(`http://${LOOPBACK_HOST}:${port}/d/${token}/`);
}

// The dashboard token, or undefined when the file is missing; kept across `sf serve` starts.
export async function readToken(stateDir: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(stateDir, TOKEN_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const token = text.trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new FactoryError('invalid_token', `${TOKEN_FILE} does not hold a dashboard token.`);
  }
  return token;
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

// mr: the merge request on the Git host (SF-048), null before one is opened; mr_host: whether the
// merge request actions are on for the job's workspace.
function jobSummary(job: Job, counts: { files: number; undeclared: number; deleted: number }, mrHost: MrHost) {
  return {
    workspace: job.workspace, ticket: job.ticket, branch: job.branch, base: job.base, state: job.state,
    iteration: job.iteration, mr_attempts: job.mr_attempts, updated_at: job.updated_at, created_at: job.created_at,
    error: job.error ?? null, worktree: job.worktree, prepared_commit: job.prepared_commit,
    fixes: job.fixes, gate_fixes: job.gate_fixes, gate_tokens: job.gate_tokens, ...counts,
    mr: job.mr, mr_host: mrHost,
  };
}

async function jobsPayload(jobs: JobStore, setup: DashboardSetup, actions: DashboardActions) {
  const list = [];
  const hosts = new Map<string, MrHost>();
  for (const job of await jobs.list()) {
    if (!hosts.has(job.workspace)) {
      hosts.set(job.workspace, await mrHostOf(actions, job.workspace));
    }
    list.push({
      ...jobSummary(job, await fileCounts(jobs, job), hosts.get(job.workspace)!),
      title: await setup.taskTitle(job.workspace, job.ticket), ...(await boardFacts(jobs, job)),
    });
  }
  return { jobs: list };
}

async function workspacesPayload(setup: DashboardSetup) {
  return { workspaces: await setup.workspaces() };
}

// The tickets without a live job, each with the ChatGPT conversation that plans it: the message
// and the prefilled URL.
async function ticketsPayload(setup: DashboardSetup) {
  return {
    tickets: (await setup.tickets()).map((row) => {
      const message = ticketConversation(row.workspace, row.ticket, row.request ?? undefined);
      const url = conversationUrl(message);
      // A very long message does not fit a link; the page offers it to copy instead.
      return { ...row, conversation: { message, url: url.length <= MAX_CONVERSATION_URL ? url : null } };
    }),
    archived: await setup.archivedTickets(),
  };
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

async function jobDetail(jobs: JobStore, job: Job, gate: boolean, actions: DashboardActions) {
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
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  const mrText = await jobs.readMrText(job.workspace, job.ticket);
  return {
    job: jobSummary(job, await fileCounts(jobs, job), await mrHostOf(actions, job.workspace)),
    iterations,
    mr: mrText !== undefined,
    // The merge request's title on the Git host: the MR text's first line (SF-048).
    mr_title: mrText === undefined ? null : (mrText.split(/\r?\n/)[0] ?? ''),
    // Whether the Codex gate is on (SF_GATE): the pipeline shows its step as off otherwise.
    gate,
    // The findings ledger (SF-052): ledger.json as written; [] before the first Fix section.
    ledger: await jobs.readLedger(job.workspace, job.ticket),
    history: await stateHistory(jobs, job.workspace, job.ticket),
  };
}

function sameToken(given: string, token: Buffer): boolean {
  const candidate = Buffer.from(given, 'utf8');
  return candidate.length === token.length && timingSafeEqual(candidate, token);
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
  | { kind: 'ticket-action'; action: 'archive' | 'restore' | 'delete' | 'start'; workspace: string | undefined; ticket: string | undefined }
  | { kind: 'both'; route: 'workspace-add' | 'ticket-new' }
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
  if (kind === 'tickets' && path.length === 2) {
    return { kind: 'both', route: 'ticket-new' };
  }
  if (kind === 'tickets' && path.length === 5 && (c === 'archive' || c === 'restore' || c === 'delete' || c === 'start')) {
    return { kind: 'ticket-action', action: c, workspace: a, ticket: b };
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
}

// One POST, validated and dispatched: the body shape, the one call it stands for, and whether
// the page refreshes its setup data after it.
interface Post {
  route: PostRoute;
  // A check before the body is read; false answers an empty 404.
  exists?: () => Promise<boolean>;
  call: (data: unknown) => (() => Promise<unknown>) | undefined;
  refreshSetup?: boolean;
  // The action may end a job too (archive, delete): every page gets the jobs again.
  refreshJobs?: boolean;
  // The action may change the job's record without a state change (mr-status, SF-048): every page
  // gets the jobs again, and the pages that show the job its detail, as on a state change.
  refreshJob?: [string, string];
}

// gate: whether the Codex gate is on (SF_GATE), shown in the job's pipeline.
export async function startDashboard(
  port: number, stateDir: string, jobs: JobStore, actions: DashboardActions, setup: DashboardSetup = NO_SETUP, { gate: gateOn = true }: { gate?: boolean } = {},
): Promise<RunningDashboard> {
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const [path, { file, type }] of Object.entries(STATIC_FILES)) {
    files.set(path, { body: await readFile(new URL(file, STATIC_DIR)), type });
  }
  // The token persists across starts, so a bookmark keeps working; a missing or unusable file
  // gets a new one (sf dashboard --rotate removes the file on purpose).
  let tokenText = await readToken(stateDir).catch(() => undefined);
  if (tokenText === undefined) {
    tokenText = randomBytes(32).toString('hex');
    await writeFileAtomic(join(stateDir, TOKEN_FILE), Buffer.from(`${tokenText}\n`));
  }
  const token = Buffer.from(tokenText, 'utf8');

  const streams = new Set<Stream>();
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
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
    const tickets = await ticketsPayload(setup);
    for (const stream of targets) {
      send(stream, 'workspaces', workspaces);
      send(stream, 'tickets', tickets);
    }
  }

  async function openStream(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
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
    const stream: Stream = { res, job: key, abort: new AbortController() };
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
    send(stream, 'jobs', await jobsPayload(jobs, setup, actions));
    await sendSetup([stream]);
    if (key === undefined) {
      return;
    }
    const job = await jobs.read(...key);
    if (job !== undefined) {
      send(stream, 'job', await jobDetail(jobs, job, gateOn, actions));
    }
    const start = Number(from);
    try {
      await followLines(jobs.eventsPath(...key), true, (raw, line) => {
        const event = line >= start ? describeEvent(raw) : undefined;
        if (event !== undefined && event.lines.length > 0) {
          send(stream, 'event', { line, ts: event.ts, iteration: event.iteration, type: event.type, text: event.lines.join('\n') });
        }
      }, stream.abort.signal);
    } catch (error) {
      // A job without events.jsonl yet has nothing to follow; the stream stays open for state changes.
      if (!(error instanceof FactoryError)) {
        throw error;
      }
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string[], query: URLSearchParams): Promise<void> {
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
      body(res, 'application/json; charset=utf-8', JSON.stringify(await jobsPayload(jobs, setup, actions)));
      return;
    }
    if (joined === 'api/workspaces') {
      body(res, 'application/json; charset=utf-8', JSON.stringify(await workspacesPayload(setup)));
      return;
    }
    if (joined === 'api/tickets') {
      body(res, 'application/json; charset=utf-8', JSON.stringify(await ticketsPayload(setup)));
      return;
    }
    if (joined === 'api/stream') {
      await openStream(req, res, query);
      return;
    }
    const [, kind, ...rest] = path;
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
      body(res, 'application/json; charset=utf-8', JSON.stringify(await jobDetail(jobs, job, gateOn, actions)));
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
    const number = Number(tail[1]);
    if (tail.length === 3 && tail[0] === 'iterations' && /^[1-9]\d{0,3}$/.test(tail[1] ?? '') && number <= job.iteration
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
      if (!(error instanceof FactoryError)) {
        throw error;
      }
      const status = ERROR_STATUS[error.code] ?? 500;
      if (status === 404) {
        empty(res, 404);
      } else {
        json(res, status, { ok: false, error: { code: error.code, message: error.message } });
      }
      return;
    }
    body(res, 'text/markdown; charset=utf-8', text);
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
        route: action, exists,
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
    if (action === 'accept') {
      // sf accept: the Execution refuses any state but needs_human after the gate stopped, with a
      // clean Claude review of the last iteration.
      const run = (): Promise<unknown> => actions.acceptGate(workspace, ticket);
      return { route: action, exists, call: (data) => (parse(BODIES.accept.schema, data) ? run : undefined) };
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
        ...(action === 'mr-status' ? { refreshJob: [workspace, ticket] as [string, string] } : {}),
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

  function setupPost(target: Exclude<Target, { kind: 'read' | 'action' }>): Post | undefined {
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
      return { route: 'workspace-remove', call: (data) => (BODIES['workspace-remove'].schema.safeParse(data).success ? () => setup.removeWorkspace(name) : undefined), refreshSetup: true };
    }
    if (target.route === 'workspace-add') {
      return {
        route: 'workspace-add',
        call: (data) => {
          const parsed = BODIES['workspace-add'].schema.safeParse(data);
          return parsed.success ? () => setup.addWorkspace(parsed.data.name, parsed.data.path) : undefined;
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

  // A POST: the transport checks, then one call. A page that goes away while the call runs stops
  // waiting; the call itself goes on and settles here.
  async function handlePost(req: IncomingMessage, res: ServerResponse, post: Post): Promise<void> {
    let gone = false;
    res.once('close', () => {
      gone = true;
    });
    const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}): void => {
      json(res, status, { ok: false, error: { code, message } }, headers);
    };
    if (req.headers.origin !== origin) {
      fail(403, 'invalid_origin', `Actions need the Origin ${origin}.`);
      return;
    }
    if (!isJsonContentType(req.headers['content-type'])) {
      fail(415, 'unsupported_media_type', 'Actions need Content-Type: application/json.');
      return;
    }
    if (post.exists !== undefined && !(await post.exists())) {
      empty(res, 404);
      return;
    }
    const raw = await readBody(req, MAX_ACTION_BODY_BYTES);
    if (raw === 'interrupted') {
      return;
    }
    if (raw === 'too_large') {
      fail(413, 'body_too_large', `The body must be at most ${MAX_ACTION_BODY_BYTES} bytes.`, { connection: 'close' });
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      fail(400, 'invalid_json', 'The body must be UTF-8 JSON.');
      return;
    }
    const run = post.call(data);
    if (run === undefined) {
      fail(400, 'invalid_body', `${post.route} expects ${BODIES[post.route].shape}; no other keys, no null.`);
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

  const httpServer = createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) {
      return;
    }
    const target = URL.parse(req.url ?? '/', 'http://localhost');
    const [first, given, ...path] = (target?.pathname ?? '').split('/').slice(1);
    // /d/<token>/...: the token segment must be followed by a slash, so path has at least one entry.
    if (target === null || first !== 'd' || given === undefined || path.length === 0 || !sameToken(given, token)) {
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
    if (what.kind === 'action' || what.kind === 'workspace-remove' || what.kind === 'ticket-action') {
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
      handlePost(req, res, post).catch(failed);
      return;
    }
    if (what.kind === 'both' && req.method === 'POST') {
      handlePost(req, res, setupPost(what)!).catch(failed);
      return;
    }
    if (req.method !== 'GET') {
      empty(res, 405, { allow: what.kind === 'both' ? 'GET, POST' : 'GET' });
      return;
    }
    route(req, res, path, target.searchParams).catch(failed);
  });

  const address = await new Promise<AddressInfo>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(error.code === 'EADDRINUSE'
        ? new FactoryError('port_in_use', `Port ${port} on ${LOOPBACK_HOST} is already in use. Set SF_DASHBOARD_PORT to a free port.`)
        : error);
    };
    httpServer.once('error', onError);
    httpServer.listen(port, LOOPBACK_HOST, () => {
      httpServer.off('error', onError);
      resolve(httpServer.address() as AddressInfo);
    });
  });
  origin = `http://${LOOPBACK_HOST}:${address.port}`;

  // A state change: every page gets the list, the setup data (a job that starts or ends changes
  // the tickets and the live counts) and, where it is selected, the job.
  const refresh = async (job: Job): Promise<void> => {
    if (streams.size === 0) {
      return;
    }
    const list = await jobsPayload(jobs, setup, actions);
    const selected = [...streams].filter((stream) => stream.job?.[0] === job.workspace && stream.job[1] === job.ticket);
    const detail = selected.length > 0 ? await jobDetail(jobs, job, gateOn, actions) : undefined;
    for (const stream of streams) {
      send(stream, 'jobs', list);
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
    const list = await jobsPayload(jobs, setup, actions);
    for (const stream of streams) {
      send(stream, 'jobs', list);
    }
    await sendSetup(streams);
  }

  return {
    url: dashboardUrl(address.port, tokenText),
    onStateChange(job) {
      refresh(job).catch((error: unknown) => console.error(error));
    },
    async close() {
      for (const stream of streams) {
        stream.abort.abort();
        stream.res.end();
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
        httpServer.closeAllConnections();
      });
    },
  };
}
