// The merge request in static/app.js (SF-048), run under node:vm against the fake page of
// test/support/fake-dom.ts: Create merge request…, Merge… and Refresh MR status in the job drawer's
// next-action panel with their confirmations (the title, the target branch and the number), the
// link, the actions off with the missing variable named, and the buttons and the link on the Your
// turn and Done board cards. Script checks, not browser acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
const URL_1 = 'https://github.com/acme/app/pull/1';
const GITHUB = { host: 'github', reason: null };

function job(ticket: string, state: string, extra: Record<string, unknown> = {}) {
  const prepared = state === 'ready_for_human_review' || state === 'pushed';
  return {
    workspace: 'app', ticket, branch: `${ticket}-demo`, base: 'main', state, iteration: 1, mr_attempts: 1,
    updated_at: new Date(Date.now() - 4 * 60000).toISOString(), created_at: '2026-11-01T10:00:00.000Z', error: null,
    prepared_commit: prepared ? 'a'.repeat(40) : null, worktree: prepared ? null : `/wt/${ticket}`, fixes: 0, gate_fixes: 0, gate_tokens: 0,
    files: 0, undeclared: 0, deleted: 0, title: `Title of ${ticket}`, cost_usd: null, review: 'clean', review_ended_at: null, gate: null,
    mr: null as Record<string, unknown> | null, mr_host: GITHUB as { host: string | null; reason: string | null }, ...extra,
  };
}
type Job = ReturnType<typeof job>;

const detail = (row: Job) => ({ job: row, iterations: [], mr: true, mr_title: 'feat(T-1): Demo', gate: true, history: [] });

async function open(jobs: Job[], hash: string): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return { jobs };
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
const state = (page: Page, id: string): [boolean, boolean] => [page.$(id).hidden, page.$(id).disabled];
const card = (page: Page, key: string): FakeElement => ['you', 'done'].flatMap((column) => page.$(`list-${column}`).children as FakeElement[])
  .find((item) => item.className?.startsWith('board-card') && item.dataset.key === key)!;
const cardButtons = (item: FakeElement): string[] => item.all().filter((element) => element.tagName === 'BUTTON' && element.className.startsWith('btn')).map((element) => element.textContent);
const links = (item: FakeElement): FakeElement[] => item.all().filter((element) => element.tagName === 'A');

test('mr client: Create merge request… on a pushed job, confirmed with the title and the target; one POST; the outcome with the link', async () => {
  const page = await open([job('T-1', 'pushed')], '#app/T-1');
  assert.deepEqual([state(page, 'mr-create-button'), page.$('mr-merge-button').hidden, page.$('mr-status-button').hidden, page.$('mr-line').hidden], [[false, false], true, true, true]);
  assert.match(page.$('next-why').textContent, /^Create the merge request here \(feat\(T-1\): Demo\)/);
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

  // Opened: the link in the panel, Merge… and Refresh MR status instead of Create.
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 1, url: URL_1, state: 'open' } }));
  assert.equal(page.$('next-headline').textContent, 'Pushed T-1-demo; merge request #1 is open.');
  const link = links(page.$('mr-line'))[0]!;
  assert.deepEqual([page.$('mr-line').textContent, link.href, link.rel], [`Merge request #1 (open): ${URL_1}`, URL_1, 'noopener noreferrer']);
  assert.deepEqual([page.$('mr-create-button').hidden, state(page, 'mr-merge-button'), state(page, 'mr-status-button')], [true, [false, false], [false, false]]);
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
  assert.deepEqual([page.$('mr-status-line').hidden, page.$('mr-status-line').textContent], [false, said]);

  // Merged: no Create, no Merge; the headline says so.
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 4, url: URL_1, state: 'merged', merge_commit: 'c'.repeat(40) } }));
  assert.equal(page.$('next-headline').textContent, 'Merged merge request #4 into main.');
  assert.deepEqual([page.$('mr-create-button').hidden, page.$('mr-merge-button').hidden, page.$('mr-status-button').hidden], [true, true, false]);
});

test('mr client: the status line read before a merge never contradicts the merge request the job shows now', async () => {
  const opened = job('T-1', 'pushed', { mr: { host: 'github', number: 5, url: URL_1, state: 'open' } });
  const page = await open([opened], '#app/T-1');
  page.$('mr-status-button').click();
  await page.flush();
  posts(page, 'mr-status')[0]!.respond(200, { ok: true, result: { state: 'pushed', branch: 'T-1-demo', mr: opened.mr, status: { number: 5, url: URL_1, state: 'open', draft: false, mergeable: true, checks: '2 passed' } } });
  await page.flush();
  assert.deepEqual([page.$('mr-status-line').hidden, page.$('mr-status-line').textContent], [false, 'On the host: #5 open, mergeable, checks: 2 passed.']);
  // Merged (here, on the host or from another page): the job's update arrives; the open status goes.
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 5, url: URL_1, state: 'merged' } }));
  assert.equal(page.$('mr-line').textContent, `Merge request #5 (merged): ${URL_1}`);
  assert.deepEqual([page.$('mr-status-line').hidden, page.$('mr-status-line').textContent], [true, '']);
  // A later job update with the same merged state does not bring the old line back.
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 5, url: URL_1, state: 'merged' } }));
  assert.equal(page.$('mr-status-line').hidden, true);
  // A new merge request (another number) never shows the old one's status either.
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 6, url: URL_1, state: 'open' } }));
  assert.equal(page.$('mr-status-line').hidden, true);

  // A status that sees the merge before the job's update does: hidden while the job says open,
  // shown once the update records the merge.
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 6, url: URL_1, state: 'open' } }));
  page.$('mr-status-button').click();
  await page.flush();
  posts(page, 'mr-status')[1]!.respond(200, { ok: true, result: { state: 'pushed', branch: 'T-1-demo', mr: { number: 6, state: 'merged' }, status: { number: 6, url: URL_1, state: 'merged', draft: false, mergeable: false, reason: 'it is merged' } } });
  await page.flush();
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 6, url: URL_1, state: 'open' } }));
  assert.equal(page.$('mr-status-line').hidden, true);
  await show(page, job('T-1', 'pushed', { mr: { host: 'github', number: 6, url: URL_1, state: 'merged' } }));
  assert.deepEqual([page.$('mr-status-line').hidden, page.$('mr-status-line').textContent], [false, 'On the host: #6 merged.']);
});

test('mr client: the actions off name the missing variable; from ready_for_human_review Create pushes first; a link that is not https stays text', async () => {
  const page = await open([job('T-1', 'pushed', { mr_host: { host: 'github', reason: 'SF_GITHUB_TOKEN is not set in the environment file' } })], '#app/T-1');
  assert.deepEqual(state(page, 'mr-create-button'), [false, true]);
  assert.match(page.$('action-reasons').textContent, /Create merge request: SF_GITHUB_TOKEN is not set in the environment file\./);
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

test('mr client: the board offers Create merge request… on Your turn and Done cards, Merge… and the link on a Done card; each opens its confirmation in the drawer', async () => {
  const jobs = [
    job('T-1', 'pushed', { mr: { host: 'github', number: 1, url: URL_1, state: 'open' } }),
    job('T-2', 'ready_for_human_review'),
    job('T-3', 'pushed', { mr_host: { host: null, reason: 'the origin URL of the checkout names no GitHub or GitLab repository' } }),
    job('T-4', 'pushed', { mr: { host: 'github', number: 9, url: URL_1, state: 'merged' } }),
  ];
  const page = await open(jobs, '');
  assert.deepEqual(cardButtons(card(page, 'app/T-1')), ['Merge…']);
  assert.deepEqual(links(card(page, 'app/T-1')).map((element) => element.href), [URL_1]);
  assert.deepEqual(cardButtons(card(page, 'app/T-2')), ['Approve…', 'Create merge request…']);
  const off = card(page, 'app/T-3').all().find((element) => element.tagName === 'BUTTON' && element.textContent === 'Create merge request…')!;
  assert.deepEqual([off.disabled, off.getAttribute('title')], [true, 'the origin URL of the checkout names no GitHub or GitLab repository.']);
  assert.deepEqual(cardButtons(card(page, 'app/T-4')), []);
  assert.match(card(page, 'app/T-4').textContent, /#9 merged/);

  card(page, 'app/T-1').all().find((element) => element.tagName === 'BUTTON' && element.textContent === 'Merge…')!.click();
  await page.flush();
  page.streams.at(-1)!.emit('job', detail(jobs[0]!));
  await page.flush();
  assert.deepEqual([page.$('confirm').hidden, page.$('confirm-ok').textContent], [false, 'Merge #1 into main']);
});
