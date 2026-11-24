// A stalled Bash call: the session driver alone, on the fake Claude Code, ends a turn whose Bash call
// hangs with no command process (or past the hard limit), sends the turn's instruction once more with
// the stall note, and fails the chain's second stall with tool_stalled; a call whose command still
// runs is left alone, and a close() during a check ends the turn as closed. The probe on a fake
// /proc, SF_TOOL_STALL_MIN, the event's line in sf watch, the resent prompt in the Stream, and the stop's row.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { jobUserMessages, lineEntries, type StreamContext } from '../src/job-stream.js';
import { type Job, JobStore } from '../src/jobs.js';
import { factoryPrompt } from '../src/prompts.js';
import { type IdleOutcome, ImplementerSession, type SessionHooks } from '../src/session.js';
import { jobActions, NO_FACTS, STOPS } from '../src/stops.js';
import { commandProbe, oneLineCommand, type ProbeAnswer, type Stall, STALL_HARD_MS, STALL_LEAD, stallNote, type StallAction, type ToolStallOptions } from '../src/tool-stall.js';
import { formatEvent } from '../src/watch.js';
import { FAKE, temp } from './support/harness.js';

// Runs fn with HOME set to a fresh folder holding the fake's turn scripts.
async function withFake<T>(name: string, turns: unknown[], fn: (home: string) => Promise<T>): Promise<T> {
  const home = join(temp, name);
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'fake-claude.json'), JSON.stringify({ turns }));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = saved;
  }
}

interface Run {
  session: ImplementerSession;
  idle: Promise<IdleOutcome>;
  prompts: Array<{ prompt: string; continued: number; images: number }>;
  stalls: Array<{ stall: Stall; action: StallAction }>;
}

// A session on the fake with the given watch, recording its prompts and the stall hook's calls.
function session(home: string, toolStall: ToolStallOptions, extra: { turnLimitContinues?: number; hooks?: Partial<SessionHooks> } = {}): Run {
  let idle: (outcome: IdleOutcome) => void = () => undefined;
  const outcome = new Promise<IdleOutcome>((done) => (idle = done));
  const prompts: Run['prompts'] = [];
  const stalls: Run['stalls'] = [];
  const created = new ImplementerSession({ cwd: home, maxTurns: 5, claudePath: FAKE, toolStall, turnLimitContinues: extra.turnLimitContinues ?? 0 }, {
    message: async () => undefined,
    prompt: async (prompt, continued, images) => void prompts.push({ prompt, continued, images: images?.length ?? 0 }),
    toolStalled: async (stall, action) => void stalls.push({ stall, action }),
    idle: async (result) => idle(result),
    ...extra.hooks,
  });
  return { session: created, idle: outcome, prompts, stalls };
}

const answer = (value: ProbeAnswer) => async (): Promise<ProbeAnswer> => value;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const lastParagraph = (text: string): string => text.slice(text.lastIndexOf('\n\n') + 2);
const HEREDOC = "cat <<'EOF' > notes.txt\nfirst line\n\n  second\tline\nEOF";

test('a hang with no command process: the hook is told resent, the first prompt goes again verbatim with the stall note as one paragraph, and the outcome is ok', async () => {
  await withFake('stall-resent', [{ hangTool: { command: HEREDOC } }, { text: 'done after the resend' }], async (home) => {
    const run = session(home, { afterMs: 200, checkMs: 50, probe: answer('none') });
    const first = factoryPrompt('/implement .software-factory/T-1.md', 'T-1', 1);
    run.session.send(first, ['WebFetch']);
    const outcome = await run.idle;
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.ok && outcome.text, 'done after the resend');
    assert.deepEqual(run.stalls.map((s) => [s.action, s.stall.tool, s.stall.reason, s.stall.command]), [['resent', 'Bash', 'no_process', "cat <<'EOF' > notes.txt first line second line EOF"]]);
    assert.ok(run.stalls[0]!.stall.openS >= 0);
    assert.equal(run.prompts.length, 2);
    const resent = run.prompts[1]!;
    assert.ok(resent.prompt.startsWith(`${first}\n\n`));
    assert.ok(resent.prompt.startsWith('/implement '), 'the slash command stays first');
    const note = resent.prompt.slice(first.length + 2);
    assert.equal(note, stallNote(run.stalls[0]!.stall));
    assert.ok(note.startsWith(STALL_LEAD));
    assert.ok(!note.includes('\n'), 'the note is one paragraph, whatever the command held');
    assert.equal(lastParagraph(resent.prompt), note);
    assert.deepEqual([resent.continued, resent.images], [0, 0]);
    assert.match(note, /Do not run that command again as it was/);
    assert.match(note, /give a long command a timeout/);
    assert.match(note, /Do not redo work you already finished/);

    // The resent prompt is not one of the user's messages; a message the user sends is.
    const state = await mkdtemp(join(tmpdir(), 'sf-stall-state-'));
    try {
      const jobs = new JobStore(state);
      const events = jobs.eventsPath('app', 'T-1');
      await mkdir(dirname(events), { recursive: true });
      const line = (prompt: string): string => JSON.stringify({ ts: '2026-11-24T10:00:00.000Z', iteration: 1, prompt });
      await writeFile(events, [line(run.prompts[0]!.prompt), line(resent.prompt), line('Please also check the docs.')].map((l) => `${l}\n`).join(''));
      assert.deepEqual((await jobUserMessages(jobs, 'app', 'T-1')).map((m) => m.text), ['Please also check the docs.']);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
    await run.session.close();
  });
});

test('a hang whose command still runs: no stall, the call ends by itself and the outcome is ok; the check timer stops when the turn ends', async () => {
  await withFake('stall-alive', [{ hangTool: { endAfterMs: 700 }, text: 'the long run passed' }], async (home) => {
    let probes = 0;
    const run = session(home, { afterMs: 100, checkMs: 50, hardMs: 60_000, probe: async () => ((probes += 1), 'alive') });
    run.session.send('go', []);
    const outcome = await run.idle;
    assert.equal(outcome.ok && outcome.text, 'the long run passed');
    assert.deepEqual(run.stalls, []);
    assert.equal(run.prompts.length, 1);
    assert.ok(probes > 0, 'the watch looked at the call');
    const seen = probes;
    await sleep(300);
    assert.equal(probes, seen, 'no check after the turn ended');
    await run.session.close();
  });
});

test('two hangs in one chain: resent, then stopped, and the turn fails with tool_stalled', async () => {
  await withFake('stall-twice', [{ hangTool: {} }, { hangTool: {} }, { text: 'never' }], async (home) => {
    const run = session(home, { afterMs: 150, checkMs: 40, probe: answer('none') });
    run.session.send('go', []);
    const outcome = await run.idle;
    assert.deepEqual(run.stalls.map((s) => s.action), ['resent', 'stopped']);
    assert.deepEqual(outcome.ok ? outcome : { ok: outcome.ok, code: outcome.code }, { ok: false, code: 'tool_stalled' });
    assert.match(!outcome.ok ? outcome.message : '', /^A Bash command hung again after the factory had sent the turn's instruction once more: find /);
    assert.equal(run.prompts.length, 2);
    await run.session.close();
  });
});

test('a hang in a turn-limit continuation after a resend stops too: the count carries over the chain; a new message starts a new count', async () => {
  await withFake('stall-continued', [{ hangTool: {} }, { maxTurns: true }, { hangTool: {} }, { hangTool: {} }, { text: 'after the user' }], async (home) => {
    let next: (outcome: IdleOutcome) => void = () => undefined;
    const outcomes: IdleOutcome[] = [];
    const run = session(home, { afterMs: 150, checkMs: 40, probe: answer('none') }, {
      turnLimitContinues: 1,
      hooks: {
        turnLimit: async () => ({ prompt: 'Continue where you stopped.' }),
        idle: async (outcome) => {
          outcomes.push(outcome);
          next(outcome);
        },
      },
    });
    const idled = (): Promise<IdleOutcome> => new Promise((done) => (next = done));
    let waiting = idled();
    run.session.send('go', []);
    const stopped = await waiting;
    assert.deepEqual(stopped.ok ? stopped : stopped.code, 'tool_stalled');
    assert.deepEqual(run.prompts.map((p) => p.continued), [0, 0, 1]);
    assert.equal(run.prompts[2]!.prompt, 'Continue where you stopped.');
    assert.deepEqual(run.stalls.map((s) => s.action), ['resent', 'stopped']);
    // The user's message: a new chain, its first stall resent again.
    waiting = idled();
    run.session.send('Use a timeout.', []);
    const after = await waiting;
    assert.equal(after.ok && after.text, 'after the user');
    assert.deepEqual(run.stalls.map((s) => s.action), ['resent', 'stopped', 'resent']);
    assert.equal(run.prompts[3]!.prompt, 'Use a timeout.');
    assert.ok(run.prompts[4]!.prompt.startsWith('Use a timeout.\n\n'));
    await run.session.close();
  });
});

test('probe unknown, past the hard limit: stalled with past_cap', async () => {
  await withFake('stall-cap', [{ hangTool: {} }, { text: 'ok' }], async (home) => {
    const run = session(home, { afterMs: 100, checkMs: 40, hardMs: 300, probe: answer('unknown') });
    run.session.send('go', []);
    const outcome = await run.idle;
    assert.equal(outcome.ok && outcome.text, 'ok');
    assert.deepEqual(run.stalls.map((s) => [s.action, s.stall.reason]), [['resent', 'past_cap']]);
    assert.ok(run.stalls[0]!.stall.openS >= 0);
    assert.match(lastParagraph(run.prompts[1]!.prompt), /past the Bash tool's 60-minute cap/);
    await run.session.close();
  });
});

test('a probe that answers unknown and alive before the hard limit never stalls', async () => {
  await withFake('stall-unknown', [{ hangTool: { endAfterMs: 600 }, text: 'ok' }], async (home) => {
    let calls = 0;
    const run = session(home, { afterMs: 50, checkMs: 30, hardMs: 60_000, probe: async () => ((calls += 1) % 2 === 1 ? 'unknown' : 'alive') });
    run.session.send('go', []);
    const outcome = await run.idle;
    assert.equal(outcome.ok && outcome.text, 'ok');
    assert.deepEqual(run.stalls, []);
    assert.ok(calls > 2);
    await run.session.close();
  });
});

test('the first check past the threshold that finds no command process stalls the call: no second check is waited for', async () => {
  await withFake('stall-first-none', [{ hangTool: {} }, { text: 'ok' }], async (home) => {
    // alive three times, then none: the fourth check stalls the call, and none runs after it.
    let calls = 0;
    const run = session(home, { afterMs: 50, checkMs: 30, hardMs: 60_000, probe: async () => ((calls += 1) <= 3 ? 'alive' : 'none') });
    run.session.send('go', []);
    const outcome = await run.idle;
    assert.equal(outcome.ok && outcome.text, 'ok');
    assert.deepEqual(run.stalls.map((s) => [s.action, s.stall.reason]), [['resent', 'no_process']]);
    // The resent turn makes no Bash call, so its watch never asks.
    assert.equal(calls, 4);
    await run.session.close();
  });
});

test('a close() while a check reads the processes ends the turn as closed: no stall, no resend, no idle outcome', async () => {
  await withFake('stall-closed', [{ hangTool: {} }, { text: 'never' }], async (home) => {
    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const holding = new Promise<void>((done) => (held = done));
    let calls = 0;
    let idled = false;
    const run = session(home, {
      afterMs: 100, checkMs: 40,
      probe: async () => {
        calls += 1;
        if (calls === 1) {
          // The check that would stall the call waits here until the test has closed the session.
          held();
          await new Promise<void>((done) => (release = done));
        }
        return 'none';
      },
    }, { hooks: { idle: async () => void (idled = true) } });
    run.session.send('go', []);
    await holding;
    const closing = run.session.close();
    release();
    await closing;
    await sleep(200);
    assert.deepEqual([run.stalls, run.prompts.length, idled, run.session.busy], [[], 1, false, false]);
  });
});

// A fake /proc with the given processes: status (Name, State, PPid, Uid), stat and cmdline of each.
async function fakeProc(processes: Array<{ pid: number; name: string; ppid: number; zombie?: boolean }>): Promise<string> {
  const proc = await mkdtemp(join(tmpdir(), 'sf-stall-proc-'));
  for (const info of processes) {
    const dir = join(proc, String(info.pid));
    const state = info.zombie === true ? 'Z' : 'S';
    await mkdir(dir);
    await writeFile(join(dir, 'status'), `Name:\t${info.name}\nState:\t${state}\nPid:\t${info.pid}\nPPid:\t${info.ppid}\nUid:\t1000\t1000\t1000\t1000\n`);
    await writeFile(join(dir, 'stat'), `${info.pid} (${info.name}) ${state} ${info.ppid} ${'0 '.repeat(17)}${1000 + info.pid} 0 0\n`);
    await writeFile(join(dir, 'cmdline'), `${info.name}\0`);
  }
  return proc;
}

test('the probe on a fake /proc: socat bridges, sandboxes and a zombie are no command; a live find is; a missing root, no root and no /proc are unknown', async () => {
  const base = [
    { pid: 7000100, name: 'bwrap', ppid: 7000001 },
    { pid: 7000101, name: 'bwrap', ppid: 7000100 },
    { pid: 7000200, name: 'claude', ppid: 7000101 },
    { pid: 7000300, name: 'socat', ppid: 7000200 },
    { pid: 7000301, name: 'socat', ppid: 7000200 },
    { pid: 7000302, name: 'bash', ppid: 7000200, zombie: true },
    // An empty Bash sandbox left below Claude Code.
    { pid: 7000400, name: 'bwrap', ppid: 7000200 },
  ];
  const quiet = await fakeProc(base);
  const busy = await fakeProc([...base, { pid: 7000401, name: 'bwrap', ppid: 7000400 }, { pid: 7000402, name: 'bash', ppid: 7000401 }, { pid: 7000403, name: 'find', ppid: 7000402 }]);
  const finding = await fakeProc([...base, { pid: 7000500, name: 'find', ppid: 7000400 }]);
  try {
    assert.equal(await commandProbe(7000100, { proc: quiet }), 'none');
    assert.equal(await commandProbe(7000100, { proc: busy }), 'alive');
    assert.equal(await commandProbe(7000100, { proc: finding }), 'alive');
    assert.equal(await commandProbe(7999999, { proc: quiet }), 'unknown');
    assert.equal(await commandProbe(undefined, { proc: quiet }), 'unknown');
    assert.equal(await commandProbe(7000100, { proc: join(quiet, 'missing') }), 'unknown');
    assert.equal(await commandProbe(7000100, { platform: 'darwin' }), 'unknown');
    // A root with no Claude Code below it, or a zombie one: unknown.
    const empty = await fakeProc([{ pid: 7000100, name: 'bwrap', ppid: 1 }]);
    const dead = await fakeProc([{ pid: 7000100, name: 'bwrap', ppid: 1 }, { pid: 7000200, name: 'claude', ppid: 7000100, zombie: true }]);
    assert.deepEqual([await commandProbe(7000100, { proc: empty }), await commandProbe(7000100, { proc: dead })], ['unknown', 'unknown']);
    await rm(empty, { recursive: true, force: true });
    await rm(dead, { recursive: true, force: true });
  } finally {
    for (const proc of [quiet, busy, finding]) {
      await rm(proc, { recursive: true, force: true });
    }
  }
});

test('oneLineCommand: whitespace runs and newlines one space, cut to 200 characters', () => {
  assert.equal(oneLineCommand(HEREDOC), "cat <<'EOF' > notes.txt first line second line EOF");
  const long = oneLineCommand(`echo ${'x'.repeat(300)}`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
  assert.equal(STALL_HARD_MS, 65 * 60_000);
});

test('SF_TOOL_STALL_MIN: unset is 10, 25 is 25, 0 is off; 61 and x are invalid_config', async () => {
  const state = await mkdtemp(join(tmpdir(), 'sf-stall-config-'));
  try {
    const env = { SF_STATE_DIR: state, SF_GATE: 'off' };
    assert.equal(loadConfig(env).toolStallMin, 10);
    assert.equal(loadConfig({ ...env, SF_TOOL_STALL_MIN: '25' }).toolStallMin, 25);
    assert.equal(loadConfig({ ...env, SF_TOOL_STALL_MIN: '0' }).toolStallMin, 0);
    for (const value of ['61', 'x']) {
      assert.throws(() => loadConfig({ ...env, SF_TOOL_STALL_MIN: value }), (error: { code?: string; message?: string }) => error.code === 'invalid_config' && /SF_TOOL_STALL_MIN/.test(error.message ?? ''), value);
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('sf watch: the stall\'s event in one line, resent and stopped', () => {
  const line = (action: string, reason: string): string => formatEvent(JSON.stringify({
    ts: '2026-11-24T10:00:00.000Z', iteration: 2, type: 'tool_stalled', tool: 'Bash', command: 'find / -name x | grep y', open_s: 1830, reason, action,
  }))[0]!.replace(/^\S+ /, '');
  assert.equal(line('resent', 'no_process'), "[2] a Bash command hung (open 31 min with no process of it running): find / -name x | grep y; the factory ended the turn and sent the turn's instruction again");
  assert.equal(line('stopped', 'past_cap'), "[2] a Bash command hung (open 31 min past the Bash tool's 60-minute cap): find / -name x | grep y; it hung again after the resend, so the job stops");
});

test('the Stream: a resent first prompt, its rules block included, is the factory\'s continuation with the note as its text', async () => {
  const ctx: StreamContext = {
    taskCopy: async () => undefined, meta: async () => undefined, review: async () => undefined, gate: async () => undefined, simplify: async () => undefined, ledger: async () => [],
  };
  const first = factoryPrompt('/implement .software-factory/T-1.md\n\n<rules>\nKeep it short.\n</rules>', 'T-1', 1);
  const note = stallNote({ tool: 'Bash', command: 'find / | grep x', openS: 700, reason: 'no_process' });
  const entries = await lineEntries(JSON.stringify({ ts: '2026-11-24T10:00:00.000Z', iteration: 1, prompt: `${first}\n\n${note}` }), 4, ctx);
  assert.deepEqual(entries.map((e) => (e.t === 'prompt' ? [e.who, e.kind, e.text] : [e.t])), [['factory', 'continue', note]]);
  const plain = await lineEntries(JSON.stringify({ ts: '2026-11-24T10:00:00.000Z', iteration: 1, prompt: first }), 3, ctx);
  assert.deepEqual(plain.map((e) => (e.t === 'prompt' ? [e.who, e.kind] : [e.t])), [['factory', 'implement']]);
});

test('the stop: tool_stalled is an error row whose actions are Tell it how, Tell it to go on and Abort', () => {
  assert.equal(STOPS.tool_stalled.kind, 'error');
  const job: Job = {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', continues: null, builds_on: null, builds_on_commit: null, base_commit: null, target_commit: null, worktree: '/wt/T-1', prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'needs_human', iteration: 2, session_id: 's1', mr: null,
    created_at: '2026-11-24T09:00:00.000Z', updated_at: '2026-11-24T09:00:00.000Z', error: { code: 'tool_stalled', message: 'A Bash command hung again.' },
  };
  const shown = jobActions(job, { ...NO_FACTS, mrHost: { host: 'github', reason: null } }, new Date('2026-11-24T10:00:00.000Z')).actions
    .map((a) => `${a.primary ? '*' : ''}${a.danger ? '!' : ''}${a.action}:${a.label}`);
  assert.deepEqual(shown, ['*say:Tell it how', 'goon:Tell it to go on', '!abort:Abort…']);
});
