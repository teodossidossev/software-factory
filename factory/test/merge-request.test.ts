// The merge request from the factory (SF-048) end to end through `sf serve`, the CLI and the
// dashboard's routes, against the fake GitHub and GitLab of test/support/fake-forge.ts: sf mr create
// from ready_for_human_review (approve, then open) and from pushed (new and reused), sf mr merge,
// sf mr status, not mergeable with the host's reason, a missing token, a wrong host, a 401, and
// the token in the Authorization header only, never in a job file or a log line.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACTIONS } from '../src/dashboard.js';
import { FactoryError } from '../src/errors.js';
import { type Job, JobStore } from '../src/jobs.js';
import { mrMessage } from '../src/mr.js';
import { jobNotification } from '../src/notify.js';
import { describeEvent } from '../src/watch.js';
import { act, fakeActions, fetchRaw, openStream } from './support/dashboard-client.js';
import { withDashboard } from './support/dashboard-state.js';
import { FAKE_MERGE_SHA, startFakeForge } from './support/fake-forge.js';
import { call, type Env, git, newEnv, newRepo, putTask, runCli, script, serve, stop, temp, waitFor } from './support/harness.js';

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
    prepared_commit: 'a'.repeat(40), mr_attempts: 1, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'pushed', iteration: 1, session_id: null,
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
    assert.match(wrong.stderr, /^sf: Merge requests are off for this workspace: bitbucket\.org is neither GitHub nor GitLab\.$/m);
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
    assert.ok(['mr-create', 'mr-merge', 'mr-status'].every((action) => ACTIONS.includes(action as never)));
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
    mr_attempts: 1, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: 'pushed', iteration: 1, session_id: null, created_at: '2026-11-04T10:00:00.000Z',
    updated_at: '2026-11-04T10:00:00.000Z', mr: { host: 'github', number: 7, url: 'https://github.com/acme/app/pull/7', state: 'open' },
  };
  assert.deepEqual(jobNotification(job, [TITLE, 'Merge request #7: https://github.com/acme/app/pull/7']), {
    title: 'T-1: merge request #7 opened', body: `branch: T-1-x\n${TITLE}\nMerge request #7: https://github.com/acme/app/pull/7`, priority: 'default', tags: 'white_check_mark',
  });
  assert.equal(jobNotification({ ...job, mr: { ...job.mr!, state: 'merged' } }).title, 'T-1: merge request #7 merged');
  assert.equal(jobNotification({ ...job, mr: null }).title, 'T-1: pushed');
});
