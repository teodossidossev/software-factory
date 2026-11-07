// The configuration's own rules (src/config.ts). SF-104: SF_SMOKE_PROBE_ALLOW is honoured only for
// the state directory sf smoke makes for its run, <tmpdir>/sf-smoke-<suffix>/state, both sides
// resolved; every other state directory ignores it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, smokeProbeAllow, stateDir } from '../src/config.js';

const COMMAND = "node probe.mjs --canary '/t/sf-smoke-x/config/auth.env' > probe.json";

// Runs body with os.tmpdir() at tmp (TMPDIR), restoring it after.
async function withTmpdir<T>(tmp: string, body: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    return await body();
  } finally {
    if (saved === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = saved;
    }
  }
}

test('SF_SMOKE_PROBE_ALLOW: honoured for an existing <tmpdir>/sf-smoke-*/state, also through a symlinked tmpdir; empty is unset; loadConfig reads it for its state directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sf-config-test-')));
  try {
    const tmp = join(root, 'tmp');
    const state = join(tmp, 'sf-smoke-x', 'state');
    await mkdir(state, { recursive: true });
    const link = join(root, 'tmp-link');
    await symlink(tmp, link);
    const env = { SF_SMOKE_PROBE_ALLOW: COMMAND };
    await withTmpdir(tmp, () => {
      assert.equal(smokeProbeAllow(env, state), COMMAND);
      assert.equal(smokeProbeAllow({ SF_SMOKE_PROBE_ALLOW: '' }, state), undefined);
      assert.equal(smokeProbeAllow({}, state), undefined);
      assert.equal(loadConfig({ SF_STATE_DIR: state, SF_GATE: 'off', ...env }).smokeProbeAllow, COMMAND);
      assert.equal(loadConfig({ SF_STATE_DIR: state, SF_GATE: 'off' }).smokeProbeAllow, undefined);
      // The state directory reached through a symlink to the tmpdir.
      assert.equal(smokeProbeAllow(env, join(link, 'sf-smoke-x', 'state')), COMMAND);
    });
    // The tmpdir itself a symlink (macOS /var -> /private/var): both sides resolved.
    await withTmpdir(link, () => {
      assert.equal(smokeProbeAllow(env, join(link, 'sf-smoke-x', 'state')), COMMAND);
      assert.equal(smokeProbeAllow(env, state), COMMAND);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SF_SMOKE_PROBE_ALLOW: ignored for the default state directory, SF_STATE_DIR elsewhere, a deeper path, a symlink into a smoke-like path that resolves elsewhere, and a state directory that does not exist yet', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sf-config-test-')));
  try {
    const tmp = join(root, 'tmp');
    await mkdir(tmp);
    const env = { SF_SMOKE_PROBE_ALLOW: COMMAND };
    // The default state directory of a real install: the user's own, and one under an
    // XDG_STATE_HOME in the tmpdir that looks like the smoke's.
    const defaultEnv = { ...env, XDG_STATE_HOME: join(tmp, 'sf-smoke-home') };
    const real = stateDir(defaultEnv);
    assert.equal(real, join(tmp, 'sf-smoke-home', 'software-factory'));
    const elsewhere = join(root, 'elsewhere', 'state');
    const notSmoke = join(tmp, 'smoke-x', 'state');
    const prefixed = join(tmp, 'my-sf-smoke-x', 'state');
    const notState = join(tmp, 'sf-smoke-x', 'state2');
    const deeper = join(tmp, 'sf-smoke-x', 'a', 'state');
    const outsideTmp = join(root, 'sf-smoke-x', 'state');
    for (const dir of [real, elsewhere, notSmoke, prefixed, notState, deeper, outsideTmp]) {
      await mkdir(dir, { recursive: true });
    }
    // A smoke-like path whose state is a symlink to a directory outside the layout.
    await mkdir(join(tmp, 'sf-smoke-y'));
    await symlink(elsewhere, join(tmp, 'sf-smoke-y', 'state'));
    // A smoke-like directory that is itself a symlink elsewhere.
    await mkdir(join(root, 'other', 'state'), { recursive: true });
    await symlink(join(root, 'other'), join(tmp, 'sf-smoke-z'));
    await withTmpdir(tmp, () => {
      assert.equal(smokeProbeAllow(env, stateDir({})), undefined);
      assert.equal(loadConfig({ ...env, SF_GATE: 'off' }).smokeProbeAllow, undefined);
      assert.equal(smokeProbeAllow(defaultEnv, stateDir(defaultEnv)), undefined);
      assert.equal(loadConfig({ ...defaultEnv, SF_GATE: 'off' }).smokeProbeAllow, undefined);
      for (const dir of [elsewhere, notSmoke, prefixed, notState, deeper, outsideTmp, join(tmp, 'sf-smoke-y', 'state'), join(tmp, 'sf-smoke-z', 'state')]) {
        assert.equal(smokeProbeAllow(env, dir), undefined, dir);
        assert.equal(loadConfig({ ...env, SF_STATE_DIR: dir, SF_GATE: 'off' }).smokeProbeAllow, undefined, dir);
      }
      // Not made yet: the realpath fails, the setting is ignored.
      assert.equal(smokeProbeAllow(env, join(tmp, 'sf-smoke-new', 'state')), undefined);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
