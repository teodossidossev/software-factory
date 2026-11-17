// The dashboard's change feed: one server-sent event stream per open page (openStream), which
// gets the health checks, the jobs, the start screen's data and, for a page that follows a job,
// its detail and the lines of its Stream; and what the open pages are told after a change
// (changed, jobChanged), merged within one tick and sent by one flush. Its queue state lives in
// changeFeed's closure, one per dashboard; the open streams are the context's.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Change, type ChangeFeed, type DashboardContext, jobKey, type Marked, mergeChange, type Stream, type TicketKey } from './dashboard-context.js';
import { jobDetail, jobsPayload, ticketsPayload, workspacesPayload } from './dashboard-payloads.js';
import { FactoryError } from './errors.js';
import { lineEntries, streamContext } from './job-stream.js';
import { describeEvent, followLines } from './watch.js';

// The open event streams at most; one more is answered 503. A comment every KEEP_ALIVE_MS keeps
// each open.
export const MAX_STREAMS = 8;
const KEEP_ALIVE_MS = 15_000;

// A change with one more kind than Change's: coordinator, the coordinator's state changed (an sf
// coordinator write, or a request for a status that POST api/coordinator/request opened;
// src/coordinator.ts); every page gets a coordinator event, on which its Coordinator card reads
// GET api/coordinator again. The event carries no state of its own.
export type FeedChange = Change & { coordinator?: true };
export interface DashboardFeed extends ChangeFeed {
  changed(change: FeedChange): void;
}

export function changeFeed(ctx: DashboardContext): DashboardFeed {
  const { jobs, actions, setup, checks, queue, health, gateOn, toolCalls, streams, send, empty, jobsOf } = ctx;

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
    // The health checks first: the light is right from the connect on.
    if (health !== undefined) {
      send(stream, 'health', health.list());
    }
    send(stream, 'jobs', await jobsOf(remote));
    // The Coordinator card reads its state once on connect, then after each change.
    send(stream, 'coordinator', {});
    // The start screen's data: on connect whole, later after each change (changed).
    send(stream, 'workspaces', await workspacesPayload(setup, ctx.stateDir));
    send(stream, 'tickets', await ticketsPayload(setup, checks, queue));
    if (key === undefined) {
      return;
    }
    const job = await jobs.read(...key);
    if (job !== undefined) {
      send(stream, 'job', await jobDetail(jobs, job, gateOn, actions, setup));
    }
    const start = Number(from);
    const [workspaceName, ticketName] = key;
    // The job's Stream: each line's entries, built asynchronously but sent strictly in
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

  // What the open pages are told after a change: the kinds marked by the calls of changed within
  // one tick, merged (keys unioned, 'all' wins over keys), and sent by one flush. A change that
  // arrives while a flush builds or sends is marked again and sent by one more flush right after.
  let marked: Marked | undefined;
  let coordinatorMarked = false;
  let flushQueued = false;
  let flushing = false;
  const queueFlush = (): void => {
    if (!flushQueued && !flushing && marked !== undefined) {
      flushQueued = true;
      setImmediate(() => void flush());
    }
  };
  function changed(change: FeedChange): void {
    marked = mergeChange(marked, change);
    coordinatorMarked ||= change.coordinator === true;
    queueFlush();
  }
  async function flush(): Promise<void> {
    flushQueued = false;
    const change = marked;
    const coordinator = coordinatorMarked;
    marked = undefined;
    coordinatorMarked = false;
    if (change === undefined || streams.size === 0) {
      return;
    }
    flushing = true;
    try {
      await sendChange(change, coordinator);
    } catch (error) {
      console.error(error);
    } finally {
      flushing = false;
      queueFlush();
    }
  }

  // Each marked payload built once and sent: jobs to every page, a changed job's detail to the
  // pages that follow it (one job event per job), workspaces and tickets to every page; tickets
  // with changed, the tickets it names, unless every ticket was marked; coordinator to every page.
  async function sendChange(change: Marked, coordinator: boolean): Promise<void> {
    const list = change.jobs ? await jobsPayload(jobs, setup, actions, toolCalls) : undefined;
    const details = [];
    for (const [workspace, ticket] of change.job.values()) {
      const followers = [...streams].filter((stream) => stream.job?.[0] === workspace && stream.job[1] === ticket);
      const job = followers.length > 0 ? await jobs.read(workspace, ticket) : undefined;
      if (job !== undefined) {
        details.push({ followers, detail: await jobDetail(jobs, job, gateOn, actions, setup) });
      }
    }
    const workspaces = change.workspaces ? await workspacesPayload(setup, ctx.stateDir) : undefined;
    const tickets = change.tickets === undefined ? undefined : {
      ...(await ticketsPayload(setup, checks, queue)),
      ...(change.tickets === 'all' ? {} : { changed: [...change.tickets.values()].map(([workspace, ticket]) => ({ workspace, ticket })) }),
    };
    for (const stream of streams) {
      if (list !== undefined) {
        send(stream, 'jobs', { ...list, remote: stream.remote });
      }
      for (const { followers, detail } of details) {
        if (followers.includes(stream)) {
          send(stream, 'job', detail);
        }
      }
      if (workspaces !== undefined) {
        send(stream, 'workspaces', workspaces);
      }
      if (tickets !== undefined) {
        send(stream, 'tickets', tickets);
      }
      if (coordinator) {
        send(stream, 'coordinator', {});
      }
    }
  }

  // A job's change: the jobs, the job, the setup data (a job that starts or ends changes the
  // tickets and the live counts), its ticket; a job that is gone changes every ticket (a page
  // following an archived job sees it gone from the list).
  async function jobChanged(key: TicketKey): Promise<void> {
    const job = await jobs.read(...key);
    changed(job !== undefined ? { jobs: true, job: key, workspaces: true, tickets: [key] } : { jobs: true, workspaces: true, tickets: 'all' });
  }

  return { openStream, changed, jobChanged };
}
