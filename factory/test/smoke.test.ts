// End-to-end: runs the real `sf` CLI with a private config dir and a temporary Git repository
// as workspace, serves on a free loopback port and drives the tools through the official MCP client.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { quickStartSection } from '../src/server.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const HANDBOOK = fileURLToPath(new URL('../../HANDBOOK.md', import.meta.url));
const READY = /listening on (http:\/\/127\.0\.0\.1:(\d+)\/mcp)/;
const TASK = '---\nticket: DEMO-1\ntitle: Demo task\nbase: main\n---\n\n# DEMO-1: Demo task\n\nПроверка ✓\n';

interface Served {
  child: ChildProcess;
  url: URL;
  port: number;
}

let temp: string;
let configDir: string;
let repo: string;
const running = new Set<ChildProcess>();

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, SF_CONFIG_DIR: configDir, SF_STATE_DIR: join(temp, 'state'), SF_PORT: '0', SF_DASHBOARD_PORT: '0', ...extra };
}

function runCli(args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function serve(extra: Record<string, string> = {}): Promise<Served> {
  const child = spawn(process.execPath, [CLI, 'serve'], { env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(child);
  child.once('exit', () => running.delete(child));
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = READY.exec(output);
      if (match) {
        child.stdout.off('data', onData);
        resolve({ child, url: new URL(match[1]!), port: Number(match[2]) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.once('exit', (code) => reject(new Error(`sf serve exited with code ${code} before ready:\n${output}`)));
  });
}

function stop(served: Served, signal: NodeJS.Signals = 'SIGINT'): Promise<number | null> {
  return new Promise((resolve) => {
    if (served.child.exitCode !== null) {
      resolve(served.child.exitCode);
      return;
    }
    served.child.once('exit', (code) => resolve(code));
    served.child.kill(signal);
  });
}

async function connect(served: Served): Promise<Client> {
  const client = new Client({ name: 'sf-011-smoke', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(served.url));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
  const [block] = result.content as Array<{ type: string; text: string }>;
  assert.deepEqual(JSON.parse(block!.text), result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

// Returns the error code of a refused call; "schema" or "protocol" when the SDK refused the input itself.
async function refusedCode(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch {
    return 'protocol';
  }
  assert.equal(result.isError, true, `expected refusal for ${name} ${JSON.stringify(args).slice(0, 80)}`);
  const [block] = result.content as Array<{ type: string; text: string }>;
  assert.doesNotMatch(block!.text, new RegExp(temp.replaceAll('/', '\\/')));
  try {
    return (JSON.parse(block!.text) as { code: string }).code;
  } catch {
    return 'schema';
  }
}

function postStatus(url: URL, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once('error', reject);
    req.end('{}');
  });
}

before(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'sf-smoke-')));
  configDir = join(temp, 'config');
  repo = join(temp, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'docs'));
  execFileSync('git', ['init', '-q', repo]);
  await writeFile(join(repo, '.gitignore'), 'ignored-needle.txt\n');
  await writeFile(join(repo, 'src', 'app.ts'), `export const needle = 1;\n// ${'needle '.repeat(60)}\n`);
  await writeFile(join(repo, 'docs', 'hello.md'), 'Здравей 👋 needle\n');
  await writeFile(join(repo, 'ignored-needle.txt'), 'needle\n');
  await writeFile(join(repo, '.env'), 'SECRET=needle\n');
  await writeFile(join(repo, '.git', 'needle-inside-git'), 'needle\n');
  // Only src/app.ts is tracked (staged); the rest are untracked or ignored.
  execFileSync('git', ['add', 'src/app.ts'], { cwd: repo });
});

after(async () => {
  for (const child of running) {
    child.kill('SIGKILL');
  }
  await rm(temp, { recursive: true, force: true });
});

test('sf workspace add, list and remove manage the registry with the documented exit codes', async () => {
  assert.equal((await runCli([])).code, 2);
  assert.equal((await runCli(['bogus'])).code, 2);
  assert.equal((await runCli(['workspace', 'add', 'demo'])).code, 2);
  assert.equal((await runCli(['workspace', 'add', 'demo', '--read', repo, '--bogus', 'x'])).code, 2);
  assert.equal((await runCli(['workspace', 'add', 'Demo', '--read', repo])).code, 1);
  assert.equal((await runCli(['workspace', 'add', 'demo', '--read', join(repo, 'src')])).code, 1);
  assert.equal((await runCli(['workspace', 'remove', 'demo'])).code, 1);
  assert.match((await runCli(['workspace', 'list'])).stdout, /No workspaces registered/);

  const added = await runCli(['workspace', 'add', 'demo', '--read', repo]);
  assert.equal(added.code, 0, added.stderr);
  assert.equal((await runCli(['workspace', 'add', 'demo', '--read', repo])).code, 1);
  const registry = JSON.parse(await readFile(join(configDir, 'workspaces.json'), 'utf8'));
  assert.deepEqual(registry, { workspaces: { demo: { read_checkout: repo, work_checkout: repo } } });
  assert.match((await runCli(['workspace', 'list'])).stdout, /^demo\n {2}read: /);

  const broken = join(temp, 'broken');
  execFileSync('git', ['init', '-q', broken]);
  assert.equal((await runCli(['workspace', 'add', 'broken', '--read', repo, '--work', broken])).code, 0);
  assert.equal((await runCli(['workspace', 'add', 'gone', '--read', broken])).code, 0);
  assert.equal((await runCli(['workspace', 'remove', 'gone'])).code, 0);
  await rm(join(broken, '.git'), { recursive: true });
});

test('sf serve gives the Quick start as instructions and the planning and execution tools', async () => {
  const served = await serve();
  const client = await connect(served);
  const handbook = await readFile(HANDBOOK, 'utf8');
  const instructions = client.getInstructions() ?? '';
  assert.equal(instructions, quickStartSection(handbook));
  assert.match(instructions, /^## Quick start\n/);
  assert.doesNotMatch(instructions, /## The cycle/);
  assert.equal(client.getServerVersion()?.name, 'software-factory');
  assert.equal(client.getServerVersion()?.version, '0.1.0');

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['check', 'guide', 'mark_clean', 'read_file', 'request_fix', 'search', 'start', 'write_task']);
  const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
  assert.equal(annotations.read_file?.readOnlyHint, true);
  assert.equal(annotations.search?.readOnlyHint, true);
  assert.equal(annotations.write_task?.readOnlyHint, false);
  assert.deepEqual(await call(client, 'guide', {}), { text: handbook });

  await client.close();
  assert.equal(await stop(served), 0);
});

test('read_file and search work on the read checkout and skip ignored, .git and credential files', async () => {
  const served = await serve();
  const client = await connect(served);

  const read = await call(client, 'read_file', { workspace: 'demo', path: 'docs/hello.md' });
  assert.equal(read.text, 'Здравей 👋 needle\n');
  assert.equal(read.next_offset, null);
  const page = await call(client, 'read_file', { workspace: 'demo', path: 'docs/hello.md', max_bytes: 4 });
  assert.deepEqual([page.text, page.next_offset], ['Зд', 4]);
  assert.equal(await refusedCode(client, 'read_file', { workspace: 'demo', path: '.env' }), 'forbidden_path');
  assert.equal(await refusedCode(client, 'read_file', { workspace: 'demo', path: '../repo/docs/hello.md' }), 'invalid_path');
  assert.equal(await refusedCode(client, 'read_file', { workspace: 'missing', path: 'docs/hello.md' }), 'workspace_not_found');
  assert.equal(await refusedCode(client, 'read_file', { workspace: 'broken', path: 'docs/hello.md' }), 'workspace_invalid');

  const byPath = await call(client, 'search', { workspace: 'demo', query: 'E', mode: 'path' });
  assert.deepEqual((byPath.matches as Array<{ path: string }>).map((match) => match.path).sort(), ['.gitignore', 'docs/hello.md']);
  assert.equal(byPath.truncated, false);
  const allPaths = await call(client, 'search', { workspace: 'demo', query: 'needle', mode: 'path' });
  assert.deepEqual(allPaths.matches, []);

  const content = await call(client, 'search', { workspace: 'demo', query: 'needle', mode: 'content' });
  const matches = content.matches as Array<{ path: string; line: number; text: string }>;
  assert.deepEqual(matches.map((match) => `${match.path}:${match.line}`).sort(), ['.gitignore:1', 'docs/hello.md:1', 'src/app.ts:1', 'src/app.ts:2']);
  assert.equal(matches.find((match) => match.line === 2)?.text.length, 200);
  assert.equal(content.truncated, false);
  // Content search ignores case like path search.
  const cased = await call(client, 'search', { workspace: 'demo', query: 'NEEDLE', mode: 'content' });
  assert.deepEqual(
    (cased.matches as Array<{ path: string; line: number }>).map((match) => `${match.path}:${match.line}`).sort(),
    ['.gitignore:1', 'docs/hello.md:1', 'src/app.ts:1', 'src/app.ts:2'],
  );

  const prefixed = await call(client, 'search', { workspace: 'demo', query: 'needle', mode: 'content', path_prefix: 'docs', max_results: 1 });
  assert.deepEqual([(prefixed.matches as unknown[]).length, prefixed.truncated, prefixed.path_prefix], [1, false, 'docs']);
  const limited = await call(client, 'search', { workspace: 'demo', query: 'needle', mode: 'content', max_results: 3 });
  assert.deepEqual([(limited.matches as unknown[]).length, limited.truncated], [3, true]);

  for (const args of [
    { workspace: 'demo', query: '', mode: 'path' },
    { workspace: 'demo', query: 'x'.repeat(257), mode: 'path' },
    { workspace: 'demo', query: 'a\0b', mode: 'content' },
    { workspace: 'demo', query: 'x', mode: 'regex' },
    { workspace: 'demo', query: 'x', mode: 'path', max_results: 201 },
    { workspace: 'demo', query: 'x', mode: 'path', extra: true },
    { workspace: 'Demo', query: 'x', mode: 'path' },
  ]) {
    assert.ok(['schema', 'protocol'].includes(await refusedCode(client, 'search', args)), JSON.stringify(args));
  }
  assert.equal(await refusedCode(client, 'search', { workspace: 'demo', query: 'x', mode: 'path', path_prefix: '../x' }), 'invalid_path');

  await client.close();
  assert.equal(await stop(served), 0);
});

test('write_task writes the Task file into the work checkout and refuses invalid input', async () => {
  const served = await serve();
  const client = await connect(served);

  const written = await call(client, 'write_task', { workspace: 'demo', ticket: 'DEMO-1', content: TASK });
  assert.deepEqual([written.path, written.status, written.bytes], ['.software-factory/DEMO-1.md', 'created', Buffer.byteLength(TASK)]);
  const back = await call(client, 'read_file', { workspace: 'demo', path: '.software-factory/DEMO-1.md' });
  assert.deepEqual([back.text, back.sha256], [TASK, written.sha256]);
  assert.equal((await call(client, 'write_task', { workspace: 'demo', ticket: 'DEMO-1', content: TASK })).status, 'replaced');
  assert.match(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.software-factory\/$/m);
  const search = await call(client, 'search', { workspace: 'demo', query: 'DEMO-1', mode: 'path' });
  assert.deepEqual(search.matches, []);

  assert.equal(await refusedCode(client, 'write_task', { workspace: 'demo', ticket: 'DEMO-2', content: TASK }), 'invalid_content');
  assert.equal(await refusedCode(client, 'write_task', { workspace: 'demo', ticket: 'DEMO-1', content: '# no front matter\n' }), 'invalid_content');
  assert.equal(await refusedCode(client, 'write_task', { workspace: 'missing', ticket: 'DEMO-1', content: TASK }), 'workspace_not_found');
  assert.equal(await refusedCode(client, 'write_task', { workspace: 'broken', ticket: 'DEMO-1', content: TASK }), 'workspace_invalid');
  for (const args of [
    { workspace: 'demo', ticket: '../DEMO-1', content: TASK },
    { workspace: 'demo', ticket: 'DEMO-1', content: '' },
    { workspace: 'demo', ticket: 'DEMO-1', content: TASK, path: '/tmp/x' },
    { workspace: 'demo', ticket: 'DEMO-1' },
  ]) {
    assert.ok(['schema', 'protocol'].includes(await refusedCode(client, 'write_task', args)), JSON.stringify(args));
  }

  await client.close();
  assert.equal(await stop(served, 'SIGTERM'), 0);
});

test('sf serve guards Host and Origin, reports a busy port and refuses an invalid registry', async () => {
  const served = await serve();
  assert.equal(await postStatus(served.url, { host: `attacker.example:${served.port}` }), 403);
  assert.equal(await postStatus(served.url, { origin: 'https://attacker.example' }), 403);

  const busy = await runCli(['serve'], { SF_PORT: String(served.port), SF_STATE_DIR: join(temp, 'state-busy') });
  const second = await runCli(['serve']);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /already listening on the socket/);
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /already in use/);
  assert.equal(await stop(served), 0);

  const badConfig = join(temp, 'bad-config');
  await mkdir(badConfig);
  await writeFile(join(badConfig, 'workspaces.json'), '{"workspaces":{"x":{"read_checkout":"relative"}}}');
  const invalid = await runCli(['serve'], { SF_CONFIG_DIR: badConfig });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /workspaces\.json is invalid/);
  assert.equal((await runCli(['serve'], { SF_HANDBOOK: join(temp, 'missing.md') })).code, 1);
  assert.equal((await runCli(['serve'], { SF_PORT: 'abc' })).code, 1);
  const longState = await runCli(['serve'], { SF_STATE_DIR: join(temp, 'x'.repeat(120)) });
  assert.equal(longState.code, 1);
  assert.match(longState.stderr, /longer than 107 bytes; use a shorter SF_STATE_DIR/);
});
