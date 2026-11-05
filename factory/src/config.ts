// Execution configuration, read once when `sf serve` starts.
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { FactoryError } from './errors.js';
import { type ForgeSettings, forgeSettings } from './forge.js';
import type { Job } from './jobs.js';
import { configDir, HANDOFF_OFF_CODE, type HandoffMode } from './registry.js';
import { DEFAULT_RULES_MAX_BYTES } from './rules-docs.js';

export interface Config {
  stateDir: string;
  checkAfterStartMin: number;
  checkAfterFixMin: number;
  maxTurns: number;
  // Continuations the factory sends by itself after an Implementer turn ended at maxTurns while
  // making progress, per chain of turns (SF-069, SF_TURN_LIMIT_CONTINUES); 0 turns them off.
  turnLimitContinues: number;
  maxIterations: number;
  // Claude Code executable for the Implementer; undefined uses the SDK's bundled binary.
  claudePath: string | undefined;
  // Claude Code's sandbox for every Implementer turn; undefined with SF_SANDBOX=off.
  sandbox: SandboxSettings | undefined;
  // The model of every Implementer turn (SF_MODEL, passed as is); undefined uses the user's Claude
  // Code default.
  model: string | undefined;
  // Where the worktree of every job is created: <root>/<workspace>/<ticket> (SF_WORKTREE_ROOT).
  worktreeRoot: string;
  // Live jobs per workspace (SF_MAX_JOBS).
  maxJobs: number;
  // Extra sensitive path globs (SF_SENSITIVE_PATHS), on top of rules.ts.
  sensitivePaths: string[];
  // The Claude review of every published iteration (SF-038); false with SF_REVIEW=off.
  review: boolean;
  // The model of the review (SF_REVIEW_MODEL, passed as is); undefined uses the user's default.
  reviewModel: string | undefined;
  // maxTurns of the review (SF_REVIEW_MAX_TURNS).
  reviewMaxTurns: number;
  // The simplification pass after the deciding clean verdict of a job with review fixes (SF-055);
  // false with SF_SIMPLIFY=off. Its model and maxTurns are the review's.
  simplify: boolean;
  // maxTurns of the Task check (SF-054, SF_TASK_CHECK_MAX_TURNS); its model is reviewModel.
  taskCheckMaxTurns: number;
  // The automatic Task checks of sf serve (SF-086, SF_TASK_CHECK_AUTO): on by default; false keeps
  // the check manual (Check on the board, sf check-task).
  taskCheckAuto: boolean;
  // The automatic checks that run at once over every workspace, 1-4 (SF_TASK_CHECK_PARALLEL).
  taskCheckParallel: number;
  // The bytes of rule file content given to the agents at most (SF-059, SF_RULES_MAX_BYTES).
  rulesMaxBytes: number;
  // The Codex gate after a clean Claude review (SF-039): the executable, or why the gate is off.
  gate: Gate;
  // The model of the gate (SF_CODEX_MODEL, passed as --model); undefined uses Codex's default.
  codexModel: string | undefined;
  // Fix verdicts of the gate per job before the next one goes to the user (SF_GATE_MAX_ROUNDS).
  gateMaxRounds: number;
  // Input plus output tokens of the gate per job (SF_GATE_MAX_TOKENS).
  gateMaxTokens: number;
  // How long one gate run may take (SF_GATE_TIMEOUT_MS).
  gateTimeoutMs: number;
  // The Git hosts' tokens and API bases for the merge requests (SF-048).
  forge: ForgeSettings;
  // SF_HANDOFF (SF-073): checkout, the default, hands a job ready for review over to the
  // workspace's checkout on its branch; off leaves it in ready_for_human_review.
  handoff: HandoffMode;
}

// The gate: on with its Codex executable, or off with why (missing: no executable was found).
export type Gate = { on: true; codexPath: string } | { on: false; reason: string; missing?: true };

// Domains sandboxed commands may reach: the npm registry and SF_SANDBOX_DOMAINS (comma-separated).
// The factory's own fetch and push run outside the sandbox, so the Git host is not needed. Binding
// local ports and every Unix socket is allowed, so the repository's own tests can start servers on
// loopback and on Unix sockets.
export function sandboxSettings(env: NodeJS.ProcessEnv = process.env): SandboxSettings | undefined {
  if (env.SF_SANDBOX === 'off') {
    return undefined;
  }
  const extra = (env.SF_SANDBOX_DOMAINS ?? '').split(',').map((domain) => domain.trim()).filter((domain) => domain !== '');
  for (const domain of extra) {
    if (!/^(\*\.)?[A-Za-z0-9.-]+$/.test(domain)) {
      throw new FactoryError('invalid_config', `SF_SANDBOX_DOMAINS has an invalid domain "${domain}".`);
    }
  }
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    network: { allowedDomains: [...new Set(['registry.npmjs.org', ...extra])], allowLocalBinding: true, allowAllUnixSockets: true },
  };
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SF_STATE_DIR) {
    return env.SF_STATE_DIR;
  }
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'software-factory');
}

export function worktreeRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SF_WORKTREE_ROOT) {
    if (!isAbsolute(env.SF_WORKTREE_ROOT)) {
      throw new FactoryError('invalid_config', 'SF_WORKTREE_ROOT must be an absolute path.');
    }
    return env.SF_WORKTREE_ROOT;
  }
  return join(stateDir(env), 'worktrees');
}

// Comma-separated globs; empty entries are dropped.
export function sensitivePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.SF_SENSITIVE_PATHS ?? '').split(',').map((pattern) => pattern.trim()).filter((pattern) => pattern !== '');
}

// The environment file every sf command reads before anything else: SF_ENV_FILE, or
// <config dir>/auth.env (its historical name; it holds any SF_* setting). KEY=VALUE lines, "#" comments, an
// optional "export " prefix, single or double quotes around the value. A variable already set
// in the environment wins. Returns the names it set; a missing file sets nothing.
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) {
      throw new FactoryError('invalid_env_file', `Not a KEY=VALUE line: "${line}".`);
    }
    let value = match[2]!.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[match[1]!] = value;
  }
  return values;
}

export function envFilePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.SF_ENV_FILE !== undefined) {
    return env.SF_ENV_FILE === '' ? undefined : env.SF_ENV_FILE;
  }
  return join(configDir(env), 'auth.env');
}

export function loadEnvFile(env: NodeJS.ProcessEnv = process.env, path = envFilePath(env)): string[] {
  if (path === undefined) {
    return [];
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const set: string[] = [];
  for (const [name, value] of Object.entries(parseEnvFile(text))) {
    if (env[name] === undefined) {
      env[name] = value;
      set.push(name);
    }
  }
  return set;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, max = 100000): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) {
    throw new FactoryError('invalid_config', `${name} must be a positive integer, got "${raw}".`);
  }
  return Number(raw);
}

// A whole number from 0 to max.
function countSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!/^\d+$/.test(raw) || Number(raw) > max) {
    throw new FactoryError('invalid_config', `${name} must be a whole number from 0 to ${max}, got "${raw}".`);
  }
  return Number(raw);
}

// An executable regular file.
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// The gate (SF_GATE: codex, the default, or off): the executable is SF_CODEX (an absolute path) or
// codex on PATH; when there is none the gate is off, with missing set.
export function gateConfig(env: NodeJS.ProcessEnv = process.env): Gate {
  const mode = env.SF_GATE || 'codex';
  if (mode === 'off') {
    return { on: false, reason: 'SF_GATE=off' };
  }
  if (mode !== 'codex') {
    throw new FactoryError('invalid_config', `SF_GATE must be codex or off, got "${mode}".`);
  }
  const configured = env.SF_CODEX || undefined;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw new FactoryError('invalid_config', 'SF_CODEX must be an absolute path.');
    }
    return executable(configured) ? { on: true, codexPath: configured } : { on: false, reason: `SF_CODEX ${configured} is not an executable file`, missing: true };
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir !== '' && isAbsolute(dir) && executable(join(dir, 'codex'))) {
      return { on: true, codexPath: join(dir, 'codex') };
    }
  }
  return { on: false, reason: 'no codex on PATH; set SF_CODEX', missing: true };
}

// SF_RULES_MAX_BYTES (SF-059): the bytes of rule file content the agents are given at most.
export function rulesMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env, 'SF_RULES_MAX_BYTES', DEFAULT_RULES_MAX_BYTES, 16 * 1024 * 1024);
}

// SF_TASK_CHECK_AUTO (SF-086): on (the default) or off.
export function taskCheckAutoSetting(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.SF_TASK_CHECK_AUTO || 'on';
  if (mode !== 'on' && mode !== 'off') {
    throw new FactoryError('invalid_config', `SF_TASK_CHECK_AUTO must be on or off, got "${mode}".`);
  }
  return mode === 'on';
}

// The most automatic Task checks at once (SF-086, SF_TASK_CHECK_PARALLEL).
export const MAX_TASK_CHECK_PARALLEL = 4;

// SF_HANDOFF: checkout (the default) or off.
export function handoffSetting(env: NodeJS.ProcessEnv = process.env): Config['handoff'] {
  const mode = env.SF_HANDOFF || 'checkout';
  if (mode !== 'checkout' && mode !== 'off') {
    throw new FactoryError('invalid_config', `SF_HANDOFF must be checkout or off, got "${mode}".`);
  }
  return mode;
}

// Whether a job of a workspace is handed over at ready (SF-083): the workspace's handoff in
// workspaces.json wins over SF_HANDOFF. undefined: hand it over; else the notice that names the
// setting which turned it off (the job's handoff_skipped, shown by sf status and the dashboard).
export function handoffOffNotice(own: HandoffMode | undefined, global: HandoffMode, ticket: string): NonNullable<Job['handoff_skipped']> | undefined {
  if ((own ?? global) === 'checkout') {
    return undefined;
  }
  return {
    code: HANDOFF_OFF_CODE,
    message: own === 'off' ? `${ticket}: ready; hand-over off for this workspace (handoff "off" in workspaces.json)` : `${ticket}: ready; hand-over off (SF_HANDOFF=off)`,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const claudePath = env.SF_CLAUDE || undefined;
  if (claudePath !== undefined && !isAbsolute(claudePath)) {
    throw new FactoryError('invalid_config', 'SF_CLAUDE must be an absolute path.');
  }
  return {
    stateDir: stateDir(env),
    checkAfterStartMin: positiveInteger(env, 'SF_CHECK_AFTER_START_MIN', 15),
    checkAfterFixMin: positiveInteger(env, 'SF_CHECK_AFTER_FIX_MIN', 5),
    maxTurns: positiveInteger(env, 'SF_MAX_TURNS', 150),
    turnLimitContinues: countSetting(env, 'SF_TURN_LIMIT_CONTINUES', 1, 10),
    maxIterations: positiveInteger(env, 'SF_MAX_ITERATIONS', 5),
    claudePath,
    sandbox: sandboxSettings(env),
    model: env.SF_MODEL || undefined,
    worktreeRoot: resolve(worktreeRoot(env)),
    maxJobs: positiveInteger(env, 'SF_MAX_JOBS', 3),
    sensitivePaths: sensitivePaths(env),
    review: env.SF_REVIEW !== 'off',
    reviewModel: env.SF_REVIEW_MODEL || undefined,
    reviewMaxTurns: positiveInteger(env, 'SF_REVIEW_MAX_TURNS', 60),
    simplify: env.SF_SIMPLIFY !== 'off',
    taskCheckMaxTurns: positiveInteger(env, 'SF_TASK_CHECK_MAX_TURNS', 30),
    taskCheckAuto: taskCheckAutoSetting(env),
    taskCheckParallel: positiveInteger(env, 'SF_TASK_CHECK_PARALLEL', 1, MAX_TASK_CHECK_PARALLEL),
    rulesMaxBytes: rulesMaxBytes(env),
    gate: gateConfig(env),
    codexModel: env.SF_CODEX_MODEL || undefined,
    gateMaxRounds: positiveInteger(env, 'SF_GATE_MAX_ROUNDS', 5),
    gateMaxTokens: positiveInteger(env, 'SF_GATE_MAX_TOKENS', 5_000_000, 1_000_000_000),
    gateTimeoutMs: positiveInteger(env, 'SF_GATE_TIMEOUT_MS', 900_000, 86_400_000),
    forge: forgeSettings(env),
    handoff: handoffSetting(env),
  };
}
