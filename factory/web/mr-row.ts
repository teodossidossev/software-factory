// mr-row.js, the dashboard's script after reports.js (DASHBOARD_SCRIPTS in src/dashboard.ts), built
// from web/mr-row.ts into dist/web/: mrRow, one compact row of an open merge request (its title, the
// link to the host, its branches, its pipeline, whether it is ready to merge, whether it must be
// rebased, SonarQube's verdict when it found a problem, and its comments button). It reads no page
// state and uses only core.js's helpers, so any page can draw the same rows. Every host text is set
// as text, never as HTML, and only an http(s) URL becomes a link. A classic script, loaded in order
// with defer, sharing the page's globals with the others. This file has no import or export on
// purpose: the compiler keeps it a script, so its top-level names stay the page's globals.
'use strict';

// A badge's colour: green, red, amber or grey (app.css .mq-badge).
type MrBadgeTone = 'ok' | 'bad' | 'warn' | 'grey';

// A link that opens url in a new tab, only when url is an http(s) one; else a span, or null without
// a fallback class.
function mrRowLink(className: string, text: string, url: string | null, fallback: boolean): HTMLElement | null {
  if (url === null || !/^https?:\/\//i.test(url)) {
    return fallback ? el('span', className, text) : null;
  }
  const link = el('a', className, text);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

// A badge with its text, a link when url is an http(s) one.
function mrBadge(tone: MrBadgeTone, text: string, url: string | null = null, title?: string): HTMLElement {
  const badge = mrRowLink(`mq-badge ${tone}`, text, url, true)!;
  if (title !== undefined) {
    badge.setAttribute('title', title);
  }
  return badge;
}

// The pipeline's badge: passed, failed, running, or the host's own word.
function mrPipelineBadge(pipeline: NonNullable<MergeRequestOverview['pipeline']>): HTMLElement {
  const tone: MrBadgeTone = pipeline.state === 'passed' ? 'ok' : pipeline.state === 'failed' ? 'bad' : pipeline.state === 'running' ? 'warn' : 'grey';
  return mrBadge(tone, pipeline.state === 'other' ? pipeline.text : pipeline.state, pipeline.url, `Pipeline: ${pipeline.text}`);
}

// The readiness badge: ready, not ready and why, or the host still deciding.
function mrReadyBadge(overview: MergeRequestOverview): HTMLElement {
  if (overview.ready === true) {
    return mrBadge('ok', 'Ready to merge');
  }
  if (overview.ready === null) {
    return mrBadge('grey', 'Checking mergeability');
  }
  return mrBadge('warn', overview.reasons.length === 0 ? 'Not ready' : `Not ready: ${overview.reasons.join('; ')}`);
}

// SonarQube's badge, only when it found a problem.
function mrSonarBadge(sonar: NonNullable<MergeRequestOverview['sonar']>): HTMLElement {
  const issues = sonar.new_issues !== null && sonar.new_issues >= 1 ? counted(sonar.new_issues, 'new issue') : null;
  const text = sonar.gate_failed ? (issues === null ? 'Sonar: gate failed' : `Sonar: gate failed, ${issues}`) : `Sonar: ${issues ?? ''}`;
  return mrBadge('bad', text, sonar.url);
}

// One open merge request as a row. overview: its overview, 'reading' while it is read, or the
// factory's refusal. expanded: whether its comments are shown under it; onToggle expands or
// collapses it (its title and its comments button, which carries data-mq="request:<number>").
function mrRow(request: OpenMergeRequest, overview: MergeRequestOverview | 'reading' | { error: string }, expanded: boolean, onToggle: () => void): HTMLElement {
  const row = el('div', expanded ? 'mq-row on' : 'mq-row');
  const head = el('span', 'mq-rhead');
  const title = button('mq-title', `!${request.number} ${request.title}`, { mq: `title:${request.number}` });
  const updated = localTime(request.updated_at);
  title.setAttribute('title', `${request.author}${updated === '' ? '' : ` · updated ${updated}`}`);
  title.setAttribute('aria-expanded', String(expanded));
  title.addEventListener('click', onToggle);
  head.append(title);
  const open = mrRowLink('mq-open', '↗', request.url, false);
  if (open !== null) {
    open.setAttribute('title', 'Open on the host');
    open.setAttribute('aria-label', `Open !${request.number} on the host`);
    head.append(open);
  }
  const branches = el('span', 'mq-branches', `${request.source} → ${request.target}`);
  const status = el('span', 'mq-status');
  let comments = 'Comments';
  if (overview === 'reading') {
    status.append(el('span', 'muted', 'Reading status…'));
  } else if ('error' in overview) {
    status.append(el('span', 'muted', `Status unavailable: ${overview.error}`));
  } else {
    if (overview.pipeline !== null) {
      status.append(mrPipelineBadge(overview.pipeline));
    }
    status.append(mrReadyBadge(overview));
    if (overview.behind !== null && overview.behind >= 1) {
      status.append(mrBadge('bad', `Rebase needed: ${overview.behind} behind ${request.target}`));
    }
    if (overview.sonar !== null) {
      status.append(mrSonarBadge(overview.sonar));
    }
    comments = overview.comments.human === 0 ? 'No comments' : counted(overview.comments.human, 'comment');
  }
  const toggle = button('mq-comments', comments, { mq: `request:${request.number}` });
  toggle.setAttribute('aria-expanded', String(expanded));
  if (typeof overview === 'object' && !('error' in overview) && overview.comments.bot >= 1) {
    toggle.setAttribute('title', `${counted(overview.comments.bot, 'bot comment')} hidden`);
  }
  toggle.addEventListener('click', onToggle);
  row.append(head, branches, status, toggle);
  return row;
}
