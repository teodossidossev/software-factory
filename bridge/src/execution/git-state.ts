// Read-only inspection of the application repository without running anything
// the repository could configure.
//
// Git applies clean filters (and other attribute-driven conversions) whenever it
// compares working-tree content: `git status`, `git diff` against the worktree
// and `git hash-object` all can, and repository configuration plus
// .git/info/attributes decide which command runs (reproduced on Git 2.43).
// So inside the repository only commands that never convert worktree content
// are used: rev-parse, config --get, check-attr, ls-files, ls-tree and
// cat-file. They run with `core.fsmonitor=false`, with `protocol.allow=never`
// (no lazy fetch in a partial clone, so no repository-configured transport),
// `--no-optional-locks` and without inherited GIT_* variables. Working-tree
// changes are found by hashing files here as Git blobs; diffs come from
// `git diff --no-index` in a temporary directory outside the repository, with
// system and global configuration and attribute files switched off.
// Paths with content conversions (filter, ident, working-tree-encoding, or
// eol/text/core.autocrlf on content with carriage returns) are reported, not
// exported: their raw bytes are not what Git stores. Nothing here stages, commits, resets or cleans.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isForbidden } from '../repo-files.js';
import { ExecutionError } from './errors.js';

// The adapter's own area in the application repository (instruction copies).
export const ADAPTER_DIR = '.software-factory';
// The mediator's state directory. Left out of the inspection only for a self-hosted app, whose
// repository is the mediator checkout (app-config.ts, inspectorOptions).
export const MEDIATOR_STATE_DIR = 'factory-data';
// Bound of the pre-existing work baseline of a self-hosted job (paths with uncommitted changes).
export const MAX_BASELINE_PATHS = 20_000;
const MAX_FINGERPRINT_BYTES = 64 * 1024 * 1024;
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
// Per-file content read for a diff; larger files are listed without content.
const MAX_FILE_BYTES = 1024 * 1024;
// Ignored directories are walked for credential-style files up to these bounds.
const MAX_IGNORED_WALK = 200_000;
const MAX_CREDENTIAL_FILES = 1000;
const MAX_CREDENTIAL_HASH_BYTES = 64 * 1024 * 1024;
const CHECK_ATTR_BATCH = 200;
const CONVERSION_ATTRIBUTES = ['filter', 'eol', 'text', 'ident', 'working-tree-encoding'];

const MODE_EXECUTABLE = '100755';
const MODE_SYMLINK = '120000';
const MODE_GITLINK = '160000';

export interface GitSnapshot {
  head: string | null;
  index_sha256: string;
  // Working-tree changes against the index plus untracked files, outside the adapter's own area.
  changes: Array<{ status: 'M' | 'D' | 'T' | '??'; path: string }>;
}

export interface InspectorOptions {
  // Top-level directories (repository-relative, no slash) left out of every listing: tracked,
  // untracked and ignored entries alike. Their content is never inspected or exported.
  ownState?: string[];
}

// The uncommitted work that existed before a job (self-hosting), by path: a content fingerprint
// of each path whose working-tree state differs from HEAD (tracked changes, staged additions and
// untracked files). Hashes only: no content is copied. A Map, never an object keyed by path: a
// path such as __proto__ must stay an ordinary entry.
export type PreexistingWork = Map<string, string>;

export interface ExportLimits {
  maxDiffBytes: number;
  maxFiles: number;
}

interface TreeEntry {
  mode: string;
  oid: string;
}

export interface ChangeSet {
  // Changed tracked paths (against the base tree) and new untracked paths.
  tracked: string[];
  untracked: string[];
  base: Map<string, TreeEntry>;
}

export interface ChangeExport {
  // Null when everything within the limits was processed; otherwise why the export stopped (then no diff).
  stopped: string | null;
  diff: string;
  newFiles: Array<{ path: string; bytes: number; sha256: string; note: string }>;
}

export interface IgnoredState {
  // Ignored entries as Git lists them (directories collapsed, ending in "/").
  entries: string[];
  // Credential-style ignored entries, also inside ignored directories: content
  // sha256 (size/mtime/inode when too large to hash) for files, "symlink:<sha256
  // of the target bytes>" for symlinks, "other:<type>" for anything else.
  // Kept only in the private baseline, never in ChatGPT-readable files.
  credentials: Record<string, string>;
  // False when an ignored directory could not be checked completely (too large or unreadable).
  complete: boolean;
}

interface GitResult {
  code: number;
  stdout: Buffer;
  overflow: boolean;
}

interface Entry {
  kind: 'file' | 'symlink' | 'other' | 'missing';
  size: number;
  content?: Buffer;
  executable?: boolean;
}

const within = (dir: string, path: string): boolean => path === dir || path === `${dir}/` || path.startsWith(`${dir}/`);
const isAdapterPath = (path: string): boolean => within(ADAPTER_DIR, path);
const hasGitSegment = (path: string): boolean => path.split('/').includes('.git');

// The caller's environment without GIT_* variables; for diffs outside the
// repository also without system and global configuration.
export function gitEnvironment(isolated = false): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return isolated ? { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: tmpdir() } : env;
}

function runGit(args: string[], cwd: string | undefined, isolated: boolean): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: MAX_GIT_OUTPUT, timeout: 120_000, env: gitEnvironment(isolated), encoding: 'buffer' }, (error, stdout) => {
      const overflow = (error as { code?: unknown } | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout: stdout ?? Buffer.alloc(0), overflow });
    });
  });
}

// "<meta>\t<path>" records of ls-files --stage / ls-tree -z output.
function parseEntries(output: Buffer, fields: (meta: string[]) => TreeEntry): Array<TreeEntry & { path: string }> {
  return output
    .toString('utf8')
    .split('\0')
    .filter((line) => line !== '')
    .map((line) => ({ ...fields(line.slice(0, line.indexOf('\t')).split(' ')), path: line.slice(line.indexOf('\t') + 1) }));
}

// A working-tree entry without following symlinks: up to maxBytes of a regular
// file (size from the open handle), or the raw link target of a symlink.
async function readEntry(path: string, maxBytes: number): Promise<Entry> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { kind: 'missing', size: 0 };
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    const target = await readlink(path, { encoding: 'buffer' });
    return { kind: 'symlink', size: target.length, content: target };
  }
  if (!stats.isFile()) {
    return { kind: 'other', size: stats.size };
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    // Git records only the owner's execute bit.
    const executable = (current.mode & 0o100) !== 0;
    if (current.size > maxBytes) {
      return { kind: 'file', size: current.size, executable };
    }
    const buffer = Buffer.alloc(current.size);
    const { bytesRead } = await handle.read(buffer, 0, current.size, 0);
    return { kind: 'file', size: bytesRead, content: buffer.subarray(0, bytesRead), executable };
  } finally {
    await handle.close();
  }
}

// What a working-tree path holds, without following symlinks: "missing", the sha256 of a regular
// file's content (size, mtime and inode beyond 64 MiB), "symlink:<sha256 of the target bytes>" or
// "other:<type>". Equal fingerprints mean the path was left as it was.
export async function contentFingerprint(path: string): Promise<string> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return 'missing';
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return `symlink:${createHash('sha256').update(await readlink(path, { encoding: 'buffer' })).digest('hex')}`;
  }
  if (!stats.isFile()) {
    return `other:${stats.isDirectory() ? 'directory' : 'special'}`;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    // The execute bit is part of what Git records.
    const mode = (current.mode & 0o100) !== 0 ? 'x' : '-';
    if (current.size > MAX_FINGERPRINT_BYTES) {
      return `large:${mode}:${current.size}:${current.mtimeMs}:${current.ino}`;
    }
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
    return `${mode}:${hash.digest('hex')}`;
  } finally {
    await handle.close();
  }
}

// sha256 of a credential-style file, or size/mtime/inode when it is too large to hash.
async function credentialFingerprint(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (stats.size > MAX_CREDENTIAL_HASH_BYTES) {
      return `meta:${stats.size}:${stats.mtimeMs}:${stats.ino}`;
    }
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

// A credential-style entry's fingerprint by type; symlinks are never followed.
async function entryFingerprint(path: string, stats: Stats): Promise<string> {
  if (stats.isSymbolicLink()) {
    return `symlink:${createHash('sha256').update(await readlink(path, { encoding: 'buffer' })).digest('hex')}`;
  }
  if (stats.isFile()) {
    return credentialFingerprint(path);
  }
  const type = stats.isFIFO() ? 'fifo' : stats.isSocket() ? 'socket' : stats.isBlockDevice() ? 'block-device' : 'character-device';
  return `other:${type}`;
}

export class GitInspector {
  readonly #repo: string;
  readonly #ownState: string[];
  #objectFormat: 'sha1' | 'sha256' | undefined;
  #fileMode: boolean | undefined;
  #autocrlf: boolean | undefined;
  // Fixed commands the inspector ran: per command, how often and with which exit codes.
  readonly #log = new Map<string, Set<number> & { runs?: number }>();

  constructor(repo: string, options: InspectorOptions = {}) {
    this.#repo = repo;
    this.#ownState = options.ownState ?? [];
  }

  // The adapter's area and, for a self-hosted app, the mediator's own state are never inspected.
  #excluded(path: string): boolean {
    return isAdapterPath(path) || this.#ownState.some((dir) => within(dir, path));
  }

  // The commands run, aggregated, for checks.md.
  get log(): Array<{ check: string; runs: number; exit_codes: number[] }> {
    return [...this.#log].map(([check, codes]) => ({ check, runs: codes.runs ?? 0, exit_codes: [...codes].sort() }));
  }

  #record(label: string, code: number): void {
    const codes = this.#log.get(label) ?? Object.assign(new Set<number>(), { runs: 0 });
    codes.add(code);
    codes.runs = (codes.runs ?? 0) + 1;
    this.#log.set(label, codes);
  }

  async #git(label: string, args: string[], okCodes = [0]): Promise<GitResult> {
    const result = await runGit(
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-C', this.#repo, ...args],
      undefined,
      false,
    );
    this.#record(label, result.code);
    if (result.overflow) {
      throw new ExecutionError('git_failed', `git ${label}: output too large to inspect.`);
    }
    if (!okCodes.includes(result.code)) {
      throw new ExecutionError('git_failed', `git ${label} failed (exit ${result.code}).`);
    }
    return result;
  }

  async #config(key: string): Promise<string | undefined> {
    const result = await this.#git('config --get (settings)', ['config', '--get', key], [0, 1]);
    return result.code === 0 ? result.stdout.toString().trim().toLowerCase() : undefined;
  }

  async #format(): Promise<'sha1' | 'sha256'> {
    if (this.#objectFormat === undefined) {
      const out = (await this.#git('rev-parse --show-object-format', ['rev-parse', '--show-object-format'])).stdout.toString().trim();
      this.#objectFormat = out === 'sha256' ? 'sha256' : 'sha1';
    }
    return this.#objectFormat;
  }

  // core.fileMode=false: the execute bit is not compared.
  async #compareFileMode(): Promise<boolean> {
    this.#fileMode ??= (await this.#config('core.filemode')) !== 'false';
    return this.#fileMode;
  }

  // The Git blob id of content, computed here (what `git hash-object --no-filters` would print).
  async #blobId(content: Buffer): Promise<string> {
    return createHash(await this.#format())
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest('hex');
  }

  async #index(): Promise<{ entries: Array<TreeEntry & { path: string }>; fingerprint: string }> {
    const result = await this.#git('ls-files --stage (index)', ['ls-files', '--stage', '-z']);
    return {
      entries: parseEntries(result.stdout, ([mode, oid]) => ({ mode: mode!, oid: oid! })),
      fingerprint: createHash('sha256').update(result.stdout).digest('hex'),
    };
  }

  async #untracked(): Promise<string[]> {
    const result = await this.#git('ls-files --others --exclude-standard (untracked)', ['ls-files', '--others', '--exclude-standard', '-z']);
    return result.stdout.toString('utf8').split('\0').filter((path) => path !== '' && !this.#excluded(path));
  }

  // The status letter of a worktree entry against (mode, oid) as Git would store it
  // without conversions, or null when it is unchanged. Regular files are hashed as a stream.
  async #status(path: string, entry: TreeEntry): Promise<'M' | 'D' | 'T' | null> {
    if (entry.mode === MODE_GITLINK) {
      // Submodule commits are not inspected.
      return null;
    }
    const full = join(this.#repo, path);
    const current = await readEntry(full, 0);
    if (current.kind === 'missing') {
      return 'D';
    }
    const isLink = entry.mode === MODE_SYMLINK;
    if ((current.kind === 'symlink') !== isLink || current.kind === 'other') {
      return 'T';
    }
    if (isLink) {
      return (await this.#blobId(current.content!)) === entry.oid ? null : 'M';
    }
    if ((await this.#compareFileMode()) && (entry.mode === MODE_EXECUTABLE) !== current.executable) {
      return 'M';
    }
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const size = (await handle.stat()).size;
      const hash = createHash(await this.#format()).update(`blob ${size}\0`);
      let read = 0;
      for await (const chunk of handle.createReadStream()) {
        read += (chunk as Buffer).length;
        hash.update(chunk as Buffer);
      }
      return read === size && hash.digest('hex') === entry.oid ? null : 'M';
    } finally {
      await handle.close();
    }
  }

  async snapshot(): Promise<GitSnapshot> {
    const head = await this.#git('rev-parse --verify HEAD', ['rev-parse', '--verify', '-q', 'HEAD'], [0, 1]);
    const index = await this.#index();
    const changes: GitSnapshot['changes'] = [];
    for (const entry of index.entries) {
      if (this.#excluded(entry.path)) {
        continue;
      }
      const status = await this.#status(entry.path, entry);
      if (status !== null) {
        changes.push({ status, path: entry.path });
      }
    }
    for (const path of await this.#untracked()) {
      changes.push({ status: '??', path });
    }
    return { head: head.code === 0 ? head.stdout.toString().trim() : null, index_sha256: index.fingerprint, changes };
  }

  // How many of the paths have content conversions, read with check-attr.
  // filter, ident and working-tree-encoding always convert. eol, text and
  // core.autocrlf only change line endings, so they count only for a file whose
  // working-tree content contains a carriage return.
  async conversions(paths: string[]): Promise<number> {
    if (paths.length === 0) {
      return 0;
    }
    this.#autocrlf ??= ['true', 'input'].includes((await this.#config('core.autocrlf')) ?? '');
    const always = new Set<string>();
    const lineEndings = new Set<string>(this.#autocrlf ? paths : []);
    for (let start = 0; start < paths.length; start += CHECK_ATTR_BATCH) {
      const batch = paths.slice(start, start + CHECK_ATTR_BATCH);
      const result = await this.#git('check-attr (content conversions)', ['check-attr', '-z', ...CONVERSION_ATTRIBUTES, '--', ...batch]);
      const fields = result.stdout.toString('utf8').split('\0');
      for (let i = 0; i + 2 < fields.length; i += 3) {
        const [path, attribute, value] = [fields[i]!, fields[i + 1]!, fields[i + 2]!];
        if (value === 'unspecified' || value === 'unset') continue;
        (attribute === 'eol' || attribute === 'text' ? lineEndings : always).add(path);
      }
    }
    let count = always.size;
    for (const path of lineEndings) {
      if (!always.has(path) && (await this.#containsCarriageReturn(path))) count += 1;
    }
    return count;
  }

  async #containsCarriageReturn(path: string): Promise<boolean> {
    let handle;
    try {
      handle = await open(join(this.#repo, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      // Deleted or not a regular file: nothing in the working tree to convert.
      return false;
    }
    try {
      if (!(await handle.stat()).isFile()) return false;
      for await (const chunk of handle.createReadStream()) {
        if ((chunk as Buffer).includes(0x0d)) return true;
      }
      return false;
    } finally {
      await handle.close();
    }
  }

  // Ignored entries, and credential-style ignored files including those inside
  // collapsed ignored directories (not inside nested .git directories).
  // Unreadable or oversized ignored trees make the result incomplete instead of failing.
  async ignored(): Promise<IgnoredState> {
    const result = await this.#git('ls-files --others --ignored (ignored)', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
    const entries = result.stdout.toString('utf8').split('\0').filter((path) => path !== '' && !this.#excluded(path));
    const credentials: Record<string, string> = {};
    let walked = 0;
    let complete = true;
    // Credential-style entries of any type: regular files by content, symlinks by
    // their own target bytes (never followed), anything else by its type alone.
    const record = async (path: string, stats: Stats): Promise<void> => {
      if (isForbidden(path) && !hasGitSegment(path)) {
        if (Object.keys(credentials).length >= MAX_CREDENTIAL_FILES) {
          complete = false;
          return;
        }
        credentials[path] = await entryFingerprint(join(this.#repo, path), stats);
      }
    };
    const walk = async (dir: string): Promise<void> => {
      for (const name of await readdir(join(this.#repo, dir))) {
        walked += 1;
        if (walked > MAX_IGNORED_WALK) {
          complete = false;
        }
        if (!complete) return;
        if (name === '.git') continue;
        const path = `${dir}${name}`;
        // lstat: a symlink to a directory is an entry here, never walked into.
        const stats = await lstat(join(this.#repo, path));
        if (stats.isDirectory()) {
          await walk(`${path}/`);
        } else {
          await record(path, stats);
        }
      }
    };
    try {
      for (const entry of entries) {
        if (!complete) break;
        if (hasGitSegment(entry)) continue;
        // Git lists an ignored symlink without a trailing slash; a "dir/" entry that is
        // a symlink anyway is recorded as one and never walked into.
        const stats = await lstat(join(this.#repo, entry));
        if (entry.endsWith('/') && stats.isDirectory()) {
          await walk(entry);
        } else {
          await record(entry.replace(/\/$/, ''), stats);
        }
      }
    } catch {
      // An entry that cannot be read (permissions, removed meanwhile) cannot be checked.
      complete = false;
    }
    return { entries, credentials, complete };
  }

  // Changed tracked paths since base (the HEAD before the session) and new untracked paths;
  // reads no file content into memory. A path base has is always compared with base, never listed
  // as new: an untracked file at such a path (its deletion staged, then recreated) is one change
  // against HEAD, or none when it has the HEAD content again.
  async changeSet(base: string | null, final: GitSnapshot): Promise<ChangeSet> {
    const baseEntries = new Map<string, TreeEntry>();
    if (base !== null) {
      const tree = await this.#git('ls-tree -r (base tree)', ['ls-tree', '-r', '-z', '--full-tree', base]);
      for (const entry of parseEntries(tree.stdout, ([mode, , oid]) => ({ mode: mode!, oid: oid! }))) {
        if (!this.#excluded(entry.path)) {
          baseEntries.set(entry.path, { mode: entry.mode, oid: entry.oid });
        }
      }
    }
    const index = await this.#index();
    const tracked: string[] = [];
    for (const [path, entry] of baseEntries) {
      if ((await this.#status(path, entry)) !== null) tracked.push(path);
    }
    for (const entry of index.entries) {
      if (!baseEntries.has(entry.path) && !this.#excluded(entry.path)) {
        tracked.push(entry.path);
      }
    }
    const untracked = final.changes.filter((change) => change.status === '??' && !baseEntries.has(change.path)).map((change) => change.path);
    return { tracked, untracked, base: baseEntries };
  }

  // The uncommitted work in the tree now, against base (the HEAD the job starts from): every path
  // the export would show (changeSet) plus every working-tree change against the index, each with
  // its content fingerprint. Throws baseline_too_large beyond MAX_BASELINE_PATHS paths.
  async preexisting(base: string | null): Promise<PreexistingWork> {
    const snapshot = await this.snapshot();
    const changes = await this.changeSet(base, snapshot);
    const paths = new Set([...changes.tracked, ...changes.untracked, ...snapshot.changes.map((change) => change.path)]);
    if (paths.size > MAX_BASELINE_PATHS) {
      throw new ExecutionError('baseline_too_large', `More than ${MAX_BASELINE_PATHS} paths have uncommitted changes; no baseline of the existing work was recorded.`);
    }
    const work: PreexistingWork = new Map();
    for (const path of [...paths].sort()) {
      work.set(path, await contentFingerprint(join(this.#repo, path)));
    }
    return work;
  }

  // The diff of a change set, built one file at a time and stopped as soon as a limit
  // is reached; then nothing of it is kept.
  async buildDiff(changes: ChangeSet, limits: ExportLimits): Promise<ChangeExport> {
    const empty: ChangeExport = { stopped: null, diff: '', newFiles: [] };
    if (changes.tracked.length + changes.untracked.length > limits.maxFiles) {
      return { ...empty, stopped: `More than ${limits.maxFiles} changed files.` };
    }
    const parts: string[] = [];
    const newFiles: ChangeExport['newFiles'] = [];
    let bytes = 0;
    const add = (text: string): boolean => {
      bytes += Buffer.byteLength(text);
      parts.push(text);
      return bytes <= limits.maxDiffBytes;
    };
    const tooLarge = (): ChangeExport => ({ ...empty, stopped: `The diff is larger than ${limits.maxDiffBytes} bytes.` });
    const work = await mkdtemp(join(tmpdir(), 'sf-export-'));
    try {
      for (const path of changes.tracked) {
        const old = changes.base.get(path);
        const current = await readEntry(join(this.#repo, path), MAX_FILE_BYTES);
        const newMode = current.kind === 'symlink' ? MODE_SYMLINK : current.kind === 'file' ? (current.executable ? MODE_EXECUTABLE : '100644') : null;
        const notes: string[] = [];
        if (old && newMode !== null && old.mode !== newMode) notes.push(`# ${path}: mode ${old.mode} -> ${newMode}\n`);
        if (current.kind === 'symlink' || old?.mode === MODE_SYMLINK) notes.push(`# ${path}: symlink; its target is shown as text\n`);
        if (current.kind === 'other') notes.push(`# ${path}: no longer a regular file; content not exported\n`);
        if (notes.length > 0 && !add(notes.join(''))) return tooLarge();
        if (current.kind === 'other') continue;
        const oldContent = old ? await this.#blob(old.oid) : Buffer.alloc(0);
        if (oldContent === undefined || (current.kind === 'file' && current.content === undefined)) {
          if (!add(`# ${path}: changed, larger than ${MAX_FILE_BYTES} bytes; content not exported\n`)) return tooLarge();
          continue;
        }
        const after = current.kind === 'missing' ? undefined : current.content!;
        if (!add(await this.#diffFiles(work, path, old ? oldContent : undefined, after))) return tooLarge();
      }
      for (const path of changes.untracked) {
        const current = await readEntry(join(this.#repo, path), MAX_FILE_BYTES);
        const note =
          current.kind !== 'file' ? 'not a regular file' : current.content === undefined ? 'too large' : current.content.subarray(0, 8192).includes(0) ? 'binary' : 'in implementation.diff';
        const sha256 = current.content ? createHash('sha256').update(current.content).digest('hex') : '';
        newFiles.push({ path, bytes: current.size, sha256, note });
        if (note === 'in implementation.diff' && !add(await this.#diffFiles(work, path, undefined, current.content!))) return tooLarge();
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    return { stopped: null, diff: parts.join(''), newFiles };
  }

  // A committed blob, or undefined when it is larger than the per-file limit.
  async #blob(oid: string): Promise<Buffer | undefined> {
    const size = Number((await this.#git('cat-file -s (blob size)', ['cat-file', '-s', oid])).stdout.toString().trim());
    if (size > MAX_FILE_BYTES) {
      return undefined;
    }
    return (await this.#git('cat-file blob (base content)', ['cat-file', 'blob', oid])).stdout;
  }

  // Unified diff of two contents via `git diff --no-index` outside any repository:
  // no repository attributes, no system/global configuration, no filters.
  async #diffFiles(work: string, path: string, before: Buffer | undefined, after: Buffer | undefined): Promise<string> {
    const side = async (name: 'a' | 'b', content: Buffer | undefined): Promise<string> => {
      if (content === undefined) return '/dev/null';
      const file = join(work, name, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
      return `${name}/${path}`;
    };
    const left = await side('a', before);
    const right = await side('b', after);
    const result = await runGit(
      ['-c', 'core.attributesFile=/dev/null', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=', '--dst-prefix=', '--', left, right],
      work,
      true,
    );
    this.#record('diff --no-index (outside the repository)', result.code);
    await rm(join(work, 'a'), { recursive: true, force: true });
    await rm(join(work, 'b'), { recursive: true, force: true });
    if (result.overflow || (result.code !== 0 && result.code !== 1)) {
      throw new ExecutionError('git_failed', `diff of a changed file failed (exit ${result.code}).`);
    }
    return result.stdout.toString('utf8');
  }
}
