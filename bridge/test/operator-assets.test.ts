// SF-007 one-time setup asset: the optional desktop launcher that opens the
// operator console in gnome-terminal is rendered from a repository template
// with paths derived from the installation, validated with the system's own
// validator, and written only to the directory the operator names. Nothing is
// installed, and no service or listener exists to install.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../src/operator/main.js', import.meta.url));
const MEDIATOR = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
let sandbox: string;

before(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'sf-operator-assets-')));
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

// The CLI with a throwaway state home, so the operator's real state is not touched.
const cli = (...args: string[]) => spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: join(sandbox, 'state') } });

test('10: the template carries no host paths; the rendered launcher is derived from the installation and valid', async () => {
  assert.deepEqual((await readdir(join(MEDIATOR, 'deploy', 'operator'))).sort(), ['sf007-operator-console.desktop.in']);
  const template = await readFile(join(MEDIATOR, 'deploy', 'operator', 'sf007-operator-console.desktop.in'), 'utf8');
  assert.doesNotMatch(template, /\/home\/|sudo|0\.0\.0\.0|127\.0\.0\.1|http|--permission-mode/);
  const target = join(sandbox, 'assets');
  const rendered = cli('render-assets', target);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Nothing was installed/);
  assert.deepEqual(await readdir(target), ['sf007-operator-console.desktop']);
  const desktop = await readFile(join(target, 'sf007-operator-console.desktop'), 'utf8');
  assert.match(desktop, new RegExp(`^Exec=gnome-terminal --title=Software-Factory-operator -- ${process.execPath.replaceAll('/', '\\/')} ${MEDIATOR.replaceAll('/', '\\/')}/bridge/dist/src/operator/main\\.js console$`, 'm'));
  assert.doesNotMatch(desktop, /@[A-Z]+@/);
  assert.equal((await stat(join(target, 'sf007-operator-console.desktop'))).mode & 0o777, 0o644);
  if (existsSync('/usr/bin/desktop-file-validate')) execFileSync('desktop-file-validate', [join(target, 'sf007-operator-console.desktop')]);
  // An existing directory is never overwritten; the rendering created no operator state.
  assert.notEqual(cli('render-assets', target).status, 0);
  assert.equal(existsSync(join(sandbox, 'state')), false);
});

test('10: unknown commands and extra arguments are refused; the console refuses without a terminal', async () => {
  assert.equal(cli('serve').status, 2);
  assert.equal(cli('pair').status, 2);
  assert.equal(cli('status', 'extra').status, 2);
  const noTty = cli('console');
  assert.equal(noTty.status, 1);
  assert.match(noTty.stdout, /needs an interactive terminal/);
});
