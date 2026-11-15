// A part of a split ticket that builds on the part before it (`builds_on: <ticket>` in the Task
// file), end to end through `sf serve` and the CLI with a bare origin: the write-time refusals; the
// job starts from the other ticket's prepared commit in the checkout, and its Patch holds its own
// change alone; MR preparation replays its one commit onto that ticket's new prepared commit; it
// stops with builds_on_not_ready while that ticket is being changed, and Retry goes on once it is
// ready again; Approve is refused while that ticket is not merged; a start by hand is refused
// while it has no prepared commit; and once it is merged the job starts from origin/<base>.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { callSocket } from '../src/ipc.js';
import { type Job, type JobState, JobStore, now } from '../src/jobs.js';
import { writeTask } from '../src/task-file.js';
import { call, type Env, git, newEnv, newRepo, refused, reviewScript, runCli, script, serve, stop, temp, waitFor } from './support/harness.js';
import { mrText, remoteTip, rev } from './support/handoff.js';

const PART_ONE = 'T-1-part-one';
const PART_TWO = 'T-2-part-two';
const TIMEOUT = { timeout: 120_000 };

function partTask(ticket: string, title: string, extra: string): string {
  return `---\nticket: ${ticket}\ntitle: ${title}\nbase: main\n${extra}---\n\n# ${ticket}: ${title}\n\nChange the README.\n`;
}

// The job record of T-1 as its job left it: its branch in the checkout, never pushed.
function partOneJob(state: JobState, prepared: string | null, extra: Partial<Job> = {}): Job {
  const at = now();
  return {
    workspace: 'app', ticket: 'T-1', branch: PART_ONE, base: 'main', continues: null, builds_on: null, builds_on_commit: null,base_commit: null, state, worktree: null, prepared_commit: prepared,
    iteration: 1, fixes: 0, gate_fixes: 0, gate_tokens: 0, session_id: null, mr: null, target_commit: null, mr_attempts: 1, mr_conflict_turn: false, created_at: at, updated_at: at, ...extra,
  };
}

interface Parts {
  env: Env;
  repo: string;
  origin: string;
  jobs: JobStore;
  // T-1's prepared commit: one commit on main that adds part1.txt.
  first: string;
  // T-1 prepared again: its branch made anew from main, part1.txt with text; returns its commit.
  prepare: (text: string) => Promise<string>;
}

// A checkout with an origin, T-1's branch with its one prepared commit (local only) and T-1's job
// in ready_for_human_review; the Task file of T-2 builds on T-1.
async function parts(name: string, extra: Record<string, string> = {}): Promise<Parts> {
  const env = await newEnv(name, extra);
  const repo = await newRepo(env, `${name}-repo`, true);
  const prepare = async (text: string): Promise<string> => {
    git(repo, 'checkout', '-q', '-B', PART_ONE, 'main');
    await writeFile(join(repo, 'part1.txt'), text);
    git(repo, 'add', 'part1.txt');
    git(repo, 'commit', '-q', '-m', 'feat(T-1): Part one');
    const commit = rev(repo, 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    return commit;
  };
  const first = await prepare('part one\n');
  const jobs = new JobStore(env.state);
  await jobs.write(partOneJob('ready_for_human_review', first, { base_commit: rev(repo, 'main'), target_commit: rev(repo, 'main') }));
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, 'T-2', partTask('T-2', 'Part two', 'builds_on: T-1\n'), jobs);
  return { env, repo, origin: join(temp, `${name}-repo-origin.git`), jobs, first, prepare };
}

const setPartOne = async (p: Parts, state: JobState, prepared: string | null, extra: Partial<Job> = {}): Promise<void> => {
  await p.jobs.write({ ...(await p.jobs.read('app', 'T-1'))!, state, prepared_commit: prepared, ...extra });
};

// A command refused by sf serve through its socket: its code and message.
async function refusedSocket(env: Env, command: string, args: string[]): Promise<{ code: string; message: string }> {
  const response = await callSocket(env.state, { command, args });
  assert.equal(response.ok, false, JSON.stringify(response));
  return (response as { error: { code: string; message: string } }).error;
}

test('a job record written without builds_on and builds_on_commit reads both as null, and is written back with them', async () => {
  const env = await newEnv('builds-on-legacy');
  const jobs = new JobStore(env.state);
  const { builds_on: _buildsOn, builds_on_commit: _buildsOnCommit, ...legacy } = partOneJob('pushed', 'a'.repeat(40));
  await mkdir(jobs.dir('app', 'T-1'), { recursive: true });
  await writeFile(join(jobs.dir('app', 'T-1'), 'job.json'), JSON.stringify(legacy));
  const read = (await jobs.read('app', 'T-1'))!;
  assert.deepEqual([read.builds_on, read.builds_on_commit], [null, null]);
  await jobs.write(read);
  const written = JSON.parse(await readFile(join(jobs.dir('app', 'T-1'), 'job.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual([written.builds_on, written.builds_on_commit], [null, null]);
});

test('builds_on is refused at write time when it names the ticket itself, is not a ticket key, or comes with continues', async () => {
  const env = await newEnv('builds-on-write');
  const repo = await newRepo(env, 'builds-on-write-repo', false);
  const workspace = { name: 'app', readCheckout: repo, workCheckout: repo };
  const jobs = new JobStore(env.state);
  const cases: Array<[string, string]> = [
    ['builds_on: T-5\n', 'builds_on must name another ticket.'],
    ['builds_on: app/T-1\n', 'builds_on must be a ticket key: 1-64 characters of A-Z, a-z, 0-9, ".", "_" and "-", starting with a letter or digit.'],
    ['builds_on: T-1\ncontinues: feature-x\n', 'builds_on and continues cannot be used together.'],
  ];
  for (const [extra, message] of cases) {
    await assert.rejects(writeTask(workspace, 'T-5', partTask('T-5', 'Refused', extra), jobs), { code: 'invalid_content', message }, extra);
  }
  // Another ticket, with lands_after too: accepted.
  await writeTask(workspace, 'T-5', partTask('T-5', 'Accepted', 'builds_on: T-1\nlands_after: T-1\n'), jobs);
});

test('a part starts from the prepared commit of the part it builds on with its Patch its own change alone, MR preparation replays it onto that part\'s new prepared commit, and Approve is refused until that part is merged', TIMEOUT, async () => {
  const p = await parts('builds-on-flow');
  await script(p.env, [{ write: { 'README.md': 'hello part two\n' } }, { write: { '.software-factory/T-2.mr.md': mrText('feat(T-2): Part two') } }]);
  const fetchHead = join(p.repo, '.git', 'FETCH_HEAD');
  const fetchedBefore = await readFile(fetchHead, 'utf8').catch(() => '');
  const served = await serve(p.env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-2' });
    await waitFor(served, 'T-2', 'awaiting_review', 1);
    let job = (await p.jobs.read('app', 'T-2'))!;
    assert.deepEqual([job.branch, job.base, job.builds_on, job.builds_on_commit, job.base_commit], [PART_TWO, 'main', 'T-1', p.first, p.first]);
    // Nothing was fetched for the start.
    assert.equal(await readFile(fetchHead, 'utf8').catch(() => ''), fetchedBefore);
    // The worktree has part one's file; the Patch the README alone.
    assert.equal(await readFile(join(job.worktree!, 'part1.txt'), 'utf8'), 'part one\n');
    const patch = (await p.jobs.readIteration('app', 'T-2', 1)).patch.toString('utf8');
    assert.match(patch, /^diff --git a\/README\.md b\/README\.md$/m);
    assert.doesNotMatch(patch, /part1\.txt/);

    // The user asked for changes on part one, and it was prepared again: a new commit, not a
    // descendant of the first.
    const second = await p.prepare('part one, changed\n');
    await setPartOne(p, 'ready_for_human_review', second);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-2' });
    await waitFor(served, 'T-2', 'ready_for_human_review', 1);
    job = (await p.jobs.read('app', 'T-2'))!;
    assert.deepEqual([job.target_commit, job.base_commit], [second, second]);
    assert.equal(rev(p.repo, `${PART_TWO}~1`), second);
    // Part one's change once (its new version) and part two's once.
    assert.equal(git(p.repo, 'rev-list', '--count', `main..${PART_TWO}`).trim(), '2');
    assert.equal(git(p.repo, 'diff', '--name-only', second, PART_TWO).trim(), 'README.md');
    assert.equal(git(p.repo, 'show', `${PART_TWO}:part1.txt`), 'part one, changed\n');

    // Approve and sf mr create are refused while part one is not merged; nothing is pushed.
    const message = 'T-2 builds on T-1, which is not merged yet: submit T-1 first.';
    assert.deepEqual(await refusedSocket(p.env, 'approve', ['app', 'T-2']), { code: 'builds_on_not_merged', message });
    const approved = await runCli(p.env, ['approve', 'app', 'T-2']);
    assert.equal(approved.code, 1, approved.stdout + approved.stderr);
    assert.ok(approved.stderr.includes(message), approved.stderr);
    const created = await runCli(p.env, ['mr', 'create', 'app', 'T-2']);
    assert.equal(created.code, 1, created.stdout + created.stderr);
    assert.ok(created.stderr.includes(message), created.stderr);
    assert.equal((await p.jobs.read('app', 'T-2'))!.state, 'ready_for_human_review');
    assert.equal(remoteTip(p.origin, PART_TWO), undefined);
    assert.equal(remoteTip(p.origin, PART_ONE), undefined);

    // Part one is pushed and merged: Approve gets past the check (here, to the push).
    await setPartOne(p, 'pushed', second, { mr: { host: 'github', number: 1, url: 'https://github.com/acme/app/pull/1', state: 'merged' } });
    const pushed = await runCli(p.env, ['approve', 'app', 'T-2']);
    assert.ok(!pushed.stderr.includes(message), pushed.stderr);
  } finally {
    await stop(served);
  }
});

test('MR preparation stops with builds_on_not_ready while the part it builds on is being changed, and Retry prepares it on that part\'s new prepared commit once it is ready again', TIMEOUT, async () => {
  const p = await parts('builds-on-retry', { SF_REVIEW: 'on' });
  await script(p.env, [
    { waitFile: 'release-turn', write: { 'README.md': 'hello part two\n' }, text: 'iteration 1' },
    { write: { '.software-factory/T-2.mr.md': mrText('feat(T-2): Part two') }, text: 'prepared' },
  ]);
  await reviewScript(p.env, [{ output: { verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [] } }]);
  const served = await serve(p.env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-2' });
    // The user asked for changes on part one: it works again.
    await setPartOne(p, 'working', p.first);
    await writeFile(join(p.env.home, 'release-turn'), '');
    const stopped = await waitFor(served, 'T-2', 'needs_human', 1);
    const message = 'T-2 builds on T-1, which is being changed: Retry once T-1 is ready again.';
    assert.equal(stopped.error.code, 'builds_on_not_ready');
    assert.ok(stopped.error.message.includes(message), stopped.error.message);

    // Still working: the Retry stops it again with the code.
    assert.deepEqual(await refusedSocket(p.env, 'retry', ['app', 'T-2']), { code: 'builds_on_not_ready', message });
    assert.equal((await waitFor(served, 'T-2', 'needs_human', 1)).error.code, 'builds_on_not_ready');

    const second = await p.prepare('part one, changed\n');
    await setPartOne(p, 'ready_for_human_review', second);
    const retried = await runCli(p.env, ['retry', 'app', 'T-2']);
    assert.equal(retried.code, 0, retried.stdout + retried.stderr);
    await waitFor(served, 'T-2', 'ready_for_human_review', 1);
    assert.equal(rev(p.repo, `${PART_TWO}~1`), second);
    assert.equal(git(p.repo, 'diff', '--name-only', second, PART_TWO).trim(), 'README.md');
  } finally {
    await stop(served);
  }
});

test('a start by hand is refused while the part it builds on has no prepared commit; once that part is merged the job starts from origin/<base>', TIMEOUT, async () => {
  const p = await parts('builds-on-start');
  const workspace = { name: 'app', readCheckout: p.repo, workCheckout: p.repo };
  await writeTask(workspace, 'T-3', partTask('T-3', 'Part three', 'builds_on: T-9\n'), p.jobs);
  await script(p.env, [{ write: { 'README.md': 'hello part two\n' } }]);
  // origin/main is one commit ahead of the local main.
  git(p.repo, 'commit', '-q', '--allow-empty', '-m', 'chore: later');
  git(p.repo, 'push', '-q', 'origin', 'main');
  git(p.repo, 'reset', '-q', '--hard', 'HEAD~1');
  const served = await serve(p.env);
  try {
    // T-9 has no job at all; T-1 works again.
    assert.deepEqual(await refused(served, 'start', { workspace: 'app', ticket: 'T-3' }), {
      code: 'builds_on_not_ready', message: 'T-3 builds on T-9, which has no prepared commit yet: start it once T-9 is ready, or queue it.',
    });
    await setPartOne(p, 'working', p.first);
    assert.deepEqual(await refused(served, 'start', { workspace: 'app', ticket: 'T-2' }), {
      code: 'builds_on_not_ready', message: 'T-2 builds on T-1, which has no prepared commit yet: start it once T-1 is ready, or queue it.',
    });
    // In handed_over without a prepared commit: refused too.
    await setPartOne(p, 'handed_over', null);
    assert.equal((await refused(served, 'start', { workspace: 'app', ticket: 'T-2' })).code, 'builds_on_not_ready');
    assert.equal(await p.jobs.read('app', 'T-2'), undefined);

    // T-1 is pushed and its merge request merged: T-2 starts from origin/main, fetched.
    await setPartOne(p, 'pushed', p.first, { mr: { host: 'github', number: 1, url: 'https://github.com/acme/app/pull/1', state: 'merged' } });
    await call(served, 'start', { workspace: 'app', ticket: 'T-2' });
    await waitFor(served, 'T-2', 'awaiting_review', 1);
    const job = (await p.jobs.read('app', 'T-2'))!;
    const tip = git(p.repo, 'rev-parse', 'origin/main').trim();
    assert.notEqual(tip, rev(p.repo, 'main'));
    assert.deepEqual([job.builds_on, job.builds_on_commit, job.base_commit], ['T-1', null, tip]);
  } finally {
    await stop(served);
  }
});
