// Job state on disk: <state dir>/jobs/<workspace>/<ticket>/ with job.json, events.jsonl and
// iterations/NNN/{report.md,patch.diff,meta.json,review.json,gate.json,gate-override.json,simplify.json} (plus the
// gate's schema and output files, and tree, SF-079), ledger.json (the findings ledger, SF-052) from
// the first Fix section on, task.md (the Task file as the Implementer was last given it, SF-067),
// from MR preparation on mr.md, and objects/ (SF-079). Strictly parsed; every file but the event
// log is replaced atomically. Knows nothing about the Implementer session, nor about Git: tree and
// objects/ are only named here, src/changes.ts writes them.
import { appendFile, type FileHandle, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic, writeFileAtomicWith } from './atomic.js';
import { FactoryError } from './errors.js';
import { type LedgerEntry, ledgerSchema } from './ledger.js';
import type { ReviewItem } from './review.js';
import type { Suggestion } from './simplify.js';

export const JOB_STATES = [
  'starting',
  'working',
  'awaiting_review',
  'needs_human',
  // The user paused the job (SF-067): nothing runs; sf resume goes on where it stopped.
  'paused',
  'ready_for_human_review',
  // The job's changes are in the workspace's checkout on its branch (SF-073): the user reviews them
  // there; nothing of the job runs.
  'handed_over',
  'preparing_mr',
  'pushed',
  'aborted',
  'failed',
] as const;
export type JobState = (typeof JOB_STATES)[number];
// States that hold the machine's one job slot: every state in which the session may be alive.
// paused is not one (SF-067): nothing of a paused job runs, and it does not count toward SF_MAX_JOBS;
// nor is handed_over (SF-073): the job's changes wait in the user's checkout.
export const ACTIVE_STATES: readonly JobState[] = ['starting', 'working', 'awaiting_review', 'needs_human', 'ready_for_human_review', 'preparing_mr'];
// States after which a new job for the same ticket may start.
export const TERMINAL_STATES: readonly JobState[] = ['failed', 'aborted', 'pushed'];
// The states sf pause takes (SF-067), and what was interrupted when the job was paused: the
// Implementer's turn, or a round of the Claude review, the gate or the simplification pass (none
// when nothing ran, as while awaiting review with the review off).
export const PAUSABLE_STATES = ['working', 'awaiting_review'] as const;
export const PAUSE_STEPS = ['turn', 'review', 'gate', 'simplify'] as const;
export type PauseStep = (typeof PAUSE_STEPS)[number];
// The states sf restart takes (SF-067): a job that waits for the user or has ended, not pushed.
export const RESTARTABLE_STATES: readonly JobState[] = ['paused', 'aborted', 'failed', 'needs_human'];

const timestamp = z.iso.datetime();
const commit = z.string().regex(/^[0-9a-f]{40,64}$/);

// The steps of a hand-over (SF-073) that change the checkout; recorded before the change, so
// recover() can repair one that was cut off.
export const HANDOVER_STEPS = ['handing_over', 'asking'] as const;
// A job in the user's checkout (SF-073): its branch, the job's commit S saved as
// refs/factory/<ticket>, the base B the branch was reset to, what the checkout was on before
// (a branch, or a detached commit), the user's untracked files from before (never touched), the
// local commit.template and commit.cleanup the factory replaced (null: unset), when it was handed
// over and when origin was last asked for the user's push; step while a change is in progress, and
// during Ask for changes the snapshot of the checkout (refs/factory/<ticket>-ask).
const handoverSchema = z.strictObject({
  branch: z.string().min(1),
  saved: commit,
  base: commit,
  previous: z.union([z.strictObject({ branch: z.string().min(1) }), z.strictObject({ commit })]),
  untracked: z.array(z.string()),
  template: z.string().nullable(),
  cleanup: z.string().nullable(),
  at: timestamp,
  checked_at: timestamp.nullable(),
  step: z.enum(HANDOVER_STEPS).nullable(),
  snapshot: commit.optional(),
});
export type Handover = z.output<typeof handoverSchema>;
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
  // The iteration the simplification pass started on (SF-055), written before it runs; absent before.
  // Once set, the pass never runs again on the job, whatever became of that run.
  simplify_iteration: z.number().int().min(1).optional(),
  session_id: z.string().min(1).nullable(),
  // The sha256 of the Task file the job works from (SF-067): recorded at Start, at every later copy
  // into the worktree and on a Resume that found the Task file changed; absent in a job started
  // before. task.md keeps the version the Implementer was last given, which can be older.
  task_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  // While paused (SF-067): the state the job was paused in, what was interrupted, and when.
  paused: z.strictObject({ from: z.enum(PAUSABLE_STATES), step: z.enum(PAUSE_STEPS).nullable(), at: timestamp }).optional(),
  // The continuations the factory sent by itself in the Implementer's current chain of turns, after
  // a turn limit (SF-069), and how many the chain may have; absent once a new chain starts.
  turn_limit: z.strictObject({ continued: z.number().int().min(1), allowed: z.number().int().min(0) }).optional(),
  created_at: timestamp,
  // Time of the last state change.
  updated_at: timestamp,
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
  // The job in the user's checkout (SF-073); absent otherwise.
  handover: handoverSchema.optional(),
  // Why the automatic hand-over did not happen at ready for review (SF-073); absent once the job
  // leaves ready_for_human_review or is handed over.
  handoff_skipped: z.strictObject({ code: z.string(), message: z.string() }).optional(),
  // The merge request the factory opened on the Git host (SF-048), from pushed on; null before.
  mr: z.strictObject({
    host: z.enum(['github', 'gitlab']),
    number: z.number().int().min(1),
    url: z.string().min(1),
    state: z.enum(['open', 'merged', 'closed']),
    // The merge commit once merged, when the host reports it.
    merge_commit: commit.nullable().optional(),
  }).nullable().default(null),
});
export type Job = z.output<typeof jobSchema>;
export type JobMr = NonNullable<Job['mr']>;

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

// One file of an iteration (SF-024): its status against the base, whether it is a sensitive
// path and whether the Task file declared it, whether it is in the Task's file scope (SF-053),
// and its line counts.
export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  from?: string;
  sensitive: 'declared' | 'undeclared' | 'no';
  // none when the Task declares no scope; a record written before SF-053 reads as none.
  scope: 'in' | 'out' | 'none';
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
  // The commit the iteration's Patch is against (SF-079); absent in iterations published before.
  base_commit?: string;
}

// iterations/NNN/review.json: the Claude review of the iteration (SF-038), or why it failed.
export type ReviewRecord =
  | {
      reviewer: string;
      verdict: 'clean' | 'fix';
      summary: string;
      items: ReviewItem[];
      accepted_sensitive: string[];
      // The items that reopened an accepted risk (SF-052): dropped, the user decided.
      dropped?: ReviewItem[];
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
      items: ReviewItem[];
      accepted_sensitive: string[];
      // The items that reopened an accepted risk (SF-052): dropped, the user decided.
      dropped?: ReviewItem[];
      model?: string;
      tokens: GateTokens;
      started_at: string;
      ended_at: string;
    }
  | { reviewer: string; error: string; model?: string; tokens: GateTokens; started_at: string; ended_at: string };

// iterations/NNN/gate-override.json (SF-047): the user accepted the iteration over a stopped gate
// (needs_human with code gate_rounds, gate_budget or gate_failed) with Claude's clean review; at
// is when, unapplied the Codex items of the iteration's gate.json the change goes without, or the
// gate's error when it failed ([] when no gate ran on the iteration). Over a ledger stop (SF-052:
// review_churn, review_disputed) unapplied are the ledger's open findings, each with its id.
export interface GateOverride {
  at: string;
  code: string;
  unapplied: Array<ReviewItem & { id?: string }> | string;
}

// iterations/NNN/simplify.json: the simplification pass after the deciding clean verdict of the
// iteration (SF-055), or why it failed (redacted). suggestions: what it offers the user; dropped:
// what the factory withheld because it names a fixed blocker entry of the ledger.
export type SimplifyRecord =
  | {
      reviewer: string;
      summary: string;
      suggestions: Suggestion[];
      dropped: Suggestion[];
      cost_usd: number | null;
      model: string | null;
      started_at: string;
      ended_at: string;
      // When the user skipped the suggestions (sf accept on simplify_offered); absent otherwise.
      skipped_at?: string;
    }
  | { reviewer: string; error: string; started_at: string; ended_at: string };

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
  // effective: the verdict the factory acted on when it is not the reviewer's (SF-051): clean for a
  // fix with nits only, fix for a clean that leaves an undeclared sensitive path unaccepted.
  | { type: 'review'; reviewer: string; verdict: 'clean' | 'fix'; items: number; effective?: 'clean' | 'fix'; ignored?: true }
  | { type: 'review_failed'; reviewer: string; error: string; ignored?: true }
  // The reviewers live (SF-045): one JSONL event of the Codex gate's stdout, one SDK message of the
  // Claude review session; truncated when cut to MAX_LIVE_EVENT_BYTES (cutEvent).
  | { type: 'gate_event'; reviewer: string; event: unknown; truncated?: true }
  | { type: 'review_message'; reviewer: string; message: unknown; truncated?: true }
  // The user accepted the iteration over the stopped gate (SF-047): the code it stopped with and
  // the number of Codex items not applied (0 when the gate failed or did not run).
  | { type: 'gate_overridden'; code: string; unapplied: number }
  // The simplification pass (SF-055): its outcome (the suggestions offered, those the factory
  // dropped, or its error), and the user's choice on the offer (simplify or skip).
  | { type: 'simplify'; reviewer: string; suggestions: number; dropped: number; error?: string; ignored?: true }
  | { type: 'simplify_chosen'; choice: 'simplify' | 'skip'; suggestions: number }
  // A step the user's Pause interrupted (SF-067): the turn, or a round of a reviewer, thrown away
  // and run again on Resume; never a verdict.
  | { type: 'interrupted'; step: PauseStep; reviewer?: string }
  // The Task file changed while the job was paused (SF-067): the sha256 the job had, and the new one.
  | { type: 'task_changed'; from: string | null; to: string }
  // An Implementer turn ended at the turn limit while making progress, and the factory sent a
  // continuation (SF-069): its number in the chain, the chain's allowance, the turn's maxTurns, the
  // worktree's changed paths and the turn's tool calls.
  | { type: 'turn_limit_continued'; continued: number; allowed: number; max_turns: number; changed_paths: number; tool_calls: number }
  // The merge request on the Git host (SF-048): opened, reused (already open for the branch),
  // merged by the factory, or found merged or closed on the host by sf mr status.
  // mr_state, not state: a record with state is a state change.
  | { type: 'merge_request'; action: 'created' | 'reused' | 'merged' | 'updated'; host: JobMr['host']; number: number; url: string; mr_state: JobMr['state']; merge_commit?: string }
  // The hand-over to the user's checkout (SF-073): done, ended (by Ask for changes, Take it back, the
  // push or abort, with the record as it was), or a note (a worktree that could not be removed, the
  // files Ask for changes left in the checkout because they changed).
  | { type: 'handover'; action: 'handed_over' | 'ended' | 'note'; handover?: Handover; note?: string }
  // The user's own push of a handed-over branch, found on origin (SF-073): the commit, and whether
  // its tree is the job's commit's (null when the commit is not known locally).
  | { type: 'handover_pushed'; commit: string; same_tree: boolean | null }
  // The factory removed the config lock Claude Code's sandbox left in the workspace checkout's Git
  // directory (SF-085, src/sandbox-lock.ts): its path.
  | { type: 'sandbox_lock_removed'; path: string }
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

// Items stored before SF-051 have no severity: they read as major.
function majorUnlessSet(items: ReviewItem[]): ReviewItem[] {
  return items.map((item) => (item.severity === undefined ? { ...item, severity: 'major' } : item));
}

// A review or gate record with every item's severity set.
function withSeverity<T extends ReviewRecord | GateRecord>(record: T): T {
  return 'items' in record && Array.isArray(record.items) ? { ...record, items: majorUnlessSet(record.items) } : record;
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

  // The workspaces that have a job directory, current or archived, sorted.
  workspaceNames(): Promise<string[]> {
    return this.#entries(this.root);
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

  // The Task file as the Implementer was last given it (SF-067); undefined in a job started before.
  readTaskCopy(workspace: string, ticket: string): Promise<string | undefined> {
    return readOrMissing(join(this.dir(workspace, ticket), 'task.md'));
  }

  // Replaced atomically, by #syncTask of the Execution only.
  async writeTaskCopy(workspace: string, ticket: string, content: Buffer): Promise<void> {
    await writeFileAtomic(join(this.dir(workspace, ticket), 'task.md'), content);
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
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as IterationMeta;
    // A file list written before SF-053 has no scope: none.
    return meta.files === undefined ? meta : { ...meta, files: meta.files.map((change) => ({ ...change, scope: change.scope ?? 'none' })) };
  }

  // The directory of one published iteration.
  iterationDir(workspace: string, ticket: string, number: number): string {
    return join(this.dir(workspace, ticket), 'iterations', String(number).padStart(3, '0'));
  }

  // iterations/NNN/tree (SF-079): the tree id of the job's files after the iteration, derived by
  // src/changes.ts from the iteration's base and Patch.
  treePath(workspace: string, ticket: string, number: number): string {
    return join(this.iterationDir(workspace, ticket, number), 'tree');
  }

  // The job's own Git object directory (SF-079): the objects of the iteration trees, with the
  // workspace's objects as alternates; nothing is written into the workspace's repository.
  objectsDir(workspace: string, ticket: string): string {
    return join(this.dir(workspace, ticket), 'objects');
  }

  // The resolution of a conflict turn whose rebase could not continue (SF-056), kept with the
  // iteration being rebased, its content written by write; returns the file's path.
  async writeConflictResolution(workspace: string, ticket: string, number: number, write: (handle: FileHandle) => Promise<void>): Promise<string> {
    const path = join(this.iterationDir(workspace, ticket, number), 'conflict-resolution.diff');
    await writeFileAtomicWith(path, write);
    return path;
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
    return text === undefined ? undefined : withSeverity(JSON.parse(text) as ReviewRecord);
  }

  async writeGate(workspace: string, ticket: string, number: number, gate: GateRecord): Promise<void> {
    await writeFileAtomic(join(this.iterationDir(workspace, ticket, number), 'gate.json'), Buffer.from(`${JSON.stringify(gate, null, 2)}\n`));
  }

  // Before the stopped gate runs again (SF-052, after the user settled a dispute).
  async removeGate(workspace: string, ticket: string, number: number): Promise<void> {
    await rm(join(this.iterationDir(workspace, ticket, number), 'gate.json'), { force: true });
  }

  // The findings ledger (SF-052); [] before the first Fix section. Strictly parsed.
  async readLedger(workspace: string, ticket: string): Promise<LedgerEntry[]> {
    const text = await readOrMissing(join(this.dir(workspace, ticket), 'ledger.json'));
    if (text === undefined) {
      return [];
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new FactoryError('ledger_invalid', `ledger.json of ${workspace}/${ticket} is not valid JSON.`);
    }
    const parsed = ledgerSchema.safeParse(data);
    if (!parsed.success) {
      throw new FactoryError('ledger_invalid', `ledger.json of ${workspace}/${ticket} is invalid.`);
    }
    return parsed.data;
  }

  // Replaced atomically; only under the job lock of the Execution.
  async writeLedger(workspace: string, ticket: string, ledger: LedgerEntry[]): Promise<void> {
    await writeFileAtomic(join(this.dir(workspace, ticket), 'ledger.json'), Buffer.from(`${JSON.stringify(ledgerSchema.parse(ledger), null, 2)}\n`));
  }

  // The outcome of the simplification pass on an iteration (SF-055), replaced atomically.
  async writeSimplify(workspace: string, ticket: string, number: number, record: SimplifyRecord): Promise<void> {
    await writeFileAtomic(join(this.iterationDir(workspace, ticket, number), 'simplify.json'), Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
  }

  // The simplification pass of an iteration (SF-055); undefined when none ended there.
  async readSimplify(workspace: string, ticket: string, number: number): Promise<SimplifyRecord | undefined> {
    const text = await readOrMissing(join(this.iterationDir(workspace, ticket, number), 'simplify.json'));
    return text === undefined ? undefined : (JSON.parse(text) as SimplifyRecord);
  }

  async writeGateOverride(workspace: string, ticket: string, number: number, override: GateOverride): Promise<void> {
    await writeFileAtomic(join(this.iterationDir(workspace, ticket, number), 'gate-override.json'), Buffer.from(`${JSON.stringify(override, null, 2)}\n`));
  }

  // The user's override of the gate on an iteration (SF-047); undefined when there is none.
  async readGateOverride(workspace: string, ticket: string, number: number): Promise<GateOverride | undefined> {
    const text = await readOrMissing(join(this.iterationDir(workspace, ticket, number), 'gate-override.json'));
    if (text === undefined) {
      return undefined;
    }
    const override = JSON.parse(text) as GateOverride;
    return Array.isArray(override.unapplied) ? { ...override, unapplied: majorUnlessSet(override.unapplied) } : override;
  }

  // The gate's review of an iteration; undefined while none ended (or with the gate off).
  async readGate(workspace: string, ticket: string, number: number): Promise<GateRecord | undefined> {
    const text = await readOrMissing(join(this.iterationDir(workspace, ticket, number), 'gate.json'));
    return text === undefined ? undefined : withSeverity(JSON.parse(text) as GateRecord);
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
