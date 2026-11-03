// Unit tests for the workspace registry: strict parsing, persistence and checkout verification.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { configDir, loadRegistry, parseRegistry, resolveWorkspace, saveRegistry } from '../src/registry.js';

let temp: string;
let repo: string;

before(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'sf-registry-')));
  repo = join(temp, 'repo');
  await mkdir(join(repo, 'sub'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['init', '-q', '--bare', join(temp, 'bare.git')]);
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

const entry = { read_checkout: '/srv/app', work_checkout: '/srv/app-work' };

function invalid(text: string): void {
  assert.throws(() => parseRegistry(text), (error: unknown) => error instanceof FactoryError && error.code === 'registry_invalid', text);
}

test('parseRegistry accepts valid names and absolute paths', () => {
  const names = ['a', '7', 'software-factory', 'a1', `a${'b'.repeat(62)}c`];
  const registry = parseRegistry(JSON.stringify({ workspaces: Object.fromEntries(names.map((name) => [name, entry])) }));
  assert.deepEqual(Object.keys(registry.workspaces).sort(), [...names].sort());
  assert.deepEqual(parseRegistry('{"workspaces":{}}'), { workspaces: {} });
});

test('parseRegistry refuses invalid files instead of ignoring them', () => {
  for (const name of ['', '-a', 'a-', 'A', 'a_b', 'a.b', `a${'b'.repeat(63)}c`]) {
    invalid(JSON.stringify({ workspaces: { [name]: entry } }));
  }
  invalid('not json');
  invalid('[]');
  invalid('{}');
  invalid('{"workspaces":[]}');
  invalid(JSON.stringify({ workspaces: {}, extra: true }));
  invalid(JSON.stringify({ workspaces: { app: { ...entry, extra: 1 } } }));
  // work_checkout is optional since SF-019 (read and ignored).
  assert.deepEqual(parseRegistry(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app' } } })).workspaces.app, { read_checkout: '/srv/app' });
  invalid(JSON.stringify({ workspaces: { app: { ...entry, read_checkout: 'relative/path' } } }));
  invalid(JSON.stringify({ workspaces: { app: { ...entry, work_checkout: '' } } }));
  invalid(JSON.stringify({ workspaces: { app: { ...entry, work_checkout: 42 } } }));
});

test('configDir honours SF_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config', () => {
  assert.equal(configDir({ SF_CONFIG_DIR: '/c', XDG_CONFIG_HOME: '/x' }), '/c');
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x' }), '/x/software-factory');
  assert.match(configDir({}), /\/\.config\/software-factory$/);
});

test('loadRegistry treats a missing file as empty and round-trips saved registries', async () => {
  const dir = join(temp, 'config');
  assert.deepEqual(await loadRegistry(dir), { workspaces: {} });
  await saveRegistry({ workspaces: { app: entry } }, dir);
  assert.deepEqual(await loadRegistry(dir), { workspaces: { app: entry } });
  assert.equal((await stat(join(dir, 'workspaces.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await writeFile(join(dir, 'workspaces.json'), '{"workspaces":{"Bad":{}}}');
  await assert.rejects(loadRegistry(dir), { code: 'registry_invalid' });
});

test('resolveWorkspace verifies that the checkout is a Git work tree root; work_checkout is ignored', async () => {
  const dir = join(temp, 'resolve');
  const outside = join(temp, 'plain');
  await mkdir(outside);
  await saveRegistry(
    {
      workspaces: {
        good: { read_checkout: repo, work_checkout: repo },
        sub: { read_checkout: join(repo, 'sub'), work_checkout: repo },
        plain: { read_checkout: repo, work_checkout: outside },
        bare: { read_checkout: join(temp, 'bare.git'), work_checkout: repo },
        gone: { read_checkout: join(temp, 'missing'), work_checkout: repo },
      },
    },
    dir,
  );
  assert.deepEqual(await resolveWorkspace('good', dir), { name: 'good', readCheckout: repo, workCheckout: repo });
  // The ignored work_checkout may point anywhere: the checkout is what counts.
  assert.deepEqual(await resolveWorkspace('plain', dir), { name: 'plain', readCheckout: repo, workCheckout: repo });
  for (const name of ['sub', 'bare', 'gone']) {
    await assert.rejects(resolveWorkspace(name, dir), (error: unknown) => {
      assert.ok(error instanceof FactoryError);
      assert.equal(error.code, 'workspace_invalid');
      assert.doesNotMatch(error.message, new RegExp(temp));
      return true;
    }, name);
  }
  for (const name of ['missing', 'constructor', '../good']) {
    await assert.rejects(resolveWorkspace(name, dir), { code: 'workspace_not_found' }, name);
  }
});
