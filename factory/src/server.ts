// The factory's MCP endpoint for the planner (SF-040): a loopback HTTP listener serving /mcp
// through the SDK's stateless handler, with the Handbook as instructions and the planning tools
// guide, read_file, search and write_task. No authentication: it listens on loopback only. Jobs
// are started, reviewed and approved by the user (the dashboard, the CLI) and the reviewers,
// never through this endpoint.
import { readFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { FactoryError } from './errors.js';
import type { Execution } from './execution.js';
import { handbookSection } from './prompts.js';
import { resolveWorkspace, WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN } from './registry.js';
import { DEFAULT_PAGE_BYTES, MAX_FILE_BYTES, MAX_PAGE_BYTES, MAX_PATH_LENGTH, MIN_PAGE_BYTES, RepoFiles, RepoReadError } from './repo-files.js';
import { DEFAULT_RESULTS, MAX_QUERY_CHARS, MAX_RESULTS, search } from './search.js';
import { MAX_TASK_BYTES, TICKET_DESCRIPTION, TICKET_PATTERN, writeTask } from './task-file.js';

export const SERVER_NAME = 'software-factory';
const LOOPBACK_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
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

const workspaceName = z.string().regex(WORKSPACE_NAME_PATTERN).describe(`Registered workspace name: ${WORKSPACE_NAME_DESCRIPTION}.`);
const ticketKey = z.string().regex(TICKET_PATTERN).describe(`Ticket key, e.g. "PROJ-123": ${TICKET_DESCRIPTION}.`);
const relativePath = (what: string) => z.string().min(1).max(MAX_PATH_LENGTH).describe(what);

// execution: only its JobStore, for write_task's guard against replacing the Task file of a live job.
function createMcpServer(handbook: Handbook, version: string, execution: Pick<Execution, 'jobs'>): McpServer {
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
    async ({ workspace, ticket, content }) => {
      try {
        return toolResult({ ...(await writeTask(await resolveWorkspace(workspace), ticket, content, execution.jobs)) });
      } catch (error) {
        return toolError(error);
      }
    },
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

export async function startServer(port: number, handbook: Handbook, version: string, execution: Pick<Execution, 'jobs'>): Promise<RunningServer> {
  const mcpHandler = createMcpHandler(() => createMcpServer(handbook, version, execution));
  const nodeHandler = toNodeHandler(mcpHandler);
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
    if (target.pathname === MCP_PATH) {
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
