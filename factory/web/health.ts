// health.js, the dashboard's traffic light (SF-153), built from web/health.ts into dist/web/: red
// when a health check is down, else yellow while one is being recovered, else green ("off", not
// configured, counts as green); its title and accessible label say the same in words. A click opens
// the panel with every check (label, status, detail, since), read again from api/health. The
// stream's health events (main.js) bring the checks; a stream lost for more than 30 s turns the
// light red: sf serve does not answer. A classic script, loaded before main.js, sharing the page's
// globals with the others: no import or export.
'use strict';

// How long the stream may be lost before the light says sf serve does not answer.
const HEALTH_LOST_MS = 30000;

interface HealthPage {
  // The checks of the last health event or read; null before the first.
  checks: HealthCheck[] | null;
  // The stream is lost for more than HEALTH_LOST_MS.
  lost: boolean;
  lostTimer: ReturnType<typeof setTimeout> | null;
  open: boolean;
}

const health: HealthPage = { checks: null, lost: false, lostTimer: null, open: false };

// The light's colour and its words.
function healthLight(): { colour: 'red' | 'yellow' | 'green' | 'unknown'; words: string } {
  if (health.lost) {
    return { colour: 'red', words: 'Factory health: sf serve does not answer' };
  }
  const checks = health.checks;
  if (checks === null || checks.length === 0) {
    return { colour: 'unknown', words: 'Factory health: not checked yet' };
  }
  const labels = (status: HealthStatus): string => checks.filter((check) => check.status === status).map((check) => check.label).join(', ');
  if (checks.some((check) => check.status === 'down')) {
    return { colour: 'red', words: `Factory health: down: ${labels('down')}` };
  }
  if (checks.some((check) => check.status === 'recovering')) {
    return { colour: 'yellow', words: `Factory health: recovering: ${labels('recovering')}` };
  }
  return { colour: 'green', words: 'Factory health: everything works' };
}

const HEALTH_WORDS: Record<HealthStatus, string> = { ok: 'ok', recovering: 'recovering', down: 'down', off: 'off (not configured)' };

function renderHealthPanel(): void {
  const list = byId('health-list');
  const rows: HTMLElement[] = [];
  if (health.lost) {
    rows.push(el('li', 'hlost', 'sf serve does not answer: the checks below are the last ones it sent.'));
  }
  for (const check of health.checks ?? []) {
    const row = el('li', `hrow ${check.status}`);
    const head = el('div', 'hhead');
    head.append(el('span', `hdot ${check.status}`), el('b', '', check.label), el('span', 'hstatus', HEALTH_WORDS[check.status]));
    const since = el('span', 'hsince', 'since ');
    since.append(timeEl(check.since));
    row.append(head, el('div', 'hdetail', check.detail), since);
    rows.push(row);
  }
  if (rows.length === 0) {
    rows.push(el('li', 'hlost', 'No check has run yet.'));
  }
  list.replaceChildren(...rows);
}

function renderHealth(): void {
  const light = byId('health-light');
  const { colour, words } = healthLight();
  light.className = `hlight ${colour}`;
  light.title = words;
  light.setAttribute('aria-label', words);
  light.setAttribute('aria-expanded', String(health.open));
  byId('health-panel').hidden = !health.open;
  if (health.open) {
    renderHealthPanel();
  }
}

// The stream answers (it opened, or an event came): the light shows the checks again.
function healthStreamUp(): void {
  clearTimeout(health.lostTimer ?? undefined);
  health.lostTimer = null;
  if (health.lost) {
    health.lost = false;
    renderHealth();
  }
}

// The stream is lost (or the page's first read failed): red once it stays lost for HEALTH_LOST_MS.
function healthStreamDown(): void {
  if (health.lostTimer !== null || health.lost) {
    return;
  }
  health.lostTimer = setTimeout(() => {
    health.lostTimer = null;
    health.lost = true;
    renderHealth();
  }, HEALTH_LOST_MS);
}

// The checks of a health event.
function onHealthEvent(data: string): void {
  const checks = payload<HealthCheck[]>(data);
  health.checks = Array.isArray(checks) ? checks : [];
  healthStreamUp();
  renderHealth();
}

// The panel opens with the checks read again (their details move on between status changes).
function toggleHealth(): void {
  health.open = !health.open;
  renderHealth();
  if (health.open) {
    getText('api/health').then((text) => {
      const checks = payload<HealthCheck[]>(text);
      if (Array.isArray(checks)) {
        health.checks = checks;
        renderHealth();
      }
    }, () => undefined);
  }
}

function initHealth(): void {
  byId('health-light').addEventListener('click', toggleHealth);
  // Escape closes the panel, from the light or from inside the panel.
  byId('health-wrap').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && health.open) {
      event.preventDefault();
      toggleHealth();
      byId('health-light').focus();
    }
  });
  renderHealth();
}
