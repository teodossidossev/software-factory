// Point mode in a real browser (SF-211): a click on a card's button and on a link runs neither (no
// request, no navigation), places 📍1 over that element and opens the note field, whose Save stores
// the note; the outline follows the pointer; the selector of an element with an id, with a data-
// attribute and with neither finds the same element after the board redraws (an ancestor's unique
// id before a nearer data- attribute, an id that is not a plain name escaped, a data- anchor where
// no id is above); a marker, however wide its id, stays inside the viewport; a marker sits at its
// element's corner and moves with a scroll; Escape leaves the mode; at 390 px the panel does not
// scroll the page sideways.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import type { Locator, Request } from 'playwright';
import { setLink } from '../../src/coordinator.js';
import { pinsFile, readPins } from '../../src/pins.js';
import { browserTest, eventually, type Fixture, PLANNED, WS } from './support.js';

const card = (fx: Fixture, ticket: string) => fx.page.locator(`#cols .card[data-key="${WS}/${ticket}"]`);
const pressed = (fx: Fixture): Promise<string | null> => fx.page.locator('#point-toggle').getAttribute('aria-pressed');

// Every request the page sends from now on.
function recordRequests(fx: Fixture): Request[] {
  const requests: Request[] = [];
  fx.page.on('request', (request) => requests.push(request));
  return requests;
}

const box = async (locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const found = await locator.boundingBox();
  assert.ok(found !== null);
  return found;
};

// A click in point mode on the element: the POST api/pins it places, answered; the pin's selector.
async function pointAt(fx: Fixture, target: Locator, position?: { x: number; y: number }): Promise<{ id: number; selector: string; text: string }> {
  const placed = fx.page.waitForResponse((response) => response.request().method() === 'POST' && response.url() === `${fx.url}api/pins`);
  await target.click(position === undefined ? {} : { position });
  const answer = (await (await placed).json()) as { result: { pin: { id: number; selector: string; text: string } } };
  await fx.page.locator('#pin-note').waitFor();
  await fx.page.locator('#pin-note-skip').click();
  return answer.result.pin;
}

browserTest('pins: in point mode a click on a card\'s button and on a link runs neither, places 📍1 over the button and opens the note field; Save stores the note; Escape leaves the mode', async (fx) => {
  await setLink(fx.state, 'https://claude.ai/chat/abc');
  await fx.open();
  const button = card(fx, PLANNED.unqueued).getByRole('button', { name: 'Add to queue' });
  await button.waitFor();
  const link = fx.page.locator('#coord a', { hasText: 'Open the chat' });
  await link.waitFor();
  const requests = recordRequests(fx);
  const popups: unknown[] = [];
  fx.page.context().on('page', (page) => popups.push(page));

  await fx.page.keyboard.press('Shift+P');
  assert.equal(await pressed(fx), 'true');
  assert.equal(await fx.page.locator('body').evaluate((body) => body.classList.contains('pointing')), true);
  const placed = fx.page.waitForResponse((response) => response.url() === `${fx.url}api/pins` && response.request().method() === 'POST');
  await button.click();
  const pin = ((await (await placed).json()) as { result: { pin: { id: number; text: string; selector: string } } }).result.pin;
  assert.deepEqual([pin.id, pin.text], [1, 'Add to queue']);
  const note = fx.page.getByRole('dialog', { name: 'Note for pin 1' });
  await note.waitFor();
  // The marker sits at the button's top-left corner.
  const marker = fx.page.locator('#pin-layer .pin-marker', { hasText: '📍1' });
  await marker.waitFor();
  const [markerBox, buttonBox] = [await box(marker), await box(button)];
  assert.ok(Math.abs(markerBox.x - buttonBox.x) <= 1 && Math.abs(markerBox.y - buttonBox.y) <= 1, `${JSON.stringify(markerBox)} at ${JSON.stringify(buttonBox)}`);
  // Save stores the note.
  await note.locator('textarea').fill('Should this say Queue?');
  const saved = fx.page.waitForResponse((response) => response.url() === `${fx.url}api/pins/1` && response.request().method() === 'POST');
  await note.getByRole('button', { name: 'Save' }).click();
  assert.equal((await saved).status(), 200);
  await note.waitFor({ state: 'hidden' });
  assert.equal((await readPins(fx.state)).pins[0]?.note, 'Should this say Queue?');

  // A link: no navigation, no new tab; the pin is placed on it.
  const before = fx.page.url();
  const onLink = await pointAt(fx, link);
  assert.deepEqual([onLink.id, onLink.text, fx.page.url(), popups.length], [2, 'Open the chat', before, 0]);
  // Neither element's own action ran: only the pins' requests went out.
  assert.deepEqual(requests.filter((request) => request.method() === 'POST').map((request) => request.url().slice(fx.url.length)), ['api/pins', 'api/pins/1', 'api/pins']);
  assert.deepEqual(fx.actions.calls, []);

  // Escape leaves the mode; the button acts again.
  await fx.page.keyboard.press('Escape');
  assert.equal(await pressed(fx), 'false');
  const queued = fx.posted('api/queue/add');
  await button.click();
  await queued;
  assert.deepEqual(fx.problems, []);
});

browserTest('pins: the outline follows the pointer; the selector of an element with an id, with a data- attribute and with neither finds the same element after the board redraws', async (fx) => {
  await fx.open();
  const newTicket = fx.page.locator('#open-new-ticket');
  const unqueued = card(fx, PLANNED.unqueued);
  await unqueued.waitFor();
  await fx.page.locator('#point-toggle').click();
  const outline = fx.page.locator('#pin-outline');
  for (const target of [newTicket, unqueued.locator('.key')]) {
    const targetBox = await box(target);
    await fx.page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
    await outline.waitFor();
    const outlineBox = await box(outline);
    assert.ok(Math.abs(outlineBox.x - targetBox.x) <= 1 && Math.abs(outlineBox.width - targetBox.width) <= 1, `${JSON.stringify(outlineBox)} over ${JSON.stringify(targetBox)}`);
  }
  assert.equal(await unqueued.locator('.key').evaluate((node) => node.getAttributeNames().length), 1, 'nothing added to the element itself');

  const withId = await pointAt(fx, newTicket);
  // The card itself, clicked at its corner, has data- attributes and no id: an ancestor's unique
  // id is the anchor all the same, before any data- attribute.
  const withData = await pointAt(fx, unqueued, { x: 3, y: 3 });
  const withNeither = await pointAt(fx, unqueued.locator('.key'));
  assert.equal(withId.selector, '#open-new-ticket');
  assert.match(withData.selector, /^#[\w-]+( > [a-z]+:nth-of-type\(\d+\))+$/);
  assert.ok(withNeither.selector.startsWith(`${withData.selector} > `), withNeither.selector);

  // Elements with no unique id above them: a data- attribute is the anchor; and a unique id that
  // is not a plain name is written escaped.
  await fx.page.evaluate(() => {
    const zone = document.createElement('div');
    zone.innerHTML = '<div data-probe="one"><p><span>in data</span></p></div><div id="1st pin:x"><i>in odd id</i></div>';
    document.body.prepend(zone);
  });
  const underData = await pointAt(fx, fx.page.getByText('in data'));
  const underOddId = await pointAt(fx, fx.page.getByText('in odd id'));
  assert.equal(underData.selector, 'div[data-probe="one"] > p:nth-of-type(1) > span:nth-of-type(1)');
  assert.equal(underOddId.selector, '#\\31 st\\ pin\\:x > i:nth-of-type(1)');
  assert.deepEqual(await fx.page.evaluate((selectors) => selectors.map((selector) => document.querySelector(selector)?.textContent), [underData.selector, underOddId.selector]), ['in data', 'in odd id']);

  // The board redraws: each selector finds the element of the same ticket again.
  const markOld = await fx.page.evaluate(() => {
    const old = document.querySelectorAll('#cols .card');
    old.forEach((node) => node.setAttribute('data-old', ''));
    return old.length;
  });
  assert.ok(markOld > 0);
  fx.dashboard.refreshSetup();
  await fx.page.waitForFunction(() => document.querySelector('#cols .card[data-old]') === null);
  const found = await fx.page.evaluate((selectors) => selectors.map((selector) => {
    const node = document.querySelector(selector);
    return node === null ? null : { id: node.id, key: node.closest('.card')?.getAttribute('data-key') ?? null, text: node.textContent?.trim().slice(0, 40) ?? '' };
  }), [withId.selector, withData.selector, withNeither.selector]);
  assert.deepEqual(found.map((entry) => [entry?.id, entry?.key]), [['open-new-ticket', null], ['', `${WS}/${PLANNED.unqueued}`], ['', `${WS}/${PLANNED.unqueued}`]]);
  assert.equal(found[2]?.text, PLANNED.unqueued);
});

browserTest('pins: a marker sits at its element\'s corner and moves with a scroll; the markers show with the mode off', async (fx) => {
  await fx.page.setViewportSize({ width: 1400, height: 320 });
  await fx.open();
  const target = card(fx, PLANNED.skeleton);
  await target.waitFor();
  await fx.page.keyboard.press('Shift+P');
  const pin = await pointAt(fx, target.locator('.key'));
  await fx.page.keyboard.press('Escape');
  assert.equal(await pressed(fx), 'false');
  const marker = fx.page.locator('#pin-layer .pin-marker', { hasText: `📍${pin.id}` });
  const corner = async (): Promise<[number, number]> => {
    const key = await box(target.locator('.key'));
    return [Math.round(key.x), Math.round(Math.max(0, key.y))];
  };
  const markerAt = async (): Promise<[number, number]> => {
    const found = await box(marker);
    return [Math.round(found.x), Math.round(found.y)];
  };
  await eventually(markerAt, await corner());
  const scrolled = await fx.page.evaluate(() => {
    window.scrollBy(0, 120);
    return window.scrollY;
  });
  assert.ok(scrolled > 0, 'the board scrolls at 320 px');
  await eventually(markerAt, await corner());
  assert.deepEqual(fx.problems, []);
});

browserTest('pins: a marker wider than 44 px (a long id) on an element at the right edge stays inside the viewport', async (fx) => {
  const id = 123_456_789_012_345;
  const pin = { id, route: '', selector: '#open-new-ticket', text: 'New ticket', rect: { x: 0, y: 0, w: 1, h: 1, vw: 1, vh: 1 }, note: '', at: '2026-11-14T09:00:00.000Z', resolved: false };
  await writeFile(pinsFile(fx.state), JSON.stringify({ version: 1, next: id + 1, pins: [pin] }));
  await fx.open();
  const marker = fx.page.locator('#pin-layer .pin-marker', { hasText: `📍${id}` });
  await marker.waitFor();
  const [markerBox, buttonBox] = [await box(marker), await box(fx.page.locator('#open-new-ticket'))];
  const width = await fx.page.evaluate(() => window.innerWidth);
  assert.ok(markerBox.width > 44, `the label is ${markerBox.width} px wide`);
  assert.ok(buttonBox.x + markerBox.width > width, 'at the button\'s corner it would cross the right edge');
  assert.ok(markerBox.x >= 0 && markerBox.x + markerBox.width <= width, `${JSON.stringify(markerBox)} in ${width} px`);
});

browserTest('pins: at 390 px the panel and the 📍 N button do not scroll the page sideways', async (fx) => {
  await fx.page.setViewportSize({ width: 390, height: 844 });
  await fx.open();
  await fx.page.keyboard.press('Shift+P');
  const panel = fx.page.locator('#pins');
  await panel.waitFor();
  const target = card(fx, PLANNED.first).locator('.key');
  await target.waitFor();
  await pointAt(fx, target);
  const widths = async (): Promise<[number, number]> => fx.page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth] as [number, number]);
  const [scroll, client] = await widths();
  assert.ok(scroll <= client, `scrollWidth ${scroll} > ${client}`);
  const panelBox = await box(panel);
  assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= 390, JSON.stringify(panelBox));
  // Its buttons are 44 px targets on a phone.
  for (const name of ['Refresh', 'Resolve']) {
    assert.ok((await box(panel.getByRole('button', { name }).first())).height >= 44, name);
  }
  await fx.page.keyboard.press('Escape');
  const open = fx.page.locator('#pins-open');
  await open.waitFor();
  assert.equal(await open.innerText(), '📍 1');
  const [afterScroll, afterClient] = await widths();
  assert.ok(afterScroll <= afterClient, `scrollWidth ${afterScroll} > ${afterClient}`);
});
