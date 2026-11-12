// The planned ticket page in static/ticket-page.js (SF-081), run under node:vm against the fake page of
// test/support/fake-dom.ts: the header and its line per dependency state, each card's plain label
// and help line, the lock of a may_touch row, "No list", Waits for with ✓, the plan check in
// words with the findings' kinds, Edit | Preview with the Markdown preview (DOM nodes, only http(s)
// links), Save with the version read and the conflict's Reload, Ctrl+S, Start with its confirmation
// and the move to the job, the history, the hash and Escape, a ticket that is gone, and no inline
// style or prototype-only part; the Images card (SF-064): thumbnails, paste, drop, × and Copy image. Script checks, not browser acceptance: the manual steps are in
// factory/README.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANVAS_PNG, type FakeClipboard, type FakeClipboardItem, type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
process.env.TZ = 'Europe/Sofia';
const SHA = 'a'.repeat(64);
const URL_PREFIX = 'https://chatgpt.com/?q=';

const summary = (extra: Record<string, unknown> = {}) => ({ state: 'none', check_reason: null, stale: false, running: false, blockers: 0, majors: 0, nits: 0, ended_at: null, start_note: 'not checked', ...extra });

function ticket(name: string, extra: Record<string, unknown> = {}) {
  return {
    workspace: 'app', ticket: name, title: `Ticket ${name}`, base: 'main', draft: false, request: null, owner: 'chatgpt', job: null, lands_after: [],
    conversation: { message: `Plan ${name}.`, url: `${URL_PREFIX}${encodeURIComponent(`Plan ${name}.`)}` }, check: summary(), ...extra,
  };
}

const TEXT = '---\nticket: T-1\ntitle: Ticket T-1\nbase: feature/x\nscope: [src/**, package.json]\nmay_touch: [package.json]\n---\n\n# T-1: Ticket T-1\n\nDo **it**.\n';

function payload(row: ReturnType<typeof ticket>, extra: Record<string, unknown> = {}) {
  return {
    ticket: row, task: { text: TEXT, sha256: SHA },
    plan: { starts_from: 'feature/x', files: [{ path: 'src/**', sensitive: false }, { path: 'package.json', sensitive: true }], scoped: true, waits_for: [] },
    check: { check: null, stale: false, running: false, current_sha256: SHA },
    history: [
      { ts: '2026-11-05T10:00:00.000Z', kind: 'edited', by: 'you', text: 'Edited by you' },
      { ts: '2026-11-04T09:00:00.000Z', kind: 'written', by: 'context_owner', text: 'Plan written by the Context owner' },
      { ts: null, kind: 'note', by: null, text: 'Older steps were not recorded; they are known only from checks and jobs.' },
    ],
    queue: null, ...extra,
  };
}

function job(name: string, state: string) {
  return {
    workspace: 'app', ticket: name, branch: `${name}-x`, base: 'main', state, iteration: 0, mr_attempts: 0, updated_at: '2026-11-05T10:00:00.000Z', created_at: '2026-11-05T10:00:00.000Z',
    error: null, prepared_commit: null, worktree: `/wt/${name}`, fixes: 0, gate_fixes: 0, gate_tokens: 0, files: 0, undeclared: 0, deleted: 0, title: `Ticket ${name}`,
    cost_usd: null, review: null, review_ended_at: null, gate: null, now: null, tool_calls: 0, stop: null,
  };
}

// The board with the tickets, then the ticket's page opened by the hash and answered with data.
async function openTicketPage(rows: ReturnType<typeof ticket>[], data: unknown, jobs: unknown[] = [], clipboard?: FakeClipboard): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs } : undefined), clipboard);
  page.location.hash = `#app/${rows[0]!.ticket}/ticket`;
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs });
  stream.emit('workspaces', { workspaces: [{ name: 'app', path: '/srv/app', liveJobs: 0, problem: null, handoff: null, color: 'teal' }] });
  stream.emit('tickets', { tickets: rows, archived: [] });
  await page.flush();
  const read = page.requests.find((request) => request.path === `api/tickets/app/${rows[0]!.ticket}/page`)!;
  read.respond(200, data);
  await page.flush();
  return page;
}

const root = (page: Page): FakeElement => page.$('ticket');
const head = (page: Page): FakeElement => root(page).querySelector('header.jhead')!;
const cardOf = (page: Page, title: RegExp): FakeElement => root(page).querySelectorAll('.card2').find((box) => title.test(box.querySelector('h3')?.textContent ?? ''))!;
const action = (page: Page, name: string): FakeElement => root(page).querySelectorAll('button').find((node) => node.dataset.tk === name)!;
const posts = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'POST');
const hint = (box: FakeElement): string | undefined => box.children.find((child) => (child as FakeElement).className === 'hint')?.textContent;

test('ticket client: the header, Starts from, Files it will change with the lock, Waits for with each state in words, their help lines, and the history', async () => {
  const lands = [
    { workspace: 'app', ticket: 'T-2', state: 'merged' }, { workspace: 'app', ticket: 'T-3', state: 'pushed' }, { workspace: 'app', ticket: 'T-4', state: 'running' },
    { workspace: 'app', ticket: 'T-5', state: 'planned' }, { workspace: 'app', ticket: 'T-6', state: 'missing' }, { workspace: 'web', ticket: 'W-1', state: 'planned' },
  ];
  const row = ticket('T-1', { lands_after: lands });
  const waits = [
    { ticket: 'T-2', state: 'merged', merged: true }, { ticket: 'T-3', state: 'pushed', merged: false }, { ticket: 'T-4', state: 'running', merged: false },
    { ticket: 'T-5', state: 'planned', merged: false }, { ticket: 'T-6', state: 'missing', merged: false }, { ticket: 'web/W-1', state: 'planned', merged: false },
  ];
  const page = await openTicketPage([row], payload(row, { plan: { ...payload(row).plan, waits_for: waits } }));
  assert.deepEqual([root(page).hidden, page.$('board').hidden, page.$('drawer').hidden], [false, true, true]);
  // The header: ← Board (Esc), the key, the workspace, the title; the conversation, the check, Start now.
  assert.equal(head(page).children.length, 4);
  assert.equal(head(page).querySelector('.btn.back')!.textContent, '← Board Esc');
  assert.equal(head(page).querySelector('.t1')!.textContent, 'T-1appTicket T-1');
  assert.deepEqual(head(page).querySelector('.tools')!.children.map((child) => [(child as FakeElement).tagName, child.textContent, (child as FakeElement).className]), [
    ['A', 'Open the ChatGPT conversation ↗', 'btn linkbtn'], ['BUTTON', 'Check the plan', 'btn'], ['BUTTON', 'Start now', 'btn primary'],
  ]);
  // The line: what it waits for (not merged yet), where it starts, the plan check in words; no queue.
  assert.deepEqual(head(page).querySelector('.t2')!.children.map((child) => child.textContent), ['waits for T-3, T-4, T-5, T-6, web/W-1', 'Starts from feature/x', 'Plan not checked yet']);
  assert.doesNotMatch(root(page).textContent, /[Qq]ueue/);
  assert.equal(action(page, 'start').getAttribute('title'), 'Waits for T-3, T-4, T-5, T-6, web/W-1');

  const base = cardOf(page, /^Starts from$/);
  assert.equal(base.querySelector('.mono')!.textContent, 'feature/x');
  assert.equal(hint(base), 'The job\'s branch is created from this branch. A feature branch when this ticket needs work that is not merged yet.');
  const files = cardOf(page, /^Files it will change$/);
  assert.deepEqual(files.querySelectorAll('ul.flist li').map((item) => item.textContent), ['src/**', 'package.json🔒']);
  const lock = files.querySelector('.lock')!;
  assert.equal(lock.getAttribute('title'), 'Sensitive file, on the list on purpose');
  assert.match(hint(files)!, /^The files the job is expected to create, change or delete\. A change to a file outside this list needs your OK before it can ship\. 🔒 marks a sensitive file/);
  const waitsCard = cardOf(page, /^Waits for$/);
  assert.deepEqual(waitsCard.querySelectorAll('.dep').map((dep) => dep.children.map((child) => child.textContent)), [
    ['✓', 'T-2', 'merged'], ['◷', 'T-3', 'pushed, not merged yet'], ['◷', 'T-4', 'running'], ['◷', 'T-5', 'planned, not started'], ['◷', 'T-6', 'unknown ticket'], ['◷', 'web/W-1', 'planned, not started'],
  ]);
  assert.equal(hint(waitsCard), 'These tickets should be merged before this one starts; Start now still starts it.');
  // No raw front-matter name is a label.
  for (const raw of ['scope', 'may_touch', 'lands_after', 'Front matter', 'Lands after', 'Task check']) {
    assert.ok(!root(page).querySelectorAll('h3').some((h3) => h3.textContent.startsWith(raw)), raw);
  }
  const history = cardOf(page, /^History$/);
  assert.deepEqual(history.querySelectorAll('ul.hist li').map((item) => item.children[1]!.textContent), [
    'Edited by you', 'Plan written by the Context owner', 'Older steps were not recorded; they are known only from checks and jobs.',
  ]);
  assert.deepEqual(history.querySelectorAll('ul.hist li').map((item) => item.children[0]!.textContent), ['Nov 5, 12:00', 'Nov 4, 11:00', '']);
  assert.equal(hint(history), 'What happened to this plan.');
  // The Images card (SF-064) without images says so; no queue buttons (SF-071).
  assert.equal(cardOf(page, /^Images$/).querySelector('.muted')!.textContent, 'No image yet.');
  assert.ok(!root(page).querySelectorAll('button').some((node) => /queue/i.test(node.textContent)));
});

test('ticket client: without a scope "No list"; without a dependency "Nothing: it can start now"; a skeleton is a draft that cannot start or be checked; a plan written meanwhile shows at the next refresh', async () => {
  const row = ticket('T-1', { draft: true });
  const page = await openTicketPage([row], payload(row, { plan: { starts_from: 'main', files: [], scoped: false, waits_for: [] } }));
  assert.equal(head(page).querySelector('.t1 .tag')!.textContent, 'draft');
  assert.deepEqual([action(page, 'start').disabled, action(page, 'check').disabled], [true, true]);
  assert.match(action(page, 'start').getAttribute('title')!, /^Waiting for the plan/);
  assert.deepEqual(head(page).querySelector('.t2')!.children.map((child) => child.textContent), ['Starts from main', 'Plan not written yet']);
  const files = cardOf(page, /^Files it will change$/);
  assert.deepEqual([files.querySelector('ul'), files.textContent], [null, 'Files it will changeNo list: the job may change any file, and nothing is checked.']);
  assert.equal(cardOf(page, /^Waits for$/).textContent, 'Waits forNothing: it can start now.');
  action(page, 'start').click();
  action(page, 'check').click();
  await page.flush();
  assert.deepEqual([page.$('ticket-confirm').hidden, posts(page)], [true, []]);
  // The Context owner writes the plan meanwhile: the next tickets refresh reads the page again.
  page.streams.at(-1)!.emit('tickets', { tickets: [{ ...row, draft: false }], archived: [] });
  await page.flush();
  page.requests.filter((request) => request.path === 'api/tickets/app/T-1/page').at(-1)!.respond(200, payload({ ...row, draft: false }, {
    plan: { starts_from: 'main', files: [{ path: '.github/**', sensitive: true }], scoped: false, waits_for: [] },
  }));
  await page.flush();
  assert.equal(head(page).querySelector('.t1 .tag'), null);
  assert.equal(action(page, 'start').disabled, false);
  assert.match(cardOf(page, /^Task file/).querySelector('.md')!.textContent, /Do it\./);
  // Without a scope, a may_touch row's lock still says what it means.
  const sensitive = cardOf(page, /^Files it will change$/);
  assert.deepEqual([sensitive.querySelectorAll('ul.flist li').map((item) => item.textContent), hint(sensitive)], [
    ['.github/**🔒'], '🔒 marks a sensitive file (build, CI, packages, credentials) the ticket is allowed to change.',
  ]);
});

test('ticket client: Claude Code plans: no ChatGPT link, the first message with Copy under the paste line; ChatGPT: the link; Plan with posts the owner and redraws', async () => {
  const paste = 'Paste it into a Claude Code session that has the software-factory MCP server (see the planning guide)';
  const message = 'Use the software-factory MCP server. Call guide.';
  const row = ticket('T-1', { owner: 'claude_code', conversation: { message, url: null } });
  const page = await openTicketPage([row], payload(row));
  const conversation = (): FakeElement => cardOf(page, /^Planning conversation$/);
  const chatLinks = (): string[] => root(page).querySelectorAll('a').map((node) => node.href).filter((href) => href.startsWith(URL_PREFIX));
  // Claude Code: neither the header nor the card links to ChatGPT; the line says where to paste, as text.
  assert.deepEqual(chatLinks(), []);
  assert.deepEqual(head(page).querySelector('.tools')!.children.map((child) => child.textContent), ['Check the plan', 'Start now']);
  assert.equal(conversation().querySelectorAll('span.fs13').map((node) => node.textContent).join('|'), paste);
  assert.doesNotMatch(conversation().textContent, /too long for a link|ChatGPT conversation/);
  assert.equal(conversation().querySelectorAll('a').length, 0);
  assert.equal(conversation().querySelector('pre.cm')!.textContent, message);
  assert.equal(action(page, 'copy').textContent, 'Copy');
  // The switch: the owner in use is pressed and off, the other switches.
  assert.equal(conversation().querySelector('.tk-owner')!.textContent, 'Plan with:ChatGPT·Claude Code');
  assert.deepEqual([action(page, 'owner-claude_code').disabled, action(page, 'owner-claude_code').getAttribute('aria-pressed'), action(page, 'owner-chatgpt').disabled], [true, 'true', false]);
  action(page, 'owner-chatgpt').click();
  await page.flush();
  assert.deepEqual(posts(page).map((request) => [request.path, JSON.parse(request.body!)]), [['api/tickets/app/T-1/owner', { owner: 'chatgpt' }]]);
  assert.equal(action(page, 'owner-chatgpt').disabled, true);
  // The answer, the ticket's row with its ChatGPT conversation, is drawn at once: the link in the header and the card.
  const chat = ticket('T-1');
  posts(page)[0]!.respond(200, { ok: true, result: chat });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'ChatGPT plans app/T-1 now.');
  assert.deepEqual(chatLinks(), [chat.conversation.url, chat.conversation.url]);
  assert.doesNotMatch(conversation().textContent, /Paste it into a Claude Code session/);
  assert.deepEqual([action(page, 'owner-chatgpt').disabled, action(page, 'owner-claude_code').disabled], [true, false]);
  // A refusal says its code; the page stays as it was.
  action(page, 'owner-claude_code').click();
  await page.flush();
  posts(page)[1]!.respond(409, { ok: false, error: { code: 'job_active', message: 'The job for app/T-1 is working; abort it first.' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'job_active: The job for app/T-1 is working; abort it first.');
  assert.deepEqual(chatLinks(), [chat.conversation.url, chat.conversation.url]);
});

const VIEW = (output: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  stale: false, running: false, current_sha256: SHA,
  check: { workspace: 'app', ticket: 'T-1', sha256: SHA, status: output === null ? 'failed' : 'checked', error: output === null ? 'The session failed.' : null, model: 'claude-x', cost_usd: 0.48, started_at: '2026-11-05T08:00:00.000Z', ended_at: '2026-11-05T08:03:00.000Z', output },
  ...extra,
});
const FINDINGS = ['decision', 'contradiction', 'missing', 'overreach', 'unclear'].map((kind, index) => ({ kind, severity: index < 2 ? 'blocker' : index === 2 ? 'major' : 'nit', where: `w${index}`, problem: `p${index}`, expected: `e${index}` }));

test('ticket client: the plan check in words: not checked, checking, ready, not ready with each kind in words, stale, failed; Check the plan posts today\'s route', async () => {
  const row = ticket('T-1');
  const states: Array<[unknown, string, string[], string]> = [
    [{ check: null, stale: false, running: false, current_sha256: SHA }, 'Plan check not checked', ['Not checked yet.'], 'Check the plan'],
    [{ check: null, stale: false, running: true, current_sha256: SHA }, 'Plan check not checked', ['Checking… a read-only session reads the plan and the code.'], 'Checking…'],
    [VIEW({ paraphrase: 'p', verdict: 'ready', files: [], findings: [] }), 'Plan check ready', ['Ready: an Implementer can build this plan without a design decision of its own.'], 'Check again'],
    [VIEW({ paraphrase: 'p', verdict: 'not_ready', files: [], findings: FINDINGS }), 'Plan check not ready', ['Not ready: 2 blockers, 1 major.'], 'Check again'],
    [VIEW({ paraphrase: 'p', verdict: 'ready', files: [], findings: [] }, { stale: true }), 'Plan check readystale', ['The plan changed after this check: check it again.', 'Ready: an Implementer can build this plan without a design decision of its own.'], 'Check again'],
    [VIEW(null), 'Plan check failed', ['The check failed: The session failed.'], 'Check again'],
  ];
  for (const [view, title, lines, label] of states) {
    const page = await openTicketPage([row], payload(row, { check: view }));
    const box = cardOf(page, /^Plan check/);
    assert.equal(box.querySelector('h3')!.textContent, title);
    assert.deepEqual(box.querySelectorAll('p').map((node) => node.textContent), lines, title);
    assert.equal(action(page, 'check').textContent, label);
    assert.equal(hint(box), 'A read-only Claude session reads only this plan and the code, and says whether an Implementer could build it without making a design decision of its own. About $0.50. It only advises.');
  }
  const page = await openTicketPage([row], payload(row, { check: VIEW({ paraphrase: 'Long paraphrase.', verdict: 'not_ready', files: [{ path: 'a.ts', action: 'create' }, { path: 'b.ts', action: 'delete' }], findings: FINDINGS }) }));
  const box = cardOf(page, /^Plan check/);
  assert.deepEqual(box.querySelectorAll('li.finding').map((item) => item.children.slice(0, 3).map((child) => child.textContent)), [
    ['#1', 'blocker', 'needs a decision'], ['#2', 'blocker', 'contradicts itself'], ['#3', 'major', 'something is missing'], ['#4', 'nit', 'does more than asked'], ['#5', 'nit', 'unclear'],
  ]);
  assert.equal(box.querySelector('li.finding .expected')!.textContent, 'Expected: e0');
  assert.equal(box.querySelector('.sev')!.className, 'sev sev-blocker');
  // What the checker understood: clamped, Show all opens it whole.
  assert.equal(box.querySelector('.para')!.className, 'prose para clamped');
  action(page, 'para').click();
  assert.deepEqual([cardOf(page, /^Plan check/).querySelector('.para')!.className, action(page, 'para').textContent], ['prose para', 'Show less']);
  assert.deepEqual(cardOf(page, /^Plan check/).querySelectorAll('.chipx').map((chip) => chip.textContent), ['+ a.ts', '− b.ts']);
  assert.match(cardOf(page, /^Plan check/).textContent, /Nov 5, 10:03 · claude-x · \$0\.48/);
  // Check again: today's route, once; Checking… until the check's end comes with the stream.
  action(page, 'check').click();
  await page.flush();
  assert.deepEqual(posts(page).map((request) => [request.path, request.body]), [['api/tickets/app/T-1/check', '{}']]);
  assert.deepEqual([action(page, 'check').textContent, action(page, 'check').disabled], ['Checking…', true]);
  action(page, 'check').click();
  await page.flush();
  assert.equal(posts(page).length, 1);
});

test('ticket client (SF-130): a Task that needs no check: the header line and the card say why; the card shows the rounds and their cost, "at least" with an unknown cost, "no rounds yet" without one', async () => {
  const reason = 'small: 2 scope entries, 310 words';
  const row = ticket('T-1', { check: summary({ state: 'not_needed', check_reason: reason, start_note: null }) });
  const page = await openTicketPage([row], payload(row, { check: { check: null, stale: false, running: false, current_sha256: SHA, check_reason: reason }, check_rounds: 0, check_usd: 0, check_usd_complete: true }));
  assert.equal(head(page).querySelector('.t2')!.children.at(-1)!.textContent, `Plan check not needed: ${reason}`);
  const box = cardOf(page, /^Plan check/);
  assert.equal(box.querySelector('h3')!.textContent, 'Plan check not needed');
  assert.deepEqual(box.querySelectorAll('p').map((node) => node.textContent), [`Not needed: ${reason}. It starts from the queue without a check; Check the plan runs one anyway.`]);
  assert.equal(box.querySelector('.tk-rounds')!.textContent, 'no rounds yet');
  assert.equal(root(page).textContent.includes('not checked'), false);
  assert.equal(root(page).textContent.includes('Not checked'), false);
  // An earlier version was checked twice, one cost unknown: still not needed for this version.
  const stale = await openTicketPage([row], payload(row, { check: VIEW({ paraphrase: 'p', verdict: 'ready', files: [], findings: [] }, { stale: true, check_reason: reason }), check_rounds: 2, check_usd: 0.75, check_usd_complete: false }));
  assert.equal(cardOf(stale, /^Plan check/).querySelector('h3')!.textContent, 'Plan check not needed');
  assert.equal(cardOf(stale, /^Plan check/).querySelector('.tk-rounds')!.textContent, '2 rounds · at least $0.75');
  // A checked ticket: the rounds under the result.
  const checked = ticket('T-1', { check: summary({ state: 'ready', start_note: null }) });
  const ready = await openTicketPage([checked], payload(checked, { check: VIEW({ paraphrase: 'p', verdict: 'ready', files: [], findings: [] }), check_rounds: 3, check_usd: 1.25, check_usd_complete: true }));
  assert.equal(cardOf(ready, /^Plan check/).querySelector('.tk-rounds')!.textContent, '3 rounds · $1.25');
  // Not checked yet and needed: no rounds yet.
  const fresh = await openTicketPage([ticket('T-1')], payload(ticket('T-1'), { check_rounds: 0, check_usd: 0, check_usd_complete: true }));
  assert.equal(cardOf(fresh, /^Plan check/).querySelector('.tk-rounds')!.textContent, 'no rounds yet');
});

test('ticket client: Preview renders the body without the front matter as DOM nodes, only http(s) links; Edit has the whole file; Save posts the text and the version read, then reads the page again', async () => {
  const row = ticket('T-1');
  const text = '---\nticket: T-1\ntitle: Ticket T-1\nbase: main\n---\n\n# T-1: <b>One</b>\n\n<script>alert(1)</script>\n\n- [x] done\n- **bold** and `code` and [ok](https://example.com/a) and [bad](javascript:alert(1))\n\n```\n<img src=x onerror=alert(2)>\n```\n';
  const page = await openTicketPage([row], payload(row, { task: { text, sha256: SHA } }));
  const file = cardOf(page, /^Task file/);
  assert.equal(file.querySelector('h3')!.textContent, 'Task file .software-factory/T-1.md');
  assert.deepEqual(file.querySelectorAll('.edtabs button').map((node) => [node.textContent, node.className]), [['Edit', ''], ['Preview', 'on'], ['Save', 'btn small']]);
  assert.equal(action(page, 'save').disabled, true);
  const preview = file.querySelector('.md')!;
  assert.doesNotMatch(preview.textContent, /ticket: T-1/);
  assert.equal(preview.querySelector('h1')!.textContent, 'T-1: <b>One</b>');
  assert.equal(preview.all().some((node) => ['SCRIPT', 'IMG'].includes(node.tagName)), false);
  assert.match(preview.textContent, /<script>alert\(1\)<\/script>/);
  assert.equal(preview.querySelector('pre code')!.textContent, '<img src=x onerror=alert(2)>');
  assert.deepEqual(preview.querySelectorAll('a').map((link) => [link.textContent, link.href, link.target, link.rel]), [['ok', 'https://example.com/a', '_blank', 'noopener noreferrer']]);
  assert.deepEqual([preview.querySelector('li.task input')!.checked, preview.querySelector('b')!.textContent, preview.querySelector('code')!.textContent], [true, 'bold', 'code']);

  // Edit: the whole file in textarea#tkText.mdedit; typing marks it unsaved and turns Save on.
  root(page).querySelectorAll('.edtabs button').find((node) => node.textContent === 'Edit')!.click();
  const box = page.$('tkText');
  assert.deepEqual([box.tagName, box.className, box.value, page.document.activeElement], ['TEXTAREA', 'mdedit fld', text, box]);
  box.value = `${text}More.\n`;
  box.dispatch('input');
  assert.match(cardOf(page, /^Task file/).querySelector('.edtabs')!.textContent, /Unsaved changes/);
  assert.equal(action(page, 'save').disabled, false);
  // Ctrl+S in the editor saves: the text and the sha256 of the version read.
  page.key('s', { ctrlKey: true });
  await page.flush();
  const save = posts(page)[0]!;
  assert.deepEqual([save.path, JSON.parse(save.body!)], ['api/tickets/app/T-1/task', { content: `${text}More.\n`, sha256: SHA }]);
  assert.deepEqual([action(page, 'save').textContent, action(page, 'save').disabled], ['Saving…', true]);
  save.respond(200, { ok: true, result: { path: '.software-factory/T-1.md', status: 'replaced', bytes: 1, sha256: 'b'.repeat(64) } });
  await page.flush();
  assert.match(page.$('toast-text').textContent, /^Saved \.software-factory\/T-1\.md\.$/);
  assert.equal(cardOf(page, /^Task file/).querySelector('.edited')!.textContent, 'edited by you');
  assert.doesNotMatch(cardOf(page, /^Task file/).textContent, /Unsaved changes/);
  // The page is read again (the history and the check); a next save starts from the saved version.
  const again = page.requests.filter((request) => request.path === 'api/tickets/app/T-1/page');
  assert.equal(again.length, 2);
  again[1]!.respond(200, payload(row, { task: { text: `${text}More.\n`, sha256: 'b'.repeat(64) } }));
  await page.flush();
  box.value = `${text}More.\nAnd more.\n`;
  box.dispatch('input');
  action(page, 'save').click();
  await page.flush();
  assert.equal(JSON.parse(posts(page)[1]!.body!).sha256, 'b'.repeat(64));
});

test('ticket client: a Save refused with task_changed keeps the text and offers Reload, which loads the file as it is; other refusals say their code', async () => {
  const row = ticket('T-1');
  const page = await openTicketPage([row], payload(row));
  root(page).querySelectorAll('.edtabs button').find((node) => node.textContent === 'Edit')!.click();
  page.$('tkText').value = `${TEXT}Mine.\n`;
  page.$('tkText').dispatch('input');
  action(page, 'save').click();
  await page.flush();
  posts(page)[0]!.respond(409, { ok: false, error: { code: 'task_changed', message: 'changed' } });
  await page.flush();
  assert.match(page.$('toast-text').textContent, /^Not saved: the Task file changed since this page read it\./);
  assert.match(cardOf(page, /^Task file/).querySelector('.notline')!.textContent, /^Not saved: the Task file changed since this page read it/);
  assert.equal(page.$('tkText').value, `${TEXT}Mine.\n`);
  action(page, 'reload').click();
  await page.flush();
  const reads = page.requests.filter((request) => request.path === 'api/tickets/app/T-1/page');
  reads.at(-1)!.respond(200, payload(row, { task: { text: `${TEXT}Theirs.\n`, sha256: 'c'.repeat(64) } }));
  await page.flush();
  assert.equal(page.$('tkText').value, `${TEXT}Theirs.\n`);
  assert.equal(cardOf(page, /^Task file/).querySelector('.notline'), null);
  assert.equal(action(page, 'save').disabled, true);
  page.$('tkText').value = `${TEXT}Theirs.\nMine again.\n`;
  page.$('tkText').dispatch('input');
  action(page, 'save').click();
  await page.flush();
  assert.equal(JSON.parse(posts(page)[1]!.body!).sha256, 'c'.repeat(64));
  posts(page)[1]!.respond(409, { ok: false, error: { code: 'job_active', message: 'The job for app/T-1 is working.' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'job_active: The job for app/T-1 is working.');
  assert.equal(cardOf(page, /^Task file/).querySelector('.notline'), null);
});

test('ticket client: Start now asks with today\'s confirmation, the check\'s note and the dependencies not merged; on success the page goes to the new job\'s Stream', async () => {
  const confirmText = async (waits: unknown[]): Promise<string> => {
    const row = ticket('T-1', { check: summary({ state: 'not_ready', blockers: 2, majors: 1, start_note: 'not ready: 2 blocker, 1 major' }) });
    const page = await openTicketPage([row], payload(row, { plan: { ...payload(row).plan, waits_for: waits } }));
    action(page, 'start').click();
    assert.deepEqual([page.$('ticket-confirm').hidden, page.$('ticket-confirm-title').textContent, page.$('ticket-ok').textContent], [false, 'Start T-1 in app?', 'Start the job']);
    // Start stays on whatever it waits for.
    assert.equal(posts(page).length, 0);
    return page.$('ticket-confirm-text').textContent;
  };
  assert.match(await confirmText([]), /^Starts a job on \.software-factory\/T-1\.md of workspace app: a new branch from main .* Task check: not ready: 2 blocker, 1 major\.$/);
  assert.match(await confirmText([{ ticket: 'T-0', state: 'merged', merged: true }]), /Task check: not ready: 2 blocker, 1 major\.$/);
  assert.match(await confirmText([{ ticket: 'SF-071', state: 'running', merged: false }, { ticket: 'SF-072', state: 'planned', merged: false }, { ticket: 'T-0', state: 'merged', merged: true }]),
    /Task check: not ready: 2 blocker, 1 major\. Waits for SF-071 \(running\), SF-072 \(planned, not started\): they are not merged yet\.$/);
  assert.match(await confirmText([{ ticket: 'web/W-1', state: 'pushed', merged: false }]), / Waits for web\/W-1 \(pushed, not merged yet\): it is not merged yet\.$/);

  // Confirmed: today's Start route; the job comes with the stream and the page moves to its Stream.
  const row = ticket('T-1');
  const page = await openTicketPage([row], payload(row), [job('T-1', 'failed')]);
  action(page, 'start').click();
  page.$('ticket-ok').click();
  await page.flush();
  assert.deepEqual(posts(page).map((request) => [request.path, request.body]), [['api/tickets/app/T-1/start', '{}']]);
  // The stream's jobs and tickets may come before the answer: the page waits for the new job.
  const stream = page.streams.at(-1)!;
  stream.emit('jobs', { jobs: [job('T-1', 'working')] });
  stream.emit('tickets', { tickets: [], archived: [] });
  await page.flush();
  assert.deepEqual([page.$('job').hidden, page.$('ticket').hidden, page.location.hash], [false, true, '#app/T-1']);
  posts(page)[0]!.respond(200, { ok: true, result: { branch: 'T-1-x', state: 'working' } });
  await page.flush();
  assert.equal(page.location.hash, '#app/T-1');

  // The answer first, then the job: the same move; a refusal stays on the page.
  const other = await openTicketPage([row], payload(row), [job('T-1', 'aborted')]);
  action(other, 'start').click();
  other.$('ticket-ok').click();
  await other.flush();
  posts(other)[0]!.respond(200, { ok: true, result: { branch: 'T-1-x', state: 'starting' } });
  await other.flush();
  // The old aborted job is not the new one.
  assert.equal(other.location.hash, '#app/T-1/ticket');
  other.streams.at(-1)!.emit('jobs', { jobs: [job('T-1', 'starting')] });
  await other.flush();
  assert.equal(other.location.hash, '#app/T-1');
  const refused = await openTicketPage([row], payload(row));
  action(refused, 'start').click();
  refused.$('ticket-ok').click();
  await refused.flush();
  posts(refused)[0]!.respond(409, { ok: false, error: { code: 'branch_exists', message: 'The branch T-1-one already exists.' } });
  await refused.flush();
  assert.deepEqual([refused.location.hash, refused.$('toast-text').textContent], ['#app/T-1/ticket', 'branch_exists: The branch T-1-one already exists.']);
});

test('ticket client: #ws/T/ticket opens the page and Escape goes back to the board; a ticket gone from the Queue or a 404 goes back too', async () => {
  const row = ticket('T-1');
  const page = await openTicketPage([row, ticket('T-2')], payload(row));
  assert.equal(page.location.hash, '#app/T-1/ticket');
  page.key('Escape');
  assert.deepEqual([root(page).hidden, page.$('board').hidden, page.location.hash], [true, false, '#']);
  // Escape in the editor leaves the editor first, then the page.
  page.location.hash = '#app/T-1/ticket';
  page.window.dispatch('hashchange');
  await page.flush();
  page.requests.filter((request) => request.path === 'api/tickets/app/T-1/page').at(-1)!.respond(200, payload(row));
  await page.flush();
  root(page).querySelectorAll('.edtabs button').find((node) => node.textContent === 'Edit')!.click();
  page.key('Escape');
  assert.equal(root(page).hidden, false);
  page.key('Escape');
  assert.equal(root(page).hidden, true);
  // Archived elsewhere: the next tickets event goes back to the board.
  page.location.hash = '#app/T-1/ticket';
  page.window.dispatch('hashchange');
  await page.flush();
  page.requests.filter((request) => request.path === 'api/tickets/app/T-1/page').at(-1)!.respond(200, payload(row));
  await page.flush();
  page.streams.at(-1)!.emit('tickets', { tickets: [ticket('T-2')], archived: [] });
  await page.flush();
  assert.deepEqual([root(page).hidden, page.location.hash], [true, '#']);
  // The page route answers 404: back to the board, with a word.
  page.location.hash = '#app/T-2/ticket';
  page.window.dispatch('hashchange');
  await page.flush();
  page.requests.filter((request) => request.path === 'api/tickets/app/T-2/page').at(-1)!.respond(404, '');
  await page.flush();
  assert.deepEqual([root(page).hidden, page.location.hash, page.$('toast-text').textContent], [true, '#', 'app/T-2 is not a planned ticket any more.']);
});

test('ticket client: no element of the page has an inline style, no prototype-only part exists, and values go in as text', async () => {
  const row = ticket('T-1', { title: '<img src=x onerror=alert(1)>' });
  const page = await openTicketPage([row], payload(row, { check: VIEW({ paraphrase: '<b>p</b>', verdict: 'not_ready', files: [], findings: [{ kind: 'unclear', severity: 'major', where: '<i>w</i>', problem: '<script>x</script>', expected: 'e' }] }) }));
  const elements = root(page).all();
  assert.equal(elements.some((node) => node.hasAttribute('style')), false);
  assert.equal(elements.some((node) => ['SCRIPT', 'IMG', 'IFRAME'].includes(node.tagName)), false);
  assert.match(head(page).querySelector('.title')!.textContent, /^<img src=x onerror=alert\(1\)>$/);
  assert.doesNotMatch(root(page).textContent, /\(prototype\)|[Ss]imulated|PROTOTYPE/);
  assert.equal(elements.some((node) => node.classList.contains('simtag')), false);
  // The prototype's file picker of the Images card is left out (SF-064: paste and drop only).
  assert.equal(elements.some((node) => node.tagName === 'INPUT' && node.type === 'file'), false);
  assert.doesNotMatch(root(page).textContent, /choose a file|stays on this page only/);
});

// The Images card (SF-064).
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7]);
const IMAGES = [{ name: '1.png', bytes: PNG.length, type: 'image/png' }, { name: '2.jpg', bytes: JPEG.length, type: 'image/jpeg' }];
const imagesCard = (page: Page): FakeElement => cardOf(page, /^Images$/);
const imageButton = (page: Page, label: string, name: string): FakeElement => imagesCard(page).querySelectorAll('button').find((node) => node.dataset.name === name && (node.textContent === label || node.getAttribute('aria-label') === `${label} ${name}`))!;

test('ticket client: the Images card shows each image to open whole, takes pasted and dropped files one upload each, keeps text paste, and removes with ×', async () => {
  const row = ticket('T-1', { attachments: IMAGES });
  const page = await openTicketPage([row], payload(row));
  const card = imagesCard(page);
  const figures = card.querySelectorAll('figure.thumb');
  assert.deepEqual(figures.map((figure) => {
    const link = figure.querySelector('a')!;
    const img = link.querySelector('img')!;
    return [link.href, link.target, link.rel, img.src, img.alt, figure.querySelector('.mono')!.textContent];
  }), [
    ['api/tickets/app/T-1/attachments/1.png', '_blank', 'noopener noreferrer', 'api/tickets/app/T-1/attachments/1.png', 'Image 1.png', '1.png'],
    ['api/tickets/app/T-1/attachments/2.jpg', '_blank', 'noopener noreferrer', 'api/tickets/app/T-1/attachments/2.jpg', 'Image 2.jpg', '2.jpg'],
  ]);
  assert.equal(page.$('tkDrop').textContent, 'Paste an image here (Ctrl+V) or drop one.');
  assert.match(hint(card)!, /at most 5 MB each and 10 per ticket\. .*read_attachment.*!\[what it shows\]\(T-1\/<name>\)/);

  // A text paste into the Task file editor goes on as usual.
  root(page).querySelectorAll('button').find((node) => node.dataset.tktab === 'edit')!.click();
  const editor = root(page).querySelector('textarea')!;
  assert.ok(editor !== null);
  const text = editor.dispatch('paste', { clipboardData: { files: [], types: ['text/plain'] } });
  await page.flush();
  assert.equal(text.defaultPrevented, false);
  // Cells copied from a spreadsheet (text and a picture of them) pasted into the editor stay text.
  const cells = editor.dispatch('paste', { clipboardData: { files: [new File([PNG], 'cells.png')], types: ['text/plain', 'Files'] } });
  await page.flush();
  assert.equal(cells.defaultPrevented, false);
  assert.equal(posts(page).length, 0);

  // A pasted image anywhere on the page: uploaded at once, without a name, as raw bytes.
  const pasted = editor.dispatch('paste', { clipboardData: { files: [new File([PNG], 'image.png', { type: 'image/png' })], types: ['Files'] } });
  assert.equal(pasted.defaultPrevented, true);
  await page.flush();
  assert.equal(page.$('tkDrop').textContent, 'Attaching 1 image…');
  const upload = posts(page)[0]!;
  assert.deepEqual([upload.path, upload.headers['content-type'], upload.body], ['api/tickets/app/T-1/attachments', 'application/octet-stream', undefined]);
  assert.deepEqual(new Uint8Array(await upload.blob!.arrayBuffer()), PNG);
  upload.respond(200, { ok: true, result: { name: '3.png', bytes: PNG.length, type: 'image/png' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'Attached 3.png.');
  assert.equal(page.$('tkDrop').textContent, 'Paste an image here (Ctrl+V) or drop one.');
  // The stream brings the new image to the card.
  page.streams.at(-1)!.emit('tickets', { tickets: [{ ...row, attachments: [...IMAGES, { name: '3.png', bytes: PNG.length, type: 'image/png' }] }], archived: [] });
  await page.flush();
  assert.deepEqual(imagesCard(page).querySelectorAll('figure .mono').map((node) => node.textContent), ['1.png', '2.jpg', '3.png']);

  // A drop of two files on the area: one upload each, in order; a refusal is said with its reason.
  const over = page.$('tkDrop').dispatch('dragover', { dataTransfer: { files: [], types: ['Files'] } });
  assert.deepEqual([over.defaultPrevented, page.$('tkDrop').classList.contains('over')], [true, true]);
  const dropped = page.$('tkDrop').dispatch('drop', { dataTransfer: { files: [new File([JPEG], 'a.jpg'), new File(['text'], 'notes.png')], types: ['Files'] } });
  assert.equal(dropped.defaultPrevented, true);
  await page.flush();
  posts(page)[1]!.respond(200, { ok: true, result: { name: '4.jpg', bytes: JPEG.length, type: 'image/jpeg' } });
  await page.flush();
  assert.equal(posts(page)[2]!.path, 'api/tickets/app/T-1/attachments');
  posts(page)[2]!.respond(400, { ok: false, error: { code: 'attachment_type', message: 'Only PNG, JPEG, WebP and GIF images can be attached.' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'Attached 4.jpg. Not attached: notes.png (attachment_type: Only PNG, JPEG, WebP and GIF images can be attached.).');

  // ×: POST .../attachments/<name>/remove with {}.
  imageButton(page, 'Remove', '1.png').click();
  await page.flush();
  assert.deepEqual([posts(page)[3]!.path, JSON.parse(posts(page)[3]!.body!)], ['api/tickets/app/T-1/attachments/1.png/remove', {}]);
  assert.equal(imageButton(page, 'Remove', '1.png').disabled, true);
  posts(page)[3]!.respond(200, { ok: true, result: { name: '1.png' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'Removed 1.png.');
  imageButton(page, 'Remove', '2.jpg').click();
  await page.flush();
  posts(page)[4]!.respond(409, { ok: false, error: { code: 'job_active', message: 'The job for app/T-1 is working; its images cannot be changed now.' } });
  await page.flush();
  assert.equal(page.$('toast-text').textContent, 'job_active: The job for app/T-1 is working; its images cannot be changed now.');
  // No file picker anywhere on the card.
  assert.equal(imagesCard(page).all().some((node) => node.tagName === 'INPUT'), false);
});

test('ticket client: Copy image puts a PNG on the clipboard as it is, draws JPEG on a canvas as PNG, and says so without a clipboard for images', async () => {
  const written: FakeClipboardItem[][] = [];
  const clipboard: FakeClipboard = { writeText: async () => undefined, write: async (items) => void written.push(items) };
  const row = ticket('T-1', { attachments: IMAGES });
  const page = await openTicketPage([row], payload(row), [], clipboard);
  const pngBlob = new Blob([PNG], { type: 'image/png' });
  imageButton(page, 'Copy image', '1.png').click();
  await page.flush();
  page.requests.find((request) => request.path === 'api/tickets/app/T-1/attachments/1.png')!.respond(200, pngBlob);
  await page.flush();
  assert.deepEqual([...written[0]!].map((item) => item.types), [['image/png']]);
  assert.equal(await written[0]![0]!.getType('image/png'), pngBlob);
  assert.equal(imagesCard(page).querySelector('[role=status]')!.textContent, 'Copied 1.png.');

  imageButton(page, 'Copy image', '2.jpg').click();
  await page.flush();
  page.requests.find((request) => request.path === 'api/tickets/app/T-1/attachments/2.jpg')!.respond(200, new Blob([JPEG], { type: 'image/jpeg' }));
  await page.flush();
  const drawn = await written[1]![0]!.getType('image/png');
  assert.equal(drawn.type, 'image/png');
  const bytes = Buffer.from(await drawn.arrayBuffer());
  assert.deepEqual([bytes.subarray(0, CANVAS_PNG.length), bytes.subarray(CANVAS_PNG.length).toString()], [CANVAS_PNG, '4x3:1']);
  assert.equal(imagesCard(page).querySelector('[role=status]')!.textContent, 'Copied 2.jpg.');

  // A browser without clipboard.write: the card says to open the image and copy it there.
  const plain = await openTicketPage([row], payload(row));
  imageButton(plain, 'Copy image', '1.png').click();
  await plain.flush();
  assert.equal(imagesCard(plain).querySelector('[role=status]')!.textContent, 'This browser cannot put an image on the clipboard: open 1.png and copy it there.');
  assert.equal(plain.requests.some((request) => request.path.includes('/attachments/')), false);
});

test('ticket client (SF-140): a tickets event naming another ticket fetches nothing but updates the row; one naming the open ticket, or without changed, reads it again once', async () => {
  const row = ticket('T-1');
  const page = await openTicketPage([row, ticket('T-2')], payload(row));
  const reads = (): string[] => page.requests.filter((request) => request.method === 'GET' && request.path.startsWith('api/tickets/app/T-1/')).map((request) => request.path);
  const answer = async (): Promise<void> => {
    page.requests.filter((request) => request.path === 'api/tickets/app/T-1/page').at(-1)!.respond(200, payload(row));
    await page.flush();
  };
  const before = reads().length;
  const emit = async (title: string, changed?: unknown[]): Promise<void> => {
    page.streams.at(-1)!.emit('tickets', { tickets: [{ ...row, title }, ticket('T-2')], archived: [], ...(changed === undefined ? {} : { changed }) });
    await page.flush();
  };
  await emit('Renamed', [{ workspace: 'app', ticket: 'T-2' }, { workspace: 'web', ticket: 'T-1' }]);
  assert.deepEqual(reads().slice(before), []);
  assert.match(head(page).querySelector('.t1')!.textContent, /Renamed/);

  await emit('Named', [{ workspace: 'app', ticket: 'T-2' }, { workspace: 'app', ticket: 'T-1' }]);
  assert.deepEqual(reads().slice(before).sort(), ['api/tickets/app/T-1/check', 'api/tickets/app/T-1/page']);
  assert.match(head(page).querySelector('.t1')!.textContent, /Named/);
  await answer();

  await emit('Everything');
  assert.deepEqual(reads().slice(before).sort(), ['api/tickets/app/T-1/check', 'api/tickets/app/T-1/check', 'api/tickets/app/T-1/page', 'api/tickets/app/T-1/page']);
});
