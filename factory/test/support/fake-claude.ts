// A fake Claude Code for tests: speaks enough of the SDK's stream-json protocol for query().
// It answers control requests, and for the user message emits system/init (a new session id, or
// the --resume one), an assistant message, optionally a tool_use and its tool_result, and a
// result. Each run takes the next turn script from $HOME/fake-claude.json ({"turns": [...]},
// consumed in order through $HOME/fake-claude.count) and logs argv, prompt and environment
// names to $HOME/fake-claude.log. A turn can write files into cwd to produce a Patch, then run a
// list of argv commands in cwd (to delete files or run Git where a test needs it), or end
// with a startup failure. A turn can also leave sandbox placeholders behind, like bubblewrap does. Sandbox arguments are logged with argv and otherwise ignored.
// A run with --json-schema is a review (SF-038): its script comes from $HOME/fake-review.json
// ({"reviews": [...]}, consumed through $HOME/fake-review.count) and it logs to
// $HOME/fake-review.log, so the Implementer's script and log stay as they are. A review entry gives
// the structured output, or a subtype or noOutput to fail, and an optional delay. Like the real CLI,
// it refuses a --json-schema whose $schema is not draft-07 (SF-044): exit 1 before anything else.
// A review entry's probes (the Task check, SF-054) are Read, Grep and Glob calls made after the
// init: each is first put to the SDK's PreToolUse hooks (registered at initialize) through the
// hook_callback control request, as the real CLI does; a denied one gets an error result, an
// allowed one runs here on the real files (without honouring any ignore file: the worst case). Each
// probe, its decision and its output go to $HOME/fake-probe.log. When hooks are registered, the
// structured output is then given, as the real CLI gives it, by a StructuredOutput tool call put to
// the hooks first (SF-070) and logged the same way; a denied one ends the run with the CLI's
// error_max_structured_output_retries result, its error naming the hook's reason.
// An Implementer turn can make a list of tool calls (each a tool_use and its tool_result) and can
// end like the real CLI at its turn limit (SF-069): the error_max_turns result with the CLI's
// error text, then exit code 1, on which the SDK throws "Claude Code returned an error result".
// A user message with a block that is not text (the images of SF-065) is logged with its blocks too:
// each text block's text, each image block's media type, size and sha256 (never its bytes).
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { matchesGlob } from '../../src/rules.js';
import { createInterface } from 'node:readline';

interface Turn {
  text?: string;
  write?: Record<string, string>;
  tool?: boolean;
  delayMs?: number;
  permissionMode?: string;
  denials?: string[];
  subtype?: string;
  // The SDK's cumulative session cost reported in the result; default 0.0123.
  costTotal?: number;
  // argv lists run in cwd after the writes, without a shell; a failing command fails the test turn.
  run?: string[][];
  // Created after run, like the sandbox's mount points: a path ending in "/" as an empty
  // directory with mode 0700, any other as a zero-byte file with mode 0444.
  placeholders?: string[];
  // Ends the turn with Claude Code's startup failure result (startup_failure_reason) and this message.
  startupFailure?: string;
  // Review runs only (SF-045): says the values of ANTHROPIC_FAKE_SECRET and ANTHROPIC_FAKE_PIN, quotes
  // ~/.codex/config.toml, reads ~/.codex/auth.json, then repeats it without naming it.
  leak?: boolean;
  // Review runs only (SF-045): after a Read of ~/.codex/auth.json, every message type with this
  // literal in each free-text field, ending in a failed result whose errors hold it.
  walk?: string;
  // The errors of a result that is not a success (default: one fixed error); for an Implementer turn
  // too (SF-072: a usage limit's message).
  errors?: string[];
  // Review runs only: the structured output of the result (default: a clean verdict), or none.
  output?: unknown;
  // Review runs only (SF-054): tool calls put to the PreToolUse hooks, then run when allowed.
  probes?: Array<{ tool: string; input: Record<string, unknown> }>;
  noOutput?: boolean;
  // Implementer runs only (SF-069): tool calls made after the writes, each with a tool_result.
  calls?: Array<{ tool: string; input: Record<string, unknown> }>;
  // Implementer runs only (SF-069): the turn ends at the turn limit (--max-turns) instead of a success.
  maxTurns?: boolean;
}

const CLEAN = { verdict: 'clean', summary: 'Looks right.', items: [], accepted_sensitive: [] };

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline !== undefined) {
    return inline.slice(name.length + 3);
  }
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

// The CLI's validator knows the draft-07 meta-schema only; any other $schema is refused at start.
const DRAFT_07 = ['http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-07/schema'];
const schema = option('json-schema');
if (schema !== undefined) {
  const declared: unknown = (JSON.parse(schema) as { $schema?: unknown }).$schema;
  if (declared !== undefined && !DRAFT_07.includes(String(declared))) {
    process.stderr.write(`Error: --json-schema is not a valid JSON Schema: no schema with key or ref "${String(declared)}"\n`);
    process.exit(1);
  }
}

const home = process.env.HOME ?? '.';
const review = schema !== undefined;
const name = review ? 'fake-review' : 'fake-claude';
const controlPath = join(home, `${name}.json`);
const countPath = join(home, `${name}.count`);
const control = existsSync(controlPath) ? (JSON.parse(readFileSync(controlPath, 'utf8')) as { turns?: Turn[]; reviews?: Turn[] }) : {};
const turns: Turn[] = (review ? control.reviews : control.turns) ?? [];
const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0;
writeFileSync(countPath, String(count + 1));
const turn: Turn = turns[count] ?? {};
const sessionId = option('resume') ?? randomUUID();
const out = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ session_id: sessionId, uuid: randomUUID(), ...message })}\n`);
};

// The PreToolUse hook callbacks the SDK registered at initialize, and the answers awaited from it.
let preToolUseHooks: string[] = [];
const awaiting = new Map<string, (response: Record<string, unknown>) => void>();
let requests = 0;

function askHook(callbackId: string, tool: string, input: Record<string, unknown>, toolUseId: string): Promise<Record<string, unknown>> {
  const requestId = `fake-hook-${(requests += 1)}`;
  return new Promise((done) => {
    awaiting.set(requestId, done);
    out({
      type: 'control_request', request_id: requestId,
      request: {
        subtype: 'hook_callback', callback_id: callbackId, tool_use_id: toolUseId,
        input: { hook_event_name: 'PreToolUse', session_id: sessionId, transcript_path: '', cwd: process.cwd(), tool_name: tool, tool_input: input, tool_use_id: toolUseId },
      },
    });
  });
}

// Every regular file under dir, symlinks not followed, .git skipped.
function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((path) => !relative(dir, path).split('/').includes('.git'));
  } catch {
    return [];
  }
}

// Brace alternatives, innermost group first ("{/a/**,b}" -> /a/**, b).
function expandBraces(pattern: string): string[] {
  const group = /\{([^{}]*)\}/.exec(pattern);
  if (group === null) {
    return [pattern];
  }
  return group[1]!.split(',').flatMap((part) => expandBraces(pattern.slice(0, group.index) + part + pattern.slice(group.index + group[0].length)));
}

// Runs an allowed probe on the real files: Read the file, Grep lines with the pattern, Glob paths.
// Paths are taken as Claude Code takes them: trimmed, ~ and ~/ expanded to the home, and Grep's
// file_path standing in for path.
function runProbe(tool: string, input: Record<string, unknown>): string {
  const cwd = process.cwd();
  const at = (value: unknown): string => {
    const path = typeof value === 'string' ? value.trim() : '';
    return path === '' ? cwd : path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : resolve(cwd, path);
  };
  if (tool === 'Grep' && input.path === undefined && input.file_path !== undefined) {
    input = { ...input, path: input.file_path };
  }
  try {
    if (tool === 'Read') {
      return readFileSync(at(input.file_path), 'utf8');
    }
    if (tool === 'Grep') {
      const pattern = String(input.pattern);
      return filesUnder(at(input.path)).flatMap((file) => readFileSync(file, 'utf8').split('\n').map((line, index) => [line, index] as const)
        .filter(([line]) => line.includes(pattern)).map(([line, index]) => `${file}:${index + 1}:${line}`)).join('\n');
    }
    // Each brace alternative on its own, an absolute one from its own root: the widest reading.
    const base = at(input.path);
    return expandBraces(String(input.pattern)).flatMap((pattern) => filesUnder(isAbsolute(pattern) ? '/' + pattern.split('/').filter((part) => part !== '' && !/[*?[\]{}]/.test(part)).join('/') : base)
      .filter((file) => matchesGlob(isAbsolute(pattern) ? file : relative(base, file), pattern))).join('\n');
  } catch (error) {
    return `error: ${(error as Error).message}`;
  }
}

// One tool call put to the hooks first, like the real CLI: the tool_use, each hook in turn until one
// denies, the call's output (the denial's reason, or run(), when allowed), logged to fake-probe.log,
// and its tool_result. Returns the reason of a denial, or undefined when every hook let it through.
async function hookedCall(id: string, tool: string, input: Record<string, unknown>, run: () => string): Promise<string | undefined> {
  out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] } });
  let reason: string | undefined;
  for (const callbackId of preToolUseHooks) {
    const answer = await askHook(callbackId, tool, input, id);
    const specific = answer.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined;
    if (specific?.permissionDecision === 'deny') {
      reason = specific.permissionDecisionReason ?? '';
      break;
    }
  }
  const output = reason ?? run();
  appendFileSync(join(home, 'fake-probe.log'), `${JSON.stringify({ tool, input, decision: reason === undefined ? 'allow' : 'deny', output, hooks: preToolUseHooks.length })}\n`);
  out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: reason !== undefined, content: output }] } });
  return reason;
}

// The probes of a review run, each through the hooks first.
async function runProbes(probes: Array<{ tool: string; input: Record<string, unknown> }>): Promise<void> {
  for (const [index, probe] of probes.entries()) {
    await hookedCall(`p${index}`, probe.tool, probe.input, () => runProbe(probe.tool, probe.input));
  }
}

// The structured output as a StructuredOutput tool call, through the hooks first like a probe.
// Returns the reason of a denial, or undefined when every hook let it through.
function giveStructuredOutput(output: unknown): Promise<string | undefined> {
  return hookedCall('so1', 'StructuredOutput', output as Record<string, unknown>, () => 'Structured output provided successfully');
}

// What the log keeps of a user message's blocks.
type LoggedBlock = { type: 'text'; text: string } | { type: 'image'; media_type: string; bytes: number; sha256: string } | { type: string };

function run(prompt: string, blocks?: LoggedBlock[]): void {
  appendFileSync(join(home, `${name}.log`), `${JSON.stringify({ argv, prompt, sessionId, cwd: process.cwd(), env: Object.keys(process.env).sort(), ...(blocks !== undefined ? { blocks } : {}) })}\n`);
  if (review) {
    void runReview();
    return;
  }
  if (turn.startupFailure !== undefined) {
    out({
      type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, duration_ms: 0, duration_api_ms: 0,
      total_cost_usd: 0, usage: {}, modelUsage: {}, stop_reason: null, permission_denials: [], errors: [turn.startupFailure],
      startup_failure_reason: 'sandbox_required_unavailable',
    });
    return;
  }
  out({
    type: 'system', subtype: 'init', permissionMode: turn.permissionMode ?? option('permission-mode') ?? 'default',
    cwd: process.cwd(), tools: [], mcp_servers: [], model: 'fake-model', slash_commands: [], output_style: 'default',
    skills: [], plugins: [], apiKeySource: 'none', claude_code_version: '0.0.0-fake',
  });
  for (const [path, content] of Object.entries(turn.write ?? {})) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  for (const [command, ...args] of turn.run ?? []) {
    execFileSync(command!, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  for (const path of turn.placeholders ?? []) {
    if (path.endsWith('/')) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '');
      chmodSync(path, 0o444);
    }
  }
  if (turn.tool === true) {
    out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } });
    out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok 1 tests\npassed' }] } });
  }
  for (const [index, call] of (turn.calls ?? []).entries()) {
    out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: `c${index}`, name: call.tool, input: call.input }] } });
    out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${index}`, is_error: false, content: 'done' }] } });
  }
  if (turn.maxTurns === true) {
    const limit = option('max-turns') ?? '?';
    out({
      type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: Number(limit), duration_ms: 1234, duration_api_ms: 1000,
      total_cost_usd: turn.costTotal ?? 0.0123, usage: {}, modelUsage: {}, stop_reason: null, permission_denials: [],
      errors: [`Reached maximum number of turns (${limit})`],
    });
    setTimeout(() => process.exit(1), 20);
    return;
  }
  const text = turn.text ?? `Report for: ${prompt}`;
  out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const subtype = turn.subtype ?? 'success';
  out({
    type: 'result', subtype, is_error: subtype !== 'success', result: text, num_turns: 2, duration_ms: 1234,
    duration_api_ms: 1000, total_cost_usd: turn.costTotal ?? 0.0123, usage: {}, modelUsage: {}, stop_reason: null,
    errors: subtype === 'success' ? undefined : (turn.errors ?? ['fake failure']),
    permission_denials: (turn.denials ?? []).map((name, index) => ({ tool_name: name, tool_use_id: `d${index}`, tool_input: { command: 'git commit -m secret-input' } })),
  });
}

// A review: init, a Read of README.md and its result, one assistant message, and the result with
// the structured output.
async function runReview(): Promise<void> {
  out({
    type: 'system', subtype: 'init', permissionMode: option('permission-mode') ?? 'default', cwd: process.cwd(), tools: [], mcp_servers: [],
    model: 'fake-model', slash_commands: [], output_style: 'default', skills: [], plugins: [], apiKeySource: 'none', claude_code_version: '0.0.0-fake',
  });
  out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'README.md' } }] } });
  out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', is_error: false, content: 'the file' }] } });
  if (turn.leak === true) {
    const say = (text: string): void => out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });
    say(`The secret is ${process.env.ANTHROPIC_FAKE_SECRET ?? ''}, the pin ${process.env.ANTHROPIC_FAKE_PIN ?? ''}.`);
    say(`${join(home, '.codex', 'config.toml')}: model = "fake-codex-config-model"`);
    out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: join(home, '.codex', 'auth.json') } }] } });
    out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r2', is_error: false, content: '{"auth_mode": "chatgpt", "last_refresh": "fake-codex-auth-file-content"}' }] } });
    say('The auth file says fake-codex-auth-repeated.');
  }
  if (turn.walk !== undefined) {
    const literal = turn.walk;
    const assistant = (...content: unknown[]): void => out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content } });
    const user = (extra: Record<string, unknown>, ...content: unknown[]): void => out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content }, ...extra });
    assistant({ type: 'tool_use', id: 'w0', name: 'Read', input: { file_path: join(home, '.codex', 'auth.json') } });
    user({}, { type: 'tool_result', tool_use_id: 'w0', is_error: false, content: '{}' });
    assistant(
      { type: 'text', text: literal }, { type: 'thinking', thinking: literal, signature: 'sig' },
      { type: 'tool_use', id: 'w1', name: 'Grep', input: { pattern: literal, path: 'src' } }, { type: 'tool_use', id: 'w2', name: 'Read', input: { file_path: literal } },
    );
    user({ tool_use_result: { content: literal } }, { type: 'tool_result', tool_use_id: 'w1', is_error: false, content: literal }, { type: 'tool_result', tool_use_id: 'w2', is_error: true, content: [{ type: 'text', text: literal }] });
    out({ type: 'system', subtype: 'notification', text: literal });
  }
  await runProbes(turn.probes ?? []);
  out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] } });
  const subtype = turn.walk !== undefined ? 'error_during_execution' : (turn.subtype ?? 'success');
  if (subtype === 'success' && turn.noOutput !== true && preToolUseHooks.length > 0) {
    const reason = await giveStructuredOutput(turn.output ?? CLEAN);
    if (reason !== undefined) {
      out({
        type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, result: '', num_turns: 3, duration_ms: 2345, duration_api_ms: 2000,
        total_cost_usd: turn.costTotal ?? 0.0456, usage: {}, modelUsage: {}, stop_reason: null, permission_denials: [],
        errors: [`Failed to provide valid structured output after 5 attempts — last StructuredOutput error: PreToolUse:StructuredOutput hook error: ${reason}`],
      });
      return;
    }
  }
  out({
    type: 'result', subtype, is_error: subtype !== 'success', result: '', num_turns: 3, duration_ms: 2345, duration_api_ms: 2000,
    total_cost_usd: turn.costTotal ?? 0.0456, usage: {}, modelUsage: {}, stop_reason: null, permission_denials: [],
    errors: subtype === 'success' ? undefined : (turn.walk !== undefined ? [turn.walk] : (turn.errors ?? ['fake review failure'])),
    ...(turn.walk !== undefined ? { result: turn.walk } : {}),
    ...(turn.noOutput === true || subtype !== 'success' ? {} : { structured_output: turn.output ?? CLEAN }),
  });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line) as {
    type: string; request_id?: string; message?: { content: Array<{ type?: string; text?: string; source?: { media_type?: string; data?: string } }> };
    request?: { subtype?: string; hooks?: { PreToolUse?: Array<{ hookCallbackIds?: string[] }> } };
    response?: { request_id?: string; response?: Record<string, unknown> };
  };
  if (message.type === 'control_response') {
    const done = awaiting.get(message.response?.request_id ?? '');
    awaiting.delete(message.response?.request_id ?? '');
    done?.(message.response?.response ?? {});
  } else if (message.type === 'control_request') {
    if (message.request?.subtype === 'initialize') {
      preToolUseHooks = (message.request.hooks?.PreToolUse ?? []).flatMap((matcher) => matcher.hookCallbackIds ?? []);
    }
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  } else if (message.type === 'user') {
    const content = message.message?.content ?? [];
    const prompt = content.map((part) => part.text ?? '').join('');
    const blocks = content.some((part) => part.type !== 'text')
      ? content.map((part): LoggedBlock => {
        if (part.type === 'text') {
          return { type: 'text', text: part.text ?? '' };
        }
        if (part.type === 'image') {
          const data = Buffer.from(part.source?.data ?? '', 'base64');
          return { type: 'image', media_type: part.source?.media_type ?? '', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
        }
        return { type: String(part.type) };
      })
      : undefined;
    setTimeout(() => run(prompt, blocks), turn.delayMs ?? 0);
  }
});
lines.on('close', () => setTimeout(() => process.exit(0), (turn.delayMs ?? 0) + 50));
