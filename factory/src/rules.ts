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
// What MR preparation needs: staging, committing, rebasing and resolving conflicts.
const MR_ALLOWED_GIT_COMMANDS = new Set(['add', 'commit', 'rebase', 'restore', 'checkout', 'switch', 'rm', 'mv']);

function deniedTools(gitCommands: string[]): string[] {
  return [
    ...gitCommands.map((command) => `Bash(git ${command}:*)`),
    'Bash(sudo:*)',
    'EnterWorktree',
    'Edit(.git/**)',
    'Write(.git/**)',
    ...['Read', 'Edit', 'Write'].flatMap((tool) => [`${tool}(**/.env)`, `${tool}(**/.env.*)`]),
  ];
}

// Iterations: every mutating Git command stays the user's; .git and .env files are off limits.
export const DENIED_TOOLS = deniedTools(ALL_GIT_COMMANDS);
// MR preparation: add, commit, rebase and conflict resolution allowed; push and the rest denied.
export const MR_DENIED_TOOLS = deniedTools(ALL_GIT_COMMANDS.filter((command) => !MR_ALLOWED_GIT_COMMANDS.has(command)));

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

// Whether a path is sensitive (SENSITIVE_PATHS plus extra globs) and, when it is, whether the
// Task file declared it with may_touch (paths or globs).
export function sensitivityOf(path: string, mayTouch: readonly string[], extra: readonly string[] = []): Sensitivity {
  if (![...SENSITIVE_PATHS, ...extra].some((glob) => matchesGlob(path, glob))) {
    return 'no';
  }
  return mayTouch.some((glob) => glob === path || matchesGlob(path, glob)) ? 'declared' : 'undeclared';
}
