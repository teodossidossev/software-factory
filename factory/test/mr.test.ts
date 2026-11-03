// Unit tests for the MR preparation rules: the commit header, the MR text, the merge request link,
// the snapshot commit and the diff check by three-way merge, the push protection, the Handbook section extraction, the MR prompt,
// the deny lists and the sandbox settings.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandboxSettings } from '../src/config.js';
import { ABSENT, compareSnapshot, deleteSnapshotRef, expectedMerge, mergeRequestLink, mrTextProblem, pushProtection, snapshotDiff, takeSnapshot } from '../src/mr.js';
import { FACTORY_PROMPT_RULES, handbookSection, mrPrompt } from '../src/prompts.js';
import { COMMIT_TYPES, commitHeader, DENIED_TOOLS, headerProblem, MR_DENIED_TOOLS } from '../src/rules.js';
import { quickStartSection } from '../src/server.js';

const HANDBOOK = fileURLToPath(new URL('../../HANDBOOK.md', import.meta.url));

const VALID_MR_TEXT = [
  'feat(T-1): Change the README',
  '',
  '## What', 'x', '## Why', 'x', '## How', 'x', '## Why the change', 'x', '## Special things to note', '- None.',
  '## Change outline', 'x', '## Testing', 'x', '## Screenshots', 'N/A', '## Checklist', '- [x] Branch name', '',
].join('\n');

test('commitHeader accepts every type with the ticket as scope and refuses the rest', () => {
  for (const type of COMMIT_TYPES) {
    assert.ok(commitHeader('PROJ-12').test(`${type}(PROJ-12): Add the export`), type);
  }
  assert.equal(COMMIT_TYPES.length, 11);
  const header = commitHeader('PROJ-12');
  for (const bad of [
    'feat(PROJ-13): Add the export',
    'feat(PROJ-1): Add the export',
    'feat: Add the export',
    'PROJ-12: Add the export',
    'feature(PROJ-12): Add the export',
    'feat(PROJ-12): Add the export.',
    'feat(PROJ-12):  ',
    'feat(PROJ-12):Add',
  ]) {
    assert.ok(!header.test(bad), bad);
  }
  // A ticket with regex characters is matched literally.
  assert.ok(!commitHeader('A.1').test('fix(AX1): Repair it'));
  const prefix = 'fix(PROJ-12): ';
  assert.ok(header.test(prefix + 'a'.repeat(72 - prefix.length)));
  assert.ok(!header.test(prefix + 'a'.repeat(73 - prefix.length)));
  assert.equal(headerProblem('PROJ-12', 'fix(PROJ-12): Repair it'), undefined);
  assert.equal(headerProblem('PROJ-12', prefix + 'a'.repeat(73 - prefix.length)), 'it has 73 characters, more than 72');
  assert.equal(headerProblem('PROJ-12', 'fix(PROJ-12): Repair it.'), 'it ends with a period');
  assert.match(headerProblem('PROJ-12', 'fix(PROJ-1): Repair it')!, /^it must match "<type>\(PROJ-12\): <imperative summary>"/);
});

test('mrTextProblem checks the title and every required heading but Screenshots', () => {
  assert.equal(mrTextProblem('T-1', VALID_MR_TEXT), undefined);
  assert.equal(mrTextProblem('T-1', VALID_MR_TEXT.replace('## Screenshots\nN/A\n', '')), undefined);
  assert.equal(mrTextProblem('T-1', '  \n'), 'it is empty');
  assert.match(mrTextProblem('T-1', VALID_MR_TEXT.replace('feat(T-1)', 'feat(T-2)'))!, /^its first line "feat\(T-2\): Change the README" is not a valid title/);
  assert.equal(mrTextProblem('T-1', VALID_MR_TEXT.replace('## Why the change\n', '').replace('## Checklist\n', '')), 'it lacks the heading(s) ## Why the change, ## Checklist');
  assert.match(mrTextProblem('T-1', `${VALID_MR_TEXT}${'x'.repeat(64 * 1024)}`)!, /more than 65536/);
  // The title must equal the commit subject.
  assert.equal(mrTextProblem('T-1', VALID_MR_TEXT, 'feat(T-1): Change the README'), undefined);
  assert.equal(
    mrTextProblem('T-1', VALID_MR_TEXT, 'docs(T-1): Change the README'),
    'its title "feat(T-1): Change the README" differs from the commit subject "docs(T-1): Change the README"',
  );
});

test('mergeRequestLink derives GitHub and GitLab pages from https and ssh origin URLs', () => {
  assert.equal(mergeRequestLink('https://github.com/acme/app.git', 'main', 'T-1-x'), 'https://github.com/acme/app/compare/main...T-1-x?expand=1');
  assert.equal(mergeRequestLink('git@github.com:acme/app.git', 'main', 'T-1-x'), 'https://github.com/acme/app/compare/main...T-1-x?expand=1');
  const gitlab = 'merge_requests/new?merge_request[source_branch]=T-1-x&merge_request[target_branch]=develop';
  assert.equal(mergeRequestLink('https://gitlab.example.com/group/sub/app.git', 'develop', 'T-1-x'), `https://gitlab.example.com/group/sub/app/-/${gitlab}`);
  assert.equal(mergeRequestLink('https://user@gitlab.example.com:8443/group/app', 'develop', 'T-1-x'), `https://gitlab.example.com:8443/group/app/-/${gitlab}`);
  assert.equal(mergeRequestLink('git@gitlab.example.com:group/app.git', 'develop', 'T-1-x'), `https://gitlab.example.com/group/app/-/${gitlab}`);
  assert.equal(mergeRequestLink('ssh://git@gitlab.example.com:2222/group/app.git', 'develop', 'T-1-x'), `https://gitlab.example.com/group/app/-/${gitlab}`);
  for (const unparseable of ['/tmp/origin.git', 'file:///tmp/origin.git', '../origin', 'https://github.com/', 'C:\\repos\\app']) {
    assert.equal(mergeRequestLink(unparseable, 'main', 'T-1-x'), undefined, unparseable);
  }
});

test('compareSnapshot compares the merge result with the branch per path; absent on both sides is equal', () => {
  // expected: the blobs of the clean three-way merge's tree; actual: the branch's blobs.
  const expected = { 'README.md': 'aaa', 'gone.txt': ABSENT, 'src/x.ts': 'bbb', 'upstream.txt': 'uuu' };
  assert.deepEqual(compareSnapshot(expected, { 'README.md': 'aaa', 'gone.txt': ABSENT, 'src/x.ts': 'bbb', 'upstream.txt': 'uuu' }), []);
  assert.deepEqual(compareSnapshot(expected, { 'README.md': 'aaa', 'gone.txt': ABSENT, 'src/x.ts': 'ccc', 'upstream.txt': 'uuu', 'extra.txt': 'ddd' }), ['extra.txt', 'src/x.ts']);
  // A reviewed file missing from the branch, and a deletion that was not made.
  assert.deepEqual(compareSnapshot(expected, { 'README.md': ABSENT, 'gone.txt': 'eee', 'src/x.ts': 'bbb', 'upstream.txt': 'uuu' }), ['README.md', 'gone.txt']);
  assert.deepEqual(compareSnapshot({}, {}), []);
});

test('takeSnapshot commits the reviewed working tree in a temporary index; snapshotDiff compares the branch with the three-way merge', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sf-snapshot-')));
  try {
    const repo = join(dir, 'repo');
    const jobDir = join(dir, 'job');
    const sh = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('mkdir', ['-p', jobDir]);
    const nine = (edit: Record<number, string>): string => `${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => edit[n] ?? String(n)).join('\n')}\n`;
    await writeFile(join(repo, 'f.txt'), nine({}));
    await writeFile(join(repo, 'gone.txt'), 'gone\n');
    await writeFile(join(repo, 'run.sh'), 'echo\n');
    sh('add', '.');
    sh('commit', '-q', '-m', 'base');
    const base = sh('rev-parse', 'HEAD');
    // The reviewed change, uncommitted: an edit, a deletion, an executable, a new file, a symlink.
    await writeFile(join(repo, 'f.txt'), nine({ 9: '9 change' }));
    await unlink(join(repo, 'gone.txt'));
    await chmod(join(repo, 'run.sh'), 0o755);
    await writeFile(join(repo, 'new.txt'), 'new\n');
    await symlink('f.txt', join(repo, 'link'));
    sh('add', 'f.txt');
    const indexBefore = sh('ls-files', '-s');
    const snapshot = await takeSnapshot(repo, 'T-1', base, { ref: 'main', commit: base }, jobDir);
    assert.deepEqual(snapshot.paths, ['f.txt', 'gone.txt', 'link', 'new.txt', 'run.sh']);
    assert.equal(sh('rev-parse', 'refs/sf/snapshot/T-1'), snapshot.snapshot_commit);
    assert.equal(sh('rev-parse', `${snapshot.snapshot_commit}^`), base);
    assert.equal(sh('ls-tree', '--name-only', snapshot.snapshot_commit).split('\n').join(','), 'f.txt,link,new.txt,run.sh');
    assert.match(sh('ls-tree', snapshot.snapshot_commit, 'link'), /^120000 blob /);
    assert.equal(sh('cat-file', '-p', `${snapshot.snapshot_commit}:link`), 'f.txt');
    assert.match(sh('ls-tree', snapshot.snapshot_commit, 'run.sh'), /^100755 /);
    // The work checkout's index, HEAD and files are untouched; the temporary files are gone.
    assert.equal(sh('ls-files', '-s'), indexBefore);
    assert.equal(sh('rev-parse', 'HEAD'), base);
    await assert.rejects(stat(join(jobDir, 'snapshot.index')), { code: 'ENOENT' });

    // The Implementer commits the change; the target moves in another hunk of f.txt and adds a file.
    sh('checkout', '-q', '-b', 'T-1-x');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'feat(T-1): Change');
    sh('checkout', '-q', 'main');
    await writeFile(join(repo, 'f.txt'), nine({ 1: '1 upstream' }));
    await writeFile(join(repo, 'up.txt'), 'up\n');
    sh('add', '.');
    sh('commit', '-q', '-m', 'upstream');
    const target = sh('rev-parse', 'HEAD');
    sh('checkout', '-q', 'T-1-x');
    sh('rebase', '-q', 'main');
    const moved = { ...snapshot, target_commit: target };
    assert.deepEqual((await expectedMerge(repo, moved)).conflicted, []);
    assert.deepEqual(await snapshotDiff(repo, moved, 'T-1-x'), []);
    // An extra change on the branch, and a reviewed path dropped from it.
    await writeFile(join(repo, 'extra.txt'), 'extra\n');
    await rm(join(repo, 'new.txt'));
    sh('add', '-A');
    sh('commit', '-q', '--amend', '-m', 'feat(T-1): Change');
    assert.deepEqual(await snapshotDiff(repo, moved, 'T-1-x'), ['extra.txt', 'new.txt']);

    // A target that conflicts with the change in line 9: the conflicted path counts as differing
    // whatever the branch holds.
    sh('checkout', '-q', '-b', 'other', base);
    await writeFile(join(repo, 'f.txt'), nine({ 9: '9 upstream' }));
    sh('commit', '-q', '-am', 'conflicting');
    const conflicting = { ...snapshot, target_commit: sh('rev-parse', 'HEAD') };
    assert.deepEqual((await expectedMerge(repo, conflicting)).conflicted, ['f.txt']);
    assert.deepEqual(await snapshotDiff(repo, conflicting, 'T-1-x'), ['extra.txt', 'f.txt', 'new.txt', 'up.txt']);

    assert.equal(await deleteSnapshotRef(repo, 'T-1'), true);
    assert.throws(() => sh('rev-parse', '--verify', '--quiet', 'refs/sf/snapshot/T-1'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('handbookSection extracts by heading and skips "## " lines inside fences; mrPrompt sends them verbatim', async () => {
  const handbook = await readFile(HANDBOOK, 'utf8');
  const rules = handbookSection(handbook, '## Git rules');
  assert.match(rules, /^## Git rules\n\n- The branch is `<ticket>-<slug>`/);
  assert.match(rules, /Header `<type>\(<ticket>\): <imperative summary>`/);
  assert.ok(rules.endsWith('pointer unless the Task file asks for it.'));
  const template = handbookSection(handbook, '## MR template');
  assert.match(template, /^## MR template\n/);
  for (const heading of ['## What', '## Why', '## How', '## Why the change', '## Special things to note', '## Change outline', '## Testing', '## Screenshots', '## Checklist']) {
    assert.match(template, new RegExp(`^${heading}$`, 'm'), heading);
  }
  assert.ok(template.endsWith('- [ ] Browser support verified\n```'));
  assert.doesNotMatch(template, /What the factory never does/);
  assert.equal(quickStartSection(handbook), handbookSection(handbook, '## Quick start'));
  assert.match(handbookSection(handbook, '## Quick start'), /When `check` says `pushed` or `aborted`, the ticket is finished for you/);
  assert.throws(() => handbookSection(handbook, '## Nope'), /no "## Nope" section/);

  const input = { ticket: 'T-1', branch: 'T-1-x', targetRef: 'origin/main', targetCommit: 'a'.repeat(40), attempt: 1, handbook };
  const prompt = mrPrompt(input);
  assert.match(prompt, /^MR preparation for T-1 on branch T-1-x\. .*\nTarget: origin\/main at a{40}\.\n/);
  assert.ok(prompt.includes(rules) && prompt.endsWith(template));
  assert.match(prompt, /`git rebase origin\/main`/);
  // Staging by path, amend on a second approve, the branch query that is not denied.
  assert.match(prompt, /^1\. Stage the files of the reviewed change by path \(`git add <path>\.\.\.`\); never `git add -A`, `git add \.` or `git add -u`\./m);
  assert.match(prompt, /placeholder files such as \.bashrc, \.gitconfig, \.idea and \.mcp\.json as untracked; they are not part of the change/);
  assert.match(prompt, /^2\. .*already has a commit on top of origin\/main .*amend that commit \(`git commit --amend`\) instead of adding a second one\.$/m);
  assert.match(prompt, /the title, exactly the commit subject/);
  assert.match(prompt, /use `git rev-parse --abbrev-ref HEAD`; `git branch` is denied\./);
  assert.match(prompt, /\.software-factory\/T-1\.mr\.md/);
  assert.match(prompt, /Do not edit \.software-factory\/T-1\.md;/);
  assert.match(prompt, /^ {2}# Report: T-1, MR preparation 1$/m);
  assert.ok(!prompt.includes(FACTORY_PROMPT_RULES.split('\n')[1]!));
  assert.doesNotMatch(prompt, /previous attempt/);
  assert.match(mrPrompt({ ...input, attempt: 2, previousError: 'The commit header is bad.' }), /attempt 2\. The previous attempt failed the factory's checks: The commit header is bad\./);
});

test('the MR deny list allows staging, committing and rebasing; push and the rest stay denied', () => {
  for (const command of ['add', 'commit', 'rebase', 'restore', 'checkout', 'switch', 'rm', 'mv']) {
    assert.ok(DENIED_TOOLS.includes(`Bash(git ${command}:*)`), command);
    assert.ok(!MR_DENIED_TOOLS.includes(`Bash(git ${command}:*)`), command);
  }
  for (const command of ['push', 'reset', 'clean', 'stash', 'merge', 'cherry-pick', 'revert', 'tag', 'branch', 'config', 'update-ref', 'update-index', 'worktree', 'am', 'pull', 'fetch']) {
    assert.ok(MR_DENIED_TOOLS.includes(`Bash(git ${command}:*)`), command);
  }
  for (const rule of ['Bash(sudo:*)', 'EnterWorktree', 'Edit(.git/**)', 'Write(.git/**)', 'Read(**/.env)', 'Write(**/.env.*)']) {
    assert.ok(MR_DENIED_TOOLS.includes(rule) && DENIED_TOOLS.includes(rule), rule);
  }
});

test('sandboxSettings allows the npm registry plus SF_SANDBOX_DOMAINS, local binding and Unix sockets, and SF_SANDBOX=off disables it', () => {
  assert.deepEqual(sandboxSettings({}), {
    enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
    network: { allowedDomains: ['registry.npmjs.org'], allowLocalBinding: true, allowAllUnixSockets: true },
  });
  assert.deepEqual(sandboxSettings({ SF_SANDBOX_DOMAINS: ' pypi.org, *.example.com ,,registry.npmjs.org' })!.network, {
    allowedDomains: ['registry.npmjs.org', 'pypi.org', '*.example.com'], allowLocalBinding: true, allowAllUnixSockets: true,
  });
  assert.equal(sandboxSettings({ SF_SANDBOX: 'off', SF_SANDBOX_DOMAINS: 'pypi.org' }), undefined);
  assert.throws(() => sandboxSettings({ SF_SANDBOX_DOMAINS: 'https://x' }), /invalid domain/);
});

test('pushProtection refuses main, master and the base branch, and allows a ticket branch', () => {
  for (const [branch, base] of [['main', 'develop'], ['master', 'main'], ['release-1', 'release-1'], ['main', 'main']] as const) {
    const failure = pushProtection(branch, base);
    assert.equal(failure?.code, 'mr_push_protected', `${branch} onto ${base}`);
    assert.match(failure.message, /merge request/);
  }
  assert.equal(pushProtection('T-1-change-readme', 'main'), undefined);
  assert.equal(pushProtection('main-fix', 'master'), undefined);
});
