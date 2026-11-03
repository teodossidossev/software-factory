// Execution configuration, read once when `sf serve` starts.
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AuthConfig } from './auth.js';
import { FactoryError } from './errors.js';
import { configDir } from './registry.js';

export interface Config {
  stateDir: string;
  checkAfterStartMin: number;
  checkAfterFixMin: number;
  maxTurns: number;
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
}

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
// <config dir>/auth.env (the file the Auth0 setup writes). KEY=VALUE lines, "#" comments, an
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

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100000) {
    throw new FactoryError('invalid_config', `${name} must be a positive integer, got "${raw}".`);
  }
  return Number(raw);
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
    maxIterations: positiveInteger(env, 'SF_MAX_ITERATIONS', 5),
    claudePath,
    sandbox: sandboxSettings(env),
    model: env.SF_MODEL || undefined,
    worktreeRoot: resolve(worktreeRoot(env)),
    maxJobs: positiveInteger(env, 'SF_MAX_JOBS', 3),
    sensitivePaths: sensitivePaths(env),
  };
}

export const DEFAULT_OPEN_METHODS = ['initialize', 'ping', 'tools/list', 'server/discover', 'notifications/initialized'];
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// An absolute URL without fragment, HTTPS or HTTP on loopback (the latter for local tests).
function webUrl(name: string, raw: string): URL {
  const url = URL.parse(raw);
  if (url === null || url.hash !== '' || !(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)))) {
    throw new FactoryError('invalid_config', `${name} must be an https URL without fragment, got "${raw}".`);
  }
  return url;
}

// OAuth for the MCP endpoint (SF_AUTH_*), read once when `sf serve` starts; undefined without
// SF_AUTH_ISSUER, which means no authentication at all.
export function authConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig | undefined {
  const issuer = env.SF_AUTH_ISSUER ?? '';
  if (issuer === '') {
    return undefined;
  }
  const issuerUrl = webUrl('SF_AUTH_ISSUER', issuer);
  if (issuerUrl.search !== '') {
    throw new FactoryError('invalid_config', 'SF_AUTH_ISSUER must not have a query string.');
  }
  const audience = env.SF_AUTH_AUDIENCE ?? '';
  if (audience === '') {
    throw new FactoryError('invalid_config', 'SF_AUTH_AUDIENCE is required when SF_AUTH_ISSUER is set.');
  }
  const resource = env.SF_AUTH_RESOURCE || audience;
  webUrl(env.SF_AUTH_RESOURCE ? 'SF_AUTH_RESOURCE' : 'SF_AUTH_RESOURCE (defaulting to SF_AUTH_AUDIENCE)', resource);
  const rawMethods = env.SF_AUTH_OPEN_METHODS;
  const openMethods = rawMethods === undefined ? DEFAULT_OPEN_METHODS : rawMethods.split(',').map((method) => method.trim()).filter((method) => method !== '');
  for (const method of openMethods) {
    if (!/^[A-Za-z0-9_./-]+$/.test(method)) {
      throw new FactoryError('invalid_config', `SF_AUTH_OPEN_METHODS has an invalid method "${method}".`);
    }
    // Events are bound to the principal; they never run without a token.
    if (method.startsWith('events/')) {
      throw new FactoryError('invalid_config', `SF_AUTH_OPEN_METHODS must not contain the event method "${method}".`);
    }
  }
  return { issuer, audience, resource, openMethods: [...new Set(openMethods)] };
}
