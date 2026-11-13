// health.js, the health checks of the top bar's factory pill, built from web/health.ts into
// dist/web/: its dot is red when a health check is down ("N down"), else yellow while one is being
// recovered ("recovering"), else green ("off", not configured, counts as green), grey with no
// words before the first checks; its title and accessible label say the same in words. A click opens
// the popover under it: "N of M checks down · checked <age>", the failing checks with their detail
// and since, then the passing ones one line each, read again from api/health; the popover's run
// queue part is header.js's. Escape and a click outside close it (routing.js). The stream's health
// events (main.js) bring the checks; a stream lost for more than 30 s turns the pill red: sf serve
// does not answer. A classic script, loaded before main.js, sharing the page's globals with the
// others: no import or export.
'use strict';

// How long the stream may be lost before the pill says sf serve does not answer.
const HEALTH_LOST_MS = 30000;

interface HealthPage {
  // The checks of the last health event or read; null before the first.
  checks: HealthCheck[] | null;
  // When this page received them (Date.now()), for the popover's "checked <age>".
  at: number | null;
  // The stream is lost for more than HEALTH_LOST_MS.
  lost: boolean;
  lostTimer: ReturnType<typeof setTimeout> | null;
  open: boolean;
}

const health: HealthPage = { checks: null, at: null, lost: false, lostTimer: null, open: false };

// The pill's colour, its words in the bar and its words in full (its title and label).
function healthLight(): { colour: 'red' | 'yellow' | 'green' | 'unknown'; short: string; words: string } {
  if (health.lost) {
    return { colour: 'red', short: 'sf serve does not answer', words: 'Factory health: sf serve does not answer' };
  }
  const checks = health.checks;
  if (checks === null || checks.length === 0) {
    return { colour: 'unknown', short: '', words: 'Factory health: not checked yet' };
  }
  const of = (status: HealthStatus): HealthCheck[] => checks.filter((check) => check.status === status);
  const labels = (status: HealthStatus): string => of(status).map((check) => check.label).join(', ');
  if (of('down').length > 0) {
    return { colour: 'red', short: `${of('down').length} down`, words: `Factory health: down: ${labels('down')}` };
  }
  if (of('recovering').length > 0) {
    return { colour: 'yellow', short: 'recovering', words: `Factory health: recovering: ${labels('recovering')}` };
  }
  return { colour: 'green', short: '', words: 'Factory health: everything works' };
}

const FAILING: readonly HealthStatus[] = ['down', 'recovering'];

// "since 10:43" today, "since 2026-11-08 10:43" before; the exact moment in its title.
function sinceEl(ts: unknown): HTMLElement {
  const node = timeEl(ts);
  const text = node.textContent ?? '';
  node.textContent = text.slice(0, 10) === localTime(new Date().toISOString()).slice(0, 10) ? text.slice(11, 16) : text.slice(0, 16);
  return node;
}

// The time since the checks came (core.js ago).
const checkedAge = (): string => ago(health.at ?? Date.now());

function renderHealthPanel(): void {
  const checks = health.checks ?? [];
  const down = checks.filter((check) => check.status === 'down').length;
  byId('health-head').textContent = checks.length === 0 ? 'No check has run yet.' : `${down} of ${checks.length} checks down · checked ${checkedAge()}`;
  const rows: HTMLElement[] = [];
  if (health.lost) {
    rows.push(el('li', 'hlost', 'sf serve does not answer: the checks below are the last ones it sent.'));
  }
  // The failing checks first, each with its detail and since; then the others one line each.
  for (const check of checks.filter((row) => FAILING.includes(row.status))) {
    const row = el('li', `hrow ${check.status}`);
    const head = el('div', 'hhead');
    head.append(el('span', `hdot ${check.status}`), el('b', '', check.label), el('span', 'hstatus', check.status));
    const since = el('span', 'hsince', 'since ');
    since.append(sinceEl(check.since));
    row.append(head, el('div', 'hdetail', check.detail), since);
    rows.push(row);
  }
  for (const check of checks.filter((row) => !FAILING.includes(row.status))) {
    const row = el('li', `hline ${check.status}`);
    row.title = `${check.label}: ${check.detail}`;
    row.append(el('span', `hdot ${check.status}`), el('span', 'hlabel', check.label), el('span', 'hdt', check.detail));
    rows.push(row);
  }
  byId('health-list').replaceChildren(...rows);
}

// The pill: its colour, its words, its title and label (with the running count header.js wrote).
function renderPill(): void {
  const pill = byId('health-light');
  const { colour, short, words } = healthLight();
  pill.className = `hlight ${colour}`;
  byId('health-words').textContent = short;
  const label = `${words} · ${byId('health-run').textContent}`;
  pill.title = label;
  pill.setAttribute('aria-label', label);
  pill.setAttribute('aria-expanded', String(health.open));
}

function renderHealth(): void {
  renderPill();
  byId('health-panel').hidden = !health.open;
  if (health.open) {
    renderHealthPanel();
  }
}

// The stream answers (it opened, or an event came): the pill shows the checks again.
function healthStreamUp(): void {
  // The stream's state on the pill (data-stream): live, or down while it reconnects.
  byId('health-light').dataset.stream = 'live';
  clearTimeout(health.lostTimer ?? undefined);
  health.lostTimer = null;
  if (health.lost) {
    health.lost = false;
    renderHealth();
  }
}

// The stream is lost (or the page's first read failed): red once it stays lost for HEALTH_LOST_MS.
function healthStreamDown(): void {
  byId('health-light').dataset.stream = 'down';
  if (health.lostTimer !== null || health.lost) {
    return;
  }
  health.lostTimer = setTimeout(() => {
    health.lostTimer = null;
    health.lost = true;
    renderHealth();
  }, HEALTH_LOST_MS);
}

function setChecks(checks: HealthCheck[]): void {
  health.checks = checks;
  health.at = Date.now();
}

// The checks of a health event.
function onHealthEvent(data: string): void {
  const checks = payload<HealthCheck[]>(data);
  setChecks(Array.isArray(checks) ? checks : []);
  healthStreamUp();
  renderHealth();
}

// The popover opens with the checks read again (their details move on between status changes).
function toggleHealth(): void {
  health.open = !health.open;
  renderHealth();
  if (health.open) {
    getText('api/health').then((text) => {
      const checks = payload<HealthCheck[]>(text);
      if (Array.isArray(checks)) {
        setChecks(checks);
        renderHealth();
      }
    }, () => undefined);
  }
}

// The popover closes (Escape, a click outside it); focus: the pill takes the focus back. False
// when it was not open.
function closeHealth(focus: boolean): boolean {
  if (!health.open) {
    return false;
  }
  toggleHealth();
  if (focus) {
    byId('health-light').focus();
  }
  return true;
}

function initHealth(): void {
  byId('health-light').addEventListener('click', toggleHealth);
  renderHealth();
}
