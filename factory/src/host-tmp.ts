// The host's temporary folder as the factory's Claude sessions see it. Claude Code's sandbox mounts
// the host's / read-only and keeps the host's /tmp, where other programs keep their Unix sockets (a
// browser extension's bridge, Chrome's SingletonSocket, other Claude sessions' proxy bridges) and
// other Claude sessions their tool output (/tmp/claude-<uid>). So every sandboxed Claude session the
// factory starts denies reading the temporary roots (tmpRoots) and reads back, by allowRead, only
// the paths it keeps under them (claudeTmpRule): a more specific denyRead inside a kept path still
// wins. The file-tool guard refuses the rest to the tools, by real path (TMP_REFUSAL). Each session
// gets a temporary folder of its own (makeSessionTmp), passed as CLAUDE_CODE_TMPDIR, so Claude Code
// keeps its own files and sockets there instead of in the shared /tmp/claude-<uid>.
// Also where the user's Unix sockets live (socketLocations), which every session denies.
import { rmSync } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { within } from './test-command.js';

// The read lists of a Claude session's sandbox for the temporary roots: denyRead the roots,
// allowRead the kept paths under them, allowWrite those of them the session writes.
export interface ClaudeTmp {
  denyRead: string[];
  allowRead: string[];
  allowWrite: string[];
}

// The file-tool guard's reason for a path in a temporary root outside the kept paths.
export const TMP_REFUSAL = "the host's temporary folder is outside this job";

// The prefix of a session's own temporary folder under os.tmpdir(), followed by the pid of the
// process that made it and "-": short, since Claude Code puts sockets there.
export const SESSION_TMP_PREFIX = 'sf-claude-';
// A session folder's name, its maker's pid captured.
const SESSION_TMP_NAME = /^sf-claude-(\d+)-/;

// A path's real path; undefined when it does not resolve.
const realOrUndefined = (path: string): Promise<string | undefined> => realpath(path).catch(() => undefined);

// The temporary roots that exist: <systemRoot>/tmp (/tmp but in tests) and tmp (os.tmpdir()) when it
// is not under it, each by its path and its real path.
export async function tmpRoots(tmp = tmpdir(), systemRoot = '/'): Promise<string[]> {
  const system = join(systemRoot, 'tmp');
  const roots = new Set<string>();
  for (const root of [system, ...(within(resolve(tmp), system) ? [] : [resolve(tmp)])]) {
    const real = await realOrUndefined(root);
    if (real !== undefined) {
      roots.add(root).add(real);
    }
  }
  return [...roots];
}

// Whether a path lies in one of the temporary roots.
export const inTmpRoot = (path: string, roots: readonly string[]): boolean => roots.some((root) => within(path, root));

// A path a session keeps under the temporary roots; write: also in allowWrite.
export interface TmpKept {
  path: string | undefined;
  write: boolean;
}

// The session's read lists for the given roots: each kept path that exists and lies under a root, by
// each spelling (its path and its real path) that does, in allowRead, and in allowWrite too when it
// is written. With no root, nothing.
export async function claudeTmpRule(roots: readonly string[], keep: readonly TmpKept[]): Promise<ClaudeTmp> {
  const allowRead = new Set<string>();
  const allowWrite = new Set<string>();
  for (const { path, write } of keep) {
    const real = path === undefined ? undefined : await realOrUndefined(path);
    if (path === undefined || real === undefined) {
      continue;
    }
    for (const spelling of new Set([resolve(path), real])) {
      if (inTmpRoot(spelling, roots)) {
        allowRead.add(spelling);
        if (write) {
          allowWrite.add(spelling);
        }
      }
    }
  }
  return { denyRead: [...roots], allowRead: [...allowRead], allowWrite: [...allowWrite] };
}

// The temporary roots of a Claude session and its read lists for them (claudeTmpRule): its worktree,
// its temporary folder and a Task check's own folder (checkFolder) written; its checkout and the
// state directory read. A job session (one with a worktree) also writes its checkout's Git directory
// (gitDirOf), so that Claude Code can bind its config.lock there and the worktree's Git commands can
// write its objects, refs and worktrees/<name>; the rest of the checkout stays read only.
export interface TmpScope {
  worktree?: string | undefined;
  sessionTmp?: string | undefined;
  checkFolder?: string | undefined;
  checkout: string;
  stateDir: string;
  tmp: string;
  systemRoot: string;
}

// The Git directory that holds a checkout's config, read without Git: <checkout>/.git when it is a
// directory; when it is a file, the directory of its gitdir: line (relative to the checkout), or the
// common directory its commondir file names (relative to that directory). Undefined when any of it
// cannot be read; never throws.
async function gitDirOf(checkout: string): Promise<string | undefined> {
  const dotGit = join(checkout, '.git');
  const info = await stat(dotGit).catch(() => undefined);
  if (info?.isDirectory() === true) {
    return dotGit;
  }
  if (info?.isFile() !== true) {
    return undefined;
  }
  const line = (await readFile(dotGit, 'utf8').catch(() => '')).split(/\r?\n/).find((text) => text.startsWith('gitdir:'));
  const target = line?.slice('gitdir:'.length).trim();
  if (target === undefined || target === '') {
    return undefined;
  }
  const gitDir = resolve(checkout, target);
  // No commondir: the gitdir is the common directory. One there that cannot be read: nothing.
  const common = await readFile(join(gitDir, 'commondir'), 'utf8').then(
    (text) => text.trim(),
    (error: unknown) => ((error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : undefined),
  );
  if (common === undefined) {
    return undefined;
  }
  return common === '' ? gitDir : resolve(gitDir, common);
}

// The read lists of a Claude session for the temporary roots of its scope.
export async function claudeTmpOf(scope: TmpScope): Promise<ClaudeTmp> {
  return claudeTmpRule(await tmpRoots(scope.tmp, scope.systemRoot), [
    { path: scope.worktree, write: true }, { path: scope.sessionTmp, write: true }, { path: scope.checkFolder, write: true },
    { path: scope.worktree === undefined ? undefined : await gitDirOf(scope.checkout), write: true },
    { path: scope.checkout, write: false }, { path: scope.stateDir, write: false },
  ]);
}

// The session folders not yet removed, removed at the latest when the process exits (a session
// dropped without being closed). A process killed before it could remove its folders leaves them to
// sweepSessionTmps.
const liveFolders = new Set<string>();
let exitHooked = false;

// Whether a process runs (one of another user's counts).
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Removes the session folders under tmp whose process has ended: each a real folder of this user
// named sf-claude-<pid>-*, <pid> no longer running. Never throws.
export async function sweepSessionTmps(tmp = tmpdir()): Promise<void> {
  for (const name of await readdir(tmp).catch(() => [] as string[])) {
    const pid = SESSION_TMP_NAME.exec(name)?.[1];
    if (pid === undefined || running(Number(pid))) {
      continue;
    }
    const info = await lstat(join(tmp, name)).catch(() => undefined);
    if (info?.isDirectory() === true && info.uid === process.getuid?.()) {
      await rm(join(tmp, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// Makes a session's own temporary folder: mkdtemp(<tmp>/sf-claude-<pid>-), mode 0700, after the
// folders of ended processes are swept. Returns its real path.
export async function makeSessionTmp(tmp = tmpdir()): Promise<string> {
  await sweepSessionTmps(tmp);
  const dir = await realpath(await mkdtemp(join(tmp, `${SESSION_TMP_PREFIX}${process.pid}-`)));
  liveFolders.add(dir);
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', () => {
      for (const folder of liveFolders) {
        rmSync(folder, { recursive: true, force: true });
      }
    });
  }
  return dir;
}

// Removes a session's temporary folder and all in it; undefined does nothing. Never throws.
export async function removeSessionTmp(dir: string | undefined): Promise<void> {
  if (dir === undefined) {
    return;
  }
  liveFolders.delete(dir);
  await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => console.error(`The session's temporary folder ${dir} could not be removed: ${error instanceof Error ? error.message : String(error)}`));
}

// Where the user's Unix sockets live: the session bus and the systemd user manager in the
// runtime directory, the system bus, docker, containerd, podman, tailscaled, screen, X11, the SSH
// agents and tmux, under root (/ but in tests). Linux cannot allow sockets by path, so their
// locations are denied instead; a missing one is left out like every other.
export async function socketLocations(env: NodeJS.ProcessEnv, root: string): Promise<string[]> {
  const uid = process.getuid?.() ?? 'user';
  const at = (...parts: string[]): string => join(root, ...parts);
  const paths = [
    at('run', 'user', String(uid)), at('run', 'dbus'), at('var', 'run', 'dbus'), at('run', 'docker.sock'), at('var', 'run', 'docker.sock'),
    at('run', 'containerd'), at('run', 'podman'), at('run', 'tailscale'), at('var', 'run', 'tailscale'), at('run', 'screen'),
    at('tmp', '.X11-unix'), at('tmp', `tmux-${uid}`),
    ...(await readdir(at('tmp')).catch(() => [] as string[])).filter((name) => name.startsWith('ssh-')).map((name) => at('tmp', name)),
  ];
  if (env.XDG_RUNTIME_DIR !== undefined && isAbsolute(env.XDG_RUNTIME_DIR)) {
    paths.push(env.XDG_RUNTIME_DIR);
  }
  return paths;
}
