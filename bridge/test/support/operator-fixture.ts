// Shared fixture for the SF-007 operator tests: a throwaway mediator with
// accepted SF-005 jobs, a disposable application Git repository, a stub
// OpenClaw receiver kept as files (so separate processes see the same records)
// and a fake `claude` that records its argv, cwd, environment and whether its
// stdio is a terminal. No real Claude Code, Docker or network is used.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessClaudeRunner } from '../../src/execution/runner.js';
import { SessionGate } from '../../src/execution/session-gate.js';
import { ExecutionService } from '../../src/execution/service.js';
import type { ReceiverRecord } from '../../src/openclaw-channel.js';

export const INSTRUCTION = '# Task\n\nAdd a "done" line to the README. <script>alert(1)</script>\n';

// Behaviour comes from control.json next to the script.
export const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const control = JSON.parse(fs.readFileSync(path.join(__dirname, 'control.json'), 'utf8'));
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'invocations.jsonl'), JSON.stringify({
  argv, cwd: process.cwd(), pid: process.pid,
  env: Object.keys(process.env).filter((k) => /^(SF_|FACTORY_|OPENCLAW_|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|MESSAGING_TOKEN))/.test(k)),
  tty: { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY), stderr: Boolean(process.stderr.isTTY) },
}) + '\n');
const sid = argv[argv.indexOf('--session-id') + 1];
const prompt = argv[argv.length - 1];
const [command, ...rest] = prompt.split(' ');
const dir = path.join(control.projects, process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const line = (entry) => { if (control.mode !== 'no-transcript') fs.appendFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify({ sessionId: sid, cwd: process.cwd(), ...entry }) + '\n'); };
if (control.mode !== 'no-skill') {
  line({ type: 'user', message: { role: 'user', content: '<command-message>' + command.slice(1) + '</command-message>\n<command-name>' + command + '</command-name>\n<command-args>' + rest.join(' ') + '</command-args>' } });
  line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: ' + path.join(control.home, '.claude', 'skills', command.slice(1)) + '\n\nImplement...' } });
} else {
  line({ type: 'user', message: { role: 'user', content: 'please implement the instruction' } });
}
line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } });
line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] } });
fs.appendFileSync(path.join(process.cwd(), 'README.md'), 'done\n');
if (control.mode === 'secret-file') fs.writeFileSync(path.join(process.cwd(), '.env'), 'TOKEN=fixture-only\n');
if (control.mode === 'commit') execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'by claude']);
if (control.mode === 'stage') execFileSync('git', ['add', 'README.md']);
process.stdout.write('FAKE-CLAUDE-STDOUT-MARKER permission prompt shown here\n');
process.stderr.write('FAKE-CLAUDE-STDERR-MARKER\n');
line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
if (control.mode === 'hang') { setInterval(() => {}, 1000); return; }
if (control.mode === 'crash') process.kill(process.pid, 'SIGKILL');
if (control.mode === 'term') process.kill(process.pid, 'SIGTERM');
process.exit(control.mode === 'exit1' ? 1 : 0);
`;

export interface Fixture {
  sandbox: string;
  mediator: string;
  app: string;
  appRepo: string;
  fakeDir: string;
  projects: string;
  claudeConfigDir: string;
  receiverDir: string;
  stateHome: string;
  stateDir: string;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

// A registered app with a clean repository, a fake claude and an empty private state home.
export async function createFixture(app = 'app-one'): Promise<Fixture> {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'sf-operator-')));
  const fx: Fixture = {
    sandbox,
    mediator: join(sandbox, 'mediator'),
    app,
    appRepo: join(sandbox, 'app-repo'),
    fakeDir: join(sandbox, 'fake'),
    projects: join(sandbox, 'projects'),
    claudeConfigDir: join(sandbox, '.claude'),
    receiverDir: join(sandbox, 'receiver'),
    stateHome: join(sandbox, 'state'),
    stateDir: join(sandbox, 'state', 'software-factory', 'operator'),
  };
  await mkdir(join(fx.mediator, 'factory-data', 'apps', app), { recursive: true });
  git(sandbox, 'init', '-q', 'mediator');
  await mkdir(fx.appRepo);
  git(fx.appRepo, 'init', '-q');
  await writeFile(join(fx.appRepo, 'README.md'), '# App\n');
  git(fx.appRepo, 'add', 'README.md');
  git(fx.appRepo, 'commit', '-q', '-m', 'init');
  await writeFile(join(fx.mediator, 'factory-data', 'apps', app, '.env'), `APP_REPO=${fx.appRepo}\n`, { mode: 0o600 });
  await mkdir(fx.fakeDir);
  await writeFile(join(fx.fakeDir, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  await mkdir(join(fx.claudeConfigDir, 'skills', 'implement'), { recursive: true });
  await writeFile(join(fx.claudeConfigDir, 'skills', 'implement', 'SKILL.md'), '---\nname: implement\n---\nfixture\n');
  await mkdir(fx.receiverDir);
  await mkdir(fx.stateHome);
  await setMode(fx, 'ok');
  return fx;
}

export async function destroyFixture(fx: Fixture): Promise<void> {
  await rm(fx.sandbox, { recursive: true, force: true });
}

// The fixture's own session gate file: shared by every process of one fixture, never the operator's.
export const gatePath = (fx: Fixture): string => join(fx.sandbox, 'gate', 'claude-session.lock');

export const jobDir = (fx: Fixture, job: string, app = fx.app): string => join(fx.mediator, 'factory-data', 'apps', app, 'jobs', job);

export async function setMode(fx: Fixture, mode: string): Promise<void> {
  await writeFile(join(fx.fakeDir, 'control.json'), JSON.stringify({ mode, projects: fx.projects, home: fx.sandbox }));
}

export interface Invocation {
  argv: string[];
  cwd: string;
  pid: number;
  env: string[];
  tty: { stdin: boolean; stdout: boolean; stderr: boolean };
}

export async function invocations(fx: Fixture): Promise<Invocation[]> {
  try {
    return (await readFile(join(fx.fakeDir, 'invocations.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Invocation);
  } catch {
    return [];
  }
}

// An accepted SF-005 job as the bridge leaves it, plus the receiver's own record.
export async function acceptedJob(fx: Fixture, job: string, content = INSTRUCTION, app = fx.app): Promise<{ requestId: string; sha: string }> {
  const dir = jobDir(fx, job, app);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'instruction.md'), content, { mode: 0o600 });
  const sha = sha256(Buffer.from(content, 'utf8'));
  const requestId = randomUUID();
  const run = { automation_id: 'f431a516-c14c-4f88-b7a8-4745b8bd3b48', run_id: `manual:f431a516:${requestId}`, status: 'ok', completion_status: 'succeeded' };
  const now = new Date().toISOString();
  const ack = { sf_dispatch: 'accepted', request_id: requestId, app_id: app, job_id: job, instruction_sha256: sha, accepted_at: now };
  await writeFile(join(dir, 'dispatch.json'), JSON.stringify({
    schema: 'software-factory.dispatch/v1', request_id: requestId, app_id: app, job_id: job, instruction_sha256: sha,
    state: 'accepted', revision: 3, attempts: 1, created_at: now, updated_at: now, last_error: null,
    receipt: 'openclaw-receipt.json', openclaw: run,
    history: [{ attempt: 1, outcome: 'accepted', finished_at: now, openclaw: run, error: null }],
  }));
  await writeFile(join(dir, 'openclaw-receipt.json'), JSON.stringify({
    schema: 'software-factory.openclaw-receipt/v1', request_id: requestId, app_id: app, job_id: job, instruction_sha256: sha,
    attempt: 1, outcome: 'accepted', recorded_at: now, openclaw: { ...run, output: JSON.stringify(ack) }, acknowledgement: ack,
  }));
  await writeReceiver(fx, { request_id: requestId, app_id: app, job_id: job, instruction_sha256: sha, accepted_at: now });
  return { requestId, sha };
}

export async function writeReceiver(fx: Fixture, record: ReceiverRecord): Promise<void> {
  await writeFile(join(fx.receiverDir, `${record.request_id}.json`), JSON.stringify(record));
}

export async function fileReceiver(dir: string, requestId: string): Promise<ReceiverRecord | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, `${requestId}.json`), 'utf8')) as ReceiverRecord;
  } catch {
    return undefined;
  }
}

// The SF-006 service wired to the fixture. stdio 'inherit' attaches the fake to the caller's terminal.
export function fixtureService(fx: Fixture, stdio: 'inherit' | 'ignore' = 'ignore'): ExecutionService {
  return new ExecutionService({
    mediatorRoot: fx.mediator,
    receiverLookup: (requestId) => fileReceiver(fx.receiverDir, requestId),
    runner: new ProcessClaudeRunner(join(fx.fakeDir, 'claude'), 'fake 0.0.0', stdio, new SessionGate(gatePath(fx))),
    claudeProjectsDir: fx.projects,
    claudeConfigDir: fx.claudeConfigDir,
    authStatus: async () => ({ loggedIn: true, method: 'fake' }),
    insideClaudeSession: false,
  });
}
