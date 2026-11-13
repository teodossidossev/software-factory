// The pass of merged jobs (Execution.archiveMergedJobs): a pushed job whose commit is on its
// target's history after a fetch of the target, or whose merge request the Git host reports merged
// (recorded, or found by its branch), is logged merged_on_target (with how, mr and commit) and
// archived as the Done card's Archive does (its active Task file too); one not merged stays; a
// failed fetch or host read leaves the jobs alone and is logged once. A handed-over job is archived
// only on the host's word, after Merged — archive's first step; no ref is read and nothing fetched
// for it; a job with continues is never looked up on the host. The pass never pulls, checks out or
// writes in the user's checkout (a git first on PATH records every command), and sends the host
// only GET requests (a fake GitHub on loopback).
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Job } from '../src/jobs.js';
import { startFakeForge } from './support/fake-forge.js';
import { git, putTask } from './support/harness.js';
import {
  archivedDirs, checkoutView, fakeGithub, githubOrigin, handedOver, localConfig, loggedCommands, mergedEvents, mergeOnHost, pushedBranch, pushedJob, recordingGit, WRITES, type World, world,
} from './support/merged.js';

const TIMEOUT = { timeout: 60_000 };
const mr = (number: number, state: 'open' | 'closed' | 'merged', merge_commit: string | null = null): Job['mr'] => ({ host: 'github', number, url: `https://github.com/acme/app/pull/${number}`, state, merge_commit });

// The ticket T-9 that lands after the given tickets, and their states as the start screen shows them.
async function landsAfter(w: World, tickets: string[]): Promise<() => Promise<string[]>> {
  await mkdir(join(w.repo, '.software-factory'), { recursive: true });
  await writeFile(join(w.repo, '.software-factory', 'T-9.md'), `---\nticket: T-9\ntitle: Nine\nbase: main\nlands_after: [${tickets.join(', ')}]\n---\n\n# T-9: Nine\n`);
  return async () => ((await w.setup.tickets()).find((row) => row.ticket === 'T-9')?.lands_after ?? []).map((row) => `${row.ticket} ${row.state}`);
}

// console.error's lines while work runs.
async function logged(work: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    await work();
  } finally {
    console.error = error;
  }
  return lines;
}

test('merged pass: a pushed job whose commit is on the target after a fetch is logged (how base) and archived with its Task file; one not on it stays', TIMEOUT, async () => {
  const w = await world('merged-pass');
  const merged = pushedBranch(w, 'T-1-one', 'one.txt');
  const open = pushedBranch(w, 'T-2-two', 'two.txt');
  mergeOnHost(w, 'T-1-one');
  await putTask(w.env, w.repo, 'T-1', 'One');
  await putTask(w.env, w.repo, 'T-2', 'Two');
  await w.jobs.write(pushedJob('T-1', 'T-1-one', merged));
  await w.jobs.write(pushedJob('T-2', 'T-2-two', open));
  const before = checkoutView(w.repo);
  const recorder = await recordingGit(w.env);
  let archived: Job[];
  try {
    archived = await w.execution.archiveMergedJobs();
  } finally {
    recorder.restore();
  }

  assert.deepEqual(archived.map((job) => job.ticket), ['T-1']);
  assert.equal(await w.jobs.read('app', 'T-1'), undefined);
  const [dir] = await archivedDirs(w, 'T-1');
  assert.equal(dir?.job.ticket, 'T-1');
  assert.deepEqual(mergedEvents(dir), [{ commit: merged, target: 'main', how: 'base' }]);
  // The active Task file went to the archive, as the Done card's Archive does.
  assert.deepEqual(await readdir(join(w.repo, '.software-factory', 'archive')), ['T-1.md']);
  // T-2 is not on main: untouched.
  assert.equal((await w.jobs.read('app', 'T-2'))?.state, 'pushed');
  assert.ok((await readdir(join(w.repo, '.software-factory'))).includes('T-2.md'));
  // The branches and their commits stay; the checkout's HEAD, branches and files are as they were.
  assert.equal(git(w.repo, 'rev-parse', 'refs/remotes/origin/T-1-one').trim(), merged);
  assert.equal(checkoutView(w.repo), before);
  // No pull, checkout, reset, merge, commit or branch change; the fetch is the one of the target.
  const commands = await loggedCommands(recorder.log);
  for (const { command } of commands) {
    assert.doesNotMatch(command, WRITES, command);
  }
  assert.ok(commands.some(({ cwd, command }) => cwd === w.repo && command === 'fetch --no-tags origin main'), JSON.stringify(commands));
});

test('merged pass with the Git host: a recorded merged merge request archives without a request; a recorded open one the host reports merged, and a merged pull request of the branch after a squash merge, archive (how host); one merged before the job was created does not; only GET requests', TIMEOUT, async () => {
  const fake = await startFakeForge('github', 'acme/app');
  try {
    const w = await world('merged-pass-host', fakeGithub(fake.url));
    await githubOrigin(w);
    const one = pushedBranch(w, 'T-1-one', 'one.txt');
    const two = pushedBranch(w, 'T-2-two', 'two.txt');
    const three = pushedBranch(w, 'T-3-three', 'three.txt');
    const four = pushedBranch(w, 'T-4-four', 'four.txt');
    // None of them is on main: no ancestor of origin/main tells (T-3's squash merge left none).
    const squash = 'f'.repeat(40);
    const opened = (number: number, branch: string) => ({ number, branch, base: 'main', title: `PR ${number}`, body: '', state: 'open' as const, draft: false, mergeable: true, mergeableState: 'clean', detailed: 'mergeable', merge_commit: null });
    fake.mrs.push(
      { ...opened(1, 'T-2-two'), state: 'merged', merge_commit: 'a'.repeat(40) },
      { ...opened(2, 'T-3-three'), state: 'merged', merge_commit: squash },
      // T-4-four's pull request of an older job of the same name, merged before T-4's job was created.
      { ...opened(3, 'T-4-four'), state: 'merged', merge_commit: 'b'.repeat(40), merged_at: '2026-11-01T10:00:00Z' },
    );
    await w.jobs.write(pushedJob('T-1', 'T-1-one', one, mr(7, 'merged', 'e'.repeat(40))));
    await w.jobs.write(pushedJob('T-2', 'T-2-two', two, mr(1, 'open')));
    await w.jobs.write(pushedJob('T-3', 'T-3-three', three));
    await w.jobs.write(pushedJob('T-4', 'T-4-four', four));
    const states = await landsAfter(w, ['T-3', 'T-4']);
    assert.deepEqual(await states(), ['T-3 pushed', 'T-4 pushed']);

    assert.deepEqual((await w.execution.archiveMergedJobs()).map((job) => job.ticket), ['T-1', 'T-2', 'T-3']);
    assert.deepEqual(mergedEvents((await archivedDirs(w, 'T-1'))[0]), [{ commit: 'e'.repeat(40), target: 'main', how: 'host', mr: 7 }]);
    assert.deepEqual(mergedEvents((await archivedDirs(w, 'T-2'))[0]), [{ commit: 'a'.repeat(40), target: 'main', how: 'host', mr: 1 }]);
    assert.deepEqual(mergedEvents((await archivedDirs(w, 'T-3'))[0]), [{ commit: squash, target: 'main', how: 'host', mr: 2 }]);
    assert.equal((await w.jobs.read('app', 'T-4'))?.state, 'pushed');
    // The auto-archived job counts as merged for the ticket that lands after it (its merged_on_target).
    assert.deepEqual(await states(), ['T-3 merged', 'T-4 pushed']);
    // GET only; T-1's recorded merge was not asked again.
    assert.deepEqual([...new Set(fake.requests.map((r) => r.method))], ['GET']);
    assert.ok(fake.requests.every((r) => !r.path.startsWith('/repos/acme/app/pulls/7')), JSON.stringify(fake.requests.map((r) => r.path)));
    assert.ok(fake.requests.some((r) => r.path === '/repos/acme/app/pulls/1'));
    // The branches stay on origin.
    assert.equal(git(w.repo, 'rev-parse', 'refs/remotes/origin/T-3-three').trim(), three);
  } finally {
    await fake.close();
  }
});

test('merged pass: a host error is logged once and the ancestor check still archives a merge-commit merge; without a forge no host request is sent and the base decides for any merge request record', TIMEOUT, async () => {
  const fake = await startFakeForge('github', 'acme/app');
  try {
    const w = await world('merged-pass-host-error', fakeGithub(fake.url));
    await githubOrigin(w);
    const one = pushedBranch(w, 'T-1-one', 'one.txt');
    const two = pushedBranch(w, 'T-2-two', 'two.txt');
    mergeOnHost(w, 'T-1-one');
    await w.jobs.write(pushedJob('T-1', 'T-1-one', one));
    await w.jobs.write(pushedJob('T-2', 'T-2-two', two));
    for (let index = 0; index < 3; index += 1) {
      fake.fail.push({ match: /^GET \/repos\/acme\/app\/pulls$/, status: 500, body: { message: 'Server Error' } });
    }
    let archived: Job[] = [];
    const lines = await logged(async () => {
      archived = await w.execution.archiveMergedJobs();
      assert.deepEqual(await w.execution.archiveMergedJobs(), []);
    });
    assert.deepEqual(archived.map((job) => job.ticket), ['T-1']);
    assert.deepEqual(mergedEvents((await archivedDirs(w, 'T-1'))[0]), [{ commit: one, target: 'main', how: 'base' }]);
    assert.equal((await w.jobs.read('app', 'T-2'))?.state, 'pushed');
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0]!, /^app: the pass of merged jobs could not read GitHub: .*500/);
    assert.equal(fake.fail.length, 0);
  } finally {
    await fake.close();
  }

  // No token: the forge is off; the base decides, also for a job whose merge request is recorded open.
  const silent = await startFakeForge('github', 'acme/app');
  try {
    const w = await world('merged-pass-no-forge', { ...fakeGithub(silent.url), githubToken: undefined });
    await githubOrigin(w);
    const one = pushedBranch(w, 'T-1-one', 'one.txt');
    mergeOnHost(w, 'T-1-one');
    await w.jobs.write(pushedJob('T-1', 'T-1-one', one, mr(4, 'open')));
    assert.deepEqual((await w.execution.archiveMergedJobs()).map((job) => job.ticket), ['T-1']);
    assert.deepEqual(mergedEvents((await archivedDirs(w, 'T-1'))[0]), [{ commit: one, target: 'main', how: 'base' }]);
    assert.deepEqual(silent.requests, []);
  } finally {
    await silent.close();
  }
});

test('merged pass: a failed fetch leaves the jobs untouched and is logged once until a fetch works again', TIMEOUT, async () => {
  const w = await world('merged-pass-fetch');
  const merged = pushedBranch(w, 'T-1-one', 'one.txt');
  mergeOnHost(w, 'T-1-one');
  // The checkout's own origin/main already has the merge, so only the failed fetch keeps the job.
  git(w.repo, 'fetch', '-q', 'origin');
  await w.jobs.write(pushedJob('T-1', 'T-1-one', merged));
  const url = git(w.repo, 'remote', 'get-url', 'origin').trim();
  git(w.repo, 'remote', 'set-url', 'origin', join(w.env.home, 'no-such-origin.git'));
  const lines = await logged(async () => {
    assert.deepEqual(await w.execution.archiveMergedJobs(), []);
    assert.deepEqual(await w.execution.archiveMergedJobs(), []);
  });
  assert.equal((await w.jobs.read('app', 'T-1'))?.state, 'pushed');
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0]!, /app.*fetch.*main/);
  git(w.repo, 'remote', 'set-url', 'origin', url);
  assert.deepEqual((await w.execution.archiveMergedJobs()).map((job) => job.ticket), ['T-1']);
});

// The user's work on a handed-over branch: a commit, pushed to origin, merged there by a merge commit.
async function userMerges(w: World, branch: string): Promise<string> {
  await writeFile(join(w.repo, 'mine.txt'), 'mine\n');
  git(w.repo, 'add', 'mine.txt');
  git(w.repo, 'commit', '-q', '-m', 'feat: mine');
  git(w.repo, 'push', '-q', 'origin', branch);
  mergeOnHost(w, branch);
  return git(w.repo, 'rev-parse', 'HEAD').trim();
}

test('merged pass on a handed-over job: without a forge it stays as it is and nothing is fetched, although its commit is on origin/main; with a merged pull request of its branch it goes through Merged — archive\'s first step and is archived (how host)', TIMEOUT, async () => {
  const w = await world('merged-pass-handed');
  const job = await handedOver(w, 'H-1', 'H-1-hand');
  const mine = await userMerges(w, 'H-1-hand');
  git(w.repo, 'fetch', '-q', 'origin');
  // origin/main has the user's commit by a merge commit, and origin/H-1-hand names a commit of it.
  assert.equal(git(w.repo, 'rev-parse', 'refs/remotes/origin/H-1-hand').trim(), mine);
  git(w.repo, 'merge-base', '--is-ancestor', mine, 'refs/remotes/origin/main');
  await w.jobs.write(job);
  const template = localConfig(w.repo, 'commit.template');
  const recorder = await recordingGit(w.env);
  try {
    assert.deepEqual(await w.execution.archiveMergedJobs(), []);
  } finally {
    recorder.restore();
  }
  assert.equal((await w.jobs.read('app', 'H-1'))?.state, 'handed_over');
  assert.equal(localConfig(w.repo, 'commit.template'), template);
  const commands = await loggedCommands(recorder.log);
  assert.ok(commands.every(({ command }) => !command.startsWith('fetch') && !WRITES.test(command)), JSON.stringify(commands));

  const fake = await startFakeForge('github', 'acme/app');
  try {
    const h = await world('merged-pass-handed-host', fakeGithub(fake.url));
    await githubOrigin(h);
    await h.jobs.write(await handedOver(h, 'H-2', 'H-2-hand'));
    const theirs = await userMerges(h, 'H-2-hand');
    fake.mrs.push({ number: 5, branch: 'H-2-hand', base: 'main', title: 'Mine', body: '', state: 'merged', draft: false, mergeable: true, mergeableState: 'clean', detailed: 'mergeable', merge_commit: 'c'.repeat(40) });
    const before = { head: git(h.repo, 'symbolic-ref', 'HEAD').trim(), tip: git(h.repo, 'rev-parse', 'HEAD').trim() };
    const archived = await h.execution.archiveMergedJobs();
    assert.deepEqual(archived.map((done) => [done.ticket, done.state]), [['H-2', 'pushed']]);
    assert.equal(await h.jobs.read('app', 'H-2'), undefined);
    const [dir] = await archivedDirs(h, 'H-2');
    assert.deepEqual([dir?.job.state, dir?.job.handover], ['pushed', undefined]);
    assert.equal(dir!.events.filter((event) => event.type === 'handover_marked_done').length, 1);
    assert.deepEqual(mergedEvents(dir), [{ commit: 'c'.repeat(40), target: 'main', how: 'host', mr: 5 }]);
    // markHandedDone's steps: the factory's commit settings go; the user's branch and commit stay.
    assert.deepEqual([localConfig(h.repo, 'commit.template'), localConfig(h.repo, 'commit.cleanup')], [null, null]);
    assert.deepEqual({ head: git(h.repo, 'symbolic-ref', 'HEAD').trim(), tip: git(h.repo, 'rev-parse', 'HEAD').trim() }, before);
    assert.equal(before.tip, theirs);
    assert.deepEqual([...new Set(fake.requests.map((r) => r.method))], ['GET']);
  } finally {
    await fake.close();
  }
});

test('merged pass: a job with continues is never looked up on the host; a pushed one is archived once its prepared_commit is on origin/main, a handed-over one stays', TIMEOUT, async () => {
  const fake = await startFakeForge('github', 'acme/app');
  try {
    const w = await world('merged-pass-continues', fakeGithub(fake.url));
    await githubOrigin(w);
    const five = pushedBranch(w, 'feature-five', 'five.txt');
    const six = pushedBranch(w, 'feature-six', 'six.txt');
    for (const [number, branch] of [[1, 'feature-five'], [2, 'feature-six'], [3, 'T-5-five'], [4, 'T-6-six']] as const) {
      fake.mrs.push({ number, branch, base: 'main', title: 'Before', body: '', state: 'merged', draft: false, mergeable: true, mergeableState: 'clean', detailed: 'mergeable', merge_commit: 'c'.repeat(40) });
    }
    await w.jobs.write({ ...pushedJob('T-5', 'T-5-five', five, mr(1, 'merged')), continues: 'feature-five' });
    const handed: Job = {
      ...pushedJob('T-6', 'T-6-six', six), continues: 'feature-six', state: 'handed_over',
      handover: { branch: 'feature-six', saved: six, base: six, previous: { branch: 'main' }, untracked: [], template: null, cleanup: null, at: '2026-11-04T11:00:00.000Z', checked_at: null, step: null },
    };
    await w.jobs.write(handed);
    // Not on main yet: nothing archives.
    assert.deepEqual(await w.execution.archiveMergedJobs(), []);
    mergeOnHost(w, 'feature-five');
    mergeOnHost(w, 'feature-six');
    assert.deepEqual((await w.execution.archiveMergedJobs()).map((job) => job.ticket), ['T-5']);
    assert.deepEqual(mergedEvents((await archivedDirs(w, 'T-5'))[0]), [{ commit: five, target: 'main', how: 'base' }]);
    assert.equal((await w.jobs.read('app', 'T-6'))?.state, 'handed_over');
    assert.deepEqual(fake.requests, []);
  } finally {
    await fake.close();
  }
});

test('Archive of a Done job: with an active Task file the Task file goes to the archive too; without one the job alone; the branch and its commits stay; a live job is refused', TIMEOUT, async () => {
  const w = await world('archive-done');
  const commit = pushedBranch(w, 'T-1-one', 'one.txt');
  await putTask(w.env, w.repo, 'T-1', 'One');
  await w.jobs.write(pushedJob('T-1', 'T-1-one', commit));
  const failed: Job = { ...pushedJob('T-2', 'T-2-two', commit), state: 'failed', prepared_commit: null };
  await w.jobs.write(failed);
  await putTask(w.env, w.repo, 'T-3', 'Three');
  await w.jobs.write({ ...pushedJob('T-3', 'T-3-three', commit), state: 'aborted', prepared_commit: null });
  await w.jobs.write({ ...pushedJob('T-4', 'T-4-four', commit), state: 'needs_human', prepared_commit: null });
  const before = git(w.repo, 'for-each-ref', '--format=%(refname) %(objectname)');

  const pushed = await w.execution.archiveFinished('app', 'T-1');
  assert.deepEqual([pushed.branch, /^jobs\/app\/T-1\.\d{8}T\d{6}Z$/.test(pushed.archived)], ['T-1-one', true]);
  // T-2 has no Task file: the job alone.
  assert.equal((await w.execution.archiveFinished('app', 'T-2')).branch, 'T-2-two');
  assert.equal((await w.execution.archiveFinished('app', 'T-3')).branch, 'T-3-three');
  await assert.rejects(w.execution.archiveFinished('app', 'T-4'), (error: Error & { code?: string }) => error.code === 'invalid_state');
  for (const ticket of ['T-1', 'T-2', 'T-3']) {
    assert.equal(await w.jobs.read('app', ticket), undefined, ticket);
  }
  assert.equal((await w.jobs.read('app', 'T-4'))?.state, 'needs_human');
  assert.deepEqual((await readdir(join(w.repo, '.software-factory', 'archive'))).sort(), ['T-1.md', 'T-3.md']);
  assert.equal(git(w.repo, 'for-each-ref', '--format=%(refname) %(objectname)'), before);
});
