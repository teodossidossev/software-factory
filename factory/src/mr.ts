// MR preparation steps on the work checkout, all through runGit: the target, the MR text, the
// factory's commit and rebase at Clean, the conflict resolution around it, the push and the merge
// request link. Git runs here outside the sandbox, so the repository's hooks are switched off.
// The Execution drives them around the Implementer's turns; this module runs no turn.
import { type FileHandle, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import { changedPaths, writeResolutionPatch } from './patch.js';
import { itemLine, type ReviewItem } from './review.js';
import { type LedgerEntry, notFixed, notFixedLine } from './ledger.js';
import { type Suggestion, suggestionLine } from './simplify.js';
import { headerProblem, MR_REQUIRED_HEADINGS, testingProblem } from './rules.js';
import { TASK_DIR } from './task-file.js';

const FETCH_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;
// Each Git call of the commit and the rebase; a signing prompt that never returns ends here.
const GIT_TIMEOUT_MS = 60_000;
// Paths per Git call, well below the argv limit.
const PATH_CHUNK = 200;
export const MAX_MR_TEXT_BYTES = 64 * 1024;

export interface MrFailure {
  code: string;
  message: string;
}

export function mrTextPath(ticket: string): string {
  return `${TASK_DIR}/${ticket}.mr.md`;
}

async function gitText(cwd: string, args: string[]): Promise<{ ok: boolean; text: string; stderr: string }> {
  const result = await runGit(cwd, args);
  return { ok: result.code === 0, text: result.stdout.toString('utf8').trim(), stderr: result.stderr.trim() };
}

// Git as the factory runs it in the worktree at Clean: no repository hooks (they would run
// outside the sandbox) and a timeout.
function factoryGit(cwd: string, args: string[]): ReturnType<typeof runGit> {
  return runGit(cwd, ['-c', 'core.hooksPath=/dev/null', ...args], 1024 * 1024, GIT_TIMEOUT_MS);
}

// Why a factory Git call failed: its stderr, or its stdout when stderr is empty (Git prints some
// rebase refusals on stdout).
export function gitFailure(args: string[], result: { code: number | null; stderr: string; stdout: Buffer }): string {
  const command = `git ${args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-c') ?? args[0]}`;
  if (result.code === null) {
    return `${command} did not finish within ${GIT_TIMEOUT_MS / 1000} s`;
  }
  const stderr = result.stderr.trim();
  return `${command} failed: ${(stderr !== '' ? stderr : result.stdout.toString('utf8').trim()).slice(0, 500)}`;
}

// stdout of a factory Git call that must succeed.
async function factoryGitOk(cwd: string, args: string[]): Promise<string> {
  const result = await factoryGit(cwd, args);
  if (result.code !== 0) {
    throw new Error(gitFailure(args, result));
  }
  return result.stdout.toString('utf8');
}

function nulList(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

function chunks<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += PATH_CHUNK) {
    result.push(items.slice(start, start + PATH_CHUNK));
  }
  return result;
}

const literal = (path: string): string => `:(literal)${path}`;

// The ref to start from or rebase onto: origin/<base> after a fetch when origin exists, else the
// local <base>; and its commit.
export async function resolveTarget(cwd: string, base: string): Promise<{ ref: string; commit: string }> {
  const remotes = (await gitText(cwd, ['remote'])).text.split('\n');
  let ref = `refs/heads/${base}`;
  if (remotes.includes('origin')) {
    const fetch = await runGit(cwd, ['fetch', '--no-recurse-submodules', 'origin', base], 1024 * 1024, FETCH_TIMEOUT_MS);
    if (fetch.code !== 0) {
      if (/couldn't find remote ref/i.test(fetch.stderr)) {
        throw new FactoryError('base_not_found', `The base "${base}" does not exist on origin.`);
      }
      throw new FactoryError('fetch_failed', fetch.code === null ? 'git fetch origin did not finish within 60 s.' : 'git fetch origin failed.');
    }
    ref = `refs/remotes/origin/${base}`;
  }
  const resolved = await gitText(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!resolved.ok || resolved.text === '') {
    throw new FactoryError('base_not_found', `The base "${base}" was not found${ref.startsWith('refs/remotes') ? ' on origin' : ''}.`);
  }
  return { ref: ref.replace(/^refs\/(heads|remotes)\//, ''), commit: resolved.text };
}

async function gitDir(cwd: string): Promise<string> {
  return resolve(cwd, (await gitText(cwd, ['rev-parse', '--git-dir'])).text);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// True while a rebase is in progress in the worktree.
export async function rebaseInProgress(cwd: string): Promise<boolean> {
  const dir = await gitDir(cwd);
  return (await exists(join(dir, 'rebase-merge'))) || (await exists(join(dir, 'rebase-apply')));
}

// True while a rebase is in progress or Git holds the index lock.
export async function gitBusy(cwd: string): Promise<boolean> {
  return (await rebaseInProgress(cwd)) || (await exists(join(await gitDir(cwd), 'index.lock')));
}

// Problems of the MR text, or undefined when it is valid.
export function mrTextProblem(ticket: string, text: string): string | undefined {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (text.trim() === '') {
    return 'it is empty';
  }
  if (bytes > MAX_MR_TEXT_BYTES) {
    return `it has ${bytes} bytes, more than ${MAX_MR_TEXT_BYTES}`;
  }
  const lines = text.split(/\r?\n/);
  const header = headerProblem(ticket, lines[0]!);
  if (header !== undefined) {
    return `its first line "${lines[0]!.slice(0, 100)}" is not a valid title: ${header}`;
  }
  const missing = MR_REQUIRED_HEADINGS.filter((heading) => !lines.some((line) => line.trimEnd() === heading));
  if (missing.length > 0) {
    return `it lacks the heading(s) ${missing.join(', ')}`;
  }
  return testingProblem(lines);
}

// The MR text the Implementer wrote into the worktree, validated: missing or empty is
// mr_text_missing, any other problem mr_text_invalid.
export async function readMrText(cwd: string, ticket: string): Promise<{ ok: true; text: string } | ({ ok: false } & MrFailure)> {
  const fail = (code: string, message: string) => ({ ok: false as const, code, message });
  const path = mrTextPath(ticket);
  let text: string;
  try {
    const stats = await lstat(join(cwd, path));
    if (!stats.isFile()) {
      return fail('mr_text_missing', `${path} is not a regular file.`);
    }
    if (stats.size > MAX_MR_TEXT_BYTES) {
      return fail('mr_text_invalid', `${path} has ${stats.size} bytes, more than ${MAX_MR_TEXT_BYTES}.`);
    }
    text = await readFile(join(cwd, path), 'utf8');
  } catch {
    return fail('mr_text_missing', `${path} does not exist.`);
  }
  const invalid = mrTextProblem(ticket, text);
  if (invalid !== undefined) {
    return fail(text.trim() === '' ? 'mr_text_missing' : 'mr_text_invalid', `${path} is invalid: ${invalid}.`);
  }
  return { ok: true, text };
}

const SPECIAL_HEADING = '## Special things to note';
export const NITS_HEADING = '### Nits not applied';

// Within the lines from to to, the index of heading and of the next line that matches stop after
// it, both outside a code fence (end is to without one); undefined when the heading is absent.
function sectionRange(lines: string[], heading: string, from: number, to: number, stop: RegExp): { start: number; end: number } | undefined {
  let fenced = false;
  let start: number | undefined;
  for (let index = from; index < to; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('```')) {
      fenced = !fenced;
    } else if (!fenced && start === undefined && line.trimEnd() === heading) {
      start = index;
    } else if (!fenced && start !== undefined && stop.test(line)) {
      return { start, end: index };
    }
  }
  return start === undefined ? undefined : { start, end: to };
}

// The MR text with the factory's list of the nits not applied (SF-051): a `### Nits not applied`
// subsection at the end of `## Special things to note`, one line per nit (withSubsection).
export function withNits(text: string, nits: ReviewItem[], iteration: number): string {
  return withSubsection(text, NITS_HEADING, nits.map((item) => `- ${itemLine(item)}`), (rest) => `- … and ${rest} more: see review.json and gate.json of iteration ${iteration}.`);
}

export const FINDINGS_HEADING = '### Review findings not fixed';

// The MR text with the factory's list of the review findings not fixed (SF-052): every
// accepted_risk, contested and left entry of the ledger, one line each with its id, as a
// `### Review findings not fixed` subsection of `## Special things to note` (withSubsection).
export function withFindings(text: string, ledger: LedgerEntry[]): string {
  return withSubsection(text, FINDINGS_HEADING, notFixed(ledger).map(notFixedLine), (rest) => `- … and ${rest} more: see ledger.json of the job.`);
}

export const SIMPLIFY_HEADING = '### Simplifications not applied';

// The MR text with the suggestions of the simplification pass the user skipped (SF-055), one line
// each, as a `### Simplifications not applied` subsection of `## Special things to note`
// (withSubsection), so they can become a follow-up ticket.
export function withSimplifications(text: string, suggestions: Suggestion[], iteration: number): string {
  return withSubsection(text, SIMPLIFY_HEADING, suggestions.map((item) => `- ${suggestionLine(item)}`), (rest) => `- … and ${rest} more: see simplify.json of iteration ${iteration}.`);
}

// The MR text with a subsection the factory writes (heading) at the end of `## Special things
// to note`, one line per entry, replacing any such subsection already there (the model's, or an
// earlier preparation's). A lone `- None.` there goes. Without entries only the old subsection
// goes; without either the text stays as it is. The list is cut, with a closing line (more) that
// counts the rest, so the text stays within MAX_MR_TEXT_BYTES.
function withSubsection(text: string, heading: string, entries: string[], more: (rest: number) => string): string {
  const lines = text.split('\n');
  const special = sectionRange(lines, SPECIAL_HEADING, 0, lines.length, /^#{1,2} /u);
  if (special === undefined) {
    return text;
  }
  const old = sectionRange(lines, heading, special.start + 1, special.end, /^#{1,3} /u);
  if (entries.length === 0 && old === undefined) {
    return text;
  }
  let body = lines.slice(special.start + 1, special.end);
  if (old !== undefined) {
    body = [...lines.slice(special.start + 1, old.start), ...lines.slice(old.end, special.end)];
  }
  while (body.length > 0 && body.at(-1)!.trim() === '') {
    body.pop();
  }
  const build = (section: string[]): string => [...lines.slice(0, special.start + 1), ...section, ...lines.slice(special.end)].join('\n');
  if (entries.length === 0) {
    return build(special.end < lines.length ? [...body, ''] : body);
  }
  const content = body.filter((line) => line.trim() !== '');
  if (content.length === 1 && /^\s*[-*]\s+None\.?\s*$/iu.test(content[0]!)) {
    body = body.filter((line) => line.trim() === '');
  }
  const lead = body.some((line) => line.trim() !== '') ? [...body, ''] : body;
  for (let shown = entries.length; shown >= 0; shown -= 1) {
    const rest = entries.length - shown;
    const list = [...entries.slice(0, shown), ...(rest > 0 ? [more(rest)] : [])];
    const result = build([...lead, heading, ...list, ...(special.end < lines.length ? [''] : [])]);
    if (Buffer.byteLength(result, 'utf8') <= MAX_MR_TEXT_BYTES) {
      return result;
    }
  }
  return build(special.end < lines.length ? [...body, ''] : body);
}

// The MR text as one message, for the factory's commit and for the forge's merge request alike:
// the title is the first line, the body is the rest without the blank lines around it. CRLF
// becomes LF and every line loses its trailing whitespace (a Markdown hard break is lost).
export function mrMessage(text: string): { title: string; body: string } {
  const [title = '', ...rest] = text.split(/\r?\n/).map((line) => line.trimEnd());
  while (rest.length > 0 && rest[0] === '') {
    rest.shift();
  }
  while (rest.length > 0 && rest.at(-1) === '') {
    rest.pop();
  }
  return { title, body: rest.join('\n') };
}

// The subset of paths that are submodules: a directory in the worktree whose index entry has
// mode 160000. Their pointer is never committed by the factory (Git rules).
export async function submodulePaths(cwd: string, paths: string[]): Promise<string[]> {
  const gitlinks = new Set<string>();
  for (const chunk of chunks(paths)) {
    const output = await factoryGitOk(cwd, ['ls-files', '--stage', '-z', '--', ...chunk.map(literal)]);
    for (const entry of nulList(output)) {
      const match = /^160000 [0-9a-f]+ \d+\t(.*)$/s.exec(entry);
      if (match !== null) {
        gitlinks.add(match[1]!);
      }
    }
  }
  const result: string[] = [];
  for (const path of paths) {
    if (gitlinks.has(path) && (await lstat(join(cwd, path)).then((stats) => stats.isDirectory(), () => false))) {
      result.push(path);
    }
  }
  return result;
}

// The paths the factory commits: the Patch's paths against baseCommit (tracked and untracked,
// filtered as the Patch is) without the submodules.
export async function commitPaths(cwd: string, baseCommit: string): Promise<string[]> {
  const { tracked, untracked } = await changedPaths(cwd, baseCommit);
  const paths = [...new Set([...tracked, ...untracked])].sort();
  const submodules = new Set(await submodulePaths(cwd, paths));
  return paths.filter((path) => !submodules.has(path));
}

// The paths left unmerged by a stopped rebase.
export async function unmergedPaths(cwd: string): Promise<string[]> {
  return nulList(await factoryGitOk(cwd, ['diff', '--name-only', '-z', '--diff-filter=U'])).sort();
}

// How the factory's commit and rebase at Clean ended: the branch is ready, the rebase stopped on
// conflicts in files (and stays in progress), or a failure (no rebase left in progress).
export type Prepared = { kind: 'ready' } | { kind: 'conflict'; files: string[] } | { kind: 'failed'; failure: MrFailure };

// Aborts a rebase in progress; true when there was one (also one that sf serve left behind when
// it restarted during a conflict turn).
export async function abortRebase(cwd: string): Promise<boolean> {
  if (!(await rebaseInProgress(cwd))) {
    return false;
  }
  await factoryGitOk(cwd, ['rebase', '--abort']);
  return true;
}

// The reviewed change as one commit on top of baseCommit, rebased onto targetCommit. A commit
// already on the branch (a fix after Clean, a retry) is undone first with `reset --mixed`, which
// leaves the working tree alone, so the result is always one commit. The identity and the signing
// configuration are the user's Git configuration.
export async function commitAndRebase(cwd: string, input: { baseCommit: string; targetCommit: string; mrText: string }): Promise<Prepared> {
  const { baseCommit, targetCommit, mrText } = input;
  const head = (await factoryGitOk(cwd, ['rev-parse', '--verify', 'HEAD'])).trim();
  if (head !== baseCommit) {
    await factoryGitOk(cwd, ['reset', '-q', '--mixed', baseCommit]);
  }
  for (const chunk of chunks(await commitPaths(cwd, baseCommit))) {
    await factoryGitOk(cwd, ['add', '--all', '--', ...chunk.map(literal)]);
  }
  const staged = await factoryGit(cwd, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) {
    return { kind: 'failed', failure: { code: 'mr_empty', message: 'The reviewed change has nothing to commit against the base.' } };
  }
  if (staged.code !== 1) {
    throw new Error(gitFailure(['diff'], staged));
  }
  // The message is the whole MR text, through a file in the Git dir (never a change of the
  // worktree; runGit has no stdin), kept verbatim so its # headings stay.
  const { title, body } = mrMessage(mrText);
  const messagePath = resolve(cwd, (await factoryGitOk(cwd, ['rev-parse', '--git-path', 'factory-commit-msg'])).trim());
  const commitArgs = ['commit', '-q', '--cleanup=verbatim', '-F', messagePath];
  let committed: Awaited<ReturnType<typeof runGit>>;
  try {
    await writeFile(messagePath, `${body === '' ? title : `${title}\n\n${body}`}\n`);
    committed = await factoryGit(cwd, commitArgs);
  } finally {
    await rm(messagePath, { force: true });
  }
  if (committed.code !== 0) {
    return { kind: 'failed', failure: { code: 'mr_commit_failed', message: `${gitFailure(commitArgs, committed)}.` } };
  }
  if ((await factoryGit(cwd, ['merge-base', '--is-ancestor', targetCommit, 'HEAD'])).code === 0) {
    return { kind: 'ready' };
  }
  const rebased = await factoryGit(cwd, ['rebase', '-q', targetCommit]);
  if (rebased.code === 0) {
    return { kind: 'ready' };
  }
  const files = rebased.code === null ? [] : await unmergedPaths(cwd);
  if (files.length > 0) {
    return { kind: 'conflict', files };
  }
  await abortRebase(cwd);
  return { kind: 'failed', failure: { code: 'mr_rebase_failed', message: `${gitFailure(['rebase'], rebased)}.` } };
}

// A line a conflict resolution must not leave behind.
const CONFLICT_MARKER = /^(<<<<<<< |=======\r?$|>>>>>>> )/m;

// The files of a stopped rebase that still hold a conflict marker line.
export async function filesWithMarkers(cwd: string, files: string[]): Promise<string[]> {
  const marked: string[] = [];
  for (const file of files) {
    const text = await readFile(join(cwd, file), 'utf8').catch(() => '');
    if (CONFLICT_MARKER.test(text)) {
      marked.push(file);
    }
  }
  return marked;
}

// After the conflict turn: every change of the worktree against the target is staged (the
// conflicted files and any other file the turn changed, filtered as the factory's commit is) and
// the rebase continues. A file that still holds a marker aborts the rebase (mr_conflict). A
// continue that fails first saves the resolved worktree, a patch against targetCommit: save opens
// the file, runs the writer it is given on it and returns where the patch is. Then the rebase is
// aborted (mr_conflict naming the patch); nothing is retried.
export async function continueRebase(
  cwd: string, input: { files: string[]; targetCommit: string; save: (write: (handle: FileHandle) => Promise<void>) => Promise<string> },
): Promise<MrFailure | undefined> {
  const { files, targetCommit, save } = input;
  const conflict = (detail: string): MrFailure => ({ code: 'mr_conflict', message: `The rebase had conflicts in ${files.join(', ')}; ${detail} The rebase was aborted.` });
  const marked = await filesWithMarkers(cwd, files);
  if (marked.length > 0) {
    await abortRebase(cwd);
    return conflict(`conflict markers are left in ${marked.join(', ')}.`);
  }
  const changed = await commitPaths(cwd, targetCommit);
  for (const chunk of chunks([...new Set([...files, ...changed])].sort())) {
    await factoryGitOk(cwd, ['add', '--all', '--', ...chunk.map(literal)]);
  }
  const continued = await factoryGit(cwd, ['-c', 'core.editor=true', 'rebase', '--continue']);
  if (continued.code !== 0) {
    // The saved patch first, so a message cut short still names it.
    let kept: string;
    try {
      kept = `the resolved files are saved in ${await save((handle) => writeResolutionPatch(cwd, targetCommit, handle.fd))}, a patch against ${targetCommit}`;
    } catch (error) {
      kept = `the resolved files could not be saved (${(error as Error).message.slice(0, 200)})`;
    }
    await abortRebase(cwd);
    return { code: 'mr_conflict', message: `The rebase had conflicts in ${files.join(', ')}; ${kept}. ${gitFailure(['rebase'], continued)}. The rebase was aborted.` };
  }
  return undefined;
}

// Nothing is pushed to main (or master) or to the job's base directly; every change reaches it
// through a merge request (Handbook, Git rules).
export const PROTECTED_BRANCHES: readonly string[] = ['main', 'master'];

export function pushProtection(branch: string, base: string): MrFailure | undefined {
  if (branch !== base && !PROTECTED_BRANCHES.includes(branch)) {
    return undefined;
  }
  return {
    code: 'mr_push_protected',
    message: `refusing to push ${branch}: nothing is pushed to main, master or the base branch (${base}) directly; every change goes through a merge request`,
  };
}

export async function pushBranch(cwd: string, branch: string, base: string): Promise<MrFailure | undefined> {
  const protectedFailure = pushProtection(branch, base);
  if (protectedFailure !== undefined) {
    return protectedFailure;
  }
  const result = await runGit(cwd, ['push', 'origin', `${branch}:${branch}`], 1024 * 1024, PUSH_TIMEOUT_MS);
  if (result.code === 0) {
    return undefined;
  }
  const detail = result.code === null ? 'it did not finish within 120 s' : result.stderr.trim().slice(0, 1000);
  return { code: 'mr_push_failed', message: `git push origin ${branch} failed: ${detail}` };
}

export async function originUrl(cwd: string): Promise<string | undefined> {
  const result = await gitText(cwd, ['remote', 'get-url', 'origin']);
  return result.ok && result.text !== '' ? result.text : undefined;
}

// The host and the repository path of an origin URL (https, ssh, git or scp-like): the host with
// its port for http(s), without it otherwise; the path without slashes around it and without
// .git. Undefined for a local path or a URL without an owner/repository path.
export function parseOrigin(url: string): { host: string; path: string } | undefined {
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(url);
  if (/^(https?|ssh|git):\/\//.test(url)) {
    const parsed = URL.parse(url);
    if (parsed === null || parsed.hostname === '') {
      return undefined;
    }
    host = parsed.protocol.startsWith('http') ? parsed.host : parsed.hostname;
    path = parsed.pathname;
  } else if (scp !== null) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return undefined;
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (path === '' || !path.includes('/')) {
    return undefined;
  }
  return { host, path };
}

// The page that opens a merge request for branch into base, derived from the origin URL:
// GitHub's compare view for github.com, GitLab's new merge request form otherwise.
export function mergeRequestLink(url: string, base: string, branch: string): string | undefined {
  const origin = parseOrigin(url);
  if (origin === undefined) {
    return undefined;
  }
  const { host, path } = origin;
  if (host === 'github.com') {
    return `https://${host}/${path}/compare/${base}...${branch}?expand=1`;
  }
  return `https://${host}/${path}/-/merge_requests/new?merge_request[source_branch]=${branch}&merge_request[target_branch]=${base}`;
}
