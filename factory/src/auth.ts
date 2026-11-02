// Bearer token verification for the MCP endpoint: RS256 JWTs issued by the configured
// authorization server (Auth0), checked against its JWKS with node:crypto. No HTTP server and no
// MCP code: server.ts wires the verifier into the listener, `sf auth-test` calls it directly.
// The network calls run in this process (sf serve or sf auth-test), never in the Implementer's
// environment.
import { createPublicKey, type JsonWebKey, type KeyObject, verify as verifySignature } from 'node:crypto';

export interface AuthConfig {
  // The issuer exactly as the tokens' iss, e.g. "https://tenant.eu.auth0.com/".
  issuer: string;
  // The API identifier that must be in aud.
  audience: string;
  // The resource value of the protected resource metadata.
  resource: string;
  // MCP methods allowed without a token.
  openMethods: string[];
}

export interface Principal {
  sub: string;
  scopes: string[];
  // Seconds since the epoch (the token's exp).
  expiresAt: number;
}

export type Verify = (token: string) => Promise<Principal>;

export type FetchImpl = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

// Why a token was rejected; jwks_unavailable is the only one that is not the token's fault.
export type AuthErrorReason =
  | 'malformed'
  | 'unsupported_alg'
  | 'unknown_kid'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'missing_sub'
  | 'jwks_unavailable';

// Every rejection. The message names the reason only, never the token or its claims.
export class AuthError extends Error {
  readonly reason: AuthErrorReason;

  constructor(reason: AuthErrorReason) {
    super(`Token rejected: ${reason}.`);
    this.name = 'AuthError';
    this.reason = reason;
  }
}

export const NETWORK_TIMEOUT_MS = 10_000;
export const KEY_CACHE_MS = 60 * 60 * 1000;
export const REFETCH_INTERVAL_MS = 60 * 1000;
export const LEEWAY_SECONDS = 60;
// Auth0 access tokens are a few kilobytes; anything far larger is not one.
const MAX_TOKEN_CHARS = 16 * 1024;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

function decodeJson(segment: string): Record<string, unknown> {
  if (!SEGMENT.test(segment)) {
    throw new AuthError('malformed');
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new AuthError('malformed');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuthError('malformed');
  }
  return value as Record<string, unknown>;
}

// "<issuer>.well-known/<name>", with a slash inserted when the issuer has none at the end.
function wellKnown(issuer: string, name: string): string {
  return `${issuer}${issuer.endsWith('/') ? '' : '/'}.well-known/${name}`;
}

async function getJson(fetchImpl: FetchImpl, url: string): Promise<unknown> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`GET ${url} answered ${response.status}`);
  }
  return response.json();
}

// The RSA signing keys of a JWKS document by kid; other and unusable keys are skipped.
function signingKeys(document: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const list = (document as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) {
    throw new Error('the JWKS has no keys array');
  }
  for (const jwk of list as Array<Record<string, unknown>>) {
    if (typeof jwk !== 'object' || jwk === null || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.use !== undefined && jwk.use !== 'sig')) {
      continue;
    }
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }));
    } catch {
      // A key node:crypto cannot import cannot verify anything either.
    }
  }
  return keys;
}

// The verifier for one issuer and audience. fetchImpl and clock (milliseconds) are for tests.
export function createVerifier(
  config: Pick<AuthConfig, 'issuer' | 'audience'>,
  fetchImpl: FetchImpl = (url, init) => fetch(url, init),
  clock: () => number = Date.now,
): Verify {
  // Resolved from the openid-configuration once a key fetch through it succeeded.
  let jwksUri: string | undefined;
  let keys = new Map<string, KeyObject>();
  // Times of the last successful key fetch, of the last failed one (cleared by a success) and of
  // the last refetch for an unknown kid.
  let fetchedAt: number | undefined;
  let failedAt: number | undefined;
  let refetchedAt: number | undefined;
  let inFlight: Promise<void> | undefined;

  const resolveJwksUri = async (): Promise<string> => {
    if (jwksUri !== undefined) {
      return jwksUri;
    }
    try {
      const discovery = (await getJson(fetchImpl, wellKnown(config.issuer, 'openid-configuration'))) as { jwks_uri?: unknown } | null;
      if (typeof discovery?.jwks_uri === 'string' && URL.canParse(discovery.jwks_uri)) {
        return discovery.jwks_uri;
      }
    } catch {
      // Falls back to the conventional location below.
    }
    return wellKnown(config.issuer, 'jwks.json');
  };

  const refresh = (): Promise<void> => {
    inFlight ??= (async () => {
      try {
        const uri = await resolveJwksUri();
        keys = signingKeys(await getJson(fetchImpl, uri));
        jwksUri = uri;
        fetchedAt = clock();
        failedAt = undefined;
      } catch (error) {
        failedAt = clock();
        console.error(`sf: fetching the authorization server's keys failed: ${(error as Error).message}`);
        throw new AuthError('jwks_unavailable');
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  const recently = (time: number | undefined): boolean => time !== undefined && clock() - time < REFETCH_INTERVAL_MS;

  const keyFor = async (kid: string): Promise<KeyObject> => {
    if (fetchedAt === undefined || clock() - fetchedAt >= KEY_CACHE_MS) {
      // After a failed fetch the authorization server is asked again at most once per minute.
      if (inFlight === undefined && recently(failedAt)) {
        throw new AuthError('jwks_unavailable');
      }
      await refresh();
    }
    let key = keys.get(kid);
    if (key === undefined && (inFlight !== undefined || !recently(refetchedAt))) {
      // An unknown kid may be a rotated key: one refetch, at most once per minute.
      // Joining a fetch already under way does not count as a refetch.
      if (inFlight === undefined) {
        refetchedAt = clock();
      }
      await refresh();
      key = keys.get(kid);
    }
    if (key === undefined) {
      throw new AuthError('unknown_kid');
    }
    return key;
  };

  return async (token: string): Promise<Principal> => {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) {
      throw new AuthError('malformed');
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new AuthError('malformed');
    }
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = decodeJson(headerPart);
    const payload = decodeJson(payloadPart);
    if (!SEGMENT.test(signaturePart)) {
      throw new AuthError('malformed');
    }
    if (header.alg !== 'RS256') {
      throw new AuthError('unsupported_alg');
    }
    if (typeof header.kid !== 'string' || header.kid === '') {
      throw new AuthError('unknown_kid');
    }
    const key = await keyFor(header.kid);
    const signed = Buffer.from(`${headerPart}.${payloadPart}`, 'ascii');
    if (!verifySignature('RSA-SHA256', signed, key, Buffer.from(signaturePart, 'base64url'))) {
      throw new AuthError('bad_signature');
    }
    if (payload.iss !== config.issuer) {
      throw new AuthError('wrong_issuer');
    }
    const audiences = typeof payload.aud === 'string' ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
    if (!audiences.includes(config.audience)) {
      throw new AuthError('wrong_audience');
    }
    const nowSeconds = clock() / 1000;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp + LEEWAY_SECONDS <= nowSeconds) {
      throw new AuthError('expired');
    }
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf - LEEWAY_SECONDS > nowSeconds)) {
      throw new AuthError('not_yet_valid');
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new AuthError('missing_sub');
    }
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter((scope) => scope !== '') : [];
    return { sub: payload.sub, scopes, expiresAt: payload.exp };
  };
}
