// npm run sync-skills, scripts/sync-skills.mjs run on a fake source folder, lock file and target:
// it copies the skills SOURCE.md lists, links followed, replaces each folder whole, rewrites the
// table from the lock file and prints the changed files; a listed skill missing from the source or
// the lock file writes nothing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The tests run from dist/test; the script is that of the checkout.
const SCRIPT = fileURLToPath(new URL('../../scripts/sync-skills.mjs', import.meta.url));

const SOURCE_MD = [
  '# The agents\' skills', '', 'Prose stays.', '',
  '| Skill | Path in the source repository | Folder hash | Updated |', '| --- | --- | --- | --- |',
  '| `implement` | `skills/engineering/implement/SKILL.md` | `old1` | 2026-11-01 |',
  '| `tdd` | `skills/engineering/tdd/SKILL.md` | `old2` | 2026-11-01 |', '',
].join('\n');

const LOCK = {
  version: 3,
  skills: {
    implement: { source: 'mattpocock/skills', skillPath: 'skills/engineering/implement/SKILL.md', skillFolderHash: 'new1', updatedAt: '2026-11-10T08:00:00.000Z' },
    tdd: { source: 'mattpocock/skills', skillPath: 'skills/engineering/tdd/SKILL.md', skillFolderHash: 'new2', updatedAt: '2026-11-11T09:30:00.000Z' },
    unlisted: { skillPath: 'skills/x/SKILL.md', skillFolderHash: 'x', updatedAt: '2026-11-11T00:00:00.000Z' },
  },
};

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
}

// A fake ~/.agents (skills/ with implement as a link, as the skills tool makes it, and the lock
// file) and a target with SOURCE.md and an older copy holding a stale file.
async function fixture(lock: unknown = LOCK): Promise<{ root: string; from: string; to: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sf-sync-skills-'));
  const from = join(root, 'agents', 'skills');
  await write(join(root, 'store'), { 'implement/SKILL.md': 'implement v2\n', 'implement/agents/openai.yaml': 'y\n' });
  await mkdir(from, { recursive: true });
  await symlink(join(root, 'store', 'implement'), join(from, 'implement'));
  await write(from, { 'tdd/SKILL.md': 'tdd v2\n', 'tdd/tests.md': 'tests\n', 'unlisted/SKILL.md': 'not copied\n' });
  await writeFile(join(root, 'agents', '.skill-lock.json'), JSON.stringify(lock));
  const to = join(root, 'target');
  await write(to, { 'SOURCE.md': SOURCE_MD, 'implement/SKILL.md': 'implement v1\n', 'implement/agents/openai.yaml': 'y\n', 'tdd/SKILL.md': 'tdd v2\n', 'tdd/stale.md': 'gone\n' });
  return { root, from, to };
}

function run(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('sync-skills copies the listed skills, links followed, replaces each folder whole, rewrites the table from the lock file and prints the changed files', async () => {
  const { from, to } = await fixture();
  const ran = run(['--from', from, '--to', to]);
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(await readFile(join(to, 'implement', 'SKILL.md'), 'utf8'), 'implement v2\n');
  assert.equal(await readFile(join(to, 'tdd', 'tests.md'), 'utf8'), 'tests\n');
  assert.equal(existsSync(join(to, 'tdd', 'stale.md')), false);
  assert.equal(existsSync(join(to, 'unlisted')), false);
  assert.equal(await readFile(join(to, 'SOURCE.md'), 'utf8'), SOURCE_MD
    .replace('`old1` | 2026-11-01', '`new1` | 2026-11-10').replace('`old2` | 2026-11-01', '`new2` | 2026-11-11'));
  const printed = ran.stdout.trim().split('\n').slice(1).map((line) => line.trim().split(/\s+/));
  assert.deepEqual(printed, [['changed', 'implement/SKILL.md'], ['added', 'tdd/tests.md'], ['removed', 'tdd/stale.md'], ['changed', 'SOURCE.md']]);
  // A second run finds nothing to change.
  const again = run(['--from', from, '--to', to]);
  assert.deepEqual([again.code, again.stdout.trim()], [0, 'sync-skills: no changes.']);
});

test('sync-skills: a listed skill missing from the source or from the lock file exits 1 naming it, and nothing is written', async () => {
  const { from: noLock, to: toNoLock } = await fixture({ skills: { implement: LOCK.skills.implement } });
  const ran = run(['--from', noLock, '--to', toNoLock]);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /tdd \(not in .*\.skill-lock\.json\)/);
  assert.equal(await readFile(join(toNoLock, 'implement', 'SKILL.md'), 'utf8'), 'implement v1\n');
  assert.equal(await readFile(join(toNoLock, 'SOURCE.md'), 'utf8'), SOURCE_MD);
  const { root, to } = await fixture();
  const empty = join(root, 'empty', 'skills');
  await mkdir(empty, { recursive: true });
  const missing = run(['--from', empty, '--lock', join(root, 'agents', '.skill-lock.json'), '--to', to]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /implement \(not in .*\), tdd \(not in /);
  assert.equal(existsSync(join(to, 'tdd', 'stale.md')), true);
  assert.equal(run(['--bogus', 'x']).code, 2);
});
