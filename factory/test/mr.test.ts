// Unit tests for the MR preparation rules: the commit header, the MR text, the merge request link,
// the snapshot comparison, the Handbook section extraction, the MR prompt, the deny lists and the
// sandbox settings.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandboxSettings } from '../src/config.js';
import { compareSnapshot, mergeRequestLink, mrTextProblem } from '../src/mr.js';
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

test('compareSnapshot names every path added, removed or changed against the snapshot', () => {
  const snapshot = { 'README.md': 'aaa', 'gone.txt': 'absent', 'src/x.ts': 'bbb' };
  assert.deepEqual(compareSnapshot(snapshot, { 'README.md': 'aaa', 'gone.txt': 'absent', 'src/x.ts': 'bbb' }), []);
  assert.deepEqual(compareSnapshot(snapshot, { 'README.md': 'aaa', 'gone.txt': 'absent', 'src/x.ts': 'ccc', 'extra.txt': 'ddd' }), ['extra.txt', 'src/x.ts']);
  // A reviewed file missing from the commit, and a deletion that was not made.
  assert.deepEqual(compareSnapshot(snapshot, { 'gone.txt': 'eee', 'src/x.ts': 'bbb' }), ['README.md', 'gone.txt']);
  assert.deepEqual(compareSnapshot({}, {}), []);
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
  assert.match(handbookSection(handbook, '## Quick start'), /`pushed`, `aborted` or `failed`/);
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

test('sandboxSettings allows the npm registry plus SF_SANDBOX_DOMAINS, and SF_SANDBOX=off disables it', () => {
  assert.deepEqual(sandboxSettings({}), {
    enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, network: { allowedDomains: ['registry.npmjs.org'] },
  });
  assert.deepEqual(sandboxSettings({ SF_SANDBOX_DOMAINS: ' pypi.org, *.example.com ,,registry.npmjs.org' })!.network, {
    allowedDomains: ['registry.npmjs.org', 'pypi.org', '*.example.com'],
  });
  assert.equal(sandboxSettings({ SF_SANDBOX: 'off', SF_SANDBOX_DOMAINS: 'pypi.org' }), undefined);
  assert.throws(() => sandboxSettings({ SF_SANDBOX_DOMAINS: 'https://x' }), /invalid domain/);
});
