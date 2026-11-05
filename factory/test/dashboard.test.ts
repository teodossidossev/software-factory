// The Dashboard's reads: in-process against startDashboard (token, endpoints, the event stream,
// the stream limit, disconnects; the test process must exit by itself afterwards) and end to end
// through `sf serve` with the fake Implementer (a real cycle, approve, SF_DASHBOARD=off,
// sf dashboard). The actions (approve, abort, say, review, archive) are in dashboard-actions.test.ts.
import assert from 'node:assert/strict';
import { readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_STREAMS, startDashboard, TOKEN_FILE } from '../src/dashboard.js';
import type { Job } from '../src/jobs.js';
import { CSP, fakeActions, fetchRaw, openStream, type Stream } from './support/dashboard-client.js';
import { withDashboard } from './support/dashboard-state.js';
import { call, newEnv, newRepo, putTask, runCli, script, serve, stop, temp, waitFor } from './support/harness.js';

// The live log prints the local time of the sf process (SF-049); Sofia is UTC+2 in November.
process.env.TZ = 'Europe/Sofia';

// Listening TCP sockets of a process, from /proc (Linux); undefined where /proc is not available.
async function listeners(pid: number): Promise<number | undefined> {
  try {
    const inodes = new Set<string>();
    for (const fd of await readdir(`/proc/${pid}/fd`)) {
      const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
      if (inode !== undefined) {
        inodes.add(inode);
      }
    }
    const rows = (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1).map((row) => row.trim().split(/\s+/));
    return rows.filter((row) => row[3] === '0A' && inodes.has(row[9]!)).length;
  } catch {
    return undefined;
  }
}

test('dashboard: token, static files with the security headers, 404 and 405 with empty bodies', async () => {
  await withDashboard('dash-token', fakeActions(), async (dashboard, { state, jobs }) => {
    const base = dashboard.url;
    const token = base.pathname.split('/')[2]!;
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(await readFile(join(state, TOKEN_FILE), 'utf8'), `${token}\n`);
    assert.equal((await stat(join(state, TOKEN_FILE))).mode & 0o777, 0o600);

    // A later start reuses the token of the file; an unusable file is replaced.
    const again = await startDashboard(0, state, jobs, fakeActions());
    try {
      assert.equal(again.url.pathname, `/d/${token}/`);
    } finally {
      await again.close();
    }
    await writeFile(join(state, TOKEN_FILE), 'not a token\n');
    const replaced = await startDashboard(0, state, jobs, fakeActions());
    try {
      const fresh = replaced.url.pathname.split('/')[2]!;
      assert.match(fresh, /^[0-9a-f]{64}$/);
      assert.notEqual(fresh, token);
      assert.equal(await readFile(join(state, TOKEN_FILE), 'utf8'), `${fresh}\n`);
    } finally {
      await replaced.close();
    }
    await writeFile(join(state, TOKEN_FILE), `${token}\n`);

    const origin = `http://127.0.0.1:${base.port}`;
    const wrong = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    for (const path of ['/', '/d/', '/d//', `/d/${token}`, `/d/${wrong}/`, `/d/${wrong}/api/jobs`, `/d/${token.slice(0, 10)}/`, `/x/${token}/`, `/d/${token}/nope`, `/d/${token}/api/nope`]) {
      const reply = await fetchRaw(`${origin}${path}`);
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
      assert.equal(reply.headers['content-security-policy'], CSP, path);
    }
    for (const [path, type, marker] of [['', 'text/html', '<script src="app.js"'], ['app.js', 'text/javascript', 'EventSource'], ['app.css', 'text/css', 'prefers-color-scheme']] as const) {
      const reply = await fetchRaw(new URL(path, base));
      assert.equal(reply.status, 200, path);
      assert.equal(reply.headers['content-type'], `${type}; charset=utf-8`);
      assert.equal(reply.headers['content-security-policy'], CSP);
      assert.equal(reply.headers['cache-control'], 'no-store');
      assert.equal(reply.headers['x-content-type-options'], 'nosniff');
      assert.ok(reply.body.includes(marker), path);
    }
    // No inline scripts or styles in the page.
    const page = (await fetchRaw(base)).body;
    assert.doesNotMatch(page, /<script>|<style|style=/);

    const post = await fetchRaw(new URL('api/jobs', base), { method: 'POST' });
    assert.deepEqual([post.status, post.body, post.headers.allow], [405, '', 'GET']);
    assert.equal((await fetchRaw(base, { host: `attacker.example:${base.port}` })).status, 403);
  });
});

test('dashboard: jobs, job detail, report, patch and mr endpoints; bad names are 404', async () => {
  await withDashboard('dash-api', fakeActions(), async (dashboard, { jobs }) => {
    const base = dashboard.url;
    const list = await fetchRaw(new URL('api/jobs', base));
    assert.equal(list.headers['content-type'], 'application/json; charset=utf-8');
    const { jobs: all } = JSON.parse(list.body);
    assert.deepEqual(all.map((job: Job) => [job.ticket, job.state]), [['T-0', 'failed'], ['T-1', 'awaiting_review']]);
    assert.deepEqual(Object.keys(all[1]).sort(), ['base', 'branch', 'cost_usd', 'created_at', 'deleted', 'error', 'files', 'fixes', 'gate', 'gate_fixes', 'gate_tokens', 'iteration', 'mr', 'mr_attempts', 'mr_host', 'prepared_commit', 'review', 'review_ended_at', 'state', 'ticket', 'title', 'undeclared', 'updated_at', 'workspace', 'worktree']);
    assert.deepEqual(all[0].error, { code: 'start_failed', message: 'Git failed.' });

    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body);
    assert.equal(detail.job.branch, 'T-1-demo');
    assert.equal(detail.mr, false);
    assert.deepEqual(detail.iterations, [{
      number: 1, started_at: '2026-11-01T10:00:01.000Z', ended_at: '2026-11-01T10:05:00.000Z', cost_usd: 0.5,
      changed_files: 1, patch_truncated: false, denials: 1, files: null, review: null, gate: null, gate_override: null,
    }]);
    assert.deepEqual(detail.history.map((entry: { from: string | null; to: string }) => [entry.from, entry.to]), [[null, 'starting'], ['starting', 'working'], ['working', 'awaiting_review']]);
    assert.equal(detail.history[2].ts, '2026-11-01T10:05:00.000Z');

    const report = await fetchRaw(new URL('api/jobs/app/T-1/iterations/1/report', base));
    assert.deepEqual([report.status, report.headers['content-type'], report.body], [200, 'text/markdown; charset=utf-8', '# Report: T-1, iteration 1\n## Done\nThings.\n']);
    const patch = await fetchRaw(new URL('api/jobs/app/T-1/iterations/1/patch', base));
    assert.equal(patch.headers['content-type'], 'text/x-diff; charset=utf-8');
    assert.match(patch.body, /^\+hello world$/m);

    assert.deepEqual([(await fetchRaw(new URL('api/jobs/app/T-1/mr', base))).status], [404]);
    await jobs.writeMrText('app', 'T-1', 'feat(T-1): Demo\n\n## What\nIt.\n');
    const mr = await fetchRaw(new URL('api/jobs/app/T-1/mr', base));
    assert.deepEqual([mr.status, mr.headers['content-type'], mr.body], [200, 'text/markdown; charset=utf-8', 'feat(T-1): Demo\n\n## What\nIt.\n']);
    assert.equal(JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body).mr, true);

    for (const path of [
      'api/jobs/App/T-1', 'api/jobs/app/..', 'api/jobs/app/%2e%2e', 'api/jobs/-app/T-1', 'api/jobs/app/.T-1', 'api/jobs/app/T-9',
      'api/jobs/app', 'api/jobs/app/T-1/', 'api/jobs/app/T-1/iterations/0/report', 'api/jobs/app/T-1/iterations/2/report',
      'api/jobs/app/T-1/iterations/01/report', 'api/jobs/app/T-1/iterations/1/other', 'api/jobs/app/T-1/iterations/1',
      'api/jobs/app/T-1/mr/x', 'api/stream?job=app/T-9', 'api/stream?job=app/../x', 'api/stream?job=APP/T-1', 'api/stream?job=app/T-1&from=-1',
    ]) {
      const reply = await fetchRaw(new URL(path, base));
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
    }
  });
});

test('dashboard: the stream sends jobs, the job and the events, follows the file, resumes, is limited and stops on disconnect', async () => {
  await withDashboard('dash-stream', fakeActions(), async (dashboard, { jobs, job }) => {
    const stream = await openStream(new URL('api/stream?job=app/T-1', dashboard.url));
    assert.equal(stream.status, 200);
    assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(stream.headers['content-security-policy'], CSP);
    const first = await stream.next('jobs');
    assert.equal(stream.events[0]!.event, 'jobs');
    assert.equal(first.jobs.length, 2);
    assert.equal((await stream.next('job')).iterations.length, 1);
    // Every visible line from 0: states, the prompt, the assistant text and tool, the result.
    const state0 = await stream.next('event');
    assert.deepEqual(state0, { line: 0, ts: '2026-11-01T10:00:00.000Z', iteration: 0, type: 'state', text: '12:00:00 [0] state - -> starting' });
    await stream.next('event', (event) => event.line === 1);
    assert.equal((await stream.next('event')).type, 'prompt');
    const assistant = await stream.next('event');
    assert.deepEqual([assistant.line, assistant.type], [3, 'assistant']);
    assert.equal(assistant.text, '12:00:03 [0] assistant: Working on it\n12:00:03 [0] tool_use Bash {"command":"npm test"}');
    assert.equal((await stream.next('event')).text, '12:04:00 [0] result success, cost $0.5000, duration 2.0 s, 3 turns');
    assert.equal((await stream.next('event')).line, 5);

    // A line appended while connected arrives as the next event.
    await jobs.appendEvent('app', 'T-1', { ts: '2026-11-04T10:14:25.668Z', iteration: 1, prompt: 'hello from say' });
    assert.deepEqual(await stream.next('event'), { line: 6, ts: '2026-11-04T10:14:25.668Z', iteration: 1, type: 'prompt', text: '12:14:25 [1] > hello from say' });

    // A state change refreshes jobs and the selected job.
    const ready: Job = { ...job, state: 'ready_for_human_review', updated_at: '2026-11-01T10:07:00.000Z' };
    await jobs.write(ready);
    dashboard.onStateChange(ready, 'awaiting_review');
    const changed = await stream.next('jobs');
    assert.equal(changed.jobs.find((entry: Job) => entry.ticket === 'T-1').state, 'ready_for_human_review');
    assert.equal((await stream.next('job')).job.state, 'ready_for_human_review');

    // from resumes mid-file.
    const resumed = await openStream(new URL('api/stream?job=app/T-1&from=4', dashboard.url));
    assert.equal((await resumed.next('event')).line, 4);
    assert.equal((await resumed.next('event')).line, 5);
    // Without job: jobs only.
    const overview = await openStream(new URL('api/stream', dashboard.url));
    assert.equal((await overview.next('jobs')).jobs.length, 2);

    // MAX_STREAMS open; the next one is refused until one disconnects.
    const more = [];
    for (let index = 3; index < MAX_STREAMS; index += 1) {
      more.push(await openStream(new URL('api/stream?job=app/T-0', dashboard.url)));
    }
    assert.ok(more.every((item) => item.status === 200));
    const refused = await fetchRaw(new URL('api/stream?job=app/T-1', dashboard.url));
    assert.deepEqual([refused.status, refused.body], [503, '']);
    resumed.close();
    const deadline = Date.now() + 5_000;
    let again: Stream;
    for (;;) {
      again = await openStream(new URL('api/stream?job=app/T-1&from=6', dashboard.url));
      if (again.status === 200 || Date.now() > deadline) {
        break;
      }
      again.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(again.status, 200);
    assert.equal((await again.next('event')).line, 6);
    for (const item of [stream, overview, again, ...more]) {
      item.close();
    }
  });
});

function mrText(header: string): string {
  return [
    header, '', '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change',
    'Readers need it.', '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'npm test: passed',
    '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

test('dashboard end to end: a fake cycle, the stream across mark_clean (the branch prepared), mr at ready, approve pushes, sf dashboard', async () => {
  const env = await newEnv('dash-e2e');
  const repo = await newRepo(env, 'dash-repo', true);
  await putTask(env, repo, 'T-1', 'Change README');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, tool: true, text: '# Report: T-1, iteration 1\n\n## Done\nChanged.' },
    { write: { '.software-factory/T-1.mr.md': mrText('feat(T-1): Change the README') }, text: 'prepared' },
  ]);
  const missing = await runCli(env, ['dashboard']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /There is no dashboard token: sf serve has not started/);

  const served = await serve(env);
  try {
    const base = served.dashboard!;
    assert.ok(base !== undefined);
    const open = await listeners(served.child.pid!);
    assert.ok(open === undefined || open === 2, `listeners: ${open}`);
    const token = (await readFile(join(env.state, TOKEN_FILE), 'utf8')).trim();
    assert.equal(base.pathname, `/d/${token}/`);
    const printed = await runCli({ ...env, extra: { SF_DASHBOARD_PORT: '8799' } }, ['dashboard']);
    assert.equal(printed.code, 0, printed.stderr);
    assert.equal(printed.stdout.split('\n')[0], `http://127.0.0.1:8799/d/${token}/`);
    assert.match(printed.stdout, /The token stays the same across sf serve starts/);
    assert.equal((await runCli({ ...env, extra: { SF_DASHBOARD: 'off' } }, ['dashboard'])).code, 1);
    // --rotate removes the file; the running sf serve keeps its token, the next start makes a new one.
    const rotated = await runCli(env, ['dashboard', '--rotate']);
    assert.equal(rotated.code, 0, rotated.stderr);
    assert.match(rotated.stdout, /Dashboard token removed; the next sf serve start/);
    await assert.rejects(stat(join(env.state, TOKEN_FILE)), { code: 'ENOENT' });
    assert.equal((await fetchRaw(new URL('api/jobs', base))).status, 200);
    await writeFile(join(env.state, TOKEN_FILE), `${token}\n`);

    await call(served, 'start', { workspace: 'app', ticket: 'T-1' });
    await waitFor(served, 'T-1', 'awaiting_review', 1);
    const { jobs: all } = JSON.parse((await fetchRaw(new URL('api/jobs', base))).body);
    assert.deepEqual(all.map((job: Job) => [job.workspace, job.ticket, job.branch, job.state, job.iteration]), [['app', 'T-1', 'T-1-change-readme', 'awaiting_review', 1]]);
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body);
    assert.equal(detail.iterations.length, 1);
    assert.equal(detail.iterations[0].changed_files, 1);
    assert.deepEqual(detail.history.map((entry: { to: string }) => entry.to), ['starting', 'working', 'awaiting_review']);
    assert.match((await fetchRaw(new URL('api/jobs/app/T-1/iterations/1/report', base))).body, /^# Report: T-1, iteration 1/);
    assert.match((await fetchRaw(new URL('api/jobs/app/T-1/iterations/1/patch', base))).body, /^\+hello world$/m);
    assert.equal((await fetchRaw(new URL('api/jobs/app/T-1/mr', base))).status, 404);

    const stream = await openStream(new URL('api/stream?job=app/T-1', base));
    assert.equal((await stream.next('jobs')).jobs[0].state, 'awaiting_review');
    await stream.next('event', (event) => event.text.includes('tool_result: ok 1 tests passed'));
    await call(served, 'mark_clean', { workspace: 'app', ticket: 'T-1' });
    assert.equal((await stream.next('jobs', (data) => data.jobs[0].state === 'preparing_mr')).jobs.length, 1);
    assert.equal((await stream.next('jobs', (data) => data.jobs[0].state === 'ready_for_human_review')).jobs.length, 1);
    const readyDetail = await stream.next('job', (data) => data.job.state === 'ready_for_human_review');
    assert.deepEqual([readyDetail.job.worktree, readyDetail.mr, readyDetail.job.files], [null, true, 1]);
    // The state line comes through the follower; it may arrive before or after the jobs and job above.
    await stream.seen('event', (event) => event.type === 'state' && event.text.endsWith('preparing_mr -> ready_for_human_review'));
    stream.close();
    const mr = await fetchRaw(new URL('api/jobs/app/T-1/mr', base));
    assert.deepEqual([mr.status, mr.body], [200, mrText('feat(T-1): Change the README')]);
    // The file list of the iteration comes with the detail.
    const withFiles = JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body);
    assert.deepEqual(withFiles.iterations[0].files, [{ path: 'README.md', status: 'modified', sensitive: 'no', scope: 'none', additions: 1, deletions: 1 }]);

    const approved = await runCli(env, ['approve', 'app', 'T-1']);
    assert.equal(approved.code, 0, approved.stdout + approved.stderr);
    assert.equal(JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body).job.state, 'pushed');
  } finally {
    await stop(served);
  }

  // SF_DASHBOARD=off: no dashboard line, no listener, and the old token is removed.
  const offEnv = { ...env, extra: { SF_DASHBOARD: 'off' } };
  await writeFile(join(env.state, TOKEN_FILE), `${'a'.repeat(64)}\n`);
  const off = await serve(offEnv);
  try {
    assert.equal(off.dashboard, undefined);
    const open = await listeners(off.child.pid!);
    assert.ok(open === undefined || open === 1, `listeners: ${open}`);
    await assert.rejects(stat(join(env.state, TOKEN_FILE)), { code: 'ENOENT' });
  } finally {
    await stop(off);
  }
});

test('dashboard (SF-040): no reviewer or subscription in the data; the subscriptions, test event and nudge routes are gone', async () => {
  await withDashboard('dash-no-reviewer', fakeActions(), async (dashboard) => {
    const base = dashboard.url;
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body);
    assert.deepEqual(Object.keys(detail).sort(), ['gate', 'history', 'iterations', 'job', 'ledger', 'mr', 'mr_title']);
    const { jobs: all } = JSON.parse((await fetchRaw(new URL('api/jobs', base))).body);
    assert.ok(all.every((job: Record<string, unknown>) => !('reviewer' in job)));
    assert.deepEqual([(await fetchRaw(new URL('api/subscriptions', base))).status], [404]);
    const origin = `http://127.0.0.1:${base.port}`;
    for (const action of ['test-event', 'nudge']) {
      const reply = await fetchRaw(new URL(`api/jobs/app/T-1/${action}`, base), { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
      assert.deepEqual([reply.status, reply.body], [405, ''], action);
    }
    const stream = await openStream(new URL('api/stream?job=app/T-1', base));
    try {
      // The opening events, in order, up to the job; no subscriptions among them.
      await stream.next('job');
      assert.deepEqual(stream.events.map((item) => item.event), ['jobs', 'workspaces', 'tickets', 'job']);
    } finally {
      stream.close();
    }
  });
});
