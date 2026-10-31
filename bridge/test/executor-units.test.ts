// SF-009 units: the fixed managed argument list, session lineage in the hand-started session scan,
// the stream-json event parsing, and the operator CLI in a throwaway home (no install, no opt-in).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DENIED_GIT_COMMANDS, managedArguments, type ManagedProcess } from '../src/execution/runner.js';
import { sessionActivity } from '../src/execution/service.js';
import { StreamSession } from '../src/executor/stream-session.js';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/executor/main.js', import.meta.url));

test('the managed argument list is fixed: print mode, stream-json, auto, prompts denied, Git operations denied', () => {
  const id = randomUUID();
  const argv = managedArguments({ sessionId: id, name: 'sf-app-job' });
  assert.deepEqual(argv.slice(0, 14), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompts', 'none', '--strict-mcp-config', '--session-id', id, '--name']);
  assert.equal(argv.filter((arg) => arg === '--permission-mode').length, 1);
  for (const command of ['commit', 'push', 'reset', 'clean', 'stash', 'checkout', 'rebase', 'config', 'add']) {
    assert.ok(DENIED_GIT_COMMANDS.includes(command));
    assert.ok(argv.includes(`Bash(git ${command}:*)`));
  }
  assert.ok(!argv.some((arg) => /bypass|dangerously|acceptEdits|dontAsk/.test(arg)));
  // Nothing positional: the instruction travels as a stdin message, never as an argument.
  assert.ok(!argv.some((arg) => arg.startsWith('/implement')));
});

test('session lineage ids are liveness candidates; a malformed lineage fails closed', () => {
  const base = { schema: 'software-factory.execution/v1', state: 'running', session: { id: randomUUID() } };
  const reset = randomUUID();
  assert.deepEqual(sessionActivity({ ...base, session_lineage: [base.session.id, reset] }), { kind: 'session', ids: [base.session.id, reset] });
  assert.deepEqual(sessionActivity(base), { kind: 'session', ids: [base.session.id] });
  assert.deepEqual(sessionActivity({ ...base, session_lineage: ['not-a-uuid'] }), { kind: 'unverifiable', category: 'invalid session lineage' });
  assert.deepEqual(sessionActivity({ ...base, state: 'completed', session_lineage: [reset] }), { kind: 'session', ids: [base.session.id, reset] });
});

test('only protocol events end a turn; denials keep the action, never the input', async () => {
  const output = new PassThrough();
  let exit: (value: { code: number; signal: null }) => void = () => undefined;
  const process_: ManagedProcess = {
    pid: 1,
    input: new PassThrough(),
    output,
    errors: new PassThrough(),
    exited: new Promise((resolve) => (exit = resolve)),
  };
  const id = randomUUID();
  const session = new StreamSession(process_, id);
  output.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: id, permissionMode: 'auto' })}\n`);
  output.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done. {"type":"result"}' }] } })}\n`);
  output.write('not json\n');
  output.write(`${JSON.stringify({ type: 'system', subtype: 'compact_boundary' })}\n`);
  output.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 3,
      permission_denials: [
        { tool_name: 'Bash', tool_input: { command: 'git -C . push origin main --token=ghp_secret' } },
        { tool_name: 'Write', tool_input: { file_path: '/etc/passwd', content: 'x' } },
      ],
    })}\n`,
  );
  const turn = await session.nextTurn();
  assert.deepEqual(turn, { kind: 'result', acked: 0, subtype: 'success', isError: false, numTurns: 3, denials: [{ action: 'Bash(git push)' }, { action: 'Write' }], modes: ['auto'] });
  assert.equal(session.compactions, 1);
  assert.equal(session.sessionMatches, true);
  output.end();
  exit({ code: 0, signal: null });
  assert.deepEqual(await session.nextTurn(), { kind: 'exited', exit: { code: 0, signal: null } });
});

test('the CLI refuses to run without the opt-in and renders the unit only into a new directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sf009-home-'));
  try {
    const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(home, 'state') };
    const status = await execFileAsync(process.execPath, [CLI, 'status'], { env });
    assert.match(status.stdout, /not enabled/);
    const run = await execFileAsync(process.execPath, [CLI, 'run'], { env }).then(
      () => 'ran',
      (error: { code?: number; stderr?: string }) => `${error.code} ${error.stderr}`,
    );
    assert.match(run, /^1 sf009-executor: not_ready: Automatic execution is not enabled/);
    const enable = await execFileAsync(process.execPath, [CLI, 'enable'], { env }).then(() => 'ok', (error: { code?: number }) => String(error.code));
    assert.equal(enable, '2');
    // Without --disposable-pilot nothing is enabled: no enforceable sandbox exists for a real app.
    const production = await execFileAsync(process.execPath, [CLI, 'enable', '--app', 'app-one', '--yes'], { env }).then(
      () => 'ok',
      (error: { code?: number; stderr?: string }) => `${error.code} ${error.stderr}`,
    );
    assert.match(production, /^1 sf009-executor: unsupported_isolation: Production automatic execution is not supported/);
    const unitDir = join(home, 'unit');
    const rendered = await execFileAsync(process.execPath, [CLI, 'render-unit', unitDir], { env });
    assert.match(rendered.stdout, /Nothing was installed or enabled/);
    const unit = await readFile(join(unitDir, 'sf009-supervisor.service'), 'utf8');
    assert.match(unit, /^ExecStart=\/.+\/bridge\/dist\/src\/executor\/main\.js run$/m);
    assert.ok(!unit.includes('@'));
    // Nothing else was created in the throwaway home: no systemd unit, no policy.
    assert.deepEqual((await readdir(home)).sort(), ['state', 'unit']);
    assert.deepEqual(await readdir(join(home, 'state', 'software-factory', 'executor', 'consumed')), []);
    await assert.rejects(readFile(join(home, 'state', 'software-factory', 'executor', 'policy.json')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
