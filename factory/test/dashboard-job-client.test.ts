// Behaviour of the job detail in static/app.js (SF-047), inside the job's full page since SF-077, run
// under node:vm against the fake page of test/support/fake-dom.ts: the URL hash that opens it, the
// pipeline per state with the
// halted codes, the next-action panel, the facts and the state history, and the flat tabs Task,
// Changes, Reviews, MR (Copy MR text, the Codex items not applied) and Live log (its filters);
// Accept and prepare MR with its confirmation. The actions shared with the old job card are tested
// in dashboard-client.test.ts. Script checks, not browser acceptance: the manual steps are in
// factory/README.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);

// The page shows local time (SF-049); the zone is set, not the machine's: Sofia is UTC+2 in November.
process.env.TZ = 'Europe/Sofia';

function job(state: string, extra: Record<string, unknown> = {}) {
  const prepared = state === 'ready_for_human_review' || state === 'pushed';
  return {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', state, iteration: 1, mr_attempts: 0,
    updated_at: '2026-11-01T10:05:00.000Z', created_at: '2026-11-01T10:00:00.000Z', error: null,
    prepared_commit: prepared ? 'a'.repeat(40) : null, worktree: prepared ? null : '/wt/T-1',
    fixes: 0, gate_fixes: 0, gate_tokens: 0, files: 0, undeclared: 0, deleted: 0, title: 'Demo', ...extra,
  };
}

type Job = ReturnType<typeof job>;
type Detail = { job: Job; iterations: Array<Record<string, unknown>>; mr: boolean; gate: boolean; history: Array<Record<string, unknown>> };

const times = { started_at: '2026-11-01T10:05:01.000Z', ended_at: '2026-11-01T10:06:00.000Z' };
const META = { started_at: '2026-11-01T10:00:01.000Z', ended_at: '2026-11-01T10:05:00.000Z', cost_usd: 0.5, changed_files: 1, patch_truncated: false, denials: 0, files: null };
const CLEAN = { reviewer: 'claude', verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [], cost_usd: 0.25, ...times };
const CLAUDE_FIX = {
  reviewer: 'claude', verdict: 'fix', summary: 'The greeting is wrong.', accepted_sensitive: [], cost_usd: 0.25,
  items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.' }, { path: 'a.txt', problem: 'Empty.', expected: 'A line.' }], ...times,
};
const GATE_FIX = {
  reviewer: 'codex', verdict: 'fix', summary: 'Not quite.', accepted_sensitive: [], model: 'gpt-x', tokens: { input: 1000, cached_input: 200, output: 100 },
  items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.' }], ...times,
};
const GATE_FAILED = { reviewer: 'codex', error: 'Codex wrote no output.', tokens: { input: 0, cached_input: 0, output: 0 }, ...times };

function iteration(number: number, extra: Record<string, unknown> = {}) {
  return { number, ...META, review: null, gate: null, gate_override: null, ...extra };
}

function detail(row: Job, extra: Partial<Omit<Detail, 'job'>> = {}): Detail {
  return { job: row, iterations: [], mr: false, gate: true, history: [{ ts: '2026-11-01T10:00:00.000Z', from: null, to: 'starting' }], ...extra };
}

// The page with the job of shown open through the URL's hash; get answers the other GETs (undefined
// leaves them pending).
async function openJob(shown: Detail, get: (path: string) => unknown = () => undefined, clipboard?: { writeText(text: string): Promise<void> }, others: Job[] = []): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs: [shown.job, ...others] };
    }
    if (path === 'api/jobs/app/T-1') {
      return shown;
    }
    return get(path);
  }, clipboard);
  page.location.hash = '#app/T-1';
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs: [shown.job, ...others] });
  stream.emit('job', shown);
  await page.flush();
  return page;
}

async function show(page: Page, shown: Detail): Promise<void> {
  page.streams.at(-1)!.emit('job', shown);
  await page.flush();
}

const elements = (page: Page, id: string): FakeElement[] => page.$(id).children as FakeElement[];
const steps = (page: Page): string[] => elements(page, 'job-stepper').map((step) => step.dataset.status!);
const captions = (page: Page): string[] => elements(page, 'job-stepper').map((step) => (step.children[2] as FakeElement).textContent);
const tab = (page: Page, name: string): FakeElement => page.$('job-tabs').querySelectorAll('button').find((button) => button.dataset.tab === name)!;
const texts = (node: FakeElement): string[] => (node.children as FakeElement[]).map((child) => child.textContent);
const posts = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'POST');
const gets = (page: Page, path: string): FetchRequest[] => page.requests.filter((request) => request.method === 'GET' && request.path === path);
const facts = (page: Page): Record<string, string> =>
  Object.fromEntries(elements(page, 'job-facts').map((row) => [(row.children[0] as FakeElement).textContent, (row.children[1] as FakeElement).textContent]));

// The key and the title in the job page's header.
const headTitle = (page: Page): string => (page.$('jhead').children[1] as FakeElement).textContent;

test('job client: the hash opens the job as its full page; a hash change opens another; ← Board clears the hash', async () => {
  const other = { ...job('working'), ticket: 'T-2', branch: 'T-2-demo' };
  const page = await openJob(detail(job('working')), () => undefined, undefined, [other]);
  assert.deepEqual([page.$('job').hidden, page.$('board').hidden, page.$('drawer').hidden, page.$('detail').hidden], [false, true, true, false]);
  assert.equal(page.$('detail').parentNode, page.$('job'));
  assert.deepEqual([page.$('job-ticket').textContent, headTitle(page), page.$('job-branch').textContent], ['T-1', 'T-1Demo', 'T-1-demo']);
  assert.equal(page.location.hash, '#app/T-1');
  assert.equal(page.streams.at(-1)!.url, 'api/stream?job=app%2FT-1&from=0');

  page.location.hash = '#app/T-2';
  page.window.dispatch('hashchange');
  await page.flush();
  assert.equal(page.streams.at(-1)!.url, 'api/stream?job=app%2FT-2&from=0');
  assert.equal(headTitle(page), 'T-2Demo');

  (page.$('jhead').children[0] as FakeElement).click();
  assert.deepEqual([page.$('job').hidden, page.$('board').hidden, page.location.hash], [true, false, '#']);
  // The drawer is left for Workspaces, New ticket, Archived and a planned ticket's Task.
  page.$('open-workspaces').click();
  assert.deepEqual([page.$('drawer').hidden, page.$('drawer').className, page.$('detail').hidden], [false, 'drawer', true]);
});

test('job client: the pipeline stepper for each state: done, current with since when, halted with the code and a sentence, the gate off', async () => {
  const page = await openJob(detail(job('starting')));
  const halt = page.$('job-halt');
  const reviewed = (review: unknown, extra: Record<string, unknown> = {}) => [iteration(1, { review, ...extra })];
  const cases: Array<[string, Record<string, unknown>, Array<Record<string, unknown>>, string[], RegExp | null]> = [
    ['starting', {}, [], ['current', 'todo', 'todo', 'todo', 'todo'], null],
    ['working', {}, [], ['current', 'todo', 'todo', 'todo', 'todo'], null],
    ['awaiting_review', {}, reviewed(null), ['done', 'current', 'todo', 'todo', 'todo'], null],
    ['awaiting_review', {}, reviewed(CLEAN), ['done', 'done', 'current', 'todo', 'todo'], null],
    ['preparing_mr', {}, reviewed(CLEAN), ['done', 'done', 'done', 'current', 'todo'], null],
    ['ready_for_human_review', {}, reviewed(CLEAN), ['done', 'done', 'done', 'done', 'current'], null],
    ['pushed', {}, reviewed(CLEAN), ['done', 'done', 'done', 'done', 'done'], null],
    ['needs_human', { error: { code: 'review_failed', message: 'x' } }, reviewed({ reviewer: 'claude', error: 'x' }), ['done', 'halted', 'todo', 'todo', 'todo'],
      /^review_failed The Claude review could not run\. Retry it\.$/],
    ['needs_human', { error: { code: 'gate_rounds', message: 'x' } }, reviewed(CLEAN, { gate: GATE_FIX }), ['done', 'done', 'halted', 'todo', 'todo'],
      /^gate_rounds Codex asked for fixes more often than the round limit allows\. Accept and prepare the MR, tell the Implementer what to do, or abort\.$/],
    ['needs_human', { error: { code: 'gate_budget', message: 'x' } }, reviewed(CLAUDE_FIX), ['done', 'done', 'halted', 'todo', 'todo'],
      /^gate_budget The gate used up its token budget for this job\. Tell the Implementer what to do, or abort\.$/],
    ['needs_human', { error: { code: 'gate_failed', message: 'x' } }, reviewed(CLEAN, { gate: GATE_FAILED }), ['done', 'done', 'halted', 'todo', 'todo'],
      /^gate_failed The Codex gate stopped without a verdict\. Accept and prepare the MR/],
    ['needs_human', { error: { code: 'iteration_limit', message: 'x' } }, reviewed(CLAUDE_FIX), ['halted', 'todo', 'todo', 'todo', 'todo'],
      /^iteration_limit The reviewers asked for fixes too many times\./],
    ['needs_human', { error: { code: 'mr_conflict', message: 'x' }, mr_attempts: 1 }, reviewed(CLEAN), ['done', 'done', 'done', 'halted', 'todo'],
      /^mr_conflict The rebase onto main conflicts and the Implementer could not resolve it\. Tell it how, or abort\.$/],
    ['needs_human', { error: { code: 'mr_push_failed', message: 'x' }, prepared_commit: 'b'.repeat(40), worktree: null }, reviewed(CLEAN), ['done', 'done', 'done', 'done', 'halted'],
      /^mr_push_failed The push failed\. Fix the cause, then approve again\.$/],
    ['failed', { error: { code: 'serve_restarted', message: 'x' } }, [], ['halted', 'todo', 'todo', 'todo', 'todo'], /^serve_restarted The job failed and cannot go on; restart or archive it\.$/],
  ];
  for (const [state, extra, iterations, expected, sentence] of cases) {
    const label = `${state} ${JSON.stringify(extra.error ?? null)}`;
    await show(page, detail(job(state, extra), { iterations }));
    assert.deepEqual(steps(page), expected, label);
    assert.equal(elements(page, 'job-stepper').map((step) => (step.children[1] as FakeElement).textContent).join(','), 'Implement,Claude review,Codex gate,MR preparation,You');
    const current = expected.findIndex((status) => status === 'current' || status === 'halted');
    if (current >= 0) {
      assert.equal(elements(page, 'job-stepper')[current]!.getAttribute('aria-current'), 'step', label);
    }
    assert.equal(halt.hidden, sentence === null, label);
    if (sentence !== null) {
      assert.match(halt.textContent, sentence, label);
      assert.equal(captions(page)[current], (extra.error as { code: string }).code, label);
    }
  }
  // The current step says since when; the Codex gate since the end of the Claude review.
  await show(page, detail(job('working')));
  assert.match(captions(page)[0]!, /^since 12:05 \(.+\)$/);
  // The exact UTC moment on hover.
  assert.equal((elements(page, 'job-stepper')[0]!.children[2] as FakeElement).getAttribute('title'), '2026-11-01T10:05:00.000Z');
  await show(page, detail(job('awaiting_review'), { iterations: reviewed(CLEAN) }));
  assert.match(captions(page)[2]!, /^since 12:06 \(.+\)$/);
  // The gate off; the gate overridden by the user.
  await show(page, detail(job('preparing_mr'), { iterations: reviewed(CLEAN), gate: false }));
  assert.deepEqual([steps(page), captions(page)[2]], [['done', 'done', 'off', 'current', 'todo'], 'off']);
  await show(page, detail(job('ready_for_human_review'), { iterations: reviewed(CLEAN, { gate: GATE_FIX, gate_override: { at: times.ended_at, code: 'gate_rounds', unapplied: GATE_FIX.items } }) }));
  assert.deepEqual([steps(page)[2], captions(page)[2]], ['done', 'overridden by you']);
  // A later iteration the gate reviewed again: the override no longer stands.
  await show(page, detail(job('ready_for_human_review', { iteration: 2 }), {
    iterations: [...reviewed(CLEAN, { gate: GATE_FIX, gate_override: { at: times.ended_at, code: 'gate_rounds', unapplied: GATE_FIX.items } }), iteration(2, { review: CLEAN, gate: { ...GATE_FIX, verdict: 'clean', items: [] } })],
  }));
  assert.deepEqual([steps(page)[2], captions(page)[2]], ['done', '']);
});

test('job client: the next-action panel says who acts now and offers the actions that move the job on; the facts and the history', async () => {
  const page = await openJob(detail(job('working')));
  const visible = (): string[] => ['approve-button', 'accept-gate-button', 'retry-review-button', 'abort-button', 'archive-job-button']
    .filter((id) => !page.$(id).hidden && !page.$(id).disabled);
  const cases: Array<[Job, Array<Record<string, unknown>>, RegExp, string, string[]]> = [
    [job('starting'), [], /^Now · Implementer · for /, 'The worktree is being created and the Implementer starts.', ['abort-button']],
    [job('working', { iteration: 1 }), [], /^Now · Implementer/, 'The Implementer is working on iteration 2.', ['abort-button']],
    [job('awaiting_review'), [iteration(1)], /^Now · Claude review/, 'Claude is reviewing iteration 1.', ['abort-button']],
    [job('awaiting_review'), [iteration(1, { review: CLEAN })], /^Now · Codex gate/, 'Codex is reviewing iteration 1.', ['abort-button']],
    [job('preparing_mr'), [iteration(1, { review: CLEAN })], /^Now · Factory/, 'The factory commits the change and rebases it onto main.', ['abort-button']],
    [job('ready_for_human_review'), [iteration(1, { review: CLEAN })], /^Your turn/, 'The branch is ready: approve to push it, or create the merge request (push and open it), or abort.', ['approve-button', 'abort-button']],
    [job('needs_human', { error: { code: 'review_failed', message: 'No output.' } }), [iteration(1, { review: { reviewer: 'claude', error: 'No output.' } })], /^Your turn/,
      'The Claude review could not run. Retry it.', ['retry-review-button', 'abort-button']],
    [job('needs_human', { error: { code: 'gate_rounds', message: 'Three rounds.' } }), [iteration(1, { review: CLEAN, gate: GATE_FIX })], /^Your turn/,
      'Codex asked for fixes more often than the round limit allows. Accept and prepare the MR, tell the Implementer what to do, or abort.', ['accept-gate-button', 'abort-button']],
    [job('needs_human', { error: { code: 'mr_push_failed', message: 'Rejected.' }, prepared_commit: 'b'.repeat(40), worktree: null }), [iteration(1, { review: CLEAN })], /^Your turn/,
      'The push failed. Fix the cause, then approve again.', ['approve-button', 'abort-button']],
    [job('pushed'), [iteration(1, { review: CLEAN })], /^Finished$/, 'Pushed T-1-demo.', ['archive-job-button']],
    [job('aborted'), [], /^Finished$/, 'Aborted.', ['archive-job-button']],
  ];
  for (const [row, iterations, who, headline, actions] of cases) {
    await show(page, detail(row, { iterations }));
    const label = `${row.state} ${JSON.stringify(row.error)}`;
    assert.match(page.$('next-who').textContent, who, label);
    assert.equal(page.$('next-headline').textContent, headline, label);
    assert.deepEqual(visible(), actions, label);
  }
  // needs_human names the error as it came.
  await show(page, detail(job('needs_human', { error: { code: 'iteration_limit', message: 'Five fix rounds.' } })));
  assert.equal(page.$('next-why').textContent, 'iteration_limit: Five fix rounds.');

  // The facts, stacked; the cost counts the iterations and their Claude reviews.
  await show(page, detail(job('working', { iteration: 2, fixes: 2, gate_fixes: 1, gate_tokens: 1500 }), {
    iterations: [iteration(1, { review: { ...CLAUDE_FIX, cost_usd: 0.125 } }), iteration(2, { cost_usd: 0.75, review: null })],
  }));
  assert.deepEqual(facts(page), {
    Base: 'main', Iteration: '2', 'Fix sections': '2', 'Gate rounds': '1', 'Gate tokens': '1500', 'Estimated cost': 'est. $1.3750',
    Updated: '2026-11-01 12:05:00', Worktree: '/wt/T-1',
  });
  const updated = (elements(page, 'job-facts').find((row) => row.textContent.startsWith('Updated'))!.children[1] as FakeElement).children[0] as FakeElement;
  assert.deepEqual([updated.tagName, updated.getAttribute('datetime'), updated.getAttribute('title')], ['TIME', '2026-11-01T10:05:00.000Z', '2026-11-01T10:05:00.000Z']);

  // The state history, compact, with the user's override of the gate.
  await show(page, detail(job('preparing_mr'), {
    history: [
      { ts: '2026-11-01T10:00:00.000Z', from: null, to: 'starting' },
      { ts: '2026-11-01T10:20:00.000Z', from: 'awaiting_review', to: 'needs_human', error: { code: 'gate_rounds', message: 'Three rounds.' } },
      { ts: '2026-11-01T10:30:00.000Z', event: 'gate_overridden', code: 'gate_rounds', unapplied: 2 },
      { ts: '2026-11-04T10:14:25.668Z', from: 'needs_human', to: 'preparing_mr' },
      // A record without a time: the server sends String(undefined); it shows no time.
      { ts: 'undefined', from: 'preparing_mr', to: 'ready_for_human_review' },
    ],
  }));
  // Local date and time; the exact UTC moment in the datetime and the title of the <time>.
  assert.deepEqual(texts(page.$('history')), [
    '2026-11-01 12:00:00- → starting', '2026-11-01 12:20:00awaiting_review → needs_human gate_rounds',
    '2026-11-01 12:30:00gate overridden by you (gate_rounds): 2 Codex items not applied', '2026-11-04 12:14:25needs_human → preparing_mr',
    'preparing_mr → ready_for_human_review',
  ]);
  const time = elements(page, 'history')[3]!.children[0] as FakeElement;
  assert.deepEqual([time.tagName, time.getAttribute('datetime'), time.getAttribute('title')], ['TIME', '2026-11-04T10:14:25.668Z', '2026-11-04T10:14:25.668Z']);
  assert.equal((elements(page, 'history')[1]!.children[2] as FakeElement).getAttribute('title'), 'Three rounds.');
});

test('job client: the tabs are flat; the selected one is kept across jobs; the Task tab shows the Task file as text, Fix sections included', async () => {
  const task = '---\nticket: T-1\n---\n# T-1: Demo\n<script>alert(1)</script>\n## Fix 1\n\nReview by Codex: x\n';
  const other = { ...job('working'), ticket: 'T-2', branch: 'T-2-demo' };
  const page = await openJob(detail(job('working', { fixes: 1 })), (path) => (path === 'api/tickets/app/T-1/task' ? task : undefined), undefined, [other]);
  const tabs = page.$('job-tabs').querySelectorAll('button');
  assert.deepEqual(tabs.map((button) => button.textContent), ['Task', 'Changes', 'Reviews', 'MR', 'Live log']);
  assert.deepEqual(tabs.map((button) => button.getAttribute('aria-selected')), ['false', 'true', 'false', 'false', 'false']);
  assert.deepEqual(['task', 'changes', 'reviews', 'mr', 'log'].map((name) => page.$(`tab-${name}`).hidden), [true, false, true, true, true]);
  // The Task file is read when its tab opens.
  assert.equal(gets(page, 'api/tickets/app/T-1/task').length, 0);
  tab(page, 'task').click();
  await page.flush();
  assert.deepEqual(['task', 'changes', 'reviews', 'mr', 'log'].map((name) => page.$(`tab-${name}`).hidden), [false, true, true, true, true]);
  assert.equal(page.$('job-task-path').textContent, '.software-factory/T-1.md');
  assert.equal(page.$('job-task').textContent, `${task}\n`);
  assert.ok(page.$('job-task').all().every((node) => node.tagName === 'SPAN'));
  assert.deepEqual(page.$('job-task').all().filter((node) => node.className === 'heading').map((node) => node.textContent), ['# T-1: Demo\n', '## Fix 1\n']);
  // Read again only when a Fix section is written.
  await show(page, detail(job('awaiting_review', { fixes: 1 })));
  assert.equal(gets(page, 'api/tickets/app/T-1/task').length, 1);
  await show(page, detail(job('working', { fixes: 2 })));
  assert.equal(gets(page, 'api/tickets/app/T-1/task').length, 2);

  // Another job keeps the tab and reads its own Task file.
  page.location.hash = '#app/T-2';
  page.window.dispatch('hashchange');
  await page.flush();
  page.streams.at(-1)!.emit('job', detail(other));
  await page.flush();
  assert.equal(tab(page, 'task').getAttribute('aria-selected'), 'true');
  assert.equal(gets(page, 'api/tickets/app/T-2/task').length, 1);
});

// SF-053: a file outside the Task's scope carries an "out of scope" mark; the summary counts them.
test("job client: a file outside the Task's scope is marked out of scope in the file list and counted in the summary", async () => {
  const files = [
    { path: 'src/a.ts', status: 'added', sensitive: 'no', scope: 'in', additions: 1, deletions: 0 },
    { path: 'notes.txt', status: 'added', sensitive: 'no', scope: 'out', additions: 1, deletions: 0 },
    { path: '.editorconfig', status: 'added', sensitive: 'undeclared', scope: 'out', additions: 1, deletions: 0 },
    { path: 'old.ts', status: 'modified', sensitive: 'no', scope: 'none', additions: 1, deletions: 1 },
  ];
  const shown = detail(job('awaiting_review', { iteration: 1, files: 4, undeclared: 1 }), { iterations: [iteration(1, { changed_files: 4, files })] });
  const page = await openJob(shown, (path) => (path.endsWith('/report') ? 'Done.' : path.endsWith('/patch') ? '' : undefined));
  assert.equal(page.$('files-summary').textContent, 'Files 4 · 1 sensitive undeclared · 2 out of scope');
  const rows = elements(page, 'files-list').filter((item) => item.className !== 'file-group').map((item) => item.children[0] as FakeElement);
  const marks = (path: string): string[] => rows.find((row) => row.dataset.path === path)!.all().filter((element) => element.className.startsWith('file-label ')).map((element) => element.textContent);
  assert.deepEqual(marks('notes.txt'), ['out of scope']);
  assert.deepEqual(marks('.editorconfig'), ['sensitive, undeclared', 'out of scope']);
  assert.deepEqual(marks('src/a.ts'), []);
  assert.deepEqual(marks('old.ts'), []);
});

// The Changes tab: the iteration picker, the Report, the file list (SF-024's order and marks) next
// to the Patch; a file click marks and scrolls its diff.
test('job client: Changes shows the Report, the files with their marks next to the Patch; a file click scrolls to its diff', async () => {
  const files = [
    { path: 'src/zeta.ts', status: 'modified', sensitive: 'no', additions: 2, deletions: 1 },
    { path: 'package.json', status: 'modified', sensitive: 'declared', additions: 1, deletions: 1 },
    { path: 'src/old.ts', status: 'deleted', sensitive: 'no', additions: 0, deletions: 3 },
    { path: '.github/workflows/ci.yml', status: 'added', sensitive: 'undeclared', additions: 5, deletions: 0 },
    { path: 'lib/alpha.ts', status: 'added', sensitive: 'no', additions: 1, deletions: 0 },
    { path: 'img.png', status: 'added', sensitive: 'no', additions: 0, deletions: 0 },
  ];
  const patch = [
    'diff --git a/src/zeta.ts b/src/zeta.ts', 'index 1..2 100644', '--- a/src/zeta.ts', '+++ b/src/zeta.ts', '@@ -1,2 +1,3 @@', '-old', '+new', '+more', ' same',
    'diff --git a/src/old.ts b/src/old.ts', 'deleted file mode 100644', '--- a/src/old.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-a', '-b', '-c',
    'diff --git a/lib/alpha.ts b/lib/alpha.ts', 'new file mode 100644', '--- /dev/null', '+++ b/lib/alpha.ts', '@@ -0,0 +1 @@', '+alpha', '',
  ].join('\n');
  const counts = { files: 6, undeclared: 1, deleted: 1 };
  const shown = detail(job('awaiting_review', { iteration: 2, ...counts }), {
    iterations: [iteration(1, { files: [] }), iteration(2, { changed_files: 6, files })],
  });
  const page = await openJob(shown, (path) => {
    if (path === 'api/jobs/app/T-1/iterations/2/patch') {
      return patch;
    }
    return path.endsWith('/report') ? `# Report of ${path.split('/')[5]}\nDone.` : undefined;
  });
  assert.equal(tab(page, 'changes').textContent, 'Changes6');
  assert.deepEqual(page.$('job-badges').all().map((element) => `${element.className}:${element.textContent}`), ['badge f-count:6 files', 'badge f-undeclared:1 sensitive', 'badge f-deleted:1 deleted']);
  // The newest iteration, picked from the iterations.
  assert.deepEqual(page.$('iteration-picker').querySelectorAll('button').map((button) => [button.textContent, button.getAttribute('aria-pressed')]), [
    ['Iteration 1', 'false'], ['Iteration 2 · Fix 1', 'true'],
  ]);
  assert.equal(page.$('iteration-report').textContent, '# Report of 2\nDone.\n');
  // The iteration's start and end in local time, the UTC moments on the <time> elements.
  assert.equal(page.$('iteration-meta').textContent, '2026-11-01 12:00:01 – 2026-11-01 12:05:00, cost $0.5000, 6 changed file(s), 0 denial(s)');
  assert.deepEqual(page.$('iteration-meta').all().map((element) => element.getAttribute('datetime')), [META.started_at, META.ended_at]);
  assert.equal(page.$('files-summary').textContent, 'Files 6 · 1 sensitive undeclared · 1 deleted');
  const items = elements(page, 'files-list');
  assert.deepEqual(items.filter((item) => item.className === 'file-group').map((item) => item.textContent), ['Sensitive, undeclared', 'Sensitive, declared', 'Deleted', 'Changed']);
  const rows = items.filter((item) => item.className !== 'file-group').map((item) => item.children[0] as FakeElement);
  assert.deepEqual(rows.map((row) => row.dataset.path), ['.github/workflows/ci.yml', 'package.json', 'src/old.ts', 'lib/alpha.ts', 'img.png', 'src/zeta.ts']);
  assert.equal(rows[0]!.textContent, 'ci.yml.github/workflowssensitive, undeclared+5 −0');
  assert.equal(rows[2]!.textContent, 'old.tssrcdeleted+0 −3');
  assert.ok(rows[1]!.all().some((element) => element.className === 'file-label declared'));

  // The Patch, one block per file, as text with its lines coloured.
  const blocks = elements(page, 'patch-body');
  assert.deepEqual(blocks.map((block) => block.dataset.path), ['src/zeta.ts', 'src/old.ts', 'lib/alpha.ts']);
  assert.equal(page.$('patch-body').textContent, `${patch}\n`);
  assert.deepEqual(blocks[0]!.all().map((element) => element.className).slice(0, 6), ['file', 'file', 'file', 'file', 'hunk', 'del']);
  assert.equal(gets(page, 'api/jobs/app/T-1/iterations/2/patch').length, 1);

  // A file click marks the row and its diff and scrolls the diff into view.
  rows[5]!.click();
  assert.deepEqual(blocks.map((block) => [block.getAttribute('aria-current'), block.scrolledIntoView]), [['true', 1], ['false', 0], ['false', 0]]);
  assert.deepEqual(rows.map((row) => row.getAttribute('aria-current')), ['false', 'false', 'false', 'false', 'false', 'true']);
  assert.equal(page.$('patch-note').textContent, '');
  rows[2]!.click();
  assert.deepEqual(blocks.map((block) => block.scrolledIntoView), [1, 1, 0]);
  // A file the Patch omits says so.
  rows[4]!.click();
  assert.equal(page.$('patch-note').textContent, 'The Patch omits img.png: a binary file, or beyond the Patch size limit.');
  assert.ok(blocks.every((block) => block.getAttribute('aria-current') === 'false'));

  // A job event redraws nothing it has drawn; the Patch is read once.
  await show(page, shown);
  assert.equal(elements(page, 'patch-body')[0], blocks[0]);
  assert.equal(gets(page, 'api/jobs/app/T-1/iterations/2/patch').length, 1);

  // An older iteration, picked: its own Report and Patch; no files.
  page.$('iteration-picker').querySelectorAll('button')[0]!.click();
  await page.flush();
  assert.equal(page.$('iteration-report').textContent, '# Report of 1\nDone.\n');
  assert.deepEqual([page.$('no-files').hidden, page.$('no-files').textContent], [false, 'No files changed.']);
  // An iteration published before the file list says so; no iteration yet says that.
  await show(page, detail(job('awaiting_review'), { iterations: [iteration(1)] }));
  assert.match(page.$('no-files').textContent, /published before the file list existed/);
  await show(page, detail(job('working', { iteration: 0 })));
  assert.deepEqual([page.$('no-iterations').hidden, page.$('changes-body').hidden], [false, true]);
});

test('job client: Reviews shows per iteration, newest first, the Claude and the Codex verdicts side by side, failures and what is pending', async () => {
  const override = { at: '2026-11-01T10:30:00.000Z', code: 'gate_rounds', unapplied: GATE_FIX.items };
  const shown = detail(job('awaiting_review', { iteration: 4 }), {
    iterations: [
      iteration(1, { review: CLAUDE_FIX }),
      iteration(2, { review: { ...CLEAN, accepted_sensitive: ['package.json'] }, gate: GATE_FIX, gate_override: override }),
      iteration(3, { review: CLEAN, gate: GATE_FAILED }),
      iteration(4, { review: CLEAN }),
    ],
  });
  const page = await openJob(shown);
  tab(page, 'reviews').click();
  assert.equal(tab(page, 'reviews').textContent, 'Reviews4');
  const rows = elements(page, 'reviews-list');
  assert.deepEqual(rows.map((row) => row.dataset.iteration), ['4', '3', '2', '1']);
  const blocks = (index: number): FakeElement[] => (elements(page, 'reviews-list')[index]!.children[1] as FakeElement).children as FakeElement[];
  const block = (index: number, which: number): [string, string[]] => [blocks(index)[which]!.className, texts(blocks(index)[which]!)];
  assert.deepEqual(block(0, 0), ['review v-clean', ['Claude review: clean, cost $0.2500', 'Right.']]);
  assert.deepEqual(block(0, 1), ['review v-none', ['Codex gate: reviewing now…']]);
  assert.deepEqual(block(1, 1), ['review v-failed', ['Codex gate: failed', 'Codex wrote no output.']]);
  assert.deepEqual(block(2, 0), ['review v-clean', ['Claude review: clean, cost $0.2500', 'Right.', 'Accepted sensitive paths: package.json']]);
  assert.deepEqual(block(2, 1), ['review v-fix', ['Codex gate: fix (1 item), 1100 tokens', 'Not quite.', 'README.md: It greets the world. Expected: It greets the reader.']]);
  assert.equal((rows[2]!.children[2] as FakeElement).textContent, 'You accepted this iteration over the gate (gate_rounds) at 2026-11-01 12:30:00.');
  assert.equal((rows[2]!.children[2] as FakeElement).all().find((element) => element.tagName === 'TIME')?.getAttribute('datetime'), override.at);
  assert.deepEqual(block(3, 0), ['review v-fix', [
    'Claude review: fix (2 items), cost $0.2500', 'The greeting is wrong.', 'README.md: It greets the world. Expected: It greets the reader.a.txt: Empty. Expected: A line.',
  ]]);
  assert.deepEqual(block(3, 1), ['review v-none', ['Codex gate: not run']]);

  // Claude reviewing; the gate waiting for it; the gate off.
  await show(page, detail(job('awaiting_review'), { iterations: [iteration(1)] }));
  assert.deepEqual([texts(blocks(0)[0]!), texts(blocks(0)[1]!)], [['Claude review: reviewing now…'], ['Codex gate: after a clean Claude review']]);
  await show(page, detail(job('preparing_mr'), { iterations: [iteration(1, { review: CLEAN })], gate: false }));
  assert.deepEqual(texts(blocks(0)[1]!), ['Codex gate: off']);
  await show(page, detail(job('working', { iteration: 0 })));
  assert.equal(page.$('no-reviews').hidden, false);
});

const clipboardOf = (fail = false) => {
  const written: string[] = [];
  return {
    written,
    writeText: async (text: string): Promise<void> => {
      if (fail) {
        throw new Error('denied');
      }
      written.push(text);
    },
  };
};

test('job client: the MR tab shows the MR text; Copy MR text puts the title, a blank line and the body on the clipboard, or selects it; the Codex items not applied under it', async () => {
  const mr = 'feat(T-1): Demo\r\n\r\n\r\n## What\r\nIt.\r\n\r\n';
  const clipboard = clipboardOf();
  const shown = detail(job('ready_for_human_review', { iteration: 2 }), { mr: true, iterations: [iteration(1), iteration(2, { review: CLEAN, gate: GATE_FIX })] });
  const page = await openJob(detail(job('working')), (path) => (path === 'api/jobs/app/T-1/mr' ? mr : undefined), clipboard);
  tab(page, 'mr').click();
  assert.deepEqual([page.$('no-mr').hidden, page.$('mr-panel').hidden, page.$('mr-unapplied').hidden], [false, true, true]);

  await show(page, shown);
  assert.deepEqual([page.$('no-mr').hidden, page.$('mr-panel').hidden], [true, false]);
  assert.match(page.$('mr-body').textContent, /^feat\(T-1\): Demo\r?\n/);
  page.$('mr-copy').click();
  await page.flush();
  assert.deepEqual(clipboard.written, ['feat(T-1): Demo\n\n## What\nIt.']);
  assert.equal(page.$('mr-copy-status').textContent, 'Copied.');
  assert.equal(page.$('mr-copy-text').hidden, true);

  // The user accepted the change over the gate: the Codex items not applied, for a follow-up.
  const accepted = { ...shown, iterations: [iteration(1), iteration(2, { review: CLEAN, gate: GATE_FIX, gate_override: { at: times.ended_at, code: 'gate_rounds', unapplied: GATE_FIX.items } })] };
  await show(page, accepted);
  assert.equal(page.$('mr-unapplied').hidden, false);
  assert.equal(page.$('mr-unapplied-note').textContent, 'You accepted the change over the gate (gate_rounds); these could go into a follow-up ticket:');
  assert.deepEqual(texts(page.$('mr-unapplied-list')), ['README.md: It greets the world. Expected: It greets the reader.']);
  await show(page, { ...shown, iterations: [iteration(1, { gate_override: { at: times.ended_at, code: 'gate_failed', unapplied: 'Codex wrote no output.' } })] });
  assert.equal(page.$('mr-unapplied-note').textContent, 'You accepted the change over the gate (gate_failed); the gate failed: Codex wrote no output.');
  assert.deepEqual(texts(page.$('mr-unapplied-list')), []);
  // An override an iteration later reviewed by the gate again replaced: nothing listed.
  await show(page, { ...accepted, iterations: [...accepted.iterations, iteration(3, { review: CLEAN, gate: { ...GATE_FIX, verdict: 'clean', items: [] } })] });
  assert.equal(page.$('mr-unapplied').hidden, true);

  // The checkout command, copied.
  page.$('copy-checkout').click();
  await page.flush();
  assert.equal(clipboard.written.at(-1), 'git checkout T-1-demo');
  assert.equal(page.$('checkout-copy-status').textContent, 'Copied.');

  // Without the clipboard, or when the browser refuses it: the text shown and selected for Ctrl+C.
  for (const refusing of [undefined, clipboardOf(true)]) {
    const other = await openJob(shown, (path) => (path === 'api/jobs/app/T-1/mr' ? mr : undefined), refusing);
    other.$('mr-copy').click();
    await other.flush();
    const box = other.$('mr-copy-text');
    assert.deepEqual([box.hidden, box.value, box.selected], [false, 'feat(T-1): Demo\n\n## What\nIt.', true]);
    assert.equal(other.$('mr-copy-status').textContent, 'Selected: press Ctrl+C to copy.');
  }
});

test('job client: Accept and prepare MR shows only when the gate stopped the job after a clean Claude review; its confirmation lists the Codex items not applied; one request; the outcome or the refusal', async () => {
  const stopped = (code: string, review: unknown, gate: unknown = GATE_FIX) =>
    detail(job('needs_human', { iteration: 2, error: { code, message: `The ${code} message.` } }), { iterations: [iteration(1, { review: CLAUDE_FIX }), iteration(2, { review, gate })] });
  const page = await openJob(detail(job('working')));
  const button = page.$('accept-gate-button');
  const acceptPosts = (): FetchRequest[] => posts(page).filter((request) => request.path.endsWith('/accept'));
  // Hidden unless the gate stopped the job and Claude's review of the last iteration is clean.
  const hidden: Detail[] = [
    detail(job('working')), stopped('gate_rounds', CLAUDE_FIX), stopped('gate_budget', null), stopped('gate_failed', { reviewer: 'claude', error: 'x' }),
    stopped('review_failed', CLEAN), stopped('iteration_limit', CLEAN), detail(job('ready_for_human_review'), { iterations: [iteration(1, { review: CLEAN })] }),
  ];
  for (const shown of hidden) {
    await show(page, shown);
    assert.equal(button.hidden, true, JSON.stringify([shown.job.state, shown.job.error]));
  }
  for (const code of ['gate_rounds', 'gate_budget', 'gate_failed']) {
    await show(page, stopped(code, CLEAN));
    assert.deepEqual([button.hidden, button.disabled], [false, false], code);
  }

  // The confirmation names the job and lists the Codex items that will not be applied; Cancel sends nothing.
  await show(page, stopped('gate_rounds', CLEAN));
  button.click();
  assert.equal(page.$('confirm').hidden, false);
  assert.equal(page.$('confirm-title').textContent, 'Accept and prepare MR app/T-1?');
  assert.match(page.$('confirm-text').textContent, /^Overrides the Codex gate \(gate_rounds\): iteration 2, which Claude reviewed clean, goes on as after a clean gate\./);
  assert.deepEqual([page.$('confirm-items').hidden, page.$('confirm-items-title').textContent], [false, 'Codex items that will not be applied (1):']);
  assert.deepEqual(texts(page.$('confirm-items-list')), ['README.md: It greets the world.']);
  assert.deepEqual([page.$('discard-label').hidden, page.$('as-is-label').hidden, page.$('confirm-ok').textContent], [true, true, 'Accept and prepare the MR']);
  assert.deepEqual([button.disabled, page.$('approve-button').disabled, page.$('abort-button').disabled], [true, true, true]);
  page.$('confirm-cancel').click();
  assert.deepEqual([page.$('confirm').hidden, page.$('confirm-items').hidden, acceptPosts().length], [true, true, 0]);

  // A failed gate: its error instead of items.
  await show(page, stopped('gate_failed', CLEAN, GATE_FAILED));
  button.click();
  assert.equal(page.$('confirm-items-title').textContent, 'The gate failed, so no Codex item is known: Codex wrote no output.');
  assert.deepEqual(texts(page.$('confirm-items-list')), []);
  page.$('confirm-cancel').click();
  // The budget used up before Codex ran: nothing known, said so.
  await show(page, stopped('gate_budget', CLEAN, null));
  button.click();
  assert.match(page.$('confirm-items-title').textContent, /^Codex did not review this iteration/);
  page.$('confirm-cancel').click();

  // Confirmed: one POST of {}; the button waits; a second click sends nothing.
  await show(page, stopped('gate_rounds', CLEAN));
  button.click();
  page.$('confirm-ok').click();
  await page.flush();
  const sent = acceptPosts()[0]!;
  assert.deepEqual([sent.path, sent.body, sent.headers['content-type']], ['api/jobs/app/T-1/accept', '{}', 'application/json']);
  assert.equal(page.$('action-status').textContent, 'Accepting over the gate…');
  assert.equal(button.disabled, true);
  assert.match(page.$('action-reasons').textContent, /Accept and prepare MR: the override was requested/);
  button.click();
  assert.equal(page.$('confirm').hidden, true);
  sent.respond(200, { ok: true, result: { state: 'preparing_mr', iteration: 2, branch: 'T-1-demo' } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'Accepted over the gate: the factory prepares the MR of iteration 2 (state preparing_mr).');
  assert.equal(page.$('action-status').className, 'status ok');
  await show(page, detail(job('preparing_mr', { iteration: 2 }), { iterations: [iteration(2, { review: CLEAN, gate: GATE_FIX })] }));
  assert.equal(button.hidden, true);

  // A refusal is shown as it comes.
  await show(page, stopped('gate_budget', CLEAN));
  button.click();
  page.$('confirm-ok').click();
  await page.flush();
  acceptPosts()[1]!.respond(409, { ok: false, error: { code: 'invalid_state', message: 'sf accept needs a clean Claude review of the last iteration (2); it says fix.' } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'invalid_state: sf accept needs a clean Claude review of the last iteration (2); it says fix.');
  assert.equal(page.$('action-status').className, 'status error');

  // An answer that cannot be read: the outcome is unknown and the controls wait for a current state.
  await show(page, stopped('gate_budget', CLEAN));
  button.click();
  page.$('confirm-ok').click();
  await page.flush();
  acceptPosts()[2]!.fail();
  await page.flush();
  assert.match(page.$('action-doubt').textContent, /The request failed \(Failed to fetch\)\. Its outcome is unknown/);
  assert.equal(acceptPosts().length, 3);
});

test('job client: the Live log tells the Implementer, the Claude review, Codex and the state apart; the filters show one of them; follow scrolls', async () => {
  const page = await openJob(detail(job('awaiting_review')));
  tab(page, 'log').click();
  const lines: Array<[string, string]> = [
    ['prompt', '10:00:00 [0] > /implement .software-factory/T-1.md'],
    ['assistant', '10:00:01 [0] Working on it.'],
    ['state', '10:01:00 [1] state working -> awaiting_review'],
    ['review_message', '10:01:01 [1] review | Reading the patch.'],
    ['review', '10:02:00 [1] review by claude: clean'],
    ['gate_event', '10:02:01 [1] codex | exec git status'],
    ['review', '10:03:00 [1] review by codex: fix (1 item)'],
    ['gate_overridden', '10:04:00 [1] gate overridden by the user (gate_rounds): 1 Codex item not applied'],
    ['placeholders_removed', '10:04:01 [1] placeholders removed: .x'],
  ];
  const stream = page.streams.at(-1)!;
  lines.forEach(([type, text], line) => stream.emit('event', { line, ts: '2026-11-01T10:00:00.000Z', iteration: 1, type, text }));
  const events = page.$('events');
  const shown = (): string[] => (events.children as FakeElement[]).filter((child) => !child.hidden).map((child) => child.textContent.slice(13));
  assert.deepEqual((events.children as FakeElement[]).map((child) => child.dataset.source), ['implementer', 'implementer', 'state', 'claude', 'claude', 'codex', 'codex', 'state', 'state']);
  assert.equal(shown().length, 9);
  const filter = (label: string): FakeElement => page.$('log-filters').querySelectorAll('button').find((button) => button.textContent === label)!;
  assert.deepEqual(page.$('log-filters').querySelectorAll('button').map((button) => [button.textContent, button.getAttribute('aria-pressed')]), [
    ['All', 'true'], ['Implementer', 'false'], ['Claude review', 'false'], ['Codex', 'false'], ['State', 'false'],
  ]);
  filter('Implementer').click();
  assert.deepEqual(shown(), ['> /implement .software-factory/T-1.md', 'Working on it.']);
  filter('Claude review').click();
  assert.deepEqual(shown(), ['review | Reading the patch.', 'review by claude: clean']);
  filter('Codex').click();
  assert.deepEqual(shown(), ['codex | exec git status', 'review by codex: fix (1 item)']);
  assert.equal(filter('Codex').getAttribute('aria-pressed'), 'true');
  // A new line follows the filter.
  stream.emit('event', { line: 9, ts: '2026-11-01T10:05:00.000Z', iteration: 1, type: 'state', text: '10:05:00 [1] state awaiting_review -> preparing_mr' });
  assert.equal(shown().length, 2);
  filter('State').click();
  assert.deepEqual(shown(), ['state working -> awaiting_review', 'gate overridden by the user (gate_rounds): 1 Codex item not applied', 'placeholders removed: .x', 'state awaiting_review -> preparing_mr']);
  filter('All').click();
  assert.equal(shown().length, 10);

  // Follow keeps the newest line in view; scrolling up turns it off.
  events.scrollHeight = 500;
  events.clientHeight = 100;
  stream.emit('event', { line: 10, ts: '2026-11-01T10:06:00.000Z', iteration: 1, type: 'assistant', text: '10:06:00 [1] More.' });
  assert.equal(events.scrollTop, 500);
  events.scrollTop = 100;
  events.dispatch('scroll');
  assert.equal(page.$('follow').checked, false);
  stream.emit('event', { line: 11, ts: '2026-11-01T10:07:00.000Z', iteration: 1, type: 'assistant', text: '10:07:00 [1] Even more.' });
  assert.equal(events.scrollTop, 100);
});

test('job client (SF-052): a ledger stop says what happened; escalated and contested findings get Accept risk and Must fix with a note; Accept over review_churn lists the open findings', async () => {
  const ledgerEntry = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id, iteration: 1, reviewer: 'claude', severity: 'major', path: 'README.md', problem: `Problem of ${id}.`, expected: 'Better.', status,
    response: '', evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null, ...extra,
  });
  const escalated = detail(job('needs_human', { iteration: 2, error: { code: 'escalated', message: 'R1: which language?' } }), {
    iterations: [iteration(1, { review: CLAUDE_FIX }), iteration(2)],
  });
  const ledger = [ledgerEntry('R1', 'escalated', { response: 'Which language?' }), ledgerEntry('R2', 'fixed')];
  const page = await openJob({ ...escalated, ledger } as Detail);
  assert.match(page.$('job-halt').textContent, /escalated a question only you can answer\. Settle each finding below/);
  assert.equal(page.$('ledger-panel').hidden, false);
  const [item] = elements(page, 'ledger-list');
  assert.equal(elements(page, 'ledger-list').length, 1);
  assert.equal((item!.children[0] as FakeElement).textContent, 'R1 · escalated · major · README.md: Problem of R1.');
  assert.equal((item!.children[1] as FakeElement).textContent, 'The Implementer asks: Which language?');
  const note = item!.querySelectorAll('input')[0]!;
  const [accept, fix] = item!.querySelectorAll('button');
  assert.deepEqual([accept!.textContent, fix!.textContent], ['Accept risk', 'Must fix']);
  note.value = 'English only.';
  fix!.click();
  await page.flush();
  const sent = posts(page).at(-1)!;
  assert.deepEqual([sent.path, JSON.parse(sent.body!)], ['api/jobs/app/T-1/settle', { id: 'R1', decision: 'fix', note: 'English only.' }]);
  sent.respond(200, { ok: true, result: { state: 'working', id: 'R1', status: 'user_fix', waiting: [] } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'Settled R1: to be fixed (state working).');

  // A dispute shows both positions; review_churn and review_disputed offer Accept with the open findings.
  const disputed = ledgerEntry('R1', 'contested', { response: 'Done at README.md:1.', evidence: 'README.md:1', dispute: { reviewer: 'codex', iteration: 2, reason: 'Still wrong.' } });
  await show(page, { ...detail(job('needs_human', { iteration: 2, error: { code: 'review_disputed', message: 'x' } }), { iterations: [iteration(1, { review: CLEAN, gate: GATE_FIX }), iteration(2, { review: CLEAN, gate: GATE_FIX })] }), ledger: [disputed] } as Detail);
  assert.match(page.$('job-halt').textContent, /disputes the Implementer's contest of a finding\. Accept and prepare the MR, settle the finding below/);
  assert.deepEqual(texts(elements(page, 'ledger-list')[0]!).slice(1, 3), ['The Implementer contests it: Done at README.md:1. Evidence: README.md:1', 'Codex reopens it: Still wrong.']);
  await show(page, { ...detail(job('needs_human', { iteration: 2, error: { code: 'review_churn', message: 'x' } }), { iterations: [iteration(2, { review: CLEAN, gate: GATE_FIX })] }), ledger: [ledgerEntry('R1', 'open')] } as Detail);
  assert.match(page.$('job-halt').textContent, /The fixes keep making new findings\. Accept and prepare the MR, continue/);
  assert.equal(page.$('ledger-panel').hidden, true);
  assert.equal(page.$('accept-gate-button').hidden, false);
  page.$('accept-gate-button').click();
  assert.match(page.$('confirm-text').textContent, /over the ledger's stop \(review_churn\)/);
  assert.equal(page.$('confirm-items-title').textContent, 'Open findings of the ledger that will not be applied (1):');
  assert.deepEqual(texts(page.$('confirm-items-list')), ['R1 README.md: Problem of R1.']);
});

test('job client (SF-055): the offer of the simplification pass says what happened; Simplify and Skip (Accept) list the suggestions; Simplify sends one request', async () => {
  const suggestion = { path: 'guard.txt', what: 'The second guard.', why: 'The first one covers it.', saves_lines: 3, ledger_ids: ['R1'] };
  const record = { reviewer: 'simplify', summary: 'One guard too many.', suggestions: [suggestion], dropped: [], cost_usd: 0.1, model: null, ...times };
  const offered = detail(job('needs_human', { iteration: 2, fixes: 1, error: { code: 'simplify_offered', message: 'The simplification pass found 1 thing.' } }), {
    iterations: [iteration(1, { review: CLAUDE_FIX }), iteration(2, { review: CLEAN, gate: { ...GATE_FIX, verdict: 'clean', items: [] }, simplify: record })],
  });
  const page = await openJob(offered);
  assert.match(page.$('job-halt').textContent, /the simplification pass found things the review fixes added that the Task does not need\. Simplify .* or Accept and prepare the MR without them/);
  const simplify = page.$('simplify-button');
  const accept = page.$('accept-gate-button');
  assert.deepEqual([simplify.hidden, simplify.disabled, accept.hidden, accept.disabled], [false, false, false, false]);

  // Skip: Accept's confirmation says the suggestions go into the MR text, and lists them.
  accept.click();
  assert.match(page.$('confirm-text').textContent, /^Skips the simplification: iteration 2.*“Simplifications not applied”/);
  assert.equal(page.$('confirm-items-title').textContent, 'Suggestions of the simplification pass (1):');
  assert.deepEqual(texts(page.$('confirm-items-list')), ['guard.txt: The second guard. Why: The first one covers it. (about 3 lines)']);
  assert.equal(page.$('confirm-ok').textContent, 'Skip and prepare the MR');
  page.$('confirm-cancel').click();

  // Simplify: its own confirmation, then one POST of {}.
  simplify.click();
  assert.equal(page.$('confirm-title').textContent, 'Simplify app/T-1?');
  assert.match(page.$('confirm-text').textContent, /^Writes one Fix section “Simplify” with the suggestions below/);
  assert.equal(page.$('confirm-ok').textContent, 'Simplify');
  page.$('confirm-ok').click();
  await page.flush();
  const sent = posts(page).filter((request) => request.path.endsWith('/simplify'));
  assert.deepEqual(sent.map((request) => [request.path, request.body]), [['api/jobs/app/T-1/simplify', '{}']]);
  sent[0]!.respond(200, { ok: true, result: { state: 'working', iteration: 3, check_after_minutes: 5 } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'Simplify: the Implementer applies the suggestions in iteration 3 (state working).');

  // Elsewhere hidden.
  await show(page, detail(job('working', { iteration: 2 })));
  assert.equal(simplify.hidden, true);
});

test('job client (SF-067): Pause on a working job; a paused one on Your turn with the Task file notice and Resume (with the message of a paused turn); Restart confirmed with Keep the files', async () => {
  const page = await openJob(detail(job('working')));
  const [pause, resume, restart] = ['pause-button', 'resume-button', 'restart-button'].map((id) => page.$(id));
  assert.deepEqual([pause!.hidden, pause!.disabled, resume!.hidden, restart!.hidden], [false, false, true, true]);
  // Pause goes at once, no confirmation.
  pause!.click();
  await page.flush();
  assert.equal(page.$('confirm').hidden, true);
  const paused = posts(page).filter((request) => request.path.endsWith('/pause'));
  assert.deepEqual(paused.map((request) => [request.path, request.body]), [['api/jobs/app/T-1/pause', '{}']]);
  paused[0]!.respond(200, { ok: true, result: { state: 'paused', branch: 'T-1-demo', step: 'turn' } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'Paused during the turn: nothing of the job runs; the worktree, the branch T-1-demo and the session stay.');

  // The paused job: on Your turn with the notice and Resume; the drawer says what was interrupted.
  const row = job('paused', { paused: { from: 'working', step: 'turn', at: '2026-11-01T10:06:00.000Z' }, task_changed: true });
  page.streams.at(-1)!.emit('jobs', { jobs: [row] });
  await show(page, detail(row));
  const item = (page.$('list-you').children as FakeElement[]).find((child) => child.dataset?.open === 'app/T-1')!;
  assert.match(item.textContent, /Task file changed since the job started/);
  assert.match(item.textContent, /Paused by you/);
  assert.match(page.$('next-headline').textContent, /^You paused the Implementer's turn on iteration 2\. Resume continues the same session \(with your message, if you write one below\); Restart starts the ticket again from its current Task file\.$/);
  assert.match(page.$('next-why').textContent, /^Task file changed since the job started/);
  assert.deepEqual([pause!.hidden, resume!.hidden, resume!.disabled, restart!.hidden, restart!.disabled], [true, false, false, false, false]);
  assert.equal(page.$('say-input').disabled, false);
  assert.equal(page.$('say-button').disabled, true);
  page.$('say-input').value = 'Mind the new line.';
  page.$('say-input').dispatch('input');
  resume!.click();
  await page.flush();
  const resumed = posts(page).filter((request) => request.path.endsWith('/resume'));
  assert.deepEqual(resumed.map((request) => [request.path, request.body]), [['api/jobs/app/T-1/resume', '{"message":"Mind the new line."}']]);
  resumed[0]!.respond(200, { ok: true, result: { state: 'working', iteration: 1, step: 'turn', task_changed: true } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'Resumed: the Implementer goes on with iteration 2. The changed Task file went with it.');
  assert.equal(page.$('say-input').value, '');

  // Restart: its confirmation says what is thrown away; Keep the files goes with the request.
  await show(page, detail(job('aborted')));
  assert.deepEqual([restart!.hidden, restart!.disabled, page.$('archive-job-button').hidden], [false, false, false]);
  restart!.click();
  assert.equal(page.$('confirm-title').textContent, 'Restart app/T-1?');
  assert.match(page.$('confirm-text').textContent, /^Starts T-1 again from its current Task file, as a new job on a fresh worktree and branch from main\. Thrown away: .*the worktree \/wt\/T-1 with its uncommitted changes \(unless kept below\) and the branch T-1-demo, deleted only when it has no commit beyond the base and was never pushed/);
  assert.equal(page.$('keep-files-label').hidden, false);
  assert.equal(page.$('confirm-ok').textContent, 'Restart');
  page.$('keep-files').checked = true;
  page.$('keep-files').dispatch('change');
  assert.equal(page.$('confirm-ok').textContent, 'Restart, keep the files');
  page.$('confirm-ok').click();
  await page.flush();
  const restarted = posts(page).filter((request) => request.path.endsWith('/restart'));
  assert.deepEqual(restarted.map((request) => [request.path, request.body]), [['api/jobs/app/T-1/restart', '{"keep_files":true}']]);
  restarted[0]!.respond(200, { ok: true, result: { branch: 'T-1-demo', state: 'working', check_after_minutes: 5, worktree: '/wt/T-1', archived: 'jobs/app/T-1.20261101T100000Z', branch_deleted: 'T-1-demo', kept: ['a.txt'] } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'Restarted on T-1-demo from the current Task file (the old job is in jobs/app/T-1.20261101T100000Z). The old branch T-1-demo was deleted. 1 file of the old worktree was copied in.');

  // Pause is held while the MR is prepared, with the reason.
  await show(page, detail(job('preparing_mr')));
  assert.deepEqual([pause!.hidden, pause!.disabled], [false, true]);
  assert.match(page.$('action-reasons').textContent, /Pause: the MR is being prepared/);
});

// The hand-over buttons (SF-073), made by app.js in the next-action panel.
const handoverButton = (page: Page, action: string): FakeElement => page.$('next-panel').querySelectorAll('button').find((button) => button.dataset.action === action)!;

test('job client (SF-073): a handed-over job shows "In your checkout on <branch>", Ask for changes, Approve, I opened the MR myself and Take it back; a ready one with handoff_skipped shows Hand over to my checkout and the skip message, and its kept worktree', async () => {
  const handover = { branch: 'T-1-demo', saved: 'a'.repeat(40), base: 'b'.repeat(40), previous: { branch: 'main' }, untracked: [], template: null, cleanup: null, at: '2026-11-01T10:06:00.000Z', checked_at: null, step: null };
  const handed = job('handed_over', { prepared_commit: 'a'.repeat(40), worktree: null, handover, handoff_skipped: null });
  const page = await openJob(detail(handed, { mr: true, mr_title: 'feat(T-1): Demo' } as Partial<Omit<Detail, 'job'>>));
  assert.equal(page.$('next-headline').textContent, 'In your checkout on T-1-demo.');
  assert.match(page.$('next-why').textContent, /Merge request title: feat\(T-1\): Demo$/);
  const shown = (action: string): boolean => !handoverButton(page, action).hidden;
  assert.deepEqual([shown('handover'), shown('handed-done'), shown('takeback')], [false, true, true]);
  assert.deepEqual([handoverButton(page, 'handed-done').textContent, handoverButton(page, 'takeback').textContent], ['I opened the MR myself', 'Take it back']);
  assert.deepEqual([page.$('approve-button').hidden, page.$('approve-button').disabled], [false, false]);
  assert.equal(page.$('say-button').textContent, 'Ask for changes');
  assert.equal(page.$('say-input').disabled, false);
  assert.equal(facts(page).Worktree, 'none');
  // The card on the board says where the job is.
  const card = page.$('list-you').all().find((node) => node.className === 'reason ready' && node.textContent === 'In your checkout on T-1-demo');
  assert.notEqual(card, undefined);

  // Take it back goes at once.
  handoverButton(page, 'takeback').click();
  await page.flush();
  const back = posts(page).filter((request) => request.path.endsWith('/takeback'));
  assert.deepEqual(back.map((request) => [request.path, request.body]), [['api/jobs/app/T-1/takeback', '{}']]);
  back[0]!.respond(200, { ok: true, result: { state: 'ready_for_human_review', branch: 'T-1-demo', worktree: '/wt/T-1' } });
  await page.flush();
  assert.match(page.$('action-status').textContent, /^Taken back: /);

  // Ready for review, not handed over: the skip message and Hand over to my checkout.
  const skipped = job('ready_for_human_review', { worktree: '/wt/T-1', handoff_skipped: { code: 'checkout_dirty', message: 'T-1: ready, but your checkout has changes; hand it over when you are ready' }, handover: null });
  page.streams.at(-1)!.emit('jobs', { jobs: [skipped] });
  await show(page, detail(skipped));
  assert.match(page.$('next-why').textContent, /^Not handed over to your checkout: T-1: ready, but your checkout has changes; hand it over when you are ready /);
  assert.deepEqual([shown('handover'), shown('handed-done'), shown('takeback')], [true, false, false]);
  assert.equal(handoverButton(page, 'handover').textContent, 'Hand over to my checkout');
  assert.equal(page.$('say-button').textContent, 'Send');
  assert.equal(facts(page).Worktree, '/wt/T-1');
  handoverButton(page, 'handover').click();
  await page.flush();
  assert.deepEqual(posts(page).filter((request) => request.path.endsWith('/handover')).map((request) => request.body), ['{}']);
});
