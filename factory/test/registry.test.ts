// Unit tests for the workspace registry: strict parsing, persistence and checkout verification.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import {
  configDir, digestSettings, editedEntry, MAX_DIGEST_TIMES, explainSettings, isNotifyMode, loadRegistry, NOTIFY_MODES, parseRegistry, resolveWorkspace, saveRegistry, WORKSPACE_COLORS, workspaceApp, workspaceColor,
  workspaceDigest, workspaceNotify, workspaceNotifyMode,
} from '../src/registry.js';

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

test('parseRegistry, resolveWorkspace and editedEntry (SF-128): test_command is 1 to 2000 characters without NUL, exposed as testCommand; the Edit keeps it', async () => {
  for (const command of ['npm test', 'x', 'c'.repeat(2000), 'cd factory && npm test\nnpm run lint']) {
    assert.deepEqual(parseRegistry(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', test_command: command } } })).workspaces.app, { read_checkout: '/srv/app', test_command: command });
  }
  for (const command of ['', 'c'.repeat(2001), 'npm\0test', 1, true, null, ['npm', 'test']]) {
    invalid(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', test_command: command } } }));
  }
  assert.throws(() => parseRegistry(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', test_command: '' } } })), /workspaces\.app\.test_command/);
  const dir = join(temp, 'resolve-tests');
  await saveRegistry({ workspaces: { with: { read_checkout: repo, test_command: 'npm test' }, without: { read_checkout: repo } } }, dir);
  assert.deepEqual(await resolveWorkspace('with', dir), { name: 'with', readCheckout: repo, workCheckout: repo, testCommand: 'npm test' });
  assert.deepEqual(await resolveWorkspace('without', dir), { name: 'without', readCheckout: repo, workCheckout: repo });
  const edit = { read_checkout: '/srv/b', description: 'B', app: '', handoff: 'off', color: 'auto', digest: { track: false, my_work: false } } as const;
  assert.deepEqual(editedEntry({ read_checkout: '/srv/a', test_command: 'npm test' }, edit), { read_checkout: '/srv/b', handoff: 'off', description: 'B', test_command: 'npm test' });
});

test('parseRegistry, workspaceNotify and editedEntry (SF-215): notify is full, brief or off, absent full; any other value is refused; the Edit keeps it', () => {
  for (const notify of ['full', 'brief', 'off'] as const) {
    const parsed = parseRegistry(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', notify } } })).workspaces.app!;
    assert.deepEqual(parsed, { read_checkout: '/srv/app', notify });
    assert.equal(workspaceNotify(parsed), notify);
  }
  assert.equal(workspaceNotify(parseRegistry(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app' } } })).workspaces.app!), 'full');
  assert.throws(() => parseRegistry(JSON.stringify({ workspaces: { app: { read_checkout: '/srv/app', notify: 'quiet' } } })), /workspaces\.app\.notify/);
  assert.deepEqual(NOTIFY_MODES, ['full', 'brief', 'off']);
  assert.equal(isNotifyMode('brief'), true);
  assert.equal(isNotifyMode('quiet'), false);
  const edit = { read_checkout: '/srv/b', description: '', app: '', handoff: 'default', color: 'auto', digest: { track: false, my_work: false } } as const;
  assert.deepEqual(editedEntry({ read_checkout: '/srv/a', notify: 'off' }, edit), { read_checkout: '/srv/b', notify: 'off' });
});

test('workspaceNotifyMode (SF-215): read from the registry on each call; a workspace not registered, or a registry that cannot be read, is full', async () => {
  const dir = join(temp, 'notify-mode');
  await saveRegistry({ workspaces: { quiet: { read_checkout: '/srv/q', notify: 'off' }, plain: { read_checkout: '/srv/p' } } }, dir);
  assert.equal(await workspaceNotifyMode('quiet', dir), 'off');
  assert.equal(await workspaceNotifyMode('plain', dir), 'full');
  assert.equal(await workspaceNotifyMode('gone', dir), 'full');
  assert.equal(await workspaceNotifyMode('constructor', dir), 'full');
  await saveRegistry({ workspaces: { quiet: { read_checkout: '/srv/q', notify: 'brief' } } }, dir);
  assert.equal(await workspaceNotifyMode('quiet', dir), 'brief');
  await writeFile(join(dir, 'workspaces.json'), '{ not json');
  assert.equal(await workspaceNotifyMode('quiet', dir), 'full');
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
  // A stored `at` (a file of before `times`) reads as one time.
  assert.deepEqual(digestSettings(registry), { times: ['07:15'], weekdays_only: false, model: 'opus', language: 'Deutsch' });
  assert.deepEqual(digestSettings(parseRegistry('{"workspaces":{}}')), { times: ['08:00'], weekdays_only: true, model: 'sonnet', language: 'English' });
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

test('parseRegistry and digestSettings: digest.times, 1 to 4 distinct HH:MM, read sorted; times wins over at; a bad list is refused', () => {
  const settings = (digest: unknown) => digestSettings(parseRegistry(JSON.stringify({ workspaces: {}, digest })));
  assert.deepEqual(settings({ times: ['10:45', '08:30'] }), { times: ['08:30', '10:45'], weekdays_only: true, model: 'sonnet', language: 'English' });
  assert.deepEqual(settings({ times: ['23:59', '00:00', '12:00', '06:15'] }).times, ['00:00', '06:15', '12:00', '23:59']);
  assert.deepEqual(settings({ times: ['09:00'], at: '07:00' }).times, ['09:00']);
  assert.deepEqual(Object.keys(settings({ at: '07:00', weekdays_only: false })).sort(), ['language', 'model', 'times', 'weekdays_only']);
  assert.equal(MAX_DIGEST_TIMES, 4);
  for (const times of [[], ['08:00', '09:00', '10:00', '11:00', '12:00'], ['08:00', '08:00'], ['24:00'], ['8:00'], ['08:00', 9], 'x']) {
    invalid(JSON.stringify({ workspaces: {}, digest: { times } }));
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
