// sf dashboard --open: the URL is printed and handed to xdg-open (a fake one in a private PATH,
// never a real browser) exactly once as one argument; usage, configuration and launcher failures
// keep the documented exit codes, and nothing is launched on an invalid configuration.
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInBrowser } from '../src/browser.js';
import { TOKEN_FILE } from '../src/dashboard.js';
import { FactoryError } from '../src/errors.js';
import { newEnv, runCli, temp } from './support/harness.js';

const TOKEN = 'ab'.repeat(32);

// A directory with a fake xdg-open that records each call's arguments and exits with the given code.
async function fakeLauncher(name: string, exit: number, body = ''): Promise<{ bin: string; calls(): Promise<string[][]> }> {
  const bin = join(temp, name);
  const log = join(bin, 'xdg-open.log');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'xdg-open'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> '${log}'\nprintf '\\036' >> '${log}'\n${body}\nexit ${exit}\n`);
  await chmod(join(bin, 'xdg-open'), 0o755);
  return {
    bin,
    async calls() {
      const text = await readFile(log, 'utf8').catch(() => '');
      return text.split('\x1e').filter((entry) => entry !== '').map((entry) => entry.split('\x1f').slice(0, -1));
    },
  };
}

test('sf dashboard --open: prints the URL and runs xdg-open once with that URL as its only argument', async () => {
  const launcher = await fakeLauncher('open-ok', 0);
  const env = await newEnv('open-ok', { PATH: launcher.bin, SF_DASHBOARD_PORT: '8799' });
  await mkdir(env.state, { recursive: true });
  await writeFile(join(env.state, TOKEN_FILE), `${TOKEN}\n`);
  const url = `http://127.0.0.1:8799/d/${TOKEN}/`;

  // Plain sf dashboard launches nothing.
  const plain = await runCli(env, ['dashboard']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.stdout, `${url}\nThe token stays the same across sf serve starts; sf dashboard --rotate makes the next start pick a new one.\n`);
  assert.deepEqual(await launcher.calls(), []);

  const opened = await runCli(env, ['dashboard', '--open']);
  assert.equal(opened.code, 0, opened.stderr);
  assert.equal(opened.stdout.split('\n')[0], url);
  assert.match(opened.stdout, /The token stays the same across sf serve starts/);
  assert.deepEqual(await launcher.calls(), [[url]]);
});

test('sf dashboard --open: launcher failures exit 1 with the URL printed; configuration errors exit 1 without launching', async () => {
  const failing = await fakeLauncher('open-fail', 3);
  const env = await newEnv('open-fail', { PATH: failing.bin, SF_DASHBOARD_PORT: '8799' });
  await mkdir(env.state, { recursive: true });
  await writeFile(join(env.state, TOKEN_FILE), `${TOKEN}\n`);
  const url = `http://127.0.0.1:8799/d/${TOKEN}/`;

  const failed = await runCli(env, ['dashboard', '--open']);
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout.split('\n')[0], url);
  assert.match(failed.stderr, /^sf: xdg-open exited with 3; open the URL above by hand\./);
  assert.deepEqual(await failing.calls(), [[url]]);

  const empty = join(temp, 'open-empty');
  await mkdir(empty, { recursive: true });
  const missing = await runCli({ ...env, extra: { ...env.extra, PATH: empty } }, ['dashboard', '--open']);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout.split('\n')[0], url);
  assert.match(missing.stderr, /^sf: xdg-open is not on PATH \(install xdg-utils\); open the URL above by hand\./);

  // Usage errors: an unknown option, a malformed option and an extra positional.
  for (const args of [['dashboard', '--nope'], ['dashboard', '--open=yes'], ['dashboard', 'extra'], ['dashboard', '--open', 'extra']]) {
    const usage = await runCli(env, args);
    assert.equal(usage.code, 2, args.join(' '));
    assert.match(usage.stderr, /^sf: .*\n\nUsage:/, args.join(' '));
  }
  // Configuration errors come first and launch nothing.
  await rm(join(failing.bin, 'xdg-open.log'), { force: true });
  const off = await runCli({ ...env, extra: { ...env.extra, SF_DASHBOARD: 'off' } }, ['dashboard', '--open']);
  assert.deepEqual([off.code, off.stdout], [1, '']);
  assert.match(off.stderr, /The dashboard is off/);
  const badPort = await runCli({ ...env, extra: { ...env.extra, SF_DASHBOARD_PORT: '99999' } }, ['dashboard', '--open']);
  assert.deepEqual([badPort.code, badPort.stdout], [1, '']);
  assert.match(badPort.stderr, /SF_DASHBOARD_PORT must be an integer/);
  await writeFile(join(env.state, TOKEN_FILE), 'not-a-token\n');
  const badToken = await runCli(env, ['dashboard', '--open']);
  assert.deepEqual([badToken.code, badToken.stdout], [1, '']);
  assert.match(badToken.stderr, /does not hold a dashboard token/);
  await rm(join(env.state, TOKEN_FILE));
  const noToken = await runCli(env, ['dashboard', '--open']);
  assert.deepEqual([noToken.code, noToken.stdout], [1, '']);
  assert.match(noToken.stderr, /There is no dashboard token/);
  assert.deepEqual(await failing.calls(), []);
});

test('openInBrowser: the wait for the launcher is bounded', async () => {
  const slow = await fakeLauncher('open-slow', 0, 'exec /bin/sleep 30');
  const path = process.env.PATH;
  process.env.PATH = slow.bin;
  try {
    await assert.rejects(openInBrowser('http://127.0.0.1:8799/d/x/', 300), (error: unknown) => {
      assert.ok(error instanceof FactoryError);
      assert.equal(error.code, 'open_failed');
      assert.match(error.message, /^xdg-open did not finish within 0\.3 s; open the URL above by hand\./);
      return true;
    });
    assert.deepEqual(await slow.calls(), [['http://127.0.0.1:8799/d/x/']]);
  } finally {
    process.env.PATH = path;
  }
});
