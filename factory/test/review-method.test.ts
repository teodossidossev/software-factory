// The reviewers' review method: the code-review skill's text in the prompt of the Claude review and
// of the Codex gate (reviewBody), read from SF_REVIEW_SKILL or the skills snapshot's copy, and the
// review_method of review.json and gate.json.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { gatePrompt } from '../src/gate.js';
import { handbookSection } from '../src/prompts.js';
import { firstPrompt } from '../src/execution.js';
import { implementCommand } from '../src/execution/prompts.js';
import { decide, MAX_REVIEW_METHOD_BYTES, readReviewMethod, reviewerSkills, reviewOutput, reviewPrompt, REVIEW_METHOD_LINES } from '../src/review.js';
import { loadHandbook, servedHandbook } from '../src/server.js';
import { rolesOf, writeRoles } from '../src/skill-roles.js';
import { MAX_SKILL_BLOCKS_BYTES, planSkills, planWarning, SKILL_BLOCKS_LINE, syncSkills } from '../src/skills.js';
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
    'Begin each item\'s `problem` with `Spec:`, `Standards:` or `Decision:`.',
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

test('an item whose problem begins `Decision:` is accepted and acted on as one that begins `Spec:` or `Standards:`', () => {
  for (const lead of ['Spec:', 'Standards:', 'Decision:']) {
    const item = { path: 'src/a.ts', problem: `${lead} the reader is called a visitor; GLOSSARY.md#Reader says "A reader is a signed-in user."`, expected: 'Call them readers.', severity: 'major' };
    const output = reviewOutput.parse({ verdict: 'fix', summary: 'One item.\nFor the user: may a guest read?', items: [item], accepted_sensitive: [] });
    assert.deepEqual(decide(output, []), { verdict: 'fix', items: [{ ...item, reopens: '', caused_by: '' }] });
  }
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

test('a reviewer\'s skills: the method only with code-review chosen; each other skill a <skill> block in the gate\'s prompt; over 64 KiB named, not included; SF_REVIEW_SKILL set wins', async () => {
  const env = await newEnv('review-method-roles');
  await syncSkills(env.state);
  const reviewSkill = loadConfig({ SF_STATE_DIR: env.state }).reviewSkill;
  // A job pinned to the snapshot's current folder with codex_gate's list.
  const job = (list: string[], folder = join(env.state, 'skills')) => ({ folder, roles: { claude_review: [], codex_gate: list } });
  const reviewerSkillsOf = (list: string[], skill = reviewSkill, folder?: string, set = false) => reviewerSkills(job(list, folder), 'codex_gate', skill, set);
  // codex_gate with []: no method, no block, nothing recorded but the method.
  const none = await reviewerSkillsOf([]);
  assert.deepEqual([none.method, none.skillBlocks, none.recorded], ['', '', { review_method: 'none' }]);
  const plain = gatePrompt({ ...(await input()), ...none, baseCommit: 'abc123' });
  assert.ok(!plain.includes('<review_method>') && !plain.includes('<skill '), plain);
  // The default, [code-review]: the method, and the record as before (no names).
  assert.deepEqual((await reviewerSkillsOf(['code-review'])).recorded, { review_method: await ownReviewMethod(env) });
  // [code-review, grilling]: the method and one <skill name="grilling"> block after it.
  const both = await reviewerSkillsOf(['code-review', 'grilling']);
  assert.deepEqual(both.recorded, { review_method: await ownReviewMethod(env), skills: ['grilling'], skills_omitted: [] });
  const prompt = gatePrompt({ ...(await input()), ...both, baseCommit: 'abc123' });
  assert.equal(prompt.split('<skill name=').length - 1, 1, prompt);
  const block = `${SKILL_BLOCKS_LINE}\n<skill name="grilling">\n---\nname: grilling\ndescription: The fake grilling skill\n---\n\n${FAKE_SKILLS.grilling}\n</skill>\n`;
  assert.ok(prompt.includes(`</review_method>\n\n${block}`), prompt);
  // A job pinned to a folder the link no longer names: after its start the link keeps code-review but
  // changes it, and loses grilling; the job's reviewer still reads both as they were at its start.
  const pinned = join(env.state, 'skills.d', 'pinned');
  await cp(await realpath(join(env.state, 'skills')), pinned, { recursive: true });
  await writeFile(join(env.state, 'skills', 'code-review', 'SKILL.md'), '---\nname: code-review\n---\n\nA changed method.\n');
  await rm(join(env.state, 'skills', 'grilling'), { recursive: true });
  const kept = await reviewerSkillsOf(['code-review', 'grilling'], reviewSkill, pinned);
  assert.equal(kept.method, FAKE_SKILLS['code-review']);
  assert.ok(kept.skillBlocks.includes(FAKE_SKILLS.grilling!));
  assert.deepEqual(kept.recorded, { review_method: { ...(await ownReviewMethod(env)), path: join(pinned, 'code-review', 'SKILL.md') }, skills: ['grilling'], skills_omitted: [] });
  // A job pinned to the link itself (none recorded) reads the link's copy as it is now.
  assert.equal((await reviewerSkillsOf(['code-review'])).method, 'A changed method.');
  // A skill over the limit: named, not included; the later ones still tried.
  await writeFile(join(env.state, 'skills', 'implement', 'SKILL.md'), 'x'.repeat(MAX_SKILL_BLOCKS_BYTES));
  const over = await reviewerSkillsOf(['implement', 'tdd']);
  assert.deepEqual(over.recorded, { review_method: 'none', skills: ['tdd'], skills_omitted: ['implement'] });
  assert.ok(!over.skillBlocks.includes('<skill name="implement">') && over.skillBlocks.includes('<skill name="tdd">'));
  // SF_REVIEW_SKILL set: its file is the method whatever the role chose.
  const own = await tempFile('own-method.md', 'My own method.\n');
  assert.equal((await reviewerSkillsOf([], own, undefined, true)).method, 'My own method.');
});

test('the planner\'s method: each chosen skill\'s body in the file\'s order; none chosen: the Quick start alone, with its warning', async () => {
  const env = await newEnv('plan-roles');
  await syncSkills(env.state);
  const saved = process.env.SF_PLAN_SKILL;
  delete process.env.SF_PLAN_SKILL;
  try {
    await writeRoles(env.state, { ...rolesOf(undefined), planner: ['tdd', 'grilling'] });
    assert.deepEqual(await planSkills(env.state), { planSkill: `${FAKE_SKILLS.tdd}\n\n${FAKE_SKILLS.grilling}`, planMissing: [] });
    await writeRoles(env.state, { ...rolesOf(undefined), planner: [] });
    const handbook = { ...(await loadHandbook()), ...(await planSkills(env.state)) };
    assert.equal(handbook.planSkill, undefined);
    assert.deepEqual(servedHandbook(handbook), { instructions: handbook.quickStart, guide: handbook.text });
    assert.equal(planWarning(handbook), 'warning: the planner role has no skill (sf skills set planner <skill> on); the instructions are the Quick start alone');
    await writeRoles(env.state, { ...rolesOf(undefined), planner: ['grilling', 'gone'] });
    const partly = await planSkills(env.state);
    assert.deepEqual(partly, { planSkill: FAKE_SKILLS.grilling, planMissing: [join(env.state, 'skills', 'gone', 'SKILL.md')] });
    assert.match(planWarning(partly)!, /^warning: no planning skill at .*gone\/SKILL\.md; the method is the other skills$/);
  } finally {
    if (saved !== undefined) {
      process.env.SF_PLAN_SKILL = saved;
    }
  }
});

test('the Implementer\'s command: /implement of the Task file when it has implement; else the Task file\'s path alone', () => {
  assert.equal(implementCommand('T-1', ['implement', 'tdd']), '/implement .software-factory/T-1.md');
  assert.equal(implementCommand('T-1', ['implement'], 2), '/implement .software-factory/T-1.md Fix 2');
  assert.equal(implementCommand('T-1', ['tdd'], 2), '.software-factory/T-1.md Fix 2');
  assert.equal(firstPrompt('T-1', [], '<rules>\nR\n</rules>', []), '.software-factory/T-1.md\n\n<rules>\nR\n</rules>');
  assert.equal(firstPrompt('T-1', []), '/implement .software-factory/T-1.md');
});

test('SF_REVIEW_SKILL set to the snapshot\'s own code-review path still wins for a reviewer whose role has no code-review; unset, that reviewer has no method', async () => {
  const env = await newEnv('review-method-override');
  await syncSkills(env.state);
  const job = { folder: join(env.state, 'skills'), roles: { claude_review: [], codex_gate: ['grilling'] } };
  const set = loadConfig({ SF_STATE_DIR: env.state, SF_REVIEW_SKILL: join(env.state, 'skills', 'code-review', 'SKILL.md') });
  assert.equal(set.reviewSkillSet, true);
  for (const role of ['claude_review', 'codex_gate'] as const) {
    const skills = await reviewerSkills(job, role, set.reviewSkill, set.reviewSkillSet);
    assert.equal(skills.method, FAKE_SKILLS['code-review'], role);
    assert.deepEqual(skills.recorded.review_method, await ownReviewMethod(env), role);
  }
  // The same path, not set: the default, which the role's choice decides.
  const unset = loadConfig({ SF_STATE_DIR: env.state });
  assert.equal(unset.reviewSkill, set.reviewSkill);
  assert.equal(unset.reviewSkillSet, false);
  assert.deepEqual((await reviewerSkills(job, 'codex_gate', unset.reviewSkill, unset.reviewSkillSet)).recorded, { review_method: 'none', skills: ['grilling'], skills_omitted: [] });
  // Set empty: no method for either reviewer, whatever their roles.
  const empty = loadConfig({ SF_STATE_DIR: env.state, SF_REVIEW_SKILL: '' });
  assert.equal((await reviewerSkills({ ...job, roles: { claude_review: ['code-review'], codex_gate: [] } }, 'claude_review', empty.reviewSkill, empty.reviewSkillSet)).method, '');
});

test('SF_REVIEW_SKILL: unset, the skills snapshot\'s code-review; empty, none; a path, that path', () => {
  assert.equal(loadConfig({ SF_STATE_DIR: '/state' }).reviewSkill, '/state/skills/code-review/SKILL.md');
  assert.equal(loadConfig({ SF_REVIEW_SKILL: '' }).reviewSkill, undefined);
  assert.equal(loadConfig({ SF_REVIEW_SKILL: '/srv/skills/review.md' }).reviewSkill, '/srv/skills/review.md');
});
