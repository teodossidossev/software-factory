// The agent roles' skills (src/skill-roles.ts): the file's read with each role's default, its
// atomic write with mode 0600, and the check of a change.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { chosenSkills, DEFAULT_ROLES, readRoles, ROLES, rolesFile, rolesOf, withRole, writeRoles } from '../src/skill-roles.js';

const state = (name: string): Promise<string> => mkdtemp(join(tmpdir(), `sf-skill-roles-${name}-`));

test('no skill-roles.json: every role has today\'s set', async () => {
  assert.deepEqual(ROLES, ['implementer', 'claude_review', 'codex_gate', 'task_check', 'planner']);
  const roles = await readRoles(await state('none'));
  assert.deepEqual(roles, { implementer: ['implement', 'tdd', 'code-review', 'grilling'], claude_review: ['code-review'], codex_gate: ['code-review'], task_check: [], planner: ['grilling'] });
  assert.deepEqual(roles, { ...DEFAULT_ROLES });
  assert.deepEqual(chosenSkills(roles), ['implement', 'tdd', 'code-review', 'grilling']);
});

test('the file: a role\'s own list, [] for none, its default when missing or not a list; only names of a skill folder\'s form, once each', async () => {
  const dir = await state('file');
  await writeFile(rolesFile(dir), JSON.stringify({
    version: 1, roles: { implementer: ['tdd', 'tdd', '../x', 'a/b', '..', 'Up', 7, 'gone'], codex_gate: [], task_check: 'grilling', unknown: ['tdd'] },
  }));
  assert.deepEqual(await readRoles(dir), { implementer: ['tdd', 'gone'], claude_review: ['code-review'], codex_gate: [], task_check: [], planner: ['grilling'] });
  assert.deepEqual(rolesOf({ roles: null }), rolesOf(undefined));
});

test('a file that is not JSON: every role\'s default, said in one warning line', async () => {
  const dir = await state('bad');
  await writeFile(rolesFile(dir), '{ not json');
  const lines: string[] = [];
  const errorMock = mock.method(console, 'error', (line: unknown) => void lines.push(String(line)));
  try {
    assert.deepEqual(await readRoles(dir), rolesOf(undefined));
  } finally {
    errorMock.mock.restore();
  }
  assert.deepEqual(lines, [`warning: ${rolesFile(dir)} is not JSON; every role has its default skills`]);
});

test('writeRoles: version 1 and every role\'s list, mode 0600, no temp file left; read back as written', async () => {
  const dir = await state('write');
  const roles = { ...rolesOf(undefined), implementer: ['tdd'], planner: [] };
  await writeRoles(dir, roles);
  assert.deepEqual(JSON.parse(await readFile(rolesFile(dir), 'utf8')), { version: 1, roles });
  assert.equal((await stat(rolesFile(dir))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['skill-roles.json']);
  assert.deepEqual(await readRoles(dir), roles);
});

test('withRole: a role\'s list replaced; an unknown role or a skill not installed refused with the list; a name the role has may stay', () => {
  const roles = { ...rolesOf(undefined), planner: ['grilling', 'gone'] };
  const installed = ['code-review', 'grilling', 'implement', 'tdd'];
  assert.deepEqual(withRole(roles, 'codex_gate', ['code-review', 'grilling', 'grilling'], installed).codex_gate, ['code-review', 'grilling']);
  assert.deepEqual(withRole(roles, 'planner', ['gone'], installed).planner, ['gone']);
  assert.throws(() => withRole(roles, 'reviewer', [], installed), { code: 'unknown_role', message: 'There is no role "reviewer"; the roles are implementer, claude_review, codex_gate, task_check, planner.' });
  assert.throws(() => withRole(roles, 'implementer', ['tdd', 'nope'], installed), {
    code: 'skill_not_installed', message: 'Not an installed skill: nope; installed: code-review, grilling, implement, tdd (npx skills add installs one).',
  });
  assert.throws(() => withRole(roles, 'task_check', [], [], ['tdd']), { code: 'skill_not_installed', message: /installed: none/ });
  // The role's list is left as it was.
  assert.deepEqual(roles.implementer, ['implement', 'tdd', 'code-review', 'grilling']);
});
