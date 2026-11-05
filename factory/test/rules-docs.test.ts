// Unit tests of the coding rules (SF-059): the links of AGENTS.md, the paths they may name, the
// collection at a commit (instruction file, linked files, the user's rules files), the budget
// (SF-093: the user's files first and cut when over it, repository files skipped one by one) and
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

// The content given never exceeds the budget.
function assertWithinBudget(list: { max_bytes: number; files: ReadonlyArray<{ bytes: number }> }): void {
  assert.ok(list.files.reduce((sum, file) => sum + file.bytes, 0) <= list.max_bytes, `over the budget of ${list.max_bytes}`);
}

test("the budget: the user's files first, then the repository's in link order, each taken whole when it fits what is left, else left out while the next is still tried", async () => {
  const { repo, commit } = await repoWith('budget', { 'AGENTS.md': 'See [a](a.md), [big](big.md), [c](c.md).\n', 'a.md': 'A'.repeat(10), 'big.md': 'B'.repeat(100), 'c.md': 'C' });
  const config = await configWith('budget', { 'rules/global.md': 'G' });
  const agentsBytes = Buffer.byteLength('See [a](a.md), [big](big.md), [c](c.md).\n');
  assert.equal(agentsBytes, 41);
  const { list, block } = await collectRules(repo, commit, options(config, { maxBytes: agentsBytes + 60 }));
  assert.deepEqual(list.files.map((file) => file.path), ['AGENTS.md', 'a.md', 'c.md', 'rules/global.md']);
  assert.deepEqual(list.left_out, [{ source: 'repository', path: 'big.md', bytes: 100 }]);
  assert.match(block, /### repository: AGENTS\.md\n[^]*### repository: a\.md\n[^]*### repository: c\.md\n\nC\n\n### global: rules\/global\.md\n\nG\n/);
  assert.match(block, new RegExp(`\\n\\n${LEFT_OUT_LEAD} big\\.md\\n</rules>$`));
  assert.doesNotMatch(block, /BBBB/);
  assertWithinBudget(list);
  // Exactly at the budget, everything fits.
  const exact = await collectRules(repo, commit, options(config, { maxBytes: agentsBytes + 10 + 100 + 1 + 1 }));
  assert.deepEqual([exact.list.files.length, exact.list.left_out], [5, []]);
  assert.doesNotMatch(exact.block, /Not included/);
  // A budget the user's file fills: only it, then the closing line naming every repository file.
  const none = await collectRules(repo, commit, options(config, { maxBytes: 1 }));
  assert.deepEqual(none.list.files.map((file) => file.path), ['rules/global.md']);
  assert.deepEqual(none.list.left_out.map((file) => file.path), ['AGENTS.md', 'a.md', 'big.md', 'c.md']);
  assert.equal(none.block, `<rules>\n${RULES_SENTENCE}\n\n### global: rules/global.md\n\nG\n\n${LEFT_OUT_LEAD} AGENTS.md, a.md, big.md, c.md\n</rules>`);
  assertWithinBudget(none.list);
});

test('a large AGENTS.md is read whole for its links: a link past 4 MiB still counts, and is given while AGENTS.md is left out by the budget', async () => {
  const agents = `${'x'.repeat(5 * 1024 * 1024)}\n\nSee [late](docs/late.md).\n`;
  const { repo, commit } = await repoWith('large', { 'AGENTS.md': agents, 'docs/late.md': 'Late rule\n' });
  const config = await configWith('large');
  const { list, block } = await collectRules(repo, commit, options(config));
  assert.deepEqual(list.files.map((file) => [file.path, file.bytes]), [['docs/late.md', 10]]);
  assert.deepEqual(list.left_out, [{ source: 'repository', path: 'AGENTS.md', bytes: Buffer.byteLength(agents) }]);
  assert.match(block, /### repository: docs\/late\.md\n\nLate rule\n\nNot included, read them if relevant: AGENTS\.md\n<\/rules>$/);
  const all = await collectRules(repo, commit, options(config, { maxBytes: 16 * 1024 * 1024 }));
  assert.deepEqual(all.list.files.map((file) => file.path), ['AGENTS.md', 'docs/late.md']);
});

test('a big repository file between small ones does not push out the small ones after it', async () => {
  const { repo, commit } = await repoWith('between', { 'AGENTS.md': 'See [one](docs/one.md), [e2e](docs/e2e.md), [two](docs/two.md), [three](docs/three.md).\n', 'docs/one.md': 'One\n', 'docs/e2e.md': 'E'.repeat(60 * 1024), 'docs/two.md': 'Two\n', 'docs/three.md': 'Three\n' });
  const config = await configWith('between', { 'rules/app.md': 'Mine\n' });
  const { list, block } = await collectRules(repo, commit, options(config));
  assert.deepEqual(list.files.map((file) => file.path), ['AGENTS.md', 'docs/one.md', 'docs/two.md', 'docs/three.md', 'rules/app.md']);
  assert.deepEqual(list.left_out, [{ source: 'repository', path: 'docs/e2e.md', bytes: 60 * 1024 }]);
  assert.match(block, /\nOne\n\n### repository: docs\/two\.md\n\nTwo\n\n### repository: docs\/three\.md\n\nThree\n\n### workspace: rules\/app\.md\n\nMine\n\nNot included, read them if relevant: docs\/e2e\.md\n<\/rules>$/);
  assertWithinBudget(list);
});

test("the workspace's and the global rules are given even when the repository's files alone exceed the budget", async () => {
  const agents = `See [big](big.md).${'.'.repeat(11)}\n`;
  const { repo, commit } = await repoWith('reserved', { 'AGENTS.md': agents, 'big.md': 'B'.repeat(200) });
  const config = await configWith('reserved', { 'rules/app.md': 'W'.repeat(10), 'rules/global.md': 'G'.repeat(5) });
  const { list, block } = await collectRules(repo, commit, options(config, { maxBytes: 50 }));
  assert.equal(Buffer.byteLength(agents), 30);
  assert.deepEqual(list.files.map((file) => [file.source, file.path, file.bytes]), [['repository', 'AGENTS.md', 30], ['workspace', 'rules/app.md', 10], ['global', 'rules/global.md', 5]]);
  assert.deepEqual(list.left_out, [{ source: 'repository', path: 'big.md', bytes: 200 }]);
  assert.match(block, /### repository: AGENTS\.md\n[^]*### workspace: rules\/app\.md\n\nW{10}\n\n### global: rules\/global\.md\n\nG{5}\n\nNot included, read them if relevant: big\.md\n<\/rules>$/);
  assertWithinBudget(list);
  // A budget the user's files fill: no repository file at all.
  const full = await collectRules(repo, commit, options(config, { maxBytes: 15 }));
  assert.deepEqual(full.list.files.map((file) => file.path), ['rules/app.md', 'rules/global.md']);
  assert.deepEqual(full.list.left_out.map((file) => file.path), ['AGENTS.md', 'big.md']);
  assertWithinBudget(full.list);
});

test("a user's file over what is left is cut at the last full UTF-8 character, with its closing line; the global one is left out when nothing is left", async () => {
  const { repo, commit } = await repoWith('cut', { 'AGENTS.md': 'Repo rule\n' });
  // The euro sign (3 bytes) spans bytes 8 to 10, across the budget of 10: the cut keeps 8 bytes.
  const workspace = 'abcdefgh\u20acxyz';
  const config = await configWith('cut', { 'rules/app.md': workspace, 'rules/global.md': 'GGGG' });
  const { list, block } = await collectRules(repo, commit, options(config, { maxBytes: 10 }));
  assert.deepEqual(list.files, [
    { source: 'workspace', path: 'rules/app.md', bytes: 8, sha256: sha256('abcdefgh'), cut_from: 14 },
    { source: 'global', path: 'rules/global.md', bytes: 2, sha256: sha256('GG'), cut_from: 4 },
  ]);
  assert.deepEqual(list.left_out, [{ source: 'repository', path: 'AGENTS.md', bytes: 10 }]);
  assert.equal(block, [
    '<rules>', RULES_SENTENCE,
    '', '### workspace: rules/app.md', '', 'abcdefgh', '[cut at the budget: 8 of 14 bytes given]',
    '', '### global: rules/global.md', '', 'GG', '[cut at the budget: 2 of 4 bytes given]',
    '', `${LEFT_OUT_LEAD} AGENTS.md`, '</rules>',
  ].join('\n'));
  assertWithinBudget(list);
  // A workspace file cut exactly at the budget leaves nothing: the global one is left out, with its full size.
  const filled = await configWith('filled', { 'rules/app.md': 'W'.repeat(30), 'rules/global.md': 'G' });
  const cut = await collectRules(repo, commit, options(filled, { maxBytes: 10 }));
  assert.deepEqual(cut.list.files, [{ source: 'workspace', path: 'rules/app.md', bytes: 10, sha256: sha256('W'.repeat(10)), cut_from: 30 }]);
  assert.deepEqual(cut.list.left_out, [{ source: 'repository', path: 'AGENTS.md', bytes: 10 }, { source: 'global', path: 'rules/global.md', bytes: 1 }]);
  assert.match(cut.block, /\nW{10}\n\[cut at the budget: 10 of 30 bytes given\]\n\nNot included, read them if relevant: AGENTS\.md, rules\/global\.md\n<\/rules>$/);
  assertWithinBudget(cut.list);
  // Files given whole carry no cut_from.
  const whole = await collectRules(repo, commit, options(filled));
  assert.ok(whole.list.files.every((file) => !('cut_from' in file)));
  // rules_skip and the budget together: still within it.
  const skipped = await collectRules(repo, commit, options(filled, { maxBytes: 10, skip: ['AGENTS.md'] }));
  assert.deepEqual(skipped.list.skipped, ['AGENTS.md']);
  assertWithinBudget(skipped.list);
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
  // A cut file: its given size, then the full one.
  assert.deepEqual(rulesLines('app', { commit: 'abc', max_bytes: 100, files: [{ source: 'workspace', path: 'rules/app.md', bytes: 100, sha256: 'f'.repeat(64), cut_from: 250 }], left_out: [], skipped: [] }), [
    'Rules for app at abc (budget 100 bytes):', '  workspace  rules/app.md  100 bytes (cut from 250 bytes)',
  ]);
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
