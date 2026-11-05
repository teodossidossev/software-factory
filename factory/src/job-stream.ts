// The job's Stream (SF-082): each events.jsonl line as typed entries for the dashboard's job page
// (docs/design/dashboard-v3/prototype.html, its stream entries). An entry depends only on its line
// and the job's files at the time of the build, never on other lines, so the paged route and the
// live event give the same entries (but for the ledger ids of a live verdict, written after its
// review record). The builder never joins a tool and its result: the client does, by id.
import type { GateRecord, IterationMeta, JobStore, ReviewRecord, SimplifyRecord } from './jobs.js';
import type { LedgerEntry } from './ledger.js';
import { describeEvent, limitStateText, shortInput } from './watch.js';

// The bound of a tool's input and a tool's result in an entry, in characters.
export const DETAIL_CHARS = 16384;
const RULES_MARK = '\n\nRules from the Software Factory:';
// changeNote (src/execution/shared.ts), appended after the prompt with a blank line.
const CHANGE_NOTE = /(?:^|\n\n)The Task file \S+ changed since you were last given it/u;
const KEPT_FILES = '\n\nThis job restarts an earlier job of ';
// The images line of factoryPrompt (src/prompts.ts) and the Resume's note of changed images
// (src/execution/control.ts), SF-065: each after a blank line, the images line last before the rules.
const IMAGES_LINE = /\n\nThe Task's images are in .+: .+\. Read them when you need them\.$/u;
const IMAGES_CHANGED = /\n\nThe Task's images changed while the job was paused: .+\.$/u;
const CONTINUE = 'Continue where you stopped.';

export type Who = 'implementer' | 'claude' | 'codex' | 'you' | 'factory' | 'mr';
export type PromptKind = 'implement' | 'fix' | 'mr' | 'conflict' | 'continue';

export interface VerdictItem {
  severity: string;
  path: string;
  problem: string;
  expected: string;
  // The ledger id, or null when none is known (the client shows #n).
  id: string | null;
}

export interface SimplifySuggestion {
  path: string;
  what: string;
  why: string;
  saves_lines: number;
}

type Body =
  // images: the names of the image blocks sent with the prompt (SF-065).
  | { t: 'prompt'; kind: PromptKind; text: string; first: string; task_changed: boolean; fix_n?: number; fix?: string; images?: string[] }
  | { t: 'user'; text: string; task_changed: boolean; images?: string[] }
  | { t: 'text'; text: string }
  | { t: 'tool'; id: string; line: string; detail: string }
  | { t: 'tool_result'; id: string; out: string; result: string; err: boolean }
  | { t: 'result'; turns: number | null; ms: number | null; cost: number | null }
  // text: the line of a park on a usage limit or the resume from it (SF-072, describeEvent).
  | { t: 'state'; from: string | null; to: string; code: string | null; msg: string | null; text?: string }
  | { t: 'verdict'; verdict: string; effective: string | null; summary?: string; items?: VerdictItem[] }
  | { t: 'changes'; files: number; paths: string[] }
  | { t: 'simplify'; suggestions: SimplifySuggestion[]; saves_lines: number }
  | { t: 'note'; text: string };
type Draft = { who: Who } & Body;
// k: "<line>", or "<line>.<n>" when the line gives several entries; it: the iteration, from 1.
export type StreamEntry = { k: string; ts: string | null; it: number } & Draft;

// The job's files an entry is joined with. A context made by streamContext caches its reads, so it
// lives for one page request; the live stream makes one per line.
export interface StreamContext {
  taskCopy(): Promise<string | undefined>;
  // undefined when the iteration has no meta.json.
  meta(iteration: number): Promise<IterationMeta | undefined>;
  review(iteration: number): Promise<ReviewRecord | undefined>;
  gate(iteration: number): Promise<GateRecord | undefined>;
  simplify(iteration: number): Promise<SimplifyRecord | undefined>;
  ledger(): Promise<LedgerEntry[]>;
}

export function streamContext(jobs: JobStore, workspace: string, ticket: string): StreamContext {
  const cache = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    let value = cache.get(key) as Promise<T> | undefined;
    if (value === undefined) {
      value = read();
      cache.set(key, value);
    }
    return value;
  };
  return {
    taskCopy: () => once('task', () => jobs.readTaskCopy(workspace, ticket)),
    meta: (iteration) => once(`meta ${iteration}`, () => jobs.readMeta(workspace, ticket, iteration).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    })),
    review: (iteration) => once(`review ${iteration}`, () => jobs.readReview(workspace, ticket, iteration)),
    gate: (iteration) => once(`gate ${iteration}`, () => jobs.readGate(workspace, ticket, iteration)),
    simplify: (iteration) => once(`simplify ${iteration}`, () => jobs.readSimplify(workspace, ticket, iteration)),
    ledger: () => once('ledger', () => jobs.readLedger(workspace, ticket)),
  };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const blocks = (message: Record<string, unknown>): Array<Record<string, unknown>> => {
  const content = asRecord(message.message).content;
  return Array.isArray(content) ? content.map(asRecord) : [];
};

// A text cut to at most limit characters, the last one the "…" mark, without splitting a surrogate pair.
function cut(text: string, limit = DETAIL_CHARS): string {
  if (text.length <= limit) {
    return text;
  }
  let end = limit - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

// A one-line text cut as shortInput (src/watch.ts) cuts a tool's input: through shortInput itself, as
// a path, since watch.ts exports no other cut (SF-082 changes nothing else there).
const shortLine = (text: string): string => shortInput({ path: text });

// The text of a tool result's content: a string, or the text parts of an array.
function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => asRecord(part).text).filter((text) => typeof text === 'string').join('\n');
  }
  return '';
}

const lineCount = (text: string): number => (text === '' ? 0 : text.replace(/\n$/u, '').split('\n').length);

// The `## Fix N` section of a Task file, heading included, up to the next heading of level 1 or 2
// outside a code fence; "" when it is missing.
function fixSection(task: string | undefined, fix: number): string {
  if (task === undefined) {
    return '';
  }
  const lines = task.split('\n');
  let fenced = false;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('```')) {
      fenced = !fenced;
    } else if (!fenced && start < 0 && new RegExp(`^## Fix ${fix}(?:\\D|$)`, 'u').test(line)) {
      start = index;
    } else if (!fenced && start >= 0 && /^#{1,2} /u.test(line)) {
      return lines.slice(start, index).join('\n').trim();
    }
  }
  return start < 0 ? '' : lines.slice(start).join('\n').trim();
}

async function promptEntry(prompt: string, ctx: StreamContext, sent: unknown): Promise<Draft> {
  const rules = prompt.indexOf(RULES_MARK);
  let text = (rules < 0 ? prompt : prompt.slice(0, rules)).replace(IMAGES_LINE, '');
  // The note of changed images is cut too; task_changed stays the Task text's (SF-065).
  text = text.replace(IMAGES_CHANGED, '');
  const note = CHANGE_NOTE.exec(text);
  const taskChanged = note !== null;
  if (note !== null) {
    text = text.slice(0, note.index);
  }
  const names = Array.isArray(sent) ? sent.map((image) => asRecord(image).name).filter((name): name is string => typeof name === 'string') : [];
  const images = names.length > 0 ? { images: names } : {};
  const first = text.split('\n')[0]!;
  const implement = /^\/implement \S+$/u.test(first);
  const fix = /^\/implement \S+ Fix (\d+)$/u.exec(first);
  const rest = text.slice(first.length);
  const base = { t: 'prompt' as const, text, first, task_changed: taskChanged, ...images };
  if (implement && (rest === '' || rest.startsWith(KEPT_FILES))) {
    return { ...base, who: 'factory', kind: 'implement' };
  }
  if (fix !== null && rest === '') {
    const number = Number(fix[1]);
    return { ...base, who: 'factory', kind: 'fix', fix_n: number, fix: fixSection(await ctx.taskCopy(), number) };
  }
  if (text.startsWith('MR preparation for ')) {
    return { ...base, who: 'mr', kind: 'mr' };
  }
  if (text.startsWith("The factory's rebase of ")) {
    return { ...base, who: 'factory', kind: 'conflict' };
  }
  if (text === CONTINUE) {
    return { ...base, who: 'factory', kind: 'continue' };
  }
  return { t: 'user', who: 'you', text, task_changed: taskChanged, ...images };
}

// The entries of one SDK message: of the Implementer, or of a Claude session in a review_message.
function messageEntries(message: Record<string, unknown>, who: 'implementer' | 'claude'): Draft[] {
  if (message.type === 'assistant') {
    return blocks(message).flatMap((block): Draft[] => {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        // As recorded: trimmed only to tell an empty block.
        return [{ t: 'text', who, text: block.text }];
      }
      if (block.type === 'tool_use') {
        const input = block.input ?? {};
        const command = asRecord(input).command;
        const what = typeof command === 'string' ? command : shortInput(input);
        return [{ t: 'tool', who, id: String(block.id ?? ''), line: shortLine(`${String(block.name)} ${what}`), detail: cut(JSON.stringify(input, null, 2)) }];
      }
      return [];
    });
  }
  if (message.type === 'user') {
    return blocks(message).filter((block) => block.type === 'tool_result').map((block): Draft => {
      const text = resultText(block.content);
      const err = block.is_error === true;
      const lines = lineCount(text);
      const out = err ? `failed: ${shortLine(text.split('\n')[0]!)}` : `${lines} ${lines === 1 ? 'line' : 'lines'}`;
      return { t: 'tool_result', who, id: String(block.tool_use_id ?? ''), out, result: cut(text), err };
    });
  }
  if (message.type === 'result') {
    return [{ t: 'result', who, turns: numberOrNull(message.num_turns), ms: numberOrNull(message.duration_ms), cost: numberOrNull(message.total_cost_usd) }];
  }
  return [];
}

// The entries of one Codex event of the gate; undefined for an event that is a note.
function codexEntries(event: Record<string, unknown>): Draft[] | undefined {
  const item = asRecord(event.item);
  const id = String(item.id ?? '');
  if (event.type === 'item.started' && item.type === 'command_execution') {
    const command = Array.isArray(item.command) ? item.command.map(String).join(' ') : String(item.command ?? '');
    return [{ t: 'tool', who: 'codex', id, line: shortLine(`$ ${command}`), detail: cut(JSON.stringify({ command: item.command }, null, 2)) }];
  }
  if (event.type !== 'item.completed') {
    return undefined;
  }
  if (item.type === 'command_execution') {
    const code = item.exit_code;
    const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
    return [{ t: 'tool_result', who: 'codex', id, out: `exit ${String(code ?? '?')}`, result: cut(output), err: typeof code === 'number' && code !== 0 }];
  }
  if (item.type === 'agent_message') {
    // As recorded: trimmed only to tell an empty message.
    const text = typeof item.text === 'string' ? item.text : '';
    return text.trim() === '' || isJsonObject(text) ? [] : [{ t: 'text', who: 'codex', text }];
  }
  return undefined;
}

// The gate's verdict is an agent message that parses as a JSON object.
function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

const reviewerWho = (reviewer: unknown): 'claude' | 'codex' => (reviewer === 'codex' ? 'codex' : 'claude');

async function verdictEntry(record: Record<string, unknown>, it: number, ctx: StreamContext): Promise<Draft> {
  const who = reviewerWho(record.reviewer);
  const effective = record.effective === 'clean' || record.effective === 'fix' ? record.effective : null;
  const entry: Draft = { t: 'verdict', who, verdict: String(record.verdict), effective };
  const file = who === 'codex' ? await ctx.gate(it) : await ctx.review(it);
  // A file a retry rewrote, or that is missing or failed, is not this record's.
  if (file === undefined || !('verdict' in file) || file.verdict !== record.verdict || file.items.length !== record.items) {
    return entry;
  }
  const ledger = await ctx.ledger();
  const items = file.items.map((item): VerdictItem => {
    const found = ledger.find((candidate) => candidate.reviewer === record.reviewer && candidate.iteration === record.iteration
      && candidate.path === item.path && candidate.problem === item.problem);
    const reopens = item.reopens ?? '';
    return {
      severity: item.severity, path: item.path, problem: item.problem, expected: item.expected,
      id: found !== undefined ? found.id : reopens !== '' ? reopens : null,
    };
  });
  return { ...entry, summary: file.summary, items };
}

// The `changes` entry after a state change that ends a publish (publish then transition: the work
// path in src/execution/turns.ts, the conflict path in src/execution/mr-steps.ts, or an escalation
// from the Fix table); the retry paths start from needs_human and publish nothing.
async function changesEntry(state: { from: unknown; to: unknown; code: string | null }, it: number, ctx: StreamContext): Promise<Draft[]> {
  const published = (state.to === 'awaiting_review' && (state.from === 'working' || state.from === 'preparing_mr'))
    || (state.to === 'needs_human' && state.code === 'escalated' && state.from === 'working');
  const meta = published ? await ctx.meta(it) : undefined;
  if (meta === undefined) {
    return [];
  }
  const paths = (meta.files ?? meta.changed_files).map((file) => file.path);
  return [{ t: 'changes', who: 'factory', files: paths.length, paths }];
}

async function simplifyEntry(it: number, ctx: StreamContext): Promise<Draft> {
  const file = await ctx.simplify(it);
  const suggestions = file !== undefined && 'suggestions' in file
    ? file.suggestions.map(({ path, what, why, saves_lines }) => ({ path, what, why, saves_lines }))
    : [];
  return { t: 'simplify', who: 'claude', suggestions, saves_lines: suggestions.reduce((sum, item) => sum + item.saves_lines, 0) };
}

// A record as one plain line: describeEvent's first line without its time, iteration and
// reviewer prefix; none when it gives no line.
function noteEntry(raw: string, who: Who): Draft[] {
  const line = describeEvent(raw)?.lines[0];
  if (line === undefined) {
    return [];
  }
  return [{ t: 'note', who, text: line.replace(/^\S+ \[[^\]]*\] /u, '').replace(/^(?:codex|review) \| /u, '') }];
}

async function drafts(raw: string, record: Record<string, unknown>, it: number, ctx: StreamContext): Promise<Draft[]> {
  if (typeof record.prompt === 'string') {
    return [await promptEntry(record.prompt, ctx, record.images)];
  }
  if (record.state !== undefined) {
    const state = asRecord(record.state);
    const error = asRecord(state.error);
    const code = typeof error.code === 'string' ? error.code : null;
    const text = limitStateText(state.from, state.to);
    const entry: Draft = {
      t: 'state', who: 'factory', from: typeof state.from === 'string' ? state.from : null, to: String(state.to),
      code, msg: typeof error.message === 'string' ? error.message : null, ...(text !== undefined ? { text } : {}),
    };
    return [entry, ...(await changesEntry({ from: state.from, to: state.to, code }, it, ctx))];
  }
  if (record.type === 'review' || record.type === 'review_failed') {
    return record.type === 'review' && record.ignored !== true ? [await verdictEntry(record, it, ctx)] : noteEntry(raw, reviewerWho(record.reviewer));
  }
  if (record.type === 'simplify') {
    if (record.ignored === true) {
      return noteEntry(raw, reviewerWho(record.reviewer));
    }
    return typeof record.error === 'string' ? noteEntry(raw, 'factory') : [await simplifyEntry(it, ctx)];
  }
  if (record.type === 'review_message') {
    // The Claude review's and the simplification pass's session alike.
    return messageEntries(asRecord(record.message), 'claude');
  }
  if (record.type === 'gate_event') {
    return codexEntries(asRecord(record.event)) ?? noteEntry(raw, 'codex');
  }
  // The MR text (SF-080): the user's save or reset; a new Clean that kept the user's text.
  if (record.type === 'mr_edited') {
    return noteEntry(raw, record.action === 'factory_new' ? 'factory' : 'you');
  }
  if (record.type === undefined && record.message !== undefined) {
    const message = asRecord(record.message);
    return message.type === 'system' ? noteEntry(raw, 'factory') : messageEntries(message, 'implementer');
  }
  return noteEntry(raw, 'factory');
}

// The entries of one events.jsonl line (0-based number line); none for a line that is not a JSON
// object or shows nothing.
export async function lineEntries(raw: string, line: number, ctx: StreamContext): Promise<StreamEntry[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }
  const record = parsed as Record<string, unknown>;
  const it = Math.max(1, typeof record.iteration === 'number' ? record.iteration : 1);
  const ts = typeof record.ts === 'string' ? record.ts : null;
  const entries = await drafts(raw, record, it, ctx);
  return entries.map((entry, index) => ({ ...entry, k: entries.length === 1 ? String(line) : `${line}.${index}`, ts, it }));
}
