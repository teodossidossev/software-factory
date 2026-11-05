// The Task check in static/app.js (SF-054), under node:vm against the fake page of
// test/support/fake-dom.ts: the Queue card's check note and Check (one POST, off while a check runs),
// the Start confirmation's note (not checked, stale, not ready: N blocker, M major; none for a
// ready check), and the last check in the Task drawer and the job's Task tab: the stale mark, the
// paraphrase above the findings, by severity. Start stays on whatever the check says.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
process.env.TZ = 'Europe/Sofia';

const summary = (extra: Record<string, unknown> = {}) => ({ state: 'none', stale: false, running: false, blockers: 0, majors: 0, nits: 0, ended_at: null, start_note: 'not checked', ...extra });

function ticket(name: string, extra: Record<string, unknown> = {}) {
  return { workspace: 'app', ticket: name, title: `Ticket ${name}`, base: 'main', draft: false, request: null, job: null, conversation: { message: 'm', url: null }, ...extra };
}

const VIEW = {
  stale: true, running: false, current_sha256: 'b'.repeat(64),
  check: {
    workspace: 'app', ticket: 'T-1', sha256: 'a'.repeat(64), status: 'checked', error: null, model: 'fake-model', cost_usd: 0.01,
    started_at: '2026-11-05T10:00:00.000Z', ended_at: '2026-11-05T10:03:00.000Z',
    output: {
      paraphrase: 'The Task greets the reader.',
      findings: [
        { kind: 'unclear', severity: 'nit', where: '## Title', problem: 'Vague.', expected: 'Name it.' },
        { kind: 'contradiction', severity: 'blocker', where: 'README.md:1', problem: 'It says hello.', expected: 'Describe it as it is.' },
      ],
      files: [{ path: 'README.md', action: 'modify' }],
      verdict: 'not_ready',
    },
  },
};

async function openBoard(tickets: ReturnType<typeof ticket>[], get: (path: string) => unknown = () => undefined, jobs: unknown[] = [], hash = ''): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs } : get(path)));
  page.location.hash = hash;
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs });
  stream.emit('workspaces', { workspaces: [{ name: 'app', path: '/srv/app', liveJobs: 0, problem: null }] });
  stream.emit('tickets', { tickets, archived: [] });
  await page.flush();
  return page;
}

const card = (page: Page, key: string): FakeElement => page.$('qlist').children.find((child) => (child as FakeElement).dataset?.ticket === key) as FakeElement;
const button = (item: FakeElement, label: string): FakeElement | undefined => item.all().find((element) => element.tagName === 'BUTTON' && element.textContent === label);
// The check note on the card's right side (SF-077).
const note = (item: FakeElement): string => item.all().find((element) => element.className === 'money')!.textContent;
const posts = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'POST');

test('check client: the card\'s check note and Check: one POST, off while the check runs; none for a draft or without the Task checks', async () => {
  const page = await openBoard([
    ticket('T-1', { check: summary() }),
    ticket('T-2', { check: summary({ state: 'not_ready', blockers: 2, majors: 1, start_note: 'not ready: 2 blocker, 1 major' }) }),
    ticket('T-3', { check: summary({ state: 'ready', stale: true, start_note: 'stale' }) }),
    ticket('T-4', { check: summary({ running: true }) }),
    ticket('T-5', { draft: true, check: summary() }),
    ticket('T-6'),
    ticket('T-7', { check: summary({ state: 'ready', start_note: null }) }),
    ticket('T-8', { check: summary({ state: 'failed', start_note: 'check failed' }) }),
    ticket('T-9', { check: summary({ state: 'not_ready', stale: true, blockers: 1, majors: 0, start_note: 'stale' }) }),
  ]);
  assert.deepEqual(['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6', 'T-7', 'T-8', 'T-9'].map((name) => note(card(page, `app/${name}`))),
    ['not checked', 'not ready: 2 blocker, 1 major', 'check: ready · stale', 'checking…', 'draft', 'not checked', 'check: ready', 'check failed', 'not ready: 1 blocker, 0 major · stale']);
  assert.deepEqual(['T-1', 'T-4'].map((name) => button(card(page, `app/${name}`), 'Check')!.disabled), [false, true]);
  assert.deepEqual(['T-5', 'T-6'].map((name) => button(card(page, `app/${name}`), 'Check')), [undefined, undefined]);

  button(card(page, 'app/T-1'), 'Check')!.click();
  await page.flush();
  assert.deepEqual([posts(page).length, posts(page)[0]!.path, posts(page)[0]!.body], [1, 'api/tickets/app/T-1/check', '{}']);
  assert.equal(button(card(page, 'app/T-1'), 'Check')!.disabled, true);
  button(card(page, 'app/T-1'), 'Check')!.click();
  await page.flush();
  assert.equal(posts(page).length, 1);
  posts(page)[0]!.respond(200, { ok: true, result: { started: true, sha256: 'a'.repeat(64) } });
  await page.flush();
  assert.match(page.$('toast-text').textContent, /^Checking app\/T-1: .* It only advises: Start stays yours\.$/);
  // Start is never off for the check.
  assert.deepEqual(['T-1', 'T-2', 'T-3', 'T-4'].map((name) => button(card(page, `app/${name}`), 'Start')!.disabled), [false, false, false, false]);
});

test('check client: Start\'s confirmation says not checked, stale or not ready: N blocker, M major; nothing for a ready check', async () => {
  const page = await openBoard([
    ticket('T-1', { check: summary() }),
    ticket('T-2', { check: summary({ state: 'not_ready', blockers: 2, majors: 1, start_note: 'not ready: 2 blocker, 1 major' }) }),
    ticket('T-3', { check: summary({ state: 'ready', stale: true, start_note: 'stale' }) }),
    ticket('T-4', { check: summary({ state: 'ready', start_note: null }) }),
    ticket('T-5'),
  ]);
  const confirmText = async (name: string): Promise<string> => {
    button(card(page, `app/${name}`), 'Start')!.click();
    await page.flush();
    const text = page.$('ticket-confirm-text').textContent;
    assert.equal(page.$('ticket-ok').textContent, 'Start the job');
    page.$('ticket-cancel').click();
    await page.flush();
    return text;
  };
  assert.match(await confirmText('T-1'), /comes back to you to approve\. Task check: not checked\.$/);
  assert.match(await confirmText('T-2'), /Task check: not ready: 2 blocker, 1 major\.$/);
  assert.match(await confirmText('T-3'), /Task check: stale\.$/);
  assert.match(await confirmText('T-4'), /comes back to you to approve\.$/);
  assert.match(await confirmText('T-5'), /comes back to you to approve\.$/);
  // Confirmed despite the note: the start goes out.
  button(card(page, 'app/T-2'), 'Start')!.click();
  page.$('ticket-ok').click();
  await page.flush();
  assert.equal(posts(page).at(-1)!.path, 'api/tickets/app/T-2/start');
});

// The check box's lines, in order.
const lines = (page: Page, id: string): string[] => (page.$(id).children as FakeElement[]).map((child) => child.textContent);

test('check client: the Task drawer shows the last check above the Task text: the stale mark, the paraphrase above the findings by severity, the files', async () => {
  const page = await openBoard([ticket('T-1', { check: summary({ state: 'not_ready', stale: true, blockers: 1, ended_at: VIEW.check.ended_at, start_note: 'stale' }) })]);
  card(page, 'app/T-1').click();
  await page.flush();
  page.requests.find((request) => request.path === 'api/tickets/app/T-1/task')!.respond(200, '---\nticket: T-1\n---\n# T-1\n');
  await page.flush();
  page.requests.find((request) => request.path === 'api/tickets/app/T-1/check')!.respond(200, VIEW);
  await page.flush();
  assert.equal(page.$('task-check').hidden, false);
  const shown = lines(page, 'task-check');
  assert.match(shown[0]!, /^Task check: not ready: 1 blocker, 0 major · .* · fake-model$/);
  assert.deepEqual(shown.slice(1), [
    'Stale: the Task file changed since this check.', 'Paraphrase', 'The Task greets the reader.', 'Findings',
    'blocker (1)', 'contradiction README.md:1: It says hello. Expected: Describe it as it is.', 'nit (1)', 'unclear ## Title: Vague. Expected: Name it.',
    'Files', 'modify README.md',
  ]);
  // A check that ends reaches the open drawer: the check is read again.
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('T-1', { check: summary({ state: 'ready', ended_at: '2026-11-05T11:00:00.000Z', start_note: null }) })], archived: [] });
  await page.flush();
  assert.equal(page.requests.filter((request) => request.path === 'api/tickets/app/T-1/check').length, 2);
  page.requests.filter((request) => request.path === 'api/tickets/app/T-1/check')[1]!.respond(200, { check: null, stale: false, running: false, current_sha256: 'b'.repeat(64) });
  await page.flush();
  assert.match(lines(page, 'task-check')[0]!, /^Task check: not checked yet\./);
});

test('check client: the job\'s Task tab shows the last check, a failed one with its error', async () => {
  const job = {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', state: 'working', iteration: 1, mr_attempts: 0,
    updated_at: '2026-11-01T10:05:00.000Z', created_at: '2026-11-01T10:00:00.000Z', error: null, prepared_commit: null, worktree: '/wt/T-1',
    fixes: 0, gate_fixes: 0, gate_tokens: 0, files: 0, undeclared: 0, deleted: 0, title: 'Demo',
  };
  const failed = { ...VIEW, stale: false, check: { ...VIEW.check, status: 'failed', output: null, error: 'The check ended with error_max_turns: limit' } };
  const page = await openBoard([], (path) => {
    if (path === 'api/jobs/app/T-1') {
      return { job, iterations: [], mr: false, gate: true, history: [] };
    }
    return path === 'api/tickets/app/T-1/task' ? '---\nticket: T-1\n---\n' : path === 'api/tickets/app/T-1/check' ? failed : undefined;
  }, [job], '#app/T-1');
  page.streams.at(-1)!.emit('job', { job, iterations: [], mr: false, gate: true, history: [] });
  await page.flush();
  page.$('job-tabs').querySelectorAll('button').find((tab) => tab.dataset.tab === 'task')!.click();
  await page.flush();
  assert.equal(page.$('job-task-check').hidden, false);
  const shown = lines(page, 'job-task-check');
  assert.match(shown[0]!, /^Task check: check failed · /);
  assert.deepEqual(shown.slice(1), ['The check ended with error_max_turns: limit']);
});
