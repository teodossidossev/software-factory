// A job that continues an open merge request (`continues: <branch>` in the Task file), end to end
// through `sf serve` and the CLI, with a bare origin and the fake GitHub: the job starts from
// origin/<continues>, MR preparation rebases onto its tip as origin has it then, Approve pushes the
// prepared commit onto <continues> as a fast-forward (never the job's own branch), and the open
// merge request of <continues> is reused. A <continues> that moved after the preparation refuses the
// push and stays as it is; the user's own push to <continues> after a hand-over counts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore } from '../src/jobs.js';
import { jobNotification } from '../src/notify.js';
import { writeTask } from '../src/task-file.js';
import { startFakeForge } from './support/fake-forge.js';
import { call, type Env, git, newEnv, newRepo, refused, runCli, script, serve, stop, temp, waitFor } from './support/harness.js';
import { config, mrText, mrTurn, refusedSocket, remoteTip, rev } from './support/handoff.js';

const CONTINUES = 'feature-x';
const BRANCH = 'T-1-change-readme';
const TITLE = 'feat(T-1): Change the README';

function continuingTask(ticket: string, title: string, continues: string): string {
  return `---\nticket: ${ticket}\ntitle: ${title}\nbase: main\ncontinues: ${continues}\n---\n\n# ${ticket}: ${title}\n\nChange the README.\n`;
}

// A checkout with an origin whose main has README.md and whose <continues> (the open merge
// request's branch) adds feature.txt; the checkout stays on <continues>, as the user's does. Returns
// the bare origin and a move() that commits file on <continues> from another clone and pushes it.
async function continuedRepo(env: Env, name: string): Promise<{ repo: string; origin: string; tip: string; move: (file: string) => string }> {
  const repo = await newRepo(env, `${name}-repo`, true);
  const origin = join(temp, `${name}-repo-origin.git`);
  git(repo, 'checkout', '-q', '-b', CONTINUES);
  await writeFile(join(repo, 'feature.txt'), 'feature\n');
  git(repo, 'add', 'feature.txt');
  git(repo, 'commit', '-q', '-m', 'feat(T-0): The feature');
  git(repo, 'push', '-q', 'origin', CONTINUES);
  const pusher = join(temp, `${name}-pusher`);
  execFileSync('git', ['clone', '-q', '--branch', CONTINUES, origin, pusher]);
  const move = (file: string): string => {
    execFileSync('sh', ['-c', 'printf moved > "$1"', 'sh', file], { cwd: pusher });
    git(pusher, 'add', file);
    git(pusher, 'commit', '-q', '-m', `chore: ${file}`);
    git(pusher, 'push', '-q', 'origin', CONTINUES);
    return rev(pusher, 'HEAD');
  };
  return { repo, origin, tip: rev(repo, 'HEAD'), move };
}

async function putContinuingTask(env: Env, repo: string): Promise<void> {
  await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, 'T-1', continuingTask('T-1', 'Change README', CONTINUES), new JobStore(env.state));
}

test('a continuing job starts from origin/<continues>, is rebased onto its moved tip, and Approve fast-forwards <continues> only; the link names it, and sf mr create reuses its open merge request', async () => {
  const fake = await startFakeForge('github', 'acme/app');
  fake.mrs.push({
    number: 7, branch: CONTINUES, base: 'main', title: 'feat(T-0): The feature', body: 'The first part.', state: 'open', draft: false,
    mergeable: true, mergeableState: 'clean', detailed: 'mergeable', merge_commit: null,
  });
  const env = await newEnv('continues-approve');
  await mkdir(env.config, { recursive: true });
  await writeFile(join(env.config, 'auth.env'), `SF_GITHUB_TOKEN=github_pat_TEST\nSF_GITHUB_API=${fake.url}\n`);
  const { repo, origin, tip, move } = await continuedRepo(env, 'continues-approve');
  await putContinuingTask(env, repo);
  await script(env, [{ write: { 'README.md': 'hello world\n' } }, { write: { '.software-factory/T-1.mr.md': mrText(TITLE) } }]);
  const served = await serve(env);
  const jobs = new JobStore(env.state);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    let job = (await jobs.read('app', 'T-1'))!;
    // The job's own branch, started from the continued branch's tip on origin.
    assert.deepEqual([job.branch, job.base, job.continues, job.base_commit], [BRANCH, 'main', CONTINUES, tip]);

    const moved = move('other.txt');
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    job = (await jobs.read('app', 'T-1'))!;
    assert.equal(job.target_commit, moved);
    assert.equal(rev(repo, `${BRANCH}~1`), moved);

    // The origin is on GitHub now; the push still goes to the bare repository.
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
    git(repo, 'remote', 'set-url', '--push', 'origin', origin);
    const approved = await runCli(env, ['approve', 'app', 'T-1']);
    assert.equal(approved.code, 0, approved.stdout + approved.stderr);
    assert.ok(approved.stdout.includes(`https://github.com/acme/app/compare/main...${CONTINUES}?expand=1`), approved.stdout);
    job = (await jobs.read('app', 'T-1'))!;
    assert.equal(job.state, 'pushed');
    // The notification of the push names the branch on origin.
    assert.equal(jobNotification(job).body.split('\n')[0], `branch: ${CONTINUES}`);
    // A fast-forward of <continues> to the prepared commit; the job's own branch is not on origin.
    assert.equal(remoteTip(origin, CONTINUES), job.prepared_commit);
    assert.equal(execFileSync('git', ['--git-dir', origin, 'rev-parse', `${job.prepared_commit}~1`], { encoding: 'utf8' }).trim(), moved);
    assert.equal(remoteTip(origin, BRANCH), undefined);
    assert.equal(fake.requests.length, 0);

    const created = await runCli(env, ['mr', 'create', 'app', 'T-1']);
    assert.equal(created.code, 0, created.stdout + created.stderr);
    assert.match(created.stdout, /^merge request: #7 already open, reused$/m);
    assert.deepEqual(fake.requests.map((request) => request.method), ['GET']);
    assert.equal(new URL(fake.requests[0]!.path, 'http://fake').searchParams.get('head'), `acme:${CONTINUES}`);
    assert.deepEqual([fake.mrs.length, fake.mrs[0]!.title, fake.mrs[0]!.body], [1, 'feat(T-0): The feature', 'The first part.']);
    assert.deepEqual((await jobs.read('app', 'T-1'))!.mr, { host: 'github', number: 7, url: 'https://github.com/acme/app/pull/7', state: 'open' });
  } finally {
    await stop(served);
    await fake.close();
  }
});

test('a <continues> that moved on origin after the preparation refuses the push (mr_push_failed) and stays as it is; continues: master, the base or an invalid name is refused at start', async () => {
  const env = await newEnv('continues-moved');
  const { repo, origin, move } = await continuedRepo(env, 'continues-moved');
  await putContinuingTask(env, repo);
  // Written straight to disk: write_task would refuse it already.
  const refusedAtStart: Array<[string, string, string]> = [
    ['T-2', 'master', '"continues" must not be a protected branch (master).'], ['T-3', 'main', '"continues" must differ from "base".'], ['T-4', 'a..b', '"continues" must be a valid branch name.'],
  ];
  for (const [ticket, continues] of refusedAtStart) {
    await writeFile(join(repo, '.software-factory', `${ticket}.md`), continuingTask(ticket, 'Refused', continues));
  }
  await script(env, [{ write: { 'README.md': 'hello world\n' } }, { write: { '.software-factory/T-1.mr.md': mrText(TITLE) } }]);
  const served = await serve(env);
  const jobs = new JobStore(env.state);
  try {
    for (const [ticket, , message] of refusedAtStart) {
      assert.deepEqual(await refused(served, 'start', { workspace: 'app', ticket }), { code: 'invalid_content', message }, ticket);
      assert.equal(await jobs.read('app', ticket), undefined, ticket);
    }

    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    const moved = move('other.txt');
    const approved = await runCli(env, ['approve', 'app', 'T-1']);
    assert.equal(approved.code, 1, approved.stdout + approved.stderr);
    const job = (await jobs.read('app', 'T-1'))!;
    assert.equal(job.state, 'needs_human');
    assert.equal(job.error?.code, 'mr_push_failed');
    assert.match(job.error!.message, new RegExp(`^git push origin ${CONTINUES} failed: `));
    assert.equal(remoteTip(origin, CONTINUES), moved);
    assert.equal(remoteTip(origin, BRANCH), undefined);
  } finally {
    await stop(served);
  }
});

test('the hand-over of a continuing job counts the user\'s push to <continues>, not to the job\'s own branch', async () => {
  const env = await newEnv('continues-handover', { SF_HANDOFF: 'checkout' });
  const { repo, origin } = await continuedRepo(env, 'continues-handover');
  git(repo, 'switch', '-q', 'main');
  await putContinuingTask(env, repo);
  await script(env, [{ write: { 'README.md': 'hello world\n' } }, mrTurn('T-1', 'Change the README')]);
  const served = await serve(env);
  const jobs = new JobStore(env.state);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'handed_over');
    const s = { env, repo, origin, served, jobs };
    assert.deepEqual(await refusedSocket(s, 'handed-done', ['app', 'T-1']), { code: 'not_pushed', message: `The branch ${CONTINUES} is not on origin with your changes; push it first.` });
    // A push of the job's own branch does not count.
    git(repo, 'commit', '-q', '-a', '-F', config(repo, 'commit.template')!, '--cleanup=scissors');
    git(repo, 'push', '-q', 'origin', BRANCH);
    assert.equal((await refusedSocket(s, 'handed-done', ['app', 'T-1'])).code, 'not_pushed');

    git(repo, 'push', '-q', 'origin', `HEAD:refs/heads/${CONTINUES}`);
    const done = await runCli(env, ['handed-done', 'app', 'T-1']);
    assert.equal(done.code, 0, done.stdout + done.stderr);
    const job = (await jobs.read('app', 'T-1'))!;
    assert.deepEqual([job.state, job.prepared_commit, remoteTip(origin, CONTINUES)], ['pushed', rev(repo, 'HEAD'), rev(repo, 'HEAD')]);
  } finally {
    await stop(served);
  }
});
