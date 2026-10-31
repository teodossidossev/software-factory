// Per-application configuration for the SF-006 execution adapter:
// factory-data/apps/<app-id>/.env, written by the operator only. It is parsed as
// data (KEY=value lines), never sourced or evaluated. The only key is APP_REPO,
// the absolute path of the application's Git worktree root. Error messages never
// contain the configured value.
//
// APP_REPO must be separate from the Software Factory (mediator) repository: neither inside it nor
// containing it. One exception exists, and only under the operator's local self-hosting opt-in
// (executor/policy.ts, SelfHostingGrant): the app it names may use the mediator checkout itself,
// exactly that real path. Ancestors and descendants of the mediator stay refused even then.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { APPS_PATH, ID_DESCRIPTION, ID_PATTERN } from '../factory-jobs.js';
import { gitEnvironment, MEDIATOR_STATE_DIR, type InspectorOptions } from './git-state.js';

const execFileAsync = promisify(execFile);
const MAX_ENV_BYTES = 4096;
const KEYS = new Set(['APP_REPO']);
// Shell-significant or quoting characters: the value is used literally, so they are refused rather than guessed at.
const UNSAFE_VALUE = /[$`"'\\\0\r\n;|&<>*?]/;

export type AppConfigErrorCode = 'invalid_id' | 'app_not_registered' | 'app_not_configured' | 'invalid_config' | 'invalid_repo';

export class AppConfigError extends Error {
  readonly code: AppConfigErrorCode;

  constructor(code: AppConfigErrorCode, message: string) {
    super(message);
    this.name = 'AppConfigError';
    this.code = code;
  }
}

export interface AppConfig {
  appId: string;
  // Real path of the worktree root. Host-local: never returned to ChatGPT, OpenClaw or exported artifacts.
  repo: string;
  // Present (true) only when repo is the mediator checkout itself, allowed by a SelfHostingGrant.
  selfHosted?: true;
}

// The operator's self-hosting opt-in as loadAppConfig needs it: the one app that may use the
// mediator checkout, and the sha256 of that checkout's real path when the opt-in was given.
export interface SelfHostingGrant {
  appId: string;
  repoSha256: string;
}

// How the repository of an app is inspected: a self-hosted app's tree identity and exports leave
// out the mediator's own state directory (factory-data/), which the supervisor and the bridge
// write while a session runs. Every other app is inspected completely, as before.
export const inspectorOptions = (config: AppConfig): InspectorOptions => (config.selfHosted === true ? { ownState: [MEDIATOR_STATE_DIR] } : {});

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function readEnvFile(path: string, label: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new AppConfigError('app_not_configured', `${label} does not exist; the app is registered but not executable.`);
    }
    throw new AppConfigError('invalid_config', `${label} cannot be opened (${code === 'ELOOP' ? 'symlink' : code ?? 'error'}).`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new AppConfigError('invalid_config', `${label} is not a regular file.`);
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new AppConfigError('invalid_config', `${label} is writable by group or others; use mode 0600.`);
    }
    if (stats.size > MAX_ENV_BYTES) {
      throw new AppConfigError('invalid_config', `${label} is larger than ${MAX_ENV_BYTES} bytes.`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function parseEnv(text: string, label: string): Map<string, string> {
  if (text.includes('\0') || text.includes('\r')) {
    throw new AppConfigError('invalid_config', `${label} contains NUL or carriage-return characters.`);
  }
  const values = new Map<string, string>();
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      return;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new AppConfigError('invalid_config', `${label} line ${index + 1} is not KEY=value.`);
    }
    const [, key, value] = match as unknown as [string, string, string];
    if (!KEYS.has(key)) {
      throw new AppConfigError('invalid_config', `${label} line ${index + 1}: unknown key ${key}; only APP_REPO is supported.`);
    }
    if (values.has(key)) {
      throw new AppConfigError('invalid_config', `${label} line ${index + 1}: ${key} is set twice.`);
    }
    if (value === '' || UNSAFE_VALUE.test(value)) {
      throw new AppConfigError('invalid_config', `${label} line ${index + 1}: ${key} is empty or contains quoting or shell characters.`);
    }
    values.set(key, value);
  });
  return values;
}

// rev-parse only reads repository metadata; it still runs without inherited GIT_* and with fsmonitor off.
async function gitOutput(repo: string, ...args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-C', repo, ...args], {
      timeout: 15_000,
      env: gitEnvironment(),
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function resolveRepo(configured: string, mediatorRoot: string, label: string, appId: string, grant: SelfHostingGrant | undefined): Promise<{ repo: string; selfHosted: boolean }> {
  if (!isAbsolute(configured)) {
    throw new AppConfigError('invalid_config', `${label}: APP_REPO must be an absolute path.`);
  }
  let repo: string;
  try {
    repo = await realpath(configured);
  } catch {
    throw new AppConfigError('invalid_repo', `${label}: APP_REPO does not exist.`);
  }
  if (!(await stat(repo)).isDirectory()) {
    throw new AppConfigError('invalid_repo', `${label}: APP_REPO is not a directory.`);
  }
  const mediator = await realpath(mediatorRoot);
  const selfHosted = repo === mediator;
  if (selfHosted) {
    if (grant === undefined || grant.appId !== appId || grant.repoSha256 !== createHash('sha256').update(repo).digest('hex')) {
      throw new AppConfigError(
        'invalid_repo',
        `${label}: APP_REPO is the Software Factory repository itself; only an app with the operator's self-hosting opt-in for exactly this checkout may use it.`,
      );
    }
  } else if (inside(mediator, repo) || inside(repo, mediator)) {
    throw new AppConfigError('invalid_repo', `${label}: APP_REPO must be separate from the Software Factory repository (not inside it, not containing it).`);
  }
  if ((await gitOutput(repo, 'rev-parse', '--is-bare-repository')) !== 'false') {
    throw new AppConfigError('invalid_repo', `${label}: APP_REPO is not a Git worktree.`);
  }
  const top = await gitOutput(repo, 'rev-parse', '--show-toplevel');
  if (top === undefined || (await realpath(top)) !== repo) {
    throw new AppConfigError('invalid_repo', `${label}: APP_REPO must be the root of a Git worktree.`);
  }
  return { repo, selfHosted };
}

// grant: the operator's self-hosting opt-in, if any; without it the mediator repository is refused.
export async function loadAppConfig(mediatorRoot: string, appId: string, grant?: SelfHostingGrant): Promise<AppConfig> {
  if (!ID_PATTERN.test(appId)) {
    throw new AppConfigError('invalid_id', `app_id must be ${ID_DESCRIPTION}.`);
  }
  const appPath = `${APPS_PATH}/${appId}`;
  try {
    const stats = await lstat(join(mediatorRoot, appPath));
    if (!stats.isDirectory()) {
      throw new AppConfigError('app_not_registered', `${appPath} is not a plain directory.`);
    }
  } catch (error) {
    if (error instanceof AppConfigError) {
      throw error;
    }
    throw new AppConfigError('app_not_registered', `App "${appId}" is not registered (${appPath} does not exist).`);
  }
  const label = `${appPath}/.env`;
  const values = parseEnv(await readEnvFile(join(mediatorRoot, appPath, '.env'), label), label);
  const configured = values.get('APP_REPO');
  if (configured === undefined) {
    throw new AppConfigError('invalid_config', `${label} does not set APP_REPO.`);
  }
  const { repo, selfHosted } = await resolveRepo(configured, mediatorRoot, label, appId, grant);
  return selfHosted ? { appId, repo, selfHosted: true } : { appId, repo };
}
