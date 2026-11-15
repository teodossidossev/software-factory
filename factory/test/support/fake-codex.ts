// A fake Codex CLI for the gate tests (SF-039), run through the wrapper script the harness writes
// (fakeCodex). `--version` prints a version, `login status` that it is logged in. `exec` logs argv, cwd, the stdin prompt, the
// environment names and its pid to $HOME/fake-codex.log, takes its run script from
// $HOME/fake-codex.json ({"runs": [...]}, consumed in order through $HOME/fake-codex.count), and
// then writes the run's output (default: a clean verdict) to the --output-last-message file and
// prints JSONL events (a reasoning item, a command started and completed, lines that are not JSON objects,
// an agent message, optionally one above the 16 KiB bound of SF-045) ending in turn.completed with
// a usage, or simulates a failure: an exit code, no output, an invalid output, an error event, a
// delay (for timeouts and aborts). A run can write a file as it starts and wait for one the test
// creates (startFile, waitFile). Each --image file (SF-065) is logged by its path and the sha256
// of its bytes when the run starts ("missing" when it cannot be read).
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Run {
  // The JSON written to the output file; default a clean verdict.
  output?: unknown;
  // Writes no output file.
  noOutput?: boolean;
  // Writes text that is not JSON to the output file.
  invalid?: boolean;
  // Exits with this code after the events, and prints a line on stderr.
  exitCode?: number;
  // Prints an error event with this message.
  error?: string;
  // Waits this long before answering.
  delayMs?: number;
  // A file under HOME written as the run starts, and one the run waits for (after delayMs) before it
  // answers: the test sees the run started and lets it end once what it waits on happened.
  startFile?: string;
  waitFile?: string;
  // Prints an agent message of this many bytes before the last one (to be cut at its bound).
  bigMessageBytes?: number;
  // Leaks (SF-045): says the values of OPENAI_FAKE_SECRET and OPENAI_FAKE_PIN (SF-125: the gate gets
  // OPENAI_* and CODEX_* variables, not ANTHROPIC_*), quotes ~/.codex/config.toml,
  // cats ~/.co*/auth.json, runs /usr/bin/env, then repeats the auth file without naming it.
  leak?: boolean;
  // After cat ~/.codex/auth.json, prints every event type with this literal in each free-text field,
  // ending in an error and a failed turn (SF-045).
  walk?: string;
  // The usage of turn.completed; default 1000 input (200 cached) and 100 output tokens.
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
}

const CLEAN = { verdict: 'clean', summary: 'Codex found it right.', items: [], accepted_sensitive: [] };

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('codex-cli 0.0.0-fake\n');
  process.exit(0);
}
// The health checks' login status (SF-153): logged in, like the real `codex login status`; nothing
// is logged and no run is taken.
if (argv[0] === 'login' && argv[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT (fake)\n');
  process.exit(0);
}
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const home = process.env.HOME ?? '.';
const controlPath = join(home, 'fake-codex.json');
const countPath = join(home, 'fake-codex.count');
const runs = existsSync(controlPath) ? ((JSON.parse(readFileSync(controlPath, 'utf8')) as { runs?: Run[] }).runs ?? []) : [];
const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0;
writeFileSync(countPath, String(count + 1));
const run: Run = runs[count] ?? {};

const event = (record: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

let prompt = '';
process.stdin.on('data', (chunk: Buffer) => {
  prompt += chunk.toString('utf8');
});
process.stdin.on('end', () => {
  const images = argv.flatMap((arg, index) => (arg === '--image' && index + 1 < argv.length ? [argv[index + 1]!] : [])).map((path) => {
    try {
      return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    } catch {
      return { path, sha256: 'missing' };
    }
  });
  appendFileSync(join(home, 'fake-codex.log'), `${JSON.stringify({ argv, cwd: process.cwd(), prompt, env: Object.keys(process.env).sort(), pid: process.pid, images })}\n`);
  if (run.startFile !== undefined) {
    writeFileSync(join(home, run.startFile), String(process.pid));
  }
  setTimeout(() => void released().then(answer), run.delayMs ?? 0);
});

// Resolves once the run's waitFile exists (at once without one).
async function released(): Promise<void> {
  while (run.waitFile !== undefined && !existsSync(join(home, run.waitFile))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function answer(): void {
  event({ type: 'thread.started', thread_id: `fake-${count}` });
  event({ type: 'turn.started' });
  const out = option('output-last-message');
  if (out !== undefined && run.noOutput !== true) {
    writeFileSync(out, run.invalid === true ? 'not json at all' : JSON.stringify(run.output ?? CLEAN));
  }
  if (run.error !== undefined) {
    event({ type: 'error', message: run.error });
  }
  event({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Reading the diff**\n\nFirst the patch.' } });
  event({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc \'git status\'', aggregated_output: '', exit_code: null, status: 'in_progress' } });
  process.stdout.write('not a JSON line\nnull\n');
  event({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc \'git status\'', aggregated_output: 'On branch fake\nnothing to commit\n', exit_code: 0, status: 'completed' } });
  if (run.leak === true) {
    const secret = process.env.OPENAI_FAKE_SECRET ?? '';
    const auth = JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'fake-access-token-value', refresh_token: 'fake-refresh-token-value' } });
    event({ type: 'item.completed', item: { id: 'leak_0', type: 'agent_message', text: `The secret is ${secret}, the pin ${process.env.OPENAI_FAKE_PIN ?? ''}.` } });
    event({ type: 'item.completed', item: { id: 'leak_p', type: 'agent_message', text: `${join(home, '.codex', 'config.toml')}: model = "fake-codex-config-model"` } });
    event({ type: 'item.completed', item: { id: 'leak_1', type: 'command_execution', command: 'bash -lc \'cat ~/.co*/auth.json\'', aggregated_output: auth, exit_code: 0, status: 'completed' } });
    event({ type: 'item.completed', item: { id: 'leak_2', type: 'command_execution', command: '/usr/bin/env', aggregated_output: `OPENAI_FAKE_SECRET=${secret}\nHOME=${home}\n`, exit_code: 0, status: 'completed' } });
    event({ type: 'item.completed', item: { id: 'leak_3', type: 'agent_message', text: 'The auth file says fake-codex-auth-repeated.' } });
  }
  if (run.walk !== undefined) {
    const literal = run.walk;
    const read = { id: 'walk_0', type: 'command_execution', command: 'bash -lc \'cat ~/.codex/auth.json\'', aggregated_output: '', exit_code: null, status: 'in_progress' };
    event({ type: 'item.started', item: read });
    event({ type: 'item.completed', item: { ...read, aggregated_output: '{}', exit_code: 0, status: 'completed' } });
    for (const phase of ['item.started', 'item.updated', 'item.completed']) {
      event({ type: phase, item: { id: 'walk_1', type: 'agent_message', text: literal } });
    }
    event({ type: 'item.completed', item: { id: 'walk_2', type: 'reasoning', text: literal } });
    event({ type: 'item.started', item: { id: 'walk_3', type: 'command_execution', command: 'cat README.md', aggregated_output: '', exit_code: null, status: 'in_progress' } });
    event({ type: 'item.completed', item: { id: 'walk_3', type: 'command_execution', command: 'cat README.md', aggregated_output: literal, exit_code: 0, status: 'completed' } });
    event({ type: 'item.completed', item: { id: 'walk_4', type: 'file_change', changes: [{ path: literal, kind: 'update' }], status: 'completed' } });
    event({ type: 'item.completed', item: { id: 'walk_5', type: 'mcp_tool_call', server: literal, tool: literal, arguments: { q: literal }, result: { content: literal }, error: { message: literal }, status: 'failed' } });
    event({ type: 'item.completed', item: { id: 'walk_6', type: 'web_search', query: literal } });
    event({ type: 'item.updated', item: { id: 'walk_7', type: 'todo_list', items: [{ text: literal, completed: false }] } });
    event({ type: 'item.completed', item: { id: 'walk_8', type: 'error', message: literal } });
    event({ type: 'error', message: literal });
    event({ type: 'turn.failed', error: { message: literal } });
  }
  if (run.bigMessageBytes !== undefined) {
    event({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: `Big ${'b'.repeat(run.bigMessageBytes)}` } });
  }
  event({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Reviewed.' } });
  event({ type: 'turn.completed', usage: run.usage ?? { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 } });
  if (run.exitCode !== undefined) {
    process.stderr.write('fake codex: something went wrong\n');
    process.exit(run.exitCode);
  }
  process.exit(0);
}
