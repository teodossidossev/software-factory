// The ChatGPT tunnel as sf serve's child: scripts/sf-tunnel.sh run (or SF_TUNNEL_SCRIPT) in a
// process group of its own, its output on stderr prefixed "tunnel | " with the MCP token shown as
// <token>. Never two tunnels: before a start, the group a previous sf serve left (tunnel.pid in the
// state directory) is ended when it still runs the tunnel script, and nothing starts when the
// tunnel client's admin endpoint already answers (a tunnel started outside sf serve, which sf serve
// never ends, restarts or takes over). The health check tunnel's recovery (src/recovery.ts) restarts
// the child; sf serve ends its group when it stops.
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic.js';
import { withoutHostTokens } from './forge.js';
import { fetchText, REQUEST_TIMEOUT_MS } from './health.js';
import { redactMcpToken } from './server.js';

export const TUNNEL_PID_FILE = 'tunnel.pid';
export const TUNNEL_RUNBOOK = 'docs/runbooks/chatgpt-connection.md';
// SIGTERM to the group, SIGKILL for what is still alive this long after.
export const TUNNEL_STOP_GRACE_MS = 5_000;
// The tunnel's first start may take this long to answer (three health passes): a restart in that
// time leaves a child that still runs to come up, and restarts one that has died.
export const TUNNEL_START_GRACE_MS = 90_000;
const POLL_MS = 100;
const SCRIPT_NAME = 'sf-tunnel.sh';

// scripts/sf-tunnel.sh of this package (dist/src/tunnel.js is three levels below the repository
// root), or SF_TUNNEL_SCRIPT.
export function tunnelScript(env: NodeJS.ProcessEnv = process.env): string {
  return env.SF_TUNNEL_SCRIPT || fileURLToPath(new URL(`../../../scripts/${SCRIPT_NAME}`, import.meta.url));
}

// The tunnel client's profile, as scripts/sf-tunnel.sh resolves it.
export function tunnelProfile(env: NodeJS.ProcessEnv = process.env, home = env.HOME ?? ''): string {
  const dir = env.TUNNEL_CLIENT_PROFILE_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'tunnel-client');
  return join(dir, 'software-factory.yaml');
}

// The tunnel client's admin endpoint (host:port), as sf info and the health check read it.
export function tunnelHealthAddress(env: NodeJS.ProcessEnv = process.env): string {
  return env.SF_TUNNEL_HEALTH || '127.0.0.1:8790';
}

// A read error of a process that ended meanwhile.
const gone = (error: unknown): boolean => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');

// The live (not zombie) processes of a process group and their command lines, from proc (default
// /proc); undefined without a readable proc. strict: undefined also when a process's files fail to
// read for another reason than its end, so the group cannot be checked.
async function groupMembers(pgid: number, proc = '/proc', strict = false): Promise<string[][] | undefined> {
  let pids: string[];
  try {
    pids = (await readdir(proc)).filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
  let unreadable = false;
  const members = await Promise.all(pids.map(async (pid) => {
    try {
      const stat = await readFile(join(proc, pid, 'stat'), 'utf8');
      // The fields after the command name: state, ppid, pgrp, ...
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (state === 'Z' || Number(pgrp) !== pgid) {
        return undefined;
      }
      return (await readFile(join(proc, pid, 'cmdline'), 'utf8')).split('\0').filter((arg) => arg !== '');
    } catch (error) {
      unreadable ||= !gone(error);
      return undefined;
    }
  }));
  return strict && unreadable ? undefined : members.filter((args) => args !== undefined);
}

// A process's start time, field 22 of <proc>/<pid>/stat: with the pid, who the process is (a reused
// pid is another). undefined when the process is gone or a zombie; rejects on another read error.
async function startTime(pid: number, proc = '/proc'): Promise<string | undefined> {
  try {
    const stat = await readFile(join(proc, String(pid), 'stat'), 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[0] === 'Z' ? undefined : rest[19];
  } catch (error) {
    if (gone(error)) {
      return undefined;
    }
    throw error;
  }
}

// Whether the process is alive (not a zombie); without /proc, by a signal 0.
async function processAlive(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    if (existsSync('/proc/self')) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

// Whether a process of the group is alive: from proc when every file of it reads, else by a signal 0
// to the group (a zombie counts as alive then), so a group is never taken as ended unchecked.
async function groupAlive(pgid: number, proc?: string): Promise<boolean> {
  const members = await groupMembers(pgid, proc, true);
  if (members !== undefined) {
    return members.length > 0;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// Sends a signal to a pid (a group as its negative id); process.kill by default.
export type SignalSender = (pid: number, signal: NodeJS.Signals) => void;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export interface TunnelOptions {
  script: string;
  stateDir: string;
  // The admin endpoint (host:port) asked for /readyz before a start.
  address: string;
  // The MCP token, read at each start: its lines show it as <token>.
  token(): Promise<string | undefined>;
  // Where the lines go; default console.error.
  log?: (line: string) => void;
  graceMs?: number;
  // How a group is signalled; default process.kill.
  kill?: SignalSender;
  // Where tunnel.pid's group is looked up; default /proc.
  proc?: string;
  now?: () => number;
}

// sf serve's tunnel: start() once, restart() for the recovery, stop() at the end.
export class TunnelChild {
  readonly #options: TunnelOptions;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #kill: SignalSender;
  // The children whose exit sf serve asked for: not reported as a failure.
  readonly #ended = new WeakSet<ChildProcess>();
  #child: ChildProcess | undefined;
  // Whether sf serve started the tunnel and so may end and restart it.
  #owned = false;
  #stopping = false;
  #startedAt: number | undefined;
  #busy: Promise<void> = Promise.resolve();

  constructor(options: TunnelOptions) {
    this.#options = options;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#now = options.now ?? Date.now;
    this.#kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  }

  get owned(): boolean {
    return this.#owned && !this.#stopping;
  }

  // The process group of the running child; undefined without one.
  get group(): number | undefined {
    return this.#child?.exitCode === null && this.#child.signalCode === null ? this.#child.pid : undefined;
  }

  // How long ago the first start was, while it may still be coming up; undefined after.
  #starting(): number | undefined {
    const since = this.#startedAt === undefined ? undefined : this.#now() - this.#startedAt;
    return since !== undefined && since < TUNNEL_START_GRACE_MS ? since : undefined;
  }

  // The start: the leftover of tunnel.pid ended, then the child unless something answers on the
  // admin endpoint. A leftover that does not end is a failed start: nothing starts beside it, and
  // tunnel.pid keeps it for the next start. Resolves with what it did; never rejects.
  async start(): Promise<'started' | 'outside' | 'failed'> {
    if (!(await this.#endLeftover())) {
      return 'failed';
    }
    if (await this.#answers()) {
      this.#log(`tunnel: not started: a tunnel already runs outside sf serve (http://${this.#options.address}/readyz answers)`);
      return 'outside';
    }
    try {
      await this.#spawn();
    } catch {
      return 'failed';
    }
    this.#owned = true;
    this.#startedAt = this.#now();
    return 'started';
  }

  // The recovery: the child's group ended and a new child started, unless a tunnel started outside
  // sf serve answers by then (sf serve then gives the tunnel up). A child of the first start that
  // still runs within TUNNEL_START_GRACE_MS is left to come up (one line); a dead one is restarted.
  // Rejects when the start fails.
  restart(): Promise<void> {
    const work = this.#busy.then(async () => {
      if (!this.owned) {
        return;
      }
      const starting = this.#starting();
      if (starting !== undefined && this.group !== undefined) {
        this.#log(`tunnel: not restarted: it started ${Math.round(starting / 1000)} s ago and still runs; left to come up`);
        return;
      }
      if (!(await this.#endChild())) {
        throw new Error('the tunnel\'s process group did not end');
      }
      if (await this.#answers()) {
        this.#owned = false;
        this.#log('tunnel: not restarted: a tunnel already runs outside sf serve; sf serve leaves it alone');
        return;
      }
      if (!this.#stopping) {
        await this.#spawn();
      }
    });
    this.#busy = work.catch(() => undefined);
    return work;
  }

  // The end: the child's group ended (SIGKILL after the grace period) and tunnel.pid removed; a
  // group that does not end stays in tunnel.pid, so the next start ends it before anything starts.
  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#busy;
    // tunnel.pid is sf serve's to remove only when it names sf serve's own child, now ended: after a
    // start that refused (a group that cannot be checked or did not end) it stays untouched.
    const group = this.#child?.pid;
    if (group === undefined) {
      return;
    }
    if (await this.#endChild()) {
      await rm(join(this.#options.stateDir, TUNNEL_PID_FILE), { force: true });
    } else {
      this.#log(`tunnel: process group ${group} did not end; tunnel.pid keeps it for the next start`);
    }
  }

  // SIGTERM to the child's group, synchronously (at the process's exit).
  stopNow(): void {
    const group = this.group;
    if (group !== undefined) {
      this.#signalGroup(group, 'SIGTERM');
    }
  }

  async #answers(): Promise<boolean> {
    return fetchText(`http://${this.#options.address}/readyz`, REQUEST_TIMEOUT_MS).then(() => true, () => false);
  }

  // A group named in tunnel.pid whose leader still has the recorded pid and start time and runs the
  // tunnel script: a crashed sf serve's tunnel, ended. A reused pid is left alone. Whether nothing
  // of the tunnel is left: false (tunnel.pid kept, one line) when the group did not end, or cannot
  // be checked (tunnel.pid or the proc files fail to read).
  async #endLeftover(): Promise<boolean> {
    const path = join(this.#options.stateDir, TUNNEL_PID_FILE);
    const uncheckable = (): boolean => {
      this.#log('tunnel.pid names a group that cannot be checked; no tunnel started');
      return false;
    };
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      return gone(error) ? true : uncheckable();
    }
    // "<pid> <start time>": the group leader as the previous sf serve started it.
    const [pidText, recorded] = text.trim().split(/\s+/);
    const pgid = Number(pidText);
    if (!Number.isInteger(pgid) || pgid <= 1) {
      return true;
    }
    const members = await groupMembers(pgid, this.#options.proc, true);
    if (members === undefined) {
      return uncheckable();
    }
    let start: string | undefined;
    try {
      start = await startTime(pgid, this.#options.proc);
    } catch {
      return uncheckable();
    }
    const runsScript = members.some((args) => args.some((arg) => arg === this.#options.script || basename(arg) === SCRIPT_NAME));
    // Ended only when the leader is still the one recorded (pid and start time) and runs the
    // script; anything else under that id is left alone, with tunnel.pid, and the start goes on to
    // ask /readyz.
    if (recorded === undefined || start !== recorded || !runsScript) {
      if (start !== undefined || members.length > 0) {
        this.#log(`tunnel: tunnel.pid names process group ${pgid}, which is not the tunnel it recorded; left alone`);
      }
      return true;
    }
    this.#log(`tunnel: ending the tunnel a previous sf serve left (process group ${pgid})`);
    if (!(await this.#endGroup(pgid))) {
      this.#log(`tunnel: not started: the tunnel a previous sf serve left (process group ${pgid}) did not end; end it, then restart sf serve`);
      return false;
    }
    await rm(path, { force: true });
    return true;
  }

  // The child's group ended; false when something of it is still alive, and the child is kept so a
  // later restart or stop tries again. Once the child itself has exited, a live process under its
  // pid is another program's (the pid was reused after the whole group ended: a pid in use as a
  // group id is never given out), and nothing is signalled.
  async #endChild(): Promise<boolean> {
    const child = this.#child;
    if (child?.pid === undefined) {
      return true;
    }
    this.#ended.add(child);
    const ended = ((child.exitCode !== null || child.signalCode !== null) && (await processAlive(child.pid))) || (await this.#endGroup(child.pid));
    if (ended && this.#child === child) {
      this.#child = undefined;
    }
    return ended;
  }

  // Sends the signal to the group, ignoring a group gone meanwhile.
  #signalGroup(pgid: number, signal: NodeJS.Signals): void {
    try {
      this.#kill(-pgid, signal);
    } catch {
      // Nothing left to signal.
    }
  }

  // SIGTERM to the group; SIGKILL after the grace period to what is still alive. Whether it ended.
  async #endGroup(pgid: number): Promise<boolean> {
    this.#signalGroup(pgid, 'SIGTERM');
    const deadline = Date.now() + (this.#options.graceMs ?? TUNNEL_STOP_GRACE_MS);
    while ((await groupAlive(pgid, this.#options.proc)) && Date.now() < deadline) {
      await sleep(POLL_MS);
    }
    if (await groupAlive(pgid, this.#options.proc)) {
      this.#signalGroup(pgid, 'SIGKILL');
      for (let tries = 0; tries < 20 && (await groupAlive(pgid, this.#options.proc)); tries += 1) {
        await sleep(POLL_MS);
      }
    }
    return !(await groupAlive(pgid, this.#options.proc));
  }

  // The child in its own process group, its group written to tunnel.pid. Rejects (after one line)
  // when the script is missing or cannot start.
  async #spawn(): Promise<void> {
    const { script, stateDir } = this.#options;
    if (!existsSync(script)) {
      this.#log(`tunnel | not started: ${script} is missing; the dashboard works without it (${TUNNEL_RUNBOOK}).`);
      throw new Error(`${script} is missing`);
    }
    const token = await this.#options.token().catch(() => undefined);
    const child = spawn(script, ['run'], { env: withoutHostTokens(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    this.#forward(child.stdout!, token);
    this.#forward(child.stderr!, token);
    try {
      await once(child, 'spawn');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#log(`tunnel | could not start (${reason}); the dashboard works without it (${TUNNEL_RUNBOOK}).`);
      throw new Error(`the tunnel could not start: ${reason}`);
    }
    this.#child = child;
    child.once('exit', (code, signal) => {
      // An exit sf serve did not ask for: the health check sees it.
      if (!this.#ended.has(child)) {
        this.#log(`tunnel | exited (${code ?? signal}); the dashboard works without it (${TUNNEL_RUNBOOK}).`);
      }
    });
    // The leader's pid and start time; without the start time no later start ends the group.
    const start = await startTime(child.pid!, this.#options.proc).catch(() => undefined);
    await writeFileAtomic(join(stateDir, TUNNEL_PID_FILE), Buffer.from(`${child.pid}${start === undefined ? '' : ` ${start}`}\n`), 0o600);
  }

  // The stream's lines on the log, prefixed and with the token shown as <token>.
  #forward(stream: NodeJS.ReadableStream, token: string | undefined): void {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      rest += chunk;
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        this.#log(`tunnel | ${redactMcpToken(line, token)}`);
      }
    });
    stream.on('end', () => {
      if (rest !== '') {
        this.#log(`tunnel | ${redactMcpToken(rest, token)}`);
        rest = '';
      }
    });
  }
}
