// The dashboard's layout in a real browser (SF-091): the light and dark colour schemes with their
// contrast (WCAG relative luminance), a narrow phone-sized window, and the job page's Stream at
// 600, 1200 and 2000 px (SF-113).
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { EventRecord } from '../../src/jobs.js';
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

// SF-113: the job page's Stream at three widths, with an Implementer call whose failed result makes
// its line about 250 characters long and a Codex gate command of about 130. The Stream spans its
// scroller, the lines are as wide as their rows (cut with an ellipsis where they do not fit), the
// opened calls' Input and Output wrap inside their rows, and neither the document, #job nor
// #streamwrap (the scroller, which the document's check alone does not see) scrolls sideways.
const command = `/bin/bash -lc "sed -n '1,400p' ${'factory/src/'.repeat(30)}x.ts"`;
const bashCommand = `sed -n '1,400p' ${'src/very/long/path/'.repeat(20)}file.ts`;
const bashResult = `${'x'.repeat(300)}\n${'y'.repeat(3000)}`;
const codexOutput = 'z'.repeat(5000);
// The start of each line, as the Stream shows it.
const IMPLEMENTER_LINE = 'Bash sed -n';
const CODEX_LINE = '$ /bin/bash -lc';
const longRecords: EventRecord[] = [
  { ts: '2026-11-01T10:19:00.000Z', iteration: 1, message: { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: bashCommand } }] } } },
  { ts: '2026-11-01T10:19:01.000Z', iteration: 1, message: { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_long', content: bashResult, is_error: true }] } } },
  { ts: '2026-11-01T10:19:02.000Z', iteration: 1, type: 'gate_event', reviewer: 'codex',
    event: { type: 'item.started', item: { id: 'item_long', type: 'command_execution', command, status: 'in_progress' } } },
  { ts: '2026-11-01T10:19:03.000Z', iteration: 1, type: 'gate_event', reviewer: 'codex',
    event: { type: 'item.completed', item: { id: 'item_long', type: 'command_execution', command, exit_code: 0, aggregated_output: codexOutput, status: 'completed' } } },
];

for (const width of [600, 1200, 2000] as const) {
  browserTest(`stream width (SF-113): at ${width} x 900 the Stream spans the page, a long tool row ends in an ellipsis inside its row, a long output wraps, and nothing scrolls sideways`, async (fx) => {
    for (const record of longRecords) {
      await fx.jobs.appendEvent(WS, JOBS.reviewing, record);
    }
    await fx.page.setViewportSize({ width, height: 900 });
    await fx.open(`${WS}/${JOBS.reviewing}`);
    const rows = fx.page.locator('#stream li.e-tool');
    const implementer = rows.filter({ has: fx.page.locator('.line', { hasText: IMPLEMENTER_LINE }) });
    const codex = rows.filter({ has: fx.page.locator('.line', { hasText: CODEX_LINE }) });
    await eventually(() => Promise.all([implementer.count(), codex.count()]), [1, 1]);
    await implementer.locator('.line').click();
    await codex.locator('.line').click();
    await eventually(() => Promise.all([implementer.locator('.more pre').count(), codex.locator('.more pre').count()]), [2, 2]);
    // A cut line still opens to its full Input and Output.
    const [implementerInput, implementerOutput] = await implementer.locator('.more pre').allTextContents();
    const [codexInput, codexOutputShown] = await codex.locator('.more pre').allTextContents();
    assert.ok(implementerInput!.includes(bashCommand), 'the Implementer call\'s Input holds its whole command');
    assert.equal(implementerOutput, bashResult);
    assert.ok(codexInput!.includes(JSON.stringify(command)), 'the Codex call\'s Input holds its whole command');
    assert.equal(codexOutputShown, codexOutput);

    const measured = await fx.page.evaluate(({ implementerText, codexText }) => {
      const wrap = document.getElementById('streamwrap')!;
      const stream = document.getElementById('stream')!;
      const wrapStyle = getComputedStyle(wrap);
      const padLeft = parseFloat(wrapStyle.paddingLeft);
      const padRight = parseFloat(wrapStyle.paddingRight);
      const lineOf = (text: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('#stream li.e-tool .line')]
        .find((line) => (line.textContent ?? '').includes(text))!;
      const measureLine = (node: HTMLElement) => {
        const body = node.closest('.body')!.getBoundingClientRect();
        const box = node.getBoundingClientRect();
        return {
          textOverflow: getComputedStyle(node).textOverflow,
          width: box.width,
          bodyWidth: body.width,
          right: box.right,
          bodyRight: body.right,
          cut: node.scrollWidth > node.clientWidth,
          title: node.title,
        };
      };
      const box = stream.getBoundingClientRect();
      return {
        innerWidth,
        documentScroll: document.documentElement.scrollWidth,
        overflowing: [document.documentElement, document.getElementById('job')!, wrap]
          .filter((node) => node.scrollWidth > node.clientWidth)
          .map((node) => `${node.id || node.nodeName}: ${node.scrollWidth} > ${node.clientWidth}`),
        stream: { left: box.left, width: box.width, expectedLeft: wrap.getBoundingClientRect().left + padLeft, expectedWidth: wrap.clientWidth - padLeft - padRight },
        implementer: measureLine(lineOf(implementerText)),
        codex: measureLine(lineOf(codexText)),
        pres: [...document.querySelectorAll<HTMLElement>('#stream li.e-tool .more pre')].map((pre) => ({
          right: pre.getBoundingClientRect().right,
          bodyRight: pre.closest('.body')!.getBoundingClientRect().right,
          scrollWidth: pre.scrollWidth,
          clientWidth: pre.clientWidth,
        })),
      };
    }, { implementerText: IMPLEMENTER_LINE, codexText: CODEX_LINE });

    // No sideways scroll: the document, #job and the Stream's scroller.
    assert.ok(measured.documentScroll <= measured.innerWidth, `document scrollWidth ${measured.documentScroll} > innerWidth ${measured.innerWidth}`);
    assert.deepEqual(measured.overflowing, []);

    // The Stream spans its scroller, less the scroller's side padding.
    const { stream } = measured;
    assert.ok(Math.abs(stream.left - stream.expectedLeft) <= 1, `#stream left ${stream.left}, expected ${stream.expectedLeft}`);
    assert.ok(Math.abs(stream.width - stream.expectedWidth) <= 1, `#stream width ${stream.width}, expected ${stream.expectedWidth}`);
    // 16 px of padding on each side and up to 20 px of vertical scrollbar: far wider than the old
    // 1180 px column at 2000 px.
    assert.ok(stream.width >= measured.innerWidth - 52, `#stream width ${stream.width} < ${measured.innerWidth - 52}`);

    // Each line is as wide as its row and ends inside it.
    for (const [who, line] of [['implementer', measured.implementer], ['codex', measured.codex]] as const) {
      assert.equal(line.textOverflow, 'ellipsis', `${who} text-overflow`);
      assert.ok(Math.abs(line.width - line.bodyWidth) <= 1, `${who} line width ${line.width}, row ${line.bodyWidth}`);
      assert.ok(line.right <= line.bodyRight + 0.5, `${who} line right ${line.right} > row right ${line.bodyRight}`);
    }

    // The lines certainly longer than their rows are cut.
    if (width === 600) {
      assert.ok(measured.implementer.cut, 'the Implementer line is cut at 600 px');
      assert.ok(measured.codex.cut, 'the Codex line is cut at 600 px');
    } else if (width === 1200) {
      assert.ok(measured.implementer.cut, 'the Implementer line is cut at 1200 px');
    }

    // The full line is kept in the title.
    assert.ok(measured.implementer.title.startsWith(IMPLEMENTER_LINE), measured.implementer.title);
    assert.ok(measured.implementer.title.includes('→ failed: '), measured.implementer.title);
    assert.ok(measured.codex.title.startsWith(CODEX_LINE), measured.codex.title);
    assert.ok(measured.codex.title.includes('→ exit 0'), measured.codex.title);

    // The opened calls' Input and Output wrap inside their rows.
    assert.equal(measured.pres.length, 4);
    for (const [index, pre] of measured.pres.entries()) {
      assert.ok(pre.right <= pre.bodyRight + 0.5, `pre ${index} right ${pre.right} > row right ${pre.bodyRight}`);
      assert.ok(pre.scrollWidth <= pre.clientWidth, `pre ${index} scrollWidth ${pre.scrollWidth} > clientWidth ${pre.clientWidth}`);
    }
  });
}
