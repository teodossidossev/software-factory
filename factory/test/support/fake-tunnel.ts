// A fake tunnel script (named sf-tunnel.sh, run as SF_TUNNEL_SCRIPT) that is its own tunnel
// client's admin endpoint: it logs each start and SIGTERM, prints the MCP token on both streams (the
// relay must show <token>), and serves /readyz (200) and /metrics (a poll of OpenAI in the future, so
// any test clock reads it as fresh) on its port. With its fail marker it fails its check at once.
import { appendFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeTunnel {
  dir: string;
  script: string;
  // host:port of its admin endpoint (SF_TUNNEL_HEALTH).
  address: string;
  failMarker: string;
  // The pids of its starts, in order.
  starts(): Promise<number[]>;
  // The pids that got SIGTERM.
  terms(): Promise<number[]>;
}

// A port nothing listens on right now.
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// tokenFile: the state directory's mcp-token, printed when it exists.
export async function fakeTunnel(tokenFile: string): Promise<FakeTunnel> {
  // Outside the package: the script is CommonJS, and no package.json above it says otherwise.
  const dir = await mkdtemp(join(tmpdir(), 'sf-fake-tunnel-'));
  const script = join(dir, 'sf-tunnel.sh');
  const log = join(dir, 'tunnel.log');
  const failMarker = join(dir, 'fail');
  const port = await freePort();
  appendFileSync(log, '');
  await writeFile(script, `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const http = require('node:http');
const log = ${JSON.stringify(log)};
appendFileSync(log, 'start ' + process.pid + ' ' + process.argv.slice(2).join(' ') + '\\n');
if (existsSync(${JSON.stringify(failMarker)})) {
  console.error('sf-tunnel: FAIL: fake check failed');
  process.exit(1);
}
const tokenFile = ${JSON.stringify(tokenFile)};
const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
console.log('sf-tunnel: ok: fake tunnel up, url http://127.0.0.1:1/mcp/' + token);
console.error('fake warning ' + token);
process.on('SIGTERM', () => {
  appendFileSync(log, 'term ' + process.pid + '\\n');
  process.exit(0);
});
http.createServer((req, res) => {
  if (req.url === '/readyz') {
    res.end('ok');
  } else if (req.url === '/metrics') {
    res.end('commands_poll_last_successful_timestamp_seconds ' + (Math.round(Date.now() / 1000) + 86400) + '\\n');
  } else {
    res.statusCode = 404;
    res.end();
  }
}).listen(${port}, '127.0.0.1');
`);
  await chmod(script, 0o755);
  const pids = async (kind: string): Promise<number[]> => (await readFile(log, 'utf8')).split('\n').filter((line) => line.startsWith(`${kind} `)).map((line) => Number(line.split(' ')[1]));
  return { dir, script, address: `127.0.0.1:${port}`, failMarker, starts: () => pids('start'), terms: () => pids('term') };
}

// Whether something answers http://address/readyz.
export async function answers(address: string): Promise<boolean> {
  try {
    await (await fetch(`http://${address}/readyz`, { signal: AbortSignal.timeout(1000) })).text();
    return true;
  } catch {
    return false;
  }
}

// Waits until probe holds (15 s).
export async function until(probe: () => Promise<boolean> | boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Whether the process is alive (not a zombie).
export async function processAlive(pid: number): Promise<boolean> {
  const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => undefined);
  return status !== undefined && !/^State:\s*Z/m.test(status);
}
