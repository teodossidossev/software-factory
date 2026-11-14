// The decision documents of a workspace: the files of a checkout that say what was decided about
// the product (its concepts, its domain rules, its architecture), found by the decision_docs globs
// of norms.json (src/norms.ts). The Task check and both reviewers get their list, paths and sizes
// only, and read the files themselves with the tools they have; a workspace whose globs match
// nothing gets nothing of this. The coding rules and their budget (src/rules-docs.ts) are apart.
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit } from './git.js';
import { norms } from './norms.js';
import { configDir } from './registry.js';
import { matchesGlob } from './rules.js';

// The most documents listed; the rest are counted on the block's last line.
export const MAX_LISTED_DECISION_DOCS = 60;
// The most bytes of `git ls-files -s -z` read: a checkout listed past it gives no documents.
const MAX_LISTING_BYTES = 64 * 1024 * 1024;
const LISTING_TIMEOUT_MS = 60_000;

export interface DecisionDoc { path: string; bytes: number }
export interface DecisionDocs { docs: DecisionDoc[]; left_out: number }

const none = (): DecisionDocs => ({ docs: [], left_out: 0 });

// The tracked regular files of the index: `git ls-files -s -z` entries "<mode> <object> <stage>\t<path>",
// symbolic links (120000) and submodules (160000) left out.
function regularPaths(listing: string): string[] {
  const paths = new Set<string>();
  for (const entry of listing.split('\0')) {
    const tab = entry.indexOf('\t');
    const mode = entry.slice(0, entry.indexOf(' '));
    const path = entry.slice(tab + 1);
    if (tab > 0 && (mode === '100644' || mode === '100755')) {
      paths.add(path);
    }
  }
  return [...paths];
}

// The size of the file at the relative path under root (a real path), or undefined when it is not a
// regular file there reached without a symbolic link: a link, a path through one, or a missing file.
async function regularSize(root: string, path: string): Promise<number | undefined> {
  const full = join(root, path);
  try {
    if (await realpath(full) !== full) {
      return undefined;
    }
    const info = await stat(full);
    return info.isFile() ? info.size : undefined;
  } catch { // missing from the worktree or unreadable: not a document to read
    return undefined;
  }
}

// The decision documents of the checkout or worktree at dir: its tracked files (git ls-files) that
// one of the globs names (as scope: globs match, src/rules.ts), but symbolic links and paths through
// them, sorted by the code-unit order of the relative path; the first MAX_LISTED_DECISION_DOCS with
// their sizes in dir, the rest counted in left_out. A failure to list gives no documents. Never throws.
export async function decisionDocs(dir: string, globs: readonly string[]): Promise<DecisionDocs> {
  if (globs.length === 0) {
    return none();
  }
  let root: string;
  let listing: string;
  try {
    root = await realpath(dir);
    const listed = await runGit(root, ['ls-files', '-s', '-z'], MAX_LISTING_BYTES, LISTING_TIMEOUT_MS);
    if (listed.code !== 0 || listed.truncated) {
      return none();
    }
    listing = listed.stdout.toString('utf8');
  } catch { // no directory, no Git, or not a checkout: no documents
    return none();
  }
  const matched = regularPaths(listing).filter((path) => globs.some((glob) => glob === path || matchesGlob(path, glob))).sort();
  const sizes = await Promise.all(matched.map((path) => regularSize(root, path)));
  const docs = matched.flatMap((path, index) => (sizes[index] === undefined ? [] : [{ path, bytes: sizes[index] }]));
  return { docs: docs.slice(0, MAX_LISTED_DECISION_DOCS), left_out: Math.max(0, docs.length - MAX_LISTED_DECISION_DOCS) };
}

// The decision documents of the workspace in dir, by its decision_docs globs in norms.json read now
// from config (the configuration directory). Never throws.
export async function workspaceDecisionDocs(workspace: string, dir: string, config: string = configDir()): Promise<DecisionDocs> {
  return decisionDocs(dir, (await norms(workspace, config)).norms.decision_docs);
}

// The <decision_documents> block, the same in the Task check's prompt and the reviewers': one
// "<path> (<bytes> bytes)" line per document and, when some are left out, a line counting them.
// A path with a control character, or one that begins with '"', is written as a JSON string, so each
// document stays one line of the block and a quoted path cannot be taken for a plain one. No
// document: no block.
export function decisionBlock(list: DecisionDocs | undefined): string[] {
  if (list === undefined || list.docs.length === 0) {
    return [];
  }
  const shown = (path: string): string => (/^"|[\u0000-\u001f]/.test(path) ? JSON.stringify(path) : path);
  return [
    '<decision_documents>',
    ...list.docs.map((doc) => `${shown(doc.path)} (${doc.bytes} bytes)`),
    ...(list.left_out > 0 ? [`(${list.left_out} more ${list.left_out === 1 ? 'is' : 'are'} not listed)`] : []),
    '</decision_documents>',
  ];
}

// The Task check's instructions about the decision documents, sent only with the block.
export const DECISION_CHECK_LINES: readonly string[] = [
  '- The decision documents below (<decision_documents>) say what was decided about the product: its concepts, its domain rules, its architecture. Read the glossary and terminology pages, and the decision records and architecture pages whose titles bear on the Task.',
  '- A Task that contradicts a decision document is a `contradiction`, always a blocker: `where` is `<path>#<heading>`, and `problem` quotes the sentence it contradicts.',
  '- A Task that decides something of the product that no decision document covers (a concept\'s name or meaning, a rule of the domain, what the user sees or may do) is a `decision`: say what is decided and what the Task assumes.',
  '- Coding style and conventions are not part of this check against the decision documents.',
];

// The lines the Task check's prompt gets after its instructions: DECISION_CHECK_LINES, then the
// block; nothing without a document, so its prompt stays as it was.
export function checkDecisionLines(list: DecisionDocs | undefined): string[] {
  const block = decisionBlock(list);
  return block.length === 0 ? [] : [...DECISION_CHECK_LINES, ...block];
}

// The lines a reviewer's prompt ends with: an empty line, then the block; nothing without a document.
export function reviewDecisionLines(list: DecisionDocs | undefined): string[] {
  const block = decisionBlock(list);
  return block.length === 0 ? [] : ['', ...block];
}
