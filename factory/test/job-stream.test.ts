// Unit tests of the job's Stream builder (SF-082): each events.jsonl record as the typed entries
// of the dashboard's job page, joined with the job's files through a fake StreamContext.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { changeNote, firstPrompt } from '../src/execution.js';
import { DETAIL_CHARS, lineEntries, type StreamContext, streamContext, type StreamEntry } from '../src/job-stream.js';
import { type GateRecord, type IterationMeta, JobStore, type ReviewRecord, type SimplifyRecord } from '../src/jobs.js';
import type { LedgerEntry } from '../src/ledger.js';
import { FACTORY_PROMPT_RULES, factoryPrompt } from '../src/prompts.js';
import type { ReviewItem } from '../src/review.js';
import { temp } from './support/harness.js';

const TS = '2026-11-05T10:11:12.000Z';

interface Files {
  task?: string;
  meta?: Record<number, IterationMeta>;
  review?: Record<number, ReviewRecord>;
  gate?: Record<number, GateRecord>;
  simplify?: Record<number, SimplifyRecord>;
  ledger?: LedgerEntry[];
}

function fakeContext(files: Files = {}): StreamContext {
  return {
    taskCopy: async () => files.task,
    meta: async (n) => files.meta?.[n],
    review: async (n) => files.review?.[n],
    gate: async (n) => files.gate?.[n],
    simplify: async (n) => files.simplify?.[n],
    ledger: async () => files.ledger ?? [],
  };
}

const build = (record: Record<string, unknown>, files?: Files, line = 7): Promise<StreamEntry[]> =>
  lineEntries(JSON.stringify({ ts: TS, iteration: 2, ...record }), line, fakeContext(files));
const one = async (record: Record<string, unknown>, files?: Files): Promise<any> => {
  const entries = await build(record, files);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  return entries[0];
};
const assistant = (content: unknown[]): Record<string, unknown> => ({ type: 'assistant', message: { role: 'assistant', content } });
const user = (content: unknown[]): Record<string, unknown> => ({ type: 'user', message: { role: 'user', content } });

function meta(iteration: number, extra: Partial<IterationMeta> = {}): IterationMeta {
  return {
    iteration, started_at: TS, ended_at: TS, denials: [], changed_files: [{ path: 'old.ts', added: 1, removed: 0 }],
    patch_truncated: false, submodule_changed: [], cost_usd: 0.1, cost_usd_total: 0.1, duration_ms: 10, ...extra,
  };
}

function ledgerEntry(id: string, reviewer: string, iteration: number, path: string, problem: string): LedgerEntry {
  return {
    id, iteration, reviewer, severity: 'major', path, problem, expected: 'e', status: 'open', response: '', evidence: '',
    reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null,
  };
}

test('lineEntries: prompt kinds by the first line; the rules block never in text; the Task-change note cut and flagged', async () => {
  const implement = await one({ prompt: factoryPrompt('/implement .software-factory/T-1.md', 'T-1', 2) });
  assert.deepEqual(implement, {
    t: 'prompt', who: 'factory', kind: 'implement', text: '/implement .software-factory/T-1.md', first: '/implement .software-factory/T-1.md',
    task_changed: false, k: '7', ts: TS, it: 2,
  });
  const kept = await one({ prompt: factoryPrompt(firstPrompt('T-1', ['a.ts', 'b.ts']), 'T-1', 1) });
  assert.deepEqual([kept.t, kept.kind, kept.first], ['prompt', 'implement', '/implement .software-factory/T-1.md']);
  assert.match(kept.text, /a\.ts, b\.ts/);

  const task = '# T-1\n\n## Fix 1\n\n1. [R1, major] a.ts: one.\n\n## Fix 2: Simplify\n\n```\n## not a heading\n```\n1. [R2, nit] b.ts: two.\n';
  const fix = await one({ prompt: factoryPrompt('/implement .software-factory/T-1.md Fix 2', 'T-1', 3) }, { task });
  assert.deepEqual([fix.t, fix.who, fix.kind, fix.fix_n], ['prompt', 'factory', 'fix', 2]);
  assert.equal(fix.fix, '## Fix 2: Simplify\n\n```\n## not a heading\n```\n1. [R2, nit] b.ts: two.');
  assert.equal((await one({ prompt: '/implement .software-factory/T-1.md Fix 1' }, { task })).fix, '## Fix 1\n\n1. [R1, major] a.ts: one.');
  // A section missing from task.md (or no task.md) is "".
  assert.equal((await one({ prompt: '/implement .software-factory/T-1.md Fix 5' }, { task })).fix, '');
  assert.equal((await one({ prompt: '/implement .software-factory/T-1.md Fix 1' })).fix, '');

  const mr = await one({ prompt: 'MR preparation for T-1 on branch T-1-x. The user approved the reviewed change.\nTarget: main at abc.' });
  assert.deepEqual([mr.t, mr.who, mr.kind, mr.first], ['prompt', 'mr', 'mr', 'MR preparation for T-1 on branch T-1-x. The user approved the reviewed change.']);
  const conflict = await one({ prompt: "The factory's rebase of T-1 onto main (abc) stopped with conflicts in these files:\n- a.ts" });
  assert.deepEqual([conflict.t, conflict.who, conflict.kind], ['prompt', 'factory', 'conflict']);
  const resumed = await one({ prompt: factoryPrompt('Continue where you stopped.', 'T-1', 2) });
  assert.deepEqual([resumed.t, resumed.who, resumed.kind, resumed.text], ['prompt', 'factory', 'continue', 'Continue where you stopped.']);

  // Anything else is the user's own message; a Task-change note is cut from text and flagged.
  const said = await one({ prompt: factoryPrompt(`Please also cover b.ts.\n\n${changeNote('T-1', '-a\n+b')}`, 'T-1', 2) });
  assert.deepEqual(said, { t: 'user', who: 'you', text: 'Please also cover b.ts.', task_changed: true, k: '7', ts: TS, it: 2 });
  const fixChanged = await one({ prompt: factoryPrompt(`/implement .software-factory/T-1.md Fix 1\n\n${changeNote('T-1', undefined)}`, 'T-1', 2) }, { task });
  assert.deepEqual([fixChanged.kind, fixChanged.text, fixChanged.task_changed], ['fix', '/implement .software-factory/T-1.md Fix 1', true]);
  // A user message that only looks like a command is the user's.
  assert.equal((await one({ prompt: '/implement .software-factory/T-1.md\n\nand more' })).t, 'user');

  for (const entry of [implement, kept, fix, mr, conflict, resumed, said, fixChanged]) {
    assert.ok(!JSON.stringify(entry).includes('Rules from the Software Factory'), entry.k);
    assert.ok(!JSON.stringify(entry).includes(FACTORY_PROMPT_RULES.split('\n')[1]!));
  }
});

test('lineEntries: text of the Implementer, the Claude review and Codex; Codex JSON output dropped; several entries keyed by block', async () => {
  const entries = await build({ message: assistant([{ type: 'text', text: '  Working on it\nsecond line ' }, { type: 'text', text: '   ' }, { type: 'text', text: 'Done.' }]) });
  assert.deepEqual(entries.map((entry) => [entry.k, entry.t, entry.who, (entry as { text: string }).text]), [
    // The text as recorded: trimmed only to tell an empty block.
    ['7.0', 'text', 'implementer', '  Working on it\nsecond line '], ['7.1', 'text', 'implementer', 'Done.'],
  ]);
  const review = await one({ type: 'review_message', reviewer: 'claude', message: assistant([{ type: 'text', text: 'Reading the patch.' }]) });
  assert.deepEqual([review.t, review.who, review.text], ['text', 'claude', 'Reading the patch.']);
  const simplify = await one({ type: 'review_message', reviewer: 'simplify', message: assistant([{ type: 'text', text: 'Looking for extra code.' }]) });
  assert.deepEqual([simplify.t, simplify.who], ['text', 'claude']);
  const codex = await one({ type: 'gate_event', reviewer: 'codex', event: { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '  Checking the tests.\n' } } });
  assert.deepEqual([codex.t, codex.who, codex.text], ['text', 'codex', '  Checking the tests.\n']);
  const indented = await one({ type: 'review_message', reviewer: 'claude', message: assistant([{ type: 'text', text: '    code()\n' }]) });
  assert.equal(indented.text, '    code()\n');
  assert.deepEqual(await build({ type: 'gate_event', reviewer: 'codex', event: { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: ' \n ' } } }), []);
  assert.deepEqual(await build({ type: 'gate_event', reviewer: 'codex', event: { type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: '\n{"verdict":"fix","items":[]}\n' } } }), []);
  assert.deepEqual(await build({ type: 'gate_event', reviewer: 'codex', event: { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: '{"verdict":"clean","items":[]}' } } }), []);
});

test('lineEntries: tools and their results with the same id, errors, Codex commands, Bash lines, Claude review tools, cuts at 16384', async () => {
  const [text, tool] = await build({ message: assistant([{ type: 'text', text: 'Now.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'factory/src/jobs.ts' } }]) });
  assert.equal(text!.t, 'text');
  assert.deepEqual(tool, { t: 'tool', who: 'implementer', id: 'tu1', line: 'Read factory/src/jobs.ts', detail: '{\n  "file_path": "factory/src/jobs.ts"\n}', k: '7.1', ts: TS, it: 2 });
  const bash = await one({ message: assistant([{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }]) });
  assert.equal(bash.line, 'Bash npm test');
  const other = await one({ message: assistant([{ type: 'tool_use', id: 'tu3', name: 'TodoWrite', input: { todos: [] } }]) });
  assert.equal(other.line, 'TodoWrite {"todos":[]}');
  const long = await one({ message: assistant([{ type: 'tool_use', id: 'tu4', name: 'Bash', input: { command: `echo ${'x'.repeat(300)}` } }]) });
  assert.equal(long.line.length, 120);
  assert.ok(long.line.endsWith('…'));

  const result = await one({ message: user([{ type: 'tool_result', tool_use_id: 'tu1', content: 'a\nb\nc\n' }]) });
  assert.deepEqual(result, { t: 'tool_result', who: 'implementer', id: 'tu1', out: '3 lines', result: 'a\nb\nc\n', err: false, k: '7', ts: TS, it: 2 });
  const parts = await one({ message: user([{ type: 'tool_result', tool_use_id: 'tu5', content: [{ type: 'text', text: 'only' }] }]) });
  assert.deepEqual([parts.out, parts.result], ['1 line', 'only']);
  const failed = await one({ message: user([{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'Exit code 1\nnpm ERR!' }]) });
  assert.deepEqual([failed.out, failed.err, failed.result], ['failed: Exit code 1', true, 'Exit code 1\nnpm ERR!']);

  const started = await one({ type: 'gate_event', reviewer: 'codex', event: { type: 'item.started', item: { id: 'item_3', type: 'command_execution', command: 'bash -lc "npm test"', status: 'in_progress' } } });
  assert.deepEqual([started.t, started.who, started.id, started.line], ['tool', 'codex', 'item_3', '$ bash -lc "npm test"']);
  assert.equal(started.detail, '{\n  "command": "bash -lc \\"npm test\\""\n}');
  const exited = await one({ type: 'gate_event', reviewer: 'codex', event: { type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: 'npm test', aggregated_output: 'fail\n', exit_code: 1 } } });
  assert.deepEqual([exited.t, exited.who, exited.id, exited.out, exited.result, exited.err], ['tool_result', 'codex', 'item_3', 'exit 1', 'fail\n', true]);
  const ok = await one({ type: 'gate_event', reviewer: 'codex', event: { type: 'item.completed', item: { id: 'item_4', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: 0 } } });
  assert.deepEqual([ok.out, ok.err], ['exit 0', false]);

  // The Claude review's tool and its result, inside review_message records.
  const reviewTool = await one({ type: 'review_message', reviewer: 'claude', message: assistant([{ type: 'tool_use', id: 'rv1', name: 'Grep', input: { pattern: 'lineEntries' } }]) });
  assert.deepEqual([reviewTool.t, reviewTool.who, reviewTool.id, reviewTool.line], ['tool', 'claude', 'rv1', 'Grep lineEntries']);
  const reviewResult = await one({ type: 'review_message', reviewer: 'claude', message: user([{ type: 'tool_result', tool_use_id: 'rv1', content: 'src/job-stream.ts' }]) });
  assert.deepEqual([reviewResult.t, reviewResult.who, reviewResult.id, reviewResult.out], ['tool_result', 'claude', 'rv1', '1 line']);

  // Inputs and results are cut at 16384 characters, the last one the mark.
  const big = 'y'.repeat(40_000);
  const bigTool = await one({ message: assistant([{ type: 'tool_use', id: 'tu6', name: 'Write', input: { file_path: 'a.ts', content: big } }]) });
  assert.equal(bigTool.detail.length, DETAIL_CHARS);
  assert.ok(bigTool.detail.endsWith('…'));
  assert.equal(bigTool.line, 'Write a.ts');
  const bigResult = await one({ message: user([{ type: 'tool_result', tool_use_id: 'tu6', content: big }]) });
  assert.equal(bigResult.result.length, DETAIL_CHARS);
  assert.ok(bigResult.result.endsWith('…'));
  const bigOutput = await one({ type: 'gate_event', reviewer: 'codex', event: { type: 'item.completed', item: { id: 'i9', type: 'command_execution', aggregated_output: big, exit_code: 0 } } });
  assert.equal(bigOutput.result.length, DETAIL_CHARS);
  // A cut never splits a surrogate pair.
  const emoji = await one({ message: user([{ type: 'tool_result', tool_use_id: 'tu7', content: `${'z'.repeat(DETAIL_CHARS - 2)}😀😀` }]) });
  assert.ok(emoji.result.length <= DETAIL_CHARS);
  assert.doesNotMatch(emoji.result, /\p{Surrogate}/u);
});

test('lineEntries: results of the Implementer and inside a review_message; a system message there gives nothing', async () => {
  const result = await one({ message: { type: 'result', subtype: 'success', num_turns: 12, duration_ms: 34000, total_cost_usd: 0.42 } });
  assert.deepEqual(result, { t: 'result', who: 'implementer', turns: 12, ms: 34000, cost: 0.42, k: '7', ts: TS, it: 2 });
  const review = await one({ type: 'review_message', reviewer: 'claude', message: { type: 'result', subtype: 'success', num_turns: 3 } });
  assert.deepEqual([review.t, review.who, review.turns, review.ms, review.cost], ['result', 'claude', 3, null, null]);
  const simplify = await one({ type: 'review_message', reviewer: 'simplify', message: { type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.01 } });
  assert.deepEqual([simplify.who, simplify.cost], ['claude', 0.01]);
  assert.deepEqual(await build({ type: 'review_message', reviewer: 'claude', message: { type: 'system', subtype: 'init', session_id: 's', model: 'm' } }), []);
});

test('lineEntries: a verdict joined with review.json and gate.json; ledger ids by the exact key, by reopens, or none; a file of another verdict or count not joined', async () => {
  const items: ReviewItem[] = [
    { severity: 'blocker', path: 'a.ts', problem: 'Broken.', expected: 'Fixed.' },
    { severity: 'nit', path: 'b.ts', problem: 'Name.', expected: 'Better.', reopens: 'R4' },
    { severity: 'major', path: 'c.ts', problem: 'Other.', expected: 'This.', reopens: '' },
  ];
  const review: ReviewRecord = { reviewer: 'claude', verdict: 'fix', summary: 'Two things.', items, accepted_sensitive: [], cost_usd: 0.1, started_at: TS, ended_at: TS };
  const ledger = [
    ledgerEntry('R7', 'claude', 2, 'a.ts', 'Broken.'),
    // Same path and problem from another reviewer, another iteration, or another problem text: not this item.
    ledgerEntry('R8', 'codex', 2, 'c.ts', 'Other.'), ledgerEntry('R9', 'claude', 1, 'c.ts', 'Other.'), ledgerEntry('R10', 'claude', 2, 'c.ts', 'Other'),
  ];
  const record = { type: 'review', reviewer: 'claude', verdict: 'fix', items: 3 };
  const joined = await one(record, { review: { 2: review }, ledger });
  assert.deepEqual(joined, {
    t: 'verdict', who: 'claude', verdict: 'fix', effective: null, summary: 'Two things.', k: '7', ts: TS, it: 2,
    items: [
      { severity: 'blocker', path: 'a.ts', problem: 'Broken.', expected: 'Fixed.', id: 'R7' },
      { severity: 'nit', path: 'b.ts', problem: 'Name.', expected: 'Better.', id: 'R4' },
      { severity: 'major', path: 'c.ts', problem: 'Other.', expected: 'This.', id: null },
    ],
  });
  // A live build before the ledger write: the same entry without the ledger's ids.
  const live = await one(record, { review: { 2: review } });
  assert.deepEqual(live.items.map((item: { id: string | null }) => item.id), [null, 'R4', null]);

  // A review file a retry rewrote (another verdict or another count), a failed or a missing one: no summary, no items.
  const others: Array<ReviewRecord | undefined> = [{ ...review, verdict: 'clean' }, { ...review, items: items.slice(0, 2) }, { reviewer: 'claude', error: 'boom' }, undefined];
  for (const file of others) {
    const entry = await one(record, { review: file === undefined ? {} : { 2: file }, ledger });
    assert.deepEqual(entry, { t: 'verdict', who: 'claude', verdict: 'fix', effective: null, k: '7', ts: TS, it: 2 });
  }

  // The gate's verdict reads gate.json, never review.json; effective is kept.
  const gate: GateRecord = {
    reviewer: 'codex', verdict: 'fix', summary: 'Only nits.', items: [{ severity: 'nit', path: 'd.ts', problem: 'P.', expected: 'E.' }], accepted_sensitive: [],
    tokens: { input: 1, cached_input: 0, output: 1 }, started_at: TS, ended_at: TS,
  };
  const codex = await one({ type: 'review', reviewer: 'codex', verdict: 'fix', items: 1, effective: 'clean' }, { gate: { 2: gate }, review: { 2: review }, ledger: [ledgerEntry('R11', 'codex', 2, 'd.ts', 'P.')] });
  assert.deepEqual([codex.who, codex.effective, codex.summary, codex.items], ['codex', 'clean', 'Only nits.', [{ severity: 'nit', path: 'd.ts', problem: 'P.', expected: 'E.', id: 'R11' }]]);
  const clean = await one({ type: 'review', reviewer: 'claude', verdict: 'clean', items: 0 }, { review: { 2: { ...review, verdict: 'clean', items: [], summary: 'Fine.' } } });
  assert.deepEqual([clean.verdict, clean.summary, clean.items], ['clean', 'Fine.', []]);
});

test('lineEntries: changes after a publish (working or preparing_mr to awaiting_review, an escalation from working), none after a retry', async () => {
  const files: Files = {
    meta: {
      2: meta(2, { files: [{ path: 'a.ts', status: 'modified', sensitive: 'no', scope: 'in', additions: 1, deletions: 0 }, { path: 'b.ts', status: 'added', sensitive: 'no', scope: 'in', additions: 2, deletions: 0 }] }),
      3: meta(3),
    },
  };
  const published = await build({ state: { from: 'working', to: 'awaiting_review' } }, files);
  assert.deepEqual(published, [
    { t: 'state', who: 'factory', from: 'working', to: 'awaiting_review', code: null, msg: null, k: '7.0', ts: TS, it: 2 },
    { t: 'changes', who: 'factory', files: 2, paths: ['a.ts', 'b.ts'], k: '7.1', ts: TS, it: 2 },
  ]);
  const conflict = await build({ state: { from: 'preparing_mr', to: 'awaiting_review' } }, files);
  assert.deepEqual(conflict.map((entry) => entry.t), ['state', 'changes']);
  const escalated = await build({ state: { from: 'working', to: 'needs_human', error: { code: 'escalated', message: 'R3 asks.' } } }, files);
  assert.deepEqual(escalated.map((entry) => entry.t), ['state', 'changes']);
  assert.deepEqual([(escalated[0] as { code: string }).code, (escalated[0] as { msg: string }).msg], ['escalated', 'R3 asks.']);
  // Before SF-024: the paths of changed_files.
  const old = await build({ iteration: 3, state: { from: 'working', to: 'awaiting_review' } }, files);
  assert.deepEqual(old[1], { t: 'changes', who: 'factory', files: 1, paths: ['old.ts'], k: '7.1', ts: TS, it: 3 });

  // No changes entry: a retry from needs_human, other transitions, another stop from working, no meta.json.
  for (const state of [
    { from: 'needs_human', to: 'awaiting_review' }, { from: 'paused', to: 'awaiting_review' }, { from: 'starting', to: 'working' },
    { from: 'working', to: 'needs_human', error: { code: 'publish_failed', message: 'x' } }, { from: 'needs_human', to: 'needs_human', error: { code: 'escalated', message: 'x' } },
  ]) {
    assert.deepEqual((await build({ state }, files)).map((entry) => entry.t), ['state'], JSON.stringify(state));
  }
  assert.deepEqual((await build({ iteration: 4, state: { from: 'working', to: 'awaiting_review' } }, files)).map((entry) => entry.t), ['state']);
});

test('lineEntries: simplify with its suggestions and saves; notes with their who; it from the record, at least 1; a line not JSON gives nothing', async () => {
  const simplify: SimplifyRecord = {
    reviewer: 'simplify', summary: 'S.', dropped: [], cost_usd: null, model: null, started_at: TS, ended_at: TS,
    suggestions: [{ path: 'a.ts', what: 'Drop x.', why: 'Unused.', saves_lines: 12, ledger_ids: ['R1'] }, { path: 'b.ts', what: 'Inline y.', why: 'Once.', saves_lines: 3, ledger_ids: [] }],
  };
  const entry = await one({ type: 'simplify', reviewer: 'simplify', suggestions: 2, dropped: 0 }, { simplify: { 2: simplify } });
  assert.deepEqual(entry, {
    t: 'simplify', who: 'claude', saves_lines: 15, k: '7', ts: TS, it: 2,
    suggestions: [{ path: 'a.ts', what: 'Drop x.', why: 'Unused.', saves_lines: 12 }, { path: 'b.ts', what: 'Inline y.', why: 'Once.', saves_lines: 3 }],
  });

  const notes: Array<[Record<string, unknown>, string, string]> = [
    [{ type: 'simplify', reviewer: 'simplify', suggestions: 0, dropped: 0, error: 'timed out' }, 'factory', 'simplification pass failed: timed out'],
    [{ type: 'simplify', reviewer: 'simplify', suggestions: 1, dropped: 0, ignored: true }, 'claude', 'simplification pass: 1 suggestion (ignored: the job had moved on)'],
    [{ type: 'review', reviewer: 'codex', verdict: 'clean', items: 0, ignored: true }, 'codex', 'review by codex: clean (ignored: the job had moved on)'],
    [{ type: 'review_failed', reviewer: 'claude', error: 'boom' }, 'claude', 'review by claude failed: boom'],
    [{ type: 'review_failed', reviewer: 'codex', error: 'exit 2' }, 'codex', 'review by codex failed: exit 2'],
    [{ type: 'placeholders_removed', paths: ['.bashrc'] }, 'factory', 'placeholders removed: .bashrc'],
    [{ type: 'sandbox_lock_removed', path: '/repo/.git/config.lock' }, 'factory', 'removed the config lock the sandbox left: /repo/.git/config.lock'],
    // The MR text (SF-080): the user's save and reset are the user's; a new Clean's text is the factory's.
    [{ type: 'mr_edited', action: 'saved' }, 'you', 'You edited the MR text'],
    [{ type: 'mr_edited', action: 'saved', branch: 'T-1-other', base: 'release' }, 'you', 'You edited the MR text (branch T-1-other, base release)'],
    [{ type: 'mr_edited', action: 'reset' }, 'you', "You reset the MR text to the factory's"],
    [{ type: 'mr_edited', action: 'factory_new' }, 'factory', 'Clean wrote a new MR text; yours is kept. Compare or reset on the Merge request screen.'],
    [{ type: 'interrupted', step: 'review', reviewer: 'claude' }, 'factory', 'review by claude interrupted by the pause (no verdict; it runs again on Resume)'],
    [{ type: 'task_changed', from: null, to: 'a'.repeat(64) }, 'factory', 'the Task file changed while the job was paused; the new one is in use'],
    [{ type: 'merge_request', action: 'created', host: 'github', number: 4, url: 'https://x/4', mr_state: 'open' }, 'factory', 'merge request #4 opened: https://x/4'],
    [{ type: 'gate_overridden', code: 'gate_rounds', unapplied: 2 }, 'factory', 'gate overridden by the user (gate_rounds): 2 Codex items not applied'],
    [{ type: 'simplify_chosen', choice: 'skip', suggestions: 2 }, 'factory', 'simplification skipped by the user: 2 suggestions'],
    [{ type: 'notify_failed', channel: 'ntfy', message: 'down' }, 'factory', 'notification via ntfy failed: down'],
    [{ message: { type: 'system', subtype: 'init', session_id: 's1', permissionMode: 'default', model: 'opus' } }, 'factory', 'session s1 (permission mode default, model opus)'],
    [{ type: 'gate_event', reviewer: 'codex', event: { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'Thinking\nmore' } } }, 'codex', 'reasoning: Thinking'],
    [{ type: 'gate_event', reviewer: 'codex', event: { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 6 } } }, 'codex', 'turn completed (5 in, 6 out tokens)'],
    [{ type: 'gate_event', reviewer: 'codex', event: { type: 'error', message: 'stream broke' } }, 'codex', 'error: stream broke'],
  ];
  for (const [record, who, text] of notes) {
    assert.deepEqual(await one(record), { t: 'note', who, text, k: '7', ts: TS, it: 2 }, JSON.stringify(record));
  }
  // Records that describeEvent shows nothing of give nothing.
  for (const record of [
    { message: { type: 'system', subtype: 'compact_boundary' } }, { message: { type: 'user', message: { content: 'plain' } } },
    { type: 'gate_event', reviewer: 'codex', event: { type: 'thread.started' } }, { type: 'gate_event', reviewer: 'codex', event: { type: 'item.started', item: { type: 'agent_message' } } },
  ]) {
    assert.deepEqual(await build(record), [], JSON.stringify(record));
  }

  // it: the record's iteration, at least 1, for prompts, SDK messages and other records alike.
  for (const record of [{ prompt: 'hi' }, { message: assistant([{ type: 'text', text: 'x' }]) }, { state: { from: null, to: 'starting' } }, { type: 'task_changed', from: null, to: 'b' }]) {
    assert.equal((await one({ ...record, iteration: 0 })).it, 1);
    assert.equal((await one({ ...record, iteration: 4 })).it, 4);
  }
  assert.deepEqual(await lineEntries('not json', 0, fakeContext()), []);
  assert.deepEqual(await lineEntries('[1]', 0, fakeContext()), []);
  assert.deepEqual(await lineEntries('null', 0, fakeContext()), []);
});

test('streamContext: reads through the JobStore, caches within one context, a missing meta.json is undefined', async () => {
  const state = join(temp, 'job-stream-context');
  await mkdir(state, { recursive: true });
  const jobs = new JobStore(state);
  await mkdir(jobs.dir('app', 'T-1'), { recursive: true });
  await jobs.writeTaskCopy('app', 'T-1', Buffer.from('# T-1\n'));
  await jobs.writeIteration('app', 'T-1', { report: 'r', patch: Buffer.from(''), meta: meta(1) });
  const ctx = streamContext(jobs, 'app', 'T-1');
  assert.equal(await ctx.taskCopy(), '# T-1\n');
  assert.equal((await ctx.meta(1))?.iteration, 1);
  assert.equal(await ctx.meta(2), undefined);
  assert.equal(await ctx.review(1), undefined);
  assert.deepEqual(await ctx.ledger(), []);
  // Cached for this context; a new context reads the file again.
  await jobs.writeTaskCopy('app', 'T-1', Buffer.from('# T-1 changed\n'));
  assert.equal(await ctx.taskCopy(), '# T-1\n');
  assert.equal(await streamContext(jobs, 'app', 'T-1').taskCopy(), '# T-1 changed\n');
});
