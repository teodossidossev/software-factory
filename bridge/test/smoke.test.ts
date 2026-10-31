// End-to-end smoke scenario: spawns the real bridge process on a free loopback
// port with a private temp data dir and drives it through the official MCP client.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir, type NetworkInterfaceInfo } from 'node:os';
import { request } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url));
const READY = /listening on (http:\/\/127\.0\.0\.1:(\d+)\/mcp)/;

// Expected byte counts and digests were computed independently (Python hashlib).
const FIRST = {
  exists: true,
  artifact: 'probe.txt',
  message: 'Здравей, фабрика! Проба №1 — UTF-8 ✓',
  bytes: 61,
  sha256: '9205911fbd8aa6c7741d33407a152f7c262c6e1be9d3a4f0c7df438920839d75',
};
// The 4096 limit counts characters (code points), so astral characters must fit too.
const EMOJI_LIMIT = {
  exists: true,
  artifact: 'probe.txt',
  message: '😀'.repeat(4096),
  bytes: 16384,
  sha256: 'da7e32ccfee509a2e7a52c605cdaf0e6046d0464cb5b8615dc5c66ff80db3abf',
};
const SECOND = {
  exists: true,
  artifact: 'probe.txt',
  message: 'Втора проба',
  bytes: 21,
  sha256: 'b76a0f393248ff9d768f3544e14f4b222a05e8d8703e0ec0d2ec7265b16067e3',
};

interface Bridge {
  child: ChildProcess;
  url: URL;
  port: number;
}

let dataDir: string;
let repoRoot: string;
const running = new Set<ChildProcess>();

function spawnBridge(port = 0, env: Record<string, string> = {}): Promise<Bridge> {
  const child = spawn(process.execPath, [MAIN], {
    env: {
      PATH: process.env.PATH,
      FACTORY_PORT: String(port),
      FACTORY_DATA_DIR: dataDir,
      FACTORY_REPO_ROOT: repoRoot,
      // Smoke runs never reach a real OpenClaw container.
      FACTORY_OPENCLAW_DISPATCH: 'off',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  child.once('exit', () => {
    running.delete(child);
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = READY.exec(output);
      if (match) {
        child.stdout?.off('data', onData);
        resolve({ child, url: new URL(match[1]!), port: Number(match[2]) });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.once('exit', (code) => {
      reject(new Error(`bridge exited with code ${code} before ready:\n${output}`));
    });
  });
}

function stopBridge(bridge: Bridge): Promise<number | null> {
  return new Promise((resolve) => {
    if (bridge.child.exitCode !== null) {
      resolve(bridge.child.exitCode);
      return;
    }
    bridge.child.once('exit', (code) => {
      resolve(code);
    });
    bridge.child.kill('SIGTERM');
  });
}

async function connect(bridge: Bridge, mode: 'legacy' | 'auto' = 'legacy'): Promise<Client> {
  const client = new Client({ name: 'sf-001-smoke', version: '0.0.0' }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(bridge.url));
  return client;
}

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host, port, timeout: 1000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function readProbe(client: Client): Promise<unknown> {
  return (await client.callTool({ name: 'factory_read_probe', arguments: {} })).structuredContent;
}

async function writeProbe(client: Client, message: string): Promise<unknown> {
  return (await client.callTool({ name: 'factory_write_probe', arguments: { message } })).structuredContent;
}

// Uses node:http rather than fetch so the Host header is sent verbatim.
function postAndGetStatusCode(url: URL, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once('error', reject);
    req.end('{}');
  });
}

// Sends a raw HTTP/1.1 request so the request target reaches the bridge byte-for-byte.
function rawRequestStatus(port: number, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: '127.0.0.1', port });
    let response = '';
    socket.once('connect', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('latin1');
    });
    socket.once('error', reject);
    socket.once('close', () => {
      const match = /^HTTP\/1\.1 (\d{3}) /.exec(response);
      if (!match) {
        reject(new Error(`no HTTP status line for ${target}: ${JSON.stringify(response)}`));
        return;
      }
      resolve(Number(match[1]));
    });
  });
}

// The SDK may surface invalid arguments as a tool error result or a protocol error.
async function assertRejected(client: Client, args: Record<string, unknown>): Promise<void> {
  let rejected: boolean;
  try {
    const result = await client.callTool({ name: 'factory_write_probe', arguments: args });
    rejected = result.isError === true;
  } catch {
    rejected = true;
  }
  assert.ok(rejected, `expected rejection for ${JSON.stringify(args).slice(0, 80)}`);
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sf-bridge-smoke-'));
  repoRoot = await mkdtemp(join(tmpdir(), 'sf-bridge-smoke-repo-'));
  await mkdir(join(repoRoot, 'docs'));
  await mkdir(join(repoRoot, 'factory-data', 'apps', 'sf-pilot'), { recursive: true });
  await writeFile(join(repoRoot, 'factory-data', 'apps', 'sf-pilot', '.env'), 'REPO_PATH=/fixture-only\n');
  await writeFile(join(repoRoot, 'docs', 'hello.md'), 'Здравей от repo-то 👋\n');
});

after(async () => {
  for (const child of running) {
    child.kill('SIGKILL');
  }
  await rm(dataDir, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

test('bridge serves the probe tools over MCP and persists the probe across restart', async () => {
  const bridge = await spawnBridge();
  const client = await connect(bridge);
  assert.equal(client.getNegotiatedProtocolVersion(), '2025-11-25');

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'factory_accept_job',
      'factory_authorize_execution',
      'factory_execution_status',
      'factory_list_review_ready',
      'factory_manage_session_context',
      'factory_read_file',
      'factory_read_probe',
      'factory_request_dispatch',
      'factory_review_snapshot',
      'factory_status',
      'factory_submit_review',
      'factory_write_instruction',
      'factory_write_probe',
    ],
  );

  const missing = await client.callTool({ name: 'factory_read_probe', arguments: {} });
  assert.equal(missing.isError ?? false, false);
  assert.deepEqual(missing.structuredContent, { exists: false, artifact: 'probe.txt' });

  const written = await client.callTool({ name: 'factory_write_probe', arguments: { message: FIRST.message } });
  assert.equal(written.isError ?? false, false);
  assert.deepEqual(written.structuredContent, FIRST);
  assert.deepEqual(
    await readProbe(client),
    FIRST,
  );

  assert.deepEqual(await writeProbe(client, EMOJI_LIMIT.message), EMOJI_LIMIT);

  // A further write replaces the probe; invalid input must leave it untouched.
  assert.deepEqual(
    await writeProbe(client, SECOND.message),
    SECOND,
  );
  const invalidArguments = [
    {},
    { message: '' },
    { message: '   \n' },
    { message: 'x'.repeat(4097) },
    { message: '😀'.repeat(4097) },
    { message: 42 },
    { message: 'ok', path: '/etc/passwd' },
  ];
  for (const args of invalidArguments) {
    await assertRejected(client, args);
  }
  // No temp files may be left behind by rejected writes.
  assert.deepEqual(await readdir(dataDir), ['probe.txt']);
  assert.deepEqual(
    await readProbe(client),
    SECOND,
  );

  await client.close();
  assert.equal(await stopBridge(bridge), 0);

  // A fresh process and a fresh connection (2026-07-28 negotiation) still see the probe.
  const restarted = await spawnBridge();
  const modernClient = await connect(restarted, 'auto');
  assert.equal(modernClient.getNegotiatedProtocolVersion(), '2026-07-28');
  assert.deepEqual(
    await readProbe(modernClient),
    SECOND,
  );
  assert.deepEqual((await modernClient.callTool({ name: 'factory_status', arguments: {} })).structuredContent, {
    name: 'software-factory-bridge',
    version: '0.1.0',
    mode: 'local-only-pilot',
  });
  await modernClient.close();
  assert.equal(await stopBridge(restarted), 0);
});

test('bridge listens on loopback only, guards Host/Origin and reports a busy port', async () => {
  const bridge = await spawnBridge();

  assert.equal(await tcpReachable('127.0.0.1', bridge.port), true);
  assert.equal(await tcpReachable('::1', bridge.port), false);
  const externalAddresses = Object.values(networkInterfaces())
    .flat()
    .filter((info): info is NetworkInterfaceInfo => info !== undefined && !info.internal)
    .map((info) => info.address);
  for (const address of externalAddresses) {
    assert.equal(await tcpReachable(address, bridge.port), false, `reachable via ${address}`);
  }

  assert.equal(await postAndGetStatusCode(bridge.url, { host: `attacker.example:${bridge.port}` }), 403);
  assert.equal(await postAndGetStatusCode(bridge.url, { origin: 'https://attacker.example' }), 403);

  await assert.rejects(spawnBridge(bridge.port), /already in use/);
  const client = await connect(bridge);
  assert.equal((await client.listTools()).tools.length, 13);
  await client.close();

  assert.equal(await stopBridge(bridge), 0);
  assert.equal(await tcpReachable('127.0.0.1', bridge.port), false);
});

test('unparseable request targets get HTTP 400 and the bridge keeps serving', async () => {
  const bridge = await spawnBridge();
  const client = await connect(bridge);
  assert.deepEqual(await writeProbe(client, FIRST.message), FIRST);

  for (const target of ['//', '//[']) {
    assert.equal(await rawRequestStatus(bridge.port, target), 400, `status for ${target}`);
  }

  assert.equal(bridge.child.exitCode, null);
  assert.deepEqual((await client.callTool({ name: 'factory_status', arguments: {} })).structuredContent, {
    name: 'software-factory-bridge',
    version: '0.1.0',
    mode: 'local-only-pilot',
  });
  assert.deepEqual(await readProbe(client), FIRST);
  await client.close();
  assert.equal(await stopBridge(bridge), 0);
});

test('factory_read_file reads a repository file over MCP and refuses bad paths without stopping', async () => {
  await assert.rejects(spawnBridge(0, { FACTORY_REPO_ROOT: join(repoRoot, 'missing') }), /does not exist/);

  const bridge = await spawnBridge();
  const client = await connect(bridge);
  const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'factory_read_file');
  assert.deepEqual(tool?.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });

  // Expected bytes and digest were computed independently (Python hashlib).
  const expected = {
    path: 'docs/hello.md',
    encoding: 'utf-8',
    bytes: 35,
    sha256: '6ffb0ea1f4b67e7e34058de65c174388fa8a5d1b99dc25e996efb5488197da30',
    offset: 0,
    returned_bytes: 35,
    text: 'Здравей от repo-то 👋\n',
    next_offset: null,
  };
  const read = await client.callTool({ name: 'factory_read_file', arguments: { path: 'docs/hello.md' } });
  assert.equal(read.isError ?? false, false);
  assert.deepEqual(read.structuredContent, expected);
  const [textBlock] = read.content as Array<{ type: string; text: string }>;
  assert.deepEqual(JSON.parse(textBlock!.text), expected);

  const escape = await client.callTool({ name: 'factory_read_file', arguments: { path: '../outside.txt' } });
  assert.equal(escape.isError, true);
  const [errorBlock] = escape.content as Array<{ type: string; text: string }>;
  assert.equal(JSON.parse(errorBlock!.text).code, 'invalid_path');
  assert.doesNotMatch(errorBlock!.text, new RegExp(repoRoot.replaceAll('/', '\\/')));

  for (const args of [{ path: 'docs/hello.md', extra: true }, { path: 'docs/hello.md', max_bytes: 3 }, {}]) {
    let rejected: boolean;
    try {
      rejected = (await client.callTool({ name: 'factory_read_file', arguments: args })).isError === true;
    } catch {
      rejected = true;
    }
    assert.ok(rejected, `expected rejection for ${JSON.stringify(args)}`);
  }

  assert.equal(bridge.child.exitCode, null);
  assert.equal(
    ((await client.callTool({ name: 'factory_status', arguments: {} })).structuredContent as { mode: string }).mode,
    'local-only-pilot',
  );
  await client.close();
  assert.equal(await stopBridge(bridge), 0);
});

// The SDK may surface invalid arguments as a tool error result or a protocol error.
async function rejectedCode(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `expected rejection for ${JSON.stringify(args).slice(0, 80)}`);
    const [block] = result.content as Array<{ type: string; text: string }>;
    assert.doesNotMatch(block!.text, new RegExp(repoRoot.replaceAll('/', '\\/')));
    try {
      return (JSON.parse(block!.text) as { code: string }).code;
    } catch {
      return 'schema';
    }
  } catch (error) {
    if (error instanceof assert.AssertionError) {
      throw error;
    }
    return 'protocol';
  }
}

test('factory_write_instruction stores Markdown that factory_read_file returns unchanged, and dispatch never fakes success', async () => {
  const bridge = await spawnBridge();
  const client = await connect(bridge);
  // Expected bytes and digests were computed independently (Python hashlib).
  const first = {
    content: '# Пилотна инструкция\n\nНапиши „здравей“ на кирилица. ✓\n',
    bytes: 100,
    sha256: 'b3496d0aaf2cac18460200ab1a7c4363033688afb2f972f3b6a55cecff7e3bbc',
  };
  const second = {
    content: '# Пилотна инструкция v2\n\nПромяна №2 — 🚀\n',
    bytes: 71,
    sha256: '3b9f94b0f082306cba94273c3840f910677adef6fddbd9346b9dad0758c18feb',
  };
  const path = 'factory-data/apps/sf-pilot/jobs/smoke-001/instruction.md';
  const write = (args: Record<string, unknown>) => client.callTool({ name: 'factory_write_instruction', arguments: args });
  const readBack = async () =>
    (await client.callTool({ name: 'factory_read_file', arguments: { path } })).structuredContent as {
      text: string;
      bytes: number;
      sha256: string;
    };

  const created = await write({ app_id: 'sf-pilot', job_id: 'smoke-001', content: first.content });
  assert.equal(created.isError ?? false, false);
  assert.deepEqual(created.structuredContent, { path, status: 'created', bytes: first.bytes, sha256: first.sha256 });
  const read = await readBack();
  assert.deepEqual([read.text, read.bytes, read.sha256], [first.content, first.bytes, first.sha256]);
  const repeated = await write({ app_id: 'sf-pilot', job_id: 'smoke-001', content: first.content });
  assert.equal((repeated.structuredContent as { status: string }).status, 'unchanged');

  // Writing never dispatches.
  assert.deepEqual((await readdir(join(repoRoot, 'factory-data', 'apps', 'sf-pilot', 'jobs', 'smoke-001'))).sort(), ['instruction.md']);

  assert.equal(
    await rejectedCode(client, 'factory_write_instruction', { app_id: 'sf-pilot', job_id: 'smoke-001', content: second.content }),
    'conflict',
  );
  const updated = await write({ app_id: 'sf-pilot', job_id: 'smoke-001', content: second.content, expected_sha256: first.sha256 });
  assert.deepEqual(updated.structuredContent, { path, status: 'updated', bytes: second.bytes, sha256: second.sha256 });
  assert.equal(
    await rejectedCode(client, 'factory_write_instruction', {
      app_id: 'sf-pilot',
      job_id: 'smoke-001',
      content: first.content,
      expected_sha256: first.sha256,
    }),
    'conflict',
  );
  assert.deepEqual([(await readBack()).text, (await readBack()).sha256], [second.content, second.sha256]);

  for (const args of [
    { app_id: '../sf-pilot', job_id: 'smoke-002', content: 'x' },
    { app_id: 'sf-pilot', job_id: '/etc/passwd', content: 'x' },
    { app_id: 'sf-pilot', job_id: 'smoke-002', content: 'a\0b' },
    { app_id: 'sf-pilot', job_id: 'smoke-002', content: 'x', path: '/tmp/x' },
    { app_id: 'missing-app', job_id: 'smoke-002', content: 'x' },
    { app_id: 'sf-pilot', job_id: 'smoke-002', content: 'я'.repeat(131073) },
  ]) {
    assert.notEqual(await rejectedCode(client, 'factory_write_instruction', args), 'internal_error');
  }
  assert.equal(await rejectedCode(client, 'factory_read_file', { path: 'factory-data/apps/sf-pilot/.env' }), 'forbidden_path');

  const dispatch = (args: Record<string, unknown>) => client.callTool({ name: 'factory_request_dispatch', arguments: args });
  assert.equal(await rejectedCode(client, 'factory_request_dispatch', { app_id: 'sf-pilot', job_id: 'smoke-001', instruction_sha256: first.sha256 }), 'sha256_mismatch');
  assert.equal(await rejectedCode(client, 'factory_request_dispatch', { app_id: 'sf-pilot', job_id: 'smoke-404', instruction_sha256: first.sha256 }), 'not_found');
  for (const args of [
    { app_id: 'sf-pilot', job_id: 'smoke-001', instruction_sha256: second.sha256, command: 'id' },
    { app_id: 'sf-pilot', job_id: 'smoke-001', instruction_sha256: second.sha256, container: 'other' },
  ]) {
    assert.notEqual(await rejectedCode(client, 'factory_request_dispatch', args), 'internal_error');
  }
  assert.deepEqual((await readdir(join(repoRoot, 'factory-data', 'apps', 'sf-pilot', 'jobs', 'smoke-001'))).sort(), ['instruction.md']);

  // With the OpenClaw channel off, the request is recorded and reported as failed, never accepted.
  const failed = await dispatch({ app_id: 'sf-pilot', job_id: 'smoke-001', instruction_sha256: second.sha256 });
  assert.equal(failed.isError ?? false, false);
  const result = failed.structuredContent as { state: string; error: { code: string }; path: string; request_id: string };
  assert.deepEqual([result.state, result.error.code, result.path], ['failed', 'openclaw_unreachable', 'factory-data/apps/sf-pilot/jobs/smoke-001/dispatch.json']);
  const retried = (await dispatch({ app_id: 'sf-pilot', job_id: 'smoke-001', instruction_sha256: second.sha256 })).structuredContent as typeof result;
  assert.equal(retried.request_id, result.request_id);
  const record = (await client.callTool({ name: 'factory_read_file', arguments: { path: result.path } })).structuredContent as { text: string };
  assert.deepEqual(
    (({ state, attempts, request_id }) => ({ state, attempts, request_id }))(JSON.parse(record.text) as Record<string, unknown>),
    { state: 'failed', attempts: 2, request_id: result.request_id },
  );
  assert.equal(
    await rejectedCode(client, 'factory_write_instruction', {
      app_id: 'sf-pilot',
      job_id: 'smoke-001',
      content: first.content,
      expected_sha256: second.sha256,
    }),
    'dispatched',
  );

  await client.close();
  assert.equal(await stopBridge(bridge), 0);
});
