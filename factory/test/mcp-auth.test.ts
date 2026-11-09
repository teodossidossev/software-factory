// SF-099: the MCP endpoint answers only with the MCP token of the state directory (in the path or as
// a bearer header), compared in constant time and read on every request; sf mcp-url prints the URL
// with it, rotates it and does the tunnel script's steps (--write-profile, --check-profile, --redact,
// --probe, --port); scripts/sf-tunnel.sh never holds it and its tunnel client's output never shows it;
// sf up's relay of the tunnel's lines does not either. No output, log or error shows the token.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { replaceSecret } from '../src/redact.js';
import { sameSecret } from '../src/http.js';
import { MCP_TOKEN_FILE, profileHasUrl, profileUrlLine, redactMcpToken, rewriteProfileUrl } from '../src/server.js';
import { trackChild } from './support/children.js';
import { call, CLI, type Env, newEnv, newRepo, processEnv, runCli, serve, type Served, stop, task, temp } from './support/harness.js';

const SF_BIN = fileURLToPath(new URL('../../bin/sf', import.meta.url));
const TUNNEL_SCRIPT = fileURLToPath(new URL('../../../scripts/sf-tunnel.sh', import.meta.url));
const SERVER_SOURCE = fileURLToPath(new URL('../../src/server.ts', import.meta.url));
const HTTP_SOURCE = fileURLToPath(new URL('../../src/http.ts', import.meta.url));
const OTHER = 'b'.repeat(64);

const tokenOf = async (env: Env): Promise<string> => (await readFile(join(env.state, MCP_TOKEN_FILE), 'utf8')).trim();
const withPort = (env: Env, port: string): Env => ({ ...env, extra: { ...env.extra, SF_PORT: port } });
const portOf = (served: Served): string => served.url.port;

// The layout tunnel-client init writes (config/tunnel-client/software-factory.example.yaml).
function profile(url: string, keyFile = '/k/tunnel-runtime.key'): string {
  return [
    'config_version: 1', 'control_plane:', '  base_url: "https://api.openai.com"', '', '  tunnel_id: "tunnel_abc123"', `  api_key: "file:${keyFile}"`,
    'health:', '  listen_addr: "127.0.0.1:8790"', 'log:', '  level: info', 'mcp:', '  server_urls:', '    - channel: main', `      url: "${url}"`, '',
  ].join('\n');
}

// A raw MCP request: its status and body.
async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const writeTaskCall = (content: string) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_task', arguments: { workspace: 'app', ticket: 'T-1', content } } });

test('redact.ts replaceSecret and redactMcpToken: one known secret and any token after /mcp/ become <token>', () => {
  assert.equal(replaceSecret('a SECRET b SECRET', 'SECRET', '<x>'), 'a <x> b <x>');
  assert.equal(replaceSecret('nothing here', '', '<x>'), 'nothing here');
  const token = 'c'.repeat(64);
  assert.equal(redactMcpToken(`url: "http://127.0.0.1:8787/mcp/${token}" and ${token}`, token), 'url: "http://127.0.0.1:8787/mcp/<token>" and <token>');
  // A token the filter does not know (an earlier one) after /mcp/ is hidden too; a dashboard token is not touched.
  assert.equal(redactMcpToken(`http://h/mcp/${OTHER} /d/${OTHER}/`, undefined), `http://h/mcp/<token> /d/${OTHER}/`);
});

test('the token is compared in constant time: sameSecret of src/http.ts with timingSafeEqual on digests, used by the endpoint', async () => {
  assert.equal(sameSecret(OTHER, OTHER), true);
  assert.equal(sameSecret(OTHER, 'c'.repeat(64)), false);
  assert.equal(sameSecret('short', OTHER), false);
  assert.equal(sameSecret('', OTHER), false);
  assert.match(await readFile(HTTP_SOURCE, 'utf8'), /export function sameSecret[\s\S]{0,300}timingSafeEqual\(digest\(given\), digest\(expected\)\)/);
  const source = await readFile(SERVER_SOURCE, 'utf8');
  assert.match(source, /import \{[^}]*\bsameSecret\b[^}]*\} from '\.\/http\.js'/);
  assert.match(source, /!sameSecret\(given, token\)/);
  assert.doesNotMatch(source, /given === token|token === given/);
  // The one compare: no other timingSafeEqual in the endpoint.
  assert.doesNotMatch(source, /timingSafeEqual/);
});

test('the profile line scan: the url of the main channel only, the layouts tunnel-client writes; anything else is profile_mcp_url_unexpected', () => {
  const plain = profile('http://127.0.0.1:8787/mcp');
  assert.deepEqual(profileUrlLine(plain), { index: 13, prefix: '      ', value: '"http://127.0.0.1:8787/mcp"' });
  const rewritten = rewriteProfileUrl(plain, `http://127.0.0.1:9000/mcp/${OTHER}`);
  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.text, plain.replace('url: "http://127.0.0.1:8787/mcp"', `url: "http://127.0.0.1:9000/mcp/${OTHER}"`));
  assert.deepEqual(rewriteProfileUrl(rewritten.text, `http://127.0.0.1:9000/mcp/${OTHER}`), { text: rewritten.text, changed: false });
  assert.equal(profileHasUrl(rewritten.text, `http://127.0.0.1:9000/mcp/${OTHER}`), true);
  assert.equal(profileHasUrl(plain, `http://127.0.0.1:8787/mcp/${OTHER}`), false);

  // The url key first in its item, another channel before it, CRLF line ends, another url elsewhere.
  const compact = 'other:\r\n  url: "http://example.com/x"\r\nmcp:\r\n  server_urls:\r\n  - channel: side\r\n    url: "http://127.0.0.1:1/side"\r\n  - url: \'http://127.0.0.1:8787/mcp\'\r\n    channel: "main"\r\n';
  const set = rewriteProfileUrl(compact, 'http://127.0.0.1:8787/mcp/T');
  assert.equal(set.text, compact.replace("  - url: 'http://127.0.0.1:8787/mcp'\r\n", '  - url: "http://127.0.0.1:8787/mcp/T"\r\n'));

  const unexpected = { code: 'profile_mcp_url_unexpected' };
  for (const text of [
    'log:\n  url: "http://127.0.0.1:8787/mcp"\n',
    profile('http://127.0.0.1:8787/mcp').replace('channel: main', 'channel: side'),
    profile('http://localhost:8787/mcp'),
    profile('https://tunnel.example.com/mcp'),
    `${profile('http://127.0.0.1:8787/mcp')}    - channel: main\n      url: "http://127.0.0.1:8787/mcp"\n`,
    profile('http://127.0.0.1:8787/mcp').replace(/ {6}url: .*\n/, '        url: "http://127.0.0.1:8787/mcp"\n'),
  ]) {
    assert.throws(() => rewriteProfileUrl(text, 'http://127.0.0.1:8787/mcp/T'), unexpected, text);
  }
});

test('sf serve: mcp-token made at the first start (mode 0600) and kept; the start line shows /mcp/<token>; an invalid file stops the start', async () => {
  const env = await newEnv('mcp-start');
  const first = await serve(env);
  const token = await tokenOf(env);
  try {
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal((await stat(join(env.state, MCP_TOKEN_FILE))).mode & 0o777, 0o600);
    assert.match(first.output, /^software-factory listening on http:\/\/127\.0\.0\.1:\d+\/mcp\/<token>$/m);
    assert.ok(!first.output.includes(token));
    // A value of its own, not the dashboard's.
    assert.notEqual((await readFile(join(env.state, 'dashboard-token'), 'utf8')).trim(), token);
  } finally {
    await stop(first);
  }
  const second = await serve(env);
  await stop(second);
  assert.equal(await tokenOf(env), token);

  await writeFile(join(env.state, MCP_TOKEN_FILE), 'not a token\n');
  const refused = await runCli(env, ['serve']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /invalid_mcp_token/);
  assert.equal(await readFile(join(env.state, MCP_TOKEN_FILE), 'utf8'), 'not a token\n');
});

test('sf serve: a valid mcp-token wider than 0600 is kept and narrowed to 0600 with a warning; a link or a directory in its place stops the start (R3)', async () => {
  const env = await newEnv('mcp-token-mode');
  await mkdir(env.state, { recursive: true, mode: 0o700 });
  const file = join(env.state, MCP_TOKEN_FILE);
  await writeFile(file, `${OTHER}\n`);
  await chmod(file, 0o644);
  const served = await serve(env);
  try {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await tokenOf(env), OTHER);
    assert.match(served.output, /^warning: mcp-token in the state directory had mode 644; it is 600 now\. .*sf mcp-url --rotate/m);
    assert.ok(!served.output.includes(OTHER));
  } finally {
    await stop(served);
  }
  // A link to a valid token elsewhere, and a directory: refused, nothing changed.
  await rm(file);
  const elsewhere = join(temp, 'mcp-token-mode', 'elsewhere');
  await writeFile(elsewhere, `${OTHER}\n`, { mode: 0o644 });
  await symlink(elsewhere, file);
  const linked = await runCli(env, ['serve']);
  assert.equal(linked.code, 1);
  assert.match(linked.stderr, /unsafe_mcp_token/);
  assert.ok(!linked.stderr.includes(OTHER));
  assert.equal((await stat(elsewhere)).mode & 0o777, 0o644);
  await rm(file);
  await mkdir(file);
  const directory = await runCli(env, ['serve']);
  assert.equal(directory.code, 1);
  assert.match(directory.stderr, /unsafe_mcp_token/);
  // A file this user cannot read: the same refusal, not a bare EACCES.
  await rm(file, { recursive: true });
  await writeFile(file, `${OTHER}\n`);
  await chmod(file, 0o200);
  const unreadable = await runCli(env, ['serve']);
  assert.equal(unreadable.code, 1);
  assert.match(unreadable.stderr, /unsafe_mcp_token/);
  await chmod(file, 0o600);
});

test('the endpoint: no token or a wrong one is 401 with a JSON-RPC error and no tool runs; the path token and the bearer token work', async () => {
  const env = await newEnv('mcp-endpoint');
  const repo = await newRepo(env, 'mcp-endpoint-repo', false);
  const served = await serve(env);
  const token = await tokenOf(env);
  const base = `http://127.0.0.1:${portOf(served)}/mcp`;
  try {
    for (const [url, headers] of [
      [base, {}],
      [base, { authorization: `Bearer ${OTHER}` }],
      [base, { authorization: `Basic ${token}` }],
      [`${base}/`, {}],
      [`${base}/${OTHER}`, {}],
      [`${base}/${token.slice(0, 63)}`, {}],
      // The bearer form is for /mcp; a wrong path token is not saved by a right header.
      [`${base}/${OTHER}`, { authorization: `Bearer ${token}` }],
    ] as Array<[string, Record<string, string>]>) {
      for (const body of [initialize, writeTaskCall(task('T-1', 'Sneaky'))]) {
        const answer = await post(url, body, headers);
        assert.equal(answer.status, 401, `${url} ${JSON.stringify(headers)}`);
        const error = JSON.parse(answer.text) as { jsonrpc: string; error: { code: number; message: string }; id: null };
        assert.equal(error.jsonrpc, '2.0');
        assert.match(error.error.message, /sf mcp-url/);
        assert.ok(!answer.text.includes(token));
      }
    }
    await assert.rejects(stat(join(repo, '.software-factory', 'T-1.md')), { code: 'ENOENT' });
    // A plain GET without the token too; another path is 404 as before.
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(`${base}/${token}/more`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${portOf(served)}/other`)).status, 404);

    // The harness's client uses the path form.
    assert.equal(served.url.pathname, `/mcp/${token}`);
    assert.match((await call(served, 'guide', {})).text, /Software Factory handbook/);
    assert.equal((await call(served, 'write_task', { workspace: 'app', ticket: 'T-1', content: task('T-1', 'Path') })).status, 'created');
    // The bearer form.
    const bearer = new Client({ name: 'sf-099-bearer', version: '0.0.0' });
    await bearer.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    try {
      const result = await bearer.callTool({ name: 'write_task', arguments: { workspace: 'app', ticket: 'T-1', content: task('T-1', 'Bearer') } });
      assert.equal((result.structuredContent as { status: string }).status, 'replaced');
    } finally {
      await bearer.close();
    }
    assert.match(await readFile(join(repo, '.software-factory', 'T-1.md'), 'utf8'), /title: Bearer/);
  } finally {
    await stop(served);
  }
});

test('while serving: an invalid or unreadable token file refuses every request (401), logged once a minute at most without a value; a valid one works again', async () => {
  const env = await newEnv('mcp-fail-closed');
  const served = await serve(env);
  let log = '';
  served.child.stderr!.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
  const token = await tokenOf(env);
  const file = join(env.state, MCP_TOKEN_FILE);
  const withToken = `http://127.0.0.1:${portOf(served)}/mcp/${token}`;
  try {
    assert.equal((await post(withToken, initialize)).status, 200);
    await writeFile(file, `${token}x\n`);
    for (let i = 0; i < 3; i++) {
      assert.equal((await post(withToken, initialize)).status, 401);
    }
    await writeFile(file, `${token}\n`);
    await chmod(file, 0o000);
    assert.equal((await post(withToken, initialize)).status, 401);
    await chmod(file, 0o600);
    assert.equal((await post(withToken, initialize)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(log.split('mcp: every request is refused').length, 2, log);
    assert.match(log, /mcp: every request is refused: the MCP token file cannot be used \(invalid_mcp_token\)/);
    assert.ok(!log.includes(token));
  } finally {
    await chmod(file, 0o600);
    await stop(served);
  }
});

test('sf mcp-url: the URL with the token, --header, --port, --rotate (a running server takes the new token, refuses the old), no_mcp_token', async () => {
  const env = await newEnv('mcp-url');
  const none = await runCli(env, ['mcp-url']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no_mcp_token/);
  assert.match(none.stderr, /start sf serve once/);
  // --rotate too: it replaces a token, it never makes the first one (R5); no file is left behind.
  const rotateNone = await runCli(env, ['mcp-url', '--rotate']);
  assert.equal(rotateNone.code, 1);
  assert.match(rotateNone.stderr, /no_mcp_token/);
  await assert.rejects(stat(join(env.state, MCP_TOKEN_FILE)), { code: 'ENOENT' });

  const served = await serve(env);
  const port = portOf(served);
  const at = withPort(env, port);
  const token = await tokenOf(env);
  try {
    assert.deepEqual(await runCli(at, ['mcp-url']), { code: 0, stdout: `http://127.0.0.1:${port}/mcp/${token}\n`, stderr: '' });
    assert.deepEqual(await runCli(at, ['mcp-url', '--header']), { code: 0, stdout: `http://127.0.0.1:${port}/mcp\nAuthorization: Bearer ${token}\n`, stderr: '' });
    assert.deepEqual(await runCli(at, ['mcp-url', '--port']), { code: 0, stdout: `${port}\n`, stderr: '' });
    // The default port without SF_PORT.
    assert.equal((await runCli(withPort(env, ''), ['mcp-url'])).stdout, `http://127.0.0.1:8787/mcp/${token}\n`);
    for (const args of [['mcp-url', 'x'], ['mcp-url', '--header', '--port'], ['mcp-url', '--nope']]) {
      assert.equal((await runCli(at, args)).code, 2, args.join(' '));
    }

    const rotated = await runCli(at, ['mcp-url', '--rotate']);
    assert.equal(rotated.code, 0, rotated.stderr);
    assert.match(rotated.stdout, /MCP token rotated/);
    assert.match(rotated.stdout, /npm run tunnel/);
    const fresh = await tokenOf(env);
    assert.notEqual(fresh, token);
    assert.match(fresh, /^[0-9a-f]{64}$/);
    assert.equal((await stat(join(env.state, MCP_TOKEN_FILE))).mode & 0o777, 0o600);
    assert.ok(!rotated.stdout.includes(fresh) && !rotated.stdout.includes(token));
    // No restart: the old token is refused, the new one answers.
    assert.equal((await post(`http://127.0.0.1:${port}/mcp/${token}`, initialize)).status, 401);
    assert.equal((await post(`http://127.0.0.1:${port}/mcp/${fresh}`, initialize)).status, 200);
    await assert.rejects(served.client.callTool({ name: 'guide', arguments: {} }));
  } finally {
    await stop(served).catch(() => undefined);
  }
  // An invalid file is replaced: that is how invalid_mcp_token is left (R5 keeps it).
  await writeFile(join(env.state, MCP_TOKEN_FILE), 'not a token\n');
  assert.equal((await runCli(at, ['mcp-url', '--rotate'])).code, 0);
  assert.match(await tokenOf(env), /^[0-9a-f]{64}$/);
});

test('sf mcp-url --write-profile and --check-profile: the plain /mcp URL and a stale token rewritten (mode 0600 kept); the check accepts only the current token', async () => {
  const env = await newEnv('mcp-profile');
  const dir = join(temp, 'mcp-profile', 'tunnel-client');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'software-factory.yaml');
  await writeFile(file, profile('http://127.0.0.1:8787/mcp'), { mode: 0o600 });
  assert.match((await runCli(env, ['mcp-url', '--write-profile', file])).stderr, /no_mcp_token/);

  const served = await serve(env);
  await stop(served);
  const token = await tokenOf(env);
  const at = withPort(env, '9123');
  const mismatch = "sf: profile MCP url is not the factory's URL (/mcp/<token>)\n";
  assert.deepEqual(await runCli(at, ['mcp-url', '--check-profile', file]), { code: 1, stdout: '', stderr: mismatch });

  const written = await runCli(at, ['mcp-url', '--write-profile', file]);
  assert.deepEqual(written, { code: 0, stdout: 'profile MCP url set to http://127.0.0.1:9123/mcp/<token>\n', stderr: '' });
  assert.equal(await readFile(file, 'utf8'), profile(`http://127.0.0.1:9123/mcp/${token}`));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(await runCli(at, ['mcp-url', '--check-profile', file]), { code: 0, stdout: '', stderr: '' });
  assert.equal((await runCli(at, ['mcp-url', '--write-profile', file])).stdout, 'profile MCP url is http://127.0.0.1:9123/mcp/<token>\n');

  // A stale token: the check refuses it without showing either; the write replaces it.
  await writeFile(file, profile(`http://127.0.0.1:9123/mcp/${OTHER}`), { mode: 0o600 });
  const stale = await runCli(at, ['mcp-url', '--check-profile', file]);
  assert.deepEqual(stale, { code: 1, stdout: '', stderr: mismatch });
  assert.equal((await runCli(at, ['mcp-url', '--write-profile', file])).code, 0);
  assert.equal(await readFile(file, 'utf8'), profile(`http://127.0.0.1:9123/mcp/${token}`));

  // An unexpected profile is left as it is.
  const odd = profile('http://localhost:8787/mcp');
  await writeFile(file, odd, { mode: 0o600 });
  const refused = await runCli(at, ['mcp-url', '--write-profile', file]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /profile_mcp_url_unexpected/);
  assert.equal(await readFile(file, 'utf8'), odd);
  assert.match((await runCli(at, ['mcp-url', '--check-profile', file])).stderr, /profile_mcp_url_unexpected/);
});

test('sf mcp-url --write-profile narrows the profile to 0600 and its directory to 0700, also when the URL is already current; --check-profile refuses wider modes (R4)', async () => {
  const env = await newEnv('mcp-profile-mode');
  await stop(await serve(env));
  const token = await tokenOf(env);
  const at = withPort(env, '9123');
  const dir = join(temp, 'mcp-profile-mode', 'tunnel-client');
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o755);
  const file = join(dir, 'software-factory.yaml');
  const current = profile(`http://127.0.0.1:9123/mcp/${token}`);
  await writeFile(file, current);
  await chmod(file, 0o644);

  const wide = await runCli(at, ['mcp-url', '--check-profile', file]);
  assert.equal(wide.code, 1);
  assert.match(wide.stderr, /profile_unsafe/);
  assert.match(wide.stderr, /mode 644, not 600/);
  const written = await runCli(at, ['mcp-url', '--write-profile', file]);
  assert.deepEqual(written, { code: 0, stdout: 'profile MCP url is http://127.0.0.1:9123/mcp/<token>; file mode 644 set to 600; directory mode 755 set to 700\n', stderr: '' });
  assert.equal(await readFile(file, 'utf8'), current);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(await runCli(at, ['mcp-url', '--check-profile', file]), { code: 0, stdout: '', stderr: '' });

  // The directory alone too wide; then a file of another kind in the profile's place.
  await chmod(dir, 0o750);
  const group = await runCli(at, ['mcp-url', '--check-profile', file]);
  assert.equal(group.code, 1);
  assert.match(group.stderr, /mode 750, not 700/);
  assert.equal((await runCli(at, ['mcp-url', '--write-profile', file])).stdout, 'profile MCP url is http://127.0.0.1:9123/mcp/<token>; directory mode 750 set to 700\n');
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  // Stricter than wanted counts too (R4): a stale profile in a 0500 directory, read-only itself,
  // is set to 0700 and 0600 and then rewritten.
  await writeFile(file, profile(`http://127.0.0.1:9123/mcp/${OTHER}`));
  await chmod(file, 0o400);
  await chmod(dir, 0o500);
  const strict = await runCli(at, ['mcp-url', '--check-profile', file]);
  assert.equal(strict.code, 1);
  assert.match(strict.stderr, /mode 400, not 600/);
  assert.deepEqual(await runCli(at, ['mcp-url', '--write-profile', file]), {
    code: 0, stdout: 'profile MCP url set to http://127.0.0.1:9123/mcp/<token>; file mode 400 set to 600; directory mode 500 set to 700\n', stderr: '',
  });
  assert.equal(await readFile(file, 'utf8'), current);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await chmod(dir, 0o500);
  assert.match((await runCli(at, ['mcp-url', '--check-profile', file])).stderr, /mode 500, not 700/);
  await chmod(dir, 0o700);
  const notFile = join(dir, 'odd.yaml');
  await mkdir(notFile);
  const odd = await runCli(at, ['mcp-url', '--write-profile', notFile]);
  assert.equal(odd.code, 1);
  assert.match(odd.stderr, /profile_unsafe/);
});

test('sf mcp-url --redact: the token becomes <token>, also across chunks; SIGINT and SIGTERM do not stop it; it ends at the end of its input', async () => {
  const env = await newEnv('mcp-redact');
  await stop(await serve(env));
  const token = await tokenOf(env);
  const child = spawn(process.execPath, [CLI, 'mcp-url', '--redact'], { env: processEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  trackChild(child, ['mcp-url', '--redact']);
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  child.stdin.write(`first line\nurl http://127.0.0.1:8787/mcp/${token.slice(0, 30)}`);
  // The first line out: the filter runs (its signal handlers are set).
  const deadline = Date.now() + 15_000;
  while (out !== 'first line\n') {
    assert.ok(Date.now() < deadline, `timed out: ${JSON.stringify(out)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill('SIGINT');
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null);
  child.stdin.end(`${token.slice(30)} done\nbare ${token} Привет\nold /mcp/${OTHER}\nlast without newline`);
  assert.equal(await exited, 0);
  assert.equal(out, 'first line\nurl http://127.0.0.1:8787/mcp/<token> done\nbare <token> Привет\nold /mcp/<token>\nlast without newline');
});

test('sf mcp-url --probe: 0 when the factory answers the token, 1 when it refuses it, 2 when nothing answers', async () => {
  const env = await newEnv('mcp-probe');
  const served = await serve(env);
  const port = portOf(served);
  try {
    assert.deepEqual(await runCli(withPort(env, port), ['mcp-url', '--probe']), { code: 0, stdout: `factory answers at http://127.0.0.1:${port}/mcp/<token>\n`, stderr: '' });
    // Another state directory's token on the same port.
    const other = await newEnv('mcp-probe-other');
    await mkdir(other.state, { recursive: true });
    await writeFile(join(other.state, MCP_TOKEN_FILE), `${OTHER}\n`, { mode: 0o600 });
    const refused = await runCli(withPort(other, port), ['mcp-url', '--probe']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /the factory refused the token/);
    assert.ok(!refused.stderr.includes(OTHER));
  } finally {
    await stop(served);
  }
  const gone = await runCli(withPort(env, port), ['mcp-url', '--probe']);
  assert.deepEqual(gone, { code: 2, stdout: '', stderr: `factory not reachable at http://127.0.0.1:${port}/mcp/<token>\n` });
});

test('SF_PORT=0 (any free port): sf mcp-url, its tunnel steps and sf info use the port the running sf serve bound; without one, mcp_port_unknown and --probe exits 2', async () => {
  // The harness serves with SF_PORT=0.
  const env = await newEnv('mcp-port-zero');
  const served = await serve(env);
  const port = portOf(served);
  assert.notEqual(port, '0');
  const token = await tokenOf(env);
  const dir = join(temp, 'mcp-port-zero', 'profiles');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'software-factory.yaml');
  await writeFile(file, profile('http://127.0.0.1:8787/mcp'), { mode: 0o600 });
  try {
    assert.equal(processEnv(env).SF_PORT, '0');
    assert.deepEqual(await runCli(env, ['mcp-url']), { code: 0, stdout: `http://127.0.0.1:${port}/mcp/${token}\n`, stderr: '' });
    assert.deepEqual(await runCli(env, ['mcp-url', '--port']), { code: 0, stdout: `${port}\n`, stderr: '' });
    assert.equal((await runCli(env, ['mcp-url', '--header'])).stdout, `http://127.0.0.1:${port}/mcp\nAuthorization: Bearer ${token}\n`);
    assert.deepEqual(await runCli(env, ['mcp-url', '--probe']), { code: 0, stdout: `factory answers at http://127.0.0.1:${port}/mcp/<token>\n`, stderr: '' });
    assert.equal((await runCli(env, ['mcp-url', '--write-profile', file])).code, 0);
    assert.equal(await readFile(file, 'utf8'), profile(`http://127.0.0.1:${port}/mcp/${token}`));
    assert.deepEqual(await runCli(env, ['mcp-url', '--check-profile', file]), { code: 0, stdout: '', stderr: '' });
    assert.match((await runCli(env, ['info'])).stdout, new RegExp(`^mcp {11}http://127\\.0\\.0\\.1:${port}/mcp/<token> `, 'm'));
  } finally {
    await stop(served);
  }
  // No sf serve to ask: the port is unknown, never 0.
  for (const args of [['mcp-url'], ['mcp-url', '--port'], ['mcp-url', '--header'], ['mcp-url', '--write-profile', file], ['mcp-url', '--check-profile', file]]) {
    const unknown = await runCli(env, args);
    assert.equal(unknown.code, 1, args.join(' '));
    assert.match(unknown.stderr, /mcp_port_unknown/, args.join(' '));
    assert.ok(!unknown.stdout.includes(':0/') && !unknown.stderr.includes(token));
  }
  const probe = await runCli(env, ['mcp-url', '--probe']);
  assert.equal(probe.code, 2);
  assert.match(probe.stderr, /^factory not reachable: SF_PORT is 0/m);
  assert.match((await runCli(env, ['info'])).stdout, /^mcp {11}any free port \(SF_PORT=0\): sf mcp-url shows the URL while sf serve runs$/m);
});

test('sf up: the relay of the tunnel\'s lines shows the token as <token>', async () => {
  const dir = join(temp, 'mcp-up-tunnel');
  await mkdir(dir, { recursive: true });
  const script = join(dir, 'sf-tunnel.sh');
  // sf serve runs the tunnel with SF_TUNNEL=auto and a tunnel profile.
  const env = await newEnv('mcp-up', { SF_TUNNEL: 'auto', SF_TUNNEL_SCRIPT: script, PATH: '/usr/bin:/bin' });
  await mkdir(join(env.home, '.config', 'tunnel-client'), { recursive: true });
  await writeFile(join(env.home, '.config', 'tunnel-client', 'software-factory.yaml'), 'config_version: 1\n');
  // The fake prints what a tunnel client may print, the profile's URL, again and again (the test
  // listens from the moment serve answers).
  await writeFile(script, `#!/bin/sh\nt=$(cat '${join(env.state, MCP_TOKEN_FILE)}')\ntrap 'exit 0' TERM\nwhile :; do echo "url http://127.0.0.1:1/mcp/$t"; echo "err $t" >&2; sleep 0.2; done\n`);
  await chmod(script, 0o755);
  const up = await serve(env, ['up', '--no-open']);
  let err = '';
  up.child.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  const token = await tokenOf(env);
  try {
    const deadline = Date.now() + 15_000;
    while (!(err.includes('tunnel | url') && err.includes('tunnel | err')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(err, /^tunnel \| url http:\/\/127\.0\.0\.1:1\/mcp\/<token>$/m);
    assert.match(err, /^tunnel \| err <token>$/m);
    assert.ok(!err.includes(token));
  } finally {
    await stop(up);
  }
});

// The tunnel script with a fake tunnel-client on PATH and the real sf CLI (SF_CLI).
interface TunnelSetup {
  env: Env;
  scriptEnv: NodeJS.ProcessEnv;
  profileFile: string;
  clientLog: string;
  pidFile: string;
}

const FAKE_CLIENT = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_TC_LOG"
cmd="$1"; shift
dir=; profile=; url=; tunnel=; key=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile-dir) dir="$2"; shift 2 ;;
    --profile) profile="$2"; shift 2 ;;
    --mcp-server-url) url="$2"; shift 2 ;;
    --tunnel-id) tunnel="$2"; shift 2 ;;
    --control-plane-api-key-ref) key="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$cmd" in
  --version) echo "tunnel-client 0.0.18+fake" ;;
  init)
    # Wider modes than the factory keeps: the script narrows them (R4).
    mkdir -p "$dir"; chmod 755 "$dir"
    (umask 022; printf 'config_version: 1\\ncontrol_plane:\\n  base_url: "https://api.openai.com"\\n\\n  tunnel_id: "%s"\\n  api_key: "%s"\\nmcp:\\n  server_urls:\\n    - channel: main\\n      url: "%s"\\n' "$tunnel" "$key" "$url" > "$dir/$profile.yaml")
    echo "profile written" ;;
  run|doctor)
    echo $$ > "$FAKE_TC_PID"
    line=$(grep -E '^ +url:' "$dir/$profile.yaml")
    echo "fake out $line"
    echo "fake err $line" >&2
    [[ "$cmd" == doctor ]] && exit 0
    [[ -n "\${FAKE_TC_EXIT:-}" ]] && exit "$FAKE_TC_EXIT"
    trap 'echo "fake last $line"; exit 7' TERM
    while :; do sleep 0.1; done ;;
esac
`;

async function tunnelSetup(name: string, port: string): Promise<TunnelSetup> {
  const env = await newEnv(name);
  const root = join(temp, name);
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'tunnel-client'), FAKE_CLIENT);
  await chmod(join(bin, 'tunnel-client'), 0o755);
  const keyFile = join(root, 'keys', 'tunnel-runtime.key');
  await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
  await writeFile(keyFile, 'runtime-key-value', { mode: 0o600 });
  const profileDir = join(root, 'profiles');
  const clientLog = join(root, 'client.log');
  const pidFile = join(root, 'client.pid');
  const scriptEnv = {
    ...processEnv(env), SF_PORT: port, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, SF_CLI: SF_BIN,
    TUNNEL_CLIENT_PROFILE_DIR: profileDir, SF_TUNNEL_KEY_FILE: keyFile, FAKE_TC_LOG: clientLog, FAKE_TC_PID: pidFile,
  };
  return { env, scriptEnv, profileFile: join(profileDir, 'software-factory.yaml'), clientLog, pidFile };
}

interface ScriptRun {
  child: ChildProcess;
  out(): string;
  err(): string;
  done: Promise<number | null>;
}

// The scripts and fake clients of these tests: a failed assertion must not leave one running.
const scripts = new Set<ChildProcess>();
const pidFiles = new Set<string>();
const states = new Set<string>();
after(async () => {
  for (const child of scripts) {
    child.kill('SIGKILL');
  }
  // The filters hold the scripts' pipes: one left would keep this test file from ending.
  for (const state of states) {
    for (const pid of await filtersAlive(state)) {
      process.kill(pid, 'SIGKILL');
    }
  }
  for (const file of pidFiles) {
    const pid = Number((await readFile(file, 'utf8').catch(() => '')).trim());
    if (pid > 0 && alive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  }
});

function runScript(setup: TunnelSetup, args: string[], extra: Record<string, string> = {}): ScriptRun {
  const child = spawn(TUNNEL_SCRIPT, args, { env: { ...setup.scriptEnv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  scripts.add(child);
  pidFiles.add(setup.pidFile);
  states.add(setup.env.state);
  child.once('exit', () => scripts.delete(child));
  let out = '';
  let err = '';
  child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  // close: the filters, which hold the pipes too, have ended as well.
  const done = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  return { child, out: () => out, err: () => err, done };
}

// The sf mcp-url --redact filters of this state directory still alive.
async function filtersAlive(state: string): Promise<number[]> {
  const alive: number[] = [];
  for (const pid of (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))) {
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    const environ = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '');
    if (command.includes('mcp-url\0--redact') && environ.includes(`SF_STATE_DIR=${state}\0`)) {
      alive.push(Number(pid));
    }
  }
  return alive;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// 60 s: before its client starts, the script runs the sf CLI five times, each a Node start, slow
// under the whole suite's load.
async function until(condition: () => boolean, what: string, run: ScriptRun): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}:\n${run.out()}\n${run.err()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The tunnel set up by the first script test, run by the second.
let tunnel: TunnelSetup;

test('scripts/sf-tunnel.sh init and check: the token goes into the profile without being printed or passed on a command line; the check takes only the current token', async () => {
  const setup = await tunnelSetup('mcp-tunnel', '0');
  tunnel = setup;
  // SF_PORT=0 and no sf serve: the port is not known; the script relays why.
  const unknown = runScript(setup, ['init', 'tunnel_abc123']);
  assert.equal(await unknown.done, 1);
  assert.match(unknown.err(), /^sf-tunnel: FAIL: SF_PORT is 0 \(any free port\).*\(mcp_port_unknown\)/m);
  // Without a token file: the script says to start sf serve first.
  const early = runScript(setup, ['init', 'tunnel_abc123'], { SF_PORT: '8787' });
  assert.equal(await early.done, 1);
  assert.match(early.err(), /sf-tunnel: FAIL: no MCP token yet: start sf serve first/);

  const served = await serve(setup.env);
  const port = portOf(served);
  setup.scriptEnv.SF_PORT = port;
  const token = await tokenOf(setup.env);
  const shown = `http://127.0.0.1:${port}/mcp/<token>`;
  try {
    // init: the plain URL on the client's command line, then the token in the file only.
    const init = runScript(setup, ['init', 'tunnel_abc123']);
    assert.equal(await init.done, 0, init.err());
    assert.match(await readFile(setup.clientLog, 'utf8'), new RegExp(`--mcp-server-url http://127\\.0\\.0\\.1:${port}/mcp `));
    assert.match(await readFile(setup.profileFile, 'utf8'), new RegExp(`^ {6}url: "http://127\\.0\\.0\\.1:${port}/mcp/${token}"$`, 'm'));
    assert.equal((await stat(setup.profileFile)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(setup.profileFile))).mode & 0o777, 0o700);
    assert.match(init.out(), new RegExp(`sf-tunnel: ok: profile MCP url set to ${shown.replace(/[.]/g, '\\.')}`));

    // check: every step passes; a plain /mcp profile fails with the redacted message.
    const check = runScript(setup, ['check']);
    assert.equal(await check.done, 0, check.err());
    assert.match(check.out(), /sf-tunnel: ok: factory answers at http:\/\/127\.0\.0\.1:\d+\/mcp\/<token>/);
    const good = await readFile(setup.profileFile, 'utf8');
    await writeFile(setup.profileFile, good.replace(`/mcp/${token}`, '/mcp'));
    const stale = runScript(setup, ['check']);
    assert.equal(await stale.done, 1);
    assert.match(stale.err(), /^sf-tunnel: FAIL: profile MCP url is not the factory's URL \(\/mcp\/<token>\)$/m);
    await writeFile(setup.profileFile, good);

    const commandLines = await readFile(setup.clientLog, 'utf8');
    for (const text of [commandLines, init.out(), init.err(), check.out(), check.err(), stale.err()]) {
      assert.ok(!text.includes(token), text);
    }
  } finally {
    await stop(served);
  }

  // Nothing answers: the check says so, with the redacted URL.
  const down = runScript(setup, ['check']);
  assert.equal(await down.done, 1);
  assert.match(down.err(), /^sf-tunnel: FAIL: factory not reachable at http:\/\/127\.0\.0\.1:\d+\/mcp\/<token> \(start it: npm run serve\)$/m);
});

test('scripts/sf-tunnel.sh run and doctor: the stale profile rewritten; the output filter hides the token; SIGTERM and SIGINT stop the client and leave no process; its exit status is the script\'s', async () => {
  const setup = tunnel;
  const served = await serve(setup.env);
  setup.scriptEnv.SF_PORT = portOf(served);
  const token = await tokenOf(setup.env);
  const shown = `http://127.0.0.1:${portOf(served)}/mcp/<token>`;
  // A profile of before SF-099: the plain /mcp URL.
  await writeFile(setup.profileFile, (await readFile(setup.profileFile, 'utf8')).replace(`/mcp/${token}`, '/mcp'));
  try {
    // run: the plain profile is rewritten, the client prints the URL on both streams, only <token>
    // comes out; SIGTERM to the script stops the client, its last line comes through, its status is the script's.
    const run = runScript(setup, ['run']);
    await until(() => run.out().includes('fake out') && run.err().includes('fake err'), 'the client\'s lines', run);
    assert.match(await readFile(setup.profileFile, 'utf8'), new RegExp(`/mcp/${token}"`));
    run.child.kill('SIGTERM');
    assert.equal(await run.done, 7, run.err());
    assert.match(run.out(), new RegExp(`^fake out +url: "${shown.replace(/[.]/g, '\\.')}"$`, 'm'));
    assert.match(run.err(), new RegExp(`^fake err +url: "${shown.replace(/[.]/g, '\\.')}"$`, 'm'));
    assert.match(run.out(), /^fake last +url: "http:\/\/127\.0\.0\.1:\d+\/mcp\/<token>"$/m);
    const clientPid = Number((await readFile(setup.pidFile, 'utf8')).trim());
    assert.equal(alive(clientPid), false);
    assert.deepEqual(await filtersAlive(setup.env.state), []);

    // SIGINT (Ctrl+C) stops it the same way.
    const interrupted = runScript(setup, ['run']);
    await until(() => interrupted.out().includes('fake out'), 'the client\'s line', interrupted);
    interrupted.child.kill('SIGINT');
    assert.equal(await interrupted.done, 7, interrupted.err());
    assert.equal(alive(Number((await readFile(setup.pidFile, 'utf8')).trim())), false);
    assert.deepEqual(await filtersAlive(setup.env.state), []);

    // A client that ends by itself: its status, every line through the filters.
    const exits = runScript(setup, ['run'], { FAKE_TC_EXIT: '3' });
    assert.equal(await exits.done, 3, exits.err());
    assert.match(exits.out(), /^fake out +url: "http:\/\/127\.0\.0\.1:\d+\/mcp\/<token>"$/m);
    assert.match(exits.err(), /^fake err +url: "http:\/\/127\.0\.0\.1:\d+\/mcp\/<token>"$/m);

    // doctor: the same filters.
    const doctor = runScript(setup, ['doctor']);
    assert.equal(await doctor.done, 0, doctor.err());
    assert.match(doctor.out(), /^fake out +url: "http:\/\/127\.0\.0\.1:\d+\/mcp\/<token>"$/m);

    // No token on any command line of the client, nor in any output.
    const commandLines = await readFile(setup.clientLog, 'utf8');
    for (const text of [commandLines, run.out(), run.err(), interrupted.out(), interrupted.err(), exits.out(), exits.err(), doctor.out(), doctor.err()]) {
      assert.ok(!text.includes(token), text);
    }
  } finally {
    await stop(served);
  }
});

test('scripts/sf-tunnel.sh: without SF_CLI it uses factory/bin/sf of its repository, and the script holds no token', async () => {
  const text = await readFile(TUNNEL_SCRIPT, 'utf8');
  assert.match(text, /SF="\$ROOT\/factory\/bin\/sf"/);
  assert.match(text, /factory\/dist\/src\/cli\.js" \]\] \|\| fail "the factory is not built .*run npm run setup"/);
  assert.doesNotMatch(text, /mcp-token|8787/);
  assert.doesNotMatch(text, /\bexec tunnel-client/);
});
