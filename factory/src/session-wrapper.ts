// The bubblewrap wrapper the Implementer's Claude Code process runs under: the whole system
// read-only but the job's worktree, the session's temporary folder, the Claude Code state the CLI
// writes and a private, empty /tmp (Claude Code's Bash sandbox makes its socket there), so no
// write of the process (a file tool's through a link a command swapped in after the
// file-tool guard's check included) lands anywhere else. It hides the session's denyRead entries as
// the Codex gate's wrapper does (gateWrapper), but those the CLI itself needs. One more layer: Claude
// Code's own Bash sandbox, the path denials and the file-tool guard hold inside it as well.
// The Implementer's chosen skills (src/skills.ts: the user's installed skills, copied verbatim into
// the snapshot) are bound read-only, one folder each, where the CLI looks for the user's
// (<config dir>/skills), so /implement runs the snapshot's copy and no other skill is seen.
// The host's network namespace (Claude Code reaches the API) and no socket filter (the Bash sandbox,
// a bwrap nested inside, makes its own sockets). A missing bwrap or a wrapper that does not start
// fails the turn with sandbox_unavailable; Claude Code is never started unwrapped.
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Redactor } from './redact.js';
import { codexPackage, fixUp, hiding, mountPoint, type SandboxDenials } from './sandbox-denials.js';
import { WATCHED_PATHS, within } from './test-command.js';

export const SANDBOX_UNAVAILABLE = 'sandbox_unavailable';
export const BWRAP_MISSING = 'bwrap is required to run the Implementer and was not found.';

// The folders under Claude Code's configuration directory the CLI writes, bound read-write (made
// before the wrapper starts when missing).
export const CLAUDE_WRITTEN = ['projects', 'shell-snapshots', 'todos', 'statsig', 'session-env'] as const;

// The folder the wrapper replaces with an empty tmpfs of the session's own.
const PRIVATE_TMP = '/tmp';

// What the wrapper is built from: the job's worktree, the session's temporary folder
// (CLAUDE_CODE_TMPDIR), the home directory, Claude Code's configuration directory (CLAUDE_CONFIG_DIR,
// else ~/.claude) and its global config (~/.claude.json), the folders of the Implementer's skills (in
// the job's snapshot folder, or <state dir>/skills, a link to its current one) and the Claude Code
// executable the SDK starts (claudeExecutable).
export interface WrapperPaths {
  worktree: string;
  sessionTmp: string;
  home: string;
  claudeDir: string;
  globalConfig: string;
  skills: readonly string[];
  executable: string;
}

// The Claude Code executable of a spawn: the script after node, bun or deno, else the command.
export function claudeExecutable(options: Pick<SpawnOptions, 'command' | 'args'>): string {
  const runtime = /^(node|bun|deno)(\.exe)?$/.test(basename(options.command));
  return resolve(runtime && options.args[0] !== undefined ? options.args[0] : options.command);
}

// What the CLI needs of its own installation, read-only: the executable's real path, its nearest
// node_modules ancestor (else its folder, codexPackage), ~/.local/share/claude when it lives there
// (the native installer's versions), and node's prefix when a runtime starts it.
function installation(paths: WrapperPaths): string[] {
  const real = mountPoint(paths.executable);
  const nativeHome = mountPoint(join(paths.home, '.local', 'share', 'claude'));
  return [real, codexPackage(paths.executable), ...(within(real, nativeHome) ? [nativeHome] : []), dirname(dirname(mountPoint(process.execPath)))];
}

// The bwrap arguments, a later mount winning over an earlier one:
//   1. the whole system read-only, a new /dev and /proc (--unshare-pid), --die-with-parent, and a
//      private, empty, writable /tmp (--tmpfs /tmp): nothing of the host's /tmp is seen inside and
//      nothing written there reaches the host. It comes before every bind, so a bind under /tmp (the
//      session's temporary folder) is the host folder, mounted on top of it;
//   2. every denyRead entry not under /tmp hidden (hiding; the private /tmp hides the others), but
//      those the CLI needs: its credentials, its global config, its installation and the folders it
//      writes;
//   3. bound back read-only: the installation; read-write: the worktree, the session's temporary
//      folder, CLAUDE_WRITTEN, the credentials and the global config (prepareClaudeState makes them);
//   4. gateWrapper's fix-up pass: a denial inside a bind hidden again (a .env of the worktree), a
//      bind inside a denial bound again, the most specific path winning;
//   5. bound read-only again: the worktree's .git and agent configuration (WATCHED_PATHS), each
//      denyWrite entry inside a read-write bind that is not a denyRead one, and the user settings
//      (settings.json, settings.local.json), which the CLI reads. A path the CLI cannot reach
//      read-only is never shown again here but the user settings: a link of the worktree into a
//      hidden folder stays hidden;
//   6. last, an empty tmpfs on <config dir>/skills (skillsMount), over whatever was there, then each
//      of the Implementer's skill folders that exists (a link resolved when the wrapper is built, so
//      a later sync does not change a running session's) read-only at <config dir>/skills/<name>,
//      then the tmpfs made read-only: no other skill is seen, none can be added. Nothing when the
//      mount point is a dangling link.
export function implementerWrapper(denials: SandboxDenials, paths: WrapperPaths): string[] {
  const args = ['--die-with-parent', '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', PRIVATE_TMP];
  const credentials = join(paths.claudeDir, '.credentials.json');
  const written = CLAUDE_WRITTEN.map((name) => join(paths.claudeDir, name));
  const readOnly = [...new Set(installation(paths))];
  const readWrite = [...new Set([paths.worktree, paths.sessionTmp, ...written, credentials, paths.globalConfig].map(mountPoint))];
  const needed = new Set([...readOnly, ...readWrite, ...[credentials, paths.globalConfig, ...written].map(mountPoint)]);
  const denied = [...new Set(denials.denyRead.map(mountPoint))].filter((path) => !needed.has(path));
  for (const path of denied.filter((entry) => !within(entry, PRIVATE_TMP))) {
    args.push(...hiding(path));
  }
  const binds = new Map<string, string[]>([
    ...readOnly.filter(existsSync).map((path): [string, string[]] => [path, ['--ro-bind', path, path]]),
    ...readWrite.map((path): [string, string[]] => [path, ['--bind', path, path]]),
  ]);
  args.push(...[...binds.values()].flat(), ...fixUp(denied, binds));
  // A path inside a bind is shown when that bind is deeper than every denial holding it, as the mounts decide.
  const deepest = (path: string, dirs: Iterable<string>): number => Math.max(-1, ...[...dirs].filter((dir) => within(path, dir)).map((dir) => dir.split('/').length));
  const shown = (path: string): boolean => deepest(path, binds.keys()) > deepest(path, denied);
  const writable = (path: string): boolean => readWrite.some((dir) => within(path, dir));
  const deniedRead = new Set(denials.denyRead.map(mountPoint));
  const again = [
    ...WATCHED_PATHS.map((name) => join(paths.worktree, name)).filter(existsSync).map(mountPoint).filter(shown),
    ...denials.denyWrite.filter(existsSync).map(mountPoint).filter((path) => !deniedRead.has(path) && shown(path)),
  ].filter(writable);
  const settings = ['settings.json', 'settings.local.json'].map((name) => join(paths.claudeDir, name)).filter(existsSync).map(mountPoint);
  for (const path of new Set([...again, ...settings])) {
    args.push('--ro-bind', path, path);
  }
  if (existsSync(join(paths.claudeDir, 'skills'))) {
    const mount = skillsMount(paths.claudeDir);
    const binds = paths.skills.filter(existsSync).flatMap((skill) => ['--ro-bind', mountPoint(skill), join(mount, basename(skill))]);
    args.push('--tmpfs', mount, ...binds, '--remount-ro', mount);
  }
  return args;
}

// Where the skills are bound: <config dir>/skills, or the real path of a link there (the
// path the CLI reaches, which the home's tmpfs hides); the guard lets the Implementer read only the
// first spelling, <config dir>/skills.
const skillsMount = (claudeDir: string): string => mountPoint(join(claudeDir, 'skills'));

// Makes what the wrapper binds of Claude Code's state when it is missing, so the CLI can write it or
// bwrap can mount on it: the folders of CLAUDE_WRITTEN and skills, and its credentials and global
// config as an empty JSON object with mode 0600. An existing file stays as it is (exclusive create: nothing is overwritten
// and no link is followed).
export async function prepareClaudeState(claudeDir: string, globalConfig: string): Promise<void> {
  for (const name of CLAUDE_WRITTEN) {
    await mkdir(join(claudeDir, name), { recursive: true, mode: 0o700 });
  }
  // Not made (a dangling link there): the wrapper binds no skills, and the job shows skill_missing.
  await mkdir(join(claudeDir, 'skills'), { recursive: true, mode: 0o700 }).catch(() => undefined);
  for (const file of [join(claudeDir, '.credentials.json'), globalConfig]) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, '{}', { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
  }
}

// The most of bwrap's error output kept, and the first line of it a failure shows.
const STDERR_KEPT = 8192;
const LINE_MAX = 300;
const CLOSE_WAIT_MS = 2_000;

// The SDK's spawnClaudeCodeProcess for one query: the command, its arguments, cwd and environment
// unchanged inside bwrap (bwrapPath) with the wrapper of the given paths (the executable taken from
// the spawn). It remembers whether bwrap failed (an error, or an exit other than 0) and the start
// of its error output, which failure() turns into the turn's message.
export class WrappedSpawn {
  readonly #bwrap: string;
  readonly #denials: SandboxDenials;
  readonly #paths: Omit<WrapperPaths, 'executable'>;
  #stderr = '';
  #failed: string | undefined;
  // Settles once bwrap's output has closed (or it failed to start); none before a spawn.
  #closed: Promise<void> | undefined;
  #exitedCleanly = false;

  constructor(bwrapPath: string, denials: SandboxDenials, paths: Omit<WrapperPaths, 'executable'>) {
    this.#bwrap = bwrapPath;
    this.#denials = denials;
    this.#paths = paths;
  }

  readonly spawn = (options: SpawnOptions): SpawnedProcess => {
    let wrapper: string[];
    try {
      wrapper = implementerWrapper(this.#denials, { ...this.#paths, executable: claudeExecutable(options) });
    } catch (error) {
      this.#failed = `The Implementer's wrapper could not be built: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    }
    const chdir = options.cwd !== undefined && isAbsolute(options.cwd) ? ['--chdir', options.cwd] : [];
    const child = spawn(this.#bwrap, [...wrapper, ...chdir, '--', options.command, ...options.args], {
      cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#closed = new Promise((settle) => {
      child.once('close', () => settle());
      child.once('error', () => settle());
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(0, STDERR_KEPT);
    });
    child.on('error', (error) => {
      this.#failed ??= `bwrap could not be started: ${error.message}`;
    });
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        this.#failed ??= `bwrap exited with code ${code} before Claude Code answered.`;
      }
      this.#exitedCleanly = code === 0 && this.#failed === undefined;
    });
    return child;
  };

  // Why the wrapper failed, for a turn that ended before Claude Code answered: the first line of
  // bwrap's error output (else what failed), redacted; undefined when it did not fail. Waits for
  // bwrap's output to close, at most CLOSE_WAIT_MS, so its error line is in.
  async failure(): Promise<string | undefined> {
    // A bwrap that exited 0 failed nothing: no wait.
    if (this.#exitedCleanly) {
      return undefined;
    }
    if (this.#closed !== undefined) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.#closed, new Promise<void>((settle) => (timer = setTimeout(settle, CLOSE_WAIT_MS)))]);
      clearTimeout(timer);
    }
    if (this.#failed === undefined) {
      return undefined;
    }
    const line = this.#stderr.split('\n').map((entry) => entry.trim()).find((entry) => entry !== '');
    return new Redactor({ cwd: this.#paths.worktree, home: this.#paths.home }).text((line ?? this.#failed).slice(0, LINE_MAX));
  }
}
