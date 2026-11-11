// The dashboard's posts: the User's actions as POST endpoints, each validated and dispatched as
// the one call it stands for: the job and queue actions of POST_ROUTES (src/dashboard-routes.ts,
// routePost), the setup actions (setupPost), the Task check's start (checkPost), the planned
// ticket page's Save (taskPost) and a ticket's images (attachmentAddPost, attachmentRemovePost);
// handlePost runs the transport checks, the call, and tells the open pages through the change
// feed. Nothing here changes a job by itself.
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as z from 'zod/v4';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';
import type { DashboardSetup } from './dashboard.js';
import { type ChangeFeed, type DashboardContext, isJsonContentType, isOctetStream, jobKey, type Post, readBody, type Target } from './dashboard-context.js';
import { type JobKey, type JobRoute, openWhileUpdating, type PostRoute, type QueueRoute } from './dashboard-routes.js';
import { FactoryError } from './errors.js';
import { internalError, sendJson, statusOf } from './http.js';
import { HANDOFF_MODES, WORKSPACE_COLORS, WORKSPACE_NAME_PATTERN } from './registry.js';
import { REVIEW_JOB_SHAPE, reviewJobCall } from './review-job.js';
import { MAX_TASK_BYTES } from './task-file.js';
import { refuseWhileUpdating } from './update.js';

// The raw body of an action request, in bytes: a transport bound, not a lifecycle rule.
export const MAX_ACTION_BODY_BYTES = 128 * 1024;
// The raw body of the planned ticket page's Save: a whole Task file as a JSON string, whose
// escapes can take up to twice its bytes; the content's own size is checked by the Task file writer.
// A file of mostly non-ASCII or control characters can need more and is written with write_task.
export const MAX_TASK_BODY_BYTES = 2 * MAX_TASK_BYTES + 1024;

// The request body of each setup, Task check, task and attachment POST, strict: unknown keys, null,
// arrays and wrong types are refused; shape is what the refusal names. The job and queue actions
// have theirs in POST_ROUTES (src/dashboard-routes.ts).
const BODIES = {
  'workspace-add': {
    shape: `{"name": string, "path": string, "handoff"?: "checkout" | "off", "color"?: ${WORKSPACE_COLORS.map((color) => `"${color}"`).join(' | ')}, "description"?: string, "app"?: string, "digest"?: {"track": boolean, "my_work": boolean}}`,
    schema: z.strictObject({
      name: z.string(), path: z.string(), handoff: z.enum(HANDOFF_MODES).optional(), color: z.enum(WORKSPACE_COLORS).optional(),
      description: z.string().optional(), app: z.string().optional(), digest: z.strictObject({ track: z.boolean(), my_work: z.boolean() }).optional(),
    }),
  },
  // Edit of a workspace: every field of the form; "" removes description and app,
  // "default" the handoff, "auto" the color.
  'workspace-edit': {
    shape: `{"path": string, "description": string, "app": string, "handoff": "default" | "checkout" | "off", "color": "auto" | ${WORKSPACE_COLORS.map((color) => `"${color}"`).join(' | ')}, "digest": {"track": boolean, "my_work": boolean}}`,
    schema: z.strictObject({
      path: z.string(), description: z.string(), app: z.string(), handoff: z.enum(['default', ...HANDOFF_MODES]), color: z.enum(['auto', ...WORKSPACE_COLORS]),
      digest: z.strictObject({ track: z.boolean(), my_work: z.boolean() }),
    }),
  },
  // The Morning digest section of the Setup.
  'digest-settings': {
    shape: '{"at": "HH:MM", "weekdays_only": boolean, "language": string}',
    schema: z.strictObject({ at: z.string(), weekdays_only: z.boolean(), language: z.string() }),
  },
  // Generate now on the Digest page.
  'digest-run': { shape: '{}', schema: z.strictObject({}) },
  'workspace-remove': { shape: '{}', schema: z.strictObject({}) },
  'ticket-archive': { shape: '{}', schema: z.strictObject({}) },
  'ticket-restore': { shape: '{}', schema: z.strictObject({}) },
  'ticket-delete': { shape: '{}', schema: z.strictObject({}) },
  'ticket-start': { shape: '{}', schema: z.strictObject({}) },
  'ticket-check': { shape: '{}', schema: z.strictObject({}) },
  // Save of the planned ticket page: the whole Task file and the sha256 of the version read.
  'ticket-task': { shape: '{"content": string, "sha256": string}', schema: z.strictObject({ content: z.string(), sha256: z.string() }) },
  // A ticket's images: the upload's body is the image's raw bytes (Content-Type:
  // application/octet-stream), not JSON; removing one takes {}.
  'ticket-attachment-add': { shape: 'the image\'s bytes', schema: z.instanceof(Buffer) },
  'ticket-attachment-remove': { shape: '{}', schema: z.strictObject({}) },
  'ticket-new': { shape: '{"workspace": string, "ticket": string, "title": string, "request": string}', schema: z.strictObject({ workspace: z.string(), ticket: z.string(), title: z.string(), request: z.string() }) },
};
type SetupRoute = keyof typeof BODIES;
// A setup POST's route and the body as its refusal names it.
const setupBody = (route: SetupRoute): { route: SetupRoute; shape: string } => ({ route, shape: BODIES[route].shape });

// The posts' handlers, each a Post for handle in startDashboard or undefined (an empty 404).
export function postHandlers(ctx: DashboardContext, feed: Pick<ChangeFeed, 'changed' | 'jobChanged'>) {
  const { stateDir, remoteOrigins, onWorkspacesChanged, jobs, actions, setup, checks, queue, digests, empty } = ctx;
  // The workspace change succeeded: the hook hears of it (a failing hook is logged).
  const workspacesChanged = <T>(result: T): T => {
    try {
      onWorkspacesChanged?.();
    } catch (error) {
      console.error(error);
    }
    return result;
  };

  // POST api/tickets/<ws>/<ticket>/check: starts a check and answers at once; its end reaches every
  // page through refreshSetup.
  function checkPost(key: [string, string]): Post | undefined {
    if (checks === undefined) {
      return undefined;
    }
    const run = (): Promise<unknown> => checks.start(...key);
    return { ...setupBody('ticket-check'), call: (data) => (BODIES['ticket-check'].schema.safeParse(data).success ? run : undefined), refreshSetup: true };
  }

  // A job or queue action of POST_ROUTES as the one call it stands for, its body checked by
  // the route's schema only. A job's action gets the job (key), which is looked up first; a queue's
  // needs the run queue (none without it: an empty 404).
  function routePost(name: string, route: JobRoute, key: JobKey): Post;
  function routePost(name: string, route: QueueRoute): Post | undefined;
  function routePost(name: string, route: PostRoute, key?: JobKey): Post | undefined {
    let run: (body: unknown) => Promise<unknown>;
    if (route.kind === 'job') {
      if (key === undefined) {
        return undefined;
      }
      run = (body) => route.call(actions, queue, key, body);
    } else {
      const runQueue = queue;
      if (runQueue === undefined) {
        return undefined;
      }
      run = (body) => route.call(actions, runQueue, undefined, body);
    }
    const { body, shape, bodyLimit, refresh } = route;
    return {
      route: name, shape, openWhileUpdating: openWhileUpdating(route), bodyLimit,
      exists: key === undefined ? undefined : async () => (await jobs.read(...key)) !== undefined,
      confirm: route.confirm === true ? key?.[1] : undefined,
      refreshJob: refresh === 'job' ? key : undefined, refreshJobs: refresh === 'jobs', refreshSetup: refresh === 'setup',
      call: (data) => {
        const parsed = body.safeParse(data);
        return parsed.success ? () => run(parsed.data) : undefined;
      },
    };
  }

  // POST api/tickets/<ws>/<ticket>/task: Save of the planned ticket page, through
  // Setup.saveTask; the new version (and the check it made stale) reaches every page. With the run
  // queue, under its lock of the ticket: never between its last look at the plan and the
  // start.
  function taskPost([workspace, ticket]: [string, string]): Post {
    return {
      ...setupBody('ticket-task'),
      bodyLimit: MAX_TASK_BODY_BYTES,
      call: (data) => {
        const parsed = BODIES['ticket-task'].schema.safeParse(data);
        if (!parsed.success) {
          return undefined;
        }
        const save = (): ReturnType<DashboardSetup['saveTask']> => setup.saveTask(workspace, ticket, parsed.data.content, parsed.data.sha256);
        return () => (queue === undefined ? save() : queue.withTicket(workspace, ticket, save));
      },
      refreshSetup: true,
    };
  }

  // POST api/tickets/<ws>/<ticket>/attachments[?name=<name>]: one image as raw bytes, at
  // most MAX_ATTACHMENT_BYTES; the next number when name is left out. The ticket's new images reach
  // every page (its row, its conversation).
  function attachmentAddPost([workspace, ticket]: [string, string], name: string | undefined): Post {
    return {
      ...setupBody('ticket-attachment-add'),
      bytes: true,
      bodyLimit: MAX_ATTACHMENT_BYTES,
      call: (data) => (data instanceof Buffer ? () => setup.addAttachment(workspace, ticket, data, name) : undefined),
      refreshSetup: true,
    };
  }

  // POST api/tickets/<ws>/<ticket>/attachments/<name>/remove with {}.
  function attachmentRemovePost([workspace, ticket]: [string, string], name: string): Post {
    return {
      ...setupBody('ticket-attachment-remove'),
      call: (data) => (BODIES['ticket-attachment-remove'].schema.safeParse(data).success ? () => setup.removeAttachment(workspace, ticket, name) : undefined),
      refreshSetup: true,
    };
  }

  function setupPost(target: Exclude<Target, { kind: 'read' | 'action' | 'ticket-check' | 'ticket-task' | 'queue' | 'ticket-attachment-add' | 'ticket-attachment-remove' }>): Post | undefined {
    if (target.kind === 'workspace-edit') {
      const name = target.name;
      if (name === undefined || !WORKSPACE_NAME_PATTERN.test(name)) {
        return undefined;
      }
      return {
        ...setupBody('workspace-edit'),
        call: (data) => {
          const parsed = BODIES['workspace-edit'].schema.safeParse(data);
          return parsed.success ? () => setup.editWorkspace(name, parsed.data).then(workspacesChanged) : undefined;
        },
        refreshSetup: true,
      };
    }
    if (target.kind === 'digest-settings') {
      return {
        ...setupBody('digest-settings'),
        call: (data) => {
          const parsed = BODIES['digest-settings'].schema.safeParse(data);
          return parsed.success ? () => setup.saveDigestSettings(parsed.data) : undefined;
        },
        refreshSetup: true,
      };
    }
    if (target.kind === 'mr-job') {
      // src/review-job.ts: the new ticket, queued, reaches every page; nothing without the run queue.
      const call = queue === undefined ? undefined : reviewJobCall({ reads: actions, jobs, queue }, target.workspace, target.number);
      return call === undefined ? undefined : { route: 'mr-job', shape: REVIEW_JOB_SHAPE, call, refreshSetup: true };
    }
    if (target.kind === 'digest-run') {
      const run = digests;
      if (run === undefined) {
        return undefined;
      }
      return { ...setupBody('digest-run'), call: (data) => (BODIES['digest-run'].schema.safeParse(data).success ? async () => run.start('manual') : undefined) };
    }
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
        return { ...setupBody('ticket-start'), call: (data) => (BODIES['ticket-start'].schema.safeParse(data).success ? run : undefined), refreshJobs: true };
      }
      const route = `ticket-${target.action}` as const;
      const methods = { archive: setup.archiveTicket, restore: setup.restoreTicket, delete: setup.deleteTicket };
      const method = methods[target.action].bind(setup);
      return { ...setupBody(route), call: (data) => (BODIES[route].schema.safeParse(data).success ? () => method(workspace, ticket) : undefined), refreshSetup: true, refreshJobs: target.action !== 'restore' };
    }
    if (target.kind === 'workspace-remove') {
      const name = target.name;
      if (name === undefined || !WORKSPACE_NAME_PATTERN.test(name)) {
        return undefined;
      }
      return { ...setupBody('workspace-remove'), call: (data) => (BODIES['workspace-remove'].schema.safeParse(data).success ? () => setup.removeWorkspace(name).then(workspacesChanged) : undefined), refreshSetup: true };
    }
    if (target.route === 'workspace-add') {
      return {
        ...setupBody('workspace-add'),
        call: (data) => {
          const parsed = BODIES['workspace-add'].schema.safeParse(data);
          if (!parsed.success) {
            return undefined;
          }
          const { name, path, ...options } = parsed.data;
          return () => setup.addWorkspace(name, path, options).then(workspacesChanged);
        },
        refreshSetup: true,
      };
    }
    return {
      ...setupBody('ticket-new'),
      call: (data) => {
        const parsed = BODIES['ticket-new'].schema.safeParse(data);
        return parsed.success ? () => setup.createTicket(parsed.data) : undefined;
      },
      refreshSetup: true,
    };
  }

  // A POST: the transport checks, then one call. A page that goes away while the call runs stops
  // waiting; the call itself goes on and settles here.
  async function handlePost(req: IncomingMessage, res: ServerResponse, post: Post, remote: boolean): Promise<void> {
    let gone = false;
    res.once('close', () => {
      gone = true;
    });
    const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}): void => {
      sendJson(res, status, { ok: false, error: { code, message } }, headers);
    };
    // The page's exact origin: the local one on the local port, a listed one on the remote port.
    if (remote ? req.headers.origin === undefined || !remoteOrigins.includes(req.headers.origin) : req.headers.origin !== ctx.origin) {
      fail(403, 'invalid_origin', `Actions need the Origin ${remote ? remoteOrigins.join(' or ') : ctx.origin}.`);
      return;
    }
    // The updating marker's gate, before anything is read or changed.
    if (post.openWhileUpdating !== true) {
      try {
        refuseWhileUpdating(stateDir);
      } catch (error) {
        const refusal = error as FactoryError;
        fail(statusOf(refusal.code, 409), refusal.code, refusal.message);
        return;
      }
    }
    if (post.bytes === true ? !isOctetStream(req.headers['content-type']) : !isJsonContentType(req.headers['content-type'])) {
      fail(415, 'unsupported_media_type', post.bytes === true ? 'An image upload needs Content-Type: application/octet-stream.' : 'Actions need Content-Type: application/json.');
      return;
    }
    if (post.exists !== undefined && !(await post.exists())) {
      empty(res, 404);
      return;
    }
    const limit = post.bodyLimit ?? MAX_ACTION_BODY_BYTES;
    const raw = await readBody(req, limit);
    if (raw === 'interrupted') {
      return;
    }
    if (raw === 'too_large') {
      if (post.bytes === true) {
        fail(413, 'attachment_too_large', `An image must be at most ${limit} bytes (5 MB).`, { connection: 'close' });
      } else {
        fail(413, 'body_too_large', `The body must be at most ${limit} bytes.`, { connection: 'close' });
      }
      return;
    }
    let data: unknown = raw;
    if (post.bytes !== true) {
      try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      } catch { // not UTF-8 JSON: answered 400 invalid_json
        fail(400, 'invalid_json', 'The body must be UTF-8 JSON.');
        return;
      }
    }
    const run = post.call(data);
    if (run === undefined) {
      fail(400, 'invalid_body', `${post.route} expects ${post.shape}; no other keys, no null.`);
      return;
    }
    // The second confirmation from another device: the job's ticket, typed by the user.
    if (remote && post.confirm !== undefined && (data as { confirm?: unknown }).confirm !== post.confirm) {
      fail(409, 'confirm_required', `From another device, ${post.route} needs "confirm": the job's ticket (${post.confirm}).`);
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
        fail(statusOf(error.code), error.code, error.message);
        return;
      }
      console.error(error);
      const failure = internalError();
      fail(500, failure.code, failure.message);
      return;
    }
    if (post.refreshJob !== undefined) {
      feed.jobChanged(post.refreshJob).catch((error: unknown) => console.error(error));
    } else if (post.refreshJobs === true) {
      feed.changed({ jobs: true, workspaces: true, tickets: 'all' });
    } else if (post.refreshSetup === true) {
      feed.changed({ workspaces: true, tickets: 'all' });
    }
    if (gone) {
      return;
    }
    sendJson(res, 200, { ok: true, result });
  }

  return { checkPost, routePost, taskPost, attachmentAddPost, attachmentRemovePost, setupPost, handlePost };
}
