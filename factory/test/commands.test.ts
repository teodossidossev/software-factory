// The command table of SF-138 (src/commands.ts): every command of the CLI in sf help with its usage
// line; a wrong argument count gives the command's one message, from the CLI (exit 2) and from sf
// serve's socket (bad_request) alike, both checked by checkArgs; the update gate follows the
// table's openWhileUpdating; the CLI's lookup of a command and the argument check as units.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { checkArgs, cliCommand, type Command, COMMAND_LIST, COMMANDS, socketName, UsageError, usageLine, usageMessage } from '../src/commands.js';
import { FactoryError } from '../src/errors.js';
import { callSocket } from '../src/ipc.js';
import { now } from '../src/jobs.js';
import { startTime } from '../src/pid-lock.js';
import { markerPath, writeMarker } from '../src/update.js';
import { act, openStream } from './support/dashboard-client.js';
import { newEnv, runCli, serve, stop } from './support/harness.js';

const E2E = { timeout: 120_000 };

const CLI_COMMANDS = COMMAND_LIST.filter((command) => command.description !== undefined);

// Arguments the check accepts: a name for <workspace> and <ticket>, 1 for <N>, the first of a|b,
// a word for any other required one, none for an optional one.
function validArgs(command: Command): string[] {
  return command.args.flatMap((token) => {
    if (token.startsWith('[')) {
      return [];
    }
    return token === '<workspace>' ? ['app'] : token === '<ticket>' ? ['T-1'] : token === '<N>' ? ['1'] : token.includes('|') ? [token.split('|')[0]!] : ['x'];
  });
}

// One argument too few, or one too many for a command that takes none; undefined for a command
// whose every count is right (sf queue hold [reason...]).
function wrongCount(command: Command): string[] | undefined {
  const valid = validArgs(command);
  if (valid.length > 0) {
    return valid.slice(0, -1);
  }
  return command.args.length === 0 ? ['extra'] : undefined;
}

const words = (command: Command): string[] => command.name.split(' ');

test('every command of the CLI is in sf help once, with its usage line; the lines keep their wording', async () => {
  const env = await newEnv('commands-help');
  const help = await runCli(env, ['help']);
  assert.equal(help.code, 0, help.stderr);
  const lines = help.stdout.split('\n');
  for (const command of CLI_COMMANDS) {
    assert.ok(lines.includes(usageLine(command)), `sf help lacks: ${usageLine(command)}`);
    // Not counting the lines of a group's command under the same first word (sf skills set under sf skills).
    const longer = CLI_COMMANDS.filter((other) => other.name.startsWith(`${command.name} `));
    assert.equal(lines.filter((line) => line.startsWith(`  sf ${command.name} `) && !longer.some((other) => line.startsWith(`  sf ${other.name} `))).length, 1, command.name);
  }
  // As they were written by hand before SF-138.
  assert.ok(lines.includes('  sf accept <workspace> <ticket>                        Accept a clean Claude review over a stopped gate (needs_human with gate_rounds, gate_budget or gate_failed) or a ledger stop (review_churn, review_disputed) or the Fix round limit (iteration_limit) or the workspace\'s tests (tests_failed, tests_unavailable: without passing tests) and prepare the MR; on simplify_offered: skip the suggestions (listed on the Merge request screen)'));
  assert.ok(lines.includes('  sf queue add <workspace> <ticket> [--at N]            Queue a planned ticket at position N (1-based; default: the end); sf serve starts it by itself when a slot is free, its lands_after tickets are merged and the Task check of its current Task file is ready'));
  assert.ok(lines.includes('  sf queue on-limit resume-then-queue|resume-only|wait  What happens when a usage limit resets: resume the parked jobs, then start queued tickets again (default); resume them and hold the queue; or hold the queue and let you resume them'));
  assert.ok(lines.includes('  sf settle <workspace> <ticket> <id> accept|fix [note...]  Settle an escalated or contested finding of the ledger (needs_human): accept the risk, or the Implementer must fix it; the job goes on once nothing is left to settle'));
  // The socket's own requests are no commands of the CLI.
  for (const command of COMMAND_LIST.filter((entry) => entry.description === undefined)) {
    assert.ok(!lines.some((line) => line.startsWith(`  sf ${command.name} `) || line === `  sf ${command.name}`), command.name);
  }
});

test('the one argument message of a command is built from its arguments and flags', () => {
  assert.equal(usageMessage(COMMANDS.accept), 'accept needs <workspace> <ticket>.');
  assert.equal(usageMessage(COMMANDS.settle), 'settle needs <workspace> <ticket> <id> accept|fix [note...].');
  assert.equal(usageMessage(COMMANDS.approve), 'approve needs <workspace> <ticket> [--as-is].');
  assert.equal(usageMessage(COMMANDS.queueAdd), 'queue add needs <workspace> <ticket> [--at N].');
  assert.equal(usageMessage(COMMANDS.queueOnLimit), 'queue on-limit needs resume-then-queue|resume-only|wait.');
  assert.equal(usageMessage(COMMANDS.queueList), 'queue list takes no arguments.');
  assert.equal(socketName(COMMANDS.queueOnLimit), 'queue-on-limit');
  assert.equal(socketName(COMMANDS.handedDone), 'handed-done');
});

test('checkArgs: the count and the a|b words, then the flags\' values and the names from left to right', () => {
  const usage = (message: string) => (error: unknown): boolean => error instanceof UsageError && error.code === 'bad_request' && error.message === message;
  const code = (expected: string) => (error: unknown): boolean => error instanceof FactoryError && !(error instanceof UsageError) && error.code === expected;
  assert.deepEqual(checkArgs(COMMANDS.say, ['app', 'T-1', 'hello', 'there']), { args: ['app', 'T-1', 'hello', 'there'], flags: {} });
  assert.deepEqual(checkArgs(COMMANDS.approve, ['app', '--as-is', 'T-1']).args, ['app', 'T-1']);
  assert.equal(checkArgs(COMMANDS.approve, ['app', 'T-1', '--as-is']).flags['as-is'], true);
  assert.equal(checkArgs(COMMANDS.queueAdd, ['app', 'T-1', '--at', '3']).flags.at, '3');
  assert.throws(() => checkArgs(COMMANDS.settle, ['app', 'T-1', 'R1', 'maybe']), usage(usageMessage(COMMANDS.settle)));
  assert.throws(() => checkArgs(COMMANDS.queueOnLimit, ['later']), usage(usageMessage(COMMANDS.queueOnLimit)));
  assert.throws(() => checkArgs(COMMANDS.queueAdd, ['app', 'T-1', '--at', 'x']), usage('--at must be a whole number.'));
  assert.throws(() => checkArgs(COMMANDS.queueMove, ['app', 'T-1', 'x']), usage('N must be a whole number.'));
  assert.throws(() => checkArgs(COMMANDS.approve, ['app', 'T-1', '--bogus']), (error: unknown) => error instanceof UsageError && /--bogus/.test(error.message));
  assert.throws(() => checkArgs(COMMANDS.start, ['bad name', 'T-1']), code('invalid_name'));
  assert.throws(() => checkArgs(COMMANDS.start, ['app', 'not a ticket']), code('invalid_ticket'));
  // A flagless command takes a word that looks like a flag as it is.
  assert.equal(checkArgs(COMMANDS.say, ['app', 'T-1', '--verbose']).args[2], '--verbose');
});

test('the CLI\'s lookup: one word or a group\'s two; a group without one of its words is a usage error; the socket\'s own requests are none', () => {
  assert.equal(cliCommand(['accept', 'app', 'T-1'])?.command, COMMANDS.accept);
  assert.deepEqual(cliCommand(['queue', 'add', 'app', 'T-1'])?.args, ['app', 'T-1']);
  assert.equal(cliCommand(['mr', 'status', 'app', 'T-1'])?.command, COMMANDS.mrStatus);
  // sf skills, and sf skills set: the group's own word wins over the command of the one word.
  assert.deepEqual(cliCommand(['skills']), { command: COMMANDS.skills, args: [] });
  assert.deepEqual(cliCommand(['skills', 'set', 'planner', 'tdd', 'on']), { command: COMMANDS.skillsSet, args: ['planner', 'tdd', 'on'] });
  assert.deepEqual(checkArgs(COMMANDS.skillsSet, ['planner', 'tdd', 'off']).args, ['planner', 'tdd', 'off']);
  assert.throws(() => checkArgs(COMMANDS.skillsSet, ['planner', 'tdd', 'maybe']), UsageError);
  assert.throws(() => checkArgs(COMMANDS.skills, ['extra']), UsageError);
  assert.throws(() => cliCommand(['mr']), (error: unknown) => error instanceof UsageError && error.message === 'mr needs create, merge, status, list or comments.');
  assert.throws(() => cliCommand(['mr', 'open']), (error: unknown) => error instanceof UsageError && error.message === 'unknown mr command "open".');
  assert.throws(() => cliCommand(['queue', 'bogus']), (error: unknown) => error instanceof UsageError && error.message === 'unknown queue command "bogus".');
  for (const name of ['status', 'serve', 'ping', 'check', 'fix', 'clean', 'serve-busy', 'digest']) {
    assert.equal(cliCommand([name]), undefined, name);
  }
});

test('a wrong argument count gives the command\'s one message, from the CLI (exit 2, without sf serve) and from the socket (bad_request) alike', E2E, async () => {
  const env = await newEnv('commands-count');
  const fromCli = await Promise.all(CLI_COMMANDS.flatMap((command) => {
    const args = wrongCount(command);
    return args === undefined ? [] : [runCli(env, [...words(command), ...args]).then((result) => ({ command, result }))];
  }));
  // Every count is right only for those whose arguments may all be left out (their --clear instead).
  assert.deepEqual(CLI_COMMANDS.filter((command) => wrongCount(command) === undefined).map((command) => command.name), ['queue hold', 'coordinator status', 'coordinator link', 'norms']);
  for (const { command, result } of fromCli) {
    assert.equal(result.code, 2, `${command.name}: ${result.stderr}`);
    assert.ok(result.stderr.startsWith(`sf: ${usageMessage(command)}\n\nUsage:\n`), `${command.name}: ${result.stderr.slice(0, 200)}`);
  }
  const served = await serve(env);
  try {
    for (const command of COMMAND_LIST) {
      const args = wrongCount(command);
      if (args === undefined) {
        continue;
      }
      const response = await callSocket(env.state, { command: socketName(command), args });
      assert.deepEqual(response, { ok: false, error: { code: 'bad_request', message: usageMessage(command) } }, command.name);
    }
    // A flag the command does not take, refused by the socket as by the CLI.
    const flag = await callSocket(env.state, { command: socketName(COMMANDS.approve), args: ['app', 'T-1', '--bogus'] });
    assert.equal(flag.ok ? 'ok' : flag.error.code, 'bad_request');
    const unknown = await callSocket(env.state, { command: 'queue-bogus', args: [] });
    assert.deepEqual(unknown, { ok: false, error: { code: 'bad_request', message: 'Unknown command "queue-bogus".' } });
  } finally {
    await stop(served);
  }
});

test('while sf update drains or builds, a command not open while updating is refused (update_in_progress) and an open one is not', E2E, async () => {
  const env = await newEnv('commands-gate');
  const served = await serve(env);
  try {
    await writeMarker(env.state, { phase: 'building', pid: process.pid, pid_start: startTime(process.pid) ?? null, start_commit: 'b'.repeat(40), paused: [], at: now() });
    for (const command of COMMAND_LIST) {
      const response = await callSocket(env.state, { command: socketName(command), args: validArgs(command) });
      const outcome = response.ok ? 'ok' : response.error.code;
      if (command.openWhileUpdating === true) {
        assert.notEqual(outcome, 'update_in_progress', command.name);
      } else {
        assert.equal(outcome, 'update_in_progress', command.name);
      }
    }
    assert.deepEqual(COMMAND_LIST.filter((command) => command.openWhileUpdating === true).map(socketName).sort(),
      ['check', 'coordinator', 'digest-latest', 'mcp-port', 'mr-comments', 'mr-list', 'mr-status', 'norms', 'pause', 'ping', 'pins', 'pins-clear', 'pins-resolve', 'queue-list', 'serve-busy', 'skills', 'vision']);
    // From the CLI: refused with exit 1; the open pause reaches the job (there is none).
    const accept = await runCli(env, ['accept', 'app', 'T-1']);
    assert.equal(accept.code, 1);
    assert.match(accept.stderr, /^sf: The factory is being updated \(sf update\)/);
    const pause = await runCli(env, ['pause', 'app', 'T-1']);
    assert.equal(pause.code, 1);
    assert.doesNotMatch(pause.stderr, /being updated/);
  } finally {
    await rm(markerPath(env.state), { force: true });
    await stop(served);
  }
});

test('sf coordinator: the writes go through sf serve, which tells the open pages (a coordinator event) after each; the read prints the state; refusals exit 1', E2E, async () => {
  const env = await newEnv('commands-coordinator');
  const offline = await runCli(env, ['coordinator', 'status', 'Planning']);
  assert.equal(offline.code, 1);
  assert.match(offline.stderr, /sf serve is not running/);
  const served = await serve(env);
  const stream = await openStream(new URL('api/stream', served.dashboard!));
  try {
    await stream.next('coordinator');
    const events = (): number => stream.events.filter((event) => event.event === 'coordinator').length;
    const write = async (args: string[]): Promise<string> => {
      const before = events();
      const result = await runCli(env, ['coordinator', ...args]);
      assert.equal(result.code, 0, result.stderr);
      await stream.seen('coordinator', () => events() > before);
      return result.stdout;
    };
    assert.match(await write(['status', 'Planning', 'SF-210']), /^status: Planning SF-210 {2}\(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\)\nquestions: none\nlink: none\n$/);
    assert.equal(await write(['ask', 'Merge SF-204 first?']), 'q1\n');
    assert.equal(await write(['ask', 'Which base?']), 'q2\n');
    await write(['answered', 'q1']);
    assert.match(await write(['link', 'https://claude.ai/chat/abc']), /link: https:\/\/claude\.ai\/chat\/abc\n$/);
    const shown = await runCli(env, ['coordinator']);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^status: Planning SF-210 .*\nquestions:\n {2}q2 {2}\S+ \S+ {2}Which base\?\nlink: https:\/\/claude\.ai\/chat\/abc\n$/);
    const before = events();
    for (const [args, message] of [
      [['link', 'https://claude.ai.evil.com/x'], /must be an https:\/\/claude\.ai\/ URL/], [['answered', 'q1'], /no open question "q1"; open: q2/],
      [['status', 'x'.repeat(2001)], /2001 characters; at most 2000/], [['status', 'x', '--clear'], /needs the status or --clear/],
    ] as const) {
      const refused = await runCli(env, ['coordinator', ...args]);
      assert.equal(refused.code, 1, args.join(' '));
      assert.match(refused.stderr, message, args.join(' '));
    }
    assert.equal(await write(['status', '--clear']), `status: none\nquestions:\n${shown.stdout.split('\n')[2]}\nlink: https://claude.ai/chat/abc\n`);
    assert.equal(events(), before + 1, 'only the writes that went through tell the pages');
    // A status of several lines, after -- as it starts with "-": its further lines under its first.
    assert.match(await write(['status', '--', '- SF-210 planned\n- SF-211 queued']), /^status: - SF-210 planned {2}\(.+\)\n {8}- SF-211 queued\nquestions:/);
  } finally {
    stream.close();
    await stop(served);
  }
});

test('sf coordinator wait-request: exit 3 on its timeout, 0 with the time of a request the dashboard opened (before or after it started); a status answers the request; no coordinator event; a wrong flag exits 2', E2E, async () => {
  const env = await newEnv('commands-wait-request');
  const served = await serve(env);
  const stream = await openStream(new URL('api/stream', served.dashboard!));
  try {
    await stream.next('coordinator');
    const events = (): number => stream.events.filter((event) => event.event === 'coordinator').length;
    const before = events();
    const none = await runCli(env, ['coordinator', 'wait-request', '--timeout', '0']);
    assert.deepEqual([none.code, none.stdout], [3, 'no status request before the timeout\n']);
    // Started before the POST: it exits 0 once the request lands.
    const waiting = runCli(env, ['coordinator', 'wait-request']);
    await new Promise((done) => setTimeout(done, 300));
    const posted = await act(new URL(served.dashboard!), 'api/coordinator/request', {});
    assert.equal(posted.status, 200, posted.body);
    const woken = await waiting;
    assert.equal(woken.code, 0, woken.stderr);
    assert.match(woken.stdout, /^status requested at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\n$/);
    await stream.seen('coordinator', () => events() > before);
    // Open already: at once.
    const open = await runCli(env, ['coordinator', 'wait-request', '--timeout', '0']);
    assert.deepEqual([open.code, open.stdout], [0, woken.stdout]);
    assert.equal(events(), before + 1, 'only the POST told the pages');
    // A status answers it.
    assert.equal((await runCli(env, ['coordinator', 'status', 'Done'])).code, 0);
    const answered = await runCli(env, ['coordinator', 'wait-request', '--timeout', '0']);
    assert.deepEqual([answered.code, answered.stdout], [3, 'no status request before the timeout\n']);
    const wrong = await runCli(env, ['coordinator', 'wait-request', '--timeout', 'x']);
    assert.equal(wrong.code, 2);
    assert.match(wrong.stderr, /--timeout must be a whole number/);
  } finally {
    stream.close();
    await stop(served);
  }
});
