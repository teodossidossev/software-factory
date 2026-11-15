// What the run queue needs to take a ticket by itself (RunQueue.addByItself, a workspace with
// auto_queue): the user's removals, <state>/queue-removed.json, a list of {workspace, ticket,
// sha256} with the sha256 of the Task file's text when the user took the ticket out of the queue,
// the place of a part of a ticket (part_of, slice) among the queued entries, and the look that
// decides whether a ticket joins (lookByItself).
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';
import { type Workspace, WORKSPACE_NAME_PATTERN } from './registry.js';
import { currentCheckSha256, taskSha256 } from './task-check.js';
import { checkNeed, parseFrontMatter, readTask, TICKET_PATTERN, type TicketRef, taskSlice } from './task-file.js';

export const QUEUE_REMOVED_FILE = 'queue-removed.json';

const removedSchema = z.array(z.strictObject({ workspace: z.string().regex(WORKSPACE_NAME_PATTERN), ticket: z.string().regex(TICKET_PATTERN), sha256: z.string().regex(/^[0-9a-f]{64}$/) }));
export type QueueRemoval = z.infer<typeof removedSchema>[number];

// Why addByItself left a ticket out: auto_queue_off (the workspace has no auto_queue), task_changed
// (the Task file is not the version the ready check read), removed_by_user (taken out of the queue
// since its Task file last changed), or the code add refuses with (already_queued, task_not_found,
// task_draft, job_exists, workspace_not_found, ...).
export type ByItself = { queued: true; position: number } | { queued: false; reason: string };

// Whether two references name the same ticket of the same workspace.
export const sameTicket = (a: TicketRef, b: TicketRef): boolean => a.workspace === b.workspace && a.ticket === b.ticket;

// <state>/queue-removed.json. Missing is none; one that cannot be read or is invalid counts as none
// too (logged), as the factory alone writes it.
export class RemovedStore {
  readonly path: string;

  // The store in the state directory, beside queue.json.
  constructor(stateDir: string) {
    this.path = join(stateDir, QUEUE_REMOVED_FILE);
  }

  // Every recorded removal, in the order recorded.
  async read(): Promise<QueueRemoval[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`warning: ${QUEUE_REMOVED_FILE} could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}); it counts as empty.`);
      }
      return [];
    }
    try {
      const parsed = removedSchema.safeParse(JSON.parse(text));
      if (parsed.success) {
        return parsed.data;
      }
    } catch { // not JSON: counts as empty, below
    }
    console.error(`warning: ${QUEUE_REMOVED_FILE} is invalid; it counts as empty.`);
    return [];
  }

  // Replaces the file with removed, atomically.
  async #write(removed: QueueRemoval[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.path, Buffer.from(`${JSON.stringify(removed, null, 2)}\n`));
  }

  // The user took the ticket out of the queue while its Task file's text had this sha256.
  async record(ref: TicketRef, sha256: string): Promise<void> {
    const others = (await this.read()).filter((item) => !sameTicket(item, ref));
    await this.#write([...others, { workspace: ref.workspace, ticket: ref.ticket, sha256 }]);
  }

  // The ticket's removals: whether one is of the text whose sha256 is kept; every other one goes
  // (all of them without kept).
  async forget(ref: TicketRef, kept?: string): Promise<boolean> {
    const removed = await this.read();
    const others = removed.filter((item) => !sameTicket(item, ref) || item.sha256 === kept);
    if (others.length !== removed.length) {
      await this.#write(others);
    }
    return kept !== undefined && others.some((item) => sameTicket(item, ref));
  }
}

// Where a Task of content goes among the queued entries (0-based): for a part of a ticket (part_of X,
// slice N), right after the last entry of the workspace whose Task is a part of X with a lower number,
// else at the first one with a higher number, else the end; any other Task at the end. A queued Task
// file that cannot be read counts as no part.
export async function partIndex(entries: TicketRef[], workspace: Workspace, content: string): Promise<number> {
  const own = taskSlice(parseFrontMatter(content) ?? new Map());
  if (own.part_of === undefined || own.slice === undefined) {
    return entries.length;
  }
  let lastLower: number | undefined;
  let firstHigher: number | undefined;
  for (const [index, entry] of entries.entries()) {
    if (entry.workspace !== workspace.name) {
      continue;
    }
    const other = await readTask(workspace, entry.ticket).then((text) => taskSlice(parseFrontMatter(text) ?? new Map()), () => undefined);
    if (other?.part_of !== own.part_of || other.slice === undefined) {
      continue;
    }
    if (other.slice.n < own.slice.n) {
      lastLower = index;
    } else if (other.slice.n > own.slice.n) {
      firstHigher ??= index;
    }
  }
  return lastLower !== undefined ? lastLower + 1 : (firstHigher ?? entries.length);
}

// What the look of addByItself needs of the run queue: the workspace of a ticket, add's refusals
// (admit throws them, else gives the Task file's text) and the user's removals.
export interface ByItselfDeps {
  resolve: (name: string) => Promise<Workspace>;
  admit: (resolved: Workspace) => Promise<string>;
  removed: RemovedStore;
}

// RunQueue.addByItself's look, under the queue's chain and the ticket's lock (see there): where ref
// goes among entries (partIndex) with the sha256 of its Task file's text, or why it is left out:
// auto_queue_off, a FactoryError's code (add's refusals), task_changed (not the version
// checkSha256 names; without it, a Task that now needs a check) or removed_by_user.
export async function lookByItself(deps: ByItselfDeps, entries: TicketRef[], ref: TicketRef, checkSha256: string | undefined): Promise<{ index: number; textSha256: string } | { reason: string }> {
  let resolved: Workspace;
  let content: string;
  try {
    resolved = await deps.resolve(ref.workspace);
    if (resolved.autoQueue !== true) {
      return { reason: 'auto_queue_off' };
    }
    content = await deps.admit(resolved);
  } catch (error) {
    if (error instanceof FactoryError) {
      return { reason: error.code };
    }
    throw error;
  }
  const changed = checkSha256 === undefined ? checkNeed(content, ref.workspace).needed : (await currentCheckSha256(resolved, ref.ticket, content)) !== checkSha256;
  if (changed) {
    return { reason: 'task_changed' };
  }
  const textSha256 = taskSha256(content);
  if (await deps.removed.forget(ref, textSha256)) {
    return { reason: 'removed_by_user' };
  }
  return { index: await partIndex(entries, resolved, content), textSha256 };
}
