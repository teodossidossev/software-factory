// The Implementer session driver: one Claude Agent SDK query() per turn, the first creating the
// session, every later one resuming it. Turns are serialized; prompts sent while a turn runs are
// queued and run in order. When the queue is empty the driver reports the outcome of the turns
// since it was last idle. Each prompt carries its own deny list; the driver does not know why.
// It knows nothing about jobs, Git or MCP.
// A turn that ends at maxTurns is put to the turnLimit hook: it answers with a
// continuation, which runs next in the same session with the same deny list, or with the reason
// the turn stops. Every prompt sent starts a chain; the driver sends at most turnLimitContinues
// continuations per chain, whatever the hook answers.
// With the sandbox on, every query's Claude Code runs inside the bwrap wrapper (session-wrapper.ts); a
// missing bwrap, or a wrapper that fails before Claude Code answers, fails the turn with
// sandbox_unavailable, and Claude Code is never started without it.
import { query, type SandboxSettings, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { type ImageRef, promptInput } from './attachments.js';
import { makeSessionTmp, removeSessionTmp } from './host-tmp.js';
import { PACKAGE_ROOT } from './package-root.js';
import { IMPLEMENTER_TOOLS } from './rules.js';
import { claudeConfigDir, claudeUserSettings, type PathDenials, withSandboxDenials } from './sandbox-denials.js';
import { factoryRoots, reapOrphanedSandboxes } from './sandbox-reaper.js';
import { BWRAP_MISSING, prepareClaudeState, SANDBOX_UNAVAILABLE, WrappedSpawn } from './session-wrapper.js';

// Markers a running Claude Code session sets for its children; a session inheriting them acts as
// a child and may not save its transcript.
const CLAUDE_SESSION_MARKERS = new Set([
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
]);
// No SSH_AUTH_SOCK: the factory fetches and pushes itself, outside the sandbox, so no
// session needs the user's SSH agent.
const KEPT_NAMES = new Set(['PATH', 'HOME', 'LANG', 'LANGUAGE', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ']);
const KEPT_PATTERN = /^(LC_\w+|XDG_\w+|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|ANTHROPIC_\w+|CLAUDE_\w+)$/;
// The cloud providers' credentials: passed only when Claude Code itself runs on Bedrock or
// Vertex, whose provider needs them; a workspace never does.
const CLOUD_PATTERN = /^(AWS_\w+|GOOGLE_\w+|CLOUD_ML_\w+)$/;
const CLOUD_PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];
// A provider switch is on unless it is unset or plainly off; an unknown value counts as on, so a
// Bedrock or Vertex setup never loses its credentials.
const switchOn = (value: string | undefined): boolean => value !== undefined && !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
// The passed variables sandboxed commands never see: the Anthropic and cloud credentials
// and the OAuth token Claude Code itself uses.
const SANDBOX_HIDDEN_PATTERN = /^(ANTHROPIC_\w+|AWS_\w+|GOOGLE_\w+|CLOUD_ML_\w+|CLAUDE_CODE_OAUTH_TOKEN)$/;

// The child's environment: the basics, proxies and the Anthropic/Claude auth variables, and the
// cloud provider's when Claude Code runs on Bedrock or Vertex; nothing of the factory (SF_*) and no
// inherited Claude session markers.
export function sessionEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const cloud = CLOUD_PROVIDER_SWITCHES.some((name) => switchOn(env[name]));
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (KEPT_NAMES.has(name) || KEPT_PATTERN.test(name) || (cloud && CLOUD_PATTERN.test(name))) && !CLAUDE_SESSION_MARKERS.has(name)) {
      result[name] = value;
    }
  }
  return result;
}

// One credentials.envVars deny entry of the sandbox settings (the installed SDK's shape) for each
// credential of the given environment (sessionEnvironment's result) that sandboxed commands may not see.
export function sandboxEnvDenials(environment: Record<string, string>): Array<{ name: string; mode: 'deny' }> {
  return Object.keys(environment).filter((name) => SANDBOX_HIDDEN_PATTERN.test(name)).map((name) => ({ name, mode: 'deny' as const }));
}

// The sandbox settings with the environment's credentials hidden from sandboxed commands
// (sandboxEnvDenials), after any credentials.envVars entries already there; undefined stays undefined.
export function withSandboxEnvDenials(sandbox: SandboxSettings | undefined, environment: Record<string, string>): SandboxSettings | undefined {
  const denied = sandboxEnvDenials(environment);
  if (sandbox === undefined || denied.length === 0) {
    return sandbox;
  }
  return { ...sandbox, credentials: { ...sandbox.credentials, envVars: [...(sandbox.credentials?.envVars ?? []), ...denied] } };
}

export interface SessionOptions {
  cwd: string;
  maxTurns: number;
  claudePath: string | undefined;
  // An existing session to resume; undefined starts a new one with the first turn.
  sessionId?: string | undefined;
  // Claude Code's sandbox for every turn, and the bwrap wrapper of its process (session-wrapper.ts)
  // under the path denials' lists; undefined (SF_SANDBOX=off) runs without either, as the gate does.
  sandbox?: SandboxSettings | undefined;
  // The model option of query(); undefined leaves the user's Claude Code default.
  model?: string | undefined;
  // Continuations after a turn limit per chain (SF_TURN_LIMIT_CONTINUES); default 0.
  turnLimitContinues?: number | undefined;
  // Builds the session's path denials (src/sandbox-denials.ts) for its temporary folder: called
  // once, by the first turn before its query(); its tools go on top of every prompt's deny list, its
  // sandbox lists and claudeTmp into the sandbox settings of every query and its hooks (the
  // file-tool guard) are every query's hooks. A failure fails that turn.
  pathDenials?: ((sessionTmp: string) => Promise<PathDenials>) | undefined;
  // Where the session's temporary folder is made (default: os.tmpdir()).
  tmp?: string | undefined;
  // Commands allowed past the permission check: one exact allowedTools rule
  // Bash(<command>) each, never a prefix rule, but in a smoke session (smokeMode), which gets the
  // one prefix rule SMOKE_PROBE_RULE instead. Only sf smoke's probe sets it (config.ts,
  // smokeProbeAllow); the sandbox holds the command as any other.
  allowCommands?: string[] | undefined;
  // sf smoke's session only (turns.ts sets it exactly when config.smokeProbeAllow is set):
  // permission mode dontAsk, without the auto mode classifier, so the probe reaches the sandbox,
  // with SMOKE_TOOLS allowed and, given allowCommands, the prefix rule SMOKE_PROBE_RULE in place of
  // the exact rules: the only session with a prefix rule, so the Implementer adding to the
  // probe's command line still reaches the sandbox. dontAsk also approves any Bash command the
  // sandbox runs and the allow rules of the settings loaded; the sandbox, the path denials and every
  // other option stay a real job's. Without it (every real job): auto, the classifier.
  smokeMode?: boolean | undefined;
  // How long a turn's stream may stay open after its result (default STREAM_GRACE_MS); tests shorten it.
  streamGraceMs?: number | undefined;
}

// After a turn's result, Claude Code ends its stream unless something keeps it alive (a background
// task, which SESSION_SHELL_ENV turns off): past this grace time the session ends the process,
// keeps the result and tells the streamStuck hook.
export const STREAM_GRACE_MS = 120_000;

// Claude Code's Bash tool in every Implementer session: no background task (run_in_background nor
// the move to the background of a command past its timeout; the guard refuses run_in_background
// too), a 20-minute default timeout and a 60-minute cap (a slow suite of a workspace, under load).
// A factory turn is synchronous: it waits for its commands.
export const SESSION_SHELL_ENV = { BASH_DEFAULT_TIMEOUT_MS: '1200000', BASH_MAX_TIMEOUT_MS: '3600000', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } as const;

// How long after a query's end its orphaned sandboxes are looked for: the query is aborted
// as it ends, and Claude Code's process, whose sandboxes are orphaned only once it has exited, may
// take that long.
const REAP_AFTER_QUERY_MS = 3_000;

// The settings every Claude session of a job passes on top of its own: no hook from a settings
// file (a .claude/settings.json a job could have written) runs. The hooks passed to query(), such
// as the file-tool guard, still do.
export const JOB_SESSION_SETTINGS = { disableAllHooks: true } as const;

// The tools of every Implementer session, the smoke's included: IMPLEMENTER_TOOLS only (its
// sub-agents inherit the session's tools), and no MCP server: strictMcpConfig with no mcpServers
// leaves out the user's claude.ai connectors, a project's .mcp.json and the plugins' servers.
export const IMPLEMENTER_SESSION_TOOLS = { tools: [...IMPLEMENTER_TOOLS], strictMcpConfig: true, mcpServers: {} };

// The file tools the smoke's ticket needs, allowed in its dontAsk session.
export const SMOKE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite'] as const;

// The smoke's sandbox probe script, in the root of its repository (live-smoke.ts).
export const PROBE_SCRIPT_NAME = 'probe.mjs';
// The allow rule of the probe in a smoke session: any `node probe.mjs …` call.
export const SMOKE_PROBE_RULE = `Bash(node ${PROBE_SCRIPT_NAME}:*)`;

// The permission mode of a session: dontAsk for the smoke's, auto for every other.
function sessionPermissionMode(smokeMode: boolean | undefined): 'auto' | 'dontAsk' {
  return smokeMode === true ? 'dontAsk' : 'auto';
}

// The allowedTools of a session's query(): none for a real job; in a smoke session
// SMOKE_PROBE_RULE when allowCommands is set, and SMOKE_TOOLS; else the exact Bash rules of
// allowCommands.
export function sessionAllowedTools(options: Pick<SessionOptions, 'allowCommands' | 'smokeMode'>): string[] {
  const commands = options.allowCommands ?? [];
  if (options.smokeMode === true) {
    return [...(commands.length > 0 ? [SMOKE_PROBE_RULE] : []), ...SMOKE_TOOLS];
  }
  return commands.map((command) => `Bash(${command})`);
}

interface Queued {
  prompt: string;
  disallowedTools: string[];
  // The image blocks sent after the prompt text; a continuation has none.
  images?: ImageRef[] | undefined;
  // Continuations sent before this prompt in its chain: 0 for a prompt sent, n for the nth continuation.
  continued: number;
}

// One tool call of the main thread of a turn, as the model made it.
export interface ToolCall {
  name: string;
  input: unknown;
}

// A turn that ended at maxTurns: its tool calls in order, the continuations its chain already
// had, and how many the chain may have (turnLimitContinues); one more runs only while
// continued < allowed.
export interface LimitedTurn {
  calls: ToolCall[];
  continued: number;
  allowed: number;
}

// The hook's answer: the continuation to send (taken only when allowed), or why the turn stops.
export type LimitAnswer = { prompt: string } | { stop: string };

export type IdleOutcome =
  | {
      ok: true;
      sessionId: string;
      // Text of the last assistant message of the last turn (or the result text).
      text: string;
      // Tool names of every denial since the driver was last idle.
      denials: string[];
      startedAt: string;
      result: SDKResultMessage;
    }
  | { ok: false; code: string; message: string; startedAt: string };

export interface SessionHooks {
  // Every SDK message, in order; awaited before the next one is handled.
  message(message: SDKMessage): Promise<void>;
  // A prompt is about to be sent as a turn; continued: as in Queued (0 starts a chain); images: the
  // image blocks that go with it, if any.
  prompt(prompt: string, continued: number, images?: ImageRef[]): Promise<void>;
  // A turn ended at maxTurns; without this hook it fails with max_turns as any failed turn.
  turnLimit?(turn: LimitedTurn): Promise<LimitAnswer>;
  // A turn's stream stayed open the grace time after its result (waitedS: that time in seconds); the
  // session then ends Claude Code and the turn finishes with the result.
  streamStuck?(waitedS: number): Promise<void>;
  // The queue is empty after one or more turns.
  idle(outcome: IdleOutcome): Promise<void>;
}

interface TurnResult {
  text: string;
  denials: string[];
  result: SDKResultMessage;
}

class TurnError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// The tool calls of an assistant message of the main thread (a subagent's are its own).
function toolCalls(message: SDKMessage): ToolCall[] {
  if (message.type !== 'assistant' || message.parent_tool_use_id !== null) {
    return [];
  }
  const content = message.message.content as unknown;
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((block): block is { type: 'tool_use'; name: string; input: unknown } => block?.type === 'tool_use' && typeof block.name === 'string')
    .map((block) => ({ name: block.name, input: block.input }));
}

// The SDK's max-turns error: a result with error_max_turns, or the error it throws after it.
const MAX_TURNS_TEXT = /maximum number of turns/i;

function assistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') {
    return '';
  }
  const content = message.message.content as unknown;
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block): block is { type: 'text'; text: string } => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// Ends the live session under key: taken out of the map, then closed, its temporary folder removed
// (a job handed over or pushed; a later message resumes it in a new session). Safe from the
// session's own idle hook (close()). No entry under key does nothing.
export async function endSession(live: Map<string, { session: ImplementerSession }>, key: string): Promise<void> {
  const ended = live.get(key);
  live.delete(key);
  await ended?.session.close();
}

// The temporary folders of sessions dropped without close() (a fallback: the hand-over and the push
// end theirs with endSession), removed once the session is collected; close() unregisters its own.
const droppedSessions = new FinalizationRegistry<string>((dir) => void removeSessionTmp(dir));

export class ImplementerSession {
  readonly #options: SessionOptions;
  readonly #hooks: SessionHooks;
  readonly #queue: Queued[] = [];
  #sessionId: string | undefined;
  #running = false;
  #closed = false;
  #abort: AbortController | undefined;
  // The tool calls of the turn running (or last run).
  #calls: ToolCall[] = [];
  #drained: Promise<void> = Promise.resolve();
  // The path denials, once the first turn has built them.
  #denials: PathDenials | undefined;
  // The session's own temporary folder (CLAUDE_CODE_TMPDIR of every query), made by its first turn
  // and kept for the session's life: removed when the session is closed, when it is dropped without
  // being closed (once collected, droppedSessions) or when its process exits.
  #tmp: string | undefined;

  constructor(options: SessionOptions, hooks: SessionHooks) {
    this.#options = options;
    this.#hooks = hooks;
    this.#sessionId = options.sessionId;
  }

  // The permission mode the session runs in and its init message must report.
  get permissionMode(): 'auto' | 'dontAsk' {
    return sessionPermissionMode(this.#options.smokeMode);
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  // True while a turn runs or prompts wait.
  get busy(): boolean {
    return this.#running;
  }

  // images: sent after the prompt text in the same user message; without any, the prompt
  // goes to query() as the string.
  send(prompt: string, disallowedTools: string[], images?: ImageRef[]): void {
    if (this.#closed) {
      throw new Error('The session is closed.');
    }
    this.#queue.push({ prompt, disallowedTools, continued: 0, ...(images !== undefined && images.length > 0 ? { images } : {}) });
    if (!this.#running) {
      this.#running = true;
      this.#drained = this.#drain();
    }
  }

  // The session's temporary folder, once its first turn has made it.
  get tmp(): string | undefined {
    return this.#tmp;
  }

  // Ends the session: queued prompts are dropped, a running turn is aborted, and no idle outcome
  // is reported. Resolves once the turn has stopped and the session's temporary folder is removed.
  // Safe from the session's own idle hook (the hand-over closes it there): no turn runs then, and
  // the drain, which waits for the hook, is not waited for.
  async close(): Promise<void> {
    this.#closed = true;
    this.#queue.length = 0;
    this.#abort?.abort();
    if (this.#running) {
      await this.#drained;
    }
    const tmp = this.#tmp;
    this.#tmp = undefined;
    droppedSessions.unregister(this);
    await removeSessionTmp(tmp);
  }

  async #drain(): Promise<void> {
    const startedAt = new Date().toISOString();
    const denials: string[] = [];
    let outcome: IdleOutcome | undefined;
    try {
      while (this.#queue.length > 0 && !this.#closed) {
        const next = this.#queue.shift()!;
        let turn: TurnResult;
        try {
          turn = await this.#turn(next);
        } catch (error) {
          if (!(error instanceof TurnError) || error.code !== 'max_turns') {
            throw error;
          }
          const continuation = await this.#continuation(next);
          if (typeof continuation === 'string') {
            throw new TurnError('max_turns', continuation);
          }
          if (continuation === undefined || this.#closed) {
            throw error;
          }
          this.#queue.unshift(continuation);
          continue;
        }
        denials.push(...turn.denials);
        outcome = { ok: true, sessionId: this.#sessionId!, text: turn.text, denials, startedAt, result: turn.result };
      }
    } catch (error) {
      // A failed turn drops the prompts still queued: the job needs a person now.
      this.#queue.length = 0;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      const code = error instanceof TurnError ? error.code : /sandbox/i.test(message) ? SANDBOX_UNAVAILABLE : 'session_failed';
      outcome = { ok: false, code, message, startedAt };
    }
    this.#running = false;
    if (this.#closed) {
      return;
    }
    try {
      await this.#hooks.idle(outcome!);
    } catch (error) {
      console.error(error);
    }
  }

  // After a turn that ended at maxTurns: the continuation of its chain, the hook's reason to stop,
  // or undefined without the hook (the SDK's error stands). Bounded here: never more than
  // turnLimitContinues continuations per chain, whatever the hook answers.
  async #continuation(turn: Queued): Promise<Queued | string | undefined> {
    if (this.#hooks.turnLimit === undefined) {
      return undefined;
    }
    const allowed = this.#options.turnLimitContinues ?? 0;
    const answer = await this.#hooks.turnLimit({ calls: [...this.#calls], continued: turn.continued, allowed });
    if ('stop' in answer) {
      return answer.stop;
    }
    return turn.continued < allowed ? { prompt: answer.prompt, disallowedTools: turn.disallowedTools, continued: turn.continued + 1 } : undefined;
  }

  // The Bash sandboxes the query's Claude Code left behind end once it has exited: looked
  // for REAP_AFTER_QUERY_MS after the query, under the factory's worktree root and state directory as
  // the environment names them. The timer holds neither the session nor its process: a runner that
  // exits sooner leaves them to sf serve's next look. Never throws.
  #reapAfterQuery(): void {
    setTimeout(() => {
      void (async () => {
        try {
          await reapOrphanedSandboxes(factoryRoots());
        } catch (error) {
          // factoryRoots refused the configuration (a relative SF_WORKTREE_ROOT): one line.
          console.error(`sandbox reaper: failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    }, REAP_AFTER_QUERY_MS).unref();
  }

  // The spawner of the wrapper for this turn's query, Claude Code's state folders made; undefined
  // without the sandbox (SF_SANDBOX=off). No bwrap on PATH fails the turn: nothing starts unwrapped.
  async #wrapper(denials: PathDenials | undefined, tmp: string): Promise<WrappedSpawn | undefined> {
    if (this.#options.sandbox === undefined) {
      return undefined;
    }
    // Loaded here: gate.ts imports review.ts, which imports this module.
    const { findBwrap } = await import('./gate.js');
    const bwrap = findBwrap();
    if (bwrap === undefined) {
      throw new TurnError(SANDBOX_UNAVAILABLE, BWRAP_MISSING);
    }
    const home = process.env.HOME || homedir();
    const claudeDir = claudeConfigDir(process.env, home);
    const globalConfig = claudeUserSettings(process.env, home)[1]!;
    await prepareClaudeState(claudeDir, globalConfig);
    return new WrappedSpawn(bwrap, denials?.sandbox ?? { denyRead: [], denyWrite: [] }, {
      worktree: this.#options.cwd, sessionTmp: tmp, home, claudeDir, globalConfig, skills: fileURLToPath(new URL('skills', PACKAGE_ROOT)),
    });
  }

  // A turn that failed before Claude Code answered (its result), with a wrapper that failed:
  // sandbox_unavailable with bwrap's own line; else undefined. Messages before the result (its
  // system/init among them) do not count: bwrap may still fail after them.
  async #wrapperFailure(wrapper: WrappedSpawn | undefined, resulted: boolean): Promise<TurnError | undefined> {
    const failure = wrapper === undefined || resulted ? undefined : await wrapper.failure();
    return failure === undefined ? undefined : new TurnError(SANDBOX_UNAVAILABLE, failure);
  }

  async #turn(next: Queued): Promise<TurnResult> {
    const { prompt, disallowedTools, images } = next;
    this.#calls = [];
    await this.#hooks.prompt(prompt, next.continued, images);
    // Closed while the hook ran (it reads the worktree): no turn starts.
    if (this.#closed) {
      throw new TurnError('closed', 'The session was closed before the turn started.');
    }
    // The session's temporary folder, before its path denials, which keep it.
    if (this.#tmp === undefined) {
      this.#tmp = await makeSessionTmp(this.#options.tmp);
      droppedSessions.register(this, this.#tmp, this);
    }
    if (this.#denials === undefined && this.#options.pathDenials !== undefined) {
      try {
        this.#denials = await this.#options.pathDenials(this.#tmp);
      } catch (error) {
        // A refusal with its own code (such as user_settings_weaken_sandbox) keeps it for the job.
        const code = (error as { code?: unknown }).code;
        throw new TurnError(typeof code === 'string' && /^[a-z][a-z_]*$/.test(code) ? code : 'session_failed', error instanceof Error ? error.message : String(error));
      }
      // Closed while they were built (an abort): no turn starts.
      if (this.#closed) {
        throw new TurnError('closed', 'The session was closed before the turn started.');
      }
    }
    const denials = this.#denials;
    const wrapper = await this.#wrapper(denials, this.#tmp);
    const environment = sessionEnvironment();
    const sandbox = withSandboxEnvDenials(withSandboxDenials(this.#options.sandbox, denials?.sandbox, denials?.claudeTmp), environment);
    const abortController = new AbortController();
    this.#abort = abortController;
    const input = await promptInput(prompt, images);
    const mode = this.permissionMode;
    const allowed = sessionAllowedTools(this.#options);
    const turn = query({
      prompt: input.prompt,
      options: {
        abortController,
        cwd: this.#options.cwd,
        permissionMode: mode,
        settingSources: ['user', 'project'],
        settings: { ...JOB_SESSION_SETTINGS },
        ...IMPLEMENTER_SESSION_TOOLS,
        disallowedTools: [...disallowedTools, ...(denials?.tools ?? [])],
        ...(allowed.length > 0 ? { allowedTools: allowed } : {}),
        maxTurns: this.#options.maxTurns,
        // A known startup failure (such as an unavailable sandbox) then ends with a result message.
        // Claude Code keeps its temporary files and sockets in the session's own folder.
        env: { ...environment, ...SESSION_SHELL_ENV, CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1', CLAUDE_CODE_TMPDIR: this.#tmp },
        ...(this.#sessionId !== undefined ? { resume: this.#sessionId } : {}),
        ...(sandbox !== undefined ? { sandbox } : {}),
        // The file-tool guard, in every permission mode.
        ...(denials?.hooks !== undefined ? { hooks: denials.hooks } : {}),
        ...(this.#options.model !== undefined ? { model: this.#options.model } : {}),
        ...(this.#options.claudePath !== undefined ? { pathToClaudeCodeExecutable: this.#options.claudePath } : {}),
        ...(wrapper !== undefined ? { spawnClaudeCodeProcess: wrapper.spawn } : {}),
      },
    });
    let text = '';
    let result: SDKResultMessage | undefined;
    // The safety net, started by the first result: a stream still open after the grace time is
    // stuck; the hook is told, then the process ended, and the turn finishes with its result.
    const graceMs = this.#options.streamGraceMs ?? STREAM_GRACE_MS;
    let grace: NodeJS.Timeout | undefined;
    let stuck = false;
    const endStuckStream = async (): Promise<void> => {
      if (!abortController.signal.aborted) {
        stuck = true;
        await this.#hooks.streamStuck?.(Math.ceil(graceMs / 1000)).catch((error: unknown) => console.error(error));
        abortController.abort();
      }
    };
    try {
      for await (const message of turn) {
        await this.#hooks.message(message);
        if (message.type === 'system' && message.subtype === 'init') {
          if (message.permissionMode !== mode) {
            throw new TurnError('permission_mode_mismatch', `The Implementer reported permission mode "${message.permissionMode}" instead of "${mode}".`);
          }
          this.#sessionId = message.session_id;
        }
        text = assistantText(message) || text;
        this.#calls.push(...toolCalls(message));
        if (message.type === 'result') {
          result = message;
          input.done();
          grace ??= setTimeout(() => void endStuckStream(), graceMs);
        }
      }
    } catch (error) {
      // The safety net ended a stuck stream after its result: the turn goes on with that result.
      if (stuck && result !== undefined) {
        return this.#finished(text, result);
      }
      // A failure of the wrapper before the result fails the turn as the sandbox's; the session's own
      // refusals (TurnError) and a turn it aborted (closed) stand as they are.
      const wrapped = error instanceof TurnError || abortController.signal.aborted ? undefined : await this.#wrapperFailure(wrapper, result !== undefined);
      if (wrapped !== undefined) {
        throw wrapped;
      }
      // The SDK throws after the CLI's error_max_turns result: the turn limit, not a failed session.
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof TurnError) && (result?.subtype === 'error_max_turns' || MAX_TURNS_TEXT.test(message))) {
        throw new TurnError('max_turns', `The turn ended with error_max_turns: ${message}`);
      }
      throw error;
    } finally {
      clearTimeout(grace);
      input.done();
      // Ends the child process when the turn stopped early (a mismatch or an error).
      abortController.abort();
      this.#reapAfterQuery();
    }
    if (result === undefined) {
      throw (await this.#wrapperFailure(wrapper, false)) ?? new TurnError('session_failed', 'The Implementer ended the turn without a result.');
    }
    return this.#finished(text, result);
  }

  // The turn's outcome from its result: a sandbox that was not available, a failed result or the
  // turn limit throw; a success gives its text (the last assistant text, else the result's).
  #finished(text: string, result: SDKResultMessage): TurnResult {
    if (result.subtype !== 'success' && result.startup_failure_reason === 'sandbox_required_unavailable') {
      throw new TurnError(SANDBOX_UNAVAILABLE, result.errors.join('; ') || 'The sandbox is not available.');
    }
    if (result.subtype !== 'success' || result.is_error) {
      const detail = result.subtype === 'success' ? result.result : result.errors.join('; ');
      throw new TurnError(result.subtype === 'error_max_turns' ? 'max_turns' : 'turn_failed', `The turn ended with ${result.subtype}: ${detail}`.trim());
    }
    return { text: text || result.result, denials: result.permission_denials.map((denial) => denial.tool_name), result };
  }
}
