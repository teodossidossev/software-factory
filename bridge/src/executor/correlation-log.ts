// SF-009: what happened to the messages of one managed process, for diagnosing a missing
// acknowledgment: send and write outcomes, accepted and rejected acknowledgments, results and the
// first output of each kind, in order. Content-free by construction: entries hold only the fixed
// words below and per-run aliases (m1, m2 for our messages, x1, x2 for other uuids), never text,
// a uuid or a value taken from an event. Times are ms since the first entry. Stored in memory and
// bounded: the newest CORRELATION_ENTRIES entries, and for our messages (the newest) and for foreign
// uuids (the first) CORRELATION_ALIASES fixed-size digests, never the identifiers themselves. So this
// log only describes: a message evicted from it reads as foreign here. Whether an event acknowledges
// a message is decided by exact comparison in stream-session.ts, never from this log.
import { createHash } from 'node:crypto';

export const CORRELATION_ENTRIES = 64;
export const CORRELATION_ALIASES = 16;
export const CORRELATION_OUTPUT_CHARS = 840;
// One managed.json event detail holds 300 characters.
const CHUNK_CHARS = 280;

export type RejectReason = 'no_uuid' | 'tool_result' | 'duplicate' | 'out_of_order' | 'foreign';
export type OutputKind = 'init' | 'assistant' | 'stream_event' | 'tool_result';
export type CorrelationStep =
  | 'send'
  | 'send_refused'
  | 'write_ok'
  | 'write_failed'
  | 'ack_accepted'
  | 'ack_rejected'
  | 'result'
  | 'first';

const digest = (uuid: string): string => createHash('sha256').update(uuid, 'utf8').digest('hex');

export class CorrelationLog {
  readonly #entries: string[] = [];
  readonly #own = new Map<string, string>();
  readonly #foreign = new Map<string, string>();
  readonly #outputSeen = new Set<OutputKind>();
  #messages = 0;
  #dropped = 0;
  #origin: number | undefined;

  get size(): number {
    return this.#entries.length;
  }

  get aliases(): number {
    return this.#own.size + this.#foreign.size;
  }

  get identifierBytes(): number {
    return [...this.#own.keys(), ...this.#foreign.keys()].reduce((total, key) => total + key.length, 0);
  }

  // A message of ours, about to be sent: first output counts anew from here.
  own(uuid: string): void {
    this.#messages += 1;
    this.#own.set(digest(uuid), `m${this.#messages}`);
    if (this.#own.size > CORRELATION_ALIASES) {
      this.#own.delete(this.#own.keys().next().value!);
    }
    this.#outputSeen.clear();
  }

  ours(uuid: string): boolean {
    return this.#own.has(digest(uuid));
  }

  // detail: one of the fixed words of this file.
  note(step: CorrelationStep, detail?: string, uuid?: string): void {
    const now = Date.now();
    this.#origin ??= now;
    const parts = [step, ...(detail === undefined ? [] : [detail]), ...(uuid === undefined ? [] : [this.#alias(uuid)])];
    this.#entries.push(`${parts.join(':')}@${now - this.#origin}`);
    if (this.#entries.length > CORRELATION_ENTRIES) {
      this.#entries.shift();
      this.#dropped += 1;
    }
  }

  // The first output of a kind after the latest message; repeats are not recorded.
  output(kind: OutputKind): void {
    if (!this.#outputSeen.has(kind)) {
      this.#outputSeen.add(kind);
      this.note('first', kind);
    }
  }

  #alias(uuid: string): string {
    const key = digest(uuid);
    const known = this.#own.get(key) ?? this.#foreign.get(key);
    if (known !== undefined) {
      return known;
    }
    if (this.#foreign.size >= CORRELATION_ALIASES) {
      return 'x+';
    }
    const alias = `x${this.#foreign.size + 1}`;
    this.#foreign.set(key, alias);
    return alias;
  }

  // The newest entries that fit, then how many were left out and the end state, in chunks of one
  // event detail each. end: a fixed code of the supervisor.
  report(end: string): string[] {
    const code = end.replace(/[^a-z_]/g, '').slice(0, 64);
    const kept: string[] = [];
    // Room for the closing words, whatever the count of entries left out.
    let chars = code.length + 24;
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const entry = this.#entries[index]!;
      if (chars + entry.length + 1 > CORRELATION_OUTPUT_CHARS) {
        break;
      }
      chars += entry.length + 1;
      kept.unshift(entry);
    }
    const left = this.#dropped + this.#entries.length - kept.length;
    const text = [...kept, `dropped=${left} end:${code}`].join(' ');
    const chunks: string[] = [];
    for (let at = 0; at < text.length; at += CHUNK_CHARS) {
      chunks.push(text.slice(at, at + CHUNK_CHARS));
    }
    return chunks;
  }
}
