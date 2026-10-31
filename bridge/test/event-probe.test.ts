// SF-010 discovery probe: drives the real listener and the installed SDK over
// loopback HTTP. No tunnel, no callback and no production bridge code is involved.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MAX_REQUEST_BYTES, startEventProbe, type RunningProbe } from '../src/event-probe/server.js';

const MODERN = '2026-07-28';
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'probe-test', version: '1' },
};

interface RpcReply {
  status: number;
  body: { result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };
}

function post(url: URL, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

async function modern(url: URL, method: string, params: object = {}, headers: Record<string, string> = {}): Promise<RpcReply> {
  const response = await post(
    url,
    { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: ENVELOPE } },
    { 'mcp-protocol-version': MODERN, 'mcp-method': method, ...headers },
  );
  return { status: response.status, body: (await response.json()) as RpcReply['body'] };
}

let probe: RunningProbe;
const diagnostics: string[] = [];

before(async () => {
  probe = await startEventProbe({ port: 0, lifetimeMs: 60_000, log: (line) => diagnostics.push(line) });
});

after(async () => {
  for (const child of children) {
    child.kill('SIGKILL');
  }
  await probe.close();
});

test('server/discover negotiates 2026-07-28 and advertises events and tools', async () => {
  const reply = await modern(probe.url, 'server/discover');
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.result?.supportedVersions, [MODERN]);
  const capabilities = reply.body.result?.capabilities as Record<string, unknown>;
  assert.deepEqual(capabilities.events, {});
  assert.ok(capabilities.tools);
});

test('events/list returns the one fixed, well-formed test event', async () => {
  const reply = await modern(probe.url, 'events/list');
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.result?.events, [
    {
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
    },
  ]);
  assert.equal(reply.body.result?.nextCursor, undefined);
});

test('probe_status is the only tool, and it is harmless and identity-free', async () => {
  const listed = await modern(probe.url, 'tools/list');
  const tools = listed.body.result?.tools as Array<{ name: string; annotations?: Record<string, boolean> }>;
  assert.deepEqual(tools.map((tool) => tool.name), ['probe_status']);
  assert.equal(tools[0]?.annotations?.readOnlyHint, true);
  assert.equal(tools[0]?.annotations?.destructiveHint, false);

  const called = await modern(
    probe.url,
    'tools/call',
    { name: 'probe_status', arguments: {} },
    { 'mcp-name': 'probe_status', authorization: 'Bearer caller-supplied', 'x-user-id': 'caller-supplied' },
  );
  assert.deepEqual(called.body.result?.structuredContent, { status: 'running', events: 1, subscriptions: 'refused' });
});

const SUBSCRIBE = {
  name: 'probe.test',
  arguments: {},
  delivery: { mode: 'webhook', url: 'https://receiver.invalid/cb', secret: 'whsec_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0' },
  cursor: null,
};

for (const method of ['events/subscribe', 'events/unsubscribe']) {
  test(`${method} is refused with Forbidden, with or without credentials`, async () => {
    const credentials: Array<Record<string, string>> = [{}, { authorization: 'Bearer caller-supplied', 'x-user-id': 'caller-supplied' }];
    for (const headers of credentials) {
      const reply = await modern(probe.url, method, SUBSCRIBE, headers);
      assert.equal(reply.status, 200);
      assert.equal(reply.body.result, undefined);
      assert.equal(reply.body.error?.code, -32024);
      assert.deepEqual(reply.body.error?.data, { reason: 'discovery_probe' });
      assert.doesNotMatch(JSON.stringify(reply.body), /whsec_|receiver\.invalid|caller-supplied/);
    }
  });
}

test('a malformed subscription is refused the same way', async () => {
  const reply = await modern(probe.url, 'events/subscribe', { name: 42 });
  assert.equal(reply.body.error?.code, -32024);
});

test('subscriptions/listen is refused with Forbidden and opens no stream', async () => {
  const reply = await modern(probe.url, 'subscriptions/listen', { notifications: {} });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.result, undefined);
  assert.equal(reply.body.error?.code, -32024);
  assert.deepEqual(reply.body.error?.data, { reason: 'discovery_probe' });

  const legacy = await post(probe.url, { jsonrpc: '2.0', id: 'listen', method: 'subscriptions/listen', params: {} });
  const body = (await legacy.json()) as RpcReply['body'] & { id: unknown };
  assert.equal(body.id, 'listen');
  assert.equal(body.error?.code, -32024);
});

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'caller-supplied', version: '1' } },
};

// Legacy replies arrive either as JSON or as one SSE data line.
async function legacyReply(response: Response): Promise<RpcReply['body']> {
  const text = await response.text();
  return JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? text) as RpcReply['body'];
}

test('legacy clients negotiate and get the same catalog and refusal', async () => {
  const init = await legacyReply(await post(probe.url, INITIALIZE));
  assert.deepEqual((init.result?.capabilities as Record<string, unknown>).events, {});

  const expected = await modern(probe.url, 'events/list');
  const list = await legacyReply(await post(probe.url, { jsonrpc: '2.0', id: 2, method: 'events/list', params: {} }));
  assert.deepEqual(list.result?.events, expected.body.result?.events);

  const refused = await legacyReply(await post(probe.url, { jsonrpc: '2.0', id: 3, method: 'events/subscribe', params: SUBSCRIBE }));
  assert.equal(refused.error?.code, -32024);
  assert.deepEqual(refused.error?.data, { reason: 'discovery_probe' });
});

// A log line follows its response, so a sentinel request flushes those of earlier tests.
async function drainDiagnostics(): Promise<void> {
  const before = diagnostics.length;
  await fetch(new URL('/drain', probe.url));
  await waitFor(() => diagnostics.slice(before).some((line) => line.includes('"status":404')));
}

async function newDiagnostics(action: () => Promise<unknown>, count: number): Promise<Array<Record<string, unknown>>> {
  await drainDiagnostics();
  const start = diagnostics.length;
  await action();
  await waitFor(() => diagnostics.length >= start + count);
  return diagnostics.slice(start).map((line) => {
    const entry = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'auth', 'era', 'method', 'protocol', 'status']);
    delete entry.at;
    return entry;
  });
}

test('diagnostics hold only allowlisted method, protocol, era, auth presence and status', async () => {
  const entries = await newDiagnostics(async () => {
    await modern(probe.url, 'events/list', {}, { authorization: 'Bearer caller-supplied', 'x-user-id': 'caller-supplied' });
    await modern(probe.url, 'events/subscribe', SUBSCRIBE);
    await post(probe.url, { jsonrpc: '2.0', id: 9, method: 'evil/caller-supplied', params: {} }, { 'mcp-protocol-version': 'caller-supplied' });
    await post(probe.url, INITIALIZE);
  }, 4);
  assert.deepEqual(entries.slice(0, 2), [
    { era: 'modern', method: 'events/list', protocol: MODERN, auth: true, status: 200 },
    { era: 'modern', method: 'events/subscribe', protocol: MODERN, auth: false, status: 200 },
  ]);
  assert.equal(entries[2]?.method, 'other');
  assert.equal(entries[2]?.protocol, 'none');
  assert.deepEqual(entries[3], { era: 'legacy', method: 'initialize', protocol: '2025-06-18', auth: false, status: 200 });
  assert.doesNotMatch(diagnostics.join('\n'), /caller-supplied|whsec_|receiver\.invalid/);
});

test('requests refused before the SDK are still logged, without a method', async () => {
  const entries = await newDiagnostics(async () => {
    await fetch(new URL('/other', probe.url));
    await post(probe.url, {}, { origin: 'https://evil.example' });
    await post(probe.url, { pad: 'x'.repeat(MAX_REQUEST_BYTES) });
  }, 3);
  assert.deepEqual(
    entries.map((entry) => [entry.era, entry.method, entry.status]),
    [
      ['none', 'none', 404],
      ['none', 'none', 403],
      ['none', 'none', 413],
    ],
  );
});

test('non-MCP paths and non-loopback Host or Origin values are rejected', async () => {
  const other = await fetch(new URL('/other', probe.url));
  assert.equal(other.status, 404);
  assert.equal((await post(probe.url, {}, { origin: 'https://evil.example' })).status, 403);
  const host = await rawPost(probe.url, 'evil.example', '{}');
  assert.match(host, /^HTTP\/1\.1 403/);
  assert.match(await rawPost(probe.url, '127.0.0.1', '{}', '//'), /^HTTP\/1\.1 400/);
});

test('a request body over the bound is refused, declared or chunked', async () => {
  const oversized = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/list', params: { pad: 'x'.repeat(MAX_REQUEST_BYTES) } });
  const declared = await fetch(probe.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: oversized });
  assert.equal(declared.status, 413);

  const chunks = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(oversized));
      controller.close();
    },
  });
  const chunked = await fetch(probe.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: chunks,
    duplex: 'half',
  } as RequestInit);
  assert.equal(chunked.status, 413);
});

test('the listener binds loopback only', async () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry !== undefined && !entry.internal)
    .map((entry) => entry?.address as string);
  for (const address of [...addresses, '::1']) {
    assert.equal(await tcpReachable(address, Number(probe.url.port)), false, address);
  }
});

test('the official SDK client negotiates with the probe and calls the status tool', async () => {
  const client = new Client({ name: 'probe-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(probe.url));
  try {
    assert.equal(client.getNegotiatedProtocolVersion(), MODERN);
    assert.ok(client.getServerCapabilities()?.tools);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['probe_status']);
    const result = await client.callTool({ name: 'probe_status', arguments: {} });
    assert.equal((result.structuredContent as { status: string }).status, 'running');
  } finally {
    await client.close();
  }
});

test('lifetimes outside (0, 10 minutes] are refused before binding', async () => {
  for (const lifetimeMs of [0, -1, 600_001, Number.NaN]) {
    await assert.rejects(startEventProbe({ port: 0, lifetimeMs, log: () => {} }), /lifetime/i);
  }
});

test('a lifetime of exactly ten minutes is accepted', async () => {
  const longest = await startEventProbe({ port: 0, lifetimeMs: 600_000, log: () => {} });
  assert.equal(await longest.close(), 'closed');
});

test('a held-open connection cannot outlive the lifetime', async () => {
  const shortLived = await startEventProbe({ port: 0, lifetimeMs: 100, log: () => {} });
  const socket = connect(Number(shortLived.url.port), '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n');
  const dropped = once(socket, 'close');
  assert.equal(await shortLived.closed, 'lifetime');
  await dropped;
  await assert.rejects(fetch(shortLived.url), (error: Error) => (error.cause as NodeJS.ErrnoException).code === 'ECONNREFUSED');
});

test('the first stop reason wins', async () => {
  const probeToStop = await startEventProbe({ port: 0, lifetimeMs: 60_000, log: () => {} });
  const stops = await Promise.all([probeToStop.close('first'), probeToStop.close('second')]);
  assert.deepEqual(stops, ['first', 'first']);
  assert.equal(await probeToStop.closed, 'first');
});

test('a taken port is refused with a clear error', async () => {
  await assert.rejects(
    startEventProbe({ port: Number(probe.url.port), lifetimeMs: 60_000, log: () => {} }),
    /port .* in use/i,
  );
});

function rawPost(url: URL, host: string, body: string, path = '/mcp'): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString();
    });
    socket.on('end', () => {
      resolve(received);
    });
    socket.on('error', reject);
  });
}

// The real entry point, as an operator would start it.
const MAIN = fileURLToPath(new URL('../src/event-probe/main.js', import.meta.url));
const children = new Set<ChildProcess>();

function runMain(env: Record<string, string>): { child: ChildProcess; exited: Promise<number | null>; output: () => string } {
  const child = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  children.add(child);
  // "close" waits for stdio, so every output assertion sees the final bytes.
  const exited = once(child, 'close').then(([code]) => {
    children.delete(child);
    return code as number | null;
  });
  return { child, exited, output: () => output };
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
}

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(1_000);
    const finish = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
    socket.once('timeout', () => {
      finish(false);
    });
  });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('the entry point requires an explicit, valid port and a lifetime within ten minutes', async () => {
  const invalid: Array<Record<string, string>> = [
    {},
    { SF010_PROBE_PORT: '' },
    { SF010_PROBE_PORT: '0' },
    { SF010_PROBE_PORT: '65536' },
    { SF010_PROBE_PORT: 'abc' },
    { SF010_PROBE_PORT: '8791', SF010_PROBE_LIFETIME_SECONDS: '601' },
    { SF010_PROBE_PORT: '8791', SF010_PROBE_LIFETIME_SECONDS: '0' },
  ];
  for (const env of invalid) {
    const run = runMain(env);
    assert.equal(await run.exited, 1, JSON.stringify(env));
    assert.match(run.output(), /SF010_PROBE_/);
  }
});

test('the entry point refuses a port conflict', async () => {
  const run = runMain({ SF010_PROBE_PORT: probe.url.port });
  assert.equal(await run.exited, 1);
  assert.match(run.output(), /in use/);
});

test('the entry point exits 0 when its lifetime ends', async () => {
  const run = runMain({ SF010_PROBE_PORT: String(await freePort()), SF010_PROBE_LIFETIME_SECONDS: '1' });
  assert.equal(await run.exited, 0);
  assert.match(run.output(), /listening on http:\/\/127\.0\.0\.1:\d+\/mcp/);
  assert.match(run.output(), /stopped: lifetime/);
});

test('the entry point stops on SIGTERM and never logs secrets', async () => {
  const port = await freePort();
  const run = runMain({ SF010_PROBE_PORT: String(port), SF010_PROBE_LIFETIME_SECONDS: '30' });
  await waitFor(() => run.output().includes('listening on'));
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  await modern(url, 'events/subscribe', SUBSCRIBE, { authorization: 'Bearer caller-supplied', cookie: 'caller-supplied' });
  await post(url, { jsonrpc: '2.0', id: 1 });
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{caller-supplied' });
  await waitFor(() => run.output().split('\n').filter((line) => line.startsWith('{')).length >= 3);
  run.child.kill('SIGTERM');
  assert.equal(await run.exited, 0);
  assert.match(run.output(), /stopped: SIGTERM/);
  assert.doesNotMatch(run.output(), /caller-supplied|whsec_|receiver\.invalid/);
});
