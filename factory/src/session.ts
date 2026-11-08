// The Implementer session driver: one Claude Agent SDK query() per turn, the first creating the
// session, every later one resuming it. Turns are serialized; prompts sent while a turn runs are
// queued and run in order. When the queue is empty the driver reports the outcome of the turns
// since it was last idle. Each prompt carries its own deny list; the driver does not know why.
// It knows nothing about jobs, Git or MCP.
// A turn that ends at maxTurns (SF-069) is put to the turnLimit hook: it answers with a
// continuation, which runs next in the same session with the same deny list, or with the reason
// the turn stops. Every prompt sent starts a chain; the driver sends at most turnLimitContinues
// continuations per chain, whatever the hook answers.
import { query, type SandboxSettings, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { type ImageRef, promptInput } from './attachments.js';
import { type PathDenials, withSandboxDenials } from './sandbox-denials.js';
import { factoryRoots, reapOrphanedSandboxes } from './sandbox-reaper.js';

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
// No SSH_AUTH_SOCK (SF-100): the factory fetches and pushes itself, outside the sandbox, so no
// session needs the user's SSH agent.
const KEPT_NAMES = new Set(['PATH', 'HOME', 'LANG', 'LANGUAGE', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ']);
const KEPT_PATTERN = /^(LC_\w+|XDG_\w+|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|ANTHROPIC_\w+|CLAUDE_\w+)$/;
// The cloud providers' credentials (SF-123): passed only when Claude Code itself runs on Bedrock or
// Vertex, whose provider needs them; a workspace never does.
const CLOUD_PATTERN = /^(AWS_\w+|GOOGLE_\w+|CLOUD_ML_\w+)$/;
const CLOUD_PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];
// A provider switch is on unless it is unset or plainly off; an unknown value counts as on, so a
// Bedrock or Vertex setup never loses its credentials.
const switchOn = (value: string | undefined): boolean => value !== undefined && !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
// The passed variables sandboxed commands never see (SF-123): the Anthropic and cloud credentials
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
  // Claude Code's sandbox for every turn; undefined runs without it.
  sandbox?: SandboxSettings | undefined;
  // The model option of query(); undefined leaves the user's Claude Code default.
  model?: string | undefined;
  // Continuations after a turn limit per chain (SF_TURN_LIMIT_CONTINUES); default 0.
  turnLimitContinues?: number | undefined;
  // Builds the session's path denials (SF-100, src/sandbox-denials.ts): called once, by the first
  // turn before its query(); its tools go on top of every prompt's deny list, its sandbox lists
  // into the sandbox settings of every query and its hooks (the file-tool guard, SF-123) are every
  // query's hooks. A failure fails that turn.
  pathDenials?: (() => Promise<PathDenials>) | undefined;
  // Commands allowed past the permission check (SF-104): one exact allowedTools rule
  // Bash(<command>) each, never a prefix rule, but in a smoke session (smokeMode), which gets the
  // one prefix rule SMOKE_PROBE_RULE instead (SF-110). Only sf smoke's probe sets it (config.ts,
  // smokeProbeAllow); the sandbox holds the command as any other.
  allowCommands?: string[] | undefined;
  // sf smoke's session only (SF-109; turns.ts sets it exactly when config.smokeProbeAllow is set):
  // permission mode dontAsk, without the auto mode classifier, so the probe reaches the sandbox,
  // with SMOKE_TOOLS allowed and, given allowCommands, the prefix rule SMOKE_PROBE_RULE in place of
  // the exact rules (SF-110): the only session with a prefix rule, so the Implementer adding to the
  // probe's command line still reaches the sandbox. dontAsk also approves any Bash command the
  // sandbox runs and the allow rules of the settings loaded; the sandbox, the path denials and every
  // other option stay a real job's. Without it (every real job): auto, the classifier.
  smokeMode?: boolean | undefined;
}

// How long after a query's end its orphaned sandboxes are looked for (SF-141): the query is aborted
// as it ends, and Claude Code's process, whose sandboxes are orphaned only once it has exited, may
// take that long.
const REAP_AFTER_QUERY_MS = 3_000;

// The file tools the smoke's ticket needs (SF-109), allowed in its dontAsk session.
export const SMOKE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite'] as const;

// The smoke's sandbox probe script (SF-100), in the root of its repository (live-smoke.ts).
export const PROBE_SCRIPT_NAME = 'probe.mjs';
// The allow rule of the probe in a smoke session (SF-110): any `node probe.mjs …` call.
export const SMOKE_PROBE_RULE = `Bash(node ${PROBE_SCRIPT_NAME}:*)`;

// The permission mode of a session (SF-109): dontAsk for the smoke's, auto for every other.
function sessionPermissionMode(smokeMode: boolean | undefined): 'auto' | 'dontAsk' {
  return smokeMode === true ? 'dontAsk' : 'auto';
}

// The allowedTools of a session's query(): none for a real job; in a smoke session
// SMOKE_PROBE_RULE when allowCommands is set (SF-110), and SMOKE_TOOLS; else the exact Bash rules of
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
  // The image blocks sent after the prompt text (SF-065); a continuation has none.
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

  constructor(options: SessionOptions, hooks: SessionHooks) {
    this.#options = options;
    this.#hooks = hooks;
    this.#sessionId = options.sessionId;
  }

  // The permission mode the session runs in and its init message must report (SF-109).
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

  // images: sent after the prompt text in the same user message (SF-065); without any, the prompt
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

  // Ends the session: queued prompts are dropped, a running turn is aborted, and no idle outcome
  // is reported. Resolves once the turn has stopped.
  async close(): Promise<void> {
    this.#closed = true;
    this.#queue.length = 0;
    this.#abort?.abort();
    await this.#drained;
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
      const code = error instanceof TurnError ? error.code : /sandbox/i.test(message) ? 'sandbox_unavailable' : 'session_failed';
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

  // The Bash sandboxes the query's Claude Code left behind (SF-141) end once it has exited: looked
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

  async #turn(next: Queued): Promise<TurnResult> {
    const { prompt, disallowedTools, images } = next;
    this.#calls = [];
    await this.#hooks.prompt(prompt, next.continued, images);
    // Closed while the hook ran (it reads the worktree, SF-069): no turn starts.
    if (this.#closed) {
      throw new TurnError('closed', 'The session was closed before the turn started.');
    }
    if (this.#denials === undefined && this.#options.pathDenials !== undefined) {
      try {
        this.#denials = await this.#options.pathDenials();
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
    const environment = sessionEnvironment();
    const sandbox = withSandboxEnvDenials(withSandboxDenials(this.#options.sandbox, denials?.sandbox), environment);
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
        disallowedTools: [...disallowedTools, ...(denials?.tools ?? [])],
        ...(allowed.length > 0 ? { allowedTools: allowed } : {}),
        maxTurns: this.#options.maxTurns,
        // A known startup failure (such as an unavailable sandbox) then ends with a result message.
        env: { ...environment, CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' },
        ...(this.#sessionId !== undefined ? { resume: this.#sessionId } : {}),
        ...(sandbox !== undefined ? { sandbox } : {}),
        // The file-tool guard (SF-123), in every permission mode.
        ...(denials?.hooks !== undefined ? { hooks: denials.hooks } : {}),
        ...(this.#options.model !== undefined ? { model: this.#options.model } : {}),
        ...(this.#options.claudePath !== undefined ? { pathToClaudeCodeExecutable: this.#options.claudePath } : {}),
      },
    });
    let text = '';
    let result: SDKResultMessage | undefined;
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
        }
      }
    } catch (error) {
      // The SDK throws after the CLI's error_max_turns result: the turn limit, not a failed session.
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof TurnError) && (result?.subtype === 'error_max_turns' || MAX_TURNS_TEXT.test(message))) {
        throw new TurnError('max_turns', `The turn ended with error_max_turns: ${message}`);
      }
      throw error;
    } finally {
      input.done();
      // Ends the child process when the turn stopped early (a mismatch or an error).
      abortController.abort();
      this.#reapAfterQuery();
    }
    if (result === undefined) {
      throw new TurnError('session_failed', 'The Implementer ended the turn without a result.');
    }
    if (result.subtype !== 'success' && result.startup_failure_reason === 'sandbox_required_unavailable') {
      throw new TurnError('sandbox_unavailable', result.errors.join('; ') || 'The sandbox is not available.');
    }
    if (result.subtype !== 'success' || result.is_error) {
      const detail = result.subtype === 'success' ? result.result : result.errors.join('; ');
      throw new TurnError(result.subtype === 'error_max_turns' ? 'max_turns' : 'turn_failed', `The turn ended with ${result.subtype}: ${detail}`.trim());
    }
    return { text: text || result.result, denials: result.permission_denials.map((denial) => denial.tool_name), result };
  }
}
