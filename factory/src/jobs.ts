// Job state on disk: <state dir>/jobs/<workspace>/<ticket>/ with job.json, events.jsonl and
// iterations/NNN/{report.md,patch.diff,meta.json}, and in MR preparation mr-snapshot.json and mr.md. Strictly parsed; every file but the event log
// is replaced atomically. Knows nothing about Git or the Implementer session.
import { appendFile, mkdir, readdir, readFile, rename } from 'node:fs/promises';
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
  // The target commit the branch was rebased onto in MR preparation.
  target_commit: commit.nullable().default(null),
  // Number of MR preparation turns started.
  mr_attempts: z.number().int().min(0).default(0),
  state: z.enum(JOB_STATES),
  // Number of published iterations.
  iteration: z.number().int().min(0),
  session_id: z.string().min(1).nullable(),
  created_at: timestamp,
  // Time of the last state change.
  updated_at: timestamp,
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
});
export type Job = z.output<typeof jobSchema>;

// The reviewed change at approve (mr-snapshot.json): the commit of the reviewed working tree on top
// of base_commit (kept under refs/sf/snapshot/<ticket>), the target, and the reviewed paths.
export interface MrSnapshot {
  target_ref: string;
  target_commit: string;
  base_commit: string;
  snapshot_commit: string;
  paths: string[];
}

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

export interface IterationMeta {
  iteration: number;
  started_at: string;
  ended_at: string;
  // Tool names of denied tool calls, in order; never their inputs.
  denials: string[];
  changed_files: ChangedFile[];
  patch_truncated: boolean;
  submodule_changed: string[];
  // This iteration's cost, and the SDK's cumulative total for the session.
  cost_usd: number | null;
  cost_usd_total: number | null;
  duration_ms: number | null;
}

export interface Iteration {
  report: string;
  patch: Buffer;
  meta: IterationMeta;
}

// One line of events.jsonl: an SDK message, a prompt sent, a state change or a failed notification.
export type EventRecord = { ts: string; iteration: number } & (
  | { message: unknown }
  | { prompt: string }
  | { state: { from: JobState | null; to: JobState; error?: { code: string; message: string } } }
  | { type: 'notify_failed'; channel: string; message: string }
  // Sandbox placeholders the factory removed from the work checkout (src/placeholders.ts).
  | { type: 'placeholders_removed'; paths: string[] }
);

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

  // The MR text once it exists (copied at push or at a diff-check iteration).
  readMrText(workspace: string, ticket: string): Promise<string | undefined> {
    return readOrMissing(join(this.dir(workspace, ticket), 'mr.md'));
  }

  async writeMrText(workspace: string, ticket: string, text: string): Promise<void> {
    await writeFileAtomic(join(this.dir(workspace, ticket), 'mr.md'), Buffer.from(text, 'utf8'));
  }

  async readSnapshot(workspace: string, ticket: string): Promise<MrSnapshot | undefined> {
    const text = await readOrMissing(join(this.dir(workspace, ticket), 'mr-snapshot.json'));
    return text === undefined ? undefined : (JSON.parse(text) as MrSnapshot);
  }

  async writeSnapshot(workspace: string, ticket: string, snapshot: MrSnapshot): Promise<void> {
    await writeFileAtomic(join(this.dir(workspace, ticket), 'mr-snapshot.json'), Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`));
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

  // The recorded cost of the published iterations 1 to count: the sum of their cost_usd. Undefined
  // when a metadata file is missing or a cost is not a finite nonnegative number (null, absent, ...);
  // other read failures and malformed JSON throw. Later directories and cost_usd_total are ignored.
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
