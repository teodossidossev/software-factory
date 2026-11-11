// The morning digest's Git data: a bare mirror per workspace under the state directory,
// fetched from origin and from the read checkout's local branches, and the extraction over it (what
// landed on the main branch in the period, the live branches, mine, my commits). No model and no
// stored state of its own: each function takes the paths it works on. Nothing here writes to the
// read checkout: it is only read (its origin URL, its user.email, its objects as the clone's
// reference, its branches by a fetch into the mirror). Dates are committer dates throughout.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { runGit, streamGitRecords } from './git.js';

// Every Git command of the digest: never a prompt, and a timeout per kind of command.
const DIGEST_GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
export const CLONE_TIMEOUT_MS = 10 * 60_000;
export const FETCH_TIMEOUT_MS = 2 * 60_000;
export const GIT_TIMEOUT_MS = 60_000;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

// A branch is live when its tip is at most this old.
export const LIVE_BRANCH_DAYS = 14;
const DAY_MS = 86_400_000;
// A "why" shorter than this sends a diff excerpt of at most DIFF_EXCERPT_CHARS to the model.
export const SHORT_WHY_CHARS = 40;
export const DIFF_EXCERPT_CHARS = 2500;
export const MAX_DERIVED_DESCRIPTION_CHARS = 300;
// The model's input is capped at this many characters (capModelInput).
export const MAX_MODEL_INPUT_CHARS = 150_000;
// The "why" of one entry and the files listed per entry, at most.
const MAX_WHY_CHARS = 1500;
const MAX_FILES = 40;
export const TICKET_KEY = /[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+/;

export class DigestGitError extends Error {}

// Runs Git for the digest: the output as text, or DigestGitError with the reason (a timeout too).
async function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS, maxBytes = MAX_GIT_OUTPUT): Promise<string> {
  const result = await runGit(cwd, args, maxBytes, timeoutMs, DIGEST_GIT_ENV);
  if (result.code === null && !result.truncated) {
    throw new DigestGitError(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`);
  }
  if (result.code !== 0 && !result.truncated) {
    throw new DigestGitError(reason(result.stderr) || `git ${args[0]} exited with ${result.code}`);
  }
  return result.stdout.toString('utf8');
}

// Whether a Git command succeeds (exit 0), never throwing.
async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    return (await runGit(cwd, args, 1024, GIT_TIMEOUT_MS, DIGEST_GIT_ENV)).code === 0;
  } catch { // Git cannot run: not ok, never throwing
    return false;
  }
}

// A Git error's last meaningful line, credentials of a URL masked, at most 300 characters.
export function reason(stderr: string): string {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('hint:'));
  const fatal = lines.find((line) => /^(fatal|error):/.test(line)) ?? lines.at(-1) ?? '';
  return maskCredentials(fatal.replace(/^(fatal|error):\s*/, '')).slice(0, 300);
}

export function maskCredentials(text: string): string {
  return text.replace(/(\/\/)[^/@\s]+@/g, '$1***@');
}

const message = (error: unknown): string => maskCredentials(error instanceof Error ? error.message : String(error));

// ---------- The text of a commit message ----------

// The first ticket key (TICKET_KEY: "DOCS-AUDIT-1" whole, not "AUDIT-1") of the texts, in order, or null.
export function ticketKey(...texts: Array<string | undefined>): string | null {
  for (const text of texts) {
    const match = text === undefined ? null : TICKET_KEY.exec(text);
    if (match !== null) {
      return match[0];
    }
  }
  return null;
}

// A text as a regular expression that matches only itself.
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const HEADING = /^#{1,6}\s/;

// The "why" of a commit message: the text under its `## Why` heading, else under `## What` (any
// level, any case), else the first paragraph of its body (the message after the subject line).
export function whyOf(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n').slice(1);
  for (const word of ['why', 'what']) {
    const start = lines.findIndex((line) => new RegExp(`^#{1,6}\\s*${word}\\s*:?\\s*$`, 'i').test(line.trim()));
    if (start >= 0) {
      const end = lines.findIndex((line, index) => index > start && HEADING.test(line.trim()));
      const section = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
      if (section !== '') {
        return section.slice(0, MAX_WHY_CHARS);
      }
    }
  }
  const body = lines.join('\n').trim();
  return (body.split(/\n\s*\n/)[0] ?? '').trim().slice(0, MAX_WHY_CHARS);
}

// ---------- The derived description ----------

// The description the repository gives of itself: the first paragraph of its README.md (headings,
// images, badges, HTML and rules skipped), else the description of its root package.json; at most
// 300 characters, on one line. null when there is none.
export async function derivedDescription(checkout: string): Promise<string | null> {
  const readme = await readHead(join(checkout, 'README.md'));
  const paragraph = readme === undefined ? undefined : firstParagraph(readme);
  if (paragraph !== undefined) {
    return shorten(paragraph);
  }
  const pkg = await readHead(join(checkout, 'package.json'));
  try {
    const description = pkg === undefined ? undefined : (JSON.parse(pkg) as { description?: unknown }).description;
    return typeof description === 'string' && description.trim() !== '' ? shorten(description) : null;
  } catch { // package.json is not JSON: no description
    return null;
  }
}

// The first 64 KB of a regular file as text (the Setup reads it for every workspaces payload), or
// undefined when it cannot be read.
async function readHead(path: string): Promise<string | undefined> {
  try {
    if (!(await lstat(path)).isFile()) {
      return undefined;
    }
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch { // missing or unreadable: undefined
    return undefined;
  }
}

function firstParagraph(markdown: string): string | undefined {
  const text = markdown.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  let fenced = false;
  const blocks: string[][] = [[]];
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      blocks.push([]);
      continue;
    }
    if (fenced) {
      continue;
    }
    if (line.trim() === '') {
      blocks.push([]);
    } else {
      blocks.at(-1)!.push(line);
    }
  }
  for (const block of blocks) {
    // A setext heading (Title, then === or ---) is no paragraph.
    if (block.length >= 2 && /^(=+|-+)\s*$/.test(block[1]!.trim())) {
      continue;
    }
    const lines = block.filter((line) => !HEADING.test(line.trim()) && !/^(?:<[^>]*>\s*)+$/.test(line.trim()) && !/^(?:\[?!\[[^\]]*\]\([^)]*\)\]?(?:\([^)]*\))?\s*)+$/.test(line.trim()) && !/^([-*_=])\1{2,}\s*$/.test(line.trim()));
    const joined = lines.join(' ').trim();
    if (joined !== '') {
      return joined;
    }
  }
  return undefined;
}

function shorten(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= MAX_DERIVED_DESCRIPTION_CHARS ? line : `${line.slice(0, MAX_DERIVED_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

// ---------- The mirror ----------

// digest/mirrors/<workspace>.json: where the mirror was cloned from and its last fetch.
export interface MirrorMeta {
  checkout: string;
  origin_url: string;
  last_fetch_ok_at: string | null;
  last_error: string | null;
}

// The mirror of one workspace for this run. ok: fetched from origin; fetch_failed: the mirror's
// older data is used (message says so); skipped: no data for this run (no origin remote, or the
// first clone failed). notes: what else did not work (the read checkout's local branches).
export interface MirrorResult {
  status: 'ok' | 'fetch_failed' | 'skipped';
  message: string | null;
  last_fetch_ok_at: string | null;
  notes: string[];
  // The mirror's path; undefined when skipped.
  path?: string;
}

export const mirrorPath = (mirrorsDir: string, name: string): string => join(mirrorsDir, `${name}.git`);
const metaPath = (mirrorsDir: string, name: string): string => join(mirrorsDir, `${name}.json`);

async function readMeta(mirrorsDir: string, name: string): Promise<MirrorMeta | undefined> {
  try {
    const data = JSON.parse(await readFile(metaPath(mirrorsDir, name), 'utf8')) as Partial<MirrorMeta>;
    if (typeof data.checkout === 'string' && typeof data.origin_url === 'string') {
      return { checkout: data.checkout, origin_url: data.origin_url, last_fetch_ok_at: data.last_fetch_ok_at ?? null, last_error: data.last_error ?? null };
    }
  } catch { // missing or unreadable: the mirror is cloned again
  }
  return undefined;
}

async function writeMeta(mirrorsDir: string, name: string, meta: MirrorMeta): Promise<void> {
  await writeFileAtomic(metaPath(mirrorsDir, name), Buffer.from(`${JSON.stringify(meta, null, 2)}\n`));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch { // lstat fails: nothing exists there
    return false;
  }
}

// The read checkout's origin URL, a relative path made absolute against the checkout; undefined
// without an origin remote.
export async function originUrl(checkout: string): Promise<string | undefined> {
  let url: string;
  try {
    url = (await git(checkout, ['config', '--get', 'remote.origin.url'])).trim();
  } catch { // git config fails without an origin remote: undefined
    return undefined;
  }
  if (url === '') {
    return undefined;
  }
  // A local path (not a URL, not scp-like host:path) relative to the checkout.
  if (!url.includes('://') && !/^[^/]+:/.test(url) && !isAbsolute(url)) {
    return resolve(checkout, url);
  }
  return url;
}

// The mirror of a workspace, ready for this run: cloned on first use (bare, with the checkout's
// objects as a reference, dissociated), then fetched from origin (prune) and from the read
// checkout's local branches into refs/sf-local/heads/*. A changed origin URL is set on the mirror;
// a changed checkout path clones it again. A failed fetch is not fatal; a failed first clone or a
// missing origin skips the workspace for this run.
export async function syncMirror(mirrorsDir: string, name: string, checkout: string, now: () => Date = () => new Date()): Promise<MirrorResult> {
  await mkdir(mirrorsDir, { recursive: true, mode: 0o700 });
  const mirror = mirrorPath(mirrorsDir, name);
  let meta = await readMeta(mirrorsDir, name);
  const url = await originUrl(checkout);
  if (url === undefined) {
    return { status: 'skipped', message: 'no origin remote', last_fetch_ok_at: meta?.last_fetch_ok_at ?? null, notes: [] };
  }
  if (meta === undefined || meta.checkout !== checkout || !(await exists(join(mirror, 'HEAD')))) {
    await rm(mirror, { recursive: true, force: true });
    const temp = `${mirror}.${randomUUID()}.tmp`;
    try {
      await git(mirrorsDir, ['clone', '--quiet', '--bare', '--reference', checkout, '--dissociate', '--', url, temp], CLONE_TIMEOUT_MS);
      await git(temp, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*']);
      await git(temp, ['config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/tags/*']);
      await rename(temp, mirror);
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      const why = message(error);
      await writeMeta(mirrorsDir, name, { checkout, origin_url: url, last_fetch_ok_at: null, last_error: `mirror not created: ${why}` });
      return { status: 'skipped', message: `mirror not created: ${why}`, last_fetch_ok_at: null, notes: [] };
    }
    // The clone fetched origin: its data is as of now.
    meta = { checkout, origin_url: url, last_fetch_ok_at: now().toISOString(), last_error: null };
  } else if (meta.origin_url !== url) {
    await git(mirror, ['remote', 'set-url', 'origin', url]).catch(() => undefined);
    meta = { ...meta, origin_url: url };
  }
  const notes: string[] = [];
  let status: MirrorResult['status'] = 'ok';
  let failure: string | null = null;
  try {
    await git(mirror, ['fetch', '--quiet', '--prune', '--no-recurse-submodules', 'origin'], FETCH_TIMEOUT_MS);
    meta = { ...meta, last_fetch_ok_at: now().toISOString(), last_error: null };
  } catch (error) {
    status = 'fetch_failed';
    failure = message(error);
    meta = { ...meta, last_error: `fetch failed: ${failure}` };
  }
  try {
    // Reads the checkout, writes only to the mirror.
    await git(mirror, ['fetch', '--quiet', '--prune', '--no-recurse-submodules', '--no-tags', checkout, '+refs/heads/*:refs/sf-local/heads/*'], FETCH_TIMEOUT_MS);
  } catch (error) {
    notes.push(`local branches not read: ${message(error)}`);
  }
  await writeMeta(mirrorsDir, name, meta);
  const asOf = meta.last_fetch_ok_at;
  return {
    status, path: mirror, notes, last_fetch_ok_at: asOf,
    message: failure === null ? null : `fetch failed: ${failure}; data as of ${asOf ?? 'an unknown time'}`,
  };
}

// ---------- The extraction ----------

export interface LandedEntry {
  sha: string;
  full_sha: string;
  author: string;
  mine: boolean;
  // Committer date, ISO 8601.
  date: string;
  // A merge commit's subject keeps both: the merged tip's subject, then the merge's own.
  subject: string;
  merge: boolean;
  ticket: string | null;
  why: string;
  files: string[];
  files_total: number;
  dirs: string[];
  stat: string;
  // Only when the "why" is shorter than SHORT_WHY_CHARS.
  diff_excerpt?: string;
}

export interface HitBy {
  sha: string;
  files: string[];
}

export interface LiveBranch {
  name: string;
  // Only in the read checkout (refs/sf-local/heads/*, no remote branch of the name).
  local: boolean;
  author: string;
  mine: boolean;
  // The tip's committer date (the newer of the remote and the local tip).
  date: string;
  age_days: number;
  ahead: number;
  behind: number;
  // A remote branch with a local one of the same name: the local commits not on the remote.
  local_only: number;
  subject: string;
  ticket: string | null;
  landed: boolean;
  earlier_merge: boolean;
  // Mine and not landed: the files changed against the merge base, those main changed since it
  // too, and the period's landed commits after the merge base that touched them.
  files?: string[];
  overlap?: string[];
  hit_by?: HitBy[];
}

export interface MyCommit {
  sha: string;
  // The branch it was found on: "name", or "name (local)".
  ref: string;
  date: string;
  subject: string;
  why: string;
  stat: string;
}

export interface RepoData {
  main: string;
  // My identity: the read checkout's user.email, or null.
  me: string | null;
  landed: LandedEntry[];
  branches: LiveBranch[];
  my_commits: MyCommit[];
  // What could not be read (a branch Git failed on); the rest is there.
  notes: string[];
}

export interface ExtractOptions {
  // The period of the repositories part: (from, to].
  from: Date;
  to: Date;
  // My commits from here (the earlier of from and the daily's yesterday) until to.
  since: Date;
  me: string | null;
  myWork: boolean;
}

// The read checkout's user.email, or null.
export async function myEmail(checkout: string): Promise<string | null> {
  try {
    const email = (await git(checkout, ['config', '--get', 'user.email'])).trim();
    return email === '' ? null : email;
  } catch { // no user.email set (git config fails): null
    return null;
  }
}

const same = (a: string, b: string | null): boolean => b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
const inPeriod = (date: string, from: Date, to: Date): boolean => {
  const time = Date.parse(date);
  return time > from.getTime() && time <= to.getTime();
};

// The mirror's main branch: its HEAD, else main, else master.
export async function mainBranch(mirror: string): Promise<string | undefined> {
  const head = await git(mirror, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then((text) => text.trim(), () => '');
  for (const name of [head, 'main', 'master']) {
    if (name !== '' && (await gitOk(mirror, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`]))) {
      return name;
    }
  }
  return undefined;
}

interface CommitFacts {
  sha: string;
  parents: string[];
  date: string;
  author: string;
  email: string;
  message: string;
}

const RS = '\x1e';
const US = '\x00';
// The same separators as Git's format escapes (an argv has no NUL).
const RS_FORMAT = '%x1e';
const US_FORMAT = '%x00';

function parseCommits(text: string): CommitFacts[] {
  return text.split(RS).map((record) => record.replace(/^\n/, '')).filter((record) => record.includes(US)).flatMap((record) => {
    const [sha, parents, date, author, email, ...rest] = record.split(US);
    if (sha === undefined || !/^[0-9a-f]{40,64}$/.test(sha) || rest.length === 0) {
      return [];
    }
    return [{ sha, parents: (parents ?? '').split(' ').filter((parent) => parent !== ''), date: date ?? '', author: author ?? '', email: email ?? '', message: rest.join(US).trimEnd() }];
  });
}

const COMMIT_FORMAT = `--format=%H${US_FORMAT}%P${US_FORMAT}%cI${US_FORMAT}%an${US_FORMAT}%ae${US_FORMAT}%B${RS_FORMAT}`;

async function commitFacts(mirror: string, rev: string): Promise<CommitFacts | undefined> {
  return parseCommits(await git(mirror, ['log', '-1', COMMIT_FORMAT, rev, '--']))[0];
}

// The two trees an entry's change is between: its first parent (the empty tree for a root
// commit) and itself.
async function emptyTree(mirror: string): Promise<string> {
  return (await git(mirror, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
}

async function changeOf(mirror: string, base: string, sha: string, wantExcerpt: boolean): Promise<{ files: string[]; stat: string; excerpt?: string }> {
  const files = (await git(mirror, ['diff', '--no-renames', '--name-only', base, sha, '--'])).split('\n').filter((line) => line !== '');
  const stat = (await git(mirror, ['diff', '--shortstat', base, sha, '--'])).trim();
  if (!wantExcerpt) {
    return { files, stat };
  }
  const result = await runGit(mirror, ['diff', '--unified=1', '--no-color', base, sha, '--'], DIFF_EXCERPT_CHARS * 4, GIT_TIMEOUT_MS, DIGEST_GIT_ENV);
  return { files, stat, excerpt: result.stdout.toString('utf8').slice(0, DIFF_EXCERPT_CHARS) };
}

// The top directories of a file list, by how many files each holds, at most three ("." for the root).
export function topDirs(files: string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const slash = file.indexOf('/');
    const dir = slash < 0 ? '.' : file.slice(0, slash);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([dir]) => dir);
}

// What landed on the main branch in the period: its first-parent commits, newest first. A merge
// commit's author and message come from the merged side's tip; its subject keeps both.
// landedFiles gets each entry's whole file list (the entry keeps at most MAX_FILES), for hit_by.
async function landedOf(mirror: string, main: string, options: ExtractOptions, landedFiles: Map<string, string[]>): Promise<LandedEntry[]> {
  const after = new Date(options.from.getTime() - 1000).toISOString();
  const commits = parseCommits(await git(mirror, ['log', '--first-parent', `--since=${after}`, COMMIT_FORMAT, `refs/heads/${main}`, '--'])).filter((commit) => inPeriod(commit.date, options.from, options.to));
  let empty: string | undefined;
  const entries: LandedEntry[] = [];
  for (const commit of commits) {
    const merge = commit.parents.length >= 2;
    const tip = merge ? await commitFacts(mirror, commit.parents[1]!) : undefined;
    const source = tip ?? commit;
    const ownSubject = commit.message.split('\n')[0] ?? '';
    const tipSubject = source.message.split('\n')[0] ?? '';
    const subject = merge ? `${tipSubject} (${ownSubject})` : ownSubject;
    const why = whyOf(source.message);
    const base = commit.parents[0] ?? (empty ??= await emptyTree(mirror));
    const change = await changeOf(mirror, base, commit.sha, why.length < SHORT_WHY_CHARS);
    landedFiles.set(commit.sha, change.files);
    entries.push({
      sha: commit.sha.slice(0, 10), full_sha: commit.sha, author: source.author, mine: same(source.email, options.me), date: commit.date, subject, merge,
      ticket: ticketKey(ownSubject, tipSubject, source.message, commit.message), why, files: change.files.slice(0, MAX_FILES), files_total: change.files.length, dirs: topDirs(change.files),
      stat: change.stat, ...(change.excerpt !== undefined ? { diff_excerpt: change.excerpt } : {}),
    });
  }
  return entries;
}

interface RefFacts {
  sha: string;
  date: string;
  author: string;
  email: string;
  subject: string;
}

async function refsOf(mirror: string): Promise<{ remote: Map<string, RefFacts>; local: Map<string, RefFacts> }> {
  const text = await git(mirror, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(authorname)%00%(authoremail:trim)%00%(subject)', 'refs/heads', 'refs/sf-local/heads']);
  const remote = new Map<string, RefFacts>();
  const local = new Map<string, RefFacts>();
  for (const line of text.split('\n')) {
    const [ref, sha, date, author, email, subject] = line.split(US);
    if (ref === undefined || sha === undefined || date === undefined) {
      continue;
    }
    const facts = { sha, date, author: author ?? '', email: email ?? '', subject: subject ?? '' };
    if (ref.startsWith('refs/heads/')) {
      remote.set(ref.slice('refs/heads/'.length), facts);
    } else if (ref.startsWith('refs/sf-local/heads/')) {
      local.set(ref.slice('refs/sf-local/heads/'.length), facts);
    }
  }
  return { remote, local };
}

const lines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter((line) => line !== '');

async function count(mirror: string, range: string): Promise<number> {
  return Number((await git(mirror, ['rev-list', '--count', range, '--'])).trim()) || 0;
}

// The live branches of the mirror: every remote branch and every local-only branch of the read
// checkout but the main branch, whose tip is at most LIVE_BRANCH_DAYS old and that has commits not on
// the main branch. Mine: the tip's author or the author of a commit not on main. landed: every
// commit's patch is on main (git cherry), or a first-parent commit of main since the merge base names
// its ticket key (a squash merge; a merge of an earlier tip of this branch does not count).
// earlier_merge: its ticket key is in a first-parent commit of main at all.
async function branchesOf(mirror: string, main: string, landed: LandedEntry[], landedFiles: Map<string, string[]>, options: ExtractOptions, notes: string[]): Promise<LiveBranch[]> {
  const { remote, local } = await refsOf(mirror);
  const mainRef = `refs/heads/${main}`;
  const names = [...new Set([...remote.keys(), ...local.keys()])].filter((name) => name !== main).sort();
  const branches: LiveBranch[] = [];
  const mainChanged = new Map<string, string[]>();
  for (const name of names) {
    try {
      const branch = await branchOf(mirror, mainRef, name, remote.get(name), local.get(name), landed, landedFiles, options, mainChanged);
      if (branch !== undefined) {
        branches.push(branch);
      }
    } catch (error) {
      // One branch that Git cannot read leaves the others and what landed.
      notes.push(`branch ${name} not read: ${message(error)}`);
    }
  }
  return branches;
}

// One live branch, or undefined when it is not live. A remote branch with a local one of the same
// name is read at the local tip when that holds commits the remote does not (they are my work, not
// pushed yet): ahead/behind, the merge base, landed and the files. A local-only branch is mine: it
// exists only in my checkout.
async function branchOf(
  mirror: string, mainRef: string, name: string, own: RefFacts | undefined, mine: RefFacts | undefined, landed: LandedEntry[], landedFiles: Map<string, string[]>,
  options: ExtractOptions, mainChanged: Map<string, string[]>,
): Promise<LiveBranch | undefined> {
  const tipFacts = own ?? mine!;
  const newest = [own, mine].filter((facts): facts is RefFacts => facts !== undefined).map((facts) => Date.parse(facts.date)).reduce((a, b) => Math.max(a, b));
  const age = (options.to.getTime() - newest) / DAY_MS;
  if (!(age <= LIVE_BRANCH_DAYS)) {
    return undefined;
  }
  const localOnly = own !== undefined && mine !== undefined && mine.sha !== own.sha ? await count(mirror, `${own.sha}..${mine.sha}`) : 0;
  const tip = localOnly > 0 ? mine!.sha : tipFacts.sha;
  const [behindText, aheadText] = (await git(mirror, ['rev-list', '--left-right', '--count', `${mainRef}...${tip}`, '--'])).trim().split(/\s+/);
  const ahead = Number(aheadText) || 0;
  if (ahead === 0) {
    return undefined;
  }
  const ticket = ticketKey(name, tipFacts.subject);
  const base = (await git(mirror, ['merge-base', mainRef, tip])).trim();
  const cherry = lines(await git(mirror, ['cherry', mainRef, tip]));
  let isLanded = cherry.length > 0 && cherry.every((line) => line.startsWith('-'));
  let earlier = false;
  if (ticket !== null) {
    const named = lines(await git(mirror, ['log', '--first-parent', '-E', `--grep=(^|[^A-Za-z0-9])${escapeRegExp(ticket)}([^0-9]|$)`, '--format=%H %P', mainRef, '--']));
    earlier = named.length > 0;
    if (!isLanded && named.length > 0 && base !== '') {
      const since = new Set(lines(await git(mirror, ['rev-list', '--first-parent', `${base}..${mainRef}`, '--'])));
      for (const line of named) {
        const [sha, , merged] = line.split(' ');
        if (sha === undefined || !since.has(sha)) {
          continue;
        }
        // A merge of an earlier tip of this branch is not this branch's landing.
        if (merged !== undefined && (await gitOk(mirror, ['merge-base', '--is-ancestor', merged, tip]))) {
          continue;
        }
        isLanded = true;
        break;
      }
    }
  }
  let isMine = own === undefined || [own, mine].some((facts) => facts !== undefined && same(facts.email, options.me));
  if (!isMine && options.me !== null) {
    const emails = lines(await git(mirror, ['log', '--format=%ae', `${mainRef}..${tip}`, '--']));
    isMine = emails.some((email) => same(email, options.me));
  }
  const branch: LiveBranch = {
    name, local: own === undefined, author: tipFacts.author, mine: isMine, date: new Date(newest).toISOString(), age_days: Math.max(0, Math.floor(age)),
    ahead, behind: Number(behindText) || 0, local_only: localOnly, subject: tipFacts.subject, ticket, landed: isLanded, earlier_merge: earlier,
  };
  if (isMine && !isLanded && base !== '') {
    const files = lines(await git(mirror, ['diff', '--no-renames', '--name-only', base, tip, '--']));
    const changed = mainChanged.get(base) ?? lines(await git(mirror, ['diff', '--no-renames', '--name-only', base, mainRef, '--']));
    mainChanged.set(base, changed);
    const shared = new Set(changed);
    const overlap = files.filter((file) => shared.has(file));
    const after = new Set(lines(await git(mirror, ['rev-list', `${base}..${mainRef}`, '--'])));
    const hitBy = landed.filter((entry) => after.has(entry.full_sha))
      .map((entry) => ({ sha: entry.sha, files: (landedFiles.get(entry.full_sha) ?? entry.files).filter((file) => overlap.includes(file)) }))
      .filter((hit) => hit.files.length > 0);
    Object.assign(branch, { files: files.slice(0, MAX_FILES), overlap, hit_by: hitBy });
  }
  return branch;
}

// My non-merge commits on every ref of the mirror (refs/sf-local/* too), each once, from since
// until to, newest first; all of them (only the model's input is capped, capModelInput). Git keeps
// only commits whose author line holds my email, so the output is mine; the check here is exact.
async function myCommitsOf(mirror: string, options: ExtractOptions): Promise<MyCommit[]> {
  if (options.me === null) {
    return [];
  }
  const after = new Date(options.since.getTime() - 1000).toISOString();
  const me = options.me;
  // The log is read as a stream, record by record, without a size limit: only my commits are kept.
  const found: Array<Omit<MyCommit, 'stat'> & { full: string }> = [];
  const args = [
    'log', '--all', '--no-merges', '--source', `--since=${after}`, '--fixed-strings', '--regexp-ignore-case', `--author=<${me.trim()}>`,
    `--format=%H${US_FORMAT}%S${US_FORMAT}%cI${US_FORMAT}%ae${US_FORMAT}%B${RS_FORMAT}`,
  ];
  const result = await streamGitRecords(mirror, args, RS.charCodeAt(0), (record) => {
    const [sha, ref, date, email, ...rest] = record.replace(/^\n/, '').split(US);
    if (sha === undefined || !/^[0-9a-f]{40,64}$/.test(sha) || date === undefined || !same(email ?? '', me) || !inPeriod(date, options.since, options.to)) {
      return;
    }
    const body = rest.join(US).trimEnd();
    found.push({ full: sha, sha: sha.slice(0, 10), ref: refName(ref ?? ''), date, subject: body.split('\n')[0] ?? '', why: whyOf(body) });
  }, GIT_TIMEOUT_MS, DIGEST_GIT_ENV);
  if (result.code !== 0) {
    throw new DigestGitError(result.code === null ? `git log timed out after ${Math.round(GIT_TIMEOUT_MS / 1000)} s` : reason(result.stderr) || `git log exited with ${result.code}`);
  }
  const commits: MyCommit[] = [];
  for (const { full, ...commit } of found) {
    commits.push({ ...commit, stat: (await git(mirror, ['show', '--shortstat', '--format=', full, '--'])).trim() });
  }
  return commits;
}

function refName(ref: string): string {
  if (ref.startsWith('refs/sf-local/heads/')) {
    return `${ref.slice('refs/sf-local/heads/'.length)} (local)`;
  }
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

// The Git data of one mirror for the period and the dailies.
export async function extractRepo(mirror: string, options: ExtractOptions): Promise<RepoData> {
  const main = await mainBranch(mirror);
  if (main === undefined) {
    throw new DigestGitError('the mirror has no main branch (HEAD, main or master)');
  }
  const landedFiles = new Map<string, string[]>();
  const notes: string[] = [];
  const landed = await landedOf(mirror, main, options, landedFiles);
  const branches = await branchesOf(mirror, main, landed, landedFiles, options, notes);
  const myCommits = options.myWork ? await myCommitsOf(mirror, options) : [];
  return { main, me: options.me, landed, branches, my_commits: myCommits, notes };
}

// ---------- The counts and the model's input cap ----------

// A branch of mine that needs attention: not landed, and files shared with main or more than 10
// commits behind.
export const BEHIND_FLAG = 10;
export function needsAttention(branch: LiveBranch): boolean {
  return branch.mine && !branch.landed && ((branch.overlap?.length ?? 0) > 0 || branch.behind > BEHIND_FLAG);
}

// The pieces of the model's input the cap may cut: each landed entry and my commit with its date.
interface Cuttable {
  date: string;
  diff_excerpt?: string;
  why: string;
}

// Caps the model's input (its JSON) at max characters, a hard bound. In order, each step only while
// the input is still over: the diff excerpts of the oldest entries, then their "why" texts, then the
// oldest entries themselves (out of their lists), then the last items of the longest lists left
// (files, branches, ...), and last the longest texts, cut in half. Deterministic: the same input
// is cut the same way. Returns the note that says what was left out, or null when nothing was. The
// input is changed in place.
export function capModelInput(input: unknown, entries: Cuttable[], max = MAX_MODEL_INPUT_CHARS): string | null {
  const sizeOf = (): number => JSON.stringify(input).length;
  let size = sizeOf();
  if (size <= max) {
    return null;
  }
  const oldest = [...entries].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  let excerpts = 0;
  let whys = 0;
  for (const entry of oldest) {
    if (size <= max) {
      break;
    }
    if (entry.diff_excerpt !== undefined) {
      size -= JSON.stringify(entry.diff_excerpt).length + '"diff_excerpt":,'.length;
      delete entry.diff_excerpt;
      excerpts += 1;
    }
  }
  for (const entry of oldest) {
    if (size <= max) {
      break;
    }
    if (entry.why !== '') {
      size -= JSON.stringify(entry.why).length - 2;
      entry.why = '';
      whys += 1;
    }
  }
  size = sizeOf();
  // The oldest entries, whole.
  const dropped = new Set<unknown>();
  for (const entry of oldest) {
    if (size <= max) {
      break;
    }
    dropped.add(entry);
    size -= JSON.stringify(entry).length + 1;
  }
  if (dropped.size > 0) {
    for (const list of listsOf(input)) {
      const kept = list.filter((item) => !dropped.has(item));
      list.splice(0, list.length, ...kept);
    }
    size = sizeOf();
  }
  // The last items of the longest lists.
  let items = 0;
  while (size > max) {
    const list = listsOf(input).filter((candidate) => candidate.length > 0).sort((a, b) => b.length - a.length)[0];
    if (list === undefined) {
      break;
    }
    list.pop();
    items += 1;
    size = sizeOf();
  }
  // The longest texts, in half.
  let texts = 0;
  while (size > max) {
    const longest = longestText(input);
    if (longest === undefined || longest.length === 0) {
      break;
    }
    longest.holder[longest.key] = (longest.holder[longest.key] as string).slice(0, Math.floor(longest.length / 2));
    texts += 1;
    size = sizeOf();
  }
  const parts = [`${excerpts} diff excerpt(s) and ${whys} "why" text(s) of the oldest entries`];
  if (dropped.size > 0) {
    parts.push(`${dropped.size} of the oldest entries`);
  }
  if (items > 0) {
    parts.push(`${items} item(s) at the end of the longest lists`);
  }
  if (texts > 0) {
    parts.push(`half of the ${texts} longest text(s)`);
  }
  return `The Git data was over ${max} characters: ${parts.join(', then ')} were left out.`;
}

// Every list in a JSON value, outer ones first.
function listsOf(value: unknown, lists: unknown[][] = []): unknown[][] {
  if (Array.isArray(value)) {
    lists.push(value);
    value.forEach((item) => listsOf(item, lists));
  } else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((item) => listsOf(item, lists));
  }
  return lists;
}

// The longest string of a JSON value, with where it is; the first one found among equals.
function longestText(value: unknown, best?: { holder: Record<string, unknown>; key: string; length: number }): { holder: Record<string, unknown>; key: string; length: number } | undefined {
  if (value === null || typeof value !== 'object') {
    return best;
  }
  const holder = value as Record<string, unknown>;
  for (const key of Object.keys(holder)) {
    const item = holder[key];
    if (typeof item === 'string') {
      if (best === undefined || item.length > best.length) {
        best = { holder, key, length: item.length };
      }
    } else {
      best = longestText(item, best);
    }
  }
  return best;
}
