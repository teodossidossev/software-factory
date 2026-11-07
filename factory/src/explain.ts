// The plain explanation of each stop (SF-106). When sf serve sees a job in needs_human, one
// structured model session with no tools (as the morning digest's) reads the stop's data (the Task's
// goal, the stop's message, its ledger entries, the last Report, the user's own messages and the
// stop's real answers) and writes, in the user's language, a headline, a short explanation, the
// choices and a recommendation, stored in <job dir>/explanation.json for the stop it explains. It
// never acts: it writes no job file but its own, and the user still answers with the stop's own
// buttons and commands. A usage-limit stop explains itself and gets none.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { MAX_MODEL_INPUT_CHARS } from './digest.js';
import { digestSessionOptions } from './digest-run.js';
import { jobUserMessages } from './job-stream.js';
import type { Job, JobStore, ReviewRecord } from './jobs.js';
import { type LedgerEntry, unsettled } from './ledger.js';
import { explainPrompt } from './prompts.js';
import { configDir as defaultConfigDir, explainSettings, type ExplainSettings, loadRegistry } from './registry.js';
import { runStructuredSession, type StructuredOutcome } from './review.js';
import { parseFrontMatter } from './task-file.js';
import { usageLimit } from './usage-limit.js';

export const EXPLANATION_FILE = 'explanation.json';
// One model call's timeout; a failed call is tried once more.
export const EXPLAIN_TIMEOUT_MS = 120_000;
export const EXPLAIN_ATTEMPTS = 2;
// Explanations written at once; the others wait in a queue of at most one per job.
export const EXPLAIN_PARALLEL = 2;
export const MAX_HEADLINE_CHARS = 140;
export const MAX_EXPLANATION_WORDS = 120;

// ---------- The model's output ----------

const explainOutput = z.strictObject({
  headline: z.string().min(1).max(MAX_HEADLINE_CHARS).describe('One sentence: what is needed from the user.'),
  explanation: z.string().min(1).describe(`At most ${MAX_EXPLANATION_WORDS} words, short sentences: what the user would see, what was planned, what happened, why the job cannot decide alone.`),
  choices: z.array(z.strictObject({
    choice: z.string().min(1).describe('What the user can do, in plain words.'),
    effect: z.string().min(1).describe('What then happens.'),
    recommended: z.boolean().describe('True for exactly one choice.'),
  })).min(1).max(4),
  recommendation: z.string().min(1).describe('One sentence: which choice and why.'),
});
export type ExplainOutput = z.output<typeof explainOutput>;
const { $schema: _draft, ...explainSchema } = z.toJSONSchema(explainOutput, { target: 'draft-7' });
export const EXPLAIN_SCHEMA: Record<string, unknown> = explainSchema;

// Why an output the schema accepts is still a failed one (and is tried again), or null: the
// explanation has at most MAX_EXPLANATION_WORDS words (runs of non-space), and exactly one choice is
// recommended. JSON Schema cannot count words, so the schema only describes the limit.
export function outputProblem(output: ExplainOutput): string | null {
  const words = output.explanation.split(/\s+/u).filter((word) => word !== '').length;
  if (words > MAX_EXPLANATION_WORDS) {
    return `The explanation has ${words} words; at most ${MAX_EXPLANATION_WORDS} are allowed.`;
  }
  const recommended = output.choices.filter((choice) => choice.recommended).length;
  return recommended === 1 ? null : `The explanation recommends ${recommended} choices; exactly one must be recommended.`;
}

// ---------- The stop and its record ----------

// A stop's identity: the job's updated_at and its error code at the stop.
export interface StopId {
  at: string;
  code: string;
}

export function stopId(job: Job): StopId | null {
  return job.state === 'needs_human' ? { at: job.updated_at, code: job.error?.code ?? '' } : null;
}

export const sameStop = (a: StopId, b: StopId): boolean => a.at === b.at && a.code === b.code;
const stopKey = (stop: StopId): string => `${stop.at}\n${stop.code}`;
const jobKey = (job: Job): string => `${job.workspace}/${job.ticket}`;

// A usage-limit stop: session_failed with a message the usage limit's test recognises (it explains
// itself: the dashboard shows the reset and Tell it to go on).
export function usageLimitStop(job: Job, now: Date): boolean {
  return job.error?.code === 'session_failed' && usageLimit(job.error.message, now, 'claude') !== undefined;
}

const recordSchema = z.strictObject({
  stop: z.strictObject({ at: z.string(), code: z.string() }),
  model: z.string(),
  language: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  cost_usd: z.number().nullable(),
  output: explainOutput.nullable(),
  error: z.string().nullable(),
});
// pending: output, error and ended_at null (the page says "Explaining…").
export type ExplanationRecord = z.output<typeof recordSchema>;

export function explanationPath(jobs: JobStore, workspace: string, ticket: string): string {
  return join(jobs.dir(workspace, ticket), EXPLANATION_FILE);
}

// The job's explanation file, or undefined when it is missing or unreadable.
export async function readExplanation(jobs: JobStore, workspace: string, ticket: string): Promise<ExplanationRecord | undefined> {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(await readFile(explanationPath(jobs, workspace, ticket), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// The explanation of the job's current stop: the file while the job is in needs_human with the
// stop's updated_at and code; null otherwise (no file, an older stop's, no stop).
export async function currentExplanation(jobs: JobStore, job: Job): Promise<ExplanationRecord | null> {
  const stop = stopId(job);
  if (stop === null) {
    return null;
  }
  const record = await readExplanation(jobs, job.workspace, job.ticket);
  return record !== undefined && sameStop(record.stop, stop) ? record : null;
}

// ---------- The stop's answers (the stop panel's, static/app.js) ----------

// The codes that share an entry of the dashboard's STOPS (its STOP_ALIASES).
export const STOP_ALIASES: Readonly<Record<string, string>> = {
  mr_interrupted: 'mr_serve_restarted', turn_failed: 'session_failed', permission_mode_mismatch: 'session_failed',
  mr_text_invalid: 'mr_text_missing', mr_commit_failed: 'mr_failed', mr_rebase_failed: 'mr_failed',
};
const resolved = (code: string): string => (Object.hasOwn(STOP_ALIASES, code) ? STOP_ALIASES[code]! : code);
const GATE_CODES = ['gate_rounds', 'gate_budget', 'gate_failed'];
const LEDGER_CODES = ['review_churn', 'review_disputed'];
const ACCEPT_CODES = [...GATE_CODES, ...LEDGER_CODES, 'simplify_offered'];
const RETRY_STOPS = ['fetch_failed', 'mr_serve_restarted', 'mr_failed'];

// The ledger entries a ledger stop is about (the stop panel's, dashboard.ts stopOf): the unsettled
// ones (escalated, review_disputed), the open ones (review_churn); null for any other stop.
export function ledgerStopEntries(code: string, ledger: LedgerEntry[]): LedgerEntry[] | null {
  if (code === 'escalated' || code === 'review_disputed') {
    return unsettled(ledger);
  }
  return code === 'review_churn' ? ledger.filter((entry) => entry.status === 'open') : null;
}

// A Claude review the factory acts on as clean: a verdict without a blocker or major item, the
// items the ledger dropped aside (the dashboard's actedClean).
function actedClean(review: ReviewRecord | undefined): boolean {
  if (review === undefined || !('verdict' in review)) {
    return false;
  }
  const dropped = new Set((review.dropped ?? []).map((item) => JSON.stringify(item)));
  return review.items.every((item) => item.severity === 'nit' || dropped.has(JSON.stringify(item)));
}

// Accept and prepare the MR applies (the dashboard's gateAcceptable): a gate or ledger stop over a
// clean Claude review of the job's last iteration.
export function gateAcceptable(job: Job, review: ReviewRecord | undefined): boolean {
  return job.state === 'needs_human' && ACCEPT_CODES.includes(job.error?.code ?? '') && actedClean(review);
}

// Retry applies (the dashboard's retryable): a transient stop of MR preparation, never after a conflict turn.
export function retryable(job: Job): boolean {
  return job.state === 'needs_human' && job.error !== undefined && RETRY_STOPS.includes(resolved(job.error.code)) && job.mr_conflict_turn !== true;
}

export interface StopAnswer {
  label: string;
  command: string;
}

// What stopAnswers reads of the job: its ledger and the Claude review of its last iteration.
export interface StopFacts {
  ledger: LedgerEntry[];
  review: ReviewRecord | undefined;
}

// The stop's real answers, each a button label and its sf command: the actions the stop panel
// offers for the code (its stopActions, the conditional ones only when they apply now), Accept risk
// and Must fix for each entry to settle, and always Send a message and Abort.
export function stopAnswers(job: Job, facts: StopFacts, now = new Date()): StopAnswer[] {
  // A button label and its command: sf <verb> <workspace> <ticket> [args...].
  const answer = (label: string, verb: string, ...args: string[]): StopAnswer => ({ label, command: ['sf', verb, job.workspace, job.ticket, ...args].join(' ') });
  const goOn = answer('Tell it to go on', 'say', '"Go on."');
  const restart = answer('Restart', 'restart');
  const retry = answer('Retry', 'retry');
  const accept = gateAcceptable(job, facts.review) ? [answer('Accept and prepare MR', 'accept')] : [];
  const code = job.error?.code ?? '';
  let actions: StopAnswer[];
  if (usageLimitStop(job, now)) {
    actions = [goOn];
  } else {
    switch (resolved(code)) {
      case 'simplify_offered':
        actions = [answer('Simplify', 'simplify'), answer('Skip', 'accept')];
        break;
      case 'review_disputed':
      case 'review_churn':
      case 'gate_rounds':
      case 'gate_budget':
        actions = accept;
        break;
      case 'iteration_limit':
        actions = [restart];
        break;
      case 'gate_failed':
        actions = [...accept, goOn];
        break;
      case 'review_failed':
        actions = [answer('Retry review', 'review')];
        break;
      case 'serve_restarted':
      case 'session_failed':
        actions = [goOn, restart];
        break;
      case 'fetch_failed':
        actions = retryable(job) ? [retry] : [goOn];
        break;
      case 'mr_serve_restarted':
      case 'mr_failed':
        actions = retryable(job) ? [retry, goOn] : [goOn];
        break;
      case 'max_turns':
      case 'sandbox_unavailable':
      case 'publish_failed':
      case 'worktree_remove_failed':
        actions = [goOn];
        break;
      case 'mr_conflict':
        actions = [answer('Tell it how', 'say', '"<message>"')];
        break;
      case 'mr_push_failed':
        actions = [answer('Push again', 'approve')];
        break;
      default:
        actions = [];
    }
  }
  const settle = code === 'escalated' || code === 'review_disputed' ? (ledgerStopEntries(code, facts.ledger) ?? []).flatMap((entry) => [answer('Accept risk', 'settle', entry.id, 'accept'), answer('Must fix', 'settle', entry.id, 'fix')]) : [];
  return [...actions, ...settle, answer('Send a message', 'say', '"<message>"'), answer('Abort', 'abort')];
}

// ---------- The model's input ----------

export interface ExplainInput {
  task: { title: string; goal: string };
  stop: { code: string; message: string };
  entries: Array<{ id: string; severity: string; path: string; problem: string; expected: string; response: string; dispute: { reviewer: string; reason: string } | null }>;
  report: { done: string; open_questions: string };
  your_messages: Array<{ iteration: number; at: string | null; text: string }>;
  answers: StopAnswer[];
}

// The level-1 and level-2 sections of a Markdown text outside code fences, each with its heading line.
function sections(text: string): Array<{ heading: string; level: number; body: string }> {
  const found: Array<{ heading: string; level: number; lines: string[] }> = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('```')) {
      fenced = !fenced;
    }
    const heading = fenced ? null : /^(#{1,2}) (.*)$/.exec(line);
    if (heading !== null) {
      found.push({ heading: heading[2]!.trim(), level: heading[1]!.length, lines: [] });
    } else {
      found.at(-1)?.lines.push(line);
    }
  }
  return found.map(({ heading, level, lines }) => ({ heading, level, body: lines.join('\n').trim() }));
}

// The Task's title (its front matter's, else its first level-1 heading) and its goal: the first
// level-2 section whose heading starts with "Goal", else the first level-2 section.
export function taskGoal(task: string | undefined): { title: string; goal: string } {
  if (task === undefined) {
    return { title: '', goal: '' };
  }
  // The body after the front matter, its closing line found as parseFrontMatter finds it.
  const lines = task.split(/\r?\n/);
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  const all = sections(end < 0 ? task : lines.slice(end + 1).join('\n'));
  const title = parseFrontMatter(task)?.get('title') || (all.find((section) => section.level === 1)?.heading ?? '');
  const levelTwo = all.filter((section) => section.level === 2);
  const goal = levelTwo.find((section) => section.heading.startsWith('Goal')) ?? levelTwo[0];
  return { title, goal: goal === undefined ? '' : `## ${goal.heading}\n\n${goal.body}`.trim() };
}

// The Report's `## Done` and `## Open questions` sections, without their headings; "" when missing.
export function reportSections(report: string | undefined): { done: string; open_questions: string } {
  const all = sections(report ?? '').filter((section) => section.level === 2);
  const body = (name: string): string => all.find((section) => section.heading === name || section.heading.startsWith(`${name} `))?.body ?? '';
  return { done: body('Done'), open_questions: body('Open questions') };
}

// The user's own messages to the job in its last two iterations: the prompts the job's Stream shows
// as the user's (jobUserMessages), the factory's rules block already cut, oldest first.
export async function userMessages(jobs: JobStore, job: Job): Promise<ExplainInput['your_messages']> {
  const from = Math.max(1, job.iteration - 1);
  return (await jobUserMessages(jobs, job.workspace, job.ticket)).filter((m) => m.iteration >= from);
}

// The model's input for the job's stop, read now (the answers too).
export async function explainInput(jobs: JobStore, job: Job, now = new Date()): Promise<ExplainInput> {
  const ledger = await jobs.readLedger(job.workspace, job.ticket);
  const review = job.iteration >= 1 ? await jobs.readReview(job.workspace, job.ticket, job.iteration) : undefined;
  let report: string | undefined;
  if (job.iteration >= 1) {
    report = await jobs.readIteration(job.workspace, job.ticket, job.iteration).then(({ report: text }) => text, () => undefined);
  }
  const code = job.error?.code ?? '';
  return {
    task: taskGoal(await jobs.readTaskCopy(job.workspace, job.ticket)),
    stop: { code, message: job.error?.message ?? '' },
    entries: (ledgerStopEntries(code, ledger) ?? []).map((entry) => ({
      id: entry.id, severity: entry.severity, path: entry.path, problem: entry.problem, expected: entry.expected, response: entry.response,
      dispute: entry.dispute === null ? null : { reviewer: entry.dispute.reviewer, reason: entry.dispute.reason },
    })),
    report: reportSections(report),
    your_messages: await userMessages(jobs, job),
    answers: stopAnswers(job, { ledger, review }, now),
  };
}

// A text cut to at most limit characters, the last one "…", without splitting a surrogate pair.
function shorten(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  if (limit <= 1) {
    return '';
  }
  let end = limit - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

// The input within max characters of JSON, cut in this order: the user's messages (oldest first),
// the Report's sections (from the end), the entries' expected texts (from the last entry). The
// Task's title and goal, the stop's message, the entries' problems and responses and the answers
// are never cut: null when they alone exceed max. The input itself is not changed.
export function capExplainInput(input: ExplainInput, max: number): ExplainInput | null {
  const capped: ExplainInput = structuredClone(input);
  const size = (): number => JSON.stringify(capped).length;
  while (size() > max && capped.your_messages.length > 0) {
    capped.your_messages.shift();
  }
  // Each text shortened by the excess (its JSON is at least as long as the text), until it fits or is empty.
  const cut = (get: () => string, set: (text: string) => void): void => {
    while (size() > max && get() !== '') {
      set(shorten(get(), get().length - (size() - max) - 1));
    }
  };
  cut(() => capped.report.open_questions, (text) => { capped.report.open_questions = text; });
  cut(() => capped.report.done, (text) => { capped.report.done = text; });
  for (const entry of [...capped.entries].reverse()) {
    cut(() => entry.expected, (text) => { entry.expected = text; });
  }
  return size() > max ? null : capped;
}

// ---------- The explainer ----------

// The model call: one structured session; never throws.
export type ExplainModel = (prompt: string, options: { model: string; cwd: string; signal: AbortSignal }) => Promise<StructuredOutcome<ExplainOutput>>;

// The session of the explanation, as the digest's: no tools besides the SDK's structured output, no
// setting sources, an empty temporary directory as cwd.
export function sdkExplainModel(claudePath: string | undefined): ExplainModel {
  return (prompt, { model, cwd, signal }) => runStructuredSession(prompt, digestSessionOptions(cwd, model, claudePath, signal), {
    schema: EXPLAIN_SCHEMA, output: explainOutput, noun: 'explanation', outputNoun: 'explanation',
  });
}

export interface ExplainerOptions {
  jobs: JobStore;
  configDir?: string;
  claudePath?: string | undefined;
  // The model call; the Agent SDK by default (tests give a fake).
  model?: ExplainModel;
  now?: () => Date;
  timeoutMs?: number;
  parallel?: number;
  // The job's explanation file was written (pending, then final): the dashboard refreshes the job.
  onWritten?: (workspace: string, ticket: string) => void;
}

interface Queued {
  job: Job;
  stop: StopId;
  settings: ExplainSettings;
}

interface Running {
  key: string;
  stop: StopId;
  controller: AbortController;
}

export class Explainer {
  readonly #jobs: JobStore;
  readonly #configDir: string;
  readonly #model: ExplainModel;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #parallel: number;
  readonly #onWritten: ExplainerOptions['onWritten'];
  // The stop each job was last seen at, by "<workspace>/<ticket>".
  readonly #seen = new Map<string, string>();
  // At most one waiting explanation per job, in arrival order.
  readonly #queue = new Map<string, Queued>();
  readonly #running = new Set<Running>();
  readonly #tasks = new Set<Promise<unknown>>();
  // The last write of each job, which the next one waits for.
  readonly #writes = new Map<string, Promise<void>>();
  #closed = false;

  constructor(options: ExplainerOptions) {
    this.#jobs = options.jobs;
    this.#configDir = options.configDir ?? defaultConfigDir();
    this.#model = options.model ?? sdkExplainModel(options.claudePath);
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? EXPLAIN_TIMEOUT_MS;
    this.#parallel = options.parallel ?? EXPLAIN_PARALLEL;
    this.#onWritten = options.onWritten;
  }

  // sf serve's job follower: a job seen at a new stop gets an explanation; never throws.
  jobChanged(job: Job): void {
    this.#track(this.#consider(job));
  }

  // At sf serve's start: every job in needs_human without a finished explanation of its current stop
  // gets one (a pending file of that stop is written again; a stored error is not retried).
  async start(): Promise<void> {
    for (const job of await this.#jobs.list()) {
      if (job.state === 'needs_human') {
        await this.#consider(job);
      }
    }
  }

  // sf serve's stop: every running explanation is aborted, the queue emptied.
  close(): void {
    this.#closed = true;
    this.#queue.clear();
    for (const run of this.#running) {
      run.controller.abort();
    }
  }

  // Tests: resolves once nothing is being considered, queued or written.
  async idle(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks]);
    }
  }

  #track(task: Promise<unknown>): void {
    const tracked = task.catch((error: unknown) => console.error(error)).finally(() => this.#tasks.delete(tracked));
    this.#tasks.add(tracked);
  }

  // A newer stop of the job (or none): its waiting explanation leaves the queue, its running one is aborted.
  #cancel(key: string): void {
    this.#queue.delete(key);
    for (const run of this.#running) {
      if (run.key === key) {
        run.controller.abort();
      }
    }
  }

  async #consider(job: Job): Promise<void> {
    const key = jobKey(job);
    const stop = stopId(job);
    if (stop === null) {
      if (this.#seen.delete(key)) {
        this.#cancel(key);
      }
      return;
    }
    const id = stopKey(stop);
    if (this.#seen.get(key) === id) {
      return;
    }
    this.#seen.set(key, id);
    this.#cancel(key);
    const current = (): boolean => !this.#closed && this.#seen.get(key) === id;
    if (this.#closed || usageLimitStop(job, this.#now())) {
      return;
    }
    // Read at each stop, so a change applies without a restart.
    const settings = explainSettings(await loadRegistry(this.#configDir));
    if (!settings.on || !current()) {
      return;
    }
    const stored = await readExplanation(this.#jobs, job.workspace, job.ticket);
    if (!current() || (stored !== undefined && sameStop(stored.stop, stop) && stored.ended_at !== null)) {
      return;
    }
    this.#queue.set(key, { job, stop, settings });
    this.#pump();
  }

  #pump(): void {
    while (!this.#closed && this.#running.size < this.#parallel && this.#queue.size > 0) {
      const [key, queued] = this.#queue.entries().next().value!;
      this.#queue.delete(key);
      const run: Running = { key, stop: queued.stop, controller: new AbortController() };
      this.#running.add(run);
      this.#track(this.#explain(queued, run).finally(() => {
        this.#running.delete(run);
        this.#pump();
      }));
    }
  }

  // Whether the run still explains the job's current stop.
  #live(run: Running): boolean {
    return !this.#closed && !run.controller.signal.aborted && this.#seen.get(run.key) === stopKey(run.stop);
  }

  // Writes the record when allowed() still holds, the check and the write after every earlier one
  // of the job's: two runs of a job never interleave between a check and its write.
  #write(job: Job, record: ExplanationRecord, allowed: () => Promise<boolean>): Promise<void> {
    const key = jobKey(job);
    const step = (this.#writes.get(key) ?? Promise.resolve()).then(async () => {
      if (!(await allowed())) {
        return;
      }
      await writeFileAtomic(explanationPath(this.#jobs, job.workspace, job.ticket), Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
      try {
        this.#onWritten?.(job.workspace, job.ticket);
      } catch (error) {
        console.error(error);
      }
    });
    const settled = step.catch(() => undefined);
    this.#writes.set(key, settled);
    void settled.then(() => {
      if (this.#writes.get(key) === settled) {
        this.#writes.delete(key);
      }
    });
    return step;
  }

  async #explain({ job, stop, settings }: Queued, run: Running): Promise<void> {
    const pending: ExplanationRecord = {
      stop, model: settings.model, language: settings.language, started_at: this.#now().toISOString(), ended_at: null, cost_usd: null, output: null, error: null,
    };
    await this.#write(job, pending, async () => this.#live(run));
    if (!this.#live(run)) {
      return;
    }
    const result = await this.#call(job, settings, run).catch((error: unknown) => ({ output: null, cost: null, error: error instanceof Error ? error.message : String(error) }));
    // Compare before write: only over this stop's own file, never over a newer stop's.
    await this.#write(job, { ...pending, ended_at: this.#now().toISOString(), cost_usd: result.cost, output: result.output, error: result.error }, async () => {
      if (!this.#live(run)) {
        return false;
      }
      const stored = await readExplanation(this.#jobs, job.workspace, job.ticket);
      return stored !== undefined && sameStop(stored.stop, stop) && this.#live(run);
    });
  }

  // The input, capped, and the model call, tried once more on a failure.
  async #call(job: Job, settings: ExplainSettings, run: Running): Promise<{ output: ExplainOutput | null; cost: number | null; error: string | null }> {
    const input = await explainInput(this.#jobs, job, this.#now());
    // The prompt's own text counts against the cap too.
    const overhead = explainPrompt(settings.language, null).length - 'null'.length;
    const capped = capExplainInput(input, MAX_MODEL_INPUT_CHARS - overhead);
    if (capped === null) {
      return { output: null, cost: null, error: `The stop's data is longer than ${MAX_MODEL_INPUT_CHARS} characters even without the user's messages, the Report and the expected texts; no explanation was made.` };
    }
    const prompt = explainPrompt(settings.language, capped);
    let error = 'The explanation was not made.';
    for (let attempt = 1; attempt <= EXPLAIN_ATTEMPTS && !run.controller.signal.aborted; attempt += 1) {
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const cwd = await mkdtemp(join(tmpdir(), 'sf-explain-'));
      let outcome: StructuredOutcome<ExplainOutput>;
      try {
        outcome = await this.#model(prompt, { model: settings.model, cwd, signal: AbortSignal.any([run.controller.signal, timeout]) });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
      if (outcome.ok) {
        const problem = outputProblem(outcome.output);
        if (problem === null) {
          return { output: outcome.output, cost: outcome.costUsd, error: null };
        }
        error = problem;
      } else {
        error = timeout.aborted ? `The model call timed out after ${this.#timeoutMs / 1000} seconds.` : outcome.message;
      }
    }
    return { output: null, cost: null, error };
  }
}

// sf explain: the lines of the current stop's explanation, or the line that there is none (with
// why: still being written, failed, or no stop).
export function explanationLines(record: ExplanationRecord | null): string[] {
  if (record === null || record.output === null) {
    const why = record === null ? [] : record.error !== null ? [`The explanation failed: ${record.error}`] : ['It is being written.'];
    return ['No explanation for the current stop.', ...why];
  }
  const { headline, explanation, choices, recommendation } = record.output;
  return [
    headline, '', explanation, '', 'Choices:',
    ...choices.map((choice) => `- ${choice.choice}${choice.recommended ? ' (recommended)' : ''}: ${choice.effect}`),
    '', `Recommendation: ${recommendation}`, '', `Explained by ${record.model}${record.cost_usd !== null ? ` · $${record.cost_usd.toFixed(2)}` : ''}`,
  ];
}
