// A loopback webhook receiver for the MCP Events tests. It records every request, verifies the
// Standard Webhooks signature itself (independently of src/events.ts) with its own secret, and
// answers from a plan: each request takes the next answer, then 200. A 200 to a verification
// request echoes the challenge.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// 200 (echoing a challenge), 302 (a redirect to /elsewhere), 410, 413 or 500; "hang" never
// answers; "wrong_challenge" answers 200 with another challenge.
export type SinkAnswer = 200 | 302 | 410 | 413 | 500 | 'hang' | 'wrong_challenge';

export interface SinkRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  json: any;
  // The webhook-signature header holds a valid v1 signature of this sink's secret.
  signatureValid: boolean;
  answer: SinkAnswer;
}

export interface WebhookSink {
  // "http://127.0.0.1:<port><path>".
  url(path: string): string;
  // "whsec_" + base64 of 32 random bytes.
  secret: string;
  requests: SinkRequest[];
  // Answers for the next requests, consumed in order.
  plan: SinkAnswer[];
  // Requests to path; waits until there are at least count of them (5 s default; then fails).
  waitFor(path: string, count: number, timeoutMs?: number): Promise<SinkRequest[]>;
  close(): Promise<void>;
}

function verify(secret: string, headers: IncomingHttpHeaders, body: string): boolean {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = headers['webhook-signature'];
  if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signatures !== 'string') {
    return false;
  }
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return false;
  }
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || value === undefined) {
      return false;
    }
    const actual = Buffer.from(value, 'base64');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

export async function startWebhookSink(): Promise<WebhookSink> {
  const hanging = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json: any;
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
      const answer = sink.plan.shift() ?? 200;
      sink.requests.push({ path: req.url ?? '/', headers: req.headers, body, json, signatureValid: verify(sink.secret, req.headers, body), answer });
      if (answer === 'hang') {
        hanging.add(res);
        return;
      }
      if (answer === 302) {
        res.writeHead(302, { location: '/elsewhere' }).end();
        return;
      }
      if (answer === 200 || answer === 'wrong_challenge') {
        const challenge = json?.type === 'verification' ? (answer === 200 ? json.challenge : 'not-the-challenge') : undefined;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(challenge !== undefined ? { challenge } : { ok: true }));
        return;
      }
      res.writeHead(answer).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const sink: WebhookSink = {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    secret: `whsec_${randomBytes(32).toString('base64')}`,
    requests: [],
    plan: [],
    async waitFor(path, count, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const matching = sink.requests.filter((request) => request.path === path);
        if (matching.length >= count) {
          return matching;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${count} requests to ${path}; got ${matching.length}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    close() {
      for (const res of hanging) {
        res.destroy();
      }
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
  return sink;
}
