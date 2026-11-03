// The Dashboard: a second loopback HTTP listener with the static page, JSON endpoints, one
// server-sent event stream per open page and, since version 2, the User's actions approve, abort
// and say as POST endpoints. Every path starts with /d/<token>/; anything else is an empty 404.
// Reads JobStore and events.jsonl; job state changes arrive through onStateChange, which
// `sf serve` composes with the notifier. The actions validate the HTTP request and delegate once
// to the Execution of `sf serve` (DashboardActions); nothing here changes a job by itself.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import type { Execution } from './execution.js';
import type { Job, JobState, JobStore } from './jobs.js';
import { WORKSPACE_NAME_PATTERN } from './registry.js';
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
// results as the socket commands of sf approve, sf abort and sf say.
export type DashboardActions = Pick<Execution, 'approve' | 'abort' | 'say'>;
export type DashboardAction = keyof DashboardActions;

// The request body of each action, strict: unknown keys, null, arrays and wrong types are
// refused; shape is what the refusal names.
const BODIES = {
  approve: { shape: '{}', schema: z.strictObject({}) },
  abort: { shape: '{"discard"?: boolean}', schema: z.strictObject({ discard: z.boolean().optional() }) },
  say: { shape: '{"message": string}', schema: z.strictObject({ message: z.string() }) },
};
export const ACTIONS = Object.keys(BODIES) as DashboardAction[];

// The HTTP status of a FactoryError the three methods can throw; any other code answers 500 and
// keeps its code and message.
const ERROR_STATUS: Record<string, number> = {
  invalid_state: 409, turn_running: 409, rebase_in_progress: 409,
  job_not_found: 404, workspace_not_found: 404,
  invalid_content: 400,
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

function jobSummary(job: Job) {
  return {
    workspace: job.workspace, ticket: job.ticket, branch: job.branch, base: job.base, state: job.state,
    iteration: job.iteration, mr_attempts: job.mr_attempts, updated_at: job.updated_at, created_at: job.created_at,
    error: job.error ?? null,
  };
}

async function jobsPayload(jobs: JobStore) {
  return { jobs: (await jobs.list()).map(jobSummary) };
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
  const history: Array<{ ts: string; from: string | null; to: string; error?: { code: string; message: string } }> = [];
  for (const line of text.split('\n')) {
    let record: { ts?: unknown; state?: { from: string | null; to: string; error?: { code: string; message: string } } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (typeof record === 'object' && record !== null && typeof record.state === 'object' && record.state !== null) {
      const { from, to, error } = record.state;
      history.push({ ts: String(record.ts), from: from ?? null, to, ...(error !== undefined ? { error } : {}) });
    }
  }
  return history;
}

async function jobDetail(jobs: JobStore, job: Job) {
  const iterations = [];
  for (let number = 1; number <= job.iteration; number += 1) {
    try {
      const meta = await jobs.readMeta(job.workspace, job.ticket, number);
      iterations.push({
        number, started_at: meta.started_at, ended_at: meta.ended_at, cost_usd: meta.cost_usd,
        changed_files: meta.changed_files.length, patch_truncated: meta.patch_truncated, denials: meta.denials.length,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return {
    job: jobSummary(job),
    iterations,
    mr: (await jobs.readMrText(job.workspace, job.ticket)) !== undefined,
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

// api/jobs/<ws>/<ticket>/<action>, whatever the names: the method rule is decided by the route.
function actionRoute(path: string[]): DashboardAction | undefined {
  const [api, kind, , , action] = path;
  return path.length === 5 && api === 'api' && kind === 'jobs' ? ACTIONS.find((known) => known === action) : undefined;
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

export async function startDashboard(port: number, stateDir: string, jobs: JobStore, actions: DashboardActions): Promise<RunningDashboard> {
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
    stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
    send(stream, 'jobs', await jobsPayload(jobs));
    if (key === undefined) {
      return;
    }
    const job = await jobs.read(...key);
    if (job !== undefined && !stream.abort.signal.aborted) {
      send(stream, 'job', await jobDetail(jobs, job));
    }
    const start = Number(from);
    try {
      await followLines(jobs.eventsPath(...key), true, (raw, line) => {
        const event = line >= start ? describeEvent(raw) : undefined;
        if (event !== undefined && event.lines.length > 0 && !stream.abort.signal.aborted) {
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
      body(res, 'application/json; charset=utf-8', JSON.stringify(await jobsPayload(jobs)));
      return;
    }
    if (joined === 'api/stream') {
      await openStream(req, res, query);
      return;
    }
    const [, kind, ...rest] = path;
    const key = kind === 'jobs' ? jobKey(rest[0], rest[1]) : undefined;
    const job = key === undefined ? undefined : await jobs.read(...key);
    if (key === undefined || job === undefined) {
      empty(res, 404);
      return;
    }
    const [, , ...tail] = rest;
    if (tail.length === 0) {
      body(res, 'application/json; charset=utf-8', JSON.stringify(await jobDetail(jobs, job)));
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

  // The validated body as the one Execution call it stands for, or undefined when it is invalid.
  function toCall(action: DashboardAction, data: unknown, [workspace, ticket]: [string, string]): (() => Promise<unknown>) | undefined {
    if (action === 'approve') {
      return BODIES.approve.schema.safeParse(data).success ? () => actions.approve(workspace, ticket) : undefined;
    }
    if (action === 'abort') {
      const parsed = BODIES.abort.schema.safeParse(data);
      return parsed.success ? () => actions.abort(workspace, ticket, parsed.data.discard === true) : undefined;
    }
    const parsed = BODIES.say.schema.safeParse(data);
    return parsed.success ? () => actions.say(workspace, ticket, parsed.data.message) : undefined;
  }

  // POST api/jobs/<ws>/<ticket>/<action>: the transport checks, then one Execution call. A page
  // that goes away while the call runs stops waiting; the call itself goes on and settles here.
  async function handleAction(req: IncomingMessage, res: ServerResponse, action: DashboardAction, key: [string, string]): Promise<void> {
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
    if ((await jobs.read(...key)) === undefined) {
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
    const run = toCall(action, data, key);
    if (run === undefined) {
      fail(400, 'invalid_body', `${action} expects ${BODIES[action].shape}; no other keys, no null.`);
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
    const action = actionRoute(path);
    if (action !== undefined) {
      if (req.method !== 'POST') {
        empty(res, 405, { allow: 'POST' });
        return;
      }
      const key = jobKey(path[2], path[3]);
      if (key === undefined) {
        empty(res, 404);
        return;
      }
      handleAction(req, res, action, key).catch(failed);
      return;
    }
    if (req.method !== 'GET') {
      empty(res, 405, { allow: 'GET' });
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

  const refresh = async (job: Job): Promise<void> => {
    if (streams.size === 0) {
      return;
    }
    const list = await jobsPayload(jobs);
    const selected = [...streams].filter((stream) => stream.job?.[0] === job.workspace && stream.job[1] === job.ticket);
    const detail = selected.length > 0 ? await jobDetail(jobs, job) : undefined;
    for (const stream of streams) {
      send(stream, 'jobs', list);
      if (detail !== undefined && selected.includes(stream)) {
        send(stream, 'job', detail);
      }
    }
  };

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
