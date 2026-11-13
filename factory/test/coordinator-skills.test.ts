// The coordinator's skills (src/coordinator-skills.ts): Claude Code's skillOverrides in the
// coordinator workspace's checkout, .claude/settings.local.json, read on every view and changed one
// key at a time; every other key kept; an unreadable file or a symlink refused, never overwritten.
// Everything in temp directories: a temp registry (SF_CONFIG_DIR) naming a temp Git checkout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { coordinatorSkills, coordinatorTestHooks, coordinatorWorkspace, setCoordinatorSkills, switchCoordinatorSkill } from '../src/coordinator-skills.js';
import { saveRegistry } from '../src/registry.js';

const INSTALLED = ['code-review', 'grilling', 'implement', 'tdd'];

// A registry whose workspace "sf" is a fresh Git checkout; env names it the coordinator's.
async function checkout(name: string): Promise<{ root: string; repo: string; env: NodeJS.ProcessEnv; settings: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `sf-coordinator-${name}-`)));
  const repo = join(root, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  const config = join(root, 'config');
  await saveRegistry({ workspaces: { sf: { read_checkout: repo } } }, config);
  return { root, repo, env: { HOME: join(root, 'home'), SF_CONFIG_DIR: config, SF_COORDINATOR_WORKSPACE: 'sf' }, settings: join(repo, '.claude', 'settings.local.json') };
}

const parsed = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

test('the coordinator workspace: SF_COORDINATOR_WORKSPACE, software-factory by default', () => {
  assert.equal(coordinatorWorkspace({}), 'software-factory');
  assert.equal(coordinatorWorkspace({ SF_COORDINATOR_WORKSPACE: '' }), 'software-factory');
  assert.equal(coordinatorWorkspace({ SF_COORDINATOR_WORKSPACE: 'mine' }), 'mine');
});

test('no settings file and no .claude/: every skill on; a switch off creates both (0700, 0600), on again removes the key and the empty skillOverrides', async () => {
  const { repo, env, settings } = await checkout('missing');
  assert.deepEqual(await coordinatorSkills(INSTALLED, env), {
    workspace: 'sf', checkout: repo, settings, skills: { 'code-review': 'on', grilling: 'on', implement: 'on', tdd: 'on' },
  });
  await switchCoordinatorSkill('tdd', false, INSTALLED, env);
  assert.deepEqual([await mode(join(repo, '.claude')), await mode(settings)], [0o700, 0o600]);
  assert.equal(await readFile(settings, 'utf8'), '{\n  "skillOverrides": {\n    "tdd": "off"\n  }\n}\n');
  assert.equal((await coordinatorSkills(INSTALLED, env) as { skills: Record<string, string> }).skills.tdd, 'off');
  await switchCoordinatorSkill('tdd', true, INSTALLED, env);
  assert.equal(await readFile(settings, 'utf8'), '{}\n');
});

test('other keys are kept in value and order; the file\'s mode is kept; overrides of names not installed are kept and not shown', async () => {
  const { env, settings } = await checkout('kept');
  await mkdir(join(settings, '..'));
  const before = {
    permissions: { allow: ['Bash(npm test)'], deny: [] }, env: { A: '1', B: 'two' },
    skillOverrides: { 'plugin:thing': 'off', grilling: 'name-only', legacy: 'user-invocable-only' }, outputStyle: 'terse', number: 1.5,
  };
  await writeFile(settings, JSON.stringify(before), { mode: 0o640 });
  await chmod(settings, 0o640);
  const view = await coordinatorSkills(INSTALLED, env) as { skills: Record<string, string> };
  assert.deepEqual(view.skills, { 'code-review': 'on', grilling: 'name-only', implement: 'on', tdd: 'on' });
  await switchCoordinatorSkill('implement', false, INSTALLED, env);
  const after = await parsed(settings) as typeof before;
  assert.deepEqual(after, { ...before, skillOverrides: { ...before.skillOverrides, implement: 'off' } });
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.deepEqual(Object.keys(after.skillOverrides), ['plugin:thing', 'grilling', 'legacy', 'implement']);
  assert.equal(await mode(settings), 0o640);
  // A click on name-only sets it on: the key goes, the others stay in order.
  await switchCoordinatorSkill('grilling', true, INSTALLED, env);
  assert.deepEqual(Object.entries((await parsed(settings) as typeof before).skillOverrides), [['plugin:thing', 'off'], ['legacy', 'user-invocable-only'], ['implement', 'off']]);
  assert.deepEqual(Object.keys(await parsed(settings) as object), Object.keys(before));
});

test('the list of skills on: only the skills whose state differs change; name-only and user-invocable-only survive when not clicked', async () => {
  const { env, settings } = await checkout('list');
  await mkdir(join(settings, '..'));
  await writeFile(settings, JSON.stringify({ skillOverrides: { grilling: 'name-only', tdd: 'off', 'code-review': 'user-invocable-only' } }));
  // implement off (was on), tdd on (was off), grilling and code-review left as they are.
  await setCoordinatorSkills(['tdd'], INSTALLED, env);
  assert.deepEqual(await parsed(settings), { skillOverrides: { grilling: 'name-only', 'code-review': 'user-invocable-only', implement: 'off' } });
  // An indeterminate skill in the list: set on.
  await setCoordinatorSkills(['tdd', 'grilling'], INSTALLED, env);
  assert.deepEqual(await parsed(settings), { skillOverrides: { 'code-review': 'user-invocable-only', implement: 'off' } });
  // Nothing to change: the file is not written.
  const text = await readFile(settings, 'utf8');
  await writeFile(settings, text.replace('\n', '\n\n'));
  await setCoordinatorSkills(['tdd', 'grilling'], INSTALLED, env);
  assert.equal(await readFile(settings, 'utf8'), text.replace('\n', '\n\n'));
  // A name not installed (or of another form) is refused, the file untouched.
  await assert.rejects(setCoordinatorSkills(['tdd', 'nope'], INSTALLED, env), { code: 'skill_not_installed' });
  await assert.rejects(switchCoordinatorSkill('../x', false, INSTALLED, env), { code: 'skill_not_installed' });
  await assert.rejects(switchCoordinatorSkill('plugin:thing', true, [...INSTALLED, 'plugin:thing'], env), { code: 'skill_not_installed' });
  assert.equal(await readFile(settings, 'utf8'), text.replace('\n', '\n\n'));
});

test('a file that is not JSON, an array, or a skillOverrides that is not an object: refused, the file unchanged', async () => {
  const { env, settings } = await checkout('unreadable');
  await mkdir(join(settings, '..'));
  for (const text of ['{ "permissions": ', '[1, 2]', 'null', '"x"', '{ "skillOverrides": 5 }', '{ "skillOverrides": ["tdd"] }']) {
    await writeFile(settings, text);
    const view = await coordinatorSkills(INSTALLED, env) as { error: { code: string; message: string } };
    assert.equal(view.error.code, 'coordinator_settings_unreadable', text);
    assert.match(view.error.message, /the sf checkout's \.claude\/settings\.local\.json/);
    assert.doesNotMatch(view.error.message, new RegExp(settings));
    await assert.rejects(switchCoordinatorSkill('tdd', false, INSTALLED, env), { code: 'coordinator_settings_unreadable' }, text);
    await assert.rejects(setCoordinatorSkills([], INSTALLED, env), { code: 'coordinator_settings_unreadable' }, text);
    assert.equal(await readFile(settings, 'utf8'), text);
  }
});

test('a file the system will not let it read or write: the column\'s error (no path), never a failed view; the file untouched', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads and writes whatever the modes say');
    return;
  }
  const { repo, env, settings } = await checkout('modes');
  await mkdir(join(repo, '.claude'));
  await writeFile(settings, '{ "skillOverrides": { "tdd": "off" } }');
  await chmod(settings, 0o000);
  try {
    const view = await coordinatorSkills(INSTALLED, env) as { error: { code: string; message: string } };
    assert.deepEqual(view.error, { code: 'coordinator_settings_unreadable', message: 'the sf checkout\'s .claude/settings.local.json could not be read (EACCES).' });
  } finally {
    await chmod(settings, 0o600);
  }
  await chmod(join(repo, '.claude'), 0o500);
  try {
    await assert.rejects(switchCoordinatorSkill('tdd', true, INSTALLED, env), { code: 'coordinator_settings_unwritable', message: 'the sf checkout\'s .claude/settings.local.json could not be written (EACCES).' });
  } finally {
    await chmod(join(repo, '.claude'), 0o700);
  }
  assert.equal(await readFile(settings, 'utf8'), '{ "skillOverrides": { "tdd": "off" } }');
});

test('a .claude swapped for a symlink between the read and the write: the write goes to the folder that was read, never through the link', async () => {
  const { root, repo, env, settings } = await checkout('swap');
  const outside = join(root, 'outside');
  await mkdir(outside);
  await mkdir(join(repo, '.claude'));
  await writeFile(settings, '{ "env": { "A": "1" } }');
  coordinatorTestHooks.beforeWrite = async () => {
    await rename(join(repo, '.claude'), join(repo, '.claude-moved'));
    await symlink(outside, join(repo, '.claude'));
  };
  try {
    await switchCoordinatorSkill('tdd', false, INSTALLED, env);
  } finally {
    delete coordinatorTestHooks.beforeWrite;
  }
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await parsed(join(repo, '.claude-moved', 'settings.local.json')), { env: { A: '1' }, skillOverrides: { tdd: 'off' } });
  // The next change finds the link and refuses.
  await assert.rejects(switchCoordinatorSkill('tdd', true, INSTALLED, env), { code: 'coordinator_settings_unsafe' });
  assert.deepEqual(await readdir(outside), []);
});

test('a large settings file that is valid JSON is read and changed like any other', async () => {
  const { env, settings } = await checkout('large');
  await mkdir(join(settings, '..'));
  const big = { notes: 'x'.repeat(3 * 1024 * 1024), skillOverrides: { grilling: 'off' } };
  await writeFile(settings, JSON.stringify(big));
  assert.equal((await coordinatorSkills(INSTALLED, env) as { skills: Record<string, string> }).skills.grilling, 'off');
  await switchCoordinatorSkill('tdd', false, INSTALLED, env);
  assert.deepEqual(await parsed(settings), { ...big, skillOverrides: { grilling: 'off', tdd: 'off' } });
});

test('a name like __proto__ is no skill name: refused, nothing written; an own key of that name in the file is kept', async () => {
  const { env, settings } = await checkout('proto');
  await mkdir(join(settings, '..'));
  await writeFile(settings, '{ "__proto__": { "x": 1 }, "skillOverrides": { "__proto__": "off" } }');
  await assert.rejects(switchCoordinatorSkill('__proto__', false, [...INSTALLED, '__proto__'], env), { code: 'skill_not_installed' });
  await switchCoordinatorSkill('tdd', false, INSTALLED, env);
  const text = await readFile(settings, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text) as object), ['__proto__', 'skillOverrides']);
  assert.deepEqual(Object.entries((JSON.parse(text) as { skillOverrides: object }).skillOverrides), [['__proto__', 'off'], ['tdd', 'off']]);
});

test('a symlinked settings file or .claude/: refused, nothing written through it', async () => {
  const { root, repo, env, settings } = await checkout('symlink');
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'settings.local.json'), '{}\n');
  await symlink(outside, join(repo, '.claude'));
  assert.equal((await coordinatorSkills(INSTALLED, env) as { error: { code: string } }).error.code, 'coordinator_settings_unsafe');
  await assert.rejects(switchCoordinatorSkill('tdd', false, INSTALLED, env), { code: 'coordinator_settings_unsafe' });
  assert.equal(await readFile(join(outside, 'settings.local.json'), 'utf8'), '{}\n');

  const other = await checkout('symlink-file');
  await mkdir(join(other.repo, '.claude'));
  await symlink(join(outside, 'settings.local.json'), other.settings);
  await assert.rejects(switchCoordinatorSkill('tdd', false, INSTALLED, other.env), { code: 'coordinator_settings_unsafe' });
  assert.equal(await readFile(join(outside, 'settings.local.json'), 'utf8'), '{}\n');
  // A .claude that is a file: refused too.
  const file = await checkout('claude-file');
  await writeFile(join(file.repo, '.claude'), 'x');
  await assert.rejects(switchCoordinatorSkill('tdd', false, INSTALLED, file.env), { code: 'coordinator_settings_unsafe' });
  assert.ok(settings.startsWith(repo));
});

test('an unknown coordinator workspace: no_coordinator_workspace in the view and refused for a change; an invalid one passed through', async () => {
  const { root, env } = await checkout('unknown');
  const none = { ...env, SF_COORDINATOR_WORKSPACE: 'other' };
  assert.deepEqual(await coordinatorSkills(INSTALLED, none), {
    error: { code: 'no_coordinator_workspace', message: 'No coordinator workspace (SF_COORDINATOR_WORKSPACE): "other" is not registered.' },
  });
  await assert.rejects(switchCoordinatorSkill('tdd', false, INSTALLED, none), { code: 'no_coordinator_workspace' });
  await assert.rejects(setCoordinatorSkills([], INSTALLED, none), { code: 'no_coordinator_workspace' });
  const config = join(root, 'config-gone');
  await saveRegistry({ workspaces: { sf: { read_checkout: join(root, 'gone') } } }, config);
  assert.equal((await coordinatorSkills(INSTALLED, { ...env, SF_CONFIG_DIR: config }) as { error: { code: string } }).error.code, 'workspace_invalid');
});
