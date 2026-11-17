// The Dashboard: a second loopback HTTP listener with the static page, JSON endpoints, one
// server-sent event stream per open page and the User's actions as POST endpoints (approve, abort,
// say, the retry of a failed review, the override of a stopped gate, the merge request on the Git
// host and the other routes of src/dashboard-routes.ts). Every path starts with /d/<token>/, or
// goes with the cookie of a token visit; anything else is an empty 404, but for GET and HEAD of
// /point on the local listener: the factory window, static/point.html, which saves the pins of the
// page that opened it (web/point.ts) and holds no data, served without the token or the cookie.
// Reads JobStore and events.jsonl; job state changes arrive through onStateChange, which
// `sf serve` composes with the notifier. The actions validate the HTTP request and delegate once
// to the Execution of `sf serve` (DashboardActions); nothing here changes a job by itself. The
// start screen adds the workspaces and the tickets (DashboardSetup: the registry and the Task
// files), the ChatGPT conversation that plans a ticket, and the User's start of a ticket whose Task
// file is written; the board adds the text of a Task file; the Task check adds each ticket's last
// check, its start (Check) and its view. The board adds to each job row what its card shows: who
// acts now, the Implementer's tool calls and the findings a stopped job waits on. The Changes
// screen reads the file lists and the file versions of the iterations (src/changes.ts), read-only.
// The planned ticket page reads a ticket's Task file, its plan in plain words, its check, its
// history and its planner session in one payload, and saves the Task file (only over the version
// it read); the planner session is read, started and ended through DashboardPlanner. A ticket's
// images are uploaded as raw bytes, served and removed through the attachments module's rules
// (src/attachments.ts). The pins of the page's point mode are read and written through the pins
// store (src/pins.ts), the same as sf pins.
// This module keeps the listeners (ports, origins, logins, token and cookies, the request's
// method and target rule in handle) and builds one DashboardContext (src/dashboard-context.ts)
// for the rest: the payloads (src/dashboard-payloads.ts), the change feed
// (src/dashboard-changes.ts), the GET route table (src/dashboard-reads.ts) and the posts
// (src/dashboard-posts.ts). Only this module imports those three.
import { createHmac, randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { hostHeaderValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { writeFileAtomic } from './atomic.js';
import { Changes } from './changes.js';
import { changeFeed } from './dashboard-changes.js';
import { type DashboardContext, hasCookie, jobKey, matchPath, type Post, type Stream, type TicketKey, targetOf } from './dashboard-context.js';
import { jobsPayload, ToolCallCounter } from './dashboard-payloads.js';
import { postHandlers } from './dashboard-posts.js';
import { readHandlers } from './dashboard-reads.js';
import { FactoryError } from './errors.js';
import type { Digests } from './digest-run.js';
import type { Execution } from './execution.js';
import type { HealthMonitor } from './health.js';
import type { RunQueue } from './queue.js';
import { listen, LOOPBACK_HOST, sameSecret, sendJson, statusOf } from './http.js';
import type { Job, JobState, JobStore } from './jobs.js';
import type { PlannerSession } from './planner-session.js';
import { DIGEST_DEFAULTS } from './registry.js';
import { DASHBOARD_TOKEN_FILE as TOKEN_FILE, readTokenFile } from './secrets.js';
import type { Setup } from './setup.js';
import type { TaskChecks } from './task-check.js';
import { TicketHistory } from './ticket-history.js';
import { Stats } from './stats.js';

// The dashboard token's file: src/secrets.ts's.
export { DASHBOARD_TOKEN_FILE as TOKEN_FILE } from './secrets.js';
// The payloads, the change feed's stream bound and the bodies' and the Stream page's bounds, where
// their modules keep them.
export { jobDetail, jobsPayload, NOW_TAIL_BYTES, planOf, ticketEntry, ticketsPayload, ToolCallCounter, workspacesPayload } from './dashboard-payloads.js';
export { MAX_STREAMS } from './dashboard-changes.js';
export { MAX_ACTION_BODY_BYTES, MAX_TASK_BODY_BYTES } from './dashboard-posts.js';
export { STREAM_PAGE_LINES } from './dashboard-reads.js';
export { plannerSessionView } from './dashboard-context.js';

export const DEFAULT_DASHBOARD_PORT = 8788;
// The remote listener's port, where `tailscale serve --bg 8789` points.
export const DEFAULT_DASHBOARD_REMOTE_PORT = 8789;
// The Host names of the local listener, and the loopback Hosts the remote one takes with a listed Origin.
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
// Compiled to dist/src/dashboard.js; the package root is two levels up. The page's HTML and CSS,
// and the factory window's HTML, are in static/, and nothing else; their scripts are written in
// TypeScript in web/ and built into dist/web/.
const PACKAGE_DIR = new URL('../../', import.meta.url);
const STATIC_DIR = new URL('static/', PACKAGE_DIR);
const WEB_SOURCE_DIR = new URL('web/', PACKAGE_DIR);
const WEB_BUILD_DIR = new URL('dist/web/', PACKAGE_DIR);
// Set on every answer. frame-ancestors 'none' and X-Frame-Options (for browsers that read only that
// header) keep any page, of this machine or another, from showing the dashboard in a frame.
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};
// The dashboard's script: classic scripts that share the page's globals, in load order.
// dashboard.html has one deferred <script> per entry, in this order; nothing at the top level of a
// file uses a name defined in a later one.
export const DASHBOARD_SCRIPTS = ['core.js', 'job-screens.js', 'job-page.js', 'composer.js', 'header.js', 'board.js', 'coordinator.js', 'routing.js', 'home.js', 'ticket-page.js', 'planner.js', 'reports.js', 'mr-row.js', 'review-page.js', 'digest-brief.js', 'setup.js', 'skills.js', 'health.js', 'pins.js', 'main.js'] as const;
export type DashboardScript = (typeof DASHBOARD_SCRIPTS)[number];
// The files of each entry of DASHBOARD_SCRIPTS, in load order: url, the file
// served, is the build output dist/web/<name>.js; source, the file written by hand, is
// web/<name>.ts. The dashboard reads url once at start, and the tests read the same files through
// this function.
export function dashboardScriptFiles(): Array<{ file: DashboardScript; url: URL; source: URL }> {
  return scriptFiles(DASHBOARD_SCRIPTS);
}
function scriptFiles<T extends string>(names: readonly T[]): Array<{ file: T; url: URL; source: URL }> {
  return names.map((file) => ({ file, url: new URL(file, WEB_BUILD_DIR), source: new URL(file.replace(/\.js$/, '.ts'), WEB_SOURCE_DIR) }));
}
// The scripts of the pages beside the dashboard (point.js: the factory window of /point): built
// from web/ into dist/web/ and served like the dashboard's own (with the token or the cookie),
// never loaded by dashboard.html. Each page loads its one script alone.
export const POINT_SCRIPTS = ['point.js'] as const;
export type PointScript = (typeof POINT_SCRIPTS)[number];
// The files of each entry of POINT_SCRIPTS, as dashboardScriptFiles gives the dashboard's.
export function pointScriptFiles(): Array<{ file: PointScript; url: URL; source: URL }> {
  return scriptFiles(POINT_SCRIPTS);
}
// The factory window's page, in static/: served at /point without the token or the cookie.
const POINT_PAGE = 'point.html';
// The page's other files, all in static/.
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '': { file: 'dashboard.html', type: 'text/html; charset=utf-8' },
  'app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  'favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml; charset=utf-8' },
};

// The User's actions, bound by `sf serve` to its one Execution: the same methods, guards and
// results as the socket commands of sf start, sf approve, sf abort, sf say, sf review and sf retry
// (retryMr: the Retry of a transient MR preparation failure). A job is started from its ticket on
// the start screen once the Task file is written, or with sf start. Archive of a job card is
// archiveFinished (terminal only), never the any-state reset.
// The merge request on the Git host: mr-create, mr-merge and mr-status as sf mr create,
// merge and status, and mergeRequestHost for whether they are on for a job's workspace; the reads
// openMergeRequests, mergeRequestThreads and mergeRequestOverview (GET, src/dashboard-routes.ts).
// Pause, Resume and Restart as sf pause, resume and restart.
// The hand-over to the user's checkout: handover, takeback, handedDone and markMerged (Merged —
// archive) as sf handover, takeback, handed-done and handed-done --merged, and checkHandedOver, the check for the
// user's own push that the job's detail starts. The Merge request screen: mergeRequestView (GET
// mr-view), saveMr and resetMr (POST mr-save and mr-reset).
export type DashboardActions = Pick<Execution, 'start' | 'approve' | 'abort' | 'say' | 'retryReview' | 'retryMr' | 'acceptGate' | 'settle' | 'simplify' | 'archiveFinished'
  | 'createMergeRequest' | 'mergeMergeRequest' | 'mergeRequestStatus' | 'mergeRequestHost' | 'pause' | 'resumePaused' | 'restart'
  | 'handover' | 'takeback' | 'handedDone' | 'markMerged' | 'checkHandedOver' | 'mergeRequestView' | 'saveMr' | 'resetMr' | 'openMergeRequests' | 'mergeRequestThreads' | 'mergeRequestOverview'
  | 'sendSuggestion' | 'dismissSuggestion'>;

// The start screen's data and changes: the workspace registry and the Task files (src/setup.ts).
// jobDependencies: the tickets a live job's Task file lands after. taskFile and saveTask:
// the planned ticket page's Task file and its Save. addAttachment, removeAttachment and
// readAttachment: a ticket's images. setTicketOwner: the ticket page's switch of who plans it.
// setPlanningChat and planningOf: a ticket's planning chat link, and the job payloads' planner block.
// editWorkspace, workspaceSettings and saveDigestSettings: the Workspaces dialog's Edit, the
// payload's settings and the Morning digest section. handoffOf: a workspace's hand-over setting,
// for the rules of a job's actions.
export type DashboardSetup = Pick<Setup, 'workspaces' | 'addWorkspace' | 'editWorkspace' | 'workspaceSettings' | 'handoffOf' | 'saveDigestSettings' | 'removeWorkspace' | 'tickets' | 'jobDependencies' | 'createTicket' | 'archiveTicket' | 'restoreTicket' | 'deleteTicket' | 'setTicketOwner' | 'archivedTickets' | 'taskText' | 'taskTitle'
  | 'taskFile' | 'saveTask' | 'addAttachment' | 'removeAttachment' | 'readAttachment' | 'setPlanningChat' | 'planningOf'>;

// The morning digest: the list, one record, a manual run.
export type DashboardDigests = Pick<Digests, 'list' | 'read' | 'start'>;
// The health checks' last result (sf serve's HealthMonitor).
export type DashboardHealth = Pick<HealthMonitor, 'list'>;
// The planned ticket page's planner session (src/planner-session.ts) for startDashboard: start
// (startPlanner), the session as it runs now (plannerSession, which removes the record of one
// that ended) and stop (stopPlanner), each by the ticket's workspace and key; the caller binds
// the session's environment and folders.
export interface DashboardPlanner {
  start(workspace: string, ticket: string): Promise<{ started: boolean; session: PlannerSession }>;
  session(workspace: string, ticket: string): Promise<PlannerSession | undefined>;
  stop(workspace: string, ticket: string): Promise<PlannerSession | undefined>;
}

// The Task checks: start one, a ticket's view and its board summary.
// store: the records of a ticket's checks, its plan-check rounds and cost.
export type DashboardChecks = Pick<TaskChecks, 'start' | 'view' | 'summary' | 'store'>;

// The run queue: its view for the tickets payload and the board's changes.
// rule: the rule at a usage limit's reset. force: the card's Start anyway;
// withTicket: Save writes under the queue's lock of the ticket.
export type DashboardQueue = Pick<RunQueue, 'view' | 'add' | 'remove' | 'move' | 'limit' | 'hold' | 'release' | 'rule' | 'force' | 'withTicket'>;

// A dashboard without a start screen (in-process tests of the endpoints that need none): the
// lists are empty, every other call is refused with setup_unavailable.
const unavailable = async (): Promise<never> => {
  throw new FactoryError('setup_unavailable', 'The start screen is not available.');
};
const NO_SETUP: DashboardSetup = {
  workspaces: async () => [],
  workspaceSettings: async () => ({ handoff_default: 'checkout', digest: { times: [...DIGEST_DEFAULTS.times], weekdays_only: DIGEST_DEFAULTS.weekdays_only, language: DIGEST_DEFAULTS.language } }),
  handoffOf: async () => 'checkout',
  tickets: async () => [],
  jobDependencies: async () => [],
  archivedTickets: async () => [],
  taskTitle: async () => null,
  taskText: unavailable,
  taskFile: unavailable,
  saveTask: unavailable,
  archiveTicket: unavailable,
  restoreTicket: unavailable,
  deleteTicket: unavailable,
  setTicketOwner: unavailable,
  setPlanningChat: unavailable,
  planningOf: async () => ({ owner: 'chatgpt', planning_chat: null }),
  addWorkspace: unavailable,
  removeWorkspace: unavailable,
  editWorkspace: unavailable,
  saveDigestSettings: unavailable,
  createTicket: unavailable,
  addAttachment: unavailable,
  removeAttachment: unavailable,
  readAttachment: unavailable,
};

export interface RunningDashboard {
  url: URL;
  // The dashboard's URLs through Tailscale, one per remote origin; empty without them.
  remoteUrls: URL[];
  // The bound port of the remote listener; undefined without remote origins.
  remotePort: number | undefined;
  // The state listener: every open page gets the jobs, the setup data and the tickets naming the
  // job's, and the pages that show the job its detail; never throws. The page updates of the calls
  // within one tick are sent together, once.
  onStateChange(job: Job, from: JobState | null): void;
  // A ticket's data changed without a job (a Task check ended, the run queue changed): every page
  // gets the workspaces and all the tickets again.
  refreshSetup(): void;
  // The job's files changed without a state change (its stop's explanation): every page
  // gets the jobs again, and the pages that show the job its detail, as the POST mr-status route
  // does; never throws.
  refreshJob(workspace: string, ticket: string): void;
  // A health check's status changed: every open page gets the checks again.
  healthChanged(): void;
  // The coordinator's state changed (an sf coordinator write): every open page is told, and its
  // Coordinator card reads GET api/coordinator again.
  coordinatorChanged(): void;
  close(): Promise<void>;
}

export function dashboardUrl(port: number, token: string): URL {
  return new URL(`http://${LOOPBACK_HOST}:${port}/d/${token}/`);
}

// SF_DASHBOARD_REMOTE_ORIGINS: the origins of the user's `tailscale serve`, whose
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

// SF_DASHBOARD_REMOTE_LOGINS: the Tailscale logins (Tailscale-User-Login) that may use
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

// The remote listener's port next to the local one: the same port is refused, unless both
// are 0 (each then gets a free port of its own).
export function checkDashboardPorts(port: number, remotePort: number): void {
  if (port === remotePort && port !== 0) {
    throw new FactoryError('invalid_config', `SF_DASHBOARD_REMOTE_PORT must differ from SF_DASHBOARD_PORT (both are ${port}).`);
  }
}

// A new secret token: 32 random bytes as 64 lower-case hex digits; the dashboard's and the MCP
// endpoint's alike.
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

// The dashboard token, or undefined when the file is missing; kept across `sf serve` starts.
export function readToken(stateDir: string): Promise<string | undefined> {
  return readTokenFile(stateDir, TOKEN_FILE, () => new FactoryError('invalid_token', `${TOKEN_FILE} does not hold a dashboard token.`));
}

// With the dashboard off, a token of an earlier start must not point at a dead page.
export async function removeToken(stateDir: string): Promise<void> {
  await rm(join(stateDir, TOKEN_FILE), { force: true });
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

// gate: whether the Codex gate is on (SF_GATE), shown in the job's pipeline; checks: the Task
// checks, none without (the check routes answer 404, the tickets have no check); queue:
// the run queue, none without (the queue routes answer 404, the tickets payload's queue is
// null); onWorkspacesChanged: called after a workspace was added, edited or removed (the
// automatic checks read the registry again); digests: the morning digest, none without (the
// digest routes answer 404); remoteOrigins: the origins of SF_DASHBOARD_REMOTE_ORIGINS, as
// dashboardRemoteOrigins returns them (not parsed again); with them a second listener opens on
// remotePort (SF_DASHBOARD_REMOTE_PORT), the only one that accepts them, and only from
// remoteLogins (SF_DASHBOARD_REMOTE_LOGINS, as dashboardRemoteLogins returns them). The logins and the
// two ports are checked here too (invalid_config), for a caller that did not check them; health:
// the health checks, none without (GET api/health answers 404, the stream sends no health
// event); planner: the planned ticket page's planner session, none without (the planner routes
// answer an empty 404 and the page payload's planner_session is null).
export async function startDashboard(
  port: number, stateDir: string, jobs: JobStore, actions: DashboardActions, setup: DashboardSetup = NO_SETUP,
  { gate: gateOn = true, checks, queue, onWorkspacesChanged, digests, health, planner, remoteOrigins = [], remoteLogins = [], remotePort = DEFAULT_DASHBOARD_REMOTE_PORT }: {
    gate?: boolean; checks?: DashboardChecks; queue?: DashboardQueue; onWorkspacesChanged?: () => void; digests?: DashboardDigests; health?: DashboardHealth; planner?: DashboardPlanner;
    remoteOrigins?: readonly string[]; remoteLogins?: readonly string[]; remotePort?: number;
  } = {},
): Promise<RunningDashboard> {
  const remoteOn = remoteOrigins.length > 0;
  if (remoteOn) {
    dashboardRemoteLogins(remoteOrigins, { SF_DASHBOARD_REMOTE_LOGINS: remoteLogins.join(',') });
    checkDashboardPorts(port, remotePort);
  }
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const [path, { file, type }] of Object.entries(STATIC_FILES)) {
    files.set(path, { body: await readFile(new URL(file, STATIC_DIR)), type });
  }
  for (const { file, url } of [...dashboardScriptFiles(), ...pointScriptFiles()]) {
    files.set(file, { body: await readFile(url), type: 'text/javascript; charset=utf-8' });
  }
  // The factory window's page: outside files, so no path with the token or the cookie serves it.
  const pointPage = await readFile(new URL(POINT_PAGE, STATIC_DIR));
  // The token persists across starts, so a bookmark keeps working; a missing or unusable file
  // gets a new one (sf dashboard --rotate removes the file on purpose).
  let tokenText = await readToken(stateDir).catch(() => undefined);
  if (tokenText === undefined) {
    tokenText = newToken();
    await writeFileAtomic(join(stateDir, TOKEN_FILE), Buffer.from(`${tokenText}\n`));
  }
  // The cookie of a token visit: the hex HMAC-SHA256 of the token over the side's label,
  // so it survives restarts and dies with the token. The local name carries the port (cookies are
  // not kept apart by port); the remote one is __Host- and Secure (the phone reaches it over https).
  const cookieOf = (side: 'local' | 'remote'): string => createHmac('sha256', tokenText).update(`dashboard-cookie:${side}`).digest('hex');
  const cookies = {
    local: { name: '', value: cookieOf('local'), attributes: 'HttpOnly; SameSite=Strict; Path=/' },
    remote: { name: '__Host-sf_dashboard', value: cookieOf('remote'), attributes: 'HttpOnly; Secure; SameSite=Strict; Path=/' },
  };

  const streams = new Set<Stream>();
  const toolCalls = new ToolCallCounter();
  const changes = new Changes(jobs);
  // The tickets' history, read for the planned ticket page.
  const history = new TicketHistory(stateDir);
  // The Stats page's numbers, with their caches.
  const stats = new Stats(stateDir, jobs);
  // The local port accepts loopback Hosts and Origins only, and ignores any
  // Tailscale-User-* header.
  const validateHost = hostHeaderValidation([...LOOPBACK_NAMES]);
  const validateOrigin = localhostOriginValidation();
  // The remote port: remote is a fact of the socket. Tailscale's identity header names a
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
  // A read refused (a Task file's, or the Git host's): an empty 404 for a missing ticket, workspace
  // or file, as for the other reads, else the refusal; anything but a FactoryError is thrown on.
  function refuseRead(res: ServerResponse, error: unknown): void {
    if (!(error instanceof FactoryError)) {
      throw error;
    }
    const status = statusOf(error.code);
    if (status === 404) {
      empty(res, 404);
    } else {
      sendJson(res, status, { ok: false, error: { code: error.code, message: error.message } });
    }
  }

  // The jobs as api/jobs and the jobs events send them: remote says which port asked.
  const jobsOf = async (remote: boolean) => ({ ...(await jobsPayload(jobs, setup, actions, toolCalls)), remote });

  // origin, the exact origin of the page, is known once the listener has its port.
  const ctx: DashboardContext = {
    stateDir, gateOn, remoteOrigins, onWorkspacesChanged, jobs, actions, setup, checks, queue, digests, health, planner, tokenText, cookies, files, streams,
    toolCalls, changes, history, stats, send, empty, body, refuseRead, jobsOf, origin: '',
  };
  const feed = changeFeed(ctx);
  const reads = readHandlers(ctx);
  const posts = postHandlers(ctx, feed);

  // One request on the local port or, with remote true, on the remote one.
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
    // The factory window: GET or HEAD of exactly /point (a query ignored), on the local listener,
    // with the headers every answer gets and no cookie set. It is static and holds no data; its
    // script and app.css load with the cookie.
    if (!remote && target.pathname === '/point' && (req.method === 'GET' || req.method === 'HEAD')) {
      body(res, 'text/html; charset=utf-8', pointPage);
      return;
    }
    const segments = target.pathname.split('/').slice(1);
    const [first, given, ...rest] = segments;
    const cookie = remote ? cookies.remote : cookies.local;
    let path: string[];
    // /d/<token>/...: the token segment must be followed by a slash, so path has at least one
    // entry. Without the token, the cookie of a token visit opens every path at the root. Without
    // either, only GET or HEAD /point on the local listener is answered (above).
    if (first === 'd' && given !== undefined && rest.length > 0 && sameSecret(given, tokenText)) {
      path = rest;
      if (path.length === 1 && path[0] === '' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.setHeader('set-cookie', `${cookie.name}=${cookie.value}; ${cookie.attributes}`);
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
    if (what.kind === 'action' || what.kind === 'workspace-remove' || what.kind === 'ticket-action' || what.kind === 'ticket-owner' || what.kind === 'ticket-chat' || what.kind === 'workspace-edit' || what.kind === 'digest-settings' || what.kind === 'digest-run' || what.kind === 'mr-job' || what.kind === 'pin' || what.kind === 'coordinator-request') {
      if (req.method !== 'POST') {
        empty(res, 405, { allow: 'POST' });
        return;
      }
      let post: Post | undefined;
      if (what.kind === 'action') {
        const key = jobKey(what.workspace, what.ticket);
        post = key === undefined ? undefined : posts.routePost(what.name, what.route, key);
      } else {
        post = posts.setupPost(what);
      }
      if (post === undefined) {
        empty(res, 404);
        return;
      }
      posts.handlePost(req, res, post, remote).catch(failed);
      return;
    }
    if (what.kind === 'ticket-check') {
      const key = jobKey(what.workspace, what.ticket);
      if (req.method !== 'GET' && req.method !== 'POST') {
        empty(res, 405, { allow: 'GET, POST' });
        return;
      }
      const post = key === undefined || req.method === 'GET' ? undefined : posts.checkPost(key);
      if (key === undefined || (req.method === 'POST' && post === undefined)) {
        empty(res, 404);
        return;
      }
      (post !== undefined ? posts.handlePost(req, res, post, remote) : reads.checkView(res, key)).catch(failed);
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
        posts.handlePost(req, res, posts.taskPost(key), remote).catch(failed);
        return;
      }
      reads.route(req, res, path, target.searchParams, remote).catch(failed);
      return;
    }
    if (what.kind === 'ticket-planner') {
      if (req.method !== 'POST' && (what.stop || req.method !== 'GET')) {
        empty(res, 405, { allow: what.stop ? 'POST' : 'GET, POST' });
        return;
      }
      if (req.method === 'GET') {
        reads.route(req, res, path, target.searchParams, remote).catch(failed);
        return;
      }
      const key = jobKey(what.workspace, what.ticket);
      const post = key === undefined ? undefined : posts.plannerPost(key, what.stop);
      if (post === undefined) {
        empty(res, 404);
        return;
      }
      posts.handlePost(req, res, post, remote).catch(failed);
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
        post = posts.attachmentAddPost(key, query.get('name') ?? undefined);
      } else if (key !== undefined && what.kind === 'ticket-attachment-remove' && what.name !== undefined && [...query.keys()].length === 0) {
        post = posts.attachmentRemovePost(key, what.name);
      }
      if (post === undefined) {
        empty(res, 404);
        return;
      }
      posts.handlePost(req, res, post, remote).catch(failed);
      return;
    }
    if (what.kind === 'queue') {
      if (req.method !== 'POST') {
        empty(res, 405, { allow: 'POST' });
        return;
      }
      const post = posts.routePost(what.name, what.route);
      if (post === undefined) {
        empty(res, 404);
        return;
      }
      posts.handlePost(req, res, post, remote).catch(failed);
      return;
    }
    if (what.kind === 'skill-roles') {
      if (req.method !== 'PUT') {
        empty(res, 405, { allow: 'PUT' });
        return;
      }
      posts.handlePost(req, res, posts.skillRolesPost(what.role), remote).catch(failed);
      return;
    }
    if (what.kind === 'both' && req.method === 'POST') {
      posts.handlePost(req, res, posts.setupPost(what)!, remote).catch(failed);
      return;
    }
    if (req.method !== 'GET') {
      empty(res, 405, { allow: what.kind === 'both' ? 'GET, POST' : 'GET' });
      return;
    }
    // GET api/stream opens the change feed's event stream; every other read is the reads' route table.
    const read = matchPath('api/stream', path) !== undefined ? feed.openStream(req, res, target.searchParams, remote) : reads.route(req, res, path, target.searchParams, remote);
    read.catch(failed);
  };

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
  ctx.origin = `http://${LOOPBACK_HOST}:${address.port}`;

  return {
    url: dashboardUrl(address.port, tokenText),
    remoteUrls: remoteDashboardUrls(remoteOrigins, tokenText),
    remotePort: remoteAddress?.port,
    onStateChange(job) {
      const key: TicketKey = [job.workspace, job.ticket];
      feed.changed({ jobs: true, job: key, workspaces: true, tickets: [key] });
    },
    refreshSetup() {
      feed.changed({ workspaces: true, tickets: 'all' });
    },
    refreshJob(workspace, ticket) {
      feed.jobChanged([workspace, ticket]).catch((error: unknown) => console.error(error));
    },
    healthChanged() {
      if (health === undefined) {
        return;
      }
      const list = health.list();
      for (const stream of streams) {
        send(stream, 'health', list);
      }
    },
    coordinatorChanged() {
      feed.changed({ coordinator: true });
    },
    async close() {
      for (const stream of streams) {
        stream.abort.abort();
        stream.res.end();
      }
      // A flush still queued has no page to tell.
      streams.clear();
      await Promise.all([httpServer, ...(remoteServer !== undefined ? [remoteServer] : [])].map(closeServer));
    },
  };
}
