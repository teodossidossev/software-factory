// A delta round: a review round of an iteration published after a clean round. The clean round is
// the job's baseline (job.json's clean, set at the deciding clean verdict); every later iteration
// carries in meta.json its delta from the baseline's tree (built at publish, src/patch.ts; recorded
// as skipped when it can no longer be rebuilt for the review), and its round judges that delta,
// with the rest of the change accepted. This module holds the records
// (the clean baseline, the iteration's delta), the judged paths (the delta's and those whose mark
// changed since the baseline), the filter of the items outside the delta (an item's outside_delta),
// the gate decision of a delta round and the lines of its prompt. It is pure: it imports no value
// of a module that reaches jobs.ts; the Execution (src/execution/reviews.ts, turns.ts) reads the
// inputs and passes its reads in (DeltaReads).
import * as z from 'zod/v4';
import { changedLines, fullRulePaths, type GateDecision, gateDecision, type GateLevelInput, type PathRules } from './gate-level.js';
import type { UserMessage } from './job-stream.js';
import type { FileChange, GateRecord, IterationMeta, ReviewRecord } from './jobs.js';
import type { TreeChange } from './patch.js';
import type { ReviewItem } from './review.js';

// job.json's clean: the last deciding clean verdict of the job (the glossary's Clean), at
// iteration, at when it was applied, with the job's gate_fixes then. Set once per iteration (a job
// picked up again keeps it); an Accept over a stop sets none. Absent: no clean round yet.
export const cleanSchema = z.strictObject({
  iteration: z.number().int().min(1),
  at: z.iso.datetime(),
  gate_fixes: z.number().int().min(0),
});
export type CleanBaseline = z.output<typeof cleanSchema>;

// meta.json's delta, on an iteration published after a clean round (from, its iteration): the
// baseline's tree and the delta's files (git diff --no-renames from_tree to the iteration's
// commit_tree, limited to the paths of either iteration's file list; each path's marks as the
// iteration's file list gives them, or the baseline's for a path the delta took out of the change;
// the counts from the delta), or why it could not be built (skipped: the round reviews the whole
// change). Absent: the iteration was reviewed whole.
export type IterationDelta = { from: number; from_tree: string; files: FileChange[] } | { from: number; skipped: string };
export type BuiltDelta = Extract<IterationDelta, { files: FileChange[] }>;

// An item's reason to stand on code outside the delta (ReviewItem's outside_delta): none, the delta
// breaks that code (problem says which delta line, or what the delta requires there), or a user
// message after the clean round asks for it (problem cites it).
export const OUTSIDE_DELTA = ['', 'broken_by_delta', 'asked_by_user'] as const;
export const OUTSIDE_DELTA_DESCRIPTION = 'Only in a delta round, for an item on a file outside the delta: "broken_by_delta" (say in problem which delta line breaks it, or what the delta requires there) or "asked_by_user" (cite the user message after the clean round); otherwise "".';

// The marks of a path a delta round compares with the baseline's.
const markOf = (file: FileChange): string => `${file.sensitive} ${file.scope}`;

// The delta's files from the trees' changes: the marks of files (the new iteration's list), else
// of baseFiles (the baseline's), else none; the counts from changes.
export function deltaFiles(changes: readonly TreeChange[], files: readonly FileChange[], baseFiles: readonly FileChange[]): FileChange[] {
  return changes.map((change) => {
    const marked = files.find((file) => file.path === change.path) ?? baseFiles.find((file) => file.path === change.path);
    return {
      path: change.path, status: change.status, sensitive: marked?.sensitive ?? 'no', scope: marked?.scope ?? 'none',
      additions: change.added, deletions: change.removed,
    };
  });
}

// The judged paths of an iteration: the paths of its built delta and every path of its change
// (files) whose mark (sensitive, scope) differs from the baseline's (baseFiles; a path the baseline
// did not change has none). undefined, every path of the change, when the iteration has no built
// delta or the baseline's file list is not known.
export function judgedPaths(files: readonly FileChange[] | undefined, delta: IterationDelta | undefined, baseFiles: readonly FileChange[] | undefined): Set<string> | undefined {
  if (delta === undefined || !('files' in delta) || baseFiles === undefined) {
    return undefined;
  }
  const before = new Map(baseFiles.map((file) => [file.path, markOf(file)]));
  const judged = new Set(delta.files.map((file) => file.path));
  for (const file of files ?? []) {
    if (before.get(file.path) !== markOf(file)) {
      judged.add(file.path);
    }
  }
  return judged;
}

// The files of the change on judged paths (judgedPaths; undefined: all of them).
export function judgedFiles(files: FileChange[] | undefined, judged: ReadonlySet<string> | undefined): FileChange[] | undefined {
  return files === undefined || judged === undefined ? files : files.filter((file) => judged.has(file.path));
}

// The judged paths of an iteration's meta.json (judgedPaths), with the baseline's meta.json read
// by read; a baseline that cannot be read, or holds no file list, leaves every path judged.
export async function judgedOf(meta: IterationMeta | undefined, read: (iteration: number) => Promise<IterationMeta | undefined>): Promise<Set<string> | undefined> {
  const delta = meta?.delta;
  if (meta === undefined || delta === undefined || !('files' in delta)) {
    return undefined;
  }
  let base: IterationMeta | undefined;
  try {
    base = await read(delta.from);
  } catch (error) {
    console.error(error);
  }
  return judgedPaths(meta.files, delta, base?.files);
}

// The paths of a delta reviewed whole: those a full rule of the gate level names (fullRulePaths);
// every one when the Task's may_touch could not be read (mayTouch undefined).
export function wholePaths(delta: BuiltDelta, rules: Omit<PathRules, 'mayTouch'> & { mayTouch: readonly string[] | undefined }): string[] {
  const paths = delta.files.map((file) => file.path);
  return rules.mayTouch === undefined ? paths : fullRulePaths(paths, { ...rules, mayTouch: rules.mayTouch });
}

// An item's path as a file: without a leading ./ and a trailing :line or :a-b.
export const itemPath = (path: string): string => path.replace(/^(?:\.\/)+/, '').replace(/:\d+(?:-\d+)?$/, '');

// What the filter of a delta round reads.
export interface OutsideInput {
  // The delta's paths; the whole paths (wholePaths) are among them.
  delta: ReadonlySet<string>;
  // Which of the items' paths (itemPath) are files of the iteration's tree; undefined when that
  // read failed: nothing is dropped.
  files: ReadonlySet<string> | undefined;
  // The baseline: a user message counts for asked_by_user only when its at is later than clean.at.
  clean: Pick<CleanBaseline, 'at'>;
  messages: readonly UserMessage[];
}

// Whether a user message was sent after the clean round (its at later than at; at null never).
export function askedAfter(messages: readonly UserMessage[], at: string): boolean {
  const since = Date.parse(at);
  return messages.some((message) => message.at !== null && Date.parse(message.at) > since);
}

// The items of a delta round's verdict it keeps, and those it drops: an item on a file of the
// tree outside the delta stands only with outside_delta broken_by_delta, or asked_by_user when a
// user message came after the clean round. An item whose path is empty or not a file of the tree
// (a directory, a glob, a path that is not there) is kept, and so is every item when the tree's
// files could not be read.
export function outsideDelta(items: readonly ReviewItem[], input: OutsideInput): { kept: ReviewItem[]; dropped: ReviewItem[] } {
  const asked = askedAfter(input.messages, input.clean.at);
  const kept: ReviewItem[] = [];
  const dropped: ReviewItem[] = [];
  for (const item of items) {
    const path = itemPath(item.path);
    const outside = input.files !== undefined && path !== '' && input.files.has(path) && !input.delta.has(path);
    const reason = item.outside_delta ?? '';
    const stands = !outside || reason === 'broken_by_delta' || (reason === 'asked_by_user' && asked);
    (stands ? kept : dropped).push(item);
  }
  return { kept, dropped };
}

// A verdict as it is stored: an item's outside_delta only when the reviewer gave a reason.
export function withoutEmptyReasons<T extends { items: ReviewItem[] }>(output: T): T {
  return {
    ...output,
    items: output.items.map((item) => {
      if (item.outside_delta !== undefined && item.outside_delta !== '') {
        return item;
      }
      const { outside_delta: _none, ...rest } = item;
      return rest;
    }),
  };
}

// What a delta round reads of the job; the Execution gives it.
export interface DeltaReads {
  meta(iteration: number): Promise<IterationMeta>;
  messages(): Promise<UserMessage[]>;
  // Which of paths are files of tree in the job's worktree (filesOfTree of src/patch.ts).
  filesOf(tree: string, paths: string[]): Promise<ReadonlySet<string>>;
  // The text of the change between two trees, limited to paths, and whether it was cut at the
  // Patch size limit (treeDiff of src/patch.ts).
  diff(from: string, to: string, paths: string[]): Promise<{ patch: Buffer; truncated: boolean }>;
  // The Patch text per file (fileSections of src/patch.ts).
  sections(patch: string): Map<string, string>;
  // Writes an iteration's meta.json again: its delta skipped because it could not be rebuilt.
  record(meta: IterationMeta): Promise<void>;
}

// The items of a verdict on the job's iteration that its delta round keeps and drops
// (outsideDelta). Nothing is dropped outside a delta round (no built delta, or a clean baseline
// that is not the delta's), nor when the iteration's meta.json or tree cannot be read.
export async function dropOutside(job: { iteration: number; clean?: CleanBaseline }, items: ReviewItem[], reads: DeltaReads): Promise<{ kept: ReviewItem[]; dropped: ReviewItem[] }> {
  const none = { kept: items, dropped: [] };
  if (items.length === 0 || job.clean === undefined) {
    return none;
  }
  let meta: IterationMeta;
  try {
    meta = await reads.meta(job.iteration);
  } catch (error) {
    console.error(error);
    return none;
  }
  const delta = meta.delta;
  if (delta === undefined || !('files' in delta) || delta.from !== job.clean.iteration) {
    return none;
  }
  let files: ReadonlySet<string> | undefined;
  try {
    files = meta.commit_tree === undefined ? undefined : await reads.filesOf(meta.commit_tree, items.map((item) => itemPath(item.path)));
  } catch (error) {
    console.error(error);
  }
  return outsideDelta(items, { delta: new Set(delta.files.map((file) => file.path)), files, clean: job.clean, messages: await reads.messages() });
}

// A verdict record without the items its delta round drops (dropOutside), and those items; a
// record without a verdict as it is.
export async function withinDelta<R extends ReviewRecord | GateRecord>(job: { iteration: number; clean?: CleanBaseline }, record: R | undefined, reads: DeltaReads): Promise<[R | undefined, ReviewItem[]]> {
  if (record === undefined || !('verdict' in record)) {
    return [record, []];
  }
  const { kept, dropped } = await dropOutside(job, record.items, reads);
  return [{ ...record, items: kept }, dropped];
}

// The job with its iteration as the clean baseline, at at; the job itself when its clean names that
// iteration already (a job picked up again).
export function withClean<J extends { iteration: number; gate_fixes: number; clean?: CleanBaseline }>(job: J, at: string): J {
  return job.clean?.iteration === job.iteration ? job : { ...job, clean: { iteration: job.iteration, at, gate_fixes: job.gate_fixes } };
}

// The files of the change at iteration on its judged paths (judgedOf); undefined when its meta.json
// cannot be read or holds no file list.
export async function judgedChange(iteration: number, read: (iteration: number) => Promise<IterationMeta | undefined>): Promise<FileChange[] | undefined> {
  let meta: IterationMeta | undefined;
  try {
    meta = await read(iteration);
  } catch (error) {
    console.error(error);
    return undefined;
  }
  return judgedFiles(meta?.files, await judgedOf(meta, read));
}

// The material of a delta round (ReviewInput's delta): the baseline's iteration and tree, the
// delta's text, the whole paths and their sections of the iteration's Patch, the whole change's
// file list (accepted_change) and its files on judged paths (marked_paths).
export interface DeltaMaterial {
  from: number;
  fromTree: string;
  // The iteration's commit_tree: git diff fromTree toTree is the delta, untracked new files included.
  toTree: string;
  patch: Buffer;
  // Whether patch was cut at the Patch size limit as it was rebuilt: the review's note says so.
  patchCut: boolean;
  wholePaths: string[];
  whole: Buffer;
  change: FileChange[];
  marked: FileChange[] | undefined;
}

// The text of the built delta of meta rebuilt from its two trees, with the iteration's tree; or why
// it cannot be: no commit_tree, or Git cannot compare the trees (a tree object gone, a Git failure).
async function rebuilt(meta: IterationMeta, delta: BuiltDelta, reads: DeltaReads): Promise<{ patch: Buffer; truncated: boolean; toTree: string } | string> {
  const toTree = meta.commit_tree;
  if (toTree === undefined) {
    return 'this iteration has no commit_tree';
  }
  try {
    return { ...(await reads.diff(delta.from_tree, toTree, delta.files.map((file) => file.path))), toTree };
  } catch (error) {
    console.error(error);
    return `git could not rebuild the delta from the trees of iteration ${delta.from} and this iteration`;
  }
}

// meta with its delta skipped, with why: once recorded (reads.record), the round's gate level,
// prompt, filter and judged paths, which all read meta.json, take the whole change.
const skippedMeta = (meta: IterationMeta, delta: BuiltDelta, why: string): IterationMeta => ({ ...meta, delta: { from: delta.from, skipped: why } });

// The iteration's meta.json as a round's gate level reads it: a built delta that can no longer be
// rebuilt is recorded as skipped (skippedMeta) and returned so, the round whole. Throws when
// meta.json cannot be read; a record that fails is logged, and the review meets the delta again
// (deltaMaterial).
export async function checkedMeta(iteration: number, reads: DeltaReads): Promise<IterationMeta> {
  const meta = await reads.meta(iteration);
  const delta = meta.delta;
  if (delta === undefined || !('files' in delta)) {
    return meta;
  }
  const text = await rebuilt(meta, delta, reads);
  if (typeof text !== 'string') {
    return meta;
  }
  const skipped = skippedMeta(meta, delta, text);
  await reads.record(skipped).catch((error: unknown) => console.error(error));
  return skipped;
}

// The material of the iteration of meta, with patch its Patch; undefined without a built delta, or
// when its text can no longer be rebuilt (it went after checkedMeta, or no gate level was decided
// in this round): the delta is then recorded as skipped (skippedMeta) and the round reviews the
// whole change. Throws only when that record fails: the review fails visibly rather than judge the
// whole change in a round whose filter would still read the delta.
export async function deltaMaterial(meta: IterationMeta, patch: Buffer, rules: Parameters<typeof wholePaths>[1], reads: DeltaReads): Promise<DeltaMaterial | undefined> {
  const delta = meta.delta;
  if (delta === undefined || !('files' in delta)) {
    return undefined;
  }
  const text = await rebuilt(meta, delta, reads);
  if (typeof text === 'string') {
    await reads.record(skippedMeta(meta, delta, text));
    return undefined;
  }
  const whole = wholePaths(delta, { ...rules, files: meta.files ?? [] });
  const sections = reads.sections(patch.toString('utf8'));
  return {
    from: delta.from, fromTree: delta.from_tree, toTree: text.toTree, wholePaths: whole, patch: text.patch, patchCut: text.truncated,
    whole: Buffer.from(whole.map((path) => sections.get(path) ?? '').join(''), 'utf8'),
    change: meta.files ?? [],
    marked: judgedFiles(meta.files, await judgedOf(meta, (iteration) => reads.meta(iteration))),
  };
}

const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

// The gate decision of a round (gate-level.json without its time). Outside a delta round (no delta
// on the iteration's meta.json): gateDecision with the job's gate fixes, or without the Claude
// review full with 'no Claude review'. In a round after the clean baseline the gate's fixes count
// from it (gateFixes minus the baseline's): a built delta is decided on the delta's files, its
// reasons beginning with 'delta since iteration N: F files, L lines', its counts the delta's; a
// skipped one on the whole change (input), with 'whole change: <why>' last.
export function roundGateDecision(input: GateLevelInput, job: { claudeReview: boolean; gateFixes: number; clean: CleanBaseline | undefined }, delta: IterationDelta | undefined): GateDecision {
  const baseline = delta !== undefined && job.clean?.iteration === delta.from ? job.clean : undefined;
  const fixes = baseline === undefined ? job.gateFixes : Math.max(0, job.gateFixes - baseline.gate_fixes);
  const noClaude = (reasons: string[], files: number | null, lines: number | null): GateDecision => ({ level: 'full', ran: true, reasons: ['no Claude review', ...reasons], files, lines });
  if (delta === undefined) {
    return job.claudeReview ? gateDecision(input, fixes) : noClaude([], null, null);
  }
  if (!('files' in delta)) {
    const whole = `whole change: ${delta.skipped}`;
    if (!job.claudeReview) {
      return noClaude([whole], null, null);
    }
    const decision = gateDecision(input, fixes);
    return { ...decision, reasons: [...decision.reasons, whole] };
  }
  const lines = changedLines(delta.files);
  const since = `delta since iteration ${delta.from}: ${counted(delta.files.length, 'file')}, ${counted(lines, 'line')}`;
  if (!job.claudeReview) {
    return noClaude([since], delta.files.length, lines);
  }
  const decision = gateDecision({ ...input, files: delta.files, patchTruncated: false }, fixes);
  return { ...decision, reasons: [since, ...decision.reasons] };
}

// The lines that open a delta round's prompt: the baseline, what an item outside the delta needs,
// the direct callers, and the whole paths when there are any.
export function deltaLines(material: Pick<DeltaMaterial, 'from' | 'wholePaths'>): string[] {
  const { from } = material;
  return [
    `- The change was clean at iteration ${from}; judge the delta since then: <delta_patch from="${from}"> below. The rest of the change (<accepted_change>) was accepted at that clean round and is context only. An item on a file outside the delta stands only when the delta breaks that code (set \`outside_delta\` to \`broken_by_delta\` and say in \`problem\` which delta line breaks it) or a user message after the clean round asks for it (\`asked_by_user\`, citing the message); otherwise the factory drops it.`,
    '- An item about something the delta is missing, or requires elsewhere (a test, a doc, a caller it should have changed), goes on the delta file it concerns, or sets `outside_delta` to `broken_by_delta`, saying in `problem` what the delta requires.',
    '- Read each file of the delta in full and find its direct callers yourself (Grep, `rg`): they are the delta\'s context.',
    ...(material.wholePaths.length > 0 ? [`- These delta paths are security-relevant, so their whole section of the change is in <patch> below and judged whole: ${material.wholePaths.join(', ')}.`] : []),
  ];
}

// The lines of <accepted_change>: each path of the whole change with its status and counts.
export function acceptedLines(change: readonly FileChange[]): string[] {
  return change.length === 0 ? ['None.'] : change.map((file) => `- ${file.path} (${file.status}, +${file.additions} -${file.deletions})`);
}
