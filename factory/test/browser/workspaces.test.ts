// The Workspaces dialog's Edit in a real browser (SF-103): the card opens as a form with the
// workspace's fields, Save posts every field and the card shows the new values, Cancel posts nothing.
import assert from 'node:assert/strict';
import { browserTest, eventually, WS } from './support.js';

const list = '#workspace-list > li';

browserTest('workspaces: Edit saves every field and the card shows them; the name stays', async (fx) => {
  await fx.open();
  await fx.page.locator('#open-workspaces').click();
  const item = fx.page.locator(list).first();
  assert.equal(await item.locator('.ws-digest').innerText(), 'Morning digest: off · My daily: off');
  await item.getByRole('button', { name: 'Edit' }).click();
  const form = item.locator('form.ws-edit');
  await form.waitFor();
  const path = form.getByLabel('Path of the local checkout');
  await eventually(async () => fx.page.evaluate(() => document.activeElement?.getAttribute('data-wsf') ?? ''), 'path');
  const before = await path.inputValue();
  assert.equal(await form.getByLabel('Description', { exact: true }).getAttribute('placeholder'), 'The app of the browser tests.');
  await form.getByLabel('Description', { exact: true }).fill('The browser tests\' app.');
  await form.getByLabel('App', { exact: true }).fill('shop');
  await form.getByLabel('When a job is ready, hand it over to my checkout').selectOption('checkout');
  await form.getByLabel('Colour of its cards on the board').selectOption('green');
  await form.getByLabel('Label on its cards').fill('exp');
  await form.getByLabel('Morning digest: follow this repository').check();
  await form.getByLabel('My daily: my commits here go into the daily of its app').check();
  const request = fx.posted(`api/workspaces/${WS}/edit`);
  await form.getByRole('button', { name: 'Save' }).click();
  const body = { path: before, description: 'The browser tests\' app.', app: 'shop', handoff: 'checkout', color: 'green', label: 'exp', digest: { track: true, my_work: true } };
  assert.deepEqual((await request).postDataJSON(), body);
  assert.deepEqual(fx.setup.calls, [{ method: 'editWorkspace', args: [WS, body] }]);
  await eventually(() => fx.page.locator('#workspace-status').innerText(), `Saved ${WS}.`);
  assert.equal(await item.locator('form').count(), 0);
  // The card from the payload the save refreshed.
  fx.dashboard.refreshSetup();
  await eventually(() => item.locator('.ws-digest').innerText(), 'Morning digest: on · My daily: on');
  assert.equal(await item.locator('.ws-app').innerText(), 'shop');
  assert.equal(await item.locator('.ws-description').innerText(), 'The browser tests\' app.');
  assert.equal(await item.locator('.ws-name').innerText(), `${WS}shop`);
  assert.deepEqual(fx.problems, []);
});

browserTest('workspaces: Cancel and Escape leave the workspace unchanged', async (fx) => {
  await fx.open();
  await fx.page.locator('#open-workspaces').click();
  const item = fx.page.locator(list).first();
  await item.getByRole('button', { name: 'Edit' }).click();
  await item.locator('form.ws-edit').getByLabel('App', { exact: true }).fill('other');
  await item.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await item.locator('form').count(), 0);
  await item.getByRole('button', { name: 'Edit' }).click();
  assert.equal(await item.locator('form.ws-edit').getByLabel('App', { exact: true }).inputValue(), '');
  await item.locator('form.ws-edit').getByLabel('App', { exact: true }).press('Escape');
  assert.equal(await item.locator('form').count(), 0);
  // The drawer stays open: Escape closed the form only.
  assert.equal(await fx.page.locator('#drawer').isVisible(), true);
  assert.deepEqual(fx.setup.calls, []);
});
