// The chains of parts of the dashboard's tickets payload (src/chains.ts): grouped by workspace and
// part_of, filtered to the chains with an active Task file, counted, sorted, and each part's state
// from its live job first, else from one call of the dependency rule.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ChainFile, chainRows } from '../src/chains.js';
import type { Job } from '../src/jobs.js';
import type { DependencyRow, DependencyState } from '../src/setup.js';
import { parseFrontMatter, type TicketRef } from '../src/task-file.js';

const COMMIT = 'a'.repeat(40);

// A Task file of workspace name with the front matter lines front (after ticket, title and base).
function file(name: string, ticket: string, front: string, options: { job?: Job; archived?: boolean } = {}): ChainFile {
  const fields = parseFrontMatter(`---\nticket: ${ticket}\ntitle: t\nbase: main\n${front}---\n\n# ${ticket}\n`)!;
  return { name, ticket, fields, job: options.job, archived: options.archived ?? false };
}

function job(ticket: string, state: Job['state'], fields: Partial<Job> = {}): Job {
  return {
    workspace: 'app', ticket, branch: `${ticket}-x`, base: 'main', continues: null, builds_on: null, builds_on_commit: null, base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state, iteration: 1, session_id: null, mr: null,
    created_at: '2026-11-18T10:00:00.000Z', updated_at: '2026-11-18T10:00:00.000Z', ...fields,
  };
}

// The dependency rule's fake: each ticket's state from rule ("planned" without one), every call's refs recorded.
function rule(states: Record<string, DependencyState> = {}): { calls: TicketRef[][]; states: (refs: TicketRef[]) => Promise<DependencyRow[]> } {
  const calls: TicketRef[][] = [];
  return {
    calls,
    states: async (refs) => {
      calls.push(refs);
      return refs.map((ref) => ({ ...ref, state: states[ref.ticket] ?? 'planned' }));
    },
  };
}

const part = (n: number, of: number, partOf = 'APP-12'): string => `part_of: ${partOf}\nslice: ${n}/${of}\n`;
const summary = (rows: Awaited<ReturnType<typeof chainRows>>): string[] => rows.map((row) => `${row.workspace}/${row.ticket} ${row.count}: ${row.parts.map((p) => `${p.n}:${p.ticket}:${p.state}`).join(' ')}`);

test('two workspaces and two part_of values make separate rows, sorted by workspace then main ticket', async () => {
  const fake = rule();
  const rows = await chainRows([
    file('web', 'W-1', part(1, 2, 'WEB-1')),
    file('app', 'B-1', part(1, 2, 'APP-20')),
    file('app', 'A-1', part(1, 2, 'APP-12')),
    file('app', 'A-2', part(2, 2, 'APP-12')),
  ], fake.states);
  assert.deepEqual(summary(rows), ['app/APP-12 2: 1:A-1:planned 2:A-2:planned', 'app/APP-20 2: 1:B-1:planned', 'web/WEB-1 2: 1:W-1:planned']);
  assert.deepEqual(rows[0], {
    workspace: 'app', ticket: 'APP-12', count: 2,
    parts: [{ ticket: 'A-1', n: 1, base: 'main', state: 'planned' }, { ticket: 'A-2', n: 2, base: 'main', state: 'planned' }],
  });
});

test('a file without slice, without part_of, or with a slice that is not valid is no part', async () => {
  const rows = await chainRows([
    file('app', 'T-1', part(1, 3)),
    file('app', 'T-2', 'part_of: APP-12\n'),
    file('app', 'T-3', 'slice: 3/3\n'),
    file('app', 'T-4', 'part_of: APP-12\nslice: 5/3\n'),
    file('app', 'T-5', ''),
  ], rule().states);
  assert.deepEqual(summary(rows), ['app/APP-12 3: 1:T-1:planned']);
});

test('an archived file beside an active one of the same ticket counts once, as the active one', async () => {
  const fake = rule({ 'T-1': 'merged' });
  const rows = await chainRows([
    file('app', 'T-1', part(1, 2), { job: job('T-1', 'working') }),
    file('app', 'T-1', part(2, 4), { archived: true }),
  ], fake.states);
  assert.deepEqual(summary(rows), ['app/APP-12 2: 1:T-1:working']);
  assert.deepEqual(fake.calls, []);
  // The same ticket in another workspace is another file.
  assert.deepEqual(summary(await chainRows([file('app', 'T-1', part(1, 2)), file('web', 'T-1', part(2, 2), { archived: true })], rule().states)), ['app/APP-12 2: 1:T-1:planned']);
});

test('count is the largest M; the parts are sorted by n, then by ticket, and two files with one n both stay', async () => {
  const rows = await chainRows([
    file('app', 'T-9', part(3, 3)),
    file('app', 'T-B', part(1, 5)),
    file('app', 'T-A', part(1, 4)),
    file('app', 'T-2', part(2, 3)),
  ], rule().states);
  assert.equal(rows[0]!.count, 5);
  assert.deepEqual(rows[0]!.parts.map((p) => `${p.n}:${p.ticket}`), ['1:T-A', '1:T-B', '2:T-2', '3:T-9']);
});

test('a part\'s base is its front matter\'s base', async () => {
  const develop = file('app', 'T-1', part(1, 2));
  develop.fields.set('base', 'develop');
  assert.equal((await chainRows([develop], rule().states))[0]!.parts[0]!.base, 'develop');
});

test('the states: from the live job first, else from the dependency rule; states is asked only for the parts without a live job, once', async () => {
  const fake = rule({ 'T-7': 'running', 'T-8': 'merged', 'T-9': 'pushed', 'T-10': 'missing', 'T-11': 'planned', 'T-12': 'merged' });
  const rows = await chainRows([
    file('app', 'T-1', part(1, 12), { job: job('T-1', 'ready_for_human_review', { builds_on: 'T-0', builds_on_commit: COMMIT }) }),
    file('app', 'T-2', part(2, 12), { job: job('T-2', 'ready_for_human_review') }),
    file('app', 'T-3', part(3, 12), { job: job('T-3', 'handed_over', { builds_on: 'T-0', builds_on_commit: COMMIT }) }),
    file('app', 'T-4', part(4, 12), { job: job('T-4', 'paused') }),
    file('app', 'T-5', part(5, 12), { job: job('T-5', 'needs_human') }),
    file('app', 'T-6', part(6, 12), { job: job('T-6', 'preparing_mr') }),
    file('app', 'T-7', part(7, 12)),
    file('app', 'T-8', part(8, 12), { job: job('T-8', 'pushed'), archived: true }),
    file('app', 'T-9', part(9, 12), { job: job('T-9', 'pushed') }),
    file('app', 'T-10', part(10, 12)),
    file('app', 'T-11', part(11, 12), { job: job('T-11', 'failed') }),
    file('app', 'T-12', part(12, 12), { job: job('T-12', 'handed_over', { builds_on: 'T-0', builds_on_commit: null }) }),
  ], fake.states);
  assert.deepEqual(rows[0]!.parts.map((p) => `${p.ticket}:${p.state}`), [
    'T-1:on_part', 'T-2:ready', 'T-3:on_part', 'T-4:stopped', 'T-5:stopped', 'T-6:working', 'T-7:working', 'T-8:merged', 'T-9:submitted', 'T-10:planned', 'T-11:planned', 'T-12:ready',
  ]);
  assert.deepEqual(fake.calls, [['T-7', 'T-8', 'T-9', 'T-10', 'T-11'].map((ticket) => ({ workspace: 'app', ticket }))]);
});

test('states is not called when every part has a live job, nor with no part at all', async () => {
  const fake = rule();
  assert.deepEqual(summary(await chainRows([file('app', 'T-1', part(1, 2), { job: job('T-1', 'working') })], fake.states)), ['app/APP-12 2: 1:T-1:working']);
  assert.deepEqual(await chainRows([], fake.states), []);
  assert.deepEqual(await chainRows([file('app', 'T-1', '')], fake.states), []);
  assert.deepEqual(fake.calls, []);
});

test('a chain whose parts are all archived is left out, kept when its main ticket has an active file in that workspace', async () => {
  const fake = rule({ 'T-1': 'merged', 'T-2': 'merged' });
  const archived = [file('app', 'T-1', part(1, 2), { archived: true }), file('app', 'T-2', part(2, 2), { archived: true })];
  assert.deepEqual(await chainRows(archived, fake.states), []);
  assert.deepEqual(fake.calls, []);
  // The main ticket archived, or active in another workspace: still left out.
  assert.deepEqual(await chainRows([...archived, file('app', 'APP-12', '', { archived: true }), file('web', 'APP-12', '')], fake.states), []);
  // The main ticket active in the workspace: kept.
  assert.deepEqual(summary(await chainRows([...archived, file('app', 'APP-12', '')], fake.states)), ['app/APP-12 2: 1:T-1:merged 2:T-2:merged']);
  // One active part: kept.
  assert.deepEqual(summary(await chainRows([archived[0]!, file('app', 'T-2', part(2, 2))], rule({ 'T-1': 'merged' }).states)), ['app/APP-12 2: 1:T-1:merged 2:T-2:planned']);
});
