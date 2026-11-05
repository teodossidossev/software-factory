// The Dashboard's reads: in-process against startDashboard (token, endpoints, the event stream,
// the job's Stream route and entries event (SF-082), the stream limit, disconnects; the test
// process must exit by itself afterwards) and end to end through `sf serve` with the fake
// Implementer (a real cycle, approve, SF_DASHBOARD=off, sf dashboard). The actions (approve,
// abort, say, review, archive) are in dashboard-actions.test.ts. The Changes routes (SF-079): the
// iterations, the file lists of a view and one side of a file, with their guards.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_STREAMS, startDashboard, STREAM_PAGE_LINES, TOKEN_FILE } from '../src/dashboard.js';
import { FactoryError } from '../src/errors.js';
import { type EventRecord, type Job, JobStore } from '../src/jobs.js';
import { buildPatch, fileChanges } from '../src/patch.js';
import { saveRegistry } from '../src/registry.js';
import { act, CSP, fakeActions, fetchRaw, openStream, type Stream } from './support/dashboard-client.js';
import { withDashboard } from './support/dashboard-state.js';
import { call, git, newEnv, newRepo, putTask, runCli, script, serve, stop, temp, waitFor } from './support/harness.js';

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
    assert.deepEqual(Object.keys(all[1]).sort(), ['base', 'branch', 'cost_usd', 'created_at', 'deleted', 'error', 'files', 'fixes', 'gate', 'gate_fixes', 'gate_tokens', 'handoff_skipped', 'handover', 'iteration', 'limit', 'mr', 'mr_attempts', 'mr_host', 'now', 'paused', 'prepared_commit', 'review', 'review_ended_at', 'state', 'stop', 'task_changed', 'ticket', 'title', 'tool_calls', 'turn_limit', 'undeclared', 'updated_at', 'workspace', 'worktree']);
    assert.deepEqual(all[0].error, { code: 'start_failed', message: 'Git failed.' });

    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body);
    assert.equal(detail.job.branch, 'T-1-demo');
    assert.equal(detail.mr, false);
    assert.deepEqual(detail.iterations, [{
      number: 1, started_at: '2026-11-01T10:00:01.000Z', ended_at: '2026-11-01T10:05:00.000Z', cost_usd: 0.5,
      changed_files: 1, patch_truncated: false, denials: 1, files: null, review: null, gate: null, gate_override: null, simplify: null,
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
    // The worktree stays until the push (SF-073).
    assert.deepEqual([readyDetail.job.worktree, readyDetail.mr, readyDetail.job.files], [join(env.state, 'worktrees', 'app', 'T-1'), true, 1]);
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

// One events.jsonl line of a fixture: a record at a fixed time, in iteration 1.
const eventLine = (record: Record<string, unknown>): string => `${JSON.stringify({ ts: '2026-11-05T10:00:00.000Z', iteration: 1, ...record })}\n`;
const toolUse = (id: string): Record<string, unknown> => ({ message: { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } } });
const toolResult = (id: string): Record<string, unknown> => ({ message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } } });

test('dashboard (SF-082): the job stream route pages events.jsonl by from and next; a pair split across pages keeps its id; guards answer 404', async () => {
  await withDashboard('dash-job-stream', fakeActions(), async (dashboard, { jobs }) => {
    const base = dashboard.url;
    const page = async (query = ''): Promise<{ entries: Array<Record<string, any>>; next: number; end: boolean }> => {
      const reply = await fetchRaw(new URL(`api/jobs/app/T-1/stream${query}`, base));
      assert.equal(reply.status, 200, query);
      assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8');
      return JSON.parse(reply.body);
    };
    // The fixture's 6 lines, in line order: states, the prompt, text and tool, the result, the publish.
    const first = await page();
    assert.deepEqual([first.next, first.end], [6, true]);
    assert.deepEqual(first.entries.map((entry) => [entry.k, entry.t, entry.who]), [
      ['0', 'state', 'factory'], ['1', 'state', 'factory'], ['2', 'prompt', 'factory'], ['3.0', 'text', 'implementer'], ['3.1', 'tool', 'implementer'],
      ['4', 'result', 'implementer'], ['5.0', 'state', 'factory'], ['5.1', 'changes', 'factory'],
    ]);
    assert.deepEqual(first.entries[7], { t: 'changes', who: 'factory', files: 1, paths: ['README.md'], k: '5.1', ts: '2026-11-01T10:05:00.000Z', it: 1 });
    assert.deepEqual(await page('?from=4'), { ...first, entries: first.entries.slice(5) });

    // More than 2000 lines: a tool_use as the last line of one page, its result the first of the next.
    const lines: string[] = [];
    for (let line = 6; line < STREAM_PAGE_LINES - 1; line += 1) {
      lines.push(eventLine({ type: 'placeholders_removed', paths: [`p${line}`] }));
    }
    lines.push(eventLine(toolUse('split')), eventLine(toolResult('split')));
    for (let line = STREAM_PAGE_LINES + 1; line < 2050; line += 1) {
      lines.push(eventLine({ type: 'placeholders_removed', paths: [`p${line}`] }));
    }
    await appendFile(jobs.eventsPath('app', 'T-1'), lines.join(''));
    const one = await page('?from=0');
    assert.deepEqual([one.next, one.end], [STREAM_PAGE_LINES, false]);
    const last = one.entries.at(-1)!;
    assert.deepEqual([last.k, last.t, last.id, last.line], [String(STREAM_PAGE_LINES - 1), 'tool', 'split', 'Bash npm test']);
    const two = await page(`?from=${one.next}`);
    assert.deepEqual([two.next, two.end, two.entries.length], [2050, true, 2050 - STREAM_PAGE_LINES]);
    assert.deepEqual([two.entries[0]!.k, two.entries[0]!.t, two.entries[0]!.id, two.entries[0]!.out], [String(STREAM_PAGE_LINES), 'tool_result', 'split', '1 line']);
    assert.deepEqual(await page('?from=2050'), { entries: [], next: 2050, end: true });
    assert.deepEqual(await page('?from=999999999'), { entries: [], next: 999999999, end: true });

    // A job without events.jsonl; then the guards: an unknown job, a bad from.
    const none = await fetchRaw(new URL('api/jobs/app/T-0/stream?from=3', base));
    assert.deepEqual([none.status, JSON.parse(none.body)], [200, { entries: [], next: 0, end: true }]);
    for (const path of [
      'api/jobs/app/T-9/stream', 'api/jobs/app/T-9/stream?from=x', 'api/jobs/APP/T-1/stream', 'api/jobs/app/T-1/stream?from=-1',
      'api/jobs/app/T-1/stream?from=1234567890', 'api/jobs/app/T-1/stream?from=', 'api/jobs/app/T-1/stream?from=1.5', 'api/jobs/app/T-1/stream/x',
    ]) {
      const reply = await fetchRaw(new URL(path, base));
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
    }
  });
});

test('dashboard (SF-082): the live stream sends the entries of each line from from, in line order, beside the unchanged event', async () => {
  await withDashboard('dash-job-entries', fakeActions(), async (dashboard, { jobs }) => {
    const stream = await openStream(new URL('api/stream?job=app/T-1', dashboard.url));
    try {
      const page = JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1/stream', dashboard.url))).body);
      // The live entries of the existing lines are the page's.
      const live: Array<Record<string, unknown>> = [];
      for (let line = 0; line < 6; line += 1) {
        const event = await stream.next('entries');
        assert.equal(event.line, line);
        live.push(...event.entries);
      }
      assert.deepEqual(live, page.entries);

      // A tool_use, the page read, then its result appended: the result arrives live with the same id.
      await jobs.appendEvent('app', 'T-1', { ts: '2026-11-05T10:00:00.000Z', iteration: 1, ...toolUse('tu-live') } as EventRecord);
      assert.deepEqual((await stream.next('entries')).entries.map((entry: Record<string, unknown>) => [entry.t, entry.id]), [['tool', 'tu-live']]);
      const read = JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1/stream?from=6', dashboard.url))).body);
      assert.deepEqual([read.next, read.entries.map((entry: Record<string, unknown>) => entry.id)], [7, ['tu-live']]);
      await jobs.appendEvent('app', 'T-1', { ts: '2026-11-05T10:00:01.000Z', iteration: 1, ...toolResult('tu-live') } as EventRecord);
      const result = await stream.next('entries');
      assert.deepEqual([result.line, result.entries[0].t, result.entries[0].id], [7, 'tool_result', 'tu-live']);

      // A review line, whose entry reads review.json, appended just before a plain line: it arrives first.
      await jobs.writeReview('app', 'T-1', 1, {
        reviewer: 'claude', verdict: 'fix', summary: 'One thing.', items: [{ severity: 'major', path: 'README.md', problem: 'P.', expected: 'E.' }],
        accepted_sensitive: [], cost_usd: 0.1, started_at: '2026-11-05T10:00:02.000Z', ended_at: '2026-11-05T10:00:03.000Z',
      });
      await appendFile(jobs.eventsPath('app', 'T-1'), eventLine({ type: 'review', reviewer: 'claude', verdict: 'fix', items: 1 }) + eventLine({ prompt: 'plain' }));
      const verdict = await stream.next('entries');
      assert.equal(verdict.line, 8);
      assert.deepEqual([verdict.entries[0].t, verdict.entries[0].summary, verdict.entries[0].items.length], ['verdict', 'One thing.', 1]);
      const plain = await stream.next('entries');
      assert.deepEqual([plain.line, plain.entries[0].t, plain.entries[0].text], [9, 'user', 'plain']);
      // The old event message is unchanged.
      assert.deepEqual(await stream.seen('event', (event) => event.line === 9), { line: 9, ts: '2026-11-05T10:00:00.000Z', iteration: 1, type: 'prompt', text: '12:00:00 [1] > plain' });

      // A line with no entries sends no entries event; from skips the earlier lines.
      await appendFile(jobs.eventsPath('app', 'T-1'), `not json\n${eventLine({ prompt: 'after' })}`);
      assert.equal((await stream.next('entries')).line, 11);
      const resumed = await openStream(new URL('api/stream?job=app/T-1&from=9', dashboard.url));
      try {
        assert.deepEqual([(await resumed.next('entries')).line, (await resumed.next('entries')).line], [9, 11]);
      } finally {
        resumed.close();
      }

      // A failed build (an invalid ledger.json for the verdict's ids) is logged and its line
      // skipped; the next line still comes.
      await writeFile(join(jobs.dir('app', 'T-1'), 'ledger.json'), 'not json');
      const logged: unknown[] = [];
      const log = console.error;
      console.error = (...args: unknown[]) => logged.push(...args);
      try {
        await appendFile(jobs.eventsPath('app', 'T-1'), eventLine({ type: 'review', reviewer: 'claude', verdict: 'fix', items: 1 }) + eventLine({ prompt: 'next' }));
        assert.equal((await stream.next('entries')).line, 13);
      } finally {
        console.error = log;
      }
      assert.match(String(logged[0]), /ledger\.json of app\/T-1 is not valid JSON/);
      assert.ok(!stream.events.some((item) => item.event === 'entries' && item.data.line === 12));
    } finally {
      stream.close();
    }
  });
});

test('dashboard (SF-079): the changes route lists the iterations and the files of a view; the file route serves one side of a listed file; every other pair, path or query is an empty 404', async () => {
  // A workspace with a job of two iterations: a.txt changed in both, b.txt added in the second.
  const repo = join(temp, 'dash-changes-repo');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await writeFile(join(repo, 'keep.txt'), 'keep\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  process.env.SF_CONFIG_DIR = join(temp, 'dash-changes-config');
  await saveRegistry({ workspaces: { web: { read_checkout: repo } } }, process.env.SF_CONFIG_DIR);
  const work = join(temp, 'dash-changes-work');
  execFileSync('git', ['clone', '-q', repo, work]);
  const state = join(temp, 'dash-changes-state');
  await mkdir(state, { recursive: true });
  const jobs = new JobStore(state);
  const job: Job = {
    workspace: 'web', ticket: 'W-1', branch: 'W-1-demo', base: 'main', base_commit: base, target_commit: null,
    worktree: null, prepared_commit: null, mr_attempts: 0, fixes: 1, gate_fixes: 0, gate_tokens: 0, state: 'awaiting_review', iteration: 2, session_id: 's1', mr: null,
    created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:05:00.000Z',
  };
  await jobs.write(job);
  for (const [n, files] of [[1, { 'a.txt': 'two\n' }], [2, { 'a.txt': 'three\n', 'b.txt': 'b\n' }]] as const) {
    for (const [path, text] of Object.entries(files)) {
      await writeFile(join(work, path), text);
    }
    const built = await buildPatch(work, base);
    await jobs.writeIteration('web', 'W-1', {
      report: 'r\n', patch: built.patch,
      meta: {
        iteration: n, started_at: '2026-11-01T10:00:00.000Z', ended_at: `2026-11-01T10:0${n}:00.000Z`, denials: [], changed_files: built.files,
        files: await fileChanges(work, base, built.files, () => ({ sensitive: 'no', scope: 'none' })), patch_truncated: false, submodule_changed: [],
        cost_usd: null, cost_usd_total: null, duration_ms: null, base_commit: base,
      },
    });
  }
  const dashboard = await startDashboard(0, state, jobs, fakeActions());
  try {
    const read = async (path: string): Promise<{ status: number; body: string; type: string | undefined }> => {
      const reply = await fetchRaw(new URL(path, dashboard.url));
      return { status: reply.status, body: reply.body, type: reply.headers['content-type'] };
    };
    const ok = async (path: string): Promise<unknown> => {
      const reply = await read(path);
      assert.deepEqual([reply.status, reply.type], [200, 'application/json; charset=utf-8'], path);
      return JSON.parse(reply.body);
    };
    const file = (path: string, status: string, additions: number, deletions: number) => ({ path, status, additions, deletions, binary: false, unavailable: false });

    assert.deepEqual(await ok('api/jobs/web/W-1/changes'), {
      base: { ref: 'main', commit: base },
      iterations: [{ n: 1, ended_at: '2026-11-01T10:01:00.000Z', truncated: false, base_commit: base }, { n: 2, ended_at: '2026-11-01T10:02:00.000Z', truncated: false, base_commit: base }],
    });
    assert.deepEqual(await ok('api/jobs/web/W-1/changes?from=base&to=2'), { files: [file('a.txt', 'modified', 1, 1), file('b.txt', 'added', 1, 0)], more: false });
    assert.deepEqual(await ok('api/jobs/web/W-1/changes?to=1&from=base'), { files: [file('a.txt', 'modified', 1, 1)], more: false });
    assert.deepEqual(await ok('api/jobs/web/W-1/changes?from=1&to=2'), { files: [file('a.txt', 'modified', 1, 1), file('b.txt', 'added', 1, 0)], more: false });
    assert.deepEqual(await ok('api/jobs/web/W-1/file?at=base&path=a.txt'), { kind: 'text', text: 'one\n' });
    assert.deepEqual(await ok('api/jobs/web/W-1/file?at=base&of=1&path=a.txt'), { kind: 'text', text: 'one\n' });
    assert.deepEqual(await ok('api/jobs/web/W-1/file?at=1&path=a.txt'), { kind: 'text', text: 'two\n' });
    assert.deepEqual(await ok('api/jobs/web/W-1/file?at=2&path=a.txt'), { kind: 'text', text: 'three\n' });
    assert.deepEqual(await ok('api/jobs/web/W-1/file?at=base&path=b.txt'), { kind: 'absent' });
    // b.txt is in the list of iteration 2 against 1, a view that shows iteration 1.
    assert.deepEqual(await ok('api/jobs/web/W-1/file?path=b.txt&at=1'), { kind: 'absent' });

    for (const path of [
      // Pairs that are no view, an iteration not published, malformed numbers, a half pair, other parameters.
      'changes?from=1&to=1', 'changes?from=2&to=1', 'changes?from=0&to=1', 'changes?from=base&to=3', 'changes?from=base&to=0', 'changes?from=base&to=01',
      'changes?from=base', 'changes?to=2', 'changes?from=base&to=2&x=1', 'changes?from=base&from=base&to=2', 'changes?from=1&to=2&to=2', 'changes?x=1', 'changes/x',
      // Paths of no list, outside the tree or of the Task directory; iterations not published; of beside a number; missing parts.
      'file?at=base&path=keep.txt', 'file?at=1&path=keep.txt', 'file?at=base&of=1&path=b.txt', 'file?at=1&path=../a.txt', 'file?at=1&path=%2Fa.txt',
      'file?at=1&path=.software-factory/W-1.md', 'file?at=3&path=a.txt', 'file?at=0&path=a.txt', 'file?at=base&of=3&path=a.txt', 'file?at=base&of=x&path=a.txt',
      'file?at=1&of=1&path=a.txt', 'file?at=1', 'file?path=a.txt', 'file?at=1&path=a.txt&path=b.txt', 'file?at=1&path=a.txt&x=1', 'file/x',
    ]) {
      assert.deepEqual(await read(`api/jobs/web/W-1/${path}`), { status: 404, body: '', type: undefined }, path);
    }
    // A job that does not exist, a bad name.
    for (const path of ['api/jobs/web/W-9/changes', 'api/jobs/web/..%2FW-1/changes', 'api/jobs/nope/W-1/file?at=1&path=a.txt']) {
      assert.deepEqual((await read(path)).status, 404, path);
    }
    // Read-only: a POST is not allowed.
    const posted = await fetchRaw(new URL('api/jobs/web/W-1/changes', dashboard.url), { method: 'POST', headers: { origin: `http://127.0.0.1:${dashboard.url.port}` } });
    assert.notEqual(posted.status, 200);
  } finally {
    await dashboard.close();
  }
});

test('dashboard (SF-080): mr-view reads the Execution\'s view (an empty 404 without MR text); mr-save and mr-reset take strict bodies, call it once, map its refusals and send the job\'s detail to the pages that show it', async () => {
  const fake = fakeActions({ state: 'ready_for_human_review', branch: 'T-1-demo', base: 'main', edited: true, prepared_commit: 'b'.repeat(40) });
  await withDashboard('dash-mr-screen', fake, async (dashboard) => {
    const base = dashboard.url;
    const view = await fetchRaw(new URL('api/jobs/app/T-1/mr-view', base));
    assert.deepEqual([view.status, view.body], [404, '']);
    assert.deepEqual(fake.calls, [['mergeRequestView', 'app', 'T-1']]);
    fake.mrView = { title: 'feat(T-1): Demo', body: '## What\nIt.', edited: false, problems: [{ field: 'body', message: 'Missing heading: ## Why.' }] };
    const shown = await fetchRaw(new URL('api/jobs/app/T-1/mr-view', base));
    assert.deepEqual([shown.status, shown.headers['content-type'], JSON.parse(shown.body)], [200, 'application/json; charset=utf-8', fake.mrView]);
    fake.calls.length = 0;
    for (const path of ['api/jobs/app/T-9/mr-view', 'api/jobs/app/T-1/mr-view?x=1', 'api/jobs/app/T-1/mr-view/x']) {
      assert.deepEqual([(await fetchRaw(new URL(path, base))).status], [404], path);
    }
    assert.deepEqual(fake.calls, []);

    const stream = await openStream(new URL('api/stream?job=app/T-1', base));
    await stream.next('job');
    const input = { title: 'feat(T-1): Demo', body: '## What\nIt.' };
    const saved = await act(base, 'api/jobs/app/T-1/mr-save', input);
    assert.deepEqual([saved.status, JSON.parse(saved.body).result.edited], [200, true]);
    assert.deepEqual(fake.calls, [['saveMr', 'app', 'T-1', input]]);
    assert.equal((await stream.next('job')).job.ticket, 'T-1');
    const moved = { ...input, branch: 'T-1-other', base: 'release' };
    assert.equal((await act(base, 'api/jobs/app/T-1/mr-save', moved)).status, 200);
    // An MR text near its 64 KiB bound passes, past the other actions' body limit once escaped.
    const long = { title: 'feat(T-1): Demo', body: '"\n'.repeat(32 * 1024) };
    assert.ok(Buffer.byteLength(JSON.stringify(long)) > 128 * 1024);
    assert.equal((await act(base, 'api/jobs/app/T-1/mr-save', long)).status, 200);
    assert.equal((await act(base, 'api/jobs/app/T-1/mr-reset', {})).status, 200);
    assert.deepEqual(fake.calls.slice(1).map((call) => call[0] === 'saveMr' ? call[3] : call), [moved, long, ['resetMr', 'app', 'T-1']]);
    fake.calls.length = 0;

    for (const text of ['{}', '{"title":"x"}', '{"body":"x"}', '{"title":1,"body":""}', '{"title":"x","body":"y","extra":1}', '{"title":"x","body":"y","branch":null}', '{"title":"x","body":"y","base":2}', '[]', 'null']) {
      const reply = await act(base, 'api/jobs/app/T-1/mr-save', undefined, { body: text });
      assert.deepEqual([reply.status, JSON.parse(reply.body).error], [400, { code: 'invalid_body', message: 'mr-save expects {"title": string, "body": string, "branch"?: string, "base"?: string}; no other keys, no null.' }], text);
    }
    assert.equal((await act(base, 'api/jobs/app/T-1/mr-reset', undefined, { body: '{"x":1}' })).status, 400);
    assert.deepEqual(fake.calls, []);

    for (const [code, status] of [['mr_text_invalid', 400], ['branch_locked', 409], ['base_unrelated', 409], ['branch_changed', 409], ['invalid_state', 409], ['runner_active', 409]] as const) {
      fake.answer = new FactoryError(code, `refused: ${code}`);
      for (const [path, body] of [['mr-save', input], ['mr-reset', {}]] as const) {
        const reply = await act(base, `api/jobs/app/T-1/${path}`, body);
        assert.deepEqual([reply.status, JSON.parse(reply.body).error], [status, { code, message: `refused: ${code}` }], `${path} ${code}`);
      }
    }
  });
});

test('dashboard api/queue/rule (SF-072): POST {"rule"} sets the rule at a usage limit reset; an unknown one is invalid_rule (400), a bad body invalid_body; the tickets payload shows it', async () => {
  const { QueueStore, RunQueue } = await import('../src/queue.js');
  const { fakeSetup } = await import('./support/dashboard-client.js');
  const dir = join(temp, 'dash-queue-rule-store');
  await mkdir(dir, { recursive: true });
  const store = new QueueStore(dir, 3);
  const jobs = new JobStore(dir);
  const noSetup = { dependencyStates: async () => [], lastJobBase: async () => undefined };
  const queue = new RunQueue(store, { start: async () => ({}) as never, fetchBase: async () => undefined, limitReset: async () => 'skipped' as const }, noSetup, jobs);
  await withDashboard('dash-queue-rule-live', fakeActions(), async (dashboard) => {
    const base = dashboard.url;
    const tickets = async () => JSON.parse((await fetchRaw(new URL('api/tickets', base))).body).queue;
    assert.equal((await tickets()).on_limit, 'resume-then-queue');
    assert.deepEqual((await tickets()).limit_hold, null);
    for (const body of [{}, { rule: 1 }, { rule: 'wait', extra: true }]) {
      const reply = await act(base, 'api/queue/rule', body);
      assert.deepEqual([reply.status, JSON.parse(reply.body).error.code], [400, 'invalid_body'], JSON.stringify(body));
    }
    const unknown = await act(base, 'api/queue/rule', { rule: 'never' });
    assert.deepEqual([unknown.status, JSON.parse(unknown.body).error.code], [400, 'invalid_rule']);
    const set = await act(base, 'api/queue/rule', { rule: 'wait' });
    assert.deepEqual([set.status, JSON.parse(set.body)], [200, { ok: true, result: { on_limit: 'wait' } }]);
    await queue.idle();
    assert.equal((await store.read()).on_limit, 'wait');
    assert.equal((await tickets()).on_limit, 'wait');
  }, fakeSetup(), { queue });
  queue.close();
});

test('dashboard (SF-065): attachment_invalid (a Start, Restart or Resume whose Task file refers to an image that cannot be used) is a 409 with its message', async () => {
  const fake = fakeActions({ branch: 'T-5-demo', state: 'starting', check_after_minutes: 15, worktree: '/w/app/T-5' });
  await withDashboard('dash-attachment-invalid', fake, async (dashboard) => {
    const message = 'The Task file refers to images that cannot be used: T-5/1.png: missing.';
    fake.answer = new FactoryError('attachment_invalid', message);
    const reply = await act(dashboard.url, 'api/tickets/app/T-5/start', {});
    assert.deepEqual([reply.status, JSON.parse(reply.body).error], [409, { code: 'attachment_invalid', message }]);
  });
});
