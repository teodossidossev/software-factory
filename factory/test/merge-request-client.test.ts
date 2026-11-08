// The merge request in static/job-page.js, static/job-screens.js and static/board.js (SF-048), run
// under node:vm against the fake page of test/support/fake-dom.ts: Create merge request, Merge… and
// Refresh MR status in the job page's composer (SF-078) with their inline confirmations (the title,
// the target branch and the number), the link, the actions off with the missing variable named in
// their title, and the buttons and the link on the Your turn and Done board cards, whose
// confirmations open on the job's page (SF-077). The Merge request screen (SF-080): its fields and
// hints per state, Edit | Preview, the side panel, the live checks, Save (the button and Ctrl+S),
// Reset, the two pushes and the diff against the factory's text. Script checks, not browser
// acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMIT_TYPES, MANUAL_CLAIM, MAX_HEADER_CHARS, MR_REQUIRED_HEADINGS } from '../src/rules.js';
import { served } from './support/dashboard-client.js';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
const URL_1 = 'https://github.com/acme/app/pull/1';
const GITHUB = { host: 'github', reason: null };

// The job as the server sends it, with its actions and their availability (SF-129).
function job(ticket: string, state: string, extra: Record<string, unknown> = {}) {
  const prepared = state === 'ready_for_human_review' || state === 'pushed';
  return served({
    workspace: 'app', ticket, branch: `${ticket}-demo`, base: 'main', state, iteration: 1, mr_attempts: 1,
    updated_at: new Date(Date.now() - 4 * 60000).toISOString(), created_at: '2026-11-01T10:00:00.000Z', error: null,
    prepared_commit: prepared ? 'a'.repeat(40) : null, worktree: prepared ? null : `/wt/${ticket}`, fixes: 0, gate_fixes: 0, gate_tokens: 0,
    files: 0, undeclared: 0, deleted: 0, title: `Title of ${ticket}`, cost_usd: null, review: 'clean', review_ended_at: null, gate: null,
    mr: null as Record<string, unknown> | null, mr_host: GITHUB as { host: string | null; reason: string | null }, ...extra,
  });
}
type Job = ReturnType<typeof job>;

const detail = (row: Job) => ({ job: row, iterations: [], mr: true, mr_title: 'feat(T-1): Demo', gate: true, history: [] });

// remote: what api/jobs says of the page's port (SF-126); absent by default, as before it.
async function open(jobs: Job[], hash: string, remote?: boolean): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs, ...(remote !== undefined ? { remote } : {}) };
    }
    const match = /^api\/jobs\/app\/([^/]+)$/.exec(path);
    const found = match ? jobs.find((row) => row.ticket === match[1]) : undefined;
    return found ? detail(found) : undefined;
  });
  page.location.hash = hash;
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs });
  stream.emit('workspaces', { workspaces: [] });
  stream.emit('tickets', { tickets: [], archived: [] });
  const shown = jobs.find((row) => `#app/${row.ticket}` === hash);
  if (shown !== undefined) {
    stream.emit('job', detail(shown));
  }
  await page.flush();
  return page;
}

async function show(page: Page, row: Job): Promise<void> {
  page.streams.at(-1)!.emit('job', detail(row));
  await page.flush();
}

const posts = (page: Page, action: string): FetchRequest[] => page.requests.filter((request) => request.method === 'POST' && request.path === `api/jobs/app/T-1/${action}`);
// A composer button as [missing, disabled]: the composer shows only the actions that apply.
const state = (page: Page, id: string): [boolean, boolean] => {
  const node = page.document.getElementById(id);
  return node === null ? [true, true] : [false, node.disabled];
};
const missing = (page: Page, id: string): boolean => page.document.getElementById(id) === null;
const card = (page: Page, key: string): FakeElement => ['you', 'done'].flatMap((column) => page.$(`list-${column}`).children as FakeElement[])
  .find((item) => item.classList?.contains('card') && item.dataset.open === key)!;
const cardButtons = (item: FakeElement): string[] => item.all().filter((element) => element.tagName === 'BUTTON' && element.className.startsWith('btn')).map((element) => element.textContent);
const links = (item: FakeElement): FakeElement[] => item.all().filter((element) => element.tagName === 'A');

test('mr client: Create merge request… on a pushed job, confirmed with the title and the target; one POST; the outcome with the link', async () => {
  const page = await open([job('T-1', 'pushed')], '#app/T-1');
  assert.deepEqual([state(page, 'mr-create-button'), missing(page, 'mr-merge-button'), missing(page, 'mr-status-button'), missing(page, 'mr-line')], [[false, false], true, true, true]);
  assert.deepEqual(page.$('acts').children.map((button) => button.textContent), ['Create merge request', 'Archive']);
  page.$('mr-create-button').click();
  assert.equal(page.$('confirm-title').textContent, 'Create merge request app/T-1?');
  assert.equal(page.$('confirm-text').textContent, 'Opens a merge request on GitHub from T-1-demo into main, titled “feat(T-1): Demo”, with the rest of the MR text as its description. One already open for the branch is reused.');
  assert.deepEqual([page.$('as-is-label').hidden, page.$('discard-label').hidden, page.$('confirm-ok').textContent], [true, true, 'Create the merge request']);
  page.$('confirm-cancel').click();
  assert.equal(posts(page, 'mr-create').length, 0);
  page.$('mr-create-button').click();
  page.$('confirm-ok').click();
  await page.flush();
  const sent = posts(page, 'mr-create');
  assert.deepEqual(sent.map((request) => request.body), ['{}']);
  assert.equal(page.$('action-status').textContent, 'Opening the merge request…');
  sent[0]!.respond(200, { ok: true, result: { state: 'pushed', branch: 'T-1-demo', title: 'feat(T-1): Demo', mr: { host: 'github', number: 1, url: URL_1, state: 'open', reused: false } } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, `Merge request #1 opened: ${URL_1}`);

  // Opened: the link in the composer, Merge… and Refresh MR status instead of Create.
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 1, url: URL_1, state: 'open' } }));
  const link = links(page.$('mr-line'))[0]!;
  assert.deepEqual([page.$('mr-line').textContent, link.href, link.rel], [`Merge request #1 (open): ${URL_1}`, URL_1, 'noopener noreferrer']);
  assert.deepEqual([missing(page, 'mr-create-button'), state(page, 'mr-merge-button'), state(page, 'mr-status-button')], [true, [false, false], [false, false]]);
});

test('mr client: Merge… names the number and the target; the host\'s refusal is shown; Refresh MR status shows mergeable, the reason and the checks', async () => {
  const opened = job('T-1', 'pushed', { mr: { host: 'github', number: 4, url: URL_1, state: 'open' } });
  const page = await open([opened], '#app/T-1');
  page.$('mr-merge-button').click();
  assert.equal(page.$('confirm-title').textContent, 'Merge app/T-1?');
  assert.match(page.$('confirm-text').textContent, /^Merges merge request #4 \(T-1-demo\) into main on GitHub through its API, as a merge commit\. Nothing is pushed or forced;/);
  assert.equal(page.$('confirm-ok').textContent, 'Merge #4 into main');
  page.$('confirm-ok').click();
  await page.flush();
  posts(page, 'mr-merge')[0]!.respond(409, { ok: false, error: { code: 'mr_not_mergeable', message: 'GitHub cannot merge pull request #4: it has conflicts with main.' } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'mr_not_mergeable: GitHub cannot merge pull request #4: it has conflicts with main.');

  page.$('mr-status-button').click();
  await page.flush();
  const status = posts(page, 'mr-status');
  assert.deepEqual(status.map((request) => request.body), ['{}']);
  status[0]!.respond(200, { ok: true, result: { state: 'pushed', branch: 'T-1-demo', mr: opened.mr, status: { number: 4, url: URL_1, state: 'open', draft: false, mergeable: false, reason: 'it has conflicts with main', checks: '1 passed, 1 failed' } } });
  await page.flush();
  const said = 'On the host: #4 open, not mergeable: it has conflicts with main, checks: 1 passed, 1 failed.';
  assert.equal(page.$('action-status').textContent, said);
  assert.equal(page.$('mr-status-line').textContent, said);

  // Merged: no Create, no Merge; the merge request line says so.
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 4, url: URL_1, state: 'merged', merge_commit: 'c'.repeat(40) } }));
  assert.equal(page.$('mr-line').textContent, `Merge request #4 (merged): ${URL_1}`);
  assert.deepEqual([missing(page, 'mr-create-button'), missing(page, 'mr-merge-button'), missing(page, 'mr-status-button')], [true, true, false]);
});

test('mr client: the status line read before a merge never contradicts the merge request the job shows now', async () => {
  const opened = job('T-1', 'pushed', { mr: { host: 'github', number: 5, url: URL_1, state: 'open' } });
  const page = await open([opened], '#app/T-1');
  page.$('mr-status-button').click();
  await page.flush();
  posts(page, 'mr-status')[0]!.respond(200, { ok: true, result: { state: 'pushed', branch: 'T-1-demo', mr: opened.mr, status: { number: 5, url: URL_1, state: 'open', draft: false, mergeable: true, checks: '2 passed' } } });
  await page.flush();
  assert.equal(page.$('mr-status-line').textContent, 'On the host: #5 open, mergeable, checks: 2 passed.');
  // Merged (here, on the host or from another page): the job's update arrives; the open status goes.
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 5, url: URL_1, state: 'merged' } }));
  assert.equal(page.$('mr-line').textContent, `Merge request #5 (merged): ${URL_1}`);
  assert.equal(missing(page, 'mr-status-line'), true);
  // A later job update with the same merged state does not bring the old line back.
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 5, url: URL_1, state: 'merged' } }));
  assert.equal(missing(page, 'mr-status-line'), true);
  // A new merge request (another number) never shows the old one's status either.
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 6, url: URL_1, state: 'open' } }));
  assert.equal(missing(page, 'mr-status-line'), true);

  // A status that sees the merge before the job's update does: hidden while the job says open,
  // shown once the update records the merge.
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 6, url: URL_1, state: 'open' } }));
  page.$('mr-status-button').click();
  await page.flush();
  posts(page, 'mr-status')[1]!.respond(200, { ok: true, result: { state: 'pushed', branch: 'T-1-demo', mr: { number: 6, state: 'merged' }, status: { number: 6, url: URL_1, state: 'merged', draft: false, mergeable: false, reason: 'it is merged' } } });
  await page.flush();
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 6, url: URL_1, state: 'open' } }));
  assert.equal(missing(page, 'mr-status-line'), true);
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 6, url: URL_1, state: 'merged' } }));
  assert.equal(page.$('mr-status-line').textContent, 'On the host: #6 merged.');
});

test('mr client: the actions off name the missing variable; from ready_for_human_review Create pushes first; a link that is not https stays text', async () => {
  const page = await open([job('T-1', 'pushed', { mr_host: { host: 'github', reason: 'SF_GITHUB_TOKEN is not set in the environment file' } })], '#app/T-1');
  assert.deepEqual(state(page, 'mr-create-button'), [false, true]);
  assert.equal(page.$('mr-create-button').getAttribute('title'), 'SF_GITHUB_TOKEN is not set in the environment file.');
  page.$('mr-create-button').click();
  assert.equal(page.$('confirm').hidden, true);

  await show(page, job('T-1', 'ready_for_human_review'));
  assert.deepEqual([state(page, 'approve-button'), state(page, 'mr-create-button')], [[false, false], [false, false]]);
  page.$('mr-create-button').click();
  assert.match(page.$('confirm-text').textContent, /^Pushes branch T-1-demo to origin as Approve does, then opens a merge request on GitHub from T-1-demo into main, titled “feat\(T-1\): Demo”/);
  page.$('confirm-ok').click();
  await page.flush();
  posts(page, 'mr-create')[0]!.respond(200, { ok: true, result: { state: 'pushed', branch: 'T-1-demo', title: 'x', link: 'https://github.com/acme/app/compare/main...T-1-demo?expand=1', error: { code: 'mr_host_unreachable', message: 'GitHub did not answer.' } } });
  await page.flush();
  assert.equal(page.$('action-status').textContent, 'Pushed T-1-demo, but the merge request was not opened (mr_host_unreachable: GitHub did not answer.). Fix it, then create the merge request again.');

  await show(page, job('T-1', 'pushed', { mr: { host: 'gitlab', number: 2, url: 'javascript:alert(1)', state: 'open' } }));
  assert.deepEqual(links(page.$('mr-line')), []);
  assert.equal(page.$('mr-line').textContent, 'Merge request #2 (open): javascript:alert(1)');
});

test('mr client: the board offers Create merge request… on Your turn and Done cards, Merge… and the link on a Done card; each opens its confirmation on the job page', async () => {
  const jobs = [
    job('T-1', 'pushed', { mr: { host: 'github', number: 1, url: URL_1, state: 'open' } }),
    job('T-2', 'ready_for_human_review'),
    job('T-3', 'pushed', { mr_host: { host: null, reason: 'the origin URL of the checkout names no GitHub or GitLab repository' } }),
    job('T-4', 'pushed', { mr: { host: 'github', number: 9, url: URL_1, state: 'merged' } }),
  ];
  const page = await open(jobs, '');
  assert.deepEqual(cardButtons(card(page, 'app/T-1')), ['Merge…']);
  assert.deepEqual(links(card(page, 'app/T-1')).map((element) => element.href), [URL_1]);
  assert.deepEqual(cardButtons(card(page, 'app/T-2')), ['Review the MR and push', 'Create merge request…']);
  const off = card(page, 'app/T-3').all().find((element) => element.tagName === 'BUTTON' && element.textContent === 'Create merge request…')!;
  assert.deepEqual([off.disabled, off.getAttribute('title')], [true, 'the origin URL of the checkout names no GitHub or GitLab repository.']);
  assert.deepEqual(cardButtons(card(page, 'app/T-4')), []);
  assert.match(card(page, 'app/T-4').textContent, /#9 merged/);

  card(page, 'app/T-1').all().find((element) => element.tagName === 'BUTTON' && element.textContent === 'Merge…')!.click();
  await page.flush();
  page.streams.at(-1)!.emit('job', detail(jobs[0]!));
  await page.flush();
  assert.deepEqual([page.$('confirm').hidden, page.$('confirm-ok').textContent], [false, 'Merge #1 into main']);
  assert.deepEqual([page.$('job').hidden, page.$('drawer').hidden, page.$('confirm').closest('#job') !== null], [false, true, true]);
});

// ---------- SF-080: the Merge request screen (renderMr, renderMrChecks, mrAction) ----------

const TITLE = 'feat(T-1): Change the README';
const BODY = [
  '## What', 'Changes the README.', '## Why', 'Readers ask for it.', '## How', 'One line.', '## Why the change', 'Readers need it.',
  '## Special things to note', '- None.', '## Change outline', '- README.md', '## Testing', '- npm test: passed', '- Not checked: by hand, open the page (the user)',
  '## Checklist', '- [x] Branch name', '- [ ] Tests',
].join('\n');
const RULES = { commit_types: COMMIT_TYPES, max_header_chars: MAX_HEADER_CHARS, required_headings: MR_REQUIRED_HEADINGS, manual_claim: { source: MANUAL_CLAIM.source, flags: MANUAL_CLAIM.flags } };
const PUSHED_AT = '2026-11-05T09:41:00.000Z';
const hhmm = (ts: string): string => `${String(new Date(ts).getHours()).padStart(2, '0')}:${String(new Date(ts).getMinutes()).padStart(2, '0')}`;

function mrView(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: TITLE, body: BODY, factory: { title: TITLE, body: BODY }, edited: false, edited_at: null, factory_new_at: null, branch: 'T-1-demo', base: 'main',
    branch_editable: true, branch_reason: null, base_editable: true, base_reason: null, problems: [], pushed: false, pushed_at: null, editable: true, readonly_reason: null,
    target: { host: 'github', repository: 'acme/app' }, rules: RULES, commit: { title: TITLE, body: BODY }, commit_differs: false, ...extra,
  };
}

const ITERATIONS = [
  { number: 1, review: { reviewer: 'claude', verdict: 'fix', items: [] }, gate: null, gate_override: null },
  { number: 2, review: { reviewer: 'claude', verdict: 'clean', items: [] }, gate: { reviewer: 'codex', verdict: 'clean', items: [] }, gate_override: null },
];

interface MrPage {
  page: Page;
  // What the next GET of mr-view answers.
  set(view: Record<string, unknown>): void;
}

// The job's page on its Merge request screen, its detail from the stream, mr-view answered from set().
async function openMr(row: Job, view: Record<string, unknown>, hash = '#app/T-1/mr', iterations: unknown[] = ITERATIONS): Promise<MrPage> {
  let current = view;
  const shown = { ...detail(row), iterations };
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs: [row] };
    }
    if (path === 'api/jobs/app/T-1') {
      return shown;
    }
    return path === 'api/jobs/app/T-1/mr-view' ? current : undefined;
  });
  page.location.hash = hash;
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs: [row] });
  stream.emit('workspaces', { workspaces: [] });
  stream.emit('tickets', { tickets: [], archived: [] });
  stream.emit('job', shown);
  await page.flush();
  return { page, set: (next) => { current = next; } };
}

const gets = (page: Page, path: string): FetchRequest[] => page.requests.filter((request) => request.method === 'GET' && request.path === path);
const bad = (page: Page, field: string): string => page.$('scrMr').querySelector(`[data-err="${field}"]`)!.textContent;
const hintOf = (page: Page, id: string): string => (page.$(id).parentNode as FakeElement).querySelector('.hint')!.textContent;
const barTexts = (page: Page): string[] => (page.$('mrBar').children as FakeElement[]).map((node) => node.textContent);
const barButton = (page: Page, label: string): FakeElement | undefined => page.$('mrBar').all().find((node) => node.tagName === 'BUTTON' && node.textContent.startsWith(label));
const cards = (page: Page): FakeElement[] => page.$('mrSide').children as FakeElement[];
const cardOf = (page: Page, title: string): FakeElement => cards(page).find((node) => node.querySelector('h3')!.textContent.startsWith(title))!;
const checks = (page: Page): string[] => cardOf(page, 'Checks').querySelectorAll('li').map((item) => item.textContent);
function type(page: Page, id: string, value: string): void {
  const node = page.$(id);
  node.focus();
  node.value = value;
  node.dispatch('input');
}

test('mr screen (SF-080): the fields with their hints, the side panel (commit message, carries, not checked, checks) and the bar of a job ready for review', async () => {
  const { page } = await openMr(job('T-1', 'ready_for_human_review', { files: 3, fixes: 1, gate_tokens: 12345 }), mrView());
  assert.deepEqual(gets(page, 'api/jobs/app/T-1/mr-view').length, 1);
  assert.equal(page.$('scrMr').querySelector('h3')!.textContent, 'Merge request');
  assert.deepEqual([page.$('mrBranch').value, page.$('mrBranch').disabled, hintOf(page, 'mrBranch')], ['T-1-demo', false, 'Editable until the first push.']);
  assert.deepEqual([page.$('mrBase').value, page.$('mrBase').disabled, hintOf(page, 'mrBase')], ['main', false, 'The MR targets this branch, e.g. main or master.']);
  assert.deepEqual([page.$('mrTitle').value, hintOf(page, 'mrTitle')], [TITLE, 'One line, the commit header too: <type>(T-1): <summary>, at most 72 characters.']);
  assert.deepEqual([page.$('mrBody').tagName, page.$('mrBody').className, page.$('mrBody').value, page.$('mrBody').disabled], ['TEXTAREA', 'mdedit', BODY, false]);
  assert.deepEqual(['title', 'body', 'branch', 'base'].map((field) => bad(page, field)), ['', '', '', '']);
  assert.deepEqual(page.$('scrMr').querySelectorAll('.edtabs button').map((node) => [node.textContent, node.className]), [['Edit', 'on'], ['Preview', '']]);

  assert.deepEqual(cards(page).map((node) => node.querySelector('h3')!.textContent), ['Commit message read-only', 'Carries', 'Not checked', 'Checks']);
  const commit = cardOf(page, 'Commit message');
  assert.equal(commit.querySelector('pre.cm')!.textContent, `${TITLE}\n\n${BODY}`);
  assert.equal(commit.querySelector('.hint')!.textContent, 'The commit message is the MR title and text. The factory amends the commit before the push when you change the text.');
  const kv = cardOf(page, 'Carries').querySelector('dl.kv')!;
  assert.deepEqual((kv.children as FakeElement[]).map((node) => node.textContent), [
    'Files', '3 changed · Open Changes c', 'Claude', 'clean at iteration 2', 'Codex', 'clean at iteration 2 · 12,345 tokens', 'Fix rounds', '1', 'Target', 'GitHub acme/appmain ← T-1-demo',
  ]);
  assert.deepEqual(cardOf(page, 'Not checked').querySelectorAll('.notline').map((node) => [node.className, node.textContent]), [['notline', 'Not checked: by hand, open the page (the user)']]);
  assert.deepEqual(checks(page), ['✓Title follows the commit header rule', '✓Branch and base are set', '✓All required headings are present', '✓## Testing claims no manual check as run (SF-058)']);

  assert.deepEqual(barTexts(page), ["The factory's text", '', 'Save Ctrl+S', 'Reset to factory text', 'Push branch only', 'Push and open MR ↗']);
  assert.deepEqual([barButton(page, 'Save')!.disabled, barButton(page, 'Reset')!.disabled, barButton(page, 'Push branch only')!.disabled, barButton(page, 'Push and open MR')!.disabled], [true, true, false, false]);
  assert.equal(barButton(page, 'Push and open MR')!.className, 'btn primary');
  // Open Changes goes to the Changes screen.
  cardOf(page, 'Carries').querySelector('button')!.click();
  assert.equal(page.location.hash, '#app/T-1/changes');
});

test('mr screen (SF-080): the checks run live with the server\'s rules; each problem on its field\'s .bad line; the push buttons are off while there are problems', async () => {
  const { page } = await openMr(job('T-1', 'ready_for_human_review'), mrView());
  type(page, 'mrTitle', 'Change the README.');
  assert.equal(bad(page, 'title'), 'The title ends with a period.');
  type(page, 'mrTitle', `feat(T-1): ${'x'.repeat(62)}`);
  assert.equal(bad(page, 'title'), 'The title has 73 characters, more than 72.');
  type(page, 'mrTitle', 'chore(T-2): Other ticket');
  assert.equal(bad(page, 'title'), `The title must read "<type>(T-1): <summary>", with <type> one of ${COMMIT_TYPES.join(', ')}.`);
  type(page, 'mrBranch', '');
  type(page, 'mrBase', ' ');
  type(page, 'mrBody', BODY.replace('## Why the change\n', '').replace('## How\n', '').replace('- npm test: passed', '- By hand: opened the page'));
  assert.deepEqual([bad(page, 'branch'), bad(page, 'base')], ['The branch is required.', 'The base branch is required.']);
  assert.equal(bad(page, 'body'), 'Missing heading: ## How. Missing heading: ## Why the change. SF-058: the ## Testing line "- By hand: opened the page" reads as a check that was run. Anything not run goes on a line starting with "Not checked:".');
  assert.deepEqual(checks(page), ['✕Title follows the commit header rule', '✕Branch and base are set', '✕All required headings are present', '✕## Testing claims no manual check as run (SF-058)']);
  assert.deepEqual(cardOf(page, 'Not checked').querySelectorAll('.notline').map((node) => [node.className, node.textContent]), [
    ['notline', 'Not checked: by hand, open the page (the user)'], ['notline bad', 'SF-058: By hand: opened the page'],
  ]);
  assert.deepEqual(barTexts(page).slice(0, 2), ['Unsaved changes', '6 problems to fix before pushing']);
  assert.deepEqual([barButton(page, 'Save')!.disabled, barButton(page, 'Push branch only')!.disabled, barButton(page, 'Push and open MR')!.disabled], [false, true, true]);
  assert.equal(barButton(page, 'Push and open MR')!.getAttribute('title'), 'Fix the problems first');
  // The commit message follows the draft.
  assert.match(cardOf(page, 'Commit message').querySelector('pre.cm')!.textContent, /^chore\(T-2\): Other ticket\n\n## What\n/);
  // A rule of the server, not of the page: another commit type list changes the check.
  const { page: other } = await openMr(job('T-1', 'ready_for_human_review'), mrView({ rules: { ...RULES, commit_types: ['feat'] } }));
  type(other, 'mrTitle', 'fix(T-1): A fix');
  assert.equal(bad(other, 'title'), 'The title must read "<type>(T-1): <summary>", with <type> one of feat.');
  // Without unsaved changes the server's list of the saved text is shown.
  const { page: saved } = await openMr(job('T-1', 'ready_for_human_review'), mrView({ problems: [{ field: 'body', message: 'Missing heading: ## Why.' }] }));
  assert.deepEqual([bad(saved, 'body'), barTexts(saved)[1]], ['Missing heading: ## Why.', '1 problem to fix before pushing']);
});

test('mr screen (SF-080): Preview renders the Markdown as nodes (headings, paragraphs, lists, task lists, code, tables, inline marks, http(s) links), never raw HTML or a javascript: link; Not checked and manual claims marked', async () => {
  const text = [
    '## What', 'Plain **bold**, *italic*, `code` and [a link](https://example.com/x) and [bad](javascript:alert(1)).', '<script>alert(1)</script> <b>raw</b>', '',
    '### Detail', '- one', '- [x] done task', '- [ ] open task', '', '1. first', '', '```', '<i>not markup</i>', '```', '', '| A | B |', '|---|---|', '| 1 | `2` |', '',
    '## Testing', '- npm test: passed', '- Not checked: by hand, open the page', '- By hand: clicked it',
  ].join('\n');
  const { page } = await openMr(job('T-1', 'ready_for_human_review'), mrView({ body: text, factory: { title: TITLE, body: text }, commit: { title: TITLE, body: text } }));
  (page.$('scrMr').querySelectorAll('.edtabs button').find((node) => node.textContent === 'Preview')!).click();
  assert.equal(page.document.getElementById('mrBody'), null);
  const preview = page.$('mrPreview');
  assert.equal(preview.className, 'card2');
  const tags = new Set(preview.all().map((node) => node.tagName));
  for (const tag of ['DIV', 'H2', 'H3', 'P', 'B', 'I', 'CODE', 'A', 'UL', 'OL', 'LI', 'INPUT', 'PRE', 'TABLE', 'TR', 'TH', 'TD']) {
    assert.ok(tags.has(tag), tag);
  }
  assert.equal(tags.has('SCRIPT'), false);
  assert.equal(preview.querySelectorAll('b').map((node) => node.textContent).join('|'), 'bold');
  assert.deepEqual(preview.querySelectorAll('a').map((node) => [node.textContent, node.href, node.target, node.rel]), [['a link', 'https://example.com/x', '_blank', 'noopener noreferrer']]);
  assert.match(preview.textContent, /\[bad\]\(javascript:alert\(1\)\)/);
  assert.match(preview.textContent, /<script>alert\(1\)<\/script> <b>raw<\/b>/);
  assert.equal(preview.querySelector('pre')!.textContent, '<i>not markup</i>');
  assert.deepEqual(preview.querySelectorAll('li.task input').map((box) => [box.type, box.disabled, box.checked]), [['checkbox', true, true], ['checkbox', true, false]]);
  assert.deepEqual(preview.querySelectorAll('th, td').map((node) => node.textContent), ['A', 'B', '1', '2']);
  assert.deepEqual(preview.querySelectorAll('li.notchk, li.flag').map((node) => [node.className, node.textContent]), [['notchk', 'Not checked: by hand, open the page'], ['flag', 'By hand: clicked it']]);
  // Edit again: the textarea with the text.
  (page.$('scrMr').querySelectorAll('.edtabs button').find((node) => node.textContent === 'Edit')!).click();
  assert.equal(page.$('mrBody').value, text);
});

test('mr screen (SF-080): Save (the button and Ctrl+S) posts the draft, the branch and the base only when changed; edited by you and the diff against the factory\'s text; a refusal in the bar and the view read again; Reset', async () => {
  const { page, set } = await openMr(job('T-1', 'ready_for_human_review'), mrView());
  const title = 'feat(T-1): Change the README for readers';
  type(page, 'mrTitle', title);
  barButton(page, 'Save')!.click();
  await page.flush();
  assert.deepEqual(posts(page, 'mr-save').map((request) => JSON.parse(request.body!)), [{ title, body: BODY }]);
  assert.equal(barTexts(page)[0], 'Saving…');
  assert.equal(barButton(page, 'Save')!.disabled, true);
  set(mrView({ title, edited: true, edited_at: PUSHED_AT, commit: { title, body: BODY } }));
  posts(page, 'mr-save')[0]!.respond(200, { ok: true, result: { state: 'ready_for_human_review', branch: 'T-1-demo', base: 'main', edited: true, prepared_commit: 'b'.repeat(40) } });
  await page.flush();
  assert.equal(gets(page, 'api/jobs/app/T-1/mr-view').length, 2);
  assert.deepEqual([barTexts(page)[0], page.$('mrEdited').textContent, page.$('toast-text').textContent], ['Saved, edited by you', 'edited by you', 'MR text saved']);
  assert.equal(barButton(page, 'Reset to factory text')!.disabled, false);

  // Show changes against the factory's text: the line diff of the two messages.
  const diffButton = page.$('scrMr').querySelectorAll('.edtabs button').find((node) => node.textContent === "Show changes against the factory's text")!;
  diffButton.click();
  const diff = page.$('scrMr').querySelector('.dfile')!;
  assert.equal(diff.className, 'dfile uni boxed');
  assert.deepEqual(diff.querySelectorAll('.r.del, .r.add').map((row) => [row.className, row.querySelector('.c')!.textContent]), [['r del', TITLE], ['r add', title]]);
  page.$('scrMr').querySelectorAll('.edtabs button').find((node) => node.textContent === 'Edit')!.click();

  // Ctrl+S in a field, the branch and the base changed: they go too; a refusal shows in the bar.
  type(page, 'mrBranch', 'T-1-readers');
  type(page, 'mrBase', 'release');
  type(page, 'mrBody', `${BODY}\n- [x] Tests`);
  const key = page.key('s', { ctrlKey: true });
  assert.equal(key.defaultPrevented, true);
  await page.flush();
  assert.deepEqual(JSON.parse(posts(page, 'mr-save')[1]!.body!), { title, body: `${BODY}\n- [x] Tests`, branch: 'T-1-readers', base: 'release' });
  posts(page, 'mr-save')[1]!.respond(409, { ok: false, error: { code: 'branch_locked', message: 'The branch cannot be renamed to T-1-readers: a branch of that name exists on origin.' } });
  await page.flush();
  assert.equal(barTexts(page)[0], 'Not saved: branch_locked: The branch cannot be renamed to T-1-readers: a branch of that name exists on origin.');
  assert.equal(gets(page, 'api/jobs/app/T-1/mr-view').length, 3);
  // The draft stays.
  assert.deepEqual([page.$('mrBranch').value, page.$('mrBase').value], ['T-1-readers', 'release']);
  // Typing again clears the refusal.
  type(page, 'mrBase', 'main');
  assert.equal(barTexts(page)[0], 'Unsaved changes');

  // Reset to factory text: one POST; the factory's title and text back, the branch as typed.
  barButton(page, 'Reset to factory text')!.click();
  await page.flush();
  assert.deepEqual(posts(page, 'mr-reset').map((request) => request.body), ['{}']);
  set(mrView());
  posts(page, 'mr-reset')[0]!.respond(200, { ok: true, result: { state: 'ready_for_human_review', branch: 'T-1-demo', base: 'main', edited: false, prepared_commit: 'c'.repeat(40) } });
  await page.flush();
  assert.deepEqual([page.$('mrTitle').value, page.$('mrBody').value, page.$('mrBranch').value, page.$('mrEdited').textContent], [TITLE, BODY, 'T-1-readers', '']);
  // A draft that only differs from the factory's saved text goes back without a request.
  type(page, 'mrBranch', 'T-1-demo');
  type(page, 'mrTitle', 'feat(T-1): Something else');
  barButton(page, 'Reset to factory text')!.click();
  await page.flush();
  assert.deepEqual([posts(page, 'mr-reset').length, page.$('mrTitle').value, barTexts(page)[0]], [1, TITLE, "The factory's text"]);
});

test('mr screen (SF-080): Push branch only is approve; with unsaved changes it saves first and pushes only after the save succeeded; branch_changed offers Push it as it is (as_is)', async () => {
  const { page } = await openMr(job('T-1', 'ready_for_human_review'), mrView());
  barButton(page, 'Push branch only')!.click();
  await page.flush();
  assert.deepEqual([posts(page, 'approve').map((request) => request.body), posts(page, 'mr-save').length], [['{}'], 0]);
  posts(page, 'approve')[0]!.respond(409, { ok: false, error: { code: 'branch_changed', message: 'The tip of T-1-demo is 1234, not the prepared aaaa: it was edited by hand. Approve with --as-is to push it as it is.' } });
  await page.flush();
  assert.match(barTexts(page)[0]!, /^branch_changed: The tip of T-1-demo/);
  barButton(page, 'Push it as it is')!.click();
  await page.flush();
  assert.deepEqual(posts(page, 'approve').map((request) => request.body), ['{}', '{"as_is":true}']);
  posts(page, 'approve')[1]!.respond(200, { ok: true, result: { state: 'pushed', branch: 'T-1-demo', title: TITLE, link: 'https://github.com/acme/app/compare/main...T-1-demo?expand=1' } });
  await page.flush();
  assert.match(barTexts(page)[0]!, /^Pushed T-1-demo\. feat\(T-1\): Change the README Merge request: https:\/\/github\.com\//);

  // Unsaved changes: the save first; a refused save pushes nothing.
  const second = await openMr(job('T-1', 'ready_for_human_review'), mrView());
  type(second.page, 'mrTitle', 'feat(T-1): Change it');
  barButton(second.page, 'Push branch only')!.click();
  await second.page.flush();
  assert.deepEqual([posts(second.page, 'mr-save').length, posts(second.page, 'approve').length], [1, 0]);
  posts(second.page, 'mr-save')[0]!.respond(400, { ok: false, error: { code: 'mr_text_invalid', message: 'The MR text is invalid.' } });
  await second.page.flush();
  assert.equal(posts(second.page, 'approve').length, 0);
  assert.equal(barTexts(second.page)[0], 'Not saved: mr_text_invalid: The MR text is invalid.');
  barButton(second.page, 'Push branch only')!.click();
  await second.page.flush();
  second.set(mrView({ title: 'feat(T-1): Change it', edited: true, commit: { title: 'feat(T-1): Change it', body: BODY } }));
  posts(second.page, 'mr-save')[1]!.respond(200, { ok: true, result: { state: 'ready_for_human_review', branch: 'T-1-demo', base: 'main', edited: true, prepared_commit: 'b'.repeat(40) } });
  await second.page.flush();
  assert.deepEqual(posts(second.page, 'approve').map((request) => request.body), ['{}']);
});

test('mr screen (SF-080): Push and open MR is one mr-create, after a successful save only; off with the host\'s reason next to Push branch only', async () => {
  const { page, set } = await openMr(job('T-1', 'ready_for_human_review'), mrView());
  type(page, 'mrBody', `${BODY}\n- [x] Tests`);
  barButton(page, 'Push and open MR')!.click();
  await page.flush();
  assert.deepEqual([posts(page, 'mr-save').length, posts(page, 'mr-create').length], [1, 0]);
  posts(page, 'mr-save')[0]!.fail();
  await page.flush();
  assert.equal(posts(page, 'mr-create').length, 0);
  assert.match(barTexts(page)[0]!, /^The save failed \(Failed to fetch\); it may have been written\./);
  barButton(page, 'Push and open MR')!.click();
  await page.flush();
  set(mrView({ body: `${BODY}\n- [x] Tests`, edited: true }));
  posts(page, 'mr-save')[1]!.respond(200, { ok: true, result: { state: 'ready_for_human_review', branch: 'T-1-demo', base: 'main', edited: true, prepared_commit: 'b'.repeat(40) } });
  await page.flush();
  assert.deepEqual(posts(page, 'mr-create').map((request) => request.body), ['{}']);
  assert.equal(barTexts(page)[0], 'Opening the merge request…');
  posts(page, 'mr-create')[0]!.respond(200, { ok: true, result: { state: 'pushed', branch: 'T-1-demo', title: TITLE, link: 'https://x', mr: { host: 'github', number: 3, url: 'https://github.com/acme/app/pull/3', state: 'open', reused: false } } });
  await page.flush();
  assert.equal(posts(page, 'mr-create').length, 1);

  const off = await openMr(job('T-1', 'ready_for_human_review', { mr_host: { host: null, reason: 'SF_GITHUB_TOKEN is not set' } }), mrView());
  assert.equal(barButton(off.page, 'Push and open MR'), undefined);
  assert.deepEqual(barTexts(off.page).slice(-2), ['Push branch only', 'Push and open MR is off: SF_GITHUB_TOKEN is not set.']);
});

test('mr screen (SF-080): read-only when pushed (the time, Back to the stream), when handed over (the push buttons stay) and in any other state; a new factory text and a commit that is not the MR text are shown', async () => {
  const pushed = await openMr(job('T-1', 'pushed'), mrView({
    pushed: true, pushed_at: PUSHED_AT, editable: false, readonly_reason: 'Pushed at 09:41. The MR text is read-only now.', branch_editable: false, branch_reason: 'Fixed after the first push.', base_editable: false, base_reason: 'Fixed after the first push.',
  }));
  const page = pushed.page;
  assert.deepEqual(page.$('scrMr').querySelector('h3')!.children.map((node) => node.textContent), ['Merge request', 'read-only: pushed', '']);
  assert.deepEqual(['mrBranch', 'mrBase', 'mrTitle', 'mrBody'].map((id) => page.$(id).disabled), [true, true, true, true]);
  assert.equal(hintOf(page, 'mrBranch'), 'Fixed after the first push.');
  assert.deepEqual(barTexts(page), [`Pushed at ${hhmm(PUSHED_AT)}.`, 'The MR text is read-only now.', '', 'Back to the stream']);
  barButton(page, 'Back to the stream')!.click();
  assert.equal(page.location.hash, '#app/T-1');

  const handed = await openMr(job('T-1', 'handed_over', { prepared_commit: 'a'.repeat(40) }), mrView({
    editable: false, readonly_reason: 'The branch is in your checkout. Take it back to edit the MR text.', branch_editable: false, branch_reason: 'The branch is in your checkout.', base_editable: false, base_reason: 'The branch is in your checkout.',
  }));
  assert.deepEqual(barTexts(handed.page), ['The branch is in your checkout. Take it back to edit the MR text.', '', 'Push branch only', 'Push and open MR ↗']);
  assert.equal(handed.page.$('mrTitle').disabled, true);
  barButton(handed.page, 'Push branch only')!.click();
  await handed.page.flush();
  assert.deepEqual([posts(handed.page, 'approve').map((request) => request.body), posts(handed.page, 'mr-save').length], [['{}'], 0]);

  // Another state: the screen is read-only, so every field is off, though the job would let the branch and base change.
  const working = await openMr(job('T-1', 'working'), mrView({ editable: false, readonly_reason: 'The MR text can be edited when the job waits for your review.' }));
  assert.deepEqual(barTexts(working.page), ['The MR text can be edited when the job waits for your review.', '', 'Back to the stream']);
  assert.deepEqual(['mrBranch', 'mrBase', 'mrTitle', 'mrBody'].map((id) => working.page.$(id).disabled), [true, true, true, true]);

  // A new Clean kept the user's text and committed the factory's (an invalid user text).
  const factoryText = { title: 'feat(T-1): The factory again', body: BODY };
  const kept = await openMr(job('T-1', 'ready_for_human_review'), mrView({ edited: true, factory: factoryText, factory_new_at: PUSHED_AT, commit: factoryText, commit_differs: true }));
  assert.equal(kept.page.$('mrFactoryNew').textContent, `The factory wrote a new text (${hhmm(PUSHED_AT)}). Compare · Reset to factory text`);
  assert.deepEqual(cardOf(kept.page, 'Commit message').querySelectorAll('pre.cm, .err-text').map((node) => node.textContent), [`feat(T-1): The factory again\n\n${BODY}`, 'differs from the MR text: save or reset']);
  kept.page.$('mrFactoryNew').querySelector('button')!.click();
  assert.deepEqual(kept.page.$('scrMr').querySelectorAll('.dfile .r.del, .dfile .r.add').map((row) => row.querySelector('.c')!.textContent), ['feat(T-1): The factory again', TITLE]);
});

test('mr screen (SF-080): the composer\'s primary in ready_for_human_review opens the screen (Approve… stays second); the draft is kept across screens; leaving the page with it unsaved asks first', async () => {
  const { page } = await openMr(job('T-1', 'ready_for_human_review'), mrView(), '#app/T-1');
  const acts = page.$('acts').children as FakeElement[];
  assert.deepEqual(acts.slice(0, 2).map((node) => [node.textContent, node.className]), [['Review the MR and push', 'btn primary'], ['Approve…', 'btn']]);
  acts[0]!.click();
  await page.flush();
  assert.deepEqual([page.location.hash, page.$('scrMr').hidden, page.$('confirm').hidden], ['#app/T-1/mr', false, true]);
  assert.equal((page.window.dispatch('beforeunload', {}) as { returnValue?: unknown }).returnValue, undefined);
  type(page, 'mrTitle', 'feat(T-1): A draft');
  page.$('mrTitle').blur();
  page.key('s');
  assert.equal(page.location.hash, '#app/T-1');
  page.key('m');
  await page.flush();
  assert.equal(page.$('mrTitle').value, 'feat(T-1): A draft');
  let prevented = false;
  const event = page.window.dispatch('beforeunload', { preventDefault: () => { prevented = true; } }) as { returnValue?: unknown };
  assert.deepEqual([event.returnValue, prevented], ['', true]);
});

test('mr client (SF-126): from another device (api/jobs remote: true) Merge… asks "Type <ticket> to continue" and sends confirm only after the exact ticket; Cancel and Escape send nothing; locally nothing changes', async () => {
  const opened = job('T-1', 'pushed', { mr: { host: 'github', number: 4, url: URL_1, state: 'open' } });
  const page = await open([opened], '#app/T-1', true);
  const confirmMerge = async (): Promise<void> => {
    page.$('mr-merge-button').click();
    assert.equal(page.$('confirm-title').textContent, 'Merge app/T-1?');
    page.$('confirm-ok').click();
    await page.flush();
  };
  await confirmMerge();
  // The first confirmation as before, then the dialog; nothing is sent yet.
  assert.equal(posts(page, 'mr-merge').length, 0);
  assert.equal(page.$('remote-confirm').hidden, false);
  assert.equal(page.$('remote-confirm-title').textContent, 'Type T-1 to continue');
  assert.equal(page.$('remote-confirm-text').textContent, 'Merge from another device: it merges the merge request on the Git host.');
  assert.deepEqual([page.$('remote-confirm-ok').textContent, page.$('remote-confirm-ok').disabled], ['Merge', true]);
  for (const typed of ['T-', 't-1', 'T-1 ', 'app/T-1', 'T-10']) {
    type(page, 'remote-confirm-input', typed);
    assert.equal(page.$('remote-confirm-ok').disabled, true, typed);
    page.$('remote-confirm-ok').click();
    page.$('remote-confirm-input').dispatch('keydown', { key: 'Enter' });
    await page.flush();
    assert.equal(posts(page, 'mr-merge').length, 0, typed);
  }
  type(page, 'remote-confirm-input', 'T-1');
  assert.equal(page.$('remote-confirm-ok').disabled, false);
  page.$('remote-confirm-ok').click();
  await page.flush();
  assert.deepEqual(posts(page, 'mr-merge').map((request) => request.body), ['{"confirm":"T-1"}']);
  assert.equal(page.$('remote-confirm').hidden, true);
  posts(page, 'mr-merge')[0]!.respond(200, { ok: true, result: { state: 'pushed', branch: 'T-1-demo', mr: { ...opened.mr, state: 'merged' } } });
  await page.flush();

  // Cancel, and Escape, after the exact ticket: nothing is sent.
  await confirmMerge();
  type(page, 'remote-confirm-input', 'T-1');
  page.$('remote-confirm-cancel').click();
  await page.flush();
  await confirmMerge();
  type(page, 'remote-confirm-input', 'T-1');
  page.$('remote-confirm-input').dispatch('keydown', { key: 'Escape' });
  await page.flush();
  assert.equal(page.$('remote-confirm').hidden, true);
  assert.equal(posts(page, 'mr-merge').length, 1);
  // Enter with the exact ticket sends it.
  await confirmMerge();
  type(page, 'remote-confirm-input', 'T-1');
  page.$('remote-confirm-input').dispatch('keydown', { key: 'Enter' });
  await page.flush();
  assert.deepEqual(posts(page, 'mr-merge').map((request) => request.body), ['{"confirm":"T-1"}', '{"confirm":"T-1"}']);

  // Locally (remote: false): the one confirmation, the body as before, no dialog.
  const local = await open([opened], '#app/T-1', false);
  local.$('mr-merge-button').click();
  local.$('confirm-ok').click();
  await local.flush();
  assert.deepEqual(posts(local, 'mr-merge').map((request) => request.body), ['{}']);
  assert.equal(local.document.getElementById('remote-confirm'), null);
});
