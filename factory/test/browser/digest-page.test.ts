// The Digest page in a real browser (SF-103) over stored records: the empty state and Generate now
// (polled until the new digest appears), the Repositories tab (one ticket across the app, a card per
// followed workspace: the headline, the effect on my work, what landed with the earlier entries
// folded, the live branches), the Brief tab (the default: its sections in order, one line per item,
// Copy for the stand-up), a digest whose model call failed, the earlier digests, and phone width.
import assert from 'node:assert/strict';
import type { DigestRecord, DigestWorkspace } from '../../src/digest-run.js';
import type { LandedEntry, LiveBranch } from '../../src/digest.js';
import { browserTest, eventually, type Fixture } from './support.js';

const TO = '2026-11-06T07:00:00.000Z';
const hoursBefore = (hours: number): string => new Date(Date.parse(TO) - hours * 3_600_000).toISOString();

function landed(sha: string, hours: number, extra: Partial<LandedEntry> = {}): LandedEntry {
  return {
    sha, full_sha: `${sha}${'0'.repeat(30)}`, author: 'Colleague', mine: false, date: hoursBefore(hours), subject: `SHOP-7: Change ${sha}`, merge: false, ticket: 'SHOP-7',
    why: 'Because.', files: ['src/orders.ts'], files_total: 1, dirs: ['src'], stat: '1 file changed, 2 insertions(+)', ...extra,
  };
}

function branch(name: string, extra: Partial<LiveBranch> = {}): LiveBranch {
  return { name, local: false, author: 'Colleague', mine: false, date: hoursBefore(5), age_days: 0, ahead: 2, behind: 1, local_only: 0, subject: `Work on ${name}`, ticket: null, landed: false, earlier_merge: false, ...extra };
}

function workspace(name: string, app: string, git: DigestWorkspace['git'], extra: Partial<DigestWorkspace> = {}): DigestWorkspace {
  return {
    name, app, description: null, description_source: null, track: true, my_work: false,
    fetch: { status: 'ok', message: null, last_fetch_ok_at: TO, notes: [] }, git, error: null, ...extra,
  };
}

function record(id: string, extra: Partial<DigestRecord> = {}): DigestRecord {
  const api = workspace('api', 'shop', {
    main: 'main', me: 'me@example.invalid',
    landed: [landed('a1b2c3d4e5', 2, { author: 'Me Myself', mine: true }), landed('f6a7b8c9d0', 40, { subject: 'SHOP-6: An older change', ticket: 'SHOP-6' })],
    branches: [
      branch('SHOP-8-mine', { mine: true, author: 'Me Myself', behind: 14, overlap: ['src/orders.ts'], hit_by: [{ sha: 'a1b2c3d4e5', files: ['src/orders.ts'] }], files: ['src/orders.ts'], ticket: 'SHOP-8' }),
      branch('SHOP-9-job', { mine: true, local: true, author: 'Me Myself', ticket: 'SHOP-9' }),
      branch('SHOP-2-done', { landed: true }),
    ],
    my_commits: [], notes: [],
  }, { my_work: true, description: 'The shop backend.', description_source: 'workspace' });
  const web = workspace('web', 'shop', { main: 'main', me: null, landed: [landed('0a0b0c0d0e', 3, { ticket: 'SHOP-7' })], branches: [], my_commits: [], notes: [] });
  const tools = workspace('tools', 'tools', null, { fetch: { status: 'skipped', message: 'mirror not created: could not read from the remote', last_fetch_ok_at: null, notes: [] } });
  return {
    id, trigger: 'scheduled', started_at: TO, ended_at: '2026-11-06T07:02:00.000Z', period: { from: '2026-11-05T07:00:00.000Z', to: TO },
    // Yesterday starts 24 hours before the digest: the day before it in any time zone.
    daily_days: { yesterday: { from: hoursBefore(24), to: hoursBefore(7) }, today: { from: hoursBefore(7), to: TO } },
    model: 'sonnet', language: 'English', workspaces: [api, web, tools],
    daily_sources: [{ app: 'shop', workspaces: ['api'], commits: [{ sha: 'a1b2c3d4e5', ref: 'SHOP-8-mine', date: hoursBefore(20), subject: 'SHOP-8: My orders', why: '', stat: '', workspace: 'api' }], jobs: [], open_branches: [] }],
    output: {
      repos: [
        { name: 'api', headline: e('The orders list landed; the work moves to payments.'), merged: [{ sha: 'a1b2c3d4e5', problem: e('The shop can list its orders.') }], branches: [{ ref: 'SHOP-8-mine', what: e('My orders work, behind main.') }], impact_on_me: [e('SHOP-8-mine shares src/orders.ts with a1b2c3d4e5: a rebase is due.')] },
        { name: 'web', headline: e('The orders page follows the API.'), merged: [{ sha: '0a0b0c0d0e', problem: e('The page shows the orders.') }], branches: [], impact_on_me: [] },
      ],
      cross_repo: [{ ticket: 'SHOP-7', by_workspace: { api: e('The list endpoint landed.'), web: e('The page landed.') }, for_me: e('Likely nothing to do.') }],
      dailies: [{ app: 'shop', workspaces: ['api'], yesterday: [e('Worked on the orders (SHOP-8).')], problems: [e('SHOP-8-mine is 14 commits behind main.')], plan: [e('Rebase SHOP-8-mine on main.')], next: [e('Finish SHOP-8.')] }],
    },
    cost_usd: 0.31, error: null, notes: [], counts: { landed: 3, live_branches: 3, impact: 1 },
    in_progress: [{ workspace: 'api', app: 'shop', ticket: 'SHOP-9', title: 'The payment form', state: 'needs_human', stop_code: 'gate_failed', iteration: 2, since: hoursBefore(1) }],
    ...extra,
  };
}

// A model text of an English record: en repeats text.
function e(text: string): { text: string; en: string } {
  return { text, en: text };
}

const repositories = async (fx: Fixture): Promise<void> => fx.page.getByRole('tab', { name: 'Repositories' }).click();

const card = (fx: Fixture, name: string) => fx.page.locator(`#digest .dg-repo[data-ws="${name}"]`);

browserTest('digest page: no digest yet; Generate now posts once, polls every 10 s and opens the new digest', async (fx) => {
  await fx.page.clock.install();
  await fx.open('digest');
  await fx.page.getByText('No digest yet').waitFor();
  assert.equal(await fx.page.locator('#digest .jhead .title').innerText(), 'Morning digest');
  const request = fx.posted('api/digests/run');
  await fx.page.getByRole('button', { name: 'Generate now' }).click();
  assert.deepEqual((await request).postDataJSON(), {});
  await fx.page.getByRole('button', { name: 'Generating…' }).waitFor();
  assert.equal(await fx.page.getByRole('button', { name: 'Generating…' }).isDisabled(), true);
  assert.deepEqual(fx.digests.starts, ['manual']);
  // The run ends with its record; the next poll opens it.
  fx.digests.records.push(record('20261106T070000Z-manual', { trigger: 'manual' }));
  fx.digests.running = false;
  await fx.page.clock.runFor(10_000);
  await fx.page.locator('#digest .dg-brief').waitFor();
  assert.equal(new URL(fx.page.url()).hash, '#digest/20261106T070000Z-manual');
  await repositories(fx);
  await card(fx, 'api').waitFor();
  assert.deepEqual(fx.problems, []);
});

browserTest('digest page: Repositories: one ticket across the app, then a card per followed workspace', async (fx) => {
  fx.digests.records.push(record('20261106T070000Z-scheduled'));
  await fx.open();
  await fx.page.locator('#open-digest').click();
  await repositories(fx);
  await card(fx, 'api').waitFor();
  assert.equal(new URL(fx.page.url()).hash, '#digest');
  assert.match(await fx.page.locator('#digest .dg-period').innerText(), /^since 2026-11-0\d \d\d:\d\d · generated 2026-11-06 \d\d:\d\d$/);
  assert.equal(await fx.page.locator('#digest .dg-cost').innerText(), '$0.31');
  // One ticket across the app: Ticket | api | web | For me.
  const table = fx.page.locator('#digest table.dgx');
  assert.deepEqual(await table.locator('th').allInnerTexts(), ['Ticket', 'api', 'web', 'For me']);
  assert.deepEqual(await table.locator('tbody td').allInnerTexts(), ['SHOP-7', 'The list endpoint landed.', 'The page landed.', 'Likely nothing to do.']);
  // The followed workspaces, in order; the one without data says why.
  assert.deepEqual(await fx.page.locator('#digest .dg-repo .dg-name').allInnerTexts(), ['api', 'web', 'tools']);
  const api = card(fx, 'api');
  assert.equal(await api.locator('.dg-headline').innerText(), 'The orders list landed; the work moves to payments.');
  assert.equal(await api.locator('.dg-impact li').innerText(), 'SHOP-8-mine shares src/orders.ts with a1b2c3d4e5: a rebase is due.');
  assert.equal(await card(fx, 'web').locator('.dg-impact').count(), 0);
  // Landed on main: what it solves with the ticket, the subject small, mine marked; the earlier one folded.
  const entries = api.locator('.dg-sec').filter({ hasText: 'Landed on main' }).locator('.dg-landed').first().locator('li');
  assert.equal(await entries.count(), 1);
  assert.match(await entries.first().locator('.dg-what').innerText(), /SHOP-7\s*The shop can list its orders\./);
  assert.equal(await entries.first().locator('.dg-subject').innerText(), 'SHOP-7: Change a1b2c3d4e5');
  assert.equal(await entries.first().locator('.tag', { hasText: 'mine' }).count(), 1);
  const fold = api.locator('details.dg-fold');
  assert.equal(await fold.locator('summary').innerText(), 'Earlier in the period (1)');
  assert.equal(await fold.locator('li').isVisible(), false);
  await fold.locator('summary').click();
  assert.match(await fold.locator('li .dg-what').innerText(), /SHOP-6: An older change/);
  // Live branches: not the landed one; behind over 10 flagged; local marked; shared files for mine.
  const branches = api.locator('.dg-branches > li');
  assert.deepEqual(await branches.locator('.dg-ref').allInnerTexts(), ['SHOP-8-mine', 'SHOP-9-job']);
  assert.equal(await branches.first().locator('.dg-behind').innerText(), '−14');
  assert.equal(await branches.first().locator('.dg-overlap').innerText(), 'Shares with main: src/orders.ts');
  assert.equal(await branches.first().locator('.dg-what').innerText(), 'My orders work, behind main.');
  assert.equal(await branches.nth(1).locator('.tag', { hasText: 'local' }).count(), 1);
  assert.equal(await card(fx, 'tools').locator('.notline').innerText(), 'mirror not created: could not read from the remote');
  assert.deepEqual(fx.problems, []);
});

browserTest('digest page: the Brief (the default tab): its sections in order of one-line items, the schedule line, the commits folded, and Copy for the stand-up as plain text', async (fx) => {
  fx.digests.records.push(record('20261106T070000Z-scheduled'));
  await fx.page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(fx.url).origin });
  await fx.open('digest');
  const brief = fx.page.locator('#digest .dg-brief');
  await brief.waitFor();
  assert.deepEqual(await fx.page.locator('#digest [role="tab"]').allInnerTexts(), ['Brief', 'Repositories']);
  assert.equal(await fx.page.locator('#digest [role="tab"][aria-selected="true"]').innerText(), 'Brief');
  assert.equal(await fx.page.locator('#digest .dg-sched span').first().innerText(), 'Updates at 08:00 (weekdays)');
  // An English record: no language switch.
  assert.equal(await fx.page.locator('#digest .dg-lang').count(), 0);
  assert.deepEqual(await brief.locator('.dg-sec > h4').allInnerTexts(), ['Yesterday', 'In progress now', 'Today', 'Merged by colleagues', 'Waiting on me']);
  // Each item one line.
  for (const item of await brief.locator('.dg-lines > li').all()) {
    if (await item.isVisible()) {
      const box = (await item.boundingBox())!;
      assert.ok(box.height < 30, `${await item.innerText()}: ${box.height}px`);
    }
  }
  assert.match(await brief.locator('.dg-sec[data-sec="progress"] li').innerText(), /^SHOP-9\s+The payment form:\s*Waits for you\s*gate_failed\s*(\d\d:\d\d|\d{4}-\d\d-\d\d)$/);
  // Merged by colleagues: per workspace (two followed), mine left out, the older one folded.
  const merged = brief.locator('.dg-sec[data-sec="merged"]');
  assert.deepEqual(await merged.locator('.dg-group .dg-name').allInnerTexts(), ['api', 'web']);
  assert.equal(await merged.locator('summary').innerText(), 'Earlier in the period (1)');
  assert.equal(await merged.locator('li', { hasText: 'The shop can list its orders.' }).count(), 0);
  assert.match(await merged.locator('li', { hasText: 'The page shows the orders.' }).innerText(), /^SHOP-7\s*The page shows the orders\.\s*Colleague · (\d\d:\d\d|\d{4}-\d\d-\d\d)$/);
  const shop = fx.page.locator('#digest .dg-app[data-app="shop"]');
  assert.equal(await shop.locator('summary').innerText(), 'The commits it was made from (1)');
  await shop.getByRole('button', { name: 'Copy for the stand-up' }).click();
  await shop.getByText('Copied.').waitFor();
  assert.equal(await fx.page.evaluate(() => navigator.clipboard.readText()), [
    'Yesterday:', '- Worked on the orders (SHOP-8).',
    'In progress now:', '- SHOP-9 The payment form: Waits for you',
    'Today:', '- Finish SHOP-8.', '- Rebase SHOP-8-mine on main.',
    'Waiting on me:', '- SHOP-8-mine shares src/orders.ts with a1b2c3d4e5: a rebase is due.', '- SHOP-8-mine is 14 commits behind main.', '- SHOP-7: Likely nothing to do.',
  ].join('\n'));
  assert.deepEqual(fx.problems, []);
});

browserTest('digest page: a failed model call shows the Git data with a note; the Brief without the model\'s items; the earlier digests by date', async (fx) => {
  fx.digests.records.push(
    record('20261105T070000Z-scheduled', { started_at: '2026-11-05T07:00:00.000Z', ended_at: '2026-11-05T07:01:00.000Z' }),
    record('20261106T070000Z-scheduled', { output: null, error: 'The digest ended with error_during_execution: boom', daily_sources: [], cost_usd: null, in_progress: [] }),
  );
  await fx.open('digest');
  await repositories(fx);
  await card(fx, 'api').waitFor();
  assert.equal(await fx.page.locator('#digest .notline.bad').innerText(), 'The model call failed (The digest ended with error_during_execution: boom); the Git data is shown without its summary.');
  assert.equal(await fx.page.locator('#digest table.dgx').count(), 0);
  assert.match(await card(fx, 'api').locator('.dg-landed li').first().innerText(), /SHOP-7: Change a1b2c3d4e5/);
  assert.equal(await fx.page.locator('#digest .dg-cost').innerText(), 'cost unknown');
  // The Brief has the colleagues' commits from the Git data only, by their subjects; no app has an item to copy.
  await fx.page.getByRole('tab', { name: 'Brief' }).click();
  const brief = fx.page.locator('#digest .dg-brief');
  await brief.waitFor();
  assert.deepEqual(await brief.locator('.dg-sec > h4').allInnerTexts(), ['Merged by colleagues']);
  assert.match(await brief.locator('li', { hasText: 'SHOP-7: Change 0a0b0c0d0e' }).innerText(), /Colleague/);
  assert.equal(await brief.locator('.dg-app').count(), 0);
  // The earlier digest, by date.
  const pick = fx.page.getByLabel('Earlier digests');
  assert.equal((await pick.locator('option').allInnerTexts()).length, 2);
  await pick.selectOption('20261105T070000Z-scheduled');
  await eventually(async () => new URL(fx.page.url()).hash, '#digest/20261105T070000Z-scheduled');
  await fx.page.locator('#digest .dg-app[data-app="shop"]').waitFor();
  // Back to the board with Escape.
  await fx.page.keyboard.press('Escape');
  await fx.page.locator('#board').waitFor();
  assert.equal(await fx.page.locator('#digest').isHidden(), true);
});

// SF-119: a phone (360, 390 px) and a tablet (768 px).
for (const width of [360, 390, 768] as const) {
  browserTest(`digest page: at ${width} px nothing is wider than the screen`, async (fx) => {
    fx.digests.records.push(record('20261106T070000Z-scheduled'));
    await fx.page.setViewportSize({ width, height: 800 });
    await fx.open('digest');
    const wide = () => fx.page.evaluate(() => [document.documentElement, document.querySelector('#digest .jhead')!, document.querySelector('#digest .form2')!]
      .filter((node) => node.scrollWidth > node.clientWidth).map((node) => `${node.tagName}.${node.className}: ${node.scrollWidth} > ${node.clientWidth}`));
    await fx.page.locator('#digest .dg-brief').waitFor();
    assert.deepEqual(await wide(), []);
    await repositories(fx);
    await card(fx, 'api').waitFor();
    assert.deepEqual(await wide(), []);
    assert.equal(await fx.page.getByRole('button', { name: 'Generate now' }).isVisible(), true);
  });
}
