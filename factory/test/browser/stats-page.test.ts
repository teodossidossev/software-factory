// The Stats page in a real browser (SF-117) over the shared fixture: it opens from the header's
// Stats button; at 1200 px the boxes "Cost per day" and "Codex gate tokens per day" sit side by side,
// at 390 x 844 they stack and the page has no horizontal scroll; its text has a contrast of at
// least 4.5:1 in the light and the dark scheme. The fixture's records are dated around 2026-11-01
// and the server runs on the real clock, so nothing here depends on the data being in the period:
// the chart boxes (div.st-chart) always render.
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { browserTest, contrast, type Fixture } from './support.js';

const box = (fx: Fixture, title: string) => fx.page.locator('#stats div.st-chart').filter({ has: fx.page.locator('h4', { hasText: title }) });

async function openStats(fx: Fixture): Promise<void> {
  await fx.open();
  await fx.page.getByRole('button', { name: 'Stats', exact: true }).click();
  await box(fx, 'Cost per day').waitFor();
  assert.equal(new URL(fx.page.url()).hash, '#stats');
}

async function bounds(fx: Fixture, title: string): Promise<{ x: number; y: number; width: number }> {
  const found = await box(fx, title).boundingBox();
  assert.ok(found !== null, title);
  return found;
}

// The text colours of the elements and their backgrounds (the nearest one that is not transparent).
async function coloursOf(page: Page, selector: string): Promise<Array<{ color: string; background: string }>> {
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

browserTest('stats page: the Stats button opens it; at 1200 px the two day charts sit side by side', async (fx) => {
  await fx.page.setViewportSize({ width: 1200, height: 900 });
  await openStats(fx);
  assert.equal(await fx.page.locator('#stats .jhead .title').innerText(), 'Stats');
  const cost = await bounds(fx, 'Cost per day');
  const tokens = await bounds(fx, 'Codex gate tokens per day');
  assert.equal(Math.round(cost.y), Math.round(tokens.y));
  assert.ok(tokens.x > cost.x + cost.width - 1, `left ${cost.x} and ${tokens.x}`);
  assert.deepEqual(fx.problems, []);
});

browserTest('stats page: at 390 x 844 the charts stack and the page has no horizontal scroll', async (fx) => {
  await fx.page.setViewportSize({ width: 390, height: 844 });
  await openStats(fx);
  const cost = await bounds(fx, 'Cost per day');
  const tokens = await bounds(fx, 'Codex gate tokens per day');
  assert.ok(tokens.y > cost.y, `top ${cost.y} and ${tokens.y}`);
  assert.equal(Math.round(cost.x), Math.round(tokens.x));
  const { scrollWidth, width, inner } = await fx.page.evaluate((): { scrollWidth: number; width: number; inner: number } => {
    const scroller = document.querySelector('#stats .form2');
    return { scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth, inner: scroller === null ? 0 : scroller.scrollWidth - scroller.clientWidth };
  });
  assert.ok(scrollWidth <= width, `scrollWidth ${scrollWidth} > innerWidth ${width}`);
  assert.ok(inner <= 0, `the page scrolls ${inner} px sideways`);
});

for (const scheme of ['light', 'dark'] as const) {
  browserTest(`stats page: in the ${scheme} scheme its text has a contrast of at least 4.5:1`, async (fx) => {
    await fx.page.emulateMedia({ colorScheme: scheme });
    await openStats(fx);
    const selector = ['#stats .jhead .title', '#stats .jhead .t2', '#stats .st-sec > h3', '#stats .st-chart h4', '#stats .st-tile-label', '#stats .st-tile-value',
      '#stats .st-tile-sub', '#stats .st-body p', '#stats .st-table th', '#stats .st-table td', '#stats .st-warn-text', '#stats .st-legend'].join(', ');
    const colours = await coloursOf(fx.page, selector);
    assert.ok(colours.length > 10);
    for (const { color, background } of colours) {
      const ratio = contrast(color, background);
      assert.ok(ratio >= 4.5, `${color} on ${background} is ${ratio.toFixed(2)}:1`);
    }
  });
}
