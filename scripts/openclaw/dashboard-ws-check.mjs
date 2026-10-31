#!/usr/bin/env node
// SF-005-UI: one Gateway WebSocket handshake through the host-loopback Dashboard
// address, for verification. Prints one JSON line with the outcome only
// (ok, error code, detail code, granted role/scopes); never a credential.
//
//   node scripts/openclaw/dashboard-ws-check.mjs no-token
//   node scripts/openclaw/dashboard-ws-check.mjs wrong-token
//   SF_GATEWAY_TOKEN=... node scripts/openclaw/dashboard-ws-check.mjs token
//
// "token" reads the shared Gateway token from SF_GATEWAY_TOKEN, which the
// caller fills from the state volume without echoing it.
import { randomBytes } from 'node:crypto';

const WS_URL = 'ws://127.0.0.1:18789/';
const TIMEOUT_MS = 20_000;

const mode = process.argv[2];
const auth = {
  'no-token': undefined,
  'wrong-token': { token: randomBytes(32).toString('hex') },
  token: process.env.SF_GATEWAY_TOKEN ? { token: process.env.SF_GATEWAY_TOKEN } : null,
}[mode];
if (auth === null || !['no-token', 'wrong-token', 'token'].includes(mode)) {
  console.log(JSON.stringify({ case: mode ?? null, error: 'usage: no-token | wrong-token | token (with SF_GATEWAY_TOKEN)' }));
  process.exit(2);
}

const outcome = await new Promise((resolve) => {
  const ws = new WebSocket(WS_URL);
  const timer = setTimeout(() => {
    ws.close();
    resolve({ error: 'timeout' });
  }, TIMEOUT_MS);
  ws.onerror = () => {
    clearTimeout(timer);
    resolve({ error: 'connection failed' });
  };
  ws.onmessage = (message) => {
    let frame;
    try {
      frame = JSON.parse(message.data);
    } catch {
      return;
    }
    if (frame.type === 'event' && frame.event === 'connect.challenge') {
      ws.send(
        JSON.stringify({
          type: 'req',
          id: 'sf-check',
          method: 'connect',
          params: {
            minProtocol: 4,
            maxProtocol: 4,
            client: { id: 'cli', version: 'sf-005-ui-check', platform: 'linux', mode: 'cli' },
            role: 'operator',
            scopes: ['operator.read'],
            ...(auth ? { auth } : {}),
          },
        }),
      );
    } else if (frame.type === 'res' && frame.id === 'sf-check') {
      clearTimeout(timer);
      ws.close();
      resolve({
        ok: frame.ok === true,
        code: frame.error?.code ?? null,
        details: frame.error?.details?.code ?? null,
        role: frame.payload?.auth?.role ?? null,
        scopes: frame.payload?.auth?.scopes ?? null,
      });
    }
  };
});
console.log(JSON.stringify({ case: mode, url: WS_URL, ...outcome }));
process.exit(0);
