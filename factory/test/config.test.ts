// The configuration's own rules (src/config.ts). SF-104: SF_SMOKE_PROBE_ALLOW is honoured only for
// the state directory sf smoke makes for its run, <tmpdir>/sf-smoke-<suffix>/state, both sides
// resolved; every other state directory ignores it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { claudeReviewDecision, fixSessionDecision, fixSessionSetting, loadConfig, smokeProbeAllow, stateDir } from '../src/config.js';
import { FactoryError } from '../src/errors.js';

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

test('SF_CLAUDE_REVIEW and SF_MAX_ITERATIONS (SF-131): defaults ticket and 3; always is read; any other value is invalid_config', () => {
  const base = { HOME: '/home/u', SF_STATE_DIR: '/tmp/sf-config-test-state' };
  const defaults = loadConfig(base);
  assert.equal(defaults.claudeReview, 'ticket');
  assert.equal(defaults.maxIterations, 3);
  assert.equal(loadConfig({ ...base, SF_CLAUDE_REVIEW: '' }).claudeReview, 'ticket');
  assert.equal(loadConfig({ ...base, SF_CLAUDE_REVIEW: 'always' }).claudeReview, 'always');
  assert.equal(loadConfig({ ...base, SF_MAX_ITERATIONS: '5' }).maxIterations, 5);
  for (const value of ['Always', 'claude', 'off']) {
    assert.throws(() => loadConfig({ ...base, SF_CLAUDE_REVIEW: value }), (error: unknown) => {
      assert.ok(error instanceof FactoryError);
      assert.equal(error.code, 'invalid_config');
      assert.equal(error.message, `SF_CLAUDE_REVIEW must be ticket or always, got "${value}".`);
      return true;
    });
  }
});

test('the Claude review of a job (SF-131, claudeReviewDecision): the gate off means Claude; then the Task file\'s review; then the setting, absent counting as always', () => {
  const on = { on: true as const, codexPath: '/bin/codex' };
  const off = { on: false as const, reason: 'SF_GATE=off' };
  assert.deepEqual(claudeReviewDecision({ claudeReview: 'ticket', gate: on }, undefined), { claude_review: false, reason: 'SF_CLAUDE_REVIEW=ticket' });
  assert.deepEqual(claudeReviewDecision({ claudeReview: 'ticket', gate: on }, 'claude'), { claude_review: true, reason: 'the Task file says review: claude' });
  assert.deepEqual(claudeReviewDecision({ claudeReview: 'always', gate: on }, undefined), { claude_review: true, reason: 'SF_CLAUDE_REVIEW=always' });
  assert.deepEqual(claudeReviewDecision({ claudeReview: 'always', gate: on }, 'codex'), { claude_review: false, reason: 'the Task file says review: codex' });
  assert.deepEqual(claudeReviewDecision({ gate: on }, undefined), { claude_review: true, reason: 'SF_CLAUDE_REVIEW=always' });
  assert.deepEqual(claudeReviewDecision({ claudeReview: 'ticket', gate: off }, 'codex'), { claude_review: true, reason: 'the gate is off (SF_GATE=off)' });
});

test('SF_FIX_SESSION (SF-316): default resume; resume, fresh and alternate are read; any other value is invalid_config at start', () => {
  const base = { HOME: '/home/u', SF_STATE_DIR: '/tmp/sf-config-test-state' };
  assert.equal(loadConfig(base).fixSession, 'resume');
  assert.equal(loadConfig({ ...base, SF_FIX_SESSION: '' }).fixSession, 'resume');
  for (const value of ['resume', 'fresh', 'alternate'] as const) {
    assert.equal(loadConfig({ ...base, SF_FIX_SESSION: value }).fixSession, value);
    assert.equal(fixSessionSetting({ SF_FIX_SESSION: value }), value);
  }
  for (const value of ['Fresh', 'new', 'off']) {
    assert.throws(() => loadConfig({ ...base, SF_FIX_SESSION: value }), (error: unknown) => {
      assert.ok(error instanceof FactoryError);
      assert.equal(error.code, 'invalid_config');
      assert.equal(error.message, `SF_FIX_SESSION must be resume, fresh or alternate, got "${value}".`);
      return true;
    });
  }
});

test('the fix session of a job (SF-316, fixSessionDecision): the Task key wins; else the setting, absent counting as resume; alternate gives one arm per ticket by the first byte of sha256("<workspace>/<ticket>")', () => {
  assert.deepEqual(fixSessionDecision({ fixSession: 'resume' }, undefined, 'app', 'T-1'), { fix_session: 'resume', reason: 'setting' });
  assert.deepEqual(fixSessionDecision({ fixSession: 'fresh' }, undefined, 'app', 'T-1'), { fix_session: 'fresh', reason: 'setting' });
  assert.deepEqual(fixSessionDecision({}, undefined, 'app', 'T-1'), { fix_session: 'resume', reason: 'setting' });
  // The key overrides every setting, alternate too.
  for (const setting of ['resume', 'fresh', 'alternate'] as const) {
    assert.deepEqual(fixSessionDecision({ fixSession: setting }, 'fresh', 'app', 'T-1'), { fix_session: 'fresh', reason: 'task' });
    assert.deepEqual(fixSessionDecision({ fixSession: setting }, 'resume', 'app', 'T-1'), { fix_session: 'resume', reason: 'task' });
  }
  // alternate: the hash's first byte decides; the same ticket gets the same arm every time, and a
  // set of names gets both arms.
  const arms = new Set<string>();
  for (let index = 1; index <= 20; index += 1) {
    const ticket = `SF-${index}`;
    const decided = fixSessionDecision({ fixSession: 'alternate' }, undefined, 'software-factory', ticket);
    const even = createHash('sha256').update(`software-factory/${ticket}`).digest()[0]! % 2 === 0;
    assert.deepEqual(decided, { fix_session: even ? 'fresh' : 'resume', reason: 'alternate' }, ticket);
    assert.deepEqual(fixSessionDecision({ fixSession: 'alternate' }, undefined, 'software-factory', ticket), decided, ticket);
    arms.add(decided.fix_session);
  }
  assert.deepEqual([...arms].sort(), ['fresh', 'resume']);
});
