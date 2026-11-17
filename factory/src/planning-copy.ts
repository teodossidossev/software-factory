// sf planner setup <workspace>: the workspace's planning copy, the folder a Claude Code session
// plans its tickets in. The copy is <SF_PLANNING_DIR or ~/planning>/<workspace>, a clone of the
// workspace's origin made with the checkout's objects as a reference (dissociated), never a
// registered checkout, never inside or around one. The steps, in this order:
// 1. the copy's path, made real through its nearest existing folder, is refused when it is, holds or
//    lies inside a registered workspace's checkout;
// 2. the checkout's origin URL;
// 3. the clone (into a temporary sibling, then renamed), or for an existing copy a check that it is a
//    clone of that origin with a .git folder of its own, a fetch (a failure is a warning) and a
//    fast-forward of the base branch when the copy is on it and has no changes (a note otherwise);
// 3b. the repository's Claude Code configuration left out of the copy's working tree by a sparse
//    checkout (src/repository-config.ts), at every run: a failure stops the setup, a path tracked as
//    .claude itself is refused, a configuration file that stays is a warning;
// 4. /.claude/ in the copy's .git/info/exclude;
// 5. .claude and .claude/skills checked without following a link, and the paths written here (the
//    planner role's skills among them) refused when the repository tracks them;
// 6. the factory's planning-tasks skill copied into .claude/skills, then the planner role's skills
//    from the skills snapshot as it is (src/skills.ts; nothing synced);
// 7. .claude/planning-copy.md: where the user's request, rules and the workspace's English vision are;
// 7b. .claude/settings.local.json: permissions and sandbox replaced with plannerSettings' (read-only
//    tools, the shell in Claude Code's sandbox, the secrets denied), its hooks' Stop and Notification
//    with sf planner waiting, skillOverrides switching off every skill but the planner's and
//    syncClaudeAiSkills false, the file's other keys and hook events kept;
// 8. the factory's MCP server registered for that folder only (claude mcp, local scope: the token
//    stays in Claude Code's ~/.claude.json), removed and added again so a rotated token arrives;
// 9. the result, and what the user does next: accept Claude Code's trust dialog there once.
// Every message names paths relative to the planning folder, never an absolute path, except the
// result lines for the user's terminal; a file system error on the way is planning_copy_failed,
// its paths shown with the same placeholders.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic, writeFileAtomicWith } from './atomic.js';
import { checkName, UsageError } from './commands.js';
import { envFilePath, planningDir, stateDir } from './config.js';
import { CLONE_TIMEOUT_MS, FETCH_TIMEOUT_MS, GIT_TIMEOUT_MS, originUrl, reason } from './digest.js';
import { FactoryError } from './errors.js';
import { withoutHostTokens } from './forge.js';
import { type GitResult, runGit } from './git.js';
import { PACKAGE_ROOT } from './package-root.js';
import { plannerSessionCommand, recordLink } from './planner-session.js';
import { plannerWaiting } from './planner-waiting.js';
import { loadRegistry, resolveWorkspace } from './registry.js';
import { absoluteRule, claudeConfigDir, claudeUserSettings, HOME_CREDENTIALS } from './sandbox-denials.js';
import { DASHBOARD_TOKEN_FILE, MCP_TOKEN_FILE } from './secrets.js';
import { mcpBaseUrl, redactMcpToken, requireMcpToken, SERVER_NAME } from './server.js';
import { COPY_SPARSE_PATTERNS, repositoryConfigIn } from './repository-config.js';
import { requestFile } from './setup.js';
import { readRoles, SKILL_NAME } from './skill-roles.js';
import { skillsSnapshot } from './skills.js';
import { tunnelProfile } from './tunnel.js';
import { visionIndex, visionRoot } from './vision.js';

export interface PlannerDeps {
  env: NodeJS.ProcessEnv;           // process.env (SF_PLANNING_DIR, HOME, PATH)
  stateDir: string;                 // config.ts stateDir(env)
  configDir: string;                // registry.ts configDir(env)
  mcpPort: () => Promise<number>;   // cli.ts mcpPort
  print: (line: string) => void;    // one line to stdout
}

export const PLANNER_USAGE: readonly string[] = [
  "  sf planner setup <workspace>                          Prepare the workspace's planning copy for Claude Code: <SF_PLANNING_DIR or ~/planning>/<workspace>, cloned or fast-forwarded, the factory's MCP server for that folder, the planning skill and .claude/planning-copy.md",
  "  sf planner waiting <workspace> [permission]           The planning copy's hook (Stop; Notification with permission): tells you that the planner waits for you, through the factory's notifications",
  "  sf planner start <workspace> <ticket>                 Start the ticket's planner: Claude Code with Remote Control in the workspace's planning copy (set up and trusted), its first message /planning-tasks workspace <workspace>, ticket <ticket>; one per ticket; it keeps running when sf serve restarts; again while it runs: since when, and its link once known",
  "  sf planner stop <workspace> <ticket>                  End the ticket's planner session",
];

// Every Git command here: never a prompt (the values of the digest's).
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
// Each claude mcp run may take this long; past it the child is killed.
const CLAUDE_TIMEOUT_MS = 60_000;
// The tail of a failed claude mcp's output that its error quotes, and what is kept of each stream.
const OUTPUT_CHARS = 300;
const KEPT_OUTPUT_CHARS = 64 * 1024;
const SKILL = 'planning-tasks';
// The factory's package folder (its messages' <factory>) and the skill copied from it.
const FACTORY_DIR = fileURLToPath(PACKAGE_ROOT).replace(/\/+$/, '');
const SKILL_SOURCE = join(FACTORY_DIR, 'skills', SKILL);
const POINTERS = '.claude/planning-copy.md';
const SETTINGS = '.claude/settings.local.json';
const EXCLUDE_LINE = '/.claude/';

// The planner's tools: the factory's MCP tools and reading tools; every other tool but the
// sandboxed shell asks first.
const ALLOWED_TOOLS = [`mcp__${SERVER_NAME}`, 'Read', 'Grep', 'Glob', 'Skill', 'Agent', 'Task', 'TodoWrite', 'ToolSearch'];
// Writing tools, and the web: a search query or a fetched URL could carry what the planner read.
const DENIED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebFetch(domain:*)', 'WebSearch'];
// The folders of HOME_CREDENTIALS (its other entries are files).
const HOME_CREDENTIAL_FOLDERS = new Set(['.ssh', '.codex', '.aws', '.config/gh']);
// Credentials in the home directory beyond HOME_CREDENTIALS, true for a folder: GnuPG, Kubernetes,
// GitLab's CLI and Docker's registry logins.
const MORE_HOME_SECRETS: Array<[string, boolean]> = [['.gnupg', true], ['.kube', true], ['.config/glab-cli', true], ['.docker/config.json', false]];

export interface PlannerSettings {
  permissions: { allow: string[]; deny: string[] };
  sandbox: { enabled: true; failIfUnavailable: true; autoAllowBashIfSandboxed: true; allowUnsandboxedCommands: false; filesystem: { denyWrite: string[]; denyRead: string[] } };
}

// The settings of a planning copy for the environment env (SF_ENV_FILE and SF_CONFIG_DIR through
// envFilePath, HOME, CLAUDE_CONFIG_DIR, TUNNEL_CLIENT_PROFILE_DIR, XDG_CONFIG_HOME) and the
// factory's state directory stateDir (the token rules and denyRead follow this argument).
// The shell's boundary is the sandbox, not a list of commands: it writes nowhere (the factory is the
// copy's only writer), reaches no network and cannot see the state folder (its socket, jobs and
// tokens); without a working sandbox the session does not start. The Read tool still reads the
// user's request files under the state folder. The secret files are denied to every tool.
export function plannerSettings(env: NodeJS.ProcessEnv, stateDir: string): PlannerSettings {
  const home = env.HOME || homedir();
  const envFile = envFilePath(env);
  const configDir = claudeConfigDir(env, home);
  // Each secret path, true for a folder, in the order of the rules.
  const files = (paths: string[]): Array<[string, boolean]> => paths.map((path) => [path, false]);
  const secrets: Array<[string, boolean]> = [
    ...files(envFile === undefined ? [] : [envFile]),
    ...files([join(stateDir, MCP_TOKEN_FILE), join(stateDir, DASHBOARD_TOKEN_FILE)]),
    ...files(claudeUserSettings(env, home)),
    [join(configDir, '.credentials.json'), false],
    [join(configDir, 'backups'), true],
    ...HOME_CREDENTIALS.map((path): [string, boolean] => [join(home, path), HOME_CREDENTIAL_FOLDERS.has(path)]),
    ...MORE_HOME_SECRETS.map(([path, folder]): [string, boolean] => [join(home, path), folder]),
    [tunnelProfile(env, home), false],
  ];
  // A path an earlier step gave keeps its place and is not repeated.
  const seen = new Set<string>();
  const reads = secrets.filter(([path]) => !seen.has(path) && seen.add(path)).map(([path, folder]) => `Read(${absoluteRule(path)}${folder ? '/**' : ''})`);
  return {
    permissions: { allow: [...ALLOWED_TOOLS], deny: [...DENIED_TOOLS, ...reads] },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      // The path as it is: the sandbox's path lists have no escape for glob characters.
      filesystem: { denyWrite: ['.'], denyRead: [`/${stateDir}`] },
    },
  };
}

// The skill folders a planning copy's settings switch off: each entry of personal (the user's
// Claude Code skills folder) and of own (the copy's .claude/skills) whose name has SKILL_NAME's
// form, is not in keep and holds a SKILL.md file (links followed); once each, sorted by name. A
// folder that is missing or cannot be read adds no name.
export async function skillsOff(personal: string, own: string, keep: readonly string[]): Promise<string[]> {
  const names = new Set<string>();
  for (const folder of [personal, own]) {
    for (const entry of await readdir(folder).catch((): string[] => [])) {
      if (SKILL_NAME.test(entry) && !keep.includes(entry) && (await stat(join(folder, entry, 'SKILL.md')).then((info) => info.isFile(), () => false))) {
        names.add(entry);
      }
    }
  }
  return [...names].sort();
}

// The arguments of sf planner waiting: waiting <workspace> [permission].
export function isPlannerWaiting(args: readonly string[]): boolean {
  return args[0] === 'waiting' && (args.length === 2 || (args.length === 3 && args[2] === 'permission'));
}

// sf planner waiting <workspace> [permission] (src/planner-waiting.ts), the planning copy's hook,
// which exits 0 whatever happens: setup (the CLI's environment file and config folder) that throws,
// or a name checkName refuses, is one line on stderr and nothing is sent. Before it sends, the
// session's link goes into its ticket's record (recordLink, for a session sf planner start started).
export async function plannerWaitingCommand(args: readonly string[], setup: () => { env: NodeJS.ProcessEnv; configDir: string }): Promise<void> {
  let deps: { env: NodeJS.ProcessEnv; configDir: string };
  let workspace: string;
  let state: string;
  try {
    deps = setup();
    workspace = checkName(args[1]);
    state = stateDir(deps.env);
  } catch (error) {
    console.error(`sf planner waiting: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  await recordLink(workspace, { env: deps.env, stateDir: state });
  await plannerWaiting(workspace, args.length === 3, { ...deps, stdin: process.stdin });
}

// sf planner setup <workspace>, sf planner waiting <workspace> [permission], and sf planner
// start|stop <workspace> <ticket> (src/planner-session.ts).
export async function plannerCommand(args: string[], deps: PlannerDeps): Promise<void> {
  if (isPlannerWaiting(args)) {
    await plannerWaitingCommand(args, () => ({ env: deps.env, configDir: deps.configDir }));
    return;
  }
  if (args.length === 3 && (args[0] === 'start' || args[0] === 'stop')) {
    await plannerSessionCommand(args, deps);
    return;
  }
  if (args.length !== 2 || args[0] !== 'setup') {
    throw new UsageError('planner needs setup <workspace>, waiting <workspace> [permission], start <workspace> <ticket> or stop <workspace> <ticket>.');
  }
  const name = checkName(args[1]);
  const ws = await resolveWorkspace(name, deps.configDir);

  // 1. Where.
  const dir = planningDir(deps.env);
  const copy = join(dir, name);
  const target = await nearestReal(copy);
  await refuseCheckouts(name, target, deps.configDir);

  // 2. The origin.
  const url = await originUrl(ws.readCheckout);
  if (url === undefined) {
    throw new FactoryError('no_origin', `${name}'s checkout has no origin remote to clone.`);
  }

  const temp = `${copy}.${randomUUID()}.tmp`;
  const relative = relativeTo([
    [temp, '<copy>.tmp'], [copy, '<copy>'], [target, '<copy>'], [dir, '<planning folder>'], [ws.readCheckout, '<checkout>'], [FACTORY_DIR, '<factory>'], [deps.stateDir, '<state dir>'],
    ...(url.startsWith('/') ? [[url, '<origin>'] as [string, string]] : []),
    ...(deps.env.HOME ? [[deps.env.HOME, '~'] as [string, string]] : []),
  ]);
  const planning: Planning = { name, checkout: ws.readCheckout, dir, copy, temp, url, relative };
  try {
    await prepare(planning, deps);
  } catch (error) {
    // A file system error names absolute paths: shown with the placeholders.
    if (error instanceof FactoryError) {
      throw error;
    }
    throw new FactoryError('planning_copy_failed', `Preparing ${name}'s planning copy failed: ${relative(error instanceof Error ? error.message : String(error))}`);
  }
}

// One run's workspace, paths and the placeholders of its messages.
interface Planning {
  name: string;
  checkout: string;
  dir: string;
  copy: string;
  temp: string;
  url: string;
  relative: (text: string) => string;
}

// Steps 3 to 9.
async function prepare(planning: Planning, deps: PlannerDeps): Promise<void> {
  const { name, copy } = planning;
  // 3. Clone or refresh.
  const { base, notes } = await cloneOrRefresh(planning);

  // 3b. The repository's Claude Code configuration left out.
  notes.push(...(await leaveConfigOut(planning)));

  // 4. The exclude.
  await excludeClaude(copy);

  // 5. The .claude folder, never through a link. The planner role's skills other than the
  // factory's own planning-tasks.
  const plannerSkills = (await readRoles(deps.stateDir)).planner.filter((skill) => skill !== SKILL);
  await prepareClaudeFolder(copy, name, plannerSkills);

  // 6. The skill.
  const skills = join(copy, '.claude', 'skills');
  await copyAfresh(SKILL_SOURCE, join(skills, SKILL));
  // The planner role's skills, copied from the skills snapshot as it is (its link read once); one it
  // lacks is a warning, and the copy keeps what it has at that path.
  const snapshot = await realpath(skillsSnapshot(deps.stateDir)).catch(() => undefined);
  const installed: string[] = [];
  for (const skill of plannerSkills) {
    if (snapshot !== undefined && (await stat(join(snapshot, skill)).then((info) => info.isDirectory(), () => false))) {
      await copyAfresh(join(snapshot, skill), join(skills, skill));
      installed.push(skill);
    } else {
      deps.print(`warning: the planner's skill ${skill} is not in the factory's skills snapshot; the copy goes without it (sf skills shows what is installed).`);
    }
  }

  // 7. The pointers.
  const text = await pointersText(name, base, deps);
  await writeFileAtomic(join(copy, POINTERS), Buffer.from(text, 'utf8'), 0o644);

  // 7b. The settings. Every other skill off for the planner, by name, and the claude.ai account's
  // skills; the factory sets both keys at every run.
  const home = deps.env.HOME || homedir();
  const off = await skillsOff(join(claudeConfigDir(deps.env, home), 'skills'), skills, [SKILL, ...plannerSkills]);
  await writeSettings(copy, name, deps, { skillOverrides: Object.fromEntries(off.map((skill) => [skill, 'off'])), syncClaudeAiSkills: false });

  // 8. The MCP server.
  const token = await requireMcpToken(deps.stateDir);
  const port = await deps.mcpPort();
  await registerMcp(planning, token, port, deps.env);

  // 9. The result.
  const short = out(await git(copy, ['rev-parse', '--short', 'HEAD']));
  for (const line of [
    ...notes,
    `Planning copy of ${name}: ${copy} (${base} at ${short})`,
    `MCP server ${SERVER_NAME}: registered for this folder only (Claude Code local scope)`,
    `${installed.length > 0 ? 'Skills' : 'Skill'} ${[SKILL, ...installed].join(', ')}: installed in .claude/skills`,
    `Skills switched off for the planner: ${off.length} of yours (skillOverrides), and your claude.ai skills (syncClaudeAiSkills false)`,
    `Pointers: ${POINTERS}`,
    "Settings: read-only; shell commands in Claude Code's sandbox (no writes, no network); secrets denied",
    'Hooks: the phone hears when the planner waits for you (sf planner waiting)',
    `Next: open Claude Code there once and accept its trust dialog: cd ${copy} && claude`,
    `Then plan a ticket: /${SKILL} workspace ${name}, ticket <ticket>`,
  ]) {
    deps.print(line);
  }
}

// The folder source copied to dest, whatever was at dest removed first (rm removes a link there
// itself, never its target).
async function copyAfresh(source: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await cp(source, dest, { recursive: true });
}

// A missing copy cloned; an existing one checked, fetched and its base branch fast-forwarded. The
// base branch, and the warning and note lines.
async function cloneOrRefresh({ name, checkout, dir, copy, temp, url, relative }: Planning): Promise<{ base: string; notes: string[] }> {
  const existing = await lstat(copy).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));
  if (existing === undefined) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const cloned = await git(dir, ['clone', '--quiet', '--reference', checkout, '--dissociate', '--', url, temp], CLONE_TIMEOUT_MS);
    const renamed = cloned.code === 0 ? await rename(temp, copy).then(() => undefined, (error: NodeJS.ErrnoException) => error.code ?? 'rename failed') : undefined;
    if (cloned.code !== 0 || renamed !== undefined) {
      await rm(temp, { recursive: true, force: true });
      throw new FactoryError('clone_failed', `Cloning ${name}'s origin failed: ${relative(renamed ?? why(cloned))}`);
    }
    return { base: await baseBranch(copy), notes: [] };
  }
  if (!existing.isDirectory() || !(await isCloneOf(copy, url))) {
    throw new FactoryError('planning_copy_unusable', `${name} in the planning folder is not a clone of ${name}'s origin: move it away and run sf planner setup again.`);
  }
  const fetched = await git(copy, ['fetch', '--quiet', '--prune', 'origin'], FETCH_TIMEOUT_MS);
  const base = await baseBranch(copy);
  if (fetched.code !== 0) {
    return { base, notes: [`warning: fetching ${name}'s origin failed (${relative(why(fetched))}); the copy stays as it was.`] };
  }
  return { base, notes: await fastForward(copy, base, relative) };
}

function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return runGit(cwd, args, 1024 * 1024, timeoutMs, GIT_ENV);
}

const out = (result: GitResult): string => result.stdout.toString('utf8').trim();

// The copy's base branch, as setup.ts's defaultBranch reads a checkout's (the branch origin/HEAD
// points at, else "main"), through this module's Git environment.
async function baseBranch(copy: string): Promise<string> {
  const result = await git(copy, ['symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD']);
  const match = /^origin\/(.+)$/.exec(out(result));
  return result.code === 0 && match !== null ? match[1]! : 'main';
}

// A failed Git command's reason: its error line, else that it timed out or its exit code.
function why(result: GitResult): string {
  return reason(result.stderr) || (result.code === null ? 'timed out' : `exit code ${result.code}`);
}

// text with each of the given absolute paths shown as its placeholder, the longest path first.
function relativeTo(paths: Array<[string, string]>): (text: string) => string {
  const sorted = paths.filter(([path]) => path !== '').sort(([a], [b]) => b.length - a.length);
  return (text) => sorted.reduce((result, [path, label]) => result.replaceAll(path, label), text);
}

// path made real through its nearest existing part: the real path of the longest prefix that
// exists (a link there followed, a dangling one by its target), the rest joined to it.
async function nearestReal(path: string, depth = 0): Promise<string> {
  const rest: string[] = [];
  let prefix = path;
  for (;;) {
    const real = await realpath(prefix).catch(() => undefined);
    if (real !== undefined) {
      return join(real, ...rest);
    }
    const link = depth < 40 ? await readlink(prefix).catch(() => undefined) : undefined;
    if (link !== undefined) {
      return nearestReal(join(resolve(dirname(prefix), link), ...rest), depth + 1);
    }
    const parent = dirname(prefix);
    if (parent === prefix) {
      return path;
    }
    rest.unshift(basename(prefix));
    prefix = parent;
  }
}

// a is b or holds it.
const holds = (a: string, b: string): boolean => a === b || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);

// Refuses a copy that is, holds or lies inside a registered workspace's checkout (one whose path
// cannot be made real is skipped).
async function refuseCheckouts(name: string, target: string, configDir: string): Promise<void> {
  const { workspaces } = await loadRegistry(configDir);
  for (const [other, entry] of Object.entries(workspaces)) {
    const checkout = await realpath(entry.read_checkout).catch(() => undefined);
    if (checkout !== undefined && (holds(checkout, target) || holds(target, checkout))) {
      throw new FactoryError('planning_copy_unusable', `The planning copy of ${name} would be the checkout of workspace ${other}: set SF_PLANNING_DIR to another folder.`);
    }
  }
}

// copy is the root of a Git work tree whose origin is url, with a repository of its own: .git a
// folder (not a link, not a worktree's file) that is its common Git directory, so a fetch never
// writes another repository's refs or objects.
async function isCloneOf(copy: string, url: string): Promise<boolean> {
  const real = await realpath(copy).catch(() => undefined);
  const dotGit = await lstat(join(copy, '.git')).catch(() => undefined);
  if (real === undefined || dotGit === undefined || !dotGit.isDirectory()) {
    return false;
  }
  const inside = await git(copy, ['rev-parse', '--is-inside-work-tree']);
  const top = await git(copy, ['rev-parse', '--show-toplevel']);
  const common = await git(copy, ['rev-parse', '--git-common-dir']);
  const origin = await git(copy, ['config', '--get', 'remote.origin.url']);
  return inside.code === 0 && out(inside) === 'true' && top.code === 0 && out(top) === real
    && common.code === 0 && resolve(real, out(common)) === join(real, '.git') && origin.code === 0 && out(origin) === url;
}

// After a fetch: the base branch fast-forwarded to origin's when the copy is on it without
// changes; the lines that say what was not done.
async function fastForward(copy: string, base: string, relative: (text: string) => string): Promise<string[]> {
  const branch = out(await git(copy, ['symbolic-ref', '--short', '--quiet', 'HEAD']));
  if (branch === '') {
    return ['note: the copy has a detached HEAD; nothing was fast-forwarded.'];
  }
  if (branch !== base) {
    return [`note: the copy is on ${branch}, not ${base}; nothing was fast-forwarded.`];
  }
  const status = await git(copy, ['status', '--porcelain', '--untracked-files=no']);
  if (status.code !== 0 || out(status) !== '') {
    return [`note: the copy has changes; ${base} was not fast-forwarded.`];
  }
  const merged = await git(copy, ['merge', '--ff-only', '--quiet', `origin/${base}`]);
  return merged.code === 0 ? [] : [`warning: ${base} could not be fast-forwarded (${relative(why(merged))}).`];
}

// The copy's sparse checkout set to COPY_SPARSE_PATTERNS, so its working tree loses the
// repository's Claude Code configuration (untracked files, the factory's own, stay). A failure
// stops the setup; a path tracked as .claude itself is refused; each configuration file the working
// tree still holds is a warning line.
async function leaveConfigOut({ name, copy, relative }: Planning): Promise<string[]> {
  // GIT_TIMEOUT_MS, git's default: 60 s.
  const set = await git(copy, ['sparse-checkout', 'set', '--no-cone', ...COPY_SPARSE_PATTERNS]);
  if (set.code !== 0) {
    throw new FactoryError('planning_copy_unsafe', `The planning copy of ${name} could not leave out the repository's Claude Code configuration: ${relative(why(set))}`);
  }
  const left = await repositoryConfigIn(copy);
  const whole = left.find((path) => path === '.claude' || path.endsWith('/.claude'));
  if (whole !== undefined) {
    throw new FactoryError('planning_copy_unsafe', `The repository tracks ${whole} as a link, a file or a submodule, not a folder: the planning copy of ${name} cannot leave its Claude Code configuration out.`);
  }
  return left.map((path) => `warning: ${path} stays in the planning copy of ${name}: it has changes of yours, or Git does not track it. Claude Code would load it there: remove it and run sf planner setup ${name} again.`);
}

// The copy's .git/info/exclude holds the line /.claude/ (appended when missing; the file created).
async function excludeClaude(copy: string): Promise<void> {
  const file = join(copy, '.git', 'info', 'exclude');
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));
  if (text !== undefined && text.split('\n').includes(EXCLUDE_LINE)) {
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${text === undefined || text === '' || text.endsWith('\n') ? '' : '\n'}${EXCLUDE_LINE}\n`);
}

// .claude and .claude/skills: each missing (made, mode 0700) or a folder, never a link; the paths
// this command writes, the folders of the planner's skills among them, must not be tracked by the
// repository.
async function prepareClaudeFolder(copy: string, name: string, planner: readonly string[]): Promise<void> {
  const subs = ['', '/skills'];
  const missing: string[] = [];
  for (const sub of subs) {
    const path = join(copy, `.claude${sub}`);
    const found = await lstat(path).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));
    if (found === undefined) {
      missing.push(path);
    } else if (!found.isDirectory()) {
      throw new FactoryError('planning_copy_unsafe', `.claude${sub} in ${name}'s planning copy is a link or not a folder: remove it and run sf planner setup again.`);
    }
  }
  const paths = [`.claude/skills/${SKILL}`, POINTERS, SETTINGS, ...planner.map((skill) => `.claude/skills/${skill}`)];
  const tracked = out(await git(copy, ['ls-files', '--', ...paths])).split('\n')[0];
  if (tracked !== undefined && tracked !== '') {
    throw new FactoryError('planning_copy_unsafe', `The repository of ${name} tracks ${tracked}, which the planning copy writes.`);
  }
  for (const path of missing) {
    await mkdir(path, { mode: 0o700 });
  }
}

// The text of .claude/planning-copy.md: the request's path, the user's rules files that exist
// (rules/<workspace>.md, then rules/global.md, once), and the workspace's English vision folder or
// that none is stored.
async function pointersText(name: string, base: string, deps: PlannerDeps): Promise<string> {
  const candidates = [...new Set([join(deps.configDir, 'rules', `${name}.md`), join(deps.configDir, 'rules', 'global.md')])];
  const rules: string[] = [];
  for (const path of candidates) {
    // A regular file (a link to one followed), as the rules reader takes it.
    if (await stat(path).then((info) => info.isFile(), () => false)) {
      rules.push(`\`${path}\``);
    }
  }
  const lines = [
    `# Planning copy of \`${name}\``,
    '',
    `This folder is the Software Factory's planning copy of the workspace \`${name}\`, on its base`,
    `branch \`${base}\`. Read it and plan with it; change nothing in it. Plan a ticket with the`,
    '`planning-tasks` skill.',
    '',
    "- **The user's request** of a ticket created on the dashboard, in their own words:",
    `  \`${requestFile(deps.stateDir, name, '<ticket>')}\``,
  ];
  if (rules.length > 0) {
    lines.push(
      "- **The user's rules for this workspace.** The Task check and the reviewers enforce them. Read",
      `  them before any test plan: ${rules.join(' and ')}`,
    );
  }
  // The store's English folder, read at each run; the Read tool reaches it, the sandboxed shell not.
  const visions = (await visionIndex(deps.stateDir)).visions;
  if (visions.some((entry) => entry.workspace === name && entry.languages.some((stored) => stored.lang === 'en'))) {
    lines.push(
      '- **The product vision** of this workspace, in English: the folder below. Read its `VISION.md`',
      '  first, with the Read tool (the shell does not see the folder), then what the ticket needs of',
      `  its \`CODEMAP.md\` and \`chapters/\`: \`${join(visionRoot(deps.stateDir), name, 'en')}\``,
    );
  } else {
    lines.push('- **The product vision:** none is stored for this workspace.');
  }
  return `${lines.join('\n')}\n`;
}

// The factory's sf, which the copy's hooks run.
const SF_BIN = fileURLToPath(new URL('bin/sf', PACKAGE_ROOT));
// The hooks' timeout, in seconds.
const HOOK_TIMEOUT_S = 30;

// text in single quotes for the shell, a ' inside written as '\''.
const shellQuoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

// The copy's Stop and Notification (permission prompt) hooks: sf planner waiting tells the user
// that the planner waits for them (src/planner-waiting.ts). Hooks run outside the sandbox.
function plannerHooks(name: string): Record<'Stop' | 'Notification', unknown[]> {
  const command = `${shellQuoted(SF_BIN)} planner waiting ${shellQuoted(name)}`;
  return {
    Stop: [{ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }],
    Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'command', command: `${command} permission`, timeout: HOOK_TIMEOUT_S }] }],
  };
}

// .claude/settings.local.json, missing or a regular file (never a link), a JSON object: its
// permissions and sandbox replaced whole with plannerSettings', its hooks' Stop and Notification
// with plannerHooks' (the other hook events kept), skillOverrides and syncClaudeAiSkills replaced
// whole with skills', every other key kept in its place (a new key last, in this order); written
// atomically with the file's mode, else 0600. The checks go by path: the planner cannot write in
// the copy and the factory is its only writer, so a link there comes only from the repository or
// an earlier tool.
async function writeSettings(copy: string, name: string, deps: PlannerDeps, skills: { skillOverrides: Record<string, string>; syncClaudeAiSkills: false }): Promise<void> {
  const path = join(copy, SETTINGS);
  const found = await lstat(path).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));
  if (found !== undefined && !found.isFile()) {
    throw new FactoryError('planning_copy_unsafe', `${SETTINGS} in ${name}'s planning copy is a link or not a file: remove it and run sf planner setup again.`);
  }
  let data: unknown = {};
  if (found !== undefined) {
    try {
      data = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      data = undefined;
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new FactoryError('planning_copy_unusable', `${SETTINGS} in ${name}'s planning copy is not a JSON object: fix or remove it.`);
  }
  const settings = plannerSettings(deps.env, deps.stateDir);
  const hooks = 'hooks' in data && typeof data.hooks === 'object' && data.hooks !== null && !Array.isArray(data.hooks) ? data.hooks : {};
  const written = { ...data, permissions: settings.permissions, sandbox: settings.sandbox, hooks: { ...hooks, ...plannerHooks(name) }, ...skills };
  const mode = found === undefined ? 0o600 : found.mode & 0o777;
  await writeFileAtomicWith(path, async (handle) => {
    await handle.chmod(mode);
    await handle.writeFile(`${JSON.stringify(written, null, 2)}\n`);
  }, mode);
}

// claude mcp remove (its exit code ignored), then claude mcp add, both in the copy, local scope.
async function registerMcp({ name, copy, relative }: Planning, token: string, port: number, env: NodeJS.ProcessEnv): Promise<void> {
  const failed = (output: string): FactoryError =>
    new FactoryError('planner_mcp_failed', `Registering the factory's MCP server for ${name}'s planning copy failed: ${relative(redactMcpToken(output, token))}`);
  const childEnv = withoutHostTokens(env);
  await runClaude(['mcp', 'remove', SERVER_NAME, '--scope', 'local'], copy, childEnv, failed);
  const added = await runClaude(
    ['mcp', 'add', '--scope', 'local', '--transport', 'http', SERVER_NAME, mcpBaseUrl(port), '--header', `Authorization: Bearer ${token}`], copy, childEnv, failed,
  );
  if (added.code !== 0) {
    // Redacted whole before the tail is cut, so no part of the token survives the cut.
    const tail = (text: string): string => redactMcpToken(text, token).trim().slice(-OUTPUT_CHARS);
    throw failed(tail(added.stderr) || tail(added.stdout));
  }
}

// One claude run: its exit code and output; claude_not_found when it is not on PATH, and
// planner_mcp_failed past CLAUDE_TIMEOUT_MS (the child killed).
function runClaude(args: string[], cwd: string, env: NodeJS.ProcessEnv, failed: (output: string) => FactoryError): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const keep = (text: string): string => text.slice(-KEPT_OUTPUT_CHARS);
    child.stdout.on('data', (chunk: Buffer) => (stdout = keep(stdout + chunk.toString('utf8'))));
    child.stderr.on('data', (chunk: Buffer) => (stderr = keep(stderr + chunk.toString('utf8'))));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CLAUDE_TIMEOUT_MS);
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT'
        ? new FactoryError('claude_not_found', 'Claude Code (claude) is not on PATH: install it, then run sf planner setup again.')
        : failed(error.code ?? 'claude could not be started'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(failed(`claude mcp timed out after ${CLAUDE_TIMEOUT_MS / 1000} s.`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}
