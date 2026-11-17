// pin-selector.js, the pins' selector, built from web/pin-selector.ts into dist/web/: how a pin
// names its element (pinSelector), finds it again (pinFind) and reads its text (pinText), within
// the bounds of src/pins.ts. The dashboard loads it right after core.js, for its point mode
// (pins.js); the Point bookmarklet (point-page.js) carries the same file, run in any page, so it
// uses nothing of another script and only what every page has (document, CSS.escape). A classic
// script: no import or export.
'use strict';

// The bounds of src/pins.ts: the text sent, the selector; a data-* value an anchor may use.
const PIN_TEXT_CHARS = 200;
const PIN_SELECTOR_CHARS = 1000;
const PIN_DATA_VALUE_CHARS = 100;

// The element's children of the same tag, its place among them from 1, as nth-of-type counts.
function pinStep(node: Element): string {
  const parent = node.parentElement;
  const same = parent === null ? [node] : Array.from(parent.children).filter((child) => child.tagName === node.tagName);
  return `${node.tagName.toLowerCase()}:nth-of-type(${same.indexOf(node) + 1})`;
}

// The elements the selector finds; none when the page cannot parse it.
function pinMatches(selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch { // a selector the page cannot parse finds nothing
    return [];
  }
}

// The element the selector finds first, or null: none found, or a selector the page cannot parse.
const pinFind = (selector: string): Element | null => pinMatches(selector)[0] ?? null;

// The element as an id anchor: #<id> (escaped with CSS.escape, so any id can be written) when its
// id is unique in the document; else null.
function pinIdAnchor(node: Element): string | null {
  if (node.id === '') {
    return null;
  }
  const selector = `#${CSS.escape(node.id)}`;
  return pinMatches(selector).length === 1 ? selector : null;
}

// The element as a data anchor: <tag>[data-<name>="<value>"] of its first data-* attribute (in
// attribute order) with a value of at most 100 characters without " or \ that finds only this
// element; else null.
function pinDataAnchor(node: Element): string | null {
  for (const name of node.getAttributeNames()) {
    const value = node.getAttribute(name) ?? '';
    if (!name.startsWith('data-') || value.length > PIN_DATA_VALUE_CHARS || /["\\]/.test(value)) {
      continue;
    }
    const selector = `${node.tagName.toLowerCase()}[${name}="${value}"]`;
    const found = pinMatches(selector);
    if (found.length === 1 && found[0] === node) {
      return selector;
    }
  }
  return null;
}

// The selector of a pin's element. Walking from the element up to body, the first element with a
// unique id is the anchor; failing that (no element on the way has one), the first with a data
// anchor (pinDataAnchor); each element below the anchor adds its nth-of-type step, joined with
// ' > '; without an anchor it starts at body. Kept only when it finds the element again; else the
// plain body > ... path of nth-of-type steps.
function pinSelector(node: Element): string {
  // The element and its ancestors below body, nearest first.
  const path: Element[] = [];
  for (let at: Element | null = node; at !== null && at !== document.body; at = at.parentElement) {
    path.push(at);
  }
  const steps = (count: number): string[] => path.slice(0, count).reverse().map(pinStep);
  const plain = ['body', ...steps(path.length)].join(' > ');
  for (const anchorOf of [pinIdAnchor, pinDataAnchor]) {
    for (const [index, at] of path.entries()) {
      const anchor = anchorOf(at);
      if (anchor !== null) {
        const selector = [anchor, ...steps(index)].join(' > ');
        return pinFind(selector) === node ? selector : plain;
      }
    }
  }
  return plain;
}

// The element's visible text: every run of white space as one space, trimmed, at most 200
// characters, never half of a surrogate pair.
function pinText(node: Element): string {
  const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= PIN_TEXT_CHARS) {
    return text;
  }
  const cut = text.slice(0, PIN_TEXT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
