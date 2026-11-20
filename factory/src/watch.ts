// `sf watch`: reads a job's events.jsonl directly (no server needed) and prints readable lines.
// The dashboard's event stream uses the same reading loop (followLines) and formatting (describeEvent).
import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import { FactoryError } from './errors.js';
import { localTime } from './local-time.js';

const INPUT_CHARS = 120;
const LINE_CHARS = 200;
const POLL_MS = 300;
// The first lines of a Codex command's output shown when it completes.
const OUTPUT_LINES = 3;

function oneLine(text: string, max = LINE_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function blocks(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : '')).join(' ');
  }
  return '';
}

export interface DescribedEvent {
  ts: string | null;
  iteration: number | null;
  // "prompt", "state", "notify_failed", "placeholders_removed", "review", "review_failed" (Claude's or the gate's), "gate_overridden" (the user accepted over the stopped gate), "gate_level", "simplify" and "simplify_chosen", "interrupted" and "task_changed", "attachments", "turn_limit_continued", "turn_stream_stuck", "sandbox_lock_removed", "mr_edited", "gate_event" (a Codex event of the gate), "review_message" (a message of the Claude review), or the SDK message type ("assistant", "user", "result", "system", ...).
  type: string;
  lines: string[];
}

// One events.jsonl record as its time, iteration, kind and printable lines; undefined for a line
// that is not a JSON object.
export function describeEvent(raw: string): DescribedEvent | undefined {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch { // not JSON: not an event
    return undefined;
  }
  if (typeof record !== 'object' || record === null) {
    return undefined;
  }
  const message = record.message as { type?: unknown } | undefined;
  const type = typeof record.prompt === 'string' ? 'prompt'
    : record.state !== undefined ? 'state'
    : typeof record.type === 'string' ? record.type
    : typeof message?.type === 'string' ? message.type
    : 'unknown';
  return {
    ts: typeof record.ts === 'string' ? record.ts : null,
    iteration: typeof record.iteration === 'number' ? record.iteration : null,
    type,
    lines: recordLines(record),
  };
}

// The printable lines of one events.jsonl record (none for messages without visible content).
export function formatEvent(raw: string): string[] {
  return describeEvent(raw)?.lines ?? [];
}

// The line of a state change into or out of waiting_limit: parked on a usage limit, or
// resumed from it into the turn or the review; undefined for any other change.
export function limitStateText(from: unknown, to: unknown): string | undefined {
  if (to === 'waiting_limit') {
    return 'Parked: usage limit reached';
  }
  if (from === 'waiting_limit' && (to === 'working' || to === 'awaiting_review')) {
    return 'Resumed after the usage limit reset';
  }
  return undefined;
}

// One image of an attachments event: its name, type and size.
function asImage(value: unknown): string {
  const image = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return `${String(image.name)} (${String(image.type)}, ${String(image.bytes)} bytes)`;
}

function recordLines(record: Record<string, unknown>): string[] {
  const time = localTime(record.ts)?.slice(11) ?? '--:--:--';
  const prefix = `${time} [${String(record.iteration)}]`;
  if (typeof record.prompt === 'string') {
    // The factory's fixed rules block after the prompt is the same every time; it is not shown.
    const rules = record.prompt.indexOf('\n\nRules from the Software Factory:');
    return [`${prefix} > ${oneLine(rules < 0 ? record.prompt : record.prompt.slice(0, rules))}`];
  }
  const state = record.state as { from: string | null; to: string; error?: { code: string; message: string } } | undefined;
  if (state !== undefined) {
    // The park on a usage limit and the resume from it.
    const limit = limitStateText(state.from, state.to);
    if (limit !== undefined) {
      return [`${prefix} ${limit}`];
    }
    const error = state.error !== undefined ? ` (${state.error.code}: ${state.error.message})` : '';
    return [`${prefix} state ${state.from ?? '-'} -> ${state.to}${error}`];
  }
  if (record.type === 'notify_failed') {
    return [`${prefix} notification via ${String(record.channel)} failed: ${oneLine(String(record.message))}`];
  }
  if (record.type === 'placeholders_removed') {
    const paths = Array.isArray(record.paths) ? record.paths.map(String) : [];
    return [`${prefix} placeholders removed: ${oneLine(paths.join(', '))}`];
  }
  if (record.type === 'review' || record.type === 'review_failed') {
    const ignored = record.ignored === true ? ' (ignored: the job had moved on)' : '';
    if (record.type === 'review_failed') {
      return [`${prefix} review by ${String(record.reviewer)} failed: ${oneLine(String(record.error))}${ignored}`];
    }
    const count = typeof record.items === 'number' ? record.items : 0;
    const items = record.verdict === 'fix' ? ` (${count} ${count === 1 ? 'item' : 'items'})` : '';
    // The verdict the factory acted on, when it is not the reviewer's.
    const effective = record.effective === 'clean' || record.effective === 'fix' ? `, acted on as ${record.effective}` : '';
    return [`${prefix} review by ${String(record.reviewer)}: ${String(record.verdict)}${items}${effective}${ignored}`];
  }
  // The gate level of the iteration: whether the gate runs, and why.
  if (record.type === 'gate_level') {
    const reasons = Array.isArray(record.reasons) ? record.reasons.map(String).join('; ') : '';
    return [`${prefix} Codex gate: ${String(record.level)}, ${record.ran === true ? 'runs' : 'skipped'} (${oneLine(reasons)})`];
  }
  if (record.type === 'gate_overridden') {
    const count = typeof record.unapplied === 'number' ? record.unapplied : 0;
    return [`${prefix} gate overridden by the user (${String(record.code)}): ${count} Codex ${count === 1 ? 'item' : 'items'} not applied`];
  }
  // The simplification pass: its outcome, and the user's choice on its offer.
  if (record.type === 'simplify') {
    const ignored = record.ignored === true ? ' (ignored: the job had moved on)' : '';
    if (typeof record.error === 'string') {
      return [`${prefix} simplification pass failed: ${oneLine(record.error)}${ignored}`];
    }
    const count = typeof record.suggestions === 'number' ? record.suggestions : 0;
    const dropped = typeof record.dropped === 'number' && record.dropped > 0 ? `, ${record.dropped} dropped (they would undo a fixed blocker)` : '';
    return [`${prefix} simplification pass: ${count} ${count === 1 ? 'suggestion' : 'suggestions'}${dropped}${ignored}`];
  }
  if (record.type === 'simplify_chosen') {
    const count = typeof record.suggestions === 'number' ? record.suggestions : 0;
    return [`${prefix} simplification ${record.choice === 'skip' ? 'skipped' : 'chosen'} by the user: ${count} ${count === 1 ? 'suggestion' : 'suggestions'}`];
  }
  // The last review: its comments, its error or its time limit (LAST_REVIEW_TIMEOUT_MS of
  // src/last-review.ts, written out so the display does not load the session's module).
  if (record.type === 'last_review') {
    const ignored = record.ignored === true ? ' (ignored: the job had moved on)' : '';
    if (record.timed_out === true) {
      return [`${prefix} last review timed out after 10 minutes${ignored}`];
    }
    if (typeof record.error === 'string') {
      return [`${prefix} last review failed: ${oneLine(record.error)}${ignored}`];
    }
    const count = typeof record.comments === 'number' ? record.comments : 0;
    return [`${prefix} last review: ${count} ${count === 1 ? 'comment' : 'comments'}${ignored}`];
  }
  // A step the user's Pause interrupted, and a Task file changed while paused.
  if (record.type === 'interrupted') {
    const who = typeof record.reviewer === 'string' ? ` by ${record.reviewer}` : '';
    return [`${prefix} ${String(record.step)}${who} interrupted by the pause (no verdict; it runs again on Resume)`];
  }
  // The job's images, resolved and copied.
  if (record.type === 'attachments') {
    const images = Array.isArray(record.images) ? record.images.map((image) => asImage(image)) : [];
    return [`${prefix} attachments: ${images.length === 0 ? 'none' : images.join(', ')}`];
  }
  if (record.type === 'task_changed') {
    return [`${prefix} the Task file changed while the job was paused; the new one is in use`];
  }
  // An Implementer turn ended at the turn limit while making progress; the factory went on.
  if (record.type === 'turn_limit_continued') {
    const changed = typeof record.changed_paths === 'number' ? `, ${record.changed_paths} changed ${record.changed_paths === 1 ? 'path' : 'paths'}` : '';
    return [`${prefix} turn limit of ${String(record.max_turns)} steps reached while making progress${changed}; the factory went on by itself (${String(record.continued)} of ${String(record.allowed)})`];
  }
  // A turn's stream stayed open after its result; the factory ended Claude Code and kept the result.
  if (record.type === 'turn_stream_stuck') {
    return [`${prefix} the turn's result came but Claude Code did not end within ${String(record.waited_s)} s (a background task kept it); the factory ended it and kept the result`];
  }
  // The sandbox's leftover config lock, removed by the factory.
  if (record.type === 'sandbox_lock_removed') {
    return [`${prefix} removed the config lock the sandbox left: ${String(record.path)}`];
  }
  // The MR text: the user's save or reset, or a new Clean that kept the user's text.
  if (record.type === 'mr_edited') {
    const line = { saved: 'You edited the MR text', reset: "You reset the MR text to the factory's", factory_new: 'Clean wrote a new MR text; yours is kept. Compare or reset on the Merge request screen.' }[String(record.action)];
    if (line === undefined) {
      return [`${prefix} MR text: ${String(record.action)}`];
    }
    const moved = [typeof record.branch === 'string' ? `branch ${record.branch}` : '', typeof record.base === 'string' ? `base ${record.base}` : ''].filter((part) => part !== '');
    return [`${prefix} ${line}${moved.length > 0 ? ` (${moved.join(', ')})` : ''}`];
  }
  // MR preparation committed nothing: the worktree changed since the reviewed iteration.
  if (record.type === 'unreviewed_change') {
    const more = typeof record.more === 'number' && record.more > 0 ? ` and ${record.more} more` : '';
    const what = Array.isArray(record.paths) ? `${record.paths.map(String).join(', ')}${more}` : 'the worktree';
    return [`${prefix} nothing committed: ${oneLine(what)} changed since iteration ${String(record.iteration)} was reviewed; back to review`];
  }
  if (record.type === 'merge_request') {
    const verb = { created: 'opened', reused: 'already open, reused', merged: 'merged', updated: `found ${String(record.mr_state)} on the host`, found: 'found open for the branch' }[String(record.action)] ?? String(record.action);
    return [`${prefix} merge request #${String(record.number)} ${verb}: ${String(record.url)}`];
  }
  if (record.type === 'gate_event' || record.type === 'review_message') {
    return reviewerLines(record).map((line) => `${prefix} ${line}`);
  }
  const message = record.message as Record<string, unknown> | undefined;
  if (message === undefined) {
    return [];
  }
  if (message.type === 'system' && message.subtype === 'init') {
    return [`${prefix} session ${String(message.session_id)} (permission mode ${String(message.permissionMode)}, model ${String(message.model)})`];
  }
  if (message.type === 'assistant') {
    return blocks(message).flatMap((block) => {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        return block.text
          .trim()
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line, index) => `${prefix} ${index === 0 ? 'assistant:' : '          '} ${line}`);
      }
      if (block.type === 'tool_use') {
        return [`${prefix} tool_use ${String(block.name)} ${JSON.stringify(block.input ?? {}).slice(0, INPUT_CHARS)}`];
      }
      return [];
    });
  }
  if (message.type === 'user') {
    return blocks(message)
      .filter((block) => block.type === 'tool_result')
      .map((block) => `${prefix} tool_result${block.is_error === true ? ' (error)' : ''}: ${oneLine(resultText(block.content))}`);
  }
  if (message.type === 'result') {
    const cost = typeof message.total_cost_usd === 'number' ? `$${message.total_cost_usd.toFixed(4)}` : 'n/a';
    const seconds = typeof message.duration_ms === 'number' ? `${(message.duration_ms / 1000).toFixed(1)} s` : 'n/a';
    return [`${prefix} result ${String(message.subtype)}, cost ${cost}, duration ${seconds}, ${String(message.num_turns)} turns`];
  }
  return [];
}

// The non-empty lines of a text, trimmed.
function textLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

// The lines of one Codex event of the gate, without the "codex | " prefix.
function codexLines(event: Record<string, unknown>): string[] {
  const item = asRecord(event.item);
  if (event.type === 'error') {
    return [`error: ${oneLine(String(event.message ?? 'error'))}`];
  }
  if (event.type === 'turn.failed') {
    return [`error: ${oneLine(String(asRecord(event.error).message ?? 'turn failed'))}`];
  }
  if (event.type === 'turn.completed') {
    const usage = asRecord(event.usage);
    return [`turn completed (${String(usage.input_tokens ?? 0)} in, ${String(usage.output_tokens ?? 0)} out tokens)`];
  }
  if (event.type === 'item.started' && item.type === 'command_execution') {
    const command = Array.isArray(item.command) ? item.command.map(String).join(' ') : String(item.command ?? '');
    return [`$ ${oneLine(command)}`];
  }
  if (event.type !== 'item.completed') {
    return [];
  }
  if (item.type === 'command_execution') {
    const output = textLines(typeof item.aggregated_output === 'string' ? item.aggregated_output : '');
    const shown = output.slice(0, OUTPUT_LINES).map((line) => `  ${oneLine(line)}`);
    return [`exit ${String(item.exit_code ?? '?')}`, ...shown, ...(output.length > OUTPUT_LINES ? ['  …'] : [])];
  }
  if (item.type === 'agent_message' && typeof item.text === 'string') {
    return textLines(item.text).map((line) => oneLine(line));
  }
  if (item.type === 'reasoning' && typeof item.text === 'string') {
    const first = textLines(item.text)[0];
    return first !== undefined ? [`reasoning: ${oneLine(first)}`] : [];
  }
  if (item.type === 'error') {
    return [`error: ${oneLine(String(item.message ?? 'error'))}`];
  }
  return [];
}

// The short input of a review tool use: the file or pattern it is about, else its JSON.
export function shortInput(input: unknown): string {
  const fields = asRecord(input);
  const named = ['file_path', 'pattern', 'path'].map((key) => fields[key]).find((value) => typeof value === 'string');
  return oneLine(typeof named === 'string' ? named : JSON.stringify(input ?? {}), INPUT_CHARS);
}

// The lines of one Claude review message, without the "review | " prefix: its text and
// tool uses. The verdict has its own record.
function reviewLines(message: Record<string, unknown>): string[] {
  if (message.type !== 'assistant') {
    return [];
  }
  return blocks(message).flatMap((block) => {
    if (block.type === 'text' && typeof block.text === 'string') {
      return textLines(block.text).map((line) => oneLine(line));
    }
    if (block.type === 'tool_use') {
      return [`${oneLine(String(block.name))}(${shortInput(block.input)})`];
    }
    return [];
  });
}

// A gate_event or review_message record as reviewer-prefixed lines; a cut one is marked.
function reviewerLines(record: Record<string, unknown>): string[] {
  const codex = record.type === 'gate_event';
  const body = asRecord(codex ? record.event : record.message);
  const lines = codex ? codexLines(body) : reviewLines(body);
  if (record.truncated === true) {
    if (lines.length === 0) {
      lines.push(oneLine(String(body.type ?? 'event')));
    }
    lines[lines.length - 1] += ' (cut)';
  }
  return lines.map((line) => `${codex ? 'codex' : 'review'} | ${line}`);
}

// Prints every event; with follow, keeps reading new lines until the signal aborts.
export async function watchEvents(path: string, follow: boolean, print: (line: string) => void, signal?: AbortSignal): Promise<void> {
  await followLines(path, follow, (raw) => formatEvent(raw).forEach(print), signal);
}

// Calls onLine with every complete line of the file and its 0-based number; with follow, keeps
// reading new lines until the signal aborts.
export async function followLines(path: string, follow: boolean, onLine: (raw: string, index: number) => void, signal?: AbortSignal): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FactoryError('job_not_found', 'This job has no events yet.');
    }
    throw error;
  }
  try {
    let position = 0;
    let index = 0;
    let pending = '';
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.alloc(65536);
    for (;;) {
      if (signal?.aborted) {
        return;
      }
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead > 0) {
        position += bytesRead;
        pending += decoder.write(chunk.subarray(0, bytesRead));
        const lines = pending.split('\n');
        pending = lines.pop()!;
        for (const line of lines) {
          onLine(line, index);
          index += 1;
        }
        continue;
      }
      if (!follow || signal?.aborted) {
        return;
      }
      try {
        await sleep(POLL_MS, undefined, { signal });
      } catch { // the sleep was aborted: the follow ends
        return;
      }
    }
  } finally {
    await handle.close();
  }
}
