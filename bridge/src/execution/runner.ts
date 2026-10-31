// Launches the native Claude Code session for one job: an interactive session
// in the application repository whose first message is the /implement skill
// invocation. The operator's terminal is attached (stdio inherit) and the
// session starts in manual permission mode, so the operator answers the
// workspace-trust and every permission prompt. Without --permission-mode a
// session can start in auto mode, where tool calls are approved automatically.
// Every launch goes through the host-wide session gate (session-gate.ts):
// reserve() takes it before the job is claimed, and the launched Claude process
// itself keeps holding it until it ends.
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ExecutionError } from './errors.js';
import { MEDIATOR_STATE_DIR } from './git-state.js';
import type { GateBusy, SessionGate } from './session-gate.js';

export interface LaunchRequest {
  cwd: string;
  sessionId: string;
  name: string;
  prompt: string;
}

export interface SessionExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface LaunchedSession {
  pid: number;
  exited: Promise<SessionExit>;
}

// SF-009: a managed session is one long-lived `claude -p` process in stream-json mode. Its
// stdin takes user messages (one JSON object per line) and its stdout reports every event,
// including a `result` at the end of each turn; it keeps running between turns until stdin ends.
export interface ManagedLaunchRequest {
  cwd: string;
  sessionId: string;
  name: string;
  // The session works in the mediator checkout (self-hosting): SELF_HOSTED_DENIED_TOOLS apply too.
  selfHosted?: boolean;
}

export interface ManagedProcess extends LaunchedSession {
  input: Writable;
  output: Readable;
  // Diagnostics only: never exported or shown through MCP.
  errors: Readable;
}

// A taken session gate, ready to launch one session (or to be given back).
export interface ReservedLaunch {
  // The gate helper's pid (diagnostics; the launched session keeps it).
  readonly holderPid: number;
  launch(request: LaunchRequest): Promise<LaunchedSession>;
  // Only runners built for managed sessions (ManagedClaudeRunner) can do this.
  launchManaged?(request: ManagedLaunchRequest): Promise<ManagedProcess>;
  release(): Promise<void>;
}

export interface ClaudeRunner {
  // "<executable> <version>", recorded as the runner identity.
  readonly identity: string;
  available(): Promise<boolean>;
  // Takes the host-wide session gate, or reports that another session holds it.
  reserve(): Promise<ReservedLaunch | GateBusy>;
  // Who holds the gate now (without taking it); empty when free.
  gateHolders(): Promise<number[]>;
  // A command for a session started by hand, wrapped so that it takes the same gate.
  gatedCommand(command: readonly string[]): Promise<string[]>;
}

// The fixed argument list: manual permissions, session id and name for traceability, then the skill invocation.
export function claudeArguments(request: Omit<LaunchRequest, 'cwd'>): string[] {
  return ['--permission-mode', 'manual', '--session-id', request.sessionId, '--name', request.name, request.prompt];
}

// Git operations that stay the operator's (SF-009 Phase 2). Denied to managed sessions as
// defense in depth; the supervisor also checks HEAD, the index and the Git control files at
// every turn boundary, which is what is relied on: a prefix rule is not a sandbox.
export const DENIED_GIT_COMMANDS = [
  'add', 'commit', 'push', 'reset', 'clean', 'stash', 'checkout', 'switch', 'restore', 'rebase', 'merge',
  'cherry-pick', 'revert', 'rm', 'mv', 'tag', 'branch', 'config', 'update-ref', 'update-index', 'worktree', 'am', 'pull', 'fetch',
];
export const DENIED_TOOLS = [
  ...DENIED_GIT_COMMANDS.map((command) => `Bash(git ${command}:*)`),
  'Bash(sudo:*)',
  'EnterWorktree',
  'Edit(.git/**)',
  'Write(.git/**)',
  // The app's .env and its variants (defense in depth; a shell can still read them).
  ...['Read', 'Edit', 'Write'].flatMap((tool) => [`${tool}(**/.env)`, `${tool}(**/.env.*)`]),
];

// Self-hosting only (the session works in the mediator checkout): the mediator's own state, where
// the bridge and the supervisor keep jobs, requests and private baselines (defense in depth; a
// shell can still reach it, and the turn-end checks do not cover it).
export const SELF_HOSTED_DENIED_TOOLS = ['Read', 'Edit', 'Write'].map((tool) => `${tool}(${MEDIATOR_STATE_DIR}/**)`);

// The fixed argument list of a managed session (SF-009): print mode with stream-json in and out,
// so one process takes several turns; exactly the documented auto permission mode; prompts that
// would need a person are denied, never answered; no MCP servers from any configuration; the
// Git operations above denied; user messages acknowledged. Nothing in it comes from a tool
// argument or the instruction.
export function managedArguments(request: Omit<ManagedLaunchRequest, 'cwd'>): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'auto',
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--session-id', request.sessionId,
    '--name', request.name,
    // Review 02: every user message is echoed on stdout, so a turn end can be attributed to the
    // message it answers (stream-session.ts). Static reading of Claude Code 2.1.312 and 2.1.314:
    // the echo is held until the first model output of the turn, and partial messages make that the
    // first non-ping stream event, not the first complete assistant message. Stream events are never
    // an acknowledgment, and this does not guarantee an echo within the acknowledgment bound.
    '--replay-user-messages',
    '--include-partial-messages',
    '--disallowedTools', ...DENIED_TOOLS, ...(request.selfHosted === true ? SELF_HOSTED_DENIED_TOOLS : []),
  ];
}

// SF-009 Review 02: the environment variable that marks every process of one managed session (its
// value: the session id). Inherited by every child, so the supervisor can still find one that left
// the process tree (executor/quiescence.ts).
export const SESSION_TAG = 'SOFTWARE_FACTORY_MANAGED_SESSION';

// Markers a running Claude Code session sets for its own child processes. A
// session that inherits them turns transcript saving off and acts as a child.
export const CLAUDE_SESSION_MARKERS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
];

// The operator's environment without Software Factory, OpenClaw and inherited Claude session variables.
export function sessionEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^(SF_|FACTORY_|OPENCLAW_)/.test(key) && !CLAUDE_SESSION_MARKERS.includes(key)),
  );
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findOnPath(name: string, path = process.env.PATH ?? ''): Promise<string | undefined> {
  for (const dir of path.split(delimiter).filter((entry) => isAbsolute(entry))) {
    if (await executable(join(dir, name))) {
      return join(dir, name);
    }
  }
  return undefined;
}

export class ProcessClaudeRunner implements ClaudeRunner {
  readonly identity: string;
  readonly #executable: string;
  readonly #stdio: 'inherit' | 'ignore';
  readonly #gate: SessionGate;

  constructor(executablePath: string, version: string, stdio: 'inherit' | 'ignore', gate: SessionGate) {
    this.#executable = executablePath;
    this.#stdio = stdio;
    this.#gate = gate;
    this.identity = `claude ${version}`;
  }

  async available(): Promise<boolean> {
    return (await executable(this.#executable)) && (await this.#gate.available());
  }

  gateHolders(): Promise<number[]> {
    return this.#gate.holders();
  }

  async gatedCommand(command: readonly string[]): Promise<string[]> {
    await this.#gate.ensure();
    return this.#gate.gatedCommand(command);
  }

  async reserve(): Promise<ReservedLaunch | GateBusy> {
    const reservation = await this.#gate.reserve(this.#stdio);
    if ('busy' in reservation) return reservation;
    const { held } = reservation;
    return {
      holderPid: held.pid,
      launch: (request) =>
        held.launch({ executable: this.#executable, args: claudeArguments(request), cwd: request.cwd, env: sessionEnvironment() }),
      release: () => held.release(),
    };
  }
}

// SF-009: the supervisor's runner. Same gate, but the launched process gets pipes instead of a
// terminal and the managed argument list. The interactive launch is not offered here.
export class ManagedClaudeRunner implements ClaudeRunner {
  readonly identity: string;
  readonly #executable: string;
  readonly #gate: SessionGate;

  constructor(executablePath: string, version: string, gate: SessionGate) {
    this.#executable = executablePath;
    this.#gate = gate;
    this.identity = `claude ${version}`;
  }

  async available(): Promise<boolean> {
    return (await executable(this.#executable)) && (await this.#gate.available());
  }

  gateHolders(): Promise<number[]> {
    return this.#gate.holders();
  }

  async gatedCommand(command: readonly string[]): Promise<string[]> {
    await this.#gate.ensure();
    return this.#gate.gatedCommand(command);
  }

  async reserve(): Promise<ReservedLaunch | GateBusy> {
    const reservation = await this.#gate.reserve('pipe');
    if ('busy' in reservation) return reservation;
    const { held } = reservation;
    return {
      holderPid: held.pid,
      launch: async () => {
        throw new ExecutionError('runner_unavailable', 'The managed runner starts managed sessions only.');
      },
      launchManaged: async (request) => {
        // The session tag (Review 02): inherited by every process the session starts, also a
        // detached one, so the supervisor can tell when none of them runs any more (quiescence.ts).
        const env = { ...sessionEnvironment(), [SESSION_TAG]: request.sessionId };
        const launched = await held.launch({ executable: this.#executable, args: managedArguments(request), cwd: request.cwd, env });
        if (launched.streams === undefined) throw new ExecutionError('runner_unavailable', 'The managed session has no pipes.');
        return { pid: launched.pid, exited: launched.exited, ...launched.streams };
      },
      release: () => held.release(),
    };
  }
}
