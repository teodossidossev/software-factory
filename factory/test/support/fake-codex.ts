// A fake Codex CLI for the gate tests (SF-039), run through the wrapper script the harness writes
// (fakeCodex). `--version` prints a version. `exec` logs argv, cwd, the stdin prompt, the
// environment names and its pid to $HOME/fake-codex.log, takes its run script from
// $HOME/fake-codex.json ({"runs": [...]}, consumed in order through $HOME/fake-codex.count), and
// then writes the run's output (default: a clean verdict) to the --output-last-message file and
// prints JSONL events ending in turn.completed with a usage, or simulates a failure: an exit code,
// no output, an invalid output, an error event, a delay (for timeouts and aborts).
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
  // The usage of turn.completed; default 1000 input (200 cached) and 100 output tokens.
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
}

const CLEAN = { verdict: 'clean', summary: 'Codex found it right.', items: [], accepted_sensitive: [] };

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('codex-cli 0.0.0-fake\n');
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
  appendFileSync(join(home, 'fake-codex.log'), `${JSON.stringify({ argv, cwd: process.cwd(), prompt, env: Object.keys(process.env).sort(), pid: process.pid })}\n`);
  setTimeout(answer, run.delayMs ?? 0);
});

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
  event({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Reviewed.' } });
  event({ type: 'turn.completed', usage: run.usage ?? { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 } });
  if (run.exitCode !== undefined) {
    process.stderr.write('fake codex: something went wrong\n');
    process.exit(run.exitCode);
  }
  process.exit(0);
}
