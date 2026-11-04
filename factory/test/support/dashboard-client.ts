// A raw HTTP client of the Dashboard for tests: one request with full control of method, headers
// and body (fetchRaw), an action POST as the page sends it (act), a server-sent event stream
// (openStream), a fake DashboardActions that records every call (fakeActions) and a fake
// DashboardSetup with settable workspaces, tickets and Task files that records every change
// (fakeSetup).
import assert from 'node:assert/strict';
import { get, request, type IncomingMessage } from 'node:http';
import type { DashboardActions, DashboardSetup } from '../../src/dashboard.js';
import { FactoryError } from '../../src/errors.js';
import type { ArchivedRow, TicketInput, TicketRow, WorkspaceRow } from '../../src/setup.js';

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'";

export interface Reply {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface RawOptions {
  method?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  // Sends the body in chunks of this size, without Content-Length (chunked transfer).
  chunk?: number;
}

export function fetchRaw(url: URL | string, options: RawOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers: Record<string, string> = { ...(options.host !== undefined ? { host: options.host } : {}), ...(options.headers ?? {}) };
    const data = options.body === undefined ? undefined : Buffer.from(options.body);
    if (data !== undefined && options.chunk === undefined) {
      headers['content-length'] = String(data.length);
    }
    let settled = false;
    const req = request(target, { method: options.method ?? 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        settled = true;
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    // A server that answers (413) before the body is complete resets the connection while the
    // client still writes; the answer counts, the write error does not.
    req.on('error', (error) => {
      if (!settled) {
        reject(error);
      }
    });
    if (data !== undefined && options.chunk !== undefined) {
      for (let offset = 0; offset < data.length; offset += options.chunk) {
        req.write(data.subarray(offset, offset + options.chunk));
      }
      req.end();
    } else {
      req.end(data);
    }
  });
}

// POST api/jobs/<key>/<action> as the page does: the exact Origin, JSON, a JSON body.
export function act(base: URL, path: string, body: unknown, overrides: RawOptions = {}): Promise<Reply> {
  const origin = `http://${base.hostname}:${base.port}`;
  return fetchRaw(new URL(path, base), {
    method: 'POST',
    ...overrides,
    headers: { origin, 'content-type': 'application/json', ...(overrides.headers ?? {}) },
    body: overrides.body ?? JSON.stringify(body),
  });
}

export interface SseEvent {
  event: string;
  data: any;
}

export interface Stream {
  status: number;
  headers: IncomingMessage['headers'];
  events: SseEvent[];
  // The next event of that name after the ones already taken.
  next(event: string, match?: (data: any) => boolean): Promise<any>;
  // An event of that name received at any time, taken or not, without taking it: for an event whose
  // order against the others is not fixed (a state line of events.jsonl, read by the follower,
  // may come before or after the jobs refresh of the same transition).
  seen(event: string, match?: (data: any) => boolean): Promise<any>;
  close(): void;
}

export function openStream(url: URL): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      const events: SseEvent[] = [];
      let taken = 0;
      let wake: (() => void) | undefined;
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (name !== undefined && data !== undefined) {
            events.push({ event: name, data: JSON.parse(data) });
            wake?.();
          }
        }
      });
      res.on('error', () => undefined);
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        events,
        async next(event, match = () => true) {
          const deadline = Date.now() + 10_000;
          for (;;) {
            for (; taken < events.length; taken += 1) {
              const candidate = events[taken]!;
              if (candidate.event === event && match(candidate.data)) {
                taken += 1;
                return candidate.data;
              }
            }
            if (Date.now() > deadline) {
              assert.fail(`no ${event} event; got ${JSON.stringify(events.map((item) => item.event))}`);
            }
            await new Promise<void>((done) => {
              wake = done;
              setTimeout(done, 100);
            });
          }
        },
        async seen(event, match = () => true) {
          const deadline = Date.now() + 10_000;
          for (;;) {
            const found = events.find((candidate) => candidate.event === event && match(candidate.data));
            if (found !== undefined) {
              return found.data;
            }
            if (Date.now() > deadline) {
              assert.fail(`no ${event} event; got ${JSON.stringify(events.map((item) => item.event))}`);
            }
            await new Promise<void>((done) => {
              wake = done;
              setTimeout(done, 100);
            });
          }
        },
        close() {
          req.destroy();
        },
      });
    });
    req.once('error', reject);
  });
}

export type Call = ['start', string, string] | ['approve', string, string] | ['abort', string, string, boolean] | ['say', string, string, string] | ['retryReview', string, string] | ['acceptGate', string, string] | ['archiveFinished', string, string];

export interface FakeActions extends DashboardActions {
  calls: Call[];
  // What the next calls answer: a value, a FactoryError or any error to throw, or a function.
  answer: unknown;
}

// Records every call and answers with `answer` (thrown when it is an Error; awaited when it is a
// function returning a promise), so a test can see exactly what reached the Execution.
export function fakeActions(answer: unknown = { state: 'pushed', branch: 'T-1-demo' }): FakeActions {
  const fake: FakeActions = {
    calls: [],
    answer,
    start: (workspace, ticket) => reply(['start', workspace, ticket]),
    approve: (workspace, ticket) => reply(['approve', workspace, ticket]),
    abort: (workspace, ticket, discard) => reply(['abort', workspace, ticket, discard]),
    say: (workspace, ticket, message) => reply(['say', workspace, ticket, message]),
    retryReview: (workspace, ticket) => reply(['retryReview', workspace, ticket]),
    acceptGate: (workspace, ticket) => reply(['acceptGate', workspace, ticket]),
    archiveFinished: (workspace, ticket) => reply(['archiveFinished', workspace, ticket]),
  };
  async function reply(call: Call): Promise<any> {
    fake.calls.push(call);
    const value = typeof fake.answer === 'function' ? await (fake.answer as () => unknown)() : fake.answer;
    if (value instanceof Error || value instanceof FactoryError) {
      throw value;
    }
    return value;
  }
  return fake;
}

export type SetupCall = ['addWorkspace', string, string] | ['removeWorkspace', string] | ['createTicket', TicketInput]
  | ['archiveTicket', string, string] | ['restoreTicket', string, string] | ['deleteTicket', string, string];

export interface FakeSetup extends DashboardSetup {
  rows: { workspaces: WorkspaceRow[]; tickets: TicketRow[]; archived: ArchivedRow[] };
  // The Task files taskText reads, by "<ws>/<ticket>" (archived: "<ws>/archive/<ticket>"); a
  // missing one is task_not_found. taskTitle reads the title of the active one.
  texts: Map<string, string>;
  // The taskText calls, in order: "<ws>/<ticket>" or "<ws>/archive/<ticket>".
  reads: string[];
  calls: SetupCall[];
  // What the next change answers: a value, an error to throw, or a function.
  answer: unknown;
}

export function workspaceRow(name: string, path = `/srv/${name}`, liveJobs = 0): WorkspaceRow {
  return { name, path, liveJobs, problem: null };
}

export function ticketRow(workspace: string, ticket: string, title = `Ticket ${ticket}`, draft = true, job: TicketRow['job'] = null): TicketRow {
  return { workspace, ticket, title, base: 'main', draft, request: null, job };
}

// Lists rows and records every change; the change answers with `answer` (thrown when it is an
// Error; awaited when it is a function) or, by default, with a plausible result.
export function fakeSetup(workspaces: WorkspaceRow[] = [], tickets: TicketRow[] = [], archived: ArchivedRow[] = []): FakeSetup {
  const fake: FakeSetup = {
    rows: { workspaces, tickets, archived },
    texts: new Map(),
    reads: [],
    calls: [],
    answer: undefined,
    taskText: async (workspace, ticket, archived = false) => {
      const key = archived ? `${workspace}/archive/${ticket}` : `${workspace}/${ticket}`;
      fake.reads.push(key);
      const text = fake.texts.get(key);
      if (text === undefined) {
        throw new FactoryError('task_not_found', `No Task file for ${key}.`);
      }
      return text;
    },
    taskTitle: async (workspace, ticket) => /^title: (.*)$/m.exec(fake.texts.get(`${workspace}/${ticket}`) ?? '')?.[1] ?? null,
    workspaces: async () => fake.rows.workspaces,
    tickets: async () => fake.rows.tickets,
    archivedTickets: async () => fake.rows.archived,
    archiveTicket: (workspace, ticket) => reply(['archiveTicket', workspace, ticket], { workspace, ticket, path: `.software-factory/archive/${ticket}.md`, jobArchived: false }),
    restoreTicket: (workspace, ticket) => reply(['restoreTicket', workspace, ticket], { workspace, ticket, path: `.software-factory/${ticket}.md` }),
    deleteTicket: (workspace, ticket) => reply(['deleteTicket', workspace, ticket], { workspace, ticket, deleted: [`.software-factory/${ticket}.md`], jobArchived: false }),
    addWorkspace: (name, path) => reply(['addWorkspace', name, path], workspaceRow(name, path)),
    removeWorkspace: (name) => reply(['removeWorkspace', name], { removed: name }),
    createTicket: (input) => reply(['createTicket', input], { workspace: input.workspace, ticket: input.ticket, path: `.software-factory/${input.ticket}.md`, base: 'main' }),
  };
  async function reply(call: SetupCall, fallback: unknown): Promise<any> {
    fake.calls.push(call);
    const value = fake.answer === undefined ? fallback : typeof fake.answer === 'function' ? await (fake.answer as () => unknown)() : fake.answer;
    if (value instanceof Error || value instanceof FactoryError) {
      throw value;
    }
    return value;
  }
  return fake;
}
