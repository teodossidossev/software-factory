// A test authorization server on loopback: an openid-configuration naming jwks_uri, a JWKS with
// one RSA key generated per run (more with addKey) and sign() for RS256 tokens. It counts the
// requests per path, and discovery can be turned off to exercise the jwks.json fallback.
import { createPublicKey, generateKeyPairSync, type KeyObject, sign as signBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const AUDIENCE = 'https://sf.example.test/mcp';

export interface SignOptions {
  kid?: string;
  alg?: string;
  // Signs with this private key instead of the key named by kid.
  key?: KeyObject;
}

export interface FakeAs {
  // "http://127.0.0.1:<port>/", trailing slash included, as Auth0 writes iss.
  issuer: string;
  kid: string;
  // Request counts by path.
  requests: Map<string, number>;
  // false answers 404 on the openid-configuration.
  discovery: boolean;
  // false answers 500 on the JWKS.
  jwksUp: boolean;
  sign(claims: Record<string, unknown>, options?: SignOptions): string;
  // Claims of a valid token for AUDIENCE, with overrides (undefined removes a claim).
  claims(overrides?: Record<string, unknown>): Record<string, unknown>;
  // Generates a key; served in the JWKS only once published.
  addKey(publish: boolean): string;
  publish(kid: string): void;
  close(): Promise<void>;
}

function newKey(): KeyObject {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
}

export async function startFakeAs(): Promise<FakeAs> {
  const privateKeys = new Map<string, KeyObject>();
  const published = new Set<string>();
  const requests = new Map<string, number>();
  let counter = 0;
  const addKey = (publish: boolean): string => {
    counter += 1;
    const kid = `test-key-${counter}`;
    privateKeys.set(kid, newKey());
    if (publish) {
      published.add(kid);
    }
    return kid;
  };
  const kid = addKey(true);

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    requests.set(path, (requests.get(path) ?? 0) + 1);
    if (path === '/.well-known/openid-configuration' && fake.discovery) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ issuer: fake.issuer, jwks_uri: `${fake.issuer}keys/jwks` }));
      return;
    }
    if ((path === '/keys/jwks' || path === '/.well-known/jwks.json') && fake.jwksUp) {
      const keys = [...published].map((id) => ({ ...createPublicKey(privateKeys.get(id)!).export({ format: 'jwk' }), kid: id, use: 'sig', alg: 'RS256' }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys }));
      return;
    }
    res.writeHead(path.includes('jwks') ? 500 : 404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const fake: FakeAs = {
    issuer: `http://127.0.0.1:${port}/`,
    kid,
    requests,
    discovery: true,
    jwksUp: true,
    sign(claims, options = {}) {
      const keyId = options.kid ?? kid;
      const header = { alg: options.alg ?? 'RS256', typ: 'JWT', kid: keyId };
      const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
      const signed = `${encode(header)}.${encode(claims)}`;
      const key = options.key ?? privateKeys.get(keyId) ?? privateKeys.get(kid)!;
      return `${signed}.${signBytes('RSA-SHA256', Buffer.from(signed), key).toString('base64url')}`;
    },
    claims(overrides = {}) {
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        iss: fake.issuer, sub: 'auth0|user-1', aud: [AUDIENCE, `${fake.issuer}userinfo`], iat: now, exp: now + 3600, scope: 'openid profile email',
      };
      for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) {
          delete claims[name];
        } else {
          claims[name] = value;
        }
      }
      return claims;
    },
    addKey,
    publish(id) {
      published.add(id);
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
  return fake;
}

export { newKey };
