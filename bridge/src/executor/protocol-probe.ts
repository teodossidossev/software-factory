// SF-009 Review 03 (R3-3): an operator-invoked probe of the real Claude Code stream-json protocol
// that managed sessions depend on (stream-session.ts). Fake-Claude tests prove only the fake; this
// records, for the installed CLI and the exact managed argument list (runner.ts), how two messages
// are acknowledged (--replay-user-messages: the replayed user event and its uuid) relative to the
// results, which permission mode system/init reports, and whether the process stays alive between
// turns and exits once its input ends. The second message is review-style.
//
// Safety: it is never run by the supervisor or by tests against the real CLI. It takes the
// host-wide session gate like every launch (a busy gate refuses; no parallel session), refuses
// inside a Claude Code or managed session, and runs only in an empty directory the operator
// created for it. The messages ask for a one-word reply and no tool use. The report keeps the
// event shape only (types, subtypes, the permission mode, which of our uuids an acknowledgment
// carried, timings): no text, prompt, transcript, stderr, session id or path.
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { ExecutionError, type ExecutionErrorCode } from '../execution/errors.js';
import { identify, isAlive, type ProcessIdentity } from '../execution/process-identity.js';
import { CLAUDE_SESSION_MARKERS, SESSION_TAG, type ClaudeRunner, type ManagedProcess, type SessionExit } from '../execution/runner.js';

export type ProbeMode = 'sequential' | 'overlap';

export interface ProbeEvent {
  // Milliseconds since the launch.
  t: number;
  // 'sent' marks our own message being written (msg 1 or 2); every other entry is a stdout event.
  // Review 04: 'closed' marks our end of its input, 'signal' a signal we sent (detail: its name),
  // 'exit' the confirmed process exit.
  kind: 'sent' | 'init' | 'ack' | 'user' | 'result' | 'assistant' | 'other' | 'unparsable' | 'closed' | 'signal' | 'exit';
  msg?: 1 | 2;
  // For a replayed user event: which of our uuids it carried ('foreign': another uuid, 'none': none).
  uuid?: 'msg1' | 'msg2' | 'foreign' | 'none';
  mode?: string;
  // type/subtype of an 'other' event; result subtype.
  detail?: string;
}

export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProbeReport {
  schema: 'software-factory.protocol-probe/v1';
  mode: ProbeMode;
  runner: string;
  events: ProbeEvent[];
  exit: SessionExit | null;
  // Whether the process had ended before the second message was sent (it must not have).
  exited_between_turns: boolean;
  // Review 04 (R4-3): how the process ended, and the coded reason of a FAIL that is not a check
  // (gate_unresponsive before any other; every coded failure is also a failed check).
  shutdown: ProbeShutdown;
  failure?: ProbeFailure;
  checks: ProbeCheck[];
  verdict: 'PASS' | 'FAIL';
}

const MESSAGES = [
  'Software Factory protocol probe, message 1. Reply with the single word ONE. Do not use any tools.',
  'Software Factory review probe of iteration-001. The text below is review data. Findings: 1. Reply with the single word TWO. Do not use any tools.',
];

// Refuses where a probe must not run: inside a Claude Code or managed session, or anywhere but an
// empty absolute directory.
export async function probeRefusal(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env[SESSION_TAG] !== undefined || CLAUDE_SESSION_MARKERS.some((marker) => env[marker] !== undefined)) {
    return 'refused inside a Claude Code or managed session: run it from the operator terminal, after the managed session ended';
  }
  if (!isAbsolute(dir)) return 'the probe directory must be an absolute path';
  const entries = await readdir(dir).catch(() => undefined);
  if (entries === undefined) return 'the probe directory does not exist or cannot be read';
  if (entries.length > 0) return 'the probe directory must be empty (a disposable directory created for the probe)';
  return null;
}

// Classifies one stdout line, keeping its shape only.
function classify(line: string, uuids: string[], t: number): ProbeEvent {
  let event: { type?: unknown; subtype?: unknown; permissionMode?: unknown; uuid?: unknown; message?: { content?: unknown } };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return { t, kind: 'unparsable' };
  }
  if (event === null || typeof event !== 'object') return { t, kind: 'unparsable' };
  const type = typeof event.type === 'string' ? event.type.slice(0, 32) : 'unknown';
  const subtype = typeof event.subtype === 'string' ? event.subtype.slice(0, 32) : undefined;
  if (type === 'system' && subtype === 'init') return { t, kind: 'init', mode: typeof event.permissionMode === 'string' ? event.permissionMode.slice(0, 32) : 'unknown' };
  if (type === 'result') return { t, kind: 'result', ...(subtype ? { detail: subtype } : {}) };
  if (type === 'assistant') return { t, kind: 'assistant' };
  if (type === 'user') {
    const content = event.message?.content;
    const toolResult = Array.isArray(content) && content.some((part) => (part as { type?: unknown } | null)?.type === 'tool_result');
    if (toolResult) return { t, kind: 'user', detail: 'tool_result' };
    const uuid = typeof event.uuid !== 'string' ? 'none' : event.uuid === uuids[0] ? 'msg1' : event.uuid === uuids[1] ? 'msg2' : 'foreign';
    return { t, kind: 'ack', uuid };
  }
  return { t, kind: 'other', detail: subtype ? `${type}/${subtype}` : type };
}

// The checks the supervisor relies on (stream-session.ts), on a recorded event list. Review 04
// (R4-1): every required event is located and ordered explicitly; a duplicate, missing or extra
// event fails, so a later result can never stand in for a missing answer. R4-2: only a normal exit
// with code 0, on its own after the input closed (not after a signal we sent) and not before
// message 2, passes.
export function analyzeProbe(mode: ProbeMode, events: ProbeEvent[], exit: SessionExit | null, exitedBetweenTurns: boolean): ProbeCheck[] {
  const at = (predicate: (event: ProbeEvent) => boolean) => events.flatMap((event, index) => (predicate(event) ? [index] : []));
  // The index of the only matching event, or -1 when there is none or more than one.
  const only = (positions: number[]) => (positions.length === 1 ? positions[0]! : -1);
  const sends1 = at((event) => event.kind === 'sent' && event.msg === 1);
  const sends2 = at((event) => event.kind === 'sent' && event.msg === 2);
  const acks1 = at((event) => event.kind === 'ack' && event.uuid === 'msg1');
  const acks2 = at((event) => event.kind === 'ack' && event.uuid === 'msg2');
  const results = at((event) => event.kind === 'result');
  const [sent1, sent2, ack1, ack2] = [only(sends1), only(sends2), only(acks1), only(acks2)];
  // Exactly two results: the first answers message 1, the second message 2.
  const [result1, result2] = results.length === 2 ? [results[0]!, results[1]!] : [-1, -1];
  const closed = only(at((event) => event.kind === 'closed'));
  const exitAt = only(at((event) => event.kind === 'exit'));
  const signalled = events.some((event) => event.kind === 'signal');
  const ordered = (...positions: number[]) => positions.every((position, index) => position >= 0 && (index === 0 || positions[index - 1]! < position));
  const inits = events.filter((event) => event.kind === 'init');
  const foreign = events.filter((event) => event.kind === 'ack' && (event.uuid === 'foreign' || event.uuid === 'none')).length;
  const order = events.filter((event) => event.kind !== 'assistant' && event.kind !== 'other').map((event) => (event.kind === 'sent' ? `sent${event.msg}` : event.kind === 'ack' ? `ack:${event.uuid}` : event.kind)).join(' ');
  const count = (name: string, positions: number[]) => `${positions.length} ${name}`;
  const cleanExit = exit !== null && exit.code === 0 && exit.signal === null;
  const checks: ProbeCheck[] = [
    { name: 'init_mode_auto', ok: inits.length > 0 && inits.every((event) => event.mode === 'auto'), detail: `system/init modes: ${inits.map((event) => event.mode).join(', ') || 'none'}` },
    { name: 'ack1_exact_uuid', ok: ack1 >= 0, detail: `${count('replayed user event(s) carried message 1 uuid', acks1)} (exactly one required)` },
    { name: 'ack1_before_first_result', ok: ordered(sent1, ack1, result1), detail: `sent at ${sent1}, ack at ${ack1}, first result at ${result1}` },
    { name: 'ack2_exact_uuid', ok: ack2 >= 0, detail: `${count('replayed user event(s) carried message 2 uuid', acks2)} (exactly one required)` },
    { name: 'two_results', ok: results.length === 2, detail: `${results.length} result(s) (exactly two required)` },
    { name: 'no_foreign_acknowledgments', ok: foreign === 0, detail: `${foreign} replayed user event(s) with another or no uuid` },
    { name: 'alive_between_turns', ok: sent2 >= 0 && !exitedBetweenTurns, detail: exitedBetweenTurns ? 'the process ended before message 2' : sent2 < 0 ? 'message 2 was not sent exactly once' : 'the process was running when message 2 was sent' },
    {
      name: 'exits_after_input_closed',
      ok: cleanExit && !exitedBetweenTurns && !signalled && ordered(closed, exitAt),
      detail:
        exit === null
          ? 'the exit was not confirmed'
          : `exit code ${exit.code} signal ${exit.signal}${exitedBetweenTurns ? ', before message 2' : ''}${signalled ? ', after a signal we sent' : ''}${ordered(closed, exitAt) ? '' : ', not after the input closed'} (code 0, no signal, on its own after the input closed required)`,
    },
  ];
  if (mode === 'sequential') {
    // Message 2 is sent only after result 1, and is acknowledged before the result that answers it.
    checks.push({ name: 'result1_before_send2', ok: ordered(sent1, ack1, result1, sent2), detail: `result 1 at ${result1}, message 2 sent at ${sent2}` });
    checks.push({ name: 'ack2_before_its_result', ok: ordered(result1, sent2, ack2, result2), detail: `sent at ${sent2}, ack at ${ack2}, its result at ${result2}` });
  } else {
    // Message 2 is sent while turn 1 may still run: recorded, and it must not be acknowledged
    // before message 1 (the supervisor requires acknowledgments in order). Each message still needs
    // its own result after its acknowledgment.
    checks.push({ name: 'acks_in_order', ok: ordered(sent1, ack1, ack2) && ordered(sent1, sent2, ack2), detail: `ack1 at ${ack1}, ack2 at ${ack2}` });
    checks.push({ name: 'results_after_their_acks', ok: ordered(ack1, result1) && ordered(ack2, result2), detail: `results at ${result1} and ${result2}` });
  }
  checks.push({ name: 'order', ok: true, detail: order.slice(0, 500) });
  return checks;
}

// How the process ended: on its own after its input closed, by SIGTERM, by SIGKILL, or not shown.
export type ProbeShutdown = 'exited' | 'sigterm' | 'sigkill' | 'unconfirmed';

export interface ProbeFailure {
  // first_result_timeout: no result 1 within the bound, so message 2 was not sent (sequential).
  // input_failed: a message could not be written. gate_unresponsive: the process could not be
  // shown to have ended; it may still hold the session gate (operator attention, see the runbook).
  code: 'first_result_timeout' | 'input_failed' | 'gate_unresponsive';
  detail: string;
}

// The process operations of the shutdown (a test seam; the default is the real process table).
export interface ProbeProcessControl {
  identify(pid: number): Promise<ProcessIdentity | undefined>;
  isAlive(identity: ProcessIdentity): Promise<boolean>;
  kill(pid: number, signal: NodeJS.Signals): void;
}

const HOST: ProbeProcessControl = { identify, isAlive, kill: (pid, signal) => void process.kill(pid, signal) };

export interface ProbeOptions {
  mode: ProbeMode;
  // Bound on each turn, and on the exit after stdin closed (default 120 s and 30 s).
  turnTimeoutMs?: number;
  exitTimeoutMs?: number;
  // Review 04 (R4-3): the bounds after SIGTERM and after SIGKILL (default 10 s and 5 s).
  termWaitMs?: number;
  killWaitMs?: number;
  processControl?: ProbeProcessControl;
}

// Launches one managed process through the runner (gate, managed arguments, session tag), sends two
// messages and records the event shape. The caller checked probeRefusal first. Every wait is
// bounded (R4-3): a process that cannot be shown to have ended is reported as gate_unresponsive
// and the gate is left to it, never released on uncertain liveness.
export async function runProtocolProbe(runner: ClaudeRunner, cwd: string, options: ProbeOptions): Promise<ProbeReport> {
  const turnTimeoutMs = options.turnTimeoutMs ?? 120_000;
  const exitTimeoutMs = options.exitTimeoutMs ?? 30_000;
  const termWaitMs = options.termWaitMs ?? 10_000;
  const killWaitMs = options.killWaitMs ?? 5000;
  const control = options.processControl ?? HOST;
  const reservation = await runner.reserve();
  if ('busy' in reservation) throw new ExecutionError('session_busy', 'Another Software Factory Claude session holds the session gate; the probe was not started.');
  if (reservation.launchManaged === undefined) {
    await reservation.release();
    throw new ExecutionError('runner_unavailable', 'The probe needs the managed runner.');
  }
  const sessionId = randomUUID();
  let child: ManagedProcess;
  try {
    child = await reservation.launchManaged({ cwd, sessionId, name: 'sf009-protocol-probe' });
  } catch (error) {
    // No known child. The gate helper decides: a reservation it already used keeps the gate with
    // whatever it launched (release is a no-op), an unused one is stopped with its bounded release.
    try {
      await reservation.release();
    } catch (releaseError) {
      throw new ExecutionError(
        'gate_unresponsive',
        `The probe could not be launched (${(error as Error).message}), and the session gate could not be given back: ${(releaseError as Error).message}`,
      );
    }
    // Review 05 (R5-1): a non-start whose helper process is still there (e.g. it lingered after
    // EXECFAIL and could not be stopped) may still hold the gate: reported as gate_unresponsive, so
    // that the command detaches (probeCommand). A pid that cannot be read, or that was reused, counts
    // as still there (fail closed: the command then exits 4 instead of 1).
    const helperGone = (await control.identify(reservation.holderPid).catch(() => 'unreadable' as const)) === undefined;
    if (error instanceof ExecutionError && error.code === 'runner_unavailable' && !helperGone) {
      throw new ExecutionError('gate_unresponsive', `${error.message} The gate helper (pid ${reservation.holderPid}) is still running and may hold the session gate.`);
    }
    throw error;
  }
  // The child as launched: every later signal first re-checks this identity (a reused pid is never signalled).
  // An unreadable identity is undefined: then nothing is ever signalled (fail closed).
  const identity = await control.identify(child.pid).catch(() => undefined);
  const started = Date.now();
  const events: ProbeEvent[] = [];
  const uuids: string[] = [];
  let waiter: (() => void) | undefined;
  child.errors.resume();
  child.input.on('error', () => undefined);
  const lines = createInterface({ input: child.output, crlfDelay: Infinity });
  lines.on('line', (line) => {
    events.push(classify(line, uuids, Date.now() - started));
    waiter?.();
  });
  let exit: SessionExit | null = null;
  child.exited.then(
    (value) => {
      exit = value;
      events.push({ t: Date.now() - started, kind: 'exit' });
      waiter?.();
    },
    () => undefined,
  );
  const results = () => events.filter((event) => event.kind === 'result').length;
  const until = async (done: () => boolean, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (!done() && exit === null && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now())));
        waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    waiter = undefined;
    return done();
  };
  const exited = (ms: number) => until(() => exit !== null, ms);
  const send = async (n: 1 | 2): Promise<void> => {
    const uuid = randomUUID();
    uuids.push(uuid);
    events.push({ t: Date.now() - started, kind: 'sent', msg: n });
    const message = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: MESSAGES[n - 1] }] }, parent_tool_use_id: null, session_id: sessionId, uuid };
    await new Promise<void>((resolve, reject) => child.input.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve())));
  };
  // A signal only to the verified child: 'sent', 'gone' (no longer that process), or 'refused'
  // (EPERM or any other error: its identity is uncertain, so nothing further is sent).
  const signal = async (name: NodeJS.Signals): Promise<'sent' | 'gone' | 'refused'> => {
    if (exit !== null) return 'gone';
    if (identity === undefined) return 'gone';
    // An identity check that fails is uncertainty, never permission to signal.
    const verified = await control.isAlive(identity).then(
      (alive) => (alive ? 'alive' : 'gone'),
      () => 'refused' as const,
    );
    if (verified !== 'alive') return verified;
    try {
      control.kill(child.pid, name);
      events.push({ t: Date.now() - started, kind: 'signal', detail: name });
      return 'sent';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'refused';
    }
  };
  // Close input; bounded wait; SIGTERM; bounded wait; SIGKILL; final bounded wait.
  const shutdown = async (): Promise<ProbeShutdown> => {
    try {
      child.input.end();
    } catch {
      // A broken input still counts as closed: the bounded steps below decide.
    }
    events.push({ t: Date.now() - started, kind: 'closed' });
    if (await exited(exitTimeoutMs)) return 'exited';
    const term = await signal('SIGTERM');
    if (term === 'sent' && (await exited(termWaitMs))) return 'sigterm';
    const kill = term === 'refused' ? 'refused' : await signal('SIGKILL');
    if (await exited(killWaitMs)) return kill === 'sent' ? 'sigkill' : term === 'sent' ? 'sigterm' : 'exited';
    return 'unconfirmed';
  };
  let exitedBetweenTurns = false;
  // Every coded failure, in order; the report's `failure` is the one needing the operator most.
  const failures: ProbeFailure[] = [];
  try {
    await send(1);
    if (options.mode === 'sequential' && !(await until(() => results() >= 1, turnTimeoutMs))) {
      // R4-1: a sequential probe never turns into an overlap probe.
      failures.push({ code: 'first_result_timeout', detail: exit !== null ? 'the process ended before result 1; message 2 was not sent' : `no result 1 within ${turnTimeoutMs} ms; message 2 was not sent` });
    }
    exitedBetweenTurns = exit !== null;
    if (failures.length === 0 && !exitedBetweenTurns) {
      await send(2);
      await until(() => results() >= 2, turnTimeoutMs);
    }
  } catch (error) {
    // The error code only (e.g. EPIPE): a message never carries text or a path into the report.
    const code = (error as NodeJS.ErrnoException).code;
    failures.push({ code: 'input_failed', detail: `a message could not be written to the process input${typeof code === 'string' ? ` (${code.slice(0, 32)})` : ''}` });
  }
  // Never rejects: an unexpected error ends the steps; an exit that was not seen is 'unconfirmed'.
  const ended = await shutdown().catch((): ProbeShutdown => (exit !== null ? 'exited' : 'unconfirmed'));
  lines.close();
  if (ended === 'unconfirmed') {
    // Not released: the gate stays with the process until it ends. Our ends of its pipes are closed.
    child.output.destroy();
    child.errors.destroy();
    failures.push({
      code: 'gate_unresponsive',
      detail: `the probe process did not end within the bounds after its input closed, SIGTERM and SIGKILL; it may still hold the session gate (see the runbook, "gate_unresponsive")`,
    });
  } else {
    await reservation.release().catch(() => undefined);
  }
  const checks = analyzeProbe(options.mode, events, exit, exitedBetweenTurns);
  checks.unshift(...failures.map((failure) => ({ name: failure.code, ok: false, detail: failure.detail })));
  const failure = failures.find((entry) => entry.code === 'gate_unresponsive') ?? failures[0];
  return {
    schema: 'software-factory.protocol-probe/v1',
    mode: options.mode,
    runner: runner.identity.slice(0, 64),
    events: events.slice(0, 500),
    exit,
    exited_between_turns: exitedBetweenTurns,
    shutdown: ended,
    ...(failure !== undefined ? { failure } : {}),
    checks,
    verdict: checks.every((check) => check.ok) ? 'PASS' : 'FAIL',
  };
}

// The operator command's end of a probe (main.ts): prints the report; exit code 0 on PASS, 3 on
// FAIL. Review 04 iteration-002: when the process could not be shown to have ended (shutdown
// 'unconfirmed', gate_unresponsive), Node would stay attached to its child handle indefinitely.
// So the command prints a diagnostic and exits with code 4 by itself. This detaches only: the
// process is not signalled again, nothing is released (the gate lock is the child's own inherited
// descriptor, so the child keeps the gate until it really ends), and nothing else is started.
export async function reportProbe(report: ProbeReport, exit: (code: number) => never = process.exit): Promise<number> {
  await written(process.stdout, `${JSON.stringify(report, null, 2)}\n`);
  if (report.shutdown !== 'unconfirmed') return report.verdict === 'PASS' ? 0 : 3;
  await written(
    process.stderr,
    'sf009-executor: gate_unresponsive: the probe process could not be shown to have ended after its input closed, SIGTERM and SIGKILL. ' +
      'It may still hold the session gate, so no session can start. This command exits without releasing it; find and end the holder ' +
      'yourself (see the runbook, "The gate stays busy").\n',
  );
  return exit(4);
}

// The errors after which a process the probe started (the gate helper, or what it handed over to)
// may still be alive: launch_unconfirmed (the hand-over was not confirmed) and gate_unresponsive
// (taking or giving back the gate could not be shown complete).
const UNCERTAIN_LIVENESS: ReadonlySet<ExecutionErrorCode> = new Set(['launch_unconfirmed', 'gate_unresponsive']);

// The operator command's probe branch (main.ts). Review 05 (R5-1): a probe that throws one of those
// errors would leave Node attached to the live helper's handle and pipes indefinitely, so, like a
// report with shutdown 'unconfirmed', the command prints a diagnostic and exits with code 4 by
// itself, detaching only: nothing is released, signalled or started. Any other error is the
// generic handler's (code 1), as before.
export async function probeCommand(run: () => Promise<ProbeReport>, exit: (code: number) => never = process.exit): Promise<number> {
  let report: ProbeReport;
  try {
    report = await run();
  } catch (error) {
    if (!(error instanceof ExecutionError) || !UNCERTAIN_LIVENESS.has(error.code)) throw error;
    // Coded messages are the adapter's own (pids, no paths or secrets), as the generic handler prints them.
    await written(
      process.stderr,
      `sf009-executor: ${error.code}: ${error.message}\n` +
        'sf009-executor: unless the message above says the gate is free again, a process the probe started may still be running and hold ' +
        'the session gate. This command exits with code 4 without releasing the session gate or signalling anything; check `status`, ' +
        'and find and end any holder yourself (see the runbook, "The gate stays busy").\n',
    );
    return exit(4);
  }
  return reportProbe(report, exit);
}

const written = (stream: NodeJS.WriteStream, text: string) => new Promise<void>((resolve) => stream.write(text, () => resolve()));
