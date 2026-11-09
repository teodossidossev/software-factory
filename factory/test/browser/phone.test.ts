// The dashboard on a phone and a tablet in a real browser (SF-119): no screen scrolls sideways at
// 360, 390 and 768 px; the board as one list with folding headings, two columns at 768 px; the top
// bar's 44 px controls and the factory pill's popover inside the screen, its rows at 1100 px and
// below, nothing sideways at 420 px; the composer's full-width box, its 44 px
// buttons and the reasons line; the Stream rows' time above the text; Changes unified with its
// folding tree; a tap showing a hover detail in the toast; the viewport meta; the hand-over panel.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { explanationPath } from '../../src/explain.js';
import { browserTest, eventually, type Fixture, JOBS, MR_TITLE, PLANNED, WS } from './support.js';

// The document and each element the selectors match that scrolls sideways, and each selector that
// matches nothing: [] when nothing does.
const sideScroll = (fx: Fixture, selectors: string[]): Promise<string[]> => fx.page.evaluate((list) => {
  const wide = (what: string, node: Element): string[] => (node.scrollWidth > node.clientWidth ? [`${what}: ${node.scrollWidth} > ${node.clientWidth}`] : []);
  return [...wide('document', document.documentElement), ...list.flatMap((selector) => {
    const nodes = [...document.querySelectorAll(selector)];
    return nodes.length === 0 ? [`${selector}: missing`] : nodes.flatMap((node) => wide(selector, node));
  })];
}, selectors);

// The box of the first element the selector matches.
async function box(fx: Fixture, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await fx.page.locator(selector).first().boundingBox();
  assert.ok(found !== null, `${selector} has a box`);
  return found;
}

for (const width of [360, 390, 768] as const) {
  browserTest(`phone (SF-119): at ${width} px the board, a stopped job's Stream with its explanation, Changes, Merge request and a planned ticket's page do not scroll sideways`, async (fx) => {
    await fx.page.setViewportSize({ width, height: width === 768 ? 1024 : 800 });
    const gate = (await fx.jobs.read(WS, JOBS.gate))!;
    const record = {
      stop: { at: gate.updated_at, code: 'gate_rounds' }, model: 'sonnet', language: 'English', started_at: gate.updated_at, ended_at: gate.updated_at, cost_usd: 0.01, error: null,
      output: {
        headline: 'Codex keeps asking for fixes: decide the two findings.', explanation: 'The Implementer fixed the change twice and Codex still found two problems.',
        choices: [
          { choice: 'Accept and prepare the MR', effect: 'The two findings go with the MR as known risks.', recommended: true },
          { choice: 'Send a message', effect: 'The Implementer works on your words.', recommended: false },
        ],
        recommendation: 'Accept: both findings are small.',
      },
    };
    await writeFile(explanationPath(fx.jobs, WS, JOBS.gate), JSON.stringify(record));

    await fx.open('');
    await fx.page.locator('#cols .card').first().waitFor();
    assert.deepEqual(await sideScroll(fx, ['#board', '.topbar', '#cols', '#cols .col']), []);

    await fx.open(`${WS}/${JOBS.gate}`);
    await fx.page.locator('#stopblock .explain').waitFor();
    assert.deepEqual(await sideScroll(fx, ['#job', '#jhead', '#streamwrap', '#stream', '#stopblock', '#stopblock .explain', '#composer']), []);

    await fx.open(`${WS}/${JOBS.ready}/changes`);
    await eventually(() => fx.page.locator('#tlist .trow').count(), 3);
    assert.deepEqual(await sideScroll(fx, ['#job', '#jhead', '#scrChanges', '#scrChanges .tree', '#tlist', '#dtool', '#dbody']), []);

    await fx.open(`${WS}/${JOBS.ready}/mr`);
    await eventually(() => fx.page.locator('#mrTitle').inputValue(), MR_TITLE);
    assert.deepEqual(await sideScroll(fx, ['#job', '#jhead', '#scrMr .form2', '#scrMr .mrbar']), []);

    await fx.open(`${WS}/${PLANNED.unqueued}/ticket`);
    await fx.page.locator('#ticket .card2').filter({ has: fx.page.locator('h3', { hasText: 'Task file' }) }).getByRole('tab', { name: 'Edit' }).waitFor();
    assert.deepEqual(await sideScroll(fx, ['#ticket', '#ticket .jhead', '#ticket .form2']), []);
  });
}

browserTest('phone (SF-119): at 390 px the board is one list (Your turn, Implementing, Reviewing, Queue, Done), a heading folds its column and the fold survives a reload; at 768 px two columns', async (fx) => {
  await fx.page.setViewportSize({ width: 390, height: 800 });
  await fx.open('');
  await fx.page.locator('#cols .card').first().waitFor();
  const columns = await fx.page.locator('#cols > .col').evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { name: node.classList[1]!, top: rect.top, left: rect.left };
  }));
  const sorted = [...columns].sort((a, b) => a.top - b.top);
  assert.deepEqual(sorted.map((column) => column.name), ['you', 'impl', 'rev', 'queue', 'done']);
  assert.ok(sorted.every((column) => Math.abs(column.left - sorted[0]!.left) <= 1), JSON.stringify(sorted));

  const fold = fx.page.locator('[data-colfold="done"]');
  await fold.click();
  assert.equal(await fold.getAttribute('aria-expanded'), 'false');
  assert.equal(await fx.page.locator('#list-done').isVisible(), false);
  await fx.page.reload();
  await fx.page.waitForFunction(() => document.getElementById('health-light')?.dataset.stream === 'live');
  assert.equal(await fold.getAttribute('aria-expanded'), 'false');
  assert.equal(await fx.page.locator('#list-done').isVisible(), false);
  await fold.click();
  assert.equal(await fx.page.locator('#list-done').isVisible(), true);

  await fx.page.setViewportSize({ width: 768, height: 1024 });
  await eventually(async () => {
    const [you, impl] = await Promise.all([box(fx, '#cols > .col.you'), box(fx, '#cols > .col.impl')]);
    return Math.abs(you.y - impl.y) <= 1 && impl.x >= you.x + you.width;
  }, true);
});

browserTest('phone (SF-119, SF-160): at 390 px every top-bar button and select is inside the screen and at least 44 px high; the pill\'s popover opens inside the screen with the stepper\'s buttons 44 x 44', async (fx) => {
  await fx.page.setViewportSize({ width: 390, height: 800 });
  await fx.open('');
  await fx.page.locator('#cols .card').first().waitFor();
  await fx.page.locator('#workspace-filter').waitFor();
  const controls = await fx.page.locator('.topbar button, .topbar select').evaluateAll((nodes) => nodes
    .filter((node) => (node as HTMLElement).offsetParent !== null)
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return { text: (node as HTMLElement).id || (node as HTMLElement).innerText.trim(), x: rect.x, right: rect.x + rect.width, height: rect.height };
    }));
  assert.deepEqual(controls.map((control) => control.text).sort(), ['health-light', 'open-new-ticket', 'page-select', 'waits', 'workspace-filter'], JSON.stringify(controls));
  const off = controls.filter((control) => control.x < 0 || control.right > 390 || control.height < 44);
  assert.deepEqual(off, []);
  await fx.page.locator('#health-light').click();
  await fx.page.locator('#qctl').waitFor();
  for (const id of ['#limDown', '#limUp']) {
    const stepper = await box(fx, id);
    assert.ok(stepper.width >= 44 && stepper.height >= 44, `${id}: ${JSON.stringify(stepper)}`);
  }
  const panel = await box(fx, '#health-panel');
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 390, JSON.stringify(panel));
  await fx.page.keyboard.press('Escape');
  assert.equal(await fx.page.locator('#health-panel').isVisible(), false);
});

browserTest('top bar (SF-160): one 48 px row with the tabs from 1100 px; below, a second row with the page and workspace selects half the width each; at 420 px nothing scrolls sideways and below it the name keeps its icon only', async (fx) => {
  await fx.page.setViewportSize({ width: 1100, height: 800 });
  await fx.open('');
  await fx.page.locator('#cols .card').first().waitFor();
  await fx.page.locator('#workspace-filter').waitFor();
  const bar = await box(fx, '.topbar');
  assert.ok(bar.height <= 49, `top bar ${bar.height} px high`);
  // A long workspace name and the pill's longest words keep the one row: they shrink.
  await fx.page.evaluate(() => {
    const option = document.createElement('option');
    option.textContent = 'a-workspace-with-a-very-long-name-that-goes-on-and-on-and-on (12)';
    document.getElementById('workspace-filter')!.append(option);
    document.getElementById('health-words')!.textContent = 'sf serve does not answer';
  });
  assert.ok((await box(fx, '.topbar')).height <= 49, `top bar ${(await box(fx, '.topbar')).height} px high with long names`);
  assert.deepEqual(await sideScroll(fx, ['.topbar']), []);
  assert.deepEqual([await fx.page.locator('.topbar .tabs').isVisible(), await fx.page.locator('#page-select').isVisible()], [true, false]);
  await fx.page.setViewportSize({ width: 1099, height: 800 });
  await eventually(() => fx.page.locator('#page-select').isVisible(), true);
  assert.equal(await fx.page.locator('.topbar .tabs').isVisible(), false);
  const [pages, filter] = await Promise.all([box(fx, '#page-select'), box(fx, '#workspace-filter')]);
  assert.ok(Math.abs(pages.y - filter.y) <= 1 && Math.abs(pages.width - filter.width) <= 1 && pages.y > bar.y + 30, JSON.stringify([pages, filter]));
  await fx.page.setViewportSize({ width: 420, height: 800 });
  await eventually(() => sideScroll(fx, ['.topbar']), []);
  assert.equal(await fx.page.locator('.topbar .bname').isVisible(), true);
  await fx.page.locator('#health-light').click();
  await fx.page.locator('#health-panel').waitFor();
  assert.deepEqual(await sideScroll(fx, ['.topbar', '#health-panel']), []);
  await fx.page.setViewportSize({ width: 400, height: 800 });
  await eventually(() => fx.page.locator('.topbar .bname').isVisible(), false);
  assert.equal(await fx.page.locator('.topbar .brand img').isVisible(), true);
});

browserTest('phone (SF-119): at 390 px the composer\'s box is full width with the buttons under it, primary first, each at least 44 x 44; an open confirmation\'s buttons too; the reasons line shows what is off', async (fx) => {
  await fx.page.setViewportSize({ width: 390, height: 844 });
  await fx.open(`${WS}/${JOBS.working}`);
  await eventually(() => fx.page.locator('#msg').isEnabled(), true);
  const [msg, crow] = await Promise.all([box(fx, '#msg'), box(fx, '#composer .crow')]);
  assert.ok(Math.abs(msg.width - crow.width) <= 1, `${msg.width} and ${crow.width}`);
  const acts = await fx.page.locator('#acts .btn').evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { text: (node as HTMLElement).innerText.trim(), primary: node.classList.contains('primary'), top: rect.top, width: rect.width, height: rect.height };
  }));
  assert.ok(acts.length >= 2, JSON.stringify(acts));
  assert.deepEqual(acts.filter((act) => act.height < 44 || act.width < 44 || act.top < msg.y + msg.height), []);
  assert.deepEqual([acts[0]!.primary, acts[0]!.text], [true, 'Send']);

  await fx.page.getByRole('button', { name: 'Abort…' }).click();
  await fx.page.locator('#confirm').waitFor();
  for (const id of ['#confirm-ok', '#confirm-cancel']) {
    const button = await box(fx, id);
    assert.ok(button.height >= 44, `${id}: ${JSON.stringify(button)}`);
  }
  assert.equal(await fx.page.locator('#acts-why').isVisible(), true);
  assert.equal(await fx.page.locator('#acts-why').innerText(), 'Off: Pause, Abort… (a confirmation is open: confirm or cancel it first.)');

  // A wide window: the reasons line only on a device without hover.
  await fx.page.setViewportSize({ width: 1200, height: 900 });
  const noHover = await fx.page.evaluate(() => matchMedia('(hover: none)').matches);
  await eventually(() => fx.page.locator('#acts-why').isVisible(), noHover);
});

browserTest('phone (SF-119): at 390 px a Stream row\'s time and actor are above its text; at 1400 px beside it', async (fx) => {
  await fx.page.setViewportSize({ width: 390, height: 844 });
  await fx.open(`${WS}/${JOBS.working}`);
  // The Bash row continues the Implementer's turn (its actor is .who.cont, hidden on a phone, rule
  // 14); the turn's first row, the text, shows the actor beside the time.
  const tool = fx.page.locator('#stream li.e-tool').filter({ hasText: 'npm test' }).first();
  const text = fx.page.locator('#stream li.e-text').filter({ hasText: 'Reading the Task file first.' }).first();
  await tool.waitFor();
  const boxOf = async (row: typeof tool, part: string) => {
    const found = await row.locator(part).boundingBox();
    assert.ok(found !== null, `${part} has a box`);
    return found;
  };
  const [ts, body] = await Promise.all([boxOf(tool, '.ts'), boxOf(tool, '.body')]);
  assert.ok(ts.y + ts.height <= body.y + 0.5, JSON.stringify({ ts, body }));
  assert.ok(Math.abs(ts.x - body.x) <= 1, JSON.stringify({ ts, body }));
  assert.deepEqual([await tool.locator('.who').getAttribute('class'), await tool.locator('.who').isVisible()], ['who cont', false]);
  const [textTs, textWho, textBody] = await Promise.all([boxOf(text, '.ts'), boxOf(text, '.who'), boxOf(text, '.body')]);
  assert.ok(Math.abs(textTs.y - textWho.y) <= 1, JSON.stringify({ textTs, textWho }));
  assert.ok(textTs.y + textTs.height <= textBody.y + 0.5, JSON.stringify({ textTs, textBody }));

  await fx.page.setViewportSize({ width: 1400, height: 900 });
  await eventually(async () => {
    const [wideTs, wideBody] = await Promise.all([boxOf(tool, '.ts'), boxOf(tool, '.body')]);
    return Math.abs(wideTs.y - wideBody.y) <= 1 && wideBody.x > wideTs.x + wideTs.width;
  }, true);
});

browserTest('phone (SF-119): Changes is unified below 768 px with no layout switch, its tree folds above the diff, and side by side comes back at 768 px', async (fx) => {
  await fx.open(`${WS}/${JOBS.ready}/changes`);
  await eventually(() => fx.page.locator('#tlist .trow').count(), 3);
  await eventually(() => fx.page.locator('#dbody .dfile').getAttribute('class'), 'dfile');
  assert.equal(await fx.page.locator('#dtool [data-mode]').count(), 2);
  assert.equal(await fx.page.locator('#cxtree').isVisible(), false);

  await fx.page.setViewportSize({ width: 390, height: 844 });
  await eventually(() => fx.page.locator('#dbody .dfile').getAttribute('class'), 'dfile uni');
  assert.equal(await fx.page.locator('#dtool [data-mode]').count(), 0);
  assert.equal(await fx.page.evaluate(() => localStorage.getItem('sf-diff-mode')), null);
  const fold = fx.page.locator('#cxtree');
  assert.equal(await fold.isVisible(), true);
  assert.equal(await fold.getAttribute('aria-expanded'), 'true');
  await fx.page.locator('#tlist .trow').filter({ hasText: 'a.ts' }).click();
  await eventually(() => fold.getAttribute('aria-expanded'), 'false');
  assert.equal(await fx.page.locator('#tlist').isVisible(), false);
  assert.equal(await fx.page.locator('#dtool .dpath').innerText(), 'src/a.ts');
  assert.equal(await fx.page.evaluate(() => document.activeElement?.id ?? ''), 'dbody');
  await fold.click();
  assert.equal(await fx.page.locator('#tlist').isVisible(), true);

  await fx.page.setViewportSize({ width: 768, height: 1024 });
  await eventually(() => fx.page.locator('#dbody .dfile').getAttribute('class'), 'dfile');
  assert.equal(await fx.page.locator('#dtool [data-mode]').count(), 2);
});

browserTest('phone (SF-119): at 390 px a tap on the job header\'s workspace chip shows "Workspace app" in the toast; Escape closes it and the page stays', async (fx) => {
  await fx.page.setViewportSize({ width: 390, height: 844 });
  await fx.open(`${WS}/${JOBS.working}`);
  await fx.page.locator('#jhead .t1 .wschip').click();
  await eventually(() => fx.page.locator('#toast-text').innerText(), 'Workspace app');
  await fx.page.keyboard.press('Escape');
  await eventually(() => fx.page.locator('#toast').isHidden(), true);
  assert.equal(await fx.page.locator('#job').isVisible(), true);
  // The Merge request tab without MR text: its tap says why and the Stream stays.
  // Playwright does not click an aria-disabled element; a finger's tap is not held by it.
  await fx.page.locator('#jhead [data-goto="mr"]').click({ force: true });
  await eventually(() => fx.page.locator('#toast-text').innerText(), 'No MR text yet: written at Clean');
  assert.equal(await fx.page.locator('#scrStream').isVisible(), true);
});

browserTest('phone (SF-119): the viewport meta lets the page use the whole screen', async (fx) => {
  await fx.open('');
  assert.equal(await fx.page.locator('meta[name="viewport"]').getAttribute('content'), 'width=device-width, initial-scale=1, viewport-fit=cover');
});

for (const width of [360, 390] as const) {
  browserTest(`phone (SF-119): at ${width} px the hand-over panel fits the screen with 44 px buttons`, async (fx) => {
    // The handed-over job as SF-107's test in job-page.test.ts creates it.
    const ticket = 'SF-H1';
    const ready = (await fx.jobs.read(WS, JOBS.ready))!;
    const commit = 'a'.repeat(40);
    await fx.jobs.write({
      ...ready, ticket, branch: `${ticket}-work`, state: 'handed_over', prepared_commit: commit, worktree: null, session_id: `session-${ticket}`,
      handover: {
        branch: `${ticket}-work`, saved: commit, base: 'b'.repeat(40), previous: { branch: 'main' }, untracked: [], template: null, cleanup: null,
        at: '2026-11-01T10:40:00.000Z', checked_at: null, step: null,
      },
    });
    fx.actions.mrHost = { host: 'github', reason: null } as typeof fx.actions.mrHost;
    await fx.page.setViewportSize({ width, height: 800 });
    await fx.open(`${WS}/${ticket}`);
    await eventually(() => fx.page.locator('#handover-panel .ho-path').count(), 2);
    const low = await fx.page.locator('#handover-panel .btn').evaluateAll((nodes) => nodes
      .filter((node) => (node as HTMLElement).offsetParent !== null)
      .map((node) => ({ text: (node as HTMLElement).innerText.trim(), height: node.getBoundingClientRect().height }))
      .filter((button) => button.height < 44));
    assert.deepEqual(low, []);
    assert.deepEqual(await sideScroll(fx, ['#job', '#jhead', '#composer', '#handover-panel']), []);
  });
}
