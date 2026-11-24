// Unit tests of a delta round (src/review-delta.ts and its Git reads in src/patch.ts): the delta's
// files and marks from two trees and when it is skipped, the judged paths, the filter of the items
// outside the delta, the gate decision of a delta round, its prompt, and the item's outside_delta
// in the schema and the stored record.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateDecision, type GateLevelInput, LIGHT_SKIPPED } from '../src/gate-level.js';
import { gatePrompt } from '../src/gate.js';
import type { UserMessage } from '../src/job-stream.js';
import type { FileChange, IterationMeta } from '../src/jobs.js';
import { filesOfTree, iterationDelta, MAX_PATCH_BYTES, treeChanges, treeDiff } from '../src/patch.js';
import {
  checkedMeta, type CleanBaseline, cleanSchema, type DeltaMaterial, type DeltaReads, deltaMaterial, dropOutside, type IterationDelta, itemPath, judgedChange, judgedFiles, judgedPaths, outsideDelta,
  roundGateDecision, withClean, withoutEmptyReasons,
} from '../src/review-delta.js';
import { MAX_REVIEW_PATCH_BYTES, type ReviewInput, type ReviewItem, reviewOutput, reviewPrompt } from '../src/review.js';
import { loadHandbook } from '../src/server.js';
import { git, temp } from './support/harness.js';

const change = (path: string, extra: Partial<FileChange> = {}): FileChange => ({ path, status: 'modified', sensitive: 'no', scope: 'in', additions: 1, deletions: 0, ...extra });
const item = (path: string, extra: Partial<ReviewItem> = {}): ReviewItem => ({ path, problem: 'P.', expected: 'E.', severity: 'major', ...extra });
const CLEAN: CleanBaseline = { iteration: 1, at: '2026-11-24T10:00:00.000Z', gate_fixes: 0 };
const message = (at: string | null): UserMessage => ({ iteration: 2, at, text: 'Fix the button.' });

function meta(iteration: number, extra: Partial<IterationMeta> = {}): IterationMeta {
  return {
    iteration, started_at: 's', ended_at: 'e', denials: [], changed_files: [], patch_truncated: false, submodule_changed: [], cost_usd: null, cost_usd_total: null, duration_ms: null, ...extra,
  };
}

// A repository with two trees: from (a.css, b.ts, dir/c.ts, gone.ts) and to (a.css one line
// changed, gone.ts deleted, new.ts added, the rest as from).
async function trees(): Promise<{ repo: string; from: string; to: string }> {
  const repo = await mkdtemp(join(temp, 'review-delta-'));
  git(repo, 'init', '-q', '-b', 'main');
  await mkdir(join(repo, 'dir'));
  await writeFile(join(repo, 'a.css'), '.a { color: red; }\n');
  await writeFile(join(repo, 'b.ts'), 'export const b = 1;\n');
  await writeFile(join(repo, 'dir', 'c.ts'), 'export const c = 1;\n');
  await writeFile(join(repo, 'gone.ts'), 'x\n');
  git(repo, 'add', '-A');
  const from = git(repo, 'write-tree').trim();
  await writeFile(join(repo, 'a.css'), '.a { color: blue; }\n');
  await writeFile(join(repo, 'new.ts'), 'export const n = 1;\nexport const m = 2;\n');
  git(repo, 'rm', '-q', '-f', 'gone.ts');
  git(repo, 'add', '-A');
  return { repo, from, to: git(repo, 'write-tree').trim() };
}

test('the delta from two trees: each path\'s status and counts, limited to the given paths; its marks from the new file list, else the baseline\'s', async () => {
  const { repo, from, to } = await trees();
  assert.deepEqual(await treeChanges(repo, from, to, ['a.css', 'b.ts', 'gone.ts', 'new.ts']), [
    { path: 'a.css', status: 'modified', added: 1, removed: 1 },
    { path: 'gone.ts', status: 'deleted', added: 0, removed: 1 },
    { path: 'new.ts', status: 'added', added: 2, removed: 0 },
  ]);
  // Only the change's own paths: new.ts is not asked for, so it is not in the delta; no paths, no delta.
  assert.deepEqual((await treeChanges(repo, from, to, ['a.css'])).map((entry) => entry.path), ['a.css']);
  assert.deepEqual(await treeChanges(repo, from, to, []), []);
  const text = await treeDiff(repo, from, to, ['a.css']);
  assert.match(text.patch.toString('utf8'), /^-\.a \{ color: red; \}\n\+\.a \{ color: blue; \}$/m);
  assert.equal(text.truncated, false);
  assert.deepEqual(await treeDiff(repo, from, to, []), { patch: Buffer.alloc(0), truncated: false });
  // iterationDelta: the baseline's file list names gone.ts (scope out), the new one a.css (sensitive) and new.ts.
  const baseFiles = [change('a.css'), change('gone.ts', { scope: 'out' })];
  const files = [change('a.css', { sensitive: 'undeclared' }), change('new.ts', { status: 'added', additions: 2 })];
  const built = await iterationDelta(repo, 1, meta(1, { commit_tree: from, files: baseFiles }), { tree: to, truncated: false, files });
  assert.deepEqual(built, {
    from: 1, from_tree: from, files: [
      { path: 'a.css', status: 'modified', sensitive: 'undeclared', scope: 'in', additions: 1, deletions: 1 },
      { path: 'gone.ts', status: 'deleted', sensitive: 'no', scope: 'out', additions: 0, deletions: 1 },
      { path: 'new.ts', status: 'added', sensitive: 'no', scope: 'in', additions: 2, deletions: 0 },
    ],
  });
});

test('treeDiff of a delta past the Patch size limit: cut after a whole line, and says it was cut', async () => {
  const { repo, from } = await trees();
  const line = `${'x'.repeat(99)}\n`;
  await writeFile(join(repo, 'big.txt'), line.repeat(Math.ceil(MAX_PATCH_BYTES / line.length) + 100));
  git(repo, 'add', '-A');
  const to = git(repo, 'write-tree').trim();
  const { patch, truncated } = await treeDiff(repo, from, to, ['big.txt']);
  assert.equal(truncated, true);
  assert.ok(patch.length <= MAX_PATCH_BYTES && patch.length > MAX_PATCH_BYTES - 200, String(patch.length));
  assert.equal(patch.at(-1), 0x0a);
});

test('iterationDelta is skipped, with why: a baseline without meta.json, commit_tree or file list, a Patch cut at either end, a tree object gone', async () => {
  const { repo, from, to } = await trees();
  const to1 = { tree: to, truncated: false, files: [change('a.css')] };
  const base = meta(1, { commit_tree: from, files: [change('a.css')] });
  const skipped = async (baseline: IterationMeta | undefined, target = to1): Promise<string> => {
    const delta = await iterationDelta(repo, 1, baseline, target);
    assert.ok('skipped' in delta, JSON.stringify(delta));
    return delta.skipped;
  };
  assert.equal(await skipped(undefined), 'the meta.json of iteration 1 cannot be read');
  assert.equal(await skipped(meta(1, { files: [] })), 'iteration 1 has no commit_tree');
  assert.equal(await skipped(meta(1, { commit_tree: from })), 'iteration 1 has no file list');
  assert.equal(await skipped({ ...base, patch_truncated: true }), 'the Patch of iteration 1 was cut at its size limit');
  assert.equal(await skipped(base, { ...to1, truncated: true }), 'the Patch of this iteration was cut at its size limit');
  assert.equal(await skipped({ ...base, commit_tree: 'b'.repeat(40) }), 'git could not compare the trees of iteration 1 and this iteration');
});

test('filesOfTree: a file of the tree is; a directory, a glob, a path that is not there, an empty path and one with a line break are not, nor any of a tree that is not there; a failing Git throws', async () => {
  const { repo, to } = await trees();
  assert.deepEqual([...(await filesOfTree(repo, to, ['a.css', 'dir', 'dir/c.ts', 'gone.ts', '', 'a\n.css', 'src/**']))].sort(), ['a.css', 'dir/c.ts']);
  assert.deepEqual(await filesOfTree(repo, to, []), new Set());
  // A tree that is not there has no files: no item on it is ever dropped.
  assert.deepEqual(await filesOfTree(repo, 'b'.repeat(40), ['a.css']), new Set());
  await assert.rejects(filesOfTree(join(repo, 'no-such-dir'), to, ['a.css']));
});

test('the judged paths: a delta path; an untouched path whose mark changed since the baseline; not an untouched path with the baseline\'s mark; every path when the baseline\'s file list is not known', async () => {
  const baseFiles = [change('a.css'), change('docs/x.md', { scope: 'out' }), change('src/old.ts', { scope: 'in' })];
  const files = [change('a.css'), change('docs/x.md', { scope: 'out' }), change('src/old.ts', { scope: 'out' })];
  const delta: IterationDelta = { from: 1, from_tree: 'f'.repeat(40), files: [change('a.css')] };
  assert.deepEqual([...judgedPaths(files, delta, baseFiles)!].sort(), ['a.css', 'src/old.ts']);
  // marked_paths and unaccepted read the same files: src/old.ts (scope changed) in, docs/x.md (as at the baseline) out.
  assert.deepEqual(judgedFiles(files, judgedPaths(files, delta, baseFiles))!.map((file) => file.path), ['a.css', 'src/old.ts']);
  assert.equal(judgedPaths(files, delta, undefined), undefined);
  assert.equal(judgedPaths(files, { from: 1, skipped: 'why' }, baseFiles), undefined);
  assert.equal(judgedPaths(files, undefined, baseFiles), undefined);
  assert.deepEqual(judgedFiles(files, undefined), files);
  // judgedChange reads the iteration and its baseline: one that cannot be read leaves every path judged.
  const metas = new Map([[1, meta(1, { files: baseFiles })], [2, meta(2, { files, delta })]]);
  const read = async (iteration: number): Promise<IterationMeta> => metas.get(iteration) ?? Promise.reject(new Error('ENOENT'));
  assert.deepEqual((await judgedChange(2, read))!.map((file) => file.path), ['a.css', 'src/old.ts']);
  metas.delete(1);
  assert.deepEqual((await judgedChange(2, read))!.map((file) => file.path), ['a.css', 'docs/x.md', 'src/old.ts']);
  metas.set(1, meta(1));
  assert.equal((await judgedChange(2, read))!.length, 3);
  assert.equal(await judgedChange(3, read), undefined);
});

test('the filter of a delta round: by path (with :line, :a-b, ./), each outside_delta, asked_by_user by the message\'s at; an empty path, a path that is not a file and a failed read keep the item', () => {
  const files = new Set(['a.css', 'src/b.ts']);
  const input = { delta: new Set(['a.css']), files, clean: CLEAN, messages: [] as UserMessage[] };
  assert.deepEqual(['src/b.ts:12', './src/b.ts', 'src/b.ts:3-9', 'a.css'].map(itemPath), ['src/b.ts', 'src/b.ts', 'src/b.ts', 'a.css']);
  const items = [
    item('a.css:3'), item('./src/b.ts:12'), item('src/b.ts', { outside_delta: 'broken_by_delta' }), item('src/b.ts', { outside_delta: 'asked_by_user' }), item('src/b.ts', { outside_delta: '' }),
    item(''), item('src'), item('src/**'),
  ];
  const { kept, dropped } = outsideDelta(items, input);
  assert.deepEqual(kept, [items[0], items[2], items[5], items[6], items[7]]);
  assert.deepEqual(dropped, [items[1], items[3], items[4]]);
  // asked_by_user stands with a message after clean.at, not with one before it or with at null.
  const asked = [item('src/b.ts', { outside_delta: 'asked_by_user' })];
  assert.equal(outsideDelta(asked, { ...input, messages: [message('2026-11-24T10:05:00.000Z')] }).kept.length, 1);
  assert.equal(outsideDelta(asked, { ...input, messages: [message('2026-11-24T09:55:00.000Z'), message(null)] }).kept.length, 0);
  // Nothing is dropped when the tree's files could not be read.
  assert.deepEqual(outsideDelta(items, { ...input, files: undefined }), { kept: items, dropped: [] });
});

test('dropOutside: only in a delta round from the job\'s clean baseline; the tree read that fails drops nothing', async () => {
  const delta: IterationDelta = { from: 1, from_tree: 'f'.repeat(40), files: [change('a.css')] };
  let filesOf: DeltaReads['filesOf'] = async () => new Set(['a.css', 'b.ts']);
  const reads = (iterationMeta: IterationMeta): DeltaReads => ({
    meta: async () => iterationMeta, messages: async () => [], filesOf: (tree, paths) => filesOf(tree, paths), diff: async () => ({ patch: Buffer.alloc(0), truncated: false }), sections: () => new Map(),
    record: async () => assert.fail('nothing to record'),
  });
  const items = [item('a.css'), item('b.ts')];
  const deltaMeta = meta(2, { commit_tree: 't'.repeat(40), delta });
  assert.deepEqual((await dropOutside({ iteration: 2, clean: CLEAN }, items, reads(deltaMeta))).dropped, [items[1]]);
  // A whole round (no delta, a skipped one), a job without clean, or a clean of another iteration: nothing dropped.
  for (const [job, iterationMeta] of [
    [{ iteration: 2, clean: CLEAN }, meta(2)], [{ iteration: 2, clean: CLEAN }, meta(2, { delta: { from: 1, skipped: 'why' } })],
    [{ iteration: 2 }, deltaMeta], [{ iteration: 2, clean: { ...CLEAN, iteration: 2 } }, deltaMeta],
  ] as const) {
    assert.deepEqual((await dropOutside(job, items, reads(iterationMeta))).dropped, [], JSON.stringify([job, iterationMeta.delta]));
  }
  filesOf = async () => Promise.reject(new Error('git cat-file failed'));
  assert.deepEqual((await dropOutside({ iteration: 2, clean: CLEAN }, items, reads(deltaMeta))).dropped, []);
});

test('withClean: the iteration becomes the baseline with the job\'s gate_fixes; a clean naming it already is kept', () => {
  const job = { iteration: 3, gate_fixes: 2 };
  assert.deepEqual(withClean(job, CLEAN.at), { iteration: 3, gate_fixes: 2, clean: { iteration: 3, at: CLEAN.at, gate_fixes: 2 } });
  const kept = { ...job, clean: { iteration: 3, at: '2026-01-01T00:00:00.000Z', gate_fixes: 1 } };
  assert.equal(withClean(kept, CLEAN.at), kept);
  assert.equal(cleanSchema.safeParse({ iteration: 3, at: CLEAN.at, gate_fixes: 2 }).success, true);
  assert.equal(cleanSchema.safeParse({ iteration: 0, at: CLEAN.at, gate_fixes: 2 }).success, false);
});

const levelInput = (files: FileChange[] | undefined, extra: Partial<GateLevelInput> = {}): GateLevelInput => ({
  files, patchTruncated: false, mayTouch: [], setting: 'auto', fullPaths: [], sensitivePaths: [], ...extra,
});

test('roundGateDecision of a delta: light runs with no gate fix since the baseline while gate_fixes is 2; light skipped after one; full with a security path; a skipped delta; no Claude review', () => {
  const whole = Array.from({ length: 20 }, (_, index) => change(`src/f${index}.ts`, { additions: 40 }));
  const css: IterationDelta = { from: 1, from_tree: 'f'.repeat(40), files: [change('src/app.css', { additions: 1, deletions: 0 })] };
  const baseline = { ...CLEAN, gate_fixes: 2 };
  // The whole change is full by size; the delta is light, and the gate asked for no fix since the baseline.
  assert.equal(gateDecision(levelInput(whole), 2).level, 'full');
  assert.deepEqual(roundGateDecision(levelInput(whole), { claudeReview: true, gateFixes: 2, clean: baseline }, css), {
    level: 'light', ran: true, reasons: ['delta since iteration 1: 1 file, 1 line', 'light: 1 file, 1 line'], files: 1, lines: 1,
  });
  assert.deepEqual(roundGateDecision(levelInput(whole), { claudeReview: true, gateFixes: 3, clean: baseline }, css), {
    level: 'light', ran: false, reasons: ['delta since iteration 1: 1 file, 1 line', LIGHT_SKIPPED], files: 1, lines: 1,
  });
  const token: IterationDelta = { ...css, files: [change('src/auth/token.ts', { additions: 2, deletions: 1 })] };
  assert.deepEqual(roundGateDecision(levelInput(whole), { claudeReview: true, gateFixes: 3, clean: baseline }, token), {
    level: 'full', ran: true, reasons: ['delta since iteration 1: 1 file, 3 lines', 'security: src/auth/token.ts'], files: 1, lines: 3,
  });
  // A skipped delta: the whole change's level, its gate fixes from the baseline, 'whole change: <why>' last.
  const skipped: IterationDelta = { from: 1, skipped: 'iteration 1 has no commit_tree' };
  const small = [change('src/app.css')];
  assert.deepEqual(roundGateDecision(levelInput(small), { claudeReview: true, gateFixes: 2, clean: baseline }, skipped), {
    level: 'light', ran: true, reasons: ['light: 1 file, 1 line', 'whole change: iteration 1 has no commit_tree'], files: 1, lines: 1,
  });
  assert.deepEqual(roundGateDecision(levelInput(small), { claudeReview: true, gateFixes: 3, clean: baseline }, skipped).reasons, [LIGHT_SKIPPED, 'whole change: iteration 1 has no commit_tree']);
  // Without the Claude review: full, its reasons naming the delta or the whole change; the counts the delta's.
  assert.deepEqual(roundGateDecision(levelInput(whole), { claudeReview: false, gateFixes: 3, clean: baseline }, css), {
    level: 'full', ran: true, reasons: ['no Claude review', 'delta since iteration 1: 1 file, 1 line'], files: 1, lines: 1,
  });
  assert.deepEqual(roundGateDecision(levelInput(small), { claudeReview: false, gateFixes: 3, clean: baseline }, skipped).reasons, ['no Claude review', 'whole change: iteration 1 has no commit_tree']);
  // A first round is as gateDecision has it, with the job's gate fixes.
  assert.deepEqual(roundGateDecision(levelInput(small), { claudeReview: true, gateFixes: 1, clean: undefined }, undefined), gateDecision(levelInput(small), 1));
  assert.deepEqual(roundGateDecision(levelInput(small), { claudeReview: false, gateFixes: 1, clean: undefined }, undefined), {
    level: 'full', ran: true, reasons: ['no Claude review'], files: null, lines: null,
  });
});

const MISSING_LINE = '- An item about something the delta is missing, or requires elsewhere (a test, a doc, a caller it should have changed), goes on the delta file it concerns, or sets `outside_delta` to `broken_by_delta`, saying in `problem` what the delta requires.';

async function promptInput(extra: Partial<ReviewInput> = {}): Promise<ReviewInput> {
  const files = [change('src/app.css'), change('src/auth/token.ts', { sensitive: 'undeclared' }), change('docs/old.md', { scope: 'out' })];
  return {
    ticket: 'D-1', iteration: 2, task: 'The task.', report: 'The report.', patch: Buffer.from('diff --git a/src/app.css b/src/app.css\n+whole\n'), patchTruncated: false, files,
    handbook: (await loadHandbook()).text, ...extra,
  };
}

test('reviewBody of a delta round: the baseline and the missing-or-elsewhere lines, the judged marked paths, <delta_patch>, the whole sections in <patch>, <accepted_change>, each cut with its note', async () => {
  const input = await promptInput();
  const material: DeltaMaterial = {
    from: 1, fromTree: 'f'.repeat(40), toTree: 't'.repeat(40), patch: Buffer.from('diff --git a/src/auth/token.ts b/src/auth/token.ts\n+delta\n'), patchCut: false, wholePaths: ['src/auth/token.ts'],
    whole: Buffer.from('diff --git a/src/auth/token.ts b/src/auth/token.ts\n+whole token\n'), change: input.files!, marked: [input.files![1]!],
  };
  const prompt = reviewPrompt({ ...input, delta: material });
  assert.ok(prompt.includes('- The change was clean at iteration 1; judge the delta since then: <delta_patch from="1"> below.'), prompt);
  assert.ok(prompt.includes(`${MISSING_LINE}\n- Read each file of the delta in full and find its direct callers yourself`), prompt);
  assert.ok(prompt.includes('- These delta paths are security-relevant, so their whole section of the change is in <patch> below and judged whole: src/auth/token.ts.'));
  assert.ok(prompt.includes('<marked_paths>\n- sensitive, undeclared: src/auth/token.ts\n</marked_paths>'), prompt);
  assert.ok(prompt.includes('<delta_patch from="1">\ndiff --git a/src/auth/token.ts b/src/auth/token.ts\n+delta\n</delta_patch>\n\n<patch>\ndiff --git a/src/auth/token.ts b/src/auth/token.ts\n+whole token\n</patch>'), prompt);
  assert.ok(prompt.includes('<accepted_change>\n- src/app.css (modified, +1 -0)\n- src/auth/token.ts (modified, +1 -0)\n- docs/old.md (modified, +1 -0)\n</accepted_change>'), prompt);
  assert.ok(!prompt.includes('+whole\n'), 'the whole Patch is not sent');
  // No whole path: no <patch> block, no security line.
  const plain = reviewPrompt({ ...input, delta: { ...material, wholePaths: [], whole: Buffer.alloc(0) } });
  assert.ok(!plain.includes('<patch>') && !plain.includes('security-relevant, so'));
  // Each block is cut at MAX_REVIEW_PATCH_BYTES with its note.
  const big = Buffer.from('x'.repeat(MAX_REVIEW_PATCH_BYTES + 10));
  const cut = reviewPrompt({ ...input, delta: { ...material, patch: big, whole: big } });
  assert.ok(cut.includes(`Note: The delta has ${big.length} bytes; only the first ${MAX_REVIEW_PATCH_BYTES} are below.`));
  assert.ok(cut.includes(`Note: The whole sections of the security-relevant paths has ${big.length} bytes; only the first ${MAX_REVIEW_PATCH_BYTES} are below.`));
  // A delta already cut at the Patch size limit when it was rebuilt says so, whatever its length now.
  const rebuiltCut = reviewPrompt({ ...input, delta: { ...material, patchCut: true } });
  assert.ok(rebuiltCut.includes(`Note: The delta has more than ${material.patch.length} bytes; only the first ${material.patch.length} are below. Read the changed files in the worktree for the rest.\n<delta_patch from="1">`), rebuiltCut);
  assert.ok(!prompt.includes('Note: The delta'));
  // The gate names the command that shows the delta.
  assert.ok(gatePrompt({ ...input, delta: material, baseCommit: 'b'.repeat(40) }).includes(`\`git diff ${'f'.repeat(40)} ${'t'.repeat(40)}\` shows the delta since the clean round of iteration 1 (the two trees, new files included).`));
});

test('reviewBody of a first round has no delta block or line: the whole Patch and every marked path', async () => {
  const input = await promptInput();
  const prompt = reviewPrompt(input);
  assert.ok(prompt.includes('<patch>\ndiff --git a/src/app.css b/src/app.css\n+whole\n</patch>'));
  assert.ok(prompt.includes('<marked_paths>\n- sensitive, undeclared: src/auth/token.ts\n- outside the Task\'s scope: docs/old.md\n</marked_paths>'));
  // The Handbook's review rules (sent with every round) name the blocks; the blocks and lines themselves are absent.
  for (const absent of ['\n<delta_patch from=', '\n<accepted_change>\n', MISSING_LINE, '- The change was clean at iteration']) {
    assert.ok(!prompt.includes(absent), absent);
  }
  assert.ok(!gatePrompt({ ...input, baseCommit: 'b'.repeat(40) }).includes('shows the delta'));
});

test('deltaMaterial rebuilds the delta from the two trees with the judged marked paths; none without a built delta', async () => {
  const files = [change('a.css'), change('src/token.ts', { sensitive: 'undeclared' }), change('docs/old.md', { scope: 'out' })];
  const delta: IterationDelta = { from: 1, from_tree: 'f'.repeat(40), files: [change('a.css'), change('src/token.ts')] };
  const asked: unknown[] = [];
  const metas = new Map([[1, meta(1, { files: [change('a.css'), change('docs/old.md', { scope: 'out' })] })], [2, meta(2, { files, delta, commit_tree: 't'.repeat(40) })]]);
  const reads: DeltaReads = {
    meta: async (iteration) => metas.get(iteration)!, messages: async () => [], filesOf: async () => new Set(),
    diff: async (from, to, paths) => {
      asked.push([from, to, paths]);
      return { patch: Buffer.from('delta'), truncated: asked.length > 1 };
    },
    sections: () => new Map([['src/token.ts', 'token section\n'], ['a.css', 'css section\n']]),
    record: async () => assert.fail('a delta that rebuilds is not recorded'),
  };
  const rules = { mayTouch: [], fullPaths: [], sensitivePaths: [] };
  const material = (await deltaMaterial(metas.get(2)!, Buffer.from('patch'), rules, reads))!;
  assert.deepEqual(asked, [['f'.repeat(40), 't'.repeat(40), ['a.css', 'src/token.ts']]]);
  assert.deepEqual([material.from, material.patch.toString(), material.patchCut, material.wholePaths, material.whole.toString()], [1, 'delta', false, ['src/token.ts'], 'token section\n']);
  assert.deepEqual(material.marked!.map((file) => file.path), ['a.css', 'src/token.ts']);
  // A Task file whose may_touch cannot be read: every delta path is whole. A delta text the rebuild
  // cut at the Patch size limit (the second read here) is marked cut.
  const unknownRules = (await deltaMaterial(metas.get(2)!, Buffer.from('patch'), { ...rules, mayTouch: undefined }, reads))!;
  assert.deepEqual([unknownRules.wholePaths, unknownRules.patchCut], [['a.css', 'src/token.ts'], true]);
  assert.equal(await deltaMaterial(meta(2, { files }), Buffer.from('patch'), rules, reads), undefined);
  assert.equal(await deltaMaterial(meta(2, { files, delta: { from: 1, skipped: 'why' } }), Buffer.from('patch'), rules, reads), undefined);
});

test('a delta that can no longer be rebuilt is recorded as skipped, with why, and its round is whole: as its gate level reads meta.json (checkedMeta) or, when it went after that, at the review (deltaMaterial); only a failed record fails the review', async () => {
  const files = [change('a.css')];
  const built = meta(2, { files, delta: { from: 1, from_tree: 'f'.repeat(40), files }, commit_tree: 't'.repeat(40) });
  const why = 'git could not rebuild the delta from the trees of iteration 1 and this iteration';
  const skipped = { ...built, delta: { from: 1, skipped: why } };
  const recorded: IterationMeta[] = [];
  let stored: IterationMeta = built;
  let diff: DeltaReads['diff'] = async () => ({ patch: Buffer.from('delta'), truncated: false });
  let record: DeltaReads['record'] = async (written) => {
    recorded.push(written);
  };
  const reads: DeltaReads = {
    meta: async () => stored, messages: async () => [], filesOf: async () => new Set(), diff: (from, to, paths) => diff(from, to, paths), sections: () => new Map(),
    record: (written) => record(written),
  };
  const rules = { mayTouch: [], fullPaths: [], sensitivePaths: [] };
  // A delta that rebuilds: nothing recorded; a whole iteration has nothing to check.
  assert.deepEqual(await checkedMeta(2, reads), built);
  stored = meta(2, { files });
  assert.deepEqual(await checkedMeta(2, reads), stored);
  stored = built;
  assert.deepEqual(recorded, []);
  // The gate level meets a tree object gone: the delta is recorded skipped, and the level is decided from that.
  diff = async () => Promise.reject(new Error('fatal: bad object'));
  assert.deepEqual(await checkedMeta(2, reads), skipped);
  assert.deepEqual(recorded.splice(0), [skipped]);
  // The interleaving: the check as the round started passed, then the tree went before the reviewer
  // rebuilt the delta. The review does not fail: it records the skip and gets no delta, a whole round.
  diff = async () => ({ patch: Buffer.from('delta'), truncated: false });
  assert.deepEqual(await checkedMeta(2, reads), built);
  diff = async () => Promise.reject(new Error('fatal: bad object'));
  assert.equal(await deltaMaterial(built, Buffer.from('patch'), rules, reads), undefined);
  assert.deepEqual(recorded.splice(0), [skipped]);
  // An iteration without commit_tree is skipped too.
  const treeless = meta(2, { files, delta: built.delta });
  assert.equal(await deltaMaterial(treeless, Buffer.from('patch'), rules, reads), undefined);
  assert.deepEqual(recorded.splice(0), [{ ...treeless, delta: { from: 1, skipped: 'this iteration has no commit_tree' } }]);
  // A record that fails: the gate level logs it and is decided on the whole change (the review meets
  // the delta again); the review fails visibly rather than judge the whole change in a round whose
  // filter would still read the delta.
  record = async () => Promise.reject(new Error('disk full'));
  assert.deepEqual(await checkedMeta(2, reads), skipped);
  await assert.rejects(deltaMaterial(built, Buffer.from('patch'), rules, reads), /disk full/);
  // A meta.json that cannot be read: checkedMeta throws, as reading it did (the gate level is then full).
  await assert.rejects(checkedMeta(2, { ...reads, meta: async () => Promise.reject(new Error('ENOENT')) }), /ENOENT/);
});

test('outside_delta: an old item without it parses; a verdict with it parses; an empty one is not stored', () => {
  const verdict = (items: unknown[]) => ({ verdict: 'fix', summary: 'S.', accepted_sensitive: [], items });
  const old = { path: 'a.ts', problem: 'P.', expected: 'E.', severity: 'major', reopens: '', caused_by: '' };
  const parsed = reviewOutput.parse(verdict([old]));
  assert.equal('outside_delta' in parsed.items[0]!, false);
  for (const value of ['', 'broken_by_delta', 'asked_by_user']) {
    assert.equal(reviewOutput.safeParse(verdict([{ ...old, outside_delta: value }])).success, true, value);
  }
  assert.equal(reviewOutput.safeParse(verdict([{ ...old, outside_delta: 'because' }])).success, false);
  const stored = withoutEmptyReasons(reviewOutput.parse(verdict([{ ...old, outside_delta: '' }, { ...old, outside_delta: 'broken_by_delta' }])));
  assert.deepEqual(stored.items, [old, { ...old, outside_delta: 'broken_by_delta' }]);
});
