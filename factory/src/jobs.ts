// Job state on disk: <state dir>/jobs/<workspace>/<ticket>/ with job.json, events.jsonl and
// iterations/NNN/{report.md,patch.diff,meta.json,review.json,gate.json} (plus the gate's schema and
// output files), and from MR preparation on mr.md. Strictly parsed; every file but the event log
// is replaced atomically. Knows nothing about Git or the Implementer session.
import { appendFile, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';

export const JOB_STATES = [
  'starting',
  'working',
  'awaiting_review',
  'needs_human',
  'ready_for_human_review',
  'preparing_mr',
  'pushed',
  'aborted',
  'failed',
] as const;
export type JobState = (typeof JOB_STATES)[number];
// States that hold the machine's one job slot: every state in which the session may be alive.
export const ACTIVE_STATES: readonly JobState[] = ['starting', 'working', 'awaiting_review', 'needs_human', 'ready_for_human_review', 'preparing_mr'];
// States after which a new job for the same ticket may start.
export const TERMINAL_STATES: readonly JobState[] = ['failed', 'aborted', 'pushed'];

const timestamp = z.iso.datetime();
const commit = z.string().regex(/^[0-9a-f]{40,64}$/);
const jobSchema = z.strictObject({
  workspace: z.string().min(1),
  ticket: z.string().min(1),
  branch: z.string().min(1),
  base: z.string().min(1),
  // The commit the branch was created from; the Patch is the difference to it.
  base_commit: commit.nullable(),
  // The target commit of MR preparation: resolved at Clean, the commit the branch is rebased onto.
  target_commit: commit.nullable().default(null),
  // The job's worktree (SF-019), absolute; null before start, after Clean and once removed.
  worktree: z.string().min(1).nullable().default(null),
  // The branch tip the factory prepared at Clean; approve pushes it unless the tip moved.
  prepared_commit: commit.nullable().default(null),
  // Number of MR preparation turns started.
  mr_attempts: z.number().int().min(0).default(0),
  state: z.enum(JOB_STATES),
  // Number of published iterations.
  iteration: z.number().int().min(0),
  // Number of Fix sections written (by the reviewers' fix verdicts); SF_MAX_ITERATIONS limits it.
  fixes: z.number().int().min(0).default(0),
  // Fix verdicts of the gate (SF-039); SF_GATE_MAX_ROUNDS limits them.
  gate_fixes: z.number().int().min(0).default(0),
  // Input plus output tokens of every gate run of the job; SF_GATE_MAX_TOKENS limits them.
  gate_tokens: z.number().int().min(0).default(0),
  session_id: z.string().min(1).nullable(),
  created_at: timestamp,
  // Time of the last state change.
  updated_at: timestamp,
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
});
export type Job = z.output<typeof jobSchema>;

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

// One file of an iteration (SF-024): its status against the base, whether it is a sensitive
// path and whether the Task file declared it, and its line counts.
export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  from?: string;
  sensitive: 'declared' | 'undeclared' | 'no';
  additions: number;
  deletions: number;
}

export interface IterationMeta {
  iteration: number;
  started_at: string;
  ended_at: string;
  // Tool names of denied tool calls, in order; never their inputs.
  denials: string[];
  changed_files: ChangedFile[];
  // The structured file list (SF-024); absent in iterations published before it.
  files?: FileChange[];
  patch_truncated: boolean;
  submodule_changed: string[];
  // This iteration's cost, and the SDK's cumulative total for the session.
  cost_usd: number | null;
  cost_usd_total: number | null;
  duration_ms: number | null;
}

// iterations/NNN/review.json: the Claude review of the iteration (SF-038), or why it failed.
export type ReviewRecord =
  | {
      reviewer: string;
      verdict: 'clean' | 'fix';
      summary: string;
      items: Array<{ path: string; problem: string; expected: string }>;
      accepted_sensitive: string[];
      cost_usd: number | null;
      started_at: string;
      ended_at: string;
    }
  | { reviewer: string; error: string };

// The token usage of one gate run, from Codex's turn.completed events.
export interface GateTokens {
  input: number;
  cached_input: number;
  output: number;
}

// iterations/NNN/gate.json: the gate's review of the iteration (SF-039), or why it failed.
export type GateRecord =
  | {
      reviewer: string;
      verdict: 'clean' | 'fix';
      summary: string;
      items: Array<{ path: string; problem: string; expected: string }>;
      accepted_sensitive: string[];
      model?: string;
      tokens: GateTokens;
      started_at: string;
      ended_at: string;
    }
  | { reviewer: string; error: string; model?: string; tokens: GateTokens; started_at: string; ended_at: string };

export interface Iteration {
  report: string;
  patch: Buffer;
  meta: IterationMeta;
}

// One line of events.jsonl: an SDK message, a prompt sent, a state change, a failed notification,
// removed placeholders, or a review's outcome, Codex event or Claude message.
export type EventRecord = { ts: string; iteration: number } & (
  | { message: unknown }
  | { prompt: string }
  | { state: { from: JobState | null; to: JobState; error?: { code: string; message: string } } }
  | { type: 'notify_failed'; channel: string; message: string }
  // Sandbox placeholders the factory removed from the work checkout (src/placeholders.ts).
  | { type: 'placeholders_removed'; paths: string[] }
  // The outcome of a review (SF-038), Claude's or the gate's (SF-039, reviewer codex); ignored when
  // the job had moved on before it ended.
  | { type: 'review'; reviewer: string; verdict: 'clean' | 'fix'; items: number; ignored?: true }
  | { type: 'review_failed'; reviewer: string; error: string; ignored?: true }
  // The reviewers live (SF-045): one JSONL event of the Codex gate's stdout, one SDK message of the
  // Claude review session; truncated when cut to MAX_LIVE_EVENT_BYTES (cutEvent).
  | { type: 'gate_event'; reviewer: string; event: unknown; truncated?: true }
  | { type: 'review_message'; reviewer: string; message: unknown; truncated?: true }
);

// The bound of one reviewer event or message in events.jsonl (SF-045), in bytes of its JSON.
export const MAX_LIVE_EVENT_BYTES = 16 * 1024;

// A string cut to at most limit UTF-16 units and marked, without splitting a surrogate pair.
function cutString(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const code = text.charCodeAt(limit - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
  return `${text.slice(0, end)}…`;
}

// The value with every string cut to limit and every array to its first limit entries.
function shrink(value: unknown, limit: number): unknown {
  if (typeof value === 'string') {
    return cutString(value, limit);
  }
  if (Array.isArray(value)) {
    return value.slice(0, limit).map((entry) => shrink(entry, limit));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shrink(entry, limit)]));
  }
  return value;
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null');

// An event (a parsed Codex event, an SDK message) within MAX_LIVE_EVENT_BYTES of JSON: as it is
// when it fits, else with its strings and arrays cut ever shorter until it fits, at the last its
// type alone.
export function cutEvent(value: unknown): { value: unknown; truncated: boolean } {
  if (jsonBytes(value) <= MAX_LIVE_EVENT_BYTES) {
    return { value, truncated: false };
  }
  for (const limit of [4096, 1024, 256, 64, 16]) {
    const cut = shrink(value, limit);
    if (jsonBytes(cut) <= MAX_LIVE_EVENT_BYTES) {
      return { value: cut, truncated: true };
    }
  }
  const type = (value as { type?: unknown } | null)?.type;
  return { value: typeof type === 'string' ? { type: cutString(type, 64) } : null, truncated: true };
}

export function isActive(job: Job): boolean {
  return ACTIVE_STATES.includes(job.state);
}

export function now(): string {
  return new Date().toISOString();
}

async function readOrMissing(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export class JobStore {
  readonly root: string;

  // stateDir: the factory state directory; jobs live in its jobs/ subdirectory.
  constructor(stateDir: string) {
    this.root = join(stateDir, 'jobs');
  }

  // workspace and ticket are validated names (registry and Task file patterns), never paths.
  dir(workspace: string, ticket: string): string {
    return join(this.root, workspace, ticket);
  }

  eventsPath(workspace: string, ticket: string): string {
    return join(this.dir(workspace, ticket), 'events.jsonl');
  }

  async read(workspace: string, ticket: string): Promise<Job | undefined> {
    const text = await readOrMissing(join(this.dir(workspace, ticket), 'job.json'));
    if (text === undefined) {
      return undefined;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new FactoryError('job_invalid', `job.json of ${workspace}/${ticket} is not valid JSON.`);
    }
    const parsed = jobSchema.safeParse(data);
    if (!parsed.success || parsed.data.workspace !== workspace || parsed.data.ticket !== ticket) {
      throw new FactoryError('job_invalid', `job.json of ${workspace}/${ticket} is invalid.`);
    }
    return parsed.data;
  }

  async write(job: Job): Promise<void> {
    const dir = this.dir(job.workspace, job.ticket);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(dir, 'job.json'), Buffer.from(`${JSON.stringify(jobSchema.parse(job), null, 2)}\n`));
  }

  // Every current job (archived ones excluded), sorted by workspace and ticket.
  async list(): Promise<Job[]> {
    const jobs: Job[] = [];
    for (const workspace of await this.#entries(this.root)) {
      for (const ticket of await this.#entries(join(this.root, workspace))) {
        // Archived directories are named <ticket>.<timestamp>; their job.json names another ticket.
        const text = await readOrMissing(join(this.root, workspace, ticket, 'job.json'));
        if (text === undefined) {
          continue;
        }
        let ticketInFile: unknown = ticket;
        try {
          ticketInFile = (JSON.parse(text) as { ticket?: unknown }).ticket;
        } catch {
          // read() below reports the invalid file.
        }
        if (ticketInFile === ticket) {
          const job = await this.read(workspace, ticket);
          if (job !== undefined) {
            jobs.push(job);
          }
        }
      }
    }
    return jobs.sort((a, b) => `${a.workspace}/${a.ticket}`.localeCompare(`${b.workspace}/${b.ticket}`));
  }

  // Moves the job directory to <ticket>.<timestamp> next to it and returns that name.
  async archive(workspace: string, ticket: string): Promise<string> {
    const stamp = now().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const name = `${ticket}.${stamp}`;
    await rename(this.dir(workspace, ticket), join(this.root, workspace, name));
    return name;
  }

  // The MR text once it exists (copied when the branch is ready, or at a conflict iteration).
  readMrText(workspace: string, ticket: string): Promise<string | undefined> {
    return readOrMissing(join(this.dir(workspace, ticket), 'mr.md'));
  }

  async writeMrText(workspace: string, ticket: string, text: string): Promise<void> {
    await writeFileAtomic(join(this.dir(workspace, ticket), 'mr.md'), Buffer.from(text, 'utf8'));
  }

  async appendEvent(workspace: string, ticket: string, record: EventRecord): Promise<void> {
    await appendFile(this.eventsPath(workspace, ticket), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  async writeIteration(workspace: string, ticket: string, iteration: Iteration): Promise<void> {
    const dir = join(this.dir(workspace, ticket), 'iterations', String(iteration.meta.iteration).padStart(3, '0'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(dir, 'patch.diff'), iteration.patch);
    await writeFileAtomic(join(dir, 'meta.json'), Buffer.from(`${JSON.stringify(iteration.meta, null, 2)}\n`));
    // The report last: its presence marks the iteration as complete.
    await writeFileAtomic(join(dir, 'report.md'), Buffer.from(iteration.report, 'utf8'));
  }

  async readMeta(workspace: string, ticket: string, number: number): Promise<IterationMeta> {
    const dir = join(this.dir(workspace, ticket), 'iterations', String(number).padStart(3, '0'));
    return JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as IterationMeta;
  }

  // The directory of one published iteration.
  iterationDir(workspace: string, ticket: string, number: number): string {
    return join(this.dir(workspace, ticket), 'iterations', String(number).padStart(3, '0'));
  }

  async writeReview(workspace: string, ticket: string, number: number, review: ReviewRecord): Promise<void> {
    await writeFileAtomic(join(this.iterationDir(workspace, ticket, number), 'review.json'), Buffer.from(`${JSON.stringify(review, null, 2)}\n`));
  }

  // Before a retried review (SF-044): the failed record goes, so the iteration's review shows as running.
  async removeReview(workspace: string, ticket: string, number: number): Promise<void> {
    const dir = join(this.dir(workspace, ticket), 'iterations', String(number).padStart(3, '0'));
    await rm(join(dir, 'review.json'), { force: true });
  }

  // The review of an iteration; undefined while none ended (or with the review off).
  async readReview(workspace: string, ticket: string, number: number): Promise<ReviewRecord | undefined> {
    const text = await readOrMissing(join(this.iterationDir(workspace, ticket, number), 'review.json'));
    return text === undefined ? undefined : (JSON.parse(text) as ReviewRecord);
  }

  async writeGate(workspace: string, ticket: string, number: number, gate: GateRecord): Promise<void> {
    await writeFileAtomic(join(this.iterationDir(workspace, ticket, number), 'gate.json'), Buffer.from(`${JSON.stringify(gate, null, 2)}\n`));
  }

  // The gate's review of an iteration; undefined while none ended (or with the gate off).
  async readGate(workspace: string, ticket: string, number: number): Promise<GateRecord | undefined> {
    const text = await readOrMissing(join(this.iterationDir(workspace, ticket, number), 'gate.json'));
    return text === undefined ? undefined : (JSON.parse(text) as GateRecord);
  }

  // The recorded cost of the published iterations 1 to count: the sum of their cost_usd and of the
  // cost_usd of their reviews. Undefined when a metadata file is missing or a cost is not a finite
  // nonnegative number (null, absent, ...); an iteration without a review, or a failed review, adds
  // nothing. Other read failures and malformed JSON throw. Later directories and cost_usd_total are
  // ignored.
  async recordedCost(workspace: string, ticket: string, count: number): Promise<number | undefined> {
    let total = 0;
    for (let number = 1; number <= count; number += 1) {
      let meta: IterationMeta;
      try {
        meta = await this.readMeta(workspace, ticket, number);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
      const cost: unknown = meta.cost_usd;
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
        return undefined;
      }
      total += cost;
      const review = await this.readReview(workspace, ticket, number);
      if (review !== undefined && 'verdict' in review) {
        const reviewCost: unknown = review.cost_usd;
        if (typeof reviewCost !== 'number' || !Number.isFinite(reviewCost) || reviewCost < 0) {
          return undefined;
        }
        total += reviewCost;
      }
    }
    return total;
  }

  async readIteration(workspace: string, ticket: string, number: number): Promise<{ report: string; patch: Buffer }> {
    const dir = join(this.dir(workspace, ticket), 'iterations', String(number).padStart(3, '0'));
    return { report: await readFile(join(dir, 'report.md'), 'utf8'), patch: await readFile(join(dir, 'patch.diff')) };
  }

  async #entries(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}
