// SF-007 demo fixture: a throwaway mediator with two accepted jobs, a throwaway
// application Git repository, a stub OpenClaw receiver kept as files, and a
// fake `claude` that behaves like an interactive session on the terminal: it
// shows whether its stdio is a TTY, asks a permission-style question and reads
// the operator's answer from the keyboard, writes a session transcript in
// Claude Code's format and edits the README. No real job, app, OpenClaw or
// Claude Code is touched.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReceiverRecord } from '../openclaw-channel.js';
import { ProcessClaudeRunner } from '../execution/runner.js';
import { ExecutionService } from '../execution/service.js';
import { SessionGate } from '../execution/session-gate.js';

export const DEMO_APP = 'demo-app';

const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
// Demo stand-in for Claude Code (SF-007 demo only).
const fs = require('fs');
const path = require('path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-claude.json'), 'utf8'));
const argv = process.argv.slice(2);
const sid = argv[argv.indexOf('--session-id') + 1];
const prompt = argv[argv.length - 1];
const [command, ...rest] = prompt.split(' ');
fs.appendFileSync(path.join(__dirname, 'invocations.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), tty: { stdin: !!process.stdin.isTTY, stdout: !!process.stdout.isTTY, stderr: !!process.stderr.isTTY } }) + '\n');
console.log('[demo claude] fake Claude Code session ' + sid);
console.log('[demo claude] arguments: ' + argv.join(' '));
console.log('[demo claude] stdin TTY: ' + !!process.stdin.isTTY + ', stdout TTY: ' + !!process.stdout.isTTY + ', stderr TTY: ' + !!process.stderr.isTTY);
process.stdout.write('[demo claude] Permission request: allow editing README.md? [y/n] ');
let answer = '';
const buffer = Buffer.alloc(1);
while (true) {
  let read = 0;
  try { read = fs.readSync(0, buffer, 0, 1, null); } catch (error) { if (error.code === 'EAGAIN') continue; throw error; }
  if (read === 0 || buffer[0] === 10 || buffer[0] === 13) break;
  answer += buffer.toString('utf8');
}
console.log('');
const dir = path.join(config.projects, process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const line = (entry) => fs.appendFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify({ sessionId: sid, cwd: process.cwd(), ...entry }) + '\n');
line({ type: 'user', message: { role: 'user', content: '<command-message>' + command.slice(1) + '</command-message>\n<command-name>' + command + '</command-name>\n<command-args>' + rest.join(' ') + '</command-args>' } });
line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: ' + path.join(config.claudeConfigDir, 'skills', command.slice(1)) + '\n\nImplement...' } });
if (/^y/i.test(answer.trim())) {
  fs.appendFileSync(path.join(process.cwd(), 'README.md'), 'Edited by the SF-007 demo session.\n');
  console.log('[demo claude] permission granted: README.md edited.');
} else {
  console.error('[demo claude] permission denied: nothing edited.');
}
line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
console.log('[demo claude] session ends.');
process.exit(0);
`;

export interface DemoFixture {
  dir: string;
  mediator: string;
  appRepo: string;
  fakeDir: string;
  claudeConfigDir: string;
  projects: string;
  receiverDir: string;
  stateHome: string;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.invalid', ...args], { cwd, encoding: 'utf8' });

export async function createDemo(): Promise<DemoFixture> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sf007-demo-')));
  const demo: DemoFixture = {
    dir,
    mediator: join(dir, 'mediator'),
    appRepo: join(dir, 'app-repo'),
    fakeDir: join(dir, 'fake'),
    claudeConfigDir: join(dir, 'claude'),
    projects: join(dir, 'claude', 'projects'),
    receiverDir: join(dir, 'receiver'),
    stateHome: join(dir, 'state'),
  };
  await mkdir(join(demo.mediator, 'factory-data', 'apps', DEMO_APP), { recursive: true });
  git(dir, 'init', '-q', 'mediator');
  await mkdir(demo.appRepo);
  git(demo.appRepo, 'init', '-q');
  await writeFile(join(demo.appRepo, 'README.md'), '# Demo app\n');
  git(demo.appRepo, 'add', 'README.md');
  git(demo.appRepo, 'commit', '-q', '-m', 'init');
  await writeFile(join(demo.mediator, 'factory-data', 'apps', DEMO_APP, '.env'), `APP_REPO=${demo.appRepo}\n`, { mode: 0o600 });
  await mkdir(demo.fakeDir);
  await writeFile(join(demo.fakeDir, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  await writeFile(join(demo.fakeDir, 'demo-claude.json'), JSON.stringify({ projects: demo.projects, claudeConfigDir: demo.claudeConfigDir }));
  await mkdir(join(demo.claudeConfigDir, 'skills', 'implement'), { recursive: true });
  await writeFile(join(demo.claudeConfigDir, 'skills', 'implement', 'SKILL.md'), '---\nname: implement\n---\nSF-007 demo skill\n');
  await mkdir(demo.receiverDir);
  await mkdir(demo.stateHome, { mode: 0o700 });
  await writeFile(join(dir, 'demo.json'), JSON.stringify(demo));
  for (const [job, text] of [
    ['demo-job-1', '# Demo task 1\n\nAdd one line to README.md.\n\n<b>This tag is shown as text, not HTML.</b>\n'],
    ['demo-job-2', '# Demo task 2\n\nReject or defer this one to see that nothing runs.\n'],
  ] as const) {
    await acceptDemoJob(demo, job, text);
  }
  return demo;
}

// An accepted SF-005 job as the bridge leaves it, plus the stub receiver's own record.
async function acceptDemoJob(demo: DemoFixture, job: string, content: string): Promise<void> {
  const dir = join(demo.mediator, 'factory-data', 'apps', DEMO_APP, 'jobs', job);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'instruction.md'), content, { mode: 0o600 });
  const sha = createHash('sha256').update(content, 'utf8').digest('hex');
  const requestId = randomUUID();
  const run = { automation_id: 'demo-automation', run_id: `manual:demo:${requestId}`, status: 'ok', completion_status: 'succeeded' };
  const at = new Date().toISOString();
  const ack = { sf_dispatch: 'accepted', request_id: requestId, app_id: DEMO_APP, job_id: job, instruction_sha256: sha, accepted_at: at };
  await writeFile(join(dir, 'dispatch.json'), JSON.stringify({
    schema: 'software-factory.dispatch/v1', request_id: requestId, app_id: DEMO_APP, job_id: job, instruction_sha256: sha,
    state: 'accepted', revision: 3, attempts: 1, created_at: at, updated_at: at, last_error: null,
    receipt: 'openclaw-receipt.json', openclaw: run,
    history: [{ attempt: 1, outcome: 'accepted', finished_at: at, openclaw: run, error: null }],
  }));
  await writeFile(join(dir, 'openclaw-receipt.json'), JSON.stringify({
    schema: 'software-factory.openclaw-receipt/v1', request_id: requestId, app_id: DEMO_APP, job_id: job, instruction_sha256: sha,
    attempt: 1, outcome: 'accepted', recorded_at: at, openclaw: { ...run, output: JSON.stringify(ack) }, acknowledgement: ack,
  }));
  const receiver: ReceiverRecord = { request_id: requestId, app_id: DEMO_APP, job_id: job, instruction_sha256: sha, accepted_at: at };
  await writeFile(join(demo.receiverDir, `${requestId}.json`), JSON.stringify(receiver));
}

export async function loadDemo(path: string): Promise<DemoFixture> {
  return JSON.parse(await readFile(path, 'utf8')) as DemoFixture;
}

// The SF-006 service wired to the demo; stdio 'inherit' attaches the fake to the terminal.
export function demoService(demo: DemoFixture): ExecutionService {
  return new ExecutionService({
    mediatorRoot: demo.mediator,
    receiverLookup: async (requestId) => {
      if (!/^[0-9a-f-]{36}$/.test(requestId)) return undefined;
      try {
        return JSON.parse(await readFile(join(demo.receiverDir, `${requestId}.json`), 'utf8')) as ReceiverRecord;
      } catch {
        return undefined;
      }
    },
    // The demo's own gate: the demo never blocks or is blocked by real sessions.
    runner: new ProcessClaudeRunner(join(demo.fakeDir, 'claude'), 'demo-fake 0.0.0', 'inherit', new SessionGate(join(demo.dir, 'session-gate', 'claude-session.lock'))),
    claudeProjectsDir: demo.projects,
    claudeConfigDir: demo.claudeConfigDir,
    authStatus: async () => ({ loggedIn: true, method: 'demo' }),
    insideClaudeSession: false,
  });
}
