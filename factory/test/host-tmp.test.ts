// The host's temporary folder as the factory's Claude sessions see it: the temporary roots denied
// for reading, the kept paths under them read back (the worktree and the session's own folder
// written too), the more specific denials kept inside them, the file-tool guard's refusal there, the
// session's own temporary folder (CLAUDE_CODE_TMPDIR, 0700, removed whenever the session ends), and
// the test runs and the gate left as they were.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sandboxSettings } from '../src/config.js';
import { claudeTmpRule, inTmpRoot, makeSessionTmp, removeSessionTmp, SESSION_TMP_PREFIX, sweepSessionTmps, TMP_REFUSAL, tmpRoots } from '../src/host-tmp.js';
import { saveRegistry } from '../src/registry.js';
import { runReview } from '../src/review.js';
import { type DenialScope, FILE_GUARD, type PathDenials, pathDenials, prepareTaskChecksDir, taskChecksDir, withSandboxDenials } from '../src/sandbox-denials.js';
import { endSession, type IdleOutcome, ImplementerSession } from '../src/session.js';
import { guardReason } from '../src/task-check.js';
import { bwrapArgs, hiddenMounts } from '../src/test-command.js';
import { FAKE, fakeLog, newEnv, reviewLog, reviewScript, script, temp } from './support/harness.js';

// A factory whose worktree, checkout and state directory lie under a fake temporary root (tmp), as
// the smoke's do under /tmp: a .env in the worktree, another job's worktree, the state's jobs/; the
// session's own temporary folder and a stray folder of another program there too. The config and
// the home lie outside it.
interface Layout {
  root: string;
  tmp: string;
  state: string;
  worktrees: string;
  own: string;
  sibling: string;
  checkout: string;
  sessionTmp: string;
  stray: string;
  home: string;
  config: string;
}

async function layout(name: string): Promise<Layout> {
  await rm(join(temp, name), { recursive: true, force: true });
  await mkdir(join(temp, name), { recursive: true });
  const root = await realpath(join(temp, name));
  const tmp = join(root, 'tmp');
  const l: Layout = {
    root, tmp, state: join(tmp, 'state'), worktrees: join(tmp, 'state', 'worktrees'), own: join(tmp, 'state', 'worktrees', 'app', 'A-1'),
    sibling: join(tmp, 'state', 'worktrees', 'app', 'A-2'), checkout: join(tmp, 'checkout'), sessionTmp: join(tmp, `${SESSION_TMP_PREFIX}test`),
    stray: join(tmp, 'other-program'), home: join(root, 'home'), config: join(root, 'config'),
  };
  for (const dir of [l.own, l.sibling, join(l.state, 'jobs'), l.checkout, l.stray, join(l.home, 'notes'), l.config]) {
    await mkdir(dir, { recursive: true });
  }
  await mkdir(l.sessionTmp, { mode: 0o700 });
  await writeFile(join(l.own, '.env'), 'SECRET=x\n');
  await writeFile(join(l.own, 'a.ts'), 'a\n');
  await writeFile(join(l.stray, 'socket-like'), 'x\n');
  await saveRegistry({ workspaces: { app: { read_checkout: l.checkout } } }, l.config);
  return l;
}

const scope = (l: Layout, session: DenialScope['session']): DenialScope => ({
  session, workspace: 'app', checkout: l.checkout, ...(session === 'job' ? { worktree: l.own } : {}), sessionTmp: l.sessionTmp, stateDir: l.state,
  worktreeRoot: l.worktrees, configDir: l.config, env: { HOME: l.home, SF_CONFIG_DIR: l.config, SF_ENV_FILE: join(l.root, 'none.env') }, tmp: l.tmp, systemRoot: join(l.root, 'sys'),
});

const sorted = (paths: readonly string[]): string[] => [...paths].sort();

async function guard(denials: PathDenials, cwd: string, tool: string, input: unknown): Promise<string | undefined> {
  const hook = denials.hooks!.PreToolUse![0]!.hooks[0]!;
  const answer = await hook({ hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '', cwd, tool_name: tool, tool_input: input, tool_use_id: 't' } as never, 't', { signal: new AbortController().signal });
  const specific = (answer as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return specific?.permissionDecision === 'deny' ? specific.permissionDecisionReason : undefined;
}

test('a job under the temporary root: the root denied, the worktree, the checkout, the state directory and the session\'s folder read back, only the worktree and the folder written; its .env and the other jobs stay denied', async () => {
  const l = await layout('host-tmp-job');
  const denials = await pathDenials(scope(l, 'job'));
  assert.deepEqual(denials.claudeTmp.denyRead, [l.tmp]);
  assert.deepEqual(sorted(denials.claudeTmp.allowRead), sorted([l.own, l.sessionTmp, l.checkout, l.state]));
  assert.deepEqual(sorted(denials.claudeTmp.allowWrite), sorted([l.own, l.sessionTmp]));
  // The more specific denials inside the kept paths stay; the root is not one of them (the gate and
  // the test runs, which use sandbox.denyRead, keep their own empty /tmp).
  for (const path of [join(l.own, '.env'), l.sibling, join(l.state, 'jobs')]) {
    assert.ok(denials.sandbox.denyRead.includes(path), path);
  }
  assert.ok(!denials.sandbox.denyRead.includes(l.tmp));
  // Merged into a Claude session's sandbox only when given.
  const merged = withSandboxDenials(sandboxSettings({}), denials.sandbox, denials.claudeTmp)!.filesystem!;
  assert.ok(merged.denyRead!.includes(l.tmp) && merged.denyRead!.includes(join(l.own, '.env')) && merged.denyRead!.includes(l.sibling));
  assert.deepEqual([sorted(merged.allowRead!), sorted(merged.allowWrite!)], [sorted(denials.claudeTmp.allowRead), sorted(denials.claudeTmp.allowWrite)]);
  const plain = withSandboxDenials(sandboxSettings({}), denials.sandbox)!.filesystem!;
  assert.ok(!plain.denyRead!.includes(l.tmp) && plain.allowRead === undefined && plain.allowWrite === undefined);
  // A kept path gone since the denials were built is left out.
  await rm(l.sessionTmp, { recursive: true });
  assert.ok(!withSandboxDenials(sandboxSettings({}), denials.sandbox, denials.claudeTmp)!.filesystem!.allowRead!.includes(l.sessionTmp));
});

test('a Task check: its own check folder read and written, not a sibling check\'s nor the Task checks\' parent; its checkout read only', async () => {
  const l = await layout('host-tmp-check');
  const checks = await prepareTaskChecksDir(taskChecksDir(l.tmp));
  const own = join(checks, 'check-own');
  const sibling = join(checks, 'check-sibling');
  await mkdir(join(own, 'repo'), { recursive: true });
  await mkdir(join(sibling, 'repo'), { recursive: true });
  const denials = await pathDenials({ ...scope(l, 'task_check'), checkFolder: own });
  assert.deepEqual(denials.claudeTmp.denyRead, [l.tmp]);
  assert.deepEqual(sorted(denials.claudeTmp.allowRead), sorted([l.sessionTmp, own, l.checkout, l.state]));
  assert.deepEqual(sorted(denials.claudeTmp.allowWrite), sorted([l.sessionTmp, own]));
  for (const path of [sibling, checks]) {
    assert.ok(![...denials.claudeTmp.allowRead, ...denials.claudeTmp.allowWrite].some((allowed) => inTmpRoot(path, [allowed])), path);
  }
});

test('nothing kept under the temporary root: the root denied, nothing read back; a root that does not exist is left out', async () => {
  const l = await layout('host-tmp-none');
  const empty = join(l.root, 'empty-tmp');
  await mkdir(empty);
  const denials = await pathDenials({ ...scope(l, 'job'), sessionTmp: undefined, tmp: empty });
  assert.deepEqual(denials.claudeTmp, { denyRead: [empty], allowRead: [], allowWrite: [] });
  assert.deepEqual(await tmpRoots(join(l.root, 'missing'), join(l.root, 'sys')), []);
  // A root under the system's /tmp is that /tmp's; a root that is a link is denied by both spellings.
  await mkdir(join(l.root, 'sys', 'tmp', 'inner'), { recursive: true });
  assert.deepEqual(await tmpRoots(join(l.root, 'sys', 'tmp', 'inner'), join(l.root, 'sys')), [join(l.root, 'sys', 'tmp')]);
  assert.deepEqual(await claudeTmpRule([empty], [{ path: join(empty, 'gone'), write: true }, { path: l.own, write: true }]), { denyRead: [empty], allowRead: [], allowWrite: [] });
  assert.ok(inTmpRoot(join(empty, 'x'), [empty]) && !inTmpRoot(l.own, [empty]));
});

test('a test run under the same denials keeps its own writable /tmp: no /tmp, no system temporary folder hidden', async () => {
  const l = await layout('host-tmp-test-run');
  const denials = await pathDenials({ ...scope(l, 'job'), tmp: undefined, systemRoot: undefined });
  assert.ok(denials.claudeTmp.denyRead.includes('/tmp'));
  const system = await realpath(tmpdir());
  assert.ok(!denials.sandbox.denyRead.some((path) => path === '/tmp' || path === system || path === tmpdir()), denials.sandbox.denyRead.join(' '));
  const hidden = await hiddenMounts(denials.sandbox.denyRead, l.own);
  assert.ok(!hidden.some((entry) => entry.path === '/tmp' || entry.path === system));
  const args = bwrapArgs({ command: 'npm test', cwd: l.own, hidden });
  // /tmp once, as the run's own tmpfs (writable), never hidden.
  assert.deepEqual(args.flatMap((arg, index) => (arg === '/tmp' ? [args[index - 1]] : [])), ['--tmpfs']);
});

test('the file-tool guard: a read in the temporary root outside the kept paths is refused, one made after the session started too; the worktree, the session\'s folder and the state directory there pass, its specific denials still refused; the home keeps its own reason', async () => {
  const l = await layout('host-tmp-guard');
  const denials = await pathDenials(scope(l, 'job'));
  const ask = (tool: string, input: unknown): Promise<string | undefined> => guard(denials, l.own, tool, input);
  for (const input of [{ file_path: join(l.stray, 'socket-like') }, { file_path: join(l.tmp, 'claude-1000', 'tasks', 'x.output') }]) {
    const reason = await ask('Read', input);
    assert.ok(reason?.startsWith(FILE_GUARD) && reason.includes(TMP_REFUSAL), reason);
  }
  await mkdir(join(l.tmp, 'later'));
  await writeFile(join(l.tmp, 'later', 'f'), 'x');
  assert.ok((await ask('Read', { file_path: join(l.tmp, 'later', 'f') }))?.includes(TMP_REFUSAL));
  assert.ok((await ask('Glob', { pattern: '*', path: l.tmp }))?.includes(TMP_REFUSAL));
  assert.match((await ask('Grep', { pattern: 'x', path: l.root }))!, /holding /);
  // Write and Edit there get the same reason; outside the worktree elsewhere they keep theirs.
  for (const [tool, input] of [['Write', { file_path: join(l.stray, 'f'), content: 'x' }], ['Edit', { file_path: join(l.stray, 'socket-like'), old_string: 'x', new_string: 'y' }]] as const) {
    const reason = await ask(tool, input);
    assert.ok(reason?.startsWith(`${FILE_GUARD} refuses this ${tool}: `) && reason.includes(TMP_REFUSAL), reason);
  }
  assert.match((await ask('Write', { file_path: join(l.home, 'notes', 'n.md'), content: 'x' }))!, /is outside the job's worktree .*, or in its \.git\.$/);
  assert.ok(!(await ask('Edit', { file_path: join(l.own, '.git', 'config'), old_string: 'x', new_string: 'y' }))!.includes(TMP_REFUSAL));
  assert.equal(await ask('Read', { file_path: join(l.own, 'a.ts') }), undefined);
  assert.equal(await ask('Glob', { pattern: '**' }), undefined);
  assert.equal(await ask('Read', { file_path: join(l.sessionTmp, 'out.txt') }), undefined);
  assert.equal(await ask('Read', { file_path: join(l.checkout, 'README.md') }), undefined);
  // The state directory, read back by the sandbox, is kept for the tools too; its jobs/ stays denied
  // (a tool rule, which the sandbox's denyRead matches).
  assert.equal(await ask('Glob', { pattern: '*', path: l.state }), undefined);
  assert.equal(await ask('Read', { file_path: join(l.state, 'serve.log') }), undefined);
  assert.ok(denials.tools.includes(`Read(/${join(l.state, 'jobs')}/**)`) && denials.sandbox.denyRead.includes(join(l.state, 'jobs')));
  assert.match((await ask('Read', { file_path: join(l.home, 'notes', 'n.md') }))!, /is in the home directory, outside the worktree, the checkout and the toolchains\.$/);
});

test('the Task check\'s own guard: a read in a temporary root outside its checkout names the temporary folder', async () => {
  const l = await layout('host-tmp-check-guard');
  const reason = await guardReason(l.checkout, 'Read', { file_path: join(l.stray, 'socket-like') }, [l.tmp]);
  assert.match(reason!, /^The Task check may read only the repository checkout /);
  assert.ok(reason!.includes(TMP_REFUSAL), reason);
  assert.ok(!(await guardReason(l.checkout, 'Read', { file_path: join(l.home, 'notes') }, [l.tmp]))!.includes(TMP_REFUSAL));
});

test('a session\'s temporary folder: made 0700 under the given folder, removed with all in it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'sf-host-tmp-'));
  try {
    const dir = await makeSessionTmp(base);
    assert.ok(dir.startsWith(join(await realpath(base), SESSION_TMP_PREFIX)));
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    await writeFile(join(dir, 'f'), 'x');
    await removeSessionTmp(dir);
    assert.equal(existsSync(dir), false);
    await removeSessionTmp(dir);
    await removeSessionTmp(undefined);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('the folders of a killed process: swept once its pid no longer runs (at the next session too); a running one\'s, a link and other names stay', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'sf-host-tmp-')));
  try {
    const dead = spawnSync('true').pid!;
    const deadDir = join(base, `${SESSION_TMP_PREFIX}${dead}-abc`);
    const liveDir = join(base, `${SESSION_TMP_PREFIX}${process.pid}-abc`);
    for (const dir of [deadDir, liveDir, join(base, 'other')]) {
      await mkdir(join(dir, 'claude-1000'), { recursive: true, mode: 0o700 });
    }
    const link = join(base, `${SESSION_TMP_PREFIX}${dead}-link`);
    await symlink(join(base, 'other'), link);
    await sweepSessionTmps(base);
    assert.deepEqual([existsSync(deadDir), existsSync(liveDir), existsSync(join(base, 'other')), existsSync(join(link, 'claude-1000'))], [false, true, true, true]);
    await mkdir(deadDir);
    const made = await makeSessionTmp(base);
    assert.ok(made.startsWith(join(base, `${SESSION_TMP_PREFIX}${process.pid}-`)));
    assert.equal(existsSync(deadDir), false);
    await removeSessionTmp(made);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('the Implementer session: CLAUDE_CODE_TMPDIR is its own 0700 folder, the one its path denials keep, made by its first turn and kept for every later one, gone once it is closed (after a failed turn too) or dropped unclosed', async () => {
  const env = await newEnv('host-tmp-session');
  await script(env, [{}, {}]);
  const base = await realpath(await mkdtemp(join(tmpdir(), 'sf-host-tmp-')));
  const home = process.env.HOME;
  process.env.HOME = env.home;
  try {
    const given: string[] = [];
    let idle: (outcome: IdleOutcome) => void = () => undefined;
    const session = new ImplementerSession({
      cwd: env.home, maxTurns: 3, claudePath: FAKE, tmp: base, pathDenials: async (sessionTmp) => {
        given.push(sessionTmp);
        return { tools: [], sandbox: { denyRead: [], denyWrite: [] }, claudeTmp: { denyRead: [], allowRead: [sessionTmp], allowWrite: [sessionTmp] }, kept: [], hooks: undefined };
      },
    }, { message: async () => undefined, prompt: async () => undefined, idle: async (outcome) => idle(outcome) });
    for (const prompt of ['first', 'second']) {
      const done = new Promise<IdleOutcome>((resolve) => (idle = resolve));
      session.send(prompt, []);
      assert.equal((await done).ok, true);
    }
    const log = await fakeLog(env);
    assert.equal(given.length, 1);
    assert.ok(given[0]!.startsWith(join(base, SESSION_TMP_PREFIX)));
    assert.deepEqual(log.map((entry) => entry.tmpdir), [{ path: given[0], mode: 0o700 }, { path: given[0], mode: 0o700 }]);
    // Between turns the folder stays, with what Claude Code left in it, for the resumed turn.
    assert.equal(session.tmp, given[0]);
    assert.equal((await stat(given[0]!)).mode & 0o777, 0o700);
    await session.close();
    assert.equal(existsSync(given[0]!), false);
    assert.equal(session.tmp, undefined);

    // A session whose turn fails keeps its folder until it is closed.
    let made: string | undefined;
    const failed = new Promise<IdleOutcome>((resolve) => (idle = resolve));
    const broken = new ImplementerSession({
      cwd: env.home, maxTurns: 3, claudePath: FAKE, tmp: base, pathDenials: async (sessionTmp) => {
        made = sessionTmp;
        throw new Error('registry unreadable');
      },
    }, { message: async () => undefined, prompt: async () => undefined, idle: async (outcome) => idle(outcome) });
    broken.send('third', []);
    assert.equal((await failed).ok, false);
    assert.ok(made !== undefined && made.startsWith(join(base, SESSION_TMP_PREFIX)));
    assert.ok(existsSync(made));
    await broken.close();
    assert.equal(existsSync(made), false);

    // endSession from the session's own idle hook (the hand-over): the session leaves the map and
    // its folder goes at once, without waiting for the drain that waits for the hook.
    await script(env, [{}]);
    const live = new Map<string, { session: ImplementerSession }>();
    let ended: string | undefined;
    const handedOver = new Promise<void>((resolve) => (idle = () => resolve()));
    const handed = new ImplementerSession({ cwd: env.home, maxTurns: 3, claudePath: FAKE, tmp: base }, {
      message: async () => undefined, prompt: async () => undefined, idle: async (outcome) => {
        ended = handed.tmp;
        assert.ok(outcome.ok && ended !== undefined && existsSync(ended));
        await endSession(live, 'app/T-1');
        idle(outcome);
      },
    });
    live.set('app/T-1', { session: handed });
    handed.send('hand over', []);
    await handedOver;
    assert.deepEqual([live.size, existsSync(ended!), handed.tmp], [0, false, undefined]);
    await endSession(live, 'app/T-1');

    // A session dropped without close() (a job handed over or pushed): its folder goes once the
    // session is collected.
    const dropped = await droppedSessionFolder(env, base);
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    for (let tries = 0; tries < 100 && existsSync(dropped); tries += 1) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(existsSync(dropped), false);
  } finally {
    process.env.HOME = home;
    await rm(base, { recursive: true, force: true });
  }
});

// Runs one turn of a session that is then dropped, never closed; returns its temporary folder.
async function droppedSessionFolder(env: Awaited<ReturnType<typeof newEnv>>, base: string): Promise<string> {
  await script(env, [{}]);
  let idle: (outcome: IdleOutcome) => void = () => undefined;
  const done = new Promise<IdleOutcome>((resolve) => (idle = resolve));
  let session: ImplementerSession | undefined = new ImplementerSession({ cwd: env.home, maxTurns: 3, claudePath: FAKE, tmp: base }, {
    message: async () => undefined, prompt: async () => undefined, idle: async (outcome) => idle(outcome),
  });
  session.send('dropped', []);
  assert.equal((await done).ok, true);
  const dir = session.tmp!;
  assert.ok(existsSync(dir));
  session = undefined;
  return dir;
}

test('a structured session (the review): CLAUDE_CODE_TMPDIR is its own 0700 folder, built into its path denials, removed when it ends well, ends failed, or is refused', async () => {
  const env = await newEnv('host-tmp-review');
  const clean = { verdict: 'clean', summary: 'Fine.', items: [], accepted_sensitive: [] };
  await reviewScript(env, [{ output: clean }, { subtype: 'error_during_execution' }]);
  const home = process.env.HOME;
  process.env.HOME = env.home;
  try {
    const given: string[] = [];
    const options = {
      cwd: env.home, claudePath: FAKE, sandbox: undefined, model: undefined, maxTurns: 3, signal: new AbortController().signal,
      pathDenials: async (sessionTmp: string): Promise<PathDenials> => {
        given.push(sessionTmp);
        return { tools: ['Read(//nowhere)'], sandbox: { denyRead: [], denyWrite: [] }, claudeTmp: { denyRead: [], allowRead: [], allowWrite: [] }, kept: [], hooks: undefined };
      },
    };
    const first = await runReview('Review this.', options);
    assert.equal(first.ok, true, first.ok ? '' : first.message);
    assert.equal((await runReview('Review this.', options)).ok, false);
    const log = await reviewLog(env);
    assert.equal(given.length, 2);
    assert.deepEqual(log.map((entry) => entry.tmpdir), given.map((path) => ({ path, mode: 0o700 })));
    assert.ok(log.every((entry) => entry.argv.some((arg) => arg.includes('Read(//nowhere)'))));
    assert.ok(given.every((path) => path.startsWith(join(tmpdir(), SESSION_TMP_PREFIX)) || path.includes(SESSION_TMP_PREFIX)) && given.every((path) => !existsSync(path)));
    // The path denials' own error is the refusal the caller takes; the folder goes all the same.
    let refused: string | undefined;
    await assert.rejects(runReview('Review this.', { ...options, pathDenials: async (sessionTmp: string) => {
      refused = sessionTmp;
      throw Object.assign(new Error('weakened'), { code: 'user_settings_weaken_sandbox' });
    } }), (error: { code?: string }) => error.code === 'user_settings_weaken_sandbox');
    assert.ok(refused !== undefined && !existsSync(refused));
  } finally {
    process.env.HOME = home;
  }
});
