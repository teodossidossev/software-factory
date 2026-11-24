// A quick fix's decision (ReviewsPart's, first in its startReview for a job with quick_fix): the
// change from the tree the user had (quick_fix.tree) to the new iteration's commit_tree is read and
// judged (quickFixDecision, src/quick-fix.ts). Quick: the event, then MR preparation with the paths
// accepted before the quick fix, with no review, gate, gate level record, simplification pass or
// last review; the guard's scan, the test step, the MR text turn and the commit-tree check still
// run. Full: the event with its reasons, quick_fix removed, and the round runs as for any iteration.
import { type FileChange, type Job, now } from '../jobs.js';
import { type DeltaEntry, quickFixDecision, readDelta, withoutQuickFix } from '../quick-fix.js';
import type { JobStorePort, SettingsPort } from './ports.js';

// What QuickFixStep uses: ReviewsPart's ports, the Task's may_touch as the gate level reads it
// (undefined when it cannot be read), and MR preparation with the accepted paths (MrPart's
// prepareMr, reached late, its failure handed to the user as a verdict's is).
export interface QuickFixStepPorts {
  store: JobStorePort;
  settings: SettingsPort;
  mayTouch: (job: Job) => Promise<string[] | undefined>;
  prepare: (job: Job, accepted: string[]) => Promise<void>;
}

// The quick fix's decision of one iteration, owned by ReviewsPart.
export class QuickFixStep {
  readonly #ports: QuickFixStepPorts;

  constructor(ports: QuickFixStepPorts) {
    this.#ports = ports;
  }

  // The decision on the job's last iteration (a job awaiting review with quick_fix): undefined when
  // it was quick and MR preparation took the job on; else the job without quick_fix, as written,
  // for the review round. Only under the lock.
  async decide(job: Job): Promise<Job | undefined> {
    const { workspace, ticket, iteration } = job;
    const record = job.quick_fix!;
    const { config } = this.#ports.settings;
    let files: FileChange[] | undefined;
    let delta: DeltaEntry[] | { error: string };
    try {
      const meta = await this.#ports.store.jobs.readMeta(workspace, ticket, iteration);
      files = meta.files;
      if (meta.commit_tree === undefined || job.worktree === null) {
        throw new Error(meta.commit_tree === undefined ? `iteration ${iteration} has no commit tree` : 'the job has no worktree');
      }
      delta = await readDelta(job.worktree, record.tree, meta.commit_tree);
    } catch (error) {
      console.error(error);
      delta = { error: (error as Error).message.slice(0, 300) };
    }
    const decision = quickFixDecision({
      delta, files, mayTouch: await this.#ports.mayTouch(job), fullPaths: config.gateFullPaths, sensitivePaths: config.sensitivePaths,
      maxLines: config.quickFixMaxLines, maxFiles: config.quickFixMaxFiles,
    });
    if (decision.quick) {
      await this.#ports.store.jobs.appendEvent(workspace, ticket, { ts: now(), iteration, type: 'quick_fix', action: 'quick', files: decision.files, lines: decision.lines });
      await this.#ports.prepare(job, record.accepted);
      return undefined;
    }
    const full = withoutQuickFix(job);
    await this.#ports.store.jobs.write(full);
    await this.#ports.store.jobs.appendEvent(workspace, ticket, { ts: now(), iteration, type: 'quick_fix', action: 'full', reasons: decision.reasons });
    return full;
  }
}
