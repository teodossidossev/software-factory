// Contract tests for the per-application configuration of the SF-006 execution
// adapter: factory-data/apps/<app-id>/.env, read as data, pointing at a separate
// Git worktree. Runs against a throwaway mediator and throwaway Git repositories.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { loadAppConfig } from '../src/execution/app-config.js';

let sandbox: string;
let mediator: string;
let appRepo: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: 'ignore' });
}

async function registerApp(appId: string, env: string | undefined): Promise<string> {
  const dir = join(mediator, 'factory-data', 'apps', appId);
  await mkdir(dir, { recursive: true });
  if (env !== undefined) {
    await writeFile(join(dir, '.env'), env, { mode: 0o600 });
  }
  return dir;
}

function rejectsWith(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code, String(error));
    // Private configuration values never appear in errors.
    assert.doesNotMatch(String((error as Error).message), new RegExp(sandbox.replaceAll('/', '\\/')));
    return true;
  };
}

before(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'sf-app-config-')));
  mediator = join(sandbox, 'mediator');
  appRepo = join(sandbox, 'app');
  for (const repo of [mediator, appRepo]) {
    await mkdir(repo);
    git(repo, 'init', '-q');
    await writeFile(join(repo, 'README.md'), 'x\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'init');
  }
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

test('resolves a registered app to its Git worktree root', async () => {
  await registerApp('app-one', `# app-one\n\nAPP_REPO=${appRepo}\n`);
  assert.deepEqual(await loadAppConfig(mediator, 'app-one'), { appId: 'app-one', repo: appRepo });

  // A symlinked path is resolved to the real repository root.
  await symlink(appRepo, join(sandbox, 'app-link'));
  await registerApp('app-link', `APP_REPO=${join(sandbox, 'app-link')}\n`);
  assert.equal((await loadAppConfig(mediator, 'app-link')).repo, appRepo);
});

test('rejects unregistered and unconfigured apps and invalid ids', async () => {
  await assert.rejects(loadAppConfig(mediator, 'missing-app'), rejectsWith('app_not_registered'));
  // A registered app without .env, like sf-pilot, is not executable.
  await registerApp('sf-pilot', undefined);
  await assert.rejects(loadAppConfig(mediator, 'sf-pilot'), rejectsWith('app_not_configured'));
  for (const id of ['../app-one', 'App', 'a/b', '', '.env']) {
    await assert.rejects(loadAppConfig(mediator, id), rejectsWith('invalid_id'), id);
  }
});

test('parses .env strictly as data and refuses injection, unknown keys and unsafe files', async () => {
  const invalid: Array<[string, string]> = [
    ['empty', ''],
    ['missing APP_REPO', '# nothing\n'],
    ['relative path', 'APP_REPO=../app\n'],
    ['unknown key', `APP_REPO=${appRepo}\nAPP_COMMAND=rm -rf /\n`],
    ['duplicate key', `APP_REPO=${appRepo}\nAPP_REPO=${appRepo}\n`],
    ['shell expansion', 'APP_REPO=$HOME/app\n'],
    ['command substitution', `APP_REPO=${appRepo}$(id)\n`],
    ['backticks', 'APP_REPO=`pwd`\n'],
    ['quotes', `APP_REPO="${appRepo}"\n`],
    ['export prefix', `export APP_REPO=${appRepo}\n`],
    ['spaces around =', `APP_REPO = ${appRepo}\n`],
    ['lowercase key', `app_repo=${appRepo}\n`],
    ['NUL byte', `APP_REPO=${appRepo}\0\n`],
    ['carriage return', `APP_REPO=${appRepo}\r\n`],
    ['too large', `# ${'x'.repeat(5000)}\nAPP_REPO=${appRepo}\n`],
  ];
  for (const [label, env] of invalid) {
    await registerApp('app-bad', env);
    await assert.rejects(loadAppConfig(mediator, 'app-bad'), rejectsWith('invalid_config'), label);
  }

  await registerApp('app-perm', `APP_REPO=${appRepo}\n`);
  await chmod(join(mediator, 'factory-data', 'apps', 'app-perm', '.env'), 0o666);
  await assert.rejects(loadAppConfig(mediator, 'app-perm'), rejectsWith('invalid_config'), 'group/world writable');

  const linked = await registerApp('app-envlink', undefined);
  await writeFile(join(sandbox, 'outside.env'), `APP_REPO=${appRepo}\n`, { mode: 0o600 });
  await symlink(join(sandbox, 'outside.env'), join(linked, '.env'));
  await assert.rejects(loadAppConfig(mediator, 'app-envlink'), rejectsWith('invalid_config'), 'symlinked .env');

  const dirEnv = await registerApp('app-envdir', undefined);
  await mkdir(join(dirEnv, '.env'));
  await assert.rejects(loadAppConfig(mediator, 'app-envdir'), rejectsWith('invalid_config'), '.env directory');
});

test('refuses repositories that are missing, not a worktree root, bare, or the mediator itself', async () => {
  await mkdir(join(sandbox, 'plain'));
  await mkdir(join(appRepo, 'sub'), { recursive: true });
  git(sandbox, 'init', '-q', '--bare', 'bare.git');
  const repos: Array<[string, string]> = [
    ['missing directory', join(sandbox, 'nope')],
    ['regular file', join(appRepo, 'README.md')],
    ['not a Git repository', join(sandbox, 'plain')],
    ['subdirectory of a worktree', join(appRepo, 'sub')],
    ['bare repository', join(sandbox, 'bare.git')],
    ['the mediator repository', mediator],
    ['inside the mediator', join(mediator, 'factory-data')],
  ];
  for (const [label, repo] of repos) {
    await registerApp('app-repo', `APP_REPO=${repo}\n`);
    await assert.rejects(loadAppConfig(mediator, 'app-repo'), rejectsWith('invalid_repo'), label);
  }
  // A repository that contains the mediator is refused as well.
  await registerApp('app-parent', `APP_REPO=${sandbox}\n`);
  git(sandbox, 'init', '-q');
  await assert.rejects(loadAppConfig(mediator, 'app-parent'), rejectsWith('invalid_repo'), 'contains the mediator');
});
