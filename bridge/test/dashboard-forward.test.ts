// Contract tests for scripts/openclaw/dashboard-forward.mjs. The docker exec pipe
// is replaced by the same pipe script run with local Node against a local echo
// server, so only the forwarder's own behaviour is under test.
import assert from 'node:assert/strict';
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface Forwarder {
  address: AddressInfo;
  readonly active: number;
  close(): Promise<void>;
}
interface ForwarderModule {
  PIPE_SCRIPT: string;
  DOCKER_PIPE_ARGV: string[];
  LISTEN_HOST: string;
  LISTEN_PORT: number;
  startForwarder(options: { host?: string; port?: number; pipeArgv?: string[]; maxConnections?: number }): Promise<Forwarder>;
}

const MODULE = fileURLToPath(new URL('../../../scripts/openclaw/dashboard-forward.mjs', import.meta.url));
let forward: ForwarderModule;
let target: Server;
let targetPort: number;
const targetSockets = new Set<Socket>();

// Same pipe as in the container, pointed at the local target port.
function localPipe(): string[] {
  return [process.execPath, '-e', forward.PIPE_SCRIPT.replace('connect(18789,', `connect(${targetPort},`)];
}

function exchange(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect(port, '127.0.0.1', () => {
      socket.end(payload);
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error('condition not reached');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

before(async () => {
  forward = (await import(MODULE)) as ForwarderModule;
  // Echo server that answers after the client half-closes, like a request/response.
  target = createServer((socket) => {
    targetSockets.add(socket);
    socket.on('close', () => targetSockets.delete(socket));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => socket.end(Buffer.concat([Buffer.from('echo:'), ...chunks])));
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  targetPort = (target.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => target.close(() => resolve()));
});

test('the production command is fixed: docker compose exec of the pipe to the in-container loopback', () => {
  assert.equal(forward.LISTEN_HOST, '127.0.0.1');
  assert.equal(forward.LISTEN_PORT, 18789);
  const argv = forward.DOCKER_PIPE_ARGV;
  assert.equal(argv[0], 'docker');
  assert.deepEqual(argv.slice(1, 3), ['compose', '-f']);
  assert.match(argv[3]!, /deploy\/openclaw\/compose\.yaml$/);
  assert.deepEqual(argv.slice(4), ['-p', 'software-factory-openclaw', 'exec', '-T', 'gateway', 'node', '-e', forward.PIPE_SCRIPT]);
  assert.match(forward.PIPE_SCRIPT, /connect\(18789,"127\.0\.0\.1"\)/);
});

test('relays bytes unchanged in both directions, including binary data and half-close', async () => {
  const forwarder = await forward.startForwarder({ port: 0, pipeArgv: localPipe() });
  try {
    const payload = Buffer.concat([Buffer.from('GET / HTTP/1.1\r\n\r\n'), Buffer.from([0, 1, 2, 255, 254]), Buffer.from('ж🚀')]);
    const reply = await exchange(forwarder.address.port, payload);
    assert.ok(reply.equals(Buffer.concat([Buffer.from('echo:'), payload])));
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    assert.equal((await exchange(forwarder.address.port, big)).length, big.length + 5);
    await waitFor(() => forwarder.active === 0);
  } finally {
    await forwarder.close();
  }
});

test('listens on 127.0.0.1 only', async () => {
  const forwarder = await forward.startForwarder({ port: 0, pipeArgv: localPipe() });
  try {
    assert.equal(forwarder.address.address, '127.0.0.1');
    const external = Object.values(networkInterfaces())
      .flat()
      .filter((info): info is NetworkInterfaceInfo => info !== undefined && !info.internal && info.family === 'IPv4');
    for (const info of external) {
      const reachable = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: info.address, port: forwarder.address.port, timeout: 1000 });
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
        socket.once('timeout', () => {
          socket.destroy();
          resolve(false);
        });
      });
      assert.equal(reachable, false, `reachable via ${info.address}`);
    }
  } finally {
    await forwarder.close();
  }
});

test('caps open connections and cleans up the pipe when either side goes away', async () => {
  const forwarder = await forward.startForwarder({ port: 0, pipeArgv: localPipe(), maxConnections: 2 });
  const open: Socket[] = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      open.push(await new Promise<Socket>((resolve) => {
        const socket = connect(forwarder.address.port, '127.0.0.1', () => resolve(socket));
      }));
    }
    await waitFor(() => targetSockets.size === 2);
    // The third connection is closed without a pipe.
    const refused = await exchange(forwarder.address.port, Buffer.from('third'));
    assert.equal(refused.length, 0);
    assert.equal(forwarder.active, 2);

    // Client goes away: its pipe process ends and the target connection closes.
    open[0]!.destroy();
    await waitFor(() => forwarder.active === 1 && targetSockets.size === 1);

    // Far end goes away: the client connection is closed.
    const closed = new Promise<void>((resolve) => open[1]!.on('close', () => resolve()));
    open[1]!.on('error', () => undefined);
    for (const socket of targetSockets) {
      socket.destroy();
    }
    await closed;
    await waitFor(() => forwarder.active === 0);
  } finally {
    for (const socket of open) {
      socket.destroy();
    }
    await forwarder.close();
  }
});

test('a busy port is reported, not taken over', async () => {
  const first = await forward.startForwarder({ port: 0, pipeArgv: localPipe() });
  try {
    await assert.rejects(forward.startForwarder({ port: first.address.port, pipeArgv: localPipe() }), { code: 'EADDRINUSE' });
  } finally {
    await first.close();
  }
});
