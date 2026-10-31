#!/usr/bin/env node
// SF-005-UI: host-loopback forwarder for the OpenClaw Dashboard (Control UI).
//
//   node scripts/openclaw/dashboard-forward.mjs     (foreground; Ctrl+C stops it)
//
// Listens on 127.0.0.1:18789 only. Each accepted TCP connection is carried by
// one `docker compose exec -T gateway node -e <pipe>` process to the Gateway's
// own loopback listener (127.0.0.1:18789 inside the container), so the
// container keeps `network_mode: none`: no published port, no Docker network,
// no egress. Bytes are relayed unchanged (HTTP and WebSocket); nothing is
// logged except connection counts. Docker access is the same trust boundary the
// bridge already uses. Not started automatically.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LISTEN_HOST = '127.0.0.1';
export const LISTEN_PORT = 18789;
// Each connection costs one Node process inside the container (pids_limit 512, mem_limit 2g).
export const MAX_CONNECTIONS = 16;
const CLOSE_GRACE_MS = 5000;
const STOP_GRACE_MS = 2000;

// Runs inside the container: joins stdin/stdout to the Gateway's loopback port.
// On close it exits only after stdout is flushed; exiting at once could drop the
// tail of a response.
export const PIPE_SCRIPT =
  'const s=require("net").connect(18789,"127.0.0.1");' +
  'process.stdin.pipe(s);s.pipe(process.stdout);' +
  's.on("error",()=>process.exit(1));s.on("close",()=>process.stdout.end(()=>process.exit(0)));';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DOCKER_PIPE_ARGV = [
  'docker',
  ...['compose', '-f', join(REPO_ROOT, 'deploy', 'openclaw', 'compose.yaml'), '-p', 'software-factory-openclaw'],
  ...['exec', '-T', 'gateway', 'node', '-e', PIPE_SCRIPT],
];

// pipeArgv is the fixed command whose stdin/stdout become the far end of each connection.
export function startForwarder({ host = LISTEN_HOST, port = LISTEN_PORT, pipeArgv = DOCKER_PIPE_ARGV, maxConnections = MAX_CONNECTIONS, log = () => {} } = {}) {
  let active = 0;
  const children = new Set();
  // allowHalfOpen: a client that half-closes (end of request) still receives the full reply.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (active >= maxConnections) {
      log(`refused a connection: ${active} already open`);
      socket.destroy();
      return;
    }
    active += 1;
    const child = spawn(pipeArgv[0], pipeArgv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
    children.add(child);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    // EPIPE/ECONNRESET on either side only ends this connection.
    child.stdin.on('error', () => undefined);
    // Client gone: EOF lets the in-container pipe close the Gateway connection and
    // exit on its own; the docker client is killed only if that does not happen.
    const stopPipe = () => {
      child.stdin.end();
      setTimeout(() => child.kill(), STOP_GRACE_MS).unref();
    };
    socket.on('error', stopPipe);
    socket.on('close', stopPipe);
    child.on('error', () => socket.destroy());
    child.on('close', () => {
      children.delete(child);
      active -= 1;
      // end(), not destroy(): relayed bytes still queued for the client must arrive.
      socket.end();
      setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({
        address: server.address(),
        get active() {
          return active;
        },
        close: () =>
          new Promise((done) => {
            for (const child of children) child.kill();
            server.close(() => done());
          }),
      });
    });
  });
}

async function main() {
  let forwarder;
  try {
    forwarder = await startForwarder({ log: (line) => console.error(`dashboard-forward: ${line}`) });
  } catch (error) {
    console.error(`dashboard-forward: cannot listen on ${LISTEN_HOST}:${LISTEN_PORT} (${error.code ?? error.message})`);
    process.exit(1);
  }
  console.log(`dashboard-forward: http://${LISTEN_HOST}:${LISTEN_PORT}/ -> gateway container loopback (Ctrl+C stops)`);
  const stop = () => forwarder.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
