// End-to-end tests of delta rounds with the real sf serve, the fake Claude (the Implementer and the
// Claude review) and the fake Codex: a first round reviews the whole Patch and its Clean becomes the
// baseline (job.json's clean); after sf say on the ready job the next round reviews the delta since
// then (DL-1, DL-2); an item outside the delta without a reason is dropped, one the delta breaks is a
// Fix (DL-3, DL-4); a security path of the delta is gated full and reviewed whole (DL-5); a light delta
// after a gate fix runs the gate, from the baseline, its delta built or skipped (DL-6, DL-8, DL-10);
// a delta that can no longer be rebuilt for its review is recorded as skipped and reviewed whole (DL-10);
// a path accepted at the baseline and left alone needs no new acceptance (DL-7); an Accept over a
// stop sets no baseline (DL-9).
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { LIGHT_SKIPPED } from '../src/gate-level.js';
import { JobStore } from '../src/jobs.js';
import { writeTask } from '../src/task-file.js';
import { call, codexLog, codexScript, type Env, fakeCodex, newEnv, newRepo, putTask, reviewLog, reviewScript, runCli, script, serve, stop, waitFor } from './support/harness.js';

const T = 'DL-1';
const GATE_CLEAN = { verdict: 'clean', summary: 'Codex found it right.', items: [], accepted_sensitive: [] };
const CLAUDE_CLEAN = { verdict: 'clean', summary: 'Claude found it right.', items: [], accepted_sensitive: [] };
// A major of the gate on src/app.ts, which the delta of the tests leaves alone.
const untouched = (outside: string): Record<string, unknown> => ({
  verdict: 'fix', summary: 'An old requirement.', accepted_sensitive: [],
  items: [{ path: 'src/app.ts:1', problem: 'Spec: it exports 1.', expected: 'It exports 2.', severity: 'major', outside_delta: outside }],
});

function mrText(): string {
  return [
    `feat(${T}): Style the page`, '',
    '## What', 'x', '## Why', 'The ticket asks for it.', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
    '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
  ].join('\n');
}
const mrTurn = { write: { [`.software-factory/${T}.mr.md`]: mrText() }, text: 'MR text' };
const turn = (files: Record<string, string>, text = 'Report'): Record<string, unknown> => ({ write: files, text });
// The first iteration of every test: a module and its style sheet.
const FIRST = turn({ 'src/app.ts': 'export const a = 1;\n', 'src/app.css': '.a { color: red; }\n' }, 'Report of iteration 1');
const CSS_FIX = turn({ 'src/app.css': '.a { color: blue; }\n' }, 'Report of the CSS fix');

async function deltaEnv(name: string, extra: Record<string, string> = {}, scope?: string): Promise<Env> {
  const env = await newEnv(name, { SF_REVIEW: 'on', SF_GATE: 'codex', SF_CODEX: fakeCodex, ...extra });
  const repo = await newRepo(env, `${name}-repo`, false);
  if (scope === undefined) {
    await putTask(env, repo, T, 'Style the page');
  } else {
    const text = `---\nticket: ${T}\ntitle: Style the page\nbase: main\nscope: ${scope}\n---\n\n# ${T}: Style the page\n\nStyle the page.\n`;
    await writeTask({ name: 'app', readCheckout: repo, workCheckout: repo }, T, text, new JobStore(env.state));
  }
  return env;
}

async function say(env: Env, ...words: string[]): Promise<void> {
  const said = await runCli(env, ['say', 'app', T, ...words]);
  assert.equal(said.code, 0, said.stdout + said.stderr);
}

const store = (env: Env): JobStore => new JobStore(env.state);
const metaPath = (env: Env, iteration: number): string => join(store(env).iterationDir('app', T, iteration), 'meta.json');
const level = async (env: Env, iteration: number): Promise<{ ran: boolean; reasons: string[]; files: number | null; lines: number | null }> => (await store(env).readGateLevel('app', T, iteration))!;

test('DL-1 to DL-3: the first round reviews the whole Patch and sets clean; after sf say the round reviews the delta; the gate\'s major on an untouched file without a reason is dropped', async () => {
  const env = await deltaEnv('delta-say');
  await script(env, [FIRST, mrTurn, CSS_FIX, mrTurn]);
  await codexScript(env, [{ output: GATE_CLEAN }, { output: untouched('') }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: T });
    await waitFor(served, T, 'ready_for_human_review', 1);
    // DL-1: the whole Patch, no delta block; the clean round is the baseline.
    const [firstReview] = await reviewLog(env);
    assert.ok(firstReview!.prompt.includes('\n<patch>\ndiff --git a/src/app.css'), firstReview!.prompt);
    // The Handbook's review rules name the blocks in every prompt; the blocks themselves are absent.
    assert.ok(!firstReview!.prompt.includes('\n<delta_patch from=') && !firstReview!.prompt.includes('\n<accepted_change>\n'));
    const baseline = (await store(env).read('app', T))!.clean!;
    assert.deepEqual({ ...baseline, at: typeof baseline.at }, { iteration: 1, at: 'string', gate_fixes: 0 });

    await say(env, 'Make', 'the', 'colour', 'blue');
    await waitFor(served, T, 'ready_for_human_review', 2);
    // DL-2: both prompts hold the delta of the one changed file and the accepted change, not the whole Patch.
    const prompts = [(await reviewLog(env))[1]!.prompt, (await codexLog(env))[1]!.prompt];
    for (const prompt of prompts) {
      assert.ok(prompt.includes('<delta_patch from="1">\ndiff --git a/src/app.css b/src/app.css\n'), prompt);
      assert.ok(prompt.includes('-.a { color: red; }\n+.a { color: blue; }\n</delta_patch>'), prompt);
      assert.ok(!prompt.includes('<patch>') && !prompt.includes('+export const a = 1;'), prompt);
      assert.ok(prompt.includes('<accepted_change>\n- src/app.ts (added, +1 -0)\n- src/app.css (added, +1 -0)\n</accepted_change>') || prompt.includes('<accepted_change>\n- src/app.css (added, +1 -0)\n- src/app.ts (added, +1 -0)\n</accepted_change>'), prompt);
      assert.ok(prompt.includes('- The change was clean at iteration 1; judge the delta since then'), prompt);
    }
    const meta = await store(env).readMeta('app', T, 2);
    assert.deepEqual(meta.delta, {
      from: 1, from_tree: (await store(env).readMeta('app', T, 1)).commit_tree,
      files: [{ path: 'src/app.css', status: 'modified', sensitive: 'no', scope: 'none', additions: 1, deletions: 1 }],
    });
    const { at: _at, ...decided } = (await store(env).readGateLevel('app', T, 2))!;
    assert.deepEqual(decided, { level: 'light', ran: true, reasons: ['delta since iteration 1: 1 file, 2 lines', 'light: 1 file, 2 lines'], files: 1, lines: 2 });
    // DL-3: the gate's major on src/app.ts, outside the delta and without a reason, is dropped and visible.
    const gate = await store(env).readGate('app', T, 2);
    assert.ok(gate !== undefined && 'verdict' in gate);
    const item = { path: 'src/app.ts:1', problem: 'Spec: it exports 1.', expected: 'It exports 2.', severity: 'major', reopens: '', caused_by: '' };
    assert.deepEqual([gate.items, gate.dropped], [[item], [item]]);
    assert.deepEqual(await store(env).readLedger('app', T), []);
    const job = (await store(env).read('app', T))!;
    assert.deepEqual([job.fixes, job.gate_fixes, job.clean?.iteration], [0, 0, 2]);
  } finally {
    await stop(served);
  }
});

test('DL-4: the gate\'s major on an untouched file that the delta breaks is a Fix; the fix round keeps the baseline, and its light gate is skipped', async () => {
  const env = await deltaEnv('delta-broken');
  await script(env, [FIRST, mrTurn, CSS_FIX, turn({ 'src/app.ts': 'export const a = 2;\n' }, '| R1 | fixed | It exports 2. |'), mrTurn]);
  await codexScript(env, [{ output: GATE_CLEAN }, { output: untouched('broken_by_delta') }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: T });
    await waitFor(served, T, 'ready_for_human_review', 1);
    await say(env, 'Make', 'the', 'colour', 'blue');
    await waitFor(served, T, 'ready_for_human_review', 3);
    const gate = await store(env).readGate('app', T, 2);
    assert.ok(gate !== undefined && 'verdict' in gate && gate.dropped === undefined);
    assert.equal(gate.items[0]!.outside_delta, 'broken_by_delta');
    assert.deepEqual((await store(env).readLedger('app', T)).map((entry) => [entry.id, entry.path]), [['R1', 'src/app.ts:1']]);
    const job = (await store(env).read('app', T))!;
    assert.deepEqual([job.fixes, job.gate_fixes], [1, 1]);
    // The fix round's delta still counts from iteration 1, and the gate asked for a fix since: skipped.
    assert.equal((await store(env).readMeta('app', T, 3)).delta?.from, 1);
    assert.deepEqual((await level(env, 3)).reasons, ['delta since iteration 1: 2 files, 4 lines', LIGHT_SKIPPED]);
    assert.equal((await level(env, 3)).ran, false);
  } finally {
    await stop(served);
  }
});

test('DL-5: a delta touching a security-named file is gated full, and that file\'s whole section is in the prompt', async () => {
  const env = await deltaEnv('delta-security');
  await script(env, [
    turn({ 'src/app.ts': 'export const a = 1;\n', 'src/auth/token.ts': 'export const token = 1;\nexport const ttl = 60;\n' }), mrTurn,
    turn({ 'src/auth/token.ts': 'export const token = 2;\nexport const ttl = 60;\n' }), mrTurn,
  ]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: T });
    await waitFor(served, T, 'ready_for_human_review', 1);
    await say(env, 'Change', 'the', 'token');
    await waitFor(served, T, 'ready_for_human_review', 2);
    const decided = await level(env, 2);
    assert.deepEqual([decided.ran, decided.reasons], [true, ['delta since iteration 1: 1 file, 2 lines', 'security: src/auth/token.ts']]);
    for (const prompt of [(await reviewLog(env))[1]!.prompt, (await codexLog(env))[1]!.prompt]) {
      assert.ok(prompt.includes('<delta_patch from="1">\ndiff --git a/src/auth/token.ts b/src/auth/token.ts\n'), prompt);
      // The whole section: the file as the change adds it, the line the delta leaves alone too.
      assert.match(prompt, /<\/delta_patch>\n\n<patch>\ndiff --git a\/src\/auth\/token\.ts b\/src\/auth\/token\.ts\n(?:[^\n]*\n)*?\+export const token = 2;\n\+export const ttl = 60;\n<\/patch>/);
      assert.ok(prompt.includes('judged whole: src/auth/token.ts.'), prompt);
    }
  } finally {
    await stop(served);
  }
});

test('DL-8, DL-6, DL-10: after a gate fix before the clean round, a light delta round runs the gate; a baseline without commit_tree or with its tree gone is a whole round, gated from the baseline', async () => {
  const env = await deltaEnv('delta-after-fix');
  const gateFix = { verdict: 'fix', summary: 'Wrong.', items: [{ path: 'src/app.ts', problem: 'Spec: it exports 1.', expected: 'It exports 2.', severity: 'major' }], accepted_sensitive: [] };
  await script(env, [
    FIRST, turn({ 'src/app.ts': 'export const a = 2;\n' }, '| R1 | fixed | It exports 2. |'), mrTurn,
    CSS_FIX, mrTurn,
    turn({ 'src/app.css': '.a { color: green; }\n' }), mrTurn,
    turn({ 'src/app.css': '.a { color: navy; }\n' }), mrTurn,
  ]);
  await codexScript(env, [{ output: gateFix }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: T });
    await waitFor(served, T, 'ready_for_human_review', 2);
    assert.deepEqual((await level(env, 2)).reasons, [LIGHT_SKIPPED]);
    assert.deepEqual((await store(env).read('app', T))!.clean?.gate_fixes, 1);
    // DL-8: the light delta round after the baseline runs the gate though the job's gate_fixes is 1.
    await say(env, 'Make', 'it', 'blue');
    await waitFor(served, T, 'ready_for_human_review', 3);
    assert.deepEqual(await level(env, 3), { ...(await level(env, 3)), ran: true, reasons: ['delta since iteration 2: 1 file, 2 lines', 'light: 1 file, 2 lines'] });
    assert.equal((await codexLog(env)).length, 2);
    // DL-6: the baseline's meta.json without commit_tree: a whole round, its reason last; the gate runs.
    const third = JSON.parse(await readFile(metaPath(env, 3), 'utf8'));
    delete third.commit_tree;
    await writeFile(metaPath(env, 3), JSON.stringify(third));
    await say(env, 'Make', 'it', 'green');
    await waitFor(served, T, 'ready_for_human_review', 4);
    assert.deepEqual((await store(env).readMeta('app', T, 4)).delta, { from: 3, skipped: 'iteration 3 has no commit_tree' });
    assert.deepEqual([(await level(env, 4)).ran, (await level(env, 4)).reasons], [true, ['light: 2 files, 2 lines', 'whole change: iteration 3 has no commit_tree']]);
    const whole = (await reviewLog(env))[3]!.prompt;
    assert.ok(whole.includes('\n<patch>\n') && !whole.includes('\n<delta_patch from='), whole);
    // DL-10: the baseline's tree object is gone: the delta is skipped, the round whole.
    const fourth = JSON.parse(await readFile(metaPath(env, 4), 'utf8'));
    await writeFile(metaPath(env, 4), JSON.stringify({ ...fourth, commit_tree: 'b'.repeat(40) }));
    await say(env, 'Make', 'it', 'navy');
    await waitFor(served, T, 'ready_for_human_review', 5);
    const why = 'git could not compare the trees of iteration 4 and this iteration';
    assert.deepEqual((await store(env).readMeta('app', T, 5)).delta, { from: 4, skipped: why });
    assert.deepEqual([(await level(env, 5)).ran, (await level(env, 5)).reasons], [true, ['light: 2 files, 2 lines', `whole change: ${why}`]]);
    assert.equal((await codexLog(env)).length, 4);
  } finally {
    await stop(served);
  }
});

test('DL-10: a delta built at publish whose baseline tree is gone when its review runs again is recorded as skipped: the review is of the whole change and does not fail', async () => {
  const env = await deltaEnv('delta-gone-later');
  await script(env, [FIRST, mrTurn, CSS_FIX, mrTurn]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: T });
    await waitFor(served, T, 'ready_for_human_review', 1);
    // The delta round's first Claude review fails, so the review runs again on sf review, its gate
    // level and the gate's verdict kept: the reviewer is the first to meet the gone tree.
    await reviewScript(env, [{ noOutput: true }]);
    await say(env, 'Make', 'it', 'blue');
    assert.equal((await waitFor(served, T, 'needs_human', 2)).error.code, 'review_failed');
    const second = JSON.parse(await readFile(metaPath(env, 2), 'utf8'));
    assert.equal(second.delta.from, 1);
    await writeFile(metaPath(env, 2), JSON.stringify({ ...second, delta: { ...second.delta, from_tree: 'b'.repeat(40) } }));
    const retried = await runCli(env, ['review', 'app', T]);
    assert.equal(retried.code, 0, retried.stderr);
    const ready = await waitFor(served, T, 'ready_for_human_review', 2);
    assert.equal(ready.error, undefined);
    const why = 'git could not rebuild the delta from the trees of iteration 1 and this iteration';
    assert.deepEqual((await store(env).readMeta('app', T, 2)).delta, { from: 1, skipped: why });
    const whole = (await reviewLog(env)).at(-1)!.prompt;
    assert.ok(whole.includes('\n<patch>\ndiff --git a/src/app.css') && !whole.includes('\n<delta_patch from='), whole);
  } finally {
    await stop(served);
  }
});

test('DL-7: a path outside the scope accepted at the baseline and left alone by the delta needs no new acceptance: the delta round reaches ready_for_human_review', async () => {
  const env = await deltaEnv('delta-accepted', {}, '[src/app.ts, src/app.css]');
  await script(env, [turn({ 'src/app.ts': 'export const a = 1;\n', 'src/app.css': '.a { color: red; }\n', 'tools/extra.ts': 'export {};\n' }), mrTurn, CSS_FIX, mrTurn]);
  await reviewScript(env, [{ output: { ...CLAUDE_CLEAN, accepted_sensitive: ['tools/extra.ts'] } }, { output: CLAUDE_CLEAN }]);
  await codexScript(env, [{ output: { ...GATE_CLEAN, accepted_sensitive: ['tools/extra.ts'] } }, { output: GATE_CLEAN }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: T });
    await waitFor(served, T, 'ready_for_human_review', 1);
    await say(env, 'Make', 'it', 'blue');
    const ready = await waitFor(served, T, 'ready_for_human_review', 2);
    assert.equal(ready.error, undefined);
    const review = await store(env).readReview('app', T, 2);
    assert.ok(review !== undefined && 'verdict' in review);
    assert.deepEqual(review.accepted_sensitive, []);
    // The judged paths hold no marked path: the delta round's marked_paths are empty.
    assert.ok((await reviewLog(env))[1]!.prompt.includes('<marked_paths>\nNone.\n</marked_paths>'));
  } finally {
    await stop(served);
  }
});

test('DL-9: an Accept over a gate_rounds stop sets no clean: after sf say the round is whole', async () => {
  const env = await deltaEnv('delta-accept', { SF_GATE_MAX_ROUNDS: '1', SF_GATE_LEVEL: 'full' });
  const fix = (summary: string): Record<string, unknown> => ({ verdict: 'fix', summary, items: [{ path: 'src/app.ts', problem: `Spec: ${summary}`, expected: 'Right.', severity: 'major' }], accepted_sensitive: [] });
  await script(env, [FIRST, turn({ 'src/app.ts': 'export const a = 2;\n' }, '| R1 | fixed | Done. |'), mrTurn, CSS_FIX, mrTurn]);
  await codexScript(env, [{ output: fix('Wrong.') }, { output: fix('Still wrong.') }]);
  const served = await serve(env);
  try {
    await call(served, 'start', { workspace: 'app', ticket: T });
    assert.equal((await waitFor(served, T, 'needs_human', 2)).error.code, 'gate_rounds');
    const accepted = await runCli(env, ['accept', 'app', T]);
    assert.equal(accepted.code, 0, accepted.stderr);
    await waitFor(served, T, 'ready_for_human_review', 2);
    assert.equal((await store(env).read('app', T))!.clean, undefined);
    await say(env, 'Make', 'it', 'blue');
    await waitFor(served, T, 'ready_for_human_review', 3);
    assert.equal((await store(env).readMeta('app', T, 3)).delta, undefined);
    assert.deepEqual((await level(env, 3)).reasons, ['SF_GATE_LEVEL=full']);
    const prompt = (await reviewLog(env))[2]!.prompt;
    assert.ok(prompt.includes('\n<patch>\n') && !prompt.includes('\n<delta_patch from='), prompt);
  } finally {
    await stop(served);
  }
});
