// A small stand-in for the dashboard page, so static/app.js runs under node:vm: a document with
// the elements of static/dashboard.html (by id), elements with the properties the script uses,
// a scripted fetch, a scripted EventSource and, when the test gives one, a clipboard. It is not a browser: layout, focus order, CSS and
// default actions (Enter in a textarea, a form's own submission) are out of its reach; the manual
// browser steps in factory/README.md cover those.
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

export class FakeText {
  readonly nodeType = 3;
  textContent: string;

  constructor(text: string) {
    this.textContent = text;
  }
}

type Listener = (event: Record<string, unknown>) => void;

export class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
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
  // Set by select(), as a text field's whole text is selected.
  selected = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  children: Array<FakeElement | FakeText> = [];
  dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly document: FakeDocument;

  constructor(document: FakeDocument, tagName: string) {
    this.document = document;
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string {
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(text: string) {
    this.children = text === '' ? [] : [new FakeText(String(text))];
  }

  append(...nodes: Array<FakeElement | FakeText | string>): void {
    for (const node of nodes) {
      this.children.push(typeof node === 'string' ? new FakeText(node) : node);
    }
  }

  replaceChildren(...nodes: Array<FakeElement | FakeText | string>): void {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  dispatch(name: string, event: Record<string, unknown> = {}): void {
    const full = { preventDefault: () => undefined, target: this, ...event };
    for (const listener of this.listeners.get(name) ?? []) {
      listener(full);
    }
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

  select(): void {
    this.selected = true;
  }

  // Tag selectors only.
  querySelectorAll(selector: string): FakeElement[] {
    const wanted = selector.toUpperCase();
    const found: FakeElement[] = [];
    const walk = (node: FakeElement | FakeText): void => {
      if (node instanceof FakeElement) {
        if (node.tagName === wanted) {
          found.push(node);
        }
        node.children.forEach(walk);
      }
    };
    this.children.forEach(walk);
    return found;
  }

  // The elements among the descendants, depth first.
  all(): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (node: FakeElement | FakeText): void => {
      if (node instanceof FakeElement) {
        found.push(node);
        node.children.forEach(walk);
      }
    };
    this.children.forEach(walk);
    return found;
  }
}

export class FakeDocument {
  readonly elements = new Map<string, FakeElement>();
  readonly listeners = new Map<string, Listener[]>();
  activeElement: FakeElement | null = null;

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  dispatch(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({});
    }
  }
}

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Listener[]>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: Listener): void {
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

export interface FetchRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  // Answers the request with a status and a body (an object is sent as JSON).
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
  timers: Array<{ ms: number; cleared: boolean; fire(): void }>;
  // Lets the page's pending promises run.
  flush(): Promise<void>;
  location: { hash: string };
  window: { dispatch(name: string): void };
}

// Builds the document from the page's HTML (every element with an id, under its tag), runs
// app.js in a fresh context against it and returns the handles. Fetches are answered by the
// test, through requests[i].respond, unless autoGet answers a GET (undefined leaves it pending).
// Without a clipboard, navigator has none (as in a context where the browser refuses it).
export async function loadPage(staticDir: URL, autoGet: (path: string) => unknown, clipboard?: { writeText(text: string): Promise<void> }): Promise<Page> {
  const html = await readFile(new URL('dashboard.html', staticDir), 'utf8');
  const source = await readFile(new URL('app.js', staticDir), 'utf8');
  const document = new FakeDocument();
  for (const match of html.matchAll(/<(\w+)([^>]*)>/g)) {
    const attributes = match[2]!;
    const id = /\bid="([^"]+)"/.exec(attributes)?.[1];
    if (id === undefined) {
      continue;
    }
    const element = document.createElement(match[1]!);
    element.id = id;
    // The boolean attributes the page starts with, as a browser would read them.
    element.hidden = /\shidden(?=[\s>]|$)/.test(attributes);
    element.checked = /\schecked(?=[\s>]|$)/.test(attributes);
    element.disabled = /\sdisabled(?=[\s>]|$)/.test(attributes);
    element.open = /\sopen(?=[\s>]|$)/.test(attributes);
    document.elements.set(id, element);
  }
  // The three view tabs are the only elements the script finds without an id.
  for (const view of ['report', 'files', 'patch']) {
    const button = document.createElement('button');
    button.dataset.view = view;
    document.elements.get('iteration-views')!.append(button);
  }
  const requests: FetchRequest[] = [];
  const fetch = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const answer = (status: number, body: unknown): void => {
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        resolve({ ok: status < 400, status, text: async () => text, json: async () => JSON.parse(text) });
      };
      const request: FetchRequest = {
        path, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body,
        respond: answer,
        fail: (message = 'Failed to fetch') => reject(new TypeError(message)),
        failBody: (status, message = 'network error') => {
          const cut = async (): Promise<never> => {
            throw new TypeError(message);
          };
          resolve({ ok: status < 400, status, text: cut, json: cut });
        },
      };
      requests.push(request);
      if (request.method === 'GET') {
        const body = autoGet(path);
        if (body !== undefined) {
          answer(200, body);
        }
      }
    });
  const location = { hash: '' };
  const windowListeners = new Map<string, Listener[]>();
  const window = {
    addEventListener: (name: string, listener: Listener): void => {
      windowListeners.set(name, [...(windowListeners.get(name) ?? []), listener]);
    },
    dispatch: (name: string): void => {
      for (const listener of windowListeners.get(name) ?? []) {
        listener({});
      }
    },
  };
  const history = {
    replaceState: (_state: unknown, _title: string, url: string): void => {
      location.hash = url;
    },
  };
  FakeEventSource.instances.length = 0;
  const timers: Page['timers'] = [];
  const fakeSetTimeout = (fire: () => void, ms: number): number => timers.push({ ms, cleared: false, fire });
  const fakeClearTimeout = (id: number | null): void => {
    if (id !== null && timers[id - 1] !== undefined) {
      timers[id - 1]!.cleared = true;
    }
  };
  const navigator = clipboard === undefined ? {} : { clipboard };
  const context = createContext({ document, window, location, history, navigator, fetch, EventSource: FakeEventSource, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, URLSearchParams, console });
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
    async flush() {
      for (let round = 0; round < 5; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    location,
    window,
  };
}
