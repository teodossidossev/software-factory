// MCP Events with webhook delivery (the draft MCP Events specification as ChatGPT implements it):
// the event catalogue, the subscription store (<state dir>/subscriptions.json), callback
// verification, Standard Webhooks signing and delivery with retries from a queue persisted in
// <state dir>/events-queue.json. No HTTP server and no MCP wiring: src/server.ts exposes
// events/list, events/subscribe and events/unsubscribe, src/cli.ts composes onStateChange with the
// other state listeners and serves `sf events`.
//
// Outbound requests run inside the sf serve process (never in the Implementer's environment or
// sandbox), through node:http(s) with a fresh agent (no proxy, no keep-alive), a DNS lookup that
// only returns public addresses, a hard timeout, and no redirect following (node:http never
// follows one; a 3xx is an ordinary failed answer).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { mkdir, readFile } from 'node:fs/promises';
import { type IncomingMessage, request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import type { Job, JobState, JobStore } from './jobs.js';
import { now } from './jobs.js';
import { WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN } from './registry.js';
import { TICKET_DESCRIPTION, TICKET_PATTERN } from './task-file.js';

export const EVENT_NAME = 'software_factory.job';
// The states that fire the event; starting, working and preparing_mr are internal to an iteration.
export const FIRING_STATES: readonly JobState[] = ['awaiting_review', 'needs_human', 'ready_for_human_review', 'pushed', 'aborted', 'failed'];
// The payload state of the synthetic event sent by `sf events test`.
export const TEST_STATE = 'test';

export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A requested lifetime below this is raised to it, to prevent excessive refreshes.
export const MIN_TTL_MS = 60 * 1000;
export const MAX_PER_PRINCIPAL = 8;
export const MAX_SUBSCRIPTIONS = 32;
export const REQUEST_TIMEOUT_MS = 10_000;
// Delays before the retries after a transient failure: attempt 1 is immediate, attempts 2 to 6
// follow these delays.
export const BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 3_600_000];
export const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_URL_LENGTH = 2048;
const CHALLENGE_BYTES = 32;
// A successful verification of {principal, url, secret} is reused for this long.
const VERIFICATION_CACHE_MS = 60 * 60 * 1000;
// After a refresh with a new secret, deliveries are signed with both keys for this long.
const ROTATION_WINDOW_MS = 10 * 60 * 1000;
const SECRET_PREFIX = 'whsec_';

// JSON-RPC error codes of the event methods.
export const INVALID_PARAMS = -32602;
// CallbackEndpointError of the MCP Events draft.
export const CALLBACK_ENDPOINT_ERROR = -32015;
// Implementation-defined server error: no principal, another principal's subscription, limits.
export const EVENTS_REFUSED = -32000;

// A refusal of an event method: the JSON-RPC code, a categorized reason (data.reason) and a message.
export class EventsError extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(code: number, reason: string, message: string) {
    super(message);
    this.name = 'EventsError';
    this.code = code;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------------------------
// The catalogue

export interface EventDefinition {
  name: string;
  description: string;
  delivery: string[];
  inputSchema: Record<string, unknown>;
  payloadSchema: Record<string, unknown>;
}

export interface JobPayload {
  workspace: string;
  ticket: string;
  state: JobState | typeof TEST_STATE;
  iteration: number;
  branch: string;
  error?: { code: string; message: string };
  mr?: { title: string };
}

const EVENT_DEFINITION: EventDefinition = {
  name: EVENT_NAME,
  description:
    'A Software Factory job reached a state that needs the Context owner or ends the job: awaiting_review ' +
    '(an iteration was published), needs_human, ready_for_human_review, pushed, aborted or failed. Call check ' +
    'with the workspace and ticket of the payload to read the Report and the Patch.',
  delivery: ['webhook'],
  inputSchema: {
    type: 'object',
    properties: {
      workspace: { type: 'string', pattern: WORKSPACE_NAME_PATTERN.source, description: `Only jobs of this registered workspace (${WORKSPACE_NAME_DESCRIPTION}).` },
      ticket: { type: 'string', pattern: TICKET_PATTERN.source, description: `Only jobs of this ticket key (${TICKET_DESCRIPTION}).` },
    },
    additionalProperties: false,
  },
  payloadSchema: {
    type: 'object',
    properties: {
      workspace: { type: 'string' },
      ticket: { type: 'string' },
      state: { type: 'string', enum: [...FIRING_STATES, TEST_STATE], description: `"${TEST_STATE}" only for a test event sent by the user.` },
      iteration: { type: 'integer', description: 'Published iterations of the job.' },
      branch: { type: 'string' },
      error: {
        type: 'object',
        properties: { code: { type: 'string' }, message: { type: 'string' } },
        required: ['code', 'message'],
        additionalProperties: false,
      },
      mr: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
    },
    required: ['workspace', 'ticket', 'state', 'iteration', 'branch'],
    additionalProperties: false,
  },
};

// The events every authenticated principal may subscribe to; one page, no nextCursor.
export function eventCatalogue(): EventDefinition[] {
  return [EVENT_DEFINITION];
}

// The subscription filter: both keys optional; absent means every job.
const inputSchema = z.strictObject({
  workspace: z.string().regex(WORKSPACE_NAME_PATTERN).optional(),
  ticket: z.string().regex(TICKET_PATTERN).optional(),
});
export type EventInput = z.output<typeof inputSchema>;

// The payload of a job that reached state; lines: the MR title (and link) when pushed.
export function jobPayload(job: Job, lines: string[] = []): JobPayload {
  const title = job.state === 'pushed' ? lines[0] : undefined;
  return {
    workspace: job.workspace,
    ticket: job.ticket,
    state: job.state,
    iteration: job.iteration,
    branch: job.branch,
    ...(job.error !== undefined ? { error: { code: job.error.code, message: job.error.message } } : {}),
    ...(title !== undefined && title !== '' ? { mr: { title } } : {}),
  };
}

function matches(input: EventInput, payload: JobPayload): boolean {
  return (input.workspace === undefined || input.workspace === payload.workspace) && (input.ticket === undefined || input.ticket === payload.ticket);
}

// The ticket's own subscription: a filter on that ticket (and on its workspace, or on none).
export function ownsTicket(input: EventInput, workspace: string, ticket: string): boolean {
  return input.ticket === ticket && (input.workspace === undefined || input.workspace === workspace);
}

// A subscription without a ticket filter that still receives the ticket's events, so a second
// conversation would review it.
export function coversTicketBroadly(input: EventInput, workspace: string): boolean {
  return input.ticket === undefined && (input.workspace === undefined || input.workspace === workspace);
}

// The two messages that set up the ChatGPT conversation of one ticket (sf ticket, the dashboard).
export const TICKET_GUIDE = 'Call guide.';

// The instruction the user pastes into the ticket's ChatGPT conversation: it creates the
// event-triggered task and the subscription filtered on this ticket.
export function ticketInstruction(workspace: string, ticket: string): string {
  return (
    `When you receive the event software_factory.job for ticket ${ticket} in workspace ${workspace} ` +
    `(subscribe to that event with arguments {"workspace": "${workspace}", "ticket": "${ticket}"}, nothing else; ` +
    'give the task this whole instruction word for word): ' +
    'call guide, then check with the workspace and ticket of the payload, and act by the guide: ' +
    'on awaiting_review review the Report and the Patch in that same run and end it with request_fix or mark_clean, ' +
    'without waiting for me; ' +
    'on needs_human, pushed, aborted or failed only summarise the state.'
  );
}

// The message that opens the ChatGPT conversation of a ticket from the dashboard (SF-025): the
// connector, guide, the draft to read, the rewrite with write_task, the subscription of
// ticketInstruction, and the wait for the User's start.
// SF-028: the User's own words open the conversation; they are never written into the Task file.
// The Context owner investigates, discusses, writes the Task file over the skeleton, and starts
// the job itself, only on the User's word.
export function ticketConversation(workspace: string, ticket: string, request?: string): string {
  const words = request === undefined || request.trim() === '' ? '' : `Here is what I want, in my words:\n\n${request.trim()}\n\n`;
  return (
    `Use the Software Factory connector. Call guide. This conversation is for ticket ${ticket} in workspace ${workspace}.\n\n` +
    words +
    `Investigate it: read the repository with read_file and search, ask me what is unclear, and discuss the solution with me. ` +
    `When we agree, write the Task file with write_task (workspace "${workspace}", ticket "${ticket}"), replacing the skeleton ` +
    `.software-factory/${ticket}.md, and show me the plan. ` +
    `${ticketInstruction(workspace, ticket)} ` +
    `Do not call start until I say start (or "давай", "почвай"); when I do, call start for this ticket yourself.`
  );
}

// Above this length the prefilled link is not offered; the message is copied by hand instead.
export const MAX_CONVERSATION_URL = 7500;

// The ChatGPT composer prefilled with the message; sending it may still need Enter.
export const CHATGPT_PREFILL_URL = 'https://chatgpt.com/?q=';

export function conversationUrl(message: string): string {
  return `${CHATGPT_PREFILL_URL}${encodeURIComponent(message)}`;
}

// JSON with object keys sorted at every level, so key order never changes an identity.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The deterministic subscription id of {principal, url, event, arguments}.
export function subscriptionId(principal: string, url: string, event: string, input: EventInput): string {
  const digest = createHash('sha256').update(canonicalJson([principal, url, event, input])).digest('base64url');
  return `sub_${digest.slice(0, 32)}`;
}

// ---------------------------------------------------------------------------------------------
// Signing (Standard Webhooks)

// The signing key of a "whsec_<base64>" secret: 24 to 64 bytes in canonical base64; undefined
// for anything else.
export function decodeSecret(secret: string): Buffer | undefined {
  if (!secret.startsWith(SECRET_PREFIX)) {
    return undefined;
  }
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return undefined;
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64') !== encoded) {
    return undefined;
  }
  return key;
}

// One Standard Webhooks signature: "v1," + base64 HMAC-SHA256 of "<id>.<timestamp>.<body>".
export function signPayload(key: Buffer, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

// The webhook-signature header: one signature per key, space-separated (key rotation).
export function signatureHeader(keys: Buffer[], id: string, timestamp: number, body: string): string {
  return keys.map((key) => signPayload(key, id, timestamp, body)).join(' ');
}

// ---------------------------------------------------------------------------------------------
// Callback URLs and addresses

// Everything that is not a public unicast address: unspecified, loopback, private, shared,
// link-local, documentation, benchmarking, multicast, reserved, IPv4-mapped/translated, 6to4,
// Teredo and unique-local ranges. One list per family: a BlockList matches IPv4 addresses
// against IPv4-mapped IPv6 rules, so ::ffff:0:0/96 in a shared list would block every IPv4.
const NON_PUBLIC_V4 = new BlockList();
const NON_PUBLIC_V6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_V4.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) {
  NON_PUBLIC_V6.addSubnet(network, prefix, 'ipv6');
}
const LOOPBACK_V4 = new BlockList();
LOOPBACK_V4.addSubnet('127.0.0.0', 8, 'ipv4');
const LOOPBACK_V6 = new BlockList();
LOOPBACK_V6.addAddress('::1', 'ipv6');

function family(address: string): 'ipv4' | 'ipv6' | undefined {
  const version = isIP(address);
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : undefined;
}

export function isPublicAddress(address: string): boolean {
  const type = family(address);
  return type === 'ipv4' ? !NON_PUBLIC_V4.check(address, 'ipv4') : type === 'ipv6' && !NON_PUBLIC_V6.check(address, 'ipv6');
}

function isLoopbackAddress(address: string): boolean {
  const type = family(address);
  return type === 'ipv4' ? LOOPBACK_V4.check(address, 'ipv4') : type === 'ipv6' && LOOPBACK_V6.check(address, 'ipv6');
}

// allowLoopback (SF_EVENTS_ALLOW_LOOPBACK=on, tests only) also admits 127.0.0.0/8 and ::1.
function allowedAddress(address: string, allowLoopback: boolean): boolean {
  return isPublicAddress(address) || (allowLoopback && isLoopbackAddress(address));
}

function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

// A callback URL ChatGPT may give: https, no userinfo, a host that is not a non-public address
// literal or a localhost name. allowLoopback admits loopback hosts, over http too. The resolved
// addresses are checked again at every connection.
export function validateCallbackUrl(raw: string, allowLoopback: boolean): URL {
  const refuse = (why: string): never => {
    throw new EventsError(CALLBACK_ENDPOINT_ERROR, 'invalid_url', `The callback URL ${why}.`);
  };
  if (raw.length > MAX_URL_LENGTH) {
    refuse(`is longer than ${MAX_URL_LENGTH} characters`);
  }
  const url = URL.parse(raw);
  if (url === null) {
    return refuse('is not an absolute URL');
  }
  if (url.username !== '' || url.password !== '') {
    refuse('must not contain userinfo');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const literal = family(host) !== undefined;
  const loopbackHost = literal ? isLoopbackAddress(host) : isLocalhostName(host);
  if (allowLoopback && loopbackHost) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      refuse('must use https');
    }
    return url;
  }
  if (url.protocol !== 'https:') {
    refuse('must use https');
  }
  if (host === '' || (literal && !isPublicAddress(host)) || (!literal && isLocalhostName(host))) {
    refuse('must name a public host');
  }
  return url;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

// A lookup for net/tls connect that resolves the host and passes on only allowed addresses, so
// the connection goes to a validated address while TLS still verifies the original hostname.
function guardedLookup(allowLoopback: boolean): (hostname: string, options: LookupOptions, callback: LookupCallback) => void {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { family: options.family, hints: options.hints, all: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, '');
        return;
      }
      const allowed = addresses.filter((entry) => allowedAddress(entry.address, allowLoopback));
      const first = allowed[0];
      if (first === undefined) {
        const blocked: NodeJS.ErrnoException = new Error(`${hostname} resolves to no public address.`);
        blocked.code = 'ESF_BLOCKED_ADDRESS';
        callback(blocked, '');
        return;
      }
      if (options.all === true) {
        callback(null, allowed);
      } else {
        callback(null, first.address, first.family);
      }
    });
  };
}

// The answer to one outbound POST, or why there was none.
export type PostOutcome =
  | { kind: 'response'; status: number; body: string }
  | { kind: 'error'; reason: 'timeout' | 'blocked_address' | 'connection_failed' };

// POSTs body to url once: validated destination, no redirects, no proxy, timeoutMs for the whole
// exchange, at most 64 KiB of the answer read.
export function postJson(url: URL, body: string, headers: Record<string, string>, timeoutMs: number, allowLoopback: boolean): Promise<PostOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: PostOutcome): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      }
    };
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (family(host) !== undefined && !allowedAddress(host, allowLoopback)) {
      resolve({ kind: 'error', reason: 'blocked_address' });
      return;
    }
    const requestHeaders: OutgoingHttpHeaders = { ...headers, 'content-length': Buffer.byteLength(body) };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(url, { method: 'POST', headers: requestHeaders, agent: false, lookup: guardedLookup(allowLoopback) }, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_RESPONSE_BYTES) {
          chunks.push(chunk);
        }
      });
      response.once('end', () => finish({ kind: 'response', status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      response.once('error', () => finish({ kind: 'response', status: response.statusCode ?? 0, body: '' }));
    });
    const timer = setTimeout(() => {
      finish({ kind: 'error', reason: 'timeout' });
      request.destroy();
    }, timeoutMs);
    request.once('error', (error: NodeJS.ErrnoException) => {
      finish({ kind: 'error', reason: error.code === 'ESF_BLOCKED_ADDRESS' ? 'blocked_address' : 'connection_failed' });
    });
    request.end(body);
  });
}

// ---------------------------------------------------------------------------------------------
// Delivery rules

// What a delivery attempt's outcome means: delivered (2xx), gone (410: end the subscription),
// too_large (413: drop the event), retry (5xx, timeout, connection failure), rejected (anything
// else: dropped without retry).
export type Verdict = 'delivered' | 'gone' | 'too_large' | 'retry' | 'rejected';

export function verdictOf(outcome: PostOutcome): Verdict {
  if (outcome.kind === 'error') {
    return outcome.reason === 'blocked_address' ? 'rejected' : 'retry';
  }
  const { status } = outcome;
  if (status >= 200 && status < 300) {
    return 'delivered';
  }
  if (status === 410) {
    return 'gone';
  }
  if (status === 413) {
    return 'too_large';
  }
  return status >= 500 ? 'retry' : 'rejected';
}

// The delay before the next attempt after `attempts` attempts failed transiently, or undefined
// when the attempts are used up.
export function retryDelay(attempts: number, schedule: readonly number[] = BACKOFF_MS): number | undefined {
  return attempts >= 1 ? schedule[attempts - 1] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Persistence

const timestamp = z.iso.datetime();
const subscriptionSchema = z.strictObject({
  id: z.string().min(1),
  principal: z.string().min(1),
  event: z.string().min(1),
  input: inputSchema,
  url: z.string().min(1),
  // Stored as given: it is the signing key.
  secret: z.string().min(1),
  // The secret replaced by the last refresh, signed with too until previousSecretUntil.
  previousSecret: z.string().min(1).optional(),
  previousSecretUntil: timestamp.optional(),
  createdAt: timestamp,
  refreshBefore: timestamp,
  // No replay: always null.
  cursor: z.null(),
});
export type Subscription = z.output<typeof subscriptionSchema>;
const subscriptionsFile = z.strictObject({ subscriptions: z.array(subscriptionSchema) });

const queueEntrySchema = z.strictObject({
  eventId: z.string().min(1),
  subscription: z.string().min(1),
  workspace: z.string().min(1),
  ticket: z.string().min(1),
  iteration: z.number().int().min(0),
  // The serialized event, sent byte for byte on every attempt.
  body: z.string(),
  // Attempts made so far.
  attempt: z.number().int().min(0),
  // The last event of a job (SF-019): once this delivery ends, the subscription is removed when
  // it is the ticket's own.
  final: z.boolean().optional(),
  nextAt: timestamp,
});
type QueueEntry = z.output<typeof queueEntrySchema>;
const queueFile = z.strictObject({ deliveries: z.array(queueEntrySchema) });

async function readJson<T>(path: string, schema: z.ZodType<T>, empty: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return empty;
    }
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FactoryError('events_state_invalid', `${path} is not valid JSON.`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new FactoryError('events_state_invalid', `${path} is invalid.`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// The hub

export interface SubscribeParams {
  name: string;
  arguments?: Record<string, unknown> | undefined;
  delivery: { mode: string; url: string; secret: string };
  cursor?: string | null | undefined;
  ttlMs?: number | null | undefined;
}

export interface SubscribeResult {
  id: string;
  refreshBefore: string;
  cursor: null;
  truncated: false;
  // The granted lifetime in milliseconds.
  ttlMs: number;
}

// Either the id, or the identity of the subscribe request (name, arguments, delivery.url).
export interface UnsubscribeParams {
  id?: string | undefined;
  name?: string | undefined;
  arguments?: Record<string, unknown> | undefined;
  delivery?: { url: string } | undefined;
}

// A subscription as `sf events list` shows it: no secret, the URL's host only.
export interface SubscriptionSummary {
  id: string;
  principal: string;
  event: string;
  input: EventInput;
  host: string;
  createdAt: string;
  refreshBefore: string;
}

export interface TestOutcome {
  subscription: string;
  delivered: boolean;
  // The HTTP status, or why there was none.
  status: number | string;
}

export interface EventsOptions {
  // SF_EVENTS_ALLOW_LOOPBACK=on: loopback callback URLs (tests only).
  allowLoopback: boolean;
  requestTimeoutMs?: number;
  backoffMs?: readonly number[];
}

export class Events {
  readonly #subscriptionsPath: string;
  readonly #queuePath: string;
  readonly #jobs: JobStore;
  readonly #allowLoopback: boolean;
  readonly #timeoutMs: number;
  readonly #backoff: readonly number[];
  #subscriptions: Subscription[];
  #queue: QueueEntry[];
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #inFlight = new Set<string>();
  // Verified {principal, url, secret} digests and when the verification expires.
  readonly #verified = new Map<string, number>();
  #lock: Promise<unknown> = Promise.resolve();
  #closed = false;
  // Called after the set of subscriptions changed (the dashboard refreshes its pages).
  readonly #changeListeners = new Set<() => void>();

  private constructor(stateDir: string, jobs: JobStore, options: EventsOptions, subscriptions: Subscription[], queue: QueueEntry[]) {
    this.#subscriptionsPath = join(stateDir, 'subscriptions.json');
    this.#queuePath = join(stateDir, 'events-queue.json');
    this.#jobs = jobs;
    this.#allowLoopback = options.allowLoopback;
    this.#timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#backoff = options.backoffMs ?? BACKOFF_MS;
    this.#subscriptions = subscriptions;
    this.#queue = queue;
  }

  // Loads the subscriptions and the pending deliveries and schedules the latter (due ones at once).
  static async open(stateDir: string, jobs: JobStore, options: EventsOptions): Promise<Events> {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const subscriptions = await readJson(join(stateDir, 'subscriptions.json'), subscriptionsFile, { subscriptions: [] });
    const queue = await readJson(join(stateDir, 'events-queue.json'), queueFile, { deliveries: [] });
    const events = new Events(stateDir, jobs, options, subscriptions.subscriptions, queue.deliveries);
    for (const entry of events.#queue) {
      events.#schedule(entry);
    }
    return events;
  }

  // Stops scheduling; pending deliveries stay in the queue file for the next start.
  close(): void {
    this.#closed = true;
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
  }

  #locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#lock.catch(() => undefined).then(work);
    this.#lock = next;
    return next;
  }

  async #saveSubscriptions(): Promise<void> {
    await writeFileAtomic(this.#subscriptionsPath, Buffer.from(`${JSON.stringify({ subscriptions: this.#subscriptions }, null, 2)}\n`), 0o600);
  }

  async #saveQueue(): Promise<void> {
    await writeFileAtomic(this.#queuePath, Buffer.from(`${JSON.stringify({ deliveries: this.#queue }, null, 2)}\n`), 0o600);
  }

  // Registers a listener for changes of the subscriptions (subscribe, refresh, secret rotation,
  // unsubscribe, remove, a 410); returns its removal. A listener must not throw; one that does is
  // logged.
  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  #changed(): void {
    for (const listener of this.#changeListeners) {
      try {
        listener();
      } catch (error) {
        console.error(error);
      }
    }
  }

  #active(at = Date.now()): Subscription[] {
    return this.#subscriptions.filter((subscription) => Date.parse(subscription.refreshBefore) > at);
  }

  // ---- the three methods; principal is the token's sub

  list(principal: string | undefined): { events: EventDefinition[] } {
    requirePrincipal(principal);
    return { events: eventCatalogue() };
  }

  async subscribe(principal: string | undefined, params: SubscribeParams): Promise<SubscribeResult> {
    const owner = requirePrincipal(principal);
    if (params.name !== EVENT_NAME) {
      throw new EventsError(INVALID_PARAMS, 'unknown_event', `Unknown event "${params.name}"; events/list names the events.`);
    }
    if (params.delivery.mode !== 'webhook') {
      throw new EventsError(INVALID_PARAMS, 'unsupported_delivery', 'Only delivery mode "webhook" is supported.');
    }
    const input = parseInput(params.arguments);
    const key = decodeSecret(params.delivery.secret);
    if (key === undefined) {
      throw new EventsError(INVALID_PARAMS, 'invalid_secret', 'delivery.secret must be "whsec_" followed by the base64 of 24 to 64 bytes.');
    }
    const url = validateCallbackUrl(params.delivery.url, this.#allowLoopback);
    const id = subscriptionId(owner, url.href, EVENT_NAME, input);
    this.#checkLimits(owner, id);
    const cacheKey = createHash('sha256').update(canonicalJson([owner, url.href, params.delivery.secret])).digest('hex');
    if ((this.#verified.get(cacheKey) ?? 0) <= Date.now()) {
      await this.#verify(url, id, key);
      this.#verified.set(cacheKey, Date.now() + VERIFICATION_CACHE_MS);
    }
    const ttl = params.ttlMs === undefined || params.ttlMs === null ? DEFAULT_TTL_MS : Math.min(Math.max(params.ttlMs, MIN_TTL_MS), DEFAULT_TTL_MS);
    return this.#locked(async () => {
      this.#checkLimits(owner, id);
      const at = Date.now();
      const existing = this.#subscriptions.find((subscription) => subscription.id === id);
      const rotated = existing !== undefined && existing.secret !== params.delivery.secret;
      const subscription: Subscription = {
        id,
        principal: owner,
        event: EVENT_NAME,
        input,
        url: url.href,
        secret: params.delivery.secret,
        ...(rotated ? { previousSecret: existing.secret, previousSecretUntil: new Date(at + ROTATION_WINDOW_MS).toISOString() } : {}),
        ...(!rotated && existing?.previousSecret !== undefined && existing.previousSecretUntil !== undefined
          ? { previousSecret: existing.previousSecret, previousSecretUntil: existing.previousSecretUntil }
          : {}),
        createdAt: existing?.createdAt ?? new Date(at).toISOString(),
        refreshBefore: new Date(at + ttl).toISOString(),
        cursor: null,
      };
      this.#subscriptions = [...this.#subscriptions.filter((item) => item.id !== id && Date.parse(item.refreshBefore) > at), subscription];
      await this.#saveSubscriptions();
      this.#changed();
      return { id, refreshBefore: subscription.refreshBefore, cursor: null, truncated: false, ttlMs: ttl };
    });
  }

  async unsubscribe(principal: string | undefined, params: UnsubscribeParams): Promise<Record<string, never>> {
    const owner = requirePrincipal(principal);
    let id = params.id;
    if (id === undefined) {
      if (params.name === undefined || params.delivery === undefined) {
        throw new EventsError(INVALID_PARAMS, 'invalid_params', 'events/unsubscribe needs name, arguments and delivery.url, or id.');
      }
      const url = URL.parse(params.delivery.url);
      if (url === null) {
        return {};
      }
      id = subscriptionId(owner, url.href, params.name, parseInput(params.arguments));
    }
    const target = id;
    return this.#locked(async () => {
      const existing = this.#subscriptions.find((subscription) => subscription.id === target);
      if (existing === undefined) {
        return {};
      }
      if (existing.principal !== owner) {
        throw new EventsError(EVENTS_REFUSED, 'forbidden', 'This subscription belongs to another principal.');
      }
      await this.#drop(target);
      return {};
    });
  }

  #checkLimits(owner: string, id: string): void {
    const active = this.#active();
    if (active.some((subscription) => subscription.id === id)) {
      return;
    }
    if (active.filter((subscription) => subscription.principal === owner).length >= MAX_PER_PRINCIPAL) {
      throw new EventsError(EVENTS_REFUSED, 'subscription_limit', `At most ${MAX_PER_PRINCIPAL} subscriptions per principal.`);
    }
    if (active.length >= MAX_SUBSCRIPTIONS) {
      throw new EventsError(EVENTS_REFUSED, 'subscription_limit', `At most ${MAX_SUBSCRIPTIONS} subscriptions in total.`);
    }
  }

  // The callback verification: a signed {"type":"verification","challenge"} that must be answered
  // with a 2xx whose JSON body echoes the challenge.
  async #verify(url: URL, id: string, key: Buffer): Promise<void> {
    const challenge = randomBytes(CHALLENGE_BYTES).toString('base64url');
    const body = JSON.stringify({ type: 'verification', challenge });
    const outcome = await postJson(url, body, signedHeaders(`msg_verification_${randomBytes(12).toString('hex')}`, id, [key], body), this.#timeoutMs, this.#allowLoopback);
    const fail = (reason: string, message: string): never => {
      throw new EventsError(CALLBACK_ENDPOINT_ERROR, reason, message);
    };
    if (outcome.kind === 'error') {
      fail(outcome.reason, `The callback verification failed: ${outcome.reason}.`);
    } else {
      if (outcome.status < 200 || outcome.status >= 300) {
        fail('challenge_failed', `The callback answered the verification with HTTP ${outcome.status}.`);
      }
      let echoed: unknown;
      try {
        echoed = (JSON.parse(outcome.body) as { challenge?: unknown }).challenge;
      } catch {
        echoed = undefined;
      }
      const expected = Buffer.from(challenge);
      const actual = Buffer.from(typeof echoed === 'string' ? echoed : '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        fail('challenge_failed', 'The callback did not echo the challenge.');
      }
    }
  }

  // ---- delivery

  // The StateListener: queues one delivery per matching subscription for a firing state and
  // returns at once; the transition never waits for a delivery.
  readonly onStateChange = (job: Job, _from: JobState | null, lines?: string[]): void => {
    if (!FIRING_STATES.includes(job.state) || this.#closed) {
      return;
    }
    this.#enqueue(job, jobPayload(job, lines)).catch((error: unknown) => console.error(error));
  };

  // One conversation per ticket (SF-019): when a job is pushed or aborted, the subscriptions
  // filtered on its ticket get the last event and are then removed, so the conversation never
  // fires again. A failed job (a start that did not get going) keeps them: the same conversation
  // starts the ticket again.
  async #enqueue(job: Job, payload: JobPayload): Promise<void> {
    const ending = job.state === 'pushed' || job.state === 'aborted';
    await this.#locked(async () => {
      const added: QueueEntry[] = [];
      for (const subscription of this.#active()) {
        if (subscription.event !== EVENT_NAME || !matches(subscription.input, payload)) {
          continue;
        }
        const own = ending && ownsTicket(subscription.input, job.workspace, job.ticket);
        const eventId = newEventId();
        const body = envelope(eventId, job.updated_at, payload);
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
          await this.#log({ workspace: job.workspace, ticket: job.ticket, iteration: job.iteration }, 'event_failed', subscription.id, 0, 'too_large');
          if (own) {
            await this.#retire(subscription.id, job);
          }
          continue;
        }
        added.push({ eventId, subscription: subscription.id, workspace: job.workspace, ticket: job.ticket, iteration: job.iteration, body, attempt: 0, nextAt: now(), ...(own ? { final: true } : {}) });
      }
      if (added.length === 0) {
        return;
      }
      this.#queue = [...this.#queue, ...added];
      await this.#saveQueue();
      for (const entry of added) {
        this.#schedule(entry);
      }
    });
  }

  #schedule(entry: QueueEntry): void {
    if (this.#closed || this.#timers.has(entry.eventId) || this.#inFlight.has(entry.eventId)) {
      return;
    }
    const delay = Math.max(0, Date.parse(entry.nextAt) - Date.now());
    const timer = setTimeout(() => {
      this.#timers.delete(entry.eventId);
      this.#inFlight.add(entry.eventId);
      this.#attempt(entry.eventId)
        .catch((error: unknown) => console.error(error))
        .finally(() => this.#inFlight.delete(entry.eventId));
    }, delay);
    this.#timers.set(entry.eventId, timer);
  }

  async #attempt(eventId: string): Promise<void> {
    const entry = this.#queue.find((item) => item.eventId === eventId);
    if (entry === undefined) {
      return;
    }
    const subscription = this.#active().find((item) => item.id === entry.subscription);
    const attempt = entry.attempt + 1;
    if (subscription === undefined) {
      await this.#locked(async () => {
        this.#queue = this.#queue.filter((item) => item.eventId !== eventId);
        await this.#saveQueue();
      });
      await this.#log(entry, 'event_failed', entry.subscription, attempt, 'no_subscription');
      return;
    }
    const outcome = await this.#send(subscription, entry.eventId, entry.body);
    const verdict = verdictOf(outcome);
    const status = outcome.kind === 'response' ? outcome.status : outcome.reason;
    const delay = verdict === 'retry' ? retryDelay(attempt, this.#backoff) : undefined;
    await this.#locked(async () => {
      if (verdict === 'gone') {
        await this.#drop(subscription.id);
        return;
      }
      if (delay !== undefined && !this.#closed) {
        const next = { ...entry, attempt, nextAt: new Date(Date.now() + delay).toISOString() };
        this.#queue = this.#queue.map((item) => (item.eventId === eventId ? next : item));
        await this.#saveQueue();
        this.#inFlight.delete(eventId);
        this.#schedule(next);
        return;
      }
      if (delay !== undefined) {
        // Closing: keep the attempt count, retry at the next start.
        const next = { ...entry, attempt, nextAt: new Date(Date.now() + delay).toISOString() };
        this.#queue = this.#queue.map((item) => (item.eventId === eventId ? next : item));
      } else {
        this.#queue = this.#queue.filter((item) => item.eventId !== eventId);
      }
      await this.#saveQueue();
    });
    await this.#log(entry, verdict === 'delivered' ? 'event_delivered' : 'event_failed', subscription.id, attempt, status);
    // The job's last event has ended its delivery (delivered, given up, or gone): the ticket's
    // subscription goes with it.
    if (entry.final === true && delay === undefined && verdict !== 'gone') {
      await this.#locked(() => this.#retire(subscription.id, entry));
    }
  }

  // Removes a subscription at the end of its ticket's job and logs it on the job; inside the lock.
  async #retire(id: string, job: { workspace: string; ticket: string; iteration: number }): Promise<void> {
    if (!this.#subscriptions.some((subscription) => subscription.id === id)) {
      return;
    }
    await this.#drop(id);
    try {
      await this.#jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration: job.iteration, type: 'subscription_removed', subscription: id });
    } catch (error) {
      console.error(error);
    }
  }

  // One signed POST of body to the subscription; the secret replaced within the rotation window
  // signs too.
  #send(subscription: Subscription, eventId: string, body: string): Promise<PostOutcome> {
    const keys = [decodeSecret(subscription.secret)];
    if (subscription.previousSecret !== undefined && subscription.previousSecretUntil !== undefined && Date.parse(subscription.previousSecretUntil) > Date.now()) {
      keys.push(decodeSecret(subscription.previousSecret));
    }
    const valid = keys.filter((key): key is Buffer => key !== undefined);
    return postJson(new URL(subscription.url), body, signedHeaders(eventId, subscription.id, valid, body), this.#timeoutMs, this.#allowLoopback);
  }

  // Removes a subscription and its pending deliveries; call inside the lock.
  async #drop(id: string): Promise<void> {
    this.#subscriptions = this.#subscriptions.filter((subscription) => subscription.id !== id);
    await this.#saveSubscriptions();
    this.#changed();
    const before = this.#queue.length;
    this.#queue = this.#queue.filter((entry) => {
      if (entry.subscription !== id) {
        return true;
      }
      clearTimeout(this.#timers.get(entry.eventId));
      this.#timers.delete(entry.eventId);
      return false;
    });
    if (this.#queue.length !== before) {
      await this.#saveQueue();
    }
  }

  async #log(
    job: { workspace: string; ticket: string; iteration: number },
    type: 'event_delivered' | 'event_failed',
    subscription: string,
    attempt: number,
    status: number | string,
  ): Promise<void> {
    try {
      await this.#jobs.appendEvent(job.workspace, job.ticket, { ts: now(), iteration: job.iteration, type, subscription, attempt, status });
    } catch (error) {
      // The job may have been archived meanwhile.
      console.error(error);
    }
  }

  // ---- `sf events`

  subscriptions(): SubscriptionSummary[] {
    return this.#active().map(({ id, principal, event, input, url, createdAt, refreshBefore }) => ({
      id, principal, event, input, host: new URL(url).host, createdAt, refreshBefore,
    }));
  }

  async remove(id: string): Promise<{ removed: string }> {
    return this.#locked(async () => {
      if (!this.#subscriptions.some((subscription) => subscription.id === id)) {
        throw new FactoryError('subscription_not_found', `There is no subscription ${id}.`);
      }
      await this.#drop(id);
      return { removed: id };
    });
  }

  // Sends one synthetic event (state "test") to the subscription, once, and reports the answer.
  // 410 ends the subscription as for a real event; nothing is queued or logged in a job.
  async test(id: string): Promise<TestOutcome> {
    const subscription = this.#active().find((item) => item.id === id);
    if (subscription === undefined) {
      throw new FactoryError('subscription_not_found', `There is no subscription ${id}.`);
    }
    const payload: JobPayload = { workspace: subscription.input.workspace ?? 'test', ticket: subscription.input.ticket ?? 'SF-TEST', state: TEST_STATE, iteration: 0, branch: 'SF-TEST-event' };
    const eventId = newEventId();
    const outcome = await this.#send(subscription, eventId, envelope(eventId, now(), payload));
    const verdict = verdictOf(outcome);
    if (verdict === 'gone') {
      await this.#locked(() => this.#drop(id));
    }
    return { subscription: id, delivered: verdict === 'delivered', status: outcome.kind === 'response' ? outcome.status : outcome.reason };
  }
}

function requirePrincipal(principal: string | undefined): string {
  if (principal === undefined || principal === '') {
    throw new EventsError(EVENTS_REFUSED, 'unauthenticated', 'Events need an authenticated principal: configure OAuth (SF_AUTH_ISSUER) and send a bearer token.');
  }
  return principal;
}

function parseInput(raw: Record<string, unknown> | undefined): EventInput {
  const parsed = inputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new EventsError(INVALID_PARAMS, 'invalid_arguments', `arguments may hold workspace (${WORKSPACE_NAME_DESCRIPTION}) and ticket (${TICKET_DESCRIPTION}), nothing else.`);
  }
  return Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))) as EventInput;
}

function newEventId(): string {
  return `evt_${randomBytes(16).toString('hex')}`;
}

// The delivered body: one event object, serialized once and sent byte for byte on every attempt.
export function envelope(eventId: string, occurredAt: string, payload: JobPayload): string {
  return JSON.stringify({ eventId, name: EVENT_NAME, timestamp: occurredAt, data: payload, cursor: null });
}

// The Standard Webhooks headers with a fresh timestamp and signature.
function signedHeaders(messageId: string, subscription: string, keys: Buffer[], body: string): Record<string, string> {
  const signedAt = Math.floor(Date.now() / 1000);
  return {
    'content-type': 'application/json',
    'webhook-id': messageId,
    'webhook-timestamp': String(signedAt),
    'webhook-signature': signatureHeader(keys, messageId, signedAt, body),
    'x-mcp-subscription-id': subscription,
  };
}
