// The merge check before sf mr merge: the MR branch as origin has it, merged into its base as origin
// has it now in a temporary worktree, and the workspace's test command run there in the job's
// sandbox (the fake bubblewrap of the harness, first on PATH). First checkMerge itself on a temporary
// repository and its origin: a pass, a failure, a timeout, a conflict, a base that moves once and one
// that keeps moving, a cancelled run, no Git hook, and the worktree gone every time. Then the merge
// through Execution with the fake Git host: a pass merges the commit it tested; a failure is
// mr_check_failed and nothing is merged; a second merge during a check is refused; stop() and
// sf reset cancel a check (runner_stopping); without a test command the merge is as before.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { FactoryError } from '../src/errors.js';
import { Execution } from '../src/execution.js';
import { GIT_KILL_AFTER_MS } from '../src/git.js';
import { statusOf } from '../src/http.js';
import type { Job } from '../src/jobs.js';
import { checkMerge, type MergeCheck, MERGE_CHECK_PREFIX, type MergeCheckOptions } from '../src/merge-check.js';
import { resolveWorkspace, saveRegistry } from '../src/registry.js';
import { runnerLauncher } from '../src/runner.js';
import { startFakeForge, type FakeForge } from './support/fake-forge.js';
import { bwrapLog, type Env, FAKE, fakeBwrapBin, git, newEnv, newRepo, processEnv, temp } from './support/harness.js';

const BRANCH = 'T-1-change-readme';

interface World {
  env: Env;
  repo: string;
  bare: string;
  worktreeRoot: string;
  // A commit on origin's base from another clone: the base moves.
  moveBase: (file: string, content: string) => void;
}

// A workspace checkout with an origin whose main has README.md, and the MR branch on origin with
// feature.txt (and README.md as branchReadme, when given).
async function world(name: string, branchReadme?: string): Promise<World> {
  const env = await newEnv(name);
  // Git as the factory runs it in-process: the identity and settings of the test's HOME.
  process.env.HOME = env.home;
  // runTestCommand finds bwrap on the factory's PATH: the fake, as for sf serve in the other tests
  // (set here: the harness makes it in its own before hook).
  if (!(process.env.PATH ?? '').startsWith(`${fakeBwrapBin}${delimiter}`)) {
    process.env.PATH = `${fakeBwrapBin}${delimiter}${process.env.PATH ?? ''}`;
  }
  const repo = await newRepo(env, `${name}-repo`, true);
  const bare = join(temp, `${name}-repo-origin.git`);
  git(repo, 'checkout', '-q', '-b', BRANCH);
  await writeFile(join(repo, 'feature.txt'), 'feature\n');
  if (branchReadme !== undefined) {
    await writeFile(join(repo, 'README.md'), branchReadme);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'feat(T-1): Change the README');
  git(repo, 'push', '-q', 'origin', BRANCH);
  git(repo, 'checkout', '-q', 'main');
  const pusher = join(temp, `${name}-pusher`);
  execFileSync('git', ['clone', '-q', bare, pusher]);
  let moves = 0;
  const moveBase = (file: string, content: string): void => {
    moves += 1;
    execFileSync('sh', ['-c', `printf '%s' "$1" > "$2"`, 'sh', content, file], { cwd: pusher });
    git(pusher, 'add', file);
    git(pusher, 'commit', '-q', '-m', `chore: move ${moves}`);
    git(pusher, 'push', '-q', 'origin', 'main');
  };
  return { env, repo, bare, worktreeRoot: join(env.state, 'worktrees'), moveBase };
}

function options(w: World, command: string, extra: Partial<MergeCheckOptions> = {}): MergeCheckOptions {
  return {
    checkout: w.repo, worktreeRoot: w.worktreeRoot, workspace: 'app', ticket: 'T-1', base: 'main', branch: BRANCH, command,
    timeoutMs: 60_000, signal: new AbortController().signal, hidden: async () => [], gitLocked: (work) => work(), ...extra,
  };
}

// The check's worktrees left on disk and registered in the checkout.
async function leftovers(w: World): Promise<string[]> {
  const folder = join(w.worktreeRoot, 'app');
  const onDisk = (await readdir(folder).catch(() => [] as string[])).filter((name) => name.startsWith(MERGE_CHECK_PREFIX));
  const registered = git(w.repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.includes(MERGE_CHECK_PREFIX));
  return [...onDisk, ...registered];
}

const originMain = (w: World): string => execFileSync('git', ['--git-dir', w.bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
const originHead = (w: World): string => execFileSync('git', ['--git-dir', w.bare, 'rev-parse', BRANCH], { encoding: 'utf8' }).trim();

// The pids of the processes whose argv is exactly argv.
async function processesOf(argv: string[]): Promise<number[]> {
  const wanted = `${argv.join('\0')}\0`;
  const pids: number[] = [];
  for (const name of await readdir('/proc')) {
    if (/^\d+$/.test(name) && (await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '')) === wanted) {
      pids.push(Number(name));
    }
  }
  return pids;
}

async function until(check: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// A `sleep 60` only this test runs: 60 seconds and a fraction nobody else uses.
const slowSleep = (): string[] => ['sleep', `60.${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`];

const refusalOf = (check: MergeCheck): { code: string; message: string } | undefined =>
  check.refusal === undefined ? undefined : { code: check.refusal.code, message: check.refusal.message };

test('a passing merged result passes: the branch merged into the base as origin has it now, the tests run in the sandbox there, no hook runs, the worktree is gone', async () => {
  const w = await world('mc-pass');
  // The base moved on origin after the branch was cut: the check sees it, the checkout's main does not.
  w.moveBase('base.txt', 'base\n');
  const marker = join(temp, 'mc-pass-hook-ran');
  for (const hook of ['pre-merge-commit', 'post-merge', 'commit-msg', 'post-checkout', 'reference-transaction']) {
    await writeFile(join(w.repo, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> '${marker}'\n`);
    await chmod(join(w.repo, '.git', 'hooks', hook), 0o755);
  }
  const before = git(w.repo, 'rev-parse', 'main').trim();
  const check = await checkMerge(options(w, 'test -f feature.txt && test -f base.txt && git log -1 --format=%P HEAD > parents.txt'));
  assert.equal(refusalOf(check), undefined);
  assert.equal(check.runs.length, 1);
  assert.deepEqual([check.runs[0]!.outcome, check.runs[0]!.base_commit, check.runs[0]!.head_commit], ['passed', originMain(w), originHead(w)]);
  assert.ok(check.runs[0]!.duration_ms >= 0);
  assert.equal(await readFile(marker, 'utf8').catch(() => 'none'), 'none');
  assert.deepEqual(await leftovers(w), []);
  // Nothing of the checkout moved; the branch's head on origin is fetched as origin/<branch>.
  assert.equal(git(w.repo, 'rev-parse', 'main').trim(), before);
  assert.equal(git(w.repo, 'rev-parse', `origin/${BRANCH}`).trim(), originHead(w));
});

test('a failing run is mr_check_failed with its first lines; the worktree is gone', async () => {
  const w = await world('mc-fail');
  const check = await checkMerge(options(w, 'echo "not ok 1 - the build broke"; exit 1'));
  assert.equal(check.runs[0]!.outcome, 'failed');
  const refusal = refusalOf(check)!;
  assert.equal(refusal.code, 'mr_check_failed');
  assert.equal(refusal.message, `The change fails on main as it is now (${originMain(w).slice(0, 12)}): \`echo "not ok 1 - the build broke"; exit 1\` failed (exit 1):\nnot ok 1 - the build broke`);
  assert.equal(statusOf(refusal.code), 409);
  assert.deepEqual(await leftovers(w), []);
});

test('a run past the timeout is timed_out and refused; a sandbox that cannot be built is refused; the worktree is gone both times', async () => {
  const w = await world('mc-timeout');
  // A limit of seconds, not milliseconds: under the load of a full run the sandbox may take longer
  // than a few hundred ms to reach the echo, and a run killed before it has no output to quote.
  const timed = await checkMerge(options(w, 'echo waiting; sleep 60', { timeoutMs: 3000 }));
  assert.equal(timed.runs[0]!.outcome, 'timed_out');
  assert.ok(timed.runs[0]!.duration_ms >= 3000 && timed.runs[0]!.duration_ms < 60_000, String(timed.runs[0]!.duration_ms));
  assert.match(refusalOf(timed)!.message, /^The change fails on main as it is now \([0-9a-f]{12}\): `echo waiting; sleep 60` failed \(timed out after \d+ s\):\nwaiting$/);
  assert.deepEqual(await leftovers(w), []);
  const denied = await checkMerge(options(w, 'exit 0', { hidden: async () => Promise.reject(new FactoryError('sandbox_failed', 'the registry cannot be read')) }));
  assert.equal(denied.runs[0]!.outcome, 'failed');
  assert.match(refusalOf(denied)!.message, /: the sandbox could not be built: the registry cannot be read$/);
  assert.deepEqual(await leftovers(w), []);
});

test('a merge that conflicts is refused with the paths, and the tests do not run', async () => {
  const w = await world('mc-conflict', 'branch\n');
  w.moveBase('README.md', 'base\n');
  const marker = join(temp, 'mc-conflict-ran');
  const check = await checkMerge(options(w, `touch '${marker}'`));
  assert.equal(check.runs[0]!.outcome, 'conflict');
  assert.equal(refusalOf(check)!.message, `The change fails on main as it is now (${originMain(w).slice(0, 12)}): ${BRANCH} conflicts with it in README.md`);
  assert.equal(await readFile(marker, 'utf8').catch(() => 'none'), 'none');
  assert.deepEqual(await leftovers(w), []);
});

test('a base that moves during a passing run is checked once more; one that keeps moving is refused', async () => {
  const w = await world('mc-move');
  let calls = 0;
  const first = originMain(w);
  const once = await checkMerge(options(w, 'exit 0', {
    hidden: async () => {
      calls += 1;
      if (calls === 1) {
        w.moveBase('moved.txt', 'once\n');
      }
      return [];
    },
  }));
  assert.equal(refusalOf(once), undefined);
  assert.deepEqual(once.runs.map((run) => [run.outcome, run.base_commit]), [['passed', first], ['passed', originMain(w)]]);
  // The check as a whole, its one event: passed, on the last base, both runs' time.
  assert.deepEqual([once.outcome, once.base_commit], ['passed', originMain(w)]);
  assert.ok(once.duration_ms >= once.runs[0]!.duration_ms + once.runs[1]!.duration_ms);
  assert.notEqual(first, originMain(w));
  assert.deepEqual(await leftovers(w), []);

  let moves = 0;
  const moving = await checkMerge(options(w, 'exit 0', {
    hidden: async () => {
      moves += 1;
      w.moveBase('moved.txt', `again ${moves}\n`);
      return [];
    },
  }));
  assert.equal(moving.runs.length, 2);
  assert.deepEqual([moving.outcome, moving.base_commit], ['failed', moving.runs[1]!.base_commit]);
  assert.deepEqual(refusalOf(moving), { code: 'mr_check_failed', message: 'The change was checked, but the base main keeps moving on origin; merge again.' });
  assert.deepEqual(await leftovers(w), []);
});

test('a cancelled check kills its run, is runner_stopping and leaves no worktree; a leftover worktree of the ticket is removed first', async () => {
  const w = await world('mc-abort');
  // A check an sf serve stopped mid-run left behind.
  const stale = join(w.worktreeRoot, 'app', `${MERGE_CHECK_PREFIX}T-1-0123456789ab`);
  git(w.repo, 'worktree', 'add', '-q', '--detach', stale, 'main');
  const controller = new AbortController();
  const sleep = slowSleep();
  const running = checkMerge(options(w, sleep.join(' '), { signal: controller.signal }));
  await until(async () => (await processesOf(sleep)).length > 0, 'the test command');
  assert.equal((await readdir(join(w.worktreeRoot, 'app'))).filter((name) => name.startsWith(MERGE_CHECK_PREFIX)).length, 1);
  controller.abort();
  const check = await running;
  assert.equal(check.runs[0]!.outcome, 'aborted');
  assert.deepEqual(refusalOf(check), { code: 'runner_stopping', message: 'The merge check was cancelled; nothing was merged.' });
  assert.deepEqual(await processesOf(sleep), []);
  assert.deepEqual(await leftovers(w), []);
});

test('a worktree that cannot be removed fails a passing run and refuses the merge, after every cleanup step was tried', async () => {
  const w = await world('mc-stuck');
  // The run leaves a folder whose entries cannot be deleted: neither rm nor git worktree remove can.
  const check = await checkMerge(options(w, 'mkdir -p keep/sub && touch keep/sub/f && chmod 555 keep/sub'));
  assert.equal(check.runs[0]!.outcome, 'failed');
  assert.equal(check.outcome, 'failed');
  const refusal = refusalOf(check)!;
  assert.equal(refusal.code, 'mr_check_failed');
  assert.match(refusal.message, /^The change fails on main as it is now \([0-9a-f]{12}\): the check's worktree \S+\.merge-check-T-1-[0-9a-f]{12} could not be removed: /);
  // Left as it was: the folder is there; the test cleans it up.
  const stuck = (await leftovers(w)).filter((entry) => !entry.startsWith('worktree '));
  assert.equal(stuck.length, 1);
  const path = join(w.worktreeRoot, 'app', stuck[0]!);
  execFileSync('chmod', ['-R', 'u+w', path]);
  await rm(path, { recursive: true, force: true });
  git(w.repo, 'worktree', 'prune');
  assert.deepEqual(await leftovers(w), []);
});

// A checkout whose origin is git@github.com:acme/app.git, reached through ssh, a script: one that
// serves the bare repository, or one that hangs (a sleep only this test runs).
async function sshOrigin(w: World, name: string, hang?: string[]): Promise<void> {
  const ssh = join(temp, `${name}-ssh`);
  await writeFile(ssh, hang === undefined ? `#!/bin/sh\nexec git-upload-pack '${w.bare}'\n` : `#!/bin/sh\nexec ${hang.join(' ')}\n`);
  await chmod(ssh, 0o755);
  git(w.repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/app.git');
  git(w.repo, 'config', 'core.sshCommand', ssh);
  git(w.repo, 'config', 'ssh.variant', 'simple');
}

test('a check cancelled during its fetch ends at once: aborted, runner_stopping, no run, no Git or ssh process left', async () => {
  const w = await world('mc-fetch-abort');
  const sleep = slowSleep();
  await sshOrigin(w, 'mc-fetch-abort', sleep);
  const controller = new AbortController();
  const running = checkMerge(options(w, 'exit 0', { signal: controller.signal }));
  await until(async () => (await processesOf(sleep)).length > 0, 'the fetch');
  const cancelledAt = Date.now();
  controller.abort();
  const check = await running;
  assert.ok(Date.now() - cancelledAt < 10_000, 'the fetch was not stopped');
  assert.deepEqual([check.outcome, check.base_commit, check.runs], ['aborted', null, []]);
  assert.deepEqual(refusalOf(check), { code: 'runner_stopping', message: 'The merge check was cancelled; nothing was merged.' });
  await until(async () => (await processesOf(sleep)).length === 0, 'the ssh process to end');
  assert.deepEqual(await leftovers(w), []);
});

test('a fetch past the Git timeout is refused, and its ssh is killed with it: no process outlives the check', async () => {
  const w = await world('mc-fetch-timeout');
  const sleep = slowSleep();
  await sshOrigin(w, 'mc-fetch-timeout', sleep);
  const check = await checkMerge(options(w, 'exit 0', { gitTimeoutMs: 1000 }));
  assert.deepEqual([check.outcome, check.base_commit, check.runs], ['failed', null, []]);
  assert.deepEqual(refusalOf(check), { code: 'fetch_failed', message: 'git fetch origin did not finish within 1 s; nothing was merged.' });
  assert.ok(check.duration_ms < 10_000, String(check.duration_ms));
  assert.deepEqual(await processesOf(sleep), []);
});

test('a merge past the Git timeout is refused, and the merge driver it started is killed with it; the worktree is gone', async () => {
  const w = await world('mc-merge-timeout', 'branch\n');
  // The user's merge driver for README.md hangs: both sides changed it, so the merge runs it.
  const sleep = slowSleep();
  git(w.repo, 'config', 'merge.slow.driver', sleep.join(' '));
  w.moveBase('.gitattributes', 'README.md merge=slow\n');
  w.moveBase('README.md', 'base\n');
  const marker = join(temp, 'mc-merge-timeout-ran');
  const check = await checkMerge(options(w, `touch '${marker}'`, { gitTimeoutMs: 1000 }));
  assert.equal(check.runs[0]!.outcome, 'failed');
  assert.deepEqual(refusalOf(check), { code: 'mr_check_failed', message: `The change fails on main as it is now (${originMain(w).slice(0, 12)}): the merge did not finish within 1 s` });
  assert.equal(await readFile(marker, 'utf8').catch(() => 'none'), 'none');
  assert.deepEqual(await processesOf(sleep), []);
  assert.deepEqual(await leftovers(w), []);
});

// A smudge filter of the user's that hangs on README.md: the checkout of the check's worktree runs it.
function hangingCheckout(w: World, sleep: string[]): void {
  git(w.repo, 'config', 'filter.slow.smudge', sleep.join(' '));
  git(w.repo, 'config', 'filter.slow.clean', 'cat');
  w.moveBase('.gitattributes', 'README.md filter=slow\n');
}

test('a check cancelled while its worktree is created ends at once: aborted, the filter Git started killed, no worktree left', async () => {
  const w = await world('mc-add-abort');
  const sleep = slowSleep();
  hangingCheckout(w, sleep);
  const controller = new AbortController();
  const marker = join(temp, 'mc-add-abort-ran');
  const running = checkMerge(options(w, `touch '${marker}'`, { signal: controller.signal }));
  await until(async () => (await processesOf(sleep)).length > 0, 'the checkout of the worktree');
  const cancelledAt = Date.now();
  controller.abort();
  const check = await running;
  assert.ok(Date.now() - cancelledAt < 10_000, 'the worktree add was not stopped');
  assert.deepEqual([check.outcome, check.runs.map((run) => run.outcome)], ['aborted', ['aborted']]);
  assert.equal(refusalOf(check)!.code, 'runner_stopping');
  assert.deepEqual(await processesOf(sleep), []);
  assert.equal(await readFile(marker, 'utf8').catch(() => 'none'), 'none');
  assert.deepEqual(await leftovers(w), []);
});

test('a worktree that cannot be created within the Git timeout fails the check, with no process and no worktree left', async () => {
  const w = await world('mc-add-timeout');
  const sleep = slowSleep();
  hangingCheckout(w, sleep);
  const check = await checkMerge(options(w, 'exit 0', { gitTimeoutMs: 1000 }));
  assert.equal(check.outcome, 'failed');
  assert.match(refusalOf(check)!.message, /: the check's worktree could not be created: git worktree add did not finish within 1 s$/);
  assert.deepEqual(await processesOf(sleep), []);
  assert.deepEqual(await leftovers(w), []);
});

test('a leftover worktree of an earlier check that cannot be removed refuses the merge before anything runs', async () => {
  const w = await world('mc-leftover-stuck');
  const stale = join(w.worktreeRoot, 'app', `${MERGE_CHECK_PREFIX}T-1-aaaaaaaaaaaa`);
  await mkdir(join(stale, 'keep', 'sub'), { recursive: true });
  await writeFile(join(stale, 'keep', 'sub', 'f'), 'x');
  await chmod(join(stale, 'keep', 'sub'), 0o555);
  const marker = join(temp, 'mc-leftover-stuck-ran');
  try {
    const check = await checkMerge(options(w, `touch '${marker}'`));
    assert.deepEqual([check.outcome, check.runs], ['failed', []]);
    const refusal = refusalOf(check)!;
    assert.equal(refusal.code, 'mr_check_failed');
    assert.match(refusal.message, /^An earlier merge check of T-1 left a worktree that could not be removed \(the check's worktree \S+aaaaaaaaaaaa could not be removed: .+\); nothing was merged\.$/s);
    assert.equal(await readFile(marker, 'utf8').catch(() => 'none'), 'none');
  } finally {
    execFileSync('chmod', ['-R', 'u+w', stale]);
    await rm(stale, { recursive: true, force: true });
  }
});

test('a checkout whose worktrees cannot be listed refuses the merge: the clean-up cannot be verified', async () => {
  const w = await world('mc-no-list');
  const plain = join(temp, 'mc-no-list-plain');
  await mkdir(plain);
  const check = await checkMerge(options(w, 'exit 0', { checkout: plain }));
  assert.deepEqual([check.outcome, check.runs], ['failed', []]);
  assert.match(refusalOf(check)!.message, /^An earlier merge check of T-1 left a worktree that could not be removed \(the checkout's worktrees could not be listed: git worktree failed: .+\); nothing was merged\.$/s);
});

test('a merge whose Git ignores SIGTERM at the Git timeout gets SIGKILL after 5 s; the check fails with mr_check_failed and nothing is left', async () => {
  const w = await world('mc-merge-sigterm');
  // A fake git first on PATH: the check's `git merge` ignores SIGTERM and hangs (its sleep inherits
  // the ignored signal); every other Git call is the real one.
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = join(temp, 'mc-merge-sigterm-bin');
  await mkdir(bin);
  const sleep = slowSleep();
  await writeFile(join(bin, 'git'), [
    '#!/bin/sh',
    'for arg in "$@"; do',
    `  if [ "$arg" = --no-ff ]; then trap '' TERM; exec ${sleep.join(' ')}; fi`,
    'done',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'));
  await chmod(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
  let check: MergeCheck;
  const startedAt = Date.now();
  try {
    check = await checkMerge(options(w, 'exit 0', { gitTimeoutMs: 1000 }));
  } finally {
    process.env.PATH = path;
  }
  const took = Date.now() - startedAt;
  assert.ok(took >= 1000 + GIT_KILL_AFTER_MS && took < 1000 + GIT_KILL_AFTER_MS + 10_000, String(took));
  assert.deepEqual([check.outcome, check.runs.map((run) => run.outcome)], ['failed', ['failed']]);
  assert.deepEqual(refusalOf(check), { code: 'mr_check_failed', message: `The change fails on main as it is now (${originMain(w).slice(0, 12)}): the merge did not finish within 1 s` });
  assert.deepEqual(await processesOf(sleep), []);
  assert.deepEqual(await leftovers(w), []);
});

test('a fetch that fails is refused with its reason, the check failed without a run', async () => {
  const w = await world('mc-fetch-fail');
  const check = await checkMerge(options(w, 'exit 0', { branch: 'no-such-branch' }));
  assert.deepEqual([check.outcome, check.base_commit, check.runs], ['failed', null, []]);
  assert.deepEqual(refusalOf(check), { code: 'branch_missing', message: 'The branch no-such-branch is not on origin; nothing was merged.' });
});

// The merge through Execution: a pushed job with an open pull request on the fake GitHub, its
// checkout's origin git@github.com:acme/app.git reached through a core.sshCommand that serves the
// bare repository.
interface MergeWorld extends World {
  fake: FakeForge;
  execution: Execution;
  job: Job;
}

async function mergeWorld(name: string, command: string | undefined): Promise<MergeWorld> {
  const w = await world(name);
  await sshOrigin(w, name);
  await saveRegistry({ workspaces: { app: { read_checkout: w.repo, work_checkout: w.repo, ...(command !== undefined ? { test_command: command } : {}) } } }, w.env.config);
  const fake = await startFakeForge('github', 'acme/app');
  fake.mrs.push({
    number: 1, branch: BRANCH, base: 'main', title: 'feat(T-1): Change the README', body: 'Body.', state: 'open', draft: false,
    mergeable: true, mergeableState: 'clean', detailed: 'mergeable', merge_commit: null,
  });
  await mkdir(join(w.worktreeRoot, 'app'), { recursive: true });
  const config: Config = {
    stateDir: w.env.state, checkAfterStartMin: 15, checkAfterFixMin: 5, maxTurns: 10, turnLimitContinues: 1, maxIterations: 5, claudePath: FAKE,
    sandbox: undefined, model: undefined, worktreeRoot: w.worktreeRoot, maxJobs: 3, sensitivePaths: [],
    review: false, reviewModel: undefined, reviewMaxTurns: 60, simplify: false, taskCheckMaxTurns: 30, taskCheckAuto: false, taskCheckParallel: 1, rulesMaxBytes: 49152,
    gate: { on: false, reason: 'SF_GATE=off' }, codexModel: undefined, gateMaxRounds: 3, gateMaxTokens: 5_000_000, gateTimeoutMs: 900_000, gateLevel: 'auto', gateFullPaths: [],
    forge: { githubToken: 'github_pat_TEST', githubApi: fake.url, gitlabToken: undefined, gitlabUrl: undefined }, handoff: 'off', smokeProbeAllow: undefined,
    testTimeoutMs: 60_000,
  };
  const execution = new Execution(config, (workspace) => resolveWorkspace(workspace, w.env.config), () => {}, '', { launch: runnerLauncher(processEnv(w.env)) });
  const job: Job = {
    workspace: 'app', ticket: 'T-1', branch: BRANCH, base: 'main', continues: null, builds_on: null, builds_on_commit: null,base_commit: null, target_commit: null, worktree: null, prepared_commit: originHead(w),
    mr_attempts: 1, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'pushed', iteration: 2, session_id: null,
    mr: { host: 'github', number: 1, url: 'https://github.com/acme/app/pull/1', state: 'open' }, created_at: '2026-11-09T10:00:00.000Z', updated_at: '2026-11-09T10:05:00.000Z',
  };
  await execution.jobs.write(job);
  return { ...w, fake, execution, job };
}

const refusal = async (work: Promise<unknown>): Promise<{ code: string; message: string }> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof FactoryError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error('not refused');
};

const puts = (w: MergeWorld): unknown[] => w.fake.requests.filter((request) => request.method === 'PUT').map((request) => request.body);

async function checkedEvents(w: MergeWorld): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(w.execution.jobs.eventsPath('app', 'T-1'), 'utf8').catch(() => '');
  return text.trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line)).filter((event) => event.type === 'merge_checked');
}

test('sf mr merge after a passing check merges the commit it tested, with one merge_checked event', async () => {
  const w = await mergeWorld('mc-merge-pass', 'test -f feature.txt');
  try {
    const merged = await w.execution.mergeMergeRequest('app', 'T-1');
    assert.deepEqual([merged.state, merged.mr.state], ['pushed', 'merged']);
    assert.deepEqual(puts(w), [{ merge_method: 'merge', sha: originHead(w) }]);
    const events = await checkedEvents(w);
    assert.deepEqual(events.map((event) => [event.iteration, event.base_commit, event.outcome]), [[2, originMain(w), 'passed']]);
    assert.equal(typeof events[0]!.duration_ms, 'number');
    assert.equal((await w.execution.jobs.read('app', 'T-1'))!.mr?.state, 'merged');
    assert.deepEqual(await leftovers(w), []);
    // The run's sandbox is the job's: no network, the check's worktree its only writable folder, the
    // state directory's jobs hidden, the command last.
    const runs = await bwrapLog(w.env);
    assert.equal(runs.length, 1, JSON.stringify(runs));
    const argv = runs[0]!.argv;
    assert.deepEqual([argv.slice(0, 3), argv.at(-1)], [['--die-with-parent', '--unshare-pid', '--unshare-net'], 'test -f feature.txt']);
    const chdir = argv[argv.indexOf('--chdir') + 1]!;
    assert.match(chdir, new RegExp(`^${w.worktreeRoot}/app/\\${MERGE_CHECK_PREFIX}T-1-[0-9a-f]{12}$`));
    assert.equal(argv[argv.indexOf('--bind') + 1], chdir);
    assert.ok(argv.includes(join(w.env.state, 'jobs')), JSON.stringify(argv));
  } finally {
    await w.fake.close();
  }
});

test('sf mr merge of a continuing job runs the merge check on <continues>, the branch it pushed; its own branch is not on origin', async () => {
  const w = await mergeWorld('mc-merge-continues', 'test -f feature.txt');
  try {
    await w.execution.jobs.write({ ...w.job, branch: 'T-1-follow-up', continues: BRANCH });
    const merged = await w.execution.mergeMergeRequest('app', 'T-1');
    assert.deepEqual([merged.state, merged.mr.state], ['pushed', 'merged']);
    assert.deepEqual(puts(w), [{ merge_method: 'merge', sha: originHead(w) }]);
    assert.deepEqual((await checkedEvents(w)).map((event) => event.outcome), ['passed']);
  } finally {
    await w.fake.close();
  }
});

test('sf mr merge after a failing check is mr_check_failed: nothing is merged, the job stays pushed with its merge request open', async () => {
  const w = await mergeWorld('mc-merge-fail', 'echo broken; exit 3');
  try {
    const refused = await refusal(w.execution.mergeMergeRequest('app', 'T-1'));
    assert.deepEqual(refused, { code: 'mr_check_failed', message: `The change fails on main as it is now (${originMain(w).slice(0, 12)}): \`echo broken; exit 3\` failed (exit 3):\nbroken` });
    assert.deepEqual(puts(w), []);
    const job = (await w.execution.jobs.read('app', 'T-1'))!;
    assert.deepEqual([job.state, job.mr?.state, w.fake.mrs[0]!.state], ['pushed', 'open', 'open']);
    assert.deepEqual((await checkedEvents(w)).map((event) => event.outcome), ['failed']);
    assert.deepEqual(await leftovers(w), []);
  } finally {
    await w.fake.close();
  }
});

test('a second merge during a check is refused; stop() cancels the check: runner_stopping, nothing merged, no process, no worktree', async () => {
  const sleep = slowSleep();
  const w = await mergeWorld('mc-merge-stop', sleep.join(' '));
  try {
    const first = refusal(w.execution.mergeMergeRequest('app', 'T-1'));
    await until(async () => (await processesOf(sleep)).length > 0, 'the merge check');
    const second = await refusal(w.execution.mergeMergeRequest('app', 'T-1'));
    assert.deepEqual(second, { code: 'invalid_state', message: 'A merge check is running for app/T-1; wait for its end.' });
    await w.execution.stop();
    assert.deepEqual(await first, { code: 'runner_stopping', message: 'The merge check was cancelled; nothing was merged.' });
    assert.deepEqual(puts(w), []);
    assert.deepEqual([(await w.execution.jobs.read('app', 'T-1'))!.mr?.state, w.fake.mrs[0]!.state], ['open', 'open']);
    assert.deepEqual((await checkedEvents(w)).map((event) => event.outcome), ['aborted']);
    assert.deepEqual(await processesOf(sleep), []);
    assert.deepEqual(await leftovers(w), []);
  } finally {
    await w.fake.close();
  }
});

test('sf reset during a check cancels it: runner_stopping, nothing merged, no process, no worktree', async () => {
  const sleep = slowSleep();
  const w = await mergeWorld('mc-merge-reset', sleep.join(' '));
  try {
    const first = refusal(w.execution.mergeMergeRequest('app', 'T-1'));
    await until(async () => (await processesOf(sleep)).length > 0, 'the merge check');
    await w.execution.reset('app', 'T-1');
    assert.equal((await first).code, 'runner_stopping');
    assert.deepEqual(puts(w), []);
    assert.equal(w.fake.mrs[0]!.state, 'open');
    assert.equal(await w.execution.jobs.read('app', 'T-1'), undefined);
    assert.deepEqual(await processesOf(sleep), []);
    assert.deepEqual(await leftovers(w), []);
  } finally {
    await w.fake.close();
  }
});

test('a base that keeps moving during the check is one merge_checked event (failed, the last base) and mr_check_failed; nothing is merged', async () => {
  const pusher = join(temp, 'mc-merge-moving-pusher');
  // Each run of the tests moves origin's main: the check runs twice and refuses.
  const w = await mergeWorld('mc-merge-moving', `git -C '${pusher}' commit -q --allow-empty -m move && git -C '${pusher}' push -q origin main`);
  try {
    const refused = await refusal(w.execution.mergeMergeRequest('app', 'T-1'));
    assert.deepEqual(refused, { code: 'mr_check_failed', message: 'The change was checked, but the base main keeps moving on origin; merge again.' });
    assert.deepEqual(puts(w), []);
    assert.equal((await bwrapLog(w.env)).length, 2);
    const events = await checkedEvents(w);
    assert.equal(events.length, 1, JSON.stringify(events));
    // The last run's base: one move before origin's main now.
    assert.deepEqual([events[0]!.outcome, events[0]!.base_commit], ['failed', git(pusher, 'rev-parse', 'HEAD~1').trim()]);
    assert.deepEqual(await leftovers(w), []);
  } finally {
    await w.fake.close();
  }
});

test('stop() during the fetch of a check is runner_stopping at once, with one aborted event; nothing is merged', async () => {
  const w = await mergeWorld('mc-merge-fetch-stop', 'exit 0');
  const sleep = slowSleep();
  await sshOrigin(w, 'mc-merge-fetch-stop', sleep);
  try {
    const first = refusal(w.execution.mergeMergeRequest('app', 'T-1'));
    await until(async () => (await processesOf(sleep)).length > 0, 'the fetch');
    await w.execution.stop();
    assert.deepEqual(await first, { code: 'runner_stopping', message: 'The merge check was cancelled; nothing was merged.' });
    assert.deepEqual(puts(w), []);
    assert.deepEqual((await checkedEvents(w)).map((event) => [event.outcome, event.base_commit]), [['aborted', null]]);
    await until(async () => (await processesOf(sleep)).length === 0, 'the ssh process to end');
  } finally {
    await w.fake.close();
  }
});

test('without a test command sf mr merge merges as before: no check, no event, no head sent', async () => {
  const w = await mergeWorld('mc-merge-none', undefined);
  try {
    const merged = await w.execution.mergeMergeRequest('app', 'T-1');
    assert.equal(merged.mr.state, 'merged');
    assert.deepEqual(puts(w), [{ merge_method: 'merge' }]);
    assert.deepEqual(await checkedEvents(w), []);
    assert.equal(await readFile(join(w.env.home, 'fake-bwrap.log'), 'utf8').catch(() => 'none'), 'none');
  } finally {
    await w.fake.close();
  }
});
