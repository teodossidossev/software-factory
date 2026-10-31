// Read-only observation console of one managed Claude session (`sf009-executor observe`): the
// job's identity, its verified repository, the managed session and what the job waits for, then
// the session's Claude Code transcript as readable user/assistant text and tool calls/results. A
// bounded recent history is printed first, then new records as they are written (--once stops
// after the history).
//
// The job is resolved the way `status` resolves it (status.ts): the transcript is looked for only
// in the repository verified against the job's authorization binding, under the session id that
// managed.json names as current; an unverified repository is reported, never replaced by the
// current registration. When the managed session changes (reset), the new one is followed after a
// separator.
//
// The transcript is read incrementally from a remembered offset, in bounded chunks: a record is
// decoded only once its line is complete (partial JSONL lines and split UTF-8 sequences wait for
// the rest), an over-long record is skipped and reported, and a missing, unreadable, replaced or
// truncated transcript is reported. Text is clipped with an explicit marker and terminal control
// sequences from the transcript are shown as inert text.
//
// The observer starts and invokes nothing, sends no input, takes no lock or session gate, signals
// no process and writes and creates nothing; content stays in the operator's terminal.
import { constants } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { findTranscript, projectSlug } from '../execution/transcript.js';
import type { JobView, StatusReport } from './status.js';

export const OBSERVE_LIMITS = {
  // Rendered entries of the existing transcript shown before following.
  historyEntries: 40,
  // The initial read starts at most this far before the end of the transcript.
  historyBytes: 512 * 1024,
  // A longer JSONL record is skipped (and reported), never buffered whole.
  recordBytes: 1024 * 1024,
  // Bytes read per poll; the rest follows on the next poll.
  pollBytes: 4 * 1024 * 1024,
  // Characters shown of one text, tool input or tool result.
  textChars: 2000,
  // Record uuids remembered so that a re-read (replaced or truncated transcript) prints nothing twice.
  seenRecords: 4096,
};

export type ObserveLimits = typeof OBSERVE_LIMITS;

// What the observer needs to know about the job, from one status reading.
export interface ObserveTarget {
  app_id: string;
  job_id: string;
  // false: no such job, or neither a managed record nor an authorization.
  found: boolean;
  state: string;
  // The verified repository, else null (repository_note says why).
  repository: string | null;
  repository_note: string;
  repository_binding: JobView['repository_binding'];
  registered_now: string | null;
  // The managed session id only (managed.json), never another source.
  session_id: string | null;
  waiting: string;
}

export function observeTarget(appId: string, jobId: string, report: StatusReport): ObserveTarget {
  const view = report.jobs.find((entry) => entry.app_id === appId && entry.job_id === jobId);
  if (view === undefined) {
    return {
      app_id: appId,
      job_id: jobId,
      found: false,
      state: 'not found',
      repository: null,
      repository_note: 'unknown',
      repository_binding: 'unverifiable',
      registered_now: null,
      session_id: null,
      waiting: report.discovery.complete ? 'nothing: no such authorized or managed job' : 'nothing found, but the job records could not all be read',
    };
  }
  return {
    app_id: appId,
    job_id: jobId,
    found: true,
    state: view.state,
    repository: view.repository,
    repository_note: view.repository_note,
    repository_binding: view.repository_binding,
    registered_now: view.registered_now,
    session_id: view.managed_session_id,
    waiting: view.waiting,
  };
}

const C1_AND_FORMATTING = /[\u0080-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

// Terminal control characters as inert text: C0 controls (except newline and tab) and DEL in caret
// notation (ESC as ^[), C1 controls and bidirectional/line formatting characters as <U+XXXX>.
export function neutralize(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === '\n' || char === '\t') {
      out += char;
    } else if (code < 0x20) {
      out += `^${String.fromCharCode(code + 64)}`;
    } else if (code === 0x7f) {
      out += '^?';
    } else if (C1_AND_FORMATTING.test(char)) {
      out += `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
    } else {
      out += char;
    }
  }
  return out;
}

// At most max characters (never splitting a surrogate pair), with an explicit marker when clipped.
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}… [truncated: ${text.length - end} more characters]`;
}

const shown = (text: string, limits: ObserveLimits): string => clip(neutralize(text), limits.textChars);

// One labelled block; continuation lines are indented under the label.
const block = (label: string, text: string): string => `${label}: ${text.replace(/\n/g, '\n    ')}`;

interface Part {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
  is_error?: unknown;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part: Part) => {
        if (part?.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
        return `[${typeof part?.type === 'string' ? part.type : 'content'}]`;
      })
      .join('\n');
  }
  return '';
}

function toolInput(name: string, input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const fields = input as Record<string, unknown>;
    if (name === 'Bash' && typeof fields.command === 'string') {
      return fields.command;
    }
  }
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}

// The readable blocks of one transcript record: user and assistant text, tool calls and tool
// results. Other records (system, summaries, snapshots, meta messages, thinking) show nothing.
export function renderRecord(record: unknown, limits: ObserveLimits = OBSERVE_LIMITS): string[] {
  if (typeof record !== 'object' || record === null) {
    return [];
  }
  const entry = record as { type?: unknown; isMeta?: unknown; isSidechain?: unknown; timestamp?: unknown; message?: { content?: unknown } };
  if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta === true) {
    return [];
  }
  const time = typeof entry.timestamp === 'string' ? /T(\d\d:\d\d:\d\d)/.exec(entry.timestamp)?.[1] : undefined;
  const prefix = `${time === undefined ? '' : `[${time}] `}${entry.isSidechain === true ? '(subagent) ' : ''}`;
  const content = entry.message?.content;
  const blocks: string[] = [];
  if (typeof content === 'string') {
    if (content.trim() !== '') {
      blocks.push(block(`${prefix}${entry.type}`, shown(content, limits)));
    }
    return blocks;
  }
  if (!Array.isArray(content)) {
    return blocks;
  }
  for (const part of content as Part[]) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
      blocks.push(block(`${prefix}${entry.type}`, shown(part.text, limits)));
    } else if (part?.type === 'tool_use') {
      const name = typeof part.name === 'string' ? part.name : 'unknown';
      blocks.push(block(`${prefix}tool call ${shown(name, limits)}`, shown(toolInput(name, part.input), limits)));
    } else if (part?.type === 'tool_result') {
      blocks.push(block(`${prefix}tool result${part.is_error === true ? ' (error)' : ''}`, shown(resultText(part.content), limits)));
    }
  }
  return blocks;
}

// reread: the transcript was replaced or truncated and is read again (records follow from its window).
export type TailItem = { kind: 'record'; record: unknown } | { kind: 'notice'; text: string; reread?: true };

// Incremental reader of one transcript file. Each read() continues at the remembered offset and
// returns the complete records written since, with notices for what could not be read.
export class TranscriptTail {
  readonly path: string;
  readonly #limits: ObserveLimits;
  #identity: string | undefined;
  #offset = 0;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  // Discarding up to the next newline: an over-long record, or the partial first line of a bounded history read.
  #skipping = false;
  // The last problem reported (missing, unreadable): reported once until it changes.
  #problem: string | undefined;

  constructor(path: string, limits: ObserveLimits = OBSERVE_LIMITS) {
    this.path = path;
    this.#limits = limits;
  }

  // Bytes of an incomplete last record that wait for the rest of their line.
  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  #report(items: TailItem[], problem: string, text: string): void {
    if (this.#problem !== problem) {
      items.push({ kind: 'notice', text });
    }
    this.#problem = problem;
  }

  #restart(): void {
    this.#offset = 0;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#skipping = false;
  }

  // A (re)started read covers at most the last historyBytes of the file, from the first whole line.
  async #window(handle: FileHandle, size: number, items: TailItem[]): Promise<void> {
    if (size <= this.#limits.historyBytes) {
      return;
    }
    this.#offset = size - this.#limits.historyBytes;
    const before = Buffer.alloc(1);
    await handle.read(before, 0, 1, this.#offset - 1);
    this.#skipping = before[0] !== 0x0a;
    items.push({ kind: 'notice', text: `earlier transcript content not shown (${this.#offset} bytes before the recent history)` });
  }

  async read(): Promise<TailItem[]> {
    const items: TailItem[] = [];
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'error';
      if (code === 'ENOENT') {
        this.#report(items, 'missing', 'transcript missing: it does not exist (any more); waiting for it');
      } else {
        this.#report(items, code, `transcript unreadable (${code}); retrying`);
      }
      return items;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        this.#report(items, 'not_regular_file', 'transcript unreadable (not a regular file); retrying');
        return items;
      }
      const identity = `${stats.dev}:${stats.ino}`;
      if (this.#identity === undefined) {
        await this.#window(handle, stats.size, items);
      } else if (identity !== this.#identity) {
        items.push({ kind: 'notice', text: 'transcript replaced by another file; reading the new one again (records already shown are not repeated)', reread: true });
        this.#restart();
        await this.#window(handle, stats.size, items);
      } else if (stats.size < this.#offset) {
        items.push({ kind: 'notice', text: `transcript truncated (now ${stats.size} bytes, ${this.#offset} were read); reading it again (records already shown are not repeated)`, reread: true });
        this.#restart();
        await this.#window(handle, stats.size, items);
      } else if (this.#problem !== undefined) {
        items.push({ kind: 'notice', text: 'transcript readable again' });
      }
      this.#identity = identity;
      this.#problem = undefined;
      const end = Math.min(stats.size, this.#offset + this.#limits.pollBytes);
      const chunk = Buffer.alloc(Math.min(256 * 1024, Math.max(0, end - this.#offset)));
      while (this.#offset < end) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, end - this.#offset), this.#offset);
        if (bytesRead === 0) {
          break;
        }
        this.#offset += bytesRead;
        this.#consume(chunk.subarray(0, bytesRead), items);
      }
    } finally {
      await handle.close();
    }
    return items;
  }

  #consume(data: Buffer, items: TailItem[]): void {
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(0x0a, start);
      const piece = data.subarray(start, newline === -1 ? data.length : newline);
      if (!this.#skipping) {
        if (this.#pendingBytes + piece.length > this.#limits.recordBytes) {
          items.push({ kind: 'notice', text: `a transcript record longer than ${this.#limits.recordBytes} bytes was skipped` });
          this.#pending = [];
          this.#pendingBytes = 0;
          this.#skipping = true;
        } else {
          this.#pending.push(Buffer.from(piece));
          this.#pendingBytes += piece.length;
        }
      }
      if (newline === -1) {
        return;
      }
      if (!this.#skipping) {
        this.#line(Buffer.concat(this.#pending).toString('utf8'), items);
      }
      this.#pending = [];
      this.#pendingBytes = 0;
      this.#skipping = false;
      start = newline + 1;
    }
  }

  #line(line: string, items: TailItem[]): void {
    if (line.trim() === '') {
      return;
    }
    try {
      items.push({ kind: 'record', record: JSON.parse(line) as unknown });
    } catch {
      items.push({ kind: 'notice', text: 'a transcript line that is not valid JSON was skipped' });
    }
  }
}

export interface ObserveOptions {
  // One status reading of the job (read-only), turned into a target.
  resolve: () => Promise<ObserveTarget>;
  // Claude Code's transcript directory (CLAUDE_CONFIG_DIR/projects or ~/.claude/projects).
  projectsDir: string;
  // Awaited before anything more is read: output that cannot be delivered stops the reading.
  write: (text: string) => void | Promise<void>;
  // Print the header and the recent history, then return.
  once?: boolean;
  // Aborted on Ctrl+C: the observer returns; nothing else is affected.
  signal?: AbortSignal;
  pollMs?: number;
  limits?: Partial<ObserveLimits>;
}

// Writes to a stream and waits while its buffer is full (backpressure) until it drains, closes or
// fails, or until the signal aborts: a slow or blocked reader holds the observer, never queues
// unbounded output. Nothing is written once the signal has aborted.
export function streamWriter(stream: NodeJS.WritableStream, signal?: AbortSignal): (text: string) => Promise<void> {
  return (text) =>
    new Promise((resolve) => {
      if (signal?.aborted === true || stream.write(text)) {
        resolve();
        return;
      }
      const done = () => {
        stream.off('drain', done);
        stream.off('close', done);
        stream.off('error', done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      stream.on('drain', done);
      stream.on('close', done);
      stream.on('error', done);
      signal?.addEventListener('abort', done, { once: true });
    });
}

export interface ObserverProcessOptions {
  resolve: () => Promise<ObserveTarget>;
  projectsDir: string;
  once: boolean;
  // How long this process may take to end after Ctrl+C or SIGTERM, whatever is still pending.
  graceMs?: number;
}

const STOPPED = 'sf009-executor observe: stopped; the session and the job are not affected\n';

// The observer as its own CLI process (`sf009-executor observe`): output to stdout through
// streamWriter; Ctrl+C (SIGINT) or SIGTERM aborts it, and nothing more is written to stdout. The
// process then ends within graceMs even when its stdout cannot drain (an unread pipe would keep it
// alive): output its reader did not take is dropped. A second Ctrl+C ends it at once. Only this
// process and its own output are affected: the session, the gate and the job records are not. With
// --once the signals keep their default and end it at once.
export async function runObserverProcess(options: ObserverProcessOptions): Promise<number> {
  const controller = new AbortController();
  const graceMs = options.graceMs ?? 2000;
  if (!options.once) {
    const stop = () => {
      if (controller.signal.aborted) {
        process.exit(130);
      }
      controller.abort();
      setTimeout(() => process.exit(130), graceMs).unref();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
  const code = await observe({
    resolve: options.resolve,
    projectsDir: options.projectsDir,
    write: streamWriter(process.stdout, controller.signal),
    once: options.once,
    signal: controller.signal,
  });
  if (controller.signal.aborted) {
    process.stderr.write(STOPPED);
    if (process.stdout.writableLength > 0) {
      process.exit(code);
    }
  }
  return code;
}

const pause = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

const row = (label: string, value: string): string => `  ${label.padEnd(14)} ${neutralize(value)}\n`;

const repositoryLine = (target: ObserveTarget): string => (target.repository === null ? target.repository_note : `${target.repository} (${target.repository_note})`);

function header(target: ObserveTarget): string {
  let text = `Observing app ${neutralize(target.app_id)} / job ${neutralize(target.job_id)} (read-only: starts, sends, locks, signals and writes nothing; Ctrl+C stops only this observer)\n`;
  text += row('repository', repositoryLine(target));
  if (target.registered_now !== null && target.repository_binding !== 'verified') {
    text += row('registered now', `${target.registered_now} (NOT verified as this job's repository: ${target.repository_binding}; never read)`);
  }
  text += row('session', target.session_id ?? 'no managed session yet');
  text += row('state', target.state);
  text += row('waiting for', target.waiting);
  return text;
}

// A bounded set of the record uuids already shown, oldest forgotten first.
class Seen {
  readonly #limit: number;
  readonly #ids = new Set<string>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  // True when the id is new (and remembers it).
  add(id: string): boolean {
    if (this.#ids.has(id)) {
      return false;
    }
    this.#ids.add(id);
    if (this.#ids.size > this.#limit) {
      this.#ids.delete(this.#ids.values().next().value!);
    }
    return true;
  }
}

// Watches the job until the signal aborts (or once). 0 when the job's transcript could be looked
// for; 1 when the job does not exist or its repository is not verified (--once only).
export async function observe(options: ObserveOptions): Promise<number> {
  const limits: ObserveLimits = { ...OBSERVE_LIMITS, ...options.limits };
  const write = async (text: string): Promise<void> => {
    await options.write(text);
  };
  const stopped = (): boolean => options.signal?.aborted === true;
  const seen = new Seen(limits.seenRecords);
  let target = await options.resolve();
  await write(header(target));
  if (!target.found) {
    await write('No such authorized or managed job; nothing to observe.\n');
    return 1;
  }
  // The followed session: its id and repository, and its transcript once found.
  let followed: { id: string; repository: string; tail: TranscriptTail | undefined; history: boolean } | undefined;
  let lastNotice: string | undefined;
  const notice = async (text: string): Promise<void> => {
    await write(`-- ${neutralize(text)}\n`);
  };
  const noticeOnce = async (key: string, text: string): Promise<void> => {
    if (lastNotice !== key) {
      await notice(text);
    }
    lastNotice = key;
  };
  // The printable text of what a read returned. For the recent history, only the last
  // historyEntries entries are kept; notices are always kept.
  const show = (items: TailItem[], history: boolean): string => {
    const uuid = (item: TailItem): string | undefined => {
      const id = item.kind === 'record' ? (item.record as { uuid?: unknown } | null)?.uuid : undefined;
      return typeof id === 'string' ? id : undefined;
    };
    // After a replacement or truncation, every record up to the last one already shown was shown
    // before. Compared before anything new is remembered, so that remembering cannot evict the
    // identities being compared against.
    let rereadEnd = -1;
    const reread = items.findIndex((item) => item.kind === 'notice' && item.reread === true);
    if (reread !== -1) {
      for (let index = items.length - 1; index > reread; index -= 1) {
        const id = uuid(items[index]!);
        if (id !== undefined && seen.has(id)) {
          rereadEnd = index;
          break;
        }
      }
    }
    const out: Array<{ notice: boolean; text: string }> = [];
    for (const [index, item] of items.entries()) {
      if (item.kind === 'notice') {
        out.push({ notice: true, text: `-- ${neutralize(item.text)}\n` });
        continue;
      }
      const id = uuid(item);
      if (index <= rereadEnd || (id !== undefined && !seen.add(id))) {
        continue;
      }
      for (const text of renderRecord(item.record, limits)) {
        out.push({ notice: false, text: `${text}\n` });
      }
    }
    const entries = out.filter((entry) => !entry.notice).length;
    let omitted = history ? Math.max(0, entries - limits.historyEntries) : 0;
    let text = omitted > 0 ? `-- ${omitted} earlier entr${omitted === 1 ? 'y' : 'ies'} not shown\n` : '';
    for (const entry of out) {
      if (!entry.notice && omitted > 0) {
        omitted -= 1;
        continue;
      }
      text += entry.text;
    }
    return text;
  };
  for (;;) {
    if (target.repository === null) {
      followed = undefined;
      await noticeOnce(`unverified:${target.repository_note}`, `the job's repository is not verified (${target.repository_note}); its transcript is not read, and the current registration is never used instead`);
    } else if (target.session_id === null) {
      followed = undefined;
      await noticeOnce('no-session', 'no managed session yet; waiting for it');
    } else if (followed === undefined || followed.id !== target.session_id || followed.repository !== target.repository) {
      if (followed !== undefined && followed.id !== target.session_id) {
        // What the previous session wrote last is shown before the separator.
        if (followed.tail !== undefined && !stopped()) {
          await write(show(await followed.tail.read(), false));
        }
        await write(`\n==== the managed session changed (reset): now following session ${neutralize(target.session_id)}, was ${neutralize(followed.id)} ====\n\n`);
      }
      followed = { id: target.session_id, repository: target.repository, tail: undefined, history: true };
      lastNotice = undefined;
    }
    if (followed !== undefined) {
      if (followed.tail === undefined) {
        // findTranscript leaves out very large transcripts; the bounded reader can still follow one.
        const expected = join(options.projectsDir, projectSlug(followed.repository), `${followed.id}.jsonl`);
        const path = (await findTranscript(options.projectsDir, followed.repository, followed.id)) ?? ((await stat(expected).catch(() => undefined))?.isFile() === true ? expected : undefined);
        if (path === undefined) {
          await noticeOnce(`waiting:${followed.id}`, `no transcript yet for session ${followed.id} under ${join(options.projectsDir, projectSlug(followed.repository))}; waiting for it`);
        } else {
          followed.tail = new TranscriptTail(path, limits);
          await notice(`transcript ${path}`);
        }
      }
      if (followed.tail !== undefined && !stopped()) {
        await write(show(await followed.tail.read(), followed.history));
        if (followed.history) {
          followed.history = false;
          if (options.once !== true) {
            await notice('following new records');
          }
        }
      }
    }
    if (options.once === true) {
      if (followed?.tail !== undefined && followed.tail.pendingBytes > 0) {
        await notice(`an incomplete last record (${followed.tail.pendingBytes} bytes so far) is not shown yet`);
      }
      return target.repository === null ? 1 : 0;
    }
    await pause(options.pollMs ?? 500, options.signal);
    if (options.signal?.aborted === true) {
      await write('-- observer stopped; the session and the job are not affected\n');
      return 0;
    }
    const previous = target;
    try {
      target = await options.resolve();
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'error';
      await noticeOnce(`resolve:${code}`, `the job's status cannot be read now (${code}); retrying`);
      continue;
    }
    if (target.state !== previous.state || target.waiting !== previous.waiting) {
      await notice(`state ${target.state}; waiting for: ${target.waiting}`);
    }
    if (target.repository !== previous.repository || target.repository_note !== previous.repository_note) {
      await notice(`repository: ${repositoryLine(target)}`);
    }
  }
}
