// The Task check's path guard (src/task-check.ts): the read rules on top of it, the PreToolUse hook
// that refuses every Read, Grep or Glob reaching outside the check's worktree or into a
// .software-factory folder there and every other tool but the SDK's StructuredOutput, and the cut of
// the symbolic links out of the worktree. src/task-check.ts re-exports all of it.
import { readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { inTmpRoot, TMP_REFUSAL } from './host-tmp.js';
import { absoluteRule } from './sandbox-denials.js';
import { TASK_DIR } from './task-file.js';

// Read rules on top of the guard (defence in depth): the work checkout's .software-factory folder
// (the other Task files, the MR texts, the archive), the factory's state (jobs, ledgers, requests,
// checks) and its config.
export function checkDeniedRules(checkout: string, stateDir: string, configDir: string): string[] {
  return [join(checkout, TASK_DIR), stateDir, configDir].map((dir) => `Read(${absoluteRule(dir)}/**)`);
}

// Glob characters: a pattern segment with one of them is not a fixed directory.
const GLOB_CHARS = /[*?[\]{}]/;

// The path with its deepest existing ancestor's symlinks resolved, so a link inside the root that
// points outside it is seen where it leads.
async function realTarget(path: string): Promise<string> {
  const rest: string[] = [];
  let existing = path;
  for (;;) {
    try {
      return join(await realpath(existing), ...rest);
    } catch { // this ancestor does not resolve: its parent is tried
      const parent = dirname(existing);
      if (parent === existing) {
        return path;
      }
      rest.unshift(relative(parent, existing));
      existing = parent;
    }
  }
}

// The keys of a tool input that name a path; Claude Code reads any of them (Grep takes file_path
// for path, for one), so each one present is a target.
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];

// A path value the guard cannot resolve as Claude Code will: one it trims or expands (~, ~/...,
// ~user); such a call is refused rather than guessed.
const unresolvable = (value: string): boolean => value !== value.trim() || value.startsWith('~');

// The most alternatives a pattern's braces may expand to, the most brace groups it may have and
// the longest path or pattern value; more refuse the call (before any expansion).
const MAX_ALTERNATIVES = 64;
const MAX_BRACE_GROUPS = 16;
const MAX_VALUE_CHARS = 4096;

// A glob pattern's brace alternatives, nested ones included ("src/{a,{b,c}}" -> src/a, src/b,
// src/c), each to be checked on its own. undefined: braces that do not pair, a backslash (an
// escape the guard does not interpret), an extglob or "|" (alternatives it does not expand) or
// more than MAX_ALTERNATIVES.
export function braceAlternatives(pattern: string): string[] | undefined {
  if (pattern.length > MAX_VALUE_CHARS || pattern.split('{').length - 1 > MAX_BRACE_GROUPS || pattern.includes('\\') || pattern.includes('|') || /[@!+*?]\(/.test(pattern)) {
    return undefined;
  }
  const open = pattern.indexOf('{');
  if (open < 0) {
    return pattern.includes('}') ? undefined : [pattern];
  }
  if (pattern.slice(0, open).includes('}')) {
    return undefined;
  }
  let depth = 0;
  let start = open + 1;
  const parts: string[] = [];
  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}' && (depth -= 1) === 0) {
      parts.push(pattern.slice(start, index));
      const result: string[] = [];
      for (const part of parts) {
        const expanded = braceAlternatives(`${pattern.slice(0, open)}${part}${pattern.slice(index + 1)}`);
        if (expanded === undefined || result.push(...expanded) > MAX_ALTERNATIVES) {
          return undefined;
        }
      }
      return result;
    } else if (char === ',' && depth === 1) {
      parts.push(pattern.slice(start, index));
      start = index + 1;
    }
  }
  return undefined;
}

// The paths a tool call reads, relative to the root or absolute: every path key present (the root
// when Grep or Glob has none) and, for each brace alternative of Glob's pattern, its part up to
// the first glob segment. undefined: a tool the check may not use, a Read without a path, a value
// it trims or expands, a pattern it cannot expand, an alternative that climbs with "..", or an
// absolute alternative of Grep's glob filter.
function toolTargets(tool: string, input: Record<string, unknown>): string[] | undefined {
  if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Glob') {
    return undefined;
  }
  const values = (keys: string[]): Array<string | undefined> => keys.filter((key) => input[key] !== undefined).map((key) => (typeof input[key] === 'string' ? input[key] as string : undefined));
  const paths = values(PATH_KEYS);
  const patterns = values(tool === 'Glob' ? ['pattern'] : tool === 'Grep' ? ['glob'] : []);
  if ([...paths, ...patterns].some((value) => value === undefined || value.length > MAX_VALUE_CHARS || unresolvable(value))) {
    return undefined;
  }
  const given = (paths as string[]).filter((path) => path !== '');
  if (tool === 'Read' && given.length === 0) {
    return undefined;
  }
  const bases = given.length > 0 ? given : ['.'];
  const targets = [...bases];
  for (const pattern of patterns as string[]) {
    const alternatives = braceAlternatives(pattern);
    if (alternatives === undefined) {
      return undefined;
    }
    for (const alternative of alternatives) {
      const segments = alternative.split('/');
      if (unresolvable(alternative) || segments.includes('..') || (tool === 'Grep' && isAbsolute(alternative))) {
        return undefined;
      }
      if (tool === 'Glob') {
        const first = segments.findIndex((segment) => GLOB_CHARS.test(segment));
        const fixed = (first < 0 ? segments : segments.slice(0, first)).join('/');
        targets.push(...(isAbsolute(alternative) ? [fixed || '/'] : bases.map((base) => join(base, fixed))));
      }
    }
  }
  return targets;
}

// The SDK's tool through which the session gives its structured output (outputFormat): it carries
// the answer, not a file access, so the guard lets it through unchecked, by this exact name only.
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

// Why a tool call of the check is refused, or undefined when it is the session's answer
// (STRUCTURED_OUTPUT_TOOL) or every path it reads is inside root (symlinks resolved) and outside a
// .software-factory folder there. root is the check's worktree, a real path; temporary: the host's
// temporary roots (tmpRoots), whose refusal says so (TMP_REFUSAL). Never throws: a call the guard
// fails to check is refused (Claude Code would take a hook that throws as no decision and let the
// call through).
export async function guardReason(root: string, tool: string, input: unknown, temporary: readonly string[] = []): Promise<string | undefined> {
  if (tool === STRUCTURED_OUTPUT_TOOL) {
    return undefined;
  }
  try {
    return await checkedReason(root, tool, input, temporary);
  } catch { // never throws: a call it fails to check is refused
    return `The Task check could not check this ${tool} call; it is refused.`;
  }
}

async function checkedReason(root: string, tool: string, input: unknown, temporary: readonly string[]): Promise<string | undefined> {
  const targets = typeof input === 'object' && input !== null ? toolTargets(tool, input as Record<string, unknown>) : undefined;
  if (targets === undefined) {
    return `The Task check reads the repository with Read, Grep and Glob only, inside ${root}, by plain paths (no ~, no surrounding spaces); this ${tool} call is refused.`;
  }
  for (const target of targets) {
    const real = await realTarget(resolve(root, target));
    const inside = relative(root, real);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || inside.split(sep)[0] === TASK_DIR) {
      return `The Task check may read only the repository checkout ${root}; ${target} ${inTmpRoot(real, temporary) ? `is in a temporary root: ${TMP_REFUSAL}` : 'is outside it'}.`;
    }
  }
  return undefined;
}

// The check's PreToolUse hook: guardReason (with the temporary roots) first; a refusal is a deny.
export function guardHooks(root: string, temporary: readonly string[] = []): { PreToolUse: Array<{ hooks: HookCallback[] }> } {
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {};
    }
    const reason = await guardReason(root, input.tool_name, input.tool_input, temporary).catch(() => 'The Task check could not check this call; it is refused.');
    return reason === undefined ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  };
  return { PreToolUse: [{ hooks: [guard] }] };
}

// What a symbolic link out of the check's worktree becomes there.
export const OUTSIDE_LINK_NOTE = 'A symbolic link out of the repository checkout; the Task check does not follow it.\n';

// Replaces every symbolic link under root (.git left alone) whose target is outside root, or does
// not resolve, with a regular file holding OUTSIDE_LINK_NOTE: a search from the root that follows
// links then stays inside the worktree. Links that stay inside are kept. Returns the paths replaced.
export async function cutOutsideLinks(root: string): Promise<string[]> {
  const cut: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== '.git') {
        await walk(path);
      } else if (entry.isSymbolicLink()) {
        const target = await realpath(path).catch(() => undefined);
        const inside = target === undefined ? '..' : relative(root, target);
        if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || inside.split(sep)[0] === TASK_DIR) {
          await unlink(path);
          await writeFile(path, OUTSIDE_LINK_NOTE, { flag: 'wx' });
          cut.push(relative(root, path));
        }
      }
    }
  };
  await walk(root);
  return cut;
}
