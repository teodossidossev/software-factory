// End-to-end execution tests, the Implementer's session: permission_mode_mismatch and its restart,
// the smoke's session (dontAsk with the probe rule) against a real job's, the allowedTools and the
// init assertion. The real `sf serve` and `sf` CLI with private config and state directories,
// throwaway Git repositories and the fake Claude Code as the Implementer executable, as in
// test/execution.test.ts (split so that no file runs near run-tests' per-file limit).
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { factoryPrompt } from '../src/prompts.js';
import { SMOKE_PROBE_RULE, SMOKE_TOOLS, sessionAllowedTools } from '../src/session.js';
import { call, fakeLog, newEnv, newRepo, putTask, runCli, script, serve, stop, temp, waitFor } from './support/harness.js';

test('permission_mode_mismatch ends in needs_human; a restart turns working jobs into needs_human and sf say resumes them', async () => {
  const env = await newEnv('restart');
  const repo = await newRepo(env, 'restart-repo', false);
  await putTask(env, repo, 'M-1', 'Mismatch');
  await script(env, [{ permissionMode: 'default' }, { text: 'resumed report' }]);
  let served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'M-1' });
  const mismatch = await waitFor(served, 'M-1', 'needs_human');
  assert.equal(mismatch.error.code, 'permission_mode_mismatch');
  assert.equal(mismatch.iteration, 0);
  assert.deepEqual([mismatch.report, mismatch.patch], [undefined, undefined]);
  // A crash leaves the socket behind; the next sf serve replaces it.
  await stop(served, 'SIGKILL');
  assert.ok((await stat(join(env.state, 'sf.sock'))).isSocket());

  // A job left "working" by a stopped server, with a session to resume.
  const jobs = new JobStore(env.state);
  const job = (await jobs.read('app', 'M-1'))!;
  await jobs.write({ ...job, state: 'working', session_id: 'kept-session', error: undefined });
  served = await serve(env);
  const restarted = await call(served, 'check', { workspace: 'app', ticket: 'M-1' });
  assert.deepEqual([restarted.state, restarted.error?.code], ['needs_human', 'serve_restarted']);
  assert.equal((await jobs.read('app', 'M-1'))!.session_id, 'kept-session');

  assert.equal((await runCli(env, ['say', 'app', 'M-1', 'please', 'continue'])).code, 0);
  const resumed = await waitFor(served, 'M-1', 'awaiting_review', 1);
  assert.match(resumed.report, /^resumed report\n/);
  const log = await fakeLog(env);
  assert.equal(log[1]!.prompt, factoryPrompt('please continue', 'M-1', 1));
  assert.ok(log[1]!.argv.includes('--resume=kept-session'));
  await stop(served);
});

test('the smoke\'s session (SF-104, SF-109, SF-110): an sf serve whose state directory is laid out as sf smoke makes it runs the Implementer in dontAsk with exactly Bash(node probe.mjs:*) and the file tools in allowedTools; a real job stays in auto without allowedTools, and the sandbox, the path denials, the setting sources and the disallowed tools are equal for the same paths', async () => {
  const command = "node probe.mjs --canary '/x/config/auth.env' --job smoke > probe.json";
  // <TMPDIR>/sf-smoke-<suffix>/state, as sf smoke makes it; the sandbox on, as in a real job.
  const env = await newEnv('sf-smoke-exec', { TMPDIR: temp, SF_SMOKE_PROBE_ALLOW: command });
  const repo = await newRepo(env, 'sf-smoke-exec-repo', true);
  await putTask(env, repo, 'P-1', 'Probe');
  await script(env, [{ text: '# Report: P-1, iteration 1' }, { text: '# Report: P-1, iteration 2' }]);
  // The ticket history, which request_fix creates, exists for both turns: the same paths to deny
  // (a missing path is left out of the denials).
  await mkdir(join(env.state, 'tickets'), { recursive: true });
  // The fake's count and log, which its first run creates in the home: there for both turns too,
  // as the home's entries are denied to Bash (SF-123).
  await writeFile(join(env.home, 'fake-claude.count'), '0');
  await writeFile(join(env.home, 'fake-claude.log'), '');
  let served = await serve(env);
  await call(served, 'start', { workspace: 'app', ticket: 'P-1' });
  await waitFor(served, 'P-1', 'awaiting_review', 1);
  await stop(served);
  // The same job's next turn from an sf serve without the setting: a real job's options, same paths.
  delete env.extra!.SF_SMOKE_PROBE_ALLOW;
  served = await serve(env);
  await call(served, 'request_fix', { workspace: 'app', ticket: 'P-1', content: '1. Again.' });
  await waitFor(served, 'P-1', 'awaiting_review', 2);
  await stop(served);

  const [smokeLogged, realLogged] = await fakeLog(env);
  // Each session has a temporary folder of its own (CLAUDE_CODE_TMPDIR), read back by its sandbox:
  // the same place in both argv once named alike.
  const own = (entry: typeof smokeLogged): typeof smokeLogged => ({ ...entry!, argv: entry!.argv.map((arg) => arg.split(entry!.tmpdir!.path).join('<session tmp>')) });
  assert.notEqual(smokeLogged!.tmpdir!.path, realLogged!.tmpdir!.path);
  const [smoke, real] = [own(smokeLogged), own(realLogged)];
  const allowed = (argv: string[]): string[] => argv.filter((arg) => arg.startsWith('--allowedTools'));
  assert.deepEqual(allowed(smoke!.argv), ['--allowedTools=Bash(node probe.mjs:*),Read,Edit,Write,Glob,Grep,TodoWrite']);
  assert.deepEqual(allowed(real!.argv), []);
  const mode = (argv: string[]): string[] => argv.filter((arg) => arg.startsWith('--permission-mode'));
  assert.deepEqual(mode(smoke!.argv), ['--permission-mode=dontAsk']);
  assert.deepEqual(mode(real!.argv), ['--permission-mode=auto']);
  // Everything else of the two sessions' argv is the same, but the real turn's resume.
  const rest = (argv: string[]): string[] => argv.filter((arg) => !/^--(allowedTools|permission-mode|resume)\b/.test(arg));
  assert.deepEqual(rest(smoke!.argv), rest(real!.argv));
  assert.ok(smoke!.argv.includes('--setting-sources=user,project'));
  assert.ok(real!.argv.includes(`--resume=${smoke!.sessionId}`));
  const sandbox = (argv: string[]): Record<string, unknown> => (JSON.parse(argv[argv.indexOf('--settings') + 1]!) as { sandbox: Record<string, unknown> }).sandbox;
  const denied = (argv: string[]): string | undefined => argv.find((arg) => arg.startsWith('--disallowedTools='));
  assert.deepEqual(sandbox(smoke!.argv), sandbox(real!.argv));
  assert.deepEqual([sandbox(smoke!.argv).enabled, sandbox(smoke!.argv).allowUnsandboxedCommands], [true, false]);
  assert.ok((sandbox(smoke!.argv).filesystem as { denyRead: string[] }).denyRead.length > 0);
  assert.equal(denied(smoke!.argv), denied(real!.argv));
  assert.ok(denied(smoke!.argv)?.includes('Bash(git commit:*)'));
});

test('the allowedTools of a session (SF-104, SF-109, SF-110): a smoke session with the probe has exactly the prefix rule and the file tools; a real job none; allowCommands without smokeMode the exact rules', () => {
  const command = "node probe.mjs --canary '/x/config/auth.env' > probe.json";
  assert.equal(SMOKE_PROBE_RULE, 'Bash(node probe.mjs:*)');
  assert.deepEqual(sessionAllowedTools({ allowCommands: [command], smokeMode: true }), [SMOKE_PROBE_RULE, ...SMOKE_TOOLS]);
  assert.deepEqual(sessionAllowedTools({ allowCommands: [command, 'node probe.mjs --job smoke'], smokeMode: true }), [SMOKE_PROBE_RULE, ...SMOKE_TOOLS]);
  assert.deepEqual(sessionAllowedTools({ allowCommands: undefined, smokeMode: false }), []);
  assert.deepEqual(sessionAllowedTools({}), []);
  assert.deepEqual(sessionAllowedTools({ allowCommands: [command], smokeMode: false }), [`Bash(${command})`]);
  assert.deepEqual(sessionAllowedTools({ allowCommands: [command] }), [`Bash(${command})`]);
  // A smoke session without a command: the file tools only, no probe rule.
  assert.deepEqual(sessionAllowedTools({ smokeMode: true }), [...SMOKE_TOOLS]);
});

test('the init assertion (SF-109): a smoke session reporting auto and a real one reporting dontAsk fail with permission_mode_mismatch; each reporting its own mode records the session id', async () => {
  const command = 'node probe.mjs --job smoke > probe.json';
  const cases: Array<{ name: string; extra: Record<string, string>; reported: string; expected: string }> = [
    { name: 'sf-smoke-mode-a', extra: { TMPDIR: temp, SF_SMOKE_PROBE_ALLOW: command }, reported: 'auto', expected: 'dontAsk' },
    { name: 'mode-real-a', extra: {}, reported: 'dontAsk', expected: 'auto' },
    { name: 'sf-smoke-mode-b', extra: { TMPDIR: temp, SF_SMOKE_PROBE_ALLOW: command }, reported: 'dontAsk', expected: 'dontAsk' },
    { name: 'mode-real-b', extra: {}, reported: 'auto', expected: 'auto' },
  ];
  for (const { name, extra, reported, expected } of cases) {
    const env = await newEnv(name, extra);
    const repo = await newRepo(env, `${name}-repo`, false);
    await putTask(env, repo, 'M-1', 'Mode');
    await script(env, [{ permissionMode: reported, text: '# Report: M-1, iteration 1' }]);
    const served = await serve(env);
    await call(served, 'start', { workspace: 'app', ticket: 'M-1' });
    const job = await waitFor(served, 'M-1', reported === expected ? 'awaiting_review' : 'needs_human', reported === expected ? 1 : undefined);
    const [entry] = await fakeLog(env);
    assert.ok(entry!.argv.includes(`--permission-mode=${expected}`), name);
    const recorded = (await new JobStore(env.state).read('app', 'M-1'))!.session_id ?? null;
    if (reported === expected) {
      assert.equal(recorded, entry!.sessionId, name);
    } else {
      assert.equal(job.error.code, 'permission_mode_mismatch', name);
      assert.match(job.error.message, new RegExp(`"${reported}" instead of "${expected}"`), name);
      assert.equal(recorded, null, name);
    }
    await stop(served);
  }
});
