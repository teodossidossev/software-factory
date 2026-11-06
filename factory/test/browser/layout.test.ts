// The dashboard's layout in a real browser (SF-091): the light and dark colour schemes with their
// contrast (WCAG relative luminance), and a narrow phone-sized window.
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { browserTest, contrast, eventually, type Fixture, JOBS, WS } from './support.js';

interface Colours {
  color: string;
  background: string;
}

// An element's computed color and its background: its own background-color, or, while that is
// transparent, the one of the nearest ancestor whose background is not.
async function coloursOf(page: Page, selector: string): Promise<Colours[]> {
  return page.locator(selector).evaluateAll((nodes) => nodes.map((node) => {
    const transparent = (value: string): boolean => value === 'transparent' || /^rgba\(.*,\s*0\)$/.test(value);
    let at: Element | null = node;
    let background = 'rgb(255, 255, 255)';
    while (at !== null) {
      const value = getComputedStyle(at).backgroundColor;
      if (!transparent(value)) {
        background = value;
        break;
      }
      at = at.parentElement;
    }
    return { color: getComputedStyle(node).color, background };
  }));
}

// The text of what has at least 4.5:1 against its background (WCAG 2, AA for normal text).
function assertContrast(what: string, { color, background }: Colours): void {
  const ratio = contrast(color, background);
  assert.ok(ratio >= 4.5, `${what}: ${color} on ${background} is ${ratio.toFixed(2)}:1`);
}

async function board(fx: Fixture, scheme: 'light' | 'dark'): Promise<void> {
  await fx.page.emulateMedia({ colorScheme: scheme });
  await fx.open();
  await fx.page.locator('#cols .card .title').first().waitFor();
}

browserTest('light and dark: body\'s background-color and color differ between the two schemes', async (fx) => {
  await board(fx, 'light');
  const [light] = await coloursOf(fx.page, 'body');
  await fx.page.emulateMedia({ colorScheme: 'dark' });
  const [dark] = await coloursOf(fx.page, 'body');
  assert.notEqual(light!.background, dark!.background, 'background-color');
  assert.notEqual(light!.color, dark!.color, 'color');
});

for (const scheme of ['light', 'dark'] as const) {
  browserTest(`light and dark: in the ${scheme} scheme the board's text and its cards' titles have a contrast of at least 4.5:1`, async (fx) => {
    await board(fx, scheme);
    const [body] = await coloursOf(fx.page, 'body');
    assertContrast('body', body!);
    const titles = await coloursOf(fx.page, '#cols .card .title');
    assert.ok(titles.length > 0);
    // The card itself (.card) has var(--panel): its background, not the column's.
    const cards = await coloursOf(fx.page, '#cols .card');
    assert.deepEqual(titles.map((title) => title.background), cards.map((card) => card.background));
    for (const title of titles) {
      assertContrast('.card .title', title);
    }
  });

  browserTest(`light and dark: in the ${scheme} scheme the job page's text has a contrast of at least 4.5:1`, async (fx) => {
    await fx.page.emulateMedia({ colorScheme: scheme });
    await fx.open(`${WS}/${JOBS.working}`);
    await fx.page.locator('#job').waitFor();
    const [body] = await coloursOf(fx.page, 'body');
    assertContrast('body', body!);
  });
}

const horizontalScroll = (page: Page): Promise<{ scrollWidth: number; innerWidth: number }> =>
  page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }));

browserTest('narrow width: at 390 x 844 the board has no horizontal scroll', async (fx) => {
  await fx.page.setViewportSize({ width: 390, height: 844 });
  await fx.open();
  await fx.page.locator('#cols .card').first().waitFor();
  const { scrollWidth, innerWidth } = await horizontalScroll(fx.page);
  assert.ok(scrollWidth <= innerWidth, `scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`);
});

browserTest('narrow width: at 390 x 844 the job page has no horizontal scroll and the stopped job\'s Simplify is in view', async (fx) => {
  await fx.page.setViewportSize({ width: 390, height: 844 });
  await fx.open(`${WS}/${JOBS.simplify}`);
  const simplify = fx.page.locator('#acts').getByRole('button', { name: 'Simplify', exact: true });
  await simplify.waitFor();
  await eventually(() => simplify.isVisible(), true);
  const box = await simplify.boundingBox();
  assert.ok(box !== null);
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `Simplify spans x ${box.x}-${box.x + box.width}`);
  assert.ok(box.y >= 0 && box.y + box.height <= 844, `Simplify spans y ${box.y}-${box.y + box.height}`);
  const { scrollWidth, innerWidth } = await horizontalScroll(fx.page);
  assert.ok(scrollWidth <= innerWidth, `scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`);
});
