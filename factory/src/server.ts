// The factory's MCP endpoint for the planner: a loopback HTTP listener serving /mcp
// through the SDK's stateless handler, with the Handbook as instructions and the planning tools
// guide, read_file, search, write_task, task_check (the last Task check of the current Task
// file; checked automatically after write_task), queue_list and queue_add (the
// run queue), and read_attachment (a ticket's image as MCP image content). It
// listens on loopback only and answers only a request with the MCP token of the state directory:
// in the path, /mcp/<token>, or as Authorization: Bearer <token> on /mcp, read from the
// token file on every request. Jobs are started, reviewed and approved by the user (the
// dashboard, the CLI) and the reviewers, never through this endpoint.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ATTACHMENT_NAME_PATTERN, MAX_ATTACHMENT_BYTES, readAttachment } from './attachments.js';
import { writeFileAtomic } from './atomic.js';
import { newToken } from './dashboard.js';
import { FactoryError } from './errors.js';
import { internalError, listen, LOOPBACK_HOST, sameSecret, sendJson } from './http.js';
import { replaceSecret } from './redact.js';
import type { Execution } from './execution.js';
import type { RunQueue } from './queue.js';
import { DEPENDENCY_STATES } from './setup.js';
import { handbookSection } from './prompts.js';
import { resolveWorkspace, WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN } from './registry.js';
import { DEFAULT_PAGE_BYTES, MAX_FILE_BYTES, MAX_PAGE_BYTES, MAX_PATH_LENGTH, MIN_PAGE_BYTES, RepoFiles, RepoReadError } from './repo-files.js';
import { DEFAULT_RESULTS, MAX_QUERY_CHARS, MAX_RESULTS, search } from './search.js';
import { MCP_TOKEN_FILE, readTokenFile } from './secrets.js';
import { checkFile, checkFinding, recordVerdict, type TaskChecks } from './task-check.js';
import { AUTO_CHECK_DELAY_MS, type AutoChecks } from './task-check-auto.js';
import { checkNeed, isDraft, MAX_TASK_BYTES, TICKET_DESCRIPTION, TICKET_PATTERN, writeTask } from './task-file.js';
import type { TicketHistory } from './ticket-history.js';

export const SERVER_NAME = 'software-factory';
const MCP_PATH = '/mcp';
// Compiled to dist/src/server.js; the package root is two levels up.
const PACKAGE_ROOT = new URL('../../', import.meta.url);

export interface Handbook {
  // The whole file, returned by guide.
  text: string;
  // The "## Quick start" section, sent as server instructions.
  quickStart: string;
}

// The MCP token's file: src/secrets.ts's.
export { MCP_TOKEN_FILE } from './secrets.js';
// What every output shows in the token's place.
export const TOKEN_LABEL = '<token>';
// A token anywhere after /mcp/: one the output filter does not know (an earlier one) is hidden too.
const TOKEN_AFTER_PATH = /\/mcp\/[0-9a-f]{64}(?![0-9a-f])/g;
const TOKEN_IN_PATH = /^\/mcp\/([^/]*)$/;
const BEARER = /^Bearer +(\S+) *$/i;
// A token file that cannot be used is logged at most this often while every request is refused.
const REFUSAL_LOG_MS = 60_000;

// The MCP URL with the token, or with TOKEN_LABEL in its place (a string: a URL would encode < >).
export function mcpUrl(port: number, token: string = TOKEN_LABEL): string {
  return `http://${LOOPBACK_HOST}:${port}${MCP_PATH}/${token}`;
}

// The URL without the token, for the bearer form and the profile tunnel-client init creates.
export function mcpBaseUrl(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}${MCP_PATH}`;
}

const invalidMcpToken = (): FactoryError =>
  new FactoryError('invalid_mcp_token', `${MCP_TOKEN_FILE} in the state directory does not hold an MCP token (invalid_mcp_token); sf mcp-url --rotate writes a new one (then restart the tunnel: npm run tunnel).`);

// The MCP token, or undefined when the file is missing; invalid_mcp_token when it holds no token.
export function readMcpToken(stateDir: string): Promise<string | undefined> {
  return readTokenFile(stateDir, MCP_TOKEN_FILE, invalidMcpToken);
}

const noMcpToken = (): FactoryError =>
  new FactoryError('no_mcp_token', 'There is no MCP token yet (no_mcp_token): start sf serve once (npm run serve); it creates the token in the state directory.');

// The MCP token; no_mcp_token without the file.
export async function requireMcpToken(stateDir: string): Promise<string> {
  const token = await readMcpToken(stateDir);
  if (token === undefined) {
    throw noMcpToken();
  }
  return token;
}

// A file or directory that holds or guards a secret (the MCP token, the tunnel client's
// profile): opened without following a link, it must be a regular file (want 0o600) or a
// directory (want 0o700) of this user, else unsafe; a mode wider than want (or, exact, any other
// mode) is set to want (fix) or is a problem (check). Returns the mode it had then; undefined when
// it was fine.
// exact: any other mode counts (the tunnel profile, R4: a 0500 directory would block its rewrite);
// else only a wider one (the MCP token, which a stricter 0400 keeps as private).
export type PrivateKind = { want: 0o600 | 0o700; unsafe: () => FactoryError; exact?: boolean };

export async function privateMode(path: string, { want, unsafe, exact = false }: PrivateKind, fix: boolean): Promise<number | undefined> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (want === 0o700 ? constants.O_DIRECTORY : constants.O_NONBLOCK);
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    // A link (ELOOP), a file where a directory belongs (ENOTDIR), or one this user cannot open
    // (EACCES: another user's, or without its read bit).
    if (['ELOOP', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw unsafe();
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    const kind = want === 0o700 ? info.isDirectory() : info.isFile();
    if (!kind || (process.getuid !== undefined && info.uid !== process.getuid())) {
      throw unsafe();
    }
    const mode = info.mode & 0o777;
    if (exact ? mode === want : (mode & ~want) === 0) {
      return undefined;
    }
    if (fix) {
      await handle.chmod(want);
    }
    return mode;
  } finally {
    await handle.close();
  }
}

const octal = (mode: number): string => mode.toString(8);

// At sf serve's start: a missing token file is created; an invalid one stops the start (a new token
// made silently would leave the tunnel with the old one); a link or anything but a regular file of
// this user stops it with unsafe_mcp_token; a valid one wider than 0600 is narrowed to 0600 and kept.
// Returns a warning when it was narrowed (the token may have been read meanwhile), else undefined.
export async function ensureMcpToken(stateDir: string): Promise<string | undefined> {
  let widened: number | undefined;
  try {
    widened = await privateMode(join(stateDir, MCP_TOKEN_FILE), {
      want: 0o600,
      unsafe: () => new FactoryError('unsafe_mcp_token', `${MCP_TOKEN_FILE} in the state directory is a link, not a regular file, not yours or not readable (unsafe_mcp_token); remove it and start sf serve again (then restart the tunnel).`),
    }, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    await rotateMcpToken(stateDir);
    return undefined;
  }
  if ((await readMcpToken(stateDir)) === undefined) {
    await rotateMcpToken(stateDir);
    return undefined;
  }
  return widened === undefined
    ? undefined
    : `${MCP_TOKEN_FILE} in the state directory had mode ${octal(widened)}; it is 600 now. Others may have read it meanwhile: sf mcp-url --rotate makes a new one (then restart the tunnel).`;
}

// The tunnel client's profile: the file exactly 0600 and its directory exactly 0700, both
// this user's; fix sets any other mode, else it is profile_unsafe. Returns what was narrowed, as words.
export async function keepProfilePrivate(file: string, directory: string, fix: boolean): Promise<string[]> {
  const unsafe = (what: string, mode?: number, want?: number) => (): FactoryError =>
    new FactoryError('profile_unsafe', mode === undefined
      ? `the profile ${what} is a link, of another kind, not yours or not readable (profile_unsafe): ${what === 'file' ? file : directory}`
      : `the profile ${what} has mode ${octal(mode)}, not ${octal(want!)} (profile_unsafe): ${what === 'file' ? file : directory}; scripts/sf-tunnel.sh run sets it`);
  const changed: string[] = [];
  for (const [what, path, want] of [['file', file, 0o600], ['directory', directory, 0o700]] as const) {
    const mode = await privateMode(path, { want, unsafe: unsafe(what), exact: true }, fix);
    if (mode !== undefined && !fix) {
      throw unsafe(what, mode, want)();
    }
    if (mode !== undefined) {
      changed.push(`${what} mode ${octal(mode)} set to ${octal(want)}`);
    }
  }
  return changed;
}

// sf mcp-url --rotate: a new token over the existing file (an invalid one too: that is how
// invalid_mcp_token is left), whether or not sf serve runs; no_mcp_token without one (R5): the first
// token is sf serve's to make.
export async function replaceMcpToken(stateDir: string): Promise<void> {
  try {
    await lstat(join(stateDir, MCP_TOKEN_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw noMcpToken();
    }
    throw error;
  }
  await rotateMcpToken(stateDir);
}

// A new token in the file; a running sf serve answers with it from its next request.
export async function rotateMcpToken(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(join(stateDir, MCP_TOKEN_FILE), Buffer.from(`${newToken()}\n`), 0o600);
}

// text with the token, and any token after /mcp/, shown as TOKEN_LABEL.
export function redactMcpToken(text: string, token: string | undefined): string {
  return replaceSecret(text, token ?? '', TOKEN_LABEL).replace(TOKEN_AFTER_PATH, `${MCP_PATH}/${TOKEN_LABEL}`);
}

// The MCP url line of a tunnel client's profile.
export interface ProfileUrlLine {
  // The line's index in the text split at "\n".
  index: number;
  // What precedes "url:" on the line: the indentation, and "- " when the key opens the item.
  prefix: string;
  // The value as written, quotes included.
  value: string;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => /^\s*(?:#.*)?$/.test(line);
const FIELD = /^([A-Za-z_][\w-]*):(?:\s+(.*?))?\s*$/;

// A scalar as YAML writes it: "double" or 'single' quoted, or plain up to a comment.
function scalar(value: string): string {
  const quoted = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(value) ?? /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(value);
  return quoted !== null ? quoted[1]! : value.replace(/\s+#.*$/, '').trim();
}

const profileUnexpected = (): FactoryError =>
  new FactoryError(
    'profile_mcp_url_unexpected',
    'The profile has no single mcp.server_urls entry with channel main and a url on 127.0.0.1 in the layout tunnel-client init writes (profile_mcp_url_unexpected); nothing changed. Create it again: scripts/sf-tunnel.sh init <tunnel_id>.',
  );

// The tunnel client's profile: the url line of the mcp.server_urls entry whose channel is
// main, found by a line scan of the layout `tunnel-client init` writes (the mcp: block, its
// server_urls: list, the items, each item's keys at the item's indentation), never any line that
// says url. No such entry, more than one, or a host other than 127.0.0.1: profile_mcp_url_unexpected.
export function profileUrlLine(text: string): ProfileUrlLine {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const starts = lines.flatMap((line, index) => (/^mcp:\s*(?:#.*)?$/.test(line) ? [index] : []));
  if (starts.length !== 1) {
    throw profileUnexpected();
  }
  // The mcp: block: the non-blank lines after it up to the next top-level line.
  const block: number[] = [];
  for (let index = starts[0]! + 1; index < lines.length; index++) {
    if (isBlank(lines[index]!)) {
      continue;
    }
    if (indentOf(lines[index]!) === 0) {
      break;
    }
    block.push(index);
  }
  const keyIndent = Math.min(...block.map((index) => indentOf(lines[index]!)));
  const keys = block.filter((index) => indentOf(lines[index]!) === keyIndent && /^\s*server_urls:\s*(?:#.*)?$/.test(lines[index]!));
  if (keys.length !== 1) {
    throw profileUnexpected();
  }
  // The list: the lines after server_urls: deeper than it, or items ("- ") at its indentation.
  const list: number[] = [];
  for (const index of block.filter((line) => line > keys[0]!)) {
    const line = lines[index]!;
    if (indentOf(line) > keyIndent || /^\s*-(?:\s|$)/.test(line)) {
      list.push(index);
      continue;
    }
    break;
  }
  const first = list[0] === undefined ? undefined : lines[list[0]]!;
  if (first === undefined || !/^\s*-(?:\s|$)/.test(first)) {
    throw profileUnexpected();
  }
  const itemIndent = indentOf(first);
  const items: Array<Array<ProfileUrlLine & { key: string }>> = [];
  let fieldIndent = itemIndent + 2;
  const field = (index: number, prefix: string, rest: string): void => {
    const match = FIELD.exec(rest);
    if (match !== null) {
      items.at(-1)!.push({ index, prefix, key: match[1]!, value: match[2] ?? '' });
    }
  };
  for (const index of list) {
    const line = lines[index]!;
    const indent = indentOf(line);
    if (indent === itemIndent && /^\s*-(?:\s|$)/.test(line)) {
      items.push([]);
      const opened = /^(\s*-\s+)(\S.*)$/.exec(line);
      fieldIndent = opened === null ? itemIndent + 2 : opened[1]!.length;
      if (opened !== null) {
        field(index, opened[1]!, opened[2]!);
      }
    } else if (indent === fieldIndent) {
      field(index, line.slice(0, indent), line.slice(indent));
    }
  }
  const main = items.filter((fields) => fields.some((entry) => entry.key === 'channel' && scalar(entry.value) === 'main'));
  const urls = main.length === 1 ? main[0]!.filter((entry) => entry.key === 'url') : [];
  if (urls.length !== 1) {
    throw profileUnexpected();
  }
  const { index, prefix, value } = urls[0]!;
  const url = URL.parse(scalar(value));
  if (url === null || url.protocol !== 'http:' || url.hostname !== LOOPBACK_HOST) {
    throw profileUnexpected();
  }
  return { index, prefix, value };
}

// The profile with its MCP url line set to url, and whether that changed anything.
export function rewriteProfileUrl(text: string, url: string): { text: string; changed: boolean } {
  const { index, prefix, value } = profileUrlLine(text);
  const wanted = `"${url}"`;
  if (value === wanted) {
    return { text, changed: false };
  }
  const lines = text.split('\n');
  const ending = lines[index]!.endsWith('\r') ? '\r' : '';
  lines[index] = `${prefix}url: ${wanted}${ending}`;
  return { text: lines.join('\n'), changed: true };
}

// Whether the profile's MCP url line is exactly url, quoted as rewriteProfileUrl writes it.
export function profileHasUrl(text: string, url: string): boolean {
  return sameSecret(profileUrlLine(text).value, `"${url}"`);
}

// What sf mcp-url --probe found.
export type ProbeOutcome = { result: 'answers' } | { result: 'refused' } | { result: 'unreachable' } | { result: 'unexpected'; status: number };

function hasResult(body: string): boolean {
  // A JSON answer, or a server-sent event stream whose data lines carry it.
  const candidates = [body, ...body.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice('data:'.length))];
  return candidates.some((text) => {
    try {
      const message = JSON.parse(text) as unknown;
      return message !== null && typeof message === 'object' && 'result' in message;
    } catch { // not JSON: not an answer
      return false;
    }
  });
}

// sf mcp-url --probe: an MCP initialize with the token, as the tunnel's check sends it:
// answers (HTTP 200 with a JSON-RPC result), refused (401), unreachable, or another answer.
export async function probeMcp(port: number, token: string, timeoutMs = 3000): Promise<ProbeOutcome> {
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sf-mcp-url-probe', version: '0.0.0' } } };
  let status: number;
  let body: string;
  try {
    const response = await fetch(mcpUrl(port, token), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(initialize),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    body = await response.text().catch(() => '');
  } catch { // refused, timed out or nothing listening: unreachable
    return { result: 'unreachable' };
  }
  if (status === 401) {
    return { result: 'refused' };
  }
  return status === 200 && hasResult(body) ? { result: 'answers' } : { result: 'unexpected', status };
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
  let { code, message }: { code: string; message: string } = internalError();
  if (error instanceof FactoryError || error instanceof RepoReadError) {
    ({ code, message } = error);
  } else {
    console.error(error);
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify({ code, message }) }], isError: true };
}

const workspaceName = z.string().regex(WORKSPACE_NAME_PATTERN).describe(`Registered workspace name: ${WORKSPACE_NAME_DESCRIPTION}.`);
const ticketKey = z.string().regex(TICKET_PATTERN).describe(`Ticket key, e.g. "PROJ-123": ${TICKET_DESCRIPTION}.`);
const relativePath = (what: string) => z.string().min(1).max(MAX_PATH_LENGTH).describe(what);

// The Task checks task_check reads: the check of the current Task file, whether one runs,
// and the stored checks (write_task's already_checked).
export type ServerChecks = Pick<TaskChecks, 'current' | 'isRunning' | 'store'>;

// The automatic Task checks: write_task triggers one; task_check says whether one is pending.
export type ServerAutoChecks = Pick<AutoChecks, 'trigger' | 'isPending'>;

// What write_task says of the automatic check of the Task file it wrote.
export const WRITE_CHECK_STATES = ['scheduled', 'off', 'already_checked', 'draft', 'not_needed'] as const;
export const CHECK_AFTER_SECONDS = AUTO_CHECK_DELAY_MS / 1000;

// The run queue the Context owner reads and adds to; it neither removes nor moves.
// withTicket: write_task writes under the queue's lock of the ticket.
export type ServerQueue = Pick<RunQueue, 'view' | 'add' | 'withTicket'>;

const dependencyRow = z.object({ workspace: z.string(), ticket: z.string(), state: z.enum(DEPENDENCY_STATES) });

// execution: only its JobStore, for write_task's guard against replacing the Task file of a live job.
// history: the tickets' history, where write_task records "written"; none records nothing.
// queue: the run queue; without it queue_list and queue_add answer queue_unavailable.
// auto: the automatic Task checks; without it write_task triggers none (check: off) and
// task_check's pending is false.
function createMcpServer(
  handbook: Handbook, version: string, execution: Pick<Execution, 'jobs'>, checks: ServerChecks | undefined, history?: TicketHistory, queue?: ServerQueue, auto?: ServerAutoChecks,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions: handbook.quickStart });

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
        'Returns the checkout-relative path, created or replaced, byte count and sha256, and check: what happens to the ' +
        `automatic Task check of what was written: scheduled (it starts after check_after_seconds, ${CHECK_AFTER_SECONDS}), off, ` +
        'already_checked (this exact text has a check), draft (a skeleton is not checked) or not_needed (a small, scoped ' +
        'Task starts without a check; check_reason says why). An automatic Task check starts ' +
        `${CHECK_AFTER_SECONDS} s after the write (unless SF_TASK_CHECK_AUTO=off or not needed); read it with task_check.`,
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
        check: z.enum(WRITE_CHECK_STATES),
        check_after_seconds: z.number().int().optional(),
        check_reason: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspace, ticket, content }) => {
      try {
        const record = history === undefined ? undefined : (sha256: string) => history.append(workspace, ticket, { kind: 'written', by: 'context_owner', sha256 });
        const target = await resolveWorkspace(workspace);
        const write = (): ReturnType<typeof writeTask> => writeTask(target, ticket, content, execution.jobs, { record });
        // Never between the run queue's last look at the ticket's plan and its start.
        const written = await (queue === undefined ? write() : queue.withTicket(workspace, ticket, write));
        return toolResult({ ...written, ...(await writeCheck(workspace, ticket, content, written.sha256)) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'task_check',
    {
      title: 'Read the Task check',
      description:
        'Returns the last Task check of the current Task file .software-factory/<ticket>.md: a read-only Claude session ' +
        'that read only the Task file and the repository (the factory runs it automatically after write_task, or the user ' +
        'presses Check). running: a check of the ticket runs now; pending: an automatic check of it is scheduled and has ' +
        'not started; call again until both are false. ' +
        'paraphrase is the checker\'s reading of the Task; findings are decision, contradiction, missing, overreach or ' +
        'unclear, each blocker, major or nit; files are the files it expects to change; verdict is ready (no blocker or ' +
        'major), not_ready, failed (error says why; never ready), or none when the current Task file has no check (a ' +
        'check of an earlier version does not count). Rewrite the Task from the findings with write_task. Starts nothing.',
      inputSchema: z.strictObject({ workspace: workspaceName, ticket: ticketKey }),
      outputSchema: z.object({
        verdict: z.enum(['none', 'ready', 'not_ready', 'failed']),
        sha256: z.string(),
        paraphrase: z.string().nullable(),
        findings: z.array(checkFinding),
        files: z.array(checkFile),
        error: z.string().nullable(),
        model: z.string().nullable(),
        checked_at: z.string().nullable(),
        running: z.boolean(),
        pending: z.boolean(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspace, ticket }) => {
      try {
        if (checks === undefined) {
          throw new FactoryError('check_unavailable', 'The Task check is not available.');
        }
        const { sha256, record } = await checks.current(workspace, ticket);
        const running = checks.isRunning(workspace, ticket);
        const pending = auto?.isPending(workspace, ticket) ?? false;
        if (record === undefined) {
          return toolResult({ verdict: 'none' as const, sha256, paraphrase: null, findings: [], files: [], error: null, model: null, checked_at: null, running, pending });
        }
        return toolResult({
          verdict: recordVerdict(record),
          sha256, paraphrase: record.output?.paraphrase ?? null, findings: record.output?.findings ?? [], files: record.output?.files ?? [],
          error: record.error, model: record.model, checked_at: record.ended_at, running, pending,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'read_attachment',
    {
      title: 'Read an image of a ticket',
      description:
        'Returns one image the user attached to the ticket (.software-factory/<ticket>/<name> in the work checkout) as ' +
        'image content, with one text line of its name, type and size. The first message of the ticket\'s conversation ' +
        `names its images. PNG, JPEG, WebP or GIF, at most ${MAX_ATTACHMENT_BYTES} bytes. In the Task file, refer to an ` +
        'image the Task needs as ![what it shows](<ticket>/<name>). Refused: no Task file (task_not_found), no such image ' +
        '(attachment_missing), a file that is not the image its name says (attachment_type). Starts nothing.',
      inputSchema: z.strictObject({
        workspace: workspaceName,
        ticket: ticketKey,
        name: z.string().regex(ATTACHMENT_NAME_PATTERN).describe('The image\'s file name, e.g. "1.png".'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspace, ticket, name }) => {
      try {
        const image = await readAttachment(await resolveWorkspace(workspace), ticket, name);
        return {
          content: [
            { type: 'image' as const, data: image.data.toString('base64'), mimeType: image.type },
            { type: 'text' as const, text: `${image.name}: ${image.type}, ${image.bytes} bytes` },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // The automatic check of a Task file write_task wrote: off without the automatic checks; else a
  // skeleton is a draft, a text with a check record is already_checked, one that needs no check
  // (checkNeed) is not_needed with check_reason, and any other is scheduled.
  async function writeCheck(workspace: string, ticket: string, content: string, sha256: string): Promise<{ check: (typeof WRITE_CHECK_STATES)[number]; check_after_seconds?: number; check_reason?: string }> {
    if (auto === undefined) {
      return { check: 'off' };
    }
    if (isDraft(content)) {
      return { check: 'draft' };
    }
    if (checks !== undefined && (await checks.store.read(workspace, ticket, sha256)) !== undefined) {
      return { check: 'already_checked' };
    }
    const need = checkNeed(content, workspace);
    if (!need.needed) {
      return { check: 'not_needed', check_reason: need.reason };
    }
    auto.trigger(workspace, ticket);
    return { check: 'scheduled', check_after_seconds: CHECK_AFTER_SECONDS };
  }

  const queueOf = (): ServerQueue => {
    if (queue === undefined) {
      throw new FactoryError('queue_unavailable', 'The run queue is not available.');
    }
    return queue;
  };

  server.registerTool(
    'queue_list',
    {
      title: 'Read the run queue',
      description:
        'Returns the run queue of every workspace: max_running (how many jobs run at once at most; the queue starts the ' +
        'next ticket by itself when a slot is free), running (the jobs running now, started by hand too), held (the queue ' +
        'starts nothing while true), and the queued tickets in order, each with its 1-based position, when it was queued, ' +
        'and waits_for: the tickets of its lands_after that are not merged yet, with their states (the queue starts a ticket ' +
        'only once all are merged). Starts nothing.',
      inputSchema: z.strictObject({}),
      outputSchema: z.object({
        max_running: z.number().int(),
        running: z.number().int(),
        held: z.boolean(),
        entries: z.array(z.object({ workspace: z.string(), ticket: z.string(), position: z.number().int(), queued_at: z.string(), waits_for: z.array(dependencyRow) })),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const { max_running, running, held, entries } = await queueOf().view();
        return toolResult({
          max_running, running, held,
          entries: entries.map(({ workspace, ticket, position, queued_at, waits_for }) => ({ workspace, ticket, position, queued_at, waits_for })),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'queue_add',
    {
      title: 'Add a ticket to the run queue',
      description:
        'Adds a planned ticket to the run queue at position at (1-based; default and beyond the end: the end); the factory ' +
        'starts it by itself when a slot is free and every ticket of its lands_after is merged. Returns its position. ' +
        'Refused: no Task file (task_not_found), a skeleton (task_draft), a ticket with a live job (job_exists), a ticket ' +
        'already queued (already_queued). The user removes and reorders on the dashboard.',
      inputSchema: z.strictObject({
        workspace: workspaceName,
        ticket: ticketKey,
        at: z.number().int().min(1).optional().describe('1-based position; default: the end.'),
      }),
      outputSchema: z.object({ position: z.number().int() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspace, ticket, at }) => {
      try {
        return toolResult({ ...(await queueOf().add(workspace, ticket, at)) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export interface RunningServer {
  // The endpoint without the token: http://127.0.0.1:<port>/mcp.
  url: URL;
  port: number;
  close(): Promise<void>;
}

// The endpoint's own JSON answers keep their content type, without a charset.
const PLAIN_JSON = { 'content-type': 'application/json' };

// What a request without the token gets: never the token, nor why the file failed.
const UNAUTHORIZED_BODY = {
  jsonrpc: '2.0',
  error: { code: -32001, message: "Unauthorized: this endpoint needs the factory's MCP URL with its token; run sf mcp-url on the factory's machine." },
  id: null,
};

// The token a request carries: the path's on /mcp/<token>, the bearer header's on /mcp; undefined
// when it carries none; null when the path is not the endpoint's.
function givenToken(req: IncomingMessage, pathname: string): string | undefined | null {
  if (pathname === MCP_PATH) {
    const header = req.headers.authorization;
    return header === undefined ? undefined : BEARER.exec(header)?.[1];
  }
  const inPath = TOKEN_IN_PATH.exec(pathname);
  return inPath === null ? null : inPath[1];
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, UNAUTHORIZED_BODY, { ...PLAIN_JSON, 'www-authenticate': 'Bearer', 'cache-control': 'no-store' });
}

// stateDir: where the MCP token is read, on every request (no cache: a rotated token counts at
// once); a file that cannot be used refuses every request (fail closed).
export async function startServer(
  port: number, stateDir: string, handbook: Handbook, version: string, execution: Pick<Execution, 'jobs'>, checks?: ServerChecks, history?: TicketHistory, queue?: ServerQueue, auto?: ServerAutoChecks,
): Promise<RunningServer> {
  const mcpHandler = createMcpHandler(() => createMcpServer(handbook, version, execution, checks, history, queue, auto));
  const nodeHandler = toNodeHandler(mcpHandler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  let lastRefusalLog = -Infinity;

  // The current token, or undefined when the file cannot be used: logged (its error code, never a
  // value) at most once per REFUSAL_LOG_MS.
  const currentToken = async (): Promise<string | undefined> => {
    let problem: string;
    try {
      const token = await readMcpToken(stateDir);
      if (token !== undefined) {
        return token;
      }
      problem = 'no_mcp_token';
    } catch (error) {
      problem = error instanceof FactoryError ? error.code : ((error as NodeJS.ErrnoException).code ?? 'unreadable');
    }
    if (Date.now() - lastRefusalLog >= REFUSAL_LOG_MS) {
      lastRefusalLog = Date.now();
      console.error(`mcp: every request is refused: the MCP token file cannot be used (${problem}); sf mcp-url --rotate writes a new one`);
    }
    return undefined;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Reject DNS-rebinding style requests before any routing.
    if (!validateHost(req, res) || !validateOrigin(req, res)) {
      return;
    }
    // Request targets such as "//" are not parseable; answer 400 instead of throwing.
    const target = URL.parse(req.url ?? '/', 'http://localhost');
    if (target === null) {
      sendJson(res, 400, { error: 'bad request target' }, PLAIN_JSON);
      return;
    }
    const given = givenToken(req, target.pathname);
    if (given === null) {
      sendJson(res, 404, { error: 'not found' }, PLAIN_JSON);
      return;
    }
    const token = await currentToken();
    if (given === undefined || token === undefined || !sameSecret(given, token)) {
      unauthorized(res);
      return;
    }
    // The SDK sees the endpoint's path only: the token goes no further than here.
    req.url = `${MCP_PATH}${target.search}`;
    await nodeHandler(req, res);
  };

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end();
    });
  });

  const address = await listen(httpServer, port, 'SF_PORT');
  return {
    url: new URL(mcpBaseUrl(address.port)),
    port: address.port,
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
