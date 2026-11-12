// The reviewers' review method: the code-review skill's text in the prompt of the Claude review and
// of the Codex gate (reviewBody), read from SF_REVIEW_SKILL or the skills snapshot's copy, and the
// review_method of review.json and gate.json.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { gatePrompt } from '../src/gate.js';
import { handbookSection } from '../src/prompts.js';
import { MAX_REVIEW_METHOD_BYTES, readReviewMethod, reviewPrompt, REVIEW_METHOD_LINES } from '../src/review.js';
import { loadHandbook } from '../src/server.js';
import { syncSkills } from '../src/skills.js';
import { FAKE_SKILLS, newEnv, ownReviewMethod } from './support/harness.js';

const input = async () => ({ ticket: 'R-1', iteration: 1, task: 't', report: 'r', patch: Buffer.from('p'), patchTruncated: false, files: [], handbook: (await loadHandbook()).text });

async function tempFile(name: string, content: string | Buffer): Promise<string> {
  const dir = join(tmpdir(), `sf-review-method-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

test('the review method: the three lines and the adaptation lines, then the <review_method> block, before the Handbook\'s review rules', async () => {
  const base = await input();
  const prompt = reviewPrompt({ ...base, method: 'Two axes.\nSpec and Standards.' });
  for (const line of [
    'Follow the review method below (the user\'s code-review skill), adapted to this review: do not spawn sub-agents and do not ask for a fixed point or a spec. The fixed point is the base commit; the spec is the Task file and the user\'s messages; the standards are the documents the method names plus the rules below. Cover the Spec axis first, then the Standards axis.',
    'Begin each item\'s `problem` with `Spec:` or `Standards:`.',
    'A baseline smell is always a `nit`, never `major` or `blocker`. A breach of a documented standard or of the Task keeps the severities below.',
    'The change is the uncommitted worktree against the base commit (`git diff <base>`, or the Patch below), not `<fixed-point>...HEAD`; do not stop on an empty `...HEAD` diff.',
    'Answer only with the output schema: no `## Standards`/`## Spec` report, no word limits.',
    'Ignore the issue-tracker and setup instructions.',
  ]) {
    assert.ok(REVIEW_METHOD_LINES.some((own) => own.endsWith(line)), line);
  }
  const block = `${REVIEW_METHOD_LINES.join('\n')}\n<review_method>\nTwo axes.\nSpec and Standards.\n</review_method>\n\n`;
  const rules = handbookSection(base.handbook, '## Review rules');
  assert.ok(prompt.includes(`\n\n${block}${rules}\n`), prompt);
  // Everything else is as without it.
  assert.equal(prompt.replace(block, ''), reviewPrompt(base));
});

test('without a method, or with an empty one, the prompt is as before: no block, no method lines', async () => {
  const base = await input();
  const before = reviewPrompt(base);
  assert.equal(reviewPrompt({ ...base, method: '' }), before);
  assert.ok(!before.includes('<review_method>') && !before.includes('Spec:'));
});

test('the gate prompt and the Claude review prompt both carry the block', async () => {
  const base = { ...(await input()), method: 'The method.' };
  for (const prompt of [reviewPrompt(base), gatePrompt({ ...base, baseCommit: 'abc123' })]) {
    assert.ok(prompt.includes('\n<review_method>\nThe method.\n</review_method>\n'), prompt);
    assert.ok(prompt.includes(REVIEW_METHOD_LINES.join('\n')));
  }
});

test('readReviewMethod: the body without the front matter, the path and the sha256 of the raw file', async () => {
  const raw = '---\nname: code-review\ndescription: "Review: two axes"\n---\n\nTwo-axis review.\n\n## Process\n';
  const path = await tempFile('front.md', raw);
  assert.deepEqual(await readReviewMethod(path), {
    method: 'Two-axis review.\n\n## Process',
    review_method: { path, sha256: createHash('sha256').update(raw).digest('hex') },
  });
  // A file without a front matter is sent whole.
  const plain = await tempFile('plain.md', 'Just the method.\n');
  assert.equal((await readReviewMethod(plain)).method, 'Just the method.');
  // The skills snapshot's copy, read where SF_REVIEW_SKILL unset points: its body, not its name and description.
  const env = await newEnv('review-method-snapshot');
  await syncSkills(env.state);
  const skill = loadConfig({ SF_STATE_DIR: env.state }).reviewSkill!;
  const own = await readReviewMethod(skill);
  assert.equal(own.method, FAKE_SKILLS['code-review']);
  assert.deepEqual(own.review_method, await ownReviewMethod(env));
});

test('readReviewMethod: a file over 32 KB is cut at 32 KB with a line saying so', async () => {
  assert.equal(MAX_REVIEW_METHOD_BYTES, 32 * 1024);
  const raw = Buffer.from(`${'line of the method\n'.repeat(Math.ceil(40 * 1024 / 19))}`.slice(0, 40 * 1024));
  const path = await tempFile('long.md', raw);
  const { method: text, review_method: method } = await readReviewMethod(path);
  const note = `(The method is cut here: the file has ${raw.length} bytes, the prompt takes ${MAX_REVIEW_METHOD_BYTES}.)`;
  assert.ok(text.endsWith(`\n${note}`), text.slice(-200));
  const body = text.slice(0, -note.length - 1);
  assert.equal(Buffer.byteLength(body), MAX_REVIEW_METHOD_BYTES);
  assert.ok(raw.toString('utf8').startsWith(body));
  assert.deepEqual(method, { path, sha256: createHash('sha256').update(raw).digest('hex') });
});

test('readReviewMethod: none without a path, or with a missing or unreadable file', async () => {
  const none = { method: '', review_method: 'none' };
  assert.deepEqual(await readReviewMethod(undefined), none);
  assert.deepEqual(await readReviewMethod(join(tmpdir(), `sf-no-such-skill-${process.pid}.md`)), none);
  assert.deepEqual(await readReviewMethod(tmpdir()), none);
});

test('SF_REVIEW_SKILL: unset, the skills snapshot\'s code-review; empty, none; a path, that path', () => {
  assert.equal(loadConfig({ SF_STATE_DIR: '/state' }).reviewSkill, '/state/skills/code-review/SKILL.md');
  assert.equal(loadConfig({ SF_REVIEW_SKILL: '' }).reviewSkill, undefined);
  assert.equal(loadConfig({ SF_REVIEW_SKILL: '/srv/skills/review.md' }).reviewSkill, '/srv/skills/review.md');
});
