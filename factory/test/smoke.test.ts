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
import { CheckStore, taskSha256 } from '../src/task-check.js';

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
  // No automatic Task check unless a test turns it on (SF-086).
  return { PATH: process.env.PATH, HOME: process.env.HOME, SF_CONFIG_DIR: configDir, SF_STATE_DIR: join(temp, 'state'), SF_PORT: '0', SF_DASHBOARD_PORT: '0', SF_TASK_CHECK_AUTO: 'off', ...extra };
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
  assert.deepEqual(registry, { workspaces: { demo: { read_checkout: repo } } });
  assert.match((await runCli(['workspace', 'list'])).stdout, /^demo\n {2}checkout: .*\n {2}hand-over: (checkout|off) \(SF_HANDOFF\)$/m);

  // --handoff (SF-083): the workspace's own hand-over setting, checkout or off; it wins over SF_HANDOFF.
  const wrong = await runCli(['workspace', 'add', 'own', '--read', repo, '--handoff', 'on']);
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /--handoff must be checkout or off, got "on"/);
  const own = await runCli(['workspace', 'add', 'own', '--read', repo, '--handoff', 'off']);
  assert.equal(own.code, 0, own.stderr);
  assert.match(own.stdout, /hand-over: off \(this workspace\)/);
  assert.deepEqual(JSON.parse(await readFile(join(configDir, 'workspaces.json'), 'utf8')).workspaces.own, { read_checkout: repo, handoff: 'off' });
  assert.match((await runCli(['workspace', 'list'])).stdout, /^own\n {2}checkout: .*\n {2}hand-over: off \(this workspace\)$/m);
  assert.equal((await runCli(['workspace', 'remove', 'own'])).code, 0);

  // --color (SF-084): one of the palette, refused with the list otherwise; without it the name picks
  // one; the same name and checkout again with --color or --handoff changes them and keeps the rest.
  const pink = await runCli(['workspace', 'add', 'tinted', '--read', repo, '--color', 'pink']);
  assert.equal(pink.code, 2);
  assert.match(pink.stderr, /--color must be one of blue, teal, green, olive, orange, red, purple, grey, got "pink"/);
  const tinted = await runCli(['workspace', 'add', 'tinted', '--read', repo, '--color', 'teal', '--handoff', 'off']);
  assert.equal(tinted.code, 0, tinted.stderr);
  assert.match(tinted.stdout, /Registered workspace "tinted" .*colour: teal\)/);
  assert.deepEqual(JSON.parse(await readFile(join(configDir, 'workspaces.json'), 'utf8')).workspaces.tinted, { read_checkout: repo, handoff: 'off', color: 'teal' });
  const recolored = await runCli(['workspace', 'add', 'tinted', '--read', repo, '--color', 'orange']);
  assert.equal(recolored.code, 0, recolored.stderr);
  assert.match(recolored.stdout, /Updated workspace "tinted" .*hand-over: off \(this workspace\); colour: orange\)/);
  assert.deepEqual(JSON.parse(await readFile(join(configDir, 'workspaces.json'), 'utf8')).workspaces.tinted, { read_checkout: repo, handoff: 'off', color: 'orange' });
  assert.match((await runCli(['workspace', 'list'])).stdout, /^tinted\n {2}checkout: .*\n {2}hand-over: off \(this workspace\)\n {2}colour: orange$/m);
  // demo has none: d+e+m+o = 100+101+109+111 = 421, 421 mod 8 = 5: red.
  assert.match((await runCli(['workspace', 'list'])).stdout, /^demo\n(?: {2}.*\n){2} {2}colour: red \(by its name\)$/m);
  // Another checkout under a registered name stays refused.
  const elsewhere = await runCli(['workspace', 'add', 'tinted', '--read', join(repo, 'src'), '--color', 'red']);
  assert.equal(elsewhere.code, 1);
  assert.equal((await runCli(['workspace', 'remove', 'tinted'])).code, 0);

  // --work is retired (SF-019): every job works in a worktree of the checkout.
  const broken = join(temp, 'broken');
  execFileSync('git', ['init', '-q', broken]);
  const retired = await runCli(['workspace', 'add', 'broken', '--read', repo, '--work', broken]);
  assert.equal(retired.code, 1);
  assert.match(retired.stderr, /--work is no longer supported/);
  assert.equal((await runCli(['workspace', 'add', 'broken', '--read', broken])).code, 0);
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
  // SF-040: the planning tools only; jobs are started, reviewed and approved elsewhere. SF-054: the
  // Context owner reads the Task check (task_check), it never runs one. SF-071: it reads the run
  // queue and adds to it (queue_list, queue_add); it neither removes nor moves. SF-064: it reads a
  // ticket's images (read_attachment).
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['guide', 'queue_add', 'queue_list', 'read_attachment', 'read_file', 'search', 'task_check', 'write_task']);
  const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
  assert.equal(annotations.task_check?.readOnlyHint, true);
  assert.equal(annotations.read_file?.readOnlyHint, true);
  assert.equal(annotations.search?.readOnlyHint, true);
  assert.equal(annotations.write_task?.readOnlyHint, false);
  assert.equal(annotations.queue_list?.readOnlyHint, true);
  assert.equal(annotations.queue_add?.readOnlyHint, false);
  assert.equal(annotations.read_attachment?.readOnlyHint, true);
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
  // SF_TASK_CHECK_AUTO=off: no automatic check, nothing pending.
  assert.equal(written.check, 'off');
  assert.equal(written.check_after_seconds, undefined);
  assert.deepEqual([(await call(client, 'task_check', { workspace: 'demo', ticket: 'DEMO-1' })).pending], [false]);
  const back = await call(client, 'read_file', { workspace: 'demo', path: '.software-factory/DEMO-1.md' });
  assert.deepEqual([back.text, back.sha256], [TASK, written.sha256]);
  assert.equal((await call(client, 'write_task', { workspace: 'demo', ticket: 'DEMO-1', content: TASK })).status, 'replaced');
  assert.match(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.software-factory\/$/m);
  // SF-081: each write is recorded in the ticket's history as written by the Context owner, with the
  // sha256 of the text; a refused write records nothing.
  const recorded = async (): Promise<unknown[]> => (await readFile(join(temp, 'state', 'tickets', 'demo', 'DEMO-1', 'history.jsonl'), 'utf8')).trimEnd().split('\n').map((line) => {
    const { kind, by, sha256 } = JSON.parse(line);
    return [kind, by, sha256];
  });
  assert.deepEqual(await recorded(), [['written', 'context_owner', written.sha256], ['written', 'context_owner', written.sha256]]);
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
  assert.equal((await recorded()).length, 2);

  await client.close();
  assert.equal(await stop(served, 'SIGTERM'), 0);
});

test('read_attachment returns a ticket\'s image as MCP image content with one text line, and refuses with the attachments\' codes', async () => {
  const served = await serve();
  const client = await connect(served);
  const ticket = 'DEMO-7';
  const content = TASK.replaceAll('DEMO-1', ticket);
  await call(client, 'write_task', { workspace: 'demo', ticket, content });
  const dir = join(repo, '.software-factory', ticket);
  await mkdir(dir, { recursive: true });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
  const gif = Buffer.from('GIF89a-frames');
  await writeFile(join(dir, '1.png'), png);
  await writeFile(join(dir, 'anim.gif'), gif);
  await writeFile(join(dir, 'fake.png'), 'not an image');

  const read = await client.callTool({ name: 'read_attachment', arguments: { workspace: 'demo', ticket, name: '1.png' } });
  assert.equal(read.isError ?? false, false, JSON.stringify(read.content));
  assert.deepEqual(read.content, [
    { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    { type: 'text', text: `1.png: image/png, ${png.length} bytes` },
  ]);
  const animated = await client.callTool({ name: 'read_attachment', arguments: { workspace: 'demo', ticket, name: 'anim.gif' } });
  assert.deepEqual((animated.content as Array<Record<string, unknown>>)[0], { type: 'image', data: gif.toString('base64'), mimeType: 'image/gif' });

  // The Task file may now refer to it; a reference to an image the ticket does not have is refused.
  await call(client, 'write_task', { workspace: 'demo', ticket, content: `${content}
![the screen](${ticket}/1.png)
` });
  assert.equal(await refusedCode(client, 'write_task', { workspace: 'demo', ticket, content: `${content}
![gone](${ticket}/2.png)
` }), 'attachment_missing');

  assert.equal(await refusedCode(client, 'read_attachment', { workspace: 'demo', ticket, name: '2.png' }), 'attachment_missing');
  assert.equal(await refusedCode(client, 'read_attachment', { workspace: 'demo', ticket, name: 'fake.png' }), 'attachment_type');
  assert.equal(await refusedCode(client, 'read_attachment', { workspace: 'demo', ticket: 'DEMO-404', name: '1.png' }), 'task_not_found');
  assert.equal(await refusedCode(client, 'read_attachment', { workspace: 'demo', ticket: 'archive', name: '1.png' }), 'invalid_ticket');
  assert.equal(await refusedCode(client, 'read_attachment', { workspace: 'missing', ticket, name: '1.png' }), 'workspace_not_found');
  for (const name of ['../DEMO-7.md', 'a/1.png', '/etc/passwd', '1.txt', '1.PNG']) {
    assert.ok(['schema', 'protocol'].includes(await refusedCode(client, 'read_attachment', { workspace: 'demo', ticket, name })), name);
  }

  await client.close();
  assert.equal(await stop(served, 'SIGTERM'), 0);
});

test('write_task with the automatic Task check (SF-086): scheduled after 60 s and pending in task_check, draft for a skeleton, already_checked for a text with a check', async () => {
  // A check that fired would fail at once (no such executable), stored as failed and not notified.
  const served = await serve({ SF_TASK_CHECK_AUTO: 'on', SF_CLAUDE: join(temp, 'no-such-claude'), SF_DESKTOP_NOTIFY: 'off' });
  const client = await connect(served);
  try {
    const text = TASK.replace('Demo task', 'Automatic check');
    const written = await call(client, 'write_task', { workspace: 'demo', ticket: 'DEMO-1', content: text });
    assert.deepEqual([written.check, written.check_after_seconds], ['scheduled', 60]);
    const read = await call(client, 'task_check', { workspace: 'demo', ticket: 'DEMO-1' });
    assert.deepEqual([read.verdict, read.running, read.pending], ['none', false, true]);
    const draft = `${text}\n## Status: waiting for the Context owner\n`;
    assert.deepEqual((await call(client, 'write_task', { workspace: 'demo', ticket: 'DEMO-1', content: draft })).check, 'draft');
    const checked = TASK.replace('Demo task', 'Checked before');
    const at = new Date().toISOString();
    await new CheckStore(join(temp, 'state')).write({
      workspace: 'demo', ticket: 'DEMO-1', sha256: taskSha256(checked), commit: null, status: 'checked', output: { paraphrase: 'p', findings: [], files: [], verdict: 'ready' },
      error: null, model: null, cost_usd: null, started_at: at, ended_at: at,
    });
    const again = await call(client, 'write_task', { workspace: 'demo', ticket: 'DEMO-1', content: checked });
    assert.deepEqual([again.check, again.check_after_seconds], ['already_checked', undefined]);
    assert.equal((await call(client, 'task_check', { workspace: 'demo', ticket: 'DEMO-1' })).verdict, 'ready');
    // Back to the original Task for the tests after this one.
    await call(client, 'write_task', { workspace: 'demo', ticket: 'DEMO-1', content: TASK });
  } finally {
    await client.close();
    assert.equal(await stop(served, 'SIGTERM'), 0);
  }
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

test('sf rules (SF-059): the rule files that would be given, without their text: at the checkout\'s HEAD, the Task file\'s base, or the job\'s base commit', async () => {
  const rulesRepo = join(temp, 'rules-repo');
  const gitIn = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: rulesRepo, encoding: 'utf8' });
  await mkdir(join(rulesRepo, 'docs'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', rulesRepo]);
  await writeFile(join(rulesRepo, 'AGENTS.md'), 'See [style](docs/style.md) and [runbook](docs/runbook.md).\n');
  await writeFile(join(rulesRepo, 'docs', 'style.md'), 'SECRET-STYLE-TEXT\n');
  await writeFile(join(rulesRepo, 'docs', 'runbook.md'), 'Runbook\n');
  gitIn('add', '-A');
  gitIn('commit', '-q', '-m', 'rules');
  const first = gitIn('rev-parse', 'HEAD').trim();
  await writeFile(join(rulesRepo, 'AGENTS.md'), 'See [style](docs/style.md), [runbook](docs/runbook.md) and [new](docs/new.md).\n');
  await writeFile(join(rulesRepo, 'docs', 'new.md'), 'New\n');
  gitIn('add', '-A');
  gitIn('commit', '-q', '-m', 'more rules');
  const second = gitIn('rev-parse', 'HEAD').trim();
  // HEAD on another branch than the Task's base.
  gitIn('checkout', '-q', '-b', 'other');
  await writeFile(join(rulesRepo, 'AGENTS.md'), 'Only the HEAD.\n');
  gitIn('commit', '-q', '-am', 'other rules');
  const head = gitIn('rev-parse', 'HEAD').trim();
  assert.equal((await runCli(['workspace', 'add', 'rules-demo', '--read', rulesRepo])).code, 0);
  const registry = JSON.parse(await readFile(join(configDir, 'workspaces.json'), 'utf8'));
  registry.workspaces['rules-demo'].rules_skip = ['docs/runbook.md'];
  await writeFile(join(configDir, 'workspaces.json'), JSON.stringify(registry));
  await mkdir(join(configDir, 'rules'), { recursive: true });
  await writeFile(join(configDir, 'rules', 'global.md'), 'Global\n');

  const atHead = await runCli(['rules', 'rules-demo'], { SF_RULES_MAX_BYTES: '200' });
  assert.equal(atHead.code, 0, atHead.stderr);
  assert.equal(atHead.stdout, `Rules for rules-demo at ${head} (budget 200 bytes):\n  repository  AGENTS.md  15 bytes\n  global  rules/global.md  7 bytes\n`);

  await mkdir(join(rulesRepo, '.software-factory'));
  await writeFile(join(rulesRepo, '.software-factory', 'T-1.md'), '---\nticket: T-1\ntitle: Rules\nbase: main\n---\n\n# T-1: Rules\n\nx\n');
  const atBase = await runCli(['rules', 'rules-demo', 'T-1'], { SF_RULES_MAX_BYTES: '100' });
  assert.equal(atBase.code, 0, atBase.stderr);
  assert.equal(atBase.stdout, [
    `Rules for rules-demo at ${second} (budget 100 bytes):`, '  repository  AGENTS.md  79 bytes', '  repository  docs/style.md  18 bytes',
    'Left out (over the budget):', '  repository  docs/new.md  4 bytes', '  global  rules/global.md  7 bytes',
    'Skipped by rules_skip:', '  repository  docs/runbook.md', '',
  ].join('\n'));
  assert.ok(!atBase.stdout.includes('SECRET-STYLE-TEXT'));

  const { JobStore } = await import('../src/jobs.js');
  const now = new Date().toISOString();
  await new JobStore(join(temp, 'state')).write({
    workspace: 'rules-demo', ticket: 'T-1', branch: 'T-1-rules', base: 'main', base_commit: first, worktree: null, prepared_commit: null,
    target_commit: null, mr_attempts: 0, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'aborted', iteration: 0, session_id: null, mr: null, created_at: now, updated_at: now,
  });
  // A job started before SF-059: nothing stored, no rules in its prompts.
  const before = await runCli(['rules', 'rules-demo', 'T-1']);
  assert.equal(before.code, 0, before.stderr);
  assert.equal(before.stdout, 'The job of rules-demo/T-1 has no stored rules (it started before SF-059): its prompts carry no <rules> block.\n');
  // A job with stored rules: its own list, whatever the rules files and the budget say today.
  const { collectRules, writeJobRules } = await import('../src/rules-docs.js');
  const jobDir = join(temp, 'state', 'jobs', 'rules-demo', 'T-1');
  await writeJobRules(jobDir, await collectRules(rulesRepo, first, { workspace: 'rules-demo', skip: ['docs/runbook.md'], configDir, maxBytes: 49152 }));
  await rm(join(configDir, 'rules', 'global.md'));
  const atJob = await runCli(['rules', 'rules-demo', 'T-1'], { SF_RULES_MAX_BYTES: '10' });
  assert.equal(atJob.code, 0, atJob.stderr);
  assert.equal(atJob.stdout, [
    `Rules for rules-demo at ${first} (budget 49152 bytes):`, '  repository  AGENTS.md  59 bytes', '  repository  docs/style.md  18 bytes', '  global  rules/global.md  7 bytes',
    'Skipped by rules_skip:', '  repository  docs/runbook.md', "Stored at the job's Start: the rules its prompts carry.", '',
  ].join('\n'));

  assert.equal((await runCli(['rules'])).code, 2);
  assert.equal((await runCli(['rules', 'rules-demo', 'T-1', 'x'])).code, 2);
  assert.equal((await runCli(['rules', 'rules-demo'], { SF_RULES_MAX_BYTES: '0' })).code, 1);
  assert.equal((await runCli(['rules', 'nope'])).code, 1);
});
