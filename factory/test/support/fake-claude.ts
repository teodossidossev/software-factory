// A fake Claude Code for tests: speaks enough of the SDK's stream-json protocol for query().
// It answers control requests, and for the user message emits system/init (a new session id, or
// the --resume one), an assistant message, optionally a tool_use and its tool_result, and a
// result. Each run takes the next turn script from $HOME/fake-claude.json ({"turns": [...]},
// consumed in order through $HOME/fake-claude.count) and logs argv, prompt and environment
// names to $HOME/fake-claude.log. A turn can write files into cwd to produce a Patch, then run a
// list of argv commands in cwd (to stage, commit and rebase like the Implementer would), or end
// with a startup failure. Sandbox arguments are logged with argv and otherwise ignored.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  // Ends the turn with Claude Code's startup failure result (startup_failure_reason) and this message.
  startupFailure?: string;
}

const home = process.env.HOME ?? '.';
const controlPath = join(home, 'fake-claude.json');
const countPath = join(home, 'fake-claude.count');
const turns: Turn[] = existsSync(controlPath) ? (JSON.parse(readFileSync(controlPath, 'utf8')) as { turns: Turn[] }).turns : [];
const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0;
writeFileSync(countPath, String(count + 1));
const turn: Turn = turns[count] ?? {};

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline !== undefined) {
    return inline.slice(name.length + 3);
  }
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const sessionId = option('resume') ?? randomUUID();
const out = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ session_id: sessionId, uuid: randomUUID(), ...message })}\n`);
};

function run(prompt: string): void {
  appendFileSync(join(home, 'fake-claude.log'), `${JSON.stringify({ argv, prompt, sessionId, cwd: process.cwd(), env: Object.keys(process.env).sort() })}\n`);
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
