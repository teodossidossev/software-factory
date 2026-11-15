// The run queue's file: <state>/queue.json, its format (queueSchema) and QueueStore, which reads and
// writes it. RunQueue (src/queue.ts) changes it and re-exports what is here.
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import { WORKSPACE_NAME_PATTERN } from './registry.js';
import { TICKET_PATTERN } from './task-file.js';

export const QUEUE_FILE = 'queue.json';
export const MIN_RUNNING = 1;
export const MAX_RUNNING = 20;

// What the queue does when a usage limit resets.
export const ON_LIMIT_RULES = ['resume-then-queue', 'resume-only', 'wait'] as const;
export type OnLimitRule = (typeof ON_LIMIT_RULES)[number];
export const DEFAULT_ON_LIMIT: OnLimitRule = 'resume-then-queue';

const timestamp = z.iso.datetime();
const workspaceName = z.string().regex(WORKSPACE_NAME_PATTERN);
const ticketKey = z.string().regex(TICKET_PATTERN);
const queueSchema = z.strictObject({
  version: z.literal(1),
  max_running: z.number().int().min(MIN_RUNNING).max(MAX_RUNNING),
  held: z.boolean(),
  hold_reason: z.string().nullable(),
  // The rule at a usage limit's reset; absent in a queue.json written without it: the default.
  on_limit: z.enum(ON_LIMIT_RULES).default(DEFAULT_ON_LIMIT),
  // force: Start anyway, whatever the plan check says; until the entry leaves the queue.
  // retry_at, retries: a start that could not fetch (RETRY_CODE) is tried again at retry_at, the
  // failures so far in retries; both absent before the first. State format 5 (src/state-version.ts).
  entries: z.array(z.strictObject({
    workspace: workspaceName, ticket: ticketKey, queued_at: timestamp, force: z.literal(true).optional(),
    retry_at: timestamp.optional(), retries: z.number().int().min(1).optional(),
  })),
  // The scheduler's start that failed, per ticket (out of the queue): shown on its card.
  errors: z.array(z.strictObject({ workspace: workspaceName, ticket: ticketKey, code: z.string(), message: z.string(), at: timestamp })),
  // When the scheduler last started a queued ticket (the health check queue reads it);
  // absent before the first start. State format 3 (src/state-version.ts).
  last_start: timestamp.optional(),
});
export type QueueFile = z.infer<typeof queueSchema>;
export type QueueEntry = QueueFile['entries'][number];
export type QueueError = QueueFile['errors'][number];

// <state>/queue.json. A missing file reads as an empty queue whose limit is the default
// (SF_MAX_JOBS, within 1-20); an unreadable or invalid one is an error (queue_invalid), which
// sf serve reports at its start.
export class QueueStore {
  readonly path: string;
  readonly #defaultLimit: number;

  constructor(stateDir: string, defaultLimit: number) {
    this.path = join(stateDir, QUEUE_FILE);
    this.#defaultLimit = Math.min(MAX_RUNNING, Math.max(MIN_RUNNING, defaultLimit));
  }

  async read(): Promise<QueueFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, max_running: this.#defaultLimit, held: false, hold_reason: null, on_limit: DEFAULT_ON_LIMIT, entries: [], errors: [] };
      }
      throw new FactoryError('queue_invalid', `${QUEUE_FILE} could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch { // not JSON: reported as queue_invalid
      throw new FactoryError('queue_invalid', `${QUEUE_FILE} is not valid JSON.`);
    }
    const parsed = queueSchema.safeParse(data);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
      throw new FactoryError('queue_invalid', `${QUEUE_FILE} is invalid: ${issues.join('; ')}.`);
    }
    return parsed.data;
  }

  async write(queue: QueueFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.path, Buffer.from(`${JSON.stringify(queue, null, 2)}\n`));
  }
}
