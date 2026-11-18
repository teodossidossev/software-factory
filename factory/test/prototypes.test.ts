// The planners' prototypes folder (src/prototypes.ts): preparePrototypes makes the prototypes folder
// and the workspace's, 0700, never through a link, keeps what is in them, and returns the
// workspace folder's real path; checkPrototypes refuses a link there without writing anything. The
// dashboard's helpers: prototypePage's text, readPrototype and listPrototypes, which follow no link
// and wait on no pipe.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import {
  checkPrototypes,
  listPrototypes,
  MAX_PROTOTYPE_BYTES,
  MAX_PROTOTYPES,
  preparePrototypes,
  PROTOTYPES_DIR,
  prototypePage,
  prototypesRoot,
  readPrototype,
} from '../src/prototypes.js';

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

// A prototypes root with the folder of app/APP-12 made, and that folder.
async function ticketRoot(name: string): Promise<{ root: string; dir: string }> {
  const root = join(await folder(name), 'prototypes');
  const dir = join(root, 'app', 'APP-12');
  await mkdir(dir, { recursive: true });
  return { root, dir };
}

test('prototypePage is the page that holds the file in a sandboxed frame at its root address', () => {
  assert.equal(
    prototypePage('app', 'APP-12', 'x.html'),
    [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>x.html · APP-12</title>',
      '<style>html,body{margin:0;height:100%;background:#fff}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style>',
      '</head>',
      '<body><iframe src="/prototype-frames/app/APP-12/x.html" sandbox="allow-scripts" referrerpolicy="no-referrer" title="x.html"></iframe></body>',
      '</html>',
      '',
    ].join('\n'),
  );
  assert.ok(prototypePage('app', 'APP-12', 'export-states.html').includes('<title>export-states.html · APP-12</title>'));
});

test('readPrototype reads a regular file and nothing through a link, a pipe, a folder or past the bound', async () => {
  const { root, dir } = await ticketRoot('read');
  await writeFile(join(dir, 'x.html'), '<p>x</p>');
  assert.deepEqual(await readPrototype(root, 'app', 'APP-12', 'x.html'), Buffer.from('<p>x</p>'));

  // Names that fail their patterns.
  for (const [workspace, ticket, name] of [['App', 'APP-12', 'x.html'], ['..', 'APP-12', 'x.html'], ['app', '..', 'x.html'], ['app', 'APP-12', 'X.html'], ['app', 'APP-12', 'x.htm'], ['app', 'APP-12', '../x.html']] as const) {
    assert.equal(await readPrototype(root, workspace, ticket, name), undefined, `${workspace}/${ticket}/${name}`);
  }
  // A missing file, ticket and workspace.
  assert.equal(await readPrototype(root, 'app', 'APP-12', 'y.html'), undefined);
  assert.equal(await readPrototype(root, 'app', 'APP-13', 'x.html'), undefined);
  assert.equal(await readPrototype(root, 'web', 'APP-12', 'x.html'), undefined);

  // A link at the workspace's folder, at the ticket's folder and at the file.
  await symlink(join(root, 'app'), join(root, 'linked'));
  assert.equal(await readPrototype(root, 'linked', 'APP-12', 'x.html'), undefined);
  await symlink(dir, join(root, 'app', 'APP-13'));
  assert.equal(await readPrototype(root, 'app', 'APP-13', 'x.html'), undefined);
  await symlink(join(dir, 'x.html'), join(dir, 'y.html'));
  assert.equal(await readPrototype(root, 'app', 'APP-12', 'y.html'), undefined);

  // A folder named like a prototype, and a pipe (not waited on).
  await mkdir(join(dir, 'folder.html'));
  assert.equal(await readPrototype(root, 'app', 'APP-12', 'folder.html'), undefined);
  execFileSync('mkfifo', [join(dir, 'pipe.html')]);
  assert.equal(await readPrototype(root, 'app', 'APP-12', 'pipe.html'), undefined);

  // At the bound, and one byte over it.
  await writeFile(join(dir, 'full.html'), Buffer.alloc(MAX_PROTOTYPE_BYTES, 'a'));
  assert.equal((await readPrototype(root, 'app', 'APP-12', 'full.html'))?.length, MAX_PROTOTYPE_BYTES);
  await writeFile(join(dir, 'big.html'), Buffer.alloc(MAX_PROTOTYPE_BYTES + 1, 'a'));
  assert.equal(await readPrototype(root, 'app', 'APP-12', 'big.html'), undefined);
});

test('listPrototypes lists the regular prototypes newest first, ties by name, at most 50', async () => {
  const { root, dir } = await ticketRoot('list');
  const at = (seconds: number): Date => new Date(Date.UTC(2026, 10, 18, 12, 0, seconds));
  for (const [name, seconds] of [['b.html', 10], ['a.html', 10], ['old.html', 1], ['new.html', 30]] as const) {
    await writeFile(join(dir, name), name);
    await utimes(join(dir, name), at(seconds), at(seconds));
  }
  // Left out: a link, a folder, a pipe, a file over the bound, names that fail PROTOTYPE_FILE.
  await symlink(join(dir, 'a.html'), join(dir, 'link.html'));
  await mkdir(join(dir, 'folder.html'));
  execFileSync('mkfifo', [join(dir, 'pipe.html')]);
  await writeFile(join(dir, 'big.html'), Buffer.alloc(MAX_PROTOTYPE_BYTES + 1, 'a'));
  for (const name of ['X.html', 'x.htm', `${'a'.repeat(60)}.html`, '-x.html']) {
    await writeFile(join(dir, name), name);
  }
  assert.equal(`${'a'.repeat(60)}.html`.length, 65);
  assert.deepEqual(await listPrototypes(root, 'app', 'APP-12'), [
    { name: 'new.html', modified: at(30).toISOString() },
    { name: 'a.html', modified: at(10).toISOString() },
    { name: 'b.html', modified: at(10).toISOString() },
    { name: 'old.html', modified: at(1).toISOString() },
  ]);

  // 51 files: the newest 50.
  const many = await ticketRoot('many');
  for (let index = 0; index <= MAX_PROTOTYPES; index += 1) {
    const name = `p${String(index).padStart(2, '0')}.html`;
    await writeFile(join(many.dir, name), name);
    await utimes(join(many.dir, name), at(index), at(index));
  }
  const listed = await listPrototypes(many.root, 'app', 'APP-12');
  assert.equal(listed.length, MAX_PROTOTYPES);
  assert.equal(listed[0]!.name, 'p50.html');
  assert.equal(listed.at(-1)!.name, 'p01.html');
});

test('listPrototypes gives [] for a missing, linked or unreadable folder and for bad names', async () => {
  const { root, dir } = await ticketRoot('empty');
  await writeFile(join(dir, 'x.html'), 'x');
  assert.equal((await listPrototypes(root, 'app', 'APP-12')).length, 1);
  assert.deepEqual(await listPrototypes(root, 'app', 'APP-13'), []);
  assert.deepEqual(await listPrototypes(join(root, 'none'), 'app', 'APP-12'), []);
  await symlink(dir, join(root, 'app', 'APP-14'));
  assert.deepEqual(await listPrototypes(root, 'app', 'APP-14'), []);
  await symlink(join(root, 'app'), join(root, 'linked'));
  assert.deepEqual(await listPrototypes(root, 'linked', 'APP-12'), []);
  for (const [workspace, ticket] of [['App', 'APP-12'], ['..', 'APP-12'], ['app', '..']] as const) {
    assert.deepEqual(await listPrototypes(root, workspace, ticket), [], `${workspace}/${ticket}`);
  }
  await chmod(dir, 0o000);
  try {
    assert.deepEqual(await listPrototypes(root, 'app', 'APP-12'), []);
  } finally {
    await chmod(dir, 0o700);
  }
});
