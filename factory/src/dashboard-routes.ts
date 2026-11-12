// The dashboard's job and queue actions, in one table: POST api/jobs/<ws>/<ticket>/<name>
// and POST api/queue/<action> (the entry queue-<action>). For each, its body (strict: unknown keys,
// null, arrays and wrong types are refused; shape is what the refusal names), the one
// DashboardActions or DashboardQueue call it stands for, whether the remote port needs the job's
// ticket typed again, what the pages get again after it, its body bound and the socket
// command it mirrors (src/commands.ts), whose openWhileUpdating is its update gate. The
// dashboard (src/dashboard.ts) looks a POST up here; the job's detail sends the confirm routes to
// the page (confirm_actions). The setup, Task check, task and attachment posts have their own
// handlers there. Last, the two reads of a workspace's merge requests on its Git host (GET).
import * as z from 'zod/v4';
import { socketCommand } from './commands.js';
import type { DashboardActions, DashboardQueue } from './dashboard.js';
import { DECISIONS } from './ledger.js';
import { MAX_MR_TEXT_BYTES } from './mr.js';
import { WORKSPACE_NAME_PATTERN } from './registry.js';
import { MR_NUMBER } from './review-job.js';

// mr-save: an MR text of MAX_MR_TEXT_BYTES, every character JSON-escaped at worst.
export const MAX_MR_BODY_BYTES = 6 * MAX_MR_TEXT_BYTES + 1024;

export type JobKey = readonly [workspace: string, ticket: string];

interface RouteBase<S extends z.ZodType> {
  // The body as the invalid_body refusal names it.
  shape: string;
  body: S;
  // On the remote port the body's "confirm" must equal the job's ticket: the routes that
  // can push or merge.
  confirm?: true;
  // What the pages get again after a call that answered: the job (its record may change without a
  // state change: every page gets the jobs, and the pages that show the job its detail), the jobs
  // (the call may end a job, or replace it), or the setup data (the tickets with the run queue).
  // None: a state change reaches the pages by itself.
  refresh?: 'job' | 'jobs' | 'setup';
  // The raw body's bound in bytes; MAX_ACTION_BODY_BYTES by default.
  bodyLimit?: number;
  // The socket name of the commands.ts entry the route mirrors; none for a route of the dashboard
  // only, which stays closed while sf update drains or builds.
  command?: string;
}

// A job's action: the job is looked up first (a missing one is an empty 404).
export interface JobRoute<S extends z.ZodType = z.ZodType> extends RouteBase<S> {
  kind: 'job';
  call(actions: DashboardActions, queue: DashboardQueue | undefined, key: JobKey, body: z.infer<S>): Promise<unknown>;
}

// A change of the run queue; none without a run queue (an empty 404).
export interface QueueRoute<S extends z.ZodType = z.ZodType> extends RouteBase<S> {
  kind: 'queue';
  call(actions: DashboardActions, queue: DashboardQueue, key: undefined, body: z.infer<S>): Promise<unknown>;
}

export type PostRoute = JobRoute | QueueRoute;

const job = <S extends z.ZodType>(route: Omit<JobRoute<S>, 'kind'>): JobRoute<S> => ({ kind: 'job', ...route });
const queue = <S extends z.ZodType>(route: Omit<QueueRoute<S>, 'kind'>): QueueRoute<S> => ({ kind: 'queue', ...route, refresh: 'setup' });
const EMPTY = { shape: '{}', body: z.strictObject({}) };
// The routes that can push or merge, Merged another way and Archive take the ticket beside their
// other keys; the local port ignores it.
const CONFIRM = { confirm: z.string().optional() };

export const POST_ROUTES = {
  // The push of the prepared branch (sf approve).
  approve: job({
    shape: '{"as_is"?: boolean, "confirm"?: string}', body: z.strictObject({ as_is: z.boolean().optional(), ...CONFIRM }), confirm: true, command: 'approve',
    call: (actions, _queue, [w, t], body) => actions.approve(w, t, body.as_is === true),
  }),
  abort: job({
    shape: '{"discard"?: boolean}', body: z.strictObject({ discard: z.boolean().optional() }), command: 'abort',
    call: (actions, _queue, [w, t], body) => actions.abort(w, t, body.discard === true),
  }),
  say: job({
    shape: '{"message": string}', body: z.strictObject({ message: z.string() }), command: 'say',
    call: (actions, _queue, [w, t], body) => actions.say(w, t, body.message),
  }),
  // sf review: the Execution refuses any state but needs_human with review_failed.
  review: job({ ...EMPTY, command: 'review', call: (actions, _queue, [w, t]) => actions.retryReview(w, t) }),
  // sf retry: the Execution refuses any job but one a transient MR preparation failure
  // stopped; on mr_push_failed it pushes again.
  retry: job({
    shape: '{"confirm"?: string}', body: z.strictObject(CONFIRM), confirm: true, command: 'retry',
    call: (actions, _queue, [w, t]) => actions.retryMr(w, t),
  }),
  // sf accept: the Execution refuses any state but needs_human after a stop it takes on (the gate's,
  // the ledger's, the Fix round limit), with the checks of acceptGateInRunner.
  accept: job({ ...EMPTY, command: 'accept', call: (actions, _queue, [w, t]) => actions.acceptGate(w, t) }),
  // sf settle: the Execution refuses any state but needs_human, and any entry but an
  // escalated or contested one.
  settle: job({
    shape: '{"id": string, "decision": "accept" | "fix", "note"?: string}',
    body: z.strictObject({ id: z.string(), decision: z.enum(DECISIONS), note: z.string().optional() }), command: 'settle',
    call: (actions, _queue, [w, t], body) => actions.settle(w, t, body.id, body.decision, body.note ?? ''),
  }),
  // sf simplify: the Execution refuses any state but needs_human with simplify_offered.
  simplify: job({ ...EMPTY, command: 'simplify', call: (actions, _queue, [w, t]) => actions.simplify(w, t) }),
  // The Archive of a Done card or job page: a finished job leaves the board as with sf reset (the
  // history is archived, a kept worktree removed, the branch and its commits untouched), and its Task
  // file goes to the archive while it is active (Setup's ticket archive, through the Execution). A live
  // job is refused (invalid_state). It ends the job without asking origin, so the remote port asks for the ticket.
  archive: job({
    shape: '{"confirm"?: string}', body: z.strictObject(CONFIRM), confirm: true, refresh: 'jobs',
    call: (actions, _queue, [w, t]) => actions.archiveFinished(w, t),
  }),
  // sf mr create, merge and status. The Execution announces an opened or merged merge
  // request to every page; a state the status found changed on the host reaches them here.
  'mr-create': job({
    shape: '{"confirm"?: string}', body: z.strictObject(CONFIRM), confirm: true, command: 'mr-create',
    call: (actions, _queue, [w, t]) => actions.createMergeRequest(w, t),
  }),
  'mr-merge': job({
    shape: '{"confirm"?: string}', body: z.strictObject(CONFIRM), confirm: true, command: 'mr-merge',
    call: (actions, _queue, [w, t]) => actions.mergeMergeRequest(w, t),
  }),
  'mr-status': job({ ...EMPTY, refresh: 'job', command: 'mr-status', call: (actions, _queue, [w, t]) => actions.mergeRequestStatus(w, t) }),
  // sf pause: the Execution refuses any state but working and awaiting_review.
  pause: job({ ...EMPTY, command: 'pause', call: (actions, _queue, [w, t]) => actions.pause(w, t) }),
  // sf resume: paused only; a message only when a turn was paused.
  resume: job({
    shape: '{"message"?: string}', body: z.strictObject({ message: z.string().optional() }), command: 'resume',
    call: (actions, _queue, [w, t], body) => actions.resumePaused(w, t, body.message ?? ''),
  }),
  // sf restart: a new job replaces the old one, so every page gets the jobs again.
  restart: job({
    shape: '{"keep_files"?: boolean}', body: z.strictObject({ keep_files: z.boolean().optional() }), refresh: 'jobs', command: 'restart',
    call: (actions, _queue, [w, t], body) => actions.restart(w, t, body.keep_files === true),
  }),
  // sf handover, takeback, handed-done and handed-done --merged: the Execution refuses any state but
  // ready_for_human_review (handover) and handed_over (the others). Merged another way ends the job
  // without asking origin, so the remote port asks for the ticket.
  handover: job({ ...EMPTY, command: 'handover', call: (actions, _queue, [w, t]) => actions.handover(w, t) }),
  takeback: job({ ...EMPTY, command: 'takeback', call: (actions, _queue, [w, t]) => actions.takeback(w, t) }),
  'handed-done': job({ ...EMPTY, command: 'handed-done', call: (actions, _queue, [w, t]) => actions.handedDone(w, t) }),
  'handed-done-merged': job({
    shape: '{"confirm"?: string}', body: z.strictObject(CONFIRM), confirm: true, command: 'handed-done',
    call: (actions, _queue, [w, t]) => actions.markHandedDone(w, t),
  }),
  // The Merge request screen: the MR title and text, and the branch and the base when they
  // change. The Execution refuses any state but ready_for_human_review and needs_human after a
  // failed push; the job's detail reaches every page that shows it. mr-reset keeps mr-save's bound.
  'mr-save': job({
    shape: '{"title": string, "body": string, "branch"?: string, "base"?: string}',
    body: z.strictObject({ title: z.string(), body: z.string(), branch: z.string().optional(), base: z.string().optional() }),
    refresh: 'job', bodyLimit: MAX_MR_BODY_BYTES,
    call: (actions, _queue, [w, t], body) => actions.saveMr(w, t, body),
  }),
  'mr-reset': job({ ...EMPTY, refresh: 'job', bodyLimit: MAX_MR_BODY_BYTES, call: (actions, _queue, [w, t]) => actions.resetMr(w, t) }),

  // The run queue: positions are 1-based; the limit's range is the queue's own check
  // (invalid_limit). Every page gets the tickets again.
  'queue-add': queue({
    shape: '{"workspace": string, "ticket": string, "at"?: integer >= 1}',
    body: z.strictObject({ workspace: z.string(), ticket: z.string(), at: z.number().int().min(1).optional() }), command: 'queue-add',
    call: (_actions, q, _key, body) => q.add(body.workspace, body.ticket, body.at),
  }),
  'queue-remove': queue({
    shape: '{"workspace": string, "ticket": string}', body: z.strictObject({ workspace: z.string(), ticket: z.string() }), command: 'queue-remove',
    call: (_actions, q, _key, body) => q.remove(body.workspace, body.ticket),
  }),
  'queue-move': queue({
    shape: '{"workspace": string, "ticket": string, "to": integer >= 1}',
    body: z.strictObject({ workspace: z.string(), ticket: z.string(), to: z.number().int().min(1) }), command: 'queue-move',
    call: (_actions, q, _key, body) => q.move(body.workspace, body.ticket, body.to),
  }),
  'queue-limit': queue({
    shape: '{"max_running": number}', body: z.strictObject({ max_running: z.number() }), command: 'queue-limit',
    call: (_actions, q, _key, body) => q.limit(body.max_running),
  }),
  'queue-hold': queue({
    shape: '{"reason"?: string}', body: z.strictObject({ reason: z.string().optional() }), command: 'queue-hold',
    call: (_actions, q, _key, body) => q.hold(body.reason),
  }),
  'queue-release': queue({ ...EMPTY, command: 'queue-release', call: (_actions, q) => q.release() }),
  // The Rules menu: the rule at a usage limit's reset; its values are the queue's own check
  // (invalid_rule).
  'queue-rule': queue({
    shape: '{"rule": string}', body: z.strictObject({ rule: z.string() }), command: 'queue-on-limit',
    call: (_actions, q, _key, body) => q.rule(body.rule),
  }),
  // Start anyway: the queued ticket starts whatever its plan check says.
  'queue-force': queue({
    shape: '{"workspace": string, "ticket": string}', body: z.strictObject({ workspace: z.string(), ticket: z.string() }), command: 'queue-force',
    call: (_actions, q, _key, body) => q.force(body.workspace, body.ticket),
  }),
};

export type RouteName = keyof typeof POST_ROUTES;
// The job actions: POST api/jobs/<ws>/<ticket>/<action>.
export type DashboardAction = { [N in RouteName]: (typeof POST_ROUTES)[N]['kind'] extends 'job' ? N : never }[RouteName];

// The route of a name and a kind, or undefined: queue-add is no job action, nor approve a queue one.
export function postRoute(name: string, kind: 'job'): JobRoute | undefined;
export function postRoute(name: string, kind: 'queue'): QueueRoute | undefined;
export function postRoute(name: string, kind: PostRoute['kind']): PostRoute | undefined {
  if (!Object.hasOwn(POST_ROUTES, name)) {
    return undefined;
  }
  const route: PostRoute = POST_ROUTES[name as RouteName];
  return route.kind === kind ? route : undefined;
}

// Whether the route answers while sf update drains or builds: its command's openWhileUpdating.
export function openWhileUpdating(route: PostRoute): boolean {
  return route.command !== undefined && socketCommand(route.command)?.openWhileUpdating === true;
}

// The routes that need the job's ticket typed again on the remote port, in the table's order: the
// job's detail sends them to the page as confirm_actions.
export const CONFIRM_ACTIONS: readonly RouteName[] = (Object.keys(POST_ROUTES) as RouteName[]).filter((name) => POST_ROUTES[name].confirm === true);

// GET api/workspaces/<ws>/merge-requests and api/workspaces/<ws>/merge-requests/<number>/threads:
// the open merge requests of the workspace's origin and the review threads of one, read on the host
// when the page asks (sf mr list and sf mr comments). undefined (an empty 404) for a name or a
// number that is not one; the host's refusals are the Execution's FactoryErrors.
export type MergeRequestReads = Pick<DashboardActions, 'openMergeRequests' | 'mergeRequestThreads'>;

export async function openMergeRequestsRead(actions: MergeRequestReads, [workspace = '']: readonly string[]): Promise<unknown> {
  return WORKSPACE_NAME_PATTERN.test(workspace) ? actions.openMergeRequests(workspace) : undefined;
}

export async function mergeRequestThreadsRead(actions: MergeRequestReads, [workspace = '', number = '']: readonly string[]): Promise<unknown> {
  return WORKSPACE_NAME_PATTERN.test(workspace) && MR_NUMBER.test(number) ? actions.mergeRequestThreads(workspace, Number(number)) : undefined;
}
