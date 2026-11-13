// End-to-end tests of `sf smoke` (SF-090) with the harness's fake Claude Code (SF_CLAUDE) and fake
// Codex (SF_CODEX, SF_GATE=codex over the harness's off), a TMPDIR the test owns and the test's own
// SF_STATE_DIR and SF_CONFIG_DIR (with an env file holding a Git host token), which the smoke must
// leave untouched: the steps of a run. Split so that no file runs near run-tests' per-file limit:
// the time budget, the signals, the process groups, the child environment, the option parsing and
// the redaction of its settings are test/live-smoke-halt.test.ts's (SF-152); the Sandbox step's
// checks test/live-smoke-sandbox.test.ts's; the Gate sandbox step (SF-125), its socket probe
// (SF-161) and SF_SANDBOX=off test/live-smoke-gate.test.ts's.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { smokePaths, smokeProbe, smokeTask, STEPS } from '../src/live-smoke.js';
import { PROBE_SCRIPT, PROBES, probeCommand } from '../src/smoke-probe.js';
import { codexLog, codexScript, fakeLog, git, reviewLog, reviewScript, script } from './support/harness.js';
import { BRANCH, CHECK_READY, CLEAN_TURNS, cleanScripts, onlyChecksDir, probeOutput, smoke, statuses, untouched } from './support/live-smoke.js';

test('a clean run: every step PASS, exit 0, the temp directory gone, the user\'s state and config untouched; the children ran in the smoke\'s directories without the user\'s SF_* settings', async () => {
  const ran = await smoke('smoke-clean', [], cleanScripts);
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), STEPS.map(() => 'PASS'), ran.stdout);
  assert.match(ran.dir, /\/sf-smoke-[^/]+$/);
  assert.ok(ran.dir.startsWith(ran.tmp), ran.dir);
  assert.match(ran.stdout, /\nsmoke: PASS, cost \d+\.\d{4} USD, gate 1100 tokens\n$/);
  assert.match(ran.rows.get('Task check')!.detail, /^verdict ready/);
  assert.equal(ran.rows.get('Sandbox')!.detail, `every probe refused (${PROBES.length}), only the allowed tools, the Write outside the worktree refused`);
  assert.equal(ran.rows.get('Gate sandbox')!.detail, 'the canary env file and jobs/ hidden inside the gate\'s wrapper; Unix sockets refused');
  assert.match(ran.rows.get('Codex gate')!.detail, /clean, 1100 tokens/);
  assert.match(ran.rows.get('MR text')!.detail, /^feat\(SMOKE-1\): Add a second greeting line$/);
  assert.match(ran.rows.get('Approve')!.detail, new RegExp(`^${BRANCH} at [0-9a-f]{12} on origin\\.git$`));
  // SF-126: sf serve prints the dashboard with <token>; the smoke builds the URL from the printed
  // port and the token file of its state directory, so the Dashboard step reads every page with it.
  assert.match(ran.rows.get('Setup')!.detail, /^sf serve ready, dashboard on port \d+$/);
  assert.match(ran.rows.get('Dashboard')!.detail, /^7 answers: the page and 6 API$/);
  // The table: a header and one row per step.
  assert.match(ran.stdout, /\nSTEP +RESULT +SECONDS +DETAIL\n/);
  await onlyChecksDir(ran.tmp);
  await untouched(ran);

  // The child environment: the smoke's directories (the job's worktree under its SF_WORKTREE_ROOT,
  // its state in SF_STATE_DIR: the user's is untouched above), its model, and none of the user's
  // SF_* settings, from the user's environment or the env file. (The factory gives Claude Code
  // only a few variables of its own environment, so the fakes log no SF_STATE_DIR either way.)
  const implementer = await fakeLog(ran.env);
  const reviews = await reviewLog(ran.env);
  const gate = await codexLog(ran.env);
  assert.equal(implementer.length, 2);
  assert.equal(reviews.length, 2);
  assert.equal(gate.length, 1);
  for (const entry of [...implementer, ...reviews, ...gate]) {
    for (const name of ['SF_NTFY_URL', 'SF_NTFY_TOKEN', 'SF_GITHUB_TOKEN', 'SF_TEST_HOOKS']) {
      assert.equal(entry.env.includes(name), false, `${name} reached the child`);
    }
  }
  for (const entry of [...implementer, ...reviews]) {
    assert.ok(entry.argv.join(' ').includes('haiku'), entry.argv.join(' '));
  }
  assert.equal(implementer[0]!.cwd, join(ran.dir, 'worktrees', 'smoke', 'SMOKE-1'));
  assert.equal(gate[0]!.cwd, join(ran.dir, 'worktrees', 'smoke', 'SMOKE-1'));
});

test('--keep keeps the directory and prints it; the bare remote has the job\'s branch at its prepared commit', async () => {
  const ran = await smoke('smoke-keep', ['--keep'], cleanScripts);
  try {
    assert.equal(ran.code, 0, ran.stdout + ran.stderr);
    assert.match(ran.rows.get('Cleanup')!.detail, new RegExp(`kept ${ran.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(existsSync(ran.dir), true);
    // The job was reset at Cleanup: its record archived, with the commit it prepared.
    const archived = (await readdir(join(ran.dir, 'state', 'jobs', 'smoke'))).filter((name) => name.startsWith('SMOKE-1.'));
    assert.equal(archived.length, 1);
    const job = JSON.parse(await readFile(join(ran.dir, 'state', 'jobs', 'smoke', archived[0]!, 'job.json'), 'utf8')) as { state: string; branch: string; prepared_commit: string };
    assert.deepEqual([job.state, job.branch], ['pushed', BRANCH]);
    assert.equal(git(join(ran.dir, 'origin.git'), 'rev-parse', BRANCH).trim(), job.prepared_commit);
    assert.equal(git(join(ran.dir, 'origin.git'), 'show', `${BRANCH}:greeting.txt`), 'hello\nhello again\n');
    // The repository the smoke made: main with the greeting and the Task file, by sf-smoke.
    // The Task of the run: its probe of the run's own paths, the canary by its SHA-256 only.
    const canary = await readFile(join(ran.dir, 'config', 'auth.env'), 'utf8');
    assert.match(canary, /^SF_CANARY=[0-9a-f]{48}\n$/);
    // The user's paths found as the smoke finds them, in the test's home (SF-123).
    const found = (path: string): string | undefined => (existsSync(path) ? path : undefined);
    const task = git(join(ran.dir, 'origin.git'), 'show', 'main:.software-factory/SMOKE-1.md');
    // The host socket: in a folder of its own under the run's TMPDIR, outside the run's directory,
    // gone with Cleanup (--keep or not).
    const tmpSocket = /--tmp-socket '([^']+)'/.exec(task)?.[1];
    assert.ok(tmpSocket !== undefined && dirname(dirname(tmpSocket)) === ran.tmp && !tmpSocket.startsWith(`${ran.dir}/`), task);
    assert.equal(existsSync(dirname(tmpSocket)), false);
    const probe = smokeProbe(smokePaths(ran.dir), createHash('sha256').update(canary).digest('hex'), {
      ssh: found(join(ran.env.home, '.ssh')), dbus: found(`/run/user/${process.getuid!()}/bus`), docker: found('/var/run/docker.sock'),
      // None when the smoke wrote the Task: the test's home has no Claude Code projects folder until
      // the Implementer's wrapper makes it for the first turn (SF-181).
      claudeProjects: undefined, tmpSocket,
    }, ran.env.home);
    assert.equal(probe.claudeTmp, `/tmp/claude-${process.getuid!()}`);
    assert.equal(probe.homeCanary, join(ran.env.home, `.sf-smoke-${basename(ran.dir).slice('sf-smoke-'.length)}`, 'canary'));
    assert.equal(task, smokeTask(probe, join(ran.dir, 'outside.txt')));
    assert.ok(task.includes(`--home-canary '${probe.homeCanary}'`));
    // SF-123: the Write outside the worktree asked for; the home canary gone with Cleanup.
    assert.ok(task.replace(/\s+/g, ' ').includes(`with the Write tool, write the line "outside" to the file \`${join(ran.dir, 'outside.txt')}\``));
    assert.equal(existsSync(dirname(probe.homeCanary)), false);
    assert.equal(existsSync(join(ran.dir, 'outside.txt')), false);
    assert.ok(task.includes(probeCommand(probe)));
    // SF-110: the probe as one Bash call on its own, then probe.json read with the Read tool.
    assert.ok(task.replace(/\s+/g, ' ').includes('as one Bash call on its own, with nothing before or after it (no `cd`, `echo`, `cat`, `;`, `&&` or `|`)'));
    assert.ok(task.includes('Then read `probe.json` with the Read tool.'));
    assert.ok(!task.includes(canary.trim()) && !ran.stdout.includes(canary.trim()));
    assert.equal(git(join(ran.dir, 'origin.git'), 'show', 'main:probe.mjs'), PROBE_SCRIPT);
    assert.equal(git(join(ran.dir, 'origin.git'), 'show', `${BRANCH}:probe.json`), probeOutput());
    assert.equal(git(join(ran.dir, 'origin.git'), 'log', '-1', '--format=%an <%ae>', 'main').trim(), 'sf-smoke <sf-smoke@localhost>');
    // SF-104, SF-109, SF-110: the Implementer ran in dontAsk, with the probe's prefix rule and the
    // file tools of the ticket allowed.
    for (const entry of await fakeLog(ran.env)) {
      assert.deepEqual(entry.argv.filter((arg) => arg.startsWith('--allowedTools')), ['--allowedTools=Bash(node probe.mjs:*),Read,Edit,Write,Glob,Grep,TodoWrite']);
      assert.deepEqual(entry.argv.filter((arg) => arg.startsWith('--permission-mode')), ['--permission-mode=dontAsk']);
    }
    await untouched(ran);
  } finally {
    await rm(ran.dir, { recursive: true, force: true });
  }
});

test('a review session that fails: the Claude review step FAILs with review_failed, the later steps SKIP, Cleanup PASS, exit 1', async () => {
  const ran = await smoke('smoke-review', [], async (env) => {
    await script(env, CLEAN_TURNS);
    await reviewScript(env, [{ output: CHECK_READY }, { noOutput: true }, { noOutput: true }]);
    await codexScript(env, [{}]);
  });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'PASS'], ran.stdout);
  assert.match(ran.rows.get('Claude review')!.detail, /^needs_human: review_failed: /);
  // Cleanup aborts the active job before its reset.
  assert.match(ran.stdout, /^Dashboard: SKIP[^\n]*\njob aborted \(sf abort smoke SMOKE-1\)\nCleanup: PASS/m);
  assert.match(ran.stdout, /\nsmoke: FAIL \(1 of 12 steps\), cost \d+\.\d{4} USD, gate 0 tokens\n$/);
  assert.equal((await codexLog(ran.env).catch(() => [])).length, 0);
  await onlyChecksDir(ran.tmp);
  await untouched(ran);
});

test('the gate off: the Codex gate step FAILs with sf info\'s reason, the job still goes on to the push and the dashboard, the run ends as FAIL', async () => {
  const ran = await smoke('smoke-gate-off', [], cleanScripts, { SF_GATE: 'off' });
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.deepEqual(statuses(ran), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'PASS', 'PASS', 'PASS', 'PASS'], ran.stdout);
  assert.equal(ran.rows.get('Codex gate')!.detail, 'the gate is off (SF_GATE=off)');
  assert.match(ran.stdout, /\nsmoke: FAIL \(1 of 12 steps\), cost \d+\.\d{4} USD, gate 0 tokens\n$/);
  await onlyChecksDir(ran.tmp);
});
