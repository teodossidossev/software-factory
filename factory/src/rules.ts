// The verifiable part of the Git rules and the tool deny lists the factory hands to the
// Implementer session per turn. The Handbook (## Git rules, ## MR template) is the prose source.

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
