// point-page.js, the Point bookmarklet's point mode, built from web/point-page.ts into dist/web/.
// The pins panel writes the bookmarklet from this file and pin-selector.js (pinBookmarklet in
// pins.js), both wrapped in one arrow function that ends with pointOnPage(<the factory's origin>),
// and the user runs it in any page. It holds no secret and asks the network for nothing: the page
// reaches the factory only through the factory window (point.js at <factory>/point), which it
// opens, and postMessage, with the factory's origin as the target of every message.
// - A second run of the bookmarklet in the same page ends the first (window.sfPointStop).
// - On a page of the factory's own origin it shows its bar with one message and ends there: no
//   window, no timer, no message, no listener on window or document, so the page keeps its keys
//   (Shift+P turns the dashboard's own point mode on).
// - Elsewhere it opens the factory window, says hello once the window is ready, and enables Point
//   once the window says the user allowed the page. Pointing stops the page's own pointer and
//   mouse actions (on window, in the capture phase); a click opens a note field next to the
//   element, whose Save or Skip sends the pin to the window; the window answers saved or refused.
//   Escape stops pointing. The pins saved in this run show as markers 📍<id>.
// Every element is appended to document.documentElement, styled only through style.setProperty
// (all: initial first, each property important, so the page's own styles do not reach them),
// every text set through textContent. It shares nothing with the page but window.sfPointStop: its
// one top-level name is pointOnPage, and of the other scripts it calls only pin-selector.js.
'use strict';

function pointOnPage(factory: string): void {
  const host = window as Window & { sfPointStop?: unknown };
  if (typeof host.sfPointStop === 'function') {
    (host.sfPointStop as () => void)();
    return;
  }

  type State = 'FACTORY' | 'OPENING' | 'BLOCKED' | 'ALLOW' | 'PRESS' | 'POINTING' | 'SAVED' | 'REFUSED' | 'NO_ANSWER' | 'CLOSED' | 'TOO_LONG';
  const STATUS: Record<Exclude<State, 'SAVED'>, string> = {
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
  // The states that show Open the factory window.
  const OPEN_SHOWN: readonly State[] = ['BLOCKED', 'NO_ANSWER', 'CLOSED'];
  // How long the window has to say ready after each open.
  const ANSWER_MS = 10000;
  // The events stopped while pointing, as the dashboard's point mode stops them.
  const STOPPED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'dragstart'];
  const BLUE = '#2b6cb0';
  const INK = '#1f2328';
  const FONT = '13px/1.4 system-ui, sans-serif';

  // ---------- The elements ----------

  const style = (node: HTMLElement, properties: Record<string, string>): void => {
    for (const [name, value] of Object.entries(properties)) {
      node.style.setProperty(name, value, 'important');
    }
  };
  // An element with an id, all: initial and then its own properties, its text (if any) as text.
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, id: string, properties: Record<string, string>, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    style(node, { all: 'initial', 'box-sizing': 'border-box', ...properties });
    if (id !== '') {
      node.id = id;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  };
  // all: initial undoes the hidden attribute's display: none, so display says it too.
  const show = (node: HTMLElement, on: boolean, display: string): void => {
    node.hidden = !on;
    style(node, { display: on ? display : 'none' });
  };
  const BUTTON = { font: FONT, color: INK, background: '#ffffff', border: '1px solid #8c959f', 'border-radius': '6px', padding: '2px 10px', cursor: 'pointer', 'white-space': 'nowrap' };

  const bar = make('div', 'sf-point-bar', {
    position: 'fixed', top: '12px', right: '12px', 'z-index': '2147483647', display: 'flex', 'flex-wrap': 'wrap', 'align-items': 'center', gap: '8px',
    'max-width': 'min(520px, calc(100vw - 24px))', padding: '8px 10px', color: INK, background: '#f4f5f7', font: FONT,
    border: '1px solid #8c959f', 'border-radius': '8px', 'box-shadow': '0 4px 16px rgba(0, 0, 0, .25)',
  });
  const title = make('span', '', { font: FONT, color: INK, 'font-weight': '600', 'white-space': 'nowrap' }, '📍 Factory');
  const status = make('span', 'sf-point-status', { font: FONT, color: INK, flex: '1 1 200px', 'min-width': '0', 'overflow-wrap': 'anywhere' });
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const toggle = make('button', 'sf-point-toggle', BUTTON, 'Point');
  toggle.type = 'button';
  toggle.setAttribute('aria-pressed', 'false');
  const openButton = make('button', 'sf-point-open', BUTTON, 'Open the factory window');
  openButton.type = 'button';
  const close = make('button', 'sf-point-close', { ...BUTTON, padding: '2px 8px' }, '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close point mode');
  bar.append(title, status, toggle, openButton, close);

  // Point: pressed while pointing, disabled until the window says allowed.
  const drawToggle = (enabled: boolean, pressed: boolean): void => {
    toggle.disabled = !enabled;
    toggle.setAttribute('aria-pressed', String(pressed));
    style(toggle, {
      opacity: enabled ? '1' : '0.5', cursor: enabled ? 'pointer' : 'default',
      background: pressed ? BLUE : '#ffffff', color: pressed ? '#ffffff' : INK,
    });
  };
  const say = (state: State, saved?: number): void => {
    status.textContent = state === 'SAVED' ? `📍${saved ?? ''} saved.` : STATUS[state];
    show(openButton, OPEN_SHOWN.includes(state), 'inline-block');
  };

  // ---------- The factory's own pages ----------

  // Its address may hold the dashboard's token, and every message would carry it: the bar alone,
  // and nothing else.
  if (location.origin === factory) {
    const stop = (): void => {
      bar.remove();
      delete host.sfPointStop;
    };
    host.sfPointStop = stop;
    close.addEventListener('click', stop);
    drawToggle(false, false);
    say('FACTORY');
    document.documentElement.append(bar);
    return;
  }

  const outline = make('div', 'sf-point-outline', {
    position: 'fixed', 'z-index': '2147483646', 'pointer-events': 'none', outline: `2px solid ${BLUE}`, 'outline-offset': '1px', 'border-radius': '3px',
  });
  const note = make('div', 'sf-point-note', {
    position: 'fixed', 'z-index': '2147483647', width: 'min(300px, calc(100vw - 16px))', gap: '8px', padding: '10px', color: INK, background: '#ffffff', font: FONT,
    border: '1px solid #8c959f', 'border-radius': '8px', 'box-shadow': '0 6px 20px rgba(0, 0, 0, .25)',
  });
  note.setAttribute('role', 'dialog');
  note.setAttribute('aria-label', 'Note for the pin');
  const noteText = make('textarea', 'sf-point-note-text', {
    display: 'block', width: '100%', 'min-height': '64px', resize: 'vertical', padding: '6px 8px', font: FONT, color: INK, background: '#f7f8fa',
    border: '1px solid #8c959f', 'border-radius': '6px', 'white-space': 'pre-wrap',
  });
  noteText.maxLength = 500;
  noteText.rows = 3;
  noteText.placeholder = 'What about it? (optional)';
  noteText.setAttribute('aria-label', 'Note');
  const save = make('button', '', { ...BUTTON, background: BLUE, color: '#ffffff', border: `1px solid ${BLUE}` }, 'Save');
  save.type = 'button';
  const skip = make('button', '', BUTTON, 'Skip');
  skip.type = 'button';
  const noteRow = make('div', '', { display: 'flex', gap: '6px', 'justify-content': 'flex-end' });
  noteRow.append(save, skip);
  note.append(noteText, noteRow);
  const layer = make('div', 'sf-point-layer', { position: 'fixed', inset: '0', 'z-index': '2147483646', 'pointer-events': 'none', overflow: 'hidden' });
  show(outline, false, 'block');
  show(note, false, 'grid');

  // ---------- The run ----------

  interface Taken { node: Element; selector: string; text: string; rect: { x: number; y: number; w: number; h: number; vw: number; vh: number } }
  const run = {
    factoryWindow: null as Window | null,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    pointing: false,
    // The element whose note field is open, measured at its click.
    taken: null as Taken | null,
    hover: null as Element | null,
    // The last ref sent, and each ref's element; the pins saved, in order.
    ref: 0,
    sent: new Map<number, Element>(),
    saved: [] as Array<{ id: number; node: Element }>,
    frame: false,
    stopped: false,
  };

  const isElement = (value: unknown): value is Element => typeof value === 'object' && value !== null && (value as Node).nodeType === 1;
  const own = (node: Element | null): boolean => node !== null && (bar.contains(node) || note.contains(node));
  const outer = (node: Element | null): boolean => node === null || node === document.body || node === document.documentElement;

  const drawOutline = (): void => {
    const box = run.pointing && run.hover !== null ? run.hover.getBoundingClientRect() : undefined;
    if (box === undefined || (box.width === 0 && box.height === 0)) {
      show(outline, false, 'block');
      return;
    }
    style(outline, { left: `${Math.round(box.left)}px`, top: `${Math.round(box.top)}px`, width: `${Math.round(box.width)}px`, height: `${Math.round(box.height)}px` });
    show(outline, true, 'block');
  };

  // Each pin saved in this run whose element is still in the document, at its top-left corner,
  // inside the viewport.
  const drawMarkers = (): void => {
    const markers: HTMLElement[] = [];
    for (const { id, node } of run.saved) {
      if (!document.documentElement.contains(node)) {
        continue;
      }
      const box = node.getBoundingClientRect();
      const marker = make('span', '', {
        position: 'absolute', display: 'inline-block', padding: '3px 6px 3px 3px', 'border-radius': '999px', font: '600 12px/1.4 system-ui, sans-serif',
        color: '#ffffff', background: BLUE, 'white-space': 'nowrap', 'box-shadow': '0 1px 4px rgba(0, 0, 0, .3)',
      }, `📍${id}`);
      marker.dataset.sfPin = String(id);
      markers.push(marker);
      layer.append(marker);
      const width = marker.offsetWidth || 44;
      const height = marker.offsetHeight || 24;
      style(marker, {
        left: `${Math.round(Math.max(0, Math.min(box.left, window.innerWidth - width)))}px`,
        top: `${Math.round(Math.max(0, Math.min(box.top, window.innerHeight - height)))}px`,
      });
    }
    layer.replaceChildren(...markers);
  };

  // The markers and the outline again in the next animation frame (a scroll, a resize).
  const scheduleDraw = (): void => {
    if (run.frame) {
      return;
    }
    run.frame = true;
    requestAnimationFrame(() => {
      run.frame = false;
      if (!run.stopped) {
        drawMarkers();
        drawOutline();
      }
    });
  };

  const setPointing = (on: boolean, enabled: boolean): void => {
    run.pointing = on;
    if (!on) {
      run.hover = null;
      closeNote();
    }
    drawToggle(enabled, on);
    drawOutline();
  };

  // Opens (or opens again) the factory window; the timer gives it 10 s to say ready.
  const openWindow = (): void => {
    setPointing(false, false);
    clearTimeout(run.timer);
    run.timer = undefined;
    run.factoryWindow = window.open(`${factory}/point`, 'sf-point', 'popup,width=440,height=420');
    if (run.factoryWindow === null) {
      say('BLOCKED');
      return;
    }
    say('OPENING');
    run.timer = setTimeout(() => {
      run.timer = undefined;
      say('NO_ANSWER');
    }, ANSWER_MS);
  };

  const post = (message: Record<string, unknown>): void => {
    run.factoryWindow?.postMessage({ sf: 'point', ...message }, factory);
  };

  // ---------- The note field ----------

  const openNote = (taken: Taken, x: number, y: number): void => {
    run.taken = taken;
    noteText.value = '';
    show(note, true, 'grid');
    const width = note.offsetWidth || 300;
    const height = note.offsetHeight || 140;
    const place = (at: number, size: number, room: number): number => Math.round(Math.max(8, Math.min(at + 12, room - size - 8)));
    style(note, { left: `${place(x, width, window.innerWidth)}px`, top: `${place(y, height, window.innerHeight)}px` });
    noteText.focus();
  };

  // The note field closed; the focus leaves it, so the page's keys are the page's again.
  const closeNote = (): void => {
    run.taken = null;
    if (note.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
    show(note, false, 'grid');
  };

  // The pin of the open note field sent to the window with the note; with no window left, nothing
  // is sent and Open shows.
  const send = (text: string): void => {
    const taken = run.taken;
    if (taken === null) {
      return;
    }
    closeNote();
    const target = run.factoryWindow;
    if (target === null || target.closed) {
      setPointing(false, false);
      say('CLOSED');
      return;
    }
    run.ref += 1;
    run.sent.set(run.ref, taken.node);
    post({ type: 'pin', ref: run.ref, url: location.href, selector: taken.selector, text: taken.text, rect: taken.rect, note: text });
  };

  // ---------- The page's events ----------

  // A pointer or mouse event while pointing: anything but the bar and the note field never gets
  // it; the click (not on html or body, the note field closed) takes the element.
  const capture = (event: Event): void => {
    if (!run.pointing) {
      return;
    }
    const target = isElement(event.target) ? event.target : null;
    if (own(target)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== 'click' || target === null || outer(target) || run.taken !== null) {
      return;
    }
    const selector = pinSelector(target);
    if (selector.length > PIN_SELECTOR_CHARS) {
      say('TOO_LONG');
      return;
    }
    const box = target.getBoundingClientRect();
    const rect = { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height), vw: Math.round(window.innerWidth), vh: Math.round(window.innerHeight) };
    const point = event as MouseEvent;
    openNote({ node: target, selector, text: pinText(target), rect }, point.clientX, point.clientY);
  };

  const hover = (event: Event): void => {
    if (!run.pointing) {
      return;
    }
    const target = isElement(event.target) ? event.target : null;
    run.hover = own(target) || outer(target) ? null : target;
    drawOutline();
  };

  // The keys, on window in the capture phase: with the note field open, Enter (without Shift) in
  // its text saves and Escape skips; else Escape while pointing stops pointing. Each goes no
  // further.
  const key = (event: KeyboardEvent): void => {
    const done = (): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    if (run.taken !== null) {
      if (event.key === 'Enter' && !event.shiftKey && event.target === noteText) {
        done();
        send(noteText.value);
      } else if (event.key === 'Escape') {
        done();
        send('');
      }
      return;
    }
    if (event.key === 'Escape' && run.pointing) {
      done();
      setPointing(false, true);
      say('PRESS');
    }
  };

  // The window's messages: only from the window this run opened, of the factory's origin.
  const message = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (run.factoryWindow === null || event.source !== run.factoryWindow || event.origin !== factory || typeof data !== 'object' || data === null) {
      return;
    }
    const { sf, type, ref, id } = data as Record<string, unknown>;
    if (sf !== 'point') {
      return;
    }
    if (type === 'ready') {
      clearTimeout(run.timer);
      run.timer = undefined;
      post({ type: 'hello', url: location.href });
      setPointing(false, false);
      say('ALLOW');
    } else if (type === 'allowed') {
      setPointing(false, true);
      say('PRESS');
    } else if (type === 'saved' && typeof ref === 'number' && typeof id === 'number' && Number.isSafeInteger(id)) {
      const node = run.sent.get(ref);
      if (node !== undefined) {
        run.saved.push({ id, node });
        drawMarkers();
      }
      say('SAVED', id);
    } else if (type === 'refused') {
      say('REFUSED');
    }
  };

  const listeners: Array<[string, EventListener, AddEventListenerOptions]> = [
    ...STOPPED.map((type): [string, EventListener, AddEventListenerOptions] => [type, capture, { capture: true }]),
    ['pointerover', hover, { capture: true, passive: true }],
    ['keydown', key as EventListener, { capture: true }],
    ['scroll', scheduleDraw, { capture: true, passive: true }],
    ['resize', scheduleDraw, {}],
    ['message', message as EventListener, {}],
  ];

  const stop = (): void => {
    run.stopped = true;
    for (const [type, listener, options] of listeners) {
      window.removeEventListener(type, listener, options);
    }
    clearTimeout(run.timer);
    run.timer = undefined;
    for (const node of [bar, outline, note, layer]) {
      node.remove();
    }
    run.factoryWindow?.close();
    run.factoryWindow = null;
    delete host.sfPointStop;
  };
  host.sfPointStop = stop;

  toggle.addEventListener('click', () => {
    if (toggle.disabled) {
      return;
    }
    setPointing(!run.pointing, true);
    say(run.pointing ? 'POINTING' : 'PRESS');
  });
  openButton.addEventListener('click', openWindow);
  close.addEventListener('click', stop);
  save.addEventListener('click', () => send(noteText.value));
  skip.addEventListener('click', () => send(''));
  for (const [type, listener, options] of listeners) {
    window.addEventListener(type, listener, options);
  }
  document.documentElement.append(layer, outline, note, bar);
  openWindow();
}
