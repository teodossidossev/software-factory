// Unit tests of the live reviewer events (SF-045): the cut of an event above its bound, and the
// lines sf watch and the dashboard's Event stream print for each kind of Codex event and Claude
// review message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutEvent, MAX_LIVE_EVENT_BYTES } from '../src/jobs.js';
import { describeEvent, formatEvent } from '../src/watch.js';

// The lines print local time (SF-049); UTC here keeps the stored and the printed time alike.
process.env.TZ = 'UTC';

const TS = '2026-11-04T10:11:12.000Z';
const gate = (event: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: TS, iteration: 2, type: 'gate_event', reviewer: 'codex', event, ...extra });
const review = (message: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: TS, iteration: 3, type: 'review_message', reviewer: 'claude', message, ...extra });
const assistant = (content: unknown[]): Record<string, unknown> => ({ type: 'assistant', message: { role: 'assistant', content } });

test('cutEvent: an event within the bound stays as it is; a larger one is cut below it, still an object with its type', () => {
  const small = { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'ok' } };
  assert.deepEqual(cutEvent(small), { value: small, truncated: false });

  const output = 'x'.repeat(40 * 1024);
  const big = { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'cat big', aggregated_output: output, exit_code: 0 } };
  const cut = cutEvent(big);
  assert.equal(cut.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(cut.value)) <= MAX_LIVE_EVENT_BYTES);
  const item = (cut.value as { type: string; item: Record<string, unknown> }).item;
  assert.equal((cut.value as { type: string }).type, 'item.completed');
  assert.deepEqual([item.type, item.command, item.exit_code], ['command_execution', 'cat big', 0]);
  assert.ok(String(item.aggregated_output).startsWith('xxx') && String(item.aggregated_output).endsWith('…'));

  // Many small strings: still cut below the bound.
  const wide = { type: 'item.updated', item: { type: 'todo_list', items: Array.from({ length: 5000 }, (_, index) => ({ text: `step ${index}`, completed: false })) } };
  const cutWide = cutEvent(wide);
  assert.equal(cutWide.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(cutWide.value)) <= MAX_LIVE_EVENT_BYTES);
  assert.equal((cutWide.value as { type: string }).type, 'item.updated');

  // Multi-byte text is measured in bytes, and no surrogate pair is split.
  const emoji = cutEvent({ type: 'x', text: '😀'.repeat(10_000) });
  assert.equal(emoji.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(emoji.value)) <= MAX_LIVE_EVENT_BYTES);
  assert.doesNotMatch(JSON.stringify(emoji.value), /\\ud83d(?!\\ude00)/);
});

test('Codex events: a command started and completed, a message, reasoning, a turn completed, errors; the rest prints nothing', () => {
  const prefix = '10:11:12 [2]';
  assert.deepEqual(formatEvent(gate({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc \'git diff abc\'', aggregated_output: '', status: 'in_progress' } })),
    [`${prefix} codex | $ bash -lc 'git diff abc'`]);
  assert.deepEqual(formatEvent(gate({ type: 'item.started', item: { type: 'command_execution', command: ['git', 'status'] } })), [`${prefix} codex | $ git status`]);
  const output = ['diff --git a/x b/x', '', 'index 1..2', '+one', '+two', '+three'].join('\n');
  assert.deepEqual(formatEvent(gate({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'git diff', aggregated_output: output, exit_code: 0, status: 'completed' } })), [
    `${prefix} codex | exit 0`,
    `${prefix} codex |   diff --git a/x b/x`,
    `${prefix} codex |   index 1..2`,
    `${prefix} codex |   +one`,
    `${prefix} codex |   …`,
  ]);
  assert.deepEqual(formatEvent(gate({ type: 'item.completed', item: { type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'failed' } })), [`${prefix} codex | exit 1`]);
  const long = formatEvent(gate({ type: 'item.completed', item: { type: 'command_execution', command: 'cat', aggregated_output: 'y'.repeat(500), exit_code: 0 } }));
  assert.equal(long.length, 2);
  assert.ok(long[1]!.length < 260 && long[1]!.endsWith('…'), long[1]);

  assert.deepEqual(formatEvent(gate({ type: 'item.completed', item: { type: 'agent_message', text: 'Looks right.\n\nOne more thing.' } })),
    [`${prefix} codex | Looks right.`, `${prefix} codex | One more thing.`]);
  assert.deepEqual(formatEvent(gate({ type: 'item.completed', item: { type: 'reasoning', text: '**Checking the diff**\n\nI will read it.' } })),
    [`${prefix} codex | reasoning: **Checking the diff**`]);
  assert.deepEqual(formatEvent(gate({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 34 } })),
    [`${prefix} codex | turn completed (1200 in, 34 out tokens)`]);
  assert.deepEqual(formatEvent(gate({ type: 'error', message: 'stream\ndisconnected' })), [`${prefix} codex | error: stream disconnected`]);
  assert.deepEqual(formatEvent(gate({ type: 'turn.failed', error: { message: 'quota exceeded' } })), [`${prefix} codex | error: quota exceeded`]);
  assert.deepEqual(formatEvent(gate({ type: 'item.completed', item: { type: 'error', message: 'command refused' } })), [`${prefix} codex | error: command refused`]);
  for (const quiet of [
    { type: 'thread.started', thread_id: 't' }, { type: 'turn.started' },
    { type: 'item.started', item: { type: 'agent_message', text: '' } }, { type: 'item.updated', item: { type: 'todo_list', items: [] } },
    'not an object', null,
  ]) {
    assert.deepEqual(formatEvent(gate(quiet)), [], JSON.stringify(quiet));
  }
  assert.deepEqual(describeEvent(gate({ type: 'turn.started' })), { ts: TS, iteration: 2, type: 'gate_event', lines: [] });
});

test('a cut Codex event is marked, also one that would print nothing', () => {
  const prefix = '10:11:12 [2]';
  assert.deepEqual(formatEvent(gate({ type: 'item.completed', item: { type: 'agent_message', text: 'Long…' } }, { truncated: true })), [`${prefix} codex | Long… (cut)`]);
  assert.deepEqual(formatEvent(gate({ type: 'item.updated', item: { type: 'todo_list' } }, { truncated: true })), [`${prefix} codex | item.updated (cut)`]);
});

test('Claude review messages: tool uses with a short input, assistant text; init, tool results and the result print nothing', () => {
  const prefix = '10:11:12 [3]';
  assert.deepEqual(formatEvent(review(assistant([
    { type: 'text', text: 'Let me read the change.\nThen the tests.' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/watch.ts', offset: 10 } },
    { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'describeEvent', path: 'src' } },
    { type: 'tool_use', id: 't3', name: 'Glob', input: { pattern: 'test/**/*.ts' } },
    { type: 'tool_use', id: 't4', name: 'Other', input: { a: 1 } },
    { type: 'tool_use', id: 't5', name: 'Read', input: { file_path: `src/${'d/'.repeat(100)}x.ts` } },
  ]))), [
    `${prefix} review | Let me read the change.`,
    `${prefix} review | Then the tests.`,
    `${prefix} review | Read(src/watch.ts)`,
    `${prefix} review | Grep(describeEvent)`,
    `${prefix} review | Glob(test/**/*.ts)`,
    `${prefix} review | Other({"a":1})`,
    `${prefix} review | Read(${`src/${'d/'.repeat(100)}x.ts`.slice(0, 119)}…)`,
  ]);
  for (const quiet of [
    { type: 'system', subtype: 'init', session_id: 's', permissionMode: 'auto', model: 'm' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file text' }] } },
    { type: 'result', subtype: 'success', total_cost_usd: 0.04, duration_ms: 1000, num_turns: 3 },
  ]) {
    assert.deepEqual(formatEvent(review(quiet)), [], JSON.stringify(quiet));
  }
  assert.equal(describeEvent(review(assistant([{ type: 'text', text: 'x' }])))?.type, 'review_message');
  assert.deepEqual(formatEvent(review(assistant([{ type: 'text', text: 'Cut text' }]), { truncated: true })), [`${prefix} review | Cut text (cut)`]);
  assert.deepEqual(formatEvent(review({ type: 'user' }, { truncated: true })), [`${prefix} review | user (cut)`]);
});

test('the Implementer\'s messages print as before', () => {
  assert.deepEqual(formatEvent(JSON.stringify({ ts: TS, iteration: 1, message: assistant([{ type: 'text', text: 'Done.' }]) })), ['10:11:12 [1] assistant: Done.']);
});

test('the MR text (SF-080): the user\'s save and reset, with a branch or base the save changed, and a new Clean that kept the user\'s text', () => {
  const edited = (extra: Record<string, unknown>): string => JSON.stringify({ ts: TS, iteration: 2, type: 'mr_edited', ...extra });
  assert.deepEqual(describeEvent(edited({ action: 'saved' })), { ts: TS, iteration: 2, type: 'mr_edited', lines: ['10:11:12 [2] You edited the MR text'] });
  assert.deepEqual(formatEvent(edited({ action: 'saved', branch: 'T-1-other' })), ['10:11:12 [2] You edited the MR text (branch T-1-other)']);
  assert.deepEqual(formatEvent(edited({ action: 'saved', base: 'release' })), ['10:11:12 [2] You edited the MR text (base release)']);
  assert.deepEqual(formatEvent(edited({ action: 'reset' })), ["10:11:12 [2] You reset the MR text to the factory's"]);
  assert.deepEqual(formatEvent(edited({ action: 'factory_new' })), ['10:11:12 [2] Clean wrote a new MR text; yours is kept. Compare or reset on the Merge request screen.']);
});

test('the park on a usage limit and the resume from it (SF-072): their own lines; the other changes of waiting_limit as state changes', () => {
  const state = (from: string, to: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ ts: TS, iteration: 1, state: { from, to, ...extra } });
  assert.deepEqual(describeEvent(state('working', 'waiting_limit')), { ts: TS, iteration: 1, type: 'state', lines: ['10:11:12 [1] Parked: usage limit reached'] });
  assert.deepEqual(formatEvent(state('waiting_limit', 'working')), ['10:11:12 [1] Resumed after the usage limit reset']);
  assert.deepEqual(formatEvent(state('waiting_limit', 'awaiting_review')), ['10:11:12 [1] Resumed after the usage limit reset']);
  assert.deepEqual(formatEvent(state('waiting_limit', 'aborted')), ['10:11:12 [1] state waiting_limit -> aborted']);
  assert.deepEqual(formatEvent(state('waiting_limit', 'needs_human', { error: { code: 'worktree_missing', message: 'gone' } })), ['10:11:12 [1] state waiting_limit -> needs_human (worktree_missing: gone)']);
});

test('the job\'s images (SF-065): one attachments line with each name, type and size; none when the set became empty', () => {
  const images = [{ name: '1.png', type: 'image/png', bytes: 12345, sha256: 'a'.repeat(64) }, { name: 'form.gif', type: 'image/gif', bytes: 99, sha256: 'b'.repeat(64) }];
  assert.deepEqual(describeEvent(JSON.stringify({ ts: TS, iteration: 0, type: 'attachments', images })), {
    ts: TS, iteration: 0, type: 'attachments', lines: ['10:11:12 [0] attachments: 1.png (image/png, 12345 bytes), form.gif (image/gif, 99 bytes)'],
  });
  assert.deepEqual(formatEvent(JSON.stringify({ ts: TS, iteration: 3, type: 'attachments', images: [] })), ['10:11:12 [3] attachments: none']);
});
