// Behaviour of the job page's Changes screen in static/app.js (SF-079, the prototype's tree, diff
// pane and iteration selector), run under node:vm against the fake page of test/support/fake-dom.ts
// with the changes and file routes answered by the test: the tree's rows (folders compacted, M/A/D
// and their colours, the binary and unavailable tags, the counts), the summary, the filter, the
// flat list, the keys in the tree, F7 / Shift+F7 and n / p, the iteration selector and its notes,
// side-by-side and unified rows with the changed words, folding, the binary, too large and
// unavailable notes, the divider, a path link of the Stream (openChanges) and the empty states.
// Script checks, not browser acceptance: the manual steps are in factory/README.md.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
process.env.TZ = 'Europe/Sofia';

const BASE1 = 'a1'.repeat(20);
const BASE3 = 'c3'.repeat(20);

function job(state: string, extra: Record<string, unknown> = {}) {
  return {
    workspace: 'app', ticket: 'T-1', branch: 'T-1-demo', base: 'main', state, iteration: 3, mr_attempts: 0,
    updated_at: '2026-11-01T10:05:00.000Z', created_at: '2026-11-01T10:00:00.000Z', error: null, prepared_commit: null, worktree: '/wt/T-1',
    fixes: 2, gate_fixes: 0, gate_tokens: 0, files: 7, undeclared: 0, deleted: 1, title: 'Demo', mr: null, ...extra,
  };
}
type Row = ReturnType<typeof job>;
const iteration = (number: number) => ({ number, started_at: '2026-11-01T10:00:01.000Z', ended_at: '2026-11-01T10:05:00.000Z', cost_usd: 0.5, changed_files: 1, patch_truncated: false, denials: 0, files: [], review: null, gate: null, gate_override: null });
const detail = (row: Row) => ({ job: row, iterations: Array.from({ length: row.iteration }, (_, at) => iteration(at + 1)), mr: false, gate: true, history: [] });

const file = (path: string, status: string, additions: number, deletions: number, extra: Record<string, unknown> = {}) =>
  ({ path, status, additions, deletions, binary: false, unavailable: false, ...extra });
const INDEX = {
  base: { ref: 'main', commit: BASE3 },
  iterations: [{ n: 1, ended_at: 'x', truncated: false, base_commit: BASE1 }, { n: 2, ended_at: 'x', truncated: true, base_commit: BASE1 }, { n: 3, ended_at: 'x', truncated: false, base_commit: BASE3 }],
};
// All changes: sorted by path as the server sends them.
const ALL = [
  file('README.md', 'modified', 1, 1), file('big.txt', 'modified', 1, 1), file('docs/old.md', 'deleted', 0, 2), file('gone.txt', 'modified', 0, 0, { unavailable: true }),
  file('img/logo.png', 'modified', 0, 0, { binary: true }), file('src/app/main.ts', 'modified', 2, 1), file('src/app/util.ts', 'added', 3, 0),
];
const LISTS: Record<string, unknown> = {
  'base|3': { files: ALL, more: false },
  'base|1': { files: [file('README.md', 'modified', 1, 1), file('src/app/main.ts', 'modified', 1, 1)], more: false },
  '1|2': { files: [file('src/app/main.ts', 'modified', 1, 1)], more: false },
  '2|3': { files: [file('src/app/main.ts', 'modified', 1, 0), file('src/app/util.ts', 'added', 3, 0)], more: false },
};
const lines = (count: number, change: Record<number, string> = {}): string => Array.from({ length: count }, (_, at) => change[at + 1] ?? `line ${at + 1}`).join('\n') + '\n';
const text = (value: string) => ({ kind: 'text', text: value });
const SIDES: Record<string, unknown> = {
  'base:3|README.md': text('# Demo\nhello world\n'),
  '3|README.md': text('# Demo\nhello reader\n'),
  'base:3|src/app/main.ts': text(lines(20, { 10: 'const x = 1;' })),
  '3|src/app/main.ts': text(lines(21, { 10: 'const x = 2;', 21: 'extra' })),
  'base:3|src/app/util.ts': { kind: 'absent' },
  '3|src/app/util.ts': text('a\nb\nc\n'),
  'base:3|docs/old.md': text('old\ntext\n'),
  '3|docs/old.md': { kind: 'absent' },
  'base:3|img/logo.png': { kind: 'binary', bytes: 120 },
  '3|img/logo.png': { kind: 'binary', bytes: null },
  'base:3|big.txt': { kind: 'too_large', bytes: 2000000 },
  '3|big.txt': { kind: 'too_large', bytes: 2000001 },
  'base:3|gone.txt': text('gone\n'),
  '3|gone.txt': { kind: 'unavailable', reason: 'The Patch of iteration 3 was cut at 2 MB.' },
  'base:1|src/app/main.ts': text('one\n'),
  '1|src/app/main.ts': text('two\n'),
  '2|src/app/main.ts': text('two\nthree\n'),
};

// The routes as the server answers them; held: paths left pending (the test answers them).
function api(path: string, held: Set<string> = new Set()): unknown {
  if (held.has(path)) {
    return undefined;
  }
  if (path === 'api/jobs/app/T-1/changes') {
    return INDEX;
  }
  const list = /^api\/jobs\/app\/T-1\/changes\?from=(\w+)&to=(\d+)$/.exec(path);
  if (list !== null) {
    return LISTS[`${list[1]}|${list[2]}`];
  }
  const side = /^api\/jobs\/app\/T-1\/file\?at=(\w+)(?:&of=(\d+))?&path=(.*)$/.exec(path);
  if (side !== null) {
    return SIDES[`${side[1] === 'base' ? `base:${side[2]}` : side[1]}|${decodeURIComponent(side[3]!)}`] ?? text('');
  }
  return undefined;
}

// A localStorage as a browser's, over a map.
const storageOf = (map: Map<string, string>) => ({ getItem: (name: string) => map.get(name) ?? null, setItem: (name: string, value: string) => void map.set(name, String(value)) });

async function openChanges(row: Row = job('awaiting_review'), get: (path: string) => unknown = (path) => api(path), screen = '/changes', globals: Record<string, unknown> = {}): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs: [row] };
    }
    if (path === 'api/jobs/app/T-1') {
      return detail(row);
    }
    return get(path);
  }, undefined, globals);
  page.location.hash = `#app/T-1${screen}`;
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs: [row] });
  stream.emit('job', detail(row));
  await page.flush();
  return page;
}

const rows = (page: Page): FakeElement[] => page.$('tlist').querySelectorAll('.trow');
const rowTexts = (page: Page): string[] => rows(page).map((row) => row.textContent);
const rowOf = (page: Page, id: string): FakeElement => rows(page).find((row) => row.dataset.trow === id)!;
const selected = (page: Page): string[] => rows(page).filter((row) => row.classList.contains('sel')).map((row) => row.dataset.trow!);
const gets = (page: Page, prefix: string): FetchRequest[] => page.requests.filter((request) => request.method === 'GET' && request.path.startsWith(prefix));
const dpath = (page: Page): string => page.$('dtool').querySelector('.dpath')!.textContent;
const diffRows = (page: Page): FakeElement[] => page.$('dbody').querySelectorAll('.dfile .r');
const notes = (page: Page): string[] => page.$('dbody').querySelectorAll('.dnote').map((note) => note.textContent);
const empty = (page: Page): string => page.$('dbody').querySelector('.dempty')?.textContent ?? '';

test('changes client: the tree: folders compacted with their counts, M/A/D in their colours, the tags, the summary; the filter and the flat list', async () => {
  const page = await openChanges();
  assert.equal(page.$('scrChanges').hidden, false);
  // The screen as the prototype builds it: the tree, the divider, the diff pane.
  assert.deepEqual((page.$('scrChanges').children as FakeElement[]).map((child) => child.className), ['tree', 'vdiv', 'dpane']);
  assert.deepEqual([page.$('cxq').getAttribute('placeholder'), page.$('vdiv').getAttribute('role')], ['Filter files (/)', 'separator']);
  assert.deepEqual(rowTexts(page), [
    '▾▤docs1', 'Dold.md+0 −2', '▾▤img1', 'Mlogo.pngbinary+0 −0', '▾▤src/app2', 'Mmain.ts+2 −1', 'Autil.ts+3 −0', 'Mbig.txt+1 −1', 'Mgone.txtunavailable+0 −0', 'MREADME.md+1 −1',
  ]);
  assert.deepEqual(rows(page).map((row) => row.className.replace(' sel', '')), [
    'trow dir', 'trow vcs-deleted', 'trow dir', 'trow vcs-modified', 'trow dir', 'trow vcs-modified', 'trow vcs-added', 'trow vcs-modified', 'trow vcs-modified', 'trow vcs-modified',
  ]);
  assert.deepEqual(rows(page).map((row) => row.style.getPropertyValue('--d')), ['0', '1', '0', '1', '0', '1', '1', '0', '0', '0']);
  assert.deepEqual([rowOf(page, 'd:src/app').getAttribute('aria-expanded'), rowOf(page, 'f:docs/old.md').getAttribute('title')], ['true', 'docs/old.md (deleted)']);
  // The first file of the list is selected, its row the one in the tab order.
  assert.deepEqual(selected(page), ['f:README.md']);
  assert.deepEqual(rows(page).map((row) => row.getAttribute('tabindex')).filter((value) => value === '0').length, 1);
  assert.equal(page.document.activeElement, rowOf(page, 'f:README.md'));
  assert.equal(page.$('cxsum').textContent, '7 files: 5 modified, 1 added, 1 deleted · +7 −5');
  assert.deepEqual(page.$('cxsum').children.filter((child) => 'className' in child).map((child) => (child as FakeElement).className), ['', 'a', 'r']);

  // The filter: the tree follows, the summary counts the matches, the selection moves to the first match.
  page.$('cxq').value = 'APP/';
  page.$('cxq').dispatch('input');
  assert.deepEqual(rowTexts(page), ['▾▤src/app2', 'Mmain.ts+2 −1', 'Autil.ts+3 −0']);
  assert.equal(page.$('cxsum').textContent, '7 files: 5 modified, 1 added, 1 deleted · +7 −5 · 2 match');
  assert.equal(dpath(page), 'src/app/main.ts');
  page.$('cxq').value = 'nothing';
  page.$('cxq').dispatch('input');
  assert.deepEqual(page.$('tlist').querySelectorAll('.dempty').map((item) => item.textContent), ['No file matches the filter.']);
  assert.deepEqual([dpath(page), empty(page)], ['No file selected', 'Select a file on the left.']);
  page.$('cxq').value = '';
  page.$('cxq').dispatch('input');

  // The flat list: every file with its folder, in the list's order.
  const flat = page.$('scrChanges').querySelectorAll('[data-flat]');
  flat[1]!.click();
  assert.deepEqual(flat.map((button) => page.$('scrChanges').querySelectorAll('[data-flat]').find((b) => b.dataset.flat === button.dataset.flat)!.classList.contains('on')), [false, true]);
  assert.deepEqual(rowTexts(page), ['MREADME.md+1 −1', 'Mbig.txt+1 −1', 'Dold.mddocs+0 −2', 'Mgone.txtunavailable+0 −0', 'Mlogo.pngimgbinary+0 −0', 'Mmain.tssrc/app+2 −1', 'Autil.tssrc/app+3 −0']);
  page.$('scrChanges').querySelectorAll('[data-flat]')[0]!.click();
  assert.equal(rows(page).length, 10);
  // Every request is a read of the changes and file routes.
  assert.ok(page.requests.filter((request) => request.method !== 'GET').length === 0);
});

test('changes client: keys: Up and Down move, Left and Right close, open and go to the parent, Enter opens a folder or the diff; F7, Shift+F7, n and p; / the filter; s, m and Escape', async () => {
  const page = await openChanges();
  // Up from README.md: the files above, then a folder; Left on a file goes to its folder.
  page.key('ArrowUp');
  page.key('ArrowUp');
  assert.deepEqual([selected(page), dpath(page)], [['f:big.txt'], 'big.txt']);
  page.key('ArrowUp');
  assert.deepEqual(selected(page), ['f:src/app/util.ts']);
  page.key('ArrowLeft');
  assert.deepEqual([selected(page), dpath(page)], [['d:src/app'], 'src/app/util.ts']);
  // Left closes the folder, Right opens it, Right again goes into it.
  page.key('ArrowLeft');
  assert.deepEqual([rowOf(page, 'd:src/app').textContent, rows(page).length], ['▸▤src/app2', 8]);
  page.key('ArrowRight');
  assert.equal(rows(page).length, 10);
  page.key('ArrowRight');
  assert.deepEqual(selected(page), ['f:src/app/main.ts']);
  // Enter on a folder closes and opens it; Enter on a file shows its diff and moves the focus there.
  page.key('ArrowUp');
  page.key('Enter');
  assert.equal(rows(page).length, 8);
  page.key('Enter');
  page.key('ArrowDown');
  page.key('Enter');
  assert.deepEqual([dpath(page), page.document.activeElement], ['src/app/main.ts', page.$('dbody')]);
  // Arrows in the diff scroll it, they do not move the tree.
  page.key('ArrowDown');
  assert.deepEqual(selected(page), ['f:src/app/main.ts']);
  // A click on a row selects it; a click on the folder under the cursor closes it.
  rowOf(page, 'd:docs').click();
  assert.deepEqual([selected(page), rows(page).length], [['d:docs'], 10]);
  rowOf(page, 'd:docs').click();
  assert.equal(rows(page).length, 9);
  rowOf(page, 'f:big.txt').click();
  assert.equal(dpath(page), 'big.txt');

  // F7 and n: the next file in the list's order, the folders on the way opened; Shift+F7 and p back.
  page.key('F7');
  assert.deepEqual([dpath(page), rows(page).length, page.$('dtool').querySelector('.muted')!.textContent], ['docs/old.md', 10, '3/7 · deleted']);
  page.key('n');
  assert.equal(dpath(page), 'gone.txt');
  page.key('F7', { shiftKey: true });
  page.key('p');
  assert.equal(dpath(page), 'big.txt');
  page.key('p');
  page.key('p');
  assert.deepEqual([dpath(page), page.$('toast-text').textContent], ['README.md', 'First file']);
  page.$('toast-close').click();
  // The toolbar's buttons: ◀ off on the first file; ▶ steps.
  const [prev, next] = page.$('dtool').querySelectorAll('[data-fstep]');
  assert.deepEqual([prev!.disabled, next!.disabled, prev!.getAttribute('title'), next!.getAttribute('title')], [true, false, 'Previous file (Shift+F7 or p)', 'Next file (F7 or n)']);
  next!.click();
  assert.equal(dpath(page), 'big.txt');

  // / goes to the filter; Arrow Down there back to the selected row.
  page.$('dbody').focus();
  page.key('/');
  assert.equal(page.document.activeElement, page.$('cxq'));
  page.key('ArrowDown');
  assert.equal(page.document.activeElement, rowOf(page, 'f:big.txt'));
  // s the Stream, c back to Changes at the same file, Escape the Stream again.
  page.key('s');
  assert.deepEqual([page.$('scrChanges').hidden, page.location.hash], [true, '#app/T-1']);
  page.key('c');
  await page.flush();
  assert.deepEqual([page.$('scrChanges').hidden, dpath(page), page.location.hash], [false, 'big.txt', '#app/T-1/changes']);
  page.key('Escape');
  assert.deepEqual([page.$('scrChanges').hidden, page.$('scrStream').hidden], [true, false]);
});

test('changes client: side-by-side and unified rows with the changed words, Before and After, the fold and unfold, Collapse unchanged; the layout is kept', async () => {
  const stored = new Map<string, string>();
  const page = await openChanges(job('awaiting_review'), (path) => api(path), '/changes', { localStorage: storageOf(stored) });
  // README.md, side by side: Before (main), After (iteration 3); the changed word highlighted.
  assert.deepEqual(notes(page), ['Before (main)After (iteration 3)']);
  assert.deepEqual(page.$('dbody').querySelectorAll('.dnote span').length, 2);
  const [same, changed] = diffRows(page);
  assert.deepEqual(same!.children.map((cell) => [(cell as FakeElement).className, cell.textContent]), [['ln', '1'], ['c', '# Demo'], ['ln', '1'], ['c', '# Demo']]);
  assert.deepEqual(changed!.children.map((cell) => [(cell as FakeElement).className, cell.textContent]), [['ln', '2'], ['c del', 'hello world'], ['ln', '2'], ['c add', 'hello reader']]);
  assert.deepEqual(changed!.querySelectorAll('.w-del, .w-add').map((span) => [span.className, span.textContent]), [['w-del', 'world'], ['w-add', 'reader']]);
  assert.equal(gets(page, 'api/jobs/app/T-1/file?').map((request) => request.path).join(' '), 'api/jobs/app/T-1/file?at=base&of=3&path=README.md api/jobs/app/T-1/file?at=3&path=README.md');

  // main.ts: unchanged runs folded (none at the file's edges, 3 lines of context around the change).
  rowOf(page, 'f:src/app/main.ts').click();
  await page.flush();
  const folds = () => page.$('dbody').querySelectorAll('.fold');
  assert.deepEqual(folds().map((fold) => fold.textContent), ['⋯ 6 unchanged lines', '⋯ 4 unchanged lines']);
  assert.deepEqual(diffRows(page).map((row) => row.children[0]!.textContent), ['7', '8', '9', '10', '11', '12', '13', '18', '19', '20', '']);
  // The added last line: the left side void.
  assert.deepEqual(diffRows(page).at(-1)!.children.map((cell) => (cell as FakeElement).className), ['ln', 'c void', 'ln', 'c add']);
  folds()[0]!.click();
  assert.deepEqual([folds().length, diffRows(page).length], [1, 17]);
  // Collapse unchanged off: every line.
  const collapse = page.$('cxcollapse');
  collapse.checked = false;
  collapse.dispatch('change');
  assert.deepEqual([folds().length, diffRows(page).length], [0, 21]);
  collapse.checked = true;
  collapse.dispatch('change');

  // Unified: one column of rows, − and + with their line numbers, the words highlighted; no Before/After.
  page.$('dtool').querySelectorAll('[data-mode]')[1]!.click();
  assert.equal(page.$('dbody').querySelector('.dfile')!.className, 'dfile uni');
  const changedRows = diffRows(page).filter((row) => row.className !== 'r');
  assert.deepEqual(changedRows.map((row) => [row.className, ...row.children.map((cell) => cell.textContent)]), [
    ['r del', '10', '', '−', 'const x = 1;'], ['r add', '', '10', '+', 'const x = 2;'], ['r add', '', '21', '+', 'extra'],
  ]);
  assert.deepEqual(changedRows[0]!.querySelectorAll('.w-del').map((span) => span.textContent), ['1']);
  assert.deepEqual(notes(page), []);
  assert.deepEqual(page.$('dtool').querySelectorAll('[data-mode]').map((button) => button.classList.contains('on')), [false, true]);
  // The layout stays for another file, and is kept in localStorage for the next page load.
  rowOf(page, 'f:README.md').click();
  assert.equal(page.$('dbody').querySelector('.dfile')!.className, 'dfile uni');
  assert.deepEqual([...stored], [['sf-diff-mode', 'uni']]);
  const again = await openChanges(job('awaiting_review'), (path) => api(path), '/changes', { localStorage: storageOf(stored) });
  assert.equal(again.$('dbody').querySelector('.dfile')!.className, 'dfile uni');
  // A browser that refuses localStorage (it throws) keeps side by side.
  const refused = await openChanges(job('awaiting_review'), (path) => api(path), '/changes', { localStorage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } });
  assert.equal(refused.$('dbody').querySelector('.dfile')!.className, 'dfile');
  refused.$('dtool').querySelectorAll('[data-mode]')[1]!.click();
  assert.equal(refused.$('dbody').querySelector('.dfile')!.className, 'dfile uni');
});

test('changes client: new, deleted, binary, too large and unavailable files say so; a file still loading says Loading…', async () => {
  const held = new Set(['api/jobs/app/T-1/file?at=3&path=src%2Fapp%2Futil.ts']);
  const page = await openChanges(job('awaiting_review'), (path) => api(path, held));
  rowOf(page, 'f:src/app/util.ts').click();
  await page.flush();
  assert.deepEqual([notes(page), empty(page)], [['New file: all added.'], 'Loading…']);
  page.requests.find((request) => request.path === 'api/jobs/app/T-1/file?at=3&path=src%2Fapp%2Futil.ts')!.respond(200, text('a\nb\nc\n'));
  await page.flush();
  assert.deepEqual(diffRows(page).map((row) => row.children.map((cell) => (cell as FakeElement).className).join(',')), Array(3).fill('ln,c void,ln,c add'));
  rowOf(page, 'f:docs/old.md').click();
  await page.flush();
  assert.deepEqual([notes(page), diffRows(page).map((row) => row.children[1]!.textContent)], [['Deleted file: the old content, all removed.'], ['old', 'text']]);
  for (const [path, message] of [
    ['img/logo.png', 'Binary file: not shown.'], ['big.txt', 'Larger than 1 MiB: not shown.'], ['gone.txt', 'The Patch of iteration 3 was cut at 2 MB.'],
  ]) {
    rowOf(page, `f:${path}`).click();
    await page.flush();
    assert.deepEqual([empty(page), diffRows(page).length], [message, 0], path);
  }
  // A side the server refuses.
  const failing = await openChanges(job('awaiting_review'), (path) => (path.includes('file?') ? undefined : api(path)));
  failing.requests.filter((request) => request.path.includes('file?')).forEach((request) => request.respond(404, ''));
  await failing.flush();
  assert.match(empty(failing), /^Could not load the file: .*HTTP 404$/);
});

test('changes client: the iteration selector: All changes and each iteration with its Fix; Iteration N reads N − 1 against N; the base moved note', async () => {
  const page = await openChanges();
  const options = page.$('cxview').children.map((option) => [(option as FakeElement).value, option.textContent]);
  assert.deepEqual(options, [['all', 'All changes (final, after iteration 3)'], ['1', 'Iteration 1'], ['2', 'Iteration 2 (Fix 1)'], ['3', 'Iteration 3 (Fix 2)']]);
  assert.equal(page.$('cxview').value, 'all');
  const choose = async (value: string): Promise<void> => {
    page.$('cxview').value = value;
    page.$('cxview').dispatch('change');
    await page.flush();
  };
  await choose('1');
  assert.deepEqual([rowTexts(page), dpath(page), notes(page)], [['▾▤src/app1', 'Mmain.ts+1 −1', 'MREADME.md+1 −1'], 'README.md', ['Before (main)After (iteration 1)']]);
  assert.equal(gets(page, 'api/jobs/app/T-1/changes?from=base&to=1').length, 1);
  await choose('2');
  assert.deepEqual([dpath(page), notes(page)], ['src/app/main.ts', ['Before (iteration 1)After (iteration 2)']]);
  assert.deepEqual(diffRows(page).map((row) => row.textContent), ['1two1two', '2three']);
  assert.ok(gets(page, 'api/jobs/app/T-1/file?at=1&path=src%2Fapp%2Fmain.ts').length === 1);
  // Iteration 3 came after a rebase: its base moved, the note says so.
  await choose('3');
  assert.deepEqual(notes(page)[0], `The base moved from ${BASE1.slice(0, 12)} to ${BASE3.slice(0, 12)} before iteration 3: this view also shows those upstream changes.`);
  // Each list is read once.
  await choose('1');
  await choose('all');
  assert.deepEqual(['from=base&to=1', 'from=1&to=2', 'from=2&to=3', 'from=base&to=3'].map((query) => gets(page, `api/jobs/app/T-1/changes?${query}`).length), [1, 1, 1, 1]);
});

test('changes client: a path link opens its file at its iteration, or at All changes when the file did not change there; the folders on the way open', async () => {
  const entries = [
    { k: '1', ts: '2026-11-01T10:01:00.000Z', it: 2, who: 'factory', t: 'changes', files: 1, paths: ['src/app/main.ts'] },
    { k: '2', ts: '2026-11-01T10:02:00.000Z', it: 2, who: 'claude', t: 'verdict', verdict: 'fix', effective: 'fix', summary: 'x', items: [{ severity: 'major', path: 'README.md', problem: 'p', expected: 'e', id: 'R1' }] },
  ];
  const page = await openChanges(job('awaiting_review'), (path) => (path === 'api/jobs/app/T-1/stream?from=0' ? { entries, next: 2, end: true } : api(path)), '');
  const link = (k: string): FakeElement => page.$('stream').querySelectorAll('.pathlink').find((node) => node.closest('li.e')!.dataset.k === k)!;
  // src/app/main.ts changed in iteration 2: Iteration 2 at that file.
  link('1').click();
  await page.flush();
  assert.deepEqual([page.location.hash, page.$('cxview').value, dpath(page), selected(page)], ['#app/T-1/changes', '2', 'src/app/main.ts', ['f:src/app/main.ts']]);
  // README.md did not change in iteration 2: All changes at that file.
  page.key('s');
  link('2').click();
  await page.flush();
  assert.deepEqual([page.$('cxview').value, dpath(page)], ['all', 'README.md']);
  // A closed folder on the way opens.
  rowOf(page, 'd:src/app').click();
  rowOf(page, 'd:src/app').click();
  assert.equal(rowOf(page, 'd:src/app').getAttribute('aria-expanded'), 'false');
  page.key('s');
  link('1').click();
  await page.flush();
  assert.deepEqual([rowOf(page, 'd:src/app').getAttribute('aria-expanded'), dpath(page)], ['true', 'src/app/main.ts']);
  // Open these changes: that iteration, its first file.
  page.key('s');
  page.$('stream').querySelectorAll('button').find((node) => node.textContent === 'Open these changes c')!.click();
  await page.flush();
  assert.deepEqual([page.$('cxview').value, dpath(page)], ['2', 'src/app/main.ts']);
});

test('changes client: no iteration yet says when the changes come; the divider resizes the tree with the pointer and the keyboard', async () => {
  const waiting = await openChanges(job('working', { iteration: 0, files: 0 }), (path) => (path === 'api/jobs/app/T-1/changes' ? { base: { ref: 'main', commit: null }, iterations: [] } : api(path)));
  assert.deepEqual([waiting.$('scrChanges').textContent, waiting.$('scrChanges').children.map((child) => (child as FakeElement).className)], [
    'No iteration has ended yet. The changes appear here when the Implementer finishes iteration 1; until then its edits are in the stream.', ['dempty span'],
  ]);
  // The first iteration ends: the index is read again and the tree appears.
  const row = job('awaiting_review', { iteration: 1 });
  const reads = (): number => waiting.requests.filter((request) => request.path === 'api/jobs/app/T-1/changes').length;
  const before = reads();
  const stream = waiting.streams.at(-1)!;
  stream.emit('jobs', { jobs: [row] });
  stream.emit('job', detail(row));
  await waiting.flush();
  assert.equal(reads(), before + 1);

  const page = await openChanges();
  const html = page.document.documentElement;
  page.$('vdiv').focus();
  page.key('ArrowRight');
  assert.equal(html.style.getPropertyValue('--tree-w'), '352px');
  page.key('ArrowLeft');
  page.key('ArrowLeft');
  assert.equal(html.style.getPropertyValue('--tree-w'), '288px');
  // The arrows on the divider never move the tree.
  assert.deepEqual(selected(page), ['f:README.md']);
  Object.assign(page.$('scrChanges'), { getBoundingClientRect: () => ({ left: 100, width: 1200 }) });
  page.$('vdiv').dispatch('pointerdown', { pointerId: 1 });
  assert.ok(page.$('vdiv').classList.contains('drag'));
  page.$('vdiv').dispatch('pointermove', { clientX: 600 });
  assert.equal(html.style.getPropertyValue('--tree-w'), '500px');
  page.$('vdiv').dispatch('pointermove', { clientX: 120 });
  assert.equal(html.style.getPropertyValue('--tree-w'), '200px');
  page.$('vdiv').dispatch('pointerup');
  assert.equal(page.$('vdiv').classList.contains('drag'), false);
  // The width is kept: another screen and back.
  page.$('vdiv').blur();
  page.key('s');
  page.key('c');
  await page.flush();
  assert.equal(html.style.getPropertyValue('--tree-w'), '200px');
});

// A browser's querySelectorAll returns a NodeList, which has forEach but none of the other array
// methods; the fake DOM returns an array, so a call like .find on it passes here and throws there.
test('changes client: the script never calls an array-only method on a querySelectorAll result', async () => {
  const source = await readFile(new URL('app.js', STATIC_DIR), 'utf8');
  const calls = source.split('\n').map((line, at) => [at + 1, line] as const)
    .filter(([, line]) => /querySelectorAll\([^)]*\)\??\.(?!forEach\b|length\b)[A-Za-z]+\(/.test(line));
  assert.deepEqual(calls, []);
});

// SF-119: a matchMedia whose matches the test sets (narrow: below 768 px), and the change listeners
// the page added.
function mediaOf(narrow: boolean) {
  const screen = { narrow, listeners: [] as Array<() => void> };
  const matchMedia = (query: string) => ({
    get matches() { return screen.narrow; }, media: query,
    addEventListener: (name: string, listener: () => void) => { if (name === 'change') screen.listeners.push(listener); },
  });
  return { screen, matchMedia };
}
const cxtree = (page: Page): [string, string | null, boolean] => [page.$('cxtree').textContent, page.$('cxtree').getAttribute('aria-expanded'), page.$('scrChanges').querySelector('.tree')!.classList.contains('folded')];

test('changes client (SF-119): below 768 px the diff is unified with no layout switch and no Before / After, the stored side by side kept; a wider window draws side by side again', async () => {
  const stored = new Map<string, string>([['sf-diff-mode', 'side']]);
  const { screen, matchMedia } = mediaOf(true);
  const page = await openChanges(job('awaiting_review'), (path) => api(path), '/changes', { localStorage: storageOf(stored), matchMedia });
  assert.deepEqual([page.$('dbody').querySelector('.dfile')!.className, page.$('dtool').querySelectorAll('[data-mode]').length, notes(page)], ['dfile uni', 0, []]);
  rowOf(page, 'f:src/app/main.ts').click();
  await page.flush();
  assert.deepEqual([page.$('dbody').querySelector('.dfile')!.className, stored.get('sf-diff-mode')], ['dfile uni', 'side']);
  // The window grows past 767 px: the listener redraws the diff in the stored layout.
  screen.narrow = false;
  assert.equal(screen.listeners.length, 1);
  screen.listeners.forEach((listener) => listener());
  assert.deepEqual([page.$('dbody').querySelector('.dfile')!.className, page.$('dtool').querySelectorAll('[data-mode]').map((button) => button.textContent), stored.get('sf-diff-mode')],
    ['dfile', ['Side-by-side', 'Unified'], 'side']);
});

test('changes client (SF-119): the tree folds by its toggle; below 768 px a chosen file folds it and focuses the diff, wider it stays open; another job opens it again', async () => {
  const other = { ...job('awaiting_review'), ticket: 'T-2', branch: 'T-2-demo' };
  const narrow = mediaOf(true);
  const get = (path: string) => (path === 'api/jobs/app/T-2' ? detail(other) : api(path.replace('/app/T-2/', '/app/T-1/')));
  const page = await openChanges(job('awaiting_review'), get, '/changes', { matchMedia: narrow.matchMedia });
  assert.deepEqual([...cxtree(page), page.$('cxtree').getAttribute('aria-controls')], ['▾ Files', 'true', false, 'tlist']);
  page.$('cxtree').click();
  assert.deepEqual(cxtree(page), ['▸ Files', 'false', true]);
  page.$('cxtree').click();
  assert.deepEqual(cxtree(page), ['▾ Files', 'true', false]);
  // A folder's click leaves the tree open; a file's folds it, its diff shown and focused.
  rowOf(page, 'd:docs').click();
  assert.deepEqual(cxtree(page), ['▾ Files', 'true', false]);
  rowOf(page, 'f:src/app/main.ts').click();
  await page.flush();
  assert.deepEqual([...cxtree(page), dpath(page), page.document.activeElement], ['▸ Files', 'false', true, 'src/app/main.ts', page.$('dbody')]);
  // Another job: the tree open again.
  page.streams.at(-1)!.emit('jobs', { jobs: [job('awaiting_review'), other] });
  page.location.hash = '#app/T-2/changes';
  page.window.dispatch('hashchange');
  await page.flush();
  page.streams.at(-1)!.emit('job', detail(other));
  await page.flush();
  assert.deepEqual(cxtree(page), ['▾ Files', 'true', false]);
  // Not narrow: a file's click leaves the tree open.
  const wide = await openChanges(job('awaiting_review'), (path) => api(path), '/changes', { matchMedia: mediaOf(false).matchMedia });
  rowOf(wide, 'f:src/app/main.ts').click();
  await wide.flush();
  assert.deepEqual([...cxtree(wide), dpath(wide)], ['▾ Files', 'true', false, 'src/app/main.ts']);
});

test('changes client (SF-119): the keys of a folded tree: / opens it and focuses the filter, an arrow opens it and moves in it; Enter on the toggle is left to the button', async () => {
  const page = await openChanges(job('awaiting_review'), (path) => api(path), '/changes', { matchMedia: mediaOf(true).matchMedia });
  rowOf(page, 'f:src/app/main.ts').click();
  await page.flush();
  assert.deepEqual([cxtree(page)[2], page.document.activeElement], [true, page.$('dbody')]);
  page.key('/');
  assert.deepEqual([...cxtree(page), page.document.activeElement], ['▾ Files', 'true', false, page.$('cxq')]);
  rowOf(page, 'f:src/app/main.ts').click();
  await page.flush();
  assert.deepEqual([cxtree(page)[2], page.document.activeElement], [true, page.$('dbody')]);
  // Up and Down in the diff scroll it; Left is the tree's.
  page.key('ArrowDown');
  assert.equal(cxtree(page)[2], true);
  page.key('ArrowLeft');
  assert.deepEqual([cxtree(page)[2], page.document.activeElement?.classList.contains('trow'), selected(page)], [false, true, ['d:src/app']]);
  page.$('cxtree').focus();
  const enter = page.key('Enter');
  assert.equal(enter.defaultPrevented, false);
});
