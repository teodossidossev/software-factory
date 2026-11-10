// The reads of a project's merge requests (src/forge-comments.ts) against the fake GitHub and the
// fake GitLab of test/support/fake-forge.ts: the open merge requests of both hosts, newest first and
// at most 50; GitLab's discussions (system notes left out, diff and general notes, resolved, two
// pages); GitHub's review comments grouped by in_reply_to_id, conversation comments and review
// bodies as threads of their own; GET only; a missing token; the token only to its own host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { forgeFor, forgeSettings } from '../src/forge.js';
import { startFakeForge } from './support/fake-forge.js';

const GH_TOKEN = 'fake-github-token-TESTTOKEN';
const GL_TOKEN = 'fake-gitlab-token-TESTTOKEN';

async function refusal(work: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof FactoryError, String(error));
    return { code: error.code, message: error.message };
  }
  assert.fail('expected a refusal');
}

// The day of the month as a time, so a larger n is newer.
const at = (n: number): string => `2026-11-${String(n).padStart(2, '0')}T10:00:00Z`;
const minute = (n: number): string => `2026-11-05T10:${String(n).padStart(2, '0')}:00Z`;

test('openRequests on GitHub and GitLab: each host\'s fields mapped, newest update first, at most 50, GET only', async () => {
  const github = await startFakeForge('github', 'acme/app');
  const gitlab = await startFakeForge('gitlab', 'group/app');
  try {
    // 60 answered (more than a host gives), in no order: the 50 newest are kept, newest first.
    github.lists['/repos/acme/app/pulls'] = Array.from({ length: 28 }, (_, i): unknown => ({
      number: i + 1, title: `PR ${i + 1}`, user: { login: `dev${i + 1}` }, head: { ref: `feature-${i + 1}` }, base: { ref: 'main' },
      html_url: `https://github.com/acme/app/pull/${i + 1}`, updated_at: at(i + 1), draft: i === 27, body: 'not read',
    })).concat(Array.from({ length: 32 }, (_, i): unknown => ({
      number: 100 + i, title: `Old ${i}`, user: null, head: { ref: `old-${i}` }, base: { ref: 'main' },
      html_url: `https://github.com/acme/app/pull/${100 + i}`, updated_at: `2026-10-${String(i % 28 + 1).padStart(2, '0')}T10:00:00Z`, draft: false, body: '',
    })).reverse());
    const forge = forgeFor('git@github.com:acme/app.git', forgeSettings({ SF_GITHUB_TOKEN: GH_TOKEN, SF_GITHUB_API: github.url }));
    const requests = await forge.openRequests();
    assert.equal(requests.length, 50);
    assert.deepEqual(requests[0], {
      number: 28, title: 'PR 28', author: 'dev28', source: 'feature-28', target: 'main', url: 'https://github.com/acme/app/pull/28', updated_at: at(28), draft: true,
    });
    assert.deepEqual(requests[1]!.draft, false);
    assert.ok(requests.every((request, i) => i === 0 || requests[i - 1]!.updated_at >= request.updated_at));
    assert.equal(requests.at(-1)!.author, 'unknown');
    assert.deepEqual(github.requests.map((r) => `${r.method} ${r.path}`), ['GET /repos/acme/app/pulls?state=open&sort=updated&direction=desc&per_page=50']);

    gitlab.lists['/api/v4/projects/group%2Fapp/merge_requests'] = [
      { iid: 3, title: 'Older', author: { username: 'bob' }, source_branch: 'b', target_branch: 'develop', web_url: `${gitlab.url}/group/app/-/merge_requests/3`, updated_at: at(1), draft: false },
      { iid: 7, title: 'Newer', author: { username: 'alice' }, source_branch: 'a', target_branch: 'main', web_url: `${gitlab.url}/group/app/-/merge_requests/7`, updated_at: at(9), work_in_progress: true },
    ];
    const lab = forgeFor(`${gitlab.url}/group/app.git`, forgeSettings({ SF_GITLAB_TOKEN: GL_TOKEN, SF_GITLAB_URL: `${gitlab.url}/api/v4` }));
    assert.deepEqual(await lab.openRequests(), [
      { number: 7, title: 'Newer', author: 'alice', source: 'a', target: 'main', url: `${gitlab.url}/group/app/-/merge_requests/7`, updated_at: at(9), draft: true },
      { number: 3, title: 'Older', author: 'bob', source: 'b', target: 'develop', url: `${gitlab.url}/group/app/-/merge_requests/3`, updated_at: at(1), draft: false },
    ]);
    assert.deepEqual(gitlab.requests.map((r) => `${r.method} ${r.path}`), ['GET /api/v4/projects/group%2Fapp/merge_requests?state=opened&order_by=updated_at&per_page=50']);

    // An entry without its number is the host's error; an HTTP error keeps the forge's message.
    gitlab.lists['/api/v4/projects/group%2Fapp/merge_requests'] = [{ title: 'No iid', web_url: 'x' }];
    assert.deepEqual(await refusal(lab.openRequests()), { code: 'mr_host_error', message: 'GitLab 127.0.0.1 answered without the merge request\'s number or URL.' });
    github.fail.push({ match: /^GET /, status: 404, body: { message: 'Not Found' } });
    assert.deepEqual(await refusal(forge.openRequests()), {
      code: 'mr_host_error', message: 'GitHub refused to list the pull requests: HTTP 404: Not Found (does SF_GITHUB_TOKEN have access to the repository?).',
    });
  } finally {
    await github.close();
    await gitlab.close();
  }
});

test('threads on GitLab: system notes left out, a diff note\'s path and line, a general note, resolved from the first resolvable note, every page, oldest first', async () => {
  const fake = await startFakeForge('gitlab', 'group/sub/app');
  try {
    const note = (n: number, extra: Record<string, unknown> = {}) => ({
      id: n, body: `Note ${n}`, author: { username: `user${n}` }, created_at: minute(n), system: false, resolvable: false, ...extra,
    });
    const discussions: unknown[] = [
      // A diff discussion on the new side, resolved, with a reply and a system note.
      {
        id: 'd-diff', individual_note: false, notes: [
          note(2, { type: 'DiffNote', resolvable: true, resolved: true, position: { new_path: 'src/a.ts', new_line: 12, old_path: 'src/a.ts', old_line: 10 } }),
          note(3, { type: 'DiffNote', resolvable: true, resolved: true, position: { new_path: 'src/a.ts', new_line: 12 } }),
          note(4, { system: true, body: 'resolved all threads' }),
        ],
      },
      // A general comment, the oldest.
      { id: 'd-general', individual_note: true, notes: [note(1)] },
      // Only a system note: left out.
      { id: 'd-system', individual_note: true, notes: [note(5, { system: true, body: 'added 1 commit' })] },
      // A note on a removed line: the old side's path and line; open.
      { id: 'd-old', individual_note: false, notes: [note(6, { type: 'DiffNote', resolvable: true, resolved: false, position: { new_path: null, new_line: null, old_path: 'src/gone.ts', old_line: 4 } })] },
    ];
    // 101 more general notes: a second page.
    for (let n = 0; n < 101; n += 1) {
      discussions.push({ id: `bulk-${n}`, individual_note: true, notes: [{ id: 1000 + n, body: `Bulk ${n}`, author: { username: 'bot' }, created_at: `2026-11-06T${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00Z`, system: false }] });
    }
    fake.lists['/api/v4/projects/group%2Fsub%2Fapp/merge_requests/4/discussions'] = discussions;
    const forge = forgeFor(`${fake.url}/group/sub/app.git`, forgeSettings({ SF_GITLAB_TOKEN: GL_TOKEN, SF_GITLAB_URL: `${fake.url}/api/v4` }));
    const threads = await forge.threads(4);
    assert.equal(threads.length, 3 + 101);
    assert.deepEqual(threads.slice(0, 3), [
      { id: 'd-general', resolved: null, path: null, line: null, comments: [{ author: 'user1', body: 'Note 1', created_at: minute(1) }] },
      {
        id: 'd-diff', resolved: true, path: 'src/a.ts', line: 12, comments: [
          { author: 'user2', body: 'Note 2', created_at: minute(2) }, { author: 'user3', body: 'Note 3', created_at: minute(3) },
        ],
      },
      { id: 'd-old', resolved: false, path: 'src/gone.ts', line: 4, comments: [{ author: 'user6', body: 'Note 6', created_at: minute(6) }] },
    ]);
    assert.equal(threads.at(-1)!.comments[0]!.body, 'Bulk 100');
    assert.deepEqual(fake.requests.map((r) => `${r.method} ${r.path}`), [
      'GET /api/v4/projects/group%2Fsub%2Fapp/merge_requests/4/discussions?per_page=100&page=1',
      'GET /api/v4/projects/group%2Fsub%2Fapp/merge_requests/4/discussions?per_page=100&page=2',
    ]);
  } finally {
    await fake.close();
  }
});

test('threads on GitLab: every page is read, past page 50, until a page holds fewer than 100 discussions', async () => {
  const fake = await startFakeForge('gitlab', 'group/app');
  try {
    // 5,050 discussions: 50 full pages and a 51st of 50.
    const start = Date.parse('2026-11-01T00:00:00Z');
    fake.lists['/api/v4/projects/group%2Fapp/merge_requests/8/discussions'] = Array.from({ length: 5050 }, (_, n) => ({
      id: `d${n}`, individual_note: true, notes: [{ id: n, body: `Note ${n}`, author: { username: 'bot' }, created_at: new Date(start + n * 1000).toISOString(), system: false }],
    }));
    const forge = forgeFor(`${fake.url}/group/app.git`, forgeSettings({ SF_GITLAB_TOKEN: GL_TOKEN, SF_GITLAB_URL: `${fake.url}/api/v4` }));
    const threads = await forge.threads(8);
    assert.equal(threads.length, 5050);
    assert.deepEqual([threads[0]!.id, threads[5000]!.id, threads.at(-1)!.id], ['d0', 'd5000', 'd5049']);
    assert.equal(fake.requests.length, 51);
    assert.equal(fake.requests.at(-1)!.path, '/api/v4/projects/group%2Fapp/merge_requests/8/discussions?per_page=100&page=51');
  } finally {
    await fake.close();
  }
});

test('threads on GitHub: review comments grouped by in_reply_to_id with their path and line, a conversation comment and a review body as threads of their own, empty and pending reviews left out', async () => {
  const fake = await startFakeForge('github', 'acme/app');
  try {
    const user = (login: string) => ({ login });
    fake.lists['/repos/acme/app/pulls/9/comments'] = [
      { id: 11, path: 'src/b.ts', line: 30, original_line: 28, body: 'Rename this.', user: user('alice'), created_at: minute(3) },
      { id: 12, in_reply_to_id: 11, path: 'src/b.ts', line: 30, body: 'Done.', user: user('bob'), created_at: minute(5) },
      // An outdated comment: its line is gone, the original line stays.
      { id: 13, path: 'src/c.ts', line: null, original_line: 7, body: 'Why?', user: user('carol'), created_at: minute(4) },
      { id: 14, in_reply_to_id: 11, path: 'src/b.ts', line: 30, body: '**Thanks**\n```ts\nx\n```', user: user('alice'), created_at: minute(6) },
    ];
    fake.lists['/repos/acme/app/issues/9/comments'] = [{ id: 21, body: 'Looks good overall.', user: user('dave'), created_at: minute(1) }];
    fake.lists['/repos/acme/app/pulls/9/reviews'] = [
      { id: 31, body: 'Please fix the naming.', user: user('alice'), state: 'CHANGES_REQUESTED', submitted_at: minute(2) },
      { id: 32, body: '', user: user('bob'), state: 'APPROVED', submitted_at: minute(7) },
      { id: 33, body: 'My draft, not submitted.', user: user('erin'), state: 'PENDING' },
    ];
    const forge = forgeFor('https://github.com/acme/app.git', forgeSettings({ SF_GITHUB_TOKEN: GH_TOKEN, SF_GITHUB_API: fake.url }));
    assert.deepEqual(await forge.threads(9), [
      { id: 'issue-comment-21', resolved: null, path: null, line: null, comments: [{ author: 'dave', body: 'Looks good overall.', created_at: minute(1) }] },
      { id: 'review-31', resolved: null, path: null, line: null, comments: [{ author: 'alice', body: 'Please fix the naming.', created_at: minute(2) }] },
      {
        id: 'comment-11', resolved: null, path: 'src/b.ts', line: 30, comments: [
          { author: 'alice', body: 'Rename this.', created_at: minute(3) },
          { author: 'bob', body: 'Done.', created_at: minute(5) },
          { author: 'alice', body: '**Thanks**\n```ts\nx\n```', created_at: minute(6) },
        ],
      },
      { id: 'comment-13', resolved: null, path: 'src/c.ts', line: 7, comments: [{ author: 'carol', body: 'Why?', created_at: minute(4) }] },
    ]);
    assert.deepEqual(fake.requests.map((r) => `${r.method} ${r.path}`), [
      'GET /repos/acme/app/pulls/9/comments?per_page=100&page=1',
      'GET /repos/acme/app/issues/9/comments?per_page=100&page=1',
      'GET /repos/acme/app/pulls/9/reviews?per_page=100&page=1',
    ]);
  } finally {
    await fake.close();
  }
});

test('the reads: a missing token is the forge\'s refusal with nothing sent; the token only in the Authorization header of its own host', async () => {
  for (const origin of ['git@github.com:acme/app.git', 'https://gitlab.com/group/app.git']) {
    const refused = (() => {
      try {
        forgeFor(origin, forgeSettings({}));
      } catch (error) {
        return error as FactoryError;
      }
      return undefined;
    })();
    assert.equal(refused?.code, 'mr_token_missing', origin);
    assert.match(refused!.message, /^Merge requests are off for this workspace: SF_(GITHUB|GITLAB)_TOKEN is not set in the environment file\.$/);
  }
  const github = await startFakeForge('github', 'acme/app');
  const gitlab = await startFakeForge('gitlab', 'group/app');
  try {
    // Both tokens set: each host gets its own, never the other's.
    for (const path of ['/repos/acme/app/pulls/1/comments', '/repos/acme/app/issues/1/comments', '/repos/acme/app/pulls/1/reviews']) {
      github.lists[path] = [];
    }
    gitlab.lists['/api/v4/projects/group%2Fapp/merge_requests/1/discussions'] = [];
    const settings = forgeSettings({ SF_GITHUB_TOKEN: GH_TOKEN, SF_GITHUB_API: github.url, SF_GITLAB_TOKEN: GL_TOKEN, SF_GITLAB_URL: `${gitlab.url}/api/v4` });
    const hub = forgeFor('https://github.com/acme/app', settings);
    const lab = forgeFor(`${gitlab.url}/group/app.git`, settings);
    await hub.openRequests();
    await hub.threads(1);
    await lab.openRequests();
    await lab.threads(1);
    for (const [fake, token] of [[github, GH_TOKEN], [gitlab, GL_TOKEN]] as const) {
      assert.ok(fake.requests.length > 0);
      for (const request of fake.requests) {
        assert.equal(request.method, 'GET');
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        assert.equal(request.body, undefined);
        const { authorization: _auth, ...others } = request.headers;
        assert.doesNotMatch(JSON.stringify([request.path, others]), /TESTTOKEN/);
      }
    }
    // A redirect is not followed: the token goes nowhere else.
    github.fail.push({ match: /^GET /, status: 302, body: {} });
    assert.equal((await refusal(hub.threads(1))).code, 'mr_host_error');
  } finally {
    await github.close();
    await gitlab.close();
  }
});
