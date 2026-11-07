// The environment file: parsing, the default path, precedence of variables already set, a
// missing file, and `sf` reading it (sf info shows what it read).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { envFilePath, loadEnvFile, parseEnvFile } from '../src/config.js';
import { newEnv, runCli, temp } from './support/harness.js';

test('parseEnvFile: KEY=VALUE, comments, export, quotes; a malformed line is refused', () => {
  const parsed = parseEnvFile('# comment\n\nA=1\nexport B = two words \nC="quoted # not a comment"\nD=\'single\'\nE=\n');
  assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'quoted # not a comment', D: 'single', E: '' });
  assert.throws(() => parseEnvFile('not a line'), { code: 'invalid_env_file' });
  assert.throws(() => parseEnvFile('1A=x'), { code: 'invalid_env_file' });
});

test('envFilePath: the config directory by default, SF_ENV_FILE overrides, empty turns it off', () => {
  assert.equal(envFilePath({ XDG_CONFIG_HOME: '/x' }), '/x/software-factory/auth.env');
  assert.equal(envFilePath({ SF_CONFIG_DIR: '/c' }), '/c/auth.env');
  assert.equal(envFilePath({ SF_ENV_FILE: '/elsewhere/env' }), '/elsewhere/env');
  assert.equal(envFilePath({ SF_ENV_FILE: '' }), undefined);
});

test('loadEnvFile: sets only unset variables, reports them, and a missing file sets nothing', async () => {
  const dir = join(temp, 'env-file');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'auth.env');
  await writeFile(path, 'SF_MODEL=claude-opus-5-5\nSF_NOTIFY_ITERATIONS=on\n');
  const env: NodeJS.ProcessEnv = { SF_MODEL: 'kept' };
  assert.deepEqual(loadEnvFile(env, path), ['SF_NOTIFY_ITERATIONS']);
  assert.deepEqual(env, { SF_MODEL: 'kept', SF_NOTIFY_ITERATIONS: 'on' });
  assert.deepEqual(loadEnvFile(env, join(dir, 'missing.env')), []);
  assert.deepEqual(loadEnvFile({ ...env, SF_ENV_FILE: '' }), []);
});

test('sf info: works without sf serve, reads the env file and reports the state', async () => {
  // A real tunnel may run on this machine: point the health check at a closed port.
  const env = await newEnv('info', { SF_TUNNEL_HEALTH: '127.0.0.1:1' });
  await mkdir(env.config, { recursive: true });
  await writeFile(join(env.config, 'auth.env'), 'SF_MODEL=from-env-file\n');
  const shown = await runCli(env, ['info']);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^version {7}software-factory \d+\.\d+\.\d+$/m);
  assert.match(shown.stdout, new RegExp(`^env file {6}${env.config.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/auth\\.env \\(read\\)$`, 'm'));
  assert.match(shown.stdout, /^model {9}from-env-file$/m);
  assert.match(shown.stdout, /^serve {9}not running \(npm run serve\)$/m);
  assert.match(shown.stdout, /^tunnel {8}not running \(npm run tunnel\)$/m);
  assert.match(shown.stdout, /^dashboard {5}no token yet/m);
  assert.match(shown.stdout, /^jobs: none$/m);
  // The MCP URL with <token> in the token's place (SF-099), never a value; with SF_PORT=0 and no sf
  // serve the port is not known yet.
  assert.match(shown.stdout, /^mcp {11}any free port \(SF_PORT=0\): sf mcp-url shows the URL while sf serve runs$/m);
  const fixed = await runCli({ ...env, extra: { ...env.extra, SF_PORT: '9123' } }, ['info']);
  assert.match(fixed.stdout, /^mcp {11}http:\/\/127\.0\.0\.1:9123\/mcp\/<token> \(planning tools, loopback only; the URL with the token: sf mcp-url\)$/m);
  assert.doesNotMatch(shown.stdout, /subscriptions|auth /);
  assert.equal((await runCli(env, ['info', 'extra'])).code, 2);
});

test('sf info: the gate level row (SF-092) after the gate row, whatever the gate: auto, full, or invalid with the message', async () => {
  for (const [name, extra, row] of [
    ['info-level-auto', {}, /^gate level {4}auto$/m],
    ['info-level-full', { SF_GATE_LEVEL: 'full' }, /^gate level {4}full$/m],
    ['info-level-invalid', { SF_GATE_LEVEL: 'light' }, /^gate level {4}invalid: SF_GATE_LEVEL must be auto or full, got "light"\.$/m],
  ] as const) {
    const env = await newEnv(name, { SF_TUNNEL_HEALTH: '127.0.0.1:1', ...extra });
    const shown = await runCli(env, ['info']);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, row);
    // Right after the gate row, which stays as it was.
    assert.match(shown.stdout, /^gate {10}off \(SF_GATE=off\)\ngate level {4}/m);
  }
});
