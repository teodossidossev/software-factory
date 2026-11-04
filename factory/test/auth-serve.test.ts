// End-to-end tests of OAuth on the MCP endpoint: the real `sf serve` with SF_AUTH_* pointing at
// the test authorization server (test/support/fake-as.ts), and `sf auth-test`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AUDIENCE, type FakeAs, newKey, startFakeAs } from './support/fake-as.js';
import { CLI, type Env, newEnv, newRepo, processEnv, putTask, runCli, script, serve, type Served, stop, waitFor } from './support/harness.js';

const RESOURCE_METADATA = 'https://sf.example.test/.well-known/oauth-protected-resource';
let as: FakeAs;

before(async () => {
  as = await startFakeAs();
});

after(async () => {
  await as.close();
});

function authEnv(name: string, extra: Record<string, string> = {}): Promise<Env> {
  return newEnv(name, { SF_AUTH_ISSUER: as.issuer, SF_AUTH_AUDIENCE: AUDIENCE, ...extra });
}

function post(url: URL, body: unknown, token?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const guideCall = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'guide', arguments: {} } };

const MISSING_HEADER = 'Missing Authorization header';

// A 401 with the whole Bearer challenge: the error, the offline_access scope hint (SF-033) and
// the metadata URL; the body is the OAuth error JSON.
async function assertChallenge(response: Response, description: string): Promise<void> {
  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get('www-authenticate'),
    `Bearer error="invalid_token", error_description="${description}", scope="offline_access", resource_metadata="${RESOURCE_METADATA}"`,
  );
  assert.deepEqual(await response.json(), { error: 'invalid_token', error_description: description });
}

// A client sending the token on every request.
async function authedClient(served: Served, token: string): Promise<Served> {
  const client = new Client({ name: 'sf-015-auth', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(served.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return { ...served, client };
}

async function events(env: Env, ticket: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(env.state, 'jobs', 'app', ticket, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

function authTest(env: Env, input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'auth-test'], { env: processEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('sf serve with OAuth: metadata, open methods, the challenge, principals in the events', async () => {
  const env = await authEnv('auth-serve', { SF_AUTH_RESOURCE: 'https://sf.example.test/mcp' });
  const repo = await newRepo(env, 'auth-repo', true);
  await putTask(env, repo, 'AUTH-1', 'Auth demo');
  await script(env, [{ text: '# Report: AUTH-1, iteration 1\n\n## Done\nChanged the README.', write: { 'README.md': 'hello auth\n' } }]);
  // The harness client connects without a token: initialize and notifications/initialized are open.
  const served = await serve(env);
  assert.match(served.output, new RegExp(`^auth: ${as.issuer.replaceAll('.', '\\.')} audience ${AUDIENCE.replaceAll('.', '\\.')}$`, 'm'));
  try {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await fetch(new URL(path, served.url));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/json');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), {
        resource: 'https://sf.example.test/mcp',
        authorization_servers: [as.issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      });
    }
    assert.equal((await fetch(new URL('/.well-known/oauth-protected-resource', served.url), { method: 'POST' })).status, 405);

    // tools/list is open; tools/call is not.
    const tools = await served.client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'guide'));
    await assertChallenge(await post(served.url, guideCall), MISSING_HEADER);
    // A batch, a body without a method and an unparseable body are never open.
    await assertChallenge(await post(served.url, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]), MISSING_HEADER);
    await assertChallenge(await post(served.url, { jsonrpc: '2.0', id: 1, result: {} }), MISSING_HEADER);
    await assertChallenge(await post(served.url, '{not json'), MISSING_HEADER);
    // An invalid token is refused even for an open method.
    const expired = as.sign(as.claims({ exp: Math.floor(Date.now() / 1000) - 3600 }));
    await assertChallenge(await post(served.url, guideCall, expired), 'Token rejected: expired.');
    await assertChallenge(await post(served.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, expired), 'Token rejected: expired.');
    await assertChallenge(await post(served.url, guideCall, as.sign(as.claims({ aud: 'https://other.example.test/mcp' }))), 'Token rejected: wrong_audience.');
    await assertChallenge(await post(served.url, guideCall, as.sign(as.claims({ iss: 'https://other.example.test/' }))), 'Token rejected: wrong_issuer.');
    await assertChallenge(await post(served.url, guideCall, as.sign(as.claims(), { key: newKey() })), 'Token rejected: bad_signature.');
    // GET /mcp is unchanged by OAuth.
    const get = await fetch(served.url, { headers: { accept: 'text/event-stream' } });
    assert.notEqual(get.status, 401);

    // A token with only the prior scopes, no offline_access, is accepted: the hint is not enforced.
    const authed = await authedClient(served, as.sign(as.claims({ scope: 'openid profile email' })));
    const guide = await authed.client.callTool({ name: 'guide', arguments: {} });
    assert.equal(guide.isError ?? false, false);
    const started = await authed.client.callTool({ name: 'start', arguments: { workspace: 'app', ticket: 'AUTH-1' } });
    assert.equal(started.isError ?? false, false, JSON.stringify(started.content));
    const principals = (await events(env, 'AUTH-1')).filter((record) => record.type === 'principal');
    assert.deepEqual(principals.map(({ iteration, tool, principal }) => ({ iteration, tool, principal })), [{ iteration: 0, tool: 'start', principal: 'auth0|user-1' }]);
    await waitFor(authed, 'AUTH-1', 'awaiting_review', 1);
    const clean = await authed.client.callTool({ name: 'mark_clean', arguments: { workspace: 'app', ticket: 'AUTH-1' } });
    assert.equal(clean.isError ?? false, false, JSON.stringify(clean.content));
    assert.deepEqual((await events(env, 'AUTH-1')).filter((record) => record.type === 'principal').map((record) => record.tool), ['start', 'mark_clean']);
    const watched = await runCli(env, ['watch', 'app', 'AUTH-1', '--once']);
    assert.equal(watched.code, 0, watched.stderr);
    assert.match(watched.stdout, /\[0\] start by auth0\|user-1$/m);
    assert.match(watched.stdout, /\[1\] mark_clean by auth0\|user-1$/m);
    await authed.client.close();
  } finally {
    await stop(served);
  }
});

test('sf serve with OAuth: the authorization server keys unreachable is a 500, not a challenge', async () => {
  const env = await authEnv('auth-jwks-down', { SF_AUTH_RESOURCE: 'https://sf.example.test/mcp' });
  await newRepo(env, 'auth-jwks-down-repo', false);
  const served = await serve(env);
  as.jwksUp = false;
  try {
    const response = await post(served.url, guideCall, as.sign(as.claims()));
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('www-authenticate'), null);
    assert.deepEqual(await response.json(), { error: 'server_error', error_description: 'Token rejected: jwks_unavailable.' });
  } finally {
    as.jwksUp = true;
    await stop(served);
  }
});

test('sf serve without SF_AUTH_ISSUER: auth off, no metadata, tools/call without a token', async () => {
  const env = await newEnv('auth-off', { SF_AUTH_AUDIENCE: AUDIENCE });
  await newRepo(env, 'auth-off-repo', false);
  const served = await serve(env);
  try {
    assert.match(served.output, /^auth: off$/m);
    assert.equal((await fetch(new URL('/.well-known/oauth-protected-resource', served.url))).status, 404);
    const guide = await served.client.callTool({ name: 'guide', arguments: {} });
    assert.equal(guide.isError ?? false, false);
  } finally {
    await stop(served);
  }
});

test('sf serve refuses SF_AUTH_ISSUER without SF_AUTH_AUDIENCE', async () => {
  const env = await newEnv('auth-invalid', { SF_AUTH_ISSUER: 'https://tenant.eu.auth0.com/' });
  const result = await runCli(env, ['serve']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SF_AUTH_AUDIENCE is required/);
});

test('sf auth-test verifies a token from stdin', async () => {
  const env = await authEnv('auth-test');
  const valid = await authTest(env, `${as.sign(as.claims())}\n`);
  assert.equal(valid.code, 0, valid.stderr);
  assert.match(valid.stdout, /^valid: sub auth0\|user-1$/m);
  assert.match(valid.stdout, /^scopes: openid profile email$/m);
  assert.match(valid.stdout, /^expires: \d{4}-\d\d-\d\dT/m);

  const token = as.sign(as.claims({ iss: 'https://other.example.test/' }));
  const invalid = await authTest(env, token);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stdout, /^rejected: wrong_issuer$/m);
  assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes(token));

  const empty = await authTest(env, '');
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /stdin is empty/);
  const off = await authTest(await newEnv('auth-test-off'), as.sign(as.claims()));
  assert.equal(off.code, 1);
  assert.match(off.stderr, /SF_AUTH_ISSUER is not set/);
  const argument = await runCli(env, ['auth-test', 'token-as-argument']);
  assert.equal(argument.code, 2);
});
