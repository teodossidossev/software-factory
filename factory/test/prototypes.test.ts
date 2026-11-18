// The planners' prototypes folder (src/prototypes.ts): preparePrototypes makes the prototypes folder
// and the workspace's, 0700, never through a link, keeps what is in them, and returns the
// workspace folder's real path; checkPrototypes refuses a link there without writing anything.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { checkPrototypes, preparePrototypes, PROTOTYPES_DIR, prototypesRoot } from '../src/prototypes.js';

// A real folder of this test's own.
const folder = async (name: string): Promise<string> => realpath(await mkdtemp(join(tmpdir(), `sf-prototypes-${name}-`)));

// preparePrototypes(planningDir, 'app') refused with planning_copy_unsafe and the message for shown.
async function refused(planningDir: string, shown: string): Promise<void> {
  await assert.rejects(preparePrototypes(planningDir, 'app'), (error: unknown) => {
    assert.ok(error instanceof FactoryError, String(error));
    assert.equal(error.code, 'planning_copy_unsafe');
    assert.equal(error.message, `${shown} in the planning folder is a link or not a folder: remove it and run sf planner setup again.`);
    assert.equal(error.message.includes(planningDir), false, error.message);
    assert.equal(error.message.includes(tmpdir()), false, error.message);
    return true;
  });
}

test('preparePrototypes makes both folders 0700 and keeps what a later call finds there', async () => {
  const planning = await folder('made');
  assert.equal(PROTOTYPES_DIR, 'prototypes');
  assert.equal(prototypesRoot(planning), join(planning, 'prototypes'));
  const made = await preparePrototypes(planning, 'app');
  assert.equal(made, join(planning, 'prototypes', 'app'));
  for (const path of [join(planning, 'prototypes'), join(planning, 'prototypes', 'app')]) {
    const info = await stat(path);
    assert.equal(info.isDirectory(), true, path);
    assert.equal(info.mode & 0o777, 0o700, path);
  }

  // A second call: the same path, a ticket's file kept.
  await mkdir(join(made, 'APP-12'));
  await writeFile(join(made, 'APP-12', 'layout.html'), '<p>mine</p>\n');
  assert.equal(await preparePrototypes(planning, 'app'), made);
  assert.equal(await readFile(join(made, 'APP-12', 'layout.html'), 'utf8'), '<p>mine</p>\n');
  assert.deepEqual(await readdir(join(planning, 'prototypes')), ['app']);
});

test('preparePrototypes returns the real path through a planning folder that is a link', async () => {
  const real = await folder('real');
  const links = await folder('links');
  const planning = join(links, 'planning');
  await symlink(real, planning);
  assert.equal(await preparePrototypes(planning, 'app'), join(real, 'prototypes', 'app'));
  assert.equal((await stat(join(real, 'prototypes', 'app'))).mode & 0o777, 0o700);
});

test('a link or a file in the place of either folder is refused, the link never followed', async () => {
  // A link at prototypes: its target untouched.
  const target = await folder('target');
  const atRoot = await folder('link-root');
  await symlink(target, join(atRoot, 'prototypes'));
  await refused(atRoot, 'prototypes');
  assert.deepEqual(await readdir(target), []);

  // A link at prototypes/app: its target untouched.
  const atWorkspace = await folder('link-workspace');
  await mkdir(join(atWorkspace, 'prototypes'), { mode: 0o700 });
  await symlink(target, join(atWorkspace, 'prototypes', 'app'));
  await refused(atWorkspace, 'prototypes/app');
  assert.deepEqual(await readdir(target), []);

  // A file at prototypes/app, kept; a file at prototypes.
  const file = await folder('file');
  await mkdir(join(file, 'prototypes'), { mode: 0o700 });
  await writeFile(join(file, 'prototypes', 'app'), 'mine\n');
  await refused(file, 'prototypes/app');
  assert.equal(await readFile(join(file, 'prototypes', 'app'), 'utf8'), 'mine\n');
  const rootFile = await folder('root-file');
  await writeFile(join(rootFile, 'prototypes'), 'mine\n');
  await refused(rootFile, 'prototypes');
});

test('checkPrototypes refuses what preparePrototypes refuses, names the missing folders and writes nothing', async () => {
  const planning = await folder('check');
  assert.deepEqual(await checkPrototypes(planning, 'app'), [join(planning, 'prototypes'), join(planning, 'prototypes', 'app')]);
  assert.deepEqual(await readdir(planning), []);
  await mkdir(join(planning, 'prototypes'), { mode: 0o700 });
  assert.deepEqual(await checkPrototypes(planning, 'app'), [join(planning, 'prototypes', 'app')]);
  await mkdir(join(planning, 'prototypes', 'app'), { mode: 0o700 });
  assert.deepEqual(await checkPrototypes(planning, 'app'), []);

  // A link at prototypes/app, then at prototypes: refused, the target untouched.
  const target = await folder('check-target');
  await rm(join(planning, 'prototypes', 'app'), { recursive: true });
  await symlink(target, join(planning, 'prototypes', 'app'));
  await assert.rejects(checkPrototypes(planning, 'app'), (error: unknown) => error instanceof FactoryError && error.code === 'planning_copy_unsafe'
    && error.message === 'prototypes/app in the planning folder is a link or not a folder: remove it and run sf planner setup again.');
  await rm(join(planning, 'prototypes'), { recursive: true });
  await symlink(target, join(planning, 'prototypes'));
  await assert.rejects(checkPrototypes(planning, 'app'), (error: unknown) => error instanceof FactoryError && error.code === 'planning_copy_unsafe'
    && error.message === 'prototypes in the planning folder is a link or not a folder: remove it and run sf planner setup again.');
  assert.deepEqual(await readdir(target), []);
});

test('a path that cannot be checked is refused at once with its own code, its relative path named, nothing made', async () => {
  // check and prepare, each refused with prototypes_folder_unchecked and the message for shown.
  const refusedBoth = async (planningDir: string, shown: string): Promise<void> => {
    for (const call of [checkPrototypes, preparePrototypes]) {
      await assert.rejects(call(planningDir, 'app'), (error: unknown) => {
        assert.ok(error instanceof FactoryError, String(error));
        assert.equal(error.code, 'prototypes_folder_unchecked');
        assert.equal(error.message, `${shown} in the planning folder cannot be checked (EACCES): fix its permissions and run sf planner setup again.`);
        assert.equal(error.message.includes(tmpdir()), false, error.message);
        return true;
      });
    }
  };

  // prototypes without read or execute permission: prototypes/app cannot be checked.
  const planning = await folder('unchecked');
  await mkdir(join(planning, 'prototypes'), { mode: 0o700 });
  await chmod(join(planning, 'prototypes'), 0o000);
  try {
    await refusedBoth(planning, 'prototypes/app');
  } finally {
    await chmod(join(planning, 'prototypes'), 0o700);
  }
  assert.deepEqual(await readdir(join(planning, 'prototypes')), []);

  // The planning folder itself without them: prototypes cannot be checked.
  const closed = await folder('unchecked-root');
  await chmod(closed, 0o000);
  try {
    await refusedBoth(closed, 'prototypes');
  } finally {
    await chmod(closed, 0o700);
  }
  assert.deepEqual(await readdir(closed), []);
});
