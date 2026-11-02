// The read-only Dashboard: in-process against startDashboard (token, endpoints, the event stream,
// the stream limit, disconnects; the test process must exit by itself afterwards) and end to end
// through `sf serve` with the fake Implementer (a real cycle, approve, SF_DASHBOARD=off, sf dashboard).
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { get, request, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_STREAMS, type RunningDashboard, startDashboard, TOKEN_FILE } from '../src/dashboard.js';
import { type EventRecord, type Job, type JobState, JobStore } from '../src/jobs.js';
import { call, newEnv, newRepo, putTask, runCli, script, serve, stop, temp, waitFor } from './support/harness.js';

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'";

interface Reply {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

function fetchRaw(url: URL | string, options: { method?: string; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(target, { method: options.method ?? 'GET', headers: options.host !== undefined ? { host: options.host } : {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.once('error', reject);
    req.end();
  });
}

interface SseEvent {
  event: string;
  data: any;
}

interface Stream {
  status: number;
  headers: IncomingMessage['headers'];
  events: SseEvent[];
  // The next event of that name after the ones already taken.
  next(event: string, match?: (data: any) => boolean): Promise<any>;
  close(): void;
}

function openStream(url: URL): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      const events: SseEvent[] = [];
      let taken = 0;
      let wake: (() => void) | undefined;
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (name !== undefined && data !== undefined) {
            events.push({ event: name, data: JSON.parse(data) });
            wake?.();
          }
        }
      });
      res.on('error', () => undefined);
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        events,
        async next(event, match = () => true) {
          const deadline = Date.now() + 10_000;
          for (;;) {
            for (; taken < events.length; taken += 1) {
              const candidate = events[taken]!;
              if (candidate.event === event && match(candidate.data)) {
                taken += 1;
                return candidate.data;
              }
            }
            if (Date.now() > deadline) {
              assert.fail(`no ${event} event; got ${JSON.stringify(events.map((item) => item.event))}`);
            }
            await new Promise<void>((done) => {
              wake = done;
              setTimeout(done, 100);
            });
          }
        },
        close() {
          req.destroy();
        },
      });
    });
    req.once('error', reject);
  });
}

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

const stateRecord = (from: JobState | null, to: JobState, ts: string): EventRecord => ({ ts, iteration: 0, state: { from, to } });

async function fixture(name: string): Promise<{ state: string; jobs: JobStore; job: Job }> {
  const state = join(temp, name);
  await mkdir(state, { recursive: true });
  const jobs = new JobStore(state);
  const job: Job = {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', base_commit: null, target_commit: null,
    mr_attempts: 0, state: 'awaiting_review', iteration: 1, session_id: 's1',
    created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:05:00.000Z',
  };
  await jobs.write(job);
  await jobs.write({ ...job, ticket: 'T-0', branch: 'T-0-old', state: 'failed', iteration: 0, error: { code: 'start_failed', message: 'Git failed.' } });
  await jobs.appendEvent('app', 'T-1', stateRecord(null, 'starting', '2026-11-01T10:00:00.000Z'));
  await jobs.appendEvent('app', 'T-1', stateRecord('starting', 'working', '2026-11-01T10:00:01.000Z'));
  await jobs.appendEvent('app', 'T-1', { ts: '2026-11-01T10:00:02.000Z', iteration: 0, prompt: '/implement .software-factory/T-1.md' });
  await jobs.appendEvent('app', 'T-1', {
    ts: '2026-11-01T10:00:03.000Z', iteration: 0,
    message: { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  });
  await jobs.appendEvent('app', 'T-1', { ts: '2026-11-01T10:04:00.000Z', iteration: 0, message: { type: 'result', subtype: 'success', total_cost_usd: 0.5, duration_ms: 2000, num_turns: 3 } });
  await jobs.appendEvent('app', 'T-1', stateRecord('working', 'awaiting_review', '2026-11-01T10:05:00.000Z'));
  await jobs.writeIteration('app', 'T-1', {
    report: '# Report: T-1, iteration 1\n## Done\nThings.\n',
    patch: Buffer.from('diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-hello\n+hello world\n'),
    meta: {
      iteration: 1, started_at: '2026-11-01T10:00:01.000Z', ended_at: '2026-11-01T10:05:00.000Z', denials: ['Bash'],
      changed_files: [{ path: 'README.md', added: 1, removed: 1 }], patch_truncated: false, submodule_changed: [],
      cost_usd: 0.5, cost_usd_total: 0.5, duration_ms: 2000,
    },
  });
  return { state, jobs, job };
}

async function withDashboard(name: string, work: (dashboard: RunningDashboard, store: Awaited<ReturnType<typeof fixture>>) => Promise<void>): Promise<void> {
  const store = await fixture(name);
  const dashboard = await startDashboard(0, store.state, store.jobs);
  try {
    await work(dashboard, store);
  } finally {
    await dashboard.close();
  }
}

test('dashboard: token, static files with the security headers, 404 and 405 with empty bodies', async () => {
  await withDashboard('dash-token', async (dashboard, { state }) => {
    const base = dashboard.url;
    const token = base.pathname.split('/')[2]!;
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(await readFile(join(state, TOKEN_FILE), 'utf8'), `${token}\n`);
    assert.equal((await stat(join(state, TOKEN_FILE))).mode & 0o777, 0o600);

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
  await withDashboard('dash-api', async (dashboard, { jobs }) => {
    const base = dashboard.url;
    const list = await fetchRaw(new URL('api/jobs', base));
    assert.equal(list.headers['content-type'], 'application/json; charset=utf-8');
    const { jobs: all } = JSON.parse(list.body);
    assert.deepEqual(all.map((job: Job) => [job.ticket, job.state]), [['T-0', 'failed'], ['T-1', 'awaiting_review']]);
    assert.deepEqual(Object.keys(all[1]).sort(), ['base', 'branch', 'created_at', 'error', 'iteration', 'mr_attempts', 'state', 'ticket', 'updated_at', 'workspace']);
    assert.deepEqual(all[0].error, { code: 'start_failed', message: 'Git failed.' });

    const detail = JSON.parse((await fetchRaw(new URL('api/jobs/app/T-1', base))).body);
    assert.equal(detail.job.branch, 'T-1-demo');
    assert.equal(detail.mr, false);
    assert.deepEqual(detail.iterations, [{
      number: 1, started_at: '2026-11-01T10:00:01.000Z', ended_at: '2026-11-01T10:05:00.000Z', cost_usd: 0.5,
      changed_files: 1, patch_truncated: false, denials: 1,
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
  await withDashboard('dash-stream', async (dashboard, { jobs, job }) => {
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
    assert.deepEqual(state0, { line: 0, ts: '2026-11-01T10:00:00.000Z', iteration: 0, type: 'state', text: '10:00:00 [0] state - -> starting' });
    await stream.next('event', (event) => event.line === 1);
    assert.equal((await stream.next('event')).type, 'prompt');
    const assistant = await stream.next('event');
    assert.deepEqual([assistant.line, assistant.type], [3, 'assistant']);
    assert.equal(assistant.text, '10:00:03 [0] assistant: Working on it\n10:00:03 [0] tool_use Bash {"command":"npm test"}');
    assert.equal((await stream.next('event')).text, '10:04:00 [0] result success, cost $0.5000, duration 2.0 s, 3 turns');
    assert.equal((await stream.next('event')).line, 5);

    // A line appended while connected arrives as the next event.
    await jobs.appendEvent('app', 'T-1', { ts: '2026-11-01T10:06:00.000Z', iteration: 1, prompt: 'hello from say' });
    assert.deepEqual(await stream.next('event'), { line: 6, ts: '2026-11-01T10:06:00.000Z', iteration: 1, type: 'prompt', text: '10:06:00 [1] > hello from say' });

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

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];

function mrText(header: string): string {
  return [
    header, '', '## What', 'Changes the README.', '## Why', 'The ticket asks for it.', '## How', 'One line.', '## Why the change',
    'Readers need it.', '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', 'npm test: passed',
    '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}

test('dashboard end to end: a fake cycle, the stream across mark_clean, mr after approve, sf dashboard', async () => {
  const env = await newEnv('dash-e2e');
  const repo = await newRepo(env, 'dash-repo', true);
  await putTask(env, repo, 'T-1', 'Change README');
  await script(env, [
    { write: { 'README.md': 'hello world\n' }, tool: true, text: '# Report: T-1, iteration 1\n\n## Done\nChanged.' },
    { write: { '.software-factory/T-1.mr.md': mrText('feat(T-1): Change the README') }, run: [['git', 'add', 'README.md'], ['git', ...ID, 'commit', '-q', '-m', 'feat(T-1): Change the README']], text: 'prepared' },
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
    assert.match(printed.stdout, /The token changes on every sf serve start/);
    assert.equal((await runCli({ ...env, extra: { SF_DASHBOARD: 'off' } }, ['dashboard'])).code, 1);

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
    assert.equal((await stream.next('jobs', (data) => data.jobs[0].state === 'ready_for_human_review')).jobs.length, 1);
    assert.equal((await stream.next('job')).job.state, 'ready_for_human_review');
    await stream.next('event', (event) => event.type === 'state' && event.text.endsWith('awaiting_review -> ready_for_human_review'));
    stream.close();

    const approved = await runCli(env, ['approve', 'app', 'T-1']);
    assert.equal(approved.code, 0, approved.stdout + approved.stderr);
    const mr = await fetchRaw(new URL('api/jobs/app/T-1/mr', base));
    assert.deepEqual([mr.status, mr.body], [200, mrText('feat(T-1): Change the README')]);
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
