// The top bar's factory pill in web/health.ts (SF-153, SF-160), run under node:vm against the fake
// page of test/support/fake-dom.ts: its dot's colour, its words ("N down", "recovering", none) and
// its title and accessible label for down, recovering and ok (off counts as green), red with "sf
// serve does not answer" after the stream is lost for more than 30 s and back once it answers, and
// the popover a click opens: "N of M checks down · checked <age>", the failing checks first with
// their detail and since, then the passing ones one line each, read again from api/health; Escape
// and a click outside close it. Script checks, not browser acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPage, type Page } from './support/fake-dom.js';

const STATIC_DIR = new URL('../../static/', import.meta.url);
process.env.TZ = 'Europe/Sofia';

type Status = 'ok' | 'recovering' | 'down' | 'off';
const check = (id: string, label: string, status: Status, detail = `${label} detail`) => ({ id, label, status, detail, since: '2026-11-09T08:00:00.000Z' });
const ALL_OK = [check('mcp', 'MCP endpoint', 'ok'), check('tunnel', 'ChatGPT tunnel', 'off', 'no tunnel profile'), check('jobs', 'Jobs', 'ok')];

// The board with its stream open; api/health answers health (none: the test answers).
async function openPage(health?: unknown, jobsAnswer = true): Promise<Page> {
  const page = await loadPage(STATIC_DIR, (path) => {
    if (path === 'api/jobs') {
      return jobsAnswer ? { jobs: [] } : undefined;
    }
    return path === 'api/health' ? health : undefined;
  });
  page.document.dispatch('DOMContentLoaded');
  await page.flush();
  return page;
}

function pill(page: Page): { colour: string; words: string; run: string; title: string; label: string | null } {
  const node = page.$('health-light');
  return { colour: node.className, words: page.$('health-words').textContent, run: page.$('health-run').textContent, title: (node as unknown as { title: string }).title, label: node.getAttribute('aria-label') };
}

test('the pill before any check (grey, no words), then red with "N down", yellow with "recovering", green without words when every check is ok or off; its title and label say it in full with the running count', async () => {
  const page = await openPage();
  assert.deepEqual(pill(page), { colour: 'hlight unknown', words: '', run: '0 running', title: 'Factory health: not checked yet · 0 running', label: 'Factory health: not checked yet · 0 running' });
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('health', [check('mcp', 'MCP endpoint', 'down'), check('tunnel', 'ChatGPT tunnel', 'recovering'), check('disk', 'Disk space', 'down')]);
  assert.deepEqual(pill(page), { colour: 'hlight red', words: '2 down', run: '0 running', title: 'Factory health: down: MCP endpoint, Disk space · 0 running', label: 'Factory health: down: MCP endpoint, Disk space · 0 running' });
  stream.emit('health', [check('mcp', 'MCP endpoint', 'ok'), check('tunnel', 'ChatGPT tunnel', 'recovering')]);
  assert.deepEqual([pill(page).colour, pill(page).words, pill(page).label], ['hlight yellow', 'recovering', 'Factory health: recovering: ChatGPT tunnel · 0 running']);
  stream.emit('health', ALL_OK);
  assert.deepEqual([pill(page).colour, pill(page).words, pill(page).label], ['hlight green', '', 'Factory health: everything works · 0 running']);
  // Off alone is not configured, never red.
  stream.emit('health', [check('tunnel', 'ChatGPT tunnel', 'off')]);
  assert.equal(pill(page).colour, 'hlight green');
});

test('a stream lost for more than 30 s turns the pill red with "sf serve does not answer"; a shorter loss does not; a stream that answers again restores it', async () => {
  const page = await openPage();
  let stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('health', ALL_OK);
  assert.equal(page.$('health-light').dataset.stream, 'live');
  // A loss of one reconnect: the stream is back before 30 s.
  stream.emit('error');
  assert.equal(page.$('health-light').dataset.stream, 'down');
  page.tick(3000);
  stream = page.streams.at(-1)!;
  stream.emit('open');
  assert.equal(page.tick(30000), 0, 'the 30 s timer was cleared');
  assert.equal(pill(page).colour, 'hlight green');
  // A loss that lasts.
  stream.emit('error');
  assert.equal(pill(page).colour, 'hlight green');
  page.tick(30000);
  assert.deepEqual([pill(page).colour, pill(page).words, pill(page).title], ['hlight red', 'sf serve does not answer', 'Factory health: sf serve does not answer · 0 running']);
  page.tick(3000);
  stream = page.streams.at(-1)!;
  stream.emit('open');
  assert.deepEqual([pill(page).colour, pill(page).words], ['hlight green', '']);
});

test('a first read that fails counts as a lost stream: red after 30 s', async () => {
  const page = await openPage(undefined, false);
  page.requests.find((request) => request.path === 'api/jobs')!.fail();
  await page.flush();
  page.tick(30000);
  assert.deepEqual([pill(page).colour, pill(page).words], ['hlight red', 'sf serve does not answer']);
});

test('a click opens the popover, read again from api/health: the count line, the failing checks first with detail and since, then the passing ones one line each; a second click, Escape and a click outside close it', async () => {
  const today = new Date().toISOString();
  const fresh = [
    check('mcp', 'MCP endpoint', 'ok', 'answers'),
    { ...check('disk', 'Disk space', 'down', 'refused the token at http://127.0.0.1:8787/mcp/<token>'), since: '2026-01-02T08:43:00.000Z' },
    check('tunnel', 'ChatGPT tunnel', 'off', 'no tunnel profile'),
    { ...check('sandboxes', 'Sandbox leftovers', 'recovering', 'reaping 2'), since: today },
  ];
  const page = await openPage(fresh);
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('health', ALL_OK);
  const button = page.$('health-light');
  const panel = page.$('health-panel');
  assert.equal(panel.hidden, true);
  button.click();
  await page.flush();
  assert.equal(panel.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.ok(page.requests.some((request) => request.path === 'api/health'));
  assert.match(page.$('health-head').textContent, /^1 of 4 checks down · checked \d+ s ago$/);
  const rows = page.$('health-list').querySelectorAll('li');
  assert.deepEqual(rows.map((row) => row.className), ['hrow down', 'hrow recovering', 'hline ok', 'hline off']);
  // Since: the date and time before today, the time alone today.
  assert.equal(rows[0]!.textContent, 'Disk spacedownrefused the token at http://127.0.0.1:8787/mcp/<token>since 2026-01-02 10:43');
  const clock = new Date(today).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Sofia' });
  assert.equal(rows[1]!.textContent, `Sandbox leftoversrecoveringreaping 2since ${clock}`);
  assert.equal(rows[2]!.textContent, 'MCP endpointanswers');
  assert.equal(rows[3]!.textContent, 'ChatGPT tunnelno tunnel profile');
  assert.deepEqual([pill(page).colour, pill(page).words], ['hlight red', '1 down'], 'the read checks are shown by the pill too');
  // Without the run queue the popover holds no run limit and no rule.
  assert.equal(page.$('qctl').hidden, true);
  button.click();
  assert.equal(panel.hidden, true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  button.click();
  await page.flush();
  const escape = panel.dispatch('keydown', { key: 'Escape' });
  assert.deepEqual([panel.hidden, escape.defaultPrevented, page.document.activeElement], [true, true, button]);
  // A click inside keeps it open; a click outside closes it.
  button.click();
  await page.flush();
  page.$('health-list').click();
  assert.equal(panel.hidden, false);
  page.$('cols').click();
  assert.equal(panel.hidden, true);
});

test('the pill is in the header; header.js loads before board.js, health.js before main.js', async () => {
  const page = await openPage();
  assert.ok(page.$('health-light').closest('.topbar') !== null);
  assert.equal(page.document.querySelectorAll('#connection').length, 0);
  const scripts = page.document.querySelectorAll('script').map((node) => node.getAttribute('src'));
  assert.deepEqual(scripts.slice(-3), ['health.js', 'pins.js', 'main.js']);
  assert.equal(scripts.indexOf('header.js') + 1, scripts.indexOf('board.js'));
});
