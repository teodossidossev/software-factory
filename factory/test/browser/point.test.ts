// The Point bookmarklet in a real browser (SF-267). The test reads the bookmarklet from the pins
// panel's link (Playwright cannot click the bookmarks bar) and runs its decoded code with
// page.evaluate:
// - in a shop of another site (http://localhost:<port>, the dashboard being 127.0.0.1) served with
//   a Content-Security-Policy that allows only its own scripts and styles: the factory window opens
//   as the shop's popup, Allow there, Point, a click on the shop's Buy button (its own handler does
//   not run), a note and Save store a page pin with the shop's address; the marker shows, the
//   window lists the pin, the shop sends nothing to the factory's origin, the bar is fixed, Escape
//   unpresses Point, and a second run closes the bar and the window;
// - in a browser without a dashboard session: the window keeps its static text, the bar says the
//   window does not answer;
// - on the dashboard itself: the bar alone with its message, no window, and the dashboard's own
//   Shift+P still works.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright';
import { readPins } from '../../src/pins.js';
import { browserTest, eventually, type Fixture } from './support.js';

const SHOP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'";
const SHOP_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title><script src="shop.js" defer></script></head>'
  + '<body><main><h1>Shop</h1><button id="buy" type="button">Buy</button><p id="result"></p></main></body></html>';
const SHOP_SCRIPT = "document.getElementById('buy').addEventListener('click', () => { document.getElementById('result').textContent = 'Bought'; });";
const FACTORY_TEXT = 'This page is the factory\'s own, so nothing is sent from it. The dashboard has its own point mode: press Shift+P.';
const NO_ANSWER = 'The factory window does not answer: see what it shows. A page that cuts off the windows it opens (Cross-Origin-Opener-Policy) cannot use point mode.';
const STATIC_TEXT = 'If this text stays, this browser has no session with the factory: open the dashboard (sf dashboard --open), then start point mode on the page again.';

// The shop: its page at / and its script, each with the policy; anything else a 404.
async function withShop(fn: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    const [type, body] = req.url === '/' ? ['text/html; charset=utf-8', SHOP_PAGE] : req.url === '/shop.js' ? ['text/javascript; charset=utf-8', SHOP_SCRIPT] : [undefined, ''];
    res.writeHead(type === undefined ? 404 : 200, { 'content-security-policy': SHOP_CSP, ...(type === undefined ? {} : { 'content-type': type }) });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://localhost:${(server.address() as AddressInfo).port}/`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// The dashboard's bookmarklet, decoded: the pins panel shown by point mode, its link read, the
// mode left.
async function bookmarklet(fx: Fixture): Promise<string> {
  await fx.open();
  await fx.page.keyboard.press('Shift+P');
  const link = fx.page.locator('#pins-bookmarklet');
  await link.waitFor();
  const href = await link.getAttribute('href');
  assert.ok(href !== null && href.startsWith('javascript:'), String(href));
  await fx.page.keyboard.press('Escape');
  assert.equal(await fx.page.locator('#point-toggle').getAttribute('aria-pressed'), 'false');
  return decodeURIComponent(href.slice('javascript:'.length));
}

const statusOf = (page: Page): Promise<string> => page.locator('#sf-point-status').innerText();

browserTest('point: the bookmarklet in a shop of another site with a strict CSP: Allow in the factory window, Point, a click on Buy (its handler does not run), a note and Save store a page pin; the marker shows; nothing is sent to the factory\'s origin; Escape; a second run closes the bar and the window', async (fx) => {
  const code = await bookmarklet(fx);
  const factory = new URL(fx.url).origin;
  assert.ok(code.endsWith(`pointOnPage(${JSON.stringify(factory)});})()`));
  await withShop(async (shopUrl) => {
    const shop = await fx.page.context().newPage();
    const sent: string[] = [];
    shop.on('request', (request) => sent.push(request.url()));
    await shop.goto(shopUrl);
    const opened = shop.waitForEvent('popup');
    await shop.evaluate(code);
    const factoryWindow = await opened;
    assert.equal(factoryWindow.url(), `${factory}/point`);
    const bar = shop.locator('#sf-point-bar');
    assert.equal(await bar.evaluate((node) => getComputedStyle(node).position), 'fixed');
    assert.equal(await shop.locator('#sf-point-toggle').isDisabled(), true);

    // Allow in the factory window, then Point.
    const allow = factoryWindow.locator('#point-allow');
    await allow.waitFor();
    await factoryWindow.waitForFunction(() => !(document.getElementById('point-allow') as HTMLButtonElement).disabled);
    await allow.click();
    await eventually(() => statusOf(shop), 'Allowed. Press Point, then click what you mean.');
    await shop.locator('#sf-point-toggle').click();
    assert.equal(await shop.locator('#sf-point-toggle').getAttribute('aria-pressed'), 'true');

    // A click on Buy: its own handler does not run; the note field opens next to it.
    await shop.locator('#buy').click();
    const note = shop.getByRole('dialog', { name: 'Note for the pin' });
    await note.waitFor();
    assert.equal(await shop.locator('#result').innerText(), '');
    await shop.locator('#sf-point-note-text').fill('Too expensive');
    await note.getByRole('button', { name: 'Save' }).click();
    const marker = shop.locator('#sf-point-layer [data-sf-pin="1"]');
    await marker.waitFor();
    assert.equal(await marker.innerText(), '📍1');
    await eventually(() => statusOf(shop), '📍1 saved.');
    const pins = (await readPins(fx.state)).pins.map(({ route, url, text, note: written }) => ({ route, url, text, note: written }));
    assert.deepEqual(pins, [{ route: '', url: shopUrl, text: 'Buy', note: 'Too expensive' }]);
    assert.deepEqual(await factoryWindow.locator('#point-list .point-row .point-id').allInnerTexts(), ['📍1']);
    // The shop sent nothing to the factory's origin.
    assert.deepEqual(sent.filter((url) => url.startsWith(factory)), []);

    // Escape unpresses Point; the shop's clicks are its own again.
    await shop.keyboard.press('Escape');
    assert.equal(await shop.locator('#sf-point-toggle').getAttribute('aria-pressed'), 'false');
    // A second run: the bar and the window close.
    const closed = factoryWindow.waitForEvent('close');
    await shop.evaluate(code);
    await closed;
    assert.equal(await bar.count(), 0);
    await shop.locator('#buy').click();
    assert.equal(await shop.locator('#result').innerText(), 'Bought');
  });
  assert.deepEqual(fx.problems, []);
});

browserTest('point: in a browser without a dashboard session the factory window keeps its static text and the bar says the window does not answer', async (fx) => {
  const code = await bookmarklet(fx);
  const browser = fx.page.context().browser();
  assert.ok(browser !== null);
  const context = await browser.newContext();
  try {
    await withShop(async (shopUrl) => {
      const shop = await context.newPage();
      await shop.goto(shopUrl);
      const opened = shop.waitForEvent('popup');
      await shop.evaluate(code);
      const factoryWindow = await opened;
      await factoryWindow.waitForLoadState();
      assert.equal(await statusOf(shop), 'Opening the factory window…');
      await shop.locator('#sf-point-status', { hasText: 'does not answer' }).waitFor({ timeout: 15000 });
      assert.equal(await statusOf(shop), NO_ANSWER);
      assert.equal(await factoryWindow.locator('#point-status').innerText(), STATIC_TEXT);
      assert.equal(await shop.locator('#sf-point-open').isVisible(), true);
    });
  } finally {
    await context.close();
  }
});

browserTest('point: on the dashboard itself the bookmarklet shows its bar alone with the factory\'s message, opens no window, and Shift+P still turns the dashboard\'s point mode on; × removes the bar', async (fx) => {
  const code = await bookmarklet(fx);
  assert.ok(new URL(fx.url).pathname.startsWith('/d/'));
  await fx.page.evaluate(code);
  assert.equal(await statusOf(fx.page), FACTORY_TEXT);
  assert.equal(fx.page.context().pages().length, 1);
  assert.equal(await fx.page.locator('#sf-point-toggle').isDisabled(), true);
  assert.equal(await fx.page.locator('#sf-point-open').isVisible(), false);
  const toggle = fx.page.locator('#point-toggle');
  await fx.page.keyboard.press('Shift+P');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  await fx.page.keyboard.press('Escape');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  await fx.page.locator('#sf-point-close').click();
  assert.equal(await fx.page.locator('#sf-point-bar').count(), 0);
  assert.equal(fx.page.context().pages().length, 1);
  assert.deepEqual(fx.problems, []);
});
