// The agents' skills (src/skills.ts): the user's installed ones, copied verbatim into a snapshot
// under the state directory when the lock file's hashes change, never edited, swapped whole.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { saveRegistry } from '../src/registry.js';
import { chosenSkills, rolesOf, writeRoles } from '../src/skill-roles.js';
import {
  implementerSkills, jobSkills, MAX_SKILL_BLOCKS_BYTES, MAX_SKILL_TEXT_BYTES, recordSkills, setRoleSkills, skillBlocks, type SkillsEvent, skillsForClients, skillsLines, skillsSnapshot, skillsSource,
  skillsText, skillsView, skillText, switchSkill, syncSkills,
} from '../src/skills.js';

// Every role's default list, and the skills they choose together: what the snapshot holds without a choice.
const DEFAULT_ROLES = rolesOf(undefined);
const AGENT_SKILLS = chosenSkills(DEFAULT_ROLES);

// A fake installation: <root>/agents/skills/<name>/ and <root>/agents/.skill-lock.json, every
// listed skill at hash <name>-1 with a SKILL.md and a nested file; the state directory <root>/state.
async function fixture(name: string): Promise<{ root: string; source: string; state: string; env: NodeJS.ProcessEnv; lock: (hashes: Record<string, string>) => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `sf-skills-${name}-`));
  const source = join(root, 'agents', 'skills');
  for (const skill of AGENT_SKILLS) {
    await mkdir(join(source, skill, 'docs'), { recursive: true });
    await writeFile(join(source, skill, 'SKILL.md'), `---\nname: ${skill}\n---\nThe ${skill} method.\n`);
    await writeFile(join(source, skill, 'docs', 'more.md'), Buffer.from([0, 1, 2, 255, 10]));
  }
  const lock = (hashes: Record<string, string>) => writeFile(join(root, 'agents', '.skill-lock.json'), JSON.stringify({ version: 3, skills: Object.fromEntries(Object.entries(hashes).map(([skill, hash]) => [skill, { skillFolderHash: hash, source: 'x' }])) }));
  await lock(Object.fromEntries(AGENT_SKILLS.map((skill) => [skill, `${skill}-1`])));
  // SF_CONFIG_DIR: the coordinator's column reads a registry, this temp one (none: no coordinator workspace).
  return { root, source, state: join(root, 'state'), env: { HOME: join(root, 'home'), SF_SKILLS_DIR: source, SF_CONFIG_DIR: join(root, 'config') }, lock };
}

const snapshotFile = (state: string, ...path: string[]): Promise<string> => readFile(join(skillsSnapshot(state), ...path), 'utf8');
const versionsOf = async (state: string): Promise<unknown> => JSON.parse(await snapshotFile(state, 'versions.json'));
const allAt = (n: number): Record<string, string> => Object.fromEntries(AGENT_SKILLS.map((skill) => [skill, `${skill}-${n}`]));
// A sync's versions and missing skills, without the pair of choice and folder it also returns.
async function synced(state: string, env: NodeJS.ProcessEnv): Promise<{ versions: Record<string, string>; missing: string[] }> {
  const { versions, missing } = await syncSkills(state, env);
  return { versions, missing };
}

test('the source: ~/.agents/skills and ~/.agents/.skill-lock.json; SF_SKILLS_DIR overrides the folder, the lock file next to it', () => {
  assert.deepEqual(AGENT_SKILLS, ['implement', 'tdd', 'code-review', 'grilling', 'prototype']);
  assert.deepEqual(DEFAULT_ROLES, { implementer: ['implement', 'tdd', 'code-review', 'grilling'], claude_review: ['code-review'], codex_gate: ['code-review'], task_check: [], planner: ['grilling', 'prototype'] });
  assert.deepEqual(skillsSource({ HOME: '/h' }), { dir: '/h/.agents/skills', lock: '/h/.agents/.skill-lock.json' });
  assert.deepEqual(skillsSource({ HOME: '/h', SF_SKILLS_DIR: '/srv/mine/skills' }), { dir: '/srv/mine/skills', lock: '/srv/mine/.skill-lock.json' });
  assert.equal(skillsSnapshot('/state'), '/state/skills');
});

test('the first sync copies every listed skill byte for byte, with versions.json, behind the skills link', async () => {
  const { source, state, env } = await fixture('first');
  await mkdir(join(source, 'other'));
  assert.deepEqual(await synced(state, env), { versions: allAt(1), missing: [] });
  assert.ok((await lstat(skillsSnapshot(state))).isSymbolicLink());
  assert.match(await readlink(skillsSnapshot(state)), /^skills\.d\/[^/]+$/);
  assert.deepEqual((await readdir(skillsSnapshot(state))).sort(), [...AGENT_SKILLS, 'versions.json'].sort());
  for (const skill of AGENT_SKILLS) {
    assert.deepEqual(await readFile(join(skillsSnapshot(state), skill, 'SKILL.md')), await readFile(join(source, skill, 'SKILL.md')));
    assert.deepEqual(await readFile(join(skillsSnapshot(state), skill, 'docs', 'more.md')), Buffer.from([0, 1, 2, 255, 10]));
  }
  assert.deepEqual(await versionsOf(state), allAt(1));
});

test('the same hashes copy nothing: the link and its folder stay, even with the source\'s files changed', async () => {
  const { source, state, env } = await fixture('same');
  await syncSkills(state, env);
  const link = await readlink(skillsSnapshot(state));
  await writeFile(join(source, 'tdd', 'SKILL.md'), 'edited without a new hash\n');
  assert.deepEqual(await synced(state, env), { versions: allAt(1), missing: [] });
  assert.equal(await readlink(skillsSnapshot(state)), link);
  assert.deepEqual(await readdir(join(state, 'skills.d')), [link.slice('skills.d/'.length)]);
  assert.match(await snapshotFile(state, 'tdd', 'SKILL.md'), /The tdd method/);
});

test('one changed hash copies that skill only, whole: a file removed in the source is gone; the others are the previous copy, untouched; the old folder stays, however long it was current', async () => {
  const { source, state, env, lock } = await fixture('one');
  await syncSkills(state, env);
  const before = await readlink(skillsSnapshot(state));
  // Current for weeks before the update: a session started on it may still bind it.
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  await utimes(join(state, before), old, old);
  await rm(join(source, 'tdd', 'docs'), { recursive: true });
  await writeFile(join(source, 'tdd', 'SKILL.md'), 'tdd v2\n');
  // A source change without a new hash is not taken.
  await writeFile(join(source, 'grilling', 'SKILL.md'), 'grilling edited\n');
  await lock({ ...allAt(1), tdd: 'tdd-2' });
  assert.deepEqual(await synced(state, env), { versions: { ...allAt(1), tdd: 'tdd-2' }, missing: [] });
  assert.notEqual(await readlink(skillsSnapshot(state)), before);
  assert.equal(await snapshotFile(state, 'tdd', 'SKILL.md'), 'tdd v2\n');
  assert.deepEqual(await readdir(join(skillsSnapshot(state), 'tdd')), ['SKILL.md']);
  assert.match(await snapshotFile(state, 'grilling', 'SKILL.md'), /The grilling method/);
  assert.deepEqual(await versionsOf(state), { ...allAt(1), tdd: 'tdd-2' });
  // The previous folder, which a running session may bind, is as it was.
  assert.match(await readFile(join(state, before, 'tdd', 'SKILL.md'), 'utf8'), /The tdd method/);
});

test('a missing source or lock file keeps the snapshot as it is and names every skill missing; none before: nothing is made', async () => {
  const { root, source, state, env } = await fixture('missing');
  const fresh = join(root, 'fresh');
  assert.deepEqual(await synced(fresh, { HOME: join(root, 'nobody') }), { versions: {}, missing: [...AGENT_SKILLS] });
  await assert.rejects(lstat(skillsSnapshot(fresh)), { code: 'ENOENT' });
  await syncSkills(state, env);
  const link = await readlink(skillsSnapshot(state));
  await rm(join(root, 'agents', '.skill-lock.json'));
  assert.deepEqual(await synced(state, env), { versions: allAt(1), missing: [...AGENT_SKILLS] });
  await writeFile(join(root, 'agents', '.skill-lock.json'), 'not json');
  assert.deepEqual(await synced(state, env), { versions: allAt(1), missing: [...AGENT_SKILLS] });
  await rm(source, { recursive: true });
  assert.deepEqual(await synced(state, env), { versions: allAt(1), missing: [...AGENT_SKILLS] });
  assert.equal(await readlink(skillsSnapshot(state)), link);
  assert.match(await snapshotFile(state, 'implement', 'SKILL.md'), /The implement method/);
});

test('a skill missing from the lock or the source blocks only itself: the others update, it keeps its copy, or has none', async () => {
  const { root, source, env, lock } = await fixture('partial');
  const state = join(root, 'state');
  await lock({ implement: 'implement-1', tdd: 'tdd-1', 'code-review': 'code-review-1', prototype: 'prototype-1' });
  assert.deepEqual(await synced(state, env), { versions: { implement: 'implement-1', tdd: 'tdd-1', 'code-review': 'code-review-1', prototype: 'prototype-1' }, missing: ['grilling'] });
  await assert.rejects(stat(join(skillsSnapshot(state), 'grilling')), { code: 'ENOENT' });
  await lock(allAt(1));
  await syncSkills(state, env);
  // implement gone from the source, though the lock lists a new hash; tdd gone from the lock; code-review updated.
  await rm(join(source, 'implement'), { recursive: true });
  await writeFile(join(source, 'code-review', 'SKILL.md'), 'review v2\n');
  await lock({ implement: 'implement-2', 'code-review': 'code-review-2', grilling: 'grilling-1', prototype: 'prototype-1' });
  assert.deepEqual(await synced(state, env), { versions: { ...allAt(1), 'code-review': 'code-review-2' }, missing: ['implement', 'tdd'] });
  // The next sync: implement's new hash with no folder in the source is still missing, and no new folder is built.
  const link = await readlink(skillsSnapshot(state));
  assert.deepEqual(await synced(state, env), { versions: { ...allAt(1), 'code-review': 'code-review-2' }, missing: ['implement', 'tdd'] });
  assert.equal(await readlink(skillsSnapshot(state)), link);
  assert.match(await snapshotFile(state, 'implement', 'SKILL.md'), /The implement method/);
  assert.match(await snapshotFile(state, 'tdd', 'SKILL.md'), /The tdd method/);
  assert.equal(await snapshotFile(state, 'code-review', 'SKILL.md'), 'review v2\n');
});

test('a skill whose source folder is gone while its lock hash is unchanged is missing: it keeps its copy and version, and no folder is built', async () => {
  const { source, state, env } = await fixture('gone-unchanged');
  await syncSkills(state, env);
  const link = await readlink(skillsSnapshot(state));
  await rm(join(source, 'grilling'), { recursive: true });
  assert.deepEqual(await synced(state, env), { versions: allAt(1), missing: ['grilling'] });
  assert.equal(await readlink(skillsSnapshot(state)), link);
  assert.deepEqual(await readdir(join(state, 'skills.d')), [link.slice('skills.d/'.length)]);
  assert.match(await snapshotFile(state, 'grilling', 'SKILL.md'), /The grilling method/);
  const records: unknown[] = [];
  await recordSkills(state, async (record) => void records.push(record), { env });
  assert.deepEqual(records, [{ type: 'skills', versions: allAt(1), missing: ['grilling'], folder: link, roles: DEFAULT_ROLES }]);
  assert.match(skillsText(records[0] as SkillsEvent), /; missing in the source: grilling \(kept the copy\); by role: implementer implement, tdd, code-review, grilling; claude_review code-review; codex_gate code-review; task_check none; planner grilling, prototype\.$/);
});

test('two syncs at once each build a complete folder; the link names one of them; a later one removes the folders a week old but the current one and the one it replaced', async () => {
  const { state, env, lock } = await fixture('race');
  const results = await Promise.all([syncSkills(state, env), syncSkills(state, env)]);
  assert.deepEqual(results.map(({ versions, missing }) => ({ versions, missing })), [{ versions: allAt(1), missing: [] }, { versions: allAt(1), missing: [] }]);
  const folders = await readdir(join(state, 'skills.d'));
  assert.ok(folders.length >= 1 && folders.length <= 2, folders.join());
  for (const folder of folders) {
    assert.deepEqual((await readdir(join(state, 'skills.d', folder))).sort(), [...AGENT_SKILLS, 'versions.json'].sort());
  }
  assert.ok(folders.includes((await readlink(skillsSnapshot(state))).slice('skills.d/'.length)));
  assert.deepEqual((await readdir(state)).sort(), ['skills', 'skills.d']);
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  for (const folder of folders) {
    await utimes(join(state, 'skills.d', folder), old, old);
  }
  const replaced = (await readlink(skillsSnapshot(state))).slice('skills.d/'.length);
  await lock(allAt(2));
  await syncSkills(state, env);
  const current = (await readlink(skillsSnapshot(state))).slice('skills.d/'.length);
  assert.deepEqual((await readdir(join(state, 'skills.d'))).sort(), [current, replaced].sort());
  // A week after it was replaced, the next swap removes it.
  await utimes(join(state, 'skills.d', replaced), old, old);
  await lock(allAt(3));
  await syncSkills(state, env);
  assert.deepEqual((await readdir(join(state, 'skills.d'))).sort(), [current, (await readlink(skillsSnapshot(state))).slice('skills.d/'.length)].sort());
});

test('recordSkills syncs and appends one skills event: the versions, the missing skills when there are any, and the folder the link names', async () => {
  const { state, env, lock } = await fixture('record');
  const records: unknown[] = [];
  await recordSkills(state, async (record) => void records.push(record), { env });
  await lock({ ...allAt(1), grilling: '' });
  await recordSkills(join(state, 'other'), async (record) => void records.push(record), { env });
  assert.deepEqual(records, [
    { type: 'skills', versions: allAt(1), folder: await readlink(skillsSnapshot(state)), roles: DEFAULT_ROLES },
    { type: 'skills', versions: { implement: 'implement-1', tdd: 'tdd-1', 'code-review': 'code-review-1', prototype: 'prototype-1' }, missing: ['grilling'], folder: await readlink(skillsSnapshot(join(state, 'other'))), roles: DEFAULT_ROLES },
  ]);
  assert.match(String((records[0] as SkillsEvent).folder), /^skills\.d\/[\w-]+$/);
});

test('a job start with skills missing in the source writes one warning line naming the job, on stderr and in its runner.log, beside its one skills event; none when all are there', async () => {
  const { root, source, state, env } = await fixture('warn');
  const lines: string[] = [];
  const errorMock = mock.method(console, 'error', (line: unknown) => void lines.push(String(line)));
  const records: unknown[] = [];
  try {
    await recordSkills(state, async (record) => void records.push(record), { env, job: 'app/W-1', log: join(root, 'runner.log') });
    assert.deepEqual(lines, []);
    // The lock file gone: every skill is missing, the snapshot keeps its copies.
    await rm(join(root, 'agents', '.skill-lock.json'));
    await recordSkills(state, async (record) => void records.push(record), { env, job: 'app/W-2', log: join(root, 'runner.log') });
    // The source folder gone, on a fresh state directory: nothing to keep.
    await rm(source, { recursive: true });
    await recordSkills(join(root, 'fresh'), async (record) => void records.push(record), { env, job: 'app/W-3' });
  } finally {
    errorMock.mock.restore();
  }
  assert.deepEqual(lines, [
    `warning: app/W-2: skills missing in ${source} or its lock file: implement, tdd, code-review, grilling, prototype; the snapshot keeps the copies it has`,
    `warning: app/W-3: skills missing in ${source} or its lock file: implement, tdd, code-review, grilling, prototype; the snapshot keeps the copies it has`,
  ]);
  // The job's runner.log: the line of W-2, the only start with that log and something missing.
  assert.equal(await readFile(join(root, 'runner.log'), 'utf8'), `${lines[0]}\n`);
  const folder = await readlink(skillsSnapshot(state));
  assert.deepEqual(records, [
    { type: 'skills', versions: allAt(1), folder, roles: DEFAULT_ROLES },
    { type: 'skills', versions: allAt(1), missing: [...AGENT_SKILLS], folder, roles: DEFAULT_ROLES },
    // No snapshot at all: no folder; the job binds the link, which is none.
    { type: 'skills', versions: {}, missing: [...AGENT_SKILLS], roles: DEFAULT_ROLES },
  ]);
});

test('a sync that fails records the snapshot as it was and the failure, never a missing skill the source has', async () => {
  const { state, env } = await fixture('failed');
  // The state directory cannot hold skills.d: the first sync fails though the source and lock are whole.
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'skills.d'), 'not a folder');
  const records: Array<Record<string, unknown>> = [];
  await recordSkills(state, async (record) => void records.push(record), { env });
  assert.deepEqual(records.map((record) => Object.keys(record).sort()), [['error', 'roles', 'type', 'versions']]);
  assert.deepEqual([records[0]!.type, records[0]!.versions], ['skills', {}]);
  assert.match(String(records[0]!.error), /^(ENOTDIR|EEXIST)/);
});

test('a failed update records the versions the snapshot still holds, and the failure', { skip: process.getuid?.() === 0 ? 'root writes through a read-only folder' : false }, async () => {
  const { state, env, lock } = await fixture('failed-update');
  await syncSkills(state, env);
  await lock({ ...allAt(1), tdd: 'tdd-2' });
  const mode = (await stat(join(state, 'skills.d'))).mode & 0o777;
  await chmod(join(state, 'skills.d'), 0o555);
  const records: Array<Record<string, unknown>> = [];
  try {
    await recordSkills(state, async (record) => void records.push(record), { env });
  } finally {
    await chmod(join(state, 'skills.d'), mode);
  }
  assert.deepEqual(records.map((record) => ({ ...record, error: typeof record.error })), [{ type: 'skills', versions: allAt(1), folder: await readlink(skillsSnapshot(state)), error: 'string', roles: DEFAULT_ROLES }]);
  assert.match(String(records[0]!.error), /^EACCES/);
});

// Writes a job directory's events.jsonl as the job's start does: a state change, then the record.
async function jobEvents(state: string, workspace: string, name: string, record: unknown): Promise<string> {
  const dir = join(state, 'jobs', workspace, name);
  await mkdir(dir, { recursive: true });
  const events = join(dir, 'events.jsonl');
  const lines = [{ ts: 't', iteration: 0, state: { from: null, to: 'starting' } }, { ts: 't', iteration: 0, ...(record as object) }];
  await writeFile(events, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return events;
}

test('a job\'s wrapper binds the folder its skills event recorded: a later swap of the link leaves it; a job without one binds the link', async () => {
  const { state, env, lock } = await fixture('pinned');
  const records: SkillsEvent[] = [];
  await recordSkills(state, async (record) => void records.push(record), { env });
  const a = await readlink(skillsSnapshot(state));
  const events = await jobEvents(state, 'app', 'A-1', records[0]);
  // Job B's start: a new tdd swaps the link to folder B.
  await lock({ ...allAt(1), tdd: 'tdd-2' });
  await recordSkills(state, async (record) => void records.push(record), { env });
  assert.notEqual(records[1]!.folder, a);
  assert.equal(await readlink(skillsSnapshot(state)), records[1]!.folder);
  // A's next wrapper still binds A.
  assert.equal((await jobSkills(state, events)).folder, join(state, a));
  // A job started before the folder was recorded, a job without events, a recorded folder gone
  // or a path that is not a skills.d folder: the link.
  const unpinned = await jobEvents(state, 'app', 'O-1', { type: 'skills', versions: allAt(1) });
  assert.equal((await jobSkills(state, unpinned)).folder, skillsSnapshot(state));
  assert.equal((await jobSkills(state, join(state, 'jobs', 'app', 'none', 'events.jsonl'))).folder, skillsSnapshot(state));
  const gone = await jobEvents(state, 'app', 'G-1', { type: 'skills', versions: allAt(1), folder: 'skills.d/0-0-gone' });
  assert.equal((await jobSkills(state, gone)).folder, skillsSnapshot(state));
  const outside = await jobEvents(state, 'app', 'X-1', { type: 'skills', versions: allAt(1), folder: '../agents' });
  assert.equal((await jobSkills(state, outside)).folder, skillsSnapshot(state));
});

test('the 7-day cleanup never removes a folder a job not yet archived recorded; an archived job\'s goes', async () => {
  const { state, env, lock } = await fixture('pinned-cleanup');
  const folder = async (): Promise<string> => readlink(skillsSnapshot(state));
  await syncSkills(state, env);
  const a = await folder();
  await jobEvents(state, 'app', 'L-1', { type: 'skills', versions: allAt(1), folder: a });
  await lock(allAt(2));
  await syncSkills(state, env);
  const b = await folder();
  await jobEvents(state, 'app', 'D-1.20261101T000000Z', { type: 'skills', versions: allAt(2), folder: b });
  await lock(allAt(3));
  await syncSkills(state, env);
  const c = await folder();
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  for (const name of [a, b, c]) {
    await utimes(join(state, name), old, old);
  }
  await lock(allAt(4));
  await syncSkills(state, env);
  const d = await folder();
  // a: recorded by L-1, still current; b: recorded by an archived job only; c: just replaced.
  const names = (list: string[]): string[] => list.map((name) => name.slice('skills.d/'.length)).sort();
  assert.deepEqual((await readdir(join(state, 'skills.d'))).sort(), names([a, c, d]));
});

test('skillsText: each skill with its short hash, then the missing ones, kept or not available', () => {
  const versions = { implement: '4804b466ab26c9b9d8d42917547db133d1f20a9f', tdd: '667dbdd00c09d0e2189e082986e6a4d61a67c2a6' };
  assert.equal(skillsText({ versions }), 'Skills: implement 4804b46, tdd 667dbdd.');
  assert.equal(skillsText({ versions, missing: ['tdd', 'grilling'] }), 'Skills: implement 4804b46, tdd 667dbdd; missing in the source: tdd (kept the copy), grilling (not available).');
  assert.equal(skillsText({ versions: {}, missing: ['implement'] }), 'Skills: none; missing in the source: implement (not available).');
  // A failed sync: the snapshot's versions as they were, and why it failed.
  assert.equal(skillsText({ versions, error: 'EACCES: permission denied' }), 'Skills: implement 4804b46, tdd 667dbdd; the sync failed (EACCES: permission denied), the snapshot as it was.');
});

// Two more installed skills, extra and unused, each with a SKILL.md and its lock entry (source, updatedAt).
async function withMore(fixtureOf: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const { root, source } = fixtureOf;
  for (const skill of ['extra', 'unused']) {
    await mkdir(join(source, skill), { recursive: true });
    await writeFile(join(source, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: "The ${skill} skill"\n---\nThe ${skill} method.\n`);
  }
  const lock = JSON.parse(await readFile(join(root, 'agents', '.skill-lock.json'), 'utf8')) as { skills: Record<string, unknown> };
  for (const skill of ['extra', 'unused']) {
    lock.skills[skill] = { skillFolderHash: `${skill}-1`, source: `owner/${skill}`, updatedAt: '2026-11-10T08:00:00.000Z' };
  }
  await writeFile(join(root, 'agents', '.skill-lock.json'), JSON.stringify(lock));
}

test('the union snapshot: a skill chosen by the Task check only is copied, one no role chose is not', async () => {
  const fixed = await fixture('union');
  await withMore(fixed);
  const { state, env } = fixed;
  await mkdir(state, { recursive: true });
  await writeRoles(state, { implementer: [], claude_review: [], codex_gate: [], task_check: ['extra'], planner: [] });
  assert.deepEqual(await synced(state, env), { versions: { extra: 'extra-1' }, missing: [] });
  assert.deepEqual((await readdir(skillsSnapshot(state))).sort(), ['extra', 'versions.json']);
  // Back to every default: the five are copied, extra (chosen by no role now) is left out of the new folder.
  await rm(join(state, 'skill-roles.json'));
  assert.deepEqual(await synced(state, env), { versions: allAt(1), missing: [] });
  assert.deepEqual((await readdir(skillsSnapshot(state))).sort(), [...AGENT_SKILLS, 'versions.json'].sort());
});

test('a choice that only takes skills out shrinks the snapshot: a new folder holds the chosen subset, its copies unchanged, and the link swaps to it', async () => {
  const { state, env } = await fixture('shrink');
  assert.deepEqual(await synced(state, env), { versions: allAt(1), missing: [] });
  const before = await readlink(skillsSnapshot(state));
  // Every remaining skill's hash is the snapshot's own: only the removal calls for a new folder.
  await writeRoles(state, { implementer: ['tdd'], claude_review: [], codex_gate: [], task_check: [], planner: [] });
  assert.deepEqual(await synced(state, env), { versions: { tdd: 'tdd-1' }, missing: [] });
  assert.notEqual(await readlink(skillsSnapshot(state)), before);
  assert.deepEqual((await readdir(skillsSnapshot(state))).sort(), ['tdd', 'versions.json']);
  assert.deepEqual(await versionsOf(state), { tdd: 'tdd-1' });
  assert.match(await snapshotFile(state, 'tdd', 'SKILL.md'), /The tdd method/);
  // The old folder stays for a job that recorded it; a sync with the same choice builds nothing more.
  assert.ok((await readdir(join(state, 'skills.d'))).includes(before.slice('skills.d/'.length)));
  const after = await readlink(skillsSnapshot(state));
  await syncSkills(state, env);
  assert.equal(await readlink(skillsSnapshot(state)), after);
});

test('the roles change between two jobs\' syncs: each job records the pair its own sync returned, and the first job\'s folder still holds every skill of its recorded lists', async () => {
  const fixed = await fixture('pair');
  await withMore(fixed);
  const { state, env } = fixed;
  const records: SkillsEvent[] = [];
  await recordSkills(state, async (record) => void records.push(record), { env });
  // The choice changes before the second job's sync: extra added, every default but tdd taken out.
  await setRoleSkills(state, 'implementer', ['tdd', 'extra'], env);
  for (const role of ['claude_review', 'codex_gate', 'planner'] as const) {
    await setRoleSkills(state, role, [], env);
  }
  await recordSkills(state, async (record) => void records.push(record), { env });
  const [first, second] = records;
  assert.deepEqual(first!.roles, DEFAULT_ROLES);
  assert.deepEqual(second!.roles, { implementer: ['tdd', 'extra'], claude_review: [], codex_gate: [], task_check: [], planner: [] });
  assert.notEqual(first!.folder, second!.folder);
  // Each recorded folder holds every skill its recorded lists name, with the versions recorded beside it.
  for (const record of [first!, second!]) {
    const held = await readdir(join(state, record.folder!));
    for (const name of chosenSkills(record.roles!)) {
      assert.ok(held.includes(name), `${record.folder} lacks ${name}`);
    }
    assert.deepEqual(JSON.parse(await readFile(join(state, record.folder!, 'versions.json'), 'utf8')), record.versions);
  }
  // The first job binds its own folder, with its own lists, after the swaps.
  const events = await jobEvents(state, 'app', 'P-1', first);
  assert.deepEqual(await implementerSkills(state, events), DEFAULT_ROLES.implementer.map((name) => join(state, first!.folder!, name)));
});

test('a running job keeps the lists its start recorded after a change; a job started afterwards has the new ones, its Implementer only its own skills', async () => {
  const { state, env } = await fixture('pinned-roles');
  const records: SkillsEvent[] = [];
  await recordSkills(state, async (record) => void records.push(record), { env });
  const running = await jobEvents(state, 'app', 'R-1', records[0]);
  await setRoleSkills(state, 'implementer', ['tdd'], env);
  await setRoleSkills(state, 'codex_gate', [], env);
  assert.deepEqual((await jobSkills(state, running)).roles, DEFAULT_ROLES);
  assert.deepEqual((await implementerSkills(state, running)).map((path) => path.split('/').at(-1)), ['implement', 'tdd', 'code-review', 'grilling']);
  await recordSkills(state, async (record) => void records.push(record), { env });
  const later = await jobEvents(state, 'app', 'L-1', records[1]);
  assert.deepEqual((await jobSkills(state, later)).roles, { ...DEFAULT_ROLES, implementer: ['tdd'], codex_gate: [] });
  assert.deepEqual(await implementerSkills(state, later), [join(state, records[1]!.folder!, 'tdd')]);
  // Without a job: the choice now, in the link.
  assert.deepEqual(await implementerSkills(state), [join(skillsSnapshot(state), 'tdd')]);
  // A job started before the lists were recorded: every role's default.
  const older = await jobEvents(state, 'app', 'O-1', { type: 'skills', versions: allAt(1) });
  assert.deepEqual((await jobSkills(state, older)).roles, DEFAULT_ROLES);
});

test('sf skills: the installed skills with source, updated and description, each role\'s list, the missing ones; set refuses an unknown role and a skill not installed', async () => {
  const fixed = await fixture('view');
  await withMore(fixed);
  const { state, env } = fixed;
  await mkdir(state, { recursive: true });
  await writeRoles(state, { ...DEFAULT_ROLES, planner: ['grilling', 'gone'] });
  const view = await skillsView(state, env);
  assert.deepEqual(view.skills.map((skill) => skill.name), ['code-review', 'extra', 'grilling', 'implement', 'prototype', 'tdd', 'unused']);
  assert.deepEqual(view.skills.find((skill) => skill.name === 'extra'), { name: 'extra', source: 'owner/extra', updated: '2026-11-10T08:00:00.000Z', description: 'The extra skill' });
  assert.deepEqual(view.missing, ['gone']);
  const lines = skillsLines(view);
  assert.match(lines[0]!, /^skill +source +updated +implementer +claude_review +codex_gate +task_check +planner +description$/);
  assert.match(lines.find((line) => line.startsWith('extra'))!, /^extra +owner\/extra +2026-11-10 +- +- +- +- +- +The extra skill$/);
  // No updatedAt and no description: a dash, and nothing.
  assert.match(lines.find((line) => line.startsWith('code-review'))!, /^code-review +x +- +on +on +on +- +-$/);
  assert.equal(lines.at(-2), 'missing: gone (chosen for planner, not installed)');
  // No coordinator workspace: no column, one line saying why.
  assert.equal(lines.at(-1), 'coordinator: No coordinator workspace (SF_COORDINATOR_WORKSPACE): "software-factory" is not registered.');
  // sf skills set: on adds at the end, off takes out; the file is written with mode 0600 and the snapshot synced at once.
  const after = await switchSkill(state, 'task_check', 'extra', true, env);
  assert.deepEqual(after.roles.task_check, ['extra']);
  assert.equal((await stat(join(state, 'skill-roles.json'))).mode & 0o777, 0o600);
  assert.ok((await readdir(skillsSnapshot(state))).includes('extra'));
  assert.deepEqual((await switchSkill(state, 'implementer', 'implement', false, env)).roles.implementer, ['tdd', 'code-review', 'grilling']);
  // A name the role has though it is not installed may go.
  assert.deepEqual((await switchSkill(state, 'planner', 'gone', false, env)).roles.planner, ['grilling']);
  await assert.rejects(switchSkill(state, 'reviewer', 'tdd', true, env), { code: 'unknown_role', message: /the roles are implementer, claude_review, codex_gate, task_check, planner/ });
  await assert.rejects(switchSkill(state, 'planner', 'nope', true, env), { code: 'skill_not_installed', message: /Not an installed skill: nope; installed: code-review, extra, grilling, implement, prototype, tdd, unused/ });
  await assert.rejects(switchSkill(state, 'planner', 'nope', false, env), { code: 'skill_not_installed' });
  await assert.rejects(setRoleSkills(state, 'codex_gate', ['../agents'], env), { code: 'skill_not_installed' });
});

test('sf skills: the coordinator column after the roles (on, -, the override), its settings file; sf skills set coordinator changes that key only, skill-roles.json untouched', async () => {
  const fixed = await fixture('coordinator');
  const { root, state, env } = fixed;
  await mkdir(state, { recursive: true });
  const repo = join(await realpath(root), 'repo');
  await mkdir(join(repo, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  await saveRegistry({ workspaces: { 'software-factory': { read_checkout: repo } } }, env.SF_CONFIG_DIR);
  const settings = join(repo, '.claude', 'settings.local.json');
  await writeFile(settings, JSON.stringify({ env: { A: '1' }, skillOverrides: { grilling: 'name-only' } }));
  const lines = skillsLines(await skillsView(state, env));
  assert.match(lines[0]!, /^skill +source +updated +implementer +claude_review +codex_gate +task_check +planner +coordinator +description$/);
  assert.match(lines.find((line) => line.startsWith('grilling'))!, /^grilling +x +- +on +- +- +- +on +name-only$/);
  assert.equal(lines.at(-1), `coordinator: Claude Code's skillOverrides in ${settings}; it applies to the next Claude Code session there (or after /skills).`);
  const view = await switchSkill(state, 'coordinator', 'tdd', false, env);
  assert.deepEqual(view.coordinator, { workspace: 'software-factory', checkout: repo, settings, skills: { 'code-review': 'on', grilling: 'name-only', implement: 'on', prototype: 'on', tdd: 'off' } });
  assert.match(skillsLines(view).find((line) => line.startsWith('tdd'))!, /^tdd +x +- +on +- +- +- +- +-$/);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { env: { A: '1' }, skillOverrides: { grilling: 'name-only', tdd: 'off' } });
  // The job roles' choice is not touched: no skill-roles.json, every role its default.
  await assert.rejects(stat(join(state, 'skill-roles.json')), { code: 'ENOENT' });
  assert.deepEqual(view.roles, DEFAULT_ROLES);
  // The list form (PUT): grilling stays name-only; tdd on again.
  assert.deepEqual(((await setRoleSkills(state, 'coordinator', ['tdd', 'implement', 'code-review', 'prototype'], env)).coordinator as { skills: unknown }).skills, { 'code-review': 'on', grilling: 'name-only', implement: 'on', prototype: 'on', tdd: 'on' });
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { env: { A: '1' }, skillOverrides: { grilling: 'name-only' } });
  await assert.rejects(switchSkill(state, 'coordinator', 'nope', true, env), { code: 'skill_not_installed' });
  // The dashboard's form: no absolute path.
  assert.deepEqual(skillsForClients(view).coordinator, { workspace: 'software-factory', skills: { 'code-review': 'on', grilling: 'name-only', implement: 'on', prototype: 'on', tdd: 'off' } });
});

test('a skill\'s SKILL.md for the API: an installed skill\'s text; a path, .. or a name not installed is refused before anything is read', async () => {
  const fixed = await fixture('text');
  await withMore(fixed);
  const { source, env } = fixed;
  assert.deepEqual(await skillText('extra', env), { name: 'extra', text: '---\nname: extra\ndescription: "The extra skill"\n---\nThe extra method.\n', truncated: false });
  for (const name of ['../agents', 'a/b', '..', '.', '', 'Extra', 'docs/../extra', 'missing']) {
    await assert.rejects(skillText(name, env), { code: 'skill_not_installed' }, name);
  }
  // A long file is cut at MAX_SKILL_TEXT_BYTES.
  await writeFile(join(source, 'unused', 'SKILL.md'), 'é'.repeat(MAX_SKILL_TEXT_BYTES));
  const long = await skillText('unused', env);
  assert.equal(long.truncated, true);
  assert.equal(Buffer.byteLength(long.text), MAX_SKILL_TEXT_BYTES);
});

test('skillBlocks: each skill\'s SKILL.md in a <skill> block, in order, at most the limit in all; one over it is named, not included, and the later ones are still tried', async () => {
  const { state, env } = await fixture('blocks');
  await syncSkills(state, env);
  const folder = skillsSnapshot(state);
  const all = await skillBlocks(folder, ['tdd', 'grilling']);
  assert.equal(all.text, '<skill name="tdd">\n---\nname: tdd\n---\nThe tdd method.\n</skill>\n<skill name="grilling">\n---\nname: grilling\n---\nThe grilling method.\n</skill>');
  assert.equal(MAX_SKILL_BLOCKS_BYTES, 64 * 1024);
  const tdd = Buffer.byteLength('<skill name="tdd">\n---\nname: tdd\n---\nThe tdd method.\n</skill>') + 1;
  await writeFile(join(folder, 'implement', 'SKILL.md'), 'x'.repeat(200));
  const cut = await skillBlocks(folder, ['implement', 'tdd', 'none'], tdd + 50);
  assert.deepEqual([cut.included, cut.omitted], [['tdd'], ['implement', 'none']]);
  assert.ok(cut.text.startsWith('<skill name="tdd">'));
});
