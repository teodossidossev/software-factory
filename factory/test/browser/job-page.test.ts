// The job page in a real browser (SF-091): the Stream, the Changes screen with its tree's keys, the
// Merge request screen, and the page's own keys.
import assert from 'node:assert/strict';
import { resultConversation } from '../../src/conversation.js';
import { browserTest, eventually, type Fixture, FILES, JOBS, MR_BODY, MR_TITLE, WS } from './support.js';

// The Stream as the user reads it: each line's kind and its text, without the time.
const streamLines = (fx: Fixture): Promise<string[]> => fx.page.locator('#stream > li').evaluateAll((items) => items.map((item) => {
  if (item.classList.contains('sep')) {
    return `sep: ${item.textContent}`;
  }
  const kind = [...item.classList].find((name) => name.startsWith('e-'))?.slice(2) ?? '?';
  return `${kind}: ${(item.querySelector('.body') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? ''}`;
}));
// The rows of the Changes tree: the name of each, the folder's ▾ or ▸ before it.
const treeRows = (fx: Fixture): Promise<string[]> => fx.page.locator('#tlist .trow').evaluateAll((rows) => rows.map((row) =>
  `${row.querySelector('.tw')?.textContent ?? ''}${row.querySelector('.nm')?.textContent ?? ''}`));
const focusedRow = (fx: Fixture): Promise<string | null> => fx.page.evaluate(() => {
  const active = document.activeElement;
  return active?.classList.contains('trow') === true ? `${active.querySelector('.tw')?.textContent ?? ''}${active.querySelector('.nm')?.textContent ?? ''}` : null;
});
const selectedRow = (fx: Fixture): Promise<string[]> => fx.page.locator('#tlist .trow.sel .nm').allTextContents();
const shownPath = (fx: Fixture): Promise<string> => fx.page.locator('#dtool .dpath').innerText();
const activeId = (fx: Fixture): Promise<string> => fx.page.evaluate(() => document.activeElement?.id ?? '');

// The Changes screen of the ready job, its tree drawn: src/ (a.ts) and README.md, README.md selected.
async function openChanges(fx: Fixture): Promise<void> {
  await fx.open(`${WS}/${JOBS.ready}/changes`);
  await eventually(() => treeRows(fx), ['▾src', 'a.ts', 'README.md']);
  await eventually(() => selectedRow(fx), ['README.md']);
  await fx.page.locator('#tlist .trow.sel').focus();
}

browserTest('job page: the Stream shows its entries in order, a tool call joined with its result, and new lines as they are appended', async (fx) => {
  await fx.open(`${WS}/${JOBS.working}`);
  // Each line of the Stream (the state lines aside) by its kind and the text it shows.
  const shown = async (): Promise<string[]> => (await streamLines(fx)).filter((line) => !line.startsWith('state:'));
  // A line that has the expected kind and text reads as "<kind>: <text>"; any other stays as shown.
  const normalised = (expected: Array<[string, string]>) => async (): Promise<string[]> => (await shown()).map((line, index) => {
    const [kind, text] = expected[index] ?? ['', '\0'];
    return line.startsWith(`${kind}: `) && line.includes(text) ? `${kind}: ${text}` : line;
  });
  const lines = (expected: Array<[string, string]>): string[] => expected.map(([kind, text]) => `${kind}: ${text}`);
  const before: Array<[string, string]> = [
    ['sep', 'Iteration 1'],
    ['prompt', `/implement .software-factory/${JOBS.working}.md`],
    ['text', 'Reading the Task file first.'],
    ['tool', 'Bash npm test → 2 lines'],
  ];
  await eventually(normalised(before), lines(before));
  // The result is joined to its call by id: no line of its own.
  assert.equal(await fx.page.locator('#stream li.e-tool_result').count(), 0);
  await fx.jobs.appendEvent(WS, JOBS.working, {
    ts: '2026-11-01T10:20:00.000Z', iteration: 0,
    message: { type: 'assistant', message: { content: [{ type: 'text', text: 'The tests pass now.' }] } },
  });
  const after: Array<[string, string]> = [...before, ['text', 'The tests pass now.']];
  await eventually(normalised(after), lines(after));
  assert.equal((await shown()).at(-1), 'text: The tests pass now.');
});

browserTest('job page: Changes shows the file tree with its folder and a file\'s diff', async (fx) => {
  await openChanges(fx);
  assert.equal(await fx.page.locator('#tlist .trow.dir .cnt').innerText(), '1');
  assert.equal(await shownPath(fx), 'README.md');
  await fx.page.locator('#tlist .trow', { hasText: 'a.ts' }).click();
  await eventually(() => shownPath(fx), 'src/a.ts');
  await eventually(() => fx.page.locator('#dbody .c.del').allInnerTexts(), [FILES['src/a.ts'].before.trimEnd()]);
  assert.deepEqual(await fx.page.locator('#dbody .c.add').allInnerTexts(), [FILES['src/a.ts'].after.trimEnd()]);
});

browserTest('ArrowDown and ArrowUp in the Changes tree move the selection', async (fx) => {
  await openChanges(fx);
  await fx.page.keyboard.press('ArrowUp');
  await eventually(() => focusedRow(fx), 'a.ts');
  assert.deepEqual(await selectedRow(fx), ['a.ts']);
  await eventually(() => shownPath(fx), 'src/a.ts');
  await fx.page.keyboard.press('ArrowUp');
  await eventually(() => focusedRow(fx), '▾src');
  await fx.page.keyboard.press('ArrowDown');
  await fx.page.keyboard.press('ArrowDown');
  await eventually(() => focusedRow(fx), 'README.md');
  assert.deepEqual(await selectedRow(fx), ['README.md']);
  await eventually(() => shownPath(fx), 'README.md');
});

browserTest('ArrowLeft and ArrowRight in the Changes tree collapse and expand a folder', async (fx) => {
  await openChanges(fx);
  await fx.page.keyboard.press('ArrowUp');
  await fx.page.keyboard.press('ArrowUp');
  await eventually(() => focusedRow(fx), '▾src');
  await fx.page.keyboard.press('ArrowLeft');
  await eventually(() => treeRows(fx), ['▸src', 'README.md']);
  assert.equal(await fx.page.locator('#tlist .trow.dir').getAttribute('aria-expanded'), 'false');
  assert.equal(await focusedRow(fx), '▸src');
  await fx.page.keyboard.press('ArrowRight');
  await eventually(() => treeRows(fx), ['▾src', 'a.ts', 'README.md']);
  assert.equal(await fx.page.locator('#tlist .trow.dir').getAttribute('aria-expanded'), 'true');
});

browserTest('Enter on a file in the Changes tree opens its diff and focuses #dbody', async (fx) => {
  await openChanges(fx);
  await fx.page.keyboard.press('ArrowUp');
  await eventually(() => focusedRow(fx), 'a.ts');
  await fx.page.keyboard.press('Enter');
  await eventually(() => activeId(fx), 'dbody');
  assert.equal(await shownPath(fx), 'src/a.ts');
  await eventually(() => fx.page.locator('#dbody .c.add').allInnerTexts(), [FILES['src/a.ts'].after.trimEnd()]);
});

browserTest('job page: the Merge request screen shows the title and the body of the MR text', async (fx) => {
  await fx.open(`${WS}/${JOBS.ready}/mr`);
  await eventually(() => fx.page.locator('#mrTitle').inputValue(), MR_TITLE);
  assert.equal(await fx.page.locator('#mrBody').inputValue(), MR_BODY);
  assert.equal(await fx.page.locator('#scrMr [data-err="title"]').innerText(), '');
});

browserTest('job page: an invalid MR title shows its problem', async (fx) => {
  await fx.open(`${WS}/${JOBS.ready}/mr`);
  const title = fx.page.locator('#mrTitle');
  await eventually(() => title.inputValue(), MR_TITLE);
  await title.fill('Add the greeting');
  await eventually(() => fx.page.locator('#scrMr [data-err="title"]').innerText(),
    `The title must read "<type>(${JOBS.ready}): <summary>", with <type> one of feat, fix, chore, refactor, docs, test, perf, build, ci, style, revert.`);
});

browserTest('Ctrl+S on the Merge request screen posts the save', async (fx) => {
  await fx.open(`${WS}/${JOBS.ready}/mr`);
  const body = fx.page.locator('#mrBody');
  await eventually(() => body.inputValue(), MR_BODY);
  await body.focus();
  await fx.page.keyboard.press('Control+End');
  await fx.page.keyboard.type('\nOne more line.');
  const request = fx.posted(`api/jobs/${WS}/${JOBS.ready}/mr-save`);
  await fx.page.keyboard.press('Control+s');
  const expected = { title: MR_TITLE, body: `${MR_BODY}\nOne more line.` };
  assert.deepEqual((await request).postDataJSON(), expected);
  await eventually(() => fx.page.locator('#toast-text').innerText(), 'MR text saved');
  assert.deepEqual(fx.actions.calls.map((call) => [call.method, ...call.args]), [['saveMr', WS, JOBS.ready, expected]]);
});

browserTest('Escape in a field on a job page blurs the field', async (fx) => {
  await fx.open(`${WS}/${JOBS.working}`);
  const box = fx.page.locator('#msg');
  await eventually(() => box.isEnabled(), true);
  await box.focus();
  assert.equal(await activeId(fx), 'msg');
  await fx.page.keyboard.press('Escape');
  assert.notEqual(await activeId(fx), 'msg');
  // Still on the job page: Escape in a field only leaves the field.
  assert.equal(await fx.page.locator('#job').isVisible(), true);
});

browserTest('Ctrl+Enter in #msg posts say', async (fx) => {
  await fx.open(`${WS}/${JOBS.working}`);
  const box = fx.page.locator('#msg');
  await eventually(() => box.isEnabled(), true);
  await box.fill('Use the new helper.');
  const request = fx.posted(`api/jobs/${WS}/${JOBS.working}/say`);
  await box.press('Control+Enter');
  assert.deepEqual((await request).postDataJSON(), { message: 'Use the new helper.' });
  await eventually(async () => fx.actions.calls.map((call) => [call.method, ...call.args]), [['say', WS, JOBS.working, 'Use the new helper.']]);
});

// SF-107: the hand-over panel of a handed-over job (created here, not in the shared fixture, so the
// board's tests keep their jobs): its two paths side by side at 1200 px, stacked at 600 px, and no
// horizontal scroll.
browserTest('job page (SF-107): the hand-over panel shows its two paths side by side at 1200 px and stacked at 600 px, without a horizontal scroll', async (fx) => {
  const ticket = 'SF-H1';
  const ready = (await fx.jobs.read(WS, JOBS.ready))!;
  const commit = 'a'.repeat(40);
  await fx.jobs.write({
    ...ready, ticket, branch: `${ticket}-work`, state: 'handed_over', prepared_commit: commit, worktree: null, session_id: `session-${ticket}`,
    handover: {
      branch: `${ticket}-work`, saved: commit, base: 'b'.repeat(40), previous: { branch: 'main' }, untracked: [], template: null, cleanup: null,
      at: '2026-11-01T10:40:00.000Z', checked_at: null, step: null,
    },
  });
  fx.actions.mrHost = { host: 'github', reason: null } as typeof fx.actions.mrHost;
  await fx.page.setViewportSize({ width: 1200, height: 900 });
  await fx.open(`${WS}/${ticket}`);
  const paths = fx.page.locator('#handover-panel .ho-path');
  await eventually(() => paths.count(), 2);
  await eventually(() => fx.page.locator('#handover-panel .ho-path .btn').allInnerTexts(), ['I opened the MR', 'Push and open the MR…']);
  const boxes = async () => Promise.all([paths.nth(0).boundingBox(), paths.nth(1).boundingBox()]);
  const noScroll = (): Promise<boolean> => fx.page.evaluate(() => [document.documentElement, document.getElementById('job')!, document.getElementById('composer')!]
    .every((node) => node.scrollWidth <= node.clientWidth));

  // Side by side: one row, two equal boxes.
  const [a, b] = await boxes();
  assert.ok(a !== null && b !== null);
  assert.ok(Math.abs(a.y - b.y) < 1, `same top: ${a.y} and ${b.y}`);
  assert.ok(b.x >= a.x + a.width, `B right of A: ${a.x}+${a.width} and ${b.x}`);
  assert.ok(Math.abs(a.width - b.width) < 1, `equal widths: ${a.width} and ${b.width}`);
  assert.equal(await noScroll(), true);

  // Stacked below 720 px: B under A, as wide, inside the viewport.
  await fx.page.setViewportSize({ width: 600, height: 900 });
  await eventually(async () => {
    const [top, bottom] = await boxes();
    return top !== null && bottom !== null && bottom.y >= top.y + top.height && Math.abs(top.x - bottom.x) < 1 && bottom.x + bottom.width <= 600;
  }, true);
  assert.equal(await noScroll(), true);
});

// SF-308-3: Discuss the result of a waiting job whose ticket Claude Code plans. claude.ai is a
// route stub: no network.
browserTest('job page (SF-308-3): Claude Code plans the ticket: Discuss the result ↗ opens its session in a new page, the message on the clipboard; with no session, Discuss the result posts discuss and the session it started shows', async (fx) => {
  const link = 'https://claude.ai/code/session_01Ab';
  const { iteration } = (await fx.jobs.read(WS, JOBS.gate))!;
  fx.setup.owners.set(JOBS.gate, 'claude_code');
  fx.planner.sessions.set(`${WS}/${JOBS.gate}`, { workspace: WS, ticket: JOBS.gate, name: `sf-plan-${WS}-${JOBS.gate}`, id: 'planner-0', pid: process.pid, started_at: '2026-11-01T10:40:00.000Z', link });
  const context = fx.page.context();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(fx.url).origin });
  await context.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>The planner session</title>' }));
  await fx.open(`${WS}/${JOBS.gate}`);
  const discuss = fx.page.locator('#planner-discuss-link');
  await discuss.waitFor();
  assert.deepEqual([await discuss.innerText(), await discuss.getAttribute('target'), await discuss.getAttribute('rel')], ['Discuss the result ↗', '_blank', 'noopener noreferrer']);
  const opened = context.waitForEvent('page');
  await discuss.click();
  const tab = await opened;
  await tab.waitForLoadState();
  assert.equal(tab.url(), link);
  await tab.close();
  await eventually(() => fx.page.evaluate(() => navigator.clipboard.readText()), resultConversation(WS, JOBS.gate, 'claude_code'));

  // No session: the button posts discuss, and the session started on this result shows its line.
  fx.planner.sessions.clear();
  await fx.page.reload();
  await fx.page.waitForFunction(() => document.getElementById('health-light')?.dataset.stream === 'live');
  const start = fx.page.locator('#planner-discuss-button');
  await start.waitFor();
  const request = fx.posted(`api/tickets/${WS}/${JOBS.gate}/planner/discuss`);
  await start.click();
  assert.deepEqual((await request).postDataJSON(), {});
  await eventually(() => fx.page.locator('#planner [role="status"]').innerText().catch(() => ''), `Planner session "sf-plan-${WS}-${JOBS.gate}" runs; its link shows here once it first waits for you, or find it under that name in the Claude app or on claude.ai/code.`);
  assert.deepEqual(fx.planner.starts, [[WS, JOBS.gate, { iteration }]]);
  assert.equal(await fx.page.locator('#planner [data-act="planner-copy"]').count(), 0);
  assert.deepEqual(fx.problems, []);
});
