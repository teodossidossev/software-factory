// The watch of an Implementer turn's Bash calls. Every Bash call of the session, its main thread's
// and its sub-agents' alike, is open from the assistant message holding its tool_use until a user
// message holds its tool_result, timed by the runner's clock; a tool_progress heartbeat is not
// activity, and other tools are not watched. While a call is open the watch checks every checkMs:
// the oldest open call is stalled when it is open longer than afterMs and the check finds no
// command process alive, or open longer than hardMs whatever runs. A call past afterMs whose
// command still runs is left alone; a call that closed while the probe read /proc is never stalled. What to do with a stall is the session's (session.ts).
//
// The probe reads /proc from a root, the pid of the turn's bwrap wrapper: the Claude Code process is
// the topmost process below it not named bwrap, and a command process is any process below Claude
// Code that is not a zombie and is named neither bwrap (its Bash sandbox) nor socat (the sandbox
// proxy's bridges). Its answer is alive, none or unknown; unknown (no /proc, no root, the root or
// Claude Code gone) counts as alive, so only hardMs applies.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { type ProcessInfo, readProcesses } from './sandbox-reaper.js';

// How often an open call is looked at.
export const STALL_CHECK_MS = 60_000;
// The Bash tool's cap is 60 minutes (BASH_MAX_TIMEOUT_MS, session.ts): a call open 5 minutes past it is hung.
export const STALL_HARD_MS = 65 * 60_000;
// The first words of the note a resent instruction ends with (stallNote).
export const STALL_LEAD = 'The factory ended your last command because it hung:';

// The stalled command's length in the note and the event.
const COMMAND_CHARS = 200;
// The processes below Claude Code that are not a command: its Bash sandbox and the proxy's bridges.
const SANDBOX_NAME = 'bwrap';
const NOT_COMMANDS = new Set([SANDBOX_NAME, 'socat']);
const WATCHED_TOOL = 'Bash';

export type ProbeAnswer = 'alive' | 'none' | 'unknown';
export type StallReason = 'no_process' | 'past_cap';
export type StallAction = 'resent' | 'stopped';

// A stalled call: its command on one line (oneLineCommand), how long it was open, and why it counts as hung.
export interface Stall {
  tool: 'Bash';
  command: string;
  openS: number;
  reason: StallReason;
}

export interface ToolStallOptions {
  // How long a call may stay open with no command process (SF_TOOL_STALL_MIN in ms).
  afterMs: number;
  // How often an open call is looked at; default STALL_CHECK_MS (tests shorten it).
  checkMs?: number | undefined;
  // How long a call may stay open whatever runs; default STALL_HARD_MS (tests shorten it).
  hardMs?: number | undefined;
  // Whether a command process runs under the wrapper's pid; default commandProbe on the real /proc.
  probe?: ((root: number | undefined) => Promise<ProbeAnswer>) | undefined;
}

// The command with every run of whitespace, newlines included, one space, cut to COMMAND_CHARS
// characters (the last one "…" when cut), without splitting a surrogate pair.
export function oneLineCommand(command: string): string {
  const line = command.replace(/\s+/gu, ' ').trim();
  if (line.length <= COMMAND_CHARS) {
    return line;
  }
  let end = COMMAND_CHARS - 1;
  const code = line.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return `${line.slice(0, end)}…`;
}

const minutes = (openS: number): number => Math.max(1, Math.round(openS / 60));
const why = (stall: Stall): string => (stall.reason === 'past_cap'
  ? `open ${minutes(stall.openS)} minutes, past the Bash tool's 60-minute cap`
  : `open ${minutes(stall.openS)} minutes with no process of it still running`);
const shownCommand = (stall: Stall): string => (stall.command === '' ? '(no command)' : stall.command);

// The paragraph a resent instruction ends with: one line, whatever the command held.
export function stallNote(stall: Stall): string {
  return `${STALL_LEAD} ${shownCommand(stall)} (${why(stall)}). Do not run that command again as it was: change what made it hang, and give a long command a timeout. Do not redo work you already finished; go on from where you stopped.`;
}

// The stop's message when a call stalls again in the same chain.
export function stallStopMessage(stall: Stall): string {
  return `A Bash command hung again after the factory had sent the turn's instruction once more: ${shownCommand(stall)} (${why(stall)}).`;
}

// Whether a /proc snapshot shows a command process below the Claude Code process under root.
function probeProcesses(processes: ReadonlyMap<number, ProcessInfo>, root: number): ProbeAnswer {
  const top = processes.get(root);
  if (top === undefined || top.zombie) {
    return 'unknown';
  }
  const children = new Map<number, ProcessInfo[]>();
  for (const info of processes.values()) {
    children.set(info.ppid, [...(children.get(info.ppid) ?? []), info]);
  }
  // Claude Code: the topmost process below root not named bwrap, looked for level by level through bwraps.
  let claude: ProcessInfo | undefined;
  for (let level = children.get(root) ?? []; claude === undefined && level.length > 0;) {
    claude = level.find((info) => info.name !== SANDBOX_NAME);
    level = level.flatMap((info) => (info.name === SANDBOX_NAME ? (children.get(info.pid) ?? []) : []));
  }
  if (claude === undefined || claude.zombie) {
    return 'unknown';
  }
  const seen = new Set<number>([claude.pid]);
  const below = [...(children.get(claude.pid) ?? [])];
  while (below.length > 0) {
    const info = below.pop()!;
    if (seen.has(info.pid)) {
      continue;
    }
    seen.add(info.pid);
    if (!info.zombie && !NOT_COMMANDS.has(info.name)) {
      return 'alive';
    }
    below.push(...(children.get(info.pid) ?? []));
  }
  return 'none';
}

// The probe: alive, none or unknown for the wrapper's pid root, on the /proc given (default the
// real one on Linux only). Never throws.
export async function commandProbe(root: number | undefined, options: { proc?: string; platform?: NodeJS.Platform } = {}): Promise<ProbeAnswer> {
  const proc = options.proc ?? ((options.platform ?? process.platform) === 'linux' ? '/proc' : undefined);
  if (root === undefined || proc === undefined) {
    return 'unknown';
  }
  try {
    return probeProcesses(await readProcesses(proc), root);
  } catch { // no /proc to read: unknown, which counts as alive
    return 'unknown';
  }
}

interface OpenCall {
  id: string;
  command: string;
  since: number;
}

// The blocks of an assistant or user message, main thread or sub-agent.
function blocksOf(message: SDKMessage): Array<Record<string, unknown>> {
  if (message.type !== 'assistant' && message.type !== 'user') {
    return [];
  }
  const content = (message.message as { content?: unknown }).content;
  return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => block !== null && typeof block === 'object') : [];
}

// One turn's watch: started with the turn, fed every SDK message (see), stopped when the turn ends
// (stop), after which no check runs and none in flight reports. onStall is called at most once.
export class ToolStallWatch {
  readonly #open = new Map<string, OpenCall>();
  readonly #afterMs: number;
  readonly #hardMs: number;
  readonly #probe: (root: number | undefined) => Promise<ProbeAnswer>;
  readonly #root: () => number | undefined;
  readonly #onStall: (stall: Stall) => void;
  readonly #timer: NodeJS.Timeout;
  readonly #now: () => number;
  #checking = false;
  #stopped = false;

  constructor(options: ToolStallOptions, root: () => number | undefined, onStall: (stall: Stall) => void, now: () => number = Date.now) {
    this.#afterMs = options.afterMs;
    this.#hardMs = options.hardMs ?? STALL_HARD_MS;
    this.#probe = options.probe ?? ((pid) => commandProbe(pid));
    this.#root = root;
    this.#onStall = onStall;
    this.#now = now;
    this.#timer = setInterval(() => void this.#check(), options.checkMs ?? STALL_CHECK_MS);
    this.#timer.unref();
  }

  // A Bash tool_use opens its call, a tool_result closes it; nothing else counts.
  see(message: SDKMessage): void {
    for (const block of blocksOf(message)) {
      if (message.type === 'assistant' && block.type === 'tool_use' && block.name === WATCHED_TOOL && typeof block.id === 'string') {
        const command = (block.input as { command?: unknown } | undefined)?.command;
        this.#open.set(block.id, { id: block.id, command: oneLineCommand(typeof command === 'string' ? command : ''), since: this.#now() });
      } else if (message.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        this.#open.delete(block.tool_use_id);
      }
    }
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
  }

  async #check(): Promise<void> {
    if (this.#stopped || this.#checking) {
      return;
    }
    const oldest = [...this.#open.values()].reduce<OpenCall | undefined>((first, call) => (first === undefined || call.since < first.since ? call : first), undefined);
    const openMs = oldest === undefined ? 0 : this.#now() - oldest.since;
    if (oldest === undefined || openMs <= this.#afterMs) {
      return;
    }
    let reason: StallReason | undefined;
    if (openMs > this.#hardMs) {
      reason = 'past_cap';
    } else {
      this.#checking = true;
      const answer = await this.#probe(this.#root()).catch((): ProbeAnswer => 'unknown');
      this.#checking = false;
      reason = answer === 'none' ? 'no_process' : undefined;
    }
    // The turn may have ended, or the call closed, while the probe read /proc.
    if (reason === undefined || this.#stopped || !this.#open.has(oldest.id)) {
      return;
    }
    this.stop();
    this.#onStall({ tool: WATCHED_TOOL, command: oldest.command, openS: Math.round((this.#now() - oldest.since) / 1000), reason });
  }
}
