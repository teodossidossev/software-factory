// The Implementer session driver: one Claude Agent SDK query() per turn, the first creating the
// session, every later one resuming it. Turns are serialized; prompts sent while a turn runs are
// queued and run in order. When the queue is empty the driver reports the outcome of the turns
// since it was last idle. Each prompt carries its own deny list; the driver does not know why.
// It knows nothing about jobs, Git or MCP.
import { query, type SandboxSettings, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

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
const KEPT_NAMES = new Set(['PATH', 'HOME', 'LANG', 'LANGUAGE', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'SSH_AUTH_SOCK']);
const KEPT_PATTERN = /^(LC_\w+|XDG_\w+|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|ANTHROPIC_\w+|CLAUDE_\w+|AWS_\w+|GOOGLE_\w+|CLOUD_ML_\w+)$/;

// The child's environment: the basics, proxies and the Anthropic/Claude (and cloud provider) auth
// variables; nothing of the factory (SF_*) and no inherited Claude session markers.
export function sessionEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (KEPT_NAMES.has(name) || KEPT_PATTERN.test(name)) && !CLAUDE_SESSION_MARKERS.has(name)) {
      result[name] = value;
    }
  }
  return result;
}

export interface SessionOptions {
  cwd: string;
  maxTurns: number;
  claudePath: string | undefined;
  // An existing session to resume; undefined starts a new one with the first turn.
  sessionId?: string | undefined;
  // Claude Code's sandbox for every turn; undefined runs without it.
  sandbox?: SandboxSettings | undefined;
}

interface Queued {
  prompt: string;
  disallowedTools: string[];
}

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
  // A prompt is about to be sent as a turn.
  prompt(prompt: string): Promise<void>;
  // The queue is empty after one or more turns.
  idle(outcome: IdleOutcome): Promise<void>;
}

class TurnError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

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
  #drained: Promise<void> = Promise.resolve();

  constructor(options: SessionOptions, hooks: SessionHooks) {
    this.#options = options;
    this.#hooks = hooks;
    this.#sessionId = options.sessionId;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  // True while a turn runs or prompts wait.
  get busy(): boolean {
    return this.#running;
  }

  send(prompt: string, disallowedTools: string[]): void {
    if (this.#closed) {
      throw new Error('The session is closed.');
    }
    this.#queue.push({ prompt, disallowedTools });
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
      while (this.#queue.length > 0) {
        const next = this.#queue.shift()!;
        const turn = await this.#turn(next.prompt, next.disallowedTools);
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

  async #turn(prompt: string, disallowedTools: string[]): Promise<{ text: string; denials: string[]; result: SDKResultMessage }> {
    await this.#hooks.prompt(prompt);
    const abortController = new AbortController();
    this.#abort = abortController;
    const turn = query({
      prompt,
      options: {
        abortController,
        cwd: this.#options.cwd,
        permissionMode: 'auto',
        settingSources: ['user', 'project'],
        disallowedTools,
        maxTurns: this.#options.maxTurns,
        // A known startup failure (such as an unavailable sandbox) then ends with a result message.
        env: { ...sessionEnvironment(), CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' },
        ...(this.#sessionId !== undefined ? { resume: this.#sessionId } : {}),
        ...(this.#options.sandbox !== undefined ? { sandbox: this.#options.sandbox } : {}),
        ...(this.#options.claudePath !== undefined ? { pathToClaudeCodeExecutable: this.#options.claudePath } : {}),
      },
    });
    let text = '';
    let result: SDKResultMessage | undefined;
    try {
      for await (const message of turn) {
        await this.#hooks.message(message);
        if (message.type === 'system' && message.subtype === 'init') {
          if (message.permissionMode !== 'auto') {
            throw new TurnError('permission_mode_mismatch', `The Implementer reported permission mode "${message.permissionMode}" instead of "auto".`);
          }
          this.#sessionId = message.session_id;
        }
        text = assistantText(message) || text;
        if (message.type === 'result') {
          result = message;
        }
      }
    } finally {
      // Ends the child process when the turn stopped early (a mismatch or an error).
      abortController.abort();
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
