// One morning digest run: the followed workspaces' mirrors and Git data (src/digest.ts),
// one model call with a structured output (retried once; on a second failure the digest keeps the
// Git data and the error), the stored record digest/<id>.json in the state directory, and for a
// scheduled run one notification with counts only. A run that is going is not started twice
// (digest_running). The digest's data stays on this machine: the state directory, the dashboard,
// and the model.
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { type DailyJob, type DailyJobs, type DigestInProgress, inProgressOf, jobsOf, liveBranch, within } from './digest-jobs.js';
import { capModelInput, derivedDescription, MAX_MODEL_INPUT_CHARS, extractRepo, type LiveBranch, maskCredentials, type MirrorResult, type MyCommit, myEmail, needsAttention, type RepoData, syncMirror } from './digest.js';
import { FactoryError } from './errors.js';
import { JobStore } from './jobs.js';
import { type ChannelResult, digestNotification, type Notification } from './notify.js';
import { digestPrompt } from './prompts.js';
import { atTime } from './digest-schedule.js';
import { configDir as defaultConfigDir, DIGEST_DEFAULTS, type DigestSettings, digestSettings, loadRegistry, verifyCheckout, workspaceApp, workspaceDigest } from './registry.js';
import { type ReviewOptions, runStructuredSession, type StructuredOutcome } from './review.js';

export const DIGEST_DIR = 'digest';
export const DIGEST_KEEP_DAYS = 60;
export const MODEL_TIMEOUT_MS = 10 * 60_000;
export const DIGEST_MAX_TURNS = 3;
export const TRIGGERS = ['scheduled', 'manual'] as const;
export type Trigger = (typeof TRIGGERS)[number];
// <YYYYMMDD>T<HHMMSS>Z-<trigger>[-N]: the run's start in UTC.
export const DIGEST_ID = /^(\d{8}T\d{6}Z)-(scheduled|manual)(?:-([2-9]|[1-9]\d{1,3}))?$/;
const DAY = 86_400_000;

// ---------- The model's output ----------

// Every text of the model twice: text in the settings' language, en the same in plain English.
const bilingual = z.strictObject({ text: z.string(), en: z.string() });
export type DigestText = z.output<typeof bilingual>;

const digestOutput = z.strictObject({
  repos: z.array(z.strictObject({
    name: z.string(),
    headline: bilingual.describe('One or two plain sentences: what happened and where the work is heading.'),
    merged: z.array(z.strictObject({ sha: z.string(), problem: bilingual.describe('The problem it solves, in one plain sentence.') })),
    branches: z.array(z.strictObject({ ref: z.string(), what: bilingual.describe('What is going on there, in one plain sentence.') })),
    impact_on_me: z.array(bilingual).describe('Per ticket of mine: what I have to do and why, in plain words.'),
  })),
  cross_repo: z.array(z.strictObject({
    ticket: z.string(),
    by_workspace: z.record(z.string(), bilingual),
    for_me: bilingual,
  })).max(6),
  dailies: z.array(z.strictObject({
    app: z.string(),
    workspaces: z.array(z.string()),
    yesterday: z.array(bilingual),
    problems: z.array(bilingual),
    plan: z.array(bilingual),
    next: z.array(bilingual),
  })),
});
export type DigestOutput = z.output<typeof digestOutput>;
export { digestOutput };
const { $schema: _draft, ...digestSchema } = z.toJSONSchema(digestOutput, { target: 'draft-7' });
export const DIGEST_SCHEMA: Record<string, unknown> = digestSchema;

// ---------- The record ----------

export interface Span {
  from: string;
  to: string;
}

export interface DigestWorkspace {
  name: string;
  app: string;
  // The workspace's own description, else the one derived from the repository, or null.
  description: string | null;
  description_source: 'workspace' | 'repository' | null;
  // Followed: a repository card and its data in the counts. my_work: my commits feed the daily.
  track: boolean;
  my_work: boolean;
  fetch: Omit<MirrorResult, 'path'>;
  git: RepoData | null;
  // Why the workspace has no Git data (its checkout, the extraction), or null.
  error: string | null;
}

export interface DailyCommit extends MyCommit {
  workspace: string;
}

// The material of one daily: an app with a my_work workspace and my commits, the factory's jobs
// for me or live branches.
export interface DailySource {
  app: string;
  workspaces: string[];
  commits: DailyCommit[];
  // The factory's jobs handed over, pushed or merged within the two days.
  jobs: DailyJob[];
  // My open branches with recent work or a job going (src/digest-jobs.ts liveBranch).
  open_branches: Array<LiveBranch & { workspace: string }>;
}

export interface DigestCounts {
  landed: number;
  live_branches: number;
  impact: number;
}

export interface DigestRecord {
  id: string;
  trigger: Trigger;
  started_at: string;
  ended_at: string;
  period: Span;
  daily_days: { yesterday: Span; today: Span };
  model: string;
  language: string;
  workspaces: DigestWorkspace[];
  daily_sources: DailySource[];
  output: DigestOutput | null;
  cost_usd: number | null;
  // The model call's failure (the page shows the Git data with a note), or null.
  error: string | null;
  // What the digest says about its data (the cap, the factory's jobs it could not read).
  notes: string[];
  counts: DigestCounts;
  // My factory jobs running or waiting at the run (src/digest-jobs.ts inProgressOf); never sent to
  // the model. A record written before it has none: read as [].
  in_progress: DigestInProgress[];
}

export interface DigestSummary {
  id: string;
  trigger: Trigger;
  period: Span;
  ended_at: string;
  counts: DigestCounts;
  cost_usd: number | null;
  error: string | null;
}

// The counts, from the Git data of the followed workspaces only, never from the model: what landed
// in the period, the live branches not landed, and my branches not landed with shared files or more
// than 10 commits behind.
export function digestCounts(workspaces: DigestWorkspace[]): DigestCounts {
  const followed = workspaces.filter((workspace) => workspace.track && workspace.git !== null).map((workspace) => workspace.git!);
  return {
    landed: followed.reduce((sum, git) => sum + git.landed.length, 0),
    live_branches: followed.reduce((sum, git) => sum + git.branches.filter((branch) => !branch.landed).length, 0),
    impact: followed.reduce((sum, git) => sum + git.branches.filter(needsAttention).length, 0),
  };
}

// ---------- The days ----------

const localDay = (date: Date, offset = 0): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
const isWeekend = (date: Date): boolean => date.getDay() === 0 || date.getDay() === 6;

// The daily's two days: yesterday, from 00:00 (local time) of the last working day before today to
// 00:00 of today (Friday and the weekend on a Monday), and today until now. No moment falls between
// them.
export function dailyDays(now: Date): { yesterday: Span; today: Span } {
  let yesterday = localDay(now, -1);
  while (isWeekend(yesterday)) {
    yesterday = localDay(yesterday, -1);
  }
  const today = localDay(now);
  return {
    yesterday: { from: yesterday.toISOString(), to: today.toISOString() },
    today: { from: today.toISOString(), to: now.toISOString() },
  };
}

// The period of every digest, scheduled or manual: from the earliest of the times (local time) on
// the previous digest day before today, to now; so every run of a day covers the same start. A
// digest day is any day, or a weekday with weekdays_only; so Friday on a Monday, a Saturday or a
// Sunday. Past digests do not move it.
export function digestPeriod(now: Date, settings: Pick<DigestSettings, 'times' | 'weekdays_only'>): Span {
  let day = localDay(now, -1);
  while (settings.weekdays_only && isWeekend(day)) {
    day = localDay(day, -1);
  }
  const earliest = [...settings.times].sort()[0] ?? DIGEST_DEFAULTS.times[0]!;
  return { from: atTime(day, earliest).toISOString(), to: now.toISOString() };
}

// The id's stamp: YYYYMMDDTHHMMSSZ of a time in UTC.
export function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function stampTime(id: string): number {
  const match = DIGEST_ID.exec(id);
  if (match === null) {
    return Number.NaN;
  }
  const s = match[1]!;
  return Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
}

// ---------- The store ----------

export class DigestStore {
  readonly dir: string;
  // The summaries of the records read so far, by id: a record never changes once written.
  readonly #summaries = new Map<string, DigestSummary & { started_at: string }>();

  constructor(stateDir: string) {
    this.dir = join(stateDir, DIGEST_DIR);
  }

  path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async #ids(): Promise<string[]> {
    try {
      return (await readdir(this.dir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name.slice(0, -5)).filter((id) => DIGEST_ID.test(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async read(id: string): Promise<DigestRecord | undefined> {
    if (!DIGEST_ID.test(id)) {
      return undefined;
    }
    try {
      const record = JSON.parse(await readFile(this.path(id), 'utf8')) as DigestRecord;
      // A record written before in_progress has none.
      return { ...record, in_progress: record.in_progress ?? [] };
    } catch { // missing or not JSON: no record
      return undefined;
    }
  }

  // Every record's summary, newest first (by start, then by id).
  async list(): Promise<Array<DigestSummary & { started_at: string }>> {
    const summaries = [];
    for (const id of await this.#ids()) {
      let summary = this.#summaries.get(id);
      if (summary === undefined) {
        const record = await this.read(id);
        if (record === undefined) {
          continue;
        }
        summary = { id, trigger: record.trigger, period: record.period, ended_at: record.ended_at, counts: digestCounts(record.workspaces), cost_usd: record.cost_usd, error: record.error, started_at: record.started_at };
        this.#summaries.set(id, summary);
      }
      summaries.push(summary);
    }
    return summaries.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id.localeCompare(a.id, 'en', { numeric: true }));
  }

  // Writes the record under its id, or <id>-2, -3, ... when that file exists: never over a record.
  async write(record: Omit<DigestRecord, 'id'>, base: string): Promise<DigestRecord> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const ids = new Set(await this.#ids());
    let id = base;
    for (let n = 2; ids.has(id); n += 1) {
      id = `${base}-${n}`;
    }
    const stored = { id, ...record };
    await writeFileAtomic(this.path(id), Buffer.from(`${JSON.stringify(stored, null, 2)}\n`));
    return stored;
  }

  // Deletes the records that started more than DIGEST_KEEP_DAYS before now.
  async prune(now: Date): Promise<string[]> {
    const removed = [];
    for (const id of await this.#ids()) {
      if (now.getTime() - stampTime(id) > DIGEST_KEEP_DAYS * DAY) {
        await rm(this.path(id), { force: true });
        this.#summaries.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }
}

// ---------- The run ----------

// The model call: one structured session; never throws.
export type DigestModel = (prompt: string, options: { model: string; cwd: string; signal: AbortSignal }) => Promise<StructuredOutcome<DigestOutput>>;

// The session of the digest: no tools besides the SDK's structured output, no setting sources (no
// CLAUDE.md, AGENTS.md or user settings), an empty directory as cwd, three turns.
export function digestSessionOptions(cwd: string, model: string, claudePath: string | undefined, signal: AbortSignal): ReviewOptions {
  return { cwd, claudePath, sandbox: undefined, model, maxTurns: DIGEST_MAX_TURNS, signal, tools: [], settingSources: [] };
}

export function sdkModel(claudePath: string | undefined): DigestModel {
  return (prompt, { model, cwd, signal }) => runStructuredSession(prompt, digestSessionOptions(cwd, model, claudePath, signal), {
    schema: DIGEST_SCHEMA, output: digestOutput, noun: 'digest', outputNoun: 'digest',
  });
}

export interface DigestsOptions {
  stateDir: string;
  configDir?: string;
  claudePath?: string | undefined;
  // The model call; the Agent SDK by default (tests give a fake).
  model?: DigestModel;
  // Sends the notification of a scheduled digest; none without.
  notify?: (notification: Notification) => Promise<ChannelResult[]>;
  now?: () => Date;
  // The model call's timeout; MODEL_TIMEOUT_MS by default.
  modelTimeoutMs?: number;
  // A run started or ended (the dashboard's pages).
  onChange?: () => void;
  // The factory's jobs, My daily's material; the state directory's by default.
  jobs?: JobStore;
}

export interface DigestRunResult {
  id: string;
  path: string;
  cost_usd: number | null;
  record: DigestRecord;
}

export class Digests {
  readonly store: DigestStore;
  readonly #stateDir: string;
  readonly #configDir: string;
  readonly #model: DigestModel;
  readonly #notify: DigestsOptions['notify'];
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #onChange: (() => void) | undefined;
  readonly #jobs: JobStore;
  #running: Trigger | null = null;

  constructor(options: DigestsOptions) {
    this.#stateDir = options.stateDir;
    this.#configDir = options.configDir ?? defaultConfigDir();
    this.store = new DigestStore(options.stateDir);
    this.#model = options.model ?? sdkModel(options.claudePath);
    this.#notify = options.notify;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.modelTimeoutMs ?? MODEL_TIMEOUT_MS;
    this.#onChange = options.onChange;
    this.#jobs = options.jobs ?? new JobStore(options.stateDir);
  }

  get running(): boolean {
    return this.#running !== null;
  }

  // GET api/digests: whether a run is going, and every digest's summary, newest first.
  async list(): Promise<{ running: boolean; digests: DigestSummary[] }> {
    return { running: this.running, digests: (await this.store.list()).map(({ started_at: _started, ...summary }) => summary) };
  }

  read(id: string): Promise<DigestRecord | undefined> {
    return this.store.read(id);
  }

  async latest(): Promise<DigestSummary | undefined> {
    return (await this.list()).digests[0];
  }

  // Whether a scheduled digest started at or after since (the scheduler: its due slot).
  async scheduledSince(since: Date): Promise<boolean> {
    return (await this.store.list()).some((summary) => summary.trigger === 'scheduled' && Date.parse(summary.started_at) >= since.getTime());
  }

  #claim(trigger: Trigger): void {
    if (this.#running !== null) {
      throw new FactoryError('digest_running', `A digest (${this.#running}) is running; it is not started twice.`);
    }
    this.#running = trigger;
  }

  // Starts a run and answers at once (POST api/digests/run, the scheduler); digest_running while one goes.
  start(trigger: Trigger): { started: true } {
    this.#claim(trigger);
    void this.#run(trigger).catch((error: unknown) => console.error(error));
    return { started: true };
  }

  // Runs one digest to its end (sf digest --now).
  async run(trigger: Trigger): Promise<DigestRunResult> {
    this.#claim(trigger);
    const record = await this.#run(trigger);
    return { id: record.id, path: this.store.path(record.id), cost_usd: record.cost_usd, record };
  }

  async #run(trigger: Trigger): Promise<DigestRecord> {
    this.#changed();
    try {
      return await this.#digest(trigger);
    } finally {
      this.#running = null;
      this.#changed();
    }
  }

  #changed(): void {
    try {
      this.#onChange?.();
    } catch (error) {
      console.error(error);
    }
  }

  async #digest(trigger: Trigger): Promise<DigestRecord> {
    const started = this.#now();
    await this.store.prune(started).catch((error: unknown) => console.error(error));
    const registry = await loadRegistry(this.#configDir);
    const settings = digestSettings(registry);
    const period = digestPeriod(started, settings);
    const from = new Date(period.from);
    const to = started;
    const days = dailyDays(started);
    const since = new Date(Math.min(from.getTime(), Date.parse(days.yesterday.from)));
    const mirrors = join(this.#stateDir, DIGEST_DIR, 'mirrors');

    const workspaces: DigestWorkspace[] = [];
    for (const name of Object.keys(registry.workspaces).sort()) {
      const entry = registry.workspaces[name]!;
      const { track, my_work } = workspaceDigest(entry);
      if (!track && !my_work) {
        continue;
      }
      const workspace: DigestWorkspace = {
        name, app: workspaceApp(name, entry), description: entry.description ?? null, description_source: entry.description !== undefined ? 'workspace' : null,
        track, my_work, fetch: { status: 'skipped', message: null, last_fetch_ok_at: null, notes: [] }, git: null, error: null,
      };
      workspaces.push(workspace);
      let checkout: string;
      try {
        checkout = await verifyCheckout(entry.read_checkout, 'checkout');
      } catch (error) {
        workspace.error = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (workspace.description === null) {
        const derived = await derivedDescription(checkout);
        if (derived !== null) {
          workspace.description = derived;
          workspace.description_source = 'repository';
        }
      }
      try {
        const { path, ...fetch } = await syncMirror(mirrors, name, checkout, this.#now);
        workspace.fetch = fetch;
        if (path === undefined) {
          continue;
        }
        workspace.git = await extractRepo(path, { from, to, since, me: await myEmail(checkout), myWork: my_work });
      } catch (error) {
        workspace.error = maskCredentials(error instanceof Error ? error.message : String(error)).slice(0, 500);
      }
    }

    const notes: string[] = [];
    let jobs: DailyJobs = { done: [], current: [] };
    let inProgress: DigestInProgress[] = [];
    try {
      jobs = await jobsOf(this.#jobs, workspaces.filter((workspace) => workspace.my_work).map((workspace) => workspace.name), days);
      inProgress = await inProgressOf(this.#jobs, jobs.current, workspaces);
    } catch (failure) {
      notes.push(`The factory's jobs could not be read: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
    const dailySources = dailiesOf(workspaces, days, jobs);
    let output: DigestOutput | null = null;
    let cost: number | null = null;
    let error: string | null = null;
    if (workspaces.every((workspace) => workspace.git === null)) {
      error = workspaces.length === 0 ? 'No workspace is followed or has My daily on.' : 'No workspace gave Git data.';
    } else {
      const { input, cut } = modelInput(workspaces, dailySources, period, days, settings.language);
      // The whole prompt, its rules too, stays within the cap.
      const rules = digestPrompt(localDate(started), settings.language, null).length - 'null'.length;
      const note = capModelInput(input, cut, MAX_MODEL_INPUT_CHARS - rules);
      if (note !== null) {
        notes.push(note);
      }
      const prompt = digestPrompt(localDate(started), settings.language, input);
      const session = join(this.#stateDir, DIGEST_DIR, 'session');
      await mkdir(session, { recursive: true, mode: 0o700 });
      for (let attempt = 1; attempt <= 2 && output === null; attempt += 1) {
        const signal = AbortSignal.timeout(this.#timeoutMs);
        const outcome = await this.#model(prompt, { model: settings.model, cwd: session, signal });
        if (outcome.ok) {
          output = outcome.output;
          cost = (cost ?? 0) + (outcome.costUsd ?? 0);
          error = null;
        } else {
          error = signal.aborted ? `The model call timed out after ${Math.round(this.#timeoutMs / 60_000)} minutes.` : outcome.message;
        }
      }
    }
    const record = await this.store.write({
      trigger, started_at: started.toISOString(), ended_at: this.#now().toISOString(), period, daily_days: days,
      model: settings.model, language: settings.language, workspaces, daily_sources: dailySources, output, cost_usd: cost, error, notes, counts: digestCounts(workspaces),
      in_progress: inProgress,
    }, `${stamp(started)}-${trigger}`);
    if (trigger === 'scheduled' && this.#notify !== undefined) {
      try {
        for (const result of await this.#notify(digestNotification(record.counts))) {
          if (result.status === 'failed') {
            console.error(`digest ${record.id}: notification via ${result.channel} failed: ${result.message}`);
          }
        }
      } catch (failure) {
        console.error(failure);
      }
    }
    return record;
  }
}

const pad = (value: number): string => String(value).padStart(2, '0');
const localDate = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// One daily per app with a my_work workspace where I have commits in its two days, the factory's
// jobs done for me in them (jobsOf) or live branches (mine, not landed, liveBranch), in the order of
// the apps' first workspace. A parked branch stays out (the Repositories tab still shows it). A
// workspace without Git data still gives its jobs.
export function dailiesOf(workspaces: DigestWorkspace[], days: { yesterday: Span; today: Span }, jobs: DailyJobs): DailySource[] {
  const apps = new Map<string, DailySource>();
  for (const workspace of workspaces) {
    const done = jobs.done.filter((job) => job.workspace === workspace.name);
    if (!workspace.my_work || (workspace.git === null && done.length === 0)) {
      continue;
    }
    const source = apps.get(workspace.app) ?? { app: workspace.app, workspaces: [], commits: [], jobs: [], open_branches: [] };
    apps.set(workspace.app, source);
    source.workspaces.push(workspace.name);
    source.jobs.push(...done);
    if (workspace.git === null) {
      continue;
    }
    source.commits.push(...workspace.git.my_commits.filter((commit) => within(commit.date, days.yesterday) || within(commit.date, days.today)).map((commit) => ({ ...commit, workspace: workspace.name })));
    const { my_commits: mine } = workspace.git;
    source.open_branches.push(...workspace.git.branches.filter((branch) => branch.mine && !branch.landed && liveBranch(branch, workspace.name, mine, jobs.current, days)).map((branch) => ({ ...branch, workspace: workspace.name })));
  }
  return [...apps.values()].filter((source) => source.commits.length > 0 || source.jobs.length > 0 || source.open_branches.length > 0);
}

// The model's input: every workspace with Git data (a followed one with what landed, its live
// branches and my commits of the period; a my_work-only one with my open branches only), the apps,
// the dailies' material (my commits, the factory's jobs, my live branches), the period and the
// daily's days. cut: the entries the cap may cut, in the input itself (a copy of the record's data).
function modelInput(workspaces: DigestWorkspace[], dailies: DailySource[], period: Span, days: { yesterday: Span; today: Span }, language: string) {
  const strip = ({ full_sha: _full, ...entry }: RepoData['landed'][number]) => entry;
  const cut: Array<{ date: string; why: string; diff_excerpt?: string }> = [];
  const repos = workspaces.filter((workspace) => workspace.git !== null).map((workspace) => {
    const git = workspace.git!;
    const landed = workspace.track ? git.landed.map(strip) : [];
    const myCommits = workspace.track ? git.my_commits.filter((commit) => within(commit.date, period)).map((commit) => ({ ...commit })) : [];
    cut.push(...landed, ...myCommits);
    return {
      name: workspace.name, app: workspace.app, description: workspace.description, followed: workspace.track, main: git.main,
      ...(workspace.fetch.message !== null ? { fetch: workspace.fetch.message } : {}),
      landed, branches: workspace.track ? git.branches : git.branches.filter((branch) => branch.mine), my_commits: myCommits,
    };
  });
  const daily = dailies.map((source) => {
    const commits = source.commits.map((commit) => ({ ...commit }));
    cut.push(...commits);
    const jobs = source.jobs.map((job) => ({ ...job }));
    return { app: source.app, workspaces: source.workspaces, commits, jobs, open_branches: source.open_branches.map((branch) => ({ workspace: branch.workspace, name: branch.name, ahead: branch.ahead, behind: branch.behind, overlap: branch.overlap ?? [], ticket: branch.ticket })) };
  });
  const apps: Record<string, string[]> = {};
  for (const workspace of workspaces) {
    (apps[workspace.app] ??= []).push(workspace.name);
  }
  return { input: { language, period, daily_days: days, apps, workspaces: repos, daily }, cut };
}
