// Point mode in web/pins.ts (SF-211), run under node:vm against the fake page of
// test/support/fake-dom.ts: the Point button and Shift+P turn the mode on and off (aria-pressed, the
// body's class), not from a text field; Escape leaves the mode before it goes Back; the pins are
// read at the start, on a hashchange and when the mode is turned on; the panel lists the open pins
// (the current route's first, the board as Board) with Resolve and Delete, which post and redraw
// from the answer; a marker per pin found, element gone and element hidden for the others; every
// pin text stays text; the 📍 N button with the mode off; a click on window in the capture phase
// places a pin and opens the note field, whose Enter saves. Script checks; the real clicks, the
// outline and the layout are test/browser/pins.test.ts's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FakeElement, type FetchRequest, loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
const RECT = { x: 10, y: 20, w: 120, h: 32, vw: 1280, vh: 800 };

interface TestPin { id: number; route: string; selector: string; text: string; note: string; resolved: boolean }
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
