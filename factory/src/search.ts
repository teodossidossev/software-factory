// Bounded path and content search over a read checkout. Candidates come from Git
// (tracked plus untracked, ignored files and .git excluded) and pass the read_file deny list.
// Both modes match case-insensitively.
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import { isForbidden, normalizeRequestPath } from './repo-files.js';

export const MAX_QUERY_CHARS = 256;
export const DEFAULT_RESULTS = 50;
export const MAX_RESULTS = 200;
const MAX_LINE_CHARS = 200;
const MAX_LIST_BYTES = 16 * 1024 * 1024;
const MAX_GREP_BYTES = 4 * 1024 * 1024;

export interface SearchRequest {
  query: string;
  mode: 'path' | 'content';
  path_prefix?: string | undefined;
  max_results?: number | undefined;
}

export interface SearchMatch {
  path: string;
  line?: number;
  text?: string;
}

export interface SearchResult {
  mode: 'path' | 'content';
  query: string;
  path_prefix: string | null;
  matches: SearchMatch[];
  // True when more matches exist than were returned, or Git output hit its bound.
  truncated: boolean;
}

function truncateLine(text: string): string {
  const chars = Array.from(text);
  return chars.length > MAX_LINE_CHARS ? chars.slice(0, MAX_LINE_CHARS).join('') : text;
}

// Parses `git grep -z -n` records: <path> NUL <line> NUL <text> LF.
function parseGrep(output: Buffer, complete: boolean): SearchMatch[] {
  const matches: SearchMatch[] = [];
  let at = 0;
  while (at < output.length) {
    const pathEnd = output.indexOf(0, at);
    const lineEnd = pathEnd < 0 ? -1 : output.indexOf(0, pathEnd + 1);
    let textEnd = lineEnd < 0 ? -1 : output.indexOf(10, lineEnd + 1);
    if (textEnd < 0) {
      if (lineEnd < 0 || !complete) {
        // A record cut off by the output bound.
        break;
      }
      textEnd = output.length;
    }
    matches.push({
      path: output.toString('utf8', at, pathEnd),
      line: Number(output.toString('utf8', pathEnd + 1, lineEnd)),
      text: truncateLine(output.toString('utf8', lineEnd + 1, textEnd)),
    });
    at = textEnd + 1;
  }
  return matches;
}

export async function search(root: string, request: SearchRequest): Promise<SearchResult> {
  const { query, mode } = request;
  if (query.length === 0 || query.length > MAX_QUERY_CHARS || query.includes('\0')) {
    throw new FactoryError('invalid_query', `query must be 1 to ${MAX_QUERY_CHARS} characters without NUL.`);
  }
  const maxResults = request.max_results ?? DEFAULT_RESULTS;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw new FactoryError('invalid_range', `max_results must be an integer from 1 to ${MAX_RESULTS}.`);
  }
  const prefix = request.path_prefix === undefined ? null : normalizeRequestPath(request.path_prefix);
  // Literal pathspecs: a prefix is a directory or file path, never pathspec magic.
  const pathspec = prefix === null ? [] : [prefix];

  let candidates: SearchMatch[];
  let bounded: boolean;
  if (mode === 'path') {
    const result = await runGit(
      root,
      ['--literal-pathspecs', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...pathspec],
      MAX_LIST_BYTES,
    );
    if (result.code !== 0 && !result.truncated) {
      throw new FactoryError('search_failed', 'Git could not list the files of the read checkout.');
    }
    const paths = result.stdout.toString('utf8').split('\0');
    if (result.truncated) {
      // The last entry may be cut off.
      paths.pop();
    }
    const needle = query.toLowerCase();
    candidates = [...new Set(paths)].filter((path) => path !== '' && path.toLowerCase().includes(needle)).map((path) => ({ path }));
    bounded = result.truncated;
  } else {
    const result = await runGit(
      root,
      ['--literal-pathspecs', 'grep', '--no-color', '-z', '-n', '-I', '-i', '--fixed-strings', '--untracked', '-e', query, '--', ...pathspec],
      MAX_GREP_BYTES,
    );
    // git grep exits 1 when nothing matches.
    if (result.code !== 0 && result.code !== 1 && !result.truncated) {
      throw new FactoryError('search_failed', 'Git could not search the read checkout.');
    }
    candidates = parseGrep(result.stdout, !result.truncated);
    bounded = result.truncated;
  }

  const allowed = candidates.filter((match) => !isForbidden(match.path));
  return {
    mode,
    query,
    path_prefix: prefix,
    matches: allowed.slice(0, maxResults),
    truncated: bounded || allowed.length > maxResults,
  };
}
