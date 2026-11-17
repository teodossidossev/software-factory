// point.js, the factory window's script, built from web/point.ts into dist/web/. The window is
// static/point.html at http://127.0.0.1:<port>/point, served without the token; this script
// loads with the dashboard's cookie, so in a browser without a dashboard session it never runs and
// the page's static text tells the user. The window saves as pins what the page that opened it
// (its opener) sends by postMessage, once the user allows that page here:
// - no opener: nothing to do, said so;
// - an opener: `ready` posted to it (target '*', its origin not known yet), then its messages
//   listened to. A message counts only from the opener, as a plain object {sf: 'point', type, ...}
//   with exactly its type's keys; anything else is ignored and answered by nothing;
// - the first `hello` from an http(s) page whose url is of its own origin binds that origin, shows
//   it and enables Allow a second later (a double click that opened the window cannot land on it);
//   a `hello` from a page without a web address (a file, a sandboxed page) ends the window's work;
// - Allow posts `allowed` to the bound origin; from then on each `pin` of that origin, for an
//   address of that origin, is posted to api/pins (the address without user info, shortened to
//   2,000 characters), listed here, and answered `saved` with its id or `refused`; the reason of a
//   refusal shows here only.
// Every text goes in through textContent. A classic script the page loads alone: it uses no name
// of another web/ script, and its own top-level names start with point.
'use strict';

// src/pins.ts's MAX_URL_CHARS: the longest address a pin keeps.
const POINT_MAX_URL_CHARS = 2000;
// How long after the page's origin shows the Allow button stays disabled.
const POINT_ALLOW_DELAY_MS = 1000;
// The keys of each message the page sends, besides sf and type.
const POINT_HELLO_KEYS = ['url'];
const POINT_PIN_KEYS = ['note', 'rect', 'ref', 'selector', 'text', 'url'];
const POINT_RECT_KEYS = ['h', 'vh', 'vw', 'w', 'x', 'y'];

type PointState = 'NO_OPENER' | 'WAITING' | 'NO_ADDRESS' | 'ASK' | 'ALLOWED';

// The status line of each state but ALLOWED, whose line names the bound origin.
const POINT_STATUS: Record<Exclude<PointState, 'ALLOWED'>, string> = {
  NO_OPENER: 'This window saves the pins of the page that opens it. Opened on its own, it has nothing to do.',
  WAITING: 'Waiting for the page…',
  NO_ADDRESS: 'This page has no web address (a file or a sandboxed page): it cannot send pins.',
  ASK: 'Allow this page below, or close this window.',
};

interface PointRect { x: number; y: number; w: number; h: number; vw: number; vh: number }
interface PointHello { type: 'hello'; url: string }
interface PointPin { type: 'pin'; ref: number; url: string; selector: string; text: string; rect: PointRect; note: string }

// The window's one page: the origin bound by the first hello, and whether the user allowed it.
const pointPage: { origin: string | undefined; allowed: boolean } = { origin: undefined, allowed: false };

function pointById(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`point.html has no #${id}`);
  }
  return element;
}

function pointShow(state: PointState): void {
  pointById('point-status').textContent = state === 'ALLOWED'
    ? `Pins from ${pointPage.origin ?? ''} are saved here. Keep this window open while you point.`
    : POINT_STATUS[state];
}

// A plain object: what structured cloning makes of the page's object literal (of any realm).
function pointIsPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

// Whether the object has exactly these keys (sorted).
function pointHasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

function pointRectOf(value: unknown): PointRect | undefined {
  if (!pointIsPlain(value) || !pointHasKeys(value, POINT_RECT_KEYS) || !POINT_RECT_KEYS.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))) {
    return undefined;
  }
  const { x, y, w, h, vw, vh } = value as unknown as PointRect;
  return { x, y, w, h, vw, vh };
}

// The page's message as the window takes it, or undefined for anything else.
function pointMessageOf(data: unknown): PointHello | PointPin | undefined {
  if (!pointIsPlain(data) || data.sf !== 'point') {
    return undefined;
  }
  const { sf: _sf, type, ...rest } = data;
  if (type === 'hello' && pointHasKeys(rest, POINT_HELLO_KEYS) && typeof rest.url === 'string') {
    return { type, url: rest.url };
  }
  if (type !== 'pin' || !pointHasKeys(rest, POINT_PIN_KEYS)) {
    return undefined;
  }
  const { ref, url, selector, text, note } = rest;
  const rect = pointRectOf(rest.rect);
  if (typeof ref !== 'number' || !Number.isSafeInteger(ref) || ref < 1 || rect === undefined
    || typeof url !== 'string' || typeof selector !== 'string' || typeof text !== 'string' || typeof note !== 'string') {
    return undefined;
  }
  return { type, ref, url, selector, text, rect, note };
}

// A message to the opener: ready to any origin, the others to the bound one only.
function pointPost(message: Record<string, unknown>, target: string): void {
  (window.opener as Window).postMessage({ sf: 'point', ...message }, target);
}

// The address a pin keeps: without user info, as URL writes it; past the bound, the origin and
// the path, else the origin alone.
function pointAddress(url: URL): string {
  url.username = '';
  url.password = '';
  if (url.href.length <= POINT_MAX_URL_CHARS) {
    return url.href;
  }
  const path = `${url.origin}${url.pathname}`;
  return path.length <= POINT_MAX_URL_CHARS ? path : `${url.origin}/`;
}

function pointRow(className: string, ...parts: Array<[string, string]>): void {
  const row = document.createElement('li');
  row.className = className;
  for (const [name, text] of parts) {
    const span = document.createElement('span');
    span.className = name;
    span.textContent = text;
    row.append(span);
  }
  pointById('point-list').append(row);
}

function pointRefused(ref: number, origin: string, reason: string): void {
  const row = document.createElement('li');
  row.className = 'point-row point-refused';
  row.textContent = `Not saved: ${reason}`;
  pointById('point-list').append(row);
  pointPost({ type: 'refused', ref }, origin);
}

// The pin saved through api/pins, as the dashboard saves its own, with route '' and the address.
async function pointSave(pin: PointPin, address: string, origin: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch('api/pins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route: '', url: address, selector: pin.selector, text: pin.text, rect: pin.rect, note: pin.note }),
    });
  } catch { // a network failure: the factory does not answer, which the row says
    pointRefused(pin.ref, origin, 'the factory does not answer.');
    return;
  }
  // An answer that is not JSON (an empty 404) leaves only its status to say.
  const answer: unknown = await response.json().catch(() => undefined);
  const result = pointIsPlain(answer) && pointIsPlain(answer.result) && pointIsPlain(answer.result.pin) ? answer.result.pin : undefined;
  const id = result?.id;
  if (response.ok && pointIsPlain(answer) && answer.ok === true && typeof id === 'number' && Number.isSafeInteger(id) && id >= 1) {
    pointRow('point-row', ['point-id', `📍${id}`], ['point-text', pin.text], ...(pin.note === '' ? [] : [['point-note', pin.note] as [string, string]]));
    pointPost({ type: 'saved', ref: pin.ref, id }, origin);
    return;
  }
  const error = pointIsPlain(answer) && pointIsPlain(answer.error) ? answer.error.message : undefined;
  pointRefused(pin.ref, origin, typeof error === 'string' && error !== '' ? error : `HTTP ${response.status}`);
}

function pointHello(hello: PointHello, from: string, stop: () => void): void {
  if (pointPage.origin !== undefined) {
    return;
  }
  if (!from.startsWith('http://') && !from.startsWith('https://')) {
    stop();
    pointShow('NO_ADDRESS');
    return;
  }
  if (URL.parse(hello.url)?.origin !== from) {
    return;
  }
  pointPage.origin = from;
  pointById('point-origin').textContent = from;
  pointById('point-url').textContent = hello.url;
  pointById('point-ask').hidden = false;
  pointShow('ASK');
  setTimeout(() => {
    (pointById('point-allow') as HTMLButtonElement).disabled = false;
  }, POINT_ALLOW_DELAY_MS);
}

function pointAllow(): void {
  const origin = pointPage.origin;
  if (origin === undefined || pointPage.allowed) {
    return;
  }
  pointPage.allowed = true;
  pointById('point-ask').hidden = true;
  pointShow('ALLOWED');
  pointPost({ type: 'allowed' }, origin);
}

function pointPin(pin: PointPin, from: string): void {
  const origin = pointPage.origin;
  const url = URL.parse(pin.url);
  if (!pointPage.allowed || origin === undefined || from !== origin || url === null || url.origin !== origin) {
    return;
  }
  void pointSave(pin, pointAddress(url), origin);
}

function pointStart(): void {
  if (!window.opener) {
    pointShow('NO_OPENER');
    return;
  }
  pointShow('WAITING');
  const listener = (event: MessageEvent): void => {
    if (event.source !== window.opener) {
      return;
    }
    const message = pointMessageOf(event.data);
    if (message?.type === 'hello') {
      pointHello(message, event.origin, () => window.removeEventListener('message', listener));
    } else if (message?.type === 'pin') {
      pointPin(message, event.origin);
    }
  };
  window.addEventListener('message', listener);
  pointById('point-allow').addEventListener('click', pointAllow);
  pointPost({ type: 'ready' }, '*');
}

pointStart();
