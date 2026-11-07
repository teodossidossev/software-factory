// Behaviour of the job page's Stream in static/app.js (SF-078), run under node:vm against the fake
// page of test/support/fake-dom.ts: SF-082's entries read page by page from
// api/jobs/<ws>/<ticket>/stream, then live from the stream's entries events (a reconnect resumes at
// the next line, an entry is never shown twice, a tool_result joins its tool by id), each entry type
// as the prototype's entryHtml draws it, the separators, the keys j, k, G and Enter, the toggles,
// the path links to Changes, the implement prompt's Task; the stop block of every needs_human code
// (its label, sentence and what it shows inline) and the composer: its actions per state, its inline
// confirmations, the posts and their bodies, Ctrl+Enter, Escape, Refresh state and the reasons of
// disabled buttons. Script checks, not browser acceptance: the manual steps are in factory/README.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
// Local times: Sofia is UTC+2 in November.
process.env.TZ = 'Europe/Sofia';

type Row = Record<string, unknown> & { state: string };
type Entry = Record<string, unknown> & { k: string; t: string };

function job(state: string, extra: Record<string, unknown> = {}): Row {
  const prepared = state === 'ready_for_human_review' || state === 'pushed';
  return {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', state, iteration: 1, mr_attempts: 0,
    updated_at: '2026-11-01T10:05:00.000Z', created_at: '2026-11-01T10:00:00.000Z', error: null,
    prepared_commit: prepared ? 'a'.repeat(40) : null, worktree: prepared ? null : '/wt/T-1', mr: null, mr_host: { host: 'github', reason: null },
    fixes: 0, gate_fixes: 0, gate_tokens: 0, files: 2, undeclared: 0, deleted: 0, title: 'Demo', cost_usd: 1.5, now: null, tool_calls: 0, stop: null, ...extra,
  };
}

const times = { started_at: '2026-11-01T10:05:01.000Z', ended_at: '2026-11-01T10:06:00.000Z' };
const META = { started_at: '2026-11-01T10:00:01.000Z', ended_at: '2026-11-01T10:05:00.000Z', cost_usd: 0.5, changed_files: 2, patch_truncated: false, denials: 0 };
const CLEAN = { reviewer: 'claude', verdict: 'clean', summary: 'Right.', items: [], accepted_sensitive: [], cost_usd: 0.25, ...times };
const CLAUDE_FIX = {
  reviewer: 'claude', verdict: 'fix', summary: 'Wrong.', accepted_sensitive: [], cost_usd: 0.25, ...times,
  items: [{ severity: 'major', path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.' }, { severity: 'nit', path: 'a.txt', problem: 'Empty.', expected: 'A line.' }],
};
const GATE_FIX = { reviewer: 'codex', verdict: 'fix', summary: 'Not quite.', accepted_sensitive: [], items: [{ path: 'README.md', problem: 'It greets the world.', expected: 'It greets the reader.' }], ...times };
const GATE_FAILED = { reviewer: 'codex', error: 'Codex wrote no output.', ...times };
const SUGGESTION = { path: 'src/guard.ts', what: 'The second guard.', why: 'The first one covers it.', saves_lines: 3, ledger_ids: ['R1'] };
const SIMPLIFY = { reviewer: 'simplify', summary: 'One guard too many.', suggestions: [SUGGESTION], dropped: [], ...times };
const FILES = [
  { path: 'src/a.ts', status: 'modified', sensitive: 'no', additions: 1, deletions: 1 },
  { path: 'README.md', status: 'modified', sensitive: 'no', additions: 1, deletions: 0 },
];

function iteration(number: number, extra: Record<string, unknown> = {}) {
  return { number, ...META, files: FILES, review: null, gate: null, gate_override: null, simplify: null, ...extra };
}

function detail(row: Row, extra: Record<string, unknown> = {}) {
  return { job: row, iterations: [iteration(1)], mr: false, mr_title: null, gate: true, ledger: [], history: [], ...extra };
}

function ledgerEntry(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id, iteration: 1, reviewer: 'claude', severity: 'major', path: 'README.md', problem: `Problem of ${id}.`, expected: 'Better.', status,
    response: '', evidence: '', reopened: 0, asked: 1, caused_by: '', dispute: null, settled: null, ...extra,
  };
}

const at = (minute: number): string => `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
const state = (k: string, from: string | null, to: string, code: string | null = null, msg: string | null = null, minute = 0): Entry =>
  ({ k, ts: at(minute), it: 1, who: 'factory', t: 'state', from, to, code, msg });
const tool = (k: string, id: string, line: string, who = 'implementer'): Entry => ({ k, ts: at(2), it: 1, who, t: 'tool', id, line, detail: `{\n  "command": "${line}"\n}` });
const result = (k: string, id: string, out: string, err = false, who = 'implementer'): Entry => ({ k, ts: at(3), it: 1, who, t: 'tool_result', id, out, result: `output of ${id}`, err });
const IMPLEMENT: Entry = { k: '2', ts: at(1), it: 1, who: 'factory', t: 'prompt', kind: 'implement', text: '/implement .software-factory/T-1.md', first: '/implement .software-factory/T-1.md', task_changed: false };

// One entry of each type, in order, as SF-082 sends them.
const STREAM: Entry[] = [
  state('0', null, 'starting'),
  state('1', 'starting', 'working'),
  IMPLEMENT,
  { k: '3.0', ts: at(2), it: 1, who: 'implementer', t: 'text', text: 'Working on `it`, **now**.' },
  tool('3.1', 'tu1', 'Bash npm test'),
  result('4', 'tu1', '12 lines'),
  { k: '5', ts: at(4), it: 1, who: 'implementer', t: 'result', turns: 3, ms: 120000, cost: 0.5 },
  state('6.0', 'working', 'awaiting_review', null, null, 5),
  { k: '6.1', ts: at(5), it: 1, who: 'factory', t: 'changes', files: 2, paths: ['src/a.ts', 'README.md'] },
  { k: '7', ts: at(6), it: 1, who: 'claude', t: 'verdict', verdict: 'fix', effective: 'fix', summary: 'Two things.', items: [
    { severity: 'major', path: 'src/a.ts', problem: 'Wrong.', expected: 'Right.', id: 'R1' }, { severity: 'nit', path: 'README.md', problem: 'Typo.', expected: '', id: null },
  ] },
  { k: '8', ts: at(7), it: 1, who: 'codex', t: 'text', text: '[withheld: the gate\'s message]' },
  { k: '9', ts: at(8), it: 1, who: 'factory', t: 'note', text: 'notify failed: no webhook' },
  { k: '10', ts: at(9), it: 1, who: 'factory', t: 'prompt', kind: 'fix', fix_n: 1, task_changed: true, text: '/implement .software-factory/T-1.md Fix 1', first: '/implement .software-factory/T-1.md Fix 1',
    fix: '## Fix 1\n\nReview by Claude: Two things.\n\n1. [R1, major] `src/a.ts`: Wrong. Expected: Right.\n\nNits (optional):\n2. [R2, nit] `README.md`: Typo. Expected: Fixed.' },
  { k: '11', ts: at(10), it: 2, who: 'you', t: 'user', text: 'Mind **this**.', task_changed: false },
  { k: '12', ts: at(11), it: 2, who: 'claude', t: 'simplify', suggestions: [SUGGESTION], saves_lines: 3 },
  { k: '13', ts: at(12), it: 2, who: 'factory', t: 'prompt', kind: 'continue', text: 'Continue where you stopped.', first: 'Continue where you stopped.', task_changed: false },
  { k: '14', ts: at(13), it: 2, who: 'mr', t: 'prompt', kind: 'mr', text: 'MR preparation for T-1 on main.', first: 'MR preparation for T-1 on main.', task_changed: false },
];

// What each page's api/jobs/app/T-1 answers: the detail last shown by openJob or update.
const served = new Map<Page, { detail: unknown }>();

// The job page of row with its Stream: pages answers api/jobs/app/T-1/stream?from=<n> (an empty last
// page when it has none), get any other GET (undefined leaves it pending); control.held leaves the
// detail's reads to the test.
async function openJob(row: Row, shown: ReturnType<typeof detail> = detail(row), pages: Record<number, unknown> = {}, get: (path: string) => unknown = () => undefined,
  control = { held: false }): Promise<Page> {
  const current = { detail: shown as unknown };
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs: [row] };
    }
    if (path === 'api/jobs/app/T-1') {
      return control.held ? undefined : current.detail;
    }
    const from = /^api\/jobs\/app\/T-1\/stream\?from=(\d+)$/.exec(path)?.[1];
    if (from !== undefined && pages[Number(from)] !== undefined) {
      return pages[Number(from)];
    }
    return get(path);
  });
  served.set(page, current);
  page.location.hash = '#app/T-1';
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const live = page.streams.at(-1)!;
  live.emit('open');
  live.emit('jobs', { jobs: [row] });
  live.emit('job', shown);
  await page.flush();
  return page;
}

// The page with these entries as the Stream's one page.
const withEntries = (row: Row, shown: ReturnType<typeof detail>, entries: Entry[], get?: (path: string) => unknown): Promise<Page> =>
  openJob(row, shown, { 0: { entries, next: entries.length, end: true } }, get);

const nodes = (page: Page): FakeElement[] => (page.$('stream').children as FakeElement[]);
const entryOf = (page: Page, k: string): FakeElement => nodes(page).find((node) => node.dataset.k === k)!;
const sel = (page: Page): string[] => nodes(page).filter((node) => node.classList.contains('sel')).map((node) => node.dataset.k!);
const acts = (page: Page): FakeElement[] => page.$('acts').children as FakeElement[];
const labels = (page: Page): string[] => acts(page).map((node) => node.textContent);
const act = (page: Page, label: string): FakeElement => acts(page).find((node) => node.textContent === label)!;
const posts = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'POST');
const sent = (page: Page): Array<[string, unknown]> => posts(page).map((request) => [request.path.replace('api/jobs/app/T-1/', ''), JSON.parse(request.body!)]);
const byClass = (node: FakeElement, className: string): FakeElement[] => node.all().filter((element) => element.classList.contains(className));
const buttonIn = (node: FakeElement, text: string): FakeElement => node.all().find((element) => element.tagName === 'BUTTON' && element.textContent === text)!;

async function update(page: Page, row: Row, shown: ReturnType<typeof detail> = detail(row)): Promise<void> {
  served.get(page)!.detail = shown;
  page.streams.at(-1)!.emit('jobs', { jobs: [row] });
  page.streams.at(-1)!.emit('job', shown);
  await page.flush();
}

test('stream client: each entry type in order, with the separators, the local time, who and the continuation of the same author', async () => {
  const page = await withEntries(job('working', { iteration: 1 }), detail(job('working', { iteration: 1 })), STREAM);
  assert.deepEqual(nodes(page).map((node) => node.className), [
    'e e-state who-factory', 'e e-state who-factory', 'sep', 'e e-prompt who-factory', 'e e-text who-implementer', 'e e-tool who-implementer', 'e e-result who-implementer',
    'e e-state who-factory', 'e e-changes who-factory', 'e e-verdict who-claude', 'e e-text who-codex', 'e e-note who-factory',
    'sep', 'e e-prompt who-factory', 'e e-user who-you', 'e e-simplify who-claude', 'e e-prompt who-factory', 'sep', 'e e-prompt who-mr',
  ]);
  // The separators: the iteration, the Fix N tag (Fix 1 starts iteration 2), MR preparation; a continue prompt has none.
  assert.deepEqual(nodes(page).filter((node) => node.className === 'sep').map((node) => node.textContent), ['Iteration 1', 'Iteration 2 Fix 1', 'MR preparation']);
  // Each entry: the local hh:mm, who (hidden for the same author's tool, text and result), the body.
  const parts = (k: string): string[] => (entryOf(page, k).children as FakeElement[]).map((child) => child.textContent);
  assert.deepEqual(parts('0'), ['12:00', 'State', 'Starting– → starting']);
  assert.deepEqual(parts('1'), ['12:00', 'State', 'The Implementer starts' + 'starting → working']);
  assert.deepEqual((entryOf(page, '3.1').children[1] as FakeElement).className, 'who cont');
  assert.deepEqual((entryOf(page, '5').children[1] as FakeElement).className, 'who cont');
  assert.deepEqual((entryOf(page, '3.0').children[1] as FakeElement).className, 'who');
  assert.equal(parts('2')[2], 'The Implementer got the Task file /implement .software-factory/T-1.md prompt Task');
  // Text as prose: `code` and **bold** as elements, never HTML.
  const prose = byClass(entryOf(page, '3.0'), 'prose')[0]!;
  assert.deepEqual([prose.textContent, prose.all().map((element) => `${element.tagName}:${element.textContent}`)], ['Working on it, now.', ['CODE:it', 'B:now']]);
  // The tool line: its verb, the rest and its joined result.
  const line = entryOf(page, '3.1').querySelector('button.line')!;
  assert.deepEqual([line.textContent, line.querySelector('.verb')!.textContent, line.querySelector('.out')!.className, line.getAttribute('title')], [
    'Bash npm test → 12 lines', 'Bash', 'out', 'Bash npm test  → 12 lines',
  ]);
  assert.equal(parts('5')[2], 'Turn ended · 3 turns · 2 min · session $0.50');
  assert.equal(parts('6.0')[2], 'The Implementer finished; the reviews startworking → awaiting_review');
  // The changes entry: the files as path links, Open these changes (c) and the Report toggle.
  const changes = entryOf(page, '6.1');
  assert.equal(byClass(changes, 'body')[0]!.textContent, 'Iteration 1 ended: 2 files changedOpen these changes csrc/a.tsREADME.mdReport');
  assert.deepEqual(byClass(changes, 'pathlink').map((link) => [link.textContent, link.dataset.cfile, link.dataset.cit]), [['src/a.ts', 'src/a.ts', '1'], ['README.md', 'README.md', '1']]);
  assert.deepEqual(byClass(changes, 'd').map((part) => part.textContent), ['src/']);
  // The verdict: who and the iteration, the pill, the count, the summary (clamped) and the findings.
  const verdict = entryOf(page, '7');
  assert.deepEqual([byClass(verdict, 'block')[0]!.className, byClass(verdict, 'bh')[0]!.textContent], ['block clamp', 'Claude review · iteration 1 asks for fixes2 notes']);
  assert.deepEqual([byClass(verdict, 'verdict')[0]!.className, byClass(verdict, 'summary')[0]!.textContent], ['verdict fix', 'Two things.']);
  assert.deepEqual(byClass(verdict, 'finding').map((finding) => (finding.children as FakeElement[]).map((child) => `${child.className}:${child.textContent}`)), [
    ['fid:R1', 'sev sev-major:major', 'pathlink:src/a.ts', 'problem:Wrong.', 'expected:Expected: Right.'],
    ['fid:#2', 'sev sev-nit:nit', 'pathlink:README.md', 'problem:Typo.'],
  ]);
  assert.equal(parts('8')[2], '(message withheld by the factory)');
  assert.equal(parts('9')[2], 'notify failed: no webhook');
  // The Fix section: its items as findings with their ledger ids, the full prompt behind a toggle.
  const fix = byClass(entryOf(page, '10'), 'fixsec')[0]!;
  assert.match(byClass(fix, 'bh')[0]!.textContent, /^Fix 1 sent to the Implementer 2 items with the Task file's change$/);
  assert.equal(byClass(fix, 'summary')[0]!.textContent, "## Fix 1\n\nReview by Claude: Two things.");
  assert.deepEqual(byClass(fix, 'finding').map((finding) => (finding.children as FakeElement[]).map((child) => child.textContent)), [
    ['R1', 'major', 'src/a.ts', 'Wrong.', 'Expected: Right.'], ['R2', 'nit', 'README.md', 'Typo.', 'Expected: Fixed.'],
  ]);
  // Its links open the iteration the review was of.
  assert.equal(byClass(fix, 'finding')[0]!.querySelector('.pathlink')!.dataset.cit, '1');
  assert.deepEqual([byClass(entryOf(page, '11'), 'block')[0]!.className, parts('11')[2]], ['block you', 'Mind this.']);
  assert.match(parts('12')[2]!, /^Simplification pass · iteration 2 1 suggestion, saves about 3 lines#1src\/guard\.tsThe second guard\.Why: The first one covers it\.saves about 3 lines$/);
  assert.equal(parts('13')[2], 'Continue where you stopped.');
  assert.equal(parts('14')[2], 'MR preparation started MR preparation for T-1 on main. prompt');
  // Nothing on the page is an inline style.
  assert.ok(page.$('stream').all().every((element) => element.getAttribute('style') === null));
});

test('stream client (SF-065): a prompt sent with images shows their names as one muted line under it; a prompt without images shows none', async () => {
  const entries: Entry[] = [
    state('0', null, 'starting'), state('1', 'starting', 'working'),
    { ...IMPLEMENT, images: ['1.png', 'form.gif'] },
    { k: '3', ts: at(3), it: 1, who: 'you', t: 'user', text: 'Look again.', task_changed: true, images: ['1.png'] },
    { k: '4', ts: at(4), it: 1, who: 'factory', t: 'prompt', kind: 'continue', text: 'Continue where you stopped.', first: 'Continue where you stopped.', task_changed: false },
  ];
  const page = await withEntries(job('working', { iteration: 1 }), detail(job('working', { iteration: 1 })), entries);
  const images = (k: string): string[] => entryOf(page, k).all().filter((element) => element.className === 'muted fs12' && element.textContent.startsWith('Images:')).map((element) => element.textContent);
  assert.deepEqual(images('2'), ['Images: 1.png, form.gif']);
  assert.deepEqual(images('3'), ['Images: 1.png']);
  assert.deepEqual(images('4'), []);
});

test('stream client: the pages are read from line 0 until the end, then the live stream from the last next; a tool_result joins its tool by id in the same page, the next page and live', async () => {
  const pages = {
    0: { entries: [tool('0.0', 'a', 'Read a.ts'), result('0.1', 'a', '3 lines'), tool('1', 'b', 'Bash make')], next: 2, end: false },
    2: { entries: [result('2', 'b', 'failed: exit 2', true), tool('3', 'c', 'Grep x'), result('4', 'nobody', '1 line')], next: 5, end: true },
  };
  const page = await openJob(job('working'), detail(job('working')), pages);
  assert.deepEqual(page.requests.filter((request) => request.path.includes('/stream?')).map((request) => request.path), ['api/jobs/app/T-1/stream?from=0', 'api/jobs/app/T-1/stream?from=2']);
  assert.equal(page.streams.at(-1)!.url, 'api/stream?job=app%2FT-1&from=5');
  // No entry of its own for a result; a result without its tool is dropped.
  assert.deepEqual(nodes(page).map((node) => node.dataset.k), ['0.0', '1', '3']);
  const out = (k: string): FakeElement | null => entryOf(page, k).querySelector('.out');
  assert.deepEqual([out('0.0')!.textContent, out('0.0')!.className], ['→ 3 lines', 'out']);
  assert.deepEqual([out('1')!.textContent, out('1')!.className, entryOf(page, '1').className], ['→ failed: exit 2', 'out bad', 'e e-tool who-implementer err']);
  assert.equal(out('3'), null);
  // Live: a result for a tool of the pages draws that one entry again; new entries append.
  const live = page.streams.at(-1)!;
  const before = entryOf(page, '0.0');
  live.emit('entries', { line: 5, entries: [result('5', 'c', '7 lines')] });
  assert.equal(out('3')!.textContent, '→ 7 lines');
  assert.equal(entryOf(page, '0.0'), before);
  live.emit('entries', { line: 6, entries: [tool('6.0', 'd', 'Edit b.ts'), result('6.1', 'd', '1 line')] });
  assert.deepEqual([nodes(page).map((node) => node.dataset.k), out('6.0')!.textContent], [['0.0', '1', '3', '6.0'], '→ 1 line']);
  // The expanded Output is the joined result.
  buttonIn(entryOf(page, '6.0'), 'Edit b.ts → 1 line').click();
  assert.deepEqual(byClass(entryOf(page, '6.0'), 'more')[0]!.children.map((child) => child.textContent), ['Input', '{\n  "command": "Edit b.ts"\n}', 'Output', 'output of d']);

  // A reconnect resumes at the next line to read; an entry already shown is ignored.
  live.emit('error');
  assert.equal(page.tick(3000), 1);
  const again = page.streams.at(-1)!;
  assert.equal(again.url, 'api/stream?job=app%2FT-1&from=7');
  again.emit('entries', { line: 6, entries: [tool('6.0', 'd', 'Edit b.ts')] });
  again.emit('entries', { line: 7, entries: [{ k: '7', ts: at(9), it: 1, who: 'implementer', t: 'text', text: 'Done.' }] });
  assert.deepEqual(nodes(page).map((node) => node.dataset.k), ['0.0', '1', '3', '6.0', '7']);
  again.emit('error');
  page.tick(3000);
  assert.equal(page.streams.at(-1)!.url, 'api/stream?job=app%2FT-1&from=8');
});

test('stream client: a page that cannot be read leaves the rest to the live stream; the view follows new entries only when it was at the bottom', async () => {
  const page = await openJob(job('working'), detail(job('working')), {}, (path) => (path.includes('/stream?') ? { not: 'a page' } : undefined));
  // A page without next: the live stream from line 0, every line from there.
  assert.equal(page.streams.at(-1)!.url, 'api/stream?job=app%2FT-1&from=0');
  const wrap = page.$('streamwrap');
  Object.assign(wrap, { scrollHeight: 1000, clientHeight: 100, scrollTop: 900 });
  page.streams.at(-1)!.emit('entries', { line: 0, entries: [state('0', null, 'starting')] });
  assert.equal(wrap.scrollTop, 1000);
  wrap.scrollTop = 200;
  page.streams.at(-1)!.emit('entries', { line: 1, entries: [state('1', 'starting', 'working')] });
  assert.equal(wrap.scrollTop, 200);
  assert.deepEqual(nodes(page).map((node) => node.dataset.k), ['0', '1']);
});

test('stream client: j and k select an entry, G the last; Enter and a click toggle a tool line; a long text is clamped at 8 lines with Show all', async () => {
  const long = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
  const entries = [state('0', null, 'starting'), tool('1', 't', 'Bash ls'), result('2', 't', '2 lines'), { k: '3', ts: at(4), it: 1, who: 'implementer', t: 'text', text: long }];
  const page = await withEntries(job('working'), detail(job('working')), entries);
  page.key('j');
  assert.deepEqual(sel(page), ['0']);
  page.key('j');
  assert.deepEqual(sel(page), ['1']);
  assert.equal(entryOf(page, '1').scrolledIntoView, 1);
  // Enter toggles the selected entry: its Input and Output.
  page.key('Enter');
  assert.deepEqual([entryOf(page, '1').className, sel(page)], ['e e-tool who-implementer open sel', ['1']]);
  assert.deepEqual(byClass(entryOf(page, '1'), 'lbl').map((label) => label.textContent), ['Input', 'Output']);
  page.key('Enter');
  assert.deepEqual([entryOf(page, '1').className, byClass(entryOf(page, '1'), 'more').length], ['e e-tool who-implementer sel', 0]);
  // A click on the line toggles it as well.
  entryOf(page, '1').querySelector('button.line')!.click();
  assert.equal(byClass(entryOf(page, '1'), 'more').length, 1);
  entryOf(page, '1').querySelector('button.line')!.click();
  assert.equal(byClass(entryOf(page, '1'), 'more').length, 0);
  page.key('G');
  assert.deepEqual(sel(page), ['3']);
  page.key('k');
  page.key('k');
  page.key('k');
  assert.deepEqual(sel(page), ['0']);
  // A click on an entry selects it.
  byClass(entryOf(page, '3'), 'prose')[0]!.click();
  assert.deepEqual(sel(page), ['3']);
  // Clamped: Show all 12 lines, then Show less.
  assert.equal(entryOf(page, '3').className, 'e e-text who-implementer clamp sel');
  buttonIn(entryOf(page, '3'), 'Show all 12 lines').click();
  assert.equal(entryOf(page, '3').className, 'e e-text who-implementer open sel');
  page.key('Enter');
  assert.ok(buttonIn(entryOf(page, '3'), 'Show all 12 lines') !== undefined);
  // A verdict's whole summary and a prompt's text behind their toggles.
  page.streams.at(-1)!.emit('entries', { line: 4, entries: [{ k: '4', ts: at(5), it: 1, who: 'codex', t: 'verdict', verdict: 'clean', effective: 'clean', summary: 'Fine.', items: [] }, { ...IMPLEMENT, k: '5' }] });
  assert.equal(byClass(entryOf(page, '4'), 'verdict')[0]!.className, 'verdict clean');
  buttonIn(entryOf(page, '4'), 'Show the whole summary').click();
  assert.deepEqual([byClass(entryOf(page, '4'), 'block')[0]!.className, buttonIn(entryOf(page, '4'), 'Show less') !== undefined], ['block', true]);
  buttonIn(entryOf(page, '5'), 'prompt').click();
  assert.deepEqual(byClass(entryOf(page, '5'), 'raw').map((pre) => pre.textContent), ['/implement .software-factory/T-1.md']);
});

test('stream client: a path link opens Changes at its file and iteration; Open these changes and c open Changes; a changes entry shows its Report', async () => {
  const shown = detail(job('awaiting_review', { iteration: 2 }), { iterations: [iteration(1), iteration(2)] });
  const listed = (paths: string[]) => ({ files: paths.map((path) => ({ path, status: 'modified', additions: 1, deletions: 1, binary: false, unavailable: false })), more: false });
  const lists: Record<string, unknown> = {
    'api/jobs/app/T-1/changes': { base: { ref: 'main', commit: 'b'.repeat(40) }, iterations: [1, 2].map((n) => ({ n, ended_at: at(n), truncated: false, base_commit: 'b'.repeat(40) })) },
    'api/jobs/app/T-1/changes?from=base&to=1': listed(['README.md', 'src/a.ts']),
    'api/jobs/app/T-1/changes?from=1&to=2': listed(['README.md']),
    'api/jobs/app/T-1/changes?from=base&to=2': listed(['README.md', 'src/a.ts']),
  };
  const get = (path: string): unknown => lists[path] ?? (path.includes('/file?') ? { kind: 'text', text: 'x\n' } : path.endsWith('/report') ? `# Report of ${path.split('/')[5]}` : undefined);
  const page = await withEntries(job('awaiting_review', { iteration: 2 }), shown, STREAM, get);
  // The Report of the changes entry, behind its toggle.
  buttonIn(entryOf(page, '6.1'), 'Report').click();
  await page.flush();
  assert.equal(byClass(entryOf(page, '6.1'), 'raw')[0]!.textContent, '# Report of 1\n');
  assert.ok(buttonIn(entryOf(page, '6.1'), 'Hide the Report') !== undefined);
  // The link of src/a.ts in the verdict of iteration 1: Iteration 1 at that file.
  byClass(entryOf(page, '7'), 'pathlink')[0]!.click();
  await page.flush();
  const shownFile = (): string => page.$('dtool').querySelector('.dpath')!.textContent;
  assert.deepEqual([page.$('scrChanges').hidden, page.$('scrStream').hidden, page.location.hash], [false, true, '#app/T-1/changes']);
  assert.deepEqual([page.$('cxview').value, shownFile()], ['1', 'src/a.ts']);
  assert.deepEqual(page.$('tlist').querySelectorAll('.trow.sel').map((row) => row.dataset.trow), ['f:src/a.ts']);
  // s back to the Stream; Open these changes: Changes at that iteration, its first file.
  page.key('s');
  buttonIn(entryOf(page, '6.1'), 'Open these changes c').click();
  await page.flush();
  assert.deepEqual([page.$('scrChanges').hidden, page.$('cxview').value, shownFile()], [false, '1', 'README.md']);
  // c from the Stream: All changes at the file shown last.
  page.key('s');
  page.key('c');
  await page.flush();
  assert.deepEqual([page.$('cxview').value, shownFile()], ['all', 'README.md']);
});

test("stream client: the implement prompt's Task toggle shows the Task text and the Task check result, read once", async () => {
  const task = '---\nticket: T-1\n---\n# T-1: Demo\n<script>alert(1)</script>\n';
  const check = {
    check: { output: { verdict: 'not_ready', paraphrase: 'It adds a greeting.', findings: [{ severity: 'blocker', kind: 'gap', where: '§Goal', problem: 'Vague.', expected: 'Precise.' }], files: [] }, ended_at: '2026-11-01T09:00:00.000Z', model: null, error: null },
    stale: false, running: false,
  };
  const get = (path: string): unknown => (path === 'api/tickets/app/T-1/task' ? task : path === 'api/tickets/app/T-1/check' ? check : undefined);
  const page = await withEntries(job('working'), detail(job('working')), [IMPLEMENT], get);
  assert.equal(page.requests.filter((request) => request.path.startsWith('api/tickets/')).length, 0);
  buttonIn(entryOf(page, '2'), 'Task').click();
  await page.flush();
  const entry = entryOf(page, '2');
  assert.match(byClass(entry, 'task-check')[0]!.textContent, /^Task check: not ready: 1 blocker, 0 major · 2026-11-01 11:00:00 · default modelParaphraseIt adds a greeting\.Findingsblocker \(1\)gap §Goal: Vague\. Expected: Precise\.$/);
  const text = byClass(entry, 'doc')[0]!;
  assert.equal(text.textContent, `${task}\n`);
  assert.deepEqual(text.all().filter((node) => node.className === 'heading').map((node) => node.textContent), ['# T-1: Demo\n']);
  assert.ok(text.all().every((node) => node.tagName === 'SPAN'));
  buttonIn(entryOf(page, '2'), 'hide Task').click();
  buttonIn(entryOf(page, '2'), 'Task').click();
  await page.flush();
  assert.equal(page.requests.filter((request) => request.path === 'api/tickets/app/T-1/task').length, 1);
});

// For every needs_human code: the job, its detail, the stop block's label, the sentence, what it
// shows inline, and the composer's buttons in order.
// The messages of the test step's stops (SF-128), as src/execution/mr-steps.ts writes them.
const TESTS_FAILED_MESSAGE = "The workspace's tests still fail after 2 Tests Fix rounds: `npm test` (exit 1) on iteration 1. Accept the iteration without passing tests (sf accept), or tell the Implementer what to do (sf say).";
const TESTS_UNAVAILABLE_MESSAGE = "bwrap is not installed.\nThe workspace's test command `npm test` could not run on iteration 1. Fix it on this machine and run sf retry, or accept the iteration without tests (sf accept).";

const STOPS: Array<[string, Record<string, unknown>, Record<string, unknown>, 'Your decision' | 'Stopped', string, RegExp, string[]]> = [
  ['simplify_offered', { iteration: 1, stop: { items: [SUGGESTION], saves_lines: 3 } }, { iterations: [iteration(1, { review: CLEAN, simplify: SIMPLIFY })] }, 'Your decision',
    'The simplification pass suggests 1 change (saves about 3 lines). Simplify or skip.', /^#1src\/guard\.tsThe second guard\.Why: The first one covers it\.saves about 3 lines$/, ['Simplify', 'Skip', 'Send', 'Abort…']],
  ['escalated', { stop: { items: [{}], saves_lines: null } }, { ledger: [ledgerEntry('R1', 'escalated', { response: 'Which language?' }), ledgerEntry('R2', 'fixed')] }, 'Your decision',
    'The Implementer asks you about 1 finding. Answer each: Accept risk or Must fix.', /^R1majorREADME\.mdProblem of R1\.The Implementer asks: Which language\?Accept riskMust fix$/, ['Send', 'Abort…']],
  ['review_disputed', { stop: { items: [{}], saves_lines: null } }, {
    iterations: [iteration(1, { review: CLEAN, gate: GATE_FIX })],
    ledger: [ledgerEntry('R1', 'contested', { response: 'Done at README.md:1.', evidence: 'README.md:1', dispute: { reviewer: 'codex', iteration: 1, reason: 'Still wrong.' } })],
  }, 'Your decision', 'A reviewer reopened 1 finding the Implementer contested. Settle each: Accept risk or Must fix.',
  /^R1majorREADME\.mdProblem of R1\.The Implementer contests it: Done at README\.md:1\.Evidence: README\.md:1Codex reopens it: Still wrong\.Accept riskMust fix$/, ['Accept and prepare MR', 'Send', 'Abort…']],
  ['review_churn', { stop: { items: [{}], saves_lines: null } }, { iterations: [iteration(1, { review: CLEAN })], ledger: [ledgerEntry('R1', 'open'), ledgerEntry('R2', 'fixed')] }, 'Your decision',
    'The fixes keep making new findings (1 open). Accept the change as it is, or tell the Implementer what to fix.', /^R1majorREADME\.mdProblem of R1\.Expected: Better\.$/, ['Accept and prepare MR', 'Send', 'Abort…']],
  ['gate_rounds', { gate_fixes: 3, stop: { items: [{}], saves_lines: null } }, { iterations: [iteration(1, { review: CLEAN, gate: GATE_FIX })] }, 'Your decision',
    'Codex asked for fixes 3 times, the limit. Accept the change without its 1 open finding, or tell the Implementer what to fix.', /^#1majorREADME\.mdIt greets the world\.Expected: It greets the reader\.$/,
    ['Accept and prepare MR', 'Send', 'Abort…']],
  ['gate_budget', { gate_tokens: 1200345, stop: { items: [], saves_lines: null } }, { iterations: [iteration(1, { review: CLAUDE_FIX })] }, 'Your decision',
    "The Codex gate used its token budget for this job. Accept the change with Claude's clean review, or tell the Implementer what to do.", /^The Codex gate used 1,200,345 tokens\.$/, ['Send', 'Abort…']],
  // SF-131: Accept at the Fix round limit whatever the last verdict; the stop's items (the ledger's
  // open blocker and major entries) when the payload has them.
  ['iteration_limit', { fixes: 5 }, { iterations: [iteration(1, { review: CLAUDE_FIX, gate: GATE_FIX })] }, 'Your decision',
    'The reviewers asked for fixes 5 times, the limit. Accept the change with its open findings listed in the MR text, give the Implementer a direction, or abort.', /^#1majorREADME\.md.*#2nita\.txtEmpty\.Expected: A line\.#3majorREADME\.md/, ['Accept and prepare MR', 'Send', 'Restart…', 'Abort…']],
  ['iteration_limit', { fixes: 5 }, { iterations: [iteration(1, { review: CLEAN, gate: GATE_FIX })] }, 'Your decision',
    'The reviewers asked for fixes 5 times, the limit. Accept the change with its open findings listed in the MR text, give the Implementer a direction, or abort.', /^#1majorREADME\.mdIt greets the world\.Expected: It greets the reader\.$/, ['Accept and prepare MR', 'Send', 'Restart…', 'Abort…']],
  ['iteration_limit', { fixes: 3, stop: { items: [ledgerEntry('R4', 'open')], saves_lines: null } }, { iterations: [iteration(1, { review: CLAUDE_FIX })], ledger: [ledgerEntry('R4', 'open')] }, 'Your decision',
    'The reviewers asked for fixes 3 times, the limit. Accept the change with its open findings listed in the MR text, give the Implementer a direction, or abort.', /^R4majorREADME\.mdProblem of R4\.Expected: Better\.$/, ['Accept and prepare MR', 'Send', 'Restart…', 'Abort…']],
  // Without the Claude review (SF-131): Accept over the gate's stop with no review at all.
  ['gate_budget', { claude_review: false, gate_tokens: 1200345, stop: { items: [], saves_lines: null } }, { iterations: [iteration(1, {})] }, 'Your decision',
    'The Codex gate used its token budget for this job. Accept the change, which no reviewer passed, or tell the Implementer what to do.', /^The Codex gate used 1,200,345 tokens\.$/, ['Accept and prepare MR', 'Send', 'Abort…']],
  ['max_turns', {}, {}, 'Your decision', 'The Implementer used all its turns on iteration 2. Tell it to go on.', /^$/, ['Tell it to go on', 'Abort…']],
  ['gate_failed', {}, { iterations: [iteration(1, { review: CLEAN, gate: GATE_FAILED })] }, 'Stopped',
    "The Codex gate stopped without a verdict. Accept with Claude's clean review, or tell the Implementer to go on.", /^Codex wrote no output\.$/, ['Accept and prepare MR', 'Tell it to go on', 'Abort…']],
  ['review_failed', {}, { iterations: [iteration(1, { review: { reviewer: 'claude', error: 'Overloaded.', ...times } })] }, 'Stopped',
    'The Claude review of iteration 1 could not run. Retry it.', /^Overloaded\.$/, ['Retry review', 'Abort…']],
  ['serve_restarted', {}, {}, 'Stopped', 'sf serve restarted while iteration 2 ran. Tell the Implementer to go on.', /^$/, ['Tell it to go on', 'Restart…', 'Abort…']],
  ['mr_serve_restarted', {}, {}, 'Stopped', 'The MR preparation was interrupted. Retry prepares the MR again without a new review; Tell it to go on reviews the iteration again.', /^$/, ['Retry', 'Tell it to go on', 'Abort…']],
  ['mr_interrupted', {}, {}, 'Stopped', 'The MR preparation was interrupted. Retry prepares the MR again without a new review; Tell it to go on reviews the iteration again.', /^$/, ['Retry', 'Tell it to go on', 'Abort…']],
  ['mr_serve_restarted', { mr_conflict_turn: true }, {}, 'Stopped', 'The MR preparation was interrupted. Tell the Implementer to go on: the iteration is reviewed again and the MR is prepared again.', /^$/, ['Tell it to go on', 'Abort…']],
  ['session_failed', { message: "You've hit your limit · resets 3am (Europe/Sofia)" }, {}, 'Stopped',
    'The Claude usage limit was reached; it resets at 3am (Europe/Sofia). Tell the Implementer to go on after that.', /^You've hit your limit · resets 3am \(Europe\/Sofia\)$/, ['Tell it to go on', 'Abort…']],
  ['session_failed', {}, {}, 'Stopped', "The Implementer's session failed: The first line. Tell it to go on, or restart.", /^The first line\.\nThe second line\.$/, ['Tell it to go on', 'Restart…', 'Abort…']],
  ['turn_failed', {}, {}, 'Stopped', "The Implementer's session failed: The first line. Tell it to go on, or restart.", /^The first line\.\nThe second line\.$/, ['Tell it to go on', 'Restart…', 'Abort…']],
  ['permission_mode_mismatch', {}, {}, 'Stopped', "The Implementer's session failed: The first line. Tell it to go on, or restart.", /^The first line\./, ['Tell it to go on', 'Restart…', 'Abort…']],
  ['sandbox_unavailable', {}, {}, 'Stopped', "The Implementer's sandbox could not start: The first line. Fix it on this machine, then tell it to go on.", /^The first line\.\nThe second line\.$/, ['Tell it to go on', 'Abort…']],
  ['publish_failed', {}, {}, 'Stopped', 'The factory could not publish the Report and Patch of iteration 2. Tell it to go on to try again.', /^$/, ['Tell it to go on', 'Abort…']],
  ['mr_conflict', { base: 'develop', message: 'The rebase had conflicts in a.ts, lib/b.ts; the Implementer left markers. The rebase was aborted.' }, {}, 'Stopped',
    'The rebase onto develop conflicts and the Implementer could not resolve it. Tell it how, or abort.', /^a\.tslib\/b\.ts$/, ['Tell it how', 'Abort…']],
  ['mr_text_missing', {}, {}, 'Stopped', "The Implementer's MR text is missing or breaks a rule: The first line. Tell it to write it again.", /^The first line\.\nThe second line\.$/, ['Send', 'Abort…']],
  ['mr_text_invalid', {}, {}, 'Stopped', "The Implementer's MR text is missing or breaks a rule: The first line. Tell it to write it again.", /^The first line\./, ['Send', 'Abort…']],
  ['mr_empty', {}, {}, 'Stopped', 'The reviewed change has nothing to commit against main. Tell the Implementer what is missing, or abort.', /^$/, ['Send', 'Abort…']],
  ['mr_commit_failed', {}, {}, 'Stopped', 'The MR preparation failed: The first line. Retry prepares the MR again without a new review; Tell it to go on reviews the iteration again.', /^The first line\./, ['Retry', 'Tell it to go on', 'Abort…']],
  ['mr_rebase_failed', {}, {}, 'Stopped', 'The MR preparation failed: The first line. Retry prepares the MR again without a new review; Tell it to go on reviews the iteration again.', /^The first line\./, ['Retry', 'Tell it to go on', 'Abort…']],
  ['mr_failed', {}, {}, 'Stopped', 'The MR preparation failed: The first line. Retry prepares the MR again without a new review; Tell it to go on reviews the iteration again.', /^The first line\./, ['Retry', 'Tell it to go on', 'Abort…']],
  ['mr_failed', { mr_conflict_turn: true }, {}, 'Stopped', 'The MR preparation failed: The first line. Tell the Implementer to go on (the iteration is reviewed again), or abort.', /^The first line\./, ['Tell it to go on', 'Abort…']],
  ['fetch_failed', {}, {}, 'Stopped', 'Git could not fetch main from origin after the clean review. Retry when the network is back.', /^The first line\./, ['Retry', 'Abort…']],
  ['worktree_remove_failed', { worktree: '/wt/T-1' }, {}, 'Stopped',
    'The branch is prepared, but its worktree could not be removed: The first line. Remove it by hand, then tell the Implementer to go on.', /^\/wt\/T-1$/, ['Tell it to go on', 'Abort…']],
  ['mr_push_failed', { prepared_commit: 'b'.repeat(40), worktree: null }, {}, 'Stopped', 'The push of T-1-demo failed: The first line. Fix the cause, then push again.', /^The first line\.\nThe second line\.$/, ['Push again', 'Abort…']],
  ['mr_push_protected', {}, {}, 'Stopped', 'The factory never pushes to T-1-demo. Rename the branch on the Merge request screen, or abort.', /^$/, ['Abort…']],
  ['tests_failed', { message: TESTS_FAILED_MESSAGE }, { iterations: [iteration(1, { review: CLEAN })] }, 'Your decision',
    "The workspace's tests still fail after the Tests Fix rounds (exit 1). Accept the change without passing tests, or tell the Implementer what to do.", /^The workspace's tests still fail/, ['Accept and prepare MR', 'Send', 'Abort…']],
  ['tests_failed', { message: TESTS_FAILED_MESSAGE.replace('(exit 1)', '(timed out after 30 min)') }, { iterations: [iteration(1, { review: CLAUDE_FIX })] }, 'Your decision',
    "The workspace's tests still fail after the Tests Fix rounds (timed out after 30 min). Accept the change without passing tests, or tell the Implementer what to do.", /^The workspace's tests still fail/, ['Send', 'Abort…']],
  ['tests_unavailable', { message: TESTS_UNAVAILABLE_MESSAGE }, { iterations: [iteration(1, { review: CLEAN })] }, 'Stopped',
    "The workspace's tests could not run: bwrap is not installed. Fix it on this machine and Retry, or accept without tests.", /^bwrap is not installed\.\nThe workspace's test command/, ['Retry', 'Accept and prepare MR', 'Send', 'Abort…']],
  ['tests_unavailable', { message: TESTS_UNAVAILABLE_MESSAGE, mr_conflict_turn: true }, {}, 'Stopped',
    "The workspace's tests could not run: bwrap is not installed. Fix it on this machine and Retry, or accept without tests.", /^bwrap is not installed\./, ['Send', 'Abort…']],
  ['odd_code', {}, {}, 'Stopped', 'The job stopped: The first line. Tell the Implementer what to do, or abort.', /^The first line\.\nThe second line\.$/, ['Send', 'Abort…']],
];

function stopped(code: string, extra: Record<string, unknown>): Row {
  const { message, ...rest } = extra;
  return job('needs_human', { error: { code, message: typeof message === 'string' ? message : 'The first line.\nThe second line.' }, ...rest });
}

test('stream client: the stop block of every needs_human code: its label (a decision never as an error), the reason and the code, the sentence, what it shows inline and the composer\'s buttons', async () => {
  for (const [code, jobExtra, detailExtra, label, sentence, inline, buttons] of STOPS) {
    const row = stopped(code, jobExtra);
    const entries = [state('0', 'working', 'needs_human', 'serve_restarted', 'An earlier stop.'), state('1', 'starting', 'working'), state('2', 'working', 'needs_human', code, 'x', 9)];
    const page = await withEntries(row, detail(row, detailExtra), entries);
    const block = page.$('stopblock');
    const name = `${code} ${JSON.stringify(jobExtra.message ?? '')}`;
    assert.equal(block.parentNode!.parentNode, entryOf(page, '2'), name);
    assert.equal(block.className, 'block stop', name);
    const pill = byClass(block, 'verdict')[0]!;
    assert.deepEqual([pill.textContent, pill.className], [label, label === 'Your decision' ? 'verdict fix' : 'verdict stop'], name);
    assert.equal((block.children[0] as FakeElement).children.at(-1)!.textContent, code, name);
    assert.equal((block.children[1] as FakeElement).textContent, sentence, name);
    assert.match((block.children as FakeElement[]).slice(2).map((child) => child.textContent).join(''), inline, name);
    assert.deepEqual(labels(page), buttons, name);
    assert.equal(acts(page)[0]!.className, buttons[0] === 'Abort…' ? 'btn danger' : 'btn primary', name);
    assert.equal(act(page, 'Abort…').className, 'btn danger', name);
    // The composer says the sentence too; the header the code beside the title.
    assert.equal(page.$('composer-sentence').children[0]!.textContent, sentence, name);
    // An earlier stop is a plain stop block with its message, never the live one.
    assert.deepEqual([byClass(entryOf(page, '0'), 'stop')[0]!.textContent, entryOf(page, '0').querySelector('#stopblock')], ['StoppedInterrupted by a restartserve_restartedAn earlier stop.', null], name);
    // A decision shows no error anywhere on the page.
    if (label === 'Your decision') {
      assert.equal(page.$('stream').all().filter((element) => element.classList.contains('verdict') && element.classList.contains('stop')).length, 1, name);
      assert.ok(page.$('list-you').all().every((element) => !element.classList.contains('err')), name);
    }
  }
});

test('stream client (SF-128): a test run is one entry, running and then its result joined by run, its output behind the toggle; an Accept shows on its own; the Accept confirmation names the command', async () => {
  const run = at(20);
  const started: Entry = { k: '0', ts: at(20), it: 1, who: 'factory', t: 'tests', run, command: 'npm test' };
  const ended: Entry = { k: '1', ts: at(22), it: 1, who: 'factory', t: 'tests_result', run, command: 'npm test', outcome: 'failed', exit_code: 1, timed_out: false, ms: 120000, reason: null, tail: 'not ok 2', tail_truncated: true };
  const row = stopped('tests_failed', { message: TESTS_FAILED_MESSAGE });
  const page = await withEntries(row, detail(row, { iterations: [iteration(1, { review: CLEAN })] }), [started]);
  const line = (k: string): string => entryOf(page, k).querySelector('.line')!.textContent;
  assert.deepEqual([line('0'), entryOf(page, '0').className], ['Tests running', 'e e-tests who-factory']);
  assert.equal(byClass(entryOf(page, '0'), 'mono')[0]!.textContent, 'npm test');
  const live = page.streams.at(-1)!;
  live.emit('entries', { line: 1, entries: [ended] });
  assert.deepEqual([nodes(page).map((node) => node.dataset.k), line('0')], [['0'], 'Tests failed (exit 1) after 2 min']);
  assert.equal(byClass(entryOf(page, '0'), 'more').length, 0);
  entryOf(page, '0').querySelector('button.line')!.click();
  assert.deepEqual(byClass(entryOf(page, '0'), 'more')[0]!.children.map((child) => child.textContent), ['Output, its last lines', 'not ok 2']);
  // Other outcomes, and a result without its run (the Accept) as an entry of its own.
  live.emit('entries', { line: 2, entries: [
    { ...ended, k: '2', run: at(30), outcome: 'accepted_failing', tail: '' },
    { ...ended, k: '3', run: at(31), outcome: 'unavailable', exit_code: 127, reason: 'the command was not found (exit 127)', tail: '' },
    { ...ended, k: '4', run: at(32), outcome: 'passed', exit_code: 0, ms: 12_000, tail: '' },
    { ...ended, k: '5', run: at(33), outcome: 'failed', exit_code: null, timed_out: true, ms: 1_800_000, tail: '' },
  ] });
  assert.deepEqual(['2', '3', '4', '5'].map(line), [
    'Tests accepted by you without passing (exit 1)', 'Tests could not run (the command was not found (exit 127))', 'Tests passed after 12 s', 'Tests timed out after 30 min',
  ]);
  act(page, 'Accept and prepare MR').click();
  assert.equal(page.$('confirm-text').textContent, 'Accepts iteration 1 without passing tests (`npm test`); the MR text records it under ### Checks.');
  assert.equal(page.$('confirm-ok').textContent, 'Accept and prepare the MR');
});

test('stream client: the stop moves with the job: it is live only while the job waits and on its last needs_human entry; settled entries show their decision', async () => {
  const row = stopped('escalated', { stop: { items: [{}, {}], saves_lines: null } });
  const ledger = [ledgerEntry('R1', 'escalated', { response: 'Which language?' }), ledgerEntry('R2', 'escalated', { response: 'Which file?' })];
  const page = await withEntries(row, detail(row, { ledger }), [state('2', 'working', 'needs_human', 'escalated', 'x', 9)]);
  // Settle: posted at once with its note, per entry.
  const finding = (id: string): FakeElement => page.$('stopblock').all().find((element) => element.dataset.id === id)!;
  const note = finding('R2').querySelector('input')!;
  assert.deepEqual([note.getAttribute('aria-label'), note.getAttribute('placeholder') ?? (note as unknown as { placeholder: string }).placeholder], ['Note on R2', 'Note (optional)']);
  note.value = 'English only.';
  note.dispatch('input');
  buttonIn(finding('R2'), 'Must fix').click();
  await page.flush();
  assert.deepEqual(sent(page), [['settle', { id: 'R2', decision: 'fix', note: 'English only.' }]]);
  // While it is out, the buttons wait with the reason.
  assert.deepEqual([buttonIn(finding('R1'), 'Accept risk').disabled, buttonIn(finding('R1'), 'Accept risk').getAttribute('title')], [true, 'a settlement was requested; waiting for its outcome.']);
  posts(page)[0]!.respond(200, { ok: true, result: { state: 'needs_human', id: 'R2', status: 'user_fix', waiting: ['R1'] } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'Settled R2: to be fixed. Still to settle: R1.');
  assert.deepEqual([page.$('toast').hidden, page.$('toast-text').textContent], [false, 'Settled']);
  // The settled entry shows its decision, no buttons.
  const settled = [ledger[0]!, { ...ledger[1]!, status: 'user_fix', response: 'English only.', settled: { decision: 'fix', note: 'English only.', at: '2026-11-01T10:20:00.000Z' } }];
  await update(page, row, detail(row, { ledger: settled }));
  assert.equal(byClass(finding('R2'), 'decide')[0]!.textContent, 'Must fixEnglish only.');
  assert.equal(finding('R2').querySelector('input'), null);
  buttonIn(finding('R1'), 'Accept risk').click();
  await page.flush();
  assert.deepEqual(sent(page)[1], ['settle', { id: 'R1', decision: 'accept', note: '' }]);
  // A note typed survives a job event that changes nothing of the stop.
  await update(page, row, detail(row, { ledger: settled }));
  // The job goes on: the stop is no longer live.
  const working = job('working', { iteration: 1 });
  await update(page, working);
  assert.equal(page.document.getElementById('stopblock'), null);
  assert.equal(byClass(entryOf(page, '2'), 'verdict')[0]!.textContent, 'Your decision');
  // A later stop is the live one; the earlier stays plain.
  page.streams.at(-1)!.emit('entries', { line: 3, entries: [state('3', 'working', 'needs_human', 'max_turns', 'Turns.', 20)] });
  await update(page, stopped('max_turns', {}));
  assert.equal(page.$('stopblock').parentNode!.parentNode, entryOf(page, '3'));
  assert.equal(entryOf(page, '2').querySelector('#stopblock'), null);
});

test('stream client: the composer per state: its sentence, its message box and its actions, primary first; a disabled action has its reason as title', async () => {
  const mr = (state: string) => ({ number: 7, url: 'https://github.com/o/r/pull/7', state });
  const cases: Array<[Row, string[], 'shown' | 'hidden' | 'disabled', string]> = [
    [job('starting', { iteration: 0 }), ['Send', 'Pause', 'Abort…'], 'disabled', 'The worktree is being created and the Implementer starts.'],
    [job('working'), ['Send', 'Pause', 'Abort…'], 'shown', 'The Implementer is working on iteration 2.'],
    [job('awaiting_review'), ['Send', 'Pause', 'Abort…'], 'shown', 'Claude and Codex are reviewing iteration 1.'],
    [job('preparing_mr'), ['Abort…'], 'disabled', 'Writing the MR text.'],
    [job('paused', { paused: { from: 'working', step: 'turn', at: at(5) }, task_changed: true }), ['Resume', 'Restart…', 'Abort…'], 'shown',
      'Paused by you during iteration 2. Resume continues the same session (with your message, if you write one below); Restart starts the ticket again from its current Task file.'],
    [job('paused', { paused: { from: 'awaiting_review', step: 'review', at: at(5) } }), ['Resume', 'Restart…', 'Abort…'], 'disabled',
      'Paused by you during iteration 1. Resume runs it again; Restart starts the ticket again from its current Task file.'],
    [job('ready_for_human_review'), ['Review the MR and push', 'Approve…', 'Hand over to my checkout', 'Create merge request', 'Send', 'Abort…'], 'shown', 'Reviews are clean and the MR text is written. Push when you are happy.'],
    [job('pushed'), ['Create merge request', 'Archive'], 'hidden', 'Pushed at 12:05.'],
    [job('pushed', { mr: mr('closed') }), ['Create merge request', 'Refresh MR status', 'Archive'], 'hidden', 'Pushed at 12:05.'],
    [job('pushed', { mr: mr('open') }), ['Merge…', 'Refresh MR status', 'Archive'], 'hidden', 'Pushed at 12:05.'],
    [job('pushed', { mr: mr('merged') }), ['Refresh MR status', 'Archive'], 'hidden', 'Pushed at 12:05.'],
    [job('aborted'), ['Restart…', 'Archive'], 'hidden', 'Aborted by you. The branch stays.'],
    [job('failed', { error: { code: 'start_failed', message: 'Git failed.' } }), ['Restart…', 'Archive'], 'hidden', 'Failed.'],
  ];
  const page = await openJob(job('working'));
  for (const [row, buttons, box, sentence] of cases) {
    await update(page, row);
    const name = `${row.state} ${JSON.stringify(row.mr)}`;
    assert.deepEqual(labels(page), buttons, name);
    assert.equal(page.$('composer-sentence').children[0]!.textContent, sentence, name);
    const msg = page.$('msg');
    assert.equal(box === 'hidden' ? msg.hidden : box === 'disabled' ? msg.disabled : !msg.hidden && !msg.disabled, true, name);
    // One primary, first; none on a finished job, nor when Abort is the only action.
    const primary = !['pushed', 'aborted', 'failed'].includes(row.state) && buttons[0] !== 'Abort…';
    assert.equal(acts(page).filter((node) => node.className.includes('primary')).length, primary ? 1 : 0, name);
    assert.equal(acts(page)[0]!.className, primary ? 'btn primary' : buttons[0] === 'Abort…' ? 'btn danger' : 'btn', name);
  }
  // SF-107: a handed-over job's actions are in its hand-over panel; the bar's row is empty and hidden.
  await update(page, job('handed_over', { prepared_commit: 'a'.repeat(40), worktree: null }));
  assert.equal(page.$('composer-sentence').children[0]!.textContent, 'In your checkout on T-1-demo.');
  assert.deepEqual([labels(page), page.$('composer').querySelector('.crow')!.hidden, page.$('msg').disabled], [[], true, false]);
  assert.deepEqual(page.$('handover-panel').querySelectorAll('button').map((node) => node.textContent),
    ['More ▾', 'Take it backYour checkout returns to how it was; the job stays ready.', 'Abort the job…', 'I opened the MR', 'Push and open the MR…', 'Ask for changes']);
  // The merge request line of a pushed job, a link to its https URL.
  await update(page, job('pushed', { mr: mr('open') }));
  assert.equal(page.$('mr-line').textContent, 'Merge request #7 (open): https://github.com/o/r/pull/7');
  assert.equal(page.$('mr-line').querySelector('a')!.href, 'https://github.com/o/r/pull/7');
  // The paused job's Task file notice.
  await update(page, cases[4]![0]);
  assert.equal(page.$('composer-sentence').children[1]!.textContent, 'Task file changed since the job started: Resume hands the change to the Implementer and the reviewers.');
  // Disabled actions say why in their title: Send without text; Pause of a starting job; Approve off.
  await update(page, job('working'));
  assert.deepEqual([act(page, 'Send').disabled, act(page, 'Send').getAttribute('title')], [true, 'write a message first.']);
  page.$('msg').value = 'Hi';
  page.$('msg').dispatch('input');
  assert.deepEqual([act(page, 'Send').disabled, act(page, 'Send').getAttribute('title')], [false, null]);
  await update(page, job('starting', { iteration: 0 }));
  assert.equal(act(page, 'Pause').getAttribute('title'), 'only while the Implementer works or the reviewers review.');
  assert.match(act(page, 'Send').getAttribute('title')!, /^messages need working, awaiting_review, needs_human, ready_for_human_review or handed_over; the job is starting\.$/);
  await update(page, job('pushed', { mr_host: { host: 'github', reason: 'SF_GITHUB_TOKEN is not set' } }));
  assert.deepEqual([act(page, 'Create merge request').disabled, act(page, 'Create merge request').getAttribute('title')], [true, 'SF_GITHUB_TOKEN is not set.']);
  // A jobs event draws the header and the actions again; the focus stays on its button.
  await update(page, job('working'));
  act(page, 'Pause').focus();
  page.streams.at(-1)!.emit('jobs', { jobs: [job('working')] });
  assert.equal(page.document.activeElement, act(page, 'Pause'));
  const changes = page.$('jhead').querySelectorAll('[data-goto="changes"]')[0]!;
  changes.focus();
  page.streams.at(-1)!.emit('jobs', { jobs: [job('working')] });
  assert.notEqual(page.$('jhead').querySelectorAll('[data-goto="changes"]')[0], changes);
  assert.equal(page.document.activeElement, page.$('jhead').querySelectorAll('[data-goto="changes"]')[0]);
});

test('stream client: each confirmation opens inline in the composer before it posts; Cancel posts nothing; Confirm posts its body once', async () => {
  const withMr = { mr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'open' } };
  const cases: Array<[Row, Record<string, unknown>, string, string, string, Array<[string, unknown]>, (page: Page) => void]> = [
    [job('working'), {}, 'Abort…', 'Abort app/T-1?', 'Abort, keep the worktree', [['abort', { discard: false }]], () => undefined],
    [job('working'), {}, 'Abort…', 'Abort app/T-1?', 'Abort and discard the branch', [['abort', { discard: true }]], (page) => {
      assert.equal(page.$('discard-label').hidden, false);
      page.$('discard').checked = true;
      page.$('discard').dispatch('change');
    }],
    [job('aborted'), {}, 'Restart…', 'Restart app/T-1?', 'Restart, keep the files', [['restart', { keep_files: true }]], (page) => {
      page.$('keep-files').checked = true;
      page.$('keep-files').dispatch('change');
    }],
    [job('ready_for_human_review'), {}, 'Approve…', 'Approve app/T-1?', 'Approve: push as it is', [['approve', { as_is: true }]], (page) => {
      page.$('as-is').checked = true;
      page.$('as-is').dispatch('change');
    }],
    [stopped('mr_push_failed', { prepared_commit: 'b'.repeat(40), worktree: null }), {}, 'Push again', 'Approve app/T-1?', 'Approve: push the branch', [['approve', {}]], () => undefined],
    [stopped('gate_rounds', {}), { iterations: [iteration(1, { review: CLEAN, gate: GATE_FIX })] }, 'Accept and prepare MR', 'Accept and prepare MR app/T-1?', 'Accept and prepare the MR', [['accept', {}]], (page) => {
      assert.equal(page.$('confirm-items-title').textContent, 'Codex items that will not be applied (1):');
    }],
    // SF-131: after a fix verdict of Claude's too; the ledger's open findings alone go unapplied.
    [stopped('iteration_limit', {}), {
      iterations: [iteration(1, { review: CLAUDE_FIX, gate: GATE_FIX })],
      // Neither a fix the user decided nor a disputed contest is an open entry (SF-131, rule 5).
      ledger: [ledgerEntry('R1', 'open'), ledgerEntry('R2', 'fixed'), ledgerEntry('R3', 'user_fix'), ledgerEntry('R4', 'contested', { dispute: { reviewer: 'codex', iteration: 1, reason: 'Still wrong.' } })],
    }, 'Accept and prepare MR', 'Accept and prepare MR app/T-1?', 'Accept and prepare the MR', [['accept', {}]], (page) => {
      assert.match(page.$('confirm-text').textContent, /^Accepts iteration \d+ at the Fix round limit with its open findings unapplied \(listed in the MR text\)\. The factory commits it/);
      assert.doesNotMatch(page.$('confirm-text').textContent, /Claude reviewed clean/);
      assert.equal(page.$('confirm-items-title').textContent, 'Open findings that will not be applied (1):');
    }],
    [stopped('gate_rounds', { claude_review: false }), { iterations: [iteration(1, { gate: GATE_FIX })] }, 'Accept and prepare MR', 'Accept and prepare MR app/T-1?', 'Accept and prepare the MR', [['accept', {}]], (page) => {
      assert.match(page.$('confirm-text').textContent, /^Accepts iteration \d+, which only the Codex gate reviewed, over gate_rounds\. The factory commits it and rebases it onto main, and the branch comes back to you to approve\. The override is recorded in the job's history\.$/);
      assert.equal(page.$('confirm-items-title').textContent, 'Codex items that will not be applied (1):');
    }],
    [stopped('simplify_offered', {}), { iterations: [iteration(1, { review: CLEAN, simplify: SIMPLIFY })] }, 'Skip', 'Accept and prepare MR app/T-1?', 'Skip and prepare the MR', [['accept', {}]], (page) => {
      assert.match(page.$('confirm-text').textContent, /^Skips the simplification/);
      assert.equal(page.$('confirm-items-list').textContent, 'src/guard.ts: The second guard. Why: The first one covers it. (about 3 lines)');
    }],
    [stopped('simplify_offered', {}), { iterations: [iteration(1, { review: CLEAN, simplify: SIMPLIFY })] }, 'Simplify', 'Simplify app/T-1?', 'Simplify', [['simplify', {}]], (page) => {
      assert.equal(page.$('confirm-items-title').textContent, 'Suggestions of the simplification pass (1):');
    }],
    [job('ready_for_human_review'), { mr_title: 'feat(T-1): Demo' }, 'Create merge request', 'Create merge request app/T-1?', 'Create the merge request', [['mr-create', {}]], (page) => {
      assert.match(page.$('confirm-text').textContent, /^Pushes branch T-1-demo to origin as Approve does, then opens a merge request on GitHub from T-1-demo into main, titled “feat\(T-1\): Demo”/);
    }],
    [job('pushed', withMr), {}, 'Merge…', 'Merge app/T-1?', 'Merge #7 into main', [['mr-merge', {}]], () => undefined],
  ];
  for (const [row, extra, button, title, ok, posted, during] of cases) {
    const page = await openJob(row, detail(row, extra));
    act(page, button).click();
    const name = `${row.state} ${button}`;
    assert.deepEqual([page.$('confirm').hidden, page.$('confirm').className, page.$('confirm-title').textContent, posts(page).length], [false, 'confirm', title, 0], name);
    assert.equal(page.$('confirm').parentNode, page.$('composer'), name);
    // While it is open, the other actions wait.
    assert.ok(acts(page).every((node) => node.disabled), name);
    page.$('confirm-cancel').click();
    assert.deepEqual([page.$('confirm').hidden, posts(page).length], [true, 0], name);
    act(page, button).click();
    during(page);
    assert.equal(page.$('confirm-ok').textContent, ok, name);
    page.$('confirm-ok').click();
    await page.flush();
    assert.deepEqual([sent(page), page.$('confirm').hidden], [posted, true], name);
  }
});

test('stream client: Send, Tell it to go on ("Go on." for an empty box), Ctrl+Enter, Pause, Resume with the message, Retry review, Refresh MR status and Archive post at once', async () => {
  const page = await openJob(stopped('max_turns', {}));
  act(page, 'Tell it to go on').click();
  await page.flush();
  assert.deepEqual(sent(page), [['say', { message: 'Go on.' }]]);
  posts(page)[0]!.respond(200, { ok: true, result: { state: 'working', queued: false } });
  await page.flush();
  page.$('msg').value = 'Go on, then stop.';
  page.$('msg').dispatch('input');
  act(page, 'Tell it to go on').click();
  await page.flush();
  assert.deepEqual(sent(page)[1], ['say', { message: 'Go on, then stop.' }]);
  posts(page)[1]!.respond(200, { ok: true, result: { state: 'working', queued: false } });
  await page.flush();
  assert.equal(page.$('msg').value, '');

  // Ctrl+Enter in the message box sends; Enter alone does not.
  await update(page, job('working'));
  page.$('msg').value = 'Look at a.ts.';
  page.$('msg').dispatch('input');
  page.$('msg').focus();
  page.key('Enter');
  assert.equal(posts(page).length, 2);
  page.key('Enter', { ctrlKey: true });
  await page.flush();
  assert.deepEqual(sent(page)[2], ['say', { message: 'Look at a.ts.' }]);
  posts(page)[2]!.respond(200, { ok: true, result: { state: 'working', queued: true } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'Queued: the message runs after the current turn ends (state working); it has not run yet.');
  assert.equal(page.$('toast-text').textContent, 'Message sent');

  act(page, 'Pause').click();
  await page.flush();
  assert.deepEqual([sent(page)[3], page.$('confirm').hidden], [['pause', {}], true]);
  posts(page)[3]!.respond(200, { ok: true, result: { state: 'paused', step: 'turn', branch: 'T-1-demo' } });
  await page.flush();
  await update(page, job('paused', { paused: { from: 'working', step: 'turn', at: at(5) } }));
  page.$('msg').value = 'Mind the new line.';
  page.$('msg').dispatch('input');
  act(page, 'Resume').click();
  await page.flush();
  assert.deepEqual(sent(page)[4], ['resume', { message: 'Mind the new line.' }]);
  posts(page)[4]!.respond(200, { ok: true, result: { state: 'working', iteration: 1, step: 'turn' } });
  await page.flush();
  assert.equal(page.$('msg').value, '');

  await update(page, stopped('review_failed', {}));
  act(page, 'Retry review').click();
  await page.flush();
  assert.deepEqual(sent(page)[5], ['review', {}]);
  posts(page)[5]!.respond(409, { ok: false, error: { code: 'review_off', message: 'SF_REVIEW is off.' } });
  await page.flush();
  assert.deepEqual([page.$('action-status').textContent, page.$('action-status').className], ['review_off: SF_REVIEW is off.', 'status error']);

  await update(page, job('pushed', { mr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'open' } }));
  act(page, 'Refresh MR status').click();
  await page.flush();
  assert.deepEqual(sent(page)[6], ['mr-status', {}]);
  posts(page)[6]!.respond(200, { ok: true, result: { status: { number: 7, state: 'open', draft: false, mergeable: true, reason: null, checks: '2 passed' } } });
  await page.flush();
  assert.equal(page.$('mr-status-line').textContent, 'On the host: #7 open, mergeable, checks: 2 passed.');
  act(page, 'Archive').click();
  await page.flush();
  assert.deepEqual(sent(page)[7], ['archive', {}]);
});

test('stream client: Escape closes an open confirmation, then goes back to the board', async () => {
  const page = await openJob(job('working'));
  act(page, 'Abort…').click();
  assert.equal(page.$('confirm').hidden, false);
  page.key('Escape');
  assert.deepEqual([page.$('confirm').hidden, page.$('job').hidden], [true, false]);
  page.$('streamwrap').focus();
  page.key('Escape');
  assert.deepEqual([page.$('job').hidden, page.location.hash, posts(page).length], [true, '#', 0]);
});

test('stream client: an unknown outcome shows its warning; Refresh state shows only when the state read after it failed, and reads it again', async () => {
  const control = { held: false };
  const row = job('working');
  const page = await openJob(row, detail(row), {}, () => undefined, control);
  control.held = true;
  const reads = (): FetchRequest[] => page.requests.filter((request) => request.method === 'GET' && request.path === 'api/jobs/app/T-1');
  const before = reads().length;
  page.$('msg').value = 'Hi';
  page.$('msg').dispatch('input');
  act(page, 'Send').click();
  await page.flush();
  posts(page)[0]!.fail();
  await page.flush();
  // The read after it is out: the warning says so; Refresh state waits for it to fail.
  assert.equal(reads().length, before + 1);
  assert.match(page.$('action-doubt').textContent, /^The request failed \(Failed to fetch\)\. Its outcome is unknown: the state is being refreshed/);
  assert.equal(page.$('refresh-button').hidden, true);
  assert.deepEqual([act(page, 'Abort…').disabled, act(page, 'Abort…').getAttribute('title')], [true, "the last action's outcome is unknown; waiting for the current state."]);
  reads().at(-1)!.fail();
  await page.flush();
  assert.match(page.$('action-doubt').textContent, /and the current state could not be loaded \(Failed to fetch\)\. The controls stay off until it is: use Refresh state/);
  assert.equal(page.$('refresh-button').hidden, false);
  assert.equal(act(page, 'Pause').getAttribute('title'), "the last action's outcome is unknown and the current state could not be loaded.");
  // Refresh state reads it again; its answer lifts the hold, the warning stays.
  page.$('refresh-button').click();
  await page.flush();
  assert.equal(reads().length, before + 2);
  reads().at(-1)!.respond(200, detail(row));
  await page.flush();
  assert.equal(page.$('refresh-button').hidden, true);
  assert.match(page.$('action-doubt').textContent, /: it may have taken effect\. The state shown is current/);
  assert.deepEqual([act(page, 'Pause').disabled, posts(page).length], [false, 1]);
});

test('stream client (SF-072): the park on a usage limit and the resume from it show the factory\'s line with the change as a tag', async () => {
  const row = job('waiting_limit', { paused: { from: 'working', step: 'turn', at: at(1) }, limit: { provider: 'claude', resets_at: at(30) } });
  const page = await withEntries(row, detail(row), [
    { ...state('0', 'working', 'waiting_limit'), text: 'Parked: usage limit reached' },
    { ...state('1', 'waiting_limit', 'working', null, null, 31), text: 'Resumed after the usage limit reset' },
  ]);
  assert.deepEqual(nodes(page).map((node) => [node.dataset.k, node.querySelector('.body')!.textContent]), [
    ['0', 'Parked: usage limit reachedworking → waiting_limit'], ['1', 'Resumed after the usage limit resetwaiting_limit → working'],
  ]);
});
