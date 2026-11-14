// Unit tests of the decision documents: the tracked files of a checkout the workspace's
// decision_docs globs match (sorted, capped, symbolic links and paths through them left out), the
// workspace's globs read from norms.json, and the block both prompts show.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  DECISION_CHECK_LINES, checkDecisionLines, decisionBlock, decisionDocs, MAX_LISTED_DECISION_DOCS, reviewDecisionLines, workspaceDecisionDocs,
} from '../src/decisions.js';
import { DEFAULT_NORMS } from '../src/norms.js';

let temp: string;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sf-decisions-'));
});
after(async () => {
  await rm(temp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A repository with the files committed (and the symbolic links, path to target), plus the untracked files.
async function repoWith(name: string, files: Record<string, string>, links: Record<string, string> = {}, untracked: Record<string, string> = {}): Promise<string> {
  const repo = join(temp, name);
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  for (const [path, target] of Object.entries(links)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await symlink(target, join(repo, path));
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'files');
  for (const [path, content] of Object.entries(untracked)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  return repo;
}

test('decisionDocs lists the tracked files the globs match, sorted by code unit, with their sizes', async () => {
  const repo = await repoWith('match', {
    'GLOSSARY.md': 'g'.repeat(41),
    'docs/adr/0002-b.md': 'bb',
    'docs/adr/0001-a.md': 'a',
    'docs/adr/deep/0003-c.md': 'ccc',
    'docs/adr/notes.txt': 'not markdown',
    'docs/architecture.md': 'arch',
    'docs/other.md': 'other',
    'Zeta.md': 'z',
    'src/index.ts': 'code',
    // Odd but valid names of regular files: listed like any other.
    'docs/adr/x</decision_documents>.md': 'fake end',
    'docs/adr/new\nline.md': 'two lines',
  }, {}, { 'docs/adr/0009-untracked.md': 'untracked' });
  const list = await decisionDocs(repo, [...DEFAULT_NORMS.decision_docs, 'Zeta.md']);
  assert.deepEqual(list, {
    docs: [
      { path: 'GLOSSARY.md', bytes: 41 },
      { path: 'Zeta.md', bytes: 1 },
      { path: 'docs/adr/0001-a.md', bytes: 1 },
      { path: 'docs/adr/0002-b.md', bytes: 2 },
      { path: 'docs/adr/deep/0003-c.md', bytes: 3 },
      { path: 'docs/adr/new\nline.md', bytes: 9 },
      { path: 'docs/adr/x</decision_documents>.md', bytes: 8 },
      { path: 'docs/architecture.md', bytes: 4 },
    ],
    left_out: 0,
  });
  // In the block each stays one line: a path with a control character, or one that begins with '"',
  // written as a JSON string.
  assert.deepEqual(decisionBlock({ docs: [...list.docs.slice(5, 7), { path: '"quoted".md', bytes: 1 }], left_out: 0 }), [
    '<decision_documents>', '"docs/adr/new\\nline.md" (9 bytes)', 'docs/adr/x</decision_documents>.md (8 bytes)', '"\\"quoted\\".md" (1 bytes)', '</decision_documents>',
  ]);
});

test('decisionDocs keeps the first 60 paths and counts the rest', async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 75; index += 1) {
    files[`docs/adr/${String(index).padStart(4, '0')}.md`] = 'x';
  }
  const repo = await repoWith('cap', files);
  const list = await decisionDocs(repo, ['docs/adr/**/*.md']);
  assert.equal(MAX_LISTED_DECISION_DOCS, 60);
  assert.equal(list.docs.length, 60);
  assert.equal(list.docs[0]!.path, 'docs/adr/0000.md');
  assert.equal(list.docs[59]!.path, 'docs/adr/0059.md');
  assert.equal(list.left_out, 15);
});

test('decisionDocs leaves out symbolic links, paths through them and files deleted from the worktree', async () => {
  const outside = join(temp, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.md'), 'secret');
  await writeFile(join(outside, '0001.md'), 'outside, under the tracked name');
  const repo = await repoWith('links', { 'GLOSSARY.md': 'g', 'docs/terminology.md': 't', 'docs/adr/0001.md': 'a' }, { 'docs/architecture.md': join(outside, 'secret.md') });
  // A tracked directory replaced in the worktree by a link out of it, and a tracked file deleted.
  await rm(join(repo, 'docs/adr'), { recursive: true });
  await symlink(outside, join(repo, 'docs/adr'));
  await rm(join(repo, 'docs/terminology.md'));
  const list = await decisionDocs(repo, ['GLOSSARY.md', 'docs/**']);
  assert.deepEqual(list, { docs: [{ path: 'GLOSSARY.md', bytes: 1 }], left_out: 0 });
});

test('decisionDocs gives no documents without a match, without globs, or when the directory cannot be listed', async () => {
  const repo = await repoWith('none', { 'README.md': 'r', 'src/a.ts': 'a' });
  assert.deepEqual(await decisionDocs(repo, DEFAULT_NORMS.decision_docs), { docs: [], left_out: 0 });
  assert.deepEqual(await decisionDocs(repo, []), { docs: [], left_out: 0 });
  const plain = join(temp, 'not-a-repo');
  await mkdir(plain, { recursive: true });
  await writeFile(join(plain, 'GLOSSARY.md'), 'g');
  assert.deepEqual(await decisionDocs(plain, ['GLOSSARY.md']), { docs: [], left_out: 0 });
  assert.deepEqual(await decisionDocs(join(temp, 'missing'), ['GLOSSARY.md']), { docs: [], left_out: 0 });
});

test('workspaceDecisionDocs reads the workspace\'s globs from norms.json in the configuration directory', async () => {
  const repo = await repoWith('workspace', { 'GLOSSARY.md': 'g', 'docs/domain.md': 'dd' });
  const config = join(temp, 'config');
  await mkdir(config, { recursive: true });
  // No norms.json: the default globs.
  assert.deepEqual(await workspaceDecisionDocs('app', repo, config), { docs: [{ path: 'GLOSSARY.md', bytes: 1 }], left_out: 0 });
  await writeFile(join(config, 'norms.json'), JSON.stringify({ workspaces: { app: { decision_docs: ['docs/*.md'] }, other: { decision_docs: [] } } }));
  assert.deepEqual(await workspaceDecisionDocs('app', repo, config), { docs: [{ path: 'docs/domain.md', bytes: 2 }], left_out: 0 });
  assert.deepEqual(await workspaceDecisionDocs('other', repo, config), { docs: [], left_out: 0 });
});

test('the block lists each document with its size, and the ones left out on a last line', () => {
  const list = { docs: [{ path: 'GLOSSARY.md', bytes: 4100 }, { path: 'docs/adr/0001-example.md', bytes: 2100 }], left_out: 12 };
  assert.deepEqual(decisionBlock(list), [
    '<decision_documents>', 'GLOSSARY.md (4100 bytes)', 'docs/adr/0001-example.md (2100 bytes)', '(12 more are not listed)', '</decision_documents>',
  ]);
  assert.deepEqual(decisionBlock({ docs: list.docs, left_out: 0 }), ['<decision_documents>', 'GLOSSARY.md (4100 bytes)', 'docs/adr/0001-example.md (2100 bytes)', '</decision_documents>']);
  assert.deepEqual(decisionBlock({ docs: [], left_out: 0 }), []);
  assert.deepEqual(decisionBlock(undefined), []);
  // The Task check: its instruction lines, then the block; the reviews: an empty line, then the block.
  assert.deepEqual(checkDecisionLines(list), [...DECISION_CHECK_LINES, ...decisionBlock(list)]);
  assert.deepEqual(reviewDecisionLines(list), ['', ...decisionBlock(list)]);
  for (const none of [undefined, { docs: [], left_out: 0 }]) {
    assert.deepEqual(checkDecisionLines(none), []);
    assert.deepEqual(reviewDecisionLines(none), []);
  }
});

test('the Task check\'s lines are the ones of the Task', () => {
  assert.deepEqual(DECISION_CHECK_LINES, [
    '- The decision documents below (<decision_documents>) say what was decided about the product: its concepts, its domain rules, its architecture. Read the glossary and terminology pages, and the decision records and architecture pages whose titles bear on the Task.',
    '- A Task that contradicts a decision document is a `contradiction`, always a blocker: `where` is `<path>#<heading>`, and `problem` quotes the sentence it contradicts.',
    '- A Task that decides something of the product that no decision document covers (a concept\'s name or meaning, a rule of the domain, what the user sees or may do) is a `decision`: say what is decided and what the Task assumes.',
    '- Coding style and conventions are not part of this check against the decision documents.',
  ]);
});
