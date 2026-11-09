// End-to-end tests of `sf smoke` (SF-090), split from test/live-smoke.test.ts (SF-152: one file ran
// near run-tests' per-file limit): the time budget, the signals and the halts that end whole process
// groups, ProcessGroups and trackRunnerLock, the usage errors, the child environment and the
// redaction of its settings. The shared helpers are test/support/live-smoke.ts's.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { childEnv, PASSED_SETTINGS, positiveDecimal, probeCommand, ProcessGroups, runSmoke, smokePaths, smokeProbe, STEPS, terminate, trackRunnerLock } from '../src/live-smoke.js';
import { Redactor } from '../src/redact.js';
import { codexScript, FAKE, fakeCodex, git, newEnv, processEnv, reviewScript, script, temp } from './support/harness.js';
import { BRANCH, CHECK_READY, CLAUDE_CLEAN, CLEAN_TURNS, onlyChecksDir, processesOf, smoke, statuses, untouched } from './support/live-smoke.js';

// The time budget of the tests that halt a step on it: the steps before that step (Setup alone in
// two of them) must fit in it under the whole suite's load, where Setup has taken over 6 s; the
// halted step's fake answers only after a minute.
const HALT_BUDGET_MIN = '0.5';

test('a time budget of a fraction of a minute with a slow turn: the step running FAILs with "time budget", the rest SKIP, the job aborted, cleanup done', async () => {
  const ran = await smoke('smoke-time', ['--timeout-min', HALT_BUDGET_MIN, '--keep'], async (env) => {
    await script(env, [{ ...CLEAN_TURNS[0], delayMs: 60_000 }]);
    await reviewScript(env, [{ output: CHECK_READY }]);
  });
  try {
    assert.equal(ran.code, 1, ran.stdout + ran.stderr);
    assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
    assert.equal(ran.rows.get('Implementer turn')!.detail, 'time budget');
    assert.match(ran.stdout, /\njob aborted \(sf abort smoke SMOKE-1\)\n/);
    assert.match(ran.rows.get('Cleanup')!.detail, /^job reset, sf serve stopped, kept /);
    // What the factory wrote: the job aborted (then archived by the reset), never pushed.
    const archived = (await readdir(join(ran.dir, 'state', 'jobs', 'smoke'))).filter((name) => name.startsWith('SMOKE-1.'));
    assert.equal(archived.length, 1);
    const job = JSON.parse(await readFile(join(ran.dir, 'state', 'jobs', 'smoke', archived[0]!, 'job.json'), 'utf8')) as { state: string };
    assert.equal(job.state, 'aborted');
    assert.equal(git(join(ran.dir, 'origin.git'), 'branch', '--list', BRANCH).trim(), '');
    assert.deepEqual(await processesOf(ran.env.home), []);
    await untouched(ran);
  } finally {
    await rm(ran.dir, { recursive: true, force: true });
  }
});

test('a halt during sf check-task ends its whole process group: the Task check\'s Claude Code does not outlive the stopped sf, nothing of the run is left', async () => {
  const ran = await smoke('smoke-group', ['--timeout-min', HALT_BUDGET_MIN], async (env) => {
    // The check's session would answer only after a minute, and lingers that long once its sf is gone.
    await reviewScript(env, [{ output: CHECK_READY, delayMs: 60_000 }]);
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Task check')!.detail, 'time budget');
  // The fake review started (it counts its run first) and was ended with the group.
  assert.equal(await readFile(join(ran.env.home, 'fake-review.count'), 'utf8'), '1');
  assert.deepEqual(await processesOf(ran.env.home), []);
  await onlyChecksDir(ran.tmp);
});

test('a halt waits for the running child sf command\'s whole group, SIGKILL included, before the step ends and the job would be aborted', async () => {
  const ran = await smoke('smoke-stubborn', ['--timeout-min', HALT_BUDGET_MIN], async (env) => {
    // Claude Code that leaves a process ignoring SIGTERM in the group of sf check-task: only the
    // SIGKILL after 15 s ends it.
    const wrapper = join(env.home, 'stubborn-claude');
    await writeFile(wrapper, `#!/bin/sh\nsh -c 'trap "" TERM; while :; do sleep 1; done' &\nexec '${process.execPath}' '${FAKE}' "$@"\n`);
    await chmod(wrapper, 0o755);
    await reviewScript(env, [{ output: CHECK_READY, delayMs: 60_000 }]);
  }, {}, undefined, (env) => ({ SF_CLAUDE: join(env.home, 'stubborn-claude') }));
  try {
    assert.equal(ran.code, 1, ran.stdout + ran.stderr);
    assert.deepEqual(statuses(ran), ['PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
    assert.equal(ran.rows.get('Task check')!.detail, 'time budget');
    // The group was stopped, SIGKILL after 15 s included, before the step's row: the step took the
    // budget's rest plus the escalation.
    assert.match(ran.stdout, /\nstopped sf check-task and its process group\nTask check: FAIL \((\d+\.\d) s\) time budget\n/);
    const seconds = Number(/\nTask check: FAIL \((\d+\.\d) s\)/.exec(ran.stdout)![1]);
    assert.ok(seconds >= 15, `the step ended after ${seconds} s, before the SIGKILL`);
    assert.deepEqual(await processesOf(ran.env.home), []);
    await onlyChecksDir(ran.tmp);
  } finally {
    // Never leave the stubborn loop behind, even when an assertion failed.
    for (const line of await processesOf(ran.env.home)) {
      process.kill(Number(line.split(':')[0]), 'SIGKILL');
    }
  }
});

test('SIGTERM during the run: the step running FAILs with "interrupted (SIGTERM)", the job aborted, sf serve stopped, the directory removed, exit 1', async () => {
  let sent = false;
  const ran = await smoke('smoke-signal', [], async (env) => {
    await script(env, [{ ...CLEAN_TURNS[0], delayMs: 60_000 }]);
    await reviewScript(env, [{ output: CHECK_READY }]);
  }, {}, (text, child) => {
    if (!sent && /^Start: PASS/m.test(text)) {
      sent = true;
      child.kill('SIGTERM');
    }
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Implementer turn')!.detail, 'interrupted (SIGTERM)');
  assert.match(ran.stdout, /\njob aborted \(sf abort smoke SMOKE-1\)\n/);
  assert.equal(ran.rows.get('Cleanup')!.detail, 'job reset, sf serve stopped, directory removed');
  assert.deepEqual(await processesOf(ran.env.home), []);
  await onlyChecksDir(ran.tmp);
  await untouched(ran);
});

test('a signal in Cleanup: the active job is aborted before its reset, Cleanup goes on to its end, exit 1', async () => {
  let sent = false;
  const ran = await smoke('smoke-cleanup-signal', ['--keep'], async (env) => {
    await script(env, CLEAN_TURNS);
    // The review fails: the job waits in needs_human, active, when Cleanup starts.
    await reviewScript(env, [{ output: CHECK_READY }, { noOutput: true }, { noOutput: true }]);
  }, {}, (text, child) => {
    // The last step's row is printed just before Cleanup starts, in the same tick.
    if (!sent && /^Dashboard: SKIP/m.test(text)) {
      sent = true;
      child.kill('SIGTERM');
    }
  });
  try {
    assert.equal(ran.code, 1, ran.stdout + ran.stderr);
    assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
    assert.match(ran.rows.get('Claude review')!.detail, /review_failed/);
    // The signal came after the steps: the job aborted in Cleanup, then reset.
    assert.match(ran.stdout, /^Dashboard: SKIP[^\n]*\njob aborted \(sf abort smoke SMOKE-1\)\nCleanup: PASS/m);
    assert.match(ran.rows.get('Cleanup')!.detail, /^job reset, sf serve stopped, kept /);
    const archived = (await readdir(join(ran.dir, 'state', 'jobs', 'smoke'))).filter((name) => name.startsWith('SMOKE-1.'));
    const job = JSON.parse(await readFile(join(ran.dir, 'state', 'jobs', 'smoke', archived[0]!, 'job.json'), 'utf8')) as { state: string };
    assert.equal(job.state, 'aborted');
    assert.deepEqual(await processesOf(ran.env.home), []);
  } finally {
    await rm(ran.dir, { recursive: true, force: true });
  }
});

test('the first signal while Cleanup\'s sf reset runs: the job was aborted before the reset (sf serve runs a reset it was asked for to its end), exit 1', async () => {
  let sent = false;
  const ran = await smoke('smoke-reset-signal', ['--keep'], async (env) => {
    await script(env, CLEAN_TURNS);
    // The review fails: the job waits in needs_human, active, when Cleanup starts.
    await reviewScript(env, [{ output: CHECK_READY }, { noOutput: true }, { noOutput: true }]);
  }, {}, (text, child) => {
    // Cleanup prints the abort's line and starts its sf reset in the same tick (live-smoke.ts,
    // cleanup), and stdout to a pipe is written at once: the smoke's signal handler, which runs in a
    // later tick, finds the reset already started as its running child sf command. The test waits
    // for that line, an event, instead of scanning /proc for the short-lived sf reset.
    if (!sent && /^Dashboard: SKIP[^\n]*\njob aborted \(sf abort smoke SMOKE-1\)\n/m.test(text)) {
      sent = true;
      child.kill('SIGTERM');
    }
  });
  try {
    assert.equal(sent, true, `Cleanup's abort line was never seen:\n${ran.stdout}`);
    assert.equal(ran.code, 1, ran.stdout + ran.stderr);
    assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
    assert.match(ran.stdout, /^Dashboard: SKIP[^\n]*\njob aborted \(sf abort smoke SMOKE-1\)\nCleanup: PASS/m);
    assert.match(ran.rows.get('Cleanup')!.detail, /^job reset, sf serve stopped, kept /);
    const archived = (await readdir(join(ran.dir, 'state', 'jobs', 'smoke'))).filter((name) => name.startsWith('SMOKE-1.'));
    assert.equal(archived.length, 1);
    const job = JSON.parse(await readFile(join(ran.dir, 'state', 'jobs', 'smoke', archived[0]!, 'job.json'), 'utf8')) as { state: string };
    assert.equal(job.state, 'aborted');
    assert.deepEqual(await processesOf(ran.env.home), []);
  } finally {
    await rm(ran.dir, { recursive: true, force: true });
  }
});

// A detached sleeper (its own process group), for the ProcessGroups tests.
function sleeper(command = 'sleep 30'): ChildProcess {
  return spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' });
}

const exited = (child: ChildProcess): Promise<void> => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve())));
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('ProcessGroups: a group never seen, or one whose id now names other processes (a reused pid), is never signalled', async () => {
  const unrelated = sleeper();
  const reused = sleeper();
  try {
    const groups = new ProcessGroups();
    await groups.end(unrelated.pid!, 100);
    // The id is tracked, but what it names now is not the process seen (another start time).
    groups.track(reused.pid!, '1');
    assert.equal(groups.owned(reused.pid!), false);
    assert.deepEqual(groups.ids(), []);
    await groups.end(reused.pid!, 100);
    assert.equal(isAlive(unrelated.pid!), true);
    assert.equal(isAlive(reused.pid!), true);
  } finally {
    unrelated.kill('SIGKILL');
    reused.kill('SIGKILL');
  }
});

test('ProcessGroups: a group that ended is forgotten, so its id is never signalled again; one left with orphans is ended whole', async () => {
  const groups = new ProcessGroups();
  const short = sleeper('true');
  groups.track(short.pid!);
  await exited(short);
  groups.observe();
  assert.deepEqual(groups.ids(), []);

  // The leader starts a grandchild and is killed alone: the orphan keeps the group, which is still the run's.
  const leader = sleeper('sleep 30 & wait');
  groups.track(leader.pid!);
  await new Promise((resolve) => setTimeout(resolve, 200));
  groups.observe();
  const orphanGroup = leader.pid!;
  leader.kill('SIGKILL');
  await exited(leader);
  assert.equal(groups.owned(orphanGroup), true);
  assert.doesNotThrow(() => process.kill(-orphanGroup, 0));
  await groups.end(orphanGroup, 100);
  assert.equal(groups.owned(orphanGroup), false);
  assert.throws(() => process.kill(-orphanGroup, 0), { code: 'ESRCH' });

  // terminate: a live child and its group end together.
  const child = sleeper('sleep 30 & wait');
  groups.track(child.pid!);
  await terminate(child, groups, 100);
  assert.throws(() => process.kill(-child.pid!, 0), { code: 'ESRCH' });
});

// The start time of a live process (field 22 of /proc/<pid>/stat), as src/pid-lock.ts writes it.
async function startOf(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
}

test('trackRunnerLock: a runner is tracked by the identity its lock holds; a pid reused since then (another start time) is never taken for it nor signalled', async () => {
  const lockDir = join(temp, 'runner-locks');
  await mkdir(lockDir, { recursive: true });
  const reused = sleeper();
  const runner = sleeper();
  try {
    const groups = new ProcessGroups();
    // The lock names the runner that held this pid before; the pid is another process's now.
    const stale = join(lockDir, 'stale.pid');
    await writeFile(stale, `${reused.pid!} 1\n`);
    await trackRunnerLock(groups, stale);
    assert.equal(groups.owned(reused.pid!), false);
    await groups.end(reused.pid!, 100);
    assert.equal(isAlive(reused.pid!), true);

    // A lock without a start time, or with no pid, tracks nothing.
    const bare = join(lockDir, 'bare.pid');
    await writeFile(bare, `${reused.pid!}\n`);
    await trackRunnerLock(groups, bare);
    await writeFile(bare, 'nonsense\n');
    await trackRunnerLock(groups, bare);
    await trackRunnerLock(groups, join(lockDir, 'missing.pid'));
    assert.deepEqual(groups.ids(), []);

    // The lock of the live runner: its group is the run's and ends.
    const live = join(lockDir, 'live.pid');
    await writeFile(live, `${runner.pid!} ${await startOf(runner.pid!)}\n`);
    await trackRunnerLock(groups, live);
    assert.equal(groups.owned(runner.pid!), true);
    await groups.end(runner.pid!, 100);
    assert.throws(() => process.kill(-runner.pid!, 0), { code: 'ESRCH' });
    assert.equal(isAlive(reused.pid!), true);
  } finally {
    reused.kill('SIGKILL');
    runner.kill('SIGKILL');
  }
});

test('a budget exceeded after the monitor\'s last poll still fails the run: the check before the next step catches it', async () => {
  const env = await newEnv('smoke-unpolled');
  const tmp = join(temp, 'smoke-unpolled', 'tmp');
  await mkdir(tmp, { recursive: true });
  // The review ends (and its cost lands) only after the Claude review step has started: the steps
  // before it (Gate sandbox, SF-125) take time of their own.
  await script(env, CLEAN_TURNS);
  await reviewScript(env, [{ output: CHECK_READY }, { output: CLAUDE_CLEAN, delayMs: 3000 }]);
  await codexScript(env, [{}]);
  // runSmoke in this process, with the children's environment as sf smoke would give it.
  const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SF_CLAUDE: process.env.SF_CLAUDE, SF_CODEX: process.env.SF_CODEX, SF_GATE: process.env.SF_GATE, PATH: process.env.PATH };
  // The fake bwrap first on PATH (SF-125), as the harness gives every sf process.
  Object.assign(process.env, { HOME: env.home, TMPDIR: tmp, SF_CLAUDE: FAKE, SF_CODEX: fakeCodex, SF_GATE: 'codex', PATH: processEnv(env).PATH });
  const lines: string[] = [];
  let code: number;
  try {
    // The Task check (0.0456) and iteration 1 (0.0123) stay within 0.08 USD; the review's 0.0456 goes
    // over it. The monitor never polls (an hour): only the checks around the steps can see it.
    code = await runSmoke({ keep: false, timeoutMin: 20, budgetUsd: 0.08, monitorMs: 3_600_000 }, (line) => lines.push(line));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
  const output = lines.join('\n');
  assert.equal(code, 1, output);
  const status = (step: string): string | undefined => new RegExp(`^${step}: (PASS|FAIL|SKIP)`, 'm').exec(output)?.[1];
  assert.deepEqual(STEPS.map(status), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'PASS'], output);
  assert.match(output, /^Codex gate: FAIL \(0\.0 s\) cost budget$/m);
  assert.match(output, /^job aborted \(sf abort smoke SMOKE-1\)$/m);
  assert.match(output, /^smoke: FAIL \(1 of 12 steps\), cost 0\.1035 USD/m);
  await onlyChecksDir(tmp);
});

test('a signal while the temporary directory is being made: the run still ends through Cleanup, the directory removed, exit 1', async () => {
  const tmp = join(temp, 'smoke-early-signal', 'tmp');
  await mkdir(tmp, { recursive: true });
  // Never a real Claude Code or Codex, and a short time budget, should the signal not stop the run.
  const saved = { TMPDIR: process.env.TMPDIR, SF_CLAUDE: process.env.SF_CLAUDE, SF_GATE: process.env.SF_GATE };
  Object.assign(process.env, { TMPDIR: tmp, SF_CLAUDE: '/bin/false', SF_GATE: 'off' });
  const lines: string[] = [];
  let code: number;
  const before = process.listeners('SIGTERM');
  try {
    // runSmoke runs up to its first await (making the directory) before this line goes on: the
    // signal comes in that window, through the handler it installed.
    const running = runSmoke({ keep: false, timeoutMin: 0.05, budgetUsd: 2 }, (line) => lines.push(line));
    const added = process.listeners('SIGTERM').filter((listener) => !before.includes(listener));
    assert.equal(added.length, 1, 'no SIGTERM handler before the directory is made');
    (added[0] as (signal: NodeJS.Signals) => void)('SIGTERM');
    code = await running;
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
  const output = lines.join('\n');
  assert.equal(code, 1, output);
  assert.match(lines[0]!, /\/sf-smoke-[^/]+$/);
  assert.match(output, /^Setup: FAIL \(0\.0 s\) interrupted \(SIGTERM\)$/m);
  assert.match(output, /^Cleanup: PASS \(\d+\.\d s\) no job to reset, directory removed$/m);
  assert.match(output, /^smoke: FAIL \(1 of 12 steps\)/m);
  await onlyChecksDir(tmp);
  // Its handlers are gone with the run.
  assert.deepEqual(process.listeners('SIGTERM'), before);
});

test('usage errors exit 2: an unknown option, a positional argument, a budget that is not a positive number', async () => {
  for (const args of [['--fast'], ['now'], ['--timeout-min', '0'], ['--timeout-min', 'ten'], ['--budget-usd', '-1'], ['--budget-usd=1e3'], ['--timeout-min']]) {
    const ran = await smoke(`smoke-usage-${args.join('').replace(/\W/g, '')}`, args, async () => undefined);
    assert.equal(ran.code, 2, `${args.join(' ')}: ${ran.stdout}${ran.stderr}`);
    assert.match(ran.stderr, /^sf: /);
    // Nothing was made.
    assert.deepEqual(await readdir(ran.tmp), []);
  }
  assert.deepEqual(['12', '0.05', '.5', '3.'].map(positiveDecimal), [12, 0.05, 0.5, 3]);
  assert.deepEqual(['0', '0.0', '-1', '1e3', '', 'x', '1.2.3'].map(positiveDecimal), [undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
});

test('the child environment: the user\'s SF_* settings dropped but the factory\'s executables, gate and sandbox; the smoke\'s directories, ports, models and limits on top, SF_CLAUDE_REVIEW=always among them (SF-131)', () => {
  const paths = smokePaths('/tmp/sf-smoke-x');
  const env = childEnv({
    PATH: '/bin', HOME: '/home/u', OPENAI_API_KEY: 'k',
    SF_CLAUDE: '/c', SF_CODEX: '/x', SF_GATE: 'codex', SF_SANDBOX: 'off', SF_SANDBOX_DOMAINS: 'a.org', SF_GATE_TIMEOUT_MS: '5',
    SF_STATE_DIR: '/mine', SF_CONFIG_DIR: '/mine/c', SF_NTFY_URL: 'u', SF_NTFY_TOKEN: 't', SF_GITHUB_TOKEN: 'g', SF_GITLAB_TOKEN: 'l', SF_GITLAB_URL: 'h',
    SF_TEST_HOOKS: 'on', SF_SENSITIVE_PATHS: 'x', SF_HANDBOOK: '/h', SF_MAX_JOBS: '9', SF_TASK_CHECK_AUTO: 'off', SF_SMOKE_CODEX_MODEL: 'gpt-mini',
  }, paths);
  assert.deepEqual(env, {
    PATH: '/bin', HOME: '/home/u', OPENAI_API_KEY: 'k',
    SF_CLAUDE: '/c', SF_CODEX: '/x', SF_GATE: 'codex', SF_SANDBOX: 'off', SF_SANDBOX_DOMAINS: 'a.org', SF_GATE_TIMEOUT_MS: '5',
    SF_STATE_DIR: '/tmp/sf-smoke-x/state', SF_CONFIG_DIR: '/tmp/sf-smoke-x/config', SF_WORKTREE_ROOT: '/tmp/sf-smoke-x/worktrees',
    SF_PORT: '0', SF_DASHBOARD_PORT: '0', SF_HANDOFF: 'off', SF_SIMPLIFY: 'off', SF_DESKTOP_NOTIFY: 'off', SF_REVIEW: 'on', SF_CLAUDE_REVIEW: 'always', SF_DASHBOARD: 'on',
    SF_ENV_FILE: '/tmp/sf-smoke-x/empty.env', SF_MODEL: 'haiku', SF_REVIEW_MODEL: 'haiku', SF_CODEX_MODEL: 'gpt-mini',
    SF_MAX_TURNS: '40', SF_REVIEW_MAX_TURNS: '30', SF_TASK_CHECK_MAX_TURNS: '30', SF_MAX_ITERATIONS: '2', SF_GATE_MAX_ROUNDS: '1', SF_GATE_MAX_TOKENS: '400000',
  });
  assert.deepEqual([...PASSED_SETTINGS].sort(), ['SF_CLAUDE', 'SF_CODEX', 'SF_GATE', 'SF_GATE_TIMEOUT_MS', 'SF_SANDBOX', 'SF_SANDBOX_DOMAINS']);
  // SF_SMOKE_MODEL picks the Claude model; without SF_SMOKE_CODEX_MODEL Codex keeps its default.
  const own = childEnv({ SF_SMOKE_MODEL: 'sonnet', SF_CODEX_MODEL: 'big' }, paths);
  assert.deepEqual([own.SF_MODEL, own.SF_REVIEW_MODEL, own.SF_CODEX_MODEL], ['sonnet', 'sonnet', undefined]);
  // SF-104: with the run's probe, SF_SMOKE_PROBE_ALLOW is its command; without one (or the user's
  // own value) it is absent.
  assert.equal('SF_SMOKE_PROBE_ALLOW' in childEnv({ SF_SMOKE_PROBE_ALLOW: 'rm -rf ~' }, paths), false);
  const probe = smokeProbe(paths, 'ab'.repeat(32), undefined);
  assert.deepEqual(childEnv({ SF_SMOKE_PROBE_ALLOW: 'rm -rf ~' }, paths, probe), { ...childEnv({}, paths), SF_SMOKE_PROBE_ALLOW: probeCommand(probe) });
});

test('SF_SMOKE_MODEL and SF_SMOKE_CODEX_MODEL are public settings: their model names are never redacted from prose', () => {
  const redactor = new Redactor({ cwd: '/work', env: { SF_SMOKE_MODEL: 'haiku', SF_SMOKE_CODEX_MODEL: 'gpt-mini', OTHER: 'secret-value' }, home: '/home/u' });
  assert.equal(redactor.text('haiku and gpt-mini, not secret-value'), 'haiku and gpt-mini, not [redacted:OTHER]');
});
