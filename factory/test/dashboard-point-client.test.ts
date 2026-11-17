// The factory window, static/point.html with web/point.ts's point.js, run under node:vm against the
// fake document of test/support/fake-dom.ts: a window whose opener records every postMessage with
// its target, message events the test dispatches as {data, origin, source}, a recording fetch the
// test answers, timers the test fires. Without an opener the window has nothing to do; with one it
// posts ready to '*', takes only its opener's well-formed messages, binds the origin of the first
// hello from an http(s) page, enables Allow a second later, and after Allow saves that origin's
// pins through POST api/pins, answering saved or refused to that origin only; every text stays text.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { pointScriptFiles } from '../src/dashboard.js';
import { type FakeElement, FakeDocument, parseHtml } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
const PAGE = 'http://localhost:3000';
const RECT = { x: 10, y: 20, w: 120, h: 32, vw: 1280, vh: 800 };
const STATIC_TEXT = 'If this text stays, this browser has no session with the factory: open the dashboard (sf dashboard --open), then start point mode on the page again.';
const NO_OPENER = 'This window saves the pins of the page that opens it. Opened on its own, it has nothing to do.';
const WAITING = 'Waiting for the page…';
const NO_ADDRESS = 'This page has no web address (a file or a sandboxed page): it cannot send pins.';
const ASK = 'Allow this page below, or close this window.';
const allowedText = (origin: string): string => `Pins from ${origin} are saved here. Keep this window open while you point.`;

interface Request { path: string; method: string; headers: Record<string, string>; body: unknown; respond(status: number, body?: unknown): void; fail(): void }

interface FactoryWindow {
  $(id: string): FakeElement;
  status(): string;
  // What the window posted to its opener: [data, target], the data as plain JSON.
  posted: Array<[unknown, string]>;
  requests: Request[];
  timers: Array<{ ms: number; fire(): void }>;
  listeners: number;
  opener: object;
  // A message event from source (the opener by default).
  send(data: unknown, origin?: string, source?: object): void;
  flush(): Promise<void>;
}

async function loadHtml(): Promise<FakeDocument> {
  const document = new FakeDocument();
  parseHtml(document, await readFile(new URL('point.html', STATIC_DIR), 'utf8'));
  return document;
}

async function openWindow(withOpener = true): Promise<FactoryWindow> {
  const document = await loadHtml();
  const source = await readFile(pointScriptFiles()[0]!.url, 'utf8');
  const posted: Array<[unknown, string]> = [];
  const opener = {
    postMessage: (data: unknown, target: string): void => {
      posted.push([JSON.parse(JSON.stringify(data)), target]);
    },
  };
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const window = {
    opener: withOpener ? opener : null,
    addEventListener: (name: string, listener: (event: unknown) => void): void => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
    removeEventListener: (name: string, listener: (event: unknown) => void): void => {
      listeners.set(name, (listeners.get(name) ?? []).filter((other) => other !== listener));
    },
  };
  const requests: Request[] = [];
  const fetch = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<unknown> => new Promise((resolve, reject) => {
    requests.push({
      path, method: init.method ?? 'GET', headers: JSON.parse(JSON.stringify(init.headers ?? {})), body: init.body === undefined ? undefined : JSON.parse(init.body),
      respond: (status, body) => {
        const text = body === undefined ? '' : JSON.stringify(body);
        resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) });
      },
      fail: () => reject(new TypeError('Failed to fetch')),
    });
  });
  const timers: FactoryWindow['timers'] = [];
  const setTimeout = (callback: () => void, ms: number): number => timers.push({ ms, fire: callback });
  const context = createContext({ document, window, fetch, setTimeout, URL, console });
  runInContext(source, context, { filename: 'point.js' });
  const $ = (id: string): FakeElement => {
    const element = document.getElementById(id);
    if (element === null) {
      throw new Error(`no element #${id} in point.html`);
    }
    return element;
  };
  return {
    $, status: () => $('point-status').textContent, posted, requests, timers, opener,
    get listeners() {
      return (listeners.get('message') ?? []).length;
    },
    send(data, origin = PAGE, from = opener) {
      for (const listener of [...(listeners.get('message') ?? [])]) {
        listener({ data, origin, source: from });
      }
    },
    async flush() {
      for (let round = 0; round < 5; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

const hello = (url = `${PAGE}/orders`) => ({ sf: 'point', type: 'hello', url });
const pinMessage = (ref: number, fields: Record<string, unknown> = {}) => ({ sf: 'point', type: 'pin', ref, url: `${PAGE}/orders`, selector: '#total', text: 'Total', rect: { ...RECT }, note: '', ...fields });

// A window past hello and Allow for PAGE.
async function allowedWindow(): Promise<FactoryWindow> {
  const page = await openWindow();
  page.send(hello());
  page.timers.find(({ ms }) => ms === 1000)!.fire();
  page.$('point-allow').click();
  page.posted.length = 0;
  return page;
}

const rows = (page: FactoryWindow): FakeElement[] => page.$('point-list').querySelectorAll('li');
const rowParts = (row: FakeElement): string[] => ['.point-id', '.point-text', '.point-note'].map((selector) => row.querySelector(selector)?.textContent ?? '-');

test('point.html: the static text, the hidden ask with its disabled Allow, the list, and only point.js', async () => {
  const document = await loadHtml();
  const $ = (id: string): FakeElement => document.getElementById(id)!;
  assert.equal(document.querySelector('title')!.textContent, 'Software Factory: point mode');
  assert.equal(document.querySelector('main')!.id, 'point');
  assert.equal(document.querySelector('h1')!.textContent, 'Point mode');
  assert.deepEqual([$('point-status').textContent, $('point-status').getAttribute('role'), $('point-status').getAttribute('aria-live')], [STATIC_TEXT, 'status', 'polite']);
  const ask = $('point-ask');
  assert.deepEqual([ask.tagName, ask.hidden, ask.getAttribute('aria-labelledby')], ['SECTION', true, 'point-ask-title']);
  assert.equal($('point-ask-title').textContent, 'Pins from ?');
  assert.ok($('point-origin').closest('#point-ask-title') !== null);
  const allow = $('point-allow');
  assert.deepEqual([allow.disabled, allow.type, allow.className, allow.textContent], [true, 'button', 'btn primary', 'Allow pins from this page']);
  assert.equal($('point-list').getAttribute('aria-label'), 'Pins saved');
  assert.deepEqual(document.querySelectorAll('script').map((script) => script.getAttribute('src')), ['point.js']);
});

test('without an opener the window says it has nothing to do and listens to nothing', async () => {
  const page = await openWindow(false);
  assert.deepEqual([page.status(), page.listeners, page.posted, page.$('point-ask').hidden], [NO_OPENER, 0, [], true]);
});

test('with an opener: Waiting, ready posted to \'*\'; a message not from the opener or not well formed is ignored and answered by nothing', async () => {
  const page = await openWindow();
  assert.deepEqual([page.status(), page.listeners, page.posted], [WAITING, 1, [[{ sf: 'point', type: 'ready' }, '*']]]);
  page.posted.length = 0;
  const { url: _url, ...noUrl } = hello();
  const ignored: unknown[] = [
    null, 'hello', [hello()], { ...hello(), sf: 'other' }, { type: 'hello', url: `${PAGE}/` }, { ...hello(), extra: 1 }, noUrl, { ...hello(), url: 5 },
    { sf: 'point', type: 'ready' }, { sf: 'point', type: 'saved', ref: 1, id: 1 },
  ];
  for (const data of ignored) {
    page.send(data);
  }
  // From another window, even with the right data and origin.
  page.send(hello(), PAGE, {});
  assert.deepEqual([page.status(), page.posted, page.$('point-ask').hidden, page.timers.length], [WAITING, [], true, 0]);
});

test('a hello from a page without a web address (null, file://) ends the window\'s work', async () => {
  for (const origin of ['null', 'file://']) {
    const page = await openWindow();
    page.send(hello('file:///home/me/page.html'), origin);
    assert.deepEqual([page.status(), page.listeners], [NO_ADDRESS, 0], origin);
    page.send(hello());
    assert.deepEqual([page.status(), page.$('point-ask').hidden, page.posted.length], [NO_ADDRESS, true, 1], origin);
  }
});

test('the first hello whose url is of its own origin binds it; Allow is enabled a second later; later hellos are ignored; Allow posts allowed to that origin only', async () => {
  const page = await openWindow();
  page.posted.length = 0;
  // A url of another origin than the sender's is ignored.
  page.send(hello('https://evil.example/x'));
  page.send(hello('not a url'));
  assert.deepEqual([page.status(), page.$('point-ask').hidden], [WAITING, true]);
  page.send(hello(`${PAGE}/orders?id=7`));
  assert.deepEqual([page.status(), page.$('point-ask').hidden, page.$('point-origin').textContent, page.$('point-url').textContent], [ASK, false, PAGE, `${PAGE}/orders?id=7`]);
  assert.equal(page.$('point-ask-title').textContent, `Pins from ${PAGE}?`);
  const allow = page.$('point-allow');
  assert.deepEqual([allow.disabled, page.timers.map(({ ms }) => ms)], [true, [1000]]);
  // Disabled, the click lands nowhere.
  allow.click();
  assert.deepEqual([page.status(), page.posted], [ASK, []]);
  // A later hello, of another origin or the same, changes nothing.
  page.send(hello('https://other.example/'), 'https://other.example');
  page.send(hello(`${PAGE}/else`));
  assert.deepEqual([page.$('point-origin').textContent, page.$('point-url').textContent, page.timers.length], [PAGE, `${PAGE}/orders?id=7`, 1]);
  page.timers[0]!.fire();
  assert.equal(allow.disabled, false);
  allow.click();
  assert.deepEqual([page.status(), page.$('point-ask').hidden, page.posted], [allowedText(PAGE), true, [[{ sf: 'point', type: 'allowed' }, PAGE]]]);
  // Once per window.
  allow.click();
  assert.equal(page.posted.length, 1);
});

test('a pin before Allow, from another origin, for an address of another origin or not well formed (a ref of 0, a NaN in rect) is ignored', async () => {
  const before = await openWindow();
  before.send(hello());
  before.send(pinMessage(1));
  assert.deepEqual([before.requests, before.posted.length], [[], 1]);

  const page = await allowedWindow();
  const { note: _note, ...noNote } = pinMessage(1);
  const ignored: unknown[] = [
    pinMessage(0), pinMessage(-1), pinMessage(1.5), pinMessage(Number.MAX_SAFE_INTEGER + 1), pinMessage(1, { ref: '1' }), noNote, { ...pinMessage(1), extra: '' },
    pinMessage(1, { rect: { ...RECT, x: Number.NaN } }), pinMessage(1, { rect: { ...RECT, w: Infinity } }), pinMessage(1, { rect: { ...RECT, z: 1 } }),
    pinMessage(1, { rect: { x: 1, y: 2, w: 3, h: 4, vw: 5 } }), pinMessage(1, { rect: [1, 2, 3, 4, 5, 6] }), pinMessage(1, { rect: { ...RECT, x: '1' } }),
    pinMessage(1, { text: 5 }), pinMessage(1, { selector: null }), pinMessage(1, { note: undefined }), pinMessage(1, { url: 'https://evil.example/' }), pinMessage(1, { url: 'nope' }),
  ];
  for (const data of ignored) {
    page.send(data);
  }
  page.send(pinMessage(1), 'https://evil.example');
  page.send(pinMessage(1), PAGE, {});
  await page.flush();
  assert.deepEqual([page.requests, page.posted, rows(page)], [[], [], []]);
});

test('a pin after Allow is posted to api/pins with route \'\' and the address without user info; saved shows a row and posts saved with its id to the bound origin', async () => {
  const page = await allowedWindow();
  page.send(pinMessage(3, { url: `http://me:secret@localhost:3000/orders?id=7#top`, note: 'Wrong total' }));
  assert.equal(page.requests.length, 1);
  const [request] = page.requests;
  assert.deepEqual([request!.path, request!.method, request!.headers], ['api/pins', 'POST', { 'Content-Type': 'application/json' }]);
  assert.deepEqual(request!.body, { route: '', url: `${PAGE}/orders?id=7#top`, selector: '#total', text: 'Total', rect: RECT, note: 'Wrong total' });
  request!.respond(200, { ok: true, result: { pin: { id: 12 }, pins: [] } });
  await page.flush();
  assert.deepEqual(rows(page).map((row) => [row.className, ...rowParts(row)]), [['point-row', '📍12', 'Total', 'Wrong total']]);
  assert.deepEqual(page.posted, [[{ sf: 'point', type: 'saved', ref: 3, id: 12 }, PAGE]]);
  // Without a note, no note span.
  page.send(pinMessage(4));
  page.requests[1]!.respond(200, { ok: true, result: { pin: { id: 13 } } });
  await page.flush();
  assert.deepEqual(rowParts(rows(page)[1]!), ['📍13', 'Total', '-']);
});

test('an address over 2,000 characters keeps its origin and path; a path over that too keeps the origin', async () => {
  const page = await allowedWindow();
  const query = `${PAGE}/orders?q=${'a'.repeat(2100)}`;
  const path = `${PAGE}/${'p'.repeat(2100)}`;
  page.send(pinMessage(1, { url: query }));
  page.send(pinMessage(2, { url: path }));
  assert.deepEqual(page.requests.map(({ body }) => (body as { url: string }).url), [`${PAGE}/orders`, `${PAGE}/`]);
});

test('a refusal shows the server\'s message, an empty 404 its status, a failed fetch that the factory does not answer; each posts refused', async () => {
  const page = await allowedWindow();
  for (let ref = 1; ref <= 4; ref += 1) {
    page.send(pinMessage(ref));
  }
  // Answered one at a time, so the rows come in this order.
  page.requests[0]!.respond(400, { ok: false, error: { code: 'invalid_request', message: 'The text is too long.' } });
  await page.flush();
  page.requests[1]!.respond(404);
  await page.flush();
  page.requests[2]!.fail();
  await page.flush();
  page.requests[3]!.respond(200, { ok: true, result: { pin: { id: 'x' } } });
  await page.flush();
  assert.deepEqual(rows(page).map((row) => [row.className, row.textContent]), [
    ['point-row point-refused', 'Not saved: The text is too long.'], ['point-row point-refused', 'Not saved: HTTP 404'],
    ['point-row point-refused', 'Not saved: the factory does not answer.'], ['point-row point-refused', 'Not saved: HTTP 200'],
  ]);
  assert.deepEqual(page.posted, [1, 2, 3, 4].map((ref) => [{ sf: 'point', type: 'refused', ref }, PAGE]));
});

test('every text stays text: the url, the pin\'s text and note, the server\'s message', async () => {
  const markup = '<img src=x onerror=alert(1)>';
  const page = await openWindow();
  page.send(hello(`${PAGE}/${markup}`));
  page.timers[0]!.fire();
  page.$('point-allow').click();
  page.send(pinMessage(1, { text: markup, note: markup }));
  page.send(pinMessage(2));
  page.requests[0]!.respond(200, { ok: true, result: { pin: { id: 1 } } });
  page.requests[1]!.respond(400, { ok: false, error: { message: markup } });
  await page.flush();
  assert.equal(page.$('point-url').textContent, `${PAGE}/${markup}`);
  assert.deepEqual(rowParts(rows(page)[0]!), ['📍1', markup, markup]);
  assert.equal(rows(page)[1]!.textContent, `Not saved: ${markup}`);
  assert.deepEqual(page.$('point').querySelectorAll('img'), []);
});
