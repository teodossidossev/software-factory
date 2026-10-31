// SF-010 standalone discovery probe: one status tool and one fixed MCP Events
// catalog entry on loopback. It stands apart from the production bridge, refuses
// every subscription, stores nothing, contacts no callback URL and has no
// authenticated principal: ChatGPT's discovery is the only thing it can show.
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  ProtocolError,
  type McpHttpHandler,
  type ServerCapabilities,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export const PROBE_NAME = 'sf010-event-probe';
export const MAX_LIFETIME_MS = 600_000;
export const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const PROBE_VERSION = '0.1.0';
const LOOPBACK_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';

// The draft specification's Forbidden code, as chosen in the SF-010 report.
const FORBIDDEN = -32024;
const REFUSAL_MESSAGE = 'This discovery probe refuses all subscriptions.';
const REFUSAL_DATA = { reason: 'discovery_probe' };
const PROTOCOL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Anything else is logged as "other", so a caller cannot write into the log.
const LOGGED_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'server/discover',
  'tools/list',
  'tools/call',
  'events/list',
  'events/subscribe',
  'events/unsubscribe',
  'subscriptions/listen',
]);

const TEST_EVENT = {
  name: 'probe.test',
  description: 'SF-010 discovery test event. Subscriptions are refused, so it never fires.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  payloadSchema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  },
};

const STATUS = { status: 'running', events: 1, subscriptions: 'refused' } as const;

const statusOutputSchema = z.object({
  status: z.literal('running'),
  events: z.literal(1),
  subscriptions: z.literal('refused'),
});

export interface EventProbeOptions {
  port: number;
  lifetimeMs: number;
  log: (line: string) => void;
}

export interface RunningProbe {
  url: URL;
  // Resolves with the first stop reason once the listener and every connection are gone.
  closed: Promise<string>;
  close(reason?: string): Promise<string>;
}

interface JsonRpcFields {
  id?: unknown;
  method?: unknown;
  params?: { protocolVersion?: unknown } | null;
}

interface Diagnostic {
  era: 'modern' | 'legacy' | 'none';
  method: string;
  protocol: string;
}

function createProbeServer(): McpServer {
  const server = new McpServer({ name: PROBE_NAME, version: PROBE_VERSION });
  server.registerTool(
    'probe_status',
    {
      title: 'SF-010 probe status',
      description: 'Report that the SF-010 discovery probe is running. It reads and changes nothing.',
      inputSchema: z.strictObject({}),
      outputSchema: statusOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      return { content: [{ type: 'text', text: JSON.stringify(STATUS) }], structuredContent: STATUS };
    },
  );
  // The SDK has no events support of its own; the capability and methods are hand-written.
  server.server.registerCapabilities({ events: {} } as ServerCapabilities);
  const anyParams = { params: z.looseObject({}) };
  server.server.setRequestHandler('events/list', anyParams, async () => ({ events: [TEST_EVENT] }));
  for (const method of ['events/subscribe', 'events/unsubscribe']) {
    server.server.setRequestHandler(method, anyParams, async () => {
      throw new ProtocolError(FORBIDDEN, REFUSAL_MESSAGE, REFUSAL_DATA);
    });
  }
  return server;
}

async function readMessage(request: Request): Promise<JsonRpcFields> {
  const message: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  return typeof message === 'object' && message !== null ? (message as JsonRpcFields) : {};
}

// Keeps the routing fields only; nothing else from the body leaves this function.
async function diagnose(request: Request, message: JsonRpcFields): Promise<Diagnostic> {
  const legacy = await isLegacyRequest(request, undefined, { maxRequestBodySize: MAX_REQUEST_BYTES });
  const protocol = request.headers.get('mcp-protocol-version') ?? message.params?.protocolVersion;
  const { method } = message;
  return {
    era: legacy ? 'legacy' : 'modern',
    method: typeof method === 'string' && LOGGED_METHODS.has(method) ? method : 'other',
    protocol: typeof protocol === 'string' && PROTOCOL_PATTERN.test(protocol) ? protocol : 'none',
  };
}

// The SDK answers subscriptions/listen before any handler, so it is refused here.
function refuseListen(id: unknown): Response {
  return Response.json({
    jsonrpc: '2.0',
    id: typeof id === 'string' || typeof id === 'number' ? id : null,
    error: { code: FORBIDDEN, message: REFUSAL_MESSAGE, data: REFUSAL_DATA },
  });
}

function createRequestListener(mcpHandler: McpHttpHandler, log: EventProbeOptions['log']) {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  return (req: IncomingMessage, res: ServerResponse): void => {
    let diagnostic: Diagnostic = { era: 'none', method: 'none', protocol: 'none' };
    res.once('close', () => {
      const auth = req.headers.authorization !== undefined;
      log(JSON.stringify({ at: new Date().toISOString(), ...diagnostic, auth, status: res.headersSent ? res.statusCode : 0 }));
    });

    if (!validateHost(req, res) || !validateOrigin(req, res)) {
      return;
    }
    // Request targets such as "//" are not parseable; answer 400 instead of throwing.
    const target = URL.parse(req.url ?? '/', 'http://localhost');
    if (target === null) {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad request target"}');
      return;
    }
    if (target.pathname !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    // The adapter enforces the size bound, so only bounded bodies reach diagnose().
    // It is built per request so that this request's diagnostic is in scope.
    const nodeHandler = toNodeHandler(
      {
        fetch: async (request, options) => {
          const message = await readMessage(request);
          diagnostic = await diagnose(request, message);
          return message.method === 'subscriptions/listen' ? refuseListen(message.id) : mcpHandler.fetch(request, options);
        },
      },
      { maxRequestBodySize: MAX_REQUEST_BYTES },
    );
    void nodeHandler(req, res);
  };
}

function listen(server: HttpServer, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(error.code === 'EADDRINUSE' ? new Error(`Port ${port} is in use on ${LOOPBACK_HOST}.`) : error);
    };
    server.once('error', onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off('error', onError);
      resolve(server.address() as AddressInfo);
    });
  });
}

export async function startEventProbe(options: EventProbeOptions): Promise<RunningProbe> {
  if (!(Number.isInteger(options.lifetimeMs) && options.lifetimeMs > 0 && options.lifetimeMs <= MAX_LIFETIME_MS)) {
    throw new Error(`Probe lifetime must be between 1 and ${MAX_LIFETIME_MS} ms.`);
  }
  // maxSubscriptions 0 is a second lock on subscriptions/listen, for forms that refuseListen does not see.
  const mcpHandler = createMcpHandler(createProbeServer, { maxRequestBodySize: MAX_REQUEST_BYTES, maxSubscriptions: 0 });
  const httpServer = createServer(
    { maxHeaderSize: MAX_HEADER_BYTES, requestTimeout: REQUEST_TIMEOUT_MS },
    createRequestListener(mcpHandler, options.log),
  );
  const address = await listen(httpServer, options.port);

  let settle: (reason: string) => void = () => {};
  const closed = new Promise<string>((resolve) => {
    settle = resolve;
  });
  let closing = false;
  const close = (reason = 'closed'): Promise<string> => {
    if (!closing) {
      closing = true;
      clearTimeout(lifetime);
      httpServer.close(() => {
        settle(reason);
      });
      httpServer.closeAllConnections();
      void mcpHandler.close();
    }
    return closed;
  };
  const lifetime = setTimeout(() => {
    void close('lifetime');
  }, options.lifetimeMs);

  return { url: new URL(`http://${LOOPBACK_HOST}:${address.port}${MCP_PATH}`), closed, close };
}
