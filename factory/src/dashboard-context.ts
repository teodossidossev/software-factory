// What the dashboard's modules share: DashboardContext, the one object startDashboard builds and
// hands to the change feed (src/dashboard-changes.ts), the reads (src/dashboard-reads.ts) and the
// posts (src/dashboard-posts.ts), and the helpers they and startDashboard use: the request's
// cookie, names and target, a POST's body and content type, the change feed's change, the GET
// route table's path match, and the view of a ticket's planner session that the reads and the
// posts answer. No state of its own: everything that lives as long as the dashboard is in the
// context.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Changes } from './changes.js';
import type { DashboardActions, DashboardChecks, DashboardDigests, DashboardHealth, DashboardPlanner, DashboardQueue, DashboardSetup } from './dashboard.js';
import type { jobsPayload, ToolCallCounter } from './dashboard-payloads.js';
import { type JobKey, type JobRoute, postRoute, type QueueRoute } from './dashboard-routes.js';
import { sameSecret } from './http.js';
import type { JobStore } from './jobs.js';
import type { PlannerSession } from './planner-session.js';
import { WORKSPACE_NAME_PATTERN } from './registry.js';
import type { Stats } from './stats.js';
import { TICKET_PATTERN } from './task-file.js';
import type { TicketHistory } from './ticket-history.js';

// The cookie of a token visit on one side: its name, value and Set-Cookie attributes.
export interface DashboardCookie {
  name: string;
  value: string;
  attributes: string;
}

// Everything the dashboard's modules share for as long as it runs, built once by startDashboard.
// The options: stateDir, gateOn (SF_GATE), remoteOrigins and onWorkspacesChanged; jobs, actions,
// setup, checks, queue, digests, health, planner and prototypes as startDashboard got them (the
// last six undefined without). tokenText and cookies: the token and the cookie of a token visit on each
// side (the local name set once the listener has its port). files: the page's static files and
// scripts by path. streams: the open event streams. toolCalls, changes, history and stats: the
// readers with their caches. send, empty, body and refuseRead: the answers every module writes. jobsOf: the
// jobs as api/jobs and the jobs events send them. origin: the exact origin of the page, set once
// the listener has its port and read at call time.
export interface DashboardContext {
  readonly stateDir: string;
  readonly gateOn: boolean;
  readonly remoteOrigins: readonly string[];
  readonly onWorkspacesChanged: (() => void) | undefined;
  readonly jobs: JobStore;
  readonly actions: DashboardActions;
  readonly setup: DashboardSetup;
  readonly checks: DashboardChecks | undefined;
  readonly queue: DashboardQueue | undefined;
  readonly digests: DashboardDigests | undefined;
  readonly health: DashboardHealth | undefined;
  readonly planner: DashboardPlanner | undefined;
  readonly prototypes: string | undefined;
  readonly tokenText: string;
  readonly cookies: { local: DashboardCookie; remote: DashboardCookie };
  readonly files: ReadonlyMap<string, { body: Buffer; type: string }>;
  readonly streams: Set<Stream>;
  readonly toolCalls: ToolCallCounter;
  readonly changes: Changes;
  readonly history: TicketHistory;
  readonly stats: Stats;
  readonly send: (stream: Stream, event: string, data: unknown) => void;
  readonly empty: (res: ServerResponse, status: number, headers?: Record<string, string>) => void;
  readonly body: (res: ServerResponse, type: string, data: string | Buffer) => void;
  readonly refuseRead: (res: ServerResponse, error: unknown) => void;
  readonly jobsOf: (remote: boolean) => Promise<Awaited<ReturnType<typeof jobsPayload>> & { remote: boolean }>;
  origin: string;
}

// The change feed as the posts use it (src/dashboard-changes.ts): changed marks a change for the
// next flush; jobChanged marks a job's change, reading whether the job is still there.
export interface ChangeFeed {
  openStream(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, remote: boolean): Promise<void>;
  changed(change: Change): void;
  jobChanged(key: TicketKey): Promise<void>;
}

// Whether the Cookie header holds the cookie name with the value, compared in constant time.
// Every entry is compared (no early return), so the answer's time does not tell which one matched.
export function hasCookie(header: string | undefined, name: string, value: string): boolean {
  let found = false;
  for (const part of (header ?? '').split(';')) {
    const equals = part.indexOf('=');
    if (equals > 0 && part.slice(0, equals).trim() === name && sameSecret(part.slice(equals + 1).trim(), value)) {
      found = true;
    }
  }
  return found;
}

// An iteration number of a query or a path: 1 to 9999, written without a leading zero.
export function iterationParam(value: string | null | undefined): number | undefined {
  return typeof value === 'string' && /^[1-9]\d{0,3}$/.test(value) ? Number(value) : undefined;
}

// "<ws>/<ticket>" as validated names, or undefined.
export function jobKey(workspace: string | undefined, ticket: string | undefined): [string, string] | undefined {
  if (workspace === undefined || ticket === undefined || !WORKSPACE_NAME_PATTERN.test(workspace) || !TICKET_PATTERN.test(ticket)) {
    return undefined;
  }
  return [workspace, ticket];
}

// A ticket's planner session as the planned ticket page shows it: its name in Claude Code, when
// it started and its claude.ai link once the session's hook recorded it (else null); null for
// none. No pid and no id: the page needs neither, and the hook's write is checked against the id.
export function plannerSessionView(session: PlannerSession | undefined): { name: string; started_at: string; link: string | null } | null {
  return session === undefined ? null : { name: session.name, started_at: session.started_at, link: session.link ?? null };
}

// What a path is for the method rule: a job action (POST only), a setup action (POST only), a
// path that lists on GET and acts on POST, or a read (GET only).
export type Target =
  // A job's action of POST_ROUTES, POST only.
  | { kind: 'action'; name: string; route: JobRoute; workspace: string | undefined; ticket: string | undefined }
  | { kind: 'workspace-remove'; name: string | undefined }
  // The Workspaces dialog's Edit and the Morning digest section, POST only.
  | { kind: 'workspace-edit'; name: string | undefined }
  | { kind: 'digest-settings' }
  // Generate now: POST api/digests/run.
  | { kind: 'digest-run' }
  | { kind: 'ticket-action'; action: 'archive' | 'restore' | 'delete' | 'start'; workspace: string | undefined; ticket: string | undefined }
  // Who plans the ticket: POST api/tickets/<ws>/<ticket>/owner, POST only.
  | { kind: 'ticket-owner'; workspace: string | undefined; ticket: string | undefined }
  // The ticket's planning chat link: POST api/tickets/<ws>/<ticket>/chat, POST only.
  | { kind: 'ticket-chat'; workspace: string | undefined; ticket: string | undefined }
  // The Task check: GET reads the ticket's last check, POST starts one.
  | { kind: 'ticket-check'; workspace: string | undefined; ticket: string | undefined }
  // The Task file: GET reads it, POST saves it.
  | { kind: 'ticket-task'; workspace: string | undefined; ticket: string | undefined }
  // A ticket's images: POST api/tickets/<ws>/<ticket>/attachments uploads one (name: the
  // name to give it, or undefined), POST .../attachments/<name>/remove removes one; GET
  // .../attachments/<name> is a read.
  | { kind: 'ticket-attachment-add'; workspace: string | undefined; ticket: string | undefined }
  | { kind: 'ticket-attachment-remove'; workspace: string | undefined; ticket: string | undefined; name: string | undefined }
  // GET lists, POST adds: api/workspaces, api/tickets and api/pins (the dashboard's pins).
  | { kind: 'both'; route: 'workspace-add' | 'ticket-new' | 'pin-add' }
  // The run queue: api/queue/<action>, POST only; name is its POST_ROUTES name.
  | { kind: 'queue'; name: string; route: QueueRoute }
  // A job from a merge request's review comments: api/workspaces/<ws>/merge-requests/<number>/job, POST only.
  | { kind: 'mr-job'; workspace: string | undefined; number: string | undefined }
  // An agent role's skills: PUT api/skills/roles/<role>, PUT only.
  | { kind: 'skill-roles'; role: string }
  // One of the dashboard's pins: POST api/pins/<id> changes it and POST api/pins/<id>/remove
  // removes it (id as the path has it, checked by the post), POST only.
  | { kind: 'pin'; id: string; remove: boolean }
  // The ticket's planner session: GET api/tickets/<ws>/<ticket>/planner reads it, POST starts it;
  // POST .../planner/stop (stop) ends it, POST only.
  | { kind: 'ticket-planner'; workspace: string | undefined; ticket: string | undefined; stop: boolean }
  // A request for the coordinator's status (a click on Zen's screen): POST
  // api/coordinator/request, POST only.
  | { kind: 'coordinator-request' }
  | { kind: 'read' };

export function targetOf(path: string[]): Target {
  const [api, kind, a, b, c] = path;
  if (api !== 'api') {
    return { kind: 'read' };
  }
  const action = kind === 'jobs' && path.length === 5 && c !== undefined ? postRoute(c, 'job') : undefined;
  if (action !== undefined && c !== undefined) {
    return { kind: 'action', name: c, route: action, workspace: a, ticket: b };
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
  if (kind === 'workspaces' && path.length === 6 && b === 'merge-requests' && path[5] === 'job') {
    return { kind: 'mr-job', workspace: a, number: c };
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
  if (kind === 'tickets' && path.length === 5 && c === 'owner') {
    return { kind: 'ticket-owner', workspace: a, ticket: b };
  }
  if (kind === 'tickets' && path.length === 5 && c === 'chat') {
    return { kind: 'ticket-chat', workspace: a, ticket: b };
  }
  if (kind === 'tickets' && path.length === 5 && c === 'check') {
    return { kind: 'ticket-check', workspace: a, ticket: b };
  }
  if (kind === 'tickets' && path.length === 5 && c === 'task') {
    return { kind: 'ticket-task', workspace: a, ticket: b };
  }
  if (kind === 'tickets' && c === 'planner' && (path.length === 5 || (path.length === 6 && path[5] === 'stop'))) {
    return { kind: 'ticket-planner', workspace: a, ticket: b, stop: path.length === 6 };
  }
  if (kind === 'tickets' && path.length === 5 && c === 'attachments') {
    return { kind: 'ticket-attachment-add', workspace: a, ticket: b };
  }
  if (kind === 'tickets' && path.length === 7 && c === 'attachments' && path[6] === 'remove') {
    return { kind: 'ticket-attachment-remove', workspace: a, ticket: b, name: path[5] };
  }
  if (kind === 'skills' && path.length === 4 && a === 'roles' && b !== undefined) {
    return { kind: 'skill-roles', role: b };
  }
  if (kind === 'coordinator' && path.length === 3 && a === 'request') {
    return { kind: 'coordinator-request' };
  }
  if (kind === 'pins' && path.length === 2) {
    return { kind: 'both', route: 'pin-add' };
  }
  if (kind === 'pins' && a !== undefined && (path.length === 3 || (path.length === 4 && b === 'remove'))) {
    return { kind: 'pin', id: a, remove: path.length === 4 };
  }
  const change = kind === 'queue' && path.length === 3 ? postRoute(`queue-${a}`, 'queue') : undefined;
  if (change !== undefined) {
    return { kind: 'queue', name: `queue-${a}`, route: change };
  }
  return { kind: 'read' };
}

// application/json, optionally with a UTF-8 charset parameter; nothing else.
export function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) {
    return false;
  }
  const [type, ...params] = header.split(';').map((part) => part.trim().toLowerCase());
  return type === 'application/json' && params.every((param) => param === '' || /^charset="?utf-?8"?$/.test(param));
}

// application/octet-stream, without parameters: the raw bytes of an image upload.
export function isOctetStream(header: string | undefined): boolean {
  return header !== undefined && header.trim().toLowerCase() === 'application/octet-stream';
}

// The whole body up to limit bytes, counted while streaming and against Content-Length first.
// 'interrupted' when the connection ends before the body does: nothing is answered then.
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer | 'too_large' | 'interrupted'> {
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

// A ticket or a job, by its workspace and ticket.
export type TicketKey = JobKey;

// A change the open pages are told of (changed): the kinds it touches; tickets names the tickets
// it touches, or 'all'.
export interface Change {
  jobs?: true;
  workspaces?: true;
  tickets?: 'all' | TicketKey[];
  job?: TicketKey;
}

// The changes of one flush merged: the keys by "<ws>/<ticket>", so each is sent once.
export interface Marked {
  jobs: boolean;
  workspaces: boolean;
  tickets: 'all' | Map<string, TicketKey> | undefined;
  job: Map<string, TicketKey>;
}

const keyText = ([workspace, ticket]: TicketKey): string => `${workspace}/${ticket}`;

// The kinds of both, the keys unioned; 'all' wins over keys.
export function mergeChange(marked: Marked | undefined, change: Change): Marked {
  const into: Marked = marked ?? { jobs: false, workspaces: false, tickets: undefined, job: new Map() };
  into.jobs ||= change.jobs === true;
  into.workspaces ||= change.workspaces === true;
  if (change.tickets === 'all') {
    into.tickets = 'all';
  } else if (change.tickets !== undefined && into.tickets !== 'all') {
    into.tickets ??= new Map();
    for (const key of change.tickets) {
      into.tickets.set(keyText(key), key);
    }
  }
  if (change.job !== undefined) {
    into.job.set(keyText(change.job), change.job);
  }
  return into;
}

// The segments a pattern's "*" stand for when the path matches it, else undefined.
export function matchPath(pattern: string, path: string[]): string[] | undefined {
  const parts = pattern.split('/');
  if (parts.length !== path.length) {
    return undefined;
  }
  const params: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (part === '*') {
      params.push(path[index]!);
    } else if (part !== path[index]) {
      return undefined;
    }
  }
  return params;
}

export const noQuery = (query: URLSearchParams): boolean => [...query.keys()].length === 0;

export interface Stream {
  res: ServerResponse;
  job: [string, string] | undefined;
  abort: AbortController;
  // Opened on the remote port: its jobs events say remote: true.
  remote: boolean;
}

// One POST, validated and dispatched: the body shape, the one call it stands for, and whether
// the page refreshes its setup data after it.
export interface Post {
  // The route's name, and the body as invalid_body names it.
  route: string;
  shape: string;
  // Answers while sf update drains or builds; false by default.
  openWhileUpdating?: boolean;
  // A check before the body is read; false answers an empty 404.
  exists?: () => Promise<boolean>;
  // The job's ticket, which "confirm" must equal on the remote port (the confirm routes of
  // POST_ROUTES).
  confirm?: string;
  call: (data: unknown) => (() => Promise<unknown>) | undefined;
  // The raw body's bound in bytes; MAX_ACTION_BODY_BYTES by default.
  bodyLimit?: number;
  // The body is the raw bytes of an image, not JSON: Content-Type
  // application/octet-stream, call gets the Buffer, and a body over the bound is
  // attachment_too_large.
  bytes?: boolean;
  refreshSetup?: boolean;
  // The action may end a job too (archive, delete): every page gets the jobs again.
  refreshJobs?: boolean;
  // The action may change the job's record without a state change (mr-status): every page
  // gets the jobs again, and the pages that show the job its detail, as on a state change.
  refreshJob?: JobKey;
}
