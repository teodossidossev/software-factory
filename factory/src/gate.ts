// The gate (SF-039): the second, deciding review of an iteration a Claude review found clean, run by
// the Codex CLI (`codex exec`) on the user's ChatGPT subscription. Codex reads the worktree itself in its
// read-only sandbox; the factory gives it the SF-038 review material in the prompt, the strict form
// of the SF-038 output schema, and reads back the verdict, the token usage and the errors. Knows
// nothing about job states; the Execution applies the verdict.
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateTokens } from './jobs.js';
import { issues, oneLine, REVIEW_SCHEMA, reviewBody, type ReviewInput, reviewOutput, type ReviewOutput } from './review.js';

// The reviewer name of the gate in gate.json and the review events.
export const GATE_REVIEWER = 'codex';
// The files of a gate run, in the iteration's directory of the job.
export const GATE_SCHEMA_FILE = 'gate-schema.json';
export const GATE_OUTPUT_FILE = 'gate-output.json';
// After SIGTERM (timeout or cancel), SIGKILL follows after this long.
const KILL_AFTER_MS = 5000;
// How much of stderr is kept for the failure message.
const MAX_STDERR_BYTES = 16 * 1024;

// The schema in the strict form OpenAI structured outputs need: every object has
// additionalProperties false and every one of its properties required; no $schema.
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(strictSchema);
  }
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key !== '$schema') {
      result[key] = strictSchema(value);
    }
  }
  if (result.type === 'object' || result.properties !== undefined) {
    const properties = (result.properties ?? {}) as Record<string, unknown>;
    result.properties = properties;
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }
  return result;
}

// The schema sent with --output-schema: the Claude review's, strict.
export const GATE_SCHEMA = strictSchema(REVIEW_SCHEMA) as Record<string, unknown>;

export interface GateInput extends ReviewInput {
  // The commit the Patch is against: Codex runs git diff against it.
  baseCommit: string;
}

// The prompt of the gate: the SF-038 review prompt, adapted to Codex in a read-only worktree.
export function gatePrompt(input: GateInput): string {
  return [
    `Code review of iteration ${input.iteration} of ticket ${input.ticket}. You are the second and deciding reviewer: a Claude review found this iteration clean, and your verdict decides. You review; you change nothing.`,
    `The current directory is the job's worktree: it holds the change of this iteration, not committed, against the base commit ${input.baseCommit}.`,
    `You work read-only. You may run read-only commands in the worktree: \`git diff ${input.baseCommit}\`, \`git status\`, \`rg\`, reading files. Do not leave the worktree. Do not read credentials: \`.env*\` files, keys, \`~/.ssh\`, \`~/.config\`.`,
    'Answer with JSON matching the output schema: verdict, summary, items and accepted_sensitive.',
    ...reviewBody(input),
  ].join('\n');
}

export interface GateOptions {
  codexPath: string;
  // The job's worktree.
  cwd: string;
  // The iteration's directory of the job: the schema file and the output file go there.
  dir: string;
  model: string | undefined;
  timeoutMs: number;
  // Cancels the run (abort, reset, a newer review): the process is killed.
  signal: AbortSignal;
  // Every JSONL event of stdout that parses, in order, as it arrives (SF-045); runGate waits for
  // the calls before it returns, and a failing call changes nothing of the outcome.
  onEvent?: (event: unknown) => Promise<void>;
}

export type GateOutcome = { tokens: GateTokens; startedAt: string; endedAt: string } & (
  | { ok: true; output: ReviewOutput }
  | { ok: false; message: string }
);

// The usage of a run that reported none.
export const noTokens = (): GateTokens => ({ input: 0, cached_input: 0, output: 0 });

// The argv of `codex exec`; the prompt goes to stdin ("-").
export function gateArgs(options: Pick<GateOptions, 'cwd' | 'dir' | 'model'>): string[] {
  return [
    'exec', '--ephemeral', '--sandbox', 'read-only', '--cd', options.cwd,
    '--output-schema', join(options.dir, GATE_SCHEMA_FILE), '--output-last-message', join(options.dir, GATE_OUTPUT_FILE), '--json',
    ...(options.model !== undefined ? ['--model', options.model] : []),
    '-',
  ];
}

// The factory's environment without its own SF_* settings.
export function gateEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && !name.startsWith('SF_')));
}

// One JSONL line of `codex exec --json` as an event object; undefined for a line that does not
// parse to an object.
function parseEvent(line: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

// Counts one event of `codex exec --json`: the usage of turn.completed, the message of an error.
function tallyEvent(event: Record<string, unknown>, tokens: GateTokens, errors: string[]): void {
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);
  if (event.type === 'turn.completed' && event.usage !== null && typeof event.usage === 'object') {
    const usage = event.usage as Record<string, unknown>;
    tokens.input += count(usage.input_tokens);
    tokens.cached_input += count(usage.cached_input_tokens);
    tokens.output += count(usage.output_tokens);
  } else if (event.type === 'error') {
    errors.push(oneLine(String(event.message ?? 'error')));
  } else if (event.type === 'turn.failed') {
    const error = event.error as Record<string, unknown> | undefined;
    errors.push(oneLine(String(error?.message ?? 'turn failed')));
  }
}

// The last non-empty line of text, on one line.
function lastLine(text: string): string | undefined {
  return text.split('\n').map(oneLine).filter((line) => line !== '').at(-1);
}

// Runs one gate. Never throws: a non-zero exit, a timeout, a Codex error event, or a missing or
// invalid output is a failed outcome. Nothing is retried.
export async function runGate(prompt: string, options: GateOptions): Promise<GateOutcome> {
  const startedAt = new Date().toISOString();
  const tokens = noTokens();
  const failed = (message: string): GateOutcome => ({ ok: false, message: message.slice(0, 1000), tokens, startedAt, endedAt: new Date().toISOString() });
  const outputPath = join(options.dir, GATE_OUTPUT_FILE);
  try {
    await writeFile(join(options.dir, GATE_SCHEMA_FILE), `${JSON.stringify(GATE_SCHEMA, null, 2)}\n`, { mode: 0o600 });
    // A file left by an earlier, killed run is not this run's answer.
    await rm(outputPath, { force: true });
  } catch (error) {
    return failed(`The gate could not start: ${(error as Error).message}`);
  }
  if (options.signal.aborted) {
    return failed('The gate was cancelled.');
  }
  const errors: string[] = [];
  let stderr = '';
  let timedOut = false;
  // The onEvent calls, one after the other.
  let delivered = Promise.resolve();
  const onLine = (line: string): void => {
    const event = parseEvent(line);
    if (event === undefined) {
      return;
    }
    tallyEvent(event, tokens, errors);
    const { onEvent } = options;
    if (onEvent !== undefined) {
      delivered = delivered.then(() => onEvent(event)).catch((error: unknown) => console.error(error));
    }
  };
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | { spawnError: Error }>((resolve) => {
    const child = spawn(options.codexPath, gateArgs(options), { cwd: options.cwd, env: gateEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    // sf serve does not leave a gate running behind it.
    const onExit = (): void => {
      child.kill('SIGKILL');
    };
    process.once('exit', onExit);
    options.signal.addEventListener('abort', kill, { once: true });
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) {
        onLine(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES);
    });
    // Codex may exit before it reads the whole prompt; that shows in its exit.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const finish = (result: { code: number | null; signal: NodeJS.Signals | null } | { spawnError: Error }): void => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.off('exit', onExit);
      options.signal.removeEventListener('abort', kill);
      // An error and then a close both end here; the last line counts once.
      onLine(pending);
      pending = '';
      resolve(result);
    };
    child.once('error', (error) => finish({ spawnError: error }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
  await delivered;
  if ('spawnError' in ended) {
    return failed(`The gate could not start: ${ended.spawnError.message}`);
  }
  if (options.signal.aborted) {
    return failed('The gate was cancelled.');
  }
  const detail = errors.at(-1) ?? lastLine(stderr);
  if (timedOut) {
    return failed(`Codex timed out after ${options.timeoutMs} ms and was stopped${ended.signal !== null ? ` (${ended.signal})` : ''}.`);
  }
  if (ended.code !== 0) {
    const how = ended.signal !== null ? `was killed by ${ended.signal}` : `exited with code ${ended.code}`;
    return failed(`Codex ${how}${detail !== undefined ? `: ${detail}` : '.'}`);
  }
  if (errors.length > 0) {
    return failed(`Codex reported an error: ${errors.at(-1)}`);
  }
  let text: string;
  try {
    text = await readFile(outputPath, 'utf8');
  } catch {
    return failed('Codex wrote no output.');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return failed(`Codex returned output that is not JSON: ${oneLine(text).slice(0, 200)}`);
  }
  const parsed = reviewOutput.safeParse(json);
  if (!parsed.success) {
    return failed(`Codex returned an invalid verdict: ${issues(parsed.error)}`);
  }
  if (parsed.data.verdict === 'fix' && parsed.data.items.length === 0) {
    return failed('Codex returned fix without items.');
  }
  return { ok: true, output: parsed.data, tokens, startedAt, endedAt: new Date().toISOString() };
}

// `codex --version` for sf info; undefined when it does not answer within a few seconds.
export function codexVersion(codexPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(codexPath, ['--version'], { env: gateEnvironment(), stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.once('error', () => resolve(undefined));
    child.once('close', (code) => resolve(code === 0 ? lastLine(out) : undefined));
  });
}
