// `sf watch`: reads a job's events.jsonl directly (no server needed) and prints readable lines.
// The dashboard's event stream uses the same reading loop (followLines) and formatting (describeEvent).
import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import { FactoryError } from './errors.js';

const INPUT_CHARS = 120;
const LINE_CHARS = 200;
const POLL_MS = 300;

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
  // "prompt", "state", "notify_failed", "placeholders_removed", "principal", "event_delivered", "event_failed", "review", "review_failed", or the SDK message type ("assistant", "user", "result", "system", ...).
  type: string;
  lines: string[];
}

// One events.jsonl record as its time, iteration, kind and printable lines; undefined for a line
// that is not a JSON object.
export function describeEvent(raw: string): DescribedEvent | undefined {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch {
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

function recordLines(record: Record<string, unknown>): string[] {
  const time = typeof record.ts === 'string' ? record.ts.slice(11, 19) : '--:--:--';
  const prefix = `${time} [${String(record.iteration)}]`;
  if (typeof record.prompt === 'string') {
    // The factory's fixed rules block after the prompt is the same every time; it is not shown.
    const rules = record.prompt.indexOf('\n\nRules from the Software Factory:');
    return [`${prefix} > ${oneLine(rules < 0 ? record.prompt : record.prompt.slice(0, rules))}`];
  }
  const state = record.state as { from: string | null; to: string; error?: { code: string; message: string } } | undefined;
  if (state !== undefined) {
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
  if (record.type === 'principal') {
    return [`${prefix} ${String(record.tool)} by ${oneLine(String(record.principal))}`];
  }
  if (record.type === 'subscription_removed') {
    return [`${prefix} subscription ${oneLine(String(record.subscription))} removed: the job ended`];
  }
  if (record.type === 'event_delivered' || record.type === 'event_failed') {
    const outcome = record.type === 'event_delivered' ? 'delivered' : 'failed';
    return [`${prefix} event to ${oneLine(String(record.subscription))} attempt ${String(record.attempt)} ${outcome}: ${oneLine(String(record.status))}`];
  }
  if (record.type === 'review' || record.type === 'review_failed') {
    const ignored = record.ignored === true ? ' (ignored: the job had moved on)' : '';
    if (record.type === 'review_failed') {
      return [`${prefix} review by ${String(record.reviewer)} failed: ${oneLine(String(record.error))}${ignored}`];
    }
    const count = typeof record.items === 'number' ? record.items : 0;
    const items = record.verdict === 'fix' ? ` (${count} ${count === 1 ? 'item' : 'items'})` : '';
    return [`${prefix} review by ${String(record.reviewer)}: ${String(record.verdict)}${items}${ignored}`];
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
      } catch {
        return;
      }
    }
  } finally {
    await handle.close();
  }
}
