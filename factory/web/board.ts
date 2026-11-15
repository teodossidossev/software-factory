// board.js, the dashboard's fifth script (DASHBOARD_SCRIPTS in src/dashboard.ts), built from
// web/board.ts into dist/web/: the board, the workspaces and dependencies on it, its cards,
// the queue and the toast. A classic script, loaded in order with defer, sharing the page's globals
// with the others. This file has no import or export on purpose: the compiler keeps it a script, so
// its top-level names stay the page's globals.
'use strict';

// ---------- The board (the v3 board of docs/design/dashboard-v3/prototype.html) ----------

// The columns of the board; a job is in any but the Queue.
type Column = 'queue' | 'implementing' | 'reviewing' | 'you' | 'done';
type JobColumn = Exclude<Column, 'queue'>;
// The column of each job state; the tickets without a live job are in the Queue. One column per
// ticket: a ticket whose last job failed or was aborted is in the Queue (to start again),
// not also in Done; a pushed one is only in Done.
const COLUMN_OF: Readonly<Record<JobState, JobColumn>> = {
  starting: 'implementing', working: 'implementing', waiting_limit: 'implementing',
  awaiting_review: 'reviewing', preparing_mr: 'reviewing',
  needs_human: 'you', ready_for_human_review: 'you', handed_over: 'you', paused: 'you',
  pushed: 'done', aborted: 'done', failed: 'done',
};
const COLUMNS: readonly Column[] = ['queue', 'implementing', 'reviewing', 'you', 'done'];
// A name of COLUMNS (a stored one, a heading's data-colfold).
const isColumn = (name: unknown): name is Column => COLUMNS.some((column) => column === name);
// The list of each column: #qlist as the prototype's Queue, #list-<column> for the others.
const LIST_OF: Readonly<Record<Column, string>> = { queue: 'qlist', implementing: 'list-implementing', reviewing: 'list-reviewing', you: 'list-you', done: 'list-done' };
// Without the run queue the Queue column lists the planned tickets, with its empty text.
const EMPTY_TEXT: Readonly<Record<'planned' | JobColumn, string>> = { planned: 'No ticket waits to start.', implementing: 'Nothing is being implemented.', reviewing: 'Nothing is in review.', you: 'Nothing waits for you.', done: 'No finished job.' };
// The element an event's target is in that matches the selector, or null (a target that is no
// element too; the tests' fake events may have none, undefined).
const closestOf = (target: EventTarget | null | undefined, selector: string): HTMLElement | null => (target !== undefined && isElement(target) ? target.closest<HTMLElement>(selector) : null);
// A field of a setup request's result (setupRequest's describe), undefined for anything but an object.
const fieldOf = (data: unknown, name: string): unknown => (isRecord(data) ? data[name] : undefined);
// A ticket in the run queue: it has its position.
const isQueued = (row: TicketRow): row is QueuedRow => Number.isInteger(row.queue_position);

// The run queue: the Queue column's text without a queued ticket.
const QUEUE_EMPTY = 'The queue is empty: add a ticket below.';
// Done shows the most recent jobs; "Show all" shows the rest.
const DONE_LIMIT = 8;
const DONE_LABELS: Readonly<Partial<Record<JobState, string>>> = { pushed: 'Pushed', aborted: 'Aborted', failed: 'Failed' };
const RESTARTABLE: readonly JobState[] = ['failed', 'aborted'];
// The states of a running card: the Now line, the tool calls, the cost "so far"; a job parked on a
// usage limit holds its slot and counts as running, with a card of its own.
const RUNNING: readonly JobState[] = ['starting', 'working', 'awaiting_review', 'preparing_mr', 'waiting_limit'];
// While a card runs and the page is visible, api/jobs is read again this often.
const REFRESH_MS = 15000;
// An ok or info message of the toast goes after this long, unless the pointer is on it.
const TOAST_MS = 6000;

// The job can be pushed: the branch prepared at Clean is ready, or its push failed and approve
// tries again.
const canApprove = (job: JobRow): boolean => job.state === 'ready_for_human_review' || job.state === 'handed_over' || (job.state === 'needs_human' && typeof job.prepared_commit === 'string');

// The hand-over: the line of a job in the user's checkout, and why a job ready for review
// was not handed over ('' when it was not refused).
const checkoutLine = (job: JobRow): string => `In your checkout on ${job.branch}`;
const skippedNote = (job: JobRow): string => (job.handoff_skipped !== null && typeof job.handoff_skipped === 'object' ? `Not handed over to your checkout: ${job.handoff_skipped.message} ` : '');

// The merge request on the Git host: the job has one; Create merge request applies to a
// branch ready to approve (push, then open) and to a pushed one without an open or merged one;
// Merge to an open one. mrOff: why the actions are off for the job's workspace, or ''.
const hasMr = (job: JobRow): job is JobRow & { mr: JobMr } => job.mr !== null && typeof job.mr === 'object';
const canCreateMr = (job: JobRow): boolean => canApprove(job) || (job.state === 'pushed' && !(hasMr(job) && job.mr.state !== 'closed'));
const canMerge = (job: JobRow): boolean => job.state === 'pushed' && hasMr(job) && job.mr.state === 'open';
const mrOff = (job: JobRow): string => (job.mr_host === null || typeof job.mr_host !== 'object' ? 'the Git host is not known yet.'
  : typeof job.mr_host.reason === 'string' && job.mr_host.reason !== '' ? `${job.mr_host.reason}.` : '');

// The iteration a job shows, numbered from 1, the same on its card and on its page: the one under
// way while the Implementer works on it (starting, working, paused in its turn, stopped by its
// session), else the last one published; never 0.
const SESSION_CODES: readonly string[] = ['serve_restarted', 'session_failed', 'turn_failed', 'max_turns', 'sandbox_unavailable', 'permission_mode_mismatch', 'publish_failed'];
function shownIteration(job: JobRow): number {
  const underWay = job.state === 'starting' || job.state === 'working' || (job.availability?.resume === '' && job.paused?.step === 'turn')
    || (job.state === 'needs_human' && SESSION_CODES.includes(job.error?.code ?? ''));
  return Math.max(1, underWay ? job.iteration + 1 : job.iteration);
}

// The number of things a stopped job waits on (the jobs payload's stop.items); null when not known.
const stopCount = (job: JobRow): number | null => (Array.isArray(job.stop?.items) ? job.stop.items.length : null);
// The first line of the job's error message, after ": ", or nothing.
const said = (job: JobRow): string => (firstLine(job.error?.message) === '' ? '' : `: ${firstLine(job.error?.message).replace(/\.$/, '')}`);
// When the Claude usage limit of a usage_limit stop resets ("You've hit your … limit · resets 3am (Europe/Sofia)").
const resetTime = (job: JobRow): string | null => /resets\s+(.+)$/i.exec(firstLine(job.error?.message))?.[1] ?? null;
// How the last run of a tests_failed stop ended: "exit 1" or "timed out after 30 min" of its message.
const testsEnding = (job: JobRow): string | null => /\((exit -?\d+|timed out after [^)]+)\) on iteration/.exec(firstLine(job.error?.message))?.[1] ?? null;
// The buttons of a ledger entry to settle: the words of src/stops.ts's SETTLE_LABELS, which the
// explanation's answers name too ("Must fix (R5)").
const SETTLE_LABELS = { accept: 'Accept risk', fix: 'Must fix' } as const;
const SETTLE_CHOICE = `${SETTLE_LABELS.accept} or ${SETTLE_LABELS.fix}`;

// The words of each stop for the cards and the job page (its header, its stop block and
// its composer), keyed by the server's stop_code (the rows of factory/src/stops.ts;
// a stop's kind is the payload's stop_kind, so a decision never shows as an error). Each entry:
// the card's reason, the sentence (with the job's numbers, or the words without one that is not
// known) and the card's button. N, M, X and T come from the job.
const STOPS = {
  simplify_offered: {
    reason: 'Simplification offered', button: () => 'Simplify or skip',
    sentence: (job: JobRow) => (stopCount(job) !== null && typeof job.stop?.saves_lines === 'number'
      ? `The simplification pass suggests ${counted(stopCount(job) ?? 0, 'change')} (saves about ${counted(job.stop.saves_lines, 'line')}). Simplify or skip.`
      : 'The simplification pass suggests changes. Simplify or skip.'),
  },
  escalated: {
    reason: 'Question for you',
    button: (job: JobRow) => (stopCount(job) ? `Answer ${counted(stopCount(job) ?? 0, 'question')}` : 'Answer the questions'),
    sentence: (job: JobRow) => `The Implementer asks you about ${stopCount(job) ? counted(stopCount(job) ?? 0, 'finding') : 'findings'}. Answer each: ${SETTLE_CHOICE}.`,
  },
  review_disputed: {
    reason: 'A reviewer disputes a contest',
    button: (job: JobRow) => (stopCount(job) ? `Settle ${counted(stopCount(job) ?? 0, 'finding')}` : 'Settle the findings'),
    sentence: (job: JobRow) => `A reviewer reopened ${stopCount(job) ? counted(stopCount(job) ?? 0, 'finding') : 'findings'} the Implementer contested. Settle each: ${SETTLE_CHOICE}.`,
  },
  review_churn: {
    reason: 'Fixes keep making findings',
    button: (job: JobRow) => (stopCount(job) ? `Decide ${counted(stopCount(job) ?? 0, 'finding')}` : 'Decide the findings'),
    sentence: (job: JobRow) => `The fixes keep making new findings${stopCount(job) !== null ? ` (${stopCount(job)} open)` : ''}. Accept the change as it is, or tell the Implementer what to fix.`,
  },
  gate_rounds: {
    reason: 'Codex round limit reached',
    button: (job: JobRow) => (stopCount(job) ? `Decide ${counted(stopCount(job) ?? 0, 'finding')}` : 'Decide the findings'),
    sentence: (job: JobRow) => `${typeof job.gate_fixes === 'number' ? `Codex asked for fixes ${counted(job.gate_fixes, 'time')}, the limit.` : 'Codex asked for fixes as often as the limit allows.'} Accept the change without its ${stopCount(job) !== null ? counted(stopCount(job) ?? 0, 'open finding') : 'open findings'}, or tell the Implementer what to fix.`,
  },
  gate_budget: {
    reason: 'Codex token budget used up', button: () => 'Decide',
    sentence: (job: JobRow) => `The Codex gate used its token budget for this job. ${claudeOn(job) ? "Accept the change with Claude's clean review" : 'Accept the change, which no reviewer passed'}, or tell the Implementer what to do.`,
  },
  iteration_limit: {
    reason: 'Fix round limit reached', button: () => 'Give a direction',
    sentence: (job: JobRow) => `${typeof job.fixes === 'number' ? `The reviewers asked for fixes ${counted(job.fixes, 'time')}, the limit.` : 'The reviewers asked for fixes as often as the limit allows.'} Accept the change with its open findings listed in the MR text, give the Implementer a direction, or abort.`,
  },
  tests_failed: {
    reason: 'Tests keep failing', button: () => 'Decide',
    sentence: (job: JobRow) => `The workspace's tests still fail after the Tests Fix rounds${testsEnding(job) !== null ? ` (${testsEnding(job)})` : ''}. Accept the change without passing tests, or tell the Implementer what to do.`,
  },
  tests_unavailable: {
    reason: 'Tests could not run', button: (job: JobRow) => (retryOn(job) ? 'Retry' : 'Decide'),
    sentence: (job: JobRow) => `The workspace's tests could not run${said(job)}. Fix it on this machine and Retry, or accept without tests.`,
  },
  builds_on_not_ready: {
    reason: 'The part it builds on is being changed', button: (job: JobRow) => (retryOn(job) ? 'Retry' : 'Tell it to go on'),
    sentence: (job: JobRow) => `The MR preparation waits for the part this one builds on${said(job)}.`,
  },
  max_turns: {
    reason: 'Turn limit reached', button: () => 'Tell it to go on',
    sentence: (job: JobRow) => `The Implementer used all its turns on iteration ${shownIteration(job)}. Tell it to go on.`,
  },
  gate_failed: {
    reason: 'Codex gate gave no verdict', button: () => 'Decide',
    sentence: (job: JobRow) => `The Codex gate stopped without a verdict. ${claudeOn(job) ? "Accept with Claude's clean review" : 'Accept the change, which no reviewer passed'}, or tell the Implementer to go on.`,
  },
  review_failed: {
    reason: 'Claude review could not run', button: () => 'Retry review',
    sentence: (job: JobRow) => `The Claude review of iteration ${shownIteration(job)} could not run. Retry it.`,
  },
  serve_restarted: {
    reason: 'Interrupted by a restart', button: () => 'Tell it to go on',
    sentence: (job: JobRow) => `sf serve restarted while iteration ${shownIteration(job)} ran. Tell the Implementer to go on.`,
  },
  mr_serve_restarted: {
    reason: 'MR preparation interrupted', button: (job: JobRow) => (retryOn(job) ? 'Retry' : 'Tell it to go on'),
    sentence: (job: JobRow) => (retryOn(job)
      ? 'The MR preparation was interrupted. Retry prepares the MR again without a new review; Tell it to go on reviews the iteration again.'
      : 'The MR preparation was interrupted. Tell the Implementer to go on: the iteration is reviewed again and the MR is prepared again.'),
  },
  // session_failed with the usage-limit message.
  usage_limit: {
    reason: 'Usage limit reached', button: () => 'Tell it to go on',
    sentence: (job: JobRow) => `The Claude usage limit was reached${resetTime(job) !== null ? `; it resets at ${resetTime(job)}` : ''}. Tell the Implementer to go on after that.`,
  },
  session_failed: {
    reason: 'Implementer session failed', button: () => 'Tell it to go on',
    sentence: (job: JobRow) => `The Implementer's session failed${said(job)}. Tell it to go on, or restart.`,
  },
  sandbox_unavailable: {
    reason: 'Sandbox unavailable', button: () => 'Tell it to go on',
    sentence: (job: JobRow) => `The Implementer's sandbox could not start${said(job)}. Fix it on this machine, then tell it to go on.`,
  },
  publish_failed: {
    reason: 'Iteration not published', button: () => 'Tell it to go on',
    sentence: (job: JobRow) => `The factory could not publish the Report and Patch of iteration ${shownIteration(job)}. Tell it to go on to try again.`,
  },
  mr_conflict: {
    reason: 'Rebase conflict', button: () => 'Tell it how',
    sentence: (job: JobRow) => `The rebase onto ${job.base} conflicts and the Implementer could not resolve it. Tell it how, or abort.`,
  },
  implementer_question: {
    reason: 'Question for you before any change', button: () => 'Answer',
    sentence: () => 'The Implementer changed nothing and asks you something. Read the question and answer with Send.',
  },
  mr_text_missing: {
    reason: 'MR text missing or invalid', button: () => 'Tell it to fix it',
    sentence: (job: JobRow) => `The Implementer's MR text is missing or breaks a rule${said(job)}. Tell it to write it again.`,
  },
  mr_empty: {
    reason: 'Nothing to commit', button: () => 'Tell it what is missing',
    sentence: (job: JobRow) => `The reviewed change has nothing to commit against ${job.base}. Tell the Implementer what is missing, or abort.`,
  },
  mr_failed: {
    reason: 'MR preparation failed', button: (job: JobRow) => (retryOn(job) ? 'Retry' : 'Tell it to go on'),
    sentence: (job: JobRow) => (retryOn(job)
      ? `The MR preparation failed${said(job)}. Retry prepares the MR again without a new review; Tell it to go on reviews the iteration again.`
      : `The MR preparation failed${said(job)}. Tell the Implementer to go on (the iteration is reviewed again), or abort.`),
  },
  fetch_failed: {
    reason: 'Fetch failed', button: (job: JobRow) => (retryOn(job) ? 'Retry' : 'Tell it to go on'),
    sentence: (job: JobRow) => `Git could not fetch ${job.base} from origin after the clean review. ${retryOn(job) ? 'Retry when the network is back.' : 'Tell the Implementer to go on when the network is back (the iteration is reviewed again).'}`,
  },
  // The guard's stops of MR preparation: guard_hit, guard_terms_invalid, guard_failed.
  guard_hit: {
    reason: 'Guard stopped the MR', button: (job: JobRow) => (retryOn(job) ? 'Retry' : 'Tell it how'),
    sentence: (job: JobRow) => `The guard stopped MR preparation${said(job)}. ${retryOn(job) ? 'Retry runs it again' : 'Tell the Implementer how to go on'}, or abort.`,
  },
  worktree_remove_failed: {
    reason: 'Worktree not removed', button: () => 'Tell it to go on',
    sentence: (job: JobRow) => `The branch is prepared, but its worktree could not be removed${said(job)}. Remove it by hand, then tell the Implementer to go on.`,
  },
  mr_push_failed: {
    reason: 'Push failed', button: () => 'Push again',
    sentence: (job: JobRow) => `The push of ${job.branch} failed${said(job)}. Fix the cause, then push again.`,
  },
  mr_push_protected: {
    reason: 'Push refused', button: () => 'Open the job',
    sentence: (job: JobRow) => `The factory never pushes to ${job.branch}. Rename the branch on the Merge request screen, or abort.`,
  },
  // Any other code.
  other: {
    reason: 'Stopped', button: () => 'Open the job',
    sentence: (job: JobRow) => `The job stopped${said(job)}. Tell the Implementer what to do, or abort.`,
  },
};
// The words of a stop: an entry of STOPS.
interface StopWords {
  reason: string;
  button: (job: JobRow) => string;
  sentence: (job: JobRow) => string;
}
// A code with an entry of STOPS.
const isStopCode = (code: unknown): code is keyof typeof STOPS => typeof code === 'string' && Object.hasOwn(STOPS, code);
// The entry of STOPS for a stop's canonical code (the server's stop_code).
function stopEntry(code: unknown): StopWords {
  return isStopCode(code) ? STOPS[code] : STOPS.other;
}

// The sentence of a job's state, as the job page's header says it.
function sentence(job: JobRow): string {
  const it = shownIteration(job);
  switch (job.state) {
    case 'starting':
      return 'The worktree is being created and the Implementer starts';
    case 'working':
      return `The Implementer is working on iteration ${it}`;
    case 'paused':
      return `Paused by you during iteration ${it}`;
    case 'waiting_limit': {
      // Parked on a usage limit.
      const who = LIMIT_PROVIDERS[job.limit?.provider ?? ''] ?? 'The';
      if (job.limit?.reset_seen === true) {
        return `The ${who} usage limit reset during iteration ${it}; the job waits for you`;
      }
      return `Waiting for limits: the ${who} usage limit resets at ${limitClock(job) ?? 'its reset'} (iteration ${it})`;
    }
    case 'awaiting_review':
      return claudeOn(job) ? `Claude and Codex are reviewing iteration ${it}` : `The Codex gate is reviewing iteration ${it}`;
    case 'preparing_mr':
      return 'Writing the MR text';
    case 'needs_human':
      return stopEntry(job.stop_code).sentence(job).replace(/\.$/, '');
    case 'ready_for_human_review':
      return 'Reviews are clean and the MR text is written. Push when you are happy';
    case 'handed_over':
      // The branch waits in the user's checkout.
      return checkoutLine(job);
    case 'pushed':
      return `Pushed at ${clock(job.updated_at)}`;
    case 'aborted':
      return 'Aborted by you. The branch stays';
    default:
      return DONE_LABELS[job.state] ?? job.state;
  }
}

// Who acts now on a running job and what it does: the jobs payload's now, or what the state says
// while the log has nothing yet.
function nowLine(job: JobRow): { who: string; what: string } {
  if (job.now !== null && typeof job.now === 'object' && typeof job.now.who === 'string') {
    return { who: job.now.who, what: String(job.now.what ?? '') };
  }
  if (job.state === 'awaiting_review') {
    return { who: !claudeOn(job) || job.review === 'clean' ? 'Codex gate' : 'Claude review', what: `reviewing iteration ${job.iteration}` };
  }
  if (job.state === 'preparing_mr') {
    return { who: 'MR writer', what: 'writing the MR text' };
  }
  return { who: 'Implementer', what: 'starting' };
}

const jobByKey = (key: string | null): JobRow | null => state.jobs.find((job) => keyOf(job) === key) ?? null;
const ticketByKey = (key: string | null): TicketRow | null => (state.tickets ?? []).find((row) => keyOf(row) === key) ?? null;
const titleOf = (job: JobRow): string => (typeof job.title === 'string' && job.title !== '' ? job.title : job.branch);

// The dependency graph: "<ws>/<ticket>" -> its lands_after rows, and -> the keys that wait for it.
interface DependencyGraph {
  deps: Map<string, DependencyRow[]>;
  needed: Map<string, string[]>;
}
// What the cards need of the board as a whole: the dependency graph.
// The board's folded columns: names of COLUMNS, kept in localStorage.
const board: { graph: DependencyGraph; folded: Set<string> } = { graph: { deps: new Map(), needed: new Map() }, folded: new Set() };
const FOLD_KEY = 'sf-board-folded';

// The folded columns stored before: the names of COLUMNS of a stored array, else none.
function readFolds(): Set<string> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(store.get(FOLD_KEY) ?? 'null');
  } catch { // unparseable: nothing folded
  }
  return new Set<string>(Array.isArray(parsed) ? parsed.filter(isColumn) : []);
}
const storeFolds = (): void => store.set(FOLD_KEY, JSON.stringify(COLUMNS.filter((name) => board.folded.has(name))));

// Each column heading's fold mark and aria-expanded, and its column's folded class.
function applyFolds(): void {
  for (const name of COLUMNS) {
    const fold = document.querySelector(`[data-colfold="${name}"]`);
    if (fold === null) {
      continue;
    }
    const folded = board.folded.has(name);
    fold.setAttribute('aria-expanded', String(!folded));
    fold.closest('.col')?.classList.toggle('folded', folded);
  }
}

// A column heading's click: its column folds or unfolds, at every width.
function toggleFold(name: unknown): void {
  if (!isColumn(name)) {
    return;
  }
  if (board.folded.has(name)) {
    board.folded.delete(name);
  } else {
    board.folded.add(name);
  }
  storeFolds();
  applyFolds();
}

// ---------- Workspaces and dependencies on the board ----------

// The workspace palette: the --ws-<name> tokens of app.css. The server sends each workspace's
// colour (its own, else the one its name picks); the page only reads it.
const WS_COLORS: readonly string[] = ['blue', 'teal', 'green', 'olive', 'orange', 'red', 'purple', 'grey'];
// The longest workspace name a chip shows whole; a longer one is shortened in the middle.
const WS_NAME_CHARS = 16;

// The colour class of a workspace ("ws-teal"), or '' when the registry does not list it.
function wsClass(name: string): string {
  const color = (state.workspaces ?? []).find((row) => row.name === name)?.color;
  return color !== undefined && WS_COLORS.includes(color) ? `ws-${color}` : '';
}

// A long workspace name shortened in the middle: "very-long…ace-name"; the full name is the title.
const shortName = (name: string): string => (name.length <= WS_NAME_CHARS ? name : `${name.slice(0, 7)}…${name.slice(-(WS_NAME_CHARS - 8))}`);

// The workspace's colour dot (decoration: the name always goes with it).
function wsDot(name: string): HTMLElement {
  const dot = el('i', `wsdot ${wsClass(name)}`.trim());
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

// The workspace chip of a card's first line and the job page header: the dot and the name.
function wsChip(name: string): HTMLElement {
  const chip = el('span', `wschip ${wsClass(name)}`.trim());
  chip.setAttribute('title', `Workspace ${name}`);
  chip.append(wsDot(name), el('span', 'wsname', shortName(name)));
  return chip;
}

// A dependency's state as a mark and in words (the mark is never the only signal: the title and
// the label say it).
const DEP_MARK: Readonly<Record<DependencyState, string>> = { merged: '✓', pushed: '⧗', running: '⧗', planned: '⧗', missing: '✗' };
const DEP_WORD: Readonly<Record<DependencyState, string>> = { merged: 'merged', pushed: 'pushed, not merged yet', running: 'running', planned: 'planned, not started', missing: 'no Task file and no job' };
const depState = (dep: DependencyRow): DependencyState => (Object.hasOwn(DEP_MARK, dep.state) ? dep.state : 'missing');
// The key a card shows for another ticket: the ticket alone in the same workspace.
const depLabel = (key: string, workspace: string): string => (key.startsWith(`${workspace}/`) ? key.slice(workspace.length + 1) : key);

// The tickets the live jobs' Task files land after (state.jobLandsAfter, main.js: the tickets
// payload's job_lands_after, else []), which core.ts's state leaves unknown.
const jobLandsAfter = (): JobDependencies[] => state.jobLandsAfter as JobDependencies[];

// The dependency graph: "<ws>/<ticket>" -> its lands_after rows (the tickets of the Queue and the
// Done cards with a Task file, and the live jobs' Task files), and the reverse: who waits for it.
function dependencyGraph(): DependencyGraph {
  const deps = new Map<string, DependencyRow[]>();
  for (const row of [...(state.tickets ?? []), ...jobLandsAfter()]) {
    if (Array.isArray(row.lands_after) && row.lands_after.length > 0) {
      deps.set(keyOf(row), row.lands_after);
    }
  }
  const needed = new Map<string, string[]>();
  for (const [key, rows] of deps) {
    for (const dep of rows) {
      const target = keyOf(dep);
      needed.set(target, [...(needed.get(target) ?? []), key]);
    }
  }
  return { deps, needed };
}

// The shortest cycle through key ("A → B → A" as keys), or null: a breadth-first walk over what
// key waits for, each ticket visited once, so a loop of any length ends.
function cycleThrough(key: string, deps: ReadonlyMap<string, DependencyRow[]>): string[] | null {
  const parent = new Map<string, string | null>([[key, null]]);
  const queue = [key];
  while (queue.length > 0) {
    const at = queue.shift();
    // Never: the queue is not empty.
    if (at === undefined) {
      break;
    }
    for (const dep of deps.get(at) ?? []) {
      const next = keyOf(dep);
      if (next === key) {
        const path: string[] = [];
        // Every key walked has its parent (null for key).
        for (let step: string | null = at; step !== null; step = parent.get(step) ?? null) {
          path.unshift(step);
        }
        return [...path, key];
      }
      if (!parent.has(next)) {
        parent.set(next, at);
        queue.push(next);
      }
    }
  }
  return null;
}

// A chip of another ticket: a click scrolls to its card and focuses it.
function depChip(key: string, workspace: string, stateName?: DependencyState): HTMLButtonElement {
  const label = depLabel(key, workspace);
  const chip = button(stateName === undefined ? 'dchip' : `dchip dep-${stateName}`, undefined, { dep: key });
  if (stateName !== undefined) {
    chip.append(el('span', 'mk', DEP_MARK[stateName]), document.createTextNode(' '));
  }
  chip.append(document.createTextNode(label));
  chip.setAttribute('title', stateName === undefined ? `${key}: show its card` : `${key}: ${DEP_WORD[stateName]}`);
  return chip;
}

// The dependency lines of a card or the job page header, each null when it does not apply: Waits
// for (only while one is not merged), Needed by, and a cycle in the error colour; lines: those that
// apply, in that order; open: the keys not merged yet, for Start's title.
function dependencyLines(key: string, graph: DependencyGraph, className: 'div' | 'span'): { waits: HTMLElement | null; needed: HTMLElement | null; cycle: HTMLElement | null; lines: HTMLElement[]; open: string[] } {
  const workspace = key.slice(0, key.indexOf('/'));
  const deps = graph.deps.get(key) ?? [];
  const open = deps.filter((dep) => depState(dep) !== 'merged').map(keyOf);
  let waits = null;
  if (open.length > 0) {
    waits = el(className, 'deps waits');
    waits.append(el('span', 'lbl', 'Waits for'), ...deps.map((dep) => depChip(keyOf(dep), workspace, depState(dep))));
  }
  const dependents = graph.needed.get(key) ?? [];
  let needed = null;
  if (dependents.length > 0) {
    needed = el(className, 'deps needed');
    needed.append(el('span', 'lbl', 'Needed by'), ...dependents.map((other) => depChip(other, workspace)));
  }
  const path = deps.length > 0 ? cycleThrough(key, graph.deps) : null;
  const cycle = path === null ? null : el(className, 'deps cycle', `Dependency cycle: ${path.map((step) => depLabel(step, workspace)).join(' → ')}`);
  return { waits, needed, cycle, lines: [waits, needed, cycle].filter((line) => line !== null), open };
}

// The card of a ticket on the board, or null.
const cardOf = (key: string): HTMLElement | null => [...document.querySelectorAll<HTMLElement>('#cols .card')].find((card) => card.dataset.key === key) ?? null;

// A chip's click: the board with that ticket's card scrolled to and focused; a filter or Done's
// limit that hides it is lifted; a ticket without a card says so. It shows the board as the Board
// tab does, whatever Back's view.
function showCard(key: string): void {
  if (ui.screen !== 'board') {
    showMain('board');
  }
  let card = cardOf(key);
  if (card === null && (state.filter !== '' || !state.doneAll)) {
    state.filter = '';
    state.doneAll = true;
    renderBoard();
    card = cardOf(key);
  }
  if (card === null) {
    toast({ level: 'info', text: `${key} has no card on the board: no Task file and no job.` });
    return;
  }
  // A card in a folded column: the column unfolds.
  const column = card.closest('.col')?.querySelector<HTMLElement>('[data-colfold]')?.dataset.colfold;
  if (column !== undefined && board.folded.has(column)) {
    board.folded.delete(column);
    storeFolds();
    applyFolds();
  }
  card.scrollIntoView({ block: 'nearest' });
  card.focus();
  relate(key);
}

// Hovering or focusing a card shows its dependencies and dependents (outlined) and dims the other
// cards; null clears it. Only a card with either relates.
function relate(key: string | null): void {
  if (ui.related === key) {
    return;
  }
  ui.related = key;
  showRelated();
}

// Applies ui.related to the cards drawn: rel on its dependencies and dependents, dim on the rest
// (nothing when it has neither); called on a change and after every drawing of the board.
function showRelated(): void {
  const graph = board.graph;
  const key = ui.related;
  const related = new Set(key === null ? [] : [...(graph.deps.get(key) ?? []).map(keyOf), ...(graph.needed.get(key) ?? [])]);
  const on = related.size > 0;
  for (const card of document.querySelectorAll<HTMLElement>('#cols .card')) {
    // Every card has its key (boardCard).
    const cardKey = card.dataset.key ?? '';
    card.classList.toggle('rel', on && related.has(cardKey));
    card.classList.toggle('dim', on && card.dataset.key !== key && !related.has(cardKey));
  }
}

// The card under the pointer or with the focus (mouseover, focusin), none outside the cards.
function onCardHover(event: Event): void {
  if (ui.screen !== 'board') {
    return;
  }
  const card = closestOf(event.target, '#cols .card');
  // Every card has its key (boardCard).
  relate(card === null ? null : card.dataset.key ?? null);
}

// The focus left the cards (focusout to outside one).
function onCardBlur(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (next === null || next === undefined || !isElement(next) || next.closest('#cols .card') === null) {
    relate(null);
  }
}

// The first line of a job card: the key, the workspace chip, the code of a stopped job,
// and the money: the cost so far (none before there is one) and the time since the start while it
// runs, the cost and the time it took when it does not.
function cardRow(job: JobRow): HTMLElement {
  const row = el('div', 'row1');
  row.append(el('span', 'key', job.ticket), wsChip(job.workspace));
  if (job.state === 'needs_human' && typeof job.error?.code === 'string') {
    const code = el('span', 'tag', job.error.code);
    code.setAttribute('title', 'error code');
    row.append(code);
  }
  const running = RUNNING.includes(job.state);
  const end = running ? Date.now() : Date.parse(job.updated_at);
  const cost = running && typeof job.cost_usd !== 'number' ? '' : `${money(job.cost_usd)}${running ? ' so far' : ''} · `;
  row.append(el('span', 'money', `${cost}${dur(end - Date.parse(job.created_at))}`));
  return row;
}

// Every card: its key for the dependency highlight and its workspace's colour stripe.
function boardCard(key: string, workspace: string): HTMLLIElement {
  const item = el('li', `card ${wsClass(workspace)}`.trim());
  item.setAttribute('tabindex', '0');
  item.dataset.key = key;
  return item;
}

// A job card (the prototype's jobCard): a click opens the job's page; one primary action only where
// the user acts (Your turn); a Done card keeps its merge request and Archive.
function jobCard(job: JobRow): HTMLLIElement {
  const key = keyOf(job);
  const item = boardCard(key, job.workspace);
  item.dataset.open = key;
  item.append(cardRow(job), el('div', 'title', titleOf(job)));
  const progress = RUNNING.includes(job.state) ? progressBlock(job, nowLine(job).what, true) : [];
  if (job.state === 'waiting_limit') {
    // Parked on a usage limit, holding its slot; once the reset passed under the rule wait,
    // the user resumes it.
    if (job.limit?.reset_seen === true) {
      const act = el('div', 'act');
      const resume = button('btn primary small', ACTION_LABELS.resume, { run: 'resume', key });
      resume.disabled = availability('resume', job) !== '';
      act.append(resume);
      item.append(el('div', 'parked', 'Limit reset: resume?'), el('div', 'meta', `Iteration ${shownIteration(job)} · parked, holds its slot`), act);
    } else {
      item.append(el('div', 'parked', `Waiting for limits · resets at ${limitClock(job) ?? '—'}`), el('div', 'meta', `Iteration ${shownIteration(job)} · parked, holds its slot`));
    }
  } else if (progress.length > 0) {
    // The steps, the phase and when it is likely ready, in place of the Now line and the iteration.
    item.append(...progress);
  } else if (RUNNING.includes(job.state)) {
    const now = nowLine(job);
    const line = el('div', 'now');
    const what = el('span', '', now.what);
    what.setAttribute('title', now.what);
    line.append(el('i', 'pulse'), el('b', '', `Now: ${now.who}`), what);
    item.append(line, el('div', 'meta', `Iteration ${shownIteration(job)} · ${counted(typeof job.tool_calls === 'number' ? job.tool_calls : 0, 'tool call')}`));
  } else if (job.state === 'needs_human') {
    const stop = stopEntry(job.stop_code);
    const reason = el('div', job.stop_kind === 'decision' ? 'reason' : 'reason err', stop.reason);
    if (typeof job.error?.message === 'string') {
      reason.setAttribute('title', job.error.message);
    }
    const n = stopCount(job);
    item.append(reason, el('div', 'meta', `Iteration ${shownIteration(job)} · ${n ? `${counted(n, 'finding')} to decide` : `stopped at ${clock(job.updated_at)}`}`), ...yourTurn(job));
  } else if (job.state === 'ready_for_human_review') {
    // Why the automatic hand-over did not happen, when it was refused.
    const skipped = skippedNote(job) === '' ? [] : [el('div', 'meta note', skippedNote(job).trim())];
    item.append(el('div', 'reason ready', 'Ready to push: reviews clean, MR text written'), el('div', 'meta', `Iteration ${shownIteration(job)}`), ...skipped, ...yourTurn(job));
  } else if (job.state === 'handed_over') {
    // The job's changes wait in the user's checkout.
    item.append(el('div', 'reason ready', checkoutLine(job)), el('div', 'meta', `Iteration ${shownIteration(job)}`), ...yourTurn(job));
  } else if (job.state === 'paused') {
    item.append(el('div', 'reason', 'Paused by you'), el('div', 'meta', `Iteration ${shownIteration(job)}`));
    if (job.task_changed === true) {
      item.append(el('div', 'meta note', 'Task file changed since the job started'));
    }
    item.append(...yourTurn(job));
  } else {
    const meta = el('div', 'meta', `${DONE_LABELS[job.state] ?? job.state} · ${counted(job.iteration, 'iteration')} · ${clock(job.updated_at)}`);
    if (typeof job.error?.message === 'string') {
      meta.setAttribute('title', `${job.error.code}: ${job.error.message}`);
    }
    item.append(meta, ...doneFoot(job));
  }
  item.append(...plannerLines(job));
  // The Implementer's turn went on by itself after the turn limit.
  if (typeof job.turn_limit === 'string') {
    item.append(el('div', 'meta note', job.turn_limit));
  }
  // Who waits for this ticket, and a cycle it is part of.
  const { needed, cycle } = dependencyLines(key, board.graph, 'div');
  item.append(...[needed, cycle].filter((line) => line !== null));
  return item;
}

// The states in which a job waits for the user (src/jobs.ts, the waiting trait).
const WAITING_STATES: readonly JobState[] = ['needs_human', 'ready_for_human_review', 'handed_over'];

// The card's planner lines: in a waiting state, the planner's suggestion clamped to three
// lines (the whole note in its title) with Review the suggestion, which opens the job page at the
// composer, where Send is (never on the card); then Discuss the result ↗ (or its message to copy) in
// a waiting state, and Open the planning chat ↗ on any card with a stored link. A click on a link
// or on Copy does not open the job.
function plannerLines(job: JobRow): HTMLElement[] {
  const planner = job.planner;
  if (planner === undefined || planner === null) {
    return [];
  }
  const key = keyOf(job);
  const waiting = WAITING_STATES.includes(job.state);
  const lines: HTMLElement[] = [];
  const suggestion = planner.suggestion;
  if (waiting && suggestion !== null && typeof suggestion.note === 'string') {
    const line = el('div', 'planner-card');
    const note = el('div', 'planner-clip', suggestion.note);
    note.setAttribute('title', suggestion.note);
    line.append(el('b', 'fs12', 'Planner suggests changes'), note, button('btn small', 'Review the suggestion', { open: key, focus: 'composer' }));
    lines.push(line);
  }
  const links = el('div', 'planner-links');
  const discuss = waiting ? planner.discuss : null;
  if (discuss !== null && typeof discuss.message === 'string') {
    if (typeof discuss.url === 'string' && discuss.url.startsWith(CHATGPT_PREFILL_URL)) {
      links.append(tabLink('fs12', 'Discuss the result ↗', discuss.url));
    } else {
      const copy = button('btn small', 'Copy the message for the planner');
      const message = discuss.message;
      copy.addEventListener('click', (event) => {
        event.stopPropagation();
        copyValue(message, byIdAs('card-copy-text', 'textarea'), (text) => toast({ level: 'info', text: `${text} The message for the planner of ${key}.` }));
      });
      links.append(copy);
    }
  }
  const chat = planningChatHref(planner.chat);
  if (chat !== null) {
    links.append(tabLink('fs12', 'Open the planning chat ↗', chat));
  }
  if (links.children.length > 0) {
    lines.push(links);
  }
  return lines;
}

// The one primary action of a Your turn card, and the job's last outcome. It opens the job's page
// at the stop or the message box (a handed-over branch with the Approve confirmation, a branch
// ready for review on its Merge request screen), except Retry review, Retry and Resume, which go
// at once; a prepared branch also offers Create merge request…, and a handed-over one Merged
// another way….
function yourTurn(job: JobRow): HTMLElement[] {
  const key = keyOf(job);
  const act = el('div', 'act');
  let primary: HTMLButtonElement;
  if (job.state === 'ready_for_human_review') {
    // The job's Merge request screen, where the text is reviewed, saved and pushed.
    primary = button('btn primary small', 'Review the MR and push', { open: key, screen: 'mr' });
  } else if (job.state === 'handed_over') {
    primary = button('btn primary small', 'Review the MR and push', { open: key, confirm: 'approve' });
    primary.disabled = availability('approve', job) !== '';
  } else if (job.state === 'paused') {
    // Resume needs no confirmation; a message for the Implementer is written in the job.
    primary = button('btn primary small', ACTION_LABELS.resume, { run: 'resume', key });
    primary.disabled = availability('resume', job) !== '';
  } else if (reviewFailed(job)) {
    primary = button('btn primary small', ACTION_LABELS.review, { run: 'review', key });
    primary.disabled = availability('review', job) !== '';
  } else if (retryOn(job)) {
    // Retry of a transient MR preparation failure, posted at once.
    primary = button('btn primary small', ACTION_LABELS.retry, { run: 'retry', key });
    primary.disabled = availability('retry', job) !== '';
  } else {
    const stop = stopEntry(job.stop_code);
    const data: Record<string, string> = { open: key };
    if (job.stop_code === 'mr_push_failed' && canApprove(job)) {
      data.confirm = 'approve';
    } else {
      data.focus = job.stop_kind === 'decision' && stopCount(job) ? 'stop' : 'composer';
    }
    primary = button('btn primary small', stop.button(job), data);
  }
  act.append(primary);
  if (canApprove(job)) {
    act.append(cardConfirmButton(job, 'mr-create'));
  }
  if (job.state === 'handed_over') {
    act.append(cardArmButton(job, 'merged-archive'));
  }
  return [act, ...cardOutcome(key, true)];
}

// The job's last outcome on its card, and the warning of an unknown one.
function cardOutcome(key: string, doubts: boolean): HTMLElement[] {
  const parts: HTMLElement[] = [];
  const outcome = state.outcomes.get(key) ?? null;
  if (outcome !== null) {
    parts.push(el('div', `outcome ${outcome.level}`, outcome.text));
  }
  const doubt = doubts ? state.doubts.get(key) : undefined;
  if (doubt !== undefined && doubt !== '') {
    parts.push(el('div', 'outcome error', doubt));
  }
  return parts;
}

// A card's Create merge request…, Merge… or Archive: opens the job's page with that confirmation
// (data); off with the reason as its title while the action is unavailable.
function cardConfirmButton(job: JobRow, action: string, label = `${ACTION_LABELS[action]}…`, data: Record<string, string> = { open: keyOf(job), confirm: action }): HTMLButtonElement {
  const node = button('btn small', label, data);
  const reason = availability(action, job);
  node.disabled = reason !== '';
  if (reason !== '') {
    node.setAttribute('title', reason);
  }
  return node;
}

// A card's Merged — archive: confirmed in place on the card, where cardRun arms it, then runs it.
const cardArmButton = (job: JobRow, action: string): HTMLButtonElement =>
  armable(cardConfirmButton(job, action, ACTION_LABELS[action], { run: action, key: keyOf(job) }), action, keyOf(job));

// A job on Done (pushed, aborted, failed): its merge request with the link, Create merge request… or
// Merge… where they apply, Merged — archive for a pushed job (confirmed in place), Archive (its
// confirmation on the job's page: the job leaves the board, and its Task file goes to the archive while
// it is active), and the job's last outcome. Never a primary button (an armed one is, until disarmed).
function doneFoot(job: JobRow): HTMLElement[] {
  const key = keyOf(job);
  const parts: HTMLElement[] = [];
  if (hasMr(job)) {
    const line = el('div', 'meta');
    line.append(document.createTextNode(`#${job.mr.number} ${job.mr.state} `), mrLink(job.mr));
    parts.push(line);
  }
  const actions = [canCreateMr(job) ? 'mr-create' : null, canMerge(job) ? 'mr-merge' : null].filter((action) => action !== null);
  const act = el('div', 'act');
  act.append(...actions.map((action) => cardConfirmButton(job, action)), ...(job.state === 'pushed' ? [cardArmButton(job, 'merged-archive')] : []),
    cardConfirmButton(job, 'archive', ACTION_LABELS.archive));
  return [...parts, act, ...cardOutcome(key, false)];
}

// The state of a ticket's last job: the jobs list (read from the stream) before the tickets list,
// which may be older; null without one.
function lastJobState(row: TicketRow): JobState | null {
  return jobByKey(keyOf(row))?.state ?? row.job ?? null;
}

// One column per ticket: a ticket is in the Queue without a job or after a failed or
// aborted one; any other job (active, or pushed) keeps it in that job's column only.
function isPlanned(row: TicketRow): boolean {
  const last = lastJobState(row);
  return last === null || RESTARTABLE.includes(last);
}

// The Task check of a Queue card in words: checking…, check: ready, not ready: N blocker,
// M major, check failed (each with " · stale" once the Task file changed after the check), check
// not needed, not checked; a skeleton is a draft.
function checkNote(row: TicketRow): string {
  if (row.draft) {
    return 'draft';
  }
  const check = row.check;
  if (check !== null && typeof check === 'object' && check.running === true) {
    return 'checking…';
  }
  if (check?.state === 'not_needed') {
    return 'check not needed';
  }
  if (check === null || typeof check !== 'object' || check.state === 'none') {
    return 'not checked';
  }
  const text = check.state === 'ready' ? 'check: ready' : check.state === 'failed' ? 'check failed' : `not ready: ${check.blockers} blocker, ${check.majors} major`;
  return `${text}${check.stale ? ' · stale' : ''}`;
}

// A Queue card (the prototype's queueCard): a click opens the planned ticket's page; the
// last job's mark opens that failed or aborted job. The first line: with the run queue a
// queued card's position, then the key, the workspace chip and the plan-check chip (which opens the
// planned ticket with the check's findings; under the title when the line has no room). Then the
// dependency lines, the queue's failed start, why the queue does not start it for its plan
// (plan not ready, plan check failed, plan being checked, plan not checked; with Start
// anyway, which forces the entry), and the actions: Start (secondary in the
// Queue, confirmed; its title names what it waits for) or "waiting for the plan" for a skeleton,
// with the run queue Add to queue / Remove from queue (not on a skeleton), Task, the ⋯ menu with
// Check, Archive and Delete…, and on a queued card the hint of its drag and Alt+Up / Alt+Down.
function queueCard(row: TicketRow): HTMLLIElement {
  const key = keyOf(row);
  const item = boardCard(key, row.workspace);
  if (state.highlight === key) {
    item.classList.add('hl');
  }
  item.dataset.ticket = key;
  const queued = state.queue !== null && isQueued(row);
  const head = el('div', 'row1');
  if (queued) {
    item.setAttribute('draggable', 'true');
    item.dataset.q = String(row.queue_position - 1);
    const pos = el('span', 'pos', String(row.queue_position));
    pos.title = 'Position in the queue';
    head.append(pos);
  }
  head.append(el('span', 'key', row.ticket), wsChip(row.workspace));
  const last = lastJobState(row);
  if (last !== null) {
    const mark = button('tag', `last job ${last}`, { open: key });
    mark.title = 'Open the last job';
    mark.disabled = jobByKey(key) === null; // only from the tickets list: nothing to open yet
    head.append(mark);
  }
  const note = checkNote(row);
  const noteChip = (className: string): HTMLButtonElement => {
    const chip = button(className, note, { ticket: key });
    // A Task that needs no check: the chip's title is the reason.
    chip.setAttribute('title', note === 'check not needed' && typeof row.check?.check_reason === 'string' ? row.check.check_reason
      : `${note}: open the ticket${row.check !== null && typeof row.check === 'object' && row.check.state !== 'none' ? ' and the check\'s findings' : ''}`);
    return chip;
  };
  head.append(noteChip('tag cnote'));
  item.append(head, el('div', 'title', row.title), noteChip('tag cnote below'));
  const { lines, open } = dependencyLines(key, board.graph, 'div');
  item.append(...lines);
  if (state.queue !== null && row.queue_error !== null && typeof row.queue_error === 'object') {
    const failed = el('div', 'waits', `Start failed: ${row.queue_error.message}`);
    failed.title = row.queue_error.code;
    item.append(failed);
  }
  const planHeld = queued && row.queue_force !== true && typeof row.queue_reason === 'string' && row.queue_reason !== '';
  if (planHeld) {
    // planHeld: a string.
    const reason = el('div', 'waits qreason', row.queue_reason ?? '');
    reason.title = 'The queue starts a ticket once the Task check of its current Task file is ready, or after Start anyway';
    item.append(reason);
  }
  const act = el('div', 'act');
  const busy = state.setupPending.has(`ticket:${key}`) || state.ticketConfirm !== null;
  if (row.draft) {
    act.append(el('span', 'muted', 'waiting for the plan'));
  } else {
    const start = button('btn small', 'Start', { qact: 'start', key });
    start.disabled = busy || state.startHolds.has(key);
    if (open.length > 0) {
      start.setAttribute('title', `Waits for ${open.map((other) => depLabel(other, row.workspace)).join(', ')}`);
    }
    act.append(start);
    if (state.queue !== null) {
      const toggle = button('btn small', queued ? 'Remove from queue' : 'Add to queue', { qtoggle: key });
      toggle.disabled = state.setupPending.has(`queue:${key}`);
      toggle.title = queued ? 'Take the ticket out of the queue' : 'The factory starts it by itself when a slot is free, what it waits for is merged and its plan check is ready';
      act.append(toggle);
      if (planHeld) {
        const force = button('btn small', 'Start anyway', { qforce: key });
        force.disabled = state.setupPending.has(`queue:${key}`);
        force.title = 'The queue starts it whatever its plan check says, until it leaves the queue';
        act.append(force);
      }
    }
  }
  const task = button('btn small', 'Task', { ticket: key });
  task.setAttribute('title', 'The Task file and its check');
  act.append(task, ...cardMenu(row, busy));
  if (queued) {
    const hint = el('span', 'muted qhint', '⠿ drag · Alt+↑↓');
    hint.title = 'Drag, or Alt+Up / Alt+Down';
    act.append(hint);
  }
  item.append(act);
  return item;
}

// The queued tickets of every workspace, in their order.
const queuedRows = (): QueuedRow[] => (state.tickets ?? []).filter(isQueued).sort((a, b) => a.queue_position - b.queue_position);

// Add to queue / Remove from queue of a card: posted once; the board shows the server's queue.
function queueToggle(key: string): void {
  const row = ticketByKey(key);
  if (row === null || state.queue === null) {
    return;
  }
  const queued = isQueued(row);
  void setupRequest(`queue:${key}`, queued ? 'api/queue/remove' : 'api/queue/add', { workspace: row.workspace, ticket: row.ticket }, 'toast', (data) =>
    ({ level: 'ok', text: queued ? `${key} is out of the queue.` : `${key} is queued at position ${fieldOf(data, 'position')}.` }));
}

// Start anyway of a queued card: the queue starts it whatever its plan check says.
function queueForce(key: string): void {
  const row = ticketByKey(key);
  if (row === null || state.queue === null || !isQueued(row)) {
    return;
  }
  void setupRequest(`queue:${key}`, 'api/queue/force', { workspace: row.workspace, ticket: row.ticket }, 'toast', () =>
    ({ level: 'ok', text: `${key} starts when a slot is free, whatever its plan check says.` }));
}

// A queued ticket to position to (1-based), by a drop or Alt+Up / Alt+Down; nothing outside the queue.
function moveQueued(key: string, to: number): void {
  const row = ticketByKey(key);
  const count = queuedRows().length;
  if (row === null || state.queue === null || !isQueued(row) || to < 1 || to > count || to === row.queue_position) {
    renderBoard();
    return;
  }
  void setupRequest(`queue:${key}`, 'api/queue/move', { workspace: row.workspace, ticket: row.ticket, to }, 'toast', (data) =>
    ({ level: 'ok', text: `${key} moved to position ${fieldOf(data, 'position')}.` }));
}

// Drag and drop in the queue (the prototype's): a queued card dropped on another goes before it.
const clearDrop = (): void => document.querySelectorAll('.dragging, .dropbefore').forEach((node) => node.classList.remove('dragging', 'dropbefore'));
function onDragStart(event: DragEvent): void {
  const item = closestOf(event.target, '#qlist .card[data-q]');
  if (!item) {
    return;
  }
  // A queued card has its key (queueCard).
  const ticket = item.dataset.ticket ?? '';
  state.drag = ticket;
  item.classList.add('dragging');
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    try {
      event.dataTransfer.setData('text/plain', ticket);
    } catch { // some browsers refuse data here; the drag goes on without it
    }
  }
}
// Over a queued card: the drop place shows before it; anywhere in the queue the drop is allowed.
function onDragOver(event: DragEvent): void {
  if (state.drag === null) {
    return;
  }
  const item = closestOf(event.target, '#qlist .card[data-q]');
  document.querySelectorAll('.dropbefore').forEach((node) => node.classList.remove('dropbefore'));
  if (item) {
    event.preventDefault();
    item.classList.add('dropbefore');
  } else if (closestOf(event.target, '#qlist')) {
    event.preventDefault();
  }
}
// The drop: api/queue/move to the place before the card it lands on; elsewhere nothing moves.
function onDrop(event: DragEvent): void {
  if (state.drag === null) {
    return;
  }
  event.preventDefault();
  const item = closestOf(event.target, '#qlist .card[data-q]');
  const key = state.drag;
  state.drag = null;
  clearDrop();
  const row = ticketByKey(key);
  if (item && item.dataset.ticket !== key && row !== null && isQueued(row)) {
    const from = row.queue_position - 1;
    const to = Number(item.dataset.q);
    moveQueued(key, (from < to ? to - 1 : to) + 1);
  } else {
    renderBoard();
  }
}
// A drag that ends without a drop.
function onDragEnd(): void {
  state.drag = null;
  clearDrop();
}

// A Queue card's ⋯ menu: Move up and Move down (a queued card), Check (with the Task
// checks, not for a skeleton), Archive and Delete…, shown while it is open (one card's at a time;
// a click elsewhere or Escape closes it).
function cardMenu(row: TicketRow, busy: boolean): HTMLElement[] {
  const key = keyOf(row);
  const open = state.openMenu === key;
  const toggle = button('btn small more', '⋯', { menu: key });
  toggle.setAttribute('aria-label', `More actions for ${row.ticket}`);
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', String(open));
  const menu = el('div', 'cmenu');
  menu.setAttribute('role', 'menu');
  menu.hidden = !open;
  const asItem = (node: HTMLButtonElement): HTMLButtonElement => {
    node.setAttribute('role', 'menuitem');
    return node;
  };
  // A queued card moves one place by a tap too (drag and Alt+Up / Alt+Down need a mouse or keys).
  if (state.queue !== null && isQueued(row)) {
    const pending = state.setupPending.has(`queue:${key}`);
    const up = button('btn small', 'Move up', { qact: 'up', key });
    up.disabled = busy || row.queue_position <= 1 || pending;
    const down = button('btn small', 'Move down', { qact: 'down', key });
    down.disabled = busy || row.queue_position >= queuedRows().length || pending;
    menu.append(asItem(up), asItem(down));
  }
  if (!row.draft && row.check !== null && typeof row.check === 'object') {
    const check = button('btn small', 'Check', { qact: 'check', key });
    check.title = 'A read-only Claude session reads the Task file and the repository and says whether it is ready; it only advises';
    check.disabled = row.check.running === true || state.setupPending.has(`check:${key}`);
    menu.append(asItem(check));
  }
  const archive = button('btn small', 'Archive', { qact: 'archive', key });
  archive.disabled = busy;
  archive.title = 'Move the Task file to .software-factory/archive/; a finished job of the ticket leaves the board';
  const remove = button('btn small danger', 'Delete…', { qact: 'delete', key });
  remove.disabled = busy;
  menu.append(asItem(archive), asItem(remove));
  return [toggle, menu];
}

// Opens or closes a Queue card's ⋯ menu; the board is drawn again with the focus where it was.
function setCardMenu(key: string | null): void {
  if (state.openMenu === key) {
    return;
  }
  state.openMenu = key;
  renderBoard();
  if (key !== null) {
    cardOf(key)?.querySelector<HTMLElement>('.cmenu button:not([disabled])')?.focus();
  }
}

const visible = (workspace: string): boolean => state.filter === '' || workspace === state.filter;

// The board (the prototype's renderBoard): the top bar (header.js), the five columns, the
// Coordinator card (coordinator.js) and the home (home.js), whichever main view is shown. The focus
// stays on the card it was on.
function renderBoard(): void {
  renderHeader();
  const active = document.activeElement;
  const focused = active !== null && active !== undefined && byId('cols').contains(active) && hasDataset(active) && active.classList?.contains('card')
    ? (active.dataset.open !== undefined ? `[data-open="${active.dataset.open}"]` : `[data-ticket="${active.dataset.ticket}"]`) : null;
  const byUpdate = (a: JobRow, b: JobRow): number => b.updated_at.localeCompare(a.updated_at);
  const jobs = state.jobs.filter((job) => visible(job.workspace)).sort(byUpdate);
  // A failed or aborted job whose ticket is in the Queue is not also in Done.
  const planned = (state.tickets ?? []).filter((row) => visible(row.workspace) && isPlanned(row));
  const plannedKeys = new Set(planned.map(keyOf));
  // With the run queue the queued tickets come first, in their order.
  const inQueue = (row: TicketRow): row is QueuedRow => state.queue !== null && isQueued(row);
  const queued = planned.filter(inQueue).sort((a, b) => a.queue_position - b.queue_position);
  const lists: { queue: TicketRow[] } & Record<JobColumn, JobRow[]> = { queue: [...queued, ...planned.filter((row) => !inQueue(row))], implementing: [], reviewing: [], you: [], done: [] };
  for (const job of jobs) {
    if (RESTARTABLE.includes(job.state) && plannedKeys.has(keyOf(job))) {
      continue;
    }
    lists[COLUMN_OF[job.state] ?? 'done'].push(job);
  }
  board.graph = dependencyGraph();
  if (state.openMenu !== null && !planned.some((row) => keyOf(row) === state.openMenu)) {
    state.openMenu = null;
  }
  for (const column of COLUMNS) {
    const entries = lists[column];
    byId(`count-${column}`).textContent = String(column === 'queue' && state.queue !== null ? queued.length : entries.length);
    // The Queue's cards, or a job column's (Done's last DONE_LIMIT unless it shows all).
    const cards = column === 'queue' ? lists.queue.map(queueCard)
      : (column === 'done' && !state.doneAll ? lists.done.slice(0, DONE_LIMIT) : lists[column]).map(jobCard);
    if (column === 'queue' && state.queue !== null) {
      // The queued cards (or the queue's empty text), "Not queued", then the other planned tickets.
      const divider = el('li', 'qdiv', 'Not queued');
      byId(LIST_OF[column]).replaceChildren(...(queued.length > 0 ? cards.slice(0, queued.length) : [el('li', 'empty', QUEUE_EMPTY)]), divider, ...cards.slice(queued.length));
      continue;
    }
    byId(LIST_OF[column]).replaceChildren(...(cards.length > 0 ? cards : [el('li', 'empty', EMPTY_TEXT[column === 'queue' ? 'planned' : column])]));
  }
  const more = byId('done-all');
  more.hidden = lists.done.length <= DONE_LIMIT;
  more.textContent = state.doneAll ? `Show the last ${DONE_LIMIT}` : `Show all ${lists.done.length}`;
  const wait = lists.you.length;
  document.title = `${wait > 0 ? `(${wait}) ` : ''}Software Factory`;
  let hint = '';
  if (state.workspaces !== null && state.workspaces.length === 0) {
    hint = 'No workspace yet: Workspaces adds the local checkout of a repository to work in.';
  } else if (state.tickets !== null && state.tickets.length === 0 && state.jobs.length === 0) {
    hint = 'No ticket yet: New ticket writes one, and its conversation plans it.';
  }
  byId('board-hint').textContent = hint;
  byId('board-hint').hidden = hint === '';
  renderCoordinator();
  renderHome();
  if (focused !== null) {
    document.querySelector<HTMLElement>(`#cols .card${focused}`)?.focus();
  }
  showRelated();
  showHighlight();
  scheduleRefresh();
}

// The new ticket's card, once the stream lists it: scrolled to and focused once; it stays
// highlighted until another ticket is created.
function showHighlight(): void {
  if (state.highlight === null || state.highlightShown || ui.screen !== 'board') {
    return;
  }
  const card = document.querySelector<HTMLElement>(`#qlist .card[data-ticket="${state.highlight}"]`);
  if (card !== null) {
    state.highlightShown = true;
    card.scrollIntoView({ block: 'nearest' });
    card.focus();
  }
}

// While a card runs and the page is visible, api/jobs is read again every REFRESH_MS, so the Now
// line and the elapsed time move: one timer, one read at a time; nothing else is polled.
const anyRunning = (): boolean => state.jobs.some((job) => visible(job.workspace) && RUNNING.includes(job.state));
function scheduleRefresh(): void {
  if (state.refresh !== null || !anyRunning() || document.visibilityState === 'hidden') {
    return;
  }
  state.refresh = setTimeout(() => {
    if (document.visibilityState === 'hidden' || !anyRunning()) {
      state.refresh = null;
      return;
    }
    // A jobs event of the stream during the read is newer than its answer.
    const seen = state.jobsSeen;
    getText('api/jobs').then((text) => {
      if (state.jobsSeen === seen) {
        state.jobs = jobsOf(text);
      }
    }, () => undefined).finally(() => {
      state.refresh = null;
      renderJobs();
    });
  }, REFRESH_MS);
}

// ---------- The toast: the board's messages ----------

// One message at a time, a new one replacing the old: ok and info go after TOAST_MS (not while
// the pointer is on it), errors stay until closed; × and Escape close it.
function toast(outcome: Outcome | null): void {
  const node = byId('toast');
  clearTimeout(state.toastTimer ?? undefined);
  state.toastTimer = null;
  state.toastLevel = outcome?.level ?? null;
  if (outcome === null) {
    node.hidden = true;
    byId('toast-text').textContent = '';
    return;
  }
  const alert = outcome.level === 'error' || outcome.level === 'warn';
  node.setAttribute('role', alert ? 'alert' : 'status');
  node.className = alert ? 'err' : '';
  byId('toast-text').textContent = outcome.text;
  node.hidden = false;
  armToast();
}

function armToast(): void {
  if ((state.toastLevel === 'ok' || state.toastLevel === 'info') && !state.toastHover && state.toastTimer === null) {
    state.toastTimer = setTimeout(() => toast(null), TOAST_MS);
  }
}

