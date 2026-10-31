// SF-009 core acceptance proof across the real MCP boundary: the bridge process (official SDK
// handler on loopback) and the private supervisor in its own process, driven by the official MCP
// client standing in for ChatGPT. One authorized call → accepted receipt → safe preflight →
// exactly one auto-mode launch, with no console approval and no per-job commands; then a review
// iteration and the final acceptance, all through MCP tools. Claude is the fake stream-json runner.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { acceptedJob, destroyFixture, git, invocations, jobDir, sha256, type Fixture } from './support/operator-fixture.js';
import { createExecutorFixture, enableApp, messages, waitFor } from './support/executor-fixture.js';

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url));
const SUPERVISOR = fileURLToPath(new URL('./support/supervisor-fixture.js', import.meta.url));
const READY = /listening on (http:\/\/127\.0\.0\.1:(\d+)\/mcp)/;
const children: ChildProcess[] = [];
const cleanup: Array<() => Promise<void>> = [];

after(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const child of children) child.kill('SIGKILL');
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
});

function start(args: string[], env: Record<string, string>, ready: RegExp): Promise<{ child: ChildProcess; match: RegExpExecArray }> {
  const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = ready.exec(output);
      if (match) resolve({ child, match });
    });
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.once('exit', (code) => reject(new Error(`exited with ${code} before ready:\n${output}`)));
  });
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent as Record<string, unknown>;
}

async function errorCode(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await client.callTool({ name, arguments: args });
    if (!result.isError) return 'ok';
    return (JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { code?: string }).code ?? 'error';
  } catch {
    return 'protocol_error';
  }
}

test('one MCP authorization runs one auto-mode session to review and acceptance without terminal mediation', async () => {
  const fx: Fixture = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await enableApp(fx);
  const job = 'job-mcp';
  const accepted = await acceptedJob(fx, job);
  const dataDir = await mkdtemp(join(tmpdir(), 'sf009-mcp-data-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const fixtureFile = join(fx.sandbox, 'fixture.json');
  await writeFile(fixtureFile, JSON.stringify(fx));

  const bridge = await start([MAIN], { FACTORY_PORT: '0', FACTORY_DATA_DIR: dataDir, FACTORY_REPO_ROOT: fx.mediator, FACTORY_OPENCLAW_DISPATCH: 'off' }, READY);
  await start([SUPERVISOR, fixtureFile], {}, /^ready$/m);
  const client = new Client({ name: 'sf009-chatgpt-equivalent', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.match[1]!)));
  cleanup.push(() => client.close());

  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ['factory_execution_status', 'factory_authorize_execution', 'factory_list_review_ready', 'factory_review_snapshot', 'factory_submit_review', 'factory_manage_session_context', 'factory_accept_job']) {
    assert.ok(names.includes(name), `${name} is offered`);
  }

  const before = await call(client, 'factory_execution_status', { app_id: fx.app, job_id: job });
  assert.equal(before.status, 'not_authorized');
  const policy = before.policy as { repo_identity: string; policy_epoch: number; permission_mode: string };
  assert.equal(policy.permission_mode, 'auto');
  assert.equal((before.supervisor as { online: boolean }).online, true);

  // Schema-level refusals at the MCP boundary.
  const base = { app_id: fx.app, job_id: job, request_id: accepted.requestId, instruction_sha256: accepted.sha, repo_identity: policy.repo_identity, permission_mode: 'auto', policy_epoch: policy.policy_epoch };
  assert.notEqual(await errorCode(client, 'factory_authorize_execution', { ...base, permission_mode: 'bypassPermissions', authorization_id: randomUUID() }), 'ok');
  assert.notEqual(await errorCode(client, 'factory_authorize_execution', { ...base, authorization_id: randomUUID(), executable: '/bin/sh' }), 'ok');
  assert.equal((await invocations(fx)).length, 0);

  // The one authorization.
  const authorized = await call(client, 'factory_authorize_execution', { ...base, authorization_id: randomUUID() });
  assert.notEqual(authorized.status, 'running', 'authorized is reported, not started');
  const ready = await waitFor(async () => {
    const status = await call(client, 'factory_execution_status', { app_id: fx.app, job_id: job });
    return status.status === 'awaiting_review' ? status : undefined;
  }, 'awaiting_review over MCP');
  const jobView = ready.job as { current_iteration: string; current_session_id: string };
  assert.equal(jobView.current_iteration, 'iteration-001');

  const calls = await invocations(fx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.argv[calls[0]!.argv.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(!calls[0]!.argv.some((arg) => /bypass|dangerously/i.test(arg)));

  const listed = (await call(client, 'factory_list_review_ready', { app_id: fx.app })).ready as Array<{ iteration_id: string; snapshot_sha256: string }>;
  assert.equal(listed.length, 1);
  const snap = await call(client, 'factory_review_snapshot', { app_id: fx.app, job_id: job, iteration_id: 'iteration-001' });
  assert.equal(snap.snapshot_sha256, listed[0]!.snapshot_sha256);
  const diffRef = snap.diff as { path: string; sha256: string };
  const diff = await call(client, 'factory_read_file', { path: diffRef.path });
  assert.equal(diff.sha256, diffRef.sha256);
  assert.match(diff.text as string, /\+iteration 1/);

  // Review: delivered to the same session without any terminal step.
  await call(client, 'factory_submit_review', {
    app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, review_id: randomUUID(),
    summary: 'One change.', findings: [{ text: 'Add a changelog line. FAKE-EDIT CHANGELOG.md entry' }],
  });
  const second = await waitFor(async () => {
    const status = await call(client, 'factory_execution_status', { app_id: fx.app, job_id: job });
    return status.status === 'awaiting_review' && (status.job as { current_iteration: string }).current_iteration === 'iteration-002' ? status : undefined;
  }, 'iteration-002 over MCP');
  assert.equal((second.job as { current_session_id: string }).current_session_id, jobView.current_session_id);
  const sent = await messages(fx);
  assert.equal(new Set(sent.map((message) => message.pid)).size, 1);
  const snap2 = await call(client, 'factory_review_snapshot', { app_id: fx.app, job_id: job, iteration_id: 'iteration-002' });
  assert.equal(await errorCode(client, 'factory_accept_job', { app_id: fx.app, job_id: job, iteration_id: 'iteration-001', snapshot_sha256: snap.snapshot_sha256, acceptance_id: randomUUID() }), 'conflict');

  // Final acceptance, its own transition.
  await call(client, 'factory_accept_job', { app_id: fx.app, job_id: job, iteration_id: 'iteration-002', snapshot_sha256: snap2.snapshot_sha256, acceptance_id: randomUUID() });
  const closed = await waitFor(async () => {
    const status = await call(client, 'factory_execution_status', { app_id: fx.app, job_id: job });
    return status.status === 'closed' ? status : undefined;
  }, 'closed over MCP');
  assert.equal((closed.job as { execution_state: string }).execution_state, 'completed');
  const report = await call(client, 'factory_read_file', { path: `factory-data/apps/${fx.app}/jobs/${job}/report.md` });
  assert.match(report.text as string, /\| State \| completed \|/);
  assert.equal((await invocations(fx)).length, 1, 'one launch for the whole job');
  assert.equal(git(fx.appRepo, 'diff', '--cached', '--name-only'), '');
  // The private executor state is not readable through the bridge, and the authorization is.
  assert.equal(await errorCode(client, 'factory_read_file', { path: `factory-data/apps/${fx.app}/.env` }), 'forbidden_path');
  const authFile = await call(client, 'factory_read_file', { path: `factory-data/apps/${fx.app}/jobs/${job}/authorization.json` });
  assert.equal(authFile.sha256, sha256(await readFile(join(jobDir(fx, job), 'authorization.json'))));
});
