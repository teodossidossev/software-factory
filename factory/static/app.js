// Software Factory dashboard v1: read-only. Loads api/jobs, follows one job through
// api/stream (server-sent events) and renders it. Every value goes in through textContent.
'use strict';

const RECONNECT_MS = 3000;
const $ = (id) => document.getElementById(id);

const state = {
  jobs: [],
  key: null, // "<ws>/<ticket>" of the selected job
  detail: null,
  iteration: null, // selected iteration number
  view: 'report',
  cache: new Map(), // "<n>/<view>" -> text, for the selected job
  source: null,
  retry: null,
  lastLine: -1,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

const keyOf = (job) => `${job.workspace}/${job.ticket}`;
const jobPath = (key) => key.split('/').map(encodeURIComponent).join('/');
const shortTime = (ts) => (typeof ts === 'string' ? ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '');

async function getText(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return response.text();
}

function setConnection(text, kind) {
  const node = $('connection');
  node.textContent = text;
  node.className = `connection ${kind}`;
}

function renderJobs() {
  const list = $('job-list');
  $('no-jobs').hidden = state.jobs.length > 0;
  const sorted = [...state.jobs].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  list.replaceChildren(...sorted.map((job) => {
    const button = el('button');
    button.type = 'button';
    button.setAttribute('aria-current', String(keyOf(job) === state.key));
    button.append(el('div', 'job-name', keyOf(job)));
    const line = el('div', 'job-line');
    line.append(el('span', `badge s-${job.state}`, job.state), el('span', '', `iter ${job.iteration}`));
    button.append(line);
    button.addEventListener('click', () => select(keyOf(job)));
    const item = el('li');
    item.append(button);
    return item;
  }));
}

function mostRecent() {
  return [...state.jobs].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

function renderHeader(detail) {
  const job = detail.job;
  $('job-ticket').textContent = job.ticket;
  const badge = $('job-state');
  badge.textContent = job.state;
  badge.className = `badge s-${job.state}`;
  $('job-branch').textContent = job.branch;
  $('job-base').textContent = job.base;
  $('job-iteration').textContent = job.mr_attempts > 0 ? `${job.iteration} (MR attempts ${job.mr_attempts})` : String(job.iteration);
  const costs = detail.iterations.map((iteration) => iteration.cost_usd).filter((cost) => typeof cost === 'number');
  // An estimate of the API-equivalent price, not a charge: the session usually runs on a subscription.
  $('job-cost').textContent = costs.length > 0 ? `est. $${costs.reduce((sum, cost) => sum + cost, 0).toFixed(4)}` : 'n/a';
  $('job-updated').textContent = shortTime(job.updated_at);
  const error = $('job-error');
  error.hidden = job.error === null;
  error.textContent = job.error === null ? '' : `${job.error.code}: ${job.error.message}`;
}

function renderHistory(history) {
  $('history').replaceChildren(...history.map((entry) => {
    const item = el('li');
    item.append(el('time', '', shortTime(entry.ts)), document.createTextNode(`${entry.from ?? '-'} → ${entry.to}`));
    if (entry.error) {
      item.append(el('span', 'history-error', ` (${entry.error.code}: ${entry.error.message})`));
    }
    return item;
  }));
}

function renderIterationTabs(iterations) {
  $('no-iterations').hidden = iterations.length > 0;
  $('iteration-views').hidden = iterations.length === 0;
  $('iteration-tabs').replaceChildren(...iterations.map((iteration) => {
    const button = el('button', '', `Iteration ${iteration.number}`);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(iteration.number === state.iteration));
    button.addEventListener('click', () => {
      state.iteration = iteration.number;
      renderIterationTabs(state.detail.iterations);
      void showIteration();
    });
    return button;
  }));
  for (const button of $('iteration-views').querySelectorAll('button')) {
    button.setAttribute('aria-selected', String(button.dataset.view === state.view));
  }
}

// Report: preformatted, Markdown headings bold.
function renderReport(text) {
  return text.split('\n').map((line) => el('span', /^#{1,6}\s/.test(line) ? 'heading' : '', `${line}\n`));
}

// Patch: preformatted, + and - lines coloured, file headers bold.
function renderPatch(text) {
  return text.split('\n').map((line) => {
    let className = '';
    if (/^(diff --git |\+\+\+ |--- |index |new file mode |deleted file mode |rename |similarity |Binary files )/.test(line)) {
      className = 'file';
    } else if (line.startsWith('@@')) {
      className = 'hunk';
    } else if (line.startsWith('+')) {
      className = 'add';
    } else if (line.startsWith('-')) {
      className = 'del';
    }
    return el('span', className, `${line}\n`);
  });
}

async function showIteration() {
  const key = state.key;
  const body = $('iteration-body');
  const meta = state.detail?.iterations.find((iteration) => iteration.number === state.iteration);
  if (meta === undefined) {
    body.replaceChildren();
    $('iteration-meta').textContent = '';
    return;
  }
  const cost = typeof meta.cost_usd === 'number' ? `$${meta.cost_usd.toFixed(4)}` : 'n/a';
  $('iteration-meta').textContent = `${shortTime(meta.started_at)} – ${shortTime(meta.ended_at)}, cost ${cost}, ` +
    `${meta.changed_files} changed file(s), ${meta.denials} denial(s)${meta.patch_truncated ? ', patch truncated' : ''}`;
  const cacheKey = `${meta.number}/${state.view}`;
  let text = state.cache.get(cacheKey);
  if (text === undefined) {
    try {
      text = await getText(`api/jobs/${jobPath(key)}/iterations/${meta.number}/${state.view}`);
    } catch (error) {
      text = `Could not load: ${error.message}`;
    }
    if (key !== state.key) {
      return;
    }
    state.cache.set(cacheKey, text);
  }
  if (cacheKey === `${state.iteration}/${state.view}`) {
    body.replaceChildren(...(state.view === 'patch' ? renderPatch(text) : renderReport(text)));
  }
}

async function showMr() {
  const key = state.key;
  const panel = $('mr-panel');
  if (!state.detail?.mr) {
    panel.hidden = true;
    return;
  }
  let text;
  try {
    text = await getText(`api/jobs/${jobPath(key)}/mr`);
  } catch (error) {
    text = `Could not load: ${error.message}`;
  }
  if (key === state.key) {
    $('mr-body').replaceChildren(...renderReport(text));
    panel.hidden = false;
  }
}

function renderDetail(detail) {
  const previous = state.detail;
  state.detail = detail;
  $('detail').hidden = false;
  const numbers = detail.iterations.map((iteration) => iteration.number);
  const newest = numbers.length > 0 ? numbers[numbers.length - 1] : null;
  // Follow the newest iteration unless the user picked an older one.
  const wasNewest = previous === null || state.iteration === null ||
    state.iteration === previous.iterations[previous.iterations.length - 1]?.number;
  if (wasNewest || !numbers.includes(state.iteration)) {
    state.iteration = newest;
  }
  renderHeader(detail);
  renderHistory(detail.history);
  renderIterationTabs(detail.iterations);
  void showIteration();
  void showMr();
}

function appendEvent(event) {
  const events = $('events');
  const block = el('div', `event t-${event.type}`, event.text);
  events.append(block);
  if ($('follow').checked) {
    events.scrollTop = events.scrollHeight;
  }
}

function closeStream() {
  clearTimeout(state.retry);
  state.retry = null;
  if (state.source !== null) {
    state.source.close();
    state.source = null;
  }
}

function openStream() {
  closeStream();
  const params = new URLSearchParams();
  if (state.key !== null) {
    params.set('job', state.key);
    params.set('from', String(state.lastLine + 1));
  }
  const key = state.key;
  const source = new EventSource(`api/stream?${params}`);
  state.source = source;
  source.addEventListener('open', () => setConnection('live', 'live'));
  source.addEventListener('jobs', (message) => {
    state.jobs = JSON.parse(message.data).jobs;
    renderJobs();
    if (state.key === null && state.jobs.length > 0) {
      select(keyOf(mostRecent()));
    }
  });
  source.addEventListener('job', (message) => {
    if (key === state.key) {
      renderDetail(JSON.parse(message.data));
    }
  });
  source.addEventListener('event', (message) => {
    const event = JSON.parse(message.data);
    if (key === state.key && event.line > state.lastLine) {
      state.lastLine = event.line;
      appendEvent(event);
    }
  });
  source.addEventListener('error', () => {
    // Reconnect ourselves after 3 s, resuming after the last line seen.
    source.close();
    if (state.source === source) {
      state.source = null;
      setConnection('reconnecting', 'down');
      state.retry = setTimeout(openStream, RECONNECT_MS);
    }
  });
}

function select(key) {
  if (key === state.key && state.source !== null) {
    return;
  }
  state.key = key;
  state.detail = null;
  state.iteration = null;
  state.cache = new Map();
  state.lastLine = -1;
  $('events').replaceChildren();
  $('iteration-body').replaceChildren();
  $('mr-panel').hidden = true;
  $('follow').checked = true;
  history.replaceState(null, '', `#${key}`);
  renderJobs();
  openStream();
}

function init() {
  for (const button of $('iteration-views').querySelectorAll('button')) {
    button.addEventListener('click', () => {
      state.view = button.dataset.view;
      renderIterationTabs(state.detail?.iterations ?? []);
      void showIteration();
    });
  }
  const events = $('events');
  events.addEventListener('scroll', () => {
    // Scrolling up switches follow off; the checkbox turns it on again.
    if (events.scrollTop + events.clientHeight < events.scrollHeight - 8) {
      $('follow').checked = false;
    }
  });
  $('follow').addEventListener('change', () => {
    if ($('follow').checked) {
      events.scrollTop = events.scrollHeight;
    }
  });
  window.addEventListener('hashchange', () => {
    const key = decodeURIComponent(location.hash.slice(1));
    if (key !== '' && key !== state.key && state.jobs.some((job) => keyOf(job) === key)) {
      select(key);
    }
  });

  load();
}

function load() {
  getText('api/jobs').then((text) => {
    state.jobs = JSON.parse(text).jobs;
    renderJobs();
    const wanted = decodeURIComponent(location.hash.slice(1));
    const job = state.jobs.find((candidate) => keyOf(candidate) === wanted) ?? mostRecent();
    if (job !== undefined) {
      select(keyOf(job));
    } else {
      openStream();
    }
  }, () => {
    setConnection('reconnecting', 'down');
    state.retry = setTimeout(load, RECONNECT_MS);
  });
}

document.addEventListener('DOMContentLoaded', init);
