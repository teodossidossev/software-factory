// The Coordinator card in a real browser, with a long status as the coordinator writes it (a first
// paragraph naming a job, then a list of six items) and the chat's link: at 1280 px on the Home its
// title and box line up with Needs you's heading and first card, the footer's age and Open the chat
// share a row with the button at the right, Enter on the focused Show all opens and closes the
// status and keeps the focus; collapsed above the board's columns the card stays short; at 360 and
// 390 px neither view scrolls sideways and the footer keeps its row.
import assert from 'node:assert/strict';
import { setLink, setStatus } from '../../src/coordinator.js';
import { browserTest, type Fixture, JOBS } from './support.js';

const ITEMS = [
  'SF-T1 queued: the importer reads the new CSV header and keeps the old one working; its Task check is ready and it starts when a slot frees up. '
    + 'It touches the parser and its tests only, so it can run beside the others without a conflict on the same files.',
  'SF-T2 queued after SF-T1: the export button on the report page, with the date range the user picked kept in the file name. '
    + 'It waits for the importer because both change the shared date helpers, and a rebase in the middle would cost a turn.',
  'SF-W1 implementing, iteration 2: the Implementer answers the review\'s three findings about the retry loop and the missing timeout. '
    + 'The first iteration passed the tests but slept without a bound; this one adds the bound and a test that proves it.',
  'SF-R1 in review: Claude reads the change to the settings page; the Codex gate follows when the review is clean. '
    + 'The change is small, two files and a test, so I expect the review to pass on the first round and the gate within the hour.',
  'SF-M1 ready for your review: the branch is prepared, the merge request text is written, nothing else waits on it. '
    + 'Open it from Your turn when you have ten minutes; the diff is the new empty state of the search page and its screenshot test.',
  'SF-T9 pushed and merged yesterday; I keep it here until the deploy of this evening shows the new login form to everyone. '
    + 'After the deploy I check the error rate on the login page once, then take it off this list and archive the job.',
];
const STATUS = `Waiting for you on ${JOBS.gate}: Codex found two problems in the importer and the job stops until you decide.\nThe rest runs on its own.\n\n${ITEMS.map((item) => `- ${item}`).join('\n')}`;

// The box of the first element the selector matches.
async function box(fx: Fixture, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await fx.page.locator(selector).first().boundingBox();
  assert.ok(found !== null, `${selector} has a box`);
  return found;
}

// The document and the card when they scroll sideways: [] when neither does.
const sideScroll = (fx: Fixture): Promise<string[]> => fx.page.evaluate(() => [document.documentElement, document.getElementById('coord')!]
  .flatMap((node) => (node.scrollWidth > node.clientWidth ? [`${node.id || 'document'}: ${node.scrollWidth} > ${node.clientWidth}`] : [])));

// The footer's age and Open the chat on one row (their vertical centres within 2 px), the age at
// the footer's left edge and the button at its right edge (the box's content edges).
async function footerRow(fx: Fixture): Promise<void> {
  const [foot, age, chat] = [await box(fx, '#coord .coord-foot'), await box(fx, '#coord .coord-foot .coord-age'), await box(fx, '#coord .coord-chat')];
  assert.ok(Math.abs((age.y + age.height / 2) - (chat.y + chat.height / 2)) <= 2, `age ${JSON.stringify(age)}, chat ${JSON.stringify(chat)}`);
  assert.ok(Math.abs(age.x - foot.x) <= 2 && Math.abs((chat.x + chat.width) - (foot.x + foot.width)) <= 2, `age ${JSON.stringify(age)} and chat ${JSON.stringify(chat)} at the ends of ${JSON.stringify(foot)}`);
}

// The coordinator's long status and the chat's link, written before the page opens.
async function report(fx: Fixture): Promise<void> {
  assert.ok(STATUS.length >= 1500 && STATUS.length <= 2000, `${STATUS.length} characters`);
  await setStatus(fx.state, STATUS);
  await setLink(fx.state, 'https://claude.ai/chat/abc');
}

browserTest('coordinator: at 1280 px on the Home the card\'s title and box line up with Needs you\'s, the footer is one row with Open the chat at the right, Enter opens and closes the status; collapsed above the columns the card stays short', async (fx) => {
  await fx.page.setViewportSize({ width: 1280, height: 900 });
  await report(fx);
  await fx.open('home');
  const more = fx.page.locator('#coord .coord-more');
  await more.waitFor();
  await fx.page.locator('#home-needs-list > li.card').first().waitFor();
  const [title, heading, coordBox, first] = [await box(fx, '#coord .coord-title'), await box(fx, '#home-needs-title'), await box(fx, '#coord .coord-box'), await box(fx, '#home-needs-list > li')];
  assert.ok(Math.abs(title.y - heading.y) <= 1, `title ${JSON.stringify(title)}, heading ${JSON.stringify(heading)}`);
  assert.ok(Math.abs(coordBox.y - first.y) <= 1, `box ${JSON.stringify(coordBox)}, first card ${JSON.stringify(first)}`);
  assert.ok(Math.abs(title.x - coordBox.x) <= 1, `title ${JSON.stringify(title)} on the box's left edge ${JSON.stringify(coordBox)}`);
  await footerRow(fx);
  // The ticket key links to its job with the title beside it.
  assert.equal(await fx.page.locator('#coord-text a.coord-tk').first().getAttribute('href'), `#app/${JOBS.gate}`);

  // Enter on the focused toggle opens and closes the status; the focus stays on the toggle.
  await more.focus();
  await fx.page.keyboard.press('Enter');
  assert.deepEqual([await more.getAttribute('aria-expanded'), await more.textContent(), await fx.page.locator('#coord-text li').count()], ['true', 'Show less', ITEMS.length]);
  assert.equal(await fx.page.evaluate(() => document.activeElement?.classList.contains('coord-more')), true);
  await fx.page.keyboard.press('Enter');
  assert.deepEqual([await more.getAttribute('aria-expanded'), await fx.page.locator('#coord-text li').count()], ['false', 0]);
  assert.equal(await fx.page.evaluate(() => document.activeElement?.classList.contains('coord-more')), true);

  // Collapsed above the board's columns: short, the footer one row.
  await fx.page.locator('#open-board').click();
  await fx.page.locator('#board #coord').waitFor();
  const card = await box(fx, '#coord');
  assert.ok(card.height <= 220, `the card is ${card.height} px high`);
  assert.ok(card.y + card.height <= (await box(fx, '#cols')).y, 'the card stands above the columns');
  await footerRow(fx);
  assert.deepEqual(fx.problems, []);
});

for (const [width, height] of [[360, 800], [390, 844]] as const) {
  browserTest(`coordinator: at ${width} px neither the Home nor the board scrolls sideways with the card, open or not, and its footer keeps its row`, async (fx) => {
    await fx.page.setViewportSize({ width, height });
    await report(fx);
    await fx.open('home');
    const more = fx.page.locator('#coord .coord-more');
    await more.waitFor();
    for (const view of ['home', 'board'] as const) {
      if (view === 'board') {
        await fx.page.locator('#page-select').selectOption('board');
        await fx.page.locator('#board #coord').waitFor();
      }
      assert.deepEqual(await sideScroll(fx), [], `${view}, collapsed`);
      await footerRow(fx);
      await more.click();
      assert.equal(await more.getAttribute('aria-expanded'), 'true');
      assert.deepEqual(await sideScroll(fx), [], `${view}, open`);
      await footerRow(fx);
      await more.click();
      assert.equal(await more.getAttribute('aria-expanded'), 'false');
    }
    assert.deepEqual(fx.problems, []);
  });
}
