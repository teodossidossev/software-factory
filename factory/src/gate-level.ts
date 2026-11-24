// The gate level of an iteration: how much of the Codex gate a clean Claude verdict gets,
// by the risk of the job's whole change at that iteration (its meta.json files), or in a delta
// round by the risk of the delta since the clean round (src/review-delta.ts).
// - full: every round of the gate, up to SF_GATE_MAX_ROUNDS. When SF_GATE_LEVEL=full, or
//   a changed path is sensitive, named by the Task's may_touch, security-relevant (SECURITY_WORDS,
//   SF_GATE_FULL_PATHS) or an agents' instructions file (CLAUDE.md, AGENTS.md at any depth), or the
//   change is large, or its files cannot be known.
// - none: every changed path is documentation, and no full rule matches.
// - light: otherwise; one round: the gate runs only while it has asked for no fix in the job.
// This module is pure: the Execution (src/execution/reviews.ts) reads the inputs and records the
// decision in gate-level.json.
import type { FileChange } from './jobs.js';
import { matchesGlob, sensitivityOf } from './rules.js';

export const GATE_LEVELS = ['full', 'light', 'none'] as const;
export type GateLevel = (typeof GATE_LEVELS)[number];

// The words of a path (pathWords) that make a change security-relevant.
export const SECURITY_WORDS: ReadonlySet<string> = new Set([
  'auth', 'oauth', 'token', 'tokens', 'secret', 'secrets', 'credential', 'credentials', 'password', 'passwords', 'crypto', 'cipher',
  'sandbox', 'permission', 'permissions', 'redact', 'session', 'sessions', 'login', 'signing', 'signature', 'jwt', 'cert', 'certs',
]);

// A change larger than either is full: added plus deleted lines, changed files.
export const MAX_LIGHT_LINES = 400;
export const MAX_LIGHT_FILES = 12;

// The agents' instructions, at any depth (SENSITIVE_PATHS names only the root ones).
const AGENT_FILES: readonly string[] = ['CLAUDE.md', 'AGENTS.md'];

// The paths one reason names at most; the rest are counted.
const MAX_NAMED_PATHS = 5;

export const LIGHT_SKIPPED = 'light: the gate already asked for a fix';

// Documentation: a Markdown file at any depth, or any file under the root's docs/.
export function isDocumentation(path: string): boolean {
  return path.endsWith('.md') || path.startsWith('docs/');
}

// The words of a path: split on "/", ".", "-", "_" and camelCase boundaries, lowercased.
export function pathWords(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[/.\-_\s]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

export interface GateLevelInput {
  // The job's change at the iteration (meta.json files); undefined when meta.json has none.
  files: FileChange[] | undefined;
  patchTruncated: boolean;
  // The Task's may_touch; undefined when the Task file could not be read.
  mayTouch: readonly string[] | undefined;
  // SF_GATE_LEVEL.
  setting: 'auto' | 'full';
  // SF_GATE_FULL_PATHS.
  fullPaths: readonly string[];
  // SF_SENSITIVE_PATHS: with SENSITIVE_PATHS, the sensitive rule of a rename's old path, which no
  // FileChange mark covers.
  sensitivePaths: readonly string[];
}

// Whether one of the paths or globs names path (as may_touch and SF_SENSITIVE_PATHS do).
const names = (globs: readonly string[], path: string): boolean => globs.some((glob) => glob === path || matchesGlob(path, glob));

// One reason naming the paths a rule matched.
function named(rule: string, paths: string[]): string {
  const shown = paths.slice(0, MAX_NAMED_PATHS).join(', ');
  return `${rule}: ${shown}${paths.length > MAX_NAMED_PATHS ? ` and ${paths.length - MAX_NAMED_PATHS} more` : ''}`;
}

// The path rules that make a change full, one reason for each rule some of paths match, in this
// order: sensitive (a path's mark in files, or sensitivityOf for a path files does not mark, as a
// rename's old path), may_touch, security (SECURITY_WORDS), SF_GATE_FULL_PATHS and agents (an
// agents' instructions file at any depth). The gate level applies them to its iteration's paths;
// a quick fix (src/quick-fix.ts) to the paths of its change since the hand-over.
export function pathRiskReasons(paths: readonly string[], rules: PathRules): string[] {
  const reasons: string[] = [];
  for (const [rule, matches] of riskChecks(rules)) {
    const matched = paths.filter(matches);
    if (matched.length > 0) {
      reasons.push(named(rule, matched));
    }
  }
  return reasons;
}

// The paths of paths that some rule of pathRiskReasons matches, in their order: a delta round
// reviews their whole section of the change (src/review-delta.ts).
export function fullRulePaths(paths: readonly string[], rules: PathRules): string[] {
  const checks = riskChecks(rules);
  return paths.filter((path) => checks.some(([, matches]) => matches(path)));
}

// What the path rules read: the Task's may_touch, SF_GATE_FULL_PATHS, SF_SENSITIVE_PATHS and the
// iteration's file list with its marks.
export interface PathRules {
  mayTouch: readonly string[];
  fullPaths: readonly string[];
  sensitivePaths: readonly string[];
  files?: readonly FileChange[];
}

function riskChecks(rules: PathRules): Array<[string, (path: string) => boolean]> {
  const files = rules.files ?? [];
  return [
    ['sensitive', (path) => files.some((file) => file.path === path && file.sensitive !== 'no') || sensitivityOf(path, [], rules.sensitivePaths) !== 'no'],
    ['may_touch', (path) => names(rules.mayTouch, path)],
    ['security', (path) => pathWords(path).some((word) => SECURITY_WORDS.has(word))],
    ['SF_GATE_FULL_PATHS', (path) => names(rules.fullPaths, path)],
    ['agents', (path) => AGENT_FILES.includes(path.split('/').at(-1)!)],
  ];
}

// The level of an iteration, with the rules that decided it (at least one).
export function gateLevel(input: GateLevelInput): { level: GateLevel; reasons: string[] } {
  if (input.setting === 'full') {
    return { level: 'full', reasons: ['SF_GATE_LEVEL=full'] };
  }
  const { files } = input;
  if (files === undefined) {
    return { level: 'full', reasons: ['unknown: the iteration has no file list'] };
  }
  const reasons: string[] = [];
  if (input.patchTruncated) {
    reasons.push('unknown: the Patch was truncated');
  }
  if (input.mayTouch === undefined) {
    reasons.push('unknown: the Task file\'s may_touch could not be read');
  }
  // Each changed path, a rename's old path too.
  const paths = [...new Set(files.flatMap((file) => (file.from !== undefined ? [file.path, file.from] : [file.path])))];
  reasons.push(...pathRiskReasons(paths, { mayTouch: input.mayTouch ?? [], fullPaths: input.fullPaths, sensitivePaths: input.sensitivePaths, files }));
  const lines = changedLines(files);
  if (lines > MAX_LIGHT_LINES) {
    reasons.push(`size: ${lines} lines`);
  }
  if (files.length > MAX_LIGHT_FILES) {
    reasons.push(`size: ${files.length} files`);
  }
  if (reasons.length > 0) {
    return { level: 'full', reasons };
  }
  // An empty change is not docs only: light.
  if (paths.length > 0 && paths.every(isDocumentation)) {
    return { level: 'none', reasons: ['docs only'] };
  }
  return { level: 'light', reasons: [`light: ${files.length} ${files.length === 1 ? 'file' : 'files'}, ${lines} ${lines === 1 ? 'line' : 'lines'}`] };
}

// The added plus deleted lines of the change.
export function changedLines(files: FileChange[]): number {
  return files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
}

export interface GateDecision {
  level: GateLevel;
  reasons: string[];
  ran: boolean;
  files: number | null;
  lines: number | null;
}

// The decision of an iteration (gate-level.json without its time): the level, whether the gate runs
// (full always, none never, light while gateFixes, the gate's fixes counted, is 0), and the change's
// counts (null when its files are not known). A delta round's decision is roundGateDecision's
// (src/review-delta.ts), which counts the gate's fixes since the clean round.
export function gateDecision(input: GateLevelInput, gateFixes: number): GateDecision {
  const { level, reasons } = gateLevel(input);
  const skipped = level === 'light' && gateFixes > 0;
  return {
    level,
    reasons: skipped ? [LIGHT_SKIPPED] : reasons,
    ran: level === 'full' || (level === 'light' && !skipped),
    files: input.files === undefined ? null : input.files.length,
    lines: input.files === undefined ? null : changedLines(input.files),
  };
}
