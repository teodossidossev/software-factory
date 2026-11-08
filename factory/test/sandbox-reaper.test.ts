// The sandbox reaper (SF-141): which processes it chooses, on a fake /proc of the test's own (no real
// process is signalled there), and one real orphan, a bwrap-named shell with a sleeping child left
// behind by a parent that exited, which it ends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findOrphanedSandboxes, reapOrphanedSandboxes } from '../src/sandbox-reaper.js';

const UID = 1000;
const OTHER_UID = 1001;
const ROOT = '/home/u/.local/state/software-factory';
const WORKTREE = `${ROOT}/worktrees/app/APP-1`;

interface FakeProcess {
  pid: number;
  name: string;
  ppid: number;
  uid?: number;
  args?: string[];
}

// A fake /proc with the given processes: status (Name, PPid, Uid), stat and cmdline of each.
async function fakeProc(processes: FakeProcess[]): Promise<string> {
  const proc = await mkdtemp(join(tmpdir(), 'sf-reaper-proc-'));
  for (const info of processes) {
    const dir = join(proc, String(info.pid));
    const uid = info.uid ?? UID;
    await mkdir(dir);
    await writeFile(join(dir, 'status'), `Name:\t${info.name}\nState:\tS (sleeping)\nPid:\t${info.pid}\nPPid:\t${info.ppid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    // The command name with a space and a parenthesis, as a real one may have; field 22 is the start time.
    await writeFile(join(dir, 'stat'), `${info.pid} (${info.name} x)) S ${info.ppid} ${'0 '.repeat(17)}${1000 + info.pid} 0 0\n`);
    await writeFile(join(dir, 'cmdline'), `${(info.args ?? [info.name]).join('\0')}\0`);
  }
  return proc;
}

// A sandbox as Claude Code starts it, naming the worktree.
const sandboxArgs = (path = WORKTREE): string[] => ['bwrap', '--new-session', '--die-with-parent', '--bind', path, path, '--', 'bash', '-c', 'true'];

// The user manager, pid 1 and a live claude, the parents of the cases below. The fake pids are above
// any real pid_max, so none is the test's own process, which the reaper spares with its ancestors.
const BASE: FakeProcess[] = [
  { pid: 1, name: 'systemd', ppid: 0, uid: 0, args: ['/sbin/init'] },
  { pid: 5000900, name: 'systemd', ppid: 1, args: ['/usr/lib/systemd/systemd', '--user'] },
  { pid: 5000950, name: 'claude', ppid: 5000900, args: ['claude'] },
];

test('findOrphanedSandboxes: an orphaned bwrap naming a worktree path is chosen with its descendants, under the user manager or pid 1', async () => {
  const proc = await fakeProc([
    ...BASE,
    // Under the user manager: the outer bwrap, the inner one, its sh and socat, and a grandchild.
    { pid: 5002000, name: 'bwrap', ppid: 5000900, args: sandboxArgs() },
    { pid: 5002001, name: 'bwrap', ppid: 5002000, args: sandboxArgs() },
    { pid: 5002002, name: 'sh', ppid: 5002001 },
    { pid: 5002003, name: 'socat', ppid: 5002001 },
    { pid: 5002004, name: 'sleep', ppid: 5002002 },
    // Under pid 1, naming the state directory itself.
    { pid: 5003000, name: 'bwrap', ppid: 1, args: sandboxArgs(ROOT) },
    { pid: 5003001, name: 'sh', ppid: 5003000 },
  ]);
  try {
    const chosen = await findOrphanedSandboxes([ROOT], { proc, uid: UID });
    assert.deepEqual(chosen.sort(), [5002000, 5002001, 5002002, 5002003, 5002004, 5003000, 5003001]);
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});

test('findOrphanedSandboxes: a bwrap whose parent is a live process other than systemd is not chosen, nor its children', async () => {
  const proc = await fakeProc([
    ...BASE,
    { pid: 5002000, name: 'bwrap', ppid: 5000950, args: sandboxArgs() },
    { pid: 5002001, name: 'bwrap', ppid: 5002000, args: sandboxArgs() },
    { pid: 5002002, name: 'sh', ppid: 5002001 },
  ]);
  try {
    assert.deepEqual(await findOrphanedSandboxes([ROOT], { proc, uid: UID }), []);
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});

test('findOrphanedSandboxes: an orphaned bwrap naming no root is not chosen, nor one naming a sibling path or only the file-system root', async () => {
  const proc = await fakeProc([
    ...BASE,
    // Another tool's sandbox (a Flatpak app).
    { pid: 5002000, name: 'bwrap', ppid: 5000900, args: sandboxArgs('/home/u/.var/app/org.example') },
    // A path that only starts with the root's text.
    { pid: 5002100, name: 'bwrap', ppid: 5000900, args: sandboxArgs(`${ROOT}-other/x`) },
    // The root inside a longer argument is not a path under it.
    { pid: 5002200, name: 'bwrap', ppid: 5000900, args: ['bwrap', '--setenv', 'X', `prefix${ROOT}/x`, '--ro-bind', '/', '/'] },
  ]);
  try {
    assert.deepEqual(await findOrphanedSandboxes([ROOT], { proc, uid: UID }), []);
    // A root of / or an empty one never covers every path.
    assert.deepEqual(await findOrphanedSandboxes(['/', ''], { proc, uid: UID }), []);
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});

test('findOrphanedSandboxes: another user\'s orphaned bwrap is not chosen, nor another user\'s descendant of ours, nor a process that is not a bwrap', async () => {
  const proc = await fakeProc([
    ...BASE,
    { pid: 5002000, name: 'bwrap', ppid: 5000900, uid: OTHER_UID, args: sandboxArgs() },
    { pid: 5002001, name: 'sh', ppid: 5002000, uid: OTHER_UID },
    // Ours, with a child of another user (and that child's own child).
    { pid: 5003000, name: 'bwrap', ppid: 5000900, args: sandboxArgs() },
    { pid: 5003001, name: 'su', ppid: 5003000, uid: OTHER_UID },
    { pid: 5003002, name: 'sh', ppid: 5003001 },
    // An orphaned shell naming the worktree is not a sandbox.
    { pid: 5004000, name: 'sh', ppid: 5000900, args: ['sh', '-c', `cd ${WORKTREE}`, WORKTREE] },
  ]);
  try {
    assert.deepEqual(await findOrphanedSandboxes([ROOT], { proc, uid: UID }), [5003000]);
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});

test('findOrphanedSandboxes and reapOrphanedSandboxes: without /proc nothing is chosen and nothing is said', async () => {
  const lines: string[] = [];
  const missing = join(tmpdir(), 'sf-reaper-no-proc', String(process.pid));
  assert.deepEqual(await findOrphanedSandboxes([ROOT], { proc: missing, uid: UID }), []);
  assert.deepEqual(await reapOrphanedSandboxes([ROOT], { proc: missing, uid: UID, log: (line) => lines.push(line) }), []);
  // Not Linux: no /proc to read.
  assert.deepEqual(await reapOrphanedSandboxes([ROOT], { platform: 'darwin', log: (line) => lines.push(line) }), []);
  assert.deepEqual(lines, []);
});

test('reapOrphanedSandboxes never throws: a failure is one log line', async () => {
  const lines: string[] = [];
  // A root that cannot be read as a path makes the reaper fail inside; it logs and returns.
  const roots = [Symbol('not a path')] as unknown as string[];
  assert.deepEqual(await reapOrphanedSandboxes(roots, { proc: tmpdir(), log: (line) => lines.push(line) }), []);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^sandbox reaper: failed: /);
});

// The state field of a live process (Z: a zombie), or undefined once it is gone.
async function stateOf(pid: number): Promise<string | undefined> {
  const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => undefined);
  return status === undefined ? undefined : /^State:\s*(\S)/m.exec(status)?.[1];
}

async function parentOf(pid: number): Promise<number | undefined> {
  const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => undefined);
  const ppid = status === undefined ? undefined : /^PPid:\s*(\d+)/m.exec(status)?.[1];
  return ppid === undefined ? undefined : Number(ppid);
}

async function nameOf(pid: number): Promise<string | undefined> {
  return (await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => undefined))?.trim();
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined || Date.now() > deadline) {
      return value;
    }
    await sleep(20);
  }
}

const ended = async (pid: number): Promise<boolean> => {
  const state = await stateOf(pid);
  return state === undefined || state === 'Z';
};

test('reapOrphanedSandboxes ends a real orphaned bwrap and its child, SIGKILL after the grace period for both, which ignore SIGTERM', { skip: process.platform !== 'linux' }, async (t) => {
  // A real path of its own: the copy's own path in its command line names the root.
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'sf-reaper-root-')));
  const bwrap = join(root, 'bwrap');
  await copyFile(realpathSync('/bin/sh'), bwrap);
  const pids: number[] = [];
  try {
    // A fake parent starts the bwrap-named shell, which starts a sleep and waits for it, then exits:
    // the shell is orphaned. Both ignore SIGTERM (an ignored signal stays ignored across exec).
    const parent = spawn('/bin/sh', ['-c', `'${bwrap}' -c 'trap "" TERM; sleep 300 & wait' </dev/null >/dev/null 2>&1 & echo $!`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    parent.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    await new Promise((done) => parent.once('close', done));
    const sandbox = Number(out.trim());
    assert.ok(Number.isInteger(sandbox) && sandbox > 0, `no pid: ${out}`);
    pids.push(sandbox);
    const child = await until(async () => {
      for (const name of (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))) {
        if ((await parentOf(Number(name))) === sandbox && (await nameOf(Number(name))) === 'sleep') {
          return Number(name);
        }
      }
      return undefined;
    });
    assert.notEqual(child, undefined, 'the sandbox\'s sleep never started');
    pids.push(child!);
    assert.equal(await nameOf(sandbox), 'bwrap');
    // Orphaned: its parent is pid 1 or the systemd user manager, unless this machine has another
    // subreaper, where the reaper rightly leaves it.
    const adopter = await parentOf(sandbox);
    if (adopter !== 1 && (await nameOf(adopter!)) !== 'systemd') {
      t.skip(`the orphan went to ${await nameOf(adopter!)} (pid ${adopter}), a subreaper that is neither pid 1 nor systemd`);
      return;
    }
    const lines: string[] = [];
    const started = Date.now();
    const reaped = await reapOrphanedSandboxes([root], { graceMs: 300, log: (line) => lines.push(line) });
    assert.deepEqual(reaped.sort(), [sandbox, child!].sort());
    assert.ok(Date.now() - started >= 300, 'SIGKILL came before the grace period');
    assert.ok(await until(async () => ((await ended(sandbox)) && (await ended(child!)) ? true : undefined)), 'the sandbox or its child is still alive');
    assert.deepEqual(lines, ['sandbox reaper: ended 1 orphaned sandbox (2 processes, 2 with SIGKILL)']);
    // Nothing left to end.
    assert.deepEqual(await findOrphanedSandboxes([root]), []);
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
