// pins.js, the dashboard's point mode, built from web/pins.ts into dist/web/. The user points at
// what they mean: the top bar's Point button or Shift+P (on every page, not in a text field)
// turns the mode on, Escape leaves it. While it is on, the element under the pointer gets an
// outline (#pin-outline, a box over it; the element itself is not touched), and every pointer and
// mouse press, release and click outside the pins' own elements is stopped on window in the
// capture phase, so the element's own action never runs; the click places a numbered pin on it
// (POST api/pins: the page's hash, a selector found again later, its text, its position) and
// opens a note field next to it. The open pins of the current hash show as markers 📍<id> in a
// fixed layer (#pin-layer) whether or not the mode is on, so a screenshot shows them; they are
// drawn again on scroll, resize, hashchange, a pins read or write and the page's DOM changes (one
// MutationObserver, coalesced into one animation frame; no timer). The pins panel (#pins) lists the
// open pins with Resolve and Delete (a pin of another page, with url, too: listed, never drawn);
// with the mode off, #pins-open opens it. The pins are read at
// the start, on every hashchange, when the mode is turned on and on Refresh; a write's answer
// replaces them. The coordinator reads the same pins with sf pins. Every pin text and server
// message goes in through textContent. The selector of a pin (pinSelector, pinFind, pinText) is
// pin-selector.js's, which the Point bookmarklet shares; on the local listener (127.0.0.1) the
// panel offers that bookmarklet for other pages (#pins-elsewhere). A classic script, loaded
// before main.js (whose init calls initPins), sharing the page's globals with the others: no
// import or export.
'use strict';

// The pins' own elements: a pointer event on them is never stopped, a click on them places nothing.
const PIN_OWN = '#point-toggle, #pins, #pin-note, #pins-open';
// The elements the pins draw into: their DOM changes do not draw the markers again.
const PIN_DRAWN = '#pin-layer, #pin-outline, #pins, #pin-note, #pins-open';
// The events stopped while the mode is on; the click also places the pin. dragstart too: a queued
// card is draggable, and its drop moves it in the queue.
const PIN_STOPPED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'dragstart'] as const;
// A marker's size where the page has no layout to measure it (each marker is measured once drawn).
const PIN_MARKER_WIDTH = 44;
const PIN_MARKER_HEIGHT = 24;

// Where a pin of the current hash is: its element shown (a marker), not found (gone), or found
// with no size (hidden).
type PinPlace = 'shown' | 'gone' | 'hidden';

interface PinsPage {
  on: boolean;
  // The panel opened by #pins-open with the mode off; closed by Close with the mode on.
  opened: boolean;
  closed: boolean;
  // Every stored pin, as the last read or write answered.
  pins: Pin[];
  // The last refusal, shown in the panel's status line.
  status: string;
  // The pin whose note field is open.
  noteFor: number | null;
  // A new pin is being posted.
  placing: boolean;
  // The element the outline is over.
  hover: Element | null;
  // A draw is waiting for its animation frame.
  frame: boolean;
  places: Map<number, PinPlace>;
  // The reads and writes in their order of start, and the last one whose answer was taken: an
  // answer to an older one does not replace a newer one's.
  asked: number;
  applied: number;
  // The Point bookmarklet's two scripts were asked for (once per page load).
  bookmarkletAsked: boolean;
}

const pinPage: PinsPage = {
  on: false, opened: false, closed: false, pins: [], status: '', noteFor: null, placing: false, hover: null, frame: false, places: new Map(), asked: 0, applied: 0, bookmarkletAsked: false,
};

// The page's hash without '#': '' for the board.
const pinRoute = (): string => location.hash.replace(/^#/, '');
const openPins = (): Pin[] => pinPage.pins.filter((pin) => !pin.resolved);
const pinOwn = (node: Element | null, selector = PIN_OWN): boolean => node !== null && node.closest(selector) !== null;
const pinMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// A text field, where Shift+P types a P.
function pinTextField(node: Element | null): boolean {
  return node !== null && (node.closest('textarea, input, select') !== null || (node as HTMLElement).isContentEditable === true);
}

// The pins of an answer ({ pins: Pin[] }), each checked for the fields the page reads; null when
// it is not one.
function pinsOf(value: unknown): Pin[] | null {
  if (!isRecord(value) || !Array.isArray(value.pins)) {
    return null;
  }
  return (value.pins as unknown[]).filter((pin): pin is Pin => isRecord(pin) && typeof pin.id === 'number' && typeof pin.route === 'string'
    && typeof pin.selector === 'string' && typeof pin.text === 'string' && typeof pin.note === 'string' && typeof pin.resolved === 'boolean'
    && (pin.url === undefined || typeof pin.url === 'string'));
}

// A pin of the current hash: one of the dashboard (a pin of another page, with url, has no hash).
const pinHere = (pin: Pin, route: string): boolean => pin.url === undefined && pin.route === route;

// A panel row's place: the dashboard hash (the board as Board) as a link to it; or the address of
// another page as its text, a link to a new tab only when it is an http: or https: address.
function pinPlaceLink(pin: Pin): HTMLAnchorElement {
  if (pin.url === undefined) {
    const link = el('a', 'pin-route', pin.route === '' ? 'Board' : pin.route);
    link.href = `#${pin.route}`;
    return link;
  }
  const link = el('a', 'pin-route', pin.url);
  const protocol = URL.parse(pin.url)?.protocol;
  if (protocol === 'http:' || protocol === 'https:') {
    link.href = pin.url;
  }
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

// The pins of an answer, unless a newer read or write was answered first.
function takePins(mine: number, value: unknown): void {
  const pins = pinsOf(value);
  if (pins === null) {
    throw new Error('The answer holds no pins.');
  }
  if (mine >= pinPage.applied) {
    pinPage.pins = pins;
    pinPage.applied = mine;
  }
  pinPage.status = '';
}

// GET api/pins; a refusal (pins_unreadable) keeps the pins shown and says why.
async function readPinList(): Promise<void> {
  const mine = ++pinPage.asked;
  try {
    const response = await fetch('api/pins', { cache: 'no-store' });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = isRecord(data) && isRecord(data.error) ? data.error : {};
      throw new Error(typeof error.message === 'string' ? error.message : `api/pins: HTTP ${response.status}`);
    }
    takePins(mine, data);
  } catch (error) {
    pinPage.status = pinMessage(error);
  }
  drawPins();
}

// A pins POST (core.js post); its answer's pins replace the page's. The result, or null on a
// refusal, which the status line shows.
async function pinWrite(path: string, body: unknown): Promise<Readonly<Record<string, unknown>> | null> {
  const mine = ++pinPage.asked;
  try {
    const result = await post(path, body);
    takePins(mine, result);
    return isRecord(result) ? result : null;
  } catch (error) {
    pinPage.status = pinMessage(error);
    pinPage.closed = false;
    return null;
  } finally {
    drawPins();
  }
}

// ---------- The mode, the click, the note field ----------

function setPointing(on: boolean): void {
  if (pinPage.on === on) {
    return;
  }
  pinPage.on = on;
  pinPage.opened = false;
  pinPage.closed = false;
  document.body.classList.toggle('pointing', on);
  byId('point-toggle').setAttribute('aria-pressed', String(on));
  if (!on) {
    pinPage.hover = null;
    closePinNote();
  }
  drawPins();
  if (on) {
    void readPinList();
  }
}

// The keys of point mode, first in routing.js onKey; true when the key was point mode's. Shift+P
// (not in a text field) turns the mode on or off; Escape leaves it before any other Escape action.
function pinKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) {
    return false;
  }
  const target = isElement(event.target) ? event.target : null;
  if (event.key === 'P' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !pinTextField(target)) {
    event.preventDefault();
    setPointing(!pinPage.on);
    return true;
  }
  if (event.key === 'Escape' && pinPage.on) {
    event.preventDefault();
    setPointing(false);
    return true;
  }
  return false;
}

// Escape while pointing, on window in the capture phase: it leaves the mode before an element's
// own Escape (a confirmation's, the drawer's) runs. The open note field keeps its Escape (Skip).
function pinEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && pinPage.noteFor === null && pinKey(event)) {
    event.stopImmediatePropagation();
  }
}

// A pointer or mouse event while the mode is on, on window in the capture phase: anything but the
// pins' own elements never gets it. The click places a pin, unless the note field is open, a pin
// is being placed or it is on html or body.
function pinCapture(event: Event): void {
  if (!pinPage.on) {
    return;
  }
  const target = isElement(event.target) ? event.target : null;
  if (pinOwn(target)) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === 'click' && target !== null && target !== document.body && target !== document.documentElement && pinPage.noteFor === null && !pinPage.placing) {
    const point = event as MouseEvent;
    void placePin(target, point.clientX, point.clientY);
  }
}

// POST api/pins for the element; the note field opens at the click once it is stored.
async function placePin(node: Element, x: number, y: number): Promise<void> {
  const selector = pinSelector(node);
  if (selector.length > PIN_SELECTOR_CHARS) {
    pinPage.status = 'This element cannot be pinned.';
    pinPage.closed = false;
    drawPins();
    return;
  }
  const box = node.getBoundingClientRect();
  const rect = { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height), vw: Math.round(window.innerWidth), vh: Math.round(window.innerHeight) };
  pinPage.placing = true;
  const result = await pinWrite('api/pins', { route: pinRoute(), selector, text: pinText(node), rect, note: '' });
  pinPage.placing = false;
  const id = result !== null && isRecord(result.pin) && typeof result.pin.id === 'number' ? result.pin.id : null;
  if (id !== null && pinPage.on) {
    openPinNote(id, x, y);
  }
}

// The note field of the new pin, next to the click and inside the viewport.
function openPinNote(id: number, x: number, y: number): void {
  const box = byId('pin-note');
  const text = byId('pin-note-text') as HTMLTextAreaElement;
  pinPage.noteFor = id;
  box.setAttribute('aria-label', `Note for pin ${id}`);
  text.value = '';
  box.hidden = false;
  const width = box.offsetWidth || 280;
  const height = box.offsetHeight || 140;
  const place = (at: number, size: number, room: number): number => Math.round(Math.max(8, Math.min(at + 12, room - size - 8)));
  box.style.setProperty('left', `${place(x, width, window.innerWidth)}px`);
  box.style.setProperty('top', `${place(y, height, window.innerHeight)}px`);
  text.focus();
}

// The note field closed; the focus leaves it, so the next Escape is the page's again.
function closePinNote(): void {
  const box = byId('pin-note');
  pinPage.noteFor = null;
  if (box.contains(document.activeElement)) {
    (document.activeElement as HTMLElement).blur();
  }
  box.hidden = true;
}

// Save: the note posted; the field closes once it is stored, and stays with the refusal shown.
async function savePinNote(): Promise<void> {
  const id = pinPage.noteFor;
  if (id === null) {
    return;
  }
  const result = await pinWrite(`api/pins/${id}`, { note: (byId('pin-note-text') as HTMLTextAreaElement).value });
  if (result !== null && pinPage.noteFor === id) {
    closePinNote();
  }
}

// The note field's own keys: Enter in its text saves (Shift+Enter is a new line; Enter on a button
// is that button's), Escape is Skip.
function pinNoteKey(event: KeyboardEvent): void {
  if (pinPage.noteFor === null) {
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey && isElement(event.target) && event.target.id === 'pin-note-text') {
    event.preventDefault();
    event.stopPropagation();
    void savePinNote();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closePinNote();
  }
}

// ---------- The markers, the outline, the panel ----------

// Each open pin of the current hash as a marker at its element's top-left corner, inside the
// viewport; where each is (pinPage.places). True when a place changed.
function drawPinMarkers(): boolean {
  const route = pinRoute();
  const before = [...pinPage.places].join();
  pinPage.places = new Map();
  const markers: Array<{ marker: HTMLElement; box: DOMRect }> = [];
  for (const pin of openPins()) {
    if (!pinHere(pin, route)) {
      continue;
    }
    const node = pinFind(pin.selector);
    const box = node?.getBoundingClientRect();
    if (box === undefined || (box.width === 0 && box.height === 0)) {
      pinPage.places.set(pin.id, box === undefined ? 'gone' : 'hidden');
      continue;
    }
    pinPage.places.set(pin.id, 'shown');
    const marker = el('span', 'pin-marker', `📍${pin.id}`);
    marker.title = pin.note !== '' ? pin.note : pin.text;
    marker.dataset.pin = String(pin.id);
    markers.push({ marker, box });
  }
  byId('pin-layer').replaceChildren(...markers.map(({ marker }) => marker));
  // Placed once drawn, by the size each marker takes (a long id is wider): inside the viewport.
  for (const { marker, box } of markers) {
    const width = marker.offsetWidth || PIN_MARKER_WIDTH;
    const height = marker.offsetHeight || PIN_MARKER_HEIGHT;
    marker.style.setProperty('left', `${Math.round(Math.max(0, Math.min(box.left, window.innerWidth - width)))}px`);
    marker.style.setProperty('top', `${Math.round(Math.max(0, Math.min(box.top, window.innerHeight - height)))}px`);
  }
  drawPinOutline();
  return [...pinPage.places].join() !== before;
}

// The outline over the element under the pointer while the mode is on.
function drawPinOutline(): void {
  const outline = byId('pin-outline');
  const box = pinPage.on ? pinPage.hover?.getBoundingClientRect() : undefined;
  if (box === undefined || (box.width === 0 && box.height === 0)) {
    outline.hidden = true;
    return;
  }
  for (const [name, value] of [['left', box.left], ['top', box.top], ['width', box.width], ['height', box.height]] as const) {
    outline.style.setProperty(name, `${Math.round(value)}px`);
  }
  outline.hidden = false;
}

// The element under the pointer, while the mode is on: the outline follows it.
function pinHover(event: Event): void {
  if (!pinPage.on) {
    return;
  }
  const target = isElement(event.target) ? event.target : null;
  pinPage.hover = target === null || pinOwn(target) || target === document.body || target === document.documentElement ? null : target;
  drawPinOutline();
}

// The panel: its head, the open pins (the current hash's first, then the others, pins of other
// pages among them, in id order), the status line; and #pins-open.
function renderPinsPanel(): void {
  const open = openPins();
  const shown = pinPage.on ? !pinPage.closed : pinPage.opened;
  byId('pins').hidden = !shown;
  byId('pins-title').textContent = `Pins (${open.length} open)`;
  byId('pins-stop').hidden = !pinPage.on;
  byId('pins-status').textContent = pinPage.status;
  // Only on 127.0.0.1, the factory window's own host: the bookmarklet opens <origin>/point, which
  // only the local listener serves, under the name its cookie was set for.
  if (shown && !pinPage.bookmarkletAsked && location.hostname === '127.0.0.1') {
    pinPage.bookmarkletAsked = true;
    void offerPinBookmarklet();
  }
  const toggle = byId('pins-open');
  toggle.hidden = pinPage.on || shown || open.length === 0;
  toggle.textContent = `📍 ${open.length}`;
  toggle.setAttribute('aria-label', `Pins: ${counted(open.length, 'open pin')}`);
  const route = pinRoute();
  const rows = [...open.filter((pin) => pinHere(pin, route)), ...open.filter((pin) => !pinHere(pin, route))].map((pin) => {
    const row = el('li', 'pin-row');
    const head = el('div', 'pin-rhead');
    head.append(el('span', 'pin-id', `📍${pin.id}`), pinPlaceLink(pin));
    const place = pinHere(pin, route) ? pinPage.places.get(pin.id) : undefined;
    if (place === 'gone' || place === 'hidden') {
      head.append(el('span', 'pin-place', `element ${place}`));
    }
    row.append(head, el('div', 'pin-text', pin.text));
    if (pin.note !== '') {
      row.append(el('div', 'pin-note', pin.note));
    }
    const acts = el('div', 'pin-acts');
    acts.append(button('btn', 'Resolve', { pinAct: 'resolve', pin: String(pin.id) }), button('btn', 'Delete', { pinAct: 'delete', pin: String(pin.id) }));
    row.append(acts);
    return row;
  });
  byId('pins-list').replaceChildren(...rows);
}

// ---------- The Point bookmarklet ----------

// The bookmarklet: pin-selector.js and point-page.js in one arrow function that calls pointOnPage
// with the factory's origin (never the page's address, whose path holds the token) and returns
// nothing, so the browser keeps the page it runs in.
function pinBookmarklet(selector: string, page: string, factory: string): string {
  return `javascript:${encodeURIComponent(`(()=>{${selector}\n${page}\npointOnPage(${JSON.stringify(factory)});})()`)}`;
}

// The panel's line on other pages, on the local listener only (renderPinsPanel asks once): both
// scripts read, the link is the bookmarklet and the line shows; a failed read keeps it hidden
// until the page loads again.
async function offerPinBookmarklet(): Promise<void> {
  const read = async (file: string): Promise<string> => {
    const response = await fetch(file, { cache: 'no-store' });
    if (response.status !== 200) {
      throw new Error(`${file}: HTTP ${response.status}`);
    }
    return response.text();
  };
  try {
    const [selector, page] = await Promise.all([read('pin-selector.js'), read('point-page.js')]);
    (byId('pins-bookmarklet') as HTMLAnchorElement).href = pinBookmarklet(selector, page, location.origin);
    byId('pins-elsewhere').hidden = false;
  } catch { // a script not served or the factory not answering: the line stays hidden
  }
}

function drawPins(): void {
  drawPinMarkers();
  renderPinsPanel();
}

// A draw in the next animation frame (scroll, resize, the page's DOM changes); the panel too when
// a pin's place changed.
function schedulePinDraw(): void {
  if (pinPage.frame) {
    return;
  }
  pinPage.frame = true;
  requestAnimationFrame(() => {
    pinPage.frame = false;
    if (drawPinMarkers()) {
      renderPinsPanel();
    }
  });
}

// Resolve and Delete of a panel row: posted at once, the panel drawn from the answer.
function onPinsClick(event: Event): void {
  const target = isElement(event.target) ? event.target.closest<HTMLElement>('[data-pin-act]') : null;
  const id = target?.dataset.pin;
  if (target === null || id === undefined) {
    return;
  }
  if (target.dataset.pinAct === 'resolve') {
    void pinWrite(`api/pins/${id}`, { resolved: true });
  } else if (target.dataset.pinAct === 'delete') {
    void pinWrite(`api/pins/${id}/remove`, {});
  }
}

function initPins(): void {
  for (const type of PIN_STOPPED) {
    window.addEventListener(type, pinCapture, { capture: true });
  }
  window.addEventListener('keydown', pinEscape, { capture: true });
  window.addEventListener('pointerover', pinHover, { capture: true, passive: true });
  window.addEventListener('scroll', schedulePinDraw, { capture: true, passive: true });
  window.addEventListener('resize', schedulePinDraw);
  window.addEventListener('hashchange', () => {
    closePinNote();
    drawPins();
    void readPinList();
  });
  new MutationObserver((records) => {
    if (records.some((record) => !(isElement(record.target) && pinOwn(record.target, PIN_DRAWN)))) {
      schedulePinDraw();
    }
  }).observe(document.body, { childList: true, subtree: true });
  byId('point-toggle').addEventListener('click', () => setPointing(!pinPage.on));
  byId('pins-open').addEventListener('click', () => {
    pinPage.opened = true;
    renderPinsPanel();
  });
  byId('pins-refresh').addEventListener('click', () => void readPinList());
  byId('pins-stop').addEventListener('click', () => setPointing(false));
  byId('pins-close').addEventListener('click', () => {
    pinPage.opened = false;
    pinPage.closed = true;
    renderPinsPanel();
  });
  byId('pins').addEventListener('click', onPinsClick);
  // The bookmarklet is dragged to the bookmarks bar, not run here.
  byId('pins-bookmarklet').addEventListener('click', (event) => event.preventDefault());
  byId('pin-note').addEventListener('keydown', pinNoteKey);
  byId('pin-note-save').addEventListener('click', () => void savePinNote());
  byId('pin-note-skip').addEventListener('click', closePinNote);
  void readPinList();
}
