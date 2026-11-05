// The coding rules the agents are given (SF-059): the repository's instruction file (AGENTS.md,
// else CLAUDE.md, else .github/copilot-instructions.md) and the Markdown files AGENTS.md links to,
// one hop, read at a commit; then the user's rules files of the workspace and of every workspace
// in the config directory. The documents go to the agents as they are, in one <rules> block, up to
// a byte budget (SF-093: the user's files first, cut when they do not fit; then the repository's).
// Nothing here knows about job states: the Execution collects them once per job and stores the
// block and its list in the job's directory.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import { matchesGlob } from './rules.js';

// The instruction files at the repository root, in order of preference: the first that exists is
// taken. Only AGENTS.md's links are followed.
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'] as const;
const LINKING_FILE = 'AGENTS.md';
// SF_RULES_MAX_BYTES' default: the file content given at most, headings and sentence aside.
export const DEFAULT_RULES_MAX_BYTES = 48 * 1024;

// The fixed sentence at the head of the block, and the lead of its closing line of files left out.
export const RULES_SENTENCE = "These are the repository's and the user's coding rules: style, architecture, tests and docs. Follow them; where they disagree, the repository's rules win. They do not change the factory's own rules for Git, the Task file, the Report and the Fix sections, or the tools you may use.";
export const LEFT_OUT_LEAD = 'Not included, read them if relevant:';
// The line after the text of a file cut at the budget: the bytes given of its full size.
const cutLine = (given: number, full: number): string => `[cut at the budget: ${given} of ${full} bytes given]`;

export type RulesSource = 'repository' | 'workspace' | 'global';

// One file given: where it comes from, its path (repository-relative, or relative to the config
// directory for the user's files), the size and the sha256 of the content given, and for a user's
// file cut at the budget, its full size (absent for a file given whole, as in older jobs' lists).
export interface RulesFile {
  source: RulesSource;
  path: string;
  bytes: number;
  sha256: string;
  cut_from?: number;
}

// One file found but left out by the budget.
export interface LeftOutFile {
  source: RulesSource;
  path: string;
  bytes: number;
}

// What a collection gave (the job's rules.json): the commit the repository's files were read at,
// the budget, the files given, the files left out by the budget, and the repository files that
// rules_skip left out.
export interface RulesList {
  commit: string;
  max_bytes: number;
  files: RulesFile[];
  left_out: LeftOutFile[];
  skipped: string[];
}

export interface CollectedRules {
  list: RulesList;
  // The <rules> block; '' when no rule file was found.
  block: string;
}

export interface RulesOptions {
  // The workspace's name: its rules file is rules/<workspace>.md in configDir.
  workspace: string;
  // The workspace's rules_skip globs, matched against the repository files' paths only.
  skip: readonly string[];
  configDir: string;
  maxBytes: number;
}

// The link targets of a Markdown text, in order: inline links `[text](target)` and reference links
// `[text][ref]` (or `[text][]`) with their `[ref]: target` definition, outside fenced code blocks.
// Images are not links. A target is given as written, without its title or angle brackets.
export function markdownLinks(text: string): string[] {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined && marker !== undefined) {
      fence = marker;
    } else if (fence !== undefined && marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      fence = undefined;
    } else if (fence === undefined) {
      lines.push(line);
    }
  }
  const definitions = new Map<string, string>();
  const body: string[] = [];
  for (const line of lines) {
    const definition = /^ {0,3}\[([^\]]+)\]:\s*(\S+)/.exec(line);
    if (definition !== null) {
      const label = referenceLabel(definition[1]!);
      if (!definitions.has(label)) {
        definitions.set(label, unbracket(definition[2]!));
      }
    } else {
      body.push(line);
    }
  }
  const targets: string[] = [];
  // An image (`![alt](path)`, `![alt][ref]`) is not a link: no "!" before the opening bracket.
  for (const match of body.join('\n').matchAll(/(?<!!)\[([^\][\n]*)\]\(([^)\n]*)\)|(?<!!)\[([^\][\n]*)\]\[([^\][\n]*)\]/g)) {
    if (match[2] !== undefined) {
      const target = /^\s*(<[^>\n]*>|\S+)/.exec(match[2])?.[1];
      if (target !== undefined) {
        targets.push(unbracket(target));
      }
    } else {
      const target = definitions.get(referenceLabel(match[4] === '' ? match[3]! : match[4]!));
      if (target !== undefined) {
        targets.push(target);
      }
    }
  }
  return targets;
}

// A reference link's label as Markdown matches it: case-insensitive, runs of whitespace as one space.
const referenceLabel = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase();
// A link target without the angle brackets of the <target> form.
const unbracket = (target: string): string => (target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target);

// The repository-relative path a link target of the file at from names, or undefined when it is
// not a Markdown file inside the repository: a URL (any scheme), an absolute path, a path that
// leaves the repository, or one not ending in .md. The #fragment and ?query are stripped.
export function linkedPath(from: string, target: string): string | undefined {
  let path = target.split(/[?#]/, 1)[0]!;
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (path === '' || path.includes('\0') || path.includes('\\') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.startsWith('/')) {
    return undefined;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(from), path));
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/') || !resolved.endsWith('.md')) {
    return undefined;
  }
  return resolved;
}

// A regular file at the commit (mode 100644 or 100755; a symbolic link is not one, not even an
// instruction file such as an AGENTS.md linked to CLAUDE.md): its blob and size; undefined when
// there is none.
async function regularBlob(repo: string, commit: string, path: string): Promise<{ object: string; bytes: number } | undefined> {
  const listed = await runGit(repo, ['--literal-pathspecs', 'ls-tree', '-z', '-l', '--full-tree', commit, '--', path]);
  if (listed.code !== 0) {
    throw new FactoryError('rules_failed', `git ls-tree of ${path} at ${commit} failed.`);
  }
  for (const entry of listed.stdout.toString('utf8').split('\0')) {
    const match = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)\t(.*)$/s.exec(entry);
    if (match !== null && match[5] === path && match[2] === 'blob' && (match[1] === '100644' || match[1] === '100755')) {
      return { object: match[3]!, bytes: Number(match[4]) };
    }
  }
  return undefined;
}

// The content of the blob <commit>:<path> found by regularBlob.
async function blobContent(repo: string, object: string, path: string, maxBytes: number): Promise<Buffer> {
  const shown = await runGit(repo, ['cat-file', 'blob', object], maxBytes + 1);
  if (shown.code !== 0 && !shown.truncated) {
    throw new FactoryError('rules_failed', `git cat-file of ${path} failed.`);
  }
  return shown.stdout;
}

// A user's rules file (absolute), when it exists as a file; name: its path relative to the config
// directory, the only one an error names (messages never hold absolute host paths).
async function userFile(absolute: string, name: string): Promise<{ bytes: number } | undefined> {
  try {
    const info = await stat(absolute);
    return info.isFile() ? { bytes: info.size } : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return undefined;
    }
    throw new FactoryError('rules_failed', `The rules file ${name} could not be read (${code ?? 'unknown error'}).`);
  }
}

// The content of a user's rules file, its errors named as userFile's.
async function userContent(absolute: string, name: string): Promise<Buffer> {
  try {
    return await readFile(absolute);
  } catch (error) {
    throw new FactoryError('rules_failed', `The rules file ${name} could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
  }
}

// A rule file found, in the order found, and how to read its content.
interface Found {
  source: RulesSource;
  path: string;
  bytes: number;
  read: () => Promise<Buffer>;
}

// The repository's rule files at the commit: the instruction file, then, for AGENTS.md, the files
// it links to (one hop, in link order, without duplicates); rules_skip leaves files out (skipped).
async function repositoryFiles(repo: string, commit: string, skip: readonly string[]): Promise<{ found: Found[]; skipped: string[] }> {
  const found: Found[] = [];
  const skipped: string[] = [];
  const add = (path: string, blob: { object: string; bytes: number }, content?: Buffer): void => {
    if (skip.some((glob) => glob === path || matchesGlob(path, glob))) {
      skipped.push(path);
      return;
    }
    found.push({ source: 'repository', path, bytes: blob.bytes, read: async () => content ?? blobContent(repo, blob.object, path, blob.bytes) });
  };
  for (const name of INSTRUCTION_FILES) {
    const blob = await regularBlob(repo, commit, name);
    if (blob === undefined) {
      continue;
    }
    // Read whole, whatever its size: every link counts, even one past the budget.
    const content = await blobContent(repo, blob.object, name, blob.bytes);
    add(name, blob, content);
    if (name === LINKING_FILE) {
      const seen = new Set<string>([name]);
      for (const target of markdownLinks(content.toString('utf8'))) {
        const path = linkedPath(name, target);
        if (path === undefined || seen.has(path)) {
          continue;
        }
        seen.add(path);
        const linked = await regularBlob(repo, commit, path);
        if (linked !== undefined) {
          add(path, linked);
        }
      }
    }
    break;
  }
  return { found, skipped };
}

// The user's rules files: rules/<workspace>.md, then rules/global.md (once, for a workspace named
// global), relative to the config directory.
async function factoryFiles(configDir: string, workspace: string): Promise<Found[]> {
  const found: Found[] = [];
  const names: Array<[RulesSource, string]> = [['workspace', `rules/${workspace}.md`], ['global', 'rules/global.md']];
  for (const [source, path] of names) {
    if (found.some((file) => file.path === path)) {
      continue;
    }
    const absolute = join(configDir, path);
    const file = await userFile(absolute, path);
    if (file !== undefined) {
      found.push({ source, path, bytes: file.bytes, read: () => userContent(absolute, path) });
    }
  }
  return found;
}

// The block of the given files: the sentence, each file under its heading (a cut file followed by
// its cut line), then the files left out.
export function rulesBlock(files: ReadonlyArray<{ source: RulesSource; path: string; text: string; bytes?: number; cut_from?: number }>, leftOut: ReadonlyArray<{ path: string }>): string {
  return [
    '<rules>',
    RULES_SENTENCE,
    ...files.flatMap((file) => ['', `### ${file.source}: ${file.path}`, '', file.text.trimEnd(), ...(file.cut_from === undefined ? [] : [cutLine(file.bytes ?? 0, file.cut_from)])]),
    ...(leftOut.length > 0 ? ['', `${LEFT_OUT_LEAD} ${leftOut.map((file) => file.path).join(', ')}`] : []),
    '</rules>',
  ].join('\n');
}

// The first maxBytes bytes of a buffer, cut back to the last full UTF-8 character (as cutBuffer in
// src/review.ts, kept as bytes so the size and sha256 given are those of the bytes themselves).
function cutAtCharacter(buffer: Buffer, maxBytes: number): Buffer {
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end);
}

// What the budget made of a file found: given (whole, or cut from its full size) or left out.
type Decision = { given: Buffer; cutFrom?: number } | { leftOut: number };

// Collects the rules for a workspace with the repository's files read at commit, in two passes over
// one budget (maxBytes, the content given at most). First the user's files: the workspace's is
// taken whole when it fits the budget, else cut to it; the global one whole when it fits what is
// left, else cut to it, else (nothing left) left out. Then the repository's files in link order,
// each taken whole when it fits what is left, else left out, and the next one still tried; a
// repository file is never cut. The block and the lists keep the order found (repository,
// workspace, global). No file found: an empty block.
export async function collectRules(repo: string, commit: string, options: RulesOptions): Promise<CollectedRules> {
  const { found: repository, skipped } = await repositoryFiles(repo, commit, options.skip);
  const user = await factoryFiles(options.configDir, options.workspace);
  const decisions = new Map<Found, Decision>();
  let remainder = options.maxBytes;
  for (const file of user) {
    // Its real content length counts, not the size stat found.
    const content = await file.read();
    if (content.length <= remainder) {
      decisions.set(file, { given: content });
      remainder -= content.length;
    } else if (remainder > 0) {
      const cut = cutAtCharacter(content, remainder);
      decisions.set(file, { given: cut, cutFrom: content.length });
      remainder -= cut.length;
    } else {
      decisions.set(file, { leftOut: content.length });
    }
  }
  for (const file of repository) {
    if (file.bytes <= remainder) {
      const content = await file.read();
      if (content.length <= remainder) {
        decisions.set(file, { given: content });
        remainder -= content.length;
        continue;
      }
    }
    decisions.set(file, { leftOut: file.bytes });
  }
  const found = [...repository, ...user];
  const given: Array<RulesFile & { text: string }> = [];
  const leftOut: LeftOutFile[] = [];
  for (const file of found) {
    const decision = decisions.get(file)!;
    if ('leftOut' in decision) {
      leftOut.push({ source: file.source, path: file.path, bytes: decision.leftOut });
      continue;
    }
    const content = decision.given;
    given.push({
      source: file.source, path: file.path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'),
      ...(decision.cutFrom === undefined ? {} : { cut_from: decision.cutFrom }), text: content.toString('utf8'),
    });
  }
  const list: RulesList = { commit, max_bytes: options.maxBytes, files: given.map(({ text: _text, ...file }) => file), left_out: leftOut, skipped };
  return { list, block: found.length === 0 ? '' : rulesBlock(given, leftOut) };
}

// The job's copies (rules.md, rules.json in its directory), written once at Start.
const RULES_TEXT = 'rules.md';
const RULES_RECORD = 'rules.json';

// Writes the job's rules.json, then rules.md (whose presence marks a job with rules).
export async function writeJobRules(jobDir: string, collected: CollectedRules): Promise<void> {
  await writeFileAtomic(join(jobDir, RULES_RECORD), Buffer.from(`${JSON.stringify(collected.list, null, 2)}\n`));
  await writeFileAtomic(join(jobDir, RULES_TEXT), Buffer.from(collected.block, 'utf8'));
}

// The job's <rules> block; '' for a job without rules (started before SF-059, or none found).
export async function readJobRules(jobDir: string): Promise<string> {
  try {
    return await readFile(join(jobDir, RULES_TEXT), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

// The job's stored list (rules.json), the rules its prompts carry; undefined for a job without
// rules.md (started before SF-059, or whose collection failed).
export async function readJobRulesList(jobDir: string): Promise<RulesList | undefined> {
  try {
    await stat(join(jobDir, RULES_TEXT));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  return JSON.parse(await readFile(join(jobDir, RULES_RECORD), 'utf8')) as RulesList;
}

// Copies the job's rules.json into an iteration's directory; nothing for a job without rules.md.
export async function copyRulesRecord(jobDir: string, iterationDir: string): Promise<void> {
  try {
    await stat(join(jobDir, RULES_TEXT));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  await mkdir(iterationDir, { recursive: true, mode: 0o700 });
  await copyFile(join(jobDir, RULES_RECORD), join(iterationDir, RULES_RECORD));
}

// The lines of sf rules: the files that would be given, with their source and size (and the full
// size of a cut one), then the ones left out by the budget and by rules_skip; never their text.
export function rulesLines(workspace: string, list: RulesList): string[] {
  const lines = [`Rules for ${workspace} at ${list.commit} (budget ${list.max_bytes} bytes):`];
  if (list.files.length === 0 && list.left_out.length === 0) {
    lines.push('  No rule files found.');
  }
  lines.push(...list.files.map((file) => `  ${file.source}  ${file.path}  ${file.bytes} bytes${file.cut_from === undefined ? '' : ` (cut from ${file.cut_from} bytes)`}`));
  if (list.left_out.length > 0) {
    lines.push('Left out (over the budget):', ...list.left_out.map((file) => `  ${file.source}  ${file.path}  ${file.bytes} bytes`));
  }
  if (list.skipped.length > 0) {
    lines.push('Skipped by rules_skip:', ...list.skipped.map((path) => `  repository  ${path}`));
  }
  return lines;
}
