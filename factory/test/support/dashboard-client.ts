// A raw HTTP client of the Dashboard for tests: one request with full control of method, headers
// and body (fetchRaw), an action POST as the page sends it (act), a server-sent event stream
// (openStream), a fake DashboardActions that records every call (fakeActions), a fake
// DashboardSetup with settable workspaces, tickets and Task files that records every change
// (fakeSetup), and the server's rules on a test's own job and detail payloads (served,
// servedDetail).
import assert from 'node:assert/strict';
import { get, request, type IncomingMessage } from 'node:http';
import type { TicketOwner } from '../../src/conversation.js';
import type { DashboardActions, DashboardSetup } from '../../src/dashboard.js';
import { FactoryError } from '../../src/errors.js';
import type { MrInput } from '../../src/execution.js';
import type { Job } from '../../src/jobs.js';
import type { LedgerEntry } from '../../src/ledger.js';
import { type JobFacts, jobActions, settleEntries, stopFields } from '../../src/stops.js';
import type { AddWorkspaceOptions, ArchivedRow, JobDependencies, TicketInput, TicketRow, WorkspaceRow } from '../../src/setup.js';
import { type WorkspaceEdit, workspaceColor } from '../../src/registry.js';
import { taskSha256 } from '../../src/task-file.js';

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:";

export interface Reply {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
  // The body's bytes as they came (an image, SF-064).
  raw: Buffer;
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
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        settled = true;
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw.toString('utf8'), raw });
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

export type Call = ['start', string, string] | ['approve', string, string] | ['abort', string, string, boolean] | ['say', string, string, string] | ['retryReview', string, string] | ['retryMr', string, string] | ['acceptGate', string, string] | ['settle', string, string, string, string, string] | ['archiveFinished', string, string]
  | ['createMergeRequest', string, string] | ['mergeMergeRequest', string, string] | ['mergeRequestStatus', string, string] | ['simplify', string, string]
  | ['pause', string, string] | ['resumePaused', string, string, string] | ['restart', string, string, boolean]
  | ['handover', string, string] | ['takeback', string, string] | ['handedDone', string, string] | ['markMerged', string, string] | ['checkHandedOver', string, string, number]
  | ['mergeRequestView', string, string] | ['saveMr', string, string, MrInput] | ['resetMr', string, string]
  | ['openMergeRequests', string] | ['mergeRequestThreads', string, number] | ['mergeRequestOverview', string, number];

export interface FakeActions extends DashboardActions {
  calls: Call[];
  // What the next calls answer: a value, a FactoryError or any error to throw, or a function.
  answer: unknown;
  // What mergeRequestHost answers for every workspace; its calls are not recorded (every payload asks).
  mrHost: { host: 'github' | 'gitlab' | null; reason: string | null };
  // What mergeRequestView answers (SF-080): undefined, the view, or an error to throw.
  mrView: unknown;
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
    retryMr: (workspace, ticket) => reply(['retryMr', workspace, ticket]),
    acceptGate: (workspace, ticket) => reply(['acceptGate', workspace, ticket]),
    settle: (workspace, ticket, id, decision, note) => reply(['settle', workspace, ticket, id, decision, note ?? '']),
    simplify: (workspace, ticket) => reply(['simplify', workspace, ticket]),
    archiveFinished: (workspace, ticket) => reply(['archiveFinished', workspace, ticket]),
    createMergeRequest: (workspace, ticket) => reply(['createMergeRequest', workspace, ticket]),
    mergeMergeRequest: (workspace, ticket) => reply(['mergeMergeRequest', workspace, ticket]),
    mergeRequestStatus: (workspace, ticket) => reply(['mergeRequestStatus', workspace, ticket]),
    pause: (workspace, ticket) => reply(['pause', workspace, ticket]),
    resumePaused: (workspace, ticket, message) => reply(['resumePaused', workspace, ticket, message ?? '']),
    restart: (workspace, ticket, keepFiles) => reply(['restart', workspace, ticket, keepFiles ?? false]),
    handover: (workspace, ticket) => reply(['handover', workspace, ticket]),
    takeback: (workspace, ticket) => reply(['takeback', workspace, ticket]),
    handedDone: (workspace, ticket) => reply(['handedDone', workspace, ticket]),
    markMerged: (workspace, ticket) => reply(['markMerged', workspace, ticket]),
    // The job detail's push check (SF-073): recorded, and answered with the job unchanged.
    checkHandedOver: async (workspace, ticket, minIntervalMs) => {
      fake.calls.push(['checkHandedOver', workspace, ticket, minIntervalMs ?? 0]);
      return { state: 'handed_over', branch: '' };
    },
    mrHost: { host: 'github', reason: null },
    mergeRequestHost: async () => fake.mrHost,
    // The Merge request screen (SF-080): the view's reads are recorded and answered with mrView.
    mrView: undefined,
    mergeRequestView: async (workspace, ticket) => {
      fake.calls.push(['mergeRequestView', workspace, ticket]);
      if (fake.mrView instanceof Error) {
        throw fake.mrView;
      }
      return fake.mrView as Awaited<ReturnType<DashboardActions['mergeRequestView']>>;
    },
    saveMr: (workspace, ticket, input) => reply(['saveMr', workspace, ticket, input]),
    resetMr: (workspace, ticket) => reply(['resetMr', workspace, ticket]),
    openMergeRequests: (workspace) => reply(['openMergeRequests', workspace]),
    mergeRequestThreads: (workspace, number) => reply(['mergeRequestThreads', workspace, number]),
    mergeRequestOverview: (workspace, number) => reply(['mergeRequestOverview', workspace, number]),
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

export type SetupCall = ['saveTask', string, string, string, string] | ['addWorkspace', string, string] | ['addWorkspace', string, string, AddWorkspaceOptions] | ['removeWorkspace', string] | ['createTicket', TicketInput]
  // The Workspaces dialog's Edit and the Morning digest section (SF-103).
  | ['editWorkspace', string, Omit<WorkspaceEdit, 'read_checkout'> & { path: string }] | ['saveDigestSettings', { at: string; weekdays_only: boolean; language: string }]
  | ['archiveTicket', string, string] | ['restoreTicket', string, string] | ['deleteTicket', string, string] | ['setTicketOwner', string, string, TicketOwner]
  // A ticket's images (SF-064): the upload's bytes as hex and its name (null without one).
  | ['addAttachment', string, string, string, string | null] | ['removeAttachment', string, string, string];

export interface FakeSetup extends DashboardSetup {
  rows: { workspaces: WorkspaceRow[]; tickets: TicketRow[]; archived: ArchivedRow[]; jobDependencies: JobDependencies[] };
  // The Task files taskText reads, by "<ws>/<ticket>" (archived: "<ws>/archive/<ticket>"); a
  // missing one is task_not_found. taskTitle reads the title of the active one.
  texts: Map<string, string>;
  // The taskText calls, in order: "<ws>/<ticket>" or "<ws>/archive/<ticket>".
  reads: string[];
  // The modification time taskFile answers (SF-081).
  mtime: string;
  calls: SetupCall[];
  // The workspaces payload's settings (SF-103).
  settings: Awaited<ReturnType<DashboardSetup['workspaceSettings']>>;
  // What the next change answers: a value, an error to throw, or a function.
  answer: unknown;
  // The images readAttachment serves (SF-064), by "<ws>/<ticket>/<name>"; a missing one is
  // attachment_missing.
  images: Map<string, { type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: Buffer }>;
}

export function workspaceRow(name: string, path = `/srv/${name}`, liveJobs = 0, handoff: WorkspaceRow['handoff'] = null): WorkspaceRow {
  return { name, path, liveJobs, problem: null, handoff, color: workspaceColor(name), app: name, description: null, derived_description: null, digest: { track: false, my_work: false } };
}

export function ticketRow(workspace: string, ticket: string, title = `Ticket ${ticket}`, draft = true, job: TicketRow['job'] = null): TicketRow {
  return { workspace, ticket, title, base: 'main', draft, request: null, owner: 'chatgpt', job, lands_after: [], attachments: [] };
}

// Lists rows and records every change; the change answers with `answer` (thrown when it is an
// Error; awaited when it is a function) or, by default, with a plausible result.
export function fakeSetup(workspaces: WorkspaceRow[] = [], tickets: TicketRow[] = [], archived: ArchivedRow[] = []): FakeSetup {
  const fake: FakeSetup = {
    rows: { workspaces, tickets, archived, jobDependencies: [] },
    texts: new Map(),
    reads: [],
    mtime: '2026-11-05T09:00:00.000Z',
    calls: [],
    settings: { handoff_default: 'checkout', digest: { at: '08:00', weekdays_only: true, language: 'English' } },
    answer: undefined,
    images: new Map(),
    addAttachment: (workspace, ticket, data, name) => reply(['addAttachment', workspace, ticket, Buffer.from(data).toString('hex'), name ?? null], { name: name ?? '1.png', bytes: data.byteLength, type: 'image/png' }),
    removeAttachment: (workspace, ticket, name) => reply(['removeAttachment', workspace, ticket, name], { name }),
    readAttachment: async (workspace, ticket, name) => {
      const image = fake.images.get(`${workspace}/${ticket}/${name}`);
      if (image === undefined) {
        throw new FactoryError('attachment_missing', `.software-factory/${ticket}/${name} does not exist.`);
      }
      return { name, bytes: image.data.byteLength, type: image.type, data: image.data };
    },
    taskText: async (workspace, ticket, archived = false) => {
      const key = archived ? `${workspace}/archive/${ticket}` : `${workspace}/${ticket}`;
      fake.reads.push(key);
      const text = fake.texts.get(key);
      if (text === undefined) {
        throw new FactoryError('task_not_found', `No Task file for ${key}.`);
      }
      return text;
    },
    // The planned ticket page (SF-081): the text as taskText reads it, its sha256 and mtime.
    taskFile: async (workspace, ticket) => {
      const text = await fake.taskText(workspace, ticket);
      return { text, sha256: taskSha256(text), mtime: fake.mtime };
    },
    // Save (SF-081): recorded; by default the text is written over the active one, as the writer does.
    saveTask: async (workspace, ticket, content, sha256) => {
      const result = await reply(['saveTask', workspace, ticket, content, sha256], { path: `.software-factory/${ticket}.md`, status: 'replaced', bytes: Buffer.byteLength(content), sha256: taskSha256(content) });
      if (fake.answer === undefined) {
        fake.texts.set(`${workspace}/${ticket}`, content);
      }
      return result;
    },
    taskTitle: async (workspace, ticket) => /^title: (.*)$/m.exec(fake.texts.get(`${workspace}/${ticket}`) ?? '')?.[1] ?? null,
    workspaces: async () => fake.rows.workspaces,
    tickets: async () => fake.rows.tickets,
    jobDependencies: async () => fake.rows.jobDependencies,
    archivedTickets: async () => fake.rows.archived,
    archiveTicket: (workspace, ticket) => reply(['archiveTicket', workspace, ticket], { workspace, ticket, path: `.software-factory/archive/${ticket}.md`, jobArchived: false }),
    restoreTicket: (workspace, ticket) => reply(['restoreTicket', workspace, ticket], { workspace, ticket, path: `.software-factory/${ticket}.md` }),
    deleteTicket: (workspace, ticket) => reply(['deleteTicket', workspace, ticket], { workspace, ticket, deleted: [`.software-factory/${ticket}.md`], jobArchived: false }),
    // The ticket page's switch: by default the listed row (or a new one) with the new owner.
    setTicketOwner: (workspace, ticket, owner) => {
      const row = fake.rows.tickets.find((each) => each.workspace === workspace && each.ticket === ticket) ?? ticketRow(workspace, ticket);
      return reply(['setTicketOwner', workspace, ticket, owner], { ...row, owner });
    },
    addWorkspace: (name, path, options = {}) => reply(
      Object.keys(options).length === 0 ? ['addWorkspace', name, path] : ['addWorkspace', name, path, options],
      { ...workspaceRow(name, path, 0, options.handoff ?? null), color: workspaceColor(name, options.color) },
    ),
    editWorkspace: (name, edit) => reply(['editWorkspace', name, edit], { ...workspaceRow(name, edit.path), description: edit.description === '' ? null : edit.description, app: edit.app === '' ? name : edit.app, digest: edit.digest }),
    workspaceSettings: async () => fake.settings,
    saveDigestSettings: (input) => reply(['saveDigestSettings', input], { ...input }),
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

// A job of a test's payload as the server sends it (SF-129): with its stop's canonical row
// (stop_code, stop_kind, stop_group), its actions and every action's availability, computed by
// src/stops.ts from the job and the facts (the ledger, the last iteration's review and gate; the
// Git host is the job's mr_host), over whatever the job carried. A test that feeds its own
// actions and availability builds the job without it.
export function served<T extends object>(job: T, facts: Partial<JobFacts> = {}): T {
  const shape = job as Record<string, unknown>;
  const real = { mr: null, mr_conflict_turn: false, ...shape, error: shape.error ?? undefined, paused: shape.paused ?? undefined } as unknown as Job;
  const now = new Date();
  const host = shape.mr_host;
  return { ...job, ...stopFields(real, now), ...jobActions(real, { ledger: [], review: undefined, mrHost: host === undefined ? null : (host as JobFacts['mrHost']), ...facts }, now) };
}

// A job detail of a test as the server sends it (SF-129): its job served with the detail's facts
// (its ledger, the review and gate of the job's last iteration), and settle_ids, the entries the
// stop block offers to settle. A detail that already carries settle_ids keeps them.
export function servedDetail<T extends { job: object; iterations?: unknown[]; ledger?: unknown[] }>(detail: T): T {
  const job = detail.job as Record<string, unknown>;
  const ledger = (detail.ledger ?? []) as LedgerEntry[];
  const last = (detail.iterations ?? []).find((iteration) => (iteration as { number?: unknown }).number === job.iteration) as { review?: unknown; gate?: unknown } | undefined;
  const facts = { ledger, review: (last?.review ?? undefined) as JobFacts['review'], gate: (last?.gate ?? undefined) as JobFacts['gate'] };
  const real = { mr: null, mr_conflict_turn: false, ...job, error: job.error ?? undefined } as unknown as Job;
  return {
    settle_ids: settleEntries(real, ledger, new Date()).map((entry) => entry.id),
    ...detail,
    job: served(detail.job, facts),
  };
}
