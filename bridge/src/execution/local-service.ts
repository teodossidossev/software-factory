// The production wiring of the SF-006 execution adapter on this host: the
// installed Claude Code (version and login state only) and an ExecutionService
// for the mediator, with the OpenClaw receiver read through the fixed docker
// command. Shared by the one-shot CLI and the SF-007 operator component.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dockerRunner, readReceiverRecord } from '../openclaw-channel.js';
import type { SelfHostingGrant } from './app-config.js';
import { CLAUDE_SESSION_MARKERS, findOnPath, ManagedClaudeRunner, ProcessClaudeRunner } from './runner.js';
import { ExecutionService } from './service.js';
import { defaultSessionGatePath, SessionGate } from './session-gate.js';

const execFileAsync = promisify(execFile);

export interface ClaudeInstallation {
  executable: string | undefined;
  version: string;
  loggedIn: boolean;
  method: string | null;
  projectsDir: string;
  configDir: string;
}

// Version and login state of the installed Claude Code; only these fields are kept (no account details).
export async function claudeInstallation(): Promise<ClaudeInstallation> {
  const fallbackConfig = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const executable = await findOnPath('claude');
  const installation: ClaudeInstallation = {
    executable,
    version: 'unknown',
    loggedIn: false,
    method: null,
    projectsDir: join(fallbackConfig, 'projects'),
    configDir: fallbackConfig,
  };
  if (executable === undefined) {
    return installation;
  }
  try {
    installation.version = (await execFileAsync(executable, ['--version'], { timeout: 30_000 })).stdout.trim().split(' ')[0] ?? 'unknown';
  } catch {
    // Reported as unknown.
  }
  try {
    const status = JSON.parse((await execFileAsync(executable, ['auth', 'status'], { timeout: 30_000 })).stdout) as Record<string, unknown>;
    installation.loggedIn = status.loggedIn === true;
    installation.method = typeof status.authMethod === 'string' ? status.authMethod : null;
    if (typeof status.projectsDirectory === 'string') installation.projectsDir = status.projectsDirectory;
    if (typeof status.configDirectory === 'string') installation.configDir = status.configDirectory;
  } catch {
    // Not logged in or no JSON: reported by preflight.
  }
  return installation;
}

// mediatorRoot must already be resolved by resolveRepoRoot.
export function localExecutionService(mediatorRoot: string, claude: ClaudeInstallation): ExecutionService {
  return new ExecutionService({
    mediatorRoot,
    receiverLookup: (requestId) => readReceiverRecord(dockerRunner(mediatorRoot), requestId),
    runner: new ProcessClaudeRunner(claude.executable ?? 'claude', claude.version, 'inherit', new SessionGate(defaultSessionGatePath())),
    claudeProjectsDir: claude.projectsDir,
    claudeConfigDir: claude.configDir,
    authStatus: async () => ({ loggedIn: claude.loggedIn, method: claude.method }),
    insideClaudeSession: process.env[CLAUDE_SESSION_MARKERS[0]!] !== undefined,
  });
}

// SF-009: the supervisor's service. Claude Code is the executable the operator verified at opt-in
// (it must still be the installed one, see executor/main.ts), started through the same session gate.
// selfHosting: the operator's self-hosting opt-in (executor/policy.ts), read afresh for every use.
export function managedExecutionService(mediatorRoot: string, claude: ClaudeInstallation, executable: string, selfHosting?: () => Promise<SelfHostingGrant | undefined>): ExecutionService {
  return new ExecutionService({
    mediatorRoot,
    receiverLookup: (requestId) => readReceiverRecord(dockerRunner(mediatorRoot), requestId),
    runner: new ManagedClaudeRunner(executable, claude.version, new SessionGate(defaultSessionGatePath())),
    claudeProjectsDir: claude.projectsDir,
    claudeConfigDir: claude.configDir,
    authStatus: async () => ({ loggedIn: claude.loggedIn, method: claude.method }),
    insideClaudeSession: process.env[CLAUDE_SESSION_MARKERS[0]!] !== undefined,
    ...(selfHosting === undefined ? {} : { selfHosting }),
  });
}
