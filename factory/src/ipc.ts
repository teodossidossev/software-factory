// The CLI's channel to `sf serve`: a Unix socket <state dir>/sf.sock (0600), one JSON request
// and one JSON response per connection.
import { chmod, mkdir, rm } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { FactoryError } from './errors.js';
import { internalError } from './http.js';

const MAX_REQUEST_BYTES = 128 * 1024;
// sun_path holds 108 bytes on Linux (104 on macOS), including the terminating NUL.
const MAX_SOCKET_PATH_BYTES = process.platform === 'linux' ? 107 : 103;

export interface IpcRequest {
  command: string;
  args: string[];
}

export type IpcResponse = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

export type IpcHandler = (request: IpcRequest) => Promise<unknown>;

export function socketPath(stateDir: string): string {
  const path = join(stateDir, 'sf.sock');
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new FactoryError('socket_path_too_long', `The socket path ${path} is longer than ${MAX_SOCKET_PATH_BYTES} bytes; use a shorter SF_STATE_DIR.`);
  }
  return path;
}

function probe(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function errorResponse(error: unknown): IpcResponse {
  if (error instanceof FactoryError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  console.error(error);
  return { ok: false, error: internalError() };
}

export interface RunningSocket {
  path: string;
  close(): Promise<void>;
}

export async function listenSocket(stateDir: string, handler: IpcHandler): Promise<RunningSocket> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = socketPath(stateDir);
  if (await probe(path)) {
    throw new FactoryError('serve_running', 'Another sf serve is already listening on the socket.');
  }
  await rm(path, { force: true });
  const server: Server = createServer((socket) => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      input += chunk;
      if (input.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const end = input.indexOf('\n');
      if (end < 0) {
        return;
      }
      socket.removeAllListeners('data');
      let request: IpcRequest;
      try {
        const data = JSON.parse(input.slice(0, end)) as IpcRequest;
        if (typeof data.command !== 'string' || !Array.isArray(data.args) || !data.args.every((arg) => typeof arg === 'string')) {
          throw new Error('bad request');
        }
        request = data;
      } catch { // not JSON or not a request: answered bad_request
        socket.end(`${JSON.stringify({ ok: false, error: { code: 'bad_request', message: 'Expected {"command", "args"}.' } })}\n`);
        return;
      }
      handler(request).then(
        (result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
        (error: unknown) => socket.end(`${JSON.stringify(errorResponse(error))}\n`),
      );
    });
    socket.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
  return {
    path,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        void rm(path, { force: true });
      }),
  };
}

// Sends one request; a missing socket or refused connection means no server is running.
export function callSocket(stateDir: string, request: IpcRequest): Promise<IpcResponse> {
  const path = socketPath(stateDir);
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let output = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => (output += chunk));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        reject(new FactoryError('serve_not_running', 'sf serve is not running.'));
        return;
      }
      reject(error);
    });
    socket.once('end', () => {
      try {
        resolve(JSON.parse(output) as IpcResponse);
      } catch { // not JSON: rejected as bad_response
        reject(new FactoryError('bad_response', 'sf serve sent an unreadable response.'));
      }
    });
  });
}
