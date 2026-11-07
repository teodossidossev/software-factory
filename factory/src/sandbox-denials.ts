// The paths a session the factory starts may not reach (SF-100): the factory's config and env file,
// its state (but the worktrees), the other jobs' worktrees, the other workspaces' checkouts, the
// tunnel client's profile, the user's credentials in the home directory and the Task checks'
// checkouts, denied for reading and writing; the factory's own installation, denied for writing.
// Built per session from the config, the registry and the session's own working directory, as
// permission deny rules for the tools (Read, Edit, Write) and as the sandbox's filesystem deny
// lists for Bash. A path that does not exist when they are built is left out everywhere, so the
// sandbox never leaves a placeholder for it. Also the Task checks' parent directory, which the
// Task checks create and the other sessions deny.
// This module knows the file system, the registry and Git; it knows nothing about jobs.
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import { lstatSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envFilePath } from './config.js';
import { FactoryError } from './errors.js';
import { gitToplevel } from './git.js';
import { configDir, loadRegistry } from './registry.js';

// The sandbox's filesystem deny lists (the installed SDK's SandboxSettings.filesystem fields).
export type SandboxDenials = Required<Pick<NonNullable<SandboxSettings['filesystem']>, 'denyRead' | 'denyWrite'>>;

// tools: permission deny rules for the session's disallowedTools; sandbox: merged into the
// sandbox's filesystem settings (withSandboxDenials).
export interface PathDenials {
  tools: string[];
  sandbox: SandboxDenials;
}

export interface DenialScope {
  // job: the Implementer (and its MR turns), the Claude review, the simplification pass;
  // task_check: a Task check, which runs inside the Task checks' parent directory.
  session: 'job' | 'task_check';
  // The session's own workspace: its name in the registry and its checkout.
  workspace: string;
  checkout: string;
  // The session's own worktree (job sessions), which stays readable and writable.
  worktree?: string | undefined;
  stateDir: string;
  worktreeRoot: string;
  // The factory's config directory, which holds the registry (default: configDir(env)).
  configDir?: string | undefined;
  // The factory's environment: the config directory, the env file, the tunnel client's profile, HOME.
  env?: NodeJS.ProcessEnv;
  // The running factory's module directory (default: this module's).
  moduleDir?: string;
  // The system temporary directory (default: os.tmpdir()).
  tmp?: string;
}

// The user's credentials in the home directory, denied when they exist. Claude Code keeps its
// login in ~/.claude/.credentials.json on Linux.
export const HOME_CREDENTIALS = ['.ssh', '.codex', '.aws', '.config/gh', '.git-credentials', '.netrc', '.npmrc', '.claude/.credentials.json'];

// The name the docs give the factory's own MCP server in Claude Code (`claude mcp add … software-factory
// …`, SF-099): every session denies its tools, so none reaches the planning tools with the token
// Claude Code holds for it, whichever scope it was added in.
export const FACTORY_MCP_SERVER = 'software-factory';

// A path as a permission rule pattern from the filesystem root ("//abs/path"), matching itself only.
export const absoluteRule = (path: string): string => `/${path.replace(/[\\*?[\]{}()!]/g, '\\$&')}`;

// The parent directory of every Task check's checkout: <tmp>/sf-task-checks-<uid>.
export function taskChecksDir(tmp = tmpdir()): string {
  return join(tmp, `sf-task-checks-${process.getuid?.() ?? 'user'}`);
}

export const TASK_CHECK_DIR_UNSAFE = 'task_check_dir_unsafe';

// Creates the Task checks' parent directory with mode 0700 when it is missing. An existing one
// must be a real directory (not a symbolic link) owned by the factory's user; a wider mode is
// narrowed to 0700. Anything else throws task_check_dir_unsafe. Returns its real path.
export async function prepareTaskChecksDir(dir = taskChecksDir()): Promise<string> {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const info = await lstat(dir);
  const uid = process.getuid?.();
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new FactoryError(TASK_CHECK_DIR_UNSAFE, `The Task checks' directory ${dir} is not a real directory (${TASK_CHECK_DIR_UNSAFE}).`);
  }
  if (uid !== undefined && info.uid !== uid) {
    throw new FactoryError(TASK_CHECK_DIR_UNSAFE, `The Task checks' directory ${dir} belongs to another user (${TASK_CHECK_DIR_UNSAFE}).`);
  }
  if ((info.mode & 0o777) !== 0o700) {
    await chmod(dir, 0o700);
  }
  return realpath(dir);
}

// Whether path is inside dir or dir itself (both absolute, resolved).
function within(path: string, dir: string): boolean {
  const inside = relative(dir, path);
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

const realOrUndefined = (path: string): Promise<string | undefined> => realpath(path).catch(() => undefined);

// One denied path with each spelling it may be reached by (as given, absolute, and its real path),
// and whether it is a directory; undefined when it does not exist (a dangling link included).
interface Denied {
  spellings: string[];
  directory: boolean;
}

async function denied(path: string): Promise<Denied | undefined> {
  const absolute = resolve(path);
  const real = await realOrUndefined(absolute);
  if (real === undefined) {
    return undefined;
  }
  const info = await stat(real).catch(() => undefined);
  if (info === undefined) {
    return undefined;
  }
  return { spellings: [...new Set([absolute, real])], directory: info.isDirectory() };
}

// How the installed Claude Code CLI reads --disallowedTools, to which the SDK joins the list with
// commas: a comma or a space ends a rule, except after "(" until the next ")" (escaped or not), and
// each rule is trimmed. A rule passes whole only when it reads back as itself.
export function cliRuleList(values: readonly string[]): string[] {
  const parsed: string[] = [];
  for (const value of values) {
    let rule = '';
    let inside = false;
    for (const char of value) {
      if (char === '(' || char === ')') {
        inside = char === '(';
        rule += char;
      } else if ((char === ',' || char === ' ') && !inside) {
        if (rule.trim() !== '') {
          parsed.push(rule.trim());
        }
        rule = '';
      } else if (rule !== '' || char.trim() !== '') {
        rule += char;
      }
    }
    if (rule.trim() !== '') {
      parsed.push(rule.trim());
    }
  }
  return parsed;
}

export const PATH_DENIAL_UNREPRESENTABLE = 'path_denial_unrepresentable';

// The rules of a denied path for the given tools. A path the CLI would cut into pieces (a space or
// a comma after a ")" in it, surrounding white space) cannot be denied for the tools: the session
// is refused rather than started without that denial.
function rules(entry: Denied, tools: readonly string[]): string[] {
  const made = entry.spellings.flatMap((path) => tools.flatMap((tool) => entry.directory ? [`${tool}(${absoluteRule(path)})`, `${tool}(${absoluteRule(path)}/**)`] : [`${tool}(${absoluteRule(path)})`]));
  for (const rule of made) {
    const read = cliRuleList([rule]);
    if (read.length !== 1 || read[0] !== rule) {
      throw new FactoryError(PATH_DENIAL_UNREPRESENTABLE, `A path to deny cannot be written as a permission rule Claude Code reads whole, so no session starts: ${JSON.stringify(rule)}.`);
    }
  }
  return made;
}

// The entries of a directory as absolute paths; none when it cannot be listed.
async function entries(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).map((name) => join(dir, name));
}

// The running factory's installation: the Git top-level of its module directory when that is in a
// Git work tree, else the nearest directory above it whose package.json is named software-factory.
export async function installDir(moduleDir: string): Promise<string | undefined> {
  const top = await gitToplevel(moduleDir);
  if (top !== undefined) {
    return top;
  }
  for (let dir = resolve(moduleDir); ; dir = dirname(dir)) {
    const name = await readFile(join(dir, 'package.json'), 'utf8').then((text) => (JSON.parse(text) as { name?: unknown }).name, () => undefined);
    if (name === 'software-factory') {
      return dir;
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// The paths denied for reading and writing, and those denied for writing only, as given (not yet
// checked for existence).
async function candidates(scope: DenialScope): Promise<{ readWrite: string[]; writeOnly: string[]; settings: string[] }> {
  const env = scope.env ?? process.env;
  const home = env.HOME || homedir();
  const config = scope.configDir ?? configDir(env);
  const readWrite: string[] = [config];
  const envFile = envFilePath(env);
  if (envFile !== undefined) {
    readWrite.push(envFile);
  }
  readWrite.push(join(home, '.config', 'software-factory'));
  // The state directory's entries but the worktrees (it stays listable): sf.sock, the tokens, jobs/,
  // checks/, queue.json, the logs. An entry holding the worktree root is not one of them.
  const worktreeRoot = resolve(scope.worktreeRoot);
  const realRoot = (await realOrUndefined(worktreeRoot)) ?? worktreeRoot;
  for (const entry of await entries(scope.stateDir)) {
    const real = (await realOrUndefined(entry)) ?? entry;
    if (basename(entry) !== 'worktrees' && !within(worktreeRoot, entry) && !within(realRoot, real)) {
      readWrite.push(entry);
    }
  }
  // The worktree root's folders (<root>/<workspace>/<ticket>): every other workspace's, and in the
  // own workspace's every other ticket's. The own worktree stays.
  const own = scope.worktree === undefined ? undefined : ((await realOrUndefined(scope.worktree)) ?? resolve(scope.worktree));
  for (const folder of await entries(worktreeRoot)) {
    if (folder !== join(worktreeRoot, scope.workspace)) {
      readWrite.push(folder);
      continue;
    }
    for (const ticket of await entries(folder)) {
      if (own === undefined || ((await realOrUndefined(ticket)) ?? ticket) !== own) {
        readWrite.push(ticket);
      }
    }
  }
  readWrite.push(env.TUNNEL_CLIENT_PROFILE_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'tunnel-client'));
  readWrite.push(...HOME_CREDENTIALS.map((path) => join(home, path)));
  // Claude Code's backups of its global config, which hold what the global config holds (SF-099).
  readWrite.push(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'backups'));
  if (scope.session !== 'task_check') {
    readWrite.push(taskChecksDir(scope.tmp));
  }
  // Every other registered workspace's checkout, unless it is, or holds, the own one.
  const ownCheckout = (await realOrUndefined(scope.checkout)) ?? resolve(scope.checkout);
  const { workspaces } = await loadRegistry(config);
  for (const [name, entry] of Object.entries(workspaces)) {
    const real = await realOrUndefined(entry.read_checkout);
    if (name !== scope.workspace && real !== undefined && !within(ownCheckout, real)) {
      readWrite.push(real);
    }
  }
  // The factory's own installation, unless it is, or holds, the own checkout (the factory developing
  // itself from its own clone).
  const writeOnly: string[] = [];
  const install = await installDir(scope.moduleDir ?? MODULE_DIR);
  const realInstall = install === undefined ? undefined : await realOrUndefined(install);
  if (realInstall !== undefined && !within(ownCheckout, realInstall)) {
    writeOnly.push(realInstall);
  }
  return { readWrite, writeOnly, settings: claudeUserSettings(env, home) };
}

// The Claude Code configuration a session loads that it could otherwise rewrite for its next query
// (SF-100): the user settings (settings source "user": sandbox.filesystem.disabled, allowRead,
// hooks, all honoured from there) and the global config (its user-scope MCP servers run outside
// the sandbox), under CLAUDE_CONFIG_DIR, else ~/.claude and ~/.claude.json. Denied for writing,
// for the tools even while missing, so a session cannot create them either. The global config is
// denied for reading too (SF-099): `claude mcp add` keeps the factory's MCP URL with its token there.
export function claudeUserSettings(env: NodeJS.ProcessEnv, home: string): string[] {
  const dir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  return [join(dir, 'settings.json'), env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json')];
}

// The denials of one session (DenialScope). Paths are absolute, each also by its real path when that
// differs; a missing path is left out.
export async function pathDenials(scope: DenialScope): Promise<PathDenials> {
  const { readWrite, writeOnly, settings } = await candidates(scope);
  const tools = new Set<string>();
  const denyRead = new Set<string>();
  const denyWrite = new Set<string>();
  for (const path of readWrite) {
    const entry = await denied(path);
    if (entry !== undefined) {
      rules(entry, ['Read', 'Edit', 'Write']).forEach((rule) => tools.add(rule));
      entry.spellings.forEach((spelling) => (denyRead.add(spelling), denyWrite.add(spelling)));
    }
  }
  for (const path of writeOnly) {
    const entry = await denied(path);
    if (entry !== undefined) {
      rules(entry, ['Edit', 'Write']).forEach((rule) => tools.add(rule));
      entry.spellings.forEach((spelling) => denyWrite.add(spelling));
    }
  }
  // The Claude configuration: an existing file as above; a missing one for the tools only (the
  // sandbox would leave a placeholder; Bash cannot write outside the worktree and the temporary
  // directory anyway), by its path and by its folder's real path. The user settings stay readable;
  // the global config does not.
  const [userSettings, globalConfig] = settings;
  for (const [path, readable] of [[userSettings!, true], [globalConfig!, false]] as const) {
    const entry = (await denied(path)) ?? {
      spellings: [...new Set([resolve(path), join((await realOrUndefined(dirname(resolve(path)))) ?? dirname(resolve(path)), basename(path))])], directory: false,
    };
    rules(entry, readable ? ['Edit', 'Write'] : ['Read', 'Edit', 'Write']).forEach((rule) => tools.add(rule));
    if (present(path)) {
      entry.spellings.forEach((spelling) => (readable ? denyWrite.add(spelling) : (denyRead.add(spelling), denyWrite.add(spelling))));
    }
  }
  tools.add(`mcp__${FACTORY_MCP_SERVER}`);
  const sandbox = { denyRead: [...denyRead], denyWrite: [...denyWrite] };
  // The Implementer, the review and the simplification pass load the user settings (settingSources
  // "user"): one that weakens the sandbox stops the session before it starts.
  if (scope.session === 'job') {
    const env = scope.env ?? process.env;
    const home = env.HOME || homedir();
    await checkUserSettings(claudeUserSettings(env, home)[0]!, sandbox, home);
  }
  return { tools: [...tools], sandbox };
}

export const USER_SETTINGS_WEAKEN_SANDBOX = 'user_settings_weaken_sandbox';

// A sandbox.filesystem path entry of a settings file as an absolute path: ~ expanded, a relative one
// from the file's folder (the root Claude Code resolves user settings paths from), cut before its
// first segment with a glob character.
function settingsPath(entry: string, file: string, home: string): string {
  const expanded = entry === '~' ? home : entry.startsWith('~/') ? join(home, entry.slice(2)) : entry;
  const absolute = resolve(dirname(file), expanded);
  const fixed: string[] = [];
  for (const segment of absolute.split(sep)) {
    if (/[*?[\]{}]/.test(segment)) {
      break;
    }
    fixed.push(segment);
  }
  return fixed.join(sep) || sep;
}

// Why the user settings file weakens the sandbox, naming the key and the path; undefined when it does
// not (or is missing). It weakens it with sandbox.enabled false, sandbox.filesystem.disabled true, or
// an allowRead (allowWrite) entry that is, holds or lies inside a path denied for reading (writing).
// A file that cannot be read or is not the JSON object Claude Code reads counts as weakening.
export async function userSettingsWeakening(file: string, denials: SandboxDenials, home: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    return `${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? 'error'}), so whether it weakens the sandbox is unknown`;
  }
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return `${file} is not valid JSON, so whether it weakens the sandbox is unknown`;
  }
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(settings)) {
    return `${file} is not a JSON object, so whether it weakens the sandbox is unknown`;
  }
  const sandbox = settings.sandbox;
  if (sandbox === undefined) {
    return undefined;
  }
  if (!isObject(sandbox)) {
    return `${file} sets sandbox to something other than an object`;
  }
  if (sandbox.enabled === false) {
    return `${file} sets sandbox.enabled false`;
  }
  const filesystem = sandbox.filesystem;
  if (filesystem === undefined) {
    return undefined;
  }
  if (!isObject(filesystem)) {
    return `${file} sets sandbox.filesystem to something other than an object`;
  }
  if (filesystem.disabled === true) {
    return `${file} sets sandbox.filesystem.disabled true`;
  }
  for (const [key, deniedPaths] of [['allowRead', denials.denyRead], ['allowWrite', denials.denyWrite]] as const) {
    const entries = filesystem[key];
    if (entries === undefined) {
      continue;
    }
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) {
      return `${file} sets sandbox.filesystem.${key} to something other than a list of paths`;
    }
    for (const entry of entries as string[]) {
      const path = settingsPath(entry, file, home);
      const spellings = [...new Set([path, (await realOrUndefined(path)) ?? path])];
      const hit = deniedPaths.find((denied) => spellings.some((spelling) => within(denied, spelling) || within(spelling, denied)));
      if (hit !== undefined) {
        return `${file} sets sandbox.filesystem.${key} "${entry}", which covers the denied ${hit}`;
      }
    }
  }
  return undefined;
}

// Throws user_settings_weaken_sandbox when the user settings file weakens the sandbox.
export async function checkUserSettings(file: string, denials: SandboxDenials, home: string): Promise<void> {
  const weakening = await userSettingsWeakening(file, denials, home);
  if (weakening !== undefined) {
    throw new FactoryError(USER_SETTINGS_WEAKEN_SANDBOX, `${weakening}; the session does not start (${USER_SETTINGS_WEAKEN_SANDBOX}). Fix the file, then tell the job to go on.`);
  }
}

// Whether a path exists now (a link counts, dangling or not).
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// The sandbox settings with the denials merged into their filesystem lists; undefined (no sandbox,
// SF_SANDBOX=off) stays undefined. A denied path gone since the denials were built (another job's
// worktree removed at its push) is left out, so the sandbox leaves no placeholder in its place.
export function withSandboxDenials(sandbox: SandboxSettings | undefined, denials: SandboxDenials | undefined): SandboxSettings | undefined {
  if (sandbox === undefined || denials === undefined) {
    return sandbox;
  }
  const filesystem = sandbox.filesystem ?? {};
  return {
    ...sandbox,
    filesystem: {
      ...filesystem,
      denyRead: [...new Set([...(filesystem.denyRead ?? []), ...denials.denyRead.filter(present)])],
      denyWrite: [...new Set([...(filesystem.denyWrite ?? []), ...denials.denyWrite.filter(present)])],
    },
  };
}
