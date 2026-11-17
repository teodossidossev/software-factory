// What more than one part of the job lifecycle uses: the report's size bound, the branch name and
// file helpers, the gate's skip, and the runtime types of a job's session, of a running review, of
// Execution's options and of a Fix section's options (what the parts that write a Fix section
// pass). The data shapes are in ./dto.ts, the codes and refusals in ./errors.ts, the Implementer's
// text in ./prompts.ts and the tests event in ./events.ts.
import { stat } from 'node:fs/promises';
import type { GATE_REVIEWER } from '../gate.js';
import type { Job, JobStore } from '../jobs.js';
import type { LedgerEntry, SIMPLIFIER } from '../ledger.js';
import type { Workspace } from '../registry.js';
import type { REVIEWER } from '../review.js';
import type { Launch } from '../runner.js';
import type { ImplementerSession } from '../session.js';
import type { Retired } from './dto.js';
import type { TESTS_RUNNER } from './events.js';

export const MAX_REPORT_BYTES = 64 * 1024;

const MAX_SLUG = 40;

// Branch slug: the title lowercased, runs of other characters than a-z and 0-9 as "-", trimmed,
// at most 40 characters.
export function slugify(title: string): string {
  const trim = (value: string): string => value.replace(/^-+|-+$/g, '');
  return trim(trim(title.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, MAX_SLUG));
}

export function branchName(ticket: string, title: string): string {
  const slug = slugify(title);
  return slug === '' ? ticket : `${ticket}-${slug}`;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch { // stat fails: the path does not exist
    return false;
  }
}

// Whether the job's last iteration skipped the gate by its gate level: its gate-level.json
// says ran: false. Then the gate counts as absent, as with the gate off (the gate's status, the step
// a pause interrupts). A file that cannot be read counts as no decision.
export async function gateSkipped(jobs: JobStore, job: Job): Promise<boolean> {
  try {
    return (await jobs.readGateLevel(job.workspace, job.ticket, job.iteration))?.ran === false;
  } catch { // a file that cannot be read counts as no decision
    return false;
  }
}

export interface Live {
  workspace: Workspace;
  session: ImplementerSession;
  // The session's cwd: the job's worktree.
  cwd: string;
  // During MR preparation: the target's ref name, the files of a stopped rebase while the
  // conflict turn runs, and the MR text turns the guard asked for (absent: 0).
  mr?: { targetRef: string; conflicts?: string[]; guardTurns?: number };
}

// A review in progress, one at a time per job: a review round (src/round.ts: the Claude review and
// the gate of a joint round together, reviewer then Claude's, or the one of them that runs), the
// simplification pass, or the run of the workspace's test command (tests); the iteration it
// reviews and what cancels it (one controller for both sessions of a round).
export interface RunningReview {
  reviewer: typeof REVIEWER | typeof GATE_REVIEWER | typeof SIMPLIFIER | typeof TESTS_RUNNER;
  iteration: number;
  controller: AbortController;
}

export interface ExecutionOptions {
  // Runner mode (sf run): the one job this Execution runs. Without it the Execution is sf serve's,
  // which runs no turn and no review itself.
  runner?: { workspace: string; ticket: string };
  // How sf serve starts a runner; the default spawns `sf run`.
  launch?: Launch;
  // The /proc directory the sandbox's config lock check scans (LockScan.proc); the real
  // /proc without it. Only tests give another (TestHooks.procDir, src/test-hooks.ts).
  lockProc?: string;
  // The run queue's limit max_running, read at each start of the queue's own (sf serve reads it
  // from queue.json); without it, config.maxJobs.
  maxRunning?: () => Promise<number>;
  // sf serve: Setup's ticket archive (src/setup.ts archiveTicket), bound late as Setup is built after
  // the Execution: moves the ticket's active Task file to the archive and retires its finished job in
  // one lock acquisition; the retired job, if any. Without it the Archive retires the job alone.
  archiveTicket?: (workspace: string, ticket: string) => Promise<Retired | undefined>;
}

// The options of a Fix section (fix).
export interface FixOptions {
  // What else the Fix counts for (the gate's gate_fixes and gate_stalled).
  counts?: Partial<Pick<Job, 'gate_fixes' | 'gate_stalled'>>;
  ledger?: LedgerEntry[];
  fromStop?: boolean;
  title?: string;
  overLimit?: boolean;
  // The Fix of the user's Must fix on a resuming settle: written even at SF_MAX_ITERATIONS (the
  // limit stops the factory's own rounds), counted in fixes, recorded in the history as the user's.
  byUser?: boolean;
  // The Tests Fix, from preparing_mr: no checkFix, the transition's action is tests, written
  // even at SF_MAX_ITERATIONS, and fixes is not counted (TEST_FIX_ROUNDS bounds it).
  fromTests?: boolean;
}
