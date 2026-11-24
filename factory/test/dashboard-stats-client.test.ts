// The Stats page in static/reports.js (SF-117), run under node:vm against the fake page of
// test/support/fake-dom.ts: #stats and the Stats button, the period and workspace reads (an older
// answer ignored), the warnings first with their links, the second opinion, the Claude review
// on/off table (SF-132), the fix session fresh/resume table (SF-316-2), the recurring findings
// checklist with/without table (SF-318-3), the stage and role
// tables, the Table toggle, the SVG charts (createElementNS, class attributes, no style attribute), the all-zero chart's box, leaving a job
// page or the drawer, the loading, error and empty states, Escape, and the other pages hiding #stats. Script checks, not browser acceptance: the layout is
// test/browser/stats-page.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
process.env.TZ = 'Europe/Sofia';
const SVG = 'http://www.w3.org/2000/svg';

const ZERO_COST = { implementer: 0, claude_review: 0, simplify: 0, task_check: 0, digest: 0, explanation: 0 };
const ZERO_TOKENS = { input: 0, cached_input: 0, output: 0 };
const outcomes = { fixed: 1, contested: 0, accepted: 0, nit: 3, open: 2 };

function payload(extra: Record<string, unknown> = {}) {
  return {
    generated_at: '2026-11-07T12:05:00.000Z', days: 30, workspace: null, period: { from: '2026-10-09', to: '2026-11-07' }, workspaces: ['app', 'web'],
    now: { running: 2, waiting_for_you: 1, paused: 0, queued: null },
    totals: {
      cost_usd: 12.5, codex_tokens: { input: 2_100_000, cached_input: 1_000_000, output: 40_000 }, jobs_started: 3,
      jobs_finished: { total: 2, pushed: 1, aborted: 1, failed: 0 }, median_time_to_ready_s: 5400, median_iterations: 2,
    },
    days_rows: [
      { day: '2026-11-06', cost: { ...ZERO_COST, implementer: 1.2, claude_review: 0.3 }, codex_tokens: { input: 1000, cached_input: 0, output: 100 }, started: 1, finished: 0 },
      { day: '2026-11-07', cost: ZERO_COST, codex_tokens: ZERO_TOKENS, started: 0, finished: 1 },
    ],
    roles: [
      { role: 'implementer', cost_usd: 1.2, complete: false, tokens: { input: 340_000, output: 950 }, runs: 3 },
      { role: 'claude_review', cost_usd: 0.3, complete: true, tokens: { input: 1000, output: 10 }, runs: 2 },
      { role: 'simplify', cost_usd: 0, complete: true, tokens: { input: 0, output: 0 }, runs: 0 },
      { role: 'codex_gate', cost_usd: null, complete: true, tokens: { input: 1000, cached_input: 0, output: 100 }, runs: 1 },
      { role: 'task_check', cost_usd: 0.5, complete: true, tokens: null, runs: 1 },
      { role: 'digest', cost_usd: 0, complete: true, tokens: null, runs: 0 },
      { role: 'explanation', cost_usd: 0, complete: true, tokens: null, runs: 0 },
    ],
    by_workspace: [{ workspace: 'app', cost: { implementer: 1.2, claude_review: 0.3, simplify: 0, task_check: 0.5, explanation: 0 }, total_usd: 2, codex_tokens: 1100, jobs_started: 1, median_time_to_ready_s: 5400 }],
    stages: [
      { stage: 'claude_review', runs: 2, failed: 1, findings: { blocker: 1, major: 2, nit: 3 }, outcomes, revised: null, fixed: 1, tickets: null, cost_usd: 0.3, tokens: { input: 1000, output: 10 } },
      { stage: 'codex_gate', runs: 1, failed: 0, findings: { blocker: 0, major: 1, nit: 0 }, outcomes, revised: null, fixed: 1, tickets: null, cost_usd: null, tokens: { input: 1000, cached_input: 0, output: 100 } },
      { stage: 'task_check', runs: 4, failed: 1, findings: { blocker: 0, major: 1, nit: 0 }, outcomes: null, revised: 1, fixed: 1, tickets: 2, cost_usd: 0.5, tokens: null },
    ],
    task_check_modes: [
      { mode: 'full', runs: 3, failed: 1, cost_usd: 0.45, cost_complete: false, usd_per_run: 0.15, started: 4, over_two: 1, over_two_share: 0.25 },
      { mode: 'follow_up', runs: 1, failed: 0, cost_usd: 0.05, cost_complete: true, usd_per_run: 0.05, started: 0, over_two: 0, over_two_share: null },
    ],
    second_opinion: {
      codex_after_claude: { iterations: 4, caught: 1, findings: 2, fixed: 1, cases: [{ workspace: 'app', ticket: 'T-1', dir: 'T-1', archived: false, iteration: 2, findings: 2, fixed: 1 }] },
      claude_after_codex: { iterations: 3, caught: 2, findings: 2, fixed: 0, cases: [{ workspace: 'app', ticket: 'C-1', dir: 'C-1.20261101T100000Z', archived: true, iteration: 3, findings: 1, fixed: 0 }] },
    },
    arms: [
      { arm: 'on', jobs: 3, delivered: 2, aborted: 1, cost_usd: 5, cost_complete: false, usd_per_delivered: 2.5, median_iterations: 3, codex_findings: 2, codex_findings_per_job: 2 / 3 },
      { arm: 'off', jobs: 1, delivered: 0, aborted: 0, cost_usd: 3, cost_complete: true, usd_per_delivered: null, median_iterations: null, codex_findings: 1, codex_findings_per_job: 1 },
    ],
    arms_fix_session: [
      { arm: 'fresh', jobs: 2, delivered: 1, aborted: 1, cost_usd: 3.75, cost_complete: true, usd_per_delivered: 3.75, median_iterations: 3, mean_iterations: 2, fix_round_usd: 0.375, fix_round_complete: false, codex_findings: 1, codex_findings_per_job: 0.5 },
      { arm: 'resume', jobs: 3, delivered: 1, aborted: 0, cost_usd: 3.5, cost_complete: false, usd_per_delivered: 3.5, median_iterations: 2, mean_iterations: 7 / 3, fix_round_usd: null, fix_round_complete: true, codex_findings: 0, codex_findings_per_job: 0 },
    ],
    arms_findings_checklist: [
      {
        arm: 'with', jobs: 2, delivered: 1, aborted: 1, cost_usd: 1.75, cost_complete: false, usd_per_delivered: 1.75, median_iterations: 2, codex_findings: 1, codex_findings_per_job: 0.5,
        codex_fix_verdicts: 1, codex_fix_verdicts_per_job: 0.5, mean_iterations: 1.5, implementer_usd: 1.5, implementer_complete: false, implementer_usd_per_delivered: 1.5,
      },
      {
        arm: 'without', jobs: 3, delivered: 0, aborted: 0, cost_usd: 5, cost_complete: true, usd_per_delivered: null, median_iterations: null, codex_findings: 2, codex_findings_per_job: 2 / 3,
        codex_fix_verdicts: 2, codex_fix_verdicts_per_job: 2 / 3, mean_iterations: 7 / 3, implementer_usd: 5, implementer_complete: true, implementer_usd_per_delivered: null,
      },
    ],
    simplify: { offered: 2, taken: 1, skipped: 1 },
    jobs: [{
      workspace: 'app', ticket: 'T-1', dir: 'T-1', archived: false, title: 'Demo', state: 'needs_human', created_at: '2026-11-06T08:00:00.000Z', iterations: 2, cost_usd: 1.5,
      cost_complete: false, codex_tokens: 1100, claude: { blocker: 1, major: 2, nit: 3 }, codex: { blocker: 0, major: 1, nit: 0 }, time_to_ready_s: null,
      plan_checks: 3, plan_check_usd: 0.75, plan_check_usd_complete: false,
    }],
    warnings: [
      { kind: 'job_unusual', text: 'T-1: cost $12.40 (usual $4.10) — compared with the last 30 finished jobs of app.', at: '2026-11-07T10:00:00.000Z', target: { kind: 'job', workspace: 'app', ticket: 'T-1', archived: false } },
      { kind: 'stage_failing', text: 'The plan check failed 3 times in a row, last on P-1 on 2026-11-06 at 14:02.', at: '2026-11-06T12:02:00.000Z', target: { kind: 'ticket', workspace: 'app', ticket: 'P-1' } },
      { kind: 'stage_failing', text: 'The digest failed 3 times in a row, last the digest of 2026-11-06 at 08:00.', at: '2026-11-06T06:00:00.000Z', target: { kind: 'digest', id: '20261106T060000Z-scheduled' } },
      { kind: 'review_churn', text: 'C-1: review churn, finding R4 was reopened 3 times.', at: '2026-11-05T10:00:00.000Z', target: { kind: 'job', workspace: 'app', ticket: 'C-1', archived: true } },
      { kind: 'cost_spike', text: '2026-11-04 cost $38.20, more than twice the usual $11.00 (median of the 30 days before).', at: '2026-11-03T22:00:00.000Z', target: null },
    ],
    notes: { truncated: 0, unreadable: 0, events_skipped: 0, digest_excluded: false },
    ...extra,
  };
}

function job(ticket: string, state: string) {
  return {
    workspace: 'app', ticket, branch: `${ticket}-x`, base: 'main', state, iteration: 1, mr_attempts: 0, updated_at: '2026-11-05T10:00:00.000Z', created_at: '2026-11-05T10:00:00.000Z',
    error: null, prepared_commit: null, worktree: `/wt/${ticket}`, fixes: 0, gate_fixes: 0, gate_tokens: 0, files: 0, undeclared: 0, deleted: 0, title: `Ticket ${ticket}`,
    cost_usd: null, review: null, review_ended_at: null, gate: null, now: null, tool_calls: 0, stop: null,
  };
}

function ticketRow(name: string) {
  return {
    workspace: 'app', ticket: name, title: `Ticket ${name}`, base: 'main', draft: false, request: null, job: null, lands_after: [],
    conversation: { message: 'Plan.', url: 'https://chatgpt.com/?q=Plan.' },
    check: { state: 'none', check_reason: null, stale: false, running: false, blockers: 0, majors: 0, nits: 0, ended_at: null, start_note: 'not checked' },
  };
}

// The page at the hash, with the board's data; GETs of api/stats stay pending for the test.
async function openPage(hash: string): Promise<Page> {
  const jobs = [job('T-1', 'working')];
  const page = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs } : undefined));
  page.location.hash = hash;
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs });
  stream.emit('workspaces', { workspaces: [{ name: 'app', path: '/srv/app', liveJobs: 0, problem: null, handoff: null, color: 'teal' }] });
  stream.emit('tickets', { tickets: [ticketRow('P-1')], archived: [] });
  await page.flush();
  return page;
}

const statsReads = (page: Page): FetchRequest[] => page.requests.filter((request) => request.path.startsWith('api/stats'));

// #stats opened and answered with data.
async function openStats(data: unknown = payload()): Promise<Page> {
  const page = await openPage('#stats');
  statsReads(page).at(-1)!.respond(200, data);
  await page.flush();
  return page;
}

const root = (page: Page): FakeElement => page.$('stats');
const body = (page: Page): FakeElement => root(page).querySelector('.st-body')!;
const sections = (page: Page): FakeElement[] => body(page).children.filter((child) => (child as FakeElement).tagName === 'SECTION') as FakeElement[];
const sectionOf = (page: Page, title: RegExp): FakeElement => sections(page).find((section) => title.test(section.querySelector('h3')!.textContent))!;
const chart = (page: Page, id: string): FakeElement => root(page).querySelector(`[data-chart="${id}"]`)!;
const toolButton = (page: Page, text: string): FakeElement => root(page).querySelectorAll('header button').find((node) => node.textContent === text)!;
const rowTexts = (table: FakeElement): string[][] => table.querySelectorAll('tr').map((row) => (row.children as FakeElement[]).map((cell) => cell.textContent));
const tableAfter = (section: FakeElement, index = 0): FakeElement => section.querySelectorAll('.st-scroll > table')[index]!;

test('stats client: #stats and the Stats button open the page and read days=30; 7 days and a workspace read again; an older answer after a newer request is ignored', async () => {
  const page = await openPage('#stats');
  assert.deepEqual([root(page).hidden, page.$('board').hidden], [false, true]);
  assert.deepEqual(statsReads(page).map((request) => request.path), ['api/stats?days=30']);
  assert.match(body(page).textContent, /Loading the stats…/);

  const board = await openPage('');
  assert.equal(root(board).hidden, true);
  board.$('open-stats').click();
  await board.flush();
  assert.deepEqual([root(board).hidden, board.location.hash, statsReads(board).map((request) => request.path)], [false, '#stats', ['api/stats?days=30']]);

  const first = statsReads(page)[0]!;
  first.respond(200, payload());
  await page.flush();
  toolButton(page, '7 days').click();
  await page.flush();
  assert.equal(statsReads(page).at(-1)!.path, 'api/stats?days=7');
  assert.equal(toolButton(page, '7 days').getAttribute('aria-pressed'), 'true');
  assert.equal(toolButton(page, '30 days').getAttribute('aria-pressed'), 'false');
  const pick = root(page).querySelector('select')!;
  assert.equal(pick.getAttribute('aria-label'), 'Workspace');
  assert.deepEqual(pick.querySelectorAll('option').map((option) => option.textContent), ['All workspaces', 'app', 'web']);
  pick.value = 'app';
  pick.dispatch('change');
  await page.flush();
  const reads = statsReads(page);
  assert.deepEqual(reads.map((request) => request.path), ['api/stats?days=30', 'api/stats?days=7', 'api/stats?days=7&workspace=app']);
  // The newer answer first, then the older one: the older is ignored.
  reads[2]!.respond(200, payload({ days: 7, workspace: 'app', period: { from: '2026-11-01', to: '2026-11-07' } }));
  await page.flush();
  reads[1]!.respond(200, payload({ days: 7, period: { from: '2026-10-31', to: '2026-11-06' } }));
  await page.flush();
  assert.match(root(page).querySelector('header .t2')!.textContent, /^2026-11-01 to 2026-11-07 · as of 14:05$/);
  toolButton(page, 'Refresh').click();
  await page.flush();
  assert.equal(statsReads(page).at(-1)!.path, 'api/stats?days=7&workspace=app');
});

test('stats client: the warnings come first with their links (job, ticket, digest), an archived job without one; no warnings', async () => {
  const page = await openStats();
  const [first] = sections(page);
  assert.equal(first!.querySelector('h3')!.textContent, 'Warnings (5)');
  const rows = first!.querySelectorAll('.st-warn li');
  assert.deepEqual(rows.map((row) => row.querySelector('a')?.href ?? null), ['#app/T-1', '#app/P-1/ticket', '#digest/20261106T060000Z-scheduled', null, null]);
  assert.equal(rows[0]!.querySelector('a')!.textContent, 'Open');
  assert.match(rows[3]!.textContent, /reopened 3 times\.\(archived\)$/);
  assert.equal(rows[4]!.textContent, '2026-11-04 cost $38.20, more than twice the usual $11.00 (median of the 30 days before).');
  assert.equal(first!.querySelector('details summary')!.textContent, 'How warnings are found');
  assert.equal(first!.querySelectorAll('details li').length, 8);
  assert.equal(first!.querySelectorAll('button').some((node) => node.textContent.startsWith('Show all')), false);
  assert.deepEqual(sections(page).map((section) => section.querySelector('h3')!.textContent),
    ['Warnings (5)', 'Now', 'Does a second model pay?', 'Claude review on/off', 'Fix session fresh/resume', 'Recurring findings checklist with/without', 'Review stages', 'Spend', 'Load', 'Jobs (1)']);
  assert.deepEqual(sectionOf(page, /^Now$/).querySelectorAll('.st-tile').map((tile) => tile.textContent), ['Running2', 'Waiting for you1', 'Paused0', 'Queued—']);

  const none = await openStats(payload({ warnings: [] }));
  assert.equal(sections(none)[0]!.querySelector('h3')!.textContent, 'Warnings (0)');
  assert.match(sections(none)[0]!.textContent, /No warnings: nothing is far from the usual\./);
});

test('stats client: 10 of 12 warnings are listed, "Show all 12" shows the other 2 in place; the heading has the full count', async () => {
  const warnings = Array.from({ length: 12 }, (_, index) => ({
    kind: 'review_churn', text: `W-${index + 1}: review churn, finding R1 was reopened 3 times.`, at: '2026-11-05T10:00:00.000Z', target: null,
  }));
  const page = await openStats(payload({ warnings }));
  const [first] = sections(page);
  assert.equal(first!.querySelector('h3')!.textContent, 'Warnings (12)');
  const texts = () => first!.querySelectorAll('.st-warn li').map((row) => row.textContent.slice(0, 4));
  assert.deepEqual(texts(), ['W-1:', 'W-2:', 'W-3:', 'W-4:', 'W-5:', 'W-6:', 'W-7:', 'W-8:', 'W-9:', 'W-10']);
  const more = first!.querySelectorAll('button').find((node) => node.textContent === 'Show all 12')!;
  assert.ok(more);
  more.click();
  assert.equal(texts().length, 12);
  assert.deepEqual(texts().slice(10), ['W-11', 'W-12']);
  assert.equal(first!.querySelectorAll('button').some((node) => node.textContent === 'Show all 12'), false);
  assert.equal(first!.querySelector('h3')!.textContent, 'Warnings (12)');
});

test('stats client: the second-opinion numbers and percentages with their cases; no iteration with both reviews', async () => {
  const page = await openStats();
  const cards = sectionOf(page, /second model/).querySelectorAll('.st-opinion');
  assert.equal(cards[0]!.querySelector('h4')!.textContent, 'Codex found a blocker or major after Claude passed');
  assert.deepEqual(cards[0]!.querySelectorAll('p').map((p) => p.textContent), ['1 of 4 iterations (25%)', '1 of its 2 findings were fixed']);
  assert.equal(cards[0]!.querySelector('.st-cases a')!.href, '#app/T-1');
  assert.equal(cards[0]!.querySelector('.st-cases li')!.textContent, 'T-1iteration 2 · 2 findings · 1 fixed');
  assert.equal(cards[1]!.querySelector('h4')!.textContent, 'Claude found a new blocker or major right after a clean Codex gate');
  assert.deepEqual(cards[1]!.querySelectorAll('p').map((p) => p.textContent).slice(0, 2), ['2 of 3 iterations (67%)', '0 of its 2 findings were fixed']);
  assert.match(cards[1]!.textContent, /The next iteration is usually MR preparation or your own request/);
  assert.equal(cards[1]!.querySelector('.st-cases a'), null);
  assert.match(cards[1]!.querySelector('.st-cases li')!.textContent, /^C-1 \(archived\)iteration 3/);

  const empty = { iterations: 0, caught: 0, findings: 0, fixed: 0, cases: [] };
  const none = await openStats(payload({ second_opinion: { codex_after_claude: empty, claude_after_codex: empty } }));
  assert.deepEqual(sectionOf(none, /second model/).querySelectorAll('.st-opinion p').map((p) => p.textContent),
    ['No iteration in this period had both reviews.', 'No iteration in this period had both reviews.']);
});

test('stats client: the Claude review on/off table (SF-132) after the second opinion, an incomplete cost "at least", its note; with no job in either arm the empty text', async () => {
  const page = await openStats();
  const arms = sectionOf(page, /^Claude review on\/off$/);
  assert.deepEqual(rowTexts(tableAfter(arms)), [
    ['Claude review', 'Jobs', 'Delivered', 'Aborted', 'Cost', 'Per delivered', 'Median iterations', 'Codex findings', 'Per job'],
    ['On', '3', '2', '1', 'at least $5.00', 'at least $2.50', '3', '2', '0.7'],
    ['Off', '1', '0', '0', '$3.00', '—', '—', '1', '1'],
  ]);
  assert.equal(arms.querySelector('p')!.textContent, 'Jobs started before the experiment are in neither arm.');

  const empty = (arm: string) => ({ arm, jobs: 0, delivered: 0, aborted: 0, cost_usd: 0, cost_complete: true, usd_per_delivered: null, median_iterations: null, codex_findings: 0, codex_findings_per_job: null });
  const none = await openStats(payload({ arms: [empty('on'), empty('off')] }));
  const noArms = sectionOf(none, /^Claude review on\/off$/);
  assert.equal(noArms.querySelector('table'), null);
  assert.deepEqual(noArms.querySelectorAll('p').map((p) => p.textContent), ['No jobs of the experiment yet.']);
});

test('stats client: the fix session fresh/resume table (SF-316-2) right under the Claude review one, per fix round and mean iterations, its note; with no job in either arm one line', async () => {
  const page = await openStats();
  const titles = sections(page).map((section) => section.querySelector('h3')!.textContent);
  assert.equal(titles.indexOf('Fix session fresh/resume'), titles.indexOf('Claude review on/off') + 1);
  const arms = sectionOf(page, /^Fix session fresh\/resume$/);
  assert.deepEqual(rowTexts(tableAfter(arms)), [
    ['Fix session', 'Jobs', 'Delivered', 'Aborted', 'Cost', 'Per delivered', 'Per fix round', 'Mean iterations', 'Codex findings', 'Per job'],
    ['Fresh', '2', '1', '1', '$3.75', '$3.75', 'at least $0.38', '2', '1', '0.5'],
    ['Resume', '3', '1', '0', 'at least $3.50', 'at least $3.50', '—', '2.3', '0', '0'],
  ]);
  assert.match(arms.querySelector('p')!.textContent, /^Per fix round: /);

  const empty = (arm: string) => ({
    arm, jobs: 0, delivered: 0, aborted: 0, cost_usd: 0, cost_complete: true, usd_per_delivered: null, median_iterations: null, mean_iterations: null, fix_round_usd: null, fix_round_complete: true, codex_findings: 0, codex_findings_per_job: null,
  });
  const none = await openStats(payload({ arms_fix_session: [empty('fresh'), empty('resume')] }));
  const noArms = sectionOf(none, /^Fix session fresh\/resume$/);
  assert.equal(noArms.querySelector('table'), null);
  assert.deepEqual(noArms.querySelectorAll('p').map((p) => p.textContent), ['No jobs with a recorded fix session in this period.']);
});

test('stats client: the recurring findings checklist with/without table (SF-318-3) right under the fix session one, Codex fix verdicts, mean iterations and Implementer per delivered, its note; with no job in either arm one line', async () => {
  const page = await openStats();
  const titles = sections(page).map((section) => section.querySelector('h3')!.textContent);
  assert.equal(titles.indexOf('Recurring findings checklist with/without'), titles.indexOf('Fix session fresh/resume') + 1);
  const arms = sectionOf(page, /^Recurring findings checklist with\/without$/);
  assert.deepEqual(rowTexts(tableAfter(arms)), [
    ['Checklist', 'Jobs', 'Delivered', 'Aborted', 'Codex fix verdicts', 'Per job', 'Mean iterations', 'Implementer per delivered'],
    ['With', '2', '1', '1', '1', '0.5', '1.5', 'at least $1.50'],
    ['Without', '3', '0', '0', '2', '0.7', '2.3', '—'],
  ]);
  assert.match(arms.querySelector('p')!.textContent, /^Implementer per delivered: .* Jobs started without a recorded checklist are in neither arm\.$/);

  const empty = (arm: string) => ({
    arm, jobs: 0, delivered: 0, aborted: 0, cost_usd: 0, cost_complete: true, usd_per_delivered: null, median_iterations: null, codex_findings: 0, codex_findings_per_job: null,
    codex_fix_verdicts: 0, codex_fix_verdicts_per_job: null, mean_iterations: null, implementer_usd: 0, implementer_complete: true, implementer_usd_per_delivered: null,
  });
  const none = await openStats(payload({ arms_findings_checklist: [empty('with'), empty('without')] }));
  const noArms = sectionOf(none, /^Recurring findings checklist with\/without$/);
  assert.equal(noArms.querySelector('table'), null);
  assert.deepEqual(noArms.querySelectorAll('p').map((p) => p.textContent), ['No jobs with a recorded findings checklist in this period.']);
});

test('stats client: the stage table, the by-role table with "not recorded" and "at least"; the Table toggle swaps a chart for its numbers and back', async () => {
  const page = await openStats();
  const stages = sectionOf(page, /^Review stages$/);
  assert.deepEqual(rowTexts(tableAfter(stages)), [
    ['Stage', 'Runs', 'Failed', 'Blocker', 'Major', 'Nit', 'Led to a fix', 'Cost', 'Tokens', 'Cost per run', 'Rounds per ticket'],
    ['Claude review', '2', '1', '1', '2', '3', '1', '$0.30', '1k in · 10 out', '$0.15', '—'],
    ['Codex gate', '1', '0', '0', '1', '0', '1', '—', '1k in (0 cached) · 100 out', '—', '—'],
    // SF-130: (4 runs + 1 failed) / 2 tickets.
    ['Plan check', '4', '1', '0', '1', '0', '1 (Task revised)', '$0.50', 'not recorded', '$0.13', '2.5'],
  ]);
  // SF-317-2: the plan check by mode, with the tickets started after each and the share over 2 iterations.
  assert.deepEqual(rowTexts(tableAfter(stages, 1)), [
    ['Mode', 'Runs', 'Failed', 'Cost', 'Cost per run', 'Tickets started after it', 'More than 2 iterations'],
    ['Full', '3', '1', 'at least $0.45', 'at least $0.15', '4', '1 (25%)'],
    ['Follow-up', '1', '0', '$0.05', '$0.05', '0', '—'],
  ]);
  const spend = sectionOf(page, /^Spend$/);
  assert.deepEqual(spend.querySelectorAll('.st-tile').map((tile) => tile.textContent), ['Cost$12.50Codex gate in tokens only', 'Codex gate tokens2.1M2.1M in (1.0M cached) · 40k out']);
  assert.deepEqual(rowTexts(tableAfter(spend)).slice(0, 5), [
    ['Role', 'Cost', 'Tokens', 'Runs'],
    ['Implementer', 'at least $1.20', '340k in · 950 out', '3'],
    ['Claude review', '$0.30', '1k in · 10 out', '2'],
    // SF-132: the simplification's offers and the user's choices.
    ['Simplification', '$0.00', '0 in · 0 out', '0 · offered 2 · taken 1 · skipped 1'],
    ['Codex gate', 'tokens only', '1k in (0 cached) · 100 out', '1'],
  ]);
  assert.deepEqual(rowTexts(tableAfter(spend)).slice(5).map((row) => row[2]), ['not recorded', 'not recorded', 'not recorded']);
  assert.deepEqual(rowTexts(tableAfter(spend, 1))[1], ['app', '$1.20', '$0.30', '$0.00', '$0.50', '$0.00', '$2.00', '1.1k', '1', '1.5h']);
  // SF-130: the Plan column, the job's plan-check rounds and cost, one unknown.
  assert.deepEqual(rowTexts(tableAfter(sectionOf(page, /^Jobs/)))[0], ['Workspace', 'Ticket', 'Title', 'State', 'Started', 'Iterations', 'Cost', 'Plan', 'Codex tokens', 'Claude B/M/N', 'Codex B/M/N', 'Time to ready']);
  assert.deepEqual(rowTexts(tableAfter(sectionOf(page, /^Jobs/)))[1], ['app', 'T-1', 'Demo', 'needs human', '2026-11-06 10:00', '2', 'at least $1.50', '3 rounds · at least $0.75', '1.1k', '1 / 2 / 3', '0 / 1 / 0', '—']);
  const complete = await openStats(payload({ jobs: [{ ...payload().jobs[0], plan_check_usd_complete: true }, { ...payload().jobs[0], ticket: 'T-2', plan_checks: 0, plan_check_usd: 0 }] }));
  assert.deepEqual(rowTexts(tableAfter(sectionOf(complete, /^Jobs/))).slice(1).map((row) => row[7]), ['3 rounds · $0.75', '—']);
  assert.deepEqual(sectionOf(page, /^Load$/).querySelectorAll('.st-tile').map((tile) => tile.textContent),
    ['Jobs started3', 'Finished2pushed 1 · aborted 1 · failed 0', 'Time to ready1.5hmedian', 'Iterations2median of pushed jobs']);

  const box = chart(page, 'cost-day');
  assert.equal(box.querySelector('h4')!.textContent, 'Cost per day');
  const toggle = box.querySelector('button')!;
  assert.deepEqual([toggle.textContent, toggle.getAttribute('aria-pressed'), box.querySelector('table')], ['Table', 'false', null]);
  assert.ok(box.querySelector('svg') !== null);
  assert.deepEqual(box.querySelectorAll('.st-legend .st-key').map((key) => key.textContent), ['Implementer', 'Claude review', 'Simplification', 'Plan check', 'Digest', 'Explanations']);
  toggle.click();
  await page.flush();
  const tabled = chart(page, 'cost-day');
  assert.equal(tabled.querySelector('svg'), null);
  assert.deepEqual([tabled.querySelector('button')!.textContent, tabled.querySelector('button')!.getAttribute('aria-pressed')], ['Chart', 'true']);
  assert.deepEqual(rowTexts(tabled.querySelector('table')!), [
    ['Day', 'Implementer', 'Claude review', 'Simplification', 'Plan check', 'Digest', 'Explanations', 'Total'],
    ['2026-11-06', '$1.20', '$0.30', '$0.00', '$0.00', '$0.00', '$0.00', '$1.50'],
    ['2026-11-07', '$0.00', '$0.00', '$0.00', '$0.00', '$0.00', '$0.00', '$0.00'],
  ]);
  tabled.querySelector('button')!.click();
  await page.flush();
  assert.ok(chart(page, 'cost-day').querySelector('svg') !== null);
  assert.equal(chart(page, 'cost-day').querySelector('table'), null);
});

test('stats client: the charts are SVG made with createElementNS and class attributes, each rect titled; no element of the page has a style attribute', async () => {
  const page = await openStats();
  const svgs = root(page).querySelectorAll('svg');
  assert.ok(svgs.length >= 4);
  for (const svg of svgs) {
    assert.equal(svg.namespaceURI, SVG);
    assert.equal(svg.getAttribute('role'), 'img');
    assert.equal(svg.getAttribute('width'), '100%');
    for (const node of svg.all()) {
      assert.equal(node.namespaceURI, SVG);
    }
  }
  const columns = chart(page, 'cost-day').querySelector('svg')!;
  assert.deepEqual([columns.getAttribute('viewBox'), columns.getAttribute('aria-label')], ['0 0 720 220', 'Cost per day']);
  // Gridlines at 0, ¼, ½, ¾ and the top (2, the smallest nice value above $1.50).
  assert.deepEqual(columns.querySelectorAll('line').map((line) => line.getAttribute('class')), ['st-grid', 'st-grid', 'st-grid', 'st-grid', 'st-grid']);
  assert.deepEqual(columns.querySelectorAll('text').slice(0, 5).map((text) => text.textContent), ['$0.00', '$0.50', '$1.00', '$1.50', '$2.00']);
  const rects = columns.querySelectorAll('rect');
  assert.deepEqual(rects.map((rect) => rect.getAttribute('class')), ['st-c-implementer', 'st-c-claude_review']);
  assert.equal(rects[0]!.querySelector('title')!.textContent, '2026-11-06 · Implementer: $1.20');
  const bars = chart(page, 'findings').querySelector('svg')!;
  assert.equal(bars.getAttribute('viewBox'), '0 0 720 84');
  assert.deepEqual(bars.querySelectorAll('rect').map((rect) => rect.getAttribute('class')), ['st-c-blocker', 'st-c-major', 'st-c-nit', 'st-c-major', 'st-c-major']);
  const styled = [page.document.documentElement, ...page.document.documentElement.all()].filter((node) => node.attributes.has('style') || node.style.properties.size > 0);
  assert.deepEqual(styled.filter((node) => root(page).contains(node)), []);
  assert.deepEqual(root(page).all().filter((node) => node.attributes.has('style')), []);
});

test('stats client: an all-zero chart keeps its box, title and toggle with the muted line in place of the SVG; its table shows the zeros', async () => {
  const zero = { day: '2026-11-07', cost: ZERO_COST, codex_tokens: ZERO_TOKENS, started: 0, finished: 0 };
  const page = await openStats(payload({ days_rows: [{ ...zero, day: '2026-11-06' }, zero], by_workspace: [], stages: payload().stages.map((row) => ({ ...row, findings: { blocker: 0, major: 0, nit: 0 } })) }));
  for (const [id, title, line] of [
    ['cost-day', 'Cost per day', 'No cost in this period.'], ['tokens-day', 'Codex gate tokens per day', 'No Codex gate run in this period.'],
    ['started-day', 'Jobs started per day', 'No job started in this period.'], ['findings', 'Findings per stage', 'No findings in this period.'],
  ]) {
    const box = chart(page, id!);
    assert.equal(box.className, 'st-chart', id);
    assert.equal(box.querySelector('h4')!.textContent, title);
    assert.equal(box.querySelector('button')!.textContent, 'Table');
    assert.equal(box.querySelector('svg'), null);
    assert.equal(box.querySelector('p.st-none')!.textContent, line);
  }
  chart(page, 'started-day').querySelector('button')!.click();
  await page.flush();
  assert.deepEqual(rowTexts(chart(page, 'started-day').querySelector('table')!), [['Day', 'Jobs started'], ['2026-11-06', '0'], ['2026-11-07', '0']]);
});

test('stats client: opening #stats from a job page leaves the job (its stream closes) and closes an open drawer', async () => {
  const page = await openPage('#app/T-1');
  assert.equal(page.$('job').hidden, false);
  const jobStream = page.streams.at(-1)!;
  assert.match(jobStream.url, /job=app%2FT-1/);
  page.$('open-workspaces').click();
  await page.flush();
  assert.equal(page.$('drawer').hidden, false);
  page.location.hash = '#stats';
  page.window.dispatch('hashchange');
  await page.flush();
  assert.equal(jobStream.closed, true);
  assert.equal(page.streams.at(-1)!.url, 'api/stream?');
  assert.deepEqual([page.$('drawer').hidden, page.$('job').hidden, root(page).hidden], [true, true, false]);
});

test('stats client: loading, a failed read with Retry, "No jobs yet"; Escape goes back to the board; the board, job, ticket and digest pages hide #stats', async () => {
  const page = await openPage('#stats');
  statsReads(page)[0]!.respond(500, '');
  await page.flush();
  assert.match(body(page).textContent, /^The stats could not be read \(api\/stats\?days=30: HTTP 500\)\.Retry$/);
  root(page).querySelectorAll('button').find((node) => node.textContent === 'Retry')!.click();
  await page.flush();
  assert.equal(statsReads(page).length, 2);
  const roles = payload().roles.map((row) => ({ ...row, runs: 0 }));
  statsReads(page)[1]!.respond(200, payload({ workspaces: [], roles }));
  await page.flush();
  assert.equal(body(page).textContent, 'No jobs yet. The stats fill in once the factory has run a job.');
  assert.deepEqual(sections(page), []);

  // Escape in the select only blurs it; on the page it goes back to the board.
  const pick = root(page).querySelector('select')!;
  pick.focus();
  page.key('Escape');
  assert.equal(root(page).hidden, false);
  root(page).querySelector('[data-back]')!.focus();
  page.key('Escape');
  assert.deepEqual([root(page).hidden, page.$('board').hidden, page.location.hash], [true, false, '#']);

  for (const [hash, shown] of [['#app/T-1', 'job'], ['#app/P-1/ticket', 'ticket'], ['#digest', 'digest'], ['', 'board']] as const) {
    page.location.hash = '#stats';
    page.window.dispatch('hashchange');
    await page.flush();
    assert.equal(root(page).hidden, false, hash);
    page.location.hash = hash;
    page.window.dispatch('hashchange');
    await page.flush();
    assert.deepEqual([root(page).hidden, page.$(shown).hidden], [true, false], hash);
  }
});
