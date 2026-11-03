// Shared helpers of the end-to-end tests: the real `sf serve` and `sf` CLI with private config
// and state directories, throwaway Git repositories and the fake Claude Code
// (test/support/fake-claude.ts) as the Implementer executable, tools driven through the official
// MCP client. Importing it registers the before/after hooks that create and remove the temp dir.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { JobStore } from '../../src/jobs.js';
import { saveRegistry } from '../../src/registry.js';
import { writeTask } from '../../src/task-file.js';

export const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
export const FAKE = fileURLToPath(new URL('./fake-claude.js', import.meta.url));
const READY = /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/;
const DASHBOARD = /dashboard (http:\/\/127\.0\.0\.1:\d+\/d\/[0-9a-f]{64}\/)/;

export let temp: string;
const running = new Set<ChildProcess>();

export interface Env {
  config: string;
  state: string;
  home: string;
  extra?: Record<string, string>;
}

export interface Served {
  child: ChildProcess;
  client: Client;
  // The printed MCP endpoint URL.
  url: URL;
  // What sf serve printed up to the listening line.
  output: string;
  // The printed dashboard URL; undefined with SF_DASHBOARD=off.
  dashboard: URL | undefined;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function processEnv(env: Env): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: env.home,
    SF_CONFIG_DIR: env.config,
    SF_STATE_DIR: env.state,
    SF_PORT: '0',
    SF_DASHBOARD_PORT: '0',
    SF_CLAUDE: FAKE,
    // The machine's real notify-send stays quiet; the notification test sets its own PATH.
    SF_DESKTOP_NOTIFY: 'off',
    // No real tunnel: sf up reports the missing script unless the test gives a fake one.
    SF_TUNNEL_SCRIPT: join(temp, 'no-such-tunnel.sh'),
    ...env.extra,
  };
}

export async function newEnv(name: string, extra: Record<string, string> = {}): Promise<Env> {
  const root = join(temp, name);
  const env = { config: join(root, 'config'), state: join(root, 'state'), home: join(root, 'home'), extra };
  await mkdir(env.home, { recursive: true });
  return env;
}

export async function script(env: Env, turns: unknown[]): Promise<void> {
  await writeFile(join(env.home, 'fake-claude.json'), JSON.stringify({ turns }));
  await rm(join(env.home, 'fake-claude.count'), { force: true });
}

export async function fakeLog(env: Env): Promise<Array<{ argv: string[]; prompt: string; sessionId: string; cwd: string; env: string[] }>> {
  return (await readFile(join(env.home, 'fake-claude.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

// A repository with one commit on main; with origin, the work checkout is a clone of a bare repo.
export async function newRepo(env: Env, name: string, withOrigin: boolean): Promise<string> {
  const seed = join(temp, `${name}-seed`);
  await mkdir(seed);
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(join(seed, 'README.md'), 'hello\n');
  await writeFile(join(seed, '.gitignore'), '*.log\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'initial');
  let repo = seed;
  if (withOrigin) {
    const bare = join(temp, `${name}-origin.git`);
    execFileSync('git', ['clone', '-q', '--bare', seed, bare]);
    repo = join(temp, name);
    execFileSync('git', ['clone', '-q', bare, repo]);
  }
  await saveRegistry({ workspaces: { app: { read_checkout: repo, work_checkout: repo } } }, env.config);
  return repo;
}

export function task(ticket: string, title: string, base = 'main'): string {
  return `---\nticket: ${ticket}\ntitle: ${title}\nbase: ${base}\n---\n\n# ${ticket}: ${title}\n\nChange the README.\n`;
}

export async function putTask(env: Env, repo: string, ticket: string, title: string, base = 'main'): Promise<void> {
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, ticket, task(ticket, title, base), new JobStore(env.state));
}

export function runCli(env: Env, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: processEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// args: the sf command line (`serve`, or `up` with its options).
export async function serve(env: Env, args: string[] = ['serve']): Promise<Served> {
  const child = spawn(process.execPath, [CLI, ...args], { env: processEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(child);
  child.once('exit', () => running.delete(child));
  let dashboard: URL | undefined;
  let output = '';
  const url = await new Promise<URL>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = READY.exec(output);
      if (match) {
        child.stdout.off('data', onData);
        const printed = DASHBOARD.exec(output);
        dashboard = printed ? new URL(printed[1]!) : undefined;
        resolve(new URL(match[1]!));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.once('exit', (code) => reject(new Error(`sf serve exited with ${code}:\n${output}`)));
  });
  const client = new Client({ name: 'sf-011-execution', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  return { child, client, url, output, dashboard };
}

export async function stop(served: Served, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  await served.client.close();
  await new Promise<void>((resolve) => {
    if (served.child.exitCode !== null) {
      resolve();
      return;
    }
    served.child.once('exit', () => resolve());
    served.child.kill(signal);
  });
}

export async function call(served: Served, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await served.client.callTool({ name, arguments: args });
  assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
  return result.structuredContent as Record<string, any>;
}

export async function refused(served: Served, name: string, args: Record<string, unknown>): Promise<{ code: string; message: string }> {
  const result = await served.client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `expected ${name} to be refused`);
  const [block] = result.content as Array<{ text: string }>;
  return JSON.parse(block!.text);
}

export async function waitFor(served: Served, ticket: string, state: string, iteration?: number): Promise<Record<string, any>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const checked = await call(served, 'check', { workspace: 'app', ticket });
    if (checked.state === state && (iteration === undefined || checked.iteration === iteration)) {
      return checked;
    }
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${state}: ${JSON.stringify(checked)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

before(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'sf-exec-')));
});

after(async () => {
  for (const child of running) {
    child.kill('SIGKILL');
  }
  await rm(temp, { recursive: true, force: true });
});

