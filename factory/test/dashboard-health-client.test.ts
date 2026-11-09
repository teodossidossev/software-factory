// The dashboard's traffic light in web/health.ts (SF-153), run under node:vm against the fake page
// of test/support/fake-dom.ts: its colour and its words (title and accessible label) for down,
// recovering and ok (off counts as green), red after the stream is lost for more than 30 s and back
// once it answers, and the panel a click opens with each check's label, status, detail and since,
// read again from api/health. Script checks, not browser acceptance.
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

function light(page: Page): { colour: string; title: string; label: string | null } {
  const node = page.$('health-light');
  return { colour: node.className, title: (node as unknown as { title: string }).title, label: node.getAttribute('aria-label') };
}

test('the light before any check, then red when a check is down, yellow while one recovers, green when every check is ok or off; its title and label say the same in words', async () => {
  const page = await openPage();
  assert.deepEqual(light(page), { colour: 'hlight unknown', title: 'Factory health: not checked yet', label: 'Factory health: not checked yet' });
  const stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('health', [check('mcp', 'MCP endpoint', 'down'), check('tunnel', 'ChatGPT tunnel', 'recovering'), check('disk', 'Disk space', 'down')]);
  assert.deepEqual(light(page), { colour: 'hlight red', title: 'Factory health: down: MCP endpoint, Disk space', label: 'Factory health: down: MCP endpoint, Disk space' });
  stream.emit('health', [check('mcp', 'MCP endpoint', 'ok'), check('tunnel', 'ChatGPT tunnel', 'recovering')]);
  assert.deepEqual(light(page), { colour: 'hlight yellow', title: 'Factory health: recovering: ChatGPT tunnel', label: 'Factory health: recovering: ChatGPT tunnel' });
  stream.emit('health', ALL_OK);
  assert.deepEqual(light(page), { colour: 'hlight green', title: 'Factory health: everything works', label: 'Factory health: everything works' });
  // Off alone is not configured, never red.
  stream.emit('health', [check('tunnel', 'ChatGPT tunnel', 'off')]);
  assert.equal(light(page).colour, 'hlight green');
});

test('a stream lost for more than 30 s turns the light red with "sf serve does not answer"; a shorter loss does not; a stream that answers again restores it', async () => {
  const page = await openPage();
  let stream = page.streams.at(-1)!;
  stream.emit('open');
  stream.emit('health', ALL_OK);
  // A loss of one reconnect: the stream is back before 30 s.
  stream.emit('error');
  page.tick(3000);
  stream = page.streams.at(-1)!;
  stream.emit('open');
  assert.equal(page.tick(30000), 0, 'the 30 s timer was cleared');
  assert.equal(light(page).colour, 'hlight green');
  // A loss that lasts.
  stream.emit('error');
  assert.equal(light(page).colour, 'hlight green');
  page.tick(30000);
  assert.deepEqual(light(page), { colour: 'hlight red', title: 'Factory health: sf serve does not answer', label: 'Factory health: sf serve does not answer' });
  page.tick(3000);
  stream = page.streams.at(-1)!;
  stream.emit('open');
  assert.equal(light(page).colour, 'hlight green');
});

test('a first read that fails counts as a lost stream: red after 30 s', async () => {
  const page = await openPage(undefined, false);
  page.requests.find((request) => request.path === 'api/jobs')!.fail();
  await page.flush();
  page.tick(30000);
  assert.equal(light(page).colour, 'hlight red');
  assert.equal(light(page).title, 'Factory health: sf serve does not answer');
});

test('a click opens the panel with each check: label, status, detail and since, read again from api/health; a second click or Escape closes it', async () => {
  const fresh = [check('mcp', 'MCP endpoint', 'down', 'refused the token at http://127.0.0.1:8787/mcp/<token>'), check('tunnel', 'ChatGPT tunnel', 'off', 'no tunnel profile')];
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
  const rows = page.$('health-list').querySelectorAll('li');
  assert.deepEqual(rows.map((row) => row.className), ['hrow down', 'hrow off']);
  assert.match(rows[0]!.textContent, /^MCP endpointdownrefused the token at http:\/\/127\.0\.0\.1:8787\/mcp\/<token>since 2026-11-09 10:00:00$/);
  assert.match(rows[1]!.textContent, /ChatGPT tunneloff \(not configured\)no tunnel profile/);
  assert.equal(light(page).colour, 'hlight red', 'the read checks are shown by the light too');
  button.click();
  assert.equal(panel.hidden, true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  button.click();
  await page.flush();
  const escape = panel.dispatch('keydown', { key: 'Escape' });
  assert.equal(panel.hidden, true);
  assert.equal(escape.defaultPrevented, true);
});

test('the light is in the header, health.js loads before main.js', async () => {
  const page = await openPage();
  assert.ok(page.$('health-light').closest('.topbar') !== null);
  const scripts = page.document.querySelectorAll('script').map((node) => node.getAttribute('src'));
  assert.deepEqual(scripts.slice(-2), ['health.js', 'main.js']);
});
