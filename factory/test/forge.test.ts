// The Git host's merge requests (src/forge.ts, SF-048) against a fake GitHub and a fake GitLab on
// loopback: the host chosen from the origin URL, the settings, create (new and reused), status,
// merge, not mergeable with the host's reason, a 401, and the token in the Authorization header only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { chooseForge, forgeFor, forgeSettings, withoutHostTokens } from '../src/forge.js';
import { FAKE_MERGE_SHA, startFakeForge } from './support/fake-forge.js';

const GH_TOKEN = 'github_pat_TESTTOKEN0123456789abcdef';
const GL_TOKEN = 'glpat-TESTTOKEN0123456789';

async function refusal(work: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof FactoryError, String(error));
    return { code: error.code, message: error.message };
  }
  assert.fail('expected a refusal');
}

test('forge settings: the tokens, SF_GITHUB_API on loopback only, SF_GITLAB_URL as an http(s) URL', () => {
  assert.deepEqual(forgeSettings({}), { githubToken: undefined, githubApi: 'https://api.github.com', gitlabToken: undefined, gitlabUrl: undefined });
  assert.deepEqual(forgeSettings({ SF_GITHUB_TOKEN: 'a', SF_GITHUB_API: 'http://127.0.0.1:9/', SF_GITLAB_TOKEN: 'b', SF_GITLAB_URL: 'https://git.corp:8443/gitlab/api/v4/' }), {
    githubToken: 'a', githubApi: 'http://127.0.0.1:9', gitlabToken: 'b', gitlabUrl: 'https://git.corp:8443/gitlab/api/v4',
  });
  assert.throws(() => forgeSettings({ SF_GITHUB_API: 'https://evil.example/api' }), /SF_GITHUB_API is for tests only/);
  assert.throws(() => forgeSettings({ SF_GITLAB_URL: 'ftp://git.corp/api/v4' }), /SF_GITLAB_URL must be an http\(s\) URL/);
  assert.throws(() => forgeSettings({ SF_GITLAB_URL: 'https://user:pw@git.corp/api/v4' }), /without credentials/);
  // A refused URL is never echoed with its credentials, query or fragment.
  const refusedMessage = (env: NodeJS.ProcessEnv): string => {
    try {
      forgeSettings(env);
    } catch (error) {
      return (error as Error).message;
    }
    assert.fail('expected a refusal');
  };
  const withCredentials = refusedMessage({ SF_GITLAB_URL: 'https://user:hunter2secret@git.example/api/v4?private_token=qsecret#fsecret' });
  assert.equal(withCredentials, 'SF_GITLAB_URL must be an http(s) URL without credentials, query or fragment, got "https://[redacted]@git.example/api/v4?[redacted]#[redacted]".');
  assert.doesNotMatch(refusedMessage({ SF_GITHUB_API: 'http://bob:hunter2secret@127.0.0.1:9/' }), /hunter2secret|bob/);
  assert.equal(refusedMessage({ SF_GITLAB_URL: 'http://git.example/api/v4' }), 'SF_GITLAB_URL must use https; http is allowed on loopback only (127.0.0.1, localhost or [::1]), got "http://git.example/api/v4".');
  assert.equal(refusedMessage({ SF_GITLAB_URL: 'not a url user:pw@' }), 'SF_GITLAB_URL must be an http(s) URL without credentials, query or fragment, got a value that is not a URL.');
  // The GitLab token never travels in cleartext: http only on loopback (the tests' fake GitLab).
  assert.throws(() => forgeSettings({ SF_GITLAB_URL: 'http://git.corp/api/v4' }), /SF_GITLAB_URL must use https; http is allowed on loopback only/);
  for (const loopback of ['http://127.0.0.1:9/api/v4', 'http://localhost:9/api/v4', 'http://[::1]:9/api/v4']) {
    assert.equal(forgeSettings({ SF_GITLAB_URL: loopback }).gitlabUrl, loopback);
  }
});

test('child processes get the environment without the Git hosts\' tokens', () => {
  assert.deepEqual(withoutHostTokens({ PATH: '/bin', SF_GITHUB_TOKEN: 'a', SF_GITLAB_TOKEN: 'b', SF_GITLAB_URL: 'https://git.corp/api/v4' }), { PATH: '/bin', SF_GITLAB_URL: 'https://git.corp/api/v4' });
});

test('forge choice: GitHub for github.com, GitLab for other hosts; the missing variable named; a wrong host refused without its token', () => {
  const none = forgeSettings({});
  const both = forgeSettings({ SF_GITHUB_TOKEN: 'a', SF_GITLAB_TOKEN: 'b' });
  assert.deepEqual(chooseForge('git@github.com:acme/app.git', none), {
    ok: false, kind: 'github', code: 'mr_token_missing', reason: 'SF_GITHUB_TOKEN is not set in the environment file', missing: 'SF_GITHUB_TOKEN',
  });
  assert.deepEqual(chooseForge('https://gitlab.example.com/group/sub/app.git', none), {
    ok: false, kind: 'gitlab', code: 'mr_token_missing', reason: 'SF_GITLAB_TOKEN is not set in the environment file', missing: 'SF_GITLAB_TOKEN',
  });
  const github = chooseForge('https://github.com/acme/app.git', both);
  assert.deepEqual(github, { ok: true, kind: 'github', host: 'github.com', path: 'acme/app', api: 'https://api.github.com', token: 'a', tokenName: 'SF_GITHUB_TOKEN' });
  const gitlab = chooseForge('ssh://git@gitlab.example.com:2222/group/sub/app.git', both);
  assert.deepEqual(gitlab, { ok: true, kind: 'gitlab', host: 'gitlab.example.com', path: 'group/sub/app', api: 'https://gitlab.example.com/api/v4', token: 'b', tokenName: 'SF_GITLAB_TOKEN' });
  // SF_GITLAB_URL is the API of its own host only.
  const configured = forgeSettings({ SF_GITLAB_TOKEN: 'b', SF_GITLAB_URL: 'https://git.corp:8443/api/v4' });
  assert.equal((chooseForge('git@git.corp:group/app.git', configured) as { api: string }).api, 'https://git.corp:8443/api/v4');
  const elsewhere = chooseForge('https://gitlab.com/group/app.git', configured);
  assert.equal(elsewhere.ok, false);
  assert.match((elsewhere as { reason: string }).reason, /the origin is on gitlab\.com, but SF_GITLAB_URL is for git\.corp; the GitLab token is not sent to another host/);
  for (const origin of [undefined, '/srv/repos/app.git', 'https://github.com/acme', 'https://github.com/acme/app/extra', 'https://bitbucket.org/acme/app.git']) {
    const choice = chooseForge(origin, both);
    assert.deepEqual([choice.ok, (choice as { code: string }).code], [false, 'mr_host_unsupported'], String(origin));
  }
  const refused = (() => {
    try {
      forgeFor('git@github.com:acme/app.git', none);
    } catch (error) {
      return error as FactoryError;
    }
    return undefined;
  })();
  assert.deepEqual([refused?.code, refused?.message], ['mr_token_missing', 'Merge requests are off for this workspace: SF_GITHUB_TOKEN is not set in the environment file.']);
});

test('GitHub: create opens a pull request with the title and body, then reuses it; status, checks; merge as a merge commit with the host\'s title; the token only in Authorization', async () => {
  const fake = await startFakeForge('github', 'acme/app');
  try {
    const forge = forgeFor('git@github.com:acme/app.git', forgeSettings({ SF_GITHUB_TOKEN: GH_TOKEN, SF_GITHUB_API: fake.url }));
    assert.equal(forge.kind, 'github');
    const input = { branch: 'T-1-demo', base: 'main', title: 'feat(T-1): Demo', body: '## What\nA demo.\n' };
    const created = await forge.open(input);
    assert.deepEqual(created, { number: 1, url: 'https://github.com/acme/app/pull/1', state: 'open', reused: false });
    assert.deepEqual(fake.requests.map((r) => `${r.method} ${r.path}`), [
      'GET /repos/acme/app/pulls?state=open&head=acme%3AT-1-demo&base=main',
      'POST /repos/acme/app/pulls',
    ]);
    assert.deepEqual(fake.requests[1]!.body, { title: 'feat(T-1): Demo', head: 'T-1-demo', base: 'main', body: '## What\nA demo.\n' });
    // Already open: reused, no second pull request.
    assert.deepEqual(await forge.open(input), { ...created, reused: true });
    assert.equal(fake.mrs.length, 1);

    fake.checkRuns.push({ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null });
    assert.deepEqual(await forge.status(1), { number: 1, url: 'https://github.com/acme/app/pull/1', state: 'open', draft: false, mergeable: true, checks: '2 passed, 1 running' });

    assert.deepEqual(await forge.merge(1), { merge_commit: FAKE_MERGE_SHA });
    const merge = fake.requests.find((r) => r.method === 'PUT')!;
    assert.equal(merge.path, '/repos/acme/app/pulls/1/merge');
    // Merge method merge; the commit title is left to GitHub.
    assert.deepEqual(merge.body, { merge_method: 'merge' });
    assert.deepEqual(await forge.status(1), { number: 1, url: 'https://github.com/acme/app/pull/1', state: 'merged', draft: false, mergeable: false, reason: 'it is merged', merge_commit: FAKE_MERGE_SHA });
    assert.deepEqual(await refusal(forge.merge(1)), { code: 'mr_not_open', message: 'Pull request #1 is merged on GitHub; nothing was merged.' });

    for (const request of fake.requests) {
      assert.equal(request.headers.authorization, `Bearer ${GH_TOKEN}`);
      assert.equal(request.headers.accept, 'application/vnd.github+json');
      assert.equal(request.headers['user-agent'], 'software-factory');
      const { authorization: _auth, ...others } = request.headers;
      assert.doesNotMatch(JSON.stringify([request.path, request.body, others]), /TESTTOKEN/);
    }
  } finally {
    await fake.close();
  }
});

test('GitHub: not mergeable (conflicts, a draft, failing required checks) is refused with the reason; a 401 names the variable without the token; other refusals keep the host\'s words', async () => {
  const fake = await startFakeForge('github', 'acme/app');
  try {
    const forge = forgeFor('https://github.com/acme/app', forgeSettings({ SF_GITHUB_TOKEN: GH_TOKEN, SF_GITHUB_API: fake.url }));
    await forge.open({ branch: 'T-1-demo', base: 'main', title: 't', body: '' });
    const mr = fake.mrs[0]!;
    mr.mergeable = false;
    mr.mergeableState = 'dirty';
    assert.deepEqual(await refusal(forge.merge(1)), { code: 'mr_not_mergeable', message: 'GitHub cannot merge pull request #1: it has conflicts with main.' });
    mr.mergeable = true;
    mr.mergeableState = 'draft';
    mr.draft = true;
    assert.deepEqual(await refusal(forge.merge(1)), { code: 'mr_not_mergeable', message: 'GitHub cannot merge pull request #1: it is a draft.' });
    mr.draft = false;
    mr.mergeableState = 'blocked';
    assert.deepEqual(await refusal(forge.merge(1)), {
      code: 'mr_not_mergeable',
      message: 'GitHub refused to merge pull request #1: Required status check "test" is failing. (it is blocked: required checks or reviews have not passed).',
    });
    assert.equal(fake.mrs[0]!.state, 'open');

    fake.fail.push({ match: /^GET /, status: 401, body: { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' } });
    const unauthorized = await refusal(forge.status(1));
    assert.deepEqual(unauthorized, { code: 'mr_auth_failed', message: 'GitHub refused the token in SF_GITHUB_TOKEN (401: Bad credentials). Check the token and its permissions.' });
    fake.fail.push({ match: /^POST /, status: 422, body: { message: 'Validation Failed', errors: [{ message: `No commits between main and T-2 ${GH_TOKEN}` }] } });
    const invalid = await refusal(forge.open({ branch: 'T-2', base: 'main', title: 't', body: '' }));
    assert.deepEqual(invalid, { code: 'mr_host_error', message: 'GitHub refused to open the pull request: HTTP 422: Validation Failed; No commits between main and T-2 [redacted].' });
    fake.fail.push({ match: /^GET /, status: 404, body: { message: 'Not Found' } });
    assert.match((await refusal(forge.status(1))).message, /HTTP 404: Not Found \(does SF_GITHUB_TOKEN have access to the repository\?\)/);
    fake.fail.push({ match: /^GET /, status: 302, body: {} });
    assert.equal((await refusal(forge.status(1))).code, 'mr_host_error');
  } finally {
    await fake.close();
  }
  // Nobody answers.
  const gone = forgeFor('https://github.com/acme/app', forgeSettings({ SF_GITHUB_TOKEN: GH_TOKEN, SF_GITHUB_API: fake.url }));
  const unreachable = await refusal(gone.status(1));
  assert.equal(unreachable.code, 'mr_host_unreachable');
  assert.doesNotMatch(unreachable.message, /TESTTOKEN/);
});

test('GitLab: create (new and reused) with the description, status with the pipeline, merge through PUT .../merge; not mergeable with the reason; a 401', async () => {
  const fake = await startFakeForge('gitlab', 'group/sub/app');
  try {
    const origin = `${fake.url}/group/sub/app.git`;
    const forge = forgeFor(origin, forgeSettings({ SF_GITLAB_TOKEN: GL_TOKEN, SF_GITLAB_URL: `${fake.url}/api/v4` }));
    assert.deepEqual([forge.kind, forge.name], ['gitlab', 'GitLab 127.0.0.1']);
    const input = { branch: 'T-1-demo', base: 'develop', title: 'feat(T-1): Demo', body: 'Body.' };
    const created = await forge.open(input);
    assert.deepEqual(created, { number: 1, url: `${fake.url}/group/sub/app/-/merge_requests/1`, state: 'open', reused: false });
    assert.deepEqual(fake.requests.map((r) => `${r.method} ${r.path}`), [
      'GET /api/v4/projects/group%2Fsub%2Fapp/merge_requests?state=opened&source_branch=T-1-demo&target_branch=develop',
      'POST /api/v4/projects/group%2Fsub%2Fapp/merge_requests',
    ]);
    assert.deepEqual(fake.requests[1]!.body, { source_branch: 'T-1-demo', target_branch: 'develop', title: 'feat(T-1): Demo', description: 'Body.' });
    assert.deepEqual(await forge.open(input), { ...created, reused: true });
    assert.equal(fake.mrs.length, 1);
    assert.deepEqual(await forge.status(1), { number: 1, url: created.url, state: 'open', draft: false, mergeable: true, checks: 'pipeline success' });

    fake.mrs[0]!.detailed = 'conflict';
    assert.deepEqual(await refusal(forge.merge(1)), { code: 'mr_not_mergeable', message: 'GitLab cannot merge merge request !1: it has conflicts with the target branch.' });
    fake.mrs[0]!.detailed = 'ci_must_pass';
    assert.deepEqual((await forge.status(1)).reason, 'its pipeline must succeed first');
    fake.mrs[0]!.detailed = 'checking';
    assert.equal((await forge.status(1)).mergeable, null);
    // GitLab still checking: the merge is tried and the host's refusal shown.
    assert.deepEqual(await refusal(forge.merge(1)), { code: 'mr_not_mergeable', message: 'GitLab refused to merge merge request !1: Branch cannot be merged.' });
    fake.mrs[0]!.detailed = 'mergeable';
    assert.deepEqual(await forge.merge(1), { merge_commit: FAKE_MERGE_SHA });
    assert.ok(fake.requests.some((r) => r.method === 'PUT' && r.path === '/api/v4/projects/group%2Fsub%2Fapp/merge_requests/1/merge'));
    assert.deepEqual((await forge.status(1)).merge_commit, FAKE_MERGE_SHA);

    fake.fail.push({ match: /^GET /, status: 401, body: { message: '401 Unauthorized' } });
    assert.deepEqual(await refusal(forge.status(1)), { code: 'mr_auth_failed', message: 'GitLab 127.0.0.1 refused the token in SF_GITLAB_TOKEN (401: 401 Unauthorized). Check the token and its permissions.' });
    for (const request of fake.requests) {
      assert.equal(request.headers.authorization, `Bearer ${GL_TOKEN}`);
      assert.equal(request.headers['private-token'], undefined);
      const { authorization: _auth, ...others } = request.headers;
      assert.doesNotMatch(JSON.stringify([request.path, request.body, others]), /TESTTOKEN/);
    }
  } finally {
    await fake.close();
  }
});
