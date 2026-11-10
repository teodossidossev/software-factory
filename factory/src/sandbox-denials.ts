// The paths a session the factory starts may not reach: the factory's config and env file,
// its state (but the worktrees), the other jobs' worktrees, the other workspaces' checkouts, the
// tunnel client's profile, the user's credentials in the home directory and the Task checks'
// checkouts, denied for reading and writing; the factory's own installation, denied for writing.
// Built per session from the config, the registry and the session's own working directory, as
// permission deny rules for the tools (Read, Edit, Write) and as the sandbox's filesystem deny
// lists for Bash. A path that does not exist when they are built is left out everywhere, so the
// sandbox never leaves a placeholder for it. Also the Task checks' parent directory, which the
// Task checks create and the other sessions deny.
// The user's socket locations are denied too; the .env files of the worktree and the checkout for
// reading; the worktree's .git and agent configuration (.claude, .mcp.json, .codex) for writing; a
// job's sandboxed commands read nothing in the home directory but the kept paths (by denyRead of the
// rest), nor in the host's temporary roots (claudeTmp, host-tmp.ts: allowRead, inside which a nested
// denyRead still wins); and the file-tool guard, a PreToolUse hook every job session gets, holds
// Write and Edit to the own worktree outside that configuration and the read tools out of the home
// directory's and the temporary roots' other paths, by real path.
// The Codex gate (gateWrapper) and the Implementer (session-wrapper.ts) run in bwrap hiding denyRead.
// This module knows the file system, the registry and Git; it knows nothing about jobs.
import type { HookCallback, Options, SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envFilePath, sandboxAllowRead } from './config.js';
import { FactoryError } from './errors.js';
import { gitToplevel, runGit } from './git.js';
import { type ClaudeTmp, claudeTmpOf, socketLocations, TMP_REFUSAL } from './host-tmp.js';
import { configDir, loadRegistry } from './registry.js';
import { AGENT_CONFIG, watchedPaths, within } from './test-command.js';

// The sandbox's filesystem deny lists (the installed SDK's SandboxSettings.filesystem fields).
export type SandboxDenials = Required<Pick<NonNullable<SandboxSettings['filesystem']>, 'denyRead' | 'denyWrite'>>;

// tools: permission deny rules for the session's disallowedTools; sandbox: merged into the
// sandbox's filesystem settings (withSandboxDenials); claudeTmp: the host's temporary roots, merged
// only into a Claude session's (not the gate's or a test run's); kept: the paths under the home
// directory a job's sandboxed commands may still read, real; hooks: the file-tool guard, the
// hooks option of every job session's query().
export interface PathDenials {
  tools: string[];
  sandbox: SandboxDenials;
  claudeTmp: ClaudeTmp;
  kept: string[];
  hooks: Options['hooks'];
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
  // The session's own temporary folder (makeSessionTmp), kept readable and writable.
  sessionTmp?: string | undefined;
  // A Task check's own folder (its check-* folder under the Task checks' parent), kept readable and writable.
  checkFolder?: string | undefined;
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
  // The root under which the system's socket locations (/run, /var/run, /tmp) are looked up
  // (default: /); tests give a fake one.
  systemRoot?: string;
}

// The user's credentials in the home directory, denied when they exist. Claude Code keeps its
// login in ~/.claude/.credentials.json on Linux.
// Git's credential store has two default files: ~/.git-credentials and ~/.config/git/credentials
// (.config/git is a kept path, so its credentials must be a denial of their own).
export const HOME_CREDENTIALS = ['.ssh', '.codex', '.aws', '.config/gh', '.git-credentials', '.config/git/credentials', '.netrc', '.npmrc', '.claude/.credentials.json'];

// Claude Code's configuration directory: CLAUDE_CONFIG_DIR, else ~/.claude.
export const claudeConfigDir = (env: NodeJS.ProcessEnv, home: string): string => env.CLAUDE_CONFIG_DIR || join(home, '.claude');

// The name the docs give the factory's own MCP server in Claude Code (`claude mcp add … software-factory
// …`): every session denies its tools, so none reaches the planning tools with the token
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
async function candidates(scope: DenialScope): Promise<{ readWrite: string[]; writeOnly: string[]; readOnly: string[]; settings: string[] }> {
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
  readWrite.push(...(await socketLocations(env, scope.systemRoot ?? '/')));
  // Claude Code's backups of its global config, which hold what the global config holds.
  readWrite.push(join(claudeConfigDir(env, home), 'backups'));
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
  // The .env files of the own worktree and checkout, for reading.
  const readOnly = [...(scope.worktree !== undefined ? await envFiles(scope.worktree) : []), ...(await envFiles(scope.checkout))];
  return { readWrite, writeOnly, readOnly, settings: claudeUserSettings(env, home) };
}

// The example files a repository shares, which hold no secret: never denied.
const ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);

// Whether a file name is a .env file to deny: .env or .env.*, but the shared examples.
const isEnvFile = (name: string): boolean => (name === '.env' || name.startsWith('.env.')) && !ENV_EXAMPLES.has(name);

// The .env and .env.* files under a Git work tree, absolute: the tracked ones and every
// untracked one, ignored ones included (`git ls-files --cached --others` without an exclude list
// lists what `--others --ignored --exclude-standard` lists, and the untracked files not ignored).
// When Git cannot list them (not a work tree, a failure, its time limit), the folder is walked
// instead, so a session never starts with a .env left out.
async function envFiles(dir: string): Promise<string[]> {
  const listed = await runGit(dir, ['ls-files', '-z', '--cached', '--others', '--', ':(glob)**/.env', ':(glob)**/.env.*'], 4 * 1024 * 1024, 60_000).catch(() => undefined);
  if (listed === undefined || listed.code !== 0 || listed.truncated) {
    const found = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
    return found.filter((entry) => entry.isFile() && isEnvFile(entry.name) && !relative(dir, entry.parentPath).split(sep).includes('.git')).map((entry) => join(entry.parentPath, entry.name));
  }
  const names = listed.stdout.toString('utf8').split('\0').filter((name) => name !== '');
  return [...new Set(names)].filter((name) => isEnvFile(basename(name))).map((name) => join(dir, name));
}

// The Claude Code configuration a session loads that it could otherwise rewrite for its next query:
// the user settings (settings source "user": sandbox.filesystem.disabled, allowRead,
// hooks, all honoured from there) and the global config (its user-scope MCP servers run outside
// the sandbox), under CLAUDE_CONFIG_DIR, else ~/.claude and ~/.claude.json. Denied for writing,
// for the tools even while missing, so a session cannot create them either. The global config is
// denied for reading too: `claude mcp add` keeps the factory's MCP URL with its token there.
export function claudeUserSettings(env: NodeJS.ProcessEnv, home: string): string[] {
  const dir = claudeConfigDir(env, home);
  return [join(dir, 'settings.json'), env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json')];
}

// The paths under the home directory a job's sandboxed commands keep reading, relative to
// it: Git's configuration, the Node toolchains and their caches, and ~/.local/bin.
export const HOME_KEPT = [
  '.gitconfig', '.config/git', '.npm', '.nvm', '.volta', '.local/share/fnm', '.local/share/pnpm', '.yarn', '.bun', '.node-gyp',
  '.cache/node', '.cache/node-gyp', '.cache/pnpm', '.cache/yarn', '.cache/ms-playwright', '.local/bin',
];

// Claude Code's name for a project's folder under <config>/projects (as the installed CLI makes it):
// every character but an ASCII letter or digit as "-", and past 200 characters the first 200 then
// "-" and the base-36 absolute value of the path's 32-bit string hash.
export function claudeProjectName(path: string): string {
  const name = path.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= 200) {
    return name;
  }
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = ((hash << 5) - hash + path.charCodeAt(index)) | 0;
  }
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

// The most links realTarget follows through dangling links before it gives up (a loop).
const MAX_LINKS = 40;

// The path with its deepest existing ancestor's links resolved: where a write or read of it lands,
// for a file not there yet too. A dangling link on the way is followed to where it points (a Write
// through it creates its target), so it never reads as a new file in its own folder. Throws on a
// loop of dangling links.
async function realTarget(path: string, followed = 0): Promise<string> {
  const rest: string[] = [];
  let existing = path;
  for (;;) {
    const real = await realOrUndefined(existing);
    if (real !== undefined) {
      return join(real, ...rest);
    }
    const link = await readlink(existing).catch(() => undefined);
    if (link !== undefined) {
      if (followed >= MAX_LINKS) {
        throw new Error(`too many links at ${existing}`);
      }
      return realTarget(join(resolve(dirname(existing), link), ...rest), followed + 1);
    }
    const parent = dirname(existing);
    if (parent === existing) {
      return path;
    }
    rest.unshift(basename(existing));
    existing = parent;
  }
}

// The kept paths of a session that exist, real: the own worktree, temporary folder, check folder
// (a Task check) and checkout, HOME_KEPT, Claude Code's shell snapshots (each Bash command
// first sources one) and the entries of SF_SANDBOX_ALLOW_READ, each refused with invalid_config when
// it is, holds or lies in a denyRead path, or is or holds a guarded root (the home, by any link).
async function keptPaths(scope: DenialScope, home: string, denyRead: readonly string[]): Promise<string[]> {
  const env = scope.env ?? process.env;
  const extra: string[] = [];
  // The roots the kept paths are carved out of: an entry that is, or holds, one of
  // them (the home itself, or a link to it or to /) would keep it whole, whatever lies below it.
  const roots = [...new Set([resolve(home), ...(await guardedRoots(env, home))])];
  for (const entry of sandboxAllowRead(env)) {
    const path = join(home, entry);
    const spellings = [...new Set([path, (await realOrUndefined(path)) ?? path])];
    const root = roots.find((guarded) => spellings.some((spelling) => within(guarded, spelling)));
    if (root !== undefined) {
      throw new FactoryError('invalid_config', `SF_SANDBOX_ALLOW_READ has the entry "${entry}", which is or holds ${root}, whose paths a job reads only through the kept ones; the session does not start.`);
    }
    const hit = denyRead.find((denied) => spellings.some((spelling) => within(denied, spelling) || within(spelling, denied)));
    if (hit !== undefined) {
      throw new FactoryError('invalid_config', `SF_SANDBOX_ALLOW_READ has the entry "${entry}", which covers the denied ${hit}; the session does not start.`);
    }
    extra.push(path);
  }
  const paths = [
    ...[scope.worktree, scope.sessionTmp, scope.checkFolder].filter((path) => path !== undefined), scope.checkout,
    ...HOME_KEPT.map((path) => join(home, path)), join(claudeConfigDir(env, home), 'shell-snapshots'), ...extra,
  ];
  const kept = new Set<string>();
  for (const path of paths) {
    const real = await realOrUndefined(resolve(path));
    if (real !== undefined) {
      kept.add(real);
    }
  }
  return [...kept];
}

// The folders whose contents a job reads only through the kept paths: the home directory
// and Claude Code's configuration directory when CLAUDE_CONFIG_DIR puts it outside the home; real.
async function guardedRoots(env: NodeJS.ProcessEnv, home: string): Promise<string[]> {
  const realHome = (await realOrUndefined(home)) ?? resolve(home);
  const config = await realOrUndefined(claudeConfigDir(env, home));
  return config === undefined || within(config, realHome) ? [realHome] : [realHome, config];
}

// The entries a job's sandboxed commands may not read in a guarded root: every entry of
// the root and of each folder on the way down to a kept path, unless it is a kept path, on the
// way to one, or a link into, or holding, one. Absolute, spelled from the root's real path. A kept
// path that is, or holds, the root keeps it whole (a checkout at $HOME, say): nothing is denied.
async function homeEntries(realHome: string, kept: readonly string[]): Promise<string[]> {
  if (kept.some((path) => within(realHome, path))) {
    return [];
  }
  const onTheWay = new Set<string>([realHome]);
  for (const path of kept.filter((path) => within(path, realHome))) {
    for (let dir = dirname(path); within(dir, realHome); dir = dirname(dir)) {
      onTheWay.add(dir);
      if (dir === realHome) {
        break;
      }
    }
  }
  const denied: string[] = [];
  for (const dir of onTheWay) {
    for (const entry of await entries(dir)) {
      if (onTheWay.has(entry) || kept.includes(entry)) {
        continue;
      }
      const real = (await realOrUndefined(entry)) ?? entry;
      if (!kept.some((path) => within(real, path) || within(path, real))) {
        denied.push(entry);
      }
    }
  }
  return denied;
}

// The denials of one session (DenialScope). Paths are absolute, each also by its real path when that
// differs; a missing path is left out.
export async function pathDenials(scope: DenialScope): Promise<PathDenials> {
  const env = scope.env ?? process.env;
  const home = env.HOME || homedir();
  const { readWrite, writeOnly, readOnly, settings } = await candidates(scope);
  const tools = new Set<string>();
  const denyRead = new Set<string>();
  const denyWrite = new Set<string>();
  // Denied for reading and writing, for writing only, for reading only; and the own worktree's .git
  // and agent configuration, each when it exists, which no sandboxed command may change (the
  // file-tool guard holds the tools).
  const groups = [
    { paths: readWrite, ruleTools: ['Read', 'Edit', 'Write'], read: true, write: true },
    { paths: writeOnly, ruleTools: ['Edit', 'Write'], read: false, write: true },
    { paths: readOnly, ruleTools: ['Read'], read: true, write: false },
    { paths: scope.worktree === undefined ? [] : await watchedPaths(scope.worktree), ruleTools: [], read: false, write: true },
  ] as const;
  for (const { paths, ruleTools, read, write } of groups) {
    for (const path of paths) {
      const entry = await denied(path);
      if (entry !== undefined) {
        rules(entry, ruleTools).forEach((rule) => tools.add(rule));
        entry.spellings.forEach((spelling) => (read && denyRead.add(spelling), write && denyWrite.add(spelling)));
      }
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
  // The specific denials: what the user settings and SF_SANDBOX_ALLOW_READ are held against.
  const specific = { denyRead: [...denyRead], denyWrite: [...denyWrite] };
  const kept = await keptPaths(scope, home, specific.denyRead);
  // What a Claude session reads in the host's temporary roots (claudeTmp.denyRead): its kept paths.
  const claudeTmp = await claudeTmpOf({ ...scope, tmp: scope.tmp ?? tmpdir(), systemRoot: scope.systemRoot ?? '/' });
  // The Implementer, the review and the simplification pass load the user settings (settingSources
  // "user"): one that weakens the sandbox, the temporary roots' denial included, stops the session
  // before it starts. Their sandboxed commands read nothing in the home directory but the kept
  // paths, by denyRead of the home's other entries.
  const roots = await guardedRoots(env, home);
  if (scope.session === 'job') {
    await checkUserSettings(claudeUserSettings(env, home)[0]!, { ...specific, denyRead: [...specific.denyRead, ...claudeTmp.denyRead] }, home);
    for (const root of roots) {
      for (const path of await homeEntries(root, kept)) {
        (await denied(path))?.spellings.forEach((spelling) => denyRead.add(spelling));
      }
    }
  }
  const sandbox = { denyRead: [...denyRead], denyWrite: [...denyWrite] };
  const projects = join(claudeConfigDir(env, home), 'projects');
  const ownProjects = scope.worktree === undefined ? [] : [...new Set([resolve(scope.worktree), (await realOrUndefined(scope.worktree)) ?? resolve(scope.worktree)])].map((path) => join(projects, claudeProjectName(path)));
  // The guard keeps what the sandbox reads back in the temporary roots too (the state directory).
  const guard = await fileGuard({ worktree: scope.worktree, roots, tmpRoots: claudeTmp.denyRead, kept: [...new Set([...kept, ...claudeTmp.allowRead])], projects: ownProjects });
  return { tools: [...tools], sandbox, claudeTmp, kept, hooks: guardHooksOf(guard) };
}

// The text every refusal of the file-tool guard starts with (the smoke looks for it).
export const FILE_GUARD = "The factory's file-tool guard";

// The file tools that write, and the ones that read, by name.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
// The keys of a tool input that name a path; each one present is a target.
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];
// The most brace alternatives a Glob pattern may expand to.
const MAX_ALTERNATIVES = 64;
const GLOB_CHARS = /[*?[\]{}]/;

// What the guard checks against, real paths: the own worktree (undefined: no write passes), the
// guarded roots, the temporary roots, the kept paths and the session's own Claude project folders.
interface FileGuard {
  worktree: string | undefined;
  roots: string[];
  tmpRoots: string[];
  kept: string[];
  projects: string[];
}

// The guard of the given paths, each by the real path it lands on.
async function fileGuard(given: FileGuard): Promise<FileGuard> {
  return {
    worktree: given.worktree === undefined ? undefined : await realTarget(resolve(given.worktree)),
    roots: given.roots,
    tmpRoots: given.tmpRoots,
    kept: given.kept,
    projects: [...new Set(await Promise.all(given.projects.map((path) => realTarget(path))))],
  };
}

// A Glob pattern's brace alternatives, innermost group first; undefined for one the guard does not
// read the way the tool does (a backslash, an extglob, "|", unpaired braces, too many alternatives).
function braceAlternatives(pattern: string): string[] | undefined {
  if (pattern.includes('\\') || pattern.includes('|') || /[@!+*?]\(/.test(pattern)) {
    return undefined;
  }
  let alternatives = [pattern];
  for (;;) {
    const next: string[] = [];
    let expanded = false;
    for (const alternative of alternatives) {
      const group = /\{([^{}]*)\}/.exec(alternative);
      if (group === null) {
        next.push(alternative);
        continue;
      }
      expanded = true;
      next.push(...group[1]!.split(',').map((part) => alternative.slice(0, group.index) + part + alternative.slice(group.index + group[0].length)));
    }
    if (next.length > MAX_ALTERNATIVES) {
      return undefined;
    }
    alternatives = next;
    if (!expanded) {
      return alternatives.some((alternative) => alternative.includes('{') || alternative.includes('}')) ? undefined : alternatives;
    }
  }
}

// The paths a file tool call reaches, absolute (relative ones from cwd), or the value the guard
// cannot read: a path that is not a string, has white space at either end or starts with "~", a
// missing target of a write or a Read, a Glob pattern it cannot expand or that climbs with ".."
// after a glob segment. A Glob, Grep or LS without a path reaches cwd. searches: the folders a Glob
// or Grep walks below for files to match: every path of the call, its folder and a
// Glob pattern's fixed parts alike (a pattern without a "/" matches at any depth, and Claude Code
// may move part of a pattern into the folder searched).
function targets(tool: string, input: Record<string, unknown>, cwd: string): { paths: string[]; searches: string[] } | { unreadable: string } {
  const plain = (value: unknown): value is string => typeof value === 'string' && value !== '' && value === value.trim() && !value.startsWith('~');
  const given = PATH_KEYS.filter((key) => input[key] !== undefined && input[key] !== '').map((key) => input[key]);
  const bad = given.find((value) => !plain(value));
  if (bad !== undefined) {
    return { unreadable: typeof bad === 'string' ? bad : JSON.stringify(bad) ?? String(bad) };
  }
  const paths = (given as string[]).map((path) => resolve(cwd, path));
  if (paths.length === 0) {
    if (WRITE_TOOLS.has(tool) || tool === 'Read') {
      return { unreadable: '(no path)' };
    }
    paths.push(cwd);
  }
  if (tool === 'Glob' && input.pattern !== undefined) {
    const pattern = input.pattern;
    const alternatives = typeof pattern === 'string' ? braceAlternatives(pattern) : undefined;
    if (alternatives === undefined) {
      return { unreadable: typeof pattern === 'string' ? pattern : String(JSON.stringify(pattern)) };
    }
    const bases = [...paths];
    for (const alternative of alternatives) {
      const segments = alternative.split('/');
      const first = segments.findIndex((segment) => GLOB_CHARS.test(segment));
      if (alternative.startsWith('~') || (first >= 0 && segments.slice(first).includes('..'))) {
        return { unreadable: alternative };
      }
      const fixed = (first < 0 ? segments : segments.slice(0, first)).join('/');
      paths.push(...(isAbsolute(alternative) ? [resolve('/', fixed)] : bases.map((base) => resolve(base, fixed))));
    }
  }
  return { paths, searches: SEARCH_TOOLS.has(tool) ? paths : [] };
}

// Where a real path the read tools may not reach lies ('tmp' a temporary root, 'home' a guarded
// root), outside the kept paths and the session's own Claude Code project folders; else undefined.
function readDenied(guard: FileGuard, real: string): 'tmp' | 'home' | undefined {
  const outside = !guard.kept.some((kept) => within(real, kept)) && !guard.projects.some((project) => within(real, project));
  return !outside ? undefined : guard.tmpRoots.some((root) => within(real, root)) ? 'tmp' : guard.roots.some((root) => within(real, root)) ? 'home' : undefined;
}

// The most folders the link check of one search walks; more refuse the search. SEARCH_BATCH: the
// folders it reads at once.
const MAX_SEARCH_DIRS = 50_000;
const SEARCH_BATCH = 64;
// The tools whose search walks the folders below its path. The installed CLI runs ripgrep for both
// without --follow; the guard holds them as if they followed links, so a CLI that does stays held.
const SEARCH_TOOLS = new Set(['Glob', 'Grep']);
// The errors that mean a folder or a link leads nowhere a search could go: anything else (EMFILE,
// EIO) cannot be checked, so the call is refused.
const NOWHERE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM']);
const nowhere = <T>(fallback: T) => (error: NodeJS.ErrnoException): T => {
  if (NOWHERE.has(error.code ?? '')) {
    return fallback;
  }
  throw error;
};

// Why a search reaching a folder (a real path) is refused: it is a refused path, or it holds one
// of the guarded or temporary roots (a search of /home walks into the home directory).
function searchDenied(guard: FileGuard, real: string): string | undefined {
  const denied = readDenied(guard, real);
  if (denied !== undefined) {
    return denied === 'tmp' ? TMP_REFUSAL : 'in the home directory outside the worktree, the checkout and the toolchains';
  }
  const held = [...guard.roots, ...guard.tmpRoots].find((root) => within(root, real));
  return held === undefined ? undefined : `holding ${held}`;
}

// Why a search from dir (a real path) would reach a refused path, or undefined:
// dir itself, or a link anywhere below it, as ripgrep with --follow walks it. Every folder it would
// reach is walked once, level by level, by its real path, a link's target folder included (a folder
// outside the worktree, such as the temporary directory, may hold a link of its own). A dangling
// link leads nowhere; an error that is not one of NOWHERE throws (the call is refused). More than
// MAX_SEARCH_DIRS folders refuse the search.
async function searchEscape(guard: FileGuard, dir: string): Promise<string | undefined> {
  const own = searchDenied(guard, dir);
  if (own !== undefined) {
    return `${dir} is ${own}`;
  }
  const visited = new Set<string>([dir]);
  let level = [dir];
  while (level.length > 0) {
    const next: string[] = [];
    for (let start = 0; start < level.length; start += SEARCH_BATCH) {
      const found = await Promise.all(level.slice(start, start + SEARCH_BATCH).map(async (current) => {
        const listed = await readdir(current, { withFileTypes: true }).catch(nowhere([]));
        return Promise.all(listed.map(async (entry): Promise<{ folder?: string; escape?: string }> => {
          const path = join(current, entry.name);
          if (entry.isDirectory()) {
            return { folder: path };
          }
          if (!entry.isSymbolicLink()) {
            return {};
          }
          const real = await realpath(path).catch(nowhere(undefined));
          if (real === undefined) {
            return {};
          }
          const denied = searchDenied(guard, real);
          if (denied !== undefined) {
            return { escape: `${path} below it links to ${real}, ${denied}` };
          }
          return (await stat(real).catch(nowhere(undefined)))?.isDirectory() === true ? { folder: real } : {};
        }));
      }));
      for (const result of found.flat()) {
        if (result.escape !== undefined) {
          return result.escape;
        }
        if (result.folder !== undefined && !visited.has(result.folder)) {
          visited.add(result.folder);
          if (visited.size > MAX_SEARCH_DIRS) {
            return `the folders below ${dir} are too many to check for links (over ${MAX_SEARCH_DIRS})`;
          }
          next.push(result.folder);
        }
      }
    }
    level = next;
  }
  return undefined;
}

// Why the guard refuses a tool call, or undefined when it passes. A write tool passes only
// when every target, links resolved, is in the own worktree outside its .git and its agent
// configuration (.claude, .mcp.json, .codex); a read tool is
// refused when a target lies in the home directory outside the kept paths and the session's own
// Claude Code project folders. Every other tool passes. Never throws: a call it fails to check is
// refused (Claude Code would take a hook that throws as no decision).
export async function fileGuardReason(guard: FileGuard, tool: string, input: unknown, cwd: string | undefined): Promise<string | undefined> {
  if (!WRITE_TOOLS.has(tool) && !READ_TOOLS.has(tool)) {
    return undefined;
  }
  try {
    const base = cwd ?? guard.worktree;
    if (typeof input !== 'object' || input === null || base === undefined) {
      return `${FILE_GUARD} refuses this ${tool}: its input cannot be checked.`;
    }
    const found = targets(tool, input as Record<string, unknown>, base);
    if ('unreadable' in found) {
      return `${FILE_GUARD} refuses this ${tool}: the path ${found.unreadable} cannot be checked (give a plain absolute path, no ~).`;
    }
    for (const path of found.paths) {
      const real = await realTarget(path);
      if (WRITE_TOOLS.has(tool)) {
        if (guard.worktree === undefined || !within(real, guard.worktree) || within(real, join(guard.worktree, '.git'))) {
          return `${FILE_GUARD} refuses this ${tool}: ${path} ${readDenied(guard, real) === 'tmp' ? `is in a temporary root; ${TMP_REFUSAL}` : `is outside the job's worktree${guard.worktree === undefined ? '' : ` ${guard.worktree}`}, or in its .git`}.`;
        }
        // The agent configuration (.claude, .mcp.json, .codex), by its path or the real path it links to.
        const config = AGENT_CONFIG.map((name) => join(guard.worktree!, name));
        if ([...config, ...(await Promise.all(config.map((root) => realTarget(root))))].some((root) => within(real, root))) {
          return `${FILE_GUARD} refuses this ${tool}: ${path} is agent configuration; the factory does not let a job change it.`;
        }
      } else if (readDenied(guard, real) !== undefined) {
        return `${FILE_GUARD} refuses this ${tool}: ${path} ${readDenied(guard, real) === 'tmp' ? `is in a temporary root; ${TMP_REFUSAL}` : 'is in the home directory, outside the worktree, the checkout and the toolchains'}.`;
      }
    }
    for (const path of found.searches) {
      const real = await realTarget(path);
      if ((await stat(real).catch(nowhere(undefined)))?.isDirectory() === true) {
        const escape = await searchEscape(guard, real);
        if (escape !== undefined) {
          return `${FILE_GUARD} refuses this ${tool} of ${path}: ${escape}.`;
        }
      }
    }
    return undefined;
  } catch {
    return `${FILE_GUARD} could not check this ${tool} call; it is refused.`;
  }
}

// The guard as the session's PreToolUse hook (in the form of the Task check's guardHooks): it runs
// in every permission mode, auto and dontAsk included; a refusal is a deny with the reason.
function guardHooksOf(guard: FileGuard): { PreToolUse: Array<{ hooks: HookCallback[] }> } {
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {};
    }
    const reason = await fileGuardReason(guard, input.tool_name, input.tool_input, typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : undefined);
    return reason === undefined ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  };
  return { PreToolUse: [{ hooks: [hook] }] };
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

// What the Codex gate's wrapper binds back: the job's worktree (Codex's --cd), the Codex
// executable, Codex's own directory (CODEX_HOME, else ~/.codex), the iteration's directory (the
// schema and output files), the Task's images (the job's copy) and the system temporary directory.
export interface GateWrapperOptions {
  worktree: string;
  codexPath: string;
  codexHome: string;
  iterationDir: string;
  images: readonly string[];
  tmp: string;
}

// The directory the Codex executable needs whole: the real path of its nearest node_modules
// ancestor (its launcher spawns the sibling package of the platform's binary), else its own folder.
export function codexPackage(codexPath: string): string {
  let real: string;
  try {
    real = realpathSync(codexPath);
  } catch {
    real = resolve(codexPath);
  }
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    if (basename(dir) === 'node_modules') {
      return dir;
    }
    if (dirname(dir) === dir) {
      return dirname(real);
    }
  }
}

// The mount that hides a denied path that exists now: an empty tmpfs over a directory, /dev/null
// over a file or a socket; none for a path gone since the denials were built (bwrap could not make
// its mount point under the read-only root).
export function hiding(path: string): string[] {
  let directory: boolean;
  try {
    directory = statSync(path).isDirectory();
  } catch {
    return [];
  }
  return directory ? ['--tmpfs', path] : ['--ro-bind', '/dev/null', path];
}

const depth = (path: string): number => path.split(sep).filter((part) => part !== '').length;

// Where bwrap can mount over a path: its real path when it exists, since bwrap cannot create a
// mount point through a link (/var/run/dbus with /var/run a link to /run); else the path resolved.
export function mountPoint(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// The bwrap arguments the Codex gate runs under, a later mount winning over an earlier one:
//   1. the whole system read-only, a new /dev and /proc (--unshare-pid: an unprivileged bwrap mounts
//      a procfs only in a PID namespace of its own), an empty /tmp, and an empty tmp when it is
//      not under /tmp;
//   2. every denyRead entry not under those temporary folders hidden (hiding);
//   3. bound back read-only: the worktree, the images, the Codex package (codexPackage) and node's
//      prefix (dirname(dirname(realpath(process.execPath)))); then the denyRead entries inside one
//      of these binds and the binds inside such an entry, shallowest first, so that the most
//      specific path wins: a .env of the worktree stays hidden, an image under jobs/ stays bound
//      when a bind holds jobs/;
//   4. bound back read-write: CODEX_HOME and the iteration's directory.
// The host's network namespace (Codex reaches OpenAI); --seccomp 3 refuses new Unix sockets (seccomp.ts).
export function gateWrapper(denials: PathDenials, options: GateWrapperOptions): string[] {
  const tmp = resolve(options.tmp);
  const temporary = within(tmp, '/tmp') ? ['/tmp'] : ['/tmp', tmp];
  const args = ['--die-with-parent', '--unshare-pid', '--seccomp', '3', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', ...temporary.flatMap((dir) => ['--tmpfs', dir])];
  const denied = [...new Set(denials.sandbox.denyRead.map(mountPoint))];
  for (const path of denied.filter((entry) => !temporary.some((dir) => within(entry, dir)))) {
    args.push(...hiding(path));
  }
  const readOnly = [...new Set([
    resolve(options.worktree), ...options.images.map((path) => resolve(path)), codexPackage(options.codexPath),
    dirname(dirname(realpathSync(process.execPath))),
  ])];
  const binds = new Map(readOnly.map((path) => [path, ['--ro-bind', path, path]]));
  args.push(...[...binds.values()].flat(), ...fixUp(denied, binds));
  for (const path of [...new Set([resolve(options.codexHome), resolve(options.iterationDir)])]) {
    args.push('--bind', path, path);
  }
  return args;
}

// A wrapper's fix-up pass after its binds (path to mount): denials inside a bind hidden again, binds
// inside such a denial mounted again, shallowest first (a denial first): the most specific path wins.
export function fixUp(denied: readonly string[], binds: ReadonlyMap<string, readonly string[]>): string[] {
  const inside = (path: string, dirs: readonly string[]): boolean => dirs.some((dir) => dir !== path && within(path, dir));
  const again = denied.filter((path) => inside(path, [...binds.keys()]));
  const rebound = [...binds.keys()].filter((path) => inside(path, again));
  const mounts = [...again.map((path) => ({ path, mount: hiding(path) })), ...rebound.map((path) => ({ path, mount: [...binds.get(path)!] }))];
  return mounts.sort((a, b) => depth(a.path) - depth(b.path)).flatMap((entry) => entry.mount);
}

// The gate's wrapper for a denial scope: pathDenials(scope), then gateWrapper. The review pipeline
// and the smoke's Gate sandbox step build it the same way.
export async function gateWrapperFor(scope: DenialScope, options: GateWrapperOptions): Promise<string[]> {
  return gateWrapper(await pathDenials(scope), options);
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

// The sandbox settings with the denials, and a Claude session's claudeTmp, merged into their
// filesystem lists; undefined (no sandbox, SF_SANDBOX=off) stays undefined. A path gone since the
// denials were built (another job's worktree removed at its push) is left out, so the sandbox leaves
// no placeholder in its place.
export function withSandboxDenials(sandbox: SandboxSettings | undefined, denials: SandboxDenials | undefined, claudeTmp?: ClaudeTmp): SandboxSettings | undefined {
  if (sandbox === undefined || denials === undefined) {
    return sandbox;
  }
  const filesystem = sandbox.filesystem ?? {};
  const merged = (key: 'denyRead' | 'denyWrite' | 'allowRead' | 'allowWrite', paths: readonly string[]): string[] => [...new Set([...(filesystem[key] ?? []), ...paths.filter(present)])];
  return {
    ...sandbox,
    filesystem: {
      ...filesystem,
      denyRead: merged('denyRead', [...denials.denyRead, ...(claudeTmp?.denyRead ?? [])]),
      denyWrite: merged('denyWrite', denials.denyWrite),
      ...(claudeTmp === undefined ? {} : { allowRead: merged('allowRead', claudeTmp.allowRead), allowWrite: merged('allowWrite', claudeTmp.allowWrite) }),
    },
  };
}
