// The factory's MCP endpoint for the planner (SF-040): a loopback HTTP listener serving /mcp
// through the SDK's stateless handler, with the Handbook as instructions and the planning tools
// guide, read_file, search, write_task, task_check (the last Task check of the current Task
// file, SF-054; checked automatically after write_task, SF-086), queue_list and queue_add (the
// run queue, SF-071), and read_attachment (a ticket's image as MCP image content, SF-064). No
// authentication: it
// listens on loopback only. Jobs
// are started, reviewed and approved by the user (the dashboard, the CLI) and the reviewers,
// never through this endpoint.
import { readFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ATTACHMENT_NAME_PATTERN, MAX_ATTACHMENT_BYTES, readAttachment } from './attachments.js';
import { FactoryError } from './errors.js';
import type { Execution } from './execution.js';
import type { RunQueue } from './queue.js';
import { DEPENDENCY_STATES } from './setup.js';
import { handbookSection } from './prompts.js';
import { resolveWorkspace, WORKSPACE_NAME_DESCRIPTION, WORKSPACE_NAME_PATTERN } from './registry.js';
import { DEFAULT_PAGE_BYTES, MAX_FILE_BYTES, MAX_PAGE_BYTES, MAX_PATH_LENGTH, MIN_PAGE_BYTES, RepoFiles, RepoReadError } from './repo-files.js';
import { DEFAULT_RESULTS, MAX_QUERY_CHARS, MAX_RESULTS, search } from './search.js';
import { checkFile, checkFinding, recordVerdict, type TaskChecks } from './task-check.js';
import { AUTO_CHECK_DELAY_MS, type AutoChecks } from './task-check-auto.js';
import { isDraft, MAX_TASK_BYTES, TICKET_DESCRIPTION, TICKET_PATTERN, writeTask } from './task-file.js';
import type { TicketHistory } from './ticket-history.js';

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

// The Task checks task_check reads (SF-054): the check of the current Task file, whether one runs,
// and the stored checks (write_task's already_checked, SF-086).
export type ServerChecks = Pick<TaskChecks, 'current' | 'isRunning' | 'store'>;

// The automatic Task checks (SF-086): write_task triggers one; task_check says whether one is pending.
export type ServerAutoChecks = Pick<AutoChecks, 'trigger' | 'isPending'>;

// What write_task says of the automatic check of the Task file it wrote (SF-086).
export const WRITE_CHECK_STATES = ['scheduled', 'off', 'already_checked', 'draft'] as const;
export const CHECK_AFTER_SECONDS = AUTO_CHECK_DELAY_MS / 1000;

// The run queue the Context owner reads and adds to (SF-071); it neither removes nor moves.
// withTicket: write_task writes under the queue's lock of the ticket (SF-086).
export type ServerQueue = Pick<RunQueue, 'view' | 'add' | 'withTicket'>;

const dependencyRow = z.object({ workspace: z.string(), ticket: z.string(), state: z.enum(DEPENDENCY_STATES) });

// execution: only its JobStore, for write_task's guard against replacing the Task file of a live job.
// history: the tickets' history (SF-081), where write_task records "written"; none records nothing.
// queue: the run queue (SF-071); without it queue_list and queue_add answer queue_unavailable.
// auto: the automatic Task checks (SF-086); without it write_task triggers none (check: off) and
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
        'already_checked (this exact text has a check) or draft (a skeleton is not checked). An automatic Task check starts ' +
        `${CHECK_AFTER_SECONDS} s after the write (unless SF_TASK_CHECK_AUTO=off); read it with task_check.`,
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
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspace, ticket, content }) => {
      try {
        const record = history === undefined ? undefined : (sha256: string) => history.append(workspace, ticket, { kind: 'written', by: 'context_owner', sha256 });
        const target = await resolveWorkspace(workspace);
        const write = (): ReturnType<typeof writeTask> => writeTask(target, ticket, content, execution.jobs, { record });
        // Never between the run queue's last look at the ticket's plan and its start (SF-086).
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
  // skeleton is a draft, a text with a check record is already_checked, and any other is scheduled.
  async function writeCheck(workspace: string, ticket: string, content: string, sha256: string): Promise<{ check: (typeof WRITE_CHECK_STATES)[number]; check_after_seconds?: number }> {
    if (auto === undefined) {
      return { check: 'off' };
    }
    if (isDraft(content)) {
      return { check: 'draft' };
    }
    if (checks !== undefined && (await checks.store.read(workspace, ticket, sha256)) !== undefined) {
      return { check: 'already_checked' };
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

export async function startServer(
  port: number, handbook: Handbook, version: string, execution: Pick<Execution, 'jobs'>, checks?: ServerChecks, history?: TicketHistory, queue?: ServerQueue, auto?: ServerAutoChecks,
): Promise<RunningServer> {
  const mcpHandler = createMcpHandler(() => createMcpServer(handbook, version, execution, checks, history, queue, auto));
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
