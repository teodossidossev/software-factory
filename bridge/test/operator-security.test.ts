// SF-007 Review 01, Finding 1: browser-origin authenticity. The withdrawn web
// page at http://127.0.0.1:8791/ could be impersonated by another local account
// that squatted the port: its script would run in the same origin, read a stored
// token, and later send requests through the operator's browser. The console
// that replaced it has no listener, origin, token or other request channel.
// These tests replay that attack against it, check that the console process
// holds no listening socket, that the operator code has no network server, and
// that job text cannot inject terminal control sequences.
import assert from 'node:assert/strict';
import { readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { printable } from '../src/operator/text.js';
import { inspectJob } from '../src/operator/queue.js';
import { OperatorStore } from '../src/operator/store.js';
import { acceptedJob, createFixture, destroyFixture, fixtureService, invocations, type Fixture } from './support/operator-fixture.js';
import { runInPty } from './support/pty.js';

const CONSOLE = fileURLToPath(new URL('./support/console-fixture.js', import.meta.url));
const OPERATOR_SRC = fileURLToPath(new URL('../../src/operator/', import.meta.url));
const OLD_PORT = 8791;
let fx: Fixture;
let fixtureJson: string;

before(async () => {
  fx = await createFixture();
  fixtureJson = join(fx.sandbox, 'fixture.json');
  await writeFile(fixtureJson, JSON.stringify(fx));
});

after(async () => {
  await destroyFixture(fx);
});

// What a malicious same-origin page would send through the operator's browser with a captured token.
function browserRequest(path: string, token: string): Promise<{ status: number; body: string } | { error: string }> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: OLD_PORT,
        method: 'POST',
        path,
        headers: { Host: `127.0.0.1:${OLD_PORT}`, Origin: `http://127.0.0.1:${OLD_PORT}`, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Authorization: `Bearer ${token}` },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? 'error' }));
    req.end(JSON.stringify({ request_id: 'x', instruction_sha256: '0'.repeat(64) }));
  });
}

// Inodes of every listening TCP/UDP/UNIX socket on this host.
async function listeningInodes(): Promise<Set<string>> {
  const inodes = new Set<string>();
  for (const table of ['tcp', 'tcp6', 'udp', 'udp6']) {
    const text = await readFile(`/proc/net/${table}`, 'utf8').catch(() => '');
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      // TCP LISTEN is 0A; any bound UDP socket can receive.
      if (fields.length > 9 && (table.startsWith('udp') || fields[3] === '0A')) inodes.add(fields[9]!);
    }
  }
  const unix = await readFile('/proc/net/unix', 'utf8').catch(() => '');
  for (const line of unix.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    // Flags 00010000 = __SO_ACCEPTCON: a listening UNIX socket.
    if (fields.length > 6 && (parseInt(fields[3]!, 16) & 0x10000) !== 0) inodes.add(fields[6]!);
  }
  return inodes;
}

async function socketInodes(pid: number): Promise<string[]> {
  const inodes: string[] = [];
  for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])) {
    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match) inodes.push(match[1]!);
  }
  return inodes;
}

test('port squat: a hostile same-port listener and a captured browser token cannot approve or start anything', async () => {
  const { requestId } = await acceptedJob(fx, 'job-target');
  // 1. The operator component is down; another account squats the old page port and serves its own script.
  const seen: string[] = [];
  const hostile: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<script>fetch("/api/jobs/app-one/job-target/approve",{method:"POST",headers:{Authorization:"Bearer "+localStorage.getItem("sf007-operator-token")}})</script>');
  });
  await new Promise<void>((resolve, reject) => {
    hostile.once('error', reject);
    hostile.listen(OLD_PORT, '127.0.0.1', () => resolve());
  });
  // 2. The browser (with whatever it kept for that origin) talks to the attacker: nothing reaches the operator side.
  const captured = 'A'.repeat(43);
  const toAttacker = await browserRequest(`/api/jobs/${fx.app}/job-target/approve`, captured);
  assert.ok('status' in toAttacker && toAttacker.status === 200);
  assert.equal(seen.length, 1);
  await new Promise<void>((resolve) => hostile.close(() => resolve()));

  // 3. The operator component "returns": the console runs, and the browser replays the request.
  const run = runInPty(fx.sandbox, [process.execPath, CONSOLE, fixtureJson], [['to review, r to refresh, q to quit:', 'r\r'], ['to review, r to refresh, q to quit:', 'q\r']], { timeout: 30 });
  const pid = await run.pid();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const replay = await browserRequest(`/api/jobs/${fx.app}/job-target/approve`, captured);
  assert.deepEqual(replay, { error: 'ECONNREFUSED' });
  // The console process holds no listening socket of any kind.
  const listening = await listeningInodes();
  const own = await socketInodes(pid);
  assert.deepEqual(own.filter((inode) => listening.has(inode)), [], 'the console listens on a socket');
  const { output } = await run.done;
  assert.match(output, /No network listener: decisions are taken only here, from this keyboard/);

  // 4. Nothing was approved, prepared or started for the job.
  const entry = await inspectJob({ mediatorRoot: fx.mediator, store: await OperatorStore.open(fx.stateHome, fx.mediator), service: fixtureService(fx), now: () => new Date() }, fx.app, 'job-target');
  assert.deepEqual([entry?.status, entry?.request_id, entry?.approval], ['awaiting_operator', requestId, null]);
  assert.equal((await invocations(fx)).length, 0);
  const stateFiles = await readdir(join(fx.stateDir, 'jobs')).catch(() => [] as string[]);
  assert.deepEqual(stateFiles, []);
});

test('the operator code contains no network server or listener; its state is private to the operator', async () => {
  for (const name of await readdir(OPERATOR_SRC)) {
    const text = await readFile(join(OPERATOR_SRC, name), 'utf8');
    // Ignore comments, which explain why the web page was withdrawn.
    const code = text.replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /node:(http|https|http2|net|dgram|tls)'|createServer|\.listen\(|WebSocket/, name);
  }
  await OperatorStore.open(fx.stateHome, fx.mediator);
  assert.equal((await stat(fx.stateDir)).mode & 0o777, 0o700);
});

test('instruction text cannot inject terminal control sequences into the console', async () => {
  const hostile = '# Task\n\x1b]0;PWNED-TITLE\x07\x1b[2J\x1b[1;1HFAKE-PROMPT\rover‮evil⁦x\u009b31m\n';
  await acceptedJob(fx, 'job-escape', hostile);
  const { output } = await runInPty(
    fx.sandbox,
    [process.execPath, CONSOLE, fixtureJson],
    [
      ['to review, r to refresh, q to quit:', `${fx.app}/job-escape\r`],
      ['anything else = back', '\r'],
      ['to review, r to refresh, q to quit:', 'q\r'],
    ],
    { timeout: 30 },
  ).done;
  assert.ok(!output.includes('\x1b]0;PWNED'), 'raw OSC title sequence reached the terminal');
  assert.ok(!output.includes('\x1b[2J'), 'raw clear-screen reached the terminal');
  assert.ok(!output.includes('‮') && !output.includes('⁦') && !output.includes('\u009b'), 'raw bidi or C1 control reached the terminal');
  assert.match(output, /\\x1b\]0;PWNED-TITLE\\x07\\x1b\[2J\\x1b\[1;1HFAKE-PROMPT\\x0dover\\u202eevil\\u2066x\\x9b31m/);
  assert.equal(printable('ok\ttab\nline'), 'ok\ttab\nline');
});
