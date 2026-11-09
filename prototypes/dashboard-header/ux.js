// Header redesign prototype: three layouts of the same board, ?v=1|2|3. Placeholder data only.
(() => {
  'use strict';
  addEventListener('error', (e) => { document.documentElement.dataset.err = String(e.message); });

  // ---------- Data ----------
  const WS = [
    { name: 'acme-api', color: 'olive' },
    { name: 'acme-web-frontend-second', color: 'teal' },
    { name: 'software-factory', color: 'blue' },
  ];
  const wsColor = (name) => (WS.find((w) => w.name === name) || { color: 'grey' }).color;
  const DATA = {
    queue: [
      { key: 'ACME-151', ws: 'acme-api', title: 'Rate-limit the export endpoint per API key', queued: true, check: 'ready', waits: 'ACME-123' },
      { key: 'ACME-140', ws: 'acme-web-frontend-second', title: 'Property preview keeps anonymous declarations after the shape API change', queued: false, check: 'not ready: 1 blocker' },
      { key: 'ACME-152', ws: 'software-factory', title: 'The digest names the weekend days it covers', queued: false, check: 'draft' },
    ],
    implementing: [
      { key: 'ACME-123', ws: 'software-factory', title: 'sf serve keeps the tunnel up and reaps sandbox leftovers', now: 'running the tests (npm test)', meta: 'Iteration 4 · 129 tool calls · $8.98 so far · 1 h 14 min' },
      { key: 'ACME-131', ws: 'acme-web-frontend-second', title: 'Class editor saves read-only superclass expressions', now: 'reading src/editor/ClassForm.tsx', meta: 'Iteration 1 · 36 tool calls · $0.41 so far · 4 min' },
    ],
    reviewing: [],
    you: [
      { key: 'ACME-118', ws: 'acme-web-frontend-second', title: 'Unify model navigation and return to local declarations by shape ID', reason: 'In your checkout on ACME-118-unify-model-navigation', meta: 'Iteration 6 · $16.00 · 3 h 36 min', action: 'Review the MR and push' },
    ],
    done: [
      { key: 'ACME-109', ws: 'acme-web-frontend-second', title: 'Support read-only anonymous superclass expressions', meta: 'Pushed · 8 iterations · 07:22 · $26.25' },
      { key: 'ACME-104', ws: 'software-factory', title: 'Remove the old execution transport', meta: 'Pushed · 3 iterations · 19:15 · $26.41' },
    ],
  };
  const COLS = [['queue', 'Queue'], ['implementing', 'Implementing'], ['reviewing', 'Reviewing'], ['you', 'Your turn'], ['done', 'Done']];
  const EMPTY = { queue: 'No ticket is planned.', implementing: 'Nothing is being implemented.', reviewing: 'Nothing in review.', you: 'Nothing waits for you.', done: 'No finished job.' };
  const RULES = [
    ['resume-then-queue', 'Resume parked jobs, then go on with the queue', 'resume, then queue'],
    ['resume-only', 'Resume parked jobs only', 'resume only'],
    ['wait', 'Wait for me', 'wait for me'],
  ];
  const PAGES = [['board', 'Board', 'board'], ['digest', 'Digest', 'digest'], ['stats', 'Stats', 'stats'], ['archived', 'Archived', 'archive'], ['workspaces', 'Workspaces', 'folder']];
  const PAGE_NOTES = {
    digest: ['The digest picker (date · trigger) and Generate now stay in the page head; "since … · generated … · cost" becomes one muted line under the title.',
      'Repositories / My daily become tabs in the page head, not buttons inside the body.',
      'The workspace filter applies here too: a filtered board opens the digest on that workspace\'s card.'],
    stats: ['Warnings first, as a short list with links; the "Now" tiles go (the header already says running / waiting / queued).',
      'The page\'s own workspace select goes: Stats follows the global workspace filter.',
      'The 12-column jobs table keeps Ticket, Title, State, Cost, Time to ready; the rest behind "More columns".'],
    archived: ['Archived becomes a page with a search box (key, title, workspace) instead of a drawer list of 119 cards.',
      'Rows grouped by month, newest first, one line each: key · workspace · title · outcome · date.',
      'Restore and Delete… on the row; the Task file opens on the row\'s click.'],
    workspaces: ['One row per workspace (dot, full name, path, digest / My daily / hand-over as small toggles); Edit opens the form for that row only.',
      'The "Add a workspace" form collapses behind a button; its hints shrink to one line each.',
      'The Morning digest settings (time, weekdays, language) move to their own small card under the list.'],
  };
  const ICONS = {
    board: '<rect x="3.5" y="4" width="5" height="16" rx="1"/><rect x="10.5" y="4" width="5" height="10" rx="1"/><rect x="17.5" y="4" width="3.5" height="13" rx="1"/>',
    digest: '<path d="M4 5h11v14H6.5A2.5 2.5 0 0 1 4 16.5z"/><path d="M15 9h4.5v7.5A2.5 2.5 0 0 1 17 19h-2"/><path d="M7 9h5M7 12.5h5"/>',
    stats: '<path d="M5 20V11M10.5 20V5M16 20v-6M3 20h18"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    left: '<path d="M14.5 6l-6 6 6 6"/>',
    right: '<path d="M9.5 6l6 6-6 6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
  };
  const LOGO = '<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a1f"/><stop offset="1" stop-color="#e5306f"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#lg)"/><path fill="#fff" d="M8 54V32l12-8v8l12-8v8l12-8V13h9v41z"/><circle cx="21" cy="43" r="5.5" fill="#c4235a"/><circle cx="38" cy="43" r="5.5" fill="#c4235a"/></svg>';

  // ---------- State ----------
  const params = new URLSearchParams(location.search);
  const narrowMq = matchMedia('(max-width: 700px)');
  const pageOf = () => { const p = location.hash.slice(1); return PAGES.some(([id]) => id === p) ? p : 'board'; };
  const S = {
    v: ['1', '2', '3'].includes(params.get('v')) ? params.get('v') : '1',
    view: pageOf(),
    filter: '',
    limit: 2,
    rule: 'resume-then-queue',
    down: params.get('h') !== 'ok',
    pop: null,          // the open popover's id
    fold: new Set(),
    rail: innerWidth >= 1440 ? 'wide' : 'slim',
    railOpen: false,    // v2 on a phone
    drawer: null,       // v3: 'you' | 'health' | 'queue' | 'new'
    archived: 119,
    seq: 160,
  };

  // ---------- Helpers ----------
  const h = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };
  const icon = (name) => h('span', { class: 'ic', 'aria-hidden': 'true', html: `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` });
  const dot = (ws) => h('span', { class: `wsdot ws-${wsColor(ws)}` });
  const visible = (row) => S.filter === '' || row.ws === S.filter;
  const all = () => Object.values(DATA).flat();
  const running = () => DATA.implementing.length + DATA.reviewing.length;
  const free = () => Math.max(0, S.limit - running());
  const checks = () => [
    ['MCP endpoint', 'answers at http://127.0.0.1:8787/mcp/<token>'],
    ['ChatGPT tunnel', 'ready; last poll 12 s ago'],
    ["Tunnel's sf build", 'built from its sources'],
    ['Jobs', `${running()} running, each with its runner`],
    ['Run queue', `${DATA.queue.filter((r) => r.queued).length} queued, ${running()} running`],
    ['Remote dashboard', 'listening on 8789'],
    ['Logins', 'Claude CLI, Codex CLI, GitHub token'],
    ['Disk space', '105.9 GB free (31 %)'],
    ['Sandbox leftovers', S.down ? '20 orphaned sandbox processes outlived the reaper' : 'none'],
    ['Morning digest', 'made today at 06:00'],
  ].map(([label, detail]) => ({ label, detail, down: S.down && label === 'Sandbox leftovers' }));
  const downChecks = () => checks().filter((c) => c.down);
  const nextText = (short = false) => {
    const q = DATA.queue.filter((r) => r.queued);
    if (q.length === 0) return 'the queue is empty';
    const ready = q.find((r) => r.check === 'ready' && !r.waits);
    if (ready) return free() > 0 ? `${ready.key} starts now` : `${ready.key} when a slot frees`;
    return short ? 'nothing ready' : `nothing ready (${q[0].key} waits for ${q[0].waits || 'its plan'})`;
  };
  let toastTimer = 0;
  const toast = (text) => {
    const t = document.getElementById('toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  };
  const go = (view) => {
    S.view = view; S.pop = null; S.railOpen = false;
    history.replaceState(null, '', `${location.search}${view === 'board' ? '' : '#' + view}`);
    render(); scrollTo(0, 0);
  };
  const setFilter = (ws) => { S.filter = ws; S.pop = null; S.railOpen = false; render(); };
  const showYourTurn = () => {
    if (S.view !== 'board') go('board');
    if (!DATA.you.some(visible)) S.filter = '';
    S.pop = null; S.drawer = S.v === '3' ? 'you' : S.drawer;
    render();
    const col = document.querySelector('.col.you');
    if (col) { col.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); col.classList.remove('flash'); void col.offsetWidth; col.classList.add('flash'); }
  };

  // ---------- Header pieces ----------
  const brand = (name = true) => h('button', { class: 'brand', type: 'button', 'data-k': 'brand', title: 'Board', onclick: () => go('board') },
    h('span', { html: LOGO, style: 'display:inline-flex' }), name ? h('span', { class: 'bn' }, 'Software Factory') : null);

  // What needs me: counts every workspace, even when the filter hides a card.
  const needsPill = (k = 'needs', withRunning = true) => {
    const n = DATA.you.length;
    const hidden = DATA.you.filter((r) => !visible(r)).length;
    return h('button', { class: `needs${n === 0 ? ' zero' : ''}`, type: 'button', 'data-k': k, onclick: showYourTurn,
      title: hidden > 0 ? `${hidden} of them in a workspace the filter hides: a click shows all` : 'Show Your turn' },
    h('span', {}, n === 0 ? 'Nothing waits for you' : [`${n} `, h('span', { class: 'hide-s' }, n === 1 ? 'waits for you' : 'wait for you'), h('span', { class: 'only-s' }, 'for you')]),
    hidden > 0 ? h('span', { class: 'run' }, '(hidden)') : null,
    withRunning ? h('span', { class: 'run hide-s' }, `· ${running()} running`) : null);
  };

  const stepper = (k) => h('span', { class: 'stepper' },
    h('button', { type: 'button', 'aria-label': 'One job fewer', 'data-k': `${k}-`, onclick: () => { S.limit = Math.max(1, S.limit - 1); render(); } }, '−'),
    h('output', {}, S.limit),
    h('button', { type: 'button', 'aria-label': 'One job more', 'data-k': `${k}+`, onclick: () => { S.limit = Math.min(6, S.limit + 1); render(); } }, '+'));
  const pips = () => {
    const n = Math.max(S.limit, running());
    return h('span', { class: 'pips', 'aria-hidden': 'true' }, Array.from({ length: n }, (_, i) => h('span', { class: `pip${i < running() ? (i >= S.limit ? ' over' : ' on') : ''}` })));
  };
  const capacity = (k) => h('div', { class: 'cap' },
    h('span', {}, 'Run up to'), stepper(k), h('span', {}, 'at once'), pips(),
    h('span', { class: 'qline' }, running() > S.limit ? `${running()} running: ${running() - S.limit} over, no new start` : `${running()} running · ${free()} free`));
  const queueLine = () => h('div', { class: 'qline' }, `Next: ${nextText()}`);
  const rulesRadios = (k) => h('div', { class: 'rules', role: 'radiogroup', 'aria-label': 'When the usage limit resets' },
    RULES.map(([id, label]) => h('label', {}, h('input', { type: 'radio', name: `rule-${k}`, value: id, checked: S.rule === id, 'data-k': `${k}-${id}`,
      onchange: () => { S.rule = id; render(); } }), label)));
  const rulesShort = () => RULES.find(([id]) => id === S.rule)[2];

  const healthPanel = () => {
    const list = checks();
    const bad = list.filter((c) => c.down);
    return h('div', { class: 'dsec' },
      h('div', { class: 'hp-head' }, h('b', {}, bad.length ? `${bad.length} of ${list.length} checks down` : `All ${list.length} checks pass`), h('span', { class: 'muted' }, 'checked 12 s ago')),
      bad.map((c) => h('div', { class: 'hp-bad' }, h('span', { class: 't' }, h('span', { class: 'bulb down' }), c.label, h('span', { class: 'sp' }), 'down'),
        h('span', { class: 'd' }, c.detail), h('span', { class: 's' }, 'since 10:43 (12 min)'))),
      h('ul', { class: 'hp-ok' }, list.filter((c) => !c.down).map((c) => h('li', { title: `${c.label}: ${c.detail} · ok since 10:40` }, h('span', { class: 'bulb' }), h('span', {}, c.label), h('span', { class: 'dt' }, c.detail)))),
      h('div', { class: 'hp-foot' }, h('button', { class: 'btn small', type: 'button', 'data-k': 'recheck', onclick: () => toast('Checked again: same result') }, 'Check again'), 'Hover a row for its full text.'));
  };

  // A popover: its trigger (with data-pop) and its panel.
  const popover = (id, trigger, content, left = false, extra = '') => {
    trigger.setAttribute('data-pop', id);
    trigger.setAttribute('data-k', `pop-${id}`);
    trigger.setAttribute('aria-expanded', String(S.pop === id));
    trigger.setAttribute('aria-haspopup', 'true');
    return h('div', { class: `popwrap ${extra}` }, trigger, S.pop === id ? h('div', { class: `pop${left ? ' left' : ''}`, 'data-for': id }, content()) : null);
  };

  const wsCount = (ws) => all().filter((r) => ws === '' || r.ws === ws).length;
  const wsOptions = () => h('div', { class: 'opts', role: 'menu' },
    [['', 'All workspaces'], ...WS.map((w) => [w.name, w.name])].map(([ws, label]) =>
      h('button', { class: 'opt', type: 'button', role: 'menuitemradio', 'aria-checked': String(S.filter === ws), 'data-k': `ws-${ws}`, onclick: () => setFilter(ws) },
        ws === '' ? h('span') : dot(ws), h('span', {}, label), h('span', { class: 'count' }, wsCount(ws)))));
  const wsDropdown = (id, extra) => popover(id,
    h('button', { class: 'pill wsbtn', type: 'button', title: S.filter || 'All workspaces' }, S.filter ? dot(S.filter) : null, h('span', { class: 'nm' }, S.filter || 'All workspaces'), h('span', { class: 'dim' }, '▾')),
    wsOptions, false, extra);

  const navTabs = (extra = '') => h('nav', { class: `tabs ${extra}`, 'aria-label': 'Pages' },
    PAGES.map(([id, label]) => h('button', { class: 'tab', type: 'button', 'data-k': `tab-${id}`, 'aria-current': S.view === id ? 'page' : null, onclick: () => go(id) },
      label, id === 'archived' ? h('span', { class: 'count' }, S.archived) : null)));
  const navDropdown = (id, extra) => popover(id,
    h('button', { class: 'pill', type: 'button' }, icon(PAGES.find(([p]) => p === S.view)[2]), PAGES.find(([p]) => p === S.view)[1], h('span', { class: 'dim' }, '▾')),
    () => h('div', { class: 'opts', role: 'menu' }, PAGES.map(([p, label, ic]) => h('button', { class: 'opt', type: 'button', role: 'menuitemradio', 'aria-checked': String(S.view === p), 'data-k': `nav-${p}`, onclick: () => go(p) },
      icon(ic), h('span', {}, label), h('span', { class: 'count' }, p === 'archived' ? S.archived : '')))), true, extra);

  const newBtn = (k = 'new') => h('button', { class: 'btn primary', type: 'button', 'data-k': k, onclick: openNew, title: 'New ticket', 'aria-label': 'New ticket' }, icon('plus'), h('span', { class: 'hide-s' }, 'New ticket'));

  // v1 and v2 (phone): one pill for the whole factory state, a popover with health, run limit and rules.
  const factoryPill = (id, extra) => {
    const bad = downChecks().length;
    return popover(id,
      h('button', { class: `pill${bad ? ' down' : ''}`, type: 'button', title: bad ? `${bad} health check down` : 'Factory health: everything works' },
        h('span', { class: `bulb${bad ? ' down' : ''}` }), h('span', { class: 'hide-s' }, bad ? `${bad} down` : 'Healthy'), h('span', { class: 'dim' }, `${running()}/${S.limit}`, h('span', { class: 'hide-s' }, ' running'))),
      () => [h('h3', {}, 'Health'), healthPanel(), h('hr'), h('h3', {}, 'Run queue'), capacity(`${id}-cap`), queueLine(), h('hr'), h('h3', {}, 'When the usage limit resets'), rulesRadios(id)], false, extra);
  };

  // ---------- Layouts ----------
  function renderHeader() {
    const hdr = document.getElementById('hdr');
    if (S.v === '1') {
      hdr.replaceChildren(
        h('div', { class: 'hrow' }, brand(), needsPill('needs', false), navTabs('wide'), h('span', { class: 'sp' }), wsDropdown('ws', 'wide'), factoryPill('factory'), newBtn()),
        h('div', { class: 'hrow hrow2 narrow' }, navDropdown('nav'), wsDropdown('ws-n')));
    } else if (S.v === '2') {
      const bad = downChecks().length;
      hdr.replaceChildren(h('div', { class: 'hrow' },
        h('button', { class: 'btn ghost navbtn', type: 'button', 'aria-label': 'Menu', 'data-k': 'menu', onclick: () => { S.railOpen = true; render(); } }, icon('menu')),
        h('span', { class: 'ptitle' }, PAGES.find(([p]) => p === S.view)[1]),
        needsPill(),
        h('span', { class: 'sp' }),
        popover('health', h('button', { class: `pill wide${bad ? ' down' : ''}`, type: 'button' }, h('span', { class: `bulb${bad ? ' down' : ''}` }), bad ? `${bad} check down` : 'Healthy'), () => healthPanel(), false, 'wide'),
        h('div', { class: 'cap wide' }, h('span', {}, 'Run up to'), stepper('top'), h('span', {}, 'at once'), pips(), h('span', { class: 'qline', title: `Next: ${nextText()}` }, `${free()} free · next: ${nextText(true)}`)),
        popover('rules', h('button', { class: 'pill wide', type: 'button', title: 'When the usage limit resets' }, `At reset: ${rulesShort()}`, h('span', { class: 'dim' }, '▾')), () => [h('h3', {}, 'When the usage limit resets'), rulesRadios('rules')], false, 'wide'),
        factoryPill('factory', 'narrow')));
    } else {
      hdr.replaceChildren(
        h('div', { class: 'hrow' }, brand(), navTabs('wide'), h('span', { class: 'sp' }), wsDropdown('ws', 'wide'), newBtn()),
        h('div', { class: 'hrow hrow2 narrow' }, navDropdown('nav'), wsDropdown('ws-n')));
    }
  }

  function renderRail() {
    const rail = document.getElementById('rail');
    if (S.v !== '2') { rail.replaceChildren(); return; }
    const narrow = narrowMq.matches;
    rail.replaceChildren(...[
      h('div', { class: 'rl-head' }, brand(), h('span', { class: 'sp' }),
        narrow ? h('button', { class: 'btn ghost small', type: 'button', 'aria-label': 'Close the menu', 'data-k': 'rail-x', onclick: () => { S.railOpen = false; render(); } }, icon('x')) : null),
      h('button', { class: 'btn primary rl-new', type: 'button', 'data-k': 'rl-new', title: 'New ticket', onclick: openNew }, icon('plus'), h('span', { class: 'rl-text' }, 'New ticket')),
      PAGES.map(([id, label, ic]) => h('button', { class: 'rl-item', type: 'button', 'data-k': `rl-${id}`, title: label, 'aria-current': S.view === id ? 'page' : null, onclick: () => go(id) },
        icon(ic), h('span', { class: 'rl-text' }, label), id === 'archived' ? h('span', { class: 'count' }, S.archived) : null)),
      h('div', { class: 'rl-sec' }, 'Workspaces'),
      [['', 'All workspaces'], ...WS.map((w) => [w.name, w.name])].map(([ws, label]) =>
        h('button', { class: 'rl-item ws', type: 'button', role: 'menuitemradio', 'aria-checked': String(S.filter === ws), 'data-k': `rlws-${ws}`, title: label, onclick: () => setFilter(ws) },
          ws === '' ? h('span', { class: 'wsdot', style: 'background:transparent;border:1.5px solid var(--muted)' }) : dot(ws), h('span', { class: 'rl-text' }, label), h('span', { class: 'count' }, wsCount(ws)))),
      narrow ? null : h('div', { class: 'rl-foot' }, h('button', { class: 'rl-item', type: 'button', 'data-k': 'rl-fold', title: S.rail === 'wide' ? 'Collapse the menu' : 'Expand the menu',
        onclick: () => { S.rail = S.rail === 'wide' ? 'slim' : 'wide'; render(); } }, icon(S.rail === 'wide' ? 'left' : 'right'), h('span', { class: 'rl-text' }, 'Collapse'))),
    ].flat(Infinity).filter(Boolean));
  }

  function renderStatus() {
    const bar = document.getElementById('status');
    if (S.v !== '3') { bar.replaceChildren(); return; }
    const bad = downChecks();
    const q = DATA.queue.filter((r) => r.queued).length;
    const sb = (id, cls, ...kids) => h('button', { class: `sb ${cls}`, type: 'button', 'data-k': `sb-${id}`, 'aria-expanded': String(S.drawer === id),
      onclick: () => { S.drawer = S.drawer === id ? null : id; S.pop = null; render(); } }, ...kids);
    bar.replaceChildren(
      sb('health', bad.length ? 'down' : '', h('span', { class: `bulb${bad.length ? ' down' : ''}` }), bad.length ? [`${bad.length} down`, h('span', { class: 'lng' }, `· ${bad[0].label}`)] : ['ok', h('span', { class: 'lng' }, '· all checks pass')]),
      sb('queue', '', pips(), `${running()}/${S.limit}`, h('span', { class: 'lng' }, ` running · ${free()} free`)),
      sb('queue', '', `Q ${q}`, h('span', { class: 'lng' }, ` · next: ${nextText()}`)),
      sb('queue', 'lng-only', h('span', { class: 'lng' }, `At reset: ${rulesShort()}`)),
      h('span', { class: 'sp' }),
      sb('you', DATA.you.length ? 'you' : '', DATA.you.length ? `${DATA.you.length} for you` : 'nothing for you'));
  }

  function renderDrawer() {
    const d = document.getElementById('drawer');
    const scrim = document.getElementById('scrim');
    const open = S.v === '3' && S.drawer !== null;
    document.body.classList.toggle('drawer-open', open);
    d.hidden = !open;
    scrim.hidden = !(open && narrowMq.matches) && !(S.v === '2' && S.railOpen && narrowMq.matches);
    if (!open) { d.replaceChildren(); return; }
    const tabs = [['you', `Waits for you (${DATA.you.length})`], ['health', 'Health'], ['queue', 'Run queue']];
    const head = h('div', { class: 'dhead' },
      S.drawer === 'new' ? h('b', { style: 'padding-left:12px' }, 'New ticket')
        : tabs.map(([id, label]) => h('button', { class: 'tab', type: 'button', 'data-k': `dt-${id}`, 'aria-current': S.drawer === id ? 'page' : null, onclick: () => { S.drawer = id; render(); } }, label)),
      h('span', { class: 'sp' }),
      h('button', { class: 'btn ghost small', type: 'button', 'aria-label': 'Close', 'data-k': 'dx', onclick: () => { S.drawer = null; render(); } }, icon('x')));
    let body;
    if (S.drawer === 'you') {
      body = DATA.you.length ? h('div', { class: 'col you has', style: 'margin:0' }, h('ul', {}, DATA.you.map(jobCard))) : h('p', { class: 'muted' }, 'Nothing waits for you.');
    } else if (S.drawer === 'health') {
      body = healthPanel();
    } else if (S.drawer === 'queue') {
      body = h('div', { class: 'dsec' }, h('h3', {}, 'Run limit'), capacity('dq'), queueLine(),
        h('h3', {}, 'In the queue'), h('ol', { class: 'qlist' }, DATA.queue.filter((r) => r.queued).map((r) => h('li', {}, h('b', { class: 'mono' }, r.key), h('span', {}, r.title), r.waits ? h('span', { class: 'muted' }, `waits for ${r.waits}`) : null))),
        h('h3', {}, 'When the usage limit resets'), rulesRadios('dq'));
    } else {
      body = ticketForm(() => { S.drawer = null; render(); });
    }
    d.replaceChildren(head, h('div', { class: 'dbody' }, body));
  }

  // ---------- Board ----------
  const chip = (row) => {
    if (row.check === 'draft') return h('span', { class: 'chk' }, 'draft');
    if (row.check === 'ready') return h('span', { class: 'chk ready' }, 'plan ready');
    return h('span', { class: 'chk bad' }, row.check);
  };
  const cardBase = (row, kind) => h('li', { class: `card ws-${wsColor(row.ws)}`, tabindex: '0', 'data-k': `card-${row.key}`, 'data-key': row.key,
    onclick: (e) => { if (!e.target.closest('button')) toast(`Opens ${row.key}'s ${kind}`); },
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) toast(`Opens ${row.key}'s ${kind}`); } },
  h('div', { class: 'row1' }, row.queued ? h('span', { class: 'pos', title: 'Position in the queue' }, DATA.queue.filter((r) => r.queued).indexOf(row) + 1) : null,
    h('span', { class: 'key' }, row.key), h('span', { class: 'wschip' }, dot(row.ws), row.ws)),
  h('div', { class: 'title' }, row.title));
  function queueCard(row) {
    const li = cardBase(row, 'ticket page');
    li.append(h('div', { class: 'row1' }, chip(row)));
    if (row.waits) li.append(h('div', { class: 'waits' }, `waits for ${row.waits} (implementing)`));
    const act = h('div', { class: 'act' });
    if (row.check === 'draft') act.append(h('span', { class: 'meta' }, 'waiting for the plan'));
    else act.append(h('button', { class: 'btn small', type: 'button', 'data-k': `q-${row.key}`, onclick: () => { row.queued = !row.queued; render(); } }, row.queued ? 'Remove from queue' : 'Add to queue'));
    li.append(act);
    return li;
  }
  function jobCard(row) {
    const li = cardBase(row, 'job page');
    if (row.now) li.append(h('div', { class: 'now' }, h('span', { class: 'pulse' }), h('b', {}, 'Implementer'), h('span', {}, row.now)));
    if (row.reason) li.append(h('div', { class: 'reason' }, row.reason));
    li.append(h('div', { class: 'meta' }, row.meta));
    if (row.action) li.append(h('div', { class: 'act' }, h('button', { class: 'btn small primary', type: 'button', 'data-k': `a-${row.key}`, onclick: () => toast(`Opens the Merge request screen of ${row.key}`) }, row.action)));
    if (DATA.done.includes(row)) li.append(h('div', { class: 'act' }, h('button', { class: 'linkish', type: 'button', 'data-k': `ar-${row.key}`, onclick: () => { DATA.done.splice(DATA.done.indexOf(row), 1); S.archived += 1; toast(`${row.key} archived`); render(); } }, 'Archive')));
    return li;
  }
  function renderBoard() {
    const tpl = [];
    const cols = h('div', { class: 'cols' }, COLS.map(([id, label]) => {
      const rows = DATA[id].filter(visible);
      const folded = S.fold.has(id);
      const empty = rows.length === 0;
      // An empty or folded column gets a slim track; columns with cards share the rest.
      tpl.push(empty || folded ? 'minmax(130px, 0.5fr)' : 'minmax(0, 1fr)');
      let list;
      if (id === 'queue' && !empty) {
        const q = rows.filter((r) => r.queued);
        const n = rows.filter((r) => !r.queued);
        list = h('ul', {}, h('li', { class: 'qsec' }, `In the queue (${q.length})`), q.length ? q.map(queueCard) : h('li', { class: 'empty' }, 'Add to queue starts a ticket by itself when a slot frees.'),
          n.length ? [h('li', { class: 'qsec' }, `Not queued (${n.length})`), n.map(queueCard)] : null);
      } else {
        list = h('ul', {}, empty ? h('li', { class: 'empty' }, EMPTY[id]) : rows.map(id === 'queue' ? queueCard : jobCard));
      }
      return h('section', { class: `col ${id}${empty ? ' empty-col' : ''}${folded ? ' folded' : ''}${id === 'you' && !empty ? ' has' : ''}`, 'aria-label': label },
        h('h2', {}, h('button', { class: 'colfold', type: 'button', 'data-k': `fold-${id}`, 'aria-expanded': String(!folded), onclick: () => { folded ? S.fold.delete(id) : S.fold.add(id); render(); } },
          label, h('span', { class: 'n' }, rows.length))), list);
    }));
    cols.style.setProperty('--tpl', tpl.join(' '));
    const hint = S.filter ? h('div', { class: 'bhead' }, h('span', { class: 'muted' }, 'Showing'), h('span', { style: 'display:inline-flex;gap:6px;align-items:center;overflow-wrap:anywhere' }, dot(S.filter), h('b', {}, S.filter)),
      h('button', { class: 'linkish', type: 'button', 'data-k': 'clear', onclick: () => setFilter('') }, 'Show all workspaces')) : null;
    return [hint, cols];
  }
  function renderMain() {
    const main = document.getElementById('main');
    if (S.view === 'board') { main.replaceChildren(...renderBoard().filter(Boolean)); return; }
    const label = PAGES.find(([p]) => p === S.view)[1];
    main.replaceChildren(h('div', { class: 'page' }, h('h1', {}, label),
      h('p', { class: 'muted', style: 'margin:0' }, 'This page is not part of the prototype: it shows how the header behaves away from the board. What would change on this page:'),
      h('div', { class: 'card2' }, h('ol', {}, PAGE_NOTES[S.view].map((t) => h('li', {}, t)))),
      h('div', {}, h('button', { class: 'btn', type: 'button', 'data-k': 'back', onclick: () => go('board') }, '← Board'), ' ', h('span', { class: 'kbd' }, 'Esc'))));
  }

  // ---------- New ticket ----------
  function ticketForm(done) {
    const ws = h('select', { id: 'f-ws' }, WS.map((w) => h('option', { value: w.name, selected: (S.filter || 'software-factory') === w.name }, w.name)));
    const key = h('input', { id: 'f-key', value: `ACME-${S.seq}`, autocomplete: 'off', spellcheck: 'false' });
    const title = h('input', { id: 'f-title', placeholder: 'One line', autocomplete: 'off', required: true });
    const req = h('textarea', { id: 'f-req', rows: '5' });
    return h('form', { class: 'form', onsubmit: (e) => {
      e.preventDefault();
      DATA.queue.push({ key: key.value.trim() || `ACME-${S.seq}`, ws: ws.value, title: title.value.trim() || 'Untitled ticket', queued: false, check: 'draft' });
      S.seq += 1; done();
      toast(`${key.value} created: its conversation writes the plan`);
      render();
    } },
    h('div', { class: 'row2' }, h('div', { class: 'fld' }, h('label', { for: 'f-ws' }, 'Workspace'), ws), h('div', { class: 'fld' }, h('label', { for: 'f-key' }, 'Ticket key'), key)),
    h('div', { class: 'fld' }, h('label', { for: 'f-title' }, 'Title'), title),
    h('div', { class: 'fld' }, h('label', { for: 'f-req' }, 'What you want, in your words'), req, h('p', { class: 'hint' }, 'Opens the planning conversation; paste screenshots here (Ctrl+V).')),
    h('div', { class: 'frow' }, h('button', { class: 'btn', type: 'button', onclick: done }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Create the ticket')));
  }
  function openNew() {
    S.pop = null; S.railOpen = false;
    if (S.v === '3') { S.drawer = 'new'; render(); document.getElementById('f-title')?.focus(); return; }
    const dlg = document.getElementById('nt');
    dlg.replaceChildren(h('h2', { id: 'nt-title', style: 'margin:0 0 12px;font-size:18px' }, 'New ticket'), ticketForm(() => dlg.close()));
    render();
    dlg.showModal();
    document.getElementById('f-title').focus();
  }

  // ---------- Prototype switcher ----------
  function renderProto() {
    const names = { 1: 'Top bar', 2: 'Left rail', 3: 'Status bar' };
    const link = (v) => h('a', { href: `?v=${v}${S.down ? '' : '&h=ok'}${location.hash}`, 'aria-current': String(S.v === String(v)), title: names[v] }, `${v}`, h('span', { class: 'lng' }, ` ${names[v]}`));
    const theme = document.documentElement.dataset.theme || 'auto';
    document.getElementById('proto').replaceChildren(h('b', {}, 'PROTOTYPE'), link(1), link(2), link(3), h('span', { class: 'sep' }),
      h('button', { type: 'button', title: 'Toggle a failing health check', onclick: () => { S.down = !S.down; render(); } }, S.down ? 'Health: 1 down' : 'Health: ok'),
      h('button', { type: 'button', title: 'Theme', onclick: () => {
        const next = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
        if (next === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
        render();
      } }, h('span', { class: 'lng' }, 'Theme: '), theme));
  }

  // ---------- Render ----------
  function render() {
    const k = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : undefined;
    document.body.className = `v${S.v}${S.v === '2' && !narrowMq.matches && S.rail === 'slim' ? ' rail-slim' : ''}${S.railOpen ? ' rail-open' : ''}`;
    renderRail(); renderHeader(); renderMain(); renderStatus(); renderDrawer(); renderProto();
    const hdr = document.getElementById('hdr');
    document.documentElement.style.setProperty('--hdr-h', `${Math.round(hdr.getBoundingClientRect().height)}px`);
    const pop = document.querySelector('.pop');
    if (pop && matchMedia('(max-width: 560px)').matches) {
      const r = pop.parentElement.firstElementChild.getBoundingClientRect();
      pop.style.top = `${Math.round(r.bottom + 6)}px`;
      pop.style.maxHeight = `calc(100vh - ${Math.round(r.bottom + 90)}px)`;
    }
    if (k) { const n = document.querySelector(`[data-k="${CSS.escape(k)}"]`); if (n) n.focus({ preventScroll: true }); }
    document.title = `${DATA.you.length ? `(${DATA.you.length}) ` : ''}Software Factory`;
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest ? e.target.closest('[data-pop]') : null;
    if (t) { S.pop = S.pop === t.dataset.pop ? null : t.dataset.pop; render(); return; }
    if (S.pop && !(e.target.closest && e.target.closest('.pop'))) { S.pop = null; render(); }
  });
  document.getElementById('scrim').addEventListener('click', () => { S.railOpen = false; S.drawer = null; render(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || document.getElementById('nt').open) return;
    if (S.pop) S.pop = null;
    else if (S.railOpen) S.railOpen = false;
    else if (S.drawer) S.drawer = null;
    else if (S.view !== 'board') { go('board'); return; }
    else return;
    render();
  });
  narrowMq.addEventListener('change', () => { S.railOpen = false; render(); });
  addEventListener('hashchange', () => { S.view = pageOf(); render(); });
  render();
  // ?probe=1: the page's width and errors as attributes, for a headless check.
  if (params.get('probe')) setTimeout(() => { document.body.dataset.sw = `${document.documentElement.scrollWidth}/${innerWidth}`; }, 50);
})();
