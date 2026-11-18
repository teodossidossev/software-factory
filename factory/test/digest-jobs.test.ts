// My daily's factory material (src/digest-jobs.ts): the jobs of the my_work workspaces handed over,
// pushed or merged within the daily's two days, current and archived, as daily material; which open
// branches of mine are live (a commit of mine in the two days, or a current job not done with it);
// the dailies built from both; the prompt's daily lines and its two languages; and the jobs in
// progress now (inProgressOf); and the count of jobs landed today (landedToday).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { dailiesOf, dailyDays, type DigestWorkspace } from '../src/digest-run.js';
import { inProgressOf, jobsOf, landedToday, liveBranch } from '../src/digest-jobs.js';
import type { LiveBranch, MyCommit } from '../src/digest.js';
import { type EventRecord, type Job, type JobState, JobStore } from '../src/jobs.js';
import { digestPrompt } from '../src/prompts.js';

let temp: string;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sf-digest-jobs-'));
});
after(async () => {
  await rm(temp, { recursive: true, force: true });
});

// The days around the real clock: events.jsonl written now counts as touched within them.
const now = new Date();
const days = dailyDays(now);
const middle = (span: { from: string; to: string }): string => new Date((Date.parse(span.from) + Date.parse(span.to)) / 2).toISOString();
const yesterday = middle(days.yesterday);
const today = middle(days.today);
const threeDaysAgo = new Date(Date.parse(days.yesterday.from) - 2 * 86_400_000).toISOString();

function job(workspace: string, ticket: string, state: JobState, at: string, extra: Partial<Job> = {}): Job {
  return {
    workspace, ticket, branch: ticket, base: 'main', continues: null, builds_on: null, builds_on_commit: null,base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, state, iteration: 1, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null,
    created_at: threeDaysAgo, updated_at: at, mr: null, ...extra,
  };
}

async function put(store: JobStore, value: Job, title?: string): Promise<void> {
  await store.write(value);
  await store.appendEvent(value.workspace, value.ticket, { ts: value.created_at, iteration: 0, state: { from: null, to: 'starting' } });
  await store.appendEvent(value.workspace, value.ticket, { ts: value.updated_at, iteration: value.iteration, state: { from: 'working', to: value.state } });
  if (title !== undefined) {
    await store.writeTaskCopy(value.workspace, value.ticket, Buffer.from(`---\nticket: ${value.ticket}\ntitle: ${title}\n---\n\n# ${value.ticket}\n`));
  }
}

const mr = (state: 'open' | 'merged' | 'closed') => ({ host: 'github' as const, number: 7, url: 'https://example.invalid/pull/7', state });

test('jobsOf: the handed-over, pushed and merged jobs of the workspaces within the two days, archived too; the current jobs', async () => {
  const store = new JobStore(join(temp, 'state-jobs'));
  await put(store, job('backend', 'SHOP-1', 'handed_over', yesterday), 'The checkout total');
  await put(store, job('backend', 'SHOP-2', 'handed_over', threeDaysAgo), 'An old one');
  // Pushed five days ago, its merge request merged this morning.
  const merged = job('backend', 'SHOP-3', 'pushed', new Date(Date.parse(threeDaysAgo) - 2 * 86_400_000).toISOString(), { mr: mr('merged') });
  await put(store, merged, 'The order history');
  await store.appendEvent('backend', 'SHOP-3', { ts: today, iteration: 1, type: 'merge_request', action: 'updated', host: 'github', number: 7, url: 'https://example.invalid/pull/7', mr_state: 'merged' });
  await put(store, job('backend', 'SHOP-4', 'pushed', yesterday, { mr: mr('open') }));
  await put(store, job('backend', 'SHOP-5', 'handed_over', yesterday), 'An archived one');
  await store.archive('backend', 'SHOP-5');
  await put(store, job('backend', 'SHOP-6', 'working', today));
  await put(store, job('backend', 'SHOP-7', 'aborted', today));
  await put(store, job('other', 'SHOP-8', 'handed_over', yesterday), 'Not my_work');

  const { done, current } = await jobsOf(store, ['backend'], days);
  assert.deepEqual(done.map((entry) => [entry.ticket, entry.title, entry.state, entry.at, entry.workspace, entry.branch]).sort(), [
    ['SHOP-1', 'The checkout total', 'handed_over', yesterday, 'backend', 'SHOP-1'],
    ['SHOP-3', 'The order history', 'merged', today, 'backend', 'SHOP-3'],
    ['SHOP-4', 'SHOP-4', 'pushed', yesterday, 'backend', 'SHOP-4'],
    ['SHOP-5', 'An archived one', 'handed_over', yesterday, 'backend', 'SHOP-5'],
  ]);
  assert.deepEqual(current.map((entry) => entry.ticket), ['SHOP-1', 'SHOP-2', 'SHOP-3', 'SHOP-4', 'SHOP-6', 'SHOP-7']);
});

test('jobsOf: a pushed job sf serve found on its target and archived (merged_on_target) is merged, at that event', async () => {
  const store = new JobStore(join(temp, 'state-merged-on-target'));
  // Pushed five days ago with no merge request (merged by hand), found merged this morning.
  await put(store, job('backend', 'SHOP-9', 'pushed', new Date(Date.parse(threeDaysAgo) - 2 * 86_400_000).toISOString()), 'Merged by hand');
  await store.appendEvent('backend', 'SHOP-9', { ts: today, iteration: 1, type: 'merged_on_target', commit: 'a'.repeat(40), target: 'main' });
  await store.archive('backend', 'SHOP-9');
  // Pushed five days ago, a closed merge request, never found merged: not in the two days.
  await put(store, job('backend', 'SHOP-10', 'pushed', new Date(Date.parse(threeDaysAgo) - 2 * 86_400_000).toISOString(), { mr: mr('closed') }));
  const { done } = await jobsOf(store, ['backend'], days);
  assert.deepEqual(done.map((entry) => [entry.ticket, entry.title, entry.state, entry.at]), [['SHOP-9', 'Merged by hand', 'merged', today]]);
});

test('landedToday: the jobs of every workspace merged since local midnight, archived too, counted once each', async () => {
  const store = new JobStore(join(temp, 'state-landed-today'));
  // Local times, so the test holds in any time zone; the events files are written now, after that
  // midnight, so none is skipped by its mtime.
  const local = (day: number, hour: number, minute: number): string => new Date(2026, 10, day, hour, minute).toISOString();
  const pushedAt = local(15, 12, 0);
  const merge = (at: string): EventRecord => ({ ts: at, iteration: 1, type: 'merge_request', action: 'updated', host: 'github', number: 7, url: 'https://example.invalid/pull/7', mr_state: 'merged' });
  const found = (at: string): EventRecord => ({ ts: at, iteration: 1, type: 'merged_on_target', commit: 'a'.repeat(40), target: 'main' });
  // A current job, its merge request merged at 00:01: counted.
  await put(store, job('backend', 'SHOP-1', 'pushed', pushedAt, { mr: mr('merged') }));
  await store.appendEvent('backend', 'SHOP-1', merge(local(17, 0, 1)));
  // An archived job of another workspace, found on its target at 00:10: counted.
  await put(store, job('frontend', 'WEB-1', 'pushed', pushedAt));
  await store.appendEvent('frontend', 'WEB-1', found(local(17, 0, 10)));
  await store.archive('frontend', 'WEB-1');
  // An archived job found on its target at 23:59 the day before: not counted.
  await put(store, job('backend', 'SHOP-2', 'pushed', pushedAt));
  await store.appendEvent('backend', 'SHOP-2', found(local(16, 23, 59)));
  await store.archive('backend', 'SHOP-2');
  // Merged at 00:40, after now: not counted.
  await put(store, job('backend', 'SHOP-3', 'pushed', pushedAt, { mr: mr('merged') }));
  await store.appendEvent('backend', 'SHOP-3', merge(local(17, 0, 40)));
  // Pushed with an open merge request, and handed over at 00:05: not counted.
  await put(store, job('backend', 'SHOP-4', 'pushed', local(17, 0, 2), { mr: mr('open') }));
  await put(store, job('backend', 'SHOP-5', 'handed_over', local(17, 0, 5)));

  assert.equal(await landedToday(store, new Date(2026, 10, 17, 0, 30)), 2);
  // An empty store lands none.
  assert.equal(await landedToday(new JobStore(join(temp, 'state-landed-none')), new Date(2026, 10, 17, 0, 30)), 0);
});

const branch = (name: string): LiveBranch => ({
  name, local: false, author: 'Me', mine: true, date: threeDaysAgo, age_days: 4, ahead: 2, behind: 171, local_only: 0,
  subject: `${name}: work`, ticket: name, landed: false, earlier_merge: false, files: ['a.ts'], overlap: ['a.ts'], hit_by: [],
});
const commit = (ref: string, date: string): MyCommit => ({ sha: `sha-${ref}-${date}`, ref, date, subject: 'work', why: '', stat: '' });

test('liveBranch: a commit of mine in the two days, or a current job of the branch not done with it', () => {
  const parked = branch('SHOP-9');
  assert.equal(liveBranch(parked, 'backend', [commit('SHOP-9', threeDaysAgo)], [], days), false);
  assert.equal(liveBranch(parked, 'backend', [commit('SHOP-9 (local)', today)], [], days), true);
  assert.equal(liveBranch(parked, 'backend', [commit('SHOP-9', yesterday)], [], days), true);
  assert.equal(liveBranch(parked, 'backend', [commit('SHOP-10', today)], [], days), false);
  assert.equal(liveBranch(parked, 'backend', [], [job('backend', 'SHOP-9', 'pushed', threeDaysAgo, { mr: mr('open') })], days), true);
  assert.equal(liveBranch(parked, 'backend', [], [job('backend', 'SHOP-9', 'pushed', threeDaysAgo)], days), true);
  assert.equal(liveBranch(parked, 'backend', [], [job('backend', 'SHOP-9', 'pushed', threeDaysAgo, { mr: mr('merged') })], days), false);
  assert.equal(liveBranch(parked, 'backend', [], [job('backend', 'SHOP-9', 'failed', today)], days), false);
  assert.equal(liveBranch(parked, 'backend', [], [job('backend', 'SHOP-9', 'aborted', today)], days), false);
  assert.equal(liveBranch(parked, 'backend', [], [job('backend', 'SHOP-9', 'handed_over', threeDaysAgo)], days), true);
  assert.equal(liveBranch(parked, 'backend', [], [job('frontend', 'SHOP-9', 'working', today)], days), false);
  assert.equal(liveBranch(parked, 'backend', [], [job('backend', 'SHOP-11', 'working', today, { branch: 'SHOP-11', continues: 'SHOP-9' })], days), true);
});

function workspace(name: string, branches: LiveBranch[], myCommits: MyCommit[]): DigestWorkspace {
  return {
    name, app: 'shop', description: null, description_source: null, track: false, my_work: true,
    fetch: { status: 'ok', message: null, last_fetch_ok_at: null, notes: [] },
    git: { main: 'main', me: 'me@example.invalid', landed: [], branches, my_commits: myCommits, notes: [] },
    error: null,
  };
}

test('dailiesOf: a job handed over yesterday makes a daily without commits; one of three days ago does not; parked branches stay out', async () => {
  const store = new JobStore(join(temp, 'state-dailies'));
  await put(store, job('backend', 'SHOP-1', 'handed_over', yesterday), 'The checkout total');
  await put(store, job('backend', 'SHOP-2', 'handed_over', threeDaysAgo), 'An old one');
  const jobs = await jobsOf(store, ['backend'], days);

  const [daily] = dailiesOf([workspace('backend', [branch('SHOP-9')], [])], days, jobs);
  assert.deepEqual(daily!.jobs.map((entry) => entry.ticket), ['SHOP-1']);
  assert.deepEqual(daily!.commits, []);
  assert.deepEqual(daily!.open_branches, []);

  // The same branch with a pushed job waiting for review, or with a commit of mine today, is live.
  const pushed = { done: [], current: [job('backend', 'SHOP-9', 'pushed', threeDaysAgo, { mr: mr('open') })] };
  assert.deepEqual(dailiesOf([workspace('backend', [branch('SHOP-9')], [])], days, pushed)[0]!.open_branches.map((entry) => entry.name), ['SHOP-9']);
  const committed = dailiesOf([workspace('backend', [branch('SHOP-9')], [commit('SHOP-9', today)])], days, { done: [], current: [] });
  assert.deepEqual(committed[0]!.open_branches.map((entry) => [entry.name, entry.workspace]), [['SHOP-9', 'backend']]);

  // Nothing of mine: no daily.
  assert.deepEqual(dailiesOf([workspace('backend', [branch('SHOP-9')], [])], days, { done: [], current: [] }), []);

  // A workspace whose Git data could not be read still gives the factory's jobs.
  const unread = { ...workspace('backend', [], []), git: null, error: 'the checkout is gone' };
  assert.deepEqual(dailiesOf([unread], days, jobs).map((entry) => [entry.workspaces, entry.jobs.map((job) => job.ticket)]), [[['backend'], ['SHOP-1']]]);
  assert.deepEqual(dailiesOf([unread], days, { done: [], current: [] }), []);
});

test('digestPrompt: yesterday counts the factory\'s jobs, today starts with what is done, problems and plan from the live branches', () => {
  const prompt = digestPrompt('2026-11-10', 'English', null);
  assert.match(prompt, /from the Git data and the factory's jobs below only/);
  assert.match(prompt, /an app where I have commits, the factory's jobs or live branches/);
  assert.match(prompt, /the jobs in daily\[\]\.jobs whose `at` is in it \(the factory's work for me counts as mine\), each ticket once/);
  assert.match(prompt, /first what is already done today \(commits or jobs dated in daily_days\.today\), each "<key> \(<topic>\): done: <what changed>", grouped by theme when more than 5; then what I do today/);
  assert.match(prompt, /only from daily\[\]\.open_branches \(the live ones\)/);
});

test('digestPrompt: every text is {text, en}, en in plain English (repeating text in English); the rule on English words holds for text only', () => {
  const prompt = digestPrompt('2026-11-10', 'Bulgarian', null);
  assert.match(prompt, /Every text of the output is an object \{"text", "en"\}: text in Bulgarian under these rules; en the same content in plain English, with ticket keys, people's names and product names unchanged and the same rules on SHAs, branch names and Git words\. When Bulgarian is English, en repeats text\. The rule on English words applies to text only\./);
  assert.match(prompt, /Unless Bulgarian is English, no English word in any script in a text/);
});

test('inProgressOf: the live current jobs only, waiting for me first, then running, then paused or parked, each group oldest first; title and stop code', async () => {
  const store = new JobStore(join(temp, 'state-progress'));
  const at = (hour: number): string => new Date(Date.UTC(2026, 10, 10, hour)).toISOString();
  const rows: Array<[string, JobState, string, Partial<Job>?]> = [
    ['SHOP-31', 'working', at(9)],
    ['SHOP-32', 'needs_human', at(10), { error: { code: 'gate_failed', message: 'The gate failed.' } }],
    ['SHOP-33', 'paused', at(7)],
    ['SHOP-34', 'ready_for_human_review', at(8)],
    ['SHOP-35', 'awaiting_review', at(6)],
    ['SHOP-36', 'pushed', at(5)],
    ['SHOP-37', 'aborted', at(5)],
    ['SHOP-38', 'failed', at(5)],
    ['SHOP-39', 'waiting_limit', at(6)],
    ['SHOP-40', 'handed_over', at(11)],
  ];
  for (const [ticket, state, updated, extra] of rows) {
    await put(store, job(ticket === 'SHOP-31' ? 'web' : 'backend', ticket, state, updated, extra), ticket === 'SHOP-31' ? 'The order export' : undefined);
  }
  const { current } = await jobsOf(store, ['backend', 'web'], days);
  const progress = await inProgressOf(store, current, [{ name: 'backend', app: 'shop' }]);
  assert.deepEqual(progress.map((row) => [row.ticket, row.state]), [
    ['SHOP-34', 'ready_for_human_review'], ['SHOP-32', 'needs_human'], ['SHOP-40', 'handed_over'],
    ['SHOP-35', 'awaiting_review'], ['SHOP-31', 'working'],
    ['SHOP-39', 'waiting_limit'], ['SHOP-33', 'paused'],
  ]);
  assert.deepEqual(progress.find((row) => row.ticket === 'SHOP-31'), { workspace: 'web', app: 'web', ticket: 'SHOP-31', title: 'The order export', state: 'working', stop_code: null, iteration: 1, since: at(9) });
  assert.deepEqual(progress.find((row) => row.ticket === 'SHOP-32'), { workspace: 'backend', app: 'shop', ticket: 'SHOP-32', title: 'SHOP-32', state: 'needs_human', stop_code: 'gate_failed', iteration: 1, since: at(10) });
  assert.equal(progress.find((row) => row.ticket === 'SHOP-40')!.stop_code, null);
});
