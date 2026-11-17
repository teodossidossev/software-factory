// The skills of each agent role: the user's choice, one shared by all workspaces, in
// <state dir>/skill-roles.json ({ "version": 1, "roles": { <role>: [<skill name>, ...] } }), written
// atomically with mode 0600. A role missing from the file (or the whole file missing) has its
// default (DEFAULT_ROLES); a role with [] has none. A name the file holds that is not installed stays
// there; the sync reports it missing. Only names of SKILL_NAME's form are read: a skill's name is
// a folder name of the snapshot, never a path.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';

// The roles: the Implementer, the Claude review, the Codex gate, the Task check, and the planner
// (ChatGPT or Claude Code: the planning method of the MCP server's instructions, and the skills sf
// planner setup puts into a planning copy).
export const ROLES = ['implementer', 'claude_review', 'codex_gate', 'task_check', 'planner'] as const;
export type Role = (typeof ROLES)[number];
export type RoleSkills = Record<Role, string[]>;

// Each role's set without a choice: the Implementer has implement, tdd, code-review and grilling,
// both reviewers follow code-review, the Task check has none, the planner grills.
export const DEFAULT_ROLES: Readonly<Record<Role, readonly string[]>> = {
  implementer: ['implement', 'tdd', 'code-review', 'grilling'], claude_review: ['code-review'], codex_gate: ['code-review'], task_check: [], planner: ['grilling'],
};

// An installed skill's folder name, as the skills tool writes it.
export const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export const rolesFile = (stateDir: string): string => join(stateDir, 'skill-roles.json');

// Whether a word names a role.
export const isRole = (role: string): role is Role => (ROLES as readonly string[]).includes(role);

// A role's list as the file gives it: the names of SKILL_NAME's form, once each, in order;
// undefined when the entry is not a list (the role then has its default).
function listOf(value: unknown): string[] | undefined {
  return Array.isArray(value) ? [...new Set(value.filter((name): name is string => typeof name === 'string' && SKILL_NAME.test(name)))] : undefined;
}

// The roles' lists from a parsed file (anything): each role's own list, else its default.
export function rolesOf(data: unknown): RoleSkills {
  const roles = (typeof data === 'object' && data !== null ? (data as { roles?: unknown }).roles : undefined) as Record<string, unknown> | undefined;
  const own = (role: Role): unknown => (typeof roles === 'object' && roles !== null && Object.hasOwn(roles, role) ? roles[role] : undefined);
  return Object.fromEntries(ROLES.map((role) => [role, listOf(own(role)) ?? [...DEFAULT_ROLES[role]]])) as RoleSkills;
}

// The choice now: the file's, every role's default when it is missing; a file that is not JSON
// counts as missing, with one warning line.
export async function readRoles(stateDir: string): Promise<RoleSkills> {
  let text: string;
  try {
    text = await readFile(rolesFile(stateDir), 'utf8');
  } catch { // no file (or one that cannot be read): every role has its default
    return rolesOf(undefined);
  }
  try {
    return rolesOf(JSON.parse(text));
  } catch { // not JSON: the defaults, said once per read
    console.error(`warning: ${rolesFile(stateDir)} is not JSON; every role has its default skills`);
    return rolesOf(undefined);
  }
}

// Every skill some role chose, once each, in the roles' order.
export const chosenSkills = (roles: RoleSkills): string[] => [...new Set(ROLES.flatMap((role) => roles[role]))];

// The roles with one role's list replaced, checked first: an unknown role, or a name of asked (the
// list's by default) that is not installed (but one the role already has, which may stay or go), is
// refused with the list.
export function withRole(roles: RoleSkills, role: string, skills: readonly string[], installed: readonly string[], asked: readonly string[] = skills): RoleSkills {
  if (!isRole(role)) {
    throw new FactoryError('unknown_role', `There is no role "${role}"; the roles are ${ROLES.join(', ')}.`);
  }
  const unknown = asked.filter((name) => !installed.includes(name) && !roles[role].includes(name));
  if (unknown.length > 0) {
    throw new FactoryError('skill_not_installed', `Not an installed skill: ${unknown.join(', ')}; installed: ${installed.length > 0 ? installed.join(', ') : 'none'} (npx skills add installs one).`);
  }
  return { ...roles, [role]: [...new Set(skills)] };
}

// Writes the choice: every role's list, atomically, mode 0600.
export async function writeRoles(stateDir: string, roles: RoleSkills): Promise<void> {
  await writeFileAtomic(rolesFile(stateDir), Buffer.from(`${JSON.stringify({ version: 1, roles }, null, 2)}\n`));
}
