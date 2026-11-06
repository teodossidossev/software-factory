// The planned ticket page in a real browser (SF-091): the Task file shown, Edit and Save, Ctrl+S
// while editing, and the history read from the state directory.
import assert from 'node:assert/strict';
import { taskSha256 as sha256 } from '../../src/task-file.js';
import { browserTest, eventually, type Fixture, PLANNED, WS } from './support.js';

const fileCard = (fx: Fixture) => fx.page.locator('#ticket .card2').filter({ has: fx.page.locator('h3', { hasText: 'Task file' }) });

// The page of a planned ticket, its Task file read.
async function openTicket(fx: Fixture, ticket: string): Promise<void> {
  await fx.open(`${WS}/${ticket}/ticket`);
  await fileCard(fx).getByRole('tab', { name: 'Edit' }).waitFor();
}

// Edit, the text with a line added at its end; the text it now holds.
async function editTask(fx: Fixture, ticket: string): Promise<string> {
  await fileCard(fx).getByRole('tab', { name: 'Edit' }).click();
  const box = fx.page.locator('#tkText');
  await eventually(async () => fx.page.evaluate(() => document.activeElement?.id ?? ''), 'tkText');
  const before = await box.inputValue();
  assert.equal(before, fx.setup.tasks.get(ticket)!.text);
  await fx.page.keyboard.press('Control+End');
  await fx.page.keyboard.type('One more line.\n');
  return `${before}One more line.\n`;
}

browserTest('ticket page: the Task file is shown', async (fx) => {
  await openTicket(fx, PLANNED.unqueued);
  assert.equal(await fx.page.locator('#ticket .t1 .key').innerText(), PLANNED.unqueued);
  assert.equal(await fx.page.locator('#ticket .t1 .title').innerText(), 'Show the user menu');
  const card = fileCard(fx);
  assert.equal(await card.locator('h3 .mono').innerText(), `.software-factory/${PLANNED.unqueued}.md`);
  assert.equal(await card.getByRole('heading', { name: `${PLANNED.unqueued}: Show the user menu` }).isVisible(), true);
  assert.equal(await card.getByText(`The goal of ${PLANNED.unqueued}.`).isVisible(), true);
  // The preview shows the body, not the front matter.
  assert.equal(await card.getByText('ticket: SF-T3').count(), 0);
});

browserTest('ticket page: the history lists the recorded writes, newest first', async (fx) => {
  await openTicket(fx, PLANNED.first);
  const history = fx.page.locator('#ticket .card2').filter({ has: fx.page.locator('h3', { hasText: /^History$/ }) });
  await eventually(() => history.locator('ul.hist > li > span:not(.t)').allInnerTexts(), ['Edited by you', 'Created by you']);
  assert.deepEqual(await history.locator('ul.hist > li > span.t').evaluateAll((spans) => spans.map((span) => span.getAttribute('title'))),
    ['2026-11-01T10:35:00.000Z', '2026-11-01T10:30:00.000Z']);
});

browserTest('ticket page: Edit and Save post the Task file over the version read', async (fx) => {
  await openTicket(fx, PLANNED.unqueued);
  const read = fx.setup.tasks.get(PLANNED.unqueued)!.text;
  const text = await editTask(fx, PLANNED.unqueued);
  assert.equal(await fileCard(fx).getByText('Unsaved changes').isVisible(), true);
  const request = fx.posted(`api/tickets/${WS}/${PLANNED.unqueued}/task`);
  await fileCard(fx).getByRole('button', { name: 'Save' }).click();
  assert.deepEqual((await request).postDataJSON(), { content: text, sha256: sha256(read) });
  await eventually(() => fx.page.locator('#toast-text').innerText(), `Saved .software-factory/${PLANNED.unqueued}.md.`);
  assert.deepEqual(fx.setup.calls, [{ method: 'saveTask', args: [WS, PLANNED.unqueued, text, sha256(read)] }]);
  await eventually(() => fileCard(fx).getByText('Unsaved changes').count(), 0);
});

browserTest('Ctrl+S on the planned ticket page\'s Edit tab posts the write', async (fx) => {
  await openTicket(fx, PLANNED.unqueued);
  const read = fx.setup.tasks.get(PLANNED.unqueued)!.text;
  const text = await editTask(fx, PLANNED.unqueued);
  const request = fx.posted(`api/tickets/${WS}/${PLANNED.unqueued}/task`);
  await fx.page.keyboard.press('Control+s');
  assert.deepEqual((await request).postDataJSON(), { content: text, sha256: sha256(read) });
  await eventually(() => fx.page.locator('#toast-text').innerText(), `Saved .software-factory/${PLANNED.unqueued}.md.`);
  assert.deepEqual(fx.setup.calls, [{ method: 'saveTask', args: [WS, PLANNED.unqueued, text, sha256(read)] }]);
});
