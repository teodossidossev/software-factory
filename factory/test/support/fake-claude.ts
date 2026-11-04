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
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  // Review runs only: the errors of a result that is not a success (default: one fixed error).
  errors?: string[];
  // Review runs only: the structured output of the result (default: a clean verdict), or none.
  output?: unknown;
  noOutput?: boolean;
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

function run(prompt: string): void {
  appendFileSync(join(home, `${name}.log`), `${JSON.stringify({ argv, prompt, sessionId, cwd: process.cwd(), env: Object.keys(process.env).sort() })}\n`);
  if (review) {
    runReview();
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
  const text = turn.text ?? `Report for: ${prompt}`;
  out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const subtype = turn.subtype ?? 'success';
  out({
    type: 'result', subtype, is_error: subtype !== 'success', result: text, num_turns: 2, duration_ms: 1234,
    duration_api_ms: 1000, total_cost_usd: turn.costTotal ?? 0.0123, usage: {}, modelUsage: {}, stop_reason: null,
    errors: subtype === 'success' ? undefined : ['fake failure'],
    permission_denials: (turn.denials ?? []).map((name, index) => ({ tool_name: name, tool_use_id: `d${index}`, tool_input: { command: 'git commit -m secret-input' } })),
  });
}

// A review: init, a Read of README.md and its result, one assistant message, and the result with
// the structured output.
function runReview(): void {
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
  out({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] } });
  const subtype = turn.walk !== undefined ? 'error_during_execution' : (turn.subtype ?? 'success');
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
  const message = JSON.parse(line) as { type: string; request_id?: string; message?: { content: Array<{ text?: string }> } };
  if (message.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  } else if (message.type === 'user') {
    const prompt = (message.message?.content ?? []).map((part) => part.text ?? '').join('');
    setTimeout(() => run(prompt), turn.delayMs ?? 0);
  }
});
lines.on('close', () => setTimeout(() => process.exit(0), (turn.delayMs ?? 0) + 50));
