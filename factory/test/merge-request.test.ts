// The merge request from the factory (SF-048) end to end through `sf serve`, the CLI and the
// dashboard's routes, against the fake GitHub and GitLab of test/support/fake-forge.ts: sf mr create
// from ready_for_human_review (approve, then open) and from pushed (new and reused), sf mr merge,
// sf mr status, not mergeable with the host's reason, a missing token, a wrong host, a 401, and
// the token in the Authorization header only, never in a job file or a log line.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { postRoute } from '../src/dashboard-routes.js';
import { FactoryError } from '../src/errors.js';
import { Execution, type MrInput } from '../src/execution.js';
import { type Job, JobStore } from '../src/jobs.js';
import { messageText, mrMessage } from '../src/mr.js';
import { resolveWorkspace, saveRegistry } from '../src/registry.js';
import { commitMessagePath } from '../src/handoff.js';
import { COMMIT_TYPES, MANUAL_CLAIM, MR_REQUIRED_HEADINGS } from '../src/rules.js';
import { enqueue, runnerLauncher } from '../src/runner.js';
import { jobNotification } from '../src/notify.js';
import { describeEvent } from '../src/watch.js';
import { act, fakeActions, fetchRaw, openStream } from './support/dashboard-client.js';
import { withDashboard } from './support/dashboard-state.js';
import { FAKE_MERGE_SHA, startFakeForge } from './support/fake-forge.js';
import { call, type Env, FAKE, git, newEnv, newRepo, processEnv, putTask, runCli, script, serve, stop, temp, waitFor } from './support/harness.js';

const TOKEN = 'github_pat_E2ESECRET0123456789abcdefgh';
const GL_TOKEN = 'glpat-E2ESECRET0123456789';
const TITLE = 'feat(T-1): Change the README';

function mrText(header: string): string {
  return [
    header, '',
    '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
    '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'npm test: passed', '## Screenshots', 'N/A',
    '## Checklist', '- [x] Branch name', '- [x] Target branch', '',
  ].join('\n');
}

// The tokens go in the environment file, as the user keeps them.
async function envFile(env: Env, lines: string[]): Promise<void> {
  await mkdir(env.config, { recursive: true });
  await writeFile(join(env.config, 'auth.env'), `${lines.join('\n')}\n`);
}

// Every file under dir, as text.
async function allText(dir: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      text += await readFile(join(entry.parentPath, entry.name), 'utf8').catch(() => '');
    }
  }
  return text;
}

// A pushed job written straight into the state directory, with its MR text, over a checkout whose
// origin is url.
async function pushedJob(env: Env, name: string, url: string, extra: Partial<Job> = {}): Promise<{ repo: string; jobs: JobStore }> {
  const repo = await newRepo(env, name, false);
  git(repo, 'remote', 'add', 'origin', url);
  const jobs = new JobStore(env.state);
  const now = '2026-11-04T10:00:00.000Z';
  await jobs.write({
    workspace: 'app', ticket: 'T-1', branch: 'T-1-change-readme', base: 'main', base_commit: null, target_commit: null, worktree: null,
    prepared_commit: 'a'.repeat(40), mr_attempts: 1, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'pushed', iteration: 1, session_id: null,
    mr: null, created_at: now, updated_at: now, ...extra,
  });
  await jobs.writeMrText('app', 'T-1', mrText(TITLE));
  return { repo, jobs };
}

// sf serve with its stdout and stderr collected after the listening line.
async function serveLogged(env: Env): Promise<{ served: Awaited<ReturnType<typeof serve>>; log: () => string }> {
  const served = await serve(env);
  let log = served.output;
  served.child.stdout!.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
  served.child.stderr!.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
  return { served, log: () => log };
}

test('sf mr create from ready_for_human_review pushes, then opens the pull request; status; merge; the token only in Authorization', async () => {
  const fake = await startFakeForge('github', 'acme/app');
  const env = await newEnv('mr-e2e');
  await envFile(env, [`SF_GITHUB_TOKEN=${TOKEN}`, `SF_GITHUB_API=${fake.url}`]);
  const repo = await newRepo(env, 'mr-e2e-repo', true);
  const origin = join(temp, 'mr-e2e-repo-origin.git');
  await putTask(env, repo, 'T-1', 'Change README');
  await script(env, [
    { write: { 'README.md': 'hello world\n' } },
    { write: { '.software-factory/T-1.mr.md': mrText(TITLE) } },
  ]);
  const { served, log } = await serveLogged(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    // The origin is on GitHub now; the push still goes to the bare repository.
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
    git(repo, 'remote', 'set-url', '--push', 'origin', origin);

    const created = await runCli(env, ['mr', 'create', 'app', 'T-1']);
    assert.equal(created.code, 0, created.stdout + created.stderr);
    assert.equal(created.stdout, [
      'state: pushed', 'branch: T-1-change-readme', `title: ${TITLE}`, 'merge request: #1 opened', 'url: https://github.com/acme/app/pull/1', '',
    ].join('\n'));
    assert.equal(execFileSync('git', ['--git-dir', origin, 'log', '-1', '--format=%s', 'T-1-change-readme'], { encoding: 'utf8' }).trim(), TITLE);
    assert.deepEqual(fake.requests.map((r) => `${r.method} ${r.path.split('?')[0]}`), ['GET /repos/acme/app/pulls', 'POST /repos/acme/app/pulls']);
    // Title and body: mrMessage of the MR text, the same as the pushed commit's message.
    assert.deepEqual(fake.requests[1]!.body, { title: TITLE, head: 'T-1-change-readme', base: 'main', body: mrMessage(mrText(TITLE)).body });
    const sent = fake.requests[1]!.body as { title: string; body: string };
    const pushed = execFileSync('git', ['--git-dir', origin, 'cat-file', 'commit', 'refs/heads/T-1-change-readme'], { encoding: 'utf8' });
    assert.equal(pushed.slice(pushed.indexOf('\n\n') + 2), `${sent.title}\n\n${sent.body}\n`);
    const jobs = new JobStore(env.state);
    let job = (await jobs.read('app', 'T-1'))!;
    assert.deepEqual([job.state, job.mr], ['pushed', { host: 'github', number: 1, url: 'https://github.com/acme/app/pull/1', state: 'open' }]);

    // Again: the open one is reused, no duplicate.
    const again = await runCli(env, ['mr', 'create', 'app', 'T-1']);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /^merge request: #1 already open, reused$/m);
    assert.equal(fake.mrs.length, 1);

    fake.checkRuns.push({ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' });
    const status = await runCli(env, ['mr', 'status', 'app', 'T-1']);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.stdout, [
      'state: pushed', 'branch: T-1-change-readme', 'merge request: #1 open', 'url: https://github.com/acme/app/pull/1', 'mergeable: yes', 'checks: 1 passed, 1 failed', '',
    ].join('\n'));

    const merged = await runCli(env, ['mr', 'merge', 'app', 'T-1']);
    assert.equal(merged.code, 0, merged.stdout + merged.stderr);
    assert.equal(merged.stdout, [
      'state: pushed', 'branch: T-1-change-readme', 'merge request: #1 merged', `merge commit: ${FAKE_MERGE_SHA}`, 'url: https://github.com/acme/app/pull/1', '',
    ].join('\n'));
    assert.deepEqual(fake.requests.find((r) => r.method === 'PUT')?.body, { merge_method: 'merge' });
    job = (await jobs.read('app', 'T-1'))!;
    assert.deepEqual(job.mr, { host: 'github', number: 1, url: 'https://github.com/acme/app/pull/1', state: 'merged', merge_commit: FAKE_MERGE_SHA });
    // Merged: a second merge is refused before any request.
    const before = fake.requests.length;
    const twice = await runCli(env, ['mr', 'merge', 'app', 'T-1']);
    assert.equal(twice.code, 1);
    assert.match(twice.stderr, /^sf: The merge request #1 is merged; only an open one is merged\.$/m);
    assert.equal(fake.requests.length, before);

    // The events: the push, then created, reused and merged.
    const events = (await readFile(jobs.eventsPath('app', 'T-1'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const mrEvents = events.filter((event) => event.type === 'merge_request');
    assert.deepEqual(mrEvents.map((event) => [event.action, event.number, event.mr_state]), [['created', 1, 'open'], ['reused', 1, 'open'], ['merged', 1, 'merged']]);
    assert.match(describeEvent(JSON.stringify(mrEvents[2]))!.lines.join('\n'), /^\d\d:\d\d:\d\d \[1\] merge request #1 merged: https:\/\/github\.com\/acme\/app\/pull\/1$/);

    // The token: in every request's Authorization header, nowhere in the state, the logs or the CLI.
    assert.ok(fake.requests.every((r) => r.headers.authorization === `Bearer ${TOKEN}`));
    assert.doesNotMatch(await allText(env.state), /E2ESECRET/);
    assert.doesNotMatch(log() + created.stdout + created.stderr + merged.stdout + status.stdout, /E2ESECRET/);
    // sf info says whether it is set, not what it is.
    const info = await runCli(env, ['info']);
    assert.match(info.stdout, /^git hosts {5}SF_GITHUB_TOKEN set, SF_GITLAB_TOKEN not set$/m);
    assert.doesNotMatch(info.stdout, /E2ESECRET/);
  } finally {
    await stop(served);
    await fake.close();
  }
});

test('sf mr: a missing token and a wrong host turn the actions off and say why, with nothing sent; a 401, a host that cannot merge and a wrong state are refused', async () => {
  const fake = await startFakeForge('github', 'acme/app');
  const env = await newEnv('mr-refusals');
  const { repo, jobs } = await pushedJob(env, 'mr-refusals-repo', 'git@github.com:acme/app.git');
  let { served } = await serveLogged(env);
  try {
    const missing = await runCli(env, ['mr', 'create', 'app', 'T-1']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^sf: Merge requests are off for this workspace: SF_GITHUB_TOKEN is not set in the environment file\.$/m);
    // A merge request needs one first; status too.
    assert.match((await runCli(env, ['mr', 'merge', 'app', 'T-1'])).stderr, /sf mr merge needs a pushed job with a merge request \(sf mr create opens one\); the job is pushed without one\./);
    assert.match((await runCli(env, ['mr', 'status', 'app', 'T-1'])).stderr, /No merge request is recorded for app\/T-1; sf mr create opens one\./);
    assert.equal((await runCli(env, ['mr', 'open', 'app', 'T-1'])).code, 2);
    assert.equal((await runCli(env, ['mr', 'create', 'app'])).code, 2);
  } finally {
    await stop(served);
  }
  await envFile(env, [`SF_GITHUB_TOKEN=${TOKEN}`, `SF_GITHUB_API=${fake.url}`]);
  ({ served } = await serveLogged(env));
  try {
    fake.fail.push({ match: /^GET /, status: 401, body: { message: 'Bad credentials' } });
    const unauthorized = await runCli(env, ['mr', 'create', 'app', 'T-1']);
    assert.equal(unauthorized.code, 1);
    assert.match(unauthorized.stderr, /^sf: GitHub refused the token in SF_GITHUB_TOKEN \(401: Bad credentials\)\. Check the token and its permissions\.$/m);
    assert.equal((await jobs.read('app', 'T-1'))!.mr, null);

    assert.equal((await runCli(env, ['mr', 'create', 'app', 'T-1'])).code, 0);
    fake.mrs[0]!.mergeable = false;
    fake.mrs[0]!.mergeableState = 'dirty';
    const status = await runCli(env, ['mr', 'status', 'app', 'T-1']);
    assert.match(status.stdout, /^mergeable: no\nreason: it has conflicts with main$/m);
    const conflicts = await runCli(env, ['mr', 'merge', 'app', 'T-1']);
    assert.equal(conflicts.code, 1);
    assert.match(conflicts.stderr, /^sf: GitHub cannot merge pull request #1: it has conflicts with main\.$/m);
    fake.mrs[0]!.mergeable = true;
    fake.mrs[0]!.mergeableState = 'blocked';
    const blocked = await runCli(env, ['mr', 'merge', 'app', 'T-1']);
    assert.match(blocked.stderr, /^sf: GitHub refused to merge pull request #1: Required status check "test" is failing\. \(it is blocked: required checks or reviews have not passed\)\.$/m);
    assert.deepEqual([fake.mrs[0]!.state, (await jobs.read('app', 'T-1'))!.mr?.state], ['open', 'open']);

    // Merged by hand on the host: sf mr status records it.
    fake.mrs[0]!.state = 'merged';
    fake.mrs[0]!.merge_commit = FAKE_MERGE_SHA;
    assert.match((await runCli(env, ['mr', 'status', 'app', 'T-1'])).stdout, /^merge request: #1 merged$/m);
    assert.deepEqual((await jobs.read('app', 'T-1'))!.mr, { host: 'github', number: 1, url: 'https://github.com/acme/app/pull/1', state: 'merged', merge_commit: FAKE_MERGE_SHA });

    // A wrong host: the origin moved to Bitbucket; nothing is sent.
    const requests = fake.requests.length;
    await jobs.write({ ...(await jobs.read('app', 'T-1'))!, mr: null });
    git(repo, 'remote', 'set-url', 'origin', 'https://bitbucket.org/acme/app.git');
    const wrong = await runCli(env, ['mr', 'create', 'app', 'T-1']);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /^sf: Merge requests are off for this workspace: bitbucket\.org is not GitHub or gitlab\.com; if it is a GitLab, set SF_GITLAB_URL to its API \(https:\/\/bitbucket\.org\/api\/v4\)\.$/m);
    assert.equal(fake.requests.length, requests);

    // Not pushed yet and not ready: refused.
    await jobs.write({ ...(await jobs.read('app', 'T-1'))!, state: 'awaiting_review' });
    assert.match((await runCli(env, ['mr', 'create', 'app', 'T-1'])).stderr, /sf mr create needs pushed, or ready_for_human_review \(approve, then the merge request\); the job is awaiting_review\./);
    assert.doesNotMatch(await allText(env.state), /E2ESECRET/);
  } finally {
    await stop(served);
    await fake.close();
  }
});

test('sf mr against GitLab: SF_GITLAB_URL for the origin\'s host; create with the description, merge through PUT .../merge', async () => {
  const fake = await startFakeForge('gitlab', 'group/app');
  const env = await newEnv('mr-gitlab');
  await envFile(env, [`SF_GITLAB_TOKEN=${GL_TOKEN}`, `SF_GITLAB_URL=${fake.url}/api/v4`]);
  const { jobs } = await pushedJob(env, 'mr-gitlab-repo', `${fake.url}/group/app.git`);
  const { served, log } = await serveLogged(env);
  try {
    const created = await runCli(env, ['mr', 'create', 'app', 'T-1']);
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, new RegExp(`^merge request: #1 opened\\nurl: ${fake.url}/group/app/-/merge_requests/1$`, 'm'));
    assert.deepEqual(fake.requests[1]!.body, { source_branch: 'T-1-change-readme', target_branch: 'main', title: TITLE, description: mrMessage(mrText(TITLE)).body });
    const merged = await runCli(env, ['mr', 'merge', 'app', 'T-1']);
    assert.equal(merged.code, 0, merged.stderr);
    assert.ok(fake.requests.some((r) => r.method === 'PUT' && r.path === '/api/v4/projects/group%2Fapp/merge_requests/1/merge'));
    assert.equal((await jobs.read('app', 'T-1'))!.mr?.state, 'merged');
    assert.ok(fake.requests.every((r) => r.headers.authorization === `Bearer ${GL_TOKEN}`));
    assert.doesNotMatch((await allText(env.state)) + log(), /E2ESECRET/);
  } finally {
    await stop(served);
    await fake.close();
  }
});

test('dashboard mr routes: POST only, an empty body, the Execution called once with the job; refusals mapped; mr and mr_host in the job data', async () => {
  const fake = fakeActions();
  fake.mrHost = { host: null, reason: 'SF_GITHUB_TOKEN is not set in the environment file' };
  await withDashboard('dash-mr-routes', fake, async (dashboard) => {
    const base = dashboard.url;
    assert.ok(['mr-create', 'mr-merge', 'mr-status'].every((action) => postRoute(action, 'job') !== undefined));
    for (const [action, method] of [['mr-create', 'createMergeRequest'], ['mr-merge', 'mergeMergeRequest'], ['mr-status', 'mergeRequestStatus']] as const) {
      assert.equal((await act(base, `api/jobs/app/T-1/${action}`, {}, { method: 'GET' })).status, 405);
      assert.equal((await act(base, `api/jobs/app/T-1/${action}`, { x: 1 })).status, 400);
      fake.answer = { state: 'pushed', branch: 'T-1-demo', mr: { host: 'github', number: 3, url: 'https://github.com/acme/app/pull/3', state: 'open' } };
      const reply = await act(base, `api/jobs/app/T-1/${action}`, {});
      assert.equal(reply.status, 200, reply.body);
      assert.deepEqual(JSON.parse(reply.body).result, fake.answer);
      assert.deepEqual(fake.calls.at(-1), [method, 'app', 'T-1']);
    }
    assert.equal(fake.calls.length, 3);
    for (const [code, status] of [['mr_not_mergeable', 409], ['mr_token_missing', 409], ['mr_host_unsupported', 409], ['mr_auth_failed', 502], ['mr_host_error', 502], ['mr_host_unreachable', 502]] as const) {
      fake.answer = new FactoryError(code, `The ${code} message.`);
      const reply = await act(base, 'api/jobs/app/T-1/mr-merge', {});
      assert.deepEqual([reply.status, JSON.parse(reply.body).error], [status, { code, message: `The ${code} message.` }], code);
    }
    const jobs = JSON.parse((await fetchRaw(new URL('api/jobs', base))).body).jobs;
    assert.deepEqual([jobs[0].mr, jobs[0].mr_host], [null, { host: null, reason: 'SF_GITHUB_TOKEN is not set in the environment file' }]);
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body);
    assert.deepEqual([detail.mr_title, detail.job.mr_host.reason], [null, 'SF_GITHUB_TOKEN is not set in the environment file']);
  });
});

test('dashboard mr-status: the pages that show the job get its detail again, so a merge request merged on the host shows merged without another state change', async () => {
  const fake = fakeActions();
  await withDashboard('dash-mr-status-refresh', fake, async (dashboard, store) => {
    const opened = { ...store.job, state: 'pushed' as const, mr: { host: 'github' as const, number: 2, url: 'https://github.com/acme/app/pull/2', state: 'open' as const } };
    await store.jobs.write(opened);
    const stream = await openStream(new URL('api/stream?job=app/T-1', dashboard.url));
    assert.equal((await stream.next('job')).job.mr.state, 'open');
    // What Execution.mergeRequestStatus does when the host says merged: the record changes, no state change.
    fake.answer = async () => {
      await store.jobs.write({ ...opened, mr: { ...opened.mr, state: 'merged' } });
      return { state: 'pushed', branch: opened.branch, mr: { ...opened.mr, state: 'merged' }, status: { number: 2, url: opened.mr.url, state: 'merged', draft: false, mergeable: false, reason: 'it is merged' } };
    };
    const reply = await act(dashboard.url, 'api/jobs/app/T-1/mr-status', {});
    assert.equal(reply.status, 200, reply.body);
    // As on a state change: the jobs, then the job's detail.
    assert.equal((await stream.next('jobs')).jobs.find((row: { ticket: string }) => row.ticket === 'T-1').mr.state, 'merged');
    const detail = await stream.next('job');
    assert.deepEqual([detail.job.state, detail.job.mr.state], ['pushed', 'merged']);
  });
});

test('sf info never prints the credentials of SF_GITLAB_URL: a valid one is shown as checked, an invalid one as its redacted refusal', async () => {
  const env = await newEnv('mr-info');
  await envFile(env, ['SF_GITLAB_URL=https://user:hunter2secret@git.example/api/v4']);
  const refused = await runCli(env, ['info']);
  assert.equal(refused.code, 0, refused.stderr);
  assert.match(refused.stdout, /^git hosts {5}invalid: SF_GITLAB_URL must be an http\(s\) URL without credentials, query or fragment, got "https:\/\/\[redacted\]@git\.example\/api\/v4"\.$/m);
  assert.doesNotMatch(refused.stdout + refused.stderr, /hunter2secret|user:/);
  await envFile(env, ['SF_GITLAB_URL=https://git.example/api/v4/', `SF_GITLAB_TOKEN=${GL_TOKEN}`]);
  const shown = await runCli(env, ['info']);
  assert.match(shown.stdout, /^git hosts {5}SF_GITHUB_TOKEN not set, SF_GITLAB_TOKEN set, SF_GITLAB_URL https:\/\/git\.example\/api\/v4$/m);
  assert.doesNotMatch(shown.stdout, /E2ESECRET/);
});

test('the notification of a pushed job names its merge request once opened or merged', () => {
  const job: Job = {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-x', base: 'main', base_commit: null, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 1, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'pushed', iteration: 1, session_id: null, created_at: '2026-11-04T10:00:00.000Z',
    updated_at: '2026-11-04T10:00:00.000Z', mr: { host: 'github', number: 7, url: 'https://github.com/acme/app/pull/7', state: 'open' },
  };
  assert.deepEqual(jobNotification(job, [TITLE, 'Merge request #7: https://github.com/acme/app/pull/7']), {
    title: 'T-1: merge request #7 opened', body: `branch: T-1-x\n${TITLE}\nMerge request #7: https://github.com/acme/app/pull/7`, priority: 'default', tags: 'white_check_mark',
  });
  assert.equal(jobNotification({ ...job, mr: { ...job.mr!, state: 'merged' } }).title, 'T-1: merge request #7 merged');
  assert.equal(jobNotification({ ...job, mr: null }).title, 'T-1: pushed');
});

// ---------- SF-080: the Merge request screen's Save and Reset, in-process ----------

const EDIT_TITLE = 'feat(T-1): Change the README for readers';
const EDIT_BODY = mrMessage(mrText(TITLE)).body.replace('Changes the README.', 'Changes the README for the readers.');
const BRANCH = 'T-1-change-readme';
const AUTHOR_DATE = '2026-11-01T09:00:00+00:00';

interface MrWorld {
  env: Env;
  repo: string;
  origin: string;
  worktree: string;
  execution: Execution;
  jobs: JobStore;
  prepared: string;
  target: string;
  job: Job;
}

// A job ready for review as Clean leaves it, without a session: its worktree on the branch with
// one commit on origin/main whose message is the MR text, mr.md, and the job record.
async function mrWorld(name: string, extra: Partial<Job> = {}): Promise<MrWorld> {
  const env = await newEnv(name);
  // Git as the factory runs it in-process: the user's identity of the test's HOME.
  process.env.HOME = env.home;
  const repo = await newRepo(env, `${name}-repo`, true);
  const origin = join(temp, `${name}-repo-origin.git`);
  const worktree = join(env.state, 'worktrees', 'app', 'T-1');
  await mkdir(join(env.state, 'worktrees', 'app'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'origin/main');
  await writeFile(join(worktree, 'README.md'), 'hello world\n');
  git(worktree, 'add', 'README.md');
  execFileSync('git', ['commit', '-q', '--cleanup=verbatim', '-F', '-'], {
    cwd: worktree, input: messageText(mrMessage(mrText(TITLE))), env: { ...process.env, GIT_AUTHOR_DATE: AUTHOR_DATE },
  });
  const prepared = git(repo, 'rev-parse', BRANCH).trim();
  const target = git(repo, 'rev-parse', 'origin/main').trim();
  const config: Config = {
    stateDir: env.state, checkAfterStartMin: 15, checkAfterFixMin: 5, maxTurns: 10, turnLimitContinues: 1, maxIterations: 5, claudePath: FAKE,
    sandbox: undefined, model: undefined, worktreeRoot: join(env.state, 'worktrees'), maxJobs: 3, sensitivePaths: [],
    review: false, reviewModel: undefined, reviewMaxTurns: 60, simplify: false, taskCheckMaxTurns: 30, taskCheckAuto: false, taskCheckParallel: 1, rulesMaxBytes: 49152,
    gate: { on: false, reason: 'SF_GATE=off' }, codexModel: undefined, gateMaxRounds: 3, gateMaxTokens: 5_000_000, gateTimeoutMs: 900_000, gateLevel: 'auto', gateFullPaths: [],
    forge: { githubToken: undefined, githubApi: 'https://api.github.com', gitlabToken: undefined, gitlabUrl: undefined }, handoff: 'off', smokeProbeAllow: undefined,
  };
  const execution = new Execution(config, (workspace) => resolveWorkspace(workspace, env.config), () => {}, '', { launch: runnerLauncher(processEnv(env)) });
  const jobs = execution.jobs;
  const job: Job = {
    workspace: 'app', ticket: 'T-1', branch: BRANCH, base: 'main', base_commit: target, target_commit: target, worktree, prepared_commit: prepared,
    mr_attempts: 1, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'ready_for_human_review', iteration: 1, session_id: null, mr: null,
    created_at: '2026-11-04T10:00:00.000Z', updated_at: '2026-11-04T10:05:00.000Z', ...extra,
  };
  await jobs.write(job);
  await jobs.appendEvent('app', 'T-1', { ts: job.updated_at, iteration: 1, state: { from: 'preparing_mr', to: 'ready_for_human_review' } });
  await jobs.writeMrText('app', 'T-1', mrText(TITLE));
  return { env, repo, origin, worktree, execution, jobs, prepared, target, job };
}

const refusal = async (work: Promise<unknown>): Promise<{ code: string; message: string }> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof FactoryError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error('not refused');
};

const messageOf = (repo: string, ref: string): string => git(repo, 'log', '-1', '--format=%B', ref);
const mrEvents = async (world: MrWorld): Promise<Array<Record<string, unknown>>> =>
  (await readFile(world.jobs.eventsPath('app', 'T-1'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.type === 'mr_edited');
const filesOf = async (world: MrWorld): Promise<[string | undefined, string | undefined]> => [await world.jobs.readMrText('app', 'T-1'), await world.jobs.readMrFactoryText('app', 'T-1')];

test('SF-080 save: mr.md as the commit message is written, mr-factory.md kept once, the prepared commit reworded with the same tree, author and parent; reset copies the factory text back', async () => {
  const world = await mrWorld('mr-save');
  const { execution, repo } = world;
  const tree = git(repo, 'rev-parse', `${BRANCH}^{tree}`).trim();
  const author = git(repo, 'log', '-1', '--format=%an <%ae> %aI', BRANCH);
  let view = (await execution.mergeRequestView('app', 'T-1'))!;
  assert.deepEqual([view.edited, view.edited_at, view.factory, view.commit_differs, view.editable, view.readonly_reason, view.problems], [false, null, mrMessage(mrText(TITLE)), false, true, null, []]);
  assert.deepEqual([view.branch, view.base, view.branch_editable, view.branch_reason, view.base_editable, view.target], [BRANCH, 'main', true, null, true, { host: null, repository: null }]);
  assert.deepEqual(view.rules.manual_claim, { source: MANUAL_CLAIM.source, flags: MANUAL_CLAIM.flags });
  assert.deepEqual([view.rules.commit_types, view.rules.max_header_chars, view.rules.required_headings], [COMMIT_TYPES, 72, MR_REQUIRED_HEADINGS]);

  // CRLF and trailing blanks go as mrMessage takes them; the stored text is the commit message's form.
  const saved = await execution.saveMr('app', 'T-1', { title: EDIT_TITLE, body: `\r\n${EDIT_BODY.replaceAll('\n', '\r\n')}  \r\n\r\n` });
  const text = `${EDIT_TITLE}\n\n${EDIT_BODY}\n`;
  const tip = git(repo, 'rev-parse', BRANCH).trim();
  assert.deepEqual(saved, { state: 'ready_for_human_review', branch: BRANCH, base: 'main', edited: true, prepared_commit: tip });
  assert.deepEqual(await filesOf(world), [text, mrText(TITLE)]);
  assert.notEqual(tip, world.prepared);
  assert.equal(messageOf(repo, BRANCH), `${text}\n`);
  assert.deepEqual([git(repo, 'rev-parse', `${BRANCH}^{tree}`).trim(), git(repo, 'rev-parse', `${BRANCH}~1`).trim(), git(repo, 'log', '-1', '--format=%an <%ae> %aI', BRANCH)], [tree, world.target, author]);
  assert.equal(git(world.worktree, 'rev-parse', 'HEAD').trim(), tip);
  assert.equal((await world.jobs.read('app', 'T-1'))!.prepared_commit, tip);
  assert.deepEqual((await mrEvents(world)).map(({ type, action, branch, base }) => ({ type, action, branch, base })), [{ type: 'mr_edited', action: 'saved', branch: undefined, base: undefined }]);
  view = (await execution.mergeRequestView('app', 'T-1'))!;
  assert.deepEqual([view.title, view.body, view.edited, typeof view.edited_at, view.commit, view.commit_differs], [EDIT_TITLE, EDIT_BODY, true, 'string', { title: EDIT_TITLE, body: EDIT_BODY }, false]);

  // A second save keeps the factory's text as it was.
  await execution.saveMr('app', 'T-1', { title: TITLE, body: EDIT_BODY });
  assert.deepEqual(await filesOf(world), [`${TITLE}\n\n${EDIT_BODY}\n`, mrText(TITLE)]);

  // Reset: the factory's text back as mr.md, the commit message too; mr-factory.md stays.
  const reset = await execution.resetMr('app', 'T-1');
  assert.deepEqual([reset.edited, reset.branch], [false, BRANCH]);
  assert.deepEqual(await filesOf(world), [mrText(TITLE), mrText(TITLE)]);
  assert.equal(messageOf(repo, BRANCH), `${messageText(mrMessage(mrText(TITLE)))}\n`);
  assert.equal(git(repo, 'rev-parse', `${BRANCH}^{tree}`).trim(), tree);
  assert.deepEqual((await mrEvents(world)).map((record) => record.action), ['saved', 'saved', 'reset']);
  view = (await execution.mergeRequestView('app', 'T-1'))!;
  assert.deepEqual([view.edited, view.edited_at, view.commit_differs], [false, null, false]);
  assert.deepEqual(await refusal(execution.resetMr('app', 'T-1')), { code: 'invalid_state', message: "The MR text is already the factory's." });
});

test('SF-080 save: the text passes the factory\'s rules or is refused (mr_text_invalid) and nothing changes; refused outside ready_for_human_review and needs_human after a failed push; runner_active while a request waits', async () => {
  const world = await mrWorld('mr-save-refused');
  const { execution, jobs, repo } = world;
  const body = mrMessage(mrText(TITLE)).body;
  const cases: Array<[MrInput, RegExp]> = [
    [{ title: 'Change the README', body }, /^The MR text is invalid: its first line "Change the README" is not a valid title: it must match/],
    [{ title: `${TITLE}.`, body }, /it ends with a period\.$/],
    [{ title: `feat(T-1): ${'x'.repeat(70)}`, body }, /it has 81 characters, more than 72\.$/],
    [{ title: `${TITLE}\nmore`, body }, /^The MR title must be one line\.$/],
    [{ title: TITLE, body: body.replace('## Why the change\n', '') }, /it lacks the heading\(s\) ## Why the change\.$/],
    [{ title: TITLE, body: body.replace('npm test: passed', '- By hand: opened the page') }, /its ## Testing line "- By hand: opened the page" reads as a check that was run/],
    [{ title: TITLE, body: `${body}\n${'x'.repeat(70 * 1024)}` }, /bytes, more than 65536\.$/],
  ];
  for (const [input, message] of cases) {
    const refused = await refusal(execution.saveMr('app', 'T-1', input));
    assert.equal(refused.code, 'mr_text_invalid');
    assert.match(refused.message, message);
  }
  assert.deepEqual(await filesOf(world), [mrText(TITLE), undefined]);
  assert.equal(git(repo, 'rev-parse', BRANCH).trim(), world.prepared);
  assert.deepEqual(await mrEvents(world), []);

  const input = { title: EDIT_TITLE, body: EDIT_BODY };
  for (const [state, error] of [['working', undefined], ['awaiting_review', undefined], ['preparing_mr', undefined], ['handed_over', undefined], ['pushed', undefined], ['needs_human', { code: 'mr_conflict', message: 'x' }]] as const) {
    await jobs.write({ ...world.job, state, ...(error !== undefined ? { error } : {}) });
    assert.equal((await refusal(execution.saveMr('app', 'T-1', input))).code, 'invalid_state', state);
    assert.equal((await refusal(execution.resetMr('app', 'T-1'))).code, 'invalid_state', state);
  }
  const view = (await execution.mergeRequestView('app', 'T-1'))!;
  // The screen is read-only; the branch and the base follow the job only (not pushed, not handed over, no merge request).
  assert.deepEqual([view.editable, view.readonly_reason, view.branch_editable, view.branch_reason, view.base_editable, view.base_reason], [false, 'The MR text can be edited when the job waits for your review.', true, null, true, null]);
  await jobs.write({ ...world.job, state: 'handed_over' });
  const handed = (await execution.mergeRequestView('app', 'T-1'))!;
  assert.deepEqual([handed.readonly_reason, handed.branch_reason, handed.base_editable], ['The branch is in your checkout. Take it back to edit the MR text.', 'The branch is in your checkout.', false]);

  // A request for the runner waits: runner_active, nothing written.
  await jobs.write({ ...world.job, state: 'needs_human', error: { code: 'mr_push_failed', message: 'git push origin failed' } });
  await enqueue(jobs.dir('app', 'T-1'), { kind: 'say', message: 'one more thing' });
  assert.equal((await refusal(execution.saveMr('app', 'T-1', input))).code, 'runner_active');
  await rm(join(jobs.dir('app', 'T-1'), 'queue'), { recursive: true, force: true });
  assert.deepEqual(await filesOf(world), [mrText(TITLE), undefined]);

  // needs_human after a failed or a refused push takes the save.
  assert.equal((await execution.saveMr('app', 'T-1', input)).edited, true);
  await jobs.write({ ...(await jobs.read('app', 'T-1'))!, error: { code: 'mr_push_protected', message: 'refusing to push' } });
  assert.equal((await execution.resetMr('app', 'T-1')).edited, false);
});

test('SF-080 save: a hand-edited branch tip is branch_changed, a removed worktree invalid_state; nothing written either way', async () => {
  const world = await mrWorld('mr-save-tip');
  const { execution, repo } = world;
  const input = { title: EDIT_TITLE, body: EDIT_BODY };
  const tree = git(repo, 'rev-parse', `${BRANCH}^{tree}`).trim();
  const edited = git(repo, 'commit-tree', tree, '-p', world.prepared, '-m', 'by hand').trim();
  git(world.worktree, 'reset', '-q', '--soft', edited);
  const changed = await refusal(execution.saveMr('app', 'T-1', input));
  assert.equal(changed.code, 'branch_changed');
  assert.match(changed.message, new RegExp(`^The tip of ${BRANCH} is ${edited.slice(0, 12)}, not the prepared ${world.prepared.slice(0, 12)}: it was edited by hand\\.`));
  assert.deepEqual(await filesOf(world), [mrText(TITLE), undefined]);
  git(world.worktree, 'reset', '-q', '--soft', world.prepared);
  git(repo, 'worktree', 'remove', '--force', world.worktree);
  assert.deepEqual(await refusal(execution.saveMr('app', 'T-1', input)), { code: 'invalid_state', message: "The job's worktree is gone; the commit message cannot be changed." });
  assert.deepEqual(await filesOf(world), [mrText(TITLE), undefined]);
  assert.equal(git(repo, 'rev-parse', BRANCH).trim(), world.prepared);
});

test('SF-080 save: the rewrite follows the user\'s commit.gpgSign as Clean does (the signing program is called, the commit is signed) and keeps the author', async () => {
  const world = await mrWorld('mr-save-sign');
  const { execution, repo } = world;
  const log = join(temp, 'mr-save-sign-gpg.log');
  const gpg = join(temp, 'mr-save-sign-gpg.sh');
  await writeFile(gpg, `#!/bin/sh\necho "$@" >> '${log}'\ncat > /dev/null\nprintf '\\n[GNUPG:] SIG_CREATED D 1 8 00 1 X\\n' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nfake\\n-----END PGP SIGNATURE-----\\n'\n`);
  await chmod(gpg, 0o755);
  git(repo, 'config', 'commit.gpgSign', 'true');
  git(repo, 'config', 'gpg.program', gpg);
  const author = git(repo, 'log', '-1', '--format=%an <%ae> %aI', BRANCH);
  await execution.saveMr('app', 'T-1', { title: EDIT_TITLE, body: EDIT_BODY });
  assert.match(await readFile(log, 'utf8'), /-bsau/);
  assert.match(git(repo, 'cat-file', 'commit', BRANCH), /^gpgsig -----BEGIN PGP SIGNATURE-----$/m);
  assert.equal(git(repo, 'log', '-1', '--format=%an <%ae> %aI', BRANCH), author);

  // A signing program that fails: mr_commit_failed, nothing written.
  await writeFile(gpg, '#!/bin/sh\nexit 1\n');
  const before = git(repo, 'rev-parse', BRANCH).trim();
  const failed = await refusal(execution.saveMr('app', 'T-1', { title: TITLE, body: EDIT_BODY }));
  assert.equal(failed.code, 'mr_commit_failed');
  assert.deepEqual([git(repo, 'rev-parse', BRANCH).trim(), (await filesOf(world))[0]], [before, `${EDIT_TITLE}\n\n${EDIT_BODY}\n`]);
});

test('SF-080 rename before the first push: the worktree follows; refused when invalid, protected, taken here or on origin, checked out elsewhere, after the first push, or when origin cannot be asked', async () => {
  const world = await mrWorld('mr-rename');
  const { execution, repo, jobs } = world;
  const body = mrMessage(mrText(TITLE)).body;
  const locked = async (branch: string, message: RegExp): Promise<void> => {
    const refused = await refusal(execution.saveMr('app', 'T-1', { title: TITLE, body, branch }));
    assert.equal(refused.code, 'branch_locked', branch);
    assert.match(refused.message, message);
    assert.equal((await jobs.read('app', 'T-1'))!.branch, BRANCH);
  };
  await locked('bad..name', /^The branch cannot be renamed to bad\.\.name: it is not a valid branch name\.$/);
  await locked('-x', /not a valid branch name/);
  await locked('main', /nothing is pushed to main, master or the base branch \(main\) directly/);
  await locked('master', /nothing is pushed to main/);
  git(repo, 'branch', 'taken', 'main');
  await locked('taken', /a branch of that name exists in the checkout/);
  git(repo, 'push', '-q', 'origin', 'main:refs/heads/on-origin');
  await locked('on-origin', /a branch of that name exists on origin/);
  const other = join(temp, 'mr-rename-other');
  git(repo, 'worktree', 'add', '-q', '-f', other, BRANCH);
  await locked('T-1-other', new RegExp(`${BRANCH} is checked out in .*mr-rename-other\\.$`));
  git(repo, 'worktree', 'remove', '--force', other);
  git(repo, 'remote', 'set-url', 'origin', join(temp, 'no-such-origin.git'));
  await locked('T-1-other', new RegExp(`^Could not check origin for ${BRANCH}: `));
  git(repo, 'remote', 'set-url', 'origin', world.origin);
  assert.equal(git(repo, 'rev-parse', BRANCH).trim(), world.prepared);
  // A rename that fails after the checks (a ref lock held): the reworded commit is put back, nothing written.
  const lock = join(repo, '.git', 'refs', 'heads', 'T-1-locked.lock');
  await writeFile(lock, '');
  const failed = await refusal(execution.saveMr('app', 'T-1', { title: EDIT_TITLE, body: EDIT_BODY, branch: 'T-1-locked' }));
  assert.equal(failed.code, 'branch_locked');
  assert.match(failed.message, /^The branch cannot be renamed to T-1-locked: git branch failed: /);
  await rm(lock);
  assert.deepEqual([git(repo, 'rev-parse', BRANCH).trim(), git(world.worktree, 'rev-parse', 'HEAD').trim(), await filesOf(world), await mrEvents(world)], [world.prepared, world.prepared, [mrText(TITLE), undefined], []]);

  // Allowed: renamed in the checkout, the job's worktree follows, the job and the event record it.
  const saved = await execution.saveMr('app', 'T-1', { title: EDIT_TITLE, body: EDIT_BODY, branch: 'T-1-readers' });
  assert.equal(saved.branch, 'T-1-readers');
  assert.equal(git(repo, 'branch', '--list', BRANCH), '');
  assert.equal(git(world.worktree, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/T-1-readers');
  const job = (await jobs.read('app', 'T-1'))!;
  assert.deepEqual([job.branch, job.prepared_commit], ['T-1-readers', git(repo, 'rev-parse', 'T-1-readers').trim()]);
  assert.deepEqual((await mrEvents(world)).map(({ action, branch }) => [action, branch]), [['saved', 'T-1-readers']]);
  assert.equal(messageOf(repo, 'T-1-readers'), `${EDIT_TITLE}\n\n${EDIT_BODY}\n\n`);

  // Once on origin (a push that failed after reaching it, or one by hand): fixed.
  git(repo, 'push', '-q', 'origin', 'T-1-readers');
  const pushed = await refusal(execution.saveMr('app', 'T-1', { title: EDIT_TITLE, body: EDIT_BODY, branch: 'T-1-again' }));
  assert.deepEqual(pushed, { code: 'branch_locked', message: 'The branch cannot be renamed to T-1-again: T-1-readers is already on origin; it is fixed after the first push.' });
  await jobs.write({ ...job, state: 'pushed' });
  const view = (await execution.mergeRequestView('app', 'T-1'))!;
  assert.deepEqual([view.branch_editable, view.branch_reason, view.base_reason, view.pushed, view.editable], [false, 'Fixed after the first push.', 'Fixed after the first push.', true, false]);
});

test('SF-080 base change: allowed when the new base on origin contains the commit the change was rebased onto; refused otherwise (base_unrelated), nothing changed; never rebased', async () => {
  const world = await mrWorld('mr-base');
  const { execution, repo, jobs } = world;
  const body = mrMessage(mrText(TITLE)).body;
  const unrelated = async (base: string, message: string): Promise<void> => {
    const refused = await refusal(execution.saveMr('app', 'T-1', { title: TITLE, body, base }));
    assert.deepEqual(refused, { code: 'base_unrelated', message }, base);
    assert.equal((await jobs.read('app', 'T-1'))!.base, 'main');
  };
  await unrelated('no-such-base', 'The base no-such-base does not exist on origin.');
  // A branch of origin that does not contain the target: an unrelated history.
  const orphan = git(repo, 'commit-tree', git(repo, 'rev-parse', 'main^{tree}').trim(), '-m', 'unrelated').trim();
  git(repo, 'push', '-q', 'origin', `${orphan}:refs/heads/legacy`);
  await unrelated('legacy', 'The change was prepared on main; restart the job with base legacy instead.');
  await unrelated(BRANCH, `"${BRANCH}" cannot be the base of ${BRANCH}.`);
  assert.deepEqual(await mrEvents(world), []);

  // A base that contains the target (ahead of it): recorded; the commit stays on the target.
  const ahead = git(repo, 'commit-tree', git(repo, 'rev-parse', 'main^{tree}').trim(), '-p', world.target, '-m', 'ahead').trim();
  git(repo, 'push', '-q', 'origin', `${ahead}:refs/heads/release`);
  const saved = await execution.saveMr('app', 'T-1', { title: TITLE, body, base: 'release' });
  assert.deepEqual([saved.base, saved.edited, saved.prepared_commit], ['release', false, world.prepared]);
  assert.equal(git(repo, 'rev-parse', `${BRANCH}~1`).trim(), world.target);
  assert.equal((await jobs.read('app', 'T-1'))!.base, 'release');
  assert.deepEqual((await mrEvents(world)).map(({ action, base }) => [action, base]), [['saved', 'release']]);
});

test('SF-080 base change after a push that failed but reached origin: refused (base_unrelated), nothing changed; an origin that cannot be asked refuses too', async () => {
  const world = await mrWorld('mr-base-pushed', { state: 'needs_human', error: { code: 'mr_push_failed', message: 'git push origin T-1-change-readme failed: the connection was reset' } });
  const { execution, repo, jobs } = world;
  const body = mrMessage(mrText(TITLE)).body;
  const ahead = git(repo, 'commit-tree', git(repo, 'rev-parse', 'main^{tree}').trim(), '-p', world.target, '-m', 'ahead').trim();
  git(repo, 'push', '-q', 'origin', `${ahead}:refs/heads/release`);
  // The remote took the branch before the push failed.
  git(repo, 'push', '-q', 'origin', BRANCH);
  const refused = await refusal(execution.saveMr('app', 'T-1', { title: EDIT_TITLE, body: EDIT_BODY, base: 'release' }));
  assert.deepEqual(refused, { code: 'base_unrelated', message: `The base is fixed after the push; ${BRANCH} is already on origin for main.` });
  assert.deepEqual([(await jobs.read('app', 'T-1'))!.base, git(repo, 'rev-parse', BRANCH).trim(), await filesOf(world), await mrEvents(world)], ['main', world.prepared, [mrText(TITLE), undefined], []]);
  git(repo, 'push', '-q', 'origin', `:refs/heads/${BRANCH}`);
  git(repo, 'remote', 'set-url', 'origin', join(temp, 'no-such-origin.git'));
  const unasked = await refusal(execution.saveMr('app', 'T-1', { title: TITLE, body, base: 'release' }));
  assert.equal(unasked.code, 'branch_locked');
  assert.match(unasked.message, new RegExp(`^Could not check origin for ${BRANCH}: `));
  git(repo, 'remote', 'set-url', 'origin', world.origin);
  // Not on origin: the base changes.
  assert.equal((await execution.saveMr('app', 'T-1', { title: TITLE, body, base: 'release' })).base, 'release');
});

test('SF-080 approve refuses while mr.md fails the rules or is not the prepared commit\'s message; a valid save clears it and the pushed commit carries the saved text', async () => {
  const world = await mrWorld('mr-approve-check');
  const { execution, jobs, repo, origin } = world;
  // The user's text kept at a new Clean that committed the factory's: not the commit's message.
  await jobs.writeMrFactoryText('app', 'T-1', mrText(TITLE));
  await jobs.writeMrText('app', 'T-1', `${EDIT_TITLE}\n\n${EDIT_BODY}\n`);
  const differs = await refusal(execution.approve('app', 'T-1'));
  assert.deepEqual(differs, { code: 'mr_text_invalid', message: `The MR text differs from the message of the prepared commit ${world.prepared.slice(0, 12)}, which the push would carry: save the text or reset it on the Merge request screen.` });
  let view = (await execution.mergeRequestView('app', 'T-1'))!;
  assert.deepEqual([view.commit, view.commit_differs, view.edited], [mrMessage(mrText(TITLE)), true, true]);
  await jobs.writeMrText('app', 'T-1', `${EDIT_TITLE}\n\n## What\nOnly this.\n`);
  const invalid = await refusal(execution.approve('app', 'T-1'));
  assert.equal(invalid.code, 'mr_text_invalid');
  assert.match(invalid.message, /^The MR text is invalid: it lacks the heading\(s\) ## Why, /);
  view = (await execution.mergeRequestView('app', 'T-1'))!;
  assert.deepEqual(view.problems.map((problem) => problem.message), ['## Why', '## How', '## Why the change', '## Special things to note', '## Change outline', '## Testing', '## Checklist'].map((heading) => `Missing heading: ${heading}.`));
  assert.equal(git(origin, 'branch', '--list', BRANCH), '');

  await execution.saveMr('app', 'T-1', { title: EDIT_TITLE, body: EDIT_BODY });
  const pushed = await execution.approve('app', 'T-1');
  assert.deepEqual([pushed.state, pushed.title], ['pushed', EDIT_TITLE]);
  const commit = git(origin, 'cat-file', 'commit', `refs/heads/${BRANCH}`);
  assert.equal(commit.slice(commit.indexOf('\n\n') + 2), (await jobs.readMrText('app', 'T-1'))!);
  view = (await execution.mergeRequestView('app', 'T-1'))!;
  assert.deepEqual([view.pushed, view.editable, view.branch_editable, typeof view.pushed_at], [true, false, false, 'string']);
  assert.match(view.readonly_reason!, /^Pushed at \d\d:\d\d\. The MR text is read-only now\.$/);
  assert.equal(git(repo, 'rev-parse', BRANCH).trim(), (await jobs.read('app', 'T-1'))!.prepared_commit);
});

// The registry with the workspace's own hand-over setting (SF-083), read again at each ready.
const handoff = (env: Env, repo: string, mode: 'checkout' | 'off'): Promise<void> => saveRegistry({ workspaces: { app: { read_checkout: repo, work_checkout: repo, handoff: mode } } }, env.config);

test('SF-080 a new Clean after an edit keeps the user\'s text as mr.md and in the commit (and the hand-over\'s template), the new factory text as mr-factory.md with factory_new; an invalid user text commits the factory\'s and approve refuses; without an edit mr-factory.md goes; a handed-over push of the user\'s own commit is not checked', async () => {
  const env = await newEnv('mr-new-clean');
  const repo = await newRepo(env, 'mr-new-clean-repo', true);
  const origin = join(temp, 'mr-new-clean-repo-origin.git');
  await putTask(env, repo, 'T-1', 'Change README');
  const factory = (n: number): string => mrText(`feat(T-1): Change the README, take ${n}`);
  const turns = [1, 2, 3, 4].flatMap((n) => [
    { write: { 'README.md': `hello ${n}\n` }, text: `iteration ${n}` },
    { write: { '.software-factory/T-1.mr.md': factory(n) }, text: 'MR text' },
  ]);
  await script(env, turns);
  const served = await serve(env);
  const jobs = new JobStore(env.state);
  const branch = 'T-1-change-readme';
  const user = `${EDIT_TITLE}\n\n${EDIT_BODY}\n`;
  const view = async (): Promise<Record<string, any>> => JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1/mr-view', served.dashboard))).body);
  const again = async (iteration: number, state = 'ready_for_human_review'): Promise<void> => {
    await runCli(env, ['say', 'app', 'T-1', 'one', 'more', 'change']);
    await waitFor(served, 'T-1', 'awaiting_review', iteration);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', state, iteration);
  };
  const actions = async (): Promise<unknown[]> => (await readFile(jobs.eventsPath('app', 'T-1'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.type === 'mr_edited').map((record) => record.action);
  try {
    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'ready_for_human_review', 1);
    const saved = await act(served.dashboard!, 'api/jobs/app/T-1/mr-save', { title: EDIT_TITLE, body: EDIT_BODY });
    assert.equal(saved.status, 200, saved.body);

    // Clean 2, handed over: the user's text stays, the commit and the checkout's template carry it.
    await handoff(env, repo, 'checkout');
    await again(2, 'handed_over');
    assert.deepEqual([await jobs.readMrText('app', 'T-1'), await jobs.readMrFactoryText('app', 'T-1')], [user, factory(2)]);
    const job = (await jobs.read('app', 'T-1'))!;
    assert.equal(git(repo, 'log', '-1', '--format=%B', job.handover!.saved), `${user}\n`);
    assert.equal(await readFile(await commitMessagePath(repo, 'T-1'), 'utf8'), `${EDIT_TITLE}\n\n${EDIT_BODY}`);
    assert.deepEqual(await actions(), ['saved', 'factory_new']);
    let shown = await view();
    assert.deepEqual([shown.edited, typeof shown.factory_new_at, shown.factory.title, shown.commit_differs, shown.editable], [true, 'string', 'feat(T-1): Change the README, take 2', false, false]);
    assert.match(describeEvent(JSON.stringify({ ts: 'x', iteration: 2, type: 'mr_edited', action: 'factory_new' }))!.lines[0]!, /Clean wrote a new MR text; yours is kept\. Compare or reset on the Merge request screen\.$/);
    const back = await runCli(env, ['takeback', 'app', 'T-1']);
    assert.equal(back.code, 0, back.stderr);
    await handoff(env, repo, 'off');

    // Clean 3 with a user text that fails the rules (written by hand): the factory's text is committed, mr.md kept; approve refuses.
    const invalid = `${EDIT_TITLE}\n\n## What\nOnly this.\n`;
    await jobs.writeMrText('app', 'T-1', invalid);
    await again(3);
    assert.deepEqual([await jobs.readMrText('app', 'T-1'), await jobs.readMrFactoryText('app', 'T-1')], [invalid, factory(3)]);
    assert.equal(git(repo, 'log', '-1', '--format=%B', branch), `${messageText(mrMessage(factory(3)))}\n`);
    shown = await view();
    assert.deepEqual([shown.commit_differs, shown.commit.title, shown.problems.length > 0, shown.editable], [true, 'feat(T-1): Change the README, take 3', true, true]);
    const refused = await approveCli(env);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^sf: The MR text is invalid: it lacks the heading\(s\) ## Why, /m);

    // Reset, then Clean 4 without an edit: mr.md is the factory's, mr-factory.md goes, edited is false.
    const reset = await act(served.dashboard!, 'api/jobs/app/T-1/mr-reset', {});
    assert.equal(reset.status, 200, reset.body);
    await handoff(env, repo, 'checkout');
    await again(4, 'handed_over');
    assert.deepEqual([await jobs.readMrText('app', 'T-1'), await jobs.readMrFactoryText('app', 'T-1')], [factory(4), undefined]);
    shown = await view();
    assert.deepEqual([shown.edited, shown.factory_new_at, shown.editable, shown.readonly_reason], [false, null, false, 'The branch is in your checkout. Take it back to edit the MR text.']);
    assert.deepEqual(await actions(), ['saved', 'factory_new', 'factory_new', 'reset']);

    // The user commits in the checkout and approves: their own commit is pushed, the MR text not checked against it.
    await jobs.writeMrText('app', 'T-1', invalid);
    git(repo, 'commit', '-q', '-a', '-m', 'feat(T-1): my own commit');
    const pushed = await approveCli(env);
    assert.equal(pushed.code, 0, pushed.stderr);
    assert.equal(git(origin, 'log', '-1', '--format=%s', branch).trim(), 'feat(T-1): my own commit');
    assert.equal((await jobs.read('app', 'T-1'))!.state, 'pushed');
  } finally {
    await stop(served);
  }
});

const approveCli = (env: Env): Promise<{ code: number | null; stdout: string; stderr: string }> => runCli(env, ['approve', 'app', 'T-1']);
