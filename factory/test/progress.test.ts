// A running job's progress (src/progress.ts): the steps file's parser and reader, the phase, the
// history's durations (per iteration meta.json, review.json, gate.json; the MR text's span in
// events.jsonl), the fallback to every workspace, the hourly cache, and the remaining range.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Job, type JobState, JobStore } from '../src/jobs.js';
import { commitAndRebase } from '../src/mr.js';
import { buildPatch } from '../src/patch.js';
import { FACTORY_PROMPT_RULES } from '../src/prompts.js';
import { type Durations, History, HISTORY_TTL_MS, parseSteps, phaseOf, progressOf, readSteps, spread, stepsPath } from '../src/progress.js';
import { temp } from './support/harness.js';

const MIN = 60_000;
const at = (minutes: number): string => new Date(Date.UTC(2026, 10, 1, 10, 0) + minutes * MIN).toISOString();

function job(workspace: string, ticket: string, state: JobState, extra: Partial<Job> = {}): Job {
  return {
    workspace, ticket, branch: `${ticket}-b`, base: 'main', continues: null, base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state, iteration: 1, session_id: null, mr: null,
    created_at: at(0), updated_at: at(0), ...extra,
  };
}

// A finished job with one iteration: a working turn of work minutes, a Claude review and a gate of
// review and gate minutes (none when null), and preparing_mr for mr minutes.
async function finished(jobs: JobStore, workspace: string, ticket: string, minutes: { work: number; review: number | null; gate: number | null; mr: number }): Promise<void> {
  await jobs.write(job(workspace, ticket, 'pushed'));
  await jobs.writeIteration(workspace, ticket, {
    report: '# Report', patch: Buffer.alloc(0),
    meta: { iteration: 1, started_at: at(0), ended_at: at(minutes.work), denials: [], changed_files: [], patch_truncated: false, submodule_changed: [], cost_usd: null, cost_usd_total: null, duration_ms: null },
  });
  if (minutes.review !== null) {
    await jobs.writeReview(workspace, ticket, 1, { reviewer: 'claude', verdict: 'clean', summary: '', items: [], accepted_sensitive: [], cost_usd: null, started_at: at(minutes.work), ended_at: at(minutes.work + minutes.review) });
  }
  if (minutes.gate !== null) {
    await jobs.writeGate(workspace, ticket, 1, { reviewer: 'codex', verdict: 'clean', summary: '', items: [], accepted_sensitive: [], tokens: { input: 0, cached_input: 0, output: 0 }, started_at: at(minutes.work), ended_at: at(minutes.work + minutes.gate) });
  }
  const start = minutes.work + 5;
  await jobs.appendEvent(workspace, ticket, { ts: at(0), iteration: 0, state: { from: null, to: 'starting' } });
  await jobs.appendEvent(workspace, ticket, { ts: at(start), iteration: 1, state: { from: 'awaiting_review', to: 'preparing_mr' } });
  await jobs.appendEvent(workspace, ticket, { ts: at(start + 1), iteration: 1, type: 'tests_started', run: at(start + 1), command: 'npm test' });
  await jobs.appendEvent(workspace, ticket, { ts: at(start + minutes.mr), iteration: 1, state: { from: 'preparing_mr', to: 'ready_for_human_review' } });
}

const DURATIONS: Durations = { working: { p25: 10 * MIN, median: 20 * MIN, p75: 30 * MIN }, claude: 2 * MIN, codex: 4 * MIN, mr_text: 1 * MIN };
const NOW = Date.UTC(2026, 10, 11, 14, 0);
const minutesFrom = (iso: string): number => (Date.parse(iso) - NOW) / MIN;
const range = (progress: ReturnType<typeof progressOf>): [number, number] => [minutesFrom(progress!.ready_from), minutesFrom(progress!.ready_to)];
const none = { claude: false, codex: false };

test('parseSteps: ticked and unticked checklist lines in order, other lines ignored, more than 12 kept', () => {
  const text = ['# Steps', '', '- [x] Read the Task', '- [ ] Write the parser', '  * [X] indented, with a star', 'Some prose - [ ] not a step', '- [] no space', '- [ ]   ', '+ [ ] plus'].join('\n');
  assert.deepEqual(parseSteps(text), [
    { text: 'Read the Task', done: true }, { text: 'Write the parser', done: false }, { text: 'indented, with a star', done: true }, { text: 'plus', done: false },
  ]);
  const many = Array.from({ length: 15 }, (_, index) => `- [${index < 4 ? 'x' : ' '}] step ${index + 1}`).join('\r\n');
  const steps = parseSteps(many);
  assert.equal(steps.length, 15);
  assert.deepEqual(steps.at(-1), { text: 'step 15', done: false });
  assert.equal(steps.filter((step) => step.done).length, 4);
  assert.deepEqual(parseSteps('no checklist at all'), []);
  assert.equal(parseSteps(`- [ ] ${'a'.repeat(500)}`)[0]!.text.length, 200);
});

test('readSteps reads .software-factory/<ticket>.steps.md of the worktree: none without a worktree, a file, or for a link', async () => {
  const worktree = join(temp, 'progress-steps');
  await mkdir(join(worktree, '.software-factory'), { recursive: true });
  assert.equal(stepsPath('SF-1'), '.software-factory/SF-1.steps.md');
  assert.deepEqual(await readSteps(null, 'SF-1'), []);
  assert.deepEqual(await readSteps(worktree, 'SF-1'), []);
  await writeFile(join(worktree, stepsPath('SF-1')), '- [x] one\n- [ ] two\n');
  assert.deepEqual(await readSteps(worktree, 'SF-1'), [{ text: 'one', done: true }, { text: 'two', done: false }]);
  await writeFile(join(worktree, 'elsewhere.md'), '- [ ] secret\n');
  await symlink(join(worktree, 'elsewhere.md'), join(worktree, stepsPath('SF-2')));
  assert.deepEqual(await readSteps(worktree, 'SF-2'), []);
});

test('the steps rule is in the factory\'s prompt rules, and the steps file never reaches the Patch or the commit', async () => {
  assert.match(FACTORY_PROMPT_RULES, /^- At the start of every turn, write the turn's steps as a checklist in \.software-factory\/<ticket>\.steps\.md: 3 to 12 lines `- \[ \] step` \(in a Fix turn, the fixes\)\. Tick a step `- \[x\]` as soon as it is done, and keep the file current\.$/m);
  const repo = join(temp, 'progress-commit');
  await mkdir(repo, { recursive: true });
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  await writeFile(join(repo, 'f.txt'), 'f\n');
  git('add', 'f.txt');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  // The worktree has the steps file, not even excluded through info/exclude, and one change.
  await mkdir(join(repo, '.software-factory'));
  await writeFile(join(repo, stepsPath('T-1')), '- [x] Change f.txt\n- [ ] Report\n');
  await writeFile(join(repo, 'f.txt'), 'f changed\n');
  const built = await buildPatch(repo, base);
  assert.deepEqual(built.files.map((file) => file.path), ['f.txt']);
  assert.doesNotMatch(built.patch.toString('utf8'), /steps\.md|Change f\.txt/);
  git('config', 'commit.gpgsign', 'false');
  for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.invalid']] as const) {
    git('config', key, value);
  }
  assert.deepEqual(await commitAndRebase(repo, { baseCommit: base, targetCommit: base, mrText: 'feat(T-1): Change f\n\n## What\nx\n' }), { kind: 'ready' });
  assert.equal(git('show', '--name-only', '--format=', 'HEAD'), 'f.txt');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '?? .software-factory/T-1.steps.md');
});

test('phaseOf: starting and working code; awaiting_review Claude until its verdict (or without it) the gate; preparing_mr the MR text; else none', () => {
  assert.equal(phaseOf({ state: 'starting' }, false), 'code');
  assert.equal(phaseOf({ state: 'working' }, false), 'code');
  assert.equal(phaseOf({ state: 'awaiting_review' }, false), 'claude');
  assert.equal(phaseOf({ state: 'awaiting_review' }, true), 'codex');
  assert.equal(phaseOf({ state: 'awaiting_review', claude_review: false }, false), 'codex');
  assert.equal(phaseOf({ state: 'preparing_mr' }, false), 'mr_text');
  for (const state of ['waiting_limit', 'paused', 'needs_human', 'ready_for_human_review', 'pushed'] as const) {
    assert.equal(phaseOf({ state }, false), null);
  }
});

test('progressOf: the remaining range for no steps, half the steps, a review, the MR text; a fix round only on the top while none happened', () => {
  const working = job('app', 'W', 'working');
  // No steps: a whole working turn, both reviews, the MR text; the top adds a fix round (20 + 2 + 4).
  const bare = progressOf(working, { steps: [], done: none, durations: DURATIONS, now: NOW });
  assert.deepEqual({ ...bare, ready_from: undefined, ready_to: undefined }, { steps: [], phase: 'code', fix_round: 0, ready_from: undefined, ready_to: undefined });
  assert.deepEqual(range(bare), [10 + 2 + 4 + 1, 30 + 2 + 4 + 1 + 26]);
  // Half the steps done: half a working turn.
  const half = [{ text: 'a', done: true }, { text: 'b', done: true }, { text: 'c', done: false }, { text: 'd', done: false }];
  assert.deepEqual(range(progressOf(working, { steps: half, done: none, durations: DURATIONS, now: NOW })), [5 + 7, 15 + 7 + 26]);
  // In a fix round: no fix round on the top.
  const fixing = progressOf({ ...working, fixes: 2 }, { steps: half, done: none, durations: DURATIONS, now: NOW });
  assert.equal(fixing!.fix_round, 2);
  assert.deepEqual(range(fixing), [5 + 7, 15 + 7]);
  // Without the Claude review on the job: its median counts nowhere.
  assert.deepEqual(range(progressOf({ ...working, claude_review: false }, { steps: [], done: none, durations: DURATIONS, now: NOW })), [10 + 4 + 1, 30 + 4 + 1 + 24]);
  // The Claude review runs: both reviews and the MR text ahead, no working turn.
  const review = job('app', 'R', 'awaiting_review');
  const claude = progressOf(review, { steps: half, done: none, durations: DURATIONS, now: NOW });
  assert.equal(claude!.phase, 'claude');
  assert.deepEqual(range(claude), [7, 7 + 26]);
  // The gate runs after Claude's verdict; its own verdict in, only the MR text is ahead.
  const gate = progressOf({ ...review, fixes: 1 }, { steps: [], done: { claude: true, codex: false }, durations: DURATIONS, now: NOW });
  assert.equal(gate!.phase, 'codex');
  assert.deepEqual(range(gate), [5, 5]);
  assert.deepEqual(range(progressOf({ ...review, fixes: 1 }, { steps: [], done: { claude: true, codex: true }, durations: DURATIONS, now: NOW })), [1, 1]);
  // The MR text: its median, and the fix round while none happened.
  const mr = progressOf(job('app', 'M', 'preparing_mr'), { steps: half, done: none, durations: DURATIONS, now: NOW });
  assert.equal(mr!.phase, 'mr_text');
  assert.deepEqual(range(mr), [1, 1 + 26]);
  // A job that does not run has none.
  assert.equal(progressOf(job('app', 'P', 'paused'), { steps: half, done: none, durations: DURATIONS, now: NOW }), null);
  assert.equal(progressOf(job('app', 'L', 'waiting_limit'), { steps: half, done: none, durations: DURATIONS, now: NOW }), null);
  // Without a working turn in the history: the base durations (the factory's history the Task quotes:
  // working 10/19/32 min, reviews 2 min, MR text 1 min), still a range of ISO times.
  const empty = progressOf(working, { steps: half, done: none, durations: { working: null, claude: null, codex: null, mr_text: null }, now: NOW });
  assert.deepEqual(range(empty), [5 + 2 + 2 + 1, 16 + 5 + (19 + 2 + 2)]);
  assert.deepEqual(range(progressOf(working, { steps: half, done: none, durations: { working: null, claude: 2 * MIN, codex: 4 * MIN, mr_text: MIN }, now: NOW })), range(empty));
  assert.equal(typeof empty!.ready_from, 'string');
});

test('spread: p25, median and p75 interpolated between the sorted values', () => {
  assert.equal(spread([]), null);
  assert.deepEqual(spread([7]), { p25: 7, median: 7, p75: 7 });
  assert.deepEqual(spread([40, 10, 30, 20, 50]), { p25: 20, median: 30, p75: 40 });
  assert.deepEqual(spread([1, 2, 3, 4]), { p25: 1.75, median: 2.5, p75: 3.25 });
});

test('History: the durations of the workspace\'s finished jobs, every workspace\'s when it has fewer than 10, read again only after an hour', async () => {
  const jobs = new JobStore(join(temp, 'progress-history'));
  // Ten finished jobs in big: working 10..28 min, reviews 2 min, gates 4 min, MR text 3 min.
  for (let index = 0; index < 10; index += 1) {
    await finished(jobs, 'big', `B-${index}`, { work: 10 + 2 * index, review: 2, gate: 4, mr: 3 });
  }
  // Running and stopped jobs are not history.
  await jobs.write(job('big', 'RUN', 'working', { iteration: 1 }));
  await jobs.writeIteration('big', 'RUN', { report: '', patch: Buffer.alloc(0), meta: { iteration: 1, started_at: at(0), ended_at: at(500), denials: [], changed_files: [], patch_truncated: false, submodule_changed: [], cost_usd: null, cost_usd_total: null, duration_ms: null } });
  // One finished job in small, without a Claude review; an aborted one without meta.json and with an unreadable gate.json.
  await finished(jobs, 'small', 'S-1', { work: 60, review: null, gate: 8, mr: 13 });
  await jobs.write(job('small', 'S-2', 'aborted', { iteration: 1 }));
  await mkdir(jobs.iterationDir('small', 'S-2', 1), { recursive: true });
  await writeFile(join(jobs.iterationDir('small', 'S-2', 1), 'gate.json'), 'not json');
  let clock = NOW;
  const history = new History(jobs, () => clock);
  assert.deepEqual(await history.of('big'), { working: { p25: 14.5 * MIN, median: 19 * MIN, p75: 23.5 * MIN }, claude: 2 * MIN, codex: 4 * MIN, mr_text: 3 * MIN });
  // small (2 finished) and an unknown workspace read every workspace's jobs.
  const all = { working: { p25: 15 * MIN, median: 20 * MIN, p75: 25 * MIN }, claude: 2 * MIN, codex: 4 * MIN, mr_text: 3 * MIN };
  assert.deepEqual(await history.of('small'), all);
  assert.deepEqual(await history.of('new'), all);
  // A new finished job counts only once the hour passed.
  await finished(jobs, 'small', 'S-3', { work: 600, review: 100, gate: 100, mr: 100 });
  clock += HISTORY_TTL_MS - 1;
  assert.deepEqual(await history.of('small'), all);
  clock += 1;
  const later = await history.of('small');
  assert.equal(later.working!.median, 21 * MIN);
  assert.equal(later.mr_text, 3 * MIN);
});
