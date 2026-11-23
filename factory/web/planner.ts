// planner.js, a dashboard script (DASHBOARD_SCRIPTS in src/dashboard.ts) right after
// ticket-page.js, built from web/planner.ts into dist/web/: the planner session of a planned
// ticket (src/planner-session.ts, through api/tickets/<ws>/<ticket>/planner): its lines in the
// ticket page's Planning conversation card and its link in the page's header, Start the planner,
// End (asked first in setup.js's ticket confirmation), the ticket's prototypes in that card and the
// newest in the header, and its read again every
// TK_PLANNER_POLL_MS while it runs; on the job page of a waiting job Claude Code plans, the
// session read every TK_PLANNER_POLL_MS and the controls of Discuss the result. A classic script, loaded in order with defer, sharing the
// page's globals with the others. This file has no import or export on purpose: the compiler
// keeps it a script, so its top-level names stay the page's globals.
'use strict';

// While the page shows a running session it reads it again this often: the session's link once its
// hook recorded it (at its first wait for the user), and its end; neither reaches sf serve as an event.
const TK_PLANNER_POLL_MS = 10000;
// The only planner link the page makes: a session page of claude.ai/code, as the hook records it.
const TK_PLANNER_LINK = /^https:\/\/claude\.ai\/code\/[A-Za-z0-9_-]{1,128}$/;

// The session the page shows: the ticket it is of ("<ws>/<ticket>"), the session as last read (null:
// none runs), whether the page saw it end, the timer of the next read, and per ticket key the count
// of the answers of Start the planner and End (a read of a ticket sent before its last one is not
// applied).
const tkPlanner: { key: string | null; session: PlannerSessionView | null; ended: boolean; timer: ReturnType<typeof setTimeout> | null; answers: Map<string, number> } = {
  key: null, session: null, ended: false, timer: null, answers: new Map(),
};

// The page's check of a prototype's name: the server's (src/prototypes.ts).
const TK_PROTO_NAME = /^[a-z0-9][a-z0-9-]{0,58}\.html$/;

// The prototypes of the ticket the page shows ("<ws>/<ticket>"), newest first, as the last read gave them.
const tkProtos: { key: string | null; list: PrototypeEntry[] } = { key: null, list: [] };

// A ticket's prototypes from a payload or the planner GET: each entry with a TK_PROTO_NAME name and
// a string time, in the server's order; anything else gives [].
function tkProtoList(value: unknown): PrototypeEntry[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (isRecord(entry) && typeof entry.name === 'string' && TK_PROTO_NAME.test(entry.name) && typeof entry.modified === 'string' ? [{ name: entry.name, modified: entry.modified }] : []))
    : [];
}

// The prototypes of ticket key as a payload or a read gives them: every read replaces the list.
function tkProtosSeen(key: string, value: unknown): void {
  tkProtos.key = key;
  tkProtos.list = tkProtoList(value);
}

// A prototype's page, at the root, through the dashboard's cookie: never under the token.
function tkProtoHref(key: string, name: string): string {
  return `/prototypes/${jobPath(key)}/${name}`;
}

// The ticket's prototypes in the Planning conversation card, newest first: each its time and a link
// that opens it in a new tab; nothing when the ticket has none.
function tkProtoLines(key: string): HTMLElement[] {
  const list = tkProtos.key === key ? tkProtos.list : [];
  if (list.length === 0) {
    return [];
  }
  const items = el('ul', 'hist');
  items.append(...list.map((entry) => {
    const item = el('li');
    const when = el('span', 't', day(entry.modified));
    when.setAttribute('title', entry.modified);
    item.append(when, tabLink('', `${entry.name} ↗`, tkProtoHref(key, entry.name)));
    return item;
  }));
  return [el('div', 'fs13', 'Prototypes the planner made, newest first:'), items];
}

// The header's links of the ticket's planning: the planner session's, once its hook recorded it, and
// the newest prototype's; none without either.
function tkPlannerHeadLinks(key: string): HTMLAnchorElement[] {
  const links: HTMLAnchorElement[] = [];
  const href = tkPlannerHref(tkPlanner.key === key ? tkPlanner.session : null);
  if (href !== null) {
    links.push(tabLink('btn linkbtn', 'Open the planner session ↗', href));
  }
  const newest = tkProtos.key === key ? tkProtos.list[0] : undefined;
  if (newest !== undefined) {
    const link = tabLink('btn linkbtn', `${newest.name} ↗`, tkProtoHref(key, newest.name));
    link.setAttribute('title', `The newest prototype of ${key}`);
    links.push(link);
  }
  return links;
}

// The count of the answers of Start the planner and End for ticket key so far: a read records it
// when sent.
function tkPlannerAnswers(key: string): number {
  return tkPlanner.answers.get(key) ?? 0;
}

// A session of the server's view (src/dashboard-context.ts plannerSessionView), else null.
function tkPlannerSession(value: unknown): PlannerSessionView | null {
  if (!isRecord(value)) {
    return null;
  }
  const { name, started_at: startedAt, link, result_of: resultOf } = value;
  return typeof name === 'string' && typeof startedAt === 'string' && (link === null || typeof link === 'string')
    ? { name, started_at: startedAt, link, result_of: Number.isInteger(resultOf) && typeof resultOf === 'number' && resultOf >= 0 ? resultOf : null }
    : null;
}

// The session's link, only a TK_PLANNER_LINK one.
function tkPlannerHref(session: PlannerSessionView | null): string | null {
  return session !== null && session.link !== null && TK_PLANNER_LINK.test(session.link) ? session.link : null;
}

// Whether the page shows ticket key: only then do a read and an answer of Start or End change the
// session shown (the page opened on a ticket reads its session with its payload).
function tkPlannerShows(key: string): boolean {
  return ui.screen === 'ticket' && ui.ticket === key;
}

// An answer of Start the planner or End for ticket key: it counts for that ticket whether or not the
// page shows it (a read of it sent before is not applied), and its session is shown when the page
// shows that ticket; a ticket the page left leaves the shown one, its reads and their timer alone.
function tkPlannerAnswered(key: string, session: PlannerSessionView | null): void {
  tkPlanner.answers.set(key, tkPlannerAnswers(key) + 1);
  if (tkPlannerShows(key)) {
    tkPlannerSeen(key, session);
  }
}

// The session of ticket key as a read or an answer gives it. answers: tkPlannerAnswers(key) when a
// read was sent; a read older than the ticket's last answer changes nothing (an answer passes none). Another
// ticket's session is forgotten first; one shown before and gone now has ended. While one runs, the
// next read comes after TK_PLANNER_POLL_MS, on one timer.
function tkPlannerSeen(key: string, session: PlannerSessionView | null, answers?: number): void {
  if (answers !== undefined && answers !== tkPlannerAnswers(key)) {
    return;
  }
  if (tkPlanner.key !== key) {
    tkPlanner.key = key;
    tkPlanner.session = null;
    tkPlanner.ended = false;
  }
  tkPlanner.ended = session === null && (tkPlanner.ended || tkPlanner.session !== null);
  tkPlanner.session = session;
  clearTimeout(tkPlanner.timer ?? undefined);
  tkPlanner.timer = session === null ? null : setTimeout(() => void tkPlannerRead(key), TK_PLANNER_POLL_MS);
}

// GET api/tickets/<ws>/<ticket>/planner while the page shows ticket key: none once it shows another
// ticket or page (opening it again reads the payload, and the reads go on from there); while the
// page is hidden there is no read and the timer goes on; a failed read keeps the session and the
// prototypes shown. The answer's prototypes replace the list whatever Start's and End's answers,
// once the page still shows the ticket (the answer of a ticket left never replaces another's).
async function tkPlannerRead(key: string): Promise<void> {
  tkPlanner.timer = null;
  if (!tkPlannerShows(key) || tkPlanner.key !== key) {
    return;
  }
  const answers = tkPlannerAnswers(key);
  let session = tkPlanner.session;
  // The answer's prototypes, as it gave them; none read yet.
  let prototypes: { value: unknown } | null = null;
  if (document.visibilityState !== 'hidden') {
    try {
      const answer = await getJson(`api/tickets/${jobPath(key)}/planner`);
      session = tkPlannerSession(fieldOf(answer, 'session'));
      prototypes = { value: fieldOf(answer, 'prototypes') };
    } catch { // no answer, an HTTP error or a body that is not JSON: the session and the prototypes shown stay until the next read
    }
  }
  if (tkPlannerShows(key)) {
    if (prototypes !== null) {
      tkProtosSeen(key, prototypes.value);
    }
    tkPlannerSeen(key, session, answers);
    renderTicket();
  }
}

// The session's lines in the Planning conversation card: for a ticket Claude Code plans, and for any
// ticket whose session runs or starts (so a running one can always be ended). A line, then a row
// with Open the planner session ↗ and End, or Start the planner; the line alone while it starts;
// then the ticket's prototypes (any owner).
function tkPlannerLines(key: string, row: TicketEntry): HTMLElement[] {
  const session = tkPlanner.key === key ? tkPlanner.session : null;
  const starting = state.setupPending.has(`planner:${key}`);
  if (row.owner !== 'claude_code' && session === null && !starting) {
    return tkProtoLines(key);
  }
  const line = el('p', 'fs13');
  line.setAttribute('role', 'status');
  if (starting) {
    line.textContent = `Starting the planner in the planning copy of ${row.workspace}…`;
    return [line, ...tkProtoLines(key)];
  }
  const acts = el('div', 'planner-acts');
  if (session !== null) {
    const href = tkPlannerHref(session);
    line.textContent = `Planner session "${session.name}" runs since ${day(session.started_at)}.${href === null ? ' Its link shows here once it first waits for you; until then find it under that name in the Claude app or on claude.ai/code.' : ''}`;
    if (href !== null) {
      acts.append(tabLink('btn small linkbtn', 'Open the planner session ↗', href));
    }
    const stopping = state.setupPending.has(`planner-stop:${key}`);
    const end = button('btn small', stopping ? 'Ending…' : 'End', { tk: 'planner-stop' });
    end.disabled = stopping;
    end.setAttribute('title', 'End this Claude Code session (asks first)');
    acts.append(end);
  } else {
    line.textContent = tkPlanner.key === key && tkPlanner.ended ? 'The planner session ended.' : 'No planner session runs.';
    const start = button('btn small', 'Start the planner', { tk: 'planner-start' });
    start.setAttribute('title', `Starts Claude Code with Remote Control in the planning copy of ${row.workspace}, with /planning-tasks workspace ${row.workspace}, ticket ${row.ticket}`);
    acts.append(start);
  }
  return [line, acts, ...tkProtoLines(key)];
}

// Start the planner, and Create & plan with Claude Code (setup.js): POST
// api/tickets/<ws>/<ticket>/planner with {}, once at a time (tkPost); the answer's session is shown
// at once while the page shows the ticket, a refusal goes to the toast.
function tkPlannerStart(key: string): Promise<void> {
  return tkPost(`planner:${key}`, `api/tickets/${jobPath(key)}/planner`, {}, (result) => {
    tkPlannerAnswered(key, tkPlannerSession(fieldOf(result, 'session')));
    return fieldOf(result, 'started') === false ? `The planner of ${key} runs already.` : `The planner of ${key} started.`;
  }, 'Starting the planner failed');
}

// End, once confirmed (setup.js submitTicketConfirm): POST .../planner/stop with {}, once at a time
// (tkPost); the page then shows the session ended, while it shows the ticket.
function tkPlannerStop(key: string): Promise<void> {
  return tkPost(`planner-stop:${key}`, `api/tickets/${jobPath(key)}/planner/stop`, {}, (result) => {
    tkPlannerAnswered(key, null);
    return tkPlannerSession(fieldOf(result, 'stopped')) === null ? `No planner of ${key} was running.` : `Ended the planner of ${key}.`;
  }, 'Ending the planner failed');
}

// ---------- Discuss the result on the job page of a waiting job Claude Code plans ----------

// The planner session of the waiting job the job page shows, apart from tkPlanner (the ticket
// page's): its job ("<ws>/<ticket>") and iteration, the session as last read or answered (null:
// none runs), whether a read is out, the timer of the next read, per job key the count of the
// answers of Discuss the result (a read sent before the last one is not applied), and the count of
// the times the page left the job (visits: a read sent before the last one is dropped whole).
const jobPlanner: { key: string | null; iteration: number | null; session: PlannerSessionView | null; reading: boolean; timer: ReturnType<typeof setTimeout> | null; answers: Map<string, number>; visits: number } = {
  key: null, iteration: null, session: null, reading: false, timer: null, answers: new Map(), visits: 0,
};

// Whether the job page shows job key (its Stream, Changes or Merge request screen) and it is a job
// Claude Code plans that waits for the user: only then is its session read.
function jobPlannerShows(key: string): boolean {
  if (ui.job !== key || !['stream', 'changes', 'mr'].includes(ui.screen)) {
    return false;
  }
  const planner = shownJob()?.planner;
  return planner?.owner === 'claude_code' && planner.discuss !== null;
}

// The job page draws the planner block of a waiting job Claude Code plans (renderPlanner, its one
// caller): another job's state is dropped and a read starts; the same job at another iteration
// reads at once, its session kept; else a read only when none is out and no timer is armed, so a
// redraw sends nothing (leaving the job and coming back finds the timer gone and reads at once).
function jobPlannerWatch(job: JobRow): void {
  const key = keyOf(job);
  if (jobPlanner.key !== key) {
    clearTimeout(jobPlanner.timer ?? undefined);
    Object.assign(jobPlanner, { key, iteration: job.iteration, session: null, reading: false, timer: null });
  } else if (jobPlanner.iteration !== job.iteration) {
    clearTimeout(jobPlanner.timer ?? undefined);
    Object.assign(jobPlanner, { iteration: job.iteration, timer: null });
  } else if (jobPlanner.timer !== null || jobPlanner.reading) {
    return;
  }
  void jobPlannerRead(key);
}

// The job page draws its planner block without a waiting job Claude Code plans: no job's detail
// (select clears it each time the page opens a job, so leaving a job and coming back passes here),
// or a job that does not wait or that ChatGPT plans. The page has left the job of jobPlanner: the
// timer is cleared, no read counts as out, and a read sent before is dropped whole when it answers;
// the session shown stays until the next read.
function jobPlannerLeave(): void {
  clearTimeout(jobPlanner.timer ?? undefined);
  Object.assign(jobPlanner, { timer: null, reading: false, visits: jobPlanner.visits + 1 });
}

// The next read of job key's session, after TK_PLANNER_POLL_MS, on one timer.
function jobPlannerArm(key: string): void {
  clearTimeout(jobPlanner.timer ?? undefined);
  jobPlanner.timer = setTimeout(() => void jobPlannerRead(key), TK_PLANNER_POLL_MS);
}

// GET api/tickets/<ws>/<ticket>/planner while the job page shows job key waiting: none once it
// shows another job or page, or the job no longer waits (no timer either); while the page is
// hidden no read, the timer goes on. An answer that comes once the page left the job (another job,
// another page, the job left and opened again, or the job no longer waiting) is dropped whole: no
// change of the session, the read out, the timer or the page; else its session replaces the one
// shown unless an answer of Discuss the result came after it was sent (a failed read keeps what is
// shown), and the next read is armed.
async function jobPlannerRead(key: string): Promise<void> {
  jobPlanner.timer = null;
  if (jobPlanner.key !== key || !jobPlannerShows(key)) {
    return;
  }
  if (document.visibilityState === 'hidden') {
    jobPlannerArm(key);
    return;
  }
  jobPlanner.reading = true;
  const answers = jobPlanner.answers.get(key) ?? 0;
  const visits = jobPlanner.visits;
  // The answer's session, once read.
  let read: { session: PlannerSessionView | null } | null = null;
  try {
    read = { session: tkPlannerSession(fieldOf(await getJson(`api/tickets/${jobPath(key)}/planner`), 'session')) };
  } catch { // no answer, an HTTP error or a body that is not JSON: the session shown stays until the next read
  }
  if (jobPlanner.key !== key || jobPlanner.visits !== visits || !jobPlannerShows(key)) {
    return;
  }
  jobPlanner.reading = false;
  if (read !== null && answers === (jobPlanner.answers.get(key) ?? 0)) {
    jobPlanner.session = read.session;
  }
  jobPlannerArm(key);
  renderComposer();
}

// Discuss the result without a session: POST api/tickets/<ws>/<ticket>/planner/discuss with {},
// once at a time (state.setupPending "discuss:<key>"), the composer drawn before and after. Its
// answer counts for the job (a read sent before is not applied) and, while the page shows the
// job, its session is shown and the next read comes TK_PLANNER_POLL_MS later; the outcome goes
// to the toast.
async function jobPlannerDiscuss(key: string): Promise<void> {
  const id = `discuss:${key}`;
  if (state.setupPending.has(id)) {
    return;
  }
  state.setupPending.add(id);
  renderComposer();
  let outcome: Outcome;
  try {
    const result = await post(`api/tickets/${jobPath(key)}/planner/discuss`, {});
    const session = tkPlannerSession(fieldOf(result, 'session'));
    jobPlanner.answers.set(key, (jobPlanner.answers.get(key) ?? 0) + 1);
    if (jobPlanner.key === key && jobPlannerShows(key)) {
      jobPlanner.session = session;
      jobPlannerArm(key);
    }
    const text = fieldOf(result, 'started') !== false
      ? `The planner of ${key} started with the message about the result: it reads the job and sums it up. Its link shows here once it first waits for you.`
      : tkPlannerHref(session) !== null ? `The planner of ${key} runs already: Discuss the result opens it.` : `The planner of ${key} runs already; its link shows here once it first waits for you.`;
    outcome = { level: 'ok', text };
  } catch (error) {
    outcome = { level: 'error', text: error instanceof ActionError ? `${error.code}: ${error.message}` : `Starting the planner failed (${errorMessage(error)}); it may have started.` };
  }
  state.setupPending.delete(id);
  toast(outcome);
  renderComposer();
}

// Discuss the result of a waiting job Claude Code plans, in the planner block (inMenu false) or as
// a ready job's More ▾ items (inMenu true). No session known: the button that starts one (its
// label while the start is out). A session with a TK_PLANNER_LINK link: that link in a new tab; the
// click copies the message to paste, unless the session was started on this iteration's result.
// Any other session: the line that it runs (in More ▾ the note of a disabled item), then Copy the
// message for the planner unless it was started on this result.
function jobPlannerControls(job: JobRow, inMenu: boolean): HTMLElement[] {
  const key = keyOf(job);
  const session = jobPlanner.key === key ? jobPlanner.session : null;
  if (session === null) {
    const posting = state.setupPending.has(`discuss:${key}`);
    const start = button(inMenu ? 'ho-item' : 'btn small', posting ? 'Starting the planner…' : 'Discuss the result', { act: 'planner-discuss' });
    start.id = 'planner-discuss-button';
    start.disabled = posting;
    start.setAttribute('title', `Starts the planner in the planning copy of ${job.workspace} with the message about the result`);
    return [start];
  }
  const fresh = session.result_of === job.iteration;
  const href = tkPlannerHref(session);
  if (href !== null) {
    const link = tabLink(inMenu ? 'ho-item' : 'fs13', 'Discuss the result ↗', href);
    link.id = 'planner-discuss-link';
    const message = job.planner.discuss?.message;
    if (!fresh && typeof message === 'string') {
      // The copy happens in the click, which the browser allows; the link opens the tab as well.
      link.addEventListener('click', () => copyValue(message, byIdAs('planner-copy-text', 'textarea'), (text) => toast({ level: 'info', text: `${text} The message for the planner: paste it into the session.` })));
    }
    link.setAttribute('title', fresh ? 'Opens the planner session, which got the message about this result' : 'Opens the planner session; the message about the result is copied, to paste there');
    return [link];
  }
  const text = `Planner session "${session.name}" runs; its link shows here once it first waits for you, or find it under that name in the Claude app or on claude.ai/code.`;
  const copy = fresh ? [] : [button(inMenu ? 'ho-item' : 'btn small', 'Copy the message for the planner', { act: 'planner-copy' })];
  if (inMenu) {
    const item = button('ho-item', 'Discuss the result');
    item.disabled = true;
    item.append(el('span', 'muted', text));
    return [item, ...copy];
  }
  const line = el('p', 'fs13', text);
  line.setAttribute('role', 'status');
  return [line, ...copy];
}
