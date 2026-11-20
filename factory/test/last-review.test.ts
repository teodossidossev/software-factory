// The last review's parts that run without a session: the comments the factory keeps of an answer,
// the copy, hash and text of the skill folder, the prompt, the output schema, the redaction of the
// answer, the records in the job directory and the sf watch lines of its event.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { JobStore } from '../src/jobs.js';
import {
  copySkill, LAST_REVIEW_SCHEMA, LAST_REVIEWER, type LastReviewOutput, type LastReviewRecord, lastReviewComments, lastReviewOutput, lastReviewPrompt, MAX_COMMENT_CHARS,
  MAX_COMMENTS, MAX_SUMMARY_CHARS, skillMethod, skillSha256,
} from '../src/last-review.js';
import { Redactor } from '../src/redact.js';
import { MAX_REVIEW_PATCH_BYTES } from '../src/review.js';
import { formatEvent } from '../src/watch.js';

let temp: string;

before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sf-last-review-'));
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

let folders = 0;
// A new folder holding the given files (relative path: content).
async function folder(files: Record<string, string | Buffer>): Promise<string> {
  folders += 1;
  const dir = join(temp, `skill-${folders}`);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

const SKILL = '---\nname: senior-review\ndescription: Review like a senior.\n---\n\nAsk why first.\n';
const CHECKLIST = '# Checklist\n\n- Is it needed?\n';

const comment = (index: number, extra: Partial<LastReviewOutput['comments'][number]> = {}): LastReviewOutput['comments'][number] => ({
  path: `src/f${index}.ts`, line: index + 1, text: `Why ${index}?`, kind: 'question', ...extra,
});

test('LR1-1 lastReviewComments: the first 30 comments with ids C1…C30, the rest dropped, a long text cut with …, a leading ./ stripped', () => {
  const comments = Array.from({ length: 32 }, (_, index) => comment(index));
  comments[0] = comment(0, { path: './src/a.ts', text: 'x'.repeat(MAX_COMMENT_CHARS + 1) });
  comments[1] = comment(1, { path: '/src/b.ts' });
  const kept = lastReviewComments({ summary: 'Fine.', comments });
  assert.equal(kept.comments.length, MAX_COMMENTS);
  assert.deepEqual(kept.comments.map((item) => item.id), Array.from({ length: 30 }, (_, index) => `C${index + 1}`));
  assert.equal(kept.dropped, 2);
  assert.equal(kept.comments[0]!.path, 'src/a.ts');
  assert.equal(kept.comments[1]!.path, 'src/b.ts');
  assert.equal(kept.comments[0]!.text.length, MAX_COMMENT_CHARS);
  assert.ok(kept.comments[0]!.text.endsWith('…'));
  assert.deepEqual(kept.comments[2], { id: 'C3', path: 'src/f2.ts', line: 3, text: 'Why 2?', kind: 'question' });
  assert.equal(kept.summary, 'Fine.');
});

test('LR1-1 lastReviewComments: the summary is cut at 2000 characters, never splitting a surrogate pair', () => {
  const summary = `${'a'.repeat(MAX_SUMMARY_CHARS - 2)}😀${'b'.repeat(10)}`;
  const kept = lastReviewComments({ summary, comments: [comment(0, { text: 'short' })] });
  assert.equal(kept.summary, `${'a'.repeat(MAX_SUMMARY_CHARS - 2)}…`);
  assert.equal(kept.comments[0]!.text, 'short');
  assert.equal(kept.dropped, 0);
});

test('LR1-2 copySkill: copies SKILL.md and CHECKLIST.md, skips a symbolic link and a .hidden file; the hash is the copy\'s, stable, and changes with a byte', async () => {
  const source = await folder({ 'SKILL.md': SKILL, 'CHECKLIST.md': CHECKLIST, '.hidden': 'secret', '.git/config': 'x' });
  await symlink(join(source, 'CHECKLIST.md'), join(source, 'link.md'));
  const dest = join(temp, 'copy-1', 'last-review-skill');
  await mkdir(join(temp, 'copy-1'));
  const copy = await copySkill(source, dest);
  assert.deepEqual((await readdir(dest)).sort(), ['CHECKLIST.md', 'SKILL.md']);
  assert.deepEqual(await readdir(join(temp, 'copy-1')), ['last-review-skill']);
  assert.deepEqual(copy, { path: source, sha256: await skillSha256(dest), files: 2 });
  assert.match(copy.sha256, /^[0-9a-f]{64}$/);
  const again = await copySkill(source, join(temp, 'copy-2'));
  assert.equal(again.sha256, copy.sha256);
  await writeFile(join(source, 'CHECKLIST.md'), CHECKLIST.replace('needed', 'needee'));
  assert.notEqual((await copySkill(source, join(temp, 'copy-3'))).sha256, copy.sha256);
  const renamed = await folder({ 'SKILL.md': SKILL, 'CHECKLIS.md': CHECKLIST });
  assert.notEqual(await skillSha256(renamed), copy.sha256);
});

test('LR1-2 copySkill: copies a nested file and replaces a copy already at dest', async () => {
  const source = await folder({ 'SKILL.md': SKILL, 'refs/deep.md': 'Deep.' });
  const dest = join(temp, 'copy-nested', 'last-review-skill');
  await mkdir(join(dest, 'stale'), { recursive: true });
  const copy = await copySkill(source, dest);
  assert.deepEqual((await readdir(dest)).sort(), ['SKILL.md', 'refs']);
  assert.deepEqual(await readdir(join(temp, 'copy-nested')), ['last-review-skill']);
  assert.equal(copy.files, 2);
});

test('LR1-3 copySkill: refuses a folder without SKILL.md, one with 51 files, and one it cannot read, leaving nothing at dest', async () => {
  const refused = async (source: string, message: string): Promise<void> => {
    const parent = join(temp, `refused-${folders}`);
    await mkdir(parent, { recursive: true });
    const dest = join(parent, 'last-review-skill');
    await assert.rejects(copySkill(source, dest), (error: unknown) => error instanceof FactoryError && error.code === 'last_review_skill' && error.message === message);
    assert.deepEqual(await readdir(parent), []);
  };
  const empty = await folder({ 'README.md': 'No skill.' });
  await refused(empty, `The last review's skill folder ${empty} has no SKILL.md.`);
  const linked = await folder({ 'other.md': SKILL });
  await symlink(join(linked, 'other.md'), join(linked, 'SKILL.md'));
  await refused(linked, `The last review's skill folder ${linked} has no SKILL.md.`);
  const many = await folder(Object.fromEntries([['SKILL.md', SKILL], ...Array.from({ length: 50 }, (_, index) => [`f${index}.md`, 'x'])]));
  await refused(many, `The last review's skill folder ${many} holds more than 50 files or 512 KiB.`);
  const big = await folder({ 'SKILL.md': SKILL, 'big.md': 'x'.repeat(512 * 1024) });
  await refused(big, `The last review's skill folder ${big} holds more than 50 files or 512 KiB.`);
  const target = await folder({ 'SKILL.md': SKILL });
  const linkedSource = join(temp, 'linked-source');
  await symlink(target, linkedSource);
  for (const source of [linkedSource, `${linkedSource}/`]) {
    const linkParent = join(temp, `refused-link-${source.length}`);
    await mkdir(linkParent);
    await assert.rejects(copySkill(source, join(linkParent, 'dest')), (error: unknown) => error instanceof FactoryError && error.code === 'last_review_skill'
      && error.message === `The last review's skill folder ${source} could not be read: ${linkedSource} is a symbolic link.`);
    assert.deepEqual(await readdir(linkParent), []);
  }
  const missing = join(temp, 'no-such-folder');
  const parent = join(temp, 'refused-missing');
  await mkdir(parent);
  await assert.rejects(copySkill(missing, join(parent, 'dest')), (error: unknown) => error instanceof FactoryError && error.code === 'last_review_skill'
    && error.message.startsWith(`The last review's skill folder ${missing} could not be read: `) && error.message.endsWith('.'));
  assert.deepEqual(await readdir(parent), []);
});

test('LR1-4 skillMethod: SKILL.md\'s body without its front matter, then CHECKLIST.md in a skill_file block; a file with a NUL byte or not UTF-8 is omitted', async () => {
  const dir = await folder({ 'SKILL.md': SKILL, 'CHECKLIST.md': CHECKLIST, 'bin.dat': Buffer.from([0x61, 0x00, 0x62]), 'latin.txt': Buffer.from([0xe9]) });
  const method = await skillMethod(dir);
  assert.equal(method.text, `Ask why first.\n\n<skill_file path="CHECKLIST.md">\n${CHECKLIST.trimEnd()}\n</skill_file>`);
  assert.deepEqual(method.omitted, ['bin.dat', 'latin.txt']);
});

test('LR1-4 skillMethod: a file that would pass 64 KiB is omitted and later files are still tried', async () => {
  const dir = await folder({ 'SKILL.md': 'Method.', 'a.md': 'x'.repeat(64 * 1024), 'b.md': 'Small.' });
  const method = await skillMethod(dir);
  assert.deepEqual(method.omitted, ['a.md']);
  assert.match(method.text, /<skill_file path="b\.md">\nSmall\.\n<\/skill_file>$/);
});

const PROMPT_LINES = [
  'Last review of ticket T-1, iteration 3: its reviewers found the change clean. You read; you change nothing.',
  "The current directory is the job's worktree: it holds the change, not committed. The factory may commit and rebase it while you read: take each line number from the Patch below (its + side), not from the files. Your tools are Read, Grep and Glob; nothing else is available.",
  "Review the change the way the review method below says. Your comments are advice for the user, who chooses which go to the change's author; none of them blocks the change.",
  '- Do not spawn sub-agents and ask nothing. Where the method says to run a command or to read a diff, read the Patch and the files instead.',
  '- Each comment: the path, the line of the file as the change leaves it (1 for the whole file), the text, and its kind: change (ask for a change), question (ask why), follow_up (worth a later ticket, not this change).',
  '- summary: one note on the whole change. No comment is a good answer when nothing stands out.',
  '- Answer only with the output schema.',
];

test('LR1-5 lastReviewPrompt: the lines in order, the method with its omitted files, the Task file, the Patch', () => {
  const prompt = lastReviewPrompt({
    ticket: 'T-1', iteration: 3, task: '# T-1: Greet\n', patch: Buffer.from('diff --git a/a b/a\n+x\n'), patchTruncated: false, method: { text: 'Ask why first.', omitted: ['bin.dat', 'big.md'] },
  });
  assert.ok(prompt.startsWith(`${PROMPT_LINES.join('\n')}\n\n`));
  assert.ok(prompt.includes('\n\n<review_method>\nAsk why first.\n(Left out of the method, over 64 KiB or not text: bin.dat, big.md.)\n</review_method>\n'));
  assert.ok(prompt.includes('\n\n<task_file path=".software-factory/T-1.md">\n# T-1: Greet\n</task_file>\n'));
  assert.ok(prompt.endsWith('\n\n<patch>\ndiff --git a/a b/a\n+x\n</patch>'));
  assert.ok(!prompt.includes('Note:'));
  const plain = lastReviewPrompt({ ticket: 'T-1', iteration: 3, task: 'x', patch: Buffer.from('p'), patchTruncated: false, method: { text: 'M.', omitted: [] } });
  assert.ok(plain.includes('<review_method>\nM.\n</review_method>'));
  assert.ok(!plain.includes('Left out'));
});

test('LR1-5 lastReviewPrompt: a Patch over the inline limit is cut with the notes simplifyPrompt writes', () => {
  const patch = Buffer.from(`${'a'.repeat(MAX_REVIEW_PATCH_BYTES)}TAIL`);
  const prompt = lastReviewPrompt({ ticket: 'T-1', iteration: 1, task: 'x', patch, patchTruncated: true, method: { text: 'M.', omitted: [] } });
  assert.ok(prompt.includes(`Note: The Patch has ${patch.length} bytes; only the first ${MAX_REVIEW_PATCH_BYTES} are below. Read the changed files in the worktree for the rest.\n`
    + 'Note: The published Patch was cut at its size limit. Read the changed files in the worktree for the rest.\n<patch>\n'));
  assert.ok(!prompt.includes('TAIL'));
});

test('LR1-6 LAST_REVIEW_SCHEMA has no $schema and requires summary and comments; the output refuses another kind and a line of 0', () => {
  assert.equal('$schema' in LAST_REVIEW_SCHEMA, false);
  assert.deepEqual([...(LAST_REVIEW_SCHEMA.required as string[])].sort(), ['comments', 'summary']);
  const valid = { summary: 'S.', comments: [{ path: 'a.ts', line: 1, text: 'Why?', kind: 'follow_up' }] };
  assert.equal(lastReviewOutput.safeParse(valid).success, true);
  assert.equal(lastReviewOutput.safeParse({ ...valid, comments: [{ ...valid.comments[0], kind: 'nit' }] }).success, false);
  assert.equal(lastReviewOutput.safeParse({ ...valid, comments: [{ ...valid.comments[0], line: 0 }] }).success, false);
});

test('LR1-7 Redactor.output redacts a secret in a comment\'s text and the summary, keeping path, line and kind', () => {
  const secret = 'opaque-value-1234567890';
  const redactor = new Redactor({ cwd: '/work/tree', env: { API_TOKEN: secret }, home: '/home/alice' });
  const output: LastReviewOutput = { summary: `Leaks ${secret}.`, comments: [{ path: 'src/a.ts', line: 4, text: `Why ${secret} here?`, kind: 'change' }] };
  assert.deepEqual(redactor.output(output), { summary: 'Leaks [redacted].', comments: [{ path: 'src/a.ts', line: 4, text: 'Why [redacted] here?', kind: 'change' }] });
});

test('LR1-8 the last review\'s record and the skill copy\'s record round-trip; none is undefined', async () => {
  const jobs = new JobStore(join(temp, 'state'));
  await mkdir(jobs.iterationDir('ws', 'T-1', 2), { recursive: true });
  const skill = { path: '/srv/skills/review', sha256: 'a'.repeat(64), files: 2 };
  const record: LastReviewRecord = {
    reviewer: LAST_REVIEWER, summary: 'S.', comments: [{ id: 'C1', path: 'a.ts', line: 1, text: 'Why?', kind: 'question' }], dropped: 0, skill,
    cost_usd: 0.12, model: 'claude-opus', started_at: '2026-11-20T10:00:00.000Z', ended_at: '2026-11-20T10:01:00.000Z',
  };
  assert.equal(await jobs.readLastReview('ws', 'T-1', 2), undefined);
  await jobs.writeLastReview('ws', 'T-1', 2, record);
  assert.deepEqual(await jobs.readLastReview('ws', 'T-1', 2), record);
  const failed: LastReviewRecord = { reviewer: LAST_REVIEWER, error: 'Timed out.', timed_out: true, skill: null, started_at: record.started_at, ended_at: record.ended_at };
  await jobs.writeLastReview('ws', 'T-1', 2, failed);
  assert.deepEqual(await jobs.readLastReview('ws', 'T-1', 2), failed);
  assert.equal(jobs.lastReviewSkillDir('ws', 'T-1'), join(temp, 'state', 'jobs', 'ws', 'T-1', 'last-review-skill'));
  assert.equal(await jobs.readLastReviewSkill('ws', 'T-1'), undefined);
  await jobs.writeLastReviewSkill('ws', 'T-1', skill);
  assert.deepEqual(await jobs.readLastReviewSkill('ws', 'T-1'), skill);
  const file = join(temp, 'state', 'jobs', 'ws', 'T-1', 'last-review-skill.json');
  await writeFile(file, 'not json');
  assert.equal(await jobs.readLastReviewSkill('ws', 'T-1'), undefined);
  await writeFile(file, JSON.stringify({ path: '/x', files: 2 }));
  assert.equal(await jobs.readLastReviewSkill('ws', 'T-1'), undefined);
});

test('LR1-9 formatEvent of a last_review event: its comments, its error, its time limit, ignored', () => {
  const line = (event: Record<string, unknown>): string => formatEvent(JSON.stringify({ ts: '2026-11-20T10:00:00.000Z', iteration: 2, type: 'last_review', ...event }))[0]!.replace(/^\S+ /, '');
  assert.equal(line({ comments: 2 }), '[2] last review: 2 comments');
  assert.equal(line({ comments: 1 }), '[2] last review: 1 comment');
  assert.equal(line({ comments: 0 }), '[2] last review: 0 comments');
  assert.equal(line({ comments: 0, error: 'The last review session failed:\n  boom' }), '[2] last review failed: The last review session failed: boom');
  assert.equal(line({ comments: 0, error: 'aborted', timed_out: true }), '[2] last review timed out after 10 minutes');
  assert.equal(line({ comments: 3, ignored: true }), '[2] last review: 3 comments (ignored: the job had moved on)');
  assert.equal(line({ comments: 0, error: 'boom', ignored: true }), '[2] last review failed: boom (ignored: the job had moved on)');
});
