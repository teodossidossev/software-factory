// Unit tests of src/auth.ts against the test authorization server: every rejection reason, the
// key cache and the refetch rule, and the SF_AUTH_* configuration.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AuthError, type AuthErrorReason, createVerifier, type FetchImpl, KEY_CACHE_MS, NETWORK_TIMEOUT_MS, REFETCH_INTERVAL_MS } from '../src/auth.js';
import { authConfig, DEFAULT_OPEN_METHODS } from '../src/config.js';
import { FactoryError } from '../src/errors.js';
import { AUDIENCE, type FakeAs, newKey, startFakeAs } from './support/fake-as.js';

let as: FakeAs;

before(async () => {
  as = await startFakeAs();
});

after(async () => {
  await as.close();
});

// A verifier with its own cache and a clock the test moves.
function verifier(start = Date.now()) {
  const clock = { now: start };
  const verify = createVerifier({ issuer: as.issuer, audience: AUDIENCE }, undefined, () => clock.now);
  return { verify, clock };
}

async function rejected(promise: Promise<unknown>, reason: AuthErrorReason, token?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AuthError, String(error));
    assert.equal(error.reason, reason);
    if (token !== undefined && token !== '') {
      assert.ok(!error.message.includes(token), 'the message must not echo the token');
    }
    return true;
  });
}

const count = (path: string): number => as.requests.get(path) ?? 0;

test('a valid token gives the principal', async () => {
  const { verify } = verifier();
  const claims = as.claims();
  assert.deepEqual(await verify(as.sign(claims)), { sub: 'auth0|user-1', scopes: ['openid', 'profile', 'email'], expiresAt: claims.exp });
  // aud as a plain string, no scope claim.
  assert.deepEqual(await verify(as.sign(as.claims({ aud: AUDIENCE, scope: undefined }))), { sub: 'auth0|user-1', scopes: [], expiresAt: claims.exp });
});

test('every rejection reason', async () => {
  const { verify } = verifier();
  const now = Math.floor(Date.now() / 1000);
  const good = as.sign(as.claims());
  const [header, payload, signature] = good.split('.') as [string, string, string];
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

  for (const token of ['', 'abc', 'a.b', `${header}.${payload}`, `${header}.${payload}.${signature}.x`, `${header}.@@@.${signature}`, `${encode([1])}.${payload}.${signature}`, `${header}.${Buffer.from('not json').toString('base64url')}.${signature}`, `${header}.${payload}.`, 'x'.repeat(20000)]) {
    await rejected(verify(token), 'malformed', token);
  }
  await rejected(verify(as.sign(as.claims(), { alg: 'HS256' })), 'unsupported_alg');
  await rejected(verify(`${encode({ alg: 'none', kid: as.kid })}.${payload}.${signature}`), 'unsupported_alg');
  await rejected(verify(`${encode({ alg: 'RS256' })}.${payload}.${signature}`), 'unknown_kid');
  await rejected(verify(as.sign(as.claims(), { kid: 'no-such-key' })), 'unknown_kid');
  const foreign = as.sign(as.claims(), { key: newKey() });
  await rejected(verify(foreign), 'bad_signature', foreign);
  await rejected(verify(`${header}.${encode(as.claims({ sub: 'auth0|someone-else' }))}.${signature}`), 'bad_signature');
  await rejected(verify(as.sign(as.claims({ iss: as.issuer.slice(0, -1) }))), 'wrong_issuer');
  await rejected(verify(as.sign(as.claims({ iss: 'https://other.example.test/' }))), 'wrong_issuer');
  await rejected(verify(as.sign(as.claims({ aud: 'https://other.example.test/mcp' }))), 'wrong_audience');
  await rejected(verify(as.sign(as.claims({ aud: ['https://other.example.test/mcp'] }))), 'wrong_audience');
  await rejected(verify(as.sign(as.claims({ aud: undefined }))), 'wrong_audience');
  await rejected(verify(as.sign(as.claims({ exp: now - 61 }))), 'expired');
  await rejected(verify(as.sign(as.claims({ exp: undefined }))), 'expired');
  await rejected(verify(as.sign(as.claims({ exp: String(now + 3600) }))), 'expired');
  await rejected(verify(as.sign(as.claims({ nbf: now + 120 }))), 'not_yet_valid');
  await rejected(verify(as.sign(as.claims({ sub: undefined }))), 'missing_sub');
  await rejected(verify(as.sign(as.claims({ sub: '' }))), 'missing_sub');
  // Inside the 60 s leeway.
  assert.equal((await verify(as.sign(as.claims({ exp: now - 30 })))).sub, 'auth0|user-1');
  assert.equal((await verify(as.sign(as.claims({ nbf: now + 30 })))).sub, 'auth0|user-1');
});

test('keys are cached for an hour; an unknown kid refetches once per minute', async () => {
  const { verify, clock } = verifier();
  // Valid past the clock moves below.
  const longLived = (): Record<string, unknown> => as.claims({ exp: Math.floor(Date.now() / 1000) + 3 * 3600 });
  const discovery = count('/.well-known/openid-configuration');
  const jwks = count('/keys/jwks');
  await verify(as.sign(longLived()));
  await verify(as.sign(longLived()));
  assert.equal(count('/.well-known/openid-configuration'), discovery + 1);
  assert.equal(count('/keys/jwks'), jwks + 1);

  // A rotated key that is not published yet: one refetch, then none within the minute.
  const rotated = as.addKey(false);
  await rejected(verify(as.sign(longLived(), { kid: rotated })), 'unknown_kid');
  assert.equal(count('/keys/jwks'), jwks + 2);
  as.publish(rotated);
  clock.now += REFETCH_INTERVAL_MS - 1000;
  await rejected(verify(as.sign(longLived(), { kid: rotated })), 'unknown_kid');
  assert.equal(count('/keys/jwks'), jwks + 2);
  clock.now += 1000;
  assert.equal((await verify(as.sign(longLived(), { kid: rotated }))).sub, 'auth0|user-1');
  assert.equal(count('/keys/jwks'), jwks + 3);
  // The discovery document is read once.
  assert.equal(count('/.well-known/openid-configuration'), discovery + 1);

  // Known kids need no fetch until the hour is over.
  clock.now += KEY_CACHE_MS - 1000;
  await verify(as.sign(longLived()));
  assert.equal(count('/keys/jwks'), jwks + 3);
  clock.now += 1000;
  await verify(as.sign(longLived()));
  assert.equal(count('/keys/jwks'), jwks + 4);
});

test('without discovery the keys come from <issuer>.well-known/jwks.json', async () => {
  as.discovery = false;
  try {
    const { verify } = verifier();
    const fallback = count('/.well-known/jwks.json');
    assert.equal((await verify(as.sign(as.claims()))).sub, 'auth0|user-1');
    assert.equal(count('/.well-known/jwks.json'), fallback + 1);
  } finally {
    as.discovery = true;
  }
});

test('an unreachable JWKS is jwks_unavailable, retried at most once per minute', async () => {
  as.jwksUp = false;
  try {
    const { verify, clock } = verifier();
    const jwks = count('/keys/jwks');
    await rejected(verify(as.sign(as.claims())), 'jwks_unavailable');
    await rejected(verify(as.sign(as.claims())), 'jwks_unavailable');
    assert.equal(count('/keys/jwks'), jwks + 1);
    as.jwksUp = true;
    clock.now += REFETCH_INTERVAL_MS;
    assert.equal((await verify(as.sign(as.claims()))).sub, 'auth0|user-1');
  } finally {
    as.jwksUp = true;
  }
});

test('network calls carry a timeout signal', async () => {
  const seen: Array<{ url: string; signal: AbortSignal }> = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    seen.push({ url, signal: init.signal });
    return fetch(url, init);
  };
  const verify = createVerifier({ issuer: as.issuer, audience: AUDIENCE }, fetchImpl);
  await verify(as.sign(as.claims()));
  assert.deepEqual(seen.map((entry) => entry.url), [`${as.issuer}.well-known/openid-configuration`, `${as.issuer}keys/jwks`]);
  assert.ok(seen.every((entry) => entry.signal instanceof AbortSignal && !entry.signal.aborted));
  assert.equal(NETWORK_TIMEOUT_MS, 10_000);
});

test('SF_AUTH_* configuration', () => {
  assert.equal(authConfig({}), undefined);
  assert.equal(authConfig({ SF_AUTH_ISSUER: '', SF_AUTH_AUDIENCE: AUDIENCE }), undefined);
  const issuer = 'https://tenant.eu.auth0.com/';
  assert.deepEqual(authConfig({ SF_AUTH_ISSUER: issuer, SF_AUTH_AUDIENCE: AUDIENCE }), {
    issuer, audience: AUDIENCE, resource: AUDIENCE, openMethods: DEFAULT_OPEN_METHODS,
  });
  assert.deepEqual(authConfig({ SF_AUTH_ISSUER: issuer, SF_AUTH_AUDIENCE: 'factory-api', SF_AUTH_RESOURCE: 'https://sf.example.test', SF_AUTH_OPEN_METHODS: ' initialize, ping ,' }), {
    issuer, audience: 'factory-api', resource: 'https://sf.example.test', openMethods: ['initialize', 'ping'],
  });
  const invalid = (env: NodeJS.ProcessEnv): void => {
    assert.throws(() => authConfig(env), (error: unknown) => error instanceof FactoryError && error.code === 'invalid_config');
  };
  invalid({ SF_AUTH_ISSUER: issuer });
  invalid({ SF_AUTH_ISSUER: 'http://tenant.eu.auth0.com/', SF_AUTH_AUDIENCE: AUDIENCE });
  invalid({ SF_AUTH_ISSUER: 'not a url', SF_AUTH_AUDIENCE: AUDIENCE });
  invalid({ SF_AUTH_ISSUER: `${issuer}?x=1`, SF_AUTH_AUDIENCE: AUDIENCE });
  // A non-URL audience needs an explicit resource.
  invalid({ SF_AUTH_ISSUER: issuer, SF_AUTH_AUDIENCE: 'factory-api' });
  invalid({ SF_AUTH_ISSUER: issuer, SF_AUTH_AUDIENCE: AUDIENCE, SF_AUTH_OPEN_METHODS: 'initialize,tools list' });
});
