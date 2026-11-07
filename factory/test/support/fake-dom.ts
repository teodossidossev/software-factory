// A small stand-in for the dashboard page, so static/app.js runs under node:vm: a document built
// from static/dashboard.html as a tree (every element, its attributes and its text), elements with
// the properties the script uses (parentNode, closest, matches, dataset, classList,
// style.setProperty, querySelector and querySelectorAll with tag, id, class and attribute
// selectors), events that bubble to the document (so the page's delegated listeners get them),
// document.visibilityState, document.createElementNS (the Stats page's SVG, SF-117), a scripted
// fetch (a Blob body sent or answered too), a scripted EventSource, timers that fire only when
// the test says so and, when the test gives one, a clipboard; for a ticket's images (SF-064) Node's Blob and File (with arrayBuffer), paste and drop
// events with clipboardData / dataTransfer files (the test's dispatch gives them), URL.createObjectURL,
// ClipboardItem, createImageBitmap and a canvas whose toBlob gives a PNG. It is not a browser: layout, focus order,
// CSS and default actions (Enter in a textarea, a form's own submission) are out of its reach; the
// manual browser steps in factory/README.md cover those.
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

export class FakeText {
  readonly nodeType = 3;
  textContent: string;
  parentNode: FakeElement | null = null;

  constructor(text: string) {
    this.textContent = text;
  }
}

type FakeNode = FakeElement | FakeText;
export type FakeEvent = Record<string, unknown> & {
  type: string;
  target: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
};
type Listener = (event: FakeEvent) => void;

// data-foo-bar <-> fooBar, as a browser's dataset maps them.
const camel = (name: string): string => name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

function newEvent(type: string, target: unknown, init: Record<string, unknown>): FakeEvent & { stopped: boolean; stoppedNow: boolean } {
  const event = {
    type, target, defaultPrevented: false, stopped: false, stoppedNow: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      event.stopped = true;
    },
    stopImmediatePropagation() {
      event.stopped = true;
      event.stoppedNow = true;
    },
    ...init,
  };
  return event;
}

function fire(listeners: Map<string, Listener[]>, event: FakeEvent & { stoppedNow: boolean }): void {
  for (const listener of [...(listeners.get(event.type) ?? [])]) {
    listener(event);
    if (event.stoppedNow) {
      return;
    }
  }
}

export class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  // An HTML element's; createElementNS (SF-117's SVG charts) sets another.
  namespaceURI: string | null = 'http://www.w3.org/1999/xhtml';
  id = '';
  className = '';
  hidden = false;
  open = false;
  disabled = false;
  checked = false;
  value = '';
  type = '';
  href = '';
  rel = '';
  target = '';
  name = '';
  // Set by select(), as a text field's whole text is selected.
  selected = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  // How often scrollIntoView was called.
  scrolledIntoView = 0;
  // An image's source, and a canvas's size and what was drawn on it (SF-064).
  src = '';
  alt = '';
  width = 0;
  height = 0;
  readonly drawn: unknown[] = [];
  children: FakeNode[] = [];
  parentNode: FakeElement | null = null;
  dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly document: FakeDocument;
  // The custom properties set through style.setProperty; nothing else of style exists.
  readonly style: { properties: Map<string, string>; setProperty(name: string, value: string): void; getPropertyValue(name: string): string };

  constructor(document: FakeDocument, tagName: string) {
    this.document = document;
    this.tagName = tagName.toUpperCase();
    const properties = new Map<string, string>();
    this.style = {
      properties,
      setProperty: (name, value) => {
        properties.set(name, String(value));
      },
      getPropertyValue: (name) => properties.get(name) ?? '',
    };
  }

  get parentElement(): FakeElement | null {
    return this.parentNode;
  }

  get textContent(): string {
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(text: string) {
    this.replaceChildren(...(String(text) === '' ? [] : [String(text)]));
  }

  get classList() {
    const names = (): string[] => this.className.split(/\s+/).filter((name) => name !== '');
    const set = (list: string[]): void => {
      this.className = list.join(' ');
    };
    return {
      contains: (name: string) => names().includes(name),
      add: (...added: string[]) => set([...names(), ...added.filter((name) => !names().includes(name))]),
      remove: (...removed: string[]) => set(names().filter((name) => !removed.includes(name))),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !names().includes(name);
        set(on ? [...names().filter((other) => other !== name), name] : names().filter((other) => other !== name));
        return on;
      },
    };
  }

  private adopt(node: FakeNode | string): FakeNode {
    const child = typeof node === 'string' ? new FakeText(node) : node;
    if (child.parentNode !== null) {
      child.parentNode.children = child.parentNode.children.filter((other) => other !== child);
    }
    child.parentNode = this;
    return child;
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const node of nodes) {
      this.children.push(this.adopt(node));
    }
  }

  prepend(...nodes: Array<FakeNode | string>): void {
    this.children.unshift(...nodes.map((node) => this.adopt(node)));
  }

  replaceChildren(...nodes: Array<FakeNode | string>): void {
    for (const child of this.children) {
      child.parentNode = null;
    }
    this.children = [];
    this.append(...nodes);
  }

  // Puts the nodes where this element is, as a browser's replaceWith does (the Stream draws one
  // entry again in place).
  replaceWith(...nodes: Array<FakeNode | string>): void {
    const parent = this.parentNode;
    if (parent === null) {
      return;
    }
    const adopted = nodes.map((node) => parent.adopt(node));
    parent.children.splice(parent.children.indexOf(this), 1, ...adopted);
    this.parentNode = null;
  }

  // Puts the nodes right before or after this element in its parent, as a browser's before and
  // after do (SF-107 moves #msg and #action-status into the hand-over panel and back).
  before(...nodes: Array<FakeNode | string>): void {
    this.insertBeside(nodes, 0);
  }

  after(...nodes: Array<FakeNode | string>): void {
    this.insertBeside(nodes, 1);
  }

  private insertBeside(nodes: Array<FakeNode | string>, offset: number): void {
    const parent = this.parentNode;
    if (parent === null) {
      return;
    }
    const adopted = nodes.map((node) => parent.adopt(node));
    parent.children.splice(parent.children.indexOf(this) + offset, 0, ...adopted);
  }

  remove(): void {
    if (this.parentNode !== null) {
      this.parentNode.children = this.parentNode.children.filter((other) => other !== this);
      this.parentNode = null;
    }
  }

  contains(node: unknown): boolean {
    for (let current = node as FakeNode | null; current !== null && current !== undefined; current = current.parentNode) {
      if (current === this) {
        return true;
      }
    }
    return false;
  }

  setAttribute(name: string, value: string): void {
    const text = String(value);
    if (name.startsWith('data-')) {
      this.dataset[camel(name.slice(5))] = text;
    } else if (name === 'id') {
      this.id = text;
    } else if (name === 'class') {
      this.className = text;
    } else {
      this.attributes.set(name, text);
    }
  }

  getAttribute(name: string): string | null {
    if (name.startsWith('data-')) {
      return this.dataset[camel(name.slice(5))] ?? null;
    }
    if (name === 'id') {
      return this.id === '' ? null : this.id;
    }
    if (name === 'class') {
      return this.className === '' ? null : this.className;
    }
    if (['hidden', 'disabled', 'checked', 'open'].includes(name)) {
      return (this as unknown as Record<string, boolean>)[name] ? '' : null;
    }
    if (['type', 'href', 'value', 'name'].includes(name) && !this.attributes.has(name)) {
      const value = (this as unknown as Record<string, string | undefined>)[name];
      return value === undefined || value === '' ? null : value;
    }
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  removeAttribute(name: string): void {
    if (name.startsWith('data-')) {
      delete this.dataset[camel(name.slice(5))];
    } else {
      this.attributes.delete(name);
    }
  }

  // Every attribute the element has, data-* included, for the checks of the markup.
  attributeNames(): string[] {
    return [...this.attributes.keys(), ...Object.keys(this.dataset).map((key) => `data-${kebab(key)}`)];
  }

  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  removeEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((other) => other !== listener));
  }

  // Fires the event at the element, then at each ancestor and, for an element in the page, at the
  // document, as a bubbling event does; event fills in the event's own fields (key, altKey, ...).
  dispatch(name: string, event: Record<string, unknown> = {}): FakeEvent {
    const full = newEvent(name, this, event);
    for (let current: FakeElement | null = this; current !== null; current = current.parentNode) {
      fire(current.listeners, full);
      if (full.stopped) {
        return full;
      }
      if (current.parentNode === null && current === this.document.documentElement) {
        fire(this.document.listeners, full);
      }
    }
    return full;
  }

  // A canvas's 2D context: drawImage records what it draws.
  getContext(kind: string): { drawImage(image: unknown, ...rest: unknown[]): void } | null {
    return kind === '2d' ? { drawImage: (image) => void this.drawn.push(image) } : null;
  }

  // A canvas's PNG, a little later as a browser gives it: the bytes name its size and what was drawn.
  toBlob(callback: (blob: Blob | null) => void, type = 'image/png'): void {
    const bytes = Buffer.concat([CANVAS_PNG, Buffer.from(`${this.width}x${this.height}:${this.drawn.length}`)]);
    setImmediate(() => callback(new Blob([bytes], { type })));
  }

  // Like a browser: a disabled control gets no click.
  click(): void {
    if (!this.disabled) {
      this.dispatch('click');
    }
  }

  focus(): void {
    this.document.activeElement = this;
  }

  blur(): void {
    if (this.document.activeElement === this) {
      this.document.activeElement = null;
    }
  }

  select(): void {
    this.selected = true;
  }

  scrollIntoView(): void {
    this.scrolledIntoView += 1;
  }

  matches(selector: string): boolean {
    return parseSelector(selector).some((complex) => matchComplex(this, complex));
  }

  closest(selector: string): FakeElement | null {
    const list = parseSelector(selector);
    for (let current: FakeElement | null = this; current !== null; current = current.parentNode) {
      if (list.some((complex) => matchComplex(current!, complex))) {
        return current;
      }
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const list = parseSelector(selector);
    return this.all().filter((element) => list.some((complex) => matchComplex(element, complex)));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  // The elements among the descendants, depth first.
  all(): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (node: FakeNode): void => {
      if (node instanceof FakeElement) {
        found.push(node);
        node.children.forEach(walk);
      }
    };
    this.children.forEach(walk);
    return found;
  }
}

// Selectors: lists of complex selectors (compounds joined by descendant or child combinators), each
// compound a tag, #id, .class, [attr], [attr="value"] (=, ^=, $=, *=), :not(compound) and :focus.
interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attributes: Array<{ name: string; op: string | null; value: string }>;
  not: Compound[];
  focus: boolean;
}
type Complex = Array<{ compound: Compound; combinator: ' ' | '>' }>;

const selectorCache = new Map<string, Complex[]>();

function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== null) {
      quote = char === quote ? null : quote;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '[' || char === '(') {
      depth += 1;
    } else if (char === ']' || char === ')') {
      depth -= 1;
    } else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function parseCompound(text: string): Compound {
  const compound: Compound = { tag: null, id: null, classes: [], attributes: [], not: [], focus: false };
  const pattern = /^(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([\^$*]?=)("[^"]*"|'[^']*'|[^\]]*))?\]|:not\(([^)]*)\)|:(focus(?:-visible)?)/y;
  let index = 0;
  while (index < text.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (match === null || match[0] === '') {
      throw new Error(`fake-dom: unsupported selector "${text}"`);
    }
    if (match[1] !== undefined && match[1] !== '*') {
      compound.tag = match[1].toUpperCase();
    } else if (match[2] !== undefined) {
      compound.id = match[2];
    } else if (match[3] !== undefined) {
      compound.classes.push(match[3]);
    } else if (match[4] !== undefined) {
      const raw = match[6] ?? '';
      compound.attributes.push({ name: match[4], op: match[5] ?? null, value: /^["']/.test(raw) ? raw.slice(1, -1) : raw });
    } else if (match[7] !== undefined) {
      compound.not.push(...splitTop(match[7], ',').map(parseCompound));
    } else if (match[8] !== undefined) {
      compound.focus = true;
    }
    index = pattern.lastIndex;
  }
  return compound;
}

function parseSelector(selector: string): Complex[] {
  const cached = selectorCache.get(selector);
  if (cached !== undefined) {
    return cached;
  }
  const list = splitTop(selector, ',').map((complex) => {
    const parts: Complex = [];
    let combinator: ' ' | '>' = ' ';
    for (const token of complex.replace(/\s*>\s*/g, ' > ').split(/\s+/)) {
      if (token === '>') {
        combinator = '>';
        continue;
      }
      parts.push({ compound: parseCompound(token), combinator });
      combinator = ' ';
    }
    return parts;
  });
  selectorCache.set(selector, list);
  return list;
}

function matchCompound(element: FakeElement, compound: Compound): boolean {
  if (compound.tag !== null && element.tagName !== compound.tag) {
    return false;
  }
  if (compound.id !== null && element.id !== compound.id) {
    return false;
  }
  if (compound.classes.some((name) => !element.classList.contains(name))) {
    return false;
  }
  if (compound.focus && element.document.activeElement !== element) {
    return false;
  }
  for (const { name, op, value } of compound.attributes) {
    const actual = element.getAttribute(name);
    if (actual === null) {
      return false;
    }
    if ((op === '=' && actual !== value) || (op === '^=' && !actual.startsWith(value)) || (op === '$=' && !actual.endsWith(value)) || (op === '*=' && !actual.includes(value))) {
      return false;
    }
  }
  return !compound.not.some((other) => matchCompound(element, other));
}

// Right to left, against the whole tree, as a browser matches (querySelectorAll only keeps the
// descendants).
function matchComplex(element: FakeElement, complex: Complex): boolean {
  const last = complex.length - 1;
  if (!matchCompound(element, complex[last]!.compound)) {
    return false;
  }
  const step = (node: FakeElement, index: number): boolean => {
    if (index < 0) {
      return true;
    }
    const { combinator } = complex[index + 1]!;
    for (let current = node.parentNode; current !== null; current = current.parentNode) {
      if (matchCompound(current, complex[index]!.compound) && step(current, index - 1)) {
        return true;
      }
      if (combinator === '>') {
        return false;
      }
    }
    return false;
  };
  return step(element, last - 1);
}

export class FakeDocument {
  readonly listeners = new Map<string, Listener[]>();
  readonly documentElement: FakeElement;
  body: FakeElement;
  activeElement: FakeElement | null = null;
  title = '';
  visibilityState: 'visible' | 'hidden' = 'visible';

  constructor() {
    this.documentElement = new FakeElement(this, 'html');
    this.body = this.documentElement;
  }

  get hidden(): boolean {
    return this.visibilityState === 'hidden';
  }

  getElementById(id: string): FakeElement | null {
    return this.documentElement.id === id ? this.documentElement : this.documentElement.all().find((element) => element.id === id) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }

  // An element of a namespace (the SVG charts of SF-117): a FakeElement with namespaceURI set.
  createElementNS(namespace: string, tagName: string): FakeElement {
    const element = new FakeElement(this, tagName);
    element.namespaceURI = namespace;
    return element;
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  removeEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((other) => other !== listener));
  }

  // An event at the document itself (DOMContentLoaded, visibilitychange).
  dispatch(name: string, event: Record<string, unknown> = {}): FakeEvent {
    const full = newEvent(name, this, event);
    fire(this.listeners, full);
    return full;
  }
}

const VOID = new Set(['meta', 'link', 'input', 'br', 'img', 'hr', 'source', 'col', 'wbr']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text: string): string => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) =>
  name.startsWith('#x') || name.startsWith('#X') ? String.fromCodePoint(parseInt(name.slice(2), 16))
    : name.startsWith('#') ? String.fromCodePoint(Number(name.slice(1))) : ENTITIES[name] ?? whole);

// The page's markup as a tree under document.documentElement: elements with their attributes (the
// boolean ones as a browser reads them) and the text that is not only white space.
export function parseHtml(document: FakeDocument, html: string): void {
  const stack: FakeElement[] = [document.documentElement];
  const token = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/gi;
  for (const match of html.matchAll(token)) {
    const top = stack[stack.length - 1]!;
    if (match[4] !== undefined) {
      if (match[4].trim() !== '') {
        top.append(document.createTextNode(decode(match[4])));
      }
      continue;
    }
    if (match[1] !== undefined) {
      const tag = match[1].toUpperCase();
      const at = stack.map((element) => element.tagName).lastIndexOf(tag);
      if (at > 0) {
        stack.length = at;
      }
      continue;
    }
    if (match[2] === undefined) {
      continue;
    }
    const tag = match[2].toLowerCase();
    if (tag === 'html') {
      continue;
    }
    const element = document.createElement(tag);
    for (const attribute of (match[3] ?? '').matchAll(/([^\s=>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
      const name = attribute[1]!.toLowerCase();
      const raw = attribute[2];
      const value = raw === undefined ? '' : decode(/^["']/.test(raw) ? raw.slice(1, -1) : raw);
      if (['hidden', 'checked', 'disabled', 'open'].includes(name)) {
        (element as unknown as Record<string, boolean>)[name] = true;
      } else if (['type', 'href', 'value', 'name', 'rel', 'target'].includes(name)) {
        (element as unknown as Record<string, string>)[name] = value;
        element.attributes.set(name, value);
      } else {
        element.setAttribute(name, value);
      }
    }
    top.append(element);
    if (tag === 'body') {
      document.body = element;
    }
    if (!VOID.has(tag)) {
      stack.push(element);
    }
  }
}

// The first bytes of the PNG a fake canvas's toBlob gives.
export const CANVAS_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface FetchRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  // A text body; a Blob or File body (an image upload, SF-064) is in blob instead.
  body: string | undefined;
  blob: Blob | undefined;
  // Answers the request with a status and a body (an object is sent as JSON; a Blob as it is, its
  // type the content type).
  respond(status: number, body: unknown): void;
  // Fails the request as a network error does.
  fail(message?: string): void;
  // The headers arrive with this status, then reading the body fails (a cut connection).
  failBody(status: number, message?: string): void;
}

export interface Page {
  document: FakeDocument;
  $(id: string): FakeElement;
  // Every fetch the page made, in order.
  requests: FetchRequest[];
  // The event streams the page opened, in order; the last one is the live one.
  streams: FakeEventSource[];
  // The page's timers, in order; none fires by itself: the test calls fire.
  timers: Array<{ ms: number; cleared: boolean; fired: boolean; fire(): void }>;
  // Fires every timer of ms not cleared or fired yet; how many fired.
  tick(ms: number): number;
  // A key pressed where the focus is (on the page when nothing has it); the event as the page left it.
  key(key: string, init?: Record<string, unknown>): FakeEvent;
  // Lets the page's pending promises run.
  flush(): Promise<void>;
  location: { hash: string; pathname: string; search: string };
  // The URLs history.pushState was given, in order.
  pushed: string[];
  window: { dispatch(name: string, event?: Record<string, unknown>): Record<string, unknown> };
  // URL.createObjectURL's URLs (blob:fake/1, ...) with their Blobs, and the ones revoked (SF-064).
  objectUrls: Map<string, Blob>;
  revokedUrls: string[];
}

// The page's clipboard: text, and with write the ClipboardItems (SF-064's Copy image).
export interface FakeClipboard {
  writeText(text: string): Promise<void>;
  write?(items: FakeClipboardItem[]): Promise<void>;
}

// A ClipboardItem as the page builds it: each type with its Blob or the promise of one.
export class FakeClipboardItem {
  readonly items: Record<string, Blob | Promise<Blob>>;

  constructor(items: Record<string, Blob | Promise<Blob>>) {
    this.items = items;
  }

  get types(): string[] {
    return Object.keys(this.items);
  }

  async getType(type: string): Promise<Blob> {
    return this.items[type]!;
  }
}

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: Record<string, unknown>) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  emit(name: string, data?: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(data === undefined ? {} : { data: JSON.stringify(data) });
    }
  }

  close(): void {
    this.closed = true;
  }
}

// The page of a job's Stream (SF-082) that a test does not give: no entries, the end. The job page
// reads its Stream before it opens the job's live stream, so a test about something else gets it.
export const EMPTY_STREAM_PAGE = /^api\/jobs\/[^/]+\/[^/]+\/stream\?from=(\d+)$/;

// Builds the document from the page's HTML, runs app.js in a fresh context against it and returns
// the handles. Fetches are answered by the test, through requests[i].respond, unless autoGet
// answers a GET (undefined leaves it pending; a Stream page it leaves undefined is an empty last
// page). Without a clipboard, navigator has none (as in a context where the browser refuses it);
// globals adds names to the page's context (a localStorage), none by default.
export async function loadPage(
  staticDir: URL, autoGet: (path: string) => unknown, clipboard?: FakeClipboard,
  globals: Record<string, unknown> = {},
): Promise<Page> {
  const html = await readFile(new URL('dashboard.html', staticDir), 'utf8');
  const source = await readFile(new URL('app.js', staticDir), 'utf8');
  const document = new FakeDocument();
  parseHtml(document, html);
  const requests: FetchRequest[] = [];
  const fetch = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Blob } = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const answer = (status: number, body: unknown): void => {
        if (body instanceof Blob) {
          resolve({ ok: status < 400, status, text: async () => body.text(), json: async () => JSON.parse(await body.text()), blob: async () => body });
          return;
        }
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        resolve({ ok: status < 400, status, text: async () => text, json: async () => JSON.parse(text), blob: async () => new Blob([text]) });
      };
      const request: FetchRequest = {
        path, method: init.method ?? 'GET', headers: init.headers ?? {},
        body: typeof init.body === 'string' ? init.body : undefined, blob: init.body instanceof Blob ? init.body : undefined,
        respond: answer,
        fail: (message = 'Failed to fetch') => reject(new TypeError(message)),
        failBody: (status, message = 'network error') => {
          const cut = async (): Promise<never> => {
            throw new TypeError(message);
          };
          resolve({ ok: status < 400, status, text: cut, json: cut, blob: cut });
        },
      };
      requests.push(request);
      if (request.method === 'GET') {
        const body = autoGet(path);
        const page = EMPTY_STREAM_PAGE.exec(path);
        if (body !== undefined) {
          answer(200, body);
        } else if (page !== null) {
          answer(200, { entries: [], next: Number(page[1]), end: true });
        }
      }
    });
  const location = { hash: '', pathname: '/d/token/', search: '' };
  const windowListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const window = {
    addEventListener: (name: string, listener: (event: Record<string, unknown>) => void): void => {
      windowListeners.set(name, [...(windowListeners.get(name) ?? []), listener]);
    },
    // The event the listeners get (an empty one by default) is returned, so a test can read what
    // they set on it (beforeunload's returnValue).
    dispatch: (name: string, event: Record<string, unknown> = {}): Record<string, unknown> => {
      for (const listener of windowListeners.get(name) ?? []) {
        listener(event);
      }
      return event;
    },
  };
  const pushed: string[] = [];
  // Only the hash of the URL is kept: the page's URLs are "#..." (or the path without one).
  const hashOf = (url: string): string => (url.startsWith('#') ? url : '');
  const history = {
    replaceState: (_state: unknown, _title: string, url: string): void => {
      location.hash = hashOf(url);
    },
    pushState: (_state: unknown, _title: string, url: string): void => {
      pushed.push(url);
      location.hash = hashOf(url);
    },
  };
  FakeEventSource.instances.length = 0;
  const timers: Page['timers'] = [];
  const fakeSetTimeout = (callback: () => void, ms: number): number => {
    const timer = {
      ms, cleared: false, fired: false,
      fire() {
        timer.fired = true;
        callback();
      },
    };
    return timers.push(timer);
  };
  const fakeClearTimeout = (id: number | null | undefined): void => {
    if (typeof id === 'number' && timers[id - 1] !== undefined) {
      timers[id - 1]!.cleared = true;
    }
  };
  const navigator = clipboard === undefined ? {} : { clipboard };
  const objectUrls = new Map<string, Blob>();
  const revokedUrls: string[] = [];
  const objectUrl = {
    createObjectURL: (blob: Blob): string => {
      const url = `blob:fake/${objectUrls.size + 1}`;
      objectUrls.set(url, blob);
      return url;
    },
    revokeObjectURL: (url: string): void => void revokedUrls.push(url),
  };
  // A bitmap of the image: its size, and the Blob it was made of.
  const createImageBitmap = async (blob: Blob): Promise<{ width: number; height: number; blob: Blob }> => ({ width: 4, height: 3, blob });
  const context = createContext({
    document, window, location, history, navigator, fetch, EventSource: FakeEventSource, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, URLSearchParams, console,
    Blob, File, URL: objectUrl, ClipboardItem: FakeClipboardItem, createImageBitmap, ...globals,
  });
  runInContext(source, context, { filename: 'app.js' });
  return {
    document,
    $: (id) => {
      const element = document.getElementById(id);
      if (element === null) {
        throw new Error(`no element #${id} in dashboard.html`);
      }
      return element;
    },
    requests,
    streams: FakeEventSource.instances,
    timers,
    tick(ms) {
      const due = timers.filter((timer) => timer.ms === ms && !timer.cleared && !timer.fired);
      due.forEach((timer) => timer.fire());
      return due.length;
    },
    key(key, init = {}) {
      return (document.activeElement ?? document.body).dispatch('keydown', { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init });
    },
    async flush() {
      for (let round = 0; round < 5; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    location,
    pushed,
    window,
    objectUrls,
    revokedUrls,
  };
}
