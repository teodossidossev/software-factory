// job-screens.js, the dashboard's second script (DASHBOARD_SCRIPTS in src/dashboard.ts): what the
// job page reads, the Task check, the Changes screen, the Merge request screen and the Stream. A
// classic script, loaded in order with defer, sharing the page's globals with the others.
'use strict';

// ---------- The job page (SF-078): what its header, Stream, stop block and composer read ----------

const verdictOf = (record) => (record === null || record === undefined ? null : typeof record.error === 'string' ? 'failed' : record.verdict);
const iterationOf = (detail, number) => detail.iterations.find((iteration) => iteration.number === number) ?? null;
// "10:05" of a timestamp, local time.
const clock = (ts) => localTime(ts).slice(11, 16);

// Whether the Claude review runs on the job (SF-131): its claude_review, true when absent.
const claudeOn = (job) => job?.claude_review !== false;

// The Codex items the gate asked for on the job's last iteration, or its error: what Accept and
// prepare MR goes without. ran is false when no gate ran on it (the budget was used up first).
function gateLeftovers(detail) {
  if (detail.job.stop_group === 'limit') {
    return limitLeftovers(detail);
  }
  if (detail.job.stop_group === 'ledger') {
    return { items: ledgerOpen(detail), error: null, ran: true, ledger: true };
  }
  const gate = iterationOf(detail, detail.job.iteration)?.gate ?? null;
  if (gate === null) {
    return { items: [], error: null, ran: false };
  }
  return typeof gate.error === 'string' ? { items: [], error: gate.error, ran: true } : { items: gate.items ?? [], error: null, ran: true };
}

// The ledger's findings an Accept over a ledger stop goes without (SF-052): open entries, the
// fixes the user decided and the disputed contests.
function ledgerOpen(detail) {
  return (detail.ledger ?? []).filter((entry) => entry.status === 'open' || entry.status === 'user_fix' || (entry.status === 'contested' && entry.dispute !== null));
}

// What an Accept at the Fix round limit goes without (SF-115), as the factory's #ledgerUnapplied
// decides it: the ledger's open entries alone (SF-131: the refused Fix wrote its items there), no
// fix the user decided and no disputed contest.
function limitLeftovers(detail) {
  return { items: (detail.ledger ?? []).filter((entry) => entry.status === 'open'), error: null, ran: true, limit: true };
}

// The suggestions the simplification pass offers on the job's last iteration (SF-055), for the
// stop block and the confirmations of Simplify and of Skip (accept).
function offeredSuggestions(detail) {
  const record = iterationOf(detail, detail?.job?.iteration)?.simplify ?? null;
  return { items: Array.isArray(record?.suggestions) ? record.suggestions : [], suggestions: true };
}

// The user's override of the gate that still stands (SF-047): the newest gate-override.json, unless
// a later iteration was reviewed by the gate again; null when there is none.
function standingOverride(detail) {
  for (const iteration of [...detail.iterations].reverse()) {
    if (iteration.gate_override !== null && iteration.gate_override !== undefined) {
      return iteration.gate_override;
    }
    if (iteration.gate !== null && iteration.gate !== undefined) {
      return null;
    }
  }
  return null;
}

// The notice of a paused job whose Task file changed since the Implementer was last given it (SF-067).
const TASK_CHANGED = 'Task file changed since the job started: Resume hands the change to the Implementer and the reviewers.';

// What moves a paused job on (SF-067), after "Paused by you during iteration N".
function pausedNext(job) {
  const step = job.paused?.step;
  const again = step === 'turn' ? 'Resume continues the same session (with your message, if you write one below)'
    : ['review', 'gate', 'simplify'].includes(step) ? 'Resume runs it again' : 'Resume goes on';
  return `${again}; Restart starts the ticket again from its current Task file`;
}

// What moves a job parked on a usage limit on (SF-072).
function parkedNext(job) {
  const turn = job.paused?.from === 'working';
  if (job.limit?.reset_seen === true) {
    return `Resume now goes on${turn ? ' (with your message, if you write one below)' : ''}`;
  }
  return `The factory resumes it then; Resume now goes on before the reset${turn ? ' (with your message, if you write one below)' : ''}`;
}

// The sentence of the job page's header and composer: sentence(), and for a paused or parked job
// what moves it on.
const headSentence = (job) => (job.state === 'paused' ? `${sentence(job)}. ${pausedNext(job)}`
  : job.state === 'waiting_limit' ? `${sentence(job)}. ${parkedNext(job)}` : sentence(job));

// A parked job's reset time (SF-072), HH:MM in local time, or null.
const limitClock = (job) => (typeof job.limit?.resets_at === 'string' ? clock(job.limit.resets_at) : null);
const LIMIT_PROVIDERS = { claude: 'Claude', codex: 'Codex' };

// A merge request's URL as a link when it is https, else as text.
function mrLink(mr) {
  if (typeof mr.url === 'string' && /^https:\/\/[^\s]+$/.test(mr.url)) {
    const link = el('a', 'mono', mr.url);
    link.href = mr.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }
  return el('span', 'mono', String(mr.url));
}

// What the host said of the merge request: "open, mergeable, checks 2 passed" or why not.
function mrStatusText(status) {
  const parts = [`#${status.number} ${status.state}${status.draft ? ' (draft)' : ''}`];
  if (status.state === 'open') {
    parts.push(status.mergeable === true ? 'mergeable' : status.mergeable === false ? `not mergeable: ${status.reason ?? 'no reason given'}` : `mergeable not known yet${status.reason ? ` (${status.reason})` : ''}`);
  }
  if (typeof status.checks === 'string') {
    parts.push(`checks: ${status.checks}`);
  }
  return `On the host: ${parts.join(', ')}.`;
}

// ---------- Task check (SF-054) ----------

// The last check of a ticket, as the implement prompt's Task toggle shows it (the planned ticket
// page has its own Plan check card, SF-081):
// the stale mark and the verdict, the paraphrase above the findings (by severity), then the
// expected files.
function renderCheck(view) {
  const box = [];
  const record = view.check;
  // A Task that needs no check (SF-130): the view says why.
  if (typeof view.check_reason === 'string' && !view.running) {
    box.push(el('p', 'check-head', `Task check: not needed: ${view.check_reason}.`));
    return box;
  }
  if (record === null) {
    box.push(el('p', 'check-head', view.running ? 'Task check: running…' : 'Task check: not checked yet. Check on the ticket\'s card runs it; it only advises.'));
    return box;
  }
  const output = record.output;
  const counts = tkCounts(output);
  const verdict = output === null ? 'check failed' : output.verdict === 'ready' ? 'ready' : `not ready: ${counts.blocker} blocker, ${counts.major} major`;
  const head = el('p', 'check-head');
  head.append(document.createTextNode(`Task check: ${verdict} · `), timeEl(record.ended_at), document.createTextNode(` · ${record.model ?? 'default model'}${view.running ? ' · a new check is running…' : ''}`));
  box.push(head);
  if (view.stale) {
    box.push(el('p', 'check-stale', 'Stale: the Task file changed since this check.'));
  }
  if (output === null) {
    box.push(el('p', 'check-error', record.error ?? 'The check failed.'));
    return box;
  }
  box.push(el('h4', 'check-title', 'Paraphrase'), el('p', 'check-paraphrase', output.paraphrase));
  box.push(el('h4', 'check-title', 'Findings'));
  for (const severity of ['blocker', 'major', 'nit']) {
    const items = output.findings.filter((item) => item.severity === severity);
    if (items.length === 0) {
      continue;
    }
    box.push(el('p', `check-severity s-${severity}`, `${severity} (${items.length})`));
    const list = el('ul', 'check-findings');
    list.append(...items.map((item) => {
      const entry = el('li');
      entry.append(el('span', 'check-kind', item.kind), document.createTextNode(' '), el('code', '', item.where), document.createTextNode(`: ${item.problem} Expected: ${item.expected}`));
      return entry;
    }));
    box.push(list);
  }
  if (output.findings.length === 0) {
    box.push(el('p', 'hint', 'None.'));
  }
  if (output.files.length > 0) {
    box.push(el('h4', 'check-title', 'Files'));
    const files = el('ul', 'check-files');
    files.append(...output.files.map((file) => {
      const entry = el('li');
      entry.append(document.createTextNode(`${file.action} `), el('code', '', file.path));
      return entry;
    }));
    box.push(files);
  }
  return box;
}

// A ticket's last check as the factory has it; null when it has none to show (no Task checks, no
// Task file).
async function readCheck(key) {
  try {
    return JSON.parse(await getText(`api/tickets/${jobPath(key)}/check`));
  } catch {
    return null;
  }
}

// Check: one request per ticket at a time; the card shows the check running, then its verdict.
async function checkTicket(row) {
  const key = `${row.workspace}/${row.ticket}`;
  await setupRequest(`check:${key}`, `api/tickets/${jobPath(key)}/check`, {}, 'toast', () =>
    ({ level: 'ok', text: `Checking ${key}: a read-only Claude session reads the Task file and the repository; the card shows the verdict when it ends. It only advises: Start stays yours.` }));
}

// ---------- The Changes screen (SF-079): the prototype's file tree, diff pane and iteration selector ----------

// Report: preformatted, Markdown headings bold (the Stream's changes entries and the MR text).
function renderReport(text) {
  return text.split('\n').map((line) => el('span', /^#{1,6}\s/.test(line) ? 'heading' : '', `${line}\n`));
}

// The Report or the Patch of an iteration, loaded once per job; undefined when the selection
// changed while it loaded.
async function iterationText(key, number, view) {
  const cacheKey = `${number}/${view}`;
  let text = state.cache.get(cacheKey);
  if (text === undefined) {
    try {
      text = await getText(`api/jobs/${jobPath(key)}/iterations/${number}/${view}`);
    } catch (error) {
      text = `Could not load: ${error.message}`;
    }
    if (key !== state.key) {
      return undefined;
    }
    state.cache.set(cacheKey, text);
  }
  return text;
}

// localStorage as the prototype's store: a browser that refuses it keeps the default.
const store = {
  get(name) {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  set(name, value) {
    try {
      localStorage.setItem(name, value);
    } catch {
      // none
    }
  },
};
const DIFF_MODE_KEY = 'sf-diff-mode';
// SF-119: a phone (below 768 px), and a phone or a device without hover (app.css has the same
// two queries). Without matchMedia (the test stand-in) neither applies.
const NARROW_QUERY = '(max-width: 767px)';
const TOUCH_QUERY = '(max-width: 767px), (hover: none)';
const media = (query) => typeof matchMedia === 'function' && matchMedia(query).matches === true;
// SF-119: below 768 px the diff is unified, whatever was chosen; the choice stays stored for a
// wider window.
const diffLayout = () => (media(NARROW_QUERY) ? 'uni' : ui.cx.mode);

// Reads path into map at id once; done runs when it arrives for the same job's data.
function cxGet(map, id, path, done) {
  if (map.has(id)) {
    return map.get(id);
  }
  map.set(id, 'loading');
  const data = state.cx;
  getText(path).then((text) => JSON.parse(text)).catch((error) => ({ error: error.message })).then((value) => {
    if (state.cx === data && map.get(id) === 'loading') {
      map.set(id, value);
      done();
    }
  });
  return 'loading';
}

// The index of the job's iterations, read again when the job's iteration or state changes (a new
// iteration, a rebase); the one read before stays shown until the new one arrives. A new index
// whose bases differ from the old one's drops the lists and sides read against them.
function cxIndex() {
  const job = shownJob();
  const data = state.cx;
  const stamp = `${job.iteration}|${job.state}`;
  if (data.stamp !== stamp && data.loading !== stamp) {
    data.loading = stamp;
    const key = state.key;
    getText(`api/jobs/${jobPath(key)}/changes`).then((text) => JSON.parse(text)).catch((error) => ({ error: error.message })).then((index) => {
      if (state.cx !== data || data.loading !== stamp) {
        return;
      }
      const bases = (value) => (Array.isArray(value?.iterations) ? value.iterations.map((iteration) => iteration.base_commit) : []);
      const fresh = bases(index);
      if (bases(data.index).some((base, at) => fresh[at] !== base)) {
        data.lists.clear();
        data.sides.clear();
        data.diffs.clear();
      }
      data.loading = null;
      data.stamp = stamp;
      data.index = index;
      if (ui.screen === 'changes' && ui.job === key) {
        renderChanges(data.focusTree || ($('tlist')?.contains(document.activeElement) ?? false));
      }
    });
  }
  return data.index;
}

function itersOf() {
  const index = state.cx.index;
  return index !== null && Array.isArray(index.iterations) ? index.iterations : [];
}

// The pair of a view: All changes is the last iteration's base against it, Iteration 1 its base
// against it, Iteration N iteration N - 1 against N.
function viewPair(view) {
  const its = itersOf();
  const to = view === 'all' ? its[its.length - 1].n : view;
  return [view === 'all' || to === 1 ? 'base' : to - 1, to];
}

// The file list of a view: 'loading', { error } or { files, more }.
function listOf(view) {
  const [from, to] = viewPair(view);
  return cxGet(state.cx.lists, `${from}|${to}`, `api/jobs/${jobPath(state.key)}/changes?from=${from}&to=${to}`, () => {
    if (ui.screen === 'changes') {
      renderChanges(state.cx.focusTree);
    }
  });
}

function changeSet(view) {
  const list = itersOf().length === 0 ? null : listOf(view ?? 'all');
  return list !== null && Array.isArray(list.files) ? list.files : [];
}

// The two sides of a view, as the file route names them: "base:<N>" (the base of iteration N) or "<N>".
function sidesOf(view) {
  const [from, to] = viewPair(view);
  return [from === 'base' ? `base:${to}` : String(from), String(to)];
}

function sideOf(side, path) {
  const [at, of] = side.startsWith('base:') ? ['base', side.slice(5)] : [side, null];
  return cxGet(state.cx.sides, `${side}|${path}`, `api/jobs/${jobPath(state.key)}/file?at=${at}${of === null ? '' : `&of=${of}`}&path=${encodeURIComponent(path)}`, () => {
    if (ui.screen === 'changes') {
      renderDiffPane();
    }
  });
}

// The lines of one side ("<side>|<path>"): none when the file is absent there.
const linesOf = (id) => {
  const version = state.cx.sides.get(id);
  if (version?.kind !== 'text') {
    return [];
  }
  const ls = version.text.split('\n');
  if (ls.length && ls[ls.length - 1] === '') {
    ls.pop();
  }
  return ls;
};

// ---- line diff (Myers, with common prefix and suffix trimmed first), the prototype's. One change:
// off is max + 1 (the prototype's max), so the trace's slice at d = max starts at 0, not at -1 (a
// one-line replacement read the wrong trace).
function myers(A, B) {
  const N = A.length, M = B.length;
  if (!N) return B.map((_, j) => ['+', -1, j]);
  if (!M) return A.map((_, i) => ['-', i, -1]);
  const max = N + M, off = max + 1, V = new Int32Array(2 * max + 3), trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > 2500) return [...A.map((_, i) => ['-', i, -1]), ...B.map((_, j) => ['+', -1, j])];
    trace.push(V.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      V[off + k] = x;
      if (x >= N && y >= M) {
        const ops = []; let cx = N, cy = M;
        for (let dd = d; dd >= 0; dd--) {
          const v = trace[dd], at = (kk) => v[kk + dd + 1];
          const kk = cx - cy;
          const pk = (kk === -dd || (kk !== dd && at(kk - 1) < at(kk + 1))) ? kk + 1 : kk - 1;
          const px = dd === 0 ? 0 : at(pk), py = px - pk;
          while (cx > px && cy > py) { ops.push(['=', cx - 1, cy - 1]); cx--; cy--; }
          if (dd > 0) { if (cx === px) ops.push(['+', -1, cy - 1]); else ops.push(['-', cx - 1, -1]); }
          cx = px; cy = py;
        }
        return ops.reverse();
      }
    }
  }
  return [];
}
function getDiff(f) {
  const key = f.a + '|' + f.b;
  if (state.cx.diffs.has(key)) return state.cx.diffs.get(key);
  const A = linesOf(f.a), B = linesOf(f.b);
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length; while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const mid = myers(A.slice(s, ea), B.slice(s, eb)).map(([t, i, j]) => [t, i < 0 ? -1 : i + s, j < 0 ? -1 : j + s]);
  const ops = [];
  for (let i = 0; i < s; i++) ops.push(['=', i, i]);
  ops.push(...mid);
  for (let i = 0; i < A.length - ea; i++) ops.push(['=', ea + i, eb + i]);
  const d = { ops, A, B, add: ops.filter((o) => o[0] === '+').length, del: ops.filter((o) => o[0] === '-').length };
  state.cx.diffs.set(key, d);
  return d;
}
// The changed words of a line pair: the part between the common prefix and suffix, as nodes.
function wordHl(a, b) {
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const wrap = (t, cls) => { const m = t.slice(p, t.length - s); return [t.slice(0, p), ...(m ? [el('span', cls, m)] : []), t.slice(t.length - s)].filter((part) => part !== ''); };
  return [wrap(a, 'w-del'), wrap(b, 'w-add')];
}
// The diff of a file as rows (the prototype's diffHtml, built as nodes): side-by-side or unified,
// unchanged runs folded to "⋯ N unchanged lines" with 3 lines of context, none at the file's edges.
function diffHtml(f) {
  const d = getDiff(f); const { A, B, ops } = d;
  const side = diffLayout() === 'side', C = 3;
  const segs = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i][0] === '=') { const s = { t: 'eq', rows: [] }; while (i < ops.length && ops[i][0] === '=') { s.rows.push(ops[i]); i++; } segs.push(s); }
    else { const s = { t: 'chg', dels: [], adds: [] }; while (i < ops.length && ops[i][0] !== '=') { if (ops[i][0] === '-') s.dels.push(ops[i][1]); else s.adds.push(ops[i][2]); i++; } segs.push(s); }
  }
  const ln = (n) => el('span', 'ln', n === null ? '' : String(n));
  const cell = (cls, parts) => { const c = el('span', cls); c.append(...parts); return c; };
  const rowOf = (cls, ...cells) => { const r = el('div', cls); r.append(...cells); return r; };
  const eq = (o) => side ? rowOf('r', ln(o[1] + 1), el('span', 'c', A[o[1]]), ln(o[2] + 1), el('span', 'c', B[o[2]]))
    : rowOf('r', ln(o[1] + 1), ln(o[2] + 1), el('span', 'sg'), el('span', 'c', A[o[1]]));
  const rows = [];
  segs.forEach((s, si) => {
    if (s.t === 'eq') {
      const fid = `${f.path}|${ui.cx.view}|${si}`;
      const head = si === 0 ? 0 : C, tail = si === segs.length - 1 ? 0 : C;
      if (ui.cx.collapse && !ui.cx.unfolded.has(fid) && s.rows.length > head + tail + 2) {
        rows.push(...s.rows.slice(0, head).map(eq), button('fold', `⋯ ${s.rows.length - head - tail} unchanged lines`, { fold: fid }), ...s.rows.slice(s.rows.length - tail).map(eq));
      } else rows.push(...s.rows.map(eq));
      return;
    }
    const n = Math.max(s.dels.length, s.adds.length);
    const pair = (k) => { const ai = s.dels[k], bi = s.adds[k]; return ai != null && bi != null && s.dels.length === s.adds.length ? wordHl(A[ai], B[bi]) : [ai != null ? [A[ai]] : [], bi != null ? [B[bi]] : []]; };
    if (side) {
      for (let k = 0; k < n; k++) { const ai = s.dels[k], bi = s.adds[k]; const [ah, bh] = pair(k);
        rows.push(rowOf('r', ln(ai != null ? ai + 1 : null), cell(`c ${ai != null ? 'del' : 'void'}`, ah), ln(bi != null ? bi + 1 : null), cell(`c ${bi != null ? 'add' : 'void'}`, bh))); }
    } else {
      const hs = Array.from({ length: n }, (_, k) => pair(k));
      s.dels.forEach((ai, k) => { rows.push(rowOf('r del', ln(ai + 1), ln(null), el('span', 'sg', '−'), cell('c', hs[k][0]))); });
      s.adds.forEach((bi, k) => { rows.push(rowOf('r add', ln(null), ln(bi + 1), el('span', 'sg', '+'), cell('c', hs[k][1]))); });
    }
  });
  const node = el('div', `dfile${side ? '' : ' uni'}`);
  node.append(...(ops.length ? rows : [el('div', 'dempty', 'Empty file.')]));
  return node;
}

// ---- the tree
function visibleFiles() { const all = changeSet(ui.cx.view); const q = ui.cx.q.toLowerCase(); return { all, files: q ? all.filter((f) => f.path.toLowerCase().includes(q)) : all }; }
function treeRows(files) {
  if (ui.cx.flat) return files.map((f) => ({ id: 'f:' + f.path, type: 'file', f, depth: 0 }));
  const root = { dirs: new Map(), files: [] };
  for (const f of files) { const parts = f.path.split('/'); let n = root; for (const p of parts.slice(0, -1)) { if (!n.dirs.has(p)) n.dirs.set(p, { dirs: new Map(), files: [] }); n = n.dirs.get(p); } n.files.push(f); }
  const count = (n) => n.files.length + [...n.dirs.values()].reduce((s, c) => s + count(c), 0);
  const out = [];
  const walk = (node, prefix, depth, parent) => {
    for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      let nm = name, c = child, full = prefix + name;
      while (c.files.length === 0 && c.dirs.size === 1) { const [n2, c2] = [...c.dirs][0]; nm += '/' + n2; full += '/' + n2; c = c2; }
      const id = 'd:' + full;
      out.push({ id, type: 'dir', path: full, name: nm, depth, count: count(c), parent, open: !ui.cx.collapsed.has(full) });
      if (!ui.cx.collapsed.has(full)) walk(c, full + '/', depth + 1, id);
    }
    for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) out.push({ id: 'f:' + f.path, type: 'file', f, depth, parent });
  };
  walk(root, '', 0, null);
  return out;
}
const LETTER = { modified: 'M', added: 'A', deleted: 'D' };
// One row of the tree: a folder (▾/▸, its name compacted, its file count) or a file (M/A/D, its
// name, its folder in the flat list, a binary or unavailable tag, +a −d), its depth as --d.
function rowHtml(r) {
  const cur = ui.cx.cursor === r.id;
  const li = el('li');
  li.setAttribute('role', 'none');
  let row;
  if (r.type === 'dir') {
    row = button(`trow dir${cur ? ' sel' : ''}`, '', { trow: r.id });
    row.setAttribute('aria-expanded', String(r.open));
    row.append(el('span', 'tw', r.open ? '▾' : '▸'), el('span', 'ic', '▤'), el('span', 'nm', r.name), el('span', 'cnt', String(r.count)));
  } else {
    const f = r.f, [dir, name] = splitPath(f.path);
    row = button(`trow vcs-${f.status}${cur ? ' sel' : ''}`, '', { trow: r.id });
    row.setAttribute('title', `${f.path} (${f.status})`);
    row.append(el('span', 'tw'), el('span', 'lt', LETTER[f.status] ?? 'M'), el('span', 'nm', name));
    if (ui.cx.flat) row.append(el('span', 'dn', dir));
    if (f.unavailable) row.append(el('span', 'tag', 'unavailable'));
    else if (f.binary) row.append(el('span', 'tag', 'binary'));
    const cnt = el('span', 'cnt');
    cnt.append(el('span', 'a', `+${f.additions}`), ' ', el('span', 'r', `−${f.deletions}`));
    row.append(cnt);
  }
  row.setAttribute('role', 'treeitem');
  row.setAttribute('tabindex', cur ? '0' : '-1');
  row.style.setProperty('--d', String(r.depth));
  li.append(row);
  return li;
}
function renderTree(focus) {
  const { all, files } = visibleFiles();
  const rows = treeRows(files);
  ui.cx.rows = rows;
  if (!rows.some((r) => r.id === ui.cx.cursor)) ui.cx.cursor = ui.cx.sel && rows.some((r) => r.id === 'f:' + ui.cx.sel) ? 'f:' + ui.cx.sel : rows.find((r) => r.type === 'file')?.id ?? rows[0]?.id ?? null;
  const n = (s) => all.filter((f) => f.status === s).length;
  let add = 0, del = 0; for (const f of all) { add += f.additions; del += f.deletions; }
  const more = listOf(ui.cx.view)?.more === true;
  $('cxsum').replaceChildren(el('b', '', `${all.length} files`), `: ${n('modified')} modified, ${n('added')} added, ${n('deleted')} deleted · `, el('span', 'a', `+${add}`), ' ', el('span', 'r', `−${del}`),
    ...(files.length !== all.length ? [` · ${files.length} match`] : []), ...(more ? [' · the first 3000 files only'] : []));
  // The focus stays in the tree when it was there: on the cursor's row.
  const inTree = $('tlist').contains(document.activeElement);
  $('tlist').replaceChildren(...(rows.length ? rows.map(rowHtml) : [el('li', 'dempty', 'No file matches the filter.')]));
  const node = [...$('tlist').querySelectorAll('.trow')].find((row) => row.dataset.trow === ui.cx.cursor);
  if (node) { node.scrollIntoView({ block: 'nearest' }); if (focus || inTree) node.focus(); }
}
function iterLabel(v) { const its = itersOf(); return v === 'all' ? `All changes (final${its.length ? ', after iteration ' + its[its.length - 1].n : ''})` : `Iteration ${v}${v > 1 ? ` (Fix ${v - 1})` : ''}`; }
// A commit in a note, short (12 characters, as elsewhere on the page).
const shortCommit = (commit) => commit.slice(0, 12);
// The diff pane's toolbar (◀ ⇧F7, F7 ▶, the path, i/n · status, the iteration selector, the
// layout, Collapse unchanged) and its body: the notes and the diff of the selected file, its two
// sides read from the file route when it is selected.
function renderDiffPane() {
  if ($('dtool') === null) return;
  const { files } = visibleFiles();
  const f = files.find((x) => x.path === ui.cx.sel) || null;
  const idx = f ? files.indexOf(f) : -1;
  const its = itersOf();
  const focused = document.activeElement?.id;
  const prev = button('btn small', '◀ ', { fstep: '-1' });
  prev.setAttribute('title', 'Previous file (Shift+F7 or p)');
  prev.append(el('span', 'kbd', '⇧F7'));
  prev.disabled = idx <= 0;
  const next = button('btn small', '', { fstep: '1' });
  next.setAttribute('title', 'Next file (F7 or n)');
  next.append(el('span', 'kbd', 'F7'), ' ▶');
  next.disabled = idx < 0 || idx >= files.length - 1;
  const dpath = el('span', 'dpath', f ? f.path : 'No file selected');
  dpath.setAttribute('title', f?.path || '');
  const select = el('select');
  select.id = 'cxview';
  select.setAttribute('aria-label', 'Which changes');
  for (const v of ['all', ...its.map((x) => x.n)]) {
    const option = el('option', '', iterLabel(v));
    option.value = String(v);
    option.selected = ui.cx.view === v;
    select.append(option);
  }
  select.value = String(ui.cx.view);
  const seg = el('span', 'seg2');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Diff layout');
  seg.append(button(ui.cx.mode === 'side' ? 'on' : '', 'Side-by-side', { mode: 'side' }), button(ui.cx.mode === 'uni' ? 'on' : '', 'Unified', { mode: 'uni' }));
  const collapse = el('input');
  collapse.type = 'checkbox';
  collapse.id = 'cxcollapse';
  collapse.checked = ui.cx.collapse;
  const label = el('label');
  label.append(collapse, ' Collapse unchanged');
  $('dtool').replaceChildren(prev, next, dpath, ...(f ? [el('span', 'muted fs12', `${idx + 1}/${files.length} · ${f.status}`)] : []), el('span', 'sp'), select, ...(media(NARROW_QUERY) ? [] : [seg]), label);
  if (focused === 'cxview' || focused === 'cxcollapse') $(focused).focus();
  const body = $('dbody');
  if (!f) { body.replaceChildren(el('div', 'dempty', listOf(ui.cx.view) === 'loading' ? 'Loading…' : 'Select a file on the left.')); return; }
  const notes = [];
  if (f.status === 'deleted') notes.push(el('div', 'dnote', 'Deleted file: the old content, all removed.'));
  else if (f.status === 'added') notes.push(el('div', 'dnote', 'New file: all added.'));
  // A conflict-resolved rebase between iteration N - 1 and N: this view also shows the upstream changes.
  if (ui.cx.view !== 'all' && ui.cx.view > 1) {
    const before = its.find((x) => x.n === ui.cx.view - 1)?.base_commit, after = its.find((x) => x.n === ui.cx.view)?.base_commit;
    if (before && after && before !== after) notes.push(el('div', 'dnote', `The base moved from ${shortCommit(before)} to ${shortCommit(after)} before iteration ${ui.cx.view}: this view also shows those upstream changes.`));
  }
  const [a, b] = sidesOf(ui.cx.view);
  const versions = [sideOf(a, f.path), sideOf(b, f.path)];
  const message = (text) => { body.replaceChildren(...notes, el('div', 'dempty', text)); body.scrollTop = 0; };
  if (versions.includes('loading')) return message('Loading…');
  const failed = versions.find((v) => typeof v?.error === 'string');
  if (failed) return message(`Could not load the file: ${failed.error}`);
  const unavailable = versions.find((v) => v.kind === 'unavailable');
  if (unavailable) return message(unavailable.reason);
  if (f.binary || versions.some((v) => v.kind === 'binary')) return message('Binary file: not shown.');
  if (versions.some((v) => v.kind === 'too_large')) return message('Larger than 1 MiB: not shown.');
  if (f.unavailable) return message('This file is not available.');
  if (f.status === 'modified' && diffLayout() === 'side') {
    const split = el('div', 'dnote split');
    split.append(el('span', '', `Before (${ui.cx.view === 'all' || ui.cx.view === 1 ? state.cx.index.base?.ref ?? '' : 'iteration ' + (ui.cx.view - 1)})`),
      el('span', '', `After (iteration ${ui.cx.view === 'all' ? its[its.length - 1].n : ui.cx.view})`));
    notes.push(split);
  }
  body.replaceChildren(...notes, diffHtml({ path: f.path, a: `${a}|${f.path}`, b: `${b}|${f.path}` }));
  body.scrollTop = 0;
}
// The Changes screen: the empty states, else the tree, the divider and the diff pane, built once
// and redrawn in place.
function renderChanges(focusTree) {
  const job = shownJob(); const node = $('scrChanges');
  if (job === null) return;
  const index = cxIndex();
  const notice = (text) => { node.replaceChildren(el('div', 'dempty span', text)); };
  if (index === null) return notice('Loading…');
  if (typeof index.error === 'string') return notice(`Could not load the changes: ${index.error}`);
  const its = itersOf();
  if (!its.length) return notice(`No iteration has ended yet. The changes appear here when the Implementer finishes iteration ${shownIteration(job) || 1}; until then its edits are in the stream.`);
  if (ui.cx.view !== 'all' && !its.some((x) => x.n === ui.cx.view)) ui.cx.view = 'all';
  if (node.querySelector('#tlist') === null) {
    const q = el('input', 'ffq');
    q.id = 'cxq';
    q.type = 'search';
    q.setAttribute('placeholder', 'Filter files (/)');
    q.setAttribute('aria-label', 'Filter files');
    const seg = el('span', 'seg2');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Tree layout');
    seg.append(button('', 'Group by directory', { flat: '0' }), button('', 'Flat list', { flat: '1' }));
    const row = el('div', 'row');
    row.append(seg);
    const sum = el('div', 'sum');
    sum.id = 'cxsum';
    const tb = el('div', 'tb');
    // SF-119: the tree's fold, shown on a phone only (app.css), above its filter.
    const fold = button('btn small cxtree', '', { cxtree: '' });
    fold.id = 'cxtree';
    fold.setAttribute('aria-controls', 'tlist');
    tb.append(fold, q, row, sum);
    const list = el('ul', 'tlist');
    list.id = 'tlist';
    list.setAttribute('role', 'tree');
    list.setAttribute('aria-label', 'Changed files');
    const tree = el('div', 'tree');
    tree.append(tb, list);
    const vdiv = el('div', 'vdiv');
    vdiv.id = 'vdiv';
    vdiv.setAttribute('role', 'separator');
    vdiv.setAttribute('aria-orientation', 'vertical');
    vdiv.setAttribute('aria-label', 'Resize the file tree');
    vdiv.setAttribute('tabindex', '0');
    const tool = el('div', 'dtool');
    tool.id = 'dtool';
    const body = el('div', 'dbody');
    body.id = 'dbody';
    body.setAttribute('tabindex', '-1');
    const pane = el('div', 'dpane');
    pane.append(tool, body);
    node.replaceChildren(tree, vdiv, pane);
  }
  $('cxtree').textContent = ui.cx.tree ? '▾ Files' : '▸ Files';
  $('cxtree').setAttribute('aria-expanded', String(ui.cx.tree));
  node.querySelector('.tree').classList.toggle('folded', !ui.cx.tree);
  $('cxq').value = ui.cx.q;
  node.querySelectorAll('[data-flat]').forEach((b) => b.classList.toggle('on', (b.dataset.flat === '1') === ui.cx.flat));
  const list = listOf(ui.cx.view);
  if (list === 'loading' || typeof list?.error === 'string') {
    $('cxsum').textContent = '';
    $('tlist').replaceChildren(el('li', 'dempty', list === 'loading' ? 'Loading…' : `Could not load the files: ${list.error}`));
    renderDiffPane();
    return;
  }
  // A path link's file that did not change in its iteration: All changes.
  if (ui.cx.check !== null) {
    const path = ui.cx.check;
    ui.cx.check = null;
    if (ui.cx.view !== 'all' && !list.files.some((f) => f.path === path)) {
      ui.cx.view = 'all';
      return renderChanges(focusTree);
    }
  }
  const { files } = visibleFiles();
  if (!ui.cx.sel || !files.some((f) => f.path === ui.cx.sel)) ui.cx.sel = files[0]?.path ?? null;
  ui.cx.cursor = ui.cx.sel ? 'f:' + ui.cx.sel : ui.cx.cursor;
  state.cx.focusTree = false;
  renderTree(focusTree); renderDiffPane();
}
function selectRow(id, focus) {
  ui.cx.cursor = id;
  if (id && id.startsWith('f:')) { const p = id.slice(2); if (p !== ui.cx.sel) { ui.cx.sel = p; renderDiffPane(); } }
  renderTree(focus);
}
// The tree's keys: Up and Down move, Left closes a folder or goes to the parent, Right opens a
// folder or goes into it, Enter opens or closes a folder, or shows the file's diff.
function treeKey(ev) {
  const rows = ui.cx.rows || []; const i = rows.findIndex((r) => r.id === ui.cx.cursor); const r = rows[i];
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); const n = rows[Math.max(0, Math.min(rows.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))]; if (n) selectRow(n.id, true); return true; }
  if (!r) return false;
  if (ev.key === 'ArrowLeft') { ev.preventDefault(); if (r.type === 'dir' && r.open) { ui.cx.collapsed.add(r.path); renderTree(true); } else if (r.parent) selectRow(r.parent, true); return true; }
  if (ev.key === 'ArrowRight') { ev.preventDefault(); if (r.type === 'dir' && !r.open) { ui.cx.collapsed.delete(r.path); renderTree(true); } else if (r.type === 'dir') { const n = rows[i + 1]; if (n) selectRow(n.id, true); } return true; }
  if (ev.key === 'Enter') { ev.preventDefault(); if (r.type === 'dir') { if (r.open) ui.cx.collapsed.add(r.path); else ui.cx.collapsed.delete(r.path); renderTree(true); } else { selectRow(r.id, false); if (media(NARROW_QUERY)) { ui.cx.tree = false; renderChanges(); } $('dbody').focus(); } return true; }
  return false;
}
// F7 / Shift+F7 and n / p: the next or previous file of the list, the folders on the way opened.
function fileStep(d) {
  const { files } = visibleFiles();
  const i = files.findIndex((f) => f.path === ui.cx.sel); const n = files[i + d];
  if (!n) return toast({ level: 'info', text: d > 0 ? 'Last file' : 'First file' });
  for (const r of (ui.cx.rows || [])) if (r.type === 'dir' && n.path.startsWith(r.path + '/')) ui.cx.collapsed.delete(r.path);
  selectRow('f:' + n.path, false);
}
// Open the Changes screen on a file, at an iteration when that file changed in it (All changes
// otherwise, decided once that iteration's list is read), the folders on the way opened.
function openChanges(path, it) {
  if (ui.job === null) return;
  ui.cx.q = '';
  let view = it ? Number(it) : 'all';
  if (!Number.isInteger(view) || view < 1) view = 'all';
  if (state.cx.index !== null && !itersOf().some((x) => x.n === view)) view = 'all';
  ui.cx.view = view;
  ui.cx.check = path && view !== 'all' ? path : null;
  if (path) { ui.cx.sel = path; for (const p of [...ui.cx.collapsed]) if (path.startsWith(p + '/')) ui.cx.collapsed.delete(p); }
  go(ui.job, 'changes');
}
// The divider between the tree and the diff: dragged with the pointer, Arrow Left and Right with
// the keyboard; the width (--tree-w on the page) is kept for the page's life.
let treeW = 320;
function treeWidth(width) {
  treeW = Math.round(width);
  document.documentElement.style.setProperty('--tree-w', `${treeW}px`);
}
function onDividerDown(ev) {
  const d = typeof ev.target?.closest === 'function' ? ev.target.closest('#vdiv') : null; if (!d) return;
  d.setPointerCapture?.(ev.pointerId); d.classList.add('drag');
  const move = (e) => { const r = $('scrChanges').getBoundingClientRect(); treeWidth(Math.max(200, Math.min(r.width - 360, e.clientX - r.left))); };
  const up = () => { d.classList.remove('drag'); d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up); };
  d.addEventListener('pointermove', move); d.addEventListener('pointerup', up);
}
function dividerKey(ev) {
  const tree = document.querySelector('#scrChanges .tree');
  const w = typeof tree?.getBoundingClientRect === 'function' ? tree.getBoundingClientRect().width : treeW;
  treeWidth(Math.max(200, w + (ev.key === 'ArrowLeft' ? -32 : 32)));
}

// One review item as a list entry: the path as code, the problem, and what is expected.
function itemEntry(item, expected = true) {
  const entry = el('li');
  if (typeof item.id === 'string') {
    entry.append(document.createTextNode(`${item.id} `));
  }
  entry.append(el('code', '', item.path), document.createTextNode(`: ${item.problem}${expected ? ` Expected: ${item.expected}` : ''}`));
  return entry;
}

// ---------- The Merge request screen (SF-080: the prototype's renderMr, renderMrChecks and mrAction) ----------

// Per job ("<ws>/<ticket>"): the mr-view last read (the server's) and its signature, the draft
// (title, body, branch, base; kept across screens), the saved values the draft is compared with,
// the factory's text, the tab (Edit or Preview), whether the diff against the factory's text is
// shown, the bar's outcome, the action under way, whether "Push it as it is" is offered, the read
// under way and its error.
const MR = new Map();
function mrState(key) {
  if (!MR.has(key)) {
    MR.set(key, {
      view: null, sig: null, title: '', body: '', branch: '', base: '', saved: { title: '', body: '', branch: '', base: '' }, factory: { title: '', body: '' },
      tab: 'edit', showChanges: false, outcome: null, busy: null, offerAsIs: false, load: null, error: null,
    });
  }
  return MR.get(key);
}
const MR_FIELDS = ['title', 'body', 'branch', 'base'];
const mrEdited = (m) => m.view !== null && m.view.edited === true;
const mrDirty = (m) => m.view !== null && MR_FIELDS.some((k) => m[k] !== m.saved[k]);
// The lines of a level-2 section of a text, as the factory reads them (src/rules.ts sectionLines).
function section(text, heading) {
  const lines = text.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start < 0) {
    return [];
  }
  const out = [];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('```')) {
      fenced = !fenced;
    } else if (!fenced && /^#{1,2} /.test(line)) {
      break;
    }
    out.push(line);
  }
  return out;
}
// The rules come with mr-view (src/rules.ts); the page keeps no copy of them.
const manualClaim = (rules) => new RegExp(rules.manual_claim.source, rules.manual_claim.flags);
const NOT_CHECKED = /^\s*(?:[-*+]\s+)?not checked:/i;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Every problem of the draft, each with its field, in the server's words (src/mr.ts mrProblems).
function mrProblems(j, m) {
  const rules = m.view.rules;
  const p = [];
  const t = m.title;
  const length = [...t].length;
  const header = new RegExp(`^(?=.{1,${rules.max_header_chars}}$)(${rules.commit_types.join('|')})\\(${escapeRe(j.ticket)}\\): \\S.*(?<!\\.)$`, 'u');
  if (!header.test(t)) {
    p.push({
      field: 'title',
      message: t.trim() === '' ? 'The title is required.'
        : length > rules.max_header_chars ? `The title has ${length} characters, more than ${rules.max_header_chars}.`
          : t.endsWith('.') ? 'The title ends with a period.'
            : `The title must read "<type>(${j.ticket}): <summary>", with <type> one of ${rules.commit_types.join(', ')}.`,
    });
  }
  if (m.branch.trim() === '') {
    p.push({ field: 'branch', message: 'The branch is required.' });
  }
  if (m.base.trim() === '') {
    p.push({ field: 'base', message: 'The base branch is required.' });
  }
  const lines = m.body.replace(/\r/g, '').split('\n');
  for (const heading of rules.required_headings.filter((h) => !lines.some((line) => line.trimEnd() === h))) {
    p.push({ field: 'body', message: `Missing heading: ${heading}.` });
  }
  const claim = section(m.body, '## Testing').find((line) => manualClaim(rules).test(line) && !/not/iu.test(line));
  if (claim !== undefined) {
    p.push({ field: 'body', message: `SF-058: the ## Testing line "${claim.trim().slice(0, 90)}" reads as a check that was run. Anything not run goes on a line starting with "Not checked:".` });
  }
  return p;
}
// The problems shown: the draft's while it has unsaved changes, else the server's list of the saved text.
const mrShownProblems = (j, m) => (mrDirty(m) ? mrProblems(j, m) : m.view.problems);

// The mark of a Preview list line (md's mark): a "Not checked:" line, a manual check claimed as run
// (SF-058).
function mdMark(raw) {
  const m = state.key === null ? undefined : MR.get(state.key);
  if (NOT_CHECKED.test(raw)) {
    return 'notchk';
  }
  if (m?.view && manualClaim(m.view.rules).test(raw) && !/not/i.test(raw)) {
    return 'flag';
  }
  return '';
}

// The line diff of two texts (myers), unified, drawn as the Changes screen draws one; "No
// difference." when they are the same.
function textDiffHtml(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  const ops = myers(A, B);
  const ln = (n) => el('span', 'ln', n === null ? '' : String(n));
  const row = (cls, ...cells) => {
    const r = el('div', cls);
    r.append(...cells);
    return r;
  };
  const node = el('div', 'dfile uni boxed');
  if (ops.every((op) => op[0] === '=')) {
    node.append(el('div', 'dempty', 'No difference.'));
    return node;
  }
  node.append(...ops.map(([t, i, k]) => (t === '=' ? row('r', ln(i + 1), ln(k + 1), el('span', 'sg'), el('span', 'c', A[i]))
    : t === '-' ? row('r del', ln(i + 1), ln(null), el('span', 'sg', '−'), el('span', 'c', A[i]))
      : row('r add', ln(null), ln(k + 1), el('span', 'sg', '+'), el('span', 'c', B[k])))));
  return node;
}
// A title and body as the commit message: the title, a blank line and the body.
const messageOf = (message) => (message.body === '' ? message.title : `${message.title}\n\n${message.body}`);

// Reads the job's mr-view. adopt: 'all' puts the saved values in the draft (after a save), 'text'
// the title and the text only (after a reset); without it the draft follows the view only while it
// has no unsaved change. An answer that an even later read overtook is dropped.
async function loadMr(key, adopt = null) {
  const m = mrState(key);
  const token = {};
  m.load = token;
  let view;
  try {
    view = JSON.parse(await getText(`api/jobs/${jobPath(key)}/mr-view`));
  } catch (error) {
    if (m.load === token) {
      m.load = null;
      m.error = error.message;
      if (key === state.key && ui.screen === 'mr') {
        renderMr();
      }
    }
    return;
  }
  if (m.load !== token) {
    return;
  }
  m.load = null;
  m.error = null;
  const dirty = mrDirty(m);
  const sig = JSON.stringify(view);
  const changed = sig !== m.sig;
  m.view = view;
  m.sig = sig;
  m.saved = { title: view.title, body: view.body, branch: view.branch, base: view.base };
  m.factory = view.factory;
  for (const k of MR_FIELDS) {
    if (adopt === 'all' || !dirty || (adopt === 'text' && (k === 'title' || k === 'body'))) {
      m[k] = m.saved[k];
    }
  }
  if (!mrEdited(m)) {
    m.showChanges = false;
  }
  if (key !== state.key || ui.screen !== 'mr') {
    return;
  }
  if (changed || adopt !== null) {
    renderMr();
  } else {
    renderMrChecks();
  }
}

// The screen of the selected job: the empty line without MR text, else its last view at once (the
// form kept when it is already drawn, so a refresh of the job does not take the typing away) and a
// fresh read.
function showMr() {
  const key = state.key;
  if (key === null || !mrAvailable()) {
    $('scrMr').replaceChildren(el('div', 'dempty', 'No MR text yet: written at Clean, when both reviews pass.'));
    return;
  }
  if ($('mrBar') !== null && $('scrMr').dataset.key === key) {
    renderMrChecks();
  } else {
    renderMr();
  }
  void loadMr(key);
}

// The field that had the focus keeps it (and its selection) across a redraw.
function keepField(work) {
  const active = document.activeElement;
  const id = active?.id;
  const start = active?.selectionStart;
  const end = active?.selectionEnd;
  work();
  const again = typeof id === 'string' && id !== '' ? $(id) : null;
  if (again !== null && again !== active) {
    again.focus();
    if (typeof start === 'number' && typeof again.setSelectionRange === 'function') {
      again.setSelectionRange(start, end);
    }
  }
}

// A field of the form: its label, the control, the hint and its .bad line.
function mrField(label, control, hint, err) {
  const field = el('div', 'fld');
  const name = el('label', '', label);
  name.setAttribute('for', control.id);
  const bad = el('span', 'bad');
  bad.dataset.err = err;
  field.append(name, control, el('span', 'hint', hint), bad);
  return field;
}
// A one-line field of the form, monospaced, without spell checking.
function mrInput(id, value, disabled) {
  const input = el('input', 'mono');
  input.id = id;
  input.type = 'text';
  input.value = value;
  input.disabled = disabled;
  input.setAttribute('spellcheck', 'false');
  return input;
}

// The screen (the prototype's renderMr): the form on the left, the side panel and the bar drawn by
// renderMrChecks; the empty line without MR text, a reading line until mr-view answers.
function renderMr() {
  const key = state.key;
  const detail = state.detail;
  const node = $('scrMr');
  if (key === null || detail === null || keyOf(detail.job) !== key) {
    return;
  }
  if (!mrAvailable()) {
    node.replaceChildren(el('div', 'dempty', 'No MR text yet: written at Clean, when both reviews pass.'));
    return;
  }
  const j = detail.job;
  const m = mrState(key);
  if (m.view === null) {
    node.replaceChildren(el('div', 'dempty', m.error !== null ? `Could not read the MR text: ${m.error}` : 'Reading the MR text…'));
    return;
  }
  const v = m.view;
  const ro = !v.editable;
  const card = el('div', 'card2');
  const h3 = el('h3', '', 'Merge request');
  if (v.pushed) {
    h3.append(el('span', 'tag', 'read-only: pushed'));
  }
  const editedTag = el('span');
  editedTag.id = 'mrEdited';
  h3.append(editedTag);
  card.append(h3);
  if (typeof v.factory_new_at === 'string') {
    const line = el('div', 'notline');
    line.id = 'mrFactoryNew';
    line.append(document.createTextNode(`The factory wrote a new text (${clock(v.factory_new_at)}). `), button('linkish', 'Compare', { mrdiff: 'on' }), document.createTextNode(' · '));
    const reset = button('linkish', 'Reset to factory text', { mr: 'reset' });
    reset.disabled = ro;
    line.append(reset);
    card.append(line);
  }
  const row = el('div', 'row2');
  row.append(
    // branch_editable and base_editable come from the job only; a read-only screen disables them too.
    mrField('Branch', mrInput('mrBranch', m.branch, ro || !v.branch_editable), v.branch_editable ? 'Editable until the first push.' : v.branch_reason ?? 'Fixed after the first push.', 'branch'),
    mrField('Base branch', mrInput('mrBase', m.base, ro || !v.base_editable), `The MR targets this branch, e.g. main or master.${v.base_editable || v.base_reason === null ? '' : ` ${v.base_reason}`}`, 'base'),
  );
  card.append(row, mrField('MR title', mrInput('mrTitle', m.title, ro), `One line, the commit header too: <type>(${j.ticket}): <summary>, at most ${v.rules.max_header_chars} characters.`, 'title'));
  const desc = el('div', 'fld');
  const tabs = el('div', 'edtabs');
  tabs.setAttribute('role', 'tablist');
  for (const [tab, text] of [['edit', 'Edit'], ['preview', 'Preview']]) {
    const t = button(m.tab === tab && !m.showChanges ? 'on' : '', text, { mrtab: tab });
    t.setAttribute('role', 'tab');
    t.setAttribute('aria-selected', String(m.tab === tab && !m.showChanges));
    tabs.append(t);
  }
  if (mrEdited(m)) {
    const diff = button(m.showChanges ? 'on' : '', "Show changes against the factory's text", { mrdiff: 'toggle' });
    diff.setAttribute('aria-pressed', String(m.showChanges));
    tabs.append(diff);
  }
  let content;
  if (m.showChanges && mrEdited(m)) {
    content = textDiffHtml(messageOf(m.factory), messageOf(m.saved));
  } else if (m.tab === 'edit') {
    content = el('textarea', 'mdedit');
    content.id = 'mrBody';
    content.value = m.body;
    content.disabled = ro;
    content.setAttribute('aria-label', 'Description');
  } else {
    content = el('div', 'card2');
    content.id = 'mrPreview';
    content.append(md(m.body, mdMark));
  }
  const bad = el('span', 'bad');
  bad.dataset.err = 'body';
  desc.append(el('label', '', 'Description'), tabs, content, bad);
  card.append(desc);
  const left = el('div', 'stack');
  left.append(card);
  const side = el('div', 'stack');
  side.id = 'mrSide';
  const grid = el('div', 'grid');
  grid.append(left, side);
  const form = el('div', 'form2');
  form.append(grid);
  const bar = el('div', 'mrbar');
  bar.id = 'mrBar';
  node.dataset.key = key;
  keepField(() => node.replaceChildren(form, bar));
  renderMrChecks();
}

// The last verdict of a reviewer ('review': Claude, 'gate': Codex) over the job's iterations.
function lastVerdict(detail, kind) {
  for (const iteration of [...detail.iterations].reverse()) {
    const verdict = verdictOf(iteration[kind]);
    if (verdict === 'clean' || verdict === 'fix') {
      return `${verdict === 'clean' ? 'clean' : 'asked for fixes'} at iteration ${iteration.number}`;
    }
  }
  return '—';
}

// A card of the side panel: its title and content.
function mrCard(title, ...content) {
  const card = el('div', 'card2');
  card.append(typeof title === 'string' ? el('h3', '', title) : title, ...content);
  return card;
}

// What follows the draft as it is typed: the .bad lines, "edited by you", the side panel and the bar.
function renderMrChecks() {
  const key = state.key;
  const detail = state.detail;
  const m = key === null ? undefined : MR.get(key);
  if (!m?.view || detail === null || keyOf(detail.job) !== key || $('mrBar') === null) {
    return;
  }
  const j = detail.job;
  const v = m.view;
  const probs = mrShownProblems(j, m);
  document.querySelectorAll('#scrMr [data-err]').forEach((s) => {
    s.textContent = probs.filter((p) => p.field === s.dataset.err).map((p) => p.message).join(' ');
  });
  $('mrEdited').replaceChildren(...(mrEdited(m) ? [el('span', 'edited', 'edited by you')] : []));

  // Commit message: the title, a blank line and the whole body; the prepared commit's own while it
  // is not the MR text (a new Clean committed the factory's).
  const commitTitle = el('h3', '', 'Commit message ');
  commitTitle.append(el('span', 'muted plain', 'read-only'));
  const commit = mrCard(commitTitle);
  if (v.commit_differs && v.commit !== null) {
    commit.append(el('pre', 'cm', messageOf(v.commit)), el('span', 'err-text fs12', 'differs from the MR text: save or reset'));
  } else {
    commit.append(el('pre', 'cm', messageOf({ title: m.title, body: m.body })));
  }
  commit.append(el('span', 'hint', 'The commit message is the MR title and text. The factory amends the commit before the push when you change the text.'));

  const kv = el('dl', 'kv');
  const files = el('dd', '', `${typeof j.files === 'number' ? j.files : 0} changed · `);
  const open = button('linkish', 'Open Changes ', { goto: 'changes' });
  open.append(el('span', 'kbd', 'c'));
  files.append(open);
  const host = v.target.host === 'github' ? 'GitHub' : v.target.host === 'gitlab' ? 'GitLab' : v.target.host;
  const target = el('dd', '', [host, v.target.repository].filter((part) => typeof part === 'string' && part !== '').join(' ') || 'origin on no known Git host');
  target.append(el('br'), el('span', 'mono fs12', `${m.base} ← ${m.branch}`));
  kv.append(el('dt', '', 'Files'), files, el('dt', '', 'Claude'), el('dd', '', claudeOn(j) ? lastVerdict(detail, 'review') : 'off'),
    el('dt', '', 'Codex'), el('dd', '', `${lastVerdict(detail, 'gate')} · ${typeof j.gate_tokens === 'number' ? j.gate_tokens.toLocaleString('en-US') : 0} tokens`),
    el('dt', '', 'Fix rounds'), el('dd', '', String(j.fixes ?? 0)), el('dt', '', 'Target'), target);

  const testing = section(m.body, '## Testing');
  const claim = manualClaim(v.rules);
  const notChecked = testing.filter((line) => NOT_CHECKED.test(line));
  const flagged = testing.filter((line) => claim.test(line) && !/not/i.test(line));
  const notCard = mrCard('Not checked');
  if (notChecked.length === 0) {
    notCard.append(el('span', 'muted fs13', 'No "Not checked:" line in ## Testing.'));
  }
  for (const line of notChecked) {
    const n = el('div', 'notline');
    n.append(...inl(line.replace(/^\s*[-*+]\s+/, '')));
    notCard.append(n);
  }
  for (const line of flagged) {
    const n = el('div', 'notline bad');
    n.append(el('b', '', 'SF-058:'), document.createTextNode(' '), ...inl(line.replace(/^\s*[-*+]\s+/, '')));
    notCard.append(n);
  }

  const checks = el('ul', 'checks');
  for (const [label, ok] of [
    ['Title follows the commit header rule', !probs.some((p) => p.field === 'title')],
    ['Branch and base are set', !probs.some((p) => p.field === 'branch' || p.field === 'base')],
    ['All required headings are present', !probs.some((p) => p.message.startsWith('Missing heading'))],
    ['## Testing claims no manual check as run (SF-058)', !probs.some((p) => p.message.startsWith('SF-058'))],
  ]) {
    const item = el('li');
    item.append(el('span', ok ? 'ok' : 'no', ok ? '✓' : '✕'), document.createTextNode(label));
    checks.append(item);
  }
  const cards = [commit, mrCard('Carries', kv), notCard, mrCard('Checks', checks)];
  // The Codex items the user accepted the change without (SF-047), for a follow-up ticket.
  const override = standingOverride(detail);
  if (override !== null) {
    const items = Array.isArray(override.unapplied) ? override.unapplied : [];
    const list = el('ol', 'review-items');
    list.append(...items.map((item) => itemEntry(item)));
    cards.push(mrCard('Codex items not applied', el('span', 'hint', typeof override.unapplied === 'string'
      ? `You accepted the change over the gate (${override.code}); the gate failed: ${override.unapplied}`
      : `You accepted the change over the gate (${override.code}); ${items.length === 0 ? 'the gate left no item.' : 'these could go into a follow-up ticket:'}`), list));
  }
  $('mrSide').replaceChildren(...cards);
  keepField(() => $('mrBar').replaceChildren(...mrBar(j, m, probs)));
}

// The bar: the state text, the problem count and the buttons; pushed: when, and Back to the stream;
// read-only: why, and the push buttons of a handed-over job; last, when a button is off with a
// reason, those reasons (SF-119, shown on a phone or a device without hover).
function mrBar(j, m, probs) {
  const nodes = mrBarNodes(j, m, probs);
  const lines = whyLines(nodes.filter((node) => node.classList?.contains('btn')));
  if (lines.length === 0) {
    return nodes;
  }
  const why = el('div', 'why');
  why.append(...lines);
  return [...nodes, why];
}

// The bar's nodes before the reasons: the state text, the problem count and the buttons.
function mrBarNodes(j, m, probs) {
  const v = m.view;
  const back = button('btn', 'Back to the stream', { goto: 'stream' });
  if (v.pushed) {
    return [el('b', '', `Pushed at ${clock(v.pushed_at) || '—'}.`), el('span', 'muted', 'The MR text is read-only now.'), el('span', 'sp'), back];
  }
  const handed = j.state === 'handed_over';
  if (!v.editable && !handed) {
    return [el('span', 'muted', v.readonly_reason ?? ''), el('span', 'sp'), back];
  }
  const dirty = mrDirty(m);
  const busy = m.busy !== null;
  const nodes = [];
  if (m.outcome !== null) {
    nodes.push(el('span', m.outcome.level === 'error' ? 'err-text' : 'muted', m.outcome.text));
  } else if (!v.editable) {
    nodes.push(el('span', 'muted', v.readonly_reason ?? ''));
  } else {
    nodes.push(dirty ? el('b', '', 'Unsaved changes') : mrEdited(m) ? el('span', 'muted', 'Saved, edited by you') : el('span', 'muted', "The factory's text"));
  }
  if (probs.length > 0) {
    nodes.push(el('span', 'err-text', `${counted(probs.length, 'problem')} to fix before pushing`));
  }
  nodes.push(el('span', 'sp'));
  if (v.editable) {
    const save = button('btn', 'Save ', { mr: 'save' });
    save.append(el('span', 'kbd', 'Ctrl+S'));
    save.disabled = !dirty || busy;
    const reset = button('btn', 'Reset to factory text', { mr: 'reset' });
    reset.disabled = !(mrEdited(m) || m.title !== m.saved.title || m.body !== m.saved.body) || busy;
    nodes.push(save, reset);
  }
  const why = (action) => (probs.length > 0 ? 'Fix the problems first' : busy ? 'Wait for the save to end' : availability(action, j));
  const push = button('btn', 'Push branch only', { mr: 'push' });
  push.disabled = why('approve') !== '';
  if (push.disabled) {
    push.setAttribute('title', why('approve'));
  }
  nodes.push(push);
  if (m.offerAsIs) {
    const asIs = button('btn', 'Push it as it is', { mr: 'push-as-is' });
    asIs.disabled = busy || availability('approve', j) !== '';
    nodes.push(asIs);
  }
  const off = mrOff(j);
  if (off !== '') {
    nodes.push(el('span', 'muted fs12', `Push and open MR is off: ${off}`));
  } else {
    const open = button('btn primary', 'Push and open MR ↗', { mr: 'push-mr' });
    open.disabled = why('mr-create') !== '';
    if (open.disabled) {
      open.setAttribute('title', why('mr-create'));
    }
    nodes.push(open);
  }
  return nodes;
}

// Save: the draft (with the branch and the base when they changed); true when the factory saved
// it. A refusal is the bar's state text; the view is read again either way.
async function mrSave(key) {
  const m = mrState(key);
  if (m.view === null || !m.view.editable || m.busy !== null || !mrDirty(m)) {
    return false;
  }
  m.busy = 'save';
  m.outcome = { level: 'pending', text: 'Saving…' };
  renderMrChecks();
  const body = {
    title: m.title, body: m.body,
    ...(m.branch !== m.saved.branch ? { branch: m.branch } : {}), ...(m.base !== m.saved.base ? { base: m.base } : {}),
  };
  let saved = false;
  try {
    await post(`api/jobs/${jobPath(key)}/mr-save`, body);
    saved = true;
    m.outcome = null;
  } catch (error) {
    m.outcome = error instanceof ActionError
      ? { level: 'error', text: `Not saved: ${error.code}: ${error.message}` }
      : { level: 'error', text: `The save failed (${error.message}); it may have been written. The MR text is read again.` };
  }
  m.busy = null;
  if (saved && key === ui.job) {
    toast({ level: 'ok', text: 'MR text saved' });
  }
  await loadMr(key, saved ? 'all' : null);
  renderMrChecks();
  return saved;
}

// Reset to factory text: the factory's title and text back (branch and base stay as saved); a draft
// that only differs from the saved text goes back to it without a request.
async function mrReset(key) {
  const m = mrState(key);
  if (m.view === null || !m.view.editable || m.busy !== null) {
    return;
  }
  if (!mrEdited(m)) {
    m.title = m.saved.title;
    m.body = m.saved.body;
    m.outcome = null;
    renderMr();
    return;
  }
  m.busy = 'reset';
  m.outcome = { level: 'pending', text: 'Resetting…' };
  renderMrChecks();
  let done = false;
  try {
    await post(`api/jobs/${jobPath(key)}/mr-reset`, {});
    done = true;
    m.outcome = null;
    m.showChanges = false;
  } catch (error) {
    m.outcome = { level: 'error', text: error instanceof ActionError ? `Not reset: ${error.code}: ${error.message}` : `The reset failed (${error.message}); it may have been done. The MR text is read again.` };
  }
  m.busy = null;
  if (done && key === ui.job) {
    toast({ level: 'ok', text: "Back to the factory's text" });
  }
  await loadMr(key, done ? 'text' : null);
  renderMrChecks();
}

// Push branch only (approve) and Push and open MR (one mr-create: the push, then the merge request;
// the factory never opens one after a failed push). With unsaved changes the save goes first, and
// the push only once it succeeded. A tip edited by hand (branch_changed) offers Push it as it is.
async function mrPush(key, action, asIs = false) {
  const m = mrState(key);
  const job = state.detail?.job ?? null;
  if (job === null || keyOf(job) !== key || m.view === null || m.busy !== null || mrShownProblems(job, m).length > 0) {
    return;
  }
  if (m.view.editable && mrDirty(m) && !(await mrSave(key))) {
    return;
  }
  if (availability(action, state.detail?.job ?? job) !== '') {
    return;
  }
  m.offerAsIs = false;
  m.outcome = { level: 'pending', text: PENDING_TEXT[action] };
  renderMrChecks();
  await run(action, key, asIs ? { as_is: true } : {});
  const outcome = state.outcomes.get(key) ?? null;
  m.outcome = outcome === null ? null : { level: outcome.level, text: typeof outcome.link === 'string' ? `${outcome.text} ${outcome.link}` : outcome.text };
  m.offerAsIs = !asIs && outcome?.level === 'error' && outcome.text.startsWith('branch_changed:');
  renderMrChecks();
}

// A button of the bar (and Ctrl+S): save, reset, push, push-as-is or push-mr.
function mrAction(a) {
  const key = state.key;
  if (key === null || ui.screen !== 'mr') {
    return;
  }
  if (a === 'save') {
    void mrSave(key);
  } else if (a === 'reset') {
    void mrReset(key);
  } else if (a === 'push' || a === 'push-as-is') {
    void mrPush(key, 'approve', a === 'push-as-is');
  } else if (a === 'push-mr') {
    void mrPush(key, 'mr-create');
  }
}

// Leaving the page with an unsaved MR text asks first (the browser's "leave the page?").
function onBeforeUnload(event) {
  if ([...MR.values()].some((m) => mrDirty(m))) {
    event.preventDefault?.();
    event.returnValue = '';
  }
}

// Copies text; without the clipboard it shows the text in box, selected for Ctrl+C. say tells the
// user which.
function copyValue(text, box, say) {
  const select = () => {
    box.value = text;
    box.hidden = false;
    box.focus();
    box.select();
    say('Selected: press Ctrl+C to copy.');
  };
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
    select();
    return;
  }
  navigator.clipboard.writeText(text).then(() => say('Copied.'), select);
}

// ---------- The Stream (SF-078): SF-082's entries, as the prototype's renderStream and entryHtml ----------

// Who an entry is of, as the prototype names them.
const WHO = { implementer: 'Implementer', claude: 'Claude review', codex: 'Codex gate', mr: 'MR writer', factory: 'Factory', you: 'You' };
const STATE_WORD = {
  starting: 'Starting', working: 'Implementing', awaiting_review: 'In review', preparing_mr: 'Writing the MR', needs_human: 'Waiting for you',
  ready_for_human_review: 'Ready for you', handed_over: 'Handed over to your checkout', paused: 'Paused by you', waiting_limit: 'Waiting for limits', pushed: 'Pushed', aborted: 'Aborted', failed: 'Failed',
};
// The line of a state change that is not a stop; the factory's own line when it gives one (SF-072:
// the park on a usage limit and the resume from it).
const STATE_TEXT = (entry) => {
  if (typeof entry.text === 'string' && entry.text !== '') {
    return entry.text;
  }
  if (entry.to === 'awaiting_review') {
    return 'The Implementer finished; the reviews start';
  }
  if (entry.to === 'working' && entry.from === 'awaiting_review') {
    return 'Codex asked for fixes; back to the Implementer';
  }
  if (entry.to === 'working') {
    return 'The Implementer starts';
  }
  if (entry.to === 'preparing_mr') {
    return 'Both reviews clean; the MR text is being written';
  }
  if (entry.to === 'ready_for_human_review') {
    return 'Ready for you';
  }
  if (entry.to === 'pushed') {
    return 'Pushed';
  }
  return STATE_WORD[entry.to] ?? entry.to;
};
// A text entry longer than this many lines is clamped, with "Show all N lines".
const CLAMP_LINES = 8;
// A changes entry links this many files, then "and N more".
const SHOWN_FILES = 14;

// A path as its folder and its file name ('' without a folder).
const splitPath = (path) => {
  const at = path.lastIndexOf('/');
  return at < 0 ? ['', path] : [path.slice(0, at), path.slice(at + 1)];
};

// A path that opens the Changes screen at that file and iteration (the prototype's pathLink).
function pathLink(path, it) {
  const text = String(path ?? '');
  const [dir, name] = splitPath(text);
  const node = button('pathlink', '', { cfile: text, cit: it ? String(it) : '' });
  node.setAttribute('title', `Open ${text} in Changes${it ? ` at iteration ${it}` : ''}`);
  if (dir !== '') {
    node.append(el('span', 'd', `${dir}/`));
  }
  node.append(name);
  return node;
}

// Text with `code`, **bold** and Markdown headings (the prototype's prose), as nodes.
function prose(text) {
  const nodes = [];
  String(text ?? '').split('\n').forEach((line, index) => {
    if (index > 0) {
      nodes.push(document.createTextNode('\n'));
    }
    if (/^#{1,4} /.test(line)) {
      nodes.push(el('span', 'h', line));
      return;
    }
    for (const part of line.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
      if (/^`[^`\n]+`$/.test(part)) {
        nodes.push(el('code', '', part.slice(1, -1)));
      } else if (/^\*\*[^*\n]+\*\*$/.test(part)) {
        nodes.push(el('b', '', part.slice(2, -2)));
      } else if (part !== '') {
        nodes.push(document.createTextNode(part));
      }
    }
  });
  return nodes;
}

// The tool's line: its verb, the rest, and once its result came, "→ <out>" (.bad on a failure).
function toolLine(entry) {
  const line = String(entry.line ?? '');
  const at = line.indexOf(' ');
  const nodes = [el('span', 'verb', at < 0 ? line : line.slice(0, at)), document.createTextNode(at < 0 ? '' : ` ${line.slice(at + 1)}`)];
  if (entry.res !== undefined) {
    nodes.push(document.createTextNode(' '), el('span', entry.res.err ? 'out bad' : 'out', `→ ${entry.res.out}`));
  }
  return nodes;
}

// A finding's severity as its pill (.sev-<severity>); an item without one reads as major.
function severityTag(value) {
  const severity = String(value ?? 'major');
  return el('span', `sev sev-${/^[a-z]+$/.test(severity) ? severity : 'major'}`, severity);
}

// A finding of a verdict or a Fix section: its ledger id (or #n), severity, path, problem and what
// is expected.
function findingHtml(item, index, it) {
  const node = el('li', 'finding');
  node.append(el('span', 'fid', typeof item.id === 'string' && item.id !== '' ? item.id : `#${index + 1}`), severityTag(item.severity), pathLink(item.path, it));
  const problem = el('div', 'problem');
  problem.append(...prose(item.problem));
  node.append(problem);
  if (typeof item.expected === 'string' && item.expected !== '') {
    const expected = el('div', 'expected');
    expected.append('Expected: ', ...prose(item.expected));
    node.append(expected);
  }
  return node;
}

// The items of a Fix section as the factory writes them (fixItemLine, src/ledger.ts): one line each,
// "1. [R1, major] `path`: problem Expected: expected".
function fixItems(text) {
  const items = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\d+\. \[(R\d+), (\w+)\] `([^`]*)`: (.*)$/.exec(line);
    if (match !== null) {
      const [problem, ...expected] = match[4].split(' Expected: ');
      items.push({ id: match[1], severity: match[2], path: match[3], problem, expected: expected.join(' Expected: ') });
    }
  }
  return items;
}

// A toggle of an entry (data-toggle: the entry's key, or "<key>/task", "<key>/report").
const toggleButton = (key, text) => button('linkish', text, { toggle: key });

// A test run's duration (SF-128): "12 s" under a minute, else as dur.
const testsDur = (ms) => (typeof ms !== 'number' ? null : ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))} s` : dur(ms));

// The line of a run of the workspace's test command (SF-128): running, or how it ended (res: its
// tests_result), or the user's Accept of it.
function testsLine(res) {
  if (res === undefined || res === null) {
    return 'Tests running';
  }
  const after = testsDur(res.ms) === null ? '' : ` after ${testsDur(res.ms)}`;
  const ending = res.timed_out === true ? 'timed out' : `exit ${res.exit_code ?? '?'}`;
  switch (res.outcome) {
    case 'passed':
      return `Tests passed${after}`;
    case 'failed':
      return res.timed_out === true ? `Tests timed out${after}` : `Tests failed (exit ${res.exit_code ?? '?'})${after}`;
    case 'unavailable':
      return `Tests could not run (${res.reason ?? 'unknown reason'})`;
    case 'accepted_failing':
      return typeof res.reason === 'string' ? `Tests accepted by you without running (${res.reason})` : `Tests accepted by you without passing (${ending})`;
    default:
      return `Tests ended (${String(res.outcome ?? '')})`;
  }
}

// The body of a test run entry (SF-128): its line, the command, and the output's last lines behind
// the toggle (collapsed).
function testsBody(entry, open) {
  const res = entry.t === 'tests_result' ? entry : entry.res;
  const tail = typeof res?.tail === 'string' ? res.tail : '';
  const line = tail === '' ? el('div', 'line', testsLine(res)) : button('line', testsLine(res), { toggle: entry.k });
  const nodes = [line, el('div', 'mono fs12', String(entry.command ?? ''))];
  if (open && tail !== '') {
    const more = el('div', 'more');
    more.append(el('span', 'lbl', res.tail_truncated === true ? 'Output, its last lines' : 'Output'), el('pre', '', tail));
    nodes.push(more);
  }
  return nodes;
}

// The command of the open job's last test run, as inline code, for the Accept confirmation (SF-128).
function testsCommand(key) {
  if (key === state.key) {
    for (let index = state.entries.length - 1; index >= 0; index -= 1) {
      const entry = state.entries[index];
      if ((entry.t === 'tests' || entry.t === 'tests_result') && typeof entry.command === 'string' && entry.command !== '') {
        return `\`${entry.command}\``;
      }
    }
  }
  return "the workspace's test command";
}

// The changes entry: the iteration's files as path links, Open these changes (c) and its Report.
function changesEntry(entry) {
  const block = el('div', 'block');
  const paths = Array.isArray(entry.paths) ? entry.paths : [];
  const head = el('div', 'bh', `Iteration ${entry.it} ended: ${counted(typeof entry.files === 'number' ? entry.files : paths.length, 'file')} changed`);
  const open = button('btn small', 'Open these changes ', { changes: String(entry.it) });
  open.append(el('span', 'kbd', 'c'));
  head.append(el('span', 'grow'), open);
  const links = el('div', 'flinks');
  links.append(...paths.slice(0, SHOWN_FILES).map((path) => pathLink(path, entry.it)));
  if (paths.length > SHOWN_FILES) {
    links.append(button('linkish', `and ${paths.length - SHOWN_FILES} more`, { changes: String(entry.it) }));
  }
  const report = `${entry.k}/report`;
  const shown = ui.open.has(report);
  const toggleRow = el('div');
  toggleRow.append(toggleButton(report, shown ? 'Hide the Report' : 'Report'));
  block.append(head, links, toggleRow);
  if (shown) {
    const text = state.cache.get(`${entry.it}/report`);
    const pre = el('pre', 'raw doc');
    pre.append(...(text === undefined ? [document.createTextNode('Loading the Report…')] : renderReport(text)));
    block.append(pre);
  }
  return block;
}

// The implement prompt's Task: the Task file and its last check, from the sources of the old Task
// tab, once per job and Fix section.
async function loadTaskView() {
  const key = state.key;
  const job = state.detail?.job ?? jobByKey(key);
  const stamp = `${key}#${job?.fixes ?? 0}#${job?.iteration ?? 0}`;
  if (key === null || state.taskView?.stamp === stamp) {
    return;
  }
  const view = { stamp, text: null, check: null };
  state.taskView = view;
  let text;
  try {
    text = await getText(`api/tickets/${jobPath(key)}/task`);
  } catch (error) {
    // The ticket may have been archived since the job started.
    try {
      text = await getText(`api/tickets/${jobPath(key)}/task?archived=1`);
    } catch {
      text = `Could not load the Task file: ${error.message}`;
      // The next toggle tries again.
      view.stamp = null;
    }
  }
  view.check = await readCheck(key);
  view.text = text;
  if (state.key === key && state.taskView === view) {
    redrawWhere((entry) => entry.t === 'prompt' && entry.kind === 'implement');
  }
}

// The images sent with a prompt (SF-065), as one muted line; none without.
function imagesLine(entry) {
  return Array.isArray(entry.images) && entry.images.length > 0 ? [el('div', 'muted fs12', `Images: ${entry.images.join(', ')}`)] : [];
}

// A prompt: the Fix section with its items, or a line with the prompt behind a toggle (and the Task
// behind another for the implement prompt); "Continue where you stopped." as a factory line; the
// images sent with it under it.
function promptBody(entry, open) {
  return [...promptNodes(entry, open), ...imagesLine(entry)];
}

// The prompt itself, without the images line.
function promptNodes(entry, open) {
  const changed = entry.task_changed === true ? [document.createTextNode(' '), el('span', 'muted fs12', "with the Task file's change")] : [];
  if (entry.kind === 'continue') {
    const line = el('div', '', 'Continue where you stopped.');
    line.append(...changed);
    return [line];
  }
  if (entry.kind === 'fix') {
    const items = fixItems(entry.fix);
    const block = el('div', 'block fixsec');
    const head = el('div', 'bh', `Fix ${entry.fix_n} sent to the Implementer `);
    head.append(el('span', 'muted light', counted(items.length, 'item')), ...changed);
    const intro = el('div', 'summary');
    intro.append(...prose(String(entry.fix ?? '').split(/\n\d+\. \[R/)[0].trim()));
    const list = el('ul', 'findings');
    list.append(...items.map((item, index) => findingHtml(item, index, entry.it)));
    block.append(head, intro, list, toggleButton(entry.k, open ? 'Hide the full prompt' : 'Show the full prompt'));
    if (open) {
      block.append(el('pre', 'raw', entry.text));
    }
    return [block];
  }
  const what = { implement: 'The Implementer got the Task file', mr: 'MR preparation started', conflict: 'The Implementer is asked to resolve the rebase conflict' }[entry.kind] ?? 'Prompt';
  const line = el('div');
  line.append(el('b', '', what), ' ', el('span', 'mono muted fs12', entry.first ?? ''), ' ', toggleButton(entry.k, open ? 'hide prompt' : 'prompt'));
  const task = `${entry.k}/task`;
  if (entry.kind === 'implement') {
    line.append(' ', toggleButton(task, ui.open.has(task) ? 'hide Task' : 'Task'));
  }
  line.append(...changed);
  const nodes = [line];
  if (open) {
    nodes.push(el('pre', 'raw', entry.text));
  }
  if (entry.kind === 'implement' && ui.open.has(task)) {
    const view = state.taskView;
    if (view === null || view.text === null) {
      nodes.push(el('div', 'muted', 'Loading the Task file…'));
    } else {
      if (view.check !== null) {
        const check = el('div', 'task-check');
        check.append(...renderCheck(view.check));
        nodes.push(check);
      }
      const text = el('pre', 'raw doc');
      text.append(...renderReport(view.text));
      nodes.push(text);
    }
  }
  return nodes;
}

// A verdict of the Claude review or the Codex gate: the pill, the count, the summary (clamped) and
// the findings.
function verdictBody(entry, open) {
  const items = Array.isArray(entry.items) ? entry.items : [];
  const effective = entry.effective ?? entry.verdict;
  const block = el('div', open ? 'block' : 'block clamp');
  const head = el('div', 'bh', `${entry.who === 'codex' ? 'Codex gate' : 'Claude review'} · iteration ${entry.it} `);
  head.append(el('span', `verdict ${effective === 'clean' ? 'clean' : 'fix'}`, effective === 'clean' ? 'clean' : 'asks for fixes'),
    el('span', 'muted light', items.length > 0 ? counted(items.length, entry.who === 'codex' ? 'finding' : 'note') : 'no findings'));
  block.append(head);
  if (typeof entry.summary === 'string' && entry.summary !== '') {
    const summary = el('div', 'summary');
    summary.append(...prose(entry.summary));
    block.append(summary, toggleButton(entry.k, open ? 'Show less' : 'Show the whole summary'));
  }
  if (items.length > 0) {
    const list = el('ul', 'findings');
    list.append(...items.map((item, index) => findingHtml(item, index, entry.it)));
    block.append(list);
  }
  return block;
}

// The suggestions of a simplification pass, as findings: the path, what, why and the lines it saves.
function suggestionItems(suggestions, it) {
  const list = el('ul', 'findings');
  list.append(...suggestions.map((item, index) => {
    const node = el('li', 'finding');
    node.append(el('span', 'fid', `#${index + 1}`), pathLink(item.path, it));
    const what = el('div', 'problem');
    what.append(...prose(item.what));
    const why = el('div', 'expected');
    why.append('Why: ', ...prose(item.why));
    node.append(what, why, el('div', 'expected', `saves about ${counted(Number(item.saves_lines) || 0, 'line')}`));
    return node;
  }));
  return list;
}

// The note typed on a ledger entry, per job: ledger ids (R1, R2, …) start again in every job.
const noteKey = (id) => `${state.key}/${id}`;

// One ledger entry of a stop: the id, severity, path and problem, what the Implementer said, a
// dispute's reason, and, when the server offers it to settle (offered: one of settle_ids),
// Accept risk / Must fix with a note; a settled one shows its decision.
function ledgerFinding(entry, busy, offered) {
  const node = el('li', 'finding');
  node.dataset.id = entry.id;
  node.append(el('span', 'fid', entry.id), severityTag(entry.severity), pathLink(entry.path, entry.iteration > 0 ? entry.iteration : null));
  const problem = el('div', 'problem');
  problem.append(...prose(entry.problem));
  node.append(problem);
  if (entry.status === 'escalated') {
    node.append(el('div', 'expected', `The Implementer asks: ${entry.response}`));
  } else if (entry.status === 'contested' || (entry.dispute !== null && entry.dispute !== undefined)) {
    node.append(el('div', 'expected', `The Implementer contests it: ${entry.response}`), el('div', 'expected', `Evidence: ${entry.evidence || 'none given'}`));
    if (entry.dispute !== null && entry.dispute !== undefined) {
      node.append(el('div', 'expected', `${entry.dispute.reviewer === 'codex' ? 'Codex' : 'Claude'} reopens it: ${entry.dispute.reason}`));
    }
  } else {
    node.append(el('div', 'expected', `Expected: ${entry.expected}`));
  }
  const decide = el('div', 'decide');
  if (entry.settled !== null && entry.settled !== undefined) {
    decide.append(el('span', 'decided', entry.settled.decision === 'accept' ? 'Accepted risk' : 'Must fix'));
    if (entry.settled.note) {
      decide.append(el('span', 'muted', entry.settled.note));
    }
  } else if (offered) {
    const note = el('input', 'note');
    note.type = 'text';
    note.placeholder = 'Note (optional)';
    note.value = state.notes.get(noteKey(entry.id)) ?? '';
    note.dataset.note = entry.id;
    note.setAttribute('aria-label', `Note on ${entry.id}`);
    decide.append(note);
    for (const [text, decision] of [['Accept risk', 'accept'], ['Must fix', 'fix']]) {
      const choice = button('btn small', text, { settle: `${entry.id}:${decision}` });
      choice.disabled = busy !== '';
      if (busy !== '') {
        choice.setAttribute('title', busy);
      }
      decide.append(choice);
    }
  } else {
    return node;
  }
  node.append(decide);
  return node;
}

// The ledger entries of a ledger stop: those to settle (the detail's settle_ids, SF-129), the open
// ones of a churn stop, and the ones settled since the stop (with their decision), in ledger order.
function stopLedger(detail, code, since) {
  const settleIds = new Set(Array.isArray(detail.settle_ids) ? detail.settle_ids : []);
  const keep = new Set([...(detail.ledger ?? []).filter((entry) => settleIds.has(entry.id)), ...(code === 'review_churn' ? ledgerOpen(detail) : [])]);
  return (detail.ledger ?? []).filter((entry) => keep.has(entry) || (entry.settled !== null && entry.settled !== undefined && typeof since === 'string' && entry.settled.at >= since));
}

// What the stop block shows for its code (the Task's table): the suggestions, the entries to
// settle, the findings, the gate's tokens, an error or the message.
function stopInline(job, detail, entry) {
  const code = job.stop_code ?? 'other';
  const message = typeof job.error?.message === 'string' ? job.error.message : '';
  const whole = () => (message === '' ? [] : [el('pre', 'raw', message)]);
  const last = detail === null ? null : iterationOf(detail, job.iteration);
  const findings = (items) => {
    const list = el('ul', 'findings');
    list.append(...items.map((item, index) => findingHtml(item, index, job.iteration)));
    return items.length === 0 ? [] : [list];
  };
  switch (code) {
    case 'simplify_offered': {
      const items = detail === null ? (job.stop?.items ?? []) : offeredSuggestions(detail).items;
      return items.length === 0 ? [] : [suggestionItems(items, job.iteration)];
    }
    case 'escalated':
    case 'review_disputed':
    case 'review_churn': {
      if (detail === null) {
        return [];
      }
      const entries = stopLedger(detail, code, entry.ts);
      if (entries.length === 0) {
        return [el('div', 'muted', 'No ledger entry is left to settle.')];
      }
      const busy = availability('settle', detail.job);
      const list = el('ul', 'findings');
      const offered = new Set(Array.isArray(detail.settle_ids) ? detail.settle_ids : []);
      list.append(...entries.map((item) => ledgerFinding(item, busy, offered.has(item.id))));
      return [list];
    }
    case 'gate_rounds':
      return findings(Array.isArray(last?.gate?.items) ? last.gate.items : (job.stop?.items ?? []));
    case 'gate_budget':
      return [el('div', '', `The Codex gate used ${typeof job.gate_tokens === 'number' ? job.gate_tokens.toLocaleString('en-US') : 'its'} tokens.`)];
    case 'iteration_limit':
      // The open blocker and major findings (SF-131: the ledger's, the stop's items).
      return findings(Array.isArray(job.stop?.items) ? job.stop.items : [...(last?.review?.items ?? []), ...(last?.gate?.items ?? [])]);
    case 'gate_failed':
      return typeof last?.gate?.error === 'string' ? [el('pre', 'raw', last.gate.error)] : whole();
    case 'review_failed':
      return typeof last?.review?.error === 'string' ? [el('pre', 'raw', last.review.error)] : whole();
    case 'mr_conflict': {
      const files = /conflicts in (.+?);/.exec(message)?.[1];
      if (files === undefined) {
        return whole();
      }
      const list = el('div', 'flinks');
      list.append(...files.split(', ').map((path) => el('span', 'mono fs12', path)));
      return [list];
    }
    case 'worktree_remove_failed':
      return typeof job.worktree === 'string' ? [el('div', 'mono fs12', job.worktree)] : whole();
    case 'max_turns':
    case 'serve_restarted':
    case 'mr_serve_restarted':
    case 'publish_failed':
    case 'mr_empty':
    case 'mr_push_protected':
      return [];
    default:
      return whole();
  }
}

// A needs_human state entry: the stop block. The live one (the last, while the job waits) also has
// the sentence and what its code needs; an earlier one its message. A decision is labelled "Your
// decision", never as an error.
function stopBlock(entry, live) {
  const job = live ? shownJob() : null;
  // The live stop's row is the job's, an earlier one the Stream entry's (SF-129).
  const stop = stopEntry(job === null ? entry.stop_code : job.stop_code);
  // Its kind is the server's too (stop_kind): a decision is never labelled as an error.
  const decision = (job === null ? entry.stop_kind : job.stop_kind) === 'decision';
  const block = el('div', 'block stop');
  const head = el('div', 'bh');
  head.append(el('span', decision ? 'verdict fix' : 'verdict stop', decision ? 'Your decision' : 'Stopped'), stop.reason);
  if (typeof entry.code === 'string') {
    head.append(el('span', 'tag', entry.code));
  }
  block.append(head);
  if (job === null) {
    if (typeof entry.msg === 'string' && entry.msg !== '') {
      block.append(el('div', 'muted', entry.msg));
    }
    return block;
  }
  block.id = 'stopblock';
  const detail = shownDetail();
  const technical = [el('div', '', stop.sentence(job)), ...stopInline(job, detail, entry)];
  const explained = stopExplanation(job, detail);
  if (explained === null) {
    block.append(...technical);
    return block;
  }
  block.append(explanationBox(explained));
  if (explained.output === null) {
    // Still being written: the technical content stays as it is.
    block.append(...technical);
    return block;
  }
  // The technical content under Details, collapsed until opened.
  const key = `${entry.k}/details`;
  block.append(toggleButton(key, ui.open.has(key) ? 'Hide details' : 'Details'));
  if (ui.open.has(key)) {
    const more = el('div', 'stop-details');
    more.append(...technical);
    block.append(more);
  }
  return block;
}

// The plain explanation of the job's current stop (SF-106): the detail's explanation while it is
// pending or written for this very stop (updated_at and code); null when there is none, it failed,
// or it is another stop's.
function stopExplanation(job, detail) {
  const explained = detail?.explanation;
  if (explained === null || explained === undefined || typeof explained !== 'object' || job.state !== 'needs_human') {
    return null;
  }
  if (explained.stop?.at !== job.updated_at || explained.stop?.code !== (job.error?.code ?? '')) {
    return null;
  }
  if (explained.output === null || explained.output === undefined) {
    return typeof explained.error === 'string' || explained.ended_at !== null ? null : { ...explained, output: null };
  }
  return explained;
}

// The box above the stop panel: "Explaining…" while pending; else the headline in bold, the
// explanation, the choices (the recommended one marked), the recommendation and who explained it.
function explanationBox(explained) {
  const box = el('div', 'explain');
  if (explained.output === null) {
    box.append(el('div', 'muted', 'Explaining…'));
    return box;
  }
  const { headline, explanation, choices, recommendation } = explained.output;
  box.append(el('b', 'explain-head', String(headline ?? '')), el('div', 'explain-text', String(explanation ?? '')));
  const list = el('ul', 'explain-choices');
  for (const choice of Array.isArray(choices) ? choices : []) {
    const item = el('li', '');
    item.append(el('span', 'explain-choice', String(choice.choice ?? '')));
    if (choice.recommended === true) {
      item.append(el('span', 'tag rec', 'Recommended'));
    }
    item.append(el('span', 'explain-effect', String(choice.effect ?? '')));
    list.append(item);
  }
  box.append(list);
  if (typeof recommendation === 'string' && recommendation !== '') {
    box.append(el('div', 'explain-rec', recommendation));
  }
  box.append(el('div', 'muted fs12', `Explained by ${String(explained.model ?? '')} · ${money(explained.cost_usd)}`));
  return box;
}

// The body of one entry.
function entryBody(entry, open) {
  switch (entry.t) {
    case 'tool': {
      const line = button('line', '', { toggle: entry.k });
      line.setAttribute('title', entry.res === undefined ? String(entry.line ?? '') : `${entry.line}  → ${entry.res.out}`);
      line.append(...toolLine(entry));
      if (!open) {
        return [line];
      }
      const more = el('div', 'more');
      more.append(el('span', 'lbl', 'Input'), el('pre', '', String(entry.detail ?? '')));
      if (entry.res !== undefined) {
        more.append(el('span', 'lbl', 'Output'), el('pre', '', entry.res.result));
      }
      return [line, more];
    }
    case 'text': {
      const text = String(entry.text ?? '');
      const lines = text.split('\n').length;
      const body = el('div', 'prose');
      if (entry.who === 'codex' && /^\[withheld/.test(text)) {
        body.append(el('span', 'muted', '(message withheld by the factory)'));
      } else {
        body.append(...prose(text));
      }
      return lines > CLAMP_LINES ? [body, toggleButton(entry.k, open ? 'Show less' : `Show all ${lines} lines`)] : [body];
    }
    case 'result':
      return [['Turn ended', typeof entry.turns === 'number' ? counted(entry.turns, 'turn') : null, typeof entry.ms === 'number' ? dur(entry.ms) : null,
        `session ${money(entry.cost)}`].filter((part) => part !== null).join(' · ')];
    case 'state': {
      if (entry.to === 'needs_human') {
        return [stopBlock(entry, entry.k === stopKey())];
      }
      const nodes = [el('b', '', STATE_TEXT(entry)), el('span', 'tag', `${entry.from ?? '–'} → ${entry.to}`)];
      if (typeof entry.msg === 'string' && entry.msg !== '') {
        nodes.push(el('span', '', entry.msg));
      }
      return nodes;
    }
    case 'prompt':
      return promptBody(entry, open);
    case 'verdict':
      return [verdictBody(entry, open)];
    case 'changes':
      return [changesEntry(entry)];
    case 'tests':
    case 'tests_result':
      return testsBody(entry, open);
    case 'simplify': {
      const suggestions = Array.isArray(entry.suggestions) ? entry.suggestions : [];
      const block = el('div', 'block');
      const head = el('div', 'bh', `Simplification pass · iteration ${entry.it} `);
      head.append(el('span', 'muted light', suggestions.length > 0 ? `${counted(suggestions.length, 'suggestion')}, saves about ${counted(entry.saves_lines ?? 0, 'line')}` : 'no suggestion'));
      block.append(head);
      if (suggestions.length > 0) {
        block.append(suggestionItems(suggestions, entry.it));
      }
      return [block];
    }
    case 'user': {
      const block = el('div', 'block you');
      const text = el('div', 'prose');
      text.append(...prose(entry.text));
      block.append(text);
      if (entry.task_changed === true) {
        block.append(el('span', 'muted fs12', "with the Task file's change"));
      }
      block.append(...imagesLine(entry));
      return [block];
    }
    default:
      // note, and any type the page does not know: its text.
      return [String(entry.text ?? '')];
  }
}

// One entry as li.e.e-<t>.who-<who>: the local time, who (hidden when the same author goes on) and
// the body. Returns the node and its label.
function entryHtml(entry, prevWho) {
  const open = ui.open.has(entry.k);
  const who = typeof entry.who === 'string' && Object.hasOwn(WHO, entry.who) ? entry.who : 'factory';
  const label = entry.t === 'state' ? 'State' : entry.t === 'prompt' ? 'Factory' : WHO[who];
  const cont = prevWho === label && ['tool', 'text', 'result'].includes(entry.t);
  const lines = entry.t === 'text' ? String(entry.text ?? '').split('\n').length : 0;
  const node = el('li', `e e-${/^[a-z_]+$/.test(String(entry.t)) ? entry.t : 'note'} who-${who}${open ? ' open' : ''}${entry.res?.err ? ' err' : ''}${!open && lines > CLAMP_LINES ? ' clamp' : ''}`);
  node.dataset.k = entry.k;
  const body = el('div', 'body');
  body.append(...entryBody(entry, open));
  node.append(el('span', 'ts', clock(entry.ts)), el('span', cont ? 'who cont' : 'who', label), body);
  return { node, label };
}

// The separator before a prompt: "Iteration N" (with the Fix N tag) or "MR preparation". A Fix
// section's it is the iterations published when it was sent, so its work is iteration it + 1. A
// continue prompt goes on in its iteration, without one.
function sepFor(entry) {
  const sep = el('li', 'sep', entry.kind === 'mr' || entry.kind === 'conflict' ? 'MR preparation' : `Iteration ${entry.kind === 'fix' ? entry.it + 1 : entry.it}`);
  if (entry.kind === 'fix') {
    sep.append(' ', el('span', 'tag', `Fix ${entry.fix_n}`));
  }
  return sep;
}

// The nodes of the next entry of the Stream: its separator, if any, and its li.
function streamItems(entry) {
  const nodes = [];
  if (entry.t === 'prompt' && entry.kind !== 'continue') {
    nodes.push(sepFor(entry));
    state.prevLabel = null;
  }
  state.labels.set(entry.k, state.prevLabel);
  const { node, label } = entryHtml(entry, state.prevLabel);
  state.prevLabel = label;
  nodes.push(node);
  return nodes;
}

// The whole Stream of the open job.
function renderStream() {
  state.prevLabel = null;
  state.labels.clear();
  $('stream').replaceChildren(...state.entries.flatMap(streamItems));
  state.stopSig = stopSignature();
  markSel(false);
}

// The li of an entry in the Stream, by its key.
const entryNode = (k) => [...$('stream').children].find((node) => node.nodeType === 1 && node.dataset.k === k) ?? null;

// One entry drawn again in place (a joined result, a toggle, the stop).
function redrawEntry(entry) {
  const old = entryNode(entry.k);
  if (old !== null) {
    old.replaceWith(entryHtml(entry, state.labels.get(entry.k) ?? null).node);
  }
}

// The entries that pass test drawn again, the scroll and the selection kept.
function redrawWhere(test) {
  keepScroll(() => state.entries.filter(test).forEach(redrawEntry));
  markSel(false);
}

// The open job's own job object: the jobs payload's (it has the stop's numbers), else the detail's.
function shownJob() {
  if (ui.job === null) {
    return null;
  }
  return jobByKey(ui.job) ?? shownDetail()?.job ?? null;
}

// The detail of the job on its page; null while it has not arrived.
function shownDetail() {
  return ui.job !== null && state.detail !== null && keyOf(state.detail.job) === ui.job ? state.detail : null;
}

// The key of the live stop: the last needs_human state entry while the job waits; else null.
function stopKey() {
  if (shownJob()?.state !== 'needs_human') {
    return null;
  }
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry.t === 'state' && entry.to === 'needs_human') {
      return entry.k;
    }
  }
  return null;
}

// What the stop block shows depends on; it is drawn again only when this changed, so a note being
// typed stays.
function stopSignature() {
  const job = shownJob();
  const detail = state.detail;
  const last = detail === null ? null : iterationOf(detail, detail.job.iteration);
  // The stop's explanation too (SF-106): its pending and final writes change nothing else.
  return JSON.stringify([stopKey(), job?.state, job?.error, job?.stop, job?.gate_tokens, job?.worktree, job?.iteration, detail?.ledger, last?.simplify, last?.review, last?.gate,
    detail === null ? '' : availability('settle', detail.job), detail?.explanation ?? null]);
}

// The stop blocks drawn again when what they show changed.
function refreshStop() {
  const signature = stopSignature();
  if (signature !== state.stopSig) {
    state.stopSig = signature;
    redrawWhere((entry) => entry.t === 'state' && entry.to === 'needs_human');
  }
}

// The tool a result belongs to: the last tool entry with its id; null when the page has not seen it.
function toolOf(id) {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry.t === 'tool' && entry.id === id) {
      return entry;
    }
  }
  return null;
}

// The test run a tests_result belongs to (SF-128): the last tests entry of its run; null when the page
// has not seen it.
function testsOf(run) {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry.t === 'tests' && entry.run === run) {
      return entry;
    }
  }
  return null;
}

// Takes the entries of a page or of a live event, alike: an entry whose k is shown is ignored; a
// tool_result joins its tool by id (dropped without it), a tests_result its test run by run (shown
// on its own without it). Returns the entries added and the tools and runs that got their result.
function takeEntries(list) {
  const added = [];
  const joined = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.k !== 'string' || state.seen.has(entry.k)) {
      continue;
    }
    state.seen.add(entry.k);
    if (entry.t === 'tool_result') {
      const tool = typeof entry.id === 'string' && entry.id !== '' ? toolOf(entry.id) : null;
      if (tool !== null) {
        tool.res = { out: String(entry.out ?? ''), result: String(entry.result ?? ''), err: entry.err === true };
        if (!joined.includes(tool) && !added.includes(tool)) {
          joined.push(tool);
        }
      }
      continue;
    }
    if (entry.t === 'tests_result') {
      const run = typeof entry.run === 'string' && entry.run !== '' ? testsOf(entry.run) : null;
      if (run !== null) {
        run.res = entry;
        if (!joined.includes(run) && !added.includes(run)) {
          joined.push(run);
        }
        continue;
      }
    }
    state.entries.push(entry);
    added.push(entry);
  }
  return { added, joined };
}

// The Stream after new entries: appended, the joined tools drawn again, the stop moved; the view
// stays at the bottom only when it was at the bottom.
function showEntries(list) {
  const { added, joined } = takeEntries(list);
  if (added.length === 0 && joined.length === 0) {
    return;
  }
  const wrap = $('streamwrap');
  const bottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 8;
  $('stream').append(...added.flatMap(streamItems));
  joined.forEach(redrawEntry);
  if (added.some((entry) => entry.t === 'state')) {
    state.stopSig = null;
  }
  refreshStop();
  markSel(false);
  if (bottom) {
    wrap.scrollTop = wrap.scrollHeight;
  }
  // A card's button that points at the stop waits for its block.
  applyWantedFocus();
}

// Reads the job's Stream page by page from line 0, then follows it live from the last next. A page
// that cannot be read leaves the rest to the live stream, which sends every line from there.
async function loadStream(key) {
  const token = {};
  state.streamLoad = token;
  for (;;) {
    let page;
    try {
      page = JSON.parse(await getText(`api/jobs/${jobPath(key)}/stream?from=${state.lastLine}`));
    } catch {
      page = null;
    }
    if (state.streamLoad !== token || state.key !== key) {
      return;
    }
    if (page === null) {
      break;
    }
    showEntries(page.entries);
    const next = Number(page.next);
    const moved = Number.isInteger(next) && next > state.lastLine;
    if (moved) {
      state.lastLine = next;
    }
    if (page.end === true || !moved) {
      break;
    }
  }
  state.streamLoad = null;
  openStream();
  if (ui.screen === 'stream' && ui.job === key) {
    const wrap = $('streamwrap');
    wrap.scrollTop = wrap.scrollHeight;
  }
}

// The entries of the Stream, in order (the prototype's entries()).
const entries = () => [...$('stream').children].filter((node) => node.nodeType === 1 && node.classList.contains('e'));

// The selected entry (j, k, G, a click) marked .sel.
function markSel(scroll) {
  const all = entries();
  all.forEach((node) => node.classList.remove('sel'));
  if (ui.sel >= 0 && all[ui.sel] !== undefined) {
    all[ui.sel].classList.add('sel');
    if (scroll) {
      all[ui.sel].scrollIntoView({ block: 'nearest' });
    }
  }
}

// Runs work (a redraw) with the Stream's scroll position kept.
function keepScroll(work) {
  const wrap = $('streamwrap');
  const top = wrap.scrollTop;
  work();
  wrap.scrollTop = top;
}

// A toggle of an entry: its Input and Output, all its lines, the whole summary, the full prompt, the
// Task or the Report.
function toggle(key) {
  if (ui.open.has(key)) {
    ui.open.delete(key);
  } else {
    ui.open.add(key);
  }
  const [k, part] = key.split('/');
  const entry = state.entries.find((candidate) => candidate.k === k);
  if (entry === undefined) {
    return;
  }
  redrawWhere((candidate) => candidate === entry);
  if (part === 'task' && ui.open.has(key)) {
    void loadTaskView();
  } else if (part === 'report' && ui.open.has(key) && state.key !== null) {
    const shown = state.key;
    void iterationText(shown, entry.it, 'report').then((text) => {
      if (text !== undefined && state.key === shown) {
        redrawWhere((candidate) => candidate === entry);
      }
    });
  }
}

