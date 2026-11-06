// The board in a real browser (SF-091): the columns and their cards by state, the stop decisions,
// the dependency chip, the run queue's controls and their keys.
import assert from 'node:assert/strict';
import { browserTest, eventually, type Fixture, JOBS, PLANNED, WS } from './support.js';

const keysIn = (fx: Fixture, list: string): Promise<string[]> => fx.page.locator(`#${list} .card .key`).allTextContents();
const queued = (fx: Fixture): Promise<string[]> => fx.page.locator('#qlist .card[data-q] .key').allTextContents();
const card = (fx: Fixture, ticket: string) => fx.page.locator(`#cols .card[data-key="${WS}/${ticket}"]`);
// The Queue column as the user reads it: the queued cards with their positions, "Not queued", the rest.
const queueColumn = (fx: Fixture): Promise<string[]> => fx.page.locator('#qlist > li').evaluateAll((items) => items.map((item) =>
  item.classList.contains('qdiv') ? `— ${item.textContent}` : `${item.querySelector('.pos')?.textContent ?? '·'} ${item.querySelector('.key')?.textContent ?? item.textContent}`));

browserTest('board: the columns show the cards by state, with no console error and no failed request during load', async (fx) => {
  await fx.open();
  await eventually(() => queueColumn(fx), [`1 ${PLANNED.first}`, `2 ${PLANNED.second}`, '— Not queued', `· ${PLANNED.unqueued}`, `· ${PLANNED.skeleton}`]);
  assert.deepEqual(await keysIn(fx, 'list-implementing'), [JOBS.working]);
  assert.deepEqual(await keysIn(fx, 'list-reviewing'), [JOBS.reviewing]);
  assert.deepEqual((await keysIn(fx, 'list-you')).sort(), [JOBS.gate, JOBS.ready, JOBS.simplify].sort());
  assert.deepEqual(await keysIn(fx, 'list-done'), [JOBS.pushed]);
  const headings = await fx.page.locator('#cols h2').allInnerTexts();
  assert.deepEqual(headings.map((text) => text.replace(/\s+/g, ' ').trim().toLowerCase()), ['queue 2', 'implementing 1', 'reviewing 1', 'your turn 3', 'done 1']);
  assert.equal(await card(fx, JOBS.working).locator('.now b').innerText(), 'Now: Implementer');
  // The page settles: the stream is live and nothing failed while it loaded.
  await fx.page.waitForLoadState('networkidle').catch(() => undefined);
  assert.deepEqual(fx.problems, []);
});

browserTest('board: a simplify_offered card is a decision, not an error, with "Simplify or skip"', async (fx) => {
  await fx.open();
  const simplify = card(fx, JOBS.simplify);
  await simplify.waitFor();
  const reason = simplify.locator('.reason');
  assert.equal(await reason.innerText(), 'Simplification offered');
  assert.equal(await reason.evaluate((node) => node.classList.contains('err')), false, 'the reason is not shown as an error');
  assert.equal(await simplify.getByRole('button', { name: 'Simplify or skip' }).isVisible(), true);
});

browserTest('board: the gate_rounds card with 2 findings reads "Decide 2 findings"', async (fx) => {
  await fx.open();
  const gate = card(fx, JOBS.gate);
  await gate.waitFor();
  assert.equal(await gate.locator('.reason').innerText(), 'Codex round limit reached');
  assert.equal(await gate.locator('.meta').first().innerText(), 'Iteration 1 · 2 findings to decide');
  assert.equal(await gate.getByRole('button', { name: 'Decide 2 findings' }).isVisible(), true);
});

browserTest('board: SF-T2 waits for SF-T9, pushed and not merged yet', async (fx) => {
  await fx.open();
  const chip = card(fx, PLANNED.second).locator('.deps.waits .dchip');
  await chip.waitFor();
  assert.equal(await chip.innerText(), `⧗ ${JOBS.pushed}`);
  assert.equal(await chip.getAttribute('title'), `${WS}/${JOBS.pushed}: pushed, not merged yet`);
  assert.equal(await card(fx, PLANNED.second).locator('.deps.waits .lbl').innerText(), 'Waits for');
});

browserTest('queue: the "Run up to N" stepper posts api/queue/limit and shows the new limit', async (fx) => {
  await fx.open();
  await fx.page.locator('#qctl').waitFor();
  // Two jobs run at the limit of 2; one fewer starts nothing, as the real queue would.
  assert.equal(await fx.page.locator('#limVal').innerText(), '2');
  const request = fx.posted('api/queue/limit');
  await fx.page.getByRole('button', { name: 'One job fewer' }).click();
  assert.deepEqual((await request).postDataJSON(), { max_running: 1 });
  await eventually(() => fx.page.locator('#limVal').innerText(), '1');
  assert.deepEqual(fx.queue.calls, [{ method: 'limit', args: [1] }]);
});

browserTest('queue: Add to queue on SF-T3 posts api/queue/add and the card is queued at 3', async (fx) => {
  await fx.open();
  const request = fx.posted('api/queue/add');
  await card(fx, PLANNED.unqueued).getByRole('button', { name: 'Add to queue' }).click();
  assert.deepEqual((await request).postDataJSON(), { workspace: WS, ticket: PLANNED.unqueued });
  await eventually(() => queueColumn(fx), [`1 ${PLANNED.first}`, `2 ${PLANNED.second}`, `3 ${PLANNED.unqueued}`, '— Not queued', `· ${PLANNED.skeleton}`]);
  assert.deepEqual(fx.queue.calls, [{ method: 'add', args: [WS, PLANNED.unqueued, undefined] }]);
});

browserTest('queue: Remove from queue on SF-T1 posts api/queue/remove and the card leaves the queue', async (fx) => {
  await fx.open();
  const request = fx.posted('api/queue/remove');
  await card(fx, PLANNED.first).getByRole('button', { name: 'Remove from queue' }).click();
  assert.deepEqual((await request).postDataJSON(), { workspace: WS, ticket: PLANNED.first });
  await eventually(() => queueColumn(fx), [`1 ${PLANNED.second}`, '— Not queued', `· ${PLANNED.first}`, `· ${PLANNED.unqueued}`, `· ${PLANNED.skeleton}`]);
  assert.deepEqual(fx.queue.calls, [{ method: 'remove', args: [WS, PLANNED.first] }]);
});

browserTest('Alt+Down on a focused queued card posts api/queue/move', async (fx) => {
  await fx.open();
  await eventually(() => queued(fx), [PLANNED.first, PLANNED.second]);
  await card(fx, PLANNED.first).focus();
  const request = fx.posted('api/queue/move');
  await fx.page.keyboard.press('Alt+ArrowDown');
  assert.deepEqual((await request).postDataJSON(), { workspace: WS, ticket: PLANNED.first, to: 2 });
  await eventually(() => queued(fx), [PLANNED.second, PLANNED.first]);
  assert.deepEqual(fx.queue.calls, [{ method: 'move', args: [WS, PLANNED.first, 2] }]);
});

browserTest('Alt+Up on a focused queued card posts api/queue/move', async (fx) => {
  await fx.open();
  await eventually(() => queued(fx), [PLANNED.first, PLANNED.second]);
  // SF-T1 down to 2 first, then Alt+Up on the card at position 2 moves it back.
  await card(fx, PLANNED.first).focus();
  await fx.page.keyboard.press('Alt+ArrowDown');
  await eventually(() => queued(fx), [PLANNED.second, PLANNED.first]);
  await card(fx, PLANNED.first).focus();
  const request = fx.posted('api/queue/move');
  await fx.page.keyboard.press('Alt+ArrowUp');
  assert.deepEqual((await request).postDataJSON(), { workspace: WS, ticket: PLANNED.first, to: 1 });
  await eventually(() => queued(fx), [PLANNED.first, PLANNED.second]);
  assert.deepEqual(fx.queue.calls, [{ method: 'move', args: [WS, PLANNED.first, 2] }, { method: 'move', args: [WS, PLANNED.first, 1] }]);
});

browserTest('queue: a drag of SF-T2 above SF-T1 posts api/queue/move to position 1', async (fx) => {
  await fx.open();
  await eventually(() => queued(fx), [PLANNED.first, PLANNED.second]);
  const request = fx.posted('api/queue/move');
  await card(fx, PLANNED.second).dragTo(card(fx, PLANNED.first));
  assert.deepEqual((await request).postDataJSON(), { workspace: WS, ticket: PLANNED.second, to: 1 });
  await eventually(() => queued(fx), [PLANNED.second, PLANNED.first]);
  assert.deepEqual(fx.queue.calls, [{ method: 'move', args: [WS, PLANNED.second, 1] }]);
});
