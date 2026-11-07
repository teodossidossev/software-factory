// The verifiable part of the Git rules, the tool deny lists the factory hands to the Implementer
// session per turn, and the sensitive paths (SF-024). The Handbook (## Git rules, ## MR template)
// is the prose source.

// Conventional Commits types allowed in the commit header.
export const COMMIT_TYPES = ['feat', 'fix', 'chore', 'refactor', 'docs', 'test', 'perf', 'build', 'ci', 'style', 'revert'];
export const MAX_HEADER_CHARS = 72;
// Headings the MR text must contain (all of the MR template's but Screenshots).
export const MR_REQUIRED_HEADINGS = [
  '## What',
  '## Why',
  '## How',
  '## Why the change',
  '## Special things to note',
  '## Change outline',
  '## Testing',
  '## Checklist',
];

// The lines of one level-2 section of the MR text, without its heading, up to the next level-1 or
// level-2 heading outside a code fence; empty when the heading is absent.
export function sectionLines(lines: string[], heading: string): string[] {
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start < 0) {
    return [];
  }
  const section: string[] = [];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('```')) {
      fenced = !fenced;
    } else if (!fenced && /^#{1,2} /u.test(line)) {
      break;
    }
    section.push(line);
  }
  return section;
}

// SF-058: the ## Testing section lists only what was run in this job. The MR prompt states the
// rule; testingProblem refuses the line that most often breaks it.
export const MR_TESTING_RULE = '`## Testing` lists only what was run in this job, with its result; anything not run (manual steps, live checks, browsers) goes on a line starting with `Not checked:`, saying who can run it';
// A line that starts, after any list marker, checkbox or emphasis, with "By hand" or "Manual".
// Exported for the Merge request screen (SF-080), which checks the text live with the same rule.
export const MANUAL_CLAIM = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?[*_]*(?:by hand\b|manual)/iu;

// Why the MR text's ## Testing section claims a manual step as run, or undefined: a line there
// that starts with "By hand" or "Manual" must also contain "not".
export function testingProblem(lines: string[]): string | undefined {
  const claim = manualClaim(lines);
  if (claim === undefined) {
    return undefined;
  }
  return `its ## Testing line "${claim.trim().slice(0, 100)}" reads as a check that was run; ${MR_TESTING_RULE}`;
}

// The first ## Testing line that claims a manual step as run (testingProblem), or undefined.
export function manualClaim(lines: string[]): string | undefined {
  return sectionLines(lines, '## Testing').find((line) => MANUAL_CLAIM.test(line) && !/not/iu.test(line));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The commit header and MR title rule: `<type>(<ticket>): <summary>`, at most 72 characters,
// no trailing period.
export function commitHeader(ticket: string): RegExp {
  return new RegExp(`^(?=.{1,${MAX_HEADER_CHARS}}$)(${COMMIT_TYPES.join('|')})\\(${escapeRegExp(ticket)}\\): \\S.*(?<!\\.)$`, 'u');
}

// Why a header breaks the rule, or undefined when it follows it.
export function headerProblem(ticket: string, header: string): string | undefined {
  if (commitHeader(ticket).test(header)) {
    return undefined;
  }
  const length = [...header].length;
  if (length > MAX_HEADER_CHARS) {
    return `it has ${length} characters, more than ${MAX_HEADER_CHARS}`;
  }
  if (header.endsWith('.')) {
    return 'it ends with a period';
  }
  return `it must match "<type>(${ticket}): <imperative summary>" with <type> one of ${COMMIT_TYPES.join(', ')}`;
}

const ALL_GIT_COMMANDS = [
  'add', 'commit', 'push', 'reset', 'clean', 'stash', 'checkout', 'switch', 'restore', 'rebase', 'merge',
  'cherry-pick', 'revert', 'rm', 'mv', 'tag', 'branch', 'config', 'update-ref', 'update-index', 'worktree', 'am', 'pull', 'fetch',
];
// .env files are off limits to every session, the reviewer's included.
export const ENV_FILE_RULES = ['Read', 'Edit', 'Write'].flatMap((tool) => [`${tool}(**/.env)`, `${tool}(**/.env.*)`]);
// Every turn, MR preparation included: every mutating Git command is the factory's or the user's;
// .git and .env files are off limits; no web tool, which the sandbox does not hold (SF-123).
export const DENIED_TOOLS = [
  ...ALL_GIT_COMMANDS.map((command) => `Bash(git ${command}:*)`),
  'Bash(sudo:*)',
  'EnterWorktree',
  'WebFetch',
  'WebSearch',
  'Edit(.git/**)',
  'Write(.git/**)',
  ...ENV_FILE_RULES,
];

// Paths that are unusual for a ticket to touch: dependency manifests and lockfiles, environment
// and tool configuration, CI and containers, IDE and agent files, and every dotfile in the root.
// Globs from the repository root: `*` and `?` never cross "/", `**` does, `{a,b}` alternates.
export const SENSITIVE_PATHS: readonly string[] = [
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle*', 'gradle.properties',
  'requirements*.txt', 'pyproject.toml', 'Pipfile*', 'poetry.lock', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
  'Gemfile*', 'composer.json', 'composer.lock',
  '**/.env*', '**/*.env', '.npmrc', '.nvmrc', '.tool-versions', 'tsconfig*.json', '*.config.{js,ts,mjs,cjs}',
  '.eslintrc*', '.prettierrc*', '.editorconfig', '.gitignore', '.gitattributes', '.gitmodules',
  '.github/**', '.gitlab-ci.yml', 'Jenkinsfile', 'Dockerfile*', 'docker-compose*.yml', 'compose*.yml', '.dockerignore', 'Makefile',
  '.idea/**', '.vscode/**', '.claude/**', 'CLAUDE.md', 'AGENTS.md',
  '.*',
];

function escapeGlobChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

// A glob as a regular expression over "/"-separated paths from the repository root.
export function globToRegExp(glob: string): RegExp {
  let source = '';
  let index = 0;
  while (index < glob.length) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') {
      // "**/" matches zero or more directories; a trailing "**" matches the rest.
      if (glob[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 3;
      } else {
        source += '.*';
        index += 2;
      }
    } else if (char === '*') {
      source += '[^/]*';
      index += 1;
    } else if (char === '?') {
      source += '[^/]';
      index += 1;
    } else if (char === '{') {
      const end = glob.indexOf('}', index);
      if (end < 0) {
        source += '\\{';
        index += 1;
      } else {
        const options = glob.slice(index + 1, end).split(',').map((option) => [...option].map(escapeGlobChar).join(''));
        source += `(?:${options.join('|')})`;
        index = end + 1;
      }
    } else {
      source += escapeGlobChar(char);
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

const compiled = new Map<string, RegExp>();

export function matchesGlob(path: string, glob: string): boolean {
  let regexp = compiled.get(glob);
  if (regexp === undefined) {
    regexp = globToRegExp(glob);
    compiled.set(glob, regexp);
  }
  return regexp.test(path);
}

export type Sensitivity = 'declared' | 'undeclared' | 'no';

// Whether one of the paths or globs names path.
const names = (globs: readonly string[], path: string): boolean => globs.some((glob) => glob === path || matchesGlob(path, glob));

// Whether a path is sensitive (SENSITIVE_PATHS plus extra globs) and, when it is, whether the
// Task file declared it with may_touch (paths or globs).
export function sensitivityOf(path: string, mayTouch: readonly string[], extra: readonly string[] = []): Sensitivity {
  if (![...SENSITIVE_PATHS, ...extra].some((glob) => matchesGlob(path, glob))) {
    return 'no';
  }
  return names(mayTouch, path) ? 'declared' : 'undeclared';
}

export type Scope = 'in' | 'out' | 'none';

// Whether a path is in the Task's file scope (SF-053): its scope or its may_touch (paths or globs)
// names it; none when the Task declares no scope.
export function scopeOf(path: string, scope: readonly string[] | undefined, mayTouch: readonly string[]): Scope {
  if (scope === undefined) {
    return 'none';
  }
  return names(scope, path) || names(mayTouch, path) ? 'in' : 'out';
}

// The marks of a changed path: whether it is sensitive, whether it is in the Task's scope.
export interface Marks {
  sensitive: Sensitivity;
  scope: Scope;
}

// The marks rule of a Task: its may_touch and scope (undefined: none declared), and the extra
// sensitive globs (SF_SENSITIVE_PATHS).
export function marksOf(mayTouch: readonly string[], scope: readonly string[] | undefined, extra: readonly string[] = []): (path: string) => Marks {
  return (path) => ({ sensitive: sensitivityOf(path, mayTouch, extra), scope: scopeOf(path, scope, mayTouch) });
}
