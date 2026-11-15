// The gate: the Codex review of an iteration, in the same round as the Claude review on a job with
// it (src/round.ts) or alone on a job without it, run by the Codex CLI (`codex exec`) on the user's ChatGPT plan. Codex reads the worktree itself in its
// read-only sandbox; the factory gives it the Claude review's material in the prompt, the strict
// form of its output schema, and reads back the verdict, the token usage and the errors. Knows
// nothing about job states; the Execution applies the verdict.
// Codex runs inside bubblewrap under the Claude sessions' read denials (the wrapper,
// src/sandbox-denials.ts) and its socket filter (src/seccomp.ts), and never without them while the
// sandbox is on; it gets a short list of environment variables, and the raw output file is removed
// once read.
import { spawn, type SpawnOptions } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { GateTokens } from './jobs.js';
import type { Redactor } from './redact.js';
import { filterSupports, spawnSeccomped } from './seccomp.js';
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
// The code of a gate the factory did not start because bubblewrap cannot hold it.
export const GATE_SANDBOX_UNAVAILABLE = 'gate_sandbox_unavailable';

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
  // The gate is the job's only reviewer (its Claude review is off).
  onlyReviewer?: boolean;
}

// The gate's role in the prompt: the only reviewer of a job without the Claude review, else one of
// the joint round's two reviewers (src/round.ts), at the same time as the Claude review.
export const ONLY_REVIEWER_LINE = 'You are the only reviewer of this iteration, and your verdict decides.';
export const JOINT_REVIEWER_LINE = "You are one of two independent reviewers of this iteration; either's blocker or major item makes a fix.";

// The prompt of the gate: the Claude review's prompt, adapted to Codex in a read-only worktree.
export function gatePrompt(input: GateInput): string {
  const role = input.onlyReviewer === true ? ONLY_REVIEWER_LINE : JOINT_REVIEWER_LINE;
  return [
    `Code review of iteration ${input.iteration} of ticket ${input.ticket}. ${role} You review; you change nothing.`,
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
  // Every JSONL event of stdout that parses, in order, as it arrives; runGate waits for
  // the calls before it returns, and a failing call changes nothing of the outcome.
  onEvent?: (event: unknown) => Promise<void>;
  // The Task's images: absolute paths of the job's copy, one --image each.
  images?: readonly string[] | undefined;
  // The bwrap arguments Codex runs under (gateWrapper); undefined runs it unwrapped (the
  // sandbox off, SF_SANDBOX=off).
  wrapper: string[] | undefined;
  // The bwrap executable (findBwrap); with a wrapper and none, Codex does not start.
  bwrapPath: string | undefined;
  // The platform (default process.platform): the wrapper holds on Linux only.
  platform?: NodeJS.Platform;
  // The architecture (default process.arch): the wrapper's socket filter holds on x64 and arm64.
  arch?: NodeJS.Architecture;
}

export type GateOutcome = { tokens: GateTokens; startedAt: string; endedAt: string } & (
  | { ok: true; output: ReviewOutput }
  // code: the job's error code when it is not gate_failed (gate_sandbox_unavailable).
  | { ok: false; message: string; code?: string }
);

// The usage of a run that reported none.
export const noTokens = (): GateTokens => ({ input: 0, cached_input: 0, output: 0 });

// The outcome as gate.json, the events, the job's error, the Fix section and the prompts get it.
// A failure message (Codex's stderr or error event) is withheld or redacted like the run's prose
// (src/redact.ts, failure); a gate the factory refused to start (a code: gate_sandbox_unavailable)
// keeps its own text, naming the cause. A verdict is redacted.
export function redactedGateOutcome(outcome: GateOutcome, redactor: Pick<Redactor, 'failure' | 'output'>): GateOutcome {
  if (!outcome.ok) {
    return outcome.code === undefined ? { ...outcome, message: redactor.failure(outcome.message) } : outcome;
  }
  return { ...outcome, output: redactor.output(outcome.output) };
}

// The argv of `codex exec`; the prompt goes to stdin ("-"). The user's Codex memories stay out:
// the memories feature off, and no memories injected should a later Codex read them without it.
// The user's global AGENTS.md has no documented switch and still loads. The Task's images go
// before --cd, so each --image is followed by another option, never by the
// final "-" (--image takes several values).
export function gateArgs(options: Pick<GateOptions, 'cwd' | 'dir' | 'model' | 'images'>): string[] {
  return [
    'exec', '--ephemeral', '--sandbox', 'read-only',
    '--disable', 'memories', '-c', 'memories.use_memories=false',
    ...(options.images ?? []).flatMap((path) => ['--image', path]),
    '--cd', options.cwd,
    '--output-schema', join(options.dir, GATE_SCHEMA_FILE), '--output-last-message', join(options.dir, GATE_OUTPUT_FILE), '--json',
    ...(options.model !== undefined ? ['--model', options.model] : []),
    '-',
  ];
}

// The variables of the factory's environment the gate gets: the shell's and the locale's,
// the proxy's, and Codex's and OpenAI's own. Nothing else: no SF_* setting, no SSH agent,
// no other tool's key.
const GATE_NAMES = new Set(['PATH', 'HOME', 'LANG', 'LANGUAGE', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ']);
const GATE_PREFIX = /^(?:LC_|XDG_|OPENAI_|CODEX_)/;
const PROXY_NAMES = new Set(['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']);

export function gateEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = (name: string): boolean => GATE_NAMES.has(name) || GATE_PREFIX.test(name) || PROXY_NAMES.has(name.toLowerCase());
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && kept(name)));
}

// The bwrap executable on PATH, or undefined.
export function findBwrap(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) {
      continue;
    }
    try {
      accessSync(join(dir, 'bwrap'), constants.X_OK);
      return join(dir, 'bwrap');
    } catch { // not here or not executable: the next PATH directory
    }
  }
  return undefined;
}

// Why the wrapper cannot hold the gate here, or undefined when it can (or there is none).
function sandboxUnavailable(options: GateOptions): string | undefined {
  if (options.wrapper === undefined) {
    return undefined;
  }
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') {
    return `The gate did not start: it runs only inside bubblewrap, on Linux, and this is ${platform} (${GATE_SANDBOX_UNAVAILABLE}); SF_SANDBOX=off runs it without (and without the sandbox).`;
  }
  const arch = options.arch ?? process.arch;
  if (!filterSupports(arch)) {
    return `The gate did not start: the gate's socket filter does not support ${arch} (${GATE_SANDBOX_UNAVAILABLE}); SF_SANDBOX=off runs it without (and without the sandbox).`;
  }
  if (options.bwrapPath === undefined) {
    return `The gate did not start: it runs only inside bubblewrap, and there is no bwrap on PATH (${GATE_SANDBOX_UNAVAILABLE}); install bubblewrap, then go on.`;
  }
  return undefined;
}

// One JSONL line of `codex exec --json` as an event object; undefined for a line that does not
// parse to an object.
function parseEvent(line: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch { // not JSON: not an event
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
  const failed = (message: string, code?: string): GateOutcome => ({ ok: false, message: message.slice(0, 1000), ...(code !== undefined ? { code } : {}), tokens, startedAt, endedAt: new Date().toISOString() });
  const outputPath = join(options.dir, GATE_OUTPUT_FILE);
  const unavailable = sandboxUnavailable(options);
  if (unavailable !== undefined) {
    return failed(unavailable, GATE_SANDBOX_UNAVAILABLE);
  }
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
    const spawnOptions: SpawnOptions = { cwd: options.cwd, env: gateEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] };
    const child = options.wrapper === undefined
      ? spawn(options.codexPath, gateArgs(options), spawnOptions)
      : spawnSeccomped(options.bwrapPath!, options.wrapper, [options.codexPath, ...gateArgs(options)], spawnOptions);
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
    child.stdout!.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) {
        onLine(line);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES);
    });
    // Codex may exit before it reads the whole prompt; that shows in its exit.
    child.stdin!.on('error', () => {});
    child.stdin!.end(prompt);
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
  // The outcome from the run and its output file, which goes once read: the verdict the
  // factory keeps is the redacted one, never Codex's raw answer.
  const outcome = async (): Promise<GateOutcome> => {
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
    } catch { // no output file: the gate fails, saying so
      return failed('Codex wrote no output.');
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch { // not JSON: the gate fails, quoting the output
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
  };
  try {
    return await outcome();
  } finally {
    await rm(outputPath, { force: true }).catch((error: unknown) => console.error(error));
  }
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
