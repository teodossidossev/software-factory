// The Git host's merge requests (src/forge.ts, SF-048) against a fake GitHub and a fake GitLab on
// loopback: the host chosen from the origin URL, the settings, create (new and reused), status,
// merge, not mergeable with the host's reason, a 401, and the token in the Authorization header only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { chooseForge, forgeFor, forgeSettings, withoutHostTokens } from '../src/forge.js';
import { FAKE_MERGE_SHA, type FakeMr, startFakeForge } from './support/fake-forge.js';

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

test('forge choice: GitHub for github.com, GitLab for gitlab.com or the host of SF_GITLAB_URL only; the missing variable named; another host refused without its token', () => {
  const none = forgeSettings({});
  const both = forgeSettings({ SF_GITHUB_TOKEN: 'a', SF_GITLAB_TOKEN: 'b' });
  assert.deepEqual(chooseForge('git@github.com:acme/app.git', none), {
    ok: false, kind: 'github', code: 'mr_token_missing', reason: 'SF_GITHUB_TOKEN is not set in the environment file', missing: 'SF_GITHUB_TOKEN',
  });
  assert.deepEqual(chooseForge('https://gitlab.com/group/sub/app.git', none), {
    ok: false, kind: 'gitlab', code: 'mr_token_missing', reason: 'SF_GITLAB_TOKEN is not set in the environment file', missing: 'SF_GITLAB_TOKEN',
  });
  const github = chooseForge('https://github.com/acme/app.git', both);
  assert.deepEqual(github, { ok: true, kind: 'github', host: 'github.com', path: 'acme/app', api: 'https://api.github.com', token: 'a', tokenName: 'SF_GITHUB_TOKEN' });
  // gitlab.com without SF_GITLAB_URL: GitLab at https://gitlab.com/api/v4.
  assert.deepEqual(chooseForge('git@gitlab.com:group/sub/app.git', both), {
    ok: true, kind: 'gitlab', host: 'gitlab.com', path: 'group/sub/app', api: 'https://gitlab.com/api/v4', token: 'b', tokenName: 'SF_GITLAB_TOKEN',
  });
  // A self-hosted GitLab: GitLab when SF_GITLAB_URL names its host.
  const named = forgeSettings({ SF_GITHUB_TOKEN: 'a', SF_GITLAB_TOKEN: 'b', SF_GITLAB_URL: 'https://gitlab.example.com/api/v4' });
  assert.deepEqual(chooseForge('https://gitlab.example.com/group/sub/app.git', forgeSettings({ SF_GITLAB_URL: 'https://gitlab.example.com/api/v4' })), {
    ok: false, kind: 'gitlab', code: 'mr_token_missing', reason: 'SF_GITLAB_TOKEN is not set in the environment file', missing: 'SF_GITLAB_TOKEN',
  });
  assert.deepEqual(chooseForge('ssh://git@gitlab.example.com:2222/group/sub/app.git', named), {
    ok: true, kind: 'gitlab', host: 'gitlab.example.com', path: 'group/sub/app', api: 'https://gitlab.example.com/api/v4', token: 'b', tokenName: 'SF_GITLAB_TOKEN',
  });
  // The same hosts without SF_GITLAB_URL, and any other host that is not GitHub (GitHub
  // Enterprise, Gitea, sourcehut, Bitbucket): refused with what to set, and no token.
  const unnamed = (hostname: string) => ({
    ok: false, kind: null, code: 'mr_host_unsupported',
    reason: `${hostname} is not GitHub or gitlab.com; if it is a GitLab, set SF_GITLAB_URL to its API (https://${hostname}/api/v4)`,
  });
  for (const [origin, hostname] of [
    ['https://gitlab.example.com/group/sub/app.git', 'gitlab.example.com'],
    ['ssh://git@gitlab.example.com:2222/group/sub/app.git', 'gitlab.example.com'],
    ['https://gitlab.example.com:8443/group/sub/app.git', 'gitlab.example.com'],
    ['git@github.example.com:acme/app.git', 'github.example.com'],
    ['https://gitea.example.org/acme/app.git', 'gitea.example.org'],
    ['https://git.sr.ht/~acme/app', 'git.sr.ht'],
    ['https://bitbucket.org/acme/app.git', 'bitbucket.org'],
  ] as const) {
    assert.deepEqual(chooseForge(origin, both), unnamed(hostname), origin);
  }
  // SF_GITLAB_URL is the API of its own host only.
  const configured = forgeSettings({ SF_GITLAB_TOKEN: 'b', SF_GITLAB_URL: 'https://git.corp:8443/api/v4' });
  assert.equal((chooseForge('git@git.corp:group/app.git', configured) as { api: string }).api, 'https://git.corp:8443/api/v4');
  for (const origin of ['https://gitlab.com/group/app.git', 'https://gitlab.example.com/group/app.git']) {
    const elsewhere = chooseForge(origin, configured);
    const hostname = new URL(origin).hostname;
    assert.deepEqual(elsewhere, {
      ok: false, kind: 'gitlab', code: 'mr_host_unsupported',
      reason: `the origin is on ${hostname}, but SF_GITLAB_URL is for git.corp; the GitLab token is not sent to another host`,
    }, origin);
  }
  for (const origin of [undefined, '/srv/repos/app.git', 'https://github.com/acme', 'https://github.com/acme/app/extra']) {
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
      'GET /repos/acme/app/pulls?state=open&head=acme%3AT-1-demo&base=main&sort=created&direction=desc&per_page=100&page=1',
      'POST /repos/acme/app/pulls',
    ]);
    assert.deepEqual(fake.requests[1]!.body, { title: 'feat(T-1): Demo', head: 'T-1-demo', base: 'main', body: '## What\nA demo.\n' });
    // Already open: reused, no second pull request.
    assert.deepEqual(await forge.open(input), { ...created, reused: true });
    assert.equal(fake.mrs.length, 1);

    fake.checkRuns.push({ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null });
    assert.deepEqual(await forge.status(1), {
      number: 1, url: 'https://github.com/acme/app/pull/1', state: 'open', draft: false, mergeable: true, checks: '2 passed, 1 running', behind: 0,
      pipeline: { state: 'running', text: '2 passed, 1 running', url: 'https://github.com/acme/app/pull/1/checks' },
    });

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
      'GET /api/v4/projects/group%2Fsub%2Fapp/merge_requests?state=opened&source_branch=T-1-demo&target_branch=develop&order_by=created_at&sort=desc&per_page=100&page=1',
      'POST /api/v4/projects/group%2Fsub%2Fapp/merge_requests',
    ]);
    assert.deepEqual(fake.requests[1]!.body, { source_branch: 'T-1-demo', target_branch: 'develop', title: 'feat(T-1): Demo', description: 'Body.' });
    assert.deepEqual(await forge.open(input), { ...created, reused: true });
    assert.equal(fake.mrs.length, 1);
    assert.deepEqual(await forge.status(1), {
      number: 1, url: created.url, state: 'open', draft: false, mergeable: true, checks: 'pipeline success', behind: 0, pipeline: { state: 'passed', text: 'success', url: null },
    });

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

// An open merge request the user opened by hand, in the fake host's memory.
function opened(number: number, branch: string, base: string, state: FakeMr['state'] = 'open'): FakeMr {
  return { number, branch, base, title: `MR ${number}`, body: '', state, draft: false, mergeable: true, mergeableState: 'clean', detailed: 'mergeable', merge_commit: null };
}

test('findOpen (SF-200): the open merge requests of the branch into the base, newest created first, with GET only; none is []; another branch\'s or base\'s entry is dropped', async () => {
  for (const kind of ['github', 'gitlab'] as const) {
    const fake = await startFakeForge(kind, 'acme/app');
    try {
      const forge = kind === 'github'
        ? forgeFor('git@github.com:acme/app.git', forgeSettings({ SF_GITHUB_TOKEN: GH_TOKEN, SF_GITHUB_API: fake.url }))
        : forgeFor(`${fake.url}/acme/app.git`, forgeSettings({ SF_GITLAB_TOKEN: GL_TOKEN, SF_GITLAB_URL: `${fake.url}/api/v4` }));
      assert.deepEqual(await forge.findOpen('T-1-demo', 'main'), [], kind);
      fake.mrs.push(opened(1, 'T-1-demo', 'main'), opened(2, 'T-1-other', 'main'), opened(3, 'T-1-demo', 'develop'), opened(4, 'T-1-demo', 'main', 'closed'), opened(5, 'T-1-demo', 'main'));
      assert.deepEqual((await forge.findOpen('T-1-demo', 'main')).map((mr) => [mr.number, mr.state]), [[5, 'open'], [1, 'open']], kind);
      // A host that ignored the filters: only the branch and base asked for are kept.
      const list = kind === 'github' ? '/repos/acme/app/pulls' : '/api/v4/projects/acme%2Fapp/merge_requests';
      fake.lists[list] = kind === 'github'
        ? [{ number: 2, html_url: 'https://github.com/acme/app/pull/2', head: { ref: 'T-1-other' }, base: { ref: 'main' } }, { number: 3, html_url: 'https://github.com/acme/app/pull/3', head: { ref: 'T-1-demo' }, base: { ref: 'develop' } }]
        : [{ iid: 2, web_url: `${fake.url}/acme/app/-/merge_requests/2`, source_branch: 'T-1-other', target_branch: 'main' }, { iid: 3, web_url: `${fake.url}/acme/app/-/merge_requests/3`, source_branch: 'T-1-demo', target_branch: 'develop' },
          // A fork's branch of the same name.
          { iid: 6, web_url: `${fake.url}/acme/app/-/merge_requests/6`, source_branch: 'T-1-demo', target_branch: 'main', source_project_id: 9, target_project_id: 1 }];
      assert.deepEqual(await forge.findOpen('T-1-demo', 'main'), [], kind);
      assert.deepEqual([...new Set(fake.requests.map((r) => r.method))], ['GET'], kind);
      assert.ok(fake.requests.every((r) => r.path.startsWith(list)), kind);
    } finally {
      await fake.close();
    }
  }
});

test('findMerged (SF-207): the merged merge requests of the branch into the base, latest merged first, with merged_at and the merge commit, GET only; open and closed ones, another branch\'s or base\'s and a GitLab fork\'s entry are dropped', async () => {
  for (const kind of ['github', 'gitlab'] as const) {
    const fake = await startFakeForge(kind, 'acme/app');
    try {
      const forge = kind === 'github'
        ? forgeFor('git@github.com:acme/app.git', forgeSettings({ SF_GITHUB_TOKEN: GH_TOKEN, SF_GITHUB_API: fake.url }))
        : forgeFor(`${fake.url}/acme/app.git`, forgeSettings({ SF_GITLAB_TOKEN: GL_TOKEN, SF_GITLAB_URL: `${fake.url}/api/v4` }));
      assert.deepEqual(await forge.findMerged('T-1-demo', 'main'), [], kind);
      const merged = (number: number, branch: string, base: string, at: string, commit: string): FakeMr => ({ ...opened(number, branch, base, 'merged'), merged_at: at, merge_commit: commit });
      fake.mrs.push(
        merged(1, 'T-1-demo', 'main', '2026-11-01T10:00:00Z', 'a'.repeat(40)),
        opened(2, 'T-1-demo', 'main'),
        opened(3, 'T-1-demo', 'main', 'closed'),
        merged(4, 'T-1-other', 'main', '2026-11-05T10:00:00Z', 'b'.repeat(40)),
        merged(5, 'T-1-demo', 'develop', '2026-11-05T10:00:00Z', 'b'.repeat(40)),
        // Created after 1, merged after it too; 7 created last, merged between them.
        merged(6, 'T-1-demo', 'main', '2026-11-03T10:00:00Z', 'c'.repeat(40)),
        merged(7, 'T-1-demo', 'main', '2026-11-02T10:00:00Z', 'd'.repeat(40)),
      );
      const found = await forge.findMerged('T-1-demo', 'main');
      assert.deepEqual(found.map((mr) => [mr.number, mr.state, mr.merged_at, mr.merge_commit]), [
        [6, 'merged', '2026-11-03T10:00:00Z', 'c'.repeat(40)], [7, 'merged', '2026-11-02T10:00:00Z', 'd'.repeat(40)], [1, 'merged', '2026-11-01T10:00:00Z', 'a'.repeat(40)],
      ], kind);
      const query = new URL(fake.requests.at(-1)!.path, 'http://fake').searchParams;
      assert.equal(query.get('state'), kind === 'github' ? 'closed' : 'merged', kind);
      // A host that ignored the filters: only merged entries of the branch and base asked for are kept.
      const list = kind === 'github' ? '/repos/acme/app/pulls' : '/api/v4/projects/acme%2Fapp/merge_requests';
      fake.lists[list] = kind === 'github'
        ? [
          { number: 2, html_url: 'https://github.com/acme/app/pull/2', head: { ref: 'T-1-demo' }, base: { ref: 'main' }, merged_at: null },
          { number: 4, html_url: 'https://github.com/acme/app/pull/4', head: { ref: 'T-1-other' }, base: { ref: 'main' }, merged_at: '2026-11-05T10:00:00Z' },
          { number: 8, html_url: 'https://github.com/acme/app/pull/8', head: { ref: 'T-1-demo' }, base: { ref: 'main' }, merged_at: '2026-11-06T10:00:00Z', merge_commit_sha: 'f'.repeat(40) },
        ]
        : [
          { iid: 2, web_url: `${fake.url}/acme/app/-/merge_requests/2`, source_branch: 'T-1-demo', target_branch: 'main', merged_at: null },
          { iid: 5, web_url: `${fake.url}/acme/app/-/merge_requests/5`, source_branch: 'T-1-demo', target_branch: 'develop', merged_at: '2026-11-05T10:00:00Z' },
          // A fork's branch of the same name.
          { iid: 6, web_url: `${fake.url}/acme/app/-/merge_requests/6`, source_branch: 'T-1-demo', target_branch: 'main', source_project_id: 9, target_project_id: 1, merged_at: '2026-11-05T10:00:00Z' },
          // A squash merge: the squash commit is the merge commit.
          { iid: 8, web_url: `${fake.url}/acme/app/-/merge_requests/8`, source_branch: 'T-1-demo', target_branch: 'main', merged_at: '2026-11-06T10:00:00Z', merge_commit_sha: null, squash_commit_sha: 'f'.repeat(40) },
        ];
      assert.deepEqual((await forge.findMerged('T-1-demo', 'main')).map((mr) => [mr.number, mr.merge_commit]), [[8, 'f'.repeat(40)]], kind);
      assert.deepEqual([...new Set(fake.requests.map((r) => r.method))], ['GET'], kind);
      assert.ok(fake.requests.every((r) => r.path.startsWith(list)), kind);
    } finally {
      await fake.close();
    }
  }
});

test('findOpen reads every page: 150 open merge requests of the branch (two pages of 100) all count, newest first, with GET only', async () => {
  for (const kind of ['github', 'gitlab'] as const) {
    const fake = await startFakeForge(kind, 'acme/app');
    try {
      const forge = kind === 'github'
        ? forgeFor('git@github.com:acme/app.git', forgeSettings({ SF_GITHUB_TOKEN: GH_TOKEN, SF_GITHUB_API: fake.url }))
        : forgeFor(`${fake.url}/acme/app.git`, forgeSettings({ SF_GITLAB_TOKEN: GL_TOKEN, SF_GITLAB_URL: `${fake.url}/api/v4` }));
      // The host's answer, newest created first, page by page.
      const numbers = Array.from({ length: 150 }, (_, index) => 150 - index);
      const list = kind === 'github' ? '/repos/acme/app/pulls' : '/api/v4/projects/acme%2Fapp/merge_requests';
      fake.lists[list] = numbers.map((number) => (kind === 'github'
        ? { number, html_url: `https://github.com/acme/app/pull/${number}`, head: { ref: 'T-1-demo' }, base: { ref: 'main' } }
        : { iid: number, web_url: `${fake.url}/acme/app/-/merge_requests/${number}`, source_branch: 'T-1-demo', target_branch: 'main' }));
      const found = await forge.findOpen('T-1-demo', 'main');
      assert.deepEqual(found.map((mr) => mr.number), numbers, kind);
      assert.deepEqual(fake.requests.map((r) => [r.method, new URL(r.path, 'http://fake').searchParams.get('page'), new URL(r.path, 'http://fake').searchParams.get('per_page')]),
        [['GET', '1', '100'], ['GET', '2', '100']], kind);
    } finally {
      await fake.close();
    }
  }
});

test('GitLab status (SF-209): asks for diverged_commits_count and maps it to behind, has_conflicts to conflicts, head_pipeline to the pipeline (an http(s) web_url only); GET only', async () => {
  const fake = await startFakeForge('gitlab', 'group/app');
  try {
    const forge = forgeFor(`${fake.url}/group/app.git`, forgeSettings({ SF_GITLAB_TOKEN: GL_TOKEN, SF_GITLAB_URL: `${fake.url}/api/v4` }));
    fake.mrs.push(opened(1, 'T-1-demo', 'main'));
    fake.behind = 3;
    fake.mrs[0]!.conflicts = true;
    fake.mrs[0]!.detailed = 'conflict';
    fake.mrs[0]!.pipeline = { status: 'failed', web_url: `${fake.url}/group/app/-/pipelines/9` };
    assert.deepEqual(await forge.status(1), {
      number: 1, url: `${fake.url}/group/app/-/merge_requests/1`, state: 'open', draft: false, mergeable: false, reason: 'it has conflicts with the target branch',
      checks: 'pipeline failed', conflicts: true, behind: 3, pipeline: { state: 'failed', text: 'failed', url: `${fake.url}/group/app/-/pipelines/9` },
    });
    assert.deepEqual(fake.requests.map((r) => `${r.method} ${r.path}`), ['GET /api/v4/projects/group%2Fapp/merge_requests/1?include_diverged_commits_count=true']);
    // The pipeline's words: the ones still to finish are running; any other is the host's own.
    const words: Array<[string, string]> = [
      ['success', 'passed'], ['created', 'running'], ['waiting_for_resource', 'running'], ['preparing', 'running'], ['pending', 'running'], ['running', 'running'],
      ['scheduled', 'running'], ['canceled', 'other'], ['skipped', 'other'], ['manual', 'other'],
    ];
    fake.mrs[0]!.conflicts = false;
    for (const [status, state] of words) {
      fake.mrs[0]!.pipeline = { status, web_url: 'javascript:alert(1)' };
      const read = await forge.status(1);
      assert.deepEqual(read.pipeline, { state, text: status, url: null }, status);
      assert.equal(read.conflicts, undefined, status);
    }
    // behind 0 is said; without a pipeline, none.
    fake.behind = 0;
    fake.fail.push({ match: /^GET /, status: 200, body: { iid: 1, web_url: `${fake.url}/group/app/-/merge_requests/1`, state: 'opened', detailed_merge_status: 'mergeable', diverged_commits_count: 0 } });
    assert.deepEqual(await forge.status(1), { number: 1, url: `${fake.url}/group/app/-/merge_requests/1`, state: 'open', draft: false, mergeable: true, behind: 0 });
    // A count that is no whole number from 0 is left out.
    fake.fail.push({ match: /^GET /, status: 200, body: { iid: 1, web_url: `${fake.url}/group/app/-/merge_requests/1`, state: 'opened', detailed_merge_status: 'mergeable', diverged_commits_count: -1 } });
    assert.equal((await forge.status(1)).behind, undefined);
    assert.deepEqual([...new Set(fake.requests.map((r) => r.method))], ['GET']);
  } finally {
    await fake.close();
  }
});

test('GitHub status (SF-209): behind from the compare of the base with the head, best effort; the pipeline from the check runs (failed over running over passed, none without a run); conflicts; GET only', async () => {
  const fake = await startFakeForge('github', 'acme/app');
  try {
    const forge = forgeFor('git@github.com:acme/app.git', forgeSettings({ SF_GITHUB_TOKEN: GH_TOKEN, SF_GITHUB_API: fake.url }));
    fake.mrs.push(opened(1, 'T-1-demo', 'release/2.0'));
    fake.behind = 4;
    // No check run: no pipeline, no checks.
    const base = { number: 1, url: 'https://github.com/acme/app/pull/1', state: 'open', draft: false, mergeable: true };
    assert.deepEqual(await forge.status(1), { ...base, behind: 4 });
    assert.deepEqual(fake.requests.map((r) => `${r.method} ${r.path}`), [
      'GET /repos/acme/app/pulls/1', `GET /repos/acme/app/commits/${'d'.repeat(40)}/check-runs?per_page=100`, `GET /repos/acme/app/compare/release/2.0...${'d'.repeat(40)}`,
    ]);
    const runs = {
      passed: { status: 'completed', conclusion: 'success' }, failed: { status: 'completed', conclusion: 'failure' },
      running: { status: 'queued', conclusion: null }, skipped: { status: 'completed', conclusion: 'skipped' },
    };
    const cases: Array<[Array<keyof typeof runs>, string, string]> = [
      [['passed', 'running', 'failed'], 'failed', '1 passed, 1 failed, 1 running'],
      [['passed', 'running'], 'running', '1 passed, 1 running'],
      [['passed', 'skipped'], 'passed', '1 passed, 1 skipped'],
      [['skipped'], 'other', '1 skipped'],
    ];
    for (const [names, state, text] of cases) {
      fake.checkRuns.splice(0, fake.checkRuns.length, ...names.map((name) => runs[name]));
      assert.deepEqual(await forge.status(1), { ...base, checks: text, behind: 4, pipeline: { state, text, url: 'https://github.com/acme/app/pull/1/checks' } }, text);
    }
    // A compare that fails leaves behind out and changes nothing else.
    const before = await forge.status(1);
    fake.fail.push({ match: /^GET .*\/compare\//, status: 404, body: { message: 'Not Found' } });
    const { behind: _behind, ...rest } = before;
    assert.deepEqual(await forge.status(1), rest);
    fake.fail.push({ match: /^GET .*\/compare\//, status: 500, body: 'oops' });
    assert.deepEqual(await forge.status(1), rest);
    // Conflicts: mergeable false or the dirty state; the reasons as before.
    fake.mrs[0]!.mergeable = false;
    fake.mrs[0]!.mergeableState = 'dirty';
    const dirty = await forge.status(1);
    assert.deepEqual([dirty.conflicts, dirty.mergeable, dirty.reason], [true, false, 'it has conflicts with release/2.0']);
    // A merged one reads no check runs and no compare.
    fake.mrs[0]!.state = 'merged';
    const count = fake.requests.length;
    const merged = await forge.status(1);
    assert.deepEqual([merged.behind, merged.pipeline, fake.requests.length - count], [undefined, undefined, 1]);
    assert.deepEqual([...new Set(fake.requests.map((r) => r.method))], ['GET']);
  } finally {
    await fake.close();
  }
});
