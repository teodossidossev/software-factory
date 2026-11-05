// The file versions of a job's iterations for the dashboard's Changes screen (SF-079), read-only.
// The tree of the job's files after iteration N is the tree of N's base (the base_commit of its
// meta.json; job.base_commit for an older iteration while no MR preparation started) with N's
// Patch applied, built by Git in a temporary index; the new objects go into the job's own object
// directory (<job dir>/objects) with the workspace checkout's objects as alternates, so nothing is
// written into the checkout's repository, its index, its refs or the job's worktree. The tree id is
// kept in iterations/NNN/tree (derived; rebuilt when missing or when its objects are gone).
// A section of the Patch that holds no exact text (binary, not UTF-8, a submodule, the section a
// truncated Patch was cut in) is left out of the tree and its file marked binary or unavailable,
// so no wrong content is ever shown as real. The results are cached in an LRU per job.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { runGit } from './git.js';
import type { IterationMeta, Job, JobStore } from './jobs.js';
import { changedFiles, fileSections } from './patch.js';
import { resolveWorkspace } from './registry.js';
import { isForbidden } from './repo-files.js';
import { TASK_DIR } from './task-file.js';

// One side of one file is served up to this size.
export const MAX_FILE_BYTES = 1024 * 1024;
// A file list is cut after this many files (more: true).
export const MAX_LIST_FILES = 3000;
// Results kept in memory per job.
export const CACHE_ENTRIES = 16;

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface ListedFile {
  path: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  unavailable: boolean;
}

export type FileVersion =
  | { kind: 'text'; text: string }
  | { kind: 'absent' }
  | { kind: 'binary'; bytes: number | null }
  | { kind: 'too_large'; bytes: number }
  | { kind: 'unavailable'; reason: string };

export interface ChangesIndex {
  base: { ref: string; commit: string | null };
  iterations: Array<{ n: number; ended_at: string; truncated: boolean; base_commit: string | null }>;
}

export const CHECKOUT_MISSING = "The workspace's checkout is not available.";
export const SUBMODULE = 'A submodule: not shown.';
export const noBase = (n: number): string =>
  `Iteration ${n} was published before the factory recorded its base, and the job may have been rebased since.`;
export const cutAt = (n: number): string => `The Patch of iteration ${n} was cut at 2 MB.`;
export const notUtf8 = (n: number): string => `The Patch of iteration ${n} does not hold this file's exact bytes (not UTF-8).`;

// The paths a Patch never contains (src/patch.ts, included): the Task directory and the
// credential-like paths.
function included(path: string): boolean {
  return path !== '' && !path.startsWith(`${TASK_DIR}/`) && !path.endsWith('/') && !isForbidden(path);
}

// The workspace's repository as the factory reads it: Git runs in the checkout with the job's
// object directory as the one written to and the repository's objects as alternates.
interface Repo {
  checkout: string;
  env: Record<string, string>;
}

// Iteration N after its Patch. failure: why every file of it is unavailable (then tree is null);
// paths: its files (meta.json files and the Patch's sections); binary and unavailable: the files
// left out of the tree; statuses: from meta.json files, else from the sections' mode lines.
interface Side {
  n: number;
  base: string | null;
  repo: Repo | null;
  baseTree: string | null;
  tree: string | null;
  failure: string | null;
  paths: string[];
  sections: Map<string, string>;
  binary: Set<string>;
  unavailable: Map<string, string>;
  statuses: Map<string, ChangeStatus>;
}

// A file list before the cut at MAX_LIST_FILES.
interface FullList {
  files: ListedFile[];
}

class Lru {
  readonly #entries = new Map<string, Promise<unknown>>();

  get<T>(key: string, make: () => Promise<T>): Promise<T> {
    const found = this.#entries.get(key);
    if (found !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, found);
      return found as Promise<T>;
    }
    const made = make();
    this.#entries.set(key, made);
    // A failure is not kept: the next request tries again.
    made.catch(() => {
      if (this.#entries.get(key) === made) {
        this.#entries.delete(key);
      }
    });
    while (this.#entries.size > CACHE_ENTRIES) {
      this.#entries.delete(this.#entries.keys().next().value!);
    }
    return made;
  }
}

const statusOfSection = (section: string): ChangeStatus =>
  /^new file mode /m.test(section) ? 'added' : /^deleted file mode /m.test(section) ? 'deleted' : 'modified';

const RAW_STATUS: Record<string, ChangeStatus> = { A: 'added', D: 'deleted' };

function gitMessage(args: string[], result: { code: number | null; stderr: string }): string {
  const text = result.stderr.trim();
  return text === '' ? `git ${args[0]} failed (${result.code}).` : text;
}

async function git(repo: Repo, args: string[], env: Record<string, string> = {}, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const result = await runGit(repo.checkout, args, maxBytes, undefined, { ...repo.env, ...env });
  if (result.code !== 0 || result.truncated) {
    throw new GitFailure(gitMessage(args, result));
  }
  return result.stdout;
}

class GitFailure extends Error {}

const isObjectId = (text: string): boolean => /^[0-9a-f]{40,64}$/.test(text);

// The base of an iteration: recorded in its meta.json since SF-079; for an older one the job's
// base_commit while MR preparation never started (no rebase can have moved it), else unknown.
export function baseOf(job: Job, meta: IterationMeta): string | null {
  if (typeof meta.base_commit === 'string') {
    return meta.base_commit;
  }
  return job.target_commit === null ? job.base_commit : null;
}

export class Changes {
  readonly #jobs: JobStore;
  readonly #caches = new Map<string, { stamp: string; lru: Lru }>();

  constructor(jobs: JobStore) {
    this.#jobs = jobs;
  }

  // The base and the published iterations.
  index(job: Job): Promise<ChangesIndex> {
    return this.#cache(job, 'index', async () => {
      const iterations: ChangesIndex['iterations'] = [];
      for (let n = 1; n <= job.iteration; n += 1) {
        const meta = await this.#jobs.readMeta(job.workspace, job.ticket, n);
        iterations.push({ n, ended_at: meta.ended_at, truncated: meta.patch_truncated, base_commit: baseOf(job, meta) });
      }
      return { base: { ref: job.base, commit: iterations.at(-1)?.base_commit ?? null }, iterations };
    });
  }

  // The files of a valid pair: the base of iteration to against to, or to - 1 against to;
  // undefined for any other pair.
  async files(job: Job, from: 'base' | number, to: number): Promise<{ files: ListedFile[]; more: boolean } | undefined> {
    if (!validPair(job, from, to)) {
      return undefined;
    }
    const { files } = await this.#list(job, from, to);
    return { files: files.slice(0, MAX_LIST_FILES), more: files.length > MAX_LIST_FILES };
  }

  // One side of one file: at the base of iteration of (at 'base') or after iteration at. Only a
  // path of a list of a view that shows that side is served; undefined for any other.
  async file(job: Job, at: 'base' | number, of: number, path: string): Promise<FileVersion | undefined> {
    if (!included(path) || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      return undefined;
    }
    const n = at === 'base' ? of : at;
    if (!published(job, n)) {
      return undefined;
    }
    const pairs: Array<['base' | number, number]> = at === 'base' ? [['base', n]] : [['base', n], [n - 1, n], [n, n + 1]];
    let listed = false;
    for (const [from, to] of pairs.filter(([from, to]) => validPair(job, from, to))) {
      // The list as it is sent: cut at MAX_LIST_FILES.
      if ((await this.#list(job, from, to)).files.slice(0, MAX_LIST_FILES).some((file) => file.path === path)) {
        listed = true;
        break;
      }
    }
    if (!listed) {
      return undefined;
    }
    return this.#cache(job, `file|${at}|${n}|${path}`, async () => {
      const side = await this.#side(job, n);
      if (at === 'base') {
        return side.baseTree === null ? { kind: 'unavailable', reason: side.failure ?? CHECKOUT_MISSING } : this.#blob(side.repo!, side.baseTree, path);
      }
      const reason = side.failure ?? side.unavailable.get(path);
      if (reason !== undefined) {
        return { kind: 'unavailable', reason };
      }
      if (side.binary.has(path)) {
        return { kind: 'binary', bytes: null };
      }
      return this.#blob(side.repo!, side.tree!, path);
    });
  }

  #cache<T>(job: Job, key: string, make: () => Promise<T>): Promise<T> {
    const id = `${job.workspace}/${job.ticket}`;
    // A new job on the ticket, a rebase (target_commit) or a new iteration starts a new cache.
    const stamp = `${job.created_at}|${job.target_commit}|${job.base_commit}|${job.iteration}`;
    let entry = this.#caches.get(id);
    if (entry === undefined || entry.stamp !== stamp) {
      entry = { stamp, lru: new Lru() };
      this.#caches.set(id, entry);
    }
    return entry.lru.get(key, make);
  }

  #list(job: Job, from: 'base' | number, to: number): Promise<FullList> {
    return this.#cache(job, `list|${from}|${to}`, async () => {
      const right = await this.#side(job, to);
      const left = from === 'base' ? null : await this.#side(job, from);
      const leftTree = left === null ? right.baseTree : left.tree;
      const failure = left?.failure ?? right.failure;
      const listed = new Map<string, ListedFile>();
      const unavailableOn = (side: Side, path: string): string | undefined => side.failure ?? side.unavailable.get(path);
      if (leftTree !== null && right.tree !== null) {
        for (const file of await this.#diffTree(right.repo!, leftTree, right.tree)) {
          listed.set(file.path, file);
        }
      }
      // The binary and unavailable paths that changed between the two sides.
      const extra = new Set<string>();
      if (left === null) {
        for (const path of [...right.binary, ...right.unavailable.keys(), ...(right.failure !== null ? right.paths : [])]) {
          extra.add(path);
        }
      } else {
        const differs = (path: string): boolean => left.sections.get(path) !== right.sections.get(path);
        for (const path of [...left.binary, ...right.binary]) {
          if (differs(path)) {
            extra.add(path);
          }
        }
        for (const side of [left, right]) {
          for (const path of [...side.unavailable.keys(), ...(side.failure !== null ? side.paths : [])]) {
            extra.add(path);
          }
        }
        if (failure !== null) {
          for (const path of [...left.paths, ...right.paths]) {
            if (differs(path)) {
              extra.add(path);
            }
          }
        }
      }
      for (const path of extra) {
        const status = right.statuses.get(path) ?? listed.get(path)?.status ?? 'modified';
        listed.set(path, { path, status, additions: 0, deletions: 0, binary: right.binary.has(path) || (left?.binary.has(path) ?? false), unavailable: false });
      }
      for (const file of listed.values()) {
        const reason = (left === null ? undefined : unavailableOn(left, file.path)) ?? unavailableOn(right, file.path)
          ?? (leftTree === null || right.tree === null ? failure ?? CHECKOUT_MISSING : undefined);
        if (reason !== undefined) {
          file.unavailable = true;
        }
        if (file.unavailable || file.binary) {
          file.status = right.statuses.get(file.path) ?? file.status;
          file.additions = 0;
          file.deletions = 0;
        }
      }
      const files = [...listed.values()].filter((file) => included(file.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { files };
    });
  }

  // The entries of git diff-tree between two trees: status from the raw part, counts from numstat
  // (a binary blob counts 0 and is binary); a submodule is unavailable.
  async #diffTree(repo: Repo, left: string, right: string): Promise<ListedFile[]> {
    const tokens = (await git(repo, ['diff-tree', '-r', '-z', '--raw', '--numstat', '--no-renames', left, right])).toString('utf8').split('\0');
    const files = new Map<string, ListedFile>();
    const fileOf = (path: string): ListedFile => {
      let file = files.get(path);
      if (file === undefined) {
        file = { path, status: 'modified', additions: 0, deletions: 0, binary: false, unavailable: false };
        files.set(path, file);
      }
      return file;
    };
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token === '') {
        continue;
      }
      if (token.startsWith(':')) {
        const [oldMode, newMode, , , letter] = token.slice(1).split(' ');
        const file = fileOf(tokens[index + 1] ?? '');
        index += 1;
        file.status = RAW_STATUS[letter?.charAt(0) ?? ''] ?? 'modified';
        if (oldMode === '160000' || newMode === '160000') {
          file.unavailable = true;
        }
        continue;
      }
      const match = /^(-|\d+)\t(-|\d+)\t([^]*)$/.exec(token);
      if (match !== null) {
        const file = fileOf(match[3]!);
        file.binary = match[1] === '-';
        file.additions = match[1] === '-' ? 0 : Number(match[1]);
        file.deletions = match[2] === '-' ? 0 : Number(match[2]);
      }
    }
    // A submodule's entry: unavailable, with no binary mark and no counts.
    for (const file of files.values()) {
      if (file.unavailable) {
        file.binary = false;
      }
    }
    return [...files.values()];
  }

  // One side of iteration n, cached in memory and its tree in iterations/NNN/tree.
  #side(job: Job, n: number): Promise<Side> {
    return this.#cache(job, `side|${n}`, async () => {
      const meta = await this.#jobs.readMeta(job.workspace, job.ticket, n);
      const patch = (await readFile(join(this.#jobs.iterationDir(job.workspace, job.ticket, n), 'patch.diff'))).toString('utf8');
      const sections = fileSections(patch);
      const { submodules } = changedFiles(patch);
      // From meta.json files; for an iteration published without them, from the sections' mode lines.
      const statuses = new Map<string, ChangeStatus>();
      if (meta.files === undefined) {
        for (const [path, section] of sections) {
          statuses.set(path, statusOfSection(section));
        }
      }
      for (const file of meta.files ?? []) {
        statuses.set(file.path, file.status === 'renamed' ? 'modified' : file.status);
      }
      const side: Side = {
        n, base: baseOf(job, meta), repo: null, baseTree: null, tree: null, failure: null,
        paths: [...new Set([...(meta.files ?? []).map((file) => file.path), ...sections.keys()])].filter(included),
        sections, binary: new Set(), unavailable: new Map(), statuses,
      };
      // The sections that go into the tree, and the files left out.
      const applied: string[] = [];
      const entries = [...sections];
      entries.forEach(([path, section], index) => {
        if (meta.patch_truncated && index === entries.length - 1) {
          side.unavailable.set(path, cutAt(n));
        } else if (submodules.includes(path)) {
          side.unavailable.set(path, SUBMODULE);
        } else if (/^Binary files .* differ$/m.test(section)) {
          side.binary.add(path);
        } else if (section.includes('�')) {
          side.unavailable.set(path, notUtf8(n));
        } else {
          applied.push(section);
        }
      });
      if (meta.patch_truncated) {
        for (const file of meta.files ?? []) {
          if (!sections.has(file.path)) {
            side.unavailable.set(file.path, cutAt(n));
          }
        }
      }
      side.repo = await this.#repo(job);
      if (side.repo === null) {
        side.failure = CHECKOUT_MISSING;
        return side;
      }
      if (side.base === null) {
        side.failure = noBase(n);
        return side;
      }
      try {
        side.baseTree = (await git(side.repo, ['rev-parse', '--verify', '--quiet', `${side.base}^{tree}`])).toString('utf8').trim();
      } catch (error) {
        if (!(error instanceof GitFailure)) {
          throw error;
        }
        side.failure = `The base ${side.base.slice(0, 12)} of iteration ${n} is not in the workspace's checkout.`;
        return side;
      }
      if (meta.patch_truncated && meta.files === undefined) {
        // Without the file list, the files after the cut are unknown.
        side.failure = cutAt(n);
        return side;
      }
      try {
        side.tree = await this.#tree(job, side.repo, n, side.baseTree, applied);
      } catch (error) {
        if (!(error instanceof GitFailure)) {
          throw error;
        }
        side.failure = error.message;
      }
      return side;
    });
  }

  // The tree of iteration n: the cached one when its object is there, else built and cached.
  async #tree(job: Job, repo: Repo, n: number, baseTree: string, applied: string[]): Promise<string> {
    const cachePath = this.#jobs.treePath(job.workspace, job.ticket, n);
    const cached = (await readFile(cachePath, 'utf8').catch(() => '')).trim();
    if (isObjectId(cached)) {
      const type = await runGit(repo.checkout, ['cat-file', '-t', cached], 1024, undefined, repo.env);
      if (type.code === 0 && type.stdout.toString('utf8').trim() === 'tree') {
        return cached;
      }
    }
    const temp = await mkdtemp(join(tmpdir(), 'sf-changes-'));
    try {
      const env = { GIT_INDEX_FILE: join(temp, 'index') };
      await git(repo, ['read-tree', baseTree], env);
      if (applied.length > 0) {
        const patchFile = join(temp, 'patch.diff');
        await writeFile(patchFile, applied.join(''), { mode: 0o600 });
        await git(repo, ['apply', '--cached', '--whitespace=nowarn', patchFile], env);
      }
      const tree = (await git(repo, ['write-tree'], env)).toString('utf8').trim();
      await writeFileAtomic(cachePath, Buffer.from(`${tree}\n`));
      return tree;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  // The workspace's checkout with the job's object directory; null when it is not available.
  async #repo(job: Job): Promise<Repo | null> {
    let checkout: string;
    try {
      ({ readCheckout: checkout } = await resolveWorkspace(job.workspace));
    } catch {
      return null;
    }
    const common = await runGit(checkout, ['rev-parse', '--git-common-dir']);
    if (common.code !== 0) {
      return null;
    }
    const objects = this.#jobs.objectsDir(job.workspace, job.ticket);
    await mkdir(objects, { recursive: true, mode: 0o700 });
    return {
      checkout,
      env: { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(resolve(checkout, common.stdout.toString('utf8').trim()), 'objects') },
    };
  }

  // A file of a tree: absent, a submodule, binary (a NUL byte or not UTF-8), too large, or its text.
  async #blob(repo: Repo, tree: string, path: string): Promise<FileVersion> {
    const listing = (await git(repo, ['ls-tree', '-l', '-z', tree, '--', path], { GIT_LITERAL_PATHSPECS: '1' })).toString('utf8');
    const entry = listing.split('\0').find((line) => line.endsWith(`\t${path}`));
    const match = entry === undefined ? null : /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t/.exec(entry);
    if (match === null || match[2] === 'tree') {
      return { kind: 'absent' };
    }
    if (match[2] === 'commit') {
      return { kind: 'unavailable', reason: SUBMODULE };
    }
    const bytes = Number(match[4]);
    if (bytes > MAX_FILE_BYTES) {
      return { kind: 'too_large', bytes };
    }
    const content = await git(repo, ['cat-file', 'blob', match[3]!], {}, MAX_FILE_BYTES + 1);
    if (content.includes(0)) {
      return { kind: 'binary', bytes };
    }
    try {
      return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(content) };
    } catch {
      return { kind: 'binary', bytes };
    }
  }
}

function published(job: Job, n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= job.iteration;
}

// from=base with any published to; from=to-1 with to >= 2.
function validPair(job: Job, from: 'base' | number, to: number): boolean {
  return published(job, to) && (from === 'base' || (from === to - 1 && to >= 2));
}
