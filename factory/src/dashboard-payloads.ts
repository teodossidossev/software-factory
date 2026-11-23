// The dashboard's payloads: what api/jobs, api/workspaces, api/tickets and a job's detail answer
// and what the change feed sends (the jobs with what each board card shows, the tickets with their
// conversation, check and place in the run queue, the planned ticket page's plan, a job's detail
// with its iterations and history). Read-only: every function reads the job store, the start
// screen's data, the Task checks and the run queue it is given, and changes nothing.
import { open, readFile } from 'node:fs/promises';
import { conversationUrl, MAX_CONVERSATION_URL, resultConversation, ticketConversation } from './conversation.js';
import type { DashboardActions, DashboardChecks, DashboardQueue, DashboardSetup } from './dashboard.js';
import { CONFIRM_ACTIONS } from './dashboard-routes.js';
import { currentExplanation, ledgerStopEntries } from './explain.js';
import { claudeReviews, type Job, type JobStore } from './jobs.js';
import { lastReviewCount, shownLastReview } from './last-review-choices.js';
import { jobLead } from './lead-time.js';
import { shownSuggestion, waits } from './planner.js';
import { historyOf, phaseOf, type Progress, progressOf, readSteps } from './progress.js';
import { configDir } from './registry.js';
import type { TicketRow, WorkspaceRow } from './setup.js';
import type { CheckSummary } from './task-check.js';
import { turnLimitLine } from './turn-limit.js';
import { mayTouch, parseFrontMatter, taskScope, taskSha256 } from './task-file.js';
import { type JobFacts, jobActions, NO_FACTS, settleEntries, stopFields } from './stops.js';
import { visionPages } from './vision.js';
import { shortInput } from './watch.js';

// The file counts of the last published iteration: every file, the undeclared sensitive
// ones and the deleted ones; zeros before the first iteration or for an iteration without a list.
async function fileCounts(jobs: JobStore, job: Job): Promise<{ files: number; undeclared: number; deleted: number }> {
  const none = { files: 0, undeclared: 0, deleted: 0 };
  if (job.iteration === 0) {
    return none;
  }
  try {
    const files = (await jobs.readMeta(job.workspace, job.ticket, job.iteration)).files ?? [];
    return {
      files: files.length,
      undeclared: files.filter((change) => change.sensitive === 'undeclared').length,
      deleted: files.filter((change) => change.status === 'deleted').length,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return none;
    }
    throw error;
  }
}

type Verdict = 'clean' | 'fix' | 'failed' | null;
const verdictOf = (record: { verdict: 'clean' | 'fix' } | { error: string } | undefined): Verdict =>
  record === undefined ? null : 'verdict' in record ? record.verdict : 'failed';

// What a board card shows besides the job record: the estimated cost of the iterations
// and their Claude reviews (the job card's sum), and the last iteration's Claude review and gate
// with the end of that review, which tell the pipeline segment of awaiting_review and since when
// the gate runs.
async function boardFacts(jobs: JobStore, job: Job): Promise<{ cost_usd: number | null; review: Verdict; review_ended_at: string | null; gate: Verdict }> {
  let cost: number | null = null;
  const add = (value: number | null | undefined): void => {
    if (typeof value === 'number') {
      cost = (cost ?? 0) + value;
    }
  };
  let review: Awaited<ReturnType<JobStore['readReview']>>;
  for (let number = 1; number <= job.iteration; number += 1) {
    try {
      add((await jobs.readMeta(job.workspace, job.ticket, number)).cost_usd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    review = await jobs.readReview(job.workspace, job.ticket, number);
    add(review !== undefined && 'verdict' in review ? review.cost_usd : undefined);
  }
  const gate = job.iteration > 0 ? await jobs.readGate(job.workspace, job.ticket, job.iteration) : undefined;
  return {
    cost_usd: cost,
    review: verdictOf(review),
    review_ended_at: review !== undefined && 'verdict' in review ? review.ended_at : null,
    gate: verdictOf(gate),
  };
}

// Whether the merge request actions are on for a workspace: its Git host, or why not.
type MrHost = Awaited<ReturnType<DashboardActions['mergeRequestHost']>>;

async function mrHostOf(actions: DashboardActions, workspace: string): Promise<MrHost> {
  try {
    return await actions.mergeRequestHost(workspace);
  } catch (error) {
    console.error(error);
    return { host: null, reason: 'the Git host could not be determined' };
  }
}

// Whether a workspace hands its jobs ready for review over to its checkout (its handoff, else
// SF_HANDOFF, is checkout); a registry that cannot be read counts as off, logged.
async function handsOverOf(setup: DashboardSetup, workspace: string): Promise<boolean> {
  try {
    return (await setup.handoffOf(workspace)) === 'checkout';
  } catch (error) {
    console.error(error);
    return false;
  }
}

// Whether the Task file of a paused job changed since the Implementer was last given it:
// its sha256 against the job's; null for a job not paused, without a recorded sha256, or whose Task
// file cannot be read.
async function taskChangedOf(setup: DashboardSetup, job: Job): Promise<boolean | null> {
  if (job.state !== 'paused' || job.task_sha256 === undefined) {
    return null;
  }
  try {
    return taskSha256(await setup.taskText(job.workspace, job.ticket)) !== job.task_sha256;
  } catch { // the Task file cannot be read: unknown (null)
    return null;
  }
}

// mr: the merge request on the Git host, null before one is opened; mr_host: whether the
// merge request actions are on for the job's workspace; paused: what a pause interrupted,
// null unless paused (or parked on a usage limit); limit: the usage limit of a parked job
// (provider, resets_at, reset_seen), null otherwise; task_changed: taskChangedOf; turn_limit: the line of a chain that went on by
// itself after a turn limit, null without one; handover: the job in the user's checkout,
// null otherwise; handoff_skipped: why the automatic hand-over did not happen, null
// otherwise; mr_conflict_turn: the MR preparation ran a conflict turn, so no Retry;
// claude_review: whether the Claude review runs on the job (absent in job.json: true); progress: progressFor.
// From src/stops.ts: stop_code, stop_kind and stop_group, the canonical row of a needs_human
// job's stop (null in any other state); actions, the actions the job page shows in order;
// availability, every action's '' or why it is off. The page renders them and decides no rule.
function jobSummary(job: Job, counts: { files: number; undeclared: number; deleted: number }, mrHost: MrHost, taskChanged: boolean | null, facts: JobFacts, progress: Progress | null) {
  const now = new Date();
  return {
    workspace: job.workspace, ticket: job.ticket, branch: job.branch, base: job.base, state: job.state,
    iteration: job.iteration, mr_attempts: job.mr_attempts, mr_conflict_turn: job.mr_conflict_turn, updated_at: job.updated_at, created_at: job.created_at,
    error: job.error ?? null, worktree: job.worktree, prepared_commit: job.prepared_commit,
    fixes: job.fixes, gate_fixes: job.gate_fixes, gate_tokens: job.gate_tokens, ...counts,
    mr: job.mr, mr_host: mrHost, paused: job.paused ?? null, limit: job.limit ?? null, task_changed: taskChanged, turn_limit: turnLimitLine(job) ?? null,
    handover: job.handover ?? null, handoff_skipped: job.handoff_skipped ?? null, claude_review: claudeReviews(job), progress,
    ...stopFields(job, now), ...jobActions(job, facts, now),
  };
}

// A running job's progress (src/progress.ts): the steps file of its worktree, whether the iteration under
// review has the Claude review's and the gate's verdict, and the history's durations; null for a job not running.
async function progressFor(jobs: JobStore, job: Job): Promise<Progress | null> {
  if (phaseOf(job, false) === null) {
    return null;
  }
  const verdict = (record: object | undefined): boolean => record !== undefined && 'verdict' in record;
  const reviewing = job.state === 'awaiting_review';
  const done = {
    claude: reviewing && verdict(await jobs.readReview(job.workspace, job.ticket, job.iteration)),
    codex: reviewing && verdict(await jobs.readGate(job.workspace, job.ticket, job.iteration)),
  };
  return progressOf(job, { steps: await readSteps(job.worktree, job.ticket), done, durations: await historyOf(jobs).of(job.workspace), now: Date.now() });
}

// What the rules of a job's actions read (src/stops.ts): for a needs_human job its ledger and the
// last iteration's Claude review and gate; for every job the workspace's Git host and whether it
// hands its jobs over (handsOver). Only the stopped jobs cost the extra reads.
async function ruleFacts(jobs: JobStore, job: Job, mrHost: MrHost, handsOver: boolean): Promise<JobFacts> {
  if (job.state !== 'needs_human') {
    return { ...NO_FACTS, mrHost, handsOver };
  }
  const last = job.iteration >= 1;
  return {
    ledger: await jobs.readLedger(job.workspace, job.ticket),
    review: last ? await jobs.readReview(job.workspace, job.ticket, job.iteration) : undefined,
    gate: last ? await jobs.readGate(job.workspace, job.ticket, job.iteration) : undefined,
    mrHost,
    handsOver,
  };
}

// The Now line reads at most this much of the end of events.jsonl; the tool calls are counted in
// chunks of TOOL_CALL_CHUNK_BYTES.
export const NOW_TAIL_BYTES = 256 * 1024;
const TOOL_CALL_CHUNK_BYTES = 1024 * 1024;
const NOW_TEXT_CHARS = 200;

interface NowLine {
  who: string;
  what: string;
  ts: string | null;
}

// The content blocks of an Implementer message: an SDK assistant message the session logged as it
// came (the reviewers' come as review_message and gate_event records); none for any other record.
function implementerBlocks(raw: string): { ts: string | null; blocks: Array<Record<string, unknown>> } | undefined {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch { // not JSON: not an Implementer message
    return undefined;
  }
  if (record === null || typeof record !== 'object' || record.type !== undefined) {
    return undefined;
  }
  const message = record.message as { type?: unknown; message?: { content?: unknown } } | undefined;
  const content = message?.type === 'assistant' ? message.message?.content : undefined;
  return Array.isArray(content) ? { ts: typeof record.ts === 'string' ? record.ts : null, blocks: content as Array<Record<string, unknown>> } : undefined;
}

// The complete lines of the last bytes of a file (the first, cut one dropped); none when it is missing.
async function tailLines(path: string, bytes: number): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

// The last thing the Implementer did, from the tail of the log: its last tool call (the verb and
// the short input of sf watch) or the first line of its last text.
function lastImplementerStep(lines: string[]): NowLine | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const found = implementerBlocks(lines[index]!);
    for (const block of [...(found?.blocks ?? [])].reverse()) {
      if (block.type === 'tool_use') {
        return { who: 'Implementer', what: `${String(block.name)} ${shortInput(block.input)}`, ts: found!.ts };
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        const first = block.text.trim().split('\n')[0]!.replace(/\s+/g, ' ').trim();
        return { who: 'Implementer', what: first.length > NOW_TEXT_CHARS ? `${first.slice(0, NOW_TEXT_CHARS - 1)}…` : first, ts: found!.ts };
      }
    }
  }
  return null;
}

// Who acts now on a running job and what it does: the Implementer's last step, the
// reviewer of the last iteration (Codex once Claude's verdict of it is stored, as the gate of the
// joint round still runs, or from the start without the Claude review), the MR writer; null for a
// job that is not running, or an Implementer with no step in the tail yet.
async function nowOf(jobs: JobStore, job: Job, facts: { review: Verdict; review_ended_at: string | null }): Promise<NowLine | null> {
  switch (job.state) {
    case 'starting':
    case 'working':
      return lastImplementerStep(await tailLines(jobs.eventsPath(job.workspace, job.ticket), NOW_TAIL_BYTES));
    case 'awaiting_review':
      if (!claudeReviews(job)) {
        return { who: 'Codex gate', what: `reviewing iteration ${job.iteration}`, ts: job.updated_at };
      }
      return facts.review === 'clean' || facts.review === 'fix'
        ? { who: 'Codex gate', what: `reviewing iteration ${job.iteration}`, ts: facts.review_ended_at }
        : { who: 'Claude review', what: `reviewing iteration ${job.iteration}`, ts: job.updated_at };
    case 'preparing_mr':
      return { who: 'MR writer', what: 'writing the MR text', ts: job.updated_at };
    default:
      return null;
  }
}

const toolUses = (raw: string): number =>
  raw.includes('"tool_use"') ? (implementerBlocks(raw)?.blocks.filter((block) => block.type === 'tool_use').length ?? 0) : 0;

// The Implementer's tool calls of each job, counted incrementally: per events.jsonl the bytes
// already read, the count so far and the cut line at the end; a log replaced (a restart) or cut
// shorter is counted again from the start. One count per log at a time.
export class ToolCallCounter {
  private readonly seen = new Map<string, { ino: number; offset: number; count: number; rest: Buffer }>();
  private readonly running = new Map<string, Promise<number>>();
  // The bytes of every log read so far, across counts.
  bytesRead = 0;

  count(path: string): Promise<number> {
    const next = (this.running.get(path) ?? Promise.resolve(0)).catch(() => 0).then(() => this.read(path));
    this.running.set(path, next);
    return next;
  }

  private async read(path: string): Promise<number> {
    let handle;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.seen.delete(path);
        return 0;
      }
      throw error;
    }
    try {
      const { ino, size } = await handle.stat();
      let entry = this.seen.get(path);
      if (entry === undefined || entry.ino !== ino || size < entry.offset) {
        entry = { ino, offset: 0, count: 0, rest: Buffer.alloc(0) };
      }
      while (entry.offset < size) {
        const chunk = Buffer.alloc(Math.min(TOOL_CALL_CHUNK_BYTES, size - entry.offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, entry.offset);
        if (bytesRead === 0) {
          break;
        }
        entry.offset += bytesRead;
        this.bytesRead += bytesRead;
        const data = Buffer.concat([entry.rest, chunk.subarray(0, bytesRead)]);
        let start = 0;
        for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
          entry.count += toolUses(data.toString('utf8', start, end));
          start = end + 1;
        }
        entry.rest = Buffer.from(data.subarray(start));
      }
      this.seen.set(path, entry);
      return entry.count;
    } finally {
      await handle.close();
    }
  }
}

// What a stopped job waits on, for its card: the suggestions of the last simplification
// pass and the lines they save (simplify_offered), the ledger entries to settle (escalated,
// review_disputed: the ledger's unsettled ones), the open ones (review_churn), the items of the last gate (gate_rounds,
// gate_budget); none for any other stop; null unless the job is needs_human.
async function stopOf(jobs: JobStore, job: Job): Promise<{ items: unknown[]; saves_lines: number | null } | null> {
  if (job.state !== 'needs_human') {
    return null;
  }
  const code = job.error?.code;
  if (code === 'simplify_offered') {
    const record = await jobs.readSimplify(job.workspace, job.ticket, job.iteration);
    const items = record !== undefined && 'suggestions' in record ? record.suggestions : [];
    return { items, saves_lines: items.reduce((sum, item) => sum + item.saves_lines, 0) };
  }
  const entries = ledgerStopEntries(code ?? '', await jobs.readLedger(job.workspace, job.ticket));
  if (entries !== null) {
    return { items: entries, saves_lines: null };
  }
  if (code === 'gate_rounds' || code === 'gate_budget') {
    for (let number = job.iteration; number >= 1; number -= 1) {
      const gate = await jobs.readGate(job.workspace, job.ticket, number);
      if (gate !== undefined && 'verdict' in gate) {
        return { items: gate.items, saves_lines: null };
      }
    }
  }
  return { items: [], saves_lines: null };
}

// A job's planner block: who plans the ticket (owner), the ticket's planning chat link; while the
// job waits for the User, the message that opens the conversation about its result (a ChatGPT
// link when ChatGPT plans the ticket and it fits, else the message to copy); and the planner's
// suggestion while it is shown (src/planner.ts).
export async function plannerOf(jobs: JobStore, setup: DashboardSetup, job: Job) {
  const { owner, planning_chat } = await setup.planningOf(job.workspace, job.ticket);
  let discuss: { message: string; url: string | null } | null = null;
  if (waits(job.state)) {
    const message = resultConversation(job.workspace, job.ticket, owner);
    const url = owner === 'chatgpt' ? conversationUrl(message) : null;
    discuss = { message, url: url !== null && url.length <= MAX_CONVERSATION_URL ? url : null };
  }
  return { owner, chat: planning_chat, discuss, suggestion: await shownSuggestion(jobs, job) };
}

// now: nowOf; tool_calls: the Implementer's tool calls in the job (ToolCallCounter); stop: stopOf;
// planner: plannerOf; last_review: the count of the last review's comments shown while the job waits
// at its iteration (src/last-review-choices.ts), null otherwise.
export async function jobsPayload(jobs: JobStore, setup: DashboardSetup, actions: DashboardActions, toolCalls: ToolCallCounter) {
  const list = [];
  const hosts = new Map<string, MrHost>();
  const handsOverBy = new Map<string, boolean>();
  for (const job of await jobs.list()) {
    if (!hosts.has(job.workspace)) {
      hosts.set(job.workspace, await mrHostOf(actions, job.workspace));
      handsOverBy.set(job.workspace, await handsOverOf(setup, job.workspace));
    }
    const facts = await boardFacts(jobs, job);
    const host = hosts.get(job.workspace)!;
    const handsOver = handsOverBy.get(job.workspace)!;
    list.push({
      ...jobSummary(job, await fileCounts(jobs, job), host, await taskChangedOf(setup, job), await ruleFacts(jobs, job, host, handsOver), await progressFor(jobs, job)),
      title: await setup.taskTitle(job.workspace, job.ticket), ...facts,
      now: await nowOf(jobs, job, facts), tool_calls: await toolCalls.count(jobs.eventsPath(job.workspace, job.ticket)), stop: await stopOf(jobs, job),
      planner: await plannerOf(jobs, setup, job),
      last_review: lastReviewCount(await shownLastReview(jobs, job)),
    });
  }
  return { jobs: list };
}

// The workspaces, the hand-over default and the morning digest's settings. A workspace with a
// vision page in stateDir (src/vision.ts) has vision: true, the drawer's link to it; the others no key.
export async function workspacesPayload(setup: DashboardSetup, stateDir: string) {
  const [rows, pages] = await Promise.all([setup.workspaces(), visionPages(stateDir)]);
  const workspaces: (WorkspaceRow & { vision?: true })[] = rows.map((row) => (pages.includes(row.name) ? { ...row, vision: true } : row));
  return { workspaces, ...(await setup.workspaceSettings()) };
}

// A ticket's check summary for the board, or none when it cannot be read.
async function checkOf(checks: DashboardChecks, workspace: string, ticket: string): Promise<CheckSummary | null> {
  try {
    return await checks.summary(workspace, ticket);
  } catch (error) {
    console.error(error);
    return null;
  }
}

// The tickets without a live job, each with the ChatGPT conversation that plans it (the message
// and the prefilled URL), the tickets it lands after with their states, with the Task
// checks its last check, and its place in the run queue (queue_position, 1-based or
// null, and queue_error, the queue's failed start or null; queue_reason, why its plan holds
// it in the queue or null, queue_force, whether Start anyway was given, and queue_retry, the next try
// of a start that could not fetch or null); job_lands_after: the same for the
// tickets with a live job, for the job page's Waits for and the board's Needed by; chains: each
// chain of parts with an active Task file (src/chains.ts), for the board's line; queue: the run
// queue's limit, running count, hold and next ticket (null without a queue).
export async function ticketsPayload(setup: DashboardSetup, checks: DashboardChecks | undefined, queue: DashboardQueue | undefined) {
  const view = queue === undefined ? undefined : await queue.view();
  const same = (row: TicketRow) => (other: { workspace: string; ticket: string }): boolean => other.workspace === row.workspace && other.ticket === row.ticket;
  const tickets = [];
  for (const row of await setup.tickets()) {
    const failed = view?.errors.find(same(row));
    const entry = view?.entries.find(same(row));
    tickets.push({
      ...(await ticketEntry(row, checks)),
      queue_position: entry?.position ?? null,
      queue_error: failed === undefined ? null : { code: failed.code, message: failed.message },
      queue_reason: entry?.plan_reason ?? null,
      queue_force: entry?.force ?? false,
      queue_retry: entry?.retry ?? null,
    });
  }
  return {
    tickets, archived: await setup.archivedTickets(), job_lands_after: await setup.jobDependencies(), chains: await setup.chains(),
    queue: view === undefined ? null : {
      max_running: view.max_running, running: view.running, held: view.held, hold_reason: view.hold_reason, next: view.next, on_limit: view.on_limit, limit_hold: view.limit_hold,
    },
  };
}

// A row of the tickets payload: the ticket, its conversation and, with the Task checks, its check.
// The ChatGPT link only when ChatGPT plans it: Claude Code gets the message to copy.
export async function ticketEntry(row: TicketRow, checks: DashboardChecks | undefined) {
  const message = ticketConversation(row.workspace, row.ticket, row.request ?? undefined, row.attachments.map((attachment) => attachment.name), row.owner);
  const url = row.owner === 'chatgpt' ? conversationUrl(message) : null;
  // A very long message does not fit a link; the page offers it to copy instead.
  return {
    ...row, conversation: { message, url: url !== null && url.length <= MAX_CONVERSATION_URL ? url : null },
    ...(checks !== undefined ? { check: await checkOf(checks, row.workspace, row.ticket) } : {}),
  };
}

// The planned ticket page's plan in plain words, from the Task file's front matter as the
// jobs read it: the branch it starts from, the files it will change (scope, then may_touch, each
// path once, a may_touch one marked sensitive), whether there is a scope, and the tickets it waits
// for with the state of each, from the tickets row (a ticket of another workspace as
// <workspace>/<ticket>).
export function planOf(text: string, row: TicketRow) {
  const fields = parseFrontMatter(text) ?? new Map<string, string>();
  const scope = taskScope(fields);
  const sensitive = mayTouch(fields);
  const files: Array<{ path: string; sensitive: boolean }> = [];
  for (const path of [...(scope ?? []), ...sensitive]) {
    if (!files.some((file) => file.path === path)) {
      files.push({ path, sensitive: sensitive.includes(path) });
    }
  }
  const waits = row.lands_after.map((dep) => ({ ticket: dep.workspace === row.workspace ? dep.ticket : `${dep.workspace}/${dep.ticket}`, state: dep.state, merged: dep.state === 'merged' }));
  return { starts_from: fields.get('base') ?? row.base, files, scoped: scope !== undefined, waits_for: waits };
}

async function stateHistory(jobs: JobStore, workspace: string, ticket: string) {
  let text = '';
  try {
    text = await readFile(jobs.eventsPath(workspace, ticket), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  type Entry = { ts: string; from: string | null; to: string; error?: { code: string; message: string } }
    | { ts: string; event: 'gate_overridden'; code: string; unapplied: number }
    | { ts: string; event: 'merge_request'; action: string; number: number; url: string; state: string };
  const history: Entry[] = [];
  for (const line of text.split('\n')) {
    let record: {
      ts?: unknown; type?: unknown; code?: unknown; unapplied?: unknown; action?: unknown; number?: unknown; url?: unknown; mr_state?: unknown;
      state?: { from: string | null; to: string; error?: { code: string; message: string } };
    };
    try {
      record = JSON.parse(line) as typeof record;
    } catch { // not a JSON line: not part of the history
      continue;
    }
    if (typeof record === 'object' && record !== null && record.type === 'merge_request') {
      // The merge request opened, reused, merged or found changed on the host.
      history.push({ ts: String(record.ts), event: 'merge_request', action: String(record.action), number: Number(record.number), url: String(record.url), state: String(record.mr_state) });
    } else if (typeof record === 'object' && record !== null && typeof record.state === 'object' && record.state !== null) {
      const { from, to, error } = record.state;
      history.push({ ts: String(record.ts), from: from ?? null, to, ...(error !== undefined ? { error } : {}) });
    } else if (typeof record === 'object' && record !== null && record.type === 'gate_overridden') {
      // The user's override of the gate is part of the job's history.
      history.push({ ts: String(record.ts), event: 'gate_overridden', code: String(record.code), unapplied: typeof record.unapplied === 'number' ? record.unapplied : 0 });
    }
  }
  return history;
}

// normsDir: where norms.json is read for the lead-time target (src/lead-time.ts).
export async function jobDetail(jobs: JobStore, job: Job, gate: boolean, actions: DashboardActions, setup: DashboardSetup, normsDir: string = configDir()) {
  const iterations = [];
  for (let number = 1; number <= job.iteration; number += 1) {
    try {
      const meta = await jobs.readMeta(job.workspace, job.ticket, number);
      iterations.push({
        number, started_at: meta.started_at, ended_at: meta.ended_at, cost_usd: meta.cost_usd,
        changed_files: meta.changed_files.length, patch_truncated: meta.patch_truncated, denials: meta.denials.length,
        // The structured file list; null for an iteration whose meta.json has none.
        files: meta.files ?? null,
        // The Claude review: review.json as written; null while none ended.
        review: (await jobs.readReview(job.workspace, job.ticket, number)) ?? null,
        // The gate: gate.json as written; null while none ended.
        gate: (await jobs.readGate(job.workspace, job.ticket, number)) ?? null,
        // The user's override of the stopped gate: gate-override.json; null when none.
        gate_override: (await jobs.readGateOverride(job.workspace, job.ticket, number)) ?? null,
        // The simplification pass: simplify.json as written; null when none ran.
        simplify: (await jobs.readSimplify(job.workspace, job.ticket, number)) ?? null,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  const mrText = await jobs.readMrText(job.workspace, job.ticket);
  const mrHost = await mrHostOf(actions, job.workspace);
  const facts = await ruleFacts(jobs, job, mrHost, await handsOverOf(setup, job.workspace));
  const ledger = job.state === 'needs_human' ? facts.ledger : await jobs.readLedger(job.workspace, job.ticket);
  const history = await stateHistory(jobs, job.workspace, job.ticket);
  return {
    job: { ...jobSummary(job, await fileCounts(jobs, job), mrHost, await taskChangedOf(setup, job), facts, await progressFor(jobs, job)), planner: await plannerOf(jobs, setup, job) },
    iterations,
    mr: mrText !== undefined,
    // The merge request's title on the Git host: the MR text's first line.
    mr_title: mrText === undefined ? null : (mrText.split(/\r?\n/)[0] ?? ''),
    // Whether the Codex gate is on (SF_GATE): the pipeline shows its step as off otherwise.
    gate,
    // The findings ledger: ledger.json as written; [] before the first Fix section.
    ledger,
    // The ids of the ledger entries the stop block offers Accept risk and Must fix for
    // (src/stops.ts settleEntries); [] unless the stop is one the user settles in.
    settle_ids: settleEntries(job, ledger, new Date()).map((entry) => entry.id),
    // The actions that need the job's ticket typed again on the remote port (POST_ROUTES'
    // confirm routes); the page asks for it exactly for these.
    confirm_actions: [...CONFIRM_ACTIONS],
    history,
    // The lead time from the job's start, where it went, and its target by the Task's size.
    lead: await jobLead(jobs, job.workspace, job.ticket, history, normsDir),
    // The plain explanation of the current stop: explanation.json while it is the job's
    // current stop's (pending, written or failed); null otherwise.
    explanation: await currentExplanation(jobs, job),
    // The last review's comments while the job waits at its iteration (src/last-review-choices.ts);
    // null otherwise.
    last_review: await shownLastReview(jobs, job),
  };
}
