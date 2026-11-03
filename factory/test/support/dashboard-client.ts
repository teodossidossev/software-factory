// A raw HTTP client of the Dashboard for tests: one request with full control of method, headers
// and body (fetchRaw), an action POST as the page sends it (act), a server-sent event stream
// (openStream), a fake DashboardActions that records every call (fakeActions) and a fake
// DashboardReviewers with settable subscriptions (fakeReviewers).
import assert from 'node:assert/strict';
import { get, request, type IncomingMessage } from 'node:http';
import type { DashboardActions, DashboardReviewers } from '../../src/dashboard.js';
import { FactoryError } from '../../src/errors.js';
import type { EventInput, SubscriptionSummary, TestOutcome } from '../../src/events.js';

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
        close() {
          req.destroy();
        },
      });
    });
    req.once('error', reject);
  });
}

export type Call = ['approve', string, string] | ['abort', string, string, boolean] | ['say', string, string, string];

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
    approve: (workspace, ticket) => reply(['approve', workspace, ticket]),
    abort: (workspace, ticket, discard) => reply(['abort', workspace, ticket, discard]),
    say: (workspace, ticket, message) => reply(['say', workspace, ticket, message]),
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

export interface FakeReviewers extends DashboardReviewers {
  rows: SubscriptionSummary[];
  // The ids test was called with, in order.
  tests: string[];
  // What the next test answers: a TestOutcome, an error to throw, or a function.
  answer: unknown;
  // Replaces the subscriptions and tells the listeners, as Events does after a change.
  set(rows: SubscriptionSummary[]): void;
  listeners(): number;
}

export function subscription(id: string, input: EventInput, host = 'chatgpt.example'): SubscriptionSummary {
  return { id, principal: 'user-1', event: 'software_factory.job', input, host, createdAt: '2026-11-01T09:00:00.000Z', refreshBefore: '2026-11-08T09:00:00.000Z' };
}

export function fakeReviewers(rows: SubscriptionSummary[] = []): FakeReviewers {
  const listeners = new Set<() => void>();
  const fake: FakeReviewers = {
    rows,
    tests: [],
    answer: undefined,
    subscriptions: () => fake.rows,
    async test(id) {
      fake.tests.push(id);
      const value = typeof fake.answer === 'function' ? await (fake.answer as () => unknown)() : fake.answer;
      if (value instanceof Error) {
        throw value;
      }
      return (value ?? { subscription: id, delivered: true, status: 200 }) as TestOutcome;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      fake.rows = next;
      for (const listener of listeners) {
        listener();
      }
    },
    listeners: () => listeners.size,
  };
  return fake;
}
