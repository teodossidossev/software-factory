// The browser tests' fixture (SF-091): the dashboard in-process over a state directory of its own,
// opened in a real Chromium (Playwright) at http://127.0.0.1:<port>/d/<token>/.
//
// Once per test process (node --test runs each file in its own): a temporary Git repository with a
// base commit (src/a.ts, README.md), a clone of it where both files are changed (the Patch and the
// file list of the published iteration are built from it), SF_CONFIG_DIR set to a temporary
// directory whose registry holds the fixture's workspace (the user's registry is never read), and
// one Chromium. Per test (browserTest): a new state directory with the six jobs, the planned tickets
// and their history, new fake actions, setup and queue that record each call and answer as the
// real ones do for the cases tested, a new startDashboard and a new page, all closed after the test.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { type Browser, chromium, type Page, type Request } from 'playwright';
import { type DashboardActions, type DashboardDigests, type DashboardQueue, type DashboardSetup, type RunningDashboard, startDashboard } from '../../src/dashboard.js';
import { digestCounts, type DigestRecord } from '../../src/digest-run.js';
import { FactoryError } from '../../src/errors.js';
import { type EventRecord, type Job, type JobState, JobStore, runningJobs, TERMINAL_STATES } from '../../src/jobs.js';
import { messageText, mrMessage, mrProblems, mrTextProblem } from '../../src/mr.js';
import { buildPatch, fileChanges } from '../../src/patch.js';
import { MAX_RUNNING, MIN_RUNNING } from '../../src/queue.js';
import { saveRegistry, type WorkspaceColor, workspaceColor } from '../../src/registry.js';
import type { WorkspaceRow, WorkspaceSettings } from '../../src/setup.js';
import { COMMIT_TYPES, MANUAL_CLAIM, MAX_HEADER_CHARS, MR_REQUIRED_HEADINGS } from '../../src/rules.js';
import { DRAFT_MARKER, isDraft, taskSha256 } from '../../src/task-file.js';
import { TicketHistory } from '../../src/ticket-history.js';

// The fixture's one workspace and its tickets.
export const WS = 'app';
export const JOBS = {
  working: 'SF-W1',
  reviewing: 'SF-R1',
  simplify: 'SF-S1',
  gate: 'SF-G1',
  ready: 'SF-M1',
  pushed: 'SF-T9',
} as const;
export const PLANNED = { first: 'SF-T1', second: 'SF-T2', unqueued: 'SF-T3', skeleton: 'SF-T4' } as const;

// The files the clone changes against the base commit, before and after.
export const FILES = {
  'src/a.ts': { before: 'export const greeting = "hello";\n', after: 'export const greeting = "hello, world";\n' },
  'README.md': { before: '# Demo\n\nA small project.\n', after: '# Demo\n\nA small project with a greeting.\n' },
};

// The valid MR text of the ready job.
const MR_TEXT = [
  `feat(${JOBS.ready}): Add the greeting`,
  '',
  ...MR_REQUIRED_HEADINGS.flatMap((heading) => [heading, '', `Text of ${heading.slice(3)}.`, '']),
].join('\n');
// The MR text's title and body as the Merge request screen shows them (src/mr.ts mrMessage).
export const MR_TITLE = MR_TEXT.split('\n')[0]!;
export const MR_BODY = MR_TEXT.split('\n').slice(1).join('\n').trim();

const HEADED = process.env.SF_BROWSER_HEADED === '1';
const T0 = '2026-11-01T10:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
// A live job: one in a state a new job of the ticket cannot start from.
const isLive = (job: Job | undefined): boolean => job !== undefined && !TERMINAL_STATES.includes(job.state);
// factory/dist/, where this file is compiled to dist/test/browser/support.js.
const DIST = fileURLToPath(new URL('../../', import.meta.url));

// ---------- Once per process: the Git repository, its clone, the registry, the browser ----------

interface Shared {
  temp: string;
  repo: string;
  base: string;
  patch: Awaited<ReturnType<typeof buildPatch>>;
  files: Awaited<ReturnType<typeof fileChanges>>;
  browser: Browser;
}

let shared: Promise<Shared> | undefined;
let stateCount = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

async function setUp(): Promise<Shared> {
  const temp = await mkdtemp(join(tmpdir(), 'sf-browser-'));
  const repo = join(temp, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  for (const [path, { before }] of Object.entries(FILES)) {
    await writeFile(join(repo, path), before);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  const work = join(temp, 'work');
  git(temp, 'clone', '-q', repo, work);
  for (const [path, { after: text }] of Object.entries(FILES)) {
    await writeFile(join(work, path), text);
  }
  const patch = await buildPatch(work, base);
  const files = await fileChanges(work, base, patch.files, () => ({ sensitive: 'no', scope: 'none' }));
  // Set before any startDashboard: the Changes screen resolves the workspace through it.
  process.env.SF_CONFIG_DIR = join(temp, 'config');
  await saveRegistry({ workspaces: { [WS]: { read_checkout: repo } } }, process.env.SF_CONFIG_DIR);
  const browser = await chromium.launch({ headless: !HEADED });
  return { temp, repo, base, patch, files, browser };
}

after(async () => {
  if (shared !== undefined) {
    const { browser, temp } = await shared;
    await browser.close();
    await rm(temp, { recursive: true, force: true });
  }
});

// ---------- The fakes ----------

export interface Call {
  method: string;
  args: unknown[];
}

const refuse = (code: string, message: string): never => {
  throw new FactoryError(code, message);
};

// The Task files of the fixture: the planned tickets, the live jobs' (for their titles) and SF-T9's
// archived one.
interface TaskEntry {
  title: string;
  text: string;
  mtime: string;
  lands_after: string[];
}

function taskText(ticket: string, title: string, landsAfter: string[] = [], draft = false): string {
  return [
    '---',
    `ticket: ${ticket}`,
    `title: ${title}`,
    'base: main',
    ...(landsAfter.length > 0 ? [`lands_after: [${landsAfter.join(', ')}]`] : []),
    '---',
    '',
    `# ${ticket}: ${title}`,
    '',
    ...(draft ? [DRAFT_MARKER, ''] : ['## Goal', '', `The goal of ${ticket}.`, '', '## Review brief', '', 'Check the goal.', '']),
  ].join('\n');
}

// The start screen's data over the fixture: the dependency states follow src/setup.ts's rule
// (running, pushed not merged, merged, planned, missing) over the job store.
export class FakeSetup implements DashboardSetup {
  readonly calls: Call[] = [];
  readonly tasks = new Map<string, TaskEntry>();
  readonly archived = new Map<string, TaskEntry>();
  readonly #jobs: JobStore;
  readonly #repo: string;

  constructor(jobs: JobStore, repo: string) {
    this.#jobs = jobs;
    this.#repo = repo;
    const add = (ticket: string, title: string, landsAfter: string[] = [], draft = false): void => {
      this.tasks.set(ticket, { title, text: taskText(ticket, title, landsAfter, draft), mtime: at(30), lands_after: landsAfter });
    };
    add(PLANNED.first, 'Add the login form');
    add(PLANNED.second, 'Remember the user', [JOBS.pushed]);
    add(PLANNED.unqueued, 'Show the user menu');
    add(PLANNED.skeleton, 'A new idea', [], true);
    add(JOBS.working, 'Build the greeting');
    add(JOBS.reviewing, 'Rename the settings');
    add(JOBS.simplify, 'Tidy the parser');
    add(JOBS.gate, 'Harden the importer');
    add(JOBS.ready, 'Add the greeting');
    add(JOBS.pushed, 'Store the session');
  }

  #record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  #known(name: string, ticket: string): TaskEntry {
    if (name !== WS) {
      refuse('workspace_not_found', `Workspace "${name}" is not registered.`);
    }
    return this.tasks.get(ticket) ?? refuse('task_not_found', `.software-factory/${ticket}.md does not exist.`);
  }

  async dependencyState(ticket: string): Promise<'merged' | 'pushed' | 'running' | 'planned' | 'missing'> {
    const job = await this.#jobs.read(WS, ticket);
    if (isLive(job)) {
      return 'running';
    }
    if (job?.state === 'pushed') {
      // An archived Task file whose job was not merged counts as planned (src/setup.ts).
      return job.mr?.state === 'merged' ? 'merged' : this.tasks.has(ticket) ? 'pushed' : 'planned';
    }
    return this.tasks.has(ticket) || this.archived.has(ticket) ? 'planned' : 'missing';
  }

  async #landsAfter(entry: TaskEntry): Promise<Array<{ workspace: string; ticket: string; state: Awaited<ReturnType<FakeSetup['dependencyState']>> }>> {
    const rows = [];
    for (const ticket of entry.lands_after) {
      rows.push({ workspace: WS, ticket, state: await this.dependencyState(ticket) });
    }
    return rows;
  }

  // The fixture's one workspace as the Setup's Edit leaves it (SF-103).
  workspace: { path: string; description: string | null; app: string; handoff: 'checkout' | 'off' | null; color: WorkspaceColor | null; digest: { track: boolean; my_work: boolean } } | undefined;

  async workspaces(): Promise<WorkspaceRow[]> {
    const live = (await this.#jobs.list()).filter(isLive).length;
    const own = this.workspace ?? { path: this.#repo, description: null, app: WS, handoff: null, color: null, digest: { track: false, my_work: false } };
    return [{
      name: WS, path: own.path, liveJobs: live, problem: null, handoff: own.handoff, color: workspaceColor(WS, own.color ?? undefined), app: own.app, description: own.description,
      derived_description: 'The app of the browser tests.', digest: own.digest,
    }];
  }

  async workspaceSettings(): Promise<WorkspaceSettings> {
    return { handoff_default: 'off', digest: { at: '08:00', weekdays_only: true, language: 'English' } };
  }

  // As Setup.editWorkspace, without Git: the fields replace the workspace's.
  async editWorkspace(name: string, edit: Parameters<DashboardSetup['editWorkspace']>[1]): Promise<WorkspaceRow> {
    this.#record('editWorkspace', name, edit);
    if (name !== WS) {
      refuse('workspace_not_found', `workspace "${name}" is not registered.`);
    }
    this.workspace = {
      path: edit.path, description: edit.description.trim() === '' ? null : edit.description.trim(), app: edit.app.trim() === '' ? WS : edit.app.trim(),
      handoff: edit.handoff === 'default' ? null : edit.handoff, color: edit.color === 'auto' ? null : edit.color, digest: edit.digest,
    };
    return (await this.workspaces())[0]!;
  }

  async saveDigestSettings(): Promise<never> {
    return refuse('setup_unavailable', 'Not in the browser fixture.');
  }

  async setTicketOwner(): Promise<never> {
    return refuse('setup_unavailable', 'Not in the browser fixture.');
  }

  async tickets() {
    const rows = [];
    for (const [ticket, entry] of [...this.tasks].sort(([a], [b]) => a.localeCompare(b))) {
      const job = await this.#jobs.read(WS, ticket);
      if (isLive(job)) {
        continue;
      }
      rows.push({
        workspace: WS, ticket, title: entry.title, base: 'main', draft: isDraft(entry.text), request: null, owner: 'chatgpt' as const, planning_chat: null,
        job: job?.state ?? null, lands_after: await this.#landsAfter(entry), attachments: [],
      });
    }
    return rows;
  }

  async jobDependencies() {
    return [];
  }

  async archivedTickets() {
    return [...this.archived].map(([ticket, entry]) => ({ workspace: WS, ticket, title: entry.title }));
  }

  async taskTitle(name: string, ticket: string) {
    return name === WS ? (this.tasks.get(ticket) ?? this.archived.get(ticket))?.title ?? null : null;
  }

  async taskText(name: string, ticket: string, archived = false) {
    if (archived) {
      return this.archived.get(ticket)?.text ?? refuse('task_not_found', `.software-factory/archive/${ticket}.md does not exist.`);
    }
    return this.#known(name, ticket).text;
  }

  async taskFile(name: string, ticket: string) {
    const entry = this.#known(name, ticket);
    return { text: entry.text, sha256: taskSha256(entry.text), mtime: entry.mtime };
  }

  // As Setup.saveTask: only over the version read (task_changed otherwise), refused while a job of
  // the ticket runs. Appends nothing to history.jsonl (the history test reads the fixture's lines).
  async saveTask(name: string, ticket: string, content: string, expected: string) {
    this.#record('saveTask', name, ticket, content, expected);
    const entry = this.#known(name, ticket);
    const job = await this.#jobs.read(name, ticket);
    if (isLive(job)) {
      refuse('job_active', `The job for ${name}/${ticket} is ${job!.state}.`);
    }
    if (taskSha256(entry.text) !== expected) {
      refuse('task_changed', `.software-factory/${ticket}.md changed since it was read.`);
    }
    entry.text = content;
    entry.mtime = new Date().toISOString();
    return { path: `.software-factory/${ticket}.md`, status: 'replaced' as const, bytes: Buffer.byteLength(content), sha256: taskSha256(content) };
  }

  async addWorkspace(): Promise<never> {
    return refuse('setup_unavailable', 'Not in the browser fixture.');
  }

  async removeWorkspace(): Promise<never> {
    return refuse('setup_unavailable', 'Not in the browser fixture.');
  }

  async createTicket(): Promise<never> {
    return refuse('setup_unavailable', 'Not in the browser fixture.');
  }

  async archiveTicket(): Promise<never> {
    return refuse('setup_unavailable', 'Not in the browser fixture.');
  }

  async restoreTicket(): Promise<never> {
    return refuse('setup_unavailable', 'Not in the browser fixture.');
  }

  async deleteTicket(): Promise<never> {
    return refuse('setup_unavailable', 'Not in the browser fixture.');
  }

  async addAttachment(): Promise<never> {
    return refuse('setup_unavailable', 'Not in the browser fixture.');
  }

  async removeAttachment(): Promise<never> {
    return refuse('setup_unavailable', 'Not in the browser fixture.');
  }

  async readAttachment(): Promise<never> {
    return refuse('attachment_missing', 'The ticket has no images.');
  }

  async setPlanningChat(): Promise<never> {
    return refuse('setup_unavailable', 'Not in the browser fixture.');
  }

  async planningOf() {
    return { owner: 'chatgpt' as const, planning_chat: null };
  }
}

// The morning digest's stored records (SF-103), as Digests lists and reads them; Generate now is
// recorded and marks a run as going (digest_running for a second one).
export class FakeDigests implements DashboardDigests {
  readonly records: DigestRecord[] = [];
  readonly starts: string[] = [];
  running = false;

  async list() {
    const digests = [...this.records].sort((a, b) => b.started_at.localeCompare(a.started_at)).map((record) => ({
      id: record.id, trigger: record.trigger, period: record.period, ended_at: record.ended_at, counts: digestCounts(record.workspaces), cost_usd: record.cost_usd, error: record.error,
    }));
    return { running: this.running, digests };
  }

  async read(id: string) {
    return this.records.find((record) => record.id === id);
  }

  start(trigger: 'scheduled' | 'manual'): { started: true } {
    this.starts.push(trigger);
    if (this.running) {
      refuse('digest_running', 'A digest is running.');
    }
    this.running = true;
    return { started: true };
  }
}

// The run queue over the fixture's tickets, with RunQueue's validation and answers (src/queue.ts):
// 1-based positions (invalid_position), a limit of 1-20 (invalid_limit), already_queued, not_queued,
// no Task file (task_not_found), a skeleton (task_draft), a live job (job_exists). Its view waits for
// the tickets not merged yet and has no plan check (every plan counts as ready).
export class FakeQueue implements DashboardQueue {
  readonly calls: Call[] = [];
  readonly entries: Array<{ workspace: string; ticket: string; queued_at: string }> = [
    { workspace: WS, ticket: PLANNED.first, queued_at: at(40) },
    { workspace: WS, ticket: PLANNED.second, queued_at: at(41) },
  ];
  // The two running jobs (working, awaiting_review) fill it: a real RunQueue would start nothing.
  maxRunning = 2;
  readonly #jobs: JobStore;
  readonly #setup: FakeSetup;

  constructor(jobs: JobStore, setup: FakeSetup) {
    this.#jobs = jobs;
    this.#setup = setup;
  }

  #index(workspace: string, ticket: string): number {
    const index = this.entries.findIndex((entry) => entry.workspace === workspace && entry.ticket === ticket);
    return index >= 0 ? index : refuse('not_queued', `${workspace}/${ticket} is not in the queue.`);
  }

  #position(value: number, name: string): number {
    return Number.isInteger(value) && value >= 1 ? value - 1 : refuse('invalid_position', `${name} must be a whole number from 1.`);
  }

  async view() {
    const jobs = await this.#jobs.list();
    const entries = [];
    let next: { workspace: string; ticket: string } | null = null;
    for (const [index, entry] of this.entries.entries()) {
      const task = this.#setup.tasks.get(entry.ticket);
      const waits = [];
      for (const ticket of task?.lands_after ?? []) {
        const state = await this.#setup.dependencyState(ticket);
        if (state !== 'merged') {
          waits.push({ workspace: WS, ticket, state });
        }
      }
      if (next === null && waits.length === 0) {
        next = { workspace: entry.workspace, ticket: entry.ticket };
      }
      entries.push({ ...entry, position: index + 1, waits_for: waits, force: false, plan_reason: null, retry: null });
    }
    return {
      max_running: this.maxRunning, running: runningJobs(jobs).length, held: false, hold_reason: null, on_limit: 'resume-then-queue' as const,
      limit_hold: null, entries, errors: [], next,
    };
  }

  async add(workspace: string, ticket: string, position?: number) {
    this.calls.push({ method: 'add', args: [workspace, ticket, position] });
    const index = position === undefined ? undefined : this.#position(position, 'at');
    if (this.entries.some((entry) => entry.workspace === workspace && entry.ticket === ticket)) {
      refuse('already_queued', `${workspace}/${ticket} is already in the queue.`);
    }
    const task = workspace === WS ? this.#setup.tasks.get(ticket) : undefined;
    if (task === undefined) {
      refuse('task_not_found', `.software-factory/${ticket}.md does not exist.`);
    }
    if (isDraft(task!.text)) {
      refuse('task_draft', `.software-factory/${ticket}.md is still the skeleton: the Context owner writes the Task with write_task first.`);
    }
    const job = await this.#jobs.read(workspace, ticket);
    if (isLive(job)) {
      refuse('job_exists', `The job for ${workspace}/${ticket} is ${job!.state}.`);
    }
    const place = Math.min(index ?? this.entries.length, this.entries.length);
    this.entries.splice(place, 0, { workspace, ticket, queued_at: new Date().toISOString() });
    return { position: place + 1 };
  }

  async remove(workspace: string, ticket: string) {
    this.calls.push({ method: 'remove', args: [workspace, ticket] });
    this.entries.splice(this.#index(workspace, ticket), 1);
    return { removed: true as const };
  }

  async move(workspace: string, ticket: string, to: number) {
    this.calls.push({ method: 'move', args: [workspace, ticket, to] });
    const index = this.#position(to, 'to');
    const [entry] = this.entries.splice(this.#index(workspace, ticket), 1);
    const position = Math.min(index, this.entries.length);
    this.entries.splice(position, 0, entry!);
    return { position: position + 1 };
  }

  async limit(maxRunning: number) {
    this.calls.push({ method: 'limit', args: [maxRunning] });
    if (!Number.isInteger(maxRunning) || maxRunning < MIN_RUNNING || maxRunning > MAX_RUNNING) {
      refuse('invalid_limit', `The limit must be a whole number from ${MIN_RUNNING} to ${MAX_RUNNING}.`);
    }
    this.maxRunning = maxRunning;
    return { max_running: maxRunning };
  }

  // Not used by the tests: refused as an unknown state would be.
  async hold(): Promise<never> {
    return this.#unused('hold');
  }

  async release(): Promise<never> {
    return this.#unused('release');
  }

  async rule(): Promise<never> {
    return this.#unused('rule');
  }

  async force(): Promise<never> {
    return this.#unused('force');
  }

  #unused(method: string): never {
    this.calls.push({ method, args: [] });
    return refuse('invalid_state', `${method} is not part of the browser fixture.`);
  }

  withTicket<T>(_workspace: string, _ticket: string, work: () => Promise<T>): Promise<T> {
    return work();
  }
}

// The job actions: each call recorded. say, simplify and the Merge request screen's view and Save
// answer as the Execution does for the fixture's jobs (the states that take them, the MR text's
// rules of src/mr.ts); the others are not used by the tests and refuse as an unknown state would.
export class FakeActions {
  readonly calls: Call[] = [];
  readonly #jobs: JobStore;
  // What mergeRequestHost answers for every workspace: off by default; a test turns it on (SF-107).
  mrHost: Awaited<ReturnType<DashboardActions['mergeRequestHost']>> = { host: null, reason: 'origin is not a GitHub or GitLab remote' };

  constructor(jobs: JobStore) {
    this.#jobs = jobs;
  }

  async #job(workspace: string, ticket: string): Promise<Job> {
    return (await this.#jobs.read(workspace, ticket)) ?? refuse('job_not_found', `No job for ${workspace}/${ticket}.`);
  }

  // The DashboardActions the dashboard is given: every method records its call.
  bind(): DashboardActions {
    const record = (method: string, run?: (...args: never[]) => Promise<unknown>) => async (...args: unknown[]): Promise<never> => {
      this.calls.push({ method, args });
      if (run === undefined) {
        return refuse('invalid_state', `${method} is not part of the browser fixture.`);
      }
      return (await (run as (...a: unknown[]) => Promise<unknown>)(...args)) as never;
    };
    return {
      start: record('start'), approve: record('approve'), abort: record('abort'), retryReview: record('retryReview'), retryMr: record('retryMr'),
      acceptGate: record('acceptGate'), settle: record('settle'), archiveFinished: record('archiveFinished'), createMergeRequest: record('createMergeRequest'),
      mergeMergeRequest: record('mergeMergeRequest'), mergeRequestStatus: record('mergeRequestStatus'), pause: record('pause'), resumePaused: record('resumePaused'),
      restart: record('restart'), handover: record('handover'), takeback: record('takeback'), handedDone: record('handedDone'), markMerged: record('markMerged'),
      resetMr: record('resetMr'),
      say: record('say', (workspace: string, ticket: string) => this.#say(workspace, ticket)),
      simplify: record('simplify', (workspace: string, ticket: string) => this.#simplify(workspace, ticket)),
      saveMr: record('saveMr', (workspace: string, ticket: string, input: { title: string; body: string; branch?: string; base?: string }) => this.#saveMr(workspace, ticket, input)),
      // Read on every payload: not recorded.
      mergeRequestHost: async () => this.mrHost,
      checkHandedOver: async (workspace: string, ticket: string) => {
        const job = await this.#job(workspace, ticket);
        return { state: job.state, branch: job.branch };
      },
      mergeRequestView: (workspace: string, ticket: string) => this.#mrView(workspace, ticket),
    } as unknown as DashboardActions;
  }

  async #say(workspace: string, ticket: string): Promise<{ state: JobState; queued: boolean }> {
    const job = await this.#job(workspace, ticket);
    if (!['working', 'awaiting_review', 'needs_human', 'ready_for_human_review', 'handed_over'].includes(job.state)) {
      refuse('invalid_state', `say needs a job that takes a message; the job is ${job.state}.`);
    }
    return { state: job.state, queued: job.state !== 'needs_human' };
  }

  async #simplify(workspace: string, ticket: string): Promise<{ state: JobState; iteration: number; check_after_minutes: number }> {
    const job = await this.#job(workspace, ticket);
    if (job.state !== 'needs_human' || job.error?.code !== 'simplify_offered') {
      refuse('invalid_state', `simplify needs needs_human with simplify_offered; the job is ${job.state}.`);
    }
    return { state: 'working', iteration: job.iteration, check_after_minutes: 5 };
  }

  // As the Execution's mergeRequestView (src/execution/mr-steps.ts) for a job without a Git host
  // and without a prepared commit's message to compare.
  async #mrView(workspace: string, ticket: string) {
    const job = await this.#job(workspace, ticket);
    const text = await this.#jobs.readMrText(workspace, ticket);
    if (text === undefined) {
      return undefined;
    }
    const factoryText = await this.#jobs.readMrFactoryText(workspace, ticket);
    const message = mrMessage(text);
    const factory = factoryText === undefined ? message : mrMessage(factoryText);
    const edited = factoryText !== undefined && factoryText !== text;
    const editable = job.state === 'ready_for_human_review';
    return {
      title: message.title, body: message.body, factory, edited, edited_at: null, factory_new_at: null,
      branch: job.branch, base: job.base, branch_editable: true, branch_reason: null, base_editable: true, base_reason: null,
      problems: mrProblems(ticket, message, job.branch, job.base),
      pushed: false, pushed_at: null, editable, readonly_reason: editable ? null : 'The MR text can be edited while the job is ready for review.',
      target: { host: null, repository: null },
      rules: { commit_types: [...COMMIT_TYPES], max_header_chars: MAX_HEADER_CHARS, required_headings: [...MR_REQUIRED_HEADINGS], manual_claim: { source: MANUAL_CLAIM.source, flags: MANUAL_CLAIM.flags } },
      commit: null, commit_differs: false,
    };
  }

  // As the Execution's saveMr: refused outside ready_for_human_review, a title of more than one
  // line or a text that breaks the rules (mr_text_invalid); the first save keeps the factory's text.
  async #saveMr(workspace: string, ticket: string, input: { title: string; body: string; branch?: string; base?: string }) {
    const job = await this.#job(workspace, ticket);
    if (job.state !== 'ready_for_human_review') {
      refuse('invalid_state', `Save needs ready_for_human_review, or needs_human after a failed push; the job is ${job.state}.`);
    }
    const current = (await this.#jobs.readMrText(workspace, ticket)) ?? refuse('mr_text_missing', `The job ${workspace}/${ticket} has no MR text yet.`);
    if (/[\r\n]/.test(input.title)) {
      refuse('mr_text_invalid', 'The MR title must be one line.');
    }
    const text = messageText(mrMessage(messageText({ title: input.title, body: input.body })));
    const problem = mrTextProblem(ticket, text);
    if (problem !== undefined) {
      refuse('mr_text_invalid', `The MR text is invalid: ${problem}.`);
    }
    if ((await this.#jobs.readMrFactoryText(workspace, ticket)) === undefined) {
      await this.#jobs.writeMrFactoryText(workspace, ticket, current);
    }
    await this.#jobs.writeMrText(workspace, ticket, text);
    return { state: job.state, branch: input.branch ?? job.branch, base: input.base ?? job.base, edited: true, prepared_commit: job.prepared_commit };
  }
}

// ---------- The state directory of one test ----------

const stateRecord = (from: JobState | null, to: JobState, ts: string, error?: { code: string; message: string }): EventRecord =>
  ({ ts, iteration: 0, state: { from, to, ...(error !== undefined ? { error } : {}) } });

async function writeState(state: string, jobs: JobStore, { base, patch, files }: Shared): Promise<void> {
  const job = (ticket: string, jobState: JobState, iteration: number, minutes: number, extra: Partial<Job> = {}): Job => ({
    workspace: WS, ticket, branch: `${ticket}-work`, base: 'main', continues: null, base_commit: base, target_commit: null, worktree: null, prepared_commit: null,
    mr_attempts: 0, mr_conflict_turn: false, fixes: 0, gate_fixes: 0, gate_tokens: 0, state: jobState, iteration, session_id: `session-${ticket}`, mr: null,
    created_at: at(minutes), updated_at: at(minutes + 5), ...extra,
  });
  const publish = async (ticket: string, minutes: number): Promise<void> => {
    await jobs.writeIteration(WS, ticket, {
      report: `# Report: ${ticket}, iteration 1\n## Done\nThe change.\n`,
      patch: patch.patch,
      meta: {
        iteration: 1, started_at: at(minutes), ended_at: at(minutes + 3), denials: [], changed_files: patch.files, files, patch_truncated: false,
        submodule_changed: [], cost_usd: 0.4, cost_usd_total: 0.4, duration_ms: 180_000, base_commit: base,
      },
    });
  };
  const review = { reviewer: 'claude', verdict: 'clean' as const, summary: 'The change does what the Task asks.', items: [], accepted_sensitive: [], cost_usd: 0.1, started_at: at(20), ended_at: at(21) };
  const item = (path: string, problem: string) => ({ path, problem, expected: `Fix ${path}.`, severity: 'major' as const, reopens: '', caused_by: '' });

  // Implementing: a Stream with the prompt, a text, a tool call and its result.
  await jobs.write(job(JOBS.working, 'working', 0, 10));
  await jobs.appendEvent(WS, JOBS.working, stateRecord(null, 'starting', at(10)));
  await jobs.appendEvent(WS, JOBS.working, stateRecord('starting', 'working', at(10)));
  await jobs.appendEvent(WS, JOBS.working, { ts: at(11), iteration: 0, prompt: `/implement .software-factory/${JOBS.working}.md` });
  await jobs.appendEvent(WS, JOBS.working, {
    ts: at(12), iteration: 0,
    message: { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the Task file first.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] } },
  });
  await jobs.appendEvent(WS, JOBS.working, {
    ts: at(13), iteration: 0,
    message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok 1 greeting\nall 1 passed', is_error: false }] } },
  });

  // Reviewing.
  await jobs.write(job(JOBS.reviewing, 'awaiting_review', 1, 15));
  await publish(JOBS.reviewing, 15);
  await jobs.appendEvent(WS, JOBS.reviewing, stateRecord('working', 'awaiting_review', at(18)));

  // Your turn: the simplification offered (a decision, not an error).
  await jobs.write(job(JOBS.simplify, 'needs_human', 1, 16, { error: { code: 'simplify_offered', message: 'The simplification pass suggests changes.' }, simplify_iteration: 1 }));
  await publish(JOBS.simplify, 16);
  await jobs.writeReview(WS, JOBS.simplify, 1, review);
  await jobs.writeSimplify(WS, JOBS.simplify, 1, {
    reviewer: 'claude', summary: 'One helper the fixes added is not needed.', model: null, cost_usd: 0.05, started_at: at(22), ended_at: at(23), dropped: [],
    suggestions: [{ path: 'src/a.ts', what: 'Inline the helper', why: 'Used once.', saves_lines: 6, ledger_ids: [] }],
  });
  await jobs.appendEvent(WS, JOBS.simplify, stateRecord('awaiting_review', 'needs_human', at(23), { code: 'simplify_offered', message: 'The simplification pass suggests changes.' }));

  // Your turn: the gate's round limit, with two findings to decide.
  await jobs.write(job(JOBS.gate, 'needs_human', 1, 17, { gate_fixes: 2, error: { code: 'gate_rounds', message: 'Codex asked for fixes 2 times, the limit.' } }));
  await publish(JOBS.gate, 17);
  await jobs.writeReview(WS, JOBS.gate, 1, review);
  await jobs.writeGate(WS, JOBS.gate, 1, {
    reviewer: 'codex', verdict: 'fix', summary: 'Two findings.', items: [item('src/a.ts', 'The greeting is not escaped.'), item('README.md', 'The README names the wrong command.')],
    accepted_sensitive: [], tokens: { input: 1000, cached_input: 0, output: 200 }, started_at: at(24), ended_at: at(25),
  });
  await jobs.appendEvent(WS, JOBS.gate, stateRecord('awaiting_review', 'needs_human', at(25), { code: 'gate_rounds', message: 'Codex asked for fixes 2 times, the limit.' }));

  // Your turn: ready for review, with its MR text, its Patch over src/a.ts and README.md and its review.
  await jobs.write(job(JOBS.ready, 'ready_for_human_review', 1, 19));
  await publish(JOBS.ready, 19);
  await jobs.writeReview(WS, JOBS.ready, 1, review);
  await jobs.writeMrText(WS, JOBS.ready, `${MR_TEXT}\n`);
  await jobs.appendEvent(WS, JOBS.ready, stateRecord('preparing_mr', 'ready_for_human_review', at(26)));

  // Done: SF-T9 pushed, its merge request open (not merged).
  await jobs.write(job(JOBS.pushed, 'pushed', 1, 1, { mr: { host: 'github', number: 7, url: 'https://github.invalid/acme/app/pull/7', state: 'open' } }));
  await publish(JOBS.pushed, 1);
  await jobs.appendEvent(WS, JOBS.pushed, stateRecord('ready_for_human_review', 'pushed', at(8)));

  // SF-T1's history, as src/ticket-history.ts records it: created, then edited, both by you.
  const text = taskText(PLANNED.first, 'Add the login form');
  await new TicketHistory(state, () => new Date(at(30))).append(WS, PLANNED.first, { kind: 'created', by: 'you', sha256: taskSha256(text) });
  await new TicketHistory(state, () => new Date(at(35))).append(WS, PLANNED.first, { kind: 'edited', by: 'you', sha256: taskSha256(text) });
}

// ---------- browserTest ----------

export interface Fixture {
  page: Page;
  dashboard: RunningDashboard;
  // http://127.0.0.1:<port>/d/<token>/
  url: string;
  state: string;
  jobs: JobStore;
  actions: FakeActions;
  setup: FakeSetup;
  queue: FakeQueue;
  digests: FakeDigests;
  // Console errors, page errors, failed requests and responses of 400 and more, since the page opened.
  problems: string[];
  // Opens the page at the hash (the board without one) and waits until the stream has delivered
  // the board's data.
  open(hash?: string): Promise<void>;
  // The next POST to the path under the dashboard URL (e.g. "api/queue/move").
  posted(path: string): Promise<Request>;
}

// The test file's name without .test.js: node --test runs each file as its own process.
const fileStem = (): string => basename(process.argv[1] ?? 'browser').replace(/\.test\.js$/, '').replace(/\.js$/, '');

export function browserTest(name: string, fn: (fx: Fixture) => Promise<void>, options: { todo?: string } = {}): void {
  test(name, options, async () => {
    shared ??= setUp();
    const once = await shared;
    stateCount += 1;
    const state = join(once.temp, `state-${stateCount}`);
    await mkdir(state, { recursive: true });
    const jobs = new JobStore(state);
    await writeState(state, jobs, once);
    const setup = new FakeSetup(jobs, once.repo);
    const queue = new FakeQueue(jobs, setup);
    const actions = new FakeActions(jobs);
    const digests = new FakeDigests();
    const dashboard = await startDashboard(0, state, jobs, actions.bind(), setup, { queue, digests });
    const context = await once.browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const url = dashboard.url.href;
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        problems.push(`console: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
    page.on('requestfailed', (request) => problems.push(`request failed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));
    page.on('response', (response) => {
      if (response.status() >= 400) {
        problems.push(`HTTP ${response.status()}: ${response.request().method()} ${response.url()}`);
      }
    });
    const fx: Fixture = {
      page, dashboard, url, state, jobs, actions, setup, queue, digests, problems,
      async open(hash = '') {
        await page.goto(`${url}${hash === '' ? '' : `#${hash}`}`);
        await page.waitForFunction(() => document.getElementById('health-light')?.dataset.stream === 'live');
      },
      posted(path) {
        return page.waitForRequest((request) => request.method() === 'POST' && request.url() === `${url}${path}`);
      },
    };
    try {
      await fn(fx);
    } catch (error) {
      const file = join(DIST, 'test-results', `${fileStem()}-${name.replace(/[^A-Za-z0-9-]/g, '-')}.png`);
      try {
        await mkdir(join(DIST, 'test-results'), { recursive: true });
        await page.screenshot({ path: file, fullPage: true });
        console.log(`screenshot: ${file}`);
      } catch (shot) {
        console.log(`screenshot failed: ${(shot as Error).message}`);
      }
      throw error;
    } finally {
      await context.close();
      await dashboard.close();
    }
  });
}

// ---------- Colour helpers of the layout tests ----------

// "rgb(r, g, b)" or "rgba(r, g, b, a)" as numbers; a = 1 without alpha.
function parseColor(value: string): { r: number; g: number; b: number; a: number } {
  const match = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(value.trim());
  if (match === null) {
    throw new Error(`Not an rgb() colour: ${value}`);
  }
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
}

// The WCAG 2 contrast ratio of two opaque colours.
export function contrast(a: string, b: string): number {
  const luminance = (value: string): number => {
    const { r, g, b: blue } = parseColor(value);
    const channel = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(blue);
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

// Reads until the value deep-equals expected (the page redraws after the server's answer), at most
// 5 s; then fails with the last value read.
export async function eventually<T>(read: () => Promise<T>, expected: T): Promise<void> {
  const end = Date.now() + 5000;
  let last: T = await read();
  while (!isDeepStrictEqual(last, expected) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    last = await read();
  }
  assert.deepEqual(last, expected);
}
