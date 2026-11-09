// read_file's refusals (SF-164): the credential-like names of isForbidden, tracked or not, and the
// files Git ignores in the read checkout, the requested path and the target of a link alike.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { isForbidden, RepoFiles, RepoReadError } from '../src/repo-files.js';

let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(repo, path, '..'), { recursive: true });
  await writeFile(join(repo, path), text);
}

before(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'sf-repo-files-')));
  git(repo, 'init', '-q');
  await put('.gitignore', ['.envrc', '*.pem', 'credentials.json', 'local/', ':secret.txt', ''].join('\n'));
  await put('README.md', 'hello\n');
  await put('keys/id_ed25519.pub', 'ssh-ed25519 AAAA\n');
  await put('keys/id_ecdsa', 'PRIVATE\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  // Ignored, not tracked.
  await put('.envrc', 'export TOKEN=1\n');
  await put('deploy.pem', 'PEM\n');
  await put('credentials.json', '{}\n');
  await put('local/settings.yaml', 'password: 1\n');
  await put(':secret.txt', 'secret\n');
  // The Task directory, ignored through info/exclude as write_task sets it up.
  await writeFile(join(repo, '.git', 'info', 'exclude'), '.software-factory/\n');
  await put('.software-factory/T-1.md', 'the task\n');
  await put('real/notes.md', 'notes\n');
  await symlink('local/settings.yaml', join(repo, 'settings-link.yaml'));
  await symlink('real', join(repo, 'dir-link'));
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function refusal(path: string): Promise<{ code: string; message: string }> {
  const error = await new RepoFiles(repo).read({ path }).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof RepoReadError, `${path} was read`);
  return { code: error.code, message: error.message };
}

test('isForbidden also refuses *.pem, .envrc, id_* but *.pub, *.tfvars and credentials*.json, tracked or not', () => {
  for (const path of ['deploy.pem', 'a/B.PEM', '.envrc', 'x/.envrc', 'id_rsa', 'id_ed25519', 'keys/id_ecdsa', 'id_dsa_sk', 'prod.tfvars', 'credentials.json', 'gcp/credentials-prod.json', 'Credentials.JSON']) {
    assert.equal(isForbidden(path), true, path);
  }
  for (const path of ['README.md', 'keys/id_ed25519.pub', 'id_rsa.pub', 'pem.md', 'envrc', 'credentials.yaml', 'my-credentials.json', 'main.tf']) {
    assert.equal(isForbidden(path), false, path);
  }
});

test('read_file refuses an ignored .envrc, deploy.pem and credentials.json with the existing forbidden_path refusal', async () => {
  for (const path of ['.envrc', 'deploy.pem', 'credentials.json']) {
    assert.deepEqual(await refusal(path), { code: 'forbidden_path', message: `${path} is excluded from repository reads.` });
  }
});

test('read_file refuses an ignored file no name rule matches, and a link to it, with the reason "ignored by .gitignore"', async () => {
  assert.equal(isForbidden('local/settings.yaml'), false);
  assert.deepEqual(await refusal('local/settings.yaml'), { code: 'forbidden_path', message: 'local/settings.yaml is excluded from repository reads (ignored by .gitignore).' });
  // A leading ':' is a file name, not pathspec magic.
  assert.deepEqual(await refusal(':secret.txt'), { code: 'forbidden_path', message: ':secret.txt is excluded from repository reads (ignored by .gitignore).' });
  // The link itself is not ignored; its target is.
  assert.deepEqual(await refusal('settings-link.yaml'), { code: 'forbidden_path', message: 'settings-link.yaml is excluded from repository reads (ignored by .gitignore).' });
});

test('read_file refuses with "could not check .gitignore" when git check-ignore fails (a path beyond a symbolic link)', async () => {
  assert.deepEqual(await refusal('dir-link/notes.md'), { code: 'forbidden_path', message: 'dir-link/notes.md is excluded from repository reads (could not check .gitignore).' });
});

test('read_file reads an ignored file under .software-factory/, a tracked README.md and a tracked id_ed25519.pub, and refuses a tracked id_ecdsa', async () => {
  const files = new RepoFiles(repo);
  assert.equal((await files.read({ path: '.software-factory/T-1.md' })).text, 'the task\n');
  assert.equal((await files.read({ path: 'README.md' })).text, 'hello\n');
  assert.equal((await files.read({ path: './real//notes.md' })).text, 'notes\n');
  assert.equal((await files.read({ path: 'keys/id_ed25519.pub' })).text, 'ssh-ed25519 AAAA\n');
  assert.deepEqual(await refusal('keys/id_ecdsa'), { code: 'forbidden_path', message: 'keys/id_ecdsa is excluded from repository reads.' });
});
