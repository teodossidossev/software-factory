// The factory's MCP endpoint: a loopback HTTP listener serving /mcp through the SDK's
// stateless handler, with the Handbook as instructions, the planning tools and the execution
// tools. The execution tools call Execution; they know nothing about the Implementer process.
// With OAuth configured (SF_AUTH_*), it is a resource server: it serves the protected resource
// metadata and lets a POST /mcp through with a valid bearer token, or without one for the open
// methods only; src/auth.ts verifies the tokens. With an Events hub it advertises the events
// capability and serves events/list, events/subscribe and events/unsubscribe (src/events.ts),
// which need the token's sub.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  createMcpHandler,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  getOAuthProtectedResourceMetadataUrl,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
  ProtocolError,
  verifyBearerToken,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type AuthConfig, AuthError, createVerifier, type Verify } from './auth.js';
import { FactoryError } from './errors.js';
import { type Events, EventsError, INVALID_PARAMS } from './events.js';
import type { Execution } from './execution.js';
import { JOB_STATES, type JobStore, now, type PrincipalTool } from './jobs.js';
import { handbookSection } from './prompts.js';
import { resolveWorkspace, WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN } from './registry.js';
import { DEFAULT_PAGE_BYTES, MAX_FILE_BYTES, MAX_PAGE_BYTES, MAX_PATH_LENGTH, MIN_PAGE_BYTES, RepoFiles, RepoReadError } from './repo-files.js';
import { DEFAULT_RESULTS, MAX_QUERY_CHARS, MAX_RESULTS, search } from './search.js';
import { MAX_FIX_BYTES, MAX_TASK_BYTES, TICKET_DESCRIPTION, TICKET_PATTERN, writeTask } from './task-file.js';

export const SERVER_NAME = 'software-factory';
const LOOPBACK_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
// Both paths serve the same document: the root one named in the challenge, and the path-aware one
// (RFC 9728) some clients try for /mcp.
const METADATA_PATHS = new Set(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']);
// Advertised and hinted in the 401 challenge, never required of a token: an agreed ChatGPT
// compatibility measure (SF-033), see README.md, section OAuth.
const OFFLINE_ACCESS = 'offline_access';
const SCOPES_SUPPORTED = ['openid', 'profile', 'email', OFFLINE_ACCESS];
// Compiled to dist/src/server.js; the package root is two levels up.
const PACKAGE_ROOT = new URL('../../', import.meta.url);

export interface Handbook {
  // The whole file, returned by guide.
  text: string;
  // The "## Quick start" section, sent as server instructions.
  quickStart: string;
}

export class PortInUseError extends Error {
  constructor(port: number) {
    super(`Port ${port} on ${LOOPBACK_HOST} is already in use.`);
    this.name = 'PortInUseError';
  }
}

export async function packageVersion(): Promise<string> {
  const data = JSON.parse(await readFile(new URL('package.json', PACKAGE_ROOT), 'utf8')) as { version: string };
  return data.version;
}

// Extracts the "## Quick start" section, from its heading up to the next level-2 heading.
export function quickStartSection(text: string): string {
  return handbookSection(text, '## Quick start');
}

export async function loadHandbook(path = process.env.SF_HANDBOOK || fileURLToPath(new URL('HANDBOOK.md', PACKAGE_ROOT))): Promise<Handbook> {
  const text = await readFile(path, 'utf8');
  return { text, quickStart: quickStartSection(text) };
}

function toolResult<T extends Record<string, unknown>>(structuredContent: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent };
}

function toolError(error: unknown) {
  let code = 'internal_error';
  let message = 'The request failed inside the factory.';
  if (error instanceof FactoryError || error instanceof RepoReadError) {
    ({ code, message } = error);
  } else {
    console.error(error);
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify({ code, message }) }], isError: true };
}

// The authenticated caller of a tool call or event method: the token's sub, undefined without
// OAuth or for a call let through as open.
function principalOf(ctx: { http?: { authInfo?: AuthInfo } }): string | undefined {
  const sub = ctx.http?.authInfo?.extra?.sub;
  return typeof sub === 'string' ? sub : undefined;
}

// Appends the principal of a successful tool call to the job's events.jsonl. Without a job for
// the ticket (write_task before the first start) there is no event log, so nothing is written.
// A failure is logged and does not change the tool's result.
async function recordPrincipal(jobs: JobStore, workspace: string, ticket: string, tool: PrincipalTool, principal: string | undefined): Promise<void> {
  if (principal === undefined) {
    return;
  }
  try {
    const job = await jobs.read(workspace, ticket);
    if (job !== undefined) {
      await jobs.appendEvent(workspace, ticket, { ts: now(), iteration: job.iteration, type: 'principal', tool, principal });
    }
  } catch (error) {
    console.error(error);
  }
}

const workspaceName = z.string().regex(WORKSPACE_NAME_PATTERN).describe(`Registered workspace name: ${WORKSPACE_NAME_DESCRIPTION}.`);
const ticketKey = z.string().regex(TICKET_PATTERN).describe(`Ticket key, e.g. "PROJ-123": ${TICKET_DESCRIPTION}.`);
const relativePath = (what: string) => z.string().min(1).max(MAX_PATH_LENGTH).describe(what);

// The event methods' errors as JSON-RPC errors with data.reason; anything else is logged and
// becomes an internal error. Every call leaves one line in the serve log (method, filter, callback
// host, outcome; never the secret or the full callback URL): ChatGPT reports a refused
// subscription without the reason.
async function eventCall<T>(method: string, detail: string, work: () => Promise<T> | T): Promise<T> {
  const line = (outcome: string) => console.error(`${method}${detail === '' ? '' : ` ${detail}`}: ${outcome}`);
  try {
    const result = await work();
    line('ok');
    return result;
  } catch (error) {
    if (error instanceof EventsError) {
      line(`refused ${error.reason} (${error.message})`);
      throw new ProtocolError(error.code, error.message, { reason: error.reason });
    }
    line('internal error');
    console.error(error);
    throw new ProtocolError(-32603, 'The request failed inside the factory.');
  }
}

const eventArguments = z.record(z.string(), z.unknown());
const subscribeParams = z.looseObject({
  name: z.string().min(1),
  arguments: eventArguments.optional(),
  delivery: z.looseObject({ mode: z.string(), url: z.string(), secret: z.string() }),
  cursor: z.string().nullable().optional(),
  ttlMs: z.number().int().positive().nullable().optional(),
});

// The filter and the callback's host (or a subscription id) for the serve log.
function describeEventCall(args: Record<string, unknown> | undefined, target: string | undefined): string {
  let where = target ?? '';
  const url = URL.parse(where);
  if (url !== null) {
    where = url.host;
  }
  return `${JSON.stringify(args ?? {})}${where === '' ? '' : ` to ${where}`}`;
}

// The MCP Events methods (protocol methods, not tools) on the same endpoint as the tools. Params
// are loose objects: unknown fields (e.g. _meta) are ignored.
function registerEvents(server: McpServer, events: Events): void {
  // events is not in the SDK's capability type; the capabilities are a loose object on the wire.
  const capabilities: Record<string, unknown> = { events: {} };
  server.server.registerCapabilities(capabilities as Parameters<typeof server.server.registerCapabilities>[0]);
  server.server.setRequestHandler(
    'events/list',
    { params: z.looseObject({ cursor: z.string().nullable().optional() }).optional() },
    async (_params, ctx) => eventCall('events/list', '', () => events.list(principalOf(ctx))),
  );
  // The SDK only checks that params is an object: the shape is checked inside, so that a refused
  // shape is logged with its reason like every other refusal.
  server.server.setRequestHandler('events/subscribe', { params: z.looseObject({}) }, async (raw, ctx) => {
    const loose = raw as { arguments?: unknown; delivery?: { url?: unknown } };
    const args = typeof loose.arguments === 'object' && loose.arguments !== null ? (loose.arguments as Record<string, unknown>) : undefined;
    const url = typeof loose.delivery?.url === 'string' ? loose.delivery.url : undefined;
    return eventCall('events/subscribe', describeEventCall(args, url), async () => {
      const parsed = subscribeParams.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`).join('; ');
        throw new EventsError(INVALID_PARAMS, 'invalid_params', `Invalid events/subscribe params: ${issues}.`);
      }
      return { ...(await events.subscribe(principalOf(ctx), parsed.data)) };
    });
  });
  server.server.setRequestHandler(
    'events/unsubscribe',
    {
      params: z.looseObject({
        id: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        arguments: eventArguments.optional(),
        delivery: z.looseObject({ mode: z.string().optional(), url: z.string() }).optional(),
      }),
    },
    async (params, ctx) =>
      eventCall('events/unsubscribe', describeEventCall(params.arguments, params.delivery?.url ?? params.id), () => events.unsubscribe(principalOf(ctx), params)),
  );
}

function createMcpServer(handbook: Handbook, version: string, execution: Execution, events: Events | undefined): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions: handbook.quickStart });
  if (events !== undefined) {
    registerEvents(server, events);
  }

  server.registerTool(
    'guide',
    {
      title: 'Factory handbook',
      description: 'Returns the full Software Factory handbook: the cycle, the tools, the Task file format, the templates and the rules.',
      inputSchema: z.strictObject({}),
      outputSchema: z.object({ text: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => toolResult({ text: handbook.text }),
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read a workspace file',
      description:
        "Reads one UTF-8 text file from the workspace's read checkout. path is relative to the checkout root. " +
        `Pages of at most max_bytes bytes (default ${DEFAULT_PAGE_BYTES}, ${MIN_PAGE_BYTES}-${MAX_PAGE_BYTES}); pages end ` +
        'on character boundaries. If next_offset is not null, call again with offset=next_offset. bytes and sha256 ' +
        'describe the whole file; if sha256 changes between pages, start again at 0. ' +
        `Files over ${MAX_FILE_BYTES} bytes, non-UTF-8 content, .git and credential-like files are refused.`,
      inputSchema: z.strictObject({
        workspace: workspaceName,
        path: relativePath('Checkout-relative path using "/", e.g. "docs/README.md".'),
        offset: z.number().int().min(0).optional().describe('Byte offset to start from; default 0. Use next_offset from the previous page.'),
        max_bytes: z.number().int().min(MIN_PAGE_BYTES).max(MAX_PAGE_BYTES).optional().describe(`Maximum bytes in this page; default ${DEFAULT_PAGE_BYTES}.`),
      }),
      outputSchema: z.object({
        path: z.string(),
        encoding: z.literal('utf-8'),
        bytes: z.number().int(),
        sha256: z.string(),
        offset: z.number().int(),
        returned_bytes: z.number().int(),
        text: z.string(),
        next_offset: z.number().int().nullable(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspace, ...request }) => {
      try {
        const { readCheckout } = await resolveWorkspace(workspace);
        return toolResult({ ...(await new RepoFiles(readCheckout).read(request)) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search a workspace',
      description:
        "Searches the workspace's read checkout, tracked and untracked files; ignored files, .git and credential-like " +
        'files are skipped. mode "path": files whose relative path contains query (case-insensitive). mode "content": ' +
        `lines containing query literally (case-insensitive; binary files skipped; lines cut at 200 characters). path_prefix ` +
        `limits the search to a directory or file. At most max_results matches (default ${DEFAULT_RESULTS}, max ` +
        `${MAX_RESULTS}); truncated says whether more exist.`,
      inputSchema: z.strictObject({
        workspace: workspaceName,
        query: z
          .string()
          .min(1)
          .max(MAX_QUERY_CHARS)
          .refine((value) => !value.includes('\0'), 'query must not contain NUL')
          .describe(`Literal text, 1-${MAX_QUERY_CHARS} characters.`),
        mode: z.enum(['path', 'content']),
        path_prefix: relativePath('Checkout-relative directory or file to search in, e.g. "src".').optional(),
        max_results: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`Default ${DEFAULT_RESULTS}.`),
      }),
      outputSchema: z.object({
        mode: z.enum(['path', 'content']),
        query: z.string(),
        path_prefix: z.string().nullable(),
        matches: z.array(z.object({ path: z.string(), line: z.number().int().optional(), text: z.string().optional() })),
        truncated: z.boolean(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspace, ...request }) => {
      try {
        const { readCheckout } = await resolveWorkspace(workspace);
        return toolResult({ ...(await search(readCheckout, request)) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'write_task',
    {
      title: 'Write the Task file',
      description:
        'Creates or replaces the Task file .software-factory/<ticket>.md in the workspace\'s work checkout. content is ' +
        'Markdown starting with a front-matter block ("---" lines) containing ticket (equal to the ticket argument), ' +
        `title and base; at most ${MAX_TASK_BYTES} bytes. The folder is kept out of Git through .git/info/exclude. ` +
        'Returns the checkout-relative path, created or replaced, byte count and sha256. Starts nothing.',
      inputSchema: z.strictObject({
        workspace: workspaceName,
        ticket: ticketKey,
        content: z.string().min(1).describe('The whole Task file; see the handbook for the format.'),
      }),
      outputSchema: z.object({
        path: z.string(),
        status: z.enum(['created', 'replaced']),
        bytes: z.number().int(),
        sha256: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspace, ticket, content }, ctx) => {
      try {
        const result = toolResult({ ...(await writeTask(await resolveWorkspace(workspace), ticket, content, execution.jobs)) });
        await recordPrincipal(execution.jobs, workspace, ticket, 'write_task', principalOf(ctx));
        return result;
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const jobState = z.enum(JOB_STATES);
  const errorShape = z.object({ code: z.string(), message: z.string() });
  // principal: the tool and the caller's sub to log once the work succeeded.
  const run = async <T extends object>(work: () => Promise<T>, principal?: { tool: PrincipalTool; workspace: string; ticket: string; sub: string | undefined }) => {
    try {
      const result = toolResult({ ...(await work()) } as Record<string, unknown>);
      if (principal !== undefined) {
        await recordPrincipal(execution.jobs, principal.workspace, principal.ticket, principal.tool, principal.sub);
      }
      return result;
    } catch (error) {
      return toolError(error);
    }
  };

  server.registerTool(
    'start',
    {
      title: 'Start the job',
      description:
        'Starts the job for a Task file written with write_task: fetches the base branch from origin, creates the ' +
        'branch <ticket>-<slug of the title> in a worktree of its own and runs the first iteration ' +
        '(/implement .software-factory/<ticket>.md) in a new Implementer session. Several jobs of a workspace run at ' +
        'the same time (job_limit above SF_MAX_JOBS). Returns the branch, the state, the worktree and after how many ' +
        'minutes to call check.',
      inputSchema: z.strictObject({ workspace: workspaceName, ticket: ticketKey }),
      outputSchema: z.object({ branch: z.string(), state: jobState, check_after_minutes: z.number().int(), worktree: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspace, ticket }, ctx) => run(() => execution.start(workspace, ticket), { tool: 'start', workspace, ticket, sub: principalOf(ctx) }),
  );

  server.registerTool(
    'check',
    {
      title: 'Check the job',
      description:
        'Returns the state of the job, its iteration count, branch, the time of the last state change (since) and, while ' +
        'working, after how many minutes to check again. Once an iteration is published, every state except working and ' +
        'starting (awaiting_review, needs_human, ready_for_human_review, ...) also returns the last Report (full text) and ' +
        `one page of the Patch, paged like read_file: offset and max_bytes (default ${DEFAULT_PAGE_BYTES}, ` +
        `${MIN_PAGE_BYTES}-${MAX_PAGE_BYTES}); call again with offset=patch.next_offset until it is null. Once MR ` +
        'preparation wrote one, mr holds the merge request text. files lists the sensitive paths (declared by the Task ' +
        "file's may_touch or not) and the deleted paths of the last iteration. pushed, aborted and failed end the " +
        'ticket for you; preparing_mr means wait.',
      inputSchema: z.strictObject({
        workspace: workspaceName,
        ticket: ticketKey,
        offset: z.number().int().min(0).optional().describe('Byte offset into the Patch; default 0.'),
        max_bytes: z.number().int().min(MIN_PAGE_BYTES).max(MAX_PAGE_BYTES).optional().describe(`Maximum Patch bytes in this page; default ${DEFAULT_PAGE_BYTES}.`),
      }),
      outputSchema: z.object({
        state: jobState,
        iteration: z.number().int(),
        branch: z.string(),
        since: z.string(),
        check_after_minutes: z.number().int().nullable(),
        error: errorShape.optional(),
        report: z.string().optional(),
        patch: z
          .object({
            bytes: z.number().int(),
            sha256: z.string(),
            offset: z.number().int(),
            returned_bytes: z.number().int(),
            text: z.string(),
            next_offset: z.number().int().nullable(),
          })
          .optional(),
        mr: z.string().optional(),
        files: z.object({ sensitive: z.array(z.object({ path: z.string(), declared: z.boolean() })), deleted: z.array(z.string()) }).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspace, ticket, offset, max_bytes }) => run(() => execution.check(workspace, ticket, offset, max_bytes)),
  );

  server.registerTool(
    'request_fix',
    {
      title: 'Request a fix',
      description:
        'In awaiting_review, or in ready_for_human_review (the branch is reopened in a worktree and the next Clean amends ' +
        'the prepared commit). Appends "## Fix N" with content to the Task file (N = the number of the iteration just ' +
        'reviewed) and starts the next iteration in the same session (/implement .software-factory/<ticket>.md Fix N). ' +
        `content: 1 to ${MAX_FIX_BYTES} bytes of Markdown, concrete items (path, what is wrong, what is expected). ` +
        'Refused with iteration_limit after the configured number of iterations without Clean. Returns the iteration now ' +
        'running and after how many minutes to check.',
      inputSchema: z.strictObject({
        workspace: workspaceName,
        ticket: ticketKey,
        content: z.string().min(1).describe('The body of the Fix section, without its heading.'),
      }),
      outputSchema: z.object({ iteration: z.number().int(), check_after_minutes: z.number().int() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspace, ticket, content }, ctx) =>
      run(() => execution.requestFix(workspace, ticket, content), { tool: 'request_fix', workspace, ticket, sub: principalOf(ctx) }),
  );

  server.registerTool(
    'mark_clean',
    {
      title: 'Mark the job Clean',
      description:
        'Only in awaiting_review (or needs_human after a failed MR preparation, as the retry). Your verdict that the ' +
        'Patch needs no further Fix section: the factory commits by the Git rules, rebases onto the base, verifies and ' +
        'puts the branch in the user\'s checkout (state preparing_mr, then ready_for_human_review, or needs_human with the ' +
        'reason; a prepared commit that differs from the reviewed change goes back to awaiting_review). Every ' +
        'undeclared sensitive path of the reviewed iteration (check.files.sensitive with declared false) must be named ' +
        'in sensitive, else sensitive_unacknowledged. Pushes nothing: the user approves.',
      inputSchema: z.strictObject({
        workspace: workspaceName,
        ticket: ticketKey,
        sensitive: z.array(z.string()).optional().describe('The undeclared sensitive paths you reviewed and accept, exactly as check.files lists them.'),
      }),
      outputSchema: z.object({ state: jobState, iteration: z.number().int(), branch: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspace, ticket, sensitive }, ctx) => run(() => execution.markClean(workspace, ticket, sensitive ?? []), { tool: 'mark_clean', workspace, ticket, sub: principalOf(ctx) }),
  );

  return server;
}

export interface RunningServer {
  url: URL;
  close(): Promise<void>;
}

function listen(server: HttpServer, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(error.code === 'EADDRINUSE' ? new PortInUseError(port) : error);
    };
    server.once('error', onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off('error', onError);
      resolve(server.address() as AddressInfo);
    });
  });
}

// Writes a web-standard Response (an SDK challenge) to a Node response.
async function send(res: ServerResponse, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers).end(body);
}

interface Gate {
  // The protected resource metadata document, serialized once.
  metadata: string;
  resourceMetadataUrl: string;
  verifier: OAuthTokenVerifier;
  openMethods: Set<string>;
}

// The SDK's verifier interface over src/auth.ts: AuthError becomes invalid_token (server_error when
// the keys could not be fetched); the reason goes to the log, never the token.
function tokenVerifier(verify: Verify): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const principal = await verify(token);
        return { token, clientId: principal.sub, scopes: principal.scopes, expiresAt: principal.expiresAt, extra: { sub: principal.sub } };
      } catch (error) {
        if (error instanceof AuthError) {
          console.error(`${SERVER_NAME} bearer token rejected: ${error.reason}`);
          throw new OAuthError(error.reason === 'jwks_unavailable' ? OAuthErrorCode.ServerError : OAuthErrorCode.InvalidToken, error.message);
        }
        throw error;
      }
    },
  };
}

function createGate(auth: AuthConfig, verify: Verify): Gate {
  // Built by hand: buildOAuthProtectedResourceMetadata needs the whole authorization server
  // metadata, rewrites resource through URL.href (adding a slash to a bare origin, which then no
  // longer equals the API identifier) and has no bearer_methods_supported.
  const metadata = {
    resource: auth.resource,
    authorization_servers: [auth.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: SCOPES_SUPPORTED,
  };
  return {
    metadata: JSON.stringify(metadata),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(new URL(auth.resource).origin)),
    verifier: tokenVerifier(verify),
    openMethods: new Set(auth.openMethods),
  };
}

// The JSON-RPC method of a parsed body when it is a single message naming one; batches, responses
// and anything unparseable have none and so are never open.
function methodOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }
  const method = (body as { method?: unknown }).method;
  return typeof method === 'string' ? method : undefined;
}

type NodeHandler = ReturnType<typeof toNodeHandler>;

// POST /mcp with OAuth on: a bearer token must verify; without one, only an open method passes.
async function gatedPost(gate: Gate, nodeHandler: NodeHandler, req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse): Promise<void> {
  // requiredScopes here only writes the scope="offline_access" hint into the challenge; it is not
  // passed to verifyBearerToken, which would then refuse tokens without it.
  const challengeOptions = { resourceMetadataUrl: gate.resourceMetadataUrl, requiredScopes: [OFFLINE_ACCESS] };
  const header = req.headers.authorization;
  if (header !== undefined) {
    try {
      req.auth = await verifyBearerToken(header, { verifier: gate.verifier, resourceMetadataUrl: gate.resourceMetadataUrl });
    } catch (error) {
      await send(res, bearerAuthChallengeResponse(error, challengeOptions));
      return;
    }
    await nodeHandler(req, res);
    return;
  }
  // No token: read the body (bounded as the adapter bounds it) only to see the method.
  let text: string;
  try {
    text = await (await toWebRequest(req, undefined, { maxRequestBodySize: DEFAULT_MAX_REQUEST_BODY_SIZE })).text();
  } catch (error) {
    if ((error as Error).name === 'RequestBodyTooLargeError') {
      const body = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: (error as Error).message }, id: null });
      res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }).end(body);
      return;
    }
    throw error;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const method = methodOf(body);
  if (method === undefined || !gate.openMethods.has(method)) {
    await send(res, bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, 'Missing Authorization header'), challengeOptions));
    return;
  }
  await nodeHandler(req, res, body);
}

// auth: the OAuth configuration (SF_AUTH_*), undefined for none; verify replaces the verifier
// created from it (tests); events: the MCP Events hub, undefined for no events capability.
export async function startServer(
  port: number,
  handbook: Handbook,
  version: string,
  execution: Execution,
  auth?: AuthConfig,
  verify?: Verify,
  events?: Events,
): Promise<RunningServer> {
  const mcpHandler = createMcpHandler(() => createMcpServer(handbook, version, execution, events));
  const nodeHandler = toNodeHandler(mcpHandler);
  const gate = auth === undefined ? undefined : createGate(auth, verify ?? createVerifier(auth));
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const httpServer = createServer((req, res) => {
    // Reject DNS-rebinding style requests before any routing.
    if (!validateHost(req, res) || !validateOrigin(req, res)) {
      return;
    }
    // Request targets such as "//" are not parseable; answer 400 instead of throwing.
    const target = URL.parse(req.url ?? '/', 'http://localhost');
    if (target === null) {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad request target"}');
      return;
    }
    if (gate !== undefined && METADATA_PATHS.has(target.pathname)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json' }).end('{"error":"method not allowed"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(req.method === 'GET' ? gate.metadata : undefined);
      return;
    }
    if (target.pathname === MCP_PATH) {
      if (gate !== undefined && req.method === 'POST') {
        gatedPost(gate, nodeHandler, req, res).catch((error: unknown) => {
          console.error(error);
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"internal error"}');
          } else {
            res.destroy();
          }
        });
        return;
      }
      void nodeHandler(req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
  });

  const address = await listen(httpServer, port);
  return {
    url: new URL(`http://${LOOPBACK_HOST}:${address.port}${MCP_PATH}`),
    async close() {
      await mcpHandler.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        httpServer.closeAllConnections();
      });
    },
  };
}
