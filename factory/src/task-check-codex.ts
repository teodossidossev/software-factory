// The Task check's Codex part: a Task file whose text ChatGPT did not write through write_task (the
// ticket's planner is Claude Code, you wrote it on the ticket's page, the factory added a Fix section,
// or it was written outside the factory's tools) is read by the Codex CLI too, so that a second model
// family checks it, as the Claude check does for a ChatGPT plan (codexCheckDue). Codex gets the Claude
// check's prompt with its tools sentence adapted, in the same check worktree and at the same time,
// through the gate's runner (runCodex, src/gate.ts) with the check's schema in strict form, inside
// the gate's bubblewrap wrapper over a job session's denials with the work checkout's
// .software-factory folder hidden too; its model, time limit and token cap are the gate's settings.
// Its answer is redacted as a reviewer's. A Codex that is off, missing, fails, times out, answers
// invalidly or goes over the token cap is a failed part, which holds nothing: the Claude check then
// decides alone. Nothing here throws.
import { mkdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type * as z from 'zod/v4';
import type { CodexEffort, Gate } from './config.js';
import { ownerOf } from './conversation.js';
import { type CodexTask, findBwrap, noTokens, redactedGateOutcome, runCodex, strictSchema } from './gate.js';
import type { GateTokens } from './jobs.js';
import { Redactor } from './redact.js';
import type { Workspace } from './registry.js';
import { issues, SEVERITIES } from './review.js';
import { gateWrapper, type PathDenials, pathDenials } from './sandbox-denials.js';
import { factoryTokens } from './secrets.js';
import { requestFile } from './setup.js';
import { TASK_DIR, taskSha256 } from './task-file.js';
import type { CheckOutput } from './task-check.js';
import { type RecordedKind, TicketHistory } from './ticket-history.js';

// The Codex part of a check record.
export interface CodexCheck {
  // Who wrote the Task file's text (codexCheckDue's reason).
  reason: string;
  status: 'checked' | 'failed';
  output: CheckOutput | null;
  error: string | null;
  // SF_CODEX_MODEL; null: Codex's default.
  model: string | null;
  tokens: GateTokens;
  started_at: string;
  ended_at: string;
}

// The Codex check's settings, from the gate's: the executable (or why it is off), SF_CODEX_MODEL,
// SF_CODEX_EFFORT, SF_GATE_TIMEOUT_MS and SF_GATE_MAX_TOKENS.
export interface CodexCheckSettings {
  gate: Gate;
  model: string | undefined;
  // undefined: Codex's own config decides.
  effort?: CodexEffort | undefined;
  timeoutMs: number;
  maxTokens: number;
}

// One Codex check's run, beside the Claude check's session.
export interface CodexCheckRun {
  // Its name and work checkout.
  workspace: Workspace;
  // The check's worktree (its check-*/repo).
  root: string;
  // The check's copies of the Task's images, absolute.
  images: readonly string[];
  stateDir: string;
  worktreeRoot: string;
  configDir: string;
  // false with SF_SANDBOX=off: no wrapper.
  sandbox: boolean;
  signal: AbortSignal;
  // Who wrote the Task file's text (codexCheckDue's reason).
  reason: string;
  // The check's schema (CHECK_SCHEMA) and its zod definition (checkOutput), given by the caller:
  // this module imports only types from src/task-check.ts, which imports it.
  schema: Record<string, unknown>;
  output: z.ZodType<CheckOutput>;
}

// The files of a Codex check run, in the codex folder beside the check's worktree.
export const CODEX_CHECK_SCHEMA_FILE = 'codex-check-schema.json';
export const CODEX_CHECK_OUTPUT_FILE = 'codex-check-output.json';
// The tools sentence of the Claude check's prompt (checkPrompt's second line, src/prompts.ts) and
// the one Codex gets in its place: it has a shell.
export const CHECK_TOOLS_SENTENCE = 'Your tools are Read, Grep and Glob, inside this directory only; nothing else is available.';
export const CODEX_TOOLS_SENTENCE = 'You work read-only: you may run read-only commands inside this directory (`rg`, `git log`, `git show`, reading files); do not leave it, and do not read credentials (`.env*` files, keys, `~/.ssh`, `~/.config`). Answer with JSON matching the output schema: paraphrase, findings, files and verdict.';

// A JSON schema without its minLength keys, at any depth.
function withoutMinLength(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(withoutMinLength);
  }
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'minLength').map(([key, value]) => [key, withoutMinLength(value)]));
}

// The schema sent with --output-schema: the Claude check's, strict, without minLength (checkOutput
// still refuses an empty paraphrase when the answer is read).
export function codexCheckSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return withoutMinLength(strictSchema(schema)) as Record<string, unknown>;
}

// The Claude check's prompt with the tools sentence of its second line replaced; every other line,
// a quote of either sentence in a rule, a skill or the Task included, as it is.
export function codexCheckPrompt(prompt: string): string {
  const lines = prompt.split('\n');
  if (lines.length > 1) {
    lines[1] = lines[1]!.replace(CHECK_TOOLS_SENTENCE, CODEX_TOOLS_SENTENCE);
  }
  return lines.join('\n');
}

// The kinds of the history's events that write the Task file's text, each with the reason Codex
// checks what it wrote (null: ChatGPT's write_task, no Codex check); queued_by_itself records a text
// the queue took and did not write.
const PAGE_REASON = 'you wrote it on the ticket\'s page';
const WRITTEN_BY: Partial<Record<RecordedKind, string | null>> = {
  created: PAGE_REASON,
  written: null,
  edited: PAGE_REASON,
  fix_added: 'the factory added a Fix section to it',
};
export const CLAUDE_CODE_REASON = 'the ticket\'s planner is Claude Code';
export const OUTSIDE_REASON = 'it was written outside the factory\'s tools (an editor or a session\'s file tools)';

// Whether Codex checks this Task text, and why: due when the ticket's planner (its .owner file) is
// Claude Code; else by the last write event of the ticket's history that left this text: written
// (ChatGPT's write_task) is not due, created or edited (the ticket's page) and fix_added are due, and
// a text no event left (written by hand or by a session's file tools) is due. Never throws: an owner
// file or a history that cannot be read counts as none.
export async function codexCheckDue(stateDir: string, workspace: string, ticket: string, task: string): Promise<{ due: true; reason: string } | { due: false }> {
  const owner = await readFile(requestFile(stateDir, workspace, ticket, 'owner'), 'utf8').catch(() => null);
  if (ownerOf(owner) === 'claude_code') {
    return { due: true, reason: CLAUDE_CODE_REASON };
  }
  const sha256 = taskSha256(task);
  const events = await new TicketHistory(stateDir).read(workspace, ticket).catch(() => []);
  const last = events.filter((event) => WRITTEN_BY[event.kind] !== undefined && event.sha256 === sha256).at(-1);
  if (last === undefined) {
    return { due: true, reason: OUTSIDE_REASON };
  }
  const reason = WRITTEN_BY[last.kind];
  return typeof reason === 'string' ? { due: true, reason } : { due: false };
}

// The denials with the work checkout's .software-factory folder (the other Task files, the MR
// texts) hidden too, as the Claude check denies it.
export function withTaskFolderHidden(denials: PathDenials, workCheckout: string): PathDenials {
  return { ...denials, sandbox: { ...denials.sandbox, denyRead: [...denials.sandbox.denyRead, join(workCheckout, TASK_DIR)] } };
}

// Runs the Codex check of one Task check. Never throws: every way it cannot check is a failed part
// with its error. The output is redacted and not yet settled (the caller settles it).
export async function runCodexCheck(prompt: string, settings: CodexCheckSettings, run: CodexCheckRun): Promise<CodexCheck> {
  const model = settings.model ?? null;
  const part = (fields: Pick<CodexCheck, 'status' | 'output' | 'error' | 'tokens' | 'started_at' | 'ended_at'>): CodexCheck => ({ reason: run.reason, ...fields, model });
  const failedNow = (error: string): CodexCheck => {
    const at = new Date().toISOString();
    return part({ status: 'failed', output: null, error, tokens: noTokens(), started_at: at, ended_at: at });
  };
  const { gate } = settings;
  if (!gate.on) {
    return failedNow(`Codex is not available (${gate.reason}); the Claude check decides alone.`);
  }
  const dir = join(dirname(run.root), 'codex');
  let wrapper: string[] | undefined;
  try {
    await mkdir(dir, { mode: 0o700 });
    if (run.sandbox) {
      const denials = await pathDenials({
        session: 'job', workspace: run.workspace.name, checkout: run.workspace.workCheckout, worktree: run.root,
        stateDir: run.stateDir, worktreeRoot: run.worktreeRoot, configDir: run.configDir,
      });
      wrapper = gateWrapper(withTaskFolderHidden(denials, run.workspace.workCheckout), {
        worktree: run.root, codexPath: gate.codexPath, codexHome: process.env.CODEX_HOME || join(homedir(), '.codex'), iterationDir: dir, images: run.images, tmp: tmpdir(),
      });
    }
  } catch (error) {
    return failedNow(`The Codex check could not start: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000));
  }
  const task: CodexTask<CheckOutput> = {
    noun: 'Codex check',
    schema: codexCheckSchema(run.schema),
    schemaFile: CODEX_CHECK_SCHEMA_FILE,
    outputFile: CODEX_CHECK_OUTPUT_FILE,
    parse: (json) => {
      const parsed = run.output.safeParse(json);
      return parsed.success ? { ok: true, output: parsed.data } : { ok: false, message: `Codex returned an invalid output: ${issues(parsed.error)}` };
    },
  };
  try {
    const raw = await runCodex(codexCheckPrompt(prompt), {
      codexPath: gate.codexPath, cwd: run.root, dir, model: settings.model, effort: settings.effort, timeoutMs: settings.timeoutMs, signal: run.signal, images: run.images, wrapper, bwrapPath: findBwrap(),
    }, task);
    const outcome = redactedGateOutcome(raw, new Redactor({ cwd: run.root, secrets: await factoryTokens({ stateDir: run.stateDir }) }));
    const times = { tokens: outcome.tokens, started_at: outcome.startedAt, ended_at: outcome.endedAt };
    if (!outcome.ok) {
      return part({ status: 'failed', output: null, error: outcome.message, ...times });
    }
    const used = outcome.tokens.input + outcome.tokens.output;
    if (used > settings.maxTokens) {
      return part({ status: 'failed', output: null, error: `Codex used ${used} tokens, over SF_GATE_MAX_TOKENS (${settings.maxTokens}); its findings are not applied.`, ...times });
    }
    return part({ status: 'checked', output: outcome.output, error: null, ...times });
  } catch (error) {
    // runCodex never throws; the redactor's token files are read here.
    return failedNow(`The Codex check failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000));
  }
}

// The Codex part as sf check-task prints it, after the Claude check's Files lines; none without one.
export function codexCheckLines(codex: CodexCheck | undefined): string[] {
  if (codex === undefined) {
    return [];
  }
  const lines = ['', `Codex check (${codex.reason}), model ${codex.model ?? 'default'}, ${codex.tokens.input + codex.tokens.output} tokens`];
  if (codex.status === 'failed' || codex.output === null) {
    return [...lines, `Codex check failed: ${codex.error ?? 'unknown error'} (it does not hold the plan)`];
  }
  lines.push('Codex findings:');
  for (const severity of SEVERITIES) {
    const items = codex.output.findings.filter((item) => item.severity === severity);
    lines.push(`  ${severity} (${items.length})${items.length === 0 ? ': none' : ':'}`);
    for (const item of items) {
      lines.push(`    - [${item.kind}] ${item.where}: ${item.problem} Expected: ${item.expected}`);
    }
  }
  lines.push(`Codex verdict: ${codex.output.verdict === 'ready' ? 'ready' : 'not ready'}`);
  return lines;
}
