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
// 4. /.claude/ in the copy's .git/info/exclude;
// 5. .claude and .claude/skills checked without following a link, and the paths written here
//    refused when the repository tracks them;
// 6. the factory's planning-tasks skill copied into .claude/skills;
// 7. .claude/planning-copy.md: where the user's request and rules are;
// 8. the factory's MCP server registered for that folder only (claude mcp, local scope: the token
//    stays in Claude Code's ~/.claude.json), removed and added again so a rotated token arrives;
// 9. the result, and what the user does next: accept Claude Code's trust dialog there once.
// Every message names paths relative to the planning folder, never an absolute path, except the
// result lines for the user's terminal; a file system error on the way is planning_copy_failed,
// its paths shown with the same placeholders.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, cp, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic.js';
import { checkName, UsageError } from './commands.js';
import { planningDir } from './config.js';
import { CLONE_TIMEOUT_MS, FETCH_TIMEOUT_MS, GIT_TIMEOUT_MS, originUrl, reason } from './digest.js';
import { FactoryError } from './errors.js';
import { withoutHostTokens } from './forge.js';
import { type GitResult, runGit } from './git.js';
import { PACKAGE_ROOT } from './package-root.js';
import { loadRegistry, resolveWorkspace } from './registry.js';
import { mcpBaseUrl, redactMcpToken, requireMcpToken, SERVER_NAME } from './server.js';
import { requestFile } from './setup.js';

export interface PlannerDeps {
  env: NodeJS.ProcessEnv;           // process.env (SF_PLANNING_DIR, HOME, PATH)
  stateDir: string;                 // config.ts stateDir(env)
  configDir: string;                // registry.ts configDir(env)
  mcpPort: () => Promise<number>;   // cli.ts mcpPort
  print: (line: string) => void;    // one line to stdout
}

export const PLANNER_USAGE: readonly string[] = [
  "  sf planner setup <workspace>                          Prepare the workspace's planning copy for Claude Code: <SF_PLANNING_DIR or ~/planning>/<workspace>, cloned or fast-forwarded, the factory's MCP server for that folder, the planning skill and .claude/planning-copy.md",
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
const EXCLUDE_LINE = '/.claude/';

// sf planner setup <workspace>.
export async function plannerCommand(args: string[], deps: PlannerDeps): Promise<void> {
  if (args.length !== 2 || args[0] !== 'setup') {
    throw new UsageError('planner needs setup <workspace>.');
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
    [temp, '<copy>.tmp'], [copy, '<copy>'], [target, '<copy>'], [dir, '<planning folder>'], [ws.readCheckout, '<checkout>'], [FACTORY_DIR, '<factory>'],
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

  // 4. The exclude.
  await excludeClaude(copy);

  // 5. The .claude folder, never through a link.
  await prepareClaudeFolder(copy, name);

  // 6. The skill (rm removes a link there itself, never its target).
  const skillDir = join(copy, '.claude', 'skills', SKILL);
  await rm(skillDir, { recursive: true, force: true });
  await cp(SKILL_SOURCE, skillDir, { recursive: true });

  // 7. The pointers.
  const text = await pointersText(name, base, deps);
  await writeFileAtomic(join(copy, POINTERS), Buffer.from(text, 'utf8'), 0o644);

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
    `Skill ${SKILL}: installed in .claude/skills`,
    `Pointers: ${POINTERS}`,
    `Next: open Claude Code there once and accept its trust dialog: cd ${copy} && claude`,
    `Then plan a ticket: /${SKILL} workspace ${name}, ticket <ticket>`,
  ]) {
    deps.print(line);
  }
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
// this command writes must not be tracked by the repository.
async function prepareClaudeFolder(copy: string, name: string): Promise<void> {
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
  const tracked = out(await git(copy, ['ls-files', '--', `.claude/skills/${SKILL}`, POINTERS])).split('\n')[0];
  if (tracked !== undefined && tracked !== '') {
    throw new FactoryError('planning_copy_unsafe', `The repository of ${name} tracks ${tracked}, which the planning copy writes.`);
  }
  for (const path of missing) {
    await mkdir(path, { mode: 0o700 });
  }
}

// The text of .claude/planning-copy.md: the request's path, and the user's rules files that exist
// (rules/<workspace>.md, then rules/global.md, once).
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
  return `${lines.join('\n')}\n`;
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
