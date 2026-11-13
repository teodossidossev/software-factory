// The tickets' history (src/ticket-history.ts, SF-081): the recorded writes of the Task file
// (append and read), the timeline with the Task checks and the jobs read from the state directory,
// "Changed outside the factory" on a sha256 the last recorded write did not leave (and not after a
// recorded Fix), the note on tickets older than the recording, and a ticket without a history file.
// The call sites (New ticket, write_task, Save, the Fix sections) are in setup.test.ts,
// smoke.test.ts and execution.test.ts.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { type Job, JobStore } from '../src/jobs.js';
import { CheckStore, type CheckRecord } from '../src/task-check.js';
import { OLDER_NOTE, TicketHistory } from '../src/ticket-history.js';
import { temp } from './support/harness.js';

const sha = (char: string): string => char.repeat(64);

// A clock that gives the times in order, one per call.
function clock(...times: string[]): () => Date {
  let at = 0;
  return () => new Date(times[Math.min(at++, times.length - 1)]!);
}

function checkRecord(ticket: string, sha256: string, ended: string, extra: Partial<CheckRecord> = {}): CheckRecord {
  return {
    workspace: 'app', ticket, sha256, commit: null, status: 'checked', error: null, model: 'm', cost_usd: 0.48, started_at: ended, ended_at: ended,
    output: { paraphrase: 'p', verdict: 'not_ready', files: [], findings: [
      { kind: 'decision', severity: 'blocker', where: 'w', problem: 'p', expected: 'e' },
      { kind: 'missing', severity: 'blocker', where: 'w', problem: 'p', expected: 'e' },
      { kind: 'unclear', severity: 'major', where: 'w', problem: 'p', expected: 'e' },
      { kind: 'unclear', severity: 'nit', where: 'w', problem: 'p', expected: 'e' },
    ] },
    ...extra,
  };
}

function jobOf(ticket: string, state: Job['state'], created: string): Job {
  return {
    workspace: 'app', ticket, branch: `${ticket}-x`, base: 'main', continues: null, base_commit: null, target_commit: null, worktree: null, prepared_commit: null, mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state,
    iteration: 0, session_id: null, mr: null, created_at: created, updated_at: created,
  };
}

const texts = (entries: Array<{ text: string }>): string[] => entries.map((entry) => entry.text);

test('ticket history: append writes one JSON line per write under tickets/<ws>/<ticket>; read gives them back in order and skips broken lines', async () => {
  const state = join(temp, 'history-append');
  const history = new TicketHistory(state, clock('2026-11-05T10:00:00.000Z', '2026-11-05T11:00:00.000Z', '2026-11-05T12:00:00.000Z'));
  assert.deepEqual(await history.read('app', 'T-1'), []);
  await history.append('app', 'T-1', { kind: 'created', by: 'you', sha256: sha('a') });
  await history.append('app', 'T-1', { kind: 'written', by: 'context_owner', sha256: sha('b') });
  await history.append('app', 'T-1', { kind: 'fix_added', by: 'factory', sha256: sha('c'), fix: 1 });
  const path = join(state, 'tickets', 'app', 'T-1', 'history.jsonl');
  assert.equal(history.path('app', 'T-1'), path);
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines, [
    { ts: '2026-11-05T10:00:00.000Z', kind: 'created', by: 'you', sha256: sha('a') },
    { ts: '2026-11-05T11:00:00.000Z', kind: 'written', by: 'context_owner', sha256: sha('b') },
    { ts: '2026-11-05T12:00:00.000Z', kind: 'fix_added', by: 'factory', sha256: sha('c'), fix: 1 },
  ]);
  await writeFile(path, `${await readFile(path, 'utf8')}not json\n{"ts":"x","kind":"created","by":"you","sha256":"${sha('d')}"}\n{"ts":"2026-11-05T13:00:00.000Z","kind":"deleted","by":"you","sha256":"${sha('d')}"}\n{"ts":"2026-11-05T13:00:00.000Z","kind":"edited","by":"you"`);
  assert.deepEqual(await history.read('app', 'T-1'), lines);
  // Both names are checked before any path is built.
  assert.throws(() => history.path('../x', 'T-1'), (error: unknown) => error instanceof FactoryError && error.code === 'invalid_name');
  assert.throws(() => history.path('app', '../T-1'), (error: unknown) => error instanceof FactoryError && error.code === 'invalid_ticket');
});

test('ticket history: the timeline merges the recorded writes, every check and every job of the ticket, newest first, with their labels', async () => {
  const state = join(temp, 'history-timeline');
  const history = new TicketHistory(state, clock('2026-11-01T09:00:00.000Z', '2026-11-01T10:00:00.000Z', '2026-11-02T09:00:00.000Z', '2026-11-03T12:00:00.000Z'));
  await history.append('app', 'T-1', { kind: 'created', by: 'you', sha256: sha('a') });
  await history.append('app', 'T-1', { kind: 'written', by: 'context_owner', sha256: sha('b') });
  await history.append('app', 'T-1', { kind: 'edited', by: 'you', sha256: sha('c') });
  await history.append('app', 'T-1', { kind: 'fix_added', by: 'factory', sha256: sha('d'), fix: 2 });
  const checks = new CheckStore(state);
  await checks.write(checkRecord('T-1', sha('b'), '2026-11-01T11:00:00.000Z'));
  await checks.write(checkRecord('T-1', sha('c'), '2026-11-02T10:00:00.000Z', { output: { paraphrase: 'p', verdict: 'ready', files: [], findings: [] }, cost_usd: 0.5 }));
  await checks.write(checkRecord('T-1', sha('e'), '2026-11-02T10:30:00.000Z', { status: 'failed', output: null, error: 'boom', cost_usd: 0.12 }));
  // Another ticket's check is not this one's.
  await checks.write(checkRecord('T-2', sha('b'), '2026-11-01T12:00:00.000Z'));
  const jobs = new JobStore(state);
  await jobs.write(jobOf('T-1', 'aborted', '2026-11-02T11:00:00.000Z'));
  await jobs.archive('app', 'T-1');
  await jobs.write(jobOf('T-1', 'pushed', '2026-11-03T08:00:00.000Z'));
  // A ticket whose name looks like an archived job of T-1 (names may contain a dot): its own job.
  await jobs.write(jobOf('T-1.20261102T120000Z', 'failed', '2026-11-02T12:00:00.000Z'));

  const timeline = await history.timeline('app', 'T-1', { sha256: sha('d'), mtime: '2026-11-03T12:00:00.000Z' });
  assert.deepEqual(timeline.map((entry) => [entry.ts, entry.kind, entry.by, entry.text]), [
    ['2026-11-03T12:00:00.000Z', 'fix_added', 'factory', 'Fix 2 added by the factory'],
    ['2026-11-03T08:00:00.000Z', 'started', 'you', 'Started as a job (ended: pushed)'],
    ['2026-11-02T11:00:00.000Z', 'started', 'you', 'Started as a job (ended: aborted)'],
    ['2026-11-02T10:30:00.000Z', 'checked', 'factory', 'Check failed · $0.12'],
    ['2026-11-02T10:00:00.000Z', 'checked', 'factory', 'Checked: ready · $0.50'],
    ['2026-11-02T09:00:00.000Z', 'edited', 'you', 'Edited by you'],
    ['2026-11-01T11:00:00.000Z', 'checked', 'factory', 'Checked: not ready (2 blockers, 1 major) · $0.48'],
    ['2026-11-01T10:00:00.000Z', 'written', 'context_owner', 'Plan written by the Context owner'],
    ['2026-11-01T09:00:00.000Z', 'created', 'you', 'Created by you'],
  ]);
});

test('ticket history: "Changed outside the factory" when the file is not the version the last recorded write left, with its mtime; not after a recorded Fix', async () => {
  const state = join(temp, 'history-outside');
  const history = new TicketHistory(state, clock('2026-11-01T09:00:00.000Z', '2026-11-01T10:00:00.000Z', '2026-11-05T08:00:00.000Z'));
  await history.append('app', 'T-1', { kind: 'created', by: 'you', sha256: sha('0') });
  await history.append('app', 'T-1', { kind: 'written', by: 'context_owner', sha256: sha('a') });
  assert.deepEqual(texts(await history.timeline('app', 'T-1', { sha256: sha('a'), mtime: '2026-11-01T10:00:00.000Z' })), ['Plan written by the Context owner', 'Created by you']);
  const outside = await history.timeline('app', 'T-1', { sha256: sha('b'), mtime: '2026-11-04T08:30:00.000Z' });
  assert.deepEqual(outside.map((entry) => [entry.ts, entry.kind, entry.text]), [
    ['2026-11-04T08:30:00.000Z', 'changed_outside', 'Changed outside the factory'],
    ['2026-11-01T10:00:00.000Z', 'written', 'Plan written by the Context owner'],
    ['2026-11-01T09:00:00.000Z', 'created', 'Created by you'],
  ]);
  // The factory's Fix section records the sha256 it left: the file is that version, nothing outside.
  await history.append('app', 'T-1', { kind: 'fix_added', by: 'factory', sha256: sha('c'), fix: 1 });
  assert.deepEqual(texts(await history.timeline('app', 'T-1', { sha256: sha('c'), mtime: '2026-11-05T08:30:00.000Z' })), ['Fix 1 added by the factory', 'Plan written by the Context owner', 'Created by you']);
});

test('ticket history: a ticket older than the recording says so once, last: nothing recorded, a first write that is not its creation (written, edited, a Fix), or checks and jobs before it', async () => {
  const state = join(temp, 'history-older');
  // No history file: the checks and the jobs, and the note; no "outside" without a recorded write.
  await new CheckStore(state).write(checkRecord('T-1', sha('a'), '2026-10-30T10:00:00.000Z', { output: { paraphrase: 'p', verdict: 'ready', files: [], findings: [] }, cost_usd: null }));
  await new JobStore(state).write(jobOf('T-1', 'failed', '2026-10-31T10:00:00.000Z'));
  const history = new TicketHistory(state, clock('2026-11-05T09:00:00.000Z'));
  const before = await history.timeline('app', 'T-1', { sha256: sha('b'), mtime: '2026-11-01T00:00:00.000Z' });
  assert.deepEqual(before.map((entry) => [entry.ts, entry.kind, entry.text]), [
    ['2026-10-31T10:00:00.000Z', 'started', 'Started as a job (ended: failed)'],
    ['2026-10-30T10:00:00.000Z', 'checked', 'Checked: ready'],
    [null, 'note', OLDER_NOTE],
  ]);
  assert.equal(OLDER_NOTE, 'Older steps were not recorded; they are known only from checks and jobs.');
  // Recorded since: an edit after the older steps; the note stays, once.
  await history.append('app', 'T-1', { kind: 'edited', by: 'you', sha256: sha('b') });
  assert.deepEqual(texts(await history.timeline('app', 'T-1', { sha256: sha('b'), mtime: '2026-11-05T09:00:00.000Z' })), ['Edited by you', 'Started as a job (ended: failed)', 'Checked: ready', OLDER_NOTE]);
  // A ticket created since the recording has no note; one with nothing recorded or read has the note alone.
  const fresh = new TicketHistory(state, clock('2026-11-05T09:00:00.000Z'));
  await fresh.append('app', 'T-2', { kind: 'created', by: 'you', sha256: sha('c') });
  assert.deepEqual(texts(await fresh.timeline('app', 'T-2', { sha256: sha('c'), mtime: '2026-11-05T09:00:00.000Z' })), ['Created by you']);
  assert.deepEqual(texts(await fresh.timeline('app', 'T-3')), [OLDER_NOTE]);
  await mkdir(join(state, 'tickets', 'app', 'T-4'), { recursive: true });
  assert.deepEqual(await fresh.read('app', 'T-4'), []);
  // Fix 1, R2: a ticket made before the recording, without a check or a job, whose first recorded
  // write is the Context owner's (or the user's Save): no creation recorded, so the note, once.
  for (const [kind, by, text] of [['written', 'context_owner', 'Plan written by the Context owner'], ['edited', 'you', 'Edited by you'], ['fix_added', 'factory', 'Fix 3 added by the factory']] as const) {
    const ticket = `T-old-${kind}`;
    const later = new TicketHistory(state, clock('2026-11-05T09:00:00.000Z', '2026-11-05T10:00:00.000Z'));
    await later.append('app', ticket, { kind, by, sha256: sha('d'), ...(kind === 'fix_added' ? { fix: 3 } : {}) });
    await later.append('app', ticket, { kind: 'written', by: 'context_owner', sha256: sha('e') });
    assert.deepEqual(texts(await later.timeline('app', ticket, { sha256: sha('e'), mtime: '2026-11-05T09:00:00.000Z' })), ['Plan written by the Context owner', text, OLDER_NOTE], kind);
  }
  // SF-203: the Fix of the user's Must fix is recorded as the user's.
  const decided = new TicketHistory(state, clock('2026-11-05T09:00:00.000Z'));
  await decided.append('app', 'T-must', { kind: 'fix_added', by: 'you', sha256: sha('f'), fix: 4 });
  assert.deepEqual(texts(await decided.timeline('app', 'T-must', { sha256: sha('f'), mtime: '2026-11-05T09:00:00.000Z' })), ['Fix 4 added by the factory for your Must fix', OLDER_NOTE]);
});
