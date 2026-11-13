// The Skills page in skills.js (SF-202), run under node:vm against the fake page of
// test/support/fake-dom.ts: #skills, the Skills tab and the page select open it; the rows and the
// role boxes from a fake api/skills, each box labelled, each head with its count; a click sends the
// role's new list at once (PUT api/skills/roles/<role>), every box disabled until the answer;
// a refused PUT or a network error puts the box back, shows the message and reads the list again,
// and a read under way when a later PUT is answered is dropped;
// the filter; the skills chosen but not installed with their boxes; a skill's SKILL.md in the side
// panel as text (a <script> stays text), Close and Escape; the other pages hiding #skills. Script
// checks, not browser acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);

const ROLES = { implementer: ['implement', 'tdd'], claude_review: ['code-review'], codex_gate: ['code-review'], task_check: [], planner: ['grilling', 'old-skill'] };

function payload(extra: Record<string, unknown> = {}) {
  return {
    skills: [
      { name: 'code-review', source: 'mattpocock/skills', updated: '2026-11-10T08:00:00.000Z', description: 'Review the changes since a fixed point.\nAlong two axes.' },
      { name: 'grilling', source: 'mattpocock/skills', updated: null, description: 'Grill the user relentlessly.' },
      { name: 'implement', source: null, updated: '2026-11-01T08:00:00.000Z', description: null },
      { name: 'tdd', source: 'mattpocock/skills', updated: '2026-11-02T08:00:00.000Z', description: 'Test-driven development.' },
    ],
    roles: ROLES,
    missing: ['old-skill'],
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

// The page at the hash, with the board's data; the skills' requests stay pending for the test.
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

const reads = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'GET' && request.path === 'api/skills');
const puts = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'PUT');
const textReads = (page: Page): FetchRequest[] => page.requests.filter((request) => request.path.startsWith('api/skills/') && request.method === 'GET');

// #skills opened and answered with data.
async function openSkills(data: unknown = payload()): Promise<Page> {
  const page = await openPage('#skills');
  reads(page).at(-1)!.respond(200, data);
  await page.flush();
  return page;
}

const root = (page: Page): FakeElement => page.$('skills');
const heads = (page: Page): string[] => root(page).querySelectorAll('.sk-table th').map((node) => node.textContent);
const rows = (page: Page): FakeElement[] => root(page).querySelectorAll('.sk-table tbody tr');
const box = (page: Page, label: string): FakeElement => root(page).querySelectorAll('input[type="checkbox"]').find((node) => node.getAttribute('aria-label') === label)!;
const boxes = (row: FakeElement): boolean[] => row.querySelectorAll('input[type="checkbox"]').map((node) => node.checked);
const message = (page: Page): string | undefined => root(page).querySelector('.sk-message')?.textContent;
// A box clicked as a browser does: its checked state flips, then change fires.
function click(node: FakeElement): void {
  node.checked = !node.checked;
  node.click();
  node.dispatch('change');
}

test('skills client: #skills, the Skills tab and the page select open the page and read api/skills; the rows by name, the boxes labelled, the heads with their counts', async () => {
  const page = await openPage('#skills');
  assert.deepEqual([root(page).hidden, page.$('board').hidden], [false, true]);
  assert.deepEqual(reads(page).length, 1);
  assert.match(root(page).textContent, /Loading the skills…/);
  reads(page)[0]!.respond(200, payload());
  await page.flush();

  assert.deepEqual(heads(page), ['Skill', 'Implementer · 2', 'Claude review · 1', 'Codex gate · 1', 'Task check · 0', 'Planner (ChatGPT) · 2Applies to the next planning request']);
  assert.deepEqual(rows(page).map((row) => row.querySelector('[data-sk-open]')!.textContent), ['code-review', 'grilling', 'implement', 'tdd']);
  assert.deepEqual(rows(page).map(boxes), [
    [false, true, true, false, false],
    [false, false, false, false, true],
    [true, false, false, false, false],
    [true, false, false, false, false],
  ]);
  // The description's first line, the whole on hover; the source and the updated date, muted.
  const first = rows(page)[0]!;
  const description = first.querySelector('.sk-desc')!;
  assert.deepEqual([description.textContent, description.getAttribute('title')], ['Review the changes since a fixed point.', 'Review the changes since a fixed point.\nAlong two axes.']);
  assert.equal(first.querySelector('.sk-meta.muted')!.textContent, 'mattpocock/skills · 2026-11-10');
  assert.equal(rows(page)[2]!.querySelector('.sk-desc'), null);
  assert.equal(box(page, 'tdd for Implementer').checked, true);
  assert.equal(box(page, 'grilling for Planner (ChatGPT)').checked, true);
  assert.match(root(page).textContent, /Changes apply to jobs started after; running jobs keep their skills\./);

  const board = await openPage('');
  assert.equal(root(board).hidden, true);
  board.$('open-skills').click();
  await board.flush();
  assert.deepEqual([root(board).hidden, board.location.hash, reads(board).length], [false, '#skills', 1]);
  const select = await openPage('');
  const pages = select.$('page-select');
  pages.value = 'skills';
  pages.dispatch('change');
  await select.flush();
  assert.deepEqual([root(select).hidden, select.location.hash, pages.value], [false, '#skills', 'board']);
});

test('skills client: a click sends the role\'s new list at once, every box disabled until the answer; the answer is shown', async () => {
  const page = await openSkills();
  click(box(page, 'grilling for Implementer'));
  await page.flush();
  assert.deepEqual(puts(page).map((request) => [request.path, request.body, request.headers['content-type']]), [['api/skills/roles/implementer', '{"skills":["implement","tdd","grilling"]}', 'application/json']]);
  // While it is sent: the box shows the new state, every box is disabled.
  assert.deepEqual([box(page, 'grilling for Implementer').checked, box(page, 'grilling for Implementer').disabled, box(page, 'tdd for Implementer').disabled, box(page, 'grilling for Claude review').disabled], [true, true, true, true]);
  assert.equal(heads(page)[1], 'Implementer · 3');
  // A change on a box while it is sent sends nothing.
  box(page, 'tdd for Claude review').dispatch('change');
  await page.flush();
  assert.equal(puts(page).length, 1);

  puts(page)[0]!.respond(200, { ok: true, result: payload({ roles: { ...ROLES, implementer: ['implement', 'tdd', 'grilling'] } }) });
  await page.flush();
  assert.deepEqual([box(page, 'grilling for Implementer').checked, box(page, 'grilling for Implementer').disabled, heads(page)[1], message(page)], [true, false, 'Implementer · 3', undefined]);

  // Off: the list without it.
  click(box(page, 'code-review for Codex gate'));
  await page.flush();
  assert.deepEqual([puts(page)[1]!.path, puts(page)[1]!.body], ['api/skills/roles/codex_gate', '{"skills":[]}']);
});

test('skills client: a refused PUT and a network error put the box back, show the message next to the table and read the list again', async () => {
  const page = await openSkills();
  click(box(page, 'tdd for Claude review'));
  await page.flush();
  puts(page)[0]!.respond(400, { ok: false, error: { code: 'skill_not_installed', message: 'Not an installed skill: tdd.' } });
  await page.flush();
  assert.deepEqual([box(page, 'tdd for Claude review').checked, box(page, 'tdd for Claude review').disabled, heads(page)[2]], [false, false, 'Claude review · 1']);
  assert.equal(message(page), 'tdd for Claude review was not switched on: Not an installed skill: tdd.');
  assert.equal(reads(page).length, 2);
  reads(page)[1]!.respond(200, payload());
  await page.flush();
  assert.equal(box(page, 'tdd for Claude review').checked, false);

  click(box(page, 'implement for Implementer'));
  await page.flush();
  puts(page)[1]!.fail('connection reset');
  await page.flush();
  assert.deepEqual([box(page, 'implement for Implementer').checked, box(page, 'implement for Implementer').disabled], [true, false]);
  assert.match(message(page)!, /^implement for Implementer was not switched off: /);
  // The read after it shows what the server stored.
  reads(page)[2]!.respond(200, payload({ roles: { ...ROLES, implementer: ['tdd'] } }));
  await page.flush();
  assert.equal(box(page, 'implement for Implementer').checked, false);

  // A read under way when a later PUT is answered is dropped: it predates the stored change.
  click(box(page, 'grilling for Task check'));
  await page.flush();
  puts(page)[2]!.respond(409, { ok: false, error: { code: 'updating', message: 'The factory is updating.' } });
  await page.flush();
  click(box(page, 'grilling for Codex gate'));
  await page.flush();
  puts(page)[3]!.respond(200, { ok: true, result: payload({ roles: { ...ROLES, implementer: ['tdd'], codex_gate: ['code-review', 'grilling'] } }) });
  await page.flush();
  reads(page)[3]!.respond(200, payload({ roles: { ...ROLES, implementer: ['tdd'] } }));
  await page.flush();
  assert.deepEqual([box(page, 'grilling for Codex gate').checked, box(page, 'grilling for Task check').checked, message(page)], [true, false, undefined]);
});

test('skills client: the filter hides the rows whose name and description miss it; the missing list with its boxes to switch it off', async () => {
  const page = await openSkills();
  const filter = root(page).querySelector('input[type="search"]')!;
  filter.value = 'GRILL';
  filter.dispatch('input');
  assert.deepEqual(rows(page).filter((row) => !row.hidden).map((row) => row.dataset.skRow), ['grilling']);
  filter.value = 'driven';
  filter.dispatch('input');
  assert.deepEqual(rows(page).filter((row) => !row.hidden).map((row) => row.dataset.skRow), ['tdd']);

  const missing = root(page).querySelectorAll('.sk-missing li');
  assert.deepEqual(missing.map((item) => item.querySelector('.sk-missing-text')!.textContent), ['Chosen but not installed: old-skill (Planner (ChatGPT))']);
  const off = box(page, 'old-skill for Planner (ChatGPT)');
  assert.equal(off.checked, true);
  click(off);
  await page.flush();
  assert.deepEqual([puts(page)[0]!.path, puts(page)[0]!.body], ['api/skills/roles/planner', '{"skills":["grilling"]}']);
  puts(page)[0]!.respond(200, { ok: true, result: payload({ roles: { ...ROLES, planner: ['grilling'] }, missing: [] }) });
  await page.flush();
  assert.equal(root(page).querySelector('.sk-missing'), null);
  assert.equal(heads(page)[5], 'Planner (ChatGPT) · 1Applies to the next planning request');
  // The filter stays across the re-render.
  assert.deepEqual(rows(page).filter((row) => !row.hidden).map((row) => row.dataset.skRow), ['tdd']);

  const none = await openSkills(payload({ skills: [], roles: { ...ROLES, implementer: [] }, missing: [] }));
  assert.match(root(none).textContent, /No skills installed: npx skills add <source> installs one\./);
});

test('skills client: a skill\'s name opens its SKILL.md in the side panel as text (a <script> stays text); Close and Escape close it, the next Escape goes back', async () => {
  const page = await openSkills();
  root(page).querySelector('[data-sk-open="grilling"]')!.click();
  await page.flush();
  assert.deepEqual(textReads(page).map((request) => request.path), ['api/skills/grilling']);
  const panel = (): FakeElement | null => root(page).querySelector('.sk-panel');
  assert.match(panel()!.textContent, /Loading…/);
  assert.equal(page.document.activeElement, panel()!.querySelector('[data-sk="close"]'));
  const text = '---\nname: grilling\n---\n<script>alert(1)</script><b>bold</b>';
  textReads(page)[0]!.respond(200, { name: 'grilling', text, truncated: false });
  await page.flush();
  const pre = panel()!.querySelector('pre.sk-text')!;
  assert.equal(pre.textContent, text);
  assert.deepEqual([pre.querySelectorAll('script').length, pre.querySelectorAll('b').length], [0, 0]);
  panel()!.querySelector('[data-sk="close"]')!.click();
  assert.equal(panel(), null);
  assert.equal(page.document.activeElement, root(page).querySelector('[data-sk-open="grilling"]'));

  // A failed read, a cut file; Escape closes the panel first, then goes back to the board.
  root(page).querySelector('[data-sk-open="tdd"]')!.click();
  await page.flush();
  textReads(page)[1]!.respond(404, '');
  await page.flush();
  assert.match(panel()!.textContent, /The skill could not be read \(api\/skills\/tdd: HTTP 404\)\./);
  page.key('Escape');
  assert.deepEqual([panel(), root(page).hidden], [null, false]);
  root(page).querySelector('[data-sk-open="code-review"]')!.click();
  await page.flush();
  textReads(page)[2]!.respond(200, { name: 'code-review', text: 'x', truncated: true });
  await page.flush();
  assert.match(panel()!.textContent, /only its first 256 KB are shown/);
  page.key('Escape');
  page.key('Escape');
  assert.deepEqual([root(page).hidden, page.$('board').hidden, page.location.hash], [true, false, '#']);
});

test('skills client: a failed read with Retry; the board, job, ticket, digest and stats pages hide #skills; no element has a style attribute', async () => {
  const page = await openPage('#skills');
  reads(page)[0]!.respond(500, '');
  await page.flush();
  assert.match(root(page).textContent, /The skills could not be read \(api\/skills: HTTP 500\)\.Retry/);
  root(page).querySelectorAll('button').find((node) => node.textContent === 'Retry')!.click();
  await page.flush();
  reads(page)[1]!.respond(200, payload());
  await page.flush();
  assert.equal(rows(page).length, 4);
  assert.deepEqual(root(page).querySelectorAll('[style]'), []);

  for (const [hash, shown] of [['#app/T-1', 'job'], ['#app/P-1/ticket', 'ticket'], ['#digest', 'digest'], ['#stats', 'stats'], ['', 'board']] as const) {
    page.location.hash = '#skills';
    page.window.dispatch('hashchange');
    await page.flush();
    assert.equal(root(page).hidden, false, hash);
    page.location.hash = hash;
    page.window.dispatch('hashchange');
    await page.flush();
    assert.deepEqual([root(page).hidden, page.$(shown).hidden], [true, false], hash);
  }
});
