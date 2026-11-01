// End-to-end execution tests: the real `sf serve` and `sf` CLI with private config and state
// directories, throwaway Git repositories and the fake Claude Code (test/support/fake-claude.ts)
// as the Implementer executable. Tools are driven through the official MCP client.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { JobStore } from '../src/jobs.js';
import { FACTORY_PROMPT_RULES, factoryPrompt } from '../src/prompts.js';
import { saveRegistry } from '../src/registry.js';
import { writeTask } from '../src/task-file.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./support/fake-claude.js', import.meta.url));
const READY = /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/;

let temp: string;
const running = new Set<ChildProcess>();

interface Env {
  config: string;
  state: string;
  home: string;
  extra?: Record<string, string>;
}

interface Served {
  child: ChildProcess;
  client: Client;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function processEnv(env: Env): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: env.home,
    SF_CONFIG_DIR: env.config,
    SF_STATE_DIR: env.state,
    SF_PORT: '0',
    SF_CLAUDE: FAKE,
    ...env.extra,
  };
}

async function newEnv(name: string, extra: Record<string, string> = {}): Promise<Env> {
  const root = join(temp, name);
  const env = { config: join(root, 'config'), state: join(root, 'state'), home: join(root, 'home'), extra };
  await mkdir(env.home, { recursive: true });
  return env;
}

async function script(env: Env, turns: unknown[]): Promise<void> {
  await writeFile(join(env.home, 'fake-claude.json'), JSON.stringify({ turns }));
  await rm(join(env.home, 'fake-claude.count'), { force: true });
}

async function fakeLog(env: Env): Promise<Array<{ argv: string[]; prompt: string; sessionId: string; env: string[] }>> {
  return (await readFile(join(env.home, 'fake-claude.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

// A repository with one commit on main; with origin, the work checkout is a clone of a bare repo.
async function newRepo(env: Env, name: string, withOrigin: boolean): Promise<string> {
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

function task(ticket: string, title: string, base = 'main'): string {
  return `---\nticket: ${ticket}\ntitle: ${title}\nbase: ${base}\n---\n\n# ${ticket}: ${title}\n\nChange the README.\n`;
}

async function putTask(env: Env, repo: string, ticket: string, title: string, base = 'main'): Promise<void> {
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, ticket, task(ticket, title, base), new JobStore(env.state));
}

function runCli(env: Env, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: processEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function serve(env: Env): Promise<Served> {
  const child = spawn(process.execPath, [CLI, 'serve'], { env: processEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(child);
  child.once('exit', () => running.delete(child));
  const url = await new Promise<URL>((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = READY.exec(output);
      if (match) {
        child.stdout.off('data', onData);
        resolve(new URL(match[1]!));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.once('exit', (code) => reject(new Error(`sf serve exited with ${code}:\n${output}`)));
  });
  const client = new Client({ name: 'sf-011-execution', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  return { child, client };
}

async function stop(served: Served, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
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

async function call(served: Served, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await served.client.callTool({ name, arguments: args });
  assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
  return result.structuredContent as Record<string, any>;
}

async function refused(served: Served, name: string, args: Record<string, unknown>): Promise<{ code: string; message: string }> {
  const result = await served.client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `expected ${name} to be refused`);
  const [block] = result.content as Array<{ text: string }>;
  return JSON.parse(block!.text);
}

async function waitFor(served: Served, ticket: string, state: string, iteration?: number): Promise<Record<string, any>> {
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

test('full cycle: start, awaiting_review with Report and Patch, request_fix, second iteration, mark_clean, watch', async () => {
  const env = await newEnv('cycle', { CLAUDE_CODE_SESSION_ID: 'outer', CLAUDE_CODE_CHILD_SESSION: '1', ANTHROPIC_API_KEY: 'test-key' });
  const repo = await newRepo(env, 'cycle-repo', true);
  await putTask(env, repo, 'DEMO-1', 'Export as CSV!');
  await script(env, [
    {
      tool: true,
      denials: ['Bash'],
      text: '# Report: DEMO-1, iteration 1\n\n## Done\nChanged the README.',
      write: { 'README.md': 'hello world\n', 'src/new.ts': 'export {};\n', 'debug.log': 'ignored\n', '.env': 'SECRET=fake\n' },
    },
    { costTotal: 0.05, text: '# Report: DEMO-1, iteration 2\n\n## Fix 1 items\n| 1 | x | fixed | |', write: { 'src/new.ts': 'export const x = 1;\n' } },
  ]);
  const served = await serve(env);

  const started = await call(served, 'start', { workspace: 'app', ticket: 'DEMO-1' });
  assert.deepEqual(started, { branch: 'DEMO-1-export-as-csv', state: 'working', check_after_minutes: 15 });
  assert.equal((await refused(served, 'write_task', { workspace: 'app', ticket: 'DEMO-1', content: task('DEMO-1', 'Other') })).code, 'job_active');

  const first = await waitFor(served, 'DEMO-1', 'awaiting_review', 1);
  assert.equal(first.branch, 'DEMO-1-export-as-csv');
  assert.equal(first.check_after_minutes, null);
  assert.match(first.report, /^# Report: DEMO-1, iteration 1\n/);
  assert.match(first.report, /\n## Changed files\n\n\| Path \| Added \| Removed \|\n\|---\|---\|---\|\n\| README\.md \| 1 \| 1 \|\n\| src\/new\.ts \| 1 \| 0 \|\n/);
  assert.match(first.report, /\n## Denied actions\n\n- Bash\n$/);
  assert.doesNotMatch(first.report, /secret-input/);
  const patch = first.patch;
  assert.equal(patch.offset, 0);
  assert.equal(patch.next_offset, null);
  assert.match(patch.text, /^diff --git a\/README\.md b\/README\.md\n/);
  assert.match(patch.text, /\+\+\+ b\/src\/new\.ts/);
  assert.doesNotMatch(patch.text, /debug\.log|\.env|SECRET|\.software-factory/);
  const page = await call(served, 'check', { workspace: 'app', ticket: 'DEMO-1', max_bytes: 64 });
  assert.deepEqual([page.patch.offset, page.patch.next_offset, page.patch.sha256], [0, 64, patch.sha256]);
  const next = await call(served, 'check', { workspace: 'app', ticket: 'DEMO-1', offset: 64, max_bytes: 64 });
  assert.equal(next.patch.text, patch.text.slice(64, 128));

  // The factory created the branch from origin/main and touched neither HEAD's commit nor the index.
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'DEMO-1-export-as-csv');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/main'));
  assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');
  const jobDir = join(env.state, 'jobs', 'app', 'DEMO-1');
  const meta = JSON.parse(await readFile(join(jobDir, 'iterations', '001', 'meta.json'), 'utf8'));
  assert.deepEqual([meta.iteration, meta.denials, meta.patch_truncated, meta.submodule_changed, meta.cost_usd, meta.cost_usd_total], [1, ['Bash'], false, [], 0.0123, 0.0123]);
  // The branch tracks nothing, so a later push cannot go to origin/main by accident.
  assert.throws(() => git(repo, 'config', '--get', 'branch.DEMO-1-export-as-csv.remote'));
  assert.throws(() => git(repo, 'config', '--get', 'branch.DEMO-1-export-as-csv.merge'));
  assert.deepEqual(meta.changed_files, [{ path: 'README.md', added: 1, removed: 1 }, { path: 'src/new.ts', added: 1, removed: 0 }]);

  const fix = await call(served, 'request_fix', { workspace: 'app', ticket: 'DEMO-1', content: '1. src/new.ts: export a value.' });
  assert.deepEqual(fix, { iteration: 2, check_after_minutes: 5 });
  const taskText = await readFile(join(repo, '.software-factory', 'DEMO-1.md'), 'utf8');
  assert.equal(taskText, `${task('DEMO-1', 'Export as CSV!')}\n\n## Fix 1\n\n1. src/new.ts: export a value.\n`);
  const second = await waitFor(served, 'DEMO-1', 'awaiting_review', 2);
  assert.match(second.report, /^# Report: DEMO-1, iteration 2\n/);
  assert.doesNotMatch(second.report, /Denied actions/);
  assert.match(second.patch.text, /\+export const x = 1;/);

  const log = await fakeLog(env);
  assert.deepEqual(log.map((entry) => entry.prompt), [
    factoryPrompt('/implement .software-factory/DEMO-1.md', 'DEMO-1', 1),
    factoryPrompt('/implement .software-factory/DEMO-1.md Fix 1', 'DEMO-1', 2),
  ]);
  assert.match(log[0]!.prompt, /^\/implement \.software-factory\/DEMO-1\.md\n\nRules from the Software Factory:\n/);
  assert.match(log[0]!.prompt, /Do not edit \.software-factory\/DEMO-1\.md;.*\n.*\n  # Report: DEMO-1, iteration 1\n/);
  assert.match(log[1]!.prompt, /  # Report: DEMO-1, iteration 2\n/);
  assert.ok(log[1]!.prompt.endsWith('  ## Fix N items (only when answering a Fix section: a table of each item, fixed or rejected, with a note)'));
  const meta2 = JSON.parse(await readFile(join(jobDir, 'iterations', '002', 'meta.json'), 'utf8'));
  assert.deepEqual([meta2.cost_usd, meta2.cost_usd_total], [0.0377, 0.05]);
  assert.equal(log[1]!.sessionId, log[0]!.sessionId);
  assert.ok(log[1]!.argv.includes(`--resume=${log[0]!.sessionId}`));
  assert.ok(!log[0]!.argv.some((arg) => arg.startsWith('--resume')));
  for (const flag of ['--permission-mode=auto', '--setting-sources=user,project', '--max-turns=150']) {
    assert.ok(log[1]!.argv.includes(flag), flag);
  }
  assert.ok(log[0]!.argv.some((arg) => arg.startsWith('--disallowedTools=') && arg.includes('Bash(git commit:*)') && arg.includes('Read(**/.env)')));
  assert.ok(log[0]!.env.includes('ANTHROPIC_API_KEY'));
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'SF_STATE_DIR', 'SF_CLAUDE']) {
    assert.ok(!log[0]!.env.includes(name), name);
  }
  const job = JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8'));
  assert.equal(job.session_id, log[0]!.sessionId);

  assert.deepEqual(await call(served, 'mark_clean', { workspace: 'app', ticket: 'DEMO-1' }), {
    state: 'ready_for_human_review', iteration: 2, branch: 'DEMO-1-export-as-csv',
  });
  assert.equal((await refused(served, 'request_fix', { workspace: 'app', ticket: 'DEMO-1', content: 'x' })).code, 'invalid_state');
  // After Clean the last Report and Patch stay readable.
  const clean = await call(served, 'check', { workspace: 'app', ticket: 'DEMO-1' });
  assert.deepEqual([clean.state, clean.report, clean.patch.sha256], ['ready_for_human_review', second.report, second.patch.sha256]);

  const watched = await runCli(env, ['watch', 'app', 'DEMO-1', '--once']);
  assert.equal(watched.code, 0, watched.stderr);
  const lines = watched.stdout;
  assert.match(lines, /^\d\d:\d\d:\d\d \[0\] state - -> starting$/m);
  assert.match(lines, /\[1\] > \/implement \.software-factory\/DEMO-1\.md$/m);
  assert.match(lines, /\[1\] session [0-9a-f-]{36} \(permission mode auto, model fake-model\)$/m);
  assert.match(lines, /\[1\] tool_use Bash \{"command":"npm test","description":"Run the tests"\}$/m);
  assert.match(lines, /\[1\] tool_result: ok 1 tests passed$/m);
  assert.match(lines, /\[1\] assistant: # Report: DEMO-1, iteration 1$/m);
  assert.match(lines, /\[1\] result success, cost \$0\.0123, duration 1\.2 s, 2 turns$/m);
  assert.match(lines, /\[1\] state working -> awaiting_review$/m);
  assert.match(lines, /\[1\]            ## Done$/m);
  assert.match(lines, /\[2\] > \/implement \.software-factory\/DEMO-1\.md Fix 1$/m);
  assert.match(lines, /\[2\] state awaiting_review -> ready_for_human_review$/m);

  const status = await runCli(env, ['status']);
  assert.match(status.stdout, /^WORKSPACE\s+TICKET\s+STATE\s+ITER\s+BRANCH\s+SINCE\s+ERROR\napp\s+DEMO-1\s+ready_for_human_review\s+2\s+DEMO-1-export-as-csv\s/);
  // write_task stays refused until the job is terminal.
  assert.equal((await refused(served, 'write_task', { workspace: 'app', ticket: 'DEMO-1', content: task('DEMO-1', 'Other') })).code, 'job_active');
  assert.equal((await stat(join(env.state, 'sf.sock'))).mode & 0o777, 0o600);
  await stop(served);
  await assert.rejects(stat(join(env.state, 'sf.sock')), { code: 'ENOENT' });
  // status and watch work without the server.
  assert.match((await runCli(env, ['status', 'app', 'DEMO-1'])).stdout, /ready_for_human_review/);
  assert.equal((await runCli(env, ['watch', 'app', 'DEMO-1', '--once'])).code, 0);
});

test('queue and limits: say during a turn, job_active, iteration_limit, checkout_dirty, base_not_found, branch_exists', async () => {
  const env = await newEnv('limits', { SF_MAX_ITERATIONS: '1' });
  const repo = await newRepo(env, 'limits-repo', false);
  for (const [ticket, title, base] of [['Q-1', 'First'], ['Q-2', 'Second'], ['Q-3', 'Third', 'nope'], ['Q-4', 'Fourth']] as const) {
    await putTask(env, repo, ticket, title, base);
  }
  await script(env, [{ delayMs: 1500, write: { 'a.txt': '1\n' }, text: 'first turn' }, { text: 'after say' }, { text: 'continued' }]);
  const served = await serve(env);

  await call(served, 'start', { workspace: 'app', ticket: 'Q-1' });
  const said = await runCli(env, ['say', 'app', 'Q-1', 'also', 'do', 'this']);
  assert.equal(said.code, 0, said.stderr);
  assert.match(said.stdout, /^state: working\nqueued: true$/m);
  const active = await refused(served, 'start', { workspace: 'app', ticket: 'Q-2' });
  assert.equal(active.code, 'job_active');
  assert.match(active.message, /app\/Q-1/);

  // Both turns form one iteration; the second resumed the session.
  const first = await waitFor(served, 'Q-1', 'awaiting_review', 1);
  assert.match(first.report, /^after say\n/);
  const log = await fakeLog(env);
  assert.deepEqual(log.map((entry) => entry.prompt), [factoryPrompt('/implement .software-factory/Q-1.md', 'Q-1', 1), factoryPrompt('also do this', 'Q-1', 1)]);
  assert.ok(log[1]!.prompt.startsWith('also do this\n\nRules from the Software Factory:\n'));
  assert.ok(log[1]!.prompt.includes(FACTORY_PROMPT_RULES.split('\n')[1]!));
  assert.ok(log[1]!.argv.includes(`--resume=${log[0]!.sessionId}`));

  const limit = await refused(served, 'request_fix', { workspace: 'app', ticket: 'Q-1', content: 'more' });
  assert.equal(limit.code, 'iteration_limit');
  const human = await call(served, 'check', { workspace: 'app', ticket: 'Q-1' });
  assert.deepEqual([human.state, human.error?.code], ['needs_human', 'iteration_limit']);
  // needs_human still returns the last Report and Patch.
  assert.deepEqual([human.report, human.patch.sha256], [first.report, first.patch.sha256]);
  assert.doesNotMatch(await readFile(join(repo, '.software-factory', 'Q-1.md'), 'utf8'), /## Fix/);

  // sf say continues a needs_human job; its turn end publishes a new iteration.
  assert.match((await runCli(env, ['say', 'app', 'Q-1', 'go', 'on'])).stdout, /^state: working\nqueued: false$/m);
  const continued = await waitFor(served, 'Q-1', 'awaiting_review', 2);
  assert.equal(continued.error, undefined);
  assert.match(continued.report, /^continued\n/);
  await call(served, 'mark_clean', { workspace: 'app', ticket: 'Q-1' });
  assert.equal((await runCli(env, ['say', 'app', 'Q-1', 'x'])).code, 1);
  assert.equal((await refused(served, 'start', { workspace: 'app', ticket: 'Q-1' })).code, 'job_exists');

  // Q-1 left a.txt behind on its branch.
  const dirty = await refused(served, 'start', { workspace: 'app', ticket: 'Q-2' });
  assert.deepEqual(dirty, { code: 'checkout_dirty', message: 'The work checkout has 1 uncommitted change(s).' });
  await rm(join(repo, 'a.txt'));
  git(repo, 'checkout', '-q', 'main');

  assert.equal((await refused(served, 'start', { workspace: 'app', ticket: 'Q-3' })).code, 'base_not_found');
  assert.equal((await call(served, 'check', { workspace: 'app', ticket: 'Q-3' })).state, 'failed');
  git(repo, 'branch', 'Q-4-fourth');
  assert.equal((await refused(served, 'start', { workspace: 'app', ticket: 'Q-4' })).code, 'branch_exists');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  // A failed job is archived by the next start of the same ticket.
  git(repo, 'branch', '-q', '-D', 'Q-4-fourth');
  assert.equal((await call(served, 'start', { workspace: 'app', ticket: 'Q-4' })).state, 'working');
  await waitFor(served, 'Q-4', 'awaiting_review', 1);
  const archived = (await readdir(join(env.state, 'jobs', 'app'))).filter((name) => name.startsWith('Q-4.'));
  assert.equal(archived.length, 1);
  assert.equal(JSON.parse(await readFile(join(env.state, 'jobs', 'app', archived[0]!, 'job.json'), 'utf8')).state, 'failed');
  assert.match((await runCli(env, ['status'])).stdout, /\napp\s+Q-4\s+awaiting_review/);
  assert.doesNotMatch((await runCli(env, ['status'])).stdout, /Q-4\./);
  await stop(served);
  assert.equal((await runCli(env, ['say', 'app', 'Q-4', 'hello'])).stderr, 'sf: sf serve is not running.\n');
});

test('permission_mode_mismatch ends in needs_human; a restart turns working jobs into needs_human and sf say resumes them', async () => {
  const env = await newEnv('restart');
  const repo = await newRepo(env, 'restart-repo', false);
  await putTask(env, repo, 'M-1', 'Mismatch');
  await script(env, [{ permissionMode: 'default' }, { text: 'resumed report' }]);
  let served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'M-1' });
  const mismatch = await waitFor(served, 'M-1', 'needs_human');
  assert.equal(mismatch.error.code, 'permission_mode_mismatch');
  assert.equal(mismatch.iteration, 0);
  assert.deepEqual([mismatch.report, mismatch.patch], [undefined, undefined]);
  // A crash leaves the socket behind; the next sf serve replaces it.
  await stop(served, 'SIGKILL');
  assert.ok((await stat(join(env.state, 'sf.sock'))).isSocket());

  // A job left "working" by a stopped server, with a session to resume.
  const jobs = new JobStore(env.state);
  const job = (await jobs.read('app', 'M-1'))!;
  await jobs.write({ ...job, state: 'working', session_id: 'kept-session', error: undefined });
  served = await serve(env);
  const restarted = await call(served, 'check', { workspace: 'app', ticket: 'M-1' });
  assert.deepEqual([restarted.state, restarted.error?.code], ['needs_human', 'serve_restarted']);
  assert.equal((await jobs.read('app', 'M-1'))!.session_id, 'kept-session');

  assert.equal((await runCli(env, ['say', 'app', 'M-1', 'please', 'continue'])).code, 0);
  const resumed = await waitFor(served, 'M-1', 'awaiting_review', 1);
  assert.match(resumed.report, /^resumed report\n/);
  const log = await fakeLog(env);
  assert.equal(log[1]!.prompt, factoryPrompt('please continue', 'M-1', 1));
  assert.ok(log[1]!.argv.includes('--resume=kept-session'));
  await stop(served);
});
