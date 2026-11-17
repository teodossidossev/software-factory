// The dashboard's reads: the GET route table (the page's files, the JSON payloads, a job's
// detail, Stream, MR text, Merge request screen, Changes and iteration files, the Stats page, the
// digests, the health checks, the coordinator's state, a workspace's vision page, the pins, the
// planned ticket page, a ticket's planner session, a Task file, a ticket's images, a workspace's
// merge requests) and the Task check's GET. Nothing here changes anything but the record of a
// planner session that ended, which its read removes (src/planner-session.ts plannerSession);
// every answer is written through the context.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readCoordinator } from './coordinator.js';
import { type DashboardContext, iterationParam, jobKey, matchPath, noQuery, plannerSessionView } from './dashboard-context.js';
import { jobDetail, planOf, ticketEntry, ticketsPayload, workspacesPayload } from './dashboard-payloads.js';
import { mergeRequestOverviewRead, mergeRequestThreadsRead, openMergeRequestsRead } from './dashboard-routes.js';
import { FactoryError } from './errors.js';
import { sendJson, statusOf } from './http.js';
import { lineEntries, type StreamEntry, streamContext } from './job-stream.js';
import type { Job } from './jobs.js';
import { readPins } from './pins.js';
import { WORKSPACE_NAME_PATTERN } from './registry.js';
import { skillsForClients, skillsView, skillText } from './skills.js';
import { STATS_DAYS, type StatsDays } from './stats.js';
import type { CheckRecord } from './task-check.js';
import { readVisionPage, VISION_PAGE_CSP } from './vision.js';
import { followLines } from './watch.js';

// The events.jsonl lines of one page of the job's Stream.
export const STREAM_PAGE_LINES = 2000;
// How often the job's detail asks origin for the user's push of a handed-over branch.
const PUSH_CHECK_INTERVAL_MS = 60_000;

// One GET as a route's handler sees it: params are the path's segments that the pattern's "*" stand for.
interface GetRequest {
  req: IncomingMessage;
  res: ServerResponse;
  query: URLSearchParams;
  remote: boolean;
  params: string[];
}

interface GetRoute {
  pattern: string;
  when?: (query: URLSearchParams) => boolean;
  handler: (get: GetRequest) => Promise<void> | void;
}

// route: a GET through the route table, an empty 404 when no route matches; checkView: GET
// api/tickets/<ws>/<ticket>/check.
export function readHandlers(ctx: DashboardContext) {
  const { jobs, actions, setup, checks, queue, digests, health, planner, gateOn, files, changes, history, stats, empty, body, refuseRead, jobsOf } = ctx;

  // The GET routes, matched in order against the path: a pattern's segments must equal the path's,
  // "*" stands for any one segment and hands it to the handler; when, if given, must hold too. A
  // path no route matches is an empty 404.
  const getRoutes: GetRoute[] = [
    ...[...files].map(([pattern, file]): GetRoute => ({ pattern, handler: ({ res }) => body(res, file.type, file.body) })),
    { pattern: 'api/jobs', handler: async ({ res, remote }) => sendJson(res, 200, await jobsOf(remote)) },
    { pattern: 'api/workspaces', handler: async ({ res }) => sendJson(res, 200, await workspacesPayload(setup, ctx.stateDir)) },
    { pattern: 'api/tickets', handler: async ({ res }) => sendJson(res, 200, await ticketsPayload(setup, checks, queue)) },
    // api/stream is the change feed's (src/dashboard-changes.ts openStream); startDashboard's handle sends it there.
    { pattern: 'api/stats', handler: ({ res, query }) => statsView(res, query) },
    // The health checks' last result.
    { pattern: 'api/health', when: (query) => health !== undefined && noQuery(query), handler: ({ res }) => sendJson(res, 200, health!.list()) },
    // The coordinator's state (src/coordinator.ts), which only sf coordinator writes.
    { pattern: 'api/coordinator', when: noQuery, handler: async ({ res }) => sendJson(res, 200, await readCoordinator(ctx.stateDir)) },
    // A workspace's vision page (src/vision.ts), which only sf vision writes: user content, under
    // its own policy (an opaque origin that loads nothing); the security headers set before stay.
    { pattern: 'vision/*', when: noQuery, handler: ({ res, params: [workspace] }) => visionRead(res, workspace!) },
    // The installed skills, the agent roles' choice and the coordinator's (sf skills; without the
    // coordinator checkout's path), and one skill's SKILL.md, read from the skills' source folder (a
    // name that is not an installed skill's is refused).
    { pattern: 'api/skills', when: noQuery, handler: async ({ res }) => sendJson(res, 200, skillsForClients(await skillsView(ctx.stateDir))) },
    { pattern: 'api/skills/*', when: noQuery, handler: ({ res, params: [name] }) => hostRead(res, skillText(name!)) },
    // The dashboard's pins (src/pins.ts), every one in id order; an unreadable pins.json is refused
    // (pins_unreadable) as the writes refuse it.
    { pattern: 'api/pins', when: noQuery, handler: ({ res }) => hostRead(res, readPins(ctx.stateDir)) },
    // The morning digest: the list, newest first, and one stored record.
    { pattern: 'api/digests', when: (query) => digests !== undefined && noQuery(query), handler: async ({ res }) => sendJson(res, 200, await digests!.list()) },
    { pattern: 'api/digests/*', when: (query) => digests !== undefined && noQuery(query), handler: ({ res, params: [id] }) => digestRecord(res, id!) },
    { pattern: 'api/tickets/*/*/page', handler: ({ res, params, query }) => ticketPage(res, params, query) },
    { pattern: 'api/tickets/*/*/task', handler: ({ res, params, query }) => taskText(res, params, query) },
    { pattern: 'api/tickets/*/*/planner', when: (query) => planner !== undefined && noQuery(query), handler: ({ res, params }) => plannerRead(res, params) },
    { pattern: 'api/tickets/*/*/attachments/*', handler: ({ res, params, query }) => attachmentFile(res, params, query) },
    { pattern: 'api/jobs/*/*', handler: jobRead(jobView) },
    { pattern: 'api/jobs/*/*/stream', handler: jobRead(streamView) },
    { pattern: 'api/jobs/*/*/mr', handler: jobRead(mrText) },
    // The Merge request screen.
    { pattern: 'api/jobs/*/*/mr-view', when: noQuery, handler: jobRead(mrView) },
    { pattern: 'api/jobs/*/*/changes', handler: jobRead(({ res, query }, job) => sendFound(res, changesOf(job, query))) },
    { pattern: 'api/jobs/*/*/file', handler: jobRead(({ res, query }, job) => sendFound(res, fileOf(job, query))) },
    { pattern: 'api/jobs/*/*/iterations/*/report', handler: jobRead((get, job) => iterationFile(get, job, 'report')) },
    { pattern: 'api/jobs/*/*/iterations/*/patch', handler: jobRead((get, job) => iterationFile(get, job, 'patch')) },
    // A workspace's merge requests on its Git host, read when asked; a refusal as refuseRead says.
    { pattern: 'api/workspaces/*/merge-requests', when: noQuery, handler: ({ res, params }) => hostRead(res, openMergeRequestsRead(actions, params)) },
    { pattern: 'api/workspaces/*/merge-requests/*/threads', when: noQuery, handler: ({ res, params }) => hostRead(res, mergeRequestThreadsRead(actions, params)) },
    { pattern: 'api/workspaces/*/merge-requests/*/overview', when: noQuery, handler: ({ res, params }) => hostRead(res, mergeRequestOverviewRead(actions, params)) },
  ];

  async function visionRead(res: ServerResponse, workspace: string): Promise<void> {
    const page = await readVisionPage(ctx.stateDir, workspace);
    if (page === undefined) {
      empty(res, 404);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': VISION_PAGE_CSP }).end(page);
  }

  async function hostRead(res: ServerResponse, found: Promise<unknown>): Promise<void> {
    try {
      await sendFound(res, found);
    } catch (error) {
      refuseRead(res, error);
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string[], query: URLSearchParams, remote: boolean): Promise<void> {
    for (const { pattern, when, handler } of getRoutes) {
      const params = matchPath(pattern, path);
      if (params !== undefined && (when === undefined || when(query))) {
        await handler({ req, res, query, remote, params });
        return;
      }
    }
    empty(res, 404);
  }

  // A job route's handler: the job of the path's first two segments, or an empty 404.
  function jobRead(handler: (get: GetRequest, job: Job, key: [string, string]) => Promise<void>): GetRoute['handler'] {
    return async (get) => {
      const key = jobKey(get.params[0], get.params[1]);
      const job = key === undefined ? undefined : await jobs.read(...key);
      if (key === undefined || job === undefined) {
        empty(get.res, 404);
        return;
      }
      await handler(get, job, key);
    };
  }

  // JSON of what was found, or an empty 404.
  async function sendFound(res: ServerResponse, found: Promise<unknown>): Promise<void> {
    const data = await found;
    if (data === undefined) {
      empty(res, 404);
      return;
    }
    sendJson(res, 200, data);
  }

  // GET api/digests/<id>: one stored digest, or an empty 404.
  async function digestRecord(res: ServerResponse, id: string): Promise<void> {
    await sendFound(res, digests!.read(id));
  }

  // GET api/jobs/<ws>/<ticket>: the job's detail. A handed-over job: origin is asked for
  // the user's push, without waiting and at most once a minute; a push found reaches the page
  // through the job's events.
  async function jobView({ res }: GetRequest, job: Job): Promise<void> {
    if (job.state === 'handed_over') {
      void actions.checkHandedOver(job.workspace, job.ticket, PUSH_CHECK_INTERVAL_MS).catch((error: unknown) => console.error(error));
    }
    sendJson(res, 200, await jobDetail(jobs, job, gateOn, actions, setup));
  }

  // GET api/jobs/<ws>/<ticket>/stream?from=<line>: a page of the job's Stream (streamPage).
  async function streamView({ res, query }: GetRequest, _job: Job, key: [string, string]): Promise<void> {
    const from = query.get('from') ?? '0';
    if (!/^\d{1,9}$/.test(from)) {
      empty(res, 404);
      return;
    }
    sendJson(res, 200, await streamPage(...key, Number(from)));
  }

  // GET api/jobs/<ws>/<ticket>/mr: the MR text as Markdown, or an empty 404 without one.
  async function mrText({ res }: GetRequest, _job: Job, key: [string, string]): Promise<void> {
    const text = await jobs.readMrText(...key);
    if (text === undefined) {
      empty(res, 404);
      return;
    }
    body(res, 'text/markdown; charset=utf-8', text);
  }

  // GET api/jobs/<ws>/<ticket>/mr-view: the Merge request screen's payload; an empty 404 without
  // MR text.
  async function mrView({ res }: GetRequest, _job: Job, key: [string, string]): Promise<void> {
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
    sendJson(res, 200, view);
  }

  // GET api/jobs/<ws>/<ticket>/iterations/<N>/report|patch: a published iteration's Report or Patch.
  async function iterationFile({ res, params }: GetRequest, job: Job, which: 'report' | 'patch'): Promise<void> {
    const number = iterationParam(params[2]);
    if (number === undefined || number > job.iteration) {
      empty(res, 404);
      return;
    }
    const iteration = await jobs.readIteration(job.workspace, job.ticket, number);
    if (which === 'report') {
      body(res, 'text/markdown; charset=utf-8', iteration.report);
    } else {
      body(res, 'text/x-diff; charset=utf-8', iteration.patch);
    }
  }

  // GET api/stats?days=7|30|90[&workspace=<name>]: the Stats page's payload. Any other
  // key or value or a repeated key is an empty 404.
  async function statsView(res: ServerResponse, query: URLSearchParams): Promise<void> {
    const keys = [...query.keys()];
    const days = STATS_DAYS.find((value) => String(value) === query.get('days'));
    const workspace = query.get('workspace');
    if (days === undefined || new Set(keys).size !== keys.length || keys.some((key) => key !== 'days' && key !== 'workspace')
      || (workspace !== null && !WORKSPACE_NAME_PATTERN.test(workspace))) {
      empty(res, 404);
      return;
    }
    sendJson(res, 200, await stats.compute({ days: days satisfies StatsDays, workspace }));
  }

  // GET api/jobs/<ws>/<ticket>/changes: the base and the published iterations; with
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

  // GET api/jobs/<ws>/<ticket>/file?at=base|<N>&path=<path> (&of=<N> with at=base, the
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

  // GET api/jobs/<ws>/<ticket>/stream?from=<line>: the entries of at most STREAM_PAGE_LINES
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

  // GET api/tickets/<ws>/<ticket>/page: the planned ticket page in one payload: the tickets
  // row with its conversation, the Task file and its sha256 (the version a Save starts from), the
  // plan in plain words, the last check (null without the Task checks), the plan-check rounds of
  // every version (check_rounds, failed ones included; check_usd, the sum of the known costs;
  // check_usd_complete, false when a cost is unknown; all-time), the history, newest first,
  // queue, always null, and the planner session's view (null when none runs or without the
  // planner). A ticket that is not in the tickets list is an empty 404.
  async function ticketPage(res: ServerResponse, [workspace, ticket]: string[], query: URLSearchParams): Promise<void> {
    const key = jobKey(workspace, ticket);
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
    let plannerSession = null;
    if (planner !== undefined) {
      try {
        plannerSession = plannerSessionView(await planner.session(...key));
      } catch (error) {
        console.error(error);
      }
    }
    sendJson(res, 200, {
      ticket: await ticketEntry(row, checks),
      task: { text: file.text, sha256: file.sha256 },
      plan: planOf(file.text, row),
      check,
      check_rounds: records.length,
      check_usd: records.reduce((total, record) => total + (record.cost_usd ?? 0), 0),
      check_usd_complete: records.every((record) => record.cost_usd !== null),
      history: await history.timeline(...key, { sha256: file.sha256, mtime: file.mtime }),
      queue: null,
      planner_session: plannerSession,
    });
  }

  // The ticket's planner session as it runs now: {session: its view, or null}, read through
  // DashboardPlanner.session, which removes the record of one that ended; names that are not a
  // workspace's and a ticket's are an empty 404.
  async function plannerRead(res: ServerResponse, [workspace, ticket]: string[]): Promise<void> {
    const key = jobKey(workspace, ticket);
    if (key === undefined) {
      empty(res, 404);
      return;
    }
    sendJson(res, 200, { session: plannerSessionView(await planner!.session(...key)) });
  }

  // GET api/tickets/<ws>/<ticket>/task[?archived=1]: the Task file through the Task file reader,
  // as text/markdown. A missing ticket, workspace or file is an empty 404, as for the other reads;
  // a file the reader refuses (not a Task file, not a regular file) answers its refusal.
  async function taskText(res: ServerResponse, [workspace, ticket]: string[], query: URLSearchParams): Promise<void> {
    const key = jobKey(workspace, ticket);
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

  // GET api/tickets/<ws>/<ticket>/attachments/<name>: one image of the ticket with the
  // type told by its bytes and nosniff. A missing ticket, workspace, Task file or image is an empty
  // 404; anything the attachments module refuses answers its refusal.
  async function attachmentFile(res: ServerResponse, [workspace, ticket, name]: string[], query: URLSearchParams): Promise<void> {
    const key = jobKey(workspace, ticket);
    if (key === undefined || [...query.keys()].length > 0) {
      empty(res, 404);
      return;
    }
    let image;
    try {
      image = await setup.readAttachment(...key, name!);
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

  // GET api/tickets/<ws>/<ticket>/check: the ticket's last check as JSON, with whether it
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
      if (error instanceof FactoryError && statusOf(error.code) === 404) {
        empty(res, 404);
        return;
      }
      throw error;
    }
    if (view.current_sha256 === null && view.check === null) {
      empty(res, 404);
      return;
    }
    sendJson(res, 200, view);
  }

  return { route, checkView };
}
