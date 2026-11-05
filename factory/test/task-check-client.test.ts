// The Task check in static/app.js (SF-054), under node:vm against the fake page of
// test/support/fake-dom.ts: the Queue card's check note and Check (one POST, off while a check runs),
// the Start confirmation's note (not checked, stale, not ready: N blocker, M major; none for a
// ready check), the last check in the planned ticket page's Plan check card (SF-081) and behind the
// job's Task toggle (on the implement prompt of its Stream, SF-078): the stale mark, the paraphrase
// and the findings. Start stays on whatever the check says.
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
  // With the run queue (SF-071): the cards sit below "Not queued", each with Add to queue.
  stream.emit('tickets', { tickets: tickets.map((row) => ({ queue_position: null, queue_error: null, ...row })), archived: [], queue: { max_running: 3, running: 0, held: false, hold_reason: null, next: null } });
  await page.flush();
  return page;
}

const card = (page: Page, key: string): FakeElement => page.$('qlist').children.find((child) => (child as FakeElement).dataset?.ticket === key) as FakeElement;
const button = (item: FakeElement, label: string): FakeElement | undefined => item.all().find((element) => element.tagName === 'BUTTON' && element.textContent === label);
// The check note on the card's right side (SF-077).
// The plan-check chip of the card's first line (SF-084: a button that opens the ticket).
const note = (item: FakeElement): string => item.all().find((element) => element.className === 'tag cnote')!.textContent;
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
  // The queue toggle is on every card but the skeleton's.
  assert.deepEqual(['T-1', 'T-5'].map((name) => button(card(page, `app/${name}`), 'Add to queue') !== undefined), [true, false]);

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

// The planned ticket page's Plan check card (SF-081).
const checkCard = (page: Page): FakeElement => page.$('ticket').querySelectorAll('.card2').find((box) => /^Plan check/.test(box.querySelector('h3')?.textContent ?? ''))!;

test('check client: the planned ticket page shows the check in its Plan check card: the stale line, the findings with their kind in words, what the checker understood, the files; a check that ends is read again', async () => {
  const row = ticket('T-1', { check: summary({ state: 'not_ready', stale: true, blockers: 1, ended_at: VIEW.check.ended_at, start_note: 'stale' }) });
  const page = await openBoard([row]);
  card(page, 'app/T-1').click();
  await page.flush();
  page.requests.find((request) => request.path === 'api/tickets/app/T-1/page')!.respond(200, {
    ticket: row, task: { text: '---\nticket: T-1\ntitle: Ticket T-1\nbase: main\n---\n# T-1\n', sha256: 'b'.repeat(64) },
    plan: { starts_from: 'main', files: [], scoped: false, waits_for: [] }, check: VIEW, history: [], queue: null,
  });
  await page.flush();
  const box = checkCard(page);
  assert.equal(box.querySelector('h3')!.textContent, 'Plan check not readystale');
  const paragraphs = box.querySelectorAll('p').map((node) => node.textContent);
  assert.deepEqual(paragraphs, ['The plan changed after this check: check it again.', 'Not ready: 1 blocker, 0 majors.']);
  // The findings in the checker's order: the number, the severity, the kind in words, where, the problem, what is expected.
  assert.deepEqual(box.querySelectorAll('li.finding').map((item) => item.children.map((child) => child.textContent)), [
    ['#1', 'nit', 'unclear', '## TitleVague.', 'Expected: Name it.'],
    ['#2', 'blocker', 'contradicts itself', 'README.md:1It says hello.', 'Expected: Describe it as it is.'],
  ]);
  assert.match(box.textContent, /What the checker understoodThe Task greets the reader\.Show all/);
  assert.equal(box.querySelector('summary')!.textContent, 'Files the checker expects to change (1)');
  assert.equal(box.querySelector('.chipx')!.textContent, '~ README.md');
  assert.match(box.textContent, /· fake-model · \$0\.01/);
  // The header's line and button say it too.
  assert.match(page.$('ticket').querySelector('.t2')!.textContent, /Plan not ready: 1 blocker, 0 majors · the plan changed after this check/);
  assert.equal(page.$('ticket').querySelectorAll('button').find((node) => node.dataset.tk === 'check')!.textContent, 'Check again');

  // A check that ends while the page is open: the tickets refresh, the check is read again at once.
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('T-1', { check: summary({ state: 'ready', ended_at: '2026-11-05T11:00:00.000Z', start_note: null }) })], archived: [] });
  await page.flush();
  const reads = page.requests.filter((request) => request.path === 'api/tickets/app/T-1/check');
  assert.equal(reads.length, 1);
  reads[0]!.respond(200, { ...VIEW, stale: false, check: { ...VIEW.check, sha256: 'b'.repeat(64), ended_at: '2026-11-05T11:00:00.000Z', output: { ...VIEW.check.output, findings: [], verdict: 'ready' } } });
  await page.flush();
  assert.deepEqual(checkCard(page).querySelectorAll('p').map((node) => node.textContent), ['Ready: an Implementer can build this plan without a design decision of its own.']);
  assert.equal(checkCard(page).querySelector('h3')!.textContent, 'Plan check ready');
});

test('check client: the Task toggle of the job\'s implement prompt shows the last check, a failed one with its error', async () => {
  const job = {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', state: 'working', iteration: 1, mr_attempts: 0,
    updated_at: '2026-11-01T10:05:00.000Z', created_at: '2026-11-01T10:00:00.000Z', error: null, prepared_commit: null, worktree: '/wt/T-1',
    fixes: 0, gate_fixes: 0, gate_tokens: 0, files: 0, undeclared: 0, deleted: 0, title: 'Demo',
  };
  const failed = { ...VIEW, stale: false, check: { ...VIEW.check, status: 'failed', output: null, error: 'The check ended with error_max_turns: limit' } };
  const prompt = { k: '2', ts: '2026-11-01T10:00:02.000Z', it: 1, who: 'factory', t: 'prompt', kind: 'implement', text: '/implement .software-factory/T-1.md', first: '/implement .software-factory/T-1.md', task_changed: false };
  const page = await openBoard([], (path) => {
    if (path === 'api/jobs/app/T-1') {
      return { job, iterations: [], mr: false, gate: true, history: [] };
    }
    if (path === 'api/jobs/app/T-1/stream?from=0') {
      return { entries: [prompt], next: 3, end: true };
    }
    return path === 'api/tickets/app/T-1/task' ? '---\nticket: T-1\n---\n' : path === 'api/tickets/app/T-1/check' ? failed : undefined;
  }, [job], '#app/T-1');
  page.streams.at(-1)!.emit('job', { job, iterations: [], mr: false, gate: true, history: [] });
  await page.flush();
  const entry = (page.$('stream').children as FakeElement[]).find((child) => child.dataset.k === '2')!;
  button(entry, 'Task')!.click();
  await page.flush();
  const check = page.$('stream').all().find((element) => element.className === 'task-check')!;
  const shown = check.children.map((child) => child.textContent);
  assert.match(shown[0]!, /^Task check: check failed · /);
  assert.deepEqual(shown.slice(1), ['The check ended with error_max_turns: limit']);
});
