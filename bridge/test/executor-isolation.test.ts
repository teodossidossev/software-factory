// SF-009 Review 01, R1-3: auto mode does not confine a session. These tests state exactly what is
// and is not enforced:
//   - the --disallowedTools rules are prefix rules that name none of the usual bypass forms;
//   - an app that is not an explicitly declared disposable pilot cannot be enabled, authorized or
//     launched (unsupported_isolation): production automatic execution is refused, not "protected";
//   - in a disposable pilot, Git bypasses (git -C . push to a remote, git -c ... commit, a shell
//     wrapper with an alias, a direct .git write) are DETECTED at the turn end and end the session
//     for inspection, but they are NOT prevented: the push reached the remote;
//   - a write to an unlisted other checkout and a credential read outside the app are neither
//     prevented nor detected. That is why only disposable pilots run.
// All repositories, remotes and "credentials" are throwaway fixtures; no network is used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { DENIED_TOOLS, managedArguments } from '../src/execution/runner.js';
import { ExecutorState } from '../src/executor/policy.js';
import { acceptedJob, destroyFixture, git, invocations, jobDir, type Fixture } from './support/operator-fixture.js';
import { authorize, createExecutorFixture, enableApp, gateway, setStreamMode, startSupervisor, streamClaude, waitFor } from './support/executor-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

const exists = (path: string) => readFile(path).then(() => true, () => false);
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

const status = (fx: Fixture, job: string, wanted: string, diagnostic?: RegExp) =>
  waitFor(async () => {
    const value = await gateway(fx).status(fx.app, job);
    return value.status === wanted && (diagnostic === undefined || diagnostic.test(`${value.job?.diagnostic?.code}`)) ? value : undefined;
  }, `${job} ${wanted}${diagnostic ? ` ${diagnostic}` : ''}`);

// The command prefixes of the Bash deny rules, e.g. "git push" for Bash(git push:*).
const denyPrefixes = DENIED_TOOLS.flatMap((rule) => {
  const match = /^Bash\((.+):\*\)$/.exec(rule);
  return match ? [match[1]!] : [];
});

test('the deny rules are command-prefix rules: none of the bypass forms starts with a denied prefix', () => {
  // A model of a prefix rule only. Claude Code may match more cleverly; this proves only that the
  // rule list itself names none of these forms, so it is not relied on as enforcement.
  const bypasses = [
    'git -C . push origin HEAD',
    'git -c user.name=x commit -am x',
    'git --git-dir=.git push',
    "sh -c 'git push'",
    'bash -lc "git commit -am x"',
    'env git push',
    '/usr/bin/git push',
    'git -c alias.ci=commit ci -am x',
    'printf x >> .git/config',
    'cat ~/.netrc',
    'echo x >> ../other-checkout/README.md',
    'node -e "require(\'child_process\').execSync(\'git push\')"',
  ];
  for (const command of bypasses) {
    assert.ok(!denyPrefixes.some((prefix) => command.startsWith(prefix)), `${command} is not named by a deny rule`);
  }
  // The file rules cover Claude's Edit/Write/Read tools only, not a shell writing the same paths.
  assert.ok(DENIED_TOOLS.includes('Write(.git/**)'));
  assert.ok(!DENIED_TOOLS.some((rule) => rule.startsWith('Bash(') && rule.includes('.git/')));
  // Native auto mode is kept; nothing bypasses permissions.
  const argv = managedArguments({ sessionId: randomUUID(), name: 'sf-x' });
  assert.deepEqual(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2), ['--permission-mode', 'auto']);
  assert.ok(!argv.some((arg) => /bypass|dangerously/.test(arg)));
});

test('an app that is not a disposable pilot is refused: not enabled, not authorized, not launched (unsupported_isolation)', async () => {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  const state = await ExecutorState.open(fx.stateHome, fx.mediator);
  assert.equal(await code(state.enable(fx.app, { executable: streamClaude(fx), version: 'fake 0.0.0' })), 'unsupported_isolation');
  assert.equal(await state.policy(), undefined, 'nothing was enabled');

  // A policy written before Review 01 has no isolation: it is treated as none.
  await enableApp(fx);
  const accepted = await acceptedJob(fx, 'job-legacy-policy');
  const auth = await authorize(fx, 'job-legacy-policy', accepted, randomUUID());
  const policyFile = join(fx.stateHome, 'software-factory', 'executor', 'policy.json');
  const policy = JSON.parse(await readFile(policyFile, 'utf8')) as { apps: Record<string, Record<string, unknown>> };
  delete policy.apps[fx.app]!.isolation;
  await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
  const running = await startSupervisor(fx);
  cleanup.push(running.stop);
  await status(fx, 'job-legacy-policy', 'blocked', /unsupported_isolation/);
  assert.equal((await invocations(fx)).length, 0);
  assert.equal(await exists(join(fx.stateHome, 'software-factory', 'executor', 'consumed', auth.authorization_id)), false, 'nothing consumed');
  assert.equal(await exists(join(jobDir(fx, 'job-legacy-policy'), 'launch.claim')), false);

  // And the bridge refuses to authorize when the published view says isolation none.
  const viewFile = join(fx.mediator, 'factory-data', 'apps', fx.app, 'executor-policy.json');
  const view = JSON.parse(await readFile(viewFile, 'utf8')) as Record<string, unknown>;
  await writeFile(viewFile, JSON.stringify({ ...view, isolation: 'none' }), { mode: 0o600 });
  const second = await acceptedJob(fx, 'job-production');
  const shown = await gateway(fx).status(fx.app, 'job-production');
  assert.equal(shown.policy?.isolation, 'none');
  await assert.rejects(authorize(fx, 'job-production', second, randomUUID()), (error: { message: string }) => /unsupported_isolation/.test(error.message));
  assert.equal(await exists(join(jobDir(fx, 'job-production'), 'authorization.json')), false);
});

// A disposable pilot launched with one shell command run during the first turn.
async function pilot(shell: (fx: Fixture) => string, prepare?: (fx: Fixture) => Promise<void>): Promise<{ fx: Fixture; job: string }> {
  const fx = await createExecutorFixture();
  cleanup.push(() => destroyFixture(fx));
  await prepare?.(fx);
  await enableApp(fx);
  await setStreamMode(fx, 'ok', { shell: shell(fx) });
  const job = 'job-pilot';
  const accepted = await acceptedJob(fx, job);
  const running = await startSupervisor(fx);
  cleanup.push(running.stop);
  await authorize(fx, job, accepted, randomUUID());
  return { fx, job };
}

test('pilot: git -C . push to a remote is detected at the turn end, but not prevented', async () => {
  const { fx, job } = await pilot(
    () => 'git -C . push -q origin HEAD:refs/heads/pushed',
    async (fx) => {
      const remote = join(fx.sandbox, 'remote.git');
      git(fx.sandbox, 'init', '-q', '--bare', remote);
      git(fx.appRepo, 'remote', 'add', 'origin', remote);
    },
  );
  const ended = await status(fx, job, 'needs_inspection', /git_operation_detected/);
  assert.equal(ended.policy?.isolation, 'disposable_pilot');
  assert.equal(ended.job?.iterations[0]?.snapshot_sha256, null, 'nothing published');
  // The remote received the push: detection after the fact is not prevention.
  assert.match(git(join(fx.sandbox, 'remote.git'), 'rev-parse', 'refs/heads/pushed'), /^[0-9a-f]{40}/);
});

test('pilot: git -c ... commit is detected at the turn end', async () => {
  const { fx, job } = await pilot(() => 'git -c user.name=t -c user.email=t@example.invalid commit -qam bypass');
  await status(fx, job, 'needs_inspection', /git_operation_detected/);
});

test('pilot: a shell wrapper with a Git alias is detected at the turn end', async () => {
  const { fx, job } = await pilot(() => `sh -c 'git -c alias.ci=commit -c user.name=t -c user.email=t@example.invalid ci -qam wrapped'`);
  await status(fx, job, 'needs_inspection', /git_operation_detected/);
});

test('pilot: a direct write to .git is detected at the turn end', async () => {
  const { fx, job } = await pilot(() => "printf '[sf]\\n\\tplanted = 1\\n' >> .git/config");
  await status(fx, job, 'needs_inspection', /git_operation_detected/);
  assert.match(await readFile(join(fx.appRepo, '.git', 'config'), 'utf8'), /planted = 1/, 'not prevented');
});

test('pilot: a write to an unlisted other checkout and a credential read and write outside the app are neither prevented nor detected', async () => {
  const { fx, job } = await pilot(
    (fx) =>
      `cat ${join(fx.sandbox, 'credentials', 'fixture-token')} > /dev/null && echo planted >> ${join(fx.sandbox, 'credentials', 'fixture-token')} && echo touched >> ${join(fx.sandbox, 'other-checkout', 'README.md')}`,
    async (fx) => {
      await mkdir(join(fx.sandbox, 'credentials'), { mode: 0o700 });
      await writeFile(join(fx.sandbox, 'credentials', 'fixture-token'), 'fixture-only\n', { mode: 0o600 });
      await mkdir(join(fx.sandbox, 'other-checkout'));
      await writeFile(join(fx.sandbox, 'other-checkout', 'README.md'), '# Other\n');
    },
  );
  const ready = await status(fx, job, 'awaiting_review');
  assert.equal(ready.policy?.isolation, 'disposable_pilot');
  assert.match(await readFile(join(fx.sandbox, 'other-checkout', 'README.md'), 'utf8'), /touched/);
  assert.match(await readFile(join(fx.sandbox, 'credentials', 'fixture-token'), 'utf8'), /planted/);
});
