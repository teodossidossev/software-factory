// A quick fix (sf quickfix): one Implementer turn on a job waiting for the user (ready for human
// review or handed over), then MR preparation as after a clean round, without a review round,
// while its change since the hand-over stays small and away from sensitive paths; otherwise the job
// falls back to the full loop. This module holds the record on the job (job.json's quick_fix), its
// event, the read of the change since the hand-over (readDelta) and the pure decision
// (quickFixDecision); src/execution/quick-fix-step.ts applies it.
import * as z from 'zod/v4';
import { FactoryError } from './errors.js';
import { pathRiskReasons } from './gate-level.js';
import { runGit } from './git.js';
import type { FileChange, IterationMeta, Job } from './jobs.js';

// The states a quick fix starts from: the job returns to the same one.
export const QUICK_FIX_STATES = ['ready_for_human_review', 'handed_over'] as const;
export type QuickFixFrom = (typeof QUICK_FIX_STATES)[number];

// A Git object id (SHA-1 or SHA-256), as Git prints it.
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

// job.json's quick_fix, while a quick fix runs: the state it came from, the tree of the change as the
// user had it (the hand-over's saved commit, or the prepared commit) that the change is measured
// against, and the marked paths of the iteration before it (sensitive or outside the scope), which
// MR preparation's check accepted then and takes as accepted again. Strictly parsed.
export const quickFixSchema = z.strictObject({
  from: z.enum(QUICK_FIX_STATES),
  tree: z.string().regex(OBJECT_ID),
  accepted: z.array(z.string()),
});
export type QuickFix = z.output<typeof quickFixSchema>;

// The quick fix's event: asked (with the state it came from), quick (the change's counts: no review,
// on to MR preparation) or full (its reasons: the round runs as for any iteration).
export interface QuickFixEvent {
  type: 'quick_fix';
  action: 'asked' | 'quick' | 'full';
  from?: QuickFixFrom;
  files?: number;
  lines?: number;
  reasons?: string[];
}

// One path of the change since the hand-over: its added and deleted lines (0 for a binary or a
// submodule entry), whether Git reads it as binary, whether either side is a submodule.
export interface DeltaEntry {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
  submodule: boolean;
}

// The bound of git diff's output for the change; a change whose list is longer is unknown.
const MAX_DELTA_BYTES = 1024 * 1024;

// The change from the tree from to the tree to (git diff --numstat --no-renames, with --raw for the
// submodules), read in cwd. Throws when Git fails, its output does not fit MAX_DELTA_BYTES, or
// the two lists do not name the same paths; the message names no host path.
export async function readDelta(cwd: string, from: string, to: string): Promise<DeltaEntry[]> {
  const run = async (format: string): Promise<string[]> => {
    const result = await runGit(cwd, ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', format, '-z', from, to, '--'], MAX_DELTA_BYTES);
    if (result.code !== 0 || result.truncated) {
      throw new Error(result.truncated ? 'the change since the hand-over is too large to list' : `git diff ${format} failed (exit ${String(result.code)})`);
    }
    const fields = result.stdout.toString('utf8').split('\0');
    return fields.at(-1) === '' ? fields.slice(0, -1) : fields;
  };
  // --raw -z: ":<old mode> <new mode> <old id> <new id> <status>", then the path, for each entry.
  const modes = new Map<string, boolean>();
  const raw = await run('--raw');
  for (let index = 0; index < raw.length; index += 2) {
    const [oldMode, newMode] = raw[index]!.slice(1).split(' ');
    const path = raw[index + 1];
    if (!raw[index]!.startsWith(':') || path === undefined || path === '') {
      throw new Error('git diff --raw gave an entry that could not be read');
    }
    modes.set(path, oldMode === '160000' || newMode === '160000');
  }
  // --numstat -z: "<added>\t<deleted>\t<path>" for each entry, "-\t-\t<path>" for a binary one.
  const delta = (await run('--numstat')).map((record) => {
    const [added = '', deleted = '', ...rest] = record.split('\t');
    const path = rest.join('\t');
    const binary = added === '-' && deleted === '-';
    const counts = binary ? [0, 0] : [added, deleted].map((count) => (/^\d+$/.test(count) ? Number(count) : Number.NaN));
    const submodule = modes.get(path);
    if (submodule === undefined || counts.some((count) => !Number.isSafeInteger(count))) {
      throw new Error('git diff --numstat gave an entry that could not be read');
    }
    return { path, added: submodule ? 0 : counts[0]!, deleted: submodule ? 0 : counts[1]!, binary: binary && !submodule, submodule };
  });
  if (delta.length !== modes.size) {
    throw new Error('git diff --numstat and --raw listed different paths');
  }
  return delta;
}

// What quickFixDecision judges.
export interface QuickFixInput {
  // The change since the hand-over, or why it could not be read.
  delta: DeltaEntry[] | { error: string };
  // The new iteration's file list (meta.json files); undefined when it has none.
  files: readonly FileChange[] | undefined;
  // The Task's may_touch; undefined when the Task file could not be read.
  mayTouch: readonly string[] | undefined;
  // SF_GATE_FULL_PATHS, SF_SENSITIVE_PATHS.
  fullPaths: readonly string[];
  sensitivePaths: readonly string[];
  // SF_QUICK_FIX_MAX_LINES, SF_QUICK_FIX_MAX_FILES.
  maxLines: number;
  maxFiles: number;
}

// Whether the change since the hand-over goes without a review (quick), with its counts and the
// reasons it does not: over the bound (size), a binary or a submodule entry, a path the gate level's
// path rules name (pathRiskReasons, on the change's paths only), a path the new iteration marks
// outside the Task's scope (scope), or a change or a Task that cannot be read (unknown).
export function quickFixDecision(input: QuickFixInput): { quick: boolean; files: number; lines: number; reasons: string[] } {
  if (!Array.isArray(input.delta)) {
    return { quick: false, files: 0, lines: 0, reasons: [`unknown: ${input.delta.error}`] };
  }
  const delta = input.delta;
  const lines = delta.reduce((sum, entry) => sum + entry.added + entry.deleted, 0);
  const reasons: string[] = [];
  if (lines > input.maxLines) {
    reasons.push(`size: ${lines} lines`);
  }
  if (delta.length > input.maxFiles) {
    reasons.push(`size: ${delta.length} files`);
  }
  reasons.push(...delta.filter((entry) => entry.binary).map((entry) => `binary: ${entry.path}`));
  reasons.push(...delta.filter((entry) => entry.submodule).map((entry) => `submodule: ${entry.path}`));
  const paths = delta.map((entry) => entry.path);
  if (input.mayTouch === undefined) {
    reasons.push('unknown: the Task file\'s may_touch could not be read');
  }
  if (input.files === undefined) {
    reasons.push('unknown: the iteration has no file list');
  }
  reasons.push(...pathRiskReasons(paths, { mayTouch: input.mayTouch ?? [], fullPaths: input.fullPaths, sensitivePaths: input.sensitivePaths, files: input.files ?? [] }));
  const outside = new Set((input.files ?? []).filter((file) => file.scope === 'out').map((file) => file.path));
  reasons.push(...paths.filter((path) => outside.has(path)).map((path) => `scope: ${path}`));
  return { quick: reasons.length === 0, files: delta.length, lines, reasons };
}

const NO_BASELINE = 'The job has no prepared commit to measure a quick fix against. Use sf say.';

// The commit a quick fix of job is measured against: the hand-over's saved commit on handed_over,
// else the prepared commit. Refused (quick_fix_unavailable) when the job has none.
export function quickFixBaseline(job: Job): string {
  const commit = job.state === 'handed_over' ? job.handover?.saved : job.prepared_commit;
  if (commit == null) {
    throw new FactoryError('quick_fix_unavailable', NO_BASELINE);
  }
  return commit;
}

// The record of a quick fix asked on job, read in the workspace's checkout as the user has the
// job: the state it comes from, the tree of its baseline (quickFixBaseline), and the marked paths
// of meta, the last iteration's meta.json. Refused (quick_fix_unavailable) when the job has no
// baseline or its tree cannot be read.
export async function quickFixRecord(job: Job, checkout: string, meta: IterationMeta): Promise<QuickFix> {
  const from = job.state === 'handed_over' ? 'handed_over' : 'ready_for_human_review';
  const read = await runGit(checkout, ['rev-parse', '--verify', '--quiet', `${quickFixBaseline(job)}^{tree}`]);
  const tree = read.code === 0 ? read.stdout.toString('utf8').trim() : '';
  if (!OBJECT_ID.test(tree)) {
    throw new FactoryError('quick_fix_unavailable', NO_BASELINE);
  }
  return { from, tree, accepted: markedPaths(meta.files ?? []) };
}

// The job without its quick fix record.
export function withoutQuickFix<T extends { quick_fix?: QuickFix }>(job: T): T {
  const copy = { ...job };
  delete copy.quick_fix;
  return copy;
}

// The paths of an iteration's file list with a mark (sensitive, or outside the Task's scope).
export function markedPaths(files: readonly FileChange[]): string[] {
  return files.filter((file) => file.sensitive !== 'no' || file.scope === 'out').map((file) => file.path);
}
