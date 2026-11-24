// Execution configuration, read once when `sf serve` starts.
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { FactoryError } from './errors.js';
import { type ForgeSettings, forgeSettings } from './forge.js';
import type { Job } from './jobs.js';
import { configDir, HANDOFF_OFF_CODE, type HandoffMode } from './registry.js';
import { DEFAULT_RULES_MAX_BYTES } from './rules-docs.js';
import { snapshotSkillFile } from './skills.js';
import type { TaskFixSession, TaskReview } from './task-file.js';

export interface Config {
  stateDir: string;
  checkAfterStartMin: number;
  checkAfterFixMin: number;
  maxTurns: number;
  // Continuations the factory sends by itself after an Implementer turn ended at maxTurns while
  // making progress, per chain of turns (SF_TURN_LIMIT_CONTINUES); 0 turns them off.
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
  // The Claude review of every published iteration; false with SF_REVIEW=off.
  review: boolean;
  // Which tickets the Claude review runs on (SF_CLAUDE_REVIEW): ticket, the default, only
  // those whose Task file says review: claude; always every ticket but those that say review: codex.
  // A Config without it (the tests' literals) counts as always.
  claudeReview?: 'ticket' | 'always';
  // The session of the Implementer's fix rounds (SF_FIX_SESSION): resume, the default, the job's one
  // session; fresh a new session per fix round; alternate one of the two per ticket. A Config without
  // it (the tests' literals) counts as resume.
  fixSession?: FixSessionSetting;
  // The model of the review (SF_REVIEW_MODEL, passed as is); undefined uses the user's default.
  reviewModel: string | undefined;
  // maxTurns of the review (SF_REVIEW_MAX_TURNS).
  reviewMaxTurns: number;
  // The code-review skill file whose method both reviewers follow (SF_REVIEW_SKILL, reviewSkillPath);
  // undefined: none (SF_REVIEW_SKILL empty, or a Config made by hand).
  reviewSkill?: string | undefined;
  // SF_REVIEW_SKILL was set (empty too): reviewSkill is then the user's override, which wins over the
  // reviewers' roles whatever its value, the snapshot's own path included (src/review.ts, reviewerSkills).
  reviewSkillSet?: boolean;
  // The simplification pass after the deciding clean verdict of a job with review fixes;
  // false with SF_SIMPLIFY=off. Its model and maxTurns are the review's.
  simplify: boolean;
  // maxTurns of the Task check (SF_TASK_CHECK_MAX_TURNS); its model is reviewModel.
  taskCheckMaxTurns: number;
  // The automatic Task checks of sf serve (SF_TASK_CHECK_AUTO): on by default; false keeps
  // the check manual (Check on the board, sf check-task).
  taskCheckAuto: boolean;
  // The automatic checks that run at once over every workspace, 1-4 (SF_TASK_CHECK_PARALLEL).
  taskCheckParallel: number;
  // The Codex check of a Task not written by ChatGPT's write_task (SF_TASK_CHECK_CODEX): auto runs
  // it, off never; a Config without it (the tests' literals) counts as off.
  taskCheckCodex?: 'auto' | 'off';
  // The follow-up re-checks of the automatic Task checks (SF_TASK_CHECK_FOLLOW_UP, src/task-check.ts):
  // on by default; a Config without it (the tests' literals) counts as off.
  taskCheckFollowUp?: boolean;
  // The bytes of rule file content given to the agents at most (SF_RULES_MAX_BYTES).
  rulesMaxBytes: number;
  // sf serve's daily refresh of each workspace's findings checklist (SF_FINDINGS_CHECKLIST,
  // src/findings-checklist.ts): on by default; a Config without it (the tests' literals) counts as on.
  findingsChecklist?: boolean;
  // The Codex gate, beside the Claude review in the same round: the executable, or why the gate is off.
  gate: Gate;
  // The model of the gate (SF_CODEX_MODEL, passed as --model); undefined uses Codex's default.
  codexModel: string | undefined;
  // The gate's fix rounds without progress per job, its first fix not counted; the one that reaches
  // it is not applied (SF_GATE_MAX_ROUNDS).
  gateMaxRounds: number;
  // The gate's token budget for every started 2000 changed lines of a job's change (SF_GATE_MAX_TOKENS).
  gateMaxTokens: number;
  // How long one gate run may take (SF_GATE_TIMEOUT_MS).
  gateTimeoutMs: number;
  // How long one run of a workspace's test command may take (SF_TEST_TIMEOUT_MS); loadConfig
  // always sets it, a Config made by hand may leave it to DEFAULT_TEST_TIMEOUT_MS.
  testTimeoutMs?: number;
  // The gate level (SF_GATE_LEVEL): auto by the risk of each iteration's change
  // (src/gate-level.ts), or full for every iteration.
  gateLevel: 'auto' | 'full';
  // Extra path globs that make an iteration full (SF_GATE_FULL_PATHS).
  gateFullPaths: string[];
  // The Git hosts' tokens and API bases for the merge requests.
  forge: ForgeSettings;
  // SF_HANDOFF: checkout, the default, hands a job ready for review over to the
  // workspace's checkout on its branch; off leaves it in ready_for_human_review.
  handoff: HandoffMode;
  // The smoke's sandbox probe command (SF_SMOKE_PROBE_ALLOW), allowed past the permission
  // check of the Implementer, whose session it puts in dontAsk; undefined everywhere but
  // in sf smoke's own state (smokeProbeAllow).
  smokeProbeAllow: string | undefined;
}

// The gate: on with its Codex executable, or off with why (missing: no executable was found).
export type Gate = { on: true; codexPath: string } | { on: false; reason: string; missing?: true };

// SF_SANDBOX_ALLOW_READ: comma-separated paths relative to the home directory that a job's
// sandboxed commands may still read there (toolchains beyond the default ones, such as
// .m2/repository,.gradle/caches). Entries are trimmed and empty ones dropped; an absolute entry, or
// one with a ".." segment or a "~", or one that names the home directory itself (".") is refused
// with invalid_config. Whether an entry touches a
// denied path is checked where the denials are built (src/sandbox-denials.ts).
export function sandboxAllowRead(env: NodeJS.ProcessEnv = process.env): string[] {
  const entries = globList(env.SF_SANDBOX_ALLOW_READ);
  for (const entry of entries) {
    if (isAbsolute(entry) || entry.includes('~') || entry.split(/[\\/]/).includes('..')) {
      throw new FactoryError('invalid_config', `SF_SANDBOX_ALLOW_READ has an invalid entry "${entry}": it must be a path relative to the home directory, without ".." or "~".`);
    }
    // The home directory itself (".", "./"): it would keep the whole home readable.
    if (entry.split(/[\\/]/).every((segment) => segment === '' || segment === '.')) {
      throw new FactoryError('invalid_config', `SF_SANDBOX_ALLOW_READ has an invalid entry "${entry}": it names the home directory itself, not a folder in it.`);
    }
  }
  return entries;
}

// Domains sandboxed commands may reach: the npm registry and SF_SANDBOX_DOMAINS (comma-separated).
// The factory's own fetch and push run outside the sandbox, so the Git host is not needed. Binding
// local ports and every Unix socket is allowed, so the repository's own tests can start servers on
// loopback and on Unix sockets: Linux cannot allow sockets by path (allowUnixSockets is macOS
// only), so the user's sockets (D-Bus, docker, tailscaled, agents, tmux) are kept out by denying
// their locations for reading instead (src/sandbox-denials.ts). No command runs outside the sandbox: with
// allowUnsandboxedCommands false the CLI ignores dangerouslyDisableSandbox, and a project's
// .claude/settings.json (which the Implementer can write in its worktree) can neither switch the
// sandbox off nor widen it, so the path denials hold for Bash.
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
    allowUnsandboxedCommands: false,
    // The flag settings outrank the user's: filesystem isolation, which carries the path denials,
    // stays on whatever ~/.claude/settings.json says.
    filesystem: { disabled: false },
    network: { allowedDomains: [...new Set(['registry.npmjs.org', ...extra])], allowLocalBinding: true, allowAllUnixSockets: true },
  };
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SF_STATE_DIR) {
    return env.SF_STATE_DIR;
  }
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'software-factory');
}

// The state directory sf smoke makes for its run: <tmpdir>/sf-smoke-<suffix>/state.
const SMOKE_DIR = /^sf-smoke-[^/]+$/;

// SF_SMOKE_PROBE_ALLOW: the smoke's probe command, which the Implementer may run without the
// permission check (the sandbox still holds it); the only switch to the smoke's dontAsk session.
// Honoured only when the state directory is the one sf smoke made for its run, both sides resolved
// (a symlinked tmpdir still matches); a real install's state directory never is, and any realpath
// error ignores it. Empty is unset.
export function smokeProbeAllow(env: NodeJS.ProcessEnv, dir: string): string | undefined {
  const command = env.SF_SMOKE_PROBE_ALLOW;
  if (command === undefined || command === '') {
    return undefined;
  }
  let real: string;
  let tmp: string;
  try {
    real = realpathSync(dir);
    tmp = realpathSync(tmpdir());
  } catch { // any realpath error: no allowance
    return undefined;
  }
  const name = basename(dirname(real));
  return SMOKE_DIR.test(name) && real === join(tmp, name, 'state') ? command : undefined;
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

// Where the planning copies live: SF_PLANNING_DIR (absolute), else ~/planning.
export function planningDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SF_PLANNING_DIR) {
    if (!isAbsolute(env.SF_PLANNING_DIR)) {
      throw new FactoryError('invalid_config', 'SF_PLANNING_DIR must be an absolute path.');
    }
    return env.SF_PLANNING_DIR;
  }
  return join(env.HOME || homedir(), 'planning');
}

// Comma-separated globs; empty entries are dropped.
function globList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((pattern) => pattern.trim()).filter((pattern) => pattern !== '');
}

// SF_SENSITIVE_PATHS: globs added to the sensitive paths of src/rules.ts.
export function sensitivePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return globList(env.SF_SENSITIVE_PATHS);
}

// SF_GATE_FULL_PATHS: globs that make an iteration's gate level full, as SF_SENSITIVE_PATHS.
export function gateFullPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return globList(env.SF_GATE_FULL_PATHS);
}

// SF_GATE_LEVEL: auto (the default) or full.
export function gateLevelSetting(env: NodeJS.ProcessEnv = process.env): Config['gateLevel'] {
  const mode = env.SF_GATE_LEVEL || 'auto';
  if (mode !== 'auto' && mode !== 'full') {
    throw new FactoryError('invalid_config', `SF_GATE_LEVEL must be auto or full, got "${mode}".`);
  }
  return mode;
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
  } catch { // missing or not executable: false
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

// SF_CLAUDE_REVIEW: ticket (the default) or always.
export function claudeReviewSetting(env: NodeJS.ProcessEnv = process.env): NonNullable<Config['claudeReview']> {
  const mode = env.SF_CLAUDE_REVIEW || 'ticket';
  if (mode !== 'ticket' && mode !== 'always') {
    throw new FactoryError('invalid_config', `SF_CLAUDE_REVIEW must be ticket or always, got "${mode}".`);
  }
  return mode;
}

// Whether the Claude review runs on a job, decided at Start from the setting, the Task
// file's review (taskReview) and the gate, with the reason for the job's review_setup event. With
// the gate off Claude reviews every job; otherwise review: claude and review: codex win, and
// without them SF_CLAUDE_REVIEW decides (absent: always).
export function claudeReviewDecision(config: Pick<Config, 'claudeReview' | 'gate'>, review: TaskReview | undefined): { claude_review: boolean; reason: string } {
  if (!config.gate.on) {
    return { claude_review: true, reason: `the gate is off (${config.gate.reason})` };
  }
  if (review !== undefined) {
    return { claude_review: review === 'claude', reason: `the Task file says review: ${review}` };
  }
  const setting = config.claudeReview ?? 'always';
  return { claude_review: setting === 'always', reason: `SF_CLAUDE_REVIEW=${setting}` };
}

export type FixSessionSetting = 'resume' | 'fresh' | 'alternate';

// SF_FIX_SESSION: resume (the default), fresh or alternate.
export function fixSessionSetting(env: NodeJS.ProcessEnv = process.env): FixSessionSetting {
  const mode = env.SF_FIX_SESSION || 'resume';
  if (mode !== 'resume' && mode !== 'fresh' && mode !== 'alternate') {
    throw new FactoryError('invalid_config', `SF_FIX_SESSION must be resume, fresh or alternate, got "${mode}".`);
  }
  return mode;
}

// The session of a job's fix rounds, decided at Start from the Task file's fix_session
// (taskFixSession), which wins, and SF_FIX_SESSION (absent: resume), with the reason for the job's
// fix_session_setup event. alternate is fresh when the first byte of sha256("<workspace>/<ticket>")
// is even, else resume: the same ticket always gets the same arm.
export function fixSessionDecision(config: Pick<Config, 'fixSession'>, task: TaskFixSession | undefined, workspace: string, ticket: string): { fix_session: TaskFixSession; reason: 'setting' | 'task' | 'alternate' } {
  if (task !== undefined) {
    return { fix_session: task, reason: 'task' };
  }
  const setting = config.fixSession ?? 'resume';
  if (setting !== 'alternate') {
    return { fix_session: setting, reason: 'setting' };
  }
  const first = createHash('sha256').update(`${workspace}/${ticket}`).digest()[0]!;
  return { fix_session: first % 2 === 0 ? 'fresh' : 'resume', reason: 'alternate' };
}

// SF_REVIEW_SKILL: the code-review skill file of the reviewers, read at each review; unset, the
// skills snapshot's (src/skills.ts), which a reviewer reads in the folder its job pinned and only when
// its role chose code-review (src/review.ts, reviewerSkills); set, it wins for both reviewers; empty, none.
export function reviewSkillPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.SF_REVIEW_SKILL ?? snapshotSkillFile(stateDir(env), 'code-review');
  return path === '' ? undefined : path;
}

// SF_RULES_MAX_BYTES: the bytes of rule file content the agents are given at most.
export function rulesMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env, 'SF_RULES_MAX_BYTES', DEFAULT_RULES_MAX_BYTES, 16 * 1024 * 1024);
}

// SF_HEALTH: sf serve's health checks, on (the default) or off (the tests' own sf serves:
// no check spawns the fake CLIs). sf health runs its checks whatever it says.
export function healthSetting(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.SF_HEALTH || 'on';
  if (mode !== 'on' && mode !== 'off') {
    throw new FactoryError('invalid_config', `SF_HEALTH must be on or off, got "${mode}".`);
  }
  return mode === 'on';
}

// SF_KEEP_AWAKE: on (the default: sf serve keeps the laptop from sleeping while a job runs,
// src/keep-awake.ts) or off (the tests' own sf serves).
export function keepAwakeSetting(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.SF_KEEP_AWAKE || 'on';
  if (mode !== 'on' && mode !== 'off') {
    throw new FactoryError('invalid_config', `SF_KEEP_AWAKE must be on or off, got "${mode}".`);
  }
  return mode === 'on';
}

// SF_TUNNEL: auto (the default: sf serve runs the ChatGPT tunnel when it has a tunnel profile) or
// off (no tunnel in sf serve).
export function tunnelSetting(env: NodeJS.ProcessEnv = process.env): 'auto' | 'off' {
  const mode = env.SF_TUNNEL || 'auto';
  if (mode !== 'auto' && mode !== 'off') {
    throw new FactoryError('invalid_config', `SF_TUNNEL must be auto or off, got "${mode}".`);
  }
  return mode;
}

// SF_PLANNER_TRUST: ask (the default: the user accepts Claude Code's trust dialog of a planning
// copy, sf planner trust) or auto (sf planner setup and start accept it for the factory's own copies).
export function plannerTrustSetting(env: NodeJS.ProcessEnv = process.env): 'ask' | 'auto' {
  const mode = env.SF_PLANNER_TRUST || 'ask';
  if (mode !== 'ask' && mode !== 'auto') {
    throw new FactoryError('invalid_config', `SF_PLANNER_TRUST must be ask or auto, got "${mode}".`);
  }
  return mode;
}

// SF_TASK_CHECK_AUTO: on (the default) or off.
export function taskCheckAutoSetting(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.SF_TASK_CHECK_AUTO || 'on';
  if (mode !== 'on' && mode !== 'off') {
    throw new FactoryError('invalid_config', `SF_TASK_CHECK_AUTO must be on or off, got "${mode}".`);
  }
  return mode === 'on';
}

// SF_FINDINGS_CHECKLIST: on (the default) or off.
export function findingsChecklistSetting(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.SF_FINDINGS_CHECKLIST || 'on';
  if (mode !== 'on' && mode !== 'off') {
    throw new FactoryError('invalid_config', `SF_FINDINGS_CHECKLIST must be on or off, got "${mode}".`);
  }
  return mode === 'on';
}

// SF_TASK_CHECK_CODEX: auto or off (the default).
export function taskCheckCodexSetting(env: NodeJS.ProcessEnv = process.env): 'auto' | 'off' {
  const mode = env.SF_TASK_CHECK_CODEX || 'off';
  if (mode !== 'auto' && mode !== 'off') {
    throw new FactoryError('invalid_config', `SF_TASK_CHECK_CODEX must be auto or off, got "${mode}".`);
  }
  return mode;
}

// SF_TASK_CHECK_FOLLOW_UP: on (the default, also empty) or off.
export function taskCheckFollowUpSetting(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.SF_TASK_CHECK_FOLLOW_UP || 'on';
  if (mode !== 'on' && mode !== 'off') {
    throw new FactoryError('invalid_config', `SF_TASK_CHECK_FOLLOW_UP must be on or off, got "${mode}".`);
  }
  return mode === 'on';
}

// SF_TEST_TIMEOUT_MS: 30 minutes by default, at most 4 hours.
export const DEFAULT_TEST_TIMEOUT_MS = 30 * 60_000;
export const MAX_TEST_TIMEOUT_MS = 4 * 60 * 60_000;

// The most automatic Task checks at once (SF_TASK_CHECK_PARALLEL).
export const MAX_TASK_CHECK_PARALLEL = 4;

// SF_HANDOFF: checkout (the default) or off.
export function handoffSetting(env: NodeJS.ProcessEnv = process.env): Config['handoff'] {
  const mode = env.SF_HANDOFF || 'checkout';
  if (mode !== 'checkout' && mode !== 'off') {
    throw new FactoryError('invalid_config', `SF_HANDOFF must be checkout or off, got "${mode}".`);
  }
  return mode;
}

// Whether a job of a workspace is handed over at ready: the workspace's handoff in
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
    maxIterations: positiveInteger(env, 'SF_MAX_ITERATIONS', 3),
    claudePath,
    sandbox: sandboxSettings(env),
    model: env.SF_MODEL || undefined,
    worktreeRoot: resolve(worktreeRoot(env)),
    maxJobs: positiveInteger(env, 'SF_MAX_JOBS', 3),
    sensitivePaths: sensitivePaths(env),
    review: env.SF_REVIEW !== 'off',
    claudeReview: claudeReviewSetting(env),
    fixSession: fixSessionSetting(env),
    reviewModel: env.SF_REVIEW_MODEL || undefined,
    reviewMaxTurns: positiveInteger(env, 'SF_REVIEW_MAX_TURNS', 60),
    reviewSkill: reviewSkillPath(env),
    reviewSkillSet: env.SF_REVIEW_SKILL !== undefined,
    simplify: env.SF_SIMPLIFY !== 'off',
    taskCheckMaxTurns: positiveInteger(env, 'SF_TASK_CHECK_MAX_TURNS', 30),
    taskCheckAuto: taskCheckAutoSetting(env),
    taskCheckParallel: positiveInteger(env, 'SF_TASK_CHECK_PARALLEL', 1, MAX_TASK_CHECK_PARALLEL),
    taskCheckCodex: taskCheckCodexSetting(env),
    taskCheckFollowUp: taskCheckFollowUpSetting(env),
    rulesMaxBytes: rulesMaxBytes(env),
    findingsChecklist: findingsChecklistSetting(env),
    gate: gateConfig(env),
    codexModel: env.SF_CODEX_MODEL || undefined,
    gateMaxRounds: positiveInteger(env, 'SF_GATE_MAX_ROUNDS', 5),
    gateMaxTokens: positiveInteger(env, 'SF_GATE_MAX_TOKENS', 5_000_000, 1_000_000_000),
    gateTimeoutMs: positiveInteger(env, 'SF_GATE_TIMEOUT_MS', 900_000, 86_400_000),
    testTimeoutMs: positiveInteger(env, 'SF_TEST_TIMEOUT_MS', DEFAULT_TEST_TIMEOUT_MS, MAX_TEST_TIMEOUT_MS),
    gateLevel: gateLevelSetting(env),
    gateFullPaths: gateFullPaths(env),
    forge: forgeSettings(env),
    handoff: handoffSetting(env),
    smokeProbeAllow: smokeProbeAllow(env, stateDir(env)),
  };
}
