// The health checks' fakes: every check's dependency answering ok (or off), and an HTTP server on
// loopback (a tunnel client's admin endpoint).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchText, type HealthDeps } from '../../src/health.js';

const MIN = 60_000;

// An HTTP server on loopback answering each path with handler's status and text.
export async function fakeServer(handler: (path: string) => { status: number; text: string }): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const { status, text } = handler(req.url ?? '/');
    res.writeHead(status, { 'content-type': 'text/plain' }).end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// Every check's dependency, each answering ok (or off), with the parts a test changes.
export function deps(now: () => Date, overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    now,
    mcp: async () => ({ port: 8787, token: 't' }),
    probe: async () => ({ result: 'answers' }),
    tunnelProfile: '/nonexistent/software-factory.yaml',
    tunnelAddress: '127.0.0.1:1',
    fetch: fetchText,
    packageRoot: '/nonexistent',
    tunnelScript: '/nonexistent/sf-tunnel.sh',
    jobs: { jobs: { list: async () => [], eventsPath: () => '/nonexistent' }, testTimeoutMs: 30 * MIN, runnerAlive: async () => true },
    queue: async () => ({ view: { held: false, limit_hold: null, running: 0, entries: [] }, lastStart: undefined, newestJob: undefined }),
    remote: () => ({ origins: [], port: 8789 }),
    answers: async () => true,
    run: async () => ({ code: 0, stdout: '' }),
    logins: { claudePath: '/bin/claude', codexPath: undefined, forgeTargets: async () => [], checkToken: async () => ({ ok: true }) },
    diskPaths: ['/state'],
    freeSpace: async () => ({ device: 1, free: 100 * 1024 ** 3, total: 200 * 1024 ** 3 }),
    sandboxes: async () => ({ found: 0, persisting: [] }),
    configDir: '/nonexistent-config',
    digests: { list: async () => [] },
    ...overrides,
  };
}

