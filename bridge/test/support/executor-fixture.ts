// Shared fixture for the SF-009 tests: the SF-007 operator fixture (throwaway mediator with
// accepted jobs, disposable app repository, file-based OpenClaw receiver, private state home)
// plus a fake `claude` that speaks the documented stream-json protocol of `claude -p`:
// it reads user messages from stdin, writes a transcript like Claude Code's, and reports
// system/init (with the permission mode it was started in), system/compact_boundary and a
// result per turn on stdout. It records every invocation (argv, pid) and every message it
// received. Its work is driven by markers in the messages (FAKE-EDIT <file> <word>, ...).
// No real Claude Code, Docker or network is used.
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ManagedClaudeRunner } from '../../src/execution/runner.js';
import { SessionGate } from '../../src/execution/session-gate.js';
import { ExecutionService, type ExecutionDeps } from '../../src/execution/service.js';
import { ExecutionGateway } from '../../src/executor/gateway.js';
import { ExecutorState } from '../../src/executor/policy.js';
import { Supervisor, type SupervisorOptions } from '../../src/executor/supervisor.js';
import { FactoryJobs } from '../../src/factory-jobs.js';
import { createFixture, fileReceiver, gatePath, type Fixture } from './operator-fixture.js';

export const FAKE_STREAM_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');
const control = JSON.parse(fs.readFileSync(path.join(__dirname, 'stream-control.json'), 'utf8'));
const argv = process.argv.slice(2);
const sid = argv[argv.indexOf('--session-id') + 1];
const mode = argv[argv.indexOf('--permission-mode') + 1];
fs.appendFileSync(path.join(__dirname, 'invocations.jsonl'), JSON.stringify({
  argv, cwd: process.cwd(), pid: process.pid,
  env: Object.keys(process.env).filter((k) => /^(SF_|FACTORY_|OPENCLAW_|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|MESSAGING_TOKEN))/.test(k)),
  tty: { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY), stderr: Boolean(process.stderr.isTTY) },
}) + '\n');
const dir = path.join(control.projects, process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const line = (entry) => fs.appendFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify({ sessionId: sid, cwd: process.cwd(), ...entry }) + '\n');
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
process.stderr.write('FAKE-STREAM-STDERR ' + sid + '\n');
let first = true;
let tool = 0;
const bash = (command) => {
  const id = 't' + (++tool);
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' }] } });
};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  const msg = JSON.parse(raw);
  const text = msg.message.content.map((part) => part.text).join('');
  fs.appendFileSync(path.join(__dirname, 'messages.jsonl'), JSON.stringify({ pid: process.pid, sid, text }) + '\n');
  // Review 03 (R3-1): for a review message, a result first (its edits done), then the message's
  // acknowledgment, then: silence; or unrelated system output only (control.noise); or progress
  // every 200 ms and, after control.laterResultMs, the message's own result (with its edits).
  if (control.mode === 'answer-before-ack' && !text.startsWith('/implement ')) {
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: sid, result: 'Early.', permission_denials: [] });
    out({ type: 'user', message: msg.message, uuid: msg.uuid, isReplay: true, session_id: sid });
    out({ type: 'system', subtype: 'init', session_id: sid, permissionMode: mode });
    if (control.noise) setInterval(() => out({ type: 'system', subtype: 'hook_response', session_id: sid }), 100);
    if (control.laterResultMs) {
      const progress = setInterval(() => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] }, session_id: sid }), 200);
      setTimeout(() => {
        clearInterval(progress);
        for (const match of text.matchAll(/FAKE-EDIT ([A-Za-z0-9._-]+) ([A-Za-z0-9-]+)/g)) fs.appendFileSync(match[1], match[2] + '\n');
        out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: sid, result: 'Answer.', permission_denials: [] });
      }, Number(control.laterResultMs));
    }
    return;
  }
  // SF-009 ack repair: as Claude Code 2.1.312 and 2.1.314 do in print mode, the replay of a message is held
  // until the first model output of its turn: the first stream event with
  // --include-partial-messages, else the first assistant message (control.firstOutputMs later).
  if (control.mode === 'replay-at-first-output' && !text.startsWith('/implement ')) {
    const partial = argv.includes('--include-partial-messages');
    const replay = () => out({ type: 'user', message: msg.message, uuid: msg.uuid, isReplay: true, session_id: sid });
    out({ type: 'system', subtype: 'init', session_id: sid, permissionMode: mode });
    if (partial) {
      replay();
      out({ type: 'stream_event', event: { type: 'message_start' }, session_id: sid });
    }
    setTimeout(() => {
      if (!partial) replay();
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] }, session_id: sid });
      for (const match of text.matchAll(/FAKE-EDIT ([A-Za-z0-9._-]+) ([A-Za-z0-9-]+)/g)) fs.appendFileSync(match[1], match[2] + '\n');
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: sid, result: 'Answer.', permission_denials: [] });
    }, Number(control.firstOutputMs));
    return;
  }
  // Review 02 (review 97dbc7ac): a result of the turn before this message, emitted after the
  // message was sent but before it is acknowledged (once, for the first non-/implement message).
  if (control.mode === 'old-result-before-ack' && !text.startsWith('/implement ') && !fs.existsSync(path.join(__dirname, 'old-result-sent'))) {
    fs.writeFileSync(path.join(__dirname, 'old-result-sent'), '');
    const old = control.lateDenial ? [{ tool_name: 'Bash', tool_use_id: 'd7', tool_input: { command: 'git push origin main' } }] : [];
    out({ type: 'result', subtype: control.lateError ? 'error_during_execution' : 'success', is_error: Boolean(control.lateError), num_turns: 1, session_id: sid, result: 'Old.', permission_denials: old });
  }
  // --replay-user-messages: the message is acknowledged with its uuid (unless control.noReplay;
  // after the first message: not at all with noReplayAfterFirst, a wrong uuid with badReplayAfterFirst).
  if (argv.includes('--replay-user-messages') && !control.noReplay && !(control.noReplayAfterFirst && !first)) {
    out({ type: 'user', message: msg.message, uuid: control.badReplayAfterFirst && !first ? require('crypto').randomUUID() : msg.uuid, isReplay: true, session_id: sid });
  }
  out({ type: 'system', subtype: 'init', session_id: sid, permissionMode: control.mode === 'auto-unavailable' ? 'default' : mode });
  if (first && text.startsWith('/implement ')) {
    const [command, ...rest] = text.split(' ');
    line({ type: 'user', message: { role: 'user', content: '<command-message>' + command.slice(1) + '</command-message>\n<command-name>' + command + '</command-name>\n<command-args>' + rest.join(' ') + '</command-args>' } });
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: ' + path.join(control.home, '.claude', 'skills', 'implement') + '\n\nImplement...' } });
  } else {
    line({ type: 'user', message: { role: 'user', content: text } });
  }
  first = false;
  const denials = [];
  if (text.startsWith('/implement ')) {
    fs.appendFileSync('README.md', 'iteration 1\n');
    bash('npm test');
    if (control.mode === 'implement-git-commit') denials.push({ tool_name: 'Bash', tool_use_id: 'd0', tool_input: { command: 'git commit -am "secret-free"' } });
    if (control.mode === 'implement-background') spawn(process.execPath, ['-e', "setInterval(() => { try { require('fs').appendFileSync('bg.txt', 'x\\n'); } catch { process.exit(0); } }, 15); setTimeout(() => process.exit(0), 12000)"], { stdio: 'ignore' });
    if (control.mode === 'implement-secret') fs.writeFileSync('.env', 'TOKEN=fixture-only\n');
    if (control.mode === 'implement-outside') fs.appendFileSync(path.join(control.outside, 'README.md'), 'touched\n');
    if (control.mode === 'implement-commit') execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'by claude']);
    // A shell command run as Claude's Bash tool would run it (R1-3 bypass forms); recorded in the transcript.
    if (control.shell) {
      execFileSync('sh', ['-c', control.shell], { stdio: 'ignore' });
      bash(control.shell);
    }
    // Review 02 (R2-1): a child that sleeps longer than the old 1 s settle, then writes and ends.
    if (control.mode === 'implement-sleep-writer') spawn(process.execPath, ['-e', "setTimeout(() => require('fs').appendFileSync('README.md', 'slow write\\n'), 1500)"], { stdio: 'ignore' });
    // A writer that leaves the process tree at once (its shell parent exits; it is re-parented).
    if (control.mode === 'implement-detached-writer') spawn('sh', ['-c', '(sleep 1.5; echo detached write >> README.md) >/dev/null 2>&1 &'], { stdio: 'ignore' });
    // A background descendant that writes once, shortly after this process has ended.
    if (control.mode === 'implement-delayed-writer') spawn(process.execPath, ['-e', "const p = " + process.pid + "; const t = setInterval(() => { try { process.kill(p, 0); } catch { clearInterval(t); setTimeout(() => require('fs').appendFileSync('README.md', 'late write\\n'), 100); } }, 10);"], { stdio: 'ignore', detached: true }).unref();
  }
  for (const match of text.matchAll(/FAKE-EDIT ([A-Za-z0-9._-]+) ([A-Za-z0-9-]+)/g)) {
    fs.appendFileSync(match[1], match[2] + '\n');
    bash('cat ' + match[1]);
  }
  if (text.includes('FAKE-GIT-COMMIT')) denials.push({ tool_name: 'Bash', tool_use_id: 'd1', tool_input: { command: 'git commit -am x' } });
  if (text.includes('FAKE-CRASH')) process.kill(process.pid, 'SIGKILL');
  if (text.startsWith('/compact')) out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } });
  const reply = text.startsWith('Software Factory context reset') ? 'Scope confirmed: the task in the instruction; no Git operations.' : 'Done with this round.';
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: sid, result: reply, permission_denials: denials });
  // Review 02: Claude answers once more on its own long after its turn ended (after publication),
  // with or without a write (control.lateWrite).
  if (control.mode === 'implement-late-result' && text.startsWith('/implement ')) {
    setTimeout(() => {
      if (control.lateWrite) fs.appendFileSync('README.md', 'late turn write\n');
      const late = control.lateDenial ? [{ tool_name: 'Bash', tool_use_id: 'd9', tool_input: { command: 'git push origin main' } }] : [];
      out({ type: 'result', subtype: control.lateError ? 'error_during_execution' : 'success', is_error: Boolean(control.lateError), num_turns: 1, session_id: sid, result: 'One more thing.', permission_denials: late });
    }, 2500);
  }
  // Review 02 (review 9a4e25e0): a late result (with lateDenial: one refused action) emitted once
  // when the test creates the file late-signal next to this script, e.g. while a request is handled.
  if (control.mode === 'late-on-signal' && text.startsWith('/implement ')) {
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(__dirname, 'late-signal'))) return;
      clearInterval(timer);
      if (control.lateWrite) fs.appendFileSync('README.md', 'late turn write\n');
      const late = control.lateDenial ? [{ tool_name: 'Bash', tool_use_id: 'd8', tool_input: { command: 'git push origin main' } }] : [];
      out({ type: 'result', subtype: control.lateError ? 'error_during_execution' : 'success', is_error: Boolean(control.lateError), num_turns: 1, session_id: sid, result: 'Late.', permission_denials: late });
    }, 20);
  }
  // Review 02 (review 1ff34ac1): one non-result output line (a tool-progress style event), emitted
  // once when the test creates the file progress-signal next to this script.
  // Keeps writing output lines (every 50 ms) once the file progress-signal exists: never quiet.
  if (control.mode === 'chatty-on-signal' && text.startsWith('/implement ')) {
    setInterval(() => {
      if (fs.existsSync(path.join(__dirname, 'progress-signal'))) out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'still' }] }, session_id: sid });
    }, 50);
  }
  if (control.mode === 'progress-on-signal' && text.startsWith('/implement ')) {
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(__dirname, 'progress-signal'))) return;
      clearInterval(timer);
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'still working' }] }, session_id: sid });
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: sid, permission_denials: [] });
    }, 20);
  }
  // Review 03 (R3-2): once the file writer-signal exists, a silent writer that leaves the process
  // tree at once (its shell parent exits) and keeps the session tag: it sleeps control.writerSleep
  // seconds, then (with control.writerWrites) appends to README.md, and marks writer-done here.
  if (control.mode === 'tagged-writer-on-signal' && text.startsWith('/implement ')) {
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(__dirname, 'writer-signal'))) return;
      clearInterval(timer);
      const write = control.writerWrites ? 'echo handoff write >> README.md; ' : '';
      spawn('sh', ['-c', '(sleep ' + (control.writerSleep || '1.5') + '; ' + write + 'touch "$1") >/dev/null 2>&1 &', 'sh', path.join(__dirname, 'writer-done')], { stdio: 'ignore' });
    }, 20);
  }
  // Review 02 (R2-1): a subagent-style background task of this process: it reports progress after
  // the turn ended, writes, and Claude answers once more (a second result) when it has finished.
  if (control.mode === 'implement-late-turn' && text.startsWith('/implement ')) {
    out({ type: 'system', subtype: 'task_started', task_id: 'task-1', session_id: sid });
    setTimeout(() => out({ type: 'system', subtype: 'task_progress', task_id: 'task-1', session_id: sid }), 300);
    setTimeout(() => {
      fs.appendFileSync('late.txt', 'background task result\n');
      out({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', session_id: sid });
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The background task finished.' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: sid, result: 'The background task finished.', permission_denials: [] });
    }, 1500);
  }
});
// What the process does when its input closes (the supervisor ending the session), before it exits.
rl.on('close', () => {
  if (control.onClose === 'linger') {
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  if (control.onClose === 'write' || control.onClose === 'write-crash') fs.appendFileSync('README.md', 'after acceptance\n');
  if (control.onClose === 'stage') execFileSync('git', ['add', 'README.md']);
  if (control.onClose === 'commit') execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'after acceptance']);
  if (control.onClose === 'write-crash' || control.onClose === 'crash') process.kill(process.pid, 'SIGKILL');
  process.exit(0);
});
`;

export const streamClaude = (fx: Fixture): string => join(fx.fakeDir, 'claude-stream');

export async function setStreamMode(fx: Fixture, mode: string, extra: Record<string, string> = {}): Promise<void> {
  await writeFile(join(fx.fakeDir, 'stream-control.json'), JSON.stringify({ mode, projects: fx.projects, home: fx.sandbox, ...extra }));
}

export async function createExecutorFixture(app = 'app-one'): Promise<Fixture> {
  const fx = await createFixture(app);
  // As the runbook registers apps (mkdir -m 700); the supervisor refuses group-writable app directories.
  await chmod(join(fx.mediator, 'factory-data', 'apps', app), 0o700);
  await writeFile(streamClaude(fx), FAKE_STREAM_CLAUDE, { mode: 0o755 });
  await setStreamMode(fx, 'ok');
  return fx;
}

// The SF-006 service with the managed runner, the fixture's gate and receiver.
export function managedService(fx: Fixture, extra: Partial<ExecutionDeps> = {}): ExecutionService {
  return new ExecutionService({
    mediatorRoot: fx.mediator,
    receiverLookup: (requestId) => fileReceiver(fx.receiverDir, requestId),
    runner: new ManagedClaudeRunner(streamClaude(fx), 'fake 0.0.0', new SessionGate(gatePath(fx))),
    claudeProjectsDir: fx.projects,
    claudeConfigDir: fx.claudeConfigDir,
    authStatus: async () => ({ loggedIn: true, method: 'fake' }),
    insideClaudeSession: false,
    managedStopMs: 3000,
    ...extra,
  });
}

export async function enableApp(fx: Fixture, app = fx.app, protectedPaths: string[] = []): Promise<void> {
  const state = await ExecutorState.open(fx.stateHome, fx.mediator);
  await state.enable(app, { executable: streamClaude(fx), version: 'fake 0.0.0' }, protectedPaths, new Date(), 'disposable_pilot');
}

export const gateway = (fx: Fixture, now?: () => Date): ExecutionGateway => new ExecutionGateway(new FactoryJobs(fx.mediator), fx.mediator, now);

export const FAST: Partial<SupervisorOptions> = { pollMs: 20, retryMs: 40, quietMs: 150, quiesceTimeoutMs: 10_000, ackTimeoutMs: 3000, heartbeatMs: 200 };

export async function startSupervisor(fx: Fixture, options: Partial<SupervisorOptions> = {}): Promise<{ supervisor: Supervisor; done: Promise<void>; stop: () => Promise<void> }> {
  const supervisor = await Supervisor.start({ mediatorRoot: fx.mediator, stateHome: fx.stateHome, service: managedService(fx), ...FAST, ...options });
  const done = supervisor.run();
  return {
    supervisor,
    done,
    stop: async () => {
      await supervisor.stop();
      await done;
      await supervisor.close();
    },
  };
}

export async function waitFor<T>(probe: () => Promise<T | undefined | false>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value as T;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// waitFor on the job status; a timeout names the status, iteration and diagnostic last seen.
export async function waitForStatus(fx: Fixture, job: string, wanted: (value: Awaited<ReturnType<ExecutionGateway['status']>>) => boolean, what: string, timeoutMs?: number): Promise<Awaited<ReturnType<ExecutionGateway['status']>>> {
  let last = '';
  try {
    return await waitFor(async () => {
      const value = await gateway(fx).status(fx.app, job);
      last = `${value.status} ${value.job?.current_iteration ?? '-'} ${value.job?.diagnostic?.code ?? '-'} ${value.job?.diagnostic?.message ?? ''}`;
      return wanted(value) ? value : undefined;
    }, what, timeoutMs);
  } catch (error) {
    throw new Error(`${(error as Error).message}; last seen: ${last}`);
  }
}

export async function messages(fx: Fixture): Promise<Array<{ pid: number; sid: string; text: string }>> {
  try {
    return (await readFile(join(fx.fakeDir, 'messages.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { pid: number; sid: string; text: string });
  } catch {
    return [];
  }
}

export interface Authorized {
  authorization_id: string;
  repo_identity: string;
  policy_epoch: number;
}

// The ChatGPT-equivalent steps: read the status for the policy view, then authorize once.
export async function authorize(fx: Fixture, job: string, accepted: { requestId: string; sha: string }, authorizationId: string, app = fx.app): Promise<Authorized> {
  const gw = gateway(fx);
  const status = await gw.status(app, job);
  if (status.policy === null || status.policy.repo_identity === null) throw new Error('no policy view');
  const input = {
    app_id: app,
    job_id: job,
    request_id: accepted.requestId,
    instruction_sha256: accepted.sha,
    repo_identity: status.policy.repo_identity,
    permission_mode: 'auto' as const,
    policy_epoch: status.policy.policy_epoch,
    authorization_id: authorizationId,
  };
  await gw.authorize(input);
  return { authorization_id: authorizationId, repo_identity: input.repo_identity, policy_epoch: input.policy_epoch };
}
