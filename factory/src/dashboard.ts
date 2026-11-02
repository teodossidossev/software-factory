// The read-only Dashboard: a second loopback HTTP listener with the static page, JSON endpoints
// and one server-sent event stream per open page. Every path starts with /d/<token>/; anything
// else is an empty 404. Reads JobStore and events.jsonl only; job state changes arrive through
// onStateChange, which `sf serve` composes with the notifier. Nothing here changes a job.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import type { Job, JobState, JobStore } from './jobs.js';
import { WORKSPACE_NAME_PATTERN } from './registry.js';
import { TICKET_PATTERN } from './task-file.js';
import { describeEvent, followLines } from './watch.js';

export const DEFAULT_DASHBOARD_PORT = 8788;
export const TOKEN_FILE = 'dashboard-token';
export const MAX_STREAMS = 8;
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

export interface RunningDashboard {
  url: URL;
  // The state listener: refreshes every open page; never throws.
  onStateChange(job: Job, from: JobState | null): void;
  close(): Promise<void>;
}

export function dashboardUrl(port: number, token: string): URL {
  return new URL(`http://${LOOPBACK_HOST}:${port}/d/${token}/`);
}

// The token of the last `sf serve` start, or undefined when the file is missing.
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

interface Stream {
  res: ServerResponse;
  job: [string, string] | undefined;
  abort: AbortController;
}

export async function startDashboard(port: number, stateDir: string, jobs: JobStore): Promise<RunningDashboard> {
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const [path, { file, type }] of Object.entries(STATIC_FILES)) {
    files.set(path, { body: await readFile(new URL(file, STATIC_DIR)), type });
  }
  const tokenText = randomBytes(32).toString('hex');
  const token = Buffer.from(tokenText, 'utf8');
  await writeFileAtomic(join(stateDir, TOKEN_FILE), Buffer.from(`${tokenText}\n`));

  const streams = new Set<Stream>();
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const send = (stream: Stream, event: string, data: unknown): void => {
    stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const empty = (res: ServerResponse, status: number, headers: Record<string, string> = {}): void => {
    res.writeHead(status, headers).end();
  };
  const body = (res: ServerResponse, type: string, data: string | Buffer): void => {
    res.writeHead(200, { 'content-type': type }).end(data);
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
    if (req.method !== 'GET') {
      empty(res, 405, { allow: 'GET' });
      return;
    }
    route(req, res, path, target.searchParams).catch((error: unknown) => {
      console.error(error);
      if (!res.headersSent) {
        empty(res, 500);
      } else {
        res.end();
      }
    });
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
