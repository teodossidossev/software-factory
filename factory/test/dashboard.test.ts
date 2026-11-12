// The Dashboard's reads: in-process against startDashboard (token, endpoints, the event stream,
// the job's Stream route and entries event (SF-082), the stream limit, disconnects; the test
// process must exit by itself afterwards) and end to end through `sf serve` with the fake
// Implementer (a real cycle, approve, SF_DASHBOARD=off, sf dashboard). The actions (approve,
// abort, say, review, archive) are in dashboard-actions.test.ts. The Changes routes (SF-079): the
// iterations, the file lists of a view and one side of a file, with their guards.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import {
  checkDashboardPorts, DASHBOARD_SCRIPTS, dashboardRemoteLogins, dashboardScriptFiles, dashboardRemoteOrigins, MAX_STREAMS, remoteDashboardUrls, removeToken, startDashboard, STREAM_PAGE_LINES, TOKEN_FILE,
} from '../src/dashboard.js';
import { POST_ROUTES, type RouteName } from '../src/dashboard-routes.js';
import { FactoryError } from '../src/errors.js';
import { explanationPath } from '../src/explain.js';
import { type EventRecord, type Job, JobStore } from '../src/jobs.js';
import { buildPatch, fileChanges } from '../src/patch.js';
import { saveRegistry } from '../src/registry.js';
import { act, CSP, fakeActions, fakeSetup, fetchRaw, openStream, type Stream, ticketRow, workspaceRow } from './support/dashboard-client.js';
import type { DashboardDigests } from '../src/dashboard.js';
import type { HealthCheck } from '../src/health.js';
import { fixture, withDashboard } from './support/dashboard-state.js';
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
    // SF-136: a file of static/ that is not in the list, or a name like a script's, is a 404 too;
    // SF-137: so is the old single script, now cut into the files of the list; SF-150: and the
    // page's old icon.
    const unlisted = ['dashboard.html', 'app.js', 'core', 'core.js.map', 'app.js/', 'static/app.js'].map((name) => `/d/${token}/${name}`);
    for (const path of ['/', '/d/', '/d//', `/d/${token}`, `/d/${wrong}/`, `/d/${wrong}/api/jobs`, `/d/${token.slice(0, 10)}/`, `/x/${token}/`, `/d/${token}/nope`, `/d/${token}/api/nope`, ...unlisted]) {
      const reply = await fetchRaw(`${origin}${path}`);
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
      assert.equal(reply.headers['content-security-policy'], CSP, path);
    }
    // SF-137: the dashboard's scripts, in load order (SF-153: health.js before main.js; SF-160: the
    // top bar's header.js before board.js).
    assert.deepEqual([...DASHBOARD_SCRIPTS], ['core.js', 'job-screens.js', 'job-page.js', 'header.js', 'board.js', 'routing.js', 'ticket-page.js', 'reports.js', 'review-page.js', 'setup.js', 'health.js', 'main.js']);
    // SF-136: every script of DASHBOARD_SCRIPTS is served as JavaScript, each with its own text (its
    // header names it); SF-137: none is longer than 2,500 lines.
    for (const file of DASHBOARD_SCRIPTS) {
      const lines = (await fetchRaw(new URL(file, base))).body.trimEnd().split('\n').length;
      assert.ok(lines <= 2500, `${file}: ${lines} lines`);
    }
    const scripts = DASHBOARD_SCRIPTS.map((file) => [file, 'text/javascript', `// ${file}, `] as const);
    for (const [path, type, marker] of [['', 'text/html', '<script src="core.js"'], ...scripts, ['app.css', 'text/css', 'prefers-color-scheme'], ['favicon.svg', 'image/svg+xml', '<svg']] as const) {
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
    // SF-136: its scripts are exactly DASHBOARD_SCRIPTS, in their order, each deferred.
    assert.deepEqual([...page.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag), DASHBOARD_SCRIPTS.map((file) => `<script src="${file}" defer>`));

    const post = await fetchRaw(new URL('api/jobs', base), { method: 'POST' });
    assert.deepEqual([post.status, post.body, post.headers.allow], [405, '', 'GET']);
    assert.equal((await fetchRaw(base, { host: `attacker.example:${base.port}` })).status, 403);
  });
});

// SF-146 to SF-150: every script is built from web/<name>.ts into dist/web/ and served from there;
// static/ keeps only the page's HTML and CSS. Each is served with the text of the
// file dashboardScriptFiles names, and each is a classic script: the compiler kept it free of import
// and export (a module would have gained an `export {}`). The names the scripts had in static/
// (app.js before SF-136 split it) that are not in the list are a 404.
const OLD_STATIC_SCRIPTS = ['app.js', 'core.js', 'job-screens.js', 'job-page.js', 'board.js', 'routing.js', 'ticket-page.js', 'reports.js', 'setup.js', 'main.js'];
test('dashboard: every script is served from the build output dist/web/, static/ holds only dashboard.html and app.css, and an old script name not in the list is a 404', async () => {
  const packageDir = new URL('../../', import.meta.url);
  const files = dashboardScriptFiles();
  assert.deepEqual(files.map(({ file }) => file), [...DASHBOARD_SCRIPTS]);
  for (const { file, url, source } of files) {
    assert.deepEqual([url.href, source.href], [new URL(`dist/web/${file}`, packageDir).href, new URL(`web/${file.replace(/\.js$/, '.ts')}`, packageDir).href], file);
  }
  assert.deepEqual((await readdir(new URL('static/', packageDir))).sort(), ['app.css', 'dashboard.html', 'favicon.svg']);
  await withDashboard('dash-built', fakeActions(), async (dashboard) => {
    for (const { file, url } of files) {
      const reply = await fetchRaw(new URL(file, dashboard.url));
      assert.equal(reply.status, 200, file);
      assert.equal(reply.body, await readFile(url, 'utf8'), file);
      assert.ok(reply.body.startsWith(`// ${file}, `), file);
      assert.match(reply.body, /^'use strict';$/m, file);
      assert.doesNotMatch(reply.body, /^\s*(import|export)\b/m, file);
      // No TypeScript left: the typed declarations are plain JavaScript.
      assert.doesNotMatch(reply.body, /^(interface|type) /m, file);
    }
    const unlisted = OLD_STATIC_SCRIPTS.filter((name) => !DASHBOARD_SCRIPTS.some((file) => file === name));
    assert.deepEqual(unlisted, ['app.js']);
    for (const path of [...unlisted, ...OLD_STATIC_SCRIPTS.map((name) => `static/${name}`)]) {
      const reply = await fetchRaw(new URL(path, dashboard.url));
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
    }
    const core = (await fetchRaw(new URL('core.js', dashboard.url))).body;
    assert.match(core, /^const state = \{$/m);
    assert.match(core, /^function el\(tag, className, text\) \{$/m);
    const screens = (await fetchRaw(new URL('job-screens.js', dashboard.url))).body;
    assert.match(screens, /^function cxGet\(map, id, path, done\) \{$/m);
    assert.match(screens, /^const MR = new Map\(\);$/m);
    const jobPage = (await fetchRaw(new URL('job-page.js', dashboard.url))).body;
    assert.match(jobPage, /^async function run\(action, key, body\) \{$/m);
    const header = (await fetchRaw(new URL('header.js', dashboard.url))).body;
    assert.match(header, /^function renderHeader\(\) \{$/m);
    const boardScript = (await fetchRaw(new URL('board.js', dashboard.url))).body;
    assert.match(boardScript, /^const STOPS = \{$/m);
    const routing = (await fetchRaw(new URL('routing.js', dashboard.url))).body;
    assert.match(routing, /^function go\(key, screen = 'stream', focus = undefined, confirm = undefined\) \{$/m);
    const setupScript = (await fetchRaw(new URL('setup.js', dashboard.url))).body;
    assert.match(setupScript, /^async function setupRequest\(what, path, body, statusId, describe\) \{$/m);
    const mainScript = (await fetchRaw(new URL('main.js', dashboard.url))).body;
    assert.match(mainScript, /^function openStream\(\) \{$/m);
  });
});

test('dashboard (SF-153): GET api/health is the checks\' last result; the stream sends them first on connect and again on healthChanged; 404 without health', async () => {
  const at = '2026-11-09T10:00:00.000Z';
  let checks: HealthCheck[] = [
    { id: 'mcp', label: 'MCP endpoint', status: 'ok', detail: 'answers', since: at },
    { id: 'tunnel', label: 'ChatGPT tunnel', status: 'off', detail: 'no tunnel profile', since: at },
  ];
  await withDashboard('dash-health', fakeActions(), async (dashboard) => {
    const base = dashboard.url;
    const reply = await fetchRaw(new URL('api/health', base));
    assert.deepEqual([reply.status, reply.headers['content-type'], reply.headers['content-security-policy']], [200, 'application/json; charset=utf-8', CSP]);
    assert.deepEqual(JSON.parse(reply.body), checks);
    assert.equal((await fetchRaw(new URL('api/health?x=1', base))).status, 404);
    assert.equal((await act(base, 'api/health', {})).status, 405);
    const stream = await openStream(new URL('api/stream', base));
    try {
      assert.deepEqual(await stream.next('health'), checks);
      assert.equal(stream.events[0]!.event, 'health', 'the first event on connect');
      await stream.next('jobs');
      checks = [{ ...checks[0]!, status: 'down', detail: 'refused the token', since: '2026-11-09T10:00:30.000Z' }, checks[1]!];
      dashboard.healthChanged();
      assert.deepEqual(await stream.next('health', (data: HealthCheck[]) => data[0]?.status === 'down'), checks);
    } finally {
      stream.close();
    }
  }, undefined, { health: { list: () => checks } });
  await withDashboard('dash-no-health', fakeActions(), async (dashboard) => {
    assert.equal((await fetchRaw(new URL('api/health', dashboard.url))).status, 404);
    const stream = await openStream(new URL('api/stream', dashboard.url));
    try {
      await stream.next('tickets');
      dashboard.healthChanged();
      assert.ok(stream.events.every((event) => event.event !== 'health'));
    } finally {
      stream.close();
    }
  });
});

test('dashboard (SF-103): the digest list and one digest, a manual run and digest_running; 404 without digests', async () => {
  const summary = { id: '20261106T060000Z-scheduled', trigger: 'scheduled' as const, period: { from: '2026-11-05T06:00:00.000Z', to: '2026-11-06T06:00:00.000Z' }, ended_at: '2026-11-06T06:02:00.000Z', counts: { landed: 3, live_branches: 2, impact: 1 }, cost_usd: 0.3, error: null };
  const record = { ...summary, started_at: '2026-11-06T06:00:00.000Z', workspaces: [] };
  let running = false;
  const starts: string[] = [];
  const digests = {
    list: async () => ({ running, digests: [summary] }),
    read: async (id: string) => (id === summary.id ? record : undefined),
    start: (trigger: 'scheduled' | 'manual') => {
      starts.push(trigger);
      if (running) {
        throw new FactoryError('digest_running', 'A digest (manual) is running; it is not started twice.');
      }
      running = true;
      return { started: true as const };
    },
  } as unknown as DashboardDigests;
  await withDashboard('dash-digests', fakeActions(), async (dashboard) => {
    const base = dashboard.url;
    const list = await fetchRaw(new URL('api/digests', base));
    assert.deepEqual([list.status, list.headers['content-type'], list.headers['content-security-policy']], [200, 'application/json; charset=utf-8', CSP]);
    assert.deepEqual(JSON.parse(list.body), { running: false, digests: [summary] });
    assert.deepEqual(JSON.parse((await fetchRaw(new URL(`api/digests/${summary.id}`, base))).body), record);
    for (const path of ['api/digests/20261106T060000Z-manual', 'api/digests/../x', `api/digests/${summary.id}/more`, 'api/digests?x=1']) {
      assert.equal((await fetchRaw(new URL(path, base))).status, 404, path);
    }
    assert.equal((await act(base, 'api/digests', {})).status, 405);
    const get = await act(base, 'api/digests/run', {}, { method: 'GET' });
    assert.deepEqual([get.status, get.headers.allow], [405, 'POST']);
    assert.deepEqual(JSON.parse((await act(base, 'api/digests/run', undefined, { body: '{"now":true}' })).body).error.code, 'invalid_body');
    assert.equal((await act(base, 'api/digests/run', {}, { headers: { origin: `http://localhost:${base.port}` } })).status, 403);
    assert.deepEqual(starts, []);
    assert.deepEqual(JSON.parse((await act(base, 'api/digests/run', {})).body), { ok: true, result: { started: true } });
    assert.equal(JSON.parse((await fetchRaw(new URL('api/digests', base))).body).running, true);
    const busy = await act(base, 'api/digests/run', {});
    assert.deepEqual([busy.status, JSON.parse(busy.body).error.code], [409, 'digest_running']);
    assert.deepEqual(starts, ['manual', 'manual']);
  }, undefined, { digests });
  await withDashboard('dash-no-digests', fakeActions(), async (dashboard) => {
    assert.equal((await fetchRaw(new URL('api/digests', dashboard.url))).status, 404);
    assert.equal((await act(dashboard.url, 'api/digests/run', {})).status, 404);
  });
});

test('dashboard (SF-117): GET api/stats with days 7, 30 or 90 and a workspace; any other query or a longer path is an empty 404; POST is 405', async () => {
  await withDashboard('dash-stats', fakeActions(), async (dashboard, { jobs, job }) => {
    const base = dashboard.url;
    await jobs.write({ ...job, workspace: 'web', ticket: 'W-1', branch: 'W-1-x', state: 'working' });
    const all = await fetchRaw(new URL('api/stats?days=30', base));
    assert.deepEqual([all.status, all.headers['content-type']], [200, 'application/json; charset=utf-8']);
    const payload = JSON.parse(all.body);
    assert.deepEqual([payload.days, payload.workspace, payload.workspaces], [30, null, ['app', 'web']]);
    // The server's clock is the real one: only the jobs that are not finished are in every period.
    const rows = (data: { jobs: Array<{ workspace: string; ticket: string }> }): string[] => data.jobs.map((row) => `${row.workspace}/${row.ticket}`);
    assert.ok(rows(payload).includes('app/T-1') && rows(payload).includes('web/W-1'));
    const app = JSON.parse((await fetchRaw(new URL('api/stats?days=7&workspace=app', base))).body);
    assert.deepEqual([app.days, app.workspace, app.days_rows.length], [7, 'app', 7]);
    assert.ok(rows(app).includes('app/T-1') && rows(app).every((row) => row.startsWith('app/')));
    assert.deepEqual(app.by_workspace.map((row: { workspace: string }) => row.workspace), ['app']);
    assert.equal(JSON.parse((await fetchRaw(new URL('api/stats?days=90', base))).body).days_rows.length, 90);
    for (const path of ['api/stats', 'api/stats?days=14', 'api/stats?days=30&x=1', 'api/stats?days=30&days=7', 'api/stats?workspace=app', 'api/stats?days=30&workspace=../x', 'api/stats/x', 'api/stats/x?days=30']) {
      const reply = await fetchRaw(new URL(path, base));
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
    }
    const post = await act(base, 'api/stats?days=30', {});
    assert.deepEqual([post.status, post.headers.allow], [405, 'GET']);
  });
});

test('dashboard (SF-129): api/jobs and the detail carry the stop\'s canonical row, the actions in order and every availability; the detail its settle_ids', async () => {
  await withDashboard('dash-stops', fakeActions(), async (dashboard, { jobs, job }) => {
    const base = dashboard.url;
    const at = '2026-11-01T10:06:00.000Z';
    const entry = (id: string, status: string) => ({
      id, iteration: 1, reviewer: 'claude', severity: 'major' as const, path: 'README.md', problem: 'P.', expected: 'E.', status: status as 'open',
      response: '', evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null,
    });
    await jobs.write({ ...job, state: 'needs_human', updated_at: at, error: { code: 'review_churn', message: 'The fixes keep making findings.' } });
    await jobs.writeLedger('app', 'T-1', [entry('R1', 'open'), entry('R2', 'contested'), entry('R3', 'escalated'), entry('R4', 'fixed')]);
    await jobs.writeReview('app', 'T-1', 1, { reviewer: 'claude', verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [], cost_usd: 0.1, started_at: at, ended_at: at });
    const row = JSON.parse((await fetchRaw(new URL('api/jobs', base))).body).jobs.find((candidate: Job) => candidate.ticket === 'T-1');
    assert.deepEqual([row.stop_code, row.stop_kind, row.stop_group], ['review_churn', 'decision', 'ledger']);
    // The board's Accept reads the real review too.
    assert.deepEqual(row.actions, [
      { action: 'accept', label: 'Accept and prepare MR', primary: true, danger: false }, { action: 'say', label: 'Send', primary: false, danger: false },
      { action: 'abort', label: 'Abort…', primary: false, danger: true },
    ]);
    assert.deepEqual([row.availability.accept, row.availability.settle, row.availability.say, row.availability.retry], ['', '', '', 'only after a transient MR preparation failure.']);
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body);
    assert.deepEqual([detail.job.stop_code, detail.job.actions, detail.job.availability], [row.stop_code, row.actions, row.availability]);
    assert.deepEqual(detail.settle_ids, ['R2', 'R3']);

    // An alias resolves to its row; the failed job has no stop and Restart and Archive, no primary.
    await jobs.write({ ...job, state: 'needs_human', updated_at: at, error: { code: 'mr_rebase_failed', message: 'Git failed.' } });
    const again = JSON.parse((await fetchRaw(new URL('api/jobs', base))).body).jobs;
    const stopped = again.find((candidate: Job) => candidate.ticket === 'T-1');
    assert.deepEqual([stopped.stop_code, stopped.stop_kind, stopped.stop_group, stopped.actions.map((shown: { action: string }) => shown.action)], ['mr_failed', 'error', null, ['retry', 'goon', 'abort']]);
    const failed = again.find((candidate: Job) => candidate.ticket === 'T-0');
    assert.deepEqual([failed.stop_code, failed.actions], [null, [
      { action: 'restart', label: 'Restart…', primary: false, danger: false }, { action: 'archive', label: 'Archive', primary: false, danger: false },
    ]]);
    assert.deepEqual(JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body).settle_ids, []);
  });
});

test('dashboard: jobs, job detail, report, patch and mr endpoints; bad names are 404', async () => {
  await withDashboard('dash-api', fakeActions(), async (dashboard, { jobs }) => {
    const base = dashboard.url;
    const list = await fetchRaw(new URL('api/jobs', base));
    assert.equal(list.headers['content-type'], 'application/json; charset=utf-8');
    const { jobs: all } = JSON.parse(list.body);
    assert.deepEqual(all.map((job: Job) => [job.ticket, job.state]), [['T-0', 'failed'], ['T-1', 'awaiting_review']]);
    assert.deepEqual(Object.keys(all[1]).sort(), ['actions', 'availability', 'base', 'branch', 'claude_review', 'cost_usd', 'created_at', 'deleted', 'error', 'files', 'fixes', 'gate', 'gate_fixes', 'gate_tokens', 'handoff_skipped', 'handover', 'iteration', 'limit', 'mr', 'mr_attempts', 'mr_conflict_turn', 'mr_host', 'now', 'paused', 'prepared_commit', 'progress', 'review', 'review_ended_at', 'state', 'stop', 'stop_code', 'stop_group', 'stop_kind', 'task_changed', 'ticket', 'title', 'tool_calls', 'turn_limit', 'undeclared', 'updated_at', 'workspace', 'worktree']);
    assert.deepEqual(all[0].error, { code: 'start_failed', message: 'Git failed.' });
    // The running job's progress (no worktree: no steps; the Claude review ahead), none for the failed one.
    assert.deepEqual({ ...all[1].progress, ready_from: typeof all[1].progress.ready_from, ready_to: typeof all[1].progress.ready_to }, { steps: [], phase: 'claude', fix_round: 0, ready_from: 'string', ready_to: 'string' });
    assert.equal(all[0].progress, null);

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

test('dashboard (SF-140): every GET route of the table answers with its status, type and body; any other path is an empty 404', async () => {
  const setup = fakeSetup([workspaceRow('app')], [ticketRow('app', 'T-5')]);
  setup.texts.set('app/T-5', '---\nticket: T-5\ntitle: Five\nbase: main\n---\n\n# T-5: Five\n');
  setup.texts.set('app/archive/T-4', '# T-4\n');
  setup.images.set('app/T-5/1.png', { type: 'image/png', data: Buffer.from('png bytes') });
  const record = { id: 'd1', workspaces: [] };
  const digests = { list: async () => ({ running: false, digests: [] }), read: async (id: string) => (id === 'd1' ? record : undefined) } as unknown as DashboardDigests;
  const actions = fakeActions();
  actions.mrView = { text: 'feat(T-1): Demo' } as unknown as typeof actions.mrView;
  await withDashboard('dash-get-table', actions, async (dashboard, { jobs }) => {
    const base = dashboard.url;
    await jobs.writeMrText('app', 'T-1', 'feat(T-1): Demo\n');
    const JSON_TYPE = 'application/json; charset=utf-8';
    const MD = 'text/markdown; charset=utf-8';
    const answers: Array<[string, string, (body: string) => void]> = [
      ['', 'text/html; charset=utf-8', (body) => assert.match(body, /<html/i)],
      ['core.js', 'text/javascript; charset=utf-8', (body) => assert.ok(body.length > 0)],
      ['app.css', 'text/css; charset=utf-8', (body) => assert.ok(body.length > 0)],
      ['favicon.svg', 'image/svg+xml; charset=utf-8', (body) => assert.match(body, /<svg/)],
      ['api/jobs', JSON_TYPE, (body) => assert.deepEqual([JSON.parse(body).jobs.length, JSON.parse(body).remote], [2, false])],
      ['api/workspaces', JSON_TYPE, (body) => assert.equal(JSON.parse(body).workspaces[0].name, 'app')],
      ['api/tickets', JSON_TYPE, (body) => assert.deepEqual(JSON.parse(body).tickets.map((row: { ticket: string }) => row.ticket), ['T-5'])],
      ['api/stats?days=7', JSON_TYPE, (body) => assert.equal(typeof JSON.parse(body), 'object')],
      ['api/digests', JSON_TYPE, (body) => assert.deepEqual(JSON.parse(body), { running: false, digests: [] })],
      ['api/digests/d1', JSON_TYPE, (body) => assert.deepEqual(JSON.parse(body), record)],
      ['api/tickets/app/T-5/page', JSON_TYPE, (body) => assert.equal(JSON.parse(body).ticket.ticket, 'T-5')],
      ['api/tickets/app/T-5/task', MD, (body) => assert.match(body, /^---\nticket: T-5/)],
      ['api/tickets/app/T-4/task?archived=1', MD, (body) => assert.equal(body, '# T-4\n')],
      ['api/tickets/app/T-5/attachments/1.png', 'image/png', (body) => assert.equal(body, 'png bytes')],
      ['api/jobs/app/T-1', JSON_TYPE, (body) => assert.equal(JSON.parse(body).job.ticket, 'T-1')],
      ['api/jobs/app/T-1/stream?from=0', JSON_TYPE, (body) => assert.equal(JSON.parse(body).end, true)],
      ['api/jobs/app/T-1/mr', MD, (body) => assert.equal(body, 'feat(T-1): Demo\n')],
      ['api/jobs/app/T-1/mr-view', JSON_TYPE, (body) => assert.deepEqual(JSON.parse(body), { text: 'feat(T-1): Demo' })],
      ['api/jobs/app/T-1/changes', JSON_TYPE, (body) => assert.equal(typeof JSON.parse(body), 'object')],
      ['api/jobs/app/T-1/iterations/1/report', MD, (body) => assert.equal(body, '# Report: T-1, iteration 1\n## Done\nThings.\n')],
      ['api/jobs/app/T-1/iterations/1/patch', 'text/x-diff; charset=utf-8', (body) => assert.match(body, /^\+hello world$/m)],
    ];
    for (const [path, type, check] of answers) {
      const reply = await fetchRaw(new URL(path, base));
      assert.deepEqual([reply.status, reply.headers['content-type']], [200, type], path);
      check(reply.body);
    }
    const stream = await openStream(new URL('api/stream', base));
    assert.deepEqual([stream.status, stream.headers['content-type']], [200, 'text/event-stream; charset=utf-8']);
    stream.close();
    for (const path of [
      'nope', 'core.js/x', 'api', 'api/', 'api/nope', 'api/jobs/', 'api/stats', 'api/stats/x?days=7', 'api/digests/d2', 'api/digests/d1/x', 'api/digests?x=1',
      'api/tickets/app/T-5', 'api/tickets/app/T-5/other', 'api/tickets/app/T-5/page/x', 'api/tickets/app/T-5/attachments/2.png',
      'api/jobs/app/T-1/mr-view?x=1', 'api/jobs/app/T-1/file', 'api/jobs/app/T-1/iterations/1', 'api/jobs/app/T-1/iterations/2/patch', 'api/jobs/app/T-9/mr', 'api/jobs/app/T-1/other',
    ]) {
      const reply = await fetchRaw(new URL(path, base));
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
    }
  }, setup, { digests });
});

test('dashboard (SF-106): the job\'s detail has the explanation only for its current stop; refreshJob sends the job\'s detail to the pages that show it', async () => {
  await withDashboard('dash-explain', fakeActions(), async (dashboard, { jobs, job }) => {
    const detailOf = async (): Promise<Record<string, any>> => JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', dashboard.url))).body);
    assert.equal((await detailOf()).explanation, null);
    const stopped: Job = { ...job, state: 'needs_human', updated_at: '2026-11-01T10:06:00.000Z', error: { code: 'escalated', message: 'The Implementer escalated R1.' } };
    await jobs.write(stopped);
    const record = {
      stop: { at: stopped.updated_at, code: 'escalated' }, model: 'sonnet', language: 'English', started_at: stopped.updated_at, ended_at: '2026-11-01T10:06:30.000Z', cost_usd: 0.01,
      output: { headline: 'Keep it or go back?', explanation: 'Plain words.', choices: [{ choice: 'Keep it', effect: 'It stays.', recommended: true }], recommendation: 'Keep it.' }, error: null,
    };
    await writeFile(explanationPath(jobs, 'app', 'T-1'), JSON.stringify(record));
    assert.deepEqual((await detailOf()).explanation, record);
    // Another stop of the job (a newer updated_at, another code), or no stop: null.
    for (const other of [{ ...stopped, updated_at: '2026-11-01T10:07:00.000Z' }, { ...stopped, error: { code: 'review_churn', message: 'x' } }, { ...stopped, state: 'working' as const }]) {
      await jobs.write(other);
      assert.equal((await detailOf()).explanation, null, JSON.stringify(other.error));
    }
    // An unreadable file: null.
    await jobs.write(stopped);
    await writeFile(explanationPath(jobs, 'app', 'T-1'), 'not json');
    assert.equal((await detailOf()).explanation, null);

    // refreshJob: the open page of the job gets its detail again, with the explanation.
    const stream = await openStream(new URL('api/stream?job=app/T-1', dashboard.url));
    try {
      await stream.next('job');
      await writeFile(explanationPath(jobs, 'app', 'T-1'), JSON.stringify(record));
      dashboard.refreshJob('app', 'T-1');
      assert.equal((await stream.next('jobs')).jobs.length, 2);
      assert.deepEqual((await stream.next('job')).explanation, record);
    } finally {
      stream.close();
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

  // SF-126: the remote settings are checked at the start: the logins are required, the ports differ.
  const remoteEnv = { SF_DASHBOARD_REMOTE_ORIGINS: 'https://pc.tail1234.ts.net', SF_DASHBOARD_REMOTE_PORT: '0' };
  for (const [extra, named] of [
    [remoteEnv, 'SF_DASHBOARD_REMOTE_LOGINS'], [{ ...remoteEnv, SF_DASHBOARD_REMOTE_LOGINS: ' , ' }, 'SF_DASHBOARD_REMOTE_LOGINS'],
    [{ ...remoteEnv, SF_DASHBOARD_REMOTE_LOGINS: 'alice@github', SF_DASHBOARD_PORT: '8790', SF_DASHBOARD_REMOTE_PORT: '8790' }, 'SF_DASHBOARD_REMOTE_PORT must differ'],
    [{ ...remoteEnv, SF_DASHBOARD_REMOTE_LOGINS: 'alice@github', SF_DASHBOARD_REMOTE_PORT: 'x' }, 'SF_DASHBOARD_REMOTE_PORT must be an integer'],
  ] as const) {
    const refusedStart = await runCli({ ...env, extra: { ...env.extra, ...extra } }, ['serve']);
    assert.equal(refusedStart.code, 1, refusedStart.stdout + refusedStart.stderr);
    assert.ok(refusedStart.stderr.includes(named), refusedStart.stderr);
  }

  env.extra = { ...env.extra, ...remoteEnv, SF_DASHBOARD_REMOTE_LOGINS: 'alice@github' };
  const served = await serve(env);
  try {
    const base = served.dashboard!;
    assert.ok(base !== undefined);
    // The MCP endpoint, the dashboard and its remote listener (SF-126).
    const open = await listeners(served.child.pid!);
    assert.ok(open === undefined || open === 3, `listeners: ${open}`);
    const token = (await readFile(join(env.state, TOKEN_FILE), 'utf8')).trim();
    assert.equal(base.pathname, `/d/${token}/`);
    // SF-126: no token in the output; the URLs with <token>, and the remote listener's port.
    assert.ok(!served.output.includes(token), served.output);
    assert.match(served.output, new RegExp(`^software-factory dashboard http://127\\.0\\.0\\.1:${base.port}/d/<token>/ \\(sf dashboard prints the full URL\\)$`, 'm'));
    const remotePort = /^software-factory dashboard remote listener 127\.0\.0\.1:(\d+)$/m.exec(served.output)?.[1];
    assert.ok(remotePort !== undefined && remotePort !== base.port, served.output);
    assert.ok(served.output.includes('software-factory dashboard through Tailscale https://pc.tail1234.ts.net/d/<token>/\n'), served.output);
    const remoteRead = await fetchRaw(`http://127.0.0.1:${remotePort}/d/${token}/api/jobs`, { host: 'pc.tail1234.ts.net', headers: { 'tailscale-user-login': 'alice@github' } });
    assert.deepEqual([remoteRead.status, JSON.parse(remoteRead.body).remote], [200, true]);
    const printed = await runCli({ ...env, extra: { SF_DASHBOARD_PORT: '8799', SF_DASHBOARD_REMOTE_ORIGINS: 'https://pc.tail1234.ts.net' } }, ['dashboard']);
    assert.equal(printed.code, 0, printed.stderr);
    assert.equal(printed.stdout.split('\n')[0], `http://127.0.0.1:8799/d/${token}/`);
    assert.equal(printed.stdout.split('\n')[1], `Through Tailscale: https://pc.tail1234.ts.net/d/${token}/`);
    const invalid = await runCli({ ...env, extra: { SF_DASHBOARD_REMOTE_ORIGINS: 'http://pc.tail1234.ts.net' } }, ['dashboard']);
    assert.deepEqual([invalid.code, invalid.stdout], [1, '']);
    assert.match(invalid.stderr, /SF_DASHBOARD_REMOTE_ORIGINS/);
    assert.match(printed.stdout, /The token stays the same across sf serve starts/);
    // SF-126: sf status keeps printing the full URL (with the configured port), last; not with the dashboard off.
    const overview = await runCli({ ...env, extra: { ...env.extra, SF_DASHBOARD_PORT: '8799' } }, ['status']);
    assert.equal(overview.code, 0, overview.stderr);
    assert.match(overview.stdout, /^No jobs\.\n/);
    assert.ok(overview.stdout.endsWith(`\ndashboard: http://127.0.0.1:8799/d/${token}/\n`), overview.stdout);
    assert.equal((await runCli({ ...env, extra: { ...env.extra, SF_DASHBOARD: 'off' } }, ['status'])).stdout, 'No jobs.\n');
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
    // SF-126: sf status <ws> <ticket> shows the full URL too: after the worktree, before the marked paths that end it.
    const one = await runCli({ ...env, extra: { ...env.extra, SF_DASHBOARD_PORT: '8799' } }, ['status', 'app', 'T-1']);
    assert.equal(one.code, 0, one.stderr);
    assert.match(one.stdout, /^WORKSPACE\s+TICKET\s+STATE/);
    assert.ok(one.stdout.includes(`\nworktree: ${join(env.state, 'worktrees', 'app', 'T-1')}\ndashboard: http://127.0.0.1:8799/d/${token}/\nsensitive: none\n`), one.stdout);
    assert.match(one.stdout, /\nsensitive: none\ndeleted: none\n$/);
    assert.doesNotMatch((await runCli({ ...env, extra: { ...env.extra, SF_DASHBOARD: 'off' } }, ['status', 'app', 'T-1'])).stdout, /dashboard:/);
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

test('dashboard (SF-118): SF_DASHBOARD_REMOTE_ORIGINS accepts only https://<machine>.<tailnet>.ts.net origins, lower-cased and without duplicates', () => {
  assert.deepEqual(dashboardRemoteOrigins({}), []);
  assert.deepEqual(dashboardRemoteOrigins({ SF_DASHBOARD_REMOTE_ORIGINS: '' }), []);
  assert.deepEqual(dashboardRemoteOrigins({ SF_DASHBOARD_REMOTE_ORIGINS: ' , ' }), []);
  assert.deepEqual(dashboardRemoteOrigins({ SF_DASHBOARD_REMOTE_ORIGINS: 'https://pc.tail1234.ts.net' }), ['https://pc.tail1234.ts.net']);
  assert.deepEqual(
    dashboardRemoteOrigins({ SF_DASHBOARD_REMOTE_ORIGINS: ' https://PC.Tail1234.ts.net/ , https://phone-host.tail1234.ts.net,https://pc.tail1234.ts.net' }),
    ['https://pc.tail1234.ts.net', 'https://phone-host.tail1234.ts.net'],
  );
  const refused = [
    'http://pc.tail1234.ts.net', 'https://pc.example.com', 'https://ts.net', 'https://tail1234.ts.net', 'https://a.b.c.ts.net',
    'https://pc.tail1234.ts.net:443', 'https://pc.tail1234.ts.net:8443', 'https://pc.tail1234.ts.net/d/', 'https://pc.tail1234.ts.net?x=1',
    'https://pc.tail1234.ts.net#x', 'https://u:p@pc.tail1234.ts.net', 'pc.tail1234.ts.net', 'https://pc.tail1234.ts.net.example.com', 'https://100.64.0.1',
  ];
  for (const entry of refused) {
    for (const value of [entry, `https://pc.tail1234.ts.net, ${entry} ,https://phone.tail1234.ts.net`]) {
      assert.throws(() => dashboardRemoteOrigins({ SF_DASHBOARD_REMOTE_ORIGINS: value }), (error: unknown) => {
        assert.ok(error instanceof FactoryError, value);
        assert.equal(error.code, 'invalid_config', value);
        assert.ok(error.message.includes('SF_DASHBOARD_REMOTE_ORIGINS'), error.message);
        assert.ok(error.message.includes(`"${entry}"`), error.message);
        return true;
      }, value);
    }
  }
});

// The remote port's request (SF-126): a listed login and a listed Host by default.
const REMOTE = 'https://pc.tail1234.ts.net';
const LOGIN = { 'tailscale-user-login': 'alice@github' };
const cookieValue = (token: string, side: 'local' | 'remote'): string => createHmac('sha256', token).update(`dashboard-cookie:${side}`).digest('hex');

async function remoteDashboard(name: string, fake = fakeActions()) {
  const store = await fixture(name);
  const dashboard = await startDashboard(0, store.state, store.jobs, fake, undefined, { remoteOrigins: [REMOTE], remoteLogins: ['alice@github', 'bob@example.com'], remotePort: 0 });
  const token = dashboard.url.pathname.split('/')[2]!;
  assert.ok(dashboard.remotePort !== undefined && dashboard.remotePort !== 0 && dashboard.remotePort !== Number(dashboard.url.port));
  return { store, dashboard, token, remote: new URL(`http://127.0.0.1:${dashboard.remotePort}/d/${token}/`) };
}

test('dashboard (SF-126): the remote port serves listed logins only; its Host is a listed ts.net name, or loopback with a listed Origin; an Origin is a listed one, absent only on GET and HEAD', async () => {
  const hex = 'ab'.repeat(32);
  assert.deepEqual(remoteDashboardUrls([REMOTE], hex).map((url) => url.href), [`${REMOTE}/d/${hex}/`]);
  const fake = fakeActions();
  const { dashboard, token, remote } = await remoteDashboard('dash-remote', fake);
  const errors = mock.method(console, 'error', () => undefined);
  try {
    assert.deepEqual(dashboard.remoteUrls.map((url) => url.href), [`${REMOTE}/d/${token}/`]);
    const loopbackHost = `127.0.0.1:${dashboard.remotePort}`;
    const page = new URL('api/jobs', remote);

    // The login: none, an unlisted one or several are an empty 403 and one line naming the login
    // (or "none"), never the path or the token; a listed one in another case passes.
    for (const [headers, named] of [
      [{}, 'none'], [{ 'tailscale-user-login': 'mallory@github' }, 'mallory@github'], [{ 'tailscale-user-login': 'alice@github, bob@example.com' }, 'alice@github,?bob@example.com'],
      [{ 'tailscale-user-name': 'Alice', 'tailscale-user-profile-pic': 'x' }, 'none'],
    ] as const) {
      errors.mock.resetCalls();
      const reply = await fetchRaw(page, { host: 'pc.tail1234.ts.net', headers });
      assert.deepEqual([reply.status, reply.body], [403, ''], named);
      assert.equal(errors.mock.callCount(), 1, named);
      const line = String(errors.mock.calls[0]!.arguments[0]);
      assert.equal(line, `dashboard: refused a request on the remote port from login ${named} (not in SF_DASHBOARD_REMOTE_LOGINS)`);
      assert.ok(!line.includes(token) && !line.includes('api/jobs'), line);
    }
    errors.mock.resetCalls();
    for (const login of ['Alice@GitHub', 'BOB@example.com']) {
      assert.equal((await fetchRaw(page, { host: 'pc.tail1234.ts.net', headers: { 'tailscale-user-login': login } })).status, 200, login);
    }

    // Accepted: the listed Host with or without the listed Origin, with :443; the loopback Host with the listed Origin.
    for (const url of [remote, page]) {
      for (const [host, headers] of [
        ['pc.tail1234.ts.net', {}], ['PC.tail1234.ts.net', { origin: REMOTE }], ['pc.tail1234.ts.net:443', {}], [loopbackHost, { origin: REMOTE }], ['localhost', { origin: REMOTE }],
      ] as const) {
        assert.equal((await fetchRaw(url, { host, headers: { ...LOGIN, ...headers } })).status, 200, `${url.pathname} ${host} ${JSON.stringify(headers)}`);
      }
    }
    // Refused, an empty 403: the loopback Host without the listed Origin, a loopback or other Origin,
    // an unlisted Host.
    for (const [host, origin] of [
      [loopbackHost, undefined], [loopbackHost, `http://${loopbackHost}`], ['pc.tail1234.ts.net', `http://${loopbackHost}`], ['pc.tail1234.ts.net', 'http://127.0.0.1'],
      ['other.tail1234.ts.net', REMOTE], ['other.tail1234.ts.net', undefined], ['pc.tail1234.ts.net', 'https://other.tail1234.ts.net'], ['pc.tail1234.ts.net', 'http://pc.tail1234.ts.net'],
      ['pc.tail1234.ts.net', 'https://pc.example.com'], ['pc.tail1234.ts.net', 'https://pc.tail1234.ts.net:8443'], ['pc.tail1234.ts.net', 'null'],
    ] as const) {
      const headers = { ...LOGIN, ...(origin !== undefined ? { origin } : {}) };
      const label = `${host} ${origin}`;
      const read = await fetchRaw(page, { host, headers });
      assert.deepEqual([read.status, read.body], [403, ''], label);
      assert.equal((await act(remote, 'api/jobs/app/T-1/approve', { confirm: 'T-1' }, { host, headers })).status, 403, label);
    }
    // An action needs the listed Origin: without one (absent passes only on GET and HEAD) it is an empty 403.
    const bare = await fetchRaw(new URL('api/jobs/app/T-1/approve', remote), {
      method: 'POST', host: 'pc.tail1234.ts.net', headers: { ...LOGIN, 'content-type': 'application/json' }, body: '{"confirm":"T-1"}',
    });
    assert.deepEqual([bare.status, bare.body], [403, '']);
    assert.deepEqual(fake.calls, []);
    // With the listed Origin, through either Host, it runs.
    for (const host of ['pc.tail1234.ts.net', loopbackHost]) {
      const approved = await act(remote, 'api/jobs/app/T-1/approve', { confirm: 'T-1' }, { host, headers: { ...LOGIN, origin: REMOTE } });
      assert.equal(approved.status, 200, `${host}: ${approved.body}`);
    }
    assert.deepEqual(fake.calls, [['approve', 'app', 'T-1'], ['approve', 'app', 'T-1']]);
    // The token (or the cookie) is still required.
    const wrong = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    for (const path of [`/d/${wrong}/api/jobs`, '/', '/api/jobs']) {
      const reply = await fetchRaw(`http://${loopbackHost}${path}`, { host: 'pc.tail1234.ts.net', headers: LOGIN });
      assert.deepEqual([reply.status, reply.body], [404, ''], path);
    }
    // No line for an allowed login.
    assert.equal(errors.mock.callCount(), 0);
  } finally {
    errors.mock.restore();
    await dashboard.close();
  }
});

test('dashboard (SF-126): the remote cookie is __Host- and Secure; api/jobs says remote; the detail\'s confirm_actions on both ports (SF-139); the local port refuses the Tailscale Host and Origin and ignores Tailscale-User-*', async () => {
  const { dashboard, token, remote } = await remoteDashboard('dash-remote-cookie');
  try {
    const base = dashboard.url;
    const visit = await fetchRaw(remote, { host: 'pc.tail1234.ts.net', headers: LOGIN });
    assert.equal(visit.status, 200);
    assert.deepEqual(visit.headers['set-cookie'], [`__Host-sf_dashboard=${cookieValue(token, 'remote')}; HttpOnly; Secure; SameSite=Strict; Path=/`]);
    const cookie = `__Host-sf_dashboard=${cookieValue(token, 'remote')}`;
    const root = `http://127.0.0.1:${dashboard.remotePort}`;
    for (const path of ['/', '/api/jobs', '/core.js']) {
      assert.equal((await fetchRaw(`${root}${path}`, { host: 'pc.tail1234.ts.net', headers: { ...LOGIN, cookie } })).status, 200, path);
    }
    // Each side's cookie works on its own port only.
    const local = `sf_dashboard_${base.port}=${cookieValue(token, 'local')}`;
    assert.equal((await fetchRaw(`${root}/api/jobs`, { host: 'pc.tail1234.ts.net', headers: { ...LOGIN, cookie: local } })).status, 404);
    assert.equal((await fetchRaw(new URL('/api/jobs', base), { headers: { cookie } })).status, 404);
    assert.equal((await fetchRaw(new URL('/api/jobs', base), { headers: { cookie: local } })).status, 200);

    // remote: true on the remote port, false locally, in api/jobs and in the stream's jobs events.
    assert.equal(JSON.parse((await fetchRaw(new URL('api/jobs', remote), { host: 'pc.tail1234.ts.net', headers: LOGIN })).body).remote, true);
    assert.equal(JSON.parse((await fetchRaw(new URL('api/jobs', base))).body).remote, false);
    const stream = await openStream(new URL('api/stream', base));
    assert.equal((await stream.next('jobs')).remote, false);
    stream.close();
    // SF-139: the job's detail names the actions that ask for the ticket from another device, the
    // confirm routes of POST_ROUTES, on both ports alike.
    const confirmActions = (Object.keys(POST_ROUTES) as RouteName[]).filter((name) => POST_ROUTES[name].confirm === true);
    assert.deepEqual(confirmActions, ['approve', 'retry', 'archive', 'mr-create', 'mr-merge', 'handed-done-merged']);
    assert.deepEqual(JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', remote), { host: 'pc.tail1234.ts.net', headers: LOGIN })).body).confirm_actions, confirmActions);
    assert.deepEqual(JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body).confirm_actions, confirmActions);

    // The local port as before SF-118: the Tailscale Host and Origin are a 403; Tailscale-User-*
    // changes nothing (no login is needed, a listed one opens nothing more).
    assert.equal((await fetchRaw(new URL('api/jobs', base), { host: 'pc.tail1234.ts.net', headers: LOGIN })).status, 403);
    assert.equal((await fetchRaw(new URL('api/jobs', base), { headers: { ...LOGIN, origin: REMOTE } })).status, 403);
    assert.equal((await act(base, 'api/jobs/app/T-1/approve', {}, { headers: { ...LOGIN, origin: REMOTE } })).status, 403);
    const tagged = await fetchRaw(new URL('api/jobs', base), { headers: { 'tailscale-user-login': 'mallory@github' } });
    assert.deepEqual([tagged.status, JSON.parse(tagged.body).remote], [200, false]);
    const bare = await fetchRaw(new URL('api/jobs/app/T-1/approve', base), { method: 'POST', headers: { ...LOGIN, 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual([bare.status, JSON.parse(bare.body).error.message], [403, `Actions need the Origin http://127.0.0.1:${base.port}.`]);
  } finally {
    await dashboard.close();
  }

  // Without the option: no remote listener, no remote URL, the Tailscale Host and Origin refused.
  await withDashboard('dash-remote-off', fakeActions(), async (plain) => {
    assert.deepEqual([plain.remoteUrls, plain.remotePort], [[], undefined]);
    assert.equal((await fetchRaw(new URL('api/jobs', plain.url), { host: 'pc.tail1234.ts.net' })).status, 403);
  });
});

test('dashboard (SF-126): SF_DASHBOARD_REMOTE_LOGINS is required with remote origins, SF_DASHBOARD_REMOTE_PORT differs from SF_DASHBOARD_PORT unless both are 0; a busy remote port is port_in_use', async () => {
  assert.deepEqual(dashboardRemoteLogins([], {}), []);
  assert.deepEqual(dashboardRemoteLogins([REMOTE], { SF_DASHBOARD_REMOTE_LOGINS: ' Alice@GitHub , bob@example.com,alice@github,' }), ['alice@github', 'bob@example.com']);
  const invalid = (code: string, text: string) => (error: unknown): boolean => {
    assert.ok(error instanceof FactoryError);
    assert.equal(error.code, code);
    assert.ok(error.message.includes(text), error.message);
    return true;
  };
  for (const value of [undefined, '', ' , ']) {
    assert.throws(() => dashboardRemoteLogins([REMOTE], value === undefined ? {} : { SF_DASHBOARD_REMOTE_LOGINS: value }), invalid('invalid_config', 'SF_DASHBOARD_REMOTE_LOGINS'));
  }
  assert.throws(() => checkDashboardPorts(8790, 8790), invalid('invalid_config', 'SF_DASHBOARD_REMOTE_PORT'));
  checkDashboardPorts(0, 0);
  checkDashboardPorts(8788, 8789);

  const store = await fixture('dash-remote-config');
  await assert.rejects(startDashboard(0, store.state, store.jobs, fakeActions(), undefined, { remoteOrigins: [REMOTE], remotePort: 0 }), invalid('invalid_config', 'SF_DASHBOARD_REMOTE_LOGINS'));
  await assert.rejects(startDashboard(8790, store.state, store.jobs, fakeActions(), undefined, { remoteOrigins: [REMOTE], remoteLogins: ['alice@github'], remotePort: 8790 }), invalid('invalid_config', 'SF_DASHBOARD_REMOTE_PORT'));
  // The remote port taken: port_in_use naming SF_DASHBOARD_REMOTE_PORT; the local listener is closed again.
  const first = await startDashboard(0, store.state, store.jobs, fakeActions());
  try {
    await assert.rejects(
      startDashboard(0, store.state, store.jobs, fakeActions(), undefined, { remoteOrigins: [REMOTE], remoteLogins: ['alice@github'], remotePort: Number(first.url.port) }),
      invalid('port_in_use', `Port ${first.url.port} on 127.0.0.1 is already in use. Set SF_DASHBOARD_REMOTE_PORT to a free port.`),
    );
  } finally {
    await first.close();
  }
});

test('dashboard (SF-126): a token visit sets the local cookie; with it the page and the API work at the root; a wrong cookie, another port\'s or one of a rotated token is a 404', async () => {
  const store = await fixture('dash-cookie');
  const fake = fakeActions();
  let dashboard = await startDashboard(0, store.state, store.jobs, fake);
  const port = Number(dashboard.url.port);
  try {
    const base = dashboard.url;
    const token = base.pathname.split('/')[2]!;
    const visit = await fetchRaw(base);
    assert.equal(visit.status, 200);
    assert.match(visit.body, /<script src="core.js"/);
    assert.deepEqual(visit.headers['set-cookie'], [`sf_dashboard_${port}=${cookieValue(token, 'local')}; HttpOnly; SameSite=Strict; Path=/`]);
    // Only the page's visit sets it.
    assert.equal((await fetchRaw(new URL('api/jobs', base))).headers['set-cookie'], undefined);
    const cookie = `sf_dashboard_${port}=${cookieValue(token, 'local')}`;
    const root = `http://127.0.0.1:${port}`;
    for (const value of [cookie, `other=1; ${cookie}; more=2`]) {
      for (const path of ['/', '/api/jobs', '/core.js', '/api/jobs/app/T-1', '/api/tickets']) {
        const reply = await fetchRaw(`${root}${path}`, { headers: { cookie: value } });
        assert.equal(reply.status, 200, `${path} ${value}`);
        assert.equal(reply.headers['set-cookie'], undefined, path);
      }
    }
    // The actions with the cookie: the same checks (the exact Origin, the body).
    assert.equal((await act(new URL(`${root}/`), 'api/jobs/app/T-1/approve', {}, { headers: { cookie } })).status, 200);
    assert.deepEqual(fake.calls, [['approve', 'app', 'T-1']]);
    const noOrigin = await fetchRaw(`${root}/api/jobs/app/T-1/approve`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual([noOrigin.status, JSON.parse(noOrigin.body).error.code], [403, 'invalid_origin']);
    assert.equal(fake.calls.length, 1);
    // Wrong: another value, another port's name, the remote name, no cookie.
    const flipped = cookieValue(token, 'local').replace(/.$/, (last) => (last === '0' ? '1' : '0'));
    for (const value of [`sf_dashboard_${port}=${flipped}`, `sf_dashboard_${port + 1}=${cookieValue(token, 'local')}`, `__Host-sf_dashboard=${cookieValue(token, 'local')}`,
      `sf_dashboard_${port}=${cookieValue(token, 'remote')}`, `sf_dashboard_${port}=`, `sf_dashboard_${port}=${token}`, '']) {
      for (const path of ['/', '/api/jobs']) {
        const reply = await fetchRaw(`${root}${path}`, { headers: value === '' ? {} : { cookie: value } });
        assert.deepEqual([reply.status, reply.body], [404, ''], `${path} ${value}`);
      }
    }

    // A restart keeps the cookie; after sf dashboard --rotate (the file removed) the next start's
    // token makes it a 404, and the new token's visit sets another one.
    await dashboard.close();
    dashboard = await startDashboard(port, store.state, store.jobs, fake);
    assert.equal((await fetchRaw(`${root}/api/jobs`, { headers: { cookie } })).status, 200);
    await dashboard.close();
    await removeToken(store.state);
    dashboard = await startDashboard(port, store.state, store.jobs, fake);
    assert.deepEqual([(await fetchRaw(`${root}/api/jobs`, { headers: { cookie } })).status, (await fetchRaw(`${root}/`, { headers: { cookie } })).status], [404, 404]);
    const fresh = await fetchRaw(dashboard.url);
    const renewed = dashboard.url.pathname.split('/')[2]!;
    assert.notEqual(renewed, token);
    assert.deepEqual(fresh.headers['set-cookie'], [`sf_dashboard_${port}=${cookieValue(renewed, 'local')}; HttpOnly; SameSite=Strict; Path=/`]);
  } finally {
    await dashboard.close();
  }
});

test('dashboard (SF-040): no reviewer or subscription in the data; the subscriptions, test event and nudge routes are gone', async () => {
  await withDashboard('dash-no-reviewer', fakeActions(), async (dashboard) => {
    const base = dashboard.url;
    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body);
    assert.deepEqual(Object.keys(detail).sort(), ['confirm_actions', 'explanation', 'gate', 'history', 'iterations', 'job', 'ledger', 'mr', 'mr_title', 'settle_ids']);
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
    workspace: 'web', ticket: 'W-1', branch: 'W-1-demo', base: 'main', continues: null, base_commit: base, target_commit: null,
    worktree: null, prepared_commit: null, mr_attempts: 0, mr_conflict_turn: false, fixes: 1, gate_fixes: 0, gate_tokens: 0, state: 'awaiting_review', iteration: 2, session_id: 's1', mr: null,
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
