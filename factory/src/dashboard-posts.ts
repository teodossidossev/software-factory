// The dashboard's posts: the User's actions as POST endpoints, each validated and dispatched as
// the one call it stands for: the job and queue actions of POST_ROUTES (src/dashboard-routes.ts,
// routePost), the setup actions (setupPost), the Task check's start (checkPost), the planned
// ticket page's Save (taskPost), a ticket's images (attachmentAddPost, attachmentRemovePost), a
// ticket's planner session (plannerPost), the pins, a request for the coordinator's status and New
// ticket's issue read (through setupPost) and an agent role's skills (skillRolesPost, the one
// PUT); handlePost runs the transport checks, the call, and tells the open pages through the
// change feed. Nothing here changes a job by itself.
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as z from 'zod/v4';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';
import { TICKET_OWNERS } from './conversation.js';
import { requestStatus } from './coordinator.js';
import type { DashboardSetup } from './dashboard.js';
import type { DashboardFeed } from './dashboard-changes.js';
import { type DashboardContext, isJsonContentType, isOctetStream, jobKey, plannerSessionView, type Post, readBody, type Target } from './dashboard-context.js';
import { ticketEntry } from './dashboard-payloads.js';
import { type JobKey, type JobRoute, openWhileUpdating, type PostRoute, type QueueRoute } from './dashboard-routes.js';
import { FactoryError } from './errors.js';
import { internalError, sendJson, statusOf } from './http.js';
import { addPin, changePin, PIN_CHANGE, PIN_CHANGE_SHAPE, PIN_ID, PIN_INPUT, PIN_INPUT_SHAPE, PIN_REMOVE, pinIdOf, refusePinToken, removePin } from './pins.js';
import type { ResultStart } from './planner-session.js';
import { WAITING_STATES, waits } from './planner.js';
import { HANDOFF_MODES, WORKSPACE_COLORS, WORKSPACE_NAME_PATTERN } from './registry.js';
import { REVIEW_JOB_SHAPE, reviewJobCall } from './review-job.js';
import { setRoleSkills, skillsForClients } from './skills.js';
import { MAX_TASK_BYTES } from './task-file.js';
import { refuseWhileUpdating } from './update.js';

// The raw body of an action request, in bytes: a transport bound, not a lifecycle rule.
export const MAX_ACTION_BODY_BYTES = 128 * 1024;
// The bounds of PUT api/skills/roles/<role>'s list: its names, and a name's length.
const MAX_ROLE_SKILLS = 200;
const MAX_SKILL_NAME = 200;
// The raw body of the planned ticket page's Save: a whole Task file as a JSON string, whose
// escapes can take up to twice its bytes; the content's own size is checked by the Task file writer.
// A file of mostly non-ASCII or control characters can need more and is written with write_task.
export const MAX_TASK_BODY_BYTES = 2 * MAX_TASK_BYTES + 1024;

// The request body of each setup, Task check, task, attachment, planner and pin POST, strict: unknown keys, null,
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
  // Edit of a workspace: every field of the form; "" removes description, app and label,
  // "default" the handoff, "auto" the color; an absent label keeps the label.
  'workspace-edit': {
    shape: `{"path": string, "description": string, "app": string, "handoff": "default" | "checkout" | "off", "color": "auto" | ${WORKSPACE_COLORS.map((color) => `"${color}"`).join(' | ')}, "label"?: string, "digest": {"track": boolean, "my_work": boolean}}`,
    schema: z.strictObject({
      path: z.string(), description: z.string(), app: z.string(), handoff: z.enum(['default', ...HANDOFF_MODES]), color: z.enum(['auto', ...WORKSPACE_COLORS]),
      label: z.string().optional(),
      digest: z.strictObject({ track: z.boolean(), my_work: z.boolean() }),
    }),
  },
  // The Morning digest section of the Setup and the Digest page's schedule: the keys given change.
  'digest-settings': {
    shape: '{"times"?: ["HH:MM", ...], "weekdays_only"?: boolean, "language"?: string} with at least one key',
    schema: z.strictObject({ times: z.array(z.string()).optional(), weekdays_only: z.boolean().optional(), language: z.string().optional() })
      .refine((body) => Object.keys(body).length > 0),
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
  // New ticket: owner, who plans it, chatgpt when left out.
  'ticket-new': {
    shape: '{"workspace": string, "ticket": string, "title": string, "request": string, "owner"?: "chatgpt" | "claude_code"}',
    schema: z.strictObject({ workspace: z.string(), ticket: z.string(), title: z.string(), request: z.string(), owner: z.enum(TICKET_OWNERS).optional() }),
  },
  // The ticket page's switch of who plans the ticket.
  'ticket-owner': { shape: '{"owner": "chatgpt" | "claude_code"}', schema: z.strictObject({ owner: z.enum(TICKET_OWNERS) }) },
  // The ticket's planning chat link: a https://chatgpt.com/ URL or a https://claude.ai/code/<session>
  // link, or null to remove it.
  'ticket-chat': { shape: '{"url": string | null}', schema: z.strictObject({ url: z.string().nullable() }) },
  // The ticket's planner session: its start, its end and its start on the job's result take {}.
  'ticket-planner': { shape: '{}', schema: z.strictObject({}) },
  'ticket-planner-stop': { shape: '{}', schema: z.strictObject({}) },
  'ticket-planner-discuss': { shape: '{}', schema: z.strictObject({}) },
  // New ticket's issue read of the key in the path: {}.
  'ticket-import': { shape: '{}', schema: z.strictObject({}) },
  // The dashboard's pins (src/pins.ts, with their bounds): a new one, a change of one, a removal.
  'pin-add': { shape: PIN_INPUT_SHAPE, schema: PIN_INPUT },
  'pin-change': { shape: PIN_CHANGE_SHAPE, schema: PIN_CHANGE },
  'pin-remove': { shape: '{}', schema: PIN_REMOVE },
  // A click on Zen's screen on the Coordinator card: a request for the coordinator's status.
  'coordinator-request': { shape: '{}', schema: z.strictObject({}) },
};
type SetupRoute = keyof typeof BODIES;
// A setup POST's route and the body as its refusal names it.
const setupBody = (route: SetupRoute): { route: SetupRoute; shape: string } => ({ route, shape: BODIES[route].shape });

// The posts' handlers, each a Post for handle in startDashboard or undefined (an empty 404).
export function postHandlers(ctx: DashboardContext, feed: Pick<DashboardFeed, 'changed' | 'jobChanged'>) {
  const { stateDir, remoteOrigins, onWorkspacesChanged, jobs, actions, setup, checks, queue, digests, planner, issues, empty, tokenText } = ctx;
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

  // POST api/tickets/<ws>/<ticket>/planner: the ticket's planner session starts
  // (DashboardPlanner.start, sf planner start), only for a ticket of the tickets list (else an
  // empty 404 before the body is read); the answer comes once start has watched the new session:
  // {started, session}, started false with the session that runs already. POST
  // .../planner/stop (stop) ends it (DashboardPlanner.stop) for any ticket names: {stopped}, the
  // session it ended or null. POST .../planner/discuss (discuss), only for a ticket with a job
  // (else an empty 404 before the body is read): with the job read again, refused without one
  // (job_not_found) and for a job that does not wait for the User (invalid_state), else start on
  // the job's result at its iteration, answered as start. Every page gets the tickets again, so an
  // open ticket page reads its payload, with the session, again. None without the planner.
  function plannerPost([workspace, ticket]: [string, string], action: 'start' | 'stop' | 'discuss'): Post | undefined {
    if (planner === undefined) {
      return undefined;
    }
    const route = action === 'start' ? 'ticket-planner' : `ticket-planner-${action}` as const;
    const start = async (result?: ResultStart) => {
      const { started, session } = await planner.start(workspace, ticket, result);
      return { started, session: plannerSessionView(session) };
    };
    const runs = {
      start: () => start(),
      stop: async () => ({ stopped: plannerSessionView(await planner.stop(workspace, ticket)) }),
      discuss: async () => {
        const job = await jobs.read(workspace, ticket);
        if (job === undefined) {
          throw new FactoryError('job_not_found', `There is no job for ${workspace}/${ticket}.`);
        }
        if (!waits(job.state)) {
          const states = `${WAITING_STATES.slice(0, -1).join(', ')} or ${WAITING_STATES.at(-1)}`;
          throw new FactoryError('invalid_state', `The job is ${job.state}; Discuss the result needs a job that waits for the user: ${states}.`);
        }
        return start({ iteration: job.iteration });
      },
    };
    const exists = {
      start: async () => (await setup.tickets()).some((entry) => entry.workspace === workspace && entry.ticket === ticket),
      stop: undefined,
      discuss: async () => (await jobs.read(workspace, ticket)) !== undefined,
    };
    const run = runs[action];
    return {
      ...setupBody(route),
      exists: exists[action],
      call: (data) => (BODIES[route].schema.safeParse(data).success ? run : undefined),
      refreshSetup: true,
    };
  }

  // PUT api/skills/roles/<role>: the role's whole list of skills, checked as sf skills set checks a
  // skill (an unknown role, a skill not installed: refused with the list), written, and the snapshot synced.
  // coordinator: the skills on, written to its Claude Code settings file. The answer is the new view,
  // without the coordinator checkout's path.
  function skillRolesPost(role: string): Post {
    const body = z.strictObject({ skills: z.array(z.string().max(MAX_SKILL_NAME)).max(MAX_ROLE_SKILLS) });
    return {
      route: 'skill-roles', shape: '{"skills": [<skill name>, ...]}',
      call: (data) => {
        const parsed = body.safeParse(data);
        return parsed.success ? async () => skillsForClients(await setRoleSkills(stateDir, role, parsed.data.skills)) : undefined;
      },
    };
  }

  // POST api/pins: a new open pin (pin_holds_token for one with the dashboard's token in any of its
  // strings, before the store is read; too_many_pins past the open ones' bound); the answer is the
  // pin and every pin.
  function pinAddPost(): Post {
    return {
      ...setupBody('pin-add'),
      call: (data) => {
        const parsed = BODIES['pin-add'].schema.safeParse(data);
        return parsed.success
          ? () => {
            refusePinToken(parsed.data, tokenText);
            return addPin(stateDir, parsed.data);
          }
          : undefined;
      },
    };
  }

  // POST api/pins/<id> (its note, resolved or open again) and POST api/pins/<id>/remove; an id that
  // is not a whole number from 1 without a leading zero is an empty 404, an unknown one pin_not_found.
  // A note with the dashboard's token is pin_holds_token, before the id is looked up. The answer is
  // every pin.
  function pinPost(id: string, remove: boolean): Post | undefined {
    if (!PIN_ID.test(id)) {
      return undefined;
    }
    if (remove) {
      return { ...setupBody('pin-remove'), call: (data) => (BODIES['pin-remove'].schema.safeParse(data).success ? () => removePin(stateDir, pinIdOf(id)) : undefined) };
    }
    return {
      ...setupBody('pin-change'),
      call: (data) => {
        const parsed = BODIES['pin-change'].schema.safeParse(data);
        return parsed.success
          ? async () => {
            refusePinToken(parsed.data, tokenText);
            return changePin(stateDir, pinIdOf(id), parsed.data);
          }
          : undefined;
      },
    };
  }

  // POST api/coordinator/request with {}: a request for the coordinator's status (requestStatus,
  // src/coordinator.ts), answered {requested_at, opened}. Only a request it opened marks the feed's
  // coordinator kind, so every page reads api/coordinator again; one open already writes nothing.
  // Allowed from another device without confirm: it changes only a time.
  function coordinatorRequestPost(): Post {
    const run = async (): Promise<{ requested_at: string; opened: boolean }> => {
      const result = await requestStatus(stateDir);
      if (result.opened) {
        feed.changed({ coordinator: true });
      }
      return result;
    };
    return { ...setupBody('coordinator-request'), call: (data) => (BODIES['coordinator-request'].schema.safeParse(data).success ? run : undefined) };
  }

  function setupPost(target: Exclude<Target, { kind: 'read' | 'action' | 'ticket-check' | 'ticket-task' | 'queue' | 'ticket-attachment-add' | 'ticket-attachment-remove' | 'skill-roles' | 'ticket-planner' }>): Post | undefined {
    if (target.kind === 'coordinator-request') {
      return coordinatorRequestPost();
    }
    if (target.kind === 'pin') {
      return pinPost(target.id, target.remove);
    }
    if (target.kind === 'both' && target.route === 'pin-add') {
      return pinAddPost();
    }
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
    if (target.kind === 'ticket-import') {
      // POST api/tickets/<ws>/<ticket>/import with {}: the issue read of the ticket key
      // (DashboardIssues.import); its answer {ticket, title, request, images} fills the New
      // ticket form. Nothing is stored and no page is told; none without the issue read.
      const key = jobKey(target.workspace, target.ticket);
      const read = issues;
      if (key === undefined || read === undefined) {
        return undefined;
      }
      return { ...setupBody('ticket-import'), call: (data) => (BODIES['ticket-import'].schema.safeParse(data).success ? () => read.import(...key) : undefined) };
    }
    if (target.kind === 'ticket-owner') {
      // Setup.setTicketOwner: the names, a live job and a missing Task file refused as the other
      // ticket actions; the answer is the ticket's row with its new conversation, which every page gets.
      const key = jobKey(target.workspace, target.ticket);
      if (key === undefined) {
        return undefined;
      }
      return {
        ...setupBody('ticket-owner'),
        call: (data) => {
          const parsed = BODIES['ticket-owner'].schema.safeParse(data);
          return parsed.success ? async () => ticketEntry(await setup.setTicketOwner(...key, parsed.data.owner), checks) : undefined;
        },
        refreshSetup: true,
      };
    }
    if (target.kind === 'ticket-chat') {
      // Setup.setPlanningChat: the names and a missing Task file refused, a live job allowed, a link
      // that is neither a https://chatgpt.com/ one nor a https://claude.ai/code/<session> one refused
      // (invalid_chat_link); the ticket and the jobs reach every page again (the job's card and page
      // show the link).
      const key = jobKey(target.workspace, target.ticket);
      if (key === undefined) {
        return undefined;
      }
      return {
        ...setupBody('ticket-chat'),
        call: (data) => {
          const parsed = BODIES['ticket-chat'].schema.safeParse(data);
          return parsed.success ? () => setup.setPlanningChat(...key, parsed.data.url) : undefined;
        },
        refreshSetup: true,
        refreshJobs: true,
      };
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

  return { checkPost, routePost, taskPost, attachmentAddPost, attachmentRemovePost, plannerPost, setupPost, skillRolesPost, handlePost };
}
