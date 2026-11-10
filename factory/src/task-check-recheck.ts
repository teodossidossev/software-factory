// The re-checks of the automatic Task checks: a sweep every SWEEP_MS over the run queue's entries,
// a forced one left out. For a queued ticket whose current Task text has a stored check, none of it
// pending or running:
// - failed: a new automatic check (retry) once the record's ended_at is RETRY_AFTER_MS old, at most
//   MAX_RETRIES per Task sha256. A retry counts once it ran (its check stored a record), so one that
//   was dropped (a job started, the update marker) is triggered again at a later sweep; the count lives
//   in memory, so a restart of sf serve starts it again.
// - not_ready: a new automatic check (moved) when the tip of the Task's base, or of its continues
//   (resolveTarget on the work checkout, the commit a new check would read), is not the record's
//   commit and the paths changed in between match the Task's scope or may_touch (any path without
//   either). A commit Git no longer knows counts as moved, every path changed.
// - ready: never re-checked.
// The tip is resolved (fetched) at most once per workspace and base in a sweep, and only for a
// not_ready ticket; a fetch or Git error skips the workspace for the sweep and is logged once.
// The new check goes through AutoChecks' trigger, whose guards (a job that runs, a draft, checkNeed)
// all apply; its record replaces the old one (same sha256, same file).
import { taskStartBranch } from './continues.js';
import { FactoryError } from './errors.js';
import { runGit } from './git.js';
import { resolveTarget } from './mr.js';
import type { Workspace } from './registry.js';
import { matchesGlob } from './rules.js';
import { type CheckRecord, type CheckStore, currentCheckSha256, recordVerdict } from './task-check.js';
import { checkNeed, isDraft, mayTouch, parseFrontMatter, readTask, taskScope } from './task-file.js';

// How often the sweep looks at the queued tickets.
export const SWEEP_MS = 600_000;
// The time from a failed check's end to its retry.
export const RETRY_AFTER_MS = 15 * 60_000;
// The automatic retries of one version of a Task file (its check sha256).
export const MAX_RETRIES = 3;

// Why an automatic check runs on a Task text that already has a record: its failed check is tried
// again (retry), or its not_ready check is checked again after the base moved (moved).
export type Recheck = 'retry' | 'moved';

// Whether a record of this verdict may be replaced by a re-check of this kind.
export const recheckApplies = (recheck: Recheck | undefined, record: CheckRecord): boolean =>
  (recheck === 'retry' && recordVerdict(record) === 'failed') || (recheck === 'moved' && recordVerdict(record) === 'not_ready');

export interface QueuedTicket {
  workspace: string;
  ticket: string;
  force: boolean;
}

export interface RecheckOptions {
  // The run queue's entries.
  queued: () => Promise<QueuedTicket[]>;
  resolve: (name: string) => Promise<Workspace>;
  store: Pick<CheckStore, 'read'>;
  // Whether a check of the ticket is pending or runs: the sweep leaves it alone.
  busy: (workspace: string, ticket: string) => boolean;
  trigger: (workspace: string, ticket: string, recheck: Recheck) => void;
  now: () => number;
}

// One look at a queued ticket: its workspace, base (or continues), scope globs and current check record.
interface Look {
  workspace: Workspace;
  ticket: string;
  base: string;
  globs: string[];
  record: CheckRecord;
}

const retryKey = (record: Pick<CheckRecord, 'workspace' | 'ticket' | 'sha256'>): string => `${record.workspace}/${record.ticket}/${record.sha256}`;

// The commit hashes a record may hold; anything else counts as a commit Git does not know.
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// The paths changed from one commit to another, or undefined when Git does not know from.
async function changedPaths(checkout: string, from: string | null, to: string): Promise<string[] | undefined> {
  if (from === null || !COMMIT.test(from) || (await runGit(checkout, ['cat-file', '-e', `${from}^{commit}`])).code !== 0) {
    return undefined;
  }
  const diff = await runGit(checkout, ['diff', '--name-only', '--no-renames', '-z', from, to], 16 * 1024 * 1024);
  if (diff.code !== 0 || diff.truncated) {
    throw new FactoryError('git_failed', `git diff ${from.slice(0, 12)} ${to.slice(0, 12)} failed.`);
  }
  return diff.stdout.toString('utf8').split('\0').filter((path) => path !== '');
}

// Whether a change of these paths (undefined: every path) touches the Task: one of its scope or
// may_touch globs names one; without any glob, any changed path counts.
export function touchesScope(globs: readonly string[], changed: readonly string[] | undefined): boolean {
  if (changed === undefined) {
    return true;
  }
  if (globs.length === 0) {
    return changed.length > 0;
  }
  return changed.some((path) => globs.some((glob) => glob === path || matchesGlob(path, glob)));
}

// The retry counts and the sweep (see the top of this file).
export class Rechecks {
  readonly #options: RecheckOptions;
  // The automatic retries by workspace/ticket/sha256.
  readonly #retries = new Map<string, number>();

  constructor(options: RecheckOptions) {
    this.#options = options;
  }

  // A retry of this Task text ran and stored record.
  retried(record: CheckRecord): void {
    this.#retries.set(retryKey(record), (this.#retries.get(retryKey(record)) ?? 0) + 1);
  }

  // Whether a retry follows this failed automatic check: its ticket is queued, not forced, and
  // the retries of this Task text that ran are below MAX_RETRIES.
  async retryFollows(record: CheckRecord): Promise<boolean> {
    if ((this.#retries.get(retryKey(record)) ?? 0) >= MAX_RETRIES) {
      return false;
    }
    const queued = await this.#options.queued();
    return queued.some((entry) => entry.workspace === record.workspace && entry.ticket === record.ticket && !entry.force);
  }

  // One sweep over the queued tickets.
  async sweep(): Promise<void> {
    const tips = new Map<string, Promise<string>>();
    const skipped = new Set<string>();
    for (const entry of await this.#options.queued()) {
      if (entry.force || this.#options.busy(entry.workspace, entry.ticket)) {
        continue;
      }
      const look = await this.#look(entry.workspace, entry.ticket);
      if (look === undefined) {
        continue;
      }
      const verdict = recordVerdict(look.record);
      if (verdict === 'failed') {
        this.#retry(look.record);
      } else if (verdict === 'not_ready' && look.base !== '' && !look.base.startsWith('-') && !skipped.has(entry.workspace)) {
        const key = `${entry.workspace}\0${look.base}`;
        try {
          if (!tips.has(key)) {
            tips.set(key, resolveTarget(look.workspace.workCheckout, look.base).then((target) => target.commit));
          }
          const tip = await tips.get(key)!;
          if (tip !== look.record.commit && touchesScope(look.globs, await changedPaths(look.workspace.workCheckout, look.record.commit, tip))) {
            this.#options.trigger(entry.workspace, entry.ticket, 'moved');
          }
        } catch (error) {
          skipped.add(entry.workspace);
          console.error(`warning: the re-check of the not-ready Task checks of ${entry.workspace} skipped this sweep: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  // The ticket's Task file and the record of its current text; undefined when there is none, the
  // file is missing or a draft, or it needs no check.
  async #look(name: string, ticket: string): Promise<Look | undefined> {
    try {
      const workspace = await this.#options.resolve(name);
      const task = await readTask(workspace, ticket);
      if (isDraft(task) || !checkNeed(task, name).needed) {
        return undefined;
      }
      const record = await this.#options.store.read(name, ticket, await currentCheckSha256(workspace, ticket, task));
      const fields = parseFrontMatter(task) ?? new Map<string, string>();
      return record === undefined ? undefined : { workspace, ticket, base: taskStartBranch(fields), globs: [...(taskScope(fields) ?? []), ...mayTouch(fields)], record };
    } catch (error) {
      if (!(error instanceof FactoryError)) {
        console.error(error);
      }
      return undefined;
    }
  }

  // A failed record RETRY_AFTER_MS old, below MAX_RETRIES: one more retry.
  #retry(record: CheckRecord): void {
    if ((this.#retries.get(retryKey(record)) ?? 0) < MAX_RETRIES && this.#options.now() - Date.parse(record.ended_at) >= RETRY_AFTER_MS) {
      this.#options.trigger(record.workspace, record.ticket, 'retry');
    }
  }
}
