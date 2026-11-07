// Unit tests for the workspace registry: strict parsing, persistence and checkout verification.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { configDir, digestSettings, editedEntry, explainSettings, loadRegistry, parseRegistry, resolveWorkspace, saveRegistry, WORKSPACE_COLORS, workspaceApp, workspaceColor, workspaceDigest } from '../src/registry.js';

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

test('parseRegistry (SF-083): a workspace may set handoff to checkout or off; any other value is refused', () => {
  for (const handoff of ['checkout', 'off'] as const) {
    assert.deepEqual(parseRegistry(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', handoff } } })).workspaces.app, { read_checkout: '/srv/app', handoff });
  }
  for (const handoff of ['', 'on', 'Off', 'true', null, true, 1]) {
    invalid(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', handoff } } }));
  }
  assert.throws(() => parseRegistry(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', handoff: 'on' } } })), /workspaces\.app\.handoff/);
});

test('parseRegistry (SF-122): a workspace may set guard to true or false; any other value is refused', () => {
  for (const guard of [true, false]) {
    assert.deepEqual(parseRegistry(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', guard } } })).workspaces.app, { read_checkout: '/srv/app', guard });
  }
  for (const guard of ['yes', 'true', 1, null]) {
    invalid(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', guard } } }));
  }
  assert.throws(() => parseRegistry(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', guard: 'yes' } } })), /workspaces\.app\.guard/);
});

test('resolveWorkspace and editedEntry (SF-122): guard: true only when the entry says true; the Edit keeps the key', async () => {
  const dir = join(temp, 'resolve-guard');
  await saveRegistry({ workspaces: { on: { read_checkout: repo, guard: true }, off: { read_checkout: repo, guard: false }, unset: { read_checkout: repo } } }, dir);
  assert.deepEqual(await resolveWorkspace('on', dir), { name: 'on', readCheckout: repo, workCheckout: repo, guard: true });
  assert.deepEqual(await resolveWorkspace('off', dir), { name: 'off', readCheckout: repo, workCheckout: repo });
  assert.deepEqual(await resolveWorkspace('unset', dir), { name: 'unset', readCheckout: repo, workCheckout: repo });
  const edit = { read_checkout: '/srv/b', description: '', app: '', handoff: 'default', color: 'auto', digest: { track: false, my_work: false } } as const;
  assert.deepEqual(editedEntry({ read_checkout: '/srv/a', guard: true }, edit), { read_checkout: '/srv/b', guard: true });
});

test('parseRegistry (SF-084): a workspace may set color to one of the palette names; anything else is refused', () => {
  assert.deepEqual([...WORKSPACE_COLORS], ['blue', 'teal', 'green', 'olive', 'orange', 'red', 'purple', 'grey']);
  for (const color of WORKSPACE_COLORS) {
    assert.deepEqual(parseRegistry(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', color } } })).workspaces.app, { read_checkout: '/srv/app', color });
  }
  for (const color of ['', 'Blue', 'gray', 'pink', '#2b6cb0', null, 1]) {
    invalid(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', color } } }));
  }
  assert.throws(() => parseRegistry(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', color: 'pink' } } })), /workspaces\.app\.color/);
});

test('parseRegistry (SF-103): description, app and digest per workspace, the top-level digest settings with defaults; unknown keys still refused', () => {
  const text = JSON.stringify({
    workspaces: { api: { read_checkout: '/srv/api', description: 'The shop backend.', app: 'shop', digest: { track: true, my_work: false } }, web: { read_checkout: '/srv/web' } },
    digest: { at: '07:15', weekdays_only: false, model: 'opus', language: 'Deutsch' },
  });
  const registry = parseRegistry(text);
  assert.deepEqual(registry.workspaces.api, { read_checkout: '/srv/api', description: 'The shop backend.', app: 'shop', digest: { track: true, my_work: false } });
  assert.deepEqual(digestSettings(registry), { at: '07:15', weekdays_only: false, model: 'opus', language: 'Deutsch' });
  assert.deepEqual(digestSettings(parseRegistry('{"workspaces":{}}')), { at: '08:00', weekdays_only: true, model: 'sonnet', language: 'English' });
  assert.deepEqual([workspaceApp('api', registry.workspaces.api!), workspaceApp('web', registry.workspaces.web!)], ['shop', 'web']);
  assert.deepEqual(workspaceDigest(registry.workspaces.web!), { track: false, my_work: false });
  for (const bad of [
    { workspaces: { app: { read_checkout: '/srv/app', digest: { track: true, follow: true } } } },
    { workspaces: { app: { read_checkout: '/srv/app', digest: { track: 'yes' } } } },
    { workspaces: { app: { read_checkout: '/srv/app', app: '' } } },
    { workspaces: { app: { read_checkout: '/srv/app', tags: [] } } },
    { workspaces: {}, digest: { at: '8:00' } },
    { workspaces: {}, digest: { at: '08:00', email: 'x' } },
    { workspaces: {}, extra: 1 },
  ]) {
    invalid(JSON.stringify(bad));
  }
});

test('parseRegistry (SF-106): the top-level explain settings, each field optional, with defaults; an unknown field inside it is refused', () => {
  assert.deepEqual(explainSettings(parseRegistry('{"workspaces":{}}')), { on: true, language: 'English', model: 'sonnet' });
  assert.deepEqual(explainSettings(parseRegistry('{"workspaces":{},"explain":{}}')), { on: true, language: 'English', model: 'sonnet' });
  assert.deepEqual(explainSettings(parseRegistry('{"workspaces":{},"explain":{"language":" Bulgarian "}}')), { on: true, language: 'Bulgarian', model: 'sonnet' });
  assert.deepEqual(explainSettings(parseRegistry('{"workspaces":{},"explain":{"on":false}}')), { on: false, language: 'English', model: 'sonnet' });
  assert.deepEqual(explainSettings(parseRegistry('{"workspaces":{},"explain":{"on":true,"language":"Deutsch","model":"haiku"}}')), { on: true, language: 'Deutsch', model: 'haiku' });
  for (const bad of [
    { workspaces: {}, explain: { on: true, tone: 'calm' } },
    { workspaces: {}, explain: { on: 'yes' } },
    { workspaces: {}, explain: { language: '' } },
    { workspaces: {}, explain: { model: '' } },
    { workspaces: {}, explain: true },
  ]) {
    invalid(JSON.stringify(bad));
  }
});

test('editedEntry (SF-103): the form\'s fields replace the entry\'s; work_checkout and rules_skip stay', () => {
  const entry = { read_checkout: '/srv/a', work_checkout: '/srv/a', rules_skip: ['x/**'], handoff: 'off' as const, color: 'red' as const, description: 'old', app: 'old' };
  assert.deepEqual(editedEntry(entry, { read_checkout: '/srv/b', description: '', app: '', handoff: 'default', color: 'auto', digest: { track: false, my_work: false } }), { read_checkout: '/srv/b', work_checkout: '/srv/a', rules_skip: ['x/**'] });
  assert.deepEqual(editedEntry(entry, { read_checkout: '/srv/a', description: ' New. ', app: 'shop', handoff: 'checkout', color: 'blue', digest: { track: false, my_work: true } }), {
    read_checkout: '/srv/a', work_checkout: '/srv/a', rules_skip: ['x/**'], handoff: 'checkout', color: 'blue', description: 'New.', app: 'shop', digest: { track: false, my_work: true },
  });
});

test('workspaceColor (SF-084): the configured colour, else the palette entry at the sum of the name\'s UTF-16 code units mod 8', () => {
  assert.equal(workspaceColor('app', 'red'), 'red');
  // a=97, p=112, p=112: 321 mod 8 = 1.
  assert.equal(workspaceColor('app'), 'teal');
  // w=119, e=101, b=98: 318 mod 8 = 6.
  assert.equal(workspaceColor('web'), 'purple');
  assert.equal(workspaceColor('web'), workspaceColor('web'));
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
  // The workspace's own hand-over setting comes along (SF-083).
  await saveRegistry({ workspaces: { off: { read_checkout: repo, handoff: 'off' } } }, join(temp, 'resolve-handoff'));
  assert.deepEqual(await resolveWorkspace('off', join(temp, 'resolve-handoff')), { name: 'off', readCheckout: repo, workCheckout: repo, handoff: 'off' });
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
