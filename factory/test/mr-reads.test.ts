// The reads of a workspace's merge requests through `sf serve`: sf mr list and sf mr comments, and
// the dashboard's GET api/workspaces/<ws>/merge-requests and .../merge-requests/<number>/threads,
// against the fake GitLab of test/support/fake-forge.ts; then the routes' dispatch and refusals
// with fake actions. Nothing but GETs reaches the host, and no comment body reaches the log.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { act, fakeActions, fetchRaw } from './support/dashboard-client.js';
import { withDashboard } from './support/dashboard-state.js';
import { startFakeForge } from './support/fake-forge.js';
import { git, newEnv, newRepo, runCli, serve, stop } from './support/harness.js';

const GL_TOKEN = 'fake-gitlab-token-READSSECRET';
const BODY = 'Please rename SECRETBODY here.';

test('sf mr list and sf mr comments print the host\'s merge requests and threads; the API routes answer the same objects as JSON; GET only, bodies never logged', async () => {
  const fake = await startFakeForge('gitlab', 'group/app');
  const env = await newEnv('mr-reads');
  await mkdir(env.config, { recursive: true });
  await writeFile(join(env.config, 'auth.env'), `SF_GITLAB_TOKEN=${GL_TOKEN}\nSF_GITLAB_URL=${fake.url}/api/v4\n`);
  const repo = await newRepo(env, 'mr-reads-repo', false);
  git(repo, 'remote', 'add', 'origin', `${fake.url}/group/app.git`);
  fake.lists['/api/v4/projects/group%2Fapp/merge_requests'] = [
    { iid: 4, title: 'Add the export', author: { username: 'alice' }, source_branch: 'feature/export', target_branch: 'main', web_url: `${fake.url}/group/app/-/merge_requests/4`, updated_at: '2026-11-09T10:00:00Z', draft: false },
    { iid: 2, title: 'Fix the login', author: { username: 'bob' }, source_branch: 'fix-login', target_branch: 'develop', web_url: `${fake.url}/group/app/-/merge_requests/2`, updated_at: '2026-11-08T10:00:00Z', draft: true },
  ];
  fake.lists['/api/v4/projects/group%2Fapp/merge_requests/4/discussions'] = [
    { id: 'd1', individual_note: true, notes: [{ id: 1, body: 'Looks good.', author: { username: 'carol' }, created_at: '2026-11-09T09:00:00Z', system: false }] },
    {
      id: 'd2', individual_note: false, notes: [
        { id: 2, body: BODY, author: { username: 'carol' }, created_at: '2026-11-09T09:05:00Z', system: false, resolvable: true, resolved: false, position: { new_path: 'src/export.ts', new_line: 12 } },
        { id: 3, body: 'Done,\nrenamed.', author: { username: 'alice' }, created_at: '2026-11-09T09:10:00Z', system: false, resolvable: true, resolved: false },
      ],
    },
    { id: 'd3', individual_note: true, notes: [{ id: 4, body: 'changed this line', author: { username: 'alice' }, created_at: '2026-11-09T09:20:00Z', system: true }] },
  ];
  const served = await serve(env);
  let log = served.output;
  served.child.stdout!.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
  served.child.stderr!.on('data', (chunk: Buffer) => (log += chunk.toString('utf8')));
  try {
    const list = await runCli(env, ['mr', 'list', 'app']);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(list.stdout, '!4  feature/export → main  alice  Add the export\n!2  fix-login → develop  bob  Fix the login\n');

    const comments = await runCli(env, ['mr', 'comments', 'app', '4']);
    assert.equal(comments.code, 0, comments.stderr);
    assert.equal(comments.stdout, [
      'general',
      '  carol  2026-11-09T09:00:00Z',
      '    Looks good.',
      '',
      'src/export.ts:12  open',
      '  carol  2026-11-09T09:05:00Z',
      `    ${BODY}`,
      '  alice  2026-11-09T09:10:00Z',
      '    Done,',
      '    renamed.',
      '',
    ].join('\n'));

    const requests = JSON.parse((await fetchRaw(new URL('api/workspaces/app/merge-requests', served.dashboard))).body);
    assert.deepEqual(requests, [
      { number: 4, title: 'Add the export', author: 'alice', source: 'feature/export', target: 'main', url: `${fake.url}/group/app/-/merge_requests/4`, updated_at: '2026-11-09T10:00:00Z', draft: false },
      { number: 2, title: 'Fix the login', author: 'bob', source: 'fix-login', target: 'develop', url: `${fake.url}/group/app/-/merge_requests/2`, updated_at: '2026-11-08T10:00:00Z', draft: true },
    ]);
    const threads = await fetchRaw(new URL('api/workspaces/app/merge-requests/4/threads', served.dashboard));
    assert.equal(threads.status, 200, threads.body);
    assert.deepEqual(JSON.parse(threads.body), [
      { id: 'd1', resolved: null, path: null, line: null, comments: [{ author: 'carol', body: 'Looks good.', created_at: '2026-11-09T09:00:00Z' }] },
      {
        id: 'd2', resolved: false, path: 'src/export.ts', line: 12, comments: [
          { author: 'carol', body: BODY, created_at: '2026-11-09T09:05:00Z' }, { author: 'alice', body: 'Done,\nrenamed.', created_at: '2026-11-09T09:10:00Z' },
        ],
      },
    ]);

    // Merge request 0 is no number: refused before the host is asked.
    const zero = await runCli(env, ['mr', 'comments', 'app', '0']);
    assert.equal(zero.code, 1);
    assert.match(zero.stderr, /The merge request number must be a whole number from 1\./);

    // The host's refusal: exit 1 with the forge's message, the same code and status on the route.
    fake.fail.push({ match: /^GET /, status: 404, body: { message: '404 Project Not Found' } });
    const refused = await runCli(env, ['mr', 'list', 'app']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /GitLab 127\.0\.0\.1 refused to list the merge requests: HTTP 404: 404 Project Not Found/);
    fake.fail.push({ match: /^GET /, status: 401, body: { message: '401 Unauthorized' } });
    const unauthorized = await fetchRaw(new URL('api/workspaces/app/merge-requests/4/threads', served.dashboard));
    assert.equal(unauthorized.status, 502);
    assert.equal(JSON.parse(unauthorized.body).error.code, 'mr_auth_failed');

    assert.ok(fake.requests.length >= 6);
    assert.ok(fake.requests.every((r) => r.method === 'GET' && r.headers.authorization === `Bearer ${GL_TOKEN}`));
    assert.doesNotMatch(log, /SECRETBODY|READSSECRET/);
  } finally {
    await stop(served);
    await fake.close();
  }
});

test('the merge request read routes: the workspace and the number passed to the Execution; a bad name or number, a query, a missing workspace an empty 404; a refusal with its status', async () => {
  const fake = fakeActions([]);
  await withDashboard('dash-mr-reads', fake, async (dashboard) => {
    const get = (path: string) => fetchRaw(new URL(path, dashboard.url));
    fake.answer = [{ number: 1 }];
    assert.deepEqual(JSON.parse((await get('api/workspaces/app/merge-requests')).body), [{ number: 1 }]);
    fake.answer = [{ id: 't' }];
    assert.deepEqual(JSON.parse((await get('api/workspaces/app/merge-requests/12/threads')).body), [{ id: 't' }]);
    assert.deepEqual(fake.calls, [['openMergeRequests', 'app'], ['mergeRequestThreads', 'app', 12]]);
    for (const path of ['api/workspaces/bad%20name/merge-requests', 'api/workspaces/app/merge-requests/0/threads', 'api/workspaces/app/merge-requests/x/threads', 'api/workspaces/app/merge-requests?x=1']) {
      const reply = await get(path);
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
    }
    // Read only: a POST is 405 with Allow: GET.
    for (const path of ['api/workspaces/app/merge-requests', 'api/workspaces/app/merge-requests/12/threads']) {
      assert.equal((await act(dashboard.url, path, {})).status, 405, path);
    }
    assert.equal(fake.calls.length, 2);
    fake.answer = new FactoryError('workspace_not_found', 'Workspace "gone" is not registered.');
    assert.deepEqual([(await get('api/workspaces/gone/merge-requests')).status], [404]);
    fake.answer = new FactoryError('mr_token_missing', 'Merge requests are off for this workspace: SF_GITLAB_TOKEN is not set in the environment file.');
    const off = await get('api/workspaces/app/merge-requests');
    assert.deepEqual([off.status, JSON.parse(off.body).error.code], [409, 'mr_token_missing']);
  });
});
