// Point mode in web/pins.ts (SF-211), run under node:vm against the fake page of
// test/support/fake-dom.ts: the Point button and Shift+P turn the mode on and off (aria-pressed, the
// body's class), not from a text field; Escape leaves the mode before it goes Back; the pins are
// read at the start, on a hashchange and when the mode is turned on; the panel lists the open pins
// (the current route's first, the board as Board) with Resolve and Delete, which post and redraw
// from the answer; a marker per pin found, element gone and element hidden for the others; every
// pin text stays text; the 📍 N button with the mode off; a click on window in the capture phase
// places a pin and opens the note field, whose Enter saves. Script checks; the real clicks, the
// outline and the layout are test/browser/pins.test.ts's. SF-267: on the local listener the panel
// offers the Point bookmarklet (pin-selector.js and point-page.js, read once), elsewhere or after a
// failed read it does not; the bookmarklet itself, run in a fresh context as a page of another
// site runs it (the factory window, its messages, pointing, the note field, the markers, stop),
// and on a page of the factory's own origin (the bar alone, nothing opened, sent or listened to).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { dashboardScriptFiles, pointScriptFiles } from '../src/dashboard.js';
import { cssEscape, FakeDocument, type FakeElement, type FetchRequest, loadPage, type Page, parseHtml } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
const RECT = { x: 10, y: 20, w: 120, h: 32, vw: 1280, vh: 800 };

interface TestPin { id: number; route: string; selector: string; text: string; note: string; resolved: boolean; url?: string }
const pin = (id: number, route: string, selector: string, text: string, note = '', resolved = false) => ({ id, route, selector, text, rect: RECT, note, at: '2026-11-14T09:00:00.000Z', resolved });

// The board (or the page at hash) with api/pins answering pins, as the test changes them.
async function openPage(pins: { list: TestPin[] }, hash = '', before?: (page: Page) => void): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs: [] } : path === 'api/pins' ? { pins: pins.list } : undefined));
  page.location.hash = hash;
  before?.(page);
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('jobs', { jobs: [] });
  await page.flush();
  return page;
}

const pinReads = (page: Page): number => page.requests.filter((request) => request.method === 'GET' && request.path === 'api/pins').length;
const posts = (page: Page): FetchRequest[] => page.requests.filter((request) => request.method === 'POST');
const pointing = (page: Page): [string | null, boolean] => [page.$('point-toggle').getAttribute('aria-pressed'), page.document.body.classList.contains('pointing')];
const rows = (page: Page): FakeElement[] => page.$('pins-list').querySelectorAll('li.pin-row');
const rowText = (row: FakeElement): string[] => ['.pin-id', '.pin-route', '.pin-place', '.pin-text', '.pin-note'].map((selector) => row.querySelector(selector)?.textContent ?? '-');
const markers = (page: Page): Array<[string, string, string, string]> => page.$('pin-layer').querySelectorAll('.pin-marker').map((marker) => [
  marker.textContent, (marker as unknown as { title: string }).title, marker.style.getPropertyValue('left'), marker.style.getPropertyValue('top'),
]);

test('the Point button and Shift+P turn the mode on and off (aria-pressed, body.pointing), on every page; Shift+P in a text field types; Escape leaves the mode before it goes Back', async () => {
  const page = await openPage({ list: [] }, '#stats');
  const toggle = page.$('point-toggle');
  assert.deepEqual([toggle.closest('.topbar') !== null, toggle.getAttribute('title'), toggle.textContent], [true, 'Point at something on the page (Shift+P)', 'Point']);
  assert.ok(toggle.parentNode!.children.indexOf(toggle) + 1 === toggle.parentNode!.children.indexOf(page.$('open-new-ticket')), 'before New ticket');
  assert.deepEqual(pointing(page), ['false', false]);
  toggle.click();
  assert.deepEqual(pointing(page), ['true', true]);
  toggle.click();
  assert.deepEqual(pointing(page), ['false', false]);
  const shiftP = page.key('P', { shiftKey: true });
  assert.deepEqual([pointing(page), shiftP.defaultPrevented], [['true', true], true]);
  // With Ctrl, Alt or Meta it is not point mode's key.
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
    page.key('P', { shiftKey: true, [modifier]: true });
    assert.deepEqual(pointing(page), ['true', true], modifier);
  }
  // Escape leaves the mode and does nothing else: the Stats page stays.
  const escape = page.key('Escape');
  assert.deepEqual([pointing(page), escape.defaultPrevented, page.location.hash, page.$('stats').hidden], [['false', false], true, '#stats', false]);
  // The next Escape goes Back to the board (whose hash the fake page keeps as '#').
  page.key('Escape');
  assert.deepEqual([page.location.hash, page.$('board').hidden], ['#', false]);
  // In a text field Shift+P is a P.
  page.$('workspace-description').focus();
  const typed = page.key('P', { shiftKey: true });
  assert.deepEqual([pointing(page), typed.defaultPrevented], [['false', false], false]);
});

test('a pin of another page (with url) is listed after the current route\'s pins, its address a link to a new tab, an http(s) one only; it has no marker and is never gone or hidden; one whose url is not a string is not listed', async () => {
  const page = await openPage({
    list: [
      { ...pin(1, '', '#open-board', 'Orders', 'Wrong total'), url: 'http://localhost:3000/orders' }, pin(2, '', '#open-new-ticket', 'New ticket'),
      { ...pin(3, '', '#nothing-here', 'Script'), url: 'javascript:alert(1)' }, { ...pin(4, '', '#open-stats', 'Not a string'), url: 5 } as unknown as TestPin,
      pin(5, 'stats', '#stats', 'Stats page'),
    ],
  }, '', (loaded) => {
    loaded.$('open-new-ticket').rect = { x: 100, y: 10, width: 110, height: 32 };
    loaded.$('open-board').rect = { x: 5, y: 5, width: 60, height: 30 };
  });
  // Only the board's own pin has a marker, though the first page pin's selector finds an element here.
  assert.deepEqual(markers(page).map(([text]) => text), ['📍2']);
  assert.equal(page.$('pins-open').textContent, '📍 4');
  page.$('pins-open').click();
  assert.deepEqual(rows(page).map(rowText), [
    ['📍2', 'Board', '-', 'New ticket', '-'], ['📍1', 'http://localhost:3000/orders', '-', 'Orders', 'Wrong total'],
    ['📍3', 'javascript:alert(1)', '-', 'Script', '-'], ['📍5', 'stats', '-', 'Stats page', '-'],
  ]);
  const links = rows(page).map((row) => row.querySelector('a.pin-route') as unknown as { href: string; target: string; rel: string });
  assert.deepEqual(links.map(({ href, target, rel }) => [href, target, rel]), [
    ['#', '', ''], ['http://localhost:3000/orders', '_blank', 'noopener noreferrer'], ['', '_blank', 'noopener noreferrer'], ['#stats', '', ''],
  ]);
  assert.equal(rows(page)[2]!.querySelector('a.pin-route')!.getAttribute('href'), null, 'not http(s): no href');
});

test('the pins are read at the start, on every hashchange and when the mode is turned on; the panel lists the open pins, the current route\'s first, the board as Board; element gone and element hidden', async () => {
  const pins = {
    list: [
      pin(1, 'stats', '#stats', 'Stats page', 'Too wide'), pin(2, '', '#open-new-ticket', 'New ticket'), pin(3, '', '#nothing-here', 'Gone'),
      pin(4, '', 'div:nth-of-type(', 'Bad selector'), pin(5, '', '#open-stats', 'Stats tab'), pin(6, '', '#open-board', 'Resolved', '', true),
    ],
  };
  const page = await openPage(pins, '', (loaded) => {
    loaded.$('open-new-ticket').rect = { x: 1250, y: -5, width: 110, height: 32 };
    loaded.$('open-board').rect = { x: 5, y: 5, width: 60, height: 30 };
  });
  assert.equal(pinReads(page), 1, 'at the start');
  // With the mode off, the panel is closed and the 📍 N button counts the open pins.
  assert.deepEqual([page.$('pins').hidden, page.$('pins-open').hidden, page.$('pins-open').textContent, page.$('pins-open').getAttribute('aria-label')], [true, false, '📍 5', 'Pins: 5 open pins']);
  // The markers show with the mode off: only the board's pin whose element is shown, kept inside
  // the viewport (1280 x 800), its title the text when there is no note.
  assert.deepEqual(markers(page), [['📍2', 'New ticket', '1236px', '0px']]);
  page.$('pins-open').click();
  assert.deepEqual([page.$('pins').hidden, page.$('pins-open').hidden, page.$('pins-title').textContent, page.$('pins-stop').hidden], [false, true, 'Pins (5 open)', true]);
  assert.deepEqual(rows(page).map(rowText), [
    ['📍2', 'Board', '-', 'New ticket', '-'], ['📍3', 'Board', 'element gone', 'Gone', '-'], ['📍4', 'Board', 'element gone', 'Bad selector', '-'],
    ['📍5', 'Board', 'element hidden', 'Stats tab', '-'], ['📍1', 'stats', '-', 'Stats page', 'Too wide'],
  ]);
  assert.deepEqual(rows(page).map((row) => row.querySelector('a')!.href), ['#', '#', '#', '#', '#stats']);
  page.$('pins-close').click();
  assert.deepEqual([page.$('pins').hidden, page.$('pins-open').hidden], [true, false]);

  // A hashchange reads them again; the current route's pins come first.
  pins.list = [...pins.list, pin(7, 'stats', '#open-digest', 'Digest tab', 'Next')];
  page.location.hash = '#stats';
  page.window.dispatch('hashchange');
  await page.flush();
  assert.equal(pinReads(page), 2);
  page.$('pins-open').click();
  assert.deepEqual(rows(page).map((row) => rowText(row).slice(0, 3)), [
    ['📍1', 'stats', 'element hidden'], ['📍7', 'stats', 'element hidden'], ['📍2', 'Board', '-'], ['📍3', 'Board', '-'], ['📍4', 'Board', '-'], ['📍5', 'Board', '-'],
  ]);
  // The mode turned on reads them again and shows the panel with Stop pointing.
  page.$('point-toggle').click();
  await page.flush();
  assert.deepEqual([pinReads(page), page.$('pins').hidden, page.$('pins-stop').hidden, page.$('pins-open').hidden], [3, false, false, true]);
  page.$('pins-refresh').click();
  await page.flush();
  assert.equal(pinReads(page), 4, 'Refresh');
  page.$('pins-stop').click();
  assert.deepEqual([pointing(page), page.$('pins').hidden], [['false', false], true]);
});

test('Resolve and Delete post at once and the panel is drawn from the answer; a refusal shows the server\'s message as text', async () => {
  const pins = { list: [pin(1, '', '#open-board', 'Board tab'), pin(2, '', '#open-stats', 'Stats tab')] };
  const page = await openPage(pins);
  page.$('pins-open').click();
  rows(page)[0]!.querySelectorAll('button').find((node) => node.textContent === 'Resolve')!.click();
  const resolve = posts(page).at(-1)!;
  assert.deepEqual([resolve.path, JSON.parse(resolve.body!)], ['api/pins/1', { resolved: true }]);
  resolve.respond(200, { ok: true, result: { pins: [{ ...pins.list[0]!, resolved: true }, pins.list[1]] } });
  await page.flush();
  assert.deepEqual([rows(page).map((row) => rowText(row)[0]), page.$('pins-title').textContent], [['📍2'], 'Pins (1 open)']);
  rows(page)[0]!.querySelectorAll('button').find((node) => node.textContent === 'Delete')!.click();
  const remove = posts(page).at(-1)!;
  assert.deepEqual([remove.path, JSON.parse(remove.body!)], ['api/pins/2/remove', {}]);
  remove.respond(409, { ok: false, error: { code: 'pins_unreadable', message: '<b>pins.json</b> is unreadable' } });
  await page.flush();
  assert.deepEqual([page.$('pins-status').textContent, page.$('pins-status').children.every((child) => child.nodeType === 3), rows(page).length], ['<b>pins.json</b> is unreadable', true, 1]);
  rows(page)[0]!.querySelectorAll('button').find((node) => node.textContent === 'Delete')!.click();
  posts(page).at(-1)!.respond(200, { ok: true, result: { pins: [{ ...pins.list[0]!, resolved: true }] } });
  await page.flush();
  assert.deepEqual([rows(page).length, page.$('pins-status').textContent, page.$('pins-title').textContent], [0, '', 'Pins (0 open)']);
  page.$('pins-close').click();
  assert.equal(page.$('pins-open').hidden, true, 'no open pin: no button');
});

test('a note, a text or a route holding <script> or <img onerror> stays text in the panel and on the marker', async () => {
  const script = '<script>alert(1)</script>';
  const image = '<img src=x onerror=alert(1)>';
  const page = await openPage({ list: [pin(1, '', '#open-board', image, script), pin(2, `${image}/x`, '#x', script, image)] }, '', (loaded) => {
    loaded.$('open-board').rect = { x: 5, y: 5, width: 60, height: 30 };
  });
  page.$('pins-open').click();
  assert.deepEqual(rows(page).map(rowText), [['📍1', 'Board', '-', image, script], ['📍2', `${image}/x`, '-', script, image]]);
  assert.deepEqual(markers(page).map(([text, title]) => [text, title]), [['📍1', script]]);
  // What the page drew: the rows and the markers, with no element but its own.
  for (const root of [page.$('pins-list'), page.$('pin-layer')]) {
    assert.equal(root.querySelectorAll('script, img').length, 0);
    for (const node of root.all()) {
      assert.ok(node.children.every((child) => child.nodeType === 3 || ['SPAN', 'A', 'DIV', 'BUTTON', 'LI'].includes((child as FakeElement).tagName)), node.tagName);
    }
  }
});

test('in point mode a click (on window, in the capture phase) is stopped and places a pin; the note field opens and Enter saves; the pins\' own elements are not stopped; a DOM change draws the markers again', async () => {
  const pins = { list: [] as TestPin[] };
  const page = await openPage(pins, '', (loaded) => {
    loaded.$('open-new-ticket').rect = { x: 1100.4, y: 8.6, width: 110, height: 32 };
  });
  const target = page.$('open-new-ticket');
  const click = (node: FakeElement, type = 'click') => page.window.dispatch(type, {
    type, target: node, clientX: 1150, clientY: 20, defaultPrevented: false, stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
  });
  // With the mode off nothing is stopped.
  assert.deepEqual([click(target).defaultPrevented, posts(page).length], [false, 0]);
  page.key('P', { shiftKey: true });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick', 'dragstart']) {
    const event = click(target, type);
    assert.deepEqual([event.defaultPrevented, event.stopped], [true, true], type);
  }
  assert.equal(posts(page).length, 0, 'only the click places');
  // The pins' own elements get their clicks; html and body place nothing.
  for (const own of [page.$('point-toggle'), page.$('pins-refresh'), page.$('pins-open')]) {
    assert.equal(click(own).defaultPrevented, false, own.id);
  }
  assert.deepEqual([click(page.document.body).defaultPrevented, posts(page).length], [true, 0]);
  const placed = click(target);
  assert.deepEqual([placed.defaultPrevented, placed.stopped], [true, true]);
  const add = posts(page).at(-1)!;
  assert.deepEqual([add.path, JSON.parse(add.body!)], ['api/pins', { route: '', selector: '#open-new-ticket', text: 'New ticket', rect: { x: 1100, y: 9, w: 110, h: 32, vw: 1280, vh: 800 }, note: '' }]);
  const stored = pin(1, '', '#open-new-ticket', 'New ticket');
  add.respond(200, { ok: true, result: { pin: stored, pins: [stored] } });
  await page.flush();
  const note = page.$('pin-note');
  assert.deepEqual([note.hidden, note.getAttribute('aria-label'), note.getAttribute('role'), page.document.activeElement?.id], [false, 'Note for pin 1', 'dialog', 'pin-note-text']);
  assert.equal(page.$('pin-note-text').getAttribute('maxlength'), '500');
  assert.deepEqual(markers(page).map(([text]) => text), ['📍1']);
  // While the note field is open, a click outside it places nothing.
  click(page.$('open-board'));
  assert.equal(posts(page).length, 1);
  (page.$('pin-note-text') as unknown as { value: string }).value = 'Make it say Plan';
  const shiftEnter = page.key('Enter', { shiftKey: true });
  assert.deepEqual([shiftEnter.defaultPrevented, posts(page).length], [false, 1], 'Shift+Enter is a new line');
  page.key('Enter');
  const save = posts(page).at(-1)!;
  assert.deepEqual([save.path, JSON.parse(save.body!)], ['api/pins/1', { note: 'Make it say Plan' }]);
  save.respond(200, { ok: true, result: { pins: [{ ...stored, note: 'Make it say Plan' }] } });
  await page.flush();
  assert.deepEqual([note.hidden, markers(page).map(([, title]) => title)], [true, ['Make it say Plan']]);
  // A refused pin: the server's message in the panel, no note field.
  click(target);
  posts(page).at(-1)!.respond(409, { ok: false, error: { code: 'too_many_pins', message: '50 pins are open already; resolve or delete one first.' } });
  await page.flush();
  assert.deepEqual([note.hidden, page.$('pins').hidden, page.$('pins-status').textContent], [true, false, '50 pins are open already; resolve or delete one first.']);
  // The element moves: a DOM change outside the pins' elements draws the markers again, once per
  // frame; one inside them does not.
  target.rect = { x: 300, y: 400, width: 110, height: 32 };
  const [observer] = page.observers;
  assert.deepEqual(observer!.observed.map((entry) => [entry.target === page.document.body, JSON.stringify(entry.options)]), [[true, '{"childList":true,"subtree":true}']]);
  observer!.notify(page.$('pin-layer'), page.$('pins-list'));
  await page.flush();
  assert.deepEqual(markers(page).map(([, , left, top]) => [left, top]), [['1100px', '9px']]);
  observer!.notify(page.$('cols'), page.$('cols'));
  await page.flush();
  assert.deepEqual(markers(page).map(([, , left, top]) => [left, top]), [['300px', '400px']]);
  // A scroll draws them again too.
  target.rect = { x: 320, y: 120, width: 110, height: 32 };
  page.window.dispatch('scroll');
  await page.flush();
  assert.deepEqual(markers(page).map(([, , left, top]) => [left, top]), [['320px', '120px']]);
  // Escape in the note field is Skip (the pin stays without a note); the mode stays until the next Escape.
  click(target);
  const second = pin(2, '', '#open-new-ticket', 'New ticket');
  posts(page).at(-1)!.respond(200, { ok: true, result: { pin: second, pins: [{ ...stored, note: 'Make it say Plan' }, second] } });
  await page.flush();
  assert.equal(note.hidden, false);
  // Enter on a button of the note field is that button's, never Save.
  page.$('pin-note-skip').focus();
  assert.deepEqual([page.key('Enter').defaultPrevented, posts(page).length], [false, 4]);
  page.$('pin-note-text').focus();
  // The window's Escape in the capture phase leaves the open note field to its own Escape.
  const early = keyEvent('Escape');
  page.window.dispatch('keydown', early);
  assert.deepEqual([early.stopped, pointing(page)], [false, ['true', true]]);
  const skip = page.key('Escape');
  assert.deepEqual([skip.defaultPrevented, note.hidden, pointing(page), posts(page).length], [true, true, ['true', true], 4]);
  // Escape reaches the window first (capture): the mode is left and no element's own Escape (a
  // confirmation's) runs after it.
  const escape = keyEvent('Escape');
  page.window.dispatch('keydown', escape);
  assert.deepEqual([escape.defaultPrevented, escape.stopped, pointing(page)], [true, true, ['false', false]]);
});

test('a note refused with pin_holds_token shows the server\'s message as text in the panel\'s status line and the note field stays open with what was typed; the note changed and saved closes it', async () => {
  const page = await openPage({ list: [] });
  const target = page.$('open-new-ticket');
  const click = (node: FakeElement, type = 'click') => page.window.dispatch(type, {
    type, target: node, clientX: 1150, clientY: 20, defaultPrevented: false, stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
  });
  page.key('P', { shiftKey: true });
  click(target);
  const stored = pin(1, '', '#open-new-ticket', 'New ticket');
  posts(page).at(-1)!.respond(200, { ok: true, result: { pin: stored, pins: [stored] } });
  await page.flush();
  const note = page.$('pin-note');
  const field = page.$('pin-note-text') as unknown as { value: string };
  const typed = 'Open http://127.0.0.1:4000/d/<token>/ here';
  field.value = typed;
  page.key('Enter');
  const message = "A pin cannot hold the dashboard's token (the secret in the dashboard's address); nothing was saved.";
  const refused = posts(page).at(-1)!;
  assert.deepEqual([refused.path, JSON.parse(refused.body!)], ['api/pins/1', { note: typed }]);
  refused.respond(400, { ok: false, error: { code: 'pin_holds_token', message } });
  await page.flush();
  const status = page.$('pins-status');
  assert.deepEqual([note.hidden, field.value, status.textContent, status.children.every((child) => child.nodeType === 3)], [false, typed, message, true]);
  field.value = 'Make it say Plan';
  page.key('Enter');
  const saved = posts(page).at(-1)!;
  assert.deepEqual([saved.path, JSON.parse(saved.body!)], ['api/pins/1', { note: 'Make it say Plan' }]);
  saved.respond(200, { ok: true, result: { pins: [{ ...stored, note: 'Make it say Plan' }] } });
  await page.flush();
  assert.deepEqual([note.hidden, status.textContent], [true, '']);
});

// A keydown as the window's capture listeners get it, with what they did to it.
function keyEvent(key: string, target: unknown = null) {
  return {
    type: 'keydown', key, target, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false, stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
  };
}

// ---------- The Point bookmarklet ----------

const FACTORY = 'http://127.0.0.1:8788';
const SHOP = 'http://localhost:3000';
const STATUS = {
  FACTORY: 'This page is the factory\'s own, so nothing is sent from it. The dashboard has its own point mode: press Shift+P.',
  OPENING: 'Opening the factory window…',
  BLOCKED: 'The browser blocked the factory window: allow pop-ups for this page, or press Open the factory window.',
  ALLOW: 'Allow this page in the factory window.',
  PRESS: 'Allowed. Press Point, then click what you mean.',
  POINTING: 'Click what you mean. Escape stops pointing.',
  REFUSED: 'The factory did not save the pin: the factory window says why.',
  NO_ANSWER: 'The factory window does not answer: see what it shows. A page that cuts off the windows it opens (Cross-Origin-Opener-Policy) cannot use point mode.',
  CLOSED: 'The factory window is closed: press Open the factory window.',
  TOO_LONG: 'This element cannot be pinned.',
};

// The compiled pin-selector.js and point-page.js, as the dashboard serves them.
async function bookmarkletScripts(): Promise<{ selector: string; page: string }> {
  const selector = await readFile(dashboardScriptFiles().find(({ file }) => file === 'pin-selector.js')!.url, 'utf8');
  const page = await readFile(pointScriptFiles().find(({ file }) => file === 'point-page.js')!.url, 'utf8');
  return { selector, page };
}

// The dashboard on the local listener (or the host given) with the panel open by the mode, the
// two scripts answered by answer (undefined: left pending for the test).
async function openPanel(hostname: string, answer: (path: string) => string | undefined): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => (path === 'api/jobs' ? { jobs: [] } : path === 'api/pins' ? { pins: [] } : answer(path)));
  Object.assign(page.location, { origin: `http://${hostname}:8788`, hostname });
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  page.streams.at(-1)!.emit('open');
  page.streams.at(-1)!.emit('jobs', { jobs: [] });
  await page.flush();
  return page;
}

const scriptReads = (page: Page): FetchRequest[] => page.requests.filter((request) => request.path === 'pin-selector.js' || request.path === 'point-page.js');

test('on 127.0.0.1 the panel reads pin-selector.js and point-page.js once and its line offers the bookmarklet: the factory\'s origin, no dashboard path; a click on it is prevented; another host or a failed read keeps the line hidden', async () => {
  const { selector, page: script } = await bookmarkletScripts();
  const page = await openPanel('127.0.0.1', (path) => (path === 'pin-selector.js' ? selector : path === 'point-page.js' ? script : undefined));
  const line = page.$('pins-elsewhere');
  assert.deepEqual([line.hidden, scriptReads(page).length], [true, 0], 'the panel is closed: nothing read');
  page.$('point-toggle').click();
  await page.flush();
  const reads = scriptReads(page);
  assert.deepEqual(reads.map(({ path, method }) => [path, method]), [['pin-selector.js', 'GET'], ['point-page.js', 'GET']]);
  assert.equal(line.hidden, false);
  const link = page.$('pins-bookmarklet');
  assert.deepEqual([link.textContent, link.getAttribute('title'), line.textContent], ['📍 Point', 'Drag to the bookmarks bar', 'On other pages: drag 📍 Point to your bookmarks bar, then click it on the page.']);
  assert.ok(link.href.startsWith('javascript:'));
  const code = decodeURIComponent(link.href.slice('javascript:'.length));
  assert.equal(code, `(()=>{${selector}\n${script}\npointOnPage("${FACTORY}");})()`);
  assert.ok(!code.includes('/d/'));
  assert.equal(link.dispatch('click').defaultPrevented, true);
  // The panel shown again reads nothing again.
  page.$('pins-stop').click();
  page.$('point-toggle').click();
  await page.flush();
  assert.equal(scriptReads(page).length, 2);

  // Another host: nothing read, the line hidden.
  const remote = await openPanel('pc.tail1234.ts.net', (path) => (path === 'pin-selector.js' ? selector : path === 'point-page.js' ? script : undefined));
  remote.$('point-toggle').click();
  await remote.flush();
  assert.deepEqual([scriptReads(remote).length, remote.$('pins-elsewhere').hidden, remote.$('pins').hidden], [0, true, false]);

  // A 404: the line stays hidden, and the panel shown again does not ask again.
  const failed = await openPanel('127.0.0.1', (path) => (path === 'pin-selector.js' ? selector : undefined));
  failed.$('point-toggle').click();
  await failed.flush();
  scriptReads(failed).find(({ path }) => path === 'point-page.js')!.respond(404, '');
  await failed.flush();
  assert.deepEqual([failed.$('pins-elsewhere').hidden, failed.$('pins-bookmarklet').href], [true, '#']);
  failed.$('pins-stop').click();
  failed.$('point-toggle').click();
  await failed.flush();
  assert.equal(scriptReads(failed).length, 2);
});

interface Recorded { type: string; listener: (event: unknown) => void }
interface PageRun {
  document: FakeDocument;
  $(id: string): FakeElement | null;
  status(): string;
  // window.open's calls; the factory window it returned last.
  opened: Array<[string, string, string]>;
  factoryWindow: { closed: boolean; posted: Array<[unknown, string]>; close(): void };
  timers: Array<{ ms: number; cleared: boolean; fire(): void }>;
  frames: Array<() => void>;
  // Every listener added to window and to document, and the ones still on window.
  added: Recorded[];
  windowListeners: Recorded[];
  host: { blockPopups: boolean; sfPointStop?: unknown };
  // The window's listeners of type get the event; what they did to it.
  fire(type: string, init: Record<string, unknown>): { defaultPrevented: boolean; stopped: boolean };
  message(data: unknown, origin?: string, source?: unknown): void;
  // The bookmarklet run again in the same page.
  again(): void;
}

// The bookmarklet run in a fresh context: a page of its own (a Buy button), a window whose open
// records its arguments and returns a factory window recording postMessage (or null, blocked),
// recorded timers and animation frames, CSS.escape, the location given.
function runOnPage(code: string, location: { href: string; origin: string }, blocked = false): PageRun {
  const document = new FakeDocument();
  parseHtml(document, '<body><main><h1>Shop</h1><button id="buy" type="button">Buy</button><p>Total</p></main></body>');
  const added: Recorded[] = [];
  const windowListeners: Recorded[] = [];
  const realAdd = document.addEventListener.bind(document);
  document.addEventListener = (type, listener) => {
    added.push({ type, listener: listener as (event: unknown) => void });
    realAdd(type, listener);
  };
  const opened: PageRun['opened'] = [];
  const newWindow = (): PageRun['factoryWindow'] => {
    const posted: Array<[unknown, string]> = [];
    return {
      closed: false, posted,
      postMessage(data: unknown, target: string) {
        posted.push([JSON.parse(JSON.stringify(data)), target]);
      },
      close() {
        this.closed = true;
      },
    } as PageRun['factoryWindow'];
  };
  const run = {} as PageRun;
  const host = {
    blockPopups: blocked, innerWidth: 1280, innerHeight: 800,
    open(url: string, target: string, features: string) {
      opened.push([url, target, features]);
      if (host.blockPopups) {
        return null;
      }
      run.factoryWindow = newWindow();
      return run.factoryWindow;
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      added.push({ type, listener });
      windowListeners.push({ type, listener });
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      const at = windowListeners.findIndex((entry) => entry.type === type && entry.listener === listener);
      if (at >= 0) {
        windowListeners.splice(at, 1);
      }
    },
  } as PageRun['host'] & Record<string, unknown>;
  const timers: PageRun['timers'] = [];
  const frames: Array<() => void> = [];
  const context = createContext({
    window: host, document, location, CSS: { escape: cssEscape }, console,
    setTimeout: (callback: () => void, ms: number) => timers.push({ ms, cleared: false, fire: callback }),
    clearTimeout: (id: number | undefined) => {
      if (typeof id === 'number' && timers[id - 1] !== undefined) {
        timers[id - 1]!.cleared = true;
      }
    },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  });
  Object.assign(run, {
    document, opened, timers, frames, added, host, windowListeners,
    $: (id: string) => document.getElementById(id),
    status: () => document.getElementById('sf-point-status')?.textContent ?? '-',
    fire(type: string, init: Record<string, unknown>) {
      const event = {
        type, defaultPrevented: false, stopped: false, shiftKey: false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        stopImmediatePropagation() {
          event.stopped = true;
        },
        ...init,
      };
      for (const { listener } of windowListeners.filter((entry) => entry.type === type)) {
        listener(event);
        if (event.stopped) {
          break;
        }
      }
      return event;
    },
    message(data: unknown, origin = FACTORY, source: unknown = run.factoryWindow) {
      run.fire('message', { data, origin, source });
    },
    again() {
      runInContext(code, context);
    },
  });
  run.again();
  return run;
}

// The decoded bookmarklet the panel offers on 127.0.0.1:8788.
async function decodedBookmarklet(): Promise<string> {
  const { selector, page: script } = await bookmarkletScripts();
  const page = await openPanel('127.0.0.1', (path) => (path === 'pin-selector.js' ? selector : path === 'point-page.js' ? script : undefined));
  page.$('point-toggle').click();
  await page.flush();
  return decodeURIComponent(page.$('pins-bookmarklet').href.slice('javascript:'.length));
}

const toggleOf = (run: PageRun): [boolean, string | null] => [run.$('sf-point-toggle')!.disabled, run.$('sf-point-toggle')!.getAttribute('aria-pressed')];

test('the bookmarklet on another site opens <factory>/point as sf-point, says hello once the window is ready, enables Point once allowed; another origin or source changes nothing; pointing stops the page\'s clicks and sends each pin with its note; saved draws its marker; a second run stops it all', async () => {
  const code = await decodedBookmarklet();
  const run = runOnPage(code, { href: `${SHOP}/shop`, origin: SHOP });
  assert.deepEqual(run.opened, [[`${FACTORY}/point`, 'sf-point', 'popup,width=440,height=420']]);
  assert.deepEqual([run.status(), toggleOf(run), run.$('sf-point-open')!.hidden], [STATUS.OPENING, [true, 'false'], true]);
  const bar = run.$('sf-point-bar')!;
  assert.equal(bar.parentNode, run.document.documentElement);
  assert.deepEqual([bar.style.getPropertyValue('all'), bar.style.getPropertyValue('position'), bar.style.getPropertyValue('z-index')], ['initial', 'fixed', '2147483647']);
  assert.deepEqual([run.$('sf-point-status')!.getAttribute('role'), run.$('sf-point-status')!.getAttribute('aria-live'), run.$('sf-point-close')!.getAttribute('aria-label')], ['status', 'polite', 'Close point mode']);
  assert.deepEqual(['sf-point-outline', 'sf-point-note', 'sf-point-layer'].map((id) => run.$(id)?.parentNode === run.document.documentElement), [true, true, true]);
  assert.deepEqual(run.timers.map(({ ms, cleared }) => [ms, cleared]), [[10000, false]]);
  // A message of another origin, of another source, or not the window's: nothing changes.
  run.message({ sf: 'point', type: 'ready' }, 'http://evil.example');
  run.message({ sf: 'point', type: 'ready' }, FACTORY, {});
  run.message({ sf: 'other', type: 'ready' });
  run.message({ sf: 'point', type: 'allowed' }, SHOP);
  assert.deepEqual([run.factoryWindow.posted, run.status(), toggleOf(run), run.timers[0]!.cleared], [[], STATUS.OPENING, [true, 'false'], false]);
  run.message({ sf: 'point', type: 'ready' });
  assert.deepEqual(run.factoryWindow.posted, [[{ sf: 'point', type: 'hello', url: `${SHOP}/shop` }, FACTORY]]);
  assert.deepEqual([run.status(), toggleOf(run), run.timers[0]!.cleared], [STATUS.ALLOW, [true, 'false'], true]);
  // Before Point is pressed, the page's clicks are its own.
  const buy = run.$('buy')!;
  buy.rect = { x: 100.4, y: 50.6, width: 80, height: 30 };
  assert.equal(run.fire('click', { target: buy, clientX: 120, clientY: 60 }).defaultPrevented, false);
  run.message({ sf: 'point', type: 'allowed' });
  assert.deepEqual([run.status(), toggleOf(run)], [STATUS.PRESS, [false, 'false']]);
  run.$('sf-point-toggle')!.click();
  assert.deepEqual([run.status(), toggleOf(run)], [STATUS.POINTING, [false, 'true']]);

  // Pointing: every pointer and mouse event outside the bar and the note field is stopped.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick', 'dragstart']) {
    const event = run.fire(type, { target: buy });
    assert.deepEqual([event.defaultPrevented, event.stopped], [true, true], type);
  }
  assert.equal(run.fire('click', { target: run.$('sf-point-toggle') }).defaultPrevented, false, 'the bar\'s own');
  assert.deepEqual([run.fire('click', { target: run.document.body }).defaultPrevented, run.$('sf-point-note')!.hidden], [true, true], 'body: nothing taken');
  run.fire('pointerover', { target: buy });
  const outline = run.$('sf-point-outline')!;
  assert.deepEqual([outline.hidden, outline.style.getPropertyValue('left'), outline.style.getPropertyValue('width')], [false, '100px', '80px']);
  const click = run.fire('click', { target: buy, clientX: 120, clientY: 60 });
  assert.deepEqual([click.defaultPrevented, click.stopped], [true, true]);
  const note = run.$('sf-point-note')!;
  const text = run.$('sf-point-note-text') as unknown as FakeElement & { value: string; maxLength: number; placeholder: string };
  assert.deepEqual([note.hidden, note.getAttribute('role'), note.getAttribute('aria-label'), run.document.activeElement?.id], [false, 'dialog', 'Note for the pin', 'sf-point-note-text']);
  assert.deepEqual([text.maxLength, text.placeholder, note.style.getPropertyValue('left'), note.style.getPropertyValue('top')], [500, 'What about it? (optional)', '132px', '72px']);
  // With the note field open, a click places nothing more.
  run.fire('click', { target: run.document.querySelector('p')!, clientX: 5, clientY: 5 });
  assert.equal(run.factoryWindow.posted.length, 1);
  text.value = 'Wrong price';
  assert.equal(run.fire('keydown', { key: 'Enter', shiftKey: true, target: text }).defaultPrevented, false, 'Shift+Enter is a new line');
  const enter = run.fire('keydown', { key: 'Enter', target: text });
  assert.deepEqual([enter.defaultPrevented, enter.stopped, note.hidden], [true, true, true]);
  const rect = { x: 100, y: 51, w: 80, h: 30, vw: 1280, vh: 800 };
  assert.deepEqual(run.factoryWindow.posted.at(-1), [{ sf: 'point', type: 'pin', ref: 1, url: `${SHOP}/shop`, selector: '#buy', text: 'Buy', rect, note: 'Wrong price' }, FACTORY]);
  run.message({ sf: 'point', type: 'saved', ref: 1, id: 7 });
  const markers = () => run.$('sf-point-layer')!.children.map((marker) => [marker.textContent, (marker as FakeElement).dataset.sfPin, (marker as FakeElement).style.getPropertyValue('left'), (marker as FakeElement).style.getPropertyValue('top')]);
  assert.deepEqual([run.status(), markers()], ['📍7 saved.', [['📍7', '7', '100px', '51px']]]);
  // A scroll draws the markers again in one animation frame.
  buy.rect = { x: 100, y: 10, width: 80, height: 30 };
  run.fire('scroll', {});
  run.fire('resize', {});
  assert.equal(run.frames.length, 1);
  run.frames[0]!();
  assert.deepEqual(markers(), [['📍7', '7', '100px', '10px']]);
  // Escape in the note field is Skip: the pin goes with an empty note; refused says so.
  run.fire('click', { target: run.document.querySelector('p')!, clientX: 5, clientY: 5 });
  const skip = run.fire('keydown', { key: 'Escape', target: text });
  assert.deepEqual([skip.stopped, toggleOf(run)], [true, [false, 'true']]);
  assert.deepEqual(run.factoryWindow.posted.at(-1)![0], { sf: 'point', type: 'pin', ref: 2, url: `${SHOP}/shop`, selector: 'body > main:nth-of-type(1) > p:nth-of-type(1)', text: 'Total', rect: { x: 0, y: 0, w: 0, h: 0, vw: 1280, vh: 800 }, note: '' });
  run.message({ sf: 'point', type: 'refused', ref: 2 });
  assert.equal(run.status(), STATUS.REFUSED);
  // Escape with the note field closed stops pointing and goes no further.
  const escape = run.fire('keydown', { key: 'Escape', target: run.document.body });
  assert.deepEqual([escape.defaultPrevented, escape.stopped, toggleOf(run), run.status()], [true, true, [false, 'false'], STATUS.PRESS]);
  assert.equal(run.fire('click', { target: buy }).defaultPrevented, false);
  // The window closed: the next pin is not sent, Open shows.
  run.$('sf-point-toggle')!.click();
  run.fire('click', { target: buy, clientX: 120, clientY: 60 });
  run.factoryWindow.closed = true;
  run.$('sf-point-note')!.querySelectorAll('button').find((button) => button.textContent === 'Save')!.click();
  assert.deepEqual([run.status(), run.$('sf-point-open')!.hidden, run.factoryWindow.posted.length, toggleOf(run)], [STATUS.CLOSED, false, 3, [true, 'false']]);

  // A second run: every element and listener gone, the window closed, sfPointStop deleted.
  run.factoryWindow.closed = false;
  const factoryWindow = run.factoryWindow;
  run.again();
  assert.deepEqual(['sf-point-bar', 'sf-point-outline', 'sf-point-note', 'sf-point-layer'].map((id) => run.$(id)), [null, null, null, null]);
  assert.deepEqual([run.windowListeners.length, factoryWindow.closed, 'sfPointStop' in run.host, run.opened.length], [0, true, false, 1]);
  assert.equal(run.timers.every(({ cleared }) => cleared), true);
});

test('the bookmarklet: a blocked window is BLOCKED with Open, which opens it again; no ready in 10 s is NO_ANSWER; a selector over the bound is TOO_LONG; × stops it', async () => {
  const code = await decodedBookmarklet();
  const run = runOnPage(code, { href: `${SHOP}/`, origin: SHOP }, true);
  assert.deepEqual([run.opened.length, run.status(), run.$('sf-point-open')!.hidden, run.timers.length, toggleOf(run)], [1, STATUS.BLOCKED, false, 0, [true, 'false']]);
  run.host.blockPopups = false;
  run.$('sf-point-open')!.click();
  assert.deepEqual([run.opened.length, run.status(), run.$('sf-point-open')!.hidden, run.timers.length], [2, STATUS.OPENING, true, 1]);
  run.timers[0]!.fire();
  assert.deepEqual([run.status(), run.$('sf-point-open')!.hidden], [STATUS.NO_ANSWER, false]);
  // Open again restarts the one timer; ready clears it.
  run.$('sf-point-open')!.click();
  assert.deepEqual([run.timers.map(({ cleared }) => cleared), run.status()], [[false, false], STATUS.OPENING]);
  run.message({ sf: 'point', type: 'ready' });
  run.message({ sf: 'point', type: 'allowed' });
  assert.equal(run.timers[1]!.cleared, true);
  // An element whose selector is over 1,000 characters cannot be pinned.
  let deep = run.$('buy')!;
  for (let level = 0; level < 80; level += 1) {
    const div = run.document.createElement('div');
    deep.append(div);
    deep = div;
  }
  run.$('sf-point-toggle')!.click();
  run.fire('click', { target: deep, clientX: 1, clientY: 1 });
  assert.deepEqual([run.status(), run.$('sf-point-note')!.hidden, run.factoryWindow.posted.length], [STATUS.TOO_LONG, true, 1]);
  const factoryWindow = run.factoryWindow;
  run.$('sf-point-close')!.click();
  assert.deepEqual([run.$('sf-point-bar'), run.windowListeners.length, factoryWindow.closed, 'sfPointStop' in run.host], [null, 0, true, false]);
  // Run again after a stop: a new run, a new window.
  run.again();
  assert.deepEqual([run.opened.length, run.status()], [4, STATUS.OPENING]);
});

test('the bookmarklet on a page of the factory\'s origin shows its bar alone with FACTORY: no window, no timer, no listener on window or document; a second run or × removes it; on localhost of the same port it runs as on any page', async () => {
  const code = await decodedBookmarklet();
  const run = runOnPage(code, { href: `${FACTORY}/d/${'a'.repeat(64)}/#stats`, origin: FACTORY });
  assert.deepEqual([run.opened, run.timers, run.added, run.document.listeners.size], [[], [], [], 0]);
  assert.deepEqual([run.status(), toggleOf(run), run.$('sf-point-open')!.hidden], [STATUS.FACTORY, [true, 'false'], true]);
  assert.deepEqual(['sf-point-outline', 'sf-point-note', 'sf-point-layer'].map((id) => run.$(id)), [null, null, null]);
  assert.equal(run.$('sf-point-bar')!.parentNode, run.document.documentElement);
  run.again();
  assert.deepEqual([run.$('sf-point-bar'), 'sfPointStop' in run.host, run.opened.length], [null, false, 0]);
  run.again();
  run.$('sf-point-close')!.click();
  assert.deepEqual([run.$('sf-point-bar'), 'sfPointStop' in run.host, run.opened, run.added], [null, false, [], []]);

  const other = runOnPage(code, { href: 'http://localhost:8788/d/x/', origin: 'http://localhost:8788' });
  assert.deepEqual([other.opened.map(([url]) => url), other.status()], [[`${FACTORY}/point`], STATUS.OPENING]);
});
