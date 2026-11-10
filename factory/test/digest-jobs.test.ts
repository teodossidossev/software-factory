// My daily's factory material (src/digest-jobs.ts): the jobs of the my_work workspaces handed over,
// pushed or merged within the daily's two days, current and archived, as daily material; which open
// branches of mine are live (a commit of mine in the two days, or a current job not done with it);
// the dailies built from both; and the prompt's daily lines.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { dailiesOf, dailyDays, type DigestWorkspace } from '../src/digest-run.js';
import { jobsOf, liveBranch } from '../src/digest-jobs.js';
import type { LiveBranch, MyCommit } from '../src/digest.js';
import { type Job, type JobState, JobStore } from '../src/jobs.js';
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
    workspace, ticket, branch: ticket, base: 'main', continues: null, base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
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
