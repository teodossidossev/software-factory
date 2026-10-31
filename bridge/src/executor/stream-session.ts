// SF-009: the conversation with one managed Claude Code process (claude -p, stream-json in and
// out). Messages go to its stdin as JSON lines, as data: never through a shell or a terminal.
// From its stdout only protocol events count:
//   system/init               the session id and the permission mode Claude Code actually uses;
//   system/compact_boundary   a completed compaction;
//   system/task_started,      a background task (a background command or subagent) started and
//   system/task_notification  ended, by task id (Review 02: a task still open means Claude is
//                             not idle even after its turn ended);
//   result                    the end of a turn: the observed boundary, with the denials
//                             (actions auto mode or the permission rules refused);
//   user (replayed)           the acknowledgment of one of our messages (--replay-user-messages):
//                             only an event carrying the uuid of the oldest message not yet
//                             acknowledged, and no tool result, counts (review 9bbf622d); a
//                             duplicate, a foreign or out-of-order uuid, or isReplay alone never
//                             does. Review 02 attributes a result to the latest message only if
//                             every message had been acknowledged first. Review 03 (R3-1): a
//                             result that arrives while a later message is unacknowledged leaves
//                             the correlation unresolved (unresolvedSince) until a result arrives
//                             that answers the latest message; a late acknowledgment never makes
//                             the earlier result that message's answer;
//                             Claude Code holds this replay until the first model output of the
//                             message's turn (static reading of 2.1.312 and 2.1.314): the first
//                             non-ping stream event with --include-partial-messages, which is why
//                             managed sessions pass it, else the first assistant message. It does
//                             not mean "read from stdin", and no time for it is guaranteed;
//   assistant, stream_event,  progress of a turn (progressAt): Claude Code is working. Other
//   user with a tool result   output (system events, unparsable lines) is not progress.
// Free text ("done") never ends a turn. Unparsable lines and other events are ignored, and none
// of the output is kept beyond the fields above and the content-free correlation log. stderr is drained and dropped (it could hold
// anything), so a full pipe never stalls the process.
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { ExecutionError } from '../execution/errors.js';
import { CorrelationLog, type RejectReason } from './correlation-log.js';
import type { ManagedProcess, SessionExit } from '../execution/runner.js';

export interface Denial {
  // A tool name, or for a shell command its Git subcommand ("Bash(git commit)"); never the input.
  action: string;
}

export interface TurnResult {
  kind: 'result';
  subtype: string;
  isError: boolean;
  numTurns: number | null;
  denials: Denial[];
  // Every permission mode reported by system/init since the previous turn ended.
  modes: string[];
  // How many of our messages Claude Code had acknowledged when this result arrived (Review 02).
  acked: number;
}

// mode: a system/init reported a permission mode other than auto; reported at once, before the turn ends.
export type TurnOutcome = TurnResult | { kind: 'exited'; exit: SessionExit } | { kind: 'mode'; mode: string };

// Whether a user event's message holds a tool result (Claude Code's own tool output, never one of
// our messages).
function carriesToolResult(message: unknown): boolean {
  const content = (message as { content?: unknown } | null)?.content;
  return Array.isArray(content) && content.some((part) => (part as { type?: unknown } | null)?.type === 'tool_result');
}

// Summarizes a permission_denials entry without keeping its input.
function denialOf(entry: unknown): Denial {
  const record = (entry ?? {}) as { tool_name?: unknown; tool_input?: { command?: unknown } };
  const tool = typeof record.tool_name === 'string' && /^[A-Za-z0-9_:.-]{1,64}$/.test(record.tool_name) ? record.tool_name : 'unknown';
  if (tool === 'Bash' && typeof record.tool_input?.command === 'string') {
    // Global options before the subcommand, including -C <dir> and -c <key=value> with their values.
    const git = /^\s*git\s+(?:(?:-C|-c)\s+\S+\s+|--?[^\s]+\s+)*([a-z][a-z-]{0,30})\b/.exec(record.tool_input.command);
    if (git) return { action: `Bash(git ${git[1]})` };
  }
  return { action: tool };
}

// Background task events: ids are kept as sha256 of the whole id (bounded memory, never exported,
// no aliasing of long ids). More than MAX_OPEN_TASKS open at once cannot be tracked: from then on
// this process counts as busy for good (fail closed; a reset starts a new process).
const MAX_OPEN_TASKS = 1000;
const taskKey = (id: string): string => createHash('sha256').update(id, 'utf8').digest('hex');

export class StreamSession {
  readonly sessionId: string;
  readonly #process: ManagedProcess;
  readonly #turns: TurnOutcome[] = [];
  #waiter: (() => void) | undefined;
  #modes: string[] = [];
  #initSessionIds = new Set<string>();
  #compactions = 0;
  #lines = 0;
  #sent = 0;
  #acked = 0;
  // Our messages not yet acknowledged, oldest first, and when each was sent (ms).
  readonly #pending: string[] = [];
  readonly #pendingSince: number[] = [];
  readonly #correlation = new CorrelationLog();
  #resultSeen = false;
  #replayMissing = false;
  // Review 03 (R3-1): when a result first arrived while the latest message was unacknowledged,
  // until a result answers it; and when Claude Code last reported progress of a turn (ms).
  #unresolvedSince: number | undefined;
  #progressAt = 0;
  readonly #openTasks = new Set<string>();
  #taskOverflow = false;
  readonly #runs = new Map<string, string>();
  #atResult = false;
  #exit: SessionExit | undefined;
  #stopped = false;

  // A result ends one turn, not necessarily the background work it started.
  get reviewReady(): boolean {
    return this.#atResult && this.openTasks === 0 && this.#turns.length === 0 && !this.exited;
  }

  // stop: resolves when the supervisor stops; a waiting nextTurn then returns undefined.
  constructor(child: ManagedProcess, sessionId: string, stop?: Promise<void>) {
    this.sessionId = sessionId;
    void stop?.then(() => {
      this.#stopped = true;
      this.#wake();
    });
    this.#process = child;
    child.errors.resume();
    child.input.on('error', () => undefined);
    const lines = createInterface({ input: child.output, crlfDelay: Infinity });
    lines.on('line', (line) => this.#event(line));
    // The exit is reported after every line of stdout was read, so a final result is never lost to it.
    const outputClosed = new Promise<void>((resolve) => lines.once('close', resolve));
    // (Bounded: a descendant that inherited stdout must not hide the exit.)
    void child.exited.then(async (exit) => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([outputClosed, new Promise<void>((resolve) => (timer = setTimeout(resolve, 2000)))]);
      clearTimeout(timer);
      this.#exit = exit;
      this.#turns.push({ kind: 'exited', exit });
      this.#wake();
    });
  }

  get pid(): number {
    return this.#process.pid;
  }

  get exited(): boolean {
    return this.#exit !== undefined;
  }

  get compactions(): number {
    return this.#compactions;
  }

  // Every stdout line counts (Review 02): output after a turn ended means Claude is still active.
  get activity(): number {
    return this.#lines;
  }

  // Background tasks Claude Code reported started and not yet ended (task ids are never exported).
  get openTasks(): number {
    return this.#openTasks.size + (this.#taskOverflow ? 1 : 0);
  }

  // How many messages were sent to this process.
  get sent(): number {
    return this.#sent;
  }

  // Messages sent and not yet acknowledged, and when the oldest of them was sent (ms).
  get unacknowledged(): number {
    return this.#pending.length;
  }

  get oldestUnacknowledgedAt(): number | undefined {
    return this.#pendingSince[0];
  }

  // False when the first result arrived although the first message was never acknowledged: this
  // Claude Code does not replay user messages, and later turn ends cannot be attributed.
  get correlated(): boolean {
    return !this.#replayMissing;
  }

  // Whether this result answers the latest message: every message sent had been acknowledged
  // before it arrived. Otherwise it ended an earlier turn (a late result of an earlier message).
  // Without replay only the first message's results can be attributed (nothing came before it).
  answers(turn: TurnResult): boolean {
    return turn.acked >= this.#sent || (this.#replayMissing && this.#sent === 1);
  }

  // Review 03 (R3-1): since when (ms) a result arrived that could not be attributed to the latest
  // message (it was not yet acknowledged) with no result attributed to it since: whether that
  // message will still be answered is unknown. undefined when nothing is unresolved.
  get unresolvedSince(): number | undefined {
    return this.#unresolvedSince;
  }

  // When (ms) Claude Code last reported progress of a turn (an assistant or stream event, or a tool
  // result); 0 before any.
  get progressAt(): number {
    return this.#progressAt;
  }

  // The content-free order of events around our messages (correlation-log.ts); end: why it is read.
  correlationReport(end: string): string[] {
    return this.#correlation.report(end);
  }

  // Outcomes observed but not yet taken by nextTurn (a further turn end, a mode report, the exit).
  get queued(): number {
    return this.#turns.length;
  }

  // Whether every system/init seen named this session (a mismatch would mean another conversation).
  get sessionMatches(): boolean {
    return [...this.#initSessionIds].every((id) => id === this.sessionId);
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.();
  }

  #event(line: string): void {
    this.#lines += 1;
    let event: { type?: unknown; subtype?: unknown; session_id?: unknown; permissionMode?: unknown; is_error?: unknown; num_turns?: unknown; permission_denials?: unknown; task_id?: unknown; uuid?: unknown; message?: unknown; run_id?: unknown; status?: unknown; patch?: { status?: unknown }; tasks?: unknown; queued_turn_count?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      return;
    }
    if (event === null || typeof event !== 'object') return;
    // Unknown text and task descriptions are never treated as lifecycle evidence.
    if (event.type === 'system' && ['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed'].includes(String(event.subtype))) {
      if (this.#taskOverflow) {
        this.#atResult = false;
        this.#wake();
        return;
      }
      if (event.session_id !== undefined && event.session_id !== this.sessionId) {
        return;
      }
      if (typeof event.task_id === 'string' && typeof event.run_id === 'string') {
        const latest = this.#runs.get(taskKey(event.task_id));
        if (latest !== undefined && event.run_id < latest) {
          return;
        }
        this.#runs.set(taskKey(event.task_id), event.run_id);
      }
      this.#atResult = false;
      if (event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks) && event.tasks.every((task) => task !== null && typeof task === 'object' && typeof task.task_id === 'string')) {
        this.#openTasks.clear();
        for (const task of event.tasks) {
          this.#openTasks.add(taskKey(task.task_id));
          if (typeof task.run_id === 'string') {
            const latest = this.#runs.get(taskKey(task.task_id));
            if (latest === undefined || task.run_id > latest) {
              this.#runs.set(taskKey(task.task_id), task.run_id);
            }
          }
        }
      } else if (typeof event.task_id === 'string') {
        const status = event.subtype === 'task_updated' ? event.patch?.status : event.status ?? (event.subtype === 'task_notification' ? 'completed' : undefined);
        if (['completed', 'failed', 'stopped', 'killed'].includes(String(status)) && (event.run_id !== undefined || !this.#runs.has(taskKey(event.task_id)))) {
          this.#openTasks.delete(taskKey(event.task_id));
        } else if (event.subtype === 'task_started' || event.subtype === 'task_progress' || ['pending', 'running', 'paused'].includes(String(status))) {
          this.#openTasks.add(taskKey(event.task_id));
        }
      }
      if (this.#openTasks.size > MAX_OPEN_TASKS || this.#runs.size > MAX_OPEN_TASKS) {
        this.#taskOverflow = true;
        this.#openTasks.clear();
        this.#runs.clear();
      }
      this.#wake();
      return;
    }
    this.#observe(event);
    if (['assistant', 'user', 'stream_event', 'tool_progress'].includes(String(event.type)) || (event.type === 'system' && event.subtype === 'init')) {
      this.#atResult = false;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.session_id === 'string') this.#initSessionIds.add(event.session_id);
      const mode = typeof event.permissionMode === 'string' ? event.permissionMode.slice(0, 32) : 'unknown';
      this.#modes.push(mode);
      if (mode !== 'auto') {
        this.#turns.push({ kind: 'mode', mode });
        this.#wake();
      }
    } else if (event.type === 'system' && event.subtype === 'compact_boundary') {
      this.#compactions += 1;
    } else if (event.type === 'user' && typeof event.uuid === 'string' && event.uuid === this.#pending[0] && !carriesToolResult(event.message)) {
      this.#pending.shift();
      this.#pendingSince.shift();
      this.#acked += 1;
    } else if (event.type === 'assistant' || event.type === 'stream_event' || (event.type === 'user' && carriesToolResult(event.message))) {
      this.#progressAt = Date.now();
    } else if (event.type === 'result') {
      this.#atResult = this.openTasks === 0 && (event.queued_turn_count === undefined || event.queued_turn_count === 0);
      if (!this.#resultSeen && this.#sent > 0 && this.#acked === 0) this.#replayMissing = true;
      this.#resultSeen = true;
      // Only later messages: the first one's results are attributed without replay (answers).
      if (this.#acked >= this.#sent) this.#unresolvedSince = undefined;
      else if (this.#sent > 1) this.#unresolvedSince ??= Date.now();
      this.#turns.push({
        acked: this.#acked,
        kind: 'result',
        subtype: typeof event.subtype === 'string' ? event.subtype.slice(0, 64) : 'unknown',
        isError: event.is_error === true,
        numTurns: typeof event.num_turns === 'number' && Number.isInteger(event.num_turns) ? event.num_turns : null,
        denials: Array.isArray(event.permission_denials) ? event.permission_denials.slice(0, 200).map(denialOf) : [],
        modes: this.#modes,
      });
      this.#modes = [];
      this.#wake();
    }
  }

  // Records how an event relates to our messages, before it changes them. Observation only.
  #observe(event: { type?: unknown; subtype?: unknown; uuid?: unknown; message?: unknown; isReplay?: unknown }): void {
    if (event.type === 'result') {
      this.#correlation.note('result', this.#pending.length === 0 ? 'after_ack' : 'before_ack');
    } else if (event.type === 'assistant') {
      this.#correlation.output('assistant');
    } else if (event.type === 'stream_event') {
      this.#correlation.output('stream_event');
    } else if (event.type === 'system' && event.subtype === 'init') {
      this.#correlation.output('init');
    } else if (event.type === 'user') {
      const uuid = typeof event.uuid === 'string' ? event.uuid : undefined;
      const tool = carriesToolResult(event.message);
      if (tool && (uuid === undefined || !this.#correlation.ours(uuid))) {
        this.#correlation.output('tool_result');
      } else if (uuid !== undefined && uuid === this.#pending[0] && !tool) {
        this.#correlation.note('ack_accepted', undefined, uuid);
      } else {
        this.#correlation.note('ack_rejected', `${this.#rejection(uuid, tool)}:${event.isReplay === true ? 'replay' : 'plain'}`, uuid);
      }
    }
  }

  #rejection(uuid: string | undefined, tool: boolean): RejectReason {
    if (uuid === undefined) {
      return 'no_uuid';
    }
    if (tool) {
      return 'tool_result';
    }
    if (this.#pending.includes(uuid)) {
      return 'out_of_order';
    }
    return this.#correlation.ours(uuid) ? 'duplicate' : 'foreign';
  }

  // One user message (one JSON line on stdin).
  async send(text: string): Promise<void> {
    if (this.#exit !== undefined) {
      this.#correlation.note('send_refused');
      throw new ExecutionError('session_ended', 'The Claude process has ended; the message was not sent.');
    }
    this.#atResult = false;
    const uuid = randomUUID();
    this.#correlation.own(uuid);
    this.#correlation.note('send', undefined, uuid);
    this.#pending.push(uuid);
    this.#pendingSince.push(Date.now());
    this.#sent += 1;
    const message = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: this.sessionId, uuid };
    await new Promise<void>((resolve, reject) => {
      this.#process.input.write(`${JSON.stringify(message)}\n`, (error) => {
        this.#correlation.note(error ? 'write_failed' : 'write_ok', undefined, uuid);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  // The next observed turn end, or the process's exit; undefined once the supervisor stops.
  async nextTurn(): Promise<TurnOutcome | undefined> {
    for (;;) {
      const next = this.#turns.shift();
      if (next !== undefined) return next;
      if (this.#stopped) return undefined;
      await new Promise<void>((resolve) => (this.#waiter = resolve));
    }
  }
}

// Summarizes denials as counts per action.
export function countDenials(denials: Denial[]): Array<{ action: string; count: number }> {
  const counts = new Map<string, number>();
  for (const denial of denials) counts.set(denial.action, (counts.get(denial.action) ?? 0) + 1);
  return [...counts].slice(0, 50).map(([action, count]) => ({ action, count }));
}
