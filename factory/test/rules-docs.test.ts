// Unit tests of the coding rules (SF-059): the links of AGENTS.md, the paths they may name, the
// collection at a commit (instruction file, linked files, the user's rules files), the budget and
// its closing line, rules_skip with this repository's layout, and the job's copies.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectRules, copyRulesRecord, LEFT_OUT_LEAD, linkedPath, markdownLinks, readJobRules, RULES_SENTENCE, type RulesOptions, rulesBlock, rulesLines, writeJobRules } from '../src/rules-docs.js';

// This repository's AGENTS.md (the test runs from factory/dist/test).
const OWN_AGENTS = fileURLToPath(new URL('../../../AGENTS.md', import.meta.url));

let temp: string;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sf-rules-docs-'));
});
after(async () => {
  await rm(temp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A repository with the given files committed on main; returns its path and the commit.
async function repoWith(name: string, files: Record<string, string>, links: Record<string, string> = {}): Promise<{ repo: string; commit: string }> {
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
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'initial');
  return { repo, commit: git(repo, 'rev-parse', 'HEAD').trim() };
}

async function configWith(name: string, files: Record<string, string> = {}): Promise<string> {
  const config = join(temp, `${name}-config`);
  await mkdir(join(config, 'rules'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(config, path), content);
  }
  return config;
}

const options = (configDir: string, extra: Partial<RulesOptions> = {}): RulesOptions => ({ workspace: 'app', skip: [], configDir, maxBytes: 48 * 1024, ...extra });
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

test('markdownLinks: inline and reference links in order, titles and angle brackets dropped, fenced code and images skipped', () => {
  const text = [
    'See [a](docs/a.md) and [b](<docs/b c.md> "Title") and ![img](pic.png) and ![diagram](docs/unintended.md) and ![ref image][r1].',
    '```md',
    '[fenced](docs/fenced.md)',
    '```',
    '~~~',
    '[tilde](docs/tilde.md)',
    '~~~',
    'Then [ref][R1], [Collapsed][] and [missing][nope].',
    '[r1]: docs/r1.md "title"',
    '[collapsed]: <docs/collapsed.md>',
    '[after](docs/after.md#part)',
  ].join('\n');
  assert.deepEqual(markdownLinks(text), ['docs/a.md', 'docs/b c.md', 'docs/r1.md', 'docs/collapsed.md', 'docs/after.md#part']);
});

test('linkedPath: relative .md paths inside the repository only, fragment and query stripped', () => {
  assert.equal(linkedPath('AGENTS.md', 'docs/a.md'), 'docs/a.md');
  assert.equal(linkedPath('AGENTS.md', './docs/a.md#section'), 'docs/a.md');
  assert.equal(linkedPath('AGENTS.md', 'docs/a.md?plain=1'), 'docs/a.md');
  assert.equal(linkedPath('AGENTS.md', 'docs/my%20rules.md'), 'docs/my rules.md');
  assert.equal(linkedPath('AGENTS.md', 'docs/../README.md'), 'README.md');
  assert.equal(linkedPath('sub/AGENTS.md', '../docs/a.md'), 'docs/a.md');
  for (const target of ['../outside.md', 'docs/../../outside.md', '/etc/rules.md', '//host/rules.md', 'https://example.com/rules.md', 'file:///rules.md', 'mailto:a@b.md', 'docs/a.txt', 'docs/a.MDX', '#only-fragment', 'C:\\rules.md', 'docs\\a.md']) {
    assert.equal(linkedPath('AGENTS.md', target), undefined, target);
  }
});

test('collectRules: AGENTS.md, then its linked .md files inside the repository, one hop, in link order, once each; symlinks, missing files and outside links skipped', async () => {
  const agents = [
    '# Agents',
    '',
    '- [B](docs/b.md#style), [A](./docs/a.md), [B again](docs/b.md)',
    '- [Out](../outside.md), [Abs](/docs/a.md), [Web](https://example.com/x.md), [Missing](docs/missing.md)',
    '- [Link](docs/link.md), [Text](docs/notes.txt), [Dir](docs/dir.md), [Self](AGENTS.md), [Ref][r], ![Image](docs/image.md)',
    '',
    '```',
    '[In code](docs/code.md)',
    '```',
    '',
    '[r]: docs/r.md',
  ].join('\n');
  const { repo, commit } = await repoWith('links', {
    'AGENTS.md': agents,
    'CLAUDE.md': 'not taken: AGENTS.md exists\n',
    'docs/a.md': 'Rule A\n',
    'docs/b.md': 'Rule B, which links [C](c.md)\n',
    'docs/c.md': 'two hops: not taken\n',
    'docs/code.md': 'in a code block: not taken\n',
    'docs/r.md': 'Rule R\n',
    'docs/notes.txt': 'not Markdown\n',
    'docs/image.md': 'an image target: not taken\n',
    'docs/dir.md/inner.md': 'a directory named dir.md\n',
  }, { 'docs/link.md': '../../outside.md' });
  const config = await configWith('links');
  const { list, block } = await collectRules(repo, commit, options(config));
  assert.deepEqual(list.files.map((file) => [file.source, file.path]), [
    ['repository', 'AGENTS.md'], ['repository', 'docs/b.md'], ['repository', 'docs/a.md'], ['repository', 'docs/r.md'],
  ]);
  assert.deepEqual(list.files.map((file) => file.sha256), [sha256(agents), sha256('Rule B, which links [C](c.md)\n'), sha256('Rule A\n'), sha256('Rule R\n')]);
  assert.deepEqual(list.files.map((file) => file.bytes), [Buffer.byteLength(agents), 30, 7, 7]);
  assert.deepEqual([list.commit, list.left_out, list.skipped], [commit, [], []]);
  assert.equal(block, [
    '<rules>', RULES_SENTENCE,
    '', '### repository: AGENTS.md', '', agents,
    '', '### repository: docs/b.md', '', 'Rule B, which links [C](c.md)',
    '', '### repository: docs/a.md', '', 'Rule A',
    '', '### repository: docs/r.md', '', 'Rule R',
    '</rules>',
  ].join('\n'));
});

test('collectRules reads the base commit: later commits and uncommitted changes do not change the rules', async () => {
  const { repo, commit } = await repoWith('base', { 'AGENTS.md': 'See [a](docs/a.md).\n', 'docs/a.md': 'Old rule\n' });
  await writeFile(join(repo, 'docs/a.md'), 'New rule\n');
  await writeFile(join(repo, 'docs/b.md'), 'Added\n');
  await writeFile(join(repo, 'AGENTS.md'), 'See [a](docs/a.md) and [b](docs/b.md).\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'change the rules');
  await writeFile(join(repo, 'docs/a.md'), 'Uncommitted rule\n');
  const config = await configWith('base');
  const { list, block } = await collectRules(repo, commit, options(config));
  assert.deepEqual(list.files.map((file) => file.path), ['AGENTS.md', 'docs/a.md']);
  assert.match(block, /\nOld rule\n/);
  assert.doesNotMatch(block, /New rule|Uncommitted|Added/);
  const later = await collectRules(repo, git(repo, 'rev-parse', 'HEAD').trim(), options(config));
  assert.deepEqual(later.list.files.map((file) => file.path), ['AGENTS.md', 'docs/a.md', 'docs/b.md']);
  assert.match(later.block, /\nNew rule\n/);
});

test('collectRules: CLAUDE.md, else .github/copilot-instructions.md, alone without their links; a symlinked AGENTS.md is not taken', async () => {
  const config = await configWith('fallback');
  const claude = await repoWith('claude', { 'CLAUDE.md': 'See [a](docs/a.md).\n', 'docs/a.md': 'A\n', '.github/copilot-instructions.md': 'Copilot\n' }, { 'AGENTS.md': 'CLAUDE.md' });
  assert.deepEqual((await collectRules(claude.repo, claude.commit, options(config))).list.files.map((file) => file.path), ['CLAUDE.md']);
  const copilot = await repoWith('copilot', { '.github/copilot-instructions.md': 'See [a](../docs/a.md).\n', 'docs/a.md': 'A\n' });
  const collected = await collectRules(copilot.repo, copilot.commit, options(config));
  assert.deepEqual(collected.list.files.map((file) => [file.source, file.path]), [['repository', '.github/copilot-instructions.md']]);
  assert.match(collected.block, /### repository: \.github\/copilot-instructions\.md\n\nSee/);
});

test('collectRules: the workspace\'s rules file, then the global one, after the repository\'s; a workspace named global reads it once', async () => {
  const { repo, commit } = await repoWith('user', { 'AGENTS.md': 'Repo rule\n' });
  const config = await configWith('user', { 'rules/app.md': 'Workspace rule\n', 'rules/global.md': 'Global rule\n', 'rules/other.md': 'Not this workspace\n' });
  const { list, block } = await collectRules(repo, commit, options(config));
  assert.deepEqual(list.files.map((file) => [file.source, file.path]), [['repository', 'AGENTS.md'], ['workspace', 'rules/app.md'], ['global', 'rules/global.md']]);
  assert.match(block, /### repository: AGENTS\.md\n\nRepo rule\n\n### workspace: rules\/app\.md\n\nWorkspace rule\n\n### global: rules\/global\.md\n\nGlobal rule\n<\/rules>$/);
  const global = await collectRules(repo, commit, options(config, { workspace: 'global' }));
  assert.deepEqual(global.list.files.map((file) => [file.source, file.path]), [['repository', 'AGENTS.md'], ['workspace', 'rules/global.md']]);
  // A rules directory entry that is not a file is not a rules file.
  const odd = await configWith('odd');
  await mkdir(join(odd, 'rules', 'app.md'));
  assert.deepEqual((await collectRules(repo, commit, options(odd))).list.files.map((file) => file.path), ['AGENTS.md']);
});

test('the budget: files taken whole in order; the first that does not fit and every later one are left out and named in the closing line', async () => {
  const { repo, commit } = await repoWith('budget', { 'AGENTS.md': 'See [a](a.md), [big](big.md), [c](c.md).\n', 'a.md': 'A'.repeat(10), 'big.md': 'B'.repeat(100), 'c.md': 'C' });
  const config = await configWith('budget', { 'rules/global.md': 'G' });
  const agentsBytes = Buffer.byteLength('See [a](a.md), [big](big.md), [c](c.md).\n');
  const { list, block } = await collectRules(repo, commit, options(config, { maxBytes: agentsBytes + 10 + 50 }));
  assert.deepEqual(list.files.map((file) => file.path), ['AGENTS.md', 'a.md']);
  assert.deepEqual(list.left_out, [{ source: 'repository', path: 'big.md', bytes: 100 }, { source: 'repository', path: 'c.md', bytes: 1 }, { source: 'global', path: 'rules/global.md', bytes: 1 }]);
  assert.match(block, new RegExp(`\\n\\n${LEFT_OUT_LEAD} big\\.md, c\\.md, rules/global\\.md\\n</rules>$`));
  assert.doesNotMatch(block, /BBBB|\nC\n|\nG\n/);
  // Exactly at the budget, everything fits.
  const exact = await collectRules(repo, commit, options(config, { maxBytes: agentsBytes + 10 + 100 + 1 + 1 }));
  assert.deepEqual([exact.list.files.length, exact.list.left_out], [5, []]);
  assert.doesNotMatch(exact.block, /Not included/);
  // A first file over the budget: only the sentence and the closing line.
  const none = await collectRules(repo, commit, options(config, { maxBytes: 1 }));
  assert.deepEqual(none.list.files, []);
  assert.equal(none.block, `<rules>\n${RULES_SENTENCE}\n\n${LEFT_OUT_LEAD} AGENTS.md, a.md, big.md, c.md, rules/global.md\n</rules>`);
});

test('a large AGENTS.md is read whole for its links: a link past 4 MiB still counts, and is left out by the budget with AGENTS.md', async () => {
  const agents = `${'x'.repeat(5 * 1024 * 1024)}\n\nSee [late](docs/late.md).\n`;
  const { repo, commit } = await repoWith('large', { 'AGENTS.md': agents, 'docs/late.md': 'Late rule\n' });
  const config = await configWith('large');
  const { list, block } = await collectRules(repo, commit, options(config));
  assert.deepEqual(list.files, []);
  assert.deepEqual(list.left_out, [{ source: 'repository', path: 'AGENTS.md', bytes: Buffer.byteLength(agents) }, { source: 'repository', path: 'docs/late.md', bytes: 10 }]);
  assert.match(block, /\nNot included, read them if relevant: AGENTS\.md, docs\/late\.md\n<\/rules>$/);
  const all = await collectRules(repo, commit, options(config, { maxBytes: 16 * 1024 * 1024 }));
  assert.deepEqual(all.list.files.map((file) => file.path), ['AGENTS.md', 'docs/late.md']);
});

test('no rule files: no block', async () => {
  const { repo, commit } = await repoWith('none', { 'README.md': 'hello\n', 'docs/a.md': 'not linked\n' });
  const config = await configWith('none');
  assert.deepEqual(await collectRules(repo, commit, options(config)), { list: { commit, max_bytes: 48 * 1024, files: [], left_out: [], skipped: [] }, block: '' });
});

test("rules_skip with this repository's layout: AGENTS.md points the coordinator at docs/runbooks/coordinator.md, which the workspace skips", async () => {
  const agents = await readFile(OWN_AGENTS, 'utf8');
  assert.match(agents, /\(docs\/runbooks\/coordinator\.md\)/);
  const { repo, commit } = await repoWith('own', { 'AGENTS.md': agents, 'CLAUDE.md': '# Software Factory\n', 'docs/runbooks/coordinator.md': '# Coordinator\n', 'factory/HANDBOOK.md': '# Handbook\n' });
  const config = await configWith('own', { 'rules/software-factory.md': 'Mine\n' });
  const all = await collectRules(repo, commit, options(config, { workspace: 'software-factory' }));
  assert.deepEqual(all.list.files.map((file) => file.path), ['AGENTS.md', 'docs/runbooks/coordinator.md', 'rules/software-factory.md']);
  const skipped = await collectRules(repo, commit, options(config, { workspace: 'software-factory', skip: ['docs/runbooks/coordinator.md'] }));
  assert.deepEqual(skipped.list.files.map((file) => file.path), ['AGENTS.md', 'rules/software-factory.md']);
  assert.deepEqual(skipped.list.skipped, ['docs/runbooks/coordinator.md']);
  assert.doesNotMatch(skipped.block, /Coordinator/);
  // Globs, and never the factory's own rules files.
  const globbed = await collectRules(repo, commit, options(config, { workspace: 'software-factory', skip: ['docs/**', 'rules/*'] }));
  assert.deepEqual(globbed.list.files.map((file) => file.path), ['AGENTS.md', 'rules/software-factory.md']);
});

test("the job's copies: rules.md and rules.json written once, the block read back, rules.json copied into an iteration; nothing for a job without rules.md", async () => {
  const { repo, commit } = await repoWith('copies', { 'AGENTS.md': 'Rule\n' });
  const collected = await collectRules(repo, commit, options(await configWith('copies')));
  const jobDir = join(temp, 'job');
  await mkdir(jobDir);
  assert.equal(await readJobRules(jobDir), '');
  await copyRulesRecord(jobDir, join(jobDir, 'iterations', '001'));
  await assert.rejects(readFile(join(jobDir, 'iterations', '001', 'rules.json')), { code: 'ENOENT' });
  await writeJobRules(jobDir, collected);
  assert.equal(await readJobRules(jobDir), collected.block);
  assert.deepEqual(JSON.parse(await readFile(join(jobDir, 'rules.json'), 'utf8')), collected.list);
  await copyRulesRecord(jobDir, join(jobDir, 'iterations', '002'));
  assert.deepEqual(JSON.parse(await readFile(join(jobDir, 'iterations', '002', 'rules.json'), 'utf8')), collected.list);
});

test('rulesBlock and rulesLines: the headings and sentence; sf rules lists paths, sources and sizes, never the text', () => {
  assert.equal(rulesBlock([{ source: 'global', path: 'rules/global.md', text: 'X\n\n' }], []), `<rules>\n${RULES_SENTENCE}\n\n### global: rules/global.md\n\nX\n</rules>`);
  const lines = rulesLines('app', {
    commit: 'abc', max_bytes: 100, files: [{ source: 'repository', path: 'AGENTS.md', bytes: 12, sha256: 'f'.repeat(64) }],
    left_out: [{ source: 'global', path: 'rules/global.md', bytes: 500 }], skipped: ['docs/x.md'],
  });
  assert.deepEqual(lines, [
    'Rules for app at abc (budget 100 bytes):', '  repository  AGENTS.md  12 bytes',
    'Left out (over the budget):', '  global  rules/global.md  500 bytes',
    'Skipped by rules_skip:', '  repository  docs/x.md',
  ]);
  assert.deepEqual(rulesLines('app', { commit: 'abc', max_bytes: 100, files: [], left_out: [], skipped: [] }), ['Rules for app at abc (budget 100 bytes):', '  No rule files found.']);
});

test('an unreadable rules file fails the collection with its config-relative path, never the absolute one', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads any file');
    return;
  }
  const { repo, commit } = await repoWith('unreadable', { 'AGENTS.md': 'Rule\n' });
  const config = await configWith('unreadable', { 'rules/app.md': 'Mine\n' });
  await chmod(join(config, 'rules', 'app.md'), 0o000);
  await assert.rejects(collectRules(repo, commit, options(config)), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'rules_failed');
    assert.equal(error.message, 'The rules file rules/app.md could not be read (EACCES).');
    return true;
  });
  await chmod(join(config, 'rules', 'app.md'), 0o600);
});
